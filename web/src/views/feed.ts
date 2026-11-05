import "./feed.css";

import { APP_NAME, RIVET_NAME, chatName } from "../../../src/shared/names.js";
import { MAX_SHORT, type Decision, type Reply, type ServedNeed } from "../../../src/shared/board.js";
import { chatImages, imageFields } from "../../../src/shared/command.js";
import { canApprove, isPlan, isTodo, isUpdate, MERGE_READY, optionNeedsText, stepsOf, threadKey, wantsText } from "../../../src/shared/answers.js";
import { isToday, maybeWhen, when } from "../../../src/shared/when.js";
import { NOTHING_NEEDS_YOU } from "../../../src/shared/words.js";
import * as api from "../api.js";
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
import { StaleSession } from "../session.js";
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
  sameSession,
  saveLater,
  saveMinimised,
  signedOut,
  subscribe,
  unminimise,
  updateCards,
  replyLanded,
  type CardState,
} from "../state.js";
import { dropPhotos, photosControl, photosHold, photosPayload, restorePhotos } from "./attach.js";
import { reopenBand } from "./answered.js";
import { cardAnswered, useTap } from "../usage.js";
import { sending } from "./mac-wait.js";
import { cardMedia, stopCardMedia } from "./card-media.js";
import { cardShareButton } from "./card-share.js";
import { openThingFor, showConversation } from "./chat.js";
import { rivet } from "../rivet/rivet.js";
import { decideUp } from "./decide-sheet.js";
import { closeLightbox } from "./lightbox.js";
import { leaveOverlays } from "./navigation.js";
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

/** No network, or the last refresh could not reach the server: the cards shown are as of the last load. */
export function offlineBar(): HTMLElement | null {
  if (!app.offline) return null;
  const asOf = app.loadedAt === null ? "no cards loaded yet" : `cards as of ${when(app.loadedAt)}`;
  return h(
    "div",
    { class: "feed-offline", attrs: { role: "status" } },
    h("span", { class: "feed-offline-t" }, `${app.offline === "offline" ? "Offline" : `Can't reach ${APP_NAME}`} · ${asOf}`),
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
function topCard(need: ServedNeed, minimisable = false): HTMLElement {
  const card = cardState(need.id);
  if (card.confirm && card.confirm.rev !== need.rev) {
    card.confirm = null;
    card.error = "This card changed; look again.";
  }
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
  const askText = ask ? h("p", { class: todo ? "card-ask todo-ask" : "card-ask" }, ...linkify(ask)) : null;
  const rec = (option: (typeof options)[number]) => !!option.recommended;
  const element = h(
    "article",
    {
      class: `card box top ${kindClass(need.kind)}${need.risk ? " risky" : ""}${shownCards.has(need.id) ? "" : " entering"}`,
      attrs: { "data-need": need.id, "data-rev": need.rev, "aria-label": need.title },
    },
    h(
      "div",
      { class: "card-head" },
      // Every card is Rivet asking you something: his ? face heads it.
      rivet("asking", { size: 30, className: "card-rivet" }),
      isPlan(need) ? h("span", { class: "card-kind plan" }, need.chat ? `Plan · ${chatName(need.chat).replace(/-/g, " ")}` : "Plan") : null,
      need.risk ? h("span", { class: "chip risk" }, `${need.risk} change`) : null,
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
      h("div", { class: "head-tools" }, minimisable ? minimiseButton(need, "top") : null, rejectButton(need)),
    ),
    h(
      "div",
      { class: need.media ? "card-body with-media" : "card-body" },
      // The owner reads what a card is about, and what it asks, before who sent it or its photos or clip.
      reopenBand(need),
      h("h2", { class: "card-title" }, need.title),
      askText,
      ...planPoints(need),
      meta || since ? h("p", { class: "card-meta" }, meta, meta && since ? " · " : null, since ? h("span", { attrs: { "data-age": need.since! } }, since) : null) : null,
      need.media ? cardMedia(need.id, need.media, need.title) : null,
      todo && steps.length ? h("ol", { class: "todo-steps" }, ...steps.map((step) => h("li", {}, ...linkify(step)))) : null,
      proofBlock(need),
      listed
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
            { class: "choices" },
            ...options.flatMap((option, index) => [
              // The answer names the button, so a redraw keeps the keyboard on this answer (dom.ts keepFocus).
              keyed(
                sending(button(
                [
                  isDesk() && index < 9 ? h("kbd", { class: "key choice-key" }, String(index + 1)) : null,
                  rec(option) ? h("span", { class: "choice-top" }, h("span", { class: "choice-rec" }, "Recommended")) : null,
                  h("span", { class: "choice-label" }, option.label),
                  option.detail ? h("span", { class: "choice-detail" }, option.detail) : null,
                ],
                () => decide(need, "choice", option.label),
                rec(option) ? "choice rec" : "choice",
                false,
                "cards.answer.choice",
                index + 1,
                )),
                option.label,
              ),
              choiceLinks(option.detail),
            ]),
          )
        : null,
      links.length
        ? h(
            "div",
            { class: "card-links" },
            ...links.map(cardLink),
          )
        : null,
      card.error ? h("p", { class: "card-error box", attrs: { role: "alert" } }, card.error) : null,
      h(
        "div",
        { class: "card-tools" },
        need.chat ? button([svg(ICONS.note, "card-message-icon"), `Message ${RIVET_NAME}`], () => messageChat(need), "card-message", false, "cards.message-rivet") : null,
        keyed(cardShareButton(need, "card-share-top"), `share-${need.id}`),
        minimisable ? minimiseButton(need, "bottom") : null,
      ),
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

function minimiseButton(need: ServedNeed, where: "top" | "bottom"): HTMLElement {
  // A recording in the say-line is written down first: closing its box would drop the words (dictation.ts).
  // A "−" alone, no word; its name and tooltip still say Minimise.
  const minimise = keyed(
    button(
      "−",
      () =>
        afterVoice(() => {
          cardAnswered(need, "minimise");
          setMinimised(need.id, need.rev, true);
        }),
      `min-btn ${where}`,
      false,
      "cards.minimise",
    ),
    `min-${where}-${need.id}`,
  );
  minimise.setAttribute("aria-label", `Minimise ${need.title}`);
  minimise.title = "Minimise";
  return minimise;
}

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
  const fields = [
    h("p", { class: "sheet-where" }, need.title),
    withMic(area),
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
 * An update's thread, from its Done today row or a link to any card in it (decision
 * ): its thing's page when a conversation holds its chat's work, as a pile's tap
 * did, else a sheet of the thread's update cards in full, newest first, with Say and Share, and Seen (Seen all N) while
 * any are new.
 */
function openUpdate(need: ServedNeed): void {
  const sheet = () => {
    const key = threadKey(need.thread);
    // The thread's cards of today, as Done today lists it, and the card opened, even from an older day (a push).
    const cards = () => {
      const now = Date.now();
      const thread = threadUpdates(key).filter((one) => one.id === need.id || (one.since !== undefined && isToday(one.since, now)));
      return thread.length ? thread : [need];
    };
    const fresh = () => {
      const open = new Set(updateCards().map((one) => one.id));
      return cards().filter((one) => !app.held.has(one.id) && open.has(one.id));
    };
    const thread = cards()[0]!.thread ?? RIVET_NAME;
    let counted: ServedNeed[] = [];
    const seen = button(
      [],
      () => {
        closeSheet();
        if (counted.length) seenPile(counted);
      },
      "upd-seen",
      false,
      "updates.pile.seen",
    );
    let target: ServedNeed | null = null;
    let say: HTMLElement | null = null;
    let shown = "";
    let stop: (() => void) | null = null;
    const paint = (el: HTMLElement) => {
      counted = fresh();
      seen.hidden = !counted.length;
      seen.parentElement?.classList.toggle("solo", seen.hidden);
      seen.replaceChildren(svg(ICONS.yes, "btn-icon"), counted.length > 1 ? `Seen all ${counted.length}` : "Seen");
      const list = cards();
      // A sent comment holds the card, as an answer does: the say-line goes with it.
      if (target && app.held.has(target.id)) target = null;
      if (!target) say = null;
      const now = JSON.stringify([target?.id ?? null, list.map((one) => [one.id, one.rev, one.comments?.length ?? 0, app.held.has(one.id), cardState(one.id).error])]);
      if (now === shown) return;
      shown = now;
      const shownCards = list.map((one) => updateCard(one, thread));
      // The say-line stays the same element while Say is open, so a repaint never takes its draft, focus or photos.
      if (say && say.parentElement === el) {
        while (el.firstChild && el.firstChild !== say) el.firstChild.remove();
        say.before(...shownCards);
        return;
      }
      if (target) {
        const id = target.id;
        say = sayLine(target, { placeholder: `Say something about ${thread}…`, send: true, current: () => cards().find((one) => one.id === id) ?? target ?? need });
      }
      el.replaceChildren(
        ...shownCards,
        say ??
          h(
            "div",
            { class: "upd-acts" },
            button(
              "Say",
              () => {
                target = cards()[0]!;
                paint(el);
                el.querySelector<HTMLTextAreaElement>(".say-text")?.focus();
              },
              "upd-say",
              false,
              "updates.pile.say",
            ),
          ),
      );
    };
    openSheet(
      thread,
      {
        mount: (el) => {
          paint(el);
          stop = subscribe(() => paint(el));
        },
        unmount: () => stop?.(),
      },
      "Close",
      seen,
      { className: "update-sheet", use: "updates.thread" },
    );
    // Close takes the focus, which scrolls a long thread to its foot: it opens on its newest card.
    document.querySelector(".update-sheet")?.scrollTo({ top: 0 });
  };
  if (!need.chat) return sheet();
  const current = sameSession();
  void openThingFor(need.chat, need.repo).then((found) => {
    if (!found && current()) sheet();
  });
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
  const answer = (need: ServedNeed): Answer => ({ itemId: need.id, decision: "seen", rev: need.rev });
  for (const need of cards) {
    app.held.add(need.id);
    cardState(need.id).error = null;
    cardAnswered(need, "seen");
  }
  hold({ need: top, answer: answer(top), rest: rest.map((need) => ({ need, answer: answer(need) })), confirm: false, verb: `Seen all ${cards.length}`, tone: "yes" });
}

function fixTag(tag: string | undefined): boolean {
  return /\b(red|fix|fixed|failed|down)\b/i.test(tag ?? "");
}

/**
 * An update card in full: what happened, its line, its media, its PR and chat, the comments, Share. Its tag is left off
 * when it only says `head`, the sheet's name above it.
 */
function updateCard(need: ServedNeed, head?: string): HTMLElement {
  const card = cardState(need.id);
  const tag = need.tag && need.tag.trim().toLowerCase() !== head?.trim().toLowerCase() ? need.tag : null;
  const meta = need.pr ? [h("b", {}, `#${need.pr}`)] : [];
  const links = (need.links ?? []).filter((link) => isHttps(link.url));
  return h(
    "article",
    { class: "upd box", attrs: { "data-need": need.id, "data-rev": need.rev, "aria-label": need.title } },
    h(
      "div",
      { class: "upd-head" },
      tag ? h("span", { class: fixTag(tag) ? "upd-tag fix" : "upd-tag" }, tag) : null,
      h("span", { class: "upd-age", attrs: need.since ? { "data-since": need.since } : {} }, maybeWhen(need.since) ?? ""),
    ),
    h("h3", { class: "upd-title" }, need.title),
    need.ask ? h("p", { class: "upd-line" }, ...updText(need.ask)) : null,
    need.media ? cardMedia(need.id, need.media, need.title) : null,
    meta.length ? h("p", { class: "upd-meta" }, ...meta) : null,
    links.length
      ? h(
          "div",
          { class: "card-links" },
          ...links.map(cardLink),
        )
      : null,
    ...(need.comments ?? []).map((note) =>
      h("p", { class: note.from === "rivet" ? "upd-note h" : "upd-note" }, h("b", {}, note.from === "rivet" ? `${RIVET_NAME}: ` : "You: "), ...linkify(note.text)),
    ),
    card.error ? h("p", { class: "card-error box", attrs: { role: "alert" } }, card.error) : null,
    keyed(cardShareButton(need, "upd-share-solo"), `share-${need.id}`),
  );
}

/**
 * An update's text as written: its line breaks and blank lines kept (pre-wrap, like a question card's), and each "• "
 * line a list line, its wrap hung under its text. No markdown.
 */
function updText(text: string): Child[] {
  return text.split("\n").flatMap((line, index) => [
    ...(index ? ["\n"] : []),
    ...(line.startsWith("• ") ? [h("span", { class: "upd-li" }, ...linkify(line))] : linkify(line)),
  ]);
}

export function openConversation(id: string): void {
  leaveOverlays(() => {
    showConversation(id);
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
  // An update card is not in the deck: it opens on its own, over the tab the owner is on.
  const update = app.board?.board?.needs.find((need) => need.id === id && isUpdate(need));
  if (update) return openUpdate(update);
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
  { placeholder = "Say something, or just tap…", send = false, current = () => need }: { placeholder?: string; send?: boolean; current?: () => ServedNeed } = {},
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
  const line = h(
    "div",
    { class: "say-line", attrs: { "data-need": need.id } },
    h(
      "div",
      { class: "say-row" },
      withMic(area, "cards.say.mic"),
      attach.button,
      send ? sending(button("Send", () => afterVoice(() => area.isConnected && decide(current(), "comment")), "say-send", false, "cards.say.send")) : null,
    ),
    attach.preview,
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
  const say = sayLine(need, { send: !wantsText(need) });
  if (isTodo(need)) {
    return h(
      "div",
      { class: "actions", attrs: { "data-need": need.id, "data-rev": need.rev } },
      say,
      todoOpen(need),
      h("div", { class: "pick-row n1" }, sending(button([svg(ICONS.yes, "btn-icon"), "Done"], () => afterVoice(() => decide(need, "done")), "pick yes", false, "cards.todo.done"))),
    );
  }
  if (isPlan(need)) {
    return h(
      "div",
      { class: "actions plan-acts", attrs: { "data-need": need.id, "data-rev": need.rev } },
      say,
      h(
        "div",
        { class: "plan-row" },
        sending(button([h("span", { class: "plan-b" }, "Yes, go"), h("span", { class: "plan-s" }, "starts the build")], () => afterVoice(() => act(need, "approve")), "pick yes plan-go", false, "cards.plan.yes")),
        button([h("span", { class: "plan-b" }, "No"), h("span", { class: "plan-s" }, "change it")], () => afterVoice(() => act(need, "reject")), "mini no plan-che", false, "cards.plan.no"),
      ),
    );
  }
  const options = need.options ?? [];
  const text = wantsText(need);
  const primary = options.length
    ? null
    : text
      ? sending(button([svg(ICONS.note, "btn-icon"), "Send answer"], () => afterVoice(() => answerText(need)), "pick yes", false, "cards.send-answer"))
      : sending(button([svg(ICONS.yes, "btn-icon"), yesLabel(need)], () => afterVoice(() => act(need, "approve")), "pick yes", false, "cards.approve"));
  return h(
    "div",
    { class: "actions", attrs: { "data-need": need.id, "data-rev": need.rev } },
    say,
    primary ? h("div", { class: "pick-row n1" }, primary) : null,
  );
}

/** A text card's answer is what the say-line holds. */
function answerText(need: ServedNeed): void {
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
    verb: decision === "choice" ? `${VERBS.choice}: ${choice ?? ""}` : VERBS[decision],
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
  if (entry.answer && !isUpdate(entry.need) && isDesk() && app.tab === "progress") app.tab = "cards";
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
    const failure = classifyFailure(error instanceof api.ApiError ? error.status : 0);
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
    if (!decideUp() && !isUpdate(need) && app.tab === "progress") [app.tab, segment] = ["cards", "needs"];
    const where = decideUp() || app.tab === "cards" || isUpdate(need) ? "" : " in Decide";
    if (failure === "changed") {
      card.error = "This card changed; look again.";
      flash(`That card changed. Look again${where}.`, "error");
      await refreshBoard();
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
      flash(`An earlier answer may not have reached ${RIVET_NAME}: ${entry.title}`, "warn", 6000);
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
    card.error = `The app closed before ${RIVET_NAME} confirmed your answer (${entry.decision === "choice" ? (entry.choice ?? "") : VERBS[entry.decision]}). Answer the same way to send it; it will not arrive twice.`;
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
      placeholder: text ? "Type your answer…" : "Comment, or a note that goes with your answer…",
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
  const todo = isTodo(need);
  const picks = todo
    ? [sending(button([svg(ICONS.yes, "btn-icon"), "Done"], () => decide(need, "done"), "pick yes", false, "cards.todo.done"))]
    : options.length && !barHoldsAll(options)
    ? [toAnswers(need)]
    : options.length
    ? options.slice(0, 4).map((option, index) => {
        const element = keyed(
          sending(button([kbd(String(index + 1)), h("span", { class: "pick-text" }, h("span", { class: "pick-label" }, option.label, option.recommended ? recommendedTag() : null), option.detail ? h("span", { class: "pick-detail" }, option.detail) : null)], () => decide(need, "choice", option.label), option.recommended ? "pick rec" : "pick", false, "cards.answer.choice", index + 1), option.detail ? `${option.label}, ${option.detail}` : option.label),
          option.label,
        );
        element.title = option.label;
        return element;
      })
    : [
        text
          ? sending(button([svg(ICONS.note, "btn-icon"), "Send answer", kbd("⌘↵")], () => sendNote(need), "pick yes", false, "cards.desk.send"))
          : sending(button([svg(ICONS.yes, "btn-icon"), yesLabel(need), kbd("A")], () => act(need, "approve"), "pick yes", false, "cards.desk.approve")),
      ];
  return h(
    "div",
    { class: "desk-actions", attrs: { "data-need": need.id, "data-rev": need.rev } },
    todo ? todoOpen(need) : null,
    h(
      "div",
      { class: "desk-answer" },
      h("div", { class: `desk-picks n${picks.length}` }, ...picks),
    ),
    h("div", { class: "desk-compose" }, withMic(note, "cards.desk.mic"), attach.button, text ? null : sending(button(["Send comment", kbd("⌘↵")], () => sendNote(need), "desk-send", false, "cards.desk.comment"))),
    attach.preview,
  );
}

/** The recommended answer's mark in the desktop bar; the card above says the word. */
function recommendedTag(): HTMLElement {
  const tag = svg(ICONS.yes, "pick-tag");
  tag.removeAttribute("aria-hidden");
  tag.setAttribute("role", "img");
  tag.setAttribute("aria-label", "Recommended");
  return tag;
}

/** Under the open card in a wide window's Decide pane: the keys it takes. */
export function keyHints(need: ServedNeed): HTMLElement {
  const hint = (keys: string[], label: string) => h("span", { class: "desk-hint" }, ...keys.map(kbd), label);
  const options = need.options?.length ?? 0;
  const todo = isTodo(need);
  const clips = need.media?.before || need.media?.after;
  return h(
    "p",
    { class: "desk-keys", attrs: { "aria-label": "Keyboard shortcuts" } },
    hint(["J", "K"], "move"),
    clips ? hint(["Space"], "play") : null,
    todo ? null : options ? hint([`1–${Math.min(options, 9)}`], "choose") : wantsText(need) ? null : hint(["A"], "approve"),
    hint(["C"], "comment"),
    hint(["X"], "reject"),
    hint(["L"], "minimise"),
    hint(["Z"], "undo"),
    hint(["/"], "search"),
    hint(["Esc"], "close"),
    hint(["?"], "all keys"),
  );
}

const MOVES: Record<string, number> = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };
const ANSWERS: Record<string, Action> = { a: "approve", x: "reject", l: "skip" };
const KEY_USE: Record<Action, string> = { approve: "cards.key.approve", reject: "cards.key.reject", skip: "cards.key.later" };

/**
 * The desktop keys for the card `host` shows, `top` at the revision shown: J/K `step` to the next or last card, A/X/L
 * answer, 1–9 choose, C types a comment, Space plays, Z undoes.
 */
export function cardKey(event: KeyboardEvent, top: ServedNeed | null, host: HTMLElement, step: (by: number) => void): void {
  if (modalOpen() || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
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
export function answerCard(need: ServedNeed): HTMLElement {
  // The "−" is Later here too: minimised, the card is its title line.
  const card = isMinimised(need.id, need.rev)
    ? h("div", { class: "answer-card" }, minimisedCard(need))
    : h("div", { class: "answer-card" }, topCard(need, true), isDesk() ? deskActions(need) : actionBar(need));
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
