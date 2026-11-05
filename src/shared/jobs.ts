import { z } from "zod";

import { ID_PATTERN } from "./board.js";
import { CLIENT_ID_PATTERN } from "./command.js";
import { addDays, zoneClock, zoneInstant } from "./ops.js";
import { parseHhMm } from "./quiet.js";
import { KNOWN_REPOS } from "./repos.js";
import { clock, dayDate } from "./when.js";

// Your own scheduled jobs (a red one is on the Red jobs sheet): a check runs one allowlisted pnpm script, or asks one app on
// the health list whether it is up, and costs no tokens; a task opens a chat on your words. Both only read, run checks
// and report.

export const JOB_ID_PATTERN = /^j-[a-z0-9]{8}$/;
/** A name on the health list, which an up check names; the server also holds it to the list. */
export const APP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A run's id: the runner's own, or the server's for a missed run. */
export const JOB_RUN_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export const MAX_ACTIVE_JOBS = 10;

/** A link the browser opens as written: no `..`, user or port, and inside a repo of RIVET_REPOS once normalised. */
export function reportUrlOk(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const inRepo = KNOWN_REPOS.some((repo) => url.href.startsWith(`https://github.com/${repo}/`));
  return url.href === value && url.protocol === "https:" && url.host === "github.com" && !url.username && !url.password && inRepo && !/(^|\/)\.\.?(\/|$)|%2e/i.test(url.pathname);
}

/** Checks at most hourly, tasks at most every 4 hours and 6 task runs a day across all jobs. */
export const CHECK_MIN_HOURS = 1;
export const TASK_MIN_HOURS = 4;
export const MAX_TASK_RUNS_A_DAY = 6;
/** Task runs are skipped at or above this Claude usage, and while usage is unknown. */
export const TASK_USAGE_LIMIT = 85;
export const TASK_MODEL = "claude-opus-5-5";
export const TASK_MAX_MINUTES = 30;
export const JOB_LOG_LINES = 20;
/** A run started this long before its time still counts as that time's run (a scheduler can start one a little early). */
export const RUN_EARLY_MS = 10 * 60_000;

export const MAX_JOB_NAME = 60;
export const MAX_JOB_WORDS = 300;
export const MAX_JOB_LINE = 200;
export const MAX_JOB_LOG_LINE = 500;

export const EVERY_HOURS = [1, 2, 3, 4, 6, 8, 12] as const;
export const WEEK_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];
const DAY_WORDS: Record<WeekDay, string> = { sun: "Sundays", mon: "Mondays", tue: "Tuesdays", wed: "Wednesdays", thu: "Thursdays", fri: "Fridays", sat: "Saturdays" };

/** The scripts a check may run, each only as it is named in the repo's package.json (the Mac checks that), and never one the denylist names. */
export const CHECK_SCRIPT_PATTERN = /^(test|test:[a-z0-9:-]{1,50}|typecheck|lint|validate:[a-z-]{1,40})$/;

/** Words no job may name, in its name, your words or its script: a job never merges, deploys or publishes. */
export const DENIED = /(?<![a-z0-9])(sign-?offs?|deploy\w*|promot\w*|merg\w*|releas\w*|publish\w*)(?![a-z0-9])/i;

/** The first denied word in the text, or null. */
export function deniedWord(text: string): string | null {
  return DENIED.exec(text)?.[1]?.toLowerCase() ?? null;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const plain = (max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .min(1)
        .max(max)
        .refine((value) => !CONTROL.test(value), "one line, no control characters"),
    );
const hhmm = z.string().refine((value) => parseHhMm(value) !== null, "a time is HH:MM");

export const jobWhenSchema = z.discriminatedUnion("every", [
  z
    .object({
      every: z.literal("hours"),
      hours: z.number().int().refine((value) => (EVERY_HOURS as readonly number[]).includes(value), "every 1, 2, 3, 4, 6, 8 or 12 hours"),
      minute: z.number().int().min(0).max(59),
    })
    .strict(),
  z.object({ every: z.literal("day"), at: hhmm }).strict(),
  z.object({ every: z.literal("weekday"), at: hhmm }).strict(),
  z.object({ every: z.literal("week"), day: z.enum(WEEK_DAYS), at: hhmm }).strict(),
]);
export type JobWhen = z.infer<typeof jobWhenSchema>;

export const scriptCheckSchema = z
  .object({
    script: z.string().regex(CHECK_SCRIPT_PATTERN),
    where: z.literal("mac").default("mac"),
    /** card: a red run cards; look: a red run also opens a chat that finds the cause. */
    onRed: z.enum(["card", "look"]),
  })
  .strict();
/** One GET of the app's health check, from the Mac; the URL comes from the health list, never from the job. */
export const upCheckSchema = z
  .object({
    probe: z.literal("up"),
    app: z.string().regex(APP_ID_PATTERN),
    where: z.literal("mac").default("mac"),
    onRed: z.literal("card").default("card"),
  })
  .strict();
export const jobCheckSchema = z.union([scriptCheckSchema, upCheckSchema]);
export type JobCheck = z.infer<typeof jobCheckSchema>;
export type ScriptCheck = z.infer<typeof scriptCheckSchema>;
export type UpCheck = z.infer<typeof upCheckSchema>;

export const isUpCheck = (check: JobCheck): check is UpCheck => "probe" in check;

/** "pnpm typecheck on the Mac", "whether my-app is up, from the Mac". */
export function checkWords(check: JobCheck): string {
  return isUpCheck(check) ? `whether ${check.app} is up, from the Mac` : `pnpm ${check.script} on the Mac`;
}

/** What a job is, as Rivet sets it from your words. */
export const jobSpecSchema = z
  .object({
    name: plain(MAX_JOB_NAME),
    words: plain(MAX_JOB_WORDS),
    kind: z.enum(["check", "task"]),
    check: jobCheckSchema.optional(),
    when: jobWhenSchema,
    /** red: a card on the first red run only; every: a Seen update after each run too. */
    cards: z.enum(["red", "every"]),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const issue = (message: string, path: string[] = []) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    if (spec.kind === "check" && !spec.check) issue("a check names its script", ["check"]);
    if (spec.kind === "task" && spec.check) issue("a task runs no script", ["check"]);
    const hours = everyHours(spec.when);
    if (spec.kind === "task" && hours < TASK_MIN_HOURS) issue(`a task runs at most every ${TASK_MIN_HOURS} hours`, ["when"]);
    if (spec.kind === "check" && hours < CHECK_MIN_HOURS) issue("a check runs at most hourly", ["when"]);
    const target = !spec.check ? "" : isUpCheck(spec.check) ? spec.check.app : spec.check.script;
    for (const [field, text] of [["name", spec.name], ["words", spec.words], ["check", target]] as const) {
      const word = deniedWord(text);
      if (word) issue(`a job never does "${word}"`, [field]);
    }
  });
export type JobSpec = z.infer<typeof jobSpecSchema>;

const clientId = z.string().regex(CLIENT_ID_PATTERN);

export const jobCreateSchema = z.object({ clientId, job: jobSpecSchema, dryRun: z.boolean().optional() }).strict();
export const JOB_OPS = ["pause", "resume", "run"] as const;
export type JobOp = (typeof JOB_OPS)[number];
export const jobChangeSchema = z.object({ clientId, op: z.enum(JOB_OPS) }).strict();
export const jobRemoveSchema = z.object({ clientId }).strict();

export const RUN_RESULTS = ["running", "green", "red", "skipped", "missed"] as const;
export type RunResult = (typeof RUN_RESULTS)[number];

/** The bridge's run report: `start` asks whether the run may go; the rest finish it. */
export const runReportSchema = z
  .object({
    run: z.string().regex(JOB_RUN_ID_PATTERN),
    /** "look": a look check's red run asks to open its chat, which counts as a task run. */
    state: z.enum(["start", "green", "red", "skipped", "look"]),
    /** Started by Run now rather than the schedule. */
    manual: z.boolean().optional(),
    /** The Run now action that started it, so only that action's failure lets go of it. */
    action: z.string().regex(ID_PATTERN).optional(),
    /** Claude usage now, the higher of session and week, or null when it is not known: a task start needs it. */
    usage: z.number().min(0).max(100).nullable().optional(),
    line: plain(MAX_JOB_LINE).optional(),
    log: z.array(z.string().max(MAX_JOB_LOG_LINE)).max(JOB_LOG_LINES).optional(),
    url: z
      .string()
      .url()
      .max(300)
      // A run's link is a PR or a log on this repository: a link elsewhere could carry what a chat read.
      .refine(reportUrlOk, "a link to this repository on github.com only")
      .optional(),
  })
  .strict();
export type RunReport = z.infer<typeof runReportSchema>;

/** `rivet job report`: the job's own chat closes the run it was opened for, once. */
export const taskReportSchema = z
  .object({
    run: z.string().regex(JOB_RUN_ID_PATTERN),
    state: z.enum(["green", "red"]),
    line: plain(MAX_JOB_LINE),
    url: runReportSchema.shape.url,
  })
  .strict();

export interface JobRun {
  id: string;
  at: string;
  finishedAt?: string;
  result: RunResult;
  manual?: boolean;
  line?: string;
  log?: string[];
  url?: string;
}

/** "removing": Delete went to the Mac, and the job stays until the Mac says its LaunchAgent is gone. */
export type JobState = "active" | "paused" | "removing";

export interface Job extends JobSpec {
  id: string;
  state: JobState;
  /** Why its last Delete did not go through; it is back as it was. */
  note?: string;
  createdAt: string;
  /** Since when its runs are due: made or last resumed. */
  activeSince: string;
  /** "Daily 7:00am" */
  whenText: string;
  nextRun: string | null;
  lastRun: JobRun | null;
  /** Newest first, at most 10. */
  runs: JobRun[];
  /** Red or missed runs in a row, newest first: 0 when it is not red. */
  redStreak: number;
  /** When the red streak's first run began, while it is red: a Dismiss holds until a new streak starts. */
  redSince?: string;
  /** Someone is on it, by its Ops record: its red files no card and leaves the indicators calm. */
  owned: boolean;
}

export interface JobsResponse {
  at: string;
  jobs: Job[];
  limits: { active: number; maxActive: number; tasksToday: number; maxTasksToday: number };
}

/** What starting a run answers: go, or the note the skipped run keeps. */
export type RunStart = { go: true; run: string; job: { id: string; kind: Job["kind"]; name: string; words: string; check?: JobCheck } } | { go: false; note: string };

export function everyHours(when: JobWhen): number {
  return when.every === "hours" ? when.hours : when.every === "week" ? 24 * 7 : 24;
}

/** "7:00am", "12:30pm". */
export function clockWords(minute: number): string {
  const hour = Math.floor(minute / 60);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute % 60).padStart(2, "0")}${hour < 12 ? "am" : "pm"}`;
}

export function whenWords(when: JobWhen): string {
  if (when.every === "hours") return when.hours === 1 ? `Hourly at :${String(when.minute).padStart(2, "0")}` : `Every ${when.hours} hours at :${String(when.minute).padStart(2, "0")}`;
  const at = clockWords(parseHhMm(when.at)!);
  if (when.every === "day") return `Daily ${at}`;
  if (when.every === "weekday") return `Weekdays ${at}`;
  return `${DAY_WORDS[when.day]} ${at}`;
}

/** The confirm card's title: "New job · Daily 7:00am · Check my-app is up · Card only if red". */
export function confirmLine(spec: Pick<JobSpec, "words" | "when" | "cards">): string {
  const words = spec.words.charAt(0).toUpperCase() + spec.words.slice(1);
  return `New job · ${whenWords(spec.when)} · ${words} · ${spec.cards === "red" ? "Card only if red" : "Card every run"}`;
}

/** The 5-field cron it runs on, in your time zone. */
export function jobCron(when: JobWhen): string {
  if (when.every === "hours") return `${when.minute} ${when.hours === 1 ? "*" : `*/${when.hours}`} * * *`;
  const minute = parseHhMm(when.at)!;
  const time = `${minute % 60} ${Math.floor(minute / 60)}`;
  if (when.every === "day") return `${time} * * *`;
  if (when.every === "weekday") return `${time} * * 1-5`;
  return `${time} * * ${WEEK_DAYS.indexOf(when.day)}`;
}

/** The minutes of a day the job runs at, or none on a day it does not. */
function minutesOn(when: JobWhen, day: string): number[] {
  if (when.every === "hours") return Array.from({ length: 24 / when.hours }, (_, n) => n * when.hours * 60 + when.minute);
  const [y, m, d] = day.split("-").map(Number);
  const weekday = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  if (when.every === "weekday" && (weekday === 0 || weekday === 6)) return [];
  if (when.every === "week" && WEEK_DAYS[weekday] !== when.day) return [];
  return [parseHhMm(when.at)!];
}

/** Its run times in (from, to], oldest first. A time the clocks skip when daylight saving starts is no run, as in cron. */
export function runTimes(when: JobWhen, from: Date, to: Date): Date[] {
  const out: Date[] = [];
  const last = addDays(zoneClock(to).day, 1);
  for (let day = addDays(zoneClock(from).day, -1); day <= last; day = addDays(day, 1)) {
    for (const minute of minutesOn(when, day)) {
      const at = zoneInstant(day, minute);
      const seen = zoneClock(at);
      if (seen.day !== day || seen.minute !== minute) continue;
      if (at.getTime() > from.getTime() && at.getTime() <= to.getTime()) out.push(at);
    }
  }
  return out;
}

export function nextRunTime(when: JobWhen, after: Date): Date | null {
  return runTimes(when, after, new Date(after.getTime() + 8 * 86_400_000))[0] ?? null;
}

/** The newest `count` run times at or before `at`, newest first. */
export function lastRunTimes(when: JobWhen, at: Date, count: number): Date[] {
  return runTimes(when, new Date(at.getTime() - 15 * 86_400_000), at).reverse().slice(0, count);
}

/** What the Mac does to a job's LaunchAgent (bridge/lib/jobs.mjs). */
export type JobActionOp = "create" | JobOp | "remove";
export interface JobAction {
  op: JobActionOp;
  id: string;
  /** create only: what the LaunchAgent is made from. */
  spec?: Pick<JobSpec, "name" | "words" | "kind" | "check"> & { cron: string };
}

/** "Sat 24 Oct 7:00am", through when.ts: a card's text is read on any day, so it names its date. */
export function dayTimeWords(at: Date | string): string {
  return `${dayDate(at)} ${clock(at)}`;
}

/** The schedule key a job's card and its Ops record go by: `rivet fix schedule job-<id>`. */
export function jobScheduleKey(id: string): string {
  return `job-${id}`;
}
