// Plain words for the Schedules tab: what each job is called and does, when it runs on
// the owner's clock, and which group it sits in. The jobs themselves are read live
// (index.mjs); this file only names them. A job missing here still shows, under its
// own name, with "No description yet."

import { clip } from "../ops/common.mjs";

/** @typedef {"daily" | "weekly" | "all-day" | "always-on"} Group */

/** @type {Map<string, string>} */
const zones = new Map();

/** The zone Intl gives `name`, or the system's when it has none or Intl does not know it. @param {string | undefined} name */
function resolveZone(name) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: name || undefined }).resolvedOptions().timeZone;
  } catch {
    return new Intl.DateTimeFormat("en-US").resolvedOptions().timeZone;
  }
}

/** The owner's time zone, read each call: RIVET_TIME_ZONE, else the system's. @param {NodeJS.ProcessEnv} [env] */
export function localZone(env = process.env) {
  const key = `${env.RIVET_TIME_ZONE ?? ""}|${process.env.TZ ?? ""}`;
  let zone = zones.get(key);
  if (zone === undefined) zones.set(key, (zone = resolveZone(env.RIVET_TIME_ZONE)));
  return zone;
}

/**
 * Names and plain descriptions, keyed by the job's id on its own system: a launchd label or a workflow file.
 * @type {Readonly<Record<string, { name: string, what: string }>>}
 */
export const WORDS = Object.freeze({
  "dev.rivet-agents.bridge": { name: "Mac bridge", what: "Links this app to the Mac: your answers, chat and these switches all go through it." },
  "dev.rivet-agents.server": { name: "Rivet server", what: "Runs this app on the Mac." },
});

export const NO_WORDS = "No description yet.";
export const NO_NAME = "Unnamed job";
/** The server's limits on a schedule's name and what (scheduleSchema, src/shared/schedules.ts): one over drops the whole snapshot. */
export const NAME_MAX = 80;
export const WHAT_MAX = 200;

/** @param {string} key @param {string} fallbackName */
export function wordsFor(key, fallbackName) {
  const words = WORDS[key] ?? { name: fallbackName, what: NO_WORDS };
  return { name: clip(words.name, NAME_MAX) || NO_NAME, what: clip(words.what, WHAT_MAX) || NO_WORDS };
}

/** "7am", "11:30pm", "12:05am", "midnight". @param {number} hour 0-23 @param {number} minute */
export function clock(hour, minute) {
  if (hour === 0 && minute === 0) return "midnight";
  const suffix = hour < 12 ? "am" : "pm";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? `${h12}${suffix}` : `${h12}:${String(minute).padStart(2, "0")}${suffix}`;
}

/** "7am, 1pm and 7pm". @param {string[]} parts */
export function list(parts) {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Every 5 min", "Every hour", "Every 2 hours", "Every minute". @param {number} seconds */
export function every(seconds) {
  if (seconds < 60) return `Every ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes === 1) return "Every minute";
  if (minutes < 60 || minutes % 60 !== 0) return `Every ${minutes} min`;
  const hours = minutes / 60;
  if (hours === 1) return "Every hour";
  if (hours % 24 === 0) return hours === 24 ? "Every day" : `Every ${hours / 24} days`;
  return `Every ${hours} hours`;
}

/**
 * One cron field as the values it allows, or null for `*`. Supports `*`, `*\/n`, `a`, `a-b`, `a-b/n` and lists.
 * @param {string} field @param {number} min @param {number} max
 * @returns {number[] | null | undefined} undefined when the field is not understood
 */
export function cronField(field, min, max) {
  if (field === "*") return null;
  /** @type {Set<number>} */
  const out = new Set();
  for (const part of field.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return undefined;
    const lo = m[1] === "*" ? min : Number(m[2]);
    const hi = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : lo;
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) return undefined;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * A five-field cron line, parsed. Day-of-week 7 counts as Sunday.
 * @param {string} expr
 */
export function parseCron(expr) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = cronField(fields[0], 0, 59);
  const hour = cronField(fields[1], 0, 23);
  const dom = cronField(fields[2], 1, 31);
  const month = cronField(fields[3], 1, 12);
  const dowRaw = cronField(fields[4], 0, 7);
  if (minute === undefined || hour === undefined || dom === undefined || month === undefined || dowRaw === undefined) return null;
  const dow = dowRaw === null ? null : [...new Set(dowRaw.map((d) => d % 7))].sort((a, b) => a - b);
  return { minute, hour, dom, month, dow, raw: fields };
}

/** @param {number[] | null} allowed @param {number} value */
const allows = (allowed, value) => allowed === null || allowed.includes(value);

/** The parts of an instant on a timezone's wall clock. @param {number} t @param {string} timeZone */
export function wallClock(t, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  }).formatToParts(new Date(t));
  /** @param {string} type */
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")) % 24, minute: Number(get("minute")), weekday };
}

/**
 * The next time a cron line fires after `from`, on the wall clock of `timeZone`, or
 * null if not within 8 days (or the line is not understood).
 * @param {string} expr @param {number} from @param {string} timeZone
 */
export function nextCron(expr, from, timeZone) {
  const cron = parseCron(expr);
  if (!cron) return null;
  let t = Math.floor(from / 60_000) * 60_000 + 60_000;
  const end = from + 8 * 24 * 3600_000;
  for (; t <= end; t += 60_000) {
    const w = timeZone === "UTC" ? utcClock(t) : wallClock(t, timeZone);
    if (!allows(cron.minute, w.minute) || !allows(cron.hour, w.hour) || !allows(cron.month, w.month)) continue;
    // Cron's rule: when both day fields are set, either may match.
    const dayOk =
      cron.dom !== null && cron.dow !== null ? cron.dom.includes(w.day) || cron.dow.includes(w.weekday) : allows(cron.dom, w.day) && allows(cron.dow, w.weekday);
    if (dayOk) return t;
  }
  return null;
}

/** @param {number} t */
function utcClock(t) {
  const d = new Date(t);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay() };
}

/**
 * Plain words and a group for a cron line. A line in another timezone (GitHub's UTC)
 * gives its fixed times as they fall on the owner's clock on the next few runs, so
 * daylight saving shows as soon as it starts.
 * @param {string} expr @param {string} timeZone @param {number} now
 * @returns {{ when: string, group: Group } | null}
 */
export function cronWords(expr, timeZone, now) {
  const cron = parseCron(expr);
  if (!cron) return null;
  const [minuteField, hourField] = cron.raw;
  const dailyAll = cron.dom === null && cron.month === null && cron.dow === null;
  // Intervals: "*/5 * * * *", "0 * * * *", "0 */2 * * *".
  if (dailyAll && hourField === "*") {
    if (minuteField === "*") return { when: "Every minute", group: "all-day" };
    const step = /^\*\/(\d+)$/.exec(minuteField);
    if (step) return { when: every(Number(step[1]) * 60), group: "all-day" };
    if (cron.minute?.length === 1) return { when: "Every hour", group: "all-day" };
  }
  const hourStep = /^\*\/(\d+)$/.exec(hourField);
  if (dailyAll && hourStep && cron.minute?.length === 1) return { when: every(Number(hourStep[1]) * 3600), group: "all-day" };
  if (cron.minute === null || cron.hour === null || cron.minute.length * cron.hour.length > 6) return { when: `Cron ${expr} (${timeZone})`, group: "all-day" };
  // Fixed times: read each from the next runs on the owner's clock.
  const local = localZone();
  const times = [];
  let t = now;
  // A week of runs, so a day-of-week range ("1-5") shows every day it covers, in the owner's days.
  for (let i = 0; i < cron.minute.length * cron.hour.length * 7; i++) {
    const next = nextCron(expr, t, timeZone);
    if (next === null) break;
    const w = wallClock(next, local);
    const own = wallClock(next, timeZone);
    times.push({ key: w.hour * 60 + w.minute, label: clock(w.hour, w.minute), weekday: w.weekday, own: own.hour * 60 + own.minute });
    t = next;
  }
  if (!times.length) return { when: `Cron ${expr} (${timeZone})`, group: "all-day" };
  // Clock times from one local day, never the whole week: a week can cross a daylight-saving change,
  // which would show one daily run as two times. A local cron's times are its own fields (a skipped
  // 2am is still its time); any other zone's are its own times moved by the gap between the zones at
  // the next run, one gap for all so two times never land on one. The whole week still names the days.
  /** @type {{ key: number, label: string }[]} */
  let unique;
  if (timeZone === local) {
    unique = cron.hour.flatMap((hour) => cron.minute.map((minute) => ({ key: hour * 60 + minute, label: clock(hour, minute) })));
  } else {
    const gap = times[0].key - times[0].own;
    unique = cron.hour.flatMap((hour) =>
      cron.minute.map((minute) => {
        const key = (((hour * 60 + minute + gap) % 1440) + 1440) % 1440;
        return { key, label: clock(Math.floor(key / 60), key % 60) };
      }),
    );
  }
  unique.sort((a, b) => a.key - b.key);
  const at = list(unique.map((x) => x.label));
  if (dailyAll) return { when: `Every day at ${at}`, group: "daily" };
  if (cron.dom === null && cron.month === null && cron.dow !== null) {
    const days = [...new Set(times.map((x) => x.weekday))].sort((a, b) => a - b);
    return { when: `${dayWords(days)} at ${at}`, group: days.length === 7 ? "daily" : "weekly" };
  }
  return { when: `Cron ${expr} (${timeZone})`, group: "weekly" };
}

/** "Weekdays", "Mondays and Thursdays", "Every day". @param {number[]} days 0 = Sunday, sorted */
function dayWords(days) {
  if (days.length === 7) return "Every day";
  if (days.join() === "1,2,3,4,5") return "Weekdays";
  if (days.join() === "0,6") return "Weekends";
  return list(days.map((d) => `${DAY_NAMES[d]}s`));
}

/**
 * Plain words for a launchd job, from its plist. The Mac's own clock runs on `macZone`.
 * @param {{ StartCalendarInterval?: unknown, StartInterval?: unknown, KeepAlive?: unknown, RunAtLoad?: unknown }} plist
 * @param {string} macZone
 * @returns {{ when: string, group: Group, interval?: number, calendar?: { hour: number, minute: number, weekday?: number }[] }}
 */
export function launchdWords(plist, macZone) {
  if (plist.KeepAlive === true || (typeof plist.KeepAlive === "object" && plist.KeepAlive !== null)) return { when: "Always on", group: "always-on" };
  const raw = plist.StartCalendarInterval;
  const entries = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((x) => typeof x === "object" && x !== null);
  const rows = entries.map((x) => /** @type {Record<string, unknown>} */ (x));
  // launchd treats a missing key as "every": no Minute means every minute of that hour, and Day or Month
  // narrow it to days of the month. Those are told plainly, with no next run worked out.
  if (rows.some((x) => x.Minute === undefined || x.Day !== undefined || x.Month !== undefined || !Number.isInteger(x.Hour))) {
    // Day with Weekday runs on either (launchd ORs them), so only a plain Day is told as monthly.
    const day = rows.find((x) => Number.isInteger(x.Day) && Number.isInteger(x.Hour) && Number.isInteger(x.Minute) && x.Month === undefined && x.Weekday === undefined);
    if (day && rows.length === 1) return { when: `Monthly, on day ${day.Day} at ${clock(Number(day.Hour), Number(day.Minute))}`, group: "weekly" };
    return { when: "On a custom launchd calendar", group: "all-day" };
  }
  const calendar = rows.map((x) => ({ hour: Number(x.Hour), minute: Number(x.Minute), ...(Number.isInteger(x.Weekday) ? { weekday: Number(x.Weekday) % 7 } : {}) }));
  if (calendar.length) {
    const zone = macZone === localZone() ? "" : ` (Mac time, ${macZone})`;
    // Each clock time with the days it runs (no Weekday is every day).
    /** @type {Map<number, Set<number>>} */
    const byTime = new Map();
    for (const c of calendar) {
      const key = c.hour * 60 + c.minute;
      const days = byTime.get(key) ?? new Set();
      for (const d of c.weekday === undefined ? [0, 1, 2, 3, 4, 5, 6] : [c.weekday]) days.add(d);
      byTime.set(key, days);
    }
    const slots = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([key, days]) => ({ time: clock(Math.floor(key / 60), key % 60), days: dayWords([...days].sort((a, b) => a - b)) }));
    const group = slots.some((slot) => slot.days === "Every day") ? "daily" : "weekly";
    // Times sharing the same days read as one line; otherwise each time says its own days.
    const when = slots.every((slot) => slot.days === slots[0].days)
      ? `${slots[0].days} at ${list(slots.map((slot) => slot.time))}`
      : slots.map((slot) => `${slot.days} at ${slot.time}`).join("; ");
    return { when: `${when}${zone}`, group, calendar };
  }
  if (typeof plist.StartInterval === "number" && plist.StartInterval > 0) return { when: every(plist.StartInterval), group: "all-day", interval: plist.StartInterval };
  if (plist.RunAtLoad === true) return { when: "When the Mac starts", group: "always-on" };
  return { when: "Only when started by hand", group: "always-on" };
}

/**
 * The next local time a launchd calendar fires after `now` (the bridge runs on the Mac, so local time is the Mac's).
 * @param {{ hour: number, minute: number, weekday?: number }[]} calendar @param {number} now
 */
export function nextCalendar(calendar, now) {
  let best = null;
  for (const c of calendar) {
    for (let add = 0; add <= 7; add++) {
      const d = new Date(now);
      d.setDate(d.getDate() + add);
      d.setHours(c.hour, c.minute, 0, 0);
      if (d.getTime() <= now || (c.weekday !== undefined && d.getDay() !== c.weekday)) continue;
      if (best === null || d.getTime() < best) best = d.getTime();
      break;
    }
  }
  return best;
}
