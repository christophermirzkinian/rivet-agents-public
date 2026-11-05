// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Board, Reply, ServedNeed } from "../src/shared/board.js";
import { when } from "../src/shared/when.js";
import { answeredTab, NOTHING_NEEDS_YOU, openTab } from "../src/shared/words.js";
import type { CardThread } from "../src/shared/threads.js";
import type { Worker } from "../src/shared/workers.js";
import { readOutbox, remember } from "../web/src/outbox.js";
import { app, cardState, changed, navStamp, openingTab, refresh, resetSession, settleOpening, subscribe, whenSignedOut } from "../web/src/state.js";
import { closeAnswerSheet, flushHeld, recoverOutbox, resetFeed, showCard, showList, TAP_LOCK_MS } from "../web/src/views/feed.js";
import { workerRefresh } from "../web/src/push.js";
import { DESK_QUERY } from "../web/src/desk.js";
import { closeWorkerSheet } from "../web/src/views/worker-sheet.js";
import * as decide from "../web/src/views/decide-sheet.js";
import { mountShell } from "../web/src/views/shell.js";
import { dock } from "../web/src/views/home.js";
import { localItems, openTarget } from "../web/src/views/search.js";
import { rankSearch } from "../src/shared/search.js";
import { endSession } from "../web/src/session.js";
import { closeSheet, closeTallSheet } from "../web/src/views/sheet.js";
import { clearUndo, flash, mountToasts, showUndo } from "../web/src/views/toast.js";
import { stubCanvas } from "./canvas-stub.js";
import { detailBody } from "./conversations-fake.js";
import { openConversation, showChatThing, showConversation } from "../web/src/views/chat.js";

vi.mock("../web/src/image.js", async (original) => ({
  ...(await original<typeof import("../web/src/image.js")>()),
  // happy-dom cannot decode or draw an image; the canvas step is the browser's.
  prepareImage: async () => new Blob(["jpeg bytes"], { type: "image/jpeg" }),
}));

const IMAGE = "d".repeat(64);
let uploads: unknown[] = [];
let fileUploads = 0;
/** How the fake server answers the next POST /api/images; unset, it takes the photo. */
let uploadAnswer: (() => Promise<Response>) | null = null;

interface Post {
  body: Record<string, unknown>;
  keepalive: boolean | undefined;
}

let needs: ServedNeed[] = [];
/** The board's other lists: coming, chats and shipped. */
let lists: Partial<Pick<Board, "coming" | "chats" | "shipped">> = {};
/** Bodies POSTed to /api/chat (Rivet's chat). */
let chatPosts: Record<string, unknown>[] = [];
/** When set, /api/chat answers only once it resolves (a slow send). */
let chatGate: Promise<void> | null = null;
/** Bodies POSTed to /api/ops/fix (Feed's Fix it), and when set, the gate its answer waits on and its status. */
let fixPosts: Record<string, unknown>[] = [];
let fixGate: Promise<void> | null = null;
let fixStatus = 202;
let replies: Reply[] = [];
/** When set, GET /api/replies/:id answers only once it resolves (a slow fetch). */
let replyGate: Promise<void> | null = null;
/** Holds a POST /api/replies the plan says "late", which then lands. */
let lateGate: Promise<void> | null = null;
/** Holds GET /api/replies, which answers with the replies as they were when it was asked. */
let listGate: Promise<void> | null = null;
let posts: Post[] = [];
/** POST /api/board/needs/:id/again bodies; "conflict" answers 409 as a card that changed. */
let againPosts: { rev: string }[] = [];
let againPlan: "ok" | "conflict" = "ok";
/** What the fake server holds minimised, as [key, rev], oldest first; PUT /api/minimised/:key writes it. */
let minimised: [string, string][] = [];
/** PUT /api/minimised answers 503 while set. */
let minimiseFails = false;
/** Minimise PUTs for these cards never answer, as a send stalled offline. */
let minimiseStalls = new Set<string>();
/** How the fake server answers each POST /api/replies, in order; missing entries succeed. */
let replyPlan: ("ok" | "conflict" | "answered" | "late" | "hang" | "signin" | "lost" | "no-photos")[] = [];
/** GET paths the fake server fails with a 503. */
let failing = new Set<string>();
let workers: Worker[] = [];
/** GET /api/card-threads: each card's thread and round. */
let cardLinks: CardThread[] = [];
let bridgeUp = true;
/** The session has ended: every API call answers 401. */
let expired = false;
let root: HTMLElement;
let unmount: (() => void) | null = null;

function need(id: string, rev: string, ask = `Ask ${id}`): ServedNeed {
  return { id, kind: "approval", title: `Card ${id}`, ask, rev };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = String(input);
  if (expired) return Promise.resolve(json({ error: "Sign in again" }, 401));
  if (failing.has(url.split("?")[0]!)) return Promise.resolve(json({ error: "Unavailable" }, 503));
  if (url === "/api/board") {
    const board = { updatedAt: "2026-09-28T00:00:00.000Z", needs, coming: [], chats: [], shipped: [], ...lists };
    return Promise.resolve(json({ version: 1, updatedAt: board.updatedAt, board, minimised }));
  }
  const minimisedMatch = /^\/api\/minimised\/([^/]+)$/.exec(url);
  if (minimisedMatch && init.method === "PUT") {
    if (minimiseFails) return Promise.resolve(json({ error: "Unavailable" }, 503));
    const key = decodeURIComponent(minimisedMatch[1]!);
    if (minimiseStalls.has(key)) return new Promise(() => undefined);
    const body = JSON.parse(String(init.body)) as { small: boolean; rev?: string };
    minimised = [...minimised.filter(([one]) => one !== key), ...(body.small ? [[key, body.rev!] as [string, string]] : [])];
    return Promise.resolve(json({ minimised }));
  }
  const againMatch = /^\/api\/board\/needs\/([^/]+)\/again$/.exec(url);
  if (againMatch && init.method === "POST") {
    againPosts.push(JSON.parse(String(init.body)) as { rev: string });
    const index = needs.findIndex((one) => one.id === againMatch[1]);
    if (againPlan === "conflict" || index < 0) return Promise.resolve(json({ error: "this card changed; look again" }, 409));
    needs = needs.map((one, i) => (i === index ? { ...one, rev: `${one.rev}-again` } : one));
    return Promise.resolve(json({ version: 2, item: needs[index] }));
  }
  if (url === "/api/answered") return Promise.resolve(json({ cards: replies.map((one) => ({ card: { ...need(one.itemId, one.rev), title: one.itemTitle }, reply: one })), reopened: [] }));
  if (url === "/api/workers") return Promise.resolve(json({ at: null, workers }));
  if (url === "/api/card-threads") return Promise.resolve(json({ cards: cardLinks }));
  if (url === "/api/conversations/t-quiz") return Promise.resolve(json(detailBody("t-quiz", [], { title: "Quiz app pace" })));
  if (url === "/api/chat" && init.method === "POST") {
    chatPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const answer = json({ id: `msg-${chatPosts.length}`, kind: "chat", status: "queued" }, 202);
    return chatGate ? chatGate.then(() => answer) : Promise.resolve(answer);
  }
  if (url === "/api/ops/fix" && init.method === "POST") {
    fixPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const answer = () => json(fixStatus === 202 ? { id: `fix-${fixPosts.length}`, kind: "chat", status: "queued" } : { error: "its status changed" }, fixStatus);
    return fixGate ? fixGate.then(answer) : Promise.resolve(answer());
  }
  if (url === "/api/status") return Promise.resolve(json({ board: { version: 1, updatedAt: null }, bridge: { connected: bridgeUp, lastSeenAt: null } }));
  if (url.startsWith("/api/replies/") && (init.method ?? "GET") === "GET") {
    const found = replies.find((item) => item.id === decodeURIComponent(url.slice("/api/replies/".length)));
    const answer = () => (found ? json(found) : json({ error: "no such reply" }, 404));
    return replyGate ? replyGate.then(answer) : Promise.resolve(answer());
  }
  if (url.startsWith("/api/replies") && (init.method ?? "GET") === "GET") {
    const asked = [...replies];
    return listGate ? listGate.then(() => json({ replies: asked })) : Promise.resolve(json({ replies: asked }));
  }
  if (url === "/api/files") {
    const name = decodeURIComponent((init.headers as Record<string, string>)["x-file-name"]!);
    // The first file is "f…", the next "e…": each upload is its own document.
    return Promise.resolve(json({ sha256: (15 - fileUploads++).toString(16).repeat(64), name, type: "application/pdf", size: 10 }, 201));
  }
  if (url === "/api/images") {
    uploads.push(init.body);
    if (uploadAnswer) return uploadAnswer();
    // The first photo is IMAGE, the next "2…", "3…": each upload is its own photo.
    return Promise.resolve(json({ image: uploads.length === 1 ? IMAGE : uploads.length.toString(16).repeat(64), type: "image/jpeg", size: 10 }, 201));
  }
  if (url === "/api/replies") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    posts.push({ body, keepalive: init.keepalive });
    const plan = replyPlan.shift() ?? "ok";
    if (plan === "hang") return new Promise(() => {});
    if (plan === "conflict") return Promise.resolve(json({ error: "This card changed" }, 409));
    if (plan === "answered") return Promise.resolve(json({ error: "This card was already answered.", answered: replies.find((r) => r.itemId === body.itemId) }, 409));
    if (plan === "signin") return Promise.resolve(json({ error: "Sign in" }, 401));
    if (plan === "lost") return Promise.reject(new TypeError("Failed to fetch"));
    if (plan === "no-photos") return Promise.resolve(json({ error: "The Mac's bridge needs updating before it can take photos." }, 424));
    const reply = { id: `reply-${posts.length}`, itemTitle: "t", at: new Date().toISOString(), handled: false, item: {}, ...body } as unknown as Reply;
    if (plan === "late") return lateGate!.then(() => json(reply, 201));
    return Promise.resolve(json(reply, 201));
  }
  return Promise.resolve(json({}, 404));
}

/** What main.ts does on sign-in; `shell` mounts the phone's real shell, whose Cards id is the Decide sheet. */
async function signIn(shell = false): Promise<void> {
  unmount?.();
  resetFeed();
  resetSession();
  // Sign-in lands on the home screen; these tests work the feed.
  app.tab = "cards";
  unmount = shell || window.matchMedia(DESK_QUERY).matches ? mountShell(root) : mountPhone();
  if (await refresh()) recoverOutbox();
}

/**
 * The wide window's Decide pane, with the toasts and
 * the home screen's dock beside it: the cards' own behaviour, answered one at a time as in the phone's Decide sheet.
 */
function mountCards(): () => void {
  const view = document.createElement("main");
  view.className = "view";
  view.dataset.tab = "cards";
  const toasts = document.createElement("div");
  toasts.className = "toasts";
  const bar = document.createElement("nav");
  bar.className = "home-dock";
  const paint = () => bar.replaceChildren(...dock());
  root.replaceChildren(view, toasts, bar);
  mountToasts(toasts);
  decide.pane.mount(view);
  const stop = subscribe(paint);
  paint();
  return () => {
    stop();
    decide.pane.unmount();
    closeWorkerSheet();
    mountToasts(null);
  };
}

/** A phone: the Cards tab id shows the Decide pane; any other shows the home screen and the sheet its id opens. */
function mountPhone(): () => void {
  let on: "cards" | "home" | null = null;
  let leave = () => {};
  const show = () => {
    const want = app.tab === "cards" ? "cards" : "home";
    if (want === on) return;
    leave();
    on = want;
    leave = want === "cards" ? mountCards() : mountShell(root);
  };
  const stop = subscribe(show);
  show();
  return () => {
    stop();
    leave();
  };
}

/** What main.ts's poll does. */
async function poll(): Promise<void> {
  if (await refresh()) recoverOutbox();
}

/** A poll that reads something new, so the Feed redraws: one that reads nothing new leaves the page as it is. */
async function pollNew(): Promise<void> {
  cardLinks = [...cardLinks, { card: `gone-${cardLinks.length}`, thread: "t-gone", title: "Gone", round: 1 }];
  await poll();
}

function reply(itemId: string, rev: string, clientId: string, decision: Reply["decision"] = "approve"): Reply {
  return { id: `r-${clientId}`, clientId, itemId, itemTitle: `Card ${itemId}`, decision, rev, at: new Date().toISOString(), handled: true, item: { id: itemId, title: `Card ${itemId}`, kind: "approval" } };
}

/** What main.ts does when the session ends. */
function signOut(): void {
  unmount?.();
  unmount = null;
  resetFeed();
  root.replaceChildren(document.createElement("section"));
}

function key(type: "keydown" | "keyup", name: string, repeat = false): void {
  document.dispatchEvent(new KeyboardEvent(type, { key: name, repeat, bubbles: true }));
}

/** Types why into the open reject popup, as a thumb would, and taps its Reject. */
function rejectWhy(text = "Not this"): void {
  const area = document.querySelector<HTMLTextAreaElement>(".reject-sheet .sheet-text")!;
  area.value = text;
  area.dispatchEvent(new Event("input"));
  document.querySelector<HTMLButtonElement>(".reject-sheet .reject-send")!.click();
}

/** The Decide pane's switch, by Cards' old segment names: "needs" is its Open, "done" its Answered. */
function segment(): string | undefined {
  const on = root.querySelector('.decide-segs .decide-seg[aria-pressed="true"]')?.getAttribute("data-seg");
  return on === "open" ? "needs" : on === "answered" ? "done" : undefined;
}

function toSegment(name: "needs" | "done"): void {
  root.querySelector<HTMLButtonElement>(`.decide-segs .decide-seg[data-seg="${name === "done" ? "answered" : "open"}"]`)!.click();
}

function topId(): string | undefined {
  return root.querySelector<HTMLElement>(".card.top")?.dataset.need;
}

async function settle(ms = 300): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  // Noon in: fixtures dated minutes or hours "ago" stay on the same local day, whenever CI runs (main run 40694019454 began 00:12).
  vi.useFakeTimers({ now: new Date("2026-10-28T01:00:00.000Z"), toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  stubCanvas();
  localStorage.clear();
  localStorage.setItem("rivet.installHint", "dismissed");
  minimised = [];
  minimiseFails = false;
  minimiseStalls = new Set();
  needs = [];
  lists = {};
  chatPosts = [];
  chatGate = null;
  replies = [];
  replyGate = null;
  listGate = null;
  lateGate = null;
  posts = [];
  againPosts = [];
  againPlan = "ok";
  uploads = [];
  fileUploads = 0;
  uploadAnswer = null;
  replyPlan = [];
  failing = new Set();
  // Sign-in keeps app.front (a notification's card); a test's Undo must not pick the next test's top card.
  app.front = null;
  workers = [];
  cardLinks = [];
  bridgeUp = true;
  fixPosts = [];
  fixGate = null;
  fixStatus = 202;
  expired = false;
  root = document.createElement("div");
  document.body.replaceChildren(root);
});

afterEach(async () => {
  signOut();
  // Finish deferred media cleanup before discarding the fake timer queue.
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("links in a card's ask", () => {
  it("opens an https URL in the ask outside the app, and leaves the rest as text", async () => {
    needs = [need("a", "a1", "Read https://example.com/white-paper.pdf, then answer.")];
    await signIn();
    const ask = root.querySelector(".card.top .card-ask")!;
    expect(ask.textContent).toBe("Read https://example.com/white-paper.pdf, then answer.");
    const link = ask.querySelector("a")!;
    expect([link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")]).toEqual(["https://example.com/white-paper.pdf", "_blank", "noopener noreferrer"]);
  });

  it("puts a choice detail's links under its button, never inside it, so opening one cannot answer", async () => {
    needs = [{ ...need("a", "a1", "Pick one"), kind: "choice", options: [{ label: "A", detail: "Preview https://example.com/demo first" }, { label: "B" }] }];
    await signIn();
    const choices = root.querySelector(".card.top .choices")!;
    expect(choices.querySelector("button a")).toBeNull();
    expect([...choices.querySelectorAll(".choice-links a")].map((a) => a.getAttribute("href"))).toEqual(["https://example.com/demo"]);
    expect(choices.querySelector(".choice-detail")!.textContent).toBe("Preview https://example.com/demo first");
  });

  it("shows no Mac pill while the Mac is online; offline, the pill shows and the buttons that send say they wait", async () => {
    needs = [{ ...need("a", "a1", "Pick one"), kind: "choice", options: [{ label: "A" }, { label: "B" }] }];
    await signIn();
    expect(root.textContent).not.toContain("waits for the Mac");
    tab("Progress");
    expect(root.querySelector(".home-band")).not.toBeNull();
    expect(root.querySelector('[aria-label="Mac offline"]')).toBeNull();
    bridgeUp = false;
    await signIn();
    const waits = [...root.querySelectorAll(".card.top .choice .waits, .actions .pick .waits")].map((span) => span.textContent);
    expect(waits.length).toBeGreaterThan(0);
    expect(new Set(waits)).toEqual(new Set(["(waits for the Mac)"]));
    // The header band carries the pill on a phone.
    tab("Progress");
    expect(root.querySelector(".home-band .pill")!.getAttribute("aria-label")).toBe("Mac offline");
  });

  it("the say-line's Send follows the Mac going and coming, and a money card's confirm tap says it waits", async () => {
    needs = [need("a", "a1")];
    await signIn();
    say("Bluer");
    const send = () => root.querySelector<HTMLButtonElement>(".actions .say-send")!;
    expect(send().textContent).toBe("Send");
    bridgeUp = false;
    await poll();
    expect(root.querySelector<HTMLTextAreaElement>(".actions .say-text")!.value).toBe("Bluer");
    expect(send().textContent).toBe("Send(waits for the Mac)");
    bridgeUp = true;
    await poll();
    expect(send().textContent).toBe("Send");

    needs = [{ ...need("m", "m1"), kind: "decision", risk: "money", options: [{ label: "Ship it" }, { label: "Hold" }] }];
    bridgeUp = false;
    await poll();
    await settle(0);
    actionButton("Ship it").click();
    await settle(0);
    expect(root.querySelector(".card.top .confirm .btn.danger")?.textContent).toBe("Yes, confirm(waits for the Mac)");
  });
});

describe("signing in again", () => {
  it("renders into the new shell and answers the card on screen, at the revision on screen", async () => {
    needs = [need("a", "a1", "Old ask")];
    await signIn();
    expect(root.querySelector(".card-ask")?.textContent).toBe("Old ask");

    signOut();
    needs = [need("a", "a2", "New ask")];
    await signIn();
    expect(root.querySelector(".card-ask")?.textContent).toBe("New ask");

    // A newer revision that has not been drawn yet is never the one answered.
    app.board!.board!.needs = [need("a", "a3", "Unseen ask")];
    key("keydown", "a");
    await settle(TAP_LOCK_MS);
    flushHeld();
    await settle(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ itemId: "a", decision: "approve", rev: "a2" });
  });

  it("leaves no keyboard handler behind on a signed-out shell", async () => {
    needs = [need("a", "a1")];
    await signIn();
    signOut();
    key("keydown", "a");
    await settle(6000);
    expect(posts).toHaveLength(0);
  });
});

describe("keyboard answers", () => {
  it("answers one card per key press, ignoring auto-repeat until the key is released", async () => {
    needs = [need("a", "a1"), need("b", "b1"), need("c", "c1")];
    await signIn();

    key("keydown", "a", true);
    await settle(TAP_LOCK_MS);
    expect(topId()).toBe("a");

    key("keydown", "a");
    await settle(TAP_LOCK_MS);
    expect(topId()).toBe("b");

    key("keydown", "a", true);
    key("keydown", "a");
    await settle(TAP_LOCK_MS);
    expect(topId()).toBe("b");

    key("keyup", "a");
    key("keydown", "a");
    await settle(TAP_LOCK_MS);
    expect(topId()).toBe("c");

    flushHeld();
    await settle(0);
    expect(posts.map((post) => post.body.itemId)).toEqual(["a", "b"]);
  });
});

describe("cards that take a pick or a typed answer", () => {
  const labels = () => [...root.querySelectorAll(".actions .btn")].map((element) => element.textContent);

  it("an option card has no Approve, and a right arrow sends nothing", async () => {
    needs = [{ ...need("m", "m1"), kind: "decision", options: [{ label: "Merge as is" }, { label: "Change something (type what)", text: true }] }];
    await signIn();
    // One list: the card's boxes are the answers, and the bar under it holds the say-line alone; Reject is the X at the
    // card's top right and there is no Dismiss.
    expect([...root.querySelectorAll<HTMLButtonElement>(".card.top .btn.choice")].map((box) => box.dataset.key)).toEqual(["Merge as is", "Change something (type what)"]);
    expect(root.querySelector(".actions .btn.pick")).toBeNull();
    expect(root.querySelector(".actions .btn.mini")).toBeNull();
    expect(root.querySelector(".card.top .card-head .x-btn")?.getAttribute("aria-label")).toBe("Reject Card m");
    expect(labels()).not.toContain("Approve");

    key("keydown", "a");
    await settle(TAP_LOCK_MS);
    key("keyup", "a");
    expect(topId()).toBe("m");

    // The "type what" option asks for the note in the say-line before it sends.
    const typeWhat = () => root.querySelector<HTMLButtonElement>('.card.top .btn.choice[data-key="Change something (type what)"]')!;
    typeWhat().click();
    await settle();
    flushHeld();
    expect(posts).toEqual([]);
    expect(document.activeElement).toBe(root.querySelector(".actions .say-text"));
    say("Bluer ice");
    typeWhat().click();
    flushHeld();
    await settle(0);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "m", decision: "choice", choice: "Change something (type what)", text: "Bluer ice" }]);
  });

  it("a question with no options leads with a text box and sends a typed answer", async () => {
    needs = [{ ...need("q", "q1", "What should change?"), kind: "question" }];
    await signIn();
    expect(labels().filter((label) => label)).toEqual(["Send answer"]);
    expect(root.querySelector(".actions .say-text")!.getAttribute("aria-label")).toBe("Your answer");

    // With nothing typed, a right arrow puts the keyboard in the say-line and sends nothing.
    key("keydown", "a");
    await settle(TAP_LOCK_MS);
    key("keyup", "a");
    flushHeld();
    expect(posts).toEqual([]);
    expect(document.activeElement).toBe(root.querySelector(".actions .say-text"));
    say("Slower camera");
    (document.activeElement as HTMLElement).blur();
    actionButton("Send answer").click();
    flushHeld();
    await settle(0);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "q", decision: "comment", text: "Slower camera" }]);
  });
});

describe("writing on a card, the next cards, and risky cards", () => {
  const OPTIONS = [
    { label: "Approve and merge", short: "OK", recommended: true },
    { label: "Send changes (write them below)", short: "Changes", text: true },
  ];
  const sheetText = (selector: string) => root.querySelector(`.sheet ${selector}`)?.textContent;
  const mini = (label: string) => [...root.querySelectorAll<HTMLButtonElement>(".actions .btn.mini")].find((b) => b.textContent === label)!;

  it("puts money, login and fairness cards first", async () => {
    needs = [need("a", "a1"), { ...need("m", "m1"), risk: "money" }, need("b", "b1"), need("c", "c1"), need("d", "d1")];
    await signIn();
    expect(topId()).toBe("m");
    expect(root.querySelector(".up-next, .card.under, .card-count")).toBeNull();
  });

  it("on a money card Rivet's pick is the one green Recommended box, with no line above it, and the extra confirm tap stays", async () => {
    needs = [{ ...need("m", "m1"), kind: "decision", risk: "money", options: [{ label: "Ship it", recommended: true }, { label: "Hold" }] }];
    await signIn();
    expect(root.querySelector(".card-suggests")).toBeNull();
    expect(root.querySelector(".card.top")?.textContent).not.toContain("suggests");
    const rec = [...root.querySelectorAll<HTMLElement>(".card.top .btn.choice.rec")];
    expect(rec.map((box) => box.dataset.key)).toEqual(["Ship it"]);
    expect(rec[0]!.querySelector(".choice-rec")?.textContent).toBe("Recommended");
    root.querySelector<HTMLButtonElement>('.card.top .btn.choice[data-key="Ship it"]')!.click();
    await settle(0);
    expect(root.querySelector(".card.top .confirm")).not.toBeNull();
    expect(posts).toHaveLength(0);
  });

  it("every card reads title, ask, then who sent it", async () => {
    needs = [{ ...need("d", "d1"), kind: "decision", chat: "schedules-retime", options: [{ label: "Keep" }] }];
    await signIn();
    const order = [...root.querySelectorAll(".card.top .card-body > *")].map((child) => child.className.split(" ")[0]);
    expect(order.slice(0, 3)).toEqual(["card-title", "card-ask", "card-meta"]);
  });

  it("the grey line names only the chat and the age, never the PR", async () => {
    needs = [{ ...need("d", "d1"), kind: "decision", chat: "schedules-retime", pr: 4321, options: [{ label: "Keep" }] } as never];
    await signIn();
    const meta = root.querySelector(".card.top .card-meta")!.textContent!;
    expect(meta).toContain("schedules");
    expect(meta).not.toContain("PR");
  });

  it("a card's answer says its label once, never its short beside it", async () => {
    needs = [{ ...need("w", "w1"), kind: "decision", options: [{ label: "5 minutes", short: "5 min", detail: "Fastest" }, { label: "Approve and merge", short: "OK" }] }];
    await signIn();
    const boxes = [...root.querySelectorAll<HTMLElement>(".card.top .btn.choice")];
    expect(boxes.map((box) => box.textContent)).toEqual(["5 minutesFastest", "Approve and merge"]);
  });

  it.each(["card", "conversation"])("a stale missing-card read cannot replace a pending %s destination", async (destination) => {
    const { leaveOverlays } = await import("../web/src/views/navigation.js");
    const { openImages } = await import("../web/src/views/lightbox.js");
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input) === "/api/board" ? gate.then(() => fakeFetch(input, init)) : fakeFetch(input, init)));
    showCard("late");
    openImages(["/image.png"], 0);
    const back = vi.spyOn(history, "back").mockImplementation(() => undefined);
    if (destination === "card") showCard("b");
    else leaveOverlays(() => {
      showConversation("t-quiz");
      app.tab = "chat";
      changed();
    });
    needs.push(need("late", "l1"));
    release();
    await settle();
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    await settle();
    if (destination === "card") expect(topId()).toBe("b");
    else expect(openConversation()).toBe("t-quiz");
    back.mockRestore();
  });

  it("opens on Cards while cards wait and on Progress when all clear, a link's tab winning; the desks repeat no count", async () => {
    needs = [need("a", "a1")];
    await signIn();
    app.tab = "progress";
    expect(openingTab(null)).toBe("cards");
    expect(openingTab("chat")).toBe("chat");
    changed();
    await settle(0);
    // The Cards badge counts the cards waiting; the desks show no need-you button repeating it.
    expect(root.querySelector(".home-decide.has-cards .home-decide-n")?.textContent).toBe("1");
    expect(root.querySelector(".paper .paper-needs")).toBeNull();
    expect(root.querySelector(".paper-next")?.textContent ?? "").not.toContain("need you");

    needs = [];
    await poll();
    app.tab = "progress";
    expect(openingTab(null)).toBe("progress");
  });

  it("picks the opening tab once the first board loads, unless a tab or a card was opened while it loaded", async () => {
    needs = [need("a", "a1")];
    await signIn();
    app.tab = "progress";
    changed();
    settleOpening(null, navStamp());
    expect(app.tab).toBe("cards");

    // A tab tapped while the board loaded stays, even after a trip to a menu page and back to Progress.
    app.tab = "progress";
    changed();
    let stamp = navStamp();
    tab("More");
    tab("Progress");
    expect(app.tab).toBe("progress");
    settleOpening(null, stamp);
    expect(app.tab).toBe("progress");

    // So does a card opened from a notification on Cards.
    app.tab = "cards";
    changed();
    stamp = navStamp();
    showCard("a");
    settleOpening("progress", stamp);
    expect(app.tab).toBe("cards");
  });
});

describe("todo cards", () => {
  const todo = (): ServedNeed => ({
    ...need("tax", "tax1", "The vendor holds access until the form is in.\nSecond line stays off the card."),
    kind: "todo",
    title: "Add the form in the vendor console",
    steps: ["Sign in as the company", "Open Business → Agreements", "Paste the company number"],
    links: [
      { label: "a guide", url: "https://example.com/guide" },
      { label: "Vendor Console", url: "https://console.example.com", primary: true },
    ],
  });

  it("shows the ask as one line, the steps numbered, the primary link as Open beside Done, and Done in place of Approve", async () => {
    needs = [todo(), need("b", "b1")];
    await signIn();
    const card = root.querySelector(".card.top")!;
    expect(card.querySelector(".card-ask")!.textContent).toBe("The vendor holds access until the form is in.");
    expect([...card.querySelectorAll("ol.todo-steps > li")].map((li) => li.textContent)).toEqual(todo().steps);
    // Out of the scrolling card, so the long-card fade never dims it.
    expect(card.querySelector(".todo-open")).toBeNull();
    const open = root.querySelector<HTMLAnchorElement>(".actions a.todo-open")!;
    expect([open.textContent, open.getAttribute("href"), open.getAttribute("target")]).toEqual(["Open Vendor Console", "https://console.example.com", "_blank"]);
    expect([...card.querySelectorAll(".card-links a")].map((a) => a.textContent)).toEqual(["a guide"]);
    expect(root.querySelector(".actions .say-line .say-text")).not.toBeNull();
    expect([...root.querySelector(".actions")!.querySelectorAll(".btn")].filter((b) => !b.closest(".say-line")).map((b) => b.textContent)).toEqual(["Done"]);
  });

  it("a card has no Dismiss: it is answered, changed, minimised or rejected", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    expect([...root.querySelector(".actions")!.querySelectorAll(".btn")].filter((b) => !b.closest(".say-line")).map((b) => b.textContent)).toEqual(["Approve"]);
    expect(root.querySelector(".btn.dismiss")).toBeNull();
  });

  it("Done waits out its Undo window in the outbox path, and Undo sends nothing", async () => {
    needs = [todo(), need("b", "b1")];
    await signIn();
    actionButton("Done").click();
    expect(topId()).toBe("b");
    expect(root.querySelector(".toast.undo .toast-text strong")?.textContent).toBe("Done");
    await settle(4000);
    root.querySelector<HTMLButtonElement>(".toast.undo .undo-btn")!.click();
    await settle(0);
    expect(topId()).toBe("tax");

    expect(posts).toEqual([]);

    replyPlan = ["hang"];
    await settle(TAP_LOCK_MS);
    actionButton("Done").click();
    await settle(5100);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "tax", decision: "done", rev: "tax1" }]);
    expect(readOutbox()).toMatchObject([{ itemId: "tax", decision: "done", rev: "tax1", title: "Add the form in the vendor console", clientId: posts[0]!.body.clientId }]);
  });

  it("an approve or reject key on a todo card sends nothing", async () => {
    needs = [todo(), need("b", "b1")];
    await signIn();
    key("keydown", "a");
    key("keyup", "a");
    key("keydown", "x");
    await settle(6000);
    flushHeld();
    await settle(0);
    expect(topId()).toBe("tax");
    expect(posts).toEqual([]);
  });

  it("a stored board whose steps are not a list of strings still renders the card, without steps", async () => {
    needs = [{ ...todo(), steps: "Sign in" as unknown as string[] }, { ...todo(), id: "abn2", steps: [1, 2] as unknown as string[] }];
    await signIn();
    expect(topId()).toBe("tax");
    expect(root.querySelector(".todo-steps")).toBeNull();
    expect(root.querySelector(".actions .btn.pick.yes")?.textContent).toBe("Done");
  });

  it("search finds a todo card by a word in its steps", async () => {
    needs = [todo(), need("b", "b1")];
    await signIn();
    const found = rankSearch(await localItems(), "Agreements", Date.now());
    expect(found.map((item) => item.key)).toContain("card:tax");
  });
});

describe("a photo with a card answer", () => {
  beforeEach(() => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  function pickPhoto(): void {
    const input = root.querySelector<HTMLInputElement>(".actions .say-line .attach-input")!;
    Object.defineProperty(input, "files", { value: [new File(["heic bytes"], "IMG_0001.HEIC", { type: "image/heic" })], configurable: true });
    input.dispatchEvent(new Event("change"));
  }

  async function openQuestion(): Promise<void> {
    needs = [{ ...need("q", "q1", "What should change?"), kind: "question" }];
    await signIn();
  }

  it("sends a photo alone as the answer from the say-line", async () => {
    await openQuestion();
    expect(root.querySelector(".actions .say-line .attach-btn")!.getAttribute("aria-label")).toBe("Attach photos or files");
    pickPhoto();
    await settle(0);
    await settle(0);
    expect(uploads).toHaveLength(1);
    expect(root.querySelector(".actions .say-line .attach-note")!.textContent).toBe("Photo attached");
    root.querySelector<HTMLButtonElement>(".actions .btn.pick.yes")!.click();
    flushHeld();
    await settle(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ itemId: "q", decision: "comment", image: IMAGE });
    expect(posts[0]!.body).not.toHaveProperty("text");
  });

  it("sends a file alone as the answer, shown as a chip; a refused type is refused at once", async () => {
    await openQuestion();
    const input = root.querySelector<HTMLInputElement>(".actions .say-line .attach-input")!;
    const pick = (file: File) => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change"));
    };
    pick(new File(["x"], "setup.exe", { type: "application/octet-stream" }));
    expect(root.querySelector(".actions .say-line .attach-notice")!.textContent).toBe("That file type can't be sent. Attach photos, videos, music, PDFs, text files, Office documents, emails, ZIPs or GLB models.");
    pick(new File(["%PDF-1.7"], "Brief.pdf", { type: "application/pdf" }));
    await settle(0);
    await settle(0);
    expect(root.querySelector(".actions .say-line .file-chip-name")!.textContent).toBe("Brief.pdf");
    expect(root.querySelector(".actions .say-line .attach-note")!.textContent).toBe("File attached");
    root.querySelector<HTMLButtonElement>(".actions .btn.pick.yes")!.click();
    flushHeld();
    await settle(0);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "q", decision: "comment", files: [{ sha256: "f".repeat(64), name: "Brief.pdf" }] }]);
    expect(posts[0]!.body).not.toHaveProperty("image");
  });

  it("sends the photo with the typed answer", async () => {
    await openQuestion();
    pickPhoto();
    await settle(0);
    await settle(0);
    const area = root.querySelector<HTMLTextAreaElement>(".actions .say-text")!;
    area.value = "The button is too small";
    area.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".actions .btn.pick.yes")!.click();
    flushHeld();
    await settle(0);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "q", decision: "comment", text: "The button is too small", image: IMAGE }]);
  });

  it("Remove before sending drops the photo from the answer", async () => {
    await openQuestion();
    pickPhoto();
    await settle(0);
    await settle(0);
    root.querySelector<HTMLButtonElement>(".actions .say-line .attach-remove")!.click();
    expect(root.querySelector<HTMLElement>(".actions .say-line .attach-preview")!.hidden).toBe(true);
    const next = root.querySelector<HTMLTextAreaElement>(".actions .say-text")!;
    next.value = "No";
    next.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".actions .btn.pick.yes")!.click();
    flushHeld();
    await settle(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ itemId: "q", decision: "comment", text: "No" });
    expect(posts[0]!.body).not.toHaveProperty("image");
  });

  function typeAnswer(value: string): void {
    const area = root.querySelector<HTMLTextAreaElement>(".actions .say-text")!;
    area.value = value;
    area.dispatchEvent(new Event("input"));
  }

  it("a photo the Mac's bridge cannot take yet: a toast, and the card keeps the note and the photo", async () => {
    replyPlan = ["no-photos"];
    await openQuestion();
    pickPhoto();
    await settle(0);
    await settle(0);
    typeAnswer("The button is too small");
    root.querySelector<HTMLButtonElement>(".actions .btn.pick.yes")!.click();
    flushHeld();
    await settle(0);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "q", text: "The button is too small", image: IMAGE }]);
    expect(root.querySelector(".toast.flash")?.textContent).toBe("The Mac's bridge needs updating before it can take photos.");
    expect(root.querySelector<HTMLTextAreaElement>(".actions .say-text")!.value).toBe("The button is too small");
    expect(root.querySelector(".actions .say-line .attach-note")!.textContent).toBe("Photo attached");
  });

  it("a typed answer with a photo that failed to upload does not send; the say-line keeps the words", async () => {
    uploadAnswer = () => Promise.resolve(json({ error: "that file is not a JPEG or PNG image" }, 415));
    await openQuestion();
    pickPhoto();
    await settle(0);
    await settle(0);
    typeAnswer("The button is too small");
    root.querySelector<HTMLButtonElement>(".actions .btn.pick.yes")!.click();
    flushHeld();
    await settle(0);
    expect(posts).toHaveLength(0);
    expect(root.querySelector(".toast.flash")?.textContent).toBe("The photo didn't upload. Try again or remove it.");
    expect(root.querySelector<HTMLTextAreaElement>(".actions .say-text")!.value).toBe("The button is too small");
  });

  it("a reject with a photo that failed to upload keeps the popup open, with his words in it", async () => {
    uploadAnswer = () => Promise.resolve(json({ error: "that file is not a JPEG or PNG image" }, 415));
    await openQuestion();
    pickPhoto();
    await settle(0);
    await settle(0);
    root.querySelector<HTMLButtonElement>(".card.top .x-btn")!.click();
    const why = document.querySelector<HTMLTextAreaElement>(".reject-sheet .sheet-text")!;
    why.value = "Too dark";
    why.dispatchEvent(new Event("input"));
    document.querySelector<HTMLButtonElement>(".reject-sheet .reject-send")!.click();
    flushHeld();
    await settle(0);
    expect(posts).toHaveLength(0);
    expect(root.querySelector(".toast.flash")?.textContent).toBe("The photo didn't upload. Try again or remove it.");
    expect(document.querySelector<HTMLTextAreaElement>(".reject-sheet .sheet-text")?.value).toBe("Too dark");
  });

  function pickMany(files: File[]): void {
    const input = root.querySelector<HTMLInputElement>(".actions .say-line .attach-input")!;
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new Event("change"));
  }

  const photo = (n: number) => new File([`photo ${n}`], `IMG_000${n}.HEIC`, { type: "image/heic" });

  it("takes several photos and several files, as the Chat composer does, and sends them all with the answer", async () => {
    let previews = 0;
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:preview-${++previews}`);
    await openQuestion();
    expect(root.querySelector(".actions .say-line .attach-input")!.hasAttribute("multiple")).toBe(true);
    pickMany([photo(1), photo(2), new File(["%PDF-1.7"], "Brief.pdf", { type: "application/pdf" })]);
    pickMany([new File(["notes"], "notes.txt", { type: "text/plain" })]);
    await settle(0);
    await settle(0);
    await settle(0);
    expect(root.querySelectorAll(".actions .say-line .attach-strip .attach-thumb")).toHaveLength(2);
    expect([...root.querySelectorAll(".actions .say-line .attach-docs .file-chip-name")].map((chip) => chip.textContent)).toEqual(["Brief.pdf", "notes.txt"]);
    expect(root.querySelector(".actions .say-line .attach-note")!.textContent).toBe("2 photos and 2 files attached");
    typeAnswer("These two screens, and the brief");
    root.querySelector<HTMLButtonElement>(".actions .btn.pick.yes")!.click();
    flushHeld();
    await settle(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      clientId: expect.any(String),
      itemId: "q",
      decision: "comment",
      rev: "q1",
      text: "These two screens, and the brief",
      images: [IMAGE, "2".repeat(64)],
      files: [
        // Each file is its own upload; which one the server saw first is not the answer's business.
        { sha256: expect.stringMatching(/^(e{64}|f{64})$/), name: "Brief.pdf" },
        { sha256: expect.stringMatching(/^(e{64}|f{64})$/), name: "notes.txt" },
      ],
    });
  });

  it("a photo waiting to send opens full screen from its preview, from the local copy", async () => {
    let previews = 0;
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:preview-${++previews}`);
    await openQuestion();
    pickMany([photo(1), photo(2)]);
    await settle(0);
    await settle(0);
    await settle(0);
    const opens = root.querySelectorAll<HTMLButtonElement>(".actions .say-line .attach-open");
    expect([...opens].map((open) => open.getAttribute("aria-label"))).toEqual(["Photo 1 to send, full screen", "Photo 2 to send, full screen"]);
    opens[1]!.click();
    expect(document.querySelector(".lightbox-title")!.textContent).toBe("Photo to send 2 of 2");
    expect(document.querySelector<HTMLImageElement>(".lightbox-img")!.getAttribute("src")).toBe("blob:preview-2");
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith("blob:"))).toBe(false);
    // The say-line is still there under the lightbox, with both photos.
    expect(root.querySelectorAll(".actions .say-line .attach-thumb")).toHaveLength(2);
  });

});

describe("toasts", () => {
  it("keeps an answer's Undo when a flash or another answer's toast is cleared", () => {
    const host = document.createElement("div");
    mountToasts(host);
    showUndo({ key: "b", verb: "Approved", title: "Card b", tone: "yes", ms: 5000, onUndo: () => {} });
    flash("Not sent.", "error");
    clearUndo("a");
    expect(host.querySelector('.toast.undo[data-key="b"]')).not.toBeNull();
    expect(host.querySelector(".toast.flash")?.textContent).toBe("Not sent.");
    clearUndo("b");
    expect(host.querySelector(".toast.undo")).toBeNull();
    expect(host.querySelector(".toast.flash")).not.toBeNull();
  });

  it("an earlier answer's failure does not remove the next answer's Undo", async () => {
    // A third card, so no cheer ends and takes Decide off screen meanwhile.
    needs = [need("a", "a1"), need("b", "b1"), need("c", "c1")];
    replyPlan = ["conflict"];
    await signIn();
    key("keydown", "a");
    await settle(TAP_LOCK_MS);
    key("keyup", "a");
    key("keydown", "a");
    await settle(4800);
    expect(posts.map((post) => post.body.itemId)).toEqual(["a"]);
    expect(root.querySelector(".toast.flash")?.textContent).toContain("changed");
    expect(root.querySelector(".toast.undo .toast-title")?.textContent).toBe("Card b");
  });
});

describe("closing the page", () => {
  it("sends every answer with keepalive and keeps it in the outbox until the server confirms it", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    replyPlan = ["ok", "hang"];
    await signIn();
    key("keydown", "a");
    await settle(TAP_LOCK_MS);
    key("keyup", "a");
    key("keydown", "x");
    rejectWhy();
    await settle();
    flushHeld();
    await settle(0);
    expect(posts.map((post) => post.keepalive)).toEqual([true, true]);
    expect(readOutbox().map((entry) => [entry.itemId, entry.decision])).toEqual([["b", "reject"]]);
  });

  it("shows an unconfirmed answer on the next load and reuses its clientId", async () => {
    needs = [need("a", "a1")];
    replyPlan = ["hang"];
    await signIn();
    key("keydown", "a");
    await settle(TAP_LOCK_MS);
    flushHeld();
    await settle(0);
    const clientId = posts[0]!.body.clientId;

    signOut();
    posts = [];
    await signIn();
    expect(topId()).toBe("a");
    expect(root.querySelector(".card-error")?.textContent).toContain("closed before Rivet confirmed");
    expect(cardState("a").pending?.clientId).toBe(clientId);

    key("keyup", "a");
    key("keydown", "a");
    await settle(TAP_LOCK_MS);
    flushHeld();
    await settle(0);
    expect(posts[0]!.body.clientId).toBe(clientId);
    expect(readOutbox()).toEqual([]);
  });

  it("drops an outbox entry the server already has", async () => {
    needs = [need("a", "a1")];
    replyPlan = ["hang"];
    await signIn();
    key("keydown", "a");
    await settle(TAP_LOCK_MS);
    flushHeld();
    await settle(0);

    signOut();
    replies = [reply("a", "a1", String(posts[0]!.body.clientId))];
    await signIn();
    expect(readOutbox()).toEqual([]);
    expect(root.querySelector(".card.top")).toBeNull();
  });

  it("keeps the outbox when the first load fails and recovers on the next good load", async () => {
    needs = [need("a", "a1")];
    remember({ clientId: "c-a", itemId: "a", decision: "approve", rev: "a1", title: "Card a" });
    for (const path of ["/api/board", "/api/status", "/api/replies"]) {
      failing = new Set([path]);
      signOut();
      await signIn();
      recoverOutbox();
      expect(readOutbox().map((entry) => entry.clientId)).toEqual(["c-a"]);
      expect(root.querySelector(".toast.flash.warn")).toBeNull();
    }
    failing = new Set();
    await poll();
    expect(topId()).toBe("a");
    expect(cardState("a").pending?.clientId).toBe("c-a");
  });

  it("recovers an unsent correction even when an earlier answer to the same card landed", async () => {
    needs = [need("a", "a1")];
    replies = [{ ...reply("a", "a1", "c-first", "comment"), text: "Proceed" }];
    remember({ clientId: "c-second", itemId: "a", decision: "comment", rev: "a1", title: "Card a", text: "Stop" });
    await signIn();
    expect(topId()).toBe("a");
    expect(root.querySelector(".card-error")?.textContent).toContain("closed before Rivet confirmed");
    expect(readOutbox().map((entry) => entry.clientId)).toEqual(["c-second"]);
  });

  it("a recovered answer over one that landed keeps its clientId, and is refused as already answered", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    replies = [reply("a", "a1", "c-first")];
    remember({ clientId: "c-second", itemId: "a", decision: "reject", rev: "a1", text: "Not this", title: "Card a" });
    await signIn();
    expect(topId()).toBe("a");
    expect(cardState("a").pending?.clientId).toBe("c-second");
    replyPlan = ["answered"];
    key("keydown", "x");
    rejectWhy();
    await settle();
    flushHeld();
    await settle(0);
    expect(posts.map((post) => post.body.clientId)).toEqual(["c-second"]);
    expect(root.querySelector(".toast.flash")?.textContent).toBe("Already answered: Approved. This answer was not sent.");
    expect(readOutbox()).toEqual([]);
    expect(app.replies.get("a")?.clientId).toBe("c-first");
    expect(topId()).toBe("b");
    expect(root.querySelector(".card-error")).toBeNull();
  });

  it("a send from before a sign-out that answers late leaves the new session's held answer alone", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    let release!: () => void;
    lateGate = new Promise((resolve) => (release = resolve));
    replyPlan = ["late"];
    key("keydown", "a");
    await settle(TAP_LOCK_MS);
    flushHeld();
    await settle(0);
    expect(posts).toHaveLength(1);
    signOut();
    await signIn();
    expect(topId()).toBe("a");
    key("keydown", "x");
    rejectWhy();
    expect(app.held.has("a")).toBe(true);
    release();
    await settle(0);
    expect(app.held.has("a")).toBe(true);
    expect(root.querySelector(".card-error")).toBeNull();
  });

  it("an answer sent while an older read is in flight stays answered when that read lands", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    let release!: () => void;
    listGate = new Promise((resolve) => (release = resolve));
    const stale = poll();
    listGate = null;
    key("keydown", "a");
    await settle(TAP_LOCK_MS);
    flushHeld();
    await settle(0);
    expect(app.replies.get("a")?.rev).toBe("a1");
    // The server has it now; the read asked before it does not.
    replies = [app.replies.get("a")!];
    release();
    await stale;
    expect(app.replies.get("a")?.rev).toBe("a1");
    expect(topId()).toBe("b");
    await poll();
    expect(topId()).toBe("b");
  });

  it("an answer that landed stays answered when a later read, of the latest 200 only, no longer lists it", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    key("keydown", "a");
    await settle(TAP_LOCK_MS);
    flushHeld();
    await settle(0);
    replies = [];
    await poll();
    await poll();
    expect(app.replies.get("a")?.rev).toBe("a1");
    expect(topId()).toBe("b");
  });

  it("a confirmed answer leaves another tab's pending answer to the same card alone", async () => {
    needs = [need("a", "a1")];
    await signIn();
    remember({ clientId: "other-tab", itemId: "a", decision: "reject", rev: "a1", title: "Card a" });
    key("keydown", "a");
    await settle(TAP_LOCK_MS);
    flushHeld();
    await settle(0);
    expect(posts).toHaveLength(1);
    expect(readOutbox().map((entry) => entry.clientId)).toEqual(["other-tab"]);
  });
});

describe("card media", () => {
  const clip = (c: string) => ({ sha256: c.repeat(64), type: "video/mp4" as const });

  it("puts the title, then the ask, then the meta line above the clip, so the card says what it asks first", async () => {
    needs = [{ ...need("a", "a1"), chat: "chat-a", pr: 12, media: { kind: "before-after", before: clip("a"), after: clip("b") } }];
    await signIn();
    const card = root.querySelector<HTMLElement>(".card.top")!;
    const body = card.querySelector<HTMLElement>(".card-body")!;
    expect(body.classList.contains("with-media")).toBe(true);
    const order = [...body.children].map((child) => child.className.split(" ")[0]);
    expect(order.slice(0, 4)).toEqual(["card-title", "card-ask", "card-meta", "card-media"]);
    const controls = [...body.querySelectorAll(".media-controls > *")].map((child) => child.className);
    // The card's one Share sends the clip (card-share.ts), so the clip has no Share or Download of its own.
    expect(controls).toEqual(["btn media-play", "media-scrub"]);
    expect([...body.querySelectorAll(".media-panes > .media-corner > *")].map((child) => child.className)).toEqual(["btn media-sound", "btn media-full"]);
    expect([...body.querySelectorAll(".media-panes > .media-toggles > *")].map((child) => child.textContent)).toEqual(["Before", "After"]);
  });

  it("takes the clip's own shape once it loads, the poster's until then, 16:9 before either", async () => {
    const images: { img: HTMLImageElement; src: string }[] = [];
    vi.spyOn(window, "Image").mockImplementation(function () {
      const img = document.createElement("img");
      Object.defineProperty(img, "src", { set: (src: string) => images.push({ img, src }) });
      return img;
    } as unknown as () => HTMLImageElement);
    const poster = { sha256: "p".repeat(64), type: "image/jpeg" as const };
    needs = [
      { ...need("a", "a1"), media: { kind: "video", after: clip("a") } },
      { ...need("b", "b1"), media: { kind: "video", after: clip("b"), poster } },
    ];
    await signIn();
    const media = root.querySelector<HTMLElement>(".card.top .card-media")!;
    const video = media.querySelector("video")!;
    expect(media.style.getPropertyValue("--ratio")).toBe("");
    Object.defineProperties(video, { videoWidth: { value: 540 }, videoHeight: { value: 960 } });
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(media.style.getPropertyValue("--ratio")).toBe("0.5625");

    showCard("b");
    await settle();
    const next = root.querySelector<HTMLElement>(".card.top .card-media")!;
    const shot = images.find((image) => image.src === `/media/${poster.sha256}`)!;
    Object.defineProperties(shot.img, { naturalWidth: { value: 1280 }, naturalHeight: { value: 720 } });
    shot.img.dispatchEvent(new Event("load"));
    expect(next.style.getPropertyValue("--ratio")).toBe("1.7778");
    const clipB = next.querySelector("video")!;
    Object.defineProperties(clipB, { videoWidth: { value: 1080 }, videoHeight: { value: 1080 } });
    clipB.dispatchEvent(new Event("loadedmetadata"));
    expect(next.style.getPropertyValue("--ratio")).toBe("1.0000");
  });

  it("on a phone shows one clip of a pair at full width, its Before/After toggle over the clip; side by side only on a wide screen", async () => {
    const { readFileSync } = await import("node:fs");
    needs = [{ ...need("a", "a1"), media: { kind: "before-after", before: clip("a"), after: clip("b") } }];
    await signIn();
    const media = root.querySelector<HTMLElement>(".card.top .card-media")!;
    expect(media.classList.contains("show-after")).toBe(true);
    const toggles = [...media.querySelectorAll<HTMLButtonElement>(".media-panes > .media-toggles .media-toggle")];
    toggles[0]!.click();
    expect(media.classList.contains("show-before")).toBe(true);
    expect(toggles.map((t) => t.getAttribute("aria-pressed"))).toEqual(["true", "false"]);

    const css = readFileSync("web/src/views/command.css", "utf8");
    const phone = css.slice(css.indexOf("@media (max-width: 759px)"), css.indexOf("@media (min-width: 760px)"));
    const wide = css.slice(css.indexOf("@media (min-width: 760px)"));
    expect(phone).not.toMatch(/grid-template-columns/);
    // At most half the screen tall on a phone, so the title and the ask stay above it on a small phone.
    expect(phone).toMatch(/\.media-clip \{\s*max-height: 50dvh;/);
    expect(phone).not.toMatch(/min-height:\s*(?:[0-3]\d|4[0-3])px/);
    expect(wide).toMatch(/\.card-media\.pair \.media-panes \{[^}]*grid-template-columns: 1fr 1fr/);
    expect(css).toMatch(/\.media-clip \{[^}]*width: 100%;[^}]*aspect-ratio: var\(--ratio, 1\.7778\)/);
    expect(css).toMatch(/\.media-panes \{[^}]*width: min\(100%, calc\(70dvh \* var\(--ratio, 1\.7778\)\)\)/);
  });

  it("gives each clip of a pair its own shape, and the one showing sets the block", async () => {
    needs = [{ ...need("a", "a1"), media: { kind: "before-after", before: clip("a"), after: clip("b") } }];
    await signIn();
    const media = root.querySelector<HTMLElement>(".card.top .card-media")!;
    const [before, after] = [...media.querySelectorAll("video")] as [HTMLVideoElement, HTMLVideoElement];
    const pane = (which: string) => media.querySelector<HTMLElement>(`.media-pane.${which}`)!.style.getPropertyValue("--ratio");
    Object.defineProperties(before, { videoWidth: { value: 540 }, videoHeight: { value: 960 } });
    Object.defineProperties(after, { videoWidth: { value: 960 }, videoHeight: { value: 540 } });
    before.dispatchEvent(new Event("loadedmetadata"));
    expect(media.style.getPropertyValue("--ratio")).toBe("");
    after.dispatchEvent(new Event("loadedmetadata"));
    expect([pane("before"), pane("after"), media.style.getPropertyValue("--ratio")]).toEqual(["0.5625", "1.7778", "1.7778"]);

    const [showBefore, showAfter] = [...media.querySelectorAll<HTMLButtonElement>(".media-toggle")];
    showBefore!.click();
    expect(media.style.getPropertyValue("--ratio")).toBe("0.5625");
    showAfter!.click();
    expect(media.style.getPropertyValue("--ratio")).toBe("1.7778");
  });

  it("moves the Before/After toggle under a clip too narrow for it and the corner buttons, and back when there is room", async () => {
    const observed: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observed.push(callback);
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    needs = [{ ...need("a", "a1"), media: { kind: "before-after", before: clip("a"), after: clip("b") } }];
    await signIn();
    const media = root.querySelector<HTMLElement>(".card.top .card-media")!;
    const panes = media.querySelector<HTMLElement>(".media-panes")!;
    const toggles = media.querySelector<HTMLElement>(".media-toggles")!;
    const corner = media.querySelector<HTMLElement>(".media-corner")!;
    const resizes: Event[] = [];
    media.addEventListener("media-resized", (event) => resizes.push(event));
    Object.defineProperty(toggles, "offsetWidth", { configurable: true, value: 148 });
    Object.defineProperty(corner, "offsetWidth", { configurable: true, value: 48 });
    const resize = (width: number) => {
      Object.defineProperty(panes, "clientWidth", { configurable: true, value: width });
      for (const callback of observed) callback();
    };

    // A 9:16 clip at 70% of a landscape phone's 320 px height is 126 px wide.
    resize(126);
    expect(toggles.parentElement).toBe(media);
    expect(toggles.previousElementSibling).toBe(panes);
    expect(resizes).toHaveLength(1);
    resize(220);
    expect(toggles.parentElement).toBe(panes);
    expect(toggles.nextElementSibling).toBe(corner);
    expect(resizes).toHaveLength(2);
    resize(300);
    expect(resizes).toHaveLength(2);

    const { readFileSync } = await import("node:fs");
    const css = readFileSync("web/src/views/command.css", "utf8");
    expect(css).toMatch(/\.card-media > \.media-toggles \{[^}]*position: static;/);
    expect(css).toMatch(/\.media-toggle \{[^}]*min-height: 44px;/);
  });

  it("a clip whose shape is not known yet shows at 16:9, not its partner's shape", async () => {
    needs = [{ ...need("a", "a1"), media: { kind: "before-after", before: clip("a"), after: clip("b") } }];
    await signIn();
    const media = root.querySelector<HTMLElement>(".card.top .card-media")!;
    const after = media.querySelectorAll("video")[1]!;
    Object.defineProperty(after, "videoWidth", { configurable: true, value: 540 });
    Object.defineProperty(after, "videoHeight", { configurable: true, value: 960 });
    after.dispatchEvent(new Event("loadedmetadata"));
    expect(media.style.getPropertyValue("--ratio")).toBe("0.5625");
    media.querySelector<HTMLButtonElement>(".media-toggle")!.click();
    expect(media.style.getPropertyValue("--ratio")).toBe("");
  });

  it("re-checks a card's scrolling when it is resized, as on a rotation", async () => {
    const observed: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observed.push(callback);
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    needs = [{ ...need("a", "a1"), media: { kind: "video", after: clip("a") } }];
    await signIn();
    const body = root.querySelector<HTMLElement>(".card.top .card-body")!;
    Object.defineProperty(body, "scrollHeight", { configurable: true, value: 900 });
    Object.defineProperty(body, "clientHeight", { configurable: true, value: 300 });
    for (const callback of observed) callback();
  });

  it("a tap on a clip never opens full screen; the Full screen button opens the one showing", async () => {
    const opened: Element[] = [];
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value(this: Element) {
        opened.push(this);
        return Promise.resolve();
      },
    });
    try {
      needs = [{ ...need("a", "a1"), media: { kind: "before-after", before: clip("a"), after: clip("b") } }];
      await signIn();
      const media = root.querySelector<HTMLElement>(".card.top .card-media")!;
      const [before, after] = [...media.querySelectorAll("video")];
      after!.click();
      expect(opened).toEqual([]);
      media.querySelector<HTMLButtonElement>(".media-full")!.click();
      expect(opened).toEqual([after]);
      media.querySelector<HTMLButtonElement>(".media-toggle")!.click();
      before!.click();
      media.querySelector<HTMLButtonElement>(".media-full")!.click();
      expect(opened).toEqual([after, before]);
      expect(posts).toHaveLength(0);
    } finally {
      delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
    }
  });
});

describe("card sound", () => {
  const clip = (c: string) => ({ sha256: c.repeat(64), type: "video/mp4" as const });
  const voice = (c: string, label?: string) => ({ sha256: c.repeat(64), type: "audio/mpeg" as const, ...(label ? { label } : {}) });

  /** happy-dom has no media pipeline: play and pause just fire their events. */
  function fakePlayback(): { played: HTMLMediaElement[]; paused: HTMLMediaElement[] } {
    const log = { played: [] as HTMLMediaElement[], paused: [] as HTMLMediaElement[] };
    const state = new WeakMap<HTMLMediaElement, boolean>();
    vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) {
      return state.get(this) ?? true;
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
      state.set(this, false);
      log.played.push(this);
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
      if (state.get(this) === false) {
        state.set(this, true);
        log.paused.push(this);
        this.dispatchEvent(new Event("pause"));
      }
    });
    return log;
  }

  it("clips load muted; Play turns the sound on for the clip showing only, and the speaker mutes it", async () => {
    fakePlayback();
    needs = [{ ...need("a", "a1"), media: { kind: "before-after", before: clip("a"), after: clip("b") } }];
    await signIn();
    const media = root.querySelector<HTMLElement>(".card.top .card-media")!;
    const [before, after] = [...media.querySelectorAll("video")];
    const speaker = media.querySelector<HTMLButtonElement>(".media-sound")!;
    expect([before!.muted, after!.muted]).toEqual([true, true]);
    expect(speaker.getAttribute("aria-label")).toBe("Turn the sound on");
    media.querySelector<HTMLButtonElement>(".media-play")!.click();
    expect([before!.muted, after!.muted]).toEqual([true, false]);
    expect(speaker.getAttribute("aria-pressed")).toBe("true");
    expect(speaker.getAttribute("aria-label")).toBe("Mute");
    [...media.querySelectorAll<HTMLButtonElement>(".media-toggle")].find((b) => b.textContent === "Before")!.click();
    await settle(0);
    expect([before!.muted, after!.muted]).toEqual([false, true]);
    speaker.click();
    expect([before!.muted, after!.muted]).toEqual([true, true]);
    expect(speaker.getAttribute("aria-label")).toBe("Turn the sound on");
    speaker.click();
    expect([before!.muted, after!.muted]).toEqual([false, true]);
  });

  it("a tap on a clip plays it inline with sound, a tap while it is heard pauses it, and Share stays in reach", async () => {
    const log = fakePlayback();
    needs = [{ ...need("a", "a1"), media: { kind: "before-after", before: clip("a"), after: clip("b") } }];
    await signIn();
    const media = root.querySelector<HTMLElement>(".card.top .card-media")!;
    const [before, after] = [...media.querySelectorAll("video")];
    after!.click();
    expect(log.played).toEqual([before, after]);
    expect([before!.muted, after!.muted]).toEqual([true, false]);
    expect(media.querySelector(".media-play")!.getAttribute("aria-label")).toBe("Pause");
    after!.click();
    expect(log.paused).toEqual([before, after]);
    expect(media.querySelector(".media-play")!.getAttribute("aria-label")).toBe("Play");
  });

  it("a tap on the clip heard pauses it even when its partner never started", async () => {
    const log = fakePlayback();
    needs = [{ ...need("a", "a1"), media: { kind: "before-after", before: clip("a"), after: clip("b") } }];
    await signIn();
    const media = root.querySelector<HTMLElement>(".card.top .card-media")!;
    const [before, after] = [...media.querySelectorAll("video")];
    after!.click();
    // Before failed to play: it is paused while After plays aloud.
    before!.pause();
    after!.click();
    expect(log.paused).toContain(after);
    expect(after!.paused).toBe(true);
  });

  it("a tap on a clip playing silently on its own turns its sound on without restarting it", async () => {
    const log = fakePlayback();
    needs = [{ ...need("a", "a1"), media: { kind: "video", after: clip("b") } }];
    await signIn();
    const media = root.querySelector<HTMLElement>(".card.top .card-media")!;
    const video = media.querySelector("video")!;
    void video.play();
    log.played.length = 0;
    video.click();
    expect(log.played).toEqual([]);
    expect(log.paused).toEqual([]);
    expect(video.muted).toBe(false);
  });

  it("an audio card has a labelled player per clip, and one playing stops the others", async () => {
    const log = fakePlayback();
    needs = [{ ...need("a", "a1"), media: { kind: "audio", clips: [voice("a", "Onyx"), voice("b", "Echo"), voice("c")] } }];
    await signIn();
    const media = root.querySelector<HTMLElement>(".card.top .card-media")!;
    const rows = [...media.querySelectorAll<HTMLElement>(".media-audio-row")];
    expect(rows.map((row) => row.querySelector(".media-audio-label")!.textContent)).toEqual(["Onyx", "Echo", "Clip 3"]);
    expect(rows.map((row) => row.querySelector("audio")!.getAttribute("src"))).toEqual(["a", "b", "c"].map((c) => `/media/${c.repeat(64)}`));
    const [onyx, echo] = rows.map((row) => row.querySelector<HTMLButtonElement>(".media-audio-play")!);
    onyx!.click();
    expect(onyx!.getAttribute("aria-label")).toBe("Pause Onyx");
    echo!.click();
    expect(log.paused).toEqual([rows[0]!.querySelector("audio")]);
    expect(onyx!.getAttribute("aria-label")).toBe("Play Onyx");
    expect(echo!.getAttribute("aria-label")).toBe("Pause Echo");
    echo!.click();
    expect(echo!.getAttribute("aria-label")).toBe("Play Echo");
  });

  describe("in full screen", () => {
    function fullScreen(video: HTMLVideoElement | null): void {
      const was = document.fullscreenElement;
      Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => video });
      (video ?? was)!.dispatchEvent(new Event("fullscreenchange", { bubbles: true }));
    }
    afterEach(() => {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => null });
    });

    it("the arrow keys answer nothing", async () => {
      needs = [{ ...need("a", "a1"), media: { kind: "video", after: clip("a") } }, need("b", "b1")];
      await signIn();
      fullScreen(root.querySelector("video"));
      key("keydown", "a");
      key("keyup", "a");
      key("keydown", "x");
      await settle(TAP_LOCK_MS);
      flushHeld();
      await settle(0);
      expect(posts).toHaveLength(0);
      expect(topId()).toBe("a");
    });

    it("a poll leaves the clip where it is and the feed catches up when full screen ends", async () => {
      needs = [{ ...need("a", "a1"), media: { kind: "video", after: clip("a") } }];
      await signIn();
      const card = root.querySelector<HTMLElement>(".card.top")!;
      const video = card.querySelector("video")!;
      const moves: MutationRecord[] = [];
      new MutationObserver((records) => moves.push(...records)).observe(root, { childList: true, subtree: true });
      fullScreen(video);
      needs = [{ ...needs[0]!, ask: "Changed" }, need("b", "b1")];
      await poll();
      await settle(0);
      expect(moves.some((record) => [...record.removedNodes].some((node) => node.contains(video)))).toBe(false);
      expect(root.querySelector(".card.top")).toBe(card);

      fullScreen(null);
      await settle(0);
      expect(root.querySelector(".card.top")).not.toBe(card);
      expect(root.querySelector(".card.top .card-ask")!.textContent).toBe("Changed");
      expect(root.querySelector(".card.top video")).toBe(video);
    });

    it("one clip of a pair plays alone, keeps its seek, and the other catches up on exit", async () => {
      fakePlayback();
      needs = [{ ...need("a", "a1"), media: { kind: "before-after", before: clip("a"), after: clip("b") } }];
      await signIn();
      const media = root.querySelector<HTMLElement>(".card.top .card-media")!;
      const [before, after] = [...media.querySelectorAll("video")] as [HTMLVideoElement, HTMLVideoElement];
      media.querySelector<HTMLButtonElement>(".media-play")!.click();
      expect([before.paused, after.paused]).toEqual([false, false]);

      fullScreen(after);
      expect([before.paused, after.paused]).toEqual([true, false]);
      expect([before.controls, after.controls]).toEqual([false, true]);
      after.currentTime = 7;
      before.dispatchEvent(new Event("timeupdate"));
      expect(after.currentTime).toBe(7);

      fullScreen(null);
      expect(before.currentTime).toBe(7);
      expect([before.paused, after.paused]).toEqual([false, false]);
      expect(media.querySelector(".media-play")!.getAttribute("aria-label")).toBe("Pause");
      expect([before.controls, after.controls]).toEqual([false, false]);
    });

    it("a speed picked in full screen carries back to the pair, so the sync does not keep seeking", async () => {
      fakePlayback();
      needs = [{ ...need("a", "a1"), media: { kind: "before-after", before: clip("a"), after: clip("b") } }];
      await signIn();
      const media = root.querySelector<HTMLElement>(".card.top .card-media")!;
      const [before, after] = [...media.querySelectorAll("video")] as [HTMLVideoElement, HTMLVideoElement];
      media.querySelector<HTMLButtonElement>(".media-play")!.click();
      fullScreen(after);
      after.playbackRate = 2;
      after.currentTime = 3;
      fullScreen(null);
      expect([before.playbackRate, after.playbackRate]).toEqual([2, 2]);
      expect(before.currentTime).toBe(3);
      expect([before.paused, after.paused]).toEqual([false, false]);

      fullScreen(before);
      before.pause();
      fullScreen(null);
      expect([before.paused, after.paused]).toEqual([true, true]);
      expect(media.querySelector(".media-play")!.getAttribute("aria-label")).toBe("Play");
    });
  });

  describe("stops when its card leaves the screen", () => {
    const voiceCard = (id: string) => ({ ...need(id, `${id}1`), media: { kind: "audio" as const, clips: [voice(id)] } });
    const videoCard = (id: string) => ({ ...need(id, `${id}1`), media: { kind: "video" as const, after: clip(id) } });
    /** Starts the top card's voice note and clip; returns what is now playing. */
    function playTop(): HTMLMediaElement[] {
      const media = root.querySelector<HTMLElement>(".card.top .card-media")!;
      media.querySelector<HTMLButtonElement>(".media-audio-play")?.click();
      media.querySelector<HTMLButtonElement>(".media-play")?.click();
      const playing = [...media.querySelectorAll<HTMLMediaElement>("audio, video")];
      expect(playing.every((player) => !player.paused)).toBe(true);
      return playing;
    }

    it("on the next card, with or without media of its own", async () => {
      fakePlayback();
      needs = [voiceCard("a"), videoCard("b"), need("c", "c1"), need("d", "d1")];
      await signIn();
      const a = playTop();
      key("keydown", "a");
      key("keyup", "a");
      await settle();
      expect(topId()).toBe("b");
      expect(a.every((player) => player.paused)).toBe(true);
      // A new top card takes no taps until the tap lock passes.
      await settle(TAP_LOCK_MS);
      const b = playTop();
      key("keydown", "a");
      key("keyup", "a");
      await settle();
      expect(topId()).toBe("c");
      expect(b.every((player) => player.paused)).toBe(true);
    });

    it("when the last card is answered", async () => {
      fakePlayback();
      needs = [voiceCard("a")];
      await signIn();
      const a = playTop();
      key("keydown", "a");
      await settle(TAP_LOCK_MS);
      expect(root.querySelector(".clear")).not.toBeNull();
      expect(a.every((player) => player.paused)).toBe(true);
    });

    it("when the feed is left", async () => {
      fakePlayback();
      needs = [voiceCard("a")];
      await signIn();
      const a = playTop();
      app.tab = "chat";
      changed();
      expect(root.querySelector(".card")).toBeNull();
      expect(a.every((player) => player.paused)).toBe(true);
    });

    it("when the session ends", async () => {
      whenSignedOut(() => signOut());
      fakePlayback();
      needs = [voiceCard("a")];
      await signIn();
      const a = playTop();
      expired = true;
      await poll();
      expect(root.querySelector(".card")).toBeNull();
      expect(a.every((player) => player.paused)).toBe(true);
    });
  });
});

describe("card stills", () => {
  const still = (c: string) => ({ sha256: c.repeat(64), type: "image/png" as const });

  it("shows every screenshot in a strip, and a tap opens one full screen to step through and close", async () => {
    needs = [{ ...need("a", "a1"), media: { kind: "stills", stills: [still("a"), still("b"), still("c")] } }];
    await signIn();
    const card = root.querySelector<HTMLElement>(".card.top")!;
    expect(card.querySelector(".media-pane")).toBeNull();
    const thumbs = [...card.querySelectorAll<HTMLButtonElement>(".media-stills .media-still")];
    expect(thumbs.map((thumb) => thumb.querySelector("img")!.getAttribute("src"))).toEqual(["a", "b", "c"].map((c) => `/media/${c.repeat(64)}`));
    thumbs[1]!.click();
    const view = document.querySelector<HTMLElement>(".lightbox")!;
    const img = () => view.querySelector<HTMLImageElement>(".lightbox-img")!.getAttribute("src");
    expect(img()).toBe(`/media/${"b".repeat(64)}`);
    expect(view.querySelector(".lightbox-title")!.textContent).toBe("Screenshot 2 of 3");
    view.querySelector<HTMLButtonElement>("[aria-label='Next']")!.click();
    expect(img()).toBe(`/media/${"c".repeat(64)}`);
    key("keydown", "ArrowRight");
    expect(img()).toBe(`/media/${"a".repeat(64)}`);
    key("keydown", "ArrowLeft");
    expect(img()).toBe(`/media/${"c".repeat(64)}`);
    key("keyup", "ArrowLeft");
    key("keydown", "a");
    await settle(TAP_LOCK_MS);
    flushHeld();
    await settle(0);
    expect(posts).toHaveLength(0);
    expect(topId()).toBe("a");
    key("keydown", "Escape");
    expect(document.querySelector(".lightbox")).toBeNull();
    thumbs[0]!.click();
    document.querySelector<HTMLButtonElement>(".lightbox-close")!.click();
    expect(document.querySelector(".lightbox")).toBeNull();
  });

  it("the viewer and its keys go when the session ends", async () => {
    whenSignedOut(() => signOut());
    const adds = vi.spyOn(document, "addEventListener");
    const removes = vi.spyOn(document, "removeEventListener");
    needs = [{ ...need("a", "a1"), media: { kind: "stills", stills: [still("a"), still("b")] } }];
    await signIn();
    adds.mockClear();
    root.querySelector<HTMLButtonElement>(".media-still")!.click();
    const onKey = adds.mock.calls.find(([type]) => type === "keydown")![1];
    expect(document.querySelector(".lightbox")).not.toBeNull();

    expired = true;
    await poll();
    expect(document.querySelector(".lightbox")).toBeNull();
    expect(removes.mock.calls.some(([type, handler]) => type === "keydown" && handler === onKey)).toBe(true);
    expect(document.body.children).toHaveLength(1);
  });

  it("sit under the clips on a before/after card", async () => {
    const clip = (c: string) => ({ sha256: c.repeat(64), type: "video/mp4" as const });
    needs = [{ ...need("a", "a1"), media: { kind: "before-after", before: clip("a"), after: clip("b"), stills: [still("c")] } }];
    await signIn();
    const media = root.querySelector<HTMLElement>(".card.top .card-media")!;
    expect([...media.children].map((child) => child.className)).toEqual(["media-panes", "media-controls", "media-stills"]);
  });
});

describe("sharing a card's clips and pictures", () => {
  const clip = (c: string) => ({ sha256: c.repeat(64), type: "video/mp4" as const });
  const still = (c: string) => ({ sha256: c.repeat(64), type: "image/png" as const });
  const BYTES = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
  let shared: File[];
  let canShare: boolean;
  /** How the next navigator.share calls end, in order; missing entries succeed. */
  let sharePlan: string[];
  let failNext: boolean;
  /** Set, the next media fetch waits until its release is called. */
  let holdNext: (() => void)[] | null;
  const mediaFetches = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input).startsWith("/media/"));

  beforeEach(() => {
    shared = [];
    canShare = true;
    sharePlan = [];
    failNext = false;
    holdNext = null;
    Object.defineProperty(navigator, "canShare", { configurable: true, value: (data: { files?: File[] }) => canShare && Boolean(data.files?.length) });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: vi.fn((data: { files: File[] }) => {
        shared.push(...data.files);
        const outcome = sharePlan.shift();
        return outcome ? Promise.reject(new DOMException("share", outcome)) : Promise.resolve();
      }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (!path.startsWith("/media/")) return fakeFetch(input, init);
        const type = path.startsWith(`/media/${"c"}`) || path.startsWith(`/media/${"d"}`) ? "image/png" : path.startsWith(`/media/${"e"}`) ? "audio/mpeg" : "video/mp4";
        if (failNext) {
          failNext = false;
          return Promise.resolve(json({ error: "no such media" }, 404));
        }
        if (holdNext) {
          const held = holdNext;
          holdNext = null;
          return new Promise<Response>((resolve) => held.push(() => resolve(new Response(BYTES, { headers: { "content-type": type } }))));
        }
        return Promise.resolve(new Response(BYTES, { headers: { "content-type": type } }));
      }),
    );
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "canShare");
    Reflect.deleteProperty(navigator, "share");
  });

  it("the viewer's Share clears its own failure once a retry works, and leaves the viewer's notes alone", async () => {
    needs = [{ ...need("a", "a1"), media: { kind: "stills", stills: [still("c")] } }];
    await signIn();
    root.querySelector<HTMLButtonElement>(".card.top .media-still")!.click();
    const view = document.querySelector<HTMLElement>(".lightbox")!;
    const note = view.querySelector<HTMLElement>(".lightbox-note")!;
    const share = view.querySelector<HTMLButtonElement>(".lightbox-bar .media-share")!;
    failNext = true;
    share.click();
    await settle(0);
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe("That file is no longer on the server.");
    share.click();
    await settle(0);
    expect(shared).toHaveLength(1);
    expect(note.hidden).toBe(true);
    // A Share failure, then the image itself failing: the retry puts the image's failure back, not a blank viewer.
    sharePlan = ["DataError"];
    share.click();
    await settle(0);
    expect(note.textContent).toBe("Could not share the picture. Download saves it instead.");
    view.querySelector(".lightbox-img")!.dispatchEvent(new Event("error"));
    expect(note.textContent).toBe("Could not load the image.");
    share.click();
    await settle(0);
    expect(shared).toHaveLength(3);
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe("Could not load the image.");
    view.querySelector<HTMLButtonElement>(".lightbox-close")!.click();
  });

  it("a picture that loads after its deadline is not reported broken again by a Share retry", async () => {
    needs = [{ ...need("a", "a1"), media: { kind: "stills", stills: [still("c")] } }];
    await signIn();
    root.querySelector<HTMLButtonElement>(".card.top .media-still")!.click();
    const view = document.querySelector<HTMLElement>(".lightbox")!;
    const note = view.querySelector<HTMLElement>(".lightbox-note")!;
    const share = view.querySelector<HTMLButtonElement>(".lightbox-bar .media-share")!;
    const img = view.querySelector<HTMLImageElement>(".lightbox-img")!;
    // Past its deadline the viewer calls it broken; then it comes after all.
    img.dispatchEvent(new Event("error"));
    expect(note.textContent).toBe("Could not load the image.");
    img.dispatchEvent(new Event("load"));
    expect(note.hidden).toBe(true);
    sharePlan = ["DataError"];
    share.click();
    await settle(0);
    expect(note.textContent).toBe("Could not share the picture. Download saves it instead.");
    share.click();
    await settle(0);
    expect(shared).toHaveLength(2);
    expect(note.hidden).toBe(true);
    view.querySelector<HTMLButtonElement>(".lightbox-close")!.click();
  });

  it("the screenshot viewer's Share hands on the screenshot showing", async () => {
    needs = [{ ...need("a", "a1"), media: { kind: "stills", stills: [still("c"), still("d")] } }];
    await signIn();
    root.querySelectorAll<HTMLButtonElement>(".card.top .media-still")[1]!.click();
    const view = document.querySelector<HTMLElement>(".lightbox")!;
    const share = view.querySelector<HTMLButtonElement>(".lightbox-bar .media-share")!;
    share.click();
    await settle(0);
    expect(shared.map((file) => [file.name, file.type])).toEqual([["card-a-screenshot-2.png", "image/png"]]);
    view.querySelector<HTMLButtonElement>("[aria-label='Next']")!.click();
    share.click();
    await settle(0);
    expect(shared.map((file) => file.name)).toEqual(["card-a-screenshot-2.png", "card-a-screenshot-1.png"]);
    expect(mediaFetches().map(([input]) => String(input))).toEqual([`/media/${"d".repeat(64)}`, `/media/${"c".repeat(64)}`]);
    view.querySelector<HTMLButtonElement>(".lightbox-close")!.click();
  });
});

describe("card PDFs", () => {
  const SHA = "e".repeat(64);
  const paper = { sha256: SHA, type: "application/pdf" as const, name: "White paper.pdf", bytes: 2_516_582 };
  const PDF_BYTES = new TextEncoder().encode("%PDF-1.7 white paper");
  let shared: File[];
  /** How each navigator.share call ends, in order; missing entries succeed. */
  let sharePlan: string[];
  let canShare: boolean;
  let pdfStatus: number;
  /** Set, the next PDF fetch answers with this instead of the PDF. */
  let pdfAnswer: (() => Promise<Response>) | null;

  const openButton = () => root.querySelector<HTMLButtonElement>(".card.top .media-file")!;
  const button = () => root.querySelector<HTMLButtonElement>(".card.top .media-share")!;
  const label = () => button().querySelector(".media-share-label")!.textContent;
  const note = () => root.querySelector<HTMLElement>(".card.top .media-file-note")!;
  const pdfFetches = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === `/media/${SHA}`);

  beforeEach(() => {
    shared = [];
    sharePlan = [];
    canShare = true;
    pdfStatus = 200;
    pdfAnswer = null;
    Object.defineProperty(navigator, "canShare", { configurable: true, value: (data: { files?: File[] }) => canShare && Boolean(data.files?.length) });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: vi.fn((data: { files: File[] }) => {
        shared.push(...data.files);
        const outcome = sharePlan.shift();
        return outcome ? Promise.reject(new DOMException("share", outcome)) : Promise.resolve();
      }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === `/media/${SHA}`
          ? pdfAnswer
            ? pdfAnswer()
            : Promise.resolve(pdfStatus === 200 ? new Response(PDF_BYTES, { headers: { "content-type": "application/pdf" } }) : json({ error: "no such media" }, pdfStatus))
          : fakeFetch(input, init),
      ),
    );
    needs = [{ ...need("a", "a1"), media: { kind: "files", files: [paper] } }];
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "canShare");
    Reflect.deleteProperty(navigator, "share");
  });

  it("a PDF the viewer cannot get says why inside the viewer", async () => {
    pdfStatus = 404;
    await signIn();
    openButton().click();
    await settle(0);
    expect(document.querySelector(".lightbox-note")!.textContent).toBe("That PDF is no longer on the server.");
    document.querySelector<HTMLButtonElement>(".lightbox-close")!.click();
    expect(document.querySelector(".lightbox")).toBeNull();
  });
});

describe("the crew on the feed", () => {
  const worker = (chat: string, state: Worker["state"]): Worker => ({ id: `w-${chat}`, name: chat, repo: "example-org/example-repo", chat, state, lastOutputAt: null });

  it("puts the card's conversation and round on its top line, and opens the conversation from it", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    cardLinks = [{ card: "a", thread: "t-quiz", title: "Quiz app pace", round: 3 }];
    await signIn();
    const line = root.querySelector<HTMLButtonElement>(".card.top .card-head .card-thread")!;
    expect(line.textContent).toBe("Round 3 · Quiz app pace");
    line.click();
    expect(app.tab).toBe("chat");
    await settle();
    expect(openConversation()).toBe("t-quiz");
    expect(document.querySelector(".rivet-sheet .thing-title")!.textContent).toBe("Quiz app pace");
    // A card in no thread shows nothing there.
    needs = [need("b", "b1")];
    await signIn();
    expect(topId()).toBe("b");
    expect(root.querySelector(".card.top .card-thread")).toBeNull();
  });

  it("a card with a chat has a Message button that opens that chat's send box", async () => {
    workers = [worker("chat-a", "working")];
    needs = [{ ...need("a", "a1"), chat: "chat-a" }, need("b", "b1")];
    await signIn();
    const message = root.querySelector<HTMLButtonElement>(".card.top .card-message")!;
    expect(message.textContent).toBe("Message Rivet");
    message.click();
    const sheet = document.querySelector<HTMLElement>(".cmd-worker-sheet")!;
    expect(sheet.getAttribute("aria-label")).toBe("chat-a");
    expect(sheet.querySelector(".cmd-send .cmd-h")!.textContent).toBe("Message Rivet about chat-a");
    sheet.querySelector<HTMLElement>(".cmd-log")!.focus();
    key("keydown", "a");
    key("keyup", "a");
    key("keydown", "x");
    await settle(TAP_LOCK_MS);
    flushHeld();
    await settle(0);
    expect(posts).toHaveLength(0);
    expect(topId()).toBe("a");
    signOut();
    expect(document.querySelector(".cmd-worker-sheet")).toBeNull();
  });
});

function pointer(target: Element, type: "pointerdown" | "pointermove" | "pointerup", x: number, y: number): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, pointerType: "touch", clientX: x, clientY: y }));
}

/** A finger down on `target`, moved by (dx, dy), lifted; `between` runs while it is down. The browser's click follows. */
function press(target: Element, dx = 0, dy = 0, between?: () => void): void {
  pointer(target, "pointerdown", 100, 100);
  if (dx || dy) pointer(target, "pointermove", 100 + dx, 100 + dy);
  between?.();
  pointer(target, "pointerup", 100 + dx, 100 + dy);
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
}

/** Types into the open card's say-line, as a thumb would. */
function say(text: string): void {
  const area = root.querySelector<HTMLTextAreaElement>(".actions .say-text")!;
  area.value = text;
  area.dispatchEvent(new Event("input"));
}

function actionButton(text: string): HTMLButtonElement {
  // The bar's buttons, then the card's own answer boxes (an option card's answers are its boxes).
  // Reject is the X at the card's top right, named by its title.
  const found = [...root.querySelectorAll<HTMLButtonElement>(".actions .btn, .card.top .btn.choice, .card.top .x-btn")].find(
    (element) => element.textContent?.includes(text) || element.title === text,
  );
  if (!found) throw new Error(`no ${text} button`);
  return found;
}

/** Opens a section from the rail, or on a phone, which has none, from the home screen: Progress is the bare home screen, More a menu page. */
function tab(label: string): void {
  if (label === "More") {
    if (!root.querySelector(".tabs .menu-row")) root.querySelector<HTMLButtonElement>(".menu-open")!.click();
    return document.querySelector<HTMLButtonElement>('.menu-row[data-key="media"]')!.click();
  }
  const onBar = [...root.querySelectorAll<HTMLButtonElement>(".tabs .tab, .tabs .menu-row")].find((element) => element.textContent?.includes(label));
  if (onBar) return onBar.click();
  if (label === "Progress") {
    if (app.tab === "cards") {
      app.tab = "progress";
      changed();
    } else closeTallSheet();
    return;
  }
  const key = ({ Cards: "decide", Chat: "rivet" } as Record<string, string>)[label];
  const button = key ? root.querySelector<HTMLButtonElement>(`.home-dock [data-key="${key}"]`) : null;
  if (!button) throw new Error(`no ${label} tab`);
  button.click();
}

describe("calm feed", () => {
  it("no swipe answers or skips a card, and there is no swipe hint", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    expect(root.querySelector(".deck-hint, .stamp")).toBeNull();
    const card = root.querySelector<HTMLElement>(".card.top")!;
    for (const [dx, dy] of [[260, 0], [-260, 0], [0, -320]] as const) {
      const title = root.querySelector(".card.top .card-title")!;
      pointer(title, "pointerdown", 100, 100);
      for (let step = 1; step <= 6; step++) pointer(title, "pointermove", 100 + (dx * step) / 6, 100 + (dy * step) / 6);
      pointer(title, "pointerup", 100 + dx, 100 + dy);
      title.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    }
    await settle(6000);
    flushHeld();
    await settle(0);
    expect(posts).toEqual([]);
    expect(topId()).toBe("a");
    expect(card.style.transform).toBe("");
    expect(root.querySelector(".toast.undo")).toBeNull();
  });

  it("a press that moves or scrolls before it lifts fires nothing; a clean tap does", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    press(actionButton("Approve"), 0, 14);
    press(actionButton("Reject"), 12, 0);
    press(actionButton("Approve"), 0, 0, () => root.querySelector(".card.top")!.dispatchEvent(new Event("scroll")));
    await settle(6000);
    expect(topId()).toBe("a");
    expect(root.querySelector(".toast.undo")).toBeNull();
    expect(posts).toEqual([]);

    press(actionButton("Approve"), 3, 4);
    expect(topId()).toBe("b");
    expect(root.querySelector(".toast.undo .toast-text strong")?.textContent).toBe("Approved");
  });

  it("Undo inside 5 s sends nothing and brings back the card for every kind of answer", async () => {
    needs = [
      need("a", "a1"),
      { ...need("m", "m1"), kind: "decision", options: [{ label: "Merge as is", short: "Merge" }, { label: "Change it" }] },
      { ...need("q", "q1", "What should change?"), kind: "question" },
    ];
    await signIn();
    const undo = async () => {
      await settle(4000);
      root.querySelector<HTMLButtonElement>(".toast.undo .undo-btn")!.click();
      await settle(0);
    };

    const small = () => root.querySelector(".card.top.minimised");
    for (const text of ["Approve", "Reject"]) {
      actionButton(text).click();
      if (text === "Reject") rejectWhy();
      expect(topId()).toBe("m");
      await undo();
      expect(topId()).toBe("a");
      expect(root.querySelector(".toast.undo")).toBeNull();
    }
    key("keydown", "l");
    key("keyup", "l");
    expect([topId(), small()]).toEqual(["m", null]);
    await undo();
    expect([topId(), small()]).toEqual(["a", null]);
    expect(root.querySelector(".toast.undo")).toBeNull();
    showCard("m");
    await settle(0);
    expect(topId()).toBe("m");

    actionButton("Merge").click();
    expect(topId()).not.toBe("m");
    await undo();
    expect(topId()).toBe("m");
    expect([...root.querySelectorAll<HTMLElement>(".card.top .btn.choice")].map((box) => box.dataset.key)).toEqual(["Merge as is", "Change it"]);

    showCard("q");
    await settle(0);
    expect(topId()).toBe("q");
    say("Slower camera");
    actionButton("Send answer").click();
    expect(topId()).not.toBe("q");
    await undo();
    expect(topId()).toBe("q");
    expect(root.querySelector<HTMLTextAreaElement>(".actions .say-text")?.value).toBe("Slower camera");

    await settle(10_000);
    flushHeld();
    await settle(0);
    expect(posts).toEqual([]);
  });

  it("sends an answer when its 5 s run out, and at once when the page is hidden", async () => {
    needs = [need("a", "a1"), { ...need("m", "m1"), kind: "decision", options: [{ label: "Merge as is", short: "Merge" }] }];
    await signIn();
    actionButton("Approve").click();
    await settle(4900);
    expect(posts).toEqual([]);
    await settle(200);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "a", decision: "approve", rev: "a1" }]);
    expect(root.querySelector(".toast.undo")).toBeNull();

    actionButton("Merge").click();
    await settle(1000);
    expect(posts).toHaveLength(1);
    // What main.ts does on visibilitychange to hidden and on pagehide.
    flushHeld();
    await settle(0);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "a" }, { itemId: "m", decision: "choice", choice: "Merge as is" }]);
    expect(posts[1]!.keepalive).toBe(true);
    expect(root.querySelector(".toast.undo")).toBeNull();
  });

  it("a double tap answers one card: the next card's buttons are locked, only for a moment", async () => {
    needs = [need("a", "a1"), need("b", "b1"), { ...need("m", "m1"), kind: "decision", options: [{ label: "Merge as is", short: "Merge" }, { label: "Change it" }] }];
    await signIn();
    press(actionButton("Approve"));
    await settle(150);
    expect(topId()).toBe("b");
    press(actionButton("Approve"));
    press(actionButton("Reject"));
    await settle(0);
    expect(topId()).toBe("b");
    expect(root.querySelector(".toast.undo .toast-title")?.textContent).toBe("Card a");

    await settle(TAP_LOCK_MS);
    // The first answer keeps its whole window: nothing is sent, and Undo still works near its end.
    await settle(4900 - 150 - TAP_LOCK_MS);
    expect(posts).toEqual([]);
    root.querySelector<HTMLButtonElement>(".toast.undo .undo-btn")!.click();
    await settle(0);
    expect(topId()).toBe("a");
    await settle(10_000);
    flushHeld();
    await settle(0);
    expect(posts).toEqual([]);

    // Option cards lock their picks the same way.
    actionButton("Approve").click();
    await settle(TAP_LOCK_MS + 50);
    actionButton("Approve").click();
    expect(topId()).toBe("m");
    press(actionButton("Merge"));
    await settle(0);
    expect(topId()).toBe("m");
    flushHeld();
    await settle(0);
    expect(posts.map((post) => post.body.itemId)).toEqual(["a", "b"]);
  });

  it("minimising the next card never cuts short the answer before it, and Undo walks back one at a time", async () => {
    needs = [need("a", "a1"), need("b", "b1"), need("c", "c1")];
    await signIn();
    const small = () => root.querySelector(".card.top.minimised");
    actionButton("Approve").click();
    await settle(2000);
    key("keydown", "l");
    key("keyup", "l");
    expect([topId(), small()]).toEqual(["c", null]);
    expect(root.querySelector(".toast.undo strong")?.textContent).toBe("Minimised");
    await settle(2900);
    expect(posts).toEqual([]);

    // Undo opens b in full again; a's toast comes back for the rest of its window.
    root.querySelector<HTMLButtonElement>(".toast.undo .undo-btn")!.click();
    await settle(0);
    expect([topId(), small()]).toEqual(["b", null]);
    expect(root.querySelector(".toast.undo .toast-title")?.textContent).toBe("Card a");
    await settle(200);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "a", decision: "approve" }]);
    expect(root.querySelector(".toast.undo")).toBeNull();
  });

  it("Reject asks why, opening with what the say-line holds, and sends those words once its Undo window ends", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    say("Move the bar above the chart");
    actionButton("Reject").click();
    expect(topId()).toBe("a");
    const why = document.querySelector<HTMLTextAreaElement>(".reject-sheet .sheet-text")!;
    expect(why.value).toBe("Move the bar above the chart");
    document.querySelector<HTMLButtonElement>(".reject-sheet .reject-send")!.click();
    expect(document.querySelector(".reject-sheet")).toBeNull();
    expect(topId()).toBe("b");
    expect(root.querySelector(".toast.undo strong")?.textContent).toBe("Rejected");
    await settle(4000);
    expect(posts).toEqual([]);
    root.querySelector<HTMLButtonElement>(".toast.undo .undo-btn")!.click();
    await settle(0);
    expect(topId()).toBe("a");
    expect(root.querySelector<HTMLTextAreaElement>(".actions .say-text")?.value).toBe("Move the bar above the chart");
    await settle(6000);
    flushHeld();
    await settle(0);
    expect(posts).toEqual([]);

    key("keydown", "x");
    document.querySelector<HTMLButtonElement>(".reject-sheet .reject-send")!.click();
    await settle(4900);
    expect(posts).toEqual([]);
    await settle(200);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "a", decision: "reject", rev: "a1", text: "Move the bar above the chart" }]);
  });

  it("a parked answer comes back with its note, so answering again after a lost reply reuses its clientId", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    say("Ship at noon");
    actionButton("Approve").click();
    await settle(1000);
    signOut();
    const parked = readOutbox();
    expect(parked).toMatchObject([{ itemId: "a", decision: "approve", text: "Ship at noon", parked: true }]);

    replyPlan = ["lost"];
    await signIn();
    await settle(0);
    expect(posts).toHaveLength(1);
    expect(topId()).toBe("a");
    expect(root.querySelector<HTMLTextAreaElement>(".actions .say-text")?.value).toBe("Ship at noon");

    actionButton("Approve").click();
    await settle(5100);
    expect(posts.map((post) => post.body)).toMatchObject([
      { itemId: "a", text: "Ship at noon", clientId: parked[0]!.clientId },
      { itemId: "a", decision: "approve", rev: "a1", text: "Ship at noon", clientId: parked[0]!.clientId },
    ]);
  });

  it("signing out inside the undo window keeps the answer and sends it after the next sign-in", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    actionButton("Reject").click();
    rejectWhy();
    await settle(1000);
    signOut();
    await settle(10_000);
    expect(posts).toEqual([]);
    const parked = readOutbox();
    expect(parked).toMatchObject([{ itemId: "a", decision: "reject", rev: "a1", parked: true }]);

    await signIn();
    await settle(0);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "a", decision: "reject", rev: "a1", clientId: parked[0]!.clientId }]);
    expect(readOutbox()).toEqual([]);
    expect(topId()).toBe("b");
    expect(root.querySelector(".card-error")).toBeNull();
  });

  it("an answer the server turns away for an ended session is kept and sent after the next sign-in", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    replyPlan = ["signin"];
    await signIn();
    actionButton("Approve").click();
    await settle(5100);
    expect(posts).toHaveLength(1);
    const parked = readOutbox();
    expect(parked).toMatchObject([{ itemId: "a", decision: "approve", clientId: posts[0]!.body.clientId, parked: true }]);

    signOut();
    await signIn();
    await settle(0);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "a" }, { itemId: "a", decision: "approve", rev: "a1", clientId: parked[0]!.clientId }]);
    expect(readOutbox()).toEqual([]);
    expect(topId()).toBe("b");
  });

  it("a parked answer to a reopened card that fails to send stays on the deck, over the earlier answer at the same revision", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    replies = [reply("a", "a1", "c-first")];
    await signIn();
    expect(topId()).toBe("b");
    showCard("a");
    expect(topId()).toBe("a");
    actionButton("Reject").click();
    rejectWhy();
    await settle(1000);
    signOut();
    const parked = readOutbox();
    expect(parked).toMatchObject([{ itemId: "a", decision: "reject", rev: "a1", parked: true }]);

    replyPlan = ["lost"];
    await signIn();
    await settle(0);
    expect(posts).toHaveLength(1);
    expect(topId()).toBe("a");
    expect(root.querySelector(".card.top .card-error")?.textContent).toContain("Not sent");
    await poll();
    expect(topId()).toBe("a");

    actionButton("Reject").click();
    rejectWhy();
    await settle(5100);
    expect(posts.map((post) => post.body)).toMatchObject([
      { itemId: "a", decision: "reject", clientId: parked[0]!.clientId },
      { itemId: "a", decision: "reject", rev: "a1", clientId: parked[0]!.clientId },
    ]);
    expect(readOutbox()).toEqual([]);
    expect(topId()).toBe("b");
  });

  it("a sheet opening mid-pull leaves the home screen at rest", async () => {
    needs = [need("a", "a1")];
    await signIn();
    tab("Progress");
    const view = root.querySelector<HTMLElement>("main.view")!;
    const touch = (type: string, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: [{ clientX: 100, clientY: y }] });
      root.querySelector(".home")!.dispatchEvent(event);
    };
    touch("touchstart", 100);
    touch("touchmove", 200);
    touch("touchmove", 300);
    expect(view.style.transform).not.toBe("");
    app.tab = "chat";
    changed();
    expect(view.style.transform).toBe("");
    expect(root.querySelector(".ptr")!.classList.contains("shown")).toBe(false);
  });

  it("pulling the home screen down re-fetches the board", async () => {
    needs = [need("a", "a1")];
    await signIn();
    tab("Progress");
    const boardLoads = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/board").length;
    const before = boardLoads();
    needs = [need("a", "a1"), need("b", "b1")];
    const view = root.querySelector<HTMLElement>("main.view")!;
    const touch = (type: string, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ clientX: 100, clientY: y }] });
      root.querySelector(".home")!.dispatchEvent(event);
    };
    touch("touchstart", 100);
    for (let y = 120; y <= 400; y += 40) touch("touchmove", y);
    touch("touchend", 400);
    await settle(600);
    expect(boardLoads()).toBeGreaterThan(before);
    expect(root.querySelector(".home-decide-n")?.textContent).toBe("2");
    expect(view.style.transform).toBe("");
  });
});

describe("voice typing", () => {
  class FakeRecognition {
    static made: FakeRecognition[] = [];
    lang = "";
    continuous = false;
    interimResults = false;
    onresult: ((event: { results: { transcript: string }[][] }) => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    listening = false;
    constructor() {
      FakeRecognition.made.push(this);
    }
    start() {
      this.listening = true;
    }
    abort() {
      this.listening = false;
    }
  }

  const hear = (text: string) => FakeRecognition.made.at(-1)!.onresult?.({ results: [[{ transcript: text }]] });

  beforeEach(() => {
    FakeRecognition.made = [];
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
  });

  it("dictates a comment, a Mix or tweak note and a question reply, and sends each only on Send", async () => {
    needs = [
      need("c", "c1"),
      { ...need("m", "m1"), kind: "decision", options: [{ label: "Ship it" }, { label: "Mix or tweak", text: true }] },
      { ...need("q", "q1", "What should change?"), kind: "question" },
    ];
    await signIn();
    // The say-line is on every card: its Send for a comment, the option itself, or a question's Send answer.
    const sends: [string, () => void][] = [
      ["c", () => root.querySelector<HTMLButtonElement>(".actions .say-send")!.click()],
      ["m", () => root.querySelector<HTMLButtonElement>('.card.top .btn.choice[data-key="Mix or tweak"]')!.click()],
      ["q", () => root.querySelector<HTMLButtonElement>(".actions .btn.pick")!.click()],
    ];
    for (const [id, send] of sends) {
      expect(topId()).toBe(id);
      const area = root.querySelector<HTMLTextAreaElement>(".actions .say-text")!;
      const mic = root.querySelector<HTMLButtonElement>(".actions .say-line .dictate-mic")!;
      expect(area.parentElement).toBe(mic.parentElement);
      mic.click();
      hear(`Spoken for ${id}`);
      expect(area.value).toBe(`Spoken for ${id}`);
      expect(cardState(id).text).toBe(`Spoken for ${id}`);
      // Edited before sending, and nothing leaves until Send.
      area.value += " please";
      area.dispatchEvent(new Event("input"));
      expect(mic.classList.contains("listening")).toBe(false);
      await settle(10_000);
      flushHeld();
      await settle(0);
      expect(posts.filter((post) => post.body.itemId === id)).toEqual([]);

      send();
      flushHeld();
      await settle(TAP_LOCK_MS + 50);
    }
    expect(posts.map((post) => post.body)).toMatchObject([
      { itemId: "c", decision: "comment", text: "Spoken for c please" },
      { itemId: "m", decision: "choice", choice: "Mix or tweak", text: "Spoken for m please" },
      { itemId: "q", decision: "comment", text: "Spoken for q please" },
    ]);
  });

  it("Send while listening stops the mic and sends what is in the box", async () => {
    needs = [need("c", "c1")];
    await signIn();
    root.querySelector<HTMLButtonElement>(".actions .say-line .dictate-mic")!.click();
    const recognition = FakeRecognition.made.at(-1)!;
    hear("Looks great");
    root.querySelector<HTMLButtonElement>(".actions .say-send")!.click();
    expect(recognition.listening).toBe(false);
    hear("Looks great and more");
    flushHeld();
    await settle(0);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "c", decision: "comment", text: "Looks great" }]);
  });

  it("the Message box a card opens has a mic too, and sends nothing by itself", async () => {
    needs = [{ ...need("a", "a1"), chat: "chat-a" }];
    await signIn();
    root.querySelector<HTMLButtonElement>(".card.top .card-message")!.click();
    const sheet = document.querySelector<HTMLElement>(".cmd-worker-sheet")!;
    const text = sheet.querySelector<HTMLTextAreaElement>(".cmd-send .cmd-text")!;
    sheet.querySelector<HTMLButtonElement>(".cmd-send .dictate-mic")!.click();
    hear("Try the bluer ice");
    expect(text.value).toBe("Try the bluer ice");
    await settle(10_000);
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url === "/api/actions/send" || url === "/api/chat")).toEqual([]);

    sheet.querySelector<HTMLButtonElement>(".cmd-send-row .btn.primary")!.click();
    expect(FakeRecognition.made.at(-1)!.listening).toBe(false);
    const send = vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/chat");
    expect(JSON.parse(String(send?.[1]?.body))).toMatchObject({ text: expect.stringMatching(/\(worker, chat chat-a\): Try the bluer ice$/) });
  });

  it("has no mic where the browser has no speech recognition", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
    stubCanvas();
    needs = [need("c", "c1")];
    await signIn();
    expect(root.querySelector(".actions .say-text")).not.toBeNull();
    expect(root.querySelector(".dictate-mic")).toBeNull();
  });
});

// Later is the "−", and minimise is kept on the server: every phone counts the same deck, and a phone's own Later and minimise lists from before go up once.
describe("minimise kept on the server", () => {
  // A phone has no Cards badge since the home screen; the app badge is its count that leaves a minimised card out.
  let badge = 0;
  const appBadge = vi.fn((n: number) => {
    badge = n;
    return Promise.resolve();
  });
  beforeEach(() => {
    badge = 0;
    appBadge.mockClear();
    Object.defineProperty(navigator, "setAppBadge", { value: appBadge, configurable: true });
    Object.defineProperty(navigator, "clearAppBadge", { value: () => Promise.resolve(void (badge = 0)), configurable: true });
  });
  const feedBadge = () => (badge ? String(badge) : null);

  it("a phone's own Later and minimise lists go up once as minimised, in place and out of both badges", async () => {
    needs = [need("a", "a1"), need("b", "b1"), need("c", "c1")];
    localStorage.setItem("rivet.later", JSON.stringify([["a", "a1"], ["gone", "g1"]]));
    localStorage.setItem("rivet.minimised", JSON.stringify([["c", "c1"]]));
    await signIn();
    await settle(0);
    expect(minimised).toEqual([["c", "c1"], ["a", "a1"], ["gone", "g1"]]);
    expect([localStorage.getItem("rivet.later"), localStorage.getItem("rivet.minimised")]).toEqual([null, null]);
    expect([topId(), root.querySelector(".card.top.minimised"), feedBadge()]).toEqual(["b", null, "1"]);
    expect(appBadge).toHaveBeenLastCalledWith(1);
    expect(root.querySelector(".later-group, .later-row")).toBeNull();
    // Sent once: a later sign-in sends nothing again.
    const puts = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).startsWith("/api/minimised/") && init?.method === "PUT").length;
    const sent = puts();
    signOut();
    await signIn();
    expect(puts()).toBe(sent);
    Reflect.deleteProperty(navigator, "setAppBadge");
  });

  it("drops each old entry from the phone once its send is answered, so a retry never minimises a card opened since", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    localStorage.setItem("rivet.later", JSON.stringify([["a", "a1"], ["b", "b1"]]));
    failing.add("/api/minimised/b");
    await signIn();
    await settle(0);
    expect(minimised).toEqual([["a", "a1"]]);
    expect(JSON.parse(localStorage.getItem("rivet.later") ?? "null")).toEqual([["b", "b1"]]);
  });

  it("drops an old entry from the phone as soon as its own send is answered, while another send still waits", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    localStorage.setItem("rivet.later", JSON.stringify([["a", "a1"], ["b", "b1"]]));
    minimiseStalls.add("b");
    await signIn();
    await settle(0);
    expect(minimised).toEqual([["a", "a1"]]);
    expect(JSON.parse(localStorage.getItem("rivet.later") ?? "null")).toEqual([["b", "b1"]]);
  });

  it("keeps a phone's own lists until the server answers, and never sends a card the server already holds", async () => {
    needs = [need("a", "a1"), need("c", "c2")];
    // Minimised again on another phone since: the server's revision is the newer.
    minimised = [["c", "c2"]];
    localStorage.setItem("rivet.later", JSON.stringify([["a", "a1"]]));
    localStorage.setItem("rivet.minimised", JSON.stringify([["c", "c1"]]));
    minimiseFails = true;
    await signIn();
    await settle(0);
    const sentKeys = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).startsWith("/api/minimised/") && init?.method === "PUT").map(([url]) => String(url));
    expect(sentKeys()).toEqual(["/api/minimised/a"]);
    expect(localStorage.getItem("rivet.later")).not.toBeNull();
    minimiseFails = false;
    signOut();
    await signIn();
    await settle(0);
    expect(minimised).toEqual([["c", "c2"], ["a", "a1"]]);
    expect([localStorage.getItem("rivet.later"), localStorage.getItem("rivet.minimised")]).toEqual([null, null]);
  });

  it("a card minimised on one phone is minimised and uncounted on another", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    minimised = [["a", "a1"]];
    await signIn();
    expect([topId(), feedBadge()]).toEqual(["b", "1"]);
    // Opened on the other phone: this one counts it again on its next read.
    minimised = [];
    await poll();
    expect([topId(), feedBadge()]).toEqual(["b", "2"]);
  });

  it("a minimise the server refuses puts the card back open and counted", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    minimiseFails = true;
    await signIn();
    root.querySelector<HTMLButtonElement>(".card.top .min-btn.top")!.click();
    await settle(0);
    expect([root.querySelector(".card.top.minimised"), feedBadge(), minimised]).toEqual([null, "2", []]);
  });
});

describe("the desktop layout", () => {
  const clip = (c: string) => ({ sha256: c.repeat(64), type: "video/mp4" as const });
  let wide = true;
  const press = async (name: string, init: KeyboardEventInit = {}) => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...init }));
    document.dispatchEvent(new KeyboardEvent("keyup", { key: name, bubbles: true, ...init }));
    await settle();
  };

  beforeEach(() => {
    wide = true;
    vi.spyOn(window, "matchMedia").mockImplementation(
      // Live, as a real MediaQueryList's is.
      (query: string) =>
        ({
          get matches() {
            return wide;
          },
          media: query,
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    );
    // Chat alongside is covered on its own; the rest keep it collapsed.
    localStorage.setItem("rivet.desk.layout", JSON.stringify({ chat: false }));
  });

  it("a cold open on a card's link opens that card, though the board loads after the screen is up", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    unmount?.();
    resetFeed();
    resetSession();
    app.front = "b";
    app.tab = "cards";
    unmount = mountShell(root);
    expect(app.front).toBe("b");
    await refresh();
    expect(topId()).toBe("b");
  });

  it("L minimises the open card, out of the red counts, with an Undo toast; Z opens it again and sends nothing", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    const counts = () => [root.querySelector('.decide-seg[data-seg="open"]')?.textContent];
    await press("l");
    expect(topId()).toBe("b");
    expect(counts()).toEqual([openTab(1)]);
    expect(root.querySelector(".toast.undo strong")?.textContent).toBe("Minimised");
    await press("z");
    expect(counts()).toEqual([openTab(2)]);
    expect(root.querySelector(".toast.undo")).toBeNull();
    await settle(5100);
    flushHeld();
    await settle(0);
    expect(posts).toEqual([]);
  });

  it("the last card's cheer ends on the home screen; Undo in the second left reopens the card", async () => {
    needs = [need("a", "a1")];
    await signIn();
    await press("a");
    expect(root.querySelector(".clear-title")?.textContent).toBe("You cleared them all!");
    expect(app.tab).toBe("cards");
    await settle(4000);
    expect(app.tab).toBe("progress");
    expect(root.querySelector('.view[data-tab="home"] .home')).not.toBeNull();
    expect(root.querySelector(".home-back")).toBeNull();
    root.querySelector<HTMLButtonElement>(".toast.undo .undo-btn")!.click();
    await settle(0);
    expect(app.tab).toBe("cards");
    expect(root.querySelector(".view.decide-pane .card.top")?.getAttribute("data-need")).toBe("a");
    expect(posts).toEqual([]);
  });

  it("a send that fails once the home screen is back opens Decide on its card again", async () => {
    needs = [need("a", "a1")];
    replyPlan = ["lost"];
    await signIn();
    await press("a");
    await settle(4000);
    expect(app.tab).toBe("progress");
    expect(posts).toEqual([]);
    await settle(1500);
    expect(posts).toHaveLength(1);
    expect(app.tab).toBe("cards");
    expect(root.querySelector(".view.decide-pane .card.top")?.getAttribute("data-need")).toBe("a");
    expect(root.querySelector(".view.decide-pane .card.top .card-error")?.textContent).toContain("Not sent");
    expect(root.querySelector(".toast.flash")?.textContent).toBe("Not sent. The card is back on top.");
  });

  it("on a phone, a failed send reopens the sheet on Open, not the Answered side it was closed on", async () => {
    wide = false;
    needs = [need("a", "a1"), need("b", "b1")];
    replyPlan = ["lost"];
    await signIn(true);
    await settle(500);
    const top = () => document.querySelector<HTMLElement>(".decide-sheet .card.top")?.dataset.need;
    const first = top()!;
    [...document.querySelectorAll<HTMLButtonElement>(".decide-sheet .actions .btn")].find((one) => one.textContent?.includes("Approve"))!.click();
    await settle(500);
    expect(top()).not.toBe(first);
    document.querySelector<HTMLButtonElement>('.decide-sheet [data-seg="answered"]')!.click();
    await settle(0);
    document.querySelector<HTMLButtonElement>(".decide-sheet .decide-close")!.click();
    await settle(500);
    expect(document.querySelector(".decide-sheet")).toBeNull();
    await settle(5000);
    expect(posts).toHaveLength(1);
    await settle(500);
    expect(top()).toBe(first);
    expect(document.querySelector(".decide-sheet .card.top .card-error")?.textContent).toContain("Not sent");
  });

  it("on a phone, a send that fails after the sheet closed on its last answer opens the sheet on the card again", async () => {
    wide = false;
    needs = [need("a", "a1")];
    replyPlan = ["lost"];
    await signIn(true);
    await settle(500);
    const approve = [...document.querySelectorAll<HTMLButtonElement>(".decide-sheet .actions .btn")].find((one) => one.textContent?.includes("Approve"))!;
    approve.click();
    await settle(500);
    expect(document.querySelector(".decide-sheet")).toBeNull();
    expect(app.tab).toBe("progress");
    await settle(5000);
    expect(posts).toHaveLength(1);
    expect(app.tab).toBe("cards");
    await settle(500);
    expect(document.querySelector<HTMLElement>(".decide-sheet .card.top")?.dataset.need).toBe("a");
    expect(document.querySelector(".decide-sheet .card.top .card-error")?.textContent).toContain("Not sent");
  });

  it("a minimised card waiting keeps Decide up after the cheer's words; so does opening it with none open", async () => {
    needs = [];
    await signIn();
    await settle(4000);
    expect(app.tab).toBe("cards");
    expect(root.querySelector(".home-back")?.textContent).toBe("‹ Your asks");
    expect(root.querySelector(".decide-close")).toBeNull();
    root.querySelector<HTMLButtonElement>(".home-back")!.click();
    expect(app.tab).toBe("progress");
    needs = [need("a", "a1"), need("b", "b1")];
    minimised = [["b", "b1"]];
    await signIn();
    await press("a");
    await settle(4000);
    expect(app.tab).toBe("cards");
    expect(root.querySelector(".decide-none-line")?.textContent).toBe("1 card waits for you, minimised.");
  });

  it("Z on the home screen takes back the last card's answer in the second left", async () => {
    needs = [need("a", "a1")];
    await signIn();
    await press("a");
    await settle(4000);
    expect(app.tab).toBe("progress");
    await press("z");
    expect(app.tab).toBe("cards");
    expect(root.querySelector(".view.decide-pane .card.top")?.getAttribute("data-need")).toBe("a");
    expect(posts).toEqual([]);
  });

  it("Decide reopened with none open during the cheer stays up when it ends", async () => {
    needs = [need("a", "a1")];
    await signIn();
    await press("a");
    root.querySelector<HTMLButtonElement>(".home-back")!.click();
    expect(app.tab).toBe("progress");
    app.tab = "cards";
    changed();
    await settle(0);
    root.querySelector<HTMLButtonElement>('[data-seg="open"]')!.click();
    expect(root.querySelector(".clear-title")?.textContent).toBe("You cleared them all!");
    await settle(4000);
    expect(app.tab).toBe("cards");
  });

  it("a card on its way when the cheer ends still opens, the home screen not taking over", async () => {
    needs = [need("a", "a1")];
    await signIn();
    await press("a");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input) === "/api/board" ? gate.then(() => fakeFetch(input, init)) : fakeFetch(input, init)));
    showCard("late");
    await settle(4000);
    expect(app.tab).toBe("cards");
    needs = [need("late", "l1")];
    release();
    await settle(0);
    expect(app.tab).toBe("cards");
    expect(root.querySelector(".view.decide-pane .card.top")?.getAttribute("data-need")).toBe("late");
  });

  it("opens the cards risky and oldest first in the middle pane, and J/K move through them, round to the start", async () => {
    needs = [
      { ...need("a", "a1"), since: "2026-09-30T10:00:00.000Z" },
      { ...need("b", "b1"), since: "2026-09-30T09:00:00.000Z" },
      { ...need("m", "m1"), risk: "money" },
    ];
    await signIn();
    expect(document.documentElement.classList.contains("desktop")).toBe(true);
    expect(root.querySelector(".view.decide-pane .card.top")).not.toBeNull();
    expect(root.querySelector(".desk-list, .qc-need")).toBeNull();
    expect(topId()).toBe("m");
    await press("j");
    expect(topId()).toBe("b");
    await press("ArrowDown");
    expect(topId()).toBe("a");
    await press("k");
    expect(topId()).toBe("b");
    await press("j");
    await press("j");
    expect(topId()).toBe("m");
  });

  it("A approves the open card with Undo, the next card opens in its place, and Z brings it back", async () => {
    needs = [need("a", "a1"), need("b", "b1"), need("c", "c1")];
    await signIn();
    await press("j");
    expect(topId()).toBe("b");

    await press("a");
    expect(root.querySelector(".toast.undo strong")?.textContent).toBe("Approved");
    expect(topId()).toBe("c");

    await press("z");
    expect(topId()).toBe("b");

    await press("A", { shiftKey: true });
    await settle(6000);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "b", decision: "approve", rev: "b1" }]);
  });

  it("number keys choose an option, and a risky card waits for Enter", async () => {
    needs = [{ ...need("m", "m1"), kind: "decision", risk: "money", options: [{ label: "5 minutes" }, { label: "15 minutes" }] }];
    await signIn();
    expect(root.querySelector(".card.top .choices")).toBeNull();
    expect([...root.querySelectorAll(".desk-picks .btn.pick kbd")].map((k) => k.textContent)).toEqual(["1", "2"]);
    expect([...root.querySelectorAll(".desk-picks .btn.pick")].map((p) => p.getAttribute("aria-label"))).toEqual(["5 minutes", "15 minutes"]);

    await press("3");
    await press("a");
    expect(root.querySelector(".confirm")).toBeNull();
    await press("2");
    expect(root.querySelector(".confirm-q")?.textContent).toBe("Choose “15 minutes”?");
    await press("Escape");
    expect(root.querySelector(".confirm")).toBeNull();
    await press("2");
    await press("Enter");
    await settle(6000);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "m", decision: "choice", choice: "15 minutes", confirm: true }]);
  });

  it("X asks why in the centred popup, with its keys: Esc cancels and ⌘↵ rejects with the words", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    expect(root.querySelector(".desk-answer .mini.no")).toBeNull();
    expect(root.querySelector(".desk-answer .desk-quiet")).toBeNull();
    expect([...root.querySelectorAll(".desk-actions .btn")].map((button) => button.textContent)).not.toContain("Dismiss");
    expect(root.querySelector(".card.top .card-head .head-tools .x-btn")).not.toBeNull();

    await press("x");
    const sheet = () => document.querySelector<HTMLElement>(".reject-sheet");
    expect(sheet()?.querySelector(".sheet-keys")?.textContent).toBe("⌘↵rejectEsccancel");
    expect(topId()).toBe("a");
    await press("Escape");
    expect(sheet()).toBeNull();
    expect(cardState("a").text).toBe("");

    await press("x");
    const why = sheet()!.querySelector<HTMLTextAreaElement>(".sheet-text")!;
    why.value = "Ask Sam first";
    why.dispatchEvent(new Event("input"));
    why.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    expect(sheet()).toBeNull();
    expect(topId()).toBe("b");
    await settle(6000);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "a", decision: "reject", rev: "a1", text: "Ask Sam first" }]);
  });

  it("the bar names each answer by its label, with a check on the recommended one", async () => {
    needs = [
      {
        ...need("m", "m1"),
        kind: "decision",
        options: [
          { label: "Yes, ship it", short: "Ship it now: invited people only", recommended: true },
          { label: "Both", short: "Ship this first, then plan" },
        ],
      },
    ];
    await signIn();
    expect(root.querySelector(".card.top .choices-cap, .card.top .choices")).toBeNull();
    expect([...root.querySelectorAll(".desk-picks .pick-label")].map((label) => label.textContent)).toEqual(["Yes, ship it", "Both"]);
    expect(root.querySelector(".desk-picks .pick.rec .pick-tag")?.getAttribute("aria-label")).toBe("Recommended");
  });

  it("shows one answer set: the bar's picks, details as a second line, when they hold every answer whole, else the card's list with the bar pointing to it", async () => {
    needs = [
      { ...need("m", "m1"), kind: "decision", options: [{ label: "Yes", detail: "Ship it to everyone tonight" }, { label: "No" }] },
      { ...need("n", "n1"), kind: "decision", options: [{ label: "Ship", detail: "Notes at https://example.com/notes" }, { label: "Wait" }] },
      { ...need("o", "o1"), kind: "decision", options: [{ label: "Ship", detail: "x".repeat(81) }, { label: "Wait" }] },
      { ...need("p", "p1"), kind: "decision", options: ["1", "2", "3", "4", "5"].map((n) => ({ label: `Option ${n}` })) },
    ];
    await signIn();
    const listed = () => [...root.querySelectorAll(".desk-detail .card.top .choice-label")].map((label) => label.textContent);
    const bar = () => [...root.querySelectorAll(".desk-picks .btn")].map((pick) => pick.textContent);
    expect([listed(), bar()]).toEqual([[], ["1YesShip it to everyone tonight", "2No"]]);
    expect(root.querySelector(".desk-picks .pick-detail")?.textContent).toBe("Ship it to everyone tonight");
    // A screen reader hears each answer's detail with its label, as the list said it.
    expect([...root.querySelectorAll(".desk-picks .btn")].map((pick) => pick.getAttribute("aria-label"))).toEqual(["Yes, Ship it to everyone tonight", "No"]);
    expect(root.querySelector(".card.top .choices-cap")).toBeNull();
    await press("j");
    expect(topId()).toBe("n");
    expect([listed(), bar()]).toEqual([["Ship", "Wait"], ["Pick an answer ↑"]]);
    await press("j");
    expect(topId()).toBe("o");
    expect([listed(), bar()]).toEqual([["Ship", "Wait"], ["Pick an answer ↑"]]);
    await press("j");
    expect(topId()).toBe("p");
    expect([listed(), bar()]).toEqual([["Option 1", "Option 2", "Option 3", "Option 4", "Option 5"], ["Pick an answer ↑"]]);
    await press("5");
    await settle(6000);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "p", decision: "choice", choice: "Option 5" }]);
  });

  it("with every card minimised, the pane says they wait, all minimised, and Show them › opens the first in full", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    minimised = [["a", "a1"], ["b", "b1"]];
    await signIn();
    // None open: the pane opens on Answered, as the phone's Decide sheet does, its Open side naming them.
    const open = root.querySelector<HTMLButtonElement>('.decide-seg[data-seg="open"]')!;
    expect(open.textContent).toBe("Minimised 2");
    open.click();
    await settle();
    expect(root.querySelector(".view.decide-pane .decide-none-line")?.textContent).toBe("2 cards wait for you, all minimised.");
    const tap = root.querySelector<HTMLButtonElement>(".view.decide-pane .clear-show .clear-min")!;
    expect([tap.textContent, tap.type]).toEqual(["Show them ›", "button"]);
    tap.click();
    await settle();
    expect(root.querySelector(".decide-none")).toBeNull();
    expect(root.querySelector(".desk-detail .card.top:not(.minimised) .card-ask")?.textContent).toBe("Ask a");
  });

  it("C goes to the comment box inline, where letters type instead of answering and ⌘↵ sends", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    await press("c");
    const note = root.querySelector<HTMLTextAreaElement>(".desk-note")!;
    expect(document.activeElement).toBe(note);

    note.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    note.value = "Slower camera";
    note.dispatchEvent(new Event("input"));
    await settle();
    expect(root.querySelector(".toast.undo")).toBeNull();

    note.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    await settle(6000);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "a", decision: "comment", text: "Slower camera" }]);
    expect(topId()).toBe("b");
  });

  it("keeps chat open alongside, and a narrow window goes back to the phone layout", async () => {
    localStorage.setItem("rivet.desk.layout", JSON.stringify({ chat: true }));
    vi.stubGlobal("EventSource", undefined);
    needs = [need("a", "a1")];
    await signIn();
    const side = root.querySelector<HTMLElement>("aside.side")!;
    expect(side.hidden).toBe(false);
    expect(side.querySelector(".chat")).not.toBeNull();
    // The menu, Chat being the pane beside it, then the Chat tool.
    expect([...root.querySelectorAll(".tabs .menu-name")].map((name) => name.textContent)).toEqual(["Your asks", "Floor", "Usage", "Machines", "Code", "Rivet's mind", "What you used", "Home", "Media", "Settings"]);
    expect([...root.querySelectorAll(".tabs .rail-tool")].map((one) => one.getAttribute("data-key"))).toEqual(["Chat"]);
    // The icon rail hides the names, so each row is named by its title, never only by its badge.
    for (const row of root.querySelectorAll<HTMLElement>(".tabs .menu-row")) {
      expect(row.title).toBe(row.querySelector(".menu-name")!.textContent);
    }

    root.querySelector<HTMLButtonElement>(".tabs .rail-tool[aria-pressed]")!.click();
    await settle(0);
    expect(side.querySelector(".chat")).toBeNull();
    expect(side.querySelector(".pane-strip.strip-chat")).not.toBeNull();
    expect(JSON.parse(localStorage.getItem("rivet.desk.layout")!)).toMatchObject({ chat: false });

    wide = false;
    changed();
    await settle(0);
    expect(document.documentElement.classList.contains("desktop")).toBe(false);
    expect(root.querySelector(".desk-board")).toBeNull();
    // A phone shows the home screen with no tab bar, and the Cards tab is the Decide sheet over it.
    await settle(500);
    expect(root.querySelector(".tabs .menu-row")).toBeNull();
    expect(root.querySelector(".view > .home")).not.toBeNull();
    expect(document.querySelector(".decide-sheet .actions")).not.toBeNull();
  });

  it("Goals is gone: anything that still opens it lands on home", async () => {
    wide = false;
    needs = [need("a", "a1")];
    await signIn();
    (app as { tab: string }).tab = "goals";
    changed();
    await settle(0);
    expect(app.tab).toBe("progress");
    expect([...root.querySelectorAll(".tabs .tab-label")].map((label) => label.textContent)).not.toContain("Goals");
  });

  it("Space plays the open card's clips", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    needs = [{ ...need("a", "a1"), media: { kind: "before-after", before: clip("a"), after: clip("b") } }];
    await signIn();
    const hints = [...root.querySelectorAll(".desk-keys .desk-hint")].map((hint) => hint.textContent!);
    expect(hints.filter((text) => text.startsWith("Space") && text.endsWith("play"))).toHaveLength(1);
    await press(" ");
    expect(play).toHaveBeenCalled();
    expect(root.querySelector(".toast.undo")).toBeNull();
  });

  it("] collapses chat to a strip, the strip opens it again, and the layout survives a reload", async () => {
    localStorage.setItem("rivet.desk.layout", JSON.stringify({ chat: true }));
    vi.stubGlobal("EventSource", undefined);
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    expect(root.querySelector("aside.side .chat")).not.toBeNull();

    await press("]");
    expect(root.querySelector("aside.side .chat")).toBeNull();
    const strip = root.querySelector<HTMLButtonElement>("aside.side .pane-strip.strip-chat")!;
    expect(strip).not.toBeNull();
    expect(JSON.parse(localStorage.getItem("rivet.desk.layout")!)).toMatchObject({ chat: false });
    // The keys still move through the cards.
    await press("j");
    expect(topId()).toBe("b");

    // A fresh start reads the layout back.
    await signIn();
    expect(root.querySelector("aside.side .pane-strip.strip-chat")).not.toBeNull();
    root.querySelector<HTMLButtonElement>("aside.side .pane-strip.strip-chat")!.click();
    await settle(0);
    expect(root.querySelector("aside.side .chat")).not.toBeNull();
  });

  it("F collapses everything but the card, and F again brings the panes back as they were", async () => {
    localStorage.setItem("rivet.desk.layout", JSON.stringify({ chat: true }));
    vi.stubGlobal("EventSource", undefined);
    needs = [need("a", "a1")];
    await signIn();
    const app = root;

    await press("f");
    expect(app.classList.contains("desk-focus")).toBe(true);
    expect(app.classList.contains("rail-icons")).toBe(true);
    expect(root.querySelector("aside.side .chat")).toBeNull();
    expect(topId()).toBe("a");

    await press("f");
    expect(app.classList.contains("desk-focus")).toBe(false);
    expect(root.querySelector("aside.side .chat")).not.toBeNull();
  });

  it("chat's grip resizes it from the keyboard, and double-click puts the default back", async () => {
    localStorage.setItem("rivet.desk.layout", JSON.stringify({ chat: true }));
    vi.stubGlobal("EventSource", undefined);
    needs = [need("a", "a1")];
    await signIn();
    const grip = () => root.querySelector<HTMLElement>(".pane-grip.grip-chat")!;
    expect(grip().getAttribute("role")).toBe("separator");
    grip().focus();
    grip().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await settle(0);
    const stored = JSON.parse(localStorage.getItem("rivet.desk.layout")!);
    expect(stored.chatW).toBeGreaterThan(0);
    expect(document.documentElement.style.getPropertyValue("--chat-w")).toBe(`${stored.chatW}px`);
    expect(document.activeElement).toBe(grip());

    grip().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await settle(0);
    expect(JSON.parse(localStorage.getItem("rivet.desk.layout")!).chatW).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--chat-w")).toBe("");
  });

  it("Enter on a focused Cancel cancels a risky answer instead of confirming it", async () => {
    needs = [{ ...need("m", "m1"), kind: "decision", risk: "money", options: [{ label: "5 minutes" }, { label: "15 minutes" }] }];
    await signIn();
    await press("2");
    const cancel = [...root.querySelectorAll<HTMLButtonElement>(".confirm button")].find((b) => b.textContent === "Cancel")!;
    cancel.focus();
    cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    // What the browser does with Enter on a focused button.
    cancel.click();
    await settle(6000);
    expect(posts).toEqual([]);
    expect(root.querySelector(".confirm")).toBeNull();
  });

  it("a poll leaves the keyboard on Cancel, so Enter still cancels instead of confirming", async () => {
    needs = [{ ...need("m", "m1"), kind: "decision", risk: "money", options: [{ label: "5 minutes" }, { label: "15 minutes" }] }];
    await signIn();
    await press("2");
    const cancel = () => [...root.querySelectorAll<HTMLButtonElement>(".confirm button")].find((b) => b.textContent === "Cancel")!;
    const first = cancel();
    first.focus();
    await pollNew();
    expect(document.activeElement).toBe(cancel());
    cancel().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    // What the browser does with Enter on a focused button.
    cancel().click();
    await settle(6000);
    expect(posts).toEqual([]);
    expect(root.querySelector(".confirm")).toBeNull();
  });

  it("a redraw that changes the card keeps the keyboard on Cancel, so Enter answers nothing on a money card", async () => {
    const money = { ...need("m", "m1"), kind: "decision", risk: "money", options: [{ label: "5 minutes" }, { label: "15 minutes" }] } as ServedNeed;
    needs = [money];
    await signIn();
    await press("2");
    const cancel = () => [...root.querySelectorAll<HTMLButtonElement>(".confirm button")].find((b) => b.textContent === "Cancel")!;
    const first = cancel();
    first.focus();
    // The same revision with other words: the pane draws the card again.
    needs = [{ ...money, ask: "Ask m, put another way" }];
    await poll();
    expect(cancel()).not.toBe(first);
    const on = document.activeElement as HTMLElement;
    on.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle(6000);
    expect(root.querySelector(".toast.undo")).toBeNull();
    expect(posts).toEqual([]);
    expect(on).toBe(cancel());
    expect(document.activeElement).toBe(cancel());
  });

  it("a redraw that moves the clip keeps the keyboard on its button, so Enter answers nothing on a money card (review R2, slice 5)", async () => {
    const clip = { sha256: "c".repeat(64), type: "video/mp4" as const };
    const money = { ...need("m", "m1"), kind: "decision", risk: "money", options: [{ label: "5 minutes" }, { label: "15 minutes" }], media: { kind: "video", after: clip } } as ServedNeed;
    needs = [money];
    await signIn();
    await press("2");
    expect(root.querySelector(".decide-pane .confirm")).not.toBeNull();
    const play = root.querySelector<HTMLButtonElement>(".decide-pane .media-play")!;
    play.focus();
    needs = [{ ...money, ask: "Ask m, put another way" }];
    await poll();
    expect(document.activeElement).toBe(root.querySelector(".decide-pane .media-play"));
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle(6000);
    expect(posts).toEqual([]);
  });

  it("J on Answered leaves the list where it is (review R2, slice 5)", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    toSegment("done");
    await settle();
    const front = app.front;
    await press("j");
    expect(segment()).toBe("done");
    expect(app.front).toBe(front);
  });

  it("J moves the card on top too, so Search or a push for the card left opens it again", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    showCard("a");
    await settle();
    const stamp = navStamp();
    await press("j");
    expect([topId(), app.front]).toEqual(["b", "b"]);
    expect(navStamp()).not.toBe(stamp);
    showCard("a");
    await settle();
    expect(topId()).toBe("a");
    await press("a");
    await settle(6000);
    expect(posts.map((post) => post.body.itemId)).toEqual(["a"]);
  });

  it("Pick an answer ↑ scrolls the pane's card, which is what scrolls there, to its list", async () => {
    needs = [{ ...need("p", "p1"), kind: "decision", options: ["1", "2", "3", "4", "5"].map((n) => ({ label: `Option ${n}` })) }];
    await signIn();
    const card = root.querySelector<HTMLElement>(".decide-pane .card.top")!;
    const rect = (top: number, bottom: number) => () => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON() {} }) as DOMRect;
    card.getBoundingClientRect = rect(0, 400);
    card.querySelector<HTMLElement>(".choices-cap")!.getBoundingClientRect = rect(600, 620);
    card.querySelector<HTMLElement>(".choices")!.getBoundingClientRect = rect(620, 900);
    const scrolled = vi.fn();
    card.scrollBy = scrolled;
    [...root.querySelectorAll<HTMLButtonElement>(".desk-picks .btn")].find((pick) => pick.textContent === "Pick an answer ↑")!.click();
    expect(scrolled).toHaveBeenCalledWith({ top: 508, behavior: "smooth" });
  });

  it("an option that needs words puts the keyboard in the pane's note box", async () => {
    needs = [{ ...need("t", "t1"), kind: "decision", options: [{ label: "Other", text: true }, { label: "Keep" }] }];
    await signIn();
    await press("1");
    expect(document.activeElement).toBe(root.querySelector(".decide-pane .desk-note"));
    await settle(6000);
    expect(posts).toEqual([]);
  });

  it("a poll that takes away the focused card never hands its Approve to the next card", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    const approve = () => [...root.querySelectorAll<HTMLButtonElement>(".desk-actions button")].find((b) => b.textContent?.startsWith("Approve"));
    const first = approve()!;
    expect(first.closest("[data-need]")?.getAttribute("data-need")).toBe("a");
    first.focus();
    needs = [need("b", "b1")];
    await poll();
    expect(approve()?.closest("[data-need]")?.getAttribute("data-need")).toBe("b");
    expect(document.activeElement).not.toBe(approve());
  });

  it("a poll never hands the keyboard to a different answer on the card", async () => {
    needs = [{ ...need("m", "m1"), kind: "decision", options: [{ label: "Ship today" }, { label: "Wait a day" }] }];
    await signIn();
    const option = (label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(label));
    const waited = option("Wait a day")!;
    waited.focus();
    // The card's options change under the keyboard: the focused one is gone, so nothing like it takes the focus.
    needs = [{ ...need("m", "m2"), kind: "decision", options: [{ label: "Ship today" }, { label: "Wait a week" }] }];
    await poll();
    expect(waited.isConnected).toBe(false);
    expect(option("Wait a week")).toBeDefined();
    expect(document.activeElement).not.toBe(option("Ship today"));
    expect(document.activeElement).not.toBe(option("Wait a week"));
  });

  it("widening the window on the Chat tab keeps chat alive in the side column", async () => {
    const streams: { closed: boolean }[] = [];
    vi.stubGlobal(
      "EventSource",
      class {
        static CLOSED = 2;
        readyState = 1;
        closed = false;
        constructor() {
          streams.push(this);
        }
        addEventListener() {}
        close() {
          this.closed = true;
        }
      },
    );
    localStorage.setItem("rivet.desk.layout", JSON.stringify({ chat: false }));
    wide = false;
    needs = [need("a", "a1")];
    await signIn();
    app.tab = "chat";
    changed();
    await settle(0);
    wide = true;
    changed();
    await settle(0);
    expect(app.tab).toBe("progress");
    expect(root.querySelector("aside.side .chat")).not.toBeNull();
    expect(streams.at(-1)?.closed).toBe(false);
  });

  it("a drag that outlives its grip still ends", async () => {
    localStorage.setItem("rivet.desk.layout", JSON.stringify({ chat: true }));
    vi.stubGlobal("EventSource", undefined);
    needs = [need("a", "a1")];
    await signIn();
    const html = document.documentElement;
    root.querySelector<HTMLElement>(".pane-grip.grip-chat")!.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 900, bubbles: true }));
    expect(html.classList.contains("pane-resizing")).toBe(true);
    // A board refresh replaces the grip mid-drag.
    changed();
    await settle(0);
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 860 }));
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 860 }));
    expect(html.classList.contains("pane-resizing")).toBe(false);
    expect(JSON.parse(localStorage.getItem("rivet.desk.layout")!).chatW).toBeGreaterThan(0);
  });

  it("? lists every key, and a narrow window ignores the pane keys", async () => {
    needs = [need("a", "a1")];
    await signIn();
    await press("?", { shiftKey: true });
    const help = document.querySelector(".sheet[aria-label='Keyboard shortcuts']");
    expect(help?.textContent).toContain("Focus: the card alone");
    expect(help?.textContent).toContain("Show or collapse chat");
    closeSheet();

    wide = false;
    changed();
    await settle(0);
    await press("f");
    await press("[");
    expect(localStorage.getItem("rivet.desk.layout")).toBe(JSON.stringify({ chat: false }));
  });

  it("a PDF card keeps its Open PDF button in the middle pane", async () => {
    needs = [{ ...need("p", "p1"), media: { kind: "files", files: [{ sha256: "9".repeat(64), type: "application/pdf", name: "Paper.pdf", bytes: 1000 }] } }];
    await signIn();
    expect(root.querySelector(".desk-detail .btn.media-file")?.textContent).toContain("Paper.pdf");
  });

  it("/ opens search, but not while typing; the header has no Search or Copy summary", async () => {
    needs = [need("a", "a1")];
    await signIn();
    for (const tab of ["cards", "progress"] as const) {
      app.tab = tab;
      changed();
      await settle(0);
      expect(root.querySelector(".topbar .topbar-end")).not.toBeNull();
      expect(root.querySelector(".topbar .agents-copy, .topbar [aria-label='Search']")).toBeNull();
    }
    app.tab = "cards";
    changed();
    await settle(0);
    const note = root.querySelector<HTMLTextAreaElement>(".desk-note")!;
    note.focus();
    note.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    note.blur();
    await press("/");
    expect(document.querySelector('[aria-modal="true"]')?.getAttribute("aria-label")).toBe("Search");
  });
});

describe("the board's lists", () => {
  let wide = true;
  const NOW = Date.now();
  const COMING = [
    { title: "Tech spec sheet", stage: "building" as const, progress: 0.2, etaMinutes: 90, updatedAt: new Date(NOW).toISOString(), chat: "spec-sheet", pr: 2700 },
    { title: "Half checkout", stage: "owner-ok" as const, chat: "half-checkout" },
    { title: "Signup Flow", stage: "shipped" as const },
    { title: "Instant return to an open page" },
    { title: "Rocket engines" },
  ];
  const press = async (name: string) => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { key: name, bubbles: true }));
    await settle();
  };

  beforeEach(() => {
    wide = true;
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          get matches() {
            return wide;
          },
          media: query,
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    );
    localStorage.setItem("rivet.desk.layout", JSON.stringify({ chat: false }));
    lists = {
      coming: COMING,
      chats: [{ name: "spec-sheet", state: "working", doing: "Measuring builds" }],
      shipped: [{ pr: 2601, title: "Quote form result screen", deployed: true, shippedAt: new Date().toISOString() }],
    };
  });

  it("chat and the rail fold from their own chevrons, the top bar keeps only Focus, and the keys still work", async () => {
    localStorage.setItem("rivet.desk.layout", JSON.stringify({ chat: true, rail: "full" }));
    vi.stubGlobal("EventSource", undefined);
    needs = [need("a", "a1")];
    await signIn();
    expect([...root.querySelectorAll(".topbar .pane-toggle")].map((b) => b.getAttribute("aria-label"))).toEqual(["Focus"]);
    const fold = (pane: string) => root.querySelector<HTMLButtonElement>(`.pane-fold.fold-${pane}`);
    expect(fold("list")).toBeNull();
    expect(fold("chat")?.getAttribute("aria-label")).toBe("Hide chat");
    expect(fold("rail")?.getAttribute("aria-expanded")).toBe("true");

    fold("chat")!.click();
    await settle(0);
    expect(root.querySelector("aside.side .chat")).toBeNull();
    expect(root.querySelector("aside.side .pane-strip.strip-chat")).not.toBeNull();

    fold("rail")!.click();
    await settle(0);
    expect(root.classList.contains("rail-icons")).toBe(true);
    expect(fold("rail")?.getAttribute("aria-label")).toBe("Show rail");
    expect(JSON.parse(localStorage.getItem("rivet.desk.layout")!)).toMatchObject({ chat: false, rail: "icons" });

    await press("]");
    await press("\\");
    expect(root.querySelector("aside.side .chat")).not.toBeNull();
    expect(root.classList.contains("rail-icons")).toBe(false);
  });

});

describe("counts and search follow-ups", () => {
  const crewMember = (chat: string, state: Worker["state"], rivet = false): Worker => ({
    id: `w-${chat}`,
    name: chat,
    repo: "example-org/example-repo",
    chat,
    state,
    lastOutputAt: null,
    ...(rivet ? { rivet } : {}),
  });

  it.each([true, false])("a cold card link survives a failed first load without reopening future answers (answered: %s)", async (answered) => {
    needs = [need("n1", "rev1"), need("n2", "rev1")];
    if (answered) replies = [reply("n1", "rev1", "other-device")];
    app.front = "n1";
    failing.add("/api/board");
    await signIn();
    expect(app.board).toBeNull();
    failing.clear();
    await poll();
    expect(topId()).toBe("n1");
    expect(app.reopened.has("n1")).toBe(answered);
    if (!answered) {
      replies = [reply("n1", "rev1", "other-device")];
      await poll();
      expect(topId()).toBe("n2");
    }
  });

  it.each(["search", "notification"])("a %s link for an answered card opens that card, as Answer again does", async (source) => {
    needs = [need("n1", "rev1"), need("n2", "rev1")];
    replies = [reply("n1", "rev1", "client-n1")];
    await signIn();
    expect(topId()).toBe("n2");
    if (source === "search") openTarget({ type: "card", id: "n1" });
    else showCard("n1");
    expect(topId()).toBe("n1");
    expect(app.reopened.has("n1")).toBe(true);
  });

  it("keeps the keyboard on the same answer's Reopen across a poll", async () => {
    needs = [need("n1", "rev1"), need("n2", "rev1")];
    replies = [reply("n1", "rev1", "client-n1"), reply("n2", "rev1", "client-n2")];
    await signIn();
    toSegment("done");
    await settle();
    const again = () => [...root.querySelectorAll<HTMLButtonElement>(".ans-row .ans-reopen")];
    expect(again()).toHaveLength(2);
    again()[1]!.focus();
    await poll();
    expect(document.activeElement).toBe(again()[1]);
  });

  it("Reopen opens the card as a new revision, and the new answer goes on that one", async () => {
    needs = [need("n1", "rev1"), need("n2", "rev1")];
    replies = [reply("n1", "rev1", "client-n1"), reply("n2", "rev1", "client-n2")];
    await signIn();
    toSegment("done");
    await settle();
    root.querySelector<HTMLButtonElement>('.ans-row[data-reply="r-client-n1"] .ans-reopen')!.click();
    await settle(0);
    expect(againPosts).toEqual([{ rev: "rev1" }]);
    expect(app.tab).toBe("cards");
    expect(topId()).toBe("n1");
    key("keydown", "x");
    rejectWhy();
    await settle();
    flushHeld();
    await settle(0);
    expect(posts.map((post) => [post.body.itemId, post.body.rev, post.body.decision])).toEqual([["n1", "rev1-again", "reject"]]);
  });

  it("Reopen on a card that changed meanwhile says so and opens nothing", async () => {
    needs = [need("n1", "rev1"), need("n2", "rev1")];
    replies = [reply("n1", "rev1", "client-n1"), reply("n2", "rev1", "client-n2")];
    await signIn();
    toSegment("done");
    await settle();
    againPlan = "conflict";
    root.querySelector<HTMLButtonElement>(".ans-row .ans-reopen")!.click();
    await settle(0);
    expect(againPosts).toHaveLength(1);
    expect(root.querySelector(".toast.flash")?.textContent).toBe("this card changed; look again");
    expect(segment()).toBe("done");
  });

  it("a reply still loading for an earlier search pick does not pull you back to it", async () => {
    replies = Array.from({ length: 20 }, (_, i) => ({ ...reply(`c${i}`, "rev1", `client-c${i}`), itemTitle: `Answer ${i}` }));
    await signIn();
    let release!: () => void;
    replyGate = new Promise((resolve) => (release = resolve));
    openTarget({ type: "reply", id: replies[17]!.id });
    openTarget({ type: "tab", tab: "feed", section: "coming" });
    release();
    await settle();
    expect(app.tab).toBe("cards");

    replyGate = new Promise((resolve) => (release = resolve));
    openTarget({ type: "reply", id: replies[18]!.id });
    openTarget({ type: "reply", id: replies[10]!.id });
    release();
    await settle();
    expect(root.querySelector(".ans-row.found .ans-t")?.textContent).toBe("Answer 10");
  });

});

describe("a refresh the service worker holds a card push for", () => {
  let acks: unknown[];
  beforeEach(() => {
    acks = [];
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { controller: { postMessage: (message: unknown) => acks.push(message) } } });
  });

  /** What main.ts does with a card push's refresh. */
  const refreshCard = (id: string, card = "a") =>
    workerRefresh({ id }, async () => false, async () => {
      const ok = await refresh();
      if (ok) recoverOutbox();
      return ok && typeof card === "string" && decide.decideShown() === card;
    }, () => null);

  it("is not acknowledged when another card has come to the front meanwhile", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    expect(topId()).toBe("a");
    app.front = "b";
    await refreshCard("1", "a");
    expect(topId()).toBe("b");
    expect(acks).toEqual([]);
    await refreshCard("2", "b");
    expect(acks).toEqual([{ type: "refresh-ack", id: "2" }]);
  });
});

describe("update cards", () => {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const update = (id: string, rev: string, extra: Partial<ServedNeed> = {}): ServedNeed => ({
    id,
    kind: "update",
    title: `News ${id}`,
    thread: "Billing",
    tag: "Merged · Deployed",
    ask: `Line ${id}`,
    since: ago(1),
    rev,
    ...extra,
  });
  const feedBadge = () => root.querySelector(".home-decide.has-cards .home-decide-n")?.textContent ?? null;
  const sheet = () => document.querySelector<HTMLElement>(".sheet.update-sheet");

  const wide = () =>
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);

  it("opens a link to a page of this app (an update card's Media link) here, and any other in a new tab", async () => {
    // A card link must be https, and happy-dom's history goes back to its first URL: keep the address.
    const was = location.href;
    const dom = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
    dom.setURL("https://rivet.example/");
    const back = history.back.bind(history);
    const keep = vi.spyOn(history, "back").mockImplementation(() => {
      back();
      dom.setURL("https://rivet.example/");
    });
    try {
      const links = [
        { label: "Media ›", url: "https://rivet.example/?tab=media" },
        { label: "a guide", url: "https://example.com/guide" },
        // Naming more than its tab (a conversation): opened as before, for main.ts to read all of it.
        { label: "the chat", url: "https://rivet.example/?tab=chat&conversation=g1" },
      ];
      needs = [need("a", "1".repeat(16)), update("new", "3".repeat(16), { since: ago(2), thread: "Morning", tag: "Morning", links })];
      wide();
      await signIn();
      showCard("new");
      await vi.waitFor(() => expect(sheet()).not.toBeNull());
      const [inApp, out, more] = [...sheet()!.querySelectorAll<HTMLAnchorElement>('.upd[data-need="new"] .card-links a')];
      expect([inApp!.getAttribute("target"), out!.getAttribute("target"), more!.getAttribute("target")]).toEqual([null, "_blank", "_blank"]);
      inApp!.click();
      await vi.waitFor(() => expect([app.tab, app.morePage]).toEqual(["more", "media"]));
      expect(sheet()).toBeNull();
    } finally {
      keep.mockRestore();
      dom.setURL(was);
    }
  });

  it("keeps update cards out of the deck and the Cards badge, and draws no news on the home screen", async () => {
    needs = [need("a", "1".repeat(16)), update("old", "2".repeat(16), { since: ago(30), thread: "main" }), update("new", "3".repeat(16), { since: ago(2) })];
    await signIn();
    await settle(0);
    expect(topId()).toBe("a");
    expect([...document.querySelectorAll(".decide-seg")].map((seg) => seg.textContent)).toEqual([openTab(1), answeredTab(0)]);
    expect(feedBadge()).toBe("1");
    app.tab = "progress";
    changed();
    await settle(0);
    expect(root.querySelector(".upd, .updates, .upd-pile, .ustream, .thread-view, .progress-news")).toBeNull();
  });

  it("opens an update card in full in a sheet, its lines kept, Seen while it is new; Seen clears it after its Undo window", async () => {
    const ask = "Top line\n\n• a\n• b";
    needs = [update("u", "1".repeat(16), { ask, chat: "report-page-visual" })];
    const css = document.createElement("style");
    css.textContent = readFileSync(resolve(process.cwd(), "web/src/styles.css"), "utf8");
    document.head.append(css);
    try {
      wide();
      await signIn();
      showCard("u");
      await settle(0);
      const card = sheet()!.querySelector<HTMLElement>('.upd[data-need="u"]')!;
      expect(card.querySelector(".upd-title")?.textContent).toBe("News u");
      expect(card.querySelector(".upd-tag")?.textContent).toBe("Merged · Deployed");
      const line = card.querySelector<HTMLElement>(".upd-line")!;
      expect(line.textContent).toBe(ask);
      expect(getComputedStyle(line).whiteSpace).toBe("pre-wrap");
      expect([...line.querySelectorAll(".upd-li")].map((item) => item.textContent)).toEqual(["• a", "• b"]);
      sheet()!.querySelector<HTMLButtonElement>(".upd-seen")!.click();
      expect(sheet()).toBeNull();
      await settle(5_100);
      expect(posts.map((post) => post.body)).toEqual([{ clientId: expect.any(String), itemId: "u", decision: "seen", rev: "1".repeat(16) }]);
      expect(app.answeredToday).toBe(0);
    } finally {
      css.remove();
    }
  });

  it("opens a thread as its cards of today newest first, their comments, Say and Seen all N; a tag that only names the thread is left off", async () => {
    needs = [
      update("first", "1".repeat(16), { since: ago(30), thread: "Morning", tag: "Morning", comments: [{ from: "owner", text: "nice", at: ago(20) }] }),
      update("second", "2".repeat(16), { since: ago(10), thread: "Morning", tag: "Red fixed", comments: [{ from: "rivet", text: "green again", at: ago(9) }] }),
      update("third", "3".repeat(16), { since: ago(40), thread: "morning", seen: true }),
      update("other", "4".repeat(16), { since: ago(5), thread: "Egypt" }),
      update("yesterday", "5".repeat(16), { since: ago(30 * 60), thread: "Morning", tag: "Morning" }),
    ];
    wide();
    await signIn();
    showCard("second");
    await settle(0);
    expect(sheet()!.querySelector(".sheet-title")?.textContent).toBe("Morning");
    expect([...sheet()!.querySelectorAll<HTMLElement>(".upd")].map((card) => card.dataset.need)).toEqual(["second", "first", "third"]);
    expect([...sheet()!.querySelectorAll(".upd")].map((card) => card.querySelector(".upd-tag")?.textContent ?? null)).toEqual(["Red fixed", null, "Merged · Deployed"]);
    expect([...sheet()!.querySelectorAll(".upd-note")].map((note) => note.textContent)).toEqual(["Rivet: green again", "You: nice"]);
    expect(sheet()!.querySelector(".upd-seen")?.textContent).toBe("Seen all 2");
    expect(sheet()!.querySelector(".say-line")).toBeNull();
    sheet()!.querySelector<HTMLButtonElement>(".upd-say")!.click();
    const area = sheet()!.querySelector<HTMLTextAreaElement>('.say-line[data-need="second"] .say-text')!;
    expect(area.placeholder).toBe("Say something about Morning…");
    expect(sheet()!.querySelector(".upd-say")).toBeNull();
    sheet()!.querySelector<HTMLButtonElement>(".upd-seen")!.click();
    expect(sheet()).toBeNull();
    await settle(5_100);
    expect(posts.map((post) => post.body)).toEqual([
      { clientId: expect.any(String), itemId: "second", decision: "seen", rev: "2".repeat(16) },
      { clientId: expect.any(String), itemId: "first", decision: "seen", rev: "1".repeat(16) },
    ]);
  });

  it("Say on a thread's sheet sends its words as a comment on the newest card", async () => {
    needs = [update("a", "1".repeat(16), { since: ago(20) }), update("b", "2".repeat(16), { since: ago(5) })];
    await signIn();
    showCard("a");
    await settle(0);
    expect([...sheet()!.querySelectorAll<HTMLElement>(".upd")].map((card) => card.dataset.need)).toEqual(["b", "a"]);
    sheet()!.querySelector<HTMLButtonElement>(".upd-say")!.click();
    const area = sheet()!.querySelector<HTMLTextAreaElement>(".say-text")!;
    area.value = "looks flat";
    area.dispatchEvent(new Event("input"));
    sheet()!.querySelector<HTMLButtonElement>(".say-send")!.click();
    await settle(0);
    expect(sheet()!.querySelector(".say-line")).toBeNull();
    await settle(5_100);
    expect(posts.map((post) => post.body)).toEqual([{ clientId: expect.any(String), itemId: "b", decision: "comment", rev: "2".repeat(16), text: "looks flat" }]);
  });

  it("opens a seen card with its comments and no Seen", async () => {
    needs = [update("u", "1".repeat(16), { seen: true, comments: [{ from: "owner", text: "flat?", at: ago(1) }, { from: "rivet", text: "on it", at: ago(1) }] })];
    await signIn();
    showCard("u");
    await settle(0);
    expect([...sheet()!.querySelectorAll(".upd-note")].map((note) => note.textContent)).toEqual(["You: flat?", "Rivet: on it"]);
    expect(sheet()!.querySelector(".upd-seen:not([hidden])")).toBeNull();
  });

  it("an update card not on the board this app read (its push, its chat line) is read for and opened", async () => {
    needs = [need("q", "1".repeat(16))];
    await signIn();
    needs = [...needs, update("late", "2".repeat(16))];
    showCard("late");
    await settle();
    expect(sheet()?.querySelector('.upd[data-need="late"]')).not.toBeNull();
  });

  it("opens no sheet over sign-in when its chat's lookup answers after the session ended", async () => {
    needs = [update("u", "1".repeat(16), { chat: "report-page-visual" })];
    await signIn();
    const real = vi.mocked(fetch).getMockImplementation()!;
    let answer = () => {};
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input) === "/api/conversations" ? new Promise<Response>((resolve) => (answer = () => resolve(json({ conversations: [] })))) : real(input, init),
    );
    showCard("u");
    await settle(0);
    answer();
    await settle(0);
    expect(sheet()).not.toBeNull();
    closeSheet();
    showCard("u");
    await settle(0);
    endSession();
    signOut();
    answer();
    await settle(0);
    expect(sheet()).toBeNull();
  });

  it("a chat's row starts no draft naming it when its lookup answers after the session ended", async () => {
    await signIn();
    const real = vi.mocked(fetch).getMockImplementation()!;
    let answer = () => {};
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input) === "/api/conversations" ? new Promise<Response>((resolve) => (answer = () => resolve(json({ conversations: [] })))) : real(input, init),
    );
    const drafted = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i)!) ?? "").some((value) => value.includes("fixer: "));
    showChatThing("fixer");
    endSession();
    signOut();
    answer();
    await settle(0);
    expect(drafted()).toBe(false);
    vi.mocked(fetch).mockImplementation(real);
    await signIn();
    showChatThing("fixer");
    await settle(0);
    expect(drafted()).toBe(true);
  });

  it("keeps Seen to what is new as polls bring cards: its label, whether it shows, and what it marks", async () => {
    needs = [update("a", "1".repeat(16), { since: ago(20), seen: true })];
    await signIn();
    showCard("a");
    await settle(0);
    const seen = () => sheet()!.querySelector<HTMLButtonElement>(".upd-seen:not([hidden])");
    expect(seen()).toBeNull();
    needs = [...needs, update("b", "2".repeat(16), { since: ago(10) })];
    await poll();
    expect(seen()?.textContent).toBe("Seen");
    needs = [...needs, update("c", "3".repeat(16), { since: ago(5) })];
    await poll();
    expect(seen()?.textContent).toBe("Seen all 2");
    seen()!.click();
    await settle(5_100);
    expect(posts.map((post) => post.body)).toEqual([
      { clientId: expect.any(String), itemId: "c", decision: "seen", rev: "3".repeat(16) },
      { clientId: expect.any(String), itemId: "b", decision: "seen", rev: "2".repeat(16) },
    ]);
  });

  it("Say stays on the card it opened on, its draft and focus kept, when a poll brings a newer card", async () => {
    needs = [update("a", "1".repeat(16), { since: ago(20) })];
    await signIn();
    showCard("a");
    await settle(0);
    sheet()!.querySelector<HTMLButtonElement>(".upd-say")!.click();
    const area = sheet()!.querySelector<HTMLTextAreaElement>('.say-line[data-need="a"] .say-text')!;
    area.value = "about a";
    area.dispatchEvent(new Event("input"));
    expect(document.activeElement).toBe(area);
    needs = [...needs, update("b", "2".repeat(16), { since: ago(5) })];
    await poll();
    expect([...sheet()!.querySelectorAll<HTMLElement>(".upd")].map((card) => card.dataset.need)).toEqual(["b", "a"]);
    expect(sheet()!.querySelector(".say-text")).toBe(area);
    expect([area.value, document.activeElement === area]).toEqual(["about a", true]);
    sheet()!.querySelector<HTMLButtonElement>(".say-send")!.click();
    await settle(5_100);
    expect(posts.map((post) => post.body)).toEqual([{ clientId: expect.any(String), itemId: "a", decision: "comment", rev: "1".repeat(16), text: "about a" }]);
  });

  it("shows Send on the sheet's Say once a photo is picked with no words", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    needs = [update("a", "1".repeat(16))];
    await signIn();
    showCard("a");
    await settle(0);
    sheet()!.querySelector<HTMLButtonElement>(".upd-say")!.click();
    const line = sheet()!.querySelector<HTMLElement>(".say-line")!;
    expect(line.classList.contains("has-text")).toBe(false);
    const input = line.querySelector<HTMLInputElement>(".attach-input")!;
    Object.defineProperty(input, "files", { value: [new File(["jpeg bytes"], "IMG_0001.JPG", { type: "image/jpeg" })], configurable: true });
    input.dispatchEvent(new Event("change"));
    await settle(0);
    await settle(0);
    expect(line.classList.contains("has-text")).toBe(true);
  });
});

describe("the Feed's segments, plan card and Done", () => {
  const plan = (): ServedNeed => ({ ...need("p", "p1"), kind: "plan", title: "Five colour picks", points: ["Pick 5 at the start", "Save between rounds"], size: "M", eta: "~2:30pm" });

  it("draws a plan card: its points, Size and ETA, and one big Yes, go that sends its yes with the say-line's words", async () => {
    needs = [plan(), need("b", "b1")];
    await signIn();
    expect(segment()).toBe("needs");
    const card = root.querySelector<HTMLElement>(".card.top")!;
    expect(card.querySelector(".card-kind")?.textContent).toMatch(/^Plan/);
    expect([...card.querySelectorAll(".plan-points li")].map((li) => li.textContent)).toEqual(["Pick 5 at the start", "Save between rounds"]);
    expect([...card.querySelectorAll(".plan-chip")].map((chip) => chip.textContent)).toEqual(["Size M", "ETA ~2:30pm"]);
    expect([...root.querySelectorAll(".plan-row .btn")].map((b) => b.textContent)).toEqual(["Yes, gostarts the build", "Nochange it"]);
    expect(root.querySelector(".actions .btn.dismiss")).toBeNull();
    expect(root.querySelector(".actions .say-line .say-text")).not.toBeNull();
    say("Start with the preview link");
    actionButton("Yes, go").click();
    expect(topId()).toBe("b");
    await settle(5100);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "p", decision: "approve", rev: "p1", text: "Start with the preview link" }]);
  });

  it("No on a plan asks why, as the X does, and sends its no with his words", async () => {
    needs = [plan()];
    await signIn();
    actionButton("No").click();
    expect(document.querySelector(".reject-sheet .sheet-title")?.textContent).toBe("Why reject?");
    rejectWhy("Start smaller");
    await settle(5100);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "p", decision: "reject", text: "Start smaller" }]);
  });

  it("an old stored Coming row with fields of the wrong type does not stop the Feed drawing", async () => {
    needs = [need("a", "a1")];
    lists = { coming: [{ title: "Legacy", etaMinutes: "soon", updatedAt: { toString: 0 } } as never] };
    await signIn();
    expect(root.querySelector('.card[data-need="a"]')).not.toBeNull();
  });
});

describe("X rejects, always asking why", () => {
  const sheet = () => document.querySelector<HTMLElement>(".reject-sheet");
  const why = () => sheet()!.querySelector<HTMLTextAreaElement>(".sheet-text")!;
  const send = () => sheet()!.querySelector<HTMLButtonElement>(".reject-send")!;
  const type = (text: string) => {
    why().value = text;
    why().dispatchEvent(new Event("input"));
  };

  it("the X opens Why reject? with the say-line's words; Reject waits for words, and Cancel or Esc leave the card as it was", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    say("half a thought");
    root.querySelector<HTMLButtonElement>(".card.top .card-head .head-tools .x-btn")!.click();
    expect(sheet()?.getAttribute("aria-label")).toBe("Why reject?");
    expect(sheet()!.querySelector(".sheet-where")?.textContent).toBe("Card a");
    expect([...sheet()!.querySelectorAll(".sheet-foot .btn")].map((button) => button.textContent)).toEqual(["Cancel", "Reject"]);
    expect(why().value).toBe("half a thought");
    expect(document.activeElement).toBe(why());
    expect(send().disabled).toBe(false);
    type("   ");
    expect(send().disabled).toBe(true);
    type("Too dark, and not my words");
    expect(send().disabled).toBe(false);

    sheet()!.querySelector<HTMLButtonElement>(".sheet-foot .btn:not(.reject-send)")!.click();
    expect(sheet()).toBeNull();
    expect(topId()).toBe("a");
    expect(cardState("a").text).toBe("half a thought");
    expect(root.querySelector<HTMLTextAreaElement>(".actions .say-text")!.value).toBe("half a thought");

    say("");
    root.querySelector<HTMLButtonElement>(".card.top .x-btn")!.click();
    expect(why().value).toBe("");
    expect(send().disabled).toBe(true);
    key("keydown", "Escape");
    key("keyup", "Escape");
    expect(sheet()).toBeNull();
    await settle(6000);
    flushHeld();
    await settle(0);
    expect(posts).toEqual([]);
    expect(topId()).toBe("a");
  });

  it("Reject sends a reject with the typed words as his own, held for Undo", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    root.querySelector<HTMLButtonElement>(".card.top .x-btn")!.click();
    type("Not before the age checks have an owner");
    send().click();
    expect(sheet()).toBeNull();
    expect(topId()).toBe("b");
    expect(root.querySelector(".toast.undo strong")?.textContent).toBe("Rejected");
    await settle(4900);
    expect(posts).toEqual([]);
    await settle(200);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "a", decision: "reject", rev: "a1", text: "Not before the age checks have an owner" }]);
  });

  it("a Left arrow opens it too, and sends nothing until Reject", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    key("keydown", "x");
    key("keyup", "x");
    expect(sheet()).not.toBeNull();
    await settle(6000);
    flushHeld();
    await settle(0);
    expect(posts).toEqual([]);
    expect(topId()).toBe("a");
    type("Wrong page");
    send().click();
    await settle(5100);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "a", decision: "reject", text: "Wrong page" }]);
  });

  it("an Agents ticket's Escape or Back closes the popup first, through closeAnswerSheet", async () => {
    needs = [need("a", "a1")];
    await signIn();
    expect(closeAnswerSheet()).toBe(false);
    root.querySelector<HTMLButtonElement>(".card.top .x-btn")!.click();
    expect(sheet()).not.toBeNull();
    expect(closeAnswerSheet()).toBe(true);
    expect(sheet()).toBeNull();
    expect(closeAnswerSheet()).toBe(false);
    expect(topId()).toBe("a");
  });

  it("a todo card has the X too, so one that is way off is rejected with a why (it has no Dismiss)", async () => {
    needs = [{ ...need("t", "t1"), kind: "todo", steps: ["Open the page"] }, need("b", "b1")];
    await signIn();
    root.querySelector<HTMLButtonElement>(".card.top .card-head .x-btn")!.click();
    document.querySelector<HTMLTextAreaElement>(".reject-sheet .sheet-text")!.value = "Not needed any more";
    document.querySelector<HTMLTextAreaElement>(".reject-sheet .sheet-text")!.dispatchEvent(new Event("input"));
    document.querySelector<HTMLButtonElement>(".reject-sheet .reject-send")!.click();
    expect(topId()).toBe("b");
    await settle(5100);
    expect(posts.map((post) => post.body)).toMatchObject([{ itemId: "t", decision: "reject", text: "Not needed any more" }]);
  });
});

describe("Minimise on Feed cards", () => {
  const long = (): ServedNeed => ({ ...need("a", "a1", "A long ask. ".repeat(40)), options: [{ label: "Yes" }, { label: "No" }] });

  it("a Needs you card has Minimise at its top and under its last line; minimising it moves on to the next card, open with its answers", async () => {
    needs = [long(), need("b", "b1")];
    await signIn();
    const card = root.querySelector<HTMLElement>(".card.top")!;
    const head = [...card.querySelector(".card-head")!.children];
    expect([...head.at(-1)!.children].map((child) => child.textContent || child.getAttribute("title"))).toEqual(["−", "Reject"]);
    const body = card.querySelector(".card-body")!;
    expect(body.lastElementChild?.lastElementChild?.matches(".min-btn.bottom")).toBe(true);
    body.querySelector<HTMLButtonElement>(".min-btn.bottom")!.click();
    // The next card, with its answers.
    expect([topId(), root.querySelector(".card.top.minimised"), root.querySelector(".card.top .card-ask") !== null, actionButton("Approve").isConnected]).toEqual(["b", null, true, true]);
    expect(root.querySelector('.decide-seg[data-seg="open"]')?.textContent).toBe(openTab(1));
  });

  it("with every card minimised, the heading says they wait, and Show them › is a button that opens the first", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    minimised = [["a", "a1"], ["b", "b1"]];
    const served = { needsYou: 0, minimised: 2, asks: { inHand: 0, noTime: 0, moved: 0 }, nextDoneAt: null };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => (String(input) === "/api/summary" ? Promise.resolve(json(served)) : fakeFetch(input, init))));
    await signIn();
    toSegment("needs");
    expect(root.querySelector(".decide-none-line")?.textContent).toBe("2 cards wait for you, all minimised.");
    const tap = root.querySelector<HTMLButtonElement>(".decide-none .clear-show .clear-min")!;
    expect([tap.textContent, tap.type]).toEqual(["Show them ›", "button"]);
    tap.click();
    expect([topId(), root.querySelector(".card.top.minimised")]).toEqual(["a", null]);
  });

  it("minimises with the say-line focused, keeping its words for when it opens again, and sends nothing", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    const text = root.querySelector<HTMLTextAreaElement>(".deck .say-text")!;
    text.focus();
    say("half a thought");
    root.querySelector<HTMLButtonElement>(".card.top .min-btn.top")!.click();
    expect(topId()).toBe("b");
    await settle(5100);
    expect(posts).toEqual([]);
    showCard("a");
    await settle(0);
    expect(topId()).toBe("a");
    expect(root.querySelector<HTMLTextAreaElement>(".deck .say-text")!.value).toBe("half a thought");
  });

  it("stays minimised over a swipe away, a poll and a restart, and opens again on a new revision", async () => {
    needs = [need("a", "a1")];
    await signIn();
    root.querySelector<HTMLButtonElement>(".card.top .min-btn.top")!.click();
    await settle(0);
    expect(minimised).toEqual([["a", "a1"]]);
    const waits = () => root.querySelector(".decide-none-line")?.textContent;
    expect(waits()).toBe("1 card waits for you, minimised.");
    app.tab = "chat";
    changed();
    app.tab = "cards";
    changed();
    await poll();
    toSegment("needs");
    expect(waits()).toBe("1 card waits for you, minimised.");
    // A restart: a fresh sign-in reads what the server kept.
    signOut();
    await signIn();
    toSegment("needs");
    expect(waits()).toBe("1 card waits for you, minimised.");
    needs = [need("a", "a2", "Changed ask")];
    await poll();
    expect(root.querySelector(".card.top.minimised")).toBeNull();
    expect(root.querySelector(".card.top .card-ask")?.textContent).toBe("Changed ask");
  });

  it("a minimised card leaves the Feed badge and the app badge until it opens or changes", async () => {
    // A phone has no Cards badge since the home screen; the app badge is its count that leaves a minimised card out.
    let badge = 0;
    const feedBadge = () => (badge ? String(badge) : null);
    const appBadge = vi.fn((n: number) => {
      badge = n;
      return Promise.resolve();
    });
    const appClear = vi.fn(() => Promise.resolve(void (badge = 0)));
    Object.defineProperty(navigator, "setAppBadge", { value: appBadge, configurable: true });
    Object.defineProperty(navigator, "clearAppBadge", { value: appClear, configurable: true });
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    expect(feedBadge()).toBe("2");
    root.querySelector<HTMLButtonElement>(".card.top .min-btn.top")!.click();
    expect(feedBadge()).toBe("1");
    expect(appBadge).toHaveBeenLastCalledWith(1);
    expect(topId()).toBe("b");
    showCard("a");
    expect(feedBadge()).toBe("2");
    expect(appBadge).toHaveBeenLastCalledWith(2);
    // Both minimised: no red number, and the home-screen count clears.
    root.querySelector<HTMLButtonElement>(".card.top .min-btn.top")!.click();
    needs = [need("a", "a1")];
    await poll();
    expect(feedBadge()).toBeNull();
    expect(appClear).toHaveBeenCalled();
    // A new revision opens it again and counts it again.
    needs = [need("a", "a2", "Changed ask")];
    await poll();
    expect(feedBadge()).toBe("1");
    expect(appBadge).toHaveBeenLastCalledWith(1);
    Reflect.deleteProperty(navigator, "setAppBadge");
    Reflect.deleteProperty(navigator, "clearAppBadge");
  });

});

describe("no jump, freshness and offline", () => {
  it("says when it cannot reach Rivet, with a Retry that refreshes", async () => {
    needs = [need("a", "a1")];
    await signIn();
    failing.add("/api/board");
    await poll();
    const bar = root.querySelector<HTMLElement>('.feed-offline[role="status"]')!;
    expect(bar.textContent).toMatch(/^Can't reach Rivet Agents · cards as of (?:[A-Z][a-z]{2} )?\d{1,2}:\d\d[ap]mRetry$/);
    expect(root.querySelector(".card.top")?.getAttribute("data-need")).toBe("a");
    failing.clear();
    bar.querySelector<HTMLButtonElement>(".feed-retry")!.click();
    await settle(0);
    expect(root.querySelector(".feed-offline")).toBeNull();
  });
});

describe("the cheer for the last card", () => {
  /** The cheer's heading, else what the pane says once it rests with no card open. */
  const title = () => root.querySelector(".clear-title, .decide-none-line, p.decide-none")?.textContent;
  const happy = () => root.querySelector(".clear-rivet")?.classList.contains("is-happy");

  it("answering the last waiting card cheers with confetti for a few seconds, then the home screen comes back by itself", async () => {
    needs = [need("a", "a1"), need("b", "b1")];
    await signIn();
    actionButton("Approve").click();
    expect(root.querySelector(".clear")).toBeNull();
    await settle(TAP_LOCK_MS);
    actionButton("Approve").click();
    expect(title()).toBe("You cleared them all!");
    expect(happy()).toBe(true);
    expect(root.querySelector(".clear-lede")?.textContent).toBe(NOTHING_NEEDS_YOU);
    expect(root.querySelector(".clear-cheer .clear-confetti")).not.toBeNull();
    // Both answers count while they are still in their Undo window.
    // The answer landing mid-cheer redraws it without ending it.
    flushHeld();
    await settle(0);
    expect(title()).toBe("You cleared them all!");
    await settle(4000);
    expect(app.tab).toBe("progress");
    expect(root.querySelector(".view.decide-pane")).toBeNull();
    expect(root.querySelector(".clear-confetti")).toBeNull();
  });

  it("shows over waiting updates, then the home screen comes back with the news on it", async () => {
    needs = [need("a", "a1"), { id: "u", kind: "update", title: "News u", thread: "Reports", rev: "1".repeat(16) } as ServedNeed];
    await signIn();
    actionButton("Approve").click();
    expect(title()).toBe("You cleared them all!");
    expect(root.querySelector(".feed-quiet")).toBeNull();
    await settle(4000);
    expect(root.querySelector(".clear-confetti")).toBeNull();
    expect(app.tab).toBe("progress");
  });

  it("never cheers on load or when the board was already empty, nor when a poll takes the last card", async () => {
    needs = [];
    await signIn();
    toSegment("needs");
    expect(title()).toBe(NOTHING_NEEDS_YOU);
    expect(root.querySelector(".clear-confetti")).toBeNull();
    needs = [need("a", "a1")];
    await poll();
    expect(root.querySelector(".clear")).toBeNull();
    needs = [];
    await poll();
    expect(title()).toBe(NOTHING_NEEDS_YOU);
    expect(root.querySelector(".clear-confetti")).toBeNull();
  });

  it("Undo takes the cheer back with the answer", async () => {
    needs = [need("a", "a1")];
    await signIn();
    actionButton("Approve").click();
    expect(title()).toBe("You cleared them all!");
    root.querySelector<HTMLButtonElement>(".toast.undo .undo-btn")!.click();
    expect(root.querySelector(".clear")).toBeNull();
    needs = [];
    await poll();
    expect(title()).toBe(NOTHING_NEEDS_YOU);
  });

  it("a minimised card arriving mid-cheer ends it: the heading says it waits, with Show it ›", async () => {
    needs = [need("a", "a1")];
    await signIn();
    actionButton("Approve").click();
    expect(title()).toBe("You cleared them all!");
    needs = [need("b", "b1")];
    minimised = [["b", "b1"]];
    await poll();
    expect(title()).toBe("1 card waits for you, minimised.");
    expect(root.querySelector(".clear-min")?.textContent).toBe("Show it ›");
    expect(root.querySelector(".clear-confetti")).toBeNull();
    expect(root.querySelector(".clear-lede")).toBeNull();
  });

  it("with reduced motion it still says the words, with no confetti", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    needs = [need("a", "a1")];
    await signIn();
    actionButton("Approve").click();
    expect(title()).toBe("You cleared them all!");
    expect(root.querySelector(".clear-lede")?.textContent).toBe(NOTHING_NEEDS_YOU);
    expect(root.querySelector(".clear-confetti")).toBeNull();
    expect(happy()).toBe(true);
  });
});
