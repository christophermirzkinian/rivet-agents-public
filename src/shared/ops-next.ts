import { zoneClock } from "./ops.js";
import type { Schedule } from "./schedules.js";

// The Plan page's Next list: dated things coming up, each with when it happens.
// Only dated items: a job with no next run, or an always-on one, is not here.

/** A schedule's next run shows this far ahead. */
export const NEXT_SCHEDULE_DAYS = 7;
export const MAX_NEXT_ROWS = 20;

export type NextSource = "schedule" | "job";

export interface NextRow {
  /** Steady for the same thing, so the page can keep a row between refreshes. */
  key: string;
  title: string;
  /** The instant it happens. */
  at: string;
  /** "Wed 4 Nov, 7:00pm"; "Wed 4 Nov" for an all-day item. */
  when: string;
  allDay: boolean;
  source: NextSource;
}

/** A job with a known next run, from outside the schedules (the Scheduled page's jobs). */
export interface NextJob {
  key: string;
  title: string;
  at: string;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A day as "Wed 4 Nov", spelt out by hand: toLocaleDateString's punctuation changes with the ICU build. */
function dayWords(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${DAYS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]} ${d} ${MONTHS[m! - 1]}`;
}

/** "Wed 4 Nov, 7:00pm" for an instant. */
export function nextWhen(at: Date, allDay = false): string {
  const clock = zoneClock(at);
  if (allDay) return dayWords(clock.day);
  const hour = Math.floor(clock.minute / 60);
  const minute = String(clock.minute % 60).padStart(2, "0");
  return `${dayWords(clock.day)}, ${hour % 12 || 12}:${minute}${hour < 12 ? "am" : "pm"}`;
}

export interface NextInput {
  now: Date;
  /** The schedules as last read; null while that reading is stale. */
  schedules: readonly Schedule[] | null;
  jobs?: readonly NextJob[];
}

/** The upcoming dated rows, soonest first. */
export function buildNext({ now, schedules, jobs = [] }: NextInput): NextRow[] {
  const rows: NextRow[] = [];
  const within = (at: number) => at > now.getTime() && at <= now.getTime() + NEXT_SCHEDULE_DAYS * 86_400_000;
  for (const item of schedules ?? []) {
    const at = item.nextRun ? Date.parse(item.nextRun) : NaN;
    // A job that runs every few minutes is not "next": only daily and weekly ones are dated.
    if (!item.on || (item.group !== "daily" && item.group !== "weekly") || !within(at)) continue;
    rows.push({ key: `schedule:${item.id}`, title: item.name, at: new Date(at).toISOString(), when: nextWhen(new Date(at)), allDay: false, source: "schedule" });
  }
  for (const job of jobs) {
    const at = Date.parse(job.at);
    if (!within(at)) continue;
    rows.push({ key: `job:${job.key}`, title: job.title, at: new Date(at).toISOString(), when: nextWhen(new Date(at)), allDay: false, source: "job" });
  }
  return rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.key.localeCompare(b.key)).slice(0, MAX_NEXT_ROWS);
}
