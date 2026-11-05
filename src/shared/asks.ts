import { z } from "zod";

import { ID_PATTERN, isRealTime } from "./board.js";
import { REPO_RE } from "./repos.js";

// Your asks, one record each: the spine every screen, card and push reads.

export const ASK_ID_PATTERN = /^[a-z0-9-]{1,40}$/;
/** Where an ask is, in order; shipped, parked and done are finished. One enum for every surface. */
export const ASK_STAGES = ["queued", "building", "push-queue", "review", "needs-you", "merging", "deploying", "shipped", "parked", "done"] as const;
export const FINISHED_STAGES = ["shipped", "parked", "done"] as const;
export const ASK_WHO = ["owner", "rivet"] as const;
export const MAX_ASK_WORDS = 4000;
/** Room for a long status text. */
export const MAX_ASK_NOTE = 2000;
export const MAX_ASK_CHAT = 300;
export const MAX_ASK_PRS = 50;
export const MAX_ASK_WHY = 200;
export const MAX_ASK_SOURCE = 200;
/** Older events drop off the front past this. */
export const MAX_ASK_TIMELINE = 100;
/** Older moves drop off the front past this, so a count of moves stops here (moved twice reads only the last two). */
export const MAX_DUE_HISTORY = 50;
/** A new time this close to the promised one, or sooner, restates the promise rather than moving it. */
export const DUE_SLACK_MS = 10 * 60_000;
/** A week: a time further out is a guess, not a promise. */
export const MAX_DUE_AHEAD_MS = 7 * 86_400_000;
/** POST /api/asks answers 507 once the store holds this many. */
export const MAX_ASKS = 5000;
/** The most asks one GET /api/asks answers with. */
export const ASK_PAGE_MAX = 500;
/** Finished asks stay in the default list this long after their last stage change. */
export const ASK_DONE_DAYS = 3;

export type AskStage = (typeof ASK_STAGES)[number];
export type AskWho = (typeof ASK_WHO)[number];

export const isFinished = (stage: AskStage): boolean => (FINISHED_STAGES as readonly string[]).includes(stage);

// C0, DEL, C1 and the bidi overrides; words and notes may still break lines.
const LINE = /^[^\x00-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]+$/;
const TEXT = /^[^\x00-\x09\x0b-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]+$/;
const time = z.string().datetime({ offset: true }).refine(isRealTime, "a time with an offset within ±14:00");
const words = z.string().min(1).max(MAX_ASK_WORDS).regex(TEXT, "words hold no control characters").refine((text) => text.trim() !== "", "words must not be blank");
const note = z.string().min(1).max(MAX_ASK_NOTE).regex(TEXT, "a note holds no control characters").refine((text) => text.trim() !== "", "a note must not be blank");
const why = z.string().min(1).max(MAX_ASK_WHY).regex(LINE, "a why is one line").refine((text) => text.trim() !== "", "a why must not be blank");
const source = z.string().min(1).max(MAX_ASK_SOURCE).regex(LINE);
const chat = z.string().max(MAX_ASK_CHAT).regex(LINE);
const by = z.string().max(100).regex(LINE);
const repo = z.string().regex(REPO_RE);
const number = z.number().int().positive().max(1_000_000_000);
const progress = z.number().min(0).max(1);
const stage = z.enum(ASK_STAGES);
const cardId = z.string().regex(ID_PATTERN);

export const askEventSchema = z
  .object({ at: time, stage: stage.optional(), note: note.optional(), by: by.optional() })
  .strict();

/** One move of the promised time: `was` is the time it replaced, `why` the reason given. */
export const dueMoveSchema = z.object({ at: time, dueAt: time, was: time, why: why.optional() }).strict();

export const askSchema = z
  .object({
    id: z.string().regex(ASK_ID_PATTERN),
    words,
    who: z.enum(ASK_WHO),
    /** Where the ask came from: `message:<id>` or `backlog:<repo>#<issue>`. */
    source: source.optional(),
    replyId: z.string().regex(ID_PATTERN).optional(),
    cardId: cardId.optional(),
    stage,
    chat: chat.optional(),
    prs: z.array(number).max(MAX_ASK_PRS),
    repo: repo.optional(),
    issue: number.optional(),
    /** Overall, 0 to 1, as the chat last said. */
    progress: progress.optional(),
    /** The promised done-by, absolute. */
    dueAt: time.optional(),
    dueHistory: z.array(dueMoveSchema).max(MAX_DUE_HISTORY),
    /** The reason for the current time, one line. */
    why: why.optional(),
    /** When the server asked the chat for a new time, the due one having passed; cleared by a new time. */
    askedForTimeAt: time.optional(),
    timeline: z.array(askEventSchema).max(MAX_ASK_TIMELINE),
    createdAt: time,
    /** The last stage change; it outlives the timeline's oldest events. */
    stageAt: time,
    updatedAt: time,
    version: z.number().int().positive(),
  })
  .strict();

/** The fields create and change share. `due` is a time to promise; `dueAt` on an ask is the server's. */
const shared = {
  words: words.optional(),
  who: z.enum(ASK_WHO).optional(),
  source: source.optional(),
  stage: stage.optional(),
  chat: chat.optional(),
  repo: repo.optional(),
  issue: number.optional(),
  progress: progress.optional(),
  due: time.optional(),
  why: why.optional(),
  note: note.optional(),
  by: by.optional(),
};

/**
 * POST /api/asks. `createdAt` (an import's date) and `note` start the timeline. `from` is the id of the message the ask
 * answers: the server takes its words from it when `words` is left out, and keeps it as `replyId` and `source`.
 */
export const askCreateSchema = z
  .object({
    id: z.string().regex(ASK_ID_PATTERN),
    ...shared,
    from: z.string().regex(ID_PATTERN).optional(),
    replyId: z.string().regex(ID_PATTERN).optional(),
    cardId: cardId.optional(),
    prs: z.array(number).max(MAX_ASK_PRS).default([]),
    createdAt: time.optional(),
  })
  .strict();

/**
 * PATCH /api/asks/:id. A null removes an optional field; `prs` are added to the ask's; `note` appends an event; `due`
 * promises a time (a later one is a move and needs `why`).
 */
export const askPatchSchema = z
  .object({
    ...shared,
    source: source.nullable().optional(),
    replyId: z.string().regex(ID_PATTERN).nullable().optional(),
    cardId: cardId.nullable().optional(),
    chat: chat.nullable().optional(),
    prs: z.array(number).max(MAX_ASK_PRS).optional(),
    repo: repo.nullable().optional(),
    issue: number.nullable().optional(),
    progress: progress.nullable().optional(),
    due: time.nullable().optional(),
    why: why.nullable().optional(),
  })
  .strict();

export type AskEvent = z.infer<typeof askEventSchema>;
export type DueMove = z.infer<typeof dueMoveSchema>;
/** `short` is served, never stored: the row's short title, from GET /api/asks. */
export type Ask = z.infer<typeof askSchema> & { short?: string };
export type AskCreate = z.infer<typeof askCreateSchema>;
export type AskPatch = z.infer<typeof askPatchSchema>;

/** How many times the promised time has moved later. */
export const moves = (ask: Pick<Ask, "dueHistory">): number => ask.dueHistory.length;

/** GET /api/asks. Each ask carries only its last timeline event; `next` is the `before` of the following page. */
export interface AsksResponse {
  /** Each open list's ask carries its short title (src/shared/short-titles.ts); `all=1` pages leave it out. */
  asks: (Ask & { short?: string })[];
  next?: string;
}
