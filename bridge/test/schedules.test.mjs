import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ExecError } from "../lib/config.mjs";
import { LAUNCHCTL_BIN } from "../lib/ops/mac.mjs";
import { BRIDGE_LABEL, CANNOT, collectGithub, collectMac, createCollector, exitWords, parseDisabled, PLUTIL_BIN, runSchedulesLoop, SERVER_LABEL, workflowTriggers } from "../lib/schedules/index.mjs";
import { SCHEDULE_ID_RE, toggleSchedule } from "../lib/schedules/toggle.mjs";

// A throwaway home, a fixed zone and one repo: the Mac's own settings must not change these tests.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "schedules-home-"));
process.env.RIVET_TIME_ZONE = "Pacific/Auckland";
process.env.RIVET_REPOS = "example-org/example-repo";
import { clock, cronWords, launchdWords, nextCron, wordsFor, NAME_MAX, NO_NAME, NO_WORDS } from "../lib/schedules/words.mjs";

const NOW = Date.parse("2026-10-02T07:00:00Z");
const REPO = "example-org/example-repo";
const JOB_ID = "mac:dev.rivet-agents.test-writer";
// Assembled here so no token shape sits in the source.
const TOKEN_SHAPED = `${"xox"}b-1234567890-fake`;

/** A fake execFile: each call is matched by its binary and first arguments. */
function fakeExec(handlers) {
  const calls = [];
  const exec = async (bin, args) => {
    // A conditional read (`api -i [-H If-None-Match: …] <path> …`) is matched and recorded by its path; with no status
    // line in the answer nothing is kept for it.
    const plain = args[0] === "api" && args[1] === "-i" ? ["api", ...args.slice(args[2] === "-H" ? 4 : 2)] : args;
    calls.push([bin, ...plain]);
    for (const [match, answer] of handlers) {
      if (match(bin, plain)) {
        const out = typeof answer === "function" ? await answer(bin, plain) : answer;
        return { stdout: typeof out === "string" ? out : JSON.stringify(out), stderr: "" };
      }
    }
    throw new Error(`unexpected exec ${bin} ${args.join(" ")}`);
  };
  return { exec, calls };
}

test("words: times in plain local words", () => {
  assert.equal(clock(0, 0), "midnight");
  assert.equal(clock(17, 40), "5:40pm");
  assert.deepEqual(cronWords("0 21 * * *", "Pacific/Auckland", NOW), { when: "Every day at 9pm", group: "daily" });
  assert.deepEqual(cronWords("*/15 * * * *", "UTC", NOW), { when: "Every 15 min", group: "all-day" });
  // A UTC Sunday-night cron is Monday morning in the local zone.
  assert.deepEqual(cronWords("30 20 * * 0", "UTC", NOW), { when: "Mondays at 9:30am", group: "weekly" });
  assert.equal(new Date(nextCron("0 21 * * *", NOW, "UTC")).toISOString(), "2026-10-02T21:00:00.000Z");
  assert.equal(launchdWords({ KeepAlive: true }, "Pacific/Auckland").group, "always-on");
  assert.equal(launchdWords({ StartInterval: 900 }, "Pacific/Auckland").when, "Every 15 min");
  assert.equal(launchdWords({ StartCalendarInterval: { Hour: 2, Minute: 0 } }, "Pacific/Auckland").when, "Every day at 2am");
  assert.deepEqual(wordsFor("dev.rivet-agents.never-heard-of-it", "never-heard-of-it"), { name: "never-heard-of-it", what: NO_WORDS });
  // A name past the server's limit is clipped, never sent whole: one over drops the whole snapshot.
  assert.equal(wordsFor("dev.rivet-agents.unnamed", "x".repeat(NAME_MAX + 20)).name, `${"x".repeat(NAME_MAX - 1)}…`);
  // Nor empty: a name that sanitises to nothing is refused too.
  assert.equal(wordsFor("custom.yml", " \u0007 ").name, NO_NAME);
  // A day-of-week range names every day it covers.
  assert.deepEqual(cronWords("0 9 * * 1-5", "Pacific/Auckland", NOW), { when: "Weekdays at 9am", group: "weekly" });
  assert.deepEqual(cronWords("0 9 * * 1,4", "Pacific/Auckland", NOW), { when: "Mondays and Thursdays at 9am", group: "weekly" });
  // launchd: a missing key is "every", and Day narrows to a day of the month.
  assert.deepEqual(launchdWords({ StartCalendarInterval: { Day: 1, Hour: 7, Minute: 0 } }, "Pacific/Auckland"), { when: "Monthly, on day 1 at 7am", group: "weekly" });
  assert.deepEqual(launchdWords({ StartCalendarInterval: { Hour: 7 } }, "Pacific/Auckland"), { when: "On a custom launchd calendar", group: "all-day" });
  assert.deepEqual(launchdWords({ StartCalendarInterval: [{ Weekday: 1, Hour: 7, Minute: 0 }, { Hour: 9, Minute: 0 }] }, "Pacific/Auckland").when, "Mondays at 7am; Every day at 9am");
  assert.equal(launchdWords({ StartCalendarInterval: [{ Weekday: 1, Hour: 7, Minute: 0 }, { Hour: 9, Minute: 0 }] }, "Pacific/Auckland").group, "daily");
  assert.equal(launchdWords({ StartCalendarInterval: { Day: 1, Weekday: 1, Hour: 7, Minute: 0 } }, "Pacific/Auckland").when, "On a custom launchd calendar");
  // A Mac on another zone says so.
  assert.equal(launchdWords({ StartCalendarInterval: { Hour: 2, Minute: 0 } }, "UTC").when, "Every day at 2am (Mac time, UTC)");
  // A week of runs crossing the local daylight-saving change is still one daily time.
  const BEFORE_SPRING = Date.parse("2026-09-25T07:00:00Z");
  assert.deepEqual(cronWords("0 21 * * *", "UTC", BEFORE_SPRING), { when: "Every day at 9am", group: "daily" });
  // Both times survive the change: a UTC pair that lands on one local hour across it, and the zone's own skipped or doubled hour.
  assert.equal(cronWords("0 12,13 * * *", "UTC", Date.parse("2026-09-26T12:30:00Z")).when.split(" and ").length, 2);
  assert.deepEqual(cronWords("0 1,2 * * *", "Pacific/Auckland", Date.parse("2026-09-26T12:30:00Z")).when, "Every day at 1am and 2am");
  assert.deepEqual(cronWords("0 2,4 * * *", "Pacific/Auckland", Date.parse("2026-04-04T12:00:00Z")).when, "Every day at 2am and 4am");
  assert.deepEqual(cronWords("0 11 * * *", "UTC", Date.parse("2026-04-03T10:00:00Z")).when, "Every day at midnight");
  assert.deepEqual(cronWords("0 8,13 * * 1", "UTC", BEFORE_SPRING).when, "Mondays and Tuesdays at 2am and 9pm");
});

test("workflowTriggers reads the inline, list and block forms", () => {
  assert.deepEqual(workflowTriggers("name: x\non: push\njobs: {}\n"), { triggers: ["push"], crons: [] });
  assert.deepEqual(workflowTriggers("on: [push, schedule]\n"), { triggers: ["push", "schedule"], crons: [] });
  assert.deepEqual(
    workflowTriggers("on:\n  schedule:\n    - cron: '0 21 * * *' # nightly\n  workflow_dispatch:\njobs:\n  a: {}\n"),
    { triggers: ["schedule", "workflow_dispatch"], crons: ["0 21 * * *"] },
  );
  assert.equal(workflowTriggers("jobs: {}\n"), null);
  // A manual run that takes inputs, in the block and the inline map form; a later key's inputs are not its.
  assert.equal(workflowTriggers("on:\n  workflow_dispatch:\n    inputs:\n      target: {}\n  schedule:\n    - cron: '0 0 * * *'\n").dispatchInputs, true);
  assert.equal(workflowTriggers("on:\n  schedule:\n    - cron: '0 0 * * *'\n  workflow_dispatch: { inputs: { a: {} } }\n").dispatchInputs, true);
  assert.equal(workflowTriggers("on:\n  workflow_dispatch:\n  workflow_call:\n    inputs:\n      a: {}\n").dispatchInputs, undefined);
  // Quoted event keys count; a form it can't read marks the workflow unsure.
  assert.deepEqual(workflowTriggers("on:\n  schedule:\n    - cron: '0 0 * * *'\n  'pull_request':\n"), { triggers: ["schedule", "pull_request"], crons: ["0 0 * * *"] });
  assert.deepEqual(workflowTriggers('on:\n  schedule:\n    - cron: "0 0 * * *"\n  "push":\n    branches: [main]\n'), { triggers: ["schedule", "push"], crons: ["0 0 * * *"] });
  assert.equal(workflowTriggers("on:\n  schedule:\n    - cron: '0 0 * * *'\n  ? pull_request\n").unsure, true);
});

test("launchctl output: disabled labels and exit codes in words", () => {
  const disabled = parseDisabled('disabled services = {\n\t"dev.rivet-agents.a" => disabled\n\t"dev.rivet-agents.b" => enabled\n\t"dev.rivet-agents.c" => true\n}');
  assert.deepEqual([...disabled].sort(), ["dev.rivet-agents.a", "dev.rivet-agents.c"]);
  assert.equal(exitWords({ exit: 0, signal: null }), undefined);
  assert.equal(exitWords({ exit: 127, signal: null }), "The script it runs is missing (exit 127)");
  assert.equal(exitWords({ exit: null, signal: "SIGKILL" }), "Stopped by a signal (SIGKILL)");
});

function agentsDir(plists) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedules-agents-"));
  for (const label of Object.keys(plists)) fs.writeFileSync(path.join(dir, `${label}.plist`), "<plist/>");
  fs.writeFileSync(path.join(dir, "com.apple.not-ours.plist"), "<plist/>");
  return dir;
}

function macExec(plists, { disabled = [], loaded = {} } = {}) {
  return fakeExec([
    [(bin, a) => bin === LAUNCHCTL_BIN && a[0] === "print-disabled", `disabled services = {\n${disabled.map((l) => `\t"${l}" => disabled`).join("\n")}\n}`],
    [
      (bin, a) => bin === LAUNCHCTL_BIN && a[0] === "print",
      (_, a) => {
        const label = a[1].split("/").pop();
        if (!(label in loaded)) throw new ExecError(LAUNCHCTL_BIN, { code: 113 }, `Could not find service "${label}" in domain`);
        return loaded[label];
      },
    ],
    [(bin) => bin === PLUTIL_BIN, (_, a) => plists[path.basename(a[4], ".plist")]],
    [(bin) => bin === LAUNCHCTL_BIN, ""],
  ]);
}

test("collectMac: on, off, failing and the bridge that can't be switched", async () => {
  const plists = {
    "dev.rivet-agents.test-writer": { Label: "dev.rivet-agents.test-writer", StartCalendarInterval: { Hour: 2, Minute: 0 } },
    "dev.rivet-agents.agent-dispatch": { Label: "dev.rivet-agents.agent-dispatch", StartInterval: 900 },
    [BRIDGE_LABEL]: { Label: BRIDGE_LABEL, KeepAlive: true },
    "dev.rivet-agents.renamed": { Label: "dev.rivet-agents.something-else", KeepAlive: true },
    "dev.rivet-agents.stuck": { Label: "dev.rivet-agents.stuck", KeepAlive: true },
    "dev.rivet-agents.busy": { Label: "dev.rivet-agents.busy", StartCalendarInterval: Array.from({ length: 24 }, (_, hour) => ({ Hour: hour, Minute: 30 })) },
    // A label is the item's id: one holding a made-up token shape is not sent at all.
    [`dev.rivet-agents.${TOKEN_SHAPED}`]: { Label: `dev.rivet-agents.${TOKEN_SHAPED}`, KeepAlive: true },
  };
  const dir = agentsDir(plists);
  try {
    const { exec } = macExec(plists, {
      disabled: ["dev.rivet-agents.agent-dispatch", "dev.rivet-agents.stuck"],
      loaded: { "dev.rivet-agents.test-writer": "\truns = 3\n\tlast exit code = 0\n", "dev.rivet-agents.agent-dispatch": "\tlast exit code = 127\n", [BRIDGE_LABEL]: "\tpid = 4242\n", "dev.rivet-agents.stuck": "\tpid = 99\n", "dev.rivet-agents.busy": "\truns = 1\n" },
    });
    const items = await collectMac({ exec, now: NOW, agentsDir: dir, uid: 501, macZone: "Pacific/Auckland", plists: new Map() });
    const byId = Object.fromEntries(items.map((item) => [item.id, item]));
    assert.deepEqual(Object.keys(byId).sort(), ["mac:dev.rivet-agents.agent-dispatch", `mac:${BRIDGE_LABEL}`, "mac:dev.rivet-agents.busy", "mac:dev.rivet-agents.stuck", "mac:dev.rivet-agents.test-writer"]);
    // Disabled is off even mid-run, so the switch can turn it back on.
    assert.equal(byId["mac:dev.rivet-agents.stuck"].on, false);
    // A long description is cut to what the server takes, so one job never blocks the whole list.
    assert.equal(byId["mac:dev.rivet-agents.busy"].when.length <= 120, true);
    assert.equal(byId["mac:dev.rivet-agents.test-writer"].on, true);
    assert.deepEqual(byId["mac:dev.rivet-agents.test-writer"].lastRun, { at: null, result: "ok" });
    assert.equal(byId["mac:dev.rivet-agents.test-writer"].nextRun !== null, true);
    assert.equal(byId["mac:dev.rivet-agents.agent-dispatch"].on, false);
    assert.equal(byId["mac:dev.rivet-agents.agent-dispatch"].lastRun.note, "The script it runs is missing (exit 127)");
    assert.equal(byId[`mac:${BRIDGE_LABEL}`].lastRun.result, "running");
    assert.deepEqual(byId[`mac:${BRIDGE_LABEL}`].toggle, { can: false, why: CANNOT.bridge });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collectMac: a timed job's runs come from launchd's run count, kept across restarts; an always-on job has none", async () => {
  const plists = {
    "dev.rivet-agents.nightly-collect": { Label: "dev.rivet-agents.nightly-collect", StartCalendarInterval: [{ Hour: 6, Minute: 45 }], StandardOutPath: "/nowhere/nightly-collect.log" },
    "dev.rivet-agents.watcher": { Label: "dev.rivet-agents.watcher", KeepAlive: true },
  };
  const dir = agentsDir(plists);
  const runsFile = path.join(dir, "state", "schedule-runs.json");
  let job = "\truns = 3\n\tlast exit code = 1\n";
  let at = NOW;
  const { exec } = fakeExec([
    [(bin, a) => bin === LAUNCHCTL_BIN && a[0] === "print-disabled", "disabled services = {\n}"],
    [(bin, a) => bin === LAUNCHCTL_BIN && a[0] === "print", (_, a) => (a[1].endsWith("watcher") ? "\tlast exit code = 1\n" : job)],
    [(bin) => bin === PLUTIL_BIN, (_, a) => plists[path.basename(a[4], ".plist")]],
  ]);
  const deps = { exec, ghBin: "/bin/gh", agentsDir: dir, now: () => new Date(at), runsFile };
  // Each pass is a new collector, as after a bridge restart: the history comes back from the file.
  const pass = async (state, ms) => {
    job = state;
    at = ms;
    const { items } = await createCollector(deps).collect({ only: "mac" });
    return Object.fromEntries(items.map((item) => [item.id, item]));
  };
  const runs = (byId) => byId["mac:dev.rivet-agents.nightly-collect"].runs.map((run) => run.result);
  const day = 86_400_000;
  try {
    // First seen: when it finished is not known, so it can't start a streak. Its log is never written either.
    let byId = await pass("\truns = 3\n\tlast exit code = 1\n", NOW);
    assert.deepEqual(byId["mac:dev.rivet-agents.nightly-collect"].runs, [{ id: `3:1@${new Date(NOW).toISOString()}`, at: new Date(NOW).toISOString(), result: "unknown" }]);
    assert.equal(byId["mac:dev.rivet-agents.watcher"].runs, undefined);
    // The same count again is the same run.
    assert.deepEqual(runs(await pass("\truns = 3\n\tlast exit code = 1\n", NOW + 60_000)), ["unknown"]);
    assert.deepEqual(runs(await pass("\truns = 4\n\tlast exit code = 1\n", NOW + day)), ["failed", "unknown"]);
    // Running: nothing new until it exits.
    assert.deepEqual(runs(await pass("\tpid = 77\n\truns = 5\n\tlast exit code = 1\n", NOW + 2 * day)), ["failed", "unknown"]);
    // A jump of two: one run went by unseen, so an unknown run sits between the failures.
    byId = await pass("\truns = 6\n\tlast exit code = 1\n", NOW + 3 * day);
    assert.deepEqual(runs(byId), ["failed", "unknown", "failed", "unknown"]);
    assert.equal(byId["mac:dev.rivet-agents.nightly-collect"].runs[1].id.startsWith("missed:5-5@"), true);
    // A reload: the count goes down, and the run after it is new, though its exit is the same.
    assert.deepEqual(runs(await pass("\truns = 1\n\tlast exit code = 1\n", NOW + 4 * day)), ["failed", "failed", "unknown", "failed", "unknown"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collectGithub: only scheduled workflows, and one that also runs on PRs is locked", async () => {
  const files = {
    "nightly.yml": "name: Nightly\non:\n  schedule:\n    - cron: '0 21 * * *'\n  workflow_dispatch:\n",
    "ci.yml": "name: CI\non:\n  pull_request:\n  schedule:\n    - cron: '0 3 * * 1'\n",
    "push.yml": "name: Push\non: push\n",
    "deploy.yml": "name: Deploy\non:\n  push:\n  schedule:\n    - cron: '0 1 * * *'\n",
    // A name that sanitises to nothing: the file name stands in, as the server takes no empty name.
    "blank.yml": "name: \" \"\non:\n  schedule:\n    - cron: '0 2 * * *'\n",
    // A made-up secret shape in a workflow's name is redacted before it is cut.
    "leak.yml": "name: Audit password=not-a-real-pass-42\non:\n  schedule:\n    - cron: '0 4 * * *'\n",
    // A file name is part of the item's id: one holding a made-up token shape is not sent at all.
    [`${TOKEN_SHAPED}.yml`]: "name: Fake\non:\n  schedule:\n    - cron: '0 5 * * *'\n",
  };
  const { exec } = fakeExec([
    [(_, a) => a[1].endsWith("/contents/.github/workflows"), Object.keys(files).map((name, i) => ({ name, path: `.github/workflows/${name}`, sha: `sha${i}` }))],
    [(_, a) => a[1].includes("/contents/.github/workflows/"), (_, a) => Buffer.from(files[a[1].split("/").pop()]).toString("base64")],
    [(_, a) => a[1].endsWith("/actions/workflows?per_page=100"), { total: 2, rows: ["/.github/workflows/nightly.yml\tactive", ".github/workflows/ci.yml\tdisabled_manually"] }],
    [(_, a) => a[1] === `repos/${REPO}`, "main\n"],
    [(_, a) => a[1].includes("/runs?event=workflow_dispatch&branch=main&per_page=20"), ""],
    [
      (_, a) => a[1].includes("/runs?event=schedule&per_page=20"),
      (_, a) =>
        a[1].includes("nightly")
          ? [
              "3\t2026-10-02T06:59:00Z\t2026-10-02T06:59:30Z\tin_progress\t\thttps://github.com/x/y/actions/runs/3",
              "2\t2026-10-01T21:00:05Z\t2026-10-01T21:09:00Z\tcompleted\tfailure\thttps://github.com/x/y/actions/runs/2",
              "1\t2026-09-30T21:00:05Z\t2026-09-30T21:08:00Z\tcompleted\tsuccess\thttps://github.com/x/y/actions/runs/1",
            ].join("\n")
          : "",
    ],
  ]);
  const items = await collectGithub({ exec, ghBin: "/bin/gh", now: NOW, repos: [REPO], files: new Map() });
  const byFile = Object.fromEntries(items.map((item) => [item.id.split("/").pop(), item]));
  assert.deepEqual(Object.keys(byFile).sort(), ["blank.yml", "ci.yml", "deploy.yml", "leak.yml", "nightly.yml"]);
  assert.match(byFile["leak.yml"].name, /^Audit password=\s?\[redacted\]$/);
  assert.equal(byFile["blank.yml"].name, "blank.yml");
  assert.deepEqual(byFile["deploy.yml"].toggle, { can: false, why: CANNOT.otherEvents });
  assert.deepEqual(byFile["nightly.yml"].toggle, { can: true });
  assert.equal(byFile["nightly.yml"].on, true);
  assert.deepEqual(byFile["nightly.yml"].lastRun, { at: "2026-10-02T06:59:00.000Z", result: "running", url: "https://github.com/x/y/actions/runs/3" });
  // Finished runs only, newest first, each with GitHub's run id and when it finished.
  assert.deepEqual(byFile["nightly.yml"].runs, [
    { id: "2", at: "2026-10-01T21:09:00.000Z", result: "failed", url: "https://github.com/x/y/actions/runs/2" },
    { id: "1", at: "2026-09-30T21:08:00.000Z", result: "ok", url: "https://github.com/x/y/actions/runs/1" },
  ]);
  assert.deepEqual(byFile["ci.yml"].runs, []);
  assert.equal(byFile["ci.yml"].on, false);
  assert.deepEqual(byFile["ci.yml"].toggle, { can: false, why: CANNOT.pullRequests });
});

test("collectGithub: a manual re-run on the default branch counts as the latest run; no other event or branch is read", async () => {
  const files = {
    "security.yml": "name: Security scan\non:\n  schedule:\n    - cron: '14 17 * * *'\n  workflow_dispatch:\n  pull_request:\n",
    // Its manual runs take inputs and can run less than the timer does, so they never count.
    "ci.yml": "name: CI\non:\n  schedule:\n    - cron: '7 13 * * *'\n  workflow_dispatch:\n    inputs:\n      idle_feeder: {}\n",
  };
  const run = (id, at, status, conclusion, done = at.replace(/:00Z$/, ":30Z")) => [id, at, done, status, conclusion, `https://github.com/x/y/actions/runs/${id}`].join("\t");
  const { exec, calls } = fakeExec([
    [(_, a) => a[1].endsWith("/contents/.github/workflows"), Object.keys(files).map((name, i) => ({ name, path: `.github/workflows/${name}`, sha: `s${i}` }))],
    [(_, a) => a[1].includes("/contents/.github/workflows/"), (_, a) => Buffer.from(files[a[1].split("/").pop()]).toString("base64")],
    // More workflows than a page: the whole list, as before.
    [(_, a) => a[1].endsWith("/actions/workflows?per_page=100"), { total: 101, rows: [] }],
    [(_, a) => a[1].endsWith("/actions/workflows") && a.includes("--paginate"), ".github/workflows/security.yml\tactive\n.github/workflows/ci.yml\tactive\n"],
    [(_, a) => a[1] === `repos/${REPO}`, "trunk\n"],
    [(_, a) => a[1].includes("/ci.yml/runs?event=schedule&"), ""],
    [
      (_, a) => a[1].includes("/runs?event=schedule&"),
      [run("10", "2026-10-01T17:14:00Z", "completed", "failure"), run("8", "2026-09-30T17:14:00Z", "completed", "failure"), run("6", "2026-09-29T17:14:00Z", "completed", "success")].join("\n"),
    ],
    [
      (_, a) => a[1].includes("/runs?event=workflow_dispatch&branch=trunk&"),
      // A burst: three re-runs still going, then the one that went green.
      [
        run("14", "2026-10-02T06:58:00Z", "in_progress", ""),
        run("13", "2026-10-02T06:57:00Z", "queued", ""),
        run("12", "2026-10-02T06:56:00Z", "in_progress", ""),
        run("11", "2026-10-02T03:24:00Z", "completed", "success"),
        run("7", "2026-09-30T01:00:00Z", "completed", "failure"),
        // Started first, finished last: kept, as the newest finished.
        run("9", "2026-09-29T00:00:00Z", "completed", "success", "2026-10-02T05:00:00Z"),
      ].join("\n"),
    ],
  ]);
  const byFile = Object.fromEntries((await collectGithub({ exec, ghBin: "/bin/gh", now: NOW, repos: [REPO], files: new Map() })).map((item) => [item.id.split("/").pop(), item]));
  const item = byFile["security.yml"];
  assert.deepEqual(item.lastRun, { at: "2026-10-02T06:58:00.000Z", result: "running", url: "https://github.com/x/y/actions/runs/14" });
  // The five newest finished from both lists, by when they finished: the green re-run ends the failing streak.
  assert.deepEqual(item.runs.map((r) => [r.id, r.result]), [["9", "ok"], ["11", "ok"], ["10", "failed"], ["8", "failed"], ["7", "failed"]]);
  const runQueries = calls.map((c) => c[2]).filter((q) => q.includes("/runs?"));
  assert.deepEqual(runQueries.sort(), [
    `repos/${REPO}/actions/workflows/ci.yml/runs?event=schedule&per_page=20`,
    `repos/${REPO}/actions/workflows/security.yml/runs?event=schedule&per_page=20`,
    `repos/${REPO}/actions/workflows/security.yml/runs?event=workflow_dispatch&branch=trunk&per_page=20`,
  ]);
});

test("collectGithub: a red CI run waiting on its one re-run shows as running, as it does on Ops", async () => {
  const files = { "ci.yml": "name: CI\non:\n  schedule:\n    - cron: '7 13 * * *'\n", "nightly.yml": "name: Nightly\non:\n  schedule:\n    - cron: '0 21 * * *'\n" };
  const { exec } = fakeExec([
    [(_, a) => a[1].endsWith("/contents/.github/workflows"), Object.keys(files).map((name, i) => ({ name, path: `.github/workflows/${name}`, sha: `h${i}` }))],
    [(_, a) => a[1].includes("/contents/.github/workflows/"), (_, a) => Buffer.from(files[a[1].split("/").pop()]).toString("base64")],
    [(_, a) => a[1].endsWith("/actions/workflows?per_page=100"), { total: 2, rows: [".github/workflows/ci.yml\tactive", ".github/workflows/nightly.yml\tactive"] }],
    [(_, a) => a[1] === `repos/${REPO}`, "main\n"],
    [(_, a) => a[1].includes("/runs?event=workflow_dispatch&"), ""],
    [
      (_, a) => a[1].includes("/runs?event=schedule&"),
      ["21\t2026-10-02T06:40:00Z\t2026-10-02T06:55:00Z\tcompleted\tfailure\thttps://github.com/x/y/actions/runs/21\t1", "20\t2026-10-01T06:40:00Z\t2026-10-01T06:55:00Z\tcompleted\tfailure\thttps://github.com/x/y/actions/runs/20\t2"].join("\n"),
    ],
  ]);
  const asked = [];
  const falseAlarm = { held: async (run) => (asked.push(run), run.workflow === "CI" && run.id === 21) };
  const items = await collectGithub({ exec, ghBin: "/bin/gh", now: NOW, repos: [REPO], files: new Map(), falseAlarm });
  const byFile = Object.fromEntries(items.map((item) => [item.id.split("/").pop(), item]));
  assert.deepEqual(byFile["ci.yml"].lastRun, { at: "2026-10-02T06:40:00.000Z", result: "running", url: "https://github.com/x/y/actions/runs/21" });
  assert.deepEqual(byFile["ci.yml"].runs.map((r) => [r.id, r.result]), [["20", "failed"]]);
  assert.deepEqual(byFile["nightly.yml"].runs.map((r) => [r.id, r.result]), [["21", "failed"], ["20", "failed"]]);
  assert.deepEqual(asked.find((run) => run.workflow === "CI" && run.id === 20), {
    repo: REPO, id: 20, attempt: 2, workflow: "CI", status: "completed", conclusion: "failure", createdAt: "2026-10-01T06:40:00Z", updatedAt: "2026-10-01T06:55:00Z",
  });
});

test("a schedule id is a Mac label or a workflow file, and nothing else", () => {
  assert.equal(SCHEDULE_ID_RE.test(JOB_ID), true);
  assert.equal(SCHEDULE_ID_RE.test(`github:${REPO}/nightly.yml`), true);
  assert.equal(SCHEDULE_ID_RE.test("mac:; rm -rf /"), false);
  assert.equal(SCHEDULE_ID_RE.test("mac:com.example.other"), false);
  assert.equal(SCHEDULE_ID_RE.test(`github:${REPO}/nightly.sh`), false);
  assert.equal(SCHEDULE_ID_RE.test("other:idle"), false);
});

/** A collector whose reads answer from `state` and fail when `broken` says so. */
function fakeCollector(items, { broken = () => false } = {}) {
  const state = new Map(items.map((item) => [item.id, { ...item }]));
  return {
    state,
    async collect({ only } = {}) {
      return { at: new Date(NOW).toISOString(), items: [...state.values()], sources: [{ source: only, ok: !broken(), at: null }] };
    },
    find: (id) => (state.has(id) ? { ...state.get(id) } : null),
  };
}

const macItem = (on = true, toggle = { can: true }) => ({ id: JOB_ID, source: "mac", name: "Test writer", on, toggle });

test("toggle: refuses what it may not touch, without running anything", async () => {
  const { exec, calls } = fakeExec([]);
  const deps = { exec, ghBin: "/bin/gh", collector: fakeCollector([macItem(true, { can: false, why: "locked" })]) };
  assert.equal((await toggleSchedule(deps, "other:idle", false)).status, "refused");
  assert.equal((await toggleSchedule(deps, "mac:../../evil", false)).status, "refused");
  assert.equal((await toggleSchedule(deps, "mac:dev.rivet-agents.gone", false)).reason, "That schedule is no longer there.");
  assert.deepEqual(await toggleSchedule(deps, JOB_ID, false), { status: "refused", reason: "locked" });
  assert.deepEqual(calls, []);
});

test("toggle: a job's LaunchAgent is the Jobs screen's, not Ops › Scheduled's, and nothing is run for it", async () => {
  const label = "dev.rivet-agents.job-j-abc12345";
  const dir = agentsDir({ [label]: {} });
  try {
    const { exec, calls } = macExec({ [label]: { Label: label, StartCalendarInterval: { Hour: 9, Minute: 0 } } }, { loaded: { [label]: "state = not running\n" } });
    const deps = { exec, ghBin: "/bin/gh", agentsDir: dir, uid: 501, collector: createCollector({ exec, ghBin: "/bin/gh", agentsDir: dir, uid: 501 }) };
    assert.deepEqual(await toggleSchedule(deps, `mac:${label}`, false), { status: "refused", reason: "That schedule is no longer there." });
    assert.deepEqual(
      calls.filter((call) => call[0] === LAUNCHCTL_BIN && !["print-disabled", "print"].includes(call[1])),
      [],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("toggle: a change that did not take, or can't be read back, is a failure", async () => {
  const { exec } = fakeExec([[() => true, { ok: true }]]);
  const stuck = { exec, ghBin: "/bin/gh", collector: fakeCollector([macItem(true)]) };
  assert.deepEqual(await toggleSchedule(stuck, JOB_ID, false), { status: "failed", reason: "It did not turn off; it is on now." });
  let reads = 0;
  const blind = { ...stuck, collector: fakeCollector([macItem(true)], { broken: () => ++reads > 1 }) };
  assert.equal((await toggleSchedule(blind, JOB_ID, false)).status, "failed");
});

test("toggle: a failed fresh read before acting changes nothing", async () => {
  const { exec, calls } = fakeExec([[() => true, { ok: true }]]);
  const deps = { exec, ghBin: "/bin/gh", collector: fakeCollector([macItem(true)], { broken: () => true }) };
  assert.equal((await toggleSchedule(deps, JOB_ID, false)).status, "refused");
  assert.deepEqual(calls, []);
});

test("toggle: launchd off disables then boots out; on enables then bootstraps the same plist", async () => {
  const label = "dev.rivet-agents.test-writer";
  const dir = agentsDir({ [label]: {} });
  try {
    const collector = fakeCollector([{ id: `mac:${label}`, source: "mac", on: true, toggle: { can: true } }]);
    const { exec, calls } = fakeExec([
      [
        (bin) => bin === LAUNCHCTL_BIN,
        (_, a) => {
          if (a[0] === "disable") collector.state.get(`mac:${label}`).on = false;
          if (a[0] === "enable") collector.state.get(`mac:${label}`).on = true;
          return "";
        },
      ],
    ]);
    const deps = { exec, ghBin: "/bin/gh", agentsDir: dir, uid: 501, collector };
    assert.equal((await toggleSchedule(deps, `mac:${label}`, false)).status, "succeeded");
    assert.equal((await toggleSchedule(deps, `mac:${label}`, true)).status, "succeeded");
    assert.deepEqual(calls, [
      [LAUNCHCTL_BIN, "disable", `gui/501/${label}`],
      [LAUNCHCTL_BIN, "bootout", `gui/501/${label}`],
      [LAUNCHCTL_BIN, "enable", `gui/501/${label}`],
      [LAUNCHCTL_BIN, "bootstrap", "gui/501", path.join(dir, `${label}.plist`)],
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("toggle: a launchd stop that leaves the job running is reported, not swallowed", async () => {
  const label = "dev.rivet-agents.test-writer";
  const dir = agentsDir({ [label]: {} });
  try {
    const collector = fakeCollector([{ id: `mac:${label}`, source: "mac", on: true, toggle: { can: true } }]);
    const { exec } = fakeExec([
      [
        (bin) => bin === LAUNCHCTL_BIN,
        (_, a) => {
          if (a[0] === "disable") collector.state.get(`mac:${label}`).on = false;
          if (a[0] === "bootout") throw Object.assign(new Error("bootout failed"), { code: 5 });
          return a[0] === "print" ? "\tpid = 77\n" : "";
        },
      ],
    ]);
    const result = await toggleSchedule({ exec, ghBin: "/bin/gh", agentsDir: dir, uid: 501, collector }, `mac:${label}`, false);
    assert.deepEqual(result, { status: "failed", reason: "Turned off for the future, but the Mac couldn't stop, or check it stopped, the run that's going now." });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("toggle: a launchd stop it can't check is not reported done", async () => {
  const label = "dev.rivet-agents.test-writer";
  const dir = agentsDir({ [label]: {} });
  try {
    const collector = fakeCollector([{ id: `mac:${label}`, source: "mac", on: true, toggle: { can: true } }]);
    const { exec } = fakeExec([
      [
        (bin) => bin === LAUNCHCTL_BIN,
        (_, a) => {
          if (a[0] === "disable") collector.state.get(`mac:${label}`).on = false;
          if (a[0] === "bootout" || a[0] === "print") throw new Error("timed out");
          return "";
        },
      ],
    ]);
    const result = await toggleSchedule({ exec, ghBin: "/bin/gh", agentsDir: dir, uid: 501, collector }, `mac:${label}`, false);
    assert.equal(result.status, "failed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("toggle: never touches the bridge's own job, even if a read said it could", async () => {
  const { exec, calls } = fakeExec([[() => true, ""]]);
  const deps = { exec, ghBin: "/bin/gh", collector: fakeCollector([{ id: `mac:${BRIDGE_LABEL}`, source: "mac", on: true, toggle: { can: true } }]) };
  assert.equal((await toggleSchedule(deps, `mac:${BRIDGE_LABEL}`, false)).status, "failed");
  assert.deepEqual(calls, []);
  const server = { ...deps, collector: fakeCollector([{ id: `mac:${SERVER_LABEL}`, source: "mac", on: true, toggle: { can: true } }]) };
  assert.equal((await toggleSchedule(server, `mac:${SERVER_LABEL}`, false)).status, "failed");
  assert.deepEqual(calls, []);
});

test("toggle: a workflow switches only in a repo on the list", async () => {
  const ours = `github:${REPO}/nightly.yml`;
  const other = "github:example-org/other-repo/nightly.yml";
  const collector = fakeCollector([ours, other].map((id) => ({ id, source: "github", on: true, toggle: { can: true } })));
  const { exec, calls } = fakeExec([[(bin) => bin === "/bin/gh", () => { collector.state.get(ours).on = false; return ""; }]]);
  const deps = { exec, ghBin: "/bin/gh", collector };
  assert.equal((await toggleSchedule(deps, ours, false)).status, "succeeded");
  assert.deepEqual(calls, [["/bin/gh", "workflow", "disable", "nightly.yml", "--repo", REPO]]);
  assert.equal((await toggleSchedule(deps, other, false)).status, "failed");
  assert.equal(calls.length, 1);
});

test("collectGithub: with no repo set it is an empty list, not an error", async (t) => {
  const repos = process.env.RIVET_REPOS;
  delete process.env.RIVET_REPOS;
  t.after(() => { process.env.RIVET_REPOS = repos; });
  const { exec, calls } = fakeExec([]);
  assert.deepEqual(await collectGithub({ exec, ghBin: "/bin/gh", now: NOW, files: new Map() }), []);
  assert.deepEqual(calls, []);
  const snap = await createCollector({ exec, ghBin: "/bin/gh", agentsDir: "/nonexistent/LaunchAgents", now: () => new Date(NOW) }).collect({ only: "github" });
  assert.deepEqual(snap.sources.map((state) => [state.source, state.ok]), [["github", true]]);
});

test("the collector keeps a failed source's last list and says it failed", async (t) => {
  const label = "dev.rivet-agents.test-writer";
  const plists = { [label]: { Label: label, StartInterval: 900 } };
  const dir = agentsDir(plists);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let fail = false;
  const { exec } = macExec(plists, { loaded: { [label]: "\truns = 1\n" } });
  const flaky = async (bin, args) => {
    if (fail) throw new Error("launchd down");
    return exec(bin, args);
  };
  const collector = createCollector({ exec: flaky, ghBin: "/bin/gh", agentsDir: dir, now: () => new Date(NOW) });
  await collector.collect({ only: "mac" });
  fail = true;
  const snap = await collector.collect({ only: "mac" });
  assert.equal(snap.items.length, 1);
  assert.deepEqual(snap.sources.map((s) => [s.source, s.ok]), [["mac", false]]);
});

test("a source's error is redacted before it is cut", async (t) => {
  const dir = agentsDir({});
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Made-up secret shapes only.
  const fake = "not-a-real-pass-42";
  const exec = async () => { throw new Error(`request failed: password=${fake}`); };
  const collector = createCollector({ exec, ghBin: "/bin/gh", agentsDir: dir, now: () => new Date(NOW) });
  const snap = await collector.collect({ only: "mac" });
  assert.match(snap.sources[0].error, /^request failed: password=\s?\[redacted\]$/);
});

test("a source failing with no message still says why: the server takes no empty error", async (t) => {
  const dir = agentsDir({});
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exec = async () => { throw new Error(""); };
  const collector = createCollector({ exec, ghBin: "/bin/gh", agentsDir: dir, now: () => new Date(NOW) });
  const snap = await collector.collect({ only: "mac" });
  assert.deepEqual(snap.sources, [{ source: "mac", ok: false, at: null, error: "error" }]);
});

test("the loop logs the fields a refused snapshot broke, not just the status", async (t) => {
  const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-loop-"));
  t.after(() => fs.rmSync(agentsDir, { recursive: true, force: true }));
  const stop = new AbortController();
  /** @type {[string, Record<string, unknown> | undefined][]} */
  const logs = [];
  const issues = [{ path: ["items", 18, "what"], message: "String must contain at most 200 character(s)" }];
  await runSchedulesLoop({
    origin: "https://rivet.example",
    runsFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rivet-schedule-runs-")), "schedule-runs.json"),
    token: "t",
    fetch: async () => new Response(JSON.stringify({ error: "invalid schedules snapshot", issues }), { status: 400 }),
    exec: fakeExec([]).exec,
    ghBin: "/bin/gh",
    agentsDir,
    log: (event, fields) => {
      logs.push([event, fields]);
      if (event === "schedules-failed") stop.abort();
    },
    stop: stop.signal,
  });
  assert.deepEqual(logs.filter(([event]) => event === "schedules-failed"), [
    ["schedules-failed", { error: "/api/bridge/schedules http 400: invalid schedules snapshot (items.18.what: String must contain at most 200 character(s))" }],
  ]);
});

