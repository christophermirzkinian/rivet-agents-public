import type { Need } from "../../shared/board.js";
import { schedulesSnapshotSchema, SCHEDULES_MAX_BYTES } from "../../shared/schedules.js";
import { json, readJson, requireBearer } from "../httputil.js";
import { parseRedacted } from "../redact.js";
import { boardPushes, summaryPushKey } from "../push.js";
import { schedulePushKey, SchedulesStore } from "../schedules.js";
import type { RouteDeps, Router } from "./router.js";

// The Schedules tab: the Mac bridge sends its live read of every schedule once a minute,
// and the app reads it back. The on/off switch is an action (routes/command.ts).

/** The card is on the feed (http.ts adds it to the board you read); this is its push, like any new card's. */
export function pushFailing(push: RouteDeps["push"], logger: RouteDeps["logger"], cards: Need[]): void {
  if (!cards.length) return;
  // As any new cards' pushes, at most five; each card's under its key, so one quiet hours held is checked again before
  // the digest. A "more cards" summary carries the keys of the cards it counts.
  for (const { payload, needs } of boardPushes(cards)) {
    const key = needs.length === 1 ? schedulePushKey(needs[0]!) : summaryPushKey(needs.map(schedulePushKey));
    void push.notify(payload, "card", key).catch((error: unknown) => {
      logger.error(`[push] failing-schedule push failed: ${error instanceof Error ? error.message : "error"}`);
    });
  }
}

export function register(router: Router): void {
  const { config, bridge, requireSession, push, logger, now } = router.deps;
  const schedules = new SchedulesStore(config.dataDir);
  router.onClose(() => schedules.close());

  router.on("PUT", "/api/bridge/schedules", async ({ request, response }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const parsed = parseRedacted(schedulesSnapshotSchema, await readJson(request, SCHEDULES_MAX_BYTES));
    if (!parsed.success) {
      json(response, 400, { error: "invalid schedules snapshot", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    bridge.seen();
    const failing = schedules.put(parsed.data, now());
    json(response, 200, { ok: true });
    pushFailing(push, logger, failing);
  });

  router.on("GET", "/api/schedules", ({ request, response }) => {
    requireSession(request);
    json(response, 200, schedules.view(now()));
  });
}
