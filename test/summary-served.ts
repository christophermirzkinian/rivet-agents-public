import type { Ask } from "../src/shared/asks.js";
import type { PushQueueRow } from "../src/shared/workers.js";
import { summarize } from "../src/shared/summary.js";
import { opsData } from "../web/src/ops-data.js";
import { app } from "../web/src/state.js";

/**
 * What GET /api/summary would answer for the client's own board, crew and Ops records, made by the same function the
 * route calls, so a test's mark and lines agree with the server (routes/summary.ts).
 */
/** `queue` stands in for the push queue when the crew reading has none: an ask with a place there is moving. */
export function serveSummary(asks: Partial<Ask>[] = [], queue?: PushQueueRow[]): void {
  const at = new Date().toISOString();
  app.summary = summarize({
    needs: [],
    minimised: new Map(),
    board: app.board?.board ?? null,
    crew: { workers: app.workers?.workers ?? [], lapsed: false },
    statuses: opsData.statuses ?? [],
    asks: asks.map((ask, i) => ({ id: `ask-${i}`, words: `Ask ${i}`, who: "owner", stage: "building", prs: [], dueHistory: [], timeline: [], createdAt: at, stageAt: at, updatedAt: at, version: 1, ...ask }) as Ask),
    queue: queue ?? app.workers?.pushQueue ?? [],
    prs: [],
    merged: [],
    now: Date.now(),
  });
}
