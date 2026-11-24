import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { StoredBacklog } from "../../shared/backlog.js";
import type { Behaviour, BehaviourValue } from "../../shared/behaviours.js";
import { scheduleOwnedItem } from "../../shared/ops-owned.js";
import { limitUnread, MAC_STALE_MS, sourceAt, type ClaudeUsageSnapshot, type FlySnapshot, type GithubSnapshot, type OpsResponse } from "../../shared/ops.js";
import { AHEAD_MS, DEFAULT_READER_FIX_CAP, minutesWords, readerBehaviourId, readerKey, READERS, READERS_FIX_ID, type ReaderSpec } from "../../shared/readers.js";
import type { Schedule, SchedulesResponse } from "../../shared/schedules.js";
import { ALL_BEHAVIOURS, BehavioursStore, OWNER } from "../behaviours.js";
import { onHostedMachine } from "../hosted-name.js";
import type { SchedulesStore } from "../schedules.js";
import type { RedItem } from "./pickup.js";
import type { OpsStore } from "./store.js";

// Readers fix themselves: a reader whose reading is stale, holds nothing or makes no sense is a red the
// pick-up (pickup.ts) sends to a fix chat, under its own cap. Every detail is fixed words and numbers: the bridge types
// it into the monitor chat only when it matches its list (bridge/lib/bridge.mjs OPS_DETAIL_FAULTS).

/** A reader with no reading at all is not set up on this machine (no job installed, no snapshot ever sent): it is null. */
export interface ReaderReading {
  /** Its newest good reading; null when it has none. */
  at: string | null;
  /** What it holds nothing of, in fixed words. */
  empty?: string;
  /** What makes no sense in it, in fixed words. */
  wrong?: string;
}

export interface ReaderSetting {
  on: boolean;
  /** Minutes. */
  fresh: number;
}

const ahead = (at: string | null | undefined, now: number) => !!at && Date.parse(at) - now > AHEAD_MS;
const AHEAD = "reading time ahead of now";

/** The oldest of the times; null when any is missing, as a part with no data has no good reading. */
function oldest(times: readonly (string | null)[]): string | null {
  if (times.some((time) => !time)) return null;
  return [...(times as string[])].sort()[0] ?? null;
}

/**
 * A haiku reader from its launchd job. Null for nothing to judge: no such job, the job switched off in Scheduled, one whose
 * failing runs already have their own red (schedules.failing), or one with no finished run read yet (launchd says
 * nothing of a job until its next run after a restart) unless that first run is still going past the reader's window.
 * A run with no log written yet has no start time of its own: `runningSeen` is when the server first saw it running.
 * Its log is written on every pass, so runs with no log written
 * since are passes that wrote nothing. Its times are the Mac's own clock, so one far ahead is a wrong clock.
 */
export function haikuReading(schedule: Schedule | undefined, failing: boolean, freshMs: number, now: Date, runningSeen: number | null = null): ReaderReading | null {
  if (!schedule || !schedule.on || failing) return null;
  const at = now.getTime();
  const runs = schedule.runs ?? [];
  const good = [...runs.filter((run) => run.result === "ok").map((run) => run.at), ...(schedule.lastRun?.result === "ok" && schedule.lastRun.at ? [schedule.lastRun.at] : [])]
    .filter((time) => !ahead(time, at))
    .sort()
    .at(-1) ?? null;
  if ([schedule.lastRun?.at, ...runs.map((run) => run.at)].some((time) => ahead(time, at))) return { at: good, wrong: AHEAD };
  const finished = runs.length > 0 || schedule.lastRun?.result === "ok" || schedule.lastRun?.result === "failed" || schedule.lastRun?.result === "skipped";
  // Its first run since a restart still going after the reader's whole window is a hung run, not a restart.
  const started = schedule.lastRun?.result !== "running" ? null : schedule.lastRun.at ? Date.parse(schedule.lastRun.at) : runningSeen;
  const hung = started !== null && at - started > freshMs;
  if (!good && !finished && !hung) return null;
  const wrote = schedule.lastRun?.at ?? null;
  if (!good || (wrote && Date.parse(good) - Date.parse(wrote) <= freshMs)) return { at: good };
  return { at: good, empty: wrote ? `ran but wrote nothing for ${minutesWords((at - Date.parse(wrote)) / 60_000)}` : "ran but wrote nothing" };
}

// A fetch that failed keeps its last good data under the pass's new `at`: each reading is as old as its oldest part.
// The server clamps only that outer `at` (service.ts notAhead); a part's own time, kept from a pass while the Mac's
// clock ran ahead, can still read ahead, and a time ahead would pass as fresh, so it is a wrong clock.

/** Every GitHub part the reader covers, the runners and queue included. */
const GITHUB_SOURCES = ["prs", "runs", "merged", "runners", "queue"] as const;

export function githubReading(github: GithubSnapshot | null | undefined, now: Date): ReaderReading | null {
  if (!github) return null;
  const times = GITHUB_SOURCES.map((source) => sourceAt(github, source));
  const at = oldest(times);
  if (times.some((time) => ahead(time, now.getTime()))) return { at: null, wrong: AHEAD };
  const queue = github.queue;
  if (queue && [queue.queuedRuns, queue.runningRuns, queue.queuedJobs].some((count) => count < 0)) return { at, wrong: "a negative count" };
  return { at, ...(!github.runs.length && !github.prs.length ? { empty: "no runs and no PRs" } : {}) };
}

const FLY_AUTH = "flyctl failed for every app (auth?)";

export function flyReading(fly: FlySnapshot | null | undefined, now: Date): ReaderReading | null {
  if (!fly) return null;
  const at = fly.source?.failed.length ? fly.source.at : fly.at;
  if (ahead(at, now.getTime())) return { at: null, wrong: AHEAD };
  if (new Set(fly.apps.map((app) => app.app)).size < fly.apps.length) return { at, wrong: "an app listed twice" };
  // No app kept and every fetch failed is flyctl with no login, never an empty Fly: say auth, not no
  // apps. Kept data stays quiet until it is older than the reader's window; a bridge just restarted has none, so its
  // first failed pass (an outage, say) reads the same, hence the question mark.
  if (!fly.apps.length && fly.source?.failed.length) return { at, wrong: FLY_AUTH };
  return { at, ...(!fly.apps.length ? { empty: "no apps" } : {}) };
}

export function backlogReading(backlog: StoredBacklog | null | undefined, now: Date): ReaderReading | null {
  if (!backlog) return null;
  // A repo whose fetch failed keeps its own older time.
  const at = backlog.repos.length ? oldest(backlog.repos.map((repo) => repo.at)) : backlog.at;
  if (backlog.repos.some((repo) => ahead(repo.at, now.getTime()))) return { at: null, wrong: AHEAD };
  if (new Set(backlog.repos.map((repo) => repo.repo)).size < backlog.repos.length) return { at, wrong: "a repo listed twice" };
  return { at, ...(!backlog.repos.length ? { empty: "no repos" } : {}) };
}

/** The bridge's own row for a usage job that can read no account: the Mac's red already says so (pickup.ts machineReds). */
const USAGE_JOB_UNREAD = "accounts_unread";

/**
 * 0% is a real reading (a fresh week, nothing run yet); no reading on any account is not. A Google row or a credit keeps
 * its own read time, which a pass while the Mac's clock ran ahead can leave ahead: a wrong clock, as for the others.
 */
export function usageReading(claude: ClaudeUsageSnapshot | null | undefined, now: Date): ReaderReading | null {
  if (!claude) return null;
  const parts = [...claude.limits.map((limit) => limit.readAt), ...(claude.credits ?? []).map((credit) => credit.readAt)];
  if (parts.some((time) => ahead(time, now.getTime()))) return { at: null, wrong: AHEAD };
  if (claude.limits.some((limit) => limit.kind === USAGE_JOB_UNREAD)) return { at: claude.at };
  if (!claude.limits.length) return { at: claude.at, empty: "no accounts" };
  if (claude.limits.some((limit) => limit.percent < 0)) return { at: claude.at, wrong: "a negative count" };
  if (claude.limits.every((limit) => limitUnread(limit))) return { at: claude.at, wrong: "no account has a reading" };
  return { at: claude.at };
}

export interface ReaderVerdict {
  spec: ReaderSpec;
  /** When its newest good reading was; null with none. */
  at: string | null;
  /** Why it is red; null while it reads fine. */
  detail: string | null;
}

/**
 * Each reader that is on and has a reading: wrong before empty before stale. A reading of null has nothing to judge.
 * Times ahead of now on more than one reader are one wrong clock: only the first says so.
 */
export function readerVerdicts(input: { readers: readonly { spec: ReaderSpec; reading: ReaderReading | null; setting: ReaderSetting }[]; now: Date }): ReaderVerdict[] {
  const at = input.now.getTime();
  let clock = false;
  return input.readers.flatMap(({ spec, reading, setting }) => {
    if (!setting.on || !reading) return [];
    if (reading.wrong === AHEAD) {
      if (clock) return [];
      clock = true;
    }
    const fresh = setting.fresh * 60_000;
    const age = reading.at ? at - Date.parse(reading.at) : null;
    const detail = reading.wrong
      ? `reader wrong: ${reading.wrong}`
      : reading.empty
        ? `reader empty: ${reading.empty}`
        : age === null
          ? "reader stale: never ran"
          : age > fresh
            ? `reader stale: no good reading for ${minutesWords(age / 60_000)} (wanted within ${minutesWords(setting.fresh)})`
            : null;
    return [{ spec, at: reading.at, detail }];
  });
}

/** One red per reader that reads stale, empty or wrong, under the fix cap. */
export function readerReds(input: { readers: readonly { spec: ReaderSpec; reading: ReaderReading | null; setting: ReaderSetting }[]; cap: number; now: Date }): RedItem[] {
  return readerVerdicts(input).flatMap(({ spec, detail }) => (detail ? [{ ...scheduleOwnedItem(readerKey(spec.id)), name: spec.name, detail, cap: input.cap, reader: true }] : []));
}

/**
 * The readers as schedule items, so a reader's Ops record settles as a schedule's does (fixes.ts itemGreen, auto-clear
 * scheduleGreen): one run, ok now while it reads fine, failed now while it is red. "Ok now", not at its data's time: a
 * reading judged fine after its record opened (a freshness raised, say) must settle that record.
 */
export function readerSchedules(verdicts: readonly ReaderVerdict[], now: Date): Schedule[] {
  return verdicts.map(({ spec, at, detail }) => ({
    id: readerKey(spec.id),
    source: "mac",
    name: spec.name,
    what: spec.line,
    when: `fresh within ${minutesWords(spec.defaultFresh)}`,
    group: "all-day",
    on: true,
    lastRun: { at: now.toISOString(), result: detail || !at ? "failed" : "ok" },
    runs: [],
    nextRun: null,
    toggle: { can: false, why: "It is a reader: switch it in Settings, Behaviours." },
  }));
}

/** What the owner's version adds: its own readers, and their readings from what only it keeps. */
interface PrivateReaders {
  PRIVATE_READERS: readonly ReaderSpec[];
  openPrivateReadings(dataDir: string): { read(opsStore: OpsStore, now: Date): Record<string, ReaderReading | null>; close(): void };
}

// The public export leaves the owner's readers out, so the file is read only when present and never imported by name.
const PRIVATE_FILE = new URL("./readers-extra.ts", import.meta.url);
const PRIVATE: PrivateReaders | null = existsSync(fileURLToPath(PRIVATE_FILE)) ? ((await import(PRIVATE_FILE.href)) as PrivateReaders) : null;

/** Every reader this build has: the shared list, then the owner's where present. */
export const ALL_READERS: readonly ReaderSpec[] = [...READERS, ...(PRIVATE?.PRIVATE_READERS ?? [])];

/** The readers judged on this machine: a hosted one never runs the owner's, as its tab never lists them (routes/behaviours.ts). */
export const activeReaders = (hosted: boolean = onHostedMachine()): readonly ReaderSpec[] => (hosted ? READERS : ALL_READERS);

const entry = (id: string): Behaviour => ALL_BEHAVIOURS.find((one) => one.id === id)!;

/** The readers' reds for one pick-up tick, each knob read from the owner's Behaviours as it stands now. */
export function createReaders(deps: { dataDir: string; opsStore: OpsStore; schedules: SchedulesStore }) {
  const behaviours = new BehavioursStore(deps.dataDir);
  const owners = PRIVATE?.openPrivateReadings(deps.dataDir) ?? null;
  const value = (id: string): BehaviourValue => behaviours.get(OWNER, entry(id)).value;
  const setting = (spec: ReaderSpec): ReaderSetting => {
    const stored = value(readerBehaviourId(spec.id));
    return { on: stored.on === true, fresh: typeof stored.fresh === "number" ? stored.fresh : spec.defaultFresh };
  };
  /** When this server first saw each haiku job running with no log written (haikuReading's `runningSeen`). */
  const runningSeen = new Map<string, number>();

  /** Null while there is nothing to judge: the feature off, or the bridge or the Mac's own reading down. */
  function judge(now: Date, ops: Pick<OpsResponse, "now" | "bridge" | "mac">): { verdicts: ReaderVerdict[]; cap: number } | null {
    const fix = value(READERS_FIX_ID);
    if (fix.on !== true) return null;
    // The bridge sends every reading: with it down or the Mac's own reading stale, the Mac's red is the one to fix.
    const mac = ops.mac;
    if (!ops.bridge.connected || !mac || mac.stale || now.getTime() - Date.parse(mac.at) > MAC_STALE_MS) return null;
    const readers = activeReaders();
    const hosted = readers.length < ALL_READERS.length;
    const settings = new Map(readers.map((spec) => [spec.id, setting(spec)]));
    const schedules: SchedulesResponse = deps.schedules.view(now);
    const macRead = !schedules.stale && schedules.sources.some((source) => source.source === "mac" && source.ok);
    const failing = new Set(deps.schedules.failing(now).map((one) => one.scheduleId));
    const fresh = (spec: ReaderSpec) => settings.get(spec.id)!.fresh * 60_000;
    const extra = hosted ? {} : (owners?.read(deps.opsStore, now) ?? {});
    const reading = (spec: ReaderSpec): ReaderReading | null => {
      switch (spec.id) {
        case "github":
          return githubReading(deps.opsStore.get("github"), now);
        case "fly":
          return flyReading(deps.opsStore.get("fly"), now);
        case "backlog":
          return backlogReading(deps.opsStore.get("backlog"), now);
        case "usage":
          return usageReading(deps.opsStore.get("claude"), now);
      }
      if (spec.kind === "haiku") {
        if (!macRead) return null;
        const id = spec.schedule!;
        const item = schedules.items.find((one) => one.id === id);
        // A run with no log written gives no start time; the first pass that saw it running stands in (a server restart
        // starts that count again, so a hung run reads stale one window later, never sooner).
        if (item?.lastRun?.result === "running" && !item.lastRun.at) {
          if (!runningSeen.has(id)) runningSeen.set(id, now.getTime());
        } else runningSeen.delete(id);
        return haikuReading(item, failing.has(id), fresh(spec), now, runningSeen.get(id) ?? null);
      }
      return extra[spec.id] ?? null;
    };
    const cap = typeof fix.cap === "number" ? fix.cap : DEFAULT_READER_FIX_CAP;
    return { verdicts: readerVerdicts({ readers: readers.map((spec) => ({ spec, reading: reading(spec), setting: settings.get(spec.id)! })), now }), cap };
  }

  return {
    reds(now: Date, ops: Pick<OpsResponse, "now" | "bridge" | "mac">): RedItem[] {
      const judged = judge(now, ops);
      if (!judged) return [];
      return judged.verdicts.flatMap(({ spec, detail }) => (detail ? [{ ...scheduleOwnedItem(readerKey(spec.id)), name: spec.name, detail, cap: judged.cap, reader: true }] : []));
    },
    /** The readers as schedule items for the fix-result and auto-clear passes; none while nothing can be judged. */
    schedules(now: Date, ops: Pick<OpsResponse, "now" | "bridge" | "mac">): Schedule[] {
      const judged = judge(now, ops);
      return judged ? readerSchedules(judged.verdicts, now) : [];
    },
    close: () => {
      behaviours.close();
      owners?.close();
    },
  };
}
