import { parseDue } from "../../../src/shared/ops-due.js";
import { when, type At } from "../../../src/shared/when.js";

/**
 * A record's free-text eta as Plan says it while the record gives no dueAt. One that names a time, read at `writtenAt` as
 * the server reads an eta ("60" written at 5:10pm, "6:10pm"), is said through when(): "by 6:10pm", "by Tue 9:00am".
 * An ISO time is said through when() whenever it was written, even one the server would no longer take ("by 5:00pm" from
 * "2026-10-26T06:00:00Z"). One it cannot read, or with no write time, is shown as said: "by Sat 9:00am" as written,
 * "by soon" from "soon".
 */
export function etaWords(eta: string, writtenAt?: At, now: At = Date.now()): string {
  const said = eta.trim();
  const written = writtenAt === undefined ? Number.NaN : new Date(writtenAt).getTime();
  if (Number.isFinite(written)) {
    const due = parseDue(said, new Date(written), true);
    if ("dueAt" in due) return `by ${when(due.dueAt, now)}`;
  }
  const iso = /^\d{4}-\d{2}-\d{2}T/.test(said) ? when(said, now) : "";
  if (iso) return `by ${iso}`;
  if (/^\d+$/.test(said)) return `in ${said} min`;
  return /^(by|in|at|around|about|before|after|within|today|tonight|tomorrow|mon|tue|wed|thu|fri|sat|sun)\b/i.test(said) ? said : `by ${said}`;
}
