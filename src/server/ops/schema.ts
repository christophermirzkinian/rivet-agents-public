import { z } from "zod";

import { MAX_CLAUDE_LIMITS } from "../../shared/ops.js";
import { BACKLOG_LABEL_MAX, BACKLOG_TITLE_MAX, CLOSE_REASONS, MAX_BACKLOG_BUGS, MAX_BACKLOG_CLOSED, MAX_BACKLOG_LABELS, MAX_BACKLOG_OWNER, MAX_BACKLOG_RECENT } from "../../shared/backlog.js";
import { isKnownRepo } from "../../shared/repos.js";
import { BRANCH_PATTERN } from "../../shared/workers.js";

// What the bridge may send about GitHub, the Mac, Claude usage and Fly. Every payload is strict,
// capped in rows and field lengths, and carries names and numbers only: no paths,
// no transcript or prompt text. These bounds mirror bridge/lib/ops/*.mjs (ops.test.ts runs the bridge's Claude rows through them).

export const MAX_PRS = 300;
export const MAX_RUNS = 150;
export const MAX_MERGED = 600;
export const MAX_RUNNERS = 50;
export const MAX_VOLUMES = 12;
export const MAX_FLY_APPS = 100;
export const MAX_RELEASES = 30;
export { MAX_CLAUDE_LIMITS };
export const NOTE_MAX = 280;
export const MAX_NOTES = 5;

export const OPS_MAX_BYTES = 512 * 1024;
/** More repos than anyone lists in RIVET_REPOS. */
export const MAX_REPOS = 50;

const iso = z.string().datetime();
const count = z.number().int().nonnegative().max(100_000);
const repo = z.string().refine(isKnownRepo, "repo is not in RIVET_REPOS");
const title = z.string().max(300);
const githubUrl = z.string().max(300).regex(/^https:\/\/github\.com\/[A-Za-z0-9._\/-]+$/);
const login = z.string().regex(/^[A-Za-z0-9-]{1,39}(\[bot\])?$/);
const name = (max: number) => z.string().regex(new RegExp(`^[A-Za-z0-9 ._:()/+-]{1,${max}}$`));
const bytes = z.number().int().nonnegative().max(1e16);
/** Fixed volume names only: a disk's own name never leaves the Mac. */
export const VOLUME_LABEL = /^(System|Data|Runners|External [1-9]\d?)$/;
export const FLY_APP_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const checksSchema = z
  .object({
    state: z.enum(["pass", "fail", "pending", "none"]),
    passed: count,
    failed: count,
    pending: count,
    failing: z.array(z.string().max(120)).max(10),
  })
  .strict();

const prSchema = z
  .object({
    repo,
    number: z.number().int().positive().max(1_000_000_000),
    title,
    url: githubUrl,
    draft: z.boolean(),
    author: login,
    labels: z.array(z.string().max(60)).max(20),
    headAt: iso.nullable(),
    updatedAt: iso,
    branch: z.string().regex(BRANCH_PATTERN).optional(),
    checks: checksSchema,
    headSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    hold: z.string().max(200).optional(),
    holds: z.array(z.string().max(200)).max(20).optional(),
    ciStartedAt: iso.optional(),
  })
  .strict();

const runSchema = z
  .object({
    repo,
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    attempt: z.number().int().positive().max(10_000),
    workflow: z.string().max(120),
    title: z.string().max(200),
    status: z.string().regex(/^[a-z_]{1,30}$/),
    conclusion: z.string().regex(/^[a-z_]{1,30}$/).nullable(),
    event: z.string().regex(/^[a-z_]{1,40}$/),
    sha: z.string().regex(/^[0-9a-f]{7,40}$/),
    url: githubUrl,
    createdAt: iso,
    updatedAt: iso,
    failedJobs: z.array(z.string().max(120)).max(10).optional(),
  })
  .strict();

const sourceSchema = z
  .object({ failed: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,100}$/)).max(MAX_REPOS), at: iso.nullable() })
  .strict();

const mergedSchema = z
  .object({ repo, number: z.number().int().positive().max(1_000_000_000), title, url: githubUrl, mergedAt: iso, mergeSha: z.string().regex(/^[0-9a-f]{40}$/).optional(), author: login, branch: z.string().regex(BRANCH_PATTERN).optional() })
  .strict();

const closedSchema = z.object({ repo, number: z.number().int().positive().max(1_000_000_000), closedAt: iso }).strict();

/** One plain line: no control characters, so a row cannot break the layout or carry hidden text. */
const line = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]*$/);

export const githubSnapshotSchema = z
  .object({
    at: iso,
    prs: z.array(prSchema).max(MAX_PRS),
    prsComplete: z.boolean().optional(),
    runs: z.array(runSchema).max(MAX_RUNS),
    runners: z
      .object({
        complete: z.boolean().optional(),
        detailsComplete: z.boolean().optional(),
        online: count,
        busy: count,
        offline: count,
        runners: z
          .array(z.object({ name: name(64), status: z.enum(["online", "offline"]), busy: z.boolean() }).strict())
          .max(MAX_RUNNERS),
      })
      .strict()
      .nullable(),
    queue: z.object({ queuedRuns: count, runningRuns: count, queuedJobs: count, runsComplete: z.boolean().optional(), jobsComplete: z.boolean().optional(), sampledRuns: count.optional() }).strict().nullable(),
    merged: z.array(mergedSchema).max(MAX_MERGED).nullable(),
    closed: z.array(closedSchema).max(MAX_MERGED).nullable().optional(),
    ciTypicalMin: z.number().int().positive().max(24 * 60).optional(),
    sources: z.object({ prs: sourceSchema, runs: sourceSchema, merged: sourceSchema, runners: sourceSchema, queue: sourceSchema }).strict(),
  })
  .strict();

const backlogIssue = z
  .object({
    number: z.number().int().positive().max(10_000_000),
    title: z.string().max(BACKLOG_TITLE_MAX),
    updatedAt: iso,
    labels: z.array(z.string().max(BACKLOG_LABEL_MAX)).max(MAX_BACKLOG_LABELS),
  })
  .strict();

/** Each repo's open issues: counts, and titles, numbers and labels of the newest. No bodies: PUT /api/bridge/issue takes one. */
export const backlogSnapshotSchema = z
  .object({
    at: iso,
    repos: z
      .array(
        z
          .object({
            repo,
            total: count,
            logs: count,
            ownerTotal: count,
            owner: z.array(backlogIssue).max(MAX_BACKLOG_OWNER),
            recent: z.array(backlogIssue).max(MAX_BACKLOG_RECENT),
            bugs: z.array(backlogIssue).max(MAX_BACKLOG_BUGS),
            closed: z
              .array(z.object({ number: z.number().int().positive().max(10_000_000), closedAt: iso, reason: z.enum(CLOSE_REASONS) }).strict())
              .max(MAX_BACKLOG_CLOSED)
              .optional(),
          })
          .strict(),
      )
      .max(MAX_REPOS),
  })
  .strict();

export const macSnapshotSchema = z
  .object({
    at: iso,
    name: line(64),
    volumes: z
      .array(z.object({ label: z.string().regex(VOLUME_LABEL), totalBytes: bytes, freeBytes: bytes, runners: z.boolean() }).strict())
      .max(MAX_VOLUMES),
    load: z
      .object({
        one: z.number().nonnegative().max(10_000),
        five: z.number().nonnegative().max(10_000),
        fifteen: z.number().nonnegative().max(10_000),
        cpus: z.number().int().positive().max(4096),
      })
      .strict(),
    memory: z.object({ freePct: z.number().min(0).max(100), pressure: z.enum(["normal", "warn", "critical", "unknown"]) }).strict(),
    uptimeSec: z.number().int().nonnegative().max(1e10),
    runners: z.array(z.object({ name: name(64), alive: z.boolean() }).strict()).max(MAX_RUNNERS),
    chatRunner: z.boolean(),
  })
  .strict();

export const claudeUsageSnapshotSchema = z
  .object({
    at: iso,
    limits: z
      .array(
        z
          .object({
            kind: z.string().regex(/^[a-z0-9_]{1,40}$/),
            // The bridge's own label ("Week, all models"): one line of plain text.
            label: z.string().regex(/^[^\u0000-\u001f\u007f-\u009f]{1,60}$/),
            percent: z.number().min(0).max(100),
            severity: z.enum(["normal", "warning", "critical"]),
            resetsAt: iso.nullable(),
            active: z.boolean(),
            // Codex rows only: the account's credit balance, on its longest window's row.
            credits: z.number().min(0).max(1e9).nullable().optional(),
            unlimited: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_CLAUDE_LIMITS),
  })
  .strict();

const releaseSchema = z
  .object({
    sha: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
    patchMerges: z.array(z.string().regex(/^[0-9a-f]{40}$/)).max(MAX_MERGED).optional(),
    version: z.number().int().nonnegative().max(1e9),
    status: z.string().regex(/^[a-z_]{1,30}$/),
    at: iso,
    image: z.string().regex(/^[a-z0-9][a-z0-9._/:@-]{0,199}$/i).optional(),
  })
  .strict();

export const flySnapshotSchema = z
  .object({
    at: iso,
    apps: z
      .array(
        z
          .object({
            app: z.string().regex(FLY_APP_PATTERN),
            status: z.string().regex(/^[a-z_]{0,30}$/),
            version: z.number().int().nonnegative().max(1e9).nullable(),
            sha: z.string().regex(/^[0-9a-f]{7,40}$/).nullable(),
            machines: z.object({ started: count, total: count }).strict(),
            checks: z.object({ passing: count, total: count }).strict(),
            updatedAt: iso.nullable(),
            releases: z.array(releaseSchema).max(MAX_RELEASES),
          })
          .strict(),
      )
      .max(MAX_FLY_APPS),
    source: z.object({ failed: z.array(z.string().regex(FLY_APP_PATTERN)).max(MAX_FLY_APPS), at: iso.nullable() }).strict().optional(),
  })
  .strict();

/** The bridge's word on an event it was sent: whether it reached the chat. */
export const ackSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  delivered: z.boolean(),
});

// A note is one short line of Rivet's, shown as plain text; control characters are refused.
export const briefingNoteSchema = z
  .object({
    text: z
      .string()
      .max(NOTE_MAX)
      .refine((value) => value.trim() !== "", "a note needs text")
      .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value), "a note is one line of plain text"),
  })
  .strict();
