import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BehavioursStore, OWNER } from "../src/server/behaviours.js";
import { BEHAVIOURS, type BehaviourRow, type BehavioursResponse } from "../src/shared/behaviours.js";
import { CHATS_ID, CHATS_STALE_MS, chatsLine, DEFAULT_CHATS, type ChatsReport } from "../src/shared/chats.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, browser, startServer, type TestServer } from "./helpers.js";

// Chats run themselves: its row's knobs, the bridge's report route and the count the row and Progress show.

const entry = BEHAVIOURS.find((one) => one.id === CHATS_ID)!;
const report = (fields: Partial<ChatsReport> = {}): ChatsReport => ({
  open: 3,
  working: 2,
  cap: 10,
  kept: [{ name: "ask-pr7", reason: "PR open" }],
  closed: ["docs-pass", "fix-css"],
  at: "2026-11-22T09:00:00.000Z",
  ...fields,
});

describe("the chats count's words", () => {
  it("counts with the stored cap, one chat in the singular, and can't tell with no report", () => {
    expect(chatsLine(report(), 10)).toBe("3 chats open · cap 10");
    expect(chatsLine(report({ open: 1, cap: 4 }), 6)).toBe("1 chat open · cap 6");
    expect(chatsLine(report({ open: 0 }), 10)).toBe("0 chats open · cap 10");
    expect(chatsLine(null, 10)).toBe("Can't tell");
  });
});

describe("the Chats row in the list", () => {
  it("is a live Work row after Promise keeper, its switch the close knob and three selects under it", () => {
    const ids = BEHAVIOURS.map((one) => one.id);
    expect(ids.indexOf(CHATS_ID)).toBe(ids.indexOf("work.promise-keeper") + 1);
    expect(entry).toMatchObject({ group: "Work", scope: "all", control: "live", switchKey: "close", default: DEFAULT_CHATS });
    expect(entry.selects?.map((select) => select.knob)).toEqual(["cap", "idleMinutes", "nightly"]);
    expect(entry.selects?.[2]?.choices[0]).toEqual({ value: 0, label: "Off" });
    for (const select of entry.selects!) for (const choice of select.choices) expect(entry.knobs.safeParse({ ...DEFAULT_CHATS, [select.knob]: choice.value }).success, `${select.knob} ${choice.value}`).toBe(true);
  });

  it("never says live or refund in its words", () => {
    const words = [entry.name, entry.line, ...entry.selects!.flatMap((select) => [select.label, ...select.choices.map((choice) => choice.label)])].join(" ");
    expect(words).not.toMatch(/\blive\b|refund/i);
  });
});

describe("the Chats row in the store", () => {
  let dir: string;
  let store: BehavioursStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-chats-"));
    store = new BehavioursStore(dir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("serves its default and saves a value its knobs accept", () => {
    expect(store.get(OWNER, entry).value).toEqual(DEFAULT_CHATS);
    expect(store.put(OWNER, entry, { close: false, cap: 20, idleMinutes: 60, nightly: 0 }, new Date())?.value).toEqual({ close: false, cap: 20, idleMinutes: 60, nightly: 0 });
  });

  it("refuses a cap of 0 or 21, an idle time it doesn't offer, more than 10 a night and an extra key", () => {
    for (const bad of [{ cap: 0 }, { cap: 21 }, { cap: 2.5 }, { idleMinutes: 25 }, { nightly: 11 }, { nightly: -1 }, { close: "yes" }, { on: true }])
      expect(store.put(OWNER, entry, { ...DEFAULT_CHATS, ...bad }, new Date()), JSON.stringify(bad)).toBeNull();
    expect(store.get(OWNER, entry).value).toEqual(DEFAULT_CHATS);
  });
});

describe("the chats report route", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startServer();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
  });

  const send = (body: unknown, headers: Record<string, string> = bearer(BRIDGE_TOKEN)) =>
    fetch(`${server.base}/api/bridge/chats`, { method: "PUT", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  const row = async (): Promise<BehaviourRow> =>
    ((await (await fetch(`${server.base}/api/behaviours`, { headers: browser(server.cookie()) })).json()) as BehavioursResponse).behaviours.find((one) => one.id === CHATS_ID)!;
  const progress = async () => (await (await fetch(`${server.base}/api/chats`, { headers: browser(server.cookie()) })).json()) as { line: string; leftMs: number | null };

  it("can't tell before the bridge reports, on the row and on Progress", async () => {
    expect(await row()).toMatchObject({ chip: "Can't tell", report: { note: "Can't tell: no report from the Mac", detail: null } });
    expect(await progress()).toEqual({ line: "Can't tell", leftMs: null });
  });

  it("takes a good report and shows its count against the stored cap", async () => {
    expect((await send(report({ cap: 7 }))).status).toBe(200);
    expect(await row()).toMatchObject({ chip: "3 chats open · cap 10", report: { note: "Last pass: 2 closed, 1 kept", detail: null } });
    expect((await progress()).line).toBe("3 chats open · cap 10");
    const saved = await fetch(`${server.base}/api/behaviours/${CHATS_ID}`, { method: "PUT", headers: browser(server.cookie()), body: JSON.stringify({ ...DEFAULT_CHATS, close: false, cap: 6 }) });
    expect(await saved.json()).toMatchObject({ value: { close: false, cap: 6 }, chip: "3 chats open · cap 6" });
    expect((await progress()).line).toBe("3 chats open · cap 6");
  });

  it("says how much longer it keeps the report, by its own clock", async () => {
    const sentAt = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(sentAt);
    expect((await send(report())).status).toBe(200);
    vi.spyOn(Date, "now").mockReturnValue(sentAt + 9 * 60_000);
    expect(await progress()).toEqual({ line: "3 chats open · cap 10", leftMs: CHATS_STALE_MS - 9 * 60_000 });
    vi.spyOn(Date, "now").mockReturnValue(sentAt + CHATS_STALE_MS);
    expect(await progress()).toEqual({ line: "3 chats open · cap 10", leftMs: 0 });
    vi.spyOn(Date, "now").mockReturnValue(sentAt + CHATS_STALE_MS + 1);
    expect(await progress()).toEqual({ line: "Can't tell", leftMs: null });
  });

  it("can't tell from a report older than twice the bridge's pass", async () => {
    expect((await send(report())).status).toBe(200);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + CHATS_STALE_MS + 1_000);
    expect((await row()).chip).toBe("Can't tell");
    expect(await progress()).toEqual({ line: "Can't tell", leftMs: null });
  });

  it("refuses a report without the bridge's token", async () => {
    expect((await send(report(), {})).status).toBe(401);
    expect((await send(report(), bearer(BOARD_TOKEN))).status).toBe(401);
    expect((await send(report(), browser(server.cookie()))).status).toBe(401);
    expect((await row()).chip).toBe("Can't tell");
  });

  it("refuses a bad body, a bad chat name and an oversize one, and keeps the last good report", async () => {
    expect((await send(report())).status).toBe(200);
    const bad = [
      report({ open: -1 }),
      report({ open: 501 }),
      report({ working: 1.5 }),
      report({ cap: 0 }),
      report({ cap: 21 }),
      report({ at: "yesterday" }),
      { ...report(), extra: 1 },
      report({ closed: ["../etc"] }),
      report({ closed: ["has space"] }),
      report({ kept: [{ name: "fine", reason: "two\nlines" }] }),
      report({ kept: [{ name: "fine", reason: "x".repeat(81) }] }),
      report({ kept: [{ name: "fine", reason: "" }] }),
      report({ kept: [{ name: "fine", reason: "ok", extra: 1 } as never] }),
      report({ closed: Array.from({ length: 101 }, (_, i) => `c${i}`) }),
      "not json",
    ];
    for (const body of bad) {
      const answer = await send(body);
      expect(answer.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect((await send({ ...report(), pad: "x".repeat(17 * 1024) })).status).toBe(413);
    expect((await row()).chip).toBe("3 chats open · cap 10");
  });

  it("refuses Progress's count signed out", async () => {
    expect((await fetch(`${server.base}/api/chats`)).status).toBe(401);
  });
});
