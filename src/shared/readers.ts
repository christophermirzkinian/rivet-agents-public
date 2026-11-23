// The readers that fix themselves: each says how fresh its reading should be, and server/ops/readers.ts
// checks it is fresh, holds something and makes sense. Readers only the owner's version has are in readers-extra.ts,
// which the public export leaves out.

/**
 * - `haiku`: a dev.rivet-agents.reader-* launchd job (scripts/install-readers.sh), read from the schedules snapshot.
 * - `bridge`: one of the bridge's Ops readings.
 * - `usage`: the bridge's Claude usage reading.
 */
export type ReaderKind = "haiku" | "bridge" | "usage";

export interface ReaderSpec {
  id: string;
  name: string;
  /** One plain line for its Behaviours row. */
  line: string;
  kind: ReaderKind;
  /** The fresh windows its row offers, in minutes; `defaultFresh` is one of them. */
  fresh: readonly number[];
  defaultFresh: number;
  /** A haiku reader's schedule id. */
  schedule?: string;
}

const HOUR = 60;
const DAY = 24 * HOUR;

const haiku = (id: string, name: string, line: string, fresh: readonly number[], defaultFresh = fresh[0]!): ReaderSpec => ({
  id,
  name,
  line,
  kind: "haiku",
  fresh,
  defaultFresh,
  schedule: `mac:dev.rivet-agents.reader-${id}`,
});

// Each default is about three times how often it runs; a weekly one waits 8 days.
export const READERS: readonly ReaderSpec[] = [
  haiku("chat-watch", "Chat watch reader", "Reads chat screens every 2 min", [10, 30, HOUR]),
  haiku("ci-triage", "CI triage reader", "Reads failed CI logs every 5 min", [15, 30, HOUR]),
  haiku("fly-errors", "Fly errors reader", "Reads Fly app errors every 10 min", [30, HOUR, 2 * HOUR]),
  haiku("issue-recheck", "Issue recheck reader", "Rechecks open issues each night", [26 * HOUR, 2 * DAY, 3 * DAY], 2 * DAY),
  haiku("memory-check", "Memory check reader", "Checks the notes each night", [26 * HOUR, 2 * DAY, 3 * DAY], 2 * DAY),
  haiku("weekly-learned-record", "Weekly learned notes", "Notes what was learned every hour", [3 * HOUR, 6 * HOUR, 12 * HOUR]),
  haiku("weekly-learned", "Weekly learned reader", "Proposes what was learned each week", [8 * DAY, 15 * DAY]),
  { id: "github", name: "GitHub reading", line: "PRs, CI runs and runners, read every minute", kind: "bridge", fresh: [15, 30, HOUR], defaultFresh: 15 },
  { id: "fly", name: "Fly reading", line: "Apps and their releases on Fly", kind: "bridge", fresh: [HOUR, 2 * HOUR, 6 * HOUR], defaultFresh: HOUR },
  { id: "backlog", name: "Backlog reading", line: "Each repo's open issues", kind: "bridge", fresh: [HOUR, 2 * HOUR, 6 * HOUR], defaultFresh: HOUR },
  { id: "usage", name: "Usage reading", line: "How much of each account's week is used", kind: "usage", fresh: [30, HOUR, 2 * HOUR], defaultFresh: 30 },
];

/** The pick-up's own cap (ops/pickup.ts PICKUP_KEY_CAP) is the default. */
export const READER_FIX_CAPS = [2, 3, 5] as const;
export type ReaderFixCap = (typeof READER_FIX_CAPS)[number];
export const DEFAULT_READER_FIX_CAP: ReaderFixCap = 3;

/** A reading time further ahead than this is a wrong clock, not a fast reader. */
export const AHEAD_MS = 5 * 60_000;

export const READERS_FIX_ID = "ops.readers-fix";
export const readerBehaviourId = (id: string) => `reader.${id}`;
/** A reader's Ops record: kind `schedule`, as a job's is `job-<id>`. */
export const readerKey = (id: string) => `reader-${id}`;
/** A reader's record: the owner hears of it only past its fix cap, on the pick-up's keeps-breaking card. */
export const isReaderRecord = (kind: string, key: string) => kind === "schedule" && key.startsWith("reader-");

/** "30 min", "2 h", "26 h", "8 days". */
export function minutesWords(minutes: number): string {
  if (minutes < HOUR) return `${Math.max(1, Math.round(minutes))} min`;
  if (minutes < 2 * DAY && minutes % DAY !== 0) return `${Math.round(minutes / HOUR)} h`;
  const days = Math.round(minutes / DAY);
  return `${days} ${days === 1 ? "day" : "days"}`;
}
