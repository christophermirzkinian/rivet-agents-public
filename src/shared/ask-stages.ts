import { isFinished, MAX_ASK_PRS, type Ask, type AskStage } from "./asks.js";
import { NO_REPO } from "./board.js";
import type { PushQueueRow, Worker } from "./workers.js";

/** An open PR as the bridge reads it. */
export interface PullRequest {
  repo: string;
  number: number;
  draft: boolean;
  branch?: string;
}

/** A merged PR as either side reads it: the server its merged list, the phone Ops' timeline (whose repo is the short name). */
export interface MergedReading {
  repo: string;
  number: number;
  branch?: string;
  at: string;
}

/** What the bridge's readings say is under way. */
export interface StageReadings {
  queue: readonly PushQueueRow[];
  /** The open PRs. */
  prs: readonly PullRequest[];
  merged: readonly MergedReading[];
}

export interface StageSignal {
  stage: Extract<AskStage, "push-queue" | "review" | "deploying">;
  /** The PR it joined by, for the ask's own list. */
  pr?: number;
  entry?: PushQueueRow;
  open?: PullRequest;
  merged?: MergedReading;
}

/** What to join on: a chat and the branch it has out, the PRs named (the first repo's), and the repos they may be in. */
export interface StageSubject {
  chat?: string;
  repos: readonly string[];
  prs: readonly number[];
  branch?: string;
  /** A merge before this is an earlier job's: its checkout's, or a PR the ask names for context. */
  since?: string;
}

export const sameRepo = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

/**
 * Where a piece of work is by the readings, first that holds: in the queue, its open non-draft PR, that PR
 * merged; null with no signal, when a stored stage stays.
 */
export function stageSignal(on: StageSubject, readings: StageReadings): StageSignal | null {
  const here = (repo: string) => on.repos.some((one) => sameRepo(one, repo));
  const entry = on.chat === undefined ? undefined : readings.queue.find((row) => row.chat === on.chat && here(row.repo));
  const onBranch = (branch?: string) => branch !== undefined && (branch === on.branch || branch === entry?.branch);
  // A named PR is the first repo's (the ask's, or the chat's with no ask); the queue entry's is the entry's own repo's.
  const named = (number: number, repo: string) => (on.prs.includes(number) && sameRepo(repo, on.repos[0] ?? repo)) || (entry?.pr === number && sameRepo(repo, entry.repo));
  const open = readings.prs.filter((pr) => !pr.draft && here(pr.repo) && (named(pr.number, pr.repo) || onBranch(pr.branch)));
  const pr = open[0];
  if (entry) {
    const number = entry.pr ?? pr?.number;
    return { stage: "push-queue", entry, ...(number !== undefined ? { pr: number } : {}), ...(pr ? { open: pr } : {}) };
  }
  if (pr) return { stage: "review", pr: pr.number, open: pr };
  const merged = readings.merged.find((one) => here(one.repo) && (named(one.number, one.repo) || onBranch(one.branch)) && !(on.since && Date.parse(one.at) < Date.parse(on.since)));
  return merged ? { stage: "deploying", pr: merged.number, merged } : null;
}

/** The repo a signal's PR is in, which a PR number alone does not say. */
export const signalRepo = (signal: StageSignal): string | undefined => (signal.entry?.pr !== undefined ? signal.entry.repo : (signal.open?.repo ?? signal.merged?.repo ?? signal.entry?.repo));

/**
 * The repo an ask's PR numbers are in: its own, else its chat's box (`rivet ask set` takes no repo, so a project
 * chat's ask has none): its project, else its worktree's repo; with no live chat, the default.
 */
export const askPrRepo = (ask: Pick<Ask, "repo">, w?: Pick<Worker, "project" | "repo">): NonNullable<Ask["repo"]> =>
  ask.repo ?? w?.project ?? w?.repo ?? NO_REPO;

/** A chat's open asks: its own repo's, else the ones filed under the project it was told (Find more work files by project). */
export function asksOfChat(w: Pick<Worker, "chat" | "repo" | "project">, asks: readonly Ask[]): Ask[] {
  const named = asks.filter((ask) => !isFinished(ask.stage) && ask.chat === w.chat);
  const own = named.filter((ask) => (ask.repo ?? NO_REPO) === w.repo);
  return own.length || !w.project ? own : named.filter((ask) => (ask.repo ?? NO_REPO) === w.project);
}

/** The chat's newest open ask, the row its status line reads. */
export function newestAskOf(w: Pick<Worker, "chat" | "repo" | "project">, asks: readonly Ask[]): Ask | undefined {
  return asksOfChat(w, asks).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

/** The chat's connected terminal an ask belongs to, by the asks' repo rule. */
export const workerOfAsk = <W extends Pick<Worker, "chat" | "repo" | "project">>(ask: Pick<Ask, "chat" | "repo">, workers: readonly W[]): W | undefined => {
  const repo = ask.repo ?? NO_REPO;
  return workers.find((w) => w.chat === ask.chat && (w.repo === repo || w.project === repo));
};

export interface AskMove {
  ask: Ask;
  stage?: AskStage;
  pr?: number;
}

/**
 * What the readings change on the asks: only a chat's newest open ask, or an ask of no chat by the PRs it names, moves.
 * Needs you and the finished stages stay put, and an ask with no signal keeps its stage.
 */
export function askMoves(asks: readonly Ask[], workers: readonly Pick<Worker, "chat" | "repo" | "project" | "branch">[], readings: StageReadings): AskMove[] {
  const open = asks.filter((ask) => !isFinished(ask.stage));
  return open.flatMap((ask): AskMove[] => {
    if (ask.stage === "needs-you") return [];
    const worker = ask.chat === undefined ? undefined : workerOfAsk(ask, workers);
    const repo = askPrRepo(ask, worker);
    if (ask.chat !== undefined && newestAskOf(worker ?? { chat: ask.chat, repo }, open)?.id !== ask.id) return [];
    const signal = stageSignal(
      {
        ...(ask.chat !== undefined ? { chat: ask.chat } : {}),
        // A chat gone from its terminal still has its queue entry's repo, which its project's ask need not name.
        repos: worker ? [repo, worker.repo] : [repo, ...readings.queue.filter((row) => row.chat === ask.chat).map((row) => row.repo)],
        prs: ask.prs,
        ...(worker?.branch !== undefined ? { branch: worker.branch } : {}),
        since: ask.createdAt,
      },
      readings,
    );
    if (!signal) return [];
    const stage = signal.stage !== ask.stage ? signal.stage : undefined;
    // An ask's PR numbers mean its own repo's: a project's ask working in another repo names none of them.
    const inRepo = sameRepo(signalRepo(signal) ?? repo, repo);
    const pr = inRepo && signal.pr !== undefined && !ask.prs.includes(signal.pr) && ask.prs.length < MAX_ASK_PRS ? signal.pr : undefined;
    return stage !== undefined || pr !== undefined ? [{ ask, ...(stage !== undefined ? { stage } : {}), ...(pr !== undefined ? { pr } : {}) }] : [];
  });
}
