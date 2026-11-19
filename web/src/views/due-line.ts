import "./due-line.css";

import { isFinished, type Ask } from "../../../src/shared/asks.js";
import { NO_REPO } from "../../../src/shared/repos.js";
import { when } from "../../../src/shared/when.js";
import { stageWord } from "../../../src/shared/words.js";
import { getAsks } from "../api.js";
import { h } from "../dom.js";
import { closeSheet, openSheet } from "./sheet.js";
import { openChatSheet } from "./worker-sheet.js";

// Chat's due line: one row under the head with what is due next, led by what is late; a tap
// lists every timed ask Rivet holds (dueAsks) by its time, and a row goes to the ask's line in Chat, else its chat's ticket.

/** How long a title the line keeps of an ask's words when nothing shorter names it. */
const TITLE_MAX = 32;

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
  const el = h("button", { class: "chat-due", attrs: { type: "button", "data-use": "chat.due.open" }, on: { click: () => openList() } });
  el.hidden = true;
  const titleOf = (ask: Ask) => dueTitle(ask, conversationTitle(ask));

  function paint(): void {
    const words = dueWords(asks, Date.now(), titleOf);
    el.hidden = !active || !words;
    if (!words) return el.replaceChildren();
    const { late, title, time, more } = words;
    el.classList.toggle("late", late > 0);
    // Never a bare count of late things (words §3d): the late line says its time.
    const said = `${late ? "Late" : "Next"} ${time} · ${title}`;
    el.setAttribute("aria-label", `${said}${more ? `, ${more} more` : ""}. Show what is due`);
    // The time leads and stays whole; the title wraps to a second line on a narrow phone.
    const named = h("span", { class: "chat-due-title" }, title);
    const at = h("strong", { class: "chat-due-time" }, time);
    el.replaceChildren(
      h("span", { class: "chat-due-words" }, late ? "Late " : "Next ", at, " · ", named),
      words.more ? h("span", { class: "chat-due-more" }, `${words.more} more ›`) : h("span", { class: "chat-due-more" }, "›"),
    );
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

  function openList(): void {
    const now = Date.now();
    const { late, next } = dueAsks(asks, now);
    openSheet(
      "What's due",
      {
        mount: (body) =>
          body.replaceChildren(h("ol", { class: "chat-due-list" }, ...late.map((ask) => row(ask, true, now)), ...next.map((ask) => row(ask, false, now)))),
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
