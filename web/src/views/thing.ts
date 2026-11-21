import "./thing.css";

import { MERGE_READY } from "../../../src/shared/answers.js";
import type { ServedNeed } from "../../../src/shared/board.js";
import type { ChatMessage } from "../../../src/shared/command.js";
import type { ConversationSummary } from "../../../src/shared/conversations.js";

// A thing: one piece of work, the conversation that holds its cards. It has no page of its own now; this holds where
// the work stands, for its lines' More in Chat.

export const THING_STEPS = ["plan", "building", "review", "look", "merged"] as const;
export type ThingStep = (typeof THING_STEPS)[number];

const MEDIA_KINDS: ReadonlySet<string> = new Set(["video", "stills", "before-after"]);
const SIZES = ["S", "M", "L"] as const;
export type ThingSize = (typeof SIZES)[number];

/** A card filed in the thing, oldest first: Rivet's line that shows it, its answer if any, and the board's copy while it is there. */
export interface ThingCard {
  id: string;
  kind: string;
  title: string;
  ask?: string;
  at: string;
  /** When the owner said yes to it (Yes, a choice, Done); a rejection or a comment is no answer to the step. */
  answeredAt: string | null;
  /** When the owner turned it down, if they did. */
  rejectedAt?: string | null;
  need?: ServedNeed;
}

export interface ThingFacts {
  step: ThingStep;
  /** The card that put it at each step reached, for its line. */
  by: Partial<Record<ThingStep, ThingCard>>;
  eta: string | null;
  size: ThingSize | null;
  lab: string | null;
  pr: string | null;
  chat: string | null;
}

export function thingCards(messages: Iterable<ChatMessage>, board: readonly ServedNeed[]): ThingCard[] {
  const list = [...messages];
  const answers = new Map<string, string>();
  const rejections = new Map<string, string>();
  for (const message of list) {
    if (!message.card || message.from !== "owner") continue;
    const said = answerKind(message.text);
    if (said === "yes") answers.set(message.card, message.at);
    else if (said === "no") rejections.set(message.card, message.at);
  }
  const seen = new Set<string>();
  const cards: ThingCard[] = [];
  for (const message of [...list].sort((a, b) => a.at.localeCompare(b.at))) {
    const posted = message.posted;
    if (!posted || seen.has(posted.id)) continue;
    seen.add(posted.id);
    const need = board.find((one) => one.id === posted.id);
    cards.push({
      id: posted.id,
      kind: posted.kind,
      title: posted.title,
      ...(posted.ask ? { ask: posted.ask } : {}),
      at: message.at,
      answeredAt: answers.get(posted.id) ?? null,
      rejectedAt: rejections.get(posted.id) ?? null,
      ...(need ? { need } : {}),
    });
  }
  return cards;
}

/** What a the owner line in a thing says about its card, from the words the server writes for an answer (answerText). */
export function answerKind(text: string): "yes" | "no" | "note" {
  const first = text.split("\n")[0]!.trim();
  // "Chose: No" on a merge-ready card declines the merge: a no-word choice is a no, not a yes.
  if (/^(Rejected|No)\b/.test(first) || /^Chose:\s*(No|Not|Stop|Hold|Holding|Held|Wait|Waiting|Awaiting|Later)\b/i.test(first)) return "no";
  if (/^(Approved:|Chose:|Done$|Yes\b)/.test(first)) return "yes";
  return "note";
}

export const isPlan = (card: Pick<ThingCard, "kind" | "title">): boolean => card.kind === "plan" || /^plan\b/i.test(card.title);
export const isReview = (card: Pick<ThingCard, "kind" | "title">): boolean => card.kind === "review" || /\breview\b/i.test(card.title);
export function hasMedia(card: Pick<ThingCard, "kind" | "need">): boolean {
  return MEDIA_KINDS.has(card.kind) || (card.need?.media !== undefined && MEDIA_KINDS.has(card.need.media.kind));
}
const isMerged = (card: Pick<ThingCard, "kind" | "answeredAt">): boolean =>
  card.kind === "merged" || card.kind === "shipped" || (card.kind === MERGE_READY && card.answeredAt !== null);

/**
 * Where the work stands, from its cards and the conversation's PR: merged once a merge-ready card is answered, a
 * merged or shipped card is in it, or its PR merged; your look once a video or stills card is in it; review once a review
 * card is; building once the plan card is answered, or its PR is open; else plan.
 */
export function thingStep(
  cards: readonly ThingCard[],
  summary: Pick<ConversationSummary, "phase" | "stage"> | null,
): { step: ThingStep; by: Partial<Record<ThingStep, ThingCard>> } {
  const newest = (test: (card: ThingCard) => boolean) => [...cards].reverse().find(test);
  const by: Partial<Record<ThingStep, ThingCard>> = {};
  const plan = newest(isPlan);
  if (plan) by.plan = plan;
  const review = newest(isReview);
  if (review) by.review = review;
  const look = newest(hasMedia);
  if (look) by.look = look;
  const merged = newest(isMerged);
  if (merged) by.merged = merged;
  const step: ThingStep =
    merged || summary?.phase === "merged" || summary?.phase === "deployed" || summary?.stage === "merged"
      ? "merged"
      : look
        ? "look"
        : review
          ? "review"
          : plan?.answeredAt || summary?.phase === "building" || summary?.stage === "open" || summary?.stage === "draft"
            ? "building"
            : "plan";
  return { step, by };
}

/** A string field Rivet may put on a card beyond the board's own (`eta`, `size`). */
function field(need: ServedNeed | undefined, key: string): string | null {
  const value = (need as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The newest card's ETA while that card is on the board; none otherwise. */
export function thingEta(cards: readonly ThingCard[]): string | null {
  for (const card of [...cards].reverse()) {
    const eta = field(card.need, "eta");
    if (eta) return eta;
  }
  return null;
}

/** S, M or L from the plan card: its `size`, else "size M" in its title or ask. */
export function thingSize(cards: readonly ThingCard[]): ThingSize | null {
  for (const card of [...cards].reverse()) {
    if (!isPlan(card)) continue;
    const said = (field(card.need, "size") ?? /\bsize[:\s]+([SML])\b/i.exec(`${card.title}\n${card.ask ?? card.need?.ask ?? ""}`)?.[1] ?? "").toUpperCase();
    if ((SIZES as readonly string[]).includes(said)) return said as ThingSize;
  }
  return null;
}

/** A card's preview link, while that card is on the board. */
export function thingLab(cards: readonly ThingCard[]): string | null {
  for (const card of [...cards].reverse()) {
    const link = card.need?.links?.find((one) => /\b(preview|lab)\b/i.test(one.label) && /^https:\/\//.test(one.url));
    if (link) return link.url;
  }
  return null;
}

export function thingFacts(
  messages: Iterable<ChatMessage>,
  board: readonly ServedNeed[],
  summary: Pick<ConversationSummary, "phase" | "stage" | "stagePr" | "links"> | null,
): ThingFacts & { cards: ThingCard[] } {
  const cards = thingCards(messages, board);
  const { step, by } = thingStep(cards, summary);
  const prCard = [...cards].reverse().find((card) => card.need?.pr !== undefined);
  const pr = summary?.stagePr ?? summary?.links.prs[0] ?? (prCard ? `#${prCard.need!.pr}` : null);
  const chatCard = [...cards].reverse().find((card) => card.need?.chat);
  const linked = summary?.links.chats[0];
  const chat = linked ?? chatCard?.need?.chat ?? null;
  return { cards, step, by, eta: thingEta(cards), size: thingSize(cards), lab: thingLab(cards), pr, chat };
}

/** What Stop it says to Rivet, in the thing's conversation. */
export function stopText(chat: string | null, title: string): string {
  return chat ? `Stop ${chat}: ${title}` : `Stop this: ${title}`;
}
