// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { watchViewing, workerRefresh, type Viewing } from "../web/src/push.js";
import { closeSheet, openSheet } from "../web/src/views/sheet.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("what the app tells the service worker it shows", () => {
  let posted: Record<string, unknown>[];
  let view: Viewing | null;
  let stop: () => void;

  beforeEach(() => {
    posted = [];
    view = { tab: "feed", card: "c1", chat: "k1" };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { controller: { postMessage: (message: Record<string, unknown>) => posted.push(message) }, addEventListener: () => {}, removeEventListener: () => {} },
    });
    stop = watchViewing(() => view);
  });
  afterEach(() => {
    stop();
    closeSheet();
    document.body.replaceChildren();
  });

  it("reports the card and chat on screen, and nothing while a sheet covers them", async () => {
    expect(posted.at(-1)).toMatchObject({ type: "viewing", tab: "feed", card: "c1", chat: "k1", visible: true });

    openSheet("Settings", { mount: (el) => el.append("settings"), unmount: () => {} });
    await tick();
    expect(posted.at(-1)).toEqual({ type: "viewing", tab: "feed", visible: true });

    closeSheet();
    await tick();
    expect(posted.at(-1)).toMatchObject({ card: "c1", chat: "k1" });
  });

  it("reports nothing while the feed's own comment sheet covers the view", async () => {
    const backdrop = document.createElement("div");
    backdrop.className = "sheet-backdrop";
    document.body.append(backdrop);
    await tick();
    expect(posted.at(-1)).toEqual({ type: "viewing", tab: "feed", visible: true });
    backdrop.remove();
    await tick();
    expect(posted.at(-1)).toMatchObject({ card: "c1", chat: "k1" });
  });

  it("re-reports when an iPhone clip enters native full screen", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    await tick();
    const before = posted.length;
    view = { tab: "feed", card: "c3", chat: null };
    video.dispatchEvent(new Event("webkitbeginfullscreen"));
    await tick();
    expect(posted.slice(before)).toEqual([{ type: "viewing", tab: "feed", card: "c3", visible: true }]);
  });

  it("re-reports after a redraw moves to another card, once per change", async () => {
    const before = posted.length;
    view = { tab: "feed", card: "c2", chat: null };
    document.body.append(document.createElement("div"));
    await tick();
    expect(posted.slice(before)).toEqual([{ type: "viewing", tab: "feed", card: "c2", visible: true }]);
    document.body.append(document.createElement("div"));
    await tick();
    expect(posted).toHaveLength(before + 1);
  });

  it("reports nothing shown once signed out", async () => {
    view = null;
    document.body.append(document.createElement("div"));
    await tick();
    expect(posted.at(-1)).toEqual({ type: "viewing", tab: "signed-out", visible: true });
  });
});

describe("a refresh from the service worker", () => {
  let posted: Record<string, unknown>[];
  beforeEach(() => {
    posted = [];
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { controller: { postMessage: (message: Record<string, unknown>) => posted.push(message) } },
    });
  });

  it("reloads the chat thread for a chat push and the board for a card push, and acknowledges each redraw", async () => {
    const chat = vi.fn(async () => true);
    const board = vi.fn(async () => true);
    await workerRefresh({ type: "refresh", id: "1", chat: "k1" } as { chat?: unknown }, chat, board, () => "k1");
    expect([chat.mock.calls.length, board.mock.calls.length]).toEqual([1, 0]);
    await workerRefresh({ type: "refresh", id: "2", card: "c1" } as { chat?: unknown }, chat, board, () => null);
    expect([chat.mock.calls.length, board.mock.calls.length]).toEqual([1, 1]);
    expect(posted).toEqual([
      { type: "refresh-ack", id: "1" },
      { type: "refresh-ack", id: "2" },
    ]);
  });

  it("does not acknowledge a refresh that did not redraw", async () => {
    await workerRefresh({ type: "refresh", id: "1", chat: "k1" } as { chat?: unknown }, async () => false, async () => true, () => "k1");
    await workerRefresh({ type: "refresh", id: "2", card: "c1" } as { chat?: unknown }, async () => true, async () => false, () => null);
    expect(posted).toEqual([]);
  });

  it("does not acknowledge a chat push once its conversation is no longer open", async () => {
    // Back on the list, or in another conversation, when the refresh lands: the notification stands.
    await workerRefresh({ type: "refresh", id: "1", chat: "k1" } as { chat?: unknown }, async () => true, async () => true, () => null);
    await workerRefresh({ type: "refresh", id: "2", chat: "k1" } as { chat?: unknown }, async () => true, async () => true, () => "w1");
    expect(posted).toEqual([]);
  });

  it("does not acknowledge a redraw behind a sheet", async () => {
    openSheet("Settings", { mount: (el) => el.append("settings"), unmount: () => {} });
    await workerRefresh({ type: "refresh", id: "1", chat: "k1" } as { chat?: unknown }, async () => true, async () => true, () => "k1");
    closeSheet();
    const backdrop = document.createElement("div");
    backdrop.className = "sheet-backdrop";
    document.body.append(backdrop);
    await workerRefresh({ type: "refresh", id: "2", card: "c1" } as { chat?: unknown }, async () => true, async () => true, () => "k1");
    backdrop.remove();
    expect(posted).toEqual([]);
  });
});
