import { addDays, zoneClock } from "./ops.js";

// Promise keeper (Settings › Behaviours): the time a chat promises the monitor in its own words — "card by 8:30",
// "ETA 08:10", "by 9", "tomorrow 7am" — read as local time. Only a time with a promise word counts (by, ETA, due,
// until, till, before, today, tonight, tomorrow), so a report's own stamps ("merged at 08:10", "date 09:21") are never
// read as one. A time already past, or over a week out, is no promise.

/** A week: as the asks' own limit (MAX_DUE_AHEAD_MS), a time further out is a guess, not a promise. */
const MAX_AHEAD_MS = 7 * 86_400_000;
const CUES = new Set(["by", "eta", "due", "until", "till", "before"]);
const WEEKDAYS: Record<string, number> = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
/** The day words that are promise words of their own. */
const DAY_CUES = new Set(["today", "tonight", "tomorrow", "tmrw"]);
/** Between a promise word and its time: "ETA: 08:10", "by Mon at 9", "by around 9". */
const FILLERS = new Set(["at", ":", "~", "about", "around", "the", "latest", "approx"]);
/** A bare hour followed by one of these is a count, not a time ("by 15 min", "by 9 PRs"). */
const UNITS = new Set(["m", "min", "mins", "minute", "minutes", "h", "hr", "hrs", "hour", "hours", "s", "sec", "secs", "second", "seconds", "d", "day", "days", "%", "x", "k", "px", "pr", "prs", "of", "items", "files", "tests", "chats", "more"]);
/**
 * What may follow a bare hour ("by 9"): the line's end, a stop, a day word or one of these. Anything else reads as a
 * count, a range or a date ("by 2 failing checks", "2-3 hours", "1/12"), so a bare hour before it is no promise.
 */
const AFTER_BARE = new Set([",", ".", ";", ":", "!", "?", ")", "o", "sharp", "latest", "with"]);
/** Between a promise word and a bare hour: "by around 9". */
const NEAR = new Set(["~", "about", "around", "approx"]);
/**
 * A time said of the past is no promise ("red until 5pm yesterday", "fixed 2 hours ago", "was due 9:42"): read as a
 * promise, a passed step time rolls on to tomorrow's or next week's and moves an ask's due later.
 */
const PAST = new Set(["yesterday", "ago", "earlier", "last", "was", "were"]);
/** Where a clause ends: a past word before it speaks of another clause ("red yesterday; card by 8:30"). */
const STOPS = new Set([",", ".", ";", "!", "?"]);
/**
 * A time whose reading today went by this recently is a report of it ("this was due by 8:30", "deployed today at
 * 9:30", "red until 17:00"), not a promise of the same clock twelve hours or a day on. Longer ago, "by 9" at noon is
 * tonight's 9.
 */
const JUST_GONE_MS = 2 * 3_600_000;
/** A time marked as another zone's ("21:30Z", "22:00 UTC") is not a local time; it is left unread. */
const OTHER_ZONE = new Set(["z", "utc", "gmt"]);
// "8:30" and the dot form "8.30"; "2.5" (one digit after the dot) is a number, never a time.
const TOKENS = /[a-z]+|\d+(?:[:.]\d+)?(?:am|pm)?|\S/g;
const TIME = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm)?$/;

export interface Promised {
  /** The instant, ISO in UTC. */
  dueAt: string;
  /** The line of the text that holds it, trimmed. */
  line: string;
  /** True when the text names its day ("tomorrow 9", "Wed 3am"); false for a bare clock time. */
  dayNamed: boolean;
  /**
   * True when the words read as a time gone by at least as well: a clock time with no day whose latest passed reading
   * is nearer than `dueAt` ("due 9:42" at 23:50 is 21:42's, two hours ago, before tomorrow's 09:42), or yesterday's
   * weekday ("due Sun 23:30" said on Monday). A step's report, not a slip, so it moves no due.
   */
  mayBePast: boolean;
}

type Day = { kind: "today" | "tonight" | "tomorrow" } | { kind: "weekday"; weekday: number };

function dayOf(token: string | undefined): Day | null {
  if (token === undefined) return null;
  if (token === "today" || token === "tonight" || token === "tomorrow") return { kind: token };
  if (token === "tmrw") return { kind: "tomorrow" };
  return token in WEEKDAYS ? { kind: "weekday", weekday: WEEKDAYS[token]! } : null;
}

/** The instant the local clock reads `minute` on `day`, or null in the hour the clocks skip. */
function at(day: string, minute: number): number | null {
  // As if the clock were UTC, then moved by the gap the clock shows, until it reads the time asked for.
  const asUtc = (clock: { day: string; minute: number }) => Date.parse(`${clock.day}T00:00:00.000Z`) + clock.minute * 60_000;
  const want = asUtc({ day, minute });
  let instant = want;
  for (let step = 0; step < 3; step += 1) instant += want - asUtc(zoneClock(instant));
  const seen = zoneClock(instant);
  return seen.day === day && seen.minute === minute ? instant : null;
}

/** The local calendar days this time may fall on, nearest first, from its day word. */
function daysFor(day: Day | null, now: Date): string[] {
  const today = zoneClock(now).day;
  if (day === null) return [today, addDays(today, 1)];
  if (day.kind === "today" || day.kind === "tonight") return [today];
  if (day.kind !== "weekday") return [addDays(today, 1)];
  const todayIndex = new Date(`${today}T00:00:00.000Z`).getUTCDay();
  const ahead = (day.weekday - todayIndex + 7) % 7;
  // Today's weekday is today alone: "due Mon 21:42" said late on Monday is the time gone by, not next Monday's.
  return [addDays(today, ahead)];
}

/**
 * The minutes past midnight a written time may mean, likeliest first. `8:30pm` and `20:30` and `08:30` mean one;
 * a bare `8:30` or `9` is either half of the day: tonight's is the evening, on a later day a working hour (7 to 11 in
 * the morning, 12 to 6 in the afternoon), and otherwise whichever comes next.
 */
function minutesFor(hour: number, minute: number, half: "am" | "pm" | null, padded: boolean, day: Day | null): number[] | null {
  if (minute > 59) return null;
  if (half) return hour >= 1 && hour <= 12 ? [((hour % 12) + (half === "pm" ? 12 : 0)) * 60 + minute] : null;
  if (hour > 23) return null;
  // "12 tonight" is midnight, which is tomorrow's day: left unread rather than read as noon.
  if (day?.kind === "tonight" && hour === 12) return null;
  if (padded || hour === 0 || hour >= 12) return [hour * 60 + minute];
  const morning = hour * 60 + minute;
  const evening = (hour + 12) * 60 + minute;
  if (day?.kind === "tonight") return [evening];
  if (day && day.kind !== "today") return [hour >= 7 ? morning : evening];
  return [morning, evening];
}

/** True when a past word stands within four tokens before `i`, in the same clause. */
function pastBefore(tokens: readonly string[], i: number): boolean {
  for (let j = i - 1; j >= 0 && j >= i - 4; j -= 1) {
    if (STOPS.has(tokens[j]!)) return false;
    if (PAST.has(tokens[j]!)) return true;
  }
  return false;
}

/** Every promised time in `text`, read at `now`, in the order written. */
export function promisedTimes(text: string, now: Date): Promised[] {
  const found: Promised[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const tokens = line.toLowerCase().match(TOKENS) ?? [];
    for (let i = 0; i < tokens.length; i += 1) {
      const match = TIME.exec(tokens[i]!);
      if (!match) continue;
      let half = (match[3] as "am" | "pm" | undefined) ?? null;
      let next = i + 1;
      if (!half && (tokens[next] === "am" || tokens[next] === "pm")) half = tokens[next++] as "am" | "pm";
      if (OTHER_ZONE.has(tokens[next] ?? "") || PAST.has(tokens[next] ?? "") || pastBefore(tokens, i)) continue;
      const written = match[2] !== undefined || half !== null;
      // What may follow a bare hour: the line's end, a stop, a day word, the short list, or "at the latest".
      const endsTime = tokens[next] === undefined || AFTER_BARE.has(tokens[next]!) || dayOf(tokens[next]) !== null || (tokens[next] === "at" && tokens[next + 1] === "the" && tokens[next + 2] === "latest");
      // The dot form without am/pm is held to a bare hour's rule and a five-minute mark, so a version, a date or a
      // measure ("until 1.25 ships", "due 1.12", "by 1.45ms") is no time.
      if (tokens[i]!.includes(".") && half === null && (!endsTime || Number(match[2]) % 5 !== 0)) continue;
      // Back from the time: day words and fillers, then a promise word or none.
      let day: Day | null = null;
      let cue = false;
      for (let j = i - 1; j >= 0 && j >= i - 4; j -= 1) {
        const token = tokens[j]!;
        const named = dayOf(token);
        if (named) {
          day ??= named;
          if (DAY_CUES.has(token)) cue = true;
          continue;
        }
        // A promise word keeps looking back for its day: "tomorrow by 7".
        if (CUES.has(token)) {
          cue = true;
          continue;
        }
        if (!FILLERS.has(token)) break;
      }
      // A bare hour must follow its promise word closely ("by 9", "by Mon 9"), and is no count of something.
      let before = i - 1;
      while (before >= 0 && NEAR.has(tokens[before]!)) before -= 1;
      if (!written && !(CUES.has(tokens[before] ?? "") || dayOf(tokens[before]) !== null || tokens[before] === "at")) continue;
      if (UNITS.has(tokens[next] ?? "") && half === null) continue;
      if (!written && !endsTime) continue;
      // Forward: "7am tomorrow", "12:00 Mon".
      const after = dayOf(tokens[next]);
      if (after) {
        day ??= after;
        if (DAY_CUES.has(tokens[next]!)) cue = true;
      }
      if (!cue) continue;
      const minutes = minutesFor(Number(match[1]), Number(match[2] ?? 0), half, /^0\d/.test(match[1]!), day);
      if (!minutes) continue;
      if (day === null || day.kind === "today" || day.kind === "tonight") {
        // Yesterday's too when no day is named: "red until 23:30" said at 00:15 went by 45 minutes ago. A named
        // today or tonight is today's own ("merged by 23:30 tonight" at 00:15 is tonight's).
        const today = zoneClock(now).day;
        const gone = (day === null ? [addDays(today, -1), today] : [today]).some((one) =>
          minutes.some((minute) => {
            const ms = at(one, minute);
            return ms !== null && ms <= now.getTime() && now.getTime() - ms <= JUST_GONE_MS;
          }),
        );
        if (gone) continue;
      }
      const times = daysFor(day, now)
        .flatMap((one) => minutes.map((minute) => at(one, minute)))
        .filter((ms): ms is number => ms !== null && ms > now.getTime() && ms - now.getTime() <= MAX_AHEAD_MS)
        .sort((a, b) => a - b);
      if (!times.length) continue;
      const today = zoneClock(now).day;
      const passed =
        day === null
          ? [addDays(today, -1), today]
              .flatMap((one) => minutes.map((minute) => at(one, minute)))
              .filter((ms): ms is number => ms !== null && ms <= now.getTime())
              .map((ms) => now.getTime() - ms)
          : [];
      const yesterday = day?.kind === "weekday" && (day.weekday - new Date(`${today}T00:00:00.000Z`).getUTCDay() + 7) % 7 === 6;
      const mayBePast = yesterday || passed.some((gone) => gone <= times[0]! - now.getTime());
      found.push({ dueAt: new Date(times[0]!).toISOString(), line, dayNamed: day !== null, mayBePast });
    }
  }
  return found;
}

/**
 * The time `text` promises, read at `now`: the last one written, as a message names a step's time before the ask's
 * own ("PR by 10:00, merged by 11:30"), and an old time before the new one ("was due 8:30, new ETA 9:30", "waiting
 * until 9 for review; card by 11"). Null when it promises none.
 */
export function promisedTime(text: string, now: Date): Promised | null {
  const all = promisedTimes(text, now);
  return all.at(-1) ?? null;
}
