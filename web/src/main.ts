import { appName } from "../../src/shared/names.js";
import "./styles.css";

import * as api from "./api.js";
import { dismissBoot } from "./boot.js";
import { hostedPage, leaveCloud, ownMachineAfterEnrol, readCloud, readServedApp } from "./cloud-agent.js";
import { DESK_QUERY, isDesk } from "./desk.js";
import { button, describe, h } from "./dom.js";
import { watchNewBuild } from "./new-build.js";
import { loadPushHealth, pushChanged } from "./push-health.js";
import { registerWorker, resyncPush, watchViewing, workerRefresh } from "./push.js";
import { watchInput } from "./rivet-sleep.js";
import { showRivetWords } from "./rivet-words.js";
import { endSession, setSignedInByCode } from "./session.js";
import { takeShare } from "./share-target.js";
import { openedVia, startUsage, usageHidden, usageShown } from "./usage.js";
import { app, changed, go, navStamp, networkChanged, refresh, resetSession, settleOpening, whenSignedOut } from "./state.js";
import { openConversation, receiveShare, refresh as refreshChat, showLine } from "./views/chat.js";
import { dropLeave, leaveOverlays } from "./views/navigation.js";
import { decideShown, showPushed } from "./views/decide-sheet.js";
import { closeSheet, closeTallSheet } from "./views/sheet.js";
import { cardsSegment, flushHeld, recoverOutbox, resetFeed } from "./views/feed.js";
import { mountShell } from "./views/shell.js";
import { catchStrayDrops } from "./views/attach.js";
import { applyChatTextSize } from "./views/chat-text-size.js";
import { loadChatPrefs } from "./views/chat-prefs.js";

// The saved Text size on <html> before anything mounts, so every screen opens at it with no flash of Medium.
applyChatTextSize();
watchInput();
readServedApp();

const POLL_MS = 15_000;
const root = document.getElementById("app")!;
let polling: number | null = null;
let signedIn = false;
let unmountShell: (() => void) | null = null;
/** The tab a link asked for, an old tab id included (state.ts landing). */
let startTab: string | null = null;
/** The conversation a link or a notification opens Chat on, and the line in it a notification is about. */
let startConversation: string | null = null;
let startMessage: string | null = null;
/** The card a `?card=` link asked for: opened on purpose, so on a phone a minimised one opens in full. */
let startCard: string | null = null;

showRivetWords();

interface GateStep {
  title: string;
  sub: string;
  done?: boolean;
}

/** The sign-in steps as ticked tiles: the ones done carry a tick, the one to do now its number. */
function gateSteps(...steps: GateStep[]): HTMLElement {
  return h(
    "ol",
    { class: "gate-steps" },
    ...steps.map((step, i) =>
      h(
        "li",
        { class: `gate-step${step.done ? " is-done" : " is-now"}` },
        h("span", { class: "gate-step-n", attrs: { "aria-hidden": "true" } }, step.done ? "✓" : String(i + 1)),
        h("span", { class: "gate-step-words" }, h("b", { class: "gate-step-title" }, step.title), h("span", { class: "gate-step-sub" }, step.sub)),
      ),
    ),
  );
}

function gate(lede: string, ...children: (Node | null)[]): void {
  signedIn = false;
  endSession();
  unmountShell?.();
  unmountShell = null;
  // The sheets hang off the page, not the shell: they go too, so no card stays over sign-in, and nothing still waiting
  // on an overlay's Back (a push's card) opens after it.
  dropLeave();
  closeTallSheet();
  closeSheet();
  leaveCloud();
  resetFeed();
  root.classList.remove("signed-in");
  root.replaceChildren(
    h(
      "section",
      { class: "gate" },
      h("img", { class: "gate-icon", attrs: { src: "/icon.svg", alt: "" } }),
      h("h1", { class: "gate-name" }, appName()),
      h("p", { class: "gate-lede" }, lede),
      ...children,
    ),
  );
}

/** Sign-in by a device code alone: the server offers it (api.me) and this window cannot make a passkey of its own. */
let codeSignIn = false;

/** The session about to start was made by a device code alone: startApp hands it to the session (signedInByCode). */
let codeMade = false;

/** How long the window's answer about its passkey maker is waited for before the passkey screen shows anyway. */
const PASSKEY_CHECK_MS = 1500;

/** False where the window has no passkey maker of its own, as the desktop app's has none. */
async function passkeysWork(): Promise<boolean> {
  if (typeof PublicKeyCredential === "undefined") return false;
  return Promise.race([
    PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => true),
    new Promise<boolean>((resolve) => window.setTimeout(() => resolve(true), PASSKEY_CHECK_MS)),
  ]);
}

const DEVICE_CODE = /^[A-Za-z0-9]{8}$/;

const gateLede = (): string => (hostedPage() ? "Your agent's command centre." : "Your coding agents, on your phone.");

/** `passkey` asks for the passkey screen where the code one would open first. */
function renderSignIn(message: string | null = null, passkey = false): void {
  if (codeSignIn && !passkey) return renderCodeSignIn(message);
  stopPolling();
  const status = h("p", { class: "gate-status", attrs: { role: "status" } }, message ?? "");
  gate(
    gateLede(),
    gateSteps({ title: "Use your passkey", sub: "No password to remember." }),
    button(
      "Sign in with passkey",
      () => {
        status.textContent = "Waiting for your passkey…";
        api.signIn().then(startApp, (error: unknown) => (status.textContent = describe(error)));
      },
      "primary big",
      false,
      "gate.signin",
    ),
    status,
    codeSignIn ? button("Use a code instead", () => renderSignIn(), "ghost big", false, "gate.signin-code") : null,
  );
}

/** `linked` is the code a set-up link brought: it waits in the field for one tap, and the link's passkey set-up stays a tap away. */
function renderCodeSignIn(message: string | null, linked: string | null = null): void {
  stopPolling();
  const status = h("p", { class: "gate-status", attrs: { role: "status" } }, message ?? "");
  let sending = false;
  const send = (): void => {
    const code = field.value.trim();
    if (sending || !code) return;
    sending = true;
    status.textContent = "Checking the code…";
    api.deviceSession(code).then(startAppByCode, (error: unknown) => {
      sending = false;
      status.textContent =
        error instanceof api.ApiError && error.status === 403 ? "That code is not valid or has expired. Get a new one and try again." : describe(error);
    });
  };
  const field = h("input", {
    class: "gate-code",
    attrs: {
      type: "text",
      autocomplete: "off",
      autocapitalize: "characters",
      spellcheck: "false",
      maxlength: "8",
      enterkeyhint: "go",
      placeholder: "8-character code",
      "aria-label": "Code from a signed-in device",
    },
    on: {
      keydown: (event) => {
        if ((event as KeyboardEvent).key === "Enter") send();
      },
    },
  });
  if (linked) field.value = linked.toUpperCase();
  gate(
    gateLede(),
    linked
      ? gateSteps({ title: "Set-up link opened", sub: "Its code came with it.", done: true }, { title: "Sign in with the code", sub: "It works once." })
      : gateSteps({ title: "Use a code from a signed-in device", sub: `On a phone signed in to ${appName()}, open Settings › Add a device.` }),
    field,
    button("Sign in with code", send, "primary big", false, "gate.code"),
    status,
    linked
      ? button("Create a passkey instead", () => renderEnrol(linked), "ghost big", false, "gate.code-enrol")
      : button("Use a passkey instead", () => renderSignIn(null, true), "ghost big", false, "gate.code-passkey"),
  );
}

function renderEnrol(code: string): void {
  const status = h("p", { class: "gate-status", attrs: { role: "status" } });
  gate(
    "Set up a passkey on this device.",
    gateSteps({ title: "Set-up link opened", sub: "Its set-up code came with it.", done: true }, { title: "Create a passkey", sub: "No password to remember." }),
    button(
      "Create passkey",
      () => {
        status.textContent = "Waiting for your passkey…";
        api.enrol(code).then(
          () => {
            status.textContent = "Passkey made. Finishing setup…";
            return ownMachineAfterEnrol().then((own) => (own ? startApp() : location.replace("/")));
          },
          (error: unknown) => (status.textContent = describe(error)),
        );
      },
      "primary big",
      false,
      "gate.enrol",
    ),
    status,
    button("I already have one: sign in", () => renderSignIn(), "ghost big", false, "gate.signin-existing"),
  );
}

function stopPolling(): void {
  if (polling !== null) window.clearInterval(polling);
  polling = null;
}

async function startApp(): Promise<void> {
  signedIn = true;
  unmountShell?.();
  resetFeed();
  const front = app.front;
  resetSession();
  setSignedInByCode(codeMade);
  codeMade = false;
  app.front = front;
  void loadChatPrefs();
  startUsage(() => ({ tab: app.tab, desk: window.matchMedia?.(DESK_QUERY).matches ?? false, morePage: app.morePage, cards: cardsSegment() }));
  const link = startTab;
  startTab = null;
  if (link) openedVia("tab.via-link");
  if (startCard) openedVia("decide.via-link");
  if (link) go(link);
  // A card's link on a phone opens its Decide sheet over the home screen; on a wide window Decide opens where it was.
  else if (front) app.tab = window.matchMedia?.(DESK_QUERY).matches ? "cards" : "progress";
  const asked = link || front ? app.tab : null;
  if (startConversation) showLine(startConversation, startMessage);
  startConversation = null;
  startMessage = null;
  unmountShell = mountShell(root);
  void readCloud(changed);
  // What the Share menu sent waits through a signed-out start, and lands in the chat on the first one signed in.
  void takeShare().then((share) => {
    if (!share) return;
    receiveShare(share);
    if (signedIn && app.tab !== "chat") {
      app.tab = "chat";
      changed();
    }
  });
  const stamp = navStamp();
  const loaded = await refresh();
  if (!signedIn) return;
  // A linked card opens as a tap would, including an answered question or a seen update. On a phone one not on the
  // board yet (or a first read that failed) goes to showPushed too, which reads the board again for it.
  const desk = window.matchMedia?.(DESK_QUERY).matches;
  const linked = front !== null && front === startCard;
  startCard = null;
  if (front && navStamp() === stamp && (!desk || app.board?.board?.needs.some((need) => need.id === front))) showPushed(front, linked);
  // Phone and wide window open on the home screen, whose Decide N says how many decisions wait; only a link or a notification
  // opens Decide.
  settleOpening(asked ?? "progress", stamp);
  if (loaded) recoverOutbox();
  stopPolling();
  polling = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      void refresh().then((ok) => ok && recoverOutbox());
      // A phone dropped while the app stays open shows its banner on the next poll.
      void loadPushHealth();
    }
  }, POLL_MS);
  void registerWorker()
    .then(() => resyncPush())
    .catch(() => undefined)
    .finally(() => void pushChanged());
}

whenSignedOut((message) => renderSignIn(message));

// The Decide sheet's card is on screen while it is open, over whatever the tab shows, so a push for it refreshes it
// instead of ringing. Chat has no conversation of its own on screen now the topic page is gone, so
// `openConversation()` is null and a chat push rings, as it already did over the main Chat.
watchViewing(() => (signedIn ? { tab: app.tab, card: decideShown(), chat: decideShown() && !isDesk() ? null : openConversation() } : null));

document.addEventListener("visibilitychange", () => {
  if (!signedIn) return;
  // An answer waiting out its undo window is sent rather than lost with the page.
  if (document.visibilityState === "hidden") {
    flushHeld();
    usageHidden();
  } else {
    usageShown();
    void refresh().then((ok) => ok && recoverOutbox());
    void readCloud(changed);
    // Back from the phone's settings, say: allowed again re-subscribes, and the banner reads the server again.
    void resyncPush()
      .catch(() => undefined)
      .finally(() => void pushChanged());
  }
});
watchNewBuild();
// A photo dragged in from the desktop and dropped beside the chat never opens in place of the app.
catchStrayDrops();
window.addEventListener("offline", networkChanged);
window.addEventListener("online", () => {
  networkChanged();
  if (signedIn) void refresh().then((ok) => ok && recoverOutbox());
});
window.addEventListener("pagehide", () => {
  if (!signedIn) return;
  flushHeld();
  usageHidden();
});

navigator.serviceWorker?.addEventListener("message", (event: MessageEvent<{ type?: string; id?: unknown; tab?: unknown; card?: unknown; chat?: unknown; conversation?: unknown; message?: unknown }>) => {
  if (event.data?.type === "refresh" && signedIn) {
    const card = event.data.card;
    return void workerRefresh(event.data, refreshChat, async () => {
      const ok = await refresh();
      if (ok) recoverOutbox();
      return ok && typeof card === "string" && decideShown() === card;
    }, openConversation);
  }
  // Dismiss overlays before navigating, including their history entries, so Back cannot undo the destination.
  if (event.data?.type === "open-tab" && typeof event.data.tab === "string" && signedIn) {
    const { conversation, message, tab } = event.data;
    return leaveOverlays(() => {
      // A notification's tap opens Chat on its line, never a page of its own.
      if (typeof conversation === "string") showLine(conversation, typeof message === "string" ? message : null);
      go(typeof conversation === "string" ? "chat" : tab);
      changed();
    });
  }
  if (event.data?.type !== "open-card" || typeof event.data.id !== "string" || !signedIn) return;
  const card = event.data.id;
  openedVia("decide.via-push");
  leaveOverlays(() => {
    showPushed(card);
    void refresh();
  });
});

function takeParams(): { code: string | null; card: string | null } {
  const hash = location.hash.replace(/^#/, "");
  const card = new URLSearchParams(location.search).get("card");
  const tab = new URLSearchParams(location.search).get("tab");
  // A conversation by its id, or by any message of it: an old Threads link's `thread` too.
  const conversation = new URLSearchParams(location.search).get("conversation") ?? new URLSearchParams(location.search).get("thread");
  if (conversation) startTab = "chat";
  else if (tab) startTab = tab;
  if (conversation) startConversation = conversation;
  if (conversation) startMessage = new URLSearchParams(location.search).get("message");
  if (hash || card || tab || conversation) history.replaceState(null, "", location.pathname);
  const code = hash ? (new URLSearchParams(hash).get("code") ?? (hash.includes("=") ? null : hash)) : null;
  return { code: code ? decodeURIComponent(code) : null, card };
}

function startAppByCode(): Promise<void> {
  codeMade = true;
  return startApp();
}

async function start(): Promise<void> {
  // The worker is there before sign-in too, so a share made from a signed-out install is kept for it.
  void registerWorker();
  const { code, card } = takeParams();
  if (code) {
    // A link's code is only put in the field: opening the link, by a slip or a preloader, spends nothing.
    const linked = DEVICE_CODE.test(code.trim()) ? code.trim() : null;
    // The server is asked only where the window cannot make a passkey: one that can sets up at once, as it always did.
    if (linked && !(await passkeysWork())) codeSignIn = await api.me().then((me) => me.deviceSession === true, () => false);
    return linked && codeSignIn ? renderCodeSignIn(null, linked) : renderEnrol(code);
  }
  if (card) app.front = startCard = card;
  try {
    const { signedIn: yes, deviceSession, via } = await api.me();
    if (yes) {
      codeMade = via === "device-code";
      // Only the signed-out gate needs the answer, so the app never waits on it; a later sign-out finds it there.
      if (deviceSession === true) void passkeysWork().then((works) => (codeSignIn = !works));
      return void (await startApp());
    }
    codeSignIn = deviceSession === true && !(await passkeysWork());
    renderSignIn();
  } catch (error) {
    renderSignIn(describe(error));
  }
}

void start().finally(dismissBoot);
