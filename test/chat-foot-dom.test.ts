// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../src/shared/command.js";
import { logFeed } from "../src/shared/log-feed.js";
import type { Worker } from "../src/shared/workers.js";
import * as cmd from "../web/src/command-api.js";
import { fakeServer } from "./conversations-fake.js";

vi.mock("../web/src/voice.js", async (original) => ({
  ...((await original()) as Record<string, unknown>),
  say: () => {},
  unlockVoice: () => Promise.resolve(true),
  unlockOnTap: () => () => {},
  stopVoice: () => {},
}));

const chat = await import("../web/src/views/chat.js");
const { holdFoot } = await import("../web/src/views/hold-foot.js");
const { openTarget } = await import("../web/src/views/search.js");
const { closeWorkerSheet, openWorkerSheet } = await import("../web/src/views/worker-sheet.js");

class FakeSource {
  static CLOSED = 2;
  readyState = 1;
  addEventListener() {}
  close() {}
}

/** happy-dom lays nothing out or reports sizes: each observer is kept, to be told when something it watches grows. */
class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  targets = new Set<Element>();
  constructor(private readonly told: ResizeObserverCallback) {
    FakeResizeObserver.all.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
  static watching(target: Element) {
    return FakeResizeObserver.all.some((one) => one.targets.has(target));
  }
  static grew(target: Element) {
    for (const one of FakeResizeObserver.all) if (one.targets.has(target)) one.told([], one as unknown as ResizeObserver);
  }
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const message = (id: string, threadId: string, n: number, text = `Message ${id}`, year = 2030): ChatMessage => ({
  id,
  from: n % 2 ? "rivet" : "owner",
  text,
  at: new Date(Date.UTC(year, 0, 1, 0, 0, n)).toISOString(),
  threadId,
});
const MESSAGES = [message("m1", "m1", 0, "Morning"), message("m2", "m1", 1, "Morning. Three things building.")];
// More than one page (THREAD_MESSAGES_MAX, 300): Earlier messages has the rest.
const LONG = Array.from({ length: 400 }, (_, i) => message(`a${String(i).padStart(3, "0")}`, "a", i, undefined, 2029));

// The chat on a narrow phone, as Chrome measured it: it shows 414 px of a thread that stood 3910 px when it
// scrolled to its newest, and 4185 px some 20 ms later.
const SHOWN = 414;
let tall = 3910;
/** When set, the thread stands this many px a message, so loading earlier ones makes it taller. */
let perMessage = 0;
/** The Rivet sheet put away: the scroller is display:none. */
let hidden = false;
let top = 0;
let root: HTMLElement;
let restore: (() => void)[] = [];

const scrolls = (el: HTMLElement) => el.classList.contains("chat-scroll") || el.classList.contains("cmd-log");
/** More topics and search hide the scroller too (conversations.css). Hidden, it reads 0; here it also comes back at its top, as an engine may drop the offset of a display:none box. */
const unseen = (el: HTMLElement) => {
  const gone = hidden || !!el.closest(".chat.topics, .chat.searching");
  if (gone) top = 0;
  return gone;
};
/** Where the scroller's top is on the page, and how tall a card's foot (More, Reply) stands, with perMessage set. */
const HEAD = 60;
let foot = 0;
/** Each card and shown line in the thread, from its top to its bottom. */
function laidOut(): Map<Element, [number, number]> {
  const at = new Map<Element, [number, number]>();
  let y = 0;
  for (const card of document.querySelectorAll(".chat-thread .chat-ex")) {
    const from = y;
    if (card.classList.contains("minimised")) y += perMessage;
    else {
      for (const line of card.querySelectorAll(".chat-msg")) at.set(line, [y, (y += perMessage)]);
      y += foot;
    }
    at.set(card, [from, y]);
  }
  return at;
}
const height = () => {
  if (!perMessage) return tall;
  const cards = [...laidOut().entries()].filter(([el]) => el.classList.contains("chat-ex"));
  return cards.at(-1)?.[1][1] ?? 0;
};

/** A scroller as a browser keeps it: as tall as what is in it, its scroll held between the top and the foot. */
function layOut(): void {
  const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return scrolls(this) && !unseen(this) ? height() : 0;
  });
  const client = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return scrolls(this) && !unseen(this) ? SHOWN : 0;
  });
  const read = vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(function (this: HTMLElement) {
    return scrolls(this) && !unseen(this) ? top : 0;
  });
  const write = vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(function (this: HTMLElement, value: number) {
    if (scrolls(this) && !unseen(this)) top = Math.max(0, Math.min(value, height() - SHOWN));
  });
  // With perMessage set, the scroller sits HEAD px down the page and each line at its place in the thread, less the
  // scroll; a card spans its lines and its foot, a minimised one is one line tall, and a line in it, unlaid, reads 0.
  const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const span = (from: number, to: number) => DOMRect.fromRect({ x: 0, y: from, width: 300, height: to - from });
    if (perMessage && scrolls(this as HTMLElement)) return span(HEAD, HEAD + SHOWN);
    const at = perMessage && this.closest(".chat-thread") ? laidOut().get(this) : undefined;
    return at ? span(HEAD + at[0] - top, HEAD + at[1] - top) : span(0, 0);
  });
  restore = [() => scrollHeight.mockRestore(), () => client.mockRestore(), () => read.mockRestore(), () => write.mockRestore(), () => rect.mockRestore()];
}

const scroller = () => root.querySelector<HTMLElement>(".chat-scroll")!;
const thread = () => root.querySelector<HTMLElement>(".chat-thread")!;
const gap = () => height() - top - SHOWN;
const line = (id: string) => root.querySelector<HTMLElement>(`.chat-msg[data-id="${id}"]`)!;
/** How far below the scroller's top it stands. */
const shownTop = (el: HTMLElement) => el.getBoundingClientRect().top - scroller().getBoundingClientRect().top;
/** The owner scrolls to `to`: the browser moves it, then tells the page. */
const scrollTo = (box: HTMLElement, to: number) => {
  top = to;
  box.dispatchEvent(new Event("scroll"));
};

async function open(): Promise<void> {
  chat.mount(root);
  await settle();
  root.querySelector<HTMLButtonElement>(".thing-back")?.click();
  await settle();
  expect(thread().textContent).toContain("Three things building.");
}

beforeEach(() => {
  const server = fakeServer(MESSAGES.map((one) => ({ ...one })));
  history.replaceState(null, "");
  vi.stubGlobal("fetch", vi.fn(server.fetch));
  vi.stubGlobal("EventSource", FakeSource);
  FakeResizeObserver.all = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  tall = 3910;
  perMessage = 0;
  foot = 0;
  hidden = false;
  top = 0;
  layOut();
  root = document.createElement("div");
  root.className = "home-chat";
  document.body.replaceChildren(root);
});

afterEach(() => {
  chat.unmount();
  closeWorkerSheet();
  for (const undo of restore) undo();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the chat opens on its newest message when the thread grows after it scrolled", () => {
  it("stays at its foot as the thread grows: no gap under the newest", async () => {
    await open();
    expect(gap()).toBe(0);
    // Fonts, pictures and a late layout: 275 px more thread, after the one scroll to the newest.
    tall = 4185;
    expect(gap()).toBe(275);
    FakeResizeObserver.grew(thread());
    expect(gap()).toBe(0);
    expect(top).toBe(4185 - SHOWN);
  });

  it("scrolled up by hand, the place is kept as the thread grows; back at the foot, it follows again", async () => {
    await open();
    // A few pixels up is up: the hold lets go.
    scrollTo(scroller(), tall - SHOWN - 10);
    tall = 4185;
    FakeResizeObserver.grew(thread());
    expect(top).toBe(3910 - SHOWN - 10);
    scrollTo(scroller(), 1200);
    tall = 4300;
    FakeResizeObserver.grew(thread());
    expect(top).toBe(1200);
    scrollTo(scroller(), tall - SHOWN);
    tall = 4400;
    FakeResizeObserver.grew(thread());
    expect(gap()).toBe(0);
  });

  it("scrolled up, a redraw while the chat is put away does not take hold of the foot", async () => {
    await open();
    scrollTo(scroller(), 1200);
    hidden = true;
    // The hidden scroller measures 0 from its foot, which is not the owner at the foot.
    await chat.refresh();
    // Chromium and WebKit keep the offset across display:none; the fake drops it, the harder case.
    hidden = false;
    FakeResizeObserver.grew(scroller());
    const at = top;
    expect(gap()).toBeGreaterThan(0);
    tall = 4185;
    FakeResizeObserver.grew(thread());
    expect(top).toBe(at);
  });

  const searchFor = (query: string) => {
    const input = root.querySelector<HTMLInputElement>(".chat-search-input")!;
    input.value = query;
    input.dispatchEvent(new Event("input"));
  };
  const clearSearch = () => root.querySelector<HTMLButtonElement>(".chat-search-clear")!.click();

  it("at its newest when a search covers it, Chat is at its newest again when the search is cleared", async () => {
    await open();
    expect(gap()).toBe(0);
    searchFor("three");
    expect(root.querySelector(".chat")!.classList.contains("searching")).toBe(true);
    expect(top).toBe(0);
    tall = 4185;
    await chat.refresh();
    clearSearch();
    expect(root.querySelector(".chat")!.classList.contains("searching")).toBe(false);
    expect(gap()).toBe(0);
    tall = 4300;
    FakeResizeObserver.grew(thread());
    expect(gap()).toBe(0);
  });

  const withTopic = () =>
    vi.stubGlobal("fetch", vi.fn(fakeServer([...MESSAGES, ...LONG.slice(0, 5)].map((one) => ({ ...one })), { a: { title: "Long one" } }).fetch));
  const lit = () => root.querySelector(".chat-msg.lit")?.getAttribute("data-id");
  /** Chat → More topics → a topic, at `at` on its page (its foot when null) → Back to the list. */
  async function viaTopic(at: number | null): Promise<void> {
    root.querySelector<HTMLButtonElement>(".chat-topics-open")!.click();
    await settle();
    chat.showConversation("a");
    await settle();
    expect(root.querySelector('.chat-msg[data-id="a001"]')).not.toBeNull();
    if (at !== null) scrollTo(scroller(), at);
    // happy-dom does not walk session history: the state Back lands on.
    history.replaceState({ chatScreen: "list" }, "");
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    await settle();
    expect(root.querySelector(".chat")!.classList.contains("topics")).toBe(true);
  }

  it("More topics opened from a topic's page keeps nothing of that page for Chat", async () => {
    withTopic();
    await open();
    scrollTo(scroller(), 600);
    await viaTopic(1200);
    // A search hit in Chat leaves More topics with a redraw, then jumps to it (its scroll is a stub here).
    openTarget({ type: "message", id: "m1" });
    expect(root.querySelector(".chat")!.classList.contains("topics")).toBe(false);
    expect(lit()).toBe("m1");
    // Neither the topic's 1200 nor Chat's 600 from before it: Back to the list showed Chat afresh, on its newest.
    expect(top).toBe(3910 - SHOWN);
    // The jump let go of it: growth moves nothing.
    tall = 4185;
    FakeResizeObserver.grew(thread());
    expect(top).toBe(3910 - SHOWN);
  });

  it("from its newest through a topic and back, Chat is at its newest and holds it", async () => {
    withTopic();
    await open();
    expect(gap()).toBe(0);
    await viaTopic(null);
    history.replaceState(null, "");
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    await settle();
    expect(root.querySelector(".chat")!.classList.contains("topics")).toBe(false);
    expect(thread().textContent).toContain("Three things building.");
    expect(gap()).toBe(0);
    tall = 4185;
    FakeResizeObserver.grew(thread());
    expect(gap()).toBe(0);
  });

  it("held on a topic's foot, then a search hit in Chat from the list: the jump lets go and growth leaves it there", async () => {
    withTopic();
    await open();
    await viaTopic(null);
    openTarget({ type: "message", id: "m1" });
    expect(lit()).toBe("m1");
    const at = top;
    tall = 4185;
    FakeResizeObserver.grew(thread());
    expect(top).toBe(at);
  });

  it("a search typed while the opening sheet holds the thread back leaves Chat at its newest when cleared", async () => {
    let release = () => {};
    chat.mount(root, (then) => {
      release = then;
    });
    await settle();
    searchFor("three");
    expect(root.querySelector(".chat")!.classList.contains("searching")).toBe(true);
    release();
    await settle();
    clearSearch();
    expect(thread().textContent).toContain("Three things building.");
    expect(gap()).toBe(0);
    tall = 4185;
    FakeResizeObserver.grew(thread());
    expect(gap()).toBe(0);
  });

  it("scrolled up when a search covers it, Chat is back where it was when the search is cleared, not read to its newest", async () => {
    await open();
    scrollTo(scroller(), 1200);
    searchFor("three");
    expect(top).toBe(0);
    clearSearch();
    expect(top).toBe(1200);
    expect(await chat.refresh()).toBe(false);
    tall = 4185;
    FakeResizeObserver.grew(thread());
    expect(top).toBe(1200);
  });

  it("a jump to a message lets go of the foot: the thread growing under its scroll does not take it back", async () => {
    await open();
    const at = top;
    openTarget({ type: "message", id: "m1" });
    expect(root.querySelector('.chat-msg[data-id="m1"]')!.classList.contains("lit")).toBe(true);
    tall = 4185;
    FakeResizeObserver.grew(thread());
    expect(top).toBe(at);
  });

  it("Earlier messages keeps the place: the ones above come in and the reader stays on the message they were on", async () => {
    perMessage = 50;
    vi.stubGlobal("fetch", vi.fn(fakeServer(LONG.map((one) => ({ ...one })), { a: { title: "Long one" } }).fetch));
    chat.showConversation("a");
    chat.mount(root);
    await settle();
    expect(root.querySelectorAll(".chat-msg")).toHaveLength(300);
    expect(gap()).toBe(0);
    scrollTo(scroller(), 0);
    root.querySelector<HTMLButtonElement>(".conv-earlier")!.click();
    await settle();
    expect(root.querySelectorAll(".chat-msg")).toHaveLength(400);
    // 100 messages more above: the one at the top stays at the top.
    expect(top).toBe(100 * 50);
    FakeResizeObserver.grew(thread());
    expect(top).toBe(100 * 50);
  });

  it("scrolled up on Chat, a topic card moving to the end leaves the line being read where it was", async () => {
    perMessage = 50;
    const lines = Array.from({ length: 20 }, (_, i) => message(i < 10 ? `a${i}` : `b${i - 10}`, i < 10 ? "a" : "b", i));
    const server = fakeServer(lines);
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    chat.mount(root);
    await settle();
    root.querySelector<HTMLButtonElement>(".thing-back")?.click();
    await settle();
    scrollTo(scroller(), 100);
    expect(shownTop(line("a2"))).toBe(0);
    server.messages.push(message("a10", "a", 30));
    await chat.refresh();
    await settle();
    expect(root.querySelector<HTMLElement>(".chat-ex:last-child")!.dataset.thread).toBe("a");
    expect(shownTop(line("a2"))).toBe(0);
  });

  it("on a topic's page, a line landing leaves the card whose foot he is on where it was, its cards sharing one thread", async () => {
    perMessage = 50;
    foot = 40;
    // Four cards of his question and three answers: each 240 px, its foot the last 40.
    const lines = Array.from({ length: 16 }, (_, i) => ({ ...message(`t${i}`, "t", i), from: i % 4 ? ("rivet" as const) : ("owner" as const) }));
    const server = fakeServer(lines, { t: { title: "Four rounds" } });
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    chat.showConversation("t");
    chat.mount(root);
    await settle();
    expect(root.querySelectorAll(".chat-ex")).toHaveLength(4);
    const second = root.querySelectorAll<HTMLElement>(".chat-ex")[1]!;
    scrollTo(scroller(), 450);
    expect(shownTop(second)).toBe(-210);
    server.messages.push({ ...message("t16", "t", 17), from: "rivet" });
    await chat.refresh();
    await settle();
    expect(root.querySelectorAll(".chat-msg")).toHaveLength(17);
    expect(top).toBe(450);
    expect(shownTop(second)).toBe(-210);
  });

  it("scrolled up on Chat at a topic card's foot, Earlier messages bringing an older line of it keeps the card where it was", async () => {
    perMessage = 50;
    foot = 40;
    // Chat's first page is the newest 50: a1-a10 and b0-b39. Earlier brings z0, an older topic's card, and a0.
    const lines = [
      message("z0", "z", 0),
      message("a0", "a", 1),
      ...Array.from({ length: 10 }, (_, i) => message(`a${i + 1}`, "a", 2 + i)),
      ...Array.from({ length: 40 }, (_, i) => message(`b${i}`, "b", 12 + i)),
    ];
    vi.stubGlobal("fetch", vi.fn(fakeServer(lines).fetch));
    chat.mount(root);
    await settle();
    root.querySelector<HTMLButtonElement>(".thing-back")?.click();
    await settle();
    const card = () => root.querySelector<HTMLElement>('.chat-ex[data-thread="a"]')!;
    expect(root.querySelector('.chat-msg[data-id="a0"]')).toBeNull();
    scrollTo(scroller(), 510);
    expect(shownTop(card())).toBe(-510);
    root.querySelector<HTMLButtonElement>(".conv-earlier")!.click();
    await settle();
    expect(root.querySelector('.chat-msg[data-id="z0"]')).not.toBeNull();
    expect(card().querySelector<HTMLElement>(".chat-msg")!.dataset.id).toBe("a0");
    expect(shownTop(card())).toBe(-510);
  });

  it("scrolled up on Chat, minimising the card he is reading keeps it where it was", async () => {
    perMessage = 50;
    foot = 40;
    const lines = ["a", "b", "c"].flatMap((thread, t) => Array.from({ length: 10 }, (_, i) => message(`${thread}${i}`, thread, t * 10 + i)));
    vi.stubGlobal("fetch", vi.fn(fakeServer(lines).fetch));
    chat.mount(root);
    await settle();
    root.querySelector<HTMLButtonElement>(".thing-back")?.click();
    await settle();
    const card = () => root.querySelector<HTMLElement>('.chat-ex[data-thread="b"]')!;
    scrollTo(scroller(), 540);
    expect(shownTop(card())).toBe(0);
    card().querySelector<HTMLButtonElement>(".chat-ex-chev")!.click();
    await settle();
    expect(card().classList.contains("minimised")).toBe(true);
    expect(top).toBe(540);
    expect(shownTop(card())).toBe(0);
  });

  it("closed, the chat holds nothing: its thread growing moves nothing", async () => {
    await open();
    const at = top;
    chat.unmount();
    tall = 4185;
    FakeResizeObserver.grew(thread());
    expect(top).toBe(at);
  });
});

describe("the screens that follow a log at its foot (a worker's raw log, an agent's screen)", () => {
  const worker: Worker = { id: "w1", name: "Ace Flyer", repo: "example-org/example-repo", chat: "ace-flyer", state: "working", lastOutputAt: Date.now() };

  it("a worker's raw log stays at its last line as its lines rewrap, and lets go as the feed, newest first", async () => {
    const lines = ["⏺ Bash(pnpm test)", "⎿  $ pnpm test", "⏺ Deployed 19 apps."];
    vi.spyOn(cmd, "getLogsIfChanged").mockResolvedValue({ logs: { repo: worker.repo, chat: worker.chat, lines, times: [], updatedAt: null, leaseUntil: null, feed: logFeed(lines, []) }, etag: null });
    vi.spyOn(cmd, "subscribeLogs").mockResolvedValue({ leaseUntil: "later" });
    openWorkerSheet(worker);
    await settle();
    const box = document.querySelector<HTMLElement>(".cmd-log")!;
    document.querySelector<HTMLButtonElement>(".cmd-log-raw")!.click();
    expect(box.classList.contains("is-raw")).toBe(true);
    expect(box.textContent).toBe(lines.join("\n"));
    expect(gap()).toBe(0);
    // The lines rewrap taller inside a box that keeps its size: what the hold watches is what grew.
    const text = box.querySelector(".cmd-log-text")!;
    expect(FakeResizeObserver.watching(text)).toBe(true);
    tall = 4185;
    FakeResizeObserver.grew(text);
    expect(gap()).toBe(0);
    // The feed, newest first: its foot is the oldest, and nothing holds it there.
    document.querySelector<HTMLButtonElement>(".cmd-log-raw")!.click();
    expect(box.classList.contains("is-raw")).toBe(false);
    expect(FakeResizeObserver.watching(box)).toBe(false);
  });

  it("a hidden box reads as at its foot, and a scroll there does not hold it again", () => {
    const box = document.createElement("div");
    box.className = "chat-scroll";
    document.body.replaceChildren(box);
    const foot = holdFoot(box, 30);
    foot.place(true);
    scrollTo(box, 1200);
    expect(foot.held()).toBe(false);
    hidden = true;
    box.dispatchEvent(new Event("scroll"));
    expect(foot.held()).toBe(false);
    foot.stop();
  });

  it("let go, it watches nothing and hears no scroll", () => {
    const box = document.createElement("div");
    box.className = "chat-scroll";
    document.body.replaceChildren(box);
    const foot = holdFoot(box, 30);
    const line = document.createElement("p");
    box.replaceChildren(line);
    foot.place(true);
    expect(FakeResizeObserver.watching(line)).toBe(true);
    const off = vi.spyOn(box, "removeEventListener");
    foot.stop();
    expect(FakeResizeObserver.watching(line)).toBe(false);
    expect(FakeResizeObserver.watching(box)).toBe(false);
    expect(off).toHaveBeenCalledWith("scroll", expect.any(Function));
  });
});
