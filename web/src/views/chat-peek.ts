import "./chat-peek.css";

import type { Ask } from "../../../src/shared/asks.js";
import type { LogsResponse } from "../../../src/shared/command.js";
import { chatName } from "../../../src/shared/names.js";
import type { ScreenItem } from "../../../src/shared/screen-view.js";
import { when } from "../../../src/shared/when.js";
import type { Worker } from "../../../src/shared/workers.js";
import { h, ICONS, svg } from "../dom.js";
import { rivet } from "../rivet/rivet.js";
import { app, crewLapsed, macOffline, subscribe } from "../state.js";
import { prHref } from "./queue-cards.js";
import { closeTallSheet, openTallSheet } from "./sheet.js";
import { liveLog } from "./worker-sheet.js";
import { watchAsks } from "./your-asks.js";

/**
 * The map's chat sheet: a tap on a row with no card shows what its chat
 * is doing, what it last said, and its screen, read only. Its screen is the live log the worker sheet reads (a lease,
 * a 2s poll, the lines masked on the Mac and again by the server), set out by screenView to read on a phone.
 */

export interface PeekFacts {
  worker: Worker;
  title: string;
  project: string;
  ask?: Ask;
  stage: string;
  time: { text: string; tone: string | null } | null;
  /** Each PR with the repo its number is in: an ask's and the signal's can differ. */
  prs: { number: number; repo: string }[];
}

/** One screen item as the box shows it. */
function itemView(item: ScreenItem): HTMLElement {
  switch (item.kind) {
    case "said":
      return h("p", { class: "peek-said" }, item.text);
    case "asked":
      return h("p", { class: "peek-asked" }, h("span", { class: "peek-label" }, "Typed in"), item.text);
    case "message":
      return h(
        "p",
        { class: "peek-message", attrs: { "data-way": item.way } },
        h("span", { class: "peek-label" }, item.way === "in" ? `From ${chatName(item.who)}` : `To ${chatName(item.who)}`),
        item.text,
      );
    case "working":
      return h("p", { class: "peek-working" }, h("span", { class: "peek-dot", attrs: { "aria-hidden": "true" } }), item.text);
    case "tool":
      return h(
        "div",
        { class: "peek-tool" },
        h("p", { class: "peek-call" }, h("span", { class: "peek-tool-name" }, item.name), item.detail ? h("code", { class: "peek-tool-detail" }, item.detail) : null),
        item.result.length
          ? h("ul", { class: "peek-result" }, ...item.result.map((line) => h("li", line.tone ? { attrs: { "data-tone": line.tone } } : {}, line.text)))
          : null,
      );
  }
}

/** Why a row's screen is not shown, or null when its chat is open on the Mac. */
export function screenGone(w: Worker, openChat: boolean): string | null {
  if (macOffline() || crewLapsed()) return "The Mac is offline. Its screen shows when the Mac is back.";
  if (openChat) return null;
  // Rows the map builds from GitHub or the push queue have an id of their own; a chat's row has its chat's.
  return w.id.includes(":") ? "This row has no chat open on the Mac: it's a PR, so there is no screen to show." : "This chat has closed. Nothing of its screen is kept.";
}

/** Opens the chat sheet for a map row; `read` gives its facts as the map has them now, null once it has left the map. */
export function openChatPeek(w: Worker, read: () => PeekFacts | null): void {
  let facts = read() ?? { worker: w, title: chatName(w.chat), project: "", stage: "", time: null, prs: [] };
  const face = rivet("working", { tone: "agent", size: 44, glow: true });
  const title = h("h2", { class: "peek-title" });
  const sub = h("p", { class: "peek-sub" });
  const close = h("button", { class: "decide-close", attrs: { type: "button", "aria-label": "Close", "data-use": "desks.chat.close" }, on: { click: () => closeTallSheet() } }, svg(ICONS.back, "btn-icon"));
  const doing = h("dl", { class: "peek-facts" });
  const saidHead = h("h3", { class: "peek-h" }, "Last said");
  const said = h("p", { class: "peek-last" });
  const saidBlock = h("section", { class: "peek-block peek-last-block" }, saidHead, said);
  saidBlock.hidden = true;
  const note = h("p", { class: "peek-note" });
  const box = h("div", { class: "peek-screen", attrs: { tabindex: "0", role: "log", "aria-live": "off", "aria-label": `Its screen: ${chatName(w.chat)}` } }, "Loading…");
  const body = h(
    "div",
    { class: "peek-body" },
    h("header", { class: "peek-head" }, face, h("div", { class: "peek-who" }, title, sub), close),
    h("section", { class: "peek-block" }, h("h3", { class: "peek-h" }, "What it's doing"), doing),
    saidBlock,
    h("section", { class: "peek-block peek-screen-block" }, h("div", { class: "peek-screen-head" }, h("h3", { class: "peek-h" }, "Its screen"), note), box),
  );

  let shown = "";
  // Why its screen has not come, once it has waited LOG_SLOW_MS: never an endless "Waiting".
  let slowWhy: string | null = null;
  let latest: LogsResponse | null = null;
  /** Paints a read: the newest at the foot, kept in view unless you have scrolled up. */
  const paintScreen = (logs: LogsResponse) => {
    latest = logs;
    if (logs.lines.length) slowWhy = null;
    const key = `${slowWhy ?? ""}\n${logs.lines.join("\n")}\n${(logs.times ?? []).join("\n")}`;
    if (key === shown) return;
    const fresh = shown === "";
    shown = key;
    const atFoot = fresh || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    // Set out and redacted again by the server (redactScreen): the lines alone are masked one by one.
    const items = logs.screen ?? [];
    if (items.length) box.replaceChildren(...items.map(itemView));
    else box.textContent = logs.lines.length ? "Nothing to read on its screen yet." : (slowWhy ?? "Waiting for its screen…");
    if (atFoot) box.scrollTop = box.scrollHeight;
    // Its last words as the box reads them; a tool under way (`⏺ Reading the notes`) is not something it said.
    const last = [...items].reverse().find((item) => item.kind === "said");
    saidBlock.hidden = !last;
    if (last) {
      // When it said them, if the feed has them as they arrived (the feed shortens paths, so a start is enough).
      const words = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 40);
      const at = (logs.feed ?? []).find((entry) => entry.kind === "said" && words(entry.text) === words(last.text))?.at;
      saidHead.textContent = at ? `Last said · ${when(at)}` : "Last said";
      said.textContent = last.text;
    }
  };

  const openChat = () => {
    return !!app.workers?.workers.some((one) => one.repo === w.repo && one.chat === w.chat);
  };
  let log: { stop(): void } | null = null;
  let gone: string | null | undefined;
  const paint = () => {
    facts = read() ?? facts;
    title.textContent = facts.title;
    sub.textContent = [chatName(facts.worker.chat), facts.project].filter(Boolean).join(" · ");
    const rows: [string, HTMLElement | string][] = [];
    if (facts.ask) rows.push(["You asked", h("q", { class: "peek-words" }, facts.ask.words)]);
    if (facts.stage)
      rows.push([
        "Stage",
        h("span", { class: "peek-stage" }, h("span", { class: "pill" }, facts.stage), facts.time ? h("span", { class: `peek-time${facts.time.tone ? ` is-${facts.time.tone}` : ""}` }, facts.time.text) : null),
      ]);
    if (facts.prs.length)
      rows.push([
        facts.prs.length === 1 ? "PR" : "PRs",
        h("span", { class: "peek-prs" }, ...facts.prs.map((pr) => h("a", { attrs: { href: prHref(pr.number, pr.repo), target: "_blank", rel: "noopener noreferrer", "data-use": "desks.chat.pr-link" } }, `#${pr.number} ›`))),
      ]);
    const next = rows.flatMap(([term, value]) => [h("dt", {}, term), h("dd", {}, value)]);
    if (next.map((one) => one.outerHTML).join("") !== [...doing.children].map((one) => one.outerHTML).join("")) doing.replaceChildren(...next);
    const why = screenGone(w, openChat());
    if (why === gone) return;
    gone = why;
    log?.stop();
    log = null;
    shown = "";
    slowWhy = null;
    latest = null;
    if (why) {
      note.textContent = "";
      box.textContent = why;
      box.dataset.state = "gone";
      saidBlock.hidden = true;
      return;
    }
    delete box.dataset.state;
    box.textContent = "Loading…";
    note.textContent = "Starting…";
    log = liveLog(
      w,
      (state, text) => {
        note.dataset.state = state;
        note.textContent = state === "on" ? "Masked on the Mac · every 2s" : text;
      },
      paintScreen,
      (text) => {
        if (log === null || text === slowWhy) return;
        slowWhy = text;
        paintScreen(latest ?? { repo: w.repo, chat: w.chat, lines: [], times: [], updatedAt: null, leaseUntil: null });
      },
    );
  };

  let stop = () => {};
  openTallSheet(
    `${chatName(w.chat)}: its chat`,
    {
      mount(el) {
        el.replaceChildren(body);
        const unsubscribe = subscribe(paint);
        const unwatchAsks = watchAsks(paint);
        stop = () => {
          unsubscribe();
          unwatchAsks();
          log?.stop();
          log = null;
        };
        paint();
      },
      unmount: () => stop(),
    },
    { className: "peek-sheet", use: "desks.chat" },
  );
}
