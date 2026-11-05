// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnsweredCard, AnsweredResponse } from "../src/shared/answered.js";
import type { Reply, ServedNeed } from "../src/shared/board.js";
import { dayHeading } from "../src/shared/when.js";
import { answeredTab, CHAT_TOLD, NO_ANSWERED, noAnsweredIn, openTab, reopenedBand, SEND_AGAIN, youAnswered, type ChatTold } from "../src/shared/words.js";
import { app, changed, refresh, resetSession } from "../web/src/state.js";
import { resetAnsweredFilters, showAnswered } from "../web/src/views/answered.js";
import { resetFeed } from "../web/src/views/feed.js";
import { isDesk } from "../web/src/desk.js";
import { mountShell } from "../web/src/views/shell.js";
import { stubCanvas } from "./canvas-stub.js";

// Cards › Answered: the Open | Answered switch, its rows, Reopen, and the band on a reopened card,
// against a fake server serving GET /api/answered, the card's Answer again and Send again. On a phone the switch is the
// Decide sheet's over the home screen; on the computer, the Decide pane's
// in the middle column.

const DAY = 24 * 3600_000;
const HOUR = 3600_000;
let needs: ServedNeed[] = [];
let answered: AnsweredCard[] = [];
let reopened: AnsweredResponse["reopened"] = [];
/** How a Reopen made by the fake server's Answer again stands with its chat. */
let told: ChatTold = "telling";
let merged = false;
/** How many reads of GET /api/answered, and of Send again, fail before one goes through. */
let answeredFails = 0;
let sendFails = 0;
let againPosts: { id: string; rev: string }[] = [];
let sendPosts: string[] = [];
let root: HTMLElement;
let unmount: (() => void) | null = null;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function entry(id: string, at: number, extra: Partial<Reply> = {}, pr?: number): AnsweredCard {
  const card: ServedNeed = { id, kind: "decision", title: `Card ${id}`, ask: `Ask ${id}`, chat: `chat-${id}`, rev: `${id}-1`, ...(pr ? { pr } : {}) };
  const reply: Reply = {
    id: `r-${id}`,
    itemId: id,
    itemTitle: card.title,
    decision: "approve",
    rev: card.rev,
    at: new Date(at).toISOString(),
    handled: true,
    item: { id, title: card.title, kind: "decision", chat: card.chat },
    delivery: { target: "chat", chat: card.chat!, at: new Date(at).toISOString() },
    ...extra,
  };
  return { card, reply };
}

function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = String(input);
  if (url === "/api/board") {
    const board = { updatedAt: "2026-10-26T00:00:00.000Z", needs, coming: [], chats: [], shipped: [] };
    return Promise.resolve(json({ version: 1, updatedAt: board.updatedAt, board }));
  }
  if (url === "/api/answered") {
    if (answeredFails > 0 && answeredFails--) return Promise.resolve(json({ error: "down" }, 503));
    return Promise.resolve(json({ cards: answered, reopened } satisfies AnsweredResponse));
  }
  const again = /^\/api\/board\/needs\/([^/]+)\/again$/.exec(url);
  if (again && init.method === "POST") {
    const id = again[1]!;
    const { rev } = JSON.parse(String(init.body)) as { rev: string };
    againPosts.push({ id, rev });
    const was = answered.find((one) => one.card.id === id);
    if (!was || was.card.rev !== rev) return Promise.resolve(json({ error: "this card changed; look again" }, 409));
    answered = answered.filter((one) => one !== was);
    const item = { ...was.card, rev: `${id}-2` };
    needs = [...needs, item];
    const at = new Date().toISOString();
    reopened = [
      ...reopened,
      {
        id: `reopen-${id}`,
        cardId: id,
        rev: item.rev,
        at,
        replyId: was.reply.id,
        title: item.title,
        repo: "example-org/example-repo",
        earlier: was.reply,
        ...(merged ? { merged: true as const } : {}),
        ...(told === "told" ? { delivery: { at } } : told === "unconfirmed" ? { delivery: { at, confirmed: false } } : told === "not-told" ? { expired: true as const } : {}),
      },
    ];
    return Promise.resolve(json({ version: 2, item }));
  }
  if (url === "/api/answered/reopen-send" && init.method === "POST") {
    const { id } = JSON.parse(String(init.body)) as { id: string };
    sendPosts.push(id);
    if (sendFails > 0 && sendFails--) return Promise.resolve(json({ error: "could not send it" }, 503));
    reopened = reopened.map((one) => (one.id === id ? (({ expired: _expired, ...rest }) => ({ ...rest, sentAt: new Date().toISOString() }))(one) : one));
    return Promise.resolve(json(reopened.find((one) => one.id === id)));
  }
  if (url === "/api/status") return Promise.resolve(json({ board: { version: 1, updatedAt: null }, bridge: { connected: true, lastSeenAt: null } }));
  if (url.startsWith("/api/replies")) return Promise.resolve(json({ replies: [] }));
  return Promise.resolve(json({}, 404));
}

async function settle(ms = 300): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** What main.ts does on sign-in, landing on Cards: on a phone, the Decide sheet over the home screen. */
async function signIn(): Promise<void> {
  unmount?.();
  resetFeed();
  resetSession();
  app.tab = "cards";
  unmount = mountShell(root);
  await refresh();
  await settle();
}

const seg = (name: "needs" | "done") => document.querySelector<HTMLButtonElement>(`.decide-segs .decide-seg[data-seg="${name === "needs" ? "open" : "answered"}"]`)!;
/** The switch's side on screen. */
const side = () => (seg("done").getAttribute("aria-pressed") === "true" ? "done" : "needs");
const rows = () => [...document.querySelectorAll<HTMLElement>(".ans-row")];
const row = (id: string) => document.querySelector<HTMLElement>(`.ans-row[data-card="${id}"]`)!;
const topCard = () => document.querySelector<HTMLElement>(".decide-card [data-need]");
const band = () => topCard()?.querySelector<HTMLElement>(".ans-reopened") ?? null;
const topId = () => topCard()?.dataset.need;

async function toAnswered(): Promise<void> {
  seg("done").click();
  await settle();
}

async function reopenRow(id: string): Promise<void> {
  row(id).querySelector<HTMLButtonElement>(".ans-reopen")!.click();
  await settle(1000);
}

beforeEach(() => {
  // Noon in: fixtures dated minutes or hours "ago" stay on the same local day, whenever CI runs (main run 40694019454 began 00:12).
  vi.useFakeTimers({ now: new Date("2026-10-28T01:00:00.000Z"), toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  stubCanvas();
  localStorage.clear();
  localStorage.setItem("rivet.installHint", "dismissed");
  // The whole list, as before the time chips; the chips' own tests start from a fresh device.
  localStorage.setItem("rivet.answered.window", "all");
  resetAnsweredFilters();
  const now = Date.now();
  needs = [{ id: "open-1", kind: "approval", title: "Card open-1", ask: "Ask open-1", rev: "open-1-1" }];
  answered = [
    entry("banner", now - 40 * 60_000, { decision: "choice", choice: "Yes, keep it" }, 3990),
    entry("pear", now - 62 * 60_000, { decision: "choice", choice: "Change it", text: "slower, 2 s", delivery: { target: "chat", chat: "chat-pear", at: new Date(now).toISOString(), confirmed: false } }),
    entry("billing", now - DAY - 60_000),
  ];
  reopened = [];
  told = "telling";
  merged = false;
  answeredFails = 0;
  sendFails = 0;
  againPosts = [];
  sendPosts = [];
  app.front = null;
  root = document.createElement("main");
  document.body.replaceChildren(root);
});

afterEach(() => {
  unmount?.();
  unmount = null;
  resetFeed();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Cards › Answered", () => {
  it("the switch reads Open N | Answered N, and Answered lists the answers newest first under their days", async () => {
    await signIn();
    expect(seg("needs").textContent).toBe(openTab(1));
    expect(seg("done").textContent).toBe(answeredTab(3));
    await toAnswered();
    expect(side()).toBe("done");
    expect(rows().map((one) => one.dataset.card)).toEqual(["banner", "pear", "billing"]);
    expect([...document.querySelectorAll(".ans-day")].map((day) => day.textContent)).toEqual([answered[0]!.reply.at, answered[2]!.reply.at].map((at) => dayHeading(at)));
  });

  it("a row is its title, You: <answer> · <time>, where the answer got to, and Reopen", async () => {
    await signIn();
    await toAnswered();
    const pear = row("pear");
    expect(pear.querySelector(".ans-t")?.textContent).toBe("Card pear");
    expect(pear.querySelector(".ans-you")?.textContent).toBe(youAnswered("Change it “slower, 2 s”", answered[1]!.reply.at));
    expect(pear.querySelector(".ans-word")?.textContent).toBe("Change it “slower, 2 s”");
    expect(pear.querySelector(".ans-state")?.classList.contains("warn")).toBe(true);
    expect(pear.querySelector(".ans-reopen")?.textContent).toBe("Reopen");
    expect(row("billing").querySelector(".ans-you")?.textContent).toBe(youAnswered("Yes", answered[2]!.reply.at));
  });

  it("with nothing answered in 30 days it says so", async () => {
    answered = [];
    await signIn();
    expect(seg("done").textContent).toBe(answeredTab(0));
    await toAnswered();
    expect(document.querySelector(".ans-empty")?.textContent).toBe(NO_ANSWERED);
    expect(rows()).toHaveLength(0);
  });

  it("Reopen opens the card again as a new revision, on top of Open, with its band", async () => {
    await signIn();
    await toAnswered();
    const at = answered[0]!.reply.at;
    await reopenRow("banner");
    expect(againPosts).toEqual([{ id: "banner", rev: "banner-1" }]);
    expect(side()).toBe("needs");
    expect(topId()).toBe("banner");
    expect(seg("needs").textContent).toBe(openTab(2));
    expect(seg("done").textContent).toBe(answeredTab(2));
    const reopen = reopened[0]!;
    expect(band()?.querySelector(".ans-band-line")?.textContent).toBe(`${reopenedBand(reopen.at, "Yes, keep it")} ${CHAT_TOLD.telling}`);
    expect(band()?.dataset.told).toBe("telling");
    expect(at).toBe(reopen.earlier!.at);
  });

  it.each(["told", "unconfirmed", "not-told"] as const)("the band says %s with its chat's line", async (state) => {
    told = state;
    await signIn();
    await toAnswered();
    await reopenRow("banner");
    expect(band()?.dataset.told).toBe(state);
    expect(band()?.querySelector(".ans-told")?.textContent).toBe(CHAT_TOLD[state]);
    expect(band()?.querySelector(".ans-send") !== null).toBe(state === "not-told");
  });

  it("not told offers Send again, which sends the notice and the band turns", async () => {
    told = "not-told";
    await signIn();
    await toAnswered();
    await reopenRow("banner");
    const send = band()!.querySelector<HTMLButtonElement>(".ans-send")!;
    expect(send.textContent).toBe(SEND_AGAIN);
    send.click();
    await settle();
    expect(sendPosts).toEqual(["reopen-banner"]);
    expect(band()?.dataset.told).toBe("telling");
    expect(band()?.querySelector(".ans-send")).toBeNull();
  });

  it("a telling band turns to told by itself once its chat hears", async () => {
    await signIn();
    await toAnswered();
    await reopenRow("banner");
    expect(band()?.dataset.told).toBe("telling");
    reopened = reopened.map((one) => ({ ...one, delivery: { at: new Date().toISOString() } }));
    await settle(11_000);
    expect(band()?.dataset.told).toBe("told");
  });

  it("a read that failed is tried again, with nothing else changing", async () => {
    answeredFails = 1;
    await signIn();
    await toAnswered();
    expect(rows()).toHaveLength(0);
    expect(document.querySelector(".ans")?.getAttribute("aria-busy")).toBe("true");
    await settle(11_000);
    expect(rows().map((one) => one.dataset.card)).toEqual(["banner", "pear", "billing"]);
  });

  it("a Send again that failed can be pressed again", async () => {
    told = "not-told";
    sendFails = 1;
    await signIn();
    await toAnswered();
    await reopenRow("banner");
    band()!.querySelector<HTMLButtonElement>(".ans-send")!.click();
    await settle();
    expect(sendPosts).toEqual(["reopen-banner"]);
    expect(band()?.querySelector<HTMLButtonElement>(".ans-send")?.disabled).toBe(false);
    band()!.querySelector<HTMLButtonElement>(".ans-send")!.click();
    await settle();
    expect(sendPosts).toEqual(["reopen-banner", "reopen-banner"]);
    expect(band()?.dataset.told).toBe("telling");
  });

  it("a search hit lights its answer's row; an answer the list does not hold shows as its own row, without Reopen", async () => {
    await signIn();
    showAnswered(answered[1]!.reply);
    await settle();
    expect(document.querySelector<HTMLElement>(".ans-row.found")?.dataset.card).toBe("pear");
    // An earlier answer to a card answered again since: the list holds only the newest.
    const earlier = entry("banner", Date.now() - 2 * DAY, { id: "r-banner-0", decision: "reject" }).reply;
    showAnswered(earlier);
    await settle();
    const found = document.querySelector<HTMLElement>(".ans-row.found")!;
    expect(found.dataset.reply).toBe("r-banner-0");
    expect(found.querySelector(".ans-you")?.textContent).toBe(youAnswered("No", earlier.at));
    expect(found.querySelector(".ans-reopen")).toBeNull();
    expect(rows().map((one) => one.dataset.reply)).toEqual(["r-banner", "r-pear", "r-billing", "r-banner-0"]);
  });

  it("a search hit for an answer after Open was tapped in the Decide sheet lands on Answered again, its row lit", async () => {
    await signIn();
    expect(isDesk()).toBe(false);
    showAnswered(answered[1]!.reply);
    await settle();
    expect(side()).toBe("done");
    seg("needs").click();
    await settle();
    expect(side()).toBe("needs");
    showAnswered(answered[0]!.reply);
    await settle();
    expect(side()).toBe("done");
    expect(document.querySelector<HTMLElement>(".ans-row.found")?.dataset.card).toBe("banner");
  });

  it("a card that changed meanwhile is not reopened, and stays on Answered", async () => {
    await signIn();
    await toAnswered();
    answered = answered.map((one) => (one.card.id === "banner" ? { ...one, card: { ...one.card, rev: "banner-9" } } : one));
    await reopenRow("banner");
    expect(againPosts).toHaveLength(1);
    expect(document.querySelector(".toast.flash")?.textContent).toBe("this card changed; look again");
    expect(side()).toBe("done");
    expect(band()).toBeNull();
  });
});

describe("Cards › Answered: time chips and Show done", () => {
  const chip = (window: string) => document.querySelector<HTMLButtonElement>(`.ans-chip[data-window="${window}"]`)!;
  const doneSwitch = () => document.querySelector<HTMLButtonElement>(".ans-done")!;
  const ids = () => rows().map((one) => one.dataset.card);

  beforeEach(() => {
    localStorage.removeItem("rivet.answered.window");
    resetAnsweredFilters();
    const now = Date.now();
    answered = [
      { ...entry("banner", now - 40 * 60_000), done: true },
      entry("pear", now - 62 * 60_000),
      entry("cache", now - 15 * HOUR),
      { ...entry("banana", now - 40 * HOUR), done: true },
      entry("maple", now - 3 * DAY),
    ];
  });

  it("opens on 24h with Show done off, and Answered N counts the rows they leave", async () => {
    await signIn();
    await toAnswered();
    expect(chip("24").getAttribute("aria-pressed")).toBe("true");
    expect(doneSwitch().getAttribute("aria-checked")).toBe("false");
    expect(ids()).toEqual(["pear", "cache"]);
    expect(seg("done").textContent).toBe(answeredTab(2));
  });

  it("a chip keeps the answers inside its hours, All the whole list, and Show done brings the finished ones back", async () => {
    await signIn();
    await toAnswered();
    chip("6").click();
    await settle();
    expect(ids()).toEqual(["pear"]);
    expect(seg("done").textContent).toBe(answeredTab(1));
    chip("all").click();
    await settle();
    expect(ids()).toEqual(["pear", "cache", "maple"]);
    doneSwitch().click();
    await settle();
    expect(doneSwitch().getAttribute("aria-checked")).toBe("true");
    expect(ids()).toEqual(["banner", "pear", "cache", "banana", "maple"]);
    expect(seg("done").textContent).toBe(answeredTab(5));
  });

  it("the chip and Show done are remembered on the device", async () => {
    await signIn();
    await toAnswered();
    chip("48").click();
    await settle();
    doneSwitch().click();
    await settle();
    expect(localStorage.getItem("rivet.answered.window")).toBe("48");
    expect(localStorage.getItem("rivet.answered.done")).toBe("1");
    resetAnsweredFilters();
    await signIn();
    await toAnswered();
    expect(chip("48").getAttribute("aria-pressed")).toBe("true");
    expect(ids()).toEqual(["banner", "pear", "cache", "banana"]);
  });

  it("picking a chip or Show done lets go of a search hit they would not keep", async () => {
    await signIn();
    showAnswered(answered[4]!.reply);
    await settle();
    expect(ids()).toEqual(["pear", "cache", "maple"]);
    chip("6").click();
    await settle();
    expect(ids()).toEqual(["pear"]);
    showAnswered(answered[0]!.reply);
    await settle();
    expect(ids()).toEqual(["banner", "pear"]);
    doneSwitch().click();
    doneSwitch().click();
    await settle();
    expect(ids()).toEqual(["pear"]);
  });

  it("with nothing else changing, a row goes once its answer is older than the chip's hours", async () => {
    await signIn();
    await toAnswered();
    chip("6").click();
    await settle();
    expect(ids()).toEqual(["pear"]);
    const start = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => start + 5 * HOUR);
    await settle(5 * HOUR);
    expect(ids()).toEqual([]);
    expect(seg("done").textContent).toBe(answeredTab(0));
  });

  it("a card whose work finished meanwhile leaves within a minute, though no poll changed", async () => {
    await signIn();
    await toAnswered();
    expect(ids()).toEqual(["pear", "cache"]);
    answered = answered.map((one) => (one.card.id === "pear" ? { ...one, done: true } : one));
    await settle(61_000);
    expect(ids()).toEqual(["cache"]);
    expect(seg("done").textContent).toBe(answeredTab(1));
  });

  it("says why no row is left: none in the chip's hours, or each one there done", async () => {
    answered = [{ ...entry("banner", Date.now() - 40 * 60_000), done: true }];
    await signIn();
    await toAnswered();
    chip("6").click();
    await settle();
    expect(document.querySelector(".ans-empty")?.textContent).toBe(noAnsweredIn(6, 1));
    expect(seg("done").textContent).toBe(answeredTab(0));
    answered = [];
    await signIn();
    await toAnswered();
    expect(document.querySelector(".ans-empty")?.textContent).toBe(noAnsweredIn(6, 0));
  });
});

describe("Cards › Answered on the computer", () => {
  beforeEach(() => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) => ({ matches: true, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }) as unknown as MediaQueryList,
    );
  });

  it("the switch sits in the middle pane, and Answered keeps its Reopen, its chips and Show done there", async () => {
    await signIn();
    const pane = root.querySelector<HTMLElement>(".view.decide-pane");
    expect(pane?.querySelector(".decide-segs")).not.toBeNull();
    expect(document.querySelector(".decide-sheet")).toBeNull();
    expect(topId()).toBe("open-1");
    await toAnswered();
    expect(side()).toBe("done");
    expect(pane?.querySelectorAll(".ans-row").length).toBe(3);
    expect(pane?.querySelector(".ans-chip")).not.toBeNull();
    expect(pane?.querySelector(".ans-done")).not.toBeNull();
    await reopenRow("pear");
    expect(againPosts).toEqual([{ id: "pear", rev: "pear-1" }]);
    expect(side()).toBe("needs");
    expect(topId()).toBe("pear");
    expect(band()).not.toBeNull();
  });

  it("a search hit for an answer from the wide home screen opens the pane on Answered, its row lit", async () => {
    await signIn();
    app.tab = "progress";
    changed();
    await settle();
    expect(root.querySelector(".view.decide-pane")).toBeNull();
    showAnswered(answered[1]!.reply);
    await settle();
    expect(side()).toBe("done");
    expect(root.querySelector<HTMLElement>(".view.decide-pane .ans-row.found")?.dataset.card).toBe("pear");
  });

  it("a search hit for an answer the list does not hold shows in the pane's Answered list", async () => {
    await signIn();
    const old = entry("maple", Date.now() - 40 * DAY, { decision: "reject" }, 3971).reply;
    showAnswered(old);
    await settle();
    expect(side()).toBe("done");
    const hit = root.querySelector<HTMLElement>('.view.decide-pane .ans-row[data-reply="r-maple"]');
    expect(hit?.classList.contains("found")).toBe(true);
    expect(hit?.querySelector(".ans-reopen")).toBeNull();
  });
});
