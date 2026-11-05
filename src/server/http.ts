/**
 * The HTTP surface. Plain node:http: the route count does not justify a
 * framework on a service that can drive agents on the Mac.
 *
 * Three callers, three credentials: your phone (passkey session cookie),
 * Rivet (board token) and the Mac bridge (bridge token). Nothing here logs a
 * token, a cookie or a request body.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { keepsAnswer, type Reopen } from "../shared/answered.js";
import { armsMerge, bareGotIt, canApprove, DECISION, GOT_IT, isGotIt, isTodo, isUpdate, optionNeedsText, QUESTION, takesDecision } from "../shared/answers.js";
import {
  boardSchema,
  bridgeAckSchema,
  chatRepo,
  comingChatRepo,
  comingChatRepos,
  ID_PATTERN,
  mediaShas,
  replyCreateSchema,
  CHAT_PATTERN,
  MAX_COMMENT,
  MAX_COMMENTS,
  MAX_CHOICE_DETAIL,
  MAX_STEP,
  MAX_STEPS,
  MINIMISED_KEY_PATTERN,
  needSchema,
  NO_REPO,
  UPDATE,
  type Board,
  type BoardChat,
  type ComingItem,
  type Repo,
  type BoardResponse,
  type Need,
  type CardComment,
  type PushConfigResponse,
  type Reply,
  type ReplyItem,
  type ServedNeed,
  type StatusResponse,
} from "../shared/board.js";
import { chatImages, imageFields, MAX_CHAT_IMAGE_BYTES, MAX_IMAGE_BYTES } from "../shared/command.js";
import { GITHUB_STALE_MS } from "../shared/ops.js";
import { isStale } from "./ops/view.js";
import { chatName, RIVET_NAME } from "../shared/names.js";
import { workerSnapshotSchema, type WorkersResponse } from "../shared/workers.js";
import { createAuth, type Auth } from "./auth.js";
import { sha256, type Config } from "./config.js";
import { BridgeChannel, FEATURES_HEADER, parseFeatures } from "./events.js";
import { withBodyBudget } from "./bodyBudget.js";
import { BodyBudgetRefused, decodeSegment, hasBearer, HttpError, json, readJson, requireBearer, requireSameOrigin } from "./httputil.js";
import { sameFiles, storedFiles } from "./media.js";
import { newNeeds, PushService, subscriptionSchema, unsubscribeSchema, type PushSender } from "./push.js";
import { QuietStore } from "./quiet.js";
import { announceReopen } from "./routes/answered.js";
import { registerRoutes } from "./routes/index.js";
import { createRouter } from "./routes/router.js";
import { SCHEDULE_CARD_PREFIX, scheduleOfPushKey, schedulePushKey, SchedulesStore, type FailingSchedule } from "./schedules.js";
import { OPS_CARD_PREFIX, opsCardPushKey } from "../shared/ops-cards.js";
import { morningPushKey } from "./morning.js";
import { settleComing, stampBoard, type StampedSection } from "./stamps.js";
import { stageReadings, syncAskStages } from "./asks/stages.js";
import { OpsStore } from "./ops/store.js";
import { serveStatic } from "./static.js";
import { Store } from "./store.js";
import { ShortTitles } from "./short-titles.js";
import { deriveWorkers } from "./workers.js";
import { BOARD_MEDIA, parseRedacted, redactBody, redactText } from "./redact.js";
import { isRetiredCard, isWait, withoutWaits, withWaits } from "./asks/waits.js";
import { ASK_PAGE_MAX, type Ask } from "../shared/asks.js";
import { isRepo } from "../shared/repos.js";

/** Why the stored board may not become `after`; null when it may. */
type BoardGuard = (before: Board, after: Board) => string | null;
type BoardChange = (current: Board) => { board: unknown; item?: (stored: Board, index?: number) => unknown; touched?: { section: StampedSection; index: number } };

const BOARD_MAX_BYTES = 1_000_000;
const ITEM_MAX_BYTES = 256 * 1024;
const SMALL_BODY_MAX = 64 * 1024;
const WORKERS_MAX_BYTES = 256 * 1024;
const MAX_REPLY_ITEMS = 100;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' blob:",
  // A file saved or opened from memory (share.ts) can be audio or video on a blob: URL.
  "media-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export interface App {
  server: Server;
  store: Store;
  auth: Auth;
  bridge: BridgeChannel;
  push: PushService;
  quiet: QuietStore;
  close(): Promise<void>;
}

/** A finished ask older than this no longer places its chat; unfinished asks always come first. */
const ASK_LINK_DAYS = 14;

export function createApp(
  config: Config,
  logger: Pick<Console, "error"> = console,
  options: { pushSender?: PushSender; now?: () => Date } = {},
): App {
  const store = new Store(config.dataDir);
  const auth = createAuth(config, store);
  const bridge = new BridgeChannel();
  const quiet = new QuietStore(config.dataDir);
  const push = new PushService(store, config.vapid, logger, options.pushSender, quiet, options.now);
  const now = options.now ?? (() => new Date());
  const schedules = new SchedulesStore(config.dataDir);
  // A failing-schedule card's push quiet hours held leaves the digest once someone is on the schedule; never sent, its
  // card is filed and pushed again once nobody is.
  push.onDigestRelease((keys) =>
    keys.filter((key) => {
      const schedule = scheduleOfPushKey(key);
      if (schedule === null || !schedules.owned(schedule)) return false;
      // A board card about the schedule leaves while it is still an update or is off the board; one since turned into
      // any other kind (a question, decision, plan and so on) is yours to act on, so its push goes.
      const id = key.slice(key.lastIndexOf(":") + 1);
      if (id.startsWith(SCHEDULE_CARD_PREFIX)) return true;
      const card = store.getBoard()?.board.needs.find((need) => need.id === id);
      return card === undefined || isUpdate(card) || isGotIt(card);
    }),
  );
  push.onDigestSettled((delivered, keys) => {
    if (delivered) return;
    for (const key of keys) {
      const schedule = scheduleOfPushKey(key);
      // Only a failing-schedule card is filed again; an update card about the schedule stays on the board.
      if (schedule !== null && key.slice(key.lastIndexOf(":") + 1).startsWith(SCHEDULE_CARD_PREFIX)) schedules.unfile(schedule);
    }
  });
  const ops = new OpsStore(config.dataDir);
  const prs = () => {
    const github = ops.get("github");
    const fresh = !!github && github.sources?.prs.failed.length === 0 && !isStale(github.at, GITHUB_STALE_MS, now());
    return { merged: ops.get("merged") ?? [], closed: ops.get("closed") ?? [], observedOpen: fresh ? github.prs : [], open: fresh && github.prsComplete === true ? github.prs : null };
  };
  // Your chat lines live in the command routes' store, which tells the board how to know one (ownerLines).
  let ownerLine: (id: string) => boolean = () => false;
  const ownerLines = (check: (id: string) => boolean) => {
    ownerLine = check;
  };
  // The conversation a card shows lives in the thread routes, which tell the reply route how to read it.
  let threadTitlesOf: ((need: Need) => string[]) | null = null;
  const cardThreadTitles = (lookup: (need: Need) => string[]) => {
    threadTitlesOf = lookup;
  };
  const workers = () => deriveWorkers(store.getWorkers(), openBoard(store, schedules, store.getBoard()?.board ?? null, now()), config.monitorChat, Date.now(), store.listAsks({ limit: ASK_PAGE_MAX, doneSince: new Date(Date.now() - ASK_LINK_DAYS * 86_400_000).toISOString() }));
  const titles = new ShortTitles(config.dataDir, now());
  const router = createRouter({ config, store, bridge, requireSession, push, quiet, schedules, logger, now, addUpdate, refreshWaits, prs, ownerLines, cardThreadTitles, workers, titles, ops });
  router.onClose(() => ops.close());
  router.onClose(() => titles.close());
  registerRoutes(router);

  // A 100 MB video from a phone on a slow uplink takes longer than Node's 300 s default to arrive, so the request
  // timeout stays long for the media uploads; readJson cuts a JSON body at its own deadline and charges it to the body
  // budget. Headers still arrive inside 10 s, checked every second.
  const serverOptions = { requestTimeout: 20 * 60 * 1000, headersTimeout: 10_000, connectionsCheckingInterval: 1_000 };
  const server = createServer(serverOptions, withBodyBudget((request, response) => {
    setSecurityHeaders(response);
    return handle(request, response).catch((error: unknown) => {
      if (error instanceof HttpError) {
        // A phone that cannot sign up for push says nothing else, so its refusals are logged (ask 98z7p).
        const path = pathOf(request);
        if (path.startsWith("/api/push/")) logger.error(`[push] ${request.method} ${path} refused ${error.status}: ${error.message}`);
        // A refused stream may still have unread bytes, so it cannot be reused.
        if (!response.headersSent && error instanceof BodyBudgetRefused) json(response, error.status, { error: error.message }, { connection: "close", "retry-after": String(error.retryAfterSeconds) });
        else if (!response.headersSent) json(response, error.status, { error: error.message }, error.status === 413 || !request.complete ? { connection: "close" } : {});
        else response.end();
        return;
      }
      logger.error(`[http] ${request.method} ${pathOf(request)} failed: ${error instanceof Error ? error.message : "error"}`);
      if (!response.headersSent) json(response, 500, { error: "internal error" }, !request.complete ? { connection: "close" } : {});
      else response.end();
    });
  }));

  function setSecurityHeaders(response: ServerResponse): void {
    response.setHeader("content-security-policy", CSP);
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-frame-options", "DENY");
    if (config.production) {
      response.setHeader("strict-transport-security", "max-age=63072000; includeSubDomains");
    }
  }

  function requireSession(request: IncomingMessage): void {
    if (!auth.hasSession(request)) throw new HttpError(401, "sign in first");
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = request.method ?? "GET";

    if (path === "/healthz") {
      json(response, 200, { ok: true });
      return;
    }

    if (await auth.handle(request, response, path)) return;

    if (path === "/api/board") {
      if (method === "GET") {
        const rivet = hasBearer(request, config.boardTokenDigest);
        if (!rivet) requireSession(request);
        const stored = store.getBoard();
        // The board token reads them too, but can't write them: push-board leaves the schedule- cards out of what it sends back.
        const cards = scheduleCards().map(({ need }) => need);
        const board = stored?.board ?? (cards.length ? { updatedAt: now().toISOString(), needs: [], coming: [], chats: [], shipped: [] } : null);
        const body: BoardResponse = board
          ? {
              version: stored?.version ?? 0,
              updatedAt: stored?.updatedAt ?? null,
              board: { ...board, needs: withSeen(store, [...board.needs, ...cards].map((need) => ({ ...need, rev: needRev(need) }))) },
              minimised: store.minimised(),
            }
          : { version: 0, updatedAt: null, board: null, minimised: store.minimised() };
        json(response, 200, body, etag(body.version));
        return;
      }
      if (method === "PUT") {
        requireBearer(request, config.boardTokenDigest);
        const ifMatch = parseIfMatch(request.headers["if-match"]);
        const body = await readJson(request, BOARD_MAX_BYTES);
        // readJson already capped the request at BOARD_MAX_BYTES; schema defaults must not push a valid body over.
        // Its chats move a row it keeps as a chat's own routes may: a dropped chat moves none, as its DELETE moves
        // none, and a changed one none into a repo where the row's PR or title is taken or its PR shipped, as its PATCH.
        commitBoard(response, ifMatch, () => ({ board: body }), { sizeCap: false, guard: putGuard });
        return;
      }
      throw new HttpError(405, "method not allowed");
    }

    if (path === "/api/board/shipped") {
      if (method !== "PUT") throw new HttpError(405, "method not allowed");
      requireBearer(request, config.boardTokenDigest);
      const ifMatch = parseIfMatch(request.headers["if-match"]);
      const body = await readJson(request, BOARD_MAX_BYTES);
      if (!Array.isArray(body)) throw new HttpError(400, "shipped must be a JSON array");
      commitBoard(response, ifMatch, (board) => ({ board: { ...board, shipped: body }, item: (stored) => stored.shipped }));
      return;
    }

    // Answer again: a new revision of an answered card, for a new answer.
    const againMatch = /^\/api\/board\/needs\/([^/]+)\/again$/.exec(path);
    if (againMatch) {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      requireSameOrigin(request, config.origin);
      requireSession(request);
      const id = decodeKey(againMatch[1]!, ID_PATTERN);
      const body = (await readJson(request, 4 * 1024)) as { rev?: unknown } | null;
      if (typeof body?.rev !== "string" || !body.rev) throw new HttpError(400, "rev is required");
      json(response, 200, answerAgain(id, body.rev));
      return;
    }

    // Minimise, kept on the server so every phone counts the same deck (Later folded into it, 2026-10-13).
    const minimisedMatch = /^\/api\/minimised\/([^/]+)$/.exec(path);
    if (minimisedMatch) {
      if (method !== "PUT") throw new HttpError(405, "method not allowed");
      requireSameOrigin(request, config.origin);
      requireSession(request);
      const key = decodeKey(minimisedMatch[1]!, MINIMISED_KEY_PATTERN);
      const body = (await readJson(request, 4 * 1024)) as { rev?: unknown; small?: unknown } | null;
      if (typeof body?.small !== "boolean") throw new HttpError(400, "small is true or false");
      if (body.small && (typeof body.rev !== "string" || !body.rev || body.rev.length > 200)) throw new HttpError(400, "rev is required");
      store.setMinimised(key, body.small ? (body.rev as string) : null, now().toISOString());
      json(response, 200, { minimised: store.minimised() });
      return;
    }

    // Rivet's line under an update card, stamped by the server: comments are never a board write's.
    const commentMatch = /^\/api\/board\/needs\/([^/]+)\/comments$/.exec(path);
    if (commentMatch) {
      requireBearer(request, config.boardTokenDigest);
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const id = decodeKey(commentMatch[1]!, ID_PATTERN);
      const body = (await readJson(request, 16 * 1024)) as { text?: unknown } | null;
      const sent = typeof body?.text === "string" ? body.text.trim() : "";
      const text = redactText(sent);
      if (!sent || !text || sent.length > MAX_COMMENT) throw new HttpError(400, `text is 1 to ${MAX_COMMENT} characters`);
      const at = now().toISOString();
      const written = addComment(id, { from: "rivet", text, at }, parseIfMatch(request.headers["if-match"]));
      store.cardNoted({ card: id, text, at });
      json(response, 201, written, etag(written.version));
      return;
    }

    const itemMatch = /^\/api\/board\/(needs|chats|coming)\/([^/]+)$/.exec(path);
    if (itemMatch) {
      requireBearer(request, config.boardTokenDigest);
      const section = itemMatch[1] as "needs" | "chats" | "coming";
      const key = decodeKey(itemMatch[2]!, section === "coming" ? COMING_KEY : section === "chats" ? CHAT_PATTERN : ID_PATTERN);
      const ifMatch = parseIfMatch(request.headers["if-match"]);
      // A chat name or PR number is only unique within a repo: ?repo= picks that repo's row.
      const repo = url.searchParams.get("repo");
      if (repo !== null && (section === "needs" || !isRepo(repo))) throw new HttpError(400, section === "needs" ? "a card has no repo key" : "repo is not an owner/name");
      const inRepo = repo as Repo | null;
      if (section === "needs") await needRoute(response, request, method, key, ifMatch, url.searchParams.get("create") === "only");
      else if (section === "chats") await chatRoute(response, request, method, key, ifMatch, inRepo);
      else {
        const by = url.searchParams.get("by");
        if (by !== null && by !== "title") throw new HttpError(400, "by must be title");
        await comingRoute(response, request, method, key, ifMatch, by === "title", inRepo);
      }
      return;
    }

    if (path === "/api/status" && method === "GET") {
      requireSession(request);
      const stored = store.getBoard();
      const body: StatusResponse = {
        board: { version: stored?.version ?? 0, updatedAt: stored?.updatedAt ?? null },
        bridge: bridge.status(),
      };
      json(response, 200, body);
      return;
    }

    if (path === "/api/replies") {
      if (method === "GET") {
        if (!hasBearer(request, config.boardTokenDigest)) requireSession(request);
        const handledParam = url.searchParams.get("handled");
        const handled = handledParam === "true" ? true : handledParam === "false" ? false : undefined;
        const acted = url.searchParams.get("acted") === "false" ? false : undefined;
        const limit = Math.min(Math.max(Math.trunc(Number(url.searchParams.get("limit") ?? 100)) || 100, 1), 500);
        // ?item=<card id>, repeatable: only those cards' answers, however many others came after them.
        const items = url.searchParams.getAll("item");
        if (items.length > MAX_REPLY_ITEMS || !items.every((item) => ID_PATTERN.test(item))) throw new HttpError(400, `at most ${MAX_REPLY_ITEMS} item card ids`);
        const replies = store.listReplies({ handled, acted, limit, ...(items.length ? { items } : {}) });
        json(response, 200, acted === false ? { replies, total: store.countUnactedReplies() } : { replies });
        return;
      }
      if (method === "POST") {
        requireSameOrigin(request, config.origin);
        requireSession(request);
        await createReply(request, response);
        return;
      }
      throw new HttpError(405, "method not allowed");
    }

    const replyMatch = /^\/api\/replies\/([^/]+)$/.exec(path);
    if (replyMatch && method === "GET") {
      if (!hasBearer(request, config.boardTokenDigest)) requireSession(request);
      const id = decodeSegment(replyMatch[1]!, "no such reply");
      const reply = ID_PATTERN.test(id) ? store.getReply(id) : null;
      if (!reply) throw new HttpError(404, "no such reply");
      json(response, 200, reply);
      return;
    }

    const handledMatch = /^\/api\/replies\/([^/]+)\/handled$/.exec(path);
    if (handledMatch && method === "POST") {
      requireBearer(request, config.boardTokenDigest);
      const id = decodeSegment(handledMatch[1]!, "no such reply");
      if (!ID_PATTERN.test(id)) throw new HttpError(404, "no such reply");
      const reply = store.markHandled(id);
      if (!reply) throw new HttpError(404, "no such reply");
      json(response, 200, reply);
      return;
    }

    if (path === "/api/push/config" && method === "GET") {
      requireSession(request);
      const body: PushConfigResponse = push.health();
      json(response, 200, body);
      return;
    }

    if (path === "/api/push/subscribe" && method === "POST") {
      requireSameOrigin(request, config.origin);
      requireSession(request);
      if (!push.configured) throw new HttpError(503, "push is not configured");
      const parsed = subscriptionSchema.safeParse(await readJson(request, SMALL_BODY_MAX));
      if (!parsed.success) throw new HttpError(400, "invalid subscription");
      push.subscribe(parsed.data);
      json(response, 200, { ok: true });
      return;
    }

    if (path === "/api/push/unsubscribe" && method === "POST") {
      requireSameOrigin(request, config.origin);
      requireSession(request);
      const parsed = unsubscribeSchema.safeParse(await readJson(request, SMALL_BODY_MAX));
      if (!parsed.success) throw new HttpError(400, "invalid subscription");
      json(response, 200, { removed: push.unsubscribe(parsed.data.endpoint) });
      return;
    }

    if (path === "/api/push/test" && method === "POST") {
      requireSameOrigin(request, config.origin);
      requireSession(request);
      if (!push.configured) throw new HttpError(503, "push is not configured");
      json(response, 200, await push.sendTest());
      return;
    }

    if (path === "/api/bridge/events" && method === "GET") {
      requireBearer(request, config.bridgeTokenDigest);
      bridge.attach(response, store.undeliveredReplies(), parseFeatures(request.headers[FEATURES_HEADER]));
      return;
    }

    if (path === "/api/bridge/ack" && method === "POST") {
      requireBearer(request, config.bridgeTokenDigest);
      const parsed = parseRedacted(bridgeAckSchema, await readJson(request, SMALL_BODY_MAX));
      if (!parsed.success) throw new HttpError(400, "invalid ack");
      bridge.seen();
      const reply = store.applyAck(parsed.data);
      if (!reply) throw new HttpError(404, "no such reply");
      json(response, 200, reply);
      return;
    }

    if (path === "/api/bridge/workers" && method === "PUT") {
      requireBearer(request, config.bridgeTokenDigest);
      const parsed = parseRedacted(workerSnapshotSchema, await readJson(request, WORKERS_MAX_BYTES));
      if (!parsed.success) {
        json(response, 400, { error: "invalid worker snapshot", issues: parsed.error.issues.slice(0, 20) });
        return;
      }
      bridge.seen();
      const at = store.putWorkers(parsed.data);
      syncAskStages(store, workers().workers, stageReadings(store, ops.get("github"), ops.get("merged"), now()), now());
      json(response, 200, { at, count: parsed.data.workers.length });
      return;
    }

    if (path === "/api/workers" && method === "GET") {
      // The board token reads it too: `rivet chat list` shows each chat's box.
      if (!hasBearer(request, config.boardTokenDigest)) requireSession(request);
      const listed = workers();
      // Each chat wears a short title from what it is at, the chat's name beside it for Haiku.
      const at = now();
      const body: WorkersResponse = {
        ...listed,
        workers: listed.workers.map((w) => {
          const what = w.what ?? w.doing;
          return what ? { ...w, short: titles.of(what, chatName(w.chat), at) } : w;
        }),
      };
      json(response, 200, body);
      return;
    }

    if (await router.dispatch(request, response, url)) return;

    if (path.startsWith("/api/")) throw new HttpError(404, "not found");

    // The Share menu's POST, should the service worker not be there to keep it: the app still opens on the chat.
    if (path === "/share-target" && method === "POST") {
      response.writeHead(303, { location: "/?tab=chat" });
      response.end();
      return;
    }

    if (await serveStatic(request, response, config.webRoot, path)) return;
    json(response, 404, { error: "not found" });
  }

  /**
   * Writes the board one change makes. Reading the current board, `change`, validation and putBoard all run
   * synchronously with no await between them, so two writes cannot interleave: a change without If-Match lands on
   * the board as it is now. Keep any await (body reads included) before the call.
   */
  function commitBoard(
    response: ServerResponse,
    ifMatch: number | null,
    change: BoardChange,
    options: { sizeCap?: boolean; guard?: BoardGuard } = {},
  ): void {
    const { status, body, headers } = writeBoard(ifMatch, change, options);
    json(response, status, body, headers);
  }

  /** commitBoard's write, answered as a status and body; `change` may throw an HttpError, as it does there. */
  function writeBoard(
    ifMatch: number | null,
    change: BoardChange,
    { sizeCap = true, progress = false, guard }: { sizeCap?: boolean; progress?: boolean; guard?: BoardGuard } = {},
  ): { status: number; body: unknown; headers?: Record<string, string> } {
    const stored = store.getBoard();
    if (ifMatch !== null && ifMatch !== (stored?.version ?? 0)) return { status: 409, body: { error: "board version is stale", version: stored?.version ?? 0 } };
    const current: Board = stored?.board ?? { updatedAt: now().toISOString(), needs: [], coming: [], chats: [], shipped: [] };
    const { board: sent, item, touched } = change(current);
    // Every string redacted before anything reads it: what the board token sent, and what was stored before. The
    // board is checked as sent as well, so a redacted field never fits a bound the sent one broke.
    const board = redactBody(sent, BOARD_MEDIA);
    // Before making room, which can drop the very update card that would be refused.
    const outcome = progress ? undefined : outcomeUpdate(stored?.board.needs ?? [], proposedUpdates(board));
    if (outcome) return { status: 400, body: { error: outcomeRefusal(outcome.id) } };
    const shaped = (one: unknown, before: Board | null) => boardSchema.safeParse(makeCardRoom(store, withServerFields(before, updatesAsGotIt(before, withoutWaits(one), now().toISOString()), now().toISOString())));
    const asSent = shaped(sent, stored?.board ?? null);
    // The stored board redacted too: the comments and times it keeps on each card go back into the board as stored.
    const parsed = asSent.success ? shaped(board, redactBody(stored?.board ?? null, BOARD_MEDIA)) : asSent;
    if (!parsed.success) return { status: 400, body: { error: "invalid board", issues: parsed.error.issues.slice(0, 20) } };
    // Two options redaction makes read the same could not be told apart when you pick one (createReply).
    const labels = (one: Board) => new Map(one.needs.map((need) => [need.id, new Set(need.options?.map((option) => option.label)).size]));
    const sentLabels = labels(asSent.data as Board);
    const folded = [...labels(parsed.data).entries()].find(([id, size]) => size < (sentLabels.get(id) ?? 0));
    if (folded) return { status: 400, body: { error: `card ${folded[0]}: two options read the same once redacted; reword them` } };
    const refused = stored && guard?.(stored.board, parsed.data);
    // Not a 409, which a whole-board writer (push-board) reads as a stale version and retries.
    if (refused) return { status: 422, body: { error: refused } };
    // Stamped first: a chat's wait reads its touchedAt, so a new or changed chat is fresh in this same write.
    const stamped = stampBoard(stored?.board ?? null, touched ? parsed.data : withChatProjects(stored?.board ?? null, parsed.data), now().toISOString(), touched);
    const waited = withWaits({ board: stamped, stored: stored?.board ?? null, asks: waitingAsks(), answers: store.answerTimes(stamped.needs.map((need) => need.id).concat((stored?.board.needs ?? []).filter(isWait).map((need) => need.id))), answered: answeredWaits(), yeses: store.waitYeses(), rev: needRev, room: MAX_CARDS, now: now() });
    const stampedBoard = withAgain(stored?.board ?? null, waited);
    const at = now();
    const keep = touched?.section === "coming" ? touched.index : undefined;
    const { merged, closed, open } = prs();
    const settlement = settleComing(stampedBoard, { merged, closed, open, now: at.toISOString(), keep });
    const settled = settlement?.board ?? stampedBoard;
    // A write that answers with one card keeps the cards where they are, so the answer is that card.
    const next = item ? settled : (withoutHandled(store, settled, at) ?? settled);
    if (next.needs.some((need) => need.id.startsWith(SCHEDULE_CARD_PREFIX))) return { status: 400, body: { error: `card ids starting "${SCHEDULE_CARD_PREFIX}" are the server's own` } };
    if (sizeCap) {
      const size = Buffer.byteLength(JSON.stringify(next));
      // A stored board can already be over the cap (schema defaults grow a whole-board PUT), so only growth is refused.
      if (size > BOARD_MAX_BYTES && size > (stored ? Buffer.byteLength(JSON.stringify(stored.board)) : 0)) return { status: 413, body: { error: "the board would be over 1 MB" } };
    }
    const previous = stored?.board.needs ?? null;
    // A slow upload batch can outlast eviction's grace, so newly named media must still be here.
    // Media the stored board already names is not re-checked: one lost file must not block every push.
    const named = new Set((previous ?? []).flatMap((need) => mediaShas(need.media)));
    for (const need of next.needs) {
      const missing = mediaShas(need.media).find((sha) => !named.has(sha) && !store.hasMedia(sha));
      if (missing) return { status: 422, body: { error: `card ${need.id} names media ${missing.slice(0, 12)} that is not on the server; upload it again` } };
    }
    const written = store.putBoard(next, ifMatch);
    if (!written) return { status: 409, body: { error: "board version is stale", version: store.boardVersion() } };
    const added = newNeeds(previous, next.needs);
    if (added.length) {
      // An update card about a schedule's break (say.mjs --schedule) pushes under its schedule's key, so a push quiet hours
      // held leaves the digest once someone is on the schedule. Only an update card: a question or decision card naming a
      // schedule is still yours to answer, so its push is never withdrawn. One about a schedule someone is on already is not
      // pushed at all, as say --schedule does not post it; written straight to the board, it stays there unpushed.
      const aboutSchedule = (need: Need) => (isUpdate(need) || isGotIt(need)) && typeof need.schedule === "string";
      // An Ops card's push carries its card's key, so one quiet hours held leaves the digest with its card (ops/service.ts).
      // An app-down card (push "fyi") is told by its own app-down push, so the board does not push it a second time.
      const isOpsCard = (need: Need) => need.id.startsWith(OPS_CARD_PREFIX);
      const keyOf = (need: Need) => (aboutSchedule(need) ? schedulePushKey(need) : isOpsCard(need) ? opsCardPushKey(need.id) : morningPushKey(need));
      const alerts = added.filter((need) => !(aboutSchedule(need) && schedules.owned(need.schedule as string)) && !(isOpsCard(need) && need.push === "fyi"));
      void push.notifyNewNeeds(alerts, keyOf).catch((error: unknown) => {
        logger.error(`[push] new-card push failed: ${error instanceof Error ? error.message : "error"}`);
      });
    }
    return { status: 200, body: item ? { ...written, item: item(next, settlement?.keep ?? touched?.index) } : written, headers: etag(written.version) };
  }

  /**
   * An update card added as `PUT /api/board/needs/<id>?create=only` adds one (its push included): kind and since filled.
   * A question or decision card keeps its kind. `progress`: a card shown in the conversation its text names, which may
   * be one you began, is news all the same (say.mjs with no --reply-to).
   */
  function addUpdate(card: { id: string } & Record<string, unknown>, { progress = false }: { progress?: boolean } = {}): { status: number; error?: string } {
    try {
      const { status, body } = writeBoard(
        null,
        (board) => {
          if (board.needs.some((need) => need.id === card.id)) throw new HttpError(409, `card ${card.id} already exists`);
          const need = { since: now().toISOString(), ...card, kind: card.kind === QUESTION || card.kind === DECISION ? card.kind : UPDATE };
          return { board: stamped(board, "needs", [...board.needs, need]), item: (stored) => stored.needs.find((one) => one.id === card.id) ?? null };
        },
        { progress },
      );
      if (status !== 200) return { status, error: String((body as { error?: unknown }).error) };
      // A full board of question cards makes room by dropping updates, this one included: then it was not added.
      if ((body as { item?: unknown }).item == null) return { status: 507, error: "the board is full of question cards" };
      return { status };
    } catch (error) {
      if (error instanceof HttpError) return { status: error.status, error: error.message };
      throw error;
    }
  }

  /**
   * The update card, new to the board or newly so, that answers one of your own lines (your message, or your answer
   * on a card): never news you clears with Seen. Finished work takes no card; what you must confirm is a
   * decision card in Needs you.
   * Cards already stored as they are pass, so an old one never blocks a write.
   */
  function outcomeUpdate(before: readonly Need[], after: readonly Need[]): Need | undefined {
    const was = new Map(before.map((need) => [need.id, need]));
    return after.find((need) => {
      // A Got it card is news too, so one that answers you are refused as well.
      if ((!isUpdate(need) && !isGotIt(need)) || need.replyTo === undefined) return false;
      const old = was.get(need.id);
      if (old && (isUpdate(old) || isGotIt(old)) && old.replyTo === need.replyTo) return false;
      return store.getReply(need.replyTo) !== null || ownerLine(need.replyTo);
    });
  }

  function stamped(board: Board, section: "needs" | "chats" | "coming", rows: unknown[]): Record<string, unknown> {
    return { ...board, [section]: rows, updatedAt: now().toISOString() };
  }

  /** PUT creates or replaces a card, PATCH merges into one (null removes a field), DELETE removes it. */
  async function needRoute(response: ServerResponse, request: IncomingMessage, method: string, id: string, ifMatch: number | null, createOnly: boolean): Promise<void> {
    if (method === "DELETE") {
      commitBoard(response, ifMatch, (board) => {
        if (!board.needs.some((need) => need.id === id)) throw new HttpError(404, "no such card");
        return { board: stamped(board, "needs", board.needs.filter((need) => need.id !== id)) };
      });
      return;
    }
    if (method !== "PUT" && method !== "PATCH") throw new HttpError(405, "method not allowed");
    const body = objectBody(await readJson(request, ITEM_MAX_BYTES));
    if (body.id !== undefined && body.id !== id) throw new HttpError(400, "the body's id must match the URL");
    commitBoard(response, ifMatch, (board) => {
      const rows: unknown[] = [...board.needs];
      let index = board.needs.findIndex((need) => need.id === id);
      if (method === "PUT" && createOnly && index >= 0) throw new HttpError(409, `card ${id} already exists`);
      if (method === "PATCH" && index < 0) throw new HttpError(404, "no such card");
      const need = method === "PUT" ? { ...body, id } : merged(board.needs[index]!, body);
      if (index < 0) index = rows.push(need) - 1;
      else rows[index] = need;
      // By id: making room past the card cap can move the card up.
      const answer = (stored: Board) => stored.needs.find((need) => need.id === id) ?? null;
      return { board: stamped(board, "needs", rows), item: (stored) => (answer(stored) ? { ...answer(stored)!, rev: needRev(answer(stored)!) } : null) };
    });
  }

  /**
   * PATCH upserts a chat row by name (null removes a field), DELETE removes it. The name cannot change. A name is only
   * unique within a repo: `repo` (?repo=) picks that repo's chat and makes a new one in it; without it, two chats of the
   * name are told apart by the body's repo.
   */
  async function chatRoute(response: ServerResponse, request: IncomingMessage, method: string, name: string, ifMatch: number | null, repo: Repo | null): Promise<void> {
    const repoOf = (row: object) => chatRepo(row) ?? NO_REPO;
    await rowRoute(response, request, method, ifMatch, "chats", {
      matches: (row) => (row as { name?: unknown }).name === name && (repo === null || repoOf(row) === repo),
      narrow: (row, body) => typeof body?.repo === "string" && repoOf(row) === body.repo,
      fresh: () => ({ name, ...(repo !== null && repo !== NO_REPO ? { repo } : {}) }),
      check: (body) => {
        if (body.name !== undefined && body.name !== name) throw new HttpError(400, "the body's name must match the URL");
        if (repo !== null && body.repo !== undefined && (body.repo ?? NO_REPO) !== repo) throw new HttpError(400, "the body's repo must match the URL's");
      },
      // A delete never means to move a Coming row (one with no chat of its name is the default repo's), and in another
      // repo settlement may drop it against that repo's PR of the number: refused. A chat's repo or PRs move its rows by
      // design, refused only where their PR or title is taken or their PR shipped. A row two repos claim is not moved.
      gone: (others, board) => {
        const one = board.coming.find((row) => movedTo(row, board.chats, others as BoardChat[]) !== undefined);
        return one ? `deleting the chat would move its coming row ${one.pr !== undefined ? `of PR ${one.pr}` : JSON.stringify(one.title)} to ${movedTo(one, board.chats, others as BoardChat[])}: drop or move the row first` : null;
      },
      clash: (row, _before, others, board) => {
        const why = movedClash(board, [...others, row] as BoardChat[]);
        return why && `moving the chat ${why}`;
      },
    });
  }

  /**
   * The key is a PR number, or with `byTitle` an exact title, so a title of digits can be addressed too. A row's repo is
   * its chat's (comingChatRepos), and a PR number or title is only unique within a repo: `repo` (?repo=) picks the row
   * of that repo, and a change that would give a second row of the same repo the same PR or title is refused.
   */
  async function comingRoute(response: ServerResponse, request: IncomingMessage, method: string, key: string, ifMatch: number | null, byTitle: boolean, repo: Repo | null): Promise<void> {
    const pr = byTitle ? null : /^\d+$/.test(key) ? Number(key) : null;
    const reposOf = comingReposOf;
    const shareRepo = (a: object, b: object, chats: readonly BoardChat[]) => {
      const theirs = reposOf(b, chats);
      return [...reposOf(a, chats)].some((one) => theirs.has(one));
    };
    await rowRoute(response, request, method, ifMatch, "coming", {
      matches: (row, chats) =>
        (pr !== null ? (row as { pr?: unknown }).pr === pr : (row as { title?: unknown }).title === key) && (repo === null || reposOf(row, chats).has(repo)),
      fresh: () => (pr !== null ? { pr } : { title: key }),
      check: (body) => {
        if (pr !== null && body.pr !== undefined && body.pr !== pr) throw new HttpError(400, "the body's pr must match the URL");
      },
      clash: (row, before, others, { chats, shipped }) => {
        const { pr: rowPr, title } = row as { pr?: unknown; title?: unknown };
        const prev = before as { pr?: unknown; title?: unknown } | undefined;
        if (repo !== null && !reposOf(row, chats).has(repo)) return `the row's repo is its chat's, and that is not ${repo}: send the chat`;
        const same = others.filter((other) => shareRepo(row, other, chats));
        // A new chat can move the row to another repo, where its PR or title may be taken. Narrowed from two repos to one
        // counts: it shared that repo's PR and title with nothing for certain before, and does now.
        const was = prev === undefined ? undefined : reposOf(prev, chats);
        const now = reposOf(row, chats);
        const [to] = now;
        const settles = was !== undefined && now.size === 1 && !(was.size === 1 && was.has(to!));
        const moved = settles || (was !== undefined && [...now].some((one) => !was.has(one)));
        if (rowPr !== undefined && (moved || rowPr !== prev?.pr) && same.some((other) => (other as { pr?: unknown }).pr === rowPr)) return `PR ${String(rowPr)} already has a coming row`;
        if ((moved || title !== prev?.title) && same.some((other) => (other as { title?: unknown }).title === title)) return `a coming row is already titled ${JSON.stringify(title)}`;
        // Nor into one where its PR shipped, which settlement would drop it against, as a chat's move may not.
        if (settles && rowPr !== undefined && shipped.some((one) => one.pr === rowPr && (one.repo ?? NO_REPO) === to))
          return `PR ${String(rowPr)} has shipped in ${to}`;
        return null;
      },
    });
  }

  async function rowRoute(
    response: ServerResponse,
    request: IncomingMessage,
    method: string,
    ifMatch: number | null,
    section: "chats" | "coming",
    rules: {
      /** Whether `row` is the one the URL names, read with the board's chats. */
      matches: (row: object, chats: readonly BoardChat[]) => boolean;
      /** Of several matches, the one the body names, if it can. */
      narrow?: (row: object, body: Record<string, unknown> | null) => boolean;
      fresh: () => Record<string, unknown>;
      check: (body: Record<string, unknown>) => void;
      /** Why `row` (replacing `before`, absent for a new row) would collide with one of `others`; null when it does not. */
      clash: (row: object, before: object | undefined, others: object[], board: Board) => string | null;
      /** Why deleting the row, leaving `others`, is refused; null when it is not. */
      gone?: (others: object[], board: Board) => string | null;
    },
  ): Promise<void> {
    const what = section === "chats" ? "chat" : "coming row";
    /** The one matching row's index, -1 for none; several matches are refused, since a change must land on one row. */
    const find = (rows: object[], chats: readonly BoardChat[], body: Record<string, unknown> | null): number => {
      let hits = rows.flatMap((row, index) => (rules.matches(row, chats) ? [index] : []));
      if (hits.length > 1 && rules.narrow) hits = hits.filter((index) => rules.narrow!(rows[index]!, body));
      if (hits.length > 1) throw new HttpError(409, `${hits.length} ${what}s match; name the repo with ?repo=, or fix the duplicates with a whole-board PUT`);
      if (!hits.length && rows.some((row) => rules.matches(row, chats))) throw new HttpError(409, `several ${what}s match; name the repo with ?repo=`);
      return hits[0] ?? -1;
    };
    if (method === "DELETE") {
      commitBoard(response, ifMatch, (board) => {
        const rows: object[] = board[section];
        const index = find(rows, board.chats, null);
        if (index < 0) throw new HttpError(404, `no such ${what}`);
        const others = rows.filter((_, at) => at !== index);
        const refused = rules.gone?.(others, board);
        if (refused) throw new HttpError(409, refused);
        return { board: stamped(board, section, others) };
      });
      return;
    }
    if (method !== "PATCH") throw new HttpError(405, "method not allowed");
    const body = objectBody(await readJson(request, ITEM_MAX_BYTES));
    rules.check(body);
    commitBoard(response, ifMatch, (board) => {
      const rows: object[] = [...board[section]];
      let index = find(rows, board.chats, body);
      const before = index < 0 ? undefined : rows[index]!;
      const row = merged(before ?? rules.fresh(), body);
      const clash = rules.clash(row, before, rows.filter((_, at) => at !== index), board);
      if (clash) throw new HttpError(409, clash);
      if (index < 0) index = rows.push(row) - 1;
      else rows[index] = row;
      // Settlement can move rows above this one out of Coming, so the answer reads the index the row ended at.
      return { board: stamped(board, section, rows), item: (stored, at = index) => stored[section][at], touched: { section, index } };
    });
  }

  async function createReply(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = replyCreateSchema.safeParse(await readJson(request, SMALL_BODY_MAX));
    if (!parsed.success) throw new HttpError(400, "invalid reply");
    const body = parsed.data;

    const text = body.text?.trim() || undefined;
    const images = chatImages(body);
    const existing = store.getReplyByClientId(body.clientId);
    if (existing) {
      const same =
        existing.itemId === body.itemId &&
        existing.decision === body.decision &&
        existing.choice === body.choice &&
        existing.text === text &&
        JSON.stringify(chatImages(existing)) === JSON.stringify(images) &&
        sameFiles(existing.files, body.files) &&
        existing.rev === body.rev;
      if (!same) throw new HttpError(409, "clientId was already used for a different reply");
      store.replayReply(existing);
      json(response, 200, existing);
      return;
    }

    const generated = body.itemId.startsWith(SCHEDULE_CARD_PREFIX);
    const failing = generated ? scheduleCards().find(({ need }) => need.id === body.itemId) : undefined;
    const need = generated ? failing?.need : store.getBoard()?.board.needs.find((item) => item.id === body.itemId);
    if (!need) throw new HttpError(404, "that item is no longer on the board");
    if (needRev(need) !== body.rev) throw new HttpError(409, "this card changed; look again");

    if (!takesDecision(need, body.decision)) {
      throw new HttpError(
        400,
        isTodo(need) ? "this card takes Done, Reject, Dismiss or a comment" : isUpdate(need) ? "an update card takes Seen or a comment" : body.decision === "seen" ? "only an update card takes Seen" : "only a todo card takes Done",
      );
    }
    const chosenOptions = body.decision === "choice" ? need.options?.filter((option) => option.label === body.choice) ?? [] : [];
    if (body.decision === "choice") {
      if (!body.choice || chosenOptions.length === 0) {
        throw new HttpError(400, "choice must be one of the item's options");
      }
      if (chosenOptions.length > 1) throw new HttpError(400, "this card has ambiguous option labels; ask for a corrected card");
    } else if (body.choice !== undefined) {
      throw new HttpError(400, "choice is only allowed with decision=choice");
    }
    if (body.decision === "comment" && !text && !images.length && !body.files) throw new HttpError(400, "a comment needs text, an image or a file");
    if (body.decision === "dismiss" && (text || images.length || body.files)) throw new HttpError(400, "a dismiss carries no answer; send a comment instead");
    // A reject always says why: the app's popup asks, and an old app, worker or outbox entry is held to it.
    if (body.decision === "reject" && !text) throw new HttpError(400, "a reject needs your why: open the card and tap the X");
    if (!images.every((sha) => store.hasImage(sha))) throw new HttpError(400, "that image is no longer on the server; attach it again");
    // The bridge takes no photo over MAX_IMAGE_BYTES, so one larger (a board still, say) is refused here, not dropped there.
    if (images.some((sha) => store.imageBytes([sha]) > MAX_IMAGE_BYTES)) throw new HttpError(413, "A photo is over 8 MB. Send a smaller one with this answer.");
    if (store.imageBytes(images) > MAX_CHAT_IMAGE_BYTES) throw new HttpError(413, "Those photos come to more than 40 MB together. Send fewer with this answer.");
    // The first answer to a revision is the one of record: a later one from another client (a stale screen, a second
    // device) is refused with that answer, never recorded and relayed beside it, ahead of any refusal that
    // could change (a photo the bridge cannot take). Seen on an update card is no answer, so one comment can follow
    // it; a second there is refused even when the board was too full to show the first (its rev unchanged).
    const answered = isUpdate(need) && body.decision === "comment" ? store.firstReplyAt(need.id, body.rev, "comment") : store.firstReplyAt(need.id, body.rev);
    if (answered) {
      json(response, 409, { error: "This card was already answered.", answered });
      return;
    }
    const photoRefusal = bridge.replyPhotosRefusal(images.length);
    if (photoRefusal) throw new HttpError(424, photoRefusal);
    const files = body.files ? storedFiles(body.files, (sha) => store.fileType(sha)) : undefined;
    const fileRefusal = files ? bridge.fileRefusal() : null;
    if (fileRefusal) throw new HttpError(424, fileRefusal);
    if (body.decision === "approve" && !canApprove(need)) {
      throw new HttpError(400, need.options?.length ? "pick one of the options" : "this card needs a typed answer");
    }
    if (body.decision === "choice" && optionNeedsText(need, body.choice) && !text) {
      throw new HttpError(400, "this option needs a typed note");
    }
    if (need.risk && (body.decision === "approve" || body.decision === "choice") && body.confirm !== true) {
      throw new HttpError(428, `this is a ${need.risk} change: confirm it`);
    }
    // A card reopened after the merge its answer started has merged takes a follow-up: no yes to it merges again.
    const arming = config.merge && armsMerge(need, body.decision, body.choice) && !(need.again && isMergedReopen(store.latestReopens([need.id]).get(need.id), body.rev));
    const mergeRefusal = arming ? bridge.cardMergeRefusal() : null;
    if (mergeRefusal) throw new HttpError(424, mergeRefusal);
    const dismissRefusal = body.decision === "dismiss" ? bridge.dismissRefusal() : null;
    if (dismissRefusal) throw new HttpError(424, dismissRefusal);

    const detail: unknown = chosenOptions[0]?.detail;
    // Old stored cards can predate field validation. Omit malformed detail rather than losing the answer at the bridge.
    const choiceDetail = typeof detail === "string" && detail.trim() !== "" && detail.length <= MAX_CHOICE_DETAIL ? detail : undefined;
    // After Answer again, the answer this one changes: Rivet acts on this one instead.
    const earlier = need.again ? store.getReply(need.again.after) : null;
    const changes = earlier ? { replyId: earlier.id, decision: earlier.decision, ...(earlier.choice ? { choice: earlier.choice } : {}) } : undefined;
    const item: ReplyItem = {
      id: need.id,
      title: need.title,
      kind: need.kind,
      // What the owner was shown, so a late delivery says what it answered.
      ...(need.ask ? { ask: failing ? `${need.ask} ${failing.detail}` : need.ask } : {}),
      ...(choiceDetail !== undefined ? { choiceDetail } : {}),
      ...(snapshotSteps(need) ? { steps: snapshotSteps(need) } : {}),
      ...(need.chat ? { chat: need.chat } : {}),
      ...(need.pr ? { pr: need.pr } : {}),
      ...(need.issue ? { issue: need.issue } : {}),
      // Absent for the default repo, which the bridge reads from RIVET_REPOS.
      ...(need.repo ? { repo: need.repo } : {}),
      ...(need.headSha ? { headSha: need.headSha } : {}),
      ...(need.risk ? { risk: need.risk } : {}),
      ...(arming ? { merge: true as const } : {}),
      ...(changes ? { changes } : {}),
    };
    const reply = store.addReply({
      clientId: body.clientId,
      itemId: need.id,
      itemTitle: need.title,
      decision: body.decision,
      choice: body.choice,
      text,
      ...imageFields(images),
      files,
      rev: body.rev,
      item,
    });
    if (failing) schedules.answer(failing, now());
    // Kept as answered, for Cards' Answered list and Reopen, once it leaves the feed.
    if (!generated && keepsAnswer(need)) store.keepAnswered(need, body.rev, reply.id, reply.at);
    // Seen goes to no chat: it is handled as it lands, and the card leaves the Feed (UPDATE_KEEP_MS keeps it on the board).
    if (body.decision === "seen") {
      // Kept as seen, for Show older once it leaves the board.
      if (isUpdate(need)) store.keepSeenUpdate(need, body.rev, reply.at);
      json(response, 201, store.markHandled(reply.id) ?? reply);
      return;
    }
    // Got it on a news card goes to no chat either: handled as it lands, and the card leaves the board at once. With a
    // note, image or file it goes on to its chat like any answer, so nothing he wrote is lost, and the card still goes.
    if (isGotIt(need) && body.decision === "choice" && body.choice === GOT_IT) {
      const handled = bareGotIt(reply) ? (store.markHandled(reply.id) ?? reply) : (bridge.send(reply), reply);
      const dropped = writeBoard(null, (board) => ({ board: stamped(board, "needs", board.needs.filter((one) => one.id !== need.id)) }));
      if (dropped.status !== 200) logger.error(`[board] card ${need.id} stays after Got it: ${String((dropped.body as { error?: unknown }).error)}`);
      json(response, 201, handled);
      return;
    }
    if (isUpdate(need) && body.decision === "comment") addCommentIfThere(need.id, { from: "owner", text: commentText(text, images.length, files?.length ?? 0), at: reply.at });
    bridge.send(reply);
    json(response, 201, reply);
  }

  /** Puts a line under an update card, oldest dropped past MAX_COMMENTS; its new revision shows the card as new again. */
  function addComment(id: string, comment: CardComment, ifMatch: number | null = null): { version: number; updatedAt: string; item: ServedNeed } {
    const stored = store.getBoard();
    if (ifMatch !== null && ifMatch !== (stored?.version ?? 0)) throw new HttpError(409, "board version is stale");
    const index = stored?.board.needs.findIndex((need) => need.id === id) ?? -1;
    if (!stored || index < 0) throw new HttpError(404, "no such card");
    if (!isUpdate(stored.board.needs[index]!)) throw new HttpError(409, `card ${id} is not an update card`);
    const needs = [...stored.board.needs];
    const need = { ...needs[index]!, comments: [...(needs[index]!.comments ?? []), comment].slice(-MAX_COMMENTS) };
    needs[index] = need;
    const next = { ...stored.board, needs, updatedAt: now().toISOString() };
    // commitBoard's cap: a line never takes the board past 1 MB, where every other write would be refused; one that
    // shrinks a board already over it (a long line rotating out) is taken, as commitBoard refuses only growth.
    const size = Buffer.byteLength(JSON.stringify(next));
    if (size > BOARD_MAX_BYTES && size > Buffer.byteLength(JSON.stringify(stored.board))) throw new HttpError(413, "the board would be over 1 MB");
    // Synchronous from the read: no write lands between, so the stored version still holds.
    const written = store.putBoard(next, stored.version);
    if (!written) throw new HttpError(409, "board version is stale");
    return { ...written, item: { ...need, rev: needRev(need) } };
  }

  /** Your comment under the card, when it is still an update card on the board: your reply stands either way. */
  function addCommentIfThere(id: string, comment: CardComment): void {
    try {
      addComment(id, comment);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
    }
  }

  /**
   * Reopen (Answer again): the answered card at `rev` becomes a new revision of itself, back on the open deck,
   * so your next answer is recorded on that one and relayed as a change, while the first answer to `rev` stays its
   * answer of record. A card that has left the board comes back from the answered cards the server keeps 30 days
   *, and the bridge tells Rivet's chat of the Reopen.
   */
  function answerAgain(id: string, rev: string): { version: number; updatedAt: string; item: ServedNeed } {
    if (isRetiredCard(id)) throw new HttpError(409, "Rivet no longer asks this; there is nothing to answer again");
    const stored = store.getBoard();
    const index = stored?.board.needs.findIndex((need) => need.id === id) ?? -1;
    const onBoard = index >= 0 ? stored!.board.needs[index]! : null;
    // On the board at another revision: changed since, or open again already.
    if (onBoard && needRev(onBoard) !== rev) throw new HttpError(409, "this card changed; look again");
    const kept = onBoard ? null : store.keptAnsweredCard(id);
    if (!onBoard && !kept) throw new HttpError(404, "that card is no longer kept");
    if (kept && kept.rev !== rev) throw new HttpError(409, "this card changed; look again");
    const need = onBoard ?? kept!.card;
    if (isUpdate(need)) throw new HttpError(400, "an update card takes a comment instead");
    const first = store.firstReplyAt(id, rev);
    if (!first) throw new HttpError(409, "this card has no answer to change yet");
    // A merge an answer started is under way the moment it lands: no later answer can take it back while it runs. Once
    // its PR has merged, a new answer is a follow-up.
    const arming = store.repliesAt(id, rev).find((reply) => reply.item.merge);
    // A revision a merged Reopen opened stays merged however often it is reopened: no answer down the line merges again.
    const merged = arming ? isMerged(arming) : isMergedReopen(store.latestReopens([id]).get(id), rev);
    if (arming && !merged) throw new HttpError(409, "that answer started the merge; it can't be changed here");
    // The Reopen's notice waits for a bridge that takes one (events.ts `reopen`); the band says so until it lands.
    const refusal = bridge.changesRefusal();
    if (refusal) throw new HttpError(424, refusal);
    // Media follows at most 1000 changes of one answer (store.cardAnswer).
    if ((need.again?.n ?? 0) >= 1000) throw new HttpError(409, "this card's answer has been changed too many times");
    const at = now().toISOString();
    const next: Need = { ...need, again: { n: (need.again?.n ?? 0) + 1, after: first.id, at } };
    // A kept card goes back as it was answered; one the board's rules have since tightened on is refused here, not
    // left to fail every later board write.
    if (!onBoard && !needSchema.safeParse(next).success) throw new HttpError(409, "that card can't go back as it was");
    const base = stored?.board ?? { updatedAt: at, needs: [], coming: [], chats: [], shipped: [] };
    const needs = [...base.needs];
    if (onBoard) needs[index] = next;
    else needs.push(next);
    // Room as a board write makes it (makeCardRoom: seen update cards go first); a deck still full refuses the Reopen.
    const board = makeCardRoom(store, { ...base, needs, updatedAt: at }) as Board;
    if (board.needs.length > MAX_CARDS) throw new HttpError(409, `the board already holds ${MAX_CARDS} cards`);
    const size = Buffer.byteLength(JSON.stringify(board));
    if (size > BOARD_MAX_BYTES && size > Buffer.byteLength(JSON.stringify(base))) throw new HttpError(413, "the board would be over 1 MB");
    const written = store.putBoard(board, stored?.version ?? 0);
    if (!written) throw new HttpError(409, "board version is stale");
    // Its notice names the card as it was reopened, whatever later writes do to the card under its id.
    const notice = { title: next.title, ...(next.chat ? { chat: next.chat } : {}), ...(next.repo ? { repo: next.repo } : {}) };
    announceReopen(store, bridge, store.addReopen({ cardId: id, rev: needRev(next), at, replyId: first.id, merged, ...notice }));
    return { ...written, item: { ...next, rev: needRev(next) } };
  }

  /** The asks a wait card can come from: every one not yet shipped or parked. */
  function waitingAsks(): Ask[] {
    return store.listAsks({ limit: ASK_PAGE_MAX, doneSince: now().toISOString() });
  }

  /** The wait cards you answered lately, as each answer recorded its card: withWaits keeps them quiet for a while. */
  function answeredWaits(): { id: string; at: string; chat?: string; pr?: number; repo?: string }[] {
    return store
      .listReplies({ limit: 200 })
      .filter((reply) => isWait({ id: reply.itemId }))
      .map((reply) => ({ id: reply.itemId, at: reply.at, ...(reply.item.chat ? { chat: reply.item.chat } : {}), ...(reply.item.pr !== undefined ? { pr: reply.item.pr } : {}), ...(reply.item.repo ? { repo: reply.item.repo } : {}) }));
  }

  /**
   * Makes the wait cards again after a write outside the board (an ask's): writes the board only when they changed, so
   * a write that changes nothing waiting on you bumps no version and pushes nothing.
   */
  function refreshWaits(): void {
    const stored = store.getBoard();
    if (!stored) return;
    const ids = stored.board.needs.map((need) => need.id);
    const next = withWaits({ board: stored.board, stored: stored.board, asks: waitingAsks(), answers: store.answerTimes(ids), answered: answeredWaits(), yeses: store.waitYeses(), rev: needRev, room: MAX_CARDS, now: now() });
    const shown = (board: Board) => board.needs.filter(isWait).map((need) => `${need.id}\n${needRev(need)}`).join("\n");
    if (shown(next) === shown(stored.board)) return;
    const { status, body } = writeBoard(null, (board) => ({ board }), { sizeCap: false });
    if (status !== 200) logger.error(`[board] wait cards not refreshed: ${String((body as { error?: unknown }).error ?? status)}`);
  }

  /** Whether `reopen` reopened `rev` after its merge ran: an answer to it is a follow-up. */
  function isMergedReopen(reopen: Reopen | undefined, rev: string): boolean {
    return reopen?.rev === rev && reopen.merged === true;
  }

  /** Whether the PR an arming answer merges has merged, as the bridge's last read of merged PRs says. */
  function isMerged(reply: Reply): boolean {
    const repo = (reply.item.repo ?? NO_REPO).toLowerCase();
    return reply.item.pr !== undefined && (ops.get("merged") ?? []).some((pr) => pr.number === reply.item.pr && pr.repo.toLowerCase() === repo);
  }

  /** The failing-schedule cards still open: any answer, Leave it too, ends its streak's card; none while someone is on it. */
  function scheduleCards(): FailingSchedule[] {
    return schedules.failing(now()).filter(({ answered, owned, held }) => !answered && !owned && !held);
  }

  async function close(): Promise<void> {
    bridge.detach();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 5_000).unref();
    });
    router.close();
    quiet.close();
    schedules.close();
    store.close();
  }

  return { server, store, auth, bridge, push, quiet, close };
}

/** The one repo the chats `after` move Coming `row` to, when it read as another repo, or as two, with `before`. */
function movedTo(row: object, before: readonly BoardChat[], after: readonly BoardChat[]): Repo | undefined {
  const now = comingReposOf(row, after);
  const was = comingReposOf(row, before);
  const [repo] = now;
  return now.size !== 1 || repo === undefined || (was.size === 1 && was.has(repo)) ? undefined : repo;
}

/**
 * Why a whole-board PUT may not take the stored board `before` to `after`; null when it may. Its rows of the same chat
 * and PR (title, for none) as a stored row are kept, and the PUT's chats may not move one as a chat route could not:
 * none whose chat (or the chat its numbered name reads as) the PUT drops, none into a taken or shipped PR (movedClash).
 */
function putGuard(before: Board, after: Board): string | null {
  const kept = after.coming.filter((row) => before.coming.some((old) => old.chat === row.chat && (row.pr !== undefined ? old.pr === row.pr : old.pr === undefined && old.title === row.title)));
  // A chat whose repo changed is still there: one is dropped when fewer chats have its name.
  const count = (chats: readonly BoardChat[], name: string) => chats.filter((chat) => chat.name === name).length;
  for (const row of kept) {
    const repo = movedTo(row, before.chats, after.chats);
    if (repo === undefined || row.chat === undefined) continue;
    // The chat its name reads as: the exact one where there is one, else the one its numbered name is of (comingChatRepos).
    const name = before.chats.some((chat) => chat.name === row.chat) ? row.chat : row.chat.replace(/-\d+$/, "");
    // One two repos claimed and now a chat of its name in one of those has is settled, not moved: movedClash judges it.
    // The default repo a numbered name falls back to is no chat's claim.
    const was = comingReposOf(row, before.chats);
    if (was.size > 1 && was.has(repo) && after.chats.some((chat) => chat.name === name && (chatRepo(chat) ?? NO_REPO) === repo)) continue;
    if (count(after.chats, name) < count(before.chats, name))
      return `dropping a chat would move its coming row ${row.pr !== undefined ? `of PR ${row.pr}` : JSON.stringify(row.title)} to ${repo}: drop or move the row first`;
  }
  const why = movedClash({ ...after, chats: before.chats }, after.chats, kept);
  return why && `the board's chats ${why}`;
}

/**
 * Why the chats `after` would move a Coming row into a repo where another row has its PR or title, or its PR has
 * shipped (settlement would drop it there); null when none would. A row is moved when it reads as one repo after and
 * did not read as that repo alone before.
 */
function movedClash(board: Board, after: readonly BoardChat[], rows: readonly ComingItem[] = board.coming): string | null {
  for (const one of rows) {
    const repo = movedTo(one, board.chats, after);
    if (repo === undefined) continue;
    const taken = board.coming.find((other) => other !== one && comingReposOf(other, after).has(repo) && ((one.pr !== undefined && other.pr === one.pr) || other.title === one.title));
    if (taken) return `would give ${repo} two coming rows of ${taken.pr !== undefined && taken.pr === one.pr ? `PR ${one.pr}` : JSON.stringify(one.title)}`;
    if (one.pr !== undefined && board.shipped.some((row) => row.pr === one.pr && (row.repo ?? NO_REPO) === repo))
      return `would move the coming row of PR ${one.pr} to ${repo}, where PR ${one.pr} has shipped`;
  }
  return null;
}

/** The repos a coming row could be in: its chat's, two when two claim it (nothing guessed), the default for no chat. */
function comingReposOf(row: object, chats: readonly BoardChat[]): Set<Repo> {
  const { chat, pr } = row as { chat?: unknown; pr?: unknown };
  const repos = typeof chat === "string" ? comingChatRepos(chats, chat, typeof pr === "number" ? pr : undefined) : new Set<Repo>();
  return repos.size ? repos : new Set([NO_REPO]);
}

/**
 * The board's cards as the Feed shows them, for every server "needs you" count: the stored cards less the ones you
 * answered at their current rev, then the failing-schedule cards still open.
 */
export function openBoard(store: Pick<Store, "answeredCards">, schedules: Pick<SchedulesStore, "failing">, board: Board | null, at: Date): Board | null {
  const cards = schedules.failing(at).flatMap(({ need, answered, owned, held }) => (answered || owned || held ? [] : [need]));
  const base = board ?? (cards.length ? { updatedAt: at.toISOString(), needs: [], coming: [], chats: [], shipped: [] } : null);
  if (!base) return null;
  const answered = base.needs.length ? store.answeredCards(base.needs.map((need) => need.id)) : new Set<string>();
  // An update card or a Got it card never needs you: it is news, not a question (the Feed still shows a Got it card to clear).
  return { ...base, needs: [...base.needs.filter((need) => !isUpdate(need) && !isGotIt(need) && !answered.has(`${need.id}\n${needRev(need)}`)), ...cards] };
}

/** What a comment with no words puts under an update card. */
/** A write's update cards that name a reply, before the schema reads it: the outcome check's input. */
function proposedUpdates(board: unknown): Need[] {
  const needs = (board as { needs?: unknown } | null)?.needs;
  if (!Array.isArray(needs)) return [];
  return needs.filter((need): need is Need => {
    const row = need as Partial<Need> | null;
    return typeof row === "object" && row !== null && typeof row.id === "string" && (row.kind === UPDATE || isGotIt(row as Need)) && typeof row.replyTo === "string";
  });
}

/** Why an update card that answers you are refused, and the fix. */
export function outcomeRefusal(id: string): string {
  return `card ${id} answers one of your asks, so it is not an update card. Finished work takes no card: close its ask (rivet ask close <id> done|shipped) or answer you (say.mjs --reply-to <your message id> --text). What you must confirm goes as a decision card (rivet card add --kind decision --option <each choice>, or say.mjs --reply-to <your message id> --card)`;
}

function commentText(text: string | undefined, images: number, files: number): string {
  if (text) return text.slice(0, MAX_COMMENT);
  const parts = [images ? `${images} photo${images === 1 ? "" : "s"}` : "", files ? `${files} file${files === 1 ? "" : "s"}` : ""].filter(Boolean);
  return `(${parts.join(" and ")})`;
}

/**
 * What the server owns on each update card of a board a writer sends, before the card cap and validation:
 * - the comments: the stored card's, whatever the write says, so a stale whole-board write never erases one and no
 *   writer can put words in your mouth; your lines come from your replies, Rivet's from POST …/comments;
 * - the thread its writer left out: the topic of its PR's Coming row in its repo (the row's
 *   chat's, comingChatRepo; a row two repos claim names none), else its chat's name, else Rivet;
 * - the since its writer left out: the stored card's, else `at`, so it is in Done today and keeps its time.
 */
/**
 * No new update cards: a card
 * a write sends as an update, unless it is one stored as an update before, is stored as a decision with one option, Got
 * it, which drops it in one tap. Its tag leads its title, as a decision card takes no tag or thread, and its push stays
 * quiet. Mapped, not refused, so every old writer (say.mjs and older scripts) still lands its news.
 */
export function updatesAsGotIt(stored: Board | null, board: unknown, at: string): unknown {
  const needs = (board as { needs?: unknown } | null)?.needs;
  if (!Array.isArray(needs)) return board;
  const kept = new Set((stored?.needs ?? []).filter(isUpdate).map((need) => need.id));
  const since = new Map((stored?.needs ?? []).map((need) => [need.id, need.since]));
  // A Got it card is dated as an update card was (its stored date, else now), so a full board drops older news first,
  // and stays quiet unless its writer asks for more.
  const dated = (row: Record<string, unknown>) => ({ ...row, since: row.since ?? since.get(row.id as string) ?? at, push: row.push ?? "fyi" });
  return {
    ...(board as object),
    needs: needs.map((row: Record<string, unknown> | null) => {
      if (row !== null && typeof row === "object" && isGotIt(row as Pick<Need, "kind" | "options">)) return dated(row);
      if (row?.kind !== UPDATE || kept.has(row.id as string)) return row;
      const { thread: _thread, tag, comments: _comments, seen: _seen, ...rest } = row;
      // Redacted again once joined: a tag and a title each clean can make a secret together ("password: …").
      const title = typeof tag === "string" && tag.trim() && typeof row.title === "string" ? redactText(`${tag.trim()}: ${row.title}`.slice(0, 300)) : row.title;
      return dated({ ...rest, kind: DECISION, title, options: [{ label: GOT_IT }], push: "fyi" });
    }),
  };
}

export function withServerFields(stored: Board | null, board: unknown, at: string): unknown {
  const needs = (board as { needs?: unknown } | null)?.needs;
  if (!Array.isArray(needs)) return board;
  const coming = (board as { coming?: unknown }).coming;
  const rows = Array.isArray(coming) ? (coming as Record<string, unknown>[]) : [];
  // Not validated yet: only the chats whose name and PRs comingChatRepo can read.
  const sent = (board as { chats?: unknown }).chats;
  const chats = (Array.isArray(sent) ? sent : [])
    .filter((chat): chat is Record<string, unknown> => typeof chat?.name === "string")
    .map((chat) => ({ ...chat, prs: Array.isArray(chat.prs) ? chat.prs : undefined })) as unknown as BoardChat[];
  const repoOf = (row: Record<string, unknown>) => {
    const found = typeof row.chat === "string" ? comingChatRepo(chats, row.chat, typeof row.pr === "number" ? row.pr : undefined) : undefined;
    return found === undefined ? NO_REPO : found;
  };
  const words = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
  const before = new Map((stored?.needs ?? []).filter(isUpdate).map((need) => [need.id, need]));
  return {
    ...(board as object),
    needs: needs.map((row: Record<string, unknown> | null) => {
      if (row?.kind !== UPDATE) return row;
      // seen is served, never stored: a board read and written back must not keep a card seen past a new comment.
      const kept = before.get(row.id as string);
      const comments = kept?.comments ?? [];
      const { comments: _sent, seen: _served, ...rest } = row;
      const repo = typeof row.repo === "string" ? row.repo : NO_REPO;
      const app = row.pr === undefined ? undefined : words(rows.find((coming) => coming?.pr === row.pr && repoOf(coming) === repo && words(coming.app))?.app);
      const thread = row.thread === undefined ? (app ?? words(row.chat) ?? RIVET_NAME).trim().slice(0, 80) : row.thread;
      const since = row.since === undefined ? (kept?.since ?? at) : row.since;
      return { ...rest, thread, since, ...(comments.length ? { comments } : {}) };
    }),
  };
}

/** A chat's project is only set on its row (`rivet chat set --project`): a whole-board write leaves it as stored, so the monitor's local file can neither drop nor restore it. */
export function withChatProjects(stored: Board | null, board: Board): Board {
  const key = (chat: BoardChat) => `${chatRepo(chat) ?? NO_REPO}\n${chat.name}`;
  const before = new Map((stored?.chats ?? []).map((chat) => [key(chat), chat]));
  return {
    ...board,
    chats: board.chats.map((chat) => {
      const was = before.get(key(chat));
      if (!was) return chat;
      const { project: _sent, ...rest } = chat;
      return was.project ? { ...rest, project: was.project } : rest;
    }),
  };
}

/**
 * Answer again is the server's: a write keeps the stored card's while it sends that card unchanged otherwise,
 * so a board read and written back leaves the new revision open, and a changed card drops it; a writer's own goes.
 */
export function withAgain(stored: Board | null, board: Board): Board {
  const again = new Map((stored?.needs ?? []).flatMap((need) => (need.again ? [[need.id, need] as const] : [])));
  if (!again.size && !board.needs.some((need) => need.again)) return board;
  const without = ({ again: _again, ...need }: Need): Need => need;
  return {
    ...board,
    needs: board.needs.map((need) => {
      const before = again.get(need.id);
      const next = without(need);
      return before && needRev(without(before)) === needRev(next) ? { ...next, again: before.again } : next;
    }),
  };
}

/** The served cards, each update card you have seen at its current rev marked so, however old your Seen is. */
function withSeen(store: Pick<Store, "answeredCards">, needs: ServedNeed[]): ServedNeed[] {
  const updates = needs.filter(isUpdate);
  if (!updates.length) return needs;
  const answered = store.answeredCards(updates.map((need) => need.id));
  return needs.map((need) => (isUpdate(need) && answered.has(`${need.id}\n${need.rev}`) ? { ...need, seen: true } : need));
}

/** The most cards a board holds (boardSchema's needs cap). */
export const MAX_CARDS = 200;

/**
 * A board past MAX_CARDS less its oldest update cards, the ones you have seen first, so news never blocks a question
 * card; any other board as it is.
 */
export function makeCardRoom(store: Pick<Store, "answeredCards">, board: unknown): unknown {
  const needs = (board as { needs?: unknown } | null)?.needs;
  if (!Array.isArray(needs) || needs.length <= MAX_CARDS) return board;
  const rows = needs as Record<string, unknown>[];
  // Got it cards are news too (updatesAsGotIt), so they make room as update cards do.
  const updates = rows.filter((row) => (row?.kind === UPDATE || (row !== null && isGotIt(row as Pick<Need, "kind" | "options">))) && typeof row.id === "string");
  const answered = store.answeredCards(updates.map((row) => row.id as string));
  const seen = (row: Record<string, unknown>) => {
    const parsed = needSchema.safeParse(row);
    return parsed.success && answered.has(`${parsed.data.id}\n${needRev(parsed.data)}`);
  };
  const since = (row: Record<string, unknown>) => {
    const at = typeof row.since === "string" ? Date.parse(row.since) : NaN;
    return Number.isFinite(at) ? at : 0;
  };
  // Seen first, then oldest first; the sort is stable, so rows with no date go in board order.
  const drop = new Set(
    updates
      .map((row) => ({ row, seen: seen(row), at: since(row) }))
      .sort((a, b) => Number(b.seen) - Number(a.seen) || a.at - b.at)
      .slice(0, needs.length - MAX_CARDS)
      .map(({ row }) => row),
  );
  return { ...(board as object), needs: rows.filter((row) => !drop.has(row)) };
}

function pick(source: object, keys: string[]): Record<string, unknown> {
  const record = source as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
}

/** How long a card stays on the board after the answer to what it shows was handled (delivered to its chat, or marked Handled). */
export const HANDLED_DROP_MS = 6 * 3600_000;
/** How long an update card stays on the board after you saw it, for the Updates stream. */
export const UPDATE_KEEP_MS = 7 * 24 * 3600_000;

/**
 * The board without the cards whose answer, to what each shows now, was handled HANDLED_DROP_MS ago (an update card's
 * Seen, UPDATE_KEEP_MS ago); null when none.
 */
export function withoutHandled(store: Store, board: Board, now: Date): Board | null {
  if (!board.needs.length) return null;
  const ids = board.needs.map((need) => need.id);
  const handled = store.handledCards(ids, new Date(now.getTime() - HANDLED_DROP_MS).toISOString());
  const seenLongAgo = store.handledCards(ids, new Date(now.getTime() - UPDATE_KEEP_MS).toISOString());
  // A wait card leaves when its wait does (asks/waits.ts): dropped while its source holds, it would come back as new.
  const needs = board.needs.filter((need) => isWait(need) || !(isUpdate(need) ? seenLongAgo : handled).has(`${need.id}\n${needRev(need)}`));
  return needs.length < board.needs.length ? { ...board, needs } : null;
}

/** First 16 hex of sha256 over what the card shows, in a fixed key order. */
export function needRev(need: Need): string {
  const canonical = {
    ...pick(need, ["id", "kind", "title", "ask", "chat", "pr", "issue", "repo", "headSha", "risk", "reply"]),
    // A plan card's: a changed scope, size or ETA is a new revision, so an old approval cannot land on it.
    ...pick(need, ["points", "size", "eta"]),
    ...(need.options ? { options: need.options.map((option) => pick(option, ["label", "short", "detail", "recommended", "text"])) } : {}),
    ...(need.links ? { links: need.links.map((link) => pick(link, ["label", "url", "primary"])) } : {}),
    // Absent on older cards, so their revs are unchanged; a new video is a new card.
    ...(need.media ? { media: need.media } : {}),
    ...(need.steps ? { steps: need.steps } : {}),
    // A merge card's proof is what you decide on: changed proof is a new revision, so an old answer cannot land on it.
    ...(need.evidence ? { evidence: need.evidence } : {}),
    // An update card's: a new comment (Rivet's answer) is a new revision, so the card shows as new again after Seen.
    ...pick(need, ["thread", "tag"]),
    ...(need.comments ? { comments: need.comments } : {}),
    // Answer again: a new revision for a new answer, while the first answer to the one before stays of record.
    ...(need.again ? { again: need.again } : {}),
  };
  return sha256(JSON.stringify(canonical)).toString("hex").slice(0, 16);
}

function pathOf(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return "?";
  }
}

function parseIfMatch(header: string | undefined): number | null {
  if (header === undefined) return null;
  const value = header.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
  if (!/^\d{1,15}$/.test(value)) throw new HttpError(400, "If-Match must be a board version number");
  return Number(value);
}

const COMING_KEY = /^[^\x00-\x1f\x7f]{1,300}$/;

function etag(version: number): Record<string, string> {
  return { etag: `"${version}"` };
}

/** A URL segment decoded and checked; anything else is a 404, like an unknown item. */
function decodeKey(raw: string, pattern: RegExp): string {
  const key = decodeSegment(raw, "not found");
  if (!pattern.test(key)) throw new HttpError(404, "not found");
  return key;
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
  return body as Record<string, unknown>;
}

/** `base` with `patch` laid over it; a null in `patch` removes that field. */
function merged(base: object, patch: Record<string, unknown>): Record<string, unknown> {
  const fields = new Map(Object.entries(base));
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) fields.delete(key);
    else fields.set(key, value);
  }
  return Object.fromEntries(fields);
}

/**
 * A todo card's steps for its reply, only in the shape the bridge accepts. A board stored before steps were checked can
 * hold a string or an empty list; copying that would make the bridge refuse the whole reply and drop his answer.
 */
function snapshotSteps(need: Need): string[] | undefined {
  const steps: unknown = need.steps;
  if (need.kind !== "todo" || !Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS) return undefined;
  return steps.every((step) => typeof step === "string" && step.trim() !== "" && step.length <= MAX_STEP) ? (steps as string[]) : undefined;
}
