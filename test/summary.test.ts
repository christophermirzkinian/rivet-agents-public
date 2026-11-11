import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Ask } from "../src/shared/asks.js";
import type { Board, ComingItem } from "../src/shared/board.js";
import type { OpsStatus } from "../src/shared/ops-status.js";
import { opsStatusKey } from "../src/shared/ops-status-key.js";
import { askCounts, askMark, inHandAsk, needCounts, ownRecords, recordMark, summarize, type Summary, type SummaryInput } from "../src/shared/summary.js";
import { bearer, BOARD_TOKEN, browser, startServer, type TestServer } from "./helpers.js";

// The one summary every count reads: cards waiting less those minimised, the
// asks in hand as Your asks lists them, and the rows the Progress mark counts.

const NOW = new Date("2026-10-26T04:00:00.000Z"); // 3:00pm local time
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const later = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const MIN = 60_000;
const REPO = "example-org/example-repo" as const;

function board(parts: Partial<Board> = {}): Board {
  return { updatedAt: NOW.toISOString(), needs: [], coming: [], chats: [], shipped: [], ...parts } as Board;
}
const row = (pr: number, extra: Partial<ComingItem> = {}): ComingItem => ({ pr, title: `Row ${pr}`, stage: "building", updatedAt: NOW.toISOString(), touchedAt: NOW.toISOString(), ...extra });
const record = (extra: Partial<OpsStatus> & Record<string, unknown>): OpsStatus =>
  ({ kind: "app", key: "notes-app", state: "in-progress", since: ago(60 * MIN), updatedAt: ago(MIN), version: 1, ...extra }) as OpsStatus;
const ask = (id: string, over: Partial<Ask> = {}): Ask => ({
  id,
  chat: "on-it",
  words: `Ask ${id}`,
  who: "owner",
  stage: "building",
  prs: [],
  dueHistory: [],
  timeline: [],
  createdAt: ago(60 * MIN),
  stageAt: ago(60 * MIN),
  updatedAt: ago(60 * MIN),
  version: 1,
  ...over,
} as Ask);
const twice = [
  { at: ago(30 * MIN), dueAt: ago(10 * MIN), was: ago(40 * MIN) },
  { at: ago(5 * MIN), dueAt: later(90 * MIN), was: ago(10 * MIN), why: "deploy queue" },
];

/** Six asks: timed, passed, moved once, moved twice, at Your OK, and Rivet's own; one done. */
const asks = [
  ask("timed", { dueAt: later(30 * MIN) }),
  ask("passed", { dueAt: ago(20 * MIN), askedForTimeAt: ago(10 * MIN) }),
  ask("once", { dueAt: later(60 * MIN), dueHistory: twice.slice(1) }),
  ask("twice", { dueAt: later(90 * MIN), dueHistory: twice }),
  ask("ok", { stage: "needs-you", dueAt: ago(20 * MIN) }),
  ask("mine", { who: "rivet", dueAt: ago(5 * MIN) }),
  ask("shipped", { stage: "done", dueAt: ago(20 * MIN) }),
];

const QUIET = { workers: [], queue: [], prs: [], merged: [] };

function input(extra: Partial<SummaryInput> = {}): SummaryInput {
  return { needs: [], minimised: new Map(), board: board(), crew: { workers: [], lapsed: false }, statuses: [], asks, queue: [{ chat: "on-it", repo: REPO, position: 1, at: 0 }], prs: [], merged: [], now: NOW.getTime(), ...extra };
}

describe("summarize", () => {
  it("counts the cards waiting less those minimised at their revision", () => {
    const needs = [
      { id: "a", rev: "a1" },
      { id: "b", rev: "b2" },
      { id: "c", rev: "c1" },
    ];
    // b was minimised at an older revision: changed since, it counts again.
    const minimised = new Map([
      ["a", "a1"],
      ["b", "b1"],
    ]);
    expect(needCounts(needs, minimised)).toEqual({ needsYou: 2, minimised: 1 });
    expect(summarize(input({ needs, minimised }))).toMatchObject({ needsYou: 2, minimised: 1 });
  });

  it("counts every unfinished ask of yours in hand, Your OK too, and marks only no time or moved twice", () => {
    expect(asks.map((one) => [inHandAsk(one), askMark(one, NOW.getTime())])).toEqual([
      [true, null],
      [true, "no-time"],
      [true, null],
      [true, "moved-twice"],
      // Its card counts it in needsYou: never in the mark.
      [true, null],
      [false, "no-time"],
      [false, null],
    ]);
    expect(summarize(input())).toEqual({
      needsYou: 0,
      minimised: 0,
      // The mark counts Rivet's own ask too, as its row on Progress is amber.
      asks: { inHand: 5, noTime: 2, moved: 1 },
      // The next time ahead of an ask the mark does not count: "timed" at 3:30pm.
      nextDoneAt: later(30 * MIN),
    } satisfies Summary);
  });

  it("marks Rivet's own records by the same rule, a time moved once marking nothing", () => {
    const now = NOW.getTime();
    expect(recordMark(record({ state: "backlog", askedForTimeAt: ago(MIN) }), now)).toBe("no-time");
    expect(recordMark(record({ state: "backlog" }), now)).toBeNull();
    expect(recordMark(record({ dueAt: ago(MIN) }), now)).toBe("no-time");
    expect(recordMark(record({ dueAt: later(MIN), dueHistory: twice.slice(1) }), now)).toBeNull();
    expect(recordMark(record({ dueAt: later(MIN), dueHistory: twice }), now)).toBe("moved-twice");
    expect(recordMark(record({ state: "fixed", dueAt: ago(MIN) }), now)).toBeNull();
    expect(recordMark(null, now)).toBeNull();
  });

  it("lists as Rivet's own a record he is on that no Coming row in hand carries, and a pick-up waiting on a time", () => {
    const onRow = record({ kind: "pr", key: opsStatusKey("pr", "100", REPO), dueAt: ago(MIN) });
    const own = record({ key: "own", dueAt: ago(MIN) });
    const waiting = record({ key: "waiting", state: "backlog", askedForTimeAt: ago(MIN) });
    const quiet = record({ key: "quiet", state: "backlog" });
    const coming = record({ kind: "coming", key: "100", dueAt: ago(MIN) });
    const statuses = [onRow, own, waiting, quiet, coming];
    const joined = new Set([`pr/${opsStatusKey("pr", "100", REPO)}`]);
    expect(ownRecords(statuses, joined)).toEqual([own, waiting]);
    // The Coming row carries #100's record: its time is the row's, never Rivet's own.
    expect(summarize(input({ asks: [], board: board({ coming: [row(100)] }), statuses })).asks).toEqual({ inHand: 0, noTime: 2, moved: 0 });
  });

  it("lets a record stand in for the pick-up ask made from it", () => {
    const pickup = ask("pickup", { who: "rivet", source: "pickup:app/notes-app", dueAt: ago(MIN) });
    expect(askCounts([pickup], [], NOW.getTime(), QUIET)).toMatchObject({ noTime: 1 });
    expect(askCounts([pickup], [record({ dueAt: later(MIN) })], NOW.getTime(), QUIET)).toMatchObject({ noTime: 0 });
  });

  it("counts one ask once though two Coming rows carry its PR, one building with no time and one at Your OK", () => {
    const coming = [row(2600, { stage: "building" }), row(2600, { stage: "owner-ok" })];
    const one = ask("one", { prs: [2600], dueAt: ago(20 * MIN), askedForTimeAt: ago(10 * MIN) });
    expect(summarize(input({ board: board({ coming }), asks: [one] })).asks).toEqual({ inHand: 1, noTime: 1, moved: 0 });
  });

  it("is all zeros with nothing in hand", () => {
    expect(summarize(input({ asks: [], board: null }))).toEqual({ needsYou: 0, minimised: 0, asks: { inHand: 0, noTime: 0, moved: 0 }, nextDoneAt: null });
  });
});

describe("GET /api/summary", () => {
  let server: TestServer;
  let cookie: string;
  beforeEach(async () => {
    server = await startServer({}, { now: () => NOW });
    cookie = server.cookie();
  });
  afterEach(async () => {
    await server.close();
  });

  const read = () => fetch(`${server.base}/api/summary`, { headers: { cookie } });
  const put = (body: unknown) => fetch(`${server.base}/api/board`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) });

  it("answers Sam's session only", async () => {
    expect((await fetch(`${server.base}/api/summary`)).status).toBe(401);
    expect((await read()).status).toBe(200);
  });

  it("is what summarize makes of the stored board, its open cards and their minimised revisions", async () => {
    expect(await (await read()).json()).toEqual({ needsYou: 0, minimised: 0, asks: { inHand: 0, noTime: 0, moved: 0 }, nextDoneAt: null });
    const need = (id: string) => ({ id, kind: "question" as const, title: `Card ${id}`, reply: "text" as const });
    // A Coming row at Your OK is a wait card too (asks/waits.ts): it counts once, as a card.
    expect((await put(board({ needs: [need("a"), need("b")], coming: [row(2500, { stage: "owner-ok" })] }))).status).toBe(200);
    for (const one of asks) server.app.store.addAsk(one);
    server.app.store.putWorkers({ workers: [], pushQueue: [{ chat: "on-it", repo: REPO, position: 1, at: 0 }] }, NOW.getTime());
    const served = (await (await fetch(`${server.base}/api/board`, { headers: { cookie } })).json()) as { board: Board & { needs: { id: string; rev: string }[] } };
    const a = served.board.needs.find((one) => one.id === "a")!;
    expect((await fetch(`${server.base}/api/minimised/a`, { method: "PUT", headers: browser(cookie), body: JSON.stringify({ small: true, rev: a.rev }) })).status).toBe(200);
    expect(await (await read()).json()).toEqual({
      needsYou: 2,
      minimised: 1,
      asks: { inHand: 5, noTime: 2, moved: 1 },
      nextDoneAt: later(30 * MIN),
    });
  });
});

describe("the quiet-hours digest", () => {
  let server: TestServer;
  afterEach(async () => server.close());

  it("opens with the summary's needs count as it goes, a minimised card left out", async () => {
    const sent: { body: string }[] = [];
    let at = Date.parse("2026-10-25T12:00:00.000Z"); // 11:00pm local, in quiet hours
    server = await startServer({}, { now: () => new Date(at), quiet: true, pushSender: { send: async (_target, body) => (sent.push(JSON.parse(body) as { body: string }), 201) } });
    server.app.push.subscribe({ endpoint: "https://fcm.googleapis.com/fcm/send/summary", keys: { p256dh: "key", auth: "auth" } });
    const cookie = server.cookie();
    const need = (id: string) => ({ id, kind: "question" as const, title: `Card ${id}`, reply: "text" as const });
    const put = (body: unknown) => fetch(`${server.base}/api/board`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) });
    expect((await put(board({ needs: [] }))).status).toBe(200);
    expect((await put(board({ needs: [need("a"), need("b")] }))).status).toBe(200);
    await expect.poll(() => server.app.quiet.heldCount()).toBe(2);
    const served = (await (await fetch(`${server.base}/api/board`, { headers: { cookie } })).json()) as { board: { needs: { id: string; rev: string }[] } };
    const a = served.board.needs.find((one) => one.id === "a")!;
    expect((await fetch(`${server.base}/api/minimised/a`, { method: "PUT", headers: browser(cookie), body: JSON.stringify({ small: true, rev: a.rev }) })).status).toBe(200);
    at += 9 * 3600_000; // 8:00am local
    await server.app.push.flushHeld();
    expect(sent.map((one) => one.body)).toEqual(["1 needs you now. Card a · Card b"]);
  });
});
