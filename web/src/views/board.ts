import "./lists.css";

import { comingChatRepo, type ServedBoard } from "../../../src/shared/board.js";
import { NO_REPO } from "../../../src/shared/repos.js";
import type { Worker } from "../../../src/shared/workers.js";
import { app, crewLapsed } from "../state.js";
import { chatRowRepo, comingRows } from "./coming-filter.js";
import type { ComingItem } from "../../../src/shared/board.js";
import { chatRepo, cleanComing, comingQuietMs, COMING_STALE_MS, kindClass, type Repo } from "./queue-cards.js";

// What the board's Coming items and chats read as, for Search, the plan and the Coming sheet. A decision opens in
// the middle pane.

export { kindClass };
export type { Repo };

/** The sections Search's old targets name; each now opens the cards. */
export const LIST_TABS = ["needs", "chats", "shipped"] as const;
export type ListTab = (typeof LIST_TABS)[number];

type ChatEntry = ServedBoard["chats"][number];

/** What a chat says first: its live terminal's state, "gone" without one, "no current reading" while the crew is not known. */
type ChatWord = "working" | "needs you" | "blocked" | "idle" | "gone" | "no current reading";

/**
 * The live worker of a board chat: same repo and name, else the chat the name numbers (`search-box-73`, `search-box`).
 * A row that names no repo is the default repo's, else the one chat of that name in another repo with no board row of
 * that name: a row can leave the repo off a chat in another repo.
 */
function chatWorker(chat: ChatEntry): Worker | undefined {
  const repo = chatRepo(chat) ?? NO_REPO;
  const workers = app.workers?.workers ?? [];
  const base = chat.name.replace(/-\d+$/, "");
  const same = workers.find((worker) => worker.repo === repo && worker.chat === chat.name) ?? workers.find((worker) => worker.repo === repo && worker.chat === base);
  if (same || chatRepo(chat)) return same;
  const rows = app.board?.board?.chats ?? [];
  const elsewhere = workers.filter((worker) => worker.chat === chat.name && !rows.some((row) => row.name === chat.name && (chatRepo(row) ?? NO_REPO) === worker.repo));
  return elsewhere.length === 1 ? elsewhere[0] : undefined;
}

function chatWord(chat: ChatEntry): ChatWord {
  // No crew is not an empty one: the server sends none while the Mac's snapshot is stale, and a live one always has Rivet.
  if (crewLapsed() || !app.workers?.workers.length) return "no current reading";
  const worker = chatWorker(chat);
  if (!worker) return "gone";
  if (worker.needsYou || worker.state === "waiting") return "needs you";
  return worker.state;
}

/**
 * The board's Coming items with the fields an old stored board can hold as any type dropped, before anything reads
 * them, less those whose chat is gone: nothing is working on them. A chat two repos claim is not known to be gone, and
 * a row waiting for your OK stays.
 */
export function shownComing(board: ServedBoard | null | undefined): ComingItem[] {
  return shownComingRows(board).rows;
}

/** Coming as the Feed shows it, with the row each chat at work holds (`heldBy`, by `chatKey`). */
export function shownComingRows(board: ServedBoard | null | undefined): ReturnType<typeof comingRows> {
  // chatRepo marks a row made from a chat here; a posted row never carries one.
  const items = (board?.coming ?? []).map((raw) => {
    const { chatRepo: _made, ...item } = cleanComing(raw) as ComingItem & { chatRepo?: unknown };
    return item as ComingItem;
  }).filter((item) => {
    // A row waiting on you stays whatever its chat is doing.
    if (!item.chat || item.stage === "shipped" || item.stage === "owner-ok" || typeof item.mergedAt === "string") return true;
    const repo = comingRowRepo(board?.chats ?? [], item);
    return repo === null || chatWord({ name: item.chat, state: "", ...(repo ? { repo } : {}) }) !== "gone";
  });
  // Each chat at work holds a row of its own repo, made from the chat when Coming has none for it.
  return comingRows(items, undefined, (item) => comingRowRepo(board?.chats ?? [], item));
}

/**
 * The repo of a Coming row's chat as the Feed shows it: the board's, else, for a chat the board gives no repo, the one
 * live chat of that name in another repo. Null when two repos claim the chat.
 */
export function comingRowRepo(chats: readonly ChatEntry[], item: ComingItem): Repo | null | undefined {
  if (!item.chat) return undefined;
  const own = chatRowRepo(item);
  if (own) return own === NO_REPO ? undefined : own;
  const repo = comingChatRepo(chats, item.chat, item.pr);
  if ((repo !== undefined && repo !== NO_REPO) || chats.some((chat) => chat.name === item.chat && chat.repo === NO_REPO)) return repo;
  const worker = chatWorker({ name: item.chat, state: "" });
  return worker ? (chatRepo(worker) ?? NO_REPO) : repo;
}

/** Coming items nobody has touched for COMING_STALE_MS; they wait under Stale, not in the list. */
export function isStaleComing(item: ComingItem, now = Date.now()): boolean {
  return (comingQuietMs(item, now) ?? 0) >= COMING_STALE_MS;
}
