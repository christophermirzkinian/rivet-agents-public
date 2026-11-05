import type { ChatMessage } from "../src/shared/command.js";
import {
  chatBadge,
  countsUnread,
  ownsNoCard,
  SEED_IDS,
  UPDATES_ID,
  type ConversationDetail,
  type ConversationPage,
  type ConversationPhase,
  type ConversationsResponse,
  type ConversationStage,
  type ConversationSummary,
  type MergeResponse,
} from "../src/shared/conversations.js";
import { THREAD_MESSAGES_MAX } from "../src/shared/threads.js";

// A fake of the conversation routes for the chat's DOM tests: the list, "Archived", one conversation, your
// rename / Close / read marker / marked unread / pin, Mark all as read, Select mode's batch, Merge into…, and POST /api/chat with `conversation`. Messages carry their conversation in threadId.

export interface FakeConversation {
  title?: string;
  unread?: number;
  needsYou?: boolean;
  links?: Partial<ConversationSummary["links"]>;
  closed?: boolean;
  appOnly?: boolean;
  markedUnread?: boolean;
  pinned?: boolean;
  done?: boolean;
  stage?: ConversationStage;
  stagePr?: string;
  phase?: ConversationPhase;
  /** Listed under Archived whatever its Close says (from before the cutover). */
  old?: boolean;
  /** The unanswered card its Needs you names. */
  statusCard?: string;
  /** A card is filed in it; unset, it is one when a card line is in it. */
  thing?: boolean;
}

export interface FakeServer {
  messages: ChatMessage[];
  conversations: Map<string, FakeConversation>;
  posted: Record<string, unknown>[];
  patched: { id: string; body: Record<string, unknown> }[];
  requests: string[];
  /** While set, conversation detail GETs wait for `release`. */
  holdDetail: boolean;
  held: (() => void)[];
  /** Answers every request with this status while set. */
  failWith: number | null;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  row: (id: string) => ConversationSummary;
  /** What POST /api/chat answers with, from the body it got. */
  answer: (body: Record<string, unknown>) => Record<string, unknown>;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function conversationOf(message: Pick<ChatMessage, "id" | "threadId">): string {
  return message.threadId ?? message.id;
}

/**
 * As GET /api/chat?chat=1: no Updates, and in a thing nothing after its first card line but your
 * typed lines and Rivet's lines and cards that answer one.
 */
export function chatOnly(messages: readonly ChatMessage[]): ChatMessage[] {
  const carded = new Set<string>();
  const typed = (id: string | undefined) => messages.some((line) => line.id === id && line.from === "owner" && !line.card);
  return messages.filter((message) => {
    const id = conversationOf(message);
    if (id === UPDATES_ID) return false;
    if (carded.has(id)) return message.from === "owner" || typed(message.replyTo);
    if (message.posted) carded.add(id);
    return true;
  });
}

export function fakeServer(messages: ChatMessage[], conversations: Record<string, FakeConversation> = {}): FakeServer {
  let seq = 0;
  const server: FakeServer = {
    messages,
    conversations: new Map(Object.entries(conversations)),
    posted: [],
    patched: [],
    requests: [],
    holdDetail: false,
    held: [],
    failWith: null,
    fetch,
    row,
    answer: (body) => {
      const id = `c9-${++seq}`;
      const replyTo = typeof body.replyTo === "string" ? body.replyTo : undefined;
      const original = server.messages.find((message) => message.id === replyTo);
      return {
        id,
        at: new Date(Date.UTC(2031, 0, 1, 0, 0, seq)).toISOString(),
        status: "collecting",
        ...(original ? { replyTo: original.id, quote: { from: original.from, text: original.text.split("\n")[0] } } : {}),
        conversation: typeof body.conversation === "string" ? body.conversation : null,
      };
    },
  };

  function ids(): string[] {
    const all = new Set<string>(server.conversations.keys());
    for (const message of server.messages) all.add(conversationOf(message));
    return [...all];
  }

  function own(id: string): ChatMessage[] {
    return server.messages.filter((message) => conversationOf(message) === id).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  function row(id: string): ConversationSummary {
    const fields = server.conversations.get(id) ?? {};
    const last = own(id).at(-1);
    return {
      id,
      title: fields.title ?? own(id)[0]?.text.split("\n")[0] ?? id,
      lastAt: last?.at ?? "2030-01-01T00:00:00.000Z",
      lastFrom: last?.from ?? "rivet",
      lastText: last?.text.split("\n")[0] ?? "",
      unread: fields.unread ?? 0,
      needsYou: fields.needsYou ?? false,
      links: { prs: [], chats: [], tag: null, ...fields.links },
      closed: fields.closed ?? false,
      updates: id === UPDATES_ID,
      appOnly: fields.appOnly ?? false,
      markedUnread: fields.markedUnread ?? false,
      pinned: fields.pinned ?? false,
      done: fields.done ?? false,
      stage: fields.stage ?? "none",
      ...(fields.stagePr ? { stagePr: fields.stagePr } : {}),
      phase: fields.phase ?? null,
      thing: fields.thing ?? own(id).some((message) => !!message.posted),
    };
  }

  function lists(): { open: ConversationSummary[]; older: ConversationSummary[] } {
    const rows = ids().map(row);
    const byTime = (a: ConversationSummary, b: ConversationSummary) => b.lastAt.localeCompare(a.lastAt);
    // As the server: Updates is only under Archived.
    const open = rows.filter((one) => !one.updates && !one.closed && (!server.conversations.get(one.id)?.old || one.pinned || one.markedUnread)).sort(byTime);
    const top = (one: ConversationSummary) => (one.pinned ? 1 : 0);
    return { open: [...open].sort((a, b) => top(b) - top(a)), older: rows.filter((one) => !open.includes(one)).sort(byTime) };
  }

  function detail(id: string): ConversationDetail {
    const summary = row(id);
    return {
      id,
      title: summary.title,
      status: null,
      statusFrom: null,
      project: summary.appOnly ? "personal" : null,
      tag: summary.links.tag,
      ball: summary.needsYou ? "owner" : null,
      startedBy: own(id)[0]?.from ?? "owner",
      count: own(id).length,
      lastAt: summary.lastAt,
      lastFrom: summary.lastFrom,
      lastText: summary.lastText,
      steps: [],
      messages: own(id).slice(-THREAD_MESSAGES_MAX),
      more: own(id).length > THREAD_MESSAGES_MAX,
      conversation: summary,
      ...(server.conversations.get(id)?.statusCard ? { statusCard: server.conversations.get(id)!.statusCard } : {}),
    };
  }

  async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input), "http://x");
    const method = init?.method ?? "GET";
    server.requests.push(`${method} ${url.pathname}${url.search}`);
    if (server.failWith !== null) return json({ error: "down" }, server.failWith);
    if (url.pathname === "/api/chat" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      server.posted.push(body);
      const answer = server.answer(body);
      // As the server does: the message lands in its conversation, a new one when null, and reopens a closed one.
      const conversation = typeof body.conversation === "string" ? body.conversation : String(answer.id);
      server.messages.push({ id: String(answer.id), from: "owner", text: String(body.text ?? ""), at: String(answer.at), status: "sent", threadId: conversation });
      const fields = server.conversations.get(conversation);
      if (fields?.closed) fields.closed = false;
      return json(answer);
    }
    if (url.pathname === "/api/conversations") {
      const { open, older } = lists();
      const unread = chatBadge(open);
      if (url.searchParams.get("older") !== "1") return json({ conversations: open, older: older.length, unread } satisfies ConversationsResponse);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const from = Number(url.searchParams.get("before") ?? 0);
      const page = older.slice(from, from + limit);
      return json({ conversations: page, older: older.length, unread, ...(from + limit < older.length ? { next: String(from + limit) } : {}) } satisfies ConversationsResponse);
    }
    if (url.pathname === "/api/conversations/batch" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { ids: string[]; action: string };
      server.posted.push(body);
      if (body.ids.length < 1 || body.ids.length > 100) return json({ error: "invalid conversation batch" }, 400);
      let changed = 0;
      // As the server: any message's id names its conversation, once; an id naming nothing is left.
      const named = body.ids.map((one) => {
        const found = server.messages.find((message) => message.id === one);
        return found ? conversationOf(found) : server.conversations.has(one) ? one : null;
      });
      for (const id of new Set(named)) {
        if (id === null || (id === UPDATES_ID && body.action === "close")) continue;
        const fields = server.conversations.get(id) ?? {};
        if (body.action === "read") Object.assign(fields, { unread: 0, markedUnread: false });
        if (body.action === "unread") Object.assign(fields, { markedUnread: true, closed: false });
        if (body.action === "close") Object.assign(fields, { closed: true, pinned: false, markedUnread: false });
        if (body.action === "reopen") fields.closed = false;
        server.conversations.set(id, fields);
        changed += 1;
      }
      return json({ changed });
    }
    if (url.pathname === "/api/conversations/read" && method === "POST") {
      const { open } = lists();
      const changed = open.filter(countsUnread);
      for (const one of changed) server.conversations.set(one.id, { ...server.conversations.get(one.id), unread: 0, markedUnread: false });
      return json({ read: changed.length });
    }
    const merging = /^\/api\/conversations\/([^/]+)\/merge$/.exec(url.pathname);
    if (merging && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { into: string };
      server.posted.push(body);
      const id = decodeURIComponent(merging[1]!);
      if (!ids().includes(id) || !ids().includes(body.into)) return json({ error: "no such conversation" }, 404);
      // As the server: never the server's own conversations, never one into itself, never across app-only and shareable.
      if (ownsNoCard(id) || ownsNoCard(body.into) || id === body.into) return json({ error: "That conversation can't be merged." }, 409);
      if (row(id).appOnly !== row(body.into).appOnly) return json({ error: "An app-only conversation can't merge with a shareable one." }, 409);
      const moving = own(id);
      for (const message of moving) message.threadId = body.into;
      server.conversations.delete(id);
      return json({ moved: moving.length, conversation: detail(body.into) } satisfies MergeResponse);
    }
    if (url.pathname.startsWith("/api/conversations/")) {
      const raw = decodeURIComponent(url.pathname.slice("/api/conversations/".length));
      const found = server.messages.find((message) => message.id === raw);
      const id = found ? conversationOf(found) : server.conversations.has(raw) ? raw : null;
      if (!id) return json({ error: "no such thread" }, 404);
      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        server.patched.push({ id, body });
        const fields = server.conversations.get(id) ?? {};
        if (body.title !== undefined) fields.title = (body.title as string | null) ?? undefined;
        if (body.closed !== undefined) fields.closed = body.closed as boolean;
        if (body.read !== undefined) {
          fields.unread = 0;
          fields.markedUnread = false;
        }
        if (body.unread !== undefined) fields.markedUnread = body.unread as boolean;
        if (body.pinned !== undefined) fields.pinned = body.pinned as boolean;
        // As the server: pinning or marking unread reopens it; closing puts both away.
        if (body.closed === true) Object.assign(fields, { pinned: false, markedUnread: false });
        else if (body.closed === undefined && (body.unread === true || body.pinned === true)) fields.closed = false;
        server.conversations.set(id, fields);
        return json(detail(id));
      }
      const before = url.searchParams.get("before");
      if (before !== null) {
        const all = own(id);
        const at = all.findIndex((message) => message.id === before);
        if (at < 0) return json({ error: "before is not a message of this conversation" }, 400);
        return json({ messages: all.slice(Math.max(0, at - THREAD_MESSAGES_MAX), at), more: at > THREAD_MESSAGES_MAX } satisfies ConversationPage);
      }
      if (server.holdDetail) await new Promise<void>((resolve) => server.held.push(resolve));
      return json(detail(id));
    }
    if (url.pathname === "/api/chat") {
      // As the server: newest `limit` before the cursor, in the order messages arrived, and the next cursor while more are left.
      const all = (url.searchParams.get("chat") === "1" ? chatOnly(server.messages) : server.messages).filter((message) => !SEED_IDS.includes(message.id));
      const before = url.searchParams.get("before");
      const end = before === null ? all.length : all.findIndex((message) => message.id === before);
      if (end < 0) return json({ messages: [], older: null });
      const limit = Number(url.searchParams.get("limit") ?? 30);
      const page = all.slice(Math.max(0, end - limit), end);
      return json({ messages: page, older: end > limit ? page[0]!.id : null });
    }
    return json({});
  }

  return server;
}

/** GET /api/conversations/:id's answer for conversation `id` holding `messages`, whatever their threadId says. */
export function detailBody(id: string, messages: readonly ChatMessage[], over: Partial<ConversationSummary> = {}): ConversationDetail {
  const server = fakeServer(messages.map((message) => ({ ...message, threadId: id })), { [id]: {} });
  const summary = { ...server.row(id), ...over };
  return {
    id,
    title: summary.title,
    status: null,
    statusFrom: null,
    project: summary.appOnly ? "personal" : null,
    tag: summary.links.tag,
    ball: null,
    startedBy: messages[0]?.from ?? "owner",
    count: messages.length,
    lastAt: summary.lastAt,
    lastFrom: summary.lastFrom,
    lastText: summary.lastText,
    steps: [],
    messages: messages.map((message) => ({ ...message, threadId: message.threadId ?? id })),
    more: false,
    conversation: summary,
  };
}

export const EMPTY_LIST: ConversationsResponse = { conversations: [], older: 0, unread: 0 };
