import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ALL_BEHAVIOURS, BehavioursStore, OWNER } from "../src/server/behaviours.js";
import { PICKUP_NOTE } from "../src/server/ops/pickup.js";
import {
  activeReaders,
  backlogReading,
  createReaders,
  flyReading,
  githubReading,
  haikuReading,
  readerReds,
  readerSchedules,
  usageReading,
  type ReaderReading,
} from "../src/server/ops/readers.js";
import { createOps } from "../src/server/ops/service.js";
import { OpsStore } from "../src/server/ops/store.js";
import { writeOpsStatus } from "../src/server/routes/ops-status.js";
import { SchedulesStore } from "../src/server/schedules.js";
import { Store } from "../src/server/store.js";
import type { StoredBacklog } from "../src/shared/backlog.js";
import type { ClaudeLimit, ClaudeUsageSnapshot, FlySnapshot, GithubSnapshot, MacSnapshot, OpsResponse } from "../src/shared/ops.js";
import { readerBehaviourId, READERS, READERS_FIX_ID, type ReaderSpec } from "../src/shared/readers.js";
import { NO_REPO } from "../src/shared/repos.js";
import type { BridgeSchedule, Schedule } from "../src/shared/schedules.js";
import type { Worker } from "../src/shared/workers.js";

// Readers fix themselves: each kind of reader stale, empty or wrong is one red; the pick-up sends it to a fix
// chat, and past its cap posts the one card, which carries the fix tried.

const T0 = Date.parse("2026-11-22T01:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date(T0);
const iso = (ms: number) => new Date(T0 + ms).toISOString();

const spec = (id: string): ReaderSpec => READERS.find((one) => one.id === id)!;
/** The one red `reading` makes for reader `id` at its default freshness, or null. */
function redOf(id: string, reading: ReaderReading | null, fresh = spec(id).defaultFresh): string | null {
  const reds = readerReds({ readers: [{ spec: spec(id), reading, setting: { on: true, fresh } }], cap: 3, now: NOW });
  expect(reds.length).toBeLessThanOrEqual(1);
  return reds[0]?.detail ?? null;
}

function job(id: string, extra: Partial<BridgeSchedule> = {}): BridgeSchedule {
  return {
    id: `mac:dev.rivet-agents.reader-${id}`,
    source: "mac",
    name: id,
    what: "Reads",
    when: "Every 2 min",
    group: "all-day",
    on: true,
    lastRun: { at: iso(-2 * MIN), result: "ok" },
    nextRun: null,
    toggle: { can: true },
    runs: [{ id: "1", at: iso(-2 * MIN), result: "ok" }],
    ...extra,
  };
}

const github = (at: number, extra: Partial<GithubSnapshot> = {}): GithubSnapshot =>
  ({ at: iso(at), prs: [{ number: 1 }], runs: [], runners: null, queue: null, merged: null, closed: null, ...extra }) as unknown as GithubSnapshot;
const fly = (at: number, apps: string[] = ["rivet"]): FlySnapshot => ({ at: iso(at), apps: apps.map((app) => ({ app })), source: null }) as unknown as FlySnapshot;
const backlog = (at: number, repos: string[] = ["a/b"]): StoredBacklog => ({ at: iso(at), repos: repos.map((repo) => ({ repo, at: iso(at) })) }) as unknown as StoredBacklog;
const limit = (percent: number, kind = "weekly_all"): ClaudeLimit => ({ kind, label: "Week", percent, severity: "normal", resetsAt: null, active: true });
const usage = (at: number, limits: ClaudeLimit[] = [limit(40)]): ClaudeUsageSnapshot => ({ at: iso(at), limits });

describe("a haiku reader", () => {
  const read = (schedule: Schedule | undefined, failing = false) => haikuReading(schedule, failing, 10 * MIN, NOW);

  it("is quiet while its job runs and writes", () => {
    expect(redOf("chat-watch", read(job("chat-watch")))).toBeNull();
  });

  it("is stale with no good run inside its window, and never ran when its runs all failed", () => {
    const old = job("chat-watch", { lastRun: { at: iso(-47 * MIN), result: "ok" }, runs: [{ id: "1", at: iso(-47 * MIN), result: "ok" }] });
    expect(redOf("chat-watch", read(old))).toBe("reader stale: no good reading for 47 min (wanted within 10 min)");
    const failedOnly = job("chat-watch", { lastRun: { at: iso(-2 * MIN), result: "failed" }, runs: [{ id: "1", at: iso(-2 * MIN), result: "failed" }] });
    expect(redOf("chat-watch", read(failedOnly))).toBe("reader stale: never ran");
  });

  it("is empty when it runs but its log has not been written within its window", () => {
    const silent = job("chat-watch", { lastRun: { at: iso(-3 * HOUR), result: "ok" }, runs: [{ id: "2", at: iso(-2 * MIN), result: "ok" }] });
    expect(redOf("chat-watch", read(silent))).toBe("reader empty: ran but wrote nothing for 3 h");
  });

  it("is wrong when a run reads ahead of now", () => {
    const ahead = job("chat-watch", { runs: [{ id: "3", at: iso(HOUR), result: "ok" }] });
    expect(redOf("chat-watch", read(ahead))).toBe("reader wrong: reading time ahead of now");
  });

  it("has nothing to judge with no job, its job off, or its failing runs already red", () => {
    expect(read(undefined)).toBeNull();
    expect(read(job("chat-watch", { on: false, lastRun: null, runs: [] }))).toBeNull();
    expect(read(job("chat-watch", { lastRun: null, runs: [] }), true)).toBeNull();
  });
});

describe("a bridge reader", () => {
  it("GitHub: quiet when fresh, else stale, empty or wrong", () => {
    expect(redOf("github", githubReading(github(-MIN), NOW))).toBeNull();
    expect(redOf("github", githubReading(github(-20 * MIN), NOW))).toBe("reader stale: no good reading for 20 min (wanted within 15 min)");
    expect(redOf("github", githubReading(github(-MIN, { prs: [] }), NOW))).toBe("reader empty: no runs and no PRs");
    expect(redOf("github", githubReading(github(-MIN, { queue: { queuedRuns: -1, runningRuns: 0, queuedJobs: 0 } }), NOW))).toBe("reader wrong: a negative count");
    expect(githubReading(null, NOW)).toBeNull();
  });

  const source = (failed: string[], at: number | null) => ({ failed, at: at === null ? null : iso(at) });
  const sources = (parts: Partial<Record<"prs" | "runs" | "merged" | "runners" | "queue", ReturnType<typeof source>>>) => ({
    prs: source([], -MIN),
    runs: source([], -MIN),
    merged: source([], -MIN),
    runners: source([], -MIN),
    queue: source([], -MIN),
    ...parts,
  });

  it("GitHub: a pass whose fetches failed is as old as the data it kept, not the pass, for every part it covers", () => {
    expect(redOf("github", githubReading(github(-MIN, { sources: sources({}) }), NOW))).toBeNull();
    expect(redOf("github", githubReading(github(-MIN, { sources: sources({ runs: source(["example-repo"], -2 * HOUR) }) }), NOW))).toBe("reader stale: no good reading for 2 h (wanted within 15 min)");
    expect(redOf("github", githubReading(github(-MIN, { sources: sources({ runs: source(["example-repo"], null) }) }), NOW))).toBe("reader stale: never ran");
    // The runners and queue fetches failing while PRs and runs still come in.
    expect(redOf("github", githubReading(github(-MIN, { sources: sources({ runners: source(["example-repo"], -2 * HOUR) }) }), NOW))).toBe("reader stale: no good reading for 2 h (wanted within 15 min)");
    expect(redOf("github", githubReading(github(-MIN, { sources: sources({ queue: source(["example-repo"], -HOUR) }) }), NOW))).toBe("reader stale: no good reading for 1 h (wanted within 15 min)");
  });

  it("GitHub, Fly and Backlog: a kept part's time ahead of now is a wrong clock, never fresh", () => {
    const day = 24 * HOUR;
    expect(redOf("github", githubReading(github(-MIN, { sources: sources({ runs: source(["example-repo"], day) }) }), NOW))).toBe("reader wrong: reading time ahead of now");
    expect(redOf("fly", flyReading({ ...fly(-MIN), source: { failed: ["rivet"], at: iso(day) } }, NOW))).toBe("reader wrong: reading time ahead of now");
    const kept = backlog(-MIN, ["a/b", "a/c"]);
    kept.repos[1]!.at = iso(day);
    expect(redOf("backlog", backlogReading(kept, NOW))).toBe("reader wrong: reading time ahead of now");
  });

  it("Fly: quiet when fresh, else stale, empty or wrong; a failed fetch is as old as its kept apps", () => {
    expect(redOf("fly", flyReading(fly(-MIN), NOW))).toBeNull();
    expect(redOf("fly", flyReading(fly(-3 * HOUR), NOW))).toBe("reader stale: no good reading for 3 h (wanted within 1 h)");
    expect(redOf("fly", flyReading(fly(-MIN, []), NOW))).toBe("reader empty: no apps");
    expect(redOf("fly", flyReading(fly(-MIN, ["rivet", "rivet"]), NOW))).toBe("reader wrong: an app listed twice");
    expect(redOf("fly", flyReading({ ...fly(-MIN, ["rivet", "web-api"]), source: { failed: ["rivet"], at: iso(-3 * HOUR) } }, NOW))).toBe("reader stale: no good reading for 3 h (wanted within 1 h)");
  });

  it("Fly: every fetch failing with no app kept is auth, never no apps; kept data waits out its window", () => {
    expect(redOf("fly", flyReading({ ...fly(-MIN, []), source: { failed: ["rivet", "web-api"], at: null } }, NOW))).toBe("reader wrong: flyctl failed for every app (auth?)");
    expect(redOf("fly", flyReading({ ...fly(-MIN, ["rivet"]), source: { failed: ["rivet"], at: iso(-MIN) } }, NOW))).toBeNull();
    expect(redOf("fly", flyReading({ ...fly(-MIN, ["rivet"]), source: { failed: ["rivet"], at: iso(-3 * HOUR) } }, NOW))).toBe("reader stale: no good reading for 3 h (wanted within 1 h)");
  });

  it("Backlog: quiet when fresh, else stale, empty or wrong; a repo whose fetch failed keeps its own older time", () => {
    expect(redOf("backlog", backlogReading(backlog(-MIN), NOW))).toBeNull();
    expect(redOf("backlog", backlogReading(backlog(-2 * 24 * HOUR), NOW))).toBe("reader stale: no good reading for 2 days (wanted within 1 h)");
    expect(redOf("backlog", backlogReading(backlog(-MIN, []), NOW))).toBe("reader empty: no repos");
    expect(redOf("backlog", backlogReading(backlog(-MIN, ["a/b", "a/b"]), NOW))).toBe("reader wrong: a repo listed twice");
    const kept = backlog(-MIN, ["a/b", "a/c"]);
    kept.repos[1]!.at = iso(-3 * HOUR);
    expect(redOf("backlog", backlogReading(kept, NOW))).toBe("reader stale: no good reading for 3 h (wanted within 1 h)");
  });
});

describe("the usage reader", () => {
  const unread = (kind = "weekly_all") => ({ ...limit(0, kind), label: "Week (no reading)" });
  const read = (claude: ClaudeUsageSnapshot) => usageReading(claude, NOW);

  it("calls a Google row's or a credit's read time ahead of now a wrong clock, never fresh", () => {
    const day = 24 * HOUR;
    expect(redOf("usage", read(usage(-MIN, [limit(40), { ...limit(10, "google"), readAt: iso(day) }])))).toBe("reader wrong: reading time ahead of now");
    expect(redOf("usage", read({ ...usage(-MIN), credits: [{ account: "a***", state: "active", expiresAt: null, readAt: iso(day) }] }))).toBe("reader wrong: reading time ahead of now");
    expect(redOf("usage", read(usage(-MIN, [limit(40), { ...limit(10, "google"), readAt: iso(-MIN) }])))).toBeNull();
  });

  it("is quiet when fresh, else stale, empty or wrong", () => {
    expect(redOf("usage", read(usage(-MIN)))).toBeNull();
    expect(redOf("usage", read(usage(-45 * MIN)))).toBe("reader stale: no good reading for 45 min (wanted within 30 min)");
    expect(redOf("usage", read(usage(-MIN, [])))).toBe("reader empty: no accounts");
    expect(redOf("usage", read(usage(-MIN, [unread(), unread("session")])))).toBe("reader wrong: no account has a reading");
    expect(redOf("usage", read(usage(-MIN, [limit(-4)])))).toBe("reader wrong: a negative count");
  });

  it("takes 0% on every account as a real reading: a fresh week with nothing run yet", () => {
    expect(redOf("usage", read(usage(-MIN, [limit(0), limit(0, "session")])))).toBeNull();
  });

  it("leaves a usage job that reads no account to the Mac's own red, whatever its rows say", () => {
    expect(redOf("usage", read(usage(-MIN, [limit(0, "accounts_unread")])))).toBeNull();
    expect(redOf("usage", read(usage(-MIN, [limit(0, "accounts_unread"), unread()])))).toBeNull();
  });
});

describe("a wrong clock and a restart", () => {
  it("raises one red for times ahead of now on many readers: one clock, one fix", () => {
    const ahead: ReaderReading = { at: iso(-MIN), wrong: "reading time ahead of now" };
    const setting = { on: true, fresh: 30 };
    const reds = readerReds({ readers: ["chat-watch", "ci-triage", "fly-errors"].map((id) => ({ spec: spec(id), reading: ahead, setting })), cap: 3, now: NOW });
    expect(reds.map((red) => red.key)).toEqual(["reader-chat-watch"]);
  });

  it("has nothing to judge for a haiku reader with no finished run read since a restart", () => {
    const rebooted = job("issue-recheck", { lastRun: { at: null, result: "unknown" } as never, runs: [] });
    expect(haikuReading(rebooted, false, 2 * 24 * HOUR, NOW)).toBeNull();
    const starting = job("chat-watch", { lastRun: { at: iso(-3 * MIN), result: "running" } as never, runs: [] });
    expect(haikuReading(starting, false, 10 * MIN, NOW)).toBeNull();
  });

  it("calls a first run since a restart still going past the reader's window stale, not a restart", () => {
    const hung = job("chat-watch", { lastRun: { at: iso(-2 * HOUR), result: "running" } as never, runs: [] });
    expect(redOf("chat-watch", haikuReading(hung, false, 10 * MIN, NOW))).toBe("reader stale: never ran");
  });

  it("times a running first run with no log written from when the server first saw it", () => {
    const noLog = job("chat-watch", { lastRun: { at: null, result: "running" } as never, runs: [] });
    expect(haikuReading(noLog, false, 10 * MIN, NOW)).toBeNull();
    expect(haikuReading(noLog, false, 10 * MIN, NOW, NOW.getTime() - 3 * MIN)).toBeNull();
    expect(redOf("chat-watch", haikuReading(noLog, false, 10 * MIN, NOW, NOW.getTime() - 2 * HOUR))).toBe("reader stale: never ran");
  });
});

describe("readers as schedules", () => {
  it("reads a fine reader ok now and a red one failed now", () => {
    const verdicts = [
      { spec: spec("github"), at: iso(-MIN), detail: null },
      { spec: spec("fly"), at: iso(-3 * HOUR), detail: "reader stale: no good reading for 3 h (wanted within 1 h)" },
    ];
    expect(readerSchedules(verdicts, NOW).map((one) => [one.id, one.lastRun])).toEqual([
      ["reader-github", { at: iso(0), result: "ok" }],
      ["reader-fly", { at: iso(0), result: "failed" }],
    ]);
  });

  it("settles a record opened at 10:10 once a freshness raised at 10:11 reads its 09:40 data fine", () => {
    // Its data is from before the record opened, but it reads fine now: the ok run is now, after the record's since.
    const [item] = readerSchedules([{ spec: spec("chat-watch"), at: iso(-31 * MIN), detail: null }], NOW);
    expect(Date.parse(item!.lastRun!.at!)).toBeGreaterThan(T0 - MIN);
    expect(item!.lastRun!.result).toBe("ok");
  });

  it("never judges the owner's readers on a hosted machine", () => {
    expect(activeReaders(true)).toEqual(READERS);
    expect(activeReaders(false).length).toBeGreaterThanOrEqual(READERS.length);
  });
});

describe("the readers' reds", () => {
  let dir: string;
  let opsStore: OpsStore;
  let schedules: SchedulesStore;
  let readers: ReturnType<typeof createReaders>;
  const healthy = { now: iso(0), bridge: { connected: true }, mac: { at: iso(-MIN), stale: false } } as unknown as Pick<OpsResponse, "now" | "bridge" | "mac">;
  const set = (id: string, value: Record<string, unknown>) => {
    const store = new BehavioursStore(dir);
    expect(store.put(OWNER, ALL_BEHAVIOURS.find((one) => one.id === id)!, value, NOW)).not.toBeNull();
    store.close();
  };
  const keys = (ops = healthy) => readers.reds(NOW, ops).map((red) => [red.key, red.detail]);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rivet-readers-"));
    opsStore = new OpsStore(dir);
    schedules = new SchedulesStore(dir);
    readers = createReaders({ dataDir: dir, opsStore, schedules });
    opsStore.put("github", github(0, { prs: [] }), NOW);
    opsStore.put("fly", fly(-3 * HOUR), NOW);
    opsStore.put("backlog", backlog(-MIN), NOW);
    opsStore.put("claude", usage(-MIN, [{ ...limit(0), label: "Week (no reading)" }]), NOW);
    schedules.put(
      {
        at: iso(-MIN),
        sources: [{ source: "mac", ok: true, at: iso(-MIN) }],
        items: [job("chat-watch", { lastRun: { at: iso(-47 * MIN), result: "ok" }, runs: [{ id: "1", at: iso(-47 * MIN), result: "ok" }] }), job("ci-triage")],
      },
      NOW,
    );
  });

  afterEach(() => {
    readers.close();
    schedules.close();
    opsStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives one red to each reader stale, empty or wrong, on the reader's own Ops record", () => {
    expect(keys()).toEqual([
      ["reader-chat-watch", "reader stale: no good reading for 47 min (wanted within 10 min)"],
      ["reader-github", "reader empty: no runs and no PRs"],
      ["reader-fly", "reader stale: no good reading for 3 h (wanted within 1 h)"],
      ["reader-usage", "reader wrong: no account has a reading"],
    ]);
    expect(readers.reds(NOW, healthy).every((red) => red.kind === "schedule" && red.reader && red.cap === 3)).toBe(true);
  });

  it("reads each reader's switch and freshness, and the fix row's switch and cap, as they stand now", () => {
    set(readerBehaviourId("github"), { on: false, fresh: 15 });
    set(readerBehaviourId("fly"), { on: true, fresh: 360 });
    expect(keys().map(([key]) => key)).toEqual(["reader-chat-watch", "reader-usage"]);
    set(READERS_FIX_ID, { on: true, cap: 5 });
    expect(readers.reds(NOW, healthy).map((red) => red.cap)).toEqual([5, 5]);
    set(READERS_FIX_ID, { on: false, cap: 5 });
    expect(keys()).toEqual([]);
  });

  it("says nothing while the bridge is down or the Mac's own reading is stale", () => {
    expect(keys({ ...healthy, bridge: { connected: false } } as typeof healthy)).toEqual([]);
    expect(keys({ ...healthy, mac: { at: iso(-HOUR), stale: true } } as typeof healthy)).toEqual([]);
    expect(keys({ ...healthy, mac: null } as typeof healthy)).toEqual([]);
  });
});

describe("a reader that keeps going wrong", () => {
  const KEY = "reader-github";
  const FIX = "Restarted the bridge's GitHub reader";
  const mac = (at: number) => ({ at: iso(at), volumes: [], load: { one: 1, five: 1, fifteen: 1, cpus: 10 }, memory: { freePct: 60, pressure: "normal" }, uptimeSec: 9000, runners: [] }) as Partial<MacSnapshot> as MacSnapshot;
  const worker = (chat: string) => ({ id: chat, name: chat, repo: NO_REPO, chat, state: "working", lastOutputAt: null }) as Worker;

  function setup(cap?: number) {
    let clock = T0;
    const dataDir = mkdtempSync(join(tmpdir(), "rivet-readers-ops-"));
    if (cap) {
      const behaviours = new BehavioursStore(dataDir);
      behaviours.put(OWNER, ALL_BEHAVIOURS.find((one) => one.id === READERS_FIX_ID)!, { on: true, cap }, NOW);
      behaviours.close();
    }
    const store = new Store(mkdtempSync(join(tmpdir(), "rivet-readers-store-")));
    const sends: { id: string; kind: string; key: string; detail?: string }[] = [];
    const cards: { id: string; title: string; ask: string }[] = [];
    const ops = createOps({
      dataDir,
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
        cards.push(card as { id: string; title: string; ask: string });
        return { status: 200 };
      },
      pickup: {
        send: (pickup) => {
          const id = `pickup-${sends.length + 1}`;
          sends.push({ id, ...pickup });
          return id;
        },
        monitorChat: "monitor",
      },
    });
    const tick = (ms: number, reading: GithubSnapshot = github(ms, { prs: [] })) => {
      clock = T0 + ms;
      ops.store.put("mac", mac(ms), new Date(clock));
      ops.store.put("github", reading, new Date(clock));
      ops.pickupTick();
    };
    /** The fix chat ends: its record says what it tried, and nobody is on it. */
    const fixed = (ms: number) => {
      const record = store.getOpsStatus("schedule", KEY)!;
      expect(record.note).toBe(PICKUP_NOTE);
      expect(writeOpsStatus(store, "schedule", KEY, { state: "backlog", note: FIX, by: "monitor" }, record.version, iso(ms)).code).toBe(200);
    };
    const mine = () => sends.filter((sent) => sent.key === KEY);
    return { ops, sends, cards, tick, fixed, mine, dataDir, store };
  }

  it("is sent to a fix chat with its detail, gets no card under the cap, and exactly one card with the fix past it", () => {
    const { ops, cards, tick, fixed, mine } = setup();
    tick(0);
    for (const [n, hour] of [1, 3, 5].entries()) {
      tick(hour * HOUR);
      expect(mine(), `hour ${hour}`).toHaveLength(n + 1);
      expect(cards).toEqual([]);
      ops.ackPickup(mine()[n]!.id, true);
      fixed(hour * HOUR + MIN);
      tick(hour * HOUR + 2 * MIN);
    }
    expect(mine()[0]).toMatchObject({ kind: "schedule", key: KEY, detail: "reader empty: no runs and no PRs" });
    for (const hour of [7, 8, 9]) tick(hour * HOUR);
    expect(mine()).toHaveLength(3);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ title: "GitHub reading is still red" });
    expect(cards[0]!.ask).toBe(
      `Rivet has tried to start on this 3 times in 24 hours and it is still red. Auto pick-up is off for it. Now: reader empty: no runs and no PRs. Last fix tried: ${FIX}`,
    );
    ops.close();
  });

  it("posts its card after the cap the fix row sets", () => {
    const { ops, cards, tick, fixed, mine } = setup(2);
    tick(0);
    for (const [n, hour] of [1, 3].entries()) {
      tick(hour * HOUR);
      ops.ackPickup(mine()[n]!.id, true);
      fixed(hour * HOUR + MIN);
      tick(hour * HOUR + 2 * MIN);
    }
    for (const hour of [5, 6]) tick(hour * HOUR);
    expect(mine()).toHaveLength(2);
    expect(cards.map((card) => card.ask.slice(0, 40))).toEqual(["Rivet has tried to start on this 2 times"]);
    ops.close();
  });

  it("stays off after its card when the cap is raised, and the card counts the tries made", () => {
    const { ops, cards, tick, fixed, mine, dataDir } = setup(2);
    tick(0);
    for (const [n, hour] of [1, 3].entries()) {
      tick(hour * HOUR);
      ops.ackPickup(mine()[n]!.id, true);
      fixed(hour * HOUR + MIN);
      tick(hour * HOUR + 2 * MIN);
    }
    tick(5 * HOUR);
    expect(cards).toHaveLength(1);
    const behaviours = new BehavioursStore(dataDir);
    behaviours.put(OWNER, ALL_BEHAVIOURS.find((one) => one.id === READERS_FIX_ID)!, { on: true, cap: 5 }, NOW);
    behaviours.close();
    for (const hour of [6, 7, 8]) tick(hour * HOUR);
    expect(mine()).toHaveLength(2);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.ask).toMatch(/^Rivet has tried to start on this 2 times/);
    ops.close();
  });

  it("gets no late card while its one fix chat runs long, under the cap", () => {
    const { ops, cards, tick, mine } = setup();
    tick(0);
    tick(HOUR);
    expect(mine()).toHaveLength(1);
    ops.ackPickup(mine()[0]!.id, true);
    tick(30 * HOUR);
    ops.syncCards();
    expect(cards).toEqual([]);
    ops.close();
  });

  it("settles its record when a freshness raised after it opened reads the same data fine", () => {
    const { ops, sends, tick, dataDir, store } = setup();
    // Fly data 90 min old against its 1 h window, kept as it is.
    const stale = (ms: number) => {
      ops.store.put("fly", fly(-90 * MIN), new Date(T0 + ms));
      tick(ms);
    };
    const FLY = "reader-fly";
    stale(0);
    stale(HOUR);
    expect(sends.filter((sent) => sent.key === FLY)).toHaveLength(1);
    expect(store.getOpsStatus("schedule", FLY)!.state).not.toBe("fixed");
    const behaviours = new BehavioursStore(dataDir);
    expect(behaviours.put(OWNER, ALL_BEHAVIOURS.find((one) => one.id === readerBehaviourId("fly"))!, { on: true, fresh: 360 }, NOW)).not.toBeNull();
    behaviours.close();
    stale(HOUR + MIN);
    ops.settleFixes();
    ops.clearStale();
    expect(store.getOpsStatus("schedule", FLY)!.state).toBe("fixed");
    ops.close();
  });
});
