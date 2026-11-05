import { createHash } from "node:crypto";

import { DECISION, isGotIt, isUpdate, QUESTION } from "../../shared/answers.js";
import { OPS_STATUS_KINDS } from "../../shared/ops-status.js";
import { chatRepo, comingChatRepo, needSchema, type Board, type BoardChat, type ComingItem, type Need } from "../../shared/board.js";
import { NO_REPO } from "../../shared/board.js";
import { TYPED_FRESH_MS } from "../../shared/workers.js";

// Everything waiting on you becomes one card, made here and nowhere else (plan rivet-information-review §3g.3): a Coming
// row at "Your OK" and a chat whose row says it waits on him. The cards are stored in board.needs like any other, so
// pushes, answers, Reopen and every count work on them unchanged. An ask makes no card of its own, at needs-you or with
// its time moved twice: its row says so, and you have nothing to answer on it.

/** Card ids starting this are the server's own: a writer's are dropped and made again from their source. */
export const WAIT_PREFIX = "wait-";
/** The wait cards still made: a Coming row at Your OK, a chat waiting on you. */
const MADE = /^wait-(ok|chat)-/;
/** A third-late card, as lateCardId names one: a failure's own, so its answer never stands for the next. */
const LATE_CARD = new RegExp(`^late-(${OPS_STATUS_KINDS.join("|")})-[a-z0-9.-]*-[0-9a-f]{12}$`);

/**
 * A card the server no longer raises, or a third-late one: an ask's or a moved time's wait card. Reopen never brings one
 * back.
 */
export const isRetiredCard = (id: string): boolean => (id.startsWith(WAIT_PREFIX) && !MADE.test(id)) || LATE_CARD.test(id);
/** The most wait cards one board holds: a bad source can never flood Cards. */
export const MAX_WAITS = 20;
/**
 * A card you answered this recently still speaks for its chat, PR or ask: the crew has had no time to act on your
 * answer, so a second card for the same wait would ask him twice.
 */
export const ANSWER_QUIET_MS = 2 * 3600_000;

/** A wait card's id before its time: the same for every card one wait makes, so an answer to any of them is its own. */
export const waitStem = (kind: WaitItem["kind"], key: string): string => `${WAIT_PREFIX}${kind}-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
/** A wait card's stem, from its id. */
export const stemOf = (id: string): string => id.replace(/-[0-9a-z]+$/, "");
/**
 * Where a wait card's Yes is kept (WaitInput.yeses): its stem, its repo (an answer always records one) and the PR the
 * card named, so a card that named none (two repos claimed its chat) never answers one that names its PR.
 */
export const yesKey = (stem: string, repo: string | undefined, pr: number | undefined): string => `${stem}\n${repo ?? NO_REPO}\n${pr ?? ""}`;

// Card words, until words.ts (cards-progress PR 1a) lands with these same names.
const yourOk = (title: string) => `Your OK: ${title}`;
const questionFrom = (title: string) => `Question from ${title}`;
const YES = "Yes";
const CHANGE_IT = "Change it";
const okBody = (what: string | undefined, who: string) => `${what ?? "It"} is ready to merge. Yes tells ${who} to merge it; Change it sends ${who} your note.`;
const RIVET = "Rivet";

/** A chat row whose state says it waits on you yourself; a bare "waiting" (on CI, on a GO) is not. */
export const OWNER_WAIT_PATTERN = /\b(?:wait(?:s|ing)?|awaiting)\b.*\b(?:you|your|owner)\b|\bawaiting-owner\b|\bneeds? (?:you|your)\b|\byour ok\b/i;

/** What waits reads of an ask, to title a card. */
export interface AskLike {
  id: string;
  words: string;
  status?: string;
  stage?: string;
  chat?: string;
  prs?: readonly number[];
  repo?: string;
}

/** One thing waiting on you, before it is a card. */
export interface WaitItem {
  kind: "ok" | "chat";
  /** Stable for the thing itself (the Coming row, the chat): one card per key at a time. */
  key: string;
  card: Omit<Need, "id" | "since">;
  chat?: string;
  prs: number[];
  /** The repo its PRs are in; undefined is the default repo, null is two repos claiming its chat. */
  repo?: string | null;
  /** When the wait began, as far as the source knows: the card's `since` on its first run. */
  at?: string;
  /** A Your OK's key before it named its repo: its card and Yes from then are still its own. */
  was?: string;
}

const IN_HAND_DONE = new Set(["merged", "shipped", "parked", "done"]);

/** An ask's title: your words on one line. */
const askName = (ask: AskLike): string => {
  const words = ask.words.replace(/\s+/g, " ").trim();
  return words.length > 280 ? `${words.slice(0, 279)}…` : words;
};

const baseChat = (name: string) => name.replace(/-\d+$/, "");
/** A PR as one repo's: PR numbers repeat across repos. */
const prKey = (repo: string | null | undefined, pr: number) => `${repo ?? NO_REPO}#${pr}`;
/**
 * A chat a card or wait speaks for, within its repo (null when two repos claim it, or a card names none and the default
 * repo has no board chat of its name). An ask's or a card's chat goes by its base name, so it is its re-spawns' too; a
 * board chat's by its own name only, as two board chats are two chats whatever their names.
 */
interface ChatClaim {
  repo: string | null;
  name: string;
  own: boolean;
}
const claimOf = (repo: string | null | undefined, chat: string, own = false): ChatClaim => ({ repo: repo === null ? null : (repo ?? NO_REPO), name: own ? chat : baseChat(chat), own });
/** The claimed chat: by name, in one repo, or in any where either side's repo is not known. */
function sameChat(item: WaitItem, claim: ChatClaim): boolean {
  if (item.chat === undefined) return false;
  const repo = item.repo === null ? null : (item.repo ?? NO_REPO);
  return (claim.own ? claim.name === item.chat : claim.name === baseChat(item.chat)) && (claim.repo === null || repo === null || claim.repo === repo);
}

/**
 * The ask a Coming row or chat stands for: the latest still in hand that names its PR in its repo, else its chat. A
 * repo two chats claim (null) matches no PR, so another repo's ask never titles the card.
 */
function askFor(asks: readonly AskLike[], { pr, chat, repo }: { pr?: number; chat?: string; repo?: string | null }): AskLike | undefined {
  const open = asks.filter((ask) => !IN_HAND_DONE.has(ask.stage ?? ask.status ?? "")).reverse();
  const sameRepo = (ask: AskLike) => repo !== null && (ask.repo ?? NO_REPO) === (repo ?? NO_REPO);
  return (
    (pr !== undefined ? open.find((ask) => sameRepo(ask) && ask.prs?.includes(pr)) : undefined) ??
    (chat !== undefined ? open.find((ask) => ask.chat !== undefined && baseChat(ask.chat) === baseChat(chat) && (repo === null || sameRepo(ask))) : undefined)
  );
}

/** The wait a Coming row at "Your OK" makes: titled with its ask, saying what is waiting and what a yes does. */
export function okWait(row: ComingItem, asks: readonly AskLike[], chats: readonly BoardChat[]): WaitItem | null {
  if (row.stage !== "owner-ok" || typeof row.mergedAt === "string") return null;
  // Null when two repos claim the row's chat: the card then names no PR, so a yes can never land on another repo's.
  const repo = row.chat ? comingChatRepo(chats, row.chat, row.pr) : undefined;
  const ask = askFor(asks, { ...(row.pr !== undefined ? { pr: row.pr } : {}), ...(row.chat ? { chat: row.chat } : {}), repo });
  const title = ask ? askName(ask) : row.title.slice(0, 280);
  const pr = repo === null ? undefined : row.pr;
  // A row of another repo than the default is keyed with its repo, so another repo's row of the PR and chat later is not
  // the same wait; where two repos claim the chat, rows of the PR may be either's, kept apart by their titles.
  const was = `ok\n${row.pr ?? ""}\n${row.chat ?? ""}\n${row.pr === undefined ? row.title : ""}`;
  return {
    kind: "ok",
    key: repo === undefined ? was : `${was}\n${repo === null ? `title ${row.title}` : `repo ${repo}`}`,
    ...(repo !== undefined ? { was } : {}),
    card: {
      kind: DECISION,
      title: yourOk(title),
      ask: okBody(row.what, row.chat ?? RIVET),
      options: [{ label: YES }, { label: CHANGE_IT, text: true }],
      // The answer goes to the card's repo (createReply), so it is always set with the PR.
      ...(pr !== undefined ? { pr, ...(repo ? { repo, links: [{ label: `PR #${pr}`, url: `https://github.com/${repo}/pull/${pr}` }] } : {}) } : {}),
      ...(row.chat ? { chat: row.chat } : {}),
    },
    prs: pr !== undefined ? [pr] : [],
    ...(repo !== undefined ? { repo } : {}),
    ...(row.chat ? { chat: row.chat } : {}),
    ...(row.touchedAt ? { at: row.touchedAt } : row.updatedAt ? { at: row.updatedAt } : {}),
  };
}

/**
 * The wait a chat waiting on you makes: `Question from <ask title>` with the question; with no ask, the question is
 * the title, so the chat is named once, in the card's own line.
 */
export function chatWait(chat: BoardChat, asks: readonly AskLike[], now: Date): WaitItem | null {
  if (!OWNER_WAIT_PATTERN.test(chat.state)) return null;
  const touched = [chat.touchedAt, chat.moved, chat.updatedAt].find((at): at is string => typeof at === "string");
  if (!(now.getTime() - Date.parse(touched ?? "") <= TYPED_FRESH_MS)) return null;
  const repo = typeof chat.repo === "string" ? chat.repo : undefined;
  const question = (chat.doing?.trim() || chat.state).slice(0, 4000);
  const ask = askFor(asks, { chat: chat.name, repo });
  const words = ask ? { title: questionFrom(askName(ask)).slice(0, 300), ask: question } : { title: question.slice(0, 300) };
  return {
    kind: "chat",
    key: `chat\n${repo ?? ""}\n${chat.name}`,
    card: { kind: QUESTION, ...words, reply: "text", chat: chat.name, ...(repo ? { repo } : {}) } as WaitItem["card"],
    chat: chat.name,
    prs: [...(chat.prs ?? [])],
    ...(repo ? { repo } : {}),
    ...(touched ? { at: touched } : {}),
  };
}

export interface WaitInput {
  /** The board as this write leaves it, before its wait cards. */
  board: Board;
  /** The board as stored: its wait cards keep their ids and `since`, and a reopened one stays. */
  stored: Board | null;
  asks: readonly AskLike[];
  /** `<id>\n<rev>` → the last time you answered that revision, for the cards on the board. */
  answers: ReadonlyMap<string, string>;
  rev: (need: Need) => string;
  /** Wait cards you answered in the last ANSWER_QUIET_MS, as their answers recorded them, gone from the board or not. */
  answered?: readonly { id: string; at: string; chat?: string; pr?: number; repo?: string }[];
  /**
   * yesKey → when you answered Yes, that being the latest answer on any of the wait's cards.
   */
  yeses?: ReadonlyMap<string, string>;
  /** The most cards the board takes; wait cards never push it over. */
  room: number;
  now: Date;
}

/**
 * The board with its wait cards made again from their sources: the writer's `wait-` cards go, one card per wait comes
 * back. A wait gives no card while a card you can still act on (not news, not answered, or answered under
 * ANSWER_QUIET_MS ago) already names its chat or PR. A stored wait card keeps its id and `since` while
 * its source holds, so its answer stays its answer and nothing is pushed twice; one you reopened stays until answered.
 */
export function withWaits({ board, stored, asks, answers, answered = [], yeses = new Map(), rev, room, now }: WaitInput): Board {
  const others = board.needs.filter((need) => !need.id.startsWith(WAIT_PREFIX));
  const lastAnswer = (need: Need): number => Date.parse(answers.get(`${need.id}\n${rev(need)}`) ?? "");
  const speaksFor = others.filter((need) => {
    if (isUpdate(need) || isGotIt(need)) return false;
    const answered = lastAnswer(need);
    return !Number.isFinite(answered) || now.getTime() - answered < ANSWER_QUIET_MS;
  });
  // A card that names no repo speaks for its chat in the default repo; in any repo only while the default repo has no
  // board chat of its name, as the monitor often leaves the repo off another repo's chat's cards.
  const defaultChats = new Set(board.chats.flatMap((chat) => ((chatRepo(chat) ?? NO_REPO) === NO_REPO ? [baseChat(chat.name)] : [])));
  const chats = speaksFor.flatMap((need) => (need.chat ? [claimOf(need.repo ?? (defaultChats.has(baseChat(need.chat)) ? NO_REPO : null), need.chat)] : []));
  const prs = new Set(speaksFor.flatMap((need) => (need.pr !== undefined ? [prKey(need.repo, need.pr)] : [])));

  const items = [
    ...board.coming.map((row) => okWait(row, asks, board.chats)),
    ...board.chats.map((chat) => chatWait(chat, asks, now)),
  ].filter((item): item is WaitItem => item !== null);

  const storedWaits = (stored?.needs ?? []).filter((need) => need.id.startsWith(WAIT_PREFIX));
  const byKey = new Map(storedWaits.flatMap((need) => (typeof need.waitKey === "string" ? [[need.waitKey, need] as const] : [])));
  // A Your OK keyed before keys named a repo (`was`) keeps its card when it alone had that key and the card names its PR and repo.
  const wasCount = new Map<string, number>();
  for (const item of items) if (item.was !== undefined) wasCount.set(item.was, (wasCount.get(item.was) ?? 0) + 1);
  // Where two repos claim the chat, every row of the PR had the one old key: its card is this row's only by its title.
  const onlyWas = (item: WaitItem): string | undefined =>
    item.was !== undefined && wasCount.get(item.was) === 1 && (item.repo !== null || byKey.get(item.was)?.title === item.card.title) ? item.was : undefined;
  // A Your OK's stored card is its own only when it names the same PR and repo: a default-repo row's key is the bare one
  // a card of another repo's row had before keys named a repo.
  const sameOk = (item: WaitItem, card: Need | undefined) => (item.kind !== "ok" || (card?.pr === item.card.pr && card?.repo === item.card.repo) ? card : undefined);
  const storedOf = (item: WaitItem): Need | undefined => {
    const own = sameOk(item, byKey.get(item.key));
    if (own) return own;
    const was = onlyWas(item);
    return was === undefined ? undefined : sameOk(item, byKey.get(was));
  };
  // A Your OK whose chat two repos claim names no PR, and an answer to another such card is that row's alone (its reply
  // records the default repo for a card with none).
  const othersAmbiguous = (item: WaitItem, one: { id: string; pr?: number }) =>
    item.kind === "ok" && item.repo === null && one.id.startsWith(`${WAIT_PREFIX}ok-`) && one.pr === undefined && stemOf(one.id) !== waitStem(item.kind, item.key);
  // An answered wait card still speaks for its chat and PR for a while, its card gone or not; never for its own wait,
  // whose card keeps its id (and so its answer) while it stays.
  const quiet = answered.filter((one) => now.getTime() - Date.parse(one.at) < ANSWER_QUIET_MS);
  const answeredFor = (item: WaitItem): boolean =>
    quiet.some(
      (one) =>
        one.id !== storedOf(item)?.id &&
        !othersAmbiguous(item, one) &&
        ((one.chat !== undefined && item.chat !== undefined && sameChat(item, claimOf(one.repo, one.chat, one.id.startsWith(`${WAIT_PREFIX}chat-`)))) ||
          (one.pr !== undefined && item.repo !== null && item.prs.some((pr) => prKey(item.repo, pr) === prKey(one.repo, one.pr!)))),
    );
  // Your Yes answers a Your OK until its source changes after it: a Coming row still at owner-ok and untouched
  // since. A card gone from the board is not made again for it. The time of the later Yes, else NaN.
  const saidYes = (item: WaitItem): number => {
    if (item.kind !== "ok") return NaN;
    const { repo, pr } = item.card;
    const yesAt = (stem: string) => Date.parse(yeses.get(yesKey(stem, typeof repo === "string" ? repo : undefined, typeof pr === "number" ? pr : undefined)) ?? "");
    const was = onlyWas(item);
    const times = [yesAt(waitStem(item.kind, item.key)), was !== undefined ? yesAt(waitStem(item.kind, was)) : NaN].filter(Number.isFinite);
    const yes = times.length ? Math.max(...times) : NaN;
    if (!Number.isFinite(yes)) return NaN;
    const since = Date.parse(item.at ?? "");
    return !Number.isFinite(since) || yes >= since ? yes : NaN;
  };
  // A wait its Yes keeps off the board still speaks for its chat and PR, for another wait unchanged since that Yes
  // (the chat's own): one that spoke after it asks afresh.
  const yesClaims: { chat?: ChatClaim; prs: string[]; at: number }[] = [];
  const yesCovered = (item: WaitItem): boolean => {
    const since = Date.parse(item.at ?? "");
    return yesClaims.some(
      (claim) =>
        !(since > claim.at) &&
        ((claim.chat !== undefined && sameChat(item, claim.chat)) || (item.repo !== null && item.prs.some((pr) => claim.prs.includes(prKey(item.repo, pr))))),
    );
  };
  const made: Need[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (made.length >= MAX_WAITS || seen.has(item.key)) continue;
    const covered =
      (item.chat !== undefined && chats.some((claim) => sameChat(item, claim))) ||
      (item.repo !== null && item.prs.some((pr) => prs.has(prKey(item.repo, pr))));
    if (covered || yesCovered(item) || answeredFor(item)) continue;
    seen.add(item.key);
    // A card still on the board keeps its answer as it is; a Yes stops only a new one.
    const yes = storedOf(item) ? NaN : saidYes(item);
    if (Number.isFinite(yes)) {
      yesClaims.push({
        ...(item.chat && item.repo !== null ? { chat: claimOf(item.repo, item.chat, item.kind === "chat") } : {}),
        prs: item.repo !== null ? item.prs.map((pr) => prKey(item.repo, pr)) : [],
        at: yes,
      });
      continue;
    }
    // What it covers now belongs to this card: a later wait on the same chat or PR is the same item.
    // A wait whose chat two repos claim speaks for neither repo's chat: either may wait on you on its own.
    if (item.chat && item.repo !== null) chats.push(claimOf(item.repo, item.chat, item.kind === "chat"));
    if (item.repo !== null) for (const pr of item.prs) prs.add(prKey(item.repo, pr));
    const before = storedOf(item);
    const card = { ...item.card, waitKey: item.key } as unknown as Need;
    if (before) {
      // Reopened and not yet answered, it stays as you reopened it: made again from its source, it would fall back to
      // the revision you answered and vanish, and a write keeps Answer again only on an unchanged card (withAgain).
      if (before.again && !answers.has(`${before.id}\n${rev(before)}`)) {
        made.push(before);
        continue;
      }
      made.push({ ...card, id: before.id, ...(before.since ? { since: before.since } : {}) });
      continue;
    }
    const startedAt = Date.parse(item.at ?? "");
    const since = Number.isFinite(startedAt) && startedAt <= now.getTime() ? new Date(startedAt) : now;
    const id = `${waitStem(item.kind, item.key)}-${now.getTime().toString(36)}`;
    const need = { ...card, id, since: since.toISOString() };
    if (needSchema.safeParse(need).success) made.push(need);
  }
  // A wait card you reopened stays until you answer it again, its source ended or not; one of a kind no longer made
  // (an ask's, a moved time's) goes.
  const madeIds = new Set(made.map((need) => need.id));
  const reopened = storedWaits.filter((need) => need.again && MADE.test(need.id) && !madeIds.has(need.id) && !answers.has(`${need.id}\n${rev(need)}`));
  const space = Math.max(0, room - others.length);
  return { ...board, needs: [...others, ...[...reopened, ...made].slice(0, space)] };
}

/** A writer's board without its `wait-` cards, before validation: they are made again, never taken from a write. */
export function withoutWaits(board: unknown): unknown {
  const needs = (board as { needs?: unknown } | null)?.needs;
  if (!Array.isArray(needs)) return board;
  return { ...(board as object), needs: needs.filter((need: { id?: unknown } | null) => !(typeof need?.id === "string" && need.id.startsWith(WAIT_PREFIX))) };
}

/** The wait cards a board holds. */
export const isWait = (need: Pick<Need, "id">): boolean => need.id.startsWith(WAIT_PREFIX);
