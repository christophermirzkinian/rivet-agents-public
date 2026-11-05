import { askMoves, sameRepo, type MergedReading, type StageReadings } from "../../shared/ask-stages.js";
import { isFinished, MAX_ASKS, type Ask, type AskStage } from "../../shared/asks.js";
import type { BacklogRepo } from "../../shared/backlog.js";
import { GITHUB_STALE_MS, type GithubSnapshot, type MergedPr } from "../../shared/ops.js";
import { NO_REPO } from "../../shared/repos.js";
import { SNAPSHOT_STALE_MS, type Worker } from "../../shared/workers.js";
import { isStale } from "../ops/view.js";
import { patched } from "../routes/asks.js";
import type { Store } from "../store.js";

/** The readings as they stand: a queue from a lapsed snapshot, or PRs from a lapsed or failed GitHub reading, say nothing. */
export function stageReadings(store: Pick<Store, "getWorkers">, github: GithubSnapshot | null, merged: readonly MergedPr[] | null, now: Date): StageReadings {
  const stored = store.getWorkers();
  const failed = new Set(github?.sources?.prs.failed ?? []);
  return {
    queue: stored && now.getTime() - Date.parse(stored.at) <= SNAPSHOT_STALE_MS ? (stored.snapshot.pushQueue ?? []) : [],
    prs: github && !isStale(github.at, GITHUB_STALE_MS, now) ? github.prs.filter((pr) => !failed.has(pr.repo.split("/").pop() ?? pr.repo)) : [],
    merged: (merged ?? []).map((pr): MergedReading => ({ repo: pr.repo, number: pr.number, ...(pr.branch ? { branch: pr.branch } : {}), at: pr.mergedAt })),
  };
}

/**
 * Moves the asks' stages by what the bridge just read. Writes only what changes, with no card, update or time: a hand
 * `rivet ask set` still works.
 */
export function syncAskStages(store: Pick<Store, "listAsks" | "replaceAsk">, workers: readonly Worker[], readings: StageReadings, now: Date): void {
  for (const { ask, stage, pr } of askMoves(store.listAsks({ limit: MAX_ASKS, doneSince: now.toISOString() }), workers, readings)) {
    store.replaceAsk(patched(ask, { ...(stage !== undefined ? { stage, by: "rivet" } : {}), ...(pr !== undefined ? { prs: [pr] } : {}) }, now), ask.version);
  }
}

export interface IssueCloseMove {
  ask: Ask;
  stage: Extract<AskStage, "done" | "parked">;
  note: string;
}

/**
 * A Start work ask whose issue the backlog reading shows closed: done when the issue was completed, parked when it was
 * closed as not planned or a duplicate. Only an unfinished ask moves, never one that needs you (as askMoves); one with
 * no reading stays.
 */
export function issueCloseMoves(asks: readonly Ask[], repos: readonly Pick<BacklogRepo, "repo" | "closed">[]): IssueCloseMove[] {
  return asks.flatMap((ask): IssueCloseMove[] => {
    if (isFinished(ask.stage) || ask.stage === "needs-you" || ask.issue === undefined || !ask.source?.startsWith("backlog:")) return [];
    const repo = ask.repo ?? NO_REPO;
    const closed = repos.find((one) => sameRepo(one.repo, repo))?.closed?.find((one) => one.number === ask.issue);
    if (!closed) return [];
    const completed = closed.reason === "completed";
    const how = completed ? "" : closed.reason === "duplicate" ? " as a duplicate" : " as not planned";
    return [{ ask, stage: completed ? "done" : "parked", note: `Issue #${closed.number} closed${how}` }];
  });
}

/** Finishes the asks whose issues the bridge just read closed, Rivet's own move, with no card, update or time. */
export function syncIssueCloses(store: Pick<Store, "listAsks" | "replaceAsk">, repos: readonly Pick<BacklogRepo, "repo" | "closed">[], now: Date): void {
  if (!repos.some((one) => one.closed?.length)) return;
  for (const { ask, stage, note } of issueCloseMoves(store.listAsks({ limit: MAX_ASKS, doneSince: now.toISOString() }), repos)) {
    store.replaceAsk(patched(ask, { stage, note, by: "rivet" }, now), ask.version);
  }
}
