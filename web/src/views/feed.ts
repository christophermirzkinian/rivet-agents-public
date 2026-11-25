import "./feed.css";

import { chatName } from "../../../src/shared/names.js";
import { ASKED_LABEL, DONE_CARD, DONE_LABEL, doneCardParts, YOU_ASKED_LABEL } from "../../../src/shared/asks.js";
import { MAX_SHORT, type Decision, type Reply, type ServedNeed } from "../../../src/shared/board.js";
import { chatImages, imageFields } from "../../../src/shared/command.js";
import { armsMerge, canApprove, isGotIt, isPlan, isTodo, isUpdate, MERGE_READY, optionNeedsText, stepsOf, threadKey, wantsText } from "../../../src/shared/answers.js";
import { isToday, maybeWhen, when } from "../../../src/shared/when.js";
import { NOTHING_NEEDS_YOU } from "../../../src/shared/words.js";
import * as api from "../api.js";
import { agentName, needsPlan } from "../cloud-agent.js";
import { isDesk, pressesControl, typing } from "../desk.js";
import { stopDictation, withMic } from "../dictation.js";
import { button, type Child, describe, h, ICONS, isHttps, linkify, linksIn, modalOpen, svg } from "../dom.js";
import {
  answerKey,
  classifyFailure,
  clientIdFor,
  proofOf,
  isTap,
  needsConfirm,
  UNDO_MS,
  UndoQueue,
  type Action,
  type Answer,
} from "../feed-logic.js";
import { freshPrs, opsData } from "../ops-data.js";
import * as outbox from "../outbox.js";
import { setSignedInByCode, signedInByCode, StaleSession } from "../session.js";
import {
  app,
  cardState,
  changed,
  closeAnsweredCards,
  go,
  deck,
  frontCard,
  isMinimised,
  macOffline,
  navigated,
  navStamp,
  refresh as refreshBoard,
  saveLater,
  saveMinimised,
  signedOut,
  unminimise,
  updateCards,
  replyLanded,
  type CardState,
} from "../state.js";
import { dropPhotos, photosControl, photosHold, photosPayload, restorePhotos } from "./attach.js";
import { mergedReopen, reopenBand } from "./answered.js";
import { cardAnswered, useTap } from "../usage.js";
import { sending } from "./mac-wait.js";
import { planLocks } from "./plan-lock.js";
import { cardMedia, cardStage, stopCardMedia } from "./card-media.js";
import { cardShareButton } from "./card-share.js";
import { showLine } from "./chat.js";
import { rivet } from "../rivet/rivet.js";
import { decideUp } from "./decide-sheet.js";
import { closeLightbox } from "./lightbox.js";
import { leaveOverlays } from "./navigation.js";
import { TYPED } from "../rivet-words.js";
import { clearWords } from "./progress-mark.js";
import { closeSheet, openSheet } from "./sheet.js";
import { clearUndo, flash, showUndo } from "./toast.js";
import { closeWorkerSheet, openChatSheet } from "./worker-sheet.js";

interface Held {
  key: string;
  need: ServedNeed;
  /** null for Later, which sends nothing. */
  answer: Answer | null;
  /** The rest of a thread's pile, Seen with this card in one tap and one Undo. */
  rest?: { need: ServedNeed; answer: Answer }[];
  confirm: boolean;
  verb: string;
  tone: "yes" | "no" | "note" | "later";
  /** When its undo window ends (ms since the epoch). */
  until: number;
}

/** After an answer the next card's buttons ignore taps this long, so a double tap answers one card. */
export const TAP_LOCK_MS = 450;

const KINDS = new Set(["approval", "decision", "question", "todo", "merge-ready", "plan"]);

const kindClass = (kind: string): string => (KINDS.has(kind) ? `k-${kind}` : "k-other");

/** The ask's first line, which stands in the picture's place on a card without one. */
function askLine(ask: string | undefined): string | null {
  const line = ask?.split(/\n/).find((part) => part.trim())?.trim();
  return line || null;
}

const queue = new UndoQueue<Held>();
/** Cards' two segments: the deck and today's answers. */
type Segment = "needs" | "done";
/** The segment the owner picked; null opens on Needs you. */
let segment: Segment | null = null;
/**
 * the owner's opens in the Feed (a card, Undo) and an answer sent back to him, so a card read
 * for late never lands over a later one.
 */
let opens = 0;
/** The cards the last render showed, and those this one shows: only a card new to the Feed slides in. */
let shownCards = new Set<string>();
let showingCards = new Set<string>();
/** Answer keys pressed and not yet released: one press answers one card. */
const keysDown = new Set<string>();
let heldSeq = 0;
let recoveryDue = true;
let tapLock: ReturnType<typeof setTimeout> | null = null;
/** A poll arrived while the Feed could not re-render; render once it can. */
let dirty = false;

/**
 * Forgets everything tied to the previous signed-in session. An answer still in
 * its undo window goes to the outbox and is sent after the next sign-in.
 */
export function resetFeed(): void {
  cheerAt = 0;
  clearTimeout(cheerTimer);
  for (const entry of queue.drain()) {
    if (entry.answer) park(entry.need, entry.answer, entry.confirm);
    for (const other of entry.rest ?? []) park(other.need, other.answer, false);
  }
  unlockTaps();
  closeLightbox();
  stopCardMedia(true);
  dirty = false;
  segment = null;
  for (const card of app.cards.values()) dropPhotos(card.attach);
  shownCards = new Set();
  showingCards = new Set();
  keysDown.clear();
  recoveryDue = true;
}

const VERBS: Record<Decision, string> = { approve: "Approved", reject: "Rejected", choice: "Chose", comment: "Comment", done: "Done", seen: "Seen", dismiss: "Dismissed" };

/** Names a control for keepFocus by what it answers, not by the words it shows. */
function keyed<T extends HTMLElement>(element: T, key: string): T {
  element.dataset.key = key;
  return element;
}

function lockTaps(): void {
  if (tapLock !== null) clearTimeout(tapLock);
  tapLock = setTimeout(unlockTaps, TAP_LOCK_MS);
}

function unlockTaps(): void {
  if (tapLock !== null) clearTimeout(tapLock);
  tapLock = null;
}

/** No network, or the last refresh failed (no answer, a server error or a 429): the cards shown are as of the last load. */
export function offlineBar(): HTMLElement | null {
  if (!app.offline && !app.notice) return null;
  const asOf = app.loadedAt === null ? "no cards loaded yet" : `cards as of ${when(app.loadedAt)}`;
  return h(
    "div",
    { class: "feed-offline", attrs: { role: "status" } },
    h("span", { class: "feed-offline-t" }, `${app.offline === "offline" ? "Offline" : `Can't reach ${agentName()}`} · ${asOf}`),
    button("Retry", () => void refresh(), "feed-retry", false, "cards.offline.retry"),
  );
}

/**
 * A card's link: one to a page of this app that names only its tab (`/?tab=`, the Morning card's What you used) opens it
 * here, not in a tab. One naming more (a conversation, a thread) opens as before, for main.ts to read it all.
 */
function cardLink(link: { label: string; url: string; primary?: boolean }): HTMLElement {
  const url = new URL(link.url);
  const tab = url.origin === location.origin && url.pathname === "/" && !url.hash && [...url.searchParams.keys()].join() === "tab" ? url.searchParams.get("tab") : null;
  const open = (event: Event) => {
    event.preventDefault();
    leaveOverlays(() => {
      go(tab!);
      changed();
    });
  };
  return h(
    "a",
    { class: link.primary ? "card-link primary" : "card-link", attrs: { href: link.url, ...(tab ? {} : { target: "_blank", rel: "noopener noreferrer" }), "data-use": "cards.link" }, ...(tab ? { on: { click: open } } : {}) },
    link.label,
  );
}

/** A choice detail's links, under its button: tapping one opens it and never answers the card. */
function choiceLinks(detail: string | undefined): HTMLElement | null {
  const links = detail ? linksIn(detail) : [];
  return links.length ? h("p", { class: "choice-links", attrs: { "data-use": "cards.choice-link" } }, ...links) : null;
}

/**
 * The open card. Its option boxes are the answer buttons, one list (no second row of the same
 * answers under the card); its head keeps the risk tag and the conversation link, not the kind word or the count left.
 */
function topCard(need: ServedNeed, minimisable = false, sheet = false): HTMLElement {
  const card = cardState(need.id);
  if (card.confirm && card.confirm.rev !== need.rev) {
    card.confirm = null;
    card.error = "This card changed; look again.";
  }
  if (card.confirm && shutLine(need, card.confirm.decision, card.confirm.choice)) card.confirm = null;
  const todo = isTodo(need);
  const place = todoPlace(need);
  const links = (need.links ?? []).filter((link) => isHttps(link.url) && link !== place);
  const options = todo ? [] : (need.options ?? []);
  // On the computer the bar under the card answers it, so the card lists its answers only where the bar cannot.
  const listed = options.length > 0 && !(isDesk() && barHoldsAll(options));
  const ask = todo ? askLine(need.ask) : need.ask;
  const steps = stepsOf(need);
  // The grey line names only the chat and the card's age.
  const meta = need.chat ? chatName(need.chat) : "";
  const since = maybeWhen(need.since);
  const thread = app.cardThreads.get(need.id);
  const rec = (option: (typeof options)[number]) => !!option.recommended;
  // In the phone's Decide sheet the card fills it: its tools are in the sheet's ⋯ menu (cardMenu), its grey line leads,
  // its media is a stage, and its answers are the card's last thing over the say-line.
  const phone = sheet;
  const points = phone && !todo && ask ? askPoints(ask) : null;
  // A card answered in its chat shows its words as they are (inChatSchema).
  const exact: Record<string, string> = need.inChat ? { [TYPED]: "" } : {};
  const askText = need.inChat ? (ask ? h("p", { class: "card-ask ask-exact", attrs: exact }, ask) : null) : (!todo && ask && isGotIt(need) && DONE_CARD.test(need.id) ? doneAsk(ask) : null) ?? points ?? (ask ? h("p", { class: todo ? "card-ask todo-ask" : "card-ask" }, ...linkify(ask)) : null);
  const metaLine = meta || since ? h("p", { class: "card-meta" }, meta, meta && since ? " · " : null, since ? h("span", { attrs: { "data-age": need.since! } }, since) : null) : null;
  const kindChip = isPlan(need) ? h("span", { class: "card-kind plan" }, need.chat ? `Plan · ${chatName(need.chat).replace(/-/g, " ")}` : "Plan") : need.inChat ? h("span", { class: "card-kind in-chat", attrs: exact }, need.inChat.label) : null;
  const riskChip = need.risk ? h("span", { class: "chip risk" }, `${need.risk} change`) : null;
  const others = options.filter((option) => !yellowAnswer(need, option));
  // Short answers with no detail line sit two to a row under the yellow one; any longer one stacks them all, as does a
  // links line under any answer (it would take a cell of the pairs).
  const paired =
    phone &&
    others.length >= 2 &&
    others.every((option) => !option.detail && option.label.length <= PAIR_LABEL) &&
    !options.some((option) => option.detail && linksIn(option.detail).length);
  const wide = paired && others.length % 2 ? others.at(-1) : undefined;
  const element = h(
    "article",
    {
      class: `card box top ${kindClass(need.kind)}${need.risk ? " risky" : ""}${shownCards.has(need.id) ? "" : " entering"}`,
      attrs: { "data-need": need.id, "data-rev": need.rev, "aria-label": need.title },
    },
    phone
      ? null
      : h(
          "div",
          { class: "card-head" },
          // Every card is Rivet asking you something: his ? face heads it.
          rivet("asking", { size: 30, className: "card-rivet" }),
          kindChip,
          riskChip,
          thread
            ? h(
                "button",
                {
                  class: "card-thread",
                  attrs: { type: "button", "aria-label": `Round ${thread.round} of the conversation ${thread.title}. Open the conversation.`, "data-use": "cards.thread.open" },
                  on: { click: () => openConversation(thread.thread) },
                },
                `Round ${thread.round} · ${thread.title}`,
              )
            : null,
          h("div", { class: "head-tools" }, minimisable ? minimiseButton(need, "top") : null, isUpdate(need) ? null : rejectButton(need)),
        ),
    h(
      "div",
      { class: need.media ? "card-body with-media" : "card-body" },
      reopenBand(need),
      phone && (kindChip || riskChip) ? h("p", { class: "card-tags" }, kindChip, riskChip) : null,
      // The owner reads what a card is about, and what it asks, before who sent it or its photos or clip.
      h("h2", { class: "card-title", attrs: exact }, need.title),
      askText,
      ...planPoints(need),
      metaLine,
      ...(need.media ? (phone ? cardStage(need.id, need.media, need.title) : [cardMedia(need.id, need.media, need.title)]) : []),
      todo && steps.length ? h("ol", { class: "todo-steps" }, ...steps.map((step) => h("li", {}, ...linkify(step)))) : null,
      proofBlock(need),
      links.length
        ? h(
            "div",
            { class: "card-links" },
            ...links.map(cardLink),
          )
        : null,
      ...(isUpdate(need) ? (need.comments ?? []) : []).map((note) =>
        h("p", { class: note.from === "rivet" ? "upd-note h" : "upd-note" }, h("b", {}, note.from === "rivet" ? `${agentName()}: ` : "You: "), ...linkify(note.text)),
      ),
      listed && !phone
        ? h(
            "p",
            { class: "choices-cap" },
            h("span", {}, "Pick one answer"),
            isDesk() ? h("span", { class: "cap-key" }, options.length > 1 ? `keys 1–${Math.min(options.length, 9)}` : "key 1") : null,
          )
        : null,
      listed
        ? h(
            "div",
            { class: paired ? "choices paired" : "choices" },
            ...options.flatMap((option, index) => [
              // The answer names the button, so a redraw keeps the keyboard on this answer (dom.ts keepFocus).
              ...(shutOption(need, options, index) ?? [keyed(
                sending(button(
                phone
                  ? [
                      h("span", { class: "choice-text" }, h("span", { class: "choice-label", attrs: exact }, rec(option) ? option.label.replace(SAID_RECOMMENDED, "") : option.label), option.detail ? h("span", { class: "choice-detail" }, option.detail) : null),
                      rec(option) ? h("span", { class: "choice-rec choice-tag" }, "Recommended") : null,
                    ]
                  : [
                      isDesk() && index < 9 ? h("kbd", { class: "key choice-key" }, String(index + 1)) : null,
                      rec(option) ? h("span", { class: "choice-top" }, h("span", { class: "choice-rec" }, "Recommended")) : null,
                      h("span", { class: "choice-label", attrs: exact }, option.label),
                      option.detail ? h("span", { class: "choice-detail" }, option.detail) : null,
                    ],
                () => decide(need, "choice", option.label),
                `${yellowAnswer(need, option) ? "choice rec" : "choice"}${option === wide ? " wide" : ""}`,
                false,
                "cards.answer.choice",
                index + 1,
                )),
                option.label,
              )]),
              choiceLinks(option.detail),
            ]),
          )
        : null,
      card.error ? h("p", { class: "card-error box", attrs: { role: "alert" } }, card.error) : null,
      phone ? null : h("div", { class: "card-tools" }, messageButton(need, `Message ${agentName()}`), keyed(cardShareButton(need, "card-share-top"), `share-${need.id}`), minimisable ? minimiseButton(need, "bottom") : null),
    ),
    h("div", { class: "more-cue", attrs: { "aria-hidden": "true" } }, "More ↓"),
    card.confirm ? confirmOverlay(need, card) : null,
  );
  showingCards.add(need.id);
  return element;
}

/** What stands behind a merge, as the chat wrote it. */
function proofBlock(need: ServedNeed): HTMLElement | null {
  const named = need.pr && opsData.ops ? (freshPrs(opsData.ops) ?? []).filter((row) => row.number === need.pr) : [];
  const pr = need.repo ? named.find((row) => row.repo === need.repo) : named.length === 1 ? named[0] : undefined;
  const lines = proofOf(need, pr);
  if (!lines.length) return null;
  return h(
    "ul",
    { class: "card-proof", attrs: { "aria-label": "Proof", "data-proof-card": need.id } },
    ...lines.map((line) => h("li", { class: `proof-line ${line.tone}`, attrs: { "data-proof": line.key } }, line.text)),
  );
}

// Minimised cards

function setMinimised(key: string, rev: string, small: boolean): void {
  saveMinimised(key, rev, small);
  // Opened again, a card put as Later counts again too.
  if (!small && app.later.delete(key)) saveLater();
  // A focused say-line holds every render (renderFeed), and its words stay on the card for when it opens.
  leaveText();
  changed();
}

/** Message Rivet in the card's chat; `word` is what it says, its name is always the whole of it. */
function messageButton(need: ServedNeed, word: string): HTMLElement | null {
  if (!need.chat) return null;
  const message = button([svg(ICONS.note, "card-message-icon"), h("span", { class: "card-message-word" }, word)], () => messageChat(need), "card-message", false, "cards.message-rivet");
  message.setAttribute("aria-label", `Message ${agentName()}`);
  return message;
}

/** A recording in the say-line is written down first: closing its box would drop the words (dictation.ts). */
function minimise(need: ServedNeed): void {
  afterVoice(() => {
    cardAnswered(need, "minimise");
    setMinimised(need.id, need.rev, true);
  });
}

function minimiseButton(need: ServedNeed, where: "top" | "bottom"): HTMLElement {
  // A "−" alone, no word; its name and tooltip still say Minimise.
  const small = keyed(button("−", () => minimise(need), `min-btn ${where}`, false, "cards.minimise"), `min-${where}-${need.id}`);
  small.setAttribute("aria-label", `Minimise ${need.title}`);
  small.title = "Minimise";
  return small;
}

/** The phone Decide sheet's ⋯ menu rows for the open card: the tools its head held, each doing what that tool did. */
export function cardMenu(need: ServedNeed): HTMLElement[] {
  const thread = app.cardThreads.get(need.id);
  const row = (icon: string, word: string, then: () => void, use: string, variant = "", aside?: string) =>
    button([svg(icon, "menu-icon"), h("span", { class: "menu-word" }, word), aside ? h("small", { class: "menu-aside" }, aside) : null], then, `decide-menu-row ${variant}`.trim(), false, use);
  const message = messageButton(need, `Message ${agentName()}`);
  message?.classList.add("decide-menu-row");
  return [
    message,
    cardShareButton(need, "decide-menu-row"),
    thread ? row(ICONS.list, "Conversation", () => openConversation(thread.thread), "cards.thread.open", "menu-thread", `Round ${thread.round}`) : null,
    // The next card slides in under the menu's foot, where its answers sit: a second tap is held, as after an answer.
    row(MINUS, "Put it aside", () => (lockTaps(), minimise(need)), "cards.minimise", "menu-aside-card"),
    // An update takes only Seen or words (http.ts), so it has no Reject.
    isUpdate(need) ? null : row(ICONS.no, "Reject, and say why", () => act(need, "reject"), "cards.reject", "menu-reject"),
  ].filter((one) => one !== null);
}

/** A done card's text as two labelled parts: what the owner asked, then what is done (one line, or up to three points). */
function doneAsk(ask: string): HTMLElement | null {
  const parts = doneCardParts(ask);
  if (!parts) return null;
  const label = (text: string) => h("span", { class: "done-label" }, text.replace(/:$/, ""));
  const [only, ...more] = parts.done;
  return h(
    "div",
    { class: "card-ask done-ask" },
    h("p", { class: "done-part" }, label(parts.own ? YOU_ASKED_LABEL : ASKED_LABEL), h("span", {}, ...linkify(parts.asked))),
    only === undefined
      ? null
      : h("div", { class: "done-part" }, label(DONE_LABEL), more.length ? h("ul", { class: "done-points" }, ...parts.done.map((item) => h("li", {}, ...linkify(item)))) : h("span", {}, ...linkify(only))),
  );
}

const MINUS ='<svg viewBox="0 0 24 24"><path d="M6 12h12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

/** A phone card's ask written as "- " lines is its points, one to a line. */
const POINT = /^\s*[-•*]\s+/;
function askPoints(ask: string): HTMLElement | null {
  const lines = ask.split("\n").filter((line) => line.trim());
  if (!lines.length || !lines.every((line) => POINT.test(line))) return null;
  return h("ul", { class: "card-ask ask-points" }, ...lines.map((line) => h("li", {}, ...linkify(line.replace(POINT, "")))));
}

/** The longest answer label that still pairs two to a row on a narrow phone screen. */
const PAIR_LABEL = 14;
/** A label's own "(Recommended)", which the phone's yellow answer says once in its tag. */
const SAID_RECOMMENDED = /\s*\(recommended\)\s*$/i;

/** The X at a card's top right rejects it, always asking why first. */
function rejectButton(need: ServedNeed): HTMLElement {
  const reject = keyed(button(svg(ICONS.no, "x-icon"), () => act(need, "reject"), "x-btn", false, "cards.reject"), `reject-${need.id}`);
  reject.setAttribute("aria-label", `Reject ${need.title}`);
  reject.title = "Reject";
  return reject;
}

/**
 * Why a card is rejected, in the owner's words: it opens
 * with the say-line's words, and Reject files them as the card's words, as a Comment does, with its photos and Undo.
 * Cancel leaves the card and its say-line as they were.
 */
/** The reject popup is open: an Agents ticket's Escape and Back close it first (closeAnswerSheet). */
let rejectOpen = false;

function openRejectSheet(need: ServedNeed): void {
  const card = cardState(need.id);
  const area = h("textarea", {
    class: "sheet-text",
    attrs: { rows: "4", maxlength: "4000", placeholder: "Say why, or tap the mic…", "aria-label": "Why you are rejecting" },
  });
  area.value = card.text;
  const send = () =>
    afterVoice(() => {
      if (!area.value.trim()) return area.focus();
      // A photo still uploading or failed keeps the popup, and his words in it, open: decide would refuse it anyway.
      const held = photosHold(card.attach.photos);
      if (held) return flash(held, "warn");
      closeSheet();
      card.text = area.value;
      decide(need, "reject");
    });
  const reject = button([svg(ICONS.no, "btn-icon"), "Reject"], send, "danger reject-send", !area.value.trim(), "cards.reject.send");
  area.addEventListener("input", () => (reject.disabled = !area.value.trim()));
  area.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    if (reject.disabled) return;
    useTap("cards.reject.send");
    send();
  });
  const field = withMic(area);
  const fields = [
    h("p", { class: "sheet-where" }, need.title),
    field,
    planLocks(area, null, reject),
    h("p", { class: "sheet-hint" }, "Goes to the card's chat as your words, with the reject."),
    isDesk() ? h("p", { class: "sheet-keys" }, h("span", {}, kbd("⌘↵"), "reject"), h("span", {}, kbd("Esc"), "cancel")) : null,
  ];
  openSheet(
    "Why reject?",
    {
      mount: (el) => el.replaceChildren(...fields.filter((field) => field !== null)),
      unmount: () => {
        rejectOpen = false;
        stopDictation();
      },
    },
    "Cancel",
    reject,
    { className: "reject-sheet", mark: svg(ICONS.no, "reject-mark"), cancelFirst: true, use: "reject", closeUse: "cards.reject.cancel" },
  );
  rejectOpen = true;
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

/** A minimised card's one line: its title (and what sits beside it), a tap opens the card again. */
function minimisedLine(key: string, rev: string, title: Child, aside: Child[] = []): HTMLElement {
  return keyed(
    h(
      "button",
      { class: "min-open", attrs: { type: "button", "aria-expanded": "false", "data-use": "cards.min-open" }, on: { click: () => setMinimised(key, rev, false) } },
      h("span", { class: "min-title" }, title),
      ...aside,
      svg(ICONS.forward, "min-chev"),
    ),
    `min-open-${key}`,
  );
}

/** The open card minimised to its title line: no body, no answers. */
function minimisedCard(need: ServedNeed): HTMLElement {
  showingCards.add(need.id);
  return h(
    "article",
    {
      class: `card box top minimised ${kindClass(need.kind)}${need.risk ? " risky" : ""}`,
      attrs: { "data-need": need.id, "data-rev": need.rev, "data-min": need.id, "aria-label": need.title },
    },
    minimisedLine(need.id, need.rev, need.title),
  );
}

/** A plan card's dot points, then its size and ETA as chips. */
function planPoints(need: ServedNeed): HTMLElement[] {
  if (!isPlan(need)) return [];
  const chips = [need.size ? h("span", { class: "plan-chip" }, h("b", {}, `Size ${need.size}`)) : null, need.eta ? h("span", { class: "plan-chip" }, "ETA ", h("b", {}, need.eta)) : null].filter((chip) => chip !== null);
  return [
    ...(need.points?.length ? [h("ul", { class: "plan-points" }, ...need.points.map((point) => h("li", {}, ...linkify(point))))] : []),
    ...(chips.length ? [h("p", { class: "plan-chips" }, ...chips)] : []),
  ];
}

// Updates

/**
 * What an update card's Seen clears: the card, then its thread's other new cards of local's today, as Done today
 * lists them, so one tap says Seen all N.
 */
function seenTogether(need: ServedNeed): ServedNeed[] {
  const now = Date.now();
  const open = new Set(updateCards().map((one) => one.id));
  const rest = threadUpdates(threadKey(need.thread)).filter((one) => one.id !== need.id && one.since !== undefined && isToday(one.since, now) && open.has(one.id) && !app.held.has(one.id));
  return [need, ...rest];
}

function seenButton(need: ServedNeed, className: string): HTMLElement {
  const cards = seenTogether(need);
  // A typed note holds the redraw (decide-sheet.ts paint), so the tap marks only the cards this button counted.
  const shown = new Set(cards.map((one) => one.id));
  return sending(button([svg(ICONS.yes, "btn-icon"), cards.length > 1 ? `Seen all ${cards.length}` : "Seen"], () => seenPile(seenTogether(need).filter((one) => shown.has(one.id))), className, false, "updates.pile.seen"));
}

/** A thread's update cards on the board, seen ones too, newest first. */
function threadUpdates(key: string): ServedNeed[] {
  const since = (need: ServedNeed) => {
    const at = need.since ? Date.parse(need.since) : NaN;
    return Number.isFinite(at) ? at : -Infinity;
  };
  return (app.board?.board?.needs ?? [])
    .map((need, index) => ({ need, index }))
    .filter(({ need }) => isUpdate(need) && threadKey(need.thread) === key)
    .sort((a, b) => since(b.need) - since(a.need) || b.index - a.index)
    .map(({ need }) => need);
}

/** Seen on a thread: one tap, one Undo, a Seen for each of its new cards. */
function seenPile(cards: readonly ServedNeed[]): void {
  const [top, ...rest] = cards as [ServedNeed, ...ServedNeed[]];
  if (!rest.length) return decide(top, "seen");
  if (app.front === top.id) app.front = null;
  const answer = (need: ServedNeed): Answer => ({ itemId: need.id, decision: "seen", rev: need.rev });
  for (const need of cards) {
    app.held.add(need.id);
    cardState(need.id).error = null;
    cardAnswered(need, "seen");
  }
  hold({ need: top, answer: answer(top), rest: rest.map((need) => ({ need, answer: answer(need) })), confirm: false, verb: `Seen all ${cards.length}`, tone: "yes" });
}

export function openConversation(id: string): void {
  leaveOverlays(() => {
    showLine(id);
    app.tab = "chat";
    changed();
  });
}

/** A todo card's primary link, else its first: the place its steps happen. */
function todoPlace(need: ServedNeed): NonNullable<ServedNeed["links"]>[number] | undefined {
  if (!isTodo(need)) return undefined;
  const links = (need.links ?? []).filter((link) => isHttps(link.url));
  return links.find((link) => link.primary) ?? links[0];
}

/** The Open button sits with Done, outside the scrolling card, so the fade over a long card never dims it. */
function todoOpen(need: ServedNeed): HTMLElement | null {
  const place = todoPlace(need);
  return place ? h("a", { class: "todo-open", attrs: { href: place.url, target: "_blank", rel: "noopener noreferrer", "data-use": "cards.todo.open" } }, `Open ${place.label}`) : null;
}

/** The card's chat in the same sheet the Floor opens; one not live on the Mac answers that when a message is sent. */
function messageChat(need: ServedNeed): void {
  openChat(need.chat!, need.repo, `card-${need.id}`, need.pr);
}

function openChat(chat: string, repo: string | undefined, id: string, pr?: number): void {
  openChatSheet(chat, repo, id, "feed", pr);
}

/** Opens the cards: Decide on Open, a wide window's middle pane or a phone's sheet. */
export function showList(): void {
  segment = "needs";
  app.tab = "cards";
  leaveText();
  changed();
}

/** Who is at work: the desks on Progress (the status line's chats part). */
export function showChats(): void {
  app.tab = "progress";
  changed();
}

export const cardsSegment = (): Segment => segment ?? "needs";
export const setCardsSegment = (next: Segment): void => void (segment = next);

/** Opens Cards on Needs you (the desks' need-you button) or on Answered (a search hit for an answer). */
export function showSegment(next: Segment): void {
  pickSegment(next);
  changed();
}

/** Decide on `next`, as showSegment, for a caller that opens the sheet itself (the home screen's dock). */
export function pickSegment(next: Segment): void {
  segment = next;
  app.tab = "cards";
  navigated();
  leaveText();
}

/**
 * Opens a card on top of the Feed, scrolled back up to it on a phone however far down the lists it was left. `picked`:
 * The owner opened it on purpose, so a minimised card opens in full; a sign-in reopening the card it left keeps it small.
 */
export function showCard(id: string, picked = true): void {
  leaveOverlays(() => showCardNow(id, picked));
}

/** Cards asked for that the board is being read again to find: the cheer's end leaves Decide up for them. */
let cardsOnTheirWay = 0;
export const cardOnItsWay = () => cardsOnTheirWay > 0;

function showCardNow(id: string, picked: boolean): void {
  const mine = ++opens;
  frontCard(id);
  if (picked) unminimise(id);
  segment = "needs";
  app.tab = "cards";
  navigated();
  // A box with the keyboard holds renders; going to another card leaves it, its words kept on its own card.
  leaveText();
  changed();
  // A card added a moment ago (its notification, its line in a chat) may not be on the board this app last read: read
  // it again and go to it, unless the owner has moved on meanwhile (another tab, another card).
  if (!app.board?.board?.needs.some((need) => need.id === id)) {
    const stamp = navStamp();
    cardsOnTheirWay++;
    void refreshBoard().finally(() => cardsOnTheirWay--).then(() => {
      if (navStamp() === stamp && opens === mine && app.board?.board?.needs.some((need) => need.id === id)) showCard(id, picked);
    });
  }
}

function confirmOverlay(need: ServedNeed, card: CardState): HTMLElement {
  const { decision, choice, rev } = card.confirm!;
  return h(
    "div",
    { class: "confirm", attrs: { role: "alertdialog", "aria-label": `Confirm a ${need.risk} change` } },
    h("p", { class: "confirm-risk" }, `${need.risk} change`),
    h("p", { class: "confirm-q" }, decision === "choice" ? `Choose “${choice ?? ""}”?` : `${yesLabel(need)} this?`),
    h("p", { class: "confirm-title" }, need.title),
    sending(button("Yes, confirm", () => decide(need, decision, choice, rev), "danger big", false, "cards.confirm.yes")),
    button(
      "Cancel",
      () => {
        card.confirm = null;
        changed();
      },
      "ghost big",
      false,
      "cards.confirm.cancel",
    ),
  );
}

/**
 * Whether an answer's label, which the bar shows, is longer than a short (a label is up to 200 characters): wrapped
 * whole in the bar it would push the card off the screen, so the bar then takes the owner to the card's own list instead
 *.
 */
function tooLong(options: NonNullable<ServedNeed["options"]>): boolean {
  return options.some((option) => option.label.length > MAX_SHORT);
}

/** The longest detail the bar shows whole, as a second line in its answer's button. */
const BAR_DETAIL = 80;

/**
 * The desktop bar shows every answer whole, so it is the one set on screen at 1280×800: four at most, each label short,
 * each detail short and with no link (a button cannot hold one).
 */
function barHoldsAll(options: NonNullable<ServedNeed["options"]>): boolean {
  return options.length <= 4 && !tooLong(options) && options.every((option) => !option.detail || (option.detail.length <= BAR_DETAIL && !linksIn(option.detail).length));
}

/**
 * Scrolls the open card's own list of answers into view, as little as shows it all, never past its caption, and back
 * up to its caption when it is above: the bar's "Pick an answer ↑" and opening a card whose list is the set.
 */
function answersIntoView(id: string, behavior: ScrollBehavior): void {
  const top = document.querySelector<HTMLElement>(`.card.top[data-need="${CSS.escape(id)}"]`);
  // In the wide Decide pane the card itself scrolls, its body at full height (desktop.css .decide-pane).
  const body = top?.closest(".decide-pane") ? top : top?.querySelector<HTMLElement>(".card-body");
  const cap = body?.querySelector<HTMLElement>(".choices-cap");
  const list = body?.querySelector<HTMLElement>(".choices");
  if (!body || !cap || !list) return;
  const box = body.getBoundingClientRect();
  const toCap = cap.getBoundingClientRect().top - box.top - 8;
  const toEnd = list.getBoundingClientRect().bottom - box.bottom + 8;
  const by = toCap < 0 ? toCap : Math.min(toCap, Math.max(0, toEnd));
  if (by) body.scrollBy?.({ top: by, behavior });
}

/** The bar's one button when an answer is too long for it: brings the card's list, where each shows whole, into view. */
function toAnswers(need: ServedNeed): HTMLElement {
  return button("Pick an answer ↑", () => answersIntoView(need.id, "smooth"), "pick", false, "cards.pick-hint");
}


/** A merge-ready card's yes merges its PR, so its button says so. */
function yesLabel(need: ServedNeed): string {
  return need.kind === MERGE_READY ? "Merge" : "Approve";
}

/** What a window a device code alone signed in reads where a merge-ready card's yes would be: the server refuses it that answer. */
const MERGE_NEEDS_PASSKEY = "Merge this from a phone or computer signed in with a passkey.";

/** The same where any other answer it is refused would be (ServedNeed passkeyAnswers). */
const YES_NEEDS_PASSKEY = "Approve this from a phone or computer signed in with a passkey.";

const passkeyLine = (text: string) => h("p", { class: "merge-passkey" }, text);

/** What this window reads in place of that answer, or null for one it can give: a device code alone arms no merge and releases none. */
function shutLine(need: ServedNeed, decision: Decision, choice?: string): string | null {
  if (signedInByCode() !== true) return null;
  if (!need.passkeyAnswers?.includes(choice ?? decision)) return null;
  return armsMerge(need, decision, choice) && !mergedReopen(need) ? MERGE_NEEDS_PASSKEY : YES_NEEDS_PASSKEY;
}

/** The card's answers this window can't give, for a drawing kept until one of its inputs changes. */
export const shutAnswers = (need: ServedNeed): string => (signedInByCode() === true && need.passkeyAnswers?.join("\n")) || "";

/** What stands in place of an option this window can't pick, one line a card; null for one it can. */
export function shutOption(need: ServedNeed, options: readonly { label: string }[], index: number): HTMLElement[] | null {
  const lines = options.map((option) => shutLine(need, "choice", option.label));
  const own = lines[index] ?? null;
  if (own === null) return null;
  return lines.findIndex((line) => line !== null) === index ? [passkeyLine(lines.includes(MERGE_NEEDS_PASSKEY) ? MERGE_NEEDS_PASSKEY : own)] : [];
}

function shutApprove(need: ServedNeed): HTMLElement | null {
  const line = shutLine(need, "approve");
  return line === null ? null : passkeyLine(line);
}

/** Dictation stops, keeping its words, before the answer goes. */
function afterVoice(then: () => void): void {
  stopDictation();
  then();
}

/**
 * The say-line: a box, the mic and a photo, always on the card above its
 * answers, no sheet. What is typed rides with the next answer as its note; `send` adds a Send that files it alone as a
 * comment, shown once there is something to send.
 */
function sayLine(
  need: ServedNeed,
  { placeholder = "Say something, or just tap…", send = false, current = () => need, answer = null }: { placeholder?: string; send?: boolean; current?: () => ServedNeed; answer?: HTMLButtonElement | null } = {},
): HTMLElement {
  const card = cardState(need.id);
  const area = h("textarea", {
    class: "say-text",
    attrs: { rows: "1", maxlength: "4000", placeholder, "aria-label": wantsText(need) ? "Your answer" : "Say something" },
  });
  area.value = card.text;
  const attach = photosControl(card.attach, {
    onChange: () => {
      paint();
      changed();
    },
    use: "cards.say.attach",
    onSignedOut: () => signedOut("Your session ended. Sign in again."),
  });
  const field = withMic(area, "cards.say.mic");
  const sayButton = send ? sending(button("Send", () => afterVoice(() => area.isConnected && decide(current(), "comment")), "say-send", false, "cards.say.send")) : null;
  const line = h(
    "div",
    { class: "say-line", attrs: { "data-need": need.id } },
    h("div", { class: "say-row" }, field, attach.button, sayButton),
    attach.preview,
    planLocks(area, attach, sayButton, answer),
  );
  const paint = () => line.classList.toggle("has-text", card.text.trim() !== "" || card.attach.photos.length > 0);
  area.addEventListener("input", () => {
    card.text = area.value;
    paint();
  });
  paint();
  return line;
}

/** Puts the keyboard in the card's say-line (the desk's note box on a wide window). */
function focusSay(id: string): void {
  const area =
    document.querySelector<HTMLTextAreaElement>(`.say-line[data-need="${CSS.escape(id)}"] .say-text`) ??
    (isDesk() ? (document.querySelector(`.decide-pane .card.top[data-need="${CSS.escape(id)}"]`)?.closest(".answer-card")?.querySelector<HTMLTextAreaElement>(".desk-note") ?? null) : null);
  area?.focus();
  area?.scrollIntoView?.({ block: "center" });
}

/**
 * Under the card: the say-line, then the answers. A plan card: one big "Yes, go" (its yes, which starts the build) and
 * No. Otherwise Answer on a text card, or Approve (or Merge) on a card with no options; an option card's answers are its
 * boxes, Reject is the X at its top right, and the "−" there does what Later did. There is no Dismiss: a card is answered, changed, minimised or rejected.
 */
function actionBar(need: ServedNeed): HTMLElement {
  const options = need.options ?? [];
  const text = wantsText(need);
  const answer = text && !options.length ? sending(button([svg(ICONS.note, "btn-icon"), "Send answer"], () => afterVoice(() => answerText(need)), "pick yes", false, "cards.send-answer")) : null;
  const say = sayLine(need, { send: !text, answer });
  if (isTodo(need)) {
    return h(
      "div",
      { class: "actions", attrs: { "data-need": need.id, "data-rev": need.rev } },
      say,
      todoOpen(need),
      h("div", { class: "pick-row n1" }, sending(button([svg(ICONS.yes, "btn-icon"), "Done"], () => afterVoice(() => decide(need, "done")), "pick yes", false, "cards.todo.done"))),
    );
  }
  if (isUpdate(need)) return h("div", { class: "actions", attrs: { "data-need": need.id, "data-rev": need.rev } }, say, h("div", { class: "pick-row n1" }, seenButton(need, "pick yes")));
  if (isPlan(need)) {
    return h(
      "div",
      { class: "actions plan-acts", attrs: { "data-need": need.id, "data-rev": need.rev } },
      say,
      h(
        "div",
        { class: "plan-row" },
        shutApprove(need) ?? sending(button([h("span", { class: "plan-b" }, "Yes, go"), h("span", { class: "plan-s" }, "starts the build")], () => afterVoice(() => act(need, "approve")), "pick yes plan-go", false, "cards.plan.yes")),
        button([h("span", { class: "plan-b" }, "No"), h("span", { class: "plan-s" }, "change it")], () => afterVoice(() => act(need, "reject")), "mini no plan-che", false, "cards.plan.no"),
      ),
    );
  }
  const primary = options.length ? null : (answer ?? shutApprove(need) ?? sending(button([svg(ICONS.yes, "btn-icon"), yesLabel(need)], () => afterVoice(() => act(need, "approve")), "pick yes", false, "cards.approve")));
  return h(
    "div",
    { class: "actions", attrs: { "data-need": need.id, "data-rev": need.rev } },
    say,
    primary ? h("div", { class: "pick-row n1" }, primary) : null,
  );
}

/** A text card's answer is what the say-line holds. */
function answerText(need: ServedNeed): void {
  // A key press reaches here past the locked Send answer.
  if (needsPlan()) return;
  const card = cardState(need.id);
  if (!card.text.trim() && !card.attach.photos.length) {
    flash("Type your answer first", "warn");
    return focusSay(need.id);
  }
  decide(need, "comment");
}

/**
 * Only a clean tap answers: a press that moved past the slop, or let anything
 * scroll before it lifted, drops its click, and so does a tap on the deck just
 * after an answer or behind an open sheet or dialog (a keyboard Enter or Space
 * included). Returns the teardown.
 */
export function guardTaps(element: HTMLElement): () => void {
  let press: { id: number; x: number; y: number; spoiled: boolean } | null = null;
  const spoil = () => {
    if (press) press.spoiled = true;
  };
  const down = (event: PointerEvent) => {
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, spoiled: false };
  };
  const move = (event: PointerEvent) => {
    if (press?.id === event.pointerId && !isTap(event.clientX - press.x, event.clientY - press.y)) press.spoiled = true;
  };
  const click = (event: MouseEvent) => {
    const onDeck = event.target instanceof Element && event.target.closest(".deck") !== null;
    const spoiled = press?.spoiled || modalOpen() || (onDeck && tapLock !== null);
    press = null;
    if (!spoiled) return;
    event.preventDefault();
    event.stopPropagation();
  };
  element.addEventListener("pointerdown", down);
  element.addEventListener("pointermove", move);
  element.addEventListener("pointercancel", spoil);
  element.addEventListener("scroll", spoil, true);
  element.addEventListener("click", click, true);
  return () => {
    element.removeEventListener("pointerdown", down);
    element.removeEventListener("pointermove", move);
    element.removeEventListener("pointercancel", spoil);
    element.removeEventListener("scroll", spoil, true);
    element.removeEventListener("click", click, true);
  };
}

/** Yes on a card that takes a pick or a typed answer points at those instead. */
function noBareApprove(need: ServedNeed): void {
  if (wantsText(need)) return answerText(need);
  flash("Pick one of the options", "warn");
}

function act(need: ServedNeed, action: Action): void {
  // A todo is Done, minimised or rejected; never approved.
  if (isTodo(need) && action === "approve") return flash("Do the steps, then tap Done", "warn");
  if (action === "approve" && !canApprove(need)) return noBareApprove(need);
  if (action === "reject" && isUpdate(need)) return;
  // A recording in the say-line is written down first, so the popup opens with all of its words.
  if (action === "reject") return afterVoice(() => openRejectSheet(need));
  if (action !== "skip") return decide(need, action);
  // Later is the "−" now: the L key and Up arrow minimise the card in
  // its place, out of the red numbers, and Z opens it again.
  if (app.front === need.id) app.front = null;
  saveMinimised(need.id, need.rev, true);
  cardAnswered(need, "minimise");
  hold({ need, answer: null, confirm: false, verb: "Minimised", tone: "later" });
}

// Answers

function decide(need: ServedNeed, decision: Decision, choice?: string, confirmedRev?: string): void {
  const card = cardState(need.id);
  // Seen and Dismiss say nothing: a note kept on the card stays there for a comment.
  const seen = decision === "seen" || decision === "dismiss";
  const text = seen ? "" : card.text.trim();
  const held = seen ? null : photosHold(card.attach.photos);
  if (held) {
    flash(held, "warn");
    return;
  }
  const { images, files } = seen ? { images: [], files: [] } : photosPayload(card.attach.photos);
  // Where a pick passes on only what the card shows, one with a note is the note alone (inChatSchema's `noted`).
  const noted = decision === "choice" && (text || images.length || files.length) ? need.inChat?.noted : undefined;
  if (noted) [decision, choice] = ["comment", undefined];
  // A key press reaches here with no button on the card.
  const shut = shutLine(need, decision, choice);
  if (shut) return flash(shut, "warn");
  if (decision === "comment" && !text && !images.length && !files.length) return focusSay(need.id);
  // The words show on the say-line above the option, so what is there is what he means.
  if (decision === "choice" && optionNeedsText(need, choice) && confirmedRev === undefined && !text) {
    flash(`Say what “${choice ?? ""}” should be first, then pick it again`, "warn");
    return focusSay(need.id);
  }
  if (needsConfirm(need, decision) && confirmedRev === undefined) {
    card.confirm = { decision, choice, rev: need.rev };
    card.error = null;
    changed();
    return;
  }
  // A confirmed answer carries the revision the owner confirmed, never a newer one
  // polled in since; the server rejects it if the card has moved.
  const answer: Answer = {
    itemId: need.id,
    decision,
    rev: confirmedRev ?? need.rev,
    ...(choice ? { choice } : {}),
    ...(text ? { text } : {}),
    ...imageFields(images),
    ...(files.length ? { files } : {}),
  };
  card.confirm = null;
  card.error = null;
  cardAnswered(need, decision);
  const waiting = deck().length;
  app.held.add(need.id);
  if (app.front === need.id) app.front = null;
  if (waiting && !deck().length) cheer();
  hold({
    need,
    answer,
    confirm: confirmedRev !== undefined,
    verb: noted ?? (decision === "choice" ? (need.inChat?.doing?.[choice ?? ""] ?? `${VERBS.choice}: ${choice ?? ""}`) : VERBS[decision]),
    tone: decision === "approve" || decision === "choice" || decision === "done" || decision === "seen" ? "yes" : decision === "reject" ? "no" : decision === "dismiss" ? "later" : "note",
  });
}

/** Every answer, a minimise by key included, waits out its own Undo window before it counts. */
function hold(entry: Omit<Held, "key" | "until">): void {
  // A say-line keeping the keyboard would hold every render back, the answered card with it.
  leaveText();
  const held: Held = { key: `held-${++heldSeq}`, until: Date.now() + UNDO_MS, ...entry };
  queue.push(held, commit);
  toastFor(held);
  lockTaps();
  changed();
}

function toastFor(entry: Held): void {
  showUndo({ key: entry.key, verb: entry.verb, title: entry.need.title, tone: entry.tone, ms: Math.max(0, entry.until - Date.now()), onUndo: undo });
}

/** Takes back the newest answer; the one before it, if still held, gets the toast back for the rest of its window. */
function undo(): void {
  const entry = queue.undo();
  if (!entry) return;
  clearUndo(entry.key);
  cardAnswered(entry.need, "undo");
  cheerAt = 0;
  if (entry.answer) app.held.delete(entry.need.id);
  else if (entry.verb === "Minimised") saveMinimised(entry.need.id, entry.need.rev, false);
  for (const other of entry.rest ?? []) app.held.delete(other.need.id);
  opens++;
  frontCard(entry.need.id);
  // The home screen came back after the cheer with this toast still up: the answer taken back reopens its card.
  if (entry.answer && isDesk() && app.tab === "progress") app.tab = "cards";
  const previous = queue.current;
  if (previous) toastFor(previous);
  unlockTaps();
  changed();
}

/** An answer caught by sign-out: kept in the outbox, marked to send once signed in again. */
function park(need: ServedNeed, answer: Answer, confirm: boolean): void {
  const card = cardState(need.id);
  const pending = clientIdFor(card.pending, answer, () => crypto.randomUUID());
  if (card.pending && card.pending.clientId !== pending.clientId) outbox.forget(card.pending.clientId);
  card.pending = pending;
  outbox.remember({ ...answer, clientId: pending.clientId, title: need.title, parked: true, ...(confirm ? { confirm: true } : {}) });
}

function commit(entry: Held): void {
  clearUndo(entry.key);
  if (entry.answer) void send(entry.need, entry.answer, entry.confirm);
  for (const other of entry.rest ?? []) void send(other.need, other.answer, false);
}

async function send(need: ServedNeed, answer: Answer, confirm: boolean): Promise<void> {
  const card = cardState(need.id);
  const pending = clientIdFor(card.pending, answer, () => crypto.randomUUID());
  if (card.pending && card.pending.clientId !== pending.clientId) outbox.forget(card.pending.clientId);
  card.pending = pending;
  outbox.remember({ ...answer, clientId: pending.clientId, title: need.title });
  try {
    const reply = await api.sendReply({ clientId: pending.clientId, ...answer, ...(confirm ? { confirm: true } : {}) });
    outbox.forget(pending.clientId);
    replyLanded(reply);
    app.recent = [reply, ...app.recent.filter((other) => other.id !== reply.id)].slice(0, 12);
    if (answer.decision !== "seen" && answer.decision !== "dismiss") app.answeredToday += 1;
    app.held.delete(need.id);
    app.reopened.delete(need.id);
    dropPhotos(card.attach);
    app.cards.delete(need.id);
    closeAnsweredCards();
    changed();
  } catch (error) {
    // A late answer to a request from before a sign-out says nothing about this session's cards.
    if (error instanceof StaleSession) return;
    if (error instanceof api.ApiError && error.answered) return alreadyAnswered(need, answer, pending.clientId, error.answered);
    app.held.delete(need.id);
    // No plan connected is no word about the card: its 409 is not "this card changed".
    const failure = error instanceof api.NoPlan ? "refused" : classifyFailure(error instanceof api.ApiError ? error.status : 0);
    if (failure === "signin") {
      park(need, answer, confirm);
      return signedOut("Your session ended. Sign in again.");
    }
    if (failure !== "retry") {
      card.pending = null;
      outbox.forget(pending.clientId);
    }
    app.front = need.id;
    opens++;
    // The home screen back after the last card's cheer, or a phone's sheet closed on its last answer: Decide opens again on
    // the card, so "back on top" is where the owner looks; off the home screen (Chat, Readings) the toast says where it is.
    // On Open, not the Answered side a closed sheet left saved, which would hide the card behind today's answers.
    if (!decideUp() && app.tab === "progress") [app.tab, segment] = ["cards", "needs"];
    const where = decideUp() || app.tab === "cards" ? "" : " in Decide";
    if (failure === "changed") {
      card.error = "This card changed; look again.";
      flash(`That card changed. Look again${where}.`, "error");
      await refreshBoard();
      return;
    }
    // The card back on top says where to give it from; one read before the server marked its answers says the refusal.
    if (api.needsPasskey(error)) {
      setSignedInByCode(true);
      if (!shutLine(need, answer.decision, answer.choice)) card.error = describe(error);
      changed();
      return;
    }
    card.error = failure === "retry" ? `Not sent: ${describe(error)} Answer again to retry.` : describe(error);
    if (error instanceof api.ApiError && error.status === 424) flash(`${describe(error)}${where ? ` The card is back on top${where}.` : ""}`, "error", 6000);
    else flash(`Not sent. The card is back on top${where}.`, "error");
    changed();
  }
}

/** Another answer to this revision landed first (another device, a stale screen): it stands, and this one was refused. */
function alreadyAnswered(need: ServedNeed, answer: Answer, clientId: string, first: Reply): void {
  outbox.forget(clientId);
  replyLanded(first);
  app.held.delete(need.id);
  app.reopened.delete(need.id);
  dropPhotos(cardState(need.id).attach);
  app.cards.delete(need.id);
  closeAnsweredCards();
  const word = first.decision === "choice" ? `${VERBS.choice} ${first.choice ?? ""}` : first.decision === "comment" ? "Commented" : VERBS[first.decision];
  // A Seen that meets a Seen (a pile seen on two devices) changes nothing, so it says nothing.
  if (!(answer.decision === "seen" && first.decision === "seen")) flash(`Already answered: ${word}. This answer was not sent.`, "warn", 6000);
  changed();
}

/**
 * Sends a held answer now, when the page is hidden or going away: The owner already
 * answered, so the answer goes rather than being lost with the page. Sends are
 * keepalive and in the outbox, so they outlive the page or show up on the next load.
 */
export function flushHeld(): void {
  queue.flush();
}

/**
 * After the first successful load of a session: answers from an earlier page that
 * the server does not have go back on top with a note. Answering the same way
 * reuses the clientId, so an answer that did land is not recorded twice. Until a
 * load succeeds the entries stay put, since a missing board proves nothing.
 */
export function recoverOutbox(): void {
  const needs = app.board?.board?.needs;
  if (!recoveryDue || !needs) return;
  recoveryDue = false;
  const onBoard = new Map(needs.map((need) => [need.id, need]));
  const entries = outbox.readOutbox();
  const open = new Set(outbox.unconfirmed(entries, app.landed).map((entry) => entry.clientId));
  for (const entry of entries) {
    if (!open.has(entry.clientId)) {
      outbox.forget(entry.clientId);
      continue;
    }
    const need = onBoard.get(entry.itemId);
    if (!need || need.rev !== entry.rev) {
      outbox.forget(entry.clientId);
      flash(`An earlier answer may not have reached ${agentName()}: ${entry.title}`, "warn", 6000);
      continue;
    }
    const card = cardState(entry.itemId);
    if (entry.parked) {
      const { clientId, title: _title, parked: _parked, confirm, ...answer } = entry;
      // The card holds the note as sent, so answering again after a lost reply is the same answer, with the same clientId.
      // Reopened, so a failed replay stays on the deck even when an earlier answer landed at this revision.
      card.text = entry.text ?? "";
      restorePhotos(card.attach, chatImages(entry), entry.files);
      card.pending = { key: answerKey(answer), clientId };
      app.reopened.add(entry.itemId);
      app.held.add(entry.itemId);
      void send(need, answer, confirm === true);
      continue;
    }
    card.text = entry.text ?? "";
    restorePhotos(card.attach, chatImages(entry), entry.files);
    card.pending = { key: answerKey(entry), clientId: entry.clientId };
    card.error = `The app closed before ${agentName()} confirmed your answer (${entry.decision === "choice" ? (entry.choice ?? "") : VERBS[entry.decision]}). Answer the same way to send it; it will not arrive twice.`;
    app.reopened.add(entry.itemId);
    app.front ??= entry.itemId;
  }
  changed();
}

export function undoLast(): void {
  if (queue.current) undo();
}

export function feedKeyUp(event: KeyboardEvent): void {
  keysDown.delete(event.key);
  keysDown.delete(event.key.toLowerCase());
}

export function releaseKeys(): void {
  keysDown.clear();
}

const kbd = (key: string) => h("kbd", { class: "key" }, key);

function focusNote(): void {
  document.querySelector<HTMLTextAreaElement>(".desk-note")?.focus();
}

/** The inline box's comment, or the typed answer on a card that asks a question. */
function sendNote(need: ServedNeed): void {
  stopDictation();
  noteNow(need);
}

function noteNow(need: ServedNeed): void {
  const card = cardState(need.id);
  if (!card.text.trim() && !card.attach.photos.length) return focusNote();
  leaveText();
  decide(need, "comment");
}

/**
 * Under the open card: the answer buttons with their keys, and the comment box inline. A note typed there rides along
 * with the next answer, as on the phone.
 */
function deskActions(need: ServedNeed): HTMLElement {
  const card = cardState(need.id);
  const options = need.options ?? [];
  const text = wantsText(need);
  const note = h("textarea", {
    class: "desk-note",
    attrs: {
      rows: "2",
      maxlength: "4000",
      placeholder: text ? "Type your answer…" : need.inChat?.noted ? "Comment…" : "Comment, or a note that goes with your answer…",
      "aria-label": text ? "Your answer" : "Comment",
    },
    on: {
      input: (event) => (card.text = (event.target as HTMLTextAreaElement).value),
      keydown: (event) => {
        const key = event as KeyboardEvent;
        if (key.key === "Escape") {
          key.preventDefault();
          leaveText();
          if (dirty) changed();
        } else if (key.key === "Enter" && (key.metaKey || key.ctrlKey)) {
          key.preventDefault();
          useTap(text ? "cards.desk.send" : "cards.desk.comment");
          sendNote(need);
        }
      },
    },
  });
  note.value = card.text;
  const attach = photosControl(card.attach, { onChange: changed, use: "cards.desk.attach", onSignedOut: () => signedOut("Your session ended. Sign in again.") });
  const field = withMic(note, "cards.desk.mic");
  const comment = text ? null : sending(button(["Send comment", kbd("⌘↵")], () => sendNote(need), "desk-send", false, "cards.desk.comment"));
  const answer = text && !options.length ? sending(button([svg(ICONS.note, "btn-icon"), "Send answer", kbd("⌘↵")], () => sendNote(need), "pick yes", false, "cards.desk.send")) : null;
  const todo = isTodo(need);
  const picks = todo
    ? [sending(button([svg(ICONS.yes, "btn-icon"), "Done"], () => decide(need, "done"), "pick yes", false, "cards.todo.done"))]
    : isUpdate(need)
    ? [seenButton(need, "pick yes")]
    : options.length && !barHoldsAll(options)
    ? [toAnswers(need)]
    : options.length
    ? options.slice(0, 4).flatMap((option, index) => {
        const shut = shutOption(need, options, index);
        if (shut) return shut;
        const element = keyed(
          sending(button([kbd(String(index + 1)), h("span", { class: "pick-text" }, h("span", { class: "pick-label", attrs: need.inChat ? { [TYPED]: "" } : {} }, option.label, option.recommended ? recommendedTag() : null), option.detail ? h("span", { class: "pick-detail" }, option.detail) : null)], () => decide(need, "choice", option.label), yellowAnswer(need, option) ? "pick rec" : "pick", false, "cards.answer.choice", index + 1), need.inChat ? undefined : option.detail ? `${option.label}, ${option.detail}` : option.label),
          option.label,
        );
        // An inChat card's answer is its label as written, read out too: the page rewords names in these attributes (rivet-words.ts).
        if (!need.inChat) element.title = option.label;
        return element;
      })
    : [answer ?? shutApprove(need) ?? sending(button([svg(ICONS.yes, "btn-icon"), yesLabel(need), kbd("A")], () => act(need, "approve"), "pick yes", false, "cards.desk.approve"))];
  return h(
    "div",
    { class: "desk-actions", attrs: { "data-need": need.id, "data-rev": need.rev } },
    todo ? todoOpen(need) : null,
    h(
      "div",
      { class: "desk-answer" },
      h("div", { class: `desk-picks n${picks.length}` }, ...picks),
    ),
    h("div", { class: "desk-compose" }, field, attach.button, comment),
    attach.preview,
    planLocks(note, attach, comment, answer),
  );
}

/**
 * The yellow answer: Rivet's recommended pick, and a Got it card's one button, which carries no Recommended tag.
 */
function yellowAnswer(need: ServedNeed, option: NonNullable<ServedNeed["options"]>[number]): boolean {
  return !!option.recommended || isGotIt(need);
}

/** The recommended answer's mark in the desktop bar; the card above says the word. */
function recommendedTag(): HTMLElement {
  const tag = svg(ICONS.yes, "pick-tag");
  tag.removeAttribute("aria-hidden");
  tag.setAttribute("role", "img");
  tag.setAttribute("aria-label", "Recommended");
  return tag;
}

const MOVES: Record<string, number> = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };
const ANSWERS: Record<string, Action> = { a: "approve", x: "reject", l: "skip" };
const KEY_USE: Record<Action, string> = { approve: "cards.key.approve", reject: "cards.key.reject", skip: "cards.key.later" };

/**
 * The desktop keys for the card `host` shows, `top` at the revision shown: J/K `step` to the next or last card, A/X/L
 * answer, 1–9 choose, C types a comment, Space plays, Z undoes.
 */
export function cardKey(event: KeyboardEvent, top: ServedNeed | null, host: HTMLElement, step: (by: number) => void): void {
  // A pane that takes the focus so a key lands nowhere (chat, its message box hidden) answers no card.
  const off = event.target instanceof HTMLElement && event.target.dataset.cardKeys === "off";
  if (off || modalOpen() || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const move = MOVES[key];
  if (move) {
    event.preventDefault();
    useTap(move > 0 ? "cards.key.next" : "cards.key.prev");
    return step(move);
  }
  if (event.repeat || keysDown.has(key)) return;
  if ((key === "Enter" || key === " ") && pressesControl(event.target)) return;
  if (key === "z" || key === "u") return useTap("cards.key.undo"), undoLast();
  const shown = host.isConnected ? host.querySelector<HTMLElement>(".card.top") : null;
  // A minimised card shows no answers, so no key answers it.
  if (!top || shown?.dataset.need !== top.id || shown.classList.contains("minimised")) return;
  const card = cardState(top.id);
  if (card.confirm) {
    if (key === "Escape") {
      useTap("cards.key.esc");
      card.confirm = null;
      changed();
    } else if ((key === "Enter" || key === "y") && tapLock === null) {
      event.preventDefault();
      useTap(key === "y" ? "cards.key.yes" : "cards.key.enter");
      keysDown.add(key);
      decide(top, card.confirm.decision, card.confirm.choice, card.confirm.rev);
    }
    return;
  }
  if (key === "c") {
    event.preventDefault();
    useTap("cards.key.comment");
    return focusNote();
  }
  if (key === " ") {
    const play = host.querySelector<HTMLButtonElement>(".card.top .media-play");
    if (!play) return;
    event.preventDefault();
    keysDown.add(key);
    return play.click();
  }
  // A second press straight after an answer would land on the next card, as a double tap would.
  if (tapLock !== null) return;
  const options = isTodo(top) ? [] : (top.options ?? []);
  const digit = /^[1-9]$/.test(key) ? Number(key) : 0;
  if (digit && digit <= options.length) {
    keysDown.add(key);
    useTap("cards.key.choice", digit);
    return decide(top, "choice", options[digit - 1]!.label);
  }
  const action = ANSWERS[key];
  if (!action) return;
  event.preventDefault();
  keysDown.add(key);
  useTap(KEY_USE[action]);
  act(top, action);
}

// Off the Feed

/**
 * A waiting card with its answers as the open card shows them, for an Agents ticket: the Feed's own controls, so the answer goes the one way.
 */
export function answerCard(need: ServedNeed, sheet = false): HTMLElement {
  // The "−" is Later here too: minimised, the card is its title line.
  const card = isMinimised(need.id, need.rev)
    ? h("div", { class: "answer-card" }, minimisedCard(need))
    : h("div", { class: "answer-card" }, topCard(need, true, sheet), isDesk() ? deskActions(need) : actionBar(need));
  // A ticket repaints without the Feed's render: its card slides in once, not on every repaint.
  shownCards.add(need.id);
  return card;
}

/** A card's yes off the Feed: the Feed's own approve, held for Undo, then sent. */
export function approveCard(need: ServedNeed): void {
  act(need, "approve");
}

/** One of a card's options, chosen off the Feed (Ops' Where suggestion): the Feed's own answer, held for Undo, then sent. */
export function answerOption(need: ServedNeed, label: string): void {
  decide(need, "choice", label);
}

/** An answer card's buttons ignore taps just after an answer, as the deck's do. */
export function answerTapsLocked(): boolean {
  return tapLock !== null;
}

/** The Feed has no answer sheet since the say-line; kept for the Agents ticket, which still asks. */
export function answerSheet(): HTMLElement | null {
  return null;
}

/** Closes the reject popup when it is open, as its Cancel does, and says whether it was. */
export function closeAnswerSheet(): boolean {
  if (!rejectOpen) return false;
  closeSheet();
  return true;
}

/** The textarea keeps focus after a button press on some browsers, and renders wait while it has it. */
function leaveText(): void {
  if (document.activeElement instanceof HTMLTextAreaElement) document.activeElement.blur();
}

/** How long Rivet cheers the last card answered before he settles to All clear. */
const CHEER_MS = 4000;
/** When the owner's own answer took the last waiting card; 0 while no cheer is on. */
let cheerAt = 0;
let cheerTimer: ReturnType<typeof setTimeout> | undefined;

/** the owner answered the last waiting card: Rivet is happy for a few seconds. */
function cheer(): void {
  cheerAt = Date.now();
  clearTimeout(cheerTimer);
  cheerTimer = setTimeout(() => {
    cheerAt = 0;
    changed();
  }, CHEER_MS);
}

const cheering = () => !!cheerAt && Date.now() - cheerAt < CHEER_MS;

/** The cheer shows only with no minimised card waiting: one still waits on the owner, so he has not cleared them all. */
const cheerShown = (minimised: number) => cheering() && !minimised;

/** Rivet's words on All clear: Home's word for Ops, or the cheer while it is on; `minimised` is the count Cards shows. */
function clearShown(minimised: number): ReturnType<typeof clearWords> {
  const words = clearWords(minimised);
  if (!cheerShown(minimised)) return words;
  return {
    ...words,
    mood: "happy",
    title: "You cleared them all!",
    lede: words.mood === "happy" ? NOTHING_NEEDS_YOU : words.lede,
  };
}

/** A burst of confetti behind Rivet, inside his own box; a redraw mid-burst carries on from where it was. */
function confetti(): HTMLElement {
  const colours = ["#ffc23d", "#2fd67b", "#7fa8ff", "#c79bff", "#ff8a95"];
  const el = h(
    "span",
    { class: "clear-confetti", attrs: { "aria-hidden": "true" } },
    ...Array.from({ length: 18 }, (_, i) => {
      const bit = h("i", {});
      bit.style.setProperty("--a", `${(i * 360) / 18 + (i % 2) * 9}deg`);
      bit.style.setProperty("--r", `-${92 + (i % 3) * 13}px`);
      bit.style.setProperty("--c", colours[i % colours.length]!);
      bit.style.setProperty("--d", `${(i % 4) * 60}ms`);
      return bit;
    }),
  );
  el.style.setProperty("--t", `${cheerAt - Date.now()}ms`);
  return el;
}

/**
 * Rivet happy over "You cleared them all!" while the cheer is on, for the Decide pane that just showed the last card;
 * null once it is over, or while `minimised` cards still wait.
 */
export function cheerView(minimised: number): HTMLElement | null {
  if (!cheerShown(minimised)) return null;
  const words = clearShown(minimised);
  const art = rivet(words.mood, { size: 150, glow: true, className: "clear-art clear-rivet" });
  return h(
    "section",
    { class: "clear" },
    h("div", { class: "clear-cheer" }, window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? null : confetti(), art),
    h("h2", { class: "clear-title" }, words.title),
    words.lede ? h("p", { class: "clear-lede" }, words.lede) : null,
    words.agents ? h("p", { class: "clear-agents" }, words.agents) : null,
    words.parked ? h("p", { class: "clear-agents clear-parked" }, words.parked) : null,
  );
}

/** Pull to refresh: the board and replies, then any answer an earlier page left unconfirmed. */
export async function refresh(): Promise<void> {
  if (await refreshBoard()) recoverOutbox();
}

export function unmount(): void {
  closeWorkerSheet("feed");
  closeLightbox();
  stopCardMedia(true);
  releaseKeys();
  // A typed note stays on its card.
  leaveText();
}
