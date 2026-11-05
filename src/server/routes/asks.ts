import {
  ASK_DONE_DAYS,
  ASK_ID_PATTERN,
  ASK_PAGE_MAX,
  ASK_STAGES,
  askCreateSchema,
  askPatchSchema,
  DUE_SLACK_MS,
  MAX_ASK_PRS,
  MAX_ASK_WORDS,
  MAX_ASKS,
  MAX_ASK_TIMELINE,
  MAX_DUE_AHEAD_MS,
  MAX_DUE_HISTORY,
  type Ask,
  type AskCreate,
  type AskEvent,
  type AskPatch,
  type AsksResponse,
  type AskStage,
} from "../../shared/asks.js";
import type { AuditEntry } from "../../shared/command.js";
import { decodeSegment, hasBearer, HttpError, json, readJson, requireBearer } from "../httputil.js";
import { parseRedacted } from "../redact.js";
import type { Store } from "../store.js";
import type { Router } from "./router.js";
import { APP_NAME } from "../../shared/names.js";

// Your asks: Rivet writes them with the board token, your phone reads them. Nothing here pushes; the board
// card an ask is carded as does that. A close posts no card: it records the stage, and Done today reads it from there
//.

const ASK_BODY_MAX = 64 * 1024;
const PREFIX = "/api/asks/";

export function register(router: Router): void {
  const { config, store, requireSession, now, refreshWaits, titles } = router.deps;

  // The app's list: everything still moving, plus what shipped or was parked in the last few days. `all=1` pages
  // through every ask instead, for the CLI's list.
  router.on("GET", "/api/asks", ({ request, response, url }) => {
    if (!hasBearer(request, config.boardTokenDigest)) requireSession(request);
    const params = url.searchParams;
    const stage = params.get("stage");
    if (stage !== null && !(ASK_STAGES as readonly string[]).includes(stage)) throw new HttpError(400, `stage is one of ${ASK_STAGES.join(", ")}`);
    const all = params.get("all") === "1";
    const limit = params.has("limit") ? Number(params.get("limit")) : ASK_PAGE_MAX;
    if (!Number.isInteger(limit) || limit < 1 || limit > ASK_PAGE_MAX) throw new HttpError(400, `limit is 1 to ${ASK_PAGE_MAX}`);
    const before = params.has("before") ? parseCursor(params.get("before")!) : undefined;
    if (!all && before) throw new HttpError(400, "before goes with all=1");
    const asks = store.listAsks({
      limit,
      ...(stage ? { stage: stage as AskStage } : {}),
      ...(all ? { before } : { doneSince: new Date(now().getTime() - ASK_DONE_DAYS * 86_400_000).toISOString() }),
    });
    const last = asks.at(-1);
    // The app's list wears short titles; the CLI's pages through every ask do not, so they queue none.
    const at = now();
    const rows = all ? asks.map(listRow) : asks.map((ask) => ({ ...listRow(ask), short: titles.of(ask.words, undefined, at) }));
    const body: AsksResponse = { asks: rows, ...(all && last && asks.length === limit ? { next: `${last.createdAt},${last.id}` } : {}) };
    json(response, 200, body);
  });

  router.onPrefix("GET", PREFIX, ({ request, response, url }) => {
    if (!hasBearer(request, config.boardTokenDigest)) requireSession(request);
    const ask = store.getAsk(askId(url.pathname.slice(PREFIX.length)));
    if (!ask) throw new HttpError(404, "no such ask");
    json(response, 200, ask, etag(ask.version));
  });

  router.on("POST", "/api/asks", async ({ request, response }) => {
    requireBearer(request, config.boardTokenDigest);
    const parsed = parseRedacted(askCreateSchema, await readJson(request, ASK_BODY_MAX));
    if (!parsed.success) {
      json(response, 400, { error: "invalid ask", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    if (store.countAsks() >= MAX_ASKS) throw new HttpError(507, `${APP_NAME} holds at most ${MAX_ASKS} asks`);
    const input = parsed.data;
    // An ask made from your message takes your words from it (plan §3h.1: the server makes the ask, not the writer).
    if (input.from !== undefined) {
      const message = store.ownerMessage(input.from);
      if (!message) throw new HttpError(404, `no message ${input.from} from you`);
      input.words ??= message.text.length > MAX_ASK_WORDS ? `${message.text.slice(0, MAX_ASK_WORDS - 1)}…` : message.text;
      input.replyId ??= input.from;
      input.source ??= `message:${input.from}`;
    }
    if (input.words === undefined) throw new HttpError(400, "an ask needs words, or from: the id of your message");
    const ask = newAsk(input, now());
    if (!store.getAsk(ask.id) && store.heldAskIds(ask.id).length) throw new HttpError(409, `ask ${ask.id} is held by a Town tell or Team Chat post`);
    if (!store.addAsk(ask)) throw new HttpError(409, `ask ${ask.id} already exists`);
    refreshWaits();
    json(response, 201, ask, etag(ask.version));
  });

  router.onPrefix("PATCH", PREFIX, async ({ request, response, url }) => {
    requireBearer(request, config.boardTokenDigest);
    const id = askId(url.pathname.slice(PREFIX.length));
    const ifMatch = parseIfMatch(request.headers["if-match"]);
    const parsed = parseRedacted(askPatchSchema, await readJson(request, ASK_BODY_MAX));
    if (!parsed.success) {
      json(response, 400, { error: "invalid change", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    // From here to the write there is no await, so two changes to one ask cannot interleave.
    const current = store.getAsk(id);
    if (!current) throw new HttpError(404, "no such ask");
    if (ifMatch !== null && ifMatch !== current.version) {
      json(response, 409, { error: "ask version is stale", version: current.version });
      return;
    }
    const next = patched(current, parsed.data, now());
    if (!store.replaceAsk(next, current.version)) {
      json(response, 409, { error: "ask version is stale", version: store.getAsk(id)?.version ?? 0 });
      return;
    }
    refreshWaits();
    json(response, 200, next, etag(next.version));
  });
}

/**
 * The a-<n> after the highest, as `rivet ask open` numbers them; when that would pass the id's 40 characters, the
 * lowest free one. An id an action holds counts as taken, made or not. Either is free, so a caller needs no retry loop.
 */
export function nextAskId(store: Pick<Store, "listAsks" | "heldAskIds">): string {
  const ids = new Set([...store.listAsks({ limit: MAX_ASKS }).map((ask) => ask.id), ...store.heldAskIds()]);
  let top = 0n;
  for (const id of ids) {
    const n = /^a-(\d+)$/.exec(id)?.[1];
    if (n && BigInt(n) > top) top = BigInt(n);
  }
  const next = `a-${top + 1n}`;
  if (ASK_ID_PATTERN.test(next)) return next;
  for (let n = 1; ; n++) if (!ids.has(`a-${n}`)) return `a-${n}`;
}

/**
 * The ask an action's line names, made by its id if it is not there yet; that id, or null for a line naming none. The id
 * is the action's alone: nextAskId and POST /api/asks never hand out one an action holds.
 */
export function ensureAsk(store: Pick<Store, "getAsk" | "addAsk">, entry: AuditEntry): string | null {
  if (!entry.ask?.words) return null;
  if (!store.getAsk(entry.ask.id)) store.addAsk(newAsk(entry.ask, new Date(entry.at)));
  return entry.ask.id;
}

/** A new ask from `input`, its words already filled. A `due` is its first promise, not a move. */
export function newAsk(input: AskCreate, at: Date): Ask {
  const updatedAt = at.toISOString();
  const createdAt = input.createdAt ? new Date(input.createdAt).toISOString() : updatedAt;
  const stage = input.stage ?? "queued";
  const cardId = input.cardId;
  const first: AskEvent = { at: createdAt, stage, ...(input.note ? { note: input.note } : {}), ...(input.by ? { by: input.by } : {}) };
  return {
    id: input.id,
    words: input.words!,
    who: input.who ?? "owner",
    ...(input.source ? { source: input.source } : {}),
    ...(input.replyId ? { replyId: input.replyId } : {}),
    ...(cardId ? { cardId } : {}),
    stage,
    ...(input.chat ? { chat: input.chat } : {}),
    prs: [...new Set(input.prs ?? [])],
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.issue ? { issue: input.issue } : {}),
    ...(input.progress !== undefined ? { progress: input.progress } : {}),
    ...(input.due ? { dueAt: checkedDue(input.due, at) } : {}),
    dueHistory: [],
    ...(input.why ? { why: input.why } : {}),
    timeline: [first],
    createdAt,
    stageAt: createdAt,
    updatedAt,
    version: 1,
  };
}

/**
 * `ask` with the change laid over it. A new stage or a note appends one event; the timeline keeps its last 100. A
 * `due` later than the promised time by more than DUE_SLACK_MS is a move: it needs a `why` and appends to
 * `dueHistory`; a sooner or nearly equal one restates the promise in place. Either clears `askedForTimeAt`.
 */
export function patched(ask: Ask, change: AskPatch, now: Date): Ask {
  const at = now.toISOString();
  const next: Record<string, unknown> = { ...ask };
  const stage = change.stage;
  if (change.words !== undefined) next.words = change.words;
  if (change.who !== undefined) next.who = change.who;
  if (stage !== undefined) next.stage = stage;
  const cardId = change.cardId;
  if (cardId === null) delete next.cardId;
  else if (cardId !== undefined) next.cardId = cardId;
  for (const key of ["source", "replyId", "chat", "repo", "issue", "progress", "why"] as const) {
    if (change[key] === null) delete next[key];
    else if (change[key] !== undefined) next[key] = change[key];
  }
  if (change.prs) {
    const prs = [...new Set([...ask.prs, ...change.prs])];
    if (prs.length > MAX_ASK_PRS) throw new HttpError(400, `an ask names at most ${MAX_ASK_PRS} PRs`);
    next.prs = prs;
  }
  if (change.due === null) {
    delete next.dueAt;
    delete next.askedForTimeAt;
  } else if (change.due !== undefined) {
    const due = checkedDue(change.due, now);
    if (ask.dueAt !== undefined && Date.parse(due) > Date.parse(ask.dueAt) + DUE_SLACK_MS) {
      if (!change.why) throw new HttpError(400, "a later time is a move: it needs a why");
      next.dueHistory = [...ask.dueHistory, { at, dueAt: due, was: ask.dueAt, why: change.why }].slice(-MAX_DUE_HISTORY);
    }
    next.dueAt = due;
    delete next.askedForTimeAt;
  }
  const moved = stage !== undefined && stage !== ask.stage;
  if (moved) next.stageAt = at;
  if (moved || change.note) {
    const event: AskEvent = { at, ...(moved ? { stage } : {}), ...(change.note ? { note: change.note } : {}), ...(change.by ? { by: change.by } : {}) };
    next.timeline = [...ask.timeline, event].slice(-MAX_ASK_TIMELINE);
  }
  next.updatedAt = at;
  next.version = ask.version + 1;
  return next as Ask;
}

/** A promised time as stored: not in the past (a minute's grace for clocks), not over a week ahead. */
function checkedDue(due: string, now: Date): string {
  const ms = Date.parse(due);
  if (ms < now.getTime() - 60_000) throw new HttpError(400, "a due time is not in the past");
  if (ms > now.getTime() + MAX_DUE_AHEAD_MS) throw new HttpError(400, "a due time is within a week");
  return new Date(ms).toISOString();
}

function listRow(ask: Ask): Ask {
  return { ...ask, timeline: ask.timeline.slice(-1) };
}

/** `before`: the `next` of the page before, `<createdAt>,<id>`. */
function parseCursor(raw: string): { createdAt: string; id: string } {
  const [createdAt = "", id = "", ...rest] = raw.split(",");
  if (rest.length || !ASK_ID_PATTERN.test(id) || Number.isNaN(Date.parse(createdAt))) throw new HttpError(400, "before is the next value of the page before");
  return { createdAt, id };
}

function askId(raw: string): string {
  const id = decodeSegment(raw, "no such ask");
  if (!ASK_ID_PATTERN.test(id)) throw new HttpError(404, "no such ask");
  return id;
}

function parseIfMatch(header: string | undefined): number | null {
  if (header === undefined) return null;
  const value = header.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
  if (!/^\d{1,15}$/.test(value)) throw new HttpError(400, "If-Match must be an ask version number");
  return Number(value);
}

function etag(version: number): Record<string, string> {
  return { etag: `"${version}"` };
}
