import { z } from "zod";

// The Schedules tab: every timed or always-on job, read live by the Mac bridge from launchd and GitHub. The bridge sends
// plain words; the app only lays them out.

export const SCHEDULE_GROUPS = ["daily", "weekly", "all-day", "always-on"] as const;
export type ScheduleGroup = (typeof SCHEDULE_GROUPS)[number];
export const GROUP_TITLES: Record<ScheduleGroup, string> = { daily: "Daily", weekly: "Weekly", "all-day": "All day", "always-on": "Always on" };

export const SCHEDULE_SOURCES = ["mac", "github"] as const;
export type ScheduleSource = (typeof SCHEDULE_SOURCES)[number];
export const SOURCE_WORDS: Record<ScheduleSource, string> = {
  mac: "Mac",
  github: "GitHub",
};

/** Mirrors SCHEDULE_ID_RE in bridge/lib/schedules/toggle.mjs. */
export const SCHEDULE_ID_PATTERN =
  /^(mac:dev\.rivet-agents\.[a-z0-9][a-z0-9.-]{0,80}|github:[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}\.ya?ml)$/;

export const MAX_SCHEDULES = 100;
export const SCHEDULES_MAX_BYTES = 256 * 1024;
/** A snapshot older than this is not how things are now: the page says so. The bridge sends one a minute. */
export const SCHEDULES_STALE_MS = 3 * 60_000;
/** This many finished runs failing in a row puts a card on the feed. */
export const FAILING_AFTER = 2;
/** Both of those runs finished within this long, so a weekly job's last two count but older history never does. */
export const FAILING_WINDOW_MS = 8 * 24 * 60 * 60_000;
/** Finished runs the bridge sends per schedule, newest first. */
export const MAX_RECENT_RUNS = 5;

const iso = z.string().datetime();
const line = (max: number) => z.string().min(1).max(max);

const lastRunSchema = z
  .object({
    at: iso.nullable(),
    result: z.enum(["ok", "failed", "skipped", "running", "unknown"]),
    note: line(160).optional(),
    url: z.string().regex(/^https:\/\/github\.com\//).max(300).optional(),
  })
  .strict();

/**
 * One finished run. `id` stays the same for that run: GitHub's run id, launchd's run count and when it
 * was seen. "unknown" is a run whose outcome or finish time the Mac could not know: it breaks a streak.
 */
const recentRunSchema = z
  .object({
    id: line(120),
    at: iso,
    result: z.enum(["ok", "failed", "skipped", "unknown"]),
    url: z.string().regex(/^https:\/\/github\.com\//).max(300).optional(),
  })
  .strict();

export const scheduleSchema = z
  .object({
    id: z.string().regex(SCHEDULE_ID_PATTERN),
    source: z.enum(SCHEDULE_SOURCES),
    name: line(80),
    what: line(200),
    when: line(120),
    group: z.enum(SCHEDULE_GROUPS),
    on: z.boolean(),
    lastRun: lastRunSchema.nullable(),
    /** Finished runs, newest first. An always-on job has none: it never finishes as ok. */
    runs: z.array(recentRunSchema).max(MAX_RECENT_RUNS).optional(),
    nextRun: iso.nullable(),
    toggle: z.union([z.object({ can: z.literal(true) }).strict(), z.object({ can: z.literal(false), why: line(200) }).strict()]),
  })
  .strict()
  .refine((item) => item.id.startsWith(`${item.source}:`), "a schedule's id must start with its source");

export const schedulesSnapshotSchema = z
  .object({
    at: iso,
    items: z.array(scheduleSchema).max(MAX_SCHEDULES),
    sources: z
      .array(z.object({ source: z.enum(SCHEDULE_SOURCES), ok: z.boolean(), at: iso.nullable(), error: line(160).optional() }).strict())
      .max(2),
  })
  .strict()
  .refine((value) => new Set(value.items.map((item) => item.id)).size === value.items.length, "a schedule is listed twice");

export type BridgeSchedule = z.infer<typeof scheduleSchema>;
export type SchedulesSnapshot = z.infer<typeof schedulesSnapshotSchema>;
export type LastRun = z.infer<typeof lastRunSchema>;
export type RecentRun = z.infer<typeof recentRunSchema>;

export type Schedule = BridgeSchedule;

export interface SchedulesResponse {
  /** When the bridge read them; null before its first snapshot. */
  at: string | null;
  /** True once `at` is over SCHEDULES_STALE_MS old. */
  stale: boolean;
  items: Schedule[];
  sources: SchedulesSnapshot["sources"];
}

export interface Streak {
  /** The oldest of its failed runs within FAILING_WINDOW_MS: the "failing since". */
  start: RecentRun;
  newest: RecentRun;
  length: number;
}

/**
 * The newest finished run, as failingStreak reads it: lastRun is the newest created (a GitHub run's created time, or
 * still running), so a rerun of an older run that failed since, or a pass under a running one, would misread.
 */
export function newestFinished(item: Schedule): RecentRun | LastRun | null {
  return [...(item.runs ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? (item.lastRun?.result === "running" ? null : item.lastRun);
}

/** The newest finished runs failing in a row within FAILING_WINDOW_MS, when at least FAILING_AFTER of them did. */
export function failingStreak(item: Schedule, now: Date): Streak | null {
  if (item.group === "always-on") return null;
  const runs = [...(item.runs ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const end = runs.findIndex((run) => run.result !== "failed" || now.getTime() - Date.parse(run.at) > FAILING_WINDOW_MS);
  const failed = runs.slice(0, end < 0 ? runs.length : end);
  if (failed.length < FAILING_AFTER) return null;
  return { start: failed[failed.length - 1]!, newest: failed[0]!, length: failed.length };
}
