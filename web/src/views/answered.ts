import "./answered.css";

import { ANSWERED_WINDOWS, answeredShown, cardFromReply, DEFAULT_ANSWERED_WINDOW, type AnsweredCard, type AnsweredResponse, type AnsweredWindow } from "../../../src/shared/answered.js";
import type { Decision, Reply, ServedNeed } from "../../../src/shared/board.js";
import { dayHeading } from "../../../src/shared/when.js";
import { localDay } from "../day.js";
import { answeredChip, CHAT_TOLD, noAnsweredIn, REOPEN, reopenedBand, SEND_AGAIN, SHOW_DONE, YES, youAnswered, type ChatTold } from "../../../src/shared/words.js";
import * as api from "../api.js";
import { answerState } from "../answer-state.js";
import { button, h } from "../dom.js";
import { onSessionReset, StaleSession } from "../session.js";
import { app, cardState, changed, macOffline, refresh, sameSession, subscribe } from "../state.js";
import { showCard, showSegment } from "./feed.js";
import { flash } from "./toast.js";

// Cards › Answered:
// every card he answered in the last 30 days, newest first and grouped by day, each with Reopen; and the band on a
// reopened card back on the open deck. The list is the server's (GET /api/answered); the phone and the computer read it.
// Over it, time chips (6h to All, 24h at first) and Show done, off at first, which hides the cards whose work is finished
// (answeredDone); both stay on the device, and Answered N counts the rows they leave.

/** A reopened card's band keeps asking the server how its chat's notice is going this often while it is on its way; a failed read is tried again after as long. */
const AGAIN_MS = 10_000;
/** Done comes from asks too, which a poll does not watch: the list is read again this often while Cards is on screen. */
const READ_EVERY_MS = 60_000;

let data: AnsweredResponse | null = null;
/** The dataRev the list was last read at: a poll that changed the board or the answers reads it again. */
let readRev = -1;
let reading = false;
/** The next read while a chat is being told, so its band turns without another redraw, or after a read failed. */
let againTimer: ReturnType<typeof setTimeout> | null = null;
/** The redraw when the oldest row the chip shows passes out of its hours. */
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * The answer a search hit asked for: its card's row is lit, and scrolled to once. An answer the list does not hold (its
 * card open again, an update's, or older than 30 days) is shown as a row of its own, without Reopen.
 */
let found: { reply: Reply; scrolled: boolean } | null = null;
/** Cards whose Reopen, or reopens whose Send again, is on its way. */
const busy = new Set<string>();

const WINDOW_KEY = "rivet.answered.window";
const DONE_KEY = "rivet.answered.done";
/** The chip and Show done as last read or picked; undefined reads them from the device. */
let windowPicked: AnsweredWindow | undefined;
let doneShown: boolean | undefined;

function saved(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: the choice lasts until the page closes.
  }
}

/** The time chip picked on this device; 24h until one is. */
export function answeredWindow(): AnsweredWindow {
  if (windowPicked === undefined) {
    // By index: the All chip's hours are null, which `find` could not tell from no match.
    const at = ANSWERED_WINDOWS.findIndex((hours) => String(hours ?? "all") === saved(WINDOW_KEY));
    windowPicked = at < 0 ? DEFAULT_ANSWERED_WINDOW : ANSWERED_WINDOWS[at]!;
  }
  return windowPicked;
}

/** Whether Show done is on on this device; off until it is turned on. */
export function showDone(): boolean {
  if (doneShown === undefined) doneShown = saved(DONE_KEY) === "1";
  return doneShown;
}

function pickWindow(hours: AnsweredWindow): void {
  windowPicked = hours;
  found = null;
  save(WINDOW_KEY, String(hours ?? "all"));
  changed();
}

function toggleDone(): void {
  doneShown = !showDone();
  found = null;
  save(DONE_KEY, doneShown ? "1" : "0");
  changed();
}

/** Forgets the chip and Show done as read, so the next read comes from the device (tests). */
export function resetAnsweredFilters(): void {
  windowPicked = undefined;
  doneShown = undefined;
}

onSessionReset(() => {
  data = null;
  readRev = -1;
  reading = false;
  if (againTimer) clearTimeout(againTimer);
  againTimer = null;
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  found = null;
  busy.clear();
});

subscribe(() => readIfStale());

/**
 * Reads the list while Cards or the Decide sheet (whose switch counts it, opened off an agent too) is on screen, and
 * again after a poll changed what it shows or its timer ran out.
 */
function readIfStale(): void {
  if (reading || !(app.tab === "cards" || document.querySelector(".decide-sheet")) || !app.board || readRev === app.dataRev) return;
  void readAnswered();
}

function readAgainIn(ms: number): void {
  if (againTimer) clearTimeout(againTimer);
  againTimer = setTimeout(() => ((againTimer = null), (readRev = -1), readIfStale()), ms);
}

async function readAnswered(): Promise<void> {
  reading = true;
  const rev = app.dataRev;
  const current = sameSession();
  try {
    const next = await api.getAnswered();
    if (!current()) return;
    const same = JSON.stringify(next) === JSON.stringify(data);
    data = next;
    readRev = rev;
    if (againTimer) clearTimeout(againTimer);
    againTimer = null;
    readAgainIn(next.reopened.some((reopen) => chatTold(reopen) === "telling") ? AGAIN_MS : READ_EVERY_MS);
    if (!same) changed();
  } catch {
    // Tried again in 10 s, or at the next poll that changes the board; the switch keeps the last count it read.
    if (!current()) return;
    readRev = rev;
    readAgainIn(AGAIN_MS);
  } finally {
    if (current()) reading = false;
  }
}

/** Answered N on the switch: the rows the chip and Show done leave; null until the list has loaded once. Drawing it reads the list when that is due. */
export function answeredCount(): number | null {
  readIfStale();
  return data ? entries().length : null;
}

/** The answer in the words its button showed: the option's own label, else Yes, No, Done, Dismissed or Comment. */
export function answerWord(reply: Pick<Reply, "decision" | "choice">): string {
  const words: Record<Decision, string> = { approve: YES, reject: "No", choice: "", done: "Done", seen: "Seen", dismiss: "Dismissed", comment: "Comment" };
  return reply.decision === "choice" ? (reply.choice ?? "") : words[reply.decision];
}

/** The answer and what the owner typed with it: `Change it “slower, 2 s”`. */
function answerText(reply: Pick<Reply, "decision" | "choice" | "text">): string {
  const word = answerWord(reply);
  return reply.text?.trim() ? `${word} “${reply.text.trim()}”` : word;
}

/** A yes reads green, a no red, Change it and anything else blue. */
function tone(reply: Pick<Reply, "decision" | "choice">): string {
  if (reply.decision === "reject") return "no";
  if (reply.decision === "choice") return /^change it$/i.test((reply.choice ?? "").trim()) ? "note" : "yes";
  return reply.decision === "approve" || reply.decision === "done" ? "yes" : "note";
}

/** A line from words.ts with the answer in it in bold, in its tone. */
function withAnswer(line: string, reply: Reply): (HTMLElement | string)[] {
  const answer = answerText(reply);
  const at = line.indexOf(answer);
  if (at < 0) return [line];
  return [h("span", {}, line.slice(0, at)), h("b", { class: `ans-word ${tone(reply)}` }, answer), h("span", {}, line.slice(at + answer.length))];
}

/**
 * Reopen: the answered card becomes a new revision of itself on the open deck, where the next answer lands as a change
 * of this one, and its chat is told (POST /api/board/needs/:id/again). A card that changed meanwhile says so.
 */
async function reopen(entry: AnsweredCard): Promise<void> {
  const { id, rev } = entry.card;
  if (busy.has(id)) return;
  busy.add(id);
  changed();
  const current = sameSession();
  try {
    const { item } = await api.answerAgain(id, rev);
    // The new revision at once, so a refresh that fails cannot leave the next answer on the old one.
    const board = app.board?.board;
    if (current() && board) {
      const on = board.needs.some((one) => one.id === item.id);
      app.board = { ...app.board!, board: { ...board, needs: on ? board.needs.map((one) => (one.id === item.id ? item : one)) : [...board.needs, item] } };
    }
  } catch (error) {
    if (error instanceof StaleSession || !current()) return;
    busy.delete(id);
    changed();
    flash(error instanceof Error ? error.message : "Could not open the card again. Try again.", "error");
    readRev = -1;
    await refresh();
    return;
  }
  readRev = -1;
  await refresh();
  if (!current()) return;
  busy.delete(id);
  const card = cardState(id);
  if (card.pending && app.landed.has(card.pending.clientId)) card.pending = null;
  showCard(id);
}

async function sendAgain(reopenId: string): Promise<void> {
  if (busy.has(reopenId)) return;
  busy.add(reopenId);
  changed();
  const current = sameSession();
  try {
    await api.sendReopenAgain(reopenId);
  } catch (error) {
    if (error instanceof StaleSession || !current()) return;
    flash(error instanceof Error ? error.message : "Could not send it again. Try again.", "error");
  }
  if (!current()) return;
  busy.delete(reopenId);
  changed();
  await readAnswered();
}

function reopenButton(entry: AnsweredCard, variant: string): HTMLButtonElement {
  const element = button(REOPEN, () => void reopen(entry), variant, busy.has(entry.card.id), "answered.reopen");
  element.setAttribute("aria-label", `${REOPEN} ${entry.card.title}`);
  return element;
}

/** One answered row: its title, `You: <answer> · <time>`, where the answer got to, and Reopen. */
function row(entry: AnsweredCard, reopens: boolean): HTMLElement {
  const { card, reply } = entry;
  const state = answerState(reply, macOffline());
  return h(
    "li",
    {
      class: `ans-row box${found?.reply.id === reply.id ? " found" : ""}`,
      attrs: { "data-card": card.id, "data-reply": reply.id },
    },
    h(
      "div",
      { class: "ans-text" },
      h("span", { class: "ans-t" }, card.title),
      h("span", { class: "ans-you" }, ...withAnswer(youAnswered(answerText(reply), reply.at), reply)),
      h("span", { class: `ans-state ${state.tone}` }, state.text),
    ),
    reopens ? reopenButton(entry, "ans-reopen") : null,
  );
}

/** The list's answers the chip and Show done keep, with a search hit's answer in its place by time whatever they keep. */
function entries(): AnsweredCard[] {
  const now = Date.now();
  const window = answeredWindow();
  const cards = answeredShown(data?.cards ?? [], window, showDone(), now);
  // Done rows too: the empty line counts them.
  redrawAtExpiry(showDone() ? cards : answeredShown(data?.cards ?? [], window, true, now), window, now);
  const reply = found?.reply;
  if (!reply || cards.some((entry) => entry.reply.id === reply.id)) return cards;
  const at = cards.findIndex((entry) => entry.reply.at < reply.at);
  const extra = data?.cards.find((entry) => entry.reply.id === reply.id) ?? { card: { ...cardFromReply(reply), rev: reply.rev ?? "" } as ServedNeed, reply };
  return at < 0 ? [...cards, extra] : [...cards.slice(0, at), extra, ...cards.slice(at)];
}

/** Redraws once the oldest of the chip's rows is older than its hours, so the list, its count and the empty line drop it unprompted. */
function redrawAtExpiry(cards: readonly AnsweredCard[], window: AnsweredWindow, now: number): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  if (window === null || !cards.length) return;
  const ends = Math.min(...cards.map((entry) => Date.parse(entry.reply.at))) + window * 3600_000;
  expiryTimer = setTimeout(() => ((expiryTimer = null), changed()), Math.max(ends - now + 1, 0));
}

/** Whether Reopen is offered: on the list's own answers, not on a search hit's answer it does not hold. */
function reopens(entry: AnsweredCard): boolean {
  return data?.cards.includes(entry) ?? false;
}

/** The line where no row is left: none answered in the chip's hours, or each one there done while Show done is off. */
function noneLine(): string {
  const window = answeredWindow();
  const done = showDone() ? 0 : answeredShown(data?.cards ?? [], window, true, Date.now()).filter((entry) => entry.done).length;
  return noAnsweredIn(window, done);
}

/** The time chips and Show done over the list. */
function filters(): HTMLElement {
  const picked = answeredWindow();
  const done = showDone();
  return h(
    "div",
    { class: "ans-filters" },
    h(
      "div",
      { class: "ans-chips", attrs: { role: "group", "aria-label": "Answered in the last" } },
      ...ANSWERED_WINDOWS.map((hours) =>
        h(
          "button",
          { class: `ans-chip${hours === picked ? " on" : ""}`, attrs: { type: "button", "aria-pressed": String(hours === picked), "data-window": String(hours ?? "all"), "data-use": hours === null ? "answered.window.all" : `answered.window.${hours}h` }, on: { click: () => pickWindow(hours) } },
          answeredChip(hours),
        ),
      ),
    ),
    h(
      "button",
      { class: `ans-done${done ? " on" : ""}`, attrs: { type: "button", role: "switch", "aria-checked": String(done), "data-use": "answered.show-done" }, on: { click: toggleDone } },
      h("span", {}, SHOW_DONE),
      h("span", { class: "ans-knob", attrs: { "aria-hidden": "true" } }),
    ),
  );
}

/** Decide › Answered: the chips and Show done, then the rows they keep, newest first and grouped by local day. */
export function answeredList(): HTMLElement {
  if (!data) return h("section", { class: "ans", attrs: { "aria-label": "Answered", "aria-busy": "true" } });
  const all = entries();
  if (!all.length) return h("section", { class: "ans", attrs: { "aria-label": "Answered" } }, filters(), h("p", { class: "feed-quiet ans-empty" }, noneLine()));
  const days: { day: string; at: string; rows: AnsweredCard[] }[] = [];
  for (const entry of all) {
    const day = localDay(entry.reply.at);
    const last = days[days.length - 1];
    if (last?.day === day) last.rows.push(entry);
    else days.push({ day, at: entry.reply.at, rows: [entry] });
  }
  const list = h(
    "section",
    { class: "ans", attrs: { "aria-label": "Answered" } },
    filters(),
    ...days.flatMap(({ at, rows }) => [h("h2", { class: "ans-day" }, dayHeading(at)), h("ol", { class: "ans-list" }, ...rows.map((entry) => row(entry, reopens(entry))))]),
  );
  if (found && !found.scrolled) {
    const target = found;
    queueMicrotask(() => {
      const at = list.querySelector<HTMLElement>(`[data-reply="${CSS.escape(target.reply.id)}"]`);
      if (!at?.isConnected) return;
      target.scrolled = true;
      at.scrollIntoView?.({ block: "center" });
    });
  }
  return list;
}

/** told once acked and confirmed, unconfirmed once acked without, not-told when its 24 hours ran out, else telling. */
function chatTold(reopen: AnsweredResponse["reopened"][number]): ChatTold {
  if (reopen.delivery) return reopen.delivery.confirmed === false ? "unconfirmed" : "told";
  return reopen.expired ? "not-told" : "telling";
}

/** The band on a reopened card: when the owner reopened it, his answer before, whether its chat heard, and if its PR merged. */
export function reopenBand(need: ServedNeed): HTMLElement | null {
  const reopen = data?.reopened.find((one) => one.cardId === need.id && one.rev === need.rev);
  if (!reopen) return null;
  const told = chatTold(reopen);
  const earlier = reopen.earlier;
  return h(
    "div",
    { class: `ans-reopened box ${told}`, attrs: { "data-told": told } },
    h(
      "p",
      { class: "ans-band-line" },
      ...(earlier ? withAnswer(reopenedBand(reopen.at, answerText(earlier)), earlier) : []),
      earlier ? " " : null,
      h("span", { class: "ans-told" }, CHAT_TOLD[told]),
    ),
    told === "not-told" ? button(SEND_AGAIN, () => void sendAgain(reopen.id), "ans-send", busy.has(reopen.id), "answered.send-again") : null,
  );
}

/** Opens Cards on Answered, with one answer's row lit (a search hit for an answer). */
export function showAnswered(reply: Reply | null = null): void {
  found = reply ? { reply, scrolled: false } : null;
  readRev = -1;
  showSegment("done");
}
