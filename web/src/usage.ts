// What you used: the screens you open and the controls you tap, by registry id (src/shared/usage-ids.ts) and numbers only.
// Nothing here reads text: a tap names its control by its `data-use`, a card event by its kind. No timer, no DOM
// write, and no scroll, touchmove or wheel listener: one capture click on the document and a passive scrollend on the
// long views. Off in vite dev (the preview fixtures are dev-only pages) and in any automated browser.

import {
  idFits,
  MAX_USAGE_EVENTS,
  MAX_USAGE_VALUE,
  USAGE_BY_ID,
  USAGE_CARD_KINDS,
  USAGE_KEEP_MS,
  type UsageDevice,
  type UsageEventKind,
} from "../../src/shared/usage-ids.js";
import { ApiError, call } from "./api.js";
import { DESK_QUERY } from "./desk.js";

type Stored = [at: number, kind: UsageEventKind, id: string, screen: string, value: number];
type Outcome = "approve" | "reject" | "choice" | "comment" | "done" | "seen" | "dismiss" | "minimise" | "undo";

/** What the app shows under any sheet, read at each `changed()`. */
export interface Where {
  tab: "cards" | "progress" | "chat" | "more";
  desk: boolean;
  morePage: string | null;
  cards: "needs" | "done";
}

export const OUTBOX_KEY = "rivet.usage";
export const OUTBOX_MAX = 500;
export const FLUSH_AT = 50;
const CONTROL = 'button, a[href], summary, [role="switch"], [role="tab"], [role="option"], [data-use]';
const MORE_SCREENS: Record<string, string> = {
  floor: "floor",
  usage: "more.usage",
  mind: "more.mind",
  machines: "more.machines",
  home: "more.home",
  media: "more.media",
  settings: "more.settings",
  "what-you-used": "more.what-you-used",
  code: "ops.code",
};
const CARDS_SCREENS: Record<Where["cards"], string> = { needs: "cards", done: "answered" };
/** The long part of a page whose scroll is its depth: Code is its Timeline. */
const DEPTH_OF: Record<string, string> = { "ops.code": "ops.timeline" };
/** A sheet that shows the screen under it: on a phone a menu page's sheet is the More tab, so the page is on top. */
const SHOWS: Record<string, string> = { "floor.page": "floor" };
/** The long views a sheet shows besides its own: Decide shows Answered, Rivet's sheet the Chat. */
const SHEET_VIEWS: Record<string, readonly string[]> = { decide: ["answered"], "floor.rivet": ["chat"] };
const owns = (sheet: string, view: string) => view === sheet || (SHEET_VIEWS[sheet]?.includes(view) ?? false);

/** A screen's visit: `acc` its time on top so far, `since` when it last came on top (null while covered or hidden). */
interface Open {
  id: string;
  acc: number;
  since: number | null;
  /** Some of its time went up when the app was hidden, so a zero left at its end is no new visit. */
  told: boolean;
}

let on = false;
let where: (() => Where) | null = null;
let queue: Stored[] = [];
/** Everything not yet taken by the server, oldest first, mirrored to the outbox; the first `inFlight` are being sent. */
let held: Stored[] = [];
let inFlight = 0;
let sending: Promise<void> | null = null;
let idle = false;
let base: Open | null = null;
const stack: Open[] = [];
let hiddenAt: number | null = null;
const depth = new Map<string, number>();
const watched = new WeakSet<Element>();
const shown = new Map<string, number>();

const clamp = (value: number) => (Number.isFinite(value) ? Math.min(MAX_USAGE_VALUE, Math.max(0, Math.round(value))) : 0);
const screenId = (id: string) => (USAGE_BY_ID.get(id)?.kind === "screen" ? id : "unknown");
const topOpen = () => {
  const sheet = stack.at(-1);
  return sheet && !(SHOWS[sheet.id] && base && base.id !== SHOWS[sheet.id]) ? sheet : base;
};
const top = () => topOpen()?.id ?? "unknown";
const opened = (id: string): Open => ({ id, acc: 0, since: null, told: false });

/** Only the screen on top runs its clock, and none while the app is hidden. */
function pause(now: number): void {
  const open = topOpen();
  if (open && open.since !== null) {
    open.acc += now - open.since;
    open.since = null;
  }
}

function resume(now: number): void {
  const open = topOpen();
  if (open && open.since === null && hiddenAt === null) open.since = now;
}

function record(kind: UsageEventKind, id: string, screen: string, value: number): void {
  if (!on) return;
  queue.push([Date.now(), kind, id, screen, clamp(value)]);
  if (queue.length >= FLUSH_AT && !idle) {
    // Without an idle callback (Safari) the send goes now: the recorder sets no timer.
    if (!window.requestIdleCallback) return void flushUsage();
    idle = true;
    window.requestIdleCallback(() => {
      idle = false;
      void flushUsage();
    });
  }
}

/** `under`: the screen under the sheets, whose going ends the visit of every long view but an open sheet's. */
function leave(open: Open, under = false): void {
  if (open.acc > 0 || !open.told) record("screen", open.id, open.id, open.acc);
  for (const [id, deepest] of depth) {
    if (!owns(open.id, id) && !(under && !stack.some((sheet) => owns(sheet.id, id)))) continue;
    record("scroll", id, id, deepest);
    depth.delete(id);
  }
}

/** Starts recording, unless this is vite dev or an automated browser. `read` says what is on screen under the sheets. */
export function startUsage(read: () => Where): void {
  where = read;
  if (on || navigator.webdriver || import.meta.env.DEV) return;
  on = true;
  held = readOutbox();
  document.addEventListener("click", tapped, { capture: true });
  screenMoved();
}

function tapped(event: MouseEvent): void {
  const control = event.target instanceof Element ? event.target.closest(CONTROL) : null;
  if (!control) return;
  // A link in a tagged control's text is that control: its own tag, or the nearest one around it.
  const named = control.closest("[data-use]");
  useTap(named?.getAttribute("data-use") ?? "", Number(named?.getAttribute("data-use-value") ?? 0));
}

/** A key or gesture, by its registry id; `value` is its position in a family. */
export function useTap(id: string, value = 0): void {
  record("tap", idFits("tap", id) ? id : "unnamed", top(), value);
}

/** An overlay or sheet came over the screen. */
export function enterScreen(id: string): void {
  if (!on) return;
  const now = Date.now();
  pause(now);
  stack.push(opened(screenId(id)));
  resume(now);
}

/** It went: its time is recorded, and any opened over it go with it. */
export function leaveScreen(id: string): void {
  const at = stack.map((open) => open.id).lastIndexOf(screenId(id));
  if (at < 0) return;
  const now = Date.now();
  pause(now);
  for (const open of stack.splice(at).reverse()) leave(open);
  resume(now);
}

/** The tab, More page or Cards view may have changed (state.ts `changed()`). */
export function screenMoved(): void {
  if (!on || !where) return;
  const now = where();
  const page = now.tab === "more" && now.morePage ? (MORE_SCREENS[now.morePage] ?? "unknown") : null;
  // A phone shows the home screen under every tab: Cards, Chat and More are its Decide, Rivet and page sheets (home.ts
  // syncSheets). Each comes up before `changed()` reads its tab and goes before it reads the home screen's: a base named
  // by the tab would get only a sheet's opening and closing ms, a screen you never see.
  const next = !now.desk
    ? (page ?? "floor")
    : now.tab === "progress" ? "progress" : now.tab === "cards" ? CARDS_SCREENS[now.cards] : now.tab === "chat" ? "chat" : (page ?? "more");
  if (base?.id === next) return;
  const at = Date.now();
  pause(at);
  if (base) leave(base, true);
  base = opened(next);
  resume(at);
}

/** A zero-value screen event saying how the app was opened: `decide.via-push`, `decide.via-link` or `tab.via-link`. */
export function openedVia(id: "decide.via-push" | "decide.via-link" | "tab.via-link"): void {
  record("screen", id, top(), 0);
}

/** A card first ≥50% in view; kept in memory only, by its id, for the ms to its answer. */
export function cardShown(cardId: string): void {
  if (on && !shown.has(cardId)) shown.set(cardId, Date.now());
}

/** A card answered, minimised or undone: its kind and what happened go up, never its id. */
export function cardAnswered(need: { id: string; kind: string }, outcome: Outcome): void {
  const kind = (USAGE_CARD_KINDS as readonly string[]).includes(need.kind) ? need.kind : "other";
  const since = shown.get(need.id);
  record("card", `card.${kind}.${outcome}`, top(), since === undefined ? 0 : Date.now() - since);
}

/**
 * The deepest scroll in 10% steps of anything scrolling inside `holder`, read once a gesture has stopped, for the long
 * view `name` says it shows: by default the screen under the sheets (a computer's chat pane is Chat beside any tab).
 * The nearest watched holder names it. One event per visit: sent when the screen under the sheets changes, or for a
 * sheet's own view when the sheet goes.
 */
export function watchDepth(holder: Element, name: () => string | null = () => (base ? (DEPTH_OF[base.id] ?? base.id) : null)): void {
  if (!on || watched.has(holder)) return;
  watched.add(holder);
  holder.addEventListener(
    "scrollend",
    (event) => {
      const scroller = event.target instanceof Element ? event.target : null;
      let near = scroller;
      while (near && !watched.has(near)) near = near.parentElement;
      if (!scroller || near !== holder) return;
      const room = scroller.scrollHeight - scroller.clientHeight;
      if (room <= 0) return;
      const id = name();
      if (!id || !idFits("scroll", id)) return;
      const step = Math.min(100, Math.floor((scroller.scrollTop / room) * 10) * 10);
      depth.set(id, Math.max(depth.get(id) ?? 0, step));
    },
    { passive: true, capture: true },
  );
}

/** The app went to the background: the screen on top is recorded and everything waiting is sent. */
export function usageHidden(): void {
  if (!on) return;
  if (hiddenAt === null) {
    const now = Date.now();
    pause(now);
    hiddenAt = now;
    // The page may not come back: every screen's time so far goes up now, top first as a closing sheet's do, so a screen
    // recorded right after another is the one under it (usage-report.ts reworkOf).
    for (const open of [...stack].reverse().concat(base ?? [])) {
      if (!open || open.acc <= 0) continue;
      record("screen", open.id, open.id, open.acc);
      open.acc = 0;
      open.told = true;
    }
    for (const [id, deepest] of depth) record("scroll", id, id, deepest);
    depth.clear();
  }
  void flushUsage(true);
}

/** Back from the background: the time away counts for no screen. */
export function usageShown(): void {
  if (hiddenAt === null) return;
  hiddenAt = null;
  resume(Date.now());
}

function device(): UsageDevice {
  return window.matchMedia?.("(pointer: coarse)").matches && !window.matchMedia(DESK_QUERY).matches ? "phone" : "desktop";
}

function readOutbox(): Stored[] {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? "[]");
    if (!Array.isArray(kept)) return [];
    return kept.filter((event): event is Stored => Array.isArray(event) && event.length === 5 && typeof event[0] === "number" && typeof event[4] === "number");
  } catch {
    return [];
  }
}

/** The outbox holds whatever the server has not taken, the batch in flight included, until it answers. */
function save(): void {
  if (held.length > OUTBOX_MAX) {
    const over = held.length - OUTBOX_MAX;
    held = held.slice(over);
    inFlight = Math.max(0, inFlight - over);
  }
  try {
    if (held.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(held));
    else localStorage.removeItem(OUTBOX_KEY);
  } catch {
    // A full or blocked store keeps them in memory only, as a closed page loses them.
  }
}

/**
 * Sends what waits, oldest first, one batch at a time, in batches the server takes. A batch stays in the outbox until
 * the server answers: taken, or a 400, which can never be stored, drops it; anything else keeps it for the next send.
 * `keepalive` (the app going to the background) lets a send outlive the page. A batch taken but never answered comes
 * again: `sentAt` dates each event by this clock, so the server stores it once.
 */
export function flushUsage(keepalive = false): Promise<void> {
  if (!on) return Promise.resolve();
  if (queue.length) {
    held.push(...queue);
    queue = [];
    save();
  }
  sending ??= send(keepalive).finally(() => {
    sending = null;
  });
  return sending;
}

async function send(keepalive: boolean): Promise<void> {
  const now = Date.now();
  held = held.filter(([at, kind, id, screen]) => now - at <= USAGE_KEEP_MS && idFits(kind, id) && screenId(screen) === screen);
  while (held.length) {
    const batch = held.slice(0, MAX_USAGE_EVENTS);
    inFlight = batch.length;
    const sentAt = Date.now();
    const body = { device: device(), sentAt, events: batch.map(([time, kind, id, screen, value]) => [Math.max(0, sentAt - time), kind, id, screen, value]) };
    try {
      await call<void>("POST", "/api/usage", body, keepalive);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 400)) {
        inFlight = 0;
        save();
        return;
      }
    }
    held = held.slice(inFlight);
    inFlight = 0;
    save();
  }
}
