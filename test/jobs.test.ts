import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { JobsStore, redStreak } from "../src/server/jobs.js";
import { SchedulesStore } from "../src/server/schedules.js";
import {
  APP_ID_PATTERN,
  CHECK_SCRIPT_PATTERN,
  checkWords,
  confirmLine,
  DENIED,
  deniedWord,
  JOB_ID_PATTERN,
  jobCron,
  jobSpecSchema,
  runReportSchema,
  lastRunTimes,
  nextRunTime,
  runTimes,
  dayTimeWords,
  whenWords,
  type JobSpec,
  type RunReport,
} from "../src/shared/jobs.js";
import { setKnownRepos } from "../src/shared/repos.js";
import { setTimeZone } from "../src/shared/when.js";

// 7:00am Saturday 24 Oct 2026 local time (the test zone, +11).
const SAT_7AM = new Date("2026-10-23T20:00:00.000Z");
const HOUR = 3_600_000;

const check = (overrides: Partial<JobSpec> = {}): JobSpec => ({
  name: "Notes app up",
  words: "check notes app is up",
  kind: "check",
  check: { probe: "up", app: "notes-app", where: "mac", onRed: "card" },
  when: { every: "day", at: "07:00" },
  cards: "red",
  ...overrides,
});
const task = (overrides: Partial<JobSpec> = {}): JobSpec => ({
  name: "Open issues",
  words: "look over the open issues",
  kind: "task",
  when: { every: "week", day: "mon", at: "09:00" },
  cards: "red",
  ...overrides,
});

describe("a job's spec", () => {
  it("is held to the same words, scripts and ids on the Mac", async () => {
    const libPath = "../bridge/lib/jobs.mjs";
    const lib = (await import(libPath)) as { JOB_ID_RE: RegExp; CHECK_SCRIPT_RE: RegExp; APP_ID_RE: RegExp; DENIED_RE: RegExp };
    expect([lib.JOB_ID_RE, lib.CHECK_SCRIPT_RE, lib.APP_ID_RE, lib.DENIED_RE].map(String)).toEqual(
      [JOB_ID_PATTERN, CHECK_SCRIPT_PATTERN, APP_ID_PATTERN, DENIED].map(String),
    );
  });

  it("takes a check on an allowlisted script and a task on words", () => {
    expect(jobSpecSchema.safeParse(check()).success).toBe(true);
    expect(jobSpecSchema.safeParse(task()).success).toBe(true);
  });

  it("refuses any script outside the allowlist, and arguments", () => {
    for (const script of ["remote", "dev:web", "check:all", "test --all", "test;rm -rf ~", "db:migrate", "build"]) {
      expect(jobSpecSchema.safeParse(check({ check: { script, where: "mac", onRed: "card" } })).success, script).toBe(false);
    }
  });

  it("refuses the denied words in its name, words or script", () => {
    expect(jobSpecSchema.safeParse(check({ check: { script: "test:deploy", where: "mac", onRed: "card" } })).success).toBe(false);
    for (const words of ["merge the ready PRs", "deploy the notes app", "promote the build", "release notes", "publish the app", "sign-offs sweep"]) {
      expect(jobSpecSchema.safeParse(task({ words })).success, words).toBe(false);
    }
    expect(deniedWord("strange ring merger")).toBe("merger");
    expect(deniedWord("look over the open issues")).toBeNull();
    expect(deniedWord("emerge stronger")).toBeNull();
  });

  it("holds checks to hourly and tasks to every 4 hours", () => {
    expect(jobSpecSchema.safeParse(check({ when: { every: "hours", hours: 1, minute: 0 } })).success).toBe(true);
    expect(jobSpecSchema.safeParse(check({ when: { every: "hours", hours: 5, minute: 0 } })).success).toBe(false);
    expect(jobSpecSchema.safeParse(task({ when: { every: "hours", hours: 2, minute: 0 } })).success).toBe(false);
    expect(jobSpecSchema.safeParse(task({ when: { every: "hours", hours: 4, minute: 30 } })).success).toBe(true);
  });

  it("needs a script for a check, none for a task, and looks into red only on the Mac", () => {
    expect(jobSpecSchema.safeParse(check({ check: undefined })).success).toBe(false);
    expect(jobSpecSchema.safeParse(task({ check: { script: "test", where: "mac", onRed: "card" } })).success).toBe(false);
    expect(jobSpecSchema.safeParse(check({ check: { script: "test", where: "remote", onRed: "look" } as never })).success).toBe(false);
  });

  it("runs a script on the Mac only, and says so", () => {
    for (const script of ["test", "test:security", "typecheck", "validate:projects"]) {
      expect(jobSpecSchema.safeParse(check({ check: { script, where: "mac", onRed: "card" } })).success, script).toBe(true);
      expect(jobSpecSchema.safeParse(check({ check: { script, where: "remote", onRed: "card" } as never })).success, script).toBe(false);
    }
    expect(jobSpecSchema.parse(check({ check: { script: "test", onRed: "look" } as never })).check).toEqual({ script: "test", where: "mac", onRed: "look" });
    expect(checkWords({ script: "typecheck", where: "mac", onRed: "card" })).toBe("pnpm typecheck on the Mac");
  });

  it("takes an up check on an app id, from the Mac and cards only, and never a URL", () => {
    const parsed = jobSpecSchema.parse(check({ check: { probe: "up", app: "notes-app" } as never }));
    expect(parsed.check).toEqual({ probe: "up", app: "notes-app", where: "mac", onRed: "card" });
    expect(checkWords(parsed.check!)).toBe("whether notes-app is up, from the Mac");
    for (const bad of [
      { probe: "up", app: "notes-app", url: "https://example.com/healthz" },
      { probe: "up", app: "https://example.com" },
      { probe: "up", app: "notes-app", where: "remote" },
      { probe: "up", app: "notes-app", onRed: "look" },
      { probe: "up", app: "notes-app", script: "test" },
      { probe: "down", app: "notes-app" },
      { probe: "up", app: "Notes App" },
      { probe: "up", app: "deploy-check" },
    ])
      expect(jobSpecSchema.safeParse(check({ check: bad as never })).success, JSON.stringify(bad)).toBe(false);
  });

  it("refuses control characters and blank words", () => {
    expect(jobSpecSchema.safeParse(task({ words: "look\nover" })).success).toBe(false);
    expect(jobSpecSchema.safeParse(task({ words: "   " })).success).toBe(false);
  });
});

describe("a job's times", () => {
  it("reads as you say them and as the job's cron", () => {
    expect(whenWords({ every: "day", at: "07:00" })).toBe("Daily 7:00am");
    expect(whenWords({ every: "weekday", at: "18:30" })).toBe("Weekdays 6:30pm");
    expect(whenWords({ every: "week", day: "mon", at: "00:15" })).toBe("Mondays 12:15am");
    expect(whenWords({ every: "hours", hours: 4, minute: 5 })).toBe("Every 4 hours at :05");
    expect(jobCron({ every: "day", at: "07:00" })).toBe("0 7 * * *");
    expect(jobCron({ every: "weekday", at: "18:30" })).toBe("30 18 * * 1-5");
    expect(jobCron({ every: "week", day: "mon", at: "09:00" })).toBe("0 9 * * 1");
    expect(jobCron({ every: "hours", hours: 1, minute: 15 })).toBe("15 * * * *");
    expect(jobCron({ every: "hours", hours: 6, minute: 0 })).toBe("0 */6 * * *");
    expect(confirmLine(check())).toBe("New job · Daily 7:00am · Check notes app is up · Card only if red");
    expect(dayTimeWords(SAT_7AM)).toBe("Sat 24 Oct 7:00am");
  });

  it("works its run times out local time", () => {
    expect(nextRunTime({ every: "day", at: "07:00" }, SAT_7AM)?.toISOString()).toBe("2026-10-24T20:00:00.000Z");
    // Saturday: the next weekday run is Monday's.
    expect(nextRunTime({ every: "weekday", at: "07:00" }, SAT_7AM)?.toISOString()).toBe("2026-10-25T20:00:00.000Z");
    expect(nextRunTime({ every: "hours", hours: 6, minute: 0 }, SAT_7AM)?.toISOString()).toBe("2026-10-24T01:00:00.000Z");
    expect(lastRunTimes({ every: "day", at: "07:00" }, SAT_7AM, 2).map((at) => at.toISOString())).toEqual(["2026-10-23T20:00:00.000Z", "2026-10-22T20:00:00.000Z"]);
    expect(runTimes({ every: "hours", hours: 1, minute: 0 }, SAT_7AM, new Date(SAT_7AM.getTime() + 3 * HOUR))).toHaveLength(3);
  });

  it("runs no time the clocks skip, and each time once, as daylight saving starts and ends", () => {
    const iso = (times: Date[]) => times.map((at) => at.toISOString());
    setTimeZone("Pacific/Auckland");
    try {
      // Sun 27 Sep 2026: 2:00am NZST goes to 3:00am NZDT, so there is no 2:30am.
      const hourly = { every: "hours", hours: 1, minute: 30 } as const;
      expect(iso(runTimes(hourly, new Date("2026-09-26T12:00:00.000Z"), new Date("2026-09-26T17:00:00.000Z")))).toEqual([
        "2026-09-26T12:30:00.000Z",
        "2026-09-26T13:30:00.000Z",
        "2026-09-26T14:30:00.000Z",
        "2026-09-26T15:30:00.000Z",
        "2026-09-26T16:30:00.000Z",
      ]);
      expect(runTimes({ every: "day", at: "02:30" }, new Date("2026-09-26T00:00:00.000Z"), new Date("2026-09-27T00:00:00.000Z"))).toEqual([]);
      // Sun 4 Apr 2027: 3:00am NZDT goes back to 2:00am NZST; 2:30am is one run.
      const back = iso(runTimes(hourly, new Date("2027-04-03T11:00:00.000Z"), new Date("2027-04-03T18:00:00.000Z")));
      expect(back).toHaveLength(6);
      expect(new Set(back).size).toBe(6);
      expect([...back].sort()).toEqual(back);
    } finally {
      setTimeZone(undefined);
    }
  });
});

describe("JobsStore", () => {
  let dir: string;
  let store: JobsStore;
  let owned: Set<string>;
  let seq = 0;
  const runId = () => `run-${(seq += 1)}-abcdefgh`;
  const start = (job: string, at: Date, extra: Partial<RunReport> = {}) => store.start(job, { run: runId(), state: "start", ...extra }, at);
  const finish = (job: string, run: string, state: "green" | "red" | "skipped", at: Date, line?: string) => store.finish(job, { run, state, ...(line ? { line } : {}) }, at);
  /** A whole run: started and finished at `at`. */
  const ran = (job: string, state: "green" | "red", at: Date, line?: string) => {
    const begun = start(job, at);
    if (!begun?.go) throw new Error("did not start");
    return finish(job, begun.run, state, at, line).outcome!;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rivet-jobs-"));
    owned = new Set();
    store = new JobsStore(dir, (key) => owned.has(key));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("holds 10 active jobs and no two of a name", () => {
    for (let n = 0; n < 10; n += 1) expect(store.create(`j-0000000${n}`, check({ name: `job ${n}` }), SAT_7AM).ok).toBe(true);
    expect(store.create("j-000000aa", check({ name: "one more" }), SAT_7AM)).toEqual({ ok: false, reason: "10 jobs are on already: pause or delete one first" });
    expect(store.setState("j-00000000", "paused", SAT_7AM).ok).toBe(true);
    expect(store.create("j-000000aa", check({ name: "job 1" }), SAT_7AM).ok).toBe(false);
    expect(store.create("j-000000aa", check({ name: "one more" }), SAT_7AM).ok).toBe(true);
    expect(store.setState("j-00000000", "active", SAT_7AM).ok).toBe(false);
  });

  it("cards the first red run once, then says back to green", () => {
    store.create("j-aaaaaaaa", check(), SAT_7AM);
    const first = ran("j-aaaaaaaa", "red", SAT_7AM, "2 of 9 sims out of range");
    expect(first.fresh).toHaveLength(1);
    expect(first.fresh[0]).toMatchObject({ kind: "decision", title: "Notes app up is red", schedule: "job-j-aaaaaaaa", options: [{ label: "Fix it" }, { label: "Leave it" }] });
    expect(first.fresh[0]!.id.startsWith("schedule-job-")).toBe(true);
    expect(first.notes).toEqual([]);
    const failing = store.failing();
    expect(failing).toHaveLength(1);
    expect(failing[0]!.detail).toContain("rivet fix schedule job-j-aaaaaaaa");
    const second = ran("j-aaaaaaaa", "red", new Date(SAT_7AM.getTime() + 24 * HOUR));
    expect(second).toEqual({ fresh: [], notes: [] });
    // The card keeps its id through the streak.
    expect(store.failing()[0]!.need.id).toBe(first.fresh[0]!.id);
    expect(store.failing()[0]!.need.ask).toContain("Red 2 runs in a row.");
    const green = ran("j-aaaaaaaa", "green", new Date(SAT_7AM.getTime() + 48 * HOUR), "all 9 in range");
    expect(green.fresh).toEqual([]);
    expect(green.notes).toEqual([expect.objectContaining({ title: "Notes app up is back to green" })]);
    expect(store.failing()).toEqual([]);
    expect(ran("j-aaaaaaaa", "green", new Date(SAT_7AM.getTime() + 72 * HOUR))).toEqual({ fresh: [], notes: [] });
    // A new streak is a new card.
    const again = ran("j-aaaaaaaa", "red", new Date(SAT_7AM.getTime() + 96 * HOUR));
    expect(again.fresh).toHaveLength(1);
    expect(again.fresh[0]!.id).not.toBe(first.fresh[0]!.id);
  });

  it("sends a Seen update after every run on the every-run rule, a card only when red", () => {
    store.create("j-bbbbbbbb", check({ cards: "every" }), SAT_7AM);
    expect(ran("j-bbbbbbbb", "green", SAT_7AM).notes).toEqual([expect.objectContaining({ title: "Notes app up: green" })]);
    const red = ran("j-bbbbbbbb", "red", new Date(SAT_7AM.getTime() + 24 * HOUR));
    expect(red.fresh).toHaveLength(1);
    expect(red.notes).toEqual([]);
    expect(ran("j-bbbbbbbb", "red", new Date(SAT_7AM.getTime() + 48 * HOUR)).notes).toEqual([expect.objectContaining({ title: "Notes app up: still red" })]);
  });

  it("keeps an answered card off until a green run, and files none while someone is on it", () => {
    store.create("j-cccccccc", check(), SAT_7AM);
    const red = ran("j-cccccccc", "red", SAT_7AM);
    store.answer("j-cccccccc", red.fresh[0]!.id, SAT_7AM);
    expect(store.failing()[0]!.answered).toBe(true);
    expect(ran("j-cccccccc", "red", new Date(SAT_7AM.getTime() + 24 * HOUR)).fresh).toEqual([]);
    ran("j-cccccccc", "green", new Date(SAT_7AM.getTime() + 48 * HOUR));
    owned.add("job-j-cccccccc");
    expect(ran("j-cccccccc", "red", new Date(SAT_7AM.getTime() + 72 * HOUR)).fresh).toEqual([]);
    expect(store.failing()[0]!.owned).toBe(true);
    expect(store.list(SAT_7AM).jobs[0]!.owned).toBe(true);
  });

  it("skips a task over the day's 6 runs or while usage is high or unknown, never queueing it", () => {
    store.create("j-dddddddd", task({ when: { every: "hours", hours: 4, minute: 0 } }), SAT_7AM);
    expect(start("j-dddddddd", SAT_7AM)).toEqual({ go: false, note: "Claude usage not known" });
    expect(start("j-dddddddd", SAT_7AM, { usage: 85 })).toEqual({ go: false, note: "usage high" });
    for (let n = 0; n < 6; n += 1) {
      const at = new Date(SAT_7AM.getTime() + n * HOUR);
      const begun = start("j-dddddddd", at, { usage: 40 });
      expect(begun?.go, `run ${n}`).toBe(true);
      if (begun?.go) store.report("j-dddddddd", begun.run, "green", "nothing new", undefined, at);
    }
    expect(start("j-dddddddd", new Date(SAT_7AM.getTime() + 7 * HOUR), { usage: 40 })).toEqual({ go: false, note: "6 task runs today already" });
    const skipped = store.list(SAT_7AM).jobs[0]!.runs.filter((run) => run.result === "skipped");
    expect(skipped.map((run) => run.line)).toEqual(["skipped: 6 task runs today already", "skipped: usage high", "skipped: Claude usage not known"]);
    // The next local day starts again.
    expect(start("j-dddddddd", new Date(SAT_7AM.getTime() + 20 * HOUR), { usage: 40 })?.go).toBe(true);
  });

  it("starts a task's run once, with its name and words for the chat, and never joins another launch to it", () => {
    store.create("j-eeeeeeee", task(), SAT_7AM);
    const first = start("j-eeeeeeee", SAT_7AM, { usage: 10, manual: true });
    expect(first).toMatchObject({ go: true, job: { id: "j-eeeeeeee", kind: "task", name: task().name, words: task().words } });
    const minute = new Date(SAT_7AM.getTime() + 60_000);
    expect(start("j-eeeeeeee", minute, { usage: 10, manual: true })).toEqual({ go: false, note: "the last run is still going" });
    expect(start("j-eeeeeeee", minute, { usage: 10 })).toEqual({ go: false, note: "the last run is still going" });
    if (first?.go) expect(store.start("j-eeeeeeee", { run: first.run, state: "start", usage: 10 }, minute)).toEqual({ go: false, note: "that run has started already" });
    expect(store.tasksToday(SAT_7AM)).toBe(1);
    expect(store.isRunning("j-eeeeeeee")).toBe(true);
  });

  it("refuses a paused job's run and skips a check whose last run is still going", () => {
    store.create("j-ffffffff", check(), SAT_7AM);
    expect(start("j-ffffffff", SAT_7AM)?.go).toBe(true);
    expect(start("j-ffffffff", SAT_7AM)).toEqual({ go: false, note: "the last run is still going" });
    store.setState("j-ffffffff", "paused", SAT_7AM);
    expect(start("j-ffffffff", SAT_7AM)).toEqual({ go: false, note: "paused" });
    expect(start("j-00000000", SAT_7AM)).toBeNull();
  });

  it("counts a run time with no run by the next one as missed, which is red", () => {
    store.create("j-gggggggg", check(), new Date(SAT_7AM.getTime() - 30 * 60_000));
    // Saturday's 7am ran green; nothing ran on Sunday.
    ran("j-gggggggg", "green", SAT_7AM);
    expect(store.sweep(new Date(SAT_7AM.getTime() + 23 * HOUR)).fresh).toEqual([]);
    expect(store.sweep(new Date(SAT_7AM.getTime() + 25 * HOUR)).fresh).toEqual([]);
    const missed = store.sweep(new Date(SAT_7AM.getTime() + 48 * HOUR));
    expect(missed.fresh).toHaveLength(1);
    expect(missed.fresh[0]!.ask).toContain("did not run at Sun 25 Oct 7:00am");
    // Once.
    expect(store.sweep(new Date(SAT_7AM.getTime() + 48 * HOUR + 60_000))).toEqual({ fresh: [], notes: [] });
    expect(store.list(SAT_7AM).jobs[0]!.redStreak).toBe(1);
  });

  it("counts a run that never reported by its next run time as missed", () => {
    store.create("j-hhhhhhhh", task({ when: { every: "day", at: "07:00" } }), new Date(SAT_7AM.getTime() - HOUR));
    const begun = start("j-hhhhhhhh", SAT_7AM, { usage: 10 });
    expect(begun?.go).toBe(true);
    expect(store.sweep(new Date(SAT_7AM.getTime() + 23 * HOUR)).fresh).toEqual([]);
    const missed = store.sweep(new Date(SAT_7AM.getTime() + 24 * HOUR));
    expect(missed.fresh).toHaveLength(1);
    expect(missed.fresh[0]!.ask).toContain("never reported");
    if (begun?.go) expect(store.finish("j-hhhhhhhh", { run: begun.run, state: "green" }, new Date(SAT_7AM.getTime() + 25 * HOUR)).status).toBe(409);
  });

  it("never sweeps a paused job, nor a run time from before it was made or resumed", () => {
    store.create("j-iiiiiiii", check(), new Date(SAT_7AM.getTime() + HOUR));
    expect(store.sweep(new Date(SAT_7AM.getTime() + 24 * HOUR + 60_000))).toEqual({ fresh: [], notes: [] });
    store.setState("j-iiiiiiii", "paused", SAT_7AM);
    expect(store.sweep(new Date(SAT_7AM.getTime() + 72 * HOUR))).toEqual({ fresh: [], notes: [] });
    store.setState("j-iiiiiiii", "active", new Date(SAT_7AM.getTime() + 72 * HOUR));
    expect(store.sweep(new Date(SAT_7AM.getTime() + 73 * HOUR))).toEqual({ fresh: [], notes: [] });
  });

  it("puts a looked-into red check's cause on its own red run, once, whatever ran since", () => {
    store.create("j-jjjjjjjj", check({ check: { script: "validate:notes", where: "mac", onRed: "look" }, when: { every: "hours", hours: 1, minute: 0 } }), SAT_7AM);
    const red = start("j-jjjjjjjj", SAT_7AM);
    if (!red?.go) throw new Error("did not start");
    finish("j-jjjjjjjj", red.run, "red", SAT_7AM, "3 tests failed");
    expect(store.report("j-jjjjjjjj", red.run, "red", "a cause", undefined, SAT_7AM).status).toBe(409);
    expect(store.look("j-jjjjjjjj", { run: red.run, state: "look", usage: 10 }, SAT_7AM)?.go).toBe(true);
    // Run now starts another check while the chat looks.
    const next = start("j-jjjjjjjj", SAT_7AM);
    if (!next?.go) throw new Error("did not start");
    expect(store.report("j-jjjjjjjj", red.run, "red", "the fixture moved", undefined, SAT_7AM).status).toBe(200);
    expect(store.report("j-jjjjjjjj", red.run, "red", "again", undefined, SAT_7AM).status).toBe(409);
    expect(store.report("j-jjjjjjjj", next.run, "red", "not the chat's run", undefined, SAT_7AM).status).toBe(409);
    expect(finish("j-jjjjjjjj", next.run, "green", SAT_7AM).status).toBe(200);
    expect(store.list(SAT_7AM).jobs[0]!.runs.map((run) => [run.result, run.line])).toEqual([["green", undefined], ["red", "the fixture moved"]]);
  });

  it("finishes only the task run a report names, and a replay of it is refused", () => {
    store.create("j-rrrrrrrr", task({ when: { every: "hours", hours: 4, minute: 0 } }), SAT_7AM);
    const a = start("j-rrrrrrrr", SAT_7AM, { usage: 10 });
    if (!a?.go) throw new Error("did not start");
    expect(store.report("j-rrrrrrrr", a.run, "green", "fine", undefined, SAT_7AM).status).toBe(200);
    const b = start("j-rrrrrrrr", new Date(SAT_7AM.getTime() + 4 * HOUR), { usage: 10 });
    if (!b?.go) throw new Error("did not start");
    expect(store.report("j-rrrrrrrr", a.run, "green", "fine", undefined, new Date(SAT_7AM.getTime() + 4 * HOUR)).status).toBe(409);
    expect(store.report("j-rrrrrrrr", "run-nope-abcdefgh", "green", "fine", undefined, SAT_7AM).status).toBe(404);
    expect(store.list(SAT_7AM).jobs[0]!.lastRun?.result).toBe("running");
  });

  it("opens a look check's chat only for a red run, once, inside the day's task runs and usage, and counts it", () => {
    const LOOK = { script: "validate:notes", where: "mac", onRed: "look" } as const;
    store.create("j-llllllll", check({ check: LOOK, when: { every: "hours", hours: 1, minute: 0 } }), SAT_7AM);
    store.create("j-mmmmmmmm", check({ name: "Card only", check: { ...LOOK, onRed: "card" } }), SAT_7AM);
    const look = (job: string, run: string, usage: number | null) => store.look(job, { run, state: "look", usage }, SAT_7AM);
    const green = start("j-llllllll", SAT_7AM);
    if (!green?.go) throw new Error("did not start");
    finish("j-llllllll", green.run, "green", SAT_7AM);
    expect(look("j-llllllll", green.run, 10)).toEqual({ go: false, note: "that run is not red" });
    const red = start("j-llllllll", SAT_7AM);
    if (!red?.go) throw new Error("did not start");
    finish("j-llllllll", red.run, "red", SAT_7AM, "boom");
    expect(look("j-llllllll", red.run, null)).toEqual({ go: false, note: "Claude usage not known" });
    expect(look("j-llllllll", red.run, 90)).toEqual({ go: false, note: "usage high" });
    expect(look("j-llllllll", red.run, 10)?.go).toBe(true);
    expect(look("j-llllllll", red.run, 10)).toEqual({ go: false, note: "a chat looked into that run already" });
    expect(store.tasksToday(SAT_7AM)).toBe(1);
    const card = start("j-mmmmmmmm", SAT_7AM);
    if (!card?.go) throw new Error("did not start");
    finish("j-mmmmmmmm", card.run, "red", SAT_7AM);
    expect(look("j-mmmmmmmm", card.run, 10)).toEqual({ go: false, note: "its red is only carded" });
    for (let n = 1; n < 6; n += 1) {
      const again = start("j-llllllll", SAT_7AM);
      if (!again?.go) throw new Error("did not start");
      finish("j-llllllll", again.run, "red", SAT_7AM);
      expect(look("j-llllllll", again.run, 10)?.go, `look ${n}`).toBe(true);
    }
    const seventh = start("j-llllllll", SAT_7AM);
    if (!seventh?.go) throw new Error("did not start");
    finish("j-llllllll", seventh.run, "red", SAT_7AM);
    expect(look("j-llllllll", seventh.run, 10)).toEqual({ go: false, note: "6 task runs today already" });
  });

  it("a red after a green in the same millisecond is the newer run, whatever the runner named them", () => {
    store.create("j-tttttttt", check(), SAT_7AM);
    const green = store.start("j-tttttttt", { run: "run-zzzzzzzz", state: "start" }, SAT_7AM);
    if (!green?.go) throw new Error("did not start");
    finish("j-tttttttt", green.run, "green", SAT_7AM);
    const red = store.start("j-tttttttt", { run: "run-aaaaaaaa", state: "start" }, SAT_7AM);
    if (!red?.go) throw new Error("did not start");
    expect(finish("j-tttttttt", red.run, "red", SAT_7AM, "boom").outcome?.fresh).toHaveLength(1);
    expect(store.list(SAT_7AM).jobs[0]!.redStreak).toBe(1);
  });

  it("keeps a red streak and its card through any number of skips, and merges a run of the same skip", () => {
    store.create("j-ssssssss", task({ when: { every: "hours", hours: 4, minute: 0 } }), SAT_7AM);
    const red = start("j-ssssssss", SAT_7AM, { usage: 10 });
    if (!red?.go) throw new Error("did not start");
    expect(store.report("j-ssssssss", red.run, "red", "two issues need you", undefined, SAT_7AM).outcome?.fresh).toHaveLength(1);
    for (let n = 1; n <= 60; n += 1) expect(start("j-ssssssss", new Date(SAT_7AM.getTime() + n * 1000), { usage: 90 })).toEqual({ go: false, note: "usage high" });
    start("j-ssssssss", new Date(SAT_7AM.getTime() + 61_000));
    const job = store.list(SAT_7AM).jobs[0]!;
    expect(job.redStreak).toBe(1);
    expect(job.runs.map((run) => run.line)).toEqual(["skipped: Claude usage not known", "skipped: usage high", "two issues need you"]);
    expect(store.failing()).toHaveLength(1);
  });

  it("counts a merged run of the same skip for every run time it stands for, so none of them is a missed run", () => {
    store.create("j-sksksksk", task({ when: { every: "hours", hours: 4, minute: 0 } }), SAT_7AM);
    const eight = new Date(SAT_7AM.getTime() + HOUR);
    for (const at of [eight, new Date(eight.getTime() + 4 * HOUR), new Date(eight.getTime() + 8 * HOUR)]) {
      expect(start("j-sksksksk", at, { usage: 90 })).toEqual({ go: false, note: "usage high" });
      expect(store.sweep(new Date(at.getTime() + 60_000)).fresh).toEqual([]);
    }
    const job = store.list(new Date(eight.getTime() + 8 * HOUR + 60_000)).jobs[0]!;
    expect(job.runs.map((run) => [run.result, run.at, run.finishedAt])).toEqual([["skipped", eight.toISOString(), new Date(eight.getTime() + 8 * HOUR).toISOString()]]);
    expect(job.redStreak).toBe(0);
    // A run time after the skips with nothing for it is still missed.
    expect(store.sweep(new Date(eight.getTime() + 16 * HOUR + 60_000)).fresh).toHaveLength(1);
  });

  it("keeps a merged skip longer than the 30 days runs are kept for, so none of its run times turns into a missed run", () => {
    store.create("j-sklongsk", task({ when: { every: "hours", hours: 4, minute: 0 } }), SAT_7AM);
    const eight = new Date(SAT_7AM.getTime() + HOUR);
    const times = 35 * 6;
    for (let n = 0; n < times; n += 1) {
      const at = new Date(eight.getTime() + n * 4 * HOUR);
      expect(start("j-sklongsk", at, { usage: 90 })).toEqual({ go: false, note: "usage high" });
      expect(store.sweep(new Date(at.getTime() + 60_000)).fresh).toEqual([]);
    }
    const last = new Date(eight.getTime() + (times - 1) * 4 * HOUR);
    const job = store.list(new Date(last.getTime() + 60_000)).jobs[0]!;
    expect(job.runs.map((run) => [run.result, run.at, run.finishedAt])).toEqual([["skipped", eight.toISOString(), last.toISOString()]]);
  });

  it("counts only the task runs that started today, never a run time the Mac slept through", () => {
    // Six tasks every 4 hours, set before midnight; the Mac sleeps from 11pm Saturday to 4:01am Sunday.
    const evening = new Date("2026-10-24T11:00:00.000Z");
    for (let n = 0; n < 6; n += 1) store.create(`j-t000000${n}`, task({ name: `task ${n}`, when: { every: "hours", hours: 4, minute: 0 } }), evening);
    const woke = new Date("2026-10-24T17:01:00.000Z");
    expect(store.sweep(woke).fresh).toHaveLength(6);
    expect(store.tasksToday(woke)).toBe(0);
    expect(store.list(woke).limits.tasksToday).toBe(0);
    const begun = start("j-t0000000", woke, { usage: 10 });
    expect(begun?.go).toBe(true);
    // A started run that never reported still counts.
    store.sweep(new Date(woke.getTime() + 4 * HOUR));
    expect(store.tasksToday(new Date(woke.getTime() + 4 * HOUR))).toBe(1);
  });

  it("keeps a job being deleted, holding its place and running nothing, and puts it back as it was when the Mac fails", () => {
    for (let n = 0; n < 10; n += 1) store.create(`j-0000000${n}`, check({ name: `job ${n}` }), SAT_7AM);
    store.setState("j-00000001", "paused", SAT_7AM);
    const going = start("j-00000000", SAT_7AM);
    store.markRemoving("j-00000000");
    store.markRemoving("j-00000001");
    expect(store.create("j-000000aa", check({ name: "one more" }), SAT_7AM).ok).toBe(true);
    expect(store.create("j-000000bb", check({ name: "two more" }), SAT_7AM).ok).toBe(false);
    expect(start("j-00000000", SAT_7AM)).toEqual({ go: false, note: "it is being deleted" });
    if (going?.go) expect(finish("j-00000000", going.run, "green", SAT_7AM)).toMatchObject({ status: 409, error: "it is being deleted" });
    expect(store.setState("j-00000000", "paused", SAT_7AM)).toEqual({ ok: false, reason: "it is being deleted" });
    store.unremove("j-00000000", "Delete did not go through: the Mac refused it. Try again.");
    store.unremove("j-00000001", "no");
    const [zero, one] = store.list(SAT_7AM).jobs;
    expect([zero!.state, zero!.note, one!.state]).toEqual(["active", "Delete did not go through: the Mac refused it. Try again.", "paused"]);
    expect(store.activeCount()).toBe(10);
  });

  it("finds the streak past skipped and running runs", () => {
    const at = SAT_7AM.toISOString();
    expect(redStreak([{ id: "a", at, result: "running" }, { id: "b", at, result: "skipped" }, { id: "c", at, result: "missed" }, { id: "d", at, result: "red" }, { id: "e", at, result: "green" }, { id: "f", at, result: "red" }]).map((run) => run.id)).toEqual(["c", "d"]);
  });
});

describe("SchedulesStore with jobs", () => {
  it("lists a red job's card with the failing schedules, and takes its answer", () => {
    const dir = mkdtempSync(join(tmpdir(), "rivet-jobs-"));
    const schedules = new SchedulesStore(dir);
    try {
      schedules.jobs.create("j-kkkkkkkk", check(), SAT_7AM);
      const begun = schedules.jobs.start("j-kkkkkkkk", { run: "run-kkkkkkkk", state: "start" }, SAT_7AM);
      expect(begun?.go).toBe(true);
      schedules.jobs.finish("j-kkkkkkkk", { run: "run-kkkkkkkk", state: "red" }, SAT_7AM);
      const failing = schedules.failing(SAT_7AM);
      expect(failing.map((one) => one.scheduleId)).toEqual(["job-j-kkkkkkkk"]);
      schedules.answer(failing[0]!, SAT_7AM);
      expect(schedules.failing(SAT_7AM)[0]!.answered).toBe(true);
    } finally {
      schedules.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a run's report", () => {
  beforeAll(() => setKnownRepos(["example-org/example-repo"]));
  afterAll(() => setKnownRepos([]));

  it("links only to this repository on github.com, so a chat cannot send what it read elsewhere", () => {
    const report = { run: "RUN_AAAA1", state: "red" as const, line: "red" };
    expect(runReportSchema.safeParse({ ...report, url: "https://github.com/example-org/example-repo/pull/387" }).success).toBe(true);
    for (const url of ["https://collector.example/x?secret=1", "https://github.com/other/repo/pull/1", "https://github.com.evil.example/example-org/example-repo/", "http://github.com/example-org/example-repo/pull/1", "https://github.com/example-org/example-repo/../../login/oauth/authorize?client_id=x&state=y", "https://github.com/example-org/example-repo/../../cli/cli/issues/1", "https://github.com/example-org/example-repo/%2e%2e/%2e%2e/cli/cli", "https://user" + "@github.com/example-org/example-repo/pull/1", "https://github.com:8443/example-org/example-repo/pull/1"])
      expect(runReportSchema.safeParse({ ...report, url }).success, url).toBe(false);
  });
});
