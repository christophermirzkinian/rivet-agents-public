import { createHash } from "node:crypto";
import { UPDATES_ID } from "../src/shared/conversations.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BATCH_CAP_MS, BATCH_MAX_TEXT, BATCH_QUIET_MS, CommandStore } from "../src/server/commandstore.js";
import { HttpError } from "../src/server/httputil.js";
import { LOG_LEASE_MS, LogLeases } from "../src/server/logs.js";
import { MAX_TEXT_UPLOADS, MediaStore, parseRange, pdfDisposition, sniffMedia } from "../src/server/media.js";
import { rivetPayload } from "../src/server/push.js";
import { actionAckSchema, chatImages as chatImagesOf, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_TEXT, type AuditEntry, type ChatMessage, type ChatPage } from "../src/shared/command.js";
import { rankSearch, type SearchItem } from "../src/shared/search.js";
import type { SnapshotWorker } from "../src/shared/workers.js";
import {
  bearer,
  BOARD_TOKEN,
  BRIDGE_TOKEN,
  browser,
  EXAMPLE_BOARD,
  fakeClock,
  oversizedStatus,
  putBoard,
  rawGet,
  revOf,
  startServer,
  waitForStatus,
  type TestServer,
} from "./helpers.js";

const MS = "example-org/example-repo";

let server: TestServer;
let cookie: string;
let clock: ReturnType<typeof fakeClock>;

beforeEach(async () => {
  clock = fakeClock();
  server = await startServer({}, { now: clock.now });
  cookie = server.cookie();
  await putBoard(server.base);
});

afterEach(async () => {
  await server.close();
});

let seq = 0;
const clientId = () => `client-${Date.now()}-${(seq += 1)}`;

const post = (path: string, body: unknown, headers: Record<string, string> = browser(cookie)) =>
  fetch(`${server.base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

async function liveWorker(chat = "checkout-feedback"): Promise<void> {
  const worker: SnapshotWorker = {
    worktreeId: createHash("sha256").update(`${MS}/${chat}`).digest("hex").slice(0, 16),
    repo: MS,
    chat,
    connected: true,
    lastOutputAt: Date.now(),
    agent: "claude",
  };
  const response = await fetch(`${server.base}/api/bridge/workers`, { method: "PUT", headers: bearer(BRIDGE_TOKEN), body: JSON.stringify({ workers: [worker] }) });
  expect(response.status).toBe(200);
}

interface Stream {
  events(): { event: string; id: string; data: Record<string, unknown> }[];
  waitFor(count: number): Promise<void>;
  abort(): void;
}

async function connectBridge(features: string | null = "image,chat-window"): Promise<Stream> {
  const controller = new AbortController();
  const headers = { ...bearer(BRIDGE_TOKEN), ...(features === null ? {} : { "x-rivet-bridge-features": features }) };
  const response = await fetch(`${server.base}/api/bridge/events`, { headers, signal: controller.signal });
  expect(response.status).toBe(200);
  let buffer = "";
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
      }
    } catch {}
  })();
  const events = () =>
    buffer
      .split("\n\n")
      .filter((block) => block.startsWith("event:"))
      .map((block) => {
        const fields = Object.fromEntries(block.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]));
        return { event: fields.event!, id: fields.id!, data: JSON.parse(fields.data!) as Record<string, unknown> };
      });
  const waitFor = async (count: number) => {
    for (let i = 0; i < 200 && events().length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events().length).toBeGreaterThanOrEqual(count);
  };
  return { events, waitFor, abort: () => controller.abort() };
}

describe("every action needs a session, CSRF and a clientId", () => {
  const actions: [string, () => Record<string, unknown>][] = [
    ["/api/chat", () => ({ clientId: clientId(), text: "hello" })],
    ["/api/logs/subscribe", () => ({ repo: MS, chat: "checkout-feedback" })],
    ["/api/logs/release", () => ({ repo: MS, chat: "checkout-feedback" })],
  ];

  it.each(actions)("%s refuses a missing session, a bad Origin and a missing header", async (path, body) => {
    const { cookie: _, ...noCookie } = browser(cookie);
    expect((await post(path, body(), noCookie)).status).toBe(401);
    expect((await post(path, body(), { ...browser(cookie), origin: "https://evil.example" })).status).toBe(403);
    const { "x-rivet": __, ...noHeader } = browser(cookie);
    expect((await post(path, body(), noHeader)).status).toBe(403);
    expect((await post(path, body(), { ...browser("__Host-rivet=forged") })).status).toBe(401);
    expect((await post(path, body(), bearer(BOARD_TOKEN))).status).toBe(403);
  });

  it("refuses an action without a clientId or with extra fields", async () => {
    expect((await post("/api/chat", { text: "hello" })).status).toBe(400);
    expect((await post("/api/chat", { clientId: "x y", text: "hello" })).status).toBe(400);
    expect((await post("/api/chat", { clientId: clientId(), text: "hello", args: ["--admin"] })).status).toBe(400);
  });

  it("an identical clientId retry returns the same action; a different one is a 409", async () => {
    const id = clientId();
    const first = await post("/api/chat", { clientId: id, text: "ship it" });
    expect(first.status).toBe(202);
    const entry = (await first.json()) as AuditEntry;
    const again = await post("/api/chat", { clientId: id, text: "ship it" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as AuditEntry).id).toBe(entry.id);
    expect((await post("/api/chat", { clientId: id, text: "something else" })).status).toBe(409);
    const page = (await (await fetch(`${server.base}/api/chat`, { headers: { cookie } })).json()) as ChatPage;
    expect(page.messages.filter((message) => message.text === "ship it")).toHaveLength(1);
  });

  it("writes every action to the audit log", async () => {
    await post("/api/chat", { clientId: clientId(), text: "one" });
    expect((await fetch(`${server.base}/api/audit`)).status).toBe(401);
    const { entries } = (await (await fetch(`${server.base}/api/audit`, { headers: { cookie } })).json()) as { entries: AuditEntry[] };
    expect(entries.map((entry) => [entry.kind, entry.status])).toEqual([["chat", "collecting"]]);
  });
});

describe("chat", () => {
  it("queues for the bridge, then shows typed and replied", async () => {
    const response = await post("/api/chat", { clientId: clientId(), text: "What's next?" });
    const entry = (await response.json()) as AuditEntry;
    const stream = await connectBridge();
    clock.advance(BATCH_QUIET_MS);
    await stream.waitFor(1);
    expect(stream.events()[0]).toMatchObject({ event: "chat", id: entry.id, data: { id: entry.id, text: "What's next?" } });

    const ack = await fetch(`${server.base}/api/bridge/action-ack`, { method: "POST", headers: bearer(BRIDGE_TOKEN), body: JSON.stringify({ id: entry.id, status: "typed" }) });
    expect(ack.status).toBe(200);
    let page = (await (await fetch(`${server.base}/api/chat`, { headers: { cookie } })).json()) as ChatPage;
    expect(page.messages.find((message) => message.id === entry.id)?.status).toBe("typed");

    const say = await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ text: "Docs refresh next.", replyTo: entry.id }) });
    expect(say.status).toBe(201);
    page = (await (await fetch(`${server.base}/api/chat`, { headers: { cookie } })).json()) as ChatPage;
    expect(page.messages.map((message: ChatMessage) => [message.from, message.text, message.status])).toEqual([
      ["owner", "What's next?", "replied"],
      ["rivet", "Docs refresh next.", undefined],
    ]);
    stream.abort();
  });

  it("an ack is the status line on your message: no bubble, no unread, no push; on anything else it is a reply", async () => {
    const notify = vi.spyOn(server.app.push, "notify");
    const entry = (await (await post("/api/chat", { clientId: clientId(), text: "Podium in logo gold?" })).json()) as AuditEntry;
    clock.advance(BATCH_QUIET_MS);
    const say = (body: object) => fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) });
    expect((await say({ replyTo: entry.id, ack: "building it, ~9:45", text: "x" })).status).toBe(400);
    expect((await say({ ack: "building it" })).status).toBe(400);
    const acked = await say({ replyTo: entry.id, ack: "building it, ~9:45" });
    expect(acked.status).toBe(200);
    expect(((await acked.json()) as ChatMessage).ack?.text).toBe("building it, ~9:45");
    expect((await say({ replyTo: entry.id, ack: "PR up, ~10:10" })).status).toBe(200);
    let page = (await (await fetch(`${server.base}/api/chat`, { headers: { cookie } })).json()) as ChatPage;
    expect(page.messages.map((message) => [message.from, message.text, message.status, message.ack?.text])).toEqual([["owner", "Podium in logo gold?", "replied", "PR up, ~10:10"]]);
    expect(notify).not.toHaveBeenCalled();
    notify.mockRestore();
    // An ack on Rivet's own line, or on no message, is refused: never a bubble.
    const reply = (await (await say({ replyTo: entry.id, text: "Done." })).json()) as ChatMessage;
    expect((await say({ replyTo: reply.id, ack: "on it" })).status).toBe(400);
    expect((await say({ replyTo: "no-such", ack: "on it" })).status).toBe(400);
    page = (await (await fetch(`${server.base}/api/chat`, { headers: { cookie } })).json()) as ChatPage;
    expect(page.messages.map((message) => message.text)).toEqual(["Podium in logo gold?", "Done."]);
  });

  it("the stream re-checks the session and closes after logout", async () => {
    const controller = new AbortController();
    const response = await fetch(`${server.base}/api/chat/stream`, { headers: { cookie }, signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const ended = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return true;
        text += decoder.decode(value, { stream: true });
      }
    })();
    const say = (words: string) => fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ text: words, new: true }) });
    expect((await say("first")).status).toBe(201);
    for (let i = 0; i < 100 && !text.includes("first"); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(text).toContain("first");
    expect((await post("/api/auth/logout", {})).status).toBe(200);
    expect((await say("after logout")).status).toBe(201);
    await expect(Promise.race([ended, new Promise((resolve) => setTimeout(() => resolve("still open"), 2_000))])).resolves.toBe(true);
    expect(text).not.toContain("after logout");
    controller.abort();
  });

  it("pages history oldest first with an older cursor", async () => {
    for (let i = 0; i < 5; i += 1) {
      await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ text: `m${i}`, new: true }) });
    }
    const first = (await (await fetch(`${server.base}/api/chat?limit=2`, { headers: { cookie } })).json()) as ChatPage;
    expect(first.messages.map((message) => message.text)).toEqual(["m3", "m4"]);
    expect(first.older).toBeTruthy();
    const second = (await (await fetch(`${server.base}/api/chat?limit=2&before=${first.older}`, { headers: { cookie } })).json()) as ChatPage;
    expect(second.messages.map((message) => message.text)).toEqual(["m1", "m2"]);
    expect((await fetch(`${server.base}/api/chat?before=..%2F`, { headers: { cookie } })).status).toBe(400);
  });

  it("bounds the say endpoint", async () => {
    const say = (body: unknown, headers = bearer(BOARD_TOKEN)) =>
      fetch(`${server.base}/api/bridge/say`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
    expect((await say({ text: "hi" }, bearer(BRIDGE_TOKEN))).status).toBe(401);
    expect((await say({ text: "hi" }, { "content-type": "application/json" })).status).toBe(401);
    expect((await say({ text: "hi" }, browser(cookie))).status).toBe(401);
    expect((await say({ text: "" })).status).toBe(400);
    expect((await say({ text: "   " })).status).toBe(400);
    expect((await say({ text: "x".repeat(4001) })).status).toBe(400);
    expect((await say({ text: "x".repeat(4000) })).status).toBe(201);
    expect((await say({ text: "hi", replyTo: "../../etc" })).status).toBe(400);
    expect((await say({ text: "hi", extra: 1 })).status).toBe(400);
    expect((await say({ text: 42 })).status).toBe(400);
    expect((await say("not json")).status).toBe(400);
    expect(await oversizedStatus(say(JSON.stringify({ text: "x".repeat(70_000) })))).toBe(413);
    // A card answer replies to a message; a tag or thread goes on a card only, within the card's caps.
    expect((await say({ text: "hi", card: true })).status).toBe(400);
    expect((await say({ text: "hi", replyTo: "m-1", tag: "Deployed" })).status).toBe(400);
    expect((await say({ text: "hi", new: true, thread: "Docs Sync" })).status).toBe(400);
    expect((await say({ text: "hi", tag: "x".repeat(41) })).status).toBe(400);
    expect((await say({ text: "hi", thread: "x".repeat(81) })).status).toBe(400);
    expect((await say({ text: "hi", tag: "  " })).status).toBe(400);
    expect((await say({ text: "hi", card: false, replyTo: "m-1" })).status).toBe(400);
    // A PR goes on an outcome card only; a repo only with its PR, and only a well-formed one.
    expect((await say({ text: "hi", pr: 6500 })).status).toBe(400);
    expect((await say({ text: "hi", replyTo: "m-1", pr: 6500 })).status).toBe(400);
    expect((await say({ text: "hi", replyTo: "m-1", card: true, repo: "example-org/third-repo" })).status).toBe(400);
    expect((await say({ text: "hi", replyTo: "m-1", card: true, pr: 0 })).status).toBe(400);
    expect((await say({ text: "hi", replyTo: "m-1", card: true, pr: 1, repo: "someone/else/extra" })).status).toBe(400);
    expect((await say({ text: "hi", tag: "Deployed", thread: "Docs Sync" })).status).toBe(201);
  });

  it("searches the whole chat history for the header search", async () => {
    for (const text of ["the kiosk is ready", "nothing here", "Kiosk at eight"]) {
      await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ text, new: true }) });
    }
    const response = await fetch(`${server.base}/api/chat/search?q=kiosk`, { headers: { cookie } });
    const { results } = (await response.json()) as { results: SearchItem[] };
    expect(results.map((item) => item.title)).toEqual(["Kiosk at eight", "the kiosk is ready"]);
    expect(results[0]).toMatchObject({ kind: "message", detail: "Rivet in Kiosk at eight", open: { type: "message", id: results[0]!.key.slice("message:".length) } });
    expect((await fetch(`${server.base}/api/chat/search?q=kiosk`)).status).toBe(401);
  });

  it("chat search finds stored old-name words by the name you read", async () => {
    // Words, not one long run of a letter, which the server's redactor reads as a token.
    const WORDS = "xxxxxxxxx ".repeat(30).trimEnd();
    await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ text: "Rivet Ops has a new card", new: true, title: "Rivet Ops hold" }) });
    await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ text: `${WORDS} Rivet Ops is ready`, new: true, title: "Maintenance" }) });
    const { results } = (await (await fetch(`${server.base}/api/chat/search?q=rivet%20ops`, { headers: { cookie } })).json()) as { results: SearchItem[] };
    expect(results.map((item) => [item.key.split(":")[0], item.title])).toEqual([
      ["conversation", "Rivet Ops hold"],
      ["message", `…${WORDS.slice(-99)} Rivet Ops is ready`],
      ["message", "Rivet Ops has a new card"],
    ]);
  });

  it("chat search finds a conversation by its title first, opening it by its first message", async () => {
    const said = await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ text: "Coals are lit", new: true, title: "Grill night" }) });
    const { id } = (await said.json()) as { id: string };
    await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ text: "grill is hot", replyTo: id }) });
    const { results } = (await (await fetch(`${server.base}/api/chat/search?q=grill`, { headers: { cookie } })).json()) as { results: SearchItem[] };
    expect(results.map((item) => [item.key.split(":")[0], item.title, item.detail])).toEqual([
      ["conversation", "Grill night", "Conversation"],
      ["message", "grill is hot", "Rivet in Grill night"],
    ]);
    expect(results[0]!.open).toEqual({ type: "message", id });
  });

  it("chat search returns a snippet around a match past the first 120 characters, which the header ranking keeps", async () => {
    // Words, not one long run of a letter, which the server's redactor reads as a token.
    const middle = `${"aaaaaaaaa ".repeat(30).trimEnd()} the lamb sketcher recipe ${"bbbbbbbbb ".repeat(30).trimEnd()}`;
    const tail = `${"ccccccccc ".repeat(40).trimEnd()} Zucchini`;
    for (const text of [middle, tail]) {
      await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ text, new: true }) });
    }
    const search = async (q: string) =>
      ((await (await fetch(`${server.base}/api/chat/search?q=${encodeURIComponent(q)}`, { headers: { cookie } })).json()) as { results: SearchItem[] }).results;
    const sketcher = await search("lamb sketcher");
    expect(sketcher).toHaveLength(1);
    expect(sketcher[0]!.title).toMatch(/^…[a ]+ the lamb sketcher recipe [b ]+…$/);
    expect(Array.from(sketcher[0]!.title).length).toBeLessThanOrEqual(120);
    expect(rankSearch(sketcher, "lamb sketcher", Date.now())).toHaveLength(1);
    const zucchini = await search("zucchini");
    expect(zucchini[0]!.title).toMatch(/^…[c ]+ Zucchini$/);
    expect(Array.from(zucchini[0]!.title).length).toBeLessThanOrEqual(120);
    expect(rankSearch(zucchini, "zucchini", Date.now())).toHaveLength(1);
  });

  it("a reply goes out through the quiet-hours push with its own key", async () => {
    const notify = vi.spyOn(server.app.push, "notify");
    const said = await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ text: "done", new: true }) });
    const message = (await said.json()) as ChatMessage;
    expect(notify).toHaveBeenCalledWith(rivetPayload("done", { id: message.id, title: "done" }), "card", `rivet:${message.id}`);
    // Updates, where a reply to an id the server does not know still lands, is FYI.
    expect(rivetPayload("done", { id: UPDATES_ID, title: "Updates" })).toMatchObject({ level: "fyi", tag: "conv-updates", chat: "updates", path: "/?conversation=updates" });
    notify.mockRestore();
  });

  it("a reply still pushes while a chat stream is open, so a background window never mutes the phone", async () => {
    const notify = vi.spyOn(server.app.push, "notify");
    const controller = new AbortController();
    const open = await fetch(`${server.base}/api/chat/stream`, { headers: { cookie }, signal: controller.signal });
    expect(open.status).toBe(200);
    const said = await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ text: "still here", new: true }) });
    const message = (await said.json()) as ChatMessage;
    expect(notify).toHaveBeenCalledWith(rivetPayload("still here", { id: message.id, title: "still here" }), "card", `rivet:${message.id}`);
    controller.abort();
    notify.mockRestore();
  });

  it("a reply stores, returns and sends the id it answers with who wrote that and its first line", async () => {
    const say = async (body: object) =>
      (await (await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) })).json()) as ChatMessage;
    // The old Updates conversation is read-only: a reply to its line, or a line typed in it, is refused.
    const news = await say({ text: "Nightly: green.", replyTo: "unknown-id" });
    expect(news.threadId).toBe(UPDATES_ID);
    const refused = await post("/api/chat", { clientId: clientId(), text: "hi", replyTo: news.id });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/Updates is read-only/);
    expect((await post("/api/chat", { clientId: clientId(), text: "hi", conversation: news.id })).status).toBe(409);
    const said = await say({ text: `Photo Album is live.\n${"x".repeat(300)}`, new: true, title: "Photo Album" });
    expect((await post("/api/chat", { clientId: clientId(), text: "hi", replyTo: "../x" })).status).toBe(400);
    expect((await post("/api/chat", { clientId: clientId(), text: "hi", replyTo: "not-a-message" })).status).toBe(400);
    const id = clientId();
    const response = await post("/api/chat", { clientId: id, text: "Send the video", replyTo: said.id });
    expect(response.status).toBe(202);
    const entry = (await response.json()) as AuditEntry;
    const quote = { from: "rivet", text: "Photo Album is live." };
    expect(entry).toMatchObject({ replyTo: said.id, quote });
    expect((await post("/api/chat", { clientId: id, text: "Send the video" })).status, "a retry must name the same message").toBe(409);

    const page = (await (await fetch(`${server.base}/api/chat`, { headers: { cookie } })).json()) as ChatPage;
    expect(page.messages.find((message) => message.id === entry.id)).toMatchObject({ from: "owner", text: "Send the video", replyTo: said.id, quote });

    const stream = await connectBridge();
    clock.advance(BATCH_QUIET_MS);
    await stream.waitFor(1);
    // The window names its conversation: the one the replied message is in.
    const conversation = { id: said.id, title: "Photo Album" };
    expect(stream.events()[0]!.data).toEqual({ id: entry.id, at: entry.at, text: "Send the video", replyTo: said.id, quote, conversation });
    const bridgePath = "../bridge/lib/actions/command.mjs";
    const { validateCommand } = (await import(bridgePath)) as { validateCommand: (event: string, raw: unknown) => unknown };
    expect(validateCommand("chat", stream.events()[0]!.data)).toEqual({ ok: true, value: { id: entry.id, text: "Send the video", replyTo: said.id, quote, conversation } });

    const answer = (await (
      await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ text: "On it.", replyTo: entry.id }) })
    ).json()) as ChatMessage;
    expect(answer).toMatchObject({ replyTo: entry.id, quote: { from: "owner", text: "Send the video" } });
    const unknown = (await (
      await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ text: "Hm.", replyTo: "gone" }) })
    ).json()) as ChatMessage;
    expect(unknown.replyTo).toBe("gone");
    expect(unknown).not.toHaveProperty("quote");
    stream.abort();
  });

  it("the push for a reply opens the Chat tab and carries no more than the clipped text", () => {
    const payload = rivetPayload("x".repeat(1000));
    expect(payload).toMatchObject({ title: "Rivet", tag: "rivet-chat", path: "/?tab=chat" });
    expect(payload.body.length).toBeLessThan(1000);
  });
});

describe("chat windows", () => {
  const T0 = Date.UTC(2026, 8, 30, 1, 0, 0);
  let dataDir: string;
  let store: CommandStore;
  let n = 0;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "rivet-batch-"));
    store = new CommandStore(dataDir);
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const add = (offset: number, request: { text?: string; image?: string; images?: string[] }, maxImages?: number) => {
    const id = `m${(n += 1)}`;
    const at = new Date(T0 + offset).toISOString();
    return store.addChat({ id, clientId: `c-${id}`, request, at }, T0 + offset, BATCH_MAX_TEXT, maxImages);
  };
  const shas = (count: number, from = 0) => Array.from({ length: count }, (_, i) => (from + i).toString(16).padStart(64, "0"));
  const flush = (offset: number) => store.flushDue(T0 + offset, new Date(T0 + offset).toISOString());
  const statuses = (...ids: string[]) => ids.map((id) => [store.getAction(id)!.status, store.getChatMessage(id)!.status]);

  it("collects follow-ups into one window that goes to the bridge as its lead, with every text", () => {
    const lead = add(0, { text: "one" }).entry;
    const second = add(4_000, { text: "two" }).entry;
    const third = add(9_000, { text: "three" }).entry;
    expect([lead.status, second.status, third.status]).toEqual(["collecting", "collecting", "collecting"]);
    expect(statuses(lead.id, second.id)).toEqual([
      ["collecting", "collecting"],
      ["collecting", "collecting"],
    ]);
    expect(store.queuedChat()).toEqual([]);
    expect(flush(18_999)).toEqual([]);
    const [sent] = flush(19_000);
    expect(sent).toMatchObject({ id: lead.id, kind: "chat", status: "queued", text: "one | two | three" });
    expect(statuses(lead.id, second.id, third.id).map(([, chat]) => chat)).toEqual(["sent", "sent", "sent"]);
    expect(flush(60_000)).toEqual([]);
    expect(store.queuedChat().map((entry) => [entry.id, entry.text])).toEqual([[lead.id, "one | two | three"]]);
  });

  it("each follow-up resets the 10 s wait, up to 30 s from the first message", () => {
    const lead = add(0, { text: "a" }).entry;
    add(8_000, { text: "b" });
    expect(flush(12_000)).toEqual([]);
    expect(flush(18_000)).toHaveLength(1);

    const capped = add(40_000, { text: "c" }).entry;
    for (const offset of [49_000, 58_000, 67_000]) add(offset, { text: "more" });
    expect(flush(69_999)).toEqual([]);
    expect(flush(70_000).map((entry) => [entry.id, entry.text])).toEqual([[capped.id, "c | more | more | more"]]);
    expect(lead.id).not.toBe(capped.id);
  });

  it("a message after the deadline, not yet swept, closes the window and leads the next", () => {
    const lead = add(0, { text: "first" }).entry;
    const late = add(BATCH_QUIET_MS, { text: "late" });
    expect(late.closed).toMatchObject({ id: lead.id, status: "queued", text: "first" });
    expect(late.entry.status).toBe("collecting");
    expect(flush(BATCH_QUIET_MS * 2).map((entry) => [entry.id, entry.text])).toEqual([[late.entry.id, "late"]]);
  });

  it("for a bridge from before several photos, a second image closes the window at once and leads the next", () => {
    const [a, b] = ["a".repeat(64), "b".repeat(64)];
    const photo = add(0, { text: "look", image: a }, 1).entry;
    add(1_000, { text: "this one" }, 1);
    const second = add(2_000, { image: b }, 1);
    expect(second.closed).toMatchObject({ id: photo.id, text: "look | this one", image: a });
    expect(second.closed).not.toHaveProperty("images");
    expect(flush(BATCH_CAP_MS)).toMatchObject([{ id: second.entry.id, image: b }]);
    expect(flush(BATCH_CAP_MS)[0]).toBeUndefined();

    const again = add(60_000, { image: a }, 1).entry;
    expect(add(61_000, { image: a }, 1).closed?.id, "the same photo again is still a second photo").toBe(again.id);
  });

  it.each([0, 1])("text starts its own window when the bridge's photo limit drops to %i", (maxImages) => {
    const images = shas(maxImages + 1);
    const photo = add(0, { text: "look", images }).entry;
    const text = add(1_000, { text: "text still goes" }, maxImages);
    expect(text.closed).toMatchObject({ id: photo.id, status: "queued", text: "look" });
    expect(chatImagesOf(text.closed!)).toEqual(images);
    expect(add(2_000, { text: "and this" }, maxImages).closed).toBeNull();
    const [sent] = flush(2_000 + BATCH_QUIET_MS);
    expect(sent).toMatchObject({ id: text.entry.id, text: "text still goes | and this" });
    expect(chatImagesOf(sent!)).toEqual([]);
    expect(store.queuedChat().map((entry) => entry.id)).toEqual([photo.id, text.entry.id]);
    store.updateAction(text.entry.id, "typed", undefined, new Date(T0 + BATCH_CAP_MS).toISOString());
    expect(store.getAction(photo.id)?.status).toBe("queued");
    expect(store.getAction(text.entry.id)?.status).toBe("typed");
  });

  it("photos join a window up to 10 in the order sent; a follow-up that would pass 10 closes it and leads the next", () => {
    const [one, two, three] = [shas(1), shas(4, 1), shas(5, 5)];
    const lead = add(0, { text: "look", image: one[0] }).entry;
    const second = add(3_000, { images: two });
    expect(second.closed).toBeNull();
    add(6_000, { text: "and these" });
    const third = add(9_000, { images: three });
    expect(third.closed).toBeNull();
    const [sent] = flush(19_000);
    expect(sent).toMatchObject({ id: lead.id, text: "look | and these", images: [...one, ...two, ...three] });
    expect(sent).not.toHaveProperty("image");
    expect(store.queuedChat()).toMatchObject([{ id: lead.id, images: [...one, ...two, ...three] }]);
    expect([lead.id, second.entry.id, third.entry.id].map((id) => chatImagesOf(store.getChatMessage(id)!))).toEqual([one, two, three]);

    const full = add(60_000, { images: shas(10, 20) }).entry;
    expect(add(61_000, { text: "words still join" }).closed).toBeNull();
    const over = add(62_000, { image: shas(1, 40)[0] });
    expect(over.closed).toMatchObject({ id: full.id, text: "words still join", images: shas(10, 20) });
    const nine = add(63_000, { images: shas(9, 50) });
    expect(nine.closed).toBeNull();
    const eleventh = add(64_000, { images: shas(2, 60) });
    expect(eleventh.closed).toMatchObject({ id: over.entry.id, images: [...shas(1, 40), ...shas(9, 50)] });
    expect(flush(BATCH_CAP_MS + 64_000)).toMatchObject([{ id: eleventh.entry.id, images: shas(2, 60) }]);
  });

  it("photos past 40 MB together close the window, even under 10", () => {
    const big = shas(6, 100);
    for (const sha of big) store.putMedia(sha, "image/jpeg", 8 * 1024 * 1024, T0);
    const lead = add(0, { images: big.slice(0, 5) }).entry;
    expect(store.imageBytes(big.slice(0, 5))).toBe(MAX_CHAT_IMAGE_BYTES);
    const sixth = add(1_000, { image: big[5] });
    expect(sixth.closed).toMatchObject({ id: lead.id, images: big.slice(0, 5) });
    expect(add(2_000, { image: shas(1, 200)[0] }).closed, "a photo the store no longer has counts as nothing").toBeNull();
  });

  it("text past 20,000 characters closes the window at once and leads the next", () => {
    const long = add(60_000, { text: "x".repeat(2000) }).entry;
    const fits = add(61_000, { text: "y".repeat(BATCH_MAX_TEXT - 2003) });
    expect(fits.closed).toBeNull();
    const over = add(62_000, { text: "z" });
    expect(over.closed?.id).toBe(long.id);
    expect(over.closed?.text).toHaveLength(BATCH_MAX_TEXT);
    expect(over.entry.status).toBe("collecting");

    // Line breaks become " | " in what Rivet reads, so a window is measured after that, not before.
    const lines = add(120_000, { text: Array(5000).fill("x").join("\n") }).entry;
    const stop = add(121_000, { text: "Do not deploy." });
    expect(stop.closed?.id, "5,000 one-letter lines render to 19,997 characters, so the follow-up opens a new window").toBe(lines.id);
    expect(stop.closed?.text).toHaveLength(19_997);
    expect(flush(200_000).map((entry) => entry.text)).toEqual(["Do not deploy."]);
  });

  it("an ack naming a member moves the whole window, and a member's final status cannot be split from the lead's", () => {
    const lead = add(0, { text: "one" }).entry;
    const member = add(1_000, { text: "two" }).entry;
    flush(BATCH_CAP_MS);
    expect(store.updateAction(member.id, "failed", { reason: "typing failed" }, new Date().toISOString())?.id).toBe(lead.id);
    expect(statuses(lead.id, member.id).map(([audit]) => audit)).toEqual(["failed", "failed"]);
    store.updateAction(lead.id, "typed", undefined, new Date().toISOString());
    expect(statuses(lead.id, member.id).map(([audit]) => audit)).toEqual(["failed", "failed"]);
  });

  it("a reply leads a window of its own; follow-ups join it", () => {
    const first = add(0, { text: "one" }).entry;
    const quote = { from: "owner" as const, text: "one" };
    const reply = store.addChat({ id: "r1", clientId: "c-r1", request: { text: "two", replyTo: first.id, quote }, at: new Date(T0 + 1_000).toISOString() }, T0 + 1_000);
    expect(reply.closed).toMatchObject({ id: first.id, text: "one" });
    add(2_000, { text: "three" });
    const [sent] = flush(BATCH_CAP_MS + 1_000);
    expect(sent).toMatchObject({ id: "r1", text: "two | three", replyTo: first.id, quote });
    expect(store.getChatMessage("r1")).toMatchObject({ replyTo: first.id, quote });
  });

  it("adds the quote columns to a chat table from before replies, keeping its messages", () => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const old = new DatabaseSync(join(dataDir, "rivet.sqlite"));
    old.exec(`CREATE TABLE chat_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, sender TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, reply_to TEXT);
      INSERT INTO chat_messages (id, sender, text, at, reply_to) VALUES ('h1', 'rivet', 'Earlier answer', '2026-09-29T00:00:00.000Z', 'c0');`);
    old.close();
    store = new CommandStore(dataDir);
    expect(store.getChatMessage("h1")).toEqual({ id: "h1", from: "rivet", text: "Earlier answer", at: "2026-09-29T00:00:00.000Z", replyTo: "c0", threadId: "h1", seq: 1 });
    expect(store.quoteOf("h1")).toEqual({ from: "rivet", text: "Earlier answer" });
  });

  it("writes a message's bubble with its audit row, so a window always has every bubble", () => {
    const lead = add(0, { text: "one" }).entry;
    expect(store.getChatMessage(lead.id)).toMatchObject({ id: lead.id, from: "owner", text: "one", status: "collecting" });
  });

  it("members mirror the lead through typed and replied, and a reply to the lead or a member marks the whole window", () => {
    const lead = add(0, { text: "one" }).entry;
    const member = add(1_000, { text: "two" }).entry;
    flush(BATCH_CAP_MS);
    store.updateAction(lead.id, "typed", undefined, new Date().toISOString());
    expect(statuses(lead.id, member.id)).toEqual([
      ["typed", "typed"],
      ["typed", "typed"],
    ]);
    expect(store.batchIds(member.id)).toEqual([lead.id, member.id]);
    expect(store.markReplied(lead.id, new Date().toISOString())).toEqual([lead.id, member.id]);
    expect(statuses(lead.id, member.id)).toEqual([
      ["replied", "replied"],
      ["replied", "replied"],
    ]);

    const next = add(60_000, { text: "three" }).entry;
    const nextMember = add(61_000, { text: "four" }).entry;
    flush(90_000);
    store.updateAction(next.id, "unconfirmed", undefined, new Date().toISOString());
    expect(store.markReplied(undefined, new Date().toISOString())).toEqual([next.id, nextMember.id]);
    expect(statuses(next.id, nextMember.id).map(([, chat]) => chat)).toEqual(["replied", "replied"]);

    const third = add(120_000, { text: "five" }).entry;
    const thirdMember = add(121_000, { text: "six" }).entry;
    flush(150_000);
    store.updateAction(third.id, "typed", undefined, new Date().toISOString());
    expect(store.markReplied(thirdMember.id, new Date().toISOString()), "a reply naming a member marks its whole window").toEqual([third.id, thirdMember.id]);
    expect(statuses(third.id, thirdMember.id).map(([, chat]) => chat)).toEqual(["replied", "replied"]);
  });

  it("an open window survives the store closing and flushes when it reopens", () => {
    const lead = add(0, { text: "before" }).entry;
    add(1_000, { text: "restart" });
    store.close();
    store = new CommandStore(dataDir);
    expect(store.getChatMessage(lead.id)?.status).toBe("collecting");
    expect(flush(BATCH_QUIET_MS + 1_000).map((entry) => entry.text)).toEqual(["before | restart"]);
  });

  it("the server flushes a window left open across a restart as it starts, and the bridge gets it on attach", async () => {
    const at = Date.now() - 60_000;
    const lead = store.addChat({ id: "restart-lead", clientId: "c-restart-lead", request: { text: "still here" }, at: new Date(at).toISOString() }, at).entry;
    store.addChat({ id: "restart-two", clientId: "c-restart-two", request: { text: "and me" }, at: new Date(at + 1).toISOString() }, at + 1);
    store.close();
    await server.close();
    server = await startServer({ RIVET_DATA_DIR: dataDir });
    cookie = server.cookie();
    store = new CommandStore(dataDir);
    expect(store.getAction(lead.id)?.status).toBe("queued");
    const stream = await connectBridge();
    await stream.waitFor(1);
    expect(stream.events()).toMatchObject([{ event: "chat", id: lead.id, data: { id: lead.id, text: "still here | and me" } }]);
    stream.abort();
  });

  it("holds a window to 2000 characters for a bridge from before chat windows, so it never cuts a follow-up", async () => {
    const stream = await connectBridge("image");
    const lead = (await (await post("/api/chat", { clientId: clientId(), text: "x".repeat(1990) })).json()) as AuditEntry;
    clock.advance(2_000);
    const stop = (await (await post("/api/chat", { clientId: clientId(), text: "Do not deploy." })).json()) as AuditEntry;
    await stream.waitFor(1);
    expect(stream.events()).toMatchObject([{ event: "chat", id: lead.id, data: { text: "x".repeat(1990) } }]);
    clock.advance(BATCH_QUIET_MS);
    await stream.waitFor(2);
    expect(stream.events()[1]).toMatchObject({ event: "chat", id: stop.id, data: { text: "Do not deploy." } });
    stream.abort();
  });

  it("keeps a window collected for a newer bridge queued while an older one is connected, and sends it whole to the next newer one", async () => {
    const newer = await connectBridge();
    const lead = (await (await post("/api/chat", { clientId: clientId(), text: "x".repeat(2000) })).json()) as AuditEntry;
    clock.advance(2_000);
    await post("/api/chat", { clientId: clientId(), text: "Do not deploy." });
    newer.abort();
    const older = await connectBridge("image");
    clock.advance(BATCH_QUIET_MS);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(older.events()).toEqual([]);
    older.abort();
    const upgraded = await connectBridge();
    await upgraded.waitFor(1);
    expect(upgraded.events()).toMatchObject([{ event: "chat", id: lead.id, data: { text: `${"x".repeat(2000)} | Do not deploy.` } }]);
    upgraded.abort();
  });

  it("takes a 20,000-character message, any script, and refuses one longer", async () => {
    const stream = await connectBridge("image,chat-window,long-chat");
    expect((await post("/api/chat", { clientId: clientId(), text: "é".repeat(MAX_CHAT_TEXT) })).status).toBe(202);
    expect((await post("/api/chat", { clientId: clientId(), text: "x".repeat(MAX_CHAT_TEXT + 1) })).status).toBe(400);
    stream.abort();
  });

  it("refuses a message too long for the bridge, so a later one never overtakes it, and sends it whole to one that says long-chat", async () => {
    const long = `${"word ".repeat(3999)}last.`;
    const offline = await post("/api/chat", { clientId: clientId(), text: long });
    expect(offline.status, "no bridge since the restart").toBe(424);
    const short = await connectBridge("image,chat-window");
    const refused = await post("/api/chat", { clientId: clientId(), text: long });
    expect(refused.status).toBe(424);
    expect(((await refused.json()) as { error: string }).error).toContain("under 4,000 characters");
    // 1,000 one-letter lines type as 3,997 characters: past the window's 3,800, within the 4,000 that bridge takes.
    const lines = Array(1000).fill("x").join("\n");
    const fits = (await (await post("/api/chat", { clientId: clientId(), text: lines })).json()) as AuditEntry;
    clock.advance(BATCH_QUIET_MS);
    await short.waitFor(1);
    expect(short.events()).toMatchObject([{ event: "chat", id: fits.id, data: { text: Array(1000).fill("x").join(" | ") } }]);
    short.abort();
    const upgraded = await connectBridge("image,chat-window,long-chat");
    const lead = (await (await post("/api/chat", { clientId: clientId(), text: long })).json()) as AuditEntry;
    clock.advance(BATCH_QUIET_MS);
    await upgraded.waitFor(2);
    expect(upgraded.events().map((event) => event.id), "the unacked short one is replayed first, then the long one").toEqual([fits.id, lead.id]);
    expect(upgraded.events()[1]).toMatchObject({ event: "chat", data: { text: long } });
    upgraded.abort();
  });

  it("end to end: shows as collecting, sends one event after the quiet, and a say to the lead marks every bubble replied", async () => {
    const controller = new AbortController();
    const app = await fetch(`${server.base}/api/chat/stream`, { headers: { cookie }, signal: controller.signal });
    const reader = app.body!.getReader();
    const decoder = new TextDecoder();
    let frames = "";
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          frames += decoder.decode(value, { stream: true });
        }
      } catch {}
    })();
    const shown = () =>
      frames
        .split("\n\n")
        .filter((block) => block.startsWith("event: message"))
        .map((block) => JSON.parse(block.slice(block.indexOf("data: ") + 6)) as ChatMessage);

    const stream = await connectBridge();
    const first = await post("/api/chat", { clientId: clientId(), text: "ship docs refresh" });
    expect(first.status).toBe(202);
    const lead = (await first.json()) as AuditEntry;
    expect(lead.status).toBe("collecting");
    clock.advance(5_000);
    const member = (await (await post("/api/chat", { clientId: clientId(), text: "then release notes" })).json()) as AuditEntry;
    const page = async () => ((await (await fetch(`${server.base}/api/chat`, { headers: { cookie } })).json()) as ChatPage).messages;
    expect((await page()).map((message) => message.status)).toEqual(["collecting", "collecting"]);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(stream.events()).toEqual([]);

    clock.advance(BATCH_QUIET_MS);
    await stream.waitFor(1);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(stream.events()).toMatchObject([{ event: "chat", id: lead.id, data: { id: lead.id, text: "ship docs refresh | then release notes" } }]);
    expect(stream.events()).toHaveLength(1);
    expect(shown().filter((message) => message.status === "sent").map((message) => message.id)).toEqual([lead.id, member.id]);

    const ack = await fetch(`${server.base}/api/bridge/action-ack`, { method: "POST", headers: bearer(BRIDGE_TOKEN), body: JSON.stringify({ id: lead.id, status: "typed" }) });
    expect(ack.status).toBe(200);
    expect((await page()).map((message) => message.status)).toEqual(["typed", "typed"]);
    const refused = await fetch(`${server.base}/api/bridge/action-ack`, { method: "POST", headers: bearer(BRIDGE_TOKEN), body: JSON.stringify({ id: lead.id, status: "collecting" }) });
    expect(refused.status).toBe(400);

    const say = await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ text: "Both queued.", replyTo: lead.id }) });
    expect(say.status).toBe(201);
    expect((await page()).map((message) => [message.from, message.status, message.replyTo])).toEqual([
      ["owner", "replied", undefined],
      ["owner", "replied", undefined],
      ["rivet", undefined, lead.id],
    ]);
    await waitForStatus(server.base, cookie, member.id, "replied");
    expect(shown().filter((message) => message.status === "replied").map((message) => message.id)).toEqual([lead.id, member.id]);
    stream.abort();
    controller.abort();
  });
});

describe("worker sheet actions", () => {
  it("nothing types into a chat or interrupts it: everything you write goes to Rivet (2026-10-09)", async () => {
    await liveWorker();
    // An app still on an older bundle gets a refusal, never a send straight into a live chat's terminal.
    expect((await post("/api/actions/send", { clientId: clientId(), repo: MS, chat: "checkout-feedback", text: "hi" })).status).toBe(404);
    expect((await post("/api/actions/pause", { clientId: clientId(), repo: MS, chat: "checkout-feedback" })).status).toBe(404);
  });

  it("a reconnecting bridge is asked about every action still open, and untracked is final", async () => {
    const commands = new CommandStore(server.dataDir);
    const at = new Date().toISOString();
    const send = commands.addAction({ id: "send-open", clientId: "c-send-open", kind: "send", request: { repo: MS, chat: "checkout-feedback", text: "hi" }, at }).entry;
    const pause = commands.addAction({ id: "pause-open", clientId: "c-pause-open", kind: "pause", request: { repo: MS, chat: "checkout-feedback" }, at }).entry;
    commands.close();
    const ack = (id: string, status: string) =>
      fetch(`${server.base}/api/bridge/action-ack`, { method: "POST", headers: bearer(BRIDGE_TOKEN), body: JSON.stringify({ id, status }) });
    expect((await ack(pause.id, "untracked")).status).toBe(200);
    expect(((await (await ack(pause.id, "running")).json()) as AuditEntry).status).toBe("untracked");
    const stream = await connectBridge();
    await stream.waitFor(1);
    const asked = stream.events().find((event) => event.event === "actions.outstanding");
    expect(asked?.data.actions).toEqual([{ id: send.id, kind: "send" }]);
    stream.abort();
  });

  it("the outstanding list skips finished sends and pauses and keeps the newest rows", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rivet-store-"));
    const store = new CommandStore(dataDir);
    const at = (minute: number) => new Date(Date.UTC(2026, 8, 28, 10, minute)).toISOString();
    const add = (id: string, kind: "send" | "pause", minute: number, status?: "typed" | "unconfirmed" | "running") => {
      store.addAction({ id, clientId: `c-${id}`, kind, request: {}, at: at(minute) });
      if (status) store.updateAction(id, status, undefined, at(minute));
    };
    add("send-typed", "send", 1, "typed");
    add("pause-unconfirmed", "pause", 2, "unconfirmed");
    add("send-open", "send", 3);
    add("pause-old", "pause", 4);
    add("send-running", "send", 5, "running");
    add("pause-new", "pause", 6);
    expect(store.outstandingActions(at(0), 10).map((row) => row.id)).toEqual(["pause-new", "send-running", "pause-old", "send-open"]);
    expect(store.outstandingActions(at(0), 2).map((row) => row.id)).toEqual(["pause-new", "send-running"]);
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("an ack never moves a final status and needs the bridge token", async () => {
    const entry = (await (await post("/api/chat", { clientId: clientId(), text: "hi" })).json()) as AuditEntry;
    const ack = (status: string, headers = bearer(BRIDGE_TOKEN)) =>
      fetch(`${server.base}/api/bridge/action-ack`, { method: "POST", headers, body: JSON.stringify({ id: entry.id, status }) });
    expect((await ack("typed", bearer(BOARD_TOKEN))).status).toBe(401);
    expect((await ack("failed")).status).toBe(200);
    const after = (await (await ack("typed")).json()) as AuditEntry;
    expect(after.status).toBe("failed");
    expect((await ack("exploded")).status).toBe(400);
  });
});

describe("live logs", () => {
  it("a lease lapses after 60 s unless renewed, and a lapsed lease keeps nothing", () => {
    let now = 1_000_000;
    const leases = new LogLeases(() => now);
    expect(leases.append(MS, "ace", ["early"], true).active).toBe(false);
    leases.renew(MS, "ace");
    expect(leases.append(MS, "ace", ["one", "two"], true)).toMatchObject({ active: true });
    expect(leases.read(MS, "ace").lines).toEqual(["one", "two"]);
    now += LOG_LEASE_MS - 1000;
    leases.renew(MS, "ace");
    now += LOG_LEASE_MS - 1000;
    expect(leases.append(MS, "ace", ["three"], false).active).toBe(true);
    now += 2000;
    expect(leases.append(MS, "ace", ["four"], false).active).toBe(false);
    expect(leases.read(MS, "ace").lines).toEqual([]);
    expect(leases.active()).toEqual([]);
  });

  it("keeps the last 200 lines only", () => {
    const leases = new LogLeases();
    leases.renew(MS, "ace");
    leases.append(MS, "ace", Array.from({ length: 150 }, (_, i) => `a${i}`), true);
    leases.append(MS, "ace", Array.from({ length: 150 }, (_, i) => `b${i}`), false);
    const { lines } = leases.read(MS, "ace");
    expect(lines).toHaveLength(200);
    expect(lines.at(-1)).toBe("b149");
  });

  it("times each line when it arrives, keeps them over a fresh read, and gives the first read's lines none", () => {
    let now = Date.parse("2026-10-26T06:53:00Z");
    const leases = new LogLeases(() => now);
    leases.renew(MS, "ace");
    leases.append(MS, "ace", ["already", "there"], true);
    now += 30_000;
    leases.append(MS, "ace", ["new"], false);
    expect(leases.read(MS, "ace").times).toEqual([null, null, "2026-10-26T06:53:30.000Z"]);
    now += 20_000;
    leases.append(MS, "ace", ["there", "new", "newer"], true);
    expect(leases.read(MS, "ace")).toMatchObject({
      lines: ["there", "new", "newer"],
      times: [null, "2026-10-26T06:53:30.000Z", "2026-10-26T06:53:50.000Z"],
    });
    // A line the screen shows twice keeps each copy's time.
    leases.renew(MS, "bee");
    leases.append(MS, "bee", ["⏺ Deployment:", "Started."], true);
    now += 20_000;
    leases.append(MS, "bee", ["⏺ Deployment:", "Failed."], false);
    now += 20_000;
    leases.append(MS, "bee", ["⏺ Deployment:", "Started.", "⏺ Deployment:", "Failed."], true);
    expect(leases.read(MS, "bee").times).toEqual([null, null, "2026-10-26T06:54:10.000Z", "2026-10-26T06:54:10.000Z"]);
    // Once the older copy has scrolled off, the one left keeps its own time.
    leases.append(MS, "bee", ["⏺ Deployment:", "Failed."], true);
    expect(leases.read(MS, "bee").times).toEqual(["2026-10-26T06:54:10.000Z", "2026-10-26T06:54:10.000Z"]);
  });

  it("subscribes only a live chat, and the bridge's upload needs an open lease", async () => {
    const lease = { repo: MS, chat: "checkout-feedback" };
    expect((await post("/api/logs/subscribe", lease)).status).toBe(409);
    await liveWorker();
    expect((await post("/api/logs/subscribe", lease)).status).toBe(503);
    const upload = (lines: unknown, headers = bearer(BRIDGE_TOKEN)) =>
      fetch(`${server.base}/api/bridge/logs`, { method: "PUT", headers, body: JSON.stringify({ ...lease, lines, reset: true }) });
    expect(await (await upload(["x"])).json()).toEqual({ active: false });
    const stream = await connectBridge();
    expect((await post("/api/logs/subscribe", lease)).status).toBe(202);
    await stream.waitFor(1);
    expect(stream.events()[0]).toMatchObject({ event: "logs.subscribe", data: lease });
    expect((await upload(["x"], bearer(BOARD_TOKEN))).status).toBe(401);
    expect((await upload(["x".repeat(501)])).status).toBe(400);
    expect((await upload(Array.from({ length: 201 }, () => "x"))).status).toBe(400);
    expect(await (await upload(["hello"])).json()).toMatchObject({ active: true });
    const logs = (await (await fetch(`${server.base}/api/logs?repo=${encodeURIComponent(MS)}&chat=checkout-feedback`, { headers: { cookie } })).json()) as {
      lines: string[];
    };
    expect(logs.lines).toEqual(["hello"]);
    // The copy the sheet holds is answered 304 with nothing in it; a session is still needed for that.
    const url = `${server.base}/api/logs?repo=${encodeURIComponent(MS)}&chat=checkout-feedback`;
    const etag = (await fetch(url, { headers: { cookie } })).headers.get("etag")!;
    expect(etag).toMatch(/^W\/"/);
    const still = await fetch(url, { headers: { cookie, "if-none-match": etag } });
    expect([still.status, await still.text()]).toEqual([304, ""]);
    expect((await fetch(url, { headers: { "if-none-match": etag } })).status).toBe(401);
    expect((await fetch(url, { headers: { cookie, "if-none-match": 'W/"other"' } })).status).toBe(200);
    // The screen as the sheet reads it is redacted again: a wrapped line joined can make a whole masking never saw (made up).
    await upload(["⏺ Basic", "dGVzdDph"]);
    const read = (await (await fetch(url, { headers: { cookie } })).json()) as { lines: string[]; screen: { text?: string }[]; feed: { text: string }[] };
    expect(read.lines).toEqual(["⏺ Basic", "dGVzdDph"]);
    expect(read.screen.map((item) => item.text).join(" ")).toMatch(/^Basic\b/);
    expect(read.screen.map((item) => item.text).join(" ")).not.toContain("dGVzdDph");
    expect(read.feed.map((entry) => entry.text).join(" ")).toMatch(/^Basic\b/);
    expect(JSON.stringify(read.feed)).not.toContain("dGVzdDph");
    // A secret's name on one line hides its value on the next, as the bridge reads a log; a made-up password.
    expect(await (await upload(["password: | # a made-up one", "  correct horse qzvtkfakepass"])).json()).toMatchObject({ active: true });
    const after = await (await fetch(`${server.base}/api/logs?repo=${encodeURIComponent(MS)}&chat=checkout-feedback`, { headers: { cookie } })).text();
    expect(after).not.toContain("qzvtkfakepass");
    // New lines are a new copy: the old ETag gets them in full.
    const changed = await fetch(url, { headers: { cookie, "if-none-match": etag } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    expect((await fetch(`${server.base}/api/logs?repo=${encodeURIComponent(MS)}&chat=checkout-feedback`)).status).toBe(401);
    expect((await post("/api/logs/release", lease)).status).toBe(200);
    expect(await (await upload(["later"])).json()).toEqual({ active: false });
    stream.abort();
  });
});

describe("media", () => {
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(200, 7)]);
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const put = (hash: string, body: Buffer, type = "video/mp4", headers = bearer(BOARD_TOKEN)) =>
    fetch(`${server.base}/api/bridge/media/${hash}`, { method: "PUT", headers: { ...headers, "content-type": type }, body: new Uint8Array(body) });

  it("stores a clip by its sha256 and serves it with Range to a session only", async () => {
    expect((await put(sha(MP4), MP4)).status).toBe(201);
    expect((await put(sha(MP4), MP4)).status).toBe(200);
    const full = await fetch(`${server.base}/media/${sha(MP4)}`, { headers: { cookie } });
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await full.arrayBuffer()).equals(MP4)).toBe(true);

    const part = await fetch(`${server.base}/media/${sha(MP4)}`, { headers: { cookie, range: "bytes=4-11" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 4-11/${MP4.length}`);
    expect(Buffer.from(await part.arrayBuffer()).toString()).toBe("ftypisom");

    const tail = await fetch(`${server.base}/media/${sha(MP4)}`, { headers: { cookie, range: "bytes=-10" } });
    expect(tail.status).toBe(206);
    expect((await tail.arrayBuffer()).byteLength).toBe(10);

    expect((await fetch(`${server.base}/media/${sha(MP4)}`, { headers: { cookie, range: `bytes=${MP4.length}-` } })).status).toBe(416);
    expect((await fetch(`${server.base}/media/${sha(MP4)}`)).status).toBe(401);
  });

  it("puts Rivet's uploaded photos and video in his chat answer, and nothing else", async () => {
    const say = (body: unknown) => fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) });
    const PNG2 = Buffer.concat([PNG, Buffer.from([2])]);
    const mp3 = Buffer.concat([Buffer.from("ID3\x04\x00", "latin1"), Buffer.alloc(100, 3)]);
    for (const [bytes, type] of [[PNG, "image/png"], [PNG2, "image/png"], [MP4, "video/mp4"], [mp3, "audio/mpeg"]] as const) {
      expect((await put(sha(bytes), bytes, type)).status).toBe(201);
    }
    // Refused: a sha not in the store, a path or URL, a clip as a photo, a photo or sound as the video, a repeat, four.
    expect((await say({ images: ["d".repeat(64)] })).status).toBe(400);
    expect((await say({ images: [join(homedir(), "still.png")] })).status).toBe(400);
    expect((await say({ images: [`https://rivet.example.com/media/${sha(PNG)}`] })).status).toBe(400);
    expect((await say({ video: "../media/x.mp4" })).status).toBe(400);
    expect((await say({ images: [sha(MP4)] })).status).toBe(400);
    expect((await say({ video: sha(PNG) })).status).toBe(400);
    expect((await say({ video: sha(mp3) })).status).toBe(400);
    expect((await say({ images: [sha(PNG), sha(PNG)] })).status).toBe(400);
    expect((await say({ images: [sha(PNG), sha(PNG2), sha(MP4), "e".repeat(64)] })).status).toBe(400);
    expect((await say({ images: [] })).status).toBe(400);
    expect((await say({ text: "  " })).status).toBe(400);

    const photoOnly = await say({ images: [sha(PNG)], new: true });
    expect(photoOnly.status).toBe(201);
    expect(await photoOnly.json()).toMatchObject({ from: "rivet", text: "", image: sha(PNG) });
    const both = (await (await say({ text: "Photo test", images: [sha(PNG), sha(PNG2)], video: sha(MP4), new: true })).json()) as ChatMessage;
    expect(both).toMatchObject({ text: "Photo test", images: [sha(PNG), sha(PNG2)], video: sha(MP4) });
    const page = (await (await fetch(`${server.base}/api/chat`, { headers: { cookie } })).json()) as ChatPage;
    expect(page.messages.find((message) => message.id === both.id)).toMatchObject({ images: [sha(PNG), sha(PNG2)], video: sha(MP4) });
    expect((await fetch(`${server.base}/media/${sha(PNG2)}`, { headers: { cookie } })).status).toBe(200);
  });

  it("a say replying to nothing is a Got it card: its photos and video the card's media, its tag leading its title; no chat line, the board's push", async () => {
    const say = (body: unknown) => fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) });
    for (const [bytes, type] of [[PNG, "image/png"], [MP4, "video/mp4"]] as const) expect((await put(sha(bytes), bytes, type)).status).toBe(201);
    const notify = vi.spyOn(server.app.push, "notify");
    const notifyNewNeeds = vi.spyOn(server.app.push, "notifyNewNeeds");
    const said = await say({ text: "Docs Sync deployed\nChecked on the site.", images: [sha(PNG)], video: sha(MP4), tag: "Deployed", thread: "Docs Sync" });
    expect(said.status).toBe(201);
    const { id, card } = (await said.json()) as { id: string; card: string };
    expect(id).toMatch(/^upd-/);
    expect(card).toBe(id);
    const board = ((await (await fetch(`${server.base}/api/board`, { headers: bearer(BOARD_TOKEN) })).json()) as { board: { needs: Record<string, unknown>[] } }).board;
    expect(board.needs.find((need) => need.id === id)).toMatchObject({
      kind: "decision",
      title: "Deployed: Docs Sync deployed",
      ask: "Checked on the site.",
      options: [{ label: "Got it" }],
      push: "fyi",
      media: { kind: "video", after: { sha256: sha(MP4), type: "video/mp4" }, stills: [{ sha256: sha(PNG), type: "image/png" }] },
    });
    expect(board.needs.find((need) => need.id === id)).not.toHaveProperty("thread");
    expect(notifyNewNeeds).toHaveBeenCalledWith([expect.objectContaining({ id })], expect.any(Function));
    expect(notify).not.toHaveBeenCalled();
    // A photo alone is titled for it; the Chat tab gets nothing.
    const photo = (await (await say({ images: [sha(PNG)] })).json()) as { id: string };
    const after = ((await (await fetch(`${server.base}/api/board`, { headers: bearer(BOARD_TOKEN) })).json()) as { board: { needs: Record<string, unknown>[] } }).board;
    expect(after.needs.find((need) => need.id === photo.id)).toMatchObject({ kind: "decision", title: "A photo", options: [{ label: "Got it" }], media: { kind: "stills" } });
    const page = (await (await fetch(`${server.base}/api/chat`, { headers: { cookie } })).json()) as ChatPage;
    expect(page.messages).toEqual([]);
    notify.mockRestore();
    notifyNewNeeds.mockRestore();
  });

  it("an outcome card offers Yes, keep it and Change it, with a video or without", async () => {
    const say = (body: unknown) => fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) });
    expect((await put(sha(MP4), MP4)).status).toBe(201);
    const asked = (await (await post("/api/chat", { clientId: "client-outcome-1", text: "Slow the page cache" })).json()) as ChatMessage;
    const board = async () => ((await (await fetch(`${server.base}/api/board`, { headers: bearer(BOARD_TOKEN) })).json()) as { board: { needs: Record<string, unknown>[] } }).board;
    const labels = async (card: string) => ((await board()).needs.find((need) => need.id === card)?.options as { label: string }[]).map((option) => option.label);
    const clip = (await (await say({ text: "Web Cache: pages load slower", replyTo: asked.id, card: true, video: sha(MP4) })).json()) as ChatMessage;
    expect(await labels(clip.card!)).toEqual(["Yes, keep it", "Change it"]);
    const plain = (await (await say({ text: "Web Cache: the tower is fixed", replyTo: asked.id, card: true })).json()) as ChatMessage;
    expect(await labels(plain.card!)).toEqual(["Yes, keep it", "Change it"]);
  });

  it("refuses the wrong type, a sniff mismatch, a hash mismatch and oversize", async () => {
    expect((await put(sha(MP4), MP4, "text/html")).status).toBe(415);
    expect((await put(sha(PNG), PNG, "video/mp4")).status).toBe(415);
    expect((await put(sha(MP4), MP4, "audio/mp4")).status).toBe(415);
    expect((await put(sha(MP4), MP4, "audio/mpeg")).status).toBe(415);
    const mp3 = Buffer.concat([Buffer.from("ID3\x04\x00", "latin1"), Buffer.alloc(100, 3)]);
    expect((await put(sha(mp3), mp3, "audio/mpeg")).status).toBe(201);
    expect((await put(sha(PNG), MP4)).status).toBe(400);
    expect((await put(sha(MP4), MP4, "video/mp4", bearer(BRIDGE_TOKEN))).status).toBe(401);
    const big = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: server.port,
          method: "PUT",
          path: `/api/bridge/media/${"a".repeat(64)}`,
          headers: { ...bearer(BOARD_TOKEN), "content-type": "video/mp4", "content-length": String(25 * 1024 * 1024 + 1) },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(big).toBe(413);
    expect((await fetch(`${server.base}/media/${sha(PNG)}`, { headers: { cookie } })).status).toBe(404);
  });

  const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n", "latin1"), Buffer.alloc(200, 5)]);
  const pdfCard = (name: string) => {
    const board = structuredClone(EXAMPLE_BOARD) as unknown as { needs: Record<string, unknown>[] };
    board.needs[0] = { ...board.needs[0], media: { kind: "files", files: [{ sha256: sha(PDF), type: "application/pdf", name, bytes: PDF.length }] } };
    return board;
  };

  it("stores a PDF and serves it to a session inline under the card's name, sandboxed", async () => {
    expect((await put(sha(PDF), PDF, "application/pdf", bearer(BRIDGE_TOKEN))).status).toBe(401);
    expect((await put(sha(PDF), PDF, "application/pdf")).status).toBe(201);
    expect((await putBoard(server.base, pdfCard("White paper (v2).pdf"))).status).toBe(200);
    const res = await fetch(`${server.base}/media/${sha(PDF)}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="White paper (v2).pdf"; filename*=UTF-8''White%20paper%20%28v2%29.pdf`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toMatch(/^sandbox(;|$)/);
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true);
    expect((await fetch(`${server.base}/media/${sha(PDF)}`)).status).toBe(401);
    // The bridge fetches your photos only.
    expect((await fetch(`${server.base}/api/bridge/media/${sha(PDF)}`, { headers: bearer(BRIDGE_TOKEN) })).status).toBe(404);
    // Off every card it still downloads, under a plain name.
    await putBoard(server.base);
    const loose = await fetch(`${server.base}/media/${sha(PDF)}`, { headers: { cookie } });
    expect(loose.headers.get("content-disposition")).toBe(`inline; filename="document.pdf"; filename*=UTF-8''document.pdf`);
    await loose.arrayBuffer();
  });

  it("refuses a PDF that is not one, is too big, or comes from your photo upload", async () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    expect((await put(sha(html), html, "application/pdf")).status).toBe(415);
    expect((await put(sha(PNG), PNG, "application/pdf")).status).toBe(415);
    expect((await put(sha(PDF), PDF, "image/png")).status).toBe(415);
    const big = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: server.port,
          method: "PUT",
          path: `/api/bridge/media/${"b".repeat(64)}`,
          headers: { ...bearer(BOARD_TOKEN), "content-type": "application/pdf", "content-length": String(25 * 1024 * 1024 + 1) },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(big).toBe(413);
    const photo = await fetch(`${server.base}/api/images`, { method: "POST", headers: { ...browser(cookie), "content-type": "application/octet-stream" }, body: new Uint8Array(PDF) });
    expect(photo.status).toBe(415);
    expect((await fetch(`${server.base}/media/${sha(PDF)}`, { headers: { cookie } })).status).toBe(404);
  });

  it("stores a card's Markdown and serves it as plain text under the card's name; refuses text that is not", async () => {
    const md = Buffer.from("# Notes\n\n<script>alert(1)</script>\n");
    expect((await put(sha(md), md, "text/markdown")).status).toBe(201);
    const board = structuredClone(EXAMPLE_BOARD) as unknown as { needs: Record<string, unknown>[] };
    board.needs[0] = { ...board.needs[0], media: { kind: "files", files: [{ sha256: sha(md), type: "text/markdown", name: "Sweep notes.md", bytes: md.length }] } };
    expect((await putBoard(server.base, board)).status).toBe(200);
    const res = await fetch(`${server.base}/media/${sha(md)}`, { headers: { cookie } });
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="Sweep notes.md"; filename*=UTF-8''Sweep%20notes.md`);
    expect(Buffer.from(await res.arrayBuffer()).equals(md)).toBe(true);
    const binary = Buffer.from([0x23, 0x00, 0xff]);
    expect((await put(sha(binary), binary, "text/plain")).status).toBe(415);
    expect((await put(sha(PNG), PNG, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).status).toBe(415);
    expect((await put(sha(md), md, "image/svg+xml")).status).toBe(415);
    // A text document is named by its digest, so one the redactor would change is refused, never stored redacted.
    const secret = Buffer.from(`# Creds\n\ntoken: ${"gh" + "p_"}${"A1b2".repeat(9)}\n`);
    const refused = await put(sha(secret), secret, "text/markdown");
    expect(refused.status).toBe(422);
    // It names the line and the rule that fired, never what was found.
    const { error } = (await refused.json()) as { error: string };
    expect(error).toMatch(/redactor takes out.*Found at line 3 \(github token\)\.$/);
    expect(error).not.toContain("A1b2");
    const escape = Buffer.from("build \u001b[31mfailed\u001b[0m\n");
    expect((await put(sha(escape), escape, "text/plain")).status).toBe(422);
    for (const refusedSha of [sha(secret), sha(escape)]) expect((await fetch(`${server.base}/media/${refusedSha}`, { headers: { cookie } })).status).toBe(404);
    const huge = Buffer.from("ok\n".repeat(128 * 1024 + 1));
    // The server answers from the declared size and closes, so a body still being sent can end in EPIPE: try again.
    const sendHuge = async (tries = 5): Promise<Response> => put(sha(huge), huge, "text/plain").catch((error: unknown) => (tries > 1 ? sendHuge(tries - 1) : Promise.reject(error)));
    expect((await sendHuge()).status).toBe(413);
    const csv = Buffer.from("id,amount\n1,12.50\n");
    expect((await put(sha(csv), csv, "text/csv")).status).toBe(201);
    // An email is text too, and is checked as text.
    const mail = Buffer.from(`From: a@example.com\r\nSubject: creds\r\n\r\ntoken: ${"gh" + "p_"}${"A1b2".repeat(9)}\r\n`);
    expect((await put(sha(mail), mail, "message/rfc822")).status).toBe(422);
    // A text document already stored (your own, or one from before the check) is read again before the board token
    // may name it: an upload of its digest is refused as a new one would be.
    const own = await fetch(`${server.base}/api/files`, {
      method: "POST",
      headers: { ...browser(cookie), "x-file-name": "creds.md" },
      body: new Uint8Array(secret),
    });
    expect(own.status).toBe(201);
    expect((await put(sha(secret), secret, "text/markdown")).status).toBe(422);
    expect((await put(sha(csv), csv, "text/csv")).status).toBe(200);
    // A card names a document with its own type's extension.
    board.needs[0] = { ...board.needs[0], media: { kind: "files", files: [{ sha256: sha(md), type: "text/markdown", name: "Sweep notes.pdf", bytes: md.length }] } };
    expect((await putBoard(server.base, board)).status).toBe(400);
  });

  it("reads at most MAX_TEXT_UPLOADS token-sent text documents at once", async () => {
    const open = Array.from({ length: MAX_TEXT_UPLOADS }, (_, i) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: server.port,
        method: "PUT",
        path: `/api/bridge/media/${String(i).repeat(64)}`,
        headers: { ...bearer(BOARD_TOKEN), "content-type": "text/plain", "transfer-encoding": "chunked" },
      });
      req.on("error", () => {});
      req.write("still sending\n");
      return req;
    });
    // The held uploads are read up to their first chunk before the next one is refused.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const busy = Buffer.from("one more\n");
    expect((await put(sha(busy), busy, "text/plain")).status).toBe(429);
    for (const req of open) req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await put(sha(busy), busy, "text/plain")).status).toBe(201);
  });

  it("builds a download name the header cannot be broken by", () => {
    const header = (name: string) => pdfDisposition(name);
    expect(header("White paper.pdf")).toBe(`inline; filename="White paper.pdf"; filename*=UTF-8''White%20paper.pdf`);
    for (const hostile of ['evil".pdf\r\nSet-Cookie: a=b', "../../etc/passwd.pdf", "résumé naïve.pdf", "x.exe", "", "...pdf", `${"a".repeat(300)}.pdf`, "a;b=c\\d.PDF"]) {
      const value = header(hostile);
      const name = /filename="([^"]*)"/.exec(value)![1]!;
      expect(name, hostile).toMatch(/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,95}\.pdf$/);
      expect(value, hostile).not.toMatch(/[\r\n]/);
      expect(value.split(";").length, hostile).toBe(3);
    }
    expect(header("../../etc/passwd.pdf")).toContain('filename="etc passwd.pdf"');
    expect(header("")).toContain('filename="document.pdf"');
  });

  it("a file gone from disk is a 404, and a broken one never takes the server down", async () => {
    const mediaDir = join(dirname(server.webRoot), "data", "media");
    expect((await put(sha(MP4), MP4)).status).toBe(201);
    rmSync(join(mediaDir, sha(MP4)));
    expect((await fetch(`${server.base}/media/${sha(MP4)}`, { headers: { cookie } })).status).toBe(404);
    mkdirSync(join(mediaDir, sha(MP4)));
    for (const range of [undefined, "bytes=0-9"]) {
      const headers: Record<string, string> = range ? { cookie, range } : { cookie };
      await fetch(`${server.base}/media/${sha(MP4)}`, { headers })
        .then((response) => response.arrayBuffer())
        .catch(() => undefined);
    }
    expect((await put(sha(PNG), PNG, "image/png")).status).toBe(201);
    expect((await fetch(`${server.base}/media/${sha(PNG)}`, { headers: { cookie } })).status).toBe(200);
  });

  it("an upload that cannot be written fails cleanly and leaves no temp file", async () => {
    const mediaDir = join(dirname(server.webRoot), "data", "media");
    chmodSync(mediaDir, 0o500);
    try {
      expect((await put(sha(MP4), MP4)).status).toBe(500);
    } finally {
      chmodSync(mediaDir, 0o700);
    }
    expect(readdirSync(mediaDir).filter((name) => name.startsWith(".upload-"))).toEqual([]);
    expect((await put(sha(MP4), MP4)).status).toBe(201);
  });

  it("refuses with 507 when the board's pinned clips leave no room", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rivet-media-"));
    const store = new CommandStore(dataDir);
    const pinned = "f".repeat(64);
    store.putMedia(pinned, "video/mp4", 300, Date.now());
    const media = new MediaStore(dataDir, store, () => new Set([pinned]), 450);
    const host = createServer((request, response) => {
      media.upload(request, response, request.url!.slice(1)).catch((error: unknown) => {
        request.resume();
        response.writeHead(error instanceof HttpError ? error.status : 500).end();
      });
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    const at = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
    const send = (body: Buffer, type: string) => fetch(`${at}/${sha(body)}`, { method: "PUT", headers: { "content-type": type }, body: new Uint8Array(body) });
    expect((await send(MP4, "video/mp4")).status).toBe(507);
    expect((await send(PNG, "image/png")).status).toBe(201);
    expect(readdirSync(join(dataDir, "media")).filter((name) => name.startsWith(".upload-"))).toEqual([]);
    expect(existsSync(join(dataDir, "media", sha(MP4)))).toBe(false);
    await new Promise((resolve) => host.close(resolve));
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("never evicts a file uploaded in the last 15 minutes, and refuses an upload that would need to", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rivet-media-"));
    const store = new CommandStore(dataDir);
    let clock = Date.parse("2026-09-30T00:00:00Z");
    // Room for one PDF: a second in the same batch would have evicted the first before the board named it.
    const media = new MediaStore(dataDir, store, () => new Set(), 300, () => clock);
    const host = createServer((request, response) => {
      media.upload(request, response, request.url!.slice(1)).then(
        () => undefined,
        (error: unknown) => {
          request.resume();
          response.writeHead(error instanceof HttpError ? error.status : 500, { "content-type": "application/json" }).end(JSON.stringify({ error: (error as Error).message }));
        },
      );
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    const at = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
    const send = (body: Buffer) => fetch(`${at}/${sha(body)}`, { method: "PUT", headers: { "content-type": "application/pdf" }, body: new Uint8Array(body) });
    const first = Buffer.concat([PDF, Buffer.from("first")]);
    const second = Buffer.concat([PDF, Buffer.from("second")]);
    expect((await send(first)).status).toBe(201);
    clock += 14 * 60_000;
    const refused = await send(second);
    expect(refused.status).toBe(507);
    expect(((await refused.json()) as { error: string }).error).toMatch(/last 15 minutes/);
    expect(store.getMedia(sha(first))).not.toBeNull();
    expect(existsSync(join(dataDir, "media", sha(first)))).toBe(true);
    expect(existsSync(join(dataDir, "media", sha(second)))).toBe(false);
    clock += 2 * 60_000;
    expect((await send(second)).status).toBe(201);
    expect(store.getMedia(sha(first))).toBeNull();
    expect(existsSync(join(dataDir, "media", sha(first)))).toBe(false);
    await new Promise((resolve) => host.close(resolve));
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("takes a file it already has again near the cap, without evicting anything", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rivet-media-"));
    const store = new CommandStore(dataDir);
    const clock = Date.parse("2026-09-30T00:00:00Z");
    const media = new MediaStore(dataDir, store, () => new Set(), 700, () => clock);
    const host = createServer((request, response) => {
      const done = request.url === "/image" ? media.uploadImage(request, response) : media.upload(request, response, request.url!.slice(1));
      done.catch((error: unknown) => {
        request.resume();
        response.writeHead(error instanceof HttpError ? error.status : 500).end();
      });
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    const at = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(120, 9)]);
    const photo = () => fetch(`${at}/image`, { method: "POST", body: new Uint8Array(jpeg) });
    const pdf = () => fetch(`${at}/${sha(PDF)}`, { method: "PUT", headers: { "content-type": "application/pdf" }, body: new Uint8Array(PDF) });
    expect((await photo()).status).toBe(201);
    expect((await pdf()).status).toBe(201);
    // A recent upload leaves less room than either file, so only a copy the store already has may come in.
    store.putMedia("e".repeat(64), "video/mp4", 300, clock);
    const before = store.mediaBytes();
    expect((await photo()).status).toBe(200);
    expect((await pdf()).status).toBe(200);
    expect(store.mediaBytes()).toBe(before);
    expect(new Set(store.mediaByAge().map((item) => item.sha))).toEqual(new Set([sha(jpeg), sha(PDF), "e".repeat(64)]));
    const other = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.alloc(120, 8)]);
    expect((await fetch(`${at}/image`, { method: "POST", body: new Uint8Array(other) })).status).toBe(507);
    await new Promise((resolve) => host.close(resolve));
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses a board that newly names media the server does not have", async () => {
    const mediaDir = join(dirname(server.webRoot), "data", "media");
    const board = pdfCard("White paper.pdf");
    const refused = await putBoard(server.base, board);
    expect(refused.status).toBe(422);
    const { error } = (await refused.json()) as { error: string };
    expect(error).toContain(String(board.needs[0]!.id));
    expect(error).toContain(sha(PDF).slice(0, 12));
    expect((await put(sha(PDF), PDF, "application/pdf")).status).toBe(201);
    expect((await putBoard(server.base, board)).status).toBe(200);

    // Evicted or lost after it was published: the board that already names it still goes up.
    const store = new CommandStore(dirname(mediaDir));
    store.deleteMedia(sha(PDF));
    store.close();
    rmSync(join(mediaDir, sha(PDF)));
    board.needs[0] = { ...board.needs[0], title: "White paper, again" };
    expect((await putBoard(server.base, board)).status).toBe(200);
    const still = { sha256: "c".repeat(64), type: "image/png" };
    board.needs[1] = { ...board.needs[1], media: { kind: "stills", stills: [still] } };
    const added = await putBoard(server.base, board);
    expect(added.status).toBe(422);
    expect(((await added.json()) as { error: string }).error).toContain(String(board.needs[1]!.id));
  });

  it("never serves a path outside the store", async () => {
    for (const path of ["/media/../secret.txt", "/media/..%2Fsecret.txt", "/media/%2e%2e/%2e%2e/secret.txt", `/media/${"a".repeat(63)}`, "/media/", `/media/${"A".repeat(64)}`]) {
      const response = await rawGet(server.port, path, { cookie });
      expect(response.body, path).not.toContain("top secret");
      expect([400, 404], path).toContain(response.status);
    }
    expect((await put("../../secret", MP4)).status).toBe(404);
  });

  it("parses Range headers and sniffs file types", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-200", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-5", 100)).toEqual({ start: 95, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=5-1", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
    expect(sniffMedia(MP4)).toBe("video/mp4");
    expect(sniffMedia(PNG)).toBe("image/png");
    expect(sniffMedia(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMedia(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe("video/webm");
    expect(sniffMedia(Buffer.from("<html>"))).toBeNull();
    expect(sniffMedia(Buffer.from("ID3\x04\x00\x00\x00\x00", "latin1"))).toBe("audio/mpeg");
    expect(sniffMedia(Buffer.from([0xff, 0xfb, 0x90, 0x64]))).toBe("audio/mpeg");
    expect(sniffMedia(Buffer.from("\x00\x00\x00\x20ftypM4A \x00\x00", "latin1"))).toBe("audio/mp4");
    expect(sniffMedia(Buffer.from("\x00\x00\x00\x20ftypisom\x00\x00", "latin1"))).toBe("video/mp4");
  });

  it("a card carries optional media and older cards keep their rev", async () => {
    // A board may name only media the server has.
    const seed = new CommandStore(join(dirname(server.webRoot), "data"));
    for (const hash of [sha(MP4), ..."abc".split("").map((c) => c.repeat(64))]) seed.putMedia(hash, "video/mp4", 1, Date.now());
    seed.close();
    const before = (await (await fetch(`${server.base}/api/board`, { headers: { cookie } })).json()) as { board: { needs: { id: string; rev: string }[] } };
    const ref = { sha256: sha(MP4), type: "video/mp4" };
    const board = structuredClone(EXAMPLE_BOARD) as unknown as { needs: Record<string, unknown>[] };
    board.needs[0] = { ...board.needs[0], media: { kind: "before-after", before: ref, after: ref } };
    expect((await putBoard(server.base, board)).status).toBe(200);
    const after = (await (await fetch(`${server.base}/api/board`, { headers: { cookie } })).json()) as {
      board: { needs: { id: string; rev: string; media?: unknown }[] };
    };
    expect(after.board.needs[0]!.media).toEqual({ kind: "before-after", before: ref, after: ref });
    expect(after.board.needs[0]!.rev).not.toBe(before.board.needs[0]!.rev);
    expect(after.board.needs[1]!.rev).toBe(before.board.needs[1]!.rev);
    board.needs[0] = { ...board.needs[0], media: { kind: "before-after", before: ref } };
    expect((await putBoard(server.base, board)).status).toBe(400);
    board.needs[0] = { ...board.needs[0], media: { kind: "video", after: { sha256: "../x", type: "video/mp4" } } };
    expect((await putBoard(server.base, board)).status).toBe(400);
    const still = (c: string) => ({ sha256: c.repeat(64), type: "image/png" });
    const voice = (c: string) => ({ sha256: c.repeat(64), type: "audio/mpeg" });
    board.needs[0] = { ...board.needs[0], media: { kind: "audio", clips: [{ ...voice("a"), label: "Onyx" }, voice("b"), { sha256: "c".repeat(64), type: "audio/mp4", label: "Echo" }] } };
    expect((await putBoard(server.base, board)).status).toBe(200);
    board.needs[0] = { ...board.needs[0], media: { kind: "video", after: ref, clips: [voice("a")] } };
    expect((await putBoard(server.base, board)).status).toBe(200);
    board.needs[0] = { ...board.needs[0], media: { kind: "before-after", before: ref, after: ref, stills: [still("a"), still("b")] } };
    expect((await putBoard(server.base, board)).status).toBe(200);
    board.needs[0] = { ...board.needs[0], media: { kind: "stills", stills: [still("c")] } };
    expect((await putBoard(server.base, board)).status).toBe(200);
    const pdf = (c: string, name = "White paper.pdf") => ({ sha256: c.repeat(64), type: "application/pdf", name, bytes: 1234 });
    board.needs[0] = { ...board.needs[0], media: { kind: "files", files: [pdf("a"), pdf("b", "Deck (final) v2_1.pdf")] } };
    expect((await putBoard(server.base, board)).status).toBe(200);
    board.needs[0] = { ...board.needs[0], media: { kind: "stills", stills: [still("c")], files: [pdf("a")] } };
    expect((await putBoard(server.base, board)).status).toBe(200);
    for (const bad of [
      { kind: "files" },
      { kind: "files", files: [] },
      { kind: "files", files: Array.from({ length: 5 }, (_, i) => pdf(String(i))) },
      { kind: "files", files: [{ ...pdf("a"), sha256: "../x" }] },
      { kind: "files", files: [{ ...pdf("a"), type: "text/html" }] },
      { kind: "files", files: [{ ...pdf("a"), bytes: "1234" }] },
      { kind: "files", files: [{ ...pdf("a"), bytes: 0 }] },
      { kind: "files", files: [{ ...pdf("a"), bytes: 25 * 1024 * 1024 + 1 }] },
      { kind: "files", files: [{ ...pdf("a"), extra: 1 }] },
      { kind: "files", files: [{ sha256: "a".repeat(64), type: "application/pdf", bytes: 10 }] },
      ...['a".pdf', "../x.pdf", "x.exe", "x.pdf.exe", " x.pdf", ".pdf", "a\r\n.pdf", "é.pdf", `${"a".repeat(97)}.pdf`].map((name) => ({ kind: "files", files: [pdf("a", name)] })),
      { kind: "stills", stills: [pdf("a")] },
      { kind: "stills" },
      { kind: "stills", stills: [] },
      { kind: "stills", stills: [ref] },
      { kind: "stills", stills: Array.from({ length: 9 }, (_, i) => still(String(i))) },
      { kind: "stills", stills: [{ sha256: "../x", type: "image/png" }] },
      { kind: "audio" },
      { kind: "audio", clips: [] },
      { kind: "audio", clips: [ref] },
      { kind: "audio", clips: Array.from({ length: 7 }, (_, i) => voice(String(i))) },
      { kind: "audio", clips: [{ ...voice("a"), label: "  " }] },
      { kind: "audio", clips: [{ ...voice("a"), label: "x".repeat(41) }] },
      { kind: "audio", clips: [{ ...voice("a"), extra: 1 }] },
      { kind: "video", after: { sha256: sha(MP4), type: "audio/mpeg" } },
    ]) {
      board.needs[0] = { ...board.needs[0], media: bad };
      expect((await putBoard(server.base, board)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
  });
});

describe("server to bridge contract", () => {
  it("every action event the server streams passes the bridge's own validator", async () => {
    const bridgePath = "../bridge/lib/actions/command.mjs";
    const { validateCommand } = (await import(bridgePath)) as { validateCommand: (event: string, raw: unknown) => { ok: boolean } };
    await liveWorker();
    const stream = await connectBridge();
    await post("/api/chat", { clientId: clientId(), text: 'hi "there"\nnew line' });
    await post("/api/chat", { clientId: clientId(), text: "and a follow-up" });
    clock.advance(BATCH_QUIET_MS);
    await stream.waitFor(1);
    const events = stream.events();
    expect(events.map((event) => event.event)).toEqual(["chat"]);
    for (const event of events) expect(validateCommand(event.event, event.data), event.event).toMatchObject({ ok: true });
    stream.abort();
  });
});

describe("a merge-ready card", () => {
  const HEAD = "b".repeat(40);
  const MERGE_BOARD = {
    ...EXAMPLE_BOARD,
    needs: [
      {
        id: "mr-options",
        kind: "merge-ready",
        title: "Daily build: merge ready",
        pr: 2022,
        headSha: HEAD,
        options: [
          { label: "Merge", recommended: true },
          { label: "Hold it" },
        ],
      },
      { id: "mr-plain", kind: "merge-ready", title: "Touch guard: merge ready", pr: 105, repo: MS, headSha: HEAD },
      { id: "mr-other", kind: "merge-ready", title: "Menu fix: merge ready", pr: 105, repo: "example-org/other-repo", headSha: HEAD },
      { id: "mr-risk", kind: "merge-ready", title: "Billing: merge ready", pr: 2200, headSha: HEAD, risk: "money" },
      { id: "pr-card", kind: "approval", title: "Touch guard", pr: 105 },
    ],
  };
  const FEATURES = "image,chat-window";

  beforeEach(async () => {
    expect((await putBoard(server.base, MERGE_BOARD)).status).toBe(200);
  });

  async function answer(itemId: string, body: Record<string, unknown>, id = clientId()): Promise<Response> {
    return post("/api/replies", { clientId: id, itemId, rev: await revOf(server.base, cookie, itemId), ...body });
  }
  async function audit(): Promise<AuditEntry[]> {
    return ((await (await fetch(`${server.base}/api/audit?limit=500`, { headers: { cookie } })).json()) as { entries: AuditEntry[] }).entries;
  }
  const delivered = (id: string) =>
    fetch(`${server.base}/api/bridge/ack`, {
      method: "POST",
      headers: bearer(BRIDGE_TOKEN),
      body: JSON.stringify({ id, delivery: { target: "rivet", at: new Date().toISOString() } }),
    });

  it("refuses a merge-ready card with no pr or no headSha, and a headSha on any other card", async () => {
    const card = { id: "mr", kind: "merge-ready", title: "No PR", pr: 105, headSha: HEAD };
    const refused = async (need: Record<string, unknown>) => (await putBoard(server.base, { ...MERGE_BOARD, needs: [need] })).status;
    expect(await refused({ ...card, pr: undefined })).toBe(400);
    expect(await refused({ ...card, headSha: undefined })).toBe(400);
    expect(await refused({ ...card, headSha: "B".repeat(40) })).toBe(400);
    expect(await refused({ ...card, kind: "approval" })).toBe(400);
    expect(await refused(card)).toBe(200);
  });

  it("refuses a merge-ready card whose options share a label or do not have exactly one recommended", async () => {
    const card = { id: "mr", kind: "merge-ready", title: "Options", pr: 105, headSha: HEAD };
    const status = async (options: unknown[]) => (await putBoard(server.base, { ...MERGE_BOARD, needs: [{ ...card, options }] })).status;
    expect(await status([{ label: "Merge", recommended: true }, { label: "Merge" }])).toBe(400);
    expect(await status([{ label: "Merge" }, { label: "Hold it" }])).toBe(400);
    expect(await status([{ label: "Merge", recommended: true }, { label: "Hold it", recommended: true }])).toBe(400);
    expect(await status([{ label: "Merge", recommended: true }, { label: "Hold it" }])).toBe(200);
    // Any other kind keeps its options as they were.
    expect((await putBoard(server.base, { ...MERGE_BOARD, needs: [{ id: "d", kind: "decision", title: "D", options: [{ label: "A" }, { label: "A" }] }] })).status).toBe(200);
  });

  it("the card's headSha is part of its rev and goes into the answer's snapshot", async () => {
    const before = await revOf(server.base, cookie, "mr-plain");
    const moved = { ...MERGE_BOARD, needs: MERGE_BOARD.needs.map((need) => (need.id === "mr-plain" ? { ...need, headSha: "c".repeat(40) } : need)) };
    expect((await putBoard(server.base, moved)).status).toBe(200);
    expect(await revOf(server.base, cookie, "mr-plain")).not.toBe(before);
    await connectBridge(FEATURES);
    const reply = (await (await answer("mr-plain", { decision: "approve" })).json()) as { item: Record<string, unknown> };
    expect(reply.item).toMatchObject({ kind: "merge-ready", pr: 105, headSha: "c".repeat(40) });
  });

  it("Dismiss on a merge-ready card arms nothing and needs no confirm; it carries no answer; an old bridge refuses it", async () => {
    const refusal = async () => {
      const response = await answer("mr-risk", { decision: "dismiss" });
      return [response.status, ((await response.json()) as { error?: string }).error];
    };
    expect(await refusal()).toEqual([424, "The Mac's bridge hasn't connected since the server restarted. Try Dismiss again in a minute."]);
    await connectBridge(FEATURES);
    expect(await refusal()).toEqual([424, "The Mac's bridge needs updating before it can take Dismiss."]);
    const stream = await connectBridge(`${FEATURES},dismiss`);
    expect((await answer("mr-plain", { decision: "dismiss", text: "no" })).status).toBe(400);
    for (const itemId of ["mr-plain", "mr-risk", "mr-options"]) {
      const response = await answer(itemId, { decision: "dismiss" });
      expect(response.status, itemId).toBe(201);
      const reply = (await response.json()) as { id: string; decision: string; item: Record<string, unknown> };
      expect(reply).toMatchObject({ decision: "dismiss", item: { kind: "merge-ready" } });
      expect(reply.item.merge).toBeUndefined();
      await delivered(reply.id);
    }
    expect(await audit()).toEqual([]);
    stream.abort();
  });

  it("a Dismiss queued while a dismiss bridge was away waits for one: an older bridge is never sent it", async () => {
    const stream = await connectBridge(`${FEATURES},dismiss`);
    stream.abort();
    const reply = (await (await answer("mr-plain", { decision: "dismiss" })).json()) as { id: string };
    const old = await connectBridge(FEATURES);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(old.events().some((event) => event.event === "reply")).toBe(false);
    old.abort();
    const fresh = await connectBridge(`${FEATURES},dismiss`);
    await fresh.waitFor(1);
    expect(fresh.events().filter((event) => event.event === "reply").map((event) => (event.data as { id: string }).id)).toEqual([reply.id]);
    fresh.abort();
  });

  it("a changed answer queued while a changes bridge was away waits for one: an older bridge is never sent it", async () => {
    const stream = await connectBridge(`${FEATURES},changes`);
    expect((await answer("mr-options", { decision: "choice", choice: "Hold it" })).status).toBe(201);
    expect((await post("/api/board/needs/mr-options/again", { rev: await revOf(server.base, cookie, "mr-options") })).status).toBe(200);
    stream.abort();
    const reply = (await (await answer("mr-options", { decision: "reject", text: "Not this one" })).json()) as { id: string; item: { changes?: unknown } };
    expect(reply.item.changes).toBeDefined();
    const old = await connectBridge(FEATURES);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(old.events().some((event) => event.event === "reply" && (event.data as { id: string }).id === reply.id)).toBe(false);
    old.abort();
    const fresh = await connectBridge(`${FEATURES},changes`);
    await fresh.waitFor(1);
    expect(fresh.events().some((event) => event.event === "reply" && (event.data as { id: string }).id === reply.id)).toBe(true);
    fresh.abort();
  });
});

describe("the bridge's action acks", () => {
  it("fit the server's limits in UTF-16 units, so an emoji never refuses the whole ack", async () => {
    const libPath = "../bridge/lib/actions/command.mjs";
    const lib = (await import(libPath)) as {
      MAX_ACK_REASON: number;
      MAX_ACK_LINE: number;
      fitAckDetail(detail: Record<string, unknown>): Record<string, unknown>;
    };
    // What sanitizeLine leaves at the limits: right in code points, one over in units.
    const reason = `${"a".repeat(lib.MAX_ACK_REASON - 1)}\u{1F600}`;
    const line = `${"b".repeat(lib.MAX_ACK_LINE - 1)}\u{1F600}`;
    const ack = (detail: Record<string, unknown>) => actionAckSchema.safeParse({ id: "a-1", status: "refused", detail }).success;
    expect(ack({ reason, lines: [line] })).toBe(false);
    expect(ack(lib.fitAckDetail({ reason, lines: [line] }))).toBe(true);
    expect(ack({ reason: "a".repeat(lib.MAX_ACK_REASON), lines: ["b".repeat(lib.MAX_ACK_LINE)] })).toBe(true);
    expect(ack({ reason: "a".repeat(lib.MAX_ACK_REASON + 1) })).toBe(false);
    expect(ack({ lines: ["b".repeat(lib.MAX_ACK_LINE + 1)] })).toBe(false);
    // The preview too, a journalled one replayed after an upgrade included.
    const preview = {
      title: reason,
      headSha: "a".repeat(40),
      headRef: "feature",
      baseRef: "main",
      isDraft: false,
      state: "OPEN",
      labels: [],
      fileCount: 1,
      blocks: [reason],
      holds: [line],
    };
    expect(actionAckSchema.safeParse({ id: "a-1", status: "previewed", detail: { preview } }).success).toBe(false);
    expect(actionAckSchema.safeParse({ id: "a-1", status: "previewed", detail: lib.fitAckDetail({ preview }) }).success).toBe(true);
  });
});
