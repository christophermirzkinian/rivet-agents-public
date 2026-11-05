import type { WorkflowRun } from "./ops.js";
import type { OpsStatus, OpsStatusKind } from "./ops-status.js";
import { opsStatusKey } from "./ops-status-key.js";
import { NO_REPO } from "./repos.js";
import type { Worker } from "./workers.js";

// Whether someone is on a failed Ops item, the one test the app's Rivet, menu count and Ops mark use and the server's
// briefing and push alerts use too. Kept free of zod and of app state: each side passes its own
// statuses and live crew.

/** What the test reads of a failed item: its record's kind and key, and a PR's repo, branch and draft. */
export interface OwnedItem {
  kind: OpsStatusKind;
  key: string;
  repo: string;
  /** A PR's head branch: the live chat with it checked out is on the PR. */
  branch?: string;
  /** A PR still a draft: of PRs, only a draft can be parked. */
  draft?: boolean;
}

/**
 * Who an automatic handler's record is by (bridge rerun-guard.mjs HANDLER_BY). It keeps pick-up off while the handler
 * waits, but nobody is fixing anything: the red stays in the counts, and its result is the handler's log, not a card.
 */
export const HANDLER_BY = "rivet-handler";

/** A record saying work is under way, named or not. */
export function underWay(status: Pick<OpsStatus, "state"> | null): boolean {
  return status?.state === "investigating" || status?.state === "in-progress";
}

/** The item's record, else null. `since` is when the item's current trouble began: a record set before it is about an earlier break. */
export function recordOf(item: OwnedItem, statuses: readonly OpsStatus[] | null | undefined, since?: string): OpsStatus | null {
  const status = statuses?.find((one) => one.kind === item.kind && one.key === item.key) ?? null;
  return status && since && Date.parse(status.updatedAt) < Date.parse(since) ? null : status;
}

/**
 * An item you parked (its record says parked): no break, a calm "Parked" line. A ready PR is never parked, whatever its
 * record says. Nor is a workflow red on main: it has no trouble start, so a parked record would hide every later red on
 * main with nothing to end it.
 */
export function isParked(item: OwnedItem, status: OpsStatus | null): boolean {
  if (status?.state !== "parked" || item.kind === "ci") return false;
  return item.kind !== "pr" || item.draft === true;
}

/**
 * The live chat whose worktree has the item's branch checked out. It counts only when no record says work is under way,
 * named or not, or that you parked the item: a record says more. `workers` is the live crew, none when it has lapsed.
 */
export function branchHolder(item: OwnedItem, status: OpsStatus | null, workers: readonly Worker[]): string | null {
  if (!item.branch || isParked(item, status) || underWay(status)) return null;
  // A chat waiting on you or idle with the branch checked out is not fixing it.
  return workers.find((worker) => worker.repo === item.repo && worker.branch === item.branch && worker.state === "working")?.chat ?? null;
}

/** Someone is fixing the item: a record says work is under way, or a working chat holds its branch. */
export function isFixing(item: OwnedItem, status: OpsStatus | null, workers: readonly Worker[]): boolean {
  return (underWay(status) && status?.by !== HANDLER_BY) || branchHolder(item, status, workers) !== null;
}

/**
 * Someone is on the item, or it is parked: it is no break to wake you for, so the counts, marks, Rivet, the
 * briefing, push alerts, the quiet-hours digest, the failing-schedule card and the Morning card leave it out and say it
 * calmly.
 */
export function isOwned(item: OwnedItem, status: OpsStatus | null, workers: readonly Worker[]): boolean {
  return isFixing(item, status, workers) || isParked(item, status);
}

/** A workflow red on main, as its record keys it. */
export function ciOwnedItem(run: Pick<WorkflowRun, "workflow" | "repo">): OwnedItem {
  return { kind: "ci", key: opsStatusKey("ci", run.workflow, run.repo), repo: run.repo };
}

/** An app down or with a failed Fly release, by its id on the Ops list. */
export function appOwnedItem(id: string): OwnedItem {
  return { kind: "app", key: opsStatusKey("app", id), repo: NO_REPO };
}

/** A schedule failing, by its id; a schedule has no branch, so only its record can say someone is on it. */
export function scheduleOwnedItem(id: string): OwnedItem {
  return { kind: "schedule", key: opsStatusKey("schedule", id), repo: NO_REPO };
}

/** The Mac's red faults (memory, the bridge, its runners), under one record. */
export function macOwnedItem(): OwnedItem {
  return { kind: "machine", key: "mac", repo: NO_REPO };
}

/** A Mac volume nearly full, by its label. */
export function diskOwnedItem(label: string): OwnedItem {
  return { kind: "disk", key: opsStatusKey("disk", label), repo: NO_REPO };
}
