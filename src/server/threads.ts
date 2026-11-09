import type { Ask } from "../shared/asks.js";
import type { Reply } from "../shared/board.js";
import type { MergedPr } from "./stamps.js";
import { NO_REPO } from "../shared/board.js";
import {
  askThreadStatus,
  ballOf,
  QUESTION_MAX_AGE_MS,
  idLike,
  isOpen,
  namesPr,
  STEP_KINDS,
  STEP_LABELS,
  stepPr,
  threadStatus,
  textMentions,
  threadTitle,
  type Mentions,
  type PrRef,
  type CardThread,
  type StatusFacts,
  type ThreadProject,
  type ThreadStep,
  type ThreadSummary,
} from "../shared/threads.js";
import type { StoredStep, ThreadRow } from "./commandstore.js";

// What a thread shows that nobody set: its status from real state (cards, the ask, open chats, open and merged PRs),
// its project from the ask linked to it, and timeline steps from that ask, merged PRs and your card answers. Worked
// out on every read, so nothing derived is ever stale.

const ONE_LINE = 160;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > ONE_LINE ? `${flat.slice(0, ONE_LINE - 1).trimEnd()}…` : flat;
}

/** The project an ask points at: a Rivet chat, else none. */
export function askProject(ask: Ask): ThreadProject | null {
  return ask.chat && /^rivet\b/i.test(ask.chat) ? "rivet" : null;
}

/**
 * The ask linked to each thread: one whose `replyId` is a message in it, or what its first message answers (a card
 * reply). Where several are, the one changed last.
 */
export function asksByThread(asks: readonly Ask[], rows: readonly Pick<ThreadRow, "id" | "rootReplyTo">[], threadOf: (id: string) => string | null): Map<string, Ask> {
  return new Map([...allAsksByThread(asks, rows, threadOf)].map(([thread, linked]) => [thread, linked[0]!]));
}

/** Every ask in each thread, newest first: a thread asked several times links the cards of each. */
export function allAsksByThread(asks: readonly Ask[], rows: readonly Pick<ThreadRow, "id" | "rootReplyTo">[], threadOf: (id: string) => string | null): Map<string, Ask[]> {
  const byRootReply = new Map<string, string>();
  for (const row of rows) if (row.rootReplyTo !== null && !byRootReply.has(row.rootReplyTo)) byRootReply.set(row.rootReplyTo, row.id);
  const linked = new Map<string, Ask[]>();
  for (const ask of asks) {
    if (!ask.replyId) continue;
    const thread = threadOf(ask.replyId) ?? byRootReply.get(ask.replyId);
    if (!thread) continue;
    linked.set(thread, [...(linked.get(thread) ?? []), ask]);
  }
  // Stable: of two asks updated at once, the one listed first stays newest.
  for (const list of linked.values()) list.sort((a, b) => (a.updatedAt === b.updatedAt ? 0 : a.updatedAt > b.updatedAt ? -1 : 1));
  return linked;
}

/**
 * What is live now, read once per list: GitHub's open PRs and the merged ones (the bridge's ops push), the cards on the
 * board you have not answered, and the chats the bridge sees open.
 */
export interface LiveState {
  /** prKey of every PR GitHub lists as open. */
  openPrs: ReadonlySet<string>;
  merged: ReadonlyMap<string, MergedPr>;
  cards: readonly { id?: string; repo: string; pr?: number; chat?: string }[];
  /** `<repo>\n<chat>`, lower case, of every open chat. */
  chats: ReadonlySet<string>;
}

export const NO_LIVE_STATE: LiveState = { openPrs: new Set(), merged: new Map(), cards: [], chats: new Set() };

export function liveState(input: {
  openPrs: readonly { repo: string; number: number }[];
  merged: readonly MergedPr[];
  cards: readonly { id?: string; repo?: string; pr?: number; chat?: string }[];
  chats: readonly { repo: string; chat: string }[];
}): LiveState {
  return {
    openPrs: new Set(input.openPrs.map((pr) => prKey(pr.repo, pr.number))),
    merged: new Map(input.merged.map((pr) => [prKey(pr.repo, pr.number), pr])),
    cards: input.cards.map((card) => ({ ...card, repo: card.repo ?? NO_REPO })),
    chats: new Set(input.chats.map((chat) => chatKey(chat.repo, chat.chat))),
  };
}

function chatKey(repo: string, chat: string): string {
  return `${repo}\n${chat}`.toLowerCase();
}

/** The PRs a thread names: its ask's and Rivet's PR steps, each with the repo its link names. */
function threadPrs(ask: Ask | undefined, stored: readonly StoredStep[]): { repo: string; number: number }[] {
  const repo = ask?.repo ?? NO_REPO;
  const prs = new Map<string, { repo: string; number: number }>();
  for (const number of ask?.prs ?? []) prs.set(prKey(repo, number), { repo, number });
  for (const step of stored) {
    if (step.kind !== "pr") continue;
    const number = stepPr(step);
    if (number === null) continue;
    const named = stepRepo(step, repo);
    prs.set(prKey(named, number), { repo: named, number });
  }
  return [...prs.values()];
}

/** The chats a thread names: its ask's, and Rivet's chat steps ("Chat <name>"). */
function threadChats(ask: Ask | undefined, stored: readonly StoredStep[]): { repo: string; chat: string }[] {
  const repo = ask?.repo ?? NO_REPO;
  const chats = ask?.chat ? [{ repo, chat: ask.chat }] : [];
  for (const step of stored) {
    const named = step.kind === "chat" ? /^chat\s+([A-Za-z0-9._-]+)$/i.exec(step.label) : null;
    if (named) chats.push({ repo, chat: named[1]! });
  }
  return chats;
}

const NO_MENTIONS: Mentions = { refs: [], words: new Set() };

/** What `said` (a thread's messages) names: its PRs, and whether it names a chat id as a word (idLike ids only). */
function mentions(said: Mentions): { refs: PrRef[]; namesChat: (chat: string) => boolean } {
  return { refs: said.refs, namesChat: (chat) => idLike(chat) && said.words.has(chat.toLowerCase()) };
}

export type CardItem = { id?: string; repo?: string; pr?: number; chat?: string };

/** What a thread links cards by: its ask's card, its PRs and its chats, and what its messages name (`said`). */
export interface ThreadLinks {
  ids: string[];
  prs: { repo: string; number: number }[];
  chats: { repo: string; chat: string }[];
  said?: Mentions;
}

/** What a thread links cards by, from every ask in it (newest first), Rivet's steps and what its messages name. */
export function threadLinks(asks: readonly Ask[], stored: readonly StoredStep[], said?: Mentions): ThreadLinks {
  const prs = new Map<string, ThreadLinks["prs"][number]>();
  const chats = new Map<string, ThreadLinks["chats"][number]>();
  for (const [index, ask] of asks.entries()) {
    for (const pr of threadPrs(ask, index === 0 ? stored : [])) prs.set(prKey(pr.repo, pr.number), pr);
    for (const chat of threadChats(ask, index === 0 ? stored : [])) chats.set(chatKey(chat.repo, chat.chat), chat);
  }
  if (!asks.length) {
    for (const pr of threadPrs(undefined, stored)) prs.set(prKey(pr.repo, pr.number), pr);
    for (const chat of threadChats(undefined, stored)) chats.set(chatKey(chat.repo, chat.chat), chat);
  }
  return {
    ids: [...new Set(asks.flatMap((ask) => (ask.cardId !== undefined ? [ask.cardId] : [])))],
    prs: [...prs.values()],
    chats: [...chats.values()],
    ...(said ? { said } : {}),
  };
}

/**
 * How strongly a card (or the card an answer was for) is the thread's: 5 its ask names it, 4 one of its PRs, 3 one of
 * its chats, 2 a PR its messages name, 1 a chat its messages name, 0 not. A thread that only mentions a PR or chat never
 * outranks one whose ask or Rivet's steps link it.
 */
function cardMatch(links: ThreadLinks): (item: CardItem) => number {
  const keys = new Set(links.prs.map((pr) => prKey(pr.repo, pr.number)));
  const chatKeys = new Set(links.chats.map((chat) => chatKey(chat.repo, chat.chat)));
  const { refs, namesChat } = mentions(links.said ?? NO_MENTIONS);
  return (item) => {
    if (item.id !== undefined && links.ids.includes(item.id)) return 5;
    if (item.pr !== undefined && keys.has(prKey(item.repo ?? NO_REPO, item.pr))) return 4;
    if (item.chat !== undefined && chatKeys.has(chatKey(item.repo ?? NO_REPO, item.chat))) return 3;
    if (item.pr !== undefined && refs.some((ref) => namesPr(ref, { repo: item.repo ?? NO_REPO, number: item.pr! }))) return 2;
    if (item.chat !== undefined && namesChat(item.chat)) return 1;
    return 0;
  };
}

/**
 * A thread's facts beyond its messages: an unanswered card, an open chat, an open or merged PR, and a shipped mark. A PR
 * or chat its messages name (`said`) counts as one of its own. `owns` says how strongly a card is this thread's, 0 for
 * another's: the list passes cardOwner's word, so a card's Round line and the thread's Your OK always agree.
 */
export function statusFacts(
  ask: Ask | undefined,
  stored: readonly StoredStep[],
  live: LiveState,
  said: Mentions = NO_MENTIONS,
  owns: (item: CardItem) => number = cardMatch(threadLinks(ask ? [ask] : [], stored, said)),
): Pick<StatusFacts, "card" | "chat" | "openPr" | "merged" | "shippedAt"> {
  const prs = threadPrs(ask, stored);
  const keys = new Set(prs.map((pr) => prKey(pr.repo, pr.number)));
  const chats = threadChats(ask, stored);
  const { refs, namesChat } = mentions(said);
  const hasPr = (pr: { repo: string; number: number }) => keys.has(prKey(pr.repo, pr.number)) || refs.some((ref) => namesPr(ref, pr));
  let card: (typeof live.cards)[number] | undefined;
  let best = 0;
  for (const one of live.cards) {
    const strength = owns(one);
    if (strength > best) [card, best] = [one, strength];
  }
  const open = prs.find((pr) => live.openPrs.has(prKey(pr.repo, pr.number))) ?? [...live.openPrs].map(parsePrKey).find(hasPr);
  let merged: MergedPr | undefined;
  for (const pr of keys.size > 0 || refs.length > 0 ? live.merged.values() : []) {
    if (hasPr(pr) && (!merged || pr.mergedAt > merged.mergedAt)) merged = pr;
  }
  const shippedAts = [...(ask?.stage === "shipped" ? [ask.stageAt] : []), ...stored.filter((step) => step.kind === "shipped").map((step) => step.at)].sort();
  const openChats = [...live.chats].map((key) => key.split("\n")[1]!);
  return {
    card: card ? { ...(card.id !== undefined ? { id: card.id } : {}), ...(card.pr !== undefined ? { pr: card.pr } : {}) } : null,
    chat: chats.find((chat) => live.chats.has(chatKey(chat.repo, chat.chat)))?.chat ?? openChats.find(namesChat) ?? null,
    openPr: open?.number ?? null,
    merged: merged ? { pr: merged.number, at: merged.mergedAt } : null,
    shippedAt: shippedAts.at(-1) ?? null,
  };
}

/**
 * The thread a Rivet note that answers nothing belongs in: the first of `threads` (newest first) whose messages
 * (`said`, by thread), asks (every one, as threadLinks) or Rivet's steps name a PR the note names (namedPrs), or whose
 * ask, card or chat id, or an open chat (`chats`) its messages name, the note names too (idLike ids only). A thread whose last word is Rivet's
 * question is passed over: filing would end its Needs you. Null starts a new thread.
 */
export function noticeThread(
  text: string,
  threads: readonly { id: string; asks: readonly Ask[]; steps: readonly StoredStep[]; asking: boolean }[],
  said: ReadonlyMap<string, Mentions>,
  chats: readonly string[],
): string | null {
  return noticeThreads(text, threads, said, chats)[0] ?? null;
}

/** Every thread noticeThread could file the note in, newest first: a conversation takes it only when it is the one. */
export function noticeThreads(
  text: string,
  threads: readonly { id: string; asks: readonly Ask[]; steps: readonly StoredStep[]; asking: boolean }[],
  said: ReadonlyMap<string, Mentions>,
  chats: readonly string[],
): string[] {
  const found: string[] = [];
  const note = mentions(textMentions(text));
  const sameRef = (a: PrRef, b: PrRef) => a.number === b.number && (a.repo === null || b.repo === null || a.repo === b.repo);
  for (const thread of threads) {
    if (thread.asking) continue;
    const its = mentions(said.get(thread.id) ?? NO_MENTIONS);
    if (its.refs.some((ref) => note.refs.some((mine) => sameRef(ref, mine)))) {
      found.push(thread.id);
      continue;
    }
    const links = threadLinks(thread.asks, thread.steps);
    if (links.prs.some((pr) => note.refs.some((ref) => namesPr(ref, pr)))) {
      found.push(thread.id);
      continue;
    }
    const ids = [...thread.asks.map((ask) => ask.id), ...links.ids, ...links.chats.map((chat) => chat.chat), ...chats.filter(its.namesChat)];
    if (ids.some((id) => !!id && note.namesChat(id))) found.push(thread.id);
  }
  return found;
}

/** Where Rivet filed the thread, your Move aside: the monitor's project, else the ask's, else the titler's. */
export function filedProject(row: Pick<ThreadRow, "rivetProject" | "aiProject">, ask: Ask | undefined): ThreadProject | null {
  return row.rivetProject ?? (ask ? askProject(ask) : null) ?? row.aiProject;
}

export function summarize(row: ThreadRow, ask: Ask | undefined, now: Date, facts: Partial<StatusFacts> = {}): ThreadSummary {
  const { status, from, pr, chat, card } = threadStatus({
    ...facts,
    set: row.status && row.statusAt ? { status: row.status, at: row.statusAt } : null,
    ask: ask ? { status: askThreadStatus(ask.stage), at: ask.stageAt } : null,
    question: row.lastFrom === "rivet" && row.lastAsks && now.getTime() - Date.parse(row.lastWordAt) <= QUESTION_MAX_AGE_MS ? row.lastWordAt : null,
    lastOwnerAt: row.lastOwnerAt,
  });
  const filed = filedProject(row, ask);
  return {
    id: row.id,
    title: row.ownerTitle ?? row.title ?? row.aiTitle ?? threadTitle(row.rootText, { images: row.rootImages, files: row.rootFiles }),
    status,
    statusFrom: from,
    ...(pr !== undefined ? { statusPr: pr } : {}),
    ...(chat !== undefined ? { statusChat: chat } : {}),
    ...(card !== undefined ? { statusCard: card } : {}),
    // Your Move stands even when it left the project empty (Unsorted).
    project: row.movedAt !== null ? row.project : filed,
    ...(filed !== null ? { filed } : {}),
    tag: row.tag,
    ball: ballOf(status),
    startedBy: row.rootFrom,
    count: row.count,
    lastAt: row.lastAt,
    lastFrom: row.lastFrom,
    lastText: oneLine(row.lastText) || (row.lastFiles ? "File" : "Photo"),
    ...(ask ? { ask: ask.id } : {}),
  };
}

/** A thread as card ownership sees it: what it links cards by, and when it was last active. */
export interface LinkedThread {
  id: string;
  lastAt: string;
  links: ThreadLinks;
}

/**
 * Which thread a card (or the card an answer was for) is: the one whose ask names it, else one naming its PR, else its
 * chat, the most recently active winning a tie. The one rule for a card's Round line and a thread's Your OK.
 */
export function cardOwner(threads: readonly LinkedThread[]): (item: CardItem) => { thread: string; strength: number } | null {
  const linked = threads.map((thread) => ({ thread, match: cardMatch(thread.links) }));
  return (item) => {
    let owner: LinkedThread | undefined;
    let best = 0;
    for (const { thread, match } of linked) {
      const strength = match(item);
      if (strength > best || (strength > 0 && strength === best && thread.lastAt > owner!.lastAt)) [owner, best] = [thread, strength];
    }
    return owner ? { thread: owner.id, strength: best } : null;
  };
}

/**
 * The thread each open card belongs to (cardOwner) and its round there: one more than the cards you already answered
 * that belong, by the same rule, to that thread.
 */
export function cardThreads(
  threads: readonly { summary: Pick<ThreadSummary, "id" | "title" | "lastAt">; links: ThreadLinks }[],
  cards: readonly (CardItem & { id: string; rev: string })[],
  repliesFor: (links: ThreadLinks) => readonly Pick<Reply, "itemId" | "rev" | "item">[],
): CardThread[] {
  const byId = new Map(threads.map((thread) => [thread.summary.id, thread]));
  const ownerOf = cardOwner(threads.map((thread) => ({ id: thread.summary.id, lastAt: thread.summary.lastAt, links: thread.links })));
  return cards.flatMap((card) => {
    const owner = byId.get(ownerOf(card)?.thread ?? "");
    if (!owner) return [];
    const answered = new Set(
      repliesFor(owner.links)
        .filter((reply) => !(reply.itemId === card.id && reply.rev === card.rev) && ownerOf({ ...reply.item, id: reply.itemId })?.thread === owner.summary.id)
        .map((reply) => `${reply.itemId}\n${reply.rev}`),
    );
    return [{ card: card.id, thread: owner.summary.id, title: owner.summary.title, round: answered.size + 1 }];
  });
}

export type ThreadCounts = Record<ThreadProject | "all" | "none", number>;

export function openCounts(threads: readonly ThreadSummary[], projects: readonly ThreadProject[]): ThreadCounts {
  const counts = { all: 0, none: 0, ...Object.fromEntries(projects.map((project) => [project, 0])) } as ThreadCounts;
  for (const thread of threads) {
    if (!isOpen(thread.status)) continue;
    counts.all++;
    counts[thread.project ?? "none"]++;
  }
  return counts;
}

function prKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

export function parsePrKey(key: string): { repo: string; number: number } {
  const at = key.lastIndexOf("#");
  return { repo: key.slice(0, at), number: Number(key.slice(at + 1)) };
}

function stepRepo(step: Pick<ThreadStep, "url">, fallback: string): string {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//.exec(step.url ?? "");
  return match ? match[1]! : fallback;
}

/**
 * A thread's timeline, oldest first: the first message as the ask (your threads), the linked ask's chat, PRs and
 * shipped mark, Rivet's steps, each PR's merge, and your OK on a card for one of those PRs.
 */
export function threadSteps(input: {
  row: Pick<ThreadRow, "id" | "rootFrom">;
  rootAt: string;
  ask: Ask | undefined;
  stored: readonly StoredStep[];
  merged: readonly MergedPr[];
  /** Your card answers for these PR numbers. */
  replies: (prs: { repo: string; number: number }[]) => readonly Reply[];
}): ThreadStep[] {
  const { row, ask } = input;
  const repo = ask?.repo ?? NO_REPO;
  const steps: ThreadStep[] = [];
  if (row.rootFrom === "owner") steps.push({ kind: "ask", label: "You asked", at: input.rootAt, auto: true, messageId: row.id });
  if (ask) {
    if (ask.chat) steps.push({ kind: "chat", label: `Chat ${ask.chat}`, at: ask.createdAt, auto: true });
    // The ask records no time per PR: dated with the ask, so a later change to it never moves them past their merge.
    for (const pr of ask.prs) steps.push({ kind: "pr", label: `PR #${pr}`, ...(repo ? { url: `https://github.com/${repo}/pull/${pr}` } : {}), at: ask.createdAt, auto: true });
    if (ask.stage === "shipped") steps.push({ kind: "shipped", label: STEP_LABELS.shipped, at: ask.stageAt, auto: true });
  }
  for (const step of input.stored) steps.push({ ...step });
  // Each PR once, with the repo its link names.
  const prs = new Map<string, { repo: string; number: number }>();
  for (const step of steps) {
    if (step.kind !== "pr") continue;
    const number = stepPr(step);
    if (number === null) continue;
    const stepRepoName = stepRepo(step, repo);
    prs.set(prKey(stepRepoName, number), { repo: stepRepoName, number });
  }
  for (const pr of input.merged) {
    if (!prs.has(prKey(pr.repo, pr.number))) continue;
    steps.push({ kind: "pr", label: `PR #${pr.number} merged`, url: pr.url, at: pr.mergedAt, auto: true });
  }
  for (const reply of input.replies([...prs.values()])) {
    const pr = reply.item.pr;
    if (pr === undefined || !prs.has(prKey(reply.item.repo ?? NO_REPO, pr))) continue;
    if (reply.decision !== "approve" && reply.decision !== "choice" && reply.decision !== "done") continue;
    const said = reply.decision === "choice" && reply.choice ? `: ${oneLine(reply.choice)}` : "";
    steps.push({ kind: "ok", label: `Your OK on PR #${pr}${said}`, ...(reply.item.repo ? { url: `https://github.com/${reply.item.repo}/pull/${pr}` } : {}), at: reply.at, auto: true });
  }
  // The same step from two sources (an ask's PR and Rivet's) shows once, the first kept.
  const seen = new Set<string>();
  const unique = steps.filter((step) => {
    const key = `${step.kind}|${step.label}|${step.url ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || STEP_KINDS.indexOf(a.kind) - STEP_KINDS.indexOf(b.kind));
}
