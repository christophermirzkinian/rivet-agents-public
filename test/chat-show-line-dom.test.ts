// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../src/shared/command.js";
import { fakeServer, type FakeServer } from "./conversations-fake.js";

// showLine: a notification, a feed link or a search hit brings its line up in Chat, lit; there is
// no page of its own.

vi.mock("../web/src/voice.js", async (original) => ({
  ...((await original()) as Record<string, unknown>),
  say: () => {},
  canSpeak: () => true,
  unlockVoice: () => {},
  unlockOnTap: () => () => {},
  stopVoice: () => {},
}));

const chat = await import("../web/src/views/chat.js");
const { app } = await import("../web/src/state.js");
const { closeSheet } = await import("../web/src/views/sheet.js");

const at = (minute: number) => new Date(Date.UTC(2030, 0, 1, 0, minute)).toISOString();
const rivet = (id: string, conversation: string, minute: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  from: "rivet",
  text: `Rivet ${id}`,
  at: at(minute),
  threadId: conversation,
  ...extra,
});
const owner = (id: string, conversation: string, minute: number): ChatMessage => ({
  id,
  from: "owner",
  text: `The owner ${id}`,
  at: at(minute),
  status: "replied",
  threadId: conversation,
});

const MESSAGES = (): ChatMessage[] => [
  owner("k1", "k1", 10),
  rivet("k2", "k1", 30, { text: "The PR is up" }),
  owner("g1", "g1", 20),
  rivet("g2", "g1", 21),
  owner("g3", "g1", 40),
];

let server: FakeServer;
let root: HTMLElement;

class FakeSource {
  static CLOSED = 2;
  readyState = 1;
  addEventListener() {}
  close() {}
}

const settle = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const shownIds = () => [...root.querySelectorAll<HTMLElement>(".chat-msg")].map((el) => el.dataset.id);
const litIds = () => [...root.querySelectorAll<HTMLElement>(".chat-msg.lit")].map((el) => el.dataset.id);
const line = (id: string) => root.querySelector<HTMLElement>(`.chat-msg[data-id="${id}"]`);
const scrolled = () => vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts as HTMLElement[];

async function onChat(): Promise<void> {
  chat.startDraft("");
  chat.mount(root);
  await settle();
}

beforeEach(() => {
  server = fakeServer(MESSAGES(), {
    k1: { title: "Results row", links: { prs: ["#341"], chats: ["results-row"], tag: "Results" } },
    g1: { title: "quote enquiry form" },
  });
  history.replaceState(null, "");
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => server.fetch(input, init)));
  vi.stubGlobal("EventSource", FakeSource);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  app.chatFocus = null;
  app.chatUnread = 0;
  app.tab = "progress";
  root = document.createElement("main");
  document.body.replaceChildren(root);
});

afterEach(() => {
  closeSheet();
  chat.unmount();
  vi.unstubAllGlobals();
});

describe("showLine", () => {
  it("lights a line Chat has loaded and scrolls to it, with no page of Chat read again", async () => {
    await onChat();
    const before = server.requests.length;
    chat.showLine("g1", "g2");
    await settle();
    expect(litIds()).toEqual(["g2"]);
    expect(scrolled()).toContain(line("g2"));
    // Only its topic's summary, for More's Share.
    expect(server.requests.slice(before).filter((one) => one.startsWith("GET /api/chat"))).toEqual([]);
  });

  it("loads Chat's earlier pages until it reaches a line off its first page, then lights it", async () => {
    // The line asked for, then three pages' worth of news after it.
    const news = Array.from({ length: 130 }, (_, i) => rivet(`n${i}`, "g1", 50 + i));
    server.messages.splice(0, server.messages.length, owner("o1", "o1", 1), rivet("o2", "o1", 2, { text: "Old reply" }), ...news);
    await onChat();
    expect(shownIds()).not.toContain("o2");
    chat.showLine("o1", "o2");
    await settle();
    expect(server.requests.filter((one) => one.startsWith("GET /api/chat?") && one.includes("before=")).length).toBeGreaterThanOrEqual(2);
    expect(shownIds()).toContain("o2");
    expect(litIds()).toEqual(["o2"]);
    expect(scrolled()).toContain(line("o2"));
  });

  it("reaches a tapped line over a thousand lines back, past the twenty pages Chat loads by itself", async () => {
    const news = Array.from({ length: 1100 }, (_, i) => rivet(`n${i}`, "g1", 50 + i));
    server.messages.splice(0, server.messages.length, owner("o1", "o1", 1), rivet("o2", "o1", 2, { text: "Old reply" }), ...news);
    await onChat();
    chat.showLine("o1", "o2");
    for (let i = 0; i < 30 && !litIds().length; i += 1) await settle();
    expect(litIds()).toEqual(["o2"]);
  });

  it("a tap on a loaded line whose topic has since gone app-only, off the list, takes Share away", async () => {
    const share = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "share", { value: share, configurable: true, writable: true });
    await onChat();
    const offersShare = () => {
      const open = line("k2")!;
      if (!open.classList.contains("open")) open.click();
      open.querySelector<HTMLButtonElement>('.chat-msg-tools [data-use="chat.msg.more"]')!.click();
      const offered = document.querySelector('.chat-more-sheet [data-use="chat.more.share"]') !== null;
      closeSheet();
      return offered;
    };
    expect(offersShare()).toBe(true);
    Object.assign(server.conversations.get("k1")!, { closed: true, appOnly: true });
    chat.showLine("k1", "k2");
    await settle();
    expect(offersShare()).toBe(false);
  });

  it("a tap on a loaded line offers no Share while its topic's read is out, nor after that read fails", async () => {
    Object.defineProperty(navigator, "share", { value: vi.fn(() => Promise.resolve()), configurable: true, writable: true });
    await onChat();
    const offersShare = () => {
      const open = line("k2")!;
      if (!open.classList.contains("open")) open.click();
      open.querySelector<HTMLButtonElement>('.chat-msg-tools [data-use="chat.msg.more"]')!.click();
      const offered = document.querySelector('.chat-more-sheet [data-use="chat.more.share"]') !== null;
      closeSheet();
      return offered;
    };
    expect(offersShare()).toBe(true);
    let fail: () => void = () => {};
    const held = new Promise<void>((_, reject) => (fail = () => reject(new Error("offline"))));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input), "http://x").pathname === "/api/conversations/k1") await held;
      return server.fetch(input, init);
    }));
    chat.showLine("k1", "k2");
    await settle();
    expect(offersShare()).toBe(false);
    fail();
    await settle();
    expect(offersShare()).toBe(false);
  });

  it("a way in named by a loaded line's id offers no Share on that line's topic while its read is out", async () => {
    Object.defineProperty(navigator, "share", { value: vi.fn(() => Promise.resolve()), configurable: true, writable: true });
    await onChat();
    const offersShare = () => {
      const open = line("k2")!;
      if (!open.classList.contains("open")) open.click();
      open.querySelector<HTMLButtonElement>('.chat-msg-tools [data-use="chat.msg.more"]')!.click();
      const offered = document.querySelector('.chat-more-sheet [data-use="chat.more.share"]') !== null;
      closeSheet();
      return offered;
    };
    expect(offersShare()).toBe(true);
    const held = new Promise<void>(() => {});
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input), "http://x").pathname === "/api/conversations/k2") await held;
      return server.fetch(input, init);
    }));
    chat.showLine("k2");
    await settle();
    expect(offersShare()).toBe(false);
  });

  it("an older tap's read landing late cannot give Share back after a newer read said app-only", async () => {
    Object.defineProperty(navigator, "share", { value: vi.fn(() => Promise.resolve()), configurable: true, writable: true });
    await onChat();
    const offersShare = () => {
      const open = line("k2")!;
      if (!open.classList.contains("open")) open.click();
      open.querySelector<HTMLButtonElement>('.chat-msg-tools [data-use="chat.msg.more"]')!.click();
      const offered = document.querySelector('.chat-more-sheet [data-use="chat.more.share"]') !== null;
      closeSheet();
      return offered;
    };
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input), "http://x").pathname === "/api/conversations/k1") {
        const read = ++reads;
        if (read === 1) await held;
        if (read === 3) return new Response(JSON.stringify({ error: "busy" }), { status: 503, headers: { "content-type": "application/json" } });
      }
      return server.fetch(input, init);
    }));
    // The first read is held; the second says app-only; the third fails.
    chat.showLine("k1", "k2");
    await settle();
    server.conversations.get("k1")!.appOnly = true;
    chat.showLine("k1", "k2");
    await settle();
    chat.showLine("k1", "k2");
    await settle();
    // The held first read now answers with the shareable word it would have had.
    server.conversations.get("k1")!.appOnly = false;
    release();
    await settle();
    expect(offersShare()).toBe(false);
  });

  it("a newer way in wins over an older one whose read is still on its way", async () => {
    await onChat();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input), "http://x").pathname === "/api/conversations/k1") await held;
      return server.fetch(input, init);
    }));
    chat.showLine("k1");
    await settle();
    chat.showLine("g1", "g2");
    await settle();
    expect(litIds()).toEqual(["g2"]);
    release();
    await settle();
    expect(litIds()).toEqual(["g2"]);
  });

  it("an older way in's newest page landing late does not take back a newer tap's line", async () => {
    await onChat();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input), "http://x").pathname === "/api/chat") await held;
      return server.fetch(input, init);
    }));
    chat.showLine("k1");
    await settle();
    chat.showLine("g1", "g2");
    await settle();
    const scroller = root.querySelector<HTMLElement>(".chat-scroll")!;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 });
    // Still at the foot, where the tap's smooth scroll up to its line began.
    scroller.scrollTop = 1600;
    release();
    await settle();
    expect(litIds()).toEqual(["g2"]);
    // The older read's page neither sticks Chat to its bottom nor ends the scroll short of the tapped line.
    expect(scroller.scrollTop).toBe(1600);
  });

  it("an older tap's earlier page landing during a newer tap's scroll from the foot does not stick Chat to its bottom", async () => {
    const news = Array.from({ length: 130 }, (_, i) => rivet(`n${i}`, "g1", 50 + i));
    server.messages.splice(0, server.messages.length, owner("o1", "o1", 1), rivet("o2", "o1", 2, { text: "Old reply" }), ...news);
    await onChat();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("before=")) await held;
      return server.fetch(input, init);
    }));
    chat.showLine("o1", "o2");
    await settle();
    chat.showLine("g1", "n120");
    await settle();
    expect(litIds()).toEqual(["n120"]);
    const scroller = root.querySelector<HTMLElement>(".chat-scroll")!;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 });
    // Still at the foot, where the newer tap's smooth scroll up to its line began.
    scroller.scrollTop = 1600;
    release();
    await settle();
    expect(litIds()).toEqual(["n120"]);
    expect(scroller.scrollTop).toBe(1600);
  });

  it("a tap on a line kept from the last visit keeps it in view once the newest page lands", async () => {
    await onChat();
    chat.unmount();
    vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
    chat.showLine("g1", "g2");
    chat.startDraft("");
    chat.mount(root);
    await settle();
    expect(litIds()).toEqual(["g2"]);
    const calls = scrolled();
    expect(calls.at(-1)).toBe(line("g2"));
  });
});

describe("opens from elsewhere land in Chat at the line, with no page", () => {
  const noPage = () => expect(document.querySelector(".thing-head, .thing-foot, .conv-head-box")).toBeNull();

  it("a feed card's thing (openThingFor its chat) is its newest line in Chat, on the Chat tab", async () => {
    await onChat();
    await expect(chat.openThingFor("results-row")).resolves.toBe(true);
    await settle();
    expect(app.tab).toBe("chat");
    expect(litIds()).toEqual(["k2"]);
    noPage();
    // A chat no conversation links opens nothing.
    await expect(chat.openThingFor("nobody")).resolves.toBe(false);
  });

  it("a search title hit is its conversation's newest line in Chat", async () => {
    const hit = { kind: "conversation", key: "conversation:k1", title: "Night Batch results row", open: { type: "message", id: "k1" } };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      new URL(String(input), "http://x").pathname === "/api/chat/search"
        ? Promise.resolve(new Response(JSON.stringify({ results: [hit] }), { status: 200, headers: { "content-type": "application/json" } }))
        : server.fetch(input, init),
    ));
    await onChat();
    root.querySelector<HTMLButtonElement>(".chat-head .chat-tools > button.chat-find")!.click();
    const input = root.querySelector<HTMLInputElement>(".chat-search-input")!;
    input.value = "pear";
    input.dispatchEvent(new Event("input"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await settle();
    root.querySelector<HTMLButtonElement>(".chat-search-hit.is-conversation")!.click();
    await settle();
    expect(litIds()).toEqual(["k2"]);
    noPage();
  });
});
