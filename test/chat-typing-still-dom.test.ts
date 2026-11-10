// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../src/shared/command.js";
import { fakeServer } from "./conversations-fake.js";

vi.mock("../web/src/voice.js", async (original) => ({
  ...((await original()) as Record<string, unknown>),
  say: () => {},
  unlockVoice: () => Promise.resolve(true),
  unlockOnTap: () => () => {},
  stopVoice: () => {},
}));

const chat = await import("../web/src/views/chat.js");

class FakeSource {
  static CLOSED = 2;
  readyState = 1;
  addEventListener() {}
  close() {}
}

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const MESSAGES: ChatMessage[] = [
  { id: "m1", from: "owner", text: "Morning", at: "2030-01-01T00:00:00.000Z", status: "replied", threadId: "m1" },
  { id: "m2", from: "rivet", text: "Morning. Three things building.", at: "2030-01-01T00:00:01.000Z", threadId: "m1" },
];

// Rivet's sheet on a phone with the keyboard up, as Chrome lays it out (measured in web/preview/typing-jump.mjs): the
// sheet's chat shows 351px; its head, More topics and the attached photo take 263px over the box.
const SHOWN = 351;
const ABOVE_BOX = 263;
const ONE_LINE = 45;
const TEXT_HEIGHT = 519;

let root: HTMLElement;

/**
 * happy-dom lays nothing out, so the sheet's scroll is modelled: it can scroll as far as its content overflows, and
 * reading the box's scrollHeight lays the page out, which clamps the scroll to the box's height at that moment.
 */
function layOut(host: HTMLElement, text: HTMLTextAreaElement): void {
  let top = 0;
  const boxHeight = () => (text.style.height === "auto" || !text.style.height ? ONE_LINE : Number.parseFloat(text.style.height));
  const clamp = (value: number) => Math.max(0, Math.min(value, ABOVE_BOX + boxHeight() - SHOWN));
  Object.defineProperty(host, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = clamp(value);
    },
  });
  Object.defineProperty(text, "scrollHeight", {
    configurable: true,
    get: () => {
      top = clamp(top);
      return TEXT_HEIGHT;
    },
  });
}

beforeEach(() => {
  const server = fakeServer(MESSAGES.map((message) => ({ ...message })), { k1: { title: "Night Batch results row" } });
  history.replaceState(null, "");
  vi.stubGlobal("fetch", vi.fn(server.fetch));
  vi.stubGlobal("EventSource", FakeSource);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  root = document.createElement("div");
  root.className = "home-chat";
  document.body.replaceChildren(root);
});

afterEach(() => {
  chat.unmount();
  vi.unstubAllGlobals();
});

describe("typing in Rivet's sheet with the keyboard up", () => {
  it("More topics and the box stay where they are on every key", async () => {
    chat.startDraft("");
    chat.mount(root);
    await settle();
    root.querySelector<HTMLButtonElement>(".thing-back")?.click();
    await settle();
    const text = root.querySelector<HTMLTextAreaElement>(".chat-text")!;
    const row = root.querySelector<HTMLElement>(".chat-topics-row")!;
    expect(row.textContent).toContain("More topics");
    layOut(root, text);
    text.value = "Before the next release, can we check the sign-up names";
    text.dispatchEvent(new Event("input"));
    // The phone's Chrome brings the whole box above the keyboard, which scrolls More topics mostly out of view.
    root.scrollTop = 64;
    expect(root.scrollTop).toBe(64);

    const seen = new Set<string>();
    for (const key of " so nothing rude or out of place gets through?") {
      text.value += key;
      text.dispatchEvent(new Event("input"));
      // What is on screen after the key: how far the sheet is scrolled, More topics there, and the box's height.
      seen.add(JSON.stringify([root.scrollTop, row.hidden, row.isConnected, row.textContent, text.style.height]));
    }
    expect([...seen]).toEqual([JSON.stringify([64, false, true, row.textContent, "180px"])]);
  });
});
