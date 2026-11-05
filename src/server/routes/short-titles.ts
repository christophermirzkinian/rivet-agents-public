import { SHORT_HASH_PATTERN, SHORT_PENDING_MAX, shortTitleAnswerSchema } from "../../shared/short-titles.js";
import { HttpError, json, readJson, requireBearer } from "../httputil.js";
import { parseRedacted } from "../redact.js";
import type { Router } from "./router.js";

// The bridge's Haiku pass over the rows' short titles (bridge/lib/row-titler.mjs): the words still queued, newest
// first, and its one answer for each.

const PREFIX = "/api/bridge/short-titles/";
const BODY_MAX = 1024;

export function register(router: Router): void {
  const { config, bridge, titles } = router.deps;

  router.on("GET", "/api/bridge/short-titles", ({ request, response, url }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const raw = url.searchParams.get("limit");
    const limit = raw === null ? 10 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > SHORT_PENDING_MAX) throw new HttpError(400, `limit is 1 to ${SHORT_PENDING_MAX}`);
    bridge.seen();
    json(response, 200, { rows: titles.pending(limit) });
  });

  router.onPrefix("POST", PREFIX, async ({ request, response, url }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const hash = url.pathname.slice(PREFIX.length);
    if (!SHORT_HASH_PATTERN.test(hash)) throw new HttpError(404, "not found");
    const parsed = parseRedacted(shortTitleAnswerSchema, await readJson(request, BODY_MAX));
    if (!parsed.success) throw new HttpError(400, "invalid short title");
    if (!titles.put(hash, parsed.data.title)) throw new HttpError(404, "no such row");
    json(response, 200, { ok: true });
  });
}
