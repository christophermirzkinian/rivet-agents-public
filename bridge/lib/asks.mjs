// The owner's asks for the `rivet ask` CLI: the list the records generate, and due times read on the owner's
// clock (RIVET_TIME_ZONE, else the Mac's own zone).

import { sanitizeLine } from "./templates.mjs";
import { dated, when } from "./when.mjs";

/** src/shared/asks.ts ASK_STAGES: where an ask is, in order; shipped, parked and done are finished. */
export const ASK_STAGES = Object.freeze(["queued", "building", "push-queue", "review", "needs-you", "merging", "deploying", "shipped", "parked", "done"]);
export const FINISHED_STAGES = Object.freeze(["shipped", "parked", "done"]);
export const ASK_WHO = Object.freeze(["owner", "rivet"]);
export const ASK_ID_RE = /^[a-z0-9-]{1,40}$/;
export const MAX_ASK_WORDS = 4000;
export const MAX_ASK_NOTE = 2000;
export const MAX_ASK_CHAT = 300;
export const MAX_ASK_WHY = 200;
const MAX_ASK_PRS = 50;
/** src/shared/asks.ts MAX_DUE_AHEAD_MS. */
const MAX_DUE_AHEAD_MS = 7 * 86_400_000;

export const ASKS_HEADER = `# Asks

Every ask goes here in its words, with its owning chat and stage.
Stages: queued → building → push-queue → review → needs-you → merging → deploying → shipped (verified) · done · or parked #N.

| # | Date (UTC) | Ask (in its words) | Owner chat / PR | Stage |
|---|---|---|---|---|
`;

/** A stage name; undefined for anything else. @param {string} word */
export function askStage(word) {
  return ASK_STAGES.includes(word) ? word : undefined;
}

/** An ask's stage, read from `status` for a row in the shape before the stage. @param {{ stage?: string, status?: string }} ask */
export function stageOfAsk(ask) {
  return ask.stage ?? (ask.status ? askStage(ask.status) ?? ask.status : "queued");
}

/**
 * @typedef {{ at: string, stage?: string, note?: string, by?: string }} AskEvent
 * @typedef {{ at: string, dueAt: string, was: string, why?: string }} DueMove
 * @typedef {{ id: string, words: string, who: string, source?: string, replyId?: string, cardId?: string, stage: string,
 *   status?: string, chat?: string, prs: number[], repo?: string, issue?: number, progress?: number, dueAt?: string,
 *   dueHistory?: DueMove[], why?: string, askedForTimeAt?: string, timeline: AskEvent[], createdAt: string, stageAt: string,
 *   updatedAt: string, version: number }} Ask
 */

/** One table cell: printable text only, lines folded to " / ", pipes escaped. @param {string} text */
function cell(text) {
  return sanitizeLine(text, Infinity).replace(/\|/g, "\\|");
}

/**
 * The list as markdown, oldest ask first; each row's stage is the ask's stage, its due time and its last event's note.
 * @param {Ask[]} asks newest first, as GET /api/asks serves them
 */
export function renderAsks(asks) {
  const rows = [...asks].reverse().sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return (
    ASKS_HEADER +
    rows
      .map((ask) => {
        const words = ask.words;
        const named = ask.chat ?? "";
        const prs = ask.prs.filter((pr) => !new RegExp(`#${pr}\\b`).test(named)).map((pr) => `#${pr}`);
        const owner = [named, prs.join(" ")].filter(Boolean).join(" / ") || "—";
        const note = ask.timeline.at(-1)?.note;
        const stage = stageOfAsk(ask);
        const due = ask.dueAt ? `, due ${dueShort(ask.dueAt)}` : "";
        const shown = `${stage === "parked" && ask.issue ? `parked #${ask.issue}` : stage}${due}`;
        return `| ${cell(ask.id)} | ${ask.createdAt.slice(0, 10)} | ${cell(words)} | ${cell(owner)} | ${cell(note ? `${shown} — ${note}` : shown)} |\n`;
      })
      .join("")
  );
}

/** The owner's time zone: RIVET_TIME_ZONE, else the Mac's own. */
const TIME_ZONE = process.env.RIVET_TIME_ZONE || undefined;
const clockParts = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** The owner's calendar day and minute of the day at `at`. @param {Date | number} at */
function ownerClock(at) {
  const p = Object.fromEntries(clockParts.formatToParts(at).map((part) => [part.type, part.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

/** @param {string} day @param {number} days */
function addDays(day, days) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The instant an owner's wall-clock time happens; in the spring-forward hour, an instant that does not read it. @param {string} day @param {number} minute */
function ownerInstant(day, minute) {
  const [y, m, d] = day.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, Math.floor(minute / 60), minute % 60);
  let guess = wall;
  for (let i = 0; i < 3; i += 1) {
    const seen = ownerClock(guess);
    const [sy, sm, sd] = seen.day.split("-").map(Number);
    const seenWall = Date.UTC(sy, sm - 1, sd, Math.floor(seen.minute / 60), seen.minute % 60);
    if (seenWall === wall) break;
    guess += wall - seenWall;
  }
  return guess;
}

/** The next time the owner's clock reads `minute`: today's, else tomorrow's; NaN when that time does not exist. @param {number} minute @param {Date} now */
function nextClock(minute, now) {
  const reads = (/** @type {string} */ day, /** @type {number} */ at) => ownerClock(at).day === day && ownerClock(at).minute === minute;
  const today = ownerClock(now).day;
  const first = ownerInstant(today, minute);
  if (reads(today, first)) {
    if (first > now.getTime()) return first;
  } else if (minute > ownerClock(now).minute) return NaN;
  const day = addDays(today, 1);
  const next = ownerInstant(day, minute);
  return reads(day, next) ? next : NaN;
}

const DUE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The instant `text` names, read at `now`, as an eta reads: whole minutes ("90", "2h"), a
 * clock time on the owner's zone ("3pm", "3:30pm", "15:30", "tonight" for 11pm; one already past today is tomorrow's) or an ISO time
 * with its offset. A time not ahead of `now`, or over a week out (the server's limit for an ask), is refused.
 * @param {string} text @param {Date} now
 * @returns {{ dueAt: string } | { error: string }}
 */
export function parseDueTime(text, now) {
  const plain = text.trim().toLowerCase().replace(/^(?:by|today)\s+/, "");
  let at = null;
  const minutes = /^(\d{1,5})\s*(?:m|min|mins|minutes)?$/.exec(plain);
  const hours = /^(\d{1,3}(?:\.\d{1,2})?)\s*(?:h|hr|hrs|hour|hours)$/.exec(plain);
  const twelve = /^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)$/.exec(plain);
  const day = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(plain);
  if (minutes) at = now.getTime() + Number(minutes[1]) * 60_000;
  else if (hours) at = now.getTime() + Math.round(Number(hours[1]) * 60) * 60_000;
  else if (twelve && Number(twelve[1]) >= 1 && Number(twelve[1]) <= 12) at = nextClock(((Number(twelve[1]) % 12) + (twelve[3] === "pm" ? 12 : 0)) * 60 + Number(twelve[2] ?? 0), now);
  else if (day) at = nextClock(Number(day[1]) * 60 + Number(day[2]), now);
  else if (plain === "tonight") at = nextClock(23 * 60, now);
  else if (DUE_ISO.test(text.trim()) && Number.isFinite(Date.parse(text.trim()))) at = Date.parse(text.trim());
  if (at === null) return { error: '--due is minutes ("90"), a clock time ("3pm", "3:30pm", "15:30", "tonight") or an ISO time' };
  if (Number.isNaN(at)) return { error: "--due names a time that does not exist on this clock: the clocks go forward an hour that night" };
  if (at <= now.getTime()) return { error: "--due must be ahead of now" };
  if (at - now.getTime() > MAX_DUE_AHEAD_MS) return { error: "--due is at most 7 days out" };
  return { dueAt: new Date(at).toISOString() };
}

/**
 * A due time as when.mjs says it at `now`: "6:10pm" today, "Tue 9:00am" on another day; with no `now` (the list, read
 * any day), "Tue 27 Oct 9:00am". @param {string} dueAt @param {Date} [now]
 */
export function dueShort(dueAt, now) {
  return now ? when(dueAt, now) : dated(dueAt);
}
