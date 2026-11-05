import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ExecError } from "../lib/config.mjs";
import { calendarOf, chatArgs, readCommand, jobLabel, jobPrompt, plistText, programArgs, runJobAction, validJobAction } from "../lib/jobs.mjs";
import { LAUNCHCTL_BIN } from "../lib/ops/mac.mjs";
import { collectMac, PLUTIL_BIN } from "../lib/schedules/index.mjs";
import { CLONE_SYNC, held, main, outputCollector, readUsage, runCheck, spawnRun, stopped, upUrl } from "../../scripts/job-run.mjs";
import { withRival } from "../../scripts/lock-race-fixture.mjs";
import { tryLock } from "../../scripts/token-lock.mjs";

// A UTC+10 zone with daylight saving and one repo: the Mac's own settings must not change these tests.
const ZONE = "Antarctica/Macquarie";
const REPO = "example-org/example-repo";
process.env.RIVET_TIME_ZONE = ZONE;
process.env.RIVET_REPOS = REPO;

const JOB_RUN_FILE = path.resolve(import.meta.dirname, "../../scripts/job-run.mjs");
const ID = "j-abc12345";
const NODE = "/usr/local/bin/node";
const BASE = path.join(os.tmpdir(), "rivet-agents-fixture");
const JOB_RUN = path.join(BASE, "scripts", "job-run.mjs");
const LOGS = path.join(BASE, "logs");
// The runner's clock starts at 2026-10-24T07:00:00Z, 6pm local.
const ON_TIME = "0 18 * * *";
// Assembled here so no token shape sits in the source.
const FAKE_TOKEN = `${"gh"}p_abcdefghijklmnopqrstuvwxyz0123456789AB`;
const CHECK = { op: "create", id: ID, spec: { name: "Typecheck", words: "typecheck main every 6 hours", kind: "check", check: { script: "typecheck", onRed: "card" }, cron: "15 */6 * * *" } };
const UP = { op: "create", id: ID, spec: { name: "Sample app up", words: "check the sample app is up", kind: "check", check: { probe: "up", app: "sample-app", onRed: "card" }, cron: "0 7 * * *" } };
const TASK = { op: "create", id: ID, spec: { name: "Issues", words: 'look over the open issues"; rm -rf ~ $(id)', kind: "task", cron: "0 9 * * 1" } };
const LABEL = jobLabel(ID);

test("the Mac takes only a job action the server would have made", () => {
  assert.deepEqual(validJobAction(CHECK), CHECK);
  assert.deepEqual(validJobAction(UP), UP);
  assert.deepEqual(validJobAction(TASK), TASK);
  assert.deepEqual(validJobAction({ op: "pause", id: ID }), { op: "pause", id: ID });
  assert.deepEqual(validJobAction({ ...CHECK, spec: { ...CHECK.spec, check: { ...CHECK.spec.check, where: "mac" } } }), CHECK, "an older job's where is dropped");
  for (const bad of [
    null,
    { op: "pause", id: ID, spec: CHECK.spec },
    { op: "merge", id: ID },
    { op: "run", id: "j-../../x" },
    { ...CHECK, spec: { ...CHECK.spec, check: { ...CHECK.spec.check, script: "deploy:site" } } },
    { ...CHECK, spec: { ...CHECK.spec, check: { ...CHECK.spec.check, script: "test; rm -rf ~" } } },
    { ...CHECK, spec: { ...CHECK.spec, check: { ...CHECK.spec.check, onRed: "shout" } } },
    { ...CHECK, spec: { ...CHECK.spec, check: { ...CHECK.spec.check, where: "elsewhere" } } },
    { ...CHECK, spec: { ...CHECK.spec, check: { ...CHECK.spec.check, script: "publish" } } },
    { ...UP, spec: { ...UP.spec, check: { ...UP.spec.check, app: "../x" } } },
    { ...UP, spec: { ...UP.spec, check: { ...UP.spec.check, where: "remote" } } },
    { ...UP, spec: { ...UP.spec, check: { ...UP.spec.check, onRed: "look" } } },
    { ...UP, spec: { ...UP.spec, check: { ...UP.spec.check, script: "typecheck" } } },
    { ...CHECK, spec: { ...CHECK.spec, cron: "0 7 * * * ; id" } },
    { ...CHECK, spec: { ...CHECK.spec, words: "line one\nline two" } },
    { ...TASK, spec: { ...TASK.spec, check: CHECK.spec.check } },
  ])
    assert.equal(validJobAction(bad), null, JSON.stringify(bad));
});

const PATHS = { rivet: path.join(BASE, "bin", "rivet"), logDir: path.join(BASE, "jobs", "logs") };
const RUN = "r-run-0002";

const plistJson = (text) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-plist-"));
  try {
    fs.writeFileSync(path.join(dir, "job.plist"), text);
    return JSON.parse(execFileSync(PLUTIL_BIN, ["-convert", "json", "-o", "-", path.join(dir, "job.plist")], { encoding: "utf8" }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test("a job's LaunchAgent: its label, node and job-run with the job id, the local cron as a calendar, PATH and HOME baked, and none of the owner's words", () => {
  const deps = { nodeBin: NODE, jobRun: JOB_RUN, logsDir: LOGS, env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: BASE } };
  const hostile = { ...TASK, spec: { ...TASK.spec, name: '</string><key>RunAtLoad</key><true/> & "x"', words: "look <here> & 'there'" } };
  const text = plistText(deps, hostile);
  assert.ok(!text.includes("RunAtLoad"), "the owner's words never reach the plist");
  assert.ok(!text.includes("look"), "the owner's words never reach the plist");
  assert.ok(text.includes(`<string>${LABEL}</string>`));
  assert.deepEqual(programArgs(deps, ID, "0 9 * * 1"), [NODE, JOB_RUN, ID, "--launchd", "0 9 * * 1"]);
  if (fs.existsSync(PLUTIL_BIN)) {
    const plist = plistJson(text);
    assert.deepEqual(plist, {
      Label: "dev.rivet-agents.job-j-abc12345",
      ProgramArguments: [NODE, JOB_RUN, ID, "--launchd", "0 9 * * 1"],
      EnvironmentVariables: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: BASE },
      StartCalendarInterval: [{ Minute: 0, Hour: 9, Weekday: 1 }],
      AbandonProcessGroup: true,
      StandardOutPath: path.join(LOGS, `job-${ID}.log`),
      StandardErrorPath: path.join(LOGS, `job-${ID}.log`),
    });
    // Every value is an escaped string: a PATH or HOME with markup in it stays one value.
    const odd = plistJson(plistText({ ...deps, env: { PATH: "/a&b:/c<d>", HOME: '/home/x"</string><key>RunAtLoad</key><true/>' } }, TASK));
    assert.deepEqual(odd.EnvironmentVariables, { PATH: "/a&b:/c<d>", HOME: '/home/x"</string><key>RunAtLoad</key><true/>' });
    assert.equal(odd.RunAtLoad, undefined);
  }
  assert.ok(plistText({ ...deps, env: { PATH: "/a&b:/c<d>", HOME: "/h" } }, TASK).includes("<string>/a&amp;b:/c&lt;d&gt;</string>"));
  assert.throws(() => plistText({ ...deps, env: { PATH: "/bin\n<key>x</key>", HOME: "/h" } }, TASK));

  assert.deepEqual(calendarOf("15 */6 * * *"), [0, 6, 12, 18].map((Hour) => ({ Minute: 15, Hour })));
  assert.deepEqual(calendarOf("30 * * * *"), [{ Minute: 30 }]);
  assert.deepEqual(calendarOf("0 7 * * 1-5"), [1, 2, 3, 4, 5].map((Weekday) => ({ Minute: 0, Hour: 7, Weekday })));
  assert.deepEqual(calendarOf("0 7 * * *"), [{ Minute: 0, Hour: 7 }]);
  assert.throws(() => calendarOf("*/5 */2 * * 1-5"));
  assert.throws(() => calendarOf("0 9 * *"));

  const prompt = jobPrompt(ID, RUN, TASK.spec, PATHS);
  assert.ok(prompt.includes(`<owner-words>\n${TASK.spec.words}\n</owner-words>`));
  assert.match(prompt, /Never merge, deploy/);
  assert.ok(prompt.includes(`${PATHS.rivet} job report ${ID} --run ${RUN} --green`));
  const lookPrompt = jobPrompt(ID, RUN, { ...CHECK.spec, check: { ...CHECK.spec.check, onRed: "look" }, line: "Failed: boom" }, PATHS);
  assert.ok(lookPrompt.includes(path.join(PATHS.logDir, `${ID}-latest.log`)));
  assert.ok(lookPrompt.includes(`rivet job report ${ID} --run ${RUN} --red`));
  assert.throws(() => programArgs({ nodeBin: "/opt/a b/node", jobRun: JOB_RUN }, ID, "0 9 * * 1"));
  assert.throws(() => programArgs({ nodeBin: NODE, jobRun: "/x/$(id)/job-run.mjs" }, ID, "0 9 * * 1"));
  assert.throws(() => programArgs({ nodeBin: NODE, jobRun: JOB_RUN }, "j-../../x", "0 9 * * 1"));
  for (const cron of ["0 9 * * 1; id", "0 9 * *", "*/5 */2 * * 1-5", "0 9 * * 1 ", undefined]) assert.throws(() => programArgs({ nodeBin: NODE, jobRun: JOB_RUN }, ID, /** @type {any} */ (cron)), String(cron));
});

test("a job's chat: claude -p on Opus that can read and report, and never merge, deploy, edit, commit or push", () => {
  const args = chatArgs(ID, RUN, TASK.spec, PATHS);
  const flag = (name) => args[args.indexOf(name) + 1];
  const list = (name) => {
    const from = args.indexOf(name) + 1;
    const to = args.findIndex((arg, i) => i >= from && arg.startsWith("--"));
    return args.slice(from, to === -1 ? undefined : to);
  };
  assert.equal(args[0], "-p");
  assert.equal(args[1], jobPrompt(ID, RUN, TASK.spec, PATHS));
  assert.equal(flag("--model"), "claude-opus-5-5");
  assert.equal(flag("--permission-mode"), "dontAsk");
  assert.equal(flag("--permission-prompts"), "none");
  assert.equal(flag("--setting-sources"), "", "no user, project or local settings file loads");
  assert.deepEqual(JSON.parse(flag("--settings")), { disableAllHooks: true, permissions: { disableBypassPermissionsMode: "disable" } });
  assert.equal(flag("--tools"), "Read,Grep,Glob,Bash");
  for (const bypass of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "bypassPermissions", "--bare", "--add-dir", "--mcp-config"])
    assert.ok(!args.includes(bypass), bypass);
  assert.equal(args.filter((arg) => arg === "--allowedTools" || arg === "--disallowedTools").length, 2);

  const allowed = list("--allowedTools");
  assert.deepEqual(allowed, [
    "Read",
    "Grep",
    "Glob",
    `Bash(${PATHS.rivet} job read:*)`,
    `Bash(${PATHS.rivet} job report ${ID} --run ${RUN}:*)`,
  ]);
  assert.deepEqual(allowed.filter((entry) => /^Bash\((gh|git)\b/.test(entry)), [], "no raw gh or git rule: a prefix cannot stop the flags after it");
  for (const entry of allowed) {
    assert.ok(!/^(Bash|Edit|Write|NotebookEdit|WebFetch|Agent|Task)$/.test(entry), `${entry} is a whole tool`);
    assert.ok(!/^Bash\((gh|git|pnpm|node|npx|sh|bash|zsh|env|fly|flyctl|scripts\/\S*|\S*rivet)(:\*|\s?\*)?\)$/.test(entry), `${entry} is broad`);
    assert.ok(!/\b(merge|create|edit|close|api|workflow|push|commit|reset|checkout|deploy|promote|rm|curl|wget)\b/.test(entry.replace(/^Bash\(\/\S+ job report /, "")), `${entry} may write`);
  }
  const denied = list("--disallowedTools");
  for (const entry of ["Edit", "Write", "NotebookEdit", "Bash(gh pr merge:*)", "Bash(pnpm deploy:*)", "Bash(git push:*)", "Bash(git commit:*)", "Bash(gh api:*)", "Bash(fly:*)", "Bash(flyctl:*)", "Bash(rm:*)"])
    assert.ok(denied.includes(entry), entry);
  assert.deepEqual(allowed.filter((entry) => denied.includes(entry)), []);
  assert.throws(() => chatArgs(ID, "r 1", TASK.spec, PATHS));
  assert.throws(() => chatArgs(ID, RUN, TASK.spec, { ...PATHS, rivet: "/x/$(id)/rivet" }));
});

test("job read runs only a listed gh or git read: gh on this repository on github.com, git with no external diff or pager", async () => {
  for (const argv of [
    ["gh", "issue", "list", "--repo", "evil.host/a/b"],
    ["gh", "issue", "list", "-R", "a/b"],
    ["gh", "issue", "list", "--repo=evil.host/a/b"],
    ["gh", "pr", "list", "--web"],
    ["gh", "pr", "list", "-w"],
    ["gh", "pr", "list", "--hostname", "evil.host"],
    ["gh", "issue", "view", "https://evil.host/a/b/issues/1"],
    ["gh", "issue", "view", "evil.host/a/b#1"],
    ["gh", "run", "list", "--branch", "https://evil.host/x"],
    ["gh", "issue", "list", "--jq", ".[]"],
    ["gh", "pr", "merge", "1"],
    ["gh", "api", "/user"],
    ["gh", "run", "rerun", "1"],
    ["git", "diff", "--output=x"],
    ["git", "diff", "--output", "x"],
    ["git", "log", "--output=/tmp/x"],
    ["git", "-c", "x=y", "log"],
    ["git", "log", "-c", "x=y"],
    ["git", "diff", "--ext-diff"],
    ["git", "diff", "--textconv"],
    ["git", "diff", "--no-index", "/etc/passwd", "x"],
    ["git", "show", "HEAD:../secret"],
    ["git", "diff", "--", "../../etc/passwd"],
    ["git", "diff", "/etc/passwd"],
    ["git", "log", "--exec=x"],
    ["git", "push", "--dry-run"],
    ["git", "commit", "-m", "x"],
    ["git", "log", "-n", "five"],
    ["pnpm", "deploy:site", "sample-app"],
    ["fly", "deploy"],
    [],
    // A search or filter value that could leave gh's query group or name another repository.
    ["gh", "pr", "list", "--search", "repo:cli/cli is:pr) OR (repo:cli/cli"],
    ["gh", "issue", "list", "--search", "repo:other/private ) OR ( repo:other/private"],
    ["gh", "issue", "list", "--search", "is:open org:other"],
    ["gh", "issue", "list", "--search", "USER: someone"],
    ["gh", "issue", "list", "--label", 'x" OR "y'],
    ["gh", "issue", "list", "--search", "a\\b"],
  ])
    assert.throws(() => readCommand(argv), /job read refuses/, argv.join(" "));
  assert.deepEqual(readCommand(["gh", "issue", "list", "--search", "is:open label:bug crash"]).args.slice(2, 4), ["--search", "is:open label:bug crash"]);

  const gh = readCommand(["gh", "issue", "list", "--limit", "1", "--state", "open", "--json", "number,title"]);
  assert.deepEqual(gh.args, ["issue", "list", "--limit", "1", "--state", "open", "--json", "number,title", "--repo", REPO]);
  assert.equal(gh.env.GH_HOST, "github.com");
  assert.deepEqual(readCommand(["gh", "run", "view", "123456789", "--log-failed"]).args.slice(0, 4), ["run", "view", "123456789", "--log-failed"]);
  const git = readCommand(["git", "log", "--oneline", "-n", "5", "origin/main", "--", "src"]);
  assert.deepEqual(git.args, ["-c", "core.pager=cat", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "--no-pager", "log", "--no-ext-diff", "--no-textconv", "--no-color", "--oneline", "-n", "5", "origin/main", "--", "src"]);
  assert.deepEqual(readCommand(["git", "diff", "--stat", "HEAD~3..HEAD"]).args.slice(-2), ["--stat", "HEAD~3..HEAD"]);
  assert.deepEqual(readCommand(["git", "status", "--short"]).args.slice(-2), ["status", "--short"]);
});

/**
 * A fake launchctl over a temporary LaunchAgents folder: bootstrap loads a job, bootout unloads it, print finds a
 * loaded one. `installed` puts the job's plist there first, `loaded` has launchd hold it, `fail` makes one verb fail.
 */
function launchdStub(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-job-"));
  const agentsDir = path.join(dir, "LaunchAgents");
  const logsDir = path.join(dir, "logs");
  fs.mkdirSync(agentsDir, { recursive: true });
  if (opts.installed) fs.writeFileSync(path.join(agentsDir, `${LABEL}.plist`), "<plist/>");
  const loaded = new Set(opts.loaded ? [`gui/501/${LABEL}`] : []);
  const calls = [];
  let linger = 0;
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === NODE) {
      if (opts.manual instanceof Error) throw opts.manual;
      return { stdout: `${opts.manual ?? "background"}\n`, stderr: "" };
    }
    if (file !== LAUNCHCTL_BIN) throw new Error(`unexpected exec ${file}`);
    if (opts.fail === args[0]) throw new ExecError(LAUNCHCTL_BIN, { code: 5 }, `${args[0]} failed`, "");
    if (args[0] === "bootstrap") {
      if (loaded.has(`${args[1]}/${LABEL}`)) throw new ExecError(LAUNCHCTL_BIN, { code: 5 }, "Bootstrap failed: 5: Input/output error", "");
      loaded.add(`${args[1]}/${LABEL}`);
    }
    if (args[0] === "bootout") {
      if (!loaded.delete(args[1])) throw new ExecError(LAUNCHCTL_BIN, { code: 3 }, "No such process", "");
      // launchd tears a job down after bootout returns: `lingers` prints still find it.
      linger = opts.lingers ?? 0;
    }
    if (args[0] === "print" && opts.printError) throw new ExecError(LAUNCHCTL_BIN, { code: 5 }, "Input/output error", "");
    if (args[0] === "print" && linger > 0) {
      linger--;
      return { stdout: "state = running\n", stderr: "" };
    }
    if (args[0] === "print" && !loaded.has(args[1])) throw new ExecError(LAUNCHCTL_BIN, { code: 113 }, "Could not find service", "");
    return { stdout: "", stderr: "" };
  };
  const deps = {
    exec,
    nodeBin: NODE,
    jobRun: JOB_RUN,
    agentsDir,
    logsDir,
    uid: 501,
    macZone: opts.macZone ?? ZONE,
    env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: BASE, RIVET_TIME_ZONE: ZONE },
    sleep: async () => {},
    log: () => {},
  };
  const plist = path.join(agentsDir, `${LABEL}.plist`);
  return { calls, deps, plist, loaded, launchctl: () => calls.filter((call) => call[0] === LAUNCHCTL_BIN).map((call) => call.slice(1)), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("makes, switches and removes only the job's own LaunchAgent, with fixed launchctl arguments", async () => {
  const TARGET = `gui/501/${LABEL}`;
  const stubs = [];
  const stub = (opts) => (stubs.push(launchdStub(opts)), stubs.at(-1));
  try {
    const fresh = stub();
    assert.deepEqual(await runJobAction(fresh.deps, CHECK), { status: "succeeded", reason: "Set on the Mac." });
    assert.deepEqual(fresh.launchctl(), [["bootout", TARGET], ["print", TARGET], ["enable", TARGET], ["bootstrap", "gui/501", fresh.plist]]);
    assert.equal(fs.readFileSync(fresh.plist, "utf8"), plistText(fresh.deps, CHECK));
    assert.ok(fs.existsSync(fresh.deps.logsDir));
    assert.ok(fresh.loaded.has(TARGET));

    // A make over one already there (interrupted, or paused) unloads it, writes it again and switches it on.
    const again = stub({ installed: true, loaded: true });
    assert.deepEqual(await runJobAction(again.deps, CHECK), { status: "succeeded", reason: "It was set on the Mac already, and is set again and on." });
    assert.deepEqual(again.launchctl(), [["bootout", TARGET], ["print", TARGET], ["enable", TARGET], ["bootstrap", "gui/501", again.plist]]);
    const stuck = stub({ fail: "bootstrap" });
    assert.equal((await runJobAction(stuck.deps, CHECK)).status, "failed");
    const abroad = stub({ macZone: "Europe/Berlin" });
    assert.deepEqual(await runJobAction(abroad.deps, CHECK), { status: "refused", reason: `The Mac's clock is on Europe/Berlin, not ${ZONE}, so the job would run at the wrong hour.` });
    assert.deepEqual(abroad.launchctl(), []);

    const paused = stub({ installed: true, loaded: true });
    assert.deepEqual(await runJobAction(paused.deps, { op: "pause", id: ID }), { status: "succeeded", reason: "Paused on the Mac." });
    assert.deepEqual(paused.launchctl(), [["disable", TARGET], ["bootout", TARGET], ["print", TARGET]]);
    const unpaused = stub({ installed: true });
    assert.deepEqual(await runJobAction(unpaused.deps, { op: "resume", id: ID }), { status: "succeeded", reason: "On again on the Mac." });
    assert.deepEqual(unpaused.launchctl(), [["enable", TARGET], ["bootstrap", "gui/501", unpaused.plist], ["print", TARGET]]);
    const stillOn = stub({ installed: true, loaded: true, fail: "bootout" });
    assert.equal((await runJobAction(stillOn.deps, { op: "pause", id: ID })).status, "failed");

    const removed = stub({ installed: true, loaded: true });
    assert.deepEqual(await runJobAction(removed.deps, { op: "remove", id: ID }), { status: "succeeded", reason: "Removed from the Mac." });
    assert.deepEqual(removed.launchctl(), [["bootout", TARGET], ["print", TARGET]]);
    assert.ok(!fs.existsSync(removed.plist));
    const none = stub();
    assert.deepEqual(await runJobAction(none.deps, { op: "remove", id: ID }), { status: "succeeded", reason: "It was not on the Mac." });
    const kept = stub({ installed: true, loaded: true, fail: "bootout" });
    assert.equal((await runJobAction(kept.deps, { op: "remove", id: ID })).status, "failed");
    assert.ok(fs.existsSync(kept.plist), "a job launchd still holds keeps its plist");

    for (const op of ["pause", "resume", "run"]) {
      const gone = stub();
      assert.deepEqual(await runJobAction(gone.deps, { op, id: ID }), { status: "failed", reason: "Its schedule on the Mac is gone: delete the job and set it again." }, op);
      assert.deepEqual(gone.launchctl(), [], op);
    }
  } finally {
    for (const one of stubs) one.cleanup();
  }
});

test("an unload waits for launchd to drop the job, and a look launchctl could not make is never taken for gone", async () => {
  const TARGET = `gui/501/${LABEL}`;
  const stubs = [];
  const stub = (opts) => (stubs.push(launchdStub(opts)), stubs.at(-1));
  try {
    for (const lingers of [1, 2]) {
      const removed = stub({ installed: true, loaded: true, lingers });
      assert.deepEqual(await runJobAction(removed.deps, { op: "remove", id: ID }), { status: "succeeded", reason: "Removed from the Mac." }, `gone on print ${lingers + 1}`);
      assert.equal(removed.launchctl().filter((call) => call[0] === "print").length, lingers + 1);
      assert.ok(!fs.existsSync(removed.plist));
      const paused = stub({ installed: true, loaded: true, lingers });
      assert.equal((await runJobAction(paused.deps, { op: "pause", id: ID })).status, "succeeded");
      const made = stub({ installed: true, loaded: true, lingers });
      assert.equal((await runJobAction(made.deps, CHECK)).status, "succeeded");
      assert.deepEqual(made.launchctl().at(-1), ["bootstrap", "gui/501", made.plist]);
    }

    const stays = stub({ installed: true, loaded: true, lingers: 1_000 });
    assert.equal((await runJobAction(stays.deps, { op: "remove", id: ID })).status, "failed");
    assert.equal(stays.launchctl().filter((call) => call[0] === "print").length, 50);
    assert.ok(fs.existsSync(stays.plist), "a job launchd still holds keeps its plist");
    const stuckMake = stub({ installed: true, loaded: true, lingers: 1_000 });
    assert.equal((await runJobAction(stuckMake.deps, CHECK)).status, "failed");
    assert.ok(!stuckMake.launchctl().some((call) => call[0] === "bootstrap"));

    for (const op of ["remove", "pause"]) {
      const blind = stub({ installed: true, loaded: true, printError: true });
      assert.equal((await runJobAction(blind.deps, { op, id: ID })).status, "failed", op);
      assert.deepEqual(blind.launchctl().filter((call) => call[0] === "print"), [["print", TARGET]], op);
      assert.ok(fs.existsSync(blind.plist), op);
    }
    const blindMake = stub({ printError: true });
    assert.equal((await runJobAction(blindMake.deps, CHECK)).status, "failed");
    assert.ok(!fs.existsSync(blindMake.plist));
    const blindResume = stub({ installed: true, printError: true });
    assert.equal((await runJobAction(blindResume.deps, { op: "resume", id: ID })).status, "failed");
  } finally {
    for (const one of stubs) one.cleanup();
  }
});

test("Run now asks the server through job-run first, and the task's chat or the check runs in the background", async () => {
  const task = launchdStub({ installed: true, loaded: true });
  const bound = launchdStub({ installed: true, loaded: true });
  const skipped = launchdStub({ installed: true, loaded: true, manual: new ExecError(NODE, { code: 1 }, "", "skipped: usage high\n") });
  try {
    assert.deepEqual(await runJobAction(task.deps, { op: "run", id: ID }), { status: "succeeded", reason: "Started on the Mac." });
    assert.deepEqual(task.calls, [[NODE, JOB_RUN, "--manual", ID]]);
    await runJobAction(bound.deps, { op: "run", id: ID }, "act-00000007");
    assert.deepEqual(bound.calls, [[NODE, JOB_RUN, "--manual", ID, "--action", "act-00000007"]]);
    assert.deepEqual(await runJobAction(skipped.deps, { op: "run", id: ID }), { status: "refused", reason: "skipped: usage high" });
    assert.deepEqual(skipped.launchctl(), []);
  } finally {
    for (const one of [task, bound, skipped]) one.cleanup();
  }
});

test("Ops › Schedules leaves the jobs' LaunchAgents to Ops › Scheduled", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-job-list-"));
  try {
    for (const label of [LABEL, "dev.rivet-agents.test-writer"]) fs.writeFileSync(path.join(dir, `${label}.plist`), "<plist/>");
    const exec = async (file, args) => {
      if (file === PLUTIL_BIN) return { stdout: JSON.stringify({ Label: path.basename(args[4], ".plist"), StartCalendarInterval: { Hour: 2, Minute: 0 } }), stderr: "" };
      if (args[0] === "print-disabled") return { stdout: "", stderr: "" };
      throw new ExecError(LAUNCHCTL_BIN, { code: 113 }, "Could not find service", "");
    };
    const items = await collectMac({ exec, now: Date.now(), agentsDir: dir, uid: 501, macZone: ZONE, plists: new Map() });
    assert.deepEqual(items.map((item) => item.id), ["mac:dev.rivet-agents.test-writer"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// job-run.mjs

/** What spawnRun gives for this output: the fakes print raw lines, as a check does. */
function printed(result) {
  const out = outputCollector();
  out.take(result.lines.join("\n"));
  return { ...result, lines: out.end() };
}

function runner(opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-jobrun-"));
  if (opts.repo !== false) {
    fs.mkdirSync(path.join(home, ".rivet-agents", "jobs", "repo", ".git"), { recursive: true });
    fs.writeFileSync(path.join(home, ".rivet-agents", "jobs", "repo", "package.json"), JSON.stringify({ scripts: { "validate:docs": "node lint.js", typecheck: "tsc" } }));
  }
  const puts = [];
  const ran = [];
  const detached = [];
  const out = [];
  let now = Date.parse("2026-10-24T07:00:00Z");
  const d = {
    env: { RIVET_URL: "http://localhost:5230", ...(opts.noRepoSet ? {} : { RIVET_REPOS: REPO }) },
    home,
    now: () => (now += 1000),
    token: async () => "c".repeat(64),
    bin: () => "/opt/pnpm",
    stdout: (s) => out.push(s),
    detach: (args) => detached.push(args),
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      puts.push({ url, method: init.method, body, auth: init.headers.authorization });
      if (url.endsWith("/report")) return new Response(JSON.stringify({ ok: opts.report !== 409 }), { status: opts.report ?? 200 });
      const answer =
        body.state === "start" ? (opts.start ?? { go: true, run: body.run, job: { id: ID, kind: "check", check: { script: "validate:docs", onRed: "card" } } }) : body.state === "look" ? (opts.look ?? { go: true, run: body.run }) : { ok: true };
      return new Response(JSON.stringify(answer), { status: 200 });
    },
    run: async (bin, args, { cwd, env, timeoutMs }) => {
      ran.push({ bin, args, cwd, env, timeoutMs });
      if (args[0] === "repo" && args[1] === "clone") {
        if (opts.clones) fs.mkdirSync(path.join(args[3], ".git"), { recursive: true });
        return { code: opts.clones ? 0 : 1, lines: [], timedOut: false };
      }
      if (bin === "/usr/bin/git" || args[0] === "install") return { code: 0, lines: [], timedOut: false };
      return printed(opts.result ?? { code: 0, lines: ["all good"], timedOut: false });
    },
  };
  return { d, home, puts, ran, detached, out, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}
const check = (extra = {}) => ({ go: true, run: "r-run-0001", job: { id: ID, kind: "check", name: "Lint", words: "lint the docs", check: { script: "validate:docs", onRed: "card", ...extra } } });

test("job-run: a card check starts, runs on in the background and opens no chat", async () => {
  const r = runner({ start: check() });
  try {
    assert.equal(await main([ID, "--launchd", ON_TIME], r.d), 0);
    assert.equal(r.puts[0].url, `http://localhost:5230/api/bridge/jobs/${ID}/runs`);
    assert.equal(r.puts[0].auth, `Bearer ${"c".repeat(64)}`);
    assert.equal(r.puts[0].body.state, "start");
    assert.deepEqual(r.detached, [["--exec", ID, "r-run-0001"]]);
    assert.deepEqual(r.ran, []);
    assert.equal(await main(["--manual", ID], r.d), 0);
    assert.equal(r.puts[1].body.manual, true);
    assert.equal(r.puts[1].body.action, undefined);
    assert.equal(await main(["--manual", ID, "--action", "act-00000007"], r.d), 0);
    assert.deepEqual([r.puts[2].body.manual, r.puts[2].body.action], [true, "act-00000007"]);
    assert.deepEqual(r.detached[1], ["--exec", ID, "r-run-0001", "--manual"]);
    assert.equal(r.out.at(-1), "background\n");
    for (const argv of [["--manual", ID, "--action"], ["--manual", ID, "--action", "a b"], ["--manual", ID, "--run", "x"], [ID, "--action", "act-1"]]) assert.equal(await main(argv, r.d), 2, argv.join(" "));
  } finally {
    r.cleanup();
  }
});

test("job-run: the background run brings its clone to the default branch, runs only pnpm <script> and reports the last lines", async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `note ${i}: ok`);
  lines.push(`${FAKE_TOKEN} leaked`, "note 7: README.md is over its line cap");
  const r = runner({ start: check(), result: { code: 1, lines, timedOut: false } });
  try {
    assert.equal(await main(["--exec", ID, "r-run-0001"], r.d), 1);
    const repo = path.join(r.home, ".rivet-agents", "jobs", "repo");
    assert.deepEqual(
      r.ran.map((call) => [call.bin, ...call.args.filter((arg) => !arg.startsWith("core.hooksPath") && arg !== "-c")].slice(0, 3)),
      [["/usr/bin/git", "fetch", "-q"], ["/usr/bin/git", "checkout", "-q"], ["/usr/bin/git", "clean", "-fdq"], ["/opt/pnpm", "install", "--frozen-lockfile"], ["/opt/pnpm", "run", "validate:docs"]],
    );
    assert.ok(r.ran.every((call) => call.cwd === repo));
    const finish = r.puts.at(-1).body;
    assert.equal(finish.state, "red");
    assert.equal(finish.line, "Failed: note 7: README.md is over its line cap");
    assert.equal(finish.log.length, 20);
    assert.ok(!JSON.stringify(finish).includes(FAKE_TOKEN.slice(0, 14)), "the log is redacted");
    assert.ok(!fs.readFileSync(path.join(r.home, ".rivet-agents", "jobs", "logs", `${ID}-latest.log`), "utf8").includes(FAKE_TOKEN.slice(0, 14)));
    assert.ok(!fs.existsSync(path.join(r.home, ".rivet-agents", "jobs", "lock")), "the lock is let go");
  } finally {
    r.cleanup();
  }
});

test("job-run: a secret's name on one line hides its value on the next, in the report, the failure line and the saved log", async () => {
  const r = runner({ start: check(), result: { code: 1, lines: ["connecting", "Database password:", "hunter2"], timedOut: false } });
  try {
    assert.equal(await main(["--exec", ID, "r-run-0001"], r.d), 1);
    const finish = r.puts.at(-1).body;
    assert.equal(finish.state, "red");
    assert.ok(!JSON.stringify(finish).includes("hunter2"), JSON.stringify(finish));
    assert.ok(!fs.readFileSync(path.join(r.home, ".rivet-agents", "jobs", "logs", `${ID}-latest.log`), "utf8").includes("hunter2"));
  } finally {
    r.cleanup();
  }
  const git = runner({ start: check() });
  git.d.run = async () => printed({ code: 1, lines: ["Database password:", "hunter2"], timedOut: false });
  try {
    assert.equal(await main(["--exec", ID, "r-run-0001"], git.d), 1);
    assert.ok(!JSON.stringify(git.puts.at(-1).body).includes("hunter2"));
  } finally {
    git.cleanup();
  }
});

test("job-run: output is redacted as it comes, so a secret's name more than 2,000 lines back still hides its value", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-jobrun-out-"));
  const run = spawnRun(process.env);
  const script = (lines) => ["-e", `process.stdout.write(${JSON.stringify(lines.join("\n") + "\n")})`];
  try {
    const blank = await run(process.execPath, script(["Database password:", ...Array(1999).fill(""), "hunter2"]), { cwd: dir, timeoutMs: 30_000 });
    assert.equal(blank.code, 0);
    assert.ok(blank.lines.length <= 2000);
    assert.ok(!blank.lines.some((line) => line.includes("hunter2")), blank.lines.at(-1));
    const block = await run(process.execPath, script(["credentials: |", ...Array.from({ length: 2001 }, (_, i) => `  line ${i}`), "  s3cr3tpw", "done"]), { cwd: dir, timeoutMs: 30_000 });
    assert.ok(!block.lines.some((line) => line.includes("s3cr3tpw") || line.includes("line 2000")), block.lines.slice(-3).join(" | "));
    assert.equal(block.lines.at(-1), "done");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("job-run: a look check runs in the foreground and starts its chat in the background only when red", async () => {
  const red = runner({ start: check({ onRed: "look" }), result: { code: 1, lines: ["boom"], timedOut: false } });
  const green = runner({ start: check({ onRed: "look" }) });
  try {
    assert.equal(await main([ID, "--launchd", ON_TIME], red.d), 1);
    assert.deepEqual(red.puts.map((put) => put.body.state), ["start", "red", "look"]);
    assert.equal(red.puts.at(-1).body.run, "r-run-0001");
    assert.deepEqual(red.detached, [["--chat", ID, "r-run-0001", JSON.stringify({ kind: "check", name: "Lint", check: { script: "validate:docs", onRed: "look" }, line: "Failed: boom" })]]);
    assert.equal(await main([ID, "--launchd", ON_TIME], green.d), 0);
    assert.deepEqual(green.detached, []);
    assert.deepEqual(green.puts.map((put) => put.body.state), ["start", "green"]);
    assert.deepEqual(green.puts.at(-1).body, { run: "r-run-0001", state: "green", line: "Passed in 1 min.", log: ["all good"] });
  } finally {
    red.cleanup();
    green.cleanup();
  }
});

test("job-run: a look check's chat waits on the server's task limits, and a check that never ran opens none", async () => {
  const held = runner({ start: check({ onRed: "look" }), look: { go: false, note: "usage high" }, result: { code: 1, lines: ["boom"], timedOut: false } });
  const missing = runner({ start: check({ onRed: "look", script: "validate:nope" }) });
  const refused = runner({ start: check({ onRed: "look", script: "deploy:site" }) });
  try {
    assert.equal(await main([ID, "--launchd", ON_TIME], held.d), 1);
    assert.equal(held.out.at(-1), "red: Failed: boom (no chat: usage high)\n");
    assert.equal(await main([ID, "--launchd", ON_TIME], missing.d), 1);
    assert.deepEqual(missing.puts.map((put) => put.body.state), ["start", "red"]);
    assert.equal(missing.puts.at(-1).body.line, "pnpm validate:nope does not exist: the repo's package.json has no such script.");
    assert.ok(!missing.ran.some((call) => call.bin === "/opt/pnpm"), "nothing ran");
    assert.equal(await main([ID, "--launchd", ON_TIME], refused.d), 1);
    assert.deepEqual(refused.puts.map((put) => put.body.state), ["start", "red"]);
  } finally {
    held.cleanup();
    missing.cleanup();
    refused.cleanup();
  }
});

test("job-run: refuses a script the repo does not have or a job may not run", async () => {
  const r = runner();
  try {
    assert.equal((await runCheck(r.d, ID, { script: "validate:nope", onRed: "card" }, 60_000)).line, "pnpm validate:nope does not exist: the repo's package.json has no such script.");
    assert.equal((await runCheck(r.d, ID, { script: "deploy:site", onRed: "card" }, 60_000)).state, "red");
    assert.ok(!r.ran.some((call) => call.args.includes("deploy:site")));
  } finally {
    r.cleanup();
  }
});

test("job-run: the jobs clone is made from the default repo on first need; no repo set is a skip, a failed clone is red", async () => {
  const cloning = runner({ repo: false, clones: true });
  const failing = runner({ repo: false });
  const none = runner({ repo: false, noRepoSet: true });
  const lint = { script: "validate:docs", onRed: "card" };
  try {
    const repo = path.join(cloning.home, ".rivet-agents", "jobs", "repo");
    assert.deepEqual(await runCheck(cloning.d, ID, lint, 60_000), { state: "red", line: "pnpm validate:docs does not exist: the repo's package.json has no such script." }, "a repo with no package.json is a red, not a crash");
    assert.deepEqual(cloning.ran[0].args, ["repo", "clone", REPO, repo, "--", "-q"]);
    assert.deepEqual((await runCheck(failing.d, ID, lint, 60_000)), { state: "red", line: "The jobs clone ~/.rivet-agents/jobs/repo could not be made." });
    assert.deepEqual(await runCheck(none.d, ID, lint, 60_000), { state: "skipped", line: "skipped: no repo is set (RIVET_REPOS)" });
    assert.deepEqual(none.ran, []);
  } finally {
    cloning.cleanup();
    failing.cleanup();
    none.cleanup();
  }
});

const HEALTH = "https://sample-app.example/healthz";

/** A runner whose RIVET_HEALTH_URLS names the sample app, and whose GETs answer `answer`. */
function upRunner(answer) {
  const r = runner();
  r.gets = [];
  r.d.env.RIVET_HEALTH_URLS = `other=https://other.example/up, sample-app=${HEALTH}`;
  r.d.fetch = async (url, init) => {
    r.gets.push({ url, method: init.method, redirect: init.redirect });
    if (answer instanceof Error) throw answer;
    return new Response(null, { status: answer });
  };
  return r;
}
const up = (app = "sample-app") => ({ probe: "up", app, onRed: "card" });

test("job-run: an up check GETs the app's URL once; a 2xx is green, anything else red with the status", async () => {
  for (const [status, state, line] of [
    [200, "green", `sample-app is up: ${HEALTH} answered 200.`],
    [204, "green", `sample-app is up: ${HEALTH} answered 204.`],
    [503, "red", `sample-app is down: ${HEALTH} answered 503.`],
    [302, "red", `sample-app is down: ${HEALTH} answered 302.`],
  ]) {
    const r = upRunner(status);
    try {
      assert.deepEqual(await runCheck(r.d, ID, up(), 60_000), { state, line }, String(status));
      assert.deepEqual(r.gets, [{ url: HEALTH, method: "GET", redirect: "manual" }]);
      assert.deepEqual(r.ran, [], "no git, no pnpm, no shell");
    } finally {
      r.cleanup();
    }
  }
  const down = upRunner(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
  const none = upRunner(200);
  const odd = upRunner(200);
  try {
    assert.deepEqual(await runCheck(down.d, ID, up(), 60_000), { state: "red", line: `sample-app is down: ${HEALTH} did not answer in 30 s.` });
    assert.deepEqual(await runCheck(none.d, ID, up("docs-only"), 60_000), { state: "red", line: "docs-only has no URL in RIVET_HEALTH_URLS." });
    assert.equal((await runCheck(odd.d, ID, up("../x"), 60_000)).state, "red");
    assert.deepEqual([...none.gets, ...odd.gets], [], "no URL but the setting's is ever asked");
  } finally {
    down.cleanup();
    none.cleanup();
    odd.cleanup();
  }
});

test("job-run: RIVET_HEALTH_URLS is a comma list of name=url, and a value that is not an http URL is no URL", () => {
  const d = { env: { RIVET_HEALTH_URLS: "a=https://a.example/up, b = http://b.example:8080/x ,c=ftp://c.example,d=not a url,=https://e.example" } };
  assert.equal(upUrl(d, "a"), "https://a.example/up");
  assert.equal(upUrl(d, "b"), "http://b.example:8080/x");
  for (const app of ["c", "d", "e", "missing"]) assert.equal(upUrl(d, app), null, app);
  assert.equal(upUrl({ env: {} }, "a"), null);
});

test("job-run: an up check runs in the background and opens no chat", async () => {
  const r = runner({ start: { go: true, run: "r-run-0003", job: { id: ID, kind: "check", check: up() } } });
  try {
    assert.equal(await main([ID, "--launchd", ON_TIME], r.d), 0);
    assert.deepEqual(r.detached, [["--exec", ID, "r-run-0003"]]);
  } finally {
    r.cleanup();
  }
});

test("job-run: a task goes on the server's word, with Claude usage, and its chat starts in the background; a refused start opens nothing", async () => {
  const task = runner({ start: { go: true, run: "r-run-0002", job: { id: ID, kind: "task", name: "Issues", words: "look over the open issues" } } });
  const paused = runner({ start: { go: false, note: "paused" } });
  try {
    fs.mkdirSync(path.join(task.home, ".rivet-agents"), { recursive: true });
    fs.writeFileSync(path.join(task.home, ".rivet-agents", "claude-usage.json"), JSON.stringify({ at: new Date(task.d.now()).toISOString(), session: { percent: 40 }, weekly: { percent: 62 } }));
    assert.equal(await main([ID, "--launchd", ON_TIME], task.d), 0);
    assert.equal(task.puts[0].body.usage, 62);
    assert.deepEqual(task.detached, [["--chat", ID, "r-run-0002", JSON.stringify({ kind: "task", name: "Issues", words: "look over the open issues" })]]);
    assert.equal(task.out.at(-1), "background\n");
    assert.equal(await main(["--manual", ID], task.d), 0, "Run now's answer to the bridge");
    assert.equal(task.detached.length, 2);
    assert.equal(await main([ID, "--launchd", ON_TIME], paused.d), 1);
    assert.equal(paused.puts[0].body.usage, null);
    assert.equal(paused.out.at(-1), "skipped: paused\n");
    fs.writeFileSync(path.join(task.home, ".rivet-agents", "claude-usage.json"), JSON.stringify({ at: "2026-10-24T05:00:00Z", session: { percent: 40 } }));
    assert.equal(readUsage(task.d), null, "a stale reading is not known");
    assert.equal(await main(["--exec", "j-bad"], task.d), 2);
  } finally {
    task.cleanup();
    paused.cleanup();
  }
});

test("job-run --launchd: a run launchd starts more than 10 minutes after its time (the Mac slept through it) reports nothing and is left as missed", async () => {
  const cases = [
    ["on time", ON_TIME, true],
    ["9 minutes late", "51 17 * * *", true],
    ["11 minutes late", "49 17 * * *", false],
    ["hours late", "0 7 * * *", false],
    ["on time, every 6 hours", "0 */6 * * *", true],
    ["on time, weekdays", "0 18 * * 1-5", false],
    ["on time, Saturdays", "0 18 * * 6", true],
  ];
  for (const [name, cron, starts] of cases) {
    const r = runner({ start: check() });
    try {
      assert.equal(await main([ID, "--launchd", cron], r.d), 0, name);
      assert.equal(r.puts.length, starts ? 1 : 0, name);
      assert.equal(r.detached.length, starts ? 1 : 0, name);
      if (!starts) assert.match(r.out.at(-1), /^late: /, name);
      // Run now is never late.
      assert.equal(await main(["--manual", ID], r.d), 0, name);
      assert.equal(r.puts.at(-1).body.manual, true, name);
    } finally {
      r.cleanup();
    }
  }
});

/** A d.run that holds its first call matching `blocks` until let go. */
function blockingRun(blocks) {
  let started, letGo;
  const running = new Promise((resolve) => (started = resolve));
  const gate = new Promise((resolve) => (letGo = resolve));
  let blocked = false;
  const run = async (bin, args) => {
    if (!blocked && blocks(bin, args)) {
      blocked = true;
      started();
      return gate;
    }
    return { code: 0, lines: [], timedOut: false };
  };
  return { run, running, letGo };
}

test("job-run: SIGTERM mid-check (a pause or delete booting it out) frees the jobs lock once, and reports the run skipped", async () => {
  const r = runner({ start: check({ onRed: "look" }) });
  const { run, running, letGo } = blockingRun((bin, args) => args[0] === "run");
  r.d.run = run;
  const lock = path.join(r.home, ".rivet-agents", "jobs", "lock");
  try {
    const finished = main([ID, "--launchd", ON_TIME], r.d);
    await running;
    assert.ok(held.lock?.mine() && fs.existsSync(lock), "this run holds the jobs lock");
    await stopped();
    assert.ok(!fs.existsSync(lock));
    assert.deepEqual([held.lock, held.run], [null, null]);
    assert.deepEqual(r.puts[1].body, { run: "r-run-0001", state: "skipped", line: "skipped: stopped while it ran (paused, deleted, or the Mac shutting down)" });
    // Another job takes the freed lock; the stopped check's finally, run late, must leave it, and report nothing more.
    const other = tryLock(lock);
    letGo({ code: 1, lines: ["boom"], timedOut: false });
    assert.equal(await finished, 1);
    assert.ok(other.mine(), "the other job's lock is still its own");
    assert.equal(r.puts.length, 2);
    assert.deepEqual(r.detached, []);
  } finally {
    held.stopping = false;
    r.cleanup();
  }
});

test("job-run: SIGTERM during a task chat's clone sync frees the jobs lock the sync took", async () => {
  const r = runner();
  const { run, running, letGo } = blockingRun((bin) => bin === "/usr/bin/git");
  r.d.run = run;
  const lock = path.join(r.home, ".rivet-agents", "jobs", "lock");
  try {
    const finished = main(["--chat", ID, "r-run-0004", JSON.stringify({ kind: "task", name: "Issues", words: "look over the open issues" })], r.d);
    await running;
    assert.ok(held.lock?.mine() && fs.existsSync(lock), "this run holds the jobs lock");
    await stopped();
    assert.ok(!fs.existsSync(lock));
    const other = tryLock(lock);
    letGo({ code: 1, lines: [], timedOut: false });
    await finished;
    assert.ok(other.mine(), "the sync's late finally leaves another job's lock");
  } finally {
    held.stopping = false;
    r.cleanup();
  }
});

test("job-run: SIGTERM stops the script's process group and frees the lock only once it has gone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-stop-"));
  const lock = path.join(dir, "lock");
  held.lock = tryLock(lock);
  // A script that takes a second to stop after SIGTERM.
  const ran = spawnRun(process.env)("/bin/sh", ["-c", 'trap "sleep 1; exit 0" TERM; sleep 30 & wait'], { cwd: dir, timeoutMs: 60_000 });
  const [pid] = held.children;
  try {
    assert.ok(pid);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stopping = stopped();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(fs.existsSync(lock), "kept while the script is still stopping");
    await stopping;
    assert.ok(!fs.existsSync(lock));
    assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" });
    await ran;
    // Nothing new starts once stopping.
    assert.deepEqual(await spawnRun(process.env)("/bin/echo", ["hi"], { cwd: dir, timeoutMs: 5_000 }), { code: null, lines: ["stopped"], timedOut: false });
    assert.equal(held.children.size, 0);
  } finally {
    held.stopping = false;
    held.lock = null;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("job-run --launchd: 0 when the run went on in the background or the check was green, not 0 for a red, skipped or refused run", async () => {
  const task = { go: true, run: "r-run-0002", job: { id: ID, kind: "task", name: "Issues", words: "look over the open issues" } };
  const red = { code: 1, lines: ["boom"], timedOut: false };
  const cases = [
    ["task", { start: task }, 0],
    ["card check", { start: check() }, 0],
    ["look check green", { start: check({ onRed: "look" }) }, 0],
    ["look check red, chat", { start: check({ onRed: "look" }), result: red }, 1],
    ["look check red, no chat", { start: check({ onRed: "look" }), result: red, look: { go: false, note: "usage high" } }, 1],
    ["skipped", { start: { go: false, note: "usage high" } }, 1],
  ];
  for (const [name, opts, code] of cases) {
    const r = runner(opts);
    try {
      assert.equal(await main([ID, "--launchd", ON_TIME], r.d), code, name);
      assert.equal(r.puts[0].body.manual, undefined, name);
    } finally {
      r.cleanup();
    }
  }
  const r = runner({ start: task });
  try {
    assert.deepEqual(r.detached, []);
    await main([ID, "--launchd", ON_TIME], r.d);
    assert.deepEqual(r.detached[0].slice(0, 3), ["--chat", ID, "r-run-0002"]);
    for (const argv of [[], [ID], ["j-bad"], [ID, "extra"], [ID, "--launchd"], [ID, "--launchd", ON_TIME, "extra"], [ID, "--launchd", "0 18 * * *; id"], [ID, "--launchd", "*/5 */2 * * 1-5"], ["--manual", ID, "--launchd", ON_TIME], ["--launchd", ID, ON_TIME], ["j-bad", "--launchd", ON_TIME]]) assert.equal(await main(argv, r.d), 2, argv.join(" "));
  } finally {
    r.cleanup();
  }
});

test("job-run: a chat runs claude -p in the jobs clone for 30 minutes at most, and a run it never reported goes red", async () => {
  const spec = { kind: "task", name: "Issues", words: "look over the open issues" };
  const look = { kind: "check", name: "Lint", check: { script: "validate:docs", onRed: "look" }, line: "Failed: boom" };
  const go = async (opts, s = spec) => {
    const r = runner(opts);
    r.d.bin = (name) => `/opt/${name}`;
    try {
      const code = await main(["--chat", ID, RUN, JSON.stringify(s)], r.d);
      return { code, r };
    } finally {
      r.cleanup();
    }
  };
  const stopped = await go({ result: { code: null, lines: [], timedOut: true } });
  assert.equal(stopped.code, 1);
  const claude = stopped.r.ran.find((call) => call.bin === "/opt/claude");
  assert.deepEqual(claude.args, chatArgs(ID, RUN, spec, { rivet: JOB_RUN_FILE, logDir: path.join(stopped.r.home, ".rivet-agents", "jobs", "logs") }));
  assert.equal(claude.cwd, path.join(stopped.r.home, ".rivet-agents", "jobs", "repo"));
  assert.deepEqual(stopped.r.ran.filter((call) => call.bin === "/usr/bin/git").map((call) => call.args.slice(2, 4)), CLONE_SYNC.map((args) => args.slice(0, 2)), "a task's clone is brought up to date first");
  assert.equal(stopped.r.puts.at(-1).url, `http://localhost:5230/api/bridge/jobs/${ID}/report`);
  assert.deepEqual(stopped.r.puts.at(-1).body, { run: RUN, state: "red", line: "Stopped after 30 minutes: the chat never reported." });

  const silent = await go({ result: { code: 0, lines: ["done"], timedOut: false } });
  assert.equal(silent.code, 1);
  assert.deepEqual(silent.r.puts.at(-1).body, { run: RUN, state: "red", line: "The chat never reported." });
  const crashed = await go({ result: { code: 1, lines: [], timedOut: false } });
  assert.equal(crashed.r.puts.at(-1).body.line, "The chat never reported (claude exited 1).");

  const reported = await go({ report: 409 });
  assert.equal(reported.code, 0, "the chat reported: the server refuses the red");
  assert.deepEqual(reported.r.puts.map((put) => put.body.state), ["red"]);

  assert.equal(claude.env.RIVET_URL, "http://localhost:5230");
  assert.ok(stopped.r.ran.filter((call) => call.bin === "/usr/bin/git").every((call) => call.env === undefined), "git keeps the run's own env");

  const looked = await go({ result: { code: null, lines: [], timedOut: true } }, look);
  assert.deepEqual(looked.r.puts.at(-1).body, { run: RUN, state: "red", line: "Failed: boom The look into it: stopped after 30 minutes: the chat never reported." });
  assert.ok(!looked.r.ran.some((call) => call.bin === "/usr/bin/git"), "a look reads the clone at the commit that went red");

  const noClone = await go({ repo: false });
  assert.deepEqual(noClone.r.ran.map((call) => call.bin), ["/opt/gh"]);
  assert.equal(noClone.r.puts.at(-1).body.line, "The jobs clone ~/.rivet-agents/jobs/repo is missing, so the chat never started.");

  const noRepo = await go({ repo: false, noRepoSet: true });
  assert.equal(noRepo.code, 1);
  assert.deepEqual(noRepo.r.ran, []);
  assert.deepEqual(noRepo.r.puts.at(-1).body, { run: RUN, state: "skipped", line: "skipped: no repo is set (RIVET_REPOS)" });
});

test("job-run: two checks that both judged a dead check's lock stale do not both run in the clone", async () => {
  const r = runner();
  const lock = path.join(r.home, ".rivet-agents", "jobs", "lock");
  fs.mkdirSync(lock);
  const holder = path.join(lock, `${2 ** 22 + 12345}-${randomUUID()}`);
  fs.writeFileSync(holder, "");
  const long = new Date(Date.parse("2026-10-24T03:00:00Z"));
  fs.utimesSync(holder, long, long);
  fs.utimesSync(lock, long, long);
  const lint = { script: "validate:docs", onRed: "card" };
  let rival;
  try {
    const late = await withRival(lock, () => (rival = runCheck(r.d, ID, lint, 60_000)), () => runCheck(r.d, ID, lint, 60_000));
    const outcomes = [await rival, late].map((o) => o.state);
    assert.deepEqual(outcomes, ["green", "skipped"], "one check runs; the late reclaimer skips");
    assert.equal(r.ran.filter((call) => call.args[0] === "run").length, 1);
  } finally {
    held.lock = null;
    r.cleanup();
  }
});

test("job read refuses before it starts gh or git, and runs a listed read capped", async () => {
  for (const argv of [["gh", "issue", "list", "--repo", "other/a/b"], ["gh", "pr", "list", "--web"], ["git", "diff", "--output=/tmp/x"], ["git", "-c", "x=y", "log"]]) {
    const r = runner();
    try {
      assert.notEqual(await main(["job", "read", ...argv], r.d), 0, argv.join(" "));
      assert.deepEqual(r.ran, [], `${argv.join(" ")} started nothing`);
      assert.match(r.out.join(""), /job read refuses/);
    } finally {
      r.cleanup();
    }
  }
  const r = runner({ result: { code: 0, lines: ["1 open issue"], timedOut: false } });
  r.d.bin = (name) => `/bin/${name}`;
  try {
    assert.equal(await main(["job", "read", "gh", "issue", "list", "--limit", "1"], r.d), 0);
    assert.equal(r.out.join(""), "1 open issue");
    assert.deepEqual(r.ran.map((call) => [call.bin, call.args.at(-1), call.cwd, call.env.GH_HOST, call.timeoutMs]), [["/bin/gh", REPO, os.tmpdir(), "github.com", 60_000]]);
    r.ran.length = 0;
    await main(["job", "read", "git", "status"], r.d);
    assert.deepEqual(r.ran.map((call) => [call.bin, call.cwd]), [["/bin/git", path.join(r.home, ".rivet-agents", "jobs", "repo")]]);
  } finally {
    r.cleanup();
  }
});

test("job read: with no repo set a gh read is refused plainly, and git still reads the clone", (t) => {
  delete process.env.RIVET_REPOS;
  t.after(() => { process.env.RIVET_REPOS = REPO; });
  assert.throws(() => readCommand(["gh", "issue", "list"]), /no repo is set/);
  assert.equal(readCommand(["git", "status"]).tool, "git");
});

test("job report closes a run with the bridge token, and binds one run: a repeated flag, both states, or any other flag is refused before it sends", async () => {
  for (const extra of [["--run", "RUN_BBBBBBBB", "--green", "x"], ["--green", "x", "--red", "y"], ["--green", "x", "--name", "y"], ["--green", "x", "--green", "y"], ["--green", "x", "--json"]]) {
    const r = runner();
    try {
      assert.equal(await main(["job", "report", ID, "--run", "RUN_AAAAAAAA", ...extra], r.d), 2, extra.join(" "));
      assert.deepEqual(r.puts, [], extra.join(" "));
    } finally {
      r.cleanup();
    }
  }
  const r = runner();
  try {
    assert.equal(await main(["job", "report", ID, "--run", "r-run-0001", "--red", "Two issues need the owner"], r.d), 0);
    assert.deepEqual(r.puts.at(-1), { url: `http://localhost:5230/api/bridge/jobs/${ID}/report`, method: "PUT", auth: `Bearer ${"c".repeat(64)}`, body: { run: "r-run-0001", state: "red", line: "Two issues need the owner" } });
    assert.equal(await main(["job", "report", ID, "--red", "no run named"], r.d), 2);
  } finally {
    r.cleanup();
  }
});

test("job-run: after its sync the jobs clone is on the default branch's pushed head, from a detached or dirty start", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-jobclone-"));
  const git = (cwd, args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const origin = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  const repo = path.join(dir, "repo");
  try {
    git(dir, ["init", "-q", "--bare", "-b", "trunk", origin]);
    git(dir, ["clone", "-q", origin, seed]);
    fs.writeFileSync(path.join(seed, "package.json"), "{}\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-qm", "one"]);
    git(seed, ["push", "-q", "origin", "HEAD:refs/heads/trunk"]);
    git(dir, ["clone", "-q", origin, repo]);
    git(repo, ["checkout", "-q", "--detach"]);
    fs.writeFileSync(path.join(repo, "stray.txt"), "left by a run\n");
    fs.writeFileSync(path.join(seed, "package.json"), '{"scripts":{}}\n');
    git(seed, ["commit", "-qam", "two"]);
    git(seed, ["push", "-q", "origin", "HEAD:refs/heads/trunk"]);
    for (const args of CLONE_SYNC) git(repo, args);
    assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), git(seed, ["rev-parse", "HEAD"]).trim());
    assert.ok(!fs.existsSync(path.join(repo, "stray.txt")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
