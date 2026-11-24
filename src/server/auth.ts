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
import { appName } from "../shared/names.js";

export const SESSION_COOKIE = "__Host-rivet";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FLOW_TTL_MS = 5 * 60 * 1000;
const MAX_FLOWS = 500;
const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
const DEVICE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
/** What a device code can be, upper-cased: a guess with any other character (I L O U 0 1) could never have been right. */
const DEVICE_CODE_SHAPE = new RegExp(`^[${DEVICE_CODE_ALPHABET}]{8}$`);
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
const deviceSessionBody = z.object({ code: z.string().min(1).max(200) });
const verifyBody = z.object({
  flowId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  response: z.object({ id: z.string().min(1).max(1024) }).passthrough(),
});

export interface Auth {
  handle(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean>;
  hasSession(request: IncomingMessage): boolean;
  /** A live session that a passkey made: false for one a device code alone made (hasPasskeySession below). */
  hasPasskeySession(request: IncomingMessage): boolean;
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

  /**
   * A session a device code alone made is the weaker one: it runs the app, and changes nothing about who can sign in.
   * Could it add a passkey or a device code, a lost laptop would outlive "Sign out desktop apps" and renew its own 30 days.
   */
  function hasPasskeySession(request: IncomingMessage): boolean {
    return sessionKind(request) === "passkey";
  }

  /** What made the caller's live session, or null without one: one store read (store.sessionKind), never two. */
  function sessionKind(request: IncomingMessage): "passkey" | "device-code" | null {
    const hash = sessionHash(request);
    return hash === null ? null : store.sessionKind(hash);
  }

  function createSession(via: "device-code" | null = null): string {
    const value = randomBytes(32).toString("base64url");
    store.addSession(sha256(value).toString("hex"), SESSION_TTL_MS, via);
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
    if (hasPasskeySession(request)) return { kind: "session" };
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
    // With a code alone able to sign in, this route must not be a free place to test guesses for that one: a wrong
    // guess shaped like a device code is a miss here too (store.missDeviceCodes).
    if (config.deviceSession && DEVICE_CODE_SHAPE.test(trimmed.toUpperCase())) store.missDeviceCodes();
    throw new HttpError(403, "that code is not valid or has expired");
  }

  function spendGrant(request: IncomingMessage, grant: Grant): void {
    const ok =
      grant.kind === "session"
        ? hasPasskeySession(request)
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
      rpName: appName(),
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
    const kind = sessionKind(request);
    if (kind === null) throw new HttpError(401, "sign in first");
    if (kind !== "passkey") throw new HttpError(403, "sign in with a passkey to add a device");
    let code = "";
    for (let i = 0; i < 8; i += 1) code += DEVICE_CODE_ALPHABET[randomInt(DEVICE_CODE_ALPHABET.length)];
    const expiresAt = store.addDeviceCode(sha256(code).toString("hex"), DEVICE_CODE_TTL_MS);
    json(response, 200, { code, expiresAt: new Date(expiresAt).toISOString() });
  }

  /**
   * A device code alone, no passkey: only ever the device_codes table, so the enrolment token is refused like any
   * other wrong code. The one UPDATE that spends the code is the check, so two posts of one code make one session.
   * A wrong guess shaped like a code is a miss against every live code (store.missDeviceCodes); one of another shape
   * (DEVICE_CODE_SHAPE) could never have been right, and costs none.
   */
  async function deviceSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = deviceSessionBody.safeParse(await readJson(request, AUTH_BODY_MAX));
    if (!body.success) throw new HttpError(400, "invalid request");
    const code = body.data.code.trim().toUpperCase();
    const shaped = DEVICE_CODE_SHAPE.test(code);
    if (!shaped || !store.useDeviceCode(sha256(code).toString("hex"))) {
      if (shaped) store.missDeviceCodes();
      throw new HttpError(403, "that code is not valid or has expired");
    }
    json(response, 200, { ok: true }, { "set-cookie": sessionCookie(createSession("device-code")) });
  }

  /**
   * Ends every session a device code alone made, the caller's too when it is one, and voids every device code still
   * waiting, so one made before this cannot bring a session back: a lost laptop's way out.
   */
  function revokeDeviceSessions(request: IncomingMessage, response: ServerResponse): void {
    const kind = sessionKind(request);
    if (kind === null) throw new HttpError(401, "sign in first");
    const own = kind === "device-code";
    const ended = store.revokeDeviceCodeSessions();
    json(response, 200, { ended, ...(own ? { signedOut: true } : {}) }, own ? { "set-cookie": clearedSessionCookie() } : {});
  }

  async function handle(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
    if (path === "/api/me" && request.method === "GET") {
      const kind = sessionKind(request);
      const signedIn = kind !== null;
      const deviceSessions = signedIn ? store.countDeviceCodeSessions() : 0;
      // `via` only to a caller whose own session a code made: Settings then does not offer it Add a device.
      const via = kind === "device-code" ? { via: "device-code" } : {};
      json(response, 200, { signedIn, ...(config.deviceSession ? { deviceSession: true } : {}), ...(deviceSessions ? { deviceSessions } : {}), ...via });
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
      case "/api/auth/device-session":
        if (!config.deviceSession) throw new HttpError(404, "not found");
        await deviceSession(request, response);
        return true;
      // Whatever the switch says: one turned off can still end the sessions it made.
      case "/api/auth/device-sessions/revoke":
        revokeDeviceSessions(request, response);
        return true;
      default:
        throw new HttpError(404, "not found");
    }
  }

  return { handle, hasSession, hasPasskeySession, createSession };
}
