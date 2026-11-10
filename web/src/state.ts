import type { BoardResponse, Decision, Reply, ServedNeed, StatusResponse } from "../../src/shared/board.js";
import { isWorking, needCounts, type Summary } from "../../src/shared/summary.js";
import { isGotIt } from "../../src/shared/answers.js";
import type { CardThread } from "../../src/shared/threads.js";
import { SNAPSHOT_STALE_MS, type Worker, type WorkersResponse } from "../../src/shared/workers.js";
import * as api from "./api.js";
import { getConversations } from "./command-api.js";
import { deckOrder, doneToday, laterOrder, updateOrder, type DeckInput } from "./feed-logic.js";
import { describe } from "./dom.js";
import { emptyPhotos, type PhotosState } from "./views/attach.js";
import { closeAnswered } from "./push.js";
import { endSession, sameSession } from "./session.js";
import { screenMoved } from "./usage.js";

export { isWorking };

/** Cards, your asks (the home screen), Chat, and a page from the menu. */
export const TABS = ["cards", "progress", "chat", "more"] as const;
export type Tab = (typeof TABS)[number];

/** The pages the menu opens: a sheet over the home screen on a phone, the middle column on a computer. */
export const OPS_PAGES = ["plan", "usage", "machines", "code"] as const;
export type OpsPage = (typeof OPS_PAGES)[number];

export const MORE_PAGES = ["floor", "usage", "mind", "machines", "code", "home", "media", "settings", "what-you-used"] as const;
export type MorePage = (typeof MORE_PAGES)[number];

/** Where a tab id lands (a saved link, a notification, `?tab=`); an id never known lands on the home screen. */
export function landing(id: string | null | undefined): { tab: Tab; page: MorePage | null } {
  if (id === "more") return { tab: "progress", page: null };
  if (TABS.some((tab) => tab === id)) return { tab: id as Tab, page: null };
  if (MORE_PAGES.some((page) => page === id)) return { tab: "more", page: id as MorePage };
  if (id === "feed") return { tab: "cards", page: null };
  return { tab: "progress", page: null };
}

/** Moves the app to a tab id, an old one included, and the More page it names. */
export function go(id: string): void {
  const { tab, page } = landing(id);
  app.tab = tab;
  if (tab === "more") app.morePage = page;
}

export function setOpsPage(page: OpsPage): void {
  app.opsPage = page;
}

export interface CardState {
  /** A note typed for this card; it rides along with the next answer. */
  text: string;
  /** A photo attached for this card; it rides along with the next answer too. */
  attach: PhotosState;
  /** The revision the confirm step was opened on; a newer card cancels it. */
  confirm: { decision: Decision; choice?: string; rev: string } | null;
  error: string | null;
  /** The last answer sent and its clientId; only an identical retry reuses the id. */
  pending: { key: string; clientId: string } | null;
}

// Later's 30-minute snoozes: drop any a device still holds so no card stays hidden.
try {
  localStorage.removeItem("rivet.snoozed");
} catch {
  // Private mode or a blocked store: nothing reads the key any more.
}

/**
 * Cards put as Later. Later and − became one button, which minimises on the server, so
 * nothing puts a card here now: the map stays empty until the Later code is retired.
 */
export function saveLater(): void {
  showAppBadge();
}

export const app = {
  board: null as BoardResponse | null,
  status: null as StatusResponse | null,
  /** The crew as GET /api/workers derives it; the Floor and the feed's "working" count both read it. */
  workers: null as WorkersResponse | null,
  /** GET /api/summary as last read: the asks' counts and next done time every screen shows. */
  summary: null as Summary | null,
  /** When this device last loaded the crew: the app shows them offline once that is SNAPSHOT_STALE_MS old. */
  workersAt: null as number | null,
  /** Card id → the thread it belongs to and its round there; a card in no thread is absent. */
  cardThreads: new Map<string, CardThread>(),
  /** itemId → its latest reply. */
  replies: new Map<string, Reply>(),
  /** clientIds of the replies the server has, from the last successful load. */
  landed: new Set<string>(),
  recent: [] as Reply[],
  answeredToday: 0,
  cards: new Map<string, CardState>(),
  reopened: new Set<string>(),
  held: new Set<string>(),
  /** id → the revision the owner put as Later; that card leaves the deck and the counts until it changes or he brings it back. */
  later: new Map<string, string>(),
  front: null as string | null,
  tab: "progress" as Tab,
  /** The page More shows; null is its list. */
  morePage: null as MorePage | null,
  opsPage: "plan" as OpsPage,
  /** A message a search hit asked Chat to show, by id, until Chat has opened its conversation on it. */
  chatFocus: null as string | null,
  /** Conversations with anything unread: the Chat tab's badge. */
  chatUnread: 0,
  notice: null as string | null,
  device: null as { code: string; expiresAt: string } | null,
  /** Bumped only when a refresh read something the Feed shows that differs from the last read. */
  dataRev: 0,
  /** When the board, status and replies last all loaded (ms since the epoch). */
  loadedAt: null as number | null,
  /** The phone has no network, or the last refresh could not reach the server (no answer, a timeout or a 5xx). */
  offline: null as "offline" | "unreachable" | null,
  /** The board's first read has gone STILL_READING_MS with no answer. */
  slowRead: false,
};

export function cardState(id: string): CardState {
  let card = app.cards.get(id);
  if (!card) {
    card = { text: "", attach: emptyPhotos(), confirm: null, error: null, pending: null };
    app.cards.set(id, card);
  }
  return card;
}

function deckInput(): DeckInput {
  const answeredRev = new Map([...app.replies].map(([id, reply]) => [id, reply.rev]));
  return { answeredRev, reopened: app.reopened, held: app.held, later: app.later, front: app.front };
}

export function deck(): ServedNeed[] {
  return deckOrder(app.board?.board?.needs ?? [], deckInput());
}

/** The update cards the owner has not seen, newest first; they never count as needing him. */
export function updateCards(): ServedNeed[] {
  return updateOrder(app.board?.board?.needs ?? [], deckInput());
}

/** Feed › Done: today's answers (local day), newest first, from the replies the app last read and sent since. */
export function doneReplies(now = new Date()): ReturnType<typeof doneToday> {
  return doneToday(app.replies.values(), now);
}

/**
 * Puts a card on top of the deck, out of Later. Every explicit open comes through here: a link or a notification,
 * Search, Ops, a Later row, the desktop list and Undo.
 */
export function frontCard(id: string): void {
  navigated();
  app.front = id;
  // Before the first board, keep the link's intent through a failed load. A successful read below drops it
  // if the card is unanswered; ordinary selection must still follow later answers from other devices.
  const need = app.board?.board?.needs.find((item) => item.id === id);
  if (!app.board || (need && (need.seen || app.replies.get(id)?.rev === need.rev))) app.reopened.add(id);
  const card = app.cards.get(id);
  if (card?.pending && app.landed.has(card.pending.clientId)) card.pending = null;
  if (app.later.delete(id)) saveLater();
}

/** Opened on purpose (a queue row, a link, Search), a minimised card opens in full and counts again. */
export function unminimise(id: string): void {
  if (minimisedCards().has(id)) saveMinimised(id, "", false);
}

/**
 * The deck less the cards minimised on this device: what every red count shows.
 */
export function countedCards(): ServedNeed[] {
  const small = minimisedCards();
  return deck().filter((need) => small.get(need.id) !== need.rev);
}

/**
 * The one summary every count reads (plan rivet-information-review §3h.5): the server's, with the cards counted here
 * by the same function, so a minimise or an answer shows at once. Null until the first read.
 */
export function summary(): Summary | null {
  if (!app.summary) return null;
  return { ...app.summary, ...needCounts(asking(), minimisedCards()) };
}

/** The deck less its Got it cards: news he clears, which never counts as needing him, as the server counts it (openBoard). */
const asking = (): ServedNeed[] => deck().filter((need) => !isGotIt(need));

/** The summary's needsYou, which the Cards tab and the home-screen icon show: counted here even before its first read. */
export const needsYou = (): number => needCounts(asking(), minimisedCards()).needsYou;

// Minimised cards, kept on the server since
// so the badge counts the same deck on every phone.

/** Minimise taps this device sent that the board has not read back yet, key → rev (null: opened again). */
const minimisedSent = new Map<string, string | null>();
/** This phone's own minimise and Later lists from Earlier go up once, on the first board read. */
let deviceMinimisedSent = false;

function minimisedCards(): Map<string, string> {
  const served = new Map(app.board?.minimised ?? []);
  for (const [key, rev] of minimisedSent) {
    if (rev === null) served.delete(key);
    else served.set(key, rev);
  }
  return served;
}

/** A board read that agrees with a sent tap ends it; until then the tap shows over a read that raced it. */
function settleMinimised(): void {
  const served = new Map(app.board?.minimised ?? []);
  for (const [key, rev] of minimisedSent) if ((served.get(key) ?? null) === rev) minimisedSent.delete(key);
}

/**
 * Earlier minimise and Later lived on each phone: this phone sends up what it held, once. A card the server
 * already holds keeps the server's (newer) revision. Each entry leaves the phone's lists once the server has answered
 * its send, so a send lost offline is tried again at the next start, and never one the owner has since opened again.
 */
function sendDeviceMinimised(): void {
  const read = (key: string): [string, string][] => {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(saved) ? saved.filter((pair): pair is [string, string] => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string") : [];
  };
  // Read again at each answer: the other sends may have left the list since.
  const drop = (key: string, done: (pair: [string, string]) => boolean): void => {
    try {
      const kept = read(key).filter((pair) => !done(pair));
      if (kept.length) localStorage.setItem(key, JSON.stringify(kept));
      else localStorage.removeItem(key);
    } catch {
      // Private mode or a bad value: nothing was kept.
    }
  };
  try {
    const served = minimisedCards();
    for (const key of ["rivet.minimised", "rivet.later"]) {
      const held = read(key);
      drop(key, ([card]) => served.has(card));
      for (const [card, rev] of held) {
        if (served.has(card)) continue;
        void saveMinimised(card, rev, true).then((sent) => {
          if (sent) drop(key, (pair) => pair[0] === card && pair[1] === rev);
        });
      }
    }
  } catch {
    // Private mode or a bad value: nothing to send.
  }
}

/** Minimised at this revision; a new revision opens the card again so the change is seen, and counted. */
export function isMinimised(key: string, rev: string): boolean {
  return minimisedCards().get(key) === rev;
}

/**
 * Minimises a card (or opens it again) on the server, showing it at once; a refused tap puts the card back as it was.
 * True once the server has answered, refused included; false when the send never got an answer.
 */
export function saveMinimised(key: string, rev: string, small: boolean): Promise<boolean> {
  const sent = small ? rev : null;
  minimisedSent.set(key, sent);
  showAppBadge();
  return api.setMinimised(key, sent).then(
    ({ minimised }) => {
      if (app.board) app.board.minimised = minimised;
      settleMinimised();
      return true;
    },
    (error: unknown) => {
      if (minimisedSent.get(key) === sent) {
        minimisedSent.delete(key);
        showAppBadge();
        changed();
      }
      // A sign-in, a timeout or a rate limit is no answer about the card.
      return error instanceof api.ApiError && error.status >= 400 && error.status < 500 && ![401, 403, 408, 429].includes(error.status);
    },
  );
}

/** The open cards put as Later, in the order they were put there. */
export function laterCards(): ServedNeed[] {
  return laterOrder(app.board?.board?.needs ?? [], deckInput());
}

/**
 * The tab a fresh session opens on, once the board has loaded: one a link or a notification asked for, else Cards
 * while cards wait and Progress when all clear.
 */
export function openingTab(asked: Tab | null): Tab {
  if (asked) return asked;
  if (app.tab !== "progress") return app.tab;
  return deck().length ? "cards" : "progress";
}

/** Every move to another tab (seen at the next `changed`) or explicit card open, so startup knows if the owner moved. */
let moves = 0;
let tabSeen: Tab = app.tab;

export function navigated(): void {
  moves++;
}

/** The moves so far, counting from the tab on screen now. */
export function navStamp(): number {
  tabSeen = app.tab;
  return moves;
}

/**
 * Whether cards wait is known only once the first board loads, after the shell is up; a tab tapped or a card opened
 * from a notification since `stamp` (navStamp) keeps its screen, even one that ended back where it began.
 */
export function settleOpening(asked: Tab | null, stamp: number): void {
  const opening = openingTab(asked);
  if (moves !== stamp || opening === app.tab) return;
  app.tab = opening;
  changed();
}

/** Why listeners hear a change: "poll" is a refresh, which the Feed may skip when nothing it shows changed. */
export type ChangeReason = "poll";
type Listener = (reason?: ChangeReason) => void;
const listeners = new Set<Listener>();
let onSignedOut: (message: string) => void = () => {};

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export { sameSession } from "./session.js";

/** Drops everything read or typed in the previous session; a deep-linked card survives. */
export function resetSession(): void {
  endSession();
  app.board = null;
  app.status = null;
  app.summary = null;
  app.workers = null;
  app.workersAt = null;
  app.cardThreads.clear();
  clearTimeout(lapseTimer);
  app.replies.clear();
  app.landed.clear();
  landedSince.clear();
  app.recent = [];
  app.answeredToday = 0;
  app.cards.clear();
  app.reopened.clear();
  app.held.clear();
  app.later.clear();
  minimisedSent.clear();
  // A new sign-in looks once more for lists kept on this phone from before.
  deviceMinimisedSent = false;
  // A card a link or a notification asked for opens, even one put as Later.
  if (app.front) frontCard(app.front);
  app.tab = "progress";
  app.morePage = null;
  app.chatFocus = null;
  app.chatUnread = 0;
  app.notice = null;
  app.device = null;
  app.dataRev = 0;
  app.loadedAt = null;
  app.offline = null;
  app.slowRead = false;
  clearTimeout(slowTimer);
  slowTimer = undefined;
  shownSignature = "";
}

let lapseTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Takes a crew just loaded. Listeners hear when it lapses even if every request hangs; the return says whether it had
 * lapsed, so a caller that does not otherwise notify can tell them it is back.
 */
export function crewLoaded(workers: WorkersResponse): boolean {
  const wasLapsed = crewLapsed();
  app.workers = workers;
  app.workersAt = Date.now();
  clearTimeout(lapseTimer);
  lapseTimer = setTimeout(changed, SNAPSHOT_STALE_MS + 1);
  return wasLapsed;
}

/**
 * The Mac bridge is known to be offline: what the owner sends now waits for it, and the buttons that send say so instead of
 * a pill in the header. Unknown before the first status reading.
 */
export const macOffline = (): boolean => app.status !== null && !app.status.bridge.connected;
export const MAC_WAITS = "(waits for the Mac)";

/** Whether the crew on hand is too old to show as live, as its lapse times it: then nobody counts as working. */
export function crewLapsed(now = Date.now()): boolean {
  return app.workersAt !== null && now - app.workersAt > SNAPSHOT_STALE_MS;
}

/** The chats at work: the one live crew that the Desks tab's "N at work", each desk's "N working" and Coming's In progress all count. */
export function atWork(): Worker[] {
  return crewLapsed() ? [] : (app.workers?.workers ?? []).filter(isWorking);
}

export function workingCount(): number {
  return atWork().length;
}

export function changed(reason?: ChangeReason): void {
  if (app.tab !== tabSeen) {
    tabSeen = app.tab;
    moves++;
  }
  for (const listener of listeners) listener(reason);
  screenMoved();
}

export function whenSignedOut(handler: (message: string) => void): void {
  onSignedOut = handler;
}

export function signedOut(message: string): void {
  endSession();
  onSignedOut(message);
}

/** What the last applied read held that the Feed shows; a different one bumps dataRev. */
let shownSignature = "";

// A worker's output clock ticks on every bridge snapshot while its terminal runs; the Feed shows its state, not that clock.
function feedSignature(): string {
  return JSON.stringify([app.board, [...app.replies.values()], [...app.cardThreads.values()], app.status?.bridge.connected ?? null, app.chatUnread, app.summary, app.workers?.workers.map(({ lastOutputAt: _output, ...shown }) => shown) ?? null, app.workers?.pushQueue ?? null]);
}

/** No answer at all, a timeout or a server error: the Feed says it cannot reach the server. */
function unreachable(error: unknown): boolean {
  return error instanceof api.ApiError && (error.status === 0 || error.status >= 500);
}

/** The phone's own network state; a refresh that reaches the server clears "unreachable". */
export function networkChanged(): void {
  if (navigator.onLine === false) app.offline = "offline";
  else if (app.offline === "offline") app.offline = null;
  changed();
}

/** Reads started, and the newest one applied: an older read that lands after a newer one is dropped. */
let reads = 0;
let readApplied = 0;
/**
 * Answers seen landing this session: a read may not carry one, having started before it landed or, reading
 * only the latest 200, long after. The server never drops an answer, so one stands until a read lists it or a newer
 * answer to its card.
 */
const landedSince = new Map<string, Reply>();

/** An answer the server holds: the card counts as answered by it until a read lists it or a newer one. */
export function replyLanded(reply: Reply): void {
  app.replies.set(reply.itemId, reply);
  if (reply.clientId) app.landed.add(reply.clientId);
  landedSince.set(reply.id, reply);
}

/** A first read this long with no answer says "Still reading…": a read waits up to 20 s before it counts as failed. */
export const STILL_READING_MS = 4000;
let slowTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Where the board's read stands for what says "all clear", which nothing may say until a board has come: reading,
 * still reading past STILL_READING_MS, or failed (a first read that failed, or the phone offline) until then.
 */
export function boardRead(): "loaded" | "reading" | "slow" | "failed" {
  // Before the server's first snapshot its board is null: not read yet, never all clear.
  if (app.board?.board) return "loaded";
  if (app.notice !== null || app.offline !== null) return "failed";
  return app.slowRead ? "slow" : "reading";
}

/** Try again: a first read that failed reads as reading again until its answer comes. */
export function readAgain(): Promise<boolean> {
  if (!app.board?.board) {
    app.notice = null;
    app.offline = null;
    app.slowRead = false;
    clearTimeout(slowTimer);
    slowTimer = undefined;
    changed();
  }
  return refresh();
}

/** True when the board, status and replies all loaded. */
export async function refresh(): Promise<boolean> {
  let loaded = false;
  const read = ++reads;
  const current = sameSession();
  if (!app.board?.board && slowTimer === undefined && !app.slowRead)
    slowTimer = setTimeout(() => {
      slowTimer = undefined;
      if (!current() || app.board?.board) return;
      app.slowRead = true;
      changed();
    }, STILL_READING_MS);
  try {
    const [board, status, replies, workers, links, conversations, summary] = await Promise.all([
      api.getBoard(),
      api.getStatus(),
      api.getReplies(),
      // The crew is extra: its failure never fails the board.
      api.getWorkers().catch(() => null),
      // So are the cards' threads: a card without one shows no thread line.
      api.getCardThreads().catch(() => null),
      // And the Chat tab's badge.
      getConversations().catch(() => null),
      // And the asks' counts: a failed read keeps the last.
      api.getSummary().catch(() => null),
    ]);
    if (!current()) return false;
    if (read < readApplied) return true;
    readApplied = read;
    app.board = board;
    settleMinimised();
    if (!deviceMinimisedSent) {
      deviceMinimisedSent = true;
      sendDeviceMinimised();
    }
    // A crew back after a lapse is new to the Feed even when its chats are unchanged: In progress counts them again.
    const crewBack = workers ? crewLoaded(workers) : false;
    if (links) app.cardThreads = new Map(links.cards.map((link) => [link.card, link]));
    if (typeof conversations?.unread === "number") app.chatUnread = conversations.unread;
    if (summary) app.summary = summary;
    app.status = status;
    app.replies.clear();
    for (const reply of replies.replies) if (!app.replies.has(reply.itemId)) app.replies.set(reply.itemId, reply);
    app.landed = new Set(replies.replies.flatMap((reply) => (reply.clientId ? [reply.clientId] : [])));
    for (const [id, kept] of landedSince) {
      const listed = app.replies.get(kept.itemId);
      if (listed && (listed.id === id || listed.at > kept.at)) landedSince.delete(id);
      else {
        app.replies.set(kept.itemId, kept);
        if (kept.clientId) app.landed.add(kept.clientId);
      }
    }
    app.recent = replies.replies.slice(0, 12);
    const today = new Date().toDateString();
    app.answeredToday = replies.replies.filter((reply) => reply.decision !== "seen" && reply.decision !== "dismiss" && new Date(reply.at).toDateString() === today).length;
    for (const id of app.reopened) {
      const need = board.board?.needs.find((item) => item.id === id);
      if (!need || (!need.seen && app.replies.get(id)?.rev !== need.rev)) app.reopened.delete(id);
    }
    if (board.board) {
      // A new revision comes back out of Later; a card gone from the board is forgotten.
      const revs = new Map(board.board.needs.map((need) => [need.id, need.rev]));
      const kept = [...app.later].filter(([id, rev]) => revs.get(id) === rev);
      if (kept.length !== app.later.size) {
        app.later = new Map(kept);
        saveLater();
      }
    }
    app.notice = null;
    const signature = feedSignature();
    if (signature !== shownSignature || crewBack) {
      shownSignature = signature;
      app.dataRev++;
    }
    app.loadedAt = Date.now();
    app.offline = navigator.onLine === false ? "offline" : null;
    loaded = true;
  } catch (error) {
    if (!current()) return false;
    if (error instanceof api.ApiError && error.status === 401) {
      signedOut("Your session ended. Sign in again.");
      return false;
    }
    if (read < readApplied) return false;
    readApplied = read;
    app.notice = describe(error);
    if (navigator.onLine === false) app.offline = "offline";
    else if (unreachable(error)) app.offline = "unreachable";
  }
  showAppBadge();
  if (loaded && app.board?.board) closeAnsweredCards();
  changed("poll");
  return loaded;
}

/**
 * Clears the notifications of cards that no longer wait on the owner: the deck, Later and unseen updates still do, and so
 * does a card whose answer still sits in its Undo window, since Undo brings the card back.
 */
export function closeAnsweredCards(): void {
  void closeAnswered(new Set([...deck(), ...laterCards(), ...updateCards()].map((need) => need.id).concat([...app.held])));
}

/**
 * The home-screen icon's count: the deck's, so a card put as Later or minimised stops counting there too. Untouched
 * until a board has been read: a cold open whose read fails keeps the count it had.
 */
function showAppBadge(): void {
  if (!app.board?.board) return;
  const count = needsYou();
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  void (count ? nav.setAppBadge?.(count) : nav.clearAppBadge?.())?.catch(() => {});
}
