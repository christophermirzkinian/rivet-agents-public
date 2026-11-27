#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import { serverError } from "../bridge/lib/board-client.mjs";
import { makeExec, readToken, resolveBin, serverOrigin, withoutRivetTokens } from "../bridge/lib/config.mjs";
import { codexSandboxDown, codexVerdict, codexWatch, connected, copilotJobEnv, copilotVerdict, copilotWatch, DRIVERS, FIRST_PLAN_UNREAD, firstPlan, isPlan, limitAsk, limitOf, limitOffer, limitReport, limitWords, notConnectedLine, othersOn, outsideNeed, PLAN_NAMES, plansHere, plansOn, SANDBOX_DOWN_LINE, STATUS_ARGS, STATUS_BIN, uncheckedLine } from "../bridge/lib/job-drivers.mjs";
import { ACTION_ID_RE, APP_ID_RE, CHECK_SCRIPT_RE, JOB_ID_RE, launchdCron, MISSED_GRACE_MS, onTime, readCommand, TASK_MAX_MINUTES } from "../bridge/lib/jobs.mjs";
import { redactLine, redactLines } from "../bridge/lib/redact.mjs";
import { takeLock, tryLock } from "../bridge/lib/token-lock.mjs";
import { defaultRepo } from "../src/shared/repos.ts";

const USAGE = `Runs one of the owner's scheduled jobs (a red one shows on Red jobs) and reports it to Rivet with the bridge token.

  job-run.mjs <job id> --launchd <cron>
                                       its LaunchAgent's run: exits 0 when it started the run in the background, the check
                                       was green, or it came more than 10 minutes after its time and was left as missed (it
                                       reports nothing then), and not 0 on a red, skipped or refused run or an error
  job-run.mjs --manual <job id> [--action <id>] [--plan claude|chatgpt|copilot]
                                       Run now from the app (--action: the Run now that asked; --plan: a limit card's
                                       answer, this one run's chat on that plan): the check or the task's chat runs on in the background
  job-run.mjs --exec <job id> <run id> [--manual [--plan claude|chatgpt|copilot]]
                                       a check's run in the background, and with --plan its look on that plan if it is red
  job-run.mjs --chat <job id> <run id> <spec json>
                                       a task's chat, or a red look check's, in the background
  job-run.mjs job read gh issue|pr|run list|view … | git log|show|diff|status …
                                       a job chat's one read command
  job-run.mjs job report <job id> --run <run id> --green|--red "<one line>" [--url <https>]
                                       a job chat's report

A check runs only \`pnpm <script>\` from the default repo's package.json, in its own clone (~/.rivet-agents/jobs/repo,
made from the first repo in RIVET_REPOS the first time it is needed). An up check asks the app's URL in RIVET_HEALTH_URLS
once. A task's chat (and a red look check's) is \`claude -p\` on Opus in the jobs clone with read-only tools only
(bridge/lib/jobs.mjs chatArgs), stopped after ${TASK_MAX_MINUTES} minutes; a run its chat never reported goes red. A hosted
agent (RIVET_AGENT_FILE) runs it on its first plan instead, which may be ChatGPT through \`codex exec --json\` or GitHub
Copilot through \`copilot -p\` (bridge/lib/job-drivers.mjs). It never runs anything else.
`;

/** A look check runs in the foreground before its chat, so it is held to less than a background check. */
export const LOOK_BUDGET_MS = 510_000;
export const CHECK_BUDGET_MS = 2 * 3_600_000;
export const UP_TIMEOUT_MS = 30_000;
export const LOG_LINES = 20;
const KEEP_LINES = 2000;
const LOCK_STALE_MS = 3 * 3_600_000;
const GIT = "/usr/bin/git";
const RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;
const READ_TIMEOUT_MS = 60_000;
const READ_MAX_BYTES = 1024 * 1024;
const CLONE_TIMEOUT_MS = 600_000;
const self = fileURLToPath(import.meta.url);
const ENV_FILE = path.resolve(path.dirname(self), "..", ".env");
const NO_REPO = { state: /** @type {const} */ ("skipped"), line: "skipped: no repo is set (RIVET_REPOS)" };

/**
 * @typedef {{ code: number | null, lines: string[], timedOut: boolean }} Ran lines: the output already redacted (outputCollector), its last KEEP_LINES;
 *   with raw, stdout alone, whole and untouched, for a machine read that is never reported or logged
 * @typedef {{ env: NodeJS.ProcessEnv, home: string, now: () => number, fetch: typeof fetch, token: () => Promise<string>,
 *   run: (bin: string, args: string[], opts: { cwd: string, timeoutMs: number, raw?: boolean, env?: NodeJS.ProcessEnv, watch?: (stream: "stdout" | "stderr", line: string) => void }) => Promise<Ran>,
 *   detach: (args: string[]) => void, bin: (name: string) => string, stdout: (s: string) => void }} Deps
 * @typedef {{ script: string, onRed: "card" | "look" } | { probe: "up", app: string, onRed: "card" }} Check
 * @typedef {{ state: "green" | "red" | "skipped", line: string, log?: string[], ran?: boolean }} Outcome ran: the script itself ran and failed
 */

export const newRunId = () => `r${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;

/**
 * What a start or look asks to start on: a hosted agent's plan for this run (a limit card's answer, else its first
 * plan), which says whose state holds it; nothing on any other machine, where every chat is Claude's.
 * @param {Deps} d @param {string | undefined} onPlan
 */
function runPlan(d, onPlan) {
  if (!plansOn(d.env)) return {};
  const plan = isPlan(onPlan) ? onPlan : firstPlan(d.env);
  return plan ? { plan } : {};
}

/** @param {Deps} d @param {string} id @param {Record<string, unknown>} body @param {"runs" | "report"} to */
async function send(d, id, body, to) {
  const origin = serverOrigin(d.env.RIVET_URL || undefined);
  return d.fetch(`${origin}/api/bridge/jobs/${id}/${to}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${await d.token()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
}

/** @param {Deps} d @param {string} id @param {Record<string, unknown>} body */
async function put(d, id, body) {
  const res = await send(d, id, body, "runs");
  if (!res.ok) throw new Error(await serverError(res, { issues: true }));
  return res.json();
}

/** @param {string} text */
const clip = (text) => redactLine(text, undefined, 200);

const HOOKS_OFF = ["-c", "core.hooksPath=/dev/null"];
/** The jobs clone brought to the default branch's pushed head before a check. */
export const CLONE_SYNC = [
  ["fetch", "-q", "--no-tags", "origin", "HEAD"],
  ["checkout", "-q", "--force", "--detach", "FETCH_HEAD"],
  ["clean", "-fdq"],
];

/**
 * The jobs clone, made from the default repo the first time a run needs it; false when there is none. Called under
 * the checks' lock, so two runs never make it at once.
 * @param {Deps} d @param {string} repo @param {number} timeoutMs
 */
async function cloned(d, repo, timeoutMs) {
  if (fs.existsSync(path.join(repo, ".git"))) return true;
  const from = defaultRepo(d.env);
  if (!from) return false;
  await d.run(d.bin("gh"), ["repo", "clone", from, repo, "--", "-q"], { cwd: path.dirname(repo), timeoutMs });
  return fs.existsSync(path.join(repo, ".git"));
}

/**
 * The app's URL from RIVET_HEALTH_URLS, a comma list of name=url, or null.
 * @param {Deps} d @param {string} app
 */
export function upUrl(d, app) {
  for (const entry of (d.env.RIVET_HEALTH_URLS ?? "").split(",")) {
    const at = entry.indexOf("=");
    if (at <= 0 || entry.slice(0, at).trim() !== app) continue;
    const url = entry.slice(at + 1).trim();
    return /^https?:\/\//.test(url) && URL.canParse(url) ? url : null;
  }
  return null;
}

/**
 * An up check: one GET of the app's health check. A 2xx is green; anything else, a redirect too, is red.
 * @param {Deps} d @param {string} app @returns {Promise<Outcome>}
 */
export async function probeUp(d, app) {
  if (!APP_ID_RE.test(app)) return { state: "red", line: `${app} is not an app a job may check` };
  const url = upUrl(d, app);
  if (!url) return { state: "red", line: `${app} has no URL in RIVET_HEALTH_URLS.` };
  try {
    const res = await d.fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(UP_TIMEOUT_MS) });
    await res.body?.cancel();
    if (res.status >= 200 && res.status < 300) return { state: "green", line: `${app} is up: ${url} answered ${res.status}.` };
    return { state: "red", line: `${app} is down: ${url} answered ${res.status}.` };
  } catch (err) {
    const timedOut = /** @type {Error} */ (err)?.name === "TimeoutError";
    return { state: "red", line: clip(`${app} is down: ${url} ${timedOut ? `did not answer in ${UP_TIMEOUT_MS / 1000} s` : `could not be reached (${/** @type {Error} */ (err)?.message ?? "error"})`}.`) };
  }
}

/**
 * Runs one check: an up check's one GET, or the default branch's newest commit in the jobs clone, then `pnpm <script>`.
 * @param {Deps} d @param {string} id @param {Check} check @param {number} budgetMs
 * @returns {Promise<Outcome>}
 */
export async function runCheck(d, id, check, budgetMs) {
  if ("probe" in check) return check.probe === "up" ? probeUp(d, check.app) : { state: "red", line: "not a check a job may run" };
  if (!CHECK_SCRIPT_RE.test(check.script)) return { state: "red", line: `pnpm ${check.script} is not a script a job may run` };
  const root = path.join(d.home, ".rivet-agents", "jobs");
  const repo = path.join(root, "repo");
  if (!fs.existsSync(path.join(repo, ".git")) && !defaultRepo(d.env)) return NO_REPO;
  fs.mkdirSync(root, { recursive: true });
  // The lock names its holder (bridge/lib/token-lock.mjs), so two checks that both judged it stale cannot both take it
  // and run in one clone.
  const lock = takeLock(path.join(root, "lock"), ({ ageMs }) => ageMs >= LOCK_STALE_MS, d.now());
  if (!lock) return { state: "skipped", line: "skipped: another job's check was running" };
  held.lock = lock;
  const started = d.now();
  const left = () => Math.max(1_000, budgetMs - (d.now() - started));
  try {
    if (!(await cloned(d, repo, Math.min(left(), CLONE_TIMEOUT_MS)))) return { state: "red", line: "The jobs clone ~/.rivet-agents/jobs/repo could not be made." };
    for (const args of CLONE_SYNC) {
      const git = await d.run(GIT, [...HOOKS_OFF, ...args], { cwd: repo, timeoutMs: Math.min(left(), 120_000) });
      if (git.code !== 0) return { state: "red", line: `Could not bring the jobs clone up to date (git ${args[0]}).`, log: tidy(git.lines) };
    }
    const manifest = path.join(repo, "package.json");
    const scripts = fs.existsSync(manifest) ? (JSON.parse(fs.readFileSync(manifest, "utf8"))?.scripts ?? {}) : {};
    if (!Object.hasOwn(scripts, check.script)) return { state: "red", line: `pnpm ${check.script} does not exist: the repo's package.json has no such script.` };
    const pnpm = d.bin("pnpm");
    const install = await d.run(pnpm, ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: repo, timeoutMs: Math.min(left(), 900_000) });
    if (install.code !== 0) return { state: "red", line: install.timedOut ? "pnpm install did not finish in time." : "pnpm install failed.", log: tidy(install.lines) };
    const ran = await d.run(pnpm, ["run", check.script], { cwd: repo, timeoutMs: left() });
    const shown = ran.lines;
    writeLog(d, id, shown);
    const log = shown.slice(-LOG_LINES);
    const minutes = Math.max(1, Math.round((d.now() - started) / 60_000));
    if (ran.code === 0) return { state: "green", line: `Passed in ${minutes} min.`, log };
    if (ran.timedOut) return { state: "red", line: `Did not finish in ${minutes} min, so it was stopped.`, log, ran: true };
    const last = [...shown].reverse().find((line) => line.trim() !== "");
    return { state: "red", line: last ? clip(`Failed: ${last.trim()}`) : `Failed with exit ${ran.code}.`, log, ran: true };
  } finally {
    release(lock);
  }
}

/**
 * What this process holds while it uses the jobs clone. Pausing or deleting a job boots it out of launchd, which sends
 * the foreground job-run SIGTERM (as a shutdown sends every one); no finally runs then, so stopped() stops the
 * script's process groups, frees the lock (or every job's check skips for LOCK_STALE_MS) and reports the run skipped.
 * Once it starts (stopping) the lock is its alone: a finally still to come must not free a lock another job took since.
 * @type {{ lock: { release: () => void } | null, children: Set<number>, run: { d: Deps, id: string, run: string, manual: boolean } | null, stopping: boolean }}
 */
export const held = { lock: null, children: new Set(), run: null, stopping: false };
const STOP_WAIT_MS = 5_000;
const STOP_REPORT_MS = 5_000;
const STOPPED_LINE = "skipped: stopped while it ran (paused, deleted, or the Mac shutting down)";

/** @param {{ release: () => void }} lock the jobs lock this process took */
function release(lock) {
  if (held.stopping || held.lock !== lock) return;
  held.lock = null;
  lock.release();
}

/** @param {number} pid a process group's leader */
const groupAlive = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return /** @type {any} */ (err)?.code === "EPERM";
  }
};

/** @param {number[]} groups @param {number} ms */
async function groupsGone(groups, ms) {
  const end = Date.now() + ms;
  while (groups.some(groupAlive)) {
    if (Date.now() >= end) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

/** The SIGTERM handler, before the process exits. launchd kills it 20 s after SIGTERM, so each wait is bounded. */
export async function stopped() {
  held.stopping = true;
  const report = held.run;
  held.run = null;
  const groups = [...held.children];
  held.children.clear();
  const signal = (/** @type {NodeJS.Signals} */ name) => {
    for (const pid of groups) {
      try {
        process.kill(-pid, name);
      } catch {}
    }
  };
  signal("SIGTERM");
  if (!(await groupsGone(groups, STOP_WAIT_MS))) {
    signal("SIGKILL");
    await groupsGone(groups, 1_000);
  }
  // A script still running in the clone keeps the lock until LOCK_STALE_MS rather than share it.
  if (held.lock && !groups.some(groupAlive)) held.lock.release();
  held.lock = null;
  if (!report) return;
  await Promise.race([
    put(report.d, report.id, { run: report.run, state: "skipped", line: STOPPED_LINE, ...(report.manual ? { manual: true } : {}) }).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, STOP_REPORT_MS).unref()),
  ]);
}

/** @param {string[]} lines a run's lines, redacted as they came */
const tidy = (lines) => lines.slice(-LOG_LINES);

/** The whole run's output, already redacted, for a look chat to read. @param {Deps} d @param {string} id @param {string[]} shown */
function writeLog(d, id, shown) {
  const dir = path.join(d.home, ".rivet-agents", "jobs", "logs");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${id}-latest.log`), `${shown.slice(-KEEP_LINES).join("\n")}\n`, { mode: 0o600 });
}

/** @param {Deps} d @param {string} id @param {string} run @param {Check} check @param {number} budgetMs @param {boolean} manual */
async function checkAndReport(d, id, run, check, budgetMs, manual) {
  let outcome;
  held.run = { d, id, run, manual };
  try {
    outcome = await runCheck(d, id, check, budgetMs);
  } catch (err) {
    outcome = { state: /** @type {const} */ ("red"), line: clip(`The check could not run: ${/** @type {Error} */ (err)?.message ?? "error"}`) };
  } finally {
    held.run = null;
  }
  // stopped() reports it.
  if (held.stopping) return { state: /** @type {const} */ ("skipped"), line: STOPPED_LINE };
  await put(d, id, { run, state: outcome.state, line: outcome.line, ...(outcome.log?.length ? { log: outcome.log } : {}), ...(manual ? { manual: true } : {}) });
  return outcome;
}

/** The jobs clone brought up to date before a task's chat; a check holding the lock brings it there itself. @param {Deps} d @param {string} repo */
async function syncForChat(d, repo) {
  fs.mkdirSync(path.dirname(repo), { recursive: true });
  const lock = tryLock(path.join(path.dirname(repo), "lock"));
  if (!lock) return;
  held.lock = lock;
  try {
    if (!(await cloned(d, repo, CLONE_TIMEOUT_MS))) return;
    for (const args of CLONE_SYNC) if ((await d.run(GIT, [...HOOKS_OFF, ...args], { cwd: repo, timeoutMs: 120_000 })).code !== 0) return;
  } finally {
    release(lock);
  }
}

/**
 * A task's chat, or a red look check's, through \`claude -p\` with read-only tools in the jobs clone, stopped after
 * TASK_MAX_MINUTES. Its report closes the run; one that never came makes the run red, and the server, which knows
 * whether it came, refuses that once it has. Only a limit card's answer (spec.plan) runs it once on the other
 * plan; nothing switches by itself.
 * @param {Deps} d @param {string} id @param {string} run @param {import("../bridge/lib/jobs.mjs").ChatSpec} spec
 * @returns {Promise<number>}
 */
export async function chat(d, id, run, spec) {
  const task = spec.kind === "task";
  const repo = path.join(d.home, ".rivet-agents", "jobs", "repo");
  if (!fs.existsSync(path.join(repo, ".git")) && !defaultRepo(d.env)) {
    d.stdout(`${NO_REPO.line}\n`);
    await put(d, id, { run, ...NO_REPO });
    return 1;
  }
  if (task) await syncForChat(d, repo);
  let why;
  /** @type {{ plan: import("../bridge/lib/job-drivers.mjs").Plan, until?: string } | null} */
  let limit = null;
  /** @type {{ plan: import("../bridge/lib/job-drivers.mjs").Plan, until?: string, connected: boolean } | null} the plan a look stopped on */
  let lookLimit = null;
  /** @type {{ state: "green" | "red", line: string } | null} a Codex chat's own verdict */
  let verdict = null;
  if (!fs.existsSync(path.join(repo, ".git"))) why = "the jobs clone ~/.rivet-agents/jobs/repo is missing, so the chat never started";
  else {
    const paths = { rivet: self, logDir: path.join(d.home, ".rivet-agents", "jobs", "logs") };
    const plan = isPlan(spec.plan) && plansOn(d.env) ? spec.plan : firstPlan(d.env);
    // On a hosted agent a CLI not on PATH is a chat that cannot start and a status that cannot be checked, never a run
    // with no report; with no agent file claude throws as it always has.
    const bin = (/** @type {string} */ name) => {
      if (!plansOn(d.env)) return d.bin(name);
      try {
        return d.bin(name);
      } catch {
        return null;
      }
    };
    const driver = plan ? DRIVERS[plan] : null;
    const exe = driver ? bin(driver.bin) : null;
    const env = withoutRivetTokens(d.env);
    // A hosted agent's job runs on its owner's own plan, so a plan that is definitely signed out starts nothing: a job
    // set before the plan was disconnected is refused here. A status that gave no answer runs as it always has. A
    // status is read from the home folder, never the jobs clone, whose project settings could answer for the plan.
    // A plan's status command (Copilot's is its own program), or null when it is not on this machine. Codex says
    // "Not logged in" on stderr, which only a run that is not raw keeps.
    /** @param {import("../bridge/lib/job-drivers.mjs").Plan} one @param {string | null} [at] the program, when already found */
    const statusOf = async (one, at = bin(STATUS_BIN[one])) => (at ? d.run(at, [...STATUS_ARGS[one]], { cwd: d.home, timeoutMs: 15_000, raw: one === "claude", env }) : null);
    const signIn = plan && driver && exe && plansOn(d.env) ? await statusOf(plan, STATUS_BIN[plan] === driver.bin ? exe : undefined) : null;
    if (!plan || !driver) why = `${FIRST_PLAN_UNREAD.toLowerCase()}, so the chat never started`;
    else if (!exe) why = `${driver.bin} is not installed on this machine, so the chat never started`;
    else if (signIn && connected(plan, signIn) === false) {
      // The other plans' status only chooses the words: the job never moves to one by itself.
      why = notConnectedLine(plan, task, (await othersOn(plan, statusOf)).on, firstPlan(d.env), plansHere(Boolean(bin(STATUS_BIN.copilot))));
    } else {
      // A Codex chat has no network to report with: it writes its verdict as its last message, which this run reports.
      const scratch = plan === "chatgpt" ? fs.mkdtempSync(path.join(os.tmpdir(), "job-codex-")) : null;
      // A Copilot chat gets an empty settings folder of its own: no saved trust, hook or MCP server reaches a job.
      const own = plan === "copilot" ? fs.mkdtempSync(path.join(os.tmpdir(), "job-copilot-")) : null;
      try {
        const where = { repo, lastMessage: scratch ? path.join(scratch, "last-message.txt") : "" };
        const watch = scratch ? codexWatch() : null;
        // A Copilot chat cannot report either: its verdict is its last message, read from its events as they come.
        const seen = plan === "copilot" ? copilotWatch() : null;
        const watching = watch?.line ?? seen?.line;
        const ran = await d.run(exe, driver.args(id, run, spec, paths, where), { cwd: repo, timeoutMs: TASK_MAX_MINUTES * 60_000, env: own && env ? copilotJobEnv(env, own) : env, ...(watching ? { watch: watching } : {}) });
        const read = driver.read(ran.lines);
        const hit = !ran.timedOut && plansOn(d.env) ? limitOf(plan, ran, read.error) : null;
        if (hit) {
          const others = await othersOn(plan, statusOf);
          // A look's limit is the look's alone: its check's red stands, with Fix it, and asks for another plan only when one is connected.
          if (!task) lookLimit = { ...limitReport(plan, hit.until, others.on[0] ?? null), connected: others.on.length > 0, first: firstPlan(d.env) ?? undefined };
          // A task is offered the first connected plan that can see what its words need: only Claude's job chat reaches outside the checkout.
          const offer = task ? limitOffer(others.on, outsideNeed(spec.words ?? "")) : null;
          if (offer) limit = { ...limitReport(plan, hit.until, offer.plan), ...(offer.outside ? { outside: offer.outside } : {}) };
          why = offer?.outside
            ? `${limitWords(plan, hit.until)}, so the job did not run. ${PLAN_NAMES[offer.plan]} can't check ${offer.outside} from here.`
            : offer
              ? limitAsk(plan, hit.until, offer.plan)
              : `${limitWords(plan, hit.until)}${task ? ", so the job did not run" : ""}${!others.on.length && others.unknown.length ? `. ${uncheckedLine(others.unknown[0])}` : ""}`;
        } else if (seen && !ran.timedOut) {
          verdict = copilotVerdict(seen.message(), task, spec.words, seen.refused());
          why = `the chat never reported a verdict${ran.code ? ` (copilot exited ${ran.code}${read.error ? `: ${read.error}` : ""})` : ""}`;
        } else if (scratch && !ran.timedOut) {
          // A sandbox that would not start wins over whatever the chat said: it read nothing.
          const down = codexSandboxDown(watch?.lines() ?? [], read.error);
          verdict = down ? null : codexVerdict(fs.existsSync(where.lastMessage) ? fs.readFileSync(where.lastMessage, "utf8") : "", task, spec.words, watch?.lines() ?? []);
          why = down ? SANDBOX_DOWN_LINE : `the chat never reported a verdict${ran.code ? ` (codex exited ${ran.code}${read.error ? `: ${read.error}` : ""})` : ""}`;
        } else
          why = ran.timedOut
            ? `stopped after ${TASK_MAX_MINUTES} minutes: the chat never reported`
            : `the chat never reported${ran.code ? ` (${driver.bin} exited ${ran.code}${read.error ? `: ${read.error}` : ""})` : ""}`;
      } finally {
        for (const dir of [scratch, own]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  const look = lookLimit ? `The check didn't run: ${why}.` : `The look into it: ${why}.`;
  const line = clip(verdict ? verdict.line : task ? (limit ? why : `${why[0].toUpperCase()}${why.slice(1)}.`) : `${spec.line ?? "Red."} ${look}`);
  const state = verdict?.state ?? "red";
  const res = await send(d, id, { run, state, line, ...(limit ? { limit } : lookLimit ? { limit: lookLimit } : {}) }, "report");
  if (res.status === 409) return 0;
  if (!res.ok) throw new Error(await serverError(res, { issues: true }));
  d.stdout(`${state}: ${line}\n`);
  return state === "green" ? 0 : 1;
}

/**
 * `job read`: one listed gh or git read for a job's chat (readCommand), capped in time and output. gh runs outside any
 * checkout, so no local remote can name its repository; git runs in the jobs clone.
 * @param {string[]} argv @param {Deps} d
 */
async function jobRead(argv, d) {
  let command;
  try {
    command = readCommand(argv);
  } catch (err) {
    d.stdout(`${/** @type {Error} */ (err).message}\n`);
    return 2;
  }
  const cwd = command.tool === "gh" ? os.tmpdir() : path.join(d.home, ".rivet-agents", "jobs", "repo");
  const ran = await d.run(d.bin(command.tool), command.args, { cwd, timeoutMs: READ_TIMEOUT_MS, raw: true, env: { ...withoutRivetTokens(d.env), ...command.env } });
  d.stdout(ran.lines.join("\n").slice(0, READ_MAX_BYTES));
  return ran.code === 0 ? 0 : 1;
}

/** `job report`: a job chat closes its run. @param {string[]} argv @param {Deps} d */
async function jobReport(argv, d) {
  const [id, ...rest] = argv;
  /** @type {Record<string, string | undefined>} */
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    // The chat's permission fixes the first --run; a second must not replace it.
    if (Object.hasOwn(flags, rest[i])) return usage(d);
    flags[rest[i]] = rest[i + 1];
  }
  const { "--run": run, "--green": green, "--red": red, "--url": url, ...other } = flags;
  if (!id || !JOB_ID_RE.test(id) || !run || !RUN_ID.test(run) || (green === undefined) === (red === undefined) || Object.keys(other).length) return usage(d);
  const state = green === undefined ? "red" : "green";
  const res = await send(d, id, { run, state, line: green ?? red, ...(url ? { url } : {}) }, "report");
  if (!res.ok) throw new Error(await serverError(res, { issues: true }));
  d.stdout(`Reported ${id} ${state}.\n`);
  return 0;
}

/**
 * @param {string[]} argv
 * @param {Deps} d
 * @returns {Promise<number>}
 */
export async function main(argv, d) {
  const [first, ...rest] = argv;
  if (first === "job" && rest[0] === "read") return jobRead(rest.slice(1), d);
  if (first === "job" && rest[0] === "report") return jobReport(rest.slice(1), d);
  if (first === "--chat") {
    const [id, run, raw] = rest;
    if (!id || !JOB_ID_RE.test(id) || !run || !RUN_ID.test(run) || !raw || rest.length !== 3) return usage(d);
    return chat(d, id, run, JSON.parse(raw));
  }
  if (first === "--exec") {
    const [id, run, manual, planFlag, onPlan] = rest;
    if (!id || !JOB_ID_RE.test(id) || !run || !RUN_ID.test(run) || (planFlag !== undefined && (planFlag !== "--plan" || !isPlan(onPlan)))) return usage(d);
    const start = await put(d, id, { run, state: "start", ...runPlan(d, onPlan) });
    if (!start.go || start.job?.kind !== "check") return 1;
    const outcome = await checkAndReport(d, id, run, start.job.check, CHECK_BUDGET_MS, manual === "--manual");
    // A limit card's answer runs the check once on the other plan: its look, if it is still red, is on that plan.
    const look = onPlan && outcome.state === "red" && outcome.ran ? await put(d, id, { run, state: "look", ...runPlan(d, onPlan) }) : null;
    if (look?.go) await chat(d, id, run, { kind: "check", name: start.job.name, check: start.job.check, line: outcome.line, plan: onPlan });
    return outcome.state === "red" ? 1 : 0;
  }
  const manual = first === "--manual";
  const launchd = !manual && rest.length === 2 && rest[0] === "--launchd";
  const id = manual ? rest[0] : first;
  const action = manual && rest[1] === "--action" ? rest[2] : undefined;
  const planAt = action === undefined ? 1 : 3;
  const onPlan = manual && rest[planAt] === "--plan" ? rest[planAt + 1] : undefined;
  if (!(manual || launchd) || !id || !JOB_ID_RE.test(id) || (manual && rest.length !== planAt + (onPlan === undefined ? 0 : 2)) || (action !== undefined && !ACTION_ID_RE.test(action)) || (onPlan !== undefined && !isPlan(onPlan))) return usage(d);
  if (launchd && !launchdCron(rest[1])) return usage(d);
  if (launchd && !onTime(rest[1], d.now())) {
    d.stdout(`late: launchd started it more than ${MISSED_GRACE_MS / 60_000} minutes after its time, so it is left as missed\n`);
    return 0;
  }
  const run = newRunId();
  const start = await put(d, id, { run, state: "start", ...runPlan(d, onPlan), ...(manual ? { manual: true } : {}), ...(action ? { action } : {}) });
  if (!start.go) {
    d.stdout(`skipped: ${start.note}\n`);
    return 1;
  }
  const check = /** @type {Check | undefined} */ (start.job.check);
  if (start.job.kind === "task" || manual || check?.onRed === "card") {
    d.detach(start.job.kind === "task" ? ["--chat", id, start.run, JSON.stringify({ kind: "task", name: start.job.name, words: start.job.words, ...(onPlan ? { plan: onPlan } : {}) })] : ["--exec", id, start.run, ...(manual ? ["--manual"] : []), ...(onPlan ? ["--plan", onPlan] : [])]);
    d.stdout("background\n");
    return 0;
  }
  const outcome = await checkAndReport(d, id, start.run, /** @type {Check} */ (check), LOOK_BUDGET_MS, false);
  // Only a script that ran and failed has a cause to look for; the chat is a task run, so the server holds it to those limits.
  const look = outcome.state === "red" && outcome.ran ? await put(d, id, { run: start.run, state: "look", ...runPlan(d, undefined) }) : null;
  if (look?.go) d.detach(["--chat", id, start.run, JSON.stringify({ kind: "check", name: start.job.name, check, line: outcome.line })]);
  d.stdout(`${outcome.state}: ${outcome.line}${look && !look.go ? ` (no chat: ${look.note})` : ""}\n`);
  return outcome.state === "green" ? 0 : 1;
}

/** @param {Deps} d */
function usage(d) {
  d.stdout(USAGE);
  return 2;
}

/**
 * A run's output is redacted as it comes, with one redaction state for the whole of it, and only then cut to its last
 * KEEP_LINES: a secret's name thousands of lines back still hides its value.
 */
export function outputCollector() {
  const state = { inKey: false };
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  /** @type {string[]} */
  const lines = [];
  let partial = "";
  const add = (/** @type {string[]} */ raw) => {
    lines.push(...redactLines(raw, state));
    if (lines.length > KEEP_LINES) lines.splice(0, lines.length - KEEP_LINES);
  };
  const take = (/** @type {string} */ text) => {
    const parts = (partial + text).split(/\r?\n/);
    partial = parts.pop() ?? "";
    add(parts);
  };
  return {
    take: (/** @type {Buffer | string} */ chunk, /** @type {"stdout" | "stderr"} */ stream = "stdout") => {
      take(typeof chunk === "string" ? chunk : decoders[stream].write(chunk));
    },
    end: (/** @type {string[]} */ more = []) => {
      for (const decoder of Object.values(decoders)) take(decoder.end());
      add([...(partial ? [partial] : []), ...more]);
      partial = "";
      return lines;
    },
  };
}

/** @param {NodeJS.ProcessEnv} env @returns {Deps["run"]} */
export const spawnRun = (env) => (bin, args, { cwd, timeoutMs, raw = false, env: runEnv = env, watch }) =>
  new Promise((resolve) => {
    const out = outputCollector();
    // `watch` sees each whole line as it came, each stream on its own, before any redaction; nothing it sees is kept here.
    const watched = Object.fromEntries(
      /** @type {const} */ (["stdout", "stderr"]).map((stream) => {
        const decoder = new StringDecoder("utf8");
        let partial = "";
        return [stream, (/** @type {Buffer | string | null} */ chunk) => {
          const text = chunk === null ? `${decoder.end()}\n` : typeof chunk === "string" ? chunk : decoder.write(chunk);
          const parts = (partial + text).split(/\r?\n/);
          partial = parts.pop() ?? "";
          for (const line of parts) watch?.(stream, line);
        }];
      }),
    );
    const take = (/** @type {"stdout" | "stderr"} */ stream) => (/** @type {Buffer} */ chunk) => {
      if (watch) watched[stream](chunk);
      out.take(chunk, stream);
    };
    /** @type {Buffer[]} */
    const stdout = [];
    const lines = (/** @type {string[]} */ more = []) => (raw ? Buffer.concat(stdout).toString("utf8").split("\n") : out.end(more));
    // Nothing new starts once stopped() has begun.
    if (held.stopping) return resolve({ code: null, lines: ["stopped"], timedOut: false });
    const child = spawn(bin, args, { cwd, env: runEnv, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const pid = child.pid;
    if (pid) held.children.add(pid);
    let timedOut = false;
    const kill = (/** @type {NodeJS.Signals} */ signal) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);
    child.stdout.on("data", raw ? (/** @type {Buffer} */ chunk) => void stdout.push(chunk) : take("stdout"));
    child.stderr.on("data", raw ? () => {} : take("stderr"));
    child.on("error", (err) => {
      clearTimeout(timer);
      if (pid) held.children.delete(pid);
      resolve({ code: null, lines: lines([err.message]), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (pid) held.children.delete(pid);
      if (watch) for (const flush of Object.values(watched)) flush(null);
      resolve({ code, lines: lines(), timedOut });
    });
  });

/** @returns {Deps} */
function realDeps() {
  const env = withoutRivetTokens(process.env);
  const exec = makeExec();
  let token = /** @type {Promise<string> | null} */ (null);
  return {
    env: process.env,
    home: os.homedir(),
    now: Date.now,
    fetch,
    token: () => (token ??= readToken(exec, "RIVET_BRIDGE_TOKEN")),
    bin: (name) => resolveBin(name),
    stdout: (s) => void process.stdout.write(s),
    detach: (args) => {
      const child = spawn(process.execPath, [self, ...args], { detached: true, stdio: "ignore", env: process.env });
      child.unref();
    },
    run: spawnRun(env),
  };
}

let invoked = "";
try {
  invoked = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
} catch {}
if (invoked === fs.realpathSync(self)) {
  // launchd gives a job only PATH and HOME: its settings are the bridge's, in the install's .env.
  if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  process.once("SIGTERM", () => void stopped().finally(() => process.exit(143)));
  main(process.argv.slice(2), realDeps()).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`job-run: ${err instanceof Error ? err.message : "error"}\n`);
      process.exitCode = 1;
    },
  );
}
