// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_CHAT_TEXT } from "../src/shared/command.js";
import { createDraftLineage } from "../web/src/draft-lineage.js";
import { detailBody, EMPTY_LIST } from "./conversations-fake.js";

vi.mock("../web/src/voice.js", async (original) => ({
  ...(await original<typeof import("../web/src/voice.js")>()),
  say: () => {},
  unlockVoice: () => Promise.resolve(true),
  unlockOnTap: () => () => {},
  stopVoice: () => {},
}));

const chat = await import("../web/src/views/chat.js");

const KEY = "rivet.chat.draft";
let root: HTMLElement;
let posted: unknown[];
let release: (() => void) | null;
let hold: boolean;

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (init?.method === "POST") {
    posted.push(JSON.parse(String(init.body)));
    if (hold) await new Promise<void>((resolve) => (release = resolve));
    return json({ id: `c${posted.length}`, at: "2030-01-01T00:00:05.000Z" });
  }
  return json(new URL(String(input), "http://x").pathname.startsWith("/api/conversations/") ? detailBody("c1", []) : EMPTY_LIST);
}

class FakeSource {
  static CLOSED = 2;
  readyState = 1;
  addEventListener() {}
  close() {}
}

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const box = () => root.querySelector<HTMLTextAreaElement>(".chat-text")!;
const type = (value: string) => {
  box().value = value;
  box().dispatchEvent(new Event("input"));
};
const send = () => root.querySelector<HTMLButtonElement>(".chat-send")!.click();

beforeEach(() => {
  posted = [];
  release = null;
  hold = false;
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  vi.stubGlobal("EventSource", FakeSource);
  localStorage.clear();
  // These tests are about the message view itself: the tab opens on All.
  chat.showConversation("c1");
  root = document.createElement("main");
  document.body.replaceChildren(root);
});

afterEach(() => {
  chat.unmount();
  vi.unstubAllGlobals();
});

describe("chat draft", () => {
  it("keeps a half-written message across leaving the tab and coming back", async () => {
    chat.mount(root);
    await settle();
    type("Check the demo vid");
    chat.unmount();
    root.replaceChildren();

    chat.mount(root);
    await settle();
    expect(box().value).toBe("Check the demo vid");
  });

  it("restores the draft after a reload, from this device's storage only", async () => {
    localStorage.setItem(KEY, "line one\nline two");
    chat.mount(root);
    await settle();
    expect(box().value).toBe("line one\nline two");
    expect(posted).toEqual([]);
  });

  it("clears the draft once the message is sent", async () => {
    chat.mount(root);
    await settle();
    type("Ship it");
    send();
    await settle();
    expect(posted).toHaveLength(1);
    expect(box().value).toBe("");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("keeps what was typed while a send was on its way", async () => {
    hold = true;
    chat.mount(root);
    await settle();
    type("first");
    send();
    await settle();
    type("first and more");
    release!();
    await settle();
    expect(box().value).toBe("first and more");
    expect(localStorage.getItem(KEY)).toBe("first and more");
  });

  it("a send that finishes after the chat was left and reopened keeps the newer draft", async () => {
    hold = true;
    chat.mount(root);
    await settle();
    type("first");
    send();
    await settle();
    chat.unmount();
    chat.mount(root);
    await settle();
    expect(box().value).toBe("first");
    type("second");
    release!();
    await settle();
    expect(box().value).toBe("second");
    expect(localStorage.getItem(KEY)).toBe("second");
  });

  it("a send that finishes after the chat was reopened clears the sent text from the new box", async () => {
    hold = true;
    chat.mount(root);
    await settle();
    type("first");
    send();
    await settle();
    chat.unmount();
    chat.mount(root);
    await settle();
    release!();
    await settle();
    expect(box().value).toBe("");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("a send that finishes while another tab is open clears only the draft it sent", async () => {
    hold = true;
    chat.mount(root);
    await settle();
    type("first");
    send();
    await settle();
    chat.unmount();
    release!();
    await settle();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("a late dictation result from a chat that was left does not overwrite the new draft", async () => {
    let recognizer: { onresult: ((event: unknown) => void) | null } | null = null;
    class FakeRecognition {
      lang = "";
      interimResults = false;
      continuous = false;
      onresult: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        recognizer = this;
      }
      start() {}
      abort() {}
    }
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    chat.mount(root);
    await settle();
    type("old");
    root.querySelector<HTMLButtonElement>(".chat-mic")!.click();
    chat.unmount();
    chat.mount(root);
    await settle();
    type("new draft");
    recognizer!.onresult?.({ results: [[{ transcript: "late words" }]] });
    expect(localStorage.getItem(KEY)).toBe("new draft");
  });

  it("a send never clears a newer draft another open copy of the app saved", async () => {
    hold = true;
    chat.mount(root);
    await settle();
    type("first");
    send();
    await settle();
    localStorage.setItem(KEY, "second, typed in another tab");
    release!();
    await settle();
    expect(box().value).toBe("");
    expect(localStorage.getItem(KEY)).toBe("second, typed in another tab");
  });

  it("a send never clears the same words another open copy of the app saved as a new draft", async () => {
    hold = true;
    chat.mount(root);
    await settle();
    type("ok");
    send();
    await settle();
    // Another tab saves the same text as its own new draft while this send is out.
    localStorage.setItem(KEY, "ok");
    localStorage.setItem(`${KEY}.rev`, "another-tab");
    release!();
    await settle();
    expect(box().value).toBe("");
    expect(localStorage.getItem(KEY)).toBe("ok");
  });

  it("a space added while the send is out still clears the stored draft along with the box", async () => {
    hold = true;
    chat.mount(root);
    await settle();
    type("ok");
    send();
    await settle();
    type("ok ");
    release!();
    await settle();
    expect(box().value).toBe("");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("a space added before leaving the chat, with the send still out, does not bring the sent text back", async () => {
    hold = true;
    chat.mount(root);
    await settle();
    type("ok");
    send();
    await settle();
    type("ok ");
    chat.unmount();
    release!();
    await settle();
    expect(localStorage.getItem(KEY)).toBeNull();
    chat.mount(root);
    await settle();
    expect(box().value).toBe("");
  });

  it("a reopened chat showing another tab's same words keeps them when the earlier send lands", async () => {
    hold = true;
    chat.mount(root);
    await settle();
    type("ok");
    send();
    await settle();
    chat.unmount();
    localStorage.setItem(KEY, "ok");
    localStorage.setItem(`${KEY}.rev`, "another-tab");
    chat.mount(root);
    await settle();
    release!();
    await settle();
    expect(box().value).toBe("ok");
    expect(localStorage.getItem(KEY)).toBe("ok");
  });

  it("a reopened chat keeps another tab's same words after a local whitespace edit", async () => {
    hold = true;
    chat.mount(root);
    await settle();
    type("ok");
    send();
    await settle();
    chat.unmount();
    localStorage.setItem(KEY, "ok");
    localStorage.setItem(`${KEY}.rev`, "another-tab");
    chat.mount(root);
    await settle();
    type("ok ");
    const adoptedRev = localStorage.getItem(`${KEY}.rev`);
    expect(adoptedRev).not.toBe("another-tab");
    release!();
    await settle();
    expect(box().value).toBe("ok ");
    expect(localStorage.getItem(KEY)).toBe("ok ");
    expect(localStorage.getItem(`${KEY}.rev`)).toBe(adoptedRev);
  });

  it("a reopened chat's whitespace edits still descend from its pending send", async () => {
    hold = true;
    chat.mount(root);
    await settle();
    type("ok");
    send();
    await settle();
    type("ok ");
    chat.unmount();
    chat.mount(root);
    await settle();
    type("ok  ");
    release!();
    await settle();
    expect(box().value).toBe("");
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem(`${KEY}.rev`)).toBeNull();
  });

  it("a send with no reply picked leaves the reply another tab picked", async () => {
    hold = true;
    chat.mount(root);
    await settle();
    type("ok");
    send();
    await settle();
    const reply = JSON.stringify({ id: "h2", quote: { from: "rivet", text: "Which one?" } });
    localStorage.setItem("rivet.chat.reply", reply);
    release!();
    await settle();
    expect(localStorage.getItem("rivet.chat.reply")).toBe(reply);
  });

  it("keeps the draft when the send fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST" ? new Response("{}", { status: 500 }) : fakeFetch(input, init),
    ));
    chat.mount(root);
    await settle();
    type("Try again later");
    send();
    await settle();
    expect(box().value).toBe("Try again later");
    expect(localStorage.getItem(KEY)).toBe("Try again later");
  });

  it("a retry after a failed send clears its own whitespace edits", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST" ? new Response("{}", { status: 500 }) : fakeFetch(input, init),
    ));
    chat.mount(root);
    await settle();
    type("Try again later");
    send();
    await settle();
    expect(localStorage.getItem(KEY)).toBe("Try again later");

    vi.stubGlobal("fetch", vi.fn(fakeFetch));
    hold = true;
    send();
    await settle();
    type("Try again later ");
    release!();
    await settle();
    expect(box().value).toBe("");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("forgets a draft that is only spaces", async () => {
    chat.mount(root);
    await settle();
    type("hi");
    type("   \n ");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("caps a stored draft at the message limit", async () => {
    localStorage.setItem(KEY, "x".repeat(MAX_CHAT_TEXT + 50));
    chat.mount(root);
    await settle();
    expect(box().value).toHaveLength(MAX_CHAT_TEXT);
  });

  it("starts the draft on an ask's reply prefix, ahead of what was typed", async () => {
    localStorage.setItem(KEY, "half typed");
    chat.startDraft("Re ask a-1: ");
    chat.startDraft("Re ask a-1: ");
    chat.mount(root);
    await settle();
    expect(box().value).toBe("Re ask a-1: half typed");
    chat.startDraft("Re ask a-1: ");
    expect(box().value).toBe("Re ask a-1: half typed");
  });

  it("opens on a draft startDraft began with the keyboard up and the caret after it, once", async () => {
    chat.startDraft("About “Item” (Coming, PR #23): ");
    chat.mount(root);
    await settle();
    expect(document.activeElement).toBe(box());
    expect(box().selectionStart).toBe(box().value.length);
    chat.unmount();
    root.replaceChildren();
    chat.mount(root);
    await settle();
    expect(document.activeElement).not.toBe(box());
  });

  it("leaves a draft the reply prefix would not fit beside as it is, never cutting it", async () => {
    const long = `${"x".repeat(MAX_CHAT_TEXT - 6)}tail.`;
    localStorage.setItem(KEY, long);
    chat.startDraft("Re ask a-1: ");
    expect(localStorage.getItem(KEY)).toBe(long);
    chat.mount(root);
    await settle();
    expect(box().value).toBe(long);
    chat.startDraft("Re ask a-1: ");
    expect(box().value).toBe(long);
  });

  it("keeps the reply prefix for the chat to open on when storage refuses it", async () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    chat.startDraft("Re ask a-1: ");
    expect(localStorage.getItem(KEY)).toBeNull();
    chat.mount(root);
    await settle();
    expect(box().value).toBe("Re ask a-1: ");
    vi.restoreAllMocks();
  });

  it("still works when storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    chat.mount(root);
    await settle();
    expect(box().value).toBe("");
    type("still typing");
    expect(box().value).toBe("still typing");
    vi.restoreAllMocks();
  });
});

describe("pending draft lineage", () => {
  it("tracks each send separately and stops extending settled sends", () => {
    const lineage = createDraftLineage();
    const first = lineage.begin("first");
    lineage.saved("first", "first-edit");
    const second = lineage.begin("second");
    lineage.saved("second", "second-edit");
    expect(first.owns("first-edit")).toBe(true);
    expect(first.owns("second-edit")).toBe(false);
    expect(second.owns("first-edit")).toBe(false);
    first.finish();
    lineage.saved("first-edit", "after-settlement");
    expect(first.owns("after-settlement")).toBe(false);
    lineage.saved("second-edit", "second-edit-again");
    expect(second.owns("second-edit-again")).toBe(true);
    second.finish();
  });
});

describe("chat mic", () => {
  class FakeRecognition {
    static made: FakeRecognition[] = [];
    lang = "";
    continuous = false;
    interimResults = false;
    onresult: ((event: { results: { transcript: string }[][] }) => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    listening = false;
    constructor() {
      FakeRecognition.made.push(this);
    }
    start() {
      this.listening = true;
    }
    abort() {
      this.listening = false;
    }
    hear(...parts: string[]) {
      this.onresult?.({ results: parts.map((transcript) => [{ transcript }]) });
    }
  }
  const mic = () => root.querySelector<HTMLButtonElement>(".chat-mic")!;
  const last = () => FakeRecognition.made.at(-1)!;

  beforeEach(() => {
    FakeRecognition.made = [];
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
  });

  it("stays on through a pause, saves the words as the draft, and stops on send", async () => {
    chat.mount(root);
    await settle();
    mic().click();
    expect(mic().classList.contains("on")).toBe(true);
    expect(mic().getAttribute("aria-pressed")).toBe("true");
    last().hear("Ship the");
    last().listening = false;
    last().onend?.();
    expect(mic().classList.contains("on")).toBe(true);
    last().hear("demo video");
    expect(box().value).toBe("Ship the demo video");
    expect(localStorage.getItem(KEY)).toBe("Ship the demo video");

    const listening = last();
    send();
    expect(listening.listening).toBe(false);
    expect(mic().classList.contains("on")).toBe(false);
    await settle();
    expect(posted).toEqual([expect.objectContaining({ text: "Ship the demo video" })]);
    expect(FakeRecognition.made).toHaveLength(2);
  });

  it("a second tap stops it and keeps the words", async () => {
    chat.mount(root);
    await settle();
    const press = new Event("mousedown", { cancelable: true });
    mic().dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    const touch = new Event("pointerdown", { cancelable: true });
    mic().dispatchEvent(touch);
    expect(touch.defaultPrevented).toBe(false);
    mic().click();
    last().hear("Hold on");
    mic().click();
    expect(last().listening).toBe(false);
    expect(mic().getAttribute("aria-label")).toBe("Speak a message");
    expect(box().value).toBe("Hold on");
  });
});
