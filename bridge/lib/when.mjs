// src/shared/when.ts's one time style, for the bridge and the CLI, which run where src/shared is not installed
// (scripts/install-bridge.sh copies bridge/lib only): a clock time on the owner's zone (RIVET_TIME_ZONE, else the
// Mac's own), 12-hour, `6:10pm` today, `Tue 9:00am` on
// another day within a week either side, `Tue 3 Nov 9:00am` further out. test/when-bridge.test.ts holds the two equal.
// Times here carry their zone (ISO with Z or an offset, or epoch ms); a zoneless wall time is when.ts's alone.

const TIME_ZONE = process.env.RIVET_TIME_ZONE || undefined;
const CLOCK = new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: TIME_ZONE });
const DAY = new Intl.DateTimeFormat("en-AU", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TIME_ZONE });
const WEEKDAY = new Intl.DateTimeFormat("en-AU", { weekday: "short", timeZone: TIME_ZONE });
const DATE = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", timeZone: TIME_ZONE });
const MAX_MS = 8.64e15;

/** @typedef {string | number | Date} At */

/** Epoch ms, or NaN. @param {At} at */
function ms(at) {
  const t = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  return Number.isFinite(t) && Math.abs(t) <= MAX_MS ? t : Number.NaN;
}

/** `6:10pm`, on the owner's clock; "" for a time that does not parse. @param {At} at */
export function clock(at) {
  const t = ms(at);
  return Number.isFinite(t) ? CLOCK.format(t).replace(/\s/g, "").toLowerCase() : "";
}

/** The owner's calendar day as a UTC midnight, for counting days apart. @param {number} t */
function dayUtc(t) {
  const part = (/** @type {string} */ type) => Number(DAY.formatToParts(t).find((p) => p.type === type)?.value);
  return new Date(0).setUTCFullYear(part("year"), part("month") - 1, part("day"));
}

/** `Tue 3 Nov 9:00am`: for a stamp read any day, such as an ask's. "" for a time that does not parse. @param {At} at */
export function dated(at) {
  const t = ms(at);
  return Number.isFinite(t) ? `${WEEKDAY.format(t)} ${DATE.format(t)} ${clock(t)}` : "";
}

/** when.ts when(): `6:10pm` today, `Tue 9:00am` within 6 days either side, else dated(). @param {At} at @param {At} [now] */
export function when(at, now = Date.now()) {
  const t = ms(at);
  const n = ms(now);
  if (!Number.isFinite(t)) return "";
  const apart = Number.isFinite(n) ? Math.round((dayUtc(t) - dayUtc(n)) / 86_400_000) : Number.NaN;
  if (apart === 0) return clock(t);
  return Math.abs(apart) <= 6 ? `${WEEKDAY.format(t)} ${clock(t)}` : dated(t);
}
