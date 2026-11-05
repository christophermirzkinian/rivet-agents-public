import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

import type { AnsweredResponse, Reopen } from "../../src/shared/answered.js";
import type { AsksResponse } from "../../src/shared/asks.js";
import type { BacklogIssueResponse, BacklogResponse, BacklogStart, IssueWriteState } from "../../src/shared/backlog.js";
import type { BoardResponse, Decision, FileRef, FileType, PushConfigResponse, Reply, ServedNeed, StatusResponse } from "../../src/shared/board.js";
import type { OpsDismissal, OpsDismissalsResponse } from "../../src/shared/ops-dismiss.js";
import type { OpsStatusKind, OpsStatusResponse } from "../../src/shared/ops-status.js";
import type { OwnerHoldsResponse } from "../../src/shared/owner-holds.js";
import type { Briefing, OpsResponse, TimelineResponse } from "../../src/shared/ops.js";
import type { MindNodeResponse, MindResponse, MindSearchResponse } from "../../src/shared/mind.js";
import type { SearchItem } from "../../src/shared/search.js";
import type { Summary } from "../../src/shared/summary.js";
import type { CardThreadsResponse } from "../../src/shared/threads.js";
import type { ChatMessage } from "../../src/shared/command.js";
import type { UsageAsk, UsageDevice, UsageReport } from "../../src/shared/usage-ids.js";
import type { WorkersResponse } from "../../src/shared/workers.js";
import { sameSession, StaleSession } from "./session.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The server never handed the action on (its bridge was offline): nothing happened, so a retry is a new try. */
    readonly undelivered = false,
    /** The card's revision already had this answer, the one of record, so this one was refused. */
    readonly answered: Reply | null = null,
  ) {
    super(message);
  }
}

/**
 * A read not finished by then, its body included, is given up: one answer that stalls must not hold a refresh that
 * waits for it (Ops, the crew) forever.
 */
export const GET_TIMEOUT_MS = 20_000;

/**
 * A send (POST, PUT) not answered by then is given up too, so a stalled answer never leaves a control busy for good.
 * Whether it landed is then unknown: the error says to try again to check, and the sends that matter carry a
 * clientId that makes the retry safe (`once` in command-api.ts, the card outbox).
 */
export const WRITE_TIMEOUT_MS = 30_000;

/** An upload's deadline: half a minute plus a second per 64 KB, so a slow line still gets a 25 MB file up. */
export const uploadTimeoutMs = (bytes: number) => 30_000 + Math.ceil(bytes / 65_536) * 1000;

/** A signal that aborts at `ms`, or when `outer` does; `timedOut` tells the two apart, `done` stops the clock. */
export function deadline(ms: number, outer?: AbortSignal) {
  const controller = new AbortController();
  let late = false;
  const giveUp = () => controller.abort();
  const timer = setTimeout(() => {
    late = true;
    giveUp();
  }, ms);
  if (outer) {
    if (outer.aborted) giveUp();
    else outer.addEventListener("abort", giveUp, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => late,
    done() {
      clearTimeout(timer);
      outer?.removeEventListener("abort", giveUp);
    },
  };
}

const lateError = (read: boolean) =>
  new ApiError(0, read ? "The server took too long to answer. Try again." : "The server took too long to answer. It may have gone through; try again to check.");

/**
 * Sends a request and reads its JSON answer, both inside `ms` (see GET_TIMEOUT_MS, WRITE_TIMEOUT_MS). One that answers
 * after its session ended rejects StaleSession, whatever it answered, so a late 401 never signs a newer session out.
 */
async function request<T>(path: string, init: RequestInit, ms: number, signal?: AbortSignal, seen?: (response: Response) => void): Promise<T> {
  const current = sameSession();
  const settled = await exchange<T>(path, init, ms, signal, seen).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  if (!current()) throw new StaleSession();
  if ("error" in settled) throw settled.error;
  return settled.value;
}

async function exchange<T>(path: string, init: RequestInit, ms: number, signal?: AbortSignal, seen?: (response: Response) => void): Promise<T> {
  const clock = deadline(ms, signal);
  const read = (init.method ?? "GET") === "GET";
  try {
    let response: Response;
    try {
      response = await fetch(path, { ...init, credentials: "same-origin", signal: clock.signal });
    } catch {
      if (clock.timedOut()) throw lateError(read);
      throw new ApiError(0, "Can't reach the server. Check your connection.");
    }
    seen?.(response);
    try {
      return await answer<T>(response);
    } catch (error) {
      // A refusal is known whatever its body did: a 401 still signs out, a 409 still says the card changed.
      if (clock.timedOut() && response.ok) throw lateError(read);
      throw error;
    }
  } finally {
    clock.done();
  }
}

export function call<T>(method: string, path: string, body?: unknown, keepalive = false, signal?: AbortSignal): Promise<T> {
  return request<T>(
    path,
    {
      method,
      keepalive,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(method === "GET" ? {} : { "x-rivet": "1" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    method === "GET" ? GET_TIMEOUT_MS : WRITE_TIMEOUT_MS,
    signal,
  );
}

/**
 * A GET that names the copy it has by its ETag: null when the server answers 304 (it has not changed), else the answer
 * and its ETag.
 */
export async function getIfChanged<T>(path: string, etag: string | null): Promise<{ value: T; etag: string | null } | null> {
  let status = 0;
  let next: string | null = null;
  const value = await request<T>(path, { method: "GET", headers: etag ? { "if-none-match": etag } : {} }, GET_TIMEOUT_MS, undefined, (response) => {
    status = response.status;
    next = response.headers.get("etag");
  });
  return status === 304 ? null : { value, etag: next };
}

async function answer<T>(response: Response): Promise<T> {
  if (response.status === 204 || response.status === 304) return undefined as T;
  let data: { error?: string; undelivered?: boolean; answered?: Reply };
  try {
    data = (await response.json()) as { error?: string; undelivered?: boolean; answered?: Reply };
  } catch {
    // An answer cut off after a success is not known to have worked or failed.
    if (response.ok) throw new ApiError(0, "The server's answer was cut off. Try again to check.");
    data = {};
  }
  if (!response.ok) throw new ApiError(response.status, data.error ?? `Request failed (${response.status})`, data.undelivered === true, data.answered ?? null);
  return data as T;
}

export const me = () => call<{ signedIn: boolean }>("GET", "/api/me");
export const getBoard = () => call<BoardResponse>("GET", "/api/board");
export const getStatus = () => call<StatusResponse>("GET", "/api/status");
export const getReplies = () => call<{ replies: Reply[] }>("GET", "/api/replies?limit=200");
export const getReply = (id: string) => call<Reply>("GET", `/api/replies/${encodeURIComponent(id)}`);
export const logout = () => call<{ ok: true }>("POST", "/api/auth/logout", {});
export const deviceCode = () => call<{ code: string; expiresAt: string }>("POST", "/api/auth/device-code", {});

export interface ReplyInput {
  clientId: string;
  itemId: string;
  decision: Decision;
  rev: string;
  choice?: string;
  text?: string;
  image?: string;
  images?: string[];
  files?: FileRef[];
  confirm?: boolean;
}

/** Minimises `key` at `rev`, or opens it again with `rev` null, on the server: every phone counts the same deck. */
export const setMinimised = (key: string, rev: string | null) =>
  call<{ minimised: [string, string][] }>("PUT", `/api/minimised/${encodeURIComponent(key)}`, rev === null ? { small: false } : { small: true, rev });

/** Answer again: the answered card at `rev` becomes a new revision, for a new answer. */
export const answerAgain = (id: string, rev: string) => call<{ version: number; item: ServedNeed }>("POST", `/api/board/needs/${encodeURIComponent(id)}/again`, { rev });

/** Always `keepalive`: a send still in flight when the page closes outlives the page. */
export const sendReply = (input: ReplyInput) => call<Reply>("POST", "/api/replies", input, true);

/** Uploads an attached image as raw bytes; the answer names it by its sha256. */
export const uploadImage = (image: Blob, signal?: AbortSignal): Promise<{ image: string; type: string; size: number }> =>
  request(
    "/api/images",
    { method: "POST", headers: { "content-type": image.type || "application/octet-stream", "x-rivet": "1" }, body: image },
    uploadTimeoutMs(image.size),
    signal,
  );

/** Uploads an attached document as raw bytes; the server decides its type and name, and names it by its sha256. */
export const uploadFile = (file: File, signal?: AbortSignal): Promise<FileRef & { type: FileType; size: number }> =>
  request(
    "/api/files",
    { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name), "x-rivet": "1" }, body: file },
    uploadTimeoutMs(file.size),
    signal,
  );

export const pushConfig = () => call<PushConfigResponse>("GET", "/api/push/config");
export const pushSubscribe = (subscription: PushSubscriptionJSON) => call<{ ok: true }>("POST", "/api/push/subscribe", subscription);
export const pushUnsubscribe = (endpoint: string) => call<{ removed: boolean }>("POST", "/api/push/unsubscribe", { endpoint });
export const pushTest = () => call<{ sent: number; removed: number; skipped?: string }>("POST", "/api/push/test", {});

export const getWorkers = () => call<WorkersResponse>("GET", "/api/workers");
export const getSummary = () => call<Summary>("GET", "/api/summary");
/** What you used, counted for one device. */
export const getUsageReport = (device: UsageDevice) => call<UsageReport>("GET", `/api/usage/report?device=${device}`);
/** Retire? or Rework? tapped: the server makes the card. */
export const askUsage = (id: string, ask: UsageAsk, device: UsageDevice) => call<{ card: string }>("POST", "/api/usage/ask", { id, ask, device });
/** Your asks still moving, and those finished in the last few days (Your asks). */
export const getAsks = () => call<AsksResponse>("GET", "/api/asks");
/** A project's backlog: the repos' open issues as the bridge last read them, and the asks not started or parked. */
export const getBacklog = () => call<BacklogResponse>("GET", "/api/backlog");
/** An issue opened from a backlog: pending while the Mac reads it from GitHub. */
export const getBacklogIssue = (repo: string, issue: number) =>
  call<BacklogIssueResponse>("GET", `/api/backlog/issue?repo=${encodeURIComponent(repo)}&issue=${issue}`);
/** Start work: one ask per issue, a line to Rivet and the agent:working label. A retry with the same clientId is safe. */
export const startBacklogIssue = (repo: string, issue: number, clientId: string) =>
  call<{ ask: string; already: boolean; start: BacklogStart | null }>("POST", "/api/backlog/start", { repo, issue, clientId });
/** Close as not needed, with a comment; a second Close gets the first. */
export const closeBacklogIssue = (repo: string, issue: number, clientId: string) =>
  call<{ close: IssueWriteState }>("POST", "/api/backlog/close", { repo, issue, clientId });
export const getCardThreads = () => call<CardThreadsResponse>("GET", "/api/card-threads");
export const getOps = () => call<OpsResponse>("GET", "/api/ops");
export const getOpsStatuses = (signal: AbortSignal) => call<OpsStatusResponse>("GET", "/api/ops/status", undefined, false, signal);
export const getOpsDismissals = (signal: AbortSignal) => call<OpsDismissalsResponse>("GET", "/api/ops/dismissals", undefined, false, signal);
export const getOwnerHolds = (signal: AbortSignal) => call<OwnerHoldsResponse>("GET", "/api/ops/holds", undefined, false, signal);
const dismissPath = (kind: OpsStatusKind, key: string) => `/api/ops/dismissals/${kind}/${encodeURIComponent(key)}`;
export const putOpsDismissal = (kind: OpsStatusKind, key: string, mark: string) => call<OpsDismissal>("PUT", dismissPath(kind, key), { mark });
export const deleteOpsDismissal = (kind: OpsStatusKind, key: string) => call<{ ok: true }>("DELETE", dismissPath(kind, key));
export const getMind = () => call<MindResponse>("GET", "/api/mind");
export const getMindNode = (id: string) => call<MindNodeResponse>("GET", `/api/mind/node?id=${encodeURIComponent(id)}`);
export const searchMind = (q: string) => call<MindSearchResponse>("GET", `/api/mind/search?q=${encodeURIComponent(q)}`);
export const getTimeline = () => call<TimelineResponse>("GET", "/api/ops/timeline");
export const getBriefing = (id?: string) => call<{ briefing: Briefing | null }>("GET", `/api/briefing${id === undefined ? "" : `?id=${encodeURIComponent(id)}`}`);
export const searchHistory = (query: string) => call<{ results: SearchItem[] }>("GET", `/api/ops/search?q=${encodeURIComponent(query)}`);


type Options<T> = { flowId: string; options: T };

export async function signIn(): Promise<void> {
  const { flowId, options } = await call<Options<Parameters<typeof startAuthentication>[0]["optionsJSON"]>>(
    "POST",
    "/api/auth/login/options",
    {},
  );
  const response = await startAuthentication({ optionsJSON: options });
  await call("POST", "/api/auth/login/verify", { flowId, response });
}

export async function enrol(code: string | null): Promise<void> {
  const { flowId, options } = await call<Options<Parameters<typeof startRegistration>[0]["optionsJSON"]>>(
    "POST",
    "/api/auth/register/options",
    code ? { code } : {},
  );
  const response = await startRegistration({ optionsJSON: options });
  await call("POST", "/api/auth/register/verify", { flowId, response });
}

/** Cards' Answered list: the cards answered in the last 30 days, and the Reopen of each open card. */
export const getAnswered = () => call<AnsweredResponse>("GET", "/api/answered");

/** Send again: a Reopen's notice its chat never got is offered for another 24 hours. */
export const sendReopenAgain = (id: string) => call<Reopen>("POST", "/api/answered/reopen-send", { id });
