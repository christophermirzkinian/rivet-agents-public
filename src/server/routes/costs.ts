import { costPutSchema, costsView, COST_SERVICE_PATTERN, MAX_COSTS, type CostRow, type CostsResponse } from "../../shared/costs.js";
import { CostsStore } from "../costs.js";
import { hasBearer, HttpError, json, readJson, requireBearer } from "../httputil.js";
import { parseRedacted, redactId } from "../redact.js";
import type { Router } from "./router.js";
import { APP_NAME } from "../../shared/names.js";

// The Costs page: Rivet writes a service's monthly cost with the board token, your phone reads the list with its
// session (and Rivet with its token).

const BODY_MAX = 4 * 1024;
const PREFIX = "/api/costs/";

export function register(router: Router): void {
  const { config, requireSession, now } = router.deps;
  const costs = new CostsStore(config.dataDir);
  router.onClose(() => costs.close());

  router.on("GET", "/api/costs", ({ request, response }) => {
    if (!hasBearer(request, config.boardTokenDigest)) requireSession(request);
    const body: CostsResponse = costsView(costs.list());
    json(response, 200, body);
  });

  // The row Rivet set: `rivet cost set` keeps its name and note.
  router.onPrefix("GET", PREFIX, ({ request, response, url }) => {
    requireBearer(request, config.boardTokenDigest);
    const service = serviceOf(url.pathname);
    const row = costs.list().find((one) => one.service === service);
    if (!row) throw new HttpError(404, "no cost for that service");
    json(response, 200, row);
  });

  router.onPrefix("PUT", PREFIX, async ({ request, response, url }) => {
    requireBearer(request, config.boardTokenDigest);
    const service = serviceOf(url.pathname);
    const parsed = parseRedacted(costPutSchema, await readJson(request, BODY_MAX));
    if (!parsed.success) {
      json(response, 400, { error: "invalid cost", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    const known = costs.has(service);
    if (!known && costs.count() >= MAX_COSTS) throw new HttpError(507, `${APP_NAME} holds at most ${MAX_COSTS} costs`);
    const { checkedAt, note, ...rest } = parsed.data;
    const row: CostRow = { service, ...rest, ...(note ? { note } : {}), checkedAt: new Date(checkedAt ?? now()).toISOString() };
    costs.put(row);
    json(response, known ? 200 : 201, row);
  });

  router.onPrefix("DELETE", PREFIX, ({ request, response, url }) => {
    requireBearer(request, config.boardTokenDigest);
    if (!costs.delete(serviceOf(url.pathname))) throw new HttpError(404, "no cost for that service");
    json(response, 200, { ok: true });
  });
}

function serviceOf(pathname: string): string {
  const service = pathname.slice(PREFIX.length);
  if (!COST_SERVICE_PATTERN.test(service)) throw new HttpError(400, "a service matches [a-z0-9][a-z0-9-]{0,39}");
  // A service name is stored and shown: one shaped as a credential is refused.
  if (redactId(service) !== service) throw new HttpError(400, "bad service");
  return service;
}
