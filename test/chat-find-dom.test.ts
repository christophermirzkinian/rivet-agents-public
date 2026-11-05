// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../src/shared/command.js";
import { fakeServer, type FakeServer } from "./conversations-fake.js";

vi.mock("../web/src/voice.js", async (original) => ({
  ...(await original<typeof import("../web/src/voice.js")>()),
  say: () => {},
  unlockVoice: () => Promise.resolve(true),
  unlockOnTap: () => () => {},
  stopVoice: () => {},
}));
const flashed: string[] = [];
vi.mock("../web/src/views/toast.js", async (original) => ({
  ...(await original<typeof import("../web/src/views/toast.js")>()),
  flash: (text: string) => flashed.push(text),
}));

const chat = await import("../web/src/views/chat.js");
const { app } = await import("../web/src/state.js");
const { openTarget } = await import("../web/src/views/search.js");

/** Conversation a: 400 messages, Chat's, so most are past its first page. Conversation b: a thing, its card on b1. */
const message = (id: string, conversation: string, n: number): ChatMessage => ({
  id,
  from: n % 2 ? "rivet" : "owner",
  text: `Message ${id}`,
  at: new Date(Date.UTC(2026, 8, 1, 0, n)).toISOString(),
  threadId: conversation,
});
const HISTORY = [
  ...Array.from({ length: 400 }, (_, i) => message(i === 0 ? "a" : `a${String(i).padStart(3, "0")}`, "a", i)),
  message("b", "b", 500),
  { ...message("b1", "b", 501), from: "rivet" as const, posted: { id: "card-b", kind: "plan", title: "Plan: short one" } },
  { ...message("b2", "b", 502), from: "rivet" as const },
];

let root: HTMLElement;
let server: FakeServer;

class FakeSource {
  static CLOSED = 2;
  readyState = 1;
  addEventListener() {}
  close() {}
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const shown = (id: string) => root.querySelector<HTMLElement>(`.chat-msg[data-id="${id}"]`);
const title = () => root.querySelector(".thing-title")?.textContent;
const chatRequests = () => server.requests.filter((one) => one.startsWith("GET /api/chat?"));

beforeEach(() => {
  server = fakeServer(HISTORY.map((one) => ({ ...one })), { a: { title: "Long one" }, b: { title: "Short one" } });
  flashed.length = 0;
  app.chatFocus = null;
  vi.stubGlobal("fetch", vi.fn(server.fetch));
  vi.stubGlobal("EventSource", FakeSource);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  root = document.createElement("main");
  document.body.replaceChildren(root);
});

afterEach(() => {
  chat.unmount();
  vi.unstubAllGlobals();
});

describe("a chat search hit", () => {
  it("in a line of Chat opens Chat at it and brings it into view", async () => {
    openTarget({ type: "message", id: "a390" });
    chat.mount(root);
    await settle();
    expect(chat.openConversation()).toBeNull();
    expect(shown("a390")!.scrollIntoView).toHaveBeenCalled();
    expect(shown("a390")!.classList.contains("lit")).toBe(true);
    expect(app.chatFocus).toBeNull();
  });

  it("makes a refresh it overtakes say the newest is not on screen, so the push still rings", async () => {
    chat.mount(root);
    await settle();
    expect(await chat.refresh()).toBe(true);
    const refreshed = chat.refresh();
    openTarget({ type: "message", id: "a380" });
    expect(shown("a380")!.classList.contains("lit")).toBe(true);
    expect(await refreshed).toBe(false);
  });

  it("makes a refresh that lands while a hit's earlier pages still load say the newest is not on screen", async () => {
    // Chat's earlier pages wait until released, so the refresh lands while the hit is still on its way.
    const held: (() => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("before=")) await new Promise<void>((resolve) => held.push(resolve));
      return server.fetch(input, init);
    }));
    chat.mount(root);
    await settle();
    openTarget({ type: "message", id: "a010" });
    await settle();
    expect(held).toHaveLength(1);
    expect(await chat.refresh()).toBe(false);
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    for (const release of held.splice(0)) release();
    await settle();
    expect(shown("a010")!.classList.contains("lit")).toBe(true);
  });

  it("finds it when Chat is already open", async () => {
    chat.mount(root);
    await settle();
    openTarget({ type: "message", id: "a395" });
    await settle();
    expect(shown("a395")!.classList.contains("lit")).toBe(true);
    expect(app.chatFocus).toBeNull();
  });

  it("in a thing opens the thing's page at it, and only that thing's messages", async () => {
    chat.mount(root);
    await settle();
    // In Chat the thing is one line to its page; what came after its card is not in Chat.
    expect(root.querySelector('.chat-thing-row[data-id="b1"]')).not.toBeNull();
    expect(shown("b2")).toBeNull();
    openTarget({ type: "message", id: "b2" });
    await settle();
    expect(chat.openConversation()).toBe("b");
    expect(title()).toBe("Short one");
    expect(shown("a399")).toBeNull();
    expect(shown("b2")!.classList.contains("lit")).toBe(true);
  });

  it("older than Chat's first page loads earlier pages until it is in", async () => {
    openTarget({ type: "message", id: "a010" });
    chat.mount(root);
    await settle();
    expect(chat.openConversation()).toBeNull();
    expect(chatRequests().some((one) => one.includes("before="))).toBe(true);
    expect(shown("a010")!.scrollIntoView).toHaveBeenCalled();
    expect(shown("a010")!.classList.contains("lit")).toBe(true);
    // Earlier ones than that are still there to load.
    expect(root.querySelector<HTMLElement>(".conv-earlier")!.hidden).toBe(false);
    expect(flashed).toEqual([]);
  });

  it("Earlier messages loads the ones before the earliest shown, and goes once there are none", async () => {
    chat.showConversation("a");
    chat.mount(root);
    await settle();
    expect(shown("a100")).not.toBeNull();
    expect(shown("a099")).toBeNull();
    const earlier = root.querySelector<HTMLButtonElement>(".conv-earlier")!;
    expect(earlier.hidden).toBe(false);
    expect(earlier.textContent).toBe("Earlier messages");
    earlier.click();
    await settle();
    expect(shown("a099")).not.toBeNull();
    expect(shown("a")).not.toBeNull();
    expect(root.querySelectorAll(".chat-msg")).toHaveLength(400);
    expect(earlier.hidden).toBe(true);
  });

  it("says so for a message that is gone, and stays on Chat", async () => {
    chat.mount(root);
    await settle();
    // Chat opens on the screen it was left on: Back takes it to Chat.
    root.querySelector<HTMLButtonElement>(".thing-back")?.click();
    await settle();
    openTarget({ type: "message", id: "gone" });
    await settle();
    expect(flashed).toEqual(["That message is gone."]);
    expect(chat.openConversation()).toBeNull();
  });
});
