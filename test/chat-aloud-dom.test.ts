// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../src/shared/command.js";
import { detailBody } from "./conversations-fake.js";

const said: string[] = [];
vi.mock("../web/src/voice.js", async (original) => ({
  ...(await original<typeof import("../web/src/voice.js")>()),
  say: (text: string) => said.push(text),
  canSpeak: () => true,
  unlockVoice: () => {},
  unlockOnTap: () => () => {},
  stopVoice: () => {},
}));

const chat = await import("../web/src/views/chat.js");
const { workerRefresh } = await import("../web/src/push.js");

/** The open conversation's history, oldest first. */
let history: ChatMessage[] = [];
let listeners: Record<string, ((event?: { data: string }) => void)[]> = {};
let root: HTMLElement;

/** Read-aloud state lasts the session, so each test starts later than the one before. */
let year = 2030;
const msg = (n: number, from: ChatMessage["from"] = "rivet", id = `h${year}-${String(n).padStart(3, "0")}`): ChatMessage => ({
  id,
  from,
  text: `line ${n}`,
  at: new Date(Date.UTC(year, 0, 1, 0, 0, n)).toISOString(),
  threadId: "c1",
});

/** While `held` is set, reads of the conversation wait for `release()` and answer from the history as it is then. */
let held: (() => void)[] | null = null;
const release = () => held?.shift()?.();

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input), "http://x");
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  // Only the conversation's own reads are held; the list answers at once.
  if (!url.pathname.startsWith("/api/conversations/")) return json({ conversations: [detailBody("c1", history).conversation], older: 0, unread: 0 });
  if (held) await new Promise<void>((resolve) => held!.push(resolve));
  return json(detailBody("c1", history));
}

class FakeSource {
  static CLOSED = 2;
  readyState = 1;
  addEventListener(type: string, fn: (event?: { data: string }) => void) {
    (listeners[type] ??= []).push(fn);
  }
  close() {}
}

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const fire = (type: string, message?: ChatMessage) => {
  for (const fn of listeners[type] ?? []) fn(message ? { data: JSON.stringify(message) } : undefined);
};
const arrive = (n: number) => {
  history.push(msg(n));
  fire("message", msg(n));
};

beforeEach(() => {
  year += 1;
  held = null;
  said.length = 0;
  listeners = {};
  history = Array.from({ length: 70 }, (_, i) => msg(i + 1));
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  vi.stubGlobal("EventSource", FakeSource);
  localStorage.clear();
  chat.showConversation("c1");
  root = document.createElement("main");
  document.body.replaceChildren(root);
});

afterEach(() => {
  chat.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("read aloud", () => {
  it("an empty-screen press reads only replies newer than the press from the first load", async () => {
    let releaseReads!: () => void;
    const pending = new Promise<void>((resolve) => { releaseReads = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      await pending;
      return fakeFetch(input);
    }));
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(msg(70).at) + 500);
    chat.mount(root);
    root.querySelector<HTMLButtonElement>(".chat-speak")!.click();
    expect(said).toEqual([]);
    history.push(msg(71));
    releaseReads();
    await settle();
    expect(said).toEqual(["line 71"]);
    fire("message", msg(71));
    await chat.refresh();
    expect(said).toEqual(["line 71"]);
  });

  it("an empty conversation records the press even when its list arrived first", async () => {
    held = [];
    chat.mount(root);
    await settle();
    history.push(msg(71));
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(msg(71).at) + 500);
    root.querySelector<HTMLButtonElement>(".chat-speak")!.click();
    history.push(msg(72));
    release();
    held = null;
    await settle();
    expect(said).toEqual(["line 72"]);
    fire("message", msg(72));
    await chat.refresh();
    expect(said).toEqual(["line 72"]);
  });

  it("reads the latest message once, then only messages that arrive after it", async () => {
    chat.mount(root);
    await settle();
    expect(said).toEqual([]);

    root.querySelector<HTMLButtonElement>(".chat-speak")!.click();
    expect(said).toEqual(["line 70"]);

    arrive(71);
    arrive(72);
    expect(said).toEqual(["line 70", "line 71", "line 72"]);

    // A reconnect reads the conversation again: only the one that came in while the stream was down is new.
    fire("open");
    history.push(msg(73));
    await settle();
    fire("open");
    await settle();
    expect(said).toEqual(["line 70", "line 71", "line 72", "line 73"]);

    // Pull to refresh, a repeated stream delivery and a remount are not new either.
    await chat.refresh();
    fire("message", msg(72));
    chat.unmount();
    listeners = {};
    chat.mount(root);
    await settle();
    fire("open");
    await settle();
    expect(said).toEqual(["line 70", "line 71", "line 72", "line 73"]);

    arrive(74);
    expect(said).toEqual(["line 70", "line 71", "line 72", "line 73", "line 74"]);
  });

  it("never replays old replies when the newest messages are all your", async () => {
    history = [...Array.from({ length: 40 }, (_, i) => msg(i + 1)), ...Array.from({ length: 30 }, (_, i) => msg(i + 41, "owner"))];
    chat.mount(root);
    await settle();
    root.querySelector<HTMLButtonElement>(".chat-speak")!.click();
    fire("open");
    await settle();
    await chat.refresh();
    expect(said).toEqual(["line 40"]);
    arrive(71);
    expect(said).toEqual(["line 40", "line 71"]);
  });

  it("a live reply during a catch-up does not hide the replies the catch-up brings", async () => {
    chat.mount(root);
    await settle();
    root.querySelector<HTMLButtonElement>(".chat-speak")!.click();
    // Offline: 71 and 72 arrive. Then a live reply with 72's timestamp and a lower id lands mid catch-up.
    history.push(msg(71), msg(72));
    held = [];
    fire("open");
    await settle();
    const live = { ...msg(72, "rivet", `a${year}-live`), text: "live" };
    history.push(live);
    fire("message", live);
    release();
    held = null;
    await settle();
    expect(said).toEqual(["line 70", "live", "line 71", "line 72"]);
  });

  it("a second first read that overlapped the first still speaks a newer reply, and never the one the list knew of", async () => {
    held = [];
    chat.mount(root);
    fire("open");
    await settle();
    release();
    await settle();
    root.querySelector<HTMLButtonElement>(".chat-speak")!.click();
    history.push(msg(71));
    release();
    await settle();
    expect(said).toEqual(["line 71"]);
  });

  it("pressing read aloud is a boundary: older replies a pending catch-up brings stay quiet", async () => {
    chat.mount(root);
    await settle();
    history.push(msg(71), msg(72));
    held = [];
    fire("open");
    await settle();
    arrive(73);
    root.querySelector<HTMLButtonElement>(".chat-speak")!.click();
    release();
    held = null;
    await settle();
    expect(said).toEqual(["line 73"]);
    arrive(74);
    expect(said).toEqual(["line 73", "line 74"]);
  });

  it("a reply after an early press is spoken even when a later load resolves first", async () => {
    held = [];
    chat.mount(root);
    arrive(71);
    root.querySelector<HTMLButtonElement>(".chat-speak")!.click();
    history.push(msg(72));
    fire("open");
    await settle();
    // The reconnect's load (second in the queue) answers first.
    held.pop()?.();
    await settle();
    release();
    held = null;
    await settle();
    expect(said).toEqual(["line 71", "line 72"]);
  });
});

describe("a refresh the service worker holds a chat push for", () => {
  let acks: unknown[];
  beforeEach(() => {
    acks = [];
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { controller: { postMessage: (message: unknown) => acks.push(message) } } });
  });

  it("is acknowledged only once the reload shows the reply, even with the stream open", async () => {
    chat.mount(root);
    await settle();
    held = [];
    history.push(msg(71));
    const loading = workerRefresh({ id: "1", chat: "c1" }, chat.refresh, async () => true, chat.openConversation);
    await settle();
    expect(acks).toEqual([]);
    release();
    held = null;
    await loading;
    expect(root.textContent).toContain("line 71");
    expect(acks).toEqual([{ type: "refresh-ack", id: "1" }]);
  });

  it("is not acknowledged while you is scrolled up through history, and is at the bottom", async () => {
    chat.mount(root);
    await settle();
    const scroller = root.querySelector<HTMLElement>(".chat-scroll")!;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 500 });
    scroller.scrollTop = 200;
    history.push(msg(71));
    await workerRefresh({ id: "1", chat: "c1" }, chat.refresh, async () => true, chat.openConversation);
    expect(root.textContent).toContain("line 71");
    expect(scroller.scrollTop).toBe(200);
    expect(acks).toEqual([]);

    scroller.scrollTop = 1500;
    history.push(msg(72));
    await workerRefresh({ id: "2", chat: "c1" }, chat.refresh, async () => true, chat.openConversation);
    expect(acks).toEqual([{ type: "refresh-ack", id: "2" }]);
  });

  it("is not acknowledged when the chat closes before or while it loads", async () => {
    chat.mount(root);
    await settle();
    held = [];
    const loading = workerRefresh({ id: "1", chat: "c1" }, chat.refresh, async () => true, chat.openConversation);
    await settle();
    chat.unmount();
    release();
    held = null;
    await loading;
    await workerRefresh({ id: "2", chat: "c1" }, chat.refresh, async () => true, chat.openConversation);
    expect(acks).toEqual([]);
  });
});
