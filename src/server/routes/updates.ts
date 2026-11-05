import { isUpdate } from "../../shared/answers.js";
import { ID_PATTERN, type OlderUpdatesResponse } from "../../shared/board.js";
import { MAX_CARDS, needRev } from "../http.js";
import { HttpError, json } from "../httputil.js";
import type { Store } from "../store.js";
import type { Router } from "./router.js";

// The Updates stream's Show older: the update cards you saw that are no longer on the board, past the 7 days
// a seen one stays (UPDATE_KEEP_MS) or dropped sooner for room. Read with his session only, never the board token.

/** Cards a page holds by default, and at most. */
export const OLDER_PAGE = 20;
export const OLDER_PAGE_MAX = 50;

/** Keeps the board's update cards you saw before the server kept each one at Seen, as they show; run as the app starts. */
export function keepSeenOnBoard(store: Store): void {
  for (const need of store.getBoard()?.board.needs.filter(isUpdate) ?? []) {
    const rev = needRev(need);
    if (store.hasSeenUpdate(need.id, rev)) continue;
    const seen = store.firstReplyAt(need.id, rev, "seen");
    if (seen) store.keepSeenUpdate(need, rev, seen.at);
  }
}

export function register(router: Router): void {
  const { store, requireSession } = router.deps;

  keepSeenOnBoard(store);

  router.on("GET", "/api/updates/older", ({ request, response, url }) => {
    requireSession(request);
    const beforeAt = url.searchParams.get("before");
    const beforeId = url.searchParams.get("id");
    if ((beforeAt === null) !== (beforeId === null)) throw new HttpError(400, "before and id go together");
    if (beforeAt !== null && (beforeAt.length > 40 || !Number.isFinite(Date.parse(beforeAt)) || !ID_PATTERN.test(beforeId!))) throw new HttpError(400, "invalid before");
    const limit = Math.min(Math.max(Math.trunc(Number(url.searchParams.get("limit") ?? OLDER_PAGE)) || OLDER_PAGE, 1), OLDER_PAGE_MAX);
    const onBoard = new Set((store.getBoard()?.board.needs ?? []).map((need) => need.id));
    // A card still on the board shows in the stream itself; at most MAX_CARDS of them are skipped, so this read has a
    // page and one more whenever there is one.
    const rows = store
      .seenUpdates(beforeAt === null ? null : { seenAt: beforeAt, id: beforeId! }, limit + 1 + MAX_CARDS)
      .filter(({ card }) => !onBoard.has(card.id));
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const body: OlderUpdatesResponse = {
      cards: page.map(({ card, rev, seenAt }) => ({ ...card, rev, seen: true, seenAt })),
      next: rows.length > limit && last ? { before: last.seenAt, id: last.card.id } : null,
    };
    json(response, 200, body);
  });
}
