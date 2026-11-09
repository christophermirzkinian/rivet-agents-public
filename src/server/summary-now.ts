import { ASK_PAGE_MAX } from "../shared/asks.js";
import { summarize, type Summary } from "../shared/summary.js";
import { stageReadings } from "./asks/stages.js";
import { needRev, openBoard } from "./http.js";
import type { RouteDeps } from "./routes/router.js";

/**
 * The summary as it stands: what GET /api/summary answers, and what the Morning
 * card and the quiet-hours digest count, so a number the server says is the badge's.
 */
export function summaryNow({ store, schedules, now, workers, ops }: Pick<RouteDeps, "store" | "schedules" | "now" | "workers" | "ops">): Summary {
  const at = now();
  const board = store.getBoard()?.board ?? null;
  let statuses: ReturnType<typeof store.listOpsStatuses> = [];
  try {
    statuses = store.listOpsStatuses();
  } catch {
    // No status records yet: nothing is timed, nothing fixed today.
  }
  const { queue, prs, merged } = stageReadings(store, ops.get("github"), ops.get("merged"), at);
  return summarize({
    needs: (openBoard(store, schedules, board, at)?.needs ?? []).map((need) => ({ id: need.id, rev: needRev(need) })),
    minimised: new Map(store.minimised()),
    board,
    // A crew the bridge stopped refreshing comes back empty, which knows no chat to be gone.
    crew: { workers: workers().workers, lapsed: false },
    statuses,
    asks: store.listAsks({ limit: ASK_PAGE_MAX, doneSince: at.toISOString() }),
    queue,
    prs,
    merged,
    now: at.getTime(),
  });
}
