import "./command.css";
import "./conversations.css";

import { isUpdate } from "../../../src/shared/answers.js";
import type { ServedNeed } from "../../../src/shared/board.js";
import {
  CHAT_WINDOW_QUIET_MS,
  chatImages,
  imageFields,
  MAX_CHAT_TEXT,
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
import { chatName, rivetWords } from "../../../src/shared/names.js";
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
import { agentName } from "../cloud-agent.js";
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
import { showCard } from "./feed.js";
import { holdFoot } from "./hold-foot.js";
import { closeLightbox } from "./lightbox.js";
import { createDraftLineage } from "../draft-lineage.js";
import { chatSearch } from "./chat-search.js";
import { BOOKMARK, BOOKMARKED, chatSaved } from "./chat-saved.js";
import { swipeToReply } from "./chat-swipe.js";
import { openMore } from "./chat-more.js";
import { chatReplyStylePicker } from "./chat-reply-style.js";
import { chatSendDelayRow } from "./chat-send-delay.js";
import { askDesigns, designsOn } from "./three-designs.js";
import { applyChatTextSize, chatTextSizePicker } from "./chat-text-size.js";
import { registerSearchSource } from "./search-sources.js";
import { askLine, dueLine } from "./due-line.js";
import { chatNotDoneItem } from "./chat-not-done.js";
import { closeSheet, openSheet } from "./sheet.js";
import { flash } from "./toast.js";
import { stopText, thingFacts } from "./thing.js";
import { useTap, watchDepth } from "../usage.js";
import { fellAsleep, onCap, onWake } from "../rivet-sleep.js";
import { TYPED } from "../rivet-words.js";

// The Chat tab: one conversation with Rivet, like messaging one
// person. Every send from Chat starts a server conversation of its own, so a card Rivet files for it makes that one a
// thing; Chat reads them all as one, and a notification, link or search brings up a line in it.

const POLL_MS = 10_000;
/** Nearly two of the server's 25 s pings missed: the chat stream has stalled. */
export const STREAM_IDLE_MS = 45_000;
/** Needs you comes from GitHub, the board and open chats too, which say nothing on the stream: the list asks again this often. */
export const LIST_REFRESH_MS = 60_000;
/** A list or open conversation redraws this long after the last change it heard of. */
const SETTLE_MS = 400;
/** How many of Chat's messages a read brings. */
const CHAT_PAGE = 50;
/** Within this many pixels of the top, the page before loads by itself. */
const EARLIER_AT_PX = 160;
const EARLIER_FAILED = "Couldn't load earlier messages.";
/** A search hit's conversation loads at most this many earlier pages looking for it. */
const EARLIER_PAGES_MAX = 20;
/**
 * A line brought up (a notification, link or hit) loads up to this many earlier pages to reach it: a busy day elsewhere
 * can put a still-recent topic's line well over a thousand lines back.
 */
const REACH_PAGES_MAX = 200;
/** The unsent message, kept on this device only so a tab switch, backgrounding or reload never loses it. */
const DRAFT_KEY = "rivet.chat.draft";
/** Changes on every draft save, so a send can tell its draft from an identical one another tab saved since. */
const DRAFT_REV_KEY = "rivet.chat.draft.rev";
/** Set while the draft holds words Cancel put back and it is over the limit: kept whole, uncapped, until trimmed. */
const DRAFT_LONG_KEY = "rivet.chat.draft.long";
/** The message the draft replies to, kept beside it so a tab switch or reload keeps the reply too. */
const REPLY_KEY = "rivet.chat.reply";
/**
 * The retired Chat · Threads switch, folder, status chip and window, the topics Clean Up's Auto kept at the foot,
 * and the topic cards, Clean Up, the one-chat switch and the away pill's mark: read for
 * nothing, so removed.
 */
const RETIRED_KEYS = [
  "rivet.chat.view",
  "rivet.chat.folder",
  "rivet.chat.status",
  "rivet.chat.since",
  "rivet.chat.groups.kept",
  "rivet.chat.groups.kept.run",
  "rivet.chat.groups.seen",
  "rivet.chat.groups.seen.run",
  "rivet.chat.minimised",
  "rivet.chat.groups.open",
  "rivet.chat.groups.run",
  "rivet.chat.cleanup.noted",
  "rivet.chat.linear",
  "rivet.chat.read",
];

const SPEAKER =
  '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const SEND =
  '<svg viewBox="0 0 24 24"><path d="M4 12l15-7-5 15-2.5-6z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>';
const SHARE =
  '<svg viewBox="0 0 24 24"><path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M6 12v7.5h12V12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CLOSE =
  '<svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
const OPTIONS =
  '<svg viewBox="0 0 24 24"><path d="M4 7h9M19 7h1M4 17h3M13 17h7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="16" cy="7" r="2.4" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="10" cy="17" r="2.4" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>';

const FIND =
  '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15 15l5 5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

/** A gap this long between two lines starts a new chunk, with its small heading: one hour. */
export const CHUNK_GAP_MS = 60 * 60_000;

/**
 * Whether a line starts a chunk, which a small centred heading names: the first line, a new local day, or an hour
 * since the line before.
 */
export function startsChunk(at: string | undefined, before: string | undefined): boolean {
  const t = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(t)) return false;
  const b = before ? Date.parse(before) : Number.NaN;
  if (!Number.isFinite(b)) return true;
  return t - b >= CHUNK_GAP_MS || dayOf(t) !== dayOf(b);
}

/**
 * A time's local day, kept: every render asks it of every line a few times over, and the calendar's formatter is
 * slow enough to tell on a thread of a thousand lines.
 */
const days = new Map<number, string>();
function dayOf(t: number): string {
  let day = days.get(t);
  if (day === undefined) {
    if (days.size >= 5000) days.clear();
    day = localDay(t);
    days.set(t, day);
  }
  return day;
}

/** His line's states that show under it without a tap; the rest wait in the line's tapped-open strip. */
const SHOWN_STATES: ReadonlySet<string> = new Set(["collecting", "unconfirmed", "failed", "cancelled"]);

/** What Chat knows of a line's conversation: ChatPage.labels, else its row in the list. */
export type LabelSource = { title?: string; ask?: string; updates?: boolean };

/** The grey label over a run of Rivet's lines: its ask and title, its title, "Update" for Updates; null with nothing known. */
export function chatLabel(source: LabelSource | null | undefined): string | null {
  if (!source) return null;
  if (source.updates) return "Update";
  const title = source.title?.trim();
  if (source.ask) return title ? `${source.ask} · ${title}` : source.ask;
  return title || null;
}

/** A line showLine asked for before Chat mounted: the next mount brings it up. */
let pendingLine: { conversation: string; message: string | null } | null = null;
/** Brings up a line in the chat on screen, if any. */
let goLine: ((conversation: string, message: string | null) => void) | null = null;

/**
 * Brings up a line in Chat, lit for a moment: `message` (any message of `conversation`), loading earlier pages to reach
 * it, else the conversation's newest line Chat shows. One Chat leaves out (Updates, Agent Chat), or one gone, shows Chat
 * at its newest. Notifications, Feed, Town and search all come here; before Chat mounts it waits for the mount.
 */
export function showLine(conversation: string, message: string | null = null): void {
  if (goLine) goLine(conversation, message);
  else pendingLine = { conversation, message };
}

/** Brings up conversation `id` (any message of it names it) at its newest line in Chat. */
export const showConversation = (id: string): void => showLine(id);

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

/**
 * Brings up the thing a chat is working on in Chat: its newest conversation that links the chat, in its repo when given.
 * A chat with no thing yet opens Chat on a draft naming it, so the owner can ask about it.
 */
export function showChatThing(chat: string, repo?: string | null): void {
  const current = sameSession();
  void openThingFor(chat, repo).then((found) => {
    if (!found && current()) startDraft(`${chat}: `);
  });
}

/**
 * Brings up in Chat the newest line of the thing a chat's work is on; false, and nothing opened, when no conversation
 * names the chat. A chat name recurs across repos: given its repo, a conversation that linked that name in another repo
 * is not it.
 */
export function openThingFor(chat: string, repo?: string | null): Promise<boolean> {
  return cmd.getConversations()
    .then((response) => {
      const row = response.conversations.find((item) => linksChat(item.links, chat, repo));
      if (!row) return false;
      showLine(row.id);
      // From the Feed or the Town the line is on the Chat tab.
      app.tab = "chat";
      changed();
      return true;
    })
    .catch(() => false);
}

/**
 * One chat's lines in the Team room: what it sent or was sent, the owner's lines naming it, and untagged answers to those.
 * A name reads as Rivet reads it: the open chat of exactly that name, else the only one with it
 * as a part (`album` for `photo-album`); `live` is the open chats.
 */
export function fromChat(
  messages: readonly ChatMessage[],
  chat: string,
  live: readonly string[] = [],
): ChatMessage[] {
  const kept = new Set<string>();
  const chats = live.includes(chat) ? live : [...live, chat];
  const target = (text: string): string | null | undefined => {
    const word = (/^@([A-Za-z0-9._-]+)[\s:,]/.exec(`${text} `) ??
      /^([A-Za-z0-9._-]+):\s/.exec(`${text} `))?.[1]?.toLowerCase();
    if (word === undefined) return undefined;
    const exact = chats.find((one) => one.toLowerCase() === word);
    if (exact) return exact;
    const parts = chats.filter((one) =>
      one.toLowerCase().split(/[._-]/).includes(word),
    );
    return parts.length === 1 ? parts[0]! : null;
  };
  return messages.filter((message) => {
    // A line with no team names is the owner's or Rivet's: kept when it names the chat, or names no one and answers a kept
    // line; one naming another chat went there.
    // Only the owner's lines are routed by name; Rivet's answer ("Status: done") follows the line it answers.
    const to =
      message.team || message.from !== "owner"
        ? undefined
        : target(message.text ?? "");
    const mine = message.team
      ? message.team.from === chat || message.team.to === chat
      : to === undefined
        ? kept.has(message.replyTo ?? "")
        : message.from === "owner" && to === chat;
    if (mine) kept.add(message.id);
    return mine;
  });
}

/** The conversation open on screen, for the service worker: none, as Chat has no conversation page. */
export function openConversation(): string | null {
  return null;
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
/** When a jump looks at its line again where a browser tells no scrollend: a long smooth scroll has ended by then. */
const JUMP_SETTLE_MS = 900;
/** A way in's line that Chat does not show after all: said, never nothing. */
const NOT_IN_CHAT = "That message isn't in Chat.";
/** How near its foot Chat counts as at it, and is held there (holdFoot). */
const FOOT_NEAR = 40;

const STATUS_WORDS: Record<NonNullable<ChatMessage["status"]>, string> = {
  collecting: "Collecting…",
  sent: "Sent",
  get typed() {
    return `Typed to ${agentName()}`;
  },
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
/** The Back to newest button's arrow. */
const DOWN_ARROW =
  '<svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** When the latest collecting window here goes to Rivet (ms since the epoch, the server's clock); null with none known. */
function collectUntil(messages: Iterable<ChatMessage>): number | null {
  return collectWindow(messages)?.until ?? null;
}

/** The latest collecting window here: when it goes, and its own Send delay (10 s from a server before it). */
function collectWindow(messages: Iterable<ChatMessage>): { until: number; ms: number } | null {
  let latest: { until: number; ms: number } | null = null;
  for (const message of messages) {
    if (message.status !== "collecting" || !message.sendsAt) continue;
    const at = Date.parse(message.sendsAt);
    if (Number.isFinite(at) && (latest === null || at > latest.until)) latest = { until: at, ms: message.windowMs || CHAT_WINDOW_QUIET_MS };
  }
  return latest;
}

/** Whole seconds until the latest collecting window here goes to Rivet, by the server's clock; null with none known. */
export function collectLeft(messages: Iterable<ChatMessage>, now = serverNow()): number | null {
  const until = collectUntil(messages);
  return until === null ? null : Math.max(0, Math.ceil((until - now) / 1000));
}

/**
 * The collect bar's width in percent, by the exact time left rather than whole seconds, so drawn every frame it drains at one even pace and empties as the window goes. Full with no
 * deadline known.
 */
export function collectBarWidth(messages: Iterable<ChatMessage>, now = serverNow()): number {
  const open = collectWindow(messages);
  if (open === null) return 100;
  return Math.min(100, Math.max(0, ((open.until - now) * 100) / open.ms));
}

/** A collecting line's own status: its seconds left, short enough for a narrow screen; the banner says the rest. */
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

function forgetRetired(): void {
  try {
    for (const key of RETIRED_KEYS) localStorage.removeItem(key);
  } catch {}
}

function readDraft(): string {
  try {
    const draft = localStorage.getItem(DRAFT_KEY) ?? "";
    // Words Cancel put back are his own, whatever their length (a window's raw lines, two put-backs in a row): kept
    // whole until he trims them. Any other draft keeps the message limit.
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
      // Put back over a draft and over the limit together, it is kept whole while he trims it; any other stays capped.
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
  /** Picked in Chat: the label of the run it answers, which the strip names in place of a quote. */
  label?: string;
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
      typeof quote.text !== "string" ||
      // In the agents' room a reply is only ever to an agent's line, which names its owner; a kept one without is dropped.
      (saved.conversation === TEAM_ROOM_ID && typeof saved.owner !== "string")
    )
      return null;
    return {
      id: saved.id,
      quote: { from: quote.from, text: quote.text },
      ...(typeof saved.conversation === "string"
        ? { conversation: saved.conversation }
        : {}),
      ...(typeof saved.owner === "string" ? { owner: saved.owner } : {}),
      ...(typeof saved.label === "string" ? { label: saved.label } : {}),
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
/** What Chat's pages named of their lines' conversations (ChatPage.labels), for the label over each run. */
const chatLabels = new Map<string, LabelSource>();
onSessionReset(() => {
  lastChat = null;
  chatLabels.clear();
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
 * Read-aloud state, kept for the session. `home` is the time of the newest message the chat knew of when it first
 * loaded: nothing older is ever spoken, so a refresh or reconnect never replays history. `heard` holds the Rivet
 * messages already shown or spoken, by id, since arrival order (not id order) decides what is new.
 */
let home: string | null = null;
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

/** The Town's Rivet row: the conversation with him on the Chat tab. */
export function showRivetChat(): void {
  openRivet();
  app.tab = "chat";
  changed();
}

/** Started from elsewhere, it is about something else: a reply saved while no chat was on screen is dropped. */
function openRivet(): void {
  if (teardown === null) writeReply(null);
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

/**
 * The words a tap sends as his (Stop it, Start it or Drop it from Coming, Fix it, Start work) and a card answer's: they
 * carry agent-written titles, so they read as the rest of the page. Lines from before the typed mark have no
 * mark, so these words are how a tap's line is told from his own, as the server's Asked-before fill does.
 */
const TAP_WORDS = /^(?:Stop (?:this|[a-z0-9][a-z0-9-]*): |Start it \(from Coming\)|Drop it \(from Coming\)|Fix it: |Start work on |Approved\b|Dismissed\b|Rejected\b|Chose:|Comment\b|Seen$|Done$)/;

/** His own words, left as he typed them (rivet-words.ts): typed in a box, or any line of his but a tap's or a card answer. */
export function hisOwnWords(message: { text: string; typed?: true; card?: unknown }): boolean {
  return message.typed === true || (!message.card && !TAP_WORDS.test(message.text.trimStart()));
}

function quoteParts(quote: ChatQuote): HTMLElement[] {
  const typed = quote.from === "owner" && hisOwnWords({ text: quote.text });
  return [
    h(
      "span",
      { class: "chat-quote-who" },
      quote.from === "owner" ? "You" : agentName(),
    ),
    h("span", { class: "chat-quote-text", attrs: typed ? { [TYPED]: "" } : {} }, quote.text),
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
      // share() must start inside the tap, before any await, or iOS refuses it.
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
  applyChatTextSize();
  /** Chat's messages. */
  let messages = new Map<string, ChatMessage>();
  let detailTimer = 0;
  let detailTicket = 0;
  let list: ConversationsResponse | null = null;
  /** Chat's newest page has come at least once since it last opened. */
  let chatLoaded = false;
  /** A conversation Chat may mark read: a thing he marked unread stays so until he opens it. */
  const readable = (row: ConversationSummary) => row.id !== TEAM_ROOM_ID && !(row.thing && row.markedUnread);
  /** Where Chat's held lines run unbroken from: a refresh keeps lines from before its page, past a gap. */
  let unbrokenFrom = "";
  /** Chat's first read failed, so its empty line says so and offers Try again rather than Loading… on. */
  let loadFailed = false;
  let listTimer = 0;
  let listTicket = 0;
  /** Whether Chat has messages before the earliest loaded; null until its first page loaded. */
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
  /** Counts ways into a line (lineNow), so only the newest one's read lands. */
  let lineGen = 0;
  /** The line a way in still waits to bring up: the next newest page to land, whoever asked for it, does. */
  let wanted: string | null = null;
  /** Summaries read when a way in fetched a topic the open list leaves out (an archived one). */
  const fetchedSummaries = new Map<string, ConversationSummary>();
  let litTimer = 0;
  /** Lets go of a jump's look back at its line once its scroll ends (jump). */
  let unsettle: (() => void) | null = null;
  /** The thread waits for `later`; `heldStick`: a render while it waited asked to stick to the newest. */
  let threadHeld = !!later && !app.chatFocus && !focusOnMount && !pendingLine;
  let heldStick = false;
  /** A way in's line asked for while the thread was held: brought up once it draws (bringUp). */
  let heldLine: string | null = null;

  const thread = h("ol", {
    class: "chat-thread",
    attrs: { "aria-live": "polite", "aria-label": "Messages" },
  });
  // No Earlier messages button: scrolling to the top loads the page before; this says so while it comes.
  const earlier = h("div", { class: "conv-earlier", attrs: { role: "status" } }, h("span", {}, "Loading earlier messages…"));
  earlier.hidden = true;
  /** Off after a failed earlier page until he scrolls away from the top, so a failure is not asked again on every pixel. */
  let earlierArmed = true;
  /** Pages before loaded by themselves since he last scrolled or opened this: at EARLIER_PAGES_MAX they wait for him. */
  let earlierRun = 0;
  function armEarlier(): void {
    earlierArmed = true;
    earlierRun = 0;
  }
  // Back to newest: read more than a screen up, a round ↓ over the message box brings the newest back in one
  // tap, counting the lines that landed while he was up. Its dock stands no taller than nothing at the scroller's foot.
  const newestCount = h("span", { class: "chat-newest-count" });
  newestCount.hidden = true;
  const newestBtn = h(
    "button",
    {
      class: "chat-newest",
      attrs: { type: "button", "aria-label": "Back to newest", "data-use": "chat.newest" },
      on: { click: () => toNewest() },
    },
    svg(DOWN_ARROW),
    newestCount,
  );
  newestBtn.hidden = true;
  const scroller = h("div", { class: "chat-scroll" }, earlier, thread, h("div", { class: "chat-newest-dock" }, newestBtn));
  watchDepth(scroller, () => "chat");
  const foot = holdFoot(scroller, FOOT_NEAR);
  /** The newest line when he left the foot: lines after it are counted on the ↓. Null while he is at it. */
  let upFrom: ChatMessage | null = null;
  /** The lines as the last paint drew them, in order: the ↓ reads them on every scroll, so they are sorted once a paint. */
  let shown: ChatMessage[] = [];
  /** Where Chat was when search covered it, to put back when it goes. */
  let covered: { held: boolean; top: number } | null = null;
  /** Chat has drawn its messages: a search over it before then has no place of Chat's to keep. */
  let drawn = false;
  const text = h("textarea", {
    class: "chat-text",
    attrs: {
      rows: "1",
      maxlength: String(MAX_CHAT_TEXT),
      placeholder: "Message",
      "aria-label": `Message ${agentName()}`,
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
  // While a window collects: the seconds left by the server's deadline, and Cancel, which puts it back in the box.
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
        ? `Sending to ${agentName()} soon`
        : left > 0
          ? `Sending to ${agentName()} in\u00a0${left}s`
          : `Sending to ${agentName()}…`;
    if (collectWords.textContent !== words) collectWords.textContent = words;
    // Reduced motion: the bar moves on this tick alone. Otherwise the frame loop drains it, started again if it rested.
    if (stillMotion()) paintBar();
    else if (!collectFrame) drainCollect();
    const line = collectLine(left);
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
   * files return to the box, ahead of anything typed since. Sent already, they stay and he is told.
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
    // A reply comes back as one, as it was picked.
    if (back.replyTo && back.quote) setReply({ id: back.replyTo, quote: back.quote }, false);
    hint.textContent =
      text.value.length > MAX_CHAT_TEXT
        ? "Cancelled. It's back in the box, too long to send as one: trim it first."
        : "Cancelled. It's back in the box to edit.";
    render(false);
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
      if (top !== null && (home === null || top > home)) home = top;
      // While the conversation is empty, the press separates history from new replies, even if its list arrived.
      if (messages.size === 0) {
        const pressedAt = new Date(Date.now()).toISOString();
        if (home === null || pressedAt > home) home = pressedAt;
      }
    } else stopVoice();
    renderSpeak();
  };
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
  };
  renderSpeak();
  // Collapse all, Expand all and Mark all read moved to the topics bar over Chat. Read aloud, where the device can
  // speak, and Text size are the menu's own. Send delay is read from the server as the menu opens.
  const sendDelay = chatSendDelayRow({ authFail: (error) => authFail(error) });
  // Chat's own "3 designs" (three-designs.ts): on a phone its sheet covers the menu, and its head has no room for more.
  const designsItem = h(
    "button",
    {
      class: "chat-menu-item chat-designs",
      attrs: { type: "button", role: "menuitem", "data-use": "menu.row.designs" },
      on: {
        click: () => {
          closeMenu();
          void askDesigns({ screen: "chat" });
        },
      },
    },
    svg(ICONS.photo, "btn-icon"),
    h("span", { class: "chat-menu-grow" }, "3 designs of this screen"),
  );
  designsItem.hidden = true;
  const menu = h(
    "div",
    { class: "chat-menu", attrs: { role: "menu", "aria-label": "Chat options" } },
    // The Promise keeper's list: your asks still open, late first.
    chatNotDoneItem(() => closeMenu(), () => signedOut("Your session ended. Sign in again.")),
    canSpeak() ? speakSwitch : null,
    chatTextSizePicker(),
    chatReplyStylePicker(),
    designsItem,
    sendDelay.el,
  );
  menu.hidden = true;
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
    sendDelay.refresh();
    designsItem.hidden = !designsOn();
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

  // Search is a magnifier in the head: its bar shows under the head while it is on, and takes no room off it.
  let finding = false;
  const findBtn = h(
    "button",
    {
      class: "icon-btn chat-options chat-find",
      attrs: { type: "button", "aria-label": "Search chat", "aria-expanded": "false", "data-use": "chat.search.open" },
      on: { click: () => setFinding(!finding) },
    },
    svg(FIND, "icon-btn-icon"),
  );
  /** Shows or puts away the search bar; put away, what was typed goes with it. `quiet` leaves the redraw to the caller. */
  function setFinding(on: boolean, quiet = false): void {
    if (finding === on) return;
    finding = on;
    if (on) saved.close(false);
    findBtn.setAttribute("aria-expanded", String(on));
    if (!on) search.clear(true);
    if (quiet) return;
    render(false);
    if (on) search.focus();
    else findBtn.focus();
  }
  // Saved lines: a bookmark in the head opens their list over Chat; a line's Save or a pull left keeps one.
  const saved = chatSaved({
    go: (line) => lineNow(line.conversation, line.id),
    // A saved line Chat has not loaded replies from what the list holds of it.
    reply: (line) => replyToLine(messages.get(line.id) ?? line),
    // As the line's own Reply: none on his line while it still collects.
    replies: (line) => !(line.from === "owner" && (messages.get(line.id) ?? line).status === "collecting"),
    changed: () => {
      if (alive) render(false);
    },
    // Quietly, as a way in does: a redraw between search and the list would show (and mark read) what search covered.
    opening: () => {
      search.clear(true);
      setFinding(false, true);
    },
    signedOut: () => signedOut("Your session ended. Sign in again."),
  });
  const dueSlot = h("span", { class: "chat-due-slot" });
  const chatTitle = h("h1", { class: "chat-title" }, agentName());
  const chatHead = h(
    "div",
    { class: "chat-head" },
    chatTitle,
    h("div", { class: "chat-tools" }, dueSlot, saved.button, findBtn, optionsBtn, menu),
  );
  // A hosted agent's name can come after Chat has mounted (cloud-agent.ts).
  const paintName = () => {
    if (chatTitle.textContent === agentName()) return;
    chatTitle.textContent = agentName();
    text.setAttribute("aria-label", `Message ${agentName()}`);
    if (alive) render(false);
  };
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
  // A title hit brings up its conversation's newest line in Chat; a message hit, that message.
  const search = chatSearch(
    (id, whole) => {
      setFinding(false, true);
      if (whole) lineNow(id, null);
      else openHit(id);
    },
    () => render(false),
    () => setFinding(false),
  );
  // An ask is named as the grey label over its line names its conversation, when Chat holds that line.
  const due = dueLine(
    (id) => openHit(id),
    (ask) => {
      const line = askLine(ask);
      const message = line ? messages.get(line) : undefined;
      if (!message) return null;
      const id = threadOf(message);
      return (chatLabels.get(id) ?? summaryOf(id))?.title?.trim() || null;
    },
  );
  dueSlot.replaceWith(due.el);
  const section = h(
    "section",
    { class: "chat", attrs: { "data-card-keys": "off" } },
    chatHead,
    search.el,
    saved.el,
    scroller,
    composeBox,
    hint,
  );
  el.replaceChildren(section);
  saved.load();

  // A draft startDraft began for this mount (Discuss this) opens with the keyboard up, the caret after it.
  const started = focusOnMount;
  focusOnMount = false;
  text.value = pendingDraft ?? readDraft();
  pendingDraft = null;
  if (text.value) fit();
  const kept = readReply();
  // A reply comes back in Chat, one picked on a thing's old page too.
  if (kept) setReply(kept, false);
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
  scroller.addEventListener("scroll", () => {
    readChat();
    earlierAtTop();
    paintNewest();
  });
  // A Chat shorter than the screen never scrolls: dragging or wheeling it down at the top is his scroll away and back,
  // once a drag (a new touch) or once a wheel gesture (after a second's pause), never on every event of one gesture.
  let gesturePulled = false;
  let wheeledAt = -Infinity;
  const pullEarlier = (): void => {
    if (gesturePulled || earlierArmed || scroller.scrollHeight - scroller.clientHeight > EARLIER_AT_PX) return;
    gesturePulled = true;
    armEarlier();
    earlierAtTop();
  };
  scroller.addEventListener("touchstart", () => (gesturePulled = false), { passive: true });
  scroller.addEventListener("touchmove", pullEarlier, { passive: true });
  scroller.addEventListener("wheel", (event) => {
    if (event.deltaY >= 0) return;
    if (event.timeStamp - wheeledAt >= 1000) gesturePulled = false;
    wheeledAt = event.timeStamp;
    pullEarlier();
  }, { passive: true });
  // Photos and files dragged from the desktop, or a screenshot pasted, attach as the clip's picker would. The whole
  // pane takes the drop, past the column's edges; a read-only conversation, with no composer, takes none.
  // Only while the composer is on screen and takes files: not over a search, which hides it, nor while Rivet is asleep,
  // when the clip is off too.
  const composing = () => !composeBox.hidden && cappedWake === null && !section.classList.contains("searching");
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
   * keyboard up, or the messages) clamps to that shorter page and stays there: the topics bar flashed back and the box
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

  /** In Chat: every line of every conversation but the old Updates. */
  function inChat(message: ChatMessage): boolean {
    return (message.threadId ?? message.id) !== UPDATES_ID;
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

  function paintPlaceholder(): void {
    text.placeholder = cappedWake !== null ? `Asleep ${cappedWake}` : "Message";
  }

  function setReply(target: ReplyTarget | null, focus = true): void {
    replyingTo = target;
    paintPlaceholder();
    writeReply(target);
    replyBar.hidden = target === null;
    replyBar.classList.toggle("labelled", !!target?.label);
    if (!target) return replyQuote.replaceChildren();
    replyQuote.replaceChildren(...(target.label ? ["Replying to ", h("strong", {}, target.label)] : quoteParts(target.quote)));
    if (focus) text.focus();
  }

  const drawnLine = (id: string): HTMLElement | undefined =>
    [...thread.querySelectorAll<HTMLElement>(".chat-msg")].find((item) => item.dataset.id === id);

  /** Brings a drawn line into view and lights it for a moment. False, with nothing done, when the line is not drawn. */
  function jump(id: string): boolean {
    const target = drawnLine(id);
    if (!target) return false;
    jumps++;
    thread.querySelector(".chat-msg.lit")?.classList.remove("lit");
    lit = id;
    target.classList.add("lit");
    // Setting the scroll ends a smooth one: the thread growing under it must not take it back to the foot.
    foot.place(false, true);
    const behavior: ScrollBehavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    // A line taller than Chat shows from its start; centred, he would land mid-answer.
    const tall = (line: HTMLElement) => line.getBoundingClientRect().height > scroller.clientHeight;
    target.scrollIntoView?.({ block: tall(target) ? "start" : "center", behavior });
    // Lines not drawn yet stand at a guessed height (content-visibility, command.css) and take their own as the scroll
    // passes them, so it can end with the line short of the middle, under the head. Each time a scroll ends
    // while it is lit, a line not wholly in view is brought to the middle again; his own touch lets it be.
    unsettle?.();
    const settle = () => {
      const line = drawnLine(id);
      if (!alive || lit !== id || !line) return unsettle?.();
      const box = scroller.getBoundingClientRect();
      const at = line.getBoundingClientRect();
      const off = tall(line) ? at.top < box.top || at.top > box.bottom : at.top < box.top || at.bottom > box.bottom;
      if (off) line.scrollIntoView?.({ block: tall(line) ? "start" : "center", behavior });
    };
    // A browser with no scrollend looks once, when a long smooth scroll has ended.
    const late = window.setTimeout(settle, JUMP_SETTLE_MS);
    let handOn = false;
    const touched = () => {
      handOn = true;
      unsettle?.();
    };
    // His own scroll, by touch, wheel or keys, lets it be.
    const his = ["pointerdown", "wheel", "touchstart", "keydown"];
    scroller.addEventListener("scrollend", settle);
    for (const kind of his) scroller.addEventListener(kind, touched, { passive: true });
    unsettle = () => {
      window.clearTimeout(late);
      scroller.removeEventListener("scrollend", settle);
      for (const kind of his) scroller.removeEventListener(kind, touched);
      unsettle = null;
    };
    window.clearTimeout(litTimer);
    litTimer = window.setTimeout(() => {
      lit = null;
      unsettle?.();
      thread.querySelector(".chat-msg.lit")?.classList.remove("lit");
      // A jump to a line at the foot moved nothing, so no scroll down took hold again: at the foot still, it holds,
      // unless he has a hand on it.
      if (!handOn && scroller.clientHeight > 0 && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < FOOT_NEAR) foot.place(true);
    }, LIT_MS);
    return true;
  }

  /** A way in's line: brought up, or, not drawn in Chat after all, a word that it is not here in place of nothing. */
  function bringUp(id: string): void {
    if (jump(id)) return;
    // Nothing drawn yet (held for the home's first frame, or under a full-screen clip): brought up once Chat draws.
    if (threadHeld || (document.fullscreenElement && thread.contains(document.fullscreenElement))) {
      heldLine = id;
      return;
    }
    flash(NOT_IN_CHAT, "warn");
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
  function row(message: ChatMessage, quoted: boolean, run: Run, next: typeof rows): HTMLElement {
    const card = cardOf(message);
    const key = JSON.stringify([
      message,
      quoted,
      run,
      labelOf([message]),
      message.id === lit,
      appOnly(message),
      card ? [card.id, card.rev, isUpdate(card)] : null,
      message.card ? answeredTitle(message) : null,
      timeOf(message.at),
      chatImages(message).map(mediaSrc),
      saved.has(message.id),
    ]);
    const was = rows.get(message.id);
    const el = was?.key === key ? was.el : bubble(message, quoted, run);
    next.set(message.id, { key, el });
    return el;
  }

  /**
   * The messages in runs, oldest to newest: a new run at each new question and at another conversation's line, so a
   * Reply names its own conversation. A chunk's first line starts one as well: its heading sits over it.
   */
  function exchangesOf(sorted: ChatMessage[]): ChatMessage[][] {
    const groups: ChatMessage[][] = [];
    for (const message of sorted) {
      const last = groups.at(-1);
      const before = last?.at(-1);
      if (
        last &&
        before &&
        !(message.from === "owner" && before.from !== "owner") &&
        threadOf(message) === threadOf(before) &&
        !startsChunk(message.at, before.at)
      )
        last.push(message);
      else groups.push([message]);
    }
    return groups;
  }

  function threadOf(message: ChatMessage): string {
    return message.threadId ?? message.id;
  }

  /** His last line in the run is still waiting for Rivet. */
  function waiting(group: ChatMessage[]): boolean {
    const last = group.at(-1)!;
    return last.from === "owner" && !last.card && (last.status === "sent" || last.status === "typed");
  }

  /**
   * Where a line sits in its run: lines from one side with no heading between them sit close, and only the run's last
   * carries Rivet's face.
   */
  type Run = { first: boolean; last: boolean };

  function sameRun(a: ChatMessage, b: ChatMessage): boolean {
    return (a.from === "owner") === (b.from === "owner") && a.team?.from === b.team?.from && a.team?.to === b.team?.to && !startsChunk(b.at, a.at);
  }

  /** The line whose time, More and Reply are open under it: one at a time, opened by a tap on the line. */
  let opened: string | null = null;

  /** Opens a line's strip, or closes it at a second tap; the line that was open closes. */
  function toggleOpen(id: string): void {
    const atFoot = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
    opened = opened === id ? null : id;
    for (const line of thread.querySelectorAll<HTMLElement>(".chat-msg")) {
      const on = line.dataset.id === opened;
      line.classList.toggle("open", on);
      const strip = line.querySelector<HTMLElement>(":scope > .chat-msg-open");
      if (strip) strip.hidden = !on && !line.classList.contains("held");
    }
    // The newest line's strip opens under it, in view.
    if (atFoot) scroller.scrollTop = scroller.scrollHeight;
  }

  /** The label of a line's conversation, "<ask id> · <title>", in its strip and on its Reply. */
  function labelOf(group: ChatMessage[]): string | null {
    const id = threadOf(group[0]!);
    return chatLabel(chatLabels.get(id) ?? summaryOf(id));
  }

  /** Each run as last drawn, by its first message: its turns list is kept, so no bubble or clip leaves the page. */
  let topicCards = new Map<string, { key: string; el: HTMLElement; turns: HTMLElement; chrome: HTMLElement[] }>();
  /** Each run's messages as last drawn: Reply reads them when tapped. */
  let cardGroups = new Map<string, ChatMessage[]>();

  /**
   * A line's More: Read aloud for Rivet's words, Copy, Share for a line that may leave the app, Open card, and on a
   * thing's line Stop it.
   */
  function moreOf(message: ChatMessage): void {
    const words = message.posted ? message.posted.title : message.card && message.from === "owner" ? answerLine(answeredTitle(message), message.text) : message.text;
    const card = cardOf(message);
    const theirs = message.from !== "owner";
    const id = threadOf(message);
    const summary = summaryOf(id);
    const thing = !ownsNoCard(id) && summary?.updates !== true;
    const facts = thing ? thingFacts([...messages.values()].filter((one) => threadOf(one) === id), allCards(), summary) : null;
    const title = (summary?.title ?? chatLabels.get(id)?.title)?.trim() || "Conversation";
    openMore({
      line: words.replace(/\s+/g, " ").trim() || (theirs ? agentName() : "Your line"),
      listen: theirs && !message.team && !message.posted && message.text.trim() ? rivetWords(message.text) : null,
      copy: words.trim() || null,
      // Share sends text: a line that is only photos or a video has none to send, and a card is no answer.
      share:
        theirs && !message.posted && message.text.trim() && !appOnly(message) && !inRoom(message)
          ? () => openShare(message.text, () => (liveRefusal ? liveRefusal(message) : SHARE_CHECKING))
          : null,
      card: card ? () => showCard(card.id) : null,
      stop: facts ? () => confirmStop(id, facts.chat, title) : null,
    });
  }

  /** Reply on a line: it answers that line, and in Chat the strip names its run's label. */
  function replyToLine(message: ChatMessage): void {
    const group = [...cardGroups.values()].find((one) => one.some((line) => line.id === message.id));
    const label = group ? labelOf(group) : null;
    setReply({
      id: message.id,
      quote: { from: message.from, text: quoteText(message) },
      ...(label ? { label } : {}),
    });
  }

  /**
   * A run of lines, under the small centred heading of its chunk when it starts one: the time today, the weekday or
   * the date with it on an earlier day. Each line carries its own time, More and Reply, shown at a tap (bubble).
   */
  function exchange(group: ChatMessage[], bubbles: HTMLElement[], heading: string | null, next: typeof topicCards): HTMLElement {
    const first = group[0]!.id;
    const thread = threadOf(group[0]!);
    const wait = waiting(group);
    const key = JSON.stringify([wait, heading]);
    const was = topicCards.get(first);
    const kept = was?.key === key ? was : null;
    const turns = was?.turns ?? h("ol", { class: "chat-ex-turns" });
    const chrome = kept?.chrome ?? [
      heading ? h("p", { class: "chat-day" }, heading) : null,
      turns,
      wait
        ? h(
            "p",
            { class: "chat-ex-wait", attrs: { role: "status" } },
            rivet("working", { size: 28, className: "chat-rivet" }),
            h("span", { class: "chat-ex-dots", attrs: { "aria-hidden": "true" } }, h("i"), h("i"), h("i")),
            `${agentName()} is working on it`,
          )
        : null,
    ].filter((one): one is HTMLElement => one !== null);
    placeChildren(turns, bubbles);
    const el = was?.el ?? h("li", { class: "chat-ex", attrs: { "data-ex": first } });
    el.dataset.thread = thread;
    placeChildren(el, chrome);
    next.set(first, { key, el, turns, chrome });
    return el;
  }

  function bubble(message: ChatMessage, quoted: boolean, run: Run): HTMLElement {
    const mine = message.from === "owner";
    const posted = message.posted;
    // A line still collecting, or one that did not go, says so under its words without a tap.
    const state = mine && message.status && SHOWN_STATES.has(message.status) ? message.status : null;
    const label = mine ? null : labelOf([message]);
    // A card answer is his message too; its card opens from here while it is still on the board. Rivet's "Card: … ›"
    // line (say.mjs --card) opens its update card the same way, the line itself one tap; so does the line beside a
    // question card (a reply that asked him something) while that card is open, and a card Rivet posted here.
    const card = cardOf(message);
    // A line's strip, opened by a tap on it: its time, in Chat its conversation's label, then how his line went.
    // No name: his lines are on the right, Rivet's on the left by his face, an agent's under its own names.
    const said = [
      timeOf(message.at) ?? "",
      label ? ` · ${label}` : null,
      message.card && mine ? " · from a card" : null,
      mine && message.ack
        ? h(
            "span",
            { class: "chat-status acked" },
            ` · ${agentName()}: ${ackWords(message.ack.text)}`,
          )
        : mine && message.status === "replied"
          ? // A small tick, not the word.
            [" · ", h("span", { class: "chat-status replied", attrs: { role: "img", "aria-label": STATUS_WORDS.replied, title: STATUS_WORDS.replied } }, svg(ICONS.yes, "chat-tick"))]
          : mine && message.status && !state
          ? h("span", { class: `chat-status ${message.status}` }, ` · ${STATUS_WORDS[message.status]}`)
          : null,
    ].flat();
    const stateLine = state
      ? h(
          "p",
          { class: "chat-state" },
          h("span", { class: `chat-status ${state}` }, state === "collecting" ? collectLine(collectLeft(messages.values())) : STATUS_WORDS[state]),
        )
      : null;
    // In Chat his card answer reads as the answer to its card: "You approved “…”".
    const text = mine && message.card ? answerLine(answeredTitle(message), message.text) : message.text;
    // A line with no plain words to tap (only a photo, a clip or a file, or Rivet's card line, whose words are the
    // card's button) keeps its strip shown: a tap there opens the photo or the card, so it could never open the strip.
    const held = !posted && (!text || Boolean(card && !mine));
    /** True when the tap opened or closed the strip. */
    const tap = (event: Event): boolean => {
      const at = event.target instanceof Element ? event.target : null;
      // A button, a link, a clip or the strip itself keeps its own tap; so does a drag that picked words out.
      if (held || !at || at.closest("button, a, video, audio, .chat-msg-open") || window.getSelection()?.toString()) return false;
      toggleOpen(message.id);
      return true;
    };
    const images = chatImages(message).map(mediaSrc);
    const alt = mine ? "Photo you sent" : "Photo";
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
    // Every line has its own More and Reply, in its strip, his own lines too: a reply
    // to his line goes to that line's conversation. None on his line while it still collects (Cancel can take the line
    // away from under the reply).
    const replies = !(mine && message.status === "collecting");
    const kept = saved.has(message.id);
    const tools = h(
      "div",
      { class: "chat-msg-tools" },
      h(
        "button",
        { class: "chat-msg-tool", attrs: { type: "button", "aria-label": "More for this line", "data-use": "chat.msg.more" }, on: { click: () => moreOf(messages.get(message.id) ?? message) } },
        "More",
      ),
      replies
        ? h(
            "button",
            { class: "chat-msg-tool", attrs: { type: "button", "aria-label": "Reply to this line", "data-use": "chat.msg.reply" }, on: { click: () => replyToLine(messages.get(message.id) ?? message) } },
            "Reply",
          )
        : null,
      // Every line can be saved, his own and one without Reply too.
      h(
        "button",
        {
          class: "chat-msg-tool chat-save",
          attrs: { type: "button", "aria-pressed": String(kept), "data-use": "chat.msg.save" },
          on: { click: () => toggleSaved(message) },
        },
        svg(kept ? BOOKMARKED : BOOKMARK, "chat-save-icon"),
        kept ? "Saved" : "Save",
      ),
    );
    const strip = h("div", { class: "chat-msg-open" }, meta, tools);
    strip.hidden = !held && message.id !== opened;
    const line = h(
      "li",
      {
        class: `chat-msg ${mine ? "mine" : "theirs"}${!mine && !message.team ? " has-rivet" : ""}${posted ? " posted" : ""}${message.id === lit ? " lit" : ""}${run.first ? " run-first" : ""}${run.last ? " run-last" : ""}${message.id === opened ? " open" : ""}${held ? " held" : ""}`,
        // A key reaches the line as a tap does: Enter or Space on it opens its strip. No data-use on the line: a tap
        // on a link in its words is the link's, and the strip's opening is counted only when it opens or closes.
        attrs: { "data-id": message.id, tabindex: "0" },
        on: {
          click: (event: Event) => {
            if (tap(event)) useTap("chat.msg.open");
          },
          keydown: (event: Event) => {
            const key = (event as KeyboardEvent).key;
            const line = event.currentTarget as HTMLElement;
            // Escape on an open line, or on its More or Reply, closes the strip only: Rivet's sheet closes on an
            // Escape that reaches the page.
            if (key === "Escape" && opened === message.id) {
              event.preventDefault();
              event.stopPropagation();
              toggleOpen(message.id);
              line.focus();
              return;
            }
            if (held || event.target !== line || (key !== "Enter" && key !== " ")) return;
            event.preventDefault();
            useTap("chat.msg.open");
            toggleOpen(message.id);
          },
        },
      },
      // Rivet's face stands by the last line of his run only. 28px is the smallest his front symbols stay legible at
      // (rivet-symbols.test.ts).
      !mine && !message.team && run.last ? rivet(moodOf(message.text), { size: 28, className: "chat-rivet" }) : null,
      // In the agents' room a run's first line says who wrote to whom.
      message.team && run.first ? h("p", { class: "chat-who" }, `${chatName(message.team.from)} → ${chatName(message.team.to)}`) : null,
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
              // A quoted line older than the page loaded here is fetched and brought up as a search hit is.
              on: { click: () => jump(replyTo) || openHit(replyTo) },
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
        : text
        ? card && !mine
          ? h(
              "button",
              {
                class: "chat-body chat-card-line",
                attrs: { type: "button", "data-use": "chat.msg.card-line" },
                on: { click: () => showCard(card.id) },
              },
              text,
            )
          : // His own line stays as he typed it (rivet-words.ts); a tap's line or a card answer carries agent-written words.
            h("p", { class: "chat-body", attrs: mine && hisOwnWords(message) ? { [TYPED]: "" } : {} }, ...linkify(text))
        : null,
      openCard ? h("div", { class: "chat-foot" }, h("div", { class: "chat-foot-tools" }, openCard)) : null,
      kept ? h("p", { class: "chat-mark" }, svg(BOOKMARKED, "chat-mark-icon"), "Saved") : null,
      stateLine,
      strip,
    );
    // Pulled right, a line replies as its Reply does, wherever it has a Reply; pulled left, any line is saved or unsaved.
    swipeToReply(
      line,
      replies
        ? () => {
            useTap("chat.msg.reply");
            replyToLine(messages.get(message.id) ?? message);
          }
        : null,
      () => {
        useTap("chat.msg.save");
        toggleSaved(message);
      },
    );
    return line;
  }

  function toggleSaved(message: ChatMessage): void {
    // Its button is drawn again with the other word: the keyboard follows it to the new one.
    const had = document.activeElement instanceof HTMLElement && document.activeElement.classList.contains("chat-save");
    saved.toggle(message);
    if (had) thread.querySelector<HTMLElement>(`.chat-msg[data-id="${CSS.escape(message.id)}"] .chat-save`)?.focus();
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
    return list?.conversations.find((row) => row.id === id) ?? fetchedSummaries.get(id) ?? null;
  }

  /** Stop it asks first, then tells Rivet in thing `id`'s conversation; there is no stop of a chat but his. */
  function confirmStop(id: string, chat: string | null, title: string): void {
    const words = stopText(chat, title);
    openSheet(
      chat ? `Ask ${agentName()} to stop ${chatName(chat)}?` : `Ask ${agentName()} to stop this?`,
      {
        mount: (body) => body.replaceChildren(h("p", { class: "sheet-hint" }, `Sends “${words}” to ${agentName()} in this line's conversation. He stops the chat and says so.`)),
        unmount: () => {},
      },
      "Cancel",
      button("Stop it", () => {
        closeSheet();
        cmd.sendChat(words, [], [], undefined, id).then(
          (entry) => {
            flash(`Asked ${agentName()} to stop it.`);
            // The stream's copy, when it came first, keeps its status, place and deadline (as send() does).
            const had = messages.get(entry.id);
            if (alive) arrived({ id: entry.id, from: "owner", text: words, at: entry.at, status: had?.status ?? (entry.status === "collecting" ? "collecting" : "sent"), ...(had?.seq !== undefined ? { seq: had.seq } : {}), ...(had?.sendsAt ? { sendsAt: had.sendsAt } : {}), ...(had?.windowMs ? { windowMs: had.windowMs } : {}), ...(had?.keeps ? { keeps: true as const } : {}), ...(had?.windowLead ? { windowLead: had.windowLead } : {}), threadId: typeof entry.conversation === "string" ? entry.conversation : id });
          },
          (error: unknown) => {
            if (!authFail(error)) flash(describe(error), "error");
          },
        );
      }, "primary big thing-stop-go", false, "chat.more.stop-confirm"),
      { use: "stop-confirm" },
    );
  }

  type Reading = {
    line: HTMLElement | null;
    lineOffset: number;
    card: HTMLElement;
    first: string;
    thread: string;
    cardOffset: number;
    /** On an open card's foot, its lines all above the screen: where the card's bottom sits, which earlier lines landing in it leave put. */
    footOffset: number | null;
  };
  /** What he is reading: the first line, or minimised card or card foot, whose bottom is below the scroller's top, and where it and its card sit. */
  function readingAt(): Reading | null {
    if (scroller.clientHeight === 0) return null;
    const top = scroller.getBoundingClientRect().top;
    for (const card of thread.querySelectorAll<HTMLElement>(".chat-ex")) {
      const box = card.getBoundingClientRect();
      if (box.bottom <= top) continue;
      const reading: Reading = { line: null, lineOffset: 0, card, first: card.dataset.ex ?? "", thread: card.dataset.thread ?? "", cardOffset: box.top - top, footOffset: null };
      for (const line of card.querySelectorAll<HTMLElement>(".chat-msg[data-id]")) {
        const at = line.getBoundingClientRect();
        if (at.bottom > top) return { ...reading, line, lineOffset: at.top - top };
      }
      return { ...reading, footOffset: box.bottom - top };
    }
    return null;
  }

  /** Puts what he was reading back where it sat: its line, or its card when the line went into a minimised card. */
  function holdReading(reading: Reading | null): void {
    if (!reading || scroller.clientHeight === 0) return;
    const card = reading.card.isConnected
      ? reading.card
      : [...thread.querySelectorAll<HTMLElement>(".chat-ex")].find((one) => one.dataset.ex === reading.first);
    const line =
      (reading.line?.isConnected
        ? reading.line
        : reading.line && [...thread.querySelectorAll<HTMLElement>(".chat-msg[data-id]")].find((one) => one.dataset.id === reading.line!.dataset.id)) || null;
    const el = line ?? card;
    if (!el) return;
    const top = scroller.getBoundingClientRect().top;
    // On a run's foot: its bottom stays put, so the foot does not jump down by the lines landing above it.
    const foot = !line && reading.footOffset !== null;
    const delta = foot
      ? el.getBoundingClientRect().bottom - top - reading.footOffset!
      : el.getBoundingClientRect().top - top - (line ? reading.lineOffset : reading.cardOffset);
    if (Math.abs(delta) >= 1) scroller.scrollTop += delta;
  }

  /** True when it leaves the newest message on screen: stuck to the bottom, or already near it. */
  function render(stick: boolean): boolean {
    paintSend();
    // On Chat while the head's magnifier is on; a wide window's pane keeps it on top (conversations.css).
    search.el.hidden = !finding;
    // It hides the scroller, which then reads 0 everywhere: where Chat was is taken before, not measured after.
    const covers = search.active() || saved.isOpen();
    const wasCovered = section.classList.contains("searching");
    if (covers && !wasCovered && drawn && scroller.clientHeight > 0)
      covered = { held: foot.held(), top: scroller.scrollTop };
    // Results, or the Saved list, stand in for Chat's messages: nothing under them is on screen or read.
    section.classList.toggle("searching", covers);
    due.setActive(true);
    paintPlaceholder();
    tickCollect();
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
    drawn = true;
    // Nothing kept, as Chat had drawn nothing when they covered it: a hold taken under them still holds.
    const back = covers ? null :(covered ?? (wasCovered && foot.held() ? { held: true, top: 0 } : null));
    if (!covers) covered = null;
    // A line just brought up is still being scrolled to while it is lit: Chat measuring at its foot then is where the
    // scroll began, and placing it at the foot would end that scroll short of the line.
    const atBottom =
      !!back?.held || (!lit && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40);
    // Updates' seed bubble ("Updates from Rivet") went with the conversation.
    const sorted = (shown = shownLines());
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
    // Each line's place in its run, across the groups: a run of Rivet's lines may span two conversations.
    const flat = groups.flat();
    const runs = new Map<string, Run>(
      flat.map((message, at) => {
        const before = flat[at - 1];
        const after = flat[at + 1];
        return [message.id, { first: !before || !sameRun(before, message), last: !after || !sameRun(message, after) }];
      }),
    );
    if (opened && !runs.has(opened)) opened = null;
    const bubbles = groups.map((group, at) => {
      const ids = new Set(group.map((message) => message.id));
      const turns = group.map((message) => row(message, !(message.replyTo && ids.has(message.replyTo)), runs.get(message.id)!, next));
      const heading = startsChunk(group[0]!.at, groups[at - 1]?.at(-1)?.at) ? timeOf(group[0]!.at) : null;
      return exchange(group, turns, heading, nextCards);
    });
    rows = next;
    topicCards = nextCards;
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
      chatLoaded ? `Say anything to ${agentName()}.` : "Loading…",
    );
    placeChildren(thread, bubbles.length ? bubbles : [empty]);
    refocus();
    if (retryHeld && !thread.contains(document.activeElement)) handFocus();
    // Under search the scroller is hidden and measures 0 everywhere: the hold stays as the reader left it.
    if (back && !atBottom) scroller.scrollTop = back.top;
    holdReading(anchor);
    if (stick || scroller.clientHeight > 0) foot.place(stick || atBottom);
    // Under search results nothing in the conversation is on screen, whatever the hidden scroller measures.
    const showsNewest = (stick || atBottom) && !section.classList.contains("searching");
    if (showsNewest) readChat();
    earlierAtTop();
    paintNewest();
    return showsNewest;
  }

  /** Chat's lines in its order, the seed bubble left out, as render draws them. */
  function shownLines(): ChatMessage[] {
    return [...messages.values()].filter((message) => !SEED_IDS.includes(message.id)).sort(byTime);
  }

  /**
   * The ↓ shows while the newest line is more than one screen below what he reads. On it, the lines that landed since
   * he left the foot, his own left out. Covered by search or Saved, the scroller reads 0: that is no move, so the mark
   * and the count stand until Chat shows again.
   */
  function paintNewest(): void {
    const screen = scroller.clientHeight;
    if (screen === 0) return;
    const left = scroller.scrollHeight - scroller.scrollTop - screen;
    if (left < FOOT_NEAR) upFrom = null;
    else upFrom ??= shown.at(-1) ?? null;
    if (left <= screen) {
      // Hidden with the keyboard on it, it would drop to the page, where Enter answers the card (keepFocus, render).
      if (newestBtn.contains(document.activeElement)) handFocus();
      newestBtn.hidden = true;
      newestCount.hidden = true;
      newestBtn.setAttribute("aria-label", "Back to newest");
      return;
    }
    newestBtn.hidden = false;
    // From the newest back to the mark: only the lines since, not the whole thread, on every scroll.
    const mark = upFrom;
    let landed = 0;
    for (let at = shown.length - 1; at >= 0; at--) {
      const line = shown[at]!;
      if (mark && byTime(line, mark) <= 0) break;
      if (line.from !== "owner") landed++;
    }
    newestCount.hidden = landed === 0;
    newestCount.textContent = landed > 99 ? "99+" : String(landed);
    newestBtn.setAttribute("aria-label", landed ? `Back to newest, ${landed} new` : "Back to newest");
  }

  /** The ↓'s tap: a smooth scroll down to the newest line, which takes the foot's hold again as it gets there. */
  function toNewest(): void {
    // A jump's look back at its line would pull the scroll up again as it ends, and its light would keep render from
    // holding the foot it gets to.
    unsettle?.();
    window.clearTimeout(litTimer);
    lit = null;
    thread.querySelector(".chat-msg.lit")?.classList.remove("lit");
    if (stillMotion()) {
      foot.place(true);
      paintNewest();
      return;
    }
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    // Lines not drawn yet stand at a guessed height (content-visibility, command.css) and grow as the scroll passes
    // them, so it can end short of the newest: as it ends, the rest of the way at once, unless his own hand took it.
    const settle = () => {
      unsettle?.();
      if (alive && scroller.clientHeight > 0) foot.place(true);
      paintNewest();
    };
    const late = window.setTimeout(settle, JUMP_SETTLE_MS);
    const touched = () => unsettle?.();
    const his = ["pointerdown", "wheel", "touchstart", "keydown"];
    scroller.addEventListener("scrollend", settle);
    for (const kind of his) scroller.addEventListener(kind, touched, { passive: true });
    unsettle = () => {
      window.clearTimeout(late);
      scroller.removeEventListener("scrollend", settle);
      for (const kind of his) scroller.removeEventListener(kind, touched);
      unsettle = null;
    };
    paintNewest();
  }

  /**
   * At the top with earlier messages still to come, the page before loads by itself (this took the Earlier messages
   * button out); a thread too short to scroll counts as at the top. Under search nothing of it shows.
   */
  function earlierAtTop(): void {
    if (scroller.clientHeight === 0 || section.classList.contains("searching")) return;
    if (scroller.scrollTop > EARLIER_AT_PX) {
      armEarlier();
      return;
    }
    if (earlierArmed && loadingEarlier?.into !== messages && earlierMore) void loadEarlier();
  }

  /** The keyboard a Try again held when it went: the message box, or on a touch screen or with the box hidden the chat. */
  function handFocus(): void {
    if (!window.matchMedia?.("(pointer: coarse)").matches) text.focus();
    if (document.activeElement !== text) parkFocus(section);
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
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight >= 40
    )
      return;
    // A thing is read only once Chat holds its newest line and as many of Rivet's words in it as it has unread (the
    // server's count: no card lines), counted only where Chat's lines run unbroken, so its replies were on screen; never
    // when the owner marked it unread himself: that stays until he opens it.
    const loaded = [...messages.values()];
    const seen = (row: ConversationSummary) => {
      if (!row.thing) return true;
      const own = loaded.filter((message) => (message.threadId ?? message.id) === row.id);
      const words = own.filter((message) => message.at >= unbrokenFrom && message.from === "rivet" && !message.posted && !message.card).length;
      return own.some((message) => message.at >= row.lastAt) && words >= row.unread;
    };
    const rows = list.conversations.filter((row) => countsUnread(row) && readable(row) && seen(row));
    if (!rows.length) return;
    for (const row of rows) {
      row.unread = 0;
      row.markedUnread = false;
    }
    noteUnread();
    // Their cards go quiet and the bar's count goes with them now, not at the next list read: a stale "N new" left
    // Mark all read with nothing to read, so a tap did nothing. After this render, as it may be inside one.
    queueMicrotask(() => {
      if (alive) render(false);
    });
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

  /** Chat on its newest, or brought to `focus` (a search hit, a notification's line) once it loads. */
  function showRivet(focus: string | null = null): void {
    wanted = focus;
    render(true);
    void loadDetail(false, true);
  }

  /**
   * Chat's last page read, on screen until the newest comes. It is not the newest yet (chatLoaded stays false): nothing
   * is marked read from it and the newest page still sets where earlier pages start.
   */
  function seedChat(): void {
    if (chatLoaded || messages.size || !lastChat) return;
    for (const message of lastChat) if (!gone.has(message.id)) messages.set(message.id, message);
  }



  /**
   * Brings a line up in Chat, lit: a notification, a feed link or a search hit opens Chat at its line, never a page of
   * its own. With no line, or one Chat never shows (a room's seed), it is the conversation's newest line in
   * Chat; a conversation with none there opens Chat on its newest.
   */
  /**
   * Reads a way in's topic for More: its summary names an archived topic's chat (Stop it), and its app-only word
   * is what Share follows. Until a newer word lands (this read's, or the list's or stream's), and for good if
   * none does, the topic and the line's own topic (which a merge or split may have moved) count as app-only: the word
   * held from before may be out of date. Stamped, not dropped, so an older read still on its way cannot clear it.
   */
  function readTopic(conversation: string, line: string | null): Promise<ConversationDetail | null> {
    // A message id names its conversation too (a hit, an old notification): its loaded line's topic is stamped as well.
    const own = messages.get(line ?? conversation)?.threadId;
    for (const id of new Set([conversation, ...(own ? [own] : [])])) heardProject(id, true, 0, false);
    const asked = nextStamp();
    return cmd.getConversation(conversation).then((found) => {
      // Only the topic read speaks for itself: a line split or merged elsewhere waits for its own topic's word.
      if (alive && found?.conversation) {
        fetchedSummaries.set(found.id, found.conversation);
        heardProject(found.id, found.conversation.appOnly, asked);
      }
      return found ?? null;
    });
  }

  function lineNow(conversation: string, message: string | null): void {
    if (message && SEED_IDS.includes(message)) message = null;
    // A newer way in outdates an older one's read still on its way.
    const go = ++lineGen;
    wanted = null;
    heldLine = null;
    // An earlier jump's look back at its line would pull Chat up to it as this one's redraw scrolls.
    unsettle?.();
    // Quietly: a redraw now would show (and mark read) what the search stood over.
    const searching = section.classList.contains("searching");
    search.clear(true);
    setFinding(false, true);
    // The Saved list goes too, whichever way in this is (its own Go, the alarm, the due clock); quietly, as search does,
    // since it covers Chat as search does (`searching` above).
    saved.close(false, true);
    if (message && messages.has(message)) {
      if (searching) render(false);
      bringUp(message);
      // Shown from the last visit's copy: whichever newest page lands next keeps the line in view.
      if (!chatLoaded) {
        wanted = message;
        void loadDetail(false, true);
      }
      // Read even when a summary is held: whether the topic is app-only now is what More's Share follows.
      readTopic(conversation, message).catch(() => {});
      return;
    }
    // Still seeking until the line's own load starts, which outdates any refresh's load still in flight.
    seeking++;
    readTopic(conversation, message).then(
      (found) => {
        seeking--;
        if (!alive || go !== lineGen) return;
        const shows = !!found?.conversation && found.id !== TEAM_ROOM_ID && found.id !== UPDATES_ID && !found.conversation.updates;
        const newestLine = shows
          ? ((found.messages ?? [])
              .filter((one) => inChat(one) && !inRoom(one) && !gone.has(one.id) && one.status !== "cancelled" && !SEED_IDS.includes(one.id))
              .sort(byTime)
              .at(-1)?.id ?? null)
          : null;
        // A line asked for that Chat never shows (the Team room's, one gone with its conversation) is said, not passed
        // over. Updates' lines are its everyday notifications, which open Chat quietly as they always have.
        const updates = found?.id === UPDATES_ID || !!found?.conversation?.updates;
        if (message && !shows && !updates) flash(NOT_IN_CHAT, "warn");
        showRivet(shows ? (message ?? newestLine) : null);
      },
      (error: unknown) => {
        seeking--;
        if (!alive || go !== lineGen || authFail(error)) return;
        if (message) flash(error instanceof ApiError && error.status === 404 ? "That message is gone." : describe(error), "error");
        showRivet();
      },
    );
  }

  /** A message hit: its id is a conversation's id too, which the server finds it by. */
  const openHit = (id: string): void => lineNow(id, id);

  const onFullscreen = () => {
    if (document.fullscreenElement) return;
    render(false);
    // A way in's line asked for under a full-screen clip comes up now Chat draws again.
    const line = heldLine;
    heldLine = null;
    if (line) bringUp(line);
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
        if (home === null) home = listTop(response.conversations);
        list = response;
        due.refresh();
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
    // A way in since this read began owns the scroll: the page no longer sticks Chat to its bottom.
    const way = lineGen;
    const into = messages;
    return cmd.getChat(null, CHAT_PAGE, true).then(
      (page) => {
        if (!alive || ticket !== detailTicket || messages !== into) return false;
        if (!page || !Array.isArray(page.messages)) {
          return failed(!chatLoaded && !messages.size);
        }
        if (gen === appOnlyGen) appOnlyHeard = true;
        lastChat = page.messages;
        for (const [id, label] of Object.entries(page.labels ?? {})) chatLabels.set(id, label);
        refreshed();
        return showTimeline(page.messages, page.older, stick && way === lineGen);
      },
      (error: unknown) => {
        if (!alive || ticket !== detailTicket || authFail(error)) return false;
        return failed(!chatLoaded && !messages.size);
      },
    );
  }

  /**
   * Chat's newest page: it stands for everything from its oldest message on, so a message shown that it no longer holds
   * (a line that turned out to be a thing's) goes; earlier pages loaded stay. The first page replaces the last visit's
   * copy whole: what that held from before this page would sit above a gap, with Earlier loading the other side of it.
   */
  function showTimeline(read: readonly ChatMessage[], olderCursor: string | null, stick: boolean): boolean {
    const page = read.filter((message) => !gone.has(message.id));
    const from = olderCursor === null || !chatLoaded ? "" : (page[0]?.at ?? "");
    // Lines kept from before this page may sit above a gap, so they never prove a thing's replies were on screen.
    unbrokenFrom = from;
    const ids = new Set(page.map((message) => message.id));
    // A line just sent may beat its own read here, so a collecting line stays until its window is due; one gone after
    // that was cancelled elsewhere.
    const nowServer = serverNow();
    for (const [id, message] of messages)
      if (message.at >= from && !ids.has(id) &&!(message.status === "collecting" && (!message.sendsAt || Date.parse(message.sendsAt) > nowServer))) messages.delete(id);
    heardMessages(page);
    take(page);
    for (const message of page) messages.set(message.id, message);
    if (!chatLoaded) {
      earlierMore = olderCursor !== null;
      earliestPage = page[0]?.id ?? null;
    }
    chatLoaded = true;
    loadFailed = false;
    // Whichever newest page lands first (a way in's own, or the stream's) takes the line still wanted, once.
    const focus = wanted;
    wanted = null;
    const shows = render(stick && !focus);
    if (focus) {
      if (messages.has(focus)) bringUp(focus);
      else void reach(focus, lineGen);
    }
    return shows;
  }

  /**
   * Loads one page of what is on screen before the earliest loaded, keeping the messages on screen where they are.
   * True while there are earlier ones still to load.
   */
  function loadEarlier(): Promise<boolean> {
    const into = messages;
    if (loadingEarlier?.into === into) return loadingEarlier.done;
    // The server pages in its own order, which a message's time need not follow.
    const first = earliestPage;
    if (!alive || !first) return Promise.resolve(false);
    const read = cmd.getChat(first, CHAT_PAGE, true).then((page) => {
      if (!Array.isArray(page?.messages)) return null;
      for (const [id, label] of Object.entries(page.labels ?? {})) chatLabels.set(id, label);
      return { messages: page.messages, more: page.older !== null };
    });
    /** Lines this page brought that were not loaded already: none when it was a page held before. */
    let added = 0;
    const done = read.then(
      (page) => {
        if (!alive || messages !== into || !Array.isArray(page?.messages))
          return false;
        heardMessages(page.messages);
        for (const message of page.messages)
          if (!gone.has(message.id)) {
            if (!messages.has(message.id)) added += 1;
            messages.set(message.id, message);
          }
        if (hint.textContent === EARLIER_FAILED) hint.textContent = "";
        earlierMore = page.more;
        if (page.messages[0]) earliestPage = page.messages[0].id;
        // At the newest (Chat shorter than the screen on open), he stays there: held by the top card instead, lines
        // landing in a card below it would push the newest off the screen.
        const atNewest = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
        const anchor = atNewest ? null : readingAt();
        render(atNewest);
        holdReading(anchor);
        return page.more;
      },
      (error: unknown) => {
        if (messages === into) earlierArmed = false;
        if (alive && messages === into && !authFail(error))
          hint.textContent = EARLIER_FAILED;
        return false;
      },
    );
    loadingEarlier = { into, done };
    earlier.hidden = false;
    const tall = scroller.scrollHeight;
    void done.finally(() => {
      if (loadingEarlier?.done !== done) return;
      loadingEarlier = null;
      earlier.hidden = true;
      if (messages !== into) return;
      // A page whose new lines drew nothing taller (they went into minimised cards or closed main topics), or in a
      // Chat he can scroll too little to take him out of the top band, leaves him at the top: the next one waits
      // until he scrolls (or drags) away and back, so opening Chat never pulls the whole history in. A Chat shorter
      // than the screen, which cannot scroll, asks for the one before at once while each page makes it taller; a page
      // with nothing new in it (held before) goes on to the one before. Either way at most EARLIER_PAGES_MAX come by
      // themselves before a drag or scroll.
      const short = scroller.scrollHeight - scroller.clientHeight <= EARLIER_AT_PX;
      if (!seeking) earlierRun += 1;
      if (
        earliestPage === first ||
        earlierRun >= EARLIER_PAGES_MAX ||
        (added > 0 && (scroller.scrollHeight <= tall || (!short && scroller.scrollTop <= EARLIER_AT_PX)))
      )
        earlierArmed = false;
      // A search hit's loads ask for theirs themselves.
      if (alive && !seeking) earlierAtTop();
    });
    return done;
  }

  /** A search hit older than what shows: earlier pages load until it is in, then it is brought up. */
  async function reach(id: string, go: number): Promise<void> {
    const into = messages;
    seeking++;
    try {
      for (
        let pages = 0;
        messages === into && go === lineGen && !messages.has(id) && pages < REACH_PAGES_MAX;
        pages++
      )
        if (!(await loadEarlier())) break;
    } finally {
      seeking--;
    }
    // A newer way in (lineNow) outdates this one: its line is not taken back from under it.
    if (!alive || messages !== into || go !== lineGen) return;
    if (messages.has(id)) bringUp(id);
    else flash("That message is older than this shows.", "warn");
  }

  /** A message on the stream: Chat or the open thing shows it, and the badge follows. */
  function arrived(message: ChatMessage, streamed = false): void {
    // Cancelled here or on another device: its lines leave the chat, and a read already out never brings them back.
    if (message.status === "cancelled") {
      gone.add(message.id);
      cmd.heardCancelled([message.id]);
      // A reply picked on a line that is now gone has nothing to answer: every send would be refused.
      if (replyingTo?.id === message.id) setReply(null, false);
      else if (readReply()?.id === message.id) writeReply(null);
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
    const here = !inRoom(message) && inChat(message);
    bump(message, conversation, fresh, streamed);
    if (here) {
      const known = messages.has(message.id);
      messages.set(message.id, message);
      render(!known && message.from === "owner");
    }
    void loadDetail(true);
    take([message]);
    void loadList(true);
  }

  /** A conversation's row takes its newest line, unread while Rivet spoke, so the badge moves before the list is read again. */
  function bump(message: ChatMessage, id: string, fresh: boolean, streamed: boolean): void {
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

  /** Speaks, oldest first, the Rivet messages not heard before and not older than the home; the first load only sets it. */
  function take(found: readonly ChatMessage[]): void {
    if (home === null) return baseline(found);
    // Strictly newer: the home can come from the list, which names no message, and its newest is history already.
    const fresh = found.filter(
      (message) =>
        message.from === "rivet" &&
        !inRoom(message) &&
        !message.posted &&
        !heard.has(message.id) &&
        message.at > home!,
    );
    for (const message of [...fresh].sort(byTime)) {
      heard.add(message.id);
      if (readSpeak()) say(message.text);
    }
  }

  /** What is on screen counts as heard, and the home rises to its newest message. */
  function baseline(found: readonly ChatMessage[]): void {
    for (const message of found) {
      if (message.from === "rivet") heard.add(message.id);
      if (home === null || message.at > home) home = message.at;
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

  /** A search hit: Chat brought to that message. */
  function seek(): void {
    const id = app.chatFocus;
    if (!id || !alive) return;
    app.chatFocus = null;
    openHit(id);
  }

  function send(): void {
    voice?.stop();
    void sendNow();
  }

  async function sendNow(): Promise<void> {
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
    const sentBox = draftBox;
    const sentRev = readDraft().trim() === body ? readDraftRev() : null;
    const sentDraft = draftLineage.begin(sentRev);
    try {
      const entry = await cmd.sendChat(
        body,
        images,
        files,
        target?.id,
        null,
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
      // Its answer names no thread for a Reply (it was typed in none); the server put it in the replied line's.
      const replied = target ? messages.get(target.id) : undefined;
      const id =
        typeof entry.conversation === "string"
          ? entry.conversation
          : (replied ? threadOf(replied) : entry.id);
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
        // And its window's own Send delay, which the countdown bar drains from.
        ...(messages.get(entry.id)?.windowMs ? { windowMs: messages.get(entry.id)!.windowMs } : {}),
        // A Feed Fix it window's mark (no Cancel) and the window's lead, which the stream knows first.
        ...(messages.get(entry.id)?.keeps ? { keeps: true as const } : {}),
        ...(messages.get(entry.id)?.windowLead ? { windowLead: messages.get(entry.id)!.windowLead } : {}),
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
        arrived(message, true);
      } catch {}
    });
    source.addEventListener("ping", streamHeard);
    // A line saved or unsaved, here or on another device: the marks and an open list follow.
    source.addEventListener("saved", (event) => {
      streamHeard();
      try {
        const { ids } = JSON.parse((event as MessageEvent<string>).data) as { ids?: unknown };
        if (Array.isArray(ids)) saved.heard(ids.filter((id): id is string => typeof id === "string"));
      } catch {}
    });
    // Rivet Cloud's machine is going to sleep: no reconnect to wake it until the next tap (rivet-sleep.ts).
    source.addEventListener("asleep", () => {
      fellAsleep();
      window.clearTimeout(idle);
      source.close();
      if (stream === source) stream = null;
    });
    // The owner's rename, Close or read marker, from this device or another.
    source.addEventListener("conversation", (event) => {
      streamHeard();
      try {
        const changedId = (
          JSON.parse((event as MessageEvent<string>).data) as { id?: unknown }
        ).id;
        if (typeof changedId !== "string") return;
        void loadList(true);
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
        // At once: a conversation just moved to personal loses its Share buttons before anything is fetched.
        render(false);
      } catch {}
    });
    source.addEventListener("open", () => {
      streamHeard();
      forgetAppOnly();
      // Catches up on what was missed while it was down.
      void loadList(true);
      void loadDetail();
      saved.load();
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

  /** A conversation may move to personal while the stream is down: no Share until a read asked for after this lands. */
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
      saved.load();
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
      const line = heldLine;
      heldLine = null;
      // One gone meanwhile is said, as bringUp says it.
      if (line) bringUp(line);
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
    paintName();
  });
  seek();
  goLine = (conversation, message) => lineNow(conversation, message);
  if (pendingLine) {
    const line = pendingLine;
    pendingLine = null;
    lineNow(line.conversation, line.message);
  }
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
    readChat();
    // Hidden, the stream's pings would keep the phone's radio waking; back in front, a fresh one catches up as it opens.
    if (document.visibilityState === "hidden") {
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
    if (wasCovered && !now) readChat();
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
    goLine = null;
    liveRefusal = null;
    unfocus();
    unboard();
    closeMenu();
    unsettle?.();
    window.clearTimeout(litTimer);
    window.clearTimeout(listTimer);
    window.clearTimeout(detailTimer);
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
