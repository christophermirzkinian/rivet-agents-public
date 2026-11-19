// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { quoteText, type ChatMessage } from "../src/shared/command.js";
import { TEAM_ROOM_ID, UPDATES_ID } from "../src/shared/conversations.js";
import { app } from "../web/src/state.js";
import { detailBody, EMPTY_LIST, fakeServer, type FakeConversation, type FakeServer } from "./conversations-fake.js";

vi.mock("../web/src/voice.js", async (original) => ({
  ...(await original<typeof import("../web/src/voice.js")>()),
  say: () => {},
  canSpeak: () => true,
  unlockVoice: () => Promise.resolve(true),
  unlockOnTap: () => () => {},
  stopVoice: () => {},
}));

const chat = await import("../web/src/views/chat.js");
const { closeSheet } = await import("../web/src/views/sheet.js");
const { autoSpeak, setAutoSpeak } = await import("../web/src/voice.js");

const LONG = `Photo Album v3 is live and verified on every phone we have, ${"and the demo video is next ".repeat(6)}\nsecond line`;
let root: HTMLElement;
let posted: Record<string, unknown>[];
let history: ChatMessage[];

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    posted.push(body);
    if (postHeld) await postHeld;
    const original = history.find((message) => message.id === body.replyTo);
    return json({
      id: "c9",
      at: "2030-01-01T00:00:09.000Z",
      status: "collecting",
      ...(original ? { replyTo: original.id, quote: { from: original.from, text: quoteText(original) } } : {}),
    });
  }
  const path = new URL(String(input), "http://x").pathname;
  if (readHeld && path.startsWith("/api/conversations/")) await readHeld;
  return json(path.startsWith("/api/conversations/") ? detailBody("c1", history) : EMPTY_LIST);
}

let listeners: Record<string, ((event: { data: string }) => void)[]> = {};
/** While set, a POST, or a read of the conversation, waits for it. */
let postHeld: Promise<void> | null = null;
let readHeld: Promise<void> | null = null;

class FakeSource {
  static CLOSED = 2;
  readyState = 1;
  addEventListener(type: string, fn: (event: { data: string }) => void) {
    (listeners[type] ??= []).push(fn);
  }
  close() {}
}
const fire = (message: ChatMessage) => {
  for (const fn of listeners.message ?? []) fn({ data: JSON.stringify(message) });
};

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const bubble = (id: string) => root.querySelector<HTMLElement>(`.chat-msg[data-id="${id}"]`)!;
/** A line's own Reply. */
const replyOn = (id: string) => bubble(id).querySelector<HTMLButtonElement>('.chat-msg-tools [data-use="chat.msg.reply"]')!;
const moreOn = (id: string) => bubble(id).querySelector<HTMLButtonElement>('.chat-msg-tools [data-use="chat.msg.more"]');
const bar = () => root.querySelector<HTMLElement>(".chat-replying")!;
const box = () => root.querySelector<HTMLTextAreaElement>(".chat-text")!;

beforeEach(() => {
  posted = [];
  listeners = {};
  postHeld = null;
  readHeld = null;
  history = [
    { id: "c1", from: "owner", text: "What's live?", at: "2030-01-01T00:00:01.000Z", status: "replied" },
    { id: "h2", from: "rivet", text: LONG, at: "2030-01-01T00:00:02.000Z", replyTo: "c1", quote: { from: "owner", text: "What's live?" } },
  ];
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  vi.stubGlobal("EventSource", FakeSource);
  localStorage.clear();
  // These tests are about the messages of one conversation: the tab opens on it.
  chat.showConversation("c1");
  root = document.createElement("main");
  document.body.replaceChildren(root);
});

afterEach(() => {
  chat.unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a refresh redraws only what changed", () => {
  it("keeps every unchanged message's row, redraws a changed one and adds a new one in place", async () => {
    chat.mount(root);
    await settle();
    const c1 = bubble("c1");
    const h2 = bubble("h2");
    await chat.refresh();
    await settle();
    expect(bubble("c1")).toBe(c1);
    expect(bubble("h2")).toBe(h2);
    history = [history[0]!, { ...history[1]!, text: "Changed" }, { id: "h3", from: "rivet", text: "Newest", at: "2030-01-01T00:00:03.000Z" }];
    await chat.refresh();
    await settle();
    expect(bubble("c1")).toBe(c1);
    expect(bubble("h2")).not.toBe(h2);
    expect(bubble("h2").textContent).toContain("Changed");
    expect([...root.querySelectorAll<HTMLElement>(".chat-msg")].map((row) => row.dataset.id)).toEqual(["c1", "h2", "h3"]);
  });

  it("two cards of one board write keep the server's order, not their ids'", async () => {
    const at = "2030-01-01T00:00:03.000Z";
    history = [...history, { id: "z-parent", from: "rivet", text: "Parent card", at, seq: 3 }, { id: "a-answer", from: "rivet", text: "Its answer", at, seq: 4, replyTo: "z-parent" }];
    chat.mount(root);
    await settle();
    expect([...root.querySelectorAll<HTMLElement>(".chat-msg")].map((row) => row.dataset.id)).toEqual(["c1", "h2", "z-parent", "a-answer"]);
  });

  it("a send answered after the stream brought it and a later card keeps its place before that card", async () => {
    chat.mount(root);
    await settle();
    let answer!: () => void;
    postHeld = new Promise((resolve) => (answer = resolve));
    replyOn("h2").click();
    box().value = "Send it";
    root.querySelector<HTMLButtonElement>(".chat-send")!.click();
    await settle();
    // The conversation's reads wait, so what shows is what the stream and the send's answer made of it.
    let read!: () => void;
    readHeld = new Promise((resolve) => (read = resolve));
    const at = "2030-01-01T00:00:09.000Z";
    fire({ id: "c9", from: "owner", text: "Send it", at, seq: 10, threadId: "c1", status: "sent" });
    fire({ id: "a-card", from: "rivet", text: "A card", at, seq: 11, threadId: "c1" });
    await settle();
    answer();
    await settle();
    const ids = [...root.querySelectorAll<HTMLElement>(".chat-msg")].map((row) => row.dataset.id);
    expect(ids).toContain("a-card");
    expect(ids.indexOf("c9")).toBeLessThan(ids.indexOf("a-card"));
    read();
  });

  it("redraws a posted card's row when another view has taken its media", async () => {
    const stills = { kind: "stills" as const, stills: [{ sha256: "c".repeat(64), type: "image/png" as const }] };
    app.board = { version: 1, updatedAt: null, board: { updatedAt: "", needs: [{ id: "upd", kind: "update", title: "Home stills", rev: "r1", media: stills }], coming: [], chats: [], shipped: [] } } as unknown as typeof app.board;
    history = [...history, { id: "h3", from: "rivet", text: "", at: "2030-01-01T00:00:03.000Z", posted: { id: "upd", kind: "update", title: "Home stills" } }];
    chat.mount(root);
    await settle();
    const block = bubble("h3").querySelector(".chat-posted > :not(span, strong, p, button)");
    expect(block).not.toBeNull();
    const h3 = bubble("h3");
    await chat.refresh();
    await settle();
    expect(bubble("h3")).toBe(h3);
    // The Feed shows the same card: the one media element moves there.
    document.body.append(block!);
    await chat.refresh();
    await settle();
    expect(bubble("h3")).not.toBe(h3);
    expect(bubble("h3").contains(block)).toBe(true);
    app.board = null;
  });

  it("keeps a posted card's row on Chat, a posted bubble with Open card and without its media", async () => {
    const stills = { kind: "stills" as const, stills: [{ sha256: "c".repeat(64), type: "image/png" as const }] };
    app.board = { version: 1, updatedAt: null, board: { updatedAt: "", needs: [{ id: "upd", kind: "update", title: "Home stills", rev: "r1", media: stills }], coming: [], chats: [], shipped: [] } } as unknown as typeof app.board;
    history = [...history, { id: "h3", from: "rivet", text: "", at: "2030-01-01T00:00:03.000Z", posted: { id: "upd", kind: "update", title: "Home stills" } }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        new URL(String(input), "http://x").pathname === "/api/chat"
          ? new Response(JSON.stringify({ messages: history, older: null }), { status: 200, headers: { "content-type": "application/json" } })
          : fakeFetch(input, init),
      ),
    );
    chat.showRivetChat();
    chat.mount(root);
    await settle();
    const h3 = bubble("h3");
    expect(h3.classList.contains("chat-thing-row")).toBe(false);
    expect(h3.querySelector(".chat-posted .chat-posted-open")!.textContent).toBe("Open card");
    expect(h3.querySelector(".chat-posted > :not(span, strong, p, button)")).toBeNull();
    await chat.refresh();
    await settle();
    expect(bubble("h3")).toBe(h3);
    app.board = null;
  });
});

describe("Chat opens on its last page", () => {
  it("shows the page read last at once while the read for the newest goes out, then the newest", async () => {
    chat.unmount();
    let chatPage = [history[0]!];
    let answer: (() => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://x");
        if (url.pathname !== "/api/chat") return fakeFetch(input, init);
        const page = chatPage;
        if (answer === null) return new Response(JSON.stringify({ messages: page, older: null }), { status: 200, headers: { "content-type": "application/json" } });
        await new Promise<void>((resolve) => (answer = resolve));
        return new Response(JSON.stringify({ messages: page, older: null }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    chat.showRivetChat();
    chat.mount(root);
    await settle();
    expect(bubble("c1")).not.toBeNull();
    chat.unmount();
    root.replaceChildren();

    // The next open: Chat's read hangs, and the last page is on screen meanwhile.
    chatPage = [history[0]!, { id: "h5", from: "rivet", text: "Newer", at: "2030-01-01T00:00:05.000Z" }];
    answer = () => {};
    chat.mount(root);
    expect(bubble("c1")).not.toBeNull();
    expect(root.querySelector(".chat-empty")).toBeNull();
    await settle();
    (answer as () => void)();
    await settle();
    expect(bubble("h5")).not.toBeNull();
  });
});

describe("Chat's first page replaces the last visit's copy", () => {
  it("drops what the copy held from before the newest page, so no gap sits above it", async () => {
    chat.unmount();
    let chatPage: { messages: ChatMessage[]; older: string | null } = { messages: [history[0]!], older: "c0" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        new URL(String(input), "http://x").pathname === "/api/chat"
          ? new Response(JSON.stringify(chatPage), { status: 200, headers: { "content-type": "application/json" } })
          : fakeFetch(input, init),
      ),
    );
    chat.showRivetChat();
    chat.mount(root);
    await settle();
    expect(bubble("c1")).not.toBeNull();
    chat.unmount();
    root.replaceChildren();

    // Many messages later the newest page starts well after c1: c1 goes rather than sit above the gap.
    chatPage = { messages: [{ id: "h7", from: "rivet", text: "Much later", at: "2030-01-01T00:00:07.000Z" }], older: "h7" };
    chat.mount(root);
    expect(bubble("c1")).not.toBeNull();
    await settle();
    expect([...root.querySelectorAll<HTMLElement>(".chat-msg")].map((row) => row.dataset.id)).toEqual(["h7"]);
  });
});

describe("reply in chat", () => {
  it("Reply shows who and the first line above the box on a conversation's page, focuses it, and × takes it back", async () => {
    chat.mount(root);
    await settle();
    replyOn("h2").click();
    expect(bar().classList.contains("labelled")).toBe(false);
    expect(bar().hidden).toBe(false);
    expect(bar().querySelector(".chat-quote-who")!.textContent).toBe("Rivet");
    const line = bar().querySelector(".chat-quote-text")!.textContent!;
    expect(line.startsWith("Photo Album v3 is live")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
    expect(line).not.toContain("second line");
    expect(Array.from(line).length).toBeLessThanOrEqual(120);
    expect(document.activeElement).toBe(box());

    bar().querySelector<HTMLButtonElement>(".chat-replying-cancel")!.click();
    expect(bar().hidden).toBe(true);
    box().value = "plain";
    root.querySelector<HTMLButtonElement>(".chat-send")!.click();
    await settle();
    expect(posted).toHaveLength(1);
    expect(posted[0]).not.toHaveProperty("replyTo");
  });

  it("the sent message carries the id it answers and shows the quote in its bubble; the bar closes", async () => {
    chat.mount(root);
    await settle();
    replyOn("h2").click();
    box().value = "Send it";
    root.querySelector<HTMLButtonElement>(".chat-send")!.click();
    await settle();
    expect(posted[0]).toMatchObject({ text: "Send it", replyTo: "h2" });
    expect(bar().hidden).toBe(true);
    const quote = bubble("c9").querySelector<HTMLButtonElement>("button.chat-quote")!;
    expect(quote.querySelector(".chat-quote-who")!.textContent).toBe("Rivet");
    expect(quote.querySelector(".chat-quote-text")!.textContent).toBe(quoteText({ text: LONG }));
  });

  it("a tab switch keeps the reply with the draft, and a send clears both", async () => {
    chat.mount(root);
    await settle();
    replyOn("h2").click();
    box().value = "Send it";
    box().dispatchEvent(new Event("input"));
    chat.unmount();
    root.replaceChildren();

    chat.mount(root);
    await settle();
    expect(box().value).toBe("Send it");
    expect(bar().hidden).toBe(false);
    expect(bar().querySelector(".chat-quote-who")!.textContent).toBe("Rivet");
    root.querySelector<HTMLButtonElement>(".chat-send")!.click();
    await settle();
    expect(posted[0]).toMatchObject({ text: "Send it", replyTo: "h2" });

    chat.unmount();
    root.replaceChildren();
    chat.mount(root);
    await settle();
    expect(bar().hidden).toBe(true);
  });

  it("a failed send keeps the reply for the next try", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST" ? new Response(JSON.stringify({ error: "nope" }), { status: 500, headers: { "content-type": "application/json" } }) : fakeFetch(input, init),
      ),
    );
    chat.mount(root);
    await settle();
    replyOn("h2").click();
    box().value = "Send it";
    root.querySelector<HTMLButtonElement>(".chat-send")!.click();
    await settle();
    expect(bar().hidden).toBe(false);
  });

  it("tapping a quote scrolls to the original and lights it for a moment", async () => {
    history.push(
      { id: "c3", from: "owner", text: "And the pear?", at: "2030-01-01T00:00:03.000Z", status: "sent", replyTo: "h2", quote: { from: "rivet", text: "Photo Album…" } },
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    chat.mount(root);
    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();
    const scrolled = vi.spyOn(bubble("h2"), "scrollIntoView");
    bubble("c3").querySelector<HTMLButtonElement>("button.chat-quote")!.click();
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(bubble("h2").classList.contains("lit")).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(bubble("h2").classList.contains("lit")).toBe(false);
  });

  it("a quote whose original is not loaded does nothing", async () => {
    history.push({ id: "c3", from: "owner", text: "Old one", at: "2030-01-01T00:00:03.000Z", status: "sent", replyTo: "gone", quote: { from: "rivet", text: "Long ago" } });
    chat.mount(root);
    await settle();
    const before = root.querySelector(".chat-thread")!.innerHTML;
    bubble("c3").querySelector<HTMLButtonElement>("button.chat-quote")!.click();
    expect(root.querySelector(".chat-msg.lit")).toBeNull();
    expect(root.querySelector(".chat-thread")!.innerHTML).toBe(before);
  });

  it("Rivet's answer to the messages just above it shows no quote; one to an earlier message does", async () => {
    history.push(
      { id: "c3", from: "owner", text: "Results next?", at: "2030-01-01T00:00:03.000Z", status: "replied" },
      { id: "h4", from: "rivet", text: "About the first one: yes.", at: "2030-01-01T00:00:04.000Z", replyTo: "c1", quote: { from: "owner", text: "What's live?" } },
    );
    chat.mount(root);
    await settle();
    expect(bubble("h2").querySelector(".chat-quote")).toBeNull();
    expect(bubble("h4").querySelector(".chat-quote-text")!.textContent).toBe("What's live?");
  });
});

describe("a chat whose read fails (review F4)", () => {
  it("says it couldn't load, never Loading… or the raw error, and Try again reads it again", async () => {
    chat.unmount();
    let down = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        down && new URL(String(input), "http://x").pathname.startsWith("/api/conversations/")
          ? new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } })
          : fakeFetch(input, init),
      ),
    );
    chat.showConversation("c1");
    chat.mount(root);
    await settle();
    const failed = root.querySelector<HTMLElement>(".chat-empty.chat-failed")!;
    expect(failed.querySelector("p")!.textContent).toBe("Couldn't load this chat.");
    expect(root.textContent).not.toMatch(/Loading…|Request failed/);
    down = false;
    failed.querySelector<HTMLButtonElement>("button.chat-retry")!.click();
    await settle();
    expect(root.querySelector(".chat-failed")).toBeNull();
    expect(bubble("c1")).not.toBeNull();
  });

  it("Try again on a first read that failed hands its focus to the message box, never the page (review r6)", async () => {
    chat.unmount();
    let down = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        down && new URL(String(input), "http://x").pathname.startsWith("/api/conversations/")
          ? new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } })
          : fakeFetch(input, init),
      ),
    );
    chat.showConversation("c1");
    chat.mount(root);
    await settle();
    const again = root.querySelector<HTMLButtonElement>(".chat-failed button.chat-retry")!;
    again.focus();
    down = false;
    again.click();
    expect(document.activeElement).toBe(box());
    await settle();
    expect(document.activeElement).not.toBe(document.body);
    // A refresh that loads the chat, with no tap, takes the button away too: its keyboard moves on the same way (r7).
    chat.unmount();
    down = true;
    chat.showConversation("c1");
    chat.mount(root);
    await settle();
    root.querySelector<HTMLButtonElement>(".chat-failed button.chat-retry")!.focus();
    down = false;
    await chat.refresh();
    await settle();
    expect(root.querySelector(".chat-failed")).toBeNull();
    expect(document.activeElement).toBe(box());
    // With the message box hidden the chat itself takes it, and card keys pass it by.
    chat.unmount();
    down = true;
    chat.showConversation("c1");
    chat.mount(root);
    await settle();
    box().disabled = true;
    const retry = root.querySelector<HTMLButtonElement>(".chat-failed button.chat-retry")!;
    retry.focus();
    retry.click();
    const pane = root.querySelector<HTMLElement>("section.chat")!;
    expect(document.activeElement).toBe(pane);
    expect(pane.dataset.cardKeys).toBe("off");
    await settle();
  });

  it("a refresh failing after the chat loaded says so plainly under the box, never the server's words (review F3)", async () => {
    chat.unmount();
    let down = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        down && new URL(String(input), "http://x").pathname.startsWith("/api/conversations/")
          ? new Response(JSON.stringify({ error: "SQLITE_BUSY: database is locked" }), { status: 500, headers: { "content-type": "application/json" } })
          : fakeFetch(input, init),
      ),
    );
    chat.showConversation("c1");
    chat.mount(root);
    await settle();
    expect(bubble("c1")).not.toBeNull();
    down = true;
    await chat.refresh();
    await settle();
    const hint = root.querySelector<HTMLElement>(".chat-hint")!;
    expect(hint.textContent).toBe("Couldn't refresh this chat. Try again");
    expect(root.textContent).not.toMatch(/SQLITE|Request failed/);
    expect(bubble("c1")).not.toBeNull();
    down = false;
    hint.querySelector<HTMLButtonElement>("button.chat-hint-retry")!.click();
    await settle();
    expect(hint.textContent).toBe("");
  });

  it("a second failed refresh keeps Try again, and its focus, in place (review r2)", async () => {
    chat.unmount();
    let down = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        down && new URL(String(input), "http://x").pathname.startsWith("/api/conversations/")
          ? new Response(JSON.stringify({ error: "SQLITE_BUSY: database is locked" }), { status: 500, headers: { "content-type": "application/json" } })
          : fakeFetch(input, init),
      ),
    );
    chat.showConversation("c1");
    chat.mount(root);
    await settle();
    down = true;
    await chat.refresh();
    await settle();
    const retry = root.querySelector<HTMLButtonElement>(".chat-hint button.chat-hint-retry")!;
    retry.focus();
    await chat.refresh();
    await settle();
    expect(root.querySelector(".chat-hint button.chat-hint-retry")).toBe(retry);
    expect(document.activeElement).toBe(retry);
  });

  it("Try again leaving while focused, by a tap or a refresh that lands, hands focus to the message box (review r3)", async () => {
    chat.unmount();
    let down = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        down && new URL(String(input), "http://x").pathname.startsWith("/api/conversations/")
          ? new Response(JSON.stringify({ error: "SQLITE_BUSY: database is locked" }), { status: 500, headers: { "content-type": "application/json" } })
          : fakeFetch(input, init),
      ),
    );
    chat.showConversation("c1");
    chat.mount(root);
    await settle();
    const fail = async () => {
      down = true;
      await chat.refresh();
      await settle();
      const retry = root.querySelector<HTMLButtonElement>(".chat-hint button.chat-hint-retry")!;
      retry.focus();
      down = false;
      return retry;
    };
    (await fail()).click();
    expect(document.activeElement).toBe(box());
    await settle();
    (await fail()).focus();
    await chat.refresh();
    await settle();
    expect(root.querySelector(".chat-hint-retry")).toBeNull();
    expect(document.activeElement).toBe(box());
  });

  it("Try again leaving while focused with the message box hidden hands focus to the chat, which card keys pass by (review r4)", async () => {
    chat.unmount();
    let down = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        down && new URL(String(input), "http://x").pathname.startsWith("/api/conversations/")
          ? new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } })
          : fakeFetch(input, init),
      ),
    );
    chat.showConversation("c1");
    chat.mount(root);
    await settle();
    down = true;
    await chat.refresh();
    await settle();
    // As in Updates, Topics or search, where the message box is not shown and cannot take the focus.
    box().disabled = true;
    root.querySelector<HTMLButtonElement>(".chat-hint button.chat-hint-retry")!.focus();
    down = false;
    await chat.refresh();
    await settle();
    const pane = root.querySelector<HTMLElement>("section.chat")!;
    expect(document.activeElement).toBe(pane);
    const { cardKey } = await import("../web/src/views/feed.js");
    const step = vi.fn();
    const enter = new KeyboardEvent("keydown", { key: "j", bubbles: true });
    Object.defineProperty(enter, "target", { value: pane });
    cardKey(enter, null, root, step);
    expect(step).not.toHaveBeenCalled();
    const elsewhere = new KeyboardEvent("keydown", { key: "j", bubbles: true });
    Object.defineProperty(elsewhere, "target", { value: document.body });
    cardKey(elsewhere, null, root, step);
    expect(step).toHaveBeenCalledOnce();
    root.querySelector<HTMLButtonElement>("button")!.focus();
    expect(pane.hasAttribute("tabindex")).toBe(false);
    // A touch screen with a keyboard: the message box would raise its own keyboard, so the chat takes the focus.
    box().disabled = false;
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)", media: query, addEventListener() {}, removeEventListener() {} }));
    down = true;
    await chat.refresh();
    await settle();
    root.querySelector<HTMLButtonElement>(".chat-hint button.chat-hint-retry")!.focus();
    down = false;
    await chat.refresh();
    await settle();
    expect(document.activeElement).toBe(pane);
  });

  it("earlier messages failing at the top says so plainly, never the server's words, and asks again only after a scroll away (review r2)", async () => {
    chat.unmount();
    let failed = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://x");
        if (url.pathname !== "/api/chat") return fakeFetch(input, init);
        if (url.searchParams.has("before")) failed++;
        return url.searchParams.has("before")
          ? new Response(JSON.stringify({ error: "SQLITE_BUSY: database is locked" }), { status: 500, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({ messages: [history[0]!], older: "c0" }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    chat.showRivetChat();
    chat.mount(root);
    await settle();
    const box = root.querySelector<HTMLElement>(".chat-scroll")!;
    let top = 0;
    vi.spyOn(box, "clientHeight", "get").mockReturnValue(600);
    vi.spyOn(box, "scrollTop", "get").mockImplementation(() => top);
    box.dispatchEvent(new Event("scroll"));
    await settle();
    expect(failed).toBe(1);
    expect(root.querySelector(".chat-hint")!.textContent).toBe("Couldn't load earlier messages.");
    expect(root.textContent).not.toMatch(/SQLITE|Request failed/);
    // Still at the top, it is not asked again on every scroll event; away and back, it is.
    box.dispatchEvent(new Event("scroll"));
    await settle();
    expect(failed).toBe(1);
    top = 400;
    box.dispatchEvent(new Event("scroll"));
    top = 0;
    box.dispatchEvent(new Event("scroll"));
    await settle();
    expect(failed).toBe(2);
  });
});

describe("one chat: every line its own More and Reply, each run its label", () => {
  const minute = (n: number) => new Date(Date.UTC(2030, 0, 1, 0, n)).toISOString();
  const line = (id: string, from: "owner" | "rivet", thread: string, n: number, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    id,
    from,
    text,
    at: minute(n),
    threadId: thread,
    ...(from === "owner" ? { status: "replied" as const } : {}),
    ...extra,
  });
  const MESSAGES = (): ChatMessage[] => [
    line(UPDATES_ID, "rivet", UPDATES_ID, 0, "Updates from Rivet"),
    line("u1", "rivet", UPDATES_ID, 0, "Nightly: main green"),
    line("a1", "owner", "a1", 1, "How is the demo ad going?"),
    line("a2", "rivet", "a1", 2, "It is waiting on your approval.", { replyTo: "a1", quote: { from: "owner", text: "How is the demo ad going?" } }),
    line("a3", "owner", "a1", 3, "Send me the stills"),
    line("a4", "rivet", "a1", 4, "Three stills are on the card."),
    line("p1", "owner", "p1", 5, "Is CI green?"),
    line("p2", "rivet", "p1", 6, "Green on main."),
    line("q1", "rivet", "a1", 7, "The upload finished.", { replyTo: "a0", quote: { from: "rivet", text: "Last week's upload is ready." } }),
    line("b1", "owner", "b1", 8, "Ship the pear results row to everyone please today", { status: "sent" }),
  ];
  const CONVERSATIONS = (): Record<string, FakeConversation> => ({
    [UPDATES_ID]: { title: "Updates" },
    a1: { title: "Demo ad approval", ask: "a-12" },
    p1: { title: "CI on main" },
    b1: { title: "" },
  });
  let server: FakeServer;
  const options = () => root.querySelector<HTMLButtonElement>(".chat-head .chat-options")!;
  const run = (id: string) => bubble(id).closest<HTMLElement>(".chat-ex")!;

  async function onChat(): Promise<void> {
    chat.startDraft("");
    chat.showRivetChat();
    chat.mount(root);
    await settle();
  }

  beforeEach(() => {
    server = fakeServer(MESSAGES(), CONVERSATIONS());
    window.history.replaceState(null, "");
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    HTMLElement.prototype.scrollIntoView = vi.fn();
    app.chatFocus = null;
    app.chatUnread = 0;
  });

  afterEach(() => closeSheet());

  it("gives every line its own More and Reply, his own lines too", async () => {
    await onChat();
    for (const id of ["a2", "a4", "p2", "q1", "a1", "a3", "p1", "b1"]) {
      expect(moreOn(id), id).not.toBeNull();
      expect(replyOn(id), id).not.toBeNull();
    }
    expect(root.querySelector(".chat-ex-foot, .chat-reply, .chat-ex-more")).toBeNull();
    expect(bar().hidden).toBe(true);
  });

  it("leaves Reply off his line while it still collects: a reply would send its window early", async () => {
    server = fakeServer([...MESSAGES(), line("c2", "owner", "c2", 9, "and the copy", { status: "collecting", sendsAt: minute(30) })], {
      ...CONVERSATIONS(),
      c2: { title: "" },
    });
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    await onChat();
    expect(moreOn("c2")).not.toBeNull();
    expect(bubble("c2").querySelector('[data-use="chat.msg.reply"]')).toBeNull();
    expect(replyOn("b1")).not.toBeNull();
  });

  it("drops a reply whose line was cancelled, here or on another device, so no send is refused for it", async () => {
    server = fakeServer([...MESSAGES(), line("c3", "owner", "c3", 9, "one more thing", { status: "sent" })], { ...CONVERSATIONS(), c3: { title: "" } });
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    await onChat();
    replyOn("c3").click();
    expect(bar().hidden).toBe(false);
    fire({ id: "c3", from: "owner", text: "", at: minute(9), status: "cancelled" } as ChatMessage);
    await settle();
    expect(bar().hidden).toBe(true);
    expect(localStorage.getItem("rivet.chat.reply")).toBeNull();
  });

  it("Reply on Chat says Replying to the line's label, and the send carries that line with no conversation", async () => {
    await onChat();
    replyOn("p2").click();
    expect(bar().hidden).toBe(false);
    expect(bar().classList.contains("labelled")).toBe(true);
    expect(bar().querySelector(".chat-quote")!.textContent).toBe("Replying to CI on main");
    expect(bar().querySelector(".chat-quote strong")!.textContent).toBe("CI on main");
    expect(document.activeElement).toBe(box());
    box().value = "And on the branch?";
    box().dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".chat-send")!.click();
    await settle();
    expect(server.posted.at(-1)).toMatchObject({ text: "And on the branch?", replyTo: "p2", conversation: null });
    expect(bar().hidden).toBe(true);
  });

  it("shows a grey label before Rivet's first line in each run, its ask and title when it has an ask", async () => {
    await onChat();
    const label = bubble("a2").previousElementSibling as HTMLElement;
    expect(label.matches("li.chat-label")).toBe(true);
    expect(label.textContent).toBe("a-12 · Demo ad approval");
    expect(bubble("a1").nextElementSibling).toBe(label);
    expect(run("a2").querySelectorAll(".chat-label")).toHaveLength(1);
    expect(run("p2").querySelector(".chat-label")!.textContent).toBe("CI on main");
    // His waiting line alone has no Rivet line to label.
    expect(run("b1").querySelector(".chat-label")).toBeNull();
    replyOn("a4").click();
    expect(bar().querySelector(".chat-quote strong")!.textContent).toBe("a-12 · Demo ad approval");
  });

  it("keeps the quote on a reply to a line Chat has not loaded", async () => {
    await onChat();
    expect(bubble("q1").querySelectorAll(".chat-quote")).toHaveLength(1);
    expect(bubble("q1").querySelector(".chat-quote")!.textContent).toContain("Last week's upload is ready.");
    // No quote for a line answering the one just above it.
    expect(bubble("a2").querySelector(".chat-quote")).toBeNull();
  });

  it("shows Rivet working on a run whose last line is his and unanswered", async () => {
    await onChat();
    const wait = run("b1").querySelector<HTMLElement>(".chat-ex-wait")!;
    expect(wait.textContent).toContain("Rivet is working on it");
    expect(run("p1").querySelector(".chat-ex-wait")).toBeNull();
  });

  it("offers More but no Reply on read-only Updates", async () => {
    chat.showConversation(UPDATES_ID);
    chat.mount(root);
    await settle();
    expect(moreOn("u1")).not.toBeNull();
    expect(root.querySelector('[data-use="chat.msg.reply"]')).toBeNull();
  });

  it("in the agents' room, Reply on an agent's line answers that line and its agent; his own line has none", async () => {
    const room = [
      line("t1", "rivet", TEAM_ROOM_ID, 1, "board up", { team: { from: "photo-album", to: "monitor" } }),
      line("t2", "owner", TEAM_ROOM_ID, 2, "looks good"),
      line("t3", "rivet", TEAM_ROOM_ID, 3, "thanks, shipping it", { team: { from: "photo-album", to: "monitor" } }),
      line("t4", "rivet", TEAM_ROOM_ID, 4, "video ready", { team: { from: "checkout-page", to: "monitor" } }),
      // The hourly summary is Rivet's, with no agent on it.
      line("team-summary-5", "rivet", TEAM_ROOM_ID, 5, "Last hour: 3 messages, 2 chats"),
    ];
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(json(new URL(String(input), "http://x").pathname.startsWith("/api/conversations/") ? detailBody(TEAM_ROOM_ID, room) : EMPTY_LIST)),
      ),
    );
    // A kept reply in the room that names no agent (another tab, an older build) is not brought back.
    localStorage.setItem(
      "rivet.chat.reply",
      JSON.stringify({ id: "team-summary-5", quote: { from: "rivet", text: "Last hour: 3 messages, 2 chats" }, conversation: TEAM_ROOM_ID }),
    );
    chat.showConversation(TEAM_ROOM_ID);
    chat.mount(root);
    await settle();
    expect(bar().hidden).toBe(true);
    expect(bubble("t1").textContent).toContain("photo-album → monitor");
    // Only an agent's line names whom a reply in the room is for.
    expect(moreOn("t2")).not.toBeNull();
    expect(bubble("t2").querySelector('[data-use="chat.msg.reply"]')).toBeNull();
    expect(moreOn("team-summary-5")).not.toBeNull();
    expect(bubble("team-summary-5").querySelector('[data-use="chat.msg.reply"]')).toBeNull();
    replyOn("t1").click();
    await settle();
    expect(bar().textContent).toContain("board up");
    expect(JSON.parse(localStorage.getItem("rivet.chat.reply")!)).toMatchObject({ id: "t1", owner: "photo-album" });
    replyOn("t4").click();
    await settle();
    expect(bar().textContent).toContain("video ready");
    expect(JSON.parse(localStorage.getItem("rivet.chat.reply")!)).toMatchObject({ id: "t4", owner: "checkout-page" });
  });

  it("puts Read aloud alone in Chat's options, a switch that turns it on and off", async () => {
    setAutoSpeak(false);
    await onChat();
    expect(options().getAttribute("aria-label")).toBe("Chat options");
    expect(options().getAttribute("aria-haspopup")).toBe("menu");
    expect(root.querySelector(".chat-head > .chat-tools > .chat-speak")).toBeNull();
    const menu = root.querySelector<HTMLElement>(".chat-menu")!;
    expect(menu.hidden).toBe(true);
    options().click();
    expect(menu.hidden).toBe(false);
    expect([...menu.querySelectorAll(".chat-menu-item")].map((item) => item.textContent)).toEqual(["Read aloud"]);
    const toggle = root.querySelector<HTMLButtonElement>(".chat-menu .chat-speak")!;
    expect(toggle.getAttribute("role")).toBe("menuitemcheckbox");
    toggle.click();
    expect(autoSpeak()).toBe(true);
    options().click();
    toggle.click();
    expect(autoSpeak()).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(menu.hidden).toBe(true);
  });

  it("offers Small, Medium and Large text in Chat's options, Medium at first, saved and applied at once", async () => {
    localStorage.removeItem("rivet.chat.textSize");
    delete document.documentElement.dataset.chatText;
    await onChat();
    expect(document.documentElement.dataset.chatText).toBe("m");
    options().click();
    const sizes = [...root.querySelectorAll<HTMLButtonElement>(".chat-menu .chat-size")];
    expect(sizes.map((one) => one.textContent)).toEqual(["Small", "Medium", "Large"]);
    expect(sizes.map((one) => one.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    sizes[2]!.click();
    expect(document.documentElement.dataset.chatText).toBe("l");
    expect(localStorage.getItem("rivet.chat.textSize")).toBe("l");
    expect(sizes.map((one) => one.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    expect(root.querySelector<HTMLElement>(".chat-menu")!.hidden).toBe(false);
    chat.unmount();
    delete document.documentElement.dataset.chatText;
    await onChat();
    expect(document.documentElement.dataset.chatText).toBe("l");
    localStorage.removeItem("rivet.chat.textSize");
  });

  it("shows Chat's head only on Chat, a conversation page keeping its own Read aloud", async () => {
    chat.showConversation("a1");
    chat.mount(root);
    await settle();
    expect(root.querySelector(".chat-speak:not(.chat-menu-item)")).not.toBeNull();
    expect(root.querySelector<HTMLElement>(".chat-head")!.hidden).toBe(true);
    root.querySelector<HTMLButtonElement>(".thing-back")!.click();
    await settle();
    expect(root.querySelector<HTMLElement>(".chat-head")!.hidden).toBe(false);
    expect(options().hidden).toBe(false);
  });

  it("lets go of the keyboard when a conversation opens, or Chat unmounts, with the options open", async () => {
    await onChat();
    options().click();
    chat.showConversation("a1");
    await settle();
    expect(root.querySelector<HTMLElement>(".chat-menu")!.hidden).toBe(true);
    expect(options().getAttribute("aria-expanded")).toBe("false");
    const heard = vi.fn();
    document.body.addEventListener("keydown", heard);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(heard).toHaveBeenCalledTimes(1);
    root.querySelector<HTMLButtonElement>(".thing-back")!.click();
    await settle();
    options().click();
    chat.unmount();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.body.removeEventListener("keydown", heard);
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
