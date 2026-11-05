import { z } from "zod";

import { CHAT_PATTERN, MAX_ETA_MINUTES, type ComingStage, type Progress } from "./board.js";
import { REPO_RE } from "./repos.js";

// The bridge's worker snapshot: metadata about agent terminals only. Strict
// objects, so a field the bridge must never send (terminal output, a preview,
// a title) is rejected rather than stored. `busy` is the one thing read from a
// title: its leading status glyph, reduced to a boolean on the Mac.

/** A hash of the worktree id; the id itself embeds a local path and stays on the Mac. */
export const WORKER_ID_PATTERN = /^[0-9a-f]{16}$/;
export const AGENT_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;
/**
 * A git branch name as the bridge sends it (a worktree's checkout, a PR's head): git's own ref rules, so nothing
 * path-shaped (no leading /, . or -, no //, /. or ..). bridge/lib/workers.mjs and ops/github.mjs mirror it.
 */
export const BRANCH_PATTERN = /^(?![/.-])(?!.*(?:\.\.|\/\/|\/\.|\/$|\.lock$))[A-Za-z0-9._/-]{1,200}$/;
export const MAX_WORKERS = 300;
export const MAX_PUSH_QUEUE = 200;
export const WORKING_MS = 2 * 60_000;
/** A spinner glyph with no output for this long is a hung title, not work. */
export const HUNG_MS = 10 * 60_000;
/** A board chat's typed doing, blocked and progress count for this long after a write last touched its row. */
export const TYPED_FRESH_MS = 24 * 3600_000;
/** Six missed 20 s bridge pushes: the Mac is gone, so nobody on it counts as live. */
export const SNAPSHOT_STALE_MS = 2 * 60_000;

export const snapshotWorkerSchema = z
  .object({
    worktreeId: z.string().regex(WORKER_ID_PATTERN),
    repo: z.string().regex(REPO_RE),
    chat: z.string().regex(CHAT_PATTERN),
    connected: z.boolean(),
    lastOutputAt: z.number().int().nonnegative().max(8_640_000_000_000_000).nullable(),
    agent: z.string().regex(AGENT_PATTERN),
    /** The agent's terminal title glyph: a spinner is true, ✳ is false; null when no title shows either. */
    busy: z.boolean().nullable().optional(),
    /** The branch checked out in the worktree; absent when detached or unreadable. */
    branch: z.string().regex(BRANCH_PATTERN).optional(),
    /** When the worktree was made (epoch ms): the chat's start; absent when the reader did not say. */
    startedAt: z.number().int().nonnegative().max(8_640_000_000_000_000).optional(),
    /** The repo its work is in, as the bridge read its clone or brief on the Mac; absent when it could not tell. */
    workRepo: z.string().regex(REPO_RE).optional(),
  })
  .strict();

/** A chat's place in the push queue (scripts/push-queue.mjs), as the bridge reads it: `position` counts from 1, in release order. */
export const pushQueueRowSchema = z
  .object({
    chat: z.string().regex(CHAT_PATTERN),
    repo: z.string().regex(REPO_RE),
    branch: z.string().regex(BRANCH_PATTERN).optional(),
    pr: z.number().int().positive().optional(),
    position: z.number().int().positive(),
    at: z.number().int().positive(),
  })
  .strict();

export const workerSnapshotSchema = z
  .object({ workers: z.array(snapshotWorkerSchema).max(MAX_WORKERS), pushQueue: z.array(pushQueueRowSchema).max(MAX_PUSH_QUEUE).optional() })
  .strict()
  .superRefine((snapshot, ctx) => {
    const seen = new Set<string>();
    snapshot.workers.forEach((worker, index) => {
      if (seen.has(worker.worktreeId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workers", index, "worktreeId"], message: "duplicate worktreeId" });
      }
      seen.add(worker.worktreeId);
    });
  });

export type SnapshotWorker = z.infer<typeof snapshotWorkerSchema>;
export type WorkerSnapshot = z.infer<typeof workerSnapshotSchema>;
export type PushQueueRow = z.infer<typeof pushQueueRowSchema>;

export type WorkerState = "working" | "waiting" | "blocked" | "idle";
export type BoxFrom = "set" | "pr" | "folder";

/** A board chat whose state reads like this is stuck; the Chats list shows it red while its terminal is quiet. */
export const BLOCKED_PATTERN = /\b(block(ed|ing)?|stuck|fail(ed|ing|s)?|red|error|broken)\b/i;

export interface Worker extends Progress {
  id: string;
  name: string;
  repo: string;
  chat: string;
  /** The repo whose box it sits in, when that is not `repo`: PR links, asks and logs stay on `repo`. */
  project?: string;
  /** Where its box came from: its board chat's project, the repo of its ask's PRs, or the folder the bridge read. */
  boxFrom?: BoxFrom;
  /** None of those said: its box is its worktree's repo, a guess. */
  boxGuess?: true;
  state: WorkerState;
  lastOutputAt: number | null;
  /** The title glyph the bridge read: a spinner is true, ✳ false; absent when it read neither. */
  busy?: boolean;
  /** The branch checked out in its worktree: Ops reads a PR on that branch as this chat's. */
  branch?: string;
  /** The agent running in it ("claude", "codex"). */
  agent?: string;
  /** When the chat started (epoch ms): its worktree was made. */
  startedAt?: number;
  doing?: string;
  /** Its short title (src/shared/short-titles.ts), from what it is at; GET /api/workers sets it. */
  short?: string;
  /** The PRs the chat's board entry lists. */
  prs?: number[];
  /** When the chat's board entry last moved on (ISO): how long it has been at what it is doing. */
  movedAt?: string;
  /** The Coming item the chat is delivering: its PR, title and stage. */
  delivering?: { pr?: number; title: string; stage?: ComingStage };
  /** Working, with a card open for you: the Chats list keeps it green and adds a "!" badge. */
  needsYou?: true;
  rivet?: true;
}

/**
 * A chat's pill fields, read defensively: the web app reads the board as JSON, so a field of the wrong type or out
 * of range is dropped or clamped here rather than trusted to the schema.
 */
export function chatStatus(chat: Partial<Record<keyof Progress, unknown>>): Progress {
  const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const status: Progress = {};
  const what = text(chat.what, 200);
  if (what) status.what = what;
  const progress = num(chat.progress);
  if (progress !== undefined) status.progress = Math.min(Math.max(progress, 0), 1);
  const eta = num(chat.etaMinutes);
  if (eta !== undefined) status.etaMinutes = Math.min(Math.max(Math.round(eta), 0), MAX_ETA_MINUTES);
  if (typeof chat.updatedAt === "string" && Number.isFinite(Date.parse(chat.updatedAt))) status.updatedAt = chat.updatedAt;
  const stage = text(chat.stage, 40);
  if (stage) status.stage = stage;
  return status;
}

export interface WorkersResponse {
  /** When the bridge last sent a snapshot; null before the first one. */
  at: string | null;
  workers: Worker[];
  /** The push queue at that snapshot, in release order; absent while it is empty. */
  pushQueue?: PushQueueRow[];
}
