import { isUpdate, threadKey } from "../../../src/shared/answers.js";
import type { MergedReading } from "../../../src/shared/ask-stages.js";
import { isFinished, moves, type Ask } from "../../../src/shared/asks.js";
import type { Need } from "../../../src/shared/board.js";
import { chatName } from "../../../src/shared/names.js";
import type { PullRequest } from "../../../src/shared/ops.js";
import { askMark, movingAsk, type MovingReadings } from "../../../src/shared/summary.js";
import { when } from "../../../src/shared/when.js";
import { doneAt, NEEDS_YOU, noTimeYet, slipped, slippedTwice, stageWord } from "../../../src/shared/words.js";
import { getAsks } from "../api.js";
import { localDay } from "../day.js";
import { button, h } from "../dom.js";
import { freshPrs, opsData, watchOps } from "../ops-data.js";
import { app, crewLapsed, sameSession, subscribe } from "../state.js";
import { showCard, showSegment } from "./feed.js";
import { fixedToday, foldRow, ownRows, type PlanRow, type PlanState } from "./ops-plan.js";
import { dismissable, dismissItem } from "./ops-status.js";
import { openChatSheet } from "./worker-sheet.js";

// Your asks: one row per ask still open, newest first, with its stage and one time, then today's finished ones. Once
// Ops has a reading, asks nothing is moving fold under Not moving; Rivet's own pick-ups and the records it is on fold away.

export type AskTone = "needs" | "moved" | "asked" | "due" | "finished";

export interface AskRow {
  id: string;
  title: string;
  right: string | null;
  tone: AskTone | null;
  /** The stage, the PR and the chat, one line. */
  sub: string | null;
  /** The sub line's parts, cells of their own in the desktop table: the stage, then the PR and chat. */
  stage: string | null;
  who: string | null;
  /** No time yet, or moved twice: what the Machines mark counts, so it reads amber. */
  counted: boolean;
  /** Building's share done, 0 to 1, drawn as a bar. */
  progress: number | null;
  go: { card: string } | { chat: string; repo: string | undefined } | { needs: true } | { record: PlanRow } | null;
}

export interface AskRows {
  open: AskRow[];
  finished: AskRow[];
  own: AskRow[];
  /** The asks in hand with nothing moving them, folded under Not moving and out of the count. */
  still: AskRow[];
}

const newest = (a: Ask, b: Ask) => Date.parse(b.createdAt) - Date.parse(a.createdAt);

/** The row a fix-result card's fixed record has (ops-plan.ts planState, `kind/key`), by the card's id. */
function fixedRowOf(card: Need, fixed: PlanState["done"]): string | undefined {
  if (card.tag !== "Fixed" || !card.id.startsWith("fix-")) return undefined;
  return fixed.find((one) => {
    const cut = one.id.indexOf("/");
    // The whole id, to its 12-hex hash: `ci/build` must not take `ci/build-web`'s card by its start.
    const head = `fix-${one.id.slice(0, cut)}-${one.id.slice(cut + 1).replace(/[^a-z0-9.-]+/g, "-").slice(0, 40)}-`;
    return cut > 0 && card.id.startsWith(head) && /^[0-9a-f]{12}$/.test(card.id.slice(head.length));
  })?.id;
}

/** A tag that reports a red still open: red, failed or down, and not one that says it is fixed ("Red fixed", "Fixed"). */
function openRed(tag: string | undefined): boolean {
  return /\b(red|failed|down)\b/i.test(tag ?? "") && !/\bfix(ed)?\b/i.test(tag ?? "");
}

/** A thread's Done today row: its newest update card, and whether that card reports a red still open. */
interface UpdateThread {
  key: string;
  head: Need;
  red: boolean;
}

/** The update cards posted today on this phone, newest first. */
function todayUpdates(updates: readonly Need[], now: number): Need[] {
  return updates
    .filter((card) => isUpdate(card) && card.since !== undefined && localDay(card.since) === localDay(now))
    .sort((a, b) => Date.parse(b.since!) - Date.parse(a.since!));
}

/**
 * Today's update cards, one Done today row per thread (the news piles' key, threadKey), newest first, each the thread's
 * newest card. A thread whose newest card's fixed record is already listed has none.
 */
function todayThreads(updates: readonly Need[], fixed: PlanState["done"], now: number): UpdateThread[] {
  const threads = new Map<string, Need[]>();
  for (const card of todayUpdates(updates, now)) {
    const key = threadKey(card.thread);
    threads.set(key, [...(threads.get(key) ?? []), card]);
  }
  // A thread whose newest card is a fix already listed is that fix's row: an older red in it is not shown as done.
  return [...threads].flatMap(([key, cards]) => {
    const head = cards[0]!;
    return fixedRowOf(head, fixed) === undefined ? [{ key, head, red: openRed(head.tag) }] : [];
  });
}

/** Each fixed record's newest fix-result card posted today: its row opens that card's thread. */
function fixCards(updates: readonly Need[], fixed: PlanState["done"], now: number): Map<string, string> {
  const cards = new Map<string, string>();
  for (const card of todayUpdates(updates, now)) {
    const row = fixedRowOf(card, fixed);
    if (row !== undefined && !cards.has(row)) cards.set(row, card.id);
  }
  return cards;
}

const boardUpdates = (): Need[] => (app.board?.board?.needs ?? []).filter(isUpdate);

/** The merges in Ops' timeline. */
export function mergedNow(): MergedReading[] {
  return (opsData.timeline?.days ?? [])
    .flatMap((day) => day.events)
    .flatMap((event) => (event.kind === "merged" && event.number !== undefined && event.at ? [{ repo: event.repo, number: event.number, ...(event.branch ? { branch: event.branch } : {}), at: event.at }] : []));
}

/** What the phone reads as moving, as the server's summary does: a lapsed crew says nothing, nor a lapsed GitHub. */
export function movingNow(): MovingReadings & { prs: PullRequest[] } {
  const lapsed = crewLapsed();
  return {
    workers: lapsed ? [] : (app.workers?.workers ?? []),
    queue: lapsed ? [] : (app.workers?.pushQueue ?? []),
    prs: (opsData.ops && freshPrs(opsData.ops)) ?? [],
    merged: mergedNow(),
  };
}

function rightOf(ask: Ask, now: number): Pick<AskRow, "right" | "tone"> {
  if (ask.stage === "needs-you") return { right: `${NEEDS_YOU} ›`, tone: "needs" };
  const due = ask.dueAt ? Date.parse(ask.dueAt) : NaN;
  // A passed time is no promise, moved or not: No time yet, and when the server asked the chat for a new one.
  if (ask.dueAt && !(due > now)) return { right: noTimeYet(ask.askedForTimeAt, now), tone: "asked" };
  const last = ask.dueHistory.at(-1);
  if (last && ask.dueAt) return { right: moves(ask) >= 2 ? slippedTwice(ask.dueAt, last.why, now) : slipped(ask.dueAt, last.was, last.why, now), tone: "moved" };
  if (due > now) return { right: `by ${when(ask.dueAt!, now)}`, tone: "due" };
  return { right: null, tone: null };
}

/**
 * A desk's bubble: the short form of its ask row's one time, so the scene and the rows never say two things. Always
 * "<stage> · <when>": Needs you; <stage> · no time yet; <stage> · now <time> after a move; <stage> · by <time>; else the stage.
 */
export function bubbleOf(ask: Ask, now: number): { text: string; tone: AskTone | null } {
  const { tone } = rightOf(ask, now);
  if (tone === "needs") return { text: NEEDS_YOU, tone };
  if (tone === "asked") return { text: `${stageWord(ask.stage)} · no time yet`, tone };
  // Amber only once counted, as its row: a time moved once is no mark.
  if (tone === "moved") return { text: `${stageWord(ask.stage)} · now ${when(ask.dueAt!, now)}`, tone: moves(ask) >= 2 ? tone : null };
  if (tone === "due") return { text: `${stageWord(ask.stage)} · by ${when(ask.dueAt!, now)}`, tone };
  return { text: stageWord(ask.stage), tone: null };
}

/** Just an ask's time, as its bubble says it after its stage; null with none. */
export function askTime(ask: Ask, now: number): { text: string; tone: AskTone | null } | null {
  const said = bubbleOf(ask, now);
  const lead = `${stageWord(ask.stage)} · `;
  return said.text.startsWith(lead) ? { text: said.text.slice(lead.length), tone: said.tone } : null;
}

function subOf(ask: Ask, stage: boolean): Pick<AskRow, "sub" | "stage" | "who"> {
  // A needs-you ask already says so in its time slot.
  const word = stage && ask.stage !== "needs-you" ? stageWord(ask.stage) : null;
  const said = word && ask.stage === "building" && ask.progress !== undefined ? `${word} ${Math.round(ask.progress * 100)}%` : word;
  // The PR number before the chat's name, so a long name is what the ellipsis cuts.
  const who = [ask.prs.length ? `#${ask.prs[0]}` : null, ask.chat ? chatName(ask.chat) : null].filter(Boolean).join(" · ");
  const sub = [said, who].filter(Boolean).join(" · ");
  return { sub: sub || null, stage: said, who: who || null };
}

function goOf(ask: Ask): AskRow["go"] {
  // One that names no card opens its chat, or Cards under Needs you, where the card that stands for it is.
  const card = ask.stage !== "needs-you" ? undefined : ask.cardId;
  if (card) return { card };
  if (ask.chat) return { chat: ask.chat, repo: ask.repo };
  return ask.stage === "needs-you" ? { needs: true } : null;
}

function openRow(ask: Ask, now: number): AskRow {
  return {
    id: ask.id,
    title: ask.words,
    ...rightOf(ask, now),
    // The summary's rule (src/shared/summary.ts), so a row and the mark never disagree.
    counted: askMark(ask, now) !== null,
    ...subOf(ask, true),
    progress: ask.stage === "building" && ask.progress !== undefined ? ask.progress : null,
    go: goOf(ask),
  };
}

function recordRow(row: PlanRow, now: number): AskRow {
  const base = { id: row.id, title: row.title, counted: row.counted, sub: row.why, stage: null, who: null, progress: null, go: { record: row } };
  // A late record reads as a late ask: its time moved while the new one is ahead, else no time yet.
  if (row.late) return { ...base, right: row.late, tone: row.dueAt && Date.parse(row.dueAt) > now ? "moved" : "asked" };
  return { ...base, right: row.dueAt ? `by ${when(row.dueAt, now)}` : (row.eta ?? noTimeYet()), tone: row.dueAt || row.eta ? "due" : null };
}

/**
 * The rows of Your asks at `now`: the open ones newest first, then the ones finished today, newest first. `records` are
 * the Ops records and breaks Rivet is on (ownRows), folded under Rivet's own, counted ones first; a record is what its
 * chat keeps current, so it stands in for the pick-up ask made from it, open or done today. Today's update cards from
 * `updates` (the board's) are Done today rows too, one per thread. With `readings` null nothing is read yet, so nothing folds.
 */
export function askRows(asks: readonly Ask[], now: number, records: readonly PlanRow[] = [], fixed: PlanState["done"] = [], updates: readonly Need[] = [], readings: MovingReadings | null = null): AskRows {
  const unfinished = asks.filter((ask) => !isFinished(ask.stage)).sort(newest);
  const counted = (a: AskRow, b: AskRow) => Number(b.counted) - Number(a.counted);
  const inHand = unfinished.filter((ask) => ask.who !== "rivet");
  // With no PR reading on this phone yet, an ask naming a PR stays up: the summary's number has the server's reading.
  const unread = !opsData.ops || !freshPrs(opsData.ops);
  const moving = (ask: Ask) => !readings || movingAsk(ask, readings, now) || (unread && ask.prs.length > 0);
  const open = inHand.filter(moving).map((ask) => openRow(ask, now));
  const still = inHand.filter((ask) => !moving(ask)).map((ask) => openRow(ask, now)).sort(counted);
  const fixedIds = new Set(fixed.map((one) => `pickup:${one.id}`));
  const fixCard = fixCards(updates, fixed, now);
  const none = { counted: false, stage: null, who: null, progress: null };
  // Today's finished asks, what Ops fixed today and today's update threads, one list, newest first; a fix, its pick-up
  // ask and its fix-result card once.
  const finished = [
    ...asks
      .filter((ask) => isFinished(ask.stage) && ask.stage !== "parked" && localDay(ask.stageAt) === localDay(now) && !(ask.source && fixedIds.has(ask.source)))
      .map((ask) => ({ at: ask.stageAt, row: { id: ask.id, title: ask.words, right: stageWord(ask.stage, ask.stageAt, now), tone: "finished", counted: false, ...subOf(ask, false), progress: null, go: goOf(ask) } as AskRow })),
    ...fixed.map((one) => {
      const card = fixCard.get(one.id);
      return { at: one.at, row: { ...none, id: one.id, title: one.text, right: doneAt(one.at, now), tone: "finished", sub: null, go: card ? { card } : null } as AskRow };
    }),
    ...todayThreads(updates, fixed, now).map(({ key, head, red }) => ({
      at: head.since!,
      row: { ...none, id: `update:${key}`, title: head.title, right: red ? when(head.since!, now) : doneAt(head.since!, now), tone: red ? null : "finished", sub: null, go: { card: head.id } } as AskRow,
    })),
  ]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .map((one) => one.row);
  // A record stands in for its pick-up ask, as the summary's askCounts has it; a break with no record gives way to it,
  // and the ask, which names no chat or card, opens the break's sheet and its Dismiss instead.
  const kept = new Set(records.flatMap((row) => (row.record ? [`pickup:${row.record}`] : [])));
  const breaks = new Map<string, PlanRow>(records.flatMap((row) => (row.record ? [] : [[`pickup:${row.id}`, row] as const])));
  const rivet = unfinished.filter((ask) => ask.who === "rivet" && !(ask.source && kept.has(ask.source)));
  const asked = new Set(rivet.map((ask) => ask.source));
  const own = [
    ...rivet.map((ask) => {
      const row = openRow(ask, now);
      const gave = ask.source ? breaks.get(ask.source) : undefined;
      return gave && !row.go ? { ...row, go: { record: gave } } : row;
    }),
    ...records.filter((row) => row.record || !asked.has(`pickup:${row.id}`)).map((row) => recordRow(row, now)),
  ].sort(counted);
  return { open, finished, own, still };
}

let asks: Ask[] | null = null;
let loadedAt = 0;
/** Reads started: only the latest one's answer is kept, as an older one can land after it. */
let loads = 0;
let ownOpen = false;
/** The rows Rivet's own held at the last render that open it: counted, or waiting on you. */
let ownCounted = new Set<string>();
let stillOpen = false;
let host: HTMLElement | null = null;
let stops: (() => void)[] = [];
const readers = new Set<() => void>();

/** The asks as last read. */
export const openAsks = (): readonly Ask[] => asks ?? [];

/** The rows as listed now: nothing folds before Ops has a reading. */
function rowsNow(now: number): AskRows {
  return askRows(asks ?? [], now, ownRows(now), fixedToday(now), boardUpdates(), opsData.ops ? movingNow() : null);
}

/**
 * The open row of Your asks due soonest within `withinMs` of `now`, one that needs you left out (its card says so): its
 * time as its row says it, its title and its tap. It picks from the rows as listed, so a record standing in for its
 * pick-up ask gives the record's current deadline, never the ask's first one.
 */
export function dueSoon(now: number, withinMs: number): { time: string; title: string; open: (() => void) | null } | null {
  const rows = rowsNow(now);
  const byId = new Map((asks ?? []).map((ask) => [ask.id, ask] as const));
  const soon = (at: number) => at > now && at <= now + withinMs;
  const next = [...rows.open, ...rows.still, ...rows.own]
    .flatMap((row) => {
      const ask = byId.get(row.id);
      if (ask) {
        const at = ask.dueAt ? Date.parse(ask.dueAt) : NaN;
        const time = askTime(ask, now);
        return ask.stage !== "needs-you" && !isFinished(ask.stage) && soon(at) && time ? [{ at, time: time.text, row }] : [];
      }
      const record = row.go && "record" in row.go ? row.go.record : null;
      const at = record?.dueAt ? Date.parse(record.dueAt) : NaN;
      return record?.dueAt && soon(at) ? [{ at, time: `by ${when(record.dueAt, now)}`, row }] : [];
    })
    .sort((a, b) => a.at - b.at)[0];
  return next ? { time: next.time, title: next.row.title, open: go(next.row) } : null;
}

/** Calls `fn` after each read of the asks; returns its stop. */
export function watchAsks(fn: () => void): () => void {
  readers.add(fn);
  return () => readers.delete(fn);
}

/** The asks read again on a redraw this long after the last read, no oftener. */
const ASKS_STALE_MS = 60_000;

/** The shell keeps the asks read on every screen; `fn` runs after each read. */
export function keepAsks(fn: () => void): () => void {
  const unwatch = watchAsks(fn);
  const stale = () => {
    if (Date.now() - loadedAt >= ASKS_STALE_MS) void load();
  };
  const unsubscribe = subscribe(stale);
  stale();
  return () => {
    unwatch();
    unsubscribe();
  };
}

function go(row: AskRow): (() => void) | null {
  const to = row.go;
  if (!to) return null;
  if ("card" in to) return () => showCard(to.card);
  if ("chat" in to) return () => openChatSheet(to.chat, to.repo, `ask-${row.id}`, "asks");
  if ("needs" in to) return () => showSegment("needs");
  return to.record.open;
}

/** The page's CSP takes no style attribute, so the fill is sized through the CSSOM. */
function bar(progress: number): HTMLElement {
  const fill = h("span");
  fill.style.width = `${Math.round(progress * 100)}%`;
  return h("span", { class: "ask-bar", attrs: { "aria-hidden": "true" } }, fill);
}

/** A row's time. A moved or asked one is a sentence: its new time and the rest are spans of their own. */
function whenEl(row: AskRow): HTMLElement | null {
  if (!row.right) return null;
  const cls = `ask-when${row.tone ? ` is-${row.tone}` : ""}`;
  const cut = row.tone === "moved" || row.tone === "asked" ? row.right.indexOf(", ") : -1;
  if (cut < 0) return h("span", { class: cls }, row.right);
  return h("span", { class: cls }, h("span", { class: "ask-now" }, row.right.slice(0, cut)), h("span", { class: "ask-was" }, h("span", { class: "ask-comma" }, ", "), row.right.slice(cut + 2)));
}

/** The sub line: the stage and the PR and chat as cells of their own, or a record's why as one line. */
function subEl(row: AskRow): HTMLElement | null {
  if (!row.sub) return null;
  if (!row.stage && !row.who) return h("span", { class: "ask-sub is-note" }, row.sub);
  return h(
    "span",
    { class: "ask-sub" },
    row.stage ? h("span", { class: "ask-stage" }, row.stage) : null,
    row.stage && row.who ? h("span", { class: "ask-dot" }, " · ") : null,
    row.who ? h("span", { class: "ask-who" }, row.who) : null,
  );
}

function rowEl(row: AskRow): HTMLElement {
  const parts = [h("span", { class: "ask-title" }, row.title), whenEl(row), subEl(row), row.progress !== null ? bar(row.progress) : null];
  const open = go(row);
  // A moved time or a time asked for is a sentence: it takes its own line under the title, so the title stays whole.
  const cls = `ask-row${row.tone === "moved" || row.tone === "asked" ? " is-long" : ""}${row.counted ? " is-counted" : ""}`;
  const record = row.go && "record" in row.go ? row.go.record : null;
  const dismiss = record?.picking && dismissable(record.item) ? record.item : null;
  const use = record ? (record.kind === "coming" ? "coming.sheet.open" : "ops.status.detail") : row.id.startsWith("update:") ? "updates.pile.open" : "plan.ask.open";
  const el = open
    ? h("button", { class: cls, attrs: { type: "button", "data-ask": row.id, "data-use": use }, on: { click: open } }, ...parts)
    : h("div", { class: cls, attrs: { "data-ask": row.id } }, ...parts);
  return h("li", { class: dismiss ? "ask-has-dismiss" : "" }, el, dismiss ? button("Dismiss", () => dismissItem(dismiss), "ghost plan-dismiss", false, "plan.dismiss") : null);
}

/** Names a fold; one holding a counted row reads amber, so the mark never points at a closed fold's nothing. */
function named(fold: HTMLElement, name: string, rows: readonly AskRow[]): HTMLElement {
  fold.dataset.fold = name;
  fold.classList.toggle("is-counted", rows.some((row) => row.counted));
  return fold;
}

function render(): void {
  if (!host) return;
  const now = Date.now();
  const rows = rowsNow(now);
  // Rivet's own opens for a counted or Needs-you row it has not held as such before, so the amber mark never points at
  // a closed fold and a question past the cards' cap still shows; a close stands until a new one comes.
  const held = rows.own.flatMap((row) => (row.tone === "needs" ? [`${row.id} needs`] : row.counted ? [`${row.id} counted`] : []));
  if (held.some((id) => !ownCounted.has(id))) ownOpen = true;
  ownCounted = new Set(held);
  host.replaceChildren(
    h(
      "section",
      { class: "your-asks", attrs: { "data-section": "asks", "aria-label": "Your asks" } },
      h("h2", { class: "asks-head" }, `In hand · ${rows.open.length}`),
      rows.open.length ? h("ul", { class: "asks-rows" }, ...rows.open.map(rowEl)) : asks ? h("p", { class: "asks-empty" }, "Nothing in hand. Ask in Chat and it shows here.") : null,
      rows.still.length ? named(foldRow(`Not moving · ${rows.still.length}`, stillOpen, () => (stillOpen = !stillOpen), render), "still", rows.still) : null,
      stillOpen && rows.still.length ? h("ul", { class: "asks-rows" }, ...rows.still.map(rowEl)) : null,
      rows.own.length ? named(foldRow(`Rivet's own · ${rows.own.length}`, ownOpen, () => (ownOpen = !ownOpen), render), "own", rows.own) : null,
      ownOpen && rows.own.length ? h("ul", { class: "asks-rows" }, ...rows.own.map(rowEl)) : null,
      rows.finished.length ? h("h2", { class: "asks-head" }, `Done today · ${rows.finished.length}`) : null,
      rows.finished.length ? h("ul", { class: "asks-rows done-rows" }, ...rows.finished.map(rowEl)) : null,
    ),
  );
}

async function load(): Promise<void> {
  const current = sameSession();
  const mine = ++loads;
  loadedAt = Date.now();
  try {
    const read = await getAsks();
    if (!current() || mine !== loads) return;
    asks = read.asks;
  } catch {
    // The last list stays; the next poll or pull to refresh tries again.
    return;
  }
  render();
  for (const fn of readers) fn();
}

export function mount(el: HTMLElement): void {
  unmount();
  host = el;
  // Each visit opens with its folds closed, but for a counted or Needs-you row Rivet's own has not shown before.
  stillOpen = ownOpen = false;
  stops = [subscribe(() => render()), watchOps(() => render())];
  render();
  void load();
}

/** Pull to refresh. */
export function refresh(): Promise<void> {
  return load();
}

export function unmount(): void {
  for (const stop of stops) stop();
  stops = [];
  host = null;
}
