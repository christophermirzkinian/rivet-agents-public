// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MediaItem, MediaPage } from "../src/shared/media.js";
import { app } from "../web/src/state.js";
import { closeLightbox } from "../web/src/views/lightbox.js";
import * as media from "../web/src/views/media.js";
import { closeSheet } from "../web/src/views/sheet.js";

// The Media tab: entries by local day, newest first, and the viewer's one way back to the card or the conversation.

const sha = (c: string) => c.repeat(64);
const answered: MediaItem[] = ["1", "2"].map((c) => ({
  sha: sha(c),
  type: "image/png",
  // 1:30am on Saturday 3 October at UTC+11, still the 2nd in UTC.
  at: "2026-10-02T14:30:00.000Z",
  source: "card",
  title: "Results page: the new charts",
  card: { id: "pear-charts", onBoard: false, ask: "Do the charts read at a glance?", answer: { decision: "choice", choice: "Ship it", at: "2026-10-02T15:00:00.000Z" } },
}));
const chat: MediaItem = {
  sha: sha("3"),
  type: "video/mp4",
  // 11:30pm on Friday 2 October at UTC+11.
  at: "2026-10-02T12:30:00.000Z",
  source: "chat",
  title: "Results row",
  chat: { conversation: "k1", message: "k3" },
};
const open: MediaItem = {
  sha: sha("4"),
  type: "image/jpeg",
  // 2:14pm on Thursday 1 October at UTC+11.
  at: "2026-10-01T03:14:00.000Z",
  source: "card",
  title: "Quiz app: the sky",
  card: { id: "quiz-sky", onBoard: true },
};

let root: HTMLElement;
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const page: MediaPage = { items: [...answered, chat, open], next: null };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 2pm on Saturday 3 October at UTC+11.
  vi.setSystemTime(new Date("2026-10-03T03:00:00.000Z"));
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(String(input).startsWith("/api/media") ? new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } }) : new Response("{}", { status: 404 })),
    ),
  );
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(history, "back").mockImplementation(() => window.dispatchEvent(new PopStateEvent("popstate")));
  document.body.innerHTML = "";
  root = document.createElement("main");
  document.body.append(root);
  app.tab = "more";
  app.morePage = "media";
  app.chatFocus = null;
  app.board = null;
  media.mount(root);
  await settle();
});

afterEach(() => {
  media.unmount();
  closeLightbox();
  closeSheet();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const thumbs = () => [...root.querySelectorAll<HTMLButtonElement>(".media-tab-thumb")];
const action = () => document.querySelector<HTMLButtonElement>(".lightbox-action");

describe("the Media tab", () => {
  it("groups by local day, newest first, one entry per card or message, with the time", () => {
    expect([...root.querySelectorAll(".media-tab-day-title")].map((el) => el.textContent)).toEqual(["Today", "Yesterday", "Thu 1 Oct"]);
    const entries = [...root.querySelectorAll(".media-tab-entry")];
    expect(entries).toHaveLength(3);
    expect(entries[0]!.querySelectorAll(".media-tab-thumb")).toHaveLength(2);
    expect([...entries].map((entry) => entry.querySelector(".media-tab-kind")!.textContent)).toEqual(["Card", "Chat", "Card"]);
    expect(entries[1]!.querySelector(".media-tab-title")!.textContent).toBe("Results row");
    expect([...entries].map((entry) => entry.querySelector(".media-tab-time")!.textContent)).toEqual(["1:30am", "11:30pm", "2:14pm"]);
    // A clip with no poster shows its first frame, with a play mark.
    expect(entries[1]!.querySelector("video")?.getAttribute("preload")).toBe("metadata");
    expect(entries[1]!.querySelector(".media-tab-play")).not.toBeNull();
  });

  it("says so in one line when there is nothing yet", async () => {
    page.items = [];
    await media.refresh();
    expect(root.querySelector(".media-tab-note")!.textContent).toBe("No photos or videos yet.");
    page.items = [...answered, chat, open];
  });

  it("Open chat leaves the viewer for the conversation, on the message", async () => {
    thumbs()[2]!.click();
    expect(document.querySelector(".lightbox video")).not.toBeNull();
    expect(action()!.textContent).toBe("Open chat");
    action()!.click();
    await settle();
    expect(document.querySelector(".lightbox")).toBeNull();
    expect(app.tab).toBe("chat");
    expect(app.chatFocus).toBe("k3");
  });

  it("Open card shows an answered card's ask and your answer once it has left the board", async () => {
    thumbs()[1]!.click();
    expect(document.querySelector(".lightbox-img")?.getAttribute("src")).toBe(`/media/${sha("2")}`);
    expect(action()!.textContent).toBe("Open card");
    action()!.click();
    await settle();
    expect(document.querySelector(".lightbox")).toBeNull();
    expect(document.querySelector(".sheet-title")!.textContent).toBe("Results page: the new charts");
    expect(document.querySelector(".media-tab-ask")!.textContent).toBe("Do the charts read at a glance?");
    expect(document.querySelector(".media-tab-answer")!.textContent).toBe("Chose: Ship it");
    expect(document.querySelector(".media-tab-answered")!.textContent).toBe("You answered today at 2:00am.");
    expect([app.tab, app.morePage]).toEqual(["more", "media"]);
  });

  it("Open card goes to the card itself while it is on the board", async () => {
    app.board = { version: 1, updatedAt: null, board: { updatedAt: "", needs: [{ id: "quiz-sky", kind: "fyi", title: "Quiz app: the sky", rev: "r1" }], coming: [], chats: [], shipped: [] } } as unknown as typeof app.board;
    thumbs()[3]!.click();
    action()!.click();
    await settle();
    expect(app.tab).toBe("cards");
    expect(app.front).toBe("quiz-sky");
    expect(document.querySelector(".sheet")).toBeNull();
  });

  it("a newer card request wins while the viewer's Open card Back is pending", async () => {
    const { showCard } = await import("../web/src/views/feed.js");
    app.board = { version: 1, updatedAt: null, board: { updatedAt: "", needs: ["quiz-sky", "newer"].map((id) => ({ id, kind: "fyi", title: id, rev: "r1" })), coming: [], chats: [], shipped: [] } } as unknown as typeof app.board;
    vi.mocked(history.back).mockImplementation(() => undefined);
    thumbs()[3]!.click();
    action()!.click();
    showCard("newer");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await settle();
    expect(app.tab).toBe("cards");
    expect(app.front).toBe("newer");
  });

  it("gives each file of a card from before the record an entry of its own, with nothing to open", () => {
    const earlier = (c: string): MediaItem => ({ sha: sha(c), type: "image/jpeg", at: "2026-09-01T00:00:00.000Z", source: "card", title: "Earlier card" });
    expect(media.entries([earlier("5"), earlier("6")]).map((entry) => entry.items.length)).toEqual([1, 1]);
    expect(media.sourceAction(earlier("5"))).toBeUndefined();
  });

  it("styles only its own classes, so a card's video Play button keeps its look", () => {
    const css = readFileSync(resolve(process.cwd(), "web/src/views/media.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = css.match(/[^{}]+(?=\{)/g)!.flatMap((rule) => rule.split(","));
    for (const selector of selectors) expect(selector).toMatch(/\.media-tab/);
    const classes = new Set(css.match(/\.[a-z][a-z-]*/g));
    for (const name of classes) expect(["media-play", "media-title", "media-source", "media-note", "card", "chat"]).not.toContain(name.slice(1));
  });
});
