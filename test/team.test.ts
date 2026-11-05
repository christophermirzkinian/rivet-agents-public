import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommandStore } from "../src/server/commandstore.js";
import type { PushSender } from "../src/server/push.js";
import type { PushSubscriptionRow } from "../src/server/store.js";
import { summaryLine, teamTick } from "../src/server/routes/team.js";
import type { AuditEntry, ChatMessage } from "../src/shared/command.js";
import { TEAM_ROOM_ID, TEAM_ROOM_KEEP_MS, type ConversationDetail, type ConversationsResponse } from "../src/shared/conversations.js";
import type { SnapshotWorker } from "../src/shared/workers.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, browser, putBoard, startServer, type TestServer } from "./helpers.js";

const MS = "example-org/example-repo";
const VAPID = {
  RIVET_VAPID_PUBLIC_KEY: "BPublicKeyForTests",
  RIVET_VAPID_PRIVATE_KEY: "private-key-for-tests",
  RIVET_VAPID_SUBJECT: "mailto:ops@example.com",
};

class FakeSender implements PushSender {
  readonly tags: string[] = [];
  async send(_target: PushSubscriptionRow, payload: string): Promise<number> {
    this.tags.push((JSON.parse(payload) as { tag: string }).tag);
    return 201;
  }
}

let server: TestServer;
let sender: FakeSender;
let cookie: string;
let seq = 0;
const clientId = () => `client-${Date.now()}-${(seq += 1)}`;

beforeEach(async () => {
  sender = new FakeSender();
  server = await startServer(VAPID, { pushSender: sender });
  cookie = server.cookie();
  await putBoard(server.base);
  await fetch(`${server.base}/api/push/subscribe`, {
    method: "POST",
    headers: browser(cookie),
    body: JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/device-1", keys: { p256dh: "BKey1", auth: "auth1" } }),
  });
});

afterEach(async () => {
  await server.close();
});

const agent = (body: Record<string, unknown>, token = BOARD_TOKEN) =>
  fetch(`${server.base}/api/team/message`, { method: "POST", headers: bearer(token), body: JSON.stringify(body) });

async function list(): Promise<ConversationsResponse> {
  return (await (await fetch(`${server.base}/api/conversations`, { headers: { cookie } })).json()) as ConversationsResponse;
}

async function room(): Promise<ConversationDetail> {
  return (await (await fetch(`${server.base}/api/conversations/${TEAM_ROOM_ID}`, { headers: { cookie } })).json()) as ConversationDetail;
}

async function liveWorkers(chats: string[]): Promise<void> {
  const workers: SnapshotWorker[] = chats.map((chat) => ({
    worktreeId: createHash("sha256").update(`${MS}/${chat}`).digest("hex").slice(0, 16),
    repo: MS,
    chat,
    connected: true,
    lastOutputAt: Date.now(),
    agent: "claude",
  }));
  expect((await fetch(`${server.base}/api/bridge/workers`, { method: "PUT", headers: bearer(BRIDGE_TOKEN), body: JSON.stringify({ workers }) })).status).toBe(200);
}

/** The bridge's event stream: what the server sent the Mac. */
async function connectBridge(): Promise<{ events(): { event: string; data: Record<string, unknown> }[]; waitFor(count: number): Promise<void> }> {
  const response = await fetch(`${server.base}/api/bridge/events`, { headers: { ...bearer(BRIDGE_TOKEN), "x-rivet-bridge-features": "image,chat-window" } });
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
        return { event: fields.event!, data: JSON.parse(fields.data!) as Record<string, unknown> };
      });
  return {
    events,
    async waitFor(count) {
      for (let i = 0; i < 200 && events().length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}

describe("agent messages", () => {
  it("land in the listed Team room on the board token, never unread, pushed or the Chat tab's badge", async () => {
    // Agent Chat is listed before any traffic, so Sam can find it.
    expect((await list()).conversations.find((one) => one.id === TEAM_ROOM_ID)).toMatchObject({ title: "Agent Chat", unread: 0, closed: false });
    expect((await agent({ id: "toolu_1", from: "notes", to: "monitor-one", text: "hi" }, BRIDGE_TOKEN)).status).toBe(401);
    expect((await agent({ id: "toolu_1", from: "notes", to: "monitor one", text: "hi" })).status).toBe(400);
    // Words, not one long run of a letter, which the server's redactor reads as a token.
    const long = `Shipped the filters.\n${"xxxxxxxxxx ".repeat(82)}`;
    expect((await agent({ id: "toolu_1", from: "notes-app-build", to: "monitor-one", text: long })).status).toBe(201);
    expect((await agent({ id: "toolu_1", from: "notes-app-build", to: "monitor-one", text: long })).status).toBe(200);
    expect((await agent({ id: "toolu_2", from: "monitor-one", to: "tasks-app", text: "Rework the forms?" })).status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sender.tags).toEqual([]);

    const listed = await list();
    const row = listed.conversations.find((one) => one.id === TEAM_ROOM_ID)!;
    expect(row).toMatchObject({ title: "Agent Chat", unread: 0, needsYou: false, lastText: "monitor-one → tasks-app: Rework the forms?", stage: "none" });
    expect(listed.unread).toBe(0);

    const detail = await room();
    const said = detail.messages.filter((message) => message.id !== TEAM_ROOM_ID);
    expect(said.map((message) => [message.team, Array.from(message.text).length])).toEqual([
      [{ from: "notes-app-build", to: "monitor-one" }, 600],
      [{ from: "monitor-one", to: "tasks-app" }, "Rework the forms?".length],
    ]);
    // The desktop strip's dot reads /api/chat: room traffic is no news there.
    const page = (await (await fetch(`${server.base}/api/chat`, { headers: { cookie } })).json()) as { messages: ChatMessage[] };
    expect(page.messages.filter((message) => message.threadId === TEAM_ROOM_ID)).toEqual([]);
    // Nor does the titler's model ever read it.
    const untitled = (await (await fetch(`${server.base}/api/bridge/threads/untitled`, { headers: bearer(BRIDGE_TOKEN) })).json()) as { threads: { id: string }[] };
    expect(untitled.threads.map((thread) => thread.id)).not.toContain(TEAM_ROOM_ID);
  });
});

describe("Sam in the Team room", () => {
  it("every line goes to Rivet, even one naming a live chat or replying to its message: none is typed into a chat", async () => {
    await liveWorkers(["notes-app-build", "tasks-app-forms", "monitor-one"]);
    await agent({ id: "toolu_1", from: "tasks-app-forms", to: "monitor-one", text: "Forms reworked." });
    const said = (await room()).messages.find((message) => message.team)!;
    const bridge = await connectBridge();

    const named = await fetch(`${server.base}/api/chat`, { method: "POST", headers: browser(cookie), body: JSON.stringify({ clientId: clientId(), text: "notes: show me the filters", conversation: TEAM_ROOM_ID }) });
    expect(named.status).toBe(202);
    expect(await named.json()).toMatchObject({ kind: "chat", text: "notes: show me the filters", conversation: TEAM_ROOM_ID });
    const replied = await fetch(`${server.base}/api/chat`, { method: "POST", headers: browser(cookie), body: JSON.stringify({ clientId: clientId(), text: "nice", replyTo: said.id }) });
    expect(replied.status).toBe(202);
    // His answer names the chat whose line it answers, so Rivet knows whom to pass it to.
    expect(await replied.json()).toMatchObject({ kind: "chat", text: "nice", replyTo: said.id, quote: { from: "rivet", text: "tasks-app-forms: Forms reworked." } });
    expect((await room()).messages.filter((message) => message.from === "owner").map((message) => message.text)).toEqual(["notes: show me the filters", "nice"]);

    const lines: AuditEntry[] = [];
    for (const text of ["what is everyone on?", "nobody: hi", "@monitor-one route this"]) {
      const response = await fetch(`${server.base}/api/chat`, { method: "POST", headers: browser(cookie), body: JSON.stringify({ clientId: clientId(), text, conversation: TEAM_ROOM_ID }) });
      lines.push((await response.json()) as AuditEntry);
    }
    expect(lines.map((line) => line.kind)).toEqual(["chat", "chat", "chat"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.events().filter((event) => event.event === "send")).toEqual([]);
    // The monitor's answer lands in the room, and pushes nothing there either.
    const answer = await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ replyTo: lines[0]!.id, text: "Notes is on filters." }) });
    expect(((await answer.json()) as ChatMessage).threadId).toBe(TEAM_ROOM_ID);
    // A card beside a room reply is a card like any other, never one living in the room.
    const carded = await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ replyTo: lines[1]!.id, text: "Filters ready", card: true }) });
    expect(carded.status).toBe(201);
    expect((await room()).messages.find((message) => message.id === lines[1]!.id)?.status, "the card answers his line").toBe("replied");
    // A question back to him in the room is a question card, also kept out of the room.
    const asked = await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ replyTo: lines[2]!.id, text: "Route it to Notes?" }) });
    expect(((await asked.json()) as { card?: string }).card).toBeTruthy();
    expect((await room()).messages.filter((message) => message.card)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Only the card pushed, as cards do (a thread's new-card tag); nothing from the room itself.
    expect(sender.tags.every((tag) => tag.startsWith("thread-") || tag.startsWith("need-")) && sender.tags.length === 2, JSON.stringify(sender.tags)).toBe(true);
  });

  it("the board token answers only Sam's room lines: a reply or ack to any other room line reads none of it", async () => {
    await agent({ id: "toolu_2", from: "tasks-app-forms", to: "monitor-one", text: "Secret plan." });
    const said = (await room()).messages.find((message) => message.team)!;
    for (const target of [said.id, TEAM_ROOM_ID]) {
      const reply = await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ replyTo: target, text: "ok" }) });
      expect(reply.status, target).toBe(404);
      expect(await reply.text()).not.toContain("Secret");
      const ack = await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ replyTo: target, ack: "seen" }) });
      expect(ack.status, target).toBe(404);
    }
    expect((await room()).messages.filter((message) => message.from === "rivet" && !message.team && message.id !== TEAM_ROOM_ID), "nothing posted in the room").toEqual([]);
    // Sam's own room line reached Rivet as his message, so answering it reads nothing new.
    const line = (await (
      await fetch(`${server.base}/api/chat`, { method: "POST", headers: browser(cookie), body: JSON.stringify({ clientId: clientId(), text: "what is everyone on?", conversation: TEAM_ROOM_ID }) })
    ).json()) as AuditEntry;
    const answer = await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ replyTo: line.id, text: "Notes is on filters." }) });
    expect(answer.status).toBe(201);
    expect(await answer.json()).toMatchObject({ threadId: TEAM_ROOM_ID, quote: { from: "owner", text: "what is everyone on?" } });
    // His answer to the agent's line quotes it; acking or answering his answer still shows none of it.
    const nice = (await (
      await fetch(`${server.base}/api/chat`, { method: "POST", headers: browser(cookie), body: JSON.stringify({ clientId: clientId(), text: "nice", replyTo: said.id }) })
    ).json()) as AuditEntry;
    const acked = await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ replyTo: nice.id, ack: "seen" }) });
    expect(acked.status).toBe(200);
    const ackText = await acked.text();
    expect(JSON.parse(ackText)).toMatchObject({ id: nice.id, ack: { text: "seen" } });
    expect(ackText).not.toContain("Secret");
    const thanked = await fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ replyTo: nice.id, text: "Thanks." }) });
    expect(thanked.status).toBe(201);
    expect(await thanked.text()).not.toContain("Secret");
    expect((await room()).messages.find((message) => message.id === nice.id)?.quote?.text, "Sam still sees what he answered").toContain("Secret");
  });

  it("can never be marked unread", async () => {
    await agent({ id: "toolu_1", from: "notes-app-build", to: "monitor-one", text: "hi" });
    await list();
    const marked = await fetch(`${server.base}/api/conversations/batch`, { method: "POST", headers: browser(cookie), body: JSON.stringify({ ids: [TEAM_ROOM_ID], action: "unread" }) });
    expect(marked.status).toBe(200);
    const listed = await list();
    expect(listed.conversations.find((one) => one.id === TEAM_ROOM_ID)).toMatchObject({ markedUnread: false, unread: 0 });
  });

  it("cannot be closed: Agent Chat is never under Archived", async () => {
    await list();
    const closed = await fetch(`${server.base}/api/conversations/batch`, { method: "POST", headers: browser(cookie), body: JSON.stringify({ ids: [TEAM_ROOM_ID], action: "close" }) });
    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual({ changed: 0 });
    const patched = await fetch(`${server.base}/api/conversations/${TEAM_ROOM_ID}`, { method: "PATCH", headers: browser(cookie), body: JSON.stringify({ closed: true }) });
    expect(patched.status).toBe(409);
    expect((await list()).conversations.find((one) => one.id === TEAM_ROOM_ID)).toMatchObject({ closed: false });
  });
});

describe("hourly summary and the week's keep", () => {
  let dir: string;
  let commands: CommandStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rivet-team-"));
    commands = new CommandStore(dir);
  });
  afterEach(() => {
    commands.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const add = (id: string, from: string, to: string, text: string, at: string) => {
    commands.ensureTeamRoom(at);
    commands.addChatMessage({ id, from: "rivet", text, at, thread: TEAM_ROOM_ID, team: { from, to } });
  };

  it("one line per hour with traffic, from counts and first lines; nothing for a quiet hour; a week kept", () => {
    add("a", "notes-app-build", "monitor-one", "Shipped filters\nmore", "2026-10-06T01:05:00.000Z");
    add("b", "notes-app-build", "monitor-one", "Filters merged", "2026-10-06T01:20:00.000Z");
    add("c", "tasks-app", "monitor-one", "Reworking forms", "2026-10-06T01:40:00.000Z");
    add("d", "monitor-one", "tasks-app", "ok", "2026-10-06T02:10:00.000Z");
    expect(teamTick(commands, new Date("2026-10-06T01:59:00.000Z"))).toBeNull();
    const summary = teamTick(commands, new Date("2026-10-06T02:00:30.000Z"))!;
    expect(summary.text).toBe("Last hour: 3 messages, 3 chats — notes-app-build: Filters merged; tasks-app: Reworking forms");
    expect(summary.threadId).toBe(TEAM_ROOM_ID);
    expect(teamTick(commands, new Date("2026-10-06T02:01:30.000Z")), "once an hour").toBeNull();
    // 03:00 summarises 02:00–03:00 (one message); 05:00 has none to summarise.
    expect(teamTick(commands, new Date("2026-10-06T03:00:10.000Z"))!.text).toBe("Last hour: 1 message, 2 chats — monitor-one: ok");
    expect(teamTick(commands, new Date("2026-10-06T05:00:10.000Z"))).toBeNull();

    // Sam's line in the room (its action shares its id) and the agent line he quoted go with the week too.
    commands.addAction({ id: "e", clientId: "e", kind: "send", request: { repo: MS, chat: "tasks-app", text: "go", quote: { from: "rivet", text: "Shipped filters" } }, at: "2026-10-06T01:10:00.000Z" });
    commands.addChatMessage({ id: "e", from: "owner", text: "go", at: "2026-10-06T01:10:00.000Z", thread: TEAM_ROOM_ID });
    teamTick(commands, new Date(Date.parse("2026-10-06T01:30:00.000Z") + TEAM_ROOM_KEEP_MS));
    expect(["a", "b", "c", "d", "e"].map((id) => commands.getChatMessage(id) !== null)).toEqual([false, false, true, true, false]);
    expect(commands.getAction("e")).toMatchObject({ kind: "send", chat: "tasks-app", text: "" });
    expect(commands.getAction("e")!.quote).toBeUndefined();
    expect(commands.getChatMessage(TEAM_ROOM_ID), "the heading stays").not.toBeNull();
  });

  it("summaryLine names at most four chats, busiest first", () => {
    const messages = ["a", "b", "b", "c", "d", "e", "e", "e"].map((from) => ({ from, to: "monitor-one", text: `${from} news` }));
    expect(summaryLine(messages)).toBe("Last hour: 8 messages, 6 chats — e: e news; b: b news; a: a news; c: c news");
    expect(summaryLine([])).toBeNull();
    expect(summaryLine([{ from: "rivet", to: "notes", text: "all ok" }])).toBe("Last hour: 1 message, 2 chats — Rivet: all ok");
  });
});
