import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultRepo } from "../../../src/shared/repos.ts";
import {
  armState,
  checkRerun,
  HANDLER_LOG_FILE,
  jobLock,
  jobVerdict,
  logDecision,
  NEVER_RETRY_RE,
  neverRetry,
  readRerunRecord,
  RERUN_RECORD_FILE,
  reserveRerun,
  stopSwitch,
  writeRerunRecord,
} from "../rerun-guard.mjs";

export { jobVerdict, NEVER_RETRY_RE, neverRetry };

// A red first attempt of a CI run on main gets one re-run of its failed jobs before Ops sees it, when every
// failed job failed on a passing cause: GitHub's API or a 5xx, an action download or network timeout, or a
// self-hosted runner that went away. Until the re-run ends the run goes to the server as queued, which is what
// GitHub shows a minute later, so no Ops record, alert or failing-schedule card starts; a red re-run is red as
// before. Only the CI workflow: other workflows may ship something, and running one twice does it twice.
//
// The causes come from each failed job's failure annotations (the error lines of its log), read once per run
// attempt. A job counts as passing trouble only when every one of its error lines is, bar the generic exit line.
// A run with a job that ships, failed or waiting behind a failed one, is never re-run nor held. A run whose jobs
// or annotations cannot be read is red at once. One re-run per run id, written to `file` before it is asked for
// and kept even when the ask fails, since GitHub may have taken it; a list that cannot be read asks for none.
// ../rerun-guard.mjs may refuse any of it.
//
// Nothing here asks, holds or writes a record without ~/.rivet-agents/auto-handlers/main-rerun.armed: the log says
// what would have happened. A re-run already out is still seen through.

export const RERUNS_FILE = join(homedir(), ".rivet-agents", "ci-reruns.json");
export const RETRY_WORKFLOW = "CI";
/** A red run older than this is shown as it is: it was red on Ops before this pass. */
export const HOLD_MS = 20 * 60_000;
/** A re-run GitHub never started stops holding its run after this. */
export const RERUN_HOLD_MS = 3 * 3600_000;
/** After an ask whose answer was lost: long enough for GitHub to show the new attempt if it took it. */
export const UNSURE_HOLD_MS = 10 * 60_000;
const KEEP_DAYS = 14;
const KEEP_MAX = 500;
const CLASSIFY_MAX = 200;
/** Runs classified per pass; each costs one read, plus one per failed job. */
const MAX_CLASSIFY = 5;
const MAX_FAILED_JOBS = 30;
const TIMEOUT_MS = 30_000;
/** Fails when any other job failed: its exit line is no cause of its own. */
const AGGREGATE_JOB = "CI complete";

const HANDLER = "main-rerun";
const SAID_MAX = 200;

/** The passing cause of a job's error lines, else null. @param {string[]} messages */
export function causeOf(messages) {
  const verdict = jobVerdict(messages);
  return verdict === "generic" ? null : verdict;
}

/**
 * @typedef {{ repo: string, id: number, attempt: number, workflow: string, event: string, sha: string, status: string,
 *   conclusion: string | null, createdAt: string, updatedAt: string, failedJobs?: string[] }} Run
 * @typedef {{ at: string, attempt: number, cause: string, unsure?: true, declined?: true }} Retry
 *   declined: refused on a passing cause, so never asked for and never held.
 * @typedef {{ id: number, name: string, conclusion: string, steps: unknown[] }} ReadJob
 * @typedef {{ job: string, cause: string }} RerunJob
 */

/** @param {Run} run */
const isCiPush = (run) => run.repo === defaultRepo() && run.workflow === RETRY_WORKFLOW && run.event === "push";
/** @param {Run} run */
const isRedCi = (run) => isCiPush(run) && run.status === "completed" && ["failure", "timed_out"].includes(run.conclusion ?? "");

/** @param {unknown} err */
const short = (err) => (err instanceof Error ? err.message.slice(0, 200) : "error");

/**
 * @param {{ exec: import("../config.mjs").Exec, ghBin: string, log: (event: string, fields?: Record<string, unknown>) => void,
 *   file?: string, now?: () => Date, check?: (run: Run, names: readonly unknown[]) => Promise<import("../rerun-guard.mjs").RerunCheck>,
 *   armed?: () => boolean, guard?: { home?: string }, logFile?: string, recordFile?: string, stops?: () => string | null }} deps
 */
export function createFalseAlarmRetry(deps) {
  const { exec, ghBin, log } = deps;
  const file = deps.file ?? RERUNS_FILE;
  const logFile = deps.logFile ?? HANDLER_LOG_FILE;
  const recordFile = deps.recordFile ?? RERUN_RECORD_FILE;
  const armedNow = deps.armed ?? (() => armState(HANDLER).armed);
  const stopsNow = deps.stops ?? (() => stopSwitch(deps.guard?.home));
  const nowMs = () => (deps.now ?? (() => new Date()))().getTime();
  /** run attempt → its passing cause, or null when it failed for real; shared by the Ops and schedules loops. */
  const causes = new Map();
  /** Run attempts the Ops pass chose not to re-run although their cause was passing (a newer run had started, or the guard said no). */
  const declined = new Set();
  /** Run attempts whose would-be re-run or refusal on a passing cause is in the log already; arming evaluates them afresh. */
  const planned = new Set();
  /** Failed job id → its verdict from its error lines. */
  const jobVerdicts = new Map();
  /** Run → the last thing the log said of it, so a wait that goes on is one line. */
  const said = new Map();

  /** @param {string[]} args */
  const gh = async (args) => JSON.parse((await exec(ghBin, ["api", ...args], { timeout: TIMEOUT_MS })).stdout);

  /** @returns {Record<string, Retry> | null} null when the list is there but unreadable */
  function readRetries() {
    try {
      const doc = JSON.parse(readFileSync(file, "utf8"));
      if (typeof doc?.runs !== "object" || doc.runs === null || Array.isArray(doc.runs)) throw new Error("no runs");
      return doc.runs;
    } catch (err) {
      if (/** @type {any} */ (err)?.code === "ENOENT") return {};
      log("ci-rerun-list-unreadable", { error: short(err) });
      return null;
    }
  }

  /** @param {Record<string, Retry>} runs @param {number} now */
  function writeRetries(runs, now) {
    const kept = Object.entries(runs)
      .filter(([, retry]) => now - Date.parse(retry.at) < KEEP_DAYS * 24 * 3600_000)
      .sort(([, a], [, b]) => a.at.localeCompare(b.at))
      .slice(-KEEP_MAX);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ runs: Object.fromEntries(kept) }, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  }

  /** @param {Record<string, unknown> & { decision: string, reason: string }} entry @param {number} now */
  function decide(entry, now) {
    try {
      logDecision({ handler: HANDLER, at: new Date(now).toISOString(), ...entry }, logFile);
    } catch (err) {
      log("ci-rerun-log-failed", { error: short(err) });
    }
  }

  /** @param {Run} run @param {string} decision @param {string} reason @param {number} now */
  function sayOnce(run, decision, reason, now) {
    const key = `${run.repo}#${run.id}`;
    if (said.get(key) === `${decision}|${reason}`) return;
    if (said.size >= SAID_MAX) said.delete(said.keys().next().value);
    said.set(key, `${decision}|${reason}`);
    decide({ decision, reason, run: run.id, sha: run.sha }, now);
  }

  /** @param {Run} run @param {readonly unknown[]} names */
  const guarded = (run, names) => (deps.check ? deps.check(run, names) : checkRerun({ repo: run.repo, workflow: run.workflow, names }, { gh, ...deps.guard }));

  /** A job's verdict from its error lines, read once. Throws when they cannot be read. @param {Run} run @param {ReadJob} job */
  async function annotationVerdict(run, job) {
    if (jobVerdicts.has(job.id)) return jobVerdicts.get(job.id);
    if (!Number.isSafeInteger(job.id)) throw new Error("gh returned no job id");
    const messages = await gh([`repos/${run.repo}/check-runs/${job.id}/annotations?per_page=100`, "--jq", '[.[] | select(.annotation_level == "failure") | .message]']);
    if (!Array.isArray(messages) || messages.some((message) => typeof message !== "string")) throw new Error("gh returned no annotations");
    const verdict = jobVerdict(messages);
    if (jobVerdicts.size >= CLASSIFY_MAX) jobVerdicts.delete(jobVerdicts.keys().next().value);
    jobVerdicts.set(job.id, verdict);
    return verdict;
  }

  /**
   * The run's passing cause, null when it failed for real or holds a job that ships, with what was read to say so.
   * Throws when GitHub could not be read.
   * @param {Run} run
   */
  async function classify(run) {
    // 50 to a page, one array a line under --paginate: GitHub answers 502 at 100 on a large run.
    const pages = String(
      (
        await exec(
          ghBin,
          [
            "api",
            `repos/${run.repo}/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=50`,
            "--paginate",
            "--jq",
            '[.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "skipped") | {id, name, conclusion, steps: [.steps[]? | select(.conclusion == "failure" or .conclusion == "timed_out") | .name]}]',
          ],
          { timeout: TIMEOUT_MS },
        )
      ).stdout,
    )
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    if (!pages.length || !pages.every(Array.isArray)) throw new Error("gh returned no jobs");
    /** @type {ReadJob[]} */
    const read = pages.flat();
    if (read.some((job) => !Array.isArray(job?.steps))) throw new Error("gh returned no jobs");
    const jobs = read.filter((job) => job.conclusion !== "skipped");
    // A re-run of the failed jobs starts whatever was skipped behind them, so those names count too.
    const names = read.flatMap((job) => [job.name, ...job.steps]);
    /** @type {RerunJob[]} */
    const faults = [];
    /** @param {string | null} cause */
    const found = (cause) => ({ cause, names, faults });
    // A job or failed step with no name could be one that ships: the run is a real failure.
    if (names.some((name) => typeof name !== "string" || !name.trim())) return found(null);
    if (neverRetry(run, /** @type {string[]} */ (names))) return found(null);
    if (!jobs.length || jobs.length > MAX_FAILED_JOBS) return found(null);
    let first = null;
    for (const job of jobs) {
      const verdict = await annotationVerdict(run, job);
      if (verdict === null || (verdict === "generic" && job.name !== AGGREGATE_JOB)) return found(null);
      if (verdict !== "generic") {
        first ??= verdict;
        faults.push({ job: job.name, cause: verdict });
      }
    }
    return found(first);
  }

  /** The cause of one run attempt, read once and shared; a failed read is not kept, so the next pass reads again. @param {Run} run */
  function causeFor(run) {
    const key = `${run.repo}#${run.id}:${run.attempt}`;
    let known = causes.get(key);
    if (!known) {
      known = classify(run);
      known.catch(() => causes.delete(key));
      if (causes.size >= CLASSIFY_MAX) causes.delete(causes.keys().next().value);
      causes.set(key, known);
    }
    return /** @type {ReturnType<typeof classify>} */ (known);
  }

  /**
   * Why main has moved on from a run, else null: a new tip is final, another main run out is only for now. Throws on a read.
   * @param {Run} run
   */
  async function mainMoved(run) {
    const { sha: tip } = await gh([`repos/${run.repo}/commits/main`, "--jq", "{sha: .sha}"]);
    if (tip !== run.sha) return { reason: "its SHA is no longer main's tip", busy: false };
    for (const state of ["in_progress", "queued", "pending"]) {
      const { total } = await gh([`repos/${run.repo}/actions/runs?branch=main&status=${state}&per_page=100`, "--jq", `{total: [.workflow_runs[] | select(.name == ${JSON.stringify(RETRY_WORKFLOW)})] | length}`]);
      if (!Number.isInteger(total)) throw new Error("no count of main's runs");
      if (total > 0) return { reason: `another main run is ${state}`, busy: true };
    }
    return null;
  }

  /**
   * Reserves the jobs and writes what a re-run rests on, then asks. The stop and the armed file are read again under the
   * record's lock, after any wait for it. Not ok when the reservation was refused (`locked`: a stop, or a job already
   * taken), the switch is off (`unarmed`), or a write failed, so nothing was asked.
   * @param {Run} run @param {Record<string, Retry>} retries @param {Retry} entry @param {readonly RerunJob[]} jobs @param {number} now
   * @returns {Promise<{ ok: boolean, locked?: string, unarmed?: true }>}
   */
  async function askRerun(run, retries, entry, jobs, now) {
    const at = new Date(now).toISOString();
    let unarmed = false;
    const recheck = () => {
      const stop = stopsNow();
      if (stop) return stop;
      unarmed = !armedNow();
      return unarmed ? "not armed" : null;
    };
    try {
      const locked = reserveRerun(jobs.map((one) => ({ ...one, sha: run.sha, at, run: run.id, attempt: run.attempt, result: /** @type {const} */ ("pending") })), now, recordFile, recheck);
      if (unarmed) return { ok: false, unarmed: true };
      if (locked) return { ok: false, locked };
      retries[`${run.repo}#${run.id}`] = entry;
      writeRetries(retries, now);
    } catch (err) {
      log("ci-rerun-list-failed", { run: run.id, error: short(err) });
      return { ok: false };
    }
    let reason = "a GitHub or runner fault";
    try {
      await exec(ghBin, ["api", "-X", "POST", `repos/${run.repo}/actions/runs/${run.id}/rerun-failed-jobs`], { timeout: TIMEOUT_MS });
      log("ci-rerun", { run: run.id, attempt: run.attempt, cause: entry.cause });
    } catch (err) {
      entry.unsure = true;
      reason = "asked, and GitHub's answer was lost";
      try {
        writeRetries(retries, now);
      } catch {
        log("ci-rerun-list-failed", { run: run.id });
      }
      log("ci-rerun-unsure", { run: run.id, error: short(err) });
    }
    for (const one of jobs) decide({ decision: "rerun", reason, run: run.id, sha: run.sha, job: one.job, cause: one.cause }, now);
    return { ok: true };
  }

  /** What became of the re-runs still out. @param {string} repo @param {number} now */
  async function followUp(repo, now) {
    let record;
    try {
      record = readRerunRecord(recordFile);
    } catch (err) {
      log("ci-rerun-record-unreadable", { error: short(err) });
      return;
    }
    const out = record.filter((one) => one.result === "pending");
    if (!out.length) return;
    const retries = readRetries();
    for (const id of new Set(out.map((one) => one.run))) {
      const mine = out.filter((one) => one.run === id);
      const { at, attempt, sha } = mine[0];
      const hold = retries?.[`${repo}#${id}`]?.unsure ? UNSURE_HOLD_MS : RERUN_HOLD_MS;
      /** @type {"passed" | "failed" | null} */
      let result = null;
      try {
        const run = await gh([`repos/${repo}/actions/runs/${id}`, "--jq", "{attempt: .run_attempt, status, conclusion}"]);
        if (run.attempt > attempt) {
          if (run.status === "completed") result = run.conclusion === "success" ? "passed" : "failed";
        } else if (now - Date.parse(at) >= hold) {
          result = "failed";
        }
      } catch (err) {
        log("ci-rerun-followup-failed", { run: id, error: short(err) });
        if (now - Date.parse(at) >= RERUN_HOLD_MS) result = "failed";
      }
      if (!result) continue;
      for (const one of mine) one.result = result;
      try {
        writeRerunRecord(record, now, recordFile);
      } catch (err) {
        log("ci-rerun-record-failed", { run: id, error: short(err) });
        return;
      }
      for (const one of mine) decide({ decision: result === "passed" ? "passed" : "stayed-red", reason: result === "passed" ? "the re-run went green" : "the re-run did not go green", run: id, sha, job: one.job, cause: one.cause }, now);
    }
  }

  /** Whether a run's re-run, asked for or to come, still holds it. @param {Run} run @param {Retry} retry @param {number} now */
  const pending = (run, retry, now) => !retry.declined && run.attempt <= retry.attempt && now - Date.parse(retry.at) < (retry.unsure ? UNSURE_HOLD_MS : RERUN_HOLD_MS);

  /** Whether a red first attempt may still get its re-run. @param {Run} run @param {number} now */
  const eligible = (run, now) => run.attempt === 1 && now - Date.parse(run.updatedAt) < HOLD_MS && !neverRetry(run, run.failedJobs);

  /**
   * A no on a passing cause stands, across a restart too: an entry in the list is what the next bridge skips on. Without
   * the armed file it is only the plan's: nothing is written, and arming evaluates the run afresh.
   * @param {Run} run @param {Record<string, Retry>} retries @param {string} cause @param {number} now
   */
  function decline(run, retries, cause, now) {
    const attemptKey = `${run.repo}#${run.id}:${run.attempt}`;
    if (!armedNow()) {
      planned.add(attemptKey);
      return;
    }
    declined.add(attemptKey);
    retries[`${run.repo}#${run.id}`] = { at: new Date(now).toISOString(), attempt: run.attempt, cause, declined: true };
    try {
      writeRetries(retries, now);
    } catch (err) {
      log("ci-rerun-list-failed", { run: run.id, error: short(err) });
    }
  }

  return {
    /**
     * One Ops pass over the runs the GitHub collector read: the runs to send, with a run held while its re-run is to come.
     * @template {Run} T
     * @param {T[]} runs
     * @returns {Promise<T[]>}
     */
    async cycle(runs) {
      const repo = defaultRepo();
      if (!repo) return runs;
      const now = nowMs();
      await followUp(repo, now);
      const red = runs.filter(isRedCi);
      if (!red.length) return runs;
      const retries = readRetries();
      if (retries === null) return runs;
      /** @type {Set<T>} */
      const held = new Set();
      let classified = 0;
      for (const run of red) {
        const key = `${run.repo}#${run.id}`;
        const retry = retries[key];
        if (retry) {
          if (pending(run, retry, now)) held.add(run);
          continue;
        }
        if (!eligible(run, now)) continue;
        const attemptKey = `${key}:${run.attempt}`;
        if (declined.has(attemptKey) || (planned.has(attemptKey) && !armedNow())) continue;
        // A re-run waits in CI's concurrency group and would take the place of a newer run pending there.
        if (runs.some((other) => other.repo === run.repo && other.workflow === run.workflow && other.createdAt > run.createdAt)) {
          (armedNow() ? declined : planned).add(attemptKey);
          continue;
        }
        if (!causes.has(attemptKey) && classified++ >= MAX_CLASSIFY) continue;
        let found;
        try {
          found = await causeFor(run);
        } catch (err) {
          log("ci-rerun-check-failed", { run: run.id, error: short(err) });
          continue;
        }
        const { cause } = found;
        if (cause === null) continue;
        const checked = await guarded(run, found.names);
        if (!checked.ok) {
          if (!checked.busy) decline(run, retries, cause, now);
          sayOnce(run, checked.busy ? "waiting" : "refused", checked.reason, now);
          continue;
        }
        let moved;
        let record;
        try {
          moved = await mainMoved(run);
          record = readRerunRecord(recordFile);
        } catch (err) {
          decline(run, retries, cause, now);
          sayOnce(run, "refused", `read failed: ${short(err)}`, now);
          continue;
        }
        if (moved) {
          if (!moved.busy) decline(run, retries, cause, now);
          sayOnce(run, moved.busy ? "waiting" : "refused", moved.reason, now);
          continue;
        }
        const locked = jobLock(record, found.faults, run.sha);
        if (locked) {
          decline(run, retries, cause, now);
          sayOnce(run, "refused", locked, now);
          continue;
        }
        const plan = () => {
          planned.add(attemptKey);
          for (const one of found.faults) decide({ decision: "would-rerun", reason: "would re-run: a GitHub or runner fault", run: run.id, sha: run.sha, job: one.job, cause: one.cause }, now);
        };
        if (!armedNow()) {
          plan();
          continue;
        }
        const asked = await askRerun(run, retries, { at: new Date(now).toISOString(), attempt: run.attempt, cause }, found.faults, now);
        if (asked.unarmed) {
          plan();
          continue;
        }
        if (asked.locked) {
          decline(run, retries, cause, now);
          sayOnce(run, "refused", asked.locked, now);
          continue;
        }
        if (!asked.ok) return runs;
        held.add(run);
      }
      return runs.map((run) => {
        if (!held.has(run)) return run;
        const { failedJobs: _failed, ...rest } = run;
        return /** @type {T} */ ({ ...rest, status: "queued", conclusion: null });
      });
    },

    /**
     * For the schedules loop: whether a red run waits on its one re-run, asked for or to be asked by the next Ops pass.
     * Never asks GitHub for one itself. @param {Run} run
     */
    async held(run) {
      if (!isRedCi(run)) return false;
      const now = nowMs();
      const retries = readRetries();
      if (retries === null) return false;
      const retry = retries[`${run.repo}#${run.id}`];
      if (retry) return pending(run, retry, now);
      const attemptKey = `${run.repo}#${run.id}:${run.attempt}`;
      if (!eligible(run, now) || declined.has(attemptKey) || !armedNow()) return false;
      try {
        return (await causeFor(run)).cause !== null;
      } catch {
        return false;
      }
    },
  };
}
