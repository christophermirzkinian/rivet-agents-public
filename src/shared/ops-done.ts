import type { OpsStatus } from "./ops-status.js";
import { zoneClock } from "./ops.js";

// The Plan page's Done list: fixed records show for today and fold away a day
// after they were fixed. A record whose card is still open stays. Pure: the page and the server's daily fold both use it.

/** A fixed record drops out of Done this long after it was fixed. */
export const DONE_FOLD_MS = 24 * 3600_000;
/** The fold runs once a day, from this minute of it (4am). */
export const DONE_FOLD_FROM_MINUTE = 4 * 60;

/** Whether a card for the record is still open. */
export type HasOpenCard = (status: Pick<OpsStatus, "kind" | "key" | "since">) => boolean;

/** The fixed records Done shows: those fixed today, and any with an open card; newest first. */
export function doneToday(statuses: readonly OpsStatus[], now: Date, hasOpenCard: HasOpenCard): OpsStatus[] {
  const today = zoneClock(now).day;
  return statuses
    .filter((status) => status.state === "fixed" && (zoneClock(new Date(status.updatedAt)).day === today || hasOpenCard(status)))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** The fixed records to remove now: fixed over 24 hours ago, with no open card. */
export function foldedDone(statuses: readonly OpsStatus[], now: Date, hasOpenCard: HasOpenCard): OpsStatus[] {
  return statuses.filter((status) => status.state === "fixed" && now.getTime() - Date.parse(status.updatedAt) > DONE_FOLD_MS && !hasOpenCard(status));
}

/** Whether the daily fold is due: it is past 4am and it has not run today (`lastDay`, a "YYYY-MM-DD"). */
export function foldDue(now: Date, lastDay: string | null): boolean {
  const clock = zoneClock(now);
  return clock.minute >= DONE_FOLD_FROM_MINUTE && lastDay !== clock.day;
}
