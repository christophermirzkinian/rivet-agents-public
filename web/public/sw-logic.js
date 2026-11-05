/*
 * The service worker's push decisions and its share target, kept pure so test/sw-logic.test.ts runs them. sw.js loads this with
 * importScripts, so it is a classic script that hangs its functions on the global object.
 */

/** Where silent pushes are not reliably allowed: Safari and every iOS browser (all WebKit). */
function webkitOnly(ua) {
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Android|Edg\//.test(ua);
}

/**
 * What to do with a push given the last report from each window: "show" it, show it "silent", or "skip" it. `viewing`
 * holds `{ id, tab, card, chat, visible, focused }` per window; `refresh` lists the windows already showing it.
 * A window with no report (the worker restarted) never counts, and neither does one that is hidden or unfocused.
 */
function shouldNotify(viewing, payload, ua) {
  const refresh = [];
  for (const view of viewing) {
    if (!view || !view.visible || !view.focused) continue;
    const onCard = typeof payload.card === "string" && view.card === payload.card;
    // A push from before conversations says chat "rivet" beside its conversation: the window names the conversation.
    const onChat =
      (typeof payload.chat === "string" && view.chat === payload.chat) || (typeof payload.conversation === "string" && view.chat === payload.conversation);
    if (onCard || onChat) refresh.push(view.id);
  }
  if (refresh.length === 0) return { action: "show", refresh };
  return { action: webkitOnly(ua || "") ? "silent" : "skip", refresh };
}

/**
 * The showNotification options: an FYI is silent with no vibration under its own tag, so it never replaces a needs-you ping.
 * A card's buttons go as far as `maxActions` (Notification.maxActions; Android Chrome shows two), and its data keeps
 * the card, its rev and what each button answers, for the tap.
 */
function notificationOptions(payload, silent, maxActions) {
  const fyi = payload.level === "fyi";
  const tag = payload.tag ? (fyi ? `fyi-${payload.tag}` : payload.tag) : undefined;
  const actions = Array.isArray(payload.actions) ? payload.actions.slice(0, maxActions === undefined ? payload.actions.length : maxActions) : [];
  const options = {
    body: payload.body || "",
    tag: tag,
    icon: "/icon-192.png",
    badge: "/badge-96.png",
    silent: fyi || Boolean(silent),
    data: { path: payload.path || "/" },
  };
  // The app closes a card's notification once the card is answered, on any device (web/src/push.ts closeAnswered).
  if (typeof payload.card === "string") options.data.card = payload.card;
  if (typeof payload.rev === "string") options.data.rev = payload.rev;
  if (actions.length) {
    options.actions = actions;
    options.data = { path: options.data.path, card: payload.card, rev: payload.rev, answers: payload.answers };
  }
  return options;
}

/**
 * What a tap on a notification does. "later" closes it and nothing else; "answer" posts `body` to /api/replies as the
 * app does; "open" opens the app on the card, as a tap on the notification itself does.
 */
function clickPlan(data, action, clientId) {
  if (action === "later") return { kind: "later" };
  const answer = action && data && data.answers ? data.answers[action] : null;
  // A reject always asks why in the app, so a notification made before that opens the card instead.
  if (!answer || answer.decision === "reject" || typeof answer.decision !== "string" || typeof data.card !== "string" || typeof data.rev !== "string") return { kind: "open" };
  const body = { clientId: clientId, itemId: data.card, decision: answer.decision, rev: data.rev };
  if (typeof answer.choice === "string") body.choice = answer.choice;
  return { kind: "answer", body: body };
}

/**
 * Sends a button's answer with the owner's session cookie and the app's CSRF header; true once the server took it. A card
 * that changed since the push answers 409, and that, any other refusal or no network is false: the card opens instead.
 */
async function sendAnswer(fetch, origin, body) {
  try {
    const response = await fetch(new URL("/api/replies", origin).href, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "x-rivet": "1" },
      body: JSON.stringify(body),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** How long a window gets to redraw a held-back push before the notification shows after all. */
const ACK_MS = 2000;

/**
 * Resolves true when the refresh with `id` is acknowledged within `ms`, false once the time runs out. `waiting` maps
 * each outstanding id to the function an incoming ack calls.
 */
function untilAck(waiting, id, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve(false);
    }, ms);
    waiting.set(id, () => {
      clearTimeout(timer);
      waiting.delete(id);
      resolve(true);
    });
  });
}

/** A refresh's id: random, so an ack meant for an earlier worker never matches. Older browsers lack randomUUID. */
function refreshId(crypto) {
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

globalThis.rivetPush = {
  shouldNotify: shouldNotify,
  notificationOptions: notificationOptions,
  clickPlan: clickPlan,
  sendAnswer: sendAnswer,
  webkitOnly: webkitOnly,
  untilAck: untilAck,
  refreshId: refreshId,
  ACK_MS: ACK_MS,
};

/*
 * The share target (manifest.webmanifest's share_target): Android's Share menu posts the text and files here, and
 * they wait in the Cache API for the app to put them in the Chat composer (web/src/share-target.ts reads them).
 */
const SHARE_PATH = "/share-target";
const SHARE_CACHE = "rivet-share";
const SHARE_META = "/share-target/meta";
/** The id of the share the app last took: a meta naming it has landed already. */
const SHARE_TAKEN = "/share-target/taken";
/**
 * Each share's files sit under its own id, and nothing here deletes another share's: a page still reading an older
 * share, or a share still being stored, keeps its files. The app deletes a share's files once it takes them, and old
 * ones a newer share left behind.
 */
const shareFileKey = (id, index) => `/share-target/${id}/file/${index}`;
/** A share's id starts with when it came, so the app can tell a forgotten one from one still being stored. */
const shareId = (crypto) => `${Date.now()}-${refreshId(crypto)}`;

/**
 * Keeps one share: each file, then the meta naming them, which makes it the newest. A file the storage refuses (too
 * big for the quota, say) is listed as lost, so the app can say so rather than drop it unseen; a meta the storage
 * refuses gives this share's files back and lists them all as lost, so the app still hears of it.
 */
async function stashShare(form, cache, id) {
  const field = (name) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const files = [];
  for (const file of form.getAll("files")) {
    if (typeof file === "string") continue;
    const entry = { name: file.name || "", type: file.type || "" };
    try {
      await cache.put(shareFileKey(id, files.length), new Response(file, { headers: { "content-type": file.type || "application/octet-stream" } }));
    } catch {
      entry.lost = true;
    }
    files.push(entry);
  }
  const meta = (list) => new Response(JSON.stringify({ id: id, title: field("title"), text: field("text"), url: field("url"), files: list }), { headers: { "content-type": "application/json" } });
  try {
    await cache.put(SHARE_META, meta(files));
  } catch {
    for (const index of files.keys()) await cache.delete(shareFileKey(id, index));
    await cache.put(SHARE_META, meta(files.map((entry) => ({ name: entry.name, type: entry.type, lost: true }))));
  }
}

/** The answer to a share's POST: whatever could be kept is kept, and the app always opens on the chat. */
async function receiveShare(request, caches, origin) {
  try {
    await stashShare(await request.formData(), await caches.open(SHARE_CACHE), shareId(globalThis.crypto));
  } catch {}
  return Response.redirect(new URL("/?tab=chat", origin).href, 303);
}

globalThis.rivetShare = {
  SHARE_PATH: SHARE_PATH,
  SHARE_CACHE: SHARE_CACHE,
  SHARE_META: SHARE_META,
  SHARE_TAKEN: SHARE_TAKEN,
  shareFileKey: shareFileKey,
  stashShare: stashShare,
  receiveShare: receiveShare,
};
