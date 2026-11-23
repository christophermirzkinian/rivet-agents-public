// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { quoteText, type ChatMessage } from "../src/shared/command.js";
import { UPDATES_ID } from "../src/shared/conversations.js";
import { maybeWhen } from "../src/shared/when.js";
import { probeCloud, resetCloud } from "../web/src/cloud-agent.js";
import { app, resetSession } from "../web/src/state.js";
import { EMPTY_LIST, fakeServer, type FakeConversation, type FakeServer } from "./conversations-fake.js";

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
  if (readHeld && path === "/api/chat") await readHeld;
  return json(path === "/api/chat" ? { messages: history, older: null, labels } : EMPTY_LIST);
}
let labels: Record<string, { title: string }>;

let listeners: Record<string, ((event: { data: string }) => void)[]> = {};
/** While set, a POST, or a read of Chat, waits for it. */
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
/** A line's strip: its time, More and Reply, hidden until the line is tapped. */
const strip = (id: string) => bubble(id).querySelector<HTMLElement>(":scope > .chat-msg-open")!;
/** Taps a line open, unless it is; its strip was hidden until then. */
function openLine(id: string): void {
  if (bubble(id).classList.contains("open")) return;
  expect(strip(id).hidden).toBe(true);
  bubble(id).click();
  expect(strip(id).hidden).toBe(false);
}
/** A line's own Reply, its line tapped open first. */
const replyOn = (id: string) => {
  openLine(id);
  return bubble(id).querySelector<HTMLButtonElement>('.chat-msg-open > .chat-msg-tools [data-use="chat.msg.reply"]')!;
};
const moreOn = (id: string) => {
  openLine(id);
  return bubble(id).querySelector<HTMLButtonElement>('.chat-msg-open > .chat-msg-tools [data-use="chat.msg.more"]');
};
const bar = () => root.querySelector<HTMLElement>(".chat-replying")!;
const box = () => root.querySelector<HTMLTextAreaElement>(".chat-text")!;

beforeEach(() => {
  posted = [];
  listeners = {};
  postHeld = null;
  readHeld = null;
  history = [
    { id: "c1", from: "owner", text: "What's live?", at: "2030-01-01T00:00:01.000Z", status: "replied", threadId: "c1" },
    { id: "h2", from: "rivet", text: LONG, at: "2030-01-01T00:00:02.000Z", threadId: "c1", replyTo: "c1", quote: { from: "owner", text: "What's live?" } },
  ];
  labels = {};
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  vi.stubGlobal("EventSource", FakeSource);
  localStorage.clear();
  chat.showRivetChat();
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
  it("pulling a line right past the threshold starts its reply, as its Reply does, and opens no strip", async () => {
    chat.mount(root);
    await settle();
    const touch = (type: string, x: number) => {
      const event = new MouseEvent(type, { clientX: x, clientY: 300, bubbles: true, cancelable: true });
      Object.defineProperty(event, "pointerId", { value: 7 });
      Object.defineProperty(event, "pointerType", { value: "touch" });
      bubble("h2").dispatchEvent(event);
    };
    touch("pointerdown", 100);
    touch("pointermove", 130);
    touch("pointermove", 200);
    touch("pointerup", 200);
    bubble("h2").click();
    expect(bar().hidden).toBe(false);
    expect(bar().querySelector(".chat-quote-who")!.textContent).toBe("Rivet");
    expect(document.activeElement).toBe(box());
    expect(strip("h2").hidden).toBe(true);
  });

  it("Reply on a line with no label shows who and the first line above the box, focuses it, and × takes it back", async () => {
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

  // Before any test gives c1 a label: Chat keeps the labels it has read for the session.
  it("a tab switch keeps a reply to a line with no label too", async () => {
    chat.mount(root);
    await settle();
    replyOn("h2").click();
    chat.unmount();
    root.replaceChildren();

    chat.mount(root);
    await settle();
    expect(bar().hidden).toBe(false);
    expect(bar().querySelector(".chat-quote-who")!.textContent).toBe("Rivet");
  });

  it("a tab switch keeps the reply with the draft, and a send clears both", async () => {
    labels = { c1: { title: "What's live" } };
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
    expect(bar().querySelector(".chat-quote")!.textContent).toBe("Replying to What's live");
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

  it("his own lines and quotes of them keep the old name as he typed it; a tap's line and Rivet's words read Rivet", async () => {
    const { showRivetWords } = await import("../web/src/rivet-words.js");
    history.push(
      { id: "c3", from: "owner", text: "Clean up Rivet's mind", at: "2030-01-01T00:00:03.000Z", status: "replied", typed: true },
      { id: "c5", from: "owner", text: "RIVET first?", at: "2030-01-01T00:00:03.500Z", status: "replied", typed: true },
      { id: "h4", from: "rivet", text: "Rivet: on it.", at: "2030-01-01T00:00:04.000Z", replyTo: "c5", quote: { from: "owner", text: "RIVET first?" } },
      { id: "c6", from: "owner", text: "Stop this: Rivet Ops cleanup", at: "2030-01-01T00:00:05.000Z", status: "replied" },
      { id: "h7", from: "rivet", text: "Stopped.", at: "2030-01-01T00:00:06.000Z", replyTo: "c6", quote: { from: "owner", text: "Stop this: Rivet Ops cleanup" } },
      // A line from before the typed mark, and a quote of his line that is not on the page.
      { id: "c8", from: "owner", text: "Rivet, what's next?", at: "2030-01-01T00:00:07.000Z", status: "replied" },
      { id: "h9", from: "rivet", text: "Next up.", at: "2030-01-01T00:00:08.000Z", replyTo: "long-gone", quote: { from: "owner", text: "Is Rivet Ops up?" } },
    );
    const stop = showRivetWords(root);
    try {
      chat.mount(root);
      await settle();
      expect(bubble("c3").querySelector(".chat-body")!.textContent).toBe("Clean up Rivet's mind");
      expect(bubble("h4").querySelector(".chat-quote-text")!.textContent).toBe("RIVET first?");
      expect(bubble("h4").querySelector(".chat-body")!.textContent).toBe("Rivet: on it.");
      expect(bubble("c6").querySelector(".chat-body")!.textContent).toBe("Stop this: Rivet Ops cleanup");
      expect(bubble("h7").querySelector(".chat-quote-text")!.textContent).toBe("Stop this: Rivet Ops cleanup");
      expect(bubble("c8").querySelector(".chat-body")!.textContent).toBe("Rivet, what's next?");
      expect(bubble("h9").querySelector(".chat-quote-text")!.textContent).toBe("Is Rivet Ops up?");
    } finally {
      stop();
    }
  });
});

describe("a chat whose read fails (review F4)", () => {
  it("says it couldn't load, never Loading… or the raw error, and Try again reads it again", async () => {
    chat.unmount();
    // Chat's last page is kept for the session: a first read has none to show.
    resetSession();
    let down = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        down && new URL(String(input), "http://x").pathname === "/api/chat"
          ? new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } })
          : fakeFetch(input, init),
      ),
    );
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
    resetSession();
    let down = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        down && new URL(String(input), "http://x").pathname === "/api/chat"
          ? new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } })
          : fakeFetch(input, init),
      ),
    );
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
    resetSession();
    down = true;
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
    resetSession();
    down = true;
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
        down && new URL(String(input), "http://x").pathname === "/api/chat"
          ? new Response(JSON.stringify({ error: "SQLITE_BUSY: database is locked" }), { status: 500, headers: { "content-type": "application/json" } })
          : fakeFetch(input, init),
      ),
    );
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
        down && new URL(String(input), "http://x").pathname === "/api/chat"
          ? new Response(JSON.stringify({ error: "SQLITE_BUSY: database is locked" }), { status: 500, headers: { "content-type": "application/json" } })
          : fakeFetch(input, init),
      ),
    );
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
        down && new URL(String(input), "http://x").pathname === "/api/chat"
          ? new Response(JSON.stringify({ error: "SQLITE_BUSY: database is locked" }), { status: 500, headers: { "content-type": "application/json" } })
          : fakeFetch(input, init),
      ),
    );
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
        down && new URL(String(input), "http://x").pathname === "/api/chat"
          ? new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } })
          : fakeFetch(input, init),
      ),
    );
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

describe("one chat: every line its own More and Reply, shown at a tap with its time and label", () => {
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
    line("a1", "owner", "a1", 1, "How is the launch ad going?"),
    line("a2", "rivet", "a1", 2, "It is waiting on your approval.", { replyTo: "a1", quote: { from: "owner", text: "How is the launch ad going?" } }),
    line("a3", "owner", "a1", 3, "Send me the stills"),
    line("a4", "rivet", "a1", 4, "Three stills are on the card."),
    line("p1", "owner", "p1", 5, "Is CI green?"),
    line("p2", "rivet", "p1", 6, "Green on main."),
    line("q1", "rivet", "a1", 7, "The upload finished.", { replyTo: "a0", quote: { from: "rivet", text: "Last week's upload is ready." } }),
    line("b1", "owner", "b1", 8, "Ship the pear results row to everyone please today", { status: "sent" }),
  ];
  const CONVERSATIONS = (): Record<string, FakeConversation> => ({
    [UPDATES_ID]: { title: "Updates" },
    a1: { title: "launch ad approval", ask: "a-12" },
    p1: { title: "CI on main" },
    b1: { title: "" },
  });
  let server: FakeServer;
  // The due clock and the magnifier share the options button's look.
  const options = () => root.querySelector<HTMLButtonElement>('.chat-head .chat-options[data-use="chat.options"]')!;
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

  it("names a Rivet line's conversation in its strip after the time, its ask and title when it has an ask; no grey label over a run", async () => {
    await onChat();
    expect(root.querySelector(".chat-label")).toBeNull();
    const meta = (id: string) => strip(id).querySelector(":scope > p.chat-meta")!.textContent;
    expect(meta("a2")).toBe(`${maybeWhen(minute(2))} · a-12 · launch ad approval`);
    expect(meta("a4")).toBe(`${maybeWhen(minute(4))} · a-12 · launch ad approval`);
    expect(meta("p2")).toBe(`${maybeWhen(minute(6))} · CI on main`);
    // His own line has no label: its time, then how it went.
    expect(meta("b1")).toBe(`${maybeWhen(minute(8))} · Sent`);
    expect(root.textContent).not.toContain("Rivet · ");
    replyOn("a4").click();
    expect(bar().querySelector(".chat-quote strong")!.textContent).toBe("a-12 · launch ad approval");
  });

  it("a tap on a line opens its strip, the time then More and Reply, and a second tap closes it", async () => {
    await onChat();
    const a2 = bubble("a2");
    expect(a2.getAttribute("tabindex")).toBe("0");
    // The line has no data-use of its own: a link in its words counts as the link, not as opening the line.
    expect(a2.dataset.use).toBeUndefined();
    expect(root.querySelector(".chat-msg.open")).toBeNull();
    expect([...root.querySelectorAll<HTMLElement>(".chat-msg > .chat-msg-open")].every((one) => one.hidden)).toBe(true);
    a2.querySelector<HTMLElement>(".chat-body")!.click();
    expect(a2.classList.contains("open")).toBe(true);
    expect(strip("a2").hidden).toBe(false);
    expect([...strip("a2").children].map((one) => one.className)).toEqual(["chat-meta", "chat-msg-tools"]);
    expect(strip("a2").querySelector(".chat-meta")!.textContent).toContain(maybeWhen(minute(2))!);
    expect([...strip("a2").querySelectorAll(".chat-msg-tools > .chat-msg-tool")].map((one) => one.textContent)).toEqual(["More", "Reply", "Save"]);
    a2.querySelector<HTMLElement>(".chat-body")!.click();
    expect(a2.classList.contains("open")).toBe(false);
    expect(strip("a2").hidden).toBe(true);
  });

  it("keeps one line open at a time, and a refresh keeps it open", async () => {
    await onChat();
    bubble("a2").click();
    bubble("p2").click();
    expect([...root.querySelectorAll<HTMLElement>(".chat-msg.open")].map((one) => one.dataset.id)).toEqual(["p2"]);
    expect(strip("a2").hidden).toBe(true);
    expect(strip("p2").hidden).toBe(false);
    await chat.refresh();
    await settle();
    expect([...root.querySelectorAll<HTMLElement>(".chat-msg.open")].map((one) => one.dataset.id)).toEqual(["p2"]);
    expect(strip("p2").hidden).toBe(false);
  });

  it("opens and closes a line with Enter or Space on it", async () => {
    await onChat();
    bubble("a4").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(strip("a4").hidden).toBe(false);
    bubble("a4").dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    expect(strip("a4").hidden).toBe(true);
    bubble("a4").dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
    expect(strip("a4").hidden).toBe(true);
  });

  it("Escape on an open line, or on its More, closes the strip only, and never reaches the page", async () => {
    await onChat();
    let reached = 0;
    const page = (event: KeyboardEvent) => void (event.key === "Escape" && reached++);
    document.addEventListener("keydown", page);
    bubble("a4").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    strip("a4").querySelector<HTMLElement>(".chat-msg-tool")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(strip("a4").hidden).toBe(true);
    expect(document.activeElement).toBe(bubble("a4"));
    expect(reached).toBe(0);
    // A closed line leaves Escape to the page.
    bubble("a4").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(reached).toBe(1);
    document.removeEventListener("keydown", page);
  });

  it("a tap on a button inside a line does not open or close it", async () => {
    await onChat();
    // The quote over q1's words is a button of its own.
    const quote = [...bubble("q1").querySelectorAll<HTMLButtonElement>("button")].find((one) => !one.closest(".chat-msg-open"))!;
    quote.click();
    expect(strip("q1").hidden).toBe(true);
    expect(bubble("q1").classList.contains("open")).toBe(false);
    bubble("q1").click();
    expect(strip("q1").hidden).toBe(false);
    quote.click();
    strip("q1").querySelector<HTMLButtonElement>('[data-use="chat.msg.more"]')!.click();
    expect(document.querySelector(".chat-more-sheet")).not.toBeNull();
    expect(strip("q1").hidden).toBe(false);
    expect(bubble("q1").classList.contains("open")).toBe(true);
  });

  it("stands Rivet's face by the last line of his run only, a run going on across two conversations", async () => {
    await onChat();
    const place = (id: string) => ({
      first: bubble(id).classList.contains("run-first"),
      last: bubble(id).classList.contains("run-last"),
      face: bubble(id).querySelector(".chat-rivet") !== null,
    });
    // One Rivet line between two of his.
    expect(place("a2")).toEqual({ first: true, last: true, face: true });
    // p2 then q1, of two conversations, with nothing of his between them.
    expect(place("p2")).toEqual({ first: true, last: false, face: false });
    expect(place("q1")).toEqual({ first: false, last: true, face: true });
    // His own lines never carry it.
    expect(place("b1")).toEqual({ first: true, last: true, face: false });
  });

  it("heads a chunk with its time: the first line, a new local day and an hour's gap, never close lines", async () => {
    // 00:00Z on 1 Jan 2030 is 11am in local: minute 780 is its midnight.
    const lines = [
      line("a1", "owner", "a1", 0, "How is the launch ad going?"),
      line("d1", "rivet", "a1", 5, "It is waiting on your approval."),
      line("d2", "rivet", "a1", 70, "Still waiting."),
      line("d3", "rivet", "a1", 775, "The stills are up."),
      line("d4", "rivet", "a1", 790, "And the video."),
      line("d5", "rivet", "a1", 795, "Both are on the card."),
    ];
    server = fakeServer(lines, { a1: { title: "launch ad approval", ask: "a-12" } });
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    await onChat();
    const headings = [...root.querySelectorAll<HTMLElement>(".chat-thread p.chat-day")];
    expect(headings.map((one) => one.textContent)).toEqual([0, 70, 775, 790].map((n) => maybeWhen(minute(n))));
    // A heading is the first thing in its group, over the line that starts the chunk.
    expect(headings.map((one) => [one.parentElement!.matches("li.chat-ex"), one.previousElementSibling, one.parentElement!.querySelector<HTMLElement>(".chat-msg")!.dataset.id])).toEqual([
      [true, null, "a1"],
      [true, null, "d2"],
      [true, null, "d3"],
      [true, null, "d4"],
    ]);
    expect(run("d1")).toBe(run("a1"));
    expect(run("d5")).toBe(run("d4"));
    // A heading ends a run: the face stands by the line before it.
    expect(["d1", "d2", "d3", "d4", "d5"].map((id) => bubble(id).querySelector(".chat-rivet") !== null)).toEqual([true, true, true, false, true]);
  });

  it("says a line did not go under its words, with no tap; a sent line's status waits in its strip", async () => {
    server = fakeServer(
      [
        ...MESSAGES(),
        line("f1", "owner", "f1", 9, "and the copy", { status: "failed" }),
        line("f2", "owner", "f2", 10, "never mind", { status: "cancelled" }),
        line("f3", "owner", "f3", 11, "one more", { status: "unconfirmed" }),
      ],
      { ...CONVERSATIONS(), f1: { title: "" }, f2: { title: "" }, f3: { title: "" } },
    );
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    await onChat();
    const state = (id: string) => bubble(id).querySelector<HTMLElement>(":scope > p.chat-state > span.chat-status");
    expect([state("f1")!.className, state("f1")!.textContent]).toEqual(["chat-status failed", "Not delivered"]);
    expect([state("f2")!.className, state("f2")!.textContent]).toEqual(["chat-status cancelled", "Cancelled"]);
    expect([state("f3")!.className, state("f3")!.textContent]).toEqual(["chat-status unconfirmed", "Typed, not confirmed"]);
    for (const id of ["f1", "f2", "f3"]) {
      expect(strip(id).hidden, id).toBe(true);
      expect(strip(id).querySelector(".chat-status"), id).toBeNull();
    }
    expect(state("b1")).toBeNull();
    expect(strip("b1").querySelector(".chat-status.sent")!.textContent).toBe(" · Sent");
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

  it("drops the working note once a reply to his line is in Chat, in whichever conversation it landed", async () => {
    await onChat();
    expect(run("b1").querySelector(".chat-ex-wait")).not.toBeNull();
    // His line itself is still "sent": only the reply, filed in another conversation, says it was answered.
    fire(line("z1", "rivet", "p1", 9, "The row went out.", { replyTo: "b1", quote: { from: "owner", text: "Ship the pear results row" } }));
    await settle();
    expect(bubble("z1")).not.toBeNull();
    expect(run("b1").querySelector(".chat-ex-wait")).toBeNull();
  });

  it("drops the working note for a whole window when the reply names its lead", async () => {
    server = fakeServer(
      [
        ...MESSAGES().filter((one) => one.id !== "b1"),
        line("w1", "owner", "w1", 8, "First half", { status: "typed" }),
        line("w2", "owner", "w1", 9, "second half", { status: "typed", windowLead: "w1" }),
        line("z2", "rivet", "p1", 10, "Both done.", { replyTo: "w1" }),
      ],
      { ...CONVERSATIONS(), w1: { title: "" } },
    );
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    await onChat();
    expect(root.querySelector(".chat-ex-wait")).toBeNull();
  });

  it("drops the working note after WORKING_MS with no reply, and not a moment before", async () => {
    const sent = Date.parse(minute(8));
    const now = vi.spyOn(Date, "now").mockReturnValue(sent + chat.WORKING_MS - 1_000);
    try {
      await onChat();
      expect(run("b1").querySelector(".chat-ex-wait")).not.toBeNull();
      expect(run("b1").querySelector(".chat-ex-late")).toBeNull();
      now.mockReturnValue(sent + chat.WORKING_MS + 1_000);
      fire(line("z3", "rivet", "p1", 40, "Unrelated.", { replyTo: "another-line" }));
      await settle();
      expect(run("b1").querySelector(".chat-ex-wait")).toBeNull();
      // It does not read as answered either: plain words say there is no answer yet, until one lands.
      expect(run("b1").querySelector(".chat-ex-late")!.textContent).toBe("No answer from Rivet yet");
      fire(line("z4", "rivet", "p1", 41, "The row went out.", { replyTo: "b1" }));
      await settle();
      expect(run("b1").querySelector(".chat-ex-late, .chat-ex-wait")).toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it("never says No answer once Rivet has said something that names no line: it may be the answer", async () => {
    const sent = Date.parse(minute(8));
    const now = vi.spyOn(Date, "now").mockReturnValue(sent + chat.WORKING_MS + 1_000);
    try {
      await onChat();
      expect(run("b1").querySelector(".chat-ex-late")).not.toBeNull();
      // An update card, a new conversation or a line placed by its words carries no replyTo and marks nothing replied.
      fire(line("z3", "rivet", "p1", 40, "Card: the row went out ›"));
      await settle();
      expect(run("b1").querySelector(".chat-ex-late, .chat-ex-wait")).toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it("ends the working note by its own timer, with no new line and no refresh", async () => {
    const sent = Date.parse(minute(8));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: sent + chat.WORKING_MS - 60_000 });
    try {
      chat.startDraft("");
      chat.showRivetChat();
      chat.mount(root);
      await vi.advanceTimersByTimeAsync(50);
      expect(run("b1").querySelector(".chat-ex-wait")).not.toBeNull();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(run("b1").querySelector(".chat-ex-wait")).toBeNull();
      expect(run("b1").querySelector(".chat-ex-late")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves an ack from under his words to the strip once the answer is in Chat, and keeps it beside a shown state", async () => {
    server = fakeServer(
      [
        ...MESSAGES(),
        line("p3", "owner", "p1", 9, "And on the branch?", { ack: { text: "checking it, ~9:45", at: minute(10) } }),
        line("f1", "owner", "f1", 11, "Did this go?", { status: "unconfirmed", ack: { text: "on it", at: minute(12) } }),
      ],
      { ...CONVERSATIONS(), f1: { title: "" } },
    );
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    await onChat();
    expect(bubble("p3").querySelector(":scope > p.chat-state > .chat-status.acked")).not.toBeNull();
    // A line that says another state under its words keeps its ack in the strip: it is shown somewhere.
    expect(bubble("f1").querySelector(":scope > p.chat-state > .chat-status.unconfirmed")).not.toBeNull();
    expect(strip("f1").querySelector(".chat-status.acked")!.textContent).toBe(" · Rivet: on it");
    fire(line("z5", "rivet", "b1", 13, "The branch is green.", { replyTo: "p3" }));
    await settle();
    expect(bubble("p3").querySelector(":scope > p.chat-state")).toBeNull();
    expect(strip("p3").querySelector(".chat-status.acked")!.textContent).toBe(" · Rivet: checking it · ~9:45");
  });

  it("shows Rivet's ack under his words without a tap, and not again in the strip", async () => {
    server = fakeServer([...MESSAGES(), line("p3", "owner", "p1", 9, "And on the branch?", { ack: { text: "checking it, ~9:45", at: minute(10) } })], CONVERSATIONS());
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    await onChat();
    expect(strip("p3").hidden).toBe(true);
    const ack = bubble("p3").querySelector<HTMLElement>(":scope > p.chat-state > .chat-status.acked")!;
    expect(ack.textContent).toBe("Rivet: checking it · ~9:45");
    expect(strip("p3").querySelector(".chat-status.acked")).toBeNull();
    // An acked line needs no working note as well, whatever its status still says.
    fire(line("b1", "owner", "b1", 8, "Ship the pear results row to everyone please today", { status: "sent", ack: { text: "on it", at: minute(9) } }));
    await settle();
    expect(bubble("b1").querySelector(".chat-status.acked")!.textContent).toBe("Rivet: on it");
    expect(run("b1").querySelector(".chat-ex-wait")).toBeNull();
  });

  describe("on a hosted machine", () => {
    const host = async (name: string | null | undefined) => {
      if (name !== undefined) vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ name, setupDone: true, firstPlan: "claude" }), { status: 200, headers: { "content-type": "application/json" } }))));
      await probeCloud();
      server =fakeServer([...MESSAGES(), line("p3", "owner", "p1", 9, "And on the branch?", { ack: { text: "checking it, ~9:45", at: minute(10) } })], CONVERSATIONS());
      vi.stubGlobal("fetch", vi.fn(server.fetch));
    };

    afterEach(() => resetCloud());

    const said = async () => {
      await onChat();
      const working = run("b1").querySelector(".chat-ex-wait")!.textContent!;
      // The ack sits under his words, no tap needed.
      expect(strip("p3").hidden).toBe(true);
      const ack = bubble("p3").querySelector(".chat-status.acked")!.textContent;
      return { working, ack, quote: bubble("q1").querySelector(".chat-quote-who")!.textContent };
    };

    it("names the agent in its working note, its acks and a quote of its line", async () => {
      await host("Pip");
      const { working, ack, quote } = await said();
      expect([working.includes("Pip is working on it"), ack, quote]).toEqual([true, "Pip: checking it · ~9:45", "Pip"]);
    });

    it("calls an agent with no name yet Agent", async () => {
      await host(null);
      const { working, ack, quote } = await said();
      expect([working.includes("Agent is working on it"), ack, quote]).toEqual([true, "Agent: checking it · ~9:45", "Agent"]);
    });

    it("is still Rivet on the owner's own machine", async () => {
      await host(undefined);
      const { working, ack, quote } = await said();
      expect([working.includes("Rivet is working on it"), ack, quote]).toEqual([true, "Rivet: checking it · ~9:45", "Rivet"]);
    });
  });

  it("opening read-only Updates shows Chat at its newest, with no Updates line and no page of its own", async () => {
    await onChat();
    chat.showConversation(UPDATES_ID);
    await settle();
    expect(bubble("b1")).not.toBeNull();
    expect(bubble("u1")).toBeNull();
    expect(root.querySelector(".thing-head")).toBeNull();
    expect(root.querySelector<HTMLElement>(".chat-head")!.hidden).toBe(false);
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
    // Send delay's switch is the menu's last row (chat-send-delay-dom.test.ts covers it).
    expect([...menu.querySelectorAll(".chat-menu-item")].map((item) => item.textContent)).toEqual(["Anything I asked not done?", "Read aloud", "Send delay"]);
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

  it("offers Short, Normal and Detailed replies in Chat's options, Normal at first, saved, and sent with every message", async () => {
    localStorage.removeItem("rivet.chat.replyStyle");
    await onChat();
    options().click();
    const styles = () => [...root.querySelectorAll<HTMLButtonElement>(".chat-menu .chat-style:not(.chat-delay-seconds)")];
    expect(root.querySelector(".chat-menu [aria-label='Reply style'] .chat-size-title")!.textContent).toBe("Reply style");
    expect(styles().map((one) => one.textContent)).toEqual(["Short", "Normal", "Detailed"]);
    expect(styles().map((one) => one.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    // Text size keeps its own three choices.
    expect(root.querySelectorAll(".chat-menu .chat-size")).toHaveLength(3);
    // Normal sends no field, so the line Rivet gets is as it was.
    box().value = "normal one";
    root.querySelector<HTMLButtonElement>(".chat-send")!.click();
    await settle();
    expect(server.posted.at(-1)).not.toHaveProperty("replyStyle");
    styles()[0]!.click();
    expect(localStorage.getItem("rivet.chat.replyStyle")).toBe("short");
    expect(styles().map((one) => one.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    box().value = "short one";
    root.querySelector<HTMLButtonElement>(".chat-send")!.click();
    await settle();
    expect(server.posted.at(-1)).toMatchObject({ text: "short one", replyStyle: "short" });
    // It survives a reload: Detailed is still picked when Chat mounts again.
    styles()[2]!.click();
    chat.unmount();
    await onChat();
    options().click();
    expect(styles().map((one) => one.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    box().value = "detailed one";
    root.querySelector<HTMLButtonElement>(".chat-send")!.click();
    await settle();
    expect(server.posted.at(-1)).toMatchObject({ text: "detailed one", replyStyle: "detailed" });
    localStorage.removeItem("rivet.chat.replyStyle");
  });

  it("a conversation opened before the mount shows Chat with its head and options, and no Read aloud outside the menu", async () => {
    chat.showConversation("a1");
    chat.mount(root);
    await settle();
    expect(bubble("a4")).not.toBeNull();
    expect(root.querySelector(".thing-head")).toBeNull();
    expect(root.querySelector(".chat-speak:not(.chat-menu-item)")).toBeNull();
    expect(root.querySelector<HTMLElement>(".chat-head")!.hidden).toBe(false);
    expect(options().hidden).toBe(false);
  });

  it("lets go of the keyboard when Chat unmounts with the options open", async () => {
    await onChat();
    options().click();
    const heard = vi.fn();
    document.body.addEventListener("keydown", heard);
    chat.unmount();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.body.removeEventListener("keydown", heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
