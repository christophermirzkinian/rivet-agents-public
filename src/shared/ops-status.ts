import { z } from "zod";

import { dueMoveSchema, MAX_DUE_HISTORY } from "./asks.js";
import { CHAT_PATTERN, isRealTime } from "./board.js";
import { isRepo } from "./repos.js";

// What is being done about each failed thing on Ops: one record per item, keyed by its kind and key. Rivet (the
// monitor) writes them with the board token; the app reads them and shows each as a pill on the failed item.

/**
 * ci: a workflow red on main, keyed by its name. pr: an open PR whose checks fail, keyed by its number. app: an app that
 * is down or whose last Fly release failed, keyed by its id on the Ops list. machine: the Mac ("mac") showing a fault.
 * runner: a CI runner listed offline, keyed by its name. disk: a Mac volume nearly full, keyed by its label. push: notifications reaching no phone, keyed "phones". schedule: a schedule that is on and
 * whose last run failed, keyed by its id (an id holds ":", so its key is a slug and hash). coming: a Coming item started
 * from its sheet, keyed by its PR number, else its title. ops-status-key.ts turns a name into
 * a key: "my-app", "2965", "other-repo/12", or for a name that is not already a plain slug its slug and a hash ("CI" is
 * "ci_0zh2u01", "Lint API" "lint-api_1odr8is").
 */
export const OPS_STATUS_KINDS = ["ci", "pr", "app", "machine", "runner", "disk", "push", "schedule", "coming"] as const;
/**
 * backlog: nobody is on it yet, so it stays red. parked: you parked it on purpose, so it is a calm line, not a break, and
 * the auto pick-up leaves it; a parked record on a ci item or a ready PR changes nothing (ops-owned.ts isParked).
 */
export const OPS_STATUS_STATES = ["investigating", "in-progress", "backlog", "parked", "fixed"] as const;
export const OPS_STATUS_KEY_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,99}$/;
export const MAX_OPS_STATUS_NOTE = 1000;
export const MAX_OPS_STATUS_ETA = 100;
/** Late work set fixed says what held it up and what stops it happening again, each one short line. */
export const MAX_OPS_STATUS_CAUSE = 100;
export const MAX_OPS_STATUS_PREVENT = 100;
/** PUT answers 507 once the store holds this many. */
export const MAX_OPS_STATUSES = 500;
/** A fixed record is deleted this long after its last change; any other record stays until it is cleared. */
export const OPS_STATUS_FIXED_DAYS = 7;
/** A write's why: work under way says why it takes until its done-by, in one short line. */
export const MAX_OPS_STATUS_WHY = 140;

export type OpsStatusKind = (typeof OPS_STATUS_KINDS)[number];
export type OpsStatusState = (typeof OPS_STATUS_STATES)[number];

// C0, DEL, C1 and the bidi overrides; a note may still break lines.
const LINE = /^[^\x00-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]+$/;
const TEXT = /^[^\x00-\x09\x0b-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]+$/;
const time = z.string().datetime({ offset: true }).refine(isRealTime, "a time with an offset within ±14:00");
const note = z.string().min(1).max(MAX_OPS_STATUS_NOTE).regex(TEXT, "a note holds no control characters").refine((text) => text.trim() !== "", "a note must not be blank");
const eta = z.string().min(1).max(MAX_OPS_STATUS_ETA).regex(LINE, "an eta is one line").refine((text) => text.trim() !== "", "an eta must not be blank");
const cause = z.string().min(1).max(MAX_OPS_STATUS_CAUSE).regex(LINE, "a cause is one line").refine((text) => text.trim() !== "", "a cause must not be blank");
const prevent = z.string().min(1).max(MAX_OPS_STATUS_PREVENT).regex(LINE, "a prevent line is one line").refine((text) => text.trim() !== "", "a prevent line must not be blank");
const chat = z.string().regex(CHAT_PATTERN);
const by = z.string().max(100).regex(LINE);
const number = z.number().int().positive().max(1_000_000_000);
const repo = z.string().refine(isRepo, "repo is not an owner/name");
const why = z.string().min(1).max(MAX_OPS_STATUS_WHY).regex(LINE, "a why is one line").refine((text) => text.trim() !== "", "a why must not be blank");

export const opsStatusSchema = z
  .object({
    kind: z.enum(OPS_STATUS_KINDS),
    key: z.string().regex(OPS_STATUS_KEY_PATTERN),
    state: z.enum(OPS_STATUS_STATES),
    note: note.optional(),
    eta: eta.optional(),
    /** When the work is due, from its done-by time. */
    dueAt: time.optional(),
    /** Why it takes until then. */
    why: z.string().min(1).max(200).regex(LINE).optional(),
    /**
     * When Rivet last asked the record's chat for a new time, its dueAt passed (ops/late.ts), or the auto pick-up found
     * it with nobody on it; never written by a writer. A record that has it ran late.
     */
    askedForTimeAt: time.optional(),
    /** Each later done-by a writer gave, as an ask keeps them: Rivet's own, never written by a writer. */
    dueHistory: z.array(dueMoveSchema).max(MAX_DUE_HISTORY).optional(),
    /** What held a Late record up, and the "So it stops:" line the Plan page shows; both are needed to set it fixed. */
    cause: cause.optional(),
    prevent: prevent.optional(),
    chat: chat.optional(),
    /** The repo of the chat it names: a chat name recurs across repos. None from a writer that did not say. */
    repo: repo.optional(),
    pr: number.optional(),
    issue: number.optional(),
    /** When the failure started: given by the writer, or the first write. */
    since: time,
    updatedAt: time,
    by: by.optional(),
    version: z.number().int().positive(),
  })
  .strict();

/**
 * PUT /api/ops/status/:kind/:key: creates the record or changes it. A null removes an optional field. investigating and
 * in-progress need `eta` (minutes, a clock time, "tonight" or an ISO time: the server sets `dueAt` from it) and
 * `why`; the server writes "by 3:30pm" into `eta` beside each `dueAt`.
 */
export const opsStatusPutSchema = z
  .object({
    state: z.enum(OPS_STATUS_STATES),
    note: note.nullable().optional(),
    eta: eta.nullable().optional(),
    cause: cause.nullable().optional(),
    prevent: prevent.nullable().optional(),
    chat: chat.nullable().optional(),
    /** The chat's repo; a write naming a chat and no repo drops the old chat's. */
    repo: repo.nullable().optional(),
    pr: number.nullable().optional(),
    issue: number.nullable().optional(),
    why: why.nullable().optional(),
    since: time.optional(),
    by: by.optional(),
    /**
     * `rivet fix`'s rollback when its chat did not open: the record's own done-by (at most 7 days out), the time it was
     * asked for a new one and its moves, put back as given; a fixed record put back this way needs no cause.
     */
    restore: z.object({ dueAt: time.optional(), askedForTimeAt: time.optional(), updatedAt: time.optional(), dueHistory: z.array(dueMoveSchema).max(MAX_DUE_HISTORY).optional() }).strict().optional(),
  })
  .strict();

export type OpsStatus = z.infer<typeof opsStatusSchema>;
export type OpsStatusPut = z.infer<typeof opsStatusPutSchema>;

/** A record as stored before askedForTimeAt, when its late marker was `lateSince`, in today's shape. */
export function upgradeOpsStatus(raw: Record<string, unknown>): OpsStatus {
  if (!("lateSince" in raw)) return raw as unknown as OpsStatus;
  const { lateSince, ...rest } = raw;
  return { ...rest, ...(rest.askedForTimeAt === undefined && typeof lateSince === "string" ? { askedForTimeAt: lateSince } : {}) } as unknown as OpsStatus;
}

/** GET /api/ops/status: every record, newest change first. */
export interface OpsStatusResponse {
  statuses: OpsStatus[];
}
