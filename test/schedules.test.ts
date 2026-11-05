import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { JobsStore } from "../src/server/jobs.js";
import { openBoard } from "../src/server/http.js";
import { summaryKeys, summaryPushKey, type PushPayload } from "../src/server/push.js";
import { pushFailing } from "../src/server/routes/schedules.js";
import { scheduleOfPushKey, SchedulesStore } from "../src/server/schedules.js";
import { Store } from "../src/server/store.js";
import type { BoardResponse, Need, Reply, ServedNeed } from "../src/shared/board.js";
import { jobScheduleKey, type JobSpec } from "../src/shared/jobs.js";
import type { AuditEntry } from "../src/shared/command.js";
import type { OpsResponse } from "../src/shared/ops.js";
import { opsStatusKey } from "../src/shared/ops-status-key.js";
import type { OpsStatus } from "../src/shared/ops-status.js";
import { RIVET_NAME } from "../src/shared/names.js";
import { scheduleSchema, SCHEDULES_STALE_MS, type BridgeSchedule, type RecentRun, type SchedulesResponse, type SchedulesSnapshot } from "../src/shared/schedules.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, browser, fakeClock, putBoard, startServer, type TestServer } from "./helpers.js";

const NIGHTLY = "mac:dev.rivet-agents.nightly-sweep";

function item(overrides: Partial<BridgeSchedule> = {}): BridgeSchedule {
  return {
    id: NIGHTLY,
    source: "mac",
    name: "Daily issue sweep",
    what: "Files issues for anything that broke overnight.",
    when: "Every day at 7am",
    group: "daily",
    on: true,
    lastRun: { at: "2026-10-01T21:00:00.000Z", result: "ok" },
    nextRun: "2026-10-02T21:00:00.000Z",
    toggle: { can: true },
    ...overrides,
  };
}

function snapshot(at: Date, items: BridgeSchedule[] = [item()]): SchedulesSnapshot {
  return { at: at.toISOString(), items, sources: [{ source: "mac", ok: true, at: at.toISOString() }] };
}

let server: TestServer;
let cookie: string;
let clock: ReturnType<typeof fakeClock>;
let seq = 0;
const clientId = () => `sched-${Date.now()}-${(seq += 1)}`;

beforeEach(async () => {
  clock = fakeClock();
  server = await startServer({}, { now: clock.now });
  cookie = server.cookie();
  await putBoard(server.base);
});

afterEach(async () => {
  await server.close();
});

const putSnapshot = (body: unknown, headers = bearer(BRIDGE_TOKEN)) =>
  fetch(`${server.base}/api/bridge/schedules`, { method: "PUT", headers, body: JSON.stringify(body) });
const getSchedules = async () => (await (await fetch(`${server.base}/api/schedules`, { headers: { cookie } })).json()) as SchedulesResponse;
const toggle = (body: Record<string, unknown>, headers: Record<string, string> = browser(cookie)) =>
  fetch(`${server.base}/api/actions/schedule`, { method: "POST", headers, body: JSON.stringify(body) });

async function connectBridge(): Promise<{ events(): { event: string; data: Record<string, unknown> }[]; waitFor(n: number): Promise<void>; abort(): void }> {
  const controller = new AbortController();
  const response = await fetch(`${server.base}/api/bridge/events`, { headers: bearer(BRIDGE_TOKEN), signal: controller.signal });
  expect(response.status).toBe(200);
  let buffer = "";
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
      }
    } catch {}
  })();
  const events = () =>
    buffer
      .split("\n\n")
      .filter((block) => block.startsWith("event:"))
      .map((block) => {
        const fields = Object.fromEntries(block.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]));
        return { event: fields.event!, data: JSON.parse(fields.data!) as Record<string, unknown> };
      })
      .filter((event) => event.event === "schedule");
  const waitFor = async (count: number) => {
    for (let i = 0; i < 200 && events().length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events().length).toBeGreaterThanOrEqual(count);
  };
  return { events, waitFor, abort: () => controller.abort() };
}

describe("the bridge's schedules snapshot", () => {
  it("takes only the bridge token and a valid snapshot", async () => {
    expect((await putSnapshot(snapshot(clock.now()), {})).status).toBe(401);
    expect((await putSnapshot(snapshot(clock.now()), bearer(BOARD_TOKEN))).status).toBe(401);
    expect((await putSnapshot({ ...snapshot(clock.now()), extra: 1 })).status).toBe(400);
    expect((await putSnapshot(snapshot(clock.now(), [item({ id: "mac:/bin/sh" })]))).status).toBe(400);
    expect((await putSnapshot(snapshot(clock.now(), [item(), item()]))).status).toBe(400);
    expect((await putSnapshot(snapshot(clock.now(), [item({ source: "cloud" as never, id: "cloud:nightly" })]))).status).toBe(400);
    // An item's source must match its id: a Mac id can't pass as GitHub's.
    expect((await putSnapshot(snapshot(clock.now(), [item({ id: "cloud:nightly" })]))).status).toBe(400);
    expect((await putSnapshot(snapshot(clock.now(), [item({ id: "mac:dev.rivet-agents.x", source: "github" })]))).status).toBe(400);
    expect((await putSnapshot(snapshot(clock.now(), [item({ runs: [{ id: "1", at: clock.now().toISOString(), result: "running" as never }] })]))).status).toBe(400);
    expect((await putSnapshot(snapshot(clock.now(), [item({ lastRun: { at: null, result: "failed", url: "https://evil.example/x" } })]))).status).toBe(400);
    expect((await putSnapshot(snapshot(clock.now()))).status).toBe(200);
  });

  it("takes every name and description the bridge gives a job, unclipped, and its clip at the limits", async () => {
    const libPath = "../bridge/lib/schedules/words.mjs";
    const lib = (await import(libPath)) as {
      WORDS: Record<string, { name: string; what: string }>;
      NAME_MAX: number;
      WHAT_MAX: number;
      wordsFor(key: string, fallbackName: string): { name: string; what: string };
    };
    // One description over the limit 400'd every snapshot for twelve hours.
    for (const [key, words] of Object.entries(lib.WORDS)) {
      expect(scheduleSchema.safeParse(item(words)).success, key).toBe(true);
      expect(lib.wordsFor(key, key), key).toEqual(words);
    }
    const long = lib.wordsFor("dev.rivet-agents.unnamed", "x".repeat(lib.NAME_MAX + 20));
    expect(scheduleSchema.safeParse(item({ ...long, what: "y".repeat(lib.WHAT_MAX) })).success).toBe(true);
    expect(scheduleSchema.safeParse(item({ what: "y".repeat(lib.WHAT_MAX + 1) })).success).toBe(false);
    expect(scheduleSchema.safeParse(item({ name: "x".repeat(lib.NAME_MAX + 1) })).success).toBe(false);
    // The refusal names the field, so the bridge's log does too.
    const refused = await putSnapshot(snapshot(clock.now(), [item({ what: "y".repeat(lib.WHAT_MAX + 1) })]));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { issues: { path: unknown[] }[] }).issues.map((issue) => issue.path)).toEqual([["items", 0, "what"]]);
  });

  it("needs a session to read, and goes stale after three minutes", async () => {
    expect((await fetch(`${server.base}/api/schedules`)).status).toBe(401);
    const empty = await getSchedules();
    expect(empty).toMatchObject({ at: null, stale: true, sources: [] });
    expect(empty.items).toEqual([]);

    await putSnapshot(snapshot(clock.now()));
    const fresh = await getSchedules();
    expect(fresh.stale).toBe(false);
    expect(fresh.items.map((entry) => entry.id)).toEqual([NIGHTLY]);
    clock.advance(SCHEDULES_STALE_MS + 1000);
    expect((await getSchedules()).stale).toBe(true);
  });
});

describe("the on/off switch", () => {
  it("needs a session, CSRF, a known id and a clientId", async () => {
    const body = { clientId: clientId(), schedule: NIGHTLY, on: false };
    const { cookie: _, ...noCookie } = browser(cookie);
    expect((await toggle(body, noCookie)).status).toBe(401);
    expect((await toggle(body, { ...browser(cookie), origin: "https://evil.example" })).status).toBe(403);
    expect((await toggle(body, bearer(BOARD_TOKEN))).status).toBe(403);
    expect((await toggle({ schedule: NIGHTLY, on: false })).status).toBe(400);
    expect((await toggle({ ...body, schedule: "mac:; rm -rf /" })).status).toBe(400);
    expect((await toggle({ ...body, on: "off" })).status).toBe(400);
    expect((await toggle({ ...body, delete: true })).status).toBe(400);
  });

  it("refuses a schedule the Mac has not listed, or one that can't be switched, with the reason", async () => {
    const missing = await toggle({ clientId: clientId(), schedule: NIGHTLY, on: false });
    expect(missing.status).toBe(404);
    await putSnapshot(snapshot(clock.now(), [item(), item({ id: "mac:dev.rivet-agents.rivet-bridge", source: "mac", toggle: { can: false, why: "It is the link to the Mac." } })]));
    const locked = await toggle({ clientId: clientId(), schedule: "mac:dev.rivet-agents.rivet-bridge", on: false });
    expect(locked.status).toBe(409);
    expect(((await locked.json()) as { entry: AuditEntry }).entry).toMatchObject({ kind: "schedule", status: "refused", detail: { reason: "It is the link to the Mac." } });
  });

  it("sends the switch to the bridge, audits what and when (the only session is the owner's), and the ack settles it", async () => {
    await putSnapshot(snapshot(clock.now()));
    const stream = await connectBridge();
    const response = await toggle({ clientId: clientId(), schedule: NIGHTLY, on: false });
    expect(response.status).toBe(202);
    const entry = (await response.json()) as AuditEntry;
    expect(entry).toMatchObject({ kind: "schedule", schedule: NIGHTLY, on: false, status: "queued" });
    await stream.waitFor(1);
    expect(stream.events()[0]!.data).toEqual({ id: entry.id, at: expect.any(String), schedule: NIGHTLY, on: false });
    const ack = await fetch(`${server.base}/api/bridge/action-ack`, {
      method: "POST",
      headers: bearer(BRIDGE_TOKEN),
      body: JSON.stringify({ id: entry.id, status: "succeeded", detail: { reason: "Turned off." } }),
    });
    expect(ack.status).toBe(200);
    const { entries } = (await (await fetch(`${server.base}/api/audit`, { headers: { cookie } })).json()) as { entries: AuditEntry[] };
    expect(entries[0]).toMatchObject({ id: entry.id, kind: "schedule", schedule: NIGHTLY, on: false, status: "succeeded", at: expect.any(String) });
    stream.abort();
  });

  it("fails at once when the bridge is offline", async () => {
    await putSnapshot(snapshot(clock.now()));
    const response = await toggle({ clientId: clientId(), schedule: NIGHTLY, on: true });
    expect(response.status).toBe(503);
  });
});

describe("a schedule failing twice in a row", () => {
  const SCAN = "github:example-org/example-repo/security-scan.yml";
  const REPO = "example-org/example-repo";
  const WHAT = "Checks the billing totals add up every night.";
  const runUrl = (run: number) => `https://github.com/${REPO}/actions/runs/${run}`;
  const run = (id: number, at: string, result: RecentRun["result"]): RecentRun => ({ id: String(id), at, result, url: runUrl(id) });
  /** The scan with its finished runs, newest first, as the bridge sends them. */
  const scan = (...runs: RecentRun[]) =>
    item({ id: SCAN, source: "github", name: "Security scan", what: WHAT, lastRun: runs[0] ? { at: runs[0].at, result: runs[0].result, url: runs[0].url } : null, runs });
  const send = async (...items: BridgeSchedule[]) => expect((await putSnapshot(snapshot(clock.now(), items))).status).toBe(200);
  const board = async (headers: Record<string, string> = { cookie }) => (await (await fetch(`${server.base}/api/board`, { headers })).json()) as BoardResponse;
  const cards = async (headers: Record<string, string> = { cookie }) => ((await board(headers)).board?.needs ?? []).filter((need) => need.id.startsWith("schedule-"));
  const failing = async () => ((await (await fetch(`${server.base}/api/ops`, { headers: { cookie } })).json()) as OpsResponse).summary.failingSchedules;
  const answer = (need: ServedNeed, choice: string) =>
    fetch(`${server.base}/api/replies`, { method: "POST", headers: browser(cookie), body: JSON.stringify({ clientId: clientId(), itemId: need.id, decision: "choice", choice, rev: need.rev }) });

  // 3 Oct, 11pm local time. The scan's first failure after a pass was 11:17pm on 2 Oct; older failures, 14 and 21 Sept, are out of the window.
  const TONIGHT = "2026-10-02T12:17:00.000Z";
  const passed = run(2, "2026-09-28T12:00:00.000Z", "ok");
  const twoFailed = [run(4, "2026-10-03T09:00:00.000Z", "failed"), run(3, TONIGHT, "failed"), passed];

  beforeEach(async () => {
    await server.close();
    clock = fakeClock(Date.parse("2026-10-03T12:00:00.000Z"));
    server = await startServer({}, { now: clock.now });
    cookie = server.cookie();
  });

  it("the server's need-you count has the open card the Feed shows, and drops it once answered", async () => {
    const needs = async () => ((await (await fetch(`${server.base}/api/ops`, { headers: { cookie } })).json()) as OpsResponse).summary.needs;
    expect(await needs()).toBe(0);
    await send(scan(...twoFailed));
    expect(await needs()).toBe(1);
    const [card] = await cards();
    expect((await answer(card!, "Leave it")).status).toBe(201);
    expect(await needs()).toBe(0);
  });

  it("never cards September's history: tonight's failure and 21 Sept's are more than eight days apart", async () => {
    await send(scan(run(3, TONIGHT, "failed"), run(2, "2026-09-21T09:00:00.000Z", "failed"), run(1, "2026-09-14T09:00:00.000Z", "failed")));
    expect(await cards()).toEqual([]);
    expect(await failing()).toBe(0);
    // One failure after a pass is not a streak either.
    await send(scan(run(3, TONIGHT, "failed"), passed));
    expect(await cards()).toEqual([]);
  });

  it("holds an ordinary schedule's card for Rivet until the streak is a day old; a money schedule's cards at once", async () => {
    const ordinary = item({ id: "github:example-org/example-repo/lint.yml", source: "github", name: "Lint", what: "Checks the code style.", lastRun: { at: twoFailed[0]!.at, result: "failed", url: twoFailed[0]!.url }, runs: twoFailed });
    await send(ordinary);
    expect(await cards()).toEqual([]);
    expect(await failing()).toBe(1);
    clock.advance(25 * 3_600_000);
    await send(ordinary);
    expect((await cards()).map((need) => need.title)).toEqual(["Lint failing since 2 Oct"]);
    await send(scan(...twoFailed));
    expect((await cards()).map((need) => need.title)).toContain("Security scan failing since 2 Oct");
  });

  it("counts only the schedules /api/schedules lists on Ops: a red job keeps its card and is counted on Scheduled", async () => {
    await send(scan(passed));
    const jobs = new JobsStore(server.dataDir);
    onTestFinished(() => jobs.close());
    const spec: JobSpec = { name: "Typecheck", words: "typecheck main", kind: "check", check: { script: "typecheck", where: "mac", onRed: "card" }, when: { every: "day", at: "07:00" }, cards: "red" };
    expect(jobs.create("j-redjob01", spec, clock.now()).ok).toBe(true);
    expect(jobs.start("j-redjob01", { run: "run-00000001", state: "start" }, clock.now())?.go).toBe(true);
    expect(jobs.finish("j-redjob01", { run: "run-00000001", state: "red", line: "Failed: 3 errors" }, clock.now()).status).toBe(200);
    expect(await failing()).toBe(0);
    expect((await cards()).map((need) => need.title)).toEqual(["Typecheck is red"]);
  });

  it("an old schedules reading counts no failing schedule on Ops, and keeps its card", async () => {
    await send(scan(...twoFailed));
    expect(await failing()).toBe(1);
    clock.advance(4 * 60_000);
    expect(await failing()).toBe(0);
    expect(await cards()).toHaveLength(1);
  });

  it("two failed in a row is one card, with the newest run, the repo and the schedule; replays and later failures keep it", async () => {
    await send(scan(...twoFailed));
    await send(scan(...twoFailed));
    const [card, ...more] = await cards();
    expect(more).toEqual([]);
    expect(card).toMatchObject({
      kind: "decision",
      title: "Security scan failing since 2 Oct",
      ask: `Its last 2 runs failed. ${WHAT}`,
      since: TONIGHT,
      repo: REPO,
      schedule: SCAN,
      options: [{ label: "Ask Rivet to fix" }, { label: "Leave it" }],
      links: [{ label: "Open run", url: runUrl(4), primary: true }],
    });
    expect(card).not.toHaveProperty("chat");
    expect(await failing()).toBe(1);

    await send(scan(run(5, "2026-10-03T11:00:00.000Z", "failed"), ...twoFailed));
    const [later] = await cards();
    expect(later).toMatchObject({ id: card!.id, ask: expect.stringContaining("last 3 runs"), links: [{ url: runUrl(5) }] });
    // Rivet's own read shows it too, so `rivet board` lists it.
    expect((await cards(bearer(BOARD_TOKEN))).map((need) => need.id)).toEqual([card!.id]);
  });

  it("a weekly schedule's two failures a week apart are a card; nine days apart are not", async () => {
    await send(scan(run(4, "2026-10-03T09:00:00.000Z", "failed"), run(3, "2026-09-26T09:00:00.000Z", "failed")));
    expect(await cards()).toHaveLength(1);
    await send(scan(run(4, "2026-10-03T09:00:00.000Z", "failed"), run(3, "2026-09-24T09:00:00.000Z", "failed")));
    expect(await cards()).toEqual([]);
  });

  it("goes when the schedule works again, a failed run re-run to success too, and the next streak is a new card", async () => {
    await send(scan(...twoFailed));
    const [first] = await cards();
    await send(scan(run(4, "2026-10-03T09:30:00.000Z", "ok"), ...twoFailed.slice(1)));
    expect(await cards()).toEqual([]);
    expect(await failing()).toBe(0);
    await send(scan(run(6, "2026-10-03T11:00:00.000Z", "failed"), run(5, "2026-10-03T10:00:00.000Z", "failed"), run(4, "2026-10-03T09:30:00.000Z", "ok")));
    const [second] = await cards();
    expect(second).toMatchObject({ title: "Security scan failing since 3 Oct" });
    expect(second!.id).not.toBe(first!.id);
  });

  it("an always-on job never gets a card: it never finishes as ok", async () => {
    await send(item({ id: "mac:dev.rivet-agents.watcher", source: "mac", name: "Watcher", group: "always-on", runs: twoFailed.map(({ url: _, ...rest }) => rest) }));
    expect(await cards()).toEqual([]);
  });

  it("a Mac job's card has no Open run, and its answer goes to Rivet's own repo", async () => {
    const mac = (id: string, at: string): RecentRun => ({ id, at, result: "failed" });
    await send(item({ id: "mac:dev.rivet-agents.nightly-collect", source: "mac", name: "Morning collect", what: "Collects the billing totals each morning.", runs: [mac("4:1:@b", "2026-10-03T08:45:00.000Z"), mac("3:1:@a", "2026-10-02T20:45:00.000Z")] }));
    const [card] = await cards();
    expect(card).toMatchObject({ title: "Morning collect failing since 3 Oct", schedule: "mac:dev.rivet-agents.nightly-collect" });
    expect(card).not.toHaveProperty("links");
    expect(card).not.toHaveProperty("repo");
  });

  it("Leave it silences the streak; Ask Rivet to fix reaches Rivet with the schedule, repo and newest failed run", async () => {
    await send(scan(...twoFailed));
    const [card] = await cards();
    expect((await answer(card!, "Leave it")).status).toBe(201);
    expect(await cards()).toEqual([]);
    await send(scan(run(5, "2026-10-03T11:00:00.000Z", "failed"), ...twoFailed));
    expect(await cards()).toEqual([]);
    // Still failing, so still counted.
    expect(await failing()).toBe(1);
    expect((await answer(card!, "Ask Rivet to fix")).status).toBe(404);

    clock.advance(86_400_000);
    await send(scan(run(8, "2026-10-04T11:00:00.000Z", "failed"), run(7, "2026-10-04T10:00:00.000Z", "failed"), run(6, "2026-10-04T09:00:00.000Z", "ok")));
    const [next] = await cards();
    expect((await answer(next!, "Ask Rivet to fix")).status).toBe(201);
    const { replies } = (await (await fetch(`${server.base}/api/replies?handled=false`, { headers: bearer(BOARD_TOKEN) })).json()) as { replies: Reply[] };
    expect(replies.find((reply) => reply.itemId === next!.id)).toMatchObject({
      decision: "choice",
      choice: "Ask Rivet to fix",
      itemTitle: "Security scan failing since 4 Oct",
      item: {
        kind: "decision",
        repo: REPO,
        ask: `Its last 2 runs failed. ${WHAT} Schedule: Security scan (${SCAN}), repo ${REPO}. Newest failed run: ${runUrl(8)}.`,
      },
    });
    expect(await cards()).toEqual([]);
  });

  it("the board token can't write a schedule- card, and an answer always finds the server's own", async () => {
    await putBoard(server.base);
    const stored = await board(bearer(BOARD_TOKEN));
    const fake = { id: "schedule-fake", kind: "decision", title: "Fake", options: [{ label: "Ask Rivet to fix" }] };
    expect((await putBoard(server.base, { ...stored.board, needs: [...stored.board!.needs, fake] })).status).toBe(400);
    const one = await fetch(`${server.base}/api/board/needs/schedule-fake`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify(fake) });
    expect(one.status).toBe(400);

    await send(scan(...twoFailed));
    const [card] = await cards();
    const replaced = await fetch(`${server.base}/api/board/needs/${card!.id}`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ ...fake, id: card!.id }) });
    expect(replaced.status).toBe(400);
    expect((await cards()).map((need) => need.title)).toEqual(["Security scan failing since 2 Oct"]);
    expect((await answer(card!, "Ask Rivet to fix")).status).toBe(201);
  });

  it("shows on the feed with no board stored yet", async () => {
    expect((await board()).board).toBeNull();
    await send(scan(...twoFailed));
    const served = await board();
    expect(served.version).toBe(0);
    expect(served.board!.needs.map((need) => need.title)).toEqual(["Security scan failing since 2 Oct"]);
  });

  it("a card is pushed once, when it first shows: not on a replay, a restart, a longer streak or one that outlives the window", () => {
    const dir = mkdtempSync(join(tmpdir(), "rivet-schedules-"));
    try {
      let store = new SchedulesStore(dir);
      const at = new Date("2026-10-03T12:00:00.000Z");
      const [pushed, ...more] = store.put(snapshot(at, [scan(...twoFailed)]), at);
      expect(more).toEqual([]);
      expect(store.put(snapshot(at, [scan(...twoFailed)]), at)).toEqual([]);
      store.close();
      store = new SchedulesStore(dir);
      expect(store.put(snapshot(at, [scan(...twoFailed)]), at)).toEqual([]);
      // Ten days on, tonight's failure is out of the window, but the streak and its card run on under the same id.
      const later = new Date("2026-10-13T12:00:00.000Z");
      const longer = scan(run(9, "2026-10-13T09:00:00.000Z", "failed"), run(8, "2026-10-12T09:00:00.000Z", "failed"), run(7, "2026-10-11T09:00:00.000Z", "failed"), run(6, "2026-10-10T09:00:00.000Z", "failed"), run(5, "2026-10-09T09:00:00.000Z", "failed"));
      expect(store.put(snapshot(later, [longer]), later)).toEqual([]);
      expect(store.failing(later).map(({ need }) => need.id)).toEqual([pushed!.id]);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a parked job is quiet until a run of its streak names money, and someone on it stays owned", () => {
    const dir = mkdtempSync(join(tmpdir(), "rivet-schedules-"));
    const statuses = new Store(dir);
    const store = new SchedulesStore(dir);
    try {
      const at = new Date("2026-10-03T12:00:00.000Z");
      const job = (id: string, name: string, line: string, state: OpsStatus["state"], script = "typecheck") => {
        expect(store.jobs.create(id, { name, words: "typecheck main", kind: "check", check: { script, where: "mac", onRed: "card" }, when: { every: "day", at: "07:00" }, cards: "red" }, at).ok).toBe(true);
        expect(store.jobs.start(id, { run: `run-${id.slice(2)}`, state: "start" }, at)?.go).toBe(true);
        expect(store.jobs.finish(id, { run: `run-${id.slice(2)}`, state: "red", line }, at).status).toBe(200);
        const key = jobScheduleKey(id);
        expect(statuses.addOpsStatus({ kind: "schedule", key, state, since: TONIGHT, updatedAt: TONIGHT, version: statuses.nextOpsStatusVersion() })).toBe(true);
        return store.owned(key);
      };
      expect(job("j-aaaaaaaa", "Nightly one", "Failed: 3 errors", "parked")).toBe(true);
      expect(job("j-cccccccc", "Nightly three", "Billing reconciliation mismatch", "parked")).toBe(false);
      expect(job("j-dddddddd", "Nightly four", "Billing reconciliation mismatch", "in-progress")).toBe(true);
      expect(job("j-ffffffff", "Nightly six", "Failed: 3 errors", "parked", "test:billing")).toBe(false);
    } finally {
      store.close();
      statuses.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a schedule someone is on files no card and pushes nothing; once nobody is, its card is filed and pushed", () => {
    const dir = mkdtempSync(join(tmpdir(), "rivet-schedules-"));
    const statuses = new Store(dir);
    const store = new SchedulesStore(dir);
    try {
      const key = opsStatusKey("schedule", SCAN);
      const record = (state: OpsStatus["state"]) => {
        const current = statuses.getOpsStatus("schedule", key);
        const next = { kind: "schedule" as const, key, state, since: TONIGHT, updatedAt: TONIGHT, version: statuses.nextOpsStatusVersion() };
        expect(current ? statuses.replaceOpsStatus(next, current.version) : statuses.addOpsStatus(next)).toBe(true);
      };
      const at = new Date("2026-10-03T12:00:00.000Z");
      record("investigating");
      expect(store.put(snapshot(at, [scan(...twoFailed)]), at)).toEqual([]);
      expect(store.failing(at).map(({ owned }) => owned)).toEqual([true]);
      expect(openBoard(statuses, store, null, at)?.needs ?? [], "off the need-you count").toEqual([]);
      record("backlog");
      const [card, ...more] = store.put(snapshot(at, [scan(...twoFailed)]), at);
      expect(card?.title).toBe("Security scan failing since 2 Oct");
      expect(more).toEqual([]);
      expect(openBoard(statuses, store, null, at)?.needs.map((need) => need.id)).toEqual([card!.id]);
    } finally {
      store.close();
      statuses.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a card push quiet hours held leaves the digest once someone is on the schedule, and goes once nobody is", async () => {
    const sent: PushPayload[] = [];
    await server.close();
    server = await startServer({}, { now: clock.now, quiet: true, pushSender: { send: async (_target, body) => (sent.push(JSON.parse(body) as PushPayload), 201) } });
    server.app.push.subscribe({ endpoint: "https://fcm.googleapis.com/fcm/send/schedules", keys: { p256dh: "key", auth: "auth" } });
    const { store } = server.app;
    const key = opsStatusKey("schedule", SCAN);
    const record = (state: OpsStatus["state"]) => {
      const current = store.getOpsStatus("schedule", key);
      const next = { kind: "schedule" as const, key, state, since: TONIGHT, updatedAt: clock.now().toISOString(), version: store.nextOpsStatusVersion() };
      expect(current ? store.replaceOpsStatus(next, current.version) : store.addOpsStatus(next)).toBe(true);
    };
    // 11pm local: quiet hours hold the card's push.
    await send(scan(...twoFailed));
    await expect.poll(() => server.app.quiet.heldCount()).toBe(1);
    record("investigating");
    // It passes, then fails twice more: a new streak, on which someone is still working; the old card's push still waits.
    const fixed = run(5, "2026-10-03T10:00:00.000Z", "ok");
    await send(scan(fixed, ...twoFailed));
    await send(scan(run(7, "2026-10-03T10:20:00.000Z", "failed"), run(6, "2026-10-03T10:10:00.000Z", "failed"), fixed, ...twoFailed.slice(0, 2)));
    expect(server.app.quiet.heldCount()).toBe(1);
    clock.advance(10 * 3600_000);
    await server.app.push.flushHeld();
    expect(sent, "someone is on it: no digest").toEqual([]);
    expect(server.app.quiet.heldCount()).toBe(0);
    record("backlog");
    await send(scan(...twoFailed));
    await expect.poll(() => sent.map((payload) => payload.title)).toEqual(["Security scan failing since 2 Oct"]);
  });

  it("a scan-stall Got it card's push quiet hours held leaves the digest once someone is on the scan; the card stays", async () => {
    const sent: PushPayload[] = [];
    await server.close();
    server = await startServer({}, { now: clock.now, quiet: true, pushSender: { send: async (_target, body) => (sent.push(JSON.parse(body) as PushPayload), 201) } });
    server.app.push.subscribe({ endpoint: "https://fcm.googleapis.com/fcm/send/scan-stall", keys: { p256dh: "key", auth: "auth" } });
    const { store } = server.app;
    const schedule = "mac:dev.rivet-agents.nightly-scan";
    const key = opsStatusKey("schedule", schedule);
    const say = (text: string) =>
      fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ text, tag: "Backlog", schedule }) });
    // 11pm local, nobody on it: the card goes, quiet hours hold its push.
    expect((await say("Nightly scan has stopped\nIt last finished over 24 hours ago.")).status).toBe(201);
    await expect.poll(() => server.app.quiet.heldCount()).toBe(1);
    store.addOpsStatus({ kind: "schedule", key, state: "investigating", since: TONIGHT, updatedAt: clock.now().toISOString(), version: store.nextOpsStatusVersion() });
    clock.advance(10 * 3600_000);
    await server.app.push.flushHeld();
    expect(sent, "someone is on it: no digest").toEqual([]);
    expect(server.app.quiet.heldCount()).toBe(0);
    const board = (await (await fetch(`${server.base}/api/board`, { headers: bearer(BOARD_TOKEN) })).json()) as BoardResponse;
    expect(board.board?.needs.map((need) => need.title)).toContain("Backlog: Nightly scan has stopped");
    // A decision card naming the schedule is still the owner's to answer: its held push is never withdrawn.
    clock.advance(14 * 3600_000);
    const decision = { kind: "decision", title: "Approve the scan fix", options: [{ label: "Yes" }, { label: "No" }], schedule };
    expect((await fetch(`${server.base}/api/board/needs/scan-ok?create=only`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify(decision) })).status).toBe(200);
    await expect.poll(() => server.app.quiet.heldCount()).toBe(1);
    clock.advance(10 * 3600_000);
    await server.app.push.flushHeld();
    expect(sent.map((payload) => payload.title).join(" ")).toContain("Approve the scan fix");
    // A Got it card since turned into a plan is the owner's to answer too: its held push goes.
    sent.length = 0;
    clock.advance(14 * 3600_000);
    expect((await fetch(`${server.base}/api/ops/status/schedule/${key}`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ state: "backlog", by: "scan-fix" }) })).status).toBeLessThan(300);
    expect((await say("Nightly scan has stopped again")).status).toBe(201);
    await expect.poll(() => server.app.quiet.heldCount()).toBe(1);
    const turned = (await (await fetch(`${server.base}/api/board`, { headers: bearer(BOARD_TOKEN) })).json()) as BoardResponse;
    const card = turned.board?.needs.find((need) => need.title === "Backlog: Nightly scan has stopped again");
    const patch = { kind: "plan", options: null };
    expect((await fetch(`${server.base}/api/board/needs/${card?.id}`, { method: "PATCH", headers: bearer(BOARD_TOKEN), body: JSON.stringify(patch) })).status).toBe(200);
    expect((await fetch(`${server.base}/api/ops/status/schedule/${key}`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ state: "investigating", eta: "90", why: "fixing the scan", by: "scan-fix" }) })).status).toBeLessThan(300);
    clock.advance(10 * 3600_000);
    await server.app.push.flushHeld();
    expect(sent.map((payload) => payload.title).join(" ")).toContain("Nightly scan has stopped again");
    // A card taken off the board before someone is on the scan: its held push leaves too.
    sent.length = 0;
    clock.advance(14 * 3600_000);
    const ops = (state: string) => fetch(`${server.base}/api/ops/status/schedule/${key}`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ state, eta: "90", why: "fixing the scan", by: "scan-fix" }) });
    expect((await ops("backlog")).status).toBeLessThan(300);
    expect((await say("Nightly scan has stopped a third time")).status).toBe(201);
    await expect.poll(() => server.app.quiet.heldCount()).toBe(1);
    const third = (await (await fetch(`${server.base}/api/board`, { headers: bearer(BOARD_TOKEN) })).json()) as BoardResponse;
    const gone = third.board?.needs.find((need) => need.title === "Backlog: Nightly scan has stopped a third time");
    expect((await fetch(`${server.base}/api/board/needs/${gone?.id}`, { method: "DELETE", headers: bearer(BOARD_TOKEN) })).status).toBeLessThan(300);
    expect((await ops("investigating")).status).toBeLessThan(300);
    clock.advance(10 * 3600_000);
    await server.app.push.flushHeld();
    expect(sent).toEqual([]);
  });

  it("an update card about a schedule someone is on, written straight to the board, stays there unpushed", async () => {
    const sent: PushPayload[] = [];
    await server.close();
    server = await startServer({}, { now: clock.now, quiet: false, pushSender: { send: async (_target, body) => (sent.push(JSON.parse(body) as PushPayload), 201) } });
    server.app.push.subscribe({ endpoint: "https://fcm.googleapis.com/fcm/send/board-write", keys: { p256dh: "key", auth: "auth" } });
    const { store } = server.app;
    const schedule = "mac:dev.rivet-agents.nightly-scan";
    store.addOpsStatus({ kind: "schedule", key: opsStatusKey("schedule", schedule), state: "investigating", since: TONIGHT, updatedAt: clock.now().toISOString(), version: store.nextOpsStatusVersion() });
    const put = (id: string, card: Record<string, unknown>) =>
      fetch(`${server.base}/api/board/needs/${id}?create=only`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ ...card, schedule }) });
    expect((await put("scan-alert", { kind: "update", title: "Scan has stopped" })).status).toBe(200);
    // A decision card naming the schedule is still the owner's to answer: it pushes.
    expect((await put("scan-ok", { kind: "decision", title: "Approve the scan fix", options: [{ label: "Yes" }, { label: "No" }] })).status).toBe(200);
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]?.title).toContain("Approve the scan fix");
    const board = (await (await fetch(`${server.base}/api/board`, { headers: bearer(BOARD_TOKEN) })).json()) as BoardResponse;
    expect(board.board?.needs.map((need) => need.title)).toContain("Scan has stopped");
  });

  it("pushes many failing schedules as any new cards, at most five, each card's under its schedule's key", () => {
    const pushed: { title: string; key: string | undefined }[] = [];
    const push = { notify: async (payload: PushPayload, _category: string, key?: string) => (pushed.push({ title: payload.title, key }), { sent: 1, removed: 0 }) };
    const cards: Need[] = Array.from({ length: 7 }, (_, n) => ({ id: `schedule-${n}`, kind: "decision", title: `Job ${n} failing`, ask: "Its last 2 runs failed.", schedule: `mac:dev.rivet-agents.job-${n}` }));
    pushFailing(push as never, { error: () => {} } as never, cards);
    expect(pushed).toHaveLength(5);
    expect(pushed.slice(0, 4).map(({ key }) => key && scheduleOfPushKey(key))).toEqual(["mac:dev.rivet-agents.job-0", "mac:dev.rivet-agents.job-1", "mac:dev.rivet-agents.job-2", "mac:dev.rivet-agents.job-3"]);
    expect(pushed[4]).toEqual({ title: "3 more cards", key: summaryPushKey(cards.slice(4).map((card) => `schedule-card:${card.schedule}:${card.id}`)) });
  });

  describe("a \"more cards\" push quiet hours held", () => {
    const job = (n: number) => ({ ...scan(...twoFailed), id: `github:${REPO}/job-${n}.yml`, name: `Job ${n}` });
    let sent: PushPayload[];
    beforeEach(async () => {
      sent = [];
      await server.close();
      server = await startServer({}, { now: clock.now, quiet: true, pushSender: { send: async (_target, body) => (sent.push(JSON.parse(body) as PushPayload), 201) } });
      server.app.push.subscribe({ endpoint: "https://fcm.googleapis.com/fcm/send/more-cards", keys: { p256dh: "key", auth: "auth" } });
    });
    const record = (schedule: string, state: OpsStatus["state"]) => {
      const { store } = server.app;
      const key = opsStatusKey("schedule", schedule);
      const current = store.getOpsStatus("schedule", key);
      const next = { kind: "schedule" as const, key, state, since: TONIGHT, updatedAt: clock.now().toISOString(), version: store.nextOpsStatusVersion() };
      expect(current ? store.replaceOpsStatus(next, current.version) : store.addOpsStatus(next)).toBe(true);
    };
    /** 11pm local: seven schedules fail at once, four cards and a summary of three held; the summary's schedules. */
    const failSeven = async () => {
      await send(...Array.from({ length: 7 }, (_, n) => job(n)));
      await expect.poll(() => server.app.quiet.heldCount()).toBe(5);
      const summary = server.app.quiet.releasable(new Date(clock.now().getTime() + 10 * 3600_000))!.keys.find((key) => summaryKeys(key).length);
      return summaryKeys(summary!).map((key) => scheduleOfPushKey(key)!);
    };

    it("leaves the digest once someone is on every schedule it counts; their cards push again once nobody is", async () => {
      const counted = await failSeven();
      expect(counted).toHaveLength(3);
      for (const schedule of counted) record(schedule, "investigating");
      clock.advance(10 * 3600_000);
      await server.app.push.flushHeld();
      expect(sent.map((payload) => payload.title)).toEqual([`${RIVET_NAME} held 4 pings while it was quiet`]);
      expect(sent[0]!.body).not.toContain("more cards");
      expect(server.app.quiet.heldCount()).toBe(0);
      for (const schedule of counted) record(schedule, "backlog");
      await send(...Array.from({ length: 7 }, (_, n) => job(n)));
      await expect.poll(() => sent.length).toBe(4);
      expect(sent.slice(1).map((payload) => payload.title).sort()).toEqual(counted.map((schedule) => `Job ${schedule.slice(-5, -4)} failing since 2 Oct`).sort());
    });

    it("still goes while nobody is on one of them", async () => {
      const counted = await failSeven();
      for (const schedule of counted.slice(1)) record(schedule, "investigating");
      clock.advance(10 * 3600_000);
      await server.app.push.flushHeld();
      expect(sent.map((payload) => payload.title)).toEqual([`${RIVET_NAME} held 5 pings while it was quiet`]);
    });
  });

  it("a card first seen on a longer streak is still pushed", () => {
    const dir = mkdtempSync(join(tmpdir(), "rivet-schedules-"));
    try {
      const store = new SchedulesStore(dir);
      const at = new Date("2026-10-03T12:00:00.000Z");
      expect(store.put(snapshot(at, [scan(run(5, "2026-10-03T11:00:00.000Z", "failed"), ...twoFailed)]), at)).toHaveLength(1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an answered schedule stays quiet through its whole streak, past five runs and eight days, until a run passes", async () => {
    await send(scan(...twoFailed));
    const [card] = await cards();
    expect((await answer(card!, "Leave it")).status).toBe(201);
    clock.advance(10 * 86_400_000);
    const failedDaily = [13, 12, 11, 10, 9].map((day) => run(day, `2026-10-${String(day).padStart(2, "0")}T09:00:00.000Z`, "failed"));
    await send(scan(...failedDaily));
    expect(await cards()).toEqual([]);
    expect(await failing()).toBe(1);
    // A pass from before the answer doesn't count; one after it does, and the next streak is a new card.
    await send(scan(run(15, "2026-10-13T11:00:00.000Z", "failed"), run(14, "2026-10-13T10:00:00.000Z", "failed"), run(4, "2026-10-03T10:00:00.000Z", "ok")));
    expect(await cards()).toEqual([]);
    await send(scan(run(18, "2026-10-13T11:30:00.000Z", "failed"), run(17, "2026-10-13T11:20:00.000Z", "failed"), run(16, "2026-10-13T11:10:00.000Z", "ok")));
    expect((await cards()).map((need) => need.title)).toEqual(["Security scan failing since 13 Oct"]);
  });

  it("says failing since the oldest failure inside the eight days, never September's", async () => {
    await send(scan(run(4, "2026-10-03T09:00:00.000Z", "failed"), run(3, TONIGHT, "failed"), run(2, "2026-09-21T09:00:00.000Z", "failed"), run(1, "2026-09-14T09:00:00.000Z", "failed")));
    expect(await cards()).toMatchObject([{ title: "Security scan failing since 2 Oct", ask: `Its last 2 runs failed. ${WHAT}`, since: TONIGHT }]);
  });

  it("ignores a bridge read older than the one stored", async () => {
    await send(scan(...twoFailed));
    const late = { ...snapshot(new Date(clock.now().getTime() - 120_000), [scan(run(5, "2026-10-03T11:00:00.000Z", "ok"), ...twoFailed)]) };
    expect((await putSnapshot(late)).status).toBe(200);
    expect(await cards()).toHaveLength(1);
    expect((await getSchedules()).at).toBe(clock.now().toISOString());
  });
});
