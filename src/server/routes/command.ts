import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import { DECISION, OUTCOME_OPTIONS, QUESTION } from "../../shared/answers.js";
import { MAX_ASKS } from "../../shared/asks.js";
import { MAX_OPS_STATUSES } from "../../shared/ops-status.js";
import { comingChatRepo, NO_REPO, ID_PATTERN, mediaShas, type ComingItem, type Reply } from "../../shared/board.js";
import {
  actionAckSchema,
  chatCreateSchema,
  chatImages,
  FIX_IT_BY,
  FIX_IT_NOTE,
  fixCreateSchema,
  fixText,
  imageFields,
  PICKUP_DUE_MINUTES,
  PICKUP_WHY,
  isSayCard,
  IMAGE_TYPES,
  logsLeaseSchema,
  MAX_CHAT_IMAGE_BYTES,
  MAX_LOG_LINE,
  MAX_LOG_LINES,
  MAX_QUOTE_TEXT,
  MAX_WORKER_TEXT,
  quoteText,
  saySchema,
  scheduleCreateSchema,
  SHA_PATTERN,
  type ActionKind,
  type AuditEntry,
  type ChatMessage,
  type FixCreate,
} from "../../shared/command.js";
import { APP_NAME } from "../../shared/names.js";
import { REPO_RE } from "../../shared/repos.js";
import type { SearchItem } from "../../shared/search.js";
import { idLike, namedPrs, textWords, THREAD_WINDOW_MS, type PrRef } from "../../shared/threads.js";
import { CommandStore, type ActionRequest } from "../commandstore.js";
import { HttpError, json, readJson, requireBearer, requireSameOrigin } from "../httputil.js";
import { LogLeases } from "../logs.js";
import { allAsksByThread, noticeThreads } from "../threads.js";
import { resolveConversation } from "../conversations.js";
import { ownsNoCard, TEAM_ROOM_ID, UPDATES_ID } from "../../shared/conversations.js";
import { ensureAsk } from "./asks.js";
import { registerConversations } from "./conversations.js";
import { writeOpsStatus } from "./ops-status.js";
import { registerBacklog } from "./backlog.js";
import { registerJobs } from "./jobs.js";
import { registerMedia } from "./media.js";
import { registerTeamRoom } from "./team.js";
import { MediaStore, sameFiles, storedFiles } from "../media.js";
import { rivetPayload } from "../push.js";
import { deriveWorkers } from "../workers.js";
import type { RouteContext, Router } from "./router.js";
import { registerThreads } from "./threads.js";
import { parseRedacted, redactFeed, redactLog, redactScreen, SAY_MEDIA } from "../redact.js";
import { RIVET_NAME, searchNeedles } from "../../shared/names.js";


const SMALL_BODY_MAX = 64 * 1024;
/** An action's body: a chat message's MAX_CHAT_TEXT characters at up to 6 bytes each once JSON-escaped, with room to spare. */
const ACTION_BODY_MAX = 160 * 1024;
const LOGS_BODY_MAX = 256 * 1024;
/** Why an action the offline bridge never got failed; a retry of it answers 503 again. */
const OFFLINE = "the Mac bridge is offline";
const STREAM_PING_MS = 25_000;
const SWEEP_MS = 15_000;
const BATCH_SWEEP_MS = 1_000;
const OUTSTANDING_WINDOW_MS = 24 * 60 * 60_000;
const OUTSTANDING_MAX = 200;
/** True when `text` names `word` as a whole word (an ask id, a chat name). */
function namesWord(text: string, word: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_-])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`, "i").test(text);
}

/** needSchema's title cap. */
const MAX_CARD_TITLE = 300;
/** Your message into the old Updates conversation, read-only: news is update cards. */
const UPDATES_READ_ONLY = "Updates is read-only now: news comes as update cards (Feed › Updates). Start a new conversation to write.";

const logsUploadSchema = z
  .object({
    repo: z.string().regex(REPO_RE),
    chat: logsLeaseSchema.shape.chat,
    lines: z.array(z.string().max(MAX_LOG_LINE)).max(MAX_LOG_LINES),
    reset: z.boolean().optional(),
  })
  .strict();

/** The SSE event the bridge receives for each kind of action. */
const EVENT: Record<ActionKind, string> = {
  chat: "chat",
  send: "send",
  pause: "pause",
  merge: "merge",
  schedule: "schedule",
  issue: "issue",
  job: "job",
};

/** Up to 120 characters of a message, centred on the match so the header's ranking still finds the term in it. */
function snippet(text: string, query: string): string {
  const chars = Array.from(text);
  if (chars.length <= 120) return text;
  // The words found, the old name included when the search said Rivet (searchNeedles).
  const needle = searchNeedles(query.trim()).find((words) => text.toLowerCase().includes(words.toLowerCase())) ?? query.trim();
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  const match = at < 0 ? 0 : Array.from(text.slice(0, at)).length;
  const width = 118;
  const start = Math.max(0, Math.min(match - Math.floor((width - Array.from(needle).length) / 2), chars.length - width));
  const end = start + width;
  return `${start > 0 ? "…" : ""}${chars.slice(start, end).join("")}${end < chars.length ? "…" : ""}`;
}

/** A live log read's ETag: its whole answer, so any change to its lines or lease answers in full. */
export const logsEtag = (body: unknown): string => `W/"${createHash("sha1").update(JSON.stringify(body)).digest("base64url")}"`;

export function register(router: Router): void {
  const { config, store, bridge, push, requireSession, now, logger, addUpdate } = router.deps;
  const commands = new CommandStore(config.dataDir);
  router.deps.ownerLines((id) => commands.getChatMessage(id)?.from === "owner");
  const media = new MediaStore(config.dataDir, commands, () => boardMedia());
  const leases = new LogLeases();
  const { schedules } = router.deps;
  /** Chat streams and the request that opened each, so its session is checked again on every write. */
  const streams = new Map<ServerResponse, IncomingMessage>();
  const sweep = setInterval(() => leases.sweep(), SWEEP_MS);
  sweep.unref();
  // A window left open across a restart flushes at once; the bridge gets it on attach.
  flushDue();
  const batchSweep = setInterval(flushDue, BATCH_SWEEP_MS);
  batchSweep.unref();

  router.onClose(() => {
    clearInterval(sweep);
    clearInterval(batchSweep);
    for (const stream of streams.keys()) stream.end();
    streams.clear();
    commands.close();
  });

  // A reconnected bridge gets the chat lines it has not typed yet and the log
  // leases still open. Other actions are never replayed: a late merge or pause
  // is worse than none. Instead the bridge is asked for the result of each one
  // still unfinished, so a lost ack cannot leave it queued.
  bridge.onAttach(() => {
    for (const entry of commands.queuedChat()) {
      // A Team room post cut short before its ask: the ask its line names exists before Rivet reads it.
      ensureAsk(store, entry);
      bridge.sendEvent(EVENT.chat, entry.id, bridgePayload(entry));
    }
    for (const lease of leases.active()) bridge.sendEvent("logs.subscribe", randomUUID(), logsEvent(lease.repo, lease.chat, lease.until));
    const since = new Date(Date.now() - OUTSTANDING_WINDOW_MS).toISOString();
    const actions = commands.outstandingActions(since, OUTSTANDING_MAX);
    if (actions.length) {
      const id = randomUUID();
      bridge.sendEvent("actions.outstanding", id, { id, actions });
    }
  });

  function boardMedia(): Set<string> {
    const shas = new Set<string>();
    for (const need of store.getBoard()?.board.needs ?? []) for (const sha of mediaShas(need.media)) shas.add(sha);
    return shas;
  }

  /** The name a card gives this PDF, if one does. */
  function boardFileName(sha: string): string | undefined {
    for (const need of store.getBoard()?.board.needs ?? []) {
      const file = need.media?.files?.find((f) => f.sha256 === sha);
      if (file) return file.name;
    }
    return undefined;
  }

  function liveWorkers() {
    return deriveWorkers(store.getWorkers(), store.getBoard()?.board ?? null, config.monitorChat, Date.now()).workers;
  }

  function isLive(repo: string, chat: string): boolean {
    return liveWorkers().some((worker) => worker.repo === repo && worker.chat === chat);
  }

  /** Writes to one chat stream, or ends it when its session has gone (signed out or expired). */
  function writeStream(stream: ServerResponse, frame: string): void {
    const opener = streams.get(stream);
    if (!opener) return;
    try {
      requireSession(opener);
    } catch {
      streams.delete(stream);
      stream.end();
      return;
    }
    stream.write(frame);
  }

  function broadcast(message: ChatMessage): void {
    const frame = `event: message\nid: ${message.id}\ndata: ${JSON.stringify(message)}\n\n`;
    for (const stream of [...streams.keys()]) writeStream(stream, frame);
  }

  const threadsApi = registerThreads(router, commands, (event) => {
    const frame = `event: thread\ndata: ${JSON.stringify(event)}\n\n`;
    for (const stream of [...streams.keys()]) writeStream(stream, frame);
  });
  registerConversations(router, commands, threadsApi, {
    broadcast,
    announce: (event) => {
      const frame = `event: conversation\ndata: ${JSON.stringify(event)}\n\n`;
      for (const stream of [...streams.keys()]) writeStream(stream, frame);
    },
  });
  registerMedia(router, commands);
  registerTeamRoom(router, commands, broadcast);
  const toMonitor = (entry: AuditEntry) => void bridge.sendEvent(EVENT.chat, entry.id, bridgePayload(entry));
  registerBacklog(router, commands, { broadcast, toMonitor });
  const scheduled = registerJobs(router, commands, { dispatch, sentBody });
  function broadcastBatch(id: string): void {
    for (const member of commands.batchIds(id)) {
      const message = commands.getChatMessage(member);
      if (message) broadcast(message);
    }
  }

  /** A closed chat window goes to the bridge as its lead; offline, it waits in queuedChat for the next attach. */
  function sendBatch(lead: AuditEntry): void {
    bridge.sendEvent(EVENT.chat, lead.id, bridgePayload(lead));
    broadcastBatch(lead.id);
  }

  function flushDue(): void {
    const time = now();
    for (const lead of commands.flushDue(time.getTime(), time.toISOString())) sendBatch(lead);
  }

  function logsEvent(repo: string, chat: string, until: number) {
    return { id: randomUUID(), repo, chat, until: new Date(until).toISOString() };
  }

  function bridgePayload(entry: AuditEntry): Record<string, unknown> {
    const { id, at, repo, chat, pr, headSha, target, schedule, on, text, image, images, files, replyTo, quote, job } = entry;
    // A chat window names the conversation it was typed in, so Rivet has the context without looking it up.
    const thread = entry.kind === "chat" ? commands.threadOf(id) : null;
    const title = thread ? commands.conversationTitle(thread) : null;
    const conversation = thread && title !== null ? { id: thread, title } : undefined;
    return Object.fromEntries(
      Object.entries({ id, at, repo, chat, pr, headSha, target, schedule, on, text, image, images, files, replyTo, quote, conversation, job }).filter(
        ([, value]) => value !== undefined,
      ),
    );
  }

  function sameRequest(entry: AuditEntry, kind: ActionKind, request: ActionRequest): boolean {
    const keys: (keyof ActionRequest)[] = ["repo", "chat", "pr", "headSha", "target", "schedule", "on", "text", "image", "images", "replyTo", "conversation", "job"];
    // Files by their bytes only: the server renames them when it stores the request, so a retry's names may differ.
    return entry.kind === kind && keys.every((key) => JSON.stringify(entry[key]) === JSON.stringify(request[key])) && sameFiles(entry.files, request.files);
  }

  /**
   * The shared path of every action: session and CSRF, a new audit row per
   * clientId (an identical retry gets the same row back, anything else under that
   * clientId is a 409), then the SSE event to the bridge.
   */
  async function startAction(
    { request, response }: RouteContext,
    kind: ActionKind,
    parse: (body: unknown) => { clientId: string; request: ActionRequest },
    check?: (request: ActionRequest) => { status: number; reason: string } | null,
    /** Runs once a new chat message is stored, before the answer: never for a retry. */
    stored?: () => void,
  ): Promise<void> {
    requireSameOrigin(request, config.origin);
    requireSession(request);
    const body = parse(await readJson(request, ACTION_BODY_MAX));
    const existing = commands.getActionByClientId(body.clientId);
    if (existing) {
      if (!sameRequest(existing, kind, body.request)) throw new HttpError(409, "clientId was already used for a different action");
      // Never sent: the retry is told so again, not handed a success.
      if (existing.status === "failed" && existing.detail?.reason === OFFLINE) {
        json(response, 503, { error: OFFLINE, entry: existing, undelivered: true });
        return;
      }
      json(response, 200, existing);
      return;
    }
    const images = chatImages(body.request);
    if (!images.every((sha) => store.hasImage(sha))) throw new HttpError(400, "that image is no longer on the server; attach it again");
    if (commands.imageBytes(images) > MAX_CHAT_IMAGE_BYTES) throw new HttpError(413, "Those photos come to more than 40 MB together. Send some of them in another message.");
    const photoRefusal = images.length ? bridge.photoRefusal() : null;
    if (photoRefusal) throw new HttpError(424, photoRefusal);
    const textRefusal = kind === "chat" ? bridge.chatTextRefusal(body.request.text) : null;
    if (textRefusal) throw new HttpError(424, textRefusal);
    if (body.request.files) {
      body.request.files = storedFiles(body.request.files, (sha) => store.fileType(sha));
      const fileRefusal = bridge.fileRefusal();
      if (fileRefusal) throw new HttpError(424, fileRefusal);
    }
    const time = now();
    const at = time.toISOString();
    if (kind === "chat") {
      // Chat waits in a window for follow-ups; the sweep hands the whole window to the bridge.
      const { entry, closed } = commands.addChat(
        { id: randomUUID(), clientId: body.clientId, request: body.request, at },
        time.getTime(),
        bridge.chatWindowMax(),
        bridge.photoRefusal() ? 0 : bridge.chatWindowImages(),
      );
      if (closed) sendBatch(closed);
      broadcast(commands.getChatMessage(entry.id)!);
      // His line under an ask awaiting him answers it: its wait card goes (asks/waits.ts).
      router.deps.refreshWaits();
      stored?.();
      json(response, 202, entry);
      return;
    }
    const sent = dispatch(kind, body.clientId, body.request, at, check);
    json(response, sent.status, sentBody(sent));
  }

  /** A 503 for an action the offline bridge never got says `undelivered`: the app may then let its clientId go. */
  function sentBody(sent: { status: number; entry: AuditEntry; error?: string; undelivered?: boolean }) {
    return sent.error ? { error: sent.error, entry: sent.entry, ...(sent.undelivered ? { undelivered: true } : {}) } : sent.entry;
  }

  /** A new audit row for an action other than chat: refused by `check`, else sent to the bridge (failed while it is offline). */
  function dispatch(
    kind: Exclude<ActionKind, "chat">,
    clientId: string,
    request: ActionRequest,
    at: string,
    check?: (request: ActionRequest) => { status: number; reason: string } | null,
    /** Runs between the audit row and the bridge event, with the action's id. */
    before?: (id: string) => void,
  ): { status: number; entry: AuditEntry; error?: string; undelivered?: boolean } {
    const { entry } = commands.addAction({ id: randomUUID(), clientId, kind, request, at });
    before?.(entry.id);
    const refusal = check?.(request) ?? null;
    if (refusal) return { status: refusal.status, error: refusal.reason, entry: commands.updateAction(entry.id, "refused", { reason: refusal.reason }, at)! };
    if (!bridge.sendEvent(EVENT[kind], entry.id, bridgePayload(entry))) {
      return { status: 503, error: OFFLINE, undelivered: true, entry: commands.updateAction(entry.id, "failed", { reason: OFFLINE }, at)! };
    }
    return { status: 202, entry };
  }

  function parseWith<T extends { clientId: string }>(schema: z.ZodType<T>, toRequest: (value: T) => ActionRequest, what: string) {
    return (body: unknown) => {
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new HttpError(400, `invalid ${what}`);
      return { clientId: parsed.data.clientId, request: toRequest(parsed.data) };
    };
  }

  // Chat with Rivet

  /** A reply's target and what it shows of it, taken from the stored message rather than the phone. */
  function replying(replyTo: string | undefined): Pick<ActionRequest, "replyTo" | "quote"> {
    if (replyTo === undefined) return {};
    const quote = commands.quoteOf(replyTo);
    if (!quote) throw new HttpError(400, "the message you replied to is not in the chat");
    if (commands.threadOf(replyTo) === UPDATES_ID) throw new HttpError(409, UPDATES_READ_ONLY);
    // An agent's line in the Team room is stored as Rivet's: its quote names the chat that said it, so Rivet knows whose
    // message you answered and whom to pass your answer on to.
    const agent = commands.getChatMessage(replyTo)?.team?.from;
    return { replyTo, quote: agent ? { ...quote, text: Array.from(`${agent}: ${quote.text}`).slice(0, MAX_QUOTE_TEXT).join("") } : quote };
  }

  /** The conversation a message is typed in, as its thread: any message of it names it; null starts a new one. */
  function typedIn(conversation: string | null | undefined): Pick<ActionRequest, "conversation"> {
    if (conversation === undefined) return {};
    if (conversation === null) return { conversation: null };
    const thread = commands.threadOf(conversation);
    if (!thread) throw new HttpError(400, "that conversation is not in the chat");
    if (thread === UPDATES_ID) throw new HttpError(409, UPDATES_READ_ONLY);
    return { conversation: thread };
  }

  router.on("POST", "/api/chat", (ctx) =>
    startAction(
      ctx,
      "chat",
      parseWith(
        chatCreateSchema,
        (body) => ({
          ...(body.text?.trim() ? { text: body.text.trim() } : {}),
          ...imageFields(chatImages(body)),
          ...(body.files ? { files: body.files } : {}),
          ...replying(body.replyTo),
          ...typedIn(body.conversation),
        }),
        "chat message",
      ),
    ),
  );

  // Feed's Fix it: one tap is your own message to Rivet, sent the chat's way, and the item's record
  // set investigating, so Rivet goes calm at once. Rivet opens the fix chat; the app never does. The phone names the
  // record version it saw: a record changed since (another tap, or Rivet already on it) sends nothing.
  router.on("POST", "/api/ops/fix", (ctx) => {
    let fix: FixCreate | null = null;
    return startAction(
      ctx,
      "chat",
      (body) => {
        const parsed = fixCreateSchema.safeParse(body);
        if (!parsed.success) throw new HttpError(400, "invalid fix");
        fix = parsed.data;
        const stored = store.getOpsStatus(fix.kind, fix.key);
        if (!commands.getActionByClientId(fix.clientId)) {
          // Someone on it already, or a record changed since the phone read it: nothing is sent.
          const onIt = stored?.state === "investigating" || stored?.state === "in-progress";
          if (onIt || (stored?.version ?? 0) !== fix.version) throw new HttpError(409, "its status changed: someone may already be on it");
          // A full store would take the message and not the record: refuse before either.
          if (!stored && store.countOpsStatuses() >= MAX_OPS_STATUSES) throw new HttpError(507, `${APP_NAME} holds at most ${MAX_OPS_STATUSES} statuses`);
        }
        return { clientId: fix.clientId, request: { text: fixText(fix), conversation: null } };
      },
      undefined,
      () => {
        const { kind, key, version } = fix!;
        try {
          const written = writeOpsStatus(
            store,
            kind,
            key,
            { state: "investigating", by: FIX_IT_BY, note: FIX_IT_NOTE, chat: null, eta: String(PICKUP_DUE_MINUTES), why: PICKUP_WHY },
            version,
            now().toISOString(),
          );
          if (written.code === 409) logger.error(`[fix] ${kind} ${key}: its status changed before the write`);
          else if (written.code === 400) logger.error(`[fix] ${kind} ${key}: status refused`);
        } catch (error) {
          // The message is sent; Rivet's rivet fix sets the record when it opens the chat.
          logger.error(`[fix] ${kind} ${key}: status not set: ${error instanceof Error ? error.message : "error"}`);
        }
      },
    );
  });

  router.on("GET", "/api/chat", ({ request, response, url }) => {
    requireSession(request);
    const before = url.searchParams.get("before");
    if (before !== null && !ID_PATTERN.test(before)) throw new HttpError(400, "invalid cursor");
    const limit = Math.min(Math.max(Math.trunc(Number(url.searchParams.get("limit") ?? 30)) || 30, 1), 100);
    json(response, 200, commands.listChat(before, limit, url.searchParams.get("chat") === "1"));
  });

  router.on("GET", "/api/chat/search", ({ request, response, url }) => {
    requireSession(request);
    const query = (url.searchParams.get("q") ?? "").slice(0, 100);
    // Conversations by title first (a conversation's id is its first message's, so it opens like a hit), then messages,
    // each naming its conversation.
    const titles: SearchItem[] = commands.searchTitles(query, 10).map((hit) => ({
      kind: "message",
      key: `conversation:${hit.id}`,
      title: hit.title,
      detail: "Conversation",
      at: hit.at,
      open: { type: "message", id: hit.id },
    }));
    const said: SearchItem[] = commands.searchChat(query, 20).map((hit) => ({
      kind: "message",
      key: `message:${hit.id}`,
      title: snippet(hit.text, query),
      detail: `${hit.from === "owner" ? "You" : RIVET_NAME} in ${commands.conversationTitle(hit.thread) ?? "a conversation"}`,
      at: hit.at,
      open: { type: "message", id: hit.id },
    }));
    json(response, 200, { results: [...titles, ...said] });
  });

  router.on("GET", "/api/chat/stream", ({ request, response }) => {
    requireSession(request);
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(": connected\n\n");
    streams.set(response, request);
    // A named event, not a comment: EventSource hides comments, and the app reconnects a stream that goes quiet.
    const ping = setInterval(() => writeStream(response, "event: ping\ndata: 1\n\n"), STREAM_PING_MS);
    response.on("close", () => {
      clearInterval(ping);
      streams.delete(response);
    });
  });

  /** The threads active this week a Rivet note answering nothing could belong in, by what it names (noticeThreads). */
  function noticeHomes(text: string): string[] {
    const since = now().getTime() - THREAD_WINDOW_MS.week;
    const rows = commands.threadRows();
    const asks = allAsksByThread(store.listAsks({ limit: MAX_ASKS }), rows, (id) => commands.threadOf(id));
    const steps = commands.allThreadSteps();
    const recent = rows
      .filter((row) => Date.parse(row.lastAt) >= since && !ownsNoCard(row.id))
      .map((row) => ({ id: row.id, asks: asks.get(row.id) ?? [], steps: steps.get(row.id) ?? [], asking: row.lastFrom === "rivet" && row.lastAsks }));
    const { workers } = deriveWorkers(store.getWorkers(), store.getBoard()?.board ?? null, config.monitorChat, now().getTime());
    const words = textWords(text);
    const chats = workers.filter((worker) => !worker.rivet && idLike(worker.chat) && words.has(worker.chat.toLowerCase())).map((worker) => worker.chat.toLowerCase());
    const refs = namedPrs(text);
    const needles = [...new Set(refs.map((ref) => String(ref.number))), ...chats];
    // Only a reference noticeThread could match is kept: the same number, and the same repo when both give one. Against
    // a bare note reference every repo matches alike, so it is kept bare, once.
    const pr = (ref: PrRef): PrRef | null => {
      const mine = refs.find((one) => one.number === ref.number && (one.repo === null || ref.repo === null || one.repo === ref.repo));
      return !mine ? null : mine.repo === null ? { repo: null, number: ref.number } : ref;
    };
    return noticeThreads(text, recent, commands.threadMentions(needles, { pr, words: new Set(chats) }, new Date(since).toISOString()), chats);
  }

  router.on("POST", "/api/bridge/say", async ({ request, response }) => {
    requireBearer(request, config.boardTokenDigest);
    const parsed = parseRedacted(saySchema, await readJson(request, SMALL_BODY_MAX), SAY_MEDIA);
    if (!parsed.success)
      throw new HttpError(400, "invalid say: text up to 4000 characters, 1 to 3 images and a video by sha256, replyTo a message id; text, an image or a video, or an ack with replyTo alone");
    const at = now().toISOString();
    const { replyTo, images, video, title } = parsed.data;
    // Only what say.mjs uploaded to the store, of the type the bubble shows it as.
    const typeOf = (sha: string) => commands.getMedia(sha)?.type;
    if (images?.some((sha) => !(IMAGE_TYPES as readonly string[]).includes(typeOf(sha) ?? ""))) throw new HttpError(400, "an image is not a jpg or png in the media store; upload it first");
    if (video !== undefined && typeOf(video) !== "video/mp4") throw new HttpError(400, "the video is not an mp4 in the media store; upload it first");
    // Chats never read the Team room: a reply's quote and an ack's answer show the message replied to, so the board token
    // answers only your own room lines, which reached Rivet as your messages.
    if (replyTo !== undefined && commands.threadOf(replyTo) === TEAM_ROOM_ID && commands.getChatMessage(replyTo)?.from !== "owner")
      throw new HttpError(404, "no such message");
    // An ack is the status line on your message: no bubble, no unread, no push.
    const { ack } = parsed.data;
    if (ack !== undefined && replyTo !== undefined) {
      const acked = commands.setAck(replyTo, ack, at);
      if (acked === null) throw new HttpError(400, "an ack goes on one of your messages; answer anything else with --text");
      const changed = new Set([acked, ...commands.markReplied(replyTo, at)]);
      for (const one of changed) broadcast(commands.getChatMessage(one)!);
      // Your room line that answers an agent's quotes that agent's line, which the board token never reads.
      const message = commands.getChatMessage(acked)!;
      json(response, 200, message.threadId === TEAM_ROOM_ID ? { ...message, quote: undefined } : message);
      return;
    }
    // An update card about a schedule's break someone is on (the shared test, ops-owned.ts) is not posted or pushed; the
    // writer asks again later and it goes once nobody is on it.
    if (parsed.data.schedule !== undefined && schedules.owned(parsed.data.schedule)) {
      json(response, 200, { owned: parsed.data.schedule });
      return;
    }
    const quote = replyTo === undefined ? undefined : (commands.quoteOf(replyTo) ?? undefined);
    const text = (parsed.data.text ?? "").trim();
    const id = randomUUID();
    // The conversation it lands in (src/server/conversations.ts): by the id Rivet quotes (Updates for an id it does not
    // know); for a card, the one its text names, else none.
    const { thread, via } = resolveConversation(
      { id, replyTo, text, fresh: parsed.data.new === true },
      { threadOf: (one) => commands.threadOf(one), isReply: (one) => store.getReply(one) !== null, repliedIn: (one) => commands.repliedIn(one), mentioned: noticeHomes },
    );
    // A say replying to nothing is an update card, never a line in Updates. --card is what you must
    // confirm: a decision card in Needs you, Yes, keep it or Change it, beside a line opening it.
    // A reply in words that asks you something ("…?") is a question card you answer by
    // typing, beside the same line, so nothing he must decide lives only in Chat.
    const asking = replyTo !== undefined && !isSayCard(parsed.data) && !parsed.data.new && !images && !video && thread !== UPDATES_ID && text.endsWith("?");
    // A card never lives in the Team room, nor opens from it: there it is a card like any other, with no line in the room.
    const inRoom = thread === TEAM_ROOM_ID;
    const cardHome = (via === "mention" || replyTo !== undefined) && !inRoom ? thread : null;
    const card = isSayCard(parsed.data) ? sayCard(parsed.data, text, cardHome) : asking ? askCard(parsed.data, text, cardHome) : null;
    if (card && (replyTo === undefined || inRoom)) {
      // A card answering your room line still answers it.
      if (inRoom && !parsed.data.new) for (const one of commands.markReplied(replyTo, at)) broadcast(commands.getChatMessage(one)!);
      json(response, 201, { id: card.id, card: card.id });
      return;
    }
    if (thread === UPDATES_ID) commands.ensureUpdates(at);
    const message = card
      ? commands.addChatMessage({ id, from: "rivet", text: `Card: ${card.title} ›`, at, replyTo, quote, thread, card: card.id })
      : commands.addChatMessage({ id, from: "rivet", text, at, replyTo, quote, images, video, thread });
    if (title !== undefined) commands.patchThread(id, { title }, at);
    // A new conversation answers none of your lines.
    if (!parsed.data.new) for (const id of commands.markReplied(parsed.data.replyTo, at)) broadcast(commands.getChatMessage(id)!);
    broadcast(message);
    // The card pushed as it was added.
    if (card) {
      json(response, 201, message);
      return;
    }
    // Every reply pushes, open streams or not: each phone's service worker drops it when that phone shows the chat.
    // A reply in the Team room never does: nothing there pushes.
    const conversation = message.threadId ?? message.id;
    if (conversation !== TEAM_ROOM_ID) void push
      .notify(rivetPayload(text || quoteText(message), { id: conversation, title: commands.conversationTitle(conversation) }), "card", `rivet:${message.id}`)
      .catch(() => {});
    json(response, 201, message);
  });

  /**
   * Adds say.mjs's card: the first line its title, the rest its line, its photos and video its media. One replying to
   * You (--card) is something you must confirm: a decision card, Yes, keep it or Change it, in Needs you. One replying to nothing is an update card. Its thread,
   * unless the writer gives one: the server's (the topic of its PR's Coming row, else its chat) when it has a PR or chat,
   * from the one PR its text names or the ask of `conversation`, else that conversation's title, else Rivet.
   */
  function sayCard(say: z.infer<typeof saySchema>, text: string, conversation: string | null, kind?: typeof QUESTION): { id: string; title: string } {
    const [first = "", ...rest] = text.split("\n");
    const line = first.trim();
    const long = line.length > MAX_CARD_TITLE;
    const title = long ? `${line.slice(0, MAX_CARD_TITLE - 1)}…` : line || (say.video ? "A video" : say.images?.length === 1 ? "A photo" : "Photos");
    const ask = (long ? text : rest.join("\n")).trim();
    const asks = store.listAsks({ limit: MAX_ASKS });
    const home = conversation !== null && !ownsNoCard(conversation) ? conversation : null;
    const homeAsks = home ? (allAsksByThread(asks, commands.threadRows(), (one) => commands.threadOf(one)).get(home) ?? []) : [];
    // The ask your message started, else the one of its conversation the text names (by id or chat), else its newest.
    // A question card names none: his answer goes back to the conversation of its line (cardThread), never to a PR.
    const owner = kind
      ? undefined
      : ((say.replyTo !== undefined ? asks.find((one) => one.replyId === say.replyTo) : undefined) ??
        homeAsks.find((one) => namesWord(text, one.id)) ??
        homeAsks.find((one) => one.chat !== undefined && namesWord(text, one.chat)) ??
        homeAsks[0]);
    const named = say.replyTo === undefined ? namedPrs(text) : [];
    const ref = new Set(named.map((one) => one.number)).size === 1 ? named[0]! : undefined;
    const asked = ref?.number ?? owner?.prs.at(-1);
    // A bare #n is the ask's repo when the ask has that PR; a chat-only ask keeps its repo too.
    const askedRepo = ref?.repo ? ref.repo : asked === undefined || owner?.prs.includes(asked) ? owner?.repo : undefined;
    const pr = say.pr ?? asked;
    const repo = say.pr !== undefined ? say.repo : askedRepo;
    const chat = owner?.chat !== undefined && ID_PATTERN.test(owner.chat) ? owner.chat : undefined;
    // The app of the PR's Coming row in the card's repo: a row's repo is its chat's, and one two repos claim is neither's.
    const stored = store.getBoard()?.board;
    const ofRepo = (row: ComingItem) => {
      const found = row.chat && stored ? comingChatRepo(stored.chats, row.chat, row.pr) : undefined;
      return found === undefined ? NO_REPO : found;
    };
    const app = pr !== undefined && stored?.coming.some((row) => row.pr === pr && ofRepo(row) === (repo ?? NO_REPO) && typeof row.app === "string" && row.app.trim());
    const titled = home && !app && !chat ? commands.conversationTitle(home)?.trim().slice(0, 80) : undefined;
    // A thread and tag stack update cards; a question or outcome card takes neither.
    const outcome = !kind && say.replyTo !== undefined;
    const thread = kind || outcome ? undefined : (say.thread ?? (titled || undefined));
    const typeOf = (sha: string) => commands.getMedia(sha)!.type;
    const stills = say.images?.map((sha) => ({ sha256: sha, type: typeOf(sha) }));
    const media = say.video ? { kind: "video", after: { sha256: say.video, type: typeOf(say.video) }, ...(stills ? { stills } : {}) } : stills ? { kind: "stills", stills } : undefined;
    const id = `${kind ? "ask" : outcome ? "out" : "upd"}-${randomUUID()}`;
    // A card with a line opening it (a reply) is in its conversation already: filed there first, so it is not posted twice.
    if (home && say.replyTo !== undefined) commands.fileCard({ card: id, thread: home, via: "say", stem: null, repo: repo ?? null, pr: pr ?? null, chat: chat ?? null, at: now().toISOString() });
    const added = addUpdate(
      {
        id,
        ...(kind ? { kind } : outcome ? { kind: DECISION, options: [...OUTCOME_OPTIONS.map((option) => ({ ...option }))] } : {}),
        title,
        ...(ask ? { ask } : {}),
        ...(pr !== undefined ? { pr } : {}),
        ...(repo ? { repo } : {}),
        ...(chat ? { chat } : {}),
        ...(thread ? { thread } : {}),
        // A card with no line opening it is shown in the conversation its text names (2026-10-09).
        ...(conversation && say.replyTo === undefined ? { replyTo: conversation } : {}),
        ...(say.tag && !outcome ? { tag: say.tag } : {}),
        // The schedule whose break it is about: its push is keyed by it, so a held one is withdrawn once someone is on it.
        ...(say.schedule && !kind && !outcome ? { schedule: say.schedule } : {}),
        ...(media ? { media } : {}),
      },
      // That conversation may be one you began: news all the same, not an answer to you.
      { progress: say.replyTo === undefined },
    );
    if (added.status !== 200) throw new HttpError(added.status, `the ${kind ? "question" : outcome ? "outcome" : "update"} card was refused: ${added.error ?? "error"}`);
    return { id, title };
  }

  /** A question card for a reply that asks you something, or null when the board refuses it: then the reply stays words. */
  function askCard(say: z.infer<typeof saySchema>, text: string, conversation: string | null): { id: string; title: string } | null {
    try {
      return sayCard(say, text, conversation, QUESTION);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      logger.error(`[command] a question stays words: ${error.message}`);
      return null;
    }
  }

  // What you attached, for Rivet's attachments script: a chat message (its whole window when it leads one) or a
  // card reply, and each file by its sha256. Board token only; nothing here is reachable with your session.

  router.onPrefix("GET", "/api/board/attachments/", ({ request, response, url }) => {
    requireBearer(request, config.boardTokenDigest);
    const id = url.pathname.slice("/api/board/attachments/".length);
    if (!ID_PATTERN.test(id)) throw new HttpError(404, "no such message or reply");
    const chat = commands.chatAttachments(id);
    const reply = chat ? null : store.getReply(id);
    const found = chat ?? (reply ? { images: chatImages(reply), files: reply.files ?? [] } : null);
    if (!found) throw new HttpError(404, "no such message or reply");
    const stored = (sha: string) => {
      const meta = commands.getMedia(sha);
      return meta ? { sha256: sha, type: meta.type, size: meta.size } : null;
    };
    json(response, 200, {
      id,
      files: found.files.flatMap((file) => {
        const meta = stored(file.sha256);
        return meta ? [{ ...meta, name: file.name }] : [];
      }),
      images: found.images.flatMap((sha) => stored(sha) ?? []),
      // Evicted since you sent them; the script says so rather than dropping them unseen.
      missing: found.files.filter((file) => !stored(file.sha256)).length + found.images.filter((sha) => !stored(sha)).length,
    });
  });

  router.onPrefix("GET", "/api/board/media/", ({ request, response, url }) => {
    requireBearer(request, config.boardTokenDigest);
    media.serveAttachment(request, response, url.pathname.slice("/api/board/media/".length));
  });

  // A merge-ready card's yes (armsMerge, src/shared/answers.ts) merges the head its gate was clean on, once the bridge
  // has acked the answer: a merge sent beside an answer the bridge then dropped could not be started again. The clientId
  // comes from the reply's id, so a retried answer or a repeated ack starts nothing new. A merge the bridge says it never
  // received (its queue was cleared) is sent again, at most CARD_RETRIES times, each only on a reconnect's answer.
  const CARD_RETRIES = 3;
  const cardMergeId = (reply: string, retry = 0) => (retry ? `card-${reply}-r${retry}` : `card-${reply}`);

  router.onClose(
    store.onReplyAcked((reply) => {
      const { merge, pr, headSha } = reply.item;
      if (merge !== true || pr === undefined || !headSha || !SHA_PATTERN.test(headSha)) return;
      try {
        const clientId = cardMergeId(reply.id);
        if (commands.getActionByClientId(clientId)) return;
        const sent = dispatch("merge", clientId, { repo: reply.item.repo ?? NO_REPO, pr, headSha }, now().toISOString());
        cardLine(reply, sent.entry);
      } catch (error) {
        logger.error(`[command] card answer ${reply.id} did not start its merge: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );

  /** The reply whose yes started this row and which send it was (0 first, then each retry), or null for any other row. */
  function cardReply(entry: AuditEntry): { reply: Reply; retry: number } | null {
    if (entry.kind !== "merge" || !entry.clientId.startsWith("card-")) return null;
    const tail = /-r([1-3])$/.exec(entry.clientId);
    for (const [id, retry] of [[entry.clientId.slice(5), 0], ...(tail ? [[entry.clientId.slice(5, -tail[0].length), Number(tail[1])]] : [])] as [string, number][]) {
      const reply = store.getReply(id);
      if (!reply || reply.item.merge !== true || reply.item.pr !== entry.pr || (reply.item.repo ?? NO_REPO) !== entry.repo) continue;
      if (entry.clientId === cardMergeId(reply.id, retry)) return { reply, retry };
    }
    return null;
  }

  /** A card-born merge's step, as a line beside your answer; one the bridge never received is sent again. */
  function cardAcked(entry: AuditEntry): void {
    const born = cardReply(entry);
    if (!born) return;
    const { reply, retry } = born;
    if (entry.status === "failed" && entry.detail?.unseen === true && retry < CARD_RETRIES && entry.pr !== undefined && entry.headSha) {
      const clientId = cardMergeId(reply.id, retry + 1);
      if (commands.getActionByClientId(clientId)) return;
      const sent = dispatch("merge", clientId, { repo: entry.repo ?? NO_REPO, pr: entry.pr, headSha: entry.headSha }, now().toISOString());
      cardLine(reply, sent.entry);
      return;
    }
    cardLine(reply, entry);
  }

  /** Where a card-born merge got to, as Rivet's line beside your answer in the card's conversation; once per step. */
  function cardLine(reply: Reply, entry: AuditEntry): void {
    const reason = entry.detail?.reason;
    let text: string | undefined;
    if (entry.status === "refused" || entry.status === "failed") text = reason ? `Not merged: ${reason}` : "Not merged.";
    else if (entry.status === "merged") text = reason ?? "Merged.";
    const id = `${entry.id}-${entry.status}`;
    if (!text || commands.getChatMessage(id)) return;
    const quote = commands.quoteOf(reply.id) ?? undefined;
    broadcast(commands.addChatMessage({ id, from: "rivet", text: `PR #${entry.pr}: ${text}`, at: now().toISOString(), replyTo: reply.id, quote }));
  }

  // The Schedules tab's switch. The server checks the bridge's latest read first; the Mac reads the job again
  // before it changes anything.
  router.on("POST", "/api/actions/schedule", (ctx) =>
    startAction(ctx, "schedule", parseWith(scheduleCreateSchema, (body) => ({ schedule: body.schedule, on: body.on }), "schedule switch"), (request) => {
      const item = schedules.find(request.schedule!);
      if (!item) return { status: 404, reason: "that schedule is not in the Mac's latest list" };
      if (!item.toggle.can) return { status: 409, reason: item.toggle.why };
      return null;
    }),
  );

  router.on("GET", "/api/actions/status", ({ request, response, url }) => {
    requireSession(request);
    const id = url.searchParams.get("id") ?? "";
    const entry = ID_PATTERN.test(id) ? commands.getAction(id) : null;
    if (!entry) throw new HttpError(404, "no such action");
    json(response, 200, entry);
  });

  router.on("GET", "/api/audit", ({ request, response, url }) => {
    requireSession(request);
    const limit = Math.min(Math.max(Math.trunc(Number(url.searchParams.get("limit") ?? 100)) || 100, 1), 500);
    json(response, 200, { entries: commands.listAudit(limit) });
  });

  router.on("POST", "/api/bridge/action-ack", async ({ request, response }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const parsed = parseRedacted(actionAckSchema, await readJson(request, SMALL_BODY_MAX));
    if (!parsed.success) throw new HttpError(400, "invalid action ack");
    bridge.seen();
    const entry = commands.updateAction(parsed.data.id, parsed.data.status, parsed.data.detail, new Date().toISOString());
    if (!entry) throw new HttpError(404, "no such action");
    if (entry.kind === "chat") broadcastBatch(entry.id);
    // A Team room line you sent a chat by name: its bubble shows typed or failed.
    const roomLine = entry.kind === "send" ? commands.getChatMessage(entry.id) : null;
    if (roomLine) broadcast(roomLine);
    cardAcked(entry);
    scheduled.acked(entry);
    json(response, 200, entry);
  });

  // Live logs

  router.on("POST", "/api/logs/subscribe", async ({ request, response }) => {
    requireSameOrigin(request, config.origin);
    requireSession(request);
    const parsed = logsLeaseSchema.safeParse(await readJson(request, SMALL_BODY_MAX));
    if (!parsed.success) throw new HttpError(400, "invalid log request");
    const { repo, chat } = parsed.data;
    if (!isLive(repo, chat)) throw new HttpError(409, "that chat is not open right now");
    const until = leases.renew(repo, chat);
    if (!bridge.sendEvent("logs.subscribe", randomUUID(), logsEvent(repo, chat, until))) {
      leases.release(repo, chat);
      throw new HttpError(503, "the Mac bridge is offline");
    }
    json(response, 202, { leaseUntil: new Date(until).toISOString() });
  });

  router.on("POST", "/api/logs/release", async ({ request, response }) => {
    requireSameOrigin(request, config.origin);
    requireSession(request);
    const parsed = logsLeaseSchema.safeParse(await readJson(request, SMALL_BODY_MAX));
    if (!parsed.success) throw new HttpError(400, "invalid log request");
    leases.release(parsed.data.repo, parsed.data.chat);
    bridge.sendEvent("logs.unsubscribe", randomUUID(), { id: randomUUID(), repo: parsed.data.repo, chat: parsed.data.chat });
    json(response, 200, { ok: true });
  });

  router.on("GET", "/api/logs", ({ request, response, url }) => {
    requireSession(request);
    const parsed = logsLeaseSchema.safeParse({ repo: url.searchParams.get("repo"), chat: url.searchParams.get("chat") });
    if (!parsed.success) throw new HttpError(400, "invalid log request");
    // A sheet polls every 2s: the same copy it holds is answered 304, with no lines.
    const read = leases.read(parsed.data.repo, parsed.data.chat);
    const body = { ...read, screen: redactScreen(read.lines), feed: redactFeed(read.lines, read.times) };
    const etag = logsEtag(body);
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { etag, "cache-control": "no-store" });
      response.end();
      return;
    }
    json(response, 200, body, { etag });
  });

  router.on("PUT", "/api/bridge/logs", async ({ request, response }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const sent = logsUploadSchema.safeParse(await readJson(request, LOGS_BODY_MAX));
    const parsed = sent.success ? parseRedacted(logsUploadSchema, { ...sent.data, lines: redactLog(sent.data.lines, MAX_LOG_LINES) }) : sent;
    if (!parsed.success) throw new HttpError(400, "invalid log upload");
    bridge.seen();
    const { repo, chat, lines, reset } = parsed.data;
    const result = leases.append(repo, chat, lines, reset === true);
    json(response, 200, result.active ? { active: true, until: new Date(result.until!).toISOString() } : { active: false });
  });

  // Media

  router.onPrefix("PUT", "/api/bridge/media/", async ({ request, response, url }) => {
    requireBearer(request, config.boardTokenDigest);
    await media.upload(request, response, url.pathname.slice("/api/bridge/media/".length));
  });

  router.onPrefix("GET", "/media/", ({ request, response, url }) => {
    requireSession(request);
    const sha = url.pathname.slice("/media/".length);
    // A card's name wins; the app's own links name an attached document with `?name=`, re-sanitised when served.
    media.serve(request, response, sha, boardFileName(sha) ?? url.searchParams.get("name") ?? undefined);
  });

  // Images you attach: uploaded by your session only, fetched by the bridge to hand the agent a local file.

  router.on("POST", "/api/images", async ({ request, response }) => {
    requireSameOrigin(request, config.origin);
    requireSession(request);
    await media.uploadImage(request, response);
  });

  router.on("POST", "/api/files", async ({ request, response }) => {
    requireSameOrigin(request, config.origin);
    requireSession(request);
    await media.uploadFile(request, response);
  });

  router.onPrefix("GET", "/api/bridge/media/", ({ request, response, url }) => {
    requireBearer(request, config.bridgeTokenDigest);
    media.serveImage(request, response, url.pathname.slice("/api/bridge/media/".length));
  });

  router.onPrefix("GET", "/api/bridge/video/", ({ request, response, url }) => {
    requireBearer(request, config.bridgeTokenDigest);
    media.serveVideo(request, response, url.pathname.slice("/api/bridge/video/".length));
  });
}
