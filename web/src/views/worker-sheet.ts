import "./command.css";
import "./worker-sheet.css";

import { MAX_CHAT_TEXT, type LogsResponse } from "../../../src/shared/command.js";
import type { FeedEntry, FeedKind } from "../../../src/shared/log-feed.js";
import { chatRepo } from "../../../src/shared/board.js";
import { maybeWhen, when } from "../../../src/shared/when.js";
import type { Worker } from "../../../src/shared/workers.js";
import * as api from "../api.js";
import * as cmd from "../command-api.js";
import { stopDictation, withMic } from "../dictation.js";
import { button, describe, h, inertBehind, keepFocus } from "../dom.js";
import { enterScreen, leaveScreen } from "../usage.js";
import { STATE_WORDS } from "../crew-words.js";
import { app, MAC_WAITS, crewLapsed, macOffline, signedOut, subscribe } from "../state.js";
import { discussButton, discussPrefix, tooLong } from "./discuss.js";
import { fitAboveKeyboard, leaveSheet } from "./sheet.js";
import { RIVET_NAME, chatName } from "../../../src/shared/names.js";

export interface WorkerSheetOptions {
  /** Rivet's chat is not running: the sheet says Offline. */
  offline?: boolean;
  /** A card names a chat absent from the crew; sending lets the server check whether its terminal exists. */
  allowUnlistedSend?: boolean;
  /** Who opened it; `closeWorkerSheet(owner)` closes only a sheet that owner opened. */
  owner?: string;
  /** The PR the opener is about (a Feed card's): the message's tag names it beside the chat's own. */
  pr?: number;
}

let open: { owner: string | undefined; close(): void } | null = null;

const LOG_POLL_MS = 2_000;
/** Until its first lines land, a log polls this often: the bridge settles a first read about half a second in. */
const LOG_FIRST_POLL_MS = 500;
/** With no lines this long after it opened, a log says why it has none rather than wait on in silence. */
export const LOG_SLOW_MS = 6_000;
// Each renewal also has the bridge read the chat afresh (bridge/lib/actions/logs.mjs): a TUI's repaints reach the log this often.
const LEASE_RENEW_MS = 10_000;

export function actionError(error: unknown): string {
  if (error instanceof api.ApiError && error.status === 401) {
    signedOut("Your session ended. Sign in again.");
    return "Signed out.";
  }
  if (error instanceof api.ApiError && error.status === 503) return "The Mac is offline.";
  if (error instanceof api.ApiError && error.status === 409) return "That chat is not running right now.";
  return describe(error);
}

const FEED_WHO: Record<FeedKind, (who: string) => string> = {
  said: () => "",
  sent: (who) => `To ${chatName(who)}`,
  heard: (who) => `From ${chatName(who)}`,
  asked: () => "Message in",
};

/** One feed row: its time, who it went to or came from, and what was said. */
function feedRow(entry: FeedEntry): HTMLElement {
  const who = FEED_WHO[entry.kind](entry.who ?? "");
  return h(
    "li",
    { class: "cmd-feed-item", attrs: { "data-kind": entry.kind } },
    h("span", { class: "cmd-feed-time" }, entry.at ? when(entry.at) : "Earlier"),
    who ? h("span", { class: "cmd-feed-who" }, who) : null,
    h("span", { class: "cmd-feed-text" }, entry.text),
  );
}

/** What a chat log's note says: leased (`on`) or why not (`off`). */
export type LogNote = (state: "on" | "off", text: string) => void;

/** Why a log has no lines LOG_SLOW_MS after it opened: its lease was refused, the Mac has sent nothing, or nothing it can show yet. */
export function slowWhy(refused: string | null, latest: LogsResponse | null): string {
  if (refused) return refused;
  if (!latest?.updatedAt) return "The Mac has not sent its screen yet. It may be busy, or this chat's terminal may have closed. Still asking.";
  return "The Mac is reading its screen but has nothing it can show masked yet. Still reading.";
}

/**
 * The live log: a lease the server lets lapse after a minute unless renewed, polled every 2s while the app is in front
 * (every 500ms until its first lines land) and released on `stop`. `render` gets each new read; a poll the server
 * answers 304 (nothing changed) renders nothing. With no lines LOG_SLOW_MS after it opened, came back to the front or
 * lost its lines, `slow` gets why, every tick until lines land, whether or not the reads are answered. Shared by the
 * worker sheet and the map's chat sheet (chat-peek.ts).
 */
export function liveLog(
  worker: Pick<Worker, "repo" | "chat">,
  note: LogNote,
  render: (logs: LogsResponse) => void,
  slow: (why: string) => void = () => {},
): { stop(): void } {
  let stopped = false;
  let etag: string | null = null;
  // Whether the newest read has lines; without them the poll is quick, and LOG_SLOW_MS after `since` it says why not.
  let got = false;
  // When it last had no lines to show: opened, back in front, or its lines gone (a new lease after a lapse).
  let since = Date.now();
  let latest: LogsResponse | null = null;
  let refused: string | null = null;
  // Why the last read failed, if it did; a read that never answers is caught by the tick's own check.
  let failed: string | null = null;
  let ticks = 0;
  const check = () => {
    if (!stopped && !got && Date.now() - since >= LOG_SLOW_MS) slow(slowWhy(refused ?? failed, latest));
  };
  const lease = () =>
    cmd.subscribeLogs(worker.repo, worker.chat).then(
      () => {
        refused = null;
        if (!stopped) note("on", "");
      },
      (error: unknown) => {
        refused = actionError(error);
        if (!stopped) note("off", refused);
      },
    );
  const inFront = () => document.visibilityState === "visible";
  // Closed or hidden by the time a lease lands: nothing to read it.
  const poll = () =>
    (stopped || !inFront() ? Promise.resolve(null) : cmd.getLogsIfChanged(worker.repo, worker.chat, etag)).then(
      (next) => {
        if (stopped) return;
        failed = null;
        if (next) {
          etag = next.etag;
          latest = next.logs;
          const has = next.logs.lines.length > 0;
          if (got && !has) since = Date.now();
          got = has;
          render(next.logs);
        }
        check();
      },
      (error: unknown) => {
        if (stopped) return;
        failed = actionError(error);
        check();
      },
    );
  void lease().then(poll);
  // Hidden, the log goes unread: no lease or poll until the app is in front again, which leases and reads at once.
  const renew = window.setInterval(() => inFront() && void lease(), LEASE_RENEW_MS);
  const tick = window.setInterval(() => {
    ticks += 1;
    if (!inFront()) return;
    if (!got || ticks % (LOG_POLL_MS / LOG_FIRST_POLL_MS) === 0) void poll();
    check();
  }, LOG_FIRST_POLL_MS);
  const back = () => {
    if (!inFront()) return;
    since = Date.now();
    void lease().then(poll);
  };
  document.addEventListener("visibilitychange", back);
  return {
    stop() {
      stopped = true;
      document.removeEventListener("visibilitychange", back);
      window.clearInterval(renew);
      window.clearInterval(tick);
      cmd.releaseLogs(worker.repo, worker.chat).catch(() => {});
    },
  };
}

/**
 * The worker sheet's log: the feed of what the chat said, newest first, or the redacted raw lines when `raw()`.
 * Returns its stop and a repaint for when the view changes.
 */
function workerLog(worker: Worker, box: HTMLElement, note: HTMLElement, raw: () => boolean): { stop(): void; repaint(): void } {
  let logs: LogsResponse | null = null;
  // Why it has no lines yet, once it has waited LOG_SLOW_MS: never an endless "Waiting".
  let why: string | null = null;
  let shown = "";
  const paint = () => {
    if (!logs && !why) return;
    const asRaw = raw();
    const lines = logs?.lines ?? [];
    const waiting = why ?? "Waiting for output…";
    const key = `${asRaw}\n${waiting}\n${lines.join("\n")}\n${(logs?.times ?? []).join("\n")}`;
    if (key === shown) return;
    const fresh = !shown.startsWith(`${asRaw}\n`);
    shown = key;
    box.classList.toggle("is-raw", asRaw);
    if (asRaw) {
      const atBottom = fresh || box.scrollHeight - box.scrollTop - box.clientHeight < 30;
      box.textContent = lines.length ? lines.join("\n") : waiting;
      if (atBottom) box.scrollTop = box.scrollHeight;
      return;
    }
    // Newest first: a reader at the top sees each new entry arrive; one scrolled down keeps their place.
    // Joined and redacted again by the server (redactFeed): the lines alone are masked one by one.
    const feed = logs?.feed ?? [];
    const top = box.scrollTop;
    if (!feed.length) box.textContent = lines.length ? "Nothing said yet. Show raw has the full log." : waiting;
    else box.replaceChildren(h("ol", { class: "cmd-feed" }, ...feed.map(feedRow)));
    box.scrollTop = fresh ? 0 : top;
  };
  const log = liveLog(
    worker,
    (state, text) => {
      note.dataset.state = state;
      note.textContent = state === "on" ? "Redacted · last 200" : text;
    },
    (next) => {
      logs = next;
      if (next.lines.length) why = null;
      paint();
    },
    (text) => {
      why = text;
      paint();
    },
  );
  return { stop: log.stop, repaint: paint };
}

/** Where a message is on its way to Rivet. */
function steps(): { el: HTMLElement; reach(status: string): void } {
  const names = ["sent", "typed", "replied"];
  const words: Record<string, string> = { sent: "Sent", typed: "Typed in", replied: "Replied" };
  const items = names.map((name) => h("li", { class: "cmd-step", attrs: { "data-step": name } }, words[name]!));
  const el = h("ol", { class: "cmd-steps", attrs: { "aria-label": "Delivery" } }, ...items);
  el.hidden = true;
  return {
    el,
    reach(status) {
      // Queued and the like are still only sent.
      const at = status === "unconfirmed" ? names.indexOf("typed") : Math.max(0, names.indexOf(status));
      el.hidden = false;
      items.forEach((item, i) => item.classList.toggle("is-on", i <= at));
    },
  };
}

/** The chat's PRs: those it carries (a live worker's from the board, a card's from the card) and its board row's. */
function prsOf(worker: Worker): number[] {
  const row = app.board?.board?.chats.find((chat) => chat.name === worker.chat && (chatRepo(chat) ?? worker.repo) === worker.repo);
  return [...new Set([...(worker.prs ?? []), ...(row?.prs ?? [])])];
}

/**
 * The tag a message about a chat starts with, so Rivet knows which chat and PRs it is about. The PR of the card it was
 * sent from comes first, named as the card's, so the same words from two cards of one chat are two messages.
 */
function aboutWorker(worker: Worker, about?: number): string {
  const prs = [...new Set([...prsOf(worker), ...(worker.delivering?.pr === undefined ? [] : [worker.delivering.pr])])].filter((pr) => pr !== about);
  return discussPrefix(worker.name, "worker", [
    `chat ${worker.chat}`,
    about === undefined ? null : `card's PR #${about}`,
    prs.length ? `${prs.length === 1 ? "PR" : "PRs"} ${prs.map((pr) => `#${pr}`).join(" ")}` : null,
    worker.repo ? `in ${worker.repo}` : null,
  ]);
}

/** What goes before the owner's words: the chat's tag, or on Rivet's own chat only the PR its opener is about. */
export const tagFor = (worker: Worker, about?: number): string =>
  worker.rivet ? (about === undefined ? "" : `About PR #${about}: `) : aboutWorker(worker, about);

/**
 * The message box goes to Rivet through the Chat path, so it lands in the Chat tab's history; one about another
 * chat carries that chat's tag for Rivet to delegate. The owner never talks to a chat directly.
 */
function sendBox(getWorker: () => Worker, onStop: (stop: () => void) => void, about?: number): HTMLElement {
  const text = h("textarea", { class: "cmd-text", attrs: { rows: "2" } });
  const heading = h("h3", { class: "cmd-h" });
  const where = h("p", { class: "sheet-where" });
  let progressEl = steps().el;
  const status = h("p", { class: "cmd-meta", attrs: { role: "status" } });
  let follow: (() => void) | null = null;
  let sending = false;
  const paint = () => {
    const worker = getWorker();
    const label = worker.rivet ? `Message ${RIVET_NAME}` : `Message ${RIVET_NAME} about ${worker.name}`;
    heading.textContent = label;
    where.textContent = worker.rivet ? `Goes to ${RIVET_NAME} now, in Chat.` : `Goes to ${RIVET_NAME} in Chat, tagged ${chatName(worker.chat)}. He passes it on.`;
    text.maxLength = MAX_CHAT_TEXT - tagFor(worker, about).length;
    text.placeholder = worker.rivet ? `Ask ${RIVET_NAME} anything` : `What should ${worker.name} do?`;
    text.setAttribute("aria-label", label);
    send.disabled = sending;
    send.textContent = macOffline() ? `Send ${MAC_WAITS}` : "Send";
  };
  const send = button(
    "Send",
    () => {
      stopDictation();
      const worker = getWorker();
      if (!text.isConnected || send.disabled) return;
      const body = text.value.trim();
      if (!body) return text.focus();
      const said = cmd.workerMessageText(worker, body, `${tagFor(worker, about)}${body}`, about);
      if (said.length > MAX_CHAT_TEXT) {
        status.textContent = tooLong(said.length - MAX_CHAT_TEXT);
        return text.focus();
      }
      sending = true;
      paint();
      follow?.();
      follow = null;
      const progress = steps();
      progressEl.replaceWith(progress.el);
      progressEl = progress.el;
      cmd.sendWorkerMessage(worker, body, said, about).then(
        (entry) => {
          // Only the text that went: words dictated while it was out stay.
          if (text.value.trim() === body) text.value = "";
          sending = false;
          paint();
          progress.reach("sent");
          status.textContent = "Waiting for the Mac…";
          follow?.();
          follow = cmd.followAction(entry.id, (next) => {
            if (next.status === "failed") {
              progress.el.hidden = true;
              status.textContent = next.detail?.reason ?? "Not delivered.";
              return;
            }
            progress.reach(next.status);
            status.textContent =
              next.status === "replied"
                ? `${RIVET_NAME} replied. It's in Chat.`
                : next.status === "unconfirmed"
                  ? "Typed; the chat did not confirm it."
                  : next.status === "typed"
                    ? `Typed into ${RIVET_NAME}'s chat. Waiting for his reply…`
                    : "Waiting for the Mac…";
          });
          onStop(() => follow?.());
        },
        (error: unknown) => {
          sending = false;
          paint();
          progress.el.hidden = true;
          status.textContent = actionError(error);
        },
      );
    },
    "primary",
    false,
    "worker.send",
  );
  paint();
  text.addEventListener("input", paint);
  onStop(subscribe(paint));
  return h(
    "div",
    { class: "cmd-send" },
    heading,
    where,
    withMic(text),
    h("div", { class: "cmd-send-row" }, progressEl, send),
    status,
  );
}

/** Opens the sheet for one worker, replacing any worker sheet already open. */
export function openWorkerSheet(worker: Worker, options: WorkerSheetOptions = {}): void {
  closeWorkerSheet();
  const opening = worker;
  const current = () => app.workers?.workers.find((next) => next.repo === opening.repo && next.chat === opening.chat);
  const available = () => !macOffline() && !crewLapsed() && (app.workers ? !!current() : !options.offline);
  const facts = h("dl", { class: "scene-facts" });
  const paintFacts = (worker: Worker, offline: boolean) => {
    const rows: [string, string | HTMLElement][] = [
      ...(worker.repo ? [["Repo", worker.repo] as [string, string]] : []),
      ["Chat", chatName(worker.chat)],
      ["State", `${offline ? "Offline" : STATE_WORDS[worker.state]} · ${maybeWhen(worker.lastOutputAt) ?? "no output yet"}`],
    ];
    if (worker.doing) rows.push(["Doing", worker.doing]);
    // The chat's PRs, one tap each to GitHub: the chats row is a button, so it cannot hold links.
    const prs = worker.repo ? prsOf(worker) : [];
    if (prs.length)
      rows.push([
        prs.length === 1 ? "PR" : "PRs",
        h("span", { class: "cmd-prs" }, ...prs.map((pr) => h("a", { attrs: { href: `https://github.com/${worker.repo}/pull/${pr}`, target: "_blank", rel: "noopener noreferrer", "data-use": "worker.pr-link" } }, `#${pr}`))),
      ]);
    const restoreFocus = keepFocus(facts);
    facts.replaceChildren(...rows.flatMap(([term, value]) => [h("dt", {}, term), h("dd", {}, value)]));
    restoreFocus();
  };
  const stops: (() => void)[] = [];
  let closed = false;
  const onStop = (stop: () => void) => closed ? stop() : void stops.push(stop);
  const close = h("button", { class: "btn scene-close", attrs: { type: "button", "data-use": "worker.close" }, on: { click: () => closeWorkerSheet() } }, "Close");
  const logBox = h("div", { class: "cmd-log", attrs: { tabindex: "0", "aria-label": `Chat log of ${chatName(worker.chat)}` } }, "Loading…");
  const logNote = h("p", { class: "cmd-meta" }, "Starting the log…");
  let raw = false;
  let log: ReturnType<typeof workerLog> | null = null;
  const rawToggle = h("button", { class: "btn cmd-log-raw", attrs: { type: "button", "data-use": "worker.log-raw", "aria-pressed": "false" } }, "Show raw");
  rawToggle.addEventListener("click", () => {
    raw = !raw;
    rawToggle.setAttribute("aria-pressed", String(raw));
    rawToggle.textContent = raw ? "Show feed" : "Show raw";
    log?.repaint();
  });
  // The message box comes first, then the facts, the log takes the rest, and the footer is one compact
  // row, so the box is on the first screen of a phone. Rivet takes messages even offline: the bridge delivers them
  // when it is back.
  let message: HTMLElement | null = null;
  let wasAvailable: boolean | null = null;
  const scroll = h("div", { class: "cmd-worker-scroll" }, facts);
  close.classList.remove("scene-close");
  const foot = h("div", { class: "cmd-worker-foot" }, close);
  const heading = h("h2", { class: "scene-sheet-name" }, worker.name);
  const panel = h("div", { class: "scene-sheet cmd-worker-sheet", attrs: { role: "dialog", "aria-modal": "true", "aria-label": worker.name } }, heading, scroll, foot);
  const paint = () => {
    worker = current() ?? worker;
    const live = available();
    heading.textContent = worker.name;
    panel.setAttribute("aria-label", worker.name);
    paintFacts(worker, !live);
    if (!message && (live || worker.rivet || options.allowUnlistedSend)) {
      message = sendBox(() => current() ?? worker, onStop, options.pr);
      scroll.prepend(message);
    }
    // Offline facts can change too: rebuild Discuss this with the PRs now shown.
    if (live && live === wasAvailable) return;
    wasAvailable = live;
    const restoreFocus = keepFocus(panel, () => close);
    log?.stop();
    log = null;
    scroll.querySelectorAll(".cmd-log-head, .cmd-log").forEach((node) => node.remove());
    if (live) {
      logBox.textContent = "Loading…";
      logNote.textContent = "Starting the log…";
      scroll.append(h("div", { class: "cmd-log-head" }, h("h3", { class: "cmd-h" }, "Chat log"), logNote, rawToggle), logBox);
      log = workerLog(worker, logBox, logNote, () => raw);
    }
    const action = live || worker.rivet ? null : discussButton(aboutWorker(worker, options.pr), () => closeWorkerSheet());
    for (const child of [...foot.children]) if (child !== close) child.remove();
    if (action) foot.insertBefore(action, close);
    restoreFocus();
  };
  const backdrop = h("div", { class: "scene-sheet-backdrop" }, panel);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeWorkerSheet();
  });
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") closeWorkerSheet();
  };
  document.addEventListener("keydown", onKey);
  const unfit = fitAboveKeyboard(backdrop);
  document.body.append(backdrop);
  const restore = inertBehind(backdrop);
  paint();
  onStop(subscribe(paint));
  enterScreen("worker");
  open = {
    owner: options.owner,
    close() {
      closed = true;
      leaveScreen("worker");
      log?.stop();
      for (const stop of stops) stop();
      restore();
      unfit();
      leaveSheet(backdrop);
      document.removeEventListener("keydown", onKey);
    },
  };
  // Never scroll the page to reach it: the sheet is fixed on the screen.
  close.focus({ preventScroll: true });
}

/** A chat by name in this sheet, `pr` the one its opener is about; one not live on the Mac answers that when a message is sent. */
export function openChatSheet(chat: string, repo: string | undefined, id: string, owner: string, pr?: number): void {
  const live = app.workers?.workers.find((worker) => worker.chat === chat && (repo === undefined || worker.repo === repo));
  const stub: Worker = { id, name: chatName(chat), repo: repo ?? "", chat, state: "idle", lastOutputAt: null, ...(pr === undefined ? {} : { prs: [pr] }) };
  openWorkerSheet(live ?? stub, { owner, offline: !live, allowUnlistedSend: !live, ...(pr === undefined ? {} : { pr }) });
}

export function closeWorkerSheet(owner?: string): void {
  if (owner !== undefined && open?.owner !== owner) return;
  open?.close();
  open = null;
}
