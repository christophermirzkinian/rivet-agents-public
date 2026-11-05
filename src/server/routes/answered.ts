import { ANSWERED_KEEP_MS, answeredDone, MAX_ANSWERED, prKey, REOPEN_NOTICE_MS, reopenAckSchema, reopenExpired, reopenSendSchema, type AnsweredResponse, type Reopen, type ReopenEvent } from "../../shared/answered.js";
import type { BridgeChannel } from "../events.js";
import { needRev, openBoard } from "../http.js";
import { HttpError, json, readJson, requireBearer, requireSameOrigin } from "../httputil.js";
import { parseRedacted } from "../redact.js";
import type { Store } from "../store.js";
import type { Router } from "./router.js";

// Cards' Answered list and Reopen: every card you answered stays 30 days, and any of them reopens. The
// reopen route itself is POST /api/board/needs/:id/again in http.ts, a board write; this area serves the list and
// carries each Reopen's notice to Rivet's chat through the bridge, offered again on each connect until it is acked.

/** The bridge event for a Reopen: the card's title, chat and repo as it was reopened; null once its earlier answer is gone. */
export function reopenEvent(store: Store, reopen: Reopen): ReopenEvent | null {
  const earlier = store.getReply(reopen.replyId);
  if (!earlier) return null;
  return {
    id: reopen.id,
    itemId: reopen.cardId,
    title: reopen.title,
    ...(reopen.chat ? { chat: reopen.chat } : {}),
    ...(reopen.repo ? { repo: reopen.repo } : {}),
    at: reopen.at,
    earlier: { replyId: earlier.id, decision: earlier.decision, ...(earlier.choice ? { choice: earlier.choice } : {}) },
  };
}

/** Sends a Reopen's notice now if a bridge that takes one is connected; the next connect offers it otherwise. */
export function announceReopen(store: Store, bridge: Pick<BridgeChannel, "sendReopen">, reopen: Reopen): void {
  const event = reopenEvent(store, reopen);
  if (event) bridge.sendReopen(event);
}

export function register(router: Router): void {
  const { config, store, bridge, requireSession, schedules, now } = router.deps;

  bridge.onAttach(() => {
    for (const reopen of store.undeliveredReopens(new Date(now().getTime() - REOPEN_NOTICE_MS).toISOString())) announceReopen(store, bridge, reopen);
  });

  router.on("GET", "/api/answered", ({ request, response }) => {
    requireSession(request);
    const at = now();
    const stored = store.getBoard()?.board ?? null;
    const open = openBoard(store, schedules, stored, at)?.needs ?? [];
    const openIds = new Set(open.map((need) => need.id));
    const onBoard = new Map((stored?.needs ?? []).map((need) => [need.id, need]));
    store.pruneAnswered(new Date(at.getTime() - ANSWERED_KEEP_MS).toISOString());
    const kept = store
      .keptAnswered(new Date(at.getTime() - ANSWERED_KEEP_MS).toISOString(), MAX_ANSWERED)
      // A card open again (reopened, or sent again at a new revision) is on the open deck instead.
      .filter(({ card }) => !openIds.has(card.id))
      .map(({ card, rev, reply }) => {
        // Still on the board as answered: that copy, which a card rebuilt from its answer alone stands in for.
        const live = onBoard.get(card.id);
        return { card: { ...(live && needRev(live) === rev ? live : card), rev }, reply };
      });
    // Show done: the PRs the board lists as shipped, and the asks that are finished, name the work that is.
    const facts = {
      merged: new Set((stored?.shipped ?? []).flatMap((row) => (row.pr === undefined ? [] : [prKey(row.repo, row.pr)]))),
      finishedCards: store.finishedAskCards(kept.map(({ card }) => card.id)),
    };
    const cards = kept.map((entry) => (answeredDone(entry, facts) ? { ...entry, done: true as const } : entry));
    const reopens = store.latestReopens([...openIds]);
    const reopened = open.flatMap((need) => {
      const reopen = reopens.get(need.id);
      return reopen && reopen.rev === needRev(need) ? [{ ...reopen, earlier: store.getReply(reopen.replyId), ...(reopenExpired(reopen, at) ? { expired: true as const } : {}) }] : [];
    });
    const body: AnsweredResponse = { cards, reopened };
    json(response, 200, body);
  });

  // Send again: a Reopen's notice the bridge never delivered is offered for another 24 hours, now and on each connect.
  router.on("POST", "/api/answered/reopen-send", async ({ request, response }) => {
    requireSession(request);
    requireSameOrigin(request, config.origin);
    const parsed = reopenSendSchema.safeParse(await readJson(request, 1024));
    if (!parsed.success) throw new HttpError(400, "invalid send");
    const reopen = store.getReopen(parsed.data.id);
    if (!reopen) throw new HttpError(404, "no such reopen");
    if (reopen.delivery) throw new HttpError(409, "its chat was told already");
    const sent = store.resendReopen(reopen.id, now().toISOString())!;
    announceReopen(store, bridge, sent);
    json(response, 200, sent);
  });

  router.on("POST", "/api/bridge/reopen-ack", async ({ request, response }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const parsed = parseRedacted(reopenAckSchema, await readJson(request, 4 * 1024));
    if (!parsed.success) throw new HttpError(400, "invalid reopen ack");
    const { id, ...ack } = parsed.data;
    const reopen = store.ackReopen(id, ack, now().toISOString());
    if (!reopen) throw new HttpError(404, "no such reopen");
    json(response, 200, { ok: true });
  });
}
