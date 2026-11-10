import "./decide-sheet.css";

import { isGotIt, isUpdate, waitsOnYou } from "../../../src/shared/answers.js";
import { asksOfChat } from "../../../src/shared/ask-stages.js";
import type { Ask } from "../../../src/shared/asks.js";
import type { ServedNeed } from "../../../src/shared/board.js";
import { chatName, RIVET_NAME } from "../../../src/shared/names.js";
import { NO_REPO } from "../../../src/shared/repos.js";
import { allMinimised, answeredTab, NEEDS_YOU, NOTHING_NEEDS_YOU, openTab, showMinimised } from "../../../src/shared/words.js";
import type { Worker } from "../../../src/shared/workers.js";
import { chatFor, seedKey } from "../agents-logic.js";
import { homeOf, projectName } from "../backlog-logic.js";
import { isDesk, typing } from "../desk.js";
import { FULL_SCREEN_EVENTS, fullScreenElement, h, ICONS, keepFocus, modalOpen, parkFocus, svg } from "../dom.js";
import { watchOps } from "../ops-data.js";
import { rivet } from "../rivet/rivet.js";
import { app, boardRead, cardState, changed, countedCards, deck, frontCard, isMinimised, navigated, navStamp, readAgain, refresh, subscribe, unminimise } from "../state.js";
import { answeredCount, answeredList } from "./answered.js";
import { stopCardMedia } from "./card-media.js";
import { answerCard, answerTapsLocked, cardKey, cardOnItsWay, cardsSegment, cheerView, feedKeyUp, guardTaps, keyHints, offlineBar, releaseKeys, setCardsSegment, showCard } from "./feed.js";
import { leaveOverlays } from "./navigation.js";
import { cardShown, enterScreen, leaveScreen, screenMoved, watchDepth } from "../usage.js";
import { closeTallSheet, openTallSheet } from "./sheet.js";
import type { View } from "./view.js";

/**
 * The Decide sheet: an open card as a tall sheet over the
 * dimmed map, opened off the agent asking it or by its push. The
 * card is the Feed's own (answerCard), so an answer goes the one way it goes on Cards.
 */

/** Marks put on a drawn card after it is drawn (its fade, its slide in): not a change to the card. */
const RUNTIME_MARKS = ["has-more", "entering"];
const bare = (card: Element): string => {
  const copy = card.cloneNode(true) as Element;
  for (const one of [copy, ...copy.querySelectorAll("*")]) one.classList.remove(...RUNTIME_MARKS);
  copy.querySelector(".decide-big")?.remove();
  return copy.outerHTML;
};

/** The card the sheet shows, which is what is on screen for the push watcher (main.ts watchViewing). */
let current: string | null = null;

/**
 * The open decision cards: those every red count shows, less those held for
 * Undo; what the sheet walks through, the map marks and Decide N counts. A push or link unminimises its card first.
 */
export const openCards = (): ServedNeed[] => countedCards().filter((need) => waitsOnYou(need) && !app.held.has(need.id));

/**
 * The open cards that count as needing him: a Got it card is news, so it is in openCards (the sheet shows it for its tap)
 * but never in Decide N or a desk's Needs you, as the server never counts it (openBoard).
 */
export const askingCards = (): ServedNeed[] => openCards().filter((need) => !isGotIt(need));

/** The cards minimised on this device that still wait on the owner: with none open the sheet says they wait, never "Nothing needs you". */
const minimisedWaiting = (): ServedNeed[] => deck().filter((need) => waitsOnYou(need) && !app.held.has(need.id) && isMinimised(need.id, need.rev));

export function decideShown(): string | null {
  return current;
}

/** Decide views mounted: the phone's sheet, the desk's pane. */
let mounted = 0;

/** Whether Decide is on screen, on a card or a list: a failed send's card then shows there by itself (feed.ts send). */
export const decideUp = (): boolean => mounted > 0;

/**
 * The open cards that are `w`'s, as the seat that holds them shows them: an ask of its chat naming a card first, then
 * cards from the chat itself. A card with no repo takes the worker's.
 */
export function cardsOf(w: Worker, crew: readonly Worker[], cards: readonly ServedNeed[] = openCards(), asks: readonly Ask[] = []): ServedNeed[] {
  const live = new Set(crew.map((one) => seedKey(one.repo, one.chat)));
  const named = new Set(asksOfChat(w, asks).flatMap((ask) => (ask.cardId ? [ask.cardId] : [])));
  const byChat = (need: ServedNeed) => !!need.chat && (need.repo ?? w.repo) === w.repo && chatFor(w.repo, need.chat, live, live) === w.chat;
  return [...cards.filter((need) => named.has(need.id)), ...cards.filter((need) => !named.has(need.id) && byChat(need))];
}

export function openDecideFor(w: Worker, crew: readonly Worker[], asks: readonly Ask[] = []): void {
  openDecide(cardsOf(w, crew, openCards(), asks).map((need) => need.id));
}

/**
 * Opens the sheet on `first[0]` (a wide window: the pane); the order is `first`, then the deck's other open cards in deck order. Its switch is
 * Cards' Open N | Answered N; `look.answered` opens on Answered.
 * `look.untilRead`: Answered only stands in for an Open with nothing yet, so the first board read's open cards replace it.
 */
export function openDecide(first: readonly string[], look: { answered?: boolean; untilRead?: boolean; onClose?: () => void } = {}): void {
  if (!look.answered && !openCards().some((need) => need.id === first[0])) return;
  // A wide window has no sheet for it: Decide opens in the middle pane.
  if (isDesk()) {
    if (first[0] && !look.answered) return showCard(first[0]);
    setCardsSegment("done");
    app.tab = "cards";
    return changed();
  }
  // An open counts as the owner moving on, so a pushed card still loading does not replace this one (showPushed).
  navigated();
  openTallSheet(NEEDS_YOU, decideView(first, look, () => closeTallSheet()), { className: "decide-sheet", onClose: look.onClose, use: "decide" });
}

/**
 * A wide window's Decide: the same view in the middle
 * pane, where the open card was, on the card put on top (a push, a link, an agent's tap) or the first open one. Its
 * The header's ‹ Your asks and Esc go back to the home screen, the last card answered is cheered where it was and then the home screen
 * comes back by itself, and the keys answer as the open card's did.
 */
export const pane = {
  mount(el: HTMLElement): void {
    paneView?.unmount();
    const cards = openCards();
    const first = cards.find((need) => need.id === app.front) ?? cards[0];
    const done = cardsSegment() === "done";
    paneView = decideView(first ? [first.id] : [], { answered: !first || done, untilRead: !first && !done }, () => {
      if (app.tab !== "cards") return;
      app.tab = "progress";
      changed();
    }, true);
    paneView.mount(el);
  },
  unmount(): void {
    paneView?.unmount();
    paneView = null;
    // Coming back to Decide opens on Open, not the side left open; a side asked for on the way in (a search hit for an
    // answer from the home screen) is set before this mounts, so it stays.
    setCardsSegment("needs");
  },
};

let paneView: View | null = null;

function decideView(first: readonly string[], look: { answered?: boolean; untilRead?: boolean }, close: () => void, inPane = false): View {
  const order = [...first];
  let at: string | null = first[0] ?? null;
  let mode: "open" | "answered" = look.answered ? "answered" : "open";
  let untilRead = !!look.untilRead && boardRead() !== "loaded";
  /**
   * The card last put on top on purpose (state.ts frontCard): Answered's Reopen, Search or a push while it is open. The
   * pane opened on another waits for it to open, as a link's card read minimised and then opened in full does.
   */
  let front = inPane && at !== app.front ? null : app.front;
  /** Cards' switch as the Feed holds it: a search hit for an answer turns it to Answered (answered.ts showAnswered). */
  let segment = cardsSegment();
  /** The card or list on screen: a card's id, "answered", or null for none yet. */
  let painted: string | null = null;
  // This pane painted the last open card, then its cheer.
  let clearedHere = false;
  // The revision on screen and the read it came from: a redraw held while typing leaves an older revision showing.
  let paintedRev: string | null = null;
  /** The card as drawn: a key answers the revision on screen, as a tap on it does. */
  let shownNeed: ServedNeed | null = null;
  let paintedData = -1;
  let alive = true;
  /** Counted in `mounted`. */
  let up = false;
  /** A phone's Answered is its own screen over the sheet, however it opened: its switch, none open, or Search. */
  let stop = () => {};
  let onAnswered = false;

  const name = h("span", { class: "decide-name" });
  const count = h("span", { class: "decide-count" });
  const skip = h("button", { class: "decide-skip", attrs: { type: "button", "data-use": "decide.skip" }, on: { click: () => move(1) } }, "Skip ›");
  // A chevron down, not an ×: the card's own reject × sits just under it.
  const closeBtn = h("button", { class: "decide-close", attrs: { type: "button", "aria-label": "Close", "data-use": "decide.close" }, on: { click: close } }, svg(ICONS.back, "btn-icon"));
  const seg = (id: typeof mode) =>
    h("button", { class: "decide-seg", attrs: { type: "button", "data-seg": id, "data-use": `decide.seg.${id}` }, on: { click: () => ((untilRead = false), (mode = id), setCardsSegment((segment = id === "answered" ? "done" : "needs")), (painted = null), paint()) } });
  const segs = { open: seg("open"), answered: seg("answered") };
  // In the pane the card wears the open card's wide look (desktop.css .desk-detail).
  const slot = h("div", { class: inPane ? "decide-card deck desk-detail" : "decide-card" });
  // A double tap on an answer lands on the card that slid in under it: the Feed's tap lock holds it here too.
  slot.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof Element) || !event.target.closest(".answer-card") || !answerTapsLocked()) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
  let panel: HTMLElement | null = null;
  let unguard = () => {};
  /**
   * A card with a long read (its scroll runs past its box) gets See it big: the sheet takes the whole screen, its switch
   * and say-line go, and the answers scroll on after the read. Smaller puts it back, and another card or a new open
   * starts small. A wide window's pane has the full column already.
   */
  let isBig = false;
  const big = h("button", { class: "decide-big", attrs: { type: "button", "aria-label": "See it big", "aria-pressed": "false", "data-use": "decide.big" }, on: { click: () => setBig(!isBig) } }, svg(ICONS.expand, "btn-icon"));
  big.hidden = true;
  /** What scrolls: the card's read, or while big the whole card with its answers. */
  const scroller = (): HTMLElement | null => {
    const box = slot.querySelector<HTMLElement>(".card.top");
    return isBig ? (box?.closest<HTMLElement>(".answer-card") ?? null) : box;
  };
  function setBig(on: boolean): void {
    const read = scroller()?.scrollTop ?? 0;
    isBig = on;
    panel?.classList.toggle("is-big", on);
    big.setAttribute("aria-label", on ? "Smaller" : "See it big");
    big.replaceChildren(svg(on ? ICONS.shrink : ICONS.expand, "btn-icon"));
    big.setAttribute("aria-pressed", String(on));
    const into = scroller();
    if (into) into.scrollTop = read;
    edge();
    requestAnimationFrame(fits);
  }
  /** Shows See it big only while the read overflows, and Smaller while big: a mark in the card's tool row, on no line of the read. */
  function fits(): void {
    const box = slot.querySelector<HTMLElement>(".card.top");
    if (!box || !big.isConnected) return;
    big.hidden = !isBig && box.scrollHeight <= box.clientHeight;
  }
  const resized = typeof ResizeObserver === "function" && !inPane ? new ResizeObserver(() => fits()) : null;
  // The sheet and the pane say when the cards shown are as of the last load; before one, the failed read says it.
  const offline = h("div", { class: "decide-offline" });
  const segsRow = h("div", { class: "decide-segs", attrs: { role: "group", "aria-label": "Decide" } }, segs.open, segs.answered);
  /** A clip leaving full screen lets the pane draw what came meanwhile. */
  function fullScreenEnded(): void {
    if (!fullScreenElement()) paint();
  }
  function paintOffline(): void {
    const bar = boardRead() === "loaded" ? offlineBar() : null;
    if ((offline.firstElementChild?.outerHTML ?? "") === (bar?.outerHTML ?? "")) return;
    // A Retry holding the keyboard keeps it in its redrawn bar; the bar gone, the sheet takes it, never the page.
    const held = offline.contains(document.activeElement);
    offline.replaceChildren(...(bar ? [bar] : []));
    if (!held) return;
    const retry = bar?.querySelector<HTMLElement>(".feed-retry");
    if (retry) retry.focus({ preventScroll: true });
    else parkFocus(panel ?? slot);
  }

  /** The next open card after `id` in the sheet's order (`by` -1: before it), round to the start; null when it is the only one. */
  function nextAfter(id: string, open: ReadonlySet<string>, by = 1): string | null {
    const from = order.indexOf(id);
    for (let step = 1; step <= order.length; step++) {
      const next = order[(((from + by * step) % order.length) + order.length) % order.length]!;
      if (next !== id && open.has(next)) return next;
    }
    return null;
  }

  function move(by: number): void {
    // J/K page the open cards; on Answered they leave the list where it is.
    if (mode !== "open") return;
    if (at) at = nextAfter(at, new Set(openCards().map((need) => need.id)), by) ?? at;
    // The card moved to is the one on top, so a push or Search for the one left opens it again.
    if (at) frontCard(at);
    paint();
  }

  /** The pane's keys: J/K move through the open cards, Esc goes back to the home screen, the rest answer as feed.ts cardKey says. */
  function onKey(event: KeyboardEvent): void {
    const need = painted && painted === at && shownNeed?.id === at ? shownNeed : null;
    if (event.key === "Escape" && !modalOpen() && !(need && cardState(need.id).confirm) && !typing(event.target)) {
      event.preventDefault();
      return close();
    }
    cardKey(event, need, slot, move);
  }

  /** Marks a card that runs on past the sheet's foot, so its cut edge fades rather than shows half a control. */
  function edge(): void {
    const box = slot.querySelector<HTMLElement>(".card.top");
    box?.classList.toggle("has-more", box.scrollTop + box.clientHeight < box.scrollHeight - 1);
  }
  slot.addEventListener("scroll", edge, true);
  if (!inPane) slot.addEventListener("scroll", () => fits(), true);
  watchDepth(slot, () => (mode === "answered" ? "answered" : "decide"));

  /** The card on screen for the push watcher, or null while an older revision of it shows. */
  function showing(id: string | null): void {
    current = id;
    if (id) cardShown(id);
    panel?.setAttribute("data-shows-card", id ?? "");
  }

  function paint(): void {
    if (!alive) return;
    const cards = openCards();
    for (const need of cards) if (!order.includes(need.id)) order.push(need.id);
    const open = new Set(cards.map((need) => need.id));
    // Opened before the app had read the board (a cold Cards link): its first read's open cards are what Cards shows,
    // unless the owner picked a side of the switch meanwhile.
    if (untilRead && boardRead() === "loaded") {
      untilRead = false;
      if (mode === "answered" && open.size) mode = "open";
    }
    if (cardsSegment() !== segment) {
      segment = cardsSegment();
      mode = segment === "done" ? "answered" : "open";
    }
    if (app.front !== front && (!app.front || open.has(app.front))) {
      front = app.front;
      if (front) [mode, at] = ["open", front];
    }
    // The desk's pane opens on Answered with none open: its segment says so, so the desk records the Answered it shows.
    if (inPane && (segment === "done") !== (mode === "answered")) {
      setCardsSegment((segment = mode === "answered" ? "done" : "needs"));
      screenMoved();
    }
    if (!inPane && onAnswered !== (mode === "answered")) {
      onAnswered = !onAnswered;
      (onAnswered ? enterScreen : leaveScreen)("answered");
    }
    // Before the board has loaded there is nothing to count: a card's shape while it reads, Try again if it could not.
    const unread = boardRead() !== "loaded" && (untilRead || mode === "open");
    segsRow.hidden = unread;
    if (unread) {
      slot.classList.add("is-list");
      return paintList(readingView(), NEEDS_YOU, `read-${boardRead()}`);
    }
    const answered = answeredCount();
    // None open with some minimised: the tab says those, so it never reads Open 0 over the line that they wait. Open N
    // itself stays the open cards, Decide N's and the sheet's "of N decisions".
    const minimised = cards.length ? 0 : minimisedWaiting().length;
    segs.open.textContent = minimised ? `Minimised ${minimised}` : openTab(cards.length);
    segs.answered.textContent = answered === null ? "Answered" : answeredTab(answered);
    for (const id of ["open", "answered"] as const) segs[id].setAttribute("aria-pressed", String(mode === id));
    slot.classList.toggle("is-list", mode === "answered" || !open.size);
    if (mode === "answered") return paintList(answeredList(), "Answered", "answered");
    // Answered (or gone from the deck): the next one, or the sheet closes with none left.
    if (!at || !open.has(at)) {
      const next = at ? nextAfter(at, open) : (order.find((id) => open.has(id)) ?? null);
      // None open: the last one answered here closes the sheet; the pane cheers it (decision
      // ), then says so, as either does opened or switched to with none.
      if (!next && painted && painted !== "none" && !inPane) return close();
      const cheer = !next && inPane ? cheerView(minimisedWaiting().length) : null;
      if (cheer) {
        clearedHere ||= !!painted && !["none", "answered", "cheer"].includes(painted);
        return paintList(cheer, NEEDS_YOU, "cheer");
      }
      // The cheer over, the pane that took the last answer goes back to the home screen; a minimised card still waiting keeps
      // it here, for Show them ›, as does a card on its way. Opened during another pane's cheer, it stays too.
      if (!next && clearedHere && painted === "cheer" && !minimisedWaiting().length && !cardOnItsWay()) return close();
      if (!next) return paintList(noneOpen(), NEEDS_YOU, "none");
      at = next;
    }
    count.hidden = false;
    const need = cards.find((one) => one.id === at)!;
    const shown = order.filter((id) => open.has(id));
    const repo = need.repo ?? NO_REPO;
    name.textContent = projectName(homeOf({ repo, project: (app.workers?.workers ?? []).find((w) => w.repo === repo && w.chat === need.chat)?.project }));
    count.textContent = `${shown.indexOf(at) + 1} of ${shown.length} · ${need.chat ? chatName(need.chat) : RIVET_NAME}`;
    skip.hidden = shown.length < 2;
    // A note typed in the card's box holds the redraw, as the Feed holds its own; so does a clip in full screen.
    const typing = document.activeElement instanceof HTMLTextAreaElement && slot.contains(document.activeElement);
    // While held, the card counts as on screen only if its revision is the one showing, so a push for a newer one rings.
    if (painted === at && (typing || fullScreenElement())) return showing(paintedRev === need.rev ? at : null);
    // The place the card was read to, taken before building the new one moves its clip out and shortens it.
    const read = painted === at ? (scroller()?.scrollTop ?? 0) : 0;
    // And the answers' own tray, which scrolls on its own once four or more cap it.
    const tray = painted === at ? (slot.querySelector<HTMLElement>(".choices")?.scrollTop ?? 0) : 0;
    // Taken before building too: the new card takes the clip, and a clip's focused button loses the keyboard with it.
    const refocus = keepFocus(slot);
    const card = answerCard(need);
    if (inPane) card.append(keyHints(need));
    paintedData = app.dataRev;
    // A redraw that changes nothing leaves the card alone, so a clip playing in it plays on.
    const drawn = slot.lastElementChild;
    if (painted === at && drawn && bare(drawn) === bare(card)) return showing(at);
    const moved = painted !== at;
    if (moved && isBig) setBig(false);
    if (!inPane) card.querySelector(".card-head .head-tools")?.prepend(big);
    slot.replaceChildren(card);
    painted = at;
    paintedRev = need.rev;
    shownNeed = need;
    showing(at);
    if (moved) slot.scrollTop = 0;
    // The same card drawn again (its clip moved into the new one, so the compare differs) keeps that place.
    const box = slot.querySelector<HTMLElement>(".card.top");
    const into = scroller();
    if (into && read) into.scrollTop = read;
    const answers = slot.querySelector<HTMLElement>(".choices");
    if (answers && tray) answers.scrollTop = tray;
    refocus();
    requestAnimationFrame(edge);
    if (!inPane) {
      resized?.disconnect();
      resized?.observe(slot);
      for (const part of box?.children ?? []) resized?.observe(part);
      requestAnimationFrame(fits);
    }
    // A clip no longer on screen (a card that went, or one a new revision replaced) stops; the one still shown plays on.
    stopCardMedia();
  }

  /** Answered's rows (Reopen, Send again) or the line saying nothing is open: no card is on screen. */
  /**
   * None open: "Nothing needs you.", or with minimised cards waiting
   * "N cards wait for you, all minimised." and "Show them ›", which opens the first one here.
   */
  function noneOpen(): HTMLElement {
    const waiting = minimisedWaiting();
    if (!waiting.length) return h("p", { class: "feed-quiet decide-none" }, NOTHING_NEEDS_YOU);
    const show = () => {
      // Read again at the tap: a redraw that changed nothing keeps this button.
      const first = minimisedWaiting()[0];
      if (!first) return paint();
      unminimise(first.id);
      [mode, at] = ["open", first.id];
      // Every count hears it, so Decide N on the dock and the map's ? show the card as the sheet does (its paint too).
      changed();
    };
    return h(
      "div",
      { class: "decide-none" },
      h("p", { class: "feed-quiet decide-none-line" }, allMinimised(waiting.length)),
      h("p", { class: "clear-show" }, h("button", { class: "clear-min", attrs: { type: "button", "data-key": "show-minimised", "data-use": "decide.show-minimised" }, on: { click: show } }, showMinimised(waiting.length))),
    );
  }

  function readingView(): HTMLElement {
    const read = boardRead();
    if (read === "failed")
      return h(
        "div",
        { class: "decide-failed" },
        rivet("thinking", { size: 64 }),
        h("p", { class: "feed-quiet" }, "Couldn't read your cards."),
        h("button", { class: "btn", attrs: { type: "button", "data-use": "decide.retry" }, on: { click: () => void readAgain() } }, "Try again"),
      );
    return h(
      "div",
      { class: "decide-wait" },
      h("div", { class: "decide-wait-card", attrs: { "aria-hidden": "true" } }, h("span", {}), h("span", {}), h("span", {}), h("span", { class: "decide-wait-answer" })),
      h("p", { class: "feed-quiet", attrs: { role: "status" } }, read === "slow" ? "Still reading…" : "Reading your cards…"),
    );
  }

  function paintList(list: HTMLElement, title: string, key: string): void {
    current = null;
    panel?.removeAttribute("data-shows-card");
    name.textContent = title;
    count.hidden = true;
    skip.hidden = true;
    if (painted === key && slot.firstElementChild?.outerHTML === list.outerHTML) return;
    if (painted !== key) slot.scrollTop = 0;
    if (isBig) setBig(false);
    const refocus = keepFocus(slot);
    slot.replaceChildren(list);
    refocus();
    painted = key;
    stopCardMedia();
  }

  return {
    mount(el) {
      if (!up) mounted++;
      up = true;
      panel = inPane ? el : el.closest<HTMLElement>(".sheet");
      if (inPane) {
        el.classList.add("decide-pane");
        document.addEventListener("keydown", onKey);
        document.addEventListener("keyup", feedKeyUp);
        // Capture: the iPhone player's end event does not bubble.
        for (const type of FULL_SCREEN_EVENTS) document.addEventListener(type, fullScreenEnded, true);
        unguard = guardTaps(el);
      }
      const parts: HTMLElement[] = [
        h(
          "header",
          { class: "decide-head" },
          rivet("asking", { tone: "agent", size: 40, className: "decide-face" }),
          h("div", { class: "decide-who" }, name, count),
          skip,
          // The pane's way back is the header's ‹ Your asks (shell.ts).
          inPane ? null : closeBtn,
        ),
        segsRow,
        offline,
        slot,
      ];
      el.replaceChildren(...parts);
      // A poll that read nothing new leaves the card alone (as the Feed's does): building it again would move its clip.
      // Before the first board, every poll is news: it read the board or failed to.
      const unsubscribe = subscribe((reason) => {
        paintOffline();
        if (reason !== "poll" || app.dataRev !== paintedData || boardRead() !== "loaded") paint();
      });
      // Ops reads GitHub on its own clock: a fresh read redraws a merge card's checks and holds (proofBlock).
      const unwatchOps = watchOps(paint);
      stop = () => {
        unsubscribe();
        unwatchOps();
      };
      paintOffline();
      paint();
      if (!inPane) closeBtn.focus();
    },
    unmount() {
      if (up) mounted--;
      up = false;
      alive = false;
      if (onAnswered) leaveScreen("answered");
      stop();
      resized?.disconnect();
      current = null;
      if (inPane) {
        document.removeEventListener("keydown", onKey);
        document.removeEventListener("keyup", feedKeyUp);
        for (const type of FULL_SCREEN_EVENTS) document.removeEventListener(type, fullScreenEnded, true);
        releaseKeys();
        unguard();
        panel?.classList.remove("decide-pane");
        panel?.removeAttribute("data-shows-card");
      }
      slot.replaceChildren();
      stopCardMedia();
    },
  };
}

/**
 * A card's push or `?card=` link on a phone opens its Decide sheet over Progress, one tap from the answer; a wide window
 * and an update card open it as the Feed does (showCard). `picked`: as showCard's.
 */
export function showPushed(id: string, picked = true): void {
  leaveOverlays(() => {
    const need = app.board?.board?.needs.find((one) => one.id === id);
    if (isDesk() || (need && isUpdate(need))) return showCard(id, picked);
    frontCard(id);
    if (picked) unminimise(id);
    app.tab = "progress";
    changed();
    if (need) return openDecide([id]);
    // A card added a moment ago may not be on the board this app last read: read it again and open it, unless the owner
    // has moved on meanwhile.
    const stamp = navStamp();
    void refresh().then(() => {
      if (navStamp() === stamp && app.board?.board?.needs.some((one) => one.id === id)) showPushed(id, picked);
    });
  });
}
