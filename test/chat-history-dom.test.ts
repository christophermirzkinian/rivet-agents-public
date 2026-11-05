// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { detailBody, EMPTY_LIST } from "./conversations-fake.js";
import * as chat from "../web/src/views/chat.js";
import { openImages, closeLightbox } from "../web/src/views/lightbox.js";
import { openTallSheet, closeTallSheet } from "../web/src/views/sheet.js";

const openSheet = () => openTallSheet("A sheet", { mount: (el) => el.append("a sheet"), unmount: () => {} });

let root: HTMLElement;
let release: (() => void) | undefined;
let posted: { conversation?: string }[];
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0));
};
const box = () => root.querySelector<HTMLTextAreaElement>(".chat-text")!;
const send = (value: string) => {
  box().value = value;
  box().dispatchEvent(new Event("input"));
  root.querySelector<HTMLButtonElement>(".chat-send")!.click();
};
// happy-dom does not traverse session history. Dispatch the state a browser lands on.
const land = (state: unknown) => {
  history.replaceState(state, "");
  window.dispatchEvent(new PopStateEvent("popstate", { state }));
};
beforeEach(() => {
  posted = [];
  release = undefined;
  localStorage.clear();
  history.replaceState(null, "");
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    let body: unknown = EMPTY_LIST;
    if (String(input).startsWith("/api/chat")) body = { messages: [], older: null };
    if (init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      if (posted.length === 1) await new Promise<void>(resolve => { release = resolve; });
      body = { id: `message-${posted.length}`, conversation: "created-chat", at: "2030-01-01T00:00:00Z" };
    } else if (String(input).includes("/api/conversations/")) {
      const id = new URL(String(input), "http://test").pathname.slice("/api/conversations/".length);
      body = detailBody(id, []);
    }
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }));
  root = document.createElement("main");
  document.body.replaceChildren(root);
  chat.showConversation("direct-chat");
});
afterEach(async () => {
  closeLightbox();
  closeTallSheet();
  land(null);
  await settle();
  chat.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ["lightbox", "back"], ["lightbox", "close"], ["sheet", "back"], ["sheet", "close"],
])("keeps a direct-linked conversation when the %s closes with %s", async (overlay, method) => {
  chat.mount(root);
  await settle();
  expect(history.state).toBeNull();
  if (overlay === "lightbox") openImages(["/media/example.png"], 0);
  else openSheet();
  if (method === "close") {
    vi.spyOn(history, "back").mockImplementation(() => {});
    if (overlay === "lightbox") closeLightbox();
    else closeTallSheet();
    // The viewer is already gone; its back event arrives later.
    expect(document.querySelector(".lightbox")).toBeNull();
  }
  land(null);
  await settle();
  expect(document.querySelector(".lightbox")).toBeNull();
  expect(document.querySelector(".sheet.is-tall")).toBeNull();
  expect(box()).not.toBeNull();
  expect(box().closest("[hidden]")).toBeNull();
  expect(chat.openConversation()).toBe("direct-chat");
  send("still here");
  await settle();
  expect(posted[0]?.conversation).toBeNull();
  release!();
  await settle();
});

it.each(["lightbox", "sheet"])("a message from Chat finishing beneath the %s leaves its history alone", async overlay => {
  chat.mount(root);
  await settle();
  chat.startDraft("");
  expect(history.state).toBeNull();
  expect(chat.openConversation()).toBeNull();
  send("first");
  await settle();
  if (overlay === "lightbox") openImages(["/media/example.png"], 0);
  else openSheet();
  const above = history.state;
  release!();
  await settle();
  expect(history.state).toEqual(above);
  land(null);
  await settle();
  // Chat stays Chat: the next message starts its own conversation too.
  expect(chat.openConversation()).toBeNull();
  send("second");
  await settle();
  expect(posted.map((one) => one.conversation)).toEqual([null, null]);
});

it("preserves Chat when an earlier sheet listener handles Back before the later-mounted pane", async () => {
  openSheet();
  chat.mount(root);
  await settle();
  land(null);
  await settle();
  expect(box().closest("[hidden]")).toBeNull();
  expect(chat.openConversation()).toBe("direct-chat");
  send("still direct");
  await settle();
  expect(posted[0]?.conversation).toBeNull();
  release!();
  await settle();
});

it.each(["lightbox", "sheet"])("honours a history jump past the %s to another conversation", async overlay => {
  chat.mount(root);
  await settle();
  chat.showConversation("conversation-a");
  const destination = history.state;
  chat.showConversation("conversation-b");
  await settle();
  if (overlay === "lightbox") openImages(["/media/example.png"], 0);
  else openSheet();
  land(destination);
  await settle();
  expect(chat.openConversation()).toBe("conversation-a");
  send("to A");
  await settle();
  expect(posted[0]?.conversation).toBeNull();
  release!();
  await settle();
});

it("a draft started while Chat is unmounted opens Chat with it, and sends there", async () => {
  chat.startDraft("Discuss this: ");
  chat.mount(root);
  await settle();
  expect(chat.openConversation()).toBeNull();
  expect(box().value).toBe("Discuss this: ");
  send("shared topic");
  await settle();
  expect(posted[0]?.conversation).toBeNull();
  release!();
  await settle();
});
