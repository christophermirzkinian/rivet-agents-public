import { askPrRepo, sameRepo, workerOfAsk, type MergedReading } from "./ask-stages.js";
import { isFinished, moves, type Ask } from "./asks.js";
import { chatRepo, CHAT_PATTERN, comingChatRepo, COMING_STAGES, MAX_ETA_MINUTES, NO_REPO, type ComingItem, type Repo } from "./board.js";
import { chatName } from "./names.js";
import { underWay } from "./ops-owned.js";
import { opsStatusKey } from "./ops-status-key.js";
import type { OpsStatus } from "./ops-status.js";
import { isRepo } from "./repos.js";
import type { PushQueueRow, Worker } from "./workers.js";

// One summary: every count Rivet shows, from the functions Progress builds its
// lists with. GET /api/summary serves it; the badge, the Progress mark, the Cards empty line and the desk bubble read it.
// An ask in hand is an ask record (src/shared/asks.ts); Rivet's own Ops records count beside them in the mark.

export interface AskCounts {
  /** Your unfinished asks, Your OK ones included: the rows Your asks lists above its folds. */
  inHand: number;
  /** Asks and Rivet's own records whose time has passed with none given since: "No time yet". */
  noTime: number;
  /** Asks and Rivet's own records whose time has moved twice. */
  moved: number;
}

export interface Summary {
  /** Cards waiting on you, less those you minimised at their revision: the badge. */
  needsYou: number;
  /** Open cards you minimised at their revision: "Nothing needs you. N minimised". */
  minimised: number;
  asks: AskCounts;
  /** The earliest done-by time ahead among asks in hand the mark does not count. */
  nextDoneAt: string | null;
}

/** Open cards → the badge's count and the minimised one. A minimise from an older revision no longer holds. */
export function needCounts(needs: readonly { id: string; rev: string }[], minimised: ReadonlyMap<string, string>): Pick<Summary, "needsYou" | "minimised"> {
  const small = needs.filter((need) => minimised.get(need.id) === need.rev).length;
  return { needsYou: needs.length - small, minimised: small };
}

// ---- Coming rows, as Progress and the Feed list them

/** No touch for this long and a row says so; for COMING_STALE_MS it moves under Stale. */
export const COMING_QUIET_MS = 2 * 3600_000;
export const COMING_STALE_MS = 6 * 3600_000;

const str = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.trim() && value.length <= max ? value : undefined);
const num = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : undefined;

/**
 * The item with every newer field it cannot use dropped. The server passes stored boards through without
 * re-validating them, and before 2026-09-30 a coming item kept any extra key, so an old board can hold a
 * `stage` or `updatedAt` of any type; this keeps such a board rendering as title-only cards.
 */
export function cleanComing(item: ComingItem): ComingItem {
  const raw = item as Record<string, unknown>;
  const stage = COMING_STAGES.find((known) => known === raw.stage);
  const eta = num(raw.etaMinutes, 0, MAX_ETA_MINUTES);
  return {
    title: str(raw.title, 300) ?? "Untitled",
    ...(num(raw.pr, 1, 1_000_000_000) !== undefined && Number.isInteger(raw.pr) ? { pr: raw.pr as number } : {}),
    ...(str(raw.app, 80) ? { app: raw.app as string } : {}),
    ...(str(raw.what, 200) ? { what: raw.what as string } : {}),
    ...(stage ? { stage } : {}),
    ...(num(raw.progress, 0, 1) !== undefined ? { progress: raw.progress as number } : {}),
    ...(eta !== undefined ? { etaMinutes: Math.round(eta) } : {}),
    ...(str(raw.updatedAt, 64) ? { updatedAt: raw.updatedAt as string } : {}),
    ...(str(raw.requestedAt, 64) ? { requestedAt: raw.requestedAt as string } : {}),
    ...(str(raw.touchedAt, 64) ? { touchedAt: raw.touchedAt as string } : {}),
    ...(str(raw.mergedAt, 64) ? { mergedAt: raw.mergedAt as string } : {}),
    ...(typeof raw.chat === "string" && CHAT_PATTERN.test(raw.chat) ? { chat: raw.chat } : {}),
    // A row made from a chat at work keeps that chat's repo (comingRows).
    ...(isRepo(raw.chatRepo) ? { chatRepo: raw.chatRepo } : {}),
  };
}

/** Merged or deployed: nothing left to age. */
export function comingDone(item: ComingItem): boolean {
  return typeof item.mergedAt === "string" || item.stage === "shipped";
}

/** How long since a write last touched the item (`touchedAt`, else `updatedAt`); null when done or never stamped. */
export function comingQuietMs(item: ComingItem, now = Date.now()): number | null {
  if (comingDone(item)) return null;
  // A board stored before the schemas can hold these as any type (cleanComing).
  const at = Date.parse([item.touchedAt, item.updatedAt].find((one): one is string => typeof one === "string") ?? "");
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

/** Coming items nobody has touched for COMING_STALE_MS; they wait under Stale, not in the list. */
export function isStaleComing(item: ComingItem, now = Date.now()): boolean {
  return (comingQuietMs(item, now) ?? 0) >= COMING_STALE_MS;
}

/** A working chat, Rivet left out: the Town's pill, place chips and hut signs, the Feed and Progress all count these. */
export function isWorking(worker: Worker): boolean {
  return worker.state === "working" && !worker.rivet;
}

/** The key `comingRows` files each chat's held row under: its repo and its name. */
export const chatKey = (repo: string | undefined, chat: string): string => `${repo ?? NO_REPO}\n${chat}`;

/** A chat's own row keeps the chat's repo, so it opens that chat even where another repo has one of the same name. */
export const chatRowRepo = (item: ComingItem): Repo | undefined => (item as { chatRepo?: Repo }).chatRepo;

function fromChat(worker: Worker): ComingItem {
  return {
    title: worker.what ?? worker.doing ?? chatName(worker.chat),
    chat: worker.chat,
    chatRepo: worker.repo,
    stage: "building",
    ...(worker.progress !== undefined ? { progress: worker.progress } : {}),
    ...(worker.etaMinutes !== undefined ? { etaMinutes: Math.round(worker.etaMinutes) } : {}),
    ...(worker.updatedAt ? { updatedAt: worker.updatedAt } : {}),
  };
}

/**
 * Coming with the chats at work in it: each holds one row, its first item still on its way and not waiting on you,
 * else a row made from the chat. In progress is those rows, so it counts exactly the chats the Desks tab and the desks
 * count. Run again on its own rows it adds none.
 * `repoOf` gives an item's repo as the Feed reads it (null: two repos claim it), so a chat only holds its own repo's row.
 */
export function comingRows(
  items: readonly ComingItem[],
  crew: readonly Worker[],
  repoOf: (item: ComingItem) => Repo | null | undefined = () => null,
): { rows: ComingItem[]; held: ReadonlySet<ComingItem>; heldBy: ReadonlyMap<string, ComingItem> } {
  const rows = [...items];
  const held = new Set<ComingItem>();
  const heldBy = new Map<string, ComingItem>();
  const onItsWay = (item: ComingItem) => {
    const { stage, mergedAt } = cleanComing(item);
    return stage !== "shipped" && stage !== "owner-ok" && !mergedAt;
  };
  const sameRepo = (item: ComingItem, worker: Worker) => {
    const repo = repoOf(item);
    return repo === null || (repo ?? NO_REPO) === worker.repo;
  };
  const atWorkNow = new Set(crew.map((worker) => chatKey(worker.repo, worker.chat)));
  for (const worker of crew) {
    // Its own name first, else a numbered one (`daily-build-73` is daily-build's), as the Feed reads a row's chat; never a
    // row naming another chat at work in its repo.
    const free = rows.filter((item) => !held.has(item) && onItsWay(item) && sameRepo(item, worker));
    const own =
      free.find((item) => item.chat === worker.chat) ??
      free.find((item) => item.chat?.replace(/-\d+$/, "") === worker.chat && !atWorkNow.has(chatKey(worker.repo, item.chat)));
    const row = own ?? fromChat(worker);
    if (!own) rows.push(row);
    held.add(row);
    heldBy.set(chatKey(worker.repo, worker.chat), row);
  }
  return { rows, held, heldBy };
}

/** The crew as a screen or the server knows it: every live worker, and whether the reading has lapsed. */
export interface Crew {
  workers: readonly Worker[];
  /** The snapshot is too old to say who is live: no chat is known to be gone, and nobody is at work. */
  lapsed: boolean;
}

type ChatLike = { name: string; repo?: unknown };

/**
 * The live worker of a board chat: same repo and name, else the chat the name numbers (`daily-build-73`, `daily-build`).
 * A row that names no repo is the default repo's, else the one chat of that name in another repo with no board row of
 * that name (`chats`): the reader often leaves the repo off a chat.
 */
export function chatWorker(chat: ChatLike, workers: readonly Worker[], chats: readonly ChatLike[] = []): Worker | undefined {
  const repo = chatRepo(chat) ?? NO_REPO;
  const base = chat.name.replace(/-\d+$/, "");
  const same = workers.find((worker) => worker.repo === repo && worker.chat === chat.name) ?? workers.find((worker) => worker.repo === repo && worker.chat === base);
  if (same || chatRepo(chat)) return same;
  const elsewhere = workers.filter((worker) => worker.chat === chat.name && !chats.some((row) => row.name === chat.name && (chatRepo(row) ?? NO_REPO) === worker.repo));
  return elsewhere.length === 1 ? elsewhere[0] : undefined;
}

/** A chat with no live terminal while the crew is known. No crew is not an empty one: a live one always has Rivet. */
export function chatGone(chat: ChatLike, crew: Crew, chats: readonly ChatLike[] = []): boolean {
  return !crew.lapsed && crew.workers.length > 0 && !chatWorker(chat, crew.workers, chats);
}

/**
 * The repo of a Coming row's chat as the Feed shows it: the board's, else, for a chat the board gives no repo, the one
 * live chat of that name in another repo, as the Chats list finds it. Null when two repos claim the chat.
 */
export function comingRowRepo(chats: readonly ChatLike[], item: ComingItem, workers: readonly Worker[]): Repo | null | undefined {
  if (!item.chat) return undefined;
  const own = chatRowRepo(item);
  if (own) return own === NO_REPO ? undefined : own;
  const repo = comingChatRepo(chats as Parameters<typeof comingChatRepo>[0], item.chat, item.pr);
  if ((repo !== undefined && repo !== NO_REPO) || chats.some((chat) => chat.name === item.chat && chat.repo === NO_REPO)) return repo;
  const worker = chatWorker({ name: item.chat }, workers, chats);
  return worker ? (chatRepo(worker) ?? NO_REPO) : repo;
}

/** The board fields the Coming rows come from. */
export interface ComingBoard {
  coming?: readonly ComingItem[];
  chats?: readonly ChatLike[];
}

/**
 * Coming as the Feed shows it, with the row each chat at work holds: the items less those whose chat is gone (nothing
 * is working on them). A chat two repos claim is not known to be gone, and a row waiting for your OK stays.
 */
export function shownComingRows(board: ComingBoard | null | undefined, crew: Crew): ReturnType<typeof comingRows> {
  const chats = board?.chats ?? [];
  // chatRepo marks a row made from a chat here; a posted row never carries one.
  const items = (board?.coming ?? [])
    .map((raw) => {
      const { chatRepo: _made, ...item } = cleanComing(raw) as ComingItem & { chatRepo?: unknown };
      return item as ComingItem;
    })
    .filter((item) => {
      // A row waiting on you stays whatever its chat is doing.
      if (!item.chat || item.stage === "shipped" || item.stage === "owner-ok" || typeof item.mergedAt === "string") return true;
      const repo = comingRowRepo(chats, item, crew.workers);
      return repo === null || !chatGone({ name: item.chat, ...(repo ? { repo } : {}) }, crew, chats);
    });
  // Each chat at work holds a row of its own repo, made from the chat when Coming has none for it.
  return comingRows(items, crew.lapsed ? [] : crew.workers.filter(isWorking), (item) => comingRowRepo(chats, item, crew.workers));
}

// ---- Asks in hand and their times

const itemName = (item: ComingItem) => (item.app && item.app !== item.title ? `${item.app}: ${item.title}` : item.title);

/** Why a row counts in the Progress mark: its time has passed with none given since, or has moved twice. */
export type TimeMark = "no-time" | "moved-twice" | null;

/** A Coming item's status key: its PR number, else its name, within its repo. */
const comingKey = (item: ComingItem, repo: string = NO_REPO) => opsStatusKey("coming", item.pr ? String(item.pr) : itemName(item), repo);

/** The ids a Coming row in hand joins by: a record under way on one of them is listed on its row, not as Rivet's own. */
export function comingIds(board: ComingBoard | null | undefined, crew: Crew, now: number): Set<string> {
  const coming = shownComingRows(board, crew);
  const ids = new Set<string>();
  for (const item of coming.rows) {
    if (comingDone(item) || (isStaleComing(item, now) && !coming.held.has(item))) continue;
    const repo = comingRowRepo(board?.chats ?? [], item, crew.workers) ?? (item as { mergedRepo?: Repo }).mergedRepo ?? NO_REPO;
    ids.add(`coming/${comingKey(item, repo)}`);
    ids.add(`coming/${repo}/${comingKey(item)}`);
    if (item.pr) ids.add(`pr/${opsStatusKey("pr", String(item.pr), repo)}`);
  }
  return ids;
}

/**
 * An ask's mark: none once finished or waiting on you (its card counts it, in needsYou); "no-time" once its time has
 * passed; "moved-twice" with a time ahead that has moved twice. A time moved once is no mark: its row says so.
 */
export function askMark(ask: Pick<Ask, "stage" | "dueAt" | "dueHistory">, now: number): TimeMark {
  if (isFinished(ask.stage) || ask.stage === "needs-you" || !ask.dueAt) return null;
  if (!(Date.parse(ask.dueAt) > now)) return "no-time";
  return moves(ask) >= 2 ? "moved-twice" : null;
}

/**
 * An Ops record's mark, the same rule: a backlog pick-up the server asked a time for has none; one under way has none
 * once its done-by has passed, or has moved twice.
 */
export function recordMark(status: OpsStatus | null, now: number): TimeMark {
  if (status?.state === "backlog") return status.askedForTimeAt ? "no-time" : null;
  if (!status || !underWay(status) || !status.dueAt) return null;
  if (!(Date.parse(status.dueAt) > now)) return "no-time";
  return (status.dueHistory?.length ?? 0) >= 2 ? "moved-twice" : null;
}

/**
 * An ask in hand: every unfinished ask of yours, at Your OK too, as Your asks lists them above its folds.
 */
export function inHandAsk(ask: Pick<Ask, "who" | "stage" | "source">): boolean {
  return ask.who !== "rivet" && !isFinished(ask.stage);
}

/** How long after its merge a deploying ask, or a merged PR with no chat, still counts as moving. */
export const MERGE_MOVING_MS = 30 * 60_000;

/** What shows work moving: the connected chats, the push queue, the open PRs and the merges. */
export interface MovingReadings {
  workers: readonly Pick<Worker, "chat" | "repo" | "project">[];
  queue: readonly PushQueueRow[];
  prs: readonly { repo: string; number: number }[];
  merged: readonly MergedReading[];
}

/**
 * An ask in hand that is really moving: at Needs you, its chat
 * connected or in the push queue, a PR of its open, or deploying under half an hour after its merge. The In hand number
 * counts these, on the summary and on the rows alike.
 */
export function movingAsk(ask: Ask, readings: MovingReadings, now: number): boolean {
  if (!inHandAsk(ask)) return false;
  if (ask.stage === "needs-you") return true;
  const worker = ask.chat === undefined ? undefined : workerOfAsk(ask, readings.workers);
  if (worker || (ask.chat !== undefined && readings.queue.some((row) => row.chat === ask.chat))) return true;
  const repo = askPrRepo(ask, worker);
  if (readings.prs.some((pr) => sameRepo(pr.repo, repo) && ask.prs.includes(pr.number))) return true;
  return ask.stage === "deploying" && readings.merged.some((pr) => sameRepo(pr.repo, repo) && ask.prs.includes(pr.number) && now - Date.parse(pr.at) < MERGE_MOVING_MS);
}

/** A record Rivet's own can hold: an Ops record he is on, or a pick-up waiting on a time, that is not Coming's. */
export function ownRecord(status: OpsStatus): boolean {
  if (status.kind === "coming") return false;
  return status.state === "backlog" ? !!status.askedForTimeAt : underWay(status);
}

/**
 * Rivet's own records, as Progress lists them under Rivet's own (web/src/views/ops-plan.ts ownRows lists exactly
 * these): each ownRecord, less one under way that is listed on a Coming row in hand.
 */
export function ownRecords(statuses: readonly OpsStatus[], joined: ReadonlySet<string>): OpsStatus[] {
  return statuses.filter((status) => ownRecord(status) && (status.state === "backlog" || !joined.has(`${status.kind}/${status.key}`)));
}

/**
 * The asks' counts: in hand, and the rows the mark counts, each once. A record stands in for the pick-up ask made from
 * it (`pickup:<kind>/<key>`), as Your asks lists it.
 */
export function askCounts(asks: readonly Ask[], records: readonly OpsStatus[], now: number, readings: MovingReadings): AskCounts & { nextDoneAt: string | null } {
  const kept = new Set(records.map((status) => `pickup:${status.kind}/${status.key}`));
  const open = asks.filter((ask) => !isFinished(ask.stage) && !(ask.who === "rivet" && ask.source && kept.has(ask.source)));
  const marks = [...open.map((ask) => askMark(ask, now)), ...records.map((status) => recordMark(status, now))];
  const next = open
    .filter((ask) => movingAsk(ask, readings, now) && askMark(ask, now) === null && ask.dueAt && Date.parse(ask.dueAt) > now)
    .map((ask) => ask.dueAt!)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return {
    inHand: open.filter((ask) => movingAsk(ask, readings, now)).length,
    noTime: marks.filter((mark) => mark === "no-time").length,
    moved: marks.filter((mark) => mark === "moved-twice").length,
    nextDoneAt: next ?? null,
  };
}

/** Everything the summary is made from. */
export interface SummaryInput {
  /** The open cards, each at its revision. */
  needs: readonly { id: string; rev: string }[];
  minimised: ReadonlyMap<string, string>;
  board: ComingBoard | null | undefined;
  crew: Crew;
  statuses: readonly OpsStatus[];
  asks: readonly Ask[];
  queue: MovingReadings["queue"];
  prs: MovingReadings["prs"];
  merged: MovingReadings["merged"];
  now: number;
}

export function summarize(input: SummaryInput): Summary {
  const { now } = input;
  const { nextDoneAt, ...asks } = askCounts(input.asks, ownRecords(input.statuses, comingIds(input.board, input.crew, now)), now, { workers: input.crew.lapsed ? [] : input.crew.workers, queue: input.queue, prs: input.prs, merged: input.merged });
  return { ...needCounts(input.needs, input.minimised), asks, nextDoneAt };
}
