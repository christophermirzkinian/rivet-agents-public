// Whether notifications reach any phone, and the banner Feed and Settings show when they reach none or this phone
// blocks them. Once Android blocked the notifications, the server dropped the phone's subscription when
// its push service answered 410, and nothing said so for two days (ask 98z7p).

import type { PushConfigResponse, PushRemoval } from "../../src/shared/board.js";
import { APP_NAME } from "../../src/shared/names.js";
import { clock, shortDate } from "../../src/shared/when.js";
import * as api from "./api.js";
import { button, describe, h, ICONS, svg } from "./dom.js";
import { enablePush, environment, needsInstall, type PushState } from "./push.js";
import { onSessionReset } from "./session.js";
import { changed } from "./state.js";
import { flash } from "./views/toast.js";

let health: PushConfigResponse | null = null;
let busy = false;
const listeners = new Set<() => void>();
onSessionReset(() => {
  health = null;
  busy = false;
});

export function pushHealth(): PushConfigResponse | null {
  return health;
}

/** Asks the server again; a failed check keeps what it last said. */
export async function loadPushHealth(): Promise<void> {
  let next: PushConfigResponse;
  try {
    next = await api.pushConfig();
  } catch {
    return;
  }
  // Polled with the board, so only a change redraws.
  if (JSON.stringify(next) === JSON.stringify(health)) return;
  health = next;
  changed();
}

/** Called whenever this phone's push may have changed (the banner's Turn on, a resync), so a view showing it reads it again. */
export function onPushChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tells every view that shows this phone's push to read it again, and asks the server for the phone count. */
export async function pushChanged(): Promise<void> {
  for (const listener of listeners) listener();
  await loadPushHealth();
}

/** blocked: this phone denies notifications, so only its system settings can undo it. none: no phone is reachable. */
export type PushAlarm = "blocked" | "none";

export function pushAlarm(config: PushConfigResponse | null, permission: NotificationPermission | null): PushAlarm | null {
  if (!config?.configured) return null;
  if (permission === "denied") return "blocked";
  return config.subscriptions === 0 ? "none" : null;
}

/** Why the last phone went, when the server knows. */
export function removalLine(removal: PushRemoval | null): string | null {
  if (!removal || removal.remaining > 0) return null;
  const at = `${shortDate(removal.at)} at ${clock(removal.at)}`;
  if (removal.reason === "gone") return `The last phone stopped taking them on ${at}. That happens when notifications are blocked for ${APP_NAME}.`;
  if (removal.reason === "turned-off") return `They were turned off in Settings on ${at}.`;
  return null;
}

/** How to unblock, for the phone in hand: the installed app's own settings, or the browser's site settings. */
export function unblockSteps(env: { isIos: boolean; isStandalone: boolean }): string[] {
  if (env.isIos)
    return [`Open the Settings app, then Notifications, then ${APP_NAME}.`, "Turn on Allow Notifications.", "Come back here and tap Turn on."];
  if (env.isStandalone)
    return [
      `Press and hold the ${APP_NAME} icon on your Home Screen, then tap App info.`,
      "Tap Notifications and turn on Allow notifications.",
      "Come back here and tap Turn on.",
    ];
  return [
    "In Chrome, tap ⋮, then Settings, Site settings, Notifications.",
    `Find ${APP_NAME} and set it to Allow.`,
    "Come back here and tap Turn on.",
  ];
}

async function turnOn(): Promise<void> {
  if (busy) return;
  busy = true;
  changed();
  let state: PushState | null = null;
  try {
    state = await enablePush();
  } catch (error) {
    flash(describe(error), "error");
  }
  busy = false;
  if (state === "on") flash("Notifications are on.", "ok");
  else if (state === "denied") flash(`Still blocked. Allow notifications for ${APP_NAME} in your phone's settings first.`, "warn");
  else if (state) flash("Notifications are still off.", "warn");
  await pushChanged();
  changed();
}

/** The banner, or null while notifications reach a phone (or the server has no push at all). */
export function pushBanner(): HTMLElement | null {
  const env = environment();
  const alarm = pushAlarm(health, env.canPush ? Notification.permission : null);
  if (!alarm) return null;
  const blocked = alarm === "blocked";
  const nowhere = health!.subscriptions === 0;
  const title = nowhere ? "Notifications are off on every phone" : "Notifications are blocked on this phone";
  const why = blocked
    ? `They're blocked for ${APP_NAME} on this phone, so it can't ping you here until they're allowed again.`
    : (removalLine(health?.lastRemoval ?? null) ?? `${APP_NAME} can't ping you anywhere.`);
  const install = needsInstall(env);
  const action = install
    ? h("p", { class: "push-off-note" }, `Add ${APP_NAME} to your Home Screen first: tap Share, then Add to Home Screen.`)
    : !env.canPush
      ? h("p", { class: "push-off-note" }, "This browser can't show notifications. Open it on your phone.")
      : button(busy ? "Turning on…" : "Turn on", () => void turnOn(), "primary big", busy, "cards.push-banner.on");
  return h(
    "section",
    { class: "push-off box", attrs: { role: "alert", "aria-label": title } },
    h("div", { class: "push-off-head" }, svg(ICONS.bell, "push-off-icon"), h("strong", {}, title)),
    h("p", { class: "push-off-why" }, why),
    blocked && !install ? h("ol", { class: "push-off-steps" }, ...unblockSteps(env).map((step) => h("li", {}, step))) : null,
    action,
  );
}
