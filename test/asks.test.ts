import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ASK_STAGES,
  ASK_WHO,
  FINISHED_STAGES,
  MAX_ASK_CHAT,
  MAX_ASK_NOTE,
  MAX_ASK_WHY,
  MAX_ASK_WORDS,
  MAX_ASKS,
  type Ask,
  type AsksResponse,
} from "../src/shared/asks.js";
// @ts-expect-error the CLI is plain ESM without type declarations
import { run } from "../scripts/rivet.mjs";
import { CommandStore } from "../src/server/commandstore.js";
import { asksPastDue } from "../src/server/asks/late.js";
import { ensureAsk } from "../src/server/routes/asks.js";
import { askRows } from "../web/src/views/your-asks.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, browser, EXAMPLE_BOARD, fakeClock, putBoard, startServer, type TestServer } from "./helpers.js";

const START = Date.parse("2026-10-01T02:00:00.000Z");

let server: TestServer;
let cookie: string;
let clock: ReturnType<typeof fakeClock>;

beforeEach(async () => {
  clock = fakeClock(START);
  server = await startServer({}, { now: clock.now });
  cookie = server.cookie();
});

afterEach(async () => {
  await server.close();
});

function send(method: string, path: string, body?: unknown, headers: Record<string, string> = bearer(BOARD_TOKEN)): Promise<Response> {
  return fetch(`${server.base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function create(body: Record<string, unknown>): Promise<Ask> {
  const response = await send("POST", "/api/asks", body);
  expect(response.status).toBe(201);
  return (await response.json()) as Ask;
}

async function page(query = "", headers: Record<string, string> = bearer(BOARD_TOKEN)): Promise<AsksResponse> {
  const response = await send("GET", `/api/asks${query}`, undefined, headers);
  expect(response.status).toBe(200);
  return (await response.json()) as AsksResponse;
}

async function list(query = "", headers: Record<string, string> = bearer(BOARD_TOKEN)): Promise<Ask[]> {
  return (await page(query, headers)).asks;
}

async function get(id: string): Promise<Ask> {
  const response = await send("GET", `/api/asks/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Ask;
}

/** A stored ask, straight into the store, for tests that need hundreds. */
function stored(id: string, createdAt: string, stage: Ask["stage"] = "queued", stageAt = createdAt): Ask {
  const ask: Ask = { id, words: id, who: "owner", stage, prs: [], dueHistory: [], timeline: [{ at: stageAt, stage }], createdAt, stageAt, updatedAt: stageAt, version: 1 };
  expect(server.app.store.addAsk(ask)).toBe(true);
  return ask;
}

describe("asks", () => {
  it("creates an ask with defaults and its first timeline event", async () => {
    const response = await send("POST", "/api/asks", { id: "a-1", words: "Make the cards as big as you can", chat: "checkout", prs: [2550, 2550] });
    expect(response.status).toBe(201);
    expect(response.headers.get("etag")).toBe('"1"');
    const ask = (await response.json()) as Ask;
    expect(ask).toEqual({
      id: "a-1",
      words: "Make the cards as big as you can",
      who: "owner",
      stage: "queued",
      chat: "checkout",
      prs: [2550],
      dueHistory: [],
      timeline: [{ at: "2026-10-01T02:00:00.000Z", stage: "queued" }],
      createdAt: "2026-10-01T02:00:00.000Z",
      stageAt: "2026-10-01T02:00:00.000Z",
      updatedAt: "2026-10-01T02:00:00.000Z",
      version: 1,
    });
  });

  it("takes an import's date and note, and refuses a taken id with 409", async () => {
    const ask = await create({ id: "l-8", words: "x", stage: "shipped", createdAt: "2026-09-30T00:00:00Z", note: "LIVE 11:45Z", who: "owner" });
    expect(ask.createdAt).toBe("2026-09-30T00:00:00.000Z");
    expect(ask.timeline).toEqual([{ at: "2026-09-30T00:00:00.000Z", stage: "shipped", note: "LIVE 11:45Z" }]);
    const again = await send("POST", "/api/asks", { id: "l-8", words: "y" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toMatch(/already exists/);
  });

  it("refuses a date whose offset Date cannot read with 400, not 500", async () => {
    for (const createdAt of ["2026-09-30T00:00:00+99:99", "2026-09-30T00:00:00+14:01", "2026-09-30T00:00:00+05:60"]) {
      expect((await send("POST", "/api/asks", { id: "l-9", words: "x", createdAt })).status, createdAt).toBe(400);
    }
    expect((await create({ id: "l-9", words: "x", createdAt: "2026-09-30T00:00:00-12:00" })).createdAt).toBe("2026-09-30T12:00:00.000Z");
  });

  it("refuses invalid bodies with 400", async () => {
    for (const body of [
      { id: "A-1", words: "x" },
      { id: "a-1", words: "   " },
      { id: "a-1", words: "x", status: "done" },
      { id: "a-1", words: "x", stage: "open" },
      { id: "a-1", words: "x", card: "c-1" },
      { id: "a-1", words: "x", why: "two\nlines" },
      { id: "a-1", words: "x", why: "y".repeat(MAX_ASK_WHY + 1) },
      { id: "a-1", words: "x", progress: 1.5 },
      { id: "a-1", words: "x", who: "sam" },
      { id: "a-1", words: "x", extra: true },
      { id: "a-1", words: "x".repeat(4001) },
      { id: "a-1", words: "x", chat: "two\nlines" },
      { id: "a-1", words: "clear \x1b[2J screen" },
      { id: "a-1", words: "bell\x07" },
      { id: "a-1", words: "c1 \x9b31m" },
      { id: "a-1", words: "x", chat: "a\x07" },
      { id: "a-1", words: "x", note: "carriage\rreturn" },
      { id: "a-1", words: "x", by: "\u202eevil" },
    ]) {
      expect((await send("POST", "/api/asks", body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect((await send("POST", "/api/asks", "not json")).status).toBe(400);
    expect(await list()).toEqual([]);
    // Words and notes may still run over lines.
    expect((await create({ id: "a-1", words: "one\ntwo", note: "three\nfour" })).words).toBe("one\ntwo");
    expect((await send("PATCH", "/api/asks/a-1", { note: "esc \x1b]0;title\x07" })).status).toBe(400);
  });

  it("caps the body", async () => {
    const response = await send("POST", "/api/asks", { id: "a-1", words: "x", note: "y".repeat(70 * 1024) });
    expect(response.status).toBe(413);
  });

  it("lists newest first and filters by stage, or by an old status word as its stage", async () => {
    await create({ id: "a-1", words: "one" });
    clock.advance(60_000);
    await create({ id: "a-2", words: "two", stage: "building" });
    clock.advance(60_000);
    await create({ id: "a-3", words: "three" });
    expect((await list()).map((ask) => ask.id)).toEqual(["a-3", "a-2", "a-1"]);
    expect((await list("?stage=queued")).map((ask) => ask.id)).toEqual(["a-3", "a-1"]);
    expect((await send("GET", "/api/asks?stage=finished")).status).toBe(400);
  });

  it("merges a change, appends stage and note events, and bumps the version", async () => {
    await create({ id: "a-1", words: "Card glow", prs: [2606] });
    clock.advance(60_000);
    const response = await send("PATCH", "/api/asks/a-1", { stage: "building", chat: "banana-round2", prs: [2605, 2606], note: "relayed", by: "monitor" });
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"2"');
    const ask = (await response.json()) as Ask;
    expect(ask).toMatchObject({ stage: "building", chat: "banana-round2", prs: [2606, 2605], version: 2, updatedAt: "2026-10-01T02:01:00.000Z" });
    expect(ask.timeline.at(-1)).toEqual({ at: "2026-10-01T02:01:00.000Z", stage: "building", note: "relayed", by: "monitor" });

    // A note alone appends a note event; the same stage again appends nothing.
    const noted = (await (await send("PATCH", "/api/asks/a-1", { note: "stills due" })).json()) as Ask;
    expect(noted.timeline.at(-1)).toEqual({ at: "2026-10-01T02:01:00.000Z", note: "stills due" });
    const same = (await (await send("PATCH", "/api/asks/a-1", { stage: "building" })).json()) as Ask;
    expect(same.timeline).toHaveLength(3);
    expect(same.version).toBe(4);

    // null removes an optional field.
    const parked = (await (await send("PATCH", "/api/asks/a-1", { stage: "parked", issue: 2666, chat: null })).json()) as Ask;
    expect(parked.chat).toBeUndefined();
    expect(parked).toMatchObject({ stage: "parked", issue: 2666 });
    expect(await get("a-1")).toEqual(parked);
    // The list carries only the last event.
    expect((await list())[0]).toEqual({ ...parked, timeline: parked.timeline.slice(-1), short: expect.any(String) });
  });

  it("moved to done or live, posts no card and comments on no PR, and still records the ask as finished for Done today", async () => {
    const needs = async () => ((await (await send("GET", "/api/board")).json()) as { board: { needs: unknown[] } | null }).board?.needs ?? [];
    // With a PR, a chat and the owner's message behind it: everything the old card was built from.
    await create({ id: "a-9", words: "Billing\nround two look", chat: "billing-2", prs: [4050] });
    await create({ id: "a-10", words: "Weigh-in chart", repo: "example-org/weigh-in" });
    for (const [id, change] of [
      ["a-9", { stage: "building" }],
      ["a-9", { stage: "done" }],
      ["a-9", { stage: "done", note: "again" }],
      ["a-9", { stage: "shipped" }],
      ["a-10", { stage: "shipped" }],
    ] as const) {
      expect((await send("PATCH", `/api/asks/${id}`, change)).status).toBe(200);
      // No card means nothing for the owner to answer, so no answer for the bridge to post on the PR.
      expect(await needs()).toEqual([]);
    }
    const finished = await list();
    expect(finished.map((ask) => [ask.id, ask.stage])).toEqual(expect.arrayContaining([["a-9", "shipped"], ["a-10", "shipped"]]));
    const done = askRows(finished, clock.now().getTime()).finished.map((row) => row.id);
    expect(done).toEqual(expect.arrayContaining(["a-9", "a-10"]));
  });

  it("an ask closed past its due time, with no card, never comes back as overdue", async () => {
    await create({ id: "a-12", words: "Late one", due: new Date(clock.now().getTime() + 60_000).toISOString() });
    clock.advance(120_000);
    expect(asksPastDue(await list(), clock.now()).map((ask) => ask.id)).toEqual(["a-12"]);
    expect((await send("PATCH", "/api/asks/a-12", { stage: "done" })).status).toBe(200);
    expect(asksPastDue(await list(), clock.now())).toEqual([]);
    clock.advance(3_600_000);
    expect(asksPastDue(await list(), clock.now())).toEqual([]);
    expect((await get("a-12")).stage).toBe("done");
  });

  it("keeps the timeline to its last 100 events, and stageAt past them", async () => {
    await create({ id: "a-1", words: "x" });
    clock.advance(60_000);
    expect((await send("PATCH", "/api/asks/a-1", { stage: "shipped" })).status).toBe(200);
    clock.advance(60_000);
    for (let i = 0; i < 101; i++) expect((await send("PATCH", "/api/asks/a-1", { note: `n${i}` })).status).toBe(200);
    const ask = await get("a-1");
    expect(ask.timeline).toHaveLength(100);
    expect(ask.timeline[0]).toMatchObject({ note: "n1" });
    expect(ask.timeline.at(-1)).toMatchObject({ note: "n100" });
    expect(ask.timeline.some((event) => event.stage)).toBe(false);
    expect(ask.stageAt).toBe("2026-10-01T02:01:00.000Z");
    // A note is not a stage change; a new stage is.
    expect(ask.updatedAt).toBe("2026-10-01T02:02:00.000Z");
    clock.advance(60_000);
    expect(((await (await send("PATCH", "/api/asks/a-1", { stage: "parked", issue: 1 })).json()) as Ask).stageAt).toBe("2026-10-01T02:03:00.000Z");
  });

  it("lists what is moving, then what finished in the last 3 days, newest first, at most 500", async () => {
    const day = 86_400_000;
    const iso = (ms: number) => new Date(START - ms).toISOString();
    stored("old-open", iso(30 * day));
    stored("old-live", iso(30 * day), "shipped", iso(4 * day));
    stored("recent-live", iso(30 * day), "shipped", iso(2 * day));
    stored("old-parked", iso(10 * day), "parked", iso(3 * day + 60_000));
    stored("new-merged", iso(60_000), "done");
    expect((await list()).map((ask) => ask.id)).toEqual(["old-open", "new-merged", "recent-live"]);
    expect((await list("?stage=shipped")).map((ask) => ask.id)).toEqual(["recent-live"]);
    expect((await list("?all=1")).map((ask) => ask.id)).toEqual(["new-merged", "old-parked", "recent-live", "old-open", "old-live"]);

    // 500 asks finished yesterday never push an old open ask out of the bounded list.
    for (let i = 0; i < 500; i++) stored(`b-${i}`, iso(i), "shipped", iso(day));
    const bounded = await page();
    expect(bounded.asks).toHaveLength(500);
    expect(bounded.asks.slice(0, 2).map((ask) => ask.id)).toEqual(["old-open", "b-0"]);
    expect(bounded.next).toBeUndefined();
  });

  it("pages through every ask with all=1, ties broken by id", async () => {
    const same = new Date(START - 60_000).toISOString();
    for (const id of ["l-1", "l-2", "l-3", "l-4", "l-5"]) stored(id, same, "shipped");
    stored("a-1", new Date(START).toISOString());
    const seen: string[] = [];
    let next: string | undefined;
    for (let n = 0; n < 5; n++) {
      const result = await page(`?all=1&limit=2${next ? `&before=${encodeURIComponent(next)}` : ""}`);
      seen.push(...result.asks.map((ask) => ask.id));
      next = result.next;
      if (!next) break;
    }
    expect(seen).toEqual(["a-1", "l-5", "l-4", "l-3", "l-2", "l-1"]);
    expect((await send("GET", "/api/asks?all=1&limit=501")).status).toBe(400);
    expect((await send("GET", "/api/asks?all=1&limit=0")).status).toBe(400);
    expect((await send("GET", "/api/asks?all=1&before=nonsense")).status).toBe(400);
    expect((await send("GET", `/api/asks?before=${encodeURIComponent(`${same},l-3`)}`)).status).toBe(400);
  });

  it("serves one ask in full by id", async () => {
    await create({ id: "a-1", words: "x" });
    expect((await get("a-1")).id).toBe("a-1");
    expect((await send("GET", "/api/asks/a-2")).status).toBe(404);
    expect((await send("GET", "/api/asks/Bad%20Id")).status).toBe(404);
    expect((await send("GET", "/api/asks/a-1", undefined, browser(cookie))).status).toBe(200);
    expect((await send("GET", "/api/asks/a-1", undefined, {})).status).toBe(401);
  });

  it("answers 507 once it holds 5000 asks", async () => {
    const at = new Date(START).toISOString();
    for (let i = 0; i < MAX_ASKS; i++) stored(`f-${i}`, at);
    const full = await send("POST", "/api/asks", { id: "a-1", words: "x" });
    expect(full.status).toBe(507);
    expect(((await full.json()) as { error: string }).error).toBe("Rivet Agents holds at most 5000 asks");
  });

  it("keeps an ask's repo for its PR links, and drops it on null", async () => {
    const ask = await create({ id: "a-1", words: "x", prs: [31], repo: "example-org/quote" });
    expect(ask.repo).toBe("example-org/quote");
    const moved = (await (await send("PATCH", "/api/asks/a-1", { repo: "example-org/Other-Repo" })).json()) as Ask;
    expect(moved.repo).toBe("example-org/Other-Repo");
    expect(((await (await send("PATCH", "/api/asks/a-1", { repo: null })).json()) as Ask).repo).toBeUndefined();
  });

  it("honours If-Match with 409 when stale", async () => {
    await create({ id: "a-1", words: "x" });
    expect((await send("PATCH", "/api/asks/a-1", { note: "one" }, { ...bearer(BOARD_TOKEN), "if-match": '"1"' })).status).toBe(200);
    const stale = await send("PATCH", "/api/asks/a-1", { note: "two" }, { ...bearer(BOARD_TOKEN), "if-match": "1" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "ask version is stale", version: 2 });
    expect((await send("PATCH", "/api/asks/a-1", { note: "two" }, { ...bearer(BOARD_TOKEN), "if-match": "abc" })).status).toBe(400);
    expect((await get("a-1")).timeline).toHaveLength(2);
  });

  it("answers 404 for an unknown or malformed id and 400 for a bad change", async () => {
    expect((await send("PATCH", "/api/asks/a-9", { note: "x" })).status).toBe(404);
    expect((await send("PATCH", "/api/asks/Bad%20Id", { note: "x" })).status).toBe(404);
    expect((await send("PATCH", "/api/asks/a-1/more", { note: "x" })).status).toBe(404);
    await create({ id: "a-1", words: "x" });
    expect((await send("PATCH", "/api/asks/a-1", { status: "done" })).status).toBe(400);
    expect((await send("PATCH", "/api/asks/a-1", { stage: "merged" })).status).toBe(400);
    expect((await send("PATCH", "/api/asks/a-1", { id: "a-2" })).status).toBe(400);
  });

  it("lets a session read but not write, the board token write, and the bridge token neither", async () => {
    await create({ id: "a-1", words: "x" });
    expect((await send("GET", "/api/asks", undefined, {})).status).toBe(401);
    expect((await list("", browser(cookie))).map((ask) => ask.id)).toEqual(["a-1"]);
    expect((await send("GET", "/api/asks", undefined, bearer(BRIDGE_TOKEN))).status).toBe(401);

    expect((await send("POST", "/api/asks", { id: "a-2", words: "x" }, browser(cookie))).status).toBe(401);
    expect((await send("PATCH", "/api/asks/a-1", { note: "x" }, browser(cookie))).status).toBe(401);
    expect((await send("POST", "/api/asks", { id: "a-2", words: "x" }, bearer(BRIDGE_TOKEN))).status).toBe(401);
    expect((await send("PATCH", "/api/asks/a-1", { note: "x" }, bearer(BRIDGE_TOKEN))).status).toBe(401);
    expect((await list()).map((ask) => ask.version)).toEqual([1]);
  });
});

describe("an ask's promised time", () => {
  const inMinutes = (minutes: number) => new Date(START + minutes * 60_000).toISOString();
  const patch = async (body: Record<string, unknown>) => {
    const response = await send("PATCH", "/api/asks/a-1", body);
    return { status: response.status, ask: (await response.json()) as Ask & { error?: string } };
  };

  it("takes a due as the first promise, not a move", async () => {
    const ask = await create({ id: "a-1", words: "x", due: inMinutes(90), why: "stills first" });
    expect(ask).toMatchObject({ dueAt: inMinutes(90), why: "stills first", dueHistory: [] });
    // A first time on an ask that had none is a promise too.
    await create({ id: "a-2", words: "y" });
    const first = (await (await send("PATCH", "/api/asks/a-2", { due: "2026-10-01T15:30:00+11:00" })).json()) as Ask;
    expect(first).toMatchObject({ dueAt: "2026-10-01T04:30:00.000Z", dueHistory: [] });
  });

  it("restates a sooner time, or one within the slack, in place", async () => {
    await create({ id: "a-1", words: "x", due: inMinutes(60) });
    expect(await patch({ due: inMinutes(70) })).toMatchObject({ status: 200, ask: { dueAt: inMinutes(70), dueHistory: [] } });
    expect(await patch({ due: inMinutes(30) })).toMatchObject({ status: 200, ask: { dueAt: inMinutes(30), dueHistory: [] } });
  });

  it("records a later time with its why in dueHistory, and refuses one with no why", async () => {
    await create({ id: "a-1", words: "x", due: inMinutes(60) });
    const refused = await patch({ due: inMinutes(71) });
    expect(refused.status).toBe(400);
    expect(refused.ask.error).toMatch(/needs a why/);
    expect((await get("a-1")).dueAt).toBe(inMinutes(60));

    clock.advance(5 * 60_000);
    const moved = await patch({ due: inMinutes(120), why: "CI queue on CI" });
    expect(moved.status).toBe(200);
    expect(moved.ask).toMatchObject({ dueAt: inMinutes(120), why: "CI queue on CI", version: 2 });
    expect(moved.ask.dueHistory).toEqual([{ at: inMinutes(5), dueAt: inMinutes(120), was: inMinutes(60), why: "CI queue on CI" }]);
    // A why is one line.
    expect((await patch({ due: inMinutes(200), why: "two\nlines" })).status).toBe(400);
  });

  it("refuses a due in the past or more than a week out, and clears one on null", async () => {
    for (const due of [inMinutes(-2), inMinutes(7 * 24 * 60 + 1)]) {
      expect((await send("POST", "/api/asks", { id: "a-1", words: "x", due })).status, due).toBe(400);
    }
    await create({ id: "a-1", words: "x", due: inMinutes(60) });
    expect((await patch({ due: inMinutes(-2) })).status).toBe(400);
    expect((await patch({ due: inMinutes(7 * 24 * 60 + 1), why: "next week" })).status).toBe(400);
    const cleared = await patch({ due: null });
    expect(cleared.status).toBe(200);
    expect(cleared.ask.dueAt).toBeUndefined();
  });
});

describe("an ask from a message", () => {
  it("makes an ask from your message, taking its words, reply and source", async () => {
    const commands = new CommandStore(server.dataDir);
    commands.addAction({ id: "msg-7", clientId: "client-msg-7", kind: "chat", at: "2026-10-01T01:59:00.000Z", request: { text: "Make the chips bigger" } });
    commands.close();
    const ask = await create({ id: "a-1", from: "msg-7", who: "owner" });
    expect(ask).toMatchObject({ words: "Make the chips bigger", replyId: "msg-7", source: "message:msg-7" });
    // Words given win; an unknown message is a 404; no words and no message is a 400.
    expect((await create({ id: "a-2", from: "msg-7", words: "Bigger chips" })).words).toBe("Bigger chips");
    expect((await send("POST", "/api/asks", { id: "a-3", from: "msg-8" })).status).toBe(404);
    expect((await send("POST", "/api/asks", { id: "a-3" })).status).toBe(400);
  });
});

describe("the CLI's side of asks", () => {
  it("mirrors the server's stages and limits", async () => {
    const libPath = "../bridge/lib/asks.mjs";
    const lib = (await import(libPath)) as {
      ASK_STAGES: readonly string[];
      FINISHED_STAGES: readonly string[];
      ASK_WHO: readonly string[];
      MAX_ASK_WORDS: number;
      MAX_ASK_NOTE: number;
      MAX_ASK_CHAT: number;
      MAX_ASK_WHY: number;
    };
    expect([...lib.ASK_STAGES]).toEqual([...ASK_STAGES]);
    expect([...lib.FINISHED_STAGES]).toEqual([...FINISHED_STAGES]);
    expect([...lib.ASK_WHO]).toEqual([...ASK_WHO]);
    expect([lib.MAX_ASK_WORDS, lib.MAX_ASK_NOTE, lib.MAX_ASK_CHAT, lib.MAX_ASK_WHY]).toEqual([MAX_ASK_WORDS, MAX_ASK_NOTE, MAX_ASK_CHAT, MAX_ASK_WHY]);
  });

  const cli = () => {
    const out = { stderr: "" };
    const env = { RIVET_BRIDGE_DEV: "1", RIVET_BOARD_TOKEN: BOARD_TOKEN, RIVET_URL: server.base, PATH: "" };
    const call = (argv: string[]): Promise<number> => run(argv, { env, now: () => new Date(clock.now()), stdout: () => undefined, stderr: (s: string) => void (out.stderr += s) });
    return { call, out };
  };

  it("rivet ask set --stage done and ask close done or live record the ask and post nothing", async () => {
    const { call, out } = cli();
    const needs = async () => ((await (await send("GET", "/api/board")).json()) as { board: { needs: unknown[] } | null }).board?.needs ?? [];
    for (const id of ["a-13", "a-14", "a-15"]) await create({ id, words: `Close ${id}`, prs: [4051] });
    expect(await call(["ask", "set", "a-13", "--stage", "done"])).toBe(0);
    expect(await call(["ask", "close", "a-14", "done"])).toBe(0);
    expect(await call(["ask", "close", "a-15", "shipped"])).toBe(0);
    expect(out.stderr).toBe("");
    expect(await Promise.all(["a-13", "a-14", "a-15"].map(async (id) => (await get(id)).stage))).toEqual(["done", "done", "shipped"]);
    expect(await needs()).toEqual([]);
  });

  it("moves an ask to needs-you with no card named: the server cards it (asks/waits.ts)", async () => {
    const { call } = cli();
    const ask = await create({ id: "a-1", words: "Which layout?", chat: "rivet-app" });
    expect(await call(["ask", "set", ask.id, "--stage", "needs-you", "--why", "Which layout?"])).toBe(0);
    expect((await get(ask.id)).stage).toBe("needs-you");
    expect(await call(["ask", "set", ask.id, "--stage", "building"])).toBe(0);
    expect((await get(ask.id)).stage).toBe("building");
  });



});
