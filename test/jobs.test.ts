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
  MAX_TASK_RUNS_A_DAY,
  nextRunTime,
  OVERNIGHT_OFF_NOTE,
  PLANS_PATH,
  runTimes,
  dayTimeWords,
  taskReportSchema,
  whenWords,
  type JobSpec,
  type RunReport,
} from "../src/shared/jobs.js";
import { setKnownRepos } from "../src/shared/repos.js";
import { setTimeZone } from "../src/shared/when.js";

// 7:00am Saturday 24 Oct 2026 in the fixed test zone (vitest.setup.ts).
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
      // Sun 27 Sep 2026: 2:00am standard time goes to 3:00am daylight time, so there is no 2:30am.
      const hourly = { every: "hours", hours: 1, minute: 30 } as const;
      expect(iso(runTimes(hourly, new Date("2026-09-26T12:00:00.000Z"), new Date("2026-09-26T17:00:00.000Z")))).toEqual([
        "2026-09-26T12:30:00.000Z",
        "2026-09-26T13:30:00.000Z",
        "2026-09-26T14:30:00.000Z",
        "2026-09-26T15:30:00.000Z",
        "2026-09-26T16:30:00.000Z",
      ]);
      expect(runTimes({ every: "day", at: "02:30" }, new Date("2026-09-26T00:00:00.000Z"), new Date("2026-09-27T00:00:00.000Z"))).toEqual([]);
      // Sun 4 Apr 2027: 3:00am daylight time goes back to 2:00am standard time; 2:30am is one run.
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

  it("starts a task, and its Run now, with no usage reported: Rivet reads no Claude usage", () => {
    store.create("j-uuuuuuuu", task({ when: { every: "hours", hours: 4, minute: 0 } }), SAT_7AM);
    const begun = start("j-uuuuuuuu", SAT_7AM);
    expect(begun?.go).toBe(true);
    if (begun?.go) store.report("j-uuuuuuuu", begun.run, "green", "nothing new", undefined, SAT_7AM);
    expect(start("j-uuuuuuuu", new Date(SAT_7AM.getTime() + HOUR), { manual: true })?.go).toBe(true);
  });

  it("skips a task over the day's 6 runs or while its reported usage is high, never queueing it", () => {
    store.create("j-dddddddd", task({ when: { every: "hours", hours: 4, minute: 0 } }), SAT_7AM);
    expect(start("j-dddddddd", SAT_7AM, { usage: 85 })).toEqual({ go: false, note: "usage high" });
    for (let n = 0; n < 6; n += 1) {
      const at = new Date(SAT_7AM.getTime() + n * HOUR);
      const begun = start("j-dddddddd", at, { usage: 40 });
      expect(begun?.go, `run ${n}`).toBe(true);
      if (begun?.go) store.report("j-dddddddd", begun.run, "green", "nothing new", undefined, at);
    }
    expect(start("j-dddddddd", new Date(SAT_7AM.getTime() + 7 * HOUR), { usage: 40 })).toEqual({ go: false, note: "6 task runs today already" });
    const skipped = store.list(SAT_7AM).jobs[0]!.runs.filter((run) => run.result === "skipped");
    expect(skipped.map((run) => run.line)).toEqual(["skipped: 6 task runs today already", "skipped: usage high"]);
    // The next local day starts again.
    expect(start("j-dddddddd", new Date(SAT_7AM.getTime() + 20 * HOUR), { usage: 40 })?.go).toBe(true);
  });

  it("cards a task that stopped on its plan's limit as the question of using the other plan, and only a red keeps it", () => {
    store.create("j-llllllll", task(), SAT_7AM);
    const begun = start("j-llllllll", SAT_7AM, { usage: 10 });
    if (!begun?.go) throw new Error("no start");
    const limit = taskReportSchema.parse({ run: begun.run, state: "red", line: "Claude is at its limit until 3 pm. Use ChatGPT for this job?", limit: { plan: "claude", until: "3 pm" } }).limit;
    const done = store.report("j-llllllll", begun.run, "red", "Claude is at its limit until 3 pm. Use ChatGPT for this job?", undefined, SAT_7AM, limit);
    expect(done.outcome?.fresh).toEqual([
      expect.objectContaining({
        kind: "decision",
        title: `${task().name}: Claude is at its limit`,
        ask: "Claude is at its limit until 3 pm. Use ChatGPT for this job?",
        schedule: "job-j-llllllll",
        options: [expect.objectContaining({ label: "Use ChatGPT" }), expect.objectContaining({ label: "Wait for Claude" })],
      }),
    ]);
    // No https origin given: no link to a Plans page.
    expect(done.outcome?.fresh[0]).not.toHaveProperty("links");
    expect(store.list(SAT_7AM).jobs[0]!.lastRun).toMatchObject({ result: "red", limit: { plan: "claude", until: "3 pm" } });
    expect(store.failing()[0]!.detail).toContain("Nothing switched without asking");
    expect(store.failing()[0]!.detail).toContain("ChatGPT is connected");
    // Only the switch answer on this job's card asks for a run, once, on the other plan.
    expect(store.planSwitch("job-j-llllllll", "Use ChatGPT")).toEqual({ id: "j-llllllll", plan: "chatgpt" });
    expect(store.planSwitch("job-j-llllllll", "Wait for Claude")).toBeNull();
    expect(store.planSwitch("job-j-llllllll", undefined)).toBeNull();
    expect(store.planSwitch("job-j-llllllll", "Use Claude")).toBeNull();
    expect(store.planSwitch("job-j-zzzzzzzz", "Use ChatGPT")).toBeNull();
    // The next red is an ordinary one, and the card says so; its answers start nothing on another plan.
    const day = new Date(SAT_7AM.getTime() + 24 * HOUR);
    const next = start("j-llllllll", day, { usage: 10 });
    if (!next?.go) throw new Error("no start");
    store.report("j-llllllll", next.run, "red", "it failed", undefined, day);
    expect(store.failing()[0]!.need).toMatchObject({ title: `${task().name} is red`, options: [{ label: "Fix it" }, { label: "Leave it" }] });
    expect(JSON.stringify(store.failing()[0]!.need)).not.toMatch(/Use ChatGPT/);
    expect(store.planSwitch("job-j-llllllll", "Use ChatGPT")).toBeNull();

    store.create("j-mmmmmmmm", task({ name: "Other task" }), SAT_7AM);
    const green = start("j-mmmmmmmm", SAT_7AM, { usage: 10 });
    if (!green?.go) throw new Error("no start");
    store.report("j-mmmmmmmm", green.run, "green", "fine", undefined, SAT_7AM, { plan: "chatgpt" });
    expect(store.list(SAT_7AM).jobs.find((job) => job.id === "j-mmmmmmmm")!.lastRun).not.toHaveProperty("limit");

    expect(taskReportSchema.safeParse({ run: begun.run, state: "red", line: "x", limit: { plan: "gemini" } }).success).toBe(false);
    expect(taskReportSchema.safeParse({ run: begun.run, state: "red", line: "x", limit: { plan: "claude", extra: 1 } }).success).toBe(false);
  });

  it("keeps Fix it for a real failure when a limit run joins its streak; the limit card is only for a streak of limits", () => {
    const LIMIT_LINE = "Claude is at its limit until 3 pm. Use ChatGPT for this job?";
    store.create("j-ssssssss", task(), SAT_7AM);
    const failed = start("j-ssssssss", SAT_7AM, { usage: 10 });
    if (!failed?.go) throw new Error("no start");
    store.report("j-ssssssss", failed.run, "red", "issue 12 is stale", "https://github.com/o/r/actions/runs/1", SAT_7AM);
    const day = new Date(SAT_7AM.getTime() + 24 * HOUR);
    const limited = start("j-ssssssss", day, { usage: 10 });
    if (!limited?.go) throw new Error("no start");
    store.report("j-ssssssss", limited.run, "red", LIMIT_LINE, undefined, day, { plan: "claude", until: "3 pm" });
    const red = store.failing()[0]!;
    expect(red.need).toMatchObject({ title: `${task().name} is red`, options: [{ label: "Fix it" }, { label: "Leave it" }], links: [{ url: "https://github.com/o/r/actions/runs/1" }] });
    expect(red.need.ask).toMatch(/^issue 12 is stale \(.+\)\. Red 2 runs in a row\. Its newest run did not run: Claude is at its limit until 3 pm\.$/);
    expect(JSON.stringify(red.need)).not.toMatch(/Use ChatGPT/);
    expect(red.detail).toContain("issue 12 is stale");
    expect(red.detail).toContain("Its newest run did not run: Claude is at its limit until 3 pm.");
    expect(red.url).toBe("https://github.com/o/r/actions/runs/1");

    store.create("j-tttttttt", task({ name: "Limits only" }), SAT_7AM);
    for (const at of [SAT_7AM, day]) {
      const run = start("j-tttttttt", at, { usage: 10 });
      if (!run?.go) throw new Error("no start");
      store.report("j-tttttttt", run.run, "red", LIMIT_LINE, undefined, at, { plan: "claude", until: "3 pm" });
    }
    expect(store.failing().find((one) => one.scheduleId === "job-j-tttttttt")!.need).toMatchObject({ title: "Limits only: Claude is at its limit", ask: LIMIT_LINE, options: [{ label: "Use ChatGPT" }, { label: "Wait for Claude" }] });
  });

  it("keeps a real red check's Fix it when its look hits a limit, and asks to use the other plan only when that one is connected", () => {
    const LOOK = { check: { script: "memory:lint", where: "mac", onRed: "look" } } as const;
    const looked = (id: string, limit: { plan: "claude"; until: string; connected: boolean; first?: "claude" | "chatgpt" }) => {
      store.create(id, check({ ...LOOK, name: `Lint ${id}` }), SAT_7AM);
      const red = start(id, SAT_7AM);
      if (!red?.go) throw new Error("did not start");
      finish(id, red.run, "red", SAT_7AM, "3 tests failed.");
      expect(store.look(id, { run: red.run, state: "look", usage: 10 }, SAT_7AM)?.go).toBe(true);
      const line = "3 tests failed. The check didn't run: Claude is at its limit until 3 pm.";
      expect(store.report(id, red.run, "red", line, undefined, SAT_7AM, taskReportSchema.parse({ run: red.run, state: "red", line, limit }).limit).status).toBe(200);
      const run = store.list(SAT_7AM).jobs.find((job) => job.id === id)!.lastRun!;
      // The check ran and failed: the limit is its look's, never the check run's own, and the line stays the check's.
      expect(run).toMatchObject({ result: "red", line: "3 tests failed.", lookLimit: limit });
      expect(run).not.toHaveProperty("limit");
      return store.failing().find((one) => one.scheduleId === `job-${id}`)!;
    };
    const asks = looked("j-kkkkkkkk", { plan: "claude", until: "3 pm", connected: true, first: "claude" });
    expect(asks.need).toMatchObject({
      title: "Lint j-kkkkkkkk is red",
      options: [{ label: "Use ChatGPT" }, { label: "Fix it", detail: "The fix chat starts on ChatGPT." }, { label: "Wait for Claude" }],
    });
    expect(asks.need.ask).toBe(`3 tests failed (${dayTimeWords(SAT_7AM)}). The check didn't run: Claude is at its limit until 3 pm. Use ChatGPT for this job?`);
    expect(asks.detail).toContain("To fix it: rivet fix schedule job-j-kkkkkkkk");
    expect(asks.detail, "the fix chat it starts is on the plan that is not at its limit").toContain("Start its fix chat on ChatGPT.");
    // ChatGPT goes first and Claude hit the limit: a fix chat starts on ChatGPT anyway, the plan that goes first.
    const second = looked("j-ffffffff", { plan: "claude", until: "3 pm", connected: true, first: "chatgpt" });
    expect(second.need.options?.find((option) => option.label === "Fix it")?.detail).toBe("The fix chat starts on ChatGPT, the plan that goes first.");
    expect(second.detail).not.toContain("Start its fix chat on");
    expect(asks.detail).toContain("The check didn't run: Claude is at its limit until 3 pm.");
    expect(store.planSwitch("job-j-kkkkkkkk", "Use ChatGPT")).toEqual({ id: "j-kkkkkkkk", plan: "chatgpt" });

    const waits = looked("j-wwwwwwww", { plan: "claude", until: "3 pm", connected: false });
    expect(waits.need).toMatchObject({ title: "Lint j-wwwwwwww is red", options: [{ label: "Fix it", recommended: true, detail: "The fix chat starts on the plan that goes first." }, { label: "Leave it" }] });
    expect(waits.need.ask).toBe(`3 tests failed (${dayTimeWords(SAT_7AM)}). The check didn't run: Claude is at its limit until 3 pm.`);
    expect(JSON.stringify(waits.need)).not.toMatch(/Use ChatGPT/);
    expect(store.planSwitch("job-j-wwwwwwww", "Use ChatGPT")).toBeNull();
  });

  it("builds a plain red card as before, whatever the look said, when no limit came with its report", () => {
    store.create("j-pppppppp", check({ check: { script: "memory:lint", where: "mac", onRed: "look" } }), SAT_7AM);
    const red = start("j-pppppppp", SAT_7AM);
    if (!red?.go) throw new Error("did not start");
    finish("j-pppppppp", red.run, "red", SAT_7AM, "3 tests failed");
    expect(store.look("j-pppppppp", { run: red.run, state: "look", usage: 10 }, SAT_7AM)?.go).toBe(true);
    expect(store.report("j-pppppppp", red.run, "red", "3 tests failed The look into it: the parser went.", undefined, SAT_7AM).outcome?.fresh).toEqual([]);
    expect(store.failing()[0]!.need).toEqual({
      id: store.failing()[0]!.need.id,
      kind: "decision",
      title: `${check().name} is red`,
      ask: `3 tests failed The look into it: the parser went. (${dayTimeWords(SAT_7AM)}). Its last lines are on the Red jobs sheet.`,
      since: SAT_7AM.toISOString(),
      schedule: "job-j-pppppppp",
      options: [{ label: "Fix it", recommended: true }, { label: "Leave it", detail: "No new card until it goes green and then red again." }],
    });
  });

  it("refuses a limit card's switch by the rules a run starts by, before it is sent", () => {
    for (let n = 0; n < MAX_TASK_RUNS_A_DAY; n += 1) {
      store.create(`j-q${n}qqqqqq`, task({ name: `Busy ${n}` }), SAT_7AM);
      const run = start(`j-q${n}qqqqqq`, SAT_7AM, { usage: 10 });
      if (!run?.go) throw new Error("no start");
      store.report(`j-q${n}qqqqqq`, run.run, "green", "fine", undefined, SAT_7AM);
    }
    store.create("j-llllllll", task(), SAT_7AM);
    store.create("j-kkkkkkkk", check({ check: { script: "memory:lint", where: "mac", onRed: "look" } }), SAT_7AM);
    expect(store.switchRefusal("j-llllllll", "chatgpt", SAT_7AM)).toBe(`${MAX_TASK_RUNS_A_DAY} task runs today already`);
    expect(store.switchRefusal("j-kkkkkkkk", "chatgpt", SAT_7AM)).toBe(`${MAX_TASK_RUNS_A_DAY} task runs today already`);
    expect(store.switchRefusal("j-zzzzzzzz", "chatgpt", SAT_7AM)).toBe("it is no longer there");
    const tomorrow = new Date(SAT_7AM.getTime() + 24 * HOUR);
    expect(store.switchRefusal("j-llllllll", "chatgpt", tomorrow)).toBeNull();
    store.setOvernight({ on: false }, tomorrow);
    expect(store.switchRefusal("j-llllllll", "chatgpt", tomorrow), "an own Run now starts with overnight jobs off").toBeNull();
    expect(store.switchRefusal("j-kkkkkkkk", "chatgpt", tomorrow), "but a check's look does not").toBe(OVERNIGHT_OFF_NOTE);
  });

  it("holds a run by the state of the plan it starts on: Claude's usage on Claude, ChatGPT's known limit on ChatGPT", () => {
    store.create("j-llllllll", task(), SAT_7AM);
    store.create("j-mmmmmmmm", task({ name: "Other" }), SAT_7AM);
    // Claude's usage is high, and "Use ChatGPT" starts the run on ChatGPT, which that usage never holds.
    expect(start("j-llllllll", SAT_7AM, { usage: 95 })).toMatchObject({ go: false, note: "usage high" });
    expect(start("j-llllllll", SAT_7AM, { usage: 95, plan: "claude" })).toMatchObject({ go: false, note: "usage high" });
    expect(store.switchRefusal("j-llllllll", "chatgpt", SAT_7AM)).toBeNull();
    const onChatGpt = start("j-llllllll", SAT_7AM, { usage: 95, plan: "chatgpt" });
    expect(onChatGpt?.go).toBe(true);
    // ChatGPT then reports its limit: in the next half hour no run starts on it, and none is offered a switch to it.
    if (!onChatGpt?.go) throw new Error("no start");
    store.report("j-llllllll", onChatGpt.run, "red", "ChatGPT is at its limit until 3 pm. Use Claude for this job?", undefined, SAT_7AM, { plan: "chatgpt", until: "3 pm" });
    const soon = new Date(SAT_7AM.getTime() + 10 * 60_000);
    expect(start("j-mmmmmmmm", soon, { usage: 10, plan: "chatgpt" })).toMatchObject({ go: false, note: "ChatGPT is at its limit until 3 pm" });
    expect(store.switchRefusal("j-mmmmmmmm", "chatgpt", soon)).toBe("ChatGPT is at its limit until 3 pm");
    expect(store.switchRefusal("j-mmmmmmmm", "claude", soon)).toBeNull();
    expect(start("j-mmmmmmmm", soon, { usage: 10, plan: "claude" })?.go).toBe(true);
    const later = new Date(SAT_7AM.getTime() + HOUR);
    expect(store.switchRefusal("j-llllllll", "chatgpt", soon)).toBe("ChatGPT is at its limit until 3 pm");
    expect(store.switchRefusal("j-llllllll", "chatgpt", later), "a limit older than half an hour is not known now").toBeNull();
  });

  it("asks a task that needs what ChatGPT can't see to wait for Claude, with no switch", () => {
    store.create("j-llllllll", task(), SAT_7AM);
    const run = start("j-llllllll", SAT_7AM, { usage: 10 });
    if (!run?.go) throw new Error("no start");
    const line = "Claude is at its limit until 3 pm, so the job did not run. ChatGPT can't check GitHub from here.";
    store.report("j-llllllll", run.run, "red", line, undefined, SAT_7AM, { plan: "claude", until: "3 pm", outside: "GitHub" });
    const card = store.failing().find((one) => one.scheduleId === "job-j-llllllll")!;
    expect(card.need.ask).toBe("Claude is at its limit until 3 pm. ChatGPT can't check GitHub from here, so this job waits for Claude.");
    expect(card.need.options?.map((option) => option.label)).toEqual(["Wait for Claude"]);
    expect(JSON.stringify(card.need)).not.toMatch(/Use ChatGPT/);
    expect(store.planSwitch("job-j-llllllll", "Use ChatGPT")).toBeNull();
    expect(card.detail).toContain("ChatGPT can't check GitHub from here");
  });

  it("links a check's red card to the Plans page when its look hit a limit with the other plan not connected", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "rivet-jobs-"));
    const schedules = new SchedulesStore(dir2, "https://agent.example");
    const jobs = schedules.jobs;
    try {
      jobs.create("j-kkkkkkkk", check({ check: { script: "memory:lint", where: "mac", onRed: "look" } }), SAT_7AM);
      const look = (at: Date, line: string, limit?: { plan: "claude"; until: string; connected: boolean }) => {
        const red = jobs.start("j-kkkkkkkk", { run: runId(), state: "start" }, at);
        if (!red?.go) throw new Error("did not start");
        jobs.finish("j-kkkkkkkk", { run: red.run, state: "red", line: "3 tests failed" }, at);
        expect(jobs.look("j-kkkkkkkk", { run: red.run, state: "look", usage: 10 }, at)?.go).toBe(true);
        return jobs.report("j-kkkkkkkk", red.run, "red", line, undefined, at, limit).outcome!;
      };
      look(SAT_7AM, "3 tests failed The check didn't run: Claude is at its limit until 3 pm.", { plan: "claude", until: "3 pm", connected: false });
      expect(schedules.failing(SAT_7AM)[0]!.need.links).toEqual([{ label: "Plans", url: `https://agent.example${PLANS_PATH}` }]);
      expect(schedules.failing(SAT_7AM)[0]!.need.options?.map((option) => option.label)).toEqual(["Fix it", "Leave it"]);
    } finally {
      schedules.close();
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("asks afresh when an answered limit card's job then makes another card, and never for an answered red card", () => {
    const LOOK = check({ check: { script: "memory:lint", where: "mac", onRed: "look" } });
    const at = (hours: number) => new Date(SAT_7AM.getTime() + hours * HOUR);
    const cardOf = (id: string) => store.failing().find((one) => one.scheduleId === `job-${id}`)!;
    const answer = (id: string, when: Date) => store.answer(id, cardOf(id).need.id, when);

    // A task: limit, then "Use ChatGPT", then a real red on ChatGPT: a fresh card with Fix it, unanswered.
    store.create("j-llllllll", task(), SAT_7AM);
    const limited = start("j-llllllll", at(0), { usage: 10 });
    if (!limited?.go) throw new Error("no start");
    store.report("j-llllllll", limited.run, "red", "Claude is at its limit until 3 pm. Use ChatGPT for this job?", undefined, at(0), { plan: "claude", until: "3 pm" });
    const limitCard = cardOf("j-llllllll").need.id;
    answer("j-llllllll", at(1));
    expect(cardOf("j-llllllll").answered).toBe(true);
    const onChatGpt = start("j-llllllll", at(2), { usage: 10, manual: true });
    if (!onChatGpt?.go) throw new Error("no start");
    const real = store.report("j-llllllll", onChatGpt.run, "red", "issue 12 is stale", undefined, at(2));
    expect(real.outcome?.fresh).toEqual([expect.objectContaining({ title: `${task().name} is red`, options: [expect.objectContaining({ label: "Fix it" }), expect.objectContaining({ label: "Leave it" })] })]);
    expect(cardOf("j-llllllll")).toMatchObject({ answered: false });
    expect(cardOf("j-llllllll").need.id).not.toBe(limitCard);
    // That red card answered, more reds bring no new card.
    answer("j-llllllll", at(3));
    const again = start("j-llllllll", at(4), { usage: 10, manual: true });
    if (!again?.go) throw new Error("no start");
    expect(store.report("j-llllllll", again.run, "red", "issue 12 is still stale", undefined, at(4)).outcome?.fresh).toEqual([]);
    expect(cardOf("j-llllllll").answered).toBe(true);

    // A check: its look's limit card, answered "Wait for Claude", covers only that card. The next red run is a real
    // failure the answer never saw: a fresh card with Fix it, which shows the look's limit again if the look hits it.
    store.create("j-kkkkkkkk", LOOK, SAT_7AM);
    // The next day, so the day's task runs the task used leave room for the looks.
    const look = (later: number, line: string, limit?: { plan: "claude"; until: string; connected: boolean }) => {
      const hours = 24 + later;
      const red = start("j-kkkkkkkk", at(hours));
      if (!red?.go) throw new Error("did not start");
      const finished = finish("j-kkkkkkkk", red.run, "red", at(hours), "3 tests failed");
      expect(store.look("j-kkkkkkkk", { run: red.run, state: "look", usage: 10 }, at(hours))?.go).toBe(true);
      return { finished: finished.outcome!.fresh, reported: store.report("j-kkkkkkkk", red.run, "red", line, undefined, at(hours), limit).outcome!.fresh };
    };
    const LIMITED = "3 tests failed The check didn't run: Claude is at its limit until 3 pm.";
    const CONNECTED = { plan: "claude", until: "3 pm", connected: true } as const;
    expect(look(0, LIMITED, CONNECTED).finished).toHaveLength(1);
    expect(cardOf("j-kkkkkkkk").need.options?.map((option) => option.label)).toEqual(["Use ChatGPT", "Fix it", "Wait for Claude"]);
    const lookCard = cardOf("j-kkkkkkkk").need.id;
    answer("j-kkkkkkkk", at(25));
    expect(store.planSwitch("job-j-kkkkkkkk", "Use ChatGPT"), "the answer reads the card as it was shown").toEqual({ id: "j-kkkkkkkk", plan: "chatgpt" });
    const next = look(2, LIMITED, CONNECTED);
    expect(next.finished).toEqual([expect.objectContaining({ title: `${check().name} is red`, options: [expect.objectContaining({ label: "Fix it" }), expect.objectContaining({ label: "Leave it" })] })]);
    expect(next.finished[0]!.id).not.toBe(lookCard);
    // The card shown as a plain red keeps that kind: its look's limit is a new card with a new id, so an answer to the
    // plain red card can never be read as one to the limit card.
    expect(next.reported).toEqual([expect.objectContaining({ options: [expect.objectContaining({ label: "Use ChatGPT" }), expect.objectContaining({ label: "Fix it" }), expect.objectContaining({ label: "Wait for Claude" })] })]);
    expect(next.reported[0]!.id).not.toBe(next.finished[0]!.id);
    expect(cardOf("j-kkkkkkkk")).toMatchObject({ answered: false, need: { id: next.reported[0]!.id } });
    expect(cardOf("j-kkkkkkkk").need.options?.map((option) => option.label), "its look hit the limit again").toEqual(["Use ChatGPT", "Fix it", "Wait for Claude"]);
    const found = look(3, "3 tests failed The look into it: the lint config lost its parser.");
    expect(found.finished).toEqual([expect.objectContaining({ options: [expect.objectContaining({ label: "Fix it" }), expect.objectContaining({ label: "Leave it" })] })]);
    expect(found.finished[0]!.id).not.toBe(next.reported[0]!.id);
    expect(found.reported).toEqual([]);
    expect(cardOf("j-kkkkkkkk")).toMatchObject({ answered: false, need: { id: found.finished[0]!.id, options: [{ label: "Fix it" }, { label: "Leave it" }] } });
    expect(store.planSwitch("job-j-kkkkkkkk", "Use ChatGPT")).toBeNull();

    // An answered plain red card is never asked again by a look that later hits a limit.
    answer("j-kkkkkkkk", at(28));
    expect(look(5, LIMITED, CONNECTED)).toEqual({ finished: [], reported: [] });
    expect(cardOf("j-kkkkkkkk").answered).toBe(true);
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
    expect(look("j-llllllll", red.run, 90)).toEqual({ go: false, note: "usage high" });
    expect(look("j-llllllll", red.run, null)?.go).toBe(true);
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

  it("skips scheduled task chats and look chats with \"Overnight jobs are off\" while the switch is off", () => {
    expect(store.overnight()).toEqual({ on: true, noticeSeen: false });
    store.create("j-nnnnnnnn", task({ when: { every: "hours", hours: 4, minute: 0 } }), SAT_7AM);
    store.create("j-oooooooo", check({ name: "Look", check: { script: "memory:lint", where: "mac", onRed: "look" }, when: { every: "hours", hours: 1, minute: 0 } }), SAT_7AM);
    const red = start("j-oooooooo", SAT_7AM);
    if (!red?.go) throw new Error("did not start");
    finish("j-oooooooo", red.run, "red", SAT_7AM, "boom");
    expect(store.setOvernight({ on: false }, SAT_7AM)).toEqual({ on: false, noticeSeen: false });
    expect(start("j-nnnnnnnn", SAT_7AM, { usage: 10 })).toEqual({ go: false, note: "Overnight jobs are off" });
    expect(store.look("j-oooooooo", { run: red.run, state: "look", usage: 10 }, SAT_7AM)).toEqual({ go: false, note: "Overnight jobs are off" });
    // A check is no chat: it still runs. A Run now the user taps in the app still goes, once; a manual run whose action
    // the app never sent (a board-token Run now) or that names none is held like a scheduled one.
    expect(start("j-oooooooo", SAT_7AM)?.go).toBe(true);
    expect(start("j-nnnnnnnn", SAT_7AM, { usage: 10, manual: true, action: "act-board" })).toEqual({ go: false, note: "Overnight jobs are off" });
    expect(start("j-nnnnnnnn", SAT_7AM, { usage: 10, manual: true })).toEqual({ go: false, note: "Overnight jobs are off" });
    store.ownRun("act-1", SAT_7AM);
    expect(start("j-nnnnnnnn", SAT_7AM, { usage: 10, action: "act-1" })).toEqual({ go: false, note: "Overnight jobs are off" });
    const own = start("j-nnnnnnnn", SAT_7AM, { usage: 10, manual: true, action: "act-1" });
    if (!own?.go) throw new Error("did not start");
    finish("j-nnnnnnnn", own.run, "green", SAT_7AM);
    expect(start("j-nnnnnnnn", SAT_7AM, { usage: 10, manual: true, action: "act-1" })).toEqual({ go: false, note: "Overnight jobs are off" });
    expect(store.tasksToday(SAT_7AM)).toBe(1);
    expect(store.list(SAT_7AM).jobs.find((job) => job.id === "j-nnnnnnnn")!.runs.some((run) => run.line === "skipped: Overnight jobs are off")).toBe(true);
    // Back on, the same red run's look chat opens.
    store.setOvernight({ on: true }, SAT_7AM);
    expect(store.look("j-oooooooo", { run: red.run, state: "look", usage: 10 }, SAT_7AM)?.go).toBe(true);
  });

  it("keeps the switch and the notice seen across a restart, and a seed never turns the switch back on", () => {
    store.setOvernight({ on: false }, SAT_7AM);
    store.close();
    store = new JobsStore(dir);
    expect(store.overnight()).toEqual({ on: false, noticeSeen: false });
    store.seedNotice(SAT_7AM);
    expect(store.overnight()).toEqual({ on: false, noticeSeen: true });
    expect(store.setOvernight({ on: true }, SAT_7AM)).toEqual({ on: true, noticeSeen: true });
    store.close();
    store = new JobsStore(dir);
    expect(store.overnight()).toEqual({ on: true, noticeSeen: true });
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
    expect(start("j-ssssssss", new Date(SAT_7AM.getTime() + 61_000))?.go).toBe(true);
    const job = store.list(SAT_7AM).jobs[0]!;
    expect(job.redStreak).toBe(1);
    expect(job.runs.map((run) => run.line)).toEqual([undefined, "skipped: usage high", "two issues need you"]);
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

  it("links a task's limit card to the Plans page on an https origin only", () => {
    const red = (origin: string) => {
      const dir = mkdtempSync(join(tmpdir(), "rivet-jobs-"));
      const schedules = new SchedulesStore(dir, origin);
      try {
        schedules.jobs.create("j-pppppppp", task(), SAT_7AM);
        const begun = schedules.jobs.start("j-pppppppp", { run: "run-pppppppp", state: "start", usage: 10 }, SAT_7AM);
        if (!begun?.go) throw new Error("no start");
        schedules.jobs.report("j-pppppppp", begun.run, "red", "Claude is at its limit. Use ChatGPT for this job?", undefined, SAT_7AM, { plan: "claude" });
        return schedules.failing(SAT_7AM)[0]!.need;
      } finally {
        schedules.close();
        rmSync(dir, { recursive: true, force: true });
      }
    };
    expect(red("https://agent.example")).toMatchObject({ ask: "Claude is at its limit. Use ChatGPT for this job?", links: [{ label: "Plans", url: `https://agent.example${PLANS_PATH}` }] });
    expect(red("http://localhost:8787")).not.toHaveProperty("links");
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
