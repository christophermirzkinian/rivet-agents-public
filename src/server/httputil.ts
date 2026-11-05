import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { bodyBudgetRefusal, takeBody, type BodyBudgetBound } from "./bodyBudget.js";
import { sha256 } from "./config.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A path segment percent-decoded; a malformed escape is a 404 with `notFound`, like an unknown id. */
export function decodeSegment(raw: string, notFound: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(404, notFound);
  }
}

/** Past the server's or this address's share of bodies held at once. */
export class BodyBudgetRefused extends HttpError {
  readonly retryAfterSeconds: number;
  constructor(bound: BodyBudgetBound) {
    const refusal = bodyBudgetRefusal(bound);
    super(refusal.status, refusal.message);
    this.retryAfterSeconds = refusal.retryAfterSeconds;
  }
}

/**
 * The whole of a JSON body arrives inside this, measured from when its route
 * starts reading it: the server's own request timeout is 20 minutes, for the
 * media uploads, which do not read through here.
 */
export const JSON_BODY_DEADLINE_MS = 15_000;

export function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(payload);
}

export function readBytes(request: IncomingMessage, maxBytes: number, deadlineMs = JSON_BODY_DEADLINE_MS): Promise<Buffer> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > maxBytes) return Promise.reject(new HttpError(413, "request body too large"));
  if (request.readableEnded) return Promise.resolve(Buffer.alloc(0));
  // Events, not the iterator: a refused or late body must keep its socket for the refusal.
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stop = (error?: Error): void => {
      clearTimeout(timer);
      request.off("data", onData).off("end", onEnd).off("error", onError).off("close", onClose);
      if (!error) return resolve(Buffer.concat(chunks));
      request.pause();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) return stop(new HttpError(413, "request body too large"));
      const bound = takeBody(request, chunk.length);
      if (bound) return stop(new BodyBudgetRefused(bound));
      chunks.push(chunk);
    };
    const onEnd = (): void => stop();
    const onError = (error: Error): void => stop(error);
    const onClose = (): void => stop(new Error("request closed before its body was read"));
    const timer = setTimeout(() => stop(new HttpError(408, "request body took too long")), deadlineMs);
    request.on("data", onData).on("end", onEnd).on("error", onError).on("close", onClose);
  });
}

export async function readJson(request: IncomingMessage, maxBytes: number, deadlineMs = JSON_BODY_DEADLINE_MS): Promise<unknown> {
  const body = await readBytes(request, maxBytes, deadlineMs);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

/**
 * Compares a bearer token against a stored digest. A null digest means the
 * token is not configured, which disables the route (503) rather than opening it.
 */
export function requireBearer(request: IncomingMessage, digest: Buffer | null): void {
  if (!digest) throw new HttpError(503, "not configured");
  const header = request.headers.authorization ?? "";
  const [scheme, value] = header.split(" ");
  if (scheme !== "Bearer" || !value || !timingSafeEqual(sha256(value), digest)) {
    throw new HttpError(401, "unauthorized");
  }
}

export function hasBearer(request: IncomingMessage, digest: Buffer | null): boolean {
  if (!digest) return false;
  const [scheme, value] = (request.headers.authorization ?? "").split(" ");
  return scheme === "Bearer" && !!value && timingSafeEqual(sha256(value), digest);
}

export function requireSameOrigin(request: IncomingMessage, origin: string): void {
  if (request.headers.origin !== origin || request.headers["x-rivet"] !== "1") {
    throw new HttpError(403, "cross-origin request refused");
  }
}

export function readCookie(request: IncomingMessage, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function clientIp(request: IncomingMessage): string {
  const fly = request.headers["fly-client-ip"];
  if (typeof fly === "string" && fly) return fly;
  return request.socket.remoteAddress ?? "unknown";
}
