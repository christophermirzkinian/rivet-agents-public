import type { AnsweredCard } from "../../../src/shared/answered.js";
import { isUpdate, PLAN } from "../../../src/shared/answers.js";
import type { Ask } from "../../../src/shared/asks.js";
import type { MediaRef, Reply, ServedNeed } from "../../../src/shared/board.js";
import { chatName } from "../../../src/shared/names.js";
import { when } from "../../../src/shared/when.js";
import { stageWord } from "../../../src/shared/words.js";

/**
 * The chat sheet as a ticket: what its Ticket and Activity tabs read, from what the app already has. Its ask, the ask's
 * timeline and due moves, and the cards made for it with the owner's answers; nothing is made up, and what is not sent
 * to the app yet (review lens findings) has an empty state instead.
 */

/**
 * Who an Activity row is from, as its filter chips name them. `other` is a row whose author the data does not name as
 * The owner, the chat or Rivet (a due move, a timeline event by someone else or no one): All shows it, under its own name.
 */
export type Who = "you" | "chat" | "lenses" | "rivet" | "other";

export const WHO_CHIPS: readonly { key: Exclude<Who, "other"> | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "you", label: "You" },
  { key: "chat", label: "Chat" },
  { key: "lenses", label: "Lenses" },
  { key: "rivet", label: "Rivet" },
];

/** What a filter with no rows says; Lenses has none until review findings reach the app. */
export const WHO_EMPTY: Record<Exclude<Who, "other"> | "all", string> = {
  all: "Nothing here yet.",
  you: "No answers from you on this yet.",
  chat: "Nothing from its chat yet.",
  lenses: "Review findings don't come to this list yet.",
  rivet: "Nothing from Rivet on this yet.",
};

export interface ActivityRow {
  /** When; null sorts it last with no time shown (its last words, when the feed has no time for them). */
  at: string | null;
  who: Who;
  name: string;
  role: string;
  text: string;
  /** The owner's typed words with an answer, shown in quotes. */
  quote?: string;
  /** The pictures a card carried: `2 pictures`. */
  attach?: string;
}

/** A card made for the ask or its chat, with the owner's answer when he has given one. */
export interface TicketCard {
  card: ServedNeed;
  reply?: Reply;
}

export interface TicketPicture {
  src: string;
  ref: MediaRef;
  title: string;
  at: string | null;
}

export interface TicketSolution {
  lead: string;
  points: string[];
  rows: [string, string][];
}

const time = (at: string | null | undefined) => (at && Number.isFinite(Date.parse(at)) ? Date.parse(at) : Number.POSITIVE_INFINITY);

/**
 * The cards for an ask, or for a chat with no ask, open and answered, one each (the answered one, which has his answer),
 * oldest first. A card names its ask (`askId`, or the ask's own `cardId`); one that names none counts when it came from
 * the same chat and, with an ask, after the ask was made. A card's `repo` is its PR's, set only with a PR, so one with a
 * repo counts only when it is one of the chat's (`repos`: the ask's, the chat's project and its worktree's, as
 * askPrRepo reads them). A card naming another ask never counts: a chat takes ask after ask, and theirs stay with them.
 * With no ask, a card counts from when the chat started (`startedAt`, epoch ms), when that is known: a name used again
 * by a later chat never takes on the earlier one's cards.
 */
export function ticketCards(
  ask: Ask | undefined,
  chat: string,
  repos: readonly (string | undefined)[],
  open: readonly ServedNeed[],
  answered: readonly AnsweredCard[],
  startedAt?: number,
): TicketCard[] {
  const after = ask ? time(ask.createdAt) : (startedAt ?? Number.NEGATIVE_INFINITY);
  const ours = (card: ServedNeed) => {
    if (ask && (card.askId === ask.id || card.id === ask.cardId)) return true;
    if (card.askId !== undefined || chat === "" || card.chat !== chat || (card.repo !== undefined && !repos.includes(card.repo))) return false;
    return after === Number.NEGATIVE_INFINITY || (card.since !== undefined && time(card.since) >= after);
  };
  const byId = new Map<string, TicketCard>();
  for (const one of answered) if (ours(one.card)) byId.set(one.card.id, { card: one.card, reply: one.reply });
  for (const card of open) if (ours(card) && !byId.has(card.id)) byId.set(card.id, { card });
  return [...byId.values()].sort((a, b) => time(a.card.since ?? a.reply?.at) - time(b.card.since ?? b.reply?.at));
}

const isImage = (ref: MediaRef | undefined): ref is MediaRef => !!ref && ref.type.startsWith("image/");

/** A card's pictures: its stills, and its before, after and poster when they are images. */
function cardImages(card: ServedNeed): MediaRef[] {
  const media = card.media;
  if (!media) return [];
  const all = [...(media.stills ?? []), media.before, media.after, media.poster].filter(isImage);
  return all.filter((ref, i) => all.findIndex((one) => one.sha256 === ref.sha256) === i);
}

/** Every picture on the cards, oldest card first, each captioned with its card's title. */
export function ticketPictures(cards: readonly TicketCard[]): TicketPicture[] {
  return cards.flatMap(({ card, reply }) => cardImages(card).map((ref) => ({ src: `/media/${ref.sha256}`, ref, title: card.title, at: card.since ?? reply?.at ?? null })));
}

/** The owner's answer in words: `Picked B`, `Approved`, his comment. Null for one that asked nothing (seen, dismissed). */
function answerText(reply: Reply): { text: string; quote?: string } | null {
  const typed = reply.text?.trim() || undefined;
  switch (reply.decision) {
    case "choice":
      return { text: `Picked ${reply.choice ?? "an option"}`, ...(typed ? { quote: typed } : {}) };
    case "approve":
      return { text: "Approved", ...(typed ? { quote: typed } : {}) };
    case "reject":
      return { text: "Said no", ...(typed ? { quote: typed } : {}) };
    case "comment":
      return typed ? { text: "Commented", quote: typed } : null;
    case "done":
      return { text: "Marked done" };
    default:
      return null;
  }
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * The Activity rows, oldest first: the ask's stage changes and notes, its due moves, each card sent and the owner's answer to
 * it, and the chat's last words when its screen has them.
 */
export function activityRows(ask: Ask | undefined, chat: string, cards: readonly TicketCard[], lastSaid: { text: string; at: string | null } | null): ActivityRow[] {
  const chatRow = { who: "chat" as const, name: chatName(chat), role: "chat" };
  const rivetRow = { who: "rivet" as const, name: "Rivet", role: "main agent" };
  // `by` is free text: only the chat's own name or Rivet's is credited to them; anyone else keeps their own name.
  const byRow = (by: string | undefined): Pick<ActivityRow, "who" | "name" | "role"> =>
    !by ? { who: "other", name: "The ask", role: "no author" } : chat !== "" && by === chat ? chatRow : by.trim().toLowerCase() === "rivet" ? rivetRow : { who: "other", name: by, role: "on the ask" };
  const rows: ActivityRow[] = [];
  if (ask) {
    ask.timeline.forEach((event, i) => {
      const from = byRow(event.by);
      const note = event.note?.trim();
      const stage = event.stage ? stageWord(event.stage) : null;
      // Opened only for the event the ask was made with: a list row carries its newest event alone.
      const head = stage ? (i === 0 && event.at === ask.createdAt ? `Opened at ${stage}` : `Moved to ${stage}`) : null;
      const text = [head, note].filter(Boolean).join(": ");
      if (text) rows.push({ at: event.at, ...from, text });
    });
    // A due move names no author.
    for (const move of ask.dueHistory) rows.push({ at: move.at, who: "other", name: "Due", role: "time moved", text: `Due moved ${when(move.was, move.at)} → ${when(move.dueAt, move.at)}${move.why ? `: ${move.why}` : ""}` });
  }
  for (const { card, reply } of cards) {
    const pictures = cardImages(card).length;
    const from = card.chat ? { ...chatRow, name: chatName(card.chat) } : ({ who: "other", name: "A card", role: "no chat" } as const);
    if (card.since) rows.push({ at: card.since, ...from, text: `${isUpdate(card) ? "Update" : card.kind === PLAN ? "Plan card sent" : "Card sent"}: ${card.title}`, ...(pictures ? { attach: plural(pictures, "picture") } : {}) });
    const answer = reply ? answerText(reply) : null;
    if (reply && answer) rows.push({ at: reply.at, who: "you", name: "You", role: "card answer", ...answer });
  }
  if (lastSaid) rows.push({ at: lastSaid.at, ...chatRow, role: "last said", text: lastSaid.text });
  return rows.map((row, i) => ({ row, i })).sort((a, b) => time(a.row.at) - time(b.row.at) || a.i - b.i).map(({ row }) => row);
}

/**
 * What is being built, from the ask's newest plan card: its main point, dot points, the option the owner picked on that
 * card, its size and the ETA it gave. Null with no plan card: the ask has no solution written down yet (another card's
 * answer is not a plan).
 */
export function ticketSolution(cards: readonly TicketCard[]): TicketSolution | null {
  const plan = [...cards].reverse().find(({ card }) => card.kind === PLAN);
  if (!plan) return null;
  const rows: [string, string][] = [];
  const reply = plan.reply;
  if (reply?.decision === "choice" && reply.choice) {
    const detail = reply.item.choiceDetail?.trim();
    rows.push(["Picked", `${reply.choice}${detail ? `: ${detail}` : ""}, ${when(reply.at)}`]);
  }
  if (plan.card.size) rows.push(["Size", plan.card.size]);
  // The plan's own estimate, as it was sent: the due time in the strip is the one that moves.
  if (plan.card.eta) rows.push(["Plan ETA", plan.card.eta]);
  return { lead: plan.card.ask?.trim() || plan.card.title, points: plan.card.points ?? [], rows };
}

/** The line under the strip: `a-1 · asked 8:12am · due moved once`. */
export function ticketMeta(ask: Ask | undefined): string {
  if (!ask) return "";
  const moves = ask.dueHistory.length;
  return [ask.id, `asked ${when(ask.createdAt)}`, moves === 0 ? null : moves === 1 ? "due moved once" : `due moved ${moves} times`].filter(Boolean).join(" · ");
}

/** Who asked, as the Description's foot says it: `You · 8:12am`. */
export function askedBy(ask: Ask): string {
  const who = ask.who === "owner" ? "You" : "Rivet";
  return `${who} · ${when(ask.createdAt)}`;
}
