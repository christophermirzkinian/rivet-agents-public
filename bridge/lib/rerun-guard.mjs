import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isTransientText } from "./github-classifier.mjs";

// What every automatic re-run must never do: one check, one log, one record of the jobs that were re-run. Any failed read
// refuses, and the red goes to a person.

/** A job, step or workflow that ships something: running it again ships it again, so its run is never re-run. */
export const NEVER_RETRY_RE = /\bdeploy|\brelease|\bpublish/i;

/** Whether a run ships something, or holds a job or step that does. @param {{ workflow: string }} run @param {readonly string[]} [names] */
export function neverRetry(run, names = []) {
  return NEVER_RETRY_RE.test(run.workflow) || names.some((name) => NEVER_RETRY_RE.test(name));
}

export const RUNNING_LIMIT = 8;
export const QUEUED_LIMIT = 5;

const RECORD_KEEP_MS = 30 * 24 * 3600_000;

export const SWITCH_DIR = join(homedir(), ".rivet-agents", "auto-handlers");
export const HANDLER_LOG_FILE = join(SWITCH_DIR, "decisions.jsonl");
export const RERUN_RECORD_FILE = join(SWITCH_DIR, "reruns.json");

/** @param {unknown} err */
const short = (err) => (err instanceof Error ? err.message.slice(0, 200) : "error");

/** Whether a file is there. One that cannot be told either way throws. @param {string} file */
function present(file) {
  try {
    statSync(file);
    return true;
  } catch (err) {
    if (/** @type {any} */ (err)?.code === "ENOENT") return false;
    throw err;
  }
}

/** Stops every re-run, whatever a handler's own switch says. */
const STOP_SWITCH = join(".rivet-agents", "auto-handlers", "STOP");

/** The stop switch when it is there now, else null. One that cannot be read is a stop. @param {string} [home] */
export function stopSwitch(home = homedir()) {
  try {
    return present(join(home, STOP_SWITCH)) ? STOP_SWITCH : null;
  } catch (err) {
    return `${STOP_SWITCH} unreadable: ${/** @type {any} */ (err)?.code ?? "error"}`;
  }
}

/**
 * Whether a handler may act, or only say what it would do. Armed needs `<name>.armed`, and neither `<name>.off` nor `off`;
 * a state that cannot be read is not armed.
 * @param {string} name @param {string} [dir]
 * @returns {{ armed: boolean, reason: string }}
 */
export function armState(name, dir = SWITCH_DIR) {
  try {
    if (present(join(dir, "off"))) return { armed: false, reason: "off" };
    if (present(join(dir, `${name}.off`))) return { armed: false, reason: `${name}.off` };
    return present(join(dir, `${name}.armed`)) ? { armed: true, reason: "armed" } : { armed: false, reason: "not armed" };
  } catch (err) {
    return { armed: false, reason: `switch unreadable: ${short(err)}` };
  }
}

/**
 * One decision, one line. A single small append is atomic, so two handlers can share the file.
 * @param {{ handler: string, decision: string, reason: string, at?: string } & Record<string, unknown>} entry
 * @param {string} [file]
 */
export function logDecision(entry, file = HANDLER_LOG_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ ...entry, at: entry.at ?? new Date().toISOString() })}\n`);
}

/** @typedef {{ job: string, sha: string, at: string, run: number, attempt: number, cause: string, result: "pending" | "passed" | "failed" }} RerunRecord */

/** A record that cannot be read throws. @param {string} file @returns {RerunRecord[]} */
function readRecord(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (/** @type {any} */ (err)?.code === "ENOENT") return [];
    throw err;
  }
  const doc = JSON.parse(text);
  if (!Array.isArray(doc?.jobs)) throw new Error("no jobs");
  return doc.jobs;
}

/** Written only under the record's lock (underLock). @param {RerunRecord[]} jobs @param {string} file */
function writeRecord(jobs, file) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ jobs }, null, 2)}\n`);
  renameSync(tmp, file);
}

const LOCK_WAIT_MS = 5_000;
// O_EXLOCK from darwin's <sys/fcntl.h>; node's fs.constants does not export it.
const O_EXLOCK = 0x20;
const lockPause = new Int32Array(new SharedArrayBuffer(4));

/**
 * The lock's descriptor, with the kernel lock taken, else null while another holds it. Only the file the path still
 * names is held: open() finds the file before it locks it.
 * @param {string} lock
 */
function kernelLock(lock) {
  for (let tries = 0; ; tries++) {
    let fd;
    try {
      fd = openSync(lock, constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK, 0o644);
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") return null;
      throw err;
    }
    let current = Number.NaN;
    try {
      current = statSync(lock).ino;
    } catch {}
    if (current === fstatSync(fd).ino) return fd;
    closeSync(fd);
    if (tries >= 4) throw new Error(`could not take ${lock}: it keeps being replaced`);
  }
}

/**
 * `write` with `<file>.lock` held, so a read and the write after it are one step, however many processes write the record.
 * On darwin it is a kernel lock (O_EXLOCK) on a file that is never removed: the OS frees a dead holder's lock, and a live
 * holder keeps it however long it is paused, so there is no takeover for a stale writer to race. Elsewhere it is an
 * exclusive create with no takeover: a dead holder's file stays until someone removes it. A lock still held after
 * `waitMs` throws.
 * @template T @param {string} file @param {() => T} write @param {{ platform?: string, waitMs?: number }} [opts]
 * @returns {T}
 */
export function underLock(file, write, { platform = process.platform, waitMs = LOCK_WAIT_MS } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const until = Date.now() + waitMs;
  /** @type {(() => void) | null} */
  let release = null;
  for (;;) {
    if (platform === "darwin") {
      const fd = kernelLock(lock);
      if (fd !== null) release = () => closeSync(fd);
    } else {
      try {
        writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
        release = () => rmSync(lock, { force: true });
      } catch (err) {
        if (/** @type {any} */ (err)?.code !== "EEXIST") throw err;
      }
    }
    if (release) break;
    if (Date.now() >= until) throw new Error(`the re-run record is locked${platform === "darwin" ? "" : ` (or its writer died: remove ${lock} once none runs)`}`);
    Atomics.wait(lockPause, 0, 0, 50);
  }
  try {
    return write();
  } finally {
    release();
  }
}

/** @param {RerunRecord} one */
const jobKey = (one) => `${one.run}:${one.attempt}:${one.sha}:${one.job}`;

/** The jobs re-run so far. @param {string} [file] */
export function readRerunRecord(file = RERUN_RECORD_FILE) {
  return readRecord(file);
}

/**
 * `jobs` over the record as it is now: a job only the record holds is kept, and a result the record already has is never
 * put back to pending.
 * @param {RerunRecord[]} jobs @param {number} now @param {string} [file]
 */
export function writeRerunRecord(jobs, now, file = RERUN_RECORD_FILE) {
  underLock(file, () => {
    const current = readRecord(file);
    const known = new Map(current.map((one) => [jobKey(one), one]));
    const mine = new Set(jobs.map(jobKey));
    const merged = [
      ...jobs.map((one) => {
        const there = known.get(jobKey(one));
        return one.result === "pending" && there && there.result !== "pending" ? there : one;
      }),
      ...current.filter((one) => !mine.has(jobKey(one))),
    ];
    writeRecord(merged.filter((one) => now - Date.parse(one.at) < RECORD_KEEP_MS), file);
  });
}

/**
 * A re-run's jobs reserved: `recheck` (the caller's switches, read now) and jobLock judged again on the record as it is
 * now, and the jobs written only if both still allow them, all under the one lock. Two writers that each passed jobLock
 * earlier cannot both re-run a job, and a switch turned off while the lock was waited on is seen.
 * @param {RerunRecord[]} jobs one SHA's @param {number} now @param {string} [file] @param {() => string | null} [recheck]
 * @returns {string | null} the refusal, else null once written
 */
export function reserveRerun(jobs, now, file = RERUN_RECORD_FILE, recheck = () => null) {
  return underLock(file, () => {
    const current = readRecord(file);
    const refused = recheck() ?? jobLock(current, jobs, jobs[0].sha);
    if (refused) return refused;
    writeRecord([...jobs, ...current].filter((one) => now - Date.parse(one.at) < RECORD_KEEP_MS), file);
    return null;
  });
}

/**
 * The lock on these jobs: one re-run per job per SHA.
 * @param {readonly RerunRecord[]} record @param {readonly { job: string }[]} jobs @param {string} sha
 * @returns {string | null} why not, or null
 */
export function jobLock(record, jobs, sha) {
  for (const { job } of jobs) {
    if (record.some((one) => one.job === job && one.sha === sha)) return `${job} already had its re-run on this SHA`;
  }
  return null;
}

const CAUSES = /** @type {const} */ ([
  ["runner restart", /lost communication with the server|runner has received a shutdown signal/i],
  ["action download", /Failed to download (?:action|archive)|download has timed out|Unable to (?:download|resolve) action|HttpClient\.Timeout/i],
  ["GitHub unavailable", /getaddrinfo (?:EAI_AGAIN|ENOTFOUND)|ECONNRESET|ETIMEDOUT|socket hang up|encountered an internal error|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out/i],
]);
const GENERIC_RE = /^Process completed with exit code \d+\.?$/;

/** One error line's passing cause, else null. @param {string} message */
function lineCause(message) {
  for (const [cause, re] of CAUSES) if (re.test(message)) return cause;
  return isTransientText(message) ? "GitHub unavailable" : null;
}

/**
 * A failed job's verdict from its error lines: its passing cause when every line is passing trouble or the
 * generic exit line and one is trouble, "generic" when there are only exit lines, else null (a real failure).
 * An annotation can hold several lines, each judged on its own; a blank one is a real failure.
 * @param {string[]} messages
 */
export function jobVerdict(messages) {
  let cause = null;
  for (const message of messages) {
    const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return null;
    for (const text of lines) {
      if (GENERIC_RE.test(text)) continue;
      const found = lineCause(text);
      if (!found) return null;
      cause ??= found;
    }
  }
  return cause ?? (messages.length ? "generic" : null);
}

/**
 * @typedef {{ repo: string, workflow: string, names: readonly unknown[] }} RerunFacts
 *   names: the run's failed jobs and failed steps, and the jobs it skipped, which a re-run would start.
 * @typedef {{ ok: true } | { ok: false, reason: string, busy?: true }} RerunCheck
 *   busy: only for now, so a caller with time left may ask again; anything else goes to a person.
 * @typedef {{ gh: (args: string[]) => Promise<any>, home?: string }} GuardDeps
 */

/**
 * Every refusal in one check, cheapest first.
 * @param {RerunFacts} facts @param {GuardDeps} deps
 * @returns {Promise<RerunCheck>}
 */
export async function checkRerun(facts, deps) {
  try {
    return await check(facts, deps);
  } catch (err) {
    return { ok: false, reason: `read failed: ${short(err)}` };
  }
}

/** @param {RerunFacts} facts @param {GuardDeps} deps @returns {Promise<RerunCheck>} */
async function check(facts, deps) {
  const stop = stopSwitch(deps.home);
  if (stop) return { ok: false, reason: `${stop} is on` };
  if (NEVER_RETRY_RE.test(facts.workflow)) return { ok: false, reason: `a workflow that ships: ${facts.workflow}` };
  for (const name of facts.names) {
    if (typeof name !== "string" || !name.trim()) return { ok: false, reason: "a failed job or step has no name" };
    if (NEVER_RETRY_RE.test(name)) return { ok: false, reason: `a job that ships: ${name}` };
  }

  /** @param {string} status */
  const active = (status) => deps.gh([`repos/${facts.repo}/actions/runs?status=${status}&per_page=1`, "--jq", "{total: .total_count}"]);
  const [running, queued] = await Promise.all([active("in_progress"), active("queued")]);
  if (!Number.isInteger(running?.total) || !Number.isInteger(queued?.total)) throw new Error("run counts not read");
  if (running.total >= RUNNING_LIMIT) return { ok: false, reason: `${running.total} runs in progress`, busy: true };
  if (queued.total >= QUEUED_LIMIT) return { ok: false, reason: `${queued.total} runs queued`, busy: true };
  return { ok: true };
}
