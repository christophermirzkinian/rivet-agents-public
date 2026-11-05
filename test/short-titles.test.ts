import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AsksResponse } from "../src/shared/asks.js";
import { fallbackTitle, MAX_SHORT_TITLE, shownTitle } from "../src/shared/short-titles.js";
import { shortHash, ShortTitles } from "../src/server/short-titles.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, startServer, type TestServer } from "./helpers.js";

// Your two long rows on 27 Oct, as your screenshot shows them.
const LINKED = "Can we keep an eye on this https://stats.example.com/dashboard/analytics and tell me whats performing well everyday. Whatever is doing well, lets make 1 more pack similar to that, and get rid of something that isnt performing well (view/visits or whatever metrics).";
const DOING = "Draft PR 6849 is open with reviews and 3 shells still running; waiting on your yes before marking it ready";

describe("the fallback title", () => {
  it("is the words' first clause, links left out, cut at a word, never past the limit", () => {
    expect(fallbackTitle(LINKED)).toBe("Can we keep an eye on this and…");
    expect(fallbackTitle(DOING)).toBe("Draft PR 6849 is open with…");
    expect(fallbackTitle("Driving demo like the sample reel: plan + look test")).toBe("Driving demo like the sample…");
    expect(fallbackTitle("Web Cache: sharper art")).toBe("Web Cache: sharper art");
    expect(fallbackTitle("Ship v0.3.1 today. Then rest")).toBe("Ship v0.3.1 today");
    for (const words of [LINKED, DOING, "x".repeat(200), "a b c ".repeat(40)]) expect(fallbackTitle(words).length).toBeLessThanOrEqual(MAX_SHORT_TITLE);
  });

  it("stops at a line break and never shows the word live", () => {
    expect(fallbackTitle("Web Cache: art\nThen ship")).toBe("Web Cache: art");
    expect(fallbackTitle("Web Cache: go live")).toBe("Web Cache: go");
    expect(fallbackTitle("https://rivet-title-filter-example-livestream.com")).not.toMatch(/\blive\b/i);
    expect(fallbackTitle("go-live")).toBe("go");
    expect(shownTitle("Rivet: go live", "Rivet: go live")).toBe("Rivet: go");
  });

  it("is never blank", () => {
    expect(fallbackTitle("https://stats.example.com/dashboard/analytics")).toBe("stats.example.com");
    expect(fallbackTitle("...")).not.toBe("");
    expect(fallbackTitle("   ")).toBe("Untitled");
  });

  it("stands in for a title that is missing, too long or not one line", () => {
    expect(shownTitle("itch: daily sales check", LINKED)).toBe("itch: daily sales check");
    expect(shownTitle(undefined, LINKED)).toBe(fallbackTitle(LINKED));
    expect(shownTitle(null, LINKED)).toBe(fallbackTitle(LINKED));
    expect(shownTitle("x".repeat(MAX_SHORT_TITLE + 1), LINKED)).toBe(fallbackTitle(LINKED));
    expect(shownTitle("bell\u0007here", LINKED)).toBe(fallbackTitle(LINKED));
    expect(shownTitle(" two\n lines ", LINKED)).toBe("two lines");
  });
});

describe("the short-title store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rivet-short-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("queues words once by their hash, serves the fallback until Haiku answers, then its title, across a restart", () => {
    const titles = new ShortTitles(dir);
    expect(titles.of(LINKED)).toBe(fallbackTitle(LINKED));
    expect(titles.of(`  ${LINKED.replace(/ /g, "  ")} `)).toBe(fallbackTitle(LINKED));
    expect(titles.pending(10)).toEqual([{ hash: shortHash(LINKED), text: LINKED }]);
    expect(titles.put(shortHash(LINKED), "itch: daily sales check")).toBe(true);
    expect(titles.pending(10)).toEqual([]);
    expect(titles.of(LINKED)).toBe("itch: daily sales check");
    titles.close();
    const again = new ShortTitles(dir);
    expect(again.of(LINKED)).toBe("itch: daily sales check");
    expect(again.put("f".repeat(64), "Nothing: here")).toBe(false);
    again.close();
  });

  it("names new words again when they change, gives a chat's line its name beside it, and keeps the fallback when Haiku gave up", () => {
    const titles = new ShortTitles(dir);
    titles.of(DOING, "rivet-short-titles");
    const [row] = titles.pending(10);
    expect(row!.text).toBe(`Chat: rivet-short-titles\n${DOING}`);
    titles.put(row!.hash, null);
    expect(titles.of(DOING, "rivet-short-titles")).toBe(fallbackTitle(DOING));
    expect(titles.pending(10)).toEqual([]);
    titles.of(`${DOING}, now green`, "rivet-short-titles");
    expect(titles.pending(10)).toHaveLength(1);
    titles.close();
  });

  it("keys on the whole of the words, though Haiku reads only their start", () => {
    const titles = new ShortTitles(dir);
    const start = "a ".repeat(400);
    titles.of(`${start}then ship it`);
    titles.of(`${start}then hold it`);
    const rows = titles.pending(10);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.text.length).toBe(600);
    titles.close();
  });

  it("keeps a title served within the last 30 days across a restart, and drops one not served for longer", () => {
    const day = 24 * 3_600_000;
    const t0 = Date.parse("2026-10-01T00:00:00Z");
    const titles = new ShortTitles(dir, new Date(t0));
    titles.of(LINKED, undefined, new Date(t0));
    titles.of(DOING, undefined, new Date(t0));
    titles.put(shortHash(LINKED), "itch: daily sales check");
    titles.put(shortHash(DOING), "Rivet: PR waits on you");
    titles.of(LINKED, undefined, new Date(t0 + 20 * day));
    titles.close();
    const later = new ShortTitles(dir, new Date(t0 + 40 * day));
    expect(later.of(LINKED, undefined, new Date(t0 + 40 * day))).toBe("itch: daily sales check");
    expect(later.of(DOING, undefined, new Date(t0 + 40 * day))).toBe(fallbackTitle(DOING));
    later.close();
  });
});

describe("the short-title routes", () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startServer();
  });
  afterEach(async () => {
    await server.close();
  });

  const send = (method: string, path: string, token: string, body?: unknown) =>
    fetch(`${server.base}${path}`, { method, headers: bearer(token), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const list = async () => ((await (await send("GET", "/api/asks", BOARD_TOKEN)).json()) as AsksResponse).asks;

  it("serves each open ask its short title, the bridge names it, and his words stay as they were", async () => {
    expect((await send("POST", "/api/asks", BOARD_TOKEN, { id: "a-1", words: LINKED })).status).toBe(201);
    const [before] = await list();
    expect(before).toMatchObject({ words: LINKED, short: fallbackTitle(LINKED) });

    // The bridge only, with its own token.
    expect((await send("GET", "/api/bridge/short-titles", BOARD_TOKEN)).status).toBe(401);
    const pending = (await (await send("GET", "/api/bridge/short-titles?limit=5", BRIDGE_TOKEN)).json()) as { rows: { hash: string; text: string }[] };
    expect(pending.rows).toEqual([{ hash: shortHash(LINKED), text: LINKED }]);
    const path = `/api/bridge/short-titles/${pending.rows[0]!.hash}`;
    for (const title of ["x".repeat(MAX_SHORT_TITLE + 1), "itch: go live"]) {
      expect((await send("POST", path, BRIDGE_TOKEN, { title })).status).toBe(400);
    }
    expect((await send("POST", `/api/bridge/short-titles/${"0".repeat(64)}`, BRIDGE_TOKEN, { title: "A: b" })).status).toBe(404);
    expect((await send("POST", path, BRIDGE_TOKEN, { title: "itch: daily sales check" })).status).toBe(200);

    const [after] = await list();
    expect(after).toMatchObject({ words: LINKED, short: "itch: daily sales check" });
    // The CLI's full pages carry no short title and queue nothing.
    const all = (await (await send("GET", "/api/asks?all=1", BOARD_TOKEN)).json()) as AsksResponse;
    expect(all.asks[0]).not.toHaveProperty("short");
  });
});
