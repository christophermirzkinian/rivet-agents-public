import "./ops.css";

import type { Briefing } from "../../../src/shared/ops.js";
import { clock, dayDate, localDay } from "../../../src/shared/when.js";

// Local noon, so the day never slips across midnight.
const dayOf = (day: string) => dayDate(`${day}T12:00:00`);

/** The calendar day `days` from `day`, both YYYY-MM-DD. */
function addDays(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, date! + days)).toISOString().slice(0, 10);
}

/** "Since yesterday, 6:00pm", "Since earlier today, 7:30am" or "Since Sat 26 Sep". */
export function sinceLabel(briefing: Briefing): string {
  const since = new Date(briefing.since);
  const day = localDay(since);
  const time = clock(since);
  if (day === briefing.day) return `Since earlier today, ${time}`;
  if (day === addDays(briefing.day, -1)) return `Since yesterday, ${time}`;
  return `Since ${dayOf(day)}`;
}

/** When it was composed, so a snapshot never reads as now: "at 6:00pm", "at 6:00pm yesterday" or "at 7:30am Sat 26 Sep". */
export function composedLabel(briefing: Briefing, now = Date.now()): string {
  const at = new Date(briefing.composedAt);
  const time = clock(at);
  const day = localDay(at);
  const today = localDay(now);
  if (day === today) return `at ${time}`;
  if (day === addDays(today, -1)) return `at ${time} yesterday`;
  return `at ${time} ${dayOf(day)}`;
}
