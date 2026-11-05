/*
 * Rivet service worker: push and the share target.
 * It caches no app files and answers no fetch but a share's POST, so the app is
 * never pinned to an old bundle and an authed /api response is never served stale.
 */

importScripts("/sw-logic.js");

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Network only, but for the Share menu's POST: the listener also makes browsers count the app as installable.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "POST" || new URL(request.url).pathname !== self.rivetShare.SHARE_PATH) return;
  event.respondWith(self.rivetShare.receiveShare(request, self.caches, self.location.origin));
});

// What each window last said it shows, by client id. Lost when the worker stops, and then every push shows.
const viewing = new Map();
// Refreshes posted to a window and not yet acknowledged, by id.
const awaitingAck = new Map();
// A window lookup or focus that stalls gives way after this, so a push still shows and a tap still opens the app.
const CLIENT_WAIT_MS = 3000;
// A button's answer not taken by then opens the card instead.
const ANSWER_WAIT_MS = 10000;

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data && data.type === "refresh-ack" && typeof data.id === "string") {
    const ack = awaitingAck.get(data.id);
    if (ack) ack();
    return;
  }
  if (!data || data.type !== "viewing" || !event.source) return;
  viewing.set(event.source.id, {
    tab: typeof data.tab === "string" ? data.tab : null,
    card: typeof data.card === "string" ? data.card : null,
    chat: typeof data.chat === "string" ? data.chat : null,
    visible: data.visible === true,
  });
});

// A push shows a notification unless a focused window already shows its card or chat; that window refreshes instead.
// Safari and iOS still show one: a push without a notification gets the permission revoked there. It is silent once
// the window acknowledges the refresh, and rings otherwise, as a skipped push does.
// A held-back push still rings if no window acknowledges its refresh in time, say because it left the chat meanwhile
// or the reply landed below the view while he reads further up.
self.addEventListener("push", (event) => {
  const payload = readPayload(event);
  event.waitUntil(
    (async () => {
      const found = await within(self.clients.matchAll({ type: "window" }), CLIENT_WAIT_MS, null);
      const windows = found ?? [];
      // Only a lookup that answered says a window has gone; a stalled one keeps every view's report.
      if (found) for (const id of viewing.keys()) if (!windows.some((client) => client.id === id)) viewing.delete(id);
      const views = windows.map((client) => {
        const report = viewing.get(client.id);
        return report && { ...report, id: client.id, visible: report.visible && client.visibilityState === "visible", focused: client.focused };
      });
      const plan = self.rivetPush.shouldNotify(views, payload, self.navigator.userAgent);
      const id = plan.refresh.length ? self.rivetPush.refreshId(self.crypto) : null;
      const acked = id ? self.rivetPush.untilAck(awaitingAck, id, self.rivetPush.ACK_MS) : null;
      for (const client of windows) {
        if (plan.refresh.includes(client.id)) client.postMessage({ type: "refresh", id: id, card: payload.card, chat: typeof payload.conversation === "string" ? payload.conversation : payload.chat });
      }
      const redrawn = acked ? await acked : false;
      if (redrawn && plan.action === "skip") return;
      const maxActions = self.Notification && typeof self.Notification.maxActions === "number" ? self.Notification.maxActions : undefined;
      await self.registration.showNotification(payload.title || "Rivet Agents", self.rivetPush.notificationOptions(payload, redrawn, maxActions));
    })(),
  );
});

// Tapping opens the app on the card. A button answers it from the notification with the rev the push carried, so a
// tap after the card changed is refused and opens the card instead; Later only closes it.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const plan = self.rivetPush.clickPlan(data, event.action, `push-${self.rivetPush.refreshId(self.crypto)}`);
  if (plan.kind === "later") return;
  const path = safePath(data.path);
  event.waitUntil(
    (async () => {
      if (plan.kind === "answer") {
        const sent = self.rivetPush.sendAnswer((url, init) => self.fetch(url, init), self.location.origin, plan.body);
        if (await within(sent, ANSWER_WAIT_MS, false)) {
          const windows = await within(self.clients.matchAll({ type: "window" }), CLIENT_WAIT_MS, []);
          for (const client of windows) client.postMessage({ type: "refresh", card: plan.body.itemId });
          return;
        }
      }
      return openApp(path);
    })(),
  );
});

// An open window is told which card or tab to show, otherwise a new one opens at the path.
async function openApp(path) {
  const card = new URL(path, self.location.origin).searchParams.get("card");
  const conversation = new URL(path, self.location.origin).searchParams.get("conversation");
  const tab = conversation ? "chat" : new URL(path, self.location.origin).searchParams.get("tab");
  const windows = await within(self.clients.matchAll({ type: "window", includeUncontrolled: true }), CLIENT_WAIT_MS, []);
  for (const client of windows) {
    if ("focus" in client) {
      if (card) client.postMessage({ type: "open-card", id: card });
      else if (tab) client.postMessage(conversation ? { type: "open-tab", tab: tab, conversation: conversation } : { type: "open-tab", tab: tab });
      // A slow focus may still land, so a second window is never opened for it; waitUntil just stops waiting.
      return within(client.focus(), CLIENT_WAIT_MS, null);
    }
  }
  if (self.clients.openWindow) return self.clients.openWindow(path);
}

// Only a same-origin path ("/..." but not "//host") is ever opened.
function safePath(path) {
  if (typeof path !== "string" || path.charAt(0) !== "/" || path.charAt(1) === "/") return "/";
  try {
    const url = new URL(path, self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search : "/";
  } catch {
    return "/";
  }
}

// The promise's value, or `fallback` once `ms` pass without one.
function within(promise, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function readPayload(event) {
  if (!event.data) return {};
  try {
    return event.data.json() || {};
  } catch {
    return { body: event.data.text() };
  }
}
