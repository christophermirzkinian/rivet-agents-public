import "./desktop.css";

import { APP_NAME, RIVET_NAME } from "../../../src/shared/names.js";
import { undoLast } from "./feed.js";
import { DESK_QUERY, typing } from "../desk.js";
import { forgetLayout, paneOpen, readLayout, toggleFocus, togglePane, WIDE_RAIL_QUERY, writeLayout, type Pane } from "../desk-layout.js";
import * as cmd from "../command-api.js";
import { h, ICONS, keepFocus, modalOpen, svg } from "../dom.js";
import { watchOps } from "../ops-data.js";
import { attachPullRefresh } from "../pull-refresh.js";
import { app, changed, go, macOffline, subscribe, TABS, type Tab } from "../state.js";
import { useTap, watchDepth } from "../usage.js";
import * as chat from "./chat.js";
import * as decide from "./decide-sheet.js";
import * as floor from "./floor.js";
import * as home from "./home.js";
import * as more from "./more.js";
import { applyWidths, MIN_CARD, PANE_ICONS, paneFold, paneGrip, paneStrip, updateLayout } from "./panes.js";
import { menuButton, menuList } from "./menu.js";
import { keepAsks } from "./your-asks.js";
import * as search from "./search.js";
import { closeSheet, openSheet } from "./sheet.js";
import * as shortcuts from "./shortcuts.js";
import { mountToasts } from "./toast.js";
import { closeWorkerSheet } from "./worker-sheet.js";
import type { View } from "./view.js";

/**
 * What the middle shows. A phone shows the home screen whatever the tab: Cards, Chat and a page are sheets over it
 * (home.ts). A wide window shows the home screen with Decide N under it, a decision where it was, or a page from the
 * menu; chat is the pane beside them.
 */
type Shown = "home" | "wide-home" | "decide" | "page";
const wideHome: View = { mount: (el) => home.mount(el, true), unmount: home.unmount, refresh: home.refresh };
const VIEWS: Record<Shown, View> = { home, "wide-home": wideHome, decide: decide.pane, page: more };
const WIDE: Record<Exclude<Tab, "chat">, Shown> = { progress: "wide-home", cards: "decide", more: "page" };
/** The wide window's header: your asks, a decision, or the page open. */
export const TITLES: Record<Exclude<Tab, "chat" | "more">, string> = { progress: home.TITLE, cards: "Decide" };

/** The header's title: the tab's name, or the page's. */
export function title(): string {
  if (app.tab === "chat") return TITLES.progress;
  return app.tab === "more" ? (app.morePage ? more.PAGE_NAMES[app.morePage] : TITLES.progress) : TITLES[app.tab];
}

/**
 * The signed-in app: header, the active tab, toasts and the tab bar. A wide window turns the tab bar into a rail and
 * keeps chat open alongside; a phone shows the home screen, the band over it and the dock under it. Returns its teardown.
 */
export function mountShell(root: HTMLElement): () => void {
  const header = h("header", { class: "topbar" });
  const view = h("main", { class: "view" });
  const side = h("aside", { class: "side", attrs: { "aria-label": `Chat with ${RIVET_NAME}` } });
  const toasts = h("div", { class: "toasts", attrs: { "aria-live": "polite" } });
  const tabs = h("nav", { class: "tabs", attrs: { "aria-label": "Sections" } });
  side.hidden = true;
  root.replaceChildren(header, view, side, toasts, tabs);
  root.classList.add("signed-in");
  mountToasts(toasts);

  const wide = window.matchMedia?.(DESK_QUERY);
  const railWide = window.matchMedia?.(WIDE_RAIL_QUERY);
  forgetLayout();
  // What the side column holds: chat itself, or the strip chat leaves when collapsed.
  let sideHolds: "none" | "chat" | "strip" = "none";
  let shown: Shown | null = null;
  let sheetUp = false;
  const unread = chatWatcher();
  watchDepth(view);
  const pull = attachPullRefresh(view, root, () => {
    useTap("floor.pull-refresh");
    return shown ? VIEWS[shown].refresh?.() : undefined;
  });
  const toggle = (pane: Pane) => updateLayout((layout) => togglePane(layout, pane, railWide?.matches ?? false));
  const focus = () => updateLayout(toggleFocus);
  const chatGrip = paneGrip(
    "chat",
    "chat",
    (x) => side.getBoundingClientRect().right - x,
    () => view.getBoundingClientRect().width + side.getBoundingClientRect().width - MIN_CARD,
  );
  const render = () => {
    const desk = wide?.matches ?? false;
    document.documentElement.classList.toggle("desktop", desk);
    // An old tab id (a saved session, a link, a notification) lands where its page went (state.ts landing).
    if (!(TABS as readonly string[]).includes(app.tab)) go(app.tab);
    // A page tab with no page is the home screen.
    if (app.tab === "more" && !app.morePage) app.tab = "progress";
    // On a wide window chat lives alongside, so the Chat tab (a notification's, say) opens it there, beside your asks.
    if (desk && app.tab === "chat") {
      app.tab = "progress";
      writeLayout({ ...readLayout(), focus: false, chat: true });
    }
    const layout = readLayout();
    const isWide = railWide?.matches ?? false;
    const open = (pane: Pane) => desk && paneOpen(layout, pane, isWide);
    root.classList.toggle("chat-open", open("chat"));
    root.classList.toggle("chat-collapsed", desk && !open("chat"));
    root.classList.toggle("rail-icons", desk && !open("rail"));
    root.classList.toggle("desk-focus", desk && layout.focus);
    applyWidths(desk ? layout : null);
    // A redraw keeps the keyboard on the header or rail control it was on (dom.ts keepFocus).
    const refocus = [keepFocus(header), keepFocus(tabs), keepFocus(side)];
    renderHeader(header, desk, layout.focus, focus);
    renderTabs(tabs, desk, open("chat"), () => toggle("chat"), open("rail"), () => toggle("rail"));
    // The tab view swaps first: widening on the Chat tab must let go of chat before the side column mounts it, and so
    // must the home screen's Rivet sheet; on a phone the sheet opens over the home screen once it is there.
    if (desk) home.syncSheets(true);
    const next: Shown = desk && app.tab !== "chat" ? WIDE[app.tab] : "home";
    if (shown !== next) {
      if (shown) VIEWS[shown].unmount();
      pull.reset();
      shown = next;
      view.scrollTop = 0;
      view.dataset.tab = next === "wide-home" ? "home" : next;
      view.replaceChildren();
      VIEWS[next].mount(view);
    }
    if (!desk) home.syncSheets(false);
    // A sheet opening over the home screen mid-pull leaves it at rest, as a tab swap does.
    if (!desk && app.tab !== "progress" && !sheetUp) pull.reset();
    sheetUp = !desk && app.tab !== "progress";
    const holds = !desk ? "none" : open("chat") ? "chat" : "strip";
    unread.watch(holds === "strip");
    if (holds !== sideHolds) {
      if (sideHolds === "chat") chat.unmount();
      sideHolds = holds;
      side.hidden = holds === "none";
      side.replaceChildren();
      if (holds === "chat") {
        chat.mount(side);
        side.append(chatGrip, paneFold({ pane: "chat", label: "Chat", open: true, shortcut: "]", onToggle: () => toggle("chat") }));
      }
    }
    if (holds === "strip") {
      side.replaceChildren(
        paneStrip({ pane: "chat", label: "Chat", icon: ICONS.note, dot: unread.fresh(), shortcut: "]", onOpen: () => toggle("chat") }),
      );
    }
    for (const put of refocus) put();
  };
  const KEY_USE: Record<string, string> = { "/": "shell.key.search", "?": "shell.key.shortcuts", "]": "shell.key.chat-pane", "\\": "shell.key.rail", f: "shell.key.focus" };
  const PANE_KEYS: Record<string, () => void> = {
    "/": () => openSheet("Search", search, "Close", undefined, { use: "search" }),
    "?": () => openSheet("Keyboard shortcuts", shortcuts, "Close", undefined, { use: "shortcuts" }),
    "]": () => toggle("chat"),
    "\\": () => toggle("rail"),
    f: focus,
  };
  const onKey = (event: KeyboardEvent) => {
    if (!(wide?.matches ?? false) || event.metaKey || event.ctrlKey || event.altKey || modalOpen() || typing(event.target)) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    // Decide's keys go with it, and the last card's Undo has a second left on the home screen.
    if ((key === "z" || key === "u") && app.tab === "progress" && !event.repeat) return useTap("cards.key.undo"), undoLast();
    const run = PANE_KEYS[key];
    if (!run || event.repeat) return;
    event.preventDefault();
    useTap(KEY_USE[key]!);
    run();
  };
  const onWidth = () => changed();
  const unsubscribe = subscribe(render);
  const unwatchAsks = keepAsks(render);
  const unwatchOps = watchOps(render);
  const unwatchLine = floor.watchLine();
  wide?.addEventListener?.("change", onWidth);
  railWide?.addEventListener?.("change", onWidth);
  document.addEventListener("keydown", onKey);
  render();
  return () => {
    unsubscribe();
    unread.watch(false);
    unwatchAsks();
    unwatchOps();
    unwatchLine();
    wide?.removeEventListener?.("change", onWidth);
    railWide?.removeEventListener?.("change", onWidth);
    document.removeEventListener("keydown", onKey);
    pull.detach();
    home.syncSheets(true);
    if (shown) VIEWS[shown].unmount();
    if (sideHolds === "chat") chat.unmount();
    closeSheet();
    closeWorkerSheet();
    mountToasts(null);
    applyWidths(null);
    document.documentElement.classList.remove("pane-resizing");
    root.classList.remove("signed-in", "chat-open", "chat-collapsed", "rail-icons", "desk-focus");
    document.documentElement.classList.remove("desktop");
  };
}

const CHAT_POLL_MS = 20_000;

/**
 * While chat is collapsed, checks now and then for a Rivet message newer than the last one on screen, so the strip
 * can show a dot. Opening chat clears it.
 */
function chatWatcher(): { watch(on: boolean): void; fresh(): boolean } {
  let timer: ReturnType<typeof setInterval> | null = null;
  let seen: string | null | undefined;
  let fresh = false;
  const newest = async () => {
    // Enough that a run of cards never hides the word before them.
    const page = await cmd.getChat(null, 30);
    // Rivet's words only: a "Card: … ›" line or a card shown inline is no new message, as Chat's unread counts it.
    const rivet = page.messages.filter((message) => message.from === "rivet" && !message.card && !message.posted);
    // A page holding only cards says nothing new: the last word seen stands.
    if (!rivet.length) return seen ?? null;
    return rivet.reduce((a, b) => (b.at > a.at ? b : a)).id;
  };
  const check = async () => {
    try {
      const id = await newest();
      if (timer === null) return;
      if (seen === undefined) seen = id;
      else if (id !== seen && !fresh) {
        fresh = true;
        changed();
      }
    } catch {
      // Offline or signed out: try again on the next tick.
    }
  };
  // Back in front, a message that came while hidden shows its dot at once.
  const back = () => document.visibilityState === "visible" && void check();
  return {
    watch(on) {
      if (on === (timer !== null)) return;
      if (on) {
        seen = undefined;
        fresh = false;
        timer = setInterval(() => document.visibilityState === "visible" && void check(), CHAT_POLL_MS);
        document.addEventListener("visibilitychange", back);
        void check();
      } else {
        clearInterval(timer!);
        document.removeEventListener("visibilitychange", back);
        timer = null;
        fresh = false;
      }
    },
    fresh: () => fresh,
  };
}

/** Only while the Mac is offline: online is no news; the Send and card buttons say what it means. */
function macPill(): HTMLElement | null {
  if (!macOffline()) return null;
  return h(
    "div",
    { class: "pill off", attrs: { role: "status", "aria-label": "Mac offline" } },
    h("span", { class: "dot" }),
    h("span", { class: "pill-text" }, h("span", { class: "pill-mac" }, "Mac "), "offline"),
  );
}

/** A wide window's own place for the alerts the phone shows on its band's line (floor.ts alerts). */
function alertPill(alert: floor.Said): HTMLElement {
  return h(
    "div",
    { class: "pill pill-alert warn", attrs: { role: "status", "data-key": `alert-${alert.key}`, "aria-label": alert.label } },
    h("span", { class: "dot" }),
    h("span", { class: "pill-text" }, alert.text),
  );
}

/** Focus: the open card alone. The panes' own controls sit on the panes (panes.ts). */
function focusToggle(on: boolean, focus: () => void): HTMLElement {
  return h(
    "button",
    {
      class: "pane-toggle focus-toggle",
      attrs: { type: "button", "data-use": "shell.header.focus", "aria-pressed": String(on), title: "Focus: the card alone (F)", "aria-label": "Focus" },
      on: { click: focus },
    },
    svg(PANE_ICONS.focus, "pane-toggle-icon"),
    h("span", { class: "pane-toggle-label" }, "Focus"),
  );
}

/** Decide's way back on a wide window, in words. */
function homeBack(): HTMLElement {
  const toHome = () => {
    go("progress");
    changed();
  };
  return h("button", { class: "home-back", attrs: { type: "button", "data-use": "shell.header.floor" }, on: { click: toHome } }, `‹ ${home.TITLE}`);
}

function renderHeader(header: HTMLElement, desk: boolean, focusOn: boolean, focus: () => void): void {
  const back = app.tab === "cards" && desk ? homeBack() : null;
  header.classList.toggle("home-band", !desk);
  if (desk) {
    header.replaceChildren(
      h("div", { class: "brand" }, back, h("h1", { class: "topbar-title" }, title())),
      h(
        "div",
        { class: "topbar-end" },
        // Focus is the open card alone, so it is Decide's own.
        app.tab === "cards" ? focusToggle(focusOn, focus) : null,
        // Decide's pane says its stale cards in its own bar.
        ...floor.alerts().filter((alert) => !(alert.key === "offline" && app.tab === "cards")).map(alertPill),
        macPill(),
      ),
    );
    return;
  }
  // The phone's band: the menu button, the app's name, the Mac pill while the Mac is offline, and one line under them
  // while something is for you. The line stays the same element, which floor.ts paints.
  const pill = macPill();
  const kids = [menuButton(), h("div", { class: "home-status" }, h("h1", { class: "topbar-title" }, title())), ...(pill ? [h("div", { class: "topbar-end" }, pill)] : [])];
  const line = floor.line();
  if (line.parentElement !== header) return header.replaceChildren(...kids, line);
  for (const old of [...header.children]) if (old !== line) old.remove();
  line.before(...kids);
}

function renderTabs(tabs: HTMLElement, desk: boolean, chatOpen: boolean, toggleChat: () => void, railOpen: boolean, toggleRail: () => void): void {
  // No tab bar on a phone: the home screen's dock, Decide N and Rivet.
  tabs.className = desk ? "tabs" : "home-dock";
  tabs.setAttribute("aria-label", desk ? "Sections" : "Decide and Rivet");
  if (!desk) {
    tabs.replaceChildren(...home.dock());
    return;
  }
  const chatTool = h(
    "button",
    {
      class: "tab rail-tool",
      attrs: { type: "button", "data-key": "Chat", "data-use": "shell.rail.chat", title: "Chat", "aria-pressed": String(chatOpen) },
      on: { click: toggleChat },
    },
    svg(ICONS.note, "tab-icon"),
    h("span", { class: "tab-label" }, "Chat"),
  );
  // The menu, as on the phone: Decide N is under your asks and Rivet's chat is the pane beside them. Then the pane tools.
  tabs.replaceChildren(
    h("div", { class: "rail-brand" }, h("img", { class: "brand-icon", attrs: { src: "/icon.svg", alt: "" } }), h("span", { class: "brand-name" }, APP_NAME)),
    menuList(),
    h("div", { class: "rail-gap" }),
    chatTool,
    paneFold({ pane: "rail", label: "Rail", open: railOpen, shortcut: "\\", onToggle: toggleRail }),
  );
}
