import { overnightLine } from "../../shared/words.js";
import { createMorning, morningMerged, morningOfPushKey } from "../morning.js";
import { cardPayload } from "../push.js";
import { summaryNow } from "../summary-now.js";
import { createUsageAsks } from "../usage-report.js";
import type { Router } from "./router.js";

// The Morning card's job. It runs only in the server main.ts starts, so a test app never files a card by the wall clock.

export const MORNING_TICK_MS = 60_000;
let running = false;

/** Called by main.ts before it makes the app: that app files the Morning card at 7am local time. */
export function runMorningJob(): void {
  running = true;
}

export function register(router: Router): void {
  const { config, store, addUpdate, prs, now, logger, push } = router.deps;
  const usage = createUsageAsks({ store, addUpdate, now, logger });
  const usageUrl = new URL("/?tab=what-you-used", config.origin);
  const morning = createMorning({
    now,
    addUpdate,
    merged: () => prs().merged,
    needs: () => summaryNow(router.deps).needsYou,
    board: () => store.getBoard()?.board ?? null,
    answered: (id) => store.listReplies({ items: [id], limit: 1 }).length > 0,
    neverUsed: (at) => usage.neverCount(at),
    // A card link must be https: a local http server's Morning card goes without it.
    ...(usageUrl.protocol === "https:" ? { usageUrl: usageUrl.href } : {}),
    logger,
  });

  // A Morning push quiet hours held whose card is off the board by the time the digest goes leaves it unsent, as there
  // is nothing left to read it from.
  router.onClose(
    push.onDigestRelease((keys) =>
      keys.filter((key) => {
        const id = morningOfPushKey(key);
        return id !== null && !store.getBoard()?.board.needs.some((need) => need.id === id);
      }),
    ),
  );

  // One held while cards were answered or minimised says how many need you as it goes, not as it was held.
  router.onClose(
    push.onDigestReword((held) =>
      held.flatMap(({ key }) => {
        const id = morningOfPushKey(key);
        const card = id === null ? undefined : store.getBoard()?.board.needs.find((need) => need.id === id);
        // A card in words that name no merged count goes as it was held.
        const merged = card ? morningMerged(card) : undefined;
        return card && merged !== undefined ? [{ key, body: cardPayload({ ...card, ask: overnightLine(merged, summaryNow(router.deps).needsYou) }).body }] : [];
      }),
    ),
  );

  if (!running) return;
  // A restart after 7am files today's card at once if it is missing. On Mondays the same tick sends What you used's
  // Retire? cards, the only scheduled work it has.
  const tick = () => {
    try {
      morning.tick();
    } catch (error) {
      logger.error(`[morning] ${error instanceof Error ? error.message : "error"}`);
    }
    try {
      usage.weekly();
    } catch (error) {
      logger.error(`[usage] ${error instanceof Error ? error.message : "error"}`);
    }
  };
  const first = setTimeout(tick, 0);
  const timer = setInterval(tick, MORNING_TICK_MS);
  timer.unref();
  router.onClose(() => {
    clearTimeout(first);
    clearInterval(timer);
  });
}
