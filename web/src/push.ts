// The client half of web push.
// Permission is only ever asked for from a tap on "Turn on".

import * as api from "./api.js";
import { FULL_SCREEN_EVENTS, fullScreenElement, modalOpen } from "./dom.js";
import { within } from "./within.js";

export interface Environment {
  isIos: boolean;
  isStandalone: boolean;
  canPush: boolean;
}

export function environment(): Environment {
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone =
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const canPush = window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  return { isIos, isStandalone, canPush };
}

/** iOS only delivers web push to an app added to the Home Screen. */
export function needsInstall(env = environment()): boolean {
  return env.isIos && !env.isStandalone;
}

export type PushState = "ios-install" | "unsupported" | "unconfigured" | "denied" | "off" | "on";

export async function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    return null;
  }
}

export async function pushState(): Promise<PushState> {
  const env = environment();
  if (needsInstall(env)) return "ios-install";
  if (!env.canPush) return "unsupported";
  const config = await api.pushConfig().catch(() => null);
  if (!config?.configured || !config.publicKey) return "unconfigured";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "off";
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ? "on" : "off";
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = `${base64url}${"=".repeat((4 - (base64url.length % 4)) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * The browser's own push steps (registering the worker, its ready, the push service's subscription) given up after this, so a stalled
 * one never leaves the Settings controls busy for good.
 */
export const PUSH_STEP_MS = 30_000;

const step = <T>(promise: Promise<T>): Promise<T> => within(promise, PUSH_STEP_MS, "Notifications took too long to set up. Try again.");

/**
 * Legacy opt-out, still read until the first stamped choice and mirrored for older tabs.
 * A phone with neither choice counts as on (ask 98z7p).
 */
const OFF_KEY = "rivet.push.off";
const OP_KEY = "rivet.push.operation";
const PUSH_LOCK = "rivet.push.subscription";
const SUPERSEDED = "Notifications changed in another tab. Check the current setting.";
let generation = 0;

function operationStamp(): string | null {
  try {
    return localStorage.getItem(OP_KEY);
  } catch {
    return null;
  }
}

/** Compare shared storage directly: storage events may arrive after a pending promise resumes. */
function snapshot(): () => boolean {
  const mine = generation;
  const stamp = operationStamp();
  return () => mine === generation && stamp === operationStamp();
}

function claim(off: boolean): () => boolean {
  const mine = ++generation;
  // Intent and revision share one atomic storage write. A stale legacy OFF write
  // must not change the choice made by a newer tab between synchronous steps.
  const stamp = `${off ? "off" : "on"}:${crypto.randomUUID()}`;
  try {
    localStorage.setItem(OP_KEY, stamp);
  } catch {
    throw new Error("Could not save the notification setting. Try again.");
  }
  return () => mine === generation && stamp === operationStamp();
}

function exclusive<T>(run: () => Promise<T>): Promise<T> {
  // Permission is requested before taking this lock, so a prompt cannot hold up Turn off.
  return navigator.locks
    ? navigator.locks.request(PUSH_LOCK, { signal: AbortSignal.timeout(PUSH_STEP_MS) }, run) as Promise<T>
    : run();
}

function requireCurrent(current: () => boolean): void {
  if (!current()) throw new Error(SUPERSEDED);
}

/** Without Web Locks, a subscribe POST may land after Turn off removed its server row. */
async function withdrawIfOff(subscription: PushSubscription): Promise<void> {
  const current = snapshot();
  if (!turnedOff() || !current()) return;
  await removeSubscription(subscription, current);
}

async function removeSubscription(subscription: PushSubscription, current: () => boolean): Promise<void> {
  await api.pushUnsubscribe(subscription.endpoint).catch(() => undefined);
  if (current() && turnedOff()) {
    // A browser operation cannot be aborted by our UI deadline. Keep the repair
    // attached to the real completion, even after step() has released the lock.
    let released = false;
    try {
      await step(subscription.unsubscribe().then(async () => {
        // While the lock is held, a newer enable is queued and will reconcile
        // when we release it; trying to take that lock here would deadlock.
        if ((!navigator.locks || released) && !current() && !turnedOff()) await resyncPush();
      }));
    } finally {
      released = true;
    }
    return;
  }
  // A removal already in flight cannot be cancelled by a newer stamp. Without
  // locks, repair that completed side effect from the latest browser state.
  if (!navigator.locks && !current() && !turnedOff()) await resyncPush();
}

function markOff(off: boolean): void {
  try {
    if (off) localStorage.setItem(OFF_KEY, "1");
    else localStorage.removeItem(OFF_KEY);
  } catch {
    // The stamped choice is authoritative; this legacy mirror is best effort.
  }
}

function turnedOff(): boolean {
  try {
    const operation = localStorage.getItem(OP_KEY);
    if (operation?.startsWith("off:")) return true;
    if (operation?.startsWith("on:")) return false;
    return localStorage.getItem(OFF_KEY) === "1";
  } catch {
    return true;
  }
}

export async function enablePush(): Promise<PushState> {
  // Publish this tap before asking permission, never reclaim it after an await.
  // Permission still gates resync, so an unanswered/denied prompt cannot subscribe.
  const current = claim(false);
  const permission = await Notification.requestPermission();
  requireCurrent(current);
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  return exclusive<PushState>(async () => {
    requireCurrent(current);
    // Asked for on, so a step that fails below leaves resync free to finish the job.
    markOff(false);
    const registration = await step(registerWorker());
    requireCurrent(current);
    const config = await api.pushConfig();
    requireCurrent(current);
    if (!registration || !config.configured || !config.publicKey) return "unconfigured";
    await step(navigator.serviceWorker.ready);
    requireCurrent(current);
    const existing = await step(registration.pushManager.getSubscription());
    requireCurrent(current);
    const subscription = existing ?? await step(registration.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: keyBytes(config.publicKey),
    }));
    if (!current()) {
      await withdrawIfOff(subscription);
      throw new Error(SUPERSEDED);
    }
    await api.pushSubscribe(subscription.toJSON());
    if (!current()) {
      await withdrawIfOff(subscription);
      throw new Error(SUPERSEDED);
    }
    return "on";
  });
}

export async function disablePush(): Promise<PushState> {
  // Before any wait, including the lock, so every older enable/resync stands down.
  const current = claim(true);
  markOff(true);
  return exclusive<PushState>(async () => {
    requireCurrent(current);
    // Keep the legacy marker consistent after any older lock holder's writes.
    markOff(true);
    const registration = await step(navigator.serviceWorker.getRegistration("/"));
    requireCurrent(current);
    const subscription = await step(registration?.pushManager.getSubscription() ?? Promise.resolve(null));
    requireCurrent(current);
    if (subscription) {
      await removeSubscription(subscription, current);
      requireCurrent(current);
    }
    return "off";
  });
}

export interface Viewing {
  tab: string;
  card: string | null;
  chat: string | null;
}

let lastViewing: { worker: ServiceWorker; key: string } | null = null;

/** Tells the service worker what is on screen, so a push for that card or chat refreshes it instead of ringing. */
function reportViewing(view: Viewing): void {
  const worker = navigator.serviceWorker?.controller;
  if (!worker) return;
  const message = { type: "viewing", tab: view.tab, card: view.card ?? undefined, chat: view.chat ?? undefined, visible: document.visibilityState === "visible" };
  const key = JSON.stringify(message);
  if (lastViewing?.worker === worker && lastViewing.key === key) return;
  lastViewing = { worker, key };
  worker.postMessage(message);
}

/** A dialog, a full-screen clip, or a sheet over its backdrop (the feed's comment sheet is not aria-modal). */
export function covered(): boolean {
  return modalOpen() || document.querySelector(".sheet-backdrop:not(.is-leaving)") !== null;
}

/**
 * Whether an overlay stands over `el`: one is open and the top one does not hold it, as Rivet's sheet holds his chat. A
 * clip in full screen covers everything, the sheet holding `el` too, as onTop counts it.
 */
export function coveredOver(el: Element): boolean {
  return fullScreenElement() !== null || (covered() && !topOverlay()?.contains(el));
}

const topOverlay = () => [...document.querySelectorAll('[aria-modal="true"], .sheet-backdrop:not(.is-leaving)')].at(-1);

/**
 * What the top overlay shows of `view`: its card when the Decide sheet over the map marks it so, its chat when that is
 * Rivet's sheet (home.ts), else nothing.
 */
function onTop(view: Viewing): Viewing {
  // A clip in full screen hides what the overlay shows, whatever is under the clip.
  if (fullScreenElement()) return { tab: view.tab, card: null, chat: null };
  const top = topOverlay();
  const card = typeof view.card === "string" && top?.closest("[data-shows-card]")?.getAttribute("data-shows-card") === view.card ? view.card : null;
  const chat = top?.closest("[data-shows-chat]") ? view.chat : null;
  return card || chat ? { tab: view.tab, card, chat } : { tab: view.tab, card: null, chat: null };
}

/** Whether the top overlay shows the card or chat a held push was for. */
function onTopShows(data: { card?: unknown; chat?: unknown }): boolean {
  const shown = onTop({ tab: "", card: typeof data.card === "string" ? data.card : null, chat: typeof data.chat === "string" ? data.chat : null });
  return shown.card !== null || shown.chat !== null;
}

/**
 * Reports what `read` says is on screen after every DOM, full-screen or visibility change; null means signed out.
 * While a sheet, dialog or full-screen clip covers the view, no card or chat counts as shown.
 */
export function watchViewing(read: () => Viewing | null): () => void {
  const report = () => {
    const view = read();
    reportViewing(!view ? { tab: "signed-out", card: null, chat: null } : covered() ? onTop(view) : view);
  };
  let queued = false;
  const soon = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      report();
    });
  };
  const observer = new MutationObserver(soon);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-modal", "data-viewing", "data-shows-card", "data-shows-chat"] });
  document.addEventListener("visibilitychange", report);
  // iPhone's native player fires webkit*fullscreen on the video only, so listen in the capture phase.
  for (const type of FULL_SCREEN_EVENTS) document.addEventListener(type, soon, true);
  navigator.serviceWorker?.addEventListener("controllerchange", report);
  report();
  return () => {
    observer.disconnect();
    document.removeEventListener("visibilitychange", report);
    for (const type of FULL_SCREEN_EVENTS) document.removeEventListener(type, soon, true);
    navigator.serviceWorker?.removeEventListener("controllerchange", report);
  };
}

/**
 * The service worker held back a push for what is on screen: a chat push reloads the thread, a card push the board.
 * Each resolves true once it has redrawn with the news, and only then, with nothing covering it, is the worker told;
 * otherwise it shows the notification after all.
 */
export async function workerRefresh(
  data: { id?: unknown; chat?: unknown; card?: unknown },
  refreshChat: () => Promise<boolean>,
  refreshBoard: () => Promise<boolean>,
  openChat: () => string | null,
): Promise<void> {
  // A chat push is shown only when its own conversation is still open once the redraw is done: left for the list or
  // another conversation meanwhile, the notification stands.
  const shown =
    typeof data.chat === "string" ? (await refreshChat()) && openChat() === data.chat : await refreshBoard();
  if (!shown || typeof data.id !== "string" || document.visibilityState !== "visible" || (covered() && !onTopShows(data))) return;
  navigator.serviceWorker?.controller?.postMessage({ type: "refresh-ack", id: data.id });
}

/**
 * On boot and on coming back to the app: re-sends this phone's subscription, so the server holds it even after it
 * dropped it, and with notifications allowed but no subscription (the push service dropped it while they were blocked)
 * subscribes again, unless Settings turned it off. Never prompts.
 */
export async function resyncPush(): Promise<void> {
  const env = environment();
  if (!env.canPush || needsInstall(env) || Notification.permission !== "granted") return;
  const started = snapshot();
  const current = () => started() && !turnedOff() && Notification.permission === "granted";
  if (!current()) return;
  await exclusive(async () => {
    if (!current()) return;
    const registration = await step(navigator.serviceWorker.getRegistration("/"));
    if (!registration || !current()) return;
    let subscription = await step(registration.pushManager.getSubscription());
    if (!current()) return;
    if (!subscription) {
      const config = await api.pushConfig().catch(() => null);
      if (!config?.configured || !config.publicKey || !current()) return;
      subscription = await step(registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.publicKey) }));
      if (!current()) {
        await withdrawIfOff(subscription);
        return;
      }
    }
    await api.pushSubscribe(subscription.toJSON());
    if (!current()) await withdrawIfOff(subscription);
  });
}

/**
 * Closes the notification of every card no longer waiting on the owner, answered here or on another device. A
 * notification with no card (the cap, a test, a chat message) is never closed. No push does this: a silent one would
 * spend Chrome's userVisibleOnly allowance and show "updated in the background".
 */
export async function closeAnswered(
  waiting: ReadonlySet<string>,
  registration?: Pick<ServiceWorkerRegistration, "getNotifications"> | null,
): Promise<void> {
  try {
    const found = registration === undefined ? await navigator.serviceWorker?.getRegistration("/") : registration;
    if (!found) return;
    for (const notification of await found.getNotifications()) {
      const card = (notification.data as { card?: unknown } | null)?.card;
      if (typeof card === "string" && !waiting.has(card)) notification.close();
    }
  } catch {
    // No service worker or no notifications here: nothing is showing to close.
  }
}
