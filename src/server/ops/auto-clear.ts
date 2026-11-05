import { KNOWN_REPOS, NO_REPO } from "../../shared/repos.js";
import { opsStatusKey } from "../../shared/ops-status-key.js";
import type { OpsStatus } from "../../shared/ops-status.js";
import { isOneOff, isRed, latestMainRuns, partialCi, type ClosedPr, type MergedPr, type OpsResponse } from "../../shared/ops.js";
import { newestFinished, type Schedule } from "../../shared/schedules.js";

// Stale records: a record whose item has plainly ended is set fixed by Rivet, so nothing is left saying work is under way
// on a merged PR or a workflow main has run green since. A PR's record clears when it merges or closes, a ci or schedule
// record when the next run of its workflow on main, or of the schedule, passes, and an app's, PR's, machine's, Mac
// volume's or runner's pick-up waiting on a time (backlog) once it reads green again, as nobody is on it to settle it. A
// parked record stays (you parked it), and the fix-result pass still owns an item with work under way that it saw go red
// and then green.

export interface ClearReadings {
  github: OpsResponse["github"];
  /** Merged and closed-unmerged PRs of the last TIMELINE_DAYS, as last read. */
  merged: readonly MergedPr[];
  closed: readonly ClosedPr[];
  /** The schedules as last read; null while that reading is stale. */
  schedules: Schedule[] | null;
  /** Each schedule source's last fetch: a failed one resends its cached runs, which say nothing new. */
  scheduleSources?: readonly { source: string; ok: boolean }[];
  /** Whether a pick-up waiting on a time has ended (ops/fixes.ts backlogGreen). */
  backlogGreen?: (status: OpsStatus) => boolean;
}

/** A run finished after the failure began: one from before it is the reading the record was written against. */
const after = (at: string, since: string) => Date.parse(at) > Date.parse(since);
const clears = (status: OpsStatus) => status.state !== "fixed" && status.state !== "parked";
const short = (repo: string) => repo.split("/").pop() ?? repo;

/** Whether a key is a PR record's ("6075", "other-repo/12"), of the default repo or a known one. */
function isPrKey(key: string): boolean {
  const slash = key.lastIndexOf("/");
  const number = key.slice(slash + 1);
  if (!/^\d+$/.test(number)) return false;
  return slash === -1 || KNOWN_REPOS.some((repo) => repo !== NO_REPO && opsStatusKey("pr", number, repo) === key);
}

/**
 * The PR record's end, "merged" or "closed"; null while it may still be open or the readings cannot say. A PR merged
 * or closed before the lists' 14 days (or past their 200 a repo) is "merged or closed" once a complete, fresh open list
 * read after the record's last change lacks it.
 */
function prEnd(status: OpsStatus, { github, merged, closed }: ClearReadings): string | null {
  const keyed = (pr: { repo: string; number: number }) => opsStatusKey("pr", String(pr.number), pr.repo) === status.key;
  // Open again in the latest reading: a merge or close in the list is an older one.
  if (github?.prs.some(keyed)) return null;
  if (merged.some(keyed)) return "merged";
  // A closed PR can be reopened: only a complete, fresh list of open PRs read after the record's last change, without
  // it, says it is still closed. A record written since (a reopen) waits for the next reading.
  const openKnown = github !== null && !github.stale && github.prsComplete === true && github.sources?.prs.failed.length === 0;
  if (!openKnown || !after(github.at, status.updatedAt)) return null;
  if (closed.some(keyed)) return "closed";
  return isPrKey(status.key) ? "merged or closed" : null;
}

/** Whether the workflow's latest automatic run on main passed after the record's failure began. */
function ciGreen(status: OpsStatus, { github }: ClearReadings): boolean {
  if (!github || github.stale) return false;
  const automatic = github.runs.filter((one) => !isOneOff(one) && opsStatusKey("ci", one.workflow, one.repo) === status.key);
  const run = latestMainRuns(automatic)[0];
  // Only the run's own repo needs reading this time.
  if (!run || github.sources?.runs.failed.includes(short(run.repo))) return false;
  // A rerun keeps its createdAt, so its finish is updatedAt.
  if (isRed(run) || !after(run.updatedAt, status.since)) return false;
  // A dispatched or nightly CI skips steps a push run has (partialCi), so its green clears only while the latest push
  // retained is green too: a push's red that has aged out of the reading leaves none to stand in for it.
  const pushed = partialCi(run) ? latestMainRuns(automatic.filter((one) => !partialCi(one)))[0] : run;
  return pushed !== undefined && !isRed(pushed);
}

/** Whether the schedule's latest run passed after the record began, read from a source whose last fetch worked. */
function scheduleGreen(status: OpsStatus, { schedules, scheduleSources }: ClearReadings): boolean {
  const found = schedules?.find((one) => opsStatusKey("schedule", one.id) === status.key);
  if (!found || scheduleSources?.some((one) => one.source === found.source && !one.ok)) return false;
  const newest = newestFinished(found);
  return newest?.result === "ok" && !!newest.at && after(newest.at, status.since);
}

/** The records to set fixed now, each with the note it is set with ("merged", "closed" or "merged or closed", or its own for a green run). */
export function staleRecords(statuses: readonly OpsStatus[], readings: ClearReadings): { status: OpsStatus; note?: string }[] {
  const due: { status: OpsStatus; note?: string }[] = [];
  for (const status of statuses) {
    if (!clears(status)) continue;
    const end = status.kind === "pr" ? prEnd(status, readings) : null;
    if (end) due.push({ status, note: end });
    else if ((status.kind === "ci" && ciGreen(status, readings)) || (status.kind === "schedule" && scheduleGreen(status, readings)) || readings.backlogGreen?.(status)) {
      due.push({ status });
    }
  }
  return due;
}
