import { ASK, DECISION, isGotIt, isUpdate, MERGE_READY, OUTCOME_OPTIONS, PLAN, QUESTION } from "./answers.js";
import type { Decision, Need, Reply, ServedNeed } from "./board.js";
import type { AskStage } from "./asks.js";
import { NO_REPO } from "./board.js";
import { z } from "zod";

/** How long the server keeps an answered card after it left the feed, for Cards' Answered list and Reopen. */
export const ANSWERED_KEEP_MS = 30 * 24 * 3600_000;

/** The most rows GET /api/answered serves: 30 days of your answers is a few hundred. */
export const MAX_ANSWERED = 500;

/** A Reopen's notice the bridge has not acked is offered again on each connect for this long, then dropped. */
export const REOPEN_NOTICE_MS = 24 * 3600_000;

/** One answered card: the card as you answered it (`card.rev` is that revision) and your answer of record to it, with its delivery. */
export interface AnsweredCard {
  card: ServedNeed;
  reply: Reply;
  /** Its work is finished (answeredDone): out of the list while Show done is off. */
  done?: true;
}

/** The time chips over Answered: the hours of answers each keeps; null keeps all the list holds (30 days). */
export const ANSWERED_WINDOWS = [6, 12, 24, 48, null] as const;
export type AnsweredWindow = (typeof ANSWERED_WINDOWS)[number];
/** Answered opens on 24h until a chip is picked on the device. */
export const DEFAULT_ANSWERED_WINDOW: AnsweredWindow = 24;

/** A PR as `answeredDone` looks it up: `<owner/repo>#<number>`, the repo in lower case. */
export function prKey(repo: string | undefined, pr: number): string {
  return `${(repo ?? NO_REPO).toLowerCase()}#${pr}`;
}

/**
 * The ask stages that finish a card's work for Show done: shipped (deployed) and done. Not `isFinished`: a parked ask stopped
 * without finishing, so its card stays in the list.
 */
export const DONE_ASK_STAGES = ["shipped", "done"] as const satisfies readonly AskStage[];

/** What the server knows of an answered card's work: the PRs that merged (`prKey`), and the cards an ask names that is shipped or done. */
export interface DoneFacts {
  merged: ReadonlySet<string>;
  finishedCards: ReadonlySet<string>;
}

/**
 * Whether an answered card's work is finished, for Show done. Any of: the answer closed it (Done, Dismissed, or an
 * outcome's Yes, keep it); its PR has merged; an ask names it as its card and is shipped or done (`DONE_ASK_STAGES`; parked is not).
 * Never from the title's words.
 */
export function answeredDone({ card, reply }: Pick<AnsweredCard, "card" | "reply">, facts: DoneFacts): boolean {
  if (reply.decision === "done" || reply.decision === "dismiss") return true;
  // An outcome is a decision card; a merge-ready card's option of the same words arms a merge that may not land. The
  // answer's kind too: a card rebuilt from its answer (cardFromReply) is a decision whatever it was.
  if (card.kind === DECISION && (reply.item.kind ?? DECISION) === DECISION && reply.decision === "choice" && (reply.choice ?? "") === OUTCOME_OPTIONS[0]!.label) return true;
  const pr = card.pr ?? reply.item.pr;
  if (pr !== undefined && facts.merged.has(prKey(card.repo ?? reply.item.repo, pr))) return true;
  return facts.finishedCards.has(card.id);
}

/** The answered rows a chip and Show done keep at `now`: answered inside the chip's hours, and not done unless Show done is on. */
export function answeredShown<T extends Pick<AnsweredCard, "reply" | "done">>(cards: readonly T[], window: AnsweredWindow, showDone: boolean, now: number): T[] {
  const since = window === null ? -Infinity : now - window * 3600_000;
  return cards.filter((entry) => Date.parse(entry.reply.at) >= since && (showDone || !entry.done));
}

/**
 * Your Reopen of an answered card, and the notice of it the bridge carries to Rivet's chat, naming the card's chat:
 * `delivery` once the bridge acked it, `error` its last failure.
 */
export interface Reopen {
  id: string;
  /** The answer armed the card's merge, and that PR has merged: a new answer is a follow-up. */
  merged?: true;
  cardId: string;
  /** The reopened revision: the one your new answer lands on. */
  rev: string;
  at: string;
  /** Your answer of record to the revision before. */
  replyId: string;
  /** The card's title, chat and repo as it was reopened: its notice names these, whatever later writes do to the card. */
  title: string;
  chat?: string;
  /** Absent for the default repo. */
  repo?: string;
  /** When Send again offered the notice again; its 24 hours run from then. */
  sentAt?: string;
  delivery?: { at: string; confirmed?: boolean };
  error?: string;
}

/** GET /api/answered: the cards answered in the last 30 days and not open again now, the newest answer first; and the Reopen of each open card that has one. */
export interface AnsweredResponse {
  cards: AnsweredCard[];
  /** `expired`: the notice was never delivered and is no longer offered, so the band says its chat was not told (Send again). */
  reopened: (Reopen & { earlier: Reply | null; expired?: true })[];
}

/** Whether a Reopen's notice is past being offered, undelivered: its chat was not told. */
export function reopenExpired(reopen: Pick<Reopen, "at" | "sentAt" | "delivery">, now: Date): boolean {
  return !reopen.delivery && Date.parse(reopen.sentAt ?? reopen.at) < now.getTime() - REOPEN_NOTICE_MS;
}

export const reopenSendSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/) }).strict();

/** The SSE `reopen` event: the bridge writes its own sentence around these, for the monitor chat. */
export interface ReopenEvent {
  id: string;
  itemId: string;
  title: string;
  chat?: string;
  /** Absent for the default repo. */
  repo?: string;
  at: string;
  earlier: { replyId: string; decision: Decision; choice?: string };
}

export const reopenAckSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
    delivered: z.boolean(),
    confirmed: z.boolean().optional(),
    error: z.string().max(1000).optional(),
  })
  .strict();

/** The kinds whose card asks for a yes: rebuilt from an answer alone, they take Yes, keep it or Change it. */
const YES_KINDS: ReadonlySet<string> = new Set([DECISION, PLAN, ASK, MERGE_READY]);

/**
 * A card rebuilt from an answer alone, for one answered before the server kept cards: its title, ask and PR link, with
 * Yes, keep it / Change it for a card that asked for a yes, else a box to type in. Never a merge card: a yes to it merges nothing.
 */
export function cardFromReply(reply: Pick<Reply, "itemId" | "itemTitle" | "item">): Need {
  const { item } = reply;
  const repo = item.repo ?? NO_REPO;
  const yes = YES_KINDS.has(item.kind ?? "");
  const url = !repo ? null : item.pr ? `https://github.com/${repo}/pull/${item.pr}` : item.issue ? `https://github.com/${repo}/issues/${item.issue}` : null;
  return {
    id: reply.itemId,
    kind: yes ? DECISION : QUESTION,
    title: reply.itemTitle,
    ...(item.ask ? { ask: item.ask } : {}),
    ...(item.chat ? { chat: item.chat } : {}),
    ...(item.pr ? { pr: item.pr } : {}),
    ...(item.issue ? { issue: item.issue } : {}),
    ...(repo ? { repo } : {}),
    ...(item.risk ? { risk: item.risk } : {}),
    ...(yes ? { options: OUTCOME_OPTIONS.map((option) => ({ ...option })) } : {}),
    ...(url ? { links: [{ label: item.pr ? `PR #${item.pr}` : `Issue #${item.issue}`, url }] } : {}),
  } as Need;
}

/** Whether a card is kept once answered: an update card is kept as seen instead, and a Got it card goes at its tap. */
export function keepsAnswer(need: Pick<Need, "kind" | "id" | "options">): boolean {
  return !isUpdate(need) && !isGotIt(need) && !need.id.startsWith("schedule-");
}
