import { BRIEFING_STALE_MS, CLAUDE_STALE_MS, FLY_STALE_MS, GITHUB_STALE_MS, longRed, MAC_STALE_MS, type OpsResponse, type PullRequest, type TimelineResponse } from "../../src/shared/ops.js";
import type { OpsDismissal } from "../../src/shared/ops-dismiss.js";
import type { OpsStatus } from "../../src/shared/ops-status.js";
import type { OwnerHold } from "../../src/shared/owner-holds.js";
import { setDefaultRepo } from "../../src/shared/repos.js";
import { SCHEDULES_STALE_MS } from "../../src/shared/schedules.js";
import * as api from "./api.js";
import { onSessionReset } from "./session.js";
import { sameSession, signedOut } from "./state.js";

const POLL_MS = 60_000;

/** The Ops board, timeline and failed items' statuses, shared by the Ops tab and search. */
export const opsData = {
  ops: null as OpsResponse | null,
  timeline: null as TimelineResponse | null,
  /** What is being done about failed items; null until loaded. */
  statuses: null as OpsStatus[] | null,
  /** Whether a whole list of statuses has loaded: one Fix it's record alone is not the list. */
  statusesLoaded: false,
  /** Your dismissed red items, each with its mark; none until loaded. */
  dismissals: [] as OpsDismissal[],
  /** Your own holds, as `rivet hold` records them (GET /api/ops/holds); null until loaded. */
  ownerHolds: null as OwnerHold[] | null,
  /** The last /api/ops read failed; the timeline's own failure is `timelineError`. */
  error: null as string | null,
  timelineError: false,
  at: 0,
  /**
   * When `ops` was asked for, on both of the device's clocks: its "now" is no earlier, so the time since never counts
   * a slow answer's transit as fresh (`opsAge`).
   */
  opsAt: { mono: 0, wall: 0 },
};

const listeners = new Set<() => void>();
let timer: number | null = null;
let inflight: Promise<void> | null = null;
let inflightCurrent = (): boolean => false;
let expiry: number | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

const STATUSES_TIMEOUT_MS = 10_000;
let statusesLoad: AbortController | null = null;
let statusesCurrent = (): boolean => false;

/** The failed items' statuses, on their own: a slow or failed load never holds up Ops, which keeps the last ones. */
function loadStatuses(): void {
  if (statusesLoad && statusesCurrent()) return;
  // One still loading for an earlier session is dropped, so this session reads its own.
  statusesLoad?.abort();
  const current = sameSession();
  statusesCurrent = current;
  const load = new AbortController();
  statusesLoad = load;
  const timer = setTimeout(() => load.abort(), STATUSES_TIMEOUT_MS);
  void api
    .getOpsStatuses(load.signal)
    .then((answer) => {
      if (load.signal.aborted || !current()) return;
      opsData.statuses = answer.statuses;
      opsData.statusesLoaded = true;
      notify();
    })
    .catch(() => {})
    .finally(() => {
      clearTimeout(timer);
      if (statusesLoad === load) statusesLoad = null;
    });
}

let dismissalsLoad: AbortController | null = null;
/** Bumped by each tap and each write's end: a load that began before either is an older list, and is dropped. */
let dismissalsTurn = 0;
let dismissalWrites = 0;

/** A Dismiss or Bring back being written: no load lands while one is, and the list is read again once all are done. */
export function dismissalWrite<T>(write: Promise<T>): Promise<T> {
  dismissalWrites++;
  dismissalsTurn++;
  return write.finally(() => {
    dismissalWrites--;
    dismissalsTurn++;
    if (!dismissalWrites) loadDismissals();
  });
}

/** The dismissals, on their own as the statuses are: a failed load keeps the last ones. */
function loadDismissals(): void {
  dismissalsLoad?.abort();
  const current = sameSession();
  const load = new AbortController();
  dismissalsLoad = load;
  const turn = dismissalsTurn;
  const timer = setTimeout(() => load.abort(), STATUSES_TIMEOUT_MS);
  void api
    .getOpsDismissals(load.signal)
    .then((answer) => {
      if (load.signal.aborted || !current() || !Array.isArray(answer?.dismissals)) return;
      if (turn !== dismissalsTurn || dismissalWrites) return;
      // Only a change repaints: the load runs on every Ops refresh.
      if (JSON.stringify(answer.dismissals) === JSON.stringify(opsData.dismissals)) return;
      opsData.dismissals = answer.dismissals;
      notify();
    })
    .catch(() => {})
    .finally(() => {
      clearTimeout(timer);
      if (dismissalsLoad === load) dismissalsLoad = null;
    });
}

let ownerHoldsLoad: AbortController | null = null;

/** Your recorded holds, on their own as the dismissals are: a failed load keeps the last ones. */
function loadOwnerHolds(): void {
  ownerHoldsLoad?.abort();
  const current = sameSession();
  const load = new AbortController();
  ownerHoldsLoad = load;
  const timer = setTimeout(() => load.abort(), STATUSES_TIMEOUT_MS);
  void api
    .getOwnerHolds(load.signal)
    .then((answer) => {
      if (load.signal.aborted || !current() || !Array.isArray(answer?.holds)) return;
      // Only a change repaints: the load runs on every Ops refresh.
      if (JSON.stringify(answer.holds) === JSON.stringify(opsData.ownerHolds)) return;
      opsData.ownerHolds = answer.holds;
      notify();
    })
    .catch(() => {})
    .finally(() => {
      clearTimeout(timer);
      if (ownerHoldsLoad === load) ownerHoldsLoad = null;
    });
}

/** A dismissal this phone just made (a mark) or took back (null), shown at once; the next load brings the stored ones. */
export function noteDismissal(kind: OpsDismissal["kind"], key: string, mark: string | null): void {
  dismissalsTurn++;
  const rest = opsData.dismissals.filter((one) => one.kind !== kind || one.key !== key);
  opsData.dismissals = mark === null ? rest : [{ kind, key, mark, at: new Date().toISOString() }, ...rest];
  notify();
}

/** A record the server just wrote for this phone, shown at once until the next load brings the stored one. */
export function noteStatus(status: OpsStatus): void {
  opsData.statuses = [status, ...(opsData.statuses ?? []).filter((one) => one.kind !== status.kind || one.key !== status.key)];
  notify();
  // A load already out may have read before this write: read again after it.
  statusesLoad?.abort();
  statusesLoad = null;
  loadStatuses();
}

/** An answer the Ops readers can draw: every server's answer has its summary, which the status line and menu read. */
function isOpsAnswer(value: unknown): value is OpsResponse {
  const summary = (value as Partial<OpsResponse> | null)?.summary;
  return typeof summary === "object" && summary !== null;
}

/** Loads both at once, and the statuses beside them; a failed part keeps its last good value. */
export function refreshOps(): Promise<void> {
  const asked = { mono: performance.now(), wall: Date.now() };
  // An answer without its summary (a proxy's page, a preview stub) is a failed load, not a reading the views crash on.
  const getOps = () => api.getOps().then((value) => (isOpsAnswer(value) ? { value, at: asked } : Promise.reject(new Error("Ops answered without its summary."))));
  if (!inflight || !inflightCurrent()) {
    const current = sameSession();
    const load: Promise<void> = Promise.allSettled([getOps(), api.getTimeline()])
      .then(([ops, timeline]) => {
        // One begun in an earlier session neither signs this one out nor fills its Ops.
        if (!current()) return;
        const failures = [ops, timeline].filter((result): result is PromiseRejectedResult => result.status === "rejected");
        // Any part refused for the session signs out, whichever part failed first.
        if (failures.some((result) => result.reason instanceof api.ApiError && result.reason.status === 401)) {
          signedOut("Your session ended. Sign in again.");
          return;
        }
        if (ops.status === "fulfilled") {
          opsData.ops = ops.value.value;
          opsData.opsAt = ops.value.at;
          setDefaultRepo(ops.value.value.defaultRepo ?? null);
          expireReadings();
        }
        if (timeline.status === "fulfilled") opsData.timeline = timeline.value;
        opsData.timelineError = timeline.status === "rejected";
        opsData.error = ops.status === "rejected" ? (ops.reason instanceof Error ? ops.reason.message : "Couldn't load Ops.") : null;
        opsData.at = Date.now();
        notify();
      })
      .finally(() => {
        if (inflight === load) inflight = null;
      });
    inflight = load;
    inflightCurrent = current;
  }
  loadStatuses();
  loadDismissals();
  loadOwnerHolds();
  return inflight;
}

/**
 * How long since `ops` was asked for: the longer of the two clocks, since a user can set the wall clock back and WebKit's
 * monotonic clock stands still while the device sleeps.
 */
export function opsAge(): number {
  return Math.max(0, performance.now() - opsData.opsAt.mono, Date.now() - opsData.opsAt.wall);
}

/** A reading's age now: its age on the server's clock when Ops answered, plus the time since on this device's (opsAge). */
export function readingAge(ops: OpsResponse, at: string): number {
  return Date.parse(ops.now) - Date.parse(at) + opsAge();
}

/** GitHub's counts stand only while its snapshot is current, judged now as well as by the server's flag: a kept answer ages. */
export function githubCurrent(ops: OpsResponse): boolean {
  return !!ops.github && !ops.github.stale && readingAge(ops, ops.github.at) <= GITHUB_STALE_MS;
}

/**
 * The PRs read this time, while GitHub is current: a repo whose PR fetch failed keeps its last list, which may be old,
 * so its PRs are left out (the notice under the glance names it) and every other repo's still count.
 */
export function freshPrs(ops: OpsResponse): PullRequest[] | null {
  if (!githubCurrent(ops)) return null;
  const failed = new Set(ops.github!.sources?.prs.failed ?? []);
  if (!failed.size) return ops.github!.prs;
  return ops.github!.prs.filter((pr) => !failed.has(pr.repo.split("/").pop() ?? pr.repo));
}

/** The current PRs red on the same push for over an hour, the ones Rivet and the Ops mark count; null with no current PR reading. */
export function brokenPrs(ops: OpsResponse): PullRequest[] | null {
  const now = Date.parse(ops.now) + opsAge();
  return freshPrs(ops)?.filter((pr) => longRed(pr, now)) ?? null;
}

/** Red CI stands only while main's runs came from the current snapshot's own fetch: a failed runs source is CI unknown. */
export function ciCurrent(ops: OpsResponse): boolean {
  return githubCurrent(ops) && !ops.github!.sources?.runs.failed.length;
}

/** Age of the oldest health check, including time spent on the server before this answer. */
function healthAge(ops: OpsResponse): number {
  const checks = (ops.apps ?? []).flatMap((one) => one.health.checkedAt ? [readingAge(ops, one.health.checkedAt)] : []);
  return Math.max(opsAge(), ...checks);
}

/** The apps-down count stands only while the oldest check is current on both clocks. */
export function healthCurrent(ops: OpsResponse): boolean {
  return !ops.healthStaleSince && healthAge(ops) <= BRIEFING_STALE_MS;
}

/** Fly is independent of public health checks, including a failed read for just one app. */
export function flyCurrent(ops: OpsResponse, app?: string): boolean {
  return !!ops.flyAt && !ops.flyStale && readingAge(ops, ops.flyAt) <= FLY_STALE_MS && (!app || !ops.flySource?.failed.includes(app));
}

/** The Mac's disk and memory stand only while its reading is current. */
export function macCurrent(ops: OpsResponse): boolean {
  return !!ops.mac && !ops.mac.stale && readingAge(ops, ops.mac.at) <= MAC_STALE_MS;
}

/** The schedules reading is current as the Schedules tab judges it (an older server's answer by its own age). */
export function schedulesCurrent(ops: OpsResponse): boolean {
  const at = ops.summary.schedulesAt;
  return at === undefined ? opsAge() <= SCHEDULES_STALE_MS : at !== null && readingAge(ops, at) <= SCHEDULES_STALE_MS;
}

/**
 * Failing schedules, while their reading is current as the Schedules tab judges it (an older server's answer by its own
 * age). The summary leaves out one already counted as red CI, so while red CI is unknown it counts again.
 */
export function failingSchedules(ops: OpsResponse): number {
  if (!schedulesCurrent(ops)) return 0;
  return ciCurrent(ops) ? ops.summary.failingSchedules : (ops.summary.failingSchedulesAll ?? ops.summary.failingSchedules);
}

/**
 * Repaints as readings expire on the device, even while the next poll hangs.
 */
function expireReadings(): void {
  if (expiry !== null) window.clearTimeout(expiry);
  expiry = null;
  const ops = opsData.ops;
  if (!ops) return;
  const lefts = [
    ops.github && !ops.github.stale ? GITHUB_STALE_MS - readingAge(ops, ops.github.at) : -1,
    ops.flyAt && !ops.flyStale ? FLY_STALE_MS - readingAge(ops, ops.flyAt) : -1,
    !ops.healthStaleSince ? BRIEFING_STALE_MS - healthAge(ops) : -1,
    ops.mac && !ops.mac.stale ? MAC_STALE_MS - readingAge(ops, ops.mac.at) : -1,
    ops.claude && !ops.claude.stale ? CLAUDE_STALE_MS - readingAge(ops, ops.claude.at) : -1,
    ops.summary?.schedulesAt === undefined ? SCHEDULES_STALE_MS - opsAge()
      : ops.summary.schedulesAt === null ? -1 : SCHEDULES_STALE_MS - readingAge(ops, ops.summary.schedulesAt),
  ].filter((left) => left >= 0);
  if (!lefts.length) return;
  expiry = window.setTimeout(() => {
    expireReadings();
    notify();
  }, Math.min(...lefts) + 50);
}

/** Loads the statuses now (a fix being opened checks for its chat sooner than the minute's poll). */
export const refreshStatuses = loadStatuses;

/** Calls `listener` whenever the data changes, with no poll of its own: for a sheet that only reads the statuses. */
export function watchStatuses(listener: () => void): () => void {
  listeners.add(listener);
  loadStatuses();
  return () => listeners.delete(listener);
}

/** Forgets the previous session's Ops, so a new shell shows Loading until its own read lands. */
export function resetOps(): void {
  Object.assign(opsData, { ops: null, timeline: null, statuses: null, statusesLoaded: false, dismissals: [], ownerHolds: null, error: null, timelineError: false, at: 0, opsAt: { mono: 0, wall: 0 } });
  if (expiry !== null) window.clearTimeout(expiry);
  expiry = null;
  statusesLoad?.abort();
  statusesLoad = null;
  dismissalsLoad?.abort();
  dismissalsLoad = null;
  ownerHoldsLoad?.abort();
  ownerHoldsLoad = null;
}
onSessionReset(resetOps);

/** Calls `listener` whenever the data changes, refreshing every minute while anything watches. */
export function watchOps(listener: () => void): () => void {
  listeners.add(listener);
  if (Date.now() - opsData.at >= POLL_MS) void refreshOps();
  timer ??= window.setInterval(() => {
    if (document.visibilityState === "visible") void refreshOps();
  }, POLL_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}
