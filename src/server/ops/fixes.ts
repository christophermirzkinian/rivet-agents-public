import { createHash } from "node:crypto";

import { NO_REPO } from "../../shared/repos.js";
import { opsStatusKey, statusKeyRepo } from "../../shared/ops-status-key.js";
import { HANDLER_BY } from "../../shared/ops-owned.js";
import type { OpsStatus } from "../../shared/ops-status.js";
import {
  GITHUB_STALE_MS,
  isOneOff,
  isRed,
  latestMainRuns,
  MAC_STALE_MS,
  partialCi,
  wedged,
  type OpsResponse,
  type WorkflowRun,
} from "../../shared/ops.js";
import { newestFinished, type Schedule } from "../../shared/schedules.js";
import { itemId, machineReds } from "./pickup.js";

// Fix result: when a failed Ops item with work under way goes green, or its record is set fixed, an
// update card says so in its thread, once per failure (its record's `since`).

/** A record set fixed by hand gets its card when the next pass sees it within this long. */
export const FIX_RESULT_WINDOW_MS = 3600_000;
/** The card ids already posted that are remembered, newest last. */
export const MAX_FIX_RESULTS = 500;
const MAX_TITLE = 300;

export interface FixReadings {
  view: OpsResponse;
  /** The schedules as last read; null while that reading is stale. */
  schedules: Schedule[] | null;
}

/** A run finished after the failure began, as auto-clear reads it. */
const after = (at: string, since: string) => Date.parse(at) > Date.parse(since);
const underWay = (status: OpsStatus) => status.state === "investigating" || status.state === "in-progress";

function app(status: OpsStatus, { view }: FixReadings) {
  return status.kind === "app" ? view.apps.find((one) => opsStatusKey("app", one.id) === status.key) : undefined;
}

function runs(status: OpsStatus, { view }: FixReadings): WorkflowRun[] {
  return status.kind === "ci" && view.github ? view.github.runs.filter((one) => opsStatusKey("ci", one.workflow, one.repo) === status.key) : [];
}

function run(status: OpsStatus, readings: FixReadings) {
  return latestMainRuns(runs(status, readings))[0];
}

function pr(status: OpsStatus, { view }: FixReadings) {
  return status.kind === "pr" ? view.github?.prs.find((one) => opsStatusKey("pr", String(one.number), one.repo) === status.key) : undefined;
}

function schedule(status: OpsStatus, { schedules }: FixReadings) {
  return status.kind === "schedule" ? schedules?.find((one) => opsStatusKey("schedule", one.id) === status.key) : undefined;
}

/**
 * When the readings that show a machine, Mac volume or runner red (pickup.ts machineReds) read it back up: the oldest of
 * them, or null when one of them is out of date, missing it or a measurement it is red on.
 */
function machineReadAt(status: OpsStatus, view: OpsResponse): string | null {
  const now = Date.parse(view.now);
  const current = (reading: { at: string; stale?: boolean } | null | undefined, limit: number) => !!reading && !reading.stale && now - Date.parse(reading.at) <= limit;
  const reads: (string | null)[] = [];
  const { mac, github } = view;
  const runnersRead = !!github && current(github, GITHUB_STALE_MS) && !github.sources?.runners.failed.length;
  if (status.kind === "machine") {
    if (status.key === "mac" && mac) reads.push(current(mac, MAC_STALE_MS) && mac.memory.pressure !== "unknown" ? mac.at : null);
  }
  if (status.kind === "disk" && mac) {
    reads.push(current(mac, MAC_STALE_MS) && mac.volumes.some((volume) => opsStatusKey("disk", volume.label) === status.key && volume.totalBytes > 0) ? mac.at : null);
  }
  if (status.kind === "runner" && github) {
    const runner = github.runners?.runners.find((one) => opsStatusKey("runner", one.name) === status.key);
    const up = runner && (runner.status === "online" || (view.retiredRunners ?? []).includes(runner.name));
    reads.push(runnersRead && up ? github.at : null);
  }
  if (!reads.length || reads.includes(null)) return null;
  return (reads as string[]).reduce((oldest, at) => (Date.parse(at) < Date.parse(oldest) ? at : oldest));
}

/** Whether the item a record is about reads green now: null when the readings cannot say, or for a kind they never show. */
export function itemGreen(status: OpsStatus, readings: FixReadings): boolean | null {
  const github = readings.view.github;
  if (status.kind === "app") {
    const found = app(status, readings);
    if (!found || readings.view.healthStaleSince || found.health.state === "unknown") return null;
    if (found.health.state === "down") return false;
    // Back up needs a current Fly reading of it too: a failed release behind a stale or failed reading is not back up.
    if ((found.app && readings.view.flySource?.failed.includes(found.app)) || (found.fly && readings.view.flyStale)) return null;
    // An app with no check has a failing Fly check on an awake machine as its only red.
    return found.fly?.lastRelease?.status !== "failed" && !wedged(found);
  }
  if (status.kind === "ci") {
    // One-off runs dropped, as brokenOnMain and auto-clear's ciGreen drop them: their red or green is not main's.
    const automatic = runs(status, readings).filter((one) => !isOneOff(one));
    const found = latestMainRuns(automatic)[0];
    if (!found || !github || github.stale || github.sources?.runs.failed.length) return null;
    // A dispatched or nightly CI skips steps a push run has (partialCi), so its green is green only while the latest
    // push retained is green too; with no push retained it cannot say.
    const pushed = partialCi(found) ? latestMainRuns(automatic.filter((one) => !partialCi(one)))[0] : found;
    if (isRed(found) || (pushed && isRed(pushed))) return false;
    // A green from before the failure began is the reading the record was written against (a rerun of the red run is
    // left out while it runs, so an older green is the latest finished): it cannot say. A rerun's finish is updatedAt.
    return pushed && after(found.updatedAt, status.since) ? true : null;
  }
  if (status.kind === "pr") {
    const found = pr(status, readings);
    // Only the PR's own repo needs reading this time: another repo's failed fetch says nothing about it.
    if (!found || !github || github.stale || github.sources?.prs.failed.includes(found.repo.split("/").pop() ?? found.repo)) return null;
    return found.checks.state === "pass" ? true : found.checks.state === "fail" ? false : null;
  }
  if (status.kind === "schedule") {
    const found = schedule(status, readings);
    // The newest finished run, as failingStreak and auto-clear read it, not lastRun alone. A pass from before the
    // failure began cannot say: a rerun of the failed run is left out of the finished runs while it runs.
    const newest = found ? newestFinished(found) : null;
    if (newest?.result === "failed") return false;
    return newest?.result === "ok" && !!newest.at && after(newest.at, status.since) ? true : null;
  }
  if (status.kind === "machine" || status.kind === "disk" || status.kind === "runner") {
    if (machineReds(readings.view).some((item) => itemId(item) === itemId(status))) return false;
    // A reading from before the failure began is the one the record was written against: it cannot say.
    const read = machineReadAt(status, readings.view);
    return read && after(read, status.since) ? true : null;
  }
  return null;
}

/**
 * Whether a pick-up waiting on a time (backlog) has ended: its app, PR, machine, Mac volume or runner reads green on
 * readings taken since the record began, as nobody is on it to settle it. A reading from before cannot say.
 */
export function backlogGreen(status: OpsStatus, readings: FixReadings): boolean {
  if (status.state !== "backlog" || itemGreen(status, readings) !== true) return false;
  // A machine, volume or runner reads green in itemGreen only on readings taken since the record began.
  if (status.kind === "machine" || status.kind === "disk" || status.kind === "runner") return true;
  const { view } = readings;
  if (status.kind === "app") {
    const found = app(status, readings);
    const checked = found?.health.checkedAt;
    const flown = !!found?.fly && !!view.flyAt && after(view.flyAt, status.since);
    // An app with no check has its Fly reading alone to say.
    return checked ? after(checked, status.since) && (!found.fly || flown) : flown;
  }
  return status.kind === "pr" && !!view.github && after(view.github.at, status.since);
}

/** The card: "Billing back up: <the record's note>", in the fix chat's thread (or its PR's). */
export function fixCard(status: OpsStatus, readings: FixReadings): { id: string; title: string; tag: string; chat?: string; pr?: number; repo?: string } {
  const foundPr = pr(status, readings);
  const head =
    status.kind === "app"
      ? `${app(status, readings)?.name ?? status.key} back up`
      : status.kind === "ci"
        ? `${run(status, readings)?.workflow ?? status.key} green on main`
        : status.kind === "pr"
          ? `#${foundPr?.number ?? status.key} checks pass`
          : status.kind === "schedule"
            ? `${schedule(status, readings)?.name ?? status.key} passing again`
            : `${status.kind} ${status.key} fixed`;
  const note = status.note?.split("\n")[0]?.trim();
  const full = note ? `${head}: ${note}` : head;
  const title = full.length > MAX_TITLE ? `${full.slice(0, MAX_TITLE - 1)}…` : full;
  // A PR, red main or Coming item in another repo has that repo's short name before a "/" in its key (opsStatusKey), read here when
  // the item is no longer in the readings.
  const keyed = status.kind === "pr" || status.kind === "ci" || status.kind === "coming" ? statusKeyRepo(status.kind, status.key) : undefined;
  const bare = status.kind === "pr" ? status.key.slice(status.key.lastIndexOf("/") + 1) : "";
  const number = foundPr?.number ?? (/^\d+$/.test(bare) ? Number(bare) : status.pr);
  // Else the repo of the record's fix chat, so its card opens that repo's conversation.
  const repo = foundPr?.repo ?? run(status, readings)?.repo ?? (keyed === NO_REPO ? undefined : keyed) ?? status.repo;
  // Readable, with a hash of the whole key and failure so two long keys sharing a start never share a card.
  const hash = createHash("sha256").update(`${status.kind}\n${status.key}\n${status.since}`).digest("hex").slice(0, 12);
  const id = `fix-${status.kind}-${status.key.replace(/[^a-z0-9.-]+/g, "-").slice(0, 40)}-${hash}`;
  return {
    id,
    title,
    tag: "Fixed",
    ...(status.chat ? { chat: status.chat } : {}),
    ...(number !== undefined ? { pr: number } : {}),
    ...(repo && repo !== NO_REPO ? { repo } : {}),
  };
}

/**
 * The records a pass acts on: a fixed record changed within the window, and one with work under way whose item was
 * read red at an earlier pass (`seenRed`, kept by the caller) and reads green now. The second is set fixed by the caller.
 */
export function fixResults(statuses: readonly OpsStatus[], readings: FixReadings, now: Date, seenRed: Set<string>): { status: OpsStatus; green: boolean }[] {
  const due: { status: OpsStatus; green: boolean }[] = [];
  const current = new Set(statuses.filter(underWay).map((status) => `${status.kind}/${status.key}/${status.since}`));
  for (const failure of seenRed) if (!current.has(failure)) seenRed.delete(failure);
  for (const status of statuses) {
    if (status.by === HANDLER_BY) continue;
    const failure = `${status.kind}/${status.key}/${status.since}`;
    if (status.state === "fixed") {
      // A record set fixed while its item still reads red says nothing is back yet: no card until it reads green.
      if (now.getTime() - Date.parse(status.updatedAt) <= FIX_RESULT_WINDOW_MS && itemGreen(status, readings) !== false) due.push({ status, green: false });
      continue;
    }
    if (!underWay(status)) continue;
    const green = itemGreen(status, readings);
    if (green === false) seenRed.add(failure);
    else if (green === true && seenRed.has(failure)) due.push({ status, green: true });
  }
  return due;
}
