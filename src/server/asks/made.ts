import { isFinished, MAX_ASKS, type Ask } from "../../shared/asks.js";
import type { OpsStatus } from "../../shared/ops-status.js";
import { newAsk, nextAskId, patched } from "../routes/asks.js";
import type { Store } from "../store.js";

// Asks the server makes itself: Rivet's own pick-ups, so what it is on shows beside your asks with the same stage and
// time. Your messages become asks through POST /api/asks (`from`).

type AskStore = Pick<Store, "listAsks" | "heldAskIds" | "getAsk" | "addAsk" | "replaceAsk" | "countAsks">;

export const pickupSource = (item: { kind: string; key: string }): string => `pickup:${item.kind}/${item.key}`;

/** The unfinished ask with this source, newest first; null when none. */
export function openAskFrom(store: Pick<Store, "listAsks">, source: string): Ask | null {
  return store.listAsks({ limit: MAX_ASKS }).find((ask) => ask.source === source && !isFinished(ask.stage)) ?? null;
}

/**
 * The ask for a pick-up Rivet just started: the open one for that item, its time promised again, else a new one by
 * Rivet. Null when the store is full or refuses it; a pick-up never fails for want of its ask.
 */
export function pickupAsk(store: AskStore, item: { kind: string; key: string; repo?: string }, now: Date, dueMinutes: number): Ask | null {
  const source = pickupSource(item);
  const due = new Date(now.getTime() + dueMinutes * 60_000).toISOString();
  const open = openAskFrom(store, source);
  if (open) {
    // A pick-up started again is a fresh promise for a fresh try, not a slip of the last one.
    const next = patched({ ...open, dueAt: undefined, askedForTimeAt: undefined } as Ask, { stage: "building", due }, now);
    return store.replaceAsk(next, open.version) ? next : null;
  }
  if (store.countAsks() >= MAX_ASKS) return null;
  const ask = newAsk({ id: nextAskId(store), words: `Fix ${item.kind} ${item.key}`, who: "rivet", source, stage: "building", prs: [], due, by: "rivet" }, now);
  return store.addAsk(ask) ? ask : null;
}

/** The why a dismissal parks a pick-up ask with, so undoing the dismissal reopens only an ask it parked. */
export const DISMISSED_WHY = "Dismissed on Ops";

/**
 * A dismissed break with no Ops record: its open pick-up ask is parked, as no record will ever settle it and it would
 * stay counted on Your asks and the Progress mark.
 */
export function parkPickupAsk(store: Pick<Store, "listAsks" | "replaceAsk">, item: { kind: string; key: string }, now: Date): void {
  const open = openAskFrom(store, pickupSource(item));
  if (open) store.replaceAsk(patched(open, { stage: "parked", why: DISMISSED_WHY }, now), open.version);
}

/** A dismissal undone: the pick-up ask it parked is open again, unless a newer one for the item is. */
export function reopenPickupAsk(store: Pick<Store, "listAsks" | "replaceAsk">, item: { kind: string; key: string }, now: Date): void {
  const newest = store.listAsks({ limit: MAX_ASKS }).find((ask) => ask.source === pickupSource(item));
  if (newest?.stage === "parked" && newest.why === DISMISSED_WHY) store.replaceAsk(patched(newest, { stage: "building", why: null }, now), newest.version);
}

/** Each open pick-up ask whose Ops record now says fixed or parked, finished to match: done or parked. */
export function settlePickupAsks(store: AskStore, statuses: readonly OpsStatus[], now: Date): void {
  const open = new Map<string, Ask>();
  for (const ask of store.listAsks({ limit: MAX_ASKS })) if (ask.source?.startsWith("pickup:") && !isFinished(ask.stage) && !open.has(ask.source)) open.set(ask.source, ask);
  if (!open.size) return;
  for (const status of statuses) {
    if (status.state !== "fixed" && status.state !== "parked") continue;
    const ask = open.get(pickupSource(status));
    if (!ask) continue;
    store.replaceAsk(patched(ask, { stage: status.state === "fixed" ? "done" : "parked" }, now), ask.version);
  }
}
