import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { z } from "zod";

import { sha256, type Config } from "./config.js";
import { clientIp, HttpError, json, readCookie, readJson, requireSameOrigin } from "./httputil.js";
import type { Store } from "./store.js";
import { APP_NAME } from "../shared/names.js";

export const SESSION_COOKIE = "__Host-rivet";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FLOW_TTL_MS = 5 * 60 * 1000;
const MAX_FLOWS = 500;
const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
const DEVICE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 1000;
const AUTH_BODY_MAX = 64 * 1024;

export function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

type Grant = { kind: "session" } | { kind: "enroll"; hash: string } | { kind: "device"; hash: string };

interface Flow {
  type: "register" | "login";
  challenge: string;
  expiresAt: number;
  grant?: Grant;
}

const codeBody = z.object({ code: z.string().min(1).max(200).optional() });
const verifyBody = z.object({
  flowId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  response: z.object({ id: z.string().min(1).max(1024) }).passthrough(),
});

export interface Auth {
  handle(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean>;
  hasSession(request: IncomingMessage): boolean;
  /** Issues a session directly; tests use it to skip the authenticator. */
  createSession(): string;
}

export function createAuth(config: Config, store: Store): Auth {
  const flows = new Map<string, Flow>();

  function sessionHash(request: IncomingMessage): string | null {
    const value = readCookie(request, SESSION_COOKIE);
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
    return sha256(value).toString("hex");
  }

  function hasSession(request: IncomingMessage): boolean {
    const hash = sessionHash(request);
    return hash !== null && store.hasSession(hash);
  }

  function createSession(): string {
    const value = randomBytes(32).toString("base64url");
    store.addSession(sha256(value).toString("hex"), SESSION_TTL_MS);
    return value;
  }

  function rateLimit(request: IncomingMessage): void {
    if (store.countHit("auth", clientIp(request), RATE_WINDOW_MS) > RATE_LIMIT) {
      throw new HttpError(429, "too many attempts, wait a minute");
    }
  }

  function startFlow(flow: Flow): string {
    const now = Date.now();
    for (const [id, existing] of flows) if (existing.expiresAt <= now) flows.delete(id);
    while (flows.size >= MAX_FLOWS) flows.delete(flows.keys().next().value!);
    const id = randomBytes(18).toString("base64url");
    flows.set(id, flow);
    return id;
  }

  function takeFlow(id: string, type: Flow["type"]): Flow {
    const flow = flows.get(id);
    flows.delete(id);
    if (!flow || flow.type !== type || flow.expiresAt <= Date.now()) {
      throw new HttpError(400, "sign-in attempt expired, start again");
    }
    return flow;
  }

  function isEnrollToken(code: string): boolean {
    return config.enrollTokenDigest !== null && timingSafeEqual(sha256(code), config.enrollTokenDigest);
  }

  function grantFor(request: IncomingMessage, code: string | undefined): Grant {
    if (hasSession(request)) return { kind: "session" };
    if (!code) throw new HttpError(401, "an enrolment code is required");
    const trimmed = code.trim();
    const deviceHash = sha256(trimmed.toUpperCase()).toString("hex");
    if (/^[A-Za-z0-9]{8}$/.test(trimmed) && store.isDeviceCodeValid(deviceHash)) {
      return { kind: "device", hash: deviceHash };
    }
    if (isEnrollToken(trimmed)) {
      const hash = sha256(trimmed).toString("hex");
      if (store.isEnrollTokenSpent(hash)) throw new HttpError(403, "this enrolment link has been used");
      return { kind: "enroll", hash };
    }
    if (!config.enrollTokenDigest && !/^[A-Za-z0-9]{8}$/.test(trimmed)) {
      throw new HttpError(503, "enrolment is not configured");
    }
    throw new HttpError(403, "that code is not valid or has expired");
  }

  function spendGrant(request: IncomingMessage, grant: Grant): void {
    const ok =
      grant.kind === "session"
        ? hasSession(request)
        : grant.kind === "enroll"
          ? store.spendEnrollToken(grant.hash)
          : store.useDeviceCode(grant.hash);
    if (!ok) throw new HttpError(403, "that code is not valid or has expired");
  }

  async function registerOptions(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = codeBody.safeParse(await readJson(request, AUTH_BODY_MAX));
    if (!body.success) throw new HttpError(400, "invalid request");
    const grant = grantFor(request, body.data.code);
    const options = await generateRegistrationOptions({
      rpName: APP_NAME,
      rpID: config.rpId,
      userName: "owner",
      userDisplayName: "you",
      userID: store.userId() as Uint8Array<ArrayBuffer>,
      attestationType: "none",
      excludeCredentials: store.listCredentials().map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      timeout: FLOW_TTL_MS,
    });
    const flowId = startFlow({ type: "register", challenge: options.challenge, expiresAt: Date.now() + FLOW_TTL_MS, grant });
    json(response, 200, { flowId, options });
  }

  async function registerVerify(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = verifyBody.safeParse(await readJson(request, AUTH_BODY_MAX));
    if (!body.success) throw new HttpError(400, "invalid request");
    const flow = takeFlow(body.data.flowId, "register");
    let result;
    try {
      result = await verifyRegistrationResponse({
        response: body.data.response as unknown as RegistrationResponseJSON,
        expectedChallenge: flow.challenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpId,
        requireUserVerification: true,
      });
    } catch {
      throw new HttpError(400, "passkey could not be verified");
    }
    if (!result.verified) throw new HttpError(400, "passkey could not be verified");
    const { credential } = result.registrationInfo;
    if (store.getCredential(credential.id)) throw new HttpError(409, "this passkey is already registered");
    spendGrant(request, flow.grant!);
    store.addCredential({
      id: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports,
    });
    const headers: Record<string, string> = {};
    if (flow.grant!.kind !== "session") headers["set-cookie"] = sessionCookie(createSession());
    json(response, 200, { ok: true }, headers);
  }

  async function loginOptions(response: ServerResponse): Promise<void> {
    const options = await generateAuthenticationOptions({
      rpID: config.rpId,
      userVerification: "required",
      timeout: FLOW_TTL_MS,
    });
    const flowId = startFlow({ type: "login", challenge: options.challenge, expiresAt: Date.now() + FLOW_TTL_MS });
    json(response, 200, { flowId, options });
  }

  async function loginVerify(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = verifyBody.safeParse(await readJson(request, AUTH_BODY_MAX));
    if (!body.success) throw new HttpError(400, "invalid request");
    const flow = takeFlow(body.data.flowId, "login");
    const credential = store.getCredential(body.data.response.id);
    if (!credential) throw new HttpError(401, "this passkey is not registered here");
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response: body.data.response as unknown as AuthenticationResponseJSON,
        expectedChallenge: flow.challenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpId,
        credential: {
          id: credential.id,
          publicKey: credential.publicKey as Uint8Array<ArrayBuffer>,
          counter: credential.counter,
          transports: credential.transports,
        },
        requireUserVerification: true,
      });
    } catch {
      throw new HttpError(401, "passkey could not be verified");
    }
    if (!result.verified) throw new HttpError(401, "passkey could not be verified");
    store.touchCredential(credential.id, result.authenticationInfo.newCounter);
    json(response, 200, { ok: true }, { "set-cookie": sessionCookie(createSession()) });
  }

  function logout(request: IncomingMessage, response: ServerResponse): void {
    const hash = sessionHash(request);
    if (hash) store.deleteSession(hash);
    json(response, 200, { ok: true }, { "set-cookie": clearedSessionCookie() });
  }

  function deviceCode(request: IncomingMessage, response: ServerResponse): void {
    if (!hasSession(request)) throw new HttpError(401, "sign in first");
    let code = "";
    for (let i = 0; i < 8; i += 1) code += DEVICE_CODE_ALPHABET[randomInt(DEVICE_CODE_ALPHABET.length)];
    const expiresAt = store.addDeviceCode(sha256(code).toString("hex"), DEVICE_CODE_TTL_MS);
    json(response, 200, { code, expiresAt: new Date(expiresAt).toISOString() });
  }

  async function handle(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
    if (path === "/api/me" && request.method === "GET") {
      json(response, 200, { signedIn: hasSession(request) });
      return true;
    }
    if (!path.startsWith("/api/auth/")) return false;
    rateLimit(request);
    if (request.method !== "POST") throw new HttpError(405, "method not allowed");
    requireSameOrigin(request, config.origin);
    switch (path) {
      case "/api/auth/register/options":
        await registerOptions(request, response);
        return true;
      case "/api/auth/register/verify":
        await registerVerify(request, response);
        return true;
      case "/api/auth/login/options":
        await loginOptions(response);
        return true;
      case "/api/auth/login/verify":
        await loginVerify(request, response);
        return true;
      case "/api/auth/logout":
        logout(request, response);
        return true;
      case "/api/auth/device-code":
        deviceCode(request, response);
        return true;
      default:
        throw new HttpError(404, "not found");
    }
  }

  return { handle, hasSession, createSession };
}
