import type { Ask } from "../shared/asks.js";
import { NO_REPO, type Board, type Progress } from "../shared/board.js";
import { RIVET_NAME } from "../shared/names.js";
import { defaultRepo } from "../shared/repos.js";
import { comingRowRepo } from "../shared/summary.js";
import { BLOCKED_PATTERN, chatStatus, HUNG_MS, SNAPSHOT_STALE_MS, TYPED_FRESH_MS, WORKING_MS, type SnapshotWorker, type Worker, type WorkersResponse } from "../shared/workers.js";
import type { StoredWorkers } from "./store.js";

/** Rivet is the monitor chat's worktree in the default repo, as the bridge routes it. */
export function isRivet(worker: Pick<SnapshotWorker, "chat" | "repo">, monitorChat: string): boolean {
  return worker.chat === monitorChat && (worker.repo === NO_REPO || worker.repo === defaultRepo());
}

/**
 * The live workers as the Yard and the feed show them. Working is the terminal
 * title's glyph when the bridge reads one (a spinner with no output for HUNG_MS
 * is not), else output in the last WORKING_MS. Working wins: a working chat with
 * a card open is `needsYou`, not `waiting`. A quiet chat is waiting with a card
 * open, else blocked when its board state says so, else idle. A card naming a
 * numbered chat (`report-page-73`) belongs to the live chat it numbers (`report-page`)
 * when no live chat has the full name. A chat's typed doing, blocked and progress go once its row is TYPED_FRESH_MS
 * untouched, and a merged Coming item is no longer being delivered. A chat's project is not typed status: it stays.
 * A chat's box is its board chat's project, else the repo of the PRs its newest ask names with a repo, else the repo
 * the bridge read its work in; with none of them its worktree's repo is a guess (`boxGuess`).
 */
export function deriveWorkers(stored: StoredWorkers | null, board: Board | null, monitorChat: string, now: number, asks: readonly Ask[] = []): WorkersResponse {
  if (!stored) return { at: null, workers: [] };
  // A snapshot the bridge stopped refreshing says nothing about who is live now.
  if (!(now - Date.parse(stored.at) <= SNAPSHOT_STALE_MS)) return { at: stored.at, workers: [] };
  const live = new Set(stored.snapshot.workers.filter((entry) => entry.connected).map((entry) => `${entry.repo}\n${entry.chat}`));
  const waiting = new Set(
    (board?.needs ?? []).flatMap((need) => {
      if (!need.chat) return [];
      const key = `${need.repo ?? NO_REPO}\n${need.chat}`;
      const base = key.replace(/-\d+$/, "");
      return [live.has(key) || !live.has(base) ? key : base];
    }),
  );
  const doing = new Map<string, string>();
  const blocked = new Set<string>();
  const statuses = new Map<string, Progress>();
  const work = new Map<string, Pick<Worker, "prs" | "movedAt">>();
  const projects = new Map<string, NonNullable<Worker["project"]>>();
  for (const chat of board?.chats ?? []) {
    const repo = typeof chat.repo === "string" ? chat.repo : NO_REPO;
    const key = `${repo}\n${chat.name}`;
    const touched = [chat.touchedAt, chat.moved, chat.updatedAt].find((at): at is string => typeof at === "string");
    const fresh = !(now - Date.parse(touched ?? "") > TYPED_FRESH_MS);
    if (fresh && chat.doing && !doing.has(key)) doing.set(key, chat.doing);
    if (!work.has(key)) {
      work.set(key, { ...(chat.prs?.length ? { prs: chat.prs } : {}), ...(chat.moved ? { movedAt: chat.moved } : {}) });
      if (chat.project) projects.set(key, chat.project);
    }
    const status = fresh ? chatStatus(chat) : {};
    if (Object.keys(status).length > 0 && !statuses.has(key)) statuses.set(key, status);
    if (fresh && BLOCKED_PATTERN.test(chat.state)) blocked.add(key);
  }
  // A Coming item names its chat but not its repo: it is the repo's the Feed gives it (its chat's on the board, else the
  // one live chat of the name), and nobody's while two repos claim it. The first one of a chat still on its way
  // is what that chat is delivering.
  const crew = stored.snapshot.workers.filter((entry) => entry.connected) as unknown as Worker[];
  const delivering = new Map<string, NonNullable<Worker["delivering"]>>();
  for (const item of board?.coming ?? []) {
    if (!item.chat || item.stage === "shipped" || typeof item.mergedAt === "string") continue;
    const repo = comingRowRepo(board?.chats ?? [], item, crew);
    const key = `${repo ?? NO_REPO}\n${item.chat}`;
    if (repo === null || delivering.has(key)) continue;
    delivering.set(key, { title: item.title, ...(item.pr !== undefined ? { pr: item.pr } : {}), ...(item.stage ? { stage: item.stage } : {}) });
  }
  // An ask with no repo is only the default's, so it links nothing; nor does a chat name two snapshot chats share (a disconnected twin's ask is not the live one's).
  const names = new Map<string, number>();
  const liveNames = new Map<string, number>();
  for (const entry of stored.snapshot.workers) {
    names.set(entry.chat, (names.get(entry.chat) ?? 0) + 1);
    if (entry.connected) liveNames.set(entry.chat, (liveNames.get(entry.chat) ?? 0) + 1);
  }
  const linked = new Map<string, Ask>();
  for (const ask of asks) {
    if (ask.chat === undefined || ask.repo === undefined || !ask.prs.length || names.get(ask.chat) !== 1) continue;
    const was = linked.get(ask.chat);
    if (!was || Date.parse(ask.createdAt) > Date.parse(was.createdAt)) linked.set(ask.chat, ask);
  }
  const workers: Worker[] = [];
  for (const entry of stored.snapshot.workers) {
    if (!entry.connected) continue;
    const rivet = isRivet(entry, monitorChat);
    const name = rivet ? RIVET_NAME : entry.chat;
    const key = `${entry.repo}\n${entry.chat}`;
    const quietFor = entry.lastOutputAt === null ? Infinity : now - entry.lastOutputAt;
    const busy = entry.busy === true ? quietFor < HUNG_MS : (entry.busy ?? quietFor < WORKING_MS);
    const card = waiting.has(key);
    const state = busy ? "working" : card ? "waiting" : blocked.has(key) ? "blocked" : "idle";
    const worker: Worker = { id: entry.worktreeId, name, repo: entry.repo, chat: entry.chat, state, lastOutputAt: entry.lastOutputAt };
    if (typeof entry.busy === "boolean") worker.busy = entry.busy;
    if (entry.branch) worker.branch = entry.branch;
    worker.agent = entry.agent;
    if (entry.startedAt !== undefined) worker.startedAt = entry.startedAt;
    if (busy && card) worker.needsYou = true;
    const what = doing.get(key);
    if (what) worker.doing = what;
    Object.assign(worker, statuses.get(key), work.get(key));
    const item = delivering.get(key);
    if (item) worker.delivering = item;
    if (rivet) worker.rivet = true;
    else {
      const set = projects.get(key);
      const pr = linked.get(entry.chat)?.repo;
      // The bridge reads a chat's folders by name, so a name two live chats share says nothing about either.
      const box = set ?? pr ?? (liveNames.get(entry.chat) === 1 ? entry.workRepo : undefined);
      if (box === undefined) worker.boxGuess = true;
      else {
        worker.boxFrom = set ? "set" : pr ? "pr" : "folder";
        if (box !== entry.repo) worker.project = box;
      }
    }
    workers.push(worker);
  }
  workers.sort(
    (a, b) =>
      Number(b.rivet === true) - Number(a.rivet === true) ||
      a.repo.localeCompare(b.repo) ||
      a.name.localeCompare(b.name) ||
      a.chat.localeCompare(b.chat),
  );
  return { at: stored.at, workers, ...(stored.snapshot.pushQueue?.length ? { pushQueue: stored.snapshot.pushQueue } : {}) };
}
