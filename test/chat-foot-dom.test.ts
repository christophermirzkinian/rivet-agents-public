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
// More than one page (THREAD_MESSAGES_MAX, 300): scrolling to the top loads the rest.
const LONG = Array.from({ length: 400 }, (_, i) => message(`a${String(i).padStart(3, "0")}`, "a", i, undefined, 2029));

// The chat on a narrow phone, as Chrome measured it: it shows 414 px of a thread that stood 3910 px when it
// scrolled to its newest, and 4185 px some 20 ms later.
const SHOWN = 414;
let tall = 3910;
/** When set, the thread stands this many px a message, so loading earlier ones makes it taller. */
let perMessage = 0;
/** When set, a line's own height in px by its id, in place of perMessage. */
let heightOf: ((id: string) => number) | null = null;
/** The Rivet sheet put away: the scroller is display:none. */
let hidden = false;
let top = 0;
let root: HTMLElement;
let restore: (() => void)[] = [];

const scrolls = (el: HTMLElement) => el.classList.contains("chat-scroll") || el.classList.contains("cmd-log");
/** Search hides the scroller too (conversations.css). Hidden, it reads 0; here it also comes back at its top, as an engine may drop the offset of a display:none box. */
const unseen = (el: HTMLElement) => {
  const gone = hidden || !!el.closest(".chat.searching");
  if (gone) top = 0;
  return gone;
};
/** Where the scroller's top is on the page, with perMessage set. */
const HEAD = 60;
/** Each run and shown line in the thread, from its top to its bottom. */
function laidOut(): Map<Element, [number, number]> {
  const at = new Map<Element, [number, number]>();
  let y = 0;
  for (const card of document.querySelectorAll(".chat-thread .chat-ex")) {
    const from = y;
    for (const line of card.querySelectorAll<HTMLElement>(".chat-msg")) at.set(line, [y, (y += heightOf?.(line.dataset.id!) ?? perMessage)]);
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
  // scroll; a run spans its lines.
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
  heightOf = null;
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

  it("a topic shown in Chat lights its newest line there, with no page; a search hit after it lets go and growth leaves it there", async () => {
    withTopic();
    await open();
    chat.showConversation("a");
    await settle();
    expect(lit()).toBe("a004");
    expect(root.querySelector(".thing-head")).toBeNull();
    expect(thread().textContent).toContain("Three things building.");
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

  it("a jump from the foot as the box above the message box goes keeps its scroll: the foot's own last scroll, told late, does not take hold again", async () => {
    // Go to that chat: the Asked-before strip going holds Chat at its foot, then the jump starts its smooth
    // scroll from there. The browser tells of the foot's scroll a frame later, unmoved, and the height the strip gave
    // back then reaches the observer: taken for a reader at the foot, it pinned Chat there and ended the jump's scroll.
    await open();
    scroller().scrollTop = scroller().scrollHeight;
    const at = top;
    openTarget({ type: "message", id: "m1" });
    expect(line("m1").classList.contains("lit")).toBe(true);
    scroller().dispatchEvent(new Event("scroll"));
    tall = 4185;
    FakeResizeObserver.grew(scroller());
    expect(top).toBe(at);
    // Or the strip's height given back clamps the scroll at the foot, told a frame later.
    tall = 3800;
    scrollTo(scroller(), tall - SHOWN);
    const clamped = top;
    tall = 4185;
    FakeResizeObserver.grew(scroller());
    expect(top).toBe(clamped);
    // A reader who scrolls back down to the newest is followed again.
    scrollTo(scroller(), tall - SHOWN - 10);
    tall = 4300;
    FakeResizeObserver.grew(thread());
    expect(gap()).toBe(0);
  });

  it("back at the foot by his own hand while the jumped-to line is still lit, a reply landing is followed there", async () => {
    const server = fakeServer(MESSAGES.map((one) => ({ ...one })));
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    await open();
    openTarget({ type: "message", id: "m1" });
    expect(line("m1").classList.contains("lit")).toBe(true);
    scroller().dispatchEvent(new Event("touchstart"));
    scrollTo(scroller(), 3000);
    scrollTo(scroller(), tall - SHOWN);
    server.messages.push(message("m3", "m1", 2, "A long reply"));
    await chat.refresh();
    await settle();
    expect(line("m1").classList.contains("lit")).toBe(true);
    tall += 120;
    FakeResizeObserver.grew(thread());
    expect(gap()).toBe(0);
  });

  it("a jump whose scroll ends short of its line (lines drawn on the way take their own height) brings it to the middle again, once it ends", async () => {
    perMessage = 100;
    const many = Array.from({ length: 20 }, (_, i) => message(`b${String(i).padStart(2, "0")}`, "b", i));
    vi.stubGlobal("fetch", vi.fn(fakeServer(many.map((one) => ({ ...one }))).fetch));
    chat.mount(root);
    await settle();
    await settle();
    expect(line("b19")).not.toBeNull();
    const into = vi.mocked(HTMLElement.prototype.scrollIntoView);
    into.mockClear();
    openTarget({ type: "message", id: "b02" });
    expect(into).toHaveBeenCalledTimes(1);
    // The smooth scroll ended with the line still above the scroller's top.
    scroller().dispatchEvent(new Event("scrollend"));
    expect(into).toHaveBeenCalledTimes(2);
    expect(into.mock.contexts[1]).toBe(line("b02"));
    // In view, it is left where it is; and a touch of his ends the looking.
    scrollTo(scroller(), 0);
    scroller().dispatchEvent(new Event("scrollend"));
    expect(into).toHaveBeenCalledTimes(2);
    scrollTo(scroller(), 1500);
    scroller().dispatchEvent(new Event("touchstart"));
    scroller().dispatchEvent(new Event("scrollend"));
    expect(into).toHaveBeenCalledTimes(2);
  });

  it("scrolling to the top keeps the place: the ones above come in by themselves and the reader stays on the message they were on", async () => {
    perMessage = 50;
    vi.stubGlobal("fetch", vi.fn(fakeServer(LONG.map((one) => ({ ...one })), { a: { title: "Long one" } }).fetch));
    chat.mount(root);
    await settle();
    expect(root.querySelectorAll(".chat-msg")).toHaveLength(50);
    expect(gap()).toBe(0);
    expect(root.querySelector("button.conv-earlier")).toBeNull();
    scrollTo(scroller(), 0);
    await settle();
    expect(root.querySelectorAll(".chat-msg")).toHaveLength(100);
    // 50 messages more above: the one at the top stays at the top.
    expect(top).toBe(50 * 50);
    FakeResizeObserver.grew(thread());
    expect(top).toBe(50 * 50);
  });

  it("scrolled up on Chat, a line landing at the end leaves the line being read where it was", async () => {
    perMessage = 50;
    const lines = Array.from({ length: 20 }, (_, i) => message(i < 10 ? `a${i}` : `b${i - 10}`, i < 10 ? "a" : "b", i));
    const server = fakeServer(lines);
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    chat.mount(root);
    await settle();
    await settle();
    scrollTo(scroller(), 100);
    expect(shownTop(line("a2"))).toBe(0);
    server.messages.push(message("a10", "a", 30));
    await chat.refresh();
    await settle();
    expect(root.querySelector<HTMLElement>(".chat-ex:last-child")!.dataset.thread).toBe("a");
    expect(shownTop(line("a2"))).toBe(0);
  });

  it("on Chat lit at a topic, a line landing leaves the run he is reading where it was, its runs sharing one thread", async () => {
    perMessage = 50;
    // Four runs of his question and three answers: each 200 px.
    const lines = Array.from({ length: 16 }, (_, i) => ({ ...message(`t${i}`, "t", i), from: i % 4 ? ("rivet" as const) : ("owner" as const) }));
    const server = fakeServer(lines, { t: { title: "Four rounds" } });
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    chat.showConversation("t");
    chat.mount(root);
    await settle();
    expect(root.querySelectorAll(".chat-ex")).toHaveLength(4);
    const second = root.querySelectorAll<HTMLElement>(".chat-ex")[1]!;
    scrollTo(scroller(), 300);
    expect(shownTop(second)).toBe(-100);
    server.messages.push({ ...message("t16", "t", 17), from: "rivet" });
    await chat.refresh();
    await settle();
    expect(root.querySelectorAll(".chat-msg")).toHaveLength(17);
    expect(top).toBe(300);
    expect(shownTop(second)).toBe(-100);
  });

  it("scrolled to the top on Chat on a line, the earlier lines coming in by themselves keep that line where it was", async () => {
    perMessage = 50;
    // Chat's first page is the newest 50: a1 and b0-b48. At the top, the page before brings z0 and a0.
    const lines = [
      message("z0", "z", 0),
      message("a0", "a", 1),
      message("a1", "a", 2),
      ...Array.from({ length: 49 }, (_, i) => message(`b${i}`, "b", 3 + i)),
    ];
    vi.stubGlobal("fetch", vi.fn(fakeServer(lines).fetch));
    chat.mount(root);
    await settle();
    await settle();
    expect(root.querySelector('.chat-msg[data-id="a0"]')).toBeNull();
    // On a1 (0-50), 10 px of it above the screen.
    scrollTo(scroller(), 10);
    await settle();
    expect(line("z0")).toBeTruthy();
    expect(line("a0")).toBeTruthy();
    expect(shownTop(line("a1"))).toBe(-10);
  });

  it("a Chat shorter than the screen keeps asking while each page before makes it taller, 20 pages at most until he wheels it", async () => {
    // Lines a quarter px tall: 1300 of them never fill the screen. Chat's first page is the newest 50, then 25 before.
    perMessage = 0.25;
    const lines = Array.from({ length: 1300 }, (_, i) => message(`a${i}`, "a", i));
    const server = fakeServer(lines);
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    chat.mount(root);
    await settle();
    await settle();
    await settle();
    const before = () => server.requests.filter((one) => one.includes("before=")).length;
    expect(before()).toBe(20);
    scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: 30 }));
    await settle();
    expect(before()).toBe(20);
    scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: -30 }));
    await settle();
    await settle();
    expect(before()).toBe(25);
  });

  it("a failed page before in a Chat shorter than the screen is asked again when he drags it, and its note clears", async () => {
    // Chat's first page, the newest 50 lines at 1 px, cannot scroll: the page before is asked at once, and fails.
    perMessage = 1;
    const lines = Array.from({ length: 150 }, (_, i) => message(`a${i}`, "a", i));
    const server = fakeServer(lines);
    let failing = true;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        server.failWith = failing && String(input).includes("before=") ? 500 : null;
        return server.fetch(input, init);
      }),
    );
    chat.mount(root);
    await settle();
    await settle();
    const before = () => server.requests.filter((one) => one.includes("before=")).length;
    expect(before()).toBe(1);
    expect(root.textContent).toContain("Couldn't load earlier messages.");
    await settle();
    expect(before()).toBe(1);
    // One drag asks once, failing or not: its other touch events ask nothing.
    scroller().dispatchEvent(new Event("touchstart"));
    scroller().dispatchEvent(new Event("touchmove"));
    await settle();
    expect(before()).toBe(2);
    scroller().dispatchEvent(new Event("touchmove"));
    await settle();
    scroller().dispatchEvent(new Event("touchmove"));
    await settle();
    expect(before()).toBe(2);
    failing = false;
    scroller().dispatchEvent(new Event("touchstart"));
    scroller().dispatchEvent(new Event("touchmove"));
    await settle();
    await settle();
    // That page lands, Chat is still short, so the last page comes by itself.
    expect(before()).toBe(4);
    expect(root.querySelectorAll(".chat-msg")).toHaveLength(150);
    expect(root.textContent).not.toContain("Couldn't load earlier messages.");
  });

  it("a page before that leaves him in the top band of a Chat he can scroll is the last one asked until he scrolls away and back", async () => {
    // z's 30 lines stand 20 px each, a's 1 px: Chat's first page (z and a's newest 20) scrolls, and a's 300 lines go
    // back six pages of 50 px, too little to take him past the top band.
    heightOf = (id) => (id.startsWith("z") ? 20 : 1);
    perMessage = 1;
    const lines = [
      ...Array.from({ length: 300 }, (_, i) => message(`a${i}`, "a", i)),
      ...Array.from({ length: 30 }, (_, i) => message(`z${i}`, "z", 300 + i)),
    ];
    const server = fakeServer(lines);
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    chat.mount(root);
    await settle();
    await settle();
    const before = () => server.requests.filter((one) => one.includes("before=")).length;
    expect(before()).toBe(0);
    scrollTo(scroller(), 0);
    await settle();
    expect(before()).toBe(1);
    expect(top).toBeLessThanOrEqual(160);
    scrollTo(scroller(), 300);
    scrollTo(scroller(), 0);
    await settle();
    expect(before()).toBe(2);
  });

  it("at the newest, a page before landing above keeps the newest on screen", async () => {
    perMessage = 5;
    // Chat's first page: a's ten lines and b's newest forty, short of the screen, so the page before comes at once.
    const lines = [
      ...Array.from({ length: 50 }, (_, i) => message(`b${i}`, "b", i)),
      ...Array.from({ length: 10 }, (_, i) => message(`a${i}`, "a", 50 + i)),
      ...Array.from({ length: 40 }, (_, i) => message(`b${50 + i}`, "b", 60 + i)),
    ];
    const server = fakeServer(lines);
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    chat.mount(root);
    await settle();
    await settle();
    expect(server.requests.filter((one) => one.includes("before=")).length).toBe(1);
    expect(line("b0")).toBeTruthy();
    expect(height()).toBeGreaterThan(SHOWN);
    expect(gap()).toBeLessThan(40);
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

describe("Back to newest: a round ↓ once he is more than one screen up", () => {
  const newest = () => root.querySelector<HTMLButtonElement>(".chat-newest")!;
  const count = () => root.querySelector<HTMLElement>(".chat-newest-count")!;
  /** The owner scrolled up so the newest line is `below` px under the screen. */
  const upBy = (below: number) => scrollTo(scroller(), tall - SHOWN - below);

  it("shows only past one screen from the newest: at the foot and at exactly one screen it stays hidden", async () => {
    await open();
    expect(newest().hidden).toBe(true);
    upBy(SHOWN);
    expect(newest().hidden).toBe(true);
    upBy(SHOWN + 1);
    expect(newest().hidden).toBe(false);
    expect(count().hidden).toBe(true);
    expect(newest().getAttribute("aria-label")).toBe("Back to newest");
    upBy(200);
    expect(newest().hidden).toBe(true);
  });

  it("counts the lines that land while he is up, his own left out, and starts again once he is back", async () => {
    const server = fakeServer(MESSAGES.map((one) => ({ ...one })));
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    await open();
    upBy(2000);
    expect(count().hidden).toBe(true);
    server.messages.push(message("n1", "m1", 3, "First new"), message("n2", "m1", 4, "Mine"), message("n3", "m1", 5, "Second new"));
    await chat.refresh();
    await settle();
    expect(thread().textContent).toContain("Second new");
    expect(newest().hidden).toBe(false);
    expect(count().hidden).toBe(false);
    expect(count().textContent).toBe("2");
    expect(newest().getAttribute("aria-label")).toBe("Back to newest, 2 new");
    // Within a screen but short of the newest and up again: he has not been back, so they still count.
    upBy(100);
    expect(newest().hidden).toBe(true);
    upBy(2000);
    expect(count().textContent).toBe("2");
    // Back at the newest and up again: the lines he has seen are not counted twice.
    upBy(0);
    upBy(2000);
    expect(newest().hidden).toBe(false);
    expect(count().hidden).toBe(true);
  });

  it("a search covering Chat while he is up keeps the count, and the lines that land under it are counted", async () => {
    const server = fakeServer(MESSAGES.map((one) => ({ ...one })));
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    await open();
    upBy(2000);
    server.messages.push(message("n1", "m1", 3, "First new"));
    await chat.refresh();
    await settle();
    expect(count().textContent).toBe("1");
    const input = root.querySelector<HTMLInputElement>(".chat-search-input")!;
    input.value = "three";
    input.dispatchEvent(new Event("input"));
    expect(root.querySelector(".chat")!.classList.contains("searching")).toBe(true);
    server.messages.push(message("n2", "m1", 5, "Under the search"));
    await chat.refresh();
    await settle();
    root.querySelector<HTMLButtonElement>(".chat-search-clear")!.click();
    await settle();
    expect(newest().hidden).toBe(false);
    expect(count().textContent).toBe("2");
  });

  it("a tap scrolls smoothly to the newest; arriving there hides it and the foot holds again", async () => {
    await open();
    upBy(2000);
    const smooth = vi.fn();
    scroller().scrollTo = smooth as unknown as HTMLElement["scrollTo"];
    newest().click();
    expect(smooth).toHaveBeenCalledWith({ top: tall, behavior: "smooth" });
    // The browser's smooth scroll reaches the foot.
    scrollTo(scroller(), tall - SHOWN);
    expect(newest().hidden).toBe(true);
    tall = 4185;
    FakeResizeObserver.grew(thread());
    expect(gap()).toBe(0);
  });

  it("lines growing under the smooth scroll leave it short: as it ends, the rest of the way, unless his hand took it", async () => {
    await open();
    upBy(2000);
    scroller().scrollTo = vi.fn() as unknown as HTMLElement["scrollTo"];
    newest().click();
    // Rows not drawn yet take their real height as the scroll passes them: the newest is further down than it aimed.
    tall = 4185;
    scroller().dispatchEvent(new Event("scrollend"));
    expect(gap()).toBe(0);
    expect(newest().hidden).toBe(true);
    // His own touch on the way down lets the scroll be.
    upBy(2000);
    newest().click();
    scroller().dispatchEvent(new Event("pointerdown"));
    scroller().dispatchEvent(new Event("scrollend"));
    expect(gap()).toBe(2000);
  });

  it("hidden as he gets back with the keyboard on it, it hands the keyboard on rather than dropping it to the page", async () => {
    await open();
    upBy(2000);
    scroller().scrollTo = vi.fn() as unknown as HTMLElement["scrollTo"];
    newest().focus();
    expect(document.activeElement).toBe(newest());
    newest().click();
    scrollTo(scroller(), tall - SHOWN);
    expect(newest().hidden).toBe(true);
    expect(document.activeElement).not.toBe(newest());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("with reduced motion asked for, a tap goes to the newest at once", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }));
    await open();
    upBy(2000);
    newest().click();
    expect(gap()).toBe(0);
    expect(newest().hidden).toBe(true);
  });
});

describe("One chat: Chat oldest to newest, no topics", () => {
  // Ten lines of a, five of b, ten more of a: in time order, never gathered by topic.
  const LINES = () => [
    ...Array.from({ length: 10 }, (_, i) => message(`a${i}`, "a", i)),
    ...Array.from({ length: 5 }, (_, i) => message(`b${i}`, "b", 10 + i)),
    ...Array.from({ length: 10 }, (_, i) => message(`a${10 + i}`, "a", 15 + i)),
  ];
  const ids = () => [...root.querySelectorAll<HTMLElement>(".chat-thread .chat-msg")].map((one) => one.dataset.id);

  async function onChat(lines: ChatMessage[] = LINES()): Promise<void> {
    vi.stubGlobal("fetch", vi.fn(fakeServer(lines, { a: { title: "Topic a" }, b: { title: "Topic b" } }).fetch));
    chat.mount(root);
    await settle();
    await settle();
  }

  it("shows every line in time order, with no topics bar and no minimised card", async () => {
    perMessage = 50;
    await onChat();
    expect(ids()).toEqual(LINES().map((one) => one.id));
    expect(root.querySelector(".chat-topics-bar, .chat-thread .chat-ex.minimised, .chat-away")).toBeNull();
  });

  it("scrolling to the top loads the page before and keeps the reader on the message they were on", async () => {
    perMessage = 50;
    // Two pages of 50 and more: a and b in turns of ten.
    const lines = Array.from({ length: 120 }, (_, i) => message(`m${String(i).padStart(3, "0")}`, Math.floor(i / 10) % 2 ? "b" : "a", i));
    await onChat(lines);
    expect(ids()).toEqual(lines.slice(70).map((one) => one.id));
    scrollTo(scroller(), 0);
    await settle();
    expect(ids()).toEqual(lines.slice(20).map((one) => one.id));
    expect(top).toBe(50 * 50);
    expect(shownTop(line("m070"))).toBe(0);
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
