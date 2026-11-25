// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServedNeed } from "../src/shared/board.js";
import type { ChatMessage } from "../src/shared/command.js";
import { answerText, TEAM_ROOM_ID, UPDATES_ID } from "../src/shared/conversations.js";
import { stopText } from "../web/src/views/thing.js";
import { fakeServer, type FakeConversation, type FakeServer } from "./conversations-fake.js";

// The Chat tab: one conversation with Rivet, with no page per thing.

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
const { setSignedInByCode } = await import("../web/src/session.js");
const { app, cardState, changed } = await import("../web/src/state.js");
const { answerTapsLocked, flushHeld, undoLast } = await import("../web/src/views/feed.js");
const { mountToasts } = await import("../web/src/views/toast.js");
const { closeSheet, openSheet } = await import("../web/src/views/sheet.js");

const at = (minute: number) => new Date(Date.UTC(2030, 0, 1, 0, minute)).toISOString();
const rivet = (id: string, conversation: string, minute: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  from: "rivet",
  text: `Rivet ${id}`,
  at: at(minute),
  threadId: conversation,
  ...extra,
});
const owner = (id: string, conversation: string, minute: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  from: "owner",
  text: `you ${id}`,
  at: at(minute),
  status: "replied",
  threadId: conversation,
  ...extra,
});

// k1 is a thing: Rivet put its plan card in it (kp) and the owner said Yes (ka). g1 and w1 are Chat's.
const MESSAGES = (): ChatMessage[] => [
  rivet(UPDATES_ID, UPDATES_ID, 1, { text: "Updates from Rivet" }),
  rivet("u1", UPDATES_ID, 2, { text: "Nightly: main green" }),
  owner("k1", "k1", 10, { text: "Results row for Results page" }),
  rivet("kp", "k1", 12, { text: "Card: Plan", posted: { id: "plan-k", kind: "plan", title: "Plan: results row", ask: "Bigger row. Size M." } }),
  owner("ka", "k1", 13, { text: "Approved: Plan\nYes", card: "plan-k", status: "sent" }),
  rivet("k2", "k1", 30, { text: "PR #341 is up\nstills attached" }),
  owner("g1", "g1", 20, { text: "quote form" }),
  rivet("g2", "g1", 21),
  owner("g3", "g1", 40, { text: "ship it" }),
  owner("w1", "w1", 5, { text: "Weekly line" }),
  rivet("w2", "w1", 6),
];
const CONVERSATIONS = (): Record<string, FakeConversation> => ({
  [UPDATES_ID]: { title: "Updates", unread: 1 },
  k1: { title: "Results row", needsYou: true, stage: "open", links: { prs: ["#341"], chats: ["results-row"], tag: "Results" } },
  g1: { title: "quote enquiry form", unread: 2, links: { tag: "quote" } },
  w1: { title: "Weekly average line", appOnly: true },
});

let server: FakeServer;
let root: HTMLElement;
let listeners: Record<string, ((event?: { data: string }) => void)[]> = {};

class FakeSource {
  static CLOSED = 2;
  readyState = 1;
  addEventListener(type: string, fn: (event?: { data: string }) => void) {
    (listeners[type] ??= []).push(fn);
  }
  close() {}
}

const settle = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const shownIds = () => [...root.querySelectorAll<HTMLElement>(".chat-msg")].map((el) => el.dataset.id);
/** The Reply on line `id`'s own bubble, its line tapped open first; null with no such line or Reply. */
const replyUnder = (id: string) => {
  const line = root.querySelector<HTMLElement>(`.chat-msg[data-id="${id}"]`);
  const strip = line?.querySelector<HTMLElement>(":scope > .chat-msg-open");
  if (!line || !strip) return null;
  if (!line.classList.contains("open")) {
    expect(strip.hidden).toBe(true);
    line.click();
  }
  expect(strip.hidden).toBe(false);
  return strip.querySelector<HTMLButtonElement>('.chat-msg-tools [data-use="chat.msg.reply"]');
};
const searchBar = () => root.querySelector<HTMLElement>(".chat-search")!;
const magnifier = () => root.querySelector<HTMLButtonElement>(".chat-head .chat-tools > button.chat-find")!;
const litId = () => root.querySelector(".chat-msg.lit")?.getAttribute("data-id");
const box = () => root.querySelector<HTMLTextAreaElement>(".chat-text")!;
const sheet = () => document.querySelector<HTMLElement>(".sheet");
const board = (needs: ServedNeed[]) => {
  app.board = { version: 1, updatedAt: at(0), board: { updatedAt: at(0), needs, coming: [], chats: [], shipped: [] } } as unknown as typeof app.board;
  changed();
};
function type(text: string): void {
  box().value = text;
  box().dispatchEvent(new Event("input"));
}
const send = (text: string) => {
  type(text);
  root.querySelector<HTMLButtonElement>(".chat-send")!.click();
};
const fire = (type: string, data?: unknown) => {
  for (const fn of listeners[type] ?? []) fn(data === undefined ? undefined : { data: JSON.stringify(data) });
};

async function onChat(): Promise<void> {
  chat.startDraft("");
  chat.mount(root);
  await settle();
}

/** Opens line `id`'s More sheet. */
const moreOn = (id: string): HTMLElement => {
  root.querySelector<HTMLElement>(`.chat-msg[data-id="${id}"]`)!.click();
  root.querySelector<HTMLButtonElement>(`.chat-msg[data-id="${id}"] > .chat-msg-open [data-use="chat.msg.more"]`)!.click();
  return document.querySelector<HTMLElement>(".chat-more-sheet")!;
};

beforeEach(() => {
  server = fakeServer(MESSAGES(), CONVERSATIONS());
  said.length = 0;
  listeners = {};
  history.replaceState(null, "");
  vi.stubGlobal("fetch", vi.fn(server.fetch));
  vi.stubGlobal("EventSource", FakeSource);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  app.chatFocus = null;
  app.chatUnread = 0;
  root = document.createElement("main");
  document.body.replaceChildren(root);
});

afterEach(() => {
  closeSheet();
  chat.unmount();
  app.board = null;
  app.status = null;
  app.workers = null;
  app.workersAt = null;
  vi.unstubAllGlobals();
});

describe("Chat", () => {
  it("is one conversation with Rivet: Chat's lines in time order, no list, a thing's card line a posted bubble", async () => {
    await onChat();
    expect(chat.openConversation()).toBeNull();
    // Updates' news is the Feed's; every other line shows, a thing's after its card too, all in time order.
    expect(shownIds()).toEqual(["w1", "w2", "k1", "kp", "ka", "g1", "g2", "k2", "g3"]);
    expect(root.querySelector(".conv-row, .conv-read-all, .conv-select, .conv-menu, .conv-new")).toBeNull();
    expect(root.querySelector(".chat-thing-row, .chat-thing-link, .chat-topic-link")).toBeNull();
    const kp = root.querySelector<HTMLElement>('.chat-msg[data-id="kp"]')!;
    expect(kp.classList.contains("posted")).toBe(true);
    expect(kp.querySelector(".chat-posted-title")!.textContent).toBe("Plan: results row");
    expect(root.querySelector<HTMLElement>(".chat-head")!.hidden).toBe(false);
    expect(box().placeholder).toBe("Message");
  });

  it("a card answer's Chat line names the card once, whatever the kind of answer", () => {
    const line = (decision: string, more: { choice?: string; text?: string } = {}) =>
      chat.answerLine("Top 10 chart libraries research", answerText({ decision, itemTitle: "Top 10 chart libraries research", ...more }));
    expect(line("dismiss")).toBe("You dismissed “Top 10 chart libraries research”");
    expect(line("approve")).toBe("You approved “Top 10 chart libraries research”");
    expect(line("approve", { text: "Yes" })).toBe("You approved “Top 10 chart libraries research” · Yes");
    expect(line("choice", { choice: "Yes, put it on the site" })).toBe("You answered “Top 10 chart libraries research”: Yes, put it on the site");
    expect(line("choice", { choice: "No", text: "Later" })).toBe("You answered “Top 10 chart libraries research”: No · Later");
    expect(line("comment", { text: "Make it bigger" })).toBe("You commented on “Top 10 chart libraries research”: Make it bigger");
    expect(line("reject")).toBe("You sent “Top 10 chart libraries research” back to fix");
    expect(line("seen")).toBe("You marked “Top 10 chart libraries research” seen");
    expect(line("done")).toBe("You marked “Top 10 chart libraries research” done");
    expect(chat.answerLine("X", "Typed straight")).toBe("You answered “X”: Typed straight");
    // Once the board card, the posting line and the conversation are all gone: an approval still names its card.
    expect(chat.answerLine(undefined, "Approved: Demo video\nYes")).toBe("You approved “Demo video” · Yes");
    expect(chat.answerLine(undefined, "Chose: Yes")).toBe("You answered a card: Yes");
    expect(chat.answerLine(undefined, "Dismissed")).toBe("You dismissed a card");
  });

  it("a card answer in Chat is his bubble reading You answered “card”: the answer", async () => {
    server.messages.push(owner("ga", "g1", 41, { text: "Chose: Yes, put it on the site", card: "card-g", status: "sent" }));
    server.messages.push(owner("gb", "g1", 42, { text: "Chose: Not yet", card: "card-old", cardTitle: "Old pricing card", status: "sent" }));
    await onChat();
    const body = (id: string) => root.querySelector(`.chat-msg[data-id="${id}"] .chat-body`)!.textContent;
    expect(root.querySelector(".chat-answer-row")).toBeNull();
    expect(body("ka")).toBe("You approved “Plan: results row” · Yes");
    // Chat names the card, never its conversation: the server's title for an old answer, "a card" when it has none.
    expect(body("gb")).toBe("You answered “Old pricing card”: Not yet");
    expect(body("ga")).toBe("You answered a card: Yes, put it on the site");
    board([{ id: "card-g", kind: "decision", title: "quote form live?", ask: "Live?", rev: "r1" }]);
    expect(body("ga")).toBe("You answered “quote form live?”: Yes, put it on the site");
  });

  it("a card answer leaves other Chat lines as they were and shows once; Rivet's follow-up under it shows in Chat", async () => {
    await onChat();
    const reply = rivet("kr", "k1", 14, { text: "Building it now", replyTo: "ka" });
    server.messages.push(reply);
    fire("message", reply);
    const answer = owner("kb", "k1", 15, { text: "Done", card: "plan-k", status: "sent" });
    server.messages.push(answer);
    fire("message", answer);
    await settle();
    expect(shownIds()).toContain("kr");
    expect(root.querySelectorAll('[data-id="kb"]')).toHaveLength(1);
    expect(root.querySelector('.chat-msg[data-id="kb"] .chat-body')!.textContent).toBe("You marked “Plan: results row” done");
    expect(root.querySelector('.chat-msg[data-id="g1"] .chat-body')!.textContent).toBe("quote form");
    // A reload reads the same lines from the server.
    chat.unmount();
    await onChat();
    expect(shownIds()).toEqual(["w1", "w2", "k1", "kp", "ka", "kr", "kb", "g1", "g2", "k2", "g3"]);
  });

  it("a notification's tap before Chat mounts opens Chat at its line, lit, with no page and no history entry", async () => {
    const went = vi.spyOn(history, "back").mockImplementation(() => undefined);
    // Its plan card's line, asked for before Chat mounts, as a notification's tap at launch asks (main.ts).
    chat.showLine("k1", "kp");
    chat.mount(root);
    await settle();
    expect(litId()).toBe("kp");
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    expect(shownIds()).toEqual(["w1", "w2", "k1", "kp", "ka", "g1", "g2", "k2", "g3"]);
    expect(root.querySelector(".thing-head")).toBeNull();
    expect(chat.openConversation()).toBeNull();
    expect(history.state?.chatScreen).toBeUndefined();
    expect(went).not.toHaveBeenCalled();
    went.mockRestore();
  });

  it("every message typed in Chat goes with no conversation, after a line was brought up too; a Reply names the line it answers", async () => {
    await onChat();
    const sent = () => server.posted.filter((body) => "text" in body);
    send("Add a leaderboard to the quiz app");
    await settle();
    expect(sent()[0]).toMatchObject({ text: "Add a leaderboard to the quiz app", conversation: null });
    expect(chat.openConversation()).toBeNull();
    expect(root.querySelector('.chat-msg[data-id="c9-1"] .chat-body')!.textContent).toBe("Add a leaderboard to the quiz app");
    send("and a weekly reset");
    await settle();
    expect(sent().at(-1)).toMatchObject({ conversation: null });
    chat.showLine("k1");
    await settle();
    expect(box().placeholder).toBe("Message");
    send("bigger still");
    await settle();
    expect(sent().at(-1)).toMatchObject({ text: "bigger still", conversation: null });
    expect(sent().at(-1)).not.toHaveProperty("replyTo");
    replyUnder("k2")!.click();
    send("yes, merge it");
    await settle();
    expect(sent().at(-1)).toMatchObject({ text: "yes, merge it", replyTo: "k2", conversation: null });
    // The server puts a Reply in the replied line's conversation.
    expect(server.messages.find((one) => one.id === "c9-4")!.threadId).toBe("k1");
    expect(shownIds()).toContain("c9-4");
  });

  it("a Reply in Chat to a server-owned room's line (Agent Chat) names that line, with no conversation of its own", async () => {
    server.messages.push(rivet("s1", TEAM_ROOM_ID, 4, { text: "The build is green" }));
    await onChat();
    expect(shownIds()).toContain("s1");
    replyUnder("s1")!.click();
    send("why did it fail?");
    await settle();
    expect(server.posted.filter((body) => "text" in body).at(-1)).toMatchObject({ text: "why did it fail?", replyTo: "s1", conversation: null });
  });

  it("Chat at its newest reads its own lines and a thing's unread reply, which it shows", async () => {
    server.conversations.get("k1")!.unread = 1;
    server.conversations.set("w1", { ...server.conversations.get("w1"), unread: 1 });
    await onChat();
    expect(shownIds()).toContain("k2");
    // g1, w1 and the thing k1: read now, in one request.
    expect(server.posted).toContainEqual({ ids: ["g1", "k1", "w1"], action: "read" });
    expect(server.conversations.get("k1")!.unread).toBe(0);
    expect(app.chatUnread).toBe(0);
  });

  it("Chat at its newest leaves a thing whose newest line it has not loaded unread", async () => {
    server.conversations.set("k1", { ...server.conversations.get("k1"), unread: 1 });
    // Its newest line is a line Chat's page never got.
    server.messages.push(rivet("kn", "k1", 90, { text: "Later" }));
    const real = server.fetch;
    server.fetch = async (input, init) => {
      const response = await real(input, init);
      if (!String(input).includes("/api/chat?")) return response;
      const page = (await response.json()) as { messages: ChatMessage[] };
      return new Response(JSON.stringify({ ...page, messages: page.messages.filter((one) => one.id !== "kn") }), { headers: { "content-type": "application/json" } });
    };
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    await onChat();
    expect(server.posted.filter((body) => body.action === "read").flatMap((body) => body.ids)).not.toContain("k1");
    expect(server.conversations.get("k1")!.unread).toBe(1);
  });

  it("Chat at its newest leaves a thing unread while an older unread reply in it is off its page", async () => {
    // Two replies unread, a page of other news between them: Chat's first page holds the newer one only.
    const others = Array.from({ length: 50 }, (_, i) => rivet(`gx${i}`, "g1", 13 + i / 100, { text: `News ${i}` }));
    server.messages.splice(0, server.messages.length, rivet("ko", "k1", 12, { text: "Older" }), ...others, rivet("kn", "k1", 40, { text: "Later" }));
    server.conversations.set("k1", { ...server.conversations.get("k1"), unread: 2, thing: true });
    await onChat();
    expect(shownIds()).toContain("kn");
    expect(shownIds()).not.toContain("ko");
    expect(server.posted.filter((body) => body.action === "read").flatMap((body) => body.ids)).not.toContain("k1");
    expect(server.conversations.get("k1")!.unread).toBe(2);
  });

  it("a refresh that keeps an older read reply above a gap does not count it for a thing's unread replies", async () => {
    server.conversations.set("k1", { ...server.conversations.get("k1"), thing: true });
    await onChat();
    expect(shownIds()).toContain("k2");
    // While Chat was away: an unread reply, a page of other news, a second unread reply.
    const others = Array.from({ length: 50 }, (_, i) => rivet(`gy${i}`, "g1", 42 + i / 100, { text: `News ${i}` }));
    server.messages.push(rivet("kr1", "k1", 41, { text: "First" }), ...others, rivet("kr2", "k1", 50, { text: "Second" }));
    server.conversations.set("k1", { ...server.conversations.get("k1"), unread: 2 });
    const before = server.posted.length;
    await chat.refresh();
    await settle();
    expect(shownIds()).toContain("kr2");
    expect(shownIds()).not.toContain("kr1");
    expect(server.posted.slice(before).filter((body) => body.action === "read").flatMap((body) => body.ids)).not.toContain("k1");
    expect(server.conversations.get("k1")!.unread).toBe(2);
  });

  it("Chat at its newest leaves a thing you marked unread yourself: it stays until you open it", async () => {
    server.conversations.set("k1", { ...server.conversations.get("k1"), markedUnread: true });
    await onChat();
    expect(shownIds()).toContain("k2");
    expect(server.posted.filter((body) => body.action === "read").flatMap((body) => body.ids)).not.toContain("k1");
    expect(server.conversations.get("k1")!.markedUnread).toBe(true);
  });

  it("a stream message shows in Chat, a thing's too, and stays once its conversation is brought up", async () => {
    await onChat();
    fire("message", rivet("g7", "g1", 51, { text: "Done" }));
    await settle();
    expect(shownIds()).toContain("g7");
    const k7 = rivet("k7", "k1", 52, { text: "Stills are up" });
    server.messages.push(k7);
    fire("message", k7);
    await settle();
    expect(shownIds().at(-1)).toBe("k7");
    chat.showLine("k1");
    await settle();
    expect(shownIds()).toContain("k7");
  });

  it("a line you type in a thing stays in Chat, with Rivet's reply and card to it and Rivet's notes after", async () => {
    await onChat();
    const lines = [
      owner("k8", "k1", 53, { text: "Settings: bigger buttons" }),
      rivet("k9", "k1", 54, { text: "On it", replyTo: "k8" }),
      rivet("kq", "k1", 55, { text: "Card: Plan", replyTo: "k8", posted: { id: "plan-g", kind: "plan", title: "Plan: goblets", ask: "Bigger. Size S." } }),
      rivet("k10", "k1", 56, { text: "Agent is idle" }),
    ];
    for (const line of lines) {
      server.messages.push(line);
      fire("message", line);
      await settle();
    }
    expect(shownIds()).toEqual(expect.arrayContaining(["k8", "k9", "kq", "k10"]));
    // A reload reads the same lines from the server.
    chat.unmount();
    await onChat();
    expect(shownIds()).toEqual(["w1", "w2", "k1", "kp", "ka", "g1", "g2", "k2", "g3", "k8", "k9", "kq", "k10"]);
  });

  it("searches every conversation's messages from Chat and opens a hit on Chat, lit, with no page; there is no More topics", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      new URL(String(input), "http://x").pathname === "/api/chat/search"
        ? Promise.resolve(new Response(JSON.stringify({ results: [{ kind: "message", key: "message:g2", title: "Rivet g2", open: { type: "message", id: "g2" } }] }), { status: 200, headers: { "content-type": "application/json" } }))
        : server.fetch(input, init),
    ));
    await onChat();
    expect(root.querySelector(".chat-topics-open, .chat-topics, .chat-topic")).toBeNull();
    // The bar waits behind the head's magnifier.
    expect(searchBar().hidden).toBe(true);
    magnifier().click();
    expect(searchBar().hidden).toBe(false);
    const input = root.querySelector<HTMLInputElement>(".chat-search-input")!;
    input.value = "rivet";
    input.dispatchEvent(new Event("input"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await settle();
    expect(root.querySelector(".chat")!.classList.contains("searching")).toBe(true);
    root.querySelector<HTMLButtonElement>(".chat-search-hit")!.click();
    await settle();
    expect(root.querySelector(".chat")!.classList.contains("searching")).toBe(false);
    expect(root.querySelector(".chat-msg.lit")?.getAttribute("data-id")).toBe("g2");
    expect(chat.openConversation()).toBeNull();
    // Picking a hit puts the bar away, emptied.
    expect(searchBar().hidden).toBe(true);
    expect(input.value).toBe("");
    expect(magnifier().getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector(".thing-head")).toBeNull();
    // A conversation brought up stays on Chat, its magnifier still there.
    chat.showLine("k1");
    await settle();
    expect(searchBar().hidden).toBe(true);
    expect(magnifier().hidden).toBe(false);
  });

  it.each([
    ["message", "message", "message:g2"],
    ["title", "chat", "conversation:g"],
  ])("hands the keyboard to the message box when a %s hit chosen from the keyboard goes, never to the page", async (_, kind, key) => {
    vi.stubGlobal("fetch", vi.fn((url: RequestInfo | URL, init?: RequestInit) =>
      new URL(String(url), "http://x").pathname === "/api/chat/search"
        ? Promise.resolve(new Response(JSON.stringify({ results: [{ kind, key, title: "Rivet g2", open: { type: "message", id: "g2" } }] }), { status: 200, headers: { "content-type": "application/json" } }))
        : server.fetch(url, init),
    ));
    await onChat();
    magnifier().click();
    const input = root.querySelector<HTMLInputElement>(".chat-search-input")!;
    input.value = "rivet";
    input.dispatchEvent(new Event("input"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await settle();
    const hit = root.querySelector<HTMLButtonElement>(".chat-search-hit")!;
    hit.focus();
    hit.click();
    await settle();
    expect(hit.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(root.querySelector(".chat-compose textarea"));
  });

  it("keeps search behind a magnifier in the head: a tap shows the bar with the caret in it, a second tap puts it away and clears it", async () => {
    await onChat();
    const tools = [...root.querySelector(".chat-head .chat-tools")!.children];
    // The due clock, the saved lines' bookmark, the magnifier, then the options and their menu.
    expect(tools.map((one) => one.className.split(" ").at(-1))).toEqual(["chat-due", "chat-saved-open", "chat-find", "chat-options", "chat-menu"]);
    expect(magnifier().dataset.use).toBe("chat.search.open");
    expect(magnifier().getAttribute("aria-label")).toBe("Search chat");
    expect(magnifier().getAttribute("aria-expanded")).toBe("false");
    expect(magnifier().hidden).toBe(false);
    expect(searchBar().hidden).toBe(true);
    const input = root.querySelector<HTMLInputElement>(".chat-search-input")!;
    magnifier().click();
    expect(searchBar().hidden).toBe(false);
    expect(magnifier().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(input);
    input.value = "poster";
    magnifier().click();
    expect(searchBar().hidden).toBe(true);
    expect(magnifier().getAttribute("aria-expanded")).toBe("false");
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(magnifier());
  });

  it("Escape on the empty search bar puts it away; with words in it, Escape first clears them", async () => {
    await onChat();
    magnifier().click();
    // Rivet's sheet closes on an Escape that reaches the page: the bar's own Escape never gets there.
    let reached = 0;
    const page = (event: KeyboardEvent) => void (event.key === "Escape" && reached++);
    document.addEventListener("keydown", page);
    const input = root.querySelector<HTMLInputElement>(".chat-search-input")!;
    input.value = "poster";
    // An Escape mid-composition only cancels the keyboard's half-typed word: the query stays.
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true }));
    expect(input.value).toBe("poster");
    expect(reached).toBe(1);
    reached = 0;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(input.value).toBe("");
    expect(searchBar().hidden).toBe(false);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(searchBar().hidden).toBe(true);
    expect(magnifier().getAttribute("aria-expanded")).toBe("false");
    document.removeEventListener("keydown", page);
    expect(reached).toBe(0);
  });

});

describe("a thing's lines in Chat", () => {
  it("a thing's line's More has Stop it, which asks first, then asks Rivet in the line's conversation", async () => {
    server.messages.push(rivet("s1", TEAM_ROOM_ID, 4, { text: "The build is green" }));
    await onChat();
    // A server-owned room's line has no thing to stop.
    expect(moreOn("s1").querySelector('[data-use="chat.more.stop"]')).toBeNull();
    closeSheet();
    moreOn("k2").querySelector<HTMLButtonElement>('[data-use="chat.more.stop"]')!.click();
    expect(sheet()!.textContent).toContain("Ask Rivet to stop results-row?");
    const sent = () => server.posted.filter((body) => "text" in body);
    expect(sent()).toEqual([]);
    sheet()!.querySelector<HTMLButtonElement>('[data-use="chat.more.stop-confirm"]')!.click();
    await settle();
    const words = stopText("results-row", "Results row");
    expect(sent()).toEqual([expect.objectContaining({ text: words, conversation: "k1" })]);
    expect(root.querySelector('.chat-msg[data-id="c9-1"] .chat-body')!.textContent).toBe(words);
  });

  it("Chat that loads under a sheet marks its conversations read only once the sheet closes", async () => {
    openSheet("Search", { mount: () => {}, unmount: () => {} });
    await onChat();
    expect(shownIds()).toContain("g3");
    const marks = () => server.posted.filter((body) => body.action === "read").flatMap((body) => body.ids as string[]);
    expect(marks()).toEqual([]);
    closeSheet();
    // happy-dom delivers the sheet's removal to the coverage observer on a timer of its own.
    await vi.waitFor(() => expect(marks()).toContain("g1"));
  });

  it("a reply picked before a reload, to a thing's line, comes back in Chat on mount", async () => {
    await onChat();
    chat.unmount();
    const quote = { from: "rivet", text: "PR #341 is up" };
    localStorage.setItem("rivet.chat.reply", JSON.stringify({ id: "k2", quote, conversation: "k1" }));
    chat.mount(root);
    await settle();
    expect(root.querySelector<HTMLElement>(".chat-replying")!.hidden).toBe(false);
    send("yes, merge it");
    await settle();
    expect(server.posted.find((body) => "text" in body)).toMatchObject({ replyTo: "k2", conversation: null });
  });

  it("a notification naming only a conversation lights its newest line in Chat, after another one's was lit", async () => {
    await onChat();
    chat.showLine("g1");
    await settle();
    expect(litId()).toBe("g3");
    chat.showLine("k1");
    await settle();
    expect(litId()).toBe("k2");
    expect(root.querySelectorAll(".chat-msg.lit")).toHaveLength(1);
    expect(shownIds()).toEqual(["w1", "w2", "k1", "kp", "ka", "g1", "g2", "k2", "g3"]);
    expect(root.querySelector(".thing-head")).toBeNull();
  });

  it("names no open conversation for the viewing report, after a line is brought up too", async () => {
    await onChat();
    chat.showLine("k1");
    await settle();
    expect(chat.openConversation()).toBeNull();
    chat.unmount();
    expect(chat.openConversation()).toBeNull();
  });

  it("the old Updates conversation, asked for by one of its messages (Search, a link), shows Chat at its newest with its composer", async () => {
    await onChat();
    chat.showLine(UPDATES_ID, "u1");
    await settle();
    expect(shownIds()).not.toContain("u1");
    expect(shownIds().at(-1)).toBe("g3");
    expect(root.querySelector(`.chat-msg[data-id="${UPDATES_ID}"]`)).toBeNull();
    expect(root.querySelector<HTMLElement>(".chat-compose-box")!.hidden).toBe(false);
    expect(root.querySelector(".thing-head")).toBeNull();
  });

  it("a card answer says so, with Open card while the card is on the board", async () => {
    server.messages.push(owner("a1", "g1", 45, { text: "Approved: merge?\nship it", card: "card-k", status: "sent" }));
    await onChat();
    const bubble = () => root.querySelector<HTMLElement>('.chat-msg[data-id="a1"]')!;
    expect(bubble().textContent).toContain("from a card");
    expect(bubble().querySelector(".chat-card-open")).toBeNull();
    board([{ id: "card-k", kind: "approval", title: "Merge?", ask: "Merge?", rev: "r1" }]);
    await settle();
    expect(bubble().querySelector(".chat-card-open")!.textContent).toBe("Open card");
  });

  it("Rivet's Card: line (say.mjs --card) opens its update card on Cards like any card; it says no 'from a card'", async () => {
    server.messages.push(rivet("h9", "g1", 45, { text: "Card: Billing deployed ›", card: "upd-1" }));
    await onChat();
    const bubble = () => root.querySelector<HTMLElement>('.chat-msg[data-id="h9"]')!;
    expect(bubble().textContent).not.toContain("from a card");
    board([{ id: "upd-1", kind: "update", title: "Billing deployed", thread: "Billing", rev: "r1", since: at(45) } as unknown as ServedNeed]);
    await settle();
    bubble().querySelector<HTMLButtonElement>(".chat-card-open")!.click();
    expect([app.tab, app.front]).toEqual(["cards", "upd-1"]);
  });

  it("Rivet's Card: line is in Chat too, and is itself one tap to its card", async () => {
    board([]);
    server.messages.push(rivet("h8", "g1", 45, { text: "Card: Purple Sector ›", card: "upd-8" }));
    await onChat();
    const line = () => root.querySelector<HTMLElement>('.chat-msg[data-id="h8"] .chat-body')!;
    expect(line().tagName).toBe("P");
    board([{ id: "upd-8", kind: "update", title: "Purple Sector", thread: "Purple", rev: "r1", since: at(45) } as unknown as ServedNeed]);
    await settle();
    expect(line().tagName).toBe("BUTTON");
    line().click();
    expect([app.tab, app.front]).toEqual(["cards", "upd-8"]);
  });

  it("a card Rivet posted shows as a card bubble, with Open card while it is on the board, and is never read aloud", async () => {
    server.messages.push(rivet("p2", "k1", 46, { text: "PR ready", posted: { id: "card-m", kind: "merge-ready", title: "PR ready" } }));
    await onChat();
    const bubble = root.querySelector<HTMLElement>('.chat-msg[data-id="kp"]')!;
    expect(bubble.classList.contains("posted")).toBe(true);
    expect(bubble.querySelector(".chat-posted-kind")!.textContent).toBe("Plan");
    expect(bubble.querySelector(".chat-posted-title")!.textContent).toBe("Plan: results row");
    expect(bubble.querySelector(".chat-posted-ask")!.textContent).toBe("Bigger row. Size M.");
    expect(bubble.querySelector(".chat-card-open")).toBeNull();
    expect(root.querySelector('.chat-msg[data-id="p2"] .chat-posted-kind')!.textContent).toBe("Merge ready");
    board([{ id: "card-m", kind: "approval", title: "PR ready", ask: "Merge?", rev: "r1" }]);
    await settle();
    const open = root.querySelector<HTMLButtonElement>('.chat-msg[data-id="p2"] .chat-posted .chat-card-open')!;
    expect(open.textContent).toBe("Open card");

    // Read aloud on: a posted card on the stream says nothing; Rivet's next words do.
    const speak = root.querySelector<HTMLButtonElement>(".chat-menu-item.chat-speak")!;
    speak.click();
    said.length = 0;
    fire("message", rivet("p3", "k1", 47, { text: "Card title", posted: { id: "card-x", kind: "update", title: "Card title" } }));
    fire("message", rivet("p4", "k1", 48, { text: "Spoken words" }));
    await settle();
    expect(said).toEqual(["Spoken words"]);
    speak.click();
    open.click();
    expect(app.tab).toBe("cards");
  });

  it("an ask's Done card reads Outcome in its bubble; another Got it card still reads Decision", async () => {
    server.messages.push(rivet("p5", "k1", 46, { text: "Done: Boss reel", posted: { id: "ask-a-1000-done", kind: "decision", title: "Done: Boss reel" } }));
    server.messages.push(rivet("p6", "g1", 46, { text: "Good morning", posted: { id: "morning-2026-11-24", kind: "decision", title: "Good morning" } }));
    await onChat();
    expect(root.querySelector('.chat-msg[data-id="p5"] .chat-posted-kind')!.textContent).toBe("Outcome");
    expect(root.querySelector('.chat-msg[data-id="p6"] .chat-posted-kind')!.textContent).toBe("Decision");
  });

  describe("a card answered in its chat (inChat, a-1012)", () => {
    const CARD = {
      id: "note-1",
      kind: "decision",
      title: "The **download** button",
      ask: "- Tapped Download, Rivet said https://a.example/x\n\n  second line",
      options: [{ label: "Send" }, { label: "Not now" }],
      rev: "r1",
    } as ServedNeed;
    const NOTED = "Not sent. Your agent will read your note first.";
    const IN_CHAT = { ...CARD, inChat: { label: "To the team", doing: { Send: "Sending to the team" }, noted: NOTED } };
    // What the line was posted with may be old: the bubble is drawn from the card.
    const line = () => rivet("p7", "k1", 46, { text: "x", posted: { id: "note-1", kind: "decision", title: "Posted title", ask: "Posted ask" } });
    const bubble = () => root.querySelector<HTMLElement>('.chat-msg[data-id="p7"] .chat-posted')!;
    const buttons = () => [...bubble().querySelectorAll("button")].map((button) => button.textContent);

    it("shows the card's own words, as written, with its options as buttons and no Open card", async () => {
      server.messages.push(line());
      await onChat();
      board([{ ...CARD, inChat: { label: "To the team" } }]);
      await settle();
      for (const [selector, words] of [[".chat-posted-kind", "To the team"], [".chat-posted-title", CARD.title], [".chat-posted-ask", CARD.ask]] as const) {
        const el = bubble().querySelector(selector)!;
        expect(el.textContent).toBe(words);
        expect(el.hasAttribute("data-typed")).toBe(true);
        expect(el.children).toHaveLength(0);
      }
      expect(buttons()).toEqual(["Send", "Not now"]);
    });

    it("in a window a code alone signed in, an answer only a passkey gives is the Feed's line, not a button", async () => {
      server.messages.push(line());
      await onChat();
      board([{ ...CARD, passkeyAnswers: ["Send"], inChat: { label: "To the team" } }]);
      await settle();
      expect(buttons()).toEqual(["Send", "Not now"]);
      setSignedInByCode(true);
      changed();
      await settle();
      expect(buttons()).toEqual(["Not now"]);
      expect(bubble().querySelector(".merge-passkey")!.textContent).toBe("Approve this from a phone or computer signed in with a passkey.");
      setSignedInByCode(false);
    });

    it("the keyboard stays on its answer through a redraw, and never lands on a changed card's", async () => {
      server.messages.push(line());
      await onChat();
      board([{ ...CARD, inChat: { label: "To the team" } }]);
      await settle();
      const primary = () => bubble().querySelector<HTMLButtonElement>("button.primary")!;
      expect(primary().hasAttribute("data-typed")).toBe(true);
      primary().focus();
      expect(document.activeElement).toBe(primary());
      board([{ ...CARD, ask: "Other words", rev: "r2", inChat: { label: "To the team" } }]);
      await settle();
      expect(bubble().querySelector(".chat-posted-ask")!.textContent).toBe("Other words");
      expect(document.activeElement).not.toBe(primary());
      // Nor to the page, where Enter would confirm a card waiting for it.
      expect(document.activeElement).not.toBe(document.body);
    });

    it("a tap is the Feed's own answer, at the revision shown, takes the buttons away and keeps every word", async () => {
      server.messages.push(rivet("p7", "k1", 46, { text: "x", posted: { id: "note-1", kind: "decision", title: CARD.title, ask: CARD.ask!, label: "To the team" } }));
      await onChat();
      board([{ ...CARD, inChat: { label: "To the team" } }]);
      await settle();
      bubble().querySelector<HTMLButtonElement>("button.primary")!.click();
      await settle();
      expect(app.held.has("note-1")).toBe(true);
      expect(bubble().querySelector(".chat-in-answers")).toBeNull();
      for (const [selector, words] of [[".chat-posted-kind", "To the team"], [".chat-posted-title", CARD.title], [".chat-posted-ask", CARD.ask]] as const) {
        expect(bubble().querySelector(selector)!.textContent).toBe(words);
        expect(bubble().querySelector(selector)!.hasAttribute("data-typed")).toBe(true);
      }
      undoLast();
      expect(app.held.has("note-1")).toBe(false);
      // The fake server's board is empty, and the gone card was read for: the board as it stands again.
      board([{ ...CARD, inChat: { label: "To the team" } }]);
      await settle();
      expect(buttons()).toEqual(["Send", "Not now"]);
    });

    it.each([
      ["a pick says what it is doing and posts that pick", "", "Sending to the team", { decision: "choice", choice: "Send", rev: "r1" }],
      ["a pick with a note typed is the note alone, and says so", "also on my iPad", NOTED, { decision: "comment", text: "also on my iPad", rev: "r1" }],
    ])("%s", async (_name, note, verb, posted) => {
      const toasts = document.createElement("div");
      mountToasts(toasts);
      server.messages.push(line());
      await onChat();
      board([IN_CHAT]);
      await settle();
      cardState("note-1").text = note;
      // The tap lock the test before left.
      await vi.waitFor(() => expect(answerTapsLocked()).toBe(false), { timeout: 3000 });
      bubble().querySelector<HTMLButtonElement>("button.primary")!.click();
      await settle();
      expect(toasts.querySelector(".toast.undo strong")!.textContent).toBe(verb);
      flushHeld();
      await settle();
      const bodies = vi.mocked(fetch).mock.calls.filter(([url, init]) => url === "/api/replies" && init?.method === "POST").map(([, init]) => JSON.parse(String(init!.body)));
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toEqual({ clientId: expect.any(String), itemId: "note-1", ...posted });
      app.cards.delete("note-1");
      app.held.delete("note-1");
    });

    it("without the flag the same card's bubble is as it was: the posted words and Open card", async () => {
      server.messages.push(line());
      await onChat();
      board([CARD]);
      await settle();
      expect(bubble().outerHTML).toBe(
        '<div class="chat-posted"><span class="chat-posted-kind">Decision</span><strong class="chat-posted-title">Posted title</strong><p class="chat-posted-ask">Posted ask</p><button class="btn chat-card-open chat-posted-open" type="button" data-use="chat.msg.open-card">Open card</button></div>',
      );
    });
  });
});
