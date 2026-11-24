// gh's login, read once for a whole scheduled process. Each `gh` call reads the login from the macOS keychain and gives
// that read a few seconds. At background priority on a loaded Mac the read sometimes runs out of time: gh then sends the
// call with no login, GitHub answers 404 for a private repository and gh exits 1, which is no transient GitHub error, so
// the run fails (about 1 run in 5 of a job that makes 10-30 calls). Here the login is read once, with
// retries, and handed to each gh call in the child's environment, so later calls never touch the keychain. Under heavy
// load the read can fail for a minute or more (four tries in a row): then no call goes out at all, and
// the run ends as a skip the next run retries, rather than going out logged out halfway through a pass.
//
// The login lives only in this closure and in the gh child's environment: never in arguments, a log line, a file or an
// error.

import { ExecError } from "./config.mjs";

/** @typedef {import("./config.mjs").Exec} Exec */

/** How many times the login is read before the run gives up on it. */
export const LOGIN_TRIES = 6;

/** The longest pause between two tries: the pauses double from `pauseMs` up to this (1, 2, 4, 8, 16 s by default). */
export const LONGEST_PAUSE_MS = 30_000;

/**
 * The login could not be read, so no gh call was made: the run says nothing about GitHub or the job. scheduledRun ends
 * it as a skip the next run retries, red after the grace hour. It carries nothing of any child's output.
 */
export class GhLoginUnread extends Error {
  constructor() {
    super("gh login unreadable");
    this.name = "GhLoginUnread";
  }
}

/**
 * gh's own answer when its keychain read ran out of time: it finds no login and says so. A read our own limit cut
 * short is the same. Anything else (gh missing or broken, an old gh with no `auth token`, a bad config) is a fault.
 * @param {unknown} err
 */
function readTimedOut(err) {
  if (!(err instanceof ExecError)) return false;
  return err.code === "ETIMEDOUT" || err.message.endsWith(" timed out") || /^no oauth token found\b/.test(err.stderrFirstLine);
}

/**
 * `gh auth token` failed for a reason that is not a slow keychain, so the run fails at once rather than skipping for
 * the grace hour. It keeps only gh's exit ("gh exit 1"), never any of the child's output: gh's stderr can echo a
 * login of any shape, so none of its text is logged (run `gh auth token` by hand to see what it says).
 */
export class GhLoginFault extends Error {
  /** @param {unknown} err */
  constructor(err) {
    super(`gh auth token failed: ${err instanceof ExecError ? err.message : "gh failed"}`);
    this.name = "GhLoginFault";
  }
}

/**
 * `gh` through `exec`, with the login read once and passed as GH_TOKEN. With GH_TOKEN or GITHUB_TOKEN already set, gh
 * uses that and never reads the keychain, so `exec` is called as it is. When every try of the read finds no login in
 * time, this call and every later one in the process throw GhLoginUnread without calling gh, with no further read;
 * when a try fails any other way, they all throw that GhLoginFault. `ready()` reads the login and throws the same,
 * for a reader to await before its pass.
 * @param {Exec} exec
 * @param {string} ghBin
 * @param {{ env?: NodeJS.ProcessEnv, sleep?: (ms: number) => Promise<unknown>, pauseMs?: number,
 *   log?: (event: string, fields: Record<string, unknown>) => void }} [opts]
 *   `log` is called at most once, with `gh-login-unread` and the number of tries only.
 * @returns {((args: string[], execOpts: Parameters<Exec>[2]) => Promise<{ stdout: string, stderr: string }>) & { ready: () => Promise<void> }}
 */
export function makeGh(exec, ghBin, { env = process.env, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), pauseMs = 1_000, log } = {}) {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) {
    /** @param {string[]} args @param {Parameters<Exec>[2]} execOpts */
    const given = (args, execOpts) => exec(ghBin, args, execOpts);
    given.ready = async () => {};
    return given;
  }
  /** @type {Promise<string> | null} */
  let reading = null;

  const read = async () => {
    for (let n = 1; n <= LOGIN_TRIES; n += 1) {
      try {
        const out = (await exec(ghBin, ["auth", "token"], { timeout: 20_000, maxBuffer: 64 * 1024 })).stdout.trim();
        if (out && !/[\r\n]/.test(out)) return out;
      } catch (err) {
        // The error is never kept or thrown as it is: an ExecError keeps the child's stdout.
        if (!readTimedOut(err)) throw new GhLoginFault(err);
      }
      if (n < LOGIN_TRIES) await sleep(Math.min(pauseMs * 2 ** (n - 1), LONGEST_PAUSE_MS));
    }
    return "";
  };

  // One read for the life of the process, whatever it found: a login that could not be read is not asked for again,
  // so a keychain that stays shut costs one round of tries, not one per call.
  const login = () =>
    (reading ??= read().then((found) => {
      try {
        if (!found) log?.("gh-login-unread", { tries: LOGIN_TRIES });
      } catch {
        // A logger that throws must not turn the kept read into a kept failure.
      }
      return found;
    }));

  /** @param {string[]} args @param {Parameters<Exec>[2]} execOpts */
  const gh = async (args, execOpts) => {
    const found = await login();
    // No call goes out logged out: a run whose login could not be read does nothing and ends as a skip.
    if (!found) throw new GhLoginUnread();
    return exec(ghBin, args, { ...execOpts, env: { ...execOpts.env, GH_TOKEN: found } });
  };
  // Awaited by a reader before its pass, so a run with no login stops before it reads, asks or writes anything.
  gh.ready = async () => {
    if (!(await login())) throw new GhLoginUnread();
  };
  return gh;
}
