import "./progress.css";
import "./home.css";

import { RIVET_NAME } from "../../../src/shared/names.js";
import { h, ICONS, keepFocus, svg } from "../dom.js";
import { rivet, type Mood } from "../rivet/rivet.js";
import { app, boardRead, changed, go, navigated, subscribe } from "../state.js";
import { watchDepth } from "../usage.js";
import * as chat from "./chat.js";
import { askingCards, openCards, openDecide } from "./decide-sheet.js";
import * as feed from "./feed.js";
import * as more from "./more.js";
import { afterFirstFrame, afterSlide, closeTallSheet, leaveTallSheet, openTallSheet, swipeOpens } from "./sheet.js";
import { closeWorkerSheet } from "./worker-sheet.js";
import * as asks from "./your-asks.js";

// The home screen: your asks. On a phone the dock under it holds Decide N and Rivet, and every page is in the menu
// (menu.ts). Cards, Chat and a page are sheets over it, opened by their tab ids (state.ts landing), so a link, a push
// or a saved tab lands where it went. A wide window shows it in its middle column: the menu is on the rail and Rivet is
// the pane beside it, and Decide N sits at the column's foot (shell.ts).

/** The home screen's name: its menu row and the wide window's header. */
export const TITLE = "Your asks";

let stop: (() => void) | null = null;

export function mount(el: HTMLElement, wide = false): void {
  unmount();
  const list = h("div", { class: "home-asks" });
  const foot = wide ? h("div", { class: "home-wide-dock" }) : null;
  el.replaceChildren(h("div", { class: "home" }, list, foot));
  asks.mount(list);
  const paint = () => {
    if (!foot) return;
    const refocus = keepFocus(foot);
    const decide = dock()[0]!;
    decide.dataset.use = "floor.wide.decide";
    foot.replaceChildren(decide);
    refocus();
  };
  const stopPaint = subscribe(paint);
  paint();
  stop = () => {
    stopPaint();
    asks.unmount();
  };
}

export function refresh(): Promise<unknown> {
  return Promise.all([asks.refresh(), feed.refresh()]);
}

export function unmount(): void {
  closeWorkerSheet("asks");
  stop?.();
  stop = null;
}

/** Moves to a tab id or page and opens its sheet: the menu's rows and Rivet go through here. */
export function goSheet(id: string): void {
  go(id);
  openNow();
}

/**
 * Opens the sheet `app.tab` now names. On a phone it opens at once and the redraw that follows a move waits until it
 * has slid up, so the slide's first frame is not held back. A wide window shows the tab in its middle column, which is
 * that redraw.
 */
function openNow(): void {
  if (onDesk) return changed();
  navigated();
  syncSheets(false);
  afterSlide(() => changed());
}

/** Happy once a board has been read; the desk's neutral face while it reads or cannot (progress-mark.ts clearWords). */
const readMood = (): Mood => (boardRead() === "loaded" ? "happy" : "thinking");

/** The dock: Decide N, the open decision cards the sheet walks through, and Rivet with his unread dot; a tap or a swipe up opens each. */
export function dock(): HTMLElement[] {
  const n = askingCards().length;
  const unread = app.chatUnread;
  // No count before the board has loaded: a 0 would say nothing waits.
  const read = boardRead() === "loaded";
  const buttons = [
    h(
      "button",
      {
        class: `home-decide${n && read ? " has-cards" : ""}`,
        attrs: { type: "button", "data-key": "decide", "data-use": "floor.dock.decide", "aria-label": read ? `Decide, ${n} ${n === 1 ? "decision" : "decisions"}` : "Decide, not read yet" },
        on: {
          click: () => {
            feed.pickSegment("needs");
            openNow();
          },
        },
      },
      h("span", {}, "Decide"),
      h("span", { class: "home-decide-n" }, read ? String(n) : "–"),
      h("span", { attrs: { "aria-hidden": "true" } }, "›"),
    ),
    h(
      "button",
      {
        class: "home-rivet",
        attrs: { type: "button", "data-key": "rivet", "data-use": "floor.dock.rivet", "aria-label": unread ? `${RIVET_NAME}, ${unread} unread` : RIVET_NAME },
        on: { click: () => goSheet("chat") },
      },
      rivet(readMood(), { size: 30, className: "home-rivet-face" }),
      h("span", {}, RIVET_NAME),
      unread ? h("span", { class: "home-dot", attrs: { "aria-hidden": "true" } }) : null,
    ),
  ];
  for (const button of buttons) swipeOpens(button);
  return buttons;
}

// ---- The sheets

function closeButton(): HTMLElement {
  return h("button", { class: "decide-close", attrs: { type: "button", "data-use": "floor.list.close", "aria-label": "Close" }, on: { click: () => closeTallSheet() } }, svg(ICONS.back, "btn-icon"));
}

function head(title: HTMLElement, lead: HTMLElement | null = null): HTMLElement {
  return h("header", { class: "home-sheet-head" }, lead, title, closeButton());
}

/** The sheets an app tab id opens over the home screen: Cards is the Decide sheet, Chat is Rivet's, More is the page's. */
type TabSheet = "cards" | "chat" | "more";
const TAB_SHEETS: readonly string[] = ["cards", "chat", "more"];

/** The tab sheet open, or on its way (a sheet before it still leaving). */
let owned: TabSheet | null = null;
/** The shell's last word on the window: wide shows tabs in its middle column, not as sheets. */
let onDesk = false;

/** Opens, swaps or closes the tab sheet `app.tab` names; a wide window has none, as each shows in its middle column. */
export function syncSheets(desk: boolean): void {
  onDesk = desk;
  const want = !desk && TAB_SHEETS.includes(app.tab) ? (app.tab as TabSheet) : null;
  if (want === owned) return;
  if (owned) {
    owned = null;
    if (!want) return closeTallSheet();
  }
  if (!want) return;
  owned = want;
  // Any sheet open goes first, its Back landed, so the new one's Back entry is its own.
  leaveTallSheet(() => owned === want && openTabSheet(want));
}

/** Closing a tab sheet (Back, a drag, Close, the last decision answered) leaves the home screen, redrawn once it has slid off. */
function closed(id: TabSheet): () => void {
  return () => {
    if (owned !== id) return;
    owned = null;
    if (app.tab !== id) return;
    app.tab = "progress";
    afterSlide(() => changed(), true);
  };
}

function openTabSheet(id: TabSheet): void {
  if (id === "cards") {
    const cards = openCards();
    const first = cards.find((need) => need.id === app.front) ?? cards[0];
    const done = feed.cardsSegment() === "done";
    return openDecide(first ? [first.id] : [], { answered: !first || done, untilRead: !first && !done, onClose: closed(id) });
  }
  if (id === "chat") return openRivet(closed(id));
  openPageSheet(closed(id));
}

function openRivet(onClose: () => void): void {
  const host = h("div", { class: "home-chat" });
  openTallSheet(
    RIVET_NAME,
    {
      mount(el) {
        // What the push watcher counts as on screen (push.ts watchViewing): the conversation open in here.
        el.closest(".sheet")?.setAttribute("data-shows-chat", "");
        const title = h("span", { class: "home-sheet-title" });
        el.replaceChildren(head(title, rivet("happy", { size: 36, className: "home-sheet-face" })), host);
        chat.mount(host, afterFirstFrame);
        // One head row: his face, the chat's own title and Read aloud, then Close.
        const chatHead = host.querySelector(".chat-head");
        if (chatHead) title.replaceWith(chatHead);
      },
      unmount: () => chat.unmount(),
    },
    { className: "home-sheet rivet-sheet", onClose, historyDepth: chat.historyDepth, use: "floor.rivet" },
  );
}

/** The page `app.morePage` names as a sheet, under its name; Close goes back to the home screen. */
function openPageSheet(onClose: () => void): void {
  const host = h("div", { class: "home-sheet-body" });
  watchDepth(host, () => (app.morePage === "code" ? "ops.timeline" : null));
  const title = h("h2", { class: "home-sheet-title" });
  let stopHead = () => {};
  const paintHead = () => {
    title.textContent = app.morePage ? more.PAGE_NAMES[app.morePage] : "";
  };
  openTallSheet(
    app.morePage ? more.PAGE_NAMES[app.morePage] : "Page",
    {
      mount(el) {
        el.replaceChildren(head(title), host);
        more.mount(host);
        stopHead = subscribe(paintHead);
        paintHead();
      },
      unmount() {
        stopHead();
        more.unmount();
      },
    },
    { className: "home-sheet page-sheet", onClose, use: "floor.page" },
  );
}
