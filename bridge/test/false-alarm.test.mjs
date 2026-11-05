import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { causeOf, createFalseAlarmRetry, HOLD_MS, jobVerdict, neverRetry, UNSURE_HOLD_MS } from "../lib/ops/false-alarm.mjs";
import { armState, checkRerun, QUEUED_LIMIT, readRerunRecord, RUNNING_LIMIT, stopSwitch } from "../lib/rerun-guard.mjs";

const REPO = "example-org/example-repo";
process.env.RIVET_REPOS = REPO;

const NOW = new Date("2026-10-24T03:00:00Z");
const SHA = "a".repeat(40);
const DOWNLOAD = ["Failed to download archive 'https://codeload.github.com/actions/checkout/tar.gz/abc123' after 3 tries", "Process completed with exit code 1."];
const REAL = ["Process completed with exit code 1.", "Expected 2 to equal 3"];
const EXIT = ["Process completed with exit code 1."];

/** @param {Record<string, unknown>} [extra] */
const run = (extra = {}) => ({
  repo: REPO,
  id: 501,
  attempt: 1,
  workflow: "CI",
  status: "completed",
  conclusion: "failure",
  event: "push",
  sha: SHA,
  createdAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
  updatedAt: new Date(NOW.getTime() - 2 * 60_000).toISOString(),
  failedJobs: ["Checks", "CI complete"],
  ...extra,
});

/**
 * GitHub for one run: its failed jobs, main's tip and what else is out on main.
 * @param {{ jobs?: any[], tip?: string, busy?: string, rerunFails?: boolean, later?: { attempt: number, status: string, conclusion: string | null } }} [opts]
 */
function github({ jobs = [{ id: 11, name: "Checks", messages: DOWNLOAD }], tip = SHA, busy, rerunFails = false, later } = {}) {
  const calls = /** @type {string[]} */ ([]);
  /** @param {string} _bin @param {string[]} args */
  const exec = async (_bin, args) => {
    const url = args[1] === "-X" ? args[3] : args[1];
    calls.push(args[1] === "-X" ? `POST ${url}` : url);
    if (args[1] === "-X") {
      if (rerunFails) throw new Error("connection reset");
      return { stdout: "{}", stderr: "" };
    }
    if (url.includes("/attempts/")) {
      return { stdout: `${JSON.stringify(jobs.map(({ id, name, conclusion = "failure", steps = [] }) => ({ id, name, conclusion, steps })))}\n`, stderr: "" };
    }
    const annotations = /check-runs\/(\d+)\/annotations/.exec(url);
    if (annotations) return { stdout: JSON.stringify(jobs.find((job) => job.id === Number(annotations[1]))?.messages ?? []), stderr: "" };
    if (url.endsWith("/commits/main")) return { stdout: JSON.stringify({ sha: tip }), stderr: "" };
    const state = /branch=main&status=(\w+)/.exec(url);
    if (state) return { stdout: JSON.stringify({ total: state[1] === busy ? 1 : 0 }), stderr: "" };
    if (/actions\/runs\/\d+$/.test(url) && later) return { stdout: JSON.stringify(later), stderr: "" };
    throw new Error(`no route for ${url}`);
  };
  return { calls, exec };
}

/** @param {import("node:test").TestContext} t @param {ReturnType<typeof github>} hub @param {Record<string, unknown>} [deps] */
function retry(t, hub, deps = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "false-alarm-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ci-reruns.json");
  const logFile = path.join(dir, "decisions.jsonl");
  const recordFile = path.join(dir, "reruns.json");
  const events = /** @type {string[]} */ ([]);
  const made = createFalseAlarmRetry({
    exec: /** @type {any} */ (hub.exec),
    ghBin: "/usr/bin/gh",
    log: (event) => void events.push(event),
    file,
    logFile,
    recordFile,
    now: () => NOW,
    armed: () => true,
    stops: () => null,
    check: async () => ({ ok: true }),
    ...deps,
  });
  const decisions = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  return { ...made, file, recordFile, events, decisions };
}

const asked = (/** @type {ReturnType<typeof github>} */ hub) => hub.calls.filter((call) => call.startsWith("POST "));

test("jobVerdict: passing trouble, a bare exit line, and a real failure", () => {
  assert.equal(jobVerdict(DOWNLOAD), "action download");
  assert.equal(jobVerdict(["The runner has received a shutdown signal."]), "runner restart");
  assert.equal(jobVerdict(["Bad Gateway"]), "GitHub unavailable");
  assert.equal(jobVerdict(EXIT), "generic");
  assert.equal(jobVerdict(REAL), null);
  assert.equal(jobVerdict([]), null);
  assert.equal(jobVerdict(["   "]), null);
  assert.equal(causeOf(EXIT), null);
  assert.equal(causeOf(DOWNLOAD), "action download");
});

test("neverRetry names anything that ships, in the workflow or a job", () => {
  assert.equal(neverRetry({ workflow: "Deploy site" }), true);
  assert.equal(neverRetry({ workflow: "CI" }, ["Checks", "Publish package"]), true);
  assert.equal(neverRetry({ workflow: "CI" }, ["Release notes"]), true);
  assert.equal(neverRetry({ workflow: "CI" }, ["Checks"]), false);
});

test("a red first attempt on a passing cause gets one re-run and goes out as queued", async (t) => {
  const hub = github();
  const r = retry(t, hub);
  const [sent] = await r.cycle([run()]);
  assert.deepEqual([sent.status, sent.conclusion, sent.failedJobs], ["queued", null, undefined]);
  assert.deepEqual(asked(hub), [`POST repos/${REPO}/actions/runs/501/rerun-failed-jobs`]);
  assert.deepEqual(readRerunRecord(r.recordFile).map((one) => [one.job, one.result]), [["Checks", "pending"]]);
  assert.equal(r.decisions().at(-1).decision, "rerun");

  const [again] = await r.cycle([run()]);
  assert.equal(again.status, "queued");
  assert.equal(asked(hub).length, 1);
  assert.equal(await r.held(run()), true);
});

test("a real failure, a run that ships and an aggregate job's exit line", async (t) => {
  const real = github({ jobs: [{ id: 11, name: "Checks", messages: REAL }] });
  assert.equal((await retry(t, real).cycle([run()]))[0].status, "completed");
  assert.deepEqual(asked(real), []);

  const ships = github({ jobs: [{ id: 11, name: "Checks", messages: DOWNLOAD }, { id: 12, name: "Deploy site", conclusion: "skipped" }] });
  assert.equal((await retry(t, ships).cycle([run()]))[0].status, "completed");
  assert.deepEqual(asked(ships), []);

  const unnamed = github({ jobs: [{ id: 11, name: "", messages: DOWNLOAD }] });
  assert.equal((await retry(t, unnamed).cycle([run()]))[0].status, "completed");
  assert.deepEqual(asked(unnamed), []);

  const aggregate = github({ jobs: [{ id: 11, name: "Checks", messages: DOWNLOAD }, { id: 12, name: "CI complete", messages: EXIT }] });
  assert.equal((await retry(t, aggregate).cycle([run()]))[0].status, "queued");
  assert.equal(asked(aggregate).length, 1);

  const bareExit = github({ jobs: [{ id: 11, name: "Checks", messages: DOWNLOAD }, { id: 12, name: "Lint", messages: EXIT }] });
  assert.equal((await retry(t, bareExit).cycle([run()]))[0].status, "completed");
  assert.deepEqual(asked(bareExit), []);
});

test("only a first attempt of CI on the default repo's push, red within the window", async (t) => {
  const old = new Date(NOW.getTime() - HOLD_MS - 1000).toISOString();
  for (const extra of [{ attempt: 2 }, { workflow: "Nightly" }, { event: "pull_request" }, { repo: "example-org/other-repo" }, { updatedAt: old }, { conclusion: "cancelled" }]) {
    const hub = github();
    const before = run(extra);
    const [sent] = await retry(t, hub).cycle([before]);
    assert.equal(sent, before);
    assert.deepEqual(asked(hub), []);
  }
});

test("no repo set: the runs go through unread", async (t) => {
  const saved = process.env.RIVET_REPOS;
  delete process.env.RIVET_REPOS;
  t.after(() => void (process.env.RIVET_REPOS = saved));
  const hub = github();
  const runs = [run()];
  assert.equal(await retry(t, hub).cycle(runs), runs);
  assert.deepEqual(hub.calls, []);
});

test("a newer run on the workflow, a moved tip or a busy main each stop the ask", async (t) => {
  const newer = github();
  await retry(t, newer).cycle([run(), run({ id: 502, createdAt: NOW.toISOString(), status: "in_progress", conclusion: null })]);
  assert.deepEqual(asked(newer), []);

  const moved = github({ tip: "b".repeat(40) });
  const movedRetry = retry(t, moved);
  assert.equal((await movedRetry.cycle([run()]))[0].status, "completed");
  assert.deepEqual(asked(moved), []);
  assert.deepEqual([movedRetry.decisions()[0].decision, movedRetry.decisions()[0].reason], ["refused", "its SHA is no longer main's tip"]);
  assert.equal(JSON.parse(fs.readFileSync(movedRetry.file, "utf8")).runs[`${REPO}#501`].declined, true);

  const busy = github({ busy: "queued" });
  const busyRetry = retry(t, busy);
  await busyRetry.cycle([run()]);
  assert.deepEqual(asked(busy), []);
  assert.equal(busyRetry.decisions()[0].decision, "waiting");
  assert.equal(fs.existsSync(busyRetry.file), false);
});

test("the guard's no stands; its busy waits for the next pass", async (t) => {
  const refused = github();
  const no = retry(t, refused, { check: async () => ({ ok: false, reason: "STOP is on" }) });
  await no.cycle([run()]);
  assert.deepEqual(asked(refused), []);
  assert.equal(no.decisions()[0].decision, "refused");
  assert.equal(await no.held(run()), false);

  let busy = true;
  const waited = github();
  const later = retry(t, waited, { check: async () => (busy ? { ok: false, reason: "9 runs in progress", busy: true } : { ok: true }) });
  await later.cycle([run()]);
  assert.deepEqual(asked(waited), []);
  busy = false;
  await later.cycle([run()]);
  assert.equal(asked(waited).length, 1);
});

test("unarmed: nothing asked, held or written, and the log says what would have happened, once", async (t) => {
  const hub = github();
  const r = retry(t, hub, { armed: () => false });
  const before = run();
  assert.equal((await r.cycle([before]))[0], before);
  await r.cycle([before]);
  assert.deepEqual(asked(hub), []);
  assert.equal(fs.existsSync(r.file), false);
  assert.equal(fs.existsSync(r.recordFile), false);
  assert.deepEqual(r.decisions().map((one) => one.decision), ["would-rerun"]);
  assert.equal(await r.held(before), false);
});

test("a stop or a switch turned off under the lock asks for nothing", async (t) => {
  const stopped = github();
  const r = retry(t, stopped, { stops: () => "STOP" });
  assert.equal((await r.cycle([run()]))[0].status, "completed");
  assert.deepEqual(asked(stopped), []);
  assert.equal(r.decisions()[0].reason, "STOP");

  let reads = 0;
  const dropped = github();
  const off = retry(t, dropped, { armed: () => reads++ < 1 });
  await off.cycle([run()]);
  assert.deepEqual(asked(dropped), []);
  assert.equal(fs.existsSync(off.recordFile), false);
});

test("one re-run per job per SHA, across runs", async (t) => {
  const hub = github();
  const r = retry(t, hub);
  fs.writeFileSync(r.recordFile, JSON.stringify({ jobs: [{ job: "Checks", sha: SHA, at: NOW.toISOString(), run: 400, attempt: 1, cause: "action download", result: "failed" }] }));
  assert.equal((await r.cycle([run()]))[0].status, "completed");
  assert.deepEqual(asked(hub), []);
  assert.equal(r.decisions().at(-1).reason, "Checks already had its re-run on this SHA");
});

test("an ask whose answer was lost holds only for the short window, and asks once", async (t) => {
  const hub = github({ rerunFails: true });
  const r = retry(t, hub);
  assert.equal((await r.cycle([run()]))[0].status, "queued");
  assert.equal(JSON.parse(fs.readFileSync(r.file, "utf8")).runs[`${REPO}#501`].unsure, true);
  assert.deepEqual(r.events, ["ci-rerun-unsure"]);
  await r.cycle([run()]);
  assert.equal(asked(hub).length, 1);

  const past = new Date(NOW.getTime() + UNSURE_HOLD_MS + 1000);
  const [shown] = await createFalseAlarmRetry({
    exec: /** @type {any} */ (github({ later: { attempt: 1, status: "completed", conclusion: "failure" } }).exec),
    ghBin: "/usr/bin/gh",
    log: () => {},
    file: r.file,
    logFile: path.join(path.dirname(r.file), "decisions.jsonl"),
    recordFile: r.recordFile,
    now: () => past,
    armed: () => true,
    stops: () => null,
    check: async () => ({ ok: true }),
  }).cycle([run()]);
  assert.equal(shown.status, "completed");
});

test("a list that cannot be read asks for nothing and shows the run red", async (t) => {
  const hub = github();
  const r = retry(t, hub);
  fs.writeFileSync(r.file, "not json");
  assert.equal((await r.cycle([run()]))[0].status, "completed");
  assert.deepEqual(asked(hub), []);
  assert.equal(await r.held(run()), false);
  assert.ok(r.events.includes("ci-rerun-list-unreadable"));
});

test("jobs that cannot be read leave the run red and are read again next pass", async (t) => {
  const hub = github();
  const { exec } = hub;
  let broken = true;
  hub.exec = async (bin, args) => {
    if (broken && args[1].includes("/attempts/")) throw new Error("gh failed");
    return exec(bin, args);
  };
  const r = retry(t, hub);
  assert.equal((await r.cycle([run()]))[0].status, "completed");
  assert.ok(r.events.includes("ci-rerun-check-failed"));
  broken = false;
  assert.equal((await r.cycle([run()]))[0].status, "queued");
});

test("a re-run that ended is seen through, green or red", async (t) => {
  for (const [conclusion, result, decision] of [["success", "passed", "passed"], ["failure", "failed", "stayed-red"]]) {
    const hub = github({ later: { attempt: 2, status: "completed", conclusion } });
    const r = retry(t, hub);
    await r.cycle([run()]);
    await r.cycle([run({ attempt: 2, status: "completed", conclusion })]);
    assert.equal(readRerunRecord(r.recordFile)[0].result, result);
    assert.equal(r.decisions().at(-1).decision, decision);
  }
});

test("checkRerun: the stop, ships, unnamed, busy and a failed read each refuse", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rerun-check-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  /** @param {number} running @param {number} queued */
  const gh = (running, queued) => async (/** @type {string[]} */ args) => ({ total: args[0].includes("in_progress") ? running : queued });
  const facts = { repo: REPO, workflow: "CI", names: ["Checks"] };

  assert.deepEqual(await checkRerun(facts, { gh: gh(0, 0), home }), { ok: true });
  assert.equal((await checkRerun({ ...facts, workflow: "Deploy site" }, { gh: gh(0, 0), home })).reason, "a workflow that ships: Deploy site");
  assert.equal((await checkRerun({ ...facts, names: ["Publish"] }, { gh: gh(0, 0), home })).reason, "a job that ships: Publish");
  assert.equal((await checkRerun({ ...facts, names: [null] }, { gh: gh(0, 0), home })).reason, "a failed job or step has no name");
  assert.deepEqual(await checkRerun(facts, { gh: gh(RUNNING_LIMIT, 0), home }), { ok: false, reason: `${RUNNING_LIMIT} runs in progress`, busy: true });
  assert.deepEqual(await checkRerun(facts, { gh: gh(0, QUEUED_LIMIT), home }), { ok: false, reason: `${QUEUED_LIMIT} runs queued`, busy: true });
  assert.equal((await checkRerun(facts, { gh: async () => ({}), home })).reason, "read failed: run counts not read");

  fs.mkdirSync(path.join(home, ".rivet-agents", "auto-handlers"), { recursive: true });
  fs.writeFileSync(path.join(home, ".rivet-agents", "auto-handlers", "STOP"), "");
  assert.ok(stopSwitch(home));
  assert.match((await checkRerun(facts, { gh: gh(0, 0), home })).reason, /STOP is on$/);
});

test("armState: armed needs its file, and either off file wins", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rerun-arm-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(armState("main-rerun", dir), { armed: false, reason: "not armed" });
  fs.writeFileSync(path.join(dir, "main-rerun.armed"), "");
  assert.deepEqual(armState("main-rerun", dir), { armed: true, reason: "armed" });
  fs.writeFileSync(path.join(dir, "main-rerun.off"), "");
  assert.deepEqual(armState("main-rerun", dir), { armed: false, reason: "main-rerun.off" });
  fs.writeFileSync(path.join(dir, "off"), "");
  assert.deepEqual(armState("main-rerun", dir), { armed: false, reason: "off" });
});
