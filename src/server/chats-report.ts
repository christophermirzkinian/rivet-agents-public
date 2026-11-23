import { z } from "zod";

import { CHAT_PATTERN } from "../shared/board.js";
import { CHATS_STALE_MS, type ChatsReport } from "../shared/chats.js";
import { json, readJson, requireBearer } from "./httputil.js";
import { parseRedacted } from "./redact.js";
import type { Router } from "./routes/router.js";

// Chats run themselves: the bridge's last pass, which the Behaviours row and Progress count. Nothing here counts or
// guesses: no fresh report is "Can't tell".

const REPORT_BODY_MAX = 16 * 1024;

const ONE_LINE = /^[^\x00-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]+$/;
const chat = z.string().regex(CHAT_PATTERN);
const count = z.number().int().min(0).max(500);

export const chatsReportSchema = z
  .object({
    open: count,
    working: count,
    cap: z.number().int().min(1).max(20),
    kept: z.array(z.object({ name: chat, reason: z.string().max(80).regex(ONE_LINE) }).strict()).max(100),
    closed: z.array(chat).max(100),
    at: z.string().datetime({ offset: true }),
  })
  .strict() satisfies z.ZodType<ChatsReport>;

export interface ChatsBoard {
  /** The last report while it is fresh, else null. */
  report(): ChatsReport | null;
  /** The last report and how much longer it stays fresh (ms), read at one time; null when there is none fresh. */
  fresh(): { report: ChatsReport; leftMs: number } | null;
}

export function registerChats(router: Router): ChatsBoard {
  const { config, bridge } = router.deps;
  /** In memory, as the bridge reports again on each pass. */
  let last: ChatsReport | null = null;
  let lastAt = 0;
  bridge.onDetach(() => (last = null));

  router.on("PUT", "/api/bridge/chats", async ({ request, response }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const parsed = parseRedacted(chatsReportSchema, await readJson(request, REPORT_BODY_MAX));
    if (!parsed.success) {
      json(response, 400, { error: "invalid chats report", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    bridge.seen();
    last = parsed.data;
    lastAt = Date.now();
    json(response, 200, { ok: true });
  });

  const fresh = () => {
    const age = Date.now() - lastAt;
    return last !== null && age <= CHATS_STALE_MS ? { report: last, leftMs: CHATS_STALE_MS - age } : null;
  };
  return {
    report: () => fresh()?.report ?? null,
    fresh,
  };
}
