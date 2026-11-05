// The one way Rivet writes a time: a clock time in Rivet's time zone, 12-hour, no tilde, `6:10pm` today and
// `Tue 9:00am` another day. Never a countdown. A slipped time shows the promise and the move: `Now 7:00pm, was 6:10pm`.
// Every surface formats its times here and nowhere else.

/** A time as the server or a record carries it: an ISO string, epoch milliseconds or a Date. */
export type At = string | number | Date;

function formatters(timeZone: string | undefined) {
  const zone = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-AU", { ...options, ...(timeZone ? { timeZone } : {}) });
  return {
    CLOCK: zone({ hour: "numeric", minute: "2-digit", hour12: true }),
    DAY: zone({ year: "numeric", month: "2-digit", day: "2-digit" }),
    WEEKDAY: zone({ weekday: "short" }),
    DATE: zone({ day: "numeric", month: "short" }),
    OFFSET: zone({ timeZoneName: "longOffset" }),
    YEAR: zone({ year: "numeric" }),
    MONTH: zone({ month: "long" }),
    MONTH_SHORT: zone({ month: "short" }),
    HOUR: zone({ hour: "numeric", hour12: true }),
    MINUTE: zone({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
  };
}

// The runtime's own zone until setTimeZone names one: the system zone on the server, the phone's in the app.
let F = formatters(undefined);

/** Sets the zone every time here is written in; empty is the runtime's own. Throws RangeError for a zone Intl does not know. */
export function setTimeZone(timeZone: string | undefined): void {
  F = formatters(timeZone?.trim() || undefined);
}

/** The widest time a Date holds; past it Intl throws rather than formats. */
const MAX_MS = 8.64e15;
/** An ISO date or date-time with no zone of its own, `2026-10-26` or `2026-10-26T18:10`: read as wall time in the zone. */
const WALL = /^((?:[+-]\d{6}|\d{4})-(\d{2})-(\d{2}))(T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/;

/** The zone's offset from UTC at a moment, in milliseconds. */
function zoneOffset(t: number): number {
  const name = F.OFFSET.formatToParts(t).find((part) => part.type === "timeZoneName")?.value ?? "";
  const m = /([+-])(\d{2}):(\d{2})(?::(\d{2}))?/.exec(name);
  return m ? (m[1] === "-" ? -1 : 1) * ((Number(m[2]) * 60 + Number(m[3])) * 60 + Number(m[4] ?? 0)) * 1000 : 0;
}

const inRange = (t: number) => Number.isFinite(t) && Math.abs(t) <= MAX_MS;

/** Epoch milliseconds, or NaN for a time that does not parse or that no Date can hold. */
function ms(at: At): number {
  let t: number;
  if (at instanceof Date) t = at.getTime();
  else if (typeof at === "number") t = at;
  else {
    const wall = WALL.exec(at);
    if (wall) {
      // A zoneless string is wall time in Rivet's zone, never UTC.
      const utc = Date.parse(`${wall[1]}${wall[4] ?? "T00:00"}Z`);
      // Date.parse rolls 30 Feb over to 2 Mar and 24:00 to the next day; a wall time that is no real time gives nothing.
      const d = new Date(utc);
      const real =
        d.getUTCMonth() + 1 === Number(wall[2]) &&
        d.getUTCDate() === Number(wall[3]) &&
        d.getUTCHours() === Number(wall[5] ?? 0) &&
        d.getUTCMinutes() === Number(wall[6] ?? 0);
      t = real && inRange(utc) ? utc - zoneOffset(utc) : Number.NaN;
      if (inRange(t)) t = utc - zoneOffset(t);
    } else t = Date.parse(at);
  }
  return inRange(t) ? t : Number.NaN;
}

/** `6:10pm`, whatever day it is; "" for a time that does not parse. */
export function clock(at: At): string {
  const t = ms(at);
  return Number.isFinite(t) ? F.CLOCK.format(t).replace(/\s/g, "").toLowerCase() : "";
}

/** The year, month and day of a time, from the formatter's parts, so no locale's punctuation is assumed. */
function dayParts(t: number): [number, number, number] {
  const part = (type: string) => Number(F.DAY.formatToParts(t).find((p) => p.type === type)?.value);
  return [part("year"), part("month"), part("day")];
}

/** The calendar day of a time, `2026-10-26`: the one calendar for "today" on every surface. */
export function localDay(at: At): string {
  const t = ms(at);
  if (!Number.isFinite(t)) return "";
  const [y, m, d] = dayParts(t);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Whether a time falls on the same day as now. */
export function isToday(at: At, now: At = Date.now()): boolean {
  const day = localDay(at);
  return day !== "" && day === localDay(now);
}

/** Whole days from now's day to the time's day: 0 today, 1 tomorrow, -1 yesterday. */
function daysApart(at: number, now: number): number {
  // setUTCFullYear, not Date.UTC, which reads years 0-99 as 1900-1999.
  const utc = (t: number) => {
    const [y, m, d] = dayParts(t);
    return new Date(0).setUTCFullYear(y, m - 1, d);
  };
  return Math.round((utc(at) - utc(now)) / 86_400_000);
}

/** `Tue 3 Nov 9:00am`: the weekday, the date and the clock. */
const dated = (t: number) => `${F.WEEKDAY.format(t)} ${F.DATE.format(t)} ${clock(t)}`;

/**
 * The one time style: `6:10pm` today, `Tue 9:00am` on another day within a week either side, and `Tue 3 Nov 9:00am`
 * further out, where a weekday alone would name the wrong week. "" for a time that does not parse.
 */
export function when(at: At, now: At = Date.now()): string {
  const t = ms(at);
  const n = ms(now);
  if (!Number.isFinite(t)) return "";
  const apart = Number.isFinite(n) ? daysApart(t, n) : Number.NaN;
  if (apart === 0) return clock(t);
  return Math.abs(apart) <= 6 ? `${F.WEEKDAY.format(t)} ${clock(t)}` : dated(t);
}

/**
 * A time that moved: `Now 7:00pm, was 6:10pm`. Two days a week apart can share a weekday (last Tue and next Tue); then
 * both carry their date, `Now Tue 27 Oct 9:00am, was Tue 20 Oct 9:00am`, so a move never reads as no move.
 */
export function moved(dueAt: At, wasAt: At, now: At = Date.now()): string {
  const due = when(dueAt, now);
  const was = when(wasAt, now);
  if (due === was && localDay(dueAt) !== localDay(wasAt)) return `Now ${dated(ms(dueAt))}, was ${dated(ms(wasAt))}`;
  return `Now ${due}, was ${was}`;
}

/** A time that moved a second time: `Now 8:30pm, moved twice`. */
export function movedTwice(dueAt: At, now: At = Date.now()): string {
  return `Now ${when(dueAt, now)}, moved twice`;
}

// Dates without a clock, and the short labels on a chart's time axis. The zone's calendar, like every time above.

/** `Tue`, the weekday; "" for a time that does not parse. */
export function weekday(at: At): string {
  const t = ms(at);
  return Number.isFinite(t) ? F.WEEKDAY.format(t) : "";
}

/** `Tue 9:00am`: the weekday always, for a stamp that names its day even today. */
export function dayClock(at: At): string {
  const t = ms(at);
  return Number.isFinite(t) ? `${F.WEEKDAY.format(t)} ${clock(t)}` : "";
}

const inYear = (t: number, now?: At) => (now !== undefined && Number.isFinite(ms(now)) && F.YEAR.format(t) !== F.YEAR.format(ms(now)) ? ` ${F.YEAR.format(t)}` : "");

/** `24 Oct`; with `now` given, `24 Oct 2025` when the year is not now's. "" for a time that does not parse. */
export function shortDate(at: At, now?: At): string {
  const t = ms(at);
  return Number.isFinite(t) ? `${F.DATE.format(t)}${inYear(t, now)}` : "";
}

/** A wall-clock setting such as quiet hours, kept as `22:00`, shown `10:00pm`; anything else is shown as given. */
export function wallClock(hhmm: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return hhmm;
  const hour = Number(m[1]);
  return `${hour % 12 || 12}:${m[2]}${hour < 12 ? "am" : "pm"}`;
}

/** A day's heading in a list: `Today`, `Yesterday`, else `Sat 24 Oct` (`Wed 31 Dec 2025` in another year). */
export function dayHeading(at: At, now: At = Date.now()): string {
  const t = ms(at);
  const n = ms(now);
  if (!Number.isFinite(t)) return "";
  const apart = Number.isFinite(n) ? daysApart(t, n) : Number.NaN;
  return apart === 0 ? "Today" : apart === -1 ? "Yesterday" : dayDate(t, now);
}

/** `Sat 24 Oct`; with `now` given, `Sat 24 Oct 2025` when the year is not now's. "" for a time that does not parse. */
export function dayDate(at: At, now?: At): string {
  const t = ms(at);
  return Number.isFinite(t) ? `${F.WEEKDAY.format(t)} ${shortDate(t, now)}` : "";
}

/** `October`, or `Oct` short: the month. "" for a time that does not parse. */
export function monthName(at: At, length: "long" | "short" = "long"): string {
  const t = ms(at);
  return Number.isFinite(t) ? (length === "long" ? F.MONTH : F.MONTH_SHORT).format(t) : "";
}

/** `6pm`: an hour on a chart's time axis. "" for a time that does not parse. */
export function hourLabel(at: At): string {
  const t = ms(at);
  return Number.isFinite(t) ? F.HOUR.format(t).replace(/\s/g, "").toLowerCase() : "";
}

/** The minute of the day in the zone, 0 to 1439; NaN for a time that does not parse. */
export function minuteOfDay(at: At): number {
  const t = ms(at);
  if (!Number.isFinite(t)) return Number.NaN;
  const part = (type: string) => Number(F.MINUTE.formatToParts(t).find((p) => p.type === type)?.value);
  return part("hour") * 60 + part("minute");
}

/** when() for a stamp that may be missing: null when there is none or it does not parse. */
export function maybeWhen(at: At | null | undefined, now: At = Date.now()): string | null {
  return at === null || at === undefined || at === "" ? null : when(at, now) || null;
}
