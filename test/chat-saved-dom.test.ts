// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../src/shared/command.js";
import { fakeServer, type FakeServer } from "./conversations-fake.js";

vi.mock("../web/src/voice.js", async (original) => ({
  ...((await original()) as object),
  say: () => {},
  unlockVoice: () => Promise.resolve(true),
  unlockOnTap: () => () => {},
  stopVoice: () => {},
}));
vi.mock("../web/src/views/toast.js", async (original) => ({
  ...((await original()) as object),
  flash: vi.fn(),
}));

const chat = await import("../web/src/views/chat.js");
const { app } = await import("../web/src/state.js");
const { flash } = await import("../web/src/views/toast.js");
const { SAVED_EMPTY } = await import("../web/src/views/chat-saved.js");

/** Conversation a: 400 lines, so its first are past Chat's first page. Conversation b: three. */
const message = (id: string, conversation: string, n: number): ChatMessage => ({
  id,
  from: n % 2 ? "rivet" : "owner",
  text: `Message ${id}`,
  at: new Date(Date.UTC(2026, 8, 1, 0, n)).toISOString(),
  threadId: conversation,
});
const HISTORY = [
  ...Array.from({ length: 400 }, (_, i) => message(i === 0 ? "a" : `a${String(i).padStart(3, "0")}`, "a", i)),
  message("b", "b", 500),
  message("b1", "b", 501),
  message("b2", "b", 502),
];

let root: HTMLElement;
let server: FakeServer;

let listeners: Record<string, ((event: { data: string }) => void)[]> = {};
class FakeSource {
  static CLOSED = 2;
  readyState = 1;
  addEventListener(type: string, fn: (event: { data: string }) => void) {
    (listeners[type] ??= []).push(fn);
  }
  close() {}
}
const fire = (type: string, data: unknown) => {
  for (const fn of listeners[type] ?? []) fn({ data: JSON.stringify(data) });
};
/** Answers the next request `match` picks as the server stands now, but only once the returned release is called. */
function hold(match: (method: string, path: string) => boolean): () => void {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://x").pathname;
      if (held || !match(init?.method ?? "GET", path)) return server.fetch(input, init);
      held = true;
      const answer = await server.fetch(input, init);
      await gate;
      return answer;
    }),
  );
  return () => release();
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const shown = (id: string) => root.querySelector<HTMLElement>(`.chat-msg[data-id="${id}"]`);
const head = () => root.querySelector<HTMLButtonElement>('[data-use="chat.saved.open"]')!;
const panel = () => root.querySelector<HTMLElement>(".chat-saved")!;
const items = () => [...panel().querySelectorAll<HTMLElement>(".chat-saved-item")];
const inItem = (id: string, use: string) => panel().querySelector<HTMLButtonElement>(`.chat-saved-item[data-id="${id}"] [data-use="${use}"]`)!;
const sheet = () => document.querySelector<HTMLElement>('.sheet[role="dialog"][aria-label="Remove from saved?"]');

async function onChat(): Promise<void> {
  chat.mount(root);
  await settle();
}

async function openList(): Promise<void> {
  head().click();
  await settle();
  expect(panel().hidden).toBe(false);
}

beforeEach(() => {
  server = fakeServer(HISTORY.map((one) => ({ ...one })), { a: { title: "Long one" }, b: { title: "Short one" } });
  app.chatFocus = null;
  listeners = {};
  vi.stubGlobal("fetch", vi.fn(server.fetch));
  vi.stubGlobal("EventSource", FakeSource);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  root = document.createElement("main");
  document.body.replaceChildren(root);
});

afterEach(() => {
  chat.unmount();
  document.querySelectorAll(".sheet-backdrop, .sheet").forEach((one) => one.remove());
  vi.unstubAllGlobals();
});

describe("saving a line", () => {
  it("Save in a line's strip saves it and marks it Saved under its words; a second tap takes it back", async () => {
    await onChat();
    const line = shown("b2")!;
    expect(line.querySelector(".chat-mark")).toBeNull();
    line.querySelector<HTMLElement>(".chat-body")!.click();
    const save = line.querySelector<HTMLButtonElement>('.chat-msg-tools [data-use="chat.msg.save"]')!;
    expect([save.textContent, save.getAttribute("aria-pressed")]).toEqual(["Save", "false"]);
    save.click();
    await settle();
    expect(server.saved).toEqual(["b2"]);
    const saved = shown("b2")!;
    expect(saved.querySelector(".chat-mark")!.textContent).toBe("Saved");
    const again = saved.querySelector<HTMLButtonElement>('[data-use="chat.msg.save"]')!;
    expect([again.textContent, again.getAttribute("aria-pressed")]).toEqual(["Saved", "true"]);
    again.click();
    await settle();
    expect(server.saved).toEqual([]);
    expect(shown("b2")!.querySelector(".chat-mark")).toBeNull();
  });

  it("marks the lines saved on another device as Chat opens", async () => {
    server.saved = ["b1"];
    await onChat();
    expect(shown("b1")!.querySelector(".chat-mark")).not.toBeNull();
    expect(shown("b2")!.querySelector(".chat-mark")).toBeNull();
  });
});

describe("the Saved list", () => {
  it("the head's bookmark opens it, newest saved first, with who, the words, Go, Reply and a cross; Close puts it away", async () => {
    server.saved = ["b1", "a"];
    await onChat();
    expect([head().getAttribute("aria-label"), head().getAttribute("aria-expanded"), panel().hidden]).toEqual(["Saved messages", "false", true]);
    await openList();
    expect(head().getAttribute("aria-expanded")).toBe("true");
    expect(items().map((one) => one.dataset.id)).toEqual(["b1", "a"]);
    const first = items()[0]!;
    expect(first.querySelector(".chat-saved-text")!.textContent).toBe("Message b1");
    expect(first.querySelector(".chat-saved-who")!.textContent).toMatch(/^Rivet · /);
    expect(items()[1]!.querySelector(".chat-saved-who")!.textContent).toMatch(/^You · /);
    expect([...first.querySelectorAll("button")].map((one) => one.textContent || one.getAttribute("aria-label"))).toEqual(["Go to message", "Reply", "Remove from saved"]);
    panel().querySelector<HTMLButtonElement>('[data-use="chat.saved.close"]')!.click();
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(head());
  });

  it("Escape puts it away and gives the head's bookmark the focus back", async () => {
    server.saved = ["b2"];
    await onChat();
    await openList();
    panel().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(head());
  });

  it("says how to save when nothing is", async () => {
    await onChat();
    await openList();
    expect(items()).toEqual([]);
    expect(panel().querySelector(".chat-saved-empty")!.textContent).toBe(SAVED_EMPTY);
  });

  it("Go to message closes it and brings the line up, lit, even one past Chat's first page", async () => {
    server.saved = ["a010"];
    await onChat();
    expect(shown("a010")).toBeNull();
    await openList();
    inItem("a010", "chat.saved.go").click();
    await settle();
    expect(panel().hidden).toBe(true);
    expect(shown("a010")!.scrollIntoView).toHaveBeenCalled();
    expect(shown("a010")!.classList.contains("lit")).toBe(true);
  });

  it("Reply closes it and puts the line's reply above the box", async () => {
    server.saved = ["b1"];
    await onChat();
    await openList();
    inItem("b1", "chat.saved.reply").click();
    await settle();
    expect(panel().hidden).toBe(true);
    const bar = root.querySelector<HTMLElement>(".chat-replying")!;
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toBe("Replying to Short one");
  });

  it("Reply quotes a line Chat has not loaded from what the list knows of it", async () => {
    server.saved = ["a010"];
    await onChat();
    await openList();
    inItem("a010", "chat.saved.reply").click();
    await settle();
    expect(root.querySelector(".chat-replying")!.textContent).toContain("Message a010");
  });

  it("the cross asks first, Cancel focused: Cancel keeps it, Remove takes it off the list and the line", async () => {
    server.saved = ["b2", "b1"];
    await onChat();
    await openList();
    inItem("b2", "chat.saved.remove").click();
    await settle();
    expect(sheet()!.textContent).toContain("Remove from saved?");
    expect(document.activeElement?.textContent).toBe("Cancel");
    document.querySelector<HTMLButtonElement>('[data-use="chat.saved.remove-cancel"]')!.click();
    await settle();
    expect(items().map((one) => one.dataset.id)).toEqual(["b2", "b1"]);
    expect(server.saved).toEqual(["b2", "b1"]);

    inItem("b2", "chat.saved.remove").click();
    await settle();
    document.querySelector<HTMLButtonElement>('[data-use="chat.saved.remove-confirm"]')!.click();
    await settle();
    expect(items().map((one) => one.dataset.id)).toEqual(["b1"]);
    expect(server.saved).toEqual(["b1"]);
    expect(shown("b2")!.querySelector(".chat-mark")).toBeNull();
  });

  it("Remove refused puts the line back in its place, marked, and the keyboard on a cross", async () => {
    server.saved = ["b2", "b1"];
    await onChat();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "DELETE" ? new Response(JSON.stringify({ error: "down" }), { status: 500, headers: { "content-type": "application/json" } }) : server.fetch(input, init),
      ),
    );
    await openList();
    inItem("b2", "chat.saved.remove").click();
    await settle();
    document.querySelector<HTMLButtonElement>('[data-use="chat.saved.remove-confirm"]')!.click();
    await settle();
    expect(items().map((one) => one.dataset.id)).toEqual(["b2", "b1"]);
    expect(shown("b2")!.querySelector(".chat-mark")).not.toBeNull();
    expect(document.activeElement?.getAttribute("data-use")).toBe("chat.saved.remove");
  });

  it("removing a line moves the keyboard to the next cross, and to Close once none is left", async () => {
    server.saved = ["b2", "b1"];
    await onChat();
    await openList();
    inItem("b2", "chat.saved.remove").click();
    await settle();
    document.querySelector<HTMLButtonElement>('[data-use="chat.saved.remove-confirm"]')!.click();
    await settle();
    expect(document.activeElement).toBe(inItem("b1", "chat.saved.remove"));
    inItem("b1", "chat.saved.remove").click();
    await settle();
    document.querySelector<HTMLButtonElement>('[data-use="chat.saved.remove-confirm"]')!.click();
    await settle();
    expect(document.activeElement?.getAttribute("data-use")).toBe("chat.saved.close");
  });

  it("an Escape anywhere on the page puts only the list away, never what Chat sits in", async () => {
    server.saved = ["b2"];
    await onChat();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    await openList();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.removeEventListener("keydown", outer);
    expect(panel().hidden).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(head());
  });

  it("offers no Reply on your own line while it still collects, as Chat does not", async () => {
    server.messages.find((one) => one.id === "b2")!.status = "collecting";
    server.saved = ["b2", "b1"];
    await onChat();
    await openList();
    expect(panel().querySelector('.chat-saved-item[data-id="b2"] [data-use="chat.saved.reply"]')).toBeNull();
    expect(inItem("b1", "chat.saved.reply")).not.toBeNull();
  });

  it("a photo with no words shows as Photo, and its reply quotes Photo", async () => {
    const photo = server.messages.find((one) => one.id === "a010")!;
    Object.assign(photo, { text: "", images: ["/media/one.jpg"] });
    server.saved = ["a010"];
    await onChat();
    await openList();
    expect(items()[0]!.querySelector(".chat-saved-text")!.textContent).toBe("Photo");
    inItem("a010", "chat.saved.reply").click();
    await settle();
    expect(root.querySelector(".chat-replying")!.textContent).toContain("Photo");
  });

  it("while it is open Chat's lines count as covered: a new line is not read until it closes", async () => {
    server.conversations.get("b")!.unread = 0;
    await onChat();
    await openList();
    server.posted.length = 0;
    const fresh = message("b3", "b", 503);
    server.messages.push(fresh);
    server.conversations.get("b")!.unread = 1;
    fire("message", fresh);
    await settle();
    expect(server.posted.filter((one) => one.action === "read")).toEqual([]);
    panel().querySelector<HTMLButtonElement>('[data-use="chat.saved.close"]')!.click();
    await settle();
    expect(server.posted).toContainEqual({ ids: ["b"], action: "read" });
  });

  it("opened from a search, Chat stays covered: a line that came in under the search is not read", async () => {
    server.conversations.get("b")!.unread = 0;
    await onChat();
    root.querySelector<HTMLButtonElement>('[data-use="chat.search.open"]')!.click();
    const input = root.querySelector<HTMLInputElement>(".chat-search-input")!;
    input.value = "note";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    server.posted.length = 0;
    const fresh = message("b3", "b", 503);
    server.messages.push(fresh);
    server.conversations.get("b")!.unread = 1;
    fire("message", fresh);
    await settle();
    await openList();
    expect(server.posted.filter((one) => one.action === "read")).toEqual([]);
  });

  it("any other way into a line puts it away too", async () => {
    await onChat();
    await openList();
    chat.showLine("b", "b2");
    await settle();
    expect(panel().hidden).toBe(true);
    expect(root.querySelector(".chat")!.classList.contains("searching")).toBe(false);
    expect(shown("b2")!.classList.contains("lit")).toBe(true);
  });

  it("a way into a line puts it away quietly: Chat redraws only once the line is up", async () => {
    server.conversations.get("b")!.unread = 0;
    await onChat();
    await openList();
    server.posted.length = 0;
    const fresh = message("b3", "b", 503);
    server.messages.push(fresh);
    server.conversations.get("b")!.unread = 1;
    fire("message", fresh);
    await settle();
    // Gone to the top of a long conversation, Chat isn't at its foot, so the new line stays unread.
    chat.showLine("a", "a");
    await settle();
    expect(panel().hidden).toBe(true);
    expect(server.posted.filter((one) => one.action === "read")).toEqual([]);
  });

  it("its own Go puts it away as quietly", async () => {
    server.saved = ["a"];
    server.conversations.get("b")!.unread = 0;
    await onChat();
    await openList();
    server.posted.length = 0;
    const fresh = message("b3", "b", 503);
    server.messages.push(fresh);
    server.conversations.get("b")!.unread = 1;
    fire("message", fresh);
    await settle();
    inItem("a", "chat.saved.go").click();
    await settle();
    expect(panel().hidden).toBe(true);
    expect(server.posted.filter((one) => one.action === "read")).toEqual([]);
  });
});

describe("staying in step", () => {
  it("Chat's stream reopening reads the marks again", async () => {
    await onChat();
    server.saved = ["b1"];
    fire("open", {});
    await settle();
    expect(shown("b1")!.querySelector(".chat-mark")).not.toBeNull();
  });

  it("an open list reads again as the stream reopens: a line saved meanwhile joins it", async () => {
    await onChat();
    await openList();
    expect(items()).toEqual([]);
    server.saved = ["b1"];
    fire("open", {});
    await settle();
    expect(items().map((item) => item.dataset.id)).toEqual(["b1"]);
  });

  it("an open list reads once as the stream reopens or a poll reads, and a failed read there shows no toast", async () => {
    await onChat();
    await openList();
    let reads = 0;
    let down = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET" && new URL(String(input), "http://x").pathname === "/api/chat/saved") {
          reads += 1;
          if (down) return new Response(JSON.stringify({ error: "down" }), { status: 503 });
        }
        return server.fetch(input, init);
      }),
    );
    fire("open", {});
    await settle();
    expect(reads).toBe(1);
    vi.mocked(flash).mockClear();
    down = true;
    fire("open", {});
    await settle();
    expect(reads).toBe(2);
    expect(vi.mocked(flash).mock.calls.filter(([, kind]) => kind === "error")).toEqual([]);
  });

  it("a read the list sent before it closed still sets Chat's marks", async () => {
    await onChat();
    await openList();
    const release = hold((method, path) => method === "GET" && path === "/api/chat/saved");
    server.saved = ["b1"];
    fire("open", {});
    await settle();
    panel().querySelector<HTMLButtonElement>('[data-use="chat.saved.close"]')!.click();
    release();
    await settle();
    expect(shown("b1")!.querySelector(".chat-mark")).not.toBeNull();
  });

  it("a read that left before a tap never takes back the tap's mark", async () => {
    await onChat();
    const release = hold((method, path) => method === "GET" && path === "/api/chat/saved");
    fire("open", {});
    await settle();
    shown("b1")!.querySelector<HTMLElement>(".chat-body")!.click();
    shown("b1")!.querySelector<HTMLButtonElement>('[data-use="chat.msg.save"]')!.click();
    await settle();
    release();
    await settle();
    expect(server.saved).toEqual(["b1"]);
    expect(shown("b1")!.querySelector(".chat-mark")).not.toBeNull();
  });

  it("a list the stream brings while a tap is on its way is read under the tap", async () => {
    await onChat();
    const release = hold((method) => method === "PUT");
    shown("b1")!.querySelector<HTMLElement>(".chat-body")!.click();
    shown("b1")!.querySelector<HTMLButtonElement>('[data-use="chat.msg.save"]')!.click();
    await settle();
    fire("saved", { ids: [] });
    await settle();
    expect(shown("b1")!.querySelector(".chat-mark")).not.toBeNull();
    release();
    await settle();
    fire("saved", { ids: ["b1"] });
    await settle();
    expect(shown("b1")!.querySelector(".chat-mark")).not.toBeNull();
  });
});
