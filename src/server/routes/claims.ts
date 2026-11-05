import {
  claimAddSchema,
  claimReleaseSchema,
  claimsOverlap,
  DEFAULT_CLAIM_TTL_MINUTES,
  MAX_CLAIMS,
  type ClaimHeld,
  type ClaimsResponse,
} from "../../shared/claims.js";
import { ClaimsStore } from "../claims.js";
import { hasBearer, HttpError, json, readJson, requireBearer } from "../httputil.js";
import { parseRedacted } from "../redact.js";
import type { Router } from "./router.js";
import { APP_NAME } from "../../shared/names.js";

// The claims board: chats claim shared paths with the board token (`rivet claim`, and the PreToolUse hook in
// .claude/hooks/claims.mjs); Rivet and the app read them. Every read and write first drops expired claims and those
// whose PR merged or closed. A minute's timer also settles between requests, so a claim made on a branch learns its
// PR while the bridge still lists it open, and goes when that PR does.

const BODY_MAX = 4 * 1024;
const SETTLE_EVERY_MS = 60_000;

export function register(router: Router): void {
  const { config, requireSession, now, prs, logger } = router.deps;
  const claims = new ClaimsStore(config.dataDir);
  router.onClose(() => claims.close());
  const settle = () => claims.settle(now(), prs());
  const timer = setInterval(() => {
    try {
      settle();
    } catch (error) {
      logger.error(`[claims] settle failed: ${error instanceof Error ? error.message : "error"}`);
    }
  }, SETTLE_EVERY_MS);
  timer.unref();
  router.onClose(() => clearInterval(timer));

  router.on("GET", "/api/claims", ({ request, response }) => {
    if (!hasBearer(request, config.boardTokenDigest)) requireSession(request);
    settle();
    const body: ClaimsResponse = { claims: claims.list() };
    json(response, 200, body);
  });

  router.on("POST", "/api/claims", async ({ request, response }) => {
    requireBearer(request, config.boardTokenDigest);
    const parsed = parseRedacted(claimAddSchema, await readJson(request, BODY_MAX));
    if (!parsed.success) {
      json(response, 400, { error: "invalid claim", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    // From here to the write there is no await, so two claims on one path cannot both see it free.
    settle();
    const { pattern, chat, pr, branch, note, ttlMinutes, force } = parsed.data;
    const live = claims.list();
    const holders = live.filter((claim) => claim.chat !== chat && claimsOverlap(claim.pattern, pattern));
    // Renewing a claim this chat already holds is never refused: a claim added beside another's with force keeps renewing.
    const renewal = live.some((claim) => claim.chat === chat && claim.pattern === pattern);
    if (holders.length && !force && !renewal) {
      const body: ClaimHeld = { error: "held by another chat", holders };
      json(response, 409, body);
      return;
    }
    if (!renewal && live.length >= MAX_CLAIMS) throw new HttpError(507, `${APP_NAME} holds at most ${MAX_CLAIMS} claims`);
    const at = now();
    const expiresAt = new Date(at.getTime() + (ttlMinutes ?? DEFAULT_CLAIM_TTL_MINUTES) * 60_000).toISOString();
    const { claim, created } = claims.put({ pattern, chat, pr, branch, note, createdAt: at.toISOString(), expiresAt });
    // A branch whose PR is already open gets its number now, not at the next request.
    settle();
    const stored = claims.list().find((one) => one.id === claim.id);
    if (!stored) throw new HttpError(410, "that claim's PR has already merged or closed");
    json(response, created ? 201 : 200, { claim: stored, holders });
  });

  router.on("POST", "/api/claims/release", async ({ request, response }) => {
    requireBearer(request, config.boardTokenDigest);
    const parsed = claimReleaseSchema.safeParse(await readJson(request, BODY_MAX));
    if (!parsed.success) {
      json(response, 400, { error: "invalid release", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    settle();
    const { chat, id, pattern } = parsed.data;
    const released = claims.release(chat, id !== undefined ? { id: Number(id.slice(2)) } : { pattern: pattern as string });
    if (!released) throw new HttpError(404, `${chat} holds no such claim`);
    json(response, 200, { released });
  });
}
