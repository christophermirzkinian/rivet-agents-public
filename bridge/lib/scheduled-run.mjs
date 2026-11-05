// How a scheduled Rivet job's run ends. GitHub refusing it, for the hourly budget every tool on the owner's account
// shares or for an outage, is no failure of the job: the run says "rate-limited, resets at <time>" (or which outage)
// and exits 0, since the next run tries again, and the schedule watcher, which counts only exit 0 as a good run, raises
// no card for it. Skips stay green for TRANSIENT_GRACE_MS from the first in a row (scripts/transient-github.mjs), so a
// fault that only looks like GitHub's still turns red. Any other error fails the run as before.
import os from "node:os";
import path from "node:path";
import { defaultRepo } from "../../src/shared/repos.ts";
import { ExecError, formatLog, makeExec, resolveBin } from "./config.mjs";
import { endTransientStreak, transientStreak, whyOf } from "./github-classifier.mjs";
import { isTransientExec } from "./transient-github.mjs";
import { when } from "./when.mjs";

/** What a run returns when it did nothing (another run held its lock): it neither fails nor ends a streak of skips. */
export const NO_RUN = Symbol("no run");

const STREAK_DIR = path.join(os.homedir(), ".rivet-agents", "readers");

/**
 * When the spent REST budget comes back, in epoch ms, from the headers of a refused call: a refused call costs nothing.
 * Null when GitHub answered (the budget is back), sent no reset, or no repo is set.
 * @param {{ exec?: (file: string, args: string[], opts: { timeout: number }) => Promise<unknown>, ghBin?: string }} [deps]
 */
export async function restReset({ exec = makeExec(), ghBin = resolveBin("gh") } = {}) {
  const repo = defaultRepo();
  if (!repo) return null;
  try {
    await exec(ghBin, ["api", "-i", `repos/${repo}/actions/runs?per_page=1`, "--jq", ".total_count"], { timeout: 30_000 });
    return null;
  } catch (err) {
    const reset = /^x-ratelimit-reset:[ \t]*(\d{9,11})\s*$/im.exec(String(/** @type {any} */ (err)?.stdout ?? ""))?.[1];
    return reset ? Number(reset) * 1000 : null;
  }
}

/** "5:56pm", "Fri 5:56pm": when.mjs's time. @param {number} ms @param {number} [now] */
export function resetWords(ms, now = Date.now()) {
  return when(ms, now);
}

/**
 * Runs `run` and resolves the exit code: its own (0 when it returns none or NO_RUN), 0 for a run GitHub turned away, else 1.
 * @param {string} job the log prefix and streak file name
 * @param {() => Promise<number | void | typeof NO_RUN>} run
 * @param {{ now?: () => number, streakFile?: string, reset?: () => Promise<number | null>, print?: (line: string) => void,
 *   fail?: (err: unknown) => void }} [deps]
 * @returns {Promise<number>}
 */
export async function scheduledRun(job, run, deps = {}) {
  const print = deps.print ?? ((line) => console.log(line));
  const fail = deps.fail ?? ((err) => print(formatLog(`${job}-failed`, { error: err instanceof Error ? err.message.slice(0, 200) : "error" })));
  const streak = deps.streakFile ?? path.join(STREAK_DIR, `${job}-github-streak.json`);
  let code;
  try {
    code = await run();
    if (code === NO_RUN) return 0;
  } catch (err) {
    if (!isTransientExec(err)) {
      fail(err);
      return 1;
    }
    // A child's output can hold anything, a credential included: only its status code is logged, never its text.
    // ExecError keeps only the first line of it.
    const text = err instanceof ExecError ? err.stderrFirstLine : whyOf(err);
    const status = /\bHTTP (\d{3})\b/.exec(text)?.[1];
    const why = status ? `HTTP ${status}` : "no answer";
    let words = "GitHub unavailable";
    if (/rate limit/i.test(text)) {
      const reset = await (deps.reset ?? (() => restReset()))().catch(() => null);
      words = reset ? `rate-limited, resets at ${resetWords(reset, (deps.now ?? Date.now)())}` : "rate-limited, reset time unknown";
    }
    /** @type {{ skip: boolean, minutes: number }} */
    let t;
    try {
      t = transientStreak(streak, (deps.now ?? Date.now)());
    } catch (saveErr) {
      print(formatLog(`${job}-failed`, { error: `${words}; streak not saved: ${String(/** @type {any} */ (saveErr)?.message ?? saveErr).slice(0, 120)}` }));
      return 1;
    }
    if (!t.skip) {
      print(formatLog(`${job}-failed`, { error: `${words} for ${t.minutes} min`, reason: why }));
      return 1;
    }
    print(`${formatLog(`${job}-skipped`, { reason: why })} ${words}`);
    return 0;
  }
  try {
    endTransientStreak(streak);
  } catch {
    // A streak that cannot be removed only shortens the next run of skips.
  }
  return code ?? 0;
}
