import "./progress.css";
import "./floor.css";

import { RIVET_NAME } from "../../../src/shared/names.js";
import { when } from "../../../src/shared/when.js";
import { h, ICONS, keepFocus, svg } from "../dom.js";
import { opsData, watchOps } from "../ops-data.js";
import { rivet, setMood, type Mood } from "../rivet/rivet.js";
import { app, boardRead, changed, go, navigated, setOpsPage, subscribe } from "../state.js";
import { watchDepth } from "../usage.js";
import * as chat from "./chat.js";
import { askingCards, openCards, openDecide } from "./decide-sheet.js";
import * as feed from "./feed.js";
import * as more from "./more.js";
import * as ops from "./ops.js";
import { parked } from "./ops-status.js";
import { afterFirstFrame, afterSlide, closeTallSheet, leaveTallSheet, openTallSheet, swipeOpens } from "./sheet.js";
import { mountPaperTown } from "./town-paper.js";
import { closeWorkerSheet } from "./worker-sheet.js";
import * as asks from "./your-asks.js";

// The home screen: on a phone the map is the app; the dock holds Decide N and Rivet, and every other page is in the
// menu (menu.ts). Cards, Chat and a page are sheets over it, opened by their tab ids (state.ts landing), so a link, a
// push or a saved tab lands where it went.
// The band is the menu button and Rivet's name, with one line under it only while something is for you; Usage heads
// the menu.
// A wide window shows the home screen in its middle column: the menu is on the rail and Rivet is the pane beside it, and
// Decide N sits at the column's foot (shell.ts).

let stop: (() => void) | null = null;
/** The home screen's Plan: a page's sheet holds the one Ops view while it is open, so Plan comes back when it goes. */
let planHost: HTMLElement | null = null;

export function mount(el: HTMLElement, wide = false): void {
  unmount();
  const town = mountPaperTown({ flow: true });
  const plan = h("div", { class: "progress-plan" });
  const foot = wide ? h("div", { class: "home-wide-dock" }) : null;
  const page = h("div", { class: "progress home" }, h("div", { class: "progress-scene" }, town.el), plan, foot);
  el.replaceChildren(page);
  planHost = plan;
  setOpsPage("plan");
  ops.mount(plan);
  const paint = () => {
    if (foot) {
      const refocus = keepFocus(foot);
      const decide = dock()[0]!;
      decide.dataset.use = "floor.wide.decide";
      foot.replaceChildren(decide);
      refocus();
    }
    paintLine(line());
  };
  // One paint per poll: the status line the Town holds repaints on the same board and Ops reads, and a jobs or
  // schedules read that changes it says changed(), so following it as well painted the home screen twice.
  const stops = [subscribe(paint), watchOps(paint), asks.watchAsks(paint)];
  paint();
  stop = () => {
    for (const one of stops) one();
    town.stop();
  };
}

export function refresh(): Promise<unknown> {
  return Promise.all([asks.refresh(), ops.refresh(), feed.refresh()]);
}

export function unmount(): void {
  closeWorkerSheet("yard");
  feed.unmount();
  ops.unmount();
  planHost = null;
  stop?.();
  stop = null;
}

// Made on first use: the phone's band (shell.ts) holds them and the home screen paints the line.
let face: HTMLElement | null = null;
let lineEl: HTMLElement | null = null;

/** Happy once a board has been read; the desk's neutral face while it reads or cannot (progress-mark.ts clearWords). */
const readMood = (): Mood => (boardRead() === "loaded" ? "happy" : "thinking");

/** The band's middle: Rivet's face and name. */
export function title(): HTMLElement {
  face ??= h("h1", { class: "home-title" }, rivet(readMood(), { size: 34, className: "home-title-face" }), h("span", {}, RIVET_NAME));
  const look = face.querySelector<HTMLElement>(".home-title-face")!;
  if (!look.classList.contains(`is-${readMood()}`)) setMood(look, readMood());
  return face;
}

/** The band's one line under the title, only while something is for you; it opens and closes rather than jumping. */
export function line(): HTMLElement {
  lineEl ??= h("div", { class: "home-line", attrs: { inert: "", "aria-hidden": "true" } }, h("div", { class: "home-line-fold" }));
  return lineEl;
}

const HOUR_MS = 60 * 60 * 1000;

export interface Said {
  key: "offline" | "cards" | "due" | "machine" | "usage";
  tone: "cards" | "due" | "warn" | "bad";
  /** The part never cut: the time of a job due. */
  lead: string | null;
  text: string;
  label: string;
  open: (() => void) | null;
}

/** The line's pills: the one thing `said` names, then the alerts. */
function lineParts(now: number): Said[] {
  return [said(now), ...alerts()].filter((part) => part !== null);
}

/** A read that failed after the cards loaded: the phone's line and the wide header show it. */
export function alerts(): Said[] {
  if (app.loadedAt === null || boardRead() !== "loaded" || !(app.offline || app.notice)) return [];
  const text = `${app.offline === "offline" ? "Offline" : `Can't reach ${RIVET_NAME}`} · cards as of ${when(app.loadedAt)}`;
  return [{ key: "offline", tone: "warn", lead: null, text, label: text, open: null }];
}

/** The one thing the line says, the first of: cards waiting, a job due within the hour, a machine amber or red, Usage near its cap. */
function said(now: number): Said | null {
  const n = askingCards().length;
  if (n)
    return {
      key: "cards",
      tone: "cards",
      lead: null,
      text: `${n} ${n === 1 ? "card waits" : "cards wait"} for you`,
      label: `${n} ${n === 1 ? "card waits" : "cards wait"} for you, open Decide`,
      open: () => {
        feed.pickSegment("needs");
        openNow();
      },
    };
  const job = asks.dueSoon(now, HOUR_MS);
  if (job) {
    const time = job.time.charAt(0).toUpperCase() + job.time.slice(1);
    return { key: "due", tone: "due", lead: time, text: job.title, label: `${time}: ${job.title}`, open: job.open };
  }
  // Machines only: a phone with notifications off is a Machines row too, but no machine, and Settings mends it. A
  // fault you parked stays calm here as on Plan (ops-status.ts parked).
  const wrong = ops.wrongRows(opsData.ops, "machines");
  const rows = wrong.rows.filter((row) => row.kind !== "push" && !parked(row.item));
  // Every machine counts, not just the rows shown.
  const total = wrong.count - (wrong.rows.length - rows.length);
  const first = rows[0];
  if (first) {
    const text = `${first.title} needs a look${total > 1 ? ` · ${total - 1} more` : ""}`;
    return { key: "machine", tone: first.tone, lead: null, text, label: `${text}, open Machines`, open: () => goSheet("machines") };
  }
  // An old reading is the notices' to say: near the cap is said only of a current one.
  const claude = opsData.ops?.claude ?? null;
  const week = claude && !ops.usageStale(claude) ? ops.weekTotal(claude.limits) : null;
  if (week && week.tone !== "ok")
    return { key: "usage", tone: week.tone, lead: null, text: `Usage ${week.n} ${week.of} · near the cap`, label: `Usage, Claude ${week.text}, open Usage`, open: () => goSheet("usage") };
  return null;
}

/** Shows the line's pills, or folds it away with their words kept so it fades out as it was. */
function paintLine(el: HTMLElement): void {
  const all = lineParts(Date.now());
  const on = all.length > 0;
  el.classList.toggle("is-on", on);
  el.toggleAttribute("inert", !on);
  if (on) el.removeAttribute("aria-hidden");
  else el.setAttribute("aria-hidden", "true");
  if (!on) return;
  const fold = el.firstElementChild as HTMLElement;
  const refocus = keepFocus(fold);
  fold.replaceChildren(...all.map(pill));
  refocus();
}

function pill(now: Said): HTMLElement {
  const parts = [
    h("span", { class: "home-line-dot", attrs: { "aria-hidden": "true" } }),
    now.lead ? h("span", { class: "home-line-lead" }, now.lead, " ·") : null,
    h("span", { class: "home-line-text" }, now.text),
    now.open ? h("span", { class: "home-line-more", attrs: { "aria-hidden": "true" } }, "›") : null,
  ];
  const cls = `home-line-say t-${now.tone}`;
  return now.open
    ? h("button", { class: cls, attrs: { type: "button", "data-key": `line-${now.key}`, "data-use": `floor.line.${now.key}`, "aria-label": now.label }, on: { click: now.open } }, ...parts)
    : h("p", { class: cls, attrs: { "data-key": `line-${now.key}`, "aria-label": now.label } }, ...parts);
}

/** Moves to a tab id or page and opens its sheet: the menu's rows and tiles, the band's line and Rivet go through here. */
export function goSheet(id: string): void {
  go(id);
  openNow();
}

/**
 * Opens the sheet `app.tab` now names. On a phone it opens at once and the redraw that follows a move (the home screen, its
 * dock, the band) waits until it has slid up: nothing on the home screen changed, and redrawing it first held the slide's
 * first frame back. A wide window shows the tab in its middle column, which is that redraw.
 */
function openNow(): void {
  if (onDesk) return changed();
  navigated();
  syncSheets(false);
  afterSlide(() => changed());
}

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
  // A swipe up off either brings its sheet up under the finger.

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

const heading = (text: string) => h("h2", { class: "home-sheet-title" }, text);

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

/** Closing a tab sheet (Back, a drag, Close, the last decision answered) leaves the bare home screen, redrawn once it has slid off. */
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
  const title = heading("");
  watchDepth(host, () => (app.morePage === "code" ? "ops.timeline" : null));
  let stopHead = () => {};
  const paintHead = () => {
    title.textContent = app.morePage ? more.PAGE_NAMES[app.morePage] : "";
  };
  openTallSheet(
    app.morePage ? more.PAGE_NAMES[app.morePage] : "Page",
    {
      mount(el) {
        ops.unmount();
        planHost?.replaceChildren();
        el.replaceChildren(head(title), host);
        more.mount(host);
        stopHead = subscribe(paintHead);
        paintHead();
      },
      unmount() {
        stopHead();
        more.unmount();
        if (!planHost) return;
        setOpsPage("plan");
        ops.mount(planHost);
      },
    },
    { className: "home-sheet page-sheet", onClose, use: "floor.page" },
  );
}
