import type { FileRef } from "../../src/shared/board.js";
import type { AuditEntry, ChatMessage, ChatPage, LogsResponse } from "../../src/shared/command.js";
import { FINAL_STATUSES, imageFields } from "../../src/shared/command.js";
import type { SearchItem } from "../../src/shared/search.js";
import type { Worker } from "../../src/shared/workers.js";
import type {
  BatchResponse,
  ConversationAction,
  ConversationDetail,
  ConversationPage,
  ConversationPatch,
  ConversationsResponse,
} from "../../src/shared/conversations.js";
import { ApiError, call, getIfChanged } from "./api.js";
import { onSessionReset, sameSession, StaleSession } from "./session.js";

/** The clientId of each request still waiting for an answer, keyed by what it asks for. */
const unresolved = new Map<string, string>();
/** No answer, a timeout, a rate limit or any 5xx but one saying it was never sent: the action may have happened. */
const lostAnswer = (error: unknown): boolean =>
  error instanceof ApiError && !error.undelivered && (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500);

const pendingNotes = new Map<string, Promise<AuditEntry>>();
// A send still out from an earlier session answers StaleSession; the next session's same send makes its own request.
onSessionReset(() => pendingNotes.clear());
/** A sheet message is its chat, the PR its opener is about and the words typed: the same words from another card are another. */
const workerMessageKey = (worker: Worker, body: string, about?: number): string => JSON.stringify(["worker", worker.repo, worker.chat, about ?? null, body]);

/** A tagged message to Rivet: its text with the chat's tag, and the conversation it goes in (null starts one). */
export interface Note {
  text: string;
  conversation: string | null;
}
/** By what the owner typed and where: the note it first went as, while its outcome is unknown. */
const notesOut = new Map<string, Note>();

/**
 * Sends an action under one clientId until its outcome is known. A retry after a
 * lost response (no answer, 408, 429 or any 5xx not marked undelivered) reuses the id, so the server
 * hands back the action it already started instead of starting a second one;
 * only success or a coded 4xx refusal lets it go. An answer that names no action
 * counts as lost too.
 */
export async function once<T extends { id: string }>(key: string, send: (clientId: string) => Promise<T>): Promise<T> {
  let id = unresolved.get(key);
  if (!id) {
    id = crypto.randomUUID();
    unresolved.set(key, id);
  }
  try {
    const result = await send(id);
    if (typeof result?.id !== "string" || !result.id) throw new ApiError(0, "The server's answer was cut off. Try again to check.");
    unresolved.delete(key);
    return result;
  } catch (error) {
    // An answer that came after its session ended is not known either: the next session's retry keeps the clientId.
    if (!lostAnswer(error) && !(error instanceof StaleSession)) unresolved.delete(key);
    throw error;
  }
}

export const getChat = (before?: string | null, limit = 30, chat = false) =>
  call<ChatPage>("GET", `/api/chat?limit=${limit}${chat ? "&chat=1" : ""}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
export const getConversations = (older?: { before?: string | null; limit?: number }) =>
  call<ConversationsResponse>(
    "GET",
    `/api/conversations${older ? `?older=1${older.limit ? `&limit=${older.limit}` : ""}${older.before ? `&before=${encodeURIComponent(older.before)}` : ""}` : ""}`,
  );
/** Any message's id opens the conversation it is in. */
export const getConversation = (id: string) => call<ConversationDetail>("GET", `/api/conversations/${encodeURIComponent(id)}`);
/** Conversation `id`'s messages older than its message `before`. */
export const getConversationPage = (id: string, before: string) =>
  call<ConversationPage>("GET", `/api/conversations/${encodeURIComponent(id)}?before=${encodeURIComponent(before)}`);
export const patchConversation = (id: string, patch: ConversationPatch) => call<ConversationDetail>("PATCH", `/api/conversations/${encodeURIComponent(id)}`, patch);
/** One action on several conversations at once: Chat marks its lines read this way. */
export const batchConversations = (ids: readonly string[], action: ConversationAction) => call<BatchResponse>("POST", "/api/conversations/batch", { ids, action });
export const searchChat = (query: string) => call<{ results: SearchItem[] }>("GET", `/api/chat/search?q=${encodeURIComponent(query)}`);
/** `conversation`: the open conversation it is typed in, or null to start a new one; every caller picks. */
export const sendChat = (text: string, images: readonly string[], files: readonly FileRef[], replyTo: string | undefined, conversation: string | null) =>
  once(`chat\n${text}\n${images.join(",")}\n${files.map((file) => file.sha256).join(",")}\n${replyTo ?? ""}\n${String(conversation)}`, (clientId) =>
    call<AuditEntry>("POST", "/api/chat", {
      clientId,
      ...(text ? { text } : {}),
      ...imageFields(images),
      ...(files.length ? { files } : {}),
      ...(replyTo ? { replyTo } : {}),
      conversation,
    }),
  );

/**
 * The note `key` goes as: the one still out from an unanswered try, so a retry is that
 * request under its clientId even if the tag or the room has changed since; else `fresh`.
 */
export const noteFor = (key: string, fresh: Note): Note => notesOut.get(key) ?? fresh;

/**
 * Sends `note` as `key`'s, held for its retry until success or a refusal says what became of it. A send of `key` while
 * one is still out (its sheet or ticket closed and reopened) shares that try's answer instead of racing it.
 */
export function sendNote(key: string, note: Note): Promise<AuditEntry> {
  const pending = pendingNotes.get(key);
  if (pending) return pending;
  const current = sameSession();
  notesOut.set(key, note);
  const request = sendChat(note.text, [], [], undefined, note.conversation)
    .then(
      (entry) => {
        notesOut.delete(key);
        return entry;
      },
      (error: unknown) => {
        if (!lostAnswer(error) && !(error instanceof StaleSession)) notesOut.delete(key);
        throw error;
      },
    )
    .finally(() => {
      if (current()) pendingNotes.delete(key);
    });
  pendingNotes.set(key, request);
  return request;
}

/** The text a worker sheet's `body` goes to Rivet as: `tagged` (its chat's tag, when about one), or a try's still out. */
export const workerMessageText = (worker: Worker, body: string, tagged: string, about?: number): string =>
  noteFor(workerMessageKey(worker, body, about), { text: tagged, conversation: null }).text;

/** A worker sheet's message, to Rivet on a new conversation: `text` from workerMessageText for the `body` typed. */
export const sendWorkerMessage = (worker: Worker, body: string, text: string, about?: number): Promise<AuditEntry> =>
  sendNote(workerMessageKey(worker, body, about), { text, conversation: null });

export const getAction = (id: string) => call<AuditEntry>("GET", `/api/actions/status?id=${encodeURIComponent(id)}`);

export const subscribeLogs = (repo: string, chat: string) => call<{ leaseUntil: string }>("POST", "/api/logs/subscribe", { repo, chat });
export const releaseLogs = (repo: string, chat: string) => call<{ ok: true }>("POST", "/api/logs/release", { repo, chat }, true);
const logsPath = (repo: string, chat: string) => `/api/logs?repo=${encodeURIComponent(repo)}&chat=${encodeURIComponent(chat)}`;
/** The log unless it is still the copy `etag` names: null on the server's 304. */
export const getLogsIfChanged = (repo: string, chat: string, etag: string | null) =>
  getIfChanged<LogsResponse>(logsPath(repo, chat), etag).then((next) => (next ? { logs: next.value, etag: next.etag } : null));

/**
 * Follows an action until it reaches a final status, calling `update` on each
 * change. Returns a stop function. Deploys keep reporting while they run.
 */
export function followAction(id: string, update: (entry: AuditEntry) => void, everyMs = 2500, gone?: (status: 401 | 404) => void): () => void {
  let stopped = false;
  let last = "";
  let timer = 0;
  // A follower from an earlier session stops: its action is no longer this session's to show.
  const current = sameSession();
  const tick = async () => {
    if (stopped || !current()) return;
    // Hidden, nobody reads it: the next look waits for the app to be in front.
    if (document.visibilityState === "hidden") {
      timer = window.setTimeout(() => void tick(), everyMs);
      return;
    }
    try {
      const entry = await getAction(id);
      if (stopped || !current()) return;
      const key = `${entry.status}/${entry.updatedAt}`;
      if (key !== last) {
        last = key;
        update(entry);
      }
      if (FINAL_STATUSES.has(entry.status)) return;
    } catch (error) {
      if (error instanceof StaleSession) return;
      if (error instanceof ApiError && (error.status === 401 || error.status === 404)) {
        if (!stopped) gone?.(error.status);
        return;
      }
    }
    timer = window.setTimeout(() => void tick(), everyMs);
  };
  timer = window.setTimeout(() => void tick(), 600);
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}

export const getAudit = (limit = 30) => call<{ entries: AuditEntry[] }>("GET", `/api/audit?limit=${limit}`);

export type { AuditEntry, ChatMessage };
