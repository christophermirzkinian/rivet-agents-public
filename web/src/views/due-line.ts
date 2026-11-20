import "./due-line.css";

import { isFinished, type Ask } from "../../../src/shared/asks.js";
import { NO_REPO } from "../../../src/shared/repos.js";
import { when } from "../../../src/shared/when.js";
import { stageWord } from "../../../src/shared/words.js";
import { getAsks } from "../api.js";
import { h, ICONS, svg } from "../dom.js";
import { closeSheet, openSheet } from "./sheet.js";
import { openChatSheet } from "./worker-sheet.js";

// Chat's due button (once a due line, now a plain clock in the head): there while an ask in hand has a time or one was
// done lately, amber while one is late. A tap opens two tabs: Done, what finished lately (doneAsks), and Up next, every
// timed ask Rivet holds (dueAsks) by its time; a row goes to the ask's line in Chat, else its chat's ticket.

/** How long a title the line keeps of an ask's words when nothing shorter names it. */
const TITLE_MAX = 32;
/** The Done tab: what finished in the last day, at least the last few when the day was quiet, at most a page. */
export const DONE_WINDOW_MS = 24 * 60 * 60_000;
export const DONE_MIN = 5;
export const DONE_MAX = 20;
const DONE_SKEW_MS = 5 * 60_000;

/**
 * Recently done, newest first: asks deployed or done (not parked) in the last day, else the last DONE_MIN of those the
 * list holds (it keeps finished asks for ASK_DONE_DAYS), never more than DONE_MAX.
 */
export function doneAsks(asks: readonly Ask[], now: number): { list: Ask[]; today: number } {
  // As dueAsks: no pick-up, whose Ops record stands for it.
  const done = asks
    .filter((ask) => (ask.stage === "shipped" || ask.stage === "done") && !ask.source?.startsWith("pickup:") && Number.isFinite(Date.parse(ask.stageAt)))
    .sort((a, b) => Date.parse(b.stageAt) - Date.parse(a.stageAt));
  // A stage time ahead of this clock (skew, or a bad stamp) counts only within DONE_SKEW_MS, so it cannot hold the clock up.
  const today = Math.min(
    DONE_MAX,
    done.filter((ask) => {
      const ago = now - Date.parse(ask.stageAt);
      return ago <= DONE_WINDOW_MS && ago >= -DONE_SKEW_MS;
    }).length,
  );
  return { list: done.slice(0, Math.max(today, DONE_MIN)), today };
}

/**
 * The asks in hand with a time, late ones first (soonest past first), then the rest by time. As the server's late rule
 * (asks/late.ts): none waiting on the owner (Your asks says Needs you), and no pick-up, whose Ops record stands for it.
 */
export function dueAsks(asks: readonly Ask[], now: number): { late: Ask[]; next: Ask[] } {
  const timed = asks
    .filter((ask) => !isFinished(ask.stage) && ask.stage !== "needs-you" && !ask.source?.startsWith("pickup:") && ask.dueAt !== undefined)
    .sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!));
  return {
    late: timed.filter((ask) => Date.parse(ask.dueAt!) <= now),
    next: timed.filter((ask) => Date.parse(ask.dueAt!) > now),
  };
}

/** An ask's short name: its conversation's title when Chat knows it, else the titler's, else its words cut. */
export function dueTitle(ask: Ask, conversationTitle?: string | null): string {
  const named = conversationTitle?.trim() || ask.short?.trim();
  if (named) return named;
  const words = ask.words.replace(/\s+/g, " ").trim();
  return words.length > TITLE_MAX ? `${words.slice(0, TITLE_MAX - 1).trimEnd()}…` : words;
}

/**
 * The line's parts: "Late <time> · <title>" or "Next <time> · <title>", the time amber when late, and how many
 * more; null when nothing has a time.
 */
export function dueWords(
  asks: readonly Ask[],
  now: number,
  titleOf: (ask: Ask) => string,
): { late: number; title: string; time: string; more: number } | null {
  const { late, next } = dueAsks(asks, now);
  const first = late[0] ?? next[0];
  if (!first) return null;
  return { late: late.length, title: titleOf(first), time: when(first.dueAt!, now), more: late.length + next.length - 1 };
}

/** The Chat line an ask was asked in: its `message:` source, else the line it replied to. */
export function askLine(ask: Ask): string | null {
  if (ask.source?.startsWith("message:")) return ask.source.slice("message:".length);
  return ask.replyId ?? null;
}

export interface DueLine {
  el: HTMLElement;
  /** Reads the asks again. */
  refresh(): void;
  /** Off over a thing's page: only Chat shows it. */
  setActive(on: boolean): void;
}

/** `jump` brings Chat to a line; `conversationTitle` names an ask by its conversation when Chat holds one. */
export function dueLine(jump: (message: string) => void, conversationTitle: (ask: Ask) => string | null = () => null): DueLine {
  let asks: readonly Ask[] = [];
  let active = true;
  let reads = 0;
  const el = h("button", { class: "icon-btn chat-options chat-due", attrs: { type: "button", "data-use": "chat.due.open" }, on: { click: () => openList() } });
  el.hidden = true;
  const titleOf = (ask: Ask) => dueTitle(ask, conversationTitle(ask));

  function paint(): void {
    const now = Date.now();
    const words = dueWords(asks, now, titleOf);
    // There while anything has a time or was done in the last day (not the quiet day's older padding): the Done tab is
    // behind it too.
    const done = doneAsks(asks, now).today;
    el.hidden = !active || (!words && !done);
    if (!words && !done) return el.replaceChildren();
    if (!el.firstChild) el.replaceChildren(svg(ICONS.clock, "icon-btn-icon"));
    if (!words) {
      el.classList.remove("late");
      return el.setAttribute("aria-label", "Nothing has a time. Show what is done and due");
    }
    const { late, title, time, more } = words;
    el.classList.toggle("late", late > 0);
    // A plain clock, no time on it;
    // a screen reader still hears what is next. Never a bare count of late things (words §3d): it says the late time.
    const said = `${late ? "Late" : "Next"} ${time} · ${title}`;
    el.setAttribute("aria-label", `${said}${more ? `, ${more} more` : ""}. Show what is done and due`);
  }

  function go(ask: Ask): void {
    closeSheet();
    const line = askLine(ask);
    if (line) return jump(line);
    if (ask.chat) openChatSheet(ask.chat, (ask.repo ?? NO_REPO) as typeof NO_REPO, `ask-${ask.id}`, "asks");
  }

  function row(ask: Ask, late: boolean, now: number): HTMLElement {
    const opens = askLine(ask) !== null || ask.chat !== undefined;
    const time = when(ask.dueAt!, now);
    return h(
      "li",
      {},
      h(
        "button",
        {
          class: `chat-due-row${late ? " late" : ""}`,
          attrs: { type: "button", "data-use": "chat.due.row", ...(opens ? {} : { disabled: "" }) },
          on: { click: () => go(ask) },
        },
        h("span", { class: "chat-due-row-time" }, late ? `due ${time}` : time),
        h("span", { class: "chat-due-row-words" }, h("strong", {}, titleOf(ask)), h("small", {}, `${ask.id} · ${stageWord(ask.stage)}`)),
      ),
    );
  }

  function doneRow(ask: Ask, now: number): HTMLElement {
    const opens = askLine(ask) !== null || ask.chat !== undefined;
    const pr = ask.prs[0];
    return h(
      "li",
      {},
      h(
        "button",
        {
          class: "chat-due-row done",
          attrs: { type: "button", "data-use": "chat.due.row", ...(opens ? {} : { disabled: "" }) },
          on: { click: () => go(ask) },
        },
        h("span", { class: "chat-due-row-time" }, when(ask.stageAt, now)),
        h("span", { class: "chat-due-row-words" }, h("strong", {}, titleOf(ask)), h("small", {}, `${stageWord(ask.stage)} · ${ask.id}${pr ? ` · #${pr}` : ""}`)),
      ),
    );
  }

  /** Two tabs, Done then Up next; it opens on Up next unless nothing has a time. */
  function openList(): void {
    const now = Date.now();
    const { late, next } = dueAsks(asks, now);
    const { list: done, today } = doneAsks(asks, now);
    const timed = late.length + next.length;
    const panes = {
      done: done.length
        ? h("ol", { class: "chat-due-list" }, ...done.map((ask) => doneRow(ask, now)))
        : h("p", { class: "chat-due-empty" }, "Nothing done lately"),
      next: timed
        ? h("ol", { class: "chat-due-list" }, ...late.map((ask) => row(ask, true, now)), ...next.map((ask) => row(ask, false, now)))
        : h("p", { class: "chat-due-empty" }, "Nothing has a time"),
    };
    type Tab = keyof typeof panes;
    const tabs = (
      [
        ["done", "Done", done.length],
        ["next", "Up next", timed],
      ] as const
    ).map(([key, label, n], i) =>
      h(
        "button",
        {
          class: "chat-due-tab",
          // The usage value is a number (usage.ts): 1 Done, 2 Up next.
          attrs: { type: "button", role: "tab", id: `chat-due-tab-${key}`, "aria-controls": "chat-due-pane", "aria-label": `${label}, ${n}`, "data-tab": key, "data-use": "chat.due.tab", "data-use-value": String(i + 1) },
          on: { click: () => show(key) },
        },
        label,
        h("span", { class: "chat-due-tab-n", attrs: { "aria-hidden": "true" } }, String(n)),
      ),
    );
    const pane = h("div", { class: "chat-due-pane", attrs: { role: "tabpanel", id: "chat-due-pane" } });
    function show(key: Tab): void {
      for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.tab === key));
      pane.setAttribute("aria-labelledby", `chat-due-tab-${key}`);
      pane.replaceChildren(panes[key]);
    }
    show(timed || !today ? "next" : "done");
    openSheet(
      "Asks",
      {
        mount: (body) => body.replaceChildren(h("div", { class: "chat-due-tabs", attrs: { role: "tablist", "aria-label": "Done and up next" } }, ...tabs), pane),
        unmount: () => {},
      },
      "Close",
      undefined,
      { className: "chat-due-sheet", use: "chat.due" },
    );
  }

  function refresh(): void {
    const read = ++reads;
    getAsks().then(
      (found) => {
        if (read !== reads || !Array.isArray(found?.asks)) return;
        asks = found.asks;
        paint();
      },
      () => {},
    );
  }

  refresh();
  return {
    el,
    refresh,
    setActive(on) {
      if (active === on) return;
      active = on;
      paint();
    },
  };
}
