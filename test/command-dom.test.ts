// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logFeed } from "../src/shared/log-feed.js";
import { when } from "../src/shared/when.js";
import { NEEDS_YOU, noTimeYet } from "../src/shared/words.js";

import { MAX_CHAT_TEXT, type AuditEntry, type ChatMessage, type ChatPage } from "../src/shared/command.js";
import type { SearchItem } from "../src/shared/search.js";
import { SNAPSHOT_STALE_MS, type Worker } from "../src/shared/workers.js";
import { call } from "../web/src/api.js";
import * as cmd from "../web/src/command-api.js";
import { app, changed } from "../web/src/state.js";
import { localItems } from "../web/src/views/search.js";
import { closeSheet } from "../web/src/views/sheet.js";
import { mountToasts } from "../web/src/views/toast.js";
import { closeWorkerSheet, openChatSheet, openWorkerSheet } from "../web/src/views/worker-sheet.js";
import * as chat from "../web/src/views/chat.js";
import { ACCEPT, FILE_REFUSED, PHOTO_FAILED, sortPick } from "../web/src/views/attach.js";
import { cardMedia } from "../web/src/views/card-media.js";
import { detailBody, EMPTY_LIST } from "./conversations-fake.js";

vi.mock("../web/src/image.js", async (original) => ({
  ...(await original<typeof import("../web/src/image.js")>()),
  // happy-dom cannot decode or draw an image; the canvas step is the browser's.
  prepareImage: (file: File) => prepare(file),
}));

let prepare: (file: File) => Promise<Blob> = async () => new Blob(["jpeg bytes"], { type: "image/jpeg" });
/** How the fake server answers POST /api/images; the default stores it under IMAGE. */
let uploadAnswer: () => Promise<Response> = () => Promise.resolve(json({ image: IMAGE, type: "image/jpeg", size: 10 }, 201));
let uploads: { type: string; body: unknown }[] = [];
/** The abort signal each upload was sent with, in order. */
let uploadSignals: (AbortSignal | null | undefined)[] = [];
/** How the fake server answers POST /api/chat; null queues it. */
let chatAnswer: ((id: string) => Promise<Response>) | null = null;
const IMAGE = "c".repeat(64);
const FILE_SHA = "f".repeat(64);
let fileUploads: string[] = [];
let posts: { url: string; body: Record<string, unknown> }[] = [];
let messages: ChatMessage[] = [];
/** Reads and changes of the open conversation, in order. */
let patches: { url: string; method: string; body: unknown }[] = [];
let actions: Record<string, AuditEntry> = {};
let root: HTMLElement;
/** Answers GET /api/chat by its before cursor; the default serves `messages` as one page. */
let chatPage: ((before: string | null) => ChatPage) | null = null;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function entry(id: string, kind: AuditEntry["kind"], status: AuditEntry["status"], extra: Partial<AuditEntry> = {}): AuditEntry {
  const at = new Date().toISOString();
  return { id, clientId: `c-${id}`, kind, at, updatedAt: at, status, ...extra };
}

function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = String(input);
  const method = init.method ?? "GET";
  if (url === "/api/files") {
    const headers = init.headers as Record<string, string>;
    expect(headers["x-rivet"]).toBe("1");
    const name = decodeURIComponent(headers["x-file-name"]!);
    fileUploads.push(name);
    return Promise.resolve(json({ sha256: FILE_SHA, name: `Server ${name}`, type: "application/pdf", size: 10 }, 201));
  }
  if (url === "/api/images") {
    const headers = init.headers as Record<string, string>;
    expect(headers["x-rivet"]).toBe("1");
    uploads.push({ type: headers["content-type"]!, body: init.body });
    uploadSignals.push(init.signal);
    return uploadAnswer();
  }
  if (url.startsWith("/api/conversations/")) {
    patches.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null });
    return Promise.resolve(json(detailBody("c1", messages)));
  }
  if (url.startsWith("/api/conversations")) return Promise.resolve(json(EMPTY_LIST));
  if (method !== "GET") {
    expect((init.headers as Record<string, string>)["x-rivet"]).toBe("1");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(typeof body.clientId).toBe("string");
    posts.push({ url, body });
  }
  if (url.startsWith("/api/chat") && method === "GET") {
    const before = new URL(url, "http://x").searchParams.get("before");
    return Promise.resolve(json(chatPage ? chatPage(before) : { messages, older: null }));
  }
  if (url === "/api/chat") {
    const id = `msg-${posts.length}`;
    return chatAnswer ? chatAnswer(id) : Promise.resolve(json(entry(id, "chat", "queued"), 202));
  }
  if (url.startsWith("/api/actions/status?id=")) {
    const id = decodeURIComponent(url.split("=")[1]!);
    return Promise.resolve(json(actions[id] ?? entry(id, "chat", "queued")));
  }
  return Promise.resolve(json({ error: "not found" }, 404));
}

beforeEach(() => {
  // These tests are about the messages of one conversation: the tab opens on it.
  chat.showConversation("c1");
  posts = [];
  patches = [];
  uploads = [];
  fileUploads = [];
  chatAnswer = null;
  prepare = async () => new Blob(["jpeg bytes"], { type: "image/jpeg" });
  uploadAnswer = () => Promise.resolve(json({ image: IMAGE, type: "image/jpeg", size: 10 }, 201));
  messages = [];
  actions = {};
  chatPage = null;
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  vi.stubGlobal("EventSource", undefined);
  root = document.createElement("main");
  document.body.replaceChildren(root);
});

afterEach(() => {
  chat.unmount();
  closeSheet();
  closeWorkerSheet();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (globalThis as { blocks?: string[] }).blocks;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("chat tab", () => {
  it("opens an attached Markdown file in the viewer and leaves an Office file to its link", async () => {
    const md = "1".repeat(64);
    const docx = "2".repeat(64);
    messages = [
      {
        id: "a",
        from: "owner",
        text: "Notes",
        at: "2026-09-28T01:00:00.000Z",
        status: "replied",
        files: [
          { sha256: md, name: "notes.md" },
          { sha256: docx, name: "report.docx" },
        ],
      },
    ];
    chat.mount(root);
    await settle();
    const [mdLink, docxLink] = [...root.querySelectorAll<HTMLAnchorElement>(".chat-file")];
    const click = (link: HTMLAnchorElement) => {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      link.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(click(docxLink!)).toBe(false);
    expect(document.querySelector(".lightbox")).toBeNull();
    expect(click(mdLink!)).toBe(true);
    expect(document.querySelector(".lightbox-title")!.textContent).toBe("notes.md");
    await settle();
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input))).toContain(`/media/${md}?name=notes.md`);
    expect(document.querySelector(".lightbox-note")!.textContent).toBe("That file is no longer on the server.");
    chat.unmount();
    expect(document.querySelector(".lightbox")).toBeNull();
  });

  it("shows Rivet's PDF as a tile with its icon, own name and size, which opens it in the PDF viewer", async () => {
    const pdf = "3".repeat(64);
    messages = [
      {
        id: "p",
        from: "rivet",
        text: "Your quarterly report.",
        at: "2026-09-28T01:00:00.000Z",
        files: [{ sha256: pdf, name: "Quarterly report (v2).pdf", bytes: 482_000 }],
      },
    ];
    chat.mount(root);
    await settle();
    const link = root.querySelector<HTMLAnchorElement>(".chat-files .chat-file")!;
    expect(link.getAttribute("href")).toBe(`/media/${pdf}?name=${encodeURIComponent("Quarterly report (v2).pdf")}`);
    expect(link.querySelector(".file-chip-sized .file-chip-icon svg text")!.textContent).toBe("PDF");
    expect(link.querySelector(".file-chip-name")!.textContent).toBe("Quarterly report (v2).pdf");
    expect(link.querySelector(".file-chip-size")!.textContent).toBe("PDF · 471 KB");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector(".lightbox-title")!.textContent).toBe("Quarterly report (v2).pdf");
    await settle();
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input))).toContain(`/media/${pdf}?name=${encodeURIComponent("Quarterly report (v2).pdf")}`);
    chat.unmount();
  });

  it("shows the thread with delivery states and sends a message", async () => {
    messages = [
      { id: "a", from: "owner", text: "What's next?", at: "2026-09-28T01:00:00.000Z", status: "replied" },
      { id: "b", from: "rivet", text: "Signup Flow.", at: "2026-09-28T01:01:00.000Z", replyTo: "a" },
      { id: "c", from: "owner", text: "OK", at: "2026-09-28T01:02:00.000Z", status: "typed" },
    ];
    chat.mount(root);
    await settle();
    const rows = [...root.querySelectorAll(".chat-msg")];
    expect(rows.map((row) => row.querySelector(".chat-body")!.textContent)).toEqual(["What's next?", "Signup Flow.", "OK"]);
    // Replied is a small tick, named for a screen reader.
    expect(rows[0]!.querySelector(".chat-status.replied .chat-tick svg")).not.toBeNull();
    expect(rows[0]!.querySelector(".chat-status.replied")?.getAttribute("aria-label")).toBe("Replied");
    expect(rows[2]!.textContent).toContain("Typed to Rivet");
    expect(rows[1]!.classList.contains("theirs")).toBe(true);

    const text = root.querySelector<HTMLTextAreaElement>(".chat-text")!;
    text.value = "  deploy rivet  ";
    root.querySelector<HTMLButtonElement>(".chat-send")!.click();
    await settle();
    await settle();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.text).toBe("deploy rivet");
    expect(text.value).toBe("");
    expect(root.querySelector(".chat-msg.mine:last-child")!.textContent).toContain("Sent");
  });

  it("a message waiting for follow-ups reads Collecting…, with a line above the box until the window goes", async () => {
    chatAnswer = (id) => Promise.resolve(json(entry(id, "chat", "collecting"), 202));
    chat.mount(root);
    await settle();
    const note = root.querySelector<HTMLElement>(".chat-collecting")!;
    expect(note.hidden).toBe(true);
    // Only the reply preview, which belongs to the box, may sit between them.
    expect(note.nextElementSibling!.classList.contains("chat-replying")).toBe(true);
    expect(note.nextElementSibling!.nextElementSibling!.classList.contains("chat-compose")).toBe(true);

    root.querySelector<HTMLTextAreaElement>(".chat-text")!.value = "ship signup flow";
    root.querySelector<HTMLButtonElement>(".chat-send")!.click();
    await settle();
    await settle();
    expect(root.querySelector(".chat-msg.mine:last-child .chat-status")!.textContent).toBe(" · Collecting…");
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe("Collecting for a few seconds. Anything else you send joins this message.");

    messages = [
      { id: "msg-1", from: "owner", text: "ship signup flow", at: "2026-09-30T01:00:00.000Z", status: "sent" },
      { id: "msg-2", from: "owner", text: "then panda", at: "2026-09-30T01:00:05.000Z", status: "sent" },
    ];
    await chat.refresh();
    expect([...root.querySelectorAll(".chat-msg .chat-status")].map((status) => status.textContent)).toEqual([" · Sent", " · Sent"]);
    expect(note.hidden).toBe(true);
  });

  it("a second Enter while the first send is in flight sends nothing", async () => {
    chat.mount(root);
    await settle();
    const text = root.querySelector<HTMLTextAreaElement>(".chat-text")!;
    text.value = "deploy rivet";
    const enter = () => text.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    enter();
    enter();
    root.querySelector<HTMLButtonElement>(".chat-send")!.click();
    await settle();
    await settle();
    expect(posts.filter((p) => p.url === "/api/chat")).toHaveLength(1);
  });

  it("after a reconnect, reads the open conversation again and shows what came in while the stream was down", async () => {
    const listeners: Record<string, (() => void)[]> = {};
    class FakeSource {
      static CLOSED = 2;
      readyState = 1;
      addEventListener(type: string, fn: () => void) {
        (listeners[type] ??= []).push(fn);
      }
      close() {}
    }
    vi.stubGlobal("EventSource", FakeSource);
    const msg = (id: string): ChatMessage => ({ id, from: "rivet", text: `text ${id}`, at: `2026-09-28T01:00:0${id.slice(1)}.000Z`, threadId: "c1" });
    messages = [msg("m1"), msg("m2")];
    chat.mount(root);
    await settle();
    const reads = () => patches.filter((one) => one.method === "GET").length;
    const before = reads();
    messages = [msg("m1"), msg("m2"), msg("n3"), msg("n4")];
    for (const fn of listeners.open ?? []) fn();
    for (let i = 0; i < 6; i += 1) await settle();
    expect(reads()).toBe(before + 1);
    const shown = [...root.querySelectorAll(".chat-msg .chat-body")].map((row) => row.textContent);
    expect(shown).toEqual(["text m1", "text m2", "text n3", "text n4"]);
  });

  it("a read that fails says so, and the next reconnect reads it again", async () => {
    const listeners: Record<string, (() => void)[]> = {};
    class FakeSource {
      static CLOSED = 2;
      readyState = 1;
      addEventListener(type: string, fn: () => void) {
        (listeners[type] ??= []).push(fn);
      }
      close() {}
    }
    vi.stubGlobal("EventSource", FakeSource);
    messages = [{ id: "m1", from: "rivet", text: "text m1", at: "2026-09-28T01:00:01.000Z", threadId: "c1" }];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith("/api/conversations/") ? Promise.resolve(json({ error: "slow" }, 503)) : fakeFetch(input, init))),
    );
    chat.mount(root);
    await settle();
    expect(root.querySelector(".chat-msg")).toBeNull();
    expect(root.querySelector(".chat-hint")!.textContent).not.toBe("");
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
    for (const fn of listeners.open ?? []) fn();
    for (let i = 0; i < 6; i += 1) await settle();
    expect(root.querySelector(".chat-msg .chat-body")!.textContent).toBe("text m1");
  });

  it("reopens a chat stream that goes quiet for STREAM_IDLE_MS, and a ping keeps an open one going", async () => {
    const sources: FakeStream[] = [];
    class FakeStream {
      static CLOSED = 2;
      readyState = 1;
      closed = false;
      listeners: Record<string, (() => void)[]> = {};
      constructor() {
        sources.push(this);
      }
      addEventListener(type: string, fn: () => void) {
        (this.listeners[type] ??= []).push(fn);
      }
      fire(type: string) {
        for (const fn of this.listeners[type] ?? []) fn();
      }
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("EventSource", FakeStream);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    chat.mount(root);
    sources[0]!.fire("open");
    vi.advanceTimersByTime(chat.STREAM_IDLE_MS - 1000);
    sources[0]!.fire("ping");
    vi.advanceTimersByTime(chat.STREAM_IDLE_MS - 1000);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.closed).toBe(false);
    // Nothing for STREAM_IDLE_MS since the ping: closed, and a fresh stream opened in its place.
    vi.advanceTimersByTime(1000);
    expect(sources[0]!.closed).toBe(true);
    expect(sources).toHaveLength(2);
    // A stream that never opens is reopened too.
    vi.advanceTimersByTime(chat.STREAM_IDLE_MS);
    expect(sources[1]!.closed).toBe(true);
    expect(sources).toHaveLength(3);
    // Leaving Chat stops the watch.
    chat.unmount();
    expect(sources[2]!.closed).toBe(true);
    vi.advanceTimersByTime(chat.STREAM_IDLE_MS * 2);
    expect(sources).toHaveLength(3);
  });

  it("closes the chat stream while the app is hidden, so its pings stop waking the phone, and opens a fresh one in front", () => {
    const sources: { closed: boolean }[] = [];
    class FakeStream {
      static CLOSED = 2;
      readyState = 1;
      closed = false;
      constructor() {
        sources.push(this);
      }
      addEventListener() {}
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("EventSource", FakeStream);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const show = (state: "visible" | "hidden") => {
      Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    try {
      chat.mount(root);
      show("hidden");
      expect(sources[0]!.closed).toBe(true);
      // Nothing reopens it while hidden, not even the quiet-stream watch.
      vi.advanceTimersByTime(chat.STREAM_IDLE_MS * 2);
      expect(sources).toHaveLength(1);
      show("visible");
      expect(sources).toHaveLength(2);
      expect(sources[1]!.closed).toBe(false);
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("mounted while the app is hidden, opens no chat stream until it is in front", () => {
    const sources: unknown[] = [];
    class FakeStream {
      static CLOSED = 2;
      readyState = 1;
      constructor() {
        sources.push(this);
      }
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal("EventSource", FakeStream);
    try {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      chat.mount(root);
      expect(sources).toHaveLength(0);
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(sources).toHaveLength(1);
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("without speech recognition the mic focuses the box and says how to dictate", async () => {
    chat.mount(root);
    await settle();
    root.querySelector<HTMLButtonElement>(".chat-mic")!.click();
    expect(root.querySelector(".chat-hint")!.textContent).toMatch(/microphone on your keyboard/);
    expect(document.activeElement).toBe(root.querySelector(".chat-text"));
  });

  it("with speech recognition the mic fills the box", async () => {
    let instance: { onresult: ((event: unknown) => void) | null; onend: (() => void) | null; start(): void } | null = null;
    class FakeRecognition {
      lang = "";
      interimResults = false;
      continuous = false;
      onresult: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      start() {
        instance = this;
      }
      abort() {}
    }
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    chat.mount(root);
    await settle();
    root.querySelector<HTMLButtonElement>(".chat-mic")!.click();
    expect(root.querySelector(".chat-mic")!.classList.contains("on")).toBe(true);
    instance!.onresult!({ results: [[{ transcript: "pause atlas" }]] });
    // The browser ending the recognition at a pause leaves the mic on.
    instance!.onend!();
    expect(root.querySelector<HTMLTextAreaElement>(".chat-text")!.value).toBe("pause atlas");
    expect(root.querySelector(".chat-mic")!.classList.contains("on")).toBe(true);
    root.querySelector<HTMLButtonElement>(".chat-mic")!.click();
    expect(root.querySelector(".chat-mic")!.classList.contains("on")).toBe(false);
  });
});

/** Picks a photo in the attach input under `scope`, as the iOS picker does. */
function pickPhoto(scope: ParentNode, name = "IMG_0001.HEIC"): void {
  const input = scope.querySelector<HTMLInputElement>(".attach-input")!;
  Object.defineProperty(input, "files", { value: [new File(["heic bytes"], name, { type: "image/heic" })], configurable: true });
  input.dispatchEvent(new Event("change"));
}

/** Picks several photos at once, as the iOS picker does with multiple selection. */
function pickPhotos(scope: ParentNode, count: number): void {
  const input = scope.querySelector<HTMLInputElement>(".attach-input")!;
  const files = Array.from({ length: count }, (_, i) => new File(["heic bytes"], `IMG_${i + 1}.HEIC`, { type: "image/heic" }));
  Object.defineProperty(input, "files", { value: files, configurable: true });
  input.dispatchEvent(new Event("change"));
}

function deferred(): { promise: Promise<Response>; resolve(response: Response): void } {
  let resolve!: (response: Response) => void;
  return { promise: new Promise<Response>((done) => (resolve = done)), resolve };
}

describe("chat files", () => {
  const pick = (files: File[]) => {
    const input = root.querySelector<HTMLInputElement>(".attach-input")!;
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new Event("change"));
  };

  it("shows a document as a chip with its own remove button, refuses a bad type at once, and sends the file", async () => {
    chat.mount(root);
    await settle();
    pick([new File(["<html>"], "page.html", { type: "text/html" }), new File(["%PDF-1.7"], "report.pdf", { type: "application/pdf" })]);
    const preview = root.querySelector<HTMLElement>(".attach-preview")!;
    expect(preview.querySelector(".attach-notice")!.textContent).toBe("That file type can't be sent. Attach photos, videos, music, PDFs, text files, Office documents, emails, ZIPs or GLB models.");
    await settle();
    await settle();
    expect(fileUploads).toEqual(["report.pdf"]);
    const tile = preview.querySelector(".attach-tile.attach-doc")!;
    expect(tile.querySelector(".file-chip-name")!.textContent).toBe("Server report.pdf");
    expect(tile.querySelector(".attach-remove")!.getAttribute("aria-label")).toBe("Remove Server report.pdf");
    expect(preview.querySelector(".attach-note")!.textContent).toBe("File attached");

    root.querySelector<HTMLTextAreaElement>(".chat-text")!.value = "";
    root.querySelector<HTMLButtonElement>(".chat-send")!.click();
    await settle();
    await settle();
    expect(posts.map((post) => post.body)).toEqual([{ clientId: expect.any(String), files: [{ sha256: FILE_SHA, name: "Server report.pdf" }], conversation: null }]);
    const link = root.querySelector<HTMLAnchorElement>(".chat-files .chat-file")!;
    expect(link.getAttribute("href")).toBe(`/media/${FILE_SHA}?name=Server%20report.pdf`);
    expect(link.getAttribute("rel")).toBe("noopener");
  });

  it("refuses a file over 25 MB without uploading it, and removes a chip with its ×", async () => {
    chat.mount(root);
    await settle();
    const big = new File(["x"], "huge.pdf", { type: "application/pdf" });
    Object.defineProperty(big, "size", { value: 25 * 1024 * 1024 + 1 });
    pick([big, new File(["a,b"], "sheet.csv", { type: "text/csv" })]);
    const preview = root.querySelector<HTMLElement>(".attach-preview")!;
    expect(preview.querySelector(".attach-notice")!.textContent).toBe("That file is over 25 MB. Send a smaller one.");
    await settle();
    expect(fileUploads).toEqual(["sheet.csv"]);
    preview.querySelector<HTMLButtonElement>(".attach-doc .attach-remove")!.click();
    expect(preview.querySelector(".attach-tile")).toBeNull();
  });

  it("takes a video or sound file up to 100 MB as a file", async () => {
    chat.mount(root);
    await settle();
    const video = new File(["x"], "monkey.mp4", { type: "video/mp4" });
    Object.defineProperty(video, "size", { value: 60 * 1024 * 1024 });
    const huge = new File(["x"], "long.mov", { type: "video/quicktime" });
    Object.defineProperty(huge, "size", { value: 100 * 1024 * 1024 + 1 });
    pick([video, huge, new File(["x"], "beat.m4a", { type: "audio/mp4" })]);
    const preview = root.querySelector<HTMLElement>(".attach-preview")!;
    expect(preview.querySelector(".attach-notice")!.textContent).toBe("That video or sound file is over 100 MB. Send a shorter one.");
    await settle();
    await settle();
    expect(fileUploads).toEqual(["monkey.mp4", "beat.m4a"]);
    expect(root.querySelector<HTMLInputElement>(".attach-input")!.accept).toContain(".mp4");
  });

  it("sends a HEIC the browser cannot draw as a file, and a GIF as one without trying", async () => {
    prepare = () => Promise.reject(new Error("Couldn't read that image."));
    chat.mount(root);
    await settle();
    pick([new File(["heic"], "20261006_075301.heic", { type: "image/heic" }), new File(["GIF89a"], "dance.gif", { type: "image/gif" })]);
    for (let i = 0; i < 4; i += 1) await settle();
    expect(fileUploads).toEqual(["20261006_075301.heic", "dance.gif"]);
    const preview = root.querySelector<HTMLElement>(".attach-preview")!;
    expect(preview.querySelectorAll(".attach-tile.attach-doc")).toHaveLength(2);
    expect(preview.querySelector(".attach-thumb")).toBeNull();
    expect(preview.textContent).not.toContain("Couldn't read that image");
  });
});

describe("a share from another app", () => {
  const mp3 = () => new File(["ID3 bytes"], "Demo theme.mp3", { type: "audio/mpeg" });
  const photo = () => new File(["jpeg bytes"], "IMG-20261006-0001.jpg", { type: "image/jpeg" });
  // Earlier tests leave a draft behind.
  beforeEach(() => localStorage.clear());

  it("waits for the chat to open, then fills a new conversation's composer and sends nothing until Send", async () => {
    chat.receiveShare({ text: "From message: the new song", files: [mp3(), photo()], lost: [] });
    chat.mount(root);
    await settle();
    await settle();
    await settle();
    expect(root.querySelector<HTMLTextAreaElement>(".chat-text")!.value).toBe("From message: the new song");
    expect(fileUploads).toEqual(["Demo theme.mp3"]);
    expect(uploads).toHaveLength(1);
    const preview = root.querySelector<HTMLElement>(".attach-preview")!;
    expect(preview.querySelector(".attach-doc .file-chip-name")!.textContent).toBe("Server Demo theme.mp3");
    expect(preview.querySelector(".attach-thumb")).not.toBeNull();
    expect(preview.querySelector(".attach-note")!.textContent).toBe("1 photo and 1 file attached");
    expect(posts.filter((post) => post.url === "/api/chat")).toEqual([]);

    root.querySelector<HTMLButtonElement>(".chat-send")!.click();
    await settle();
    await settle();
    const sent = posts.filter((post) => post.url === "/api/chat").map((post) => post.body);
    expect(sent).toEqual([
      expect.objectContaining({ text: "From message: the new song", image: IMAGE, files: [{ sha256: FILE_SHA, name: "Server Demo theme.mp3" }], conversation: null }),
    ]);
  });

  it("lands in the chat on screen after what is already typed, and refuses what the paper clip would", async () => {
    chat.mount(root);
    await settle();
    const text = root.querySelector<HTMLTextAreaElement>(".chat-text")!;
    text.value = "Look at this ";
    chat.receiveShare({ text: "https://example.com/clip", files: [new File(["<html>"], "page.html", { type: "text/html" })], lost: ["clip.mp4"] });
    expect(text.value).toBe("Look at this\nhttps://example.com/clip");
    expect(root.querySelector(".attach-notice")!.textContent).toBe(
      `clip.mp4 didn't come through from the share. Share again, or attach with the paper clip. ${FILE_REFUSED}`,
    );
    expect(fileUploads).toEqual([]);
    expect(localStorage.getItem("rivet.chat.draft")).toBe("Look at this\nhttps://example.com/clip");
  });

  it("never cuts shared words that would not fit after the draft, and says so", async () => {
    const toasts = document.createElement("div");
    document.body.append(toasts);
    mountToasts(toasts);
    chat.mount(root);
    await settle();
    const text = root.querySelector<HTMLTextAreaElement>(".chat-text")!;
    text.value = "x".repeat(MAX_CHAT_TEXT - 3);
    chat.receiveShare({ text: "https://example.com/clip", files: [], lost: [] });
    expect(text.value).toBe("x".repeat(MAX_CHAT_TEXT - 3));
    expect(toasts.querySelector(".toast.flash")!.textContent).toBe(chat.SHARE_TOO_LONG);
    mountToasts(null);
  });
});

describe("chat attachments", () => {
  let revoked: string[];
  beforeEach(() => {
    revoked = [];
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => void revoked.push(url));
  });
  afterEach(() => vi.restoreAllMocks());

  const preview = () => root.querySelector<HTMLElement>(".attach-preview")!;
  const send = async (value: string) => {
    root.querySelector<HTMLTextAreaElement>(".chat-text")!.value = value;
    root.querySelector<HTMLButtonElement>(".chat-send")!.click();
    await settle();
    await settle();
  };

  it("previews a picked photo while it uploads, then sends it with the text", async () => {
    const upload = deferred();
    uploadAnswer = () => upload.promise;
    chat.mount(root);
    await settle();
    expect(root.querySelector(".attach-btn")!.getAttribute("aria-label")).toBe("Attach photos or files");
    expect(root.querySelector(".attach-input")!.getAttribute("accept")).toMatch(/^image\/\*,\.pdf,.*application\/pdf/);
    expect(root.querySelector(".attach-input")!.hasAttribute("multiple")).toBe(true);
    expect(preview().hidden).toBe(true);

    pickPhoto(root);
    await settle();
    expect(preview().hidden).toBe(false);
    expect(preview().querySelector<HTMLImageElement>(".attach-thumb")!.getAttribute("src")).toBe("blob:preview");
    expect(preview().querySelector(".attach-note")!.textContent).toBe("Getting the photo ready…");
    expect(uploads).toEqual([{ type: "image/jpeg", body: expect.any(Blob) }]);

    await send("Is this right?");
    expect(posts).toHaveLength(0);
    expect(root.textContent).toContain("The photo is still getting ready.");

    upload.resolve(json({ image: IMAGE, type: "image/jpeg", size: 10 }, 201));
    await settle();
    expect(preview().querySelector(".attach-note")!.textContent).toBe("Photo attached");

    await send("Is this right?");
    expect(posts.map((post) => post.body)).toMatchObject([{ text: "Is this right?", image: IMAGE }]);
    expect(preview().hidden).toBe(true);
    expect(revoked).toEqual(["blob:preview"]);
    const sent = root.querySelector(".chat-msg.mine:last-child")!;
    expect(sent.querySelector(".chat-image")!.getAttribute("src")).toBe(`/media/${IMAGE}`);
    expect(sent.querySelector(".chat-body")!.textContent).toBe("Is this right?");
  });

  it("sends a photo with no text", async () => {
    chat.mount(root);
    await settle();
    pickPhoto(root, "Screenshot.png");
    await settle();
    await send("   ");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.image).toBe(IMAGE);
    expect(posts[0]!.body).not.toHaveProperty("text");
    const sent = root.querySelector(".chat-msg.mine:last-child")!;
    expect(sent.querySelector(".chat-image")).not.toBeNull();
    expect(sent.querySelector(".chat-body")).toBeNull();
  });

  it("Remove drops the photo, even one still uploading, and the next send is text only", async () => {
    const upload = deferred();
    uploadAnswer = () => upload.promise;
    chat.mount(root);
    await settle();
    pickPhoto(root);
    await settle();
    preview().querySelector<HTMLButtonElement>(".attach-remove")!.click();
    expect(preview().hidden).toBe(true);
    upload.resolve(json({ image: IMAGE, type: "image/jpeg", size: 10 }, 201));
    await settle();
    expect(preview().hidden).toBe(true);

    await send("");
    expect(posts).toHaveLength(0);
    await send("just text");
    expect(posts.map((post) => post.body)).toEqual([{ clientId: expect.any(String), text: "just text", conversation: null }]);
  });

  it("shows the server's refusal and sends nothing for the photo", async () => {
    uploadAnswer = () => Promise.resolve(json({ error: "The image is over 8 MB. Pick a smaller one or take a screenshot of it." }, 413));
    chat.mount(root);
    await settle();
    pickPhoto(root);
    await settle();
    await settle();
    const note = preview().querySelector(".attach-note")!;
    expect(note.classList.contains("error")).toBe(true);
    expect(note.textContent).toBe("The image is over 8 MB. Pick a smaller one or take a screenshot of it.");
    expect(preview().querySelector(".attach-thumb")).toBeNull();
    await send("");
    expect(posts).toHaveLength(0);
  });

  it("a caption with a photo that failed to upload does not send; the caption stays", async () => {
    uploadAnswer = () => Promise.resolve(json({ error: "that file is not a JPEG or PNG image" }, 415));
    chat.mount(root);
    await settle();
    pickPhoto(root);
    await settle();
    await settle();
    await send("The checkout button looks cramped here");
    expect(posts).toHaveLength(0);
    expect(root.querySelector(".chat-hint")!.textContent).toBe("The photo didn't upload. Try again or remove it.");
    expect(root.querySelector<HTMLTextAreaElement>(".chat-text")!.value).toBe("The checkout button looks cramped here");
  });

  it("a photo the Mac's bridge cannot take yet: a toast, and the draft and photo stay", async () => {
    const toasts = document.createElement("div");
    document.body.append(toasts);
    mountToasts(toasts);
    chatAnswer = () => Promise.resolve(json({ error: "The Mac's bridge needs updating before it can take photos." }, 424));
    chat.mount(root);
    await settle();
    pickPhoto(root);
    await settle();
    await send("Is this right?");
    expect(posts.map((post) => post.body)).toMatchObject([{ text: "Is this right?", image: IMAGE }]);
    expect(toasts.querySelector(".toast.flash")!.textContent).toBe("The Mac's bridge needs updating before it can take photos.");
    expect(root.querySelector<HTMLTextAreaElement>(".chat-text")!.value).toBe("Is this right?");
    expect(preview().hidden).toBe(false);
    expect(preview().querySelector(".attach-note")!.textContent).toBe("Photo attached");
    mountToasts(null);
  });

  it("a photo picked while a send is in flight stays for the next message", async () => {
    const sent = deferred();
    chatAnswer = () => sent.promise;
    chat.mount(root);
    await settle();
    pickPhoto(root);
    await settle();
    await send("first");
    uploadAnswer = () => Promise.resolve(json({ image: "e".repeat(64), type: "image/png", size: 10 }, 201));
    pickPhoto(root, "second.png");
    await settle();
    sent.resolve(json(entry("msg-1", "chat", "queued"), 202));
    await settle();
    await settle();
    expect(preview().hidden).toBe(false);
    expect(preview().querySelector(".attach-note")!.textContent).toBe("Photo attached");
    chatAnswer = null;
    await send("second");
    expect(posts.map((post) => post.body.image)).toEqual([IMAGE, "e".repeat(64)]);
  });

  it("leaving Chat releases the preview and drops a photo still being prepared", async () => {
    chat.mount(root);
    await settle();
    pickPhoto(root);
    await settle();
    chat.unmount();
    expect(revoked).toEqual(["blob:preview"]);

    let ready!: (blob: Blob) => void;
    prepare = () => new Promise<Blob>((done) => (ready = done));
    chat.mount(root);
    await settle();
    pickPhoto(root);
    await settle();
    chat.unmount();
    ready(new Blob(["jpeg"], { type: "image/jpeg" }));
    await settle();
    expect(vi.mocked(URL.createObjectURL)).toHaveBeenCalledTimes(1);
    expect(uploads).toHaveLength(1);
  });

  describe("several photos", () => {
    let uploaded = 0;
    beforeEach(() => {
      uploaded = 0;
      uploadAnswer = () => Promise.resolve(json({ image: String((uploaded += 1)).repeat(64), type: "image/jpeg", size: 10 }, 201));
    });
    const tiles = () => [...preview().querySelectorAll<HTMLElement>(".attach-tile")];
    const removeLabels = () => tiles().map((tile) => tile.querySelector(".attach-remove")!.getAttribute("aria-label"));
    const note = () => preview().querySelector(".attach-note")!.textContent;

    it("picks several at once into a strip with a remove button each, and sends them as one message", async () => {
      chat.mount(root);
      await settle();
      pickPhotos(root, 3);
      await settle();
      await settle();
      expect(uploads).toHaveLength(3);
      expect(removeLabels()).toEqual(["Remove photo 1", "Remove photo 2", "Remove photo 3"]);
      expect(note()).toBe("3 photos attached");

      tiles()[1]!.querySelector<HTMLButtonElement>(".attach-remove")!.click();
      expect(removeLabels()).toEqual(["Remove photo 1", "Remove photo 2"]);
      expect(note()).toBe("2 photos attached");
      expect(revoked).toEqual(["blob:preview"]);

      await send("Two views");
      expect(posts.map((post) => post.body)).toEqual([{ clientId: expect.any(String), text: "Two views", images: ["1".repeat(64), "3".repeat(64)], conversation: null }]);
      expect(preview().hidden).toBe(true);
      const sent = root.querySelector(".chat-msg.mine:last-child")!;
      expect([...sent.querySelectorAll(".chat-images .chat-image-tile")].map((img) => [img.getAttribute("src"), img.getAttribute("alt")])).toEqual([
        [`/media/${"1".repeat(64)}`, "Photo you sent, 1 of 2"],
        [`/media/${"3".repeat(64)}`, "Photo you sent, 2 of 2"],
      ]);
      // A tap opens that photo full screen, the other a swipe away; leaving Chat closes it.
      sent.querySelectorAll<HTMLButtonElement>(".chat-image-open")[1]!.click();
      expect(document.querySelector(".lightbox-img")!.getAttribute("src")).toBe(`/media/${"3".repeat(64)}`);
      expect(document.querySelector(".lightbox-title")!.textContent).toBe("Photo 2 of 2");
      chat.unmount();
      expect(document.querySelector(".lightbox")).toBeNull();
    });

    it("prepares and uploads them one at a time, and Send waits for the last", async () => {
      const first = deferred();
      uploadAnswer = () => first.promise;
      chat.mount(root);
      await settle();
      pickPhotos(root, 2);
      await settle();
      expect(uploads).toHaveLength(1);
      expect(note()).toBe("Getting 2 of 2 photos ready…");
      await send("wait");
      expect(posts).toHaveLength(0);
      expect(root.querySelector(".chat-hint")!.textContent).toBe("The photos are still getting ready.");
      uploadAnswer = () => Promise.resolve(json({ image: "b".repeat(64), type: "image/jpeg", size: 10 }, 201));
      first.resolve(json({ image: "a".repeat(64), type: "image/jpeg", size: 10 }, 201));
      await settle();
      await settle();
      expect(uploads).toHaveLength(2);
      await send("now");
      expect(posts.map((post) => post.body.images)).toEqual([["a".repeat(64), "b".repeat(64)]]);
    });

    it("removing a photo whose upload has stalled cancels it, and the next photos upload and send", async () => {
      uploadSignals = [];
      const stalled = deferred();
      uploadAnswer = () => stalled.promise;
      chat.mount(root);
      await settle();
      pickPhotos(root, 2);
      await settle();
      expect(uploads).toHaveLength(1);
      uploadAnswer = () => Promise.resolve(json({ image: "b".repeat(64), type: "image/jpeg", size: 10 }, 201));
      tiles()[0]!.querySelector<HTMLButtonElement>(".attach-remove")!.click();
      expect(uploadSignals[0]?.aborted).toBe(true);
      await settle();
      await settle();
      expect(uploads).toHaveLength(2);
      expect(note()).toBe("Photo attached");
      await send("the second one");
      expect(posts.map((post) => post.body)).toEqual([{ clientId: expect.any(String), text: "the second one", image: "b".repeat(64), conversation: null }]);
    });

    it("takes up to 10: the rest are left out with a note, and the button still takes files", async () => {
      chat.mount(root);
      await settle();
      pickPhotos(root, 12);
      await settle();
      await settle();
      expect(tiles()).toHaveLength(10);
      expect(uploads).toHaveLength(10);
      expect(note()).toBe("10 photos attached");
      expect(preview().querySelector(".attach-notice")!.textContent).toBe("A message takes up to 10 photos, so 2 were left out.");
      expect(root.querySelector<HTMLButtonElement>(".attach-btn")!.disabled).toBe(false);
      tiles()[0]!.querySelector<HTMLButtonElement>(".attach-remove")!.click();
      expect(note()).toBe("9 photos attached");
      expect(preview().querySelector<HTMLElement>(".attach-notice")!.hidden).toBe(true);
    });

    it("one that failed holds Send until it is removed; the others stay", async () => {
      uploadAnswer = () =>
        (uploaded += 1) === 2
          ? Promise.resolve(json({ error: "The image is over 8 MB. Pick a smaller one or take a screenshot of it." }, 413))
          : Promise.resolve(json({ image: String(uploaded).repeat(64), type: "image/jpeg", size: 10 }, 201));
      chat.mount(root);
      await settle();
      pickPhotos(root, 3);
      await settle();
      await settle();
      expect(tiles().map((tile) => tile.classList.contains("failed"))).toEqual([false, true, false]);
      expect(preview().querySelector(".attach-note")!.classList.contains("error")).toBe(true);
      expect(note()).toBe("The image is over 8 MB. Pick a smaller one or take a screenshot of it.");
      await send("see");
      expect(posts).toHaveLength(0);
      expect(root.querySelector(".chat-hint")!.textContent).toBe(PHOTO_FAILED);
      tiles()[1]!.querySelector<HTMLButtonElement>(".attach-remove")!.click();
      await send("see");
      expect(posts.map((post) => post.body.images)).toEqual([["1".repeat(64), "3".repeat(64)]]);
    });
  });

  it("the empty message box's hint fits on one line at phone width", async () => {
    chat.mount(root);
    await settle();
    // Chat opens on the screen it was left on: Back takes it to Chat.
    root.querySelector<HTMLButtonElement>(".thing-back")?.click();
    await settle();
    expect(root.querySelector(".chat-text")!.getAttribute("placeholder")).toBe("Message");
    expect(root.querySelector(".chat-text")!.getAttribute("aria-label")).toBe("Message Rivet");
  });
});

describe("action retries", () => {
  const pause = (key: string) => cmd.once(key, (clientId) => call<AuditEntry>("POST", "/api/actions/pause", { clientId }));
  it("keeps one clientId until the outcome is known", async () => {
    const seen: string[] = [];
    const plan: (Response | "lost")[] = [
      "lost",
      json({}, 502),
      json({ error: "internal error" }, 500),
      json({}, 408),
      json({}, 429),
      json({ error: "full" }, 507),
      json(entry("x1", "pause", "queued"), 202),
      json({ error: "no" }, 400),
      json(entry("x2", "pause", "queued"), 202),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init: RequestInit = {}) => {
        seen.push(String(JSON.parse(String(init.body)).clientId));
        const next = plan.shift()!;
        return next === "lost" ? Promise.reject(new TypeError("network")) : Promise.resolve(next);
      }),
    );
    // A lost answer, a timeout, a rate limit or any 5xx is no refusal: the action may have happened.
    for (const status of [0, 502, 500, 408, 429, 507]) await expect(pause("pause\nrivet")).rejects.toMatchObject({ status });
    await pause("pause\nrivet");
    await expect(pause("pause\nrivet")).rejects.toMatchObject({ status: 400 });
    await pause("pause\nrivet");
    expect(new Set(seen.slice(0, 7)).size).toBe(1);
    expect(new Set(seen).size).toBe(3);
    expect(seen[7]).not.toBe(seen[8]);
  });

  it("a 503 saying the action was never sent lets its clientId go; any other 503 keeps it", async () => {
    const seen: string[] = [];
    const plan: Response[] = [
      json({ error: "the Mac bridge is offline" }, 503),
      json({ error: "the Mac bridge is offline", undelivered: true }, 503),
      json(entry("x4", "pause", "queued"), 202),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init: RequestInit = {}) => {
        seen.push(String(JSON.parse(String(init.body)).clientId));
        return Promise.resolve(plan.shift()!);
      }),
    );
    await expect(pause("pause\nrivet")).rejects.toMatchObject({ status: 503, undelivered: false });
    await expect(pause("pause\nrivet")).rejects.toMatchObject({ status: 503, undelivered: true });
    await pause("pause\nrivet");
    expect(seen[0]).toBe(seen[1]);
    expect(seen[2]).not.toBe(seen[1]);
  });

  it("an accepted answer that is cut off or names no action is not a success", async () => {
    const seen: string[] = [];
    const cut = new Response('{"id":"x3","clientId', { status: 202, headers: { "content-type": "application/json" } });
    const plan: Response[] = [cut, json({}, 202), json(entry("x3", "pause", "queued"), 202)];
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init: RequestInit = {}) => {
        seen.push(String(JSON.parse(String(init.body)).clientId));
        return Promise.resolve(plan.shift()!);
      }),
    );
    await expect(pause("pause\no/r")).rejects.toMatchObject({ status: 0 });
    await expect(pause("pause\no/r")).rejects.toMatchObject({ status: 0 });
    await expect(pause("pause\no/r")).resolves.toMatchObject({ id: "x3" });
    expect(new Set(seen).size).toBe(1);
  });
});

describe("search", () => {
  it("the header search asks the chat history for the query", async () => {
    const hit: SearchItem = { kind: "message", key: "message:h1", title: "the build is ready", detail: "Rivet", open: { type: "message", id: "h1" } };
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        asked.push(String(input));
        return Promise.resolve(String(input).startsWith("/api/chat/search") ? json({ results: [hit] }) : json({ error: "no" }, 404));
      }),
    );
    const items = await localItems("build");
    expect(items).toContainEqual(hit);
    expect(asked).toContain("/api/chat/search?q=build");
  });

});

describe("worker sheet", () => {
  const worker: Worker = { id: "w1", name: "Atlas", repo: "example-org/example-repo", chat: "atlas", state: "working", lastOutputAt: Date.now() };

  it("its log says why it has no lines after 6s rather than wait on, and shows them when they land", async () => {
    const previous = { workers: app.workers, workersAt: app.workersAt, status: app.status };
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    const subscribe = vi.spyOn(cmd, "subscribeLogs").mockResolvedValue({ leaseUntil: "later" });
    const release = vi.spyOn(cmd, "releaseLogs").mockResolvedValue({ ok: true });
    let lines: string[] = [];
    const poll = vi.spyOn(cmd, "getLogsIfChanged").mockImplementation(async () => ({
      logs: { repo: worker.repo, chat: worker.chat, lines, times: lines.map(() => null), updatedAt: null, leaseUntil: null, feed: lines.map((text) => ({ kind: "said" as const, text, at: null })) },
      etag: lines.join("|"),
    }));
    try {
      app.status = null;
      app.workersAt = Date.now();
      app.workers = { at: new Date().toISOString(), workers: [worker] };
      openWorkerSheet(worker);
      await vi.advanceTimersByTimeAsync(5_500);
      expect(document.querySelector(".cmd-log")!.textContent).toBe("Waiting for output…");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(document.querySelector(".cmd-log")!.textContent).toBe("The Mac has not sent its screen yet. It may be busy, or this chat's terminal may have closed. Still asking.");
      lines = ["Working on it."];
      await vi.advanceTimersByTimeAsync(500);
      expect(document.querySelector(".cmd-log")!.textContent).toContain("Working on it.");
    } finally {
      closeWorkerSheet();
      vi.useRealTimers();
      subscribe.mockRestore();
      release.mockRestore();
      poll.mockRestore();
      Object.assign(app, previous);
    }
  });

  it("refreshes facts, retains a focused draft, and stops live controls offline or after the worker leaves", async () => {
    const previous = { workers: app.workers, workersAt: app.workersAt, status: app.status };
    const subscribe = vi.spyOn(cmd, "subscribeLogs").mockResolvedValue({ leaseUntil: "later" });
    const release = vi.spyOn(cmd, "releaseLogs").mockResolvedValue({ ok: true });
    try {
      app.status = null;
      app.workersAt = Date.now();
      app.workers = { at: new Date().toISOString(), workers: [worker] };
      openWorkerSheet(worker);
      const text = document.querySelector<HTMLTextAreaElement>(".cmd-text")!;
      text.value = "keep this draft";
      text.focus();
      app.workers = { ...app.workers, workers: [{ ...worker, state: "blocked", doing: "Waiting for review", prs: [2683] }] };
      changed();
      expect(document.querySelector(".scene-facts")!.textContent).toContain("Waiting for review");
      expect(document.querySelector(".scene-facts a")!.textContent).toBe("#2683");
      expect(document.activeElement).toBe(text);
      expect(text.value).toBe("keep this draft");
      app.status = { board: { version: 1, updatedAt: null }, bridge: { connected: false, lastSeenAt: null } };
      changed();
      const send = document.querySelector<HTMLButtonElement>(".cmd-send-row .primary")!;
      // Rivet takes it while the Mac is away: the bridge delivers it when it is back.
      expect(send.disabled).toBe(false);
      expect(send.textContent).toBe("Send (waits for the Mac)");
      expect(document.querySelector(".cmd-log")).toBeNull();
      expect(release).toHaveBeenCalledTimes(1);
      app.status = null;
      changed();
      expect(subscribe).toHaveBeenCalledTimes(2);
      document.querySelector<HTMLElement>(".cmd-log")!.focus();
      app.workers = { ...app.workers, workers: [] };
      changed();
      expect(document.querySelector(".scene-facts")!.textContent).toContain("Offline");
      expect(text.value).toBe("keep this draft");
      expect(release).toHaveBeenCalledTimes(2);
      expect(document.activeElement?.textContent).toBe("Close");
      app.workers = { ...app.workers, workers: [worker] };
      app.workersAt = Date.now() - SNAPSHOT_STALE_MS - 1;
      changed();
      expect(subscribe).toHaveBeenCalledTimes(2);
      closeWorkerSheet();
      app.workers = { ...app.workers, workers: [worker] };
      changed();
      expect(subscribe).toHaveBeenCalledTimes(2);
    } finally {
      closeWorkerSheet();
      Object.assign(app, previous);
      subscribe.mockRestore();
      release.mockRestore();
    }
  });

  it("keeps Discuss this aligned with the offline worker's refreshed PRs", () => {
    const previous = { workers: app.workers, board: app.board, tab: app.tab };
    const draft = vi.spyOn(chat, "startDraft").mockReturnValue(true);
    try {
      app.workers = { at: null, workers: [] };
      const board = { chats: [{ name: worker.chat, repo: worker.repo, prs: [111] }] };
      app.board = { board } as unknown as typeof app.board;
      openWorkerSheet({ ...worker, prs: [] }, { offline: true });
      board.chats[0]!.prs = [222];
      changed();
      expect(document.querySelector(".scene-facts a")?.textContent).toBe("#222");
      document.querySelector<HTMLButtonElement>(".cmd-worker-foot .discuss-this")!.click();
      expect(draft).toHaveBeenCalledWith(expect.stringContaining("PR #222"));
    } finally {
      closeWorkerSheet();
      Object.assign(app, previous);
      draft.mockRestore();
    }
  });

  it("sends a card's unlisted named chat's message to Rivet, tagged, without claiming live controls", async () => {
    const previous = { workers: app.workers, workersAt: app.workersAt, status: app.status };
    try {
      app.status = null;
      app.workersAt = Date.now();
      app.workers = { at: new Date().toISOString(), workers: [] };
      openChatSheet(worker.chat, worker.repo, "card-chat", "feed");
      const text = document.querySelector<HTMLTextAreaElement>(".cmd-text")!;
      const send = document.querySelector<HTMLButtonElement>(".cmd-send-row .primary")!;
      expect(text).not.toBeNull();
      expect(send.disabled).toBe(false);
      expect(document.querySelector(".cmd-log")).toBeNull();
      expect(document.querySelector(".cmd-send .sheet-where")!.textContent).toBe("Goes to Rivet in Chat, tagged atlas. He passes it on.");
      text.value = "run the tests";
      send.click();
      await settle();
      expect(posts.map((post) => [post.url, post.body.text, post.body.conversation])).toEqual([
        ["/api/chat", "About “atlas” (worker, chat atlas, in example-org/example-repo): run the tests", null],
      ]);
    } finally {
      closeWorkerSheet();
      Object.assign(app, previous);
    }
  });

  it("tags a card's PR beside a live chat's own when the card opens its sheet", async () => {
    const previous = { workers: app.workers, workersAt: app.workersAt, status: app.status };
    try {
      app.status = null;
      app.workersAt = Date.now();
      app.workers = { at: new Date().toISOString(), workers: [{ ...worker, prs: [10] }] };
      openChatSheet(worker.chat, worker.repo, "card-chat", "feed", 12);
      const text = document.querySelector<HTMLTextAreaElement>(".cmd-text")!;
      text.value = "approve this PR";
      document.querySelector<HTMLButtonElement>(".cmd-send-row .primary")!.click();
      await settle();
      expect(posts.map((post) => post.body.text)).toEqual([expect.stringMatching(/^About “[^”]+” \(worker, chat atlas, card's PR #12, PR #10, in example-org\/example-repo\): approve this PR$/)]);
    } finally {
      closeWorkerSheet();
      Object.assign(app, previous);
    }
  });

  it("sends the same words from another card's sheet as their own message, and tags Rivet's own chat with its card's PR", async () => {
    const previous = { workers: app.workers, workersAt: app.workersAt, status: app.status };
    let release = (_: Response) => {};
    const held = new Promise<Response>((resolve) => (release = resolve));
    try {
      app.status = null;
      app.workersAt = Date.now();
      // The chat carries both cards' PRs, so only the card's own PR tells the two messages apart.
      app.workers = { at: new Date().toISOString(), workers: [{ ...worker, prs: [12, 13] }, { ...worker, id: "h", name: "Rivet", chat: "rivet-main", rivet: true }] };
      const say = async (chat: string, pr: number) => {
        openChatSheet(chat, worker.repo, `card-${pr}`, "feed", pr);
        document.querySelector<HTMLTextAreaElement>(".cmd-text")!.value = "approve this PR";
        document.querySelector<HTMLButtonElement>(".cmd-send-row .primary")!.click();
        await settle();
        closeWorkerSheet();
      };
      // PR #12's message is still out when PR #13's card sends the same words: #13 goes as its own.
      chatAnswer = () => held;
      await say(worker.chat, 12);
      chatAnswer = null;
      await say(worker.chat, 13);
      await say("rivet-main", 14);
      expect(posts.map((post) => post.body.text)).toEqual([
        expect.stringMatching(/\(worker, chat atlas, card's PR #12, PR #13, in example-org\/example-repo\): approve this PR$/),
        expect.stringMatching(/\(worker, chat atlas, card's PR #13, PR #12, in example-org\/example-repo\): approve this PR$/),
        "About PR #14: approve this PR",
      ]);
      expect(new Set(posts.map((post) => post.body.clientId)).size).toBe(3);
    } finally {
      release(json(entry("held", "chat", "queued"), 202));
      closeWorkerSheet();
      Object.assign(app, previous);
    }
  });

  it("updates an unlisted Rivet composer in place and queues its next message through Chat while offline", async () => {
    const previous = { workers: app.workers, workersAt: app.workersAt, status: app.status };
    vi.stubGlobal("SpeechRecognition", class {});
    try {
      app.status = null;
      app.workersAt = Date.now();
      app.workers = { at: new Date().toISOString(), workers: [] };
      openChatSheet("rivet-main", worker.repo, "card-chat", "feed");
      const text = document.querySelector<HTMLTextAreaElement>(".cmd-text")!;
      const mic = document.querySelector(".dictate-mic");
      expect(mic).not.toBeNull();
      text.value = "keep my draft";
      text.focus();
      text.setSelectionRange(2, 6);
      app.workers = { ...app.workers, workers: [{ ...worker, name: "Rivet", chat: "rivet-main", rivet: true }] };
      changed();
      expect(document.querySelector(".cmd-text")).toBe(text);
      expect(document.querySelector(".dictate-mic")).toBe(mic);
      expect(document.activeElement).toBe(text);
      expect(text.value).toBe("keep my draft");
      expect([text.selectionStart, text.selectionEnd]).toEqual([2, 6]);
      expect(text.maxLength).toBe(MAX_CHAT_TEXT);
      expect(text.placeholder).toBe("Ask Rivet anything");
      expect(text.getAttribute("aria-label")).toBe("Message Rivet");
      expect(document.querySelector(".cmd-send .cmd-h")!.textContent).toBe("Message Rivet");
      expect(document.querySelector(".cmd-send .sheet-where")!.textContent).toBe("Goes to Rivet now, in Chat.");
      app.status = { board: { version: 1, updatedAt: null }, bridge: { connected: false, lastSeenAt: null } };
      changed();
      const send = document.querySelector<HTMLButtonElement>(".cmd-send-row .primary")!;
      expect(send.disabled).toBe(false);
      expect(send.textContent).toBe("Send (waits for the Mac)");
      send.click();
      await settle();
      expect(posts.filter((post) => post.url === "/api/chat" || post.url === "/api/actions/send")).toEqual([
        expect.objectContaining({ url: "/api/chat", body: expect.objectContaining({ text: "keep my draft", conversation: null }) }),
      ]);
      expect([...document.querySelectorAll(".cmd-step")].map((step) => step.textContent)).toEqual(["Sent", "Typed in", "Replied"]);
    } finally {
      closeWorkerSheet();
      Object.assign(app, previous);
    }
  });

  it("tags a message about a worker with its chat and PRs for Rivet, and never posts to the chat", async () => {
    openWorkerSheet({ ...worker, prs: [492] });
    const text = document.querySelector<HTMLTextAreaElement>(".cmd-text")!;
    expect(document.querySelector(".cmd-send .cmd-h")!.textContent).toBe("Message Rivet about Atlas");
    expect(text.placeholder).toBe("What should Atlas do?");
    text.value = "rebase please";
    document.querySelector<HTMLButtonElement>(".cmd-send-row .primary")!.click();
    await settle();
    expect(posts.map((post) => [post.url, post.body.text, post.body.conversation])).toEqual([
      ["/api/chat", "About “Atlas” (worker, chat atlas, PR #492, in example-org/example-repo): rebase please", null],
    ]);
    expect(text.value).toBe("");
    expect([...document.querySelectorAll(".cmd-step")].map((step) => step.textContent)).toEqual(["Sent", "Typed in", "Replied"]);
  });

  it("retries a lost answer with the same clientId", async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    vi.mocked(fetch).mockImplementation((input, init = {}) => {
      const url = String(input);
      if (init.method === "POST" && url === "/api/chat") {
        sent.push({ url, body: JSON.parse(String(init.body)) });
        // The server accepted the first send but its response never arrived.
        if (sent.length === 1) return Promise.reject(new TypeError("Response lost"));
        return Promise.resolve(json(entry("accepted-chat", "chat", "queued"), 202));
      }
      return fakeFetch(input, init);
    });
    try {
      openWorkerSheet(worker);
      const text = document.querySelector<HTMLTextAreaElement>(".cmd-text")!;
      const send = document.querySelector<HTMLButtonElement>(".cmd-send-row .primary")!;
      text.value = "uncertain delivery";
      send.click();
      await settle();
      expect(text.value).toBe("uncertain delivery");
      send.click();
      await settle();
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual(sent[0]);
      expect(text.value).toBe("");
    } finally {
      closeWorkerSheet();
    }
  });

  it("retries a lost answer as the tagged text it first went as, though the chat's PRs changed since", async () => {
    const previous = { workers: app.workers, workersAt: app.workersAt };
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    vi.mocked(fetch).mockImplementation((input, init = {}) => {
      const url = String(input);
      if (init.method === "POST" && url === "/api/chat") {
        sent.push({ url, body: JSON.parse(String(init.body)) });
        if (sent.length === 1) return Promise.resolve(json({ error: "busy" }, 503));
        return Promise.resolve(json(entry("accepted-chat", "chat", "queued"), 202));
      }
      return fakeFetch(input, init);
    });
    try {
      app.workersAt = Date.now();
      app.workers = { at: new Date().toISOString(), workers: [{ ...worker, prs: [1] }] };
      openWorkerSheet({ ...worker, prs: [1] });
      const text = document.querySelector<HTMLTextAreaElement>(".cmd-text")!;
      const send = document.querySelector<HTMLButtonElement>(".cmd-send-row .primary")!;
      text.value = "rebase please";
      send.click();
      await settle();
      app.workers = { ...app.workers, workers: [{ ...worker, prs: [1, 2] }] };
      changed();
      send.click();
      await settle();
      expect(sent.map((one) => [one.body.clientId, one.body.text])).toEqual([
        [sent[0]!.body.clientId, "About “Atlas” (worker, chat atlas, PR #1, in example-org/example-repo): rebase please"],
        [sent[0]!.body.clientId, "About “Atlas” (worker, chat atlas, PR #1, in example-org/example-repo): rebase please"],
      ]);
      expect(text.value).toBe("");
    } finally {
      closeWorkerSheet();
      Object.assign(app, previous);
    }
  });

  it("tags every PR a chat lists or delivers, and the card's PR on a chat opened from the Feed", async () => {
    const previous = { workers: app.workers, workersAt: app.workersAt };
    try {
      app.workersAt = Date.now();
      app.workers = { at: new Date().toISOString(), workers: [] };
      const say = async (words: string) => {
        document.querySelector<HTMLTextAreaElement>(".cmd-text")!.value = words;
        document.querySelector<HTMLButtonElement>(".cmd-send-row .primary")!.click();
        await settle();
        closeWorkerSheet();
      };
      const delivering: Worker = { ...worker, prs: [10], delivering: { pr: 11, title: "Faces", stage: "building" } as Worker["delivering"] };
      app.workers = { at: new Date().toISOString(), workers: [delivering] };
      openWorkerSheet(delivering);
      await say("go");
      app.workers = { at: new Date().toISOString(), workers: [] };
      openChatSheet(worker.chat, worker.repo, "card-x", "feed", 12);
      await say("look at the card");
      expect(posts.filter((post) => post.url === "/api/chat").map((post) => post.body.text)).toEqual([
        "About “Atlas” (worker, chat atlas, PRs #10 #11, in example-org/example-repo): go",
        "About “atlas” (worker, chat atlas, card's PR #12, in example-org/example-repo): look at the card",
      ]);
    } finally {
      closeWorkerSheet();
      Object.assign(app, previous);
    }
  });

  it("keeps a message too long once tagged, says by how much, and sends nothing", async () => {
    try {
      openWorkerSheet(worker);
      const text = document.querySelector<HTMLTextAreaElement>(".cmd-text")!;
      text.value = "x".repeat(MAX_CHAT_TEXT);
      document.querySelector<HTMLButtonElement>(".cmd-send-row .primary")!.click();
      await settle();
      expect(posts.filter((post) => post.url === "/api/chat")).toEqual([]);
      expect(text.value).toBe("x".repeat(MAX_CHAT_TEXT));
      expect(document.querySelector(".cmd-send .cmd-meta")!.textContent).toBe(
        `Not sent: ${"About “Atlas” (worker, chat atlas, in example-org/example-repo): ".length} characters too long with the chat's tag. Shorten it and send again.`,
      );
    } finally {
      closeWorkerSheet();
    }
  });

  it.each(["success", "lost"] as const)("shares a pending send across reopened sheets and gives both the same %s outcome", async (outcome) => {
    const previous = { workers: app.workers, workersAt: app.workersAt, status: app.status };
    const body = `overlapping delivery ${outcome}`;
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    let resolve!: (response: Response) => void;
    let reject!: (error: Error) => void;
    vi.mocked(fetch).mockImplementation((input, init = {}) => {
      const url = String(input);
      if (init.method === "POST" && url === "/api/chat") {
        sent.push({ url, body: JSON.parse(String(init.body)) });
        if (sent.length === 1) return new Promise((yes, no) => { resolve = yes; reject = no; });
        return Promise.resolve(json(entry("shared-chat", "chat", "queued"), 202));
      }
      return fakeFetch(input, init);
    });
    try {
      app.status = null;
      app.workersAt = Date.now();
      app.workers = { at: new Date().toISOString(), workers: [] };
      const send = () => document.querySelector<HTMLButtonElement>(".cmd-send-row .primary")!;
      openChatSheet("rivet-main", worker.repo, "card-chat", "feed");
      const first = document.querySelector<HTMLTextAreaElement>(".cmd-text")!;
      first.value = body;
      first.dispatchEvent(new Event("input", { bubbles: true }));
      send().click();
      expect(sent).toHaveLength(1);
      closeWorkerSheet();
      openChatSheet("rivet-main", worker.repo, "card-chat", "feed");
      const second = document.querySelector<HTMLTextAreaElement>(".cmd-text")!;
      second.value = body;
      second.dispatchEvent(new Event("input", { bubbles: true }));
      send().click();
      expect(send().disabled).toBe(true);
      expect(sent).toHaveLength(1);
      if (outcome === "success") resolve(json(entry("shared-chat", "chat", "queued"), 202));
      else reject(new TypeError("Response lost"));
      await settle();
      expect(send().disabled).toBe(false);
      expect([first.value, second.value]).toEqual(outcome === "success" ? ["", ""] : [body, body]);
      if (outcome === "lost") {
        send().click();
        await settle();
        expect(sent).toHaveLength(2);
        expect(sent[1]).toEqual(sent[0]);
        expect(second.value).toBe("");
      }
    } finally {
      closeWorkerSheet();
      Object.assign(app, previous);
    }
  });

  it("puts the message box first, then the facts, above the live log, with a compact footer and no Pause", () => {
    openWorkerSheet(worker);
    const scroll = document.querySelector(".cmd-worker-sheet .cmd-worker-scroll")!;
    expect([...scroll.children].map((child) => child.className)).toEqual(["cmd-send", "scene-facts", "cmd-log-head", expect.stringContaining("cmd-log")]);
    expect(scroll.querySelector(".cmd-send .cmd-h")!.textContent).toBe("Message Rivet about Atlas");
    expect([...document.querySelectorAll(".cmd-worker-sheet button")].map((b) => b.textContent)).not.toContain("Pause");
    const foot = document.querySelector(".cmd-worker-sheet > .cmd-worker-foot")!;
    expect([...foot.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Close"]);
  });

  it("shows the live log as a feed, newest first with its time, and Show raw brings back the redacted lines", async () => {
    const lines = ["⏺ Bash(pnpm test)", "⎿  $ pnpm test", "⏺ Updated 19 pages.", "✶ Enchanting… (4m 44s · ↓ 11.2k tokens)", "⏺ Reporting to rivet-main."];
    const times = [null, null, null, "2026-10-26T06:53:00.000Z", "2026-10-26T06:53:00.000Z"];
    const logs = vi.spyOn(cmd, "getLogsIfChanged").mockResolvedValue({ logs: { repo: worker.repo, chat: worker.chat, lines, times, updatedAt: null, leaseUntil: null, feed: logFeed(lines, times) }, etag: null });
    const subscribe = vi.spyOn(cmd, "subscribeLogs").mockResolvedValue({ leaseUntil: "later" });
    try {
      openWorkerSheet(worker);
      await settle();
      await settle();
      const box = document.querySelector<HTMLElement>(".cmd-log")!;
      const rows = [...box.querySelectorAll(".cmd-feed-item")].map((row) => [row.querySelector(".cmd-feed-time")!.textContent, row.querySelector(".cmd-feed-text")!.textContent]);
      expect(rows).toEqual([[when("2026-10-26T06:53:00.000Z"), "Reporting to rivet-main."], ["Earlier", "Updated 19 pages."]]);
      expect(box.textContent).not.toContain("pnpm");
      const toggle = document.querySelector<HTMLButtonElement>(".cmd-log-raw")!;
      toggle.click();
      expect(box.classList.contains("is-raw")).toBe(true);
      expect(box.textContent).toBe(lines.join("\n"));
      expect([toggle.textContent, toggle.getAttribute("aria-pressed")]).toEqual(["Show feed", "true"]);
      toggle.click();
      expect(box.querySelectorAll(".cmd-feed-item")).toHaveLength(2);
    } finally {
      closeWorkerSheet();
      logs.mockRestore();
      subscribe.mockRestore();
    }
  });

  it("a second tap on Send while the first is in flight sends nothing", async () => {
    openWorkerSheet(worker);
    document.querySelector<HTMLTextAreaElement>(".cmd-text")!.value = "run the tests";
    const send = [...document.querySelectorAll<HTMLButtonElement>(".cmd-send button")].find((b) => b.textContent === "Send")!;
    send.click();
    send.click();
    await settle();
    expect(posts.filter((p) => p.url === "/api/chat")).toHaveLength(1);
  });

  it("Rivet's box goes through the Chat path and shows sent, typed, then replied", async () => {
    openWorkerSheet({ ...worker, id: "h", name: "Rivet", chat: "rivet-main", rivet: true });
    expect(document.querySelector(".cmd-send .cmd-h")!.textContent).toBe("Message Rivet");
    document.querySelector<HTMLTextAreaElement>(".cmd-text")!.value = "how is Search Page?";
    [...document.querySelectorAll<HTMLButtonElement>(".cmd-send button")].find((b) => b.textContent === "Send")!.click();
    await settle();
    expect(posts.map((p) => [p.url, p.body.text, p.body.conversation])).toEqual([["/api/chat", "how is Search Page?", null]]);
    const on = () => [...document.querySelectorAll(".cmd-step.is-on")].map((step) => step.textContent);
    expect(on()).toEqual(["Sent"]);
    actions["msg-1"] = entry("msg-1", "chat", "typed");
    await new Promise((resolve) => setTimeout(resolve, 700));
    await settle();
    expect(on()).toEqual(["Sent", "Typed in"]);
    actions["msg-1"] = entry("msg-1", "chat", "replied", { updatedAt: new Date(Date.now() + 1000).toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 2600));
    await settle();
    expect(on()).toEqual(["Sent", "Typed in", "Replied"]);
    expect(document.querySelector(".cmd-send [role=status]")!.textContent).toContain("Rivet replied");
  });

  it("offline Rivet still takes a message; the Mac gets it when the bridge is back", () => {
    openWorkerSheet({ ...worker, id: "h", name: "Rivet", chat: "rivet-main", rivet: true }, { offline: true });
    expect(document.querySelector(".cmd-send .cmd-h")!.textContent).toBe("Message Rivet");
    expect(document.querySelector(".cmd-pause")).toBeNull();
    closeWorkerSheet();
    openWorkerSheet(worker, { offline: true });
    expect(document.querySelector(".cmd-send")).toBeNull();
    // Only Close would be left: Discuss this starts a Rivet message about the worker instead.
    localStorage.removeItem("rivet.chat.draft");
    const foot = document.querySelector(".cmd-worker-foot")!;
    expect([...foot.querySelectorAll("button")].map((btn) => btn.textContent)).toEqual(["Discuss this", "Close"]);
    foot.querySelector<HTMLButtonElement>(".discuss-this")!.click();
    expect(document.querySelector(".cmd-worker-sheet")).toBeNull();
    expect(localStorage.getItem("rivet.chat.draft")).toBe("About “Atlas” (worker, chat atlas, in example-org/example-repo): ");
    openWorkerSheet({ ...worker, prs: [282], repo: "example-org/quote" }, { offline: true });
    document.querySelector<HTMLButtonElement>(".cmd-worker-foot .discuss-this")!.click();
    expect(localStorage.getItem("rivet.chat.draft")).toMatch(/^About “Atlas” \(worker, chat atlas, PR #282, in example-org\/quote\): /);
  });
});

describe("card media", () => {
  const ref = (c: string, type: "video/mp4" | "image/jpeg" = "video/mp4") => ({ sha256: c.repeat(64), type });

  it("renders muted inline before and after clips with a phone toggle, reused across renders", () => {
    const media = { kind: "before-after" as const, before: ref("a"), after: ref("b"), poster: ref("c", "image/jpeg") };
    const block = cardMedia("n1", media)!;
    const videos = [...block.querySelectorAll("video")];
    expect(videos).toHaveLength(2);
    for (const video of videos) {
      expect(video.muted).toBe(true);
      expect(video.hasAttribute("playsinline")).toBe(true);
      expect(video.getAttribute("poster")).toBe(`/media/${"c".repeat(64)}`);
      expect(video.getAttribute("preload")).toBe("none");
    }
    expect(videos[0]!.getAttribute("src")).toBe(`/media/${"a".repeat(64)}`);
    expect(block.classList.contains("show-after")).toBe(true);
    const [before] = [...block.querySelectorAll<HTMLButtonElement>(".media-toggle")];
    before!.click();
    expect(block.classList.contains("show-before")).toBe(true);
    expect(block.classList.contains("show-after")).toBe(false);
    document.body.append(block);
    expect(cardMedia("n1", media)).toBe(block);
    expect(cardMedia("n1", undefined)).toBeNull();
  });

  it("an image pair gets the same Before/After toggle, without play controls", () => {
    const block = cardMedia("n3", { kind: "before-after", before: ref("e", "image/jpeg"), after: ref("f", "image/jpeg") })!;
    expect(block.querySelectorAll("video")).toHaveLength(0);
    expect(block.querySelectorAll("img")).toHaveLength(2);
    const toggles = [...block.querySelectorAll<HTMLButtonElement>(".media-toggle")];
    expect(toggles.map((b) => b.textContent)).toEqual(["Before", "After"]);
    toggles[0]!.click();
    expect(block.classList.contains("show-before")).toBe(true);
    expect(block.querySelector(".media-play")).toBeNull();
  });

  it("a single clip has no toggle", () => {
    const block = cardMedia("n2", { kind: "video", after: ref("d") })!;
    expect(block.querySelectorAll("video")).toHaveLength(1);
    expect(block.querySelector(".media-toggles")).toBeNull();
  });
});

describe("sorting a pick", () => {
  it("sends a photo the picker gave no image type down the photo path, by its extension", () => {
    expect(sortPick(new File(["x"], "IMG_1.JPG", { type: "" }))).toEqual({ kind: "photo" });
    expect(sortPick(new File(["x"], "shot.png", { type: "application/octet-stream" }))).toEqual({ kind: "photo" });
    expect(sortPick(new File(["x"], "plan.pdf", { type: "" }))).toEqual({ kind: "file" });
    expect(sortPick(new File(["x"], "page.html", { type: "" }))).toMatchObject({ kind: "refused" });
  });

  it("sends a GIF as it is, a HEIC or a WebP as a photo, a ZIP or a model up to 100 MB, and never an SVG", () => {
    expect(sortPick(new File(["x"], "20261006_075301.heic", { type: "image/heic" }))).toEqual({ kind: "photo" });
    expect(sortPick(new File(["x"], "IMG_2.HEIF", { type: "" }))).toEqual({ kind: "photo" });
    expect(sortPick(new File(["x"], "dance.gif", { type: "image/gif" }))).toEqual({ kind: "file" });
    expect(sortPick(new File(["x"], "sticker.webp", { type: "image/webp" }))).toEqual({ kind: "photo" });
    expect(sortPick(new File(["x"], "voice-20261006-0001.opus", { type: "" }))).toEqual({ kind: "file" });
    expect(sortPick(new File(["x"], "take.flac", { type: "audio/flac" }))).toEqual({ kind: "file" });
    expect(sortPick(new File(["x"], "art.zip", { type: "application/zip" }))).toEqual({ kind: "file" });
    expect(sortPick(new File(["x"], "monkey.glb", { type: "" }))).toEqual({ kind: "file" });
    const big = (name: string) => {
      const file = new File(["x"], name);
      Object.defineProperty(file, "size", { value: 100 * 1024 * 1024 + 1 });
      return file;
    };
    expect(sortPick(big("art.zip"))).toEqual({ kind: "refused", reason: "That file is over 100 MB. Send a smaller one." });
    expect(sortPick(big("note.ogg"))).toEqual({ kind: "refused", reason: "That video or sound file is over 100 MB. Send a shorter one." });
    expect(sortPick(new File(["x"], "logo.svg", { type: "" }))).toMatchObject({ kind: "refused" });
    expect(ACCEPT.split(",")).toEqual(expect.arrayContaining([".heic", ".heif", ".gif", ".ogg", ".opus", ".flac", ".zip", ".glb", "image/heic", "audio/ogg", "model/gltf-binary"]));
    expect(ACCEPT).not.toMatch(/svg/);
  });

  it("sends an email as a file up to 25 MB, and the picker offers it", () => {
    expect(sortPick(new File(["x"], "Logo from Sam.eml", { type: "message/rfc822" }))).toEqual({ kind: "file" });
    expect(sortPick(new File(["x"], "Invoice.MSG", { type: "" }))).toEqual({ kind: "file" });
    const big = new File(["x"], "big.eml");
    Object.defineProperty(big, "size", { value: 25 * 1024 * 1024 + 1 });
    expect(sortPick(big)).toEqual({ kind: "refused", reason: "That file is over 25 MB. Send a smaller one." });
    expect(ACCEPT.split(",")).toEqual(expect.arrayContaining([".eml", ".msg", "message/rfc822", "application/vnd.ms-outlook"]));
  });
});
