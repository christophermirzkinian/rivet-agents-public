// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServedNeed } from "../src/shared/board.js";
import type { ChatMessage } from "../src/shared/command.js";
import { answerText, UPDATES_ID } from "../src/shared/conversations.js";
import { fakeServer, type FakeConversation, type FakeServer } from "./conversations-fake.js";

// The Chat tab: one conversation with Rivet, and a page per thing.

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
const { app, changed } = await import("../web/src/state.js");
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
const title = () => root.querySelector(".thing-title")?.textContent;
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

/** Mounts Chat on Chat: it reopens on the screen it was left on, and Back takes it to Chat. */
async function onChat(): Promise<void> {
  chat.startDraft("");
  chat.mount(root);
  await settle();
  root.querySelector<HTMLButtonElement>(".thing-back")?.click();
  await settle();
}

async function onThing(id: string): Promise<void> {
  chat.showConversation(id);
  chat.mount(root);
  await settle();
}

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
  vi.unstubAllGlobals();
});

describe("Chat", () => {
  it("is one conversation with Rivet: Chat's lines in time order, no list, and a thing as one line to its page", async () => {
    await onChat();
    expect(chat.openConversation()).toBeNull();
    // Updates' news is the Feed's; what followed the card is the thing's, but the owner's answer to it shows as one line.
    expect(shownIds()).toEqual(["w1", "w2", "k1", "kp", "ka", "g1", "g2", "g3"]);
    expect(root.querySelector(".conv-row, .conv-read-all, .conv-select, .conv-menu, .conv-new")).toBeNull();
    const link = root.querySelector<HTMLButtonElement>('.chat-thing-row[data-id="kp"] .chat-thing-link')!;
    expect(link.textContent).toContain("Plan: results row");
    expect(link.textContent).toContain("Open its page ›");
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

  it("a card answer is one line in Chat, You answered “card”: the answer, and one tap opens the card's conversation", async () => {
    server.messages.push(owner("ga", "g1", 41, { text: "Chose: Yes, put it on the site", card: "card-g", status: "sent" }));
    server.messages.push(owner("gb", "g1", 42, { text: "Chose: Not yet", card: "card-old", cardTitle: "Old pricing card", status: "sent" }));
    await onChat();
    const lines = () => root.querySelectorAll<HTMLElement>('.chat-msg[data-id="ka"], .chat-msg[data-id="ga"]');
    expect(lines()).toHaveLength(2);
    const ka = root.querySelector<HTMLElement>('.chat-answer-row[data-id="ka"]')!;
    expect(ka.querySelector(".chat-answer-text")!.textContent).toBe("You approved “Plan: results row” · Yes");
    expect(ka.textContent).not.toContain("from a card");
    // Chat names the card, never its conversation: the server's title for an old answer, "a card" when it has none.
    expect(root.querySelector('.chat-answer-row[data-id="gb"] .chat-answer-text')!.textContent).toBe("You answered “Old pricing card”: Not yet");
    expect(root.querySelector('.chat-answer-row[data-id="ga"] .chat-answer-text')!.textContent).toBe("You answered a card: Yes, put it on the site");
    board([{ id: "card-g", kind: "decision", title: "quote form live?", ask: "Live?", rev: "r1" }]);
    expect(root.querySelector('.chat-answer-row[data-id="ga"] .chat-answer-text')!.textContent).toBe("You answered “quote form live?”: Yes, put it on the site");
    root.querySelector<HTMLButtonElement>('.chat-answer-row[data-id="ka"] .chat-thing-link')!.click();
    await settle();
    expect(chat.openConversation()).toBe("k1");
    expect(shownIds()).toEqual(["k1", "kp", "ka", "k2"]);
    expect(root.querySelector('.chat-msg[data-id="ka"]')!.textContent).toContain("from a card");
    expect(root.querySelector(".chat-answer-row")).toBeNull();
  });

  it("a card answer leaves other Chat lines as they were, shows once, and Rivet's follow-up under it stays out of Chat", async () => {
    await onChat();
    const reply = rivet("kr", "k1", 14, { text: "Building it now", replyTo: "ka" });
    server.messages.push(reply);
    fire("message", reply);
    const answer = owner("kb", "k1", 15, { text: "Done", card: "plan-k", status: "sent" });
    server.messages.push(answer);
    fire("message", answer);
    await settle();
    expect(shownIds()).not.toContain("kr");
    expect(root.querySelectorAll('[data-id="kb"]')).toHaveLength(1);
    expect(root.querySelector('[data-id="kb"]')!.classList.contains("chat-answer-row")).toBe(true);
    const typed = root.querySelector<HTMLElement>('.chat-msg[data-id="g1"]')!;
    expect(typed.classList.contains("chat-answer-row")).toBe(false);
    expect(typed.querySelector(".chat-body")!.textContent).toBe("quote form");
    expect(root.querySelectorAll(".chat-answer-row")).toHaveLength(2);
    // A reload reads the same lines from the server.
    chat.unmount();
    await onChat();
    expect(shownIds()).toEqual(["w1", "w2", "k1", "kp", "ka", "kb", "g1", "g2", "g3"]);
  });

  it("a thing's line opens its page: title, where it stands, its facts, all its talk and Stop it; Back goes to Chat", async () => {
    await onChat();
    root.querySelector<HTMLButtonElement>('.chat-thing-row[data-id="kp"] .chat-thing-link')!.click();
    await settle();
    expect(chat.openConversation()).toBe("k1");
    expect(history.state).toMatchObject({ chatScreen: "k1" });
    expect(title()).toBe("Results row");
    // The plan card is answered: it is building.
    expect(root.querySelector(".thing-pill")!.textContent).toBe("Building");
    // The stage list is gone: the pill says where it stands, and the talk starts under the head.
    expect(root.querySelector(".thing-steps")).toBeNull();
    expect(root.querySelector(".thing-meta")!.textContent).toBe("PR #341 · chat results-row · size M");
    expect(shownIds()).toEqual(["k1", "kp", "ka", "k2"]);
    expect(root.querySelector<HTMLElement>(".chat-head")!.hidden).toBe(true);
    expect(box().placeholder).toBe("New chat");
    expect(root.querySelector(".thing-stop")).not.toBeNull();
    root.querySelector<HTMLButtonElement>(".thing-back")!.click();
    await settle();
    expect(chat.openConversation()).toBeNull();
    expect(root.querySelector('.chat-thing-row[data-id="kp"]')).not.toBeNull();
    expect(root.querySelector<HTMLElement>(".thing-foot")!.hidden).toBe(true);
  });

  it("a thing opened as the first screen (a notification's tap) has no Chat behind it: Back shows Chat in place, never leaves the app", async () => {
    const went = vi.spyOn(history, "back").mockImplementation(() => undefined);
    // Opened by its plan card's message id before Chat mounts, as a notification's tap at launch opens it (main.ts).
    chat.showConversation("kp");
    chat.mount(root);
    await settle();
    expect(chat.openConversation()).toBe("k1");
    expect(history.state).toMatchObject({ chatScreen: "k1" });
    root.querySelector<HTMLButtonElement>(".thing-back")!.click();
    await settle();
    expect(went).not.toHaveBeenCalled();
    expect(chat.openConversation()).toBeNull();
    expect(history.state?.chatScreen).toBeUndefined();
    went.mockRestore();
  });

  it("a message from Chat or from a thing's page starts a conversation of its own, unless Reply is set", async () => {
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
    chat.showConversation("k1");
    await settle();
    expect(box().placeholder).toBe("New chat");
    send("bigger still");
    await settle();
    expect(sent().at(-1)).toMatchObject({ text: "bigger still", conversation: null });
    expect(sent().at(-1)).not.toHaveProperty("replyTo");
    // The new conversation opens: the page is the line it started.
    expect(chat.openConversation()).toMatch(/^c9-/);
    chat.showConversation("k1");
    await settle();
    root.querySelector<HTMLButtonElement>('.chat-msg[data-id="k2"] .chat-reply')!.click();
    expect(box().placeholder).not.toBe("New chat");
    send("yes, merge it");
    await settle();
    expect(sent().at(-1)).toMatchObject({ text: "yes, merge it", replyTo: "k2", conversation: "k1" });
    expect(chat.openConversation()).toBe("k1");
  });

  it("the badge counts Chat once and each thing with an unread reply; Chat at its newest reads its own lines", async () => {
    server.conversations.get("k1")!.unread = 1;
    server.conversations.set("w1", { ...server.conversations.get("w1"), unread: 1 });
    await onChat();
    // g1 and w1 were Chat's: read now, in one request. k1 is a thing: read on its page.
    expect(server.posted).toContainEqual({ ids: ["g1", "w1"], action: "read" });
    expect(app.chatUnread).toBe(1);
    chat.showConversation("k1");
    await settle();
    expect(server.patched).toContainEqual({ id: "k1", body: { read: "k2" } });
    expect(app.chatUnread).toBe(0);
  });

  it("a stream message: one of Chat's shows in Chat; a thing's stays on its page and counts on the badge", async () => {
    await onChat();
    fire("message", rivet("g7", "g1", 51, { text: "Done" }));
    await settle();
    expect(shownIds()).toContain("g7");
    const k7 = rivet("k7", "k1", 52, { text: "Stills are up" });
    server.messages.push(k7);
    fire("message", k7);
    await settle();
    expect(shownIds()).not.toContain("k7");
    expect(app.chatUnread).toBe(1);
  });

  it("a line you type in a thing stays in Chat, with Rivet's reply and card to it; your own notes stay on the page", async () => {
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
    expect(shownIds()).toEqual(expect.arrayContaining(["k8", "k9", "kq"]));
    expect(shownIds()).not.toContain("k10");
    // A reload reads the same lines from the server.
    chat.unmount();
    await onChat();
    expect(shownIds()).toEqual(["w1", "w2", "k1", "kp", "ka", "g1", "g2", "g3", "k8", "k9", "kq"]);
  });

  it("searches every conversation's messages from inside More topics, and only there", async () => {
    await onChat();
    expect(root.querySelector<HTMLElement>(".chat-search")!.hidden).toBe(true);
    root.querySelector<HTMLButtonElement>(".chat-topics-open")!.click();
    await settle();
    expect(root.querySelector<HTMLElement>(".chat-search")!.hidden).toBe(false);
    chat.showConversation("k1");
    await settle();
    expect(root.querySelector<HTMLElement>(".chat-search")!.hidden).toBe(true);
  });

  it("More topics is one row on Chat; open, it lists every topic but Updates, a topic opens its page, and Back comes back to the list, then to Chat", async () => {
    await onChat();
    const section = root.querySelector<HTMLElement>(".chat")!;
    const topics = () => [...root.querySelectorAll<HTMLElement>(".chat-topic")].map((row) => row.dataset.id);
    expect(root.querySelector(".chat-topics-open")!.textContent).toContain("More topics");
    expect(topics()).toEqual([]);
    expect(section.classList.contains("topics")).toBe(false);
    root.querySelector<HTMLButtonElement>(".chat-topics-open")!.click();
    await settle();
    expect(history.state).toMatchObject({ chatScreen: "list" });
    expect(section.classList.contains("topics")).toBe(true);
    expect(topics().sort()).toEqual(["g1", "k1", "w1"]);
    expect(root.querySelector('.chat-topic[data-id="k1"]')!.textContent).toContain("Needs you");
    expect(root.querySelector('.chat-topic[data-id="g1"] .chat-topic-last')!.textContent).toBe("You: ship it");
    root.querySelector<HTMLButtonElement>('.chat-topic[data-id="k1"]')!.click();
    await settle();
    expect(chat.openConversation()).toBe("k1");
    expect(section.classList.contains("topics")).toBe(false);
    root.querySelector<HTMLButtonElement>(".thing-back")!.click();
    await settle();
    expect(chat.openConversation()).toBeNull();
    expect(section.classList.contains("topics")).toBe(true);
    root.querySelector<HTMLButtonElement>(".chat-topics-back")!.click();
    await settle();
    expect(section.classList.contains("topics")).toBe(false);
    expect(root.querySelector(".chat-topics-open")).not.toBeNull();
    expect(shownIds()).toEqual(["w1", "w2", "k1", "kp", "ka", "g1", "g2", "g3"]);
  });

  it("a saved More topics entry lands back on the topics; Archived loads the older ones on a tap, never Updates; a thing's new reply shows on the row", async () => {
    server.conversations.get("k1")!.unread = 1;
    server.conversations.set("o1", { title: "Old quiz leaderboard", old: true });
    server.messages.push(owner("o2", "o1", 3, { text: "Leaderboard?" }));
    await onChat();
    expect(root.querySelector(".chat-topics-open")!.textContent).toContain("1 new");
    history.pushState({ chatScreen: "list" }, "");
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    await settle();
    const topics = () => [...root.querySelectorAll<HTMLElement>(".chat-topic")].map((row) => row.dataset.id);
    expect(root.querySelector(".chat")!.classList.contains("topics")).toBe(true);
    expect(topics()).not.toContain("o1");
    const more = root.querySelector<HTMLButtonElement>(".chat-topics-more")!;
    expect(more.textContent).toBe("Archived");
    more.click();
    await settle();
    expect(topics()).toContain("o1");
    expect(topics()).not.toContain(UPDATES_ID);
    expect(root.querySelector(".chat-topics-more")).toBeNull();
  });
});

describe("a thing's page", () => {
  it("Stop it asks first, then asks Rivet in the thing's conversation", async () => {
    await onThing("k1");
    root.querySelector<HTMLButtonElement>(".thing-stop")!.click();
    expect(sheet()!.textContent).toContain("Ask Rivet to stop results-row?");
    const sent = () => server.posted.filter((body) => "text" in body);
    expect(sent()).toEqual([]);
    sheet()!.querySelector<HTMLButtonElement>(".thing-stop-go")!.click();
    await settle();
    expect(sent()).toEqual([expect.objectContaining({ text: "Stop results-row: Results row", conversation: "k1" })]);
    expect(root.querySelector('.chat-msg[data-id="c9-1"] .chat-body')!.textContent).toBe("Stop results-row: Results row");
  });

  it("its newest card with stills is its Share, and the step is Your look", async () => {
    server.messages.push(rivet("ks", "k1", 50, { text: "Card: Stills", posted: { id: "stills-k", kind: "decision", title: "Results row at 320" } }));
    // Before it has media its Share is Rivet's reply, never the card's.
    await onThing("k1");
    expect(root.querySelector(".thing-buttons .card-share")).toBeNull();
    chat.unmount();
    board([
      { id: "plan-k", kind: "plan", title: "Plan: results row", ask: "Bigger row.", rev: "r1" } as unknown as ServedNeed,
      {
        id: "stills-k",
        kind: "decision",
        title: "Results row at 320",
        ask: "Look?",
        rev: "r1",
        media: { kind: "stills", stills: [{ sha256: "a".repeat(64), type: "image/jpeg" }] },
        eta: "2:30pm",
      } as unknown as ServedNeed,
    ]);
    chat.mount(root);
    await settle();
    expect(root.querySelector(".thing-buttons .card-share.thing-btn")).not.toBeNull();
    expect(root.querySelector(".thing-pill")!.textContent).toBe("Your look");
    expect(root.querySelector(".thing-meta")!.textContent).toContain("ETA 2:30pm");
  });

  it("Read aloud is on its head, and turning it on there reads its latest Rivet message", async () => {
    await onThing("k1");
    const speak = root.querySelector<HTMLButtonElement>(".thing-head .chat-speak")!;
    expect(speak.closest("[hidden]")).toBeNull();
    expect(speak.textContent).toBe("Read aloud");
    speak.click();
    expect(said).toEqual(["PR #341 is up\nstills attached"]);
    expect(speak.textContent).toBe("Reading aloud");
    expect(root.querySelector(".chat-head .chat-speak")!.getAttribute("aria-pressed")).toBe("true");
    speak.click();
  });

  it("a Rivet message that lands under a sheet is marked read only once the sheet closes", async () => {
    await onThing("g1");
    openSheet("Search", { mount: () => {}, unmount: () => {} });
    // An id no earlier test sent: a message is counted once per page load.
    fire("message", rivet("g8", "g1", 51));
    await settle();
    const marks = () => server.patched.filter((one) => one.id === "g1" && one.body.read === "g8");
    expect(marks()).toEqual([]);
    closeSheet();
    // happy-dom delivers the sheet's removal to the coverage observer on a timer of its own.
    await vi.waitFor(() => expect(marks()).toEqual([{ id: "g1", body: { read: "g8" } }]));
  });

  it("a reply picked before a reload waits for its thing to open", async () => {
    await onChat();
    chat.unmount();
    const quote = { from: "rivet", text: "PR #341 is up" };
    localStorage.setItem("rivet.chat.reply", JSON.stringify({ id: "k2", quote, conversation: "k1" }));
    chat.mount(root);
    await settle();
    expect(localStorage.getItem("rivet.chat.reply")).not.toBeNull();
    chat.showConversation("k1");
    await settle();
    expect(root.querySelector<HTMLElement>(".chat-replying")!.hidden).toBe(false);
    send("yes, merge it");
    await settle();
    expect(server.posted.find((body) => "text" in body)).toMatchObject({ replyTo: "k2", conversation: "k1" });

    // Opened by another message of it (a search hit), it still comes back once the conversation is known.
    chat.unmount();
    localStorage.setItem("rivet.chat.reply", JSON.stringify({ id: "k2", quote, conversation: "k1" }));
    chat.showConversation("k2");
    chat.mount(root);
    await settle();
    expect(chat.openConversation()).toBe("k1");
    expect(root.querySelector<HTMLElement>(".chat-replying")!.hidden).toBe(false);
  });

  it("a notification for another thing, with one open, shows only the other one's messages", async () => {
    await onThing("g1");
    expect(shownIds()).toContain("g3");
    chat.showConversation("k1");
    await settle();
    expect(title()).toBe("Results row");
    expect(shownIds().filter((id) => id?.startsWith("g"))).toEqual([]);
    send("on Results");
    await settle();
    expect(server.posted.find((body) => "text" in body)).toMatchObject({ text: "on Results", conversation: null });
  });

  it("names the open thing for the viewing report, and nothing on Chat or once Chat is left", async () => {
    await onThing("k1");
    expect(chat.openConversation()).toBe("k1");
    root.querySelector<HTMLButtonElement>(".thing-back")!.click();
    await settle();
    expect(chat.openConversation()).toBeNull();
    chat.showConversation("k1");
    await settle();
    chat.unmount();
    expect(chat.openConversation()).toBeNull();
  });

  it("the old Updates conversation opened by one of its messages (Search, a link) is read-only: no composer, no seed bubble, no thing chrome", async () => {
    await onThing("u1");
    expect(chat.openConversation()).toBe(UPDATES_ID);
    expect(title()).toBe("Updates");
    expect(root.querySelector<HTMLElement>(".chat-compose-box")!.hidden).toBe(true);
    expect(root.querySelector(`.chat-msg[data-id="${UPDATES_ID}"]`)).toBeNull();
    expect(root.querySelector<HTMLElement>(".thing-foot")!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('.chat-msg[data-id="u1"] .chat-reply')!.hidden).toBe(true);
    chat.showConversation("g1");
    await settle();
    expect(root.querySelector<HTMLElement>(".chat-compose-box")!.hidden).toBe(false);
  });

  it("a quiet thing says so, and comes back when you writes in it", async () => {
    server.conversations.get("g1")!.closed = true;
    await onThing("g1");
    expect(root.querySelector(".thing-quiet")).not.toBeNull();
    root.querySelector<HTMLButtonElement>('.chat-msg[data-id="g3"] .chat-reply')!.click();
    send("one more thing");
    await settle();
    expect(server.posted.find((body) => "text" in body)).toMatchObject({ replyTo: "g3", conversation: "g1" });
    await chat.refresh();
    await settle();
    expect(root.querySelector(".thing-quiet")).toBeNull();
  });

  it("a card answer says so, with Open card while the card is on the board", async () => {
    server.messages.push(owner("a1", "g1", 45, { text: "Approved: merge?\nship it", card: "card-k", status: "sent" }));
    await onThing("g1");
    const bubble = () => root.querySelector<HTMLElement>('.chat-msg[data-id="a1"]')!;
    expect(bubble().textContent).toContain("from a card");
    expect(bubble().querySelector(".chat-card-open")).toBeNull();
    board([{ id: "card-k", kind: "approval", title: "Merge?", ask: "Merge?", rev: "r1" }]);
    await settle();
    expect(bubble().querySelector(".chat-card-open")!.textContent).toBe("Open card");
  });

  it("Rivet's Card: line (say.mjs --card) opens its update card, which is in no deck; it says no 'from a card'", async () => {
    server.messages.push(rivet("h9", "g1", 45, { text: "Card: Billing deployed ›", card: "upd-1" }));
    await onThing("g1");
    const bubble = () => root.querySelector<HTMLElement>('.chat-msg[data-id="h9"]')!;
    expect(bubble().textContent).not.toContain("from a card");
    board([{ id: "upd-1", kind: "update", title: "Billing deployed", thread: "Billing", rev: "r1", since: at(45) } as unknown as ServedNeed]);
    await settle();
    bubble().querySelector<HTMLButtonElement>(".chat-card-open")!.click();
    expect(app.tab).toBe("progress");
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
    expect(app.tab).toBe("progress");
  });

  it("a thing whose Needs you names a card on the board opens that card from its head", async () => {
    server.conversations.get("k1")!.statusCard = "card-k";
    await onThing("k1");
    expect(root.querySelector(".thing-card-open")).toBeNull();
    board([{ id: "card-k", kind: "approval", title: "Merge?", ask: "Merge?", rev: "r1" }]);
    await settle();
    const open = root.querySelector<HTMLButtonElement>(".thing-head .thing-card-open")!;
    expect(open.textContent).toBe("Open the card that needs you");
    open.click();
    expect(app.tab).toBe("cards");
  });

  it("a card Rivet posted shows as a card bubble, with Open card while it is on the board, and is never read aloud", async () => {
    server.messages.push(rivet("p2", "k1", 46, { text: "PR ready", posted: { id: "card-m", kind: "merge-ready", title: "PR ready" } }));
    await onThing("k1");
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
    root.querySelector<HTMLButtonElement>(".thing-head .chat-speak")!.click();
    said.length = 0;
    fire("message", rivet("p3", "k1", 47, { text: "Card title", posted: { id: "card-x", kind: "update", title: "Card title" } }));
    fire("message", rivet("p4", "k1", 48, { text: "Spoken words" }));
    await settle();
    expect(said).toEqual(["Spoken words"]);
    root.querySelector<HTMLButtonElement>(".thing-head .chat-speak")!.click();
    open.click();
    expect(app.tab).toBe("cards");
  });
});
