import {
  MAX_USAGE_BYTES,
  usageAskSchema,
  usageBatchSchema,
  USAGE_BATCHES_PER_MINUTE,
  usageReportQuerySchema,
  usageSummaryQuerySchema,
  type UsageSummary,
} from "../../shared/usage-ids.js";
import { HttpError, json, readJson, requireSameOrigin } from "../httputil.js";
import { createUsageAsks } from "../usage-report.js";
import type { Router } from "./router.js";

// What you used: the app sends the screens you opened and the controls you tapped, by registry id only
// (shared/usage-ids.ts), and What you used reads them back. An id outside the registry refuses the whole batch,
// so nothing but those fixed strings and numbers is ever stored.

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function register(router: Router): void {
  const { config, store, requireSession, now, addUpdate, logger } = router.deps;
  const asks = createUsageAsks({ store, addUpdate, now, logger });
  router.onClose(store.onReply((reply) => asks.answered(reply.itemId, reply.choice ?? reply.decision, reply.at)));

  router.on("POST", "/api/usage", async ({ request, response }) => {
    requireSession(request);
    requireSameOrigin(request, config.origin);
    if (store.countHit("usage", "owner", MINUTE_MS) > USAGE_BATCHES_PER_MINUTE) throw new HttpError(429, "too many usage batches");
    const parsed = usageBatchSchema.safeParse(await readJson(request, MAX_USAGE_BYTES));
    if (!parsed.success) throw new HttpError(400, "invalid usage batch");
    if (!store.addUsage(parsed.data, now())) throw new HttpError(429, "too many usage events today");
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
  });

  router.on("GET", "/api/usage/summary", ({ request, response, url }) => {
    requireSession(request);
    const parsed = usageSummaryQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new HttpError(400, "invalid summary query");
    const { days, device } = parsed.data;
    const { since, counts } = store.usageSummary(new Date(now().getTime() - days * DAY_MS).toISOString(), device);
    const body: UsageSummary = { days, device, since, counts };
    json(response, 200, body);
  });

  // What you used: counted from one read when the page opens.
  router.on("GET", "/api/usage/report", ({ request, response, url }) => {
    requireSession(request);
    const parsed = usageReportQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new HttpError(400, "invalid report query");
    json(response, 200, asks.report(parsed.data.device));
  });

  router.on("POST", "/api/usage/ask", async ({ request, response }) => {
    requireSession(request);
    requireSameOrigin(request, config.origin);
    const parsed = usageAskSchema.safeParse(await readJson(request, 1024));
    if (!parsed.success) throw new HttpError(400, "invalid ask");
    const made = asks.ask(parsed.data.id, parsed.data.ask, parsed.data.device);
    if ("error" in made) throw new HttpError(made.status, made.error);
    json(response, 201, made);
  });
}
