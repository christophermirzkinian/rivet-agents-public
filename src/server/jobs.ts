import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { Need } from "../shared/board.js";
import { RIVET_NAME } from "../shared/names.js";
import { isMoneyText } from "../shared/ops-cards.js";
import { zoneClock } from "../shared/ops.js";
import {
  checkWords,
  isUpCheck,
  jobScheduleKey,
  lastRunTimes,
  MAX_ACTIVE_JOBS,
  MAX_TASK_RUNS_A_DAY,
  nextRunTime,
  RUN_EARLY_MS,
  dayTimeWords,
  TASK_USAGE_LIMIT,
  whenWords,
  type Job,
  type JobRun,
  type JobSpec,
  type JobState,
  type JobsResponse,
  type RunReport,
  type RunResult,
  type RunStart,
} from "../shared/jobs.js";
import { MAX_RECENT_RUNS, type Schedule } from "../shared/schedules.js";
import type { FailingSchedule } from "./schedules.js";

// See store.ts: node:sqlite goes through createRequire under vitest.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

// Your own jobs and their runs. A run is only ever reported by the job (the Mac starting it says nothing about green
// or red), and silence is never green: a run time with no report by the next one is a missed run, which counts as red.
// A card row keeps a red streak's card id steady, pushes it once and holds your answer, as schedule_cards does.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  spec          TEXT NOT NULL,
  state         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  active_since  TEXT NOT NULL,
  before_remove TEXT,
  note          TEXT,
  last_action   TEXT
);
CREATE TABLE IF NOT EXISTS job_runs (
  job_id      TEXT NOT NULL,
  id          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  at          TEXT NOT NULL,
  finished_at TEXT,
  result      TEXT NOT NULL,
  manual      INTEGER NOT NULL DEFAULT 0,
  line        TEXT,
  log         TEXT,
  url         TEXT,
  action      TEXT,
  PRIMARY KEY (job_id, id)
);
CREATE INDEX IF NOT EXISTS job_runs_at ON job_runs (job_id, at);
CREATE TABLE IF NOT EXISTS job_looks (
  job_id      TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  at          TEXT NOT NULL,
  reported_at TEXT,
  PRIMARY KEY (job_id, run_id)
);
CREATE TABLE IF NOT EXISTS job_cards (
  job_id      TEXT PRIMARY KEY,
  card_id     TEXT NOT NULL,
  shown_at    TEXT NOT NULL,
  answered_at TEXT
);
`;

/** A red job's card id: the server's own, under the failing-schedule prefix the board token can't write. */
export const JOB_CARD_PREFIX = "schedule-job-";
/** A job's Seen updates. */
export const JOB_NOTE_PREFIX = "jobnote-";
const RUNS_SHOWN = 10;
const RUNS_KEPT_MS = 30 * 86_400_000;

/** A Seen update the server adds about a job. */
export interface JobNote {
  id: string;
  title: string;
  ask: string;
}

/** What a finished run changes on the feed: a red card to push, Seen updates to add. */
export interface JobOutcome {
  fresh: Need[];
  notes: JobNote[];
}

interface JobRow {
  id: string;
  spec: string;
  state: JobState;
  created_at: string;
  active_since: string;
  before_remove: "active" | "paused" | null;
  note: string | null;
  last_action: string | null;
}

interface RunRow {
  job_id: string;
  id: string;
  kind: string;
  at: string;
  finished_at: string | null;
  result: RunResult;
  manual: number;
  line: string | null;
  log: string | null;
  url: string | null;
}

interface CardRow {
  job_id: string;
  card_id: string;
  shown_at: string;
  answered_at: string | null;
}

interface Stored {
  id: string;
  spec: JobSpec;
  state: JobState;
  createdAt: string;
  activeSince: string;
  note: string | null;
  /** The newest action sent to the Mac for it: only that one's failure may undo a change. */
  lastAction: string | null;
}

export class JobsStore {
  private readonly db: InstanceType<typeof DatabaseSync>;

  /** `owned`: someone is on this job's schedule key, by its Ops record (SchedulesStore's test). */
  constructor(
    dataDir: string,
    private readonly owned: (key: string) => boolean = () => false,
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "rivet.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  get(id: string): Stored | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as unknown as JobRow | undefined;
    return row ? stored(row) : null;
  }

  private all(): Stored[] {
    return (this.db.prepare("SELECT * FROM jobs ORDER BY created_at, id").all() as unknown as JobRow[]).map(stored);
  }

  activeCount(): number {
    // A job being deleted holds its place: a Delete the Mac could not do puts it back.
    return (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = 'active' OR (state = 'removing' AND before_remove = 'active')").get() as { n: number }).n;
  }

  /** Adds a job, or says why not: the active limit holds here, in one statement with the count. */
  create(id: string, spec: JobSpec, at: Date): { ok: true } | { ok: false; reason: string } {
    if (this.activeCount() >= MAX_ACTIVE_JOBS) return { ok: false, reason: `${MAX_ACTIVE_JOBS} jobs are on already: pause or delete one first` };
    if (this.all().some((job) => job.spec.name.toLowerCase() === spec.name.toLowerCase())) return { ok: false, reason: "a job of that name is on the list already" };
    this.db
      .prepare("INSERT INTO jobs (id, spec, state, created_at, active_since) VALUES (?, ?, 'active', ?, ?)")
      .run(id, JSON.stringify(spec), at.toISOString(), at.toISOString());
    return { ok: true };
  }

  /** Pause or resume. A resumed job's run times count from now, so the paused ones are never missed runs. */
  setState(id: string, state: "active" | "paused", at: Date, note: string | null = null): { ok: true } | { ok: false; reason: string } {
    const job = this.get(id);
    if (!job) return { ok: false, reason: "no such job" };
    if (job.state === "removing") return { ok: false, reason: "it is being deleted" };
    if (job.state === state && note === null) return { ok: true };
    if (state === "active" && job.state !== "active" && this.activeCount() >= MAX_ACTIVE_JOBS) return { ok: false, reason: `${MAX_ACTIVE_JOBS} jobs are on already: pause or delete one first` };
    const since = state === "active" && job.state !== "active";
    this.db
      .prepare(`UPDATE jobs SET state = ?, note = ?${since ? ", active_since = ?" : ""} WHERE id = ?`)
      .run(...(since ? [state, note, at.toISOString(), id] : [state, note, id]));
    return { ok: true };
  }

  /**
   * The Mac could not make its automation, or could not say it did (a restart mid-make): the job stays, paused and
   * saying why, as the Mac may hold the job all the same. Resume finds it, and Delete removes any there is.
   */
  notSet(id: string, note: string): void {
    this.db.prepare("UPDATE jobs SET state = 'paused', note = ? WHERE id = ? AND state <> 'removing'").run(note, id);
  }

  sentAction(id: string, actionId: string): void {
    this.db.prepare("UPDATE jobs SET last_action = ? WHERE id = ?").run(actionId, id);
  }

  /** Delete went to the Mac: the job stays, running nothing, until the Mac says its automation is gone. */
  markRemoving(id: string): void {
    this.db.prepare("UPDATE jobs SET before_remove = state, state = 'removing', note = NULL WHERE id = ? AND state <> 'removing'").run(id);
  }

  /** The Mac could not remove its automation: the job is back as it was, saying why, and Delete can go again. */
  unremove(id: string, note: string): void {
    this.db.prepare("UPDATE jobs SET state = before_remove, before_remove = NULL, note = ? WHERE id = ? AND state = 'removing'").run(note, id);
  }

  /** Its runs stay a while, as the day's task runs still count. */
  remove(id: string): void {
    this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM job_cards WHERE job_id = ?").run(id);
  }

  /** Newest first; runs with one `at` go by insert order (rowid), never by the caller-chosen id. */
  private runs(jobId: string, limit = 50): RunRow[] {
    return this.db.prepare("SELECT * FROM job_runs WHERE job_id = ? ORDER BY at DESC, rowid DESC LIMIT ?").all(jobId, limit) as unknown as RunRow[];
  }

  /** The newest runs that were not skipped: the streak and the card read these, so skips never push a red out. */
  /**
   * The whole red streak, newest first: redStreak over every run since the newest green, not counted()'s 50, so a long
   * streak keeps its start (a Dismiss's mark) and every run's words are read.
   */
  private streak(jobId: string): JobRun[] {
    const green = this.db.prepare("SELECT at, rowid AS seq FROM job_runs WHERE job_id = ? AND result = 'green' ORDER BY at DESC, rowid DESC LIMIT 1").get(jobId) as { at: string; seq: number } | undefined;
    const rows = green
      ? this.db.prepare("SELECT * FROM job_runs WHERE job_id = ? AND result IN ('red', 'missed') AND (at > ? OR (at = ? AND rowid > ?)) ORDER BY at DESC, rowid DESC").all(jobId, green.at, green.at, green.seq)
      : this.db.prepare("SELECT * FROM job_runs WHERE job_id = ? AND result IN ('red', 'missed') ORDER BY at DESC, rowid DESC").all(jobId);
    return (rows as unknown as RunRow[]).map(toRun);
  }

  private counted(jobId: string, limit = 50): JobRun[] {
    return (this.db.prepare("SELECT * FROM job_runs WHERE job_id = ? AND result <> 'skipped' ORDER BY at DESC, rowid DESC LIMIT ?").all(jobId, limit) as unknown as RunRow[]).map(toRun);
  }

  private run(jobId: string, runId: string): RunRow | null {
    return (this.db.prepare("SELECT * FROM job_runs WHERE job_id = ? AND id = ?").get(jobId, runId) as unknown as RunRow | undefined) ?? null;
  }

  /**
   * Task runs started today, across every job (a deleted one's too), and look checks' chats. A skipped run
   * and a run time the sweep found missed (its id `missed-…`) never started; a started run that never reported did.
   */
  tasksToday(now: Date): number {
    const today = zoneClock(now).day;
    const since = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    const rows = [
      ...(this.db.prepare("SELECT at FROM job_runs WHERE kind = 'task' AND result <> 'skipped' AND id NOT LIKE 'missed-%' AND at >= ?").all(since) as { at: string }[]),
      ...(this.db.prepare("SELECT at FROM job_looks WHERE at >= ?").all(since) as { at: string }[]),
    ];
    return rows.filter((row) => zoneClock(new Date(row.at)).day === today).length;
  }

  /**
   * A skip like the job's newest row merges into it, so a run of the same skip is one row: from its first skip (`at`)
   * to its latest (`finished_at`), and the sweep counts it for every run time in that span. False when it merged.
   */
  private insertSkip(job: Stored, run: { id: string; at: Date; manual?: boolean; line: string }): boolean {
    const newest = this.runs(job.id, 1)[0];
    if (newest?.result === "skipped" && newest.line === run.line && newest.manual === (run.manual ? 1 : 0)) {
      this.db.prepare("UPDATE job_runs SET finished_at = ? WHERE job_id = ? AND id = ?").run(run.at.toISOString(), job.id, newest.id);
      return false;
    }
    this.insertRun(job, { ...run, result: "skipped", finishedAt: run.at });
    return true;
  }

  private insertRun(job: Stored, run: { id: string; at: Date; result: RunResult; manual?: boolean; finishedAt?: Date; line?: string; action?: string }): void {
    this.db
      .prepare("INSERT INTO job_runs (job_id, id, kind, at, finished_at, result, manual, line, action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(job.id, run.id, job.spec.kind, run.at.toISOString(), run.finishedAt?.toISOString() ?? null, run.result, run.manual ? 1 : 0, run.line ?? null, run.action ?? null);
  }

  /**
   * The Mac could not start the task's Run now `actionId`: the run that action began, if any, is kept as skipped, so
   * Run now can go again at once. A late or replayed answer never touches another Run now's run.
   */
  runNotStarted(jobId: string, actionId: string, reason: string, now: Date): void {
    this.db
      .prepare("UPDATE job_runs SET result = 'skipped', finished_at = ?, line = ? WHERE kind = 'task' AND manual = 1 AND result = 'running' AND job_id = ? AND action = ?")
      .run(now.toISOString(), `skipped: the Mac did not start it: ${reason}`, jobId, actionId);
  }

  isRunning(jobId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM job_runs WHERE job_id = ? AND result = 'running'").get(jobId);
  }

  /**
   * A run asks to start. Over a limit it is kept as skipped with the note and never queued: a task over the day's
   * runs, or while Claude usage is high or unknown; a check while its last run is still going. A task's start is one
   * chat, which job-run.mjs starts itself.
   */
  start(jobId: string, report: RunReport, now: Date): RunStart | null {
    const job = this.get(jobId);
    if (!job) return null;
    const go: RunStart = { go: true, run: report.run, job: { id: job.id, kind: job.spec.kind, name: job.spec.name, words: job.spec.words, ...(job.spec.check ? { check: job.spec.check } : {}) } };
    const same = this.run(jobId, report.run);
    if (same) return same.result === "running" && job.spec.kind === "check" && job.state !== "removing" ? go : { go: false, note: same.result === "running" ? "that run has started already" : "that run already finished" };
    if (job.state !== "active") return { go: false, note: stateNote(job.state) };
    const running = this.runs(jobId).find((run) => run.result === "running");
    const skip = (note: string): RunStart => {
      this.insertSkip(job, { id: report.run, at: now, manual: report.manual, line: `skipped: ${note}` });
      return { go: false, note };
    };
    if (running) return skip("the last run is still going");
    if (job.spec.kind === "task") {
      if (this.tasksToday(now) >= MAX_TASK_RUNS_A_DAY) return skip(`${MAX_TASK_RUNS_A_DAY} task runs today already`);
      if (report.usage === undefined || report.usage === null) return skip("Claude usage not known");
      if (report.usage >= TASK_USAGE_LIMIT) return skip("usage high");
    }
    this.insertRun(job, { id: report.run, at: now, result: "running", manual: report.manual, action: report.manual ? report.action : undefined });
    return go;
  }

  /**
   * A look check's red run asks to open its chat. The chat is a task run: the day's task runs and Claude usage hold it,
   * and it counts as one. Once per red run.
   */
  look(jobId: string, report: RunReport, now: Date): RunStart | null {
    const job = this.get(jobId);
    if (!job) return null;
    if (!job.spec.check || isUpCheck(job.spec.check) || job.spec.check.onRed !== "look") return { go: false, note: "its red is only carded" };
    if (job.state !== "active") return { go: false, note: stateNote(job.state) };
    if (this.run(jobId, report.run)?.result !== "red") return { go: false, note: "that run is not red" };
    if (this.db.prepare("SELECT 1 FROM job_looks WHERE job_id = ? AND run_id = ?").get(jobId, report.run)) return { go: false, note: "a chat looked into that run already" };
    if (this.tasksToday(now) >= MAX_TASK_RUNS_A_DAY) return { go: false, note: `${MAX_TASK_RUNS_A_DAY} task runs today already` };
    if (report.usage === undefined || report.usage === null) return { go: false, note: "Claude usage not known" };
    if (report.usage >= TASK_USAGE_LIMIT) return { go: false, note: "usage high" };
    this.db.prepare("INSERT INTO job_looks (job_id, run_id, at) VALUES (?, ?, ?)").run(jobId, report.run, now.toISOString());
    return { go: true, run: report.run, job: { id: job.id, kind: job.spec.kind, name: job.spec.name, words: job.spec.words, check: job.spec.check } };
  }

  /** The bridge finishes a run it started (or skips one it could not start). */
  finish(jobId: string, report: RunReport, now: Date): { status: 200 | 404 | 409; error?: string; outcome?: JobOutcome } {
    const job = this.get(jobId);
    if (!job) return { status: 404, error: "no such job" };
    if (job.state === "removing") return { status: 409, error: stateNote(job.state) };
    const run = this.run(jobId, report.run);
    if (!run) {
      if (report.state !== "skipped") return { status: 404, error: "no such run" };
      if (!this.insertSkip(job, { id: report.run, at: now, manual: report.manual, line: report.line ?? "skipped" })) return { status: 200 };
      return { status: 200, outcome: this.settle(job, report.run, now) };
    }
    if (run.result !== "running") {
      if (run.result === report.state) return { status: 200 };
      return { status: 409, error: run.result === "missed" ? "too late: it was counted as missed" : "that run already finished" };
    }
    this.db
      .prepare("UPDATE job_runs SET result = ?, finished_at = ?, line = ?, log = ?, url = ? WHERE job_id = ? AND id = ?")
      .run(report.state, now.toISOString(), report.line ?? null, report.log ? JSON.stringify(report.log) : null, report.url ?? null, jobId, report.run);
    return { status: 200, outcome: this.settle(job, report.run, now) };
  }

  /**
   * `rivet job report` from the job's own chat, for the run it was opened for, once: a task's running run finishes;
   * a look check's red run (the check finished it) takes the chat's line, the cause.
   */
  report(jobId: string, runId: string, state: "green" | "red", line: string, url: string | undefined, now: Date): { status: 200 | 404 | 409; error?: string; outcome?: JobOutcome } {
    const job = this.get(jobId);
    if (!job) return { status: 404, error: "no such job" };
    if (job.state === "removing") return { status: 409, error: stateNote(job.state) };
    const run = this.run(jobId, runId);
    if (!run) return { status: 404, error: "no such run" };
    if (job.spec.kind === "task" && run.result === "running") return this.finish(jobId, { run: runId, state, line, ...(url ? { url } : {}) }, now);
    const looked = state === "red" && this.db.prepare("UPDATE job_looks SET reported_at = ? WHERE job_id = ? AND run_id = ? AND reported_at IS NULL").run(now.toISOString(), jobId, runId).changes > 0;
    if (looked) {
      this.db.prepare("UPDATE job_runs SET line = ?, url = COALESCE(?, url) WHERE job_id = ? AND id = ?").run(line, url ?? null, jobId, runId);
      return { status: 200, outcome: { fresh: [], notes: [] } };
    }
    return { status: 409, error: run.result === "missed" ? "too late: it was counted as missed" : "that run is not waiting for a report" };
  }

  /**
   * Missed runs, for every active job: the run time before the newest that passed with no run started for it (from a
   * little before it until a little before the next), and any run still going when its next run time came.
   */
  sweep(now: Date): JobOutcome {
    const outcome: JobOutcome = { fresh: [], notes: [] };
    const kept = new Date(now.getTime() - RUNS_KEPT_MS).toISOString();
    // A merged skip stands for every run time up to its finished_at, so it is kept as long as its last one is.
    // A live job's red streak stays whole however old: its start is a Dismiss's mark.
    // Its newest green stays too, as the streak's edge: a missed run finished after an older green is no streak once that
    // green goes.
    this.db
      .prepare(
        `DELETE FROM job_runs WHERE COALESCE(finished_at, at) < ? AND NOT (
          result IN ('red', 'missed', 'green') AND job_id IN (SELECT id FROM jobs)
          AND NOT EXISTS (SELECT 1 FROM job_runs AS g WHERE g.job_id = job_runs.job_id AND g.result = 'green' AND (g.at > job_runs.at OR (g.at = job_runs.at AND g.rowid > job_runs.rowid)))
        )`,
      )
      .run(kept);
    this.db.prepare("DELETE FROM job_looks WHERE at < ?").run(kept);
    for (const job of this.all()) {
      if (job.state !== "active") continue;
      const [newest, before] = lastRunTimes(job.spec.when, now, 2);
      if (!newest || !before) continue;
      const runs = this.runs(job.id);
      for (const run of runs) {
        if (run.result !== "running" || Date.parse(run.at) >= newest.getTime() - RUN_EARLY_MS) continue;
        this.db
          .prepare("UPDATE job_runs SET result = 'missed', finished_at = ?, line = ? WHERE job_id = ? AND id = ?")
          .run(now.toISOString(), `never reported: it started at ${dayTimeWords(run.at)} and sent no result`, job.id, run.id);
        merge(outcome, this.settle(job, run.id, now));
      }
      if (before.getTime() < Date.parse(job.activeSince)) continue;
      const id = `missed-${before.getTime()}`;
      if (this.run(job.id, id)) continue;
      const from = before.getTime() - RUN_EARLY_MS;
      const to = newest.getTime() - RUN_EARLY_MS;
      const ran = runs.some((run) => {
        if (run.manual !== 0 || run.id === id) return false;
        const last = run.result === "skipped" && run.finished_at ? Date.parse(run.finished_at) : Date.parse(run.at);
        return Date.parse(run.at) < to && last >= from;
      });
      if (ran) continue;
      this.insertRun(job, { id, at: before, result: "missed", finishedAt: now, line: `did not run at ${dayTimeWords(before)}: the Mac was asleep or the run never started` });
      merge(outcome, this.settle(job, id, now));
    }
    return outcome;
  }

  /** After a run finished: the first red of a streak cards (once), the first green after red says so, and so on. */
  private settle(job: Stored, runId: string, now: Date): JobOutcome {
    const outcome: JobOutcome = { fresh: [], notes: [] };
    const found = this.run(job.id, runId);
    if (!found) return outcome;
    const run = toRun(found);
    const runs = this.counted(job.id);
    const counted = runs.filter((one) => one.result !== "running");
    const at = dayTimeWords(run.at);
    const note = (title: string, ask: string) => outcome.notes.push({ id: `${JOB_NOTE_PREFIX}${job.id}-${run.id}`, title, ask });
    if (run.result === "skipped") {
      if (job.spec.cards === "every") note(`${job.spec.name}: skipped`, `${run.line ?? "skipped"} (${at}).`);
      return outcome;
    }
    if (run.result === "green") {
      const before = counted[counted.findIndex((one) => one.id === run.id) + 1];
      const wasRed = before?.result === "red" || before?.result === "missed";
      this.db.prepare("DELETE FROM job_cards WHERE job_id = ?").run(job.id);
      if (wasRed) note(`${job.spec.name} is back to green`, `${run.line ?? "It passed."} (${at}).`);
      else if (job.spec.cards === "every") note(`${job.spec.name}: green`, `${run.line ?? "It passed."} (${at}).`);
      return outcome;
    }
    const streak = redStreak(runs);
    const row = this.cardRow(job.id);
    const key = jobScheduleKey(job.id);
    if (!row && !this.owned(key) && streak.length) {
      const cardId = jobCardId(job.id, streak[streak.length - 1]!.id);
      this.db.prepare("INSERT INTO job_cards (job_id, card_id, shown_at) VALUES (?, ?, ?)").run(job.id, cardId, now.toISOString());
      outcome.fresh.push(redCard(job, streak, cardId));
    } else if (job.spec.cards === "every") {
      note(`${job.spec.name}: still red`, `${runLine(run)} (${at}).`);
    }
    return outcome;
  }

  private cardRow(jobId: string): CardRow | null {
    return (this.db.prepare("SELECT * FROM job_cards WHERE job_id = ?").get(jobId) as unknown as CardRow | undefined) ?? null;
  }

  /** Each red job's card, worked out from its runs, as SchedulesStore.failing gives a failing schedule's. */
  /** Whether this job's red streak names money: a parked record does not quiet it. */
  loud(key: string): boolean {
    const job = this.all().find((one) => jobScheduleKey(one.id) === key);
    if (!job) return false;
    const streak = this.streak(job.id);
    const words = [...streakWords(job, streak), job.spec.check ? checkWords(job.spec.check) : ""];
    return streak.length > 0 && isMoneyText(...words);
  }

  failing(): FailingSchedule[] {
    return this.all().flatMap((job) => {
      const streak = job.state === "removing" ? [] : redStreak(this.counted(job.id));
      if (!streak.length) return [];
      const row = this.cardRow(job.id);
      const cardId = row?.card_id ?? jobCardId(job.id, streak[streak.length - 1]!.id);
      const key = jobScheduleKey(job.id);
      return [{ scheduleId: key, need: redCard(job, streak, cardId), detail: redDetail(job, streak[0]!), url: streak[0]!.url ?? null, answered: !!row?.answered_at, answeredAt: row?.answered_at ?? null, owned: this.owned(key), held: false }];
    });
  }

  /**
   * Each job read as a schedule, by its card's key, for the passes that set a record fixed once its item runs green
   * (fixes.ts, auto-clear.ts): your jobs are not in the bridge's schedules reading.
   */
  readings(): Schedule[] {
    const result = (run: JobRun) => (run.result === "green" ? "ok" : run.result === "running" ? "running" : "failed");
    return this.all().map((job) => {
      const counted = this.counted(job.id, MAX_RECENT_RUNS + 1);
      const runs = counted.filter((run) => run.result !== "running").slice(0, MAX_RECENT_RUNS);
      const newest = counted[0];
      return {
        id: jobScheduleKey(job.id),
        source: "mac",
        name: job.spec.name,
        what: job.spec.words,
        when: whenWords(job.spec.when),
        group: "daily",
        on: job.state === "active",
        lastRun: newest ? { at: newest.finishedAt ?? newest.at, result: result(newest) } : null,
        runs: runs.map((run) => ({ id: run.id, at: run.finishedAt ?? run.at, result: result(run) as "ok" | "failed" })),
        nextRun: null,
        toggle: { can: false, why: "It is a job: ask Rivet to pause it." },
      };
    });
  }

  /** You answered the red card (Leave it too): no card again until it goes green, then red. */
  answer(jobId: string, cardId: string, at: Date): void {
    this.db
      .prepare("INSERT INTO job_cards (job_id, card_id, shown_at, answered_at) VALUES (?, ?, ?, ?) ON CONFLICT (job_id) DO UPDATE SET answered_at = excluded.answered_at")
      .run(jobId, cardId, at.toISOString(), at.toISOString());
  }

  /** A red card whose push never went: its row goes, so the next red run pushes it again. */
  unfile(jobId: string): void {
    this.db.prepare("DELETE FROM job_cards WHERE job_id = ? AND answered_at IS NULL").run(jobId);
  }

  view(job: Stored, now: Date): Job {
    const runs = this.runs(job.id, RUNS_SHOWN).map(toRun);
    const next = job.state === "active" ? nextRunTime(job.spec.when, now) : null;
    const streak = this.streak(job.id);
    return {
      ...job.spec,
      id: job.id,
      state: job.state,
      ...(job.note ? { note: job.note } : {}),
      createdAt: job.createdAt,
      activeSince: job.activeSince,
      whenText: whenWords(job.spec.when),
      nextRun: next?.toISOString() ?? null,
      lastRun: runs[0] ?? null,
      runs,
      redStreak: streak.length,
      ...(streak.length ? { redSince: streak[streak.length - 1]!.at } : {}),
      owned: this.owned(jobScheduleKey(job.id)),
    };
  }

  list(now: Date): JobsResponse {
    const jobs = this.all().map((job) => this.view(job, now));
    return {
      at: now.toISOString(),
      jobs,
      limits: { active: jobs.filter((job) => job.state === "active").length, maxActive: MAX_ACTIVE_JOBS, tasksToday: this.tasksToday(now), maxTasksToday: MAX_TASK_RUNS_A_DAY },
    };
  }
}

function stored(row: JobRow): Stored {
  return { id: row.id, spec: JSON.parse(row.spec) as JobSpec, state: row.state, createdAt: row.created_at, activeSince: row.active_since, note: row.note, lastAction: row.last_action };
}

const stateNote = (state: JobState) => (state === "removing" ? "it is being deleted" : state);

function toRun(row: RunRow): JobRun {
  return {
    id: row.id,
    at: row.at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    result: row.result,
    ...(row.manual ? { manual: true } : {}),
    ...(row.line ? { line: row.line } : {}),
    ...(row.log ? { log: JSON.parse(row.log) as string[] } : {}),
    ...(row.url ? { url: row.url } : {}),
  };
}

function merge(into: JobOutcome, more: JobOutcome): void {
  into.fresh.push(...more.fresh);
  into.notes.push(...more.notes);
}

/** The red and missed runs in a row at the newest end, newest first; skipped and running ones neither break nor join it. */
export function redStreak(runs: readonly JobRun[]): JobRun[] {
  const streak: JobRun[] = [];
  for (const run of runs) {
    if (run.result === "running" || run.result === "skipped") continue;
    if (run.result === "green") break;
    streak.push(run);
  }
  return streak;
}

export function jobCardId(jobId: string, startRunId: string): string {
  return `${JOB_CARD_PREFIX}${createHash("sha256").update(`${jobId}\n${startRunId}`).digest("hex").slice(0, 16)}`;
}

function runLine(run: JobRun): string {
  return run.line ?? (run.result === "missed" ? "It did not run." : "It failed.");
}

function redCard(job: Stored, streak: readonly JobRun[], id: string): Need {
  const newest = streak[0]!;
  const first = streak[streak.length - 1]!;
  const where = job.spec.check && !isUpCheck(job.spec.check) ? " Its last lines are on the Red jobs sheet." : "";
  return {
    id,
    kind: "decision",
    title: `${job.spec.name} is red`,
    ask: `${runLine(newest)} (${dayTimeWords(newest.at)}).${streak.length > 1 ? ` Red ${streak.length} runs in a row.` : ""}${where}`,
    since: first.finishedAt ?? first.at,
    schedule: jobScheduleKey(job.id),
    options: [
      { label: "Fix it", recommended: true },
      { label: "Leave it", detail: "No new card until it goes green and then red again." },
    ],
    ...(newest.url ? { links: [{ label: newest.url.includes("/pull/") ? "Open PR" : "Open log", url: newest.url, primary: true }] } : {}),
  };
}

/** What Rivet gets with the answer: enough to open the fix with `rivet fix schedule <key>`. */
/** A job's words and every line and log of its streak. */
function streakWords(job: Stored, streak: JobRun[]): string[] {
  return [job.spec.name, job.spec.words, ...streak.flatMap((run) => [run.line ?? "", ...(run.log ?? [])])];
}

function redDetail(job: Stored, newest: JobRun): string {
  const what = job.spec.check ? `a check, ${checkWords(job.spec.check)}` : "a task";
  const log = newest.log?.slice(-5).join(" | ");
  return `${RIVET_NAME} job ${job.id} "${job.spec.name}" (${what}; the owner's words: "${job.spec.words}"). Newest red run ${dayTimeWords(newest.at)}: ${runLine(newest)}${log ? ` Last lines: ${log}` : ""}${newest.url ? ` Link: ${newest.url}` : ""}. To fix it: rivet fix schedule ${jobScheduleKey(job.id)}.`.slice(0, 2000);
}
