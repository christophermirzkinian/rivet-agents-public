import { APP_NAME } from "../../src/shared/names.js";
import "./styles.css";

import * as api from "./api.js";
import { dismissBoot } from "./boot.js";
import { DESK_QUERY, isDesk } from "./desk.js";
import { button, describe, h } from "./dom.js";
import { loadPushHealth, pushChanged } from "./push-health.js";
import { registerWorker, resyncPush, watchViewing, workerRefresh } from "./push.js";
import { showRivetWords } from "./rivet-words.js";
import { endSession } from "./session.js";
import { takeShare } from "./share-target.js";
import { openedVia, startUsage, usageHidden, usageShown } from "./usage.js";
import { app, changed, go, navStamp, networkChanged, refresh, resetSession, settleOpening, whenSignedOut } from "./state.js";
import { openConversation, receiveShare, refresh as refreshChat, showConversation } from "./views/chat.js";
import { dropLeave, leaveOverlays } from "./views/navigation.js";
import { decideShown, showPushed } from "./views/decide-sheet.js";
import { closeSheet, closeTallSheet } from "./views/sheet.js";
import { cardsSegment, flushHeld, recoverOutbox, resetFeed } from "./views/feed.js";
import { mountShell } from "./views/shell.js";

const POLL_MS = 15_000;
const root = document.getElementById("app")!;
let polling: number | null = null;
let signedIn = false;
let unmountShell: (() => void) | null = null;
/** The tab a link asked for, an old tab id included (state.ts landing). */
let startTab: string | null = null;
/** The conversation a link or a notification opens on. */
let startConversation: string | null = null;
/** The card a `?card=` link asked for: opened on purpose, so on a phone a minimised one opens in full. */
let startCard: string | null = null;

showRivetWords();

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
  resetFeed();
  root.classList.remove("signed-in");
  root.replaceChildren(
    h(
      "section",
      { class: "gate" },
      h("img", { class: "gate-icon", attrs: { src: "/icon.svg", alt: "" } }),
      h("h1", { class: "gate-name" }, APP_NAME),
      h("p", { class: "gate-lede" }, lede),
      ...children,
    ),
  );
}

function renderSignIn(message: string | null = null): void {
  stopPolling();
  const status = h("p", { class: "gate-status", attrs: { role: "status" } }, message ?? "");
  gate(
    "Your coding agents, on your phone.",
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
  );
}

function renderEnrol(code: string): void {
  const status = h("p", { class: "gate-status", attrs: { role: "status" } });
  gate(
    "Set up a passkey on this device.",
    button(
      "Create passkey",
      () => {
        status.textContent = "Waiting for your passkey…";
        api.enrol(code).then(startApp, (error: unknown) => (status.textContent = describe(error)));
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
  app.front = front;
  startUsage(() => ({ tab: app.tab, desk: window.matchMedia?.(DESK_QUERY).matches ?? false, morePage: app.morePage, cards: cardsSegment() }));
  const link = startTab;
  startTab = null;
  if (link) openedVia("tab.via-link");
  if (startCard) openedVia("decide.via-link");
  if (link) go(link);
  // A card's link on a phone opens its Decide sheet over the home screen; on a wide window Decide opens where it was.
  else if (front) app.tab = window.matchMedia?.(DESK_QUERY).matches ? "cards" : "progress";
  const asked = link || front ? app.tab : null;
  if (startConversation) showConversation(startConversation);
  startConversation = null;
  unmountShell = mountShell(root);
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

// The open conversation, so a push for it refreshes it instead of ringing; one for any other conversation rings.
// The Decide sheet's card is on screen while it is open, over whatever the tab shows; on a phone the open conversation
// is Rivet's sheet's (push.ts), under the sheet, and a wide window's is in the chat beside the pane.
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
    // Back from the phone's settings, say: allowed again re-subscribes, and the banner reads the server again.
    void resyncPush()
      .catch(() => undefined)
      .finally(() => void pushChanged());
  }
});
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

navigator.serviceWorker?.addEventListener("message", (event: MessageEvent<{ type?: string; id?: unknown; tab?: unknown; card?: unknown; chat?: unknown; conversation?: unknown }>) => {
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
    const { conversation, tab } = event.data;
    return leaveOverlays(() => {
      if (typeof conversation === "string") showConversation(conversation);
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
  if (hash || card || tab || conversation) history.replaceState(null, "", location.pathname);
  const code = hash ? (new URLSearchParams(hash).get("code") ?? (hash.includes("=") ? null : hash)) : null;
  return { code: code ? decodeURIComponent(code) : null, card };
}

async function start(): Promise<void> {
  // The worker is there before sign-in too, so a share made from a signed-out install is kept for it.
  void registerWorker();
  const { code, card } = takeParams();
  if (code) return renderEnrol(code);
  if (card) app.front = startCard = card;
  try {
    const { signedIn: yes } = await api.me();
    if (yes) return void (await startApp());
    renderSignIn();
  } catch (error) {
    renderSignIn(describe(error));
  }
}

void start().finally(dismissBoot);
