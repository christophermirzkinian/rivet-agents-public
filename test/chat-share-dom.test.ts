// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../src/shared/command.js";
import { detailBody, EMPTY_LIST } from "./conversations-fake.js";

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
const { SHARE_WAIT_MS } = await import("../web/src/within.js");

const REPLY = "The demo is ready.\nNext: the launch video 🐸 & #236";
let history: ChatMessage[] = [];
let listeners: Record<string, ((event?: { data: string }) => void)[]> = {};
let root: HTMLElement;
let share: ReturnType<typeof vi.fn> | null;
let opened: ReturnType<typeof vi.fn>;

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  // The conversation is not app-only: until a read of it says so, no reply offers Share.
  const body = new URL(String(input), "http://x").pathname.startsWith("/api/conversations/") ? detailBody("c1", history) : EMPTY_LIST;
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
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

const sheet = () => document.querySelector<HTMLElement>('.sheet[aria-label="Share"]');
const area = () => sheet()!.querySelector<HTMLTextAreaElement>("textarea")!;
const sheetButton = (label: string) => [...sheet()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;

async function openReplyShare(): Promise<void> {
  chat.mount(root);
  await settle();
  root.querySelector<HTMLButtonElement>('.chat-msg[data-id="h2"] .chat-share')!.click();
}

function useShare(impl: (data: ShareData) => Promise<void>): void {
  share = vi.fn(impl);
  Object.defineProperty(navigator, "share", { value: share, configurable: true, writable: true });
}

beforeEach(() => {
  flashed.length = 0;
  listeners = {};
  share = null;
  history = [
    { id: "c1", from: "owner", text: "What's live?", at: "2030-01-01T00:00:01.000Z", status: "replied" },
    { id: "h2", from: "rivet", text: REPLY, at: "2030-01-01T00:00:02.000Z" },
  ];
  opened = vi.fn(() => null);
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  vi.stubGlobal("EventSource", FakeSource);
  vi.spyOn(window, "open").mockImplementation(opened);
  localStorage.clear();
  // These tests are about the messages of one conversation: the tab opens on it.
  chat.showConversation("c1");
  root = document.createElement("main");
  document.body.replaceChildren(root);
});

afterEach(() => {
  vi.useRealTimers();
  chat.unmount();
  document.querySelector<HTMLButtonElement>(".sheet > .btn")?.click();
  delete (navigator as { share?: unknown }).share;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("share a reply", () => {
  it("a Send while the conversation has not been read since a reconnect says it is still checking, and shares nothing", async () => {
    useShare(() => Promise.resolve());
    await openReplyShare();
    for (const fn of listeners.open ?? []) fn();
    sheetButton("Send").click();
    expect(flashed).toEqual(["Checking where this conversation belongs. Try again in a moment."]);
    expect(share).not.toHaveBeenCalled();
    expect(sheet()).toBeNull();
  });

  it("a stream error hides Share and refuses an open sheet's Send as still checking, until a read sent after it lands", async () => {
    useShare(() => Promise.resolve());
    await openReplyShare();
    for (const fn of listeners.error ?? []) fn();
    expect(root.querySelector(".chat-share")).toBeNull();
    sheetButton("Send").click();
    expect(flashed).toEqual(["Checking where this conversation belongs. Try again in a moment."]);
    expect(share).not.toHaveBeenCalled();
    await settle();
    expect(root.querySelector(".chat-share")).toBeNull();
    await chat.refresh();
    await settle();
    expect(root.querySelector('.chat-msg[data-id="h2"] .chat-share')).not.toBeNull();
  });

  it("hidden, and back before the reopened stream reads again, Send says it is still checking, even after a read that landed hidden", async () => {
    useShare(() => Promise.resolve());
    await openReplyShare();
    const show = (state: "visible" | "hidden") => {
      Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    try {
      show("hidden");
      // A read asked for while hidden lands; the conversation may still move before the app is back.
      await chat.refresh();
      await settle();
      show("visible");
      sheetButton("Send").click();
      expect(flashed).toEqual(["Checking where this conversation belongs. Try again in a moment."]);
      expect(share).not.toHaveBeenCalled();
      // The fresh stream opens and reads again: Share is back.
      for (const fn of listeners.open ?? []) fn();
      await settle();
      expect(root.querySelector('.chat-msg[data-id="h2"] .chat-share')).not.toBeNull();
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("a stream gone quiet past the watchdog hides Share and refuses an open sheet's Send, until a read sent after it lands", async () => {
    useShare(() => Promise.resolve());
    await openReplyShare();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // A ping restarts the watchdog on the fake clock.
    for (const fn of listeners.ping ?? []) fn();
    vi.advanceTimersByTime(chat.STREAM_IDLE_MS);
    vi.useRealTimers();
    expect(root.querySelector(".chat-share")).toBeNull();
    sheetButton("Send").click();
    expect(flashed).toEqual(["Checking where this conversation belongs. Try again in a moment."]);
    expect(share).not.toHaveBeenCalled();
    await chat.refresh();
    await settle();
    expect(root.querySelector('.chat-msg[data-id="h2"] .chat-share')).not.toBeNull();
  });

  it("a read superseded by a newer one never brings Share back, even when the newer one fails", async () => {
    chat.mount(root);
    await settle();
    for (const fn of listeners.error ?? []) fn();
    expect(root.querySelector(".chat-share")).toBeNull();
    // Read A is held; read B, sent after it, fails; then A lands. Only the newest read may say Share is safe again.
    let release: (() => void) | null = null;
    let lists = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (!new URL(String(input), "http://x").pathname.startsWith("/api/conversations/")) return fakeFetch(input);
        lists += 1;
        if (lists === 1) {
          await new Promise<void>((resolve) => (release = resolve));
          return fakeFetch(input);
        }
        return new Response(JSON.stringify({ error: "down" }), { status: 503, headers: { "content-type": "application/json" } });
      }),
    );
    void chat.refresh();
    await settle();
    await chat.refresh();
    await settle();
    expect(lists).toBe(2);
    release!();
    await settle();
    expect(root.querySelector(".chat-share")).toBeNull();
  });

  it("a Send in a conversation known to be personal says it stays in the app, and shares nothing", async () => {
    useShare(() => Promise.resolve());
    await openReplyShare();
    for (const fn of listeners.thread ?? []) fn({ data: JSON.stringify({ id: "c1", project: "personal" }) });
    sheetButton("Send").click();
    expect(flashed).toEqual(["This conversation is personal now: it stays in the app."]);
    expect(share).not.toHaveBeenCalled();
    for (const fn of listeners.thread ?? []) fn({ data: JSON.stringify({ id: "c1", project: null }) });
  });

  it("keeps a PDF in a personal conversation in the app: its viewer offers Download, never Share", async () => {
    const { closeLightbox } = await import("../web/src/views/lightbox.js");
    history[1] = { ...history[1]!, files: [{ sha256: "4".repeat(64), name: "Pitch deck.pdf", bytes: 90_000 }] };
    const tools = async () => {
      root.querySelector<HTMLAnchorElement>('.chat-msg[data-id="h2"] .chat-file')!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      const labels = [...document.querySelectorAll<HTMLButtonElement>(".lightbox .lightbox-share")].map((one) => one.getAttribute("aria-label") ?? one.textContent);
      closeLightbox();
      await settle();
      return labels;
    };
    chat.mount(root);
    await settle();
    expect(await tools()).toEqual(["Download Pitch deck.pdf", "Share Pitch deck.pdf"]);
    for (const fn of listeners.thread ?? []) fn({ data: JSON.stringify({ id: "c1", project: "personal" }) });
    await settle();
    expect(await tools()).toEqual(["Download Pitch deck.pdf"]);
    for (const fn of listeners.thread ?? []) fn({ data: JSON.stringify({ id: "c1", project: null }) });
  });

  it("shares nothing from a PDF viewer left open while its conversation turned personal", async () => {
    const { closeLightbox } = await import("../web/src/views/lightbox.js");
    history[1] = { ...history[1]!, files: [{ sha256: "4".repeat(64), name: "Pitch deck.pdf", bytes: 90_000 }] };
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input).startsWith("/media/") ? new Response(new Blob(["%PDF-1.4\n"], { type: "application/pdf" }), { status: 200, headers: { "content-type": "application/pdf" } }) : fakeFetch(input),
    );
    useShare(() => Promise.resolve());
    Object.defineProperty(navigator, "canShare", { value: () => true, configurable: true, writable: true });
    chat.mount(root);
    await settle();
    root.querySelector<HTMLAnchorElement>('.chat-msg[data-id="h2"] .chat-file')!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await settle();
    const shareTool = document.querySelector<HTMLButtonElement>('.lightbox [aria-label="Share Pitch deck.pdf"]')!;
    expect(shareTool.hidden).toBe(false);
    for (const fn of listeners.thread ?? []) fn({ data: JSON.stringify({ id: "c1", project: "personal" }) });
    await settle();
    shareTool.click();
    await settle();
    expect(share).not.toHaveBeenCalled();
    expect(shareTool.isConnected).toBe(false);
    expect(document.querySelector(".lightbox")!.textContent).toContain("This conversation is personal now: it stays in the app.");
    closeLightbox();
    for (const fn of listeners.thread ?? []) fn({ data: JSON.stringify({ id: "c1", project: null }) });
  });

  it("puts Share on Rivet's replies only", async () => {
    chat.mount(root);
    await settle();
    expect(root.querySelector('.chat-msg[data-id="h2"] .chat-share')).not.toBeNull();
    expect(root.querySelector('.chat-msg[data-id="c1"] .chat-share')).toBeNull();
  });

  it("shows no Reply under a bubble until it is tapped, and keeps it open through a redraw", async () => {
    chat.mount(root);
    await settle();
    const reply = () => root.querySelector<HTMLElement>('.chat-msg[data-id="h2"] .chat-reply')!;
    const share = () => root.querySelector<HTMLElement>('.chat-msg[data-id="h2"] .chat-share')!;
    const meta = () => root.querySelector<HTMLButtonElement>('.chat-msg[data-id="h2"] .chat-meta-tap')!;
    expect(reply().hidden).toBe(true);
    expect(share().hidden).toBe(true);
    expect(meta().getAttribute("aria-expanded")).toBe("false");

    meta().click();
    expect(reply().hidden).toBe(false);
    expect(share().hidden).toBe(false);
    expect(meta().getAttribute("aria-expanded")).toBe("true");
    for (const fn of listeners.thread ?? []) fn({ data: JSON.stringify({ id: "c1", project: null }) });
    await settle();
    expect(share().hidden).toBe(false);

    meta().click();
    expect(share().hidden).toBe(true);

    // A tap anywhere on the message opens them too; a tap on a link in it does not.
    root.querySelector<HTMLElement>('.chat-msg[data-id="h2"] .chat-body')!.click();
    expect(reply().hidden).toBe(false);
    root.querySelector<HTMLElement>('.chat-msg[data-id="h2"] .chat-body')!.click();
    expect(reply().hidden).toBe(true);
  });

  it("shares exactly the edited, trimmed text", async () => {
    useShare(() => Promise.resolve());
    await openReplyShare();
    expect(area().value).toBe(REPLY);
    area().value = "  The demo is ready.\n\n ";
    sheetButton("Send").click();
    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({ text: "The demo is ready." });
    await settle();
    expect(sheet()).toBeNull();
    expect(opened).not.toHaveBeenCalled();
  });

  it("Cancel shares nothing and leaves the chat as it was", async () => {
    useShare(() => Promise.resolve());
    await openReplyShare();
    const before = root.querySelector(".chat-thread")!.innerHTML;
    area().value = "edited";
    sheetButton("Cancel").click();
    await settle();
    expect(sheet()).toBeNull();
    expect(share).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    expect(root.querySelector(".chat-thread")!.innerHTML).toBe(before);
  });

  it("copies the text when there is no share sheet", async () => {
    const wrote = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText: wrote }, configurable: true });
    await openReplyShare();
    sheetButton("Send").click();
    expect(wrote).toHaveBeenCalledWith(REPLY);
    expect(opened).not.toHaveBeenCalled();
    expect(sheet()).toBeNull();
  });

  it("a cancelled share sheet is quiet; a refused one says so; the chat carries on", async () => {
    useShare(() => Promise.reject(new DOMException("Share canceled", "AbortError")));
    await openReplyShare();
    sheetButton("Send").click();
    await settle();
    expect(flashed).toEqual([]);
    expect(sheet()).not.toBeNull();
    expect(sheetButton("Send").disabled).toBe(false);

    useShare(() => Promise.reject(new DOMException("Not allowed", "NotAllowedError")));
    sheetButton("Send").click();
    await settle();
    expect(flashed).toEqual(["Couldn't open the share sheet. Try again."]);
    expect(sheet()).not.toBeNull();
    expect(opened).not.toHaveBeenCalled();

    sheetButton("Cancel").click();
    const next: ChatMessage = { id: "h3", from: "rivet", text: "Still here", at: "2030-01-01T00:00:03.000Z", threadId: "c1" };
    for (const fn of listeners.message ?? []) fn({ data: JSON.stringify(next) });
    expect(root.querySelector('.chat-msg[data-id="h3"] .chat-body')?.textContent).toBe("Still here");
    useShare(() => Promise.resolve());
    root.querySelector<HTMLButtonElement>('.chat-msg[data-id="h3"] .chat-share')!.click();
    sheetButton("Send").click();
    expect(share).toHaveBeenCalledWith({ text: "Still here" });
  });
});

describe("a share sheet left open", () => {
  it("gives Send back after SHARE_WAIT_MS, and a late share still closes the sheet", async () => {
    let answer!: () => void;
    useShare(() => new Promise<void>((done) => (answer = done)));
    await openReplyShare();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    sheetButton("Send").click();
    expect(sheetButton("Send").disabled).toBe(true);
    vi.advanceTimersByTime(SHARE_WAIT_MS - 1);
    expect(sheetButton("Send").disabled).toBe(true);
    vi.advanceTimersByTime(1);
    expect(sheetButton("Send").disabled).toBe(false);

    vi.useRealTimers();
    answer();
    await settle();
    expect(sheet()).toBeNull();
    expect(flashed).toEqual([]);
  });
});

describe("links in chat", () => {
  it("links https URLs in both Rivet's replies and your messages, and nothing else", async () => {
    history = [
      { id: "c1", from: "owner", text: "Is https://rivet.example.com up? not javascript:alert(1)", at: "2030-01-01T00:00:01.000Z", status: "replied" },
      { id: "h2", from: "rivet", text: "Yes: https://github.com/example-org/example-repo/pull/2504.", at: "2030-01-01T00:00:02.000Z" },
    ];
    chat.mount(root);
    await settle();
    const hrefs = (id: string) => [...root.querySelectorAll(`.chat-msg[data-id="${id}"] .chat-body a`)].map((a) => a.getAttribute("href"));
    expect(hrefs("c1")).toEqual(["https://rivet.example.com/"]);
    expect(hrefs("h2")).toEqual(["https://github.com/example-org/example-repo/pull/2504"]);
    expect(root.querySelector('.chat-msg[data-id="h2"] .chat-body')!.textContent).toBe(history[1]!.text);
  });
});

