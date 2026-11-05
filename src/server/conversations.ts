import {
  CONVERSATION_LINKS_MAX,
  IDLE_ARCHIVE_MS,
  ownsNoCard,
  TEAM_ROOM_ID,
  UPDATES_ID,
  type ChatRef,
  type ConversationPhase,
  type ConversationStage,
  type ConversationSummary,
} from "../shared/conversations.js";
import { NO_REPO } from "../shared/board.js";
import { appOnlyThread, THREAD_PROJECT_LABELS, type ThreadSummary } from "../shared/threads.js";
import type { ThreadRow } from "./commandstore.js";
import type { ThreadLinks } from "./threads.js";

// Conversations (src/shared/conversations.ts) on the server: where a message from Rivet lands, and how a thread reads
// as a row of the list.

/** Where a Rivet message landed, and by which rule. */
export interface Resolved {
  thread: string;
  via: "message" | "mention" | "updates" | "new";
}

/**
 * The conversation a message from Rivet (`say.mjs`) lands in, by the id it already has:
 * 1. `replyTo` is a chat message (your, your own, a conversation's first, or a card answer's, whose id is the
 *    reply's) → that message's conversation. A card answer with no message (one from before conversations) → the
 *    conversation of the latest reply to it, else a new one at this message (its root replying to the answer, so
 *    its ask still links it). Any other id → Updates.
 * 2. No id: the one conversation active this week its text names by PR, chat, ask or card id (`mentioned`, the
 *    title matcher, Updates left out); none or several → Updates.
 * `fresh` (say.mjs --new) starts one at `id`, the message's own.
 */
export function resolveConversation(
  input: { id: string; replyTo?: string; text: string; fresh?: boolean },
  deps: {
    threadOf: (id: string) => string | null;
    isReply: (id: string) => boolean;
    /** The conversation of the latest message replying to `id`. */
    repliedIn: (id: string) => string | null;
    mentioned: (text: string) => readonly string[];
  },
): Resolved {
  if (input.fresh) return { thread: input.id, via: "new" };
  if (input.replyTo !== undefined) {
    const thread = deps.threadOf(input.replyTo);
    if (thread) return { thread, via: "message" };
    if (!deps.isReply(input.replyTo)) return { thread: UPDATES_ID, via: "updates" };
    const earlier = deps.repliedIn(input.replyTo);
    return earlier ? { thread: earlier, via: "message" } : { thread: input.id, via: "new" };
  }
  if (input.text) {
    const named = deps.mentioned(input.text).filter((thread) => !ownsNoCard(thread));
    if (named.length === 1) return { thread: named[0]!, via: "mention" };
  }
  return { thread: UPDATES_ID, via: "updates" };
}

/** Ids the server and the monitor mint by the thousand (a merge's Merged and Deployed cards too): nothing about their topic is in them. */
const UNSTEMMED = /^(upd|ask|merged|deployed)-/;

/**
 * What a card id says about its topic (2026-10-09): a trailing PR number (`-4861`, four digits or more) and the stem
 * left once that, a date and round markers (`-2`, `-v3`, `-r11`, `-8b`, `-step1`, `-part3`) are cut, so
 * `signup-forms-v3-4861` and `signup-forms-4861` are one topic, as are `login-flow-5` and `login-flow-r12-4859`. A
 * stem under five characters, or an id the server or monitor mints (`upd-…`, `ask-…`), names no topic.
 */
export function cardKey(id: string): { stem: string | null; pr: number | null } {
  let rest = id.toLowerCase();
  // A dated id (a daily report) is that day's alone.
  if (UNSTEMMED.test(rest) || /-\d{4}-\d{2}-\d{2}$/.test(rest)) return { stem: null, pr: null };
  const pr = /-(\d{4,6})$/.exec(rest);
  if (pr) rest = rest.slice(0, pr.index);
  for (let cut = rest.replace(/-(?:v|r|round|part|step)?\d{1,3}[a-z]?$/, ""); cut !== rest; cut = rest.replace(/-(?:v|r|round|part|step)?\d{1,3}[a-z]?$/, "")) rest = cut;
  return { stem: rest.length >= 5 ? rest : null, pr: pr ? Number(pr[1]) : null };
}

/** Chats that own no one topic (Rivet's), so a card naming one is matched by nothing but its stem or PR. */
export const MIXED_CHATS: ReadonlySet<string> = new Set(["rivet"]);

/**
 * Where a conversation's work stands, for its row: your ball first, then deployed (the thread reads shipped), merged,
 * building (a PR open or in draft, or a chat at work); none otherwise.
 */
export function phaseOf(input: { needsYou: boolean; stage: ConversationStage; statusFrom: ThreadSummary["statusFrom"] }): ConversationPhase | null {
  if (input.needsYou) return "waiting";
  if (input.statusFrom === "shipped") return "deployed";
  if (input.stage === "merged" || input.statusFrom === "merged") return "merged";
  if (input.stage === "open" || input.stage === "draft" || input.statusFrom === "chat" || input.statusFrom === "pr") return "building";
  return null;
}

/** A PR as a chip names it: "#3412" in the main repo, "other-repo#88" in another. */
function prChip(pr: { repo: string | null; number: number }): string {
  return pr.repo === null || pr.repo.toLowerCase() === NO_REPO.toLowerCase() ? `#${pr.number}` : `${pr.repo.split("/").pop()}#${pr.number}`;
}

/** A PR's key for its stage: `owner/repo#n`, lower case; a bare `#n` is the main repo's. */
export function prStageKey(pr: { repo: string | null; number: number }): string {
  return `${(pr.repo ?? NO_REPO).toLowerCase()}#${pr.number}`;
}

/** Which PR stage a conversation shows when it links several: anything still open wins, then draft, merged, closed. */
const STAGE_RANK: readonly ConversationStage[] = ["open", "draft", "merged", "closed"];

/** PR links (`owner/repo#n`, in GitHub's case) with each PR once, whatever the case. */
export function uniquePrs(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  return keys.filter((key) => !seen.has(key.toLowerCase()) && Boolean(seen.add(key.toLowerCase())));
}

/**
 * Every PR a conversation links now, as `owner/repo#n`: its ask's, Rivet's steps', what its messages name, and its
 * status's. A bare `#n` (a message's, or the status's) is the linked PR with that number when there is one, else
 * whichever repo's PR GitHub shows with it (`resolve`, as namesPr matches it), else the main repo's.
 */
export function linkedPrs(
  thread: Pick<ThreadSummary, "statusPr">,
  links: ThreadLinks | undefined,
  resolve: (number: number) => string | undefined = () => undefined,
): string[] {
  const named = [...(links?.prs ?? []), ...(links?.said?.refs ?? [])].flatMap((pr) => (pr.repo !== null ? [{ repo: pr.repo, number: pr.number }] : []));
  const bare = [...(links?.said?.refs ?? []).flatMap((pr) => (pr.repo === null ? [pr.number] : [])), ...(thread.statusPr !== undefined ? [thread.statusPr] : [])];
  const keys = named.map((pr) => `${pr.repo}#${pr.number}`);
  for (const number of bare) if (!named.some((pr) => pr.number === number)) keys.push(resolve(number) ?? `${NO_REPO}#${number}`);
  return uniquePrs(keys);
}

/** The stage its PRs (`owner/repo#n`) show, and the PR that decided it; none when GitHub has told us about none of them. */
export function conversationStage(prs: readonly string[], stageOf: (key: string) => ConversationStage | undefined): { stage: ConversationStage; pr?: string } {
  let best: { stage: ConversationStage; pr?: string } = { stage: "none" };
  for (const key of prs) {
    const stage = stageOf(key.toLowerCase());
    if (stage === undefined || stage === "none") continue;
    const at = key.lastIndexOf("#");
    if (best.stage === "none" || STAGE_RANK.indexOf(stage) < STAGE_RANK.indexOf(best.stage)) best = { stage, pr: prChip({ repo: key.slice(0, at), number: Number(key.slice(at + 1)) }) };
  }
  return best;
}

/** Done stands until you write after Rivet marked it. */
export function isDone(row: Pick<ThreadRow, "doneAt" | "lastOwnerAt">): boolean {
  return row.doneAt !== null && (row.lastOwnerAt === null || row.lastOwnerAt <= row.doneAt);
}

/**
 * A closed conversation stays closed until a message comes after its Close. The retired 8-hour merged sweep stamped
 * closed_at and swept_at alike; its closures are no Close of his, so the idle rule decides them (one waiting on him
 * is listed again).
 */
export function isClosed(row: Pick<ThreadRow, "closedAt" | "lastAt" | "sweptAt">): boolean {
  return row.closedAt !== null && row.closedAt !== row.sweptAt && row.closedAt >= row.lastAt;
}

/**
 * Waiting on you, which is never archived whatever its age: Needs you, something else waiting on
 * him (`more`: an unanswered card in it, or any ask in it awaiting him, not only the newest), or Rivet's question
 * still the last word however old.
 */
export function waitsOnYou(summary: Pick<ConversationSummary, "needsYou">, row: Pick<ThreadRow, "lastFrom" | "lastAsks">, more = false): boolean {
  return summary.needsYou || more || (row.lastFrom === "rivet" && row.lastAsks);
}

/**
 * Idle: no message in it, his, Rivet's or a card, for more than IDLE_ARCHIVE_MS, nor his Reopen since. Read from
 * the newest message's time as the list is read, so there is no job and a new message brings it back at once. Never one
 * waiting on you (waitsOnYou), pinned or marked unread.
 */
export function idle(
  summary: Pick<ConversationSummary, "needsYou">,
  row: Pick<ThreadRow, "lastAt" | "lastFrom" | "lastAsks" | "closedAt" | "pinnedAt" | "unreadAt" | "sweptAt">,
  now: number,
): boolean {
  if (waitsOnYou(summary, row) || row.pinnedAt !== null || row.unreadAt !== null) return false;
  // His Reopen (closed_at cleared, swept_at stamped) counts as a message: it stays two hours more.
  const reopened = row.closedAt === null && row.sweptAt !== null && row.sweptAt > row.lastAt ? row.sweptAt : row.lastAt;
  return Date.parse(reopened) < now - IDLE_ARCHIVE_MS;
}

/** One row of the list: the thread's summary, what it links (its ask's, Rivet's steps, what it names), unread and closed. */
export function conversationSummary(
  thread: ThreadSummary,
  row: ThreadRow,
  links: ThreadLinks | undefined,
  unread: number,
  stageOf: (key: string) => ConversationStage | undefined = () => undefined,
  /** Every PR it links now or linked before (`owner/repo#n`, as linkedPrs and conversation_prs give them). */
  linked: readonly string[] = linkedPrs(thread, links),
  /** A card is filed in it. */
  filed = false,
): ConversationSummary {
  // Updates links nothing: no chip, no stage and no merged sweep.
  const own = ownsNoCard(thread.id);
  const prs = new Set<string>();
  const chats = new Map<string, ChatRef>();
  // A name only said, or its status's, adds no repo-less ref beside a linked one: that would match it in every repo.
  const addChat = (chat: string, repo?: string) => {
    const key = `${repo?.toLowerCase() ?? ""}#${chat}`;
    if (chats.has(key) || (!repo && [...chats.values()].some((ref) => ref.chat === chat))) return;
    chats.set(key, { chat, ...(repo ? { repo } : {}) });
  };
  if (!own) {
    for (const pr of links?.prs ?? []) prs.add(prChip(pr));
    for (const ref of links?.said?.refs ?? []) prs.add(prChip(ref));
    if (thread.statusPr !== undefined) prs.add(`#${thread.statusPr}`);
    for (const chat of links?.chats ?? []) addChat(chat.chat, chat.repo);
    for (const chat of links?.said?.words ?? []) addChat(chat);
    if (thread.statusChat !== undefined) addChat(thread.statusChat);
  }
  const shownChats = [...new Set([...chats.values()].map((ref) => ref.chat))].slice(0, CONVERSATION_LINKS_MAX);
  const updates = thread.id === UPDATES_ID;
  const closed = !updates && thread.id !== TEAM_ROOM_ID && isClosed(row);
  const stage = own ? { stage: "none" as const } : conversationStage(uniquePrs(linked), stageOf);
  // The Team room is the agents' talk: a question there is one agent's to another, never your ball.
  const needsYou = thread.ball === "owner" && !closed && thread.id !== TEAM_ROOM_ID;
  return {
    id: thread.id,
    title: thread.title,
    lastAt: thread.lastAt,
    lastFrom: thread.lastFrom,
    lastText: thread.lastText,
    unread,
    needsYou,
    links: {
      prs: [...prs].slice(0, CONVERSATION_LINKS_MAX),
      chats: shownChats,
      // The first refs as before, plus every repo's ref of each chat shown, so a chat two repos link is never cut to one of them.
      chatRefs: [...chats.values()].filter((ref, i) => i < CONVERSATION_LINKS_MAX * 2 || shownChats.includes(ref.chat)),
      tag: updates ? null : (thread.tag ?? (thread.project ? THREAD_PROJECT_LABELS[thread.project] : null)),
    },
    closed,
    updates,
    appOnly: appOnlyThread(thread),
    // The Team room is never news: no unread mark, so no badge.
    markedUnread: row.unreadAt !== null && thread.id !== TEAM_ROOM_ID,
    pinned: row.pinnedAt !== null,
    done: !updates && isDone(row),
    stage: stage.stage,
    ...(stage.pr !== undefined ? { stagePr: stage.pr } : {}),
    phase: own || thread.id === TEAM_ROOM_ID ? null : phaseOf({ needsYou, stage: stage.stage, statusFrom: thread.statusFrom }),
    thing: filed && !own && thread.id !== TEAM_ROOM_ID,
  };
}

/**
 * The list's order: pinned ones first, then the rest; each by its newest message, newest first (`seq`, the order
 * messages arrived in). Updates is not in it.
 */
export function listOrder(rows: readonly { summary: ConversationSummary; seq: number }[]): ConversationSummary[] {
  const top = (summary: ConversationSummary) => (summary.pinned ? 1 : 0);
  return [...rows].sort((a, b) => top(b.summary) - top(a.summary) || b.seq - a.seq).map((row) => row.summary);
}
