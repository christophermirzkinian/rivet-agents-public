import { chatName } from "../../../src/shared/names.js";
import "./thing.css";

import { MERGE_READY } from "../../../src/shared/answers.js";
import type { ServedNeed } from "../../../src/shared/board.js";
import type { ChatMessage } from "../../../src/shared/command.js";
import type { ConversationSummary } from "../../../src/shared/conversations.js";
import { h, ICONS, svg } from "../dom.js";

// The thing page: one page per piece of work, the conversation that
// holds its cards. chat.ts draws it; this holds where the work stands and the page's own parts.

export const THING_STEPS = ["plan", "building", "review", "look", "merged"] as const;
export type ThingStep = (typeof THING_STEPS)[number];
export const STEP_LABELS: Record<ThingStep, string> = {
  plan: "Plan",
  building: "Building",
  review: "Review",
  look: "Your look",
  merged: "Merged",
};

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

/** One line under the title: PR, chat, size and the preview link, then the ETA. */
export function thingMeta(facts: ThingFacts): HTMLElement | null {
  const parts: (string | HTMLElement)[] = [];
  if (facts.pr) parts.push(`PR ${facts.pr}`);
  if (facts.chat) parts.push(`chat ${chatName(facts.chat)}`);
  if (facts.size) parts.push(`size ${facts.size}`);
  if (facts.lab) parts.push(h("a", { class: "thing-lab", attrs: { href: facts.lab, target: "_blank", rel: "noopener", "data-use": "chat.thing.link" } }, "Preview"));
  if (facts.eta) parts.push(h("span", { class: "thing-eta" }, "ETA ", h("b", {}, facts.eta)));
  if (!parts.length) return null;
  return h("p", { class: "thing-meta" }, ...parts.flatMap((part, index) => (index ? [" · ", part] : [part])));
}

const BACK =
  '<svg viewBox="0 0 24 24"><path d="M14.5 5.5L8 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export interface ThingHeadInput {
  title: string;
  /** Where it stands, for the pill; null on Rivet's own conversations (Updates, Agent Chat). */
  step: ThingStep | null;
  facts: ThingFacts | null;
  back: () => void;
  /** The Read aloud toggle, Chat's own, kept in reach. */
  speak: HTMLElement | null;
  /** Opens the unanswered card it waits on, while that card is on the board. */
  card: (() => void) | null;
  closed: boolean;
}

/** Back to Chat, the title with where it stands, then PR, chat, size, preview link and ETA on one line. */
export function thingHead(input: ThingHeadInput): HTMLElement {
  return h(
    "div",
    { class: "thing-head" },
    h(
      "div",
      { class: "thing-head-row" },
      h(
        "button",
        { class: "icon-btn thing-back", attrs: { type: "button", "aria-label": "Back to Chat", "data-use": "chat.thing.back" }, on: { click: input.back } },
        svg(BACK, "icon-btn-icon"),
      ),
      h("h2", { class: "thing-title" }, input.title),
      input.speak,
    ),
    input.step || input.facts
      ? h(
          "div",
          { class: "thing-head-facts" },
          input.step ? h("span", { class: `thing-pill step-${input.step}` }, STEP_LABELS[input.step]) : null,
          input.facts ? thingMeta(input.facts) : null,
        )
      : null,
    input.closed ? h("p", { class: "thing-quiet" }, "Quiet for a while. A new message brings it back.") : null,
    input.card ? h("button", { class: "btn thing-card-open", attrs: { type: "button", "data-use": "chat.thing.open-card" }, on: { click: input.card } }, "Open the card that needs you") : null,
  );
}

export interface ThingButtons {
  /** The card's own Share, or a reply's; null when there is nothing to share. */
  share: HTMLElement | null;
  stop: () => void;
}

/** Share, Open on Mac and Stop it, at the foot of the page. */
export function thingButtons(input: ThingButtons): HTMLElement {
  return h(
    "div",
    { class: "thing-buttons" },
    input.share,
    h("button", { class: "btn thing-btn thing-stop", attrs: { type: "button", "data-use": "chat.thing.stop" }, on: { click: input.stop } }, svg(ICONS.no, "btn-icon"), "Stop it"),
  );
}

/** What Stop it says to Rivet, in the thing's conversation. */
export function stopText(chat: string | null, title: string): string {
  return chat ? `Stop ${chat}: ${title}` : `Stop this: ${title}`;
}

let opener: ((id: string) => void) | null = null;

/** chat.ts opens the page: on screen now when the chat is, else when it mounts. */
export function onShowThing(open: (id: string) => void): void {
  opener = open;
}

/** Opens thing `id` (any message of its conversation names it). */
export function showThing(id: string): void {
  opener?.(id);
}
