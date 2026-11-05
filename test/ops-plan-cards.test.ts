import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Need } from "../src/shared/board.js";
import { cardId, cardReason, opsCardPushKey, type CardEntry } from "../src/shared/ops-cards.js";
import { opsStatusKey } from "../src/shared/ops-status-key.js";
import { setKnownRepos } from "../src/shared/repos.js";
import { isOwnerHold } from "../src/shared/pr-holds.js";
import type { OwnerHold } from "../src/shared/owner-holds.js";
import type { OpsStatus } from "../src/shared/ops-status.js";
import type { JobSpec } from "../src/shared/jobs.js";
import { jobScheduleKey } from "../src/shared/jobs.js";
import type { Health, OpsResponse, PullRequest } from "../src/shared/ops.js";
import { noCards, opsCardItems, syncOpsCards } from "../src/server/ops/cards.js";
import { JobsStore } from "../src/server/jobs.js";
import { SchedulesStore } from "../src/server/schedules.js";
import { lateCardId } from "../src/server/ops/late.js";
import { createOps } from "../src/server/ops/service.js";
import { OpsStore } from "../src/server/ops/store.js";
import type { PushPayload } from "../src/server/push.js";
import { Store } from "../src/server/store.js";
import { bearer, BOARD_TOKEN, fakeClock, putBoard, startServer } from "./helpers.js";

// 1pm on Saturday 24 Oct local time.
const START = Date.parse("2026-10-24T02:00:00.000Z");
const APP = opsStatusKey("app", "tasks-app");
const iso = (ms: number) => new Date(ms).toISOString();

let dir = "";
beforeAll(() => setKnownRepos(["example-org/example-repo", "example-org/other-repo"]));
afterAll(() => setKnownRepos([]));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup() {
  dir = mkdtempSync(join(tmpdir(), "rivet-plan-cards-"));
  const store = new Store(dir);
  let at = START;
  let sent = 1;
  const pushed: { category: string; key: string; title: string }[] = [];
  const adds: Need[] = [];
  const releases: ((keys: readonly string[]) => readonly string[])[] = [];
  const ops = createOps({
    dataDir: dir,
    store,
    bridge: { status: () => ({ connected: true }) as never },
    push: {
      notify: async (payload: PushPayload, category: string, key: string) => (pushed.push({ category, key, title: payload.title }), { sent }),
      flushHeld: async () => null,
      onDigestSettled: () => () => {},
      onDigestRelease: (check: (keys: readonly string[]) => readonly string[]) => (releases.push(check), () => {}),
      onDigestReword: () => () => {},
    } as never,
    checks: [{ name: "tasks-app", url: "https://tasks-app.example/health" }],
    fetch: (async () => new Response("")) as typeof fetch,
    now: () => new Date(at),
    logger: { error: () => {} },
    addUpdate: (card) => {
      const stored = store.getBoard();
      const board = stored?.board ?? { updatedAt: iso(at), needs: [], coming: [], chats: [], shipped: [], waitingWM: [] };
      if (board.needs.some((need) => need.id === card.id)) return { status: 409, error: "exists" };
      adds.push(card as unknown as Need);
      store.putBoard({ ...board, needs: [...board.needs, card as unknown as Need] }, stored?.version ?? null);
      return { status: 200 };
    },
  });
  const health = (state: Health["state"]): Health => ({ state, status: state === "up" ? 200 : 502, ms: 40, checkedAt: iso(at), since: iso(at), fails: state === "down" ? 5 : 0 });
  const record = (extra: Partial<OpsStatus>) =>
    store.addOpsStatus({ kind: "ci", key: "build", state: "investigating", since: iso(at), updatedAt: iso(at), version: store.nextOpsStatusVersion(), ...extra });
  return {
    store,
    ops,
    pushed,
    adds,
    releases,
    health,
    record,
    advance: (ms: number) => (at += ms),
    pushSends: (count: number) => (sent = count),
    boardIds: () => (store.getBoard()?.board.needs ?? []).map((need) => need.id),
    close: () => (ops.close(), store.close()),
  };
}

const BILLING = "mac:dev.rivet-agents.billing-audit";

/** The bridge reads the billing audit with these failed runs (ms), at `snapshotAt`; with `answerAt`, Sam answers its card then. */
function fileBilling(failedAt: number[], snapshotAt: number, answerAt?: number): void {
  const schedules = new SchedulesStore(dir);
  schedules.put(
    {
      at: iso(snapshotAt),
      sources: [{ source: "mac", ok: true, at: iso(snapshotAt) }],
      items: [
        {
          id: BILLING,
          source: "mac",
          name: "Billing audit",
          what: "Audits billing every night.",
          when: "Every night",
          group: "daily",
          on: true,
          lastRun: null,
          nextRun: null,
          toggle: { can: true },
          runs: failedAt.map((at) => ({ id: `${at}:1:@a`, at: iso(at), result: "failed" as const })).reverse(),
        },
      ],
    },
    new Date(snapshotAt),
  );
  if (answerAt !== undefined) schedules.answer(schedules.failing(new Date(answerAt))[0]!, new Date(answerAt));
  schedules.close();
}

describe("Ops cards on the server", () => {
  it("cards a money record at once, once, and nothing for a fresh ordinary one", () => {
    const t = setup();
    t.record({ kind: "ci", key: "build", note: "Build is red" });
    t.record({ kind: "ci", key: "billing-sync", note: "Billing sync failed for notes-app" });
    t.ops.syncCards();
    t.ops.syncCards();
    expect(t.adds).toHaveLength(1);
    expect(t.adds[0]).toMatchObject({ kind: "decision", title: "Billing sync failed for notes-app" });
    t.close();
  });

  it("cards a late record past 24 hours, and takes the card back once the record is fixed", () => {
    const t = setup();
    t.record({ kind: "pr", key: "88", note: "Waiting on a rebase" });
    t.ops.syncCards();
    expect(t.boardIds()).toEqual([]);
    t.advance(25 * 3600_000);
    t.ops.syncCards();
    expect(t.boardIds()).toHaveLength(1);
    const record = t.store.getOpsStatus("pr", "88")!;
    t.store.replaceOpsStatus({ ...record, state: "fixed", updatedAt: iso(START + 25 * 3600_000), version: t.store.nextOpsStatusVersion() }, record.version);
    t.ops.syncCards();
    expect(t.boardIds()).toEqual([]);
    t.close();
  });

  it("a card belongs to one incident: the key reopened later gets a fresh card", () => {
    const t = setup();
    t.record({ kind: "ci", key: "billing-check", note: "Billing check red" });
    t.ops.syncCards();
    const [first] = t.boardIds();
    const record = t.store.getOpsStatus("ci", "billing-check")!;
    t.store.deleteOpsStatus("ci", "billing-check", record.version);
    t.ops.syncCards();
    expect(t.boardIds()).toEqual([]);
    t.advance(3600_000);
    t.record({ kind: "ci", key: "billing-check", note: "Billing check red" });
    t.ops.syncCards();
    expect(t.boardIds()).toHaveLength(1);
    expect(t.boardIds()[0]).not.toBe(first);
    t.close();
  });

  it("a parked money record still has its card, and parking one does not withdraw it; a parked ordinary one has none", () => {
    const t = setup();
    t.record({ kind: "ci", key: "billing", note: "Billing mismatch" });
    t.record({ kind: "ci", key: "lint", state: "parked", note: "Lint is red", since: iso(START - 48 * 3600_000) });
    t.ops.syncCards();
    expect(t.boardIds()).toHaveLength(1);
    const record = t.store.getOpsStatus("ci", "billing")!;
    t.store.replaceOpsStatus({ ...record, state: "parked", version: t.store.nextOpsStatusVersion() }, record.version);
    t.ops.syncCards();
    expect(t.boardIds()).toHaveLength(1);
    t.close();
  });

  it("cards an app still down 15 minutes after Rivet's record began, once, told by one app-down push", async () => {
    const t = setup();
    t.record({ kind: "app", key: APP, state: "in-progress", by: "Rivet", note: "Machine restarted" });
    t.ops.store.put("health", { "tasks-app": t.health("down") }, new Date(START));
    t.advance(10 * 60_000);
    t.ops.syncCards();
    expect(t.boardIds()).toEqual([]);
    // Progress updates do not restart the clock: the record's `since` does.
    const record = t.store.getOpsStatus("app", APP)!;
    t.advance(6 * 60_000);
    t.store.replaceOpsStatus({ ...record, updatedAt: iso(START + 16 * 60_000), version: t.store.nextOpsStatusVersion() }, record.version);
    t.ops.syncCards();
    t.ops.syncCards();
    expect(t.adds).toHaveLength(1);
    expect(t.adds[0]).toMatchObject({ title: "tasks-app", push: "fyi" });
    await vi.waitFor(() => expect(t.pushed).toHaveLength(1));
    expect(t.pushed[0]).toMatchObject({ category: "app-down", title: "tasks-app" });
    // It comes back up: the card goes.
    t.ops.store.put("health", { "tasks-app": t.health("up") }, new Date(START));
    t.ops.syncCards();
    expect(t.boardIds()).toEqual([]);
    t.close();
  });

  it("tries the app-down push again when no device got it, and stops once one does", async () => {
    const t = setup();
    t.pushSends(0);
    t.record({ kind: "app", key: APP, state: "in-progress", by: "Rivet", note: "Machine restarted" });
    t.ops.store.put("health", { "tasks-app": t.health("down") }, new Date(START));
    t.advance(16 * 60_000);
    t.ops.syncCards();
    await vi.waitFor(() => expect(t.pushed).toHaveLength(1));
    await t.ops.deliverPushes();
    t.pushSends(1);
    t.advance(10 * 60_000);
    await t.ops.deliverPushes();
    expect(t.pushed).toHaveLength(2);
    t.advance(10 * 60_000);
    await t.ops.deliverPushes();
    t.ops.syncCards();
    await t.ops.deliverPushes();
    expect(t.pushed).toHaveLength(2);
    t.close();
  });

  it("cards an owned schedule's money record, but leaves an unowned failing schedule to SchedulesStore's own card", () => {
    const t = setup();
    const id = "mac:dev.rivet-agents.billing-audit";
    const run = (n: number, hoursAgo: number) => ({ id: `${n}:1:@a`, at: iso(START - hoursAgo * 3600_000), result: "failed" as const });
    const schedules = new SchedulesStore(dir);
    schedules.put(
      {
        at: iso(START),
        sources: [{ source: "mac", ok: true, at: iso(START) }],
        items: [{ id, source: "mac", name: "Billing audit", what: "Audits billing every night.", when: "Every night", group: "daily", on: true, lastRun: null, nextRun: null, toggle: { can: true }, runs: [run(2, 2), run(1, 26)] }],
      },
      new Date(START),
    );
    schedules.close();
    t.record({ kind: "schedule", key: opsStatusKey("schedule", id), state: "backlog", note: "Investigating failed run" });
    t.ops.syncCards();
    expect(t.adds).toEqual([]);
    const record = t.store.getOpsStatus("schedule", opsStatusKey("schedule", id))!;
    t.store.replaceOpsStatus({ ...record, state: "in-progress", version: t.store.nextOpsStatusVersion() }, record.version);
    t.ops.syncCards();
    expect(t.adds).toMatchObject([{ kind: "decision", title: "Investigating failed run" }]);
    t.close();
  });

  it("raises no second card for a schedule streak Sam already answered, when Rivet takes it on", () => {
    const t = setup();
    const id = "mac:dev.rivet-agents.billing-audit";
    const run = (n: number, hoursAgo: number) => ({ id: `${n}:1:@a`, at: iso(START - hoursAgo * 3600_000), result: "failed" as const });
    const schedules = new SchedulesStore(dir);
    schedules.put(
      {
        at: iso(START),
        sources: [{ source: "mac", ok: true, at: iso(START) }],
        items: [{ id, source: "mac", name: "Billing audit", what: "Audits billing every night.", when: "Every night", group: "daily", on: true, lastRun: null, nextRun: null, toggle: { can: true }, runs: [run(2, 2), run(1, 26)] }],
      },
      new Date(START),
    );
    schedules.answer(schedules.failing(new Date(START))[0]!, new Date(START));
    schedules.close();
    t.record({ kind: "schedule", key: opsStatusKey("schedule", id), state: "in-progress", note: "Investigating failed run" });
    t.ops.syncCards();
    expect(t.adds).toEqual([]);
    t.close();
  });

  it("cards an owned money schedule from its first failed run, when it has a fresh record", () => {
    const t = setup();
    fileBilling([START - 3600_000], START);
    t.record({ kind: "schedule", key: opsStatusKey("schedule", BILLING), state: "in-progress", note: "Investigating failed run" });
    t.ops.syncCards();
    expect(t.adds).toMatchObject([{ kind: "decision", title: "Investigating failed run", ask: "It touches money, so it reaches you at once." }]);
    t.close();
  });

  it("an answer covers the failure it answered, whenever a record of it begins; a new failure after it gets its own card", () => {
    const record = { kind: "schedule" as const, key: opsStatusKey("schedule", BILLING), state: "in-progress" as const, note: "Investigating failed run" };
    // The same unbroken failure, a record begun after the answer (Ask Rivet to fix): no second card.
    const same = setup();
    fileBilling([START - 26 * 3600_000, START - 2 * 3600_000], START, START);
    same.advance(3600_000);
    same.record(record);
    same.ops.syncCards();
    expect(same.adds).toEqual([]);
    same.close();
    // A later incident the bridge's truncated runs cannot tell from the same streak: its record begins after the answer.
    const fresh = setup();
    fileBilling([START - 26 * 3600_000, START - 2 * 3600_000], START, START);
    fresh.advance(10 * 3600_000);
    fileBilling([START + 5 * 3600_000, START + 6 * 3600_000, START + 7 * 3600_000], START + 10 * 3600_000);
    fresh.record({ ...record, note: "Billing mismatch" });
    fresh.ops.syncCards();
    expect(fresh.adds).toMatchObject([{ title: "Billing mismatch" }]);
    fresh.close();
  });

  it("cards a red job as money by its words, not only its title", () => {
    const t = setup();
    const jobs = new JobsStore(dir);
    const spec: JobSpec = { name: "Nightly checks", words: "Run billing tests", kind: "check", check: { script: "test", where: "mac", onRed: "card" }, when: { every: "day", at: "07:00" }, cards: "red" };
    expect(jobs.create("j-payjob01", spec, new Date(START - 3600_000)).ok).toBe(true);
    expect(jobs.start("j-payjob01", { run: "run-00000001", state: "start" }, new Date(START - 3600_000))?.go).toBe(true);
    expect(jobs.finish("j-payjob01", { run: "run-00000001", state: "red", line: "Failed: 2 errors" }, new Date(START - 3000_000)).status).toBe(200);
    jobs.close();
    t.record({ kind: "schedule", key: opsStatusKey("schedule", jobScheduleKey("j-payjob01")), state: "in-progress", note: "Investigating red run" });
    t.ops.syncCards();
    expect(t.adds).toMatchObject([{ title: "Investigating red run", ask: "It touches money, so it reaches you at once." }]);
    t.close();
  });

  it("does not send an app-down push after its card is withdrawn, and drops it from the outbox", async () => {
    const t = setup();
    t.pushSends(0);
    t.record({ kind: "app", key: APP, state: "in-progress", by: "Rivet", note: "Machine restarted" });
    t.ops.store.put("health", { "tasks-app": t.health("down") }, new Date(START));
    t.advance(16 * 60_000);
    t.ops.syncCards();
    await vi.waitFor(() => expect(t.pushed).toHaveLength(1));
    await t.ops.deliverPushes();
    expect(t.ops.store.pendingPushes()).toBe(1);
    t.ops.store.put("health", { "tasks-app": t.health("up") }, new Date(START));
    t.ops.syncCards();
    expect(t.boardIds()).toEqual([]);
    t.pushSends(1);
    t.advance(2 * 60_000);
    await t.ops.deliverPushes();
    expect(t.pushed).toHaveLength(1);
    expect(t.ops.store.pendingPushes()).toBe(0);
    t.close();
  });

  it("raises an app-down push again after the outbox gave up on it, once, and then leaves it told", async () => {
    const t = setup();
    t.pushSends(0);
    t.record({ kind: "app", key: APP, state: "in-progress", by: "Rivet", note: "Machine restarted" });
    t.ops.store.put("health", { "tasks-app": t.health("down") }, new Date(START));
    t.advance(16 * 60_000);
    t.ops.syncCards();
    await vi.waitFor(() => expect(t.pushed).toHaveLength(1));
    for (let i = 0; i < 12; i += 1) {
      await t.ops.deliverPushes();
      t.advance(61_000);
    }
    await t.ops.deliverPushes();
    expect(t.ops.store.pendingPushes()).toBe(0);
    const tried = t.pushed.length;
    t.pushSends(1);
    t.advance(15 * 60_000);
    t.ops.syncCards();
    await vi.waitFor(() => expect(t.pushed).toHaveLength(tried + 1));
    expect(t.pushed[tried]).toMatchObject({ category: "app-down", title: "tasks-app" });
    t.advance(20 * 60_000);
    t.ops.syncCards();
    await t.ops.deliverPushes();
    expect(t.pushed).toHaveLength(tried + 1);
    t.close();
  });

  it("a card's held quiet-hours push leaves the digest once its card is off the board, and stays while it is on", () => {
    const t = setup();
    t.record({ kind: "ci", key: "billing-check", note: "Billing check red" });
    t.ops.syncCards();
    const [id] = t.boardIds();
    const key = opsCardPushKey(id!);
    const release = (keys: string[]) => t.releases.flatMap((check) => check(keys));
    expect(release([key, "unrelated"])).toEqual([]);
    const record = t.store.getOpsStatus("ci", "billing-check")!;
    t.store.replaceOpsStatus({ ...record, state: "fixed", version: t.store.nextOpsStatusVersion() }, record.version);
    t.ops.syncCards();
    expect(release([key, "unrelated"])).toEqual([key]);
    t.close();
  });

  it("folds fixed records over a day old once a local day, keeping any with an open card", () => {
    const t = setup();
    const day = 24 * 3600_000;
    const old = iso(START - 2 * day);
    t.record({ kind: "ci", key: "old-fixed", state: "fixed", updatedAt: old, since: old });
    t.record({ kind: "ci", key: "kept-fixed", state: "fixed", updatedAt: old, since: old });
    t.record({ kind: "ci", key: "recent-fixed", state: "fixed" });
    t.record({ kind: "ci", key: "open", state: "investigating", updatedAt: old, since: old });
    t.store.putBoard(
      { updatedAt: old, needs: [{ id: cardId({ kind: "ci", key: "kept-fixed", incident: old }), kind: "decision", title: "kept", options: [{ label: "A" }, { label: "B" }] } as unknown as Need], coming: [], chats: [], shipped: [], waitingWM: [] },
      null,
    );
    expect(t.ops.foldDone()).toBe(1);
    expect(t.store.listOpsStatuses().map((one) => one.key).sort()).toEqual(["kept-fixed", "open", "recent-fixed"]);
    // Once run today, it waits for tomorrow.
    t.advance(1000);
    expect(t.ops.foldDone()).toBe(0);
    t.close();
  });
});

describe("a hold card reaches Sam only for a hold he placed himself", () => {
  it("cards no hold read from a PR's text, labels or the holds file, and cards his own once rivet hold records it", async () => {
    const t = setup();
    const prs = [
      pull({ number: 12, hold: "- Hold: the monitor holds the merge until the owner opens the ruleset window", holds: ["Hold: until the fix lands", "- Owner holds: none (Sam approved the plan, then asked for one more look)"] }),
      pull({ number: 13, labels: ["do-not-merge"], hold: "holds.json: Sam hold: stays draft until he plays it" }),
      pull({ number: 14, hold: "**Merge waits for the review.**" }),
    ];
    await t.ops.putGithub({ at: iso(START), prs, runs: [] } as never);
    t.ops.syncCards();
    expect(t.adds).toEqual([]);
    const holds = (list: OwnerHold[]) => {
      const ops = new OpsStore(dir);
      ops.put("ownerHolds", list, new Date(START));
      ops.close();
    };
    holds([mine(13)]);
    t.ops.syncCards();
    expect(t.adds).toMatchObject([{ pr: 13, title: "#13 Notes reels", ask: "You placed a hold on it, so it needs you.", options: [{ label: "Release the hold", recommended: true }, { label: "Keep it held" }] }]);
    expect(t.boardIds()).toEqual([t.adds[0]!.id]);
    // rivet unhold takes his record away: the card goes, whatever the PR's text still says.
    holds([]);
    t.ops.syncCards();
    expect(t.boardIds()).toEqual([]);
    expect(t.adds).toHaveLength(1);
    t.close();
  });
});

describe("Ops cards beside the late sweeper", () => {
  const board = (ids: string[]) => ({ updatedAt: iso(START), needs: ids.map((id) => ({ id, kind: "decision", title: "t", options: [{ label: "A" }, { label: "B" }] }) as unknown as Need), coming: [], chats: [], shipped: [], waitingWM: [] });

  it("gives one failure one card: no Ops card over an open late card, no late card over an open Ops card", () => {
    const late = setup();
    late.record({ kind: "ci", key: "billing", note: "Billing is red" });
    late.store.putBoard(board([lateCardId({ kind: "ci", key: "billing", since: iso(START) })]), null);
    late.ops.syncCards();
    expect(late.adds).toEqual([]);
    late.close();
    const ops = setup();
    ops.record({ kind: "ci", key: "billing", note: "Billing is red" });
    ops.ops.syncCards();
    expect(ops.adds.map((need) => need.id)).toEqual([cardId({ kind: "ci", key: "billing", incident: iso(START) })]);
    ops.ops.store.put("late", { [`ci/billing/${iso(START)}`]: { dueAts: [iso(START - 3000), iso(START - 2000), iso(START - 1000)], asks: [] } }, new Date(START));
    ops.ops.sweepLate();
    expect(ops.adds.map((need) => need.id)).toEqual([cardId({ kind: "ci", key: "billing", incident: iso(START) })]);
    // The Ops card posted first stays when a late card opens beside it.
    ops.store.putBoard(board([...ops.boardIds(), lateCardId({ kind: "ci", key: "billing", since: iso(START) })]), ops.store.getBoard()!.version);
    ops.ops.syncCards();
    expect(ops.boardIds()).toContain(cardId({ kind: "ci", key: "billing", incident: iso(START) }));
    ops.close();
  });

  it("leaves a posted Ops card exactly as it is while the late card is open, so an answered one is not reopened", () => {
    const t = setup();
    t.record({ kind: "ci", key: "billing", note: "Billing is red" });
    t.ops.syncCards();
    const id = cardId({ kind: "ci", key: "billing", incident: iso(START) });
    const book = t.ops.store.get("opsCards");
    t.store.putBoard(board([...t.boardIds(), lateCardId({ kind: "ci", key: "billing", since: iso(START) })]), t.store.getBoard()!.version);
    const record = t.store.getOpsStatus("ci", "billing")!;
    t.store.replaceOpsStatus({ ...record, note: "Billing still red after the rerun", version: t.store.nextOpsStatusVersion() }, record.version);
    t.ops.syncCards();
    expect(t.store.getBoard()!.board.needs.find((need) => need.id === id)?.title).toBe("t");
    expect(t.ops.store.get("opsCards")).toEqual(book);
    t.close();
  });

  it("cards an app down over its open late card and takes the late card back once that card is on the board", () => {
    const t = setup();
    t.record({ kind: "app", key: APP, state: "in-progress", by: "Rivet", note: "Machine restarted" });
    t.ops.store.put("health", { "tasks-app": t.health("down") }, new Date(START));
    const late = lateCardId({ kind: "app", key: APP, since: iso(START) });
    t.store.putBoard(board([late]), null);
    t.advance(16 * 60_000);
    t.ops.syncCards();
    expect(t.adds).toEqual([expect.objectContaining({ title: "tasks-app" })]);
    expect(t.boardIds()).not.toContain(late);
    t.close();
  });

  it("keeps the late card when the app-down card is only in the book, answered and gone from the board", () => {
    const t = setup();
    t.record({ kind: "app", key: APP, state: "in-progress", by: "Rivet", note: "Machine restarted" });
    t.ops.store.put("health", { "tasks-app": t.health("down") }, new Date(START));
    t.advance(16 * 60_000);
    t.ops.syncCards();
    const posted = cardId({ kind: "app", key: APP, incident: iso(START) });
    expect(t.ops.store.get("opsCards")?.cards[posted]).toBeDefined();
    const late = lateCardId({ kind: "app", key: APP, since: iso(START) });
    t.store.putBoard(board([late]), t.store.getBoard()!.version);
    t.ops.syncCards();
    expect(t.boardIds()).toEqual([late]);
    t.close();
  });

  it("raises no third-late card for an app down with no one named on its record", () => {
    const t = setup();
    t.record({ kind: "app", key: APP, state: "in-progress", note: "Machine restarted" });
    t.ops.store.put("health", { "tasks-app": t.health("down") }, new Date(START));
    t.ops.store.put("late", { [`app/${APP}/${iso(START)}`]: { dueAts: [iso(START - 3000), iso(START - 2000), iso(START - 1000)], asks: [] } }, new Date(START));
    t.ops.sweepLate();
    expect(t.adds).toEqual([]);
    t.close();
  });

  it("keeps a fixed record over a day old while its late card is unanswered", () => {
    const t = setup();
    const old = iso(START - 2 * 24 * 3600_000);
    t.record({ kind: "ci", key: "late-fixed", state: "fixed", updatedAt: old, since: old });
    t.record({ kind: "ci", key: "old-fixed", state: "fixed", updatedAt: old, since: old });
    t.store.putBoard(board([lateCardId({ kind: "ci", key: "late-fixed", since: old })]), null);
    expect(t.ops.foldDone()).toBe(1);
    expect(t.store.listOpsStatuses().map((one) => one.key)).toEqual(["late-fixed"]);
    t.close();
  });
});

const record = (extra: Partial<OpsStatus>): OpsStatus => ({ kind: "ci", key: "build", state: "investigating", since: iso(START), updatedAt: iso(START), version: 1, ...extra });
const pull = (extra: Partial<PullRequest>): PullRequest =>
  ({ repo: "example-org/example-repo", number: 12, title: "Notes reels", draft: false, labels: [], updatedAt: iso(START), checks: { state: "pass", passed: 1, failed: 0, pending: 0 }, ...extra }) as unknown as PullRequest;
const github = (prs: PullRequest[]) => ({ prs, runs: [] }) as unknown as OpsResponse["github"];
const view = (prs: PullRequest[] = []) => ({ apps: [], github: github(prs) }) as Pick<OpsResponse, "apps" | "github">;
/** Sam's own hold, as rivet hold records it on the server. */
const MINE = "Sam 4:30pm (r_9): 'hold it till I play it'";
const mine = (pr: number, extra: Partial<OwnerHold> = {}): OwnerHold => ({ pr, repo: "example-org/example-repo", reason: MINE, at: iso(START), ...extra });

describe("opsCardItems", () => {
  it("dates Rivet's time on an app from its record's start, and leaves out a schedule SchedulesStore shows its own card for", () => {
    const apps = [{ id: "tasks-app", name: "tasks-app", health: { state: "down" }, fly: null }] as unknown as OpsResponse["apps"];
    const items = opsCardItems(
      [
        record({ kind: "app", key: APP, state: "in-progress", by: "Rivet", since: iso(START - 20 * 60_000), updatedAt: iso(START - 60_000) }),
        record({ kind: "schedule", key: "nightly", note: "billing sweep failing" }),
      ],
      { apps, github: null },
      new Map([[opsStatusKey("schedule", "nightly"), { name: "Nightly", handled: true }]]),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "app", down: true, rivetRecordSince: iso(START - 20 * 60_000), incident: iso(START - 20 * 60_000) });
  });

  it("keeps a schedule's record once SchedulesStore shows no card for it, so a money incident is never left with none", () => {
    const records = [record({ kind: "schedule", key: opsStatusKey("schedule", "nightly"), state: "in-progress", note: "billing sweep failing" })];
    const facts = (handled: boolean, name = "Nightly") => new Map([[opsStatusKey("schedule", "nightly"), { name, handled }]]);
    expect(opsCardItems(records, view(), facts(false))).toMatchObject([{ kind: "schedule", title: "billing sweep failing" }]);
    expect(opsCardItems(records, view(), facts(true))).toEqual([]);
  });

  it("carries a record's fix chat repo onto its card, so the card opens that repo's conversation", () => {
    const records = [record({ kind: "app", key: APP, state: "in-progress", chat: "fix-app-tasks-app", repo: "example-org/other-repo", note: "restarting" })];
    expect(opsCardItems(records, view())).toMatchObject([{ chat: "fix-app-tasks-app", repo: "example-org/other-repo" }]);
    expect(opsCardItems([{ ...records[0]!, repo: "example-org/example-repo" }], view())[0]).not.toHaveProperty("repo");
  });

  it("reads a record's dueAt: a record two hours past its own done-by is late, well before 24 hours", () => {
    const [item] = opsCardItems([record({ kind: "pr", key: "7", state: "in-progress", note: "Rebasing", dueAt: iso(START + 3600_000) })], view());
    expect(item).toMatchObject({ dueAt: iso(START + 3600_000) });
    expect(cardReason(item!, new Date(START + 179 * 60_000))).toBeNull();
    expect(cardReason(item!, new Date(START + 181 * 60_000))).toBe("late");
  });

  it("reads no dueAt from a record no one is working: a stale done-by time on a backlog record holds nothing back", () => {
    const [item] = opsCardItems([record({ kind: "pr", key: "7", state: "backlog", since: iso(START - 25 * 3600_000), dueAt: iso(START + 3600_000) })], view());
    expect(item).toMatchObject({ dueAt: null });
    expect(cardReason(item!, new Date(START))).toBe("late");
  });

  it("counts a schedule's name toward the money test, not only the record's own words", () => {
    const records = [record({ kind: "schedule", key: opsStatusKey("schedule", "audit"), state: "in-progress", note: "Investigating failed run" })];
    const facts = (name: string) => new Map([[opsStatusKey("schedule", "audit"), { name, handled: false }]]);
    const [money] = opsCardItems(records, view(), facts("Billing audit"));
    expect(cardReason(money!, new Date(START))).toBe("money");
    const [plain] = opsCardItems(records, view(), facts("Daily issue sweep"));
    expect(cardReason(plain!, new Date(START))).toBeNull();
  });

  it("cards no hold read from PR text: a Hold: line, an 'Owner holds: none (x)' line, a quoted example, a label, the holds file", () => {
    const prs = [
      pull({ number: 1, hold: "Hold: until the fix lands" }),
      pull({ number: 2, hold: "- Owner holds: none (Sam approved the plan, then asked for one more look)" }),
      pull({ number: 3, hold: "> Owner hold: do not merge until the owner's OK is relayed." }),
      pull({ number: 4, hold: "Owner hold: Sam wants to try it first", holds: ["Hold: STACK until the fix lands", "Owner hold: do not merge until I finish playtesting"] }),
      pull({ number: 5, draft: true, labels: ["do-not-merge"] }),
      pull({ number: 6, hold: "holds.json: Sam hold: stays draft until he plays it" }),
      pull({ number: 8, hold: "**Merge waits for the review.**" }),
      // A holds-file line never cards, even one whose reason opens with the owner.
      pull({ number: 9, hold: "holds file: owner: wait until 9:00 Tue 27 Oct", holds: ["holds file: owner: wait until 9:00 Tue 27 Oct"] }),
    ];
    const cleared = new Set<string>();
    expect(opsCardItems([], view(prs), new Map(), [], cleared)).toEqual([]);
    expect([...cleared].sort()).toEqual(prs.map((pr) => opsStatusKey("pr", String(pr.number), pr.repo)).sort());
  });

  it("cards each hold Sam placed, as rivet hold recorded it, on that PR of that repo only", () => {
    const items = opsCardItems([], view([pull({ number: 12, hold: "Hold: until the fix lands" }), pull({ number: 13 })]), new Map(), [mine(12), mine(13, { repo: "example-org/other-repo" }), mine(99)]);
    expect(items).toEqual([expect.objectContaining({ pr: 12, title: "#12 Notes reels", hold: true, text: MINE, startedAt: iso(START), holdLine: `${iso(START)}\n${MINE}` })]);
  });

  it("reads a hold as the owner's only when it names them other than to deny it, past Markdown", () => {
    for (const his of [
      "Owner hold: no merge until tests pass",
      "Owner hold: none of the required approvals have arrived.",
      "Do not merge without the owner's OK",
      "No owner OK yet, so no merge",
      "No owner hold may be released until the owner approves the video.",
      "**Owner hold:** waiting on the video",
      "owner_hold",
      "Hold: nothing from the owner but a request to wait for their playtest.",
      // The monitor relaying the owner's ask is still the owner's.
      "Monitor hold: the owner asked to wait for their playtest.",
      "- Hold: the monitor holds the merge for the owner.",
      "Monitor holds: on the owner's word, until the legal note lands",
      "Monitor hold: the owner told us to wait for their playtest.",
      "Monitor hold: the owner has asked us not to merge until they playtest it",
      "Monitor hold: requested by the owner; wait for their playtest",
      "Monitor hold: the owner has just asked us not to merge until they playtest it",
      "Monitor hold: until the playtest finishes, as requested by the owner",
      "Monitor hold: until the fix lands, as requested by the owner.",
      "Monitor hold: until the fix lands — as requested by the owner.",
      "Monitor hold: until the fix lands (as requested by the owner).",
      "Monitor hold: until the fix lands as requested by the owner",
      "Monitor hold: until the fix lands per the owner.",
      "Monitor hold: until the fix lands for the owner",
      "Monitor hold: until the fix lands following the owner's request to wait.",
      "Monitor hold: until the fix lands per the owner and the owner has seen it.",
      "- Owner holds: none (until the owner approves)",
      "- Owner holds: none (the owner hasn't seen it)",
      "- Owner holds: none (on condition the owner approves)",
      "- Owner holds: none (conditional on the owner approving)",
      "- Holds: none (Owner hold: the owner must playtest the build)",
      "Owner holds: none (the owner says: stop this PR)",
      "Owner holds: none (the owner: this PR remains blocked)",
      "Owner holds: none (the owner approved pausing this PR)",
      // A reason that opens with an app's name holds no one.
      "Hold: Rivet keeps failing on the owner's phone; do not merge.",
    ])
      expect(isOwnerHold(his), his).toBe(true);
    for (const agents of [
      "- Holds: in holds.json until the fix lands (the monitor lifts it); none from the owner.",
      // The same line quoted in another PR's body.
      "> - Holds: in holds.json until the fix lands (the monitor lifts it); none from the owner.",
      "> - Holds: in holds.json \u2026 none from the owner",
      "`- Holds: in holds.json until the fix lands; none from the owner.`",
      "- Holds: in holds.json until the fix lands; none from **the owner**.",
      "Hold: STACK until the fix lands; no **owner hold**.",
      "ORDER: lands after the fix. Owner holds: none",
      // The checkpoint line every PR writes, with an aside.
      "- Owner holds: none (the owner approved the plan)",
      "- **Owner holds:** none (the owner OKed it).",
      "- Owner holds: none (the owner has signed off on the video)",
      "Merge hold from the monitor until the fix lands, not by the owner",
      "Hold: monitor order until the fix lands; not by the owner but by the monitor.",
      // The monitor's own hold whose condition names the owner.
      "- Hold: the monitor holds the merge until the owner opens the ruleset window (§ 5); `Required checks` is red by design until then",
      "Monitor hold: until the owner opens the ruleset window",
      "The monitor holds this until the fix lands and the owner has seen it",
      "**Merge hold:** the agent holds it until the owner's PR lands",
      // Prose using the word, read or not as a hold elsewhere, is never the owner's.
      "the machinery, release order and floor rules still hold",
      "Hold: the monitor keeps this PR on hold until the owner opens the ruleset window.",
      "Monitor hold: until the owner's call with legal finishes.",
    ])
      expect(isOwnerHold(agents), agents).toBe(false);
  });

  it("gives a card the PR, the repo (when not the default) and the chat the item has", () => {
    const [held] = opsCardItems([], view([pull({ number: 7, repo: "example-org/other-repo" })]), new Map(), [mine(7, { repo: "example-org/other-repo" })]);
    expect(held).toMatchObject({ pr: 7, repo: "example-org/other-repo" });
    const [keyed] = opsCardItems([record({ kind: "pr", key: "other-repo/88", chat: "fix-pr-88" })], view());
    expect(keyed).toMatchObject({ pr: 88, repo: "example-org/other-repo", chat: "fix-pr-88" });
    const [plain] = opsCardItems([record({ kind: "pr", key: "12" })], view([pull({ number: 12 })]));
    expect(plain).toMatchObject({ pr: 12 });
    expect(plain).not.toHaveProperty("repo");
  });
});

describe("syncOpsCards", () => {
  function pass(needs: Record<string, unknown>[] = []) {
    const board = { updatedAt: "x", needs, coming: [], chats: [], shipped: [], waitingWM: [] };
    const state = { stored: { board, version: 3 } as { board: typeof board; version: number } | null, added: [] as unknown[], raised: [] as unknown[], open: true };
    return {
      state,
      pass: {
        store: { getBoard: () => state.stored, putBoard: (next: typeof board) => ((state.stored = { board: next, version: 4 }), { version: 4, updatedAt: "y" }) } as never,
        addUpdate: (card: unknown) => (state.added.push(card), { status: 200 }),
        raise: async (alerts: unknown[]) => void state.raised.push(...alerts),
        isOpen: () => state.open,
        now: new Date(START),
        logger: { error: () => {} },
      },
    };
  }
  const billingItem = { kind: "ci", key: "build", title: "Build billing check", startedAt: iso(START - 1000), incident: "i1" };

  it("rewrites a card whose words changed in place, options and all, even when its reason stays", () => {
    const id = cardId(billingItem);
    const { state, pass: p } = pass([{ id, kind: "decision", title: "old", ask: "old", options: [{ label: "Old" }] }]);
    const after = syncOpsCards(p, [billingItem], { cards: { [id]: { base: id, print: "stale", reason: "money" } }, gens: {} });
    expect(Object.keys(after.cards)).toEqual([id]);
    expect(state.added).toEqual([]);
    expect(state.stored!.board.needs).toHaveLength(1);
    expect(state.stored!.board.needs[0]).toMatchObject({ title: "Build billing check", ask: "It touches money, so it reaches you at once.", options: [{ label: "Ask Rivet to fix", recommended: true }, { label: "Leave it" }] });
    // Unchanged on the next pass: left alone.
    const again = syncOpsCards(p, [billingItem], after);
    expect(again).toEqual(after);
    expect(state.stored!.version).toBe(4);
  });

  it("posts a card with its PR, repo and chat, and raises the app-down push only for an app down", () => {
    const { state, pass: p } = pass();
    syncOpsCards(p, [{ ...billingItem, pr: 9, repo: "example-org/other-repo", chat: "fix-pr-9" }], noCards());
    expect(state.added[0]).toMatchObject({ pr: 9, repo: "example-org/other-repo", chat: "fix-pr-9" });
    expect(state.raised).toEqual([]);
    syncOpsCards(p, [{ kind: "app", key: APP, title: "tasks-app", startedAt: iso(START - 3600_000), incident: "i2", down: true, rivetRecordSince: iso(START - 3600_000) }], noCards());
    expect(state.raised).toMatchObject([{ category: "app-down" }]);
  });

  const downItem = { kind: "app", key: APP, title: "tasks-app", text: "Billing note from the restart", startedAt: iso(START), incident: "i2", down: true, rivetRecordSince: iso(START) };
  const later = (p: ReturnType<typeof pass>["pass"], minutes: number) => ({ ...p, now: new Date(START + minutes * 60_000) });

  it("raises the app-down push when a posted card turns app-down, once", () => {
    const { state, pass: p } = pass();
    const posted = syncOpsCards(p, [downItem], noCards());
    expect(Object.values(posted.cards)[0]).toMatchObject({ reason: "money" });
    expect(state.raised).toEqual([]);
    const turned = syncOpsCards(later(p, 16), [downItem], posted);
    expect(state.raised).toMatchObject([{ category: "app-down" }]);
    expect(Object.values(turned.cards)[0]).toMatchObject({ reason: "app-down" });
    syncOpsCards(later(p, 17), [downItem], turned);
    expect(state.raised).toHaveLength(1);
  });

  it("raises an app-down push again every 15 minutes while its card stays open, and not once it is answered", () => {
    const { state, pass: p } = pass();
    const first = syncOpsCards(later(p, 20), [{ ...downItem, text: undefined }], noCards());
    expect(state.raised).toHaveLength(1);
    const soon = syncOpsCards(later(p, 30), [{ ...downItem, text: undefined }], first);
    expect(state.raised).toHaveLength(1);
    const lapsed = syncOpsCards(later(p, 36), [{ ...downItem, text: undefined }], soon);
    expect(state.raised).toHaveLength(2);
    state.open = false;
    syncOpsCards(later(p, 60), [{ ...downItem, text: undefined }], lapsed);
    expect(state.raised).toHaveLength(2);
  });

  it("gives a card that comes back after it was withdrawn a new id, with or without a record", () => {
    const { state, pass: p } = pass();
    const hold = { kind: "pr", key: "example-org/example-repo#12", title: "#12 Fix", startedAt: iso(START), hold: true, pr: 12 };
    const posted = syncOpsCards(p, [hold], noCards());
    const [firstId] = Object.keys(posted.cards) as [string];
    const withdrawn = syncOpsCards(p, [], posted);
    expect(withdrawn.cards).toEqual({});
    expect(withdrawn.gens[(posted.cards[firstId] as CardEntry).base]).toBe(1);
    syncOpsCards(p, [hold], withdrawn);
    const ids = state.added.map((card) => (card as { id: string }).id);
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(ids[0]);
    expect(ids[0]).toBe(firstId);
  });

  const step = (p: ReturnType<typeof pass>["pass"], prs: PullRequest[], book: ReturnType<typeof noCards>, holds: OwnerHold[] = [], statuses: OpsStatus[] = []) => {
    const cleared = new Set<string>();
    return syncOpsCards(p, opsCardItems(statuses, view(prs), new Map(), holds, cleared), book, cleared);
  };
  const PR = pull({ number: 6540 });
  const HOLD = mine(6540);
  const AGAIN = mine(6540, { reason: "Sam: check the numbers first", at: iso(START + 60_000) });

  it("lets his answer to a hold card stand when the same hold is read again, and cards a hold he places again", () => {
    const { state, pass: p } = pass();
    const posted = step(p, [PR], noCards(), [HOLD]);
    expect(state.added).toHaveLength(1);
    state.open = false;
    // His Keep it held lands, the PR drops from a reading (a missed read), and it comes back: no new card.
    const gone = step(p, [], posted, [HOLD]);
    expect(gone.cards).toEqual({});
    const back = step(p, [PR], gone, [HOLD]);
    expect(back.cards).toEqual({});
    expect(step(p, [PR], back, [HOLD]).cards).toEqual({});
    expect(state.added).toHaveLength(1);
    state.open = true;
    const fresh = step(p, [PR], back, [AGAIN]);
    expect(Object.keys(fresh.cards)).toHaveLength(1);
    expect(state.added).toHaveLength(2);
    expect(fresh.released).toBeUndefined();
  });

  it("clears his answer once a reading of the PR has no hold of his: the same hold put back cards", () => {
    const { state, pass: p } = pass();
    const posted = step(p, [PR], noCards(), [HOLD]);
    state.open = false;
    const free = step(p, [PR], posted);
    expect(free.cards).toEqual({});
    expect(free.released).toBeUndefined();
    state.open = true;
    step(p, [PR], free, [HOLD]);
    expect(state.added).toHaveLength(2);
  });

  it("cards a new hold on a card he answered that is still posted, as a new card, and withdraws the old one", () => {
    const { state, pass: p } = pass();
    const posted = step(p, [PR], noCards(), [HOLD]);
    const [first] = Object.keys(posted.cards) as [string];
    state.stored!.board.needs.push(state.added[0] as never);
    state.open = false;
    const moved = step(p, [PR], posted, [AGAIN]);
    const [second] = Object.keys(moved.cards) as [string];
    expect(second).not.toBe(first);
    expect(state.added).toHaveLength(2);
    expect(state.stored!.board.needs.map((need) => need.id)).not.toContain(first);
    // It stays one card while it holds.
    expect(Object.keys(step(p, [PR], moved, [AGAIN]).cards)).toEqual([second]);
    expect(state.added).toHaveLength(2);
  });

  it("keeps his answer when a status record for the PR comes with the same hold", () => {
    const { state, pass: p } = pass();
    const posted = step(p, [PR], noCards(), [HOLD]);
    state.open = false;
    const gone = step(p, [], posted, [HOLD]);
    const items = opsCardItems([record({ kind: "pr", key: opsStatusKey("pr", "6540"), note: "rebasing" })], view([PR]), new Map(), [HOLD], new Set());
    expect(items[0]).toMatchObject({ incident: iso(START), hold: true });
    expect(syncOpsCards(p, items, gone).cards).toEqual({});
    expect(state.added).toHaveLength(1);
  });

  it("cards a hold put back while a late record kept the PR's card, after a reading with none", () => {
    const { state, pass: p } = pass();
    const late = [record({ kind: "pr", key: opsStatusKey("pr", "6540"), state: "investigating", since: iso(START - 25 * 3600_000), note: "rebasing" })];
    const posted = step(p, [PR], noCards(), [HOLD], late);
    expect(Object.values(posted.cards)[0]).toMatchObject({ reason: "hold" });
    state.open = false;
    const free = step(p, [PR], posted, [], late);
    expect(Object.keys(free.cards)).toHaveLength(1);
    expect(Object.values(free.cards)[0]!.held).toBeUndefined();
    // Rewritten as a late card it is open again; the hold put back is still a new card, not the revision he answered.
    state.open = true;
    step(p, [PR], free, [HOLD], late);
    expect(state.added).toHaveLength(2);
  });

  it("keeps the newest answer under the cap, whatever the PR numbers", () => {
    const { pass: p, state } = pass();
    const posted = step(p, [PR], noCards(), [HOLD]);
    const older = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`pr:${7000 + i}`, "an older hold"]));
    state.open = false;
    const gone = step(p, [], { ...posted, released: older }, [HOLD]);
    expect(Object.keys(gone.released ?? {})).toHaveLength(300);
    expect(gone.released?.["pr:6540"]).toBe(`${iso(START)}\n${MINE}`);
    expect(gone.released?.["pr:7000"]).toBeUndefined();
  });

  it("does not ask again when a status record for the PR moves its answered card's id", () => {
    const { state, pass: p } = pass();
    const posted = step(p, [PR], noCards(), [HOLD]);
    state.open = false;
    const moved = step(p, [PR], posted, [HOLD], [record({ kind: "pr", key: opsStatusKey("pr", "6540"), note: "rebasing" })]);
    expect(moved.cards).toEqual({});
    expect(state.added).toHaveLength(1);
    expect(step(p, [PR], moved, [HOLD]).cards).toEqual({});
    expect(state.added).toHaveLength(1);
  });

  it("cards a hold again when its first card left unanswered", () => {
    const { state, pass: p } = pass();
    const posted = step(p, [PR], noCards(), [HOLD]);
    const gone = step(p, [], posted, [HOLD]);
    expect(gone.released).toBeUndefined();
    step(p, [PR], gone, [HOLD]);
    expect(state.added).toHaveLength(2);
  });

});

describe("the board push for an Ops card", () => {
  it("is skipped for an app-down card, which has its own push, and sent for any other", async () => {
    const clock = fakeClock();
    const sent: PushPayload[] = [];
    const server = await startServer({}, { now: clock.now, pushSender: { send: async (_target, body) => (sent.push(JSON.parse(body) as PushPayload), 201) } });
    try {
      server.app.push.subscribe({ endpoint: "https://fcm.googleapis.com/fcm/send/ops-cards", keys: { p256dh: "key", auth: "auth" } });
      await putBoard(server.base);
      const create = (id: string, extra: Record<string, unknown>) =>
        fetch(`${server.base}/api/board/needs/${id}?create=only`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ id, kind: "decision", title: `Card ${id}`, ask: "Why", options: [{ label: "A" }, { label: "B" }], ...extra }) });
      expect((await create("ops-card-app-tasks-app-0000001", { push: "fyi" })).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const ours = () => sent.filter((one) => (one as { card?: string }).card?.startsWith("ops-card-"));
      expect(ours()).toEqual([]);
      expect((await create("ops-card-ci-billing-0000002", {})).status).toBe(200);
      await vi.waitFor(() => expect(ours()).toHaveLength(1));
      expect(ours()[0]!.title).toBe("Card ops-card-ci-billing-0000002");
    } finally {
      await server.close();
    }
  });
});
