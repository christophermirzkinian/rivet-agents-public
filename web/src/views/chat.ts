import "./command.css";
import "./conversations.css";

import { isUpdate } from "../../../src/shared/answers.js";
import type { ServedNeed } from "../../../src/shared/board.js";
import {
  CHAT_WINDOW_QUIET_MS,
  chatImages,
  imageFields,
  MAX_CHAT_TEXT,
  notAnswerOf,
  quoteText,
  type ChatCancelled,
  type ChatQuote,
} from "../../../src/shared/command.js";
import {
  chatBadge,
  countsUnread,
  linksChat,
  type ConversationDetail,
  type ConversationsResponse,
  type ConversationSummary,
  ownsNoCard,
  SEED_IDS,
  TEAM_ROOM_ID,
  UPDATES_ID,
} from "../../../src/shared/conversations.js";
import { RIVET_NAME, chatName, rivetWords } from "../../../src/shared/names.js";
import { rivet, type Mood } from "../rivet/rivet.js";

/** Rivet's face beside what he says: a tick when it is done, dots while on it, ? when he asks, a cross when broken. */
function moodOf(text: string): Mood {
  if (/\b(fail|broke|broken|red|stuck|error)\b/i.test(text)) return "wrong";
  if (/\?\s*$/.test(text.trim())) return "asking";
  if (/\b(on the site|merged|deployed|built|shipped|done)\b/i.test(text)) return "happy";
  if (/\b(on it|building|making|by about)\b/i.test(text)) return "working";
  return "clear";
}
import { APP_ONLY_PROJECTS, type ThreadProject } from "../../../src/shared/threads.js";
import { ApiError, serverClockSkew } from "../api.js";
import * as cmd from "../command-api.js";
import type { ChatMessage } from "../command-api.js";
import { dictation, MIC, STOP } from "../dictation.js";
import { maybeWhen } from "../../../src/shared/when.js";
import { localDay } from "../day.js";
import { button, describe, h, ICONS, keepFocus, linkify, parkFocus, svg } from "../dom.js";
import { coveredOver } from "../push.js";
import {
  app,
  changed,
  deck,
  laterCards,
  MAC_WAITS,
  macOffline,
  refresh as refreshBoard,
  sameSession,
  signedOut,
  subscribe,
} from "../state.js";
import { onSessionReset } from "../session.js";
import { lostNotice, type Shared } from "../share-target.js";
import { autoSpeak, canSpeak, say, setAutoSpeak, stopVoice, unlockOnTap, unlockVoice, AUTO_SPEAK_EVENT } from "../voice.js";
import { SHARE_WAIT_MS } from "../within.js";
import {
  dropPhotos,
  dropZone,
  emptyPhotos,
  fileLink,
  imageButton,
  mediaSrc,
  pastedFiles,
  photosControl,
  photosHold,
  photosPayload,
} from "./attach.js";
import { cardMedia } from "./card-media.js";
import { cardShareButton } from "./card-share.js";
import { showCard } from "./feed.js";
import { holdFoot } from "./hold-foot.js";
import { closeLightbox } from "./lightbox.js";
import { overlayTraversal } from "../overlay-history.js";
import { createDraftLineage } from "../draft-lineage.js";
import { chatSearch } from "./chat-search.js";
import { registerSearchSource } from "./search-sources.js";
import { openMore } from "./chat-more.js";
import { closeSheet, openSheet } from "./sheet.js";
import { flash } from "./toast.js";
import { onShowThing, showThing, stopText, thingButtons, thingFacts, thingHead } from "./thing.js";
import { enterScreen, leaveScreen, useTap, watchDepth } from "../usage.js";
import { fellAsleep, onCap, onWake } from "../rivet-sleep.js";

// The Chat tab: one conversation with Rivet, like messaging one
// person, and each piece of work's conversation as its thing page (thing.ts). Every send from Chat starts a server
// conversation of its own, so a card Rivet files for it makes that one a thing; Chat reads them all as one.

const POLL_MS = 10_000;
/** Nearly two of the server's 25 s pings missed: the chat stream has stalled. */
export const STREAM_IDLE_MS = 45_000;
/** Needs you comes from GitHub, the board and open chats too, which say nothing on the stream: the list asks again this often. */
export const LIST_REFRESH_MS = 60_000;
/** A list or open conversation redraws this long after the last change it heard of. */
const SETTLE_MS = 400;
/** How many of Chat's messages a read brings. */
const CHAT_PAGE = 50;
/** A search hit's conversation loads at most this many earlier pages looking for it. */
const EARLIER_PAGES_MAX = 20;
/** The unsent message, kept on this device only so a tab switch, backgrounding or reload never loses it. */
const DRAFT_KEY = "rivet.chat.draft";
/** Changes on every draft save, so a send can tell its draft from an identical one another tab saved since. */
const DRAFT_REV_KEY = "rivet.chat.draft.rev";
/** Set while the draft holds words Cancel put back and it is over the limit: kept whole, uncapped, until trimmed. */
const DRAFT_LONG_KEY = "rivet.chat.draft.long";
/** The message the draft replies to, kept beside it so a tab switch or reload keeps the reply too. */
const REPLY_KEY = "rivet.chat.reply";
/** The retired Chat · Threads switch, folder, status chip and window: read for nothing, so removed. */
const RETIRED_KEYS = [
  "rivet.chat.view",
  "rivet.chat.folder",
  "rivet.chat.status",
  "rivet.chat.since",
];

const SPEAKER =
  '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const SEND =
  '<svg viewBox="0 0 24 24"><path d="M4 12l15-7-5 15-2.5-6z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>';
const SHARE =
  '<svg viewBox="0 0 24 24"><path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M6 12v7.5h12V12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const REPLY =
  '<svg viewBox="0 0 24 24"><path d="M9.5 6L4 11.5 9.5 17M4 11.5h9.5a6.5 6.5 0 016.5 6.5v1" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CLOSE =
  '<svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
const CHEVRON =
  '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const OPTIONS =
  '<svg viewBox="0 0 24 24"><path d="M4 7h9M19 7h1M4 17h3M13 17h7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="16" cy="7" r="2.4" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="10" cy="17" r="2.4" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>';
const COLLAPSE =
  '<svg viewBox="0 0 24 24"><path d="M7 4l5 5 5-5M7 20l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const EXPAND =
  '<svg viewBox="0 0 24 24"><path d="M7 9l5-5 5 5M7 15l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const MORE = '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>';
/** The conversations whose topic card Chat shows minimised, on this device only. */
const MINIMISED_KEY = "rivet.chat.minimised";
const CHAT_READ_KEY = "rivet.chat.read";

/** What the Chat tab shows: the one conversation with Rivet, or a thing's page. */
type Screen = { kind: "rivet" } | { kind: "conversation"; id: string };

/** Kept for the session, so a tab switch comes back to it. */
let shown: Screen = { kind: "rivet" };

// A mounted chat switches itself: setting `shown` first would hide that it is another conversation, and the one on
// screen would keep its messages under the new heading.
onShowThing((id) => {
  if (goConversation) goConversation(id);
  else shown = { kind: "conversation", id };
});

/**
 * Chat's line for a card answer, from the answer's text (`answerText`): the verb names the kind, so the card's title
 * shows once ("You approved “X”", "You dismissed “X”", "You answered “X”: Yes"), and a note follows after " · ".
 */
export function answerLine(title: string | undefined, text: string): string {
  const [said = "", ...notes] = text.trim().split(/\s*\n\s*/);
  const after = (verb: string): string => said.slice(verb.length).replace(/^:\s*/, "");
  // An approval names its card in its own text ("Approved: <title>"), which outlives the board and the conversation.
  const named = title ?? (said.startsWith("Approved:") ? after("Approved") || undefined : undefined);
  const card = named ? `“${named}”` : "a card";
  const head = said.startsWith("Approved")
    ? `You approved ${card}`
    : said.startsWith("Dismissed")
      ? `You dismissed ${card}`
      : said.startsWith("Rejected")
        ? `You sent ${card} back to fix`
        : said === "Seen"
          ? `You marked ${card} seen`
          : said === "Done"
            ? `You marked ${card} done`
            : said.startsWith("Comment")
              ? after("Comment")
                ? `You commented on ${card}: ${after("Comment")}`
                : `You commented on ${card}`
              : `You answered ${card}: ${said.startsWith("Chose:") ? after("Chose") : said}`;
  return notes.length ? `${head} · ${notes.join(" · ")}` : head;
}

/** Opens a thing's page (any message of its conversation names it): Feed and notifications call it so. */
export const showConversation = showThing;

/**
 * Opens the thing a chat is working on: its newest conversation that links the chat, in its repo when given. A chat with
 * no thing yet opens Chat with Rivet on a draft naming it, so the owner can ask about it.
 */
export function showChatThing(chat: string, repo?: string | null): void {
  const current = sameSession();
  void openThingFor(chat, repo).then((found) => {
    if (!found && current()) startDraft(`${chat}: `);
  });
}

/**
 * Opens the page of the thing a chat's work is on; false, and nothing opened, when no conversation names the chat. A
 * chat name recurs across repos: given its repo, a conversation that linked that name in another repo is not it.
 */
export function openThingFor(chat: string, repo?: string | null): Promise<boolean> {
  return cmd.getConversations()
    .then((response) => {
      const row = response.conversations.find((item) => linksChat(item.links, chat, repo));
      if (!row) return false;
      showThing(row.id);
      // From the Feed the page is on the Chat tab (a mounted chat switched itself above).
      app.tab = "chat";
      changed();
      return true;
    })
    .catch(() => false);
}


/** The Team room answered 404: no agent has written there yet. */
let roomMissing = false;

/** The conversation open on screen, for the service worker: null on the list, under search results or with no chat mounted. */
export function openConversation(): string | null {
  return teardown !== null && shown.kind === "conversation" && !document.querySelector(".chat.searching") ? shown.id : null;
}

/** Message times as shown, kept for the local day they were worked out on: each row asks on every render. */
const times = new Map<string, string | null>();
let timesDay = "";
let timesCheckedAt = 0;

function timeOf(at: string | undefined): string | null {
  if (!at) return null;
  const now = Date.now();
  if (now - timesCheckedAt > 60_000) {
    timesCheckedAt = now;
    const day = localDay(now);
    if (day !== timesDay) {
      timesDay = day;
      times.clear();
    }
  }
  let said = times.get(at);
  if (said === undefined) {
    said = maybeWhen(at, now);
    times.set(at, said);
  }
  return said;
}

/** Puts `children` in `parent` in order, moving only what is out of place and removing the rest. */
function placeChildren(parent: HTMLElement, children: HTMLElement[]): void {
  let at = parent.firstChild;
  for (const child of children) {
    if (child === at) at = at.nextSibling;
    else parent.insertBefore(child, at);
  }
  while (at) {
    const next: ChildNode | null = at.nextSibling;
    at.remove();
    at = next;
  }
}

/** The cards still open on the board, Later ones too: Open card brings one out of Later (frontCard). */
function boardCards(): ServedNeed[] {
  return [...deck(), ...laterCards()];
}

/** Every card the board holds, update cards too: a thing's page reads its cards' media, ETA and size from them. */
function allCards(): ServedNeed[] {
  const cards = new Map<string, ServedNeed>();
  for (const need of [...boardCards(), ...(app.board?.board?.needs ?? [])]) if (!cards.has(need.id)) cards.set(need.id, need);
  return [...cards.values()];
}

/** Cards a Rivet line named that the board had not: each is read for once, and the bubbles redraw when it lands. */
const boardReadFor = new Set<string>();
function readBoardFor(card: string): void {
  // Before the first board lands its own read is coming; a second one racing it could land first and be overwritten.
  if (!app.board || boardReadFor.has(card)) return;
  boardReadFor.add(card);
  void refreshBoard();
}

function isAppOnly(project: unknown): boolean {
  return (
    typeof project === "string" &&
    APP_ONLY_PROJECTS.has(project as ThreadProject)
  );
}

/** How long a message the quote jumped to stays lit. */
const LIT_MS = 1600;

const STATUS_WORDS: Record<NonNullable<ChatMessage["status"]>, string> = {
  collecting: "Collecting…",
  sent: "Sent",
  typed: `Typed to ${RIVET_NAME}`,
  unconfirmed: "Typed, not confirmed",
  failed: "Not delivered",
  replied: "Replied",
  cancelled: "Cancelled",
};

/**
 * The server's clock by the answers' Date header, so the collect countdown runs to the server's own deadline whatever
 * the phone's clock says. Never a stream line's time: one can arrive late.
 */
const serverNow = (): number => Date.now() + (serverClockSkew() ?? 0);
const CANCEL_OWED_KEY = "rivet.chat.cancelOwed";
/**
 * A Cancel still owed its answer: lost twice, or answered after Chat closed. The next Chat open, or the next word
 * from Rivet, asks again (a cancelled window answers as it did) or puts back the answer it holds. Its id is kept
 * in storage too, so a reload still asks.
 */
let cancelOwed: { id: string; back?: ChatCancelled } | null = readCancelOwed();
function readCancelOwed(): { id: string } | null {
  try {
    const id = localStorage.getItem(CANCEL_OWED_KEY);
    return id ? { id } : null;
  } catch {
    return null;
  }
}
function owe(next: { id: string; back?: ChatCancelled } | null): void {
  cancelOwed = next;
  try {
    if (next) localStorage.setItem(CANCEL_OWED_KEY, next.id);
    else localStorage.removeItem(CANCEL_OWED_KEY);
  } catch {}
}
/** Lines cancelled here or elsewhere: a read already out, or a cached Chat, never brings them back. */
const gone = new Set<string>();
/** How often the collect countdown redraws: often enough that a whole second never shows late. */
const COLLECT_TICK_MS = 250;
/** Reduced motion asked for: the collect bar steps with the countdown's tick rather than draining every frame. */
const stillMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** When the latest collecting window here goes to Rivet (ms since the epoch, the server's clock); null with none known. */
function collectUntil(messages: Iterable<ChatMessage>): number | null {
  let until: number | null = null;
  for (const message of messages) {
    if (message.status !== "collecting" || !message.sendsAt) continue;
    const at = Date.parse(message.sendsAt);
    if (Number.isFinite(at) && (until === null || at > until)) until = at;
  }
  return until;
}

/** Whole seconds until the latest collecting window here goes to Rivet, by the server's clock; null with none known. */
export function collectLeft(messages: Iterable<ChatMessage>, now = serverNow()): number | null {
  const until = collectUntil(messages);
  return until === null ? null : Math.max(0, Math.ceil((until - now) / 1000));
}

/**
 * The collect bar's width in percent, by the exact time left rather than whole seconds, so
 * drawn every frame it drains at one even pace and empties as the window goes. Full with no
 * deadline known.
 */
export function collectBarWidth(messages: Iterable<ChatMessage>, now = serverNow()): number {
  const until = collectUntil(messages);
  if (until === null) return 100;
  return Math.min(100, Math.max(0, ((until - now) * 100) / CHAT_WINDOW_QUIET_MS));
}

/** A collecting line's own status: its seconds left, short enough for a 320-wide screen; the banner says the rest. */
export function collectLine(left: number | null): string {
  return left === null ? STATUS_WORDS.collecting : left > 0 ? `${left}s` : "Sending…";
}

const POSTED_KINDS: Record<string, string> = {
  decision: "Decision",
  update: "Update",
  "merge-ready": "Merge ready",
  todo: "Do it",
  question: "Question",
};

/** A posted card's kind, as its bubble names it. */
function postedKind(kind: string): string {
  return POSTED_KINDS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Rivet's ack as its status line: "building it, ~9:45" reads "building it · ~9:45". */
function ackWords(text: string): string {
  return text.replace(/,\s*~/, " · ~");
}

function readSpeak(): boolean {
  return autoSpeak();
}

function writeSpeak(on: boolean): void {
  setAutoSpeak(on);
}

function readMinimised(): Set<string> {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(MINIMISED_KEY) ?? "[]");
    return new Set(Array.isArray(kept) ? kept.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/** This install has read Chat at least once, so the server's read marks are his. */
function readChatBefore(): boolean {
  try {
    return localStorage.getItem(CHAT_READ_KEY) !== null;
  } catch {
    return false;
  }
}

function noteChatRead(): void {
  try {
    localStorage.setItem(CHAT_READ_KEY, "1");
  } catch {}
}

function writeMinimised(ids: ReadonlySet<string>): void {
  try {
    if (ids.size) localStorage.setItem(MINIMISED_KEY, JSON.stringify([...ids]));
    else localStorage.removeItem(MINIMISED_KEY);
  } catch {}
}

function forgetRetired(): void {
  try {
    for (const key of RETIRED_KEYS) localStorage.removeItem(key);
  } catch {}
}

function readDraft(): string {
  try {
    const draft = localStorage.getItem(DRAFT_KEY) ?? "";
    // Words Cancel put back are the owner's own, whatever their length (a window's raw lines, two put-backs in a row): kept
    // whole until the owner trims them. Any other draft keeps the message limit.
    return localStorage.getItem(DRAFT_LONG_KEY) ? draft : draft.slice(0, MAX_CHAT_TEXT);
  } catch {
    return "";
  }
}

const draftLineage = createDraftLineage();

function readDraftRev(): string | null {
  try {
    return localStorage.getItem(DRAFT_REV_KEY);
  } catch {
    return null;
  }
}

/** `fresh`: words no send owns (put back by Cancel), so a send still out never clears them as its own. */
function writeDraft(value: string, fresh = false): void {
  try {
    if (value.trim()) {
      const previous = fresh ? null : readDraftRev();
      const revision = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      // Put back over a draft and over the limit together, it is kept whole while the owner trims it; any other stays capped.
      const long = value.length > MAX_CHAT_TEXT && (fresh || localStorage.getItem(DRAFT_LONG_KEY) !== null);
      localStorage.setItem(DRAFT_KEY, value);
      localStorage.setItem(DRAFT_REV_KEY, revision);
      if (long) localStorage.setItem(DRAFT_LONG_KEY, "1");
      else localStorage.removeItem(DRAFT_LONG_KEY);
      draftLineage.saved(previous, revision);
    } else {
      localStorage.removeItem(DRAFT_KEY);
      localStorage.removeItem(DRAFT_REV_KEY);
      localStorage.removeItem(DRAFT_LONG_KEY);
    }
  } catch {}
}

interface ReplyTarget {
  id: string;
  quote: ChatQuote;
  /** The conversation it was picked in: the reply is dropped in any other. */
  conversation?: string;
  /** In the Team room, the chat it answers: the sender of the line it was picked on. */
  owner?: string;
}

function readReply(): ReplyTarget | null {
  try {
    const saved = JSON.parse(
      localStorage.getItem(REPLY_KEY) ?? "null",
    ) as Partial<ReplyTarget> | null;
    const quote = saved?.quote;
    if (
      typeof saved?.id !== "string" ||
      !quote ||
      (quote.from !== "owner" && quote.from !== "rivet") ||
      typeof quote.text !== "string"
    )
      return null;
    return {
      id: saved.id,
      quote: { from: quote.from, text: quote.text },
      ...(typeof saved.conversation === "string"
        ? { conversation: saved.conversation }
        : {}),
      ...(typeof saved.owner === "string" ? { owner: saved.owner } : {}),
    };
  } catch {
    return null;
  }
}

function writeReply(target: ReplyTarget | null): void {
  try {
    if (target) localStorage.setItem(REPLY_KEY, JSON.stringify(target));
    else localStorage.removeItem(REPLY_KEY);
  } catch {}
}

let teardown: (() => void) | null = null;
/** Opens a conversation in the chat on screen, if any: the desktop pane stays mounted while the Feed asks for one. */
let goConversation: ((id: string, record?: boolean) => void) | null = null;
/** Brings the chat on screen back to the one conversation with Rivet, if any. */
let goRivet: (() => void) | null = null;
/** Why the chat on screen would not share `message`, or null when it may; null with no chat mounted. */
let liveRefusal: ((message: ChatMessage) => string | null) | null = null;
/**
 * The latest word on each conversation's project, kept for the session so a remount never forgets one: whether it is
 * app-only (its project is kept in the app, or Rivet filed it there whatever its project now) and the clock when that word
 * arrived. A word that it is app-only always counts, in any order. A word that it is not clears it only when its
 * request was sent after the last word arrived, so the server read it later: a slow or reordered response never lifts
 * a newer restriction. A message's own project can add but never clear; a stream event may have waited on the
 * connection, so its word clears nothing either: the fetch it starts does.
 */
const threadWord = new Map<string, { app: boolean; at: number }>();
let projectClock = 0;
const nextStamp = (): number => ++projectClock;
/** `sent` is the clock when the word's request went out; a stream event's is when it arrived. True when Share flips. */
function heardProject(
  id: string,
  app: boolean,
  sent: number,
  canClear = true,
): boolean {
  const was = threadWord.get(id);
  if (!app && (!canClear || (was && sent <= was.at))) return false;
  threadWord.set(id, { app, at: nextStamp() });
  return was?.app !== app;
}
/** Messages that say their conversation is app-only; true when Share flips. */
function heardMessages(list: readonly ChatMessage[]): boolean {
  let flipped = false;
  for (const message of list)
    if (message.threadId !== undefined && isAppOnly(message.project))
      flipped = heardProject(message.threadId, true, 0, false) || flipped;
  return flipped;
}
/**
 * Chat's newest page as last read, kept across mounts so Rivet's sheet opens on it at once while the read for the
 * newest goes out. A session's end forgets it.
 */
let lastChat: readonly ChatMessage[] | null = null;
/** The things Chat's pages named (ChatPage.things): their lines carry Open topic though their card line is not loaded. */
const chatThings = new Set<string>();
onSessionReset(() => {
  lastChat = null;
  chatThings.clear();
  gone.clear();
  // Not the owed Cancel: every app start resets the session, and a reload must still ask for its words.
});
/** True once a conversation was read since the stream last (re)opened; until then no reply is offered to share. */
let appOnlyHeard = false;
/** Bumped on every reset of appOnlyHeard: only a read asked for since the last reset sets it again. */
let appOnlyGen = 0;
const SHARE_CHECKING =
  "Checking where this conversation belongs. Try again in a moment.";
const SHARE_APP_ONLY =
  "This conversation is personal now: it stays in the app.";
/** The message box of the chat on screen, if any: a send that finishes after the chat was left and reopened clears this one. */
let draftBox: { text: HTMLTextAreaElement; fit: () => void } | null = null;

/**
 * Read-aloud state, kept for the session. `floor` is the time of the newest message the chat knew of when it first
 * loaded: nothing older is ever spoken, so a refresh or reconnect never replays history. `heard` holds the Rivet
 * messages already shown or spoken, by id, since arrival order (not id order) decides what is new.
 */
let floor: string | null = null;
const heard = new Set<string>();
const listTop = (rows: readonly ConversationSummary[]): string | null =>
  rows.reduce<string | null>(
    (top, row) => (top === null || row.lastAt > top ? row.lastAt : top),
    null,
  );
/** Rivet messages already counted into a row's unread, so a message sent again on the stream counts once. */
const counted = new Set<string>();
let reload: (() => Promise<boolean>) | null = null;

/** Pull to refresh, and a push the service worker held back: true once the redraw shows the newest. */
export function refresh(): Promise<boolean> {
  return reload?.() ?? Promise.resolve(false);
}

/** A draft startDraft made for the next chat to open on, held here too since storage may refuse it. */
let pendingDraft: string | null = null;
/** startDraft ran with no chat on screen: the next one to open puts the keyboard up on the draft. */
let focusOnMount = false;

/**
 * Starts the unsent message with `prefix`, ahead of anything already typed, in Chat. A draft that
 * already starts with it, or that would not fit with it, is left as it is: his words are never cut. False when the
 * draft does not start with `prefix` afterwards.
 */
export function startDraft(prefix: string): boolean {
  // So too when the draft already starts with it.
  openRivet();
  if (!draftBox) focusOnMount = true;
  const draft = draftBox ? draftBox.text.value : (pendingDraft ?? readDraft());
  if (draft.startsWith(prefix)) return true;
  if (prefix.length + draft.length > MAX_CHAT_TEXT) return false;
  const next = `${prefix}${draft}`;
  writeDraft(next);
  if (!draftBox) {
    pendingDraft = next;
    return true;
  }
  draftBox.text.value = next;
  draftBox.fit();
  draftBox.text.focus();
  return true;
}

/** Rivet's chat: the conversation with him on the Chat tab, never the thing left open. */
export function showRivetChat(): void {
  openRivet();
  app.tab = "chat";
  changed();
}

/** Started from elsewhere, it is about something else: Chat, never whichever thing was open last (on a desktop the chat stays open beside the other tabs). */
function openRivet(): void {
  if (goRivet) return goRivet();
  shown = { kind: "rivet" };
  writeReply(null);
}

export const SHARE_TOO_LONG =
  "The shared words don't fit after your draft. Send or clear it, then share again.";
/** A share from another app, for the next chat to open on, or for the one on screen through putShare. */
let pendingShare: Shared | null = null;
let putShare: (() => void) | null = null;

/** Puts what another app shared in Chat's composer: its words in the box, its files attached. Nothing sends until Send. */
export function receiveShare(share: Shared): void {
  openRivet();
  pendingShare = share;
  putShare?.();
}

function quoteParts(quote: ChatQuote): HTMLElement[] {
  return [
    h(
      "span",
      { class: "chat-quote-who" },
      quote.from === "owner" ? "You" : RIVET_NAME,
    ),
    h("span", { class: "chat-quote-text" }, quote.text),
  ];
}

/** A message the server has not stored yet (no `seq`) is the newest of its millisecond. */
const UNSTORED = Number.MAX_SAFE_INTEGER;

/** Oldest first; one `at` goes by the server's insert order, so a card follows the card it answers. */
function byTime(
  a: Pick<ChatMessage, "at" | "id" | "seq">,
  b: Pick<ChatMessage, "at" | "id" | "seq">,
): number {
  return a.at.localeCompare(b.at) || (a.seq ?? UNSTORED) - (b.seq ?? UNSTORED) || a.id.localeCompare(b.id);
}

/** In the Team room: the agents' talk, never unread and never read aloud. */
const inRoom = (message: ChatMessage): boolean =>
  (message.threadId ?? message.id) === TEAM_ROOM_ID;

/** A message as a list row's last line: its first line, or what it carries when it has no text. */
function lastLine(message: ChatMessage): string {
  const line = message.text
    .split("\n")
    .find((part) => part.trim())
    ?.trim();
  if (line && message.team)
    return `${chatName(message.team.from)} → ${chatName(message.team.to)}: ${line}`;
  if (line) return line;
  if (message.video) return "Video";
  if (chatImages(message).length) return "Photo";
  return message.files?.length ? "File" : "";
}

/**
 * The light edit step before a reply leaves the app. Send hands the text to the share sheet, or copies it
 * where there is none; nothing is sent from here, and Cancel shares nothing. `refusal` is asked again at Send: a
 * conversation can move to an app-only project while the sheet is open.
 */
function openShare(reply: string, refusal: () => string | null): void {
  const area = h("textarea", {
    class: "sheet-text",
    attrs: { rows: "6", "aria-label": "Text to share" },
  });
  area.value = rivetWords(reply);
  const go = button(
    [svg(SHARE, "btn-icon"), "Send"],
    () => {
      const text = area.value.trim();
      if (!text) return area.focus();
      const refused = refusal();
      if (refused !== null) {
        flash(refused, "error");
        return closeSheet();
      }
      if (typeof navigator.share !== "function") {
        void navigator.clipboard?.writeText(text).then(() => flash("Copied. Paste it where you like."));
        return closeSheet();
      }
      // share must start inside the tap, before any await, or iOS refuses it.
      go.disabled = true;
      const waiting = setTimeout(() => (go.disabled = false), SHARE_WAIT_MS);
      navigator.share({ text }).then(
        () => {
          clearTimeout(waiting);
          closeSheet();
        },
        (error: unknown) => {
          clearTimeout(waiting);
          go.disabled = false;
          if (!(error instanceof Error && error.name === "AbortError"))
            flash("Couldn't open the share sheet. Try again.", "error");
        },
      );
    },
    "primary big chat-share-send",
    false,
    "chat.share.send",
  );
  openSheet(
    "Share",
    {
      mount: (el) =>
        el.replaceChildren(
          area,
          h(
            "p",
            { class: "sheet-hint" },
            "Trim anything only you should see, then send.",
          ),
          go,
        ),
      unmount: () => {},
    },
    "Cancel",
    undefined,
    { use: "share", closeUse: "chat.share.cancel" },
  );
}

registerSearchSource("chat-history", (query) =>
  query ? cmd.searchChat(query).then((response) => response.results) : [],
);

/**
 * `later`, Rivet's sheet's: the chat's frame (its head and box) goes up at once and its messages land when `later` runs,
 * so the sheet starts its slide before the thread is built. A message to go to, or a draft to type on, mounts whole.
 */
export function mount(el: HTMLElement, later?: (then: () => void) => void): void {
  unmount();
  forgetRetired();
  /** The open conversation's messages. */
  let messages = new Map<string, ChatMessage>();
  let detail: ConversationDetail | null = null;
  let detailTimer = 0;
  let detailTicket = 0;
  let list: ConversationsResponse | null = null;
  /** Chat's newest page has come at least once since it last opened. */
  let chatLoaded = false;
  // While you were away: Chat marks his read the moment it lands at its newest, so the pill keeps the Rivet lines
  // the first list since he came back had unread, by its read mark, until he leaves again.
  /** Each topic's unread count from that list, until its lines are on hand. */
  const awayOwed = new Map<string, number>();
  /** The lines the pill counts. */
  const away = new Set<string>();
  let awayLoad = true;
  const awayPill = h("li", { class: "chat-away", attrs: { role: "status" } });
  /** A topic Chat may mark read: the pill counts only these, so what it counted is read by the time he is back. */
  const readable = (row: ConversationSummary) =>
    // A minimised topic shows New until he opens it; a thing he marked unread stays so until he opens it (2026-11-16).
    row.id !== TEAM_ROOM_ID && !minimised.has(row.id) && !(row.thing && row.markedUnread);
  /** Where Chat's held lines run unbroken from: a refresh keeps lines from before its page, past a gap (2026-11-16). */
  let unbrokenFrom = "";
  /** The open thing's first read failed, so its empty line says so and offers Try again rather than Loading… on. */
  let loadFailed = false;
  let listTimer = 0;
  let listTicket = 0;
  /** Whether the open conversation has messages before the earliest loaded; null until an earlier page loaded. */
  let earlierMore: boolean | null = null;
  /** The first message of the earliest page loaded, in the server's order: the cursor for the page before it. */
  let earliestPage: string | null = null;
  /** The earlier page on its way, and the messages it is for. */
  let loadingEarlier: {
    into: Map<string, ChatMessage>;
    done: Promise<boolean>;
  } | null = null;
  let speak = readSpeak();
  let stream: EventSource | null = null;
  let poll = 0;
  let idle = 0;
  let sending = false;
  /** Rivet Cloud's month of hours used up: "until 1 December" while nothing can be sent (rivet-sleep.ts), else null. */
  let cappedWake: string | null = null;
  let alive = true;
  /** The message the next send replies to; × drops it. */
  let replyingTo: ReplyTarget | null = null;
  let lit: string | null = null;
  /**
   * Counts jumps, and search hits still on their way to one, so a refresh that a jump overtook, or that lands while a
   * hit is still loading, does not say the newest is on screen.
   */
  let jumps = 0;
  let seeking = 0;
  let litTimer = 0;
  /** Conversations whose topic card Chat shows as one row. */
  const minimised = readMinimised();
  /** Rivet messages that came into the open conversation since it was last marked read. */
  let unseen = 0;
  /** The newest message the open conversation was marked read up to. */
  let marked: string | null = null;
  /** More topics is open over Chat: the conversations, with Chat's search on top of them. */
  let topicsOpen = false;
  /** The archived conversations read so far under More topics, and the cursor of the next page. */
  let archived: ConversationSummary[] | null = null;
  let archivedNext: string | null = null;
  let archivedBusy = false;
  /** Bumped when the archived pages are dropped, so a page still in flight from before lands nowhere. */
  let archivedRead = 0;
  /** The thread waits for `later`; `heldStick`: a render while it waited asked to stick to the newest. */
  let threadHeld = !!later && !app.chatFocus && !focusOnMount;
  let heldStick = false;

  const thread = h("ol", {
    class: "chat-thread",
    attrs: { "aria-live": "polite", "aria-label": "Messages" },
  });
  const earlier = button(
    "Earlier messages",
    () => void loadEarlier(),
    "ghost conv-earlier",
    false,
    "chat.earlier",
  );
  const headBox = h("div", { class: "conv-head-box" });
  /** A thing's Share and Stop it, under its say-line. */
  const thingFoot = h("div", { class: "thing-foot" });
  const scroller = h("div", { class: "chat-scroll" }, earlier, thread);
  watchDepth(scroller, () => "chat");
  const foot = holdFoot(scroller, 40);
  /** Where Chat was when More topics or search covered it, to put back when they go. */
  let covered: { held: boolean; top: number } | null = null;
  /** What the last render drew: More topics opened from a conversation's page has no place of Chat's to keep. */
  let drawn: Screen["kind"] | null = null;
  let thingOnTop = false;
  const text = h("textarea", {
    class: "chat-text",
    attrs: {
      rows: "1",
      maxlength: String(MAX_CHAT_TEXT),
      placeholder: "Message",
      "aria-label": `Message ${RIVET_NAME}`,
      enterkeyhint: "send",
    },
  });
  const hint = h("p", { class: "chat-hint", attrs: { role: "status" } });
  const replyQuote = h("div", { class: "chat-quote box" });
  const replyBar = h(
    "div",
    {
      class: "chat-replying",
      attrs: { role: "group", "aria-label": "Replying to" },
    },
    replyQuote,
    h(
      "button",
      {
        class: "icon-btn chat-replying-cancel",
        attrs: { type: "button", "aria-label": "Cancel reply", "data-use": "chat.reply.cancel" },
        on: {
          click: () => {
            setReply(null);
            text.focus();
          },
        },
      },
      svg(CLOSE, "icon-btn-icon"),
    ),
  );
  replyBar.hidden = true;
  // While a window collects (2026-11-16): the seconds left by the server's deadline, and Cancel, which puts it back in
  // the box.
  const collectWords = h("strong", { class: "chat-collecting-when" });
  const collectBar = h("span", { class: "chat-collecting-bar", attrs: { "aria-hidden": "true" } });
  const cancelBtn = h(
    "button",
    {
      class: "chat-collecting-cancel",
      attrs: { type: "button", "data-use": "chat.compose.cancel" },
      on: { click: () => void cancelCollecting() },
    },
    "Cancel",
  ) as HTMLButtonElement;
  const collectMore = h("span", { class: "chat-collecting-more" }, "Cancel puts it back in the box");
  const collecting = h(
    "div",
    { class: "chat-collecting" },
    h("p", { class: "chat-collecting-words", attrs: { role: "status" } }, collectWords, collectMore),
    cancelBtn,
    collectBar,
  );
  collecting.hidden = true;
  let cancelling = false;
  let collectTick = 0;
  let collectFrame = 0;
  /** The bar's length, as a scale so a redraw never lays the page out again. Returns its width in percent. */
  function paintBar(): number {
    const width = collectBarWidth(messages.values());
    collectBar.style.transform = `scaleX(${width / 100})`;
    return width;
  }
  /**
   * The bar every frame while it drains, at one even pace rather than a step a second. It rests once empty or full
   * (no deadline known), where nothing moves, and paintCollect's tick starts it again.
   */
  function drainCollect(): void {
    const width = paintBar();
    collectFrame = width > 0 && width < 100 ? window.requestAnimationFrame(drainCollect) : 0;
  }
  /** The banner's words and each collecting line's seconds, from the server's deadline. */
  function paintCollect(): void {
    const left = collectLeft(messages.values());
    const words =
      left === null
        ? `Sending to ${RIVET_NAME} soon`
        : left > 0
          ? `Sending to ${RIVET_NAME} in\u00a0${left}s`
          : `Sending to ${RIVET_NAME}…`;
    if (collectWords.textContent !== words) collectWords.textContent = words;
    // Reduced motion: the bar moves on this tick alone. Otherwise the frame loop drains it, started again if it rested.
    if (stillMotion()) paintBar();
    else if (!collectFrame) drainCollect();
    const line = ` · ${collectLine(left)}`;
    for (const status of thread.querySelectorAll<HTMLElement>(".chat-status.collecting"))
      if (status.textContent !== line) status.textContent = line;
    // Not while a send is out: the window may be about to take that line too.
    cancelBtn.disabled = cancelling || sending;
    // A Fix it goes as it is: no Cancel is offered for it.
    const keeps = !!newestCollecting()?.keeps;
    cancelBtn.hidden = keeps;
    collectMore.hidden = keeps;
    cancelBtn.textContent = cancelling ? "Cancelling…" : "Cancel";
  }
  /** Runs the countdown while anything here collects, and stops once nothing does. */
  function tickCollect(): void {
    const any = [...messages.values()].some((message) => message.status === "collecting");
    collecting.hidden = !any;
    if (!any) {
      window.clearInterval(collectTick);
      window.cancelAnimationFrame(collectFrame);
      collectTick = 0;
      collectFrame = 0;
      return;
    }
    paintCollect();
    if (!collectTick) collectTick = window.setInterval(paintCollect, COLLECT_TICK_MS);
  }
  /**
   * Cancel: the server takes the window back before it goes, the lines leave the chat, and their words, photos and
   * files return to the box, ahead of anything typed since. Sent already, they stay and the owner is told.
   */
  function newestCollecting(): ChatMessage | undefined {
    const open = [...messages.values()].filter((message) => message.status === "collecting");
    return open[open.length - 1];
  }
  async function cancelCollecting(): Promise<void> {
    const named = newestCollecting();
    if (!named || named.keeps || cancelling || sending) return;
    await askCancel(named.id);
  }
  const lostAnswer = (error: unknown): boolean => error instanceof ApiError && (error.status === 0 || error.status === 408 || error.status >= 500);
  async function askCancel(id: string): Promise<void> {
    cancelling = true;
    owe({ id });
    paintCollect();
    try {
      // A lost answer is asked once more: a cancelled window answers as it did, so the words still come back.
      const back = await cmd.cancelChat(id).catch((error: unknown) => {
        if (lostAnswer(error)) return cmd.cancelChat(id);
        throw error;
      });
      // Chat closed while it was out: the next Chat open puts it back, unless a newer Chat has already asked and put it.
      if (!alive) {
        if (cancelOwed?.id === id) owe({ id, back });
        return;
      }
      owe(null);
      putBack(back);
    } catch (error) {
      // Lost twice: kept owed, asked again when the server is next heard. Any answer that says what became of it ends it.
      if (!lostAnswer(error) && cancelOwed?.id === id) owe(null);
      if (!alive || authFail(error)) return;
      if (error instanceof ApiError && (error.status === 409 || error.status === 404)) {
        hint.textContent = error.message;
        // At once: its lines read as they are rather than counting on.
        void loadDetail();
      } else if (lostAnswer(error)) hint.textContent = "Cancel didn't hear back. It asks again shortly.";
      else hint.textContent = describe(error);
    } finally {
      cancelling = false;
      if (alive) tickCollect();
    }
  }
  /** A Cancel owed its answer is settled once the server is heard here: put back, or asked again. */
  function settleCancel(): void {
    if (!cancelOwed || cancelling || sending || !alive) return;
    const { id, back } = cancelOwed;
    if (!back) return void askCancel(id);
    owe(null);
    putBack(back);
  }
  function putBack(back: ChatCancelled): void {
    cmd.tookBack(back);
    for (const id of back.ids) {
      gone.add(id);
      messages.delete(id);
    }
    if (back.text) {
      // Words still in the box (a send whose answer was lost) are not put there twice.
      const typed = text.value.trim();
      text.value = !typed || typed === back.text || back.text.split("\n").includes(typed) ? back.text : `${back.text}\n${text.value}`;
      fit();
      writeDraft(text.value, true);
    }
    if (back.images.length || back.files.length) attach.put(back.images, back.files);
    // A reply comes back as one: on the page it is put back on, or from Chat as it was picked there.
    if (back.replyTo && back.quote) {
      const here = shownId();
      setReply({ id: back.replyTo, quote: back.quote, ...(here && !back.ids.includes(here) ? { conversation: here } : {}) }, false);
    }
    hint.textContent =
      text.value.length > MAX_CHAT_TEXT
        ? "Cancelled. It's back in the box, too long to send as one: trim it first."
        : "Cancelled. It's back in the box to edit.";
    // A page that was the cancelled line's own conversation has nothing left to show.
    if (shown.kind === "conversation" && back.ids.includes(shown.id)) showRivet();
    else render(false);
    void loadList(true);
    text.focus();
  }
  const micBtn = h(
    "button",
    {
      class: "icon-btn chat-mic",
      attrs: {
        type: "button",
        "aria-label": "Speak a message",
        "aria-pressed": "false",
        "data-use": "chat.compose.mic",
      },
      // Keeps the caret in the box: a blur would end dictation before the tap could. Not
      // pointerdown: WebKit drops the tap's click when that is prevented.
      on: {
        click: () => toggleMic(),
        mousedown: (event) => event.preventDefault(),
      },
    },
    svg(MIC, "icon-btn-icon"),
  );
  const voice = dictation(text, (on) => {
    micBtn.replaceChildren(svg(on ? STOP : MIC, "icon-btn-icon"));
    micBtn.classList.toggle("on", on);
    micBtn.setAttribute("aria-pressed", String(on));
    micBtn.setAttribute(
      "aria-label",
      on ? "Stop dictation" : "Speak a message",
    );
    hint.textContent = on ? "Listening… tap the mic to stop" : "";
  });
  const sendBtn = h("button", {
    class: "btn primary chat-send",
    attrs: { type: "button", "data-use": "chat.compose.send" },
    on: { click: send },
  });
  // While the Mac is offline the button says a message waits for it, the header pill alone
  // being too far from the thumb.
  let sendWaits: boolean | null = null;
  const paintSend = () => {
    sendBtn.disabled = sending || cappedWake !== null;
    const waits = macOffline();
    if (waits === sendWaits) return;
    sendWaits = waits;
    sendBtn.classList.toggle("waits", waits);
    sendBtn.setAttribute("aria-label", waits ? `Send ${MAC_WAITS}` : "Send");
    sendBtn.replaceChildren(
      svg(SEND, "btn-icon"),
      ...(waits ? [h("span", { class: "chat-send-wait" }, MAC_WAITS)] : []),
    );
  };
  paintSend();
  const attached = emptyPhotos();
  const attach = photosControl(attached, {
    use: "chat.compose.attach",
    onChange: () => (hint.textContent = ""),
    onSignedOut: () => signedOut("Your session ended. Sign in again."),
  });
  /** Read aloud, on the list's head and on a conversation's: the two always agree. */
  const speakBtns: HTMLButtonElement[] = [];
  const speakButton = (): HTMLButtonElement => {
    const one = h("button", {
      class: "btn ghost chat-speak",
      attrs: { type: "button", "aria-pressed": String(speak), "data-use": "chat.speak.toggle" },
      on: { click: () => toggleSpeak() },
    });
    speakBtns.push(one);
    return one;
  };
  const toggleSpeak = () => {
    speak = !speak;
    writeSpeak(speak);
    if (speak) {
      unlockVoice();
      // Read the latest message once; after that only new ones are spoken. The press is a new boundary: nothing
      // already on screen, and nothing older than it that a later load brings, is read.
      const latest = newest("rivet", true);
      if (latest && !inRoom(latest)) say(latest.text);
      baseline([...messages.values()]);
      const top = list ? listTop(list.conversations) : null;
      if (top !== null && (floor === null || top > floor)) floor = top;
      // While the conversation is empty, the press separates history from new replies, even if its list arrived.
      if (messages.size === 0) {
        const pressedAt = new Date(Date.now()).toISOString();
        if (floor === null || pressedAt > floor) floor = pressedAt;
      }
    } else stopVoice();
    renderSpeak();
  };
  const headSpeak = speakButton();
  // Chat's head keeps one options button: Collapse all, Expand all, Mark all read, and Read aloud as a switch.
  const speakSwitch = h(
    "button",
    {
      class: "chat-menu-item chat-speak",
      attrs: { type: "button", role: "menuitemcheckbox", "aria-checked": String(speak), "data-use": "chat.speak.toggle" },
      on: { click: () => toggleSpeak() },
    },
    svg(SPEAKER, "btn-icon"),
    h("span", { class: "chat-menu-grow" }, "Read aloud"),
    h("span", { class: "chat-switch", attrs: { "aria-hidden": "true" } }),
  );
  const renderSpeak = () => {
    speak = readSpeak();
    speakSwitch.setAttribute("aria-checked", String(speak));
    for (const one of speakBtns) {
      one.setAttribute("aria-pressed", String(speak));
      one.replaceChildren(
        svg(SPEAKER, "btn-icon"),
        speak ? "Reading aloud" : "Read aloud",
      );
    }
  };
  renderSpeak();
  const unreadCount = h("small", { class: "chat-menu-count" });
  const menuItem = (icon: string, label: string, use: string, go: () => void, extra: HTMLElement | null = null) =>
    h(
      "button",
      {
        class: "chat-menu-item",
        attrs: { type: "button", role: "menuitem", "data-use": use },
        on: {
          click: () => {
            closeMenu();
            go();
          },
        },
      },
      svg(icon, "btn-icon"),
      h("span", { class: "chat-menu-grow" }, label),
      extra,
    );
  const markAllBtn = menuItem(ICONS.yes, "Mark all read", "chat.options.mark-read", () => markAllRead(), unreadCount);
  // Off Chat only Read aloud stays: a topic's page in Rivet's sheet has no other.
  const chatOnlyItems = [
    menuItem(COLLAPSE, "Collapse all", "chat.options.collapse-all", () => collapseAll(true)),
    menuItem(EXPAND, "Expand all", "chat.options.expand-all", () => collapseAll(false)),
    markAllBtn,
  ];
  const menu = h(
    "div",
    { class: "chat-menu", attrs: { role: "menu", "aria-label": "Chat options" } },
    ...chatOnlyItems,
    canSpeak() ? speakSwitch : null,
  );
  menu.hidden = true;
  /** The page the menu was last drawn for: "" is Chat. */
  let menuView = "";
  const optionsBtn = h(
    "button",
    {
      class: "icon-btn chat-options",
      attrs: { type: "button", "aria-label": "Chat options", "aria-haspopup": "menu", "aria-expanded": "false", "data-use": "chat.options" },
      on: { click: () => (menu.hidden ? openMenu() : closeMenu()) },
    },
    svg(OPTIONS, "icon-btn-icon"),
  );
  const outside = (event: Event) => {
    if (event.target instanceof Node && !menu.contains(event.target) && !optionsBtn.contains(event.target)) closeMenu();
  };
  const menuKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    closeMenu();
    optionsBtn.focus();
  };
  function openMenu(): void {
    const count = markable().length;
    unreadCount.textContent = count ? `${count} new` : "";
    markAllBtn.disabled = count === 0;
    menu.hidden = false;
    optionsBtn.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", menuKey, true);
  }
  function closeMenu(): void {
    menu.hidden = true;
    optionsBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", menuKey, true);
  }

  const chatHead = h(
    "div",
    { class: "chat-head" },
    h("h1", { class: "chat-title" }, RIVET_NAME),
    h("div", { class: "chat-tools" }, optionsBtn, menu),
  );
  const composeBox = h(
    "div",
    { class: "chat-compose-box" },
    attach.preview,
    collecting,
    replyBar,
    h(
      "div",
      { class: "chat-compose" },
      attach.button,
      h("div", { class: "chat-field" }, text, micBtn),
      sendBtn,
    ),
  );
  // A title hit opens that thing on its newest; a message hit is brought up where it lives, in Chat or on its thing.
  const search = chatSearch(
    (id, whole) => (whole ? openConversationNow(id) : openHit(id)),
    () => render(false),
  );
  const topicsRow = h("div", { class: "chat-topics-row" });
  const topicsList = h("ul", { class: "chat-topics", attrs: { "aria-label": "Topics" } });
  const section = h(
    "section",
    { class: "chat", attrs: { "data-card-keys": "off" } },
    chatHead,
    headBox,
    topicsRow,
    search.el,
    topicsList,
    scroller,
    composeBox,
    thingFoot,
    hint,
  );
  el.replaceChildren(section);

  // A draft startDraft began for this mount (Discuss this) opens with the keyboard up, the caret after it.
  const started = focusOnMount;
  focusOnMount = false;
  text.value = pendingDraft ?? readDraft();
  pendingDraft = null;
  if (text.value) fit();
  const kept = readReply();
  // A reply belongs to the conversation it was picked in: kept until that one opens. One saved before conversations
  // names none, so it is dropped.
  if (kept && shown.kind === "conversation" && kept.conversation === shown.id)
    setReply(kept, false);
  else if (kept && kept.conversation === undefined) writeReply(null);
  const box = { text, fit };
  draftBox = box;
  putShare = () => {
    const share = pendingShare;
    pendingShare = null;
    if (!share) return;
    // After anything already typed, on a line of its own; words that would not fit are never cut, and he is told.
    const joined = text.value
      ? `${text.value.trimEnd()}\n${share.text}`
      : share.text;
    if (share.text && joined.length > MAX_CHAT_TEXT) flash(SHARE_TOO_LONG);
    else if (share.text) {
      text.value = joined;
      fit();
      writeDraft(text.value);
    }
    const lost = lostNotice(share.lost);
    attach.add(share.files, lost ? [lost] : []);
  };
  putShare();
  text.addEventListener("input", () => {
    fit();
    writeDraft(text.value);
  });
  text.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      useTap("chat.compose.send");
      send();
    }
  });
  scroller.addEventListener("scroll", () => markRead());
  // Photos and files dragged from the desktop, or a screenshot pasted, attach as the clip's picker would. The whole
  // pane takes the drop, past the column's edges; a read-only conversation, with no composer, takes none.
  // Only while the composer is on screen and takes files: not over More topics or a search, which hide it, nor while
  // Rivet is asleep, when the clip is off too.
  const composing = () =>
    !composeBox.hidden && cappedWake === null && !section.classList.contains("topics") && !section.classList.contains("searching");
  const unzone = dropZone(el, (files) => attach.add(files), composing);
  // On the composer, so a screenshot pasted into the search field is not taken unseen.
  composeBox.addEventListener("paste", (event) => {
    if (!composing()) return;
    const files = pastedFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    attach.add(files);
  });

  /**
   * The box grows with what is typed. Measuring shrinks it for a moment, and a scroll around it (Rivet's sheet with the
   * keyboard up, or the messages) clamps to that shorter page and stays there: More topics flashed back and the box
   * jumped on every key. Each one keeps its place.
   */
  function fit(): void {
    const kept: [Element, number][] = [];
    for (let el = text.parentElement; el; el = el.parentElement) if (el.scrollTop) kept.push([el, el.scrollTop]);
    if (scroller.scrollTop) kept.push([scroller, scroller.scrollTop]);
    text.style.height = "auto";
    text.style.height = `${Math.min(text.scrollHeight, 180)}px`;
    for (const [el, top] of kept) if (el.scrollTop !== top) el.scrollTop = top;
  }

  /** A piece of work's page: any conversation but Rivet's own (Updates, quote alerts, Agent Chat). */
  function thingPage(): boolean {
    const id = shownId();
    return id !== null && !ownsNoCard(id) && !readOnly();
  }

  /**
   * In Chat: every line of every conversation but the old Updates (2026-11-16). A thing's lines stay on its page too;
   * in Chat each of Rivet's carries Open topic (topicOf).
   */
  function inChat(message: ChatMessage): boolean {
    return (message.threadId ?? message.id) !== UPDATES_ID;
  }

  /** In Chat, the thing a line of Rivet's (not a card line, which opens its page already) belongs to: its Open topic. */
  function topicOf(message: ChatMessage): string | null {
    if (shown.kind !== "rivet" || message.from !== "rivet" || message.posted || message.team) return null;
    const id = message.threadId ?? message.id;
    if (ownsNoCard(id)) return null;
    return chatThings.has(id) || hasCard(id) || !!list?.conversations.some((row) => row.id === id && row.thing) ? id : null;
  }

  /** The title of an answered card: the one the server sent with the answer, else its board card, else the line that posted it. */
  function answeredTitle(answer: ChatMessage): string | undefined {
    const posted = [...messages.values()].find((one) => one.posted?.id === answer.card)?.posted;
    return answer.cardTitle ?? allCards().find((need) => need.id === answer.card)?.title ?? posted?.title;
  }

  /** A card line of conversation `id` is in Chat already (other than `except`). */
  function hasCard(id: string, except?: string): boolean {
    for (const one of messages.values()) if (one.posted && one.id !== except && (one.threadId ?? one.id) === id) return true;
    return false;
  }

  /** The old Updates conversation is read-only: opened by its id, or by any message of it once its detail says so. */
  function readOnly(): boolean {
    const id = shownId();
    return (
      id !== null &&
      (id === UPDATES_ID ||
        summaryOf(id)?.updates === true ||
        (detail !== null && detail.conversation.updates))
    );
  }

  function shownId(): string | null {
    return shown.kind === "conversation" ? shown.id : null;
  }

  /**
   * A server-owned room other than the Agent Chat room: a line typed there with no Reply starts a chat of its own, since
   * the room files no card. A topic's page keeps its lines (2026-11-17).
   */
  function roomStartsChat(id: string): boolean {
    return ownsNoCard(id) && id !== TEAM_ROOM_ID;
  }

  function paintPlaceholder(): void {
    const id = shownId();
    text.placeholder =
      cappedWake !== null
        ? `Asleep ${cappedWake}`
        : id === TEAM_ROOM_ID
        ? `Message ${RIVET_NAME} about a chat`
        : id !== null && !replyingTo
          ? // Short enough for one line beside the mic at 320 (the box is about 100px of text there).
            roomStartsChat(id)
            ? "New chat"
            : "Reply here"
          : thingPage()
            ? "Say something to this thing…"
            : "Message";
  }

  function setReply(target: ReplyTarget | null, focus = true): void {
    replyingTo = target;
    paintPlaceholder();
    writeReply(target);
    replyBar.hidden = target === null;
    if (!target) return replyQuote.replaceChildren();
    replyQuote.replaceChildren(...quoteParts(target.quote));
    if (focus) text.focus();
  }

  /** Hides the reply without forgetting it: it stays saved for its own conversation. */
  function putReplyAway(): void {
    replyingTo = null;
    paintPlaceholder();
    replyBar.hidden = true;
    replyQuote.replaceChildren();
  }

  /** Brings the quoted message into view and lights it for a moment; one not loaded here is left alone. */
  function jump(id: string): void {
    const into = messages.get(id);
    if (into && shown.kind === "rivet" && minimised.has(threadOf(into))) toggleMinimised(threadOf(into), false);
    const target = [...thread.querySelectorAll<HTMLElement>(".chat-msg")].find(
      (item) => item.dataset.id === id,
    );
    if (!target) return;
    jumps++;
    thread.querySelector(".chat-msg.lit")?.classList.remove("lit");
    lit = id;
    target.classList.add("lit");
    // Setting the scroll ends a smooth one: the thread growing under it must not take it back to the foot.
    foot.place(false);
    target.scrollIntoView?.({
      block: "center",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
    window.clearTimeout(litTimer);
    litTimer = window.setTimeout(() => {
      lit = null;
      thread.querySelector(".chat-msg.lit")?.classList.remove("lit");
    }, LIT_MS);
  }

  /**
   * A message's clip, the same element on every redraw, so a refresh or a new message neither stops it nor sends it
   * back to the start. Native controls carry play and full screen; nothing loads past its first frame until he plays it.
   */
  const players = new Map<string, HTMLVideoElement>();
  function player(id: string, sha: string): HTMLVideoElement {
    let video = players.get(id);
    if (!video) {
      video = h("video", {
        class: "chat-video",
        attrs: {
          src: mediaSrc(sha),
          controls: "",
          playsinline: "",
          preload: "metadata",
          "aria-label": "Video",
        },
      });
      players.set(id, video);
    }
    return video;
  }

  /** The card a message opens: its own posted card, or the one it answered or names, while the board holds it. */
  function cardOf(message: ChatMessage): ServedNeed | undefined {
    const cardId = message.posted?.id ?? message.card;
    if (!cardId) return undefined;
    const mine = message.from === "owner";
    const card = mine
      ? boardCards().find((need) => need.id === cardId)
      : (app.board?.board?.needs.find(
          (need) => need.id === cardId && isUpdate(need),
        ) ?? boardCards().find((need) => need.id === cardId));
    // The line comes by the stream as its card is added: the board this app read may not have it yet.
    if (!mine && !card) readBoardFor(cardId);
    return card;
  }

  /** Each message's row as last drawn, with what it was drawn from: a refresh redraws only the rows that changed. */
  let rows = new Map<string, { key: string; el: HTMLElement }>();

  /**
   * A message's row, the one already drawn while nothing it shows has changed, so a 10 s refresh or a stream message no
   * longer rebuilds the whole thread. The key holds everything `bubble` reads.
   */
  function row(message: ChatMessage, quoted: boolean, next: typeof rows): HTMLElement {
    const card = cardOf(message);
    const key = JSON.stringify([
      message,
      quoted,
      shown.kind,
      shownId(),
      readOnly(),
      message.id === lit,
      appOnly(message),
      card ? [card.id, card.rev, isUpdate(card)] : null,
      message.card ? answeredTitle(message) : null,
      timeOf(message.at),
      chatImages(message).map(mediaSrc),
      topicOf(message),
      // Its Open topic button names the topic, which the titler or the owner may rename.
      summaryOf(topicOf(message) ?? "")?.title,
    ]);
    const was = rows.get(message.id);
    // A card's media is one element shared with the Feed and Answered, so another view may have taken it from the row.
    // Chat's own timeline shows a posted card as one line, without it.
    const media = message.posted && shown.kind !== "rivet" && card?.media ? cardMedia(card.id, card.media, card.title) : null;
    const el = was?.key === key && (!media || was.el.contains(media)) ? was.el : bubble(message, quoted);
    next.set(message.id, { key, el });
    return el;
  }

  /**
   * Chat's messages as topic cards: a card holds a run of one conversation's lines, and a line replying to one
   * in it. A conversation's own page has its title on top, so there a card is one turn: his lines and Rivet's answer.
   */
  /**
   * Chat's topic cards: one per conversation, each in time order and the cards ordered by their newest line, so the
   * newest line is last. A conversation's page splits at each new question.
   */
  function exchangesOf(sorted: ChatMessage[]): ChatMessage[][] {
    if (shown.kind === "rivet") {
      const byThread = new Map<string, ChatMessage[]>();
      const newest = new Map<ChatMessage[], number>();
      sorted.forEach((message, index) => {
        const thread = threadOf(message);
        const group = byThread.get(thread) ?? [];
        group.push(message);
        byThread.set(thread, group);
        newest.set(group, index);
      });
      return [...newest.keys()].sort((a, b) => newest.get(a)! - newest.get(b)!);
    }
    const groups: ChatMessage[][] = [];
    // In the agents' room each agent's run is its own card, so its Reply goes to that agent: only another agent's line starts one.
    if (shown.id === TEAM_ROOM_ID) {
      let agent: string | undefined;
      for (const message of sorted) {
        const last = groups.at(-1);
        if (last && (!message.team || agent === undefined || message.team.from === agent)) last.push(message);
        else groups.push([message]);
        agent = message.team?.from ?? agent;
      }
      return groups;
    }
    for (const message of sorted) {
      const last = groups.at(-1);
      const before = last?.at(-1);
      if (last && before && !(message.from === "owner" && before.from !== "owner")) last.push(message);
      else groups.push([message]);
    }
    return groups;
  }

  function threadOf(message: ChatMessage): string {
    return message.threadId ?? message.id;
  }

  /** A line as a minimised card's second line or a sheet's top line names it, whatever it carries. */
  function lineOf(message: ChatMessage): string {
    if (message.posted) return `Card: ${message.posted.title}`;
    if (message.card && message.from === "owner") return answerLine(answeredTitle(message), message.text);
    return lastLine(message);
  }

  /** His last line in the card is still waiting for Rivet. */
  function waiting(group: ChatMessage[]): boolean {
    const last = group.at(-1)!;
    return last.from === "owner" && !last.card && (last.status === "sent" || last.status === "typed");
  }

  /**
   * A topic card's heading: the conversation's title, or his question until it has one, cut to the space by CSS. An
   * idle topic is not in the open list, so its title is unknown here; his card answer ("Chose: …") is no question.
   */
  function titleOf(group: ChatMessage[]): string {
    const title = summaryOf(threadOf(group[0]!))?.title?.trim();
    if (title) return title;
    const asked = group.find((message) => message.from === "owner" && !message.card && message.text.trim()) ?? group[0]!;
    return lineOf(asked).replace(/\s+/g, " ").trim() || RIVET_NAME;
  }

  /** Each card as last drawn, by its first message: its turns list is kept, so no bubble or clip leaves the page. */
  let topicCards = new Map<string, { key: string; el: HTMLElement; turns: HTMLElement; chrome: HTMLElement[] }>();
  /** Each card's messages as last drawn: Reply and More read them when tapped. */
  let cardGroups = new Map<string, ChatMessage[]>();

  function toggleMinimised(thread: string, close: boolean): void {
    if (close) minimised.add(thread);
    else minimised.delete(thread);
    writeMinimised(minimised);
    render(false);
  }

  /** Opening a minimised topic Rivet has replied in reads it, as its page would. */
  function openMinimised(thread: string): void {
    const row = list?.conversations.find((item) => item.id === thread);
    const fresh = !!row && countsUnread(row);
    if (fresh) {
      row.unread = 0;
      row.markedUnread = false;
    }
    toggleMinimised(thread, false);
    if (!fresh) return;
    noteUnread();
    cmd.patchConversation(thread, { read: true }).catch((error: unknown) => {
      if (!authFail(error) && alive) void loadList();
    });
  }

  /** Collapse all minimises every topic Chat shows; Expand all opens them. Others' saved state stays. */
  function collapseAll(close: boolean): void {
    for (const group of cardGroups.values()) {
      if (close) minimised.add(threadOf(group[0]!));
      else minimised.delete(threadOf(group[0]!));
    }
    writeMinimised(minimised);
    render(false);
  }

  /** The conversations Mark all read reads: the ones the Chat badge counts. */
  function markable(): ConversationSummary[] {
    return (list?.conversations ?? []).filter((row) => countsUnread(row) && row.id !== TEAM_ROOM_ID && !row.updates);
  }

  function markAllRead(): void {
    const rows = markable();
    if (!rows.length) return;
    for (const row of rows) {
      row.unread = 0;
      row.markedUnread = false;
    }
    noteUnread();
    render(false);
    for (const row of rows)
      cmd.patchConversation(row.id, { read: true }).catch((error: unknown) => {
        if (!authFail(error) && alive) void loadList();
      });
  }

  function replyToCard(first: string): void {
    const group = cardGroups.get(first);
    // The server routes a room reply by the line it answers: the card's agent's last line, never his own.
    const agentLine = shownId() === TEAM_ROOM_ID ? [...(group ?? [])].reverse().find((one) => one.team) : undefined;
    const message = agentLine ?? group?.at(-1);
    if (!message) return;
    const owner = agentLine?.team?.from;
    setReply({
      id: message.id,
      quote: { from: message.from, text: quoteText(message) },
      ...(shownId() ? { conversation: shownId()! } : {}),
      ...(owner ? { owner } : {}),
    });
  }

  function moreOf(first: string): void {
    const group = cardGroups.get(first);
    if (!group) return;
    const answers = group.filter((message) => message.from === "rivet" && !message.posted && message.text.trim());
    const answer = answers.at(-1) ?? null;
    const asked = group.filter((message) => message.from === "owner").at(-1);
    const thread = threadOf(group[0]!);
    // Judged on all of the conversation loaded, as the server judges it: a card holds only its newest exchange.
    const lines = [...messages.values()].filter((message) => threadOf(message) === thread).sort(byTime);
    const reAsk = answer && notAnswerOf(lines, answer, (id) => messages.get(id));
    const rejectable = !!reAsk && reAsk.last && !reAsk.open.length && !readOnly() && thread !== TEAM_ROOM_ID && !waiting(lines);
    openMore({
      question: asked ? lineOf(asked) : titleOf(group),
      listen: answer ? rivetWords(answer.text) : null,
      readAll: shown.kind === "rivet" ? () => openConversationNow(thread) : null,
      // Share sends text: an answer that is only photos or a video has none to send, and a card is no answer.
      share:
        answer && !appOnly(answer) && !inRoom(answer)
          ? () => openShare(answer.text, () => (liveRefusal ? liveRefusal(answer) : SHARE_CHECKING))
          : null,
      notAnswer: rejectable && answer ? () => askAgain(answer) : null,
    });
  }

  /** Not an answer: his question goes to Rivet again, and the card shows Rivet at work as it does for a line just sent. */
  function askAgain(answer: ChatMessage): void {
    cmd.notAnswer(answer.id).then(
      (entry) => {
        if (!alive) return;
        if (entry.status === "failed" || entry.status === "refused" || entry.status === "cancelled") {
          hint.textContent = `${RIVET_NAME} did not get it. Tap Not an answer again.`;
          return;
        }
        hint.textContent = "";
        const stored = messages.get(entry.id);
        arrived({
          id: entry.id,
          from: "owner",
          text: entry.text ?? "",
          ...imageFields(chatImages(entry)),
          at: entry.at,
          status: stored?.status ?? (entry.status === "collecting" ? "collecting" : "sent"),
          ...(stored?.seq !== undefined ? { seq: stored.seq } : {}),
          replyTo: answer.id,
          ...(entry.quote ? { quote: entry.quote } : {}),
          ...(entry.notAnswerFor ? { notAnswerFor: entry.notAnswerFor } : {}),
          threadId: threadOf(answer),
        });
      },
      (error: unknown) => {
        if (authFail(error)) return;
        hint.textContent = describe(error);
        if (error instanceof ApiError && error.status === 424) flash(describe(error), "error", 6000);
      },
    );
  }

  function exchange(group: ChatMessage[], bubbles: HTMLElement[], next: typeof topicCards): HTMLElement {
    const first = group[0]!.id;
    const thread = threadOf(group[0]!);
    const onChat = shown.kind === "rivet";
    const closed = onChat && minimised.has(thread);
    const last = group.at(-1)!;
    const wait = waiting(group);
    const summary = onChat ? summaryOf(thread) : null;
    const fresh = !!summary && countsUnread(summary);
    const title = onChat ? titleOf(group) : "";
    // His card answer already reads "You approved “…”".
    const said = last.team || (last.card && last.from === "owner") ? lineOf(last) : `${last.from === "owner" ? "You" : RIVET_NAME}: ${lineOf(last)}`;
    const replies = !readOnly();
    const key = JSON.stringify([onChat, closed, wait, fresh, title, closed ? [said, timeOf(last.at)] : null, replies]);
    const was = topicCards.get(first);
    const kept = was?.key === key ? was : null;
    const turns = was?.turns ?? h("ol", { class: "chat-ex-turns" });
    const chrome = kept?.chrome ?? [
      onChat && !closed
        ? h(
            "div",
            { class: "chat-ex-head" },
            h("i", { class: "chat-ex-dot", attrs: { "aria-hidden": "true" } }),
            h("span", { class: "chat-ex-title" }, title),
            h(
              "button",
              {
                class: "chat-ex-chev",
                attrs: { type: "button", "aria-label": `Minimise ${title}`, "aria-expanded": "true", "data-use": "chat.ex.minimise" },
                on: { click: () => toggleMinimised(thread, true) },
              },
              svg(CHEVRON, "chat-ex-chev-icon"),
            ),
          )
        : null,
      closed
        ? h(
            "button",
            {
              class: "chat-ex-min",
              attrs: { type: "button", "aria-label": `Open ${title}${fresh ? ", new reply" : ""}`, "aria-expanded": "false", "data-use": "chat.ex.open" },
              on: { click: () => openMinimised(thread) },
            },
            h("i", { class: `chat-ex-dot${fresh ? " new" : ""}`, attrs: { "aria-hidden": "true" } }),
            h(
              "span",
              { class: "chat-ex-min-words" },
              h("strong", { class: "chat-ex-title" }, title),
              h(
                "span",
                { class: "chat-ex-min-row" },
                h("span", { class: `chat-ex-min-line${wait ? " working" : ""}` }, wait ? `${RIVET_NAME} is working on it` : said),
                fresh ? h("span", { class: "chat-ex-new" }, "New") : h("small", { class: "chat-ex-time" }, timeOf(last.at) ?? ""),
              ),
            ),
            svg(CHEVRON, "chat-ex-chev-icon"),
          )
        : null,
      turns,
      wait && !closed
        ? h(
            "p",
            { class: "chat-ex-wait", attrs: { role: "status" } },
            rivet("working", { size: 28, className: "chat-rivet" }),
            h("span", { class: "chat-ex-dots", attrs: { "aria-hidden": "true" } }, h("i"), h("i"), h("i")),
            `${RIVET_NAME} is working on it`,
          )
        : null,
      closed
        ? null
        : h(
            "div",
            { class: "chat-ex-foot" },
            h(
              "button",
              { class: "btn ghost chat-ex-more", attrs: { type: "button", "aria-label": "More for this topic", "data-use": "chat.ex.more" }, on: { click: () => moreOf(first) } },
              svg(MORE, "btn-icon"),
              "More",
            ),
            // Updates is read-only: nothing to reply with.
            replies
              ? h(
                  "button",
                  { class: "btn ghost chat-reply", attrs: { type: "button", "aria-label": "Reply to this topic", "data-use": "chat.msg.reply" }, on: { click: () => replyToCard(first) } },
                  svg(REPLY, "btn-icon"),
                  "Reply",
                )
              : null,
          ),
    ].filter((one): one is HTMLElement => one !== null);
    turns.hidden = closed;
    placeChildren(turns, bubbles);
    const el = was?.el ?? h("li", { class: "chat-ex", attrs: { "data-ex": first } });
    el.dataset.thread = thread;
    el.classList.toggle("minimised", closed);
    el.classList.toggle("on-chat", onChat);
    placeChildren(el, chrome);
    next.set(first, { key, el, turns, chrome });
    return el;
  }

  function bubble(message: ChatMessage, quoted: boolean): HTMLElement {
    const mine = message.from === "owner";
    const topic = topicOf(message);
    const posted = message.posted;
    // A card answer is his message too; its card opens from here while it is still on the board. Rivet's "Card: … ›"
    // line (say.mjs --card) opens its update card the same way, the line itself one tap; so does the line beside a
    // question card (a reply that asked him something) while that card is open, and a card Rivet posted here.
    const card = cardOf(message);
    // His bubble needs no name: it is on the right of its topic card.
    const said = [
      mine
        ? (timeOf(message.at) ?? "")
        : `${message.team ? `${chatName(message.team.from)} → ${chatName(message.team.to)}` : "Rivet"} · ${timeOf(message.at) ?? ""}`,
      message.card && mine ? " · from a card" : null,
      mine && message.ack
        ? h(
            "span",
            { class: "chat-status acked" },
            ` · ${RIVET_NAME}: ${ackWords(message.ack.text)}`,
          )
        : mine && message.status === "replied"
          ? // A small tick, not the word (the owner).
            [" · ", h("span", { class: "chat-status replied", attrs: { role: "img", "aria-label": STATUS_WORDS.replied, title: STATUS_WORDS.replied } }, svg(ICONS.yes, "chat-tick"))]
          : mine && message.status
          ? h(
              "span",
              { class: `chat-status ${message.status}` },
              ` · ${message.status === "collecting" ? collectLine(collectLeft(messages.values())) : STATUS_WORDS[message.status]}`,
            )
          : null,
    ].flat();
    const images = chatImages(message).map(mediaSrc);
    const alt = mine ? "Photo you sent" : "Photo";
    // Reply and More sit once under the topic card, not on each bubble.
    const meta = h("p", { class: "chat-meta" }, ...said);
    const openCard = card && !posted
      ? h(
          "button",
          {
            class: "btn ghost chat-card-open",
            attrs: { type: "button", "data-use": "chat.msg.open-card" },
            on: { click: () => showCard(card.id) },
          },
          "Open card",
        )
      : null;
    const replyTo = message.replyTo;
    // In Chat a thing's card is a way to its page; its other lines carry Open topic (2026-11-16).
    if (posted && shown.kind === "rivet") {
      const thing = message.threadId ?? message.id;
      return h(
        "li",
        { class: `chat-msg theirs posted chat-thing-row${message.id === lit ? " lit" : ""}`, attrs: { "data-id": message.id } },
        h(
          "button",
          { class: "chat-thing-link", attrs: { type: "button", "aria-label": `Open the page for ${posted.title}`, "data-use": "chat.msg.thing-link" }, on: { click: () => openConversationNow(thing) } },
          h("span", { class: "chat-posted-kind" }, postedKind(posted.kind)),
          h("strong", { class: "chat-posted-title" }, posted.title),
          h("span", { class: "chat-thing-open" }, "Open its page ›"),
        ),
        h("p", { class: "chat-meta" }, `Rivet · ${timeOf(message.at) ?? ""}`),
      );
    }
    // In Chat a card answer is one line that opens the card's conversation, where the answer stays with its card.
    if (mine && message.card && shown.kind === "rivet") {
      const thing = message.threadId ?? message.id;
      const line = answerLine(answeredTitle(message), message.text);
      return h(
        "li",
        { class: `chat-msg mine chat-answer-row${message.id === lit ? " lit" : ""}`, attrs: { "data-id": message.id } },
        h(
          "button",
          { class: "chat-thing-link", attrs: { type: "button", "aria-label": `${line}. Open its chat`, "data-use": "chat.msg.answer-line" }, on: { click: () => openConversationNow(thing) } },
          h("span", { class: "chat-answer-text" }, line),
          h("span", { class: "chat-thing-open" }, "Open its chat ›"),
        ),
        h("p", { class: "chat-meta" }, `You · ${timeOf(message.at) ?? ""}`),
      );
    }
    return h(
      "li",
      {
        class: `chat-msg ${mine ? "mine" : "theirs"}${!mine && !message.team ? " has-rivet" : ""}${posted ? " posted" : ""}${message.id === lit ? " lit" : ""}`,
        attrs: { "data-id": message.id },
      },
      // 28px is the smallest his front symbols stay legible at (rivet-symbols.test.ts).
      !mine && !message.team ? rivet(moodOf(message.text), { size: 28, className: "chat-rivet" }) : null,
      meta,
      quoted && message.quote && replyTo
        ? h(
            "button",
            {
              class: "chat-quote box",
              attrs: {
                type: "button",
                "aria-label": "Go to the quoted message",
                "data-use": "chat.msg.quote-jump",
              },
              on: { click: () => jump(replyTo) },
            },
            ...quoteParts(message.quote),
          )
        : null,
      images.length === 1
        ? imageButton(
            images,
            0,
            h("img", {
              class: "chat-image",
              attrs: { src: images[0]!, alt, loading: "lazy", decoding: "async" },
            }),
          )
        : images.length > 1
          ? h(
              "div",
              { class: "chat-images" },
              ...images.map((image, index) =>
                imageButton(
                  images,
                  index,
                  h("img", {
                    class: "chat-image-tile",
                    attrs: {
                      src: image,
                      alt: `${alt}, ${index + 1} of ${images.length}`,
                      loading: "lazy",
                      decoding: "async",
                    },
                  }),
                ),
              ),
            )
          : null,
      message.video ? player(message.id, message.video) : null,
      message.files?.length
        ? h(
            "ul",
            { class: "chat-files" },
            // An app-only conversation's file stays in the app: its viewer offers Download, never Share, asked again at a tap.
            ...message.files.map((file) => h("li", {}, fileLink(file, () => {
              // The message as it stands now: a thread event replaces it with its new project.
              const now = messages.get(message.id) ?? message;
              return !appOnly(now) && !inRoom(now);
            }))),
          )
        : null,
      posted
        ? h(
            "div",
            { class: "chat-posted" },
            h("span", { class: "chat-posted-kind" }, postedKind(posted.kind)),
            h("strong", { class: "chat-posted-title" }, posted.title),
            posted.ask
              ? h("p", { class: "chat-posted-ask" }, posted.ask)
              : null,
            card?.media ? cardMedia(card.id, card.media, card.title) : null,
            card
              ? h(
                  "button",
                  {
                    class: "btn chat-card-open chat-posted-open",
                    attrs: { type: "button", "data-use": "chat.msg.open-card" },
                    on: { click: () => showCard(card.id) },
                  },
                  "Open card",
                )
              : null,
          )
        : message.text
        ? card && !mine
          ? h(
              "button",
              {
                class: "chat-body chat-card-line",
                attrs: { type: "button", "data-use": "chat.msg.card-line" },
                on: { click: () => showCard(card.id) },
              },
              message.text,
            )
          : h("p", { class: "chat-body" }, ...linkify(message.text))
        : null,
      topic
        ? h(
            "button",
            {
              class: "btn ghost chat-topic-link",
              attrs: { type: "button", "aria-label": `Open topic: ${summaryOf(topic)?.title ?? "its page"}`, "data-use": "chat.msg.topic-open" },
              on: { click: () => openConversationNow(topic) },
            },
            "Open topic ›",
          )
        : null,
      openCard ? h("div", { class: "chat-foot" }, h("div", { class: "chat-foot-tools" }, openCard)) : null,
    );
  }

  /** An app-only conversation stays in the app: nothing in it is offered to share. */
  function appOnly(message: ChatMessage): boolean {
    if (!appOnlyHeard) return true;
    const word = threadWord.get(message.threadId ?? message.id);
    // Not read since it opened: nothing says it may leave the app yet.
    if (!word) return true;
    return word.app || isAppOnly(message.project);
  }

  function summaryOf(id: string): ConversationSummary | null {
    // The open conversation's detail is the freshest; off it, the rows a patch refreshes are.
    if (detail?.id === id && shownId() === id) return detail.conversation;
    return (
      list?.conversations.find((row) => row.id === id) ??
      (detail?.id === id ? detail.conversation : null)
    );
  }

  /** Rivet's newest reply in the open conversation with text to share, or null. */
  function shareable(): ChatMessage | null {
    let latest: ChatMessage | null = null;
    for (const message of messages.values())
      if (
        message.from === "rivet" &&
        message.text &&
        !message.posted &&
        (!latest || byTime(message, latest) > 0)
      )
        latest = message;
    return latest && !appOnly(latest) && !inRoom(latest) ? latest : null;
  }

  let paintedHead = "";
  let paintedThing = "";
  function paintHead(): void {
    const id = shownId();
    const summary = id ? summaryOf(id) : null;
    // The card its Needs you names opens from here while it is on the board.
    const waiting =
      detail && detail.id === id && detail.statusCard
        ? detail.statusCard
        : null;
    const card =
      waiting && boardCards().some((need) => need.id === waiting)
        ? waiting
        : null;
    const thing = thingPage();
    const facts = thing ? thingFacts(messages.values(), allCards(), summary) : null;
    const title = summary?.title ?? (thing && !loadFailed ? "Loading…" : "Conversation");
    const key = JSON.stringify([title, summary?.closed, facts && { ...facts, cards: facts.cards.length }, card, headHosted()]);
    if (key !== paintedHead || !headBox.firstChild) {
      paintedHead = key;
      const refocus = keepFocus(headBox);
      headBox.replaceChildren(
        thingHead({
          title,
          step: facts?.step ?? null,
          facts,
          back: () => back(),
          speak: canSpeak() && !headHosted() ? headSpeak : null,
          card: card ? () => showCard(card) : null,
          closed: summary?.closed === true,
        }),
      );
      refocus();
    }
    paintThing(facts, title);
  }

  /** A thing's foot: Share (its newest card with media, else Rivet's newest reply) and Stop it. */
  function paintThing(facts: ReturnType<typeof thingFacts> | null, title: string): void {
    // Nothing leaves an app-only thing: its media shares only once a line of Rivet's in it may.
    const open = [...messages.values()].some((one) => one.from === "rivet" && !appOnly(one) && !inRoom(one));
    const media = facts && open ? [...facts.cards].reverse().find((one) => one.need?.media)?.need : undefined;
    const reply = facts && !media ? shareable() : null;
    const key = JSON.stringify([facts && { ...facts, cards: facts.cards.length }, open, media && `${media.id}:${media.rev}`, reply?.id, title]);
    if (key === paintedThing) return;
    paintedThing = key;
    if (!facts) return void thingFoot.replaceChildren();
    const refocus = keepFocus(thingFoot);
    thingFoot.replaceChildren(
      thingButtons({
        share: media
          ? cardShareButton(media, "thing-btn", () => [...messages.values()].some((one) => one.from === "rivet" && !appOnly(one) && !inRoom(one)))
          : reply
            ? button([svg(SHARE, "btn-icon"), "Share"], () => openShare(`${title}\n\n${reply.text}`, () => (liveRefusal ? liveRefusal(reply) : SHARE_CHECKING)), "thing-btn thing-share", false, "chat.thing.share")
            : null,
        stop: () => confirmStop(facts.chat, title),
      }),
    );
    refocus();
  }

  /** Stop it asks first, then tells Rivet in this thing's conversation; there is no stop of a chat but his. */
  function confirmStop(chat: string | null, title: string): void {
    const id = shownId();
    if (!id) return;
    const words = stopText(chat, title);
    openSheet(
      chat ? `Ask ${RIVET_NAME} to stop ${chatName(chat)}?` : `Ask ${RIVET_NAME} to stop this?`,
      {
        mount: (body) => body.replaceChildren(h("p", { class: "sheet-hint" }, `Sends “${words}” to ${RIVET_NAME} here. He stops the chat and says so.`)),
        unmount: () => {},
      },
      "Cancel",
      button("Stop it", () => {
        closeSheet();
        cmd.sendChat(words, [], [], undefined, id).then(
          (entry) => {
            flash(`Asked ${RIVET_NAME} to stop it.`);
            if (alive) arrived({ id: entry.id, from: "owner", text: words, at: entry.at, status: "sent", threadId: typeof entry.conversation === "string" ? entry.conversation : id });
          },
          (error: unknown) => {
            if (!authFail(error)) flash(describe(error), "error");
          },
        );
      }, "primary big thing-stop-go", false, "chat.thing.stop-confirm"),
      { use: "stop-confirm" },
    );
  }

  type Reading = { line: HTMLElement | null; lineOffset: number; card: HTMLElement; first: string; thread: string; cardOffset: number };
  /** What he is reading: the first line, or minimised card or card foot, whose bottom is below the scroller's top, and where it and its card sit. */
  function readingAt(): Reading | null {
    if (scroller.clientHeight === 0) return null;
    const top = scroller.getBoundingClientRect().top;
    for (const card of thread.querySelectorAll<HTMLElement>(".chat-ex")) {
      const box = card.getBoundingClientRect();
      if (box.bottom <= top) continue;
      const reading = { line: null, lineOffset: 0, card, first: card.dataset.ex ?? "", thread: card.dataset.thread ?? "", cardOffset: box.top - top };
      if (!card.classList.contains("minimised"))
        for (const line of card.querySelectorAll<HTMLElement>(".chat-msg[data-id]")) {
          const at = line.getBoundingClientRect();
          if (at.bottom > top) return { ...reading, line, lineOffset: at.top - top };
        }
      return reading;
    }
    return null;
  }

  /** Puts what he was reading back where it sat: its line, or its card when the line went into a minimised card. */
  function holdReading(reading: Reading | null): void {
    if (!reading || scroller.clientHeight === 0) return;
    // On Chat a card is its topic, which an earlier line coming in leaves the same; elsewhere a topic has several cards.
    const card = reading.card.isConnected
      ? reading.card
      : [...thread.querySelectorAll<HTMLElement>(".chat-ex")].find((one) =>
          shown.kind === "rivet" ? one.dataset.thread === reading.thread : one.dataset.ex === reading.first,
        );
    const kept = reading.line?.isConnected
      ? reading.line
      : reading.line && [...thread.querySelectorAll<HTMLElement>(".chat-msg[data-id]")].find((one) => one.dataset.id === reading.line!.dataset.id);
    const line = kept && !kept.closest(".chat-ex")?.classList.contains("minimised") ? kept : null;
    const el = line ?? card;
    if (!el) return;
    const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - (line ? reading.lineOffset : reading.cardOffset);
    if (Math.abs(delta) >= 1) scroller.scrollTop += delta;
  }

  /** True when it leaves the newest message on screen: stuck to the bottom, or already near it. */
  function render(stick: boolean): boolean {
    const kind = shown.kind;
    const topics = topicsOpen && kind === "rivet";
    paintSend();
    search.el.dataset.view = kind;
    // On Chat under the More topics row; a wide window's pane keeps it on top (conversations.css).
    search.el.hidden = kind !== "rivet";
    // Both hide the scroller, which then reads 0 everywhere: where Chat was is taken before, not measured after.
    const covers = topics || (search.active() && kind === "rivet");
    const wasCovered = section.classList.contains("topics") || section.classList.contains("searching");
    if (covers && !wasCovered && drawn === "rivet" && scroller.clientHeight > 0)
      covered = { held: foot.held(), top: scroller.scrollTop };
    // Results stand in for Chat's messages while a search is typed.
    section.classList.toggle("searching", search.active() && kind === "rivet");
    section.classList.toggle("topics", topics);
    section.classList.toggle("thing-page", thingPage());
    if (thingPage() !== thingOnTop) {
      thingOnTop = !thingOnTop;
      if (thingOnTop) enterScreen("chat.thing");
      else leaveScreen("chat.thing");
    }
    // In the Rivet sheet's head row it is the sheet's title, over a thing's page too.
    chatHead.hidden = kind !== "rivet" && !headHosted();
    optionsBtn.hidden = kind !== "rivet" && !canSpeak();
    for (const item of chatOnlyItems) item.hidden = kind !== "rivet";
    // A page opened with no tap outside it (a search hit, a push) must not leave the menu, and its keys, held open.
    if ((optionsBtn.hidden || (shownId() ?? "") !== menuView) && !menu.hidden) closeMenu();
    menuView = shownId() ?? "";
    headBox.hidden = kind === "rivet";
    topicsRow.hidden = kind !== "rivet";
    topicsList.hidden = !topics;
    paintTopics(topics);
    thingFoot.hidden = !thingPage();
    // The server takes a room line once the room exists, with its first agent line.
    composeBox.hidden = readOnly() || (roomMissing && shownId() === TEAM_ROOM_ID);
    paintPlaceholder();
    earlier.hidden = !(earlierMore ?? detail?.more);
    tickCollect();
    if (kind === "conversation") paintHead();
    else paintThing(null, "");
    // Taking a clip out of the page ends its full screen: the conversation redraws once he leaves it (onFullscreen).
    if (
      document.fullscreenElement &&
      thread.contains(document.fullscreenElement)
    )
      return false;
    if (threadHeld) {
      heldStick ||= stick;
      return false;
    }
    drawn = kind;
    // Nothing kept, as Chat had drawn nothing when they covered it: a hold taken under them still holds.
    const back = covers || kind !== "rivet" ? null : (covered ?? (wasCovered && foot.held() ? { held: true, top: 0 } : null));
    if (!covers) covered = null;
    const atBottom =
      !!back?.held || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
    // Updates' seed bubble ("Updates from Rivet") went with the conversation.
    const sorted = [...messages.values()]
      .filter((message) => !SEED_IDS.includes(message.id))
      .sort(byTime);
    if (kind === "rivet" && chatLoaded && minimised.size) {
      const held = new Set(sorted.map(threadOf));
      const before = minimised.size;
      for (const id of minimised) if (!held.has(id)) minimised.delete(id);
      if (minimised.size !== before) writeMinimised(minimised);
    }
    // A new message keeps the keyboard on the control it was on; dropped to the page, Enter would answer the card.
    const refocus = keepFocus(thread);
    // A first-read Try again goes however the chat loads (its own tap, a refresh, the stream): its keyboard moves on.
    const retryHeld = !!thread.querySelector(".chat-retry")?.contains(document.activeElement);
    // A card moving to the end, or lines landing above, would shift what he is reading: iOS has no overflow-anchor.
    const anchor = !stick && !atBottom && !back ? readingAt() : null;
    // A reply to a line in its own topic card needs no quote; one to a line outside it shows it.
    const next: typeof rows = new Map();
    const nextCards: typeof topicCards = new Map();
    const groups = exchangesOf(sorted);
    cardGroups = new Map(groups.map((group) => [group[0]!.id, group]));
    const bubbles = groups.map((group) => {
      const ids = new Set(group.map((message) => message.id));
      const turns = group.map((message) => row(message, !(message.replyTo && ids.has(message.replyTo)), next));
      return exchange(group, turns, nextCards);
    });
    rows = next;
    topicCards = nextCards;
    if (kind === "rivet" && chatLoaded) {
      for (const [id, count] of awayOwed) {
        const words = sorted.filter((message) => threadOf(message) === id && message.from === "rivet" && !message.card && !message.posted && !message.team);
        if (!words.length) continue;
        for (const message of words.slice(-count)) away.add(message.id);
        awayOwed.delete(id);
      }
      // Above the topmost card holding one, so every answer it counts is below it: cards go by their newest line.
      const at = groups.findIndex((group) => group.some((message) => away.has(message.id)));
      if (at >= 0) {
        const count = sorted.filter((message) => away.has(message.id)).length;
        awayPill.textContent = `While you were away · ${count} ${count === 1 ? "answer" : "answers"}`;
        bubbles.splice(at, 0, awayPill);
      }
    }
    const retry = () => {
      loadFailed = false;
      render(false);
      void loadDetail();
    };
    const empty = loadFailed
      ? h("li", { class: "chat-empty chat-failed" }, h("p", {}, "Couldn't load this chat."), button("Try again", retry, "chat-retry", false, "chat.retry"))
      : h(
      "li",
      { class: "chat-empty" },
      kind === "rivet"
        ? chatLoaded
          ? `Say anything to ${RIVET_NAME}. Each piece of work gets a page of its own.`
          : "Loading…"
        : !detail
          ? roomMissing && shownId() === TEAM_ROOM_ID
            ? "No agent has written here yet."
            : "Loading…"
          : shownId() === TEAM_ROOM_ID
            ? "No agent has written here yet."
            : "Nothing here yet.",
    );
    placeChildren(thread, bubbles.length ? bubbles : [empty]);
    refocus();
    if (retryHeld && !thread.contains(document.activeElement)) handFocus();
    // Under More topics or search the scroller is hidden and measures 0 everywhere: the hold stays as the reader left it.
    if (back && !atBottom) scroller.scrollTop = back.top;
    holdReading(anchor);
    if (stick || scroller.clientHeight > 0) foot.place(stick || atBottom);
    // Under search results nothing in the conversation is on screen, whatever the hidden scroller measures.
    const showsNewest = (stick || atBottom) && !section.classList.contains("searching") && !topics;
    if (showsNewest) markRead();
    return showsNewest;
  }

  /** The keyboard a Try again held when it went: the message box, or on a touch screen or with the box hidden the chat. */
  function handFocus(): void {
    if (!window.matchMedia?.("(pointer: coarse)").matches) text.focus();
    if (document.activeElement !== text) parkFocus(section);
  }

  /** Marks the open conversation read up to its newest message, once that is on screen and anything is unread. */
  function markRead(): void {
    if (shown.kind === "rivet") return readChat();
    const id = shownId();
    if (
      !alive ||
      !id ||
      !detail ||
      detail.id !== id ||
      document.visibilityState !== "visible" ||
      coveredOver(section) ||
      // Search results stand over the conversation on a desktop: what they hide is not seen.
      section.classList.contains("searching")
    )
      return;
    if (
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight >=
      40
    )
      return;
    const latest = newest();
    if (
      !latest ||
      latest.id === marked ||
      (!countsUnread(detail.conversation) && unseen === 0)
    )
      return;
    marked = latest.id;
    unseen = 0;
    const row = list?.conversations.find((item) => item.id === id);
    if (row && countsUnread(row)) {
      row.unread = 0;
      row.markedUnread = false;
      noteUnread();
    }
    cmd.patchConversation(id, { read: latest.id }).then(
      (found) => {
        if (alive && shownId() === found?.id && detail && found.conversation)
          detail = { ...detail, conversation: found.conversation };
      },
      (error: unknown) => {
        if (authFail(error)) return;
        if (marked === latest.id) marked = null;
      },
    );
  }

  /**
   * Chat on screen at its newest: every conversation in it (a thing too, whose replies Chat now shows; not Agent Chat) Rivet has replied in is marked read at once.
   */
  function readChat(): void {
    if (
      !alive ||
      !list ||
      !chatLoaded ||
      document.visibilityState !== "visible" ||
      coveredOver(section) ||
      section.classList.contains("searching") ||
      section.classList.contains("topics") ||
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight >= 40
    )
      return;
    // A thing is read only once Chat holds its newest line and as many of Rivet's words in it as it has unread (the
    // server's count: no card lines), counted only where Chat's lines run unbroken, so its replies were on screen; never
    // when the owner marked it unread: that stays until the owner opens it (2026-11-16).
    const loaded = [...messages.values()];
    const seen = (row: ConversationSummary) => {
      if (!row.thing) return true;
      const own = loaded.filter((message) => (message.threadId ?? message.id) === row.id);
      const words = own.filter((message) => message.at >= unbrokenFrom && message.from === "rivet" && !message.posted && !message.card).length;
      return own.some((message) => message.at >= row.lastAt) && words >= row.unread;
    };
    noteChatRead();
    const rows = list.conversations.filter((row) => countsUnread(row) && readable(row) && seen(row));
    if (!rows.length) return;
    for (const row of rows) {
      row.unread = 0;
      row.markedUnread = false;
    }
    noteUnread();
    // The server takes 100 a request.
    for (let at = 0; at < rows.length; at += 100)
      cmd.batchConversations(rows.slice(at, at + 100).map((row) => row.id), "read").then(
        () => {},
        (error: unknown) => {
          if (!authFail(error) && alive) void loadList();
        },
      );
  }

  /** The Chat tab's badge: 1 while Rivet has replied in Chat, plus each thing with a reply not read. */
  function noteUnread(): void {
    if (!list) return;
    const count = chatBadge(list.conversations);
    if (app.chatUnread === count) return;
    app.chatUnread = count;
    changed();
  }

  /** The things whose page entry this chat pushed: only those have a Chat entry behind them to go back to. */
  const pushed = new Set<string>();

  /**
   * An entry naming a chat screen keeps what else the entry carries: inside Rivet's sheet that is the sheet's own
   * marker, without which the sheet reads Back to it as leaving the sheet and closes (sheet.ts onPop).
   */
  const withScreen = (screen: string) => ({ ...(history.state ?? {}), chatScreen: screen });
  function withoutScreen(): object | null {
    const { chatScreen: _, ...rest } = (history.state ?? {}) as Record<string, unknown>;
    return Object.keys(rest).length ? rest : null;
  }

  /** Records a thing's page opening so the phone's back gesture goes back to Chat. */
  function remember(screen: Screen): void {
    if (screen.kind !== "conversation") return;
    try {
      // Only an entry this chat pushed counts: a page that replaced the first entry has no Chat behind it.
      if (history.state?.chatScreen === screen.id) return;
      history.pushState({ ...withScreen(screen.id), chatDepth: historyDepth() + 1 }, "");
      pushed.add(screen.id);
    } catch {}
  }

  function openConversationNow(id: string, focus: string | null = null, record = true): void {
    // A seeded room's first message is never shown (a title hit names it): it opens on the newest, not hunting for it.
    if (focus && SEED_IDS.includes(focus)) focus = null;
    // Anywhere else that opens a conversation (header search, a notification, a feed link) ends the panel's search.
    // Quietly: a redraw now would show (and mark read) the conversation being left.
    search.clear(true);
    const fresh = shownId() !== id;
    shown = { kind: "conversation", id };
    topicsOpen = false;
    if (fresh) {
      messages = new Map();
      detail = null;
      loadFailed = false;
      earlierMore = null;
      earliestPage = null;
      marked = null;
      unseen = 0;
      detailTicket++;
    }
    // Another conversation, or one opened by a message of it whose own id is not known yet: the reply is put away,
    // not dropped, and comes back when its conversation shows.
    if (replyingTo && replyingTo.conversation !== id) putReplyAway();
    // A reply picked here before a reload waits in storage for its conversation to open.
    if (!replyingTo) {
      const saved = readReply();
      if (saved?.conversation === id) setReply(saved, false);
    }
    if (record) remember(shown);
    render(true);
    void loadDetail(false, true, focus);
  }

  /**
   * Back to Chat. From the button, through history when this chat pushed the page's entry, so back stays in step; a
   * thing opened as the first screen (a notification's tap, a link) has no Chat entry behind it, and going back from it
   * would leave the app, so Chat is shown in place.
   */
  function back(): void {
    if (shown.kind === "rivet") return;
    if (history.state?.chatScreen === shown.id && pushed.has(shown.id)) {
      history.back();
      return;
    }
    try {
      if (history.state?.chatScreen !== undefined) history.replaceState(withoutScreen(), "");
    } catch {}
    showRivet();
  }

  /** Chat: the one conversation with Rivet, on its newest, or brought to `focus` (a search hit) once it loads; `topics` opens More topics over it. */
  function showRivet(focus: string | null = null, topics = false): void {
    const fresh = shown.kind !== "rivet";
    shown = { kind: "rivet" };
    if (topicsOpen && !topics) search.clear(true);
    topicsOpen = topics;
    if (fresh) {
      detail = null;
      earlierMore = null;
      earliestPage = null;
      messages = new Map();
      chatLoaded = false;
      loadFailed = false;
      window.clearTimeout(detailTimer);
      detailTicket++;
      seedChat();
    }
    if (replyingTo && replyingTo.conversation !== undefined) putReplyAway();
    if (!replyingTo) {
      const saved = readReply();
      if (saved && saved.conversation === undefined) setReply(saved, false);
    }
    render(true);
    void loadDetail(false, true, focus);
  }

  /**
   * Chat's last page read, on screen until the newest comes. It is not the newest yet (chatLoaded stays false): nothing
   * is marked read from it and the newest page still sets where earlier pages start.
   */
  function seedChat(): void {
    if (shown.kind !== "rivet" || chatLoaded || messages.size || !lastChat) return;
    for (const message of lastChat) if (!gone.has(message.id)) messages.set(message.id, message);
  }

  /** The Rivet sheet hosts Chat's head in its own row, beside his face and Close (home.ts). */
  function headHosted(): boolean {
    return !section.contains(chatHead);
  }

  let paintedTopics = "";
  /** More topics: one row over Chat, or open, every conversation the server lists, then the archived ones on a tap. */
  function paintTopics(open: boolean): void {
    const rows = (list?.conversations ?? []).filter((row) => !row.updates && row.id !== TEAM_ROOM_ID);
    const fresh = rows.filter((row) => row.thing && countsUnread(row)).length;
    const shape = (row: ConversationSummary) => [row.id, row.title, row.lastFrom, row.lastText, row.lastAt, row.needsYou, countsUnread(row)];
    const key = JSON.stringify(
      open
        ? [rows.map(shape), archived?.map(shape) ?? null, archivedNext, archivedBusy, list?.older ?? 0, list === null]
        : [fresh],
    );
    if (key === paintedTopics) return;
    paintedTopics = key;
    // The row's button goes with the redraw (More topics ›, or the list's Back arrow): focus on it moves to the new
    // one, never to the page, where an Enter would reach the desk's keys (feed.ts deskKey).
    const here = topicsRow.contains(document.activeElement) || topicsList.contains(document.activeElement);
    const keep = keepFocus(section);
    const refocus = () => {
      keep();
      if (here && !section.contains(document.activeElement)) topicsRow.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    };
    if (!open) {
      topicsRow.replaceChildren(
        button(
          [
            h("span", { class: "chat-topics-label" }, "More topics"),
            fresh ? h("span", { class: "chat-topics-new" }, `${fresh} new`) : null,
            svg(ICONS.forward, "btn-icon"),
          ],
          () => openTopics(),
          "ghost chat-topics-open",
          false,
          "chat.topics.open",
        ),
      );
      topicsList.replaceChildren();
      return refocus();
    }
    topicsRow.replaceChildren(
      h(
        "button",
        { class: "icon-btn chat-topics-back", attrs: { type: "button", "aria-label": "Back to Chat", "data-use": "chat.topics.back" }, on: { click: () => closeTopics() } },
        svg(ICONS.back, "icon-btn-icon"),
      ),
      h("h2", { class: "chat-topics-title" }, "More topics"),
    );
    const older = list?.older ?? 0;
    topicsList.replaceChildren(
      ...(list === null
        ? [h("li", { class: "chat-topics-empty" }, "Loading…")]
        : rows.length || older
          ? rows.map(topicRow)
          : [h("li", { class: "chat-topics-empty" }, "No other topics yet.")]),
      ...(archived ? [h("li", { class: "chat-topics-group" }, archived.length ? "Archived" : "Nothing archived."), ...archived.map(topicRow)] : []),
      ...(older && (archived === null || archivedNext)
        ? [
            h(
              "li",
              {},
              button(archivedBusy ? "Loading…" : archived === null ? "Archived" : "More archived", () => loadArchived(), "ghost chat-topics-more", archivedBusy, "chat.topics.archived"),
            ),
          ]
        : []),
    );
    refocus();
  }

  function topicRow(row: ConversationSummary): HTMLElement {
    const meta = [row.needsYou ? "Needs you" : null, countsUnread(row) ? "New reply" : null, timeOf(row.lastAt)].filter(Boolean).join(" · ");
    return h(
      "li",
      {},
      h(
        "button",
        { class: "chat-topic", attrs: { type: "button", "data-id": row.id, "data-use": "chat.topics.row" }, on: { click: () => openConversationNow(row.id) } },
        h("span", { class: "chat-topic-title" }, row.title),
        row.lastText ? h("span", { class: "chat-topic-last" }, `${row.lastFrom === "owner" ? "You" : RIVET_NAME}: ${row.lastText}`) : null,
        meta ? h("span", { class: `chat-topic-meta${row.needsYou ? " needs-you" : ""}` }, meta) : null,
      ),
    );
  }

  /** Opens More topics over Chat, with an entry of its own so Back comes back to Chat; it counts in the depth too. */
  function openTopics(): void {
    if (shown.kind !== "rivet" || topicsOpen) return;
    topicsOpen = true;
    try {
      history.pushState({ ...withScreen("list"), chatDepth: historyDepth() + 1 }, "");
    } catch {}
    render(false);
    void loadList();
  }

  /** Chat shown in place under More topics (a search hit already in Chat): its list entry becomes Chat's. */
  function leaveTopics(): void {
    if (!topicsOpen) return;
    topicsOpen = false;
    try {
      if (history.state?.chatScreen === "list") history.replaceState(withoutScreen(), "");
    } catch {}
    render(false);
  }

  function closeTopics(): void {
    if (!topicsOpen) return;
    // Through history when its entry is on top, so Back stays in step; onPop shows Chat.
    if (history.state?.chatScreen === "list") return history.back();
    showRivet();
  }

  /** The next page of archived conversations under More topics. */
  function loadArchived(): void {
    if (archivedBusy) return;
    archivedBusy = true;
    const read = archivedRead;
    render(false);
    cmd.getConversations({ before: archivedNext, limit: 30 }).then(
      (response) => {
        if (!alive || read !== archivedRead) return;
        archivedBusy = false;
        if (Array.isArray(response?.conversations)) {
          archived = [...(archived ?? []), ...response.conversations.filter((row) => !row.updates && row.id !== TEAM_ROOM_ID)];
          archivedNext = response.next ?? null;
        }
        render(false);
      },
      (error: unknown) => {
        if (!alive || read !== archivedRead) return;
        archivedBusy = false;
        render(false);
        if (!authFail(error)) flash("Couldn't load the archived chats.", "error");
      },
    );
  }

  /** A message hit: brought up in Chat when it is Chat's, else on its thing's page. */
  function openHit(id: string): void {
    if (shown.kind === "rivet" && messages.has(id)) {
      leaveTopics();
      app.chatFocus = id;
      return seek();
    }
    // Still seeking until the hit's own load starts, which outdates any refresh's load still in flight.
    seeking++;
    cmd.getConversation(id).then(
      (found) => {
        seeking--;
        if (!alive) return;
        // A hit Chat has not loaded: a thing's opens its page, which holds it, as Chat's paging back may not reach it.
        if (found?.conversation && (found.conversation.thing || ownsNoCard(found.id))) openConversationNow(found.id, id);
        else {
          leaveTopics();
          showRivet(id);
        }
      },
      (error: unknown) => {
        seeking--;
        if (!alive || authFail(error)) return;
        flash(error instanceof ApiError && error.status === 404 ? "That message is gone." : describe(error), "error");
      },
    );
  }

  // Back and forward show the thing their entry names, or Chat.
  const onPop = (event: PopStateEvent) => {
    // Closing a viewer or the phone's menu keeps the screen under it.
    if (overlayTraversal(event)) return;
    const named: unknown = history.state?.chatScreen;
    if (named === "list") return showRivet(null, true);
    if (typeof named !== "string" || ["rivet", "older", "new"].includes(named)) return showRivet();
    if (named !== shownId()) openConversationNow(named, null, false);
  };
  window.addEventListener("popstate", onPop);
  const onFullscreen = () => {
    if (!document.fullscreenElement) render(false);
  };
  document.addEventListener("fullscreenchange", onFullscreen);

  /**
   * Fetches the conversations now, or SETTLE_MS after the last of a burst of changes: never drawn, they say which are
   * things, what is unread for the badge and which may be shared. A slower answer never lands over a newer one.
   */
  function loadList(soon = false): Promise<boolean> {
    window.clearTimeout(listTimer);
    if (!alive) return Promise.resolve(false);
    if (soon) {
      listTimer = window.setTimeout(() => void loadList(), SETTLE_MS);
      return Promise.resolve(false);
    }
    const ticket = ++listTicket;
    const stamp = nextStamp();
    return cmd.getConversations().then(
      (response) => {
        if (!alive || ticket !== listTicket) return false;
        if (!response || !Array.isArray(response.conversations)) return false;
        for (const row of response.conversations)
          heardProject(row.id, row.appOnly, stamp);
        if (floor === null) floor = listTop(response.conversations);
        // A topic that left the active list (archived since) or came back to it (a reply) outdates the archived pages
        // read so far: they are read again from the first on the next tap.
        const active = new Set(response.conversations.map((row) => row.id));
        const was = list?.conversations ?? [];
        if (archived && (archived.some((row) => active.has(row.id)) || was.some((row) => !active.has(row.id)))) {
          archived = null;
          archivedNext = null;
          archivedBusy = false;
          archivedRead++;
        }
        list = response;
        if (awayLoad && document.visibilityState === "visible") {
          awayLoad = false;
          // A fresh install has never read Chat: no mark, so nothing was missed.
          if (readChatBefore())
            for (const row of response.conversations) if (row.unread > 0 && readable(row) && !row.updates) awayOwed.set(row.id, row.unread);
        }
        noteUnread();
        render(false);
        return true;
      },
      (error: unknown) => {
        if (!alive || ticket !== listTicket || authFail(error)) return false;
        return false;
      },
    );
  }

  /** Fetches what is on screen: Chat's newest page, or the open thing; `stick` scrolls to its newest once it lands. True when the redraw shows the newest. */
  function loadDetail(
    soon = false,
    stick = false,
    focus: string | null = null,
  ): Promise<boolean> {
    window.clearTimeout(detailTimer);
    if (!alive) return Promise.resolve(false);
    if (soon) {
      detailTimer = window.setTimeout(() => void loadDetail(), SETTLE_MS);
      return Promise.resolve(false);
    }
    // A read that fails with nothing shown yet says so in the thread, with Try again; after a load, the hint says it.
    // A Try again already there stays: replacing it drops its focus, and Enter would reach a card awaiting its confirm.
    // For the same reason one taken back while focused hands its focus to the message box.
    const clearRetry = () => {
      const held = hint.querySelector(".chat-hint-retry")?.contains(document.activeElement);
      hint.textContent = "";
      // A keyboard's Enter must not land on the page, where a card waiting for its confirm takes it. On a touch screen
      // the message box would raise its keyboard, so there, as where Updates, Topics and search hide it, the chat itself
      // takes the focus, and card keys pass it by. It is focusable only until the focus leaves, so a click in the chat
      // never holds the card keys back.
      if (held) handFocus();
    };
    const failed = (nothing: boolean): false => {
      if (nothing) {
        loadFailed = true;
        render(false);
      } else if (!hint.querySelector(".chat-hint-retry")) {
        const again = () => {
          clearRetry();
          void loadDetail();
        };
        hint.replaceChildren("Couldn't refresh this chat. ", button("Try again", again, "chat-hint-retry", false, "chat.retry"));
      }
      return false;
    };
    // A read that lands takes back the hint's "Couldn't refresh", and only that: the hint says other things too.
    const refreshed = () => {
      if (hint.querySelector(".chat-hint-retry")) clearRetry();
    };
    const ticket = ++detailTicket;
    const gen = appOnlyGen;
    if (shown.kind === "rivet") {
      const into = messages;
      return cmd.getChat(null, CHAT_PAGE, true).then(
        (page) => {
          if (!alive || ticket !== detailTicket || messages !== into) return false;
          if (!page || !Array.isArray(page.messages)) {
            return failed(!chatLoaded && !messages.size);
          }
          if (gen === appOnlyGen) appOnlyHeard = true;
          lastChat = page.messages;
          for (const one of page.things ?? []) chatThings.add(one);
          refreshed();
          return showTimeline(page.messages, page.older, stick, focus);
        },
        (error: unknown) => {
          if (!alive || ticket !== detailTicket || authFail(error)) return false;
          return failed(!chatLoaded && !messages.size);
        },
      );
    }
    const id = shown.id;
    const stamp = nextStamp();
    return cmd.getConversation(id).then(
      (found) => {
        if (!alive || ticket !== detailTicket || shownId() !== id) return false;
        if (id === TEAM_ROOM_ID) roomMissing = false;
        if (!found || !Array.isArray(found.messages) || !found.conversation) {
          return failed(!detail);
        }
        heardProject(found.id, found.conversation.appOnly, stamp);
        if (gen === appOnlyGen) appOnlyHeard = true;
        refreshed();
        return showDetail(found, stick, focus);
      },
      (error: unknown) => {
        if (!alive || ticket !== detailTicket || authFail(error)) return false;
        // The room starts with its first agent line: until then it is empty, not gone.
        if (
          error instanceof ApiError &&
          error.status === 404 &&
          id === TEAM_ROOM_ID
        ) {
          roomMissing = true;
          render(false);
          return false;
        }
        if (error instanceof ApiError && error.status === 404) {
          flash("That conversation is gone.", "error");
          showRivet();
          return false;
        }
        return failed(!detail);
      },
    );
  }

  /**
   * Chat's newest page: it stands for everything from its oldest message on, so a message shown that it no longer holds
   * (a line that turned out to be a thing's) goes; earlier pages loaded stay. The first page replaces the last visit's
   * copy whole: what that held from before this page would sit above a gap, with Earlier loading the other side of it.
   */
  function showTimeline(read: readonly ChatMessage[], olderCursor: string | null, stick: boolean, focus: string | null): boolean {
    const page = read.filter((message) => !gone.has(message.id));
    const from = olderCursor === null || !chatLoaded ? "" : (page[0]?.at ?? "");
    // Lines kept from before this page may sit above a gap, so they never prove a thing's replies were on screen.
    unbrokenFrom = from;
    const ids = new Set(page.map((message) => message.id));
    // A line just sent may beat its own read here, so a collecting line stays until its window is due; one gone after
    // that was cancelled elsewhere.
    const nowServer = serverNow();
    for (const [id, message] of messages)
      if (message.at >= from && !ids.has(id) && !(message.status === "collecting" && (!message.sendsAt || Date.parse(message.sendsAt) > nowServer))) messages.delete(id);
    heardMessages(page);
    take(page);
    for (const message of page) messages.set(message.id, message);
    if (!chatLoaded) {
      earlierMore = olderCursor !== null;
      earliestPage = page[0]?.id ?? null;
    }
    chatLoaded = true;
    loadFailed = false;
    const shows = render(stick && !focus);
    if (focus) {
      if (messages.has(focus)) jump(focus);
      else void reach(focus);
    }
    return shows;
  }

  function showDetail(
    found: ConversationDetail,
    stick: boolean,
    focus: string | null,
  ): boolean {
    // Opened by any message of it (a search hit, an old thread link): from here on it goes by its own id.
    if (shownId() !== found.id) {
      const before = shownId();
      if (before !== null && pushed.has(before)) pushed.add(found.id);
      shown = { kind: "conversation", id: found.id };
      try {
        history.replaceState(withScreen(found.id), "");
      } catch {}
      // A reply waiting in storage for this conversation, now that its own id is known.
      const saved = replyingTo ? null : readReply();
      if (saved?.conversation === found.id) setReply(saved, false);
    }
    detail = found;
    loadFailed = false;
    const page = found.messages.filter((message) => !gone.has(message.id));
    // A collecting line of this conversation that a read no longer has once its window was due was cancelled elsewhere.
    const ids = new Set(page.map((message) => message.id));
    const from = page[0]?.at ?? "";
    for (const [id, message] of messages)
      if (message.status === "collecting" && !ids.has(id) && message.at >= from && (message.threadId ?? message.id) === found.id && message.sendsAt && Date.parse(message.sendsAt) <= serverNow())
        messages.delete(id);
    heardMessages(page);
    take(page);
    for (const message of page) messages.set(message.id, message);
    const shows = render(stick && !focus);
    if (focus) {
      if (messages.has(focus)) jump(focus);
      else void reach(focus);
    }
    return shows;
  }

  /**
   * Loads one page of what is on screen before the earliest loaded, keeping the messages on screen where they are.
   * True while there are earlier ones still to load.
   */
  function loadEarlier(): Promise<boolean> {
    const id = shownId();
    const into = messages;
    if (loadingEarlier?.into === into) return loadingEarlier.done;
    // The server pages in its own order, which a message's time need not follow.
    const first = earliestPage ?? detail?.messages[0]?.id;
    if (!alive || !first || (id === null && shown.kind !== "rivet")) return Promise.resolve(false);
    const read =
      id === null
        ? cmd.getChat(first, CHAT_PAGE, true).then((page) => {
            if (!Array.isArray(page?.messages)) return null;
            for (const one of page.things ?? []) chatThings.add(one);
            return { messages: page.messages, more: page.older !== null };
          })
        : cmd.getConversationPage(id, first);
    const done = read.then(
      (page) => {
        if (!alive || messages !== into || !Array.isArray(page?.messages))
          return false;
        heardMessages(page.messages);
        for (const message of page.messages) if (!gone.has(message.id)) messages.set(message.id, message);
        earlierMore = page.more;
        if (page.messages[0]) earliestPage = page.messages[0].id;
        const anchor = readingAt();
        render(false);
        holdReading(anchor);
        return page.more;
      },
      (error: unknown) => {
        if (alive && messages === into && !authFail(error))
          hint.textContent = "Couldn't load earlier messages.";
        return false;
      },
    );
    loadingEarlier = { into, done };
    void done.finally(() => {
      if (loadingEarlier?.done === done) loadingEarlier = null;
    });
    return done;
  }

  /** A search hit older than what shows: earlier pages load until it is in, then it is brought up. */
  async function reach(id: string): Promise<void> {
    const into = messages;
    seeking++;
    try {
      for (
        let pages = 0;
        messages === into && !messages.has(id) && pages < EARLIER_PAGES_MAX;
        pages++
      )
        if (!(await loadEarlier())) break;
    } finally {
      seeking--;
    }
    if (!alive || messages !== into) return;
    if (messages.has(id)) jump(id);
    else flash("That message is older than this shows.", "warn");
  }

  /** A message on the stream: Chat or the open thing shows it, and the badge follows. */
  function arrived(message: ChatMessage): void {
    // Cancelled here or on another device: its lines leave the chat, and a read already out never brings them back.
    if (message.status === "cancelled") {
      gone.add(message.id);
      cmd.heardCancelled([message.id]);
      if (messages.delete(message.id)) render(false);
      void loadList(true);
      return;
    }
    if (gone.has(message.id)) return;
    heardMessages([message]);
    const conversation = message.threadId ?? message.id;
    // Only Rivet's words count: a "Card: … ›" line opens a card the Feed shows anyway.
    const fresh =
      message.from === "rivet" &&
      !message.card &&
      !message.posted &&
      !counted.has(message.id) &&
      !inRoom(message);
    if (message.from === "rivet") counted.add(message.id);
    const here = shown.kind === "rivet" ? !inRoom(message) && inChat(message) : conversation === shownId();
    if (!here || shown.kind === "rivet") bump(message, conversation, fresh);
    if (here) {
      const known = messages.has(message.id);
      messages.set(message.id, message);
      if (fresh && !known) unseen++;
      render(!known && message.from === "owner");
    }
    if (shown.kind === "rivet" || here) void loadDetail(true);
    take([message]);
    void loadList(true);
  }

  /** A conversation's row takes its newest line, unread while Rivet spoke, so the badge moves before the list is read again. */
  function bump(message: ChatMessage, id: string, fresh: boolean): void {
    if (!list) return;
    const at = list.conversations.findIndex((row) => row.id === id);
    if (at < 0) return;
    const rows = [...list.conversations];
    rows[at] = {
      ...rows[at]!,
      lastAt: message.at,
      ...(message.posted ? { thing: true } : { lastFrom: message.from, lastText: lastLine(message) }),
      closed: false,
      unread: rows[at]!.unread + (fresh ? 1 : 0),
    };
    list = { ...list, conversations: rows };
    noteUnread();
  }

  /** Speaks, oldest first, the Rivet messages not heard before and not older than the floor; the first load only sets it. */
  function take(found: readonly ChatMessage[]): void {
    if (floor === null) return baseline(found);
    // Strictly newer: the floor can come from the list, which names no message, and its newest is history already.
    const fresh = found.filter(
      (message) =>
        message.from === "rivet" &&
        !inRoom(message) &&
        !message.posted &&
        !heard.has(message.id) &&
        message.at > floor!,
    );
    for (const message of [...fresh].sort(byTime)) {
      heard.add(message.id);
      if (readSpeak()) say(message.text);
    }
  }

  /** What is on screen counts as heard, and the floor rises to its newest message. */
  function baseline(found: readonly ChatMessage[]): void {
    for (const message of found) {
      if (message.from === "rivet") heard.add(message.id);
      if (floor === null || message.at > floor) floor = message.at;
    }
  }

  function authFail(error: unknown): boolean {
    if (error instanceof ApiError && error.status === 401) {
      signedOut("Your session ended. Sign in again.");
      return true;
    }
    return false;
  }

  /** The newest message (from one side); `words` passes over a card shown inline. */
  function newest(from?: ChatMessage["from"], words = false): ChatMessage | null {
    let latest: ChatMessage | null = null;
    for (const message of messages.values())
      if (
        (!from || message.from === from) &&
        (!words || !message.posted) &&
        (!latest || byTime(message, latest) > 0)
      )
        latest = message;
    return latest;
  }

  /** A search hit: opens the conversation the message is in, on that message. */
  function seek(): void {
    const id = app.chatFocus;
    if (!id || !alive) return;
    app.chatFocus = null;
    // A seeded room's first message is never shown: its title hit opens it on the newest.
    if (SEED_IDS.includes(id)) return openConversationNow(id);
    // Results over this conversation give way to it.
    const searching = section.classList.contains("searching");
    search.clear(true);
    if (messages.has(id)) {
      leaveTopics();
      if (searching) render(false);
      return jump(id);
    }
    openHit(id);
  }

  function send(): void {
    voice?.stop();
    void sendNow();
  }

  async function sendNow(): Promise<void> {
    const screen = shown;
    const body = text.value.trim();
    // A photo picked while this send is in flight is not this send's to drop.
    const photos = [...attached.photos];
    const held = photosHold(photos);
    if (held) {
      hint.textContent = held;
      return;
    }
    const { images, files } = photosPayload(photos);
    if (!body && !images.length && !files.length) return text.focus();
    // Not while a Cancel is out: its answer puts words back in this box.
    if (sending || cancelling || cappedWake !== null) return;
    sending = true;
    sendBtn.disabled = true;
    changed();
    const target = replyingTo;
    // Typed on a topic's page (the Agent Chat room too), with or without Reply, it joins that topic, whatever its stage or
    // a closed chat (2026-11-17). Chat's own box, and a server-owned room's with no Reply, start a conversation of their own.
    const conversation = screen.kind === "conversation" && (target || !roomStartsChat(screen.id)) ? screen.id : null;
    const sentBox = draftBox;
    const sentRev = readDraft().trim() === body ? readDraftRev() : null;
    const sentDraft = draftLineage.begin(sentRev);
    try {
      const entry = await cmd.sendChat(
        body,
        images,
        files,
        target?.id,
        conversation,
        true,
      );
      // Clear the box on screen, and the stored draft that other open copies of the app share, only while each still
      // holds what was sent: anything typed while the send was out stays as the next draft, even the same words. The
      // stored draft is this send's only while its revision descends from the one sent. A draft adopted from another
      // tab is independent even after this page edits it; a reopened box clears only for this send's descendants.
      const rev = readDraftRev();
      const mine = sentDraft.owns(rev);
      const onScreen = draftBox;
      if (
        onScreen &&
        onScreen.text.value.trim() === body &&
        (onScreen === sentBox || mine)
      ) {
        onScreen.text.value = "";
        onScreen.fit();
      }
      if (readDraft().trim() === body && mine) writeDraft("");
      attach.drop(photos);
      // With no reply picked here, the stored reply may be another tab's.
      if (target && replyingTo === target) setReply(null);
      hint.textContent = "";
      // Its answer names no thread for a Reply from Chat (it was typed in none); the server put it in the replied line's.
      const replied = target ? messages.get(target.id) : undefined;
      const id =
        typeof entry.conversation === "string"
          ? entry.conversation
          : (conversation ?? (replied ? threadOf(replied) : entry.id));
      const sent: ChatMessage = {
        id: entry.id,
        from: "owner",
        text: body,
        at: entry.at,
        status:
          messages.get(entry.id)?.status ??
          (entry.status === "collecting" ? "collecting" : "sent"),
        // Its stored copy, when the stream brought it first, keeps its place among the same millisecond's.
        ...(messages.get(entry.id)?.seq !== undefined ? { seq: messages.get(entry.id)!.seq } : {}),
        ...(messages.get(entry.id)?.sendsAt ? { sendsAt: messages.get(entry.id)!.sendsAt } : {}),
        ...imageFields(images),
        ...(files.length ? { files } : {}),
        // The direct send's answer may not echo the reply: the one sent stands.
        ...((entry.replyTo ?? target?.id)
          ? {
              replyTo: (entry.replyTo ?? target?.id)!,
              ...(entry.quote ? { quote: entry.quote } : {}),
            }
          : {}),
        typed: true,
        threadId: id,
      };
      // Sent from a server-owned room with no Reply: that chat is new, so it opens to show where Rivet's answer lands.
      if (alive && screen.kind === "conversation" && conversation === null && shown === screen) openConversationNow(id);
      if (alive) arrived(sent);
    } catch (error) {
      if (authFail(error)) return;
      hint.textContent = describe(error);
      if (error instanceof ApiError && error.status === 424)
        flash(describe(error), "error", 6000);
    } finally {
      sentDraft.finish();
      sending = false;
      paintSend();
      changed();
    }
  }

  function toggleMic(): void {
    if (voice) return voice.toggle();
    hint.textContent = "Tap the microphone on your keyboard to dictate.";
    text.focus();
  }

  function startStream(): void {
    // Chat opening or back in view: a Cancel still owed is settled first.
    settleCancel();
    if (typeof EventSource === "undefined") return startPolling();
    const source = new EventSource("/api/chat/stream");
    stream = source;
    source.addEventListener("message", (event) => {
      streamHeard();
      try {
        const message = JSON.parse((event as MessageEvent<string>).data) as ChatMessage;
        arrived(message);
      } catch {}
    });
    source.addEventListener("ping", streamHeard);
    // Rivet Cloud's machine is going to sleep: no reconnect to wake it until the next tap (rivet-sleep.ts).
    source.addEventListener("asleep", () => {
      fellAsleep();
      window.clearTimeout(idle);
      source.close();
      if (stream === source) stream = null;
    });
    // the owner's rename, Close or read marker, from this device or another.
    source.addEventListener("conversation", (event) => {
      streamHeard();
      try {
        const changedId = (
          JSON.parse((event as MessageEvent<string>).data) as { id?: unknown }
        ).id;
        if (typeof changedId !== "string") return;
        void loadList(true);
        if (shownId() === changedId) {
          // A merge may have brought in older messages: Earlier pages again from the newest ones.
          earlierMore = null;
          earliestPage = null;
          void loadDetail(true);
        }
      } catch {}
    });
    // Rivet changed a conversation's status, project, title or steps.
    source.addEventListener("thread", (event) => {
      streamHeard();
      try {
        const changedThread = JSON.parse(
          (event as MessageEvent<string>).data,
        ) as { id?: unknown; project?: unknown; appOnly?: unknown };
        if (typeof changedThread.id !== "string") return;
        const project =
          typeof changedThread.project === "string"
            ? changedThread.project
            : undefined;
        // A move to an app-only project counts at once; a move out waits for the fetches below, sent after this
        // arrived.
        heardProject(
          changedThread.id,
          isAppOnly(project) || changedThread.appOnly === true,
          0,
          false,
        );
        for (const [key, message] of messages) {
          if (message.threadId !== changedThread.id) continue;
          const { project: _was, ...rest } = message;
          messages.set(key, project ? { ...rest, project } : rest);
        }
        void loadList(true);
        if (shownId() === changedThread.id) void loadDetail(true);
        // At once: a conversation just moved to an app-only project loses its Share buttons before anything is fetched.
        render(false);
      } catch {}
    });
    source.addEventListener("open", () => {
      streamHeard();
      forgetAppOnly();
      // Catches up on what was missed while it was down.
      void loadList(true);
      void loadDetail();
    });
    source.addEventListener("error", () => {
      forgetAppOnly();
      if (source.readyState === EventSource.CLOSED && stream === source) {
        window.clearTimeout(idle);
        stream = null;
        startPolling();
      }
    });
    streamHeard();
  }

  /** A conversation may move to an app-only project while the stream is down: no Share until a read asked for after this lands. */
  function forgetAppOnly(): void {
    if (!alive) return;
    appOnlyHeard = false;
    appOnlyGen++;
    render(false);
  }

  /**
   * The server pings the stream every 25 s. One that goes quiet while its connection stays open fires neither open nor
   * error, so it is closed and opened again, and the reopen catches up on what was missed.
   */
  function streamHeard(): void {
    settleCancel();
    window.clearTimeout(idle);
    idle = window.setTimeout(() => {
      if (!alive || !stream) return;
      stream.close();
      stream = null;
      forgetAppOnly();
      startStream();
    }, STREAM_IDLE_MS);
  }

  function startPolling(): void {
    if (poll) return;
    poll = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      // No stream to say what changed: the list and the open conversation are read again.
      settleCancel();
      void loadList();
      void loadDetail();
    }, POLL_MS);
  }

  // Read-aloud left on from an earlier visit still needs one tap before iOS plays audio.
  const stopUnlock = speak ? unlockOnTap() : null;
  seedChat();
  render(true);
  if (threadHeld)
    later?.(() => {
      if (!alive || !threadHeld) return;
      threadHeld = false;
      render(heldStick);
    });
  void loadList();
  void loadDetail(false, true);
  // Mounted hidden, the stream waits for the app to come to the front.
  if (document.visibilityState !== "hidden") startStream();
  reload = async () => {
    void loadList();
    const before = jumps;
    return (await loadDetail()) && jumps === before && seeking === 0;
  };
  liveRefusal = (message) =>
    !appOnlyHeard ? SHARE_CHECKING : appOnly(message) ? SHARE_APP_ONLY : null;
  const unfocus = subscribe(() => {
    seek();
    paintSend();
  });
  seek();
  goConversation = (id, record) => openConversationNow(id, null, record);
  goRivet = () => {
    if (shown.kind === "rivet" && history.state?.chatScreen === undefined) return render(false);
    try {
      if (history.state?.chatScreen !== undefined)
        history.replaceState(withoutScreen(), "");
    } catch {}
    showRivet();
  };
  // A card answer's Open card shows while its card is on the board, and Rivet's Card: line's while its update card is;
  // a thing's step, media and Share read the board's cards: the page redraws when that changes.
  const openable = () =>
    allCards()
      .map((need) => `${need.id}:${need.rev}`)
      .join("\n");
  let cards = openable();
  const unboard = subscribe(() => {
    const now = openable();
    if (now === cards) return;
    cards = now;
    if (alive) render(false);
  });
  const refresher = window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    void loadList();
    void loadDetail();
  }, LIST_REFRESH_MS);
  const unwake = onWake(() => {
    if (alive && !stream && !poll && document.visibilityState !== "hidden") startStream();
  });
  // The mic's own disabled state is kept to give back when the cap lifts.
  let micWasDisabled = micBtn.disabled;
  const uncap = onCap((wake) => {
    const was = cappedWake;
    cappedWake = wake;
    if (wake !== null && was === null) micWasDisabled = micBtn.disabled;
    // The band above the app takes or gives back height: the thread keeps what was at its foot there. One within 160 px
    // of its end goes to the end, so the newest message shows whole with its time on a short screen.
    const left = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const fromBottom = left <= 160 ? 0 : left;
    attach.lock(wake !== null);
    if (wake !== null) voice?.stop();
    text.disabled = wake !== null;
    micBtn.disabled = wake !== null || micWasDisabled;
    composeBox.classList.toggle("capped", wake !== null);
    paintSend();
    paintPlaceholder();
    if ((wake === null) !== (was === null)) requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - fromBottom));
  });
  const onVisible = () => {
    markRead();
    // Hidden, the stream's pings would keep the phone's radio waking; back in front, a fresh one catches up as it opens.
    if (document.visibilityState === "hidden") {
      const pill = away.size > 0;
      away.clear();
      awayOwed.clear();
      awayLoad = true;
      if (pill) render(false);
      window.clearTimeout(idle);
      stream?.close();
      stream = null;
      // What it would have said while closed is unheard: no Share until reads asked for back in front land.
      forgetAppOnly();
      return;
    }
    // A read that landed while hidden may be stale by now too.
    forgetAppOnly();
    if (!stream && !poll) startStream();
    // Polling, with no stream to open: what changed while hidden is read now, not on the next tick. A fresh stream reads
    // it as it opens.
    if (poll) {
      void loadList();
      void loadDetail();
    }
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener(AUTO_SPEAK_EVENT, renderSpeak);
  // A sheet or dialog over the conversation holds its read marker back until it closes.
  let wasCovered = coveredOver(section);
  const coverage = new MutationObserver(() => {
    const now = coveredOver(section);
    if (wasCovered && !now) markRead();
    wasCovered = now;
  });
  coverage.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-modal"],
  });

  teardown = () => {
    alive = false;
    if (thingOnTop) leaveScreen("chat.thing");
    goConversation = null;
    goRivet = null;
    liveRefusal = null;
    unfocus();
    unboard();
    closeMenu();
    window.clearTimeout(litTimer);
    window.clearTimeout(listTimer);
    window.clearTimeout(detailTimer);
    window.removeEventListener("popstate", onPop);
    document.removeEventListener("fullscreenchange", onFullscreen);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener(AUTO_SPEAK_EVENT, renderSpeak);
    coverage.disconnect();
    foot.stop();
    if (draftBox === box) draftBox = null;
    putShare = null;
    reload = null;
    dropPhotos(attached);
    unzone();
    stream?.close();
    window.clearTimeout(idle);
    if (poll) window.clearInterval(poll);
    window.clearInterval(refresher);
    unwake();
    uncap();
    window.clearInterval(collectTick);
    window.cancelAnimationFrame(collectFrame);
    voice?.stop();
    stopUnlock?.();
    stopVoice();
  };
  if (started) {
    text.focus();
    text.setSelectionRange(text.value.length, text.value.length);
  }
}

/** Also the start of every mount, and sign-out (the shell unmounts the chat): the next mount waits for its own reads. */
export function unmount(): void {
  appOnlyHeard = false;
  appOnlyGen++;
  closeLightbox();
  teardown?.();
  teardown = null;
}

/**
 * How many entries this chat pushed under and including the current one (each conversation it opens records one), read
 * from the entry itself so Back and Forward keep it true. Rivet's sheet goes back past them when it closes.
 */
export function historyDepth(): number {
  const depth: unknown = (history.state as { chatDepth?: unknown } | null)?.chatDepth;
  return typeof depth === "number" && depth > 0 ? depth : 0;
}

/** True while the chat is mounted, as the Chat tab or alongside on a wide window. */
export function chatShown(): boolean {
  return teardown !== null;
}
