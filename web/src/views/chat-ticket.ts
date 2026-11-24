import type { AnsweredCard } from "../../../src/shared/answered.js";
import { isUpdate, PLAN } from "../../../src/shared/answers.js";
import { askPrRepo, asksOfChat, sameRepo, workerOfAsk, type StageReadings } from "../../../src/shared/ask-stages.js";
import { isFinished, type Ask } from "../../../src/shared/asks.js";
import type { MediaRef, Reply, ServedNeed } from "../../../src/shared/board.js";
import { chatName } from "../../../src/shared/names.js";
import { underWay } from "../../../src/shared/ops-owned.js";
import type { OpsStatus } from "../../../src/shared/ops-status.js";
import { when } from "../../../src/shared/when.js";
import type { Worker } from "../../../src/shared/workers.js";
import { stageWord } from "../../../src/shared/words.js";
import { agentName } from "../cloud-agent.js";

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
  {
    key: "rivet",
    get label() {
      return agentName();
    },
  },
];

/** What a filter with no rows says; Lenses has none until review findings reach the app. */
export const WHO_EMPTY: Record<Exclude<Who, "other"> | "all", string> = {
  all: "Nothing here yet.",
  you: "No answers from you on this yet.",
  chat: "Nothing from its chat yet.",
  lenses: "Review findings don't come to this list yet.",
  get rivet() {
    return `Nothing from ${agentName()} on this yet.`;
  },
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

const ASK_ID = /(?<![A-Za-z0-9])a-(\d{1,5})(?![A-Za-z0-9])/g;
const BRANCH_ASK = /^a(\d{1,5})-/;

/**
 * The ask ids a title or branch names: `(a-12)` or `a-12` in either, and a branch that starts `a12-`. A bare `a12` in a
 * title is a word, not an ask.
 */
export function askIdsIn(title: string | undefined, branch?: string): string[] {
  const named = [title, branch].flatMap((text) => [...(text ?? "").matchAll(ASK_ID)].map((match) => match[1]!));
  const lead = BRANCH_ASK.exec(branch ?? "")?.[1];
  return [...new Set([...named, ...(lead ? [lead] : [])])].map((n) => `a-${n}`);
}

type Chat = Pick<Worker, "chat" | "repo" | "project">;

/**
 * The row's PRs an ask names, in the ask's repo as its chat's worktree reads it, bar one merged before the ask was made:
 * that one it names only for context (desks.ts claims).
 */
export function linkedPrs(ask: Ask, w: Pick<Worker, "repo" | "prs">, chats: readonly Chat[], merged: StageReadings["merged"]): { number: number; repo: string }[] {
  const repo = askPrRepo(ask, workerOfAsk(ask, chats));
  if (!sameRepo(repo, w.repo)) return [];
  const before = (pr: number) => merged.some((one) => one.number === pr && sameRepo(one.repo, repo) && Date.parse(one.at) < Date.parse(ask.createdAt));
  return ask.prs.filter((pr) => (w.prs ?? []).includes(pr) && !before(pr)).map((number) => ({ number, repo }));
}

/**
 * Every open ask a row is about, newest first: its chat's own and one naming a PR of the row's (linkedPrs). A row the
 * map builds from GitHub or the push queue has no chat to hold an ask, so with neither its title or branch may name one;
 * a chat's doing text can mention an ask it only follows, so a chat's row never links by it.
 */
export function linkedAsks(w: Pick<Worker, "id" | "chat" | "repo" | "project" | "prs" | "what" | "branch">, asks: readonly Ask[], chats: readonly Chat[] = [], merged: StageReadings["merged"] = []): Ask[] {
  const own = new Set(asksOfChat(w, asks).map((ask) => ask.id));
  const open = asks.filter((ask) => !isFinished(ask.stage));
  // A map row may carry the chat name of the ask it was built from; that chat's other asks naming only other PRs are not its.
  const mapRow = w.id.includes(":");
  const direct = open.filter((ask) => {
    const viaPr = linkedPrs(ask, w, chats, merged).length > 0;
    return viaPr || (own.has(ask.id) && !(mapRow && ask.prs.length));
  });
  const named = !direct.length && w.id.includes(":") ? askIdsIn(w.what, w.branch) : [];
  const inRepo = (ask: Ask) => sameRepo(askPrRepo(ask, workerOfAsk(ask, chats)), w.repo);
  return (direct.length ? direct : open.filter((ask) => named.includes(ask.id) && inRepo(ask))).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * The ops record of a chat `rivet fix` opened, newest first: its chat's name, in its repo when the record says, and set
 * since the chat started, in any state (a fix chat often marks it fixed while its PR waits); with no start known, only one
 * with work under way on it (a name used again keeps no older record).
 */
export function opsRecordOf(w: Pick<Worker, "chat" | "repo" | "startedAt">, statuses: readonly OpsStatus[]): OpsStatus | undefined {
  const current = (status: OpsStatus) => (w.startedAt === undefined ? underWay(status) : Date.parse(status.updatedAt) >= w.startedAt);
  return statuses
    .filter((status) => status.chat === w.chat && (status.repo === undefined || sameRepo(status.repo, w.repo)) && current(status))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}

/** Where an ask came from, to link to: the Chat line it was asked in, else the issue it was started from. */
export function askSourceLink(ask: Ask, line: string | null, chats: readonly Chat[] = []): { line: string } | { issue: number; href: string } | null {
  if (line) return { line };
  const backlog = /^backlog:([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ask.source ?? "");
  const repo = backlog ? backlog[1]! : askPrRepo(ask, workerOfAsk(ask, chats));
  const issue = backlog ? Number(backlog[2]) : ask.issue;
  return issue === undefined ? null : { issue, href: `https://github.com/${repo}/issues/${issue}` };
}

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

/** Several asks' cards as one list, one each (the first list's copy), oldest first. */
export function mergedCards(lists: readonly (readonly TicketCard[])[]): TicketCard[] {
  const byId = new Map<string, TicketCard>();
  for (const one of lists.flat()) if (!byId.has(one.card.id)) byId.set(one.card.id, one);
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
  const rivetRow = { who: "rivet" as const, name: agentName(), role: "main agent" };
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
    // A due move names its mover when it records one ("by cards-fix"), as the Promise keeper's do.
    for (const move of ask.dueHistory) rows.push({ at: move.at, who: "other", name: "Due", role: "time moved", text: `Due moved ${when(move.was, move.at)} → ${when(move.dueAt, move.at)}${move.by ? ` by ${move.by}` : ""}${move.why ? `: ${move.why}` : ""}` });
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
  const who = ask.who === "owner" ? "You" : agentName();
  return `${who} · ${when(ask.createdAt)}`;
}
