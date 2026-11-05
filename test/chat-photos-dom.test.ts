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

const chat = await import("../web/src/views/chat.js");

const A = "a".repeat(64);
const B = "b".repeat(64);
const V = "c".repeat(64);
let history: ChatMessage[] = [];
let listeners: Record<string, ((event?: { data: string }) => void)[]> = {};
let root: HTMLElement;

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
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

beforeEach(() => {
  listeners = {};
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

describe("Rivet's photos and video in a chat answer", () => {
  it("shows a photo-only answer's photo in the bubble, and a tap opens it full screen", async () => {
    history = [{ id: "h1", from: "rivet", text: "", at: "2030-01-01T00:00:01.000Z", image: A }];
    chat.mount(root);
    await settle();
    const bubble = root.querySelector('.chat-msg.theirs[data-id="h1"]')!;
    expect(bubble.querySelector(".chat-image")!.getAttribute("src")).toBe(`/media/${A}`);
    expect(bubble.querySelector(".chat-body")).toBeNull();
    // Share sends text; a photo-only answer has none.
    expect(bubble.querySelector(".chat-share")).toBeNull();
    bubble.querySelector<HTMLButtonElement>(".chat-image-open")!.click();
    expect(document.querySelector(".lightbox-img")!.getAttribute("src")).toBe(`/media/${A}`);
  });

  it("shows several photos as tiles, the video with its own controls, then the text", async () => {
    history = [{ id: "h2", from: "rivet", text: "Photo test: the new skin", at: "2030-01-01T00:00:02.000Z", images: [A, B], video: V }];
    chat.mount(root);
    await settle();
    const bubble = root.querySelector('.chat-msg.theirs[data-id="h2"]')!;
    expect([...bubble.querySelectorAll(".chat-images .chat-image-tile")].map((img) => [img.getAttribute("src"), img.getAttribute("alt")])).toEqual([
      [`/media/${A}`, "Photo, 1 of 2"],
      [`/media/${B}`, "Photo, 2 of 2"],
    ]);
    const video = bubble.querySelector<HTMLVideoElement>("video.chat-video")!;
    expect(video.getAttribute("src")).toBe(`/media/${V}`);
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.hasAttribute("playsinline")).toBe(true);
    expect(video.getAttribute("preload")).toBe("metadata");
    expect([...bubble.children].map((child) => child.className)).toEqual(["rivet is-clear is-rivet chat-rivet", "chat-images", "chat-video", "chat-body", "chat-foot"]);
  });

  it("keeps the same video element through a redraw, so a playing clip is not stopped or rewound", async () => {
    history = [{ id: "h3", from: "rivet", text: "The clip", at: "2030-01-01T00:00:03.000Z", video: V }];
    chat.mount(root);
    await settle();
    const before = root.querySelector("video.chat-video")!;
    // A new message redraws every bubble.
    const next: ChatMessage = { id: "h4", from: "rivet", text: "And one more", at: "2030-01-01T00:00:04.000Z", threadId: "c1" };
    for (const fn of listeners.message ?? []) fn({ data: JSON.stringify(next) });
    await settle();
    expect(root.querySelector('.chat-msg[data-id="h4"]')).not.toBeNull();
    expect(root.querySelectorAll("video.chat-video")).toHaveLength(1);
    expect(root.querySelector("video.chat-video")).toBe(before);
  });
});
