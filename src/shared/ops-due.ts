import { addDays, zoneClock, zoneInstant } from "./ops.js";
import { when } from "./when.js";

// A status record's done-by time (automation 2 of the Ops plan, 2026-10-24): every investigating or in-progress write
// says when it will be done, in your time, and why. Nobody else's clock is read.

/** A done-by further out than this needs the monitor's --by. */
export const MAX_DUE_MS = 24 * 3600_000;
/** Even the monitor's. */
export const MAX_MONITOR_DUE_MS = 7 * 24 * 3600_000;
/** "tonight" is 11pm. */
const TONIGHT_MINUTE = 23 * 60;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The instant `eta` names, read at `now`: whole minutes ("90", "90m", "2h"), a clock time ("3pm", "3:30pm",
 * "15:30", "tonight" for 11pm; one already past today is tomorrow's) or an ISO time with its offset. A time not ahead of
 * `now` or too far out is refused, with the reason.
 */
export function parseDue(eta: string, now: Date, monitor = false): { dueAt: string } | { error: string } {
  const text = eta.trim().toLowerCase().replace(/^(?:by|today)\s+/, "");
  let at: number | null = null;
  const minutes = /^(\d{1,5})\s*(?:m|min|mins|minutes)?$/.exec(text);
  const hours = /^(\d{1,3}(?:\.\d{1,2})?)\s*(?:h|hr|hrs|hour|hours)$/.exec(text);
  const twelve = /^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)$/.exec(text);
  const day = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (minutes) at = now.getTime() + Number(minutes[1]) * 60_000;
  else if (hours) at = now.getTime() + Math.round(Number(hours[1]) * 60) * 60_000;
  else if (twelve && Number(twelve[1]) >= 1 && Number(twelve[1]) <= 12) at = clock(((Number(twelve[1]) % 12) + (twelve[3] === "pm" ? 12 : 0)) * 60 + Number(twelve[2] ?? 0), now);
  else if (day) at = clock(Number(day[1]) * 60 + Number(day[2]), now);
  else if (text === "tonight") at = clock(TONIGHT_MINUTE, now);
  else if (ISO.test(eta.trim()) && Number.isFinite(Date.parse(eta.trim()))) at = Date.parse(eta.trim());
  if (at === null) return { error: 'eta is minutes ("90"), a time ("3pm", "3:30pm", "15:30", "tonight") or an ISO time' };
  if (Number.isNaN(at)) return { error: "eta names a time that does not exist: the clocks go forward an hour that night" };
  if (at <= now.getTime()) return { error: "eta must be ahead of now" };
  if (at - now.getTime() > (monitor ? MAX_MONITOR_DUE_MS : MAX_DUE_MS)) {
    return { error: monitor ? "eta is at most 7 days out" : "eta is at most 24 hours out; a later one is the monitor's to set" };
  }
  return { dueAt: new Date(at).toISOString() };
}

/** The next time the clock reads `minute`: today's, else tomorrow's. */
function clock(minute: number, now: Date): number {
  const exists = (day: string, at: Date) => zoneClock(at).day === day && zoneClock(at).minute === minute;
  const today = zoneClock(now).day;
  const first = zoneInstant(today, minute);
  if (exists(today, first)) {
    if (first.getTime() > now.getTime()) return first.getTime();
  } else if (minute > zoneClock(now).minute) return NaN;
  const day = addDays(today, 1);
  const next = zoneInstant(day, minute);
  return exists(day, next) ? next.getTime() : NaN;
}

/** "by 3:30pm", "by Sat 9:00am" when not today: the free-text eta an app from before `dueAt` shows. */
export function dueLabel(dueAt: string, now: Date): string {
  return `by ${when(dueAt, now)}`;
}
