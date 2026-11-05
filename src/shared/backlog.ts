import type { Ask } from "./asks.js";

// A project's backlog: the bridge reads each repo's open issues every
// five minutes, titles, numbers and labels only (bridge/lib/ops/backlog.mjs); GET /api/backlog joins the asks not
// started or parked. The same pass reads the issues closed lately, which finish the Yeses on them.

export const BACKLOG_STALE_MS = 20 * 60_000;
/** A backlog reading dated further ahead of the server than this finishes no asks: a wrong bridge clock. */
export const BACKLOG_AHEAD_MS = 2 * 60_000;
export const MAX_BACKLOG_OWNER = 20;
export const MAX_BACKLOG_RECENT = 100;
export const MAX_BACKLOG_BUGS = 20;
export const MAX_BACKLOG_CLOSED = 50;
export const CLOSE_REASONS = ["completed", "not_planned", "duplicate"] as const;
export const MAX_BACKLOG_LABELS = 10;
export const BACKLOG_TITLE_MAX = 300;
export const BACKLOG_LABEL_MAX = 50;
/** Asks of each stage served, newest first. */
export const MAX_BACKLOG_ASKS = 500;

export interface BacklogIssue {
  number: number;
  title: string;
  updatedAt: string;
  labels: string[];
}

/** An issue closed lately, and why: an ask from a Yes on it finishes (src/server/asks/stages.ts). */
export interface ClosedIssue {
  number: number;
  closedAt: string;
  reason: (typeof CLOSE_REASONS)[number];
}

export interface BacklogRepo {
  repo: string;
  /** Open issues, logs too. */
  total: number;
  /** Open issues labelled type:log. */
  logs: number;
  /** Open issues labelled autonomy:owner. */
  ownerTotal: number;
  /** The newest of those, by last update. */
  owner: BacklogIssue[];
  /** The newest open issues, by last update. */
  recent: BacklogIssue[];
  /** The newest open bugs (type:bug or bug), so an older bug still shows. */
  bugs: BacklogIssue[];
  /** The most recently updated closed issues; absent from an older bridge. */
  closed?: ClosedIssue[];
}

/** A repo as the server keeps it: the reading's own time, kept when a later pass could not read the repo. */
export interface StoredBacklogRepo extends BacklogRepo {
  at: string;
}

export interface StoredBacklog {
  at: string;
  repos: StoredBacklogRepo[];
}

/** A repo as served: stale when its own reading is older than BACKLOG_STALE_MS. */
export interface ServedBacklogRepo extends StoredBacklogRepo {
  stale: boolean;
}

export interface BacklogSnapshot {
  at: string;
  repos: BacklogRepo[];
}

export type BacklogAsk = Pick<Ask, "id" | "words" | "short" | "stage" | "repo" | "issue" | "chat" | "why" | "prs" | "createdAt" | "stageAt">;

export interface BacklogResponse {
  /** When the bridge last read GitHub; null before its first reading. */
  at: string | null;
  stale: boolean;
  repos: Partial<Record<BacklogRepo["repo"], ServedBacklogRepo>>;
  /** The asks not started or parked, newest first, up to MAX_BACKLOG_ASKS of each; Start work's are in `started`. */
  asks: BacklogAsk[];
  /** The unfinished asks Start work made; absent from an older server. */
  started?: BacklogStart[];
  /** The issues Close closed in the last hour, or is closing: off the list at once. */
  closing?: { repo: BacklogRepo["repo"]; issue: number }[];
}

// An issue opened in the app: read on tap by the Mac's bridge
// (bridge/lib/actions/issue.mjs), kept here five minutes; Start work makes an ask and labels it, Close closes it as not
// planned with a comment.

export const ISSUE_BODY_MAX = 20_000;
export const ISSUE_KEPT_MS = 5 * 60_000;
/** Close's comment on GitHub. */
export const CLOSE_WORDS = "Closed in Rivet: not needed.";
/** The source of Start work's ask: one unfinished ask per issue. */
export const backlogSource = (repo: string, issue: number): string => `backlog:${repo}#${issue}`;

export interface IssueDetail {
  repo: BacklogRepo["repo"];
  number: number;
  title: string;
  /** Markdown as its author wrote it, redacted and cut to ISSUE_BODY_MAX. */
  body: string;
  author: string | null;
  createdAt: string;
  state: "open" | "closed";
  url: string;
  comments: number;
  labels: string[];
  /** When the bridge read it. */
  at: string;
}

/** An unfinished ask Start work made from an issue. */
export interface BacklogStart {
  repo: BacklogRepo["repo"];
  issue: number;
  ask: string;
  words: string;
  at: string;
  stage: Ask["stage"];
  chat?: string;
}

/** A GitHub write's state as the issue page shows it: waiting until the Mac's bridge has done it. */
export interface IssueWriteState {
  id: string;
  status: "waiting" | "done" | "failed";
  at: string;
  reason?: string;
}

/** GET /api/backlog/issue */
export interface BacklogIssueResponse {
  detail: IssueDetail | null;
  /** The Mac was asked to read it: ask again shortly. */
  pending: boolean;
  start: BacklogStart | null;
  close: IssueWriteState | null;
  /** The chat on the newest unfinished ask naming the issue. */
  chat: string | null;
}
