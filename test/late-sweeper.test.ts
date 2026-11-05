import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error the CLI is plain ESM without type declarations
import { run } from "../scripts/rivet.mjs";
import { opsStatusKey } from "../src/shared/ops-status-key.js";
import { OPS_STATUS_KINDS, type OpsStatus, type OpsStatusResponse } from "../src/shared/ops-status.js";
import type { GithubSnapshot, PullRequest } from "../src/shared/ops.js";
import { lateCardId } from "../src/server/ops/late.js";
import { isRetiredCard } from "../src/server/asks/waits.js";
import { createOps } from "../src/server/ops/service.js";
import { writeOpsStatus } from "../src/server/routes/ops-status.js";
import { Store } from "../src/server/store.js";
import { bearer, BOARD_TOKEN, fakeClock, startServer, type TestServer } from "./helpers.js";

const REPO = "example-org/example-repo";
const START = Date.parse("2026-10-24T08:00:00.000Z");
const SINCE = "2026-10-24T05:00:00.000Z";
const at = (minutes: number) => new Date(START + minutes * 60_000).toISOString();

const record = (extra: Partial<OpsStatus> = {}): OpsStatus => ({ kind: "ci", key: "ci", state: "in-progress", since: SINCE, updatedAt: SINCE, version: 1, chat: "ci-fix", dueAt: at(-10), why: "waiting on a rerun", ...extra });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "rivet-late-"));
  const store = new Store(dir);
  const clock = { now: START };
  const asks: { kind: string; key: string; chat?: string; dueAt: string }[] = [];
  const ids: string[] = [];
  const cards: { id: string; kind: string; title: string; ask: string; repo?: string }[] = [];
  let connected = true;
  const ops = createOps({
    dataDir: dir,
    store,
    bridge: {
      status: () => ({ connected }) as never,
      sendLateAsk: (id, ask) => {
        if (!connected) return false;
        ids.push(id);
        asks.push(ask);
        return true;
      },
    },
    push: { notify: async () => ({}) as never, flushHeld: async () => null, onDigestSettled: () => () => {}, onDigestRelease: () => () => {}, onDigestReword: () => () => {} } as never,
    checks: [],
    fetch: (async () => new Response("")) as typeof fetch,
    now: () => new Date(clock.now),
    logger: { error: () => {} },
    addUpdate: (card) => {
      if (cards.some((one) => one.id === card.id)) return { status: 409, error: "exists" };
      cards.push(card as never);
      return { status: 200 };
    },
  });
  const add = (extra: Partial<OpsStatus> = {}) => {
    const status = record({ ...extra, version: store.nextOpsStatusVersion() });
    store.addOpsStatus(status);
    return status;
  };
  /** Another writer moves the done-by time on, as `status set --eta` will. */
  const retime = (kind: string, key: string, dueAt: string) => {
    const current = store.getOpsStatus(kind, key)!;
    store.replaceOpsStatus({ ...current, dueAt, version: store.nextOpsStatusVersion() }, current.version);
  };
  return { store, ops, clock, asks, ids, cards, add, retime, offline: () => (connected = false), online: () => (connected = true) };
}

describe("the late sweeper", () => {
  it("marks a record late once for its dueAt and asks its chat one question", () => {
    const t = setup();
    t.add();
    t.add({ key: "lint", dueAt: at(30) });
    t.ops.sweepLate();
    t.ops.sweepLate();
    t.ops.ackLateAsk(t.ids[0]!, true);
    t.clock.now += 10 * 60_000;
    t.ops.sweepLate();
    expect(t.store.getOpsStatus("ci", "ci")).toMatchObject({ state: "in-progress", askedForTimeAt: at(0), chat: "ci-fix" });
    expect(t.store.getOpsStatus("ci", "lint")?.askedForTimeAt).toBeUndefined();
    expect(t.asks).toEqual([{ kind: "ci", key: "ci", chat: "ci-fix", dueAt: at(-10) }]);
    expect(t.cards).toEqual([]);
    t.ops.close();
  });

  it("asks again until the bridge acks it delivered, and never after", () => {
    const t = setup();
    t.add();
    t.offline();
    t.ops.sweepLate();
    expect(t.asks).toEqual([]);
    expect(t.store.getOpsStatus("ci", "ci")?.askedForTimeAt).toBe(at(0));
    t.online();
    t.ops.sweepLate();
    expect(t.asks).toHaveLength(1);
    // Sent and unacked: it waits, then goes again once the ack is overdue.
    t.ops.sweepLate();
    expect(t.asks).toHaveLength(1);
    t.clock.now += 3 * 60_000;
    t.ops.sweepLate();
    expect(t.asks).toHaveLength(2);
    expect(t.ids[1]).toBe(t.ids[0]);
    expect(t.ops.ackLateAsk(t.ids[0]!, true)).toBe(true);
    expect(t.ops.ackLateAsk(t.ids[0]!, true)).toBe(true);
    expect(t.ops.ackLateAsk("never-sent", true)).toBe(false);
    t.clock.now += 10 * 60_000;
    t.ops.sweepLate();
    expect(t.asks).toHaveLength(2);
    t.ops.close();
  });

  it("asks its chat again each time a record goes late, and never raises a Keep going card", () => {
    const t = setup();
    t.add();
    t.ops.sweepLate();
    t.ops.ackLateAsk(t.ids[0]!, true);
    t.retime("ci", "ci", at(20));
    t.clock.now += 30 * 60_000;
    t.ops.sweepLate();
    t.ops.ackLateAsk(t.ids[1]!, true);
    expect(t.asks).toHaveLength(2);
    expect(t.cards).toEqual([]);
    t.retime("ci", "ci", at(60));
    t.clock.now += 40 * 60_000;
    t.ops.sweepLate();
    t.ops.ackLateAsk(t.ids[2]!, true);
    expect(t.asks).toHaveLength(3);
    expect(t.cards).toEqual([]);
    t.retime("ci", "ci", at(120));
    t.clock.now += 80 * 60_000;
    t.ops.sweepLate();
    t.ops.sweepLate();
    expect(t.asks).toHaveLength(4);
    expect(t.cards).toEqual([]);
    t.ops.close();
  });

  it("raises no card for a record already logged late three times", () => {
    const t = setup();
    t.add();
    t.ops.store.put("late", { [`ci/ci/${SINCE}`]: { dueAts: [at(-300), at(-200), at(-100)], asks: [] } }, new Date(START));
    t.ops.sweepLate();
    t.ops.sweepLate();
    expect(t.cards).toEqual([]);
    t.ops.close();
  });

  it("asks the current time of an older log that stopped asking at its third late", () => {
    const t = setup();
    t.add();
    const legacy = { dueAts: [at(-300), at(-200), at(-10)], asks: [{ dueAt: at(-300), id: "a1", sentAt: at(-299), delivered: true }, { dueAt: at(-200), id: "a2", sentAt: at(-199), delivered: true }], card: true };
    t.ops.store.put("late", { [`ci/ci/${SINCE}`]: legacy } as never, new Date(START));
    t.ops.sweepLate();
    t.ops.ackLateAsk(t.ids[0]!, true);
    t.clock.now += 10 * 60_000;
    t.ops.sweepLate();
    expect(t.asks).toEqual([{ kind: "ci", key: "ci", chat: "ci-fix", dueAt: at(-10) }]);
    expect(t.cards).toEqual([]);
    t.ops.close();
  });

  it("leaves parked, backlog and fixed records, and a PR under Sam's hold, alone", () => {
    const t = setup();
    t.add({ key: "parked-pr", kind: "pr", state: "parked" });
    t.add({ key: "waiting", state: "backlog" });
    t.add({ key: "done", state: "fixed" });
    const held = t.add({ kind: "pr", key: "6075", pr: 6075, state: "investigating" });
    const free = t.add({ kind: "pr", key: "6076", pr: 6076, state: "investigating" });
    const pr = (number: number, extra: Partial<PullRequest>): PullRequest =>
      ({ repo: REPO, number, title: "t", url: "u", draft: false, author: "a", labels: [], headAt: null, updatedAt: at(0), checks: { state: "pass", passed: 1, failed: 0, pending: 0, failing: [] }, ...extra }) as PullRequest;
    t.ops.store.put("github", { at: at(0), runs: [], prs: [pr(6075,{ hold: "Owner hold: do not merge until Sam says" }), pr(6076, {})] } as unknown as GithubSnapshot, new Date(START));
    expect(opsStatusKey("pr", "6075", REPO)).toBe(held.key);
    t.ops.sweepLate();
    for (const key of ["parked-pr", "waiting", "done", "6075"]) expect(t.store.listOpsStatuses().find((one) => one.key === key)?.askedForTimeAt, key).toBeUndefined();
    expect(t.store.getOpsStatus("pr", free.key)?.askedForTimeAt).toBe(at(0));
    expect(t.asks.map((ask) => ask.key)).toEqual(["6076"]);
    expect(t.store.getOpsStatus("pr", "parked-pr")).toMatchObject({ state: "parked", version: expect.any(Number) });
    t.ops.close();
  });
});

describe("late sweeper, records that change after going late", () => {
  const prFor = (number: number, extra: Partial<PullRequest>): PullRequest =>
    ({ repo: REPO, number, title: "t", url: "u", draft: false, author: "a", labels: [], headAt: null, updatedAt: at(0), checks: { state: "pass", passed: 1, failed: 0, pending: 0, failing: [] }, ...extra }) as PullRequest;
  const logged = { dueAts: [at(-300), at(-200), at(-100)], asks: [] };

  it("sends no question and raises no card for a record parked, backlogged or held after it went late", () => {
    const t = setup();
    t.add();
    t.ops.sweepLate();
    expect(t.asks).toHaveLength(1);
    t.clock.now += 3 * 60_000;
    writeOpsStatus(t.store, "ci", "ci", { state: "parked" }, null, at(3));
    t.ops.sweepLate();
    expect(t.asks).toHaveLength(1);
    t.add({ key: "again", state: "parked" });
    t.ops.store.put("late", { ...t.ops.store.get("late"), [`ci/again/${SINCE}`]: logged }, new Date(START));
    t.ops.sweepLate();
    expect(t.cards).toEqual([]);
    const held = t.add({ kind: "pr", key: "6075", pr: 6075, state: "investigating", dueAt: at(60) });
    t.ops.store.put("github", { at: at(0), runs: [], prs: [prFor(6075, { hold: "Owner hold: wait" })] } as unknown as GithubSnapshot, new Date(START));
    t.ops.store.put("late", { ...t.ops.store.get("late"), [`pr/${held.key}/${SINCE}`]: { dueAts: logged.dueAts, asks: [] } }, new Date(START));
    t.ops.sweepLate();
    expect(t.cards).toEqual([]);
    t.ops.close();
  });

  it("reads a draft PR and every merge-hold label as a hold", () => {
    const t = setup();
    const keys = ["1", "2", "3", "4", "5", "6"];
    for (const key of keys) t.add({ kind: "pr", key, pr: Number(key), state: "investigating" });
    t.ops.store.put(
      "github",
      {
        at: at(0),
        runs: [],
        prs: [
          prFor(1, { draft: true }),
          prFor(2, { labels: ["Do Not Merge"] }),
          prFor(3, { labels: ["dnm"] }),
          prFor(4, { labels: ["WIP"] }),
          prFor(5, { labels: ["blocked"] }),
          prFor(6, { labels: ["bug"] }),
        ],
      } as unknown as GithubSnapshot,
      new Date(START),
    );
    t.ops.sweepLate();
    expect(t.asks.map((ask) => ask.key)).toEqual(["6"]);
    t.ops.close();
  });
});

describe("close with cause", () => {
  const setFixed = (t: ReturnType<typeof setup>, change: Record<string, unknown>) => writeOpsStatus(t.store, "ci", "ci", { state: "fixed", ...change } as never, null, at(50));

  it("refuses fixed on a record that went late without both a cause and a prevent line, and says what to add", () => {
    const t = setup();
    t.add();
    t.ops.sweepLate();
    const bare = setFixed(t, {});
    expect(bare.code).toBe(400);
    expect(JSON.stringify(bare.body)).toContain("--cause");
    expect(setFixed(t, { cause: "runner ran out of disk" }).code).toBe(400);
    expect(setFixed(t, { prevent: "disk check pages at 80 percent" }).code).toBe(400);
    expect(setFixed(t, { cause: "runner ran out of disk", prevent: null }).code).toBe(400);
    expect(t.store.getOpsStatus("ci", "ci")?.state).toBe("in-progress");
    const closed = setFixed(t, { cause: "runner ran out of disk", prevent: "disk check pages at 80 percent" });
    expect(closed.code).toBe(200);
    expect(t.store.getOpsStatus("ci", "ci")).toMatchObject({ state: "fixed", cause: "runner ran out of disk", prevent: "disk check pages at 80 percent", askedForTimeAt: at(0) });
    t.ops.close();
  });

  it("takes a cause and prevent given earlier, and needs none on a record that never went late", () => {
    const t = setup();
    t.add();
    t.ops.sweepLate();
    expect(writeOpsStatus(t.store, "ci", "ci", { state: "in-progress", eta: "30", why: "waiting on a rerun", cause: "runner ran out of disk", prevent: "disk check pages at 80 percent" }, null, at(40)).code).toBe(200);
    expect(setFixed(t, {}).code).toBe(200);
    t.add({ key: "lint", dueAt: at(30) });
    expect(writeOpsStatus(t.store, "ci", "lint", { state: "fixed" }, null, at(50)).code).toBe(200);
    t.ops.close();
  });

  it("keeps cause and prevent on a late fixed record: clearing them is refused, even fixed to fixed", () => {
    const t = setup();
    t.add();
    t.ops.sweepLate();
    setFixed(t, { cause: "runner ran out of disk", prevent: "disk check pages at 80 percent" });
    expect(setFixed(t, { cause: null, prevent: null }).code).toBe(400);
    expect(setFixed(t, { prevent: null }).code).toBe(400);
    expect(setFixed(t, { note: "still fine" }).code).toBe(200);
    expect(t.store.getOpsStatus("ci", "ci")).toMatchObject({ cause: "runner ran out of disk", prevent: "disk check pages at 80 percent" });
    t.ops.close();
  });

  it("reopening a fixed record clears the late marker, the explanations and the old time, with or without a since", () => {
    for (const since of [undefined, at(95)]) {
      const t = setup();
      t.add({ why: "waiting on a rerun" });
      t.ops.sweepLate();
      setFixed(t, { cause: "runner ran out of disk", prevent: "disk check pages at 80 percent" });
      const again = writeOpsStatus(t.store, "ci", "ci", { state: "investigating", eta: "30", why: "it broke again", ...(since ? { since } : {}) }, null, at(90));
      expect(again.status).toMatchObject({ state: "investigating", since: since ?? at(90), dueAt: at(120), why: "it broke again" });
      for (const field of ["askedForTimeAt", "cause", "prevent"] as const) expect(again.status?.[field], field).toBeUndefined();
      expect(setFixed(t, {}).code).toBe(200);
      t.ops.close();
    }
  });

  it("starts clean when a fixed record breaks again", () => {
    const t = setup();
    t.add();
    t.ops.sweepLate();
    setFixed(t, { cause: "runner ran out of disk", prevent: "disk check pages at 80 percent" });
    const again = writeOpsStatus(t.store, "ci", "ci", { state: "investigating", eta: "30", why: "it broke again" }, null, at(90));
    expect(again.status).toMatchObject({ state: "investigating", since: at(90) });
    expect(again.status?.askedForTimeAt).toBeUndefined();
    expect(again.status?.cause).toBeUndefined();
    expect(setFixed(t, {}).code).toBe(200);
    t.ops.close();
  });
});

describe("late sweeper reads the auto pick-up's holds", () => {
  const prFor = (number: number, extra: Partial<PullRequest>): PullRequest =>
    ({ repo: REPO, number, title: "t", url: "u", draft: false, author: "a", labels: [], headAt: null, updatedAt: at(0), checks: { state: "pass", passed: 1, failed: 0, pending: 0, failing: [] }, ...extra }) as PullRequest;
  const thrice = { dueAts: [at(-300), at(-200), at(-100)], asks: [] };

  it("never asks about or cards a PR held in a comment, a review or by a label", () => {
    const t = setup();
    for (const key of ["1", "4", "5"]) t.add({ kind: "pr", key, pr: Number(key), state: "investigating" });
    for (const key of ["11", "12"]) {
      t.add({ kind: "pr", key, pr: Number(key), state: "investigating", note: `PR ${key}` });
      t.ops.store.put("late", { ...t.ops.store.get("late"), [`pr/${key}/${SINCE}`]: thrice }, new Date(START));
    }
    t.ops.store.put(
      "github",
      {
        at: at(0),
        runs: [],
        prs: [
          prFor(1, { hold: "Comment by sam: Owner hold: wait for the review" }),
          prFor(4, { labels: ["on-hold"] }),
          prFor(5, {}),
          prFor(11, { hold: "Review summary: do not merge until Sam says" }),
          prFor(12, {}),
        ],
      } as unknown as GithubSnapshot,
      new Date(START),
    );
    t.ops.sweepLate();
    // 12 went late three times before, unheld: its chat is asked, as 5's is, and no card is raised.
    expect(t.asks.map((ask) => ask.key)).toEqual(["12", "5"]);
    for (const key of ["1", "4", "11"]) expect(t.store.getOpsStatus("pr", key)?.askedForTimeAt, key).toBeUndefined();
    expect(t.cards).toEqual([]);
    t.ops.close();
  });

  it("holds every PR record while GitHub's reading is stale or missing, or its repo's PR read failed", () => {
    for (const snapshot of [undefined, { at: at(-60), runs: [], prs: [] }, { at: at(0), runs: [], prs: [], sources: { prs: { at: at(0), failed: ["example-repo"] }, runs: { at: at(0), failed: [] }, runners: { at: at(0), failed: [] } } }]) {
      const t = setup();
      t.add({ kind: "pr", key: "6075", pr: 6075, state: "investigating" });
      t.add({ kind: "pr", key: "6076", pr: 6076, state: "investigating", note: "PR 6076" });
      t.ops.store.put("late", { [`pr/6076/${SINCE}`]: thrice }, new Date(START));
      t.add({ key: "lint" });
      if (snapshot) t.ops.store.put("github", snapshot as unknown as GithubSnapshot, new Date(START));
      t.ops.sweepLate();
      expect(t.store.getOpsStatus("pr", "6075")?.askedForTimeAt, JSON.stringify(snapshot)).toBeUndefined();
      expect(t.asks.map((ask) => ask.key)).toEqual(["lint"]);
      expect(t.cards).toEqual([]);
      t.ops.close();
    }
  });
});

describe("late sweeper, failures and restores", () => {
  it("leaves updatedAt alone when it marks a record late, so the orphan sweep still sees two quiet hours", () => {
    const t = setup();
    const before = t.add({ updatedAt: at(-120) });
    t.ops.sweepLate();
    expect(t.store.getOpsStatus("ci", "ci")).toMatchObject({ askedForTimeAt: at(0), updatedAt: before.updatedAt });
    t.ops.close();
  });

  it("reads a record stored with the old lateSince back as askedForTimeAt, and a fixed one still needs its cause", () => {
    const t = setup();
    t.store.addOpsStatus({ ...record({ version: t.store.nextOpsStatusVersion() }), lateSince: at(-5) } as OpsStatus);
    const back = t.store.getOpsStatus("ci", "ci")!;
    expect(back).toMatchObject({ askedForTimeAt: at(-5) });
    expect(back).not.toHaveProperty("lateSince");
    expect(t.store.listOpsStatuses()[0]).toMatchObject({ askedForTimeAt: at(-5) });
    expect(writeOpsStatus(t.store, "ci", "ci", { state: "fixed" }, null, at(0)).code).toBe(400);
    t.ops.close();
  });

  it("names each failure's third-late card by its own since, so an old card never stands for a new failure", () => {
    expect(lateCardId(record({ since: SINCE }))).not.toBe(lateCardId(record({ since: at(0) })));
    expect(lateCardId(record({ since: SINCE }))).toBe(lateCardId(record({ since: SINCE, note: "other" })));
    // Reopen refuses every one (asks/waits.ts isRetiredCard), whatever its kind or key.
    for (const kind of OPS_STATUS_KINDS) expect(isRetiredCard(lateCardId(record({ kind, key: "Some Key/with spaces" }))), kind).toBe(true);
  });

  it("a rollback's restore puts back a fixed late record with no cause, and a restored done-by is at most 7 days out", () => {
    const t = setup();
    t.add();
    const back = writeOpsStatus(t.store, "ci", "ci", { state: "fixed", since: SINCE, restore: { askedForTimeAt: at(-5) } }, null, at(0));
    expect(back.code).toBe(200);
    expect(back.status).toMatchObject({ state: "fixed", askedForTimeAt: at(-5) });
    expect(back.status?.cause).toBeUndefined();
    const far = writeOpsStatus(t.store, "ci", "lint", { state: "in-progress", why: "x", restore: { dueAt: new Date(START + 8 * 24 * 3600_000).toISOString() } }, null, at(0));
    expect(far.code).toBe(400);
    const past = writeOpsStatus(t.store, "ci", "lint", { state: "in-progress", why: "x", restore: { dueAt: at(-30) } }, null, at(0));
    expect(past.status?.dueAt).toBe(at(-30));
    t.ops.close();
  });
});

describe("late work end to end: the CLI, the status route, the sweeper and what Plan reads", () => {
  let server: TestServer;
  let clock: ReturnType<typeof fakeClock>;
  let stderr = "";

  beforeEach(async () => {
    clock = fakeClock(START);
    server = await startServer({}, { now: clock.now });
    stderr = "";
  });

  afterEach(async () => {
    await server.close();
  });

  const nowhere = join(tmpdir(), "rivet-late-e2e-none");
  const cli = (argv: string[], deps: Record<string, unknown> = {}): Promise<number> =>
    run(argv, {
      env: { RIVET_BRIDGE_DEV: "1", RIVET_BOARD_TOKEN: BOARD_TOKEN, RIVET_URL: server.base, RIVET_REPOS: REPO, PATH: "" },
      now: clock.now,
      holdsFile: join(nowhere, "holds.json"),
      ...deps,
      stdout: () => undefined,
      stderr: (s: string) => void (stderr += s),
    });
  /** A chat runner that lists no chats and cannot open one. */
  const noChat = { context: () => ({}), ps: () => [], create: () => { throw new Error("disk full"); } };
  const list = async () => ((await (await fetch(`${server.base}/api/ops/status`, { headers: bearer(BOARD_TOKEN) })).json()) as OpsStatusResponse).statuses;
  const sweeper = () =>
    createOps({
      dataDir: mkdtempSync(join(tmpdir(), "rivet-late-e2e-")),
      store: server.app.store,
      bridge: { status: () => ({ connected: true }) as never, sendLateAsk: () => true },
      push: { notify: async () => ({}) as never, flushHeld: async () => null, onDigestSettled: () => () => {}, onDigestRelease: () => () => {}, onDigestReword: () => () => {} } as never,
      checks: [],
      fetch: (async () => new Response("")) as typeof fetch,
      now: clock.now,
      logger: { error: () => {} },
    });
  const goLate = async () => {
    expect(await cli(["status", "set", "ci", "ci", "--state", "investigating", "--eta", "30", "--why", "flaky test, rerun queued", "--chat", "ci-fix"]), stderr).toBe(0);
    expect((await list())[0]).toMatchObject({ state: "investigating", dueAt: at(30), why: "flaky test, rerun queued" });
    clock.advance(40 * 60_000);
    const ops = sweeper();
    ops.sweepLate();
    ops.close();
    expect((await list())[0]).toMatchObject({ askedForTimeAt: at(40), dueAt: at(30) });
  };

  it("status set --eta --why, late, re-timed as the bridge asks, then fixed with --cause --prevent", async () => {
    await goLate();
    // The bridge's question names these flags (bridge/lib/bridge.mjs lateAskLine).
    expect(await cli(["status", "set", "ci", "ci", "--state", "in-progress", "--eta", "60", "--why", "the rerun hit the same flake"]), stderr).toBe(0);
    expect((await list())[0]).toMatchObject({ state: "in-progress", dueAt: at(100), why: "the rerun hit the same flake", askedForTimeAt: at(40) });
    expect(await cli(["status", "set", "ci", "ci", "--state", "fixed", "--note", "rerun passed"])).toBe(1);
    expect(stderr).toMatch(/--cause/);
    expect(await cli(["status", "set", "ci", "ci", "--state", "fixed", "--note", "rerun passed", "--cause", "a flaky test in the queue", "--prevent", "the flaky test is quarantined"]), stderr).toBe(0);
    // What the Plan page reads for the Late row's why and its "So it stops:" line.
    expect((await list())[0]).toMatchObject({ state: "fixed", why: "the rerun hit the same flake", cause: "a flaky test in the queue", prevent: "the flaky test is quarantined", askedForTimeAt: at(40) });
  });

  it("rivet fix by the auto pick-up leaves an item parked since, and opens nothing", async () => {
    expect(await cli(["status", "set", "machine", "phone-1", "--state", "parked", "--note", "leave it"])).toBe(0);
    const before = await list();
    const runner = {
      context: () => ({}),
      ps: () => {
        throw new Error("unexpected ps");
      },
      create: () => {
        throw new Error("unexpected create");
      },
    };
    expect(await cli(["fix", "machine", "phone-1", "--by", "rivet"], { runner })).toBe(0);
    expect(await list()).toEqual(before);
    // Anyone else asking for the fix goes on, as a person may mean to re-open it.
    expect(await cli(["fix", "machine", "phone-1", "--by", "monitor"], { runner })).toBe(1);
    expect(stderr).toMatch(/unexpected ps/);
  });

  it("rivet fix puts a parked record back with its own time when its chat does not open, so it cannot re-park newer trouble", async () => {
    expect(await cli(["status", "set", "machine", "phone-1", "--state", "parked", "--note", "leave it"])).toBe(0);
    const parkedAt = (await list())[0]!.updatedAt;
    clock.advance(60_000);
    expect(await cli(["fix", "machine", "phone-1"], { runner: noChat })).toBe(1);
    expect(stderr).toMatch(/the chat runner could not open/);
    expect((await list())[0]).toMatchObject({ state: "parked", updatedAt: parkedAt });
    // A restored time is only ever an older one, and only a parked record's.
    const late = { state: "parked", restore: { updatedAt: new Date(clock.now().getTime() + 3_600_000).toISOString() } };
    const res = await fetch(`${server.base}/api/ops/status/machine/phone-1`, { method: "PUT", headers: { ...bearer(BOARD_TOKEN), "content-type": "application/json", "if-match": String((await list())[0]!.version) }, body: JSON.stringify(late) });
    expect(res.status).toBe(200);
    expect((await list())[0]!.updatedAt).toBe(clock.now().toISOString());
  });

  it("rivet fix puts the whole late record back when its chat does not open", async () => {
    await goLate();
    const { version: _version, updatedAt: _updatedAt, ...before } = (await list())[0]!;
    expect(await cli(["fix", "ci", "ci"], { runner: noChat })).toBe(1);
    expect(stderr).toMatch(/the chat runner could not open/);
    expect(stderr).not.toMatch(/still names/);
    // A put cannot clear `by`: a record that had none goes back naming the fix's writer.
    const { version: _v, updatedAt: _u, by, ...after } = (await list())[0]!;
    expect(after).toEqual(before);
    expect(by).toBe("Rivet");
  });

  it("rivet fix puts back a late record Rivet settled fixed with no cause when its chat does not open", async () => {
    await goLate();
    const store = server.app.store;
    const late = store.getOpsStatus("ci", "ci")!;
    const dueHistory = [
      { at: at(5), dueAt: at(20), was: at(10), why: "tests were red" },
      { at: at(15), dueAt: at(30), was: at(20), why: "deploy queue" },
    ];
    store.replaceOpsStatus({ ...late, state: "fixed", note: "main is green again", dueHistory, version: store.nextOpsStatusVersion() }, late.version);
    const { version: _version, updatedAt: _updatedAt, ...before } = (await list())[0]!;
    expect(before).toMatchObject({ state: "fixed", askedForTimeAt: at(40), dueHistory });
    expect(await cli(["fix", "ci", "ci"], { runner: noChat })).toBe(1);
    expect(stderr).toMatch(/the chat runner could not open/);
    expect(stderr).not.toMatch(/still names/);
    const { version: _v, updatedAt: _u, by: _by, ...after } = (await list())[0]!;
    expect(after).toEqual(before);
  });
});
