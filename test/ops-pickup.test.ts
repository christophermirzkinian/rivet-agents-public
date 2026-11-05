import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createOps } from "../src/server/ops/service.js";
import { Store } from "../src/server/store.js";
import { type OpsResponse, type PullRequest, type WorkflowRun } from "../src/shared/ops.js";
import { opsStatusKey } from "../src/shared/ops-status-key.js";
import { setKnownRepos } from "../src/shared/repos.js";
import {
  CHAT_CLOSED,
  itemId,
  keepsBreakingCard,
  machineReds,
  MAX_WORKING_CHATS,
  NO_PICKUPS,
  planPickups,
  QUEUE_FULL,
  releasePickup,
  scheduleRepo,
  type PickupState,
  type RedItem,
} from "../src/server/ops/pickup.js";
import { HANDLER_BY, isFixing, isOwned } from "../src/shared/ops-owned.js";
import type { OpsStatus } from "../src/shared/ops-status.js";
import { writeOpsStatus } from "../src/server/routes/ops-status.js";
import type { Worker } from "../src/shared/workers.js";

const MS = "example-org/example-repo";
beforeAll(() => setKnownRepos([MS, "example-org/other-repo"]));
afterAll(() => setKnownRepos([]));
const T0 = Date.parse("2026-10-24T01:00:00.000Z");
const MIN = 60_000;
const at = (ms: number) => new Date(T0 + ms);
const iso = (ms: number) => at(ms).toISOString();

const red = (key: string, extra: Partial<RedItem> = {}): RedItem => ({ kind: "ci", key, repo: MS, name: `${key} workflow`, ...extra });
const worker = (chat: string, state = "working", extra: Partial<Worker> = {}) => ({ id: chat, name: chat, repo: MS, chat, state, lastOutputAt: null, ...extra }) as Worker;
const record = (key: string, extra: Partial<OpsStatus> = {}): OpsStatus => ({
  kind: "ci",
  key,
  state: "investigating",
  since: iso(0),
  updatedAt: iso(0),
  version: 1,
  ...extra,
});

function plan(input: { red?: RedItem[]; statuses?: OpsStatus[]; workers?: Worker[]; held?: string[]; state?: PickupState; now: number }) {
  return planPickups({
    red: input.red ?? [],
    statuses: input.statuses ?? [],
    workers: input.workers ?? [worker("monitor")],
    held: new Set(input.held ?? []),
    monitorChat: "monitor",
    state: input.state ?? NO_PICKUPS,
    now: at(input.now),
  });
}

/** The state after the service sent each item `start` names. */
function sent(state: PickupState, items: RedItem[], now: number): PickupState {
  const next = { ...state, starts: [...state.starts], sent: { ...state.sent } };
  for (const [n, item] of items.entries()) {
    next.starts.push({ item: itemId(item), at: iso(now) });
    next.sent[`pickup-${now}-${n}`] = { kind: item.kind, key: item.key, at: iso(now), version: 1 };
  }
  return next;
}

describe("auto pick-up", () => {
  it("stays off a red an automatic handler is waiting on, which still counts as red", () => {
    const item = red("ci");
    const mine = record("ci", { by: HANDLER_BY, state: "in-progress" });
    const first = plan({ red: [item], statuses: [mine], now: 0 });
    expect(plan({ red: [item], statuses: [mine], state: first.state, now: 60 * MIN }).start).toEqual([]);
    expect(isFixing(item, mine, [worker("monitor")])).toBe(false);
    expect(isOwned(item, mine, [worker("monitor")])).toBe(false);
    expect(isOwned(item, { ...mine, by: "rivet" }, [worker("monitor")])).toBe(true);
  });

  it("takes the red over once the handler hands back, or its record is left past the orphan rule", () => {
    const item = red("ci");
    const back = record("ci", { by: HANDLER_BY, state: "backlog" });
    const first = plan({ red: [item], statuses: [back], now: 0 });
    expect(plan({ red: [item], statuses: [back], state: first.state, now: 10 * MIN }).start).toEqual([item]);
    const left = record("ci", { by: HANDLER_BY, state: "in-progress" });
    const waited = plan({ red: [item], statuses: [left], now: 0 });
    expect(plan({ red: [item], statuses: [left], state: waited.state, now: 121 * MIN }).start).toEqual([item]);
  });

  it("picks a red item up once nobody has been on it for ten minutes, and only once while it is in flight", () => {
    const item = red("ci");
    const first = plan({ red: [item], now: 0 });
    expect(first.start).toEqual([]);
    expect(plan({ red: [item], state: first.state, now: 9 * MIN }).start).toEqual([]);
    const due = plan({ red: [item], state: first.state, now: 10 * MIN });
    expect(due.start).toEqual([item]);
    const flying = sent(due.state, due.start, 10 * MIN);
    expect(plan({ red: [item], state: flying, now: 11 * MIN }).start).toEqual([]);
    // Picked up: its record says someone is on it.
    const owned = plan({ red: [item], statuses: [record("ci", { by: "rivet" })], state: flying, now: 30 * MIN });
    expect([owned.start, owned.queueFull]).toEqual([[], []]);
  });

  it("lets go of a pick-up the bridge never acked, still counting its start", () => {
    const item = red("ci");
    const flying = sent({ ...NO_PICKUPS, unowned: { "ci/ci": iso(0) } }, [item], 10 * MIN);
    const late = plan({ red: [item], state: flying, now: 20 * MIN });
    expect(late.expired).toEqual(["pickup-600000-0"]);
    const released = releasePickup(late.state, "pickup-600000-0");
    expect(released.sent).toMatchObject({ kind: "ci", key: "ci" });
    expect(released.state.starts).toEqual([{ item: "ci/ci", at: iso(10 * MIN) }]);
    expect(released.state.sent).toEqual({});
    const again = plan({ red: [item], state: released.state, now: 21 * MIN });
    expect(again.start).toEqual([]);
    expect(plan({ red: [item], state: again.state, now: 31 * MIN }).start).toEqual([item]);
  });

  it("stops after three pick-ups of one key in 24 hours and raises one keeps-breaking card", () => {
    const item = red("ci");
    let state: PickupState = { ...NO_PICKUPS, unowned: { "ci/ci": iso(0) } };
    for (const hour of [1, 3, 5]) {
      const tick = plan({ red: [item], state, now: hour * 60 * MIN });
      expect(tick.start, `hour ${hour}`).toEqual([item]);
      state = sent(tick.state, tick.start, hour * 60 * MIN);
      state = releasePickup(state, Object.keys(state.sent)[0]!).state;
      // Fixed, then red again with nobody on it.
      state.unowned = { "ci/ci": iso(hour * 60 * MIN) };
    }
    const capped = plan({ red: [item], state, now: 6 * 60 * MIN });
    expect([capped.start, capped.queueFull, capped.keepsBreaking]).toEqual([[], [], [{ item, episode: iso(60 * MIN) }]]);
    const carded = { ...capped.state, cards: [...capped.state.cards, "ci/ci"] };
    const again = plan({ red: [item], state: carded, now: 7 * 60 * MIN });
    expect([again.start, again.keepsBreaking]).toEqual([[], []]);
    // A day after the first pick-up it is picked up again.
    const later = plan({ red: [item], state: again.state, now: 25 * 60 * MIN });
    expect(later.start).toEqual([item]);
    expect(later.state.cards).toEqual(["ci/ci"]);
    expect(plan({ red: [item], state: later.state, now: 30 * 60 * MIN }).state.cards).toEqual([]);
  });

  it("the card for a key that keeps breaking has one id per key and run of pick-ups, and asks Sam to find the cause", () => {
    const card = keepsBreakingCard(red("ci"), iso(0));
    // True whether each pick-up broke again or never reached a chat: a start counts once sent.
    expect(card).toMatchObject({ kind: "decision", title: "ci workflow is still red", ask: "Rivet has tried to start on this 3 times in 24 hours and it is still red. Auto pick-up is off for it.", repo: MS });
    expect(card.id).toBe(keepsBreakingCard(red("ci"), iso(0)).id);
    expect(card.id).not.toBe(keepsBreakingCard(red("deploy"), iso(0)).id);
    // A later run is a new card, never the answered one.
    expect(card.id).not.toBe(keepsBreakingCard(red("ci"), iso(30 * 60 * MIN)).id);
    expect((card.options as { label: string }[]).map((option) => option.label)).toEqual(["Find the cause", "Leave it"]);
  });

  it("starts at most three in any rolling hour; the rest are Late, queue full, and tried again later", () => {
    const items = ["a", "b", "c", "d"].map((key) => red(key));
    const unowned = Object.fromEntries(items.map((item) => [itemId(item), iso(0)]));
    const tick = plan({ red: items, state: { ...NO_PICKUPS, unowned }, now: 10 * MIN });
    expect(tick.start.map((item) => item.key)).toEqual(["a", "b", "c"]);
    expect(tick.queueFull.map((item) => item.key)).toEqual(["d"]);
    let state = sent(tick.state, tick.start, 10 * MIN);
    // Marked once: a record already Late for a full queue is not written again.
    const lateD = record("d", { state: "backlog", why: QUEUE_FULL, askedForTimeAt: iso(10 * MIN) });
    const waiting = plan({ red: items, statuses: [lateD], state, now: 15 * MIN });
    expect([waiting.start, waiting.queueFull]).toEqual([[], []]);
    // An hour after the first three, the fourth goes.
    state = Object.keys(state.sent).reduce((next, id) => releasePickup(next, id).state, state);
    expect(plan({ red: [items[3]!], statuses: [lateD], state, now: 69 * MIN }).start).toEqual([]);
    const later = plan({ red: [items[3]!], statuses: [lateD], state, now: 70 * MIN });
    expect(later.start.map((item) => item.key)).toEqual(["d"]);
  });

  it("starts nothing while ten chats are working, counting neither the monitor nor Rivet's own", () => {
    const item = red("ci");
    const state = { ...NO_PICKUPS, unowned: { "ci/ci": iso(0) } };
    const ten = Array.from({ length: MAX_WORKING_CHATS }, (_, n) => worker(`chat-${n}`));
    const full = plan({ red: [item], workers: [worker("monitor"), ...ten], state, now: 10 * MIN });
    expect([full.start, full.queueFull]).toEqual([[], [item]]);
    const nine = [...ten.slice(1), worker("monitor"), worker("rivet-app", "working", { rivet: true } as Partial<Worker>), worker("idle-chat", "idle")];
    const room = plan({ red: [item, red("ci2")], workers: nine, state: { ...state, unowned: { ...state.unowned, "ci/ci2": iso(0) } }, now: 10 * MIN });
    expect(room.start).toEqual([item]);
    expect(room.queueFull).toEqual([red("ci2")]);
  });

  it("counts pick-ups sent and not acked yet as working chats, and starts nothing with no crew read", () => {
    const nine = Array.from({ length: MAX_WORKING_CHATS - 1 }, (_, n) => worker(`chat-${n}`));
    const flying = sent({ ...NO_PICKUPS, unowned: { "ci/b": iso(0) } }, [red("a")], 10 * MIN);
    const tick = plan({ red: [red("a"), red("b")], workers: [worker("monitor"), ...nine], state: flying, now: 11 * MIN });
    expect([tick.start, tick.queueFull]).toEqual([[], [red("b")]]);
    expect(plan({ red: [red("b")], workers: [], state: { ...NO_PICKUPS, unowned: { "ci/b": iso(0) } }, now: 11 * MIN }).start).toEqual([]);
  });

  it("keeps a pick-up the bridge never acked in the hour's count, and counts a refused record too", () => {
    const items = ["a", "b", "c", "d"].map((key) => red(key));
    const unowned = { "ci/d": iso(0) };
    let state = sent({ ...NO_PICKUPS, unowned }, items.slice(0, 3), 10 * MIN);
    const late = plan({ red: [items[3]!], state, now: 20 * MIN });
    expect(late.expired).toHaveLength(3);
    state = late.expired.reduce((next, id) => releasePickup(next, id).state, late.state);
    expect(plan({ red: [items[3]!], state, now: 21 * MIN }).queueFull).toEqual([items[3]]);
    const refused = { ...NO_PICKUPS, unowned, refused: ["a", "b", "c"].map((key) => ({ item: `ci/${key}`, at: iso(10 * MIN) })) };
    expect(plan({ red: [items[3]!], state: refused, now: 21 * MIN }).queueFull).toEqual([items[3]]);
    expect(plan({ red: [items[3]!], state: refused, now: 71 * MIN }).start).toEqual([items[3]]);
  });

  it("counts a typed pick-up as a working chat until its chat is in the crew, or fifteen minutes after the ack", () => {
    const crew = [worker("monitor"), ...Array.from({ length: MAX_WORKING_CHATS - 1 }, (_, n) => worker(`chat-${n}`))];
    const state = { ...NO_PICKUPS, unowned: { "ci/b": iso(0) }, acked: [{ item: "ci/a", at: iso(10 * MIN) }] };
    const typed = plan({ red: [red("b")], workers: crew, state, now: 11 * MIN });
    expect([typed.start, typed.queueFull, typed.state.acked]).toEqual([[], [red("b")], state.acked]);
    // Its chat is in the crew now and counts as itself, once.
    const opened = plan({ red: [red("b")], statuses: [record("a", { chat: "fix-a" })], workers: [...crew.slice(0, -1), worker("fix-a")], state, now: 12 * MIN });
    expect([opened.start, opened.state.acked]).toEqual([[red("b")], []]);
    const late = plan({ red: [red("b")], workers: crew.slice(0, -1), state, now: 25 * MIN });
    expect([late.start, late.state.acked]).toEqual([[red("b")], []]);
  });

  it("keeps a record naming a live chat as the owner of a machine", () => {
    const mac = red("mac", { kind: "machine" });
    const mine = record("mac", { kind: "machine", chat: "fix-mac", by: "monitor", updatedAt: iso(5 * MIN) });
    const state = { ...NO_PICKUPS, unowned: { "machine/mac": iso(0) } };
    expect(plan({ red: [mac], statuses: [mine], workers: [worker("monitor"), worker("fix-mac")], state, now: 40 * MIN }).start).toEqual([]);
  });

  it("leaves a PR under a hold alone", () => {
    const pr = red("6000", { kind: "pr", name: "#600" });
    const tick = plan({ red: [pr], held: ["pr/6000"], state: { ...NO_PICKUPS, unowned: { "pr/6000": iso(0) } }, now: 20 * MIN });
    expect([tick.start, tick.queueFull]).toEqual([[], []]);
  });

});

describe("a parked record", () => {
  const machine = (extra: Partial<RedItem> = {}): RedItem => ({ kind: "machine", key: "phone-1", repo: MS, name: "Phone 1: sick", detail: "no answer over ssh", ...extra });
  const parked = (extra: Partial<OpsStatus> = {}): OpsStatus => record("phone-1", { kind: "machine", state: "parked", since: iso(MIN), updatedAt: iso(MIN), by: "monitor", ...extra });

  it("keeps the pick-up off a parked machine however long it stays red, and it does not count as waiting", () => {
    let state = NO_PICKUPS;
    for (const now of [0, 10 * MIN, 11 * MIN, 12 * 60 * MIN]) {
      const tick = plan({ red: [machine()], statuses: [parked()], state, now });
      expect([tick.start, tick.queueFull, tick.keepsBreaking, tick.orphans]).toEqual([[], [], [], []]);
      expect(tick.state.unowned).toEqual({});
      state = tick.state;
    }
  });

  it("keeps it off every kind that goes red but a workflow, and a ready PR and a workflow red on main are still picked up", () => {
    for (const kind of ["app", "machine", "runner", "disk", "schedule"] as const) {
      const item = red("thing", { kind });
      const first = plan({ red: [item], statuses: [record("thing", { kind, state: "parked" })], now: 0 });
      expect(plan({ red: [item], statuses: [record("thing", { kind, state: "parked" })], state: first.state, now: 10 * MIN }).start, kind).toEqual([]);
    }
    const ready = red("7239", { kind: "pr", draft: false });
    const statuses = [record("7239", { kind: "pr", state: "parked" })];
    const first = plan({ red: [ready], statuses, now: 0 });
    expect(plan({ red: [ready], statuses, state: first.state, now: 10 * MIN }).start).toEqual([ready]);
    const main = red("lint");
    const parkedRun = [record("lint", { state: "parked" })];
    const seen = plan({ red: [main], statuses: parkedRun, now: 0 });
    expect(plan({ red: [main], statuses: parkedRun, state: seen.state, now: 10 * MIN }).start).toEqual([main]);
  });

});

describe("orphan sweep", () => {
  const gone = record("ci", { chat: "fix-ci", by: "monitor" });

  it("marks work whose chat has been gone two hours as orphaned and picks it up again at once", () => {
    const first = plan({ red: [red("ci")], statuses: [gone], workers: [worker("other")], now: 60 * MIN });
    expect(first.orphans).toEqual([]);
    expect(first.state.absent).toEqual({ "ci/ci": iso(60 * MIN) });
    expect(first.start).toEqual([]);
    expect(plan({ red: [red("ci")], statuses: [gone], workers: [worker("other")], state: first.state, now: 179 * MIN }).orphans).toEqual([]);
    const late = plan({ red: [red("ci")], statuses: [gone], workers: [worker("other")], state: first.state, now: 180 * MIN });
    expect(late.orphans).toEqual([gone]);
    expect(late.start).toEqual([red("ci")]);
    expect(CHAT_CLOSED).toBe("chat closed");
  });

  it("never sweeps with no crew read, a chat in the crew, a record changed lately, a hold, or work not under way", () => {
    const absent = { ...NO_PICKUPS, absent: { "ci/ci": iso(0) } };
    expect(plan({ statuses: [gone], workers: [], state: absent, now: 180 * MIN }).orphans).toEqual([]);
    expect(plan({ statuses: [gone], workers: [worker("fix-ci", "idle")], state: absent, now: 180 * MIN }).orphans).toEqual([]);
    expect(plan({ statuses: [{ ...gone, updatedAt: iso(120 * MIN) }], workers: [worker("other")], state: absent, now: 180 * MIN }).orphans).toEqual([]);
    expect(plan({ statuses: [gone], workers: [worker("other")], held: ["ci/ci"], state: absent, now: 180 * MIN }).orphans).toEqual([]);
    for (const state of ["parked", "backlog", "fixed"] as const) {
      expect(plan({ statuses: [{ ...gone, state }], workers: [worker("other")], state: absent, now: 180 * MIN }).orphans, state).toEqual([]);
    }
    expect(plan({ statuses: [{ ...gone, kind: "coming" }], workers: [worker("other")], state: { ...NO_PICKUPS, absent: { "coming/ci": iso(0) } }, now: 180 * MIN }).orphans).toEqual([]);
  });

  it("reads a record's chat as live only in the record's repo; one with no repo is live by name", () => {
    const other = "example-org/other-repo";
    const absent = { ...NO_PICKUPS, absent: { "ci/ci": iso(0) } };
    const fixing = record("ci", { chat: "fix-ci", by: "monitor" });
    const crew = [worker("monitor"), worker("fix-ci")];
    expect(plan({ statuses: [{ ...fixing, repo: other }], workers: crew, state: absent, now: 180 * MIN }).orphans).toEqual([{ ...fixing, repo: other }]);
    expect(plan({ statuses: [{ ...fixing, repo: other }], workers: [...crew, worker("fix-ci", "working", { repo: other })], state: absent, now: 180 * MIN }).orphans).toEqual([]);
    expect(plan({ statuses: [{ ...fixing, repo: MS }], workers: crew, state: absent, now: 180 * MIN }).orphans).toEqual([]);
    expect(plan({ statuses: [fixing], workers: [worker("monitor"), worker("fix-ci", "working", { repo: other })], state: absent, now: 180 * MIN }).orphans).toEqual([]);
    // A record with no repo whose key names another repo is live only in that repo.
    const keyed = { ...fixing, key: "other-repo/ci" };
    const keyedAbsent = { ...NO_PICKUPS, absent: { "ci/other-repo/ci": iso(0) } };
    expect(plan({ statuses: [keyed], workers: crew, state: keyedAbsent, now: 180 * MIN }).orphans).toEqual([keyed]);
    expect(plan({ statuses: [keyed], workers: [...crew, worker("fix-ci", "working", { repo: other })], state: keyedAbsent, now: 180 * MIN }).orphans).toEqual([]);
  });
});

describe("the reds beyond CI, PRs, apps and schedules", () => {
  const now = iso(0);
  const ops = {
    now,
    bridge: { connected: true },
    mac: {
      at: now,
      stale: false,
      volumes: [{ label: "External 1", totalBytes: 100, freeBytes: 1, runners: false }, { label: "Data", totalBytes: 100, freeBytes: 50, runners: true }],
      memory: { freePct: 2, pressure: "critical" },
      runners: [{ name: "mac-1", alive: false }],
    },
    github: { at: now, stale: false, runners: { runners: [{ name: "runner-3", status: "offline", busy: false }, { name: "mac-2", status: "offline", busy: false }, { name: "old-runner", status: "offline", busy: false }] }, sources: { runners: { failed: [], at: null } } },
    retiredRunners: ["old-runner"],
  } as unknown as OpsResponse;

  it("reads the Mac's memory, full disks and runners offline, keyed as the app's items", () => {
    const items = machineReds(ops);
    expect(items.map(itemId)).toEqual(["machine/mac", `disk/${opsStatusKey("disk", "External 1")}`, `runner/${opsStatusKey("runner", "runner-3")}`, `runner/${opsStatusKey("runner", "mac-2")}`]);
    expect(items[0]!.detail).toBe("Memory pressure critical, 2% free, Runner mac-1 down");
  });

  it("reads nothing from an old reading", () => {
    const later = { ...ops, now: iso(20 * MIN) };
    expect(machineReds(later)).toEqual([]);
  });

  it("runs a failing schedule's fix in its own repo", () => {
    const third = "example-org/third-repo";
    expect(scheduleRepo(`github:${third}/nightly.yml`, undefined)).toBe(third);
    expect(scheduleRepo("backlog-puller", undefined)).toBe(MS);
    expect(scheduleRepo(`github:${MS}/nightly.yml`, third)).toBe(third);
  });
});

describe("auto pick-up on the server", () => {
  const failed = (workflow: string): WorkflowRun =>
    ({ repo: MS, id: 1, attempt: 1, workflow, status: "completed", conclusion: "failure", event: "push", sha: "a", createdAt: iso(-60 * MIN), updatedAt: iso(-60 * MIN), title: "main", url: "https://github.com/x" }) as WorkflowRun;
  const github = (now: Date, prs: PullRequest[] = []): NonNullable<OpsResponse["github"]> =>
    ({
      at: now.toISOString(),
      stale: false,
      prs,
      prsComplete: true,
      runs: [failed("CI")],
      runners: null,
      queue: null,
      merged: null,
      closed: null,
      sources: { prs: { failed: [], at: null }, runs: { failed: [], at: null }, merged: { failed: [], at: null }, runners: { failed: [], at: null }, queue: { failed: [], at: null } },
    }) as NonNullable<OpsResponse["github"]>;

  function setup(prs: PullRequest[] = [], send?: () => string | null) {
    let clock = T0;
    const store = new Store(mkdtempSync(join(tmpdir(), "rivet-pickup-")));
    const sends: { id: string; kind: string; key: string }[] = [];
    const cards: { id: string; title: string }[] = [];
    const ops = createOps({
      dataDir: mkdtempSync(join(tmpdir(), "rivet-pickup-ops-")),
      store,
      bridge: { status: () => ({ connected: true }) as never },
      push: { notify: async () => ({}) as never, flushHeld: async () => null, onDigestSettled: () => () => {}, onDigestRelease: () => () => {}, onDigestReword: () => () => {} } as never,
      checks: [],
      fetch: (async () => new Response("")) as typeof fetch,
      now: () => new Date(clock),
      logger: { error: () => {} },
      workers: () => [worker("monitor")],
      addUpdate: (card) => {
        if (cards.some((one) => one.id === card.id)) return { status: 409 };
        cards.push(card as { id: string; title: string });
        return { status: 200 };
      },
      pickup: {
        send: (pickup) => {
          if (send) return send();
          const id = `pickup-${sends.length + 1}`;
          sends.push({ id, ...pickup });
          return id;
        },
        monitorChat: "monitor",
      },
    });
    const tick = (ms: number, read = true) => {
      clock = T0 + ms;
      if (read) ops.store.put("github", github(new Date(clock), prs), new Date(clock));
      ops.pickupTick();
    };
    return { store, ops, sends, cards, tick };
  }

  it("sends a red workflow once, sets its record investigating by rivet with a done-by", () => {
    const { store, ops, sends, tick } = setup();
    const key = opsStatusKey("ci", "CI");
    tick(0);
    tick(5 * MIN);
    expect(sends).toEqual([]);
    tick(10 * MIN);
    expect(sends).toEqual([{ id: "pickup-1", kind: "ci", key, repo: MS }]);
    expect(store.getOpsStatus("ci", key)).toMatchObject({ state: "investigating", by: "rivet", dueAt: iso(70 * MIN), why: "Rivet is looking into it" });
    expect(ops.ackPickup("pickup-1", true)).toBe(true);
    tick(11 * MIN);
    tick(60 * MIN);
    expect(sends).toHaveLength(1);
    expect(ops.ackPickup("pickup-1", true)).toBe(false);
    ops.close();
  });

  it("holds a typed pick-up as a working chat from its ack", () => {
    const { ops, tick } = setup();
    tick(0);
    tick(10 * MIN);
    ops.ackPickup("pickup-1", true);
    expect(ops.store.get("pickup")?.acked).toEqual([{ item: `ci/${opsStatusKey("ci", "CI")}`, at: iso(10 * MIN) }]);
    tick(26 * MIN);
    expect(ops.store.get("pickup")?.acked).toEqual([]);
    ops.close();
  });

  it("stores a start before the send, so a restart between them still counts it", () => {
    const { store, ops, tick } = setup([], () => {
      throw new Error("the server stopped");
    });
    const key = opsStatusKey("ci", "CI");
    tick(0);
    expect(() => tick(10 * MIN)).toThrow("the server stopped");
    expect(ops.store.get("pickup")?.starts).toEqual([{ item: `ci/${key}`, at: iso(10 * MIN) }]);
    expect(store.getOpsStatus("ci", key)).toMatchObject({ state: "investigating", by: "rivet" });
    ops.close();
  });

  it("takes the start back too when no bridge could take the pick-up", () => {
    const { ops, tick } = setup([], () => null);
    tick(0);
    tick(10 * MIN);
    expect(ops.store.get("pickup")?.starts).toEqual([]);
    ops.close();
  });

  it("takes its record back when the bridge could not type it, and picks it up again", () => {
    const { store, ops, sends, tick } = setup();
    const key = opsStatusKey("ci", "CI");
    tick(0);
    tick(10 * MIN);
    expect(ops.ackPickup("pickup-1", false)).toBe(true);
    expect(store.getOpsStatus("ci", key)).toBeNull();
    tick(11 * MIN);
    expect(sends).toHaveLength(1);
    tick(21 * MIN);
    expect(sends.map((one) => one.id)).toEqual(["pickup-1", "pickup-2"]);
    ops.close();
  });

  it("after three pick-ups in a day posts one keeps-breaking card, and sends no more", () => {
    const { store, ops, sends, cards, tick } = setup();
    const key = opsStatusKey("ci", "CI");
    tick(0);
    for (const [n, hour] of [1, 3, 5].entries()) {
      tick(hour * 60 * MIN);
      expect(sends, `hour ${hour}`).toHaveLength(n + 1);
      ops.ackPickup(`pickup-${n + 1}`, true);
      // Fixed, then red again: nobody is on it.
      store.deleteOpsStatus("ci", key, store.getOpsStatus("ci", key)!.version);
      tick(hour * 60 * MIN + MIN);
    }
    tick(7 * 60 * MIN);
    tick(8 * 60 * MIN);
    expect(sends).toHaveLength(3);
    expect(cards.map((card) => card.title)).toEqual(["CI is still red"]);
    ops.close();
  });

  const pr = (number: number, extra: Partial<PullRequest> = {}): PullRequest =>
    ({ repo: MS, number, title: `PR ${number}`, url: "https://example.com/pr", draft: false, author: "a", labels: [], headAt: iso(-3 * 60 * MIN), updatedAt: iso(0), checks: { state: "fail", passed: 0, failed: 1, pending: 0, failing: ["Tests"] }, ...extra }) as PullRequest;

  it("never touches a PR held in its text or by a hold label, red or not, nor sweeps its record", () => {
    const prs = [
      pr(6001, { hold: "Owner hold: wait for the review" }),
      pr(6002, { labels: ["Blocked"] }),
      pr(6003, { hold: "Owner hold", checks: { state: "pending", passed: 0, failed: 0, pending: 1, failing: [] } }),
      pr(6005),
    ];
    const { store, ops, sends, tick } = setup(prs);
    const held = opsStatusKey("pr", "6003", MS);
    writeOpsStatus(store, "pr", held, { state: "investigating", chat: "fix-6003", by: "monitor", eta: "60", why: "rerun queued" }, null, iso(0));
    for (const minute of [0, 10, 20, 180, 181]) tick(minute * MIN);
    expect(sends.filter((one) => one.kind === "pr").map((one) => one.key)).toEqual([opsStatusKey("pr", "6005", MS)]);
    expect(store.getOpsStatus("pr", held)).toMatchObject({ state: "investigating", chat: "fix-6003", by: "monitor" });
    ops.close();
  });

  it("keeps the last holds and sweeps no PR record while GitHub's reading is stale", () => {
    const { store, ops, sends, tick } = setup([pr(6010, { hold: "Owner hold: wait for the review", checks: { state: "pending", passed: 0, failed: 0, pending: 1, failing: [] } })]);
    const record = (number: string) => writeOpsStatus(store, "pr", opsStatusKey("pr", number, MS), { state: "investigating", chat: `fix-${number}`, by: "monitor", eta: "600", why: "rebasing" }, null, iso(0));
    record("6010");
    record("6011");
    tick(0);
    for (let minute = 10; minute <= 300; minute += 10) tick(minute * MIN, false);
    const state = (number: string) => store.getOpsStatus("pr", opsStatusKey("pr", number, MS))?.state;
    expect([state("6010"), state("6011")]).toEqual(["investigating", "investigating"]);
    // Read again: the record with no hold whose chat is gone is swept, the held one still is not.
    for (let minute = 310; minute <= 450; minute += 10) tick(minute * MIN);
    expect([state("6010"), state("6011")]).toEqual(["investigating", "backlog"]);
    expect(sends.filter((one) => one.kind === "pr")).toEqual([]);
    ops.close();
  });

  it("sweeps no PR record of a repo whose PR read failed in a fresh reading, and still sweeps another repo's", () => {
    const { store, ops, sends, tick } = setup();
    const OTHER = "example-org/other-repo";
    const record = (number: string, repo: string) => writeOpsStatus(store, "pr", opsStatusKey("pr", number, repo), { state: "investigating", chat: `fix-${number}`, by: "monitor", eta: "600", why: "rebasing" }, null, iso(0));
    record("6020", MS);
    record("12", OTHER);
    for (let minute = 0; minute <= 300; minute += 10) {
      const snapshot = github(new Date(T0 + minute * MIN));
      ops.store.put("github", { ...snapshot, sources: { ...snapshot.sources!, prs: { failed: ["example-repo"], at: null } } }, new Date(T0 + minute * MIN));
      tick(minute * MIN, false);
    }
    expect(store.getOpsStatus("pr", opsStatusKey("pr", "6020", MS))?.state).toBe("investigating");
    expect(store.getOpsStatus("pr", opsStatusKey("pr", "12", OTHER))?.state).toBe("backlog");
    expect(sends.filter((one) => one.kind === "pr")).toEqual([]);
    ops.close();
  });

  it("writes the record before sending, and sends nothing when the store refuses it, at most three tries an hour", () => {
    const { store, ops, sends, tick } = setup();
    store.countOpsStatuses = () => 500;
    for (let minute = 0; minute <= 60; minute += 1) tick(minute * MIN);
    expect(sends).toEqual([]);
    expect(ops.store.get("pickup")?.refused?.map((one) => one.at)).toEqual([iso(10 * MIN), iso(21 * MIN), iso(32 * MIN)]);
    ops.close();
  });

  it("puts a parked record back with its own time, so a failed pick-up cannot re-park newer trouble", () => {
    const { store, ops, tick } = setup();
    const key = opsStatusKey("ci", "CI");
    writeOpsStatus(store, "ci", key, { state: "parked", note: "Leave it", by: "monitor" }, null, iso(-MIN));
    tick(0);
    tick(10 * MIN);
    expect(store.getOpsStatus("ci", key)).toMatchObject({ state: "investigating", by: "rivet" });
    expect(ops.ackPickup("pickup-1", false)).toBe(true);
    expect(store.getOpsStatus("ci", key)).toMatchObject({ state: "parked", note: "Leave it", updatedAt: iso(-MIN) });
    ops.close();
  });

  it("puts back the record a pick-up replaced when the bridge could not type it", () => {
    const { store, ops, tick } = setup();
    const key = opsStatusKey("ci", "CI");
    writeOpsStatus(store, "ci", key, { state: "backlog", note: "Incident: flaky runner, see the notes", by: "monitor" }, null, iso(-MIN));
    tick(0);
    tick(10 * MIN);
    expect(store.getOpsStatus("ci", key)).toMatchObject({ state: "investigating", by: "rivet" });
    expect(ops.ackPickup("pickup-1", false)).toBe(true);
    expect(store.getOpsStatus("ci", key)).toMatchObject({ state: "backlog", note: "Incident: flaky runner, see the notes", by: "monitor", since: iso(-MIN) });
    ops.close();
  });
});
