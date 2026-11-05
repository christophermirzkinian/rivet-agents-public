import { existsSync } from "node:fs";
import path from "node:path";

import { repoAllowlist } from "../../../src/shared/repos.ts";
import { LAUNCHCTL_BIN } from "../ops/mac.mjs";
import { AGENTS_DIR, createCollector, LABEL_RE, launchdState, LOCKED_LABELS, sharedCollector, WORKFLOW_FILE_RE } from "./index.mjs";

// Turns one schedule on or off: the only writer in this folder. It acts on a job only
// as a fresh read finds it, never on what the app sent, and only through these fixed,
// reversible commands. Nothing here deletes a job:
//   launchd: launchctl disable + bootout (off), enable + bootstrap of the same plist (on)
//   GitHub:  gh workflow disable | enable <file> (timer-only workflows; see index.mjs)

const TIMEOUT_MS = 30_000;
export const SCHEDULE_ID_RE = /^(mac:dev\.rivet-agents\.[a-z0-9][a-z0-9.-]{0,80}|github:[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}\.ya?ml)$/;

/** @typedef {import("./index.mjs").Schedule} Schedule */
/** @typedef {{ status: "succeeded" | "refused" | "failed", reason: string }} ToggleResult */

/**
 * @param {{ exec: import("../config.mjs").Exec, ghBin: string,
 *   agentsDir?: string, uid?: number, collector?: ReturnType<typeof createCollector> | null,
 *   log?: (event: string, fields?: Record<string, unknown>) => void }} deps
 * @param {string} id
 * @param {boolean} on
 * @returns {Promise<ToggleResult>}
 */
export async function toggleSchedule(deps, id, on) {
  if (!SCHEDULE_ID_RE.test(id)) return { status: "refused", reason: "That is not a schedule the Mac knows." };
  const source = /** @type {import("./index.mjs").Source} */ (id.slice(0, id.indexOf(":")));
  const collector = deps.collector ?? sharedCollector() ?? createCollector(deps);
  const word = on ? "on" : "off";
  // A fresh read of that source: the job as it is now, not as the phone last saw it.
  const fresh = await collector.collect({ only: source });
  // A failed read keeps the last list; acting on that could undo a change made since (a PR trigger added).
  if (fresh.sources.find((state) => state.source === source)?.ok !== true) {
    return { status: "refused", reason: "The Mac couldn't read it just now, so nothing was changed. Try again in a minute." };
  }
  const item = collector.find(id);
  if (!item) return { status: "refused", reason: "That schedule is no longer there." };
  if (!item.toggle.can) return { status: "refused", reason: item.toggle.why };
  if (item.on === on) return { status: "succeeded", reason: `It was already ${word}.` };
  let stillRunning = false;
  try {
    if (source === "mac") stillRunning = await launchd(deps, id.slice(4), on);
    else await workflow(deps, id.slice(7), on);
  } catch (err) {
    deps.log?.("schedule-toggle-failed", { id, on, error: String(/** @type {any} */ (err)?.message ?? "error").slice(0, 200) });
    // A half-done change is still checked below: the read says where it ended up.
  }
  const read = await collector.collect({ only: source });
  if (read.sources.find((state) => state.source === source)?.ok === false) {
    return { status: "failed", reason: `The Mac couldn't read it back to check it turned ${word}. Look again in a minute.` };
  }
  const after = collector.find(id);
  if (after?.on === on && stillRunning) return { status: "failed", reason: "Turned off for the future, but the Mac couldn't stop, or check it stopped, the run that's going now." };
  if (after?.on === on) return { status: "succeeded", reason: `Turned ${word}.` };
  return { status: "failed", reason: `It did not turn ${word}; it is ${after ? (after.on ? "on" : "off") : "gone"} now.` };
}

/** @param {Parameters<typeof toggleSchedule>[0]} deps @param {string} label @param {boolean} on */
async function launchd(deps, label, on) {
  if (!LABEL_RE.test(label) || LOCKED_LABELS.has(label)) throw new Error("bad label");
  const uid = deps.uid ?? process.getuid?.() ?? 501;
  const target = `gui/${uid}/${label}`;
  const plist = path.join(deps.agentsDir ?? AGENTS_DIR, `${label}.plist`);
  if (!existsSync(plist)) throw new Error("no plist");
  const run = (/** @type {string[]} */ args) => deps.exec(LAUNCHCTL_BIN, args, { timeout: TIMEOUT_MS });
  if (on) {
    await run(["enable", target]);
    // Already loaded is fine: the read afterwards decides.
    await run(["bootstrap", `gui/${uid}`, plist]).catch(() => {});
  } else {
    // Disabled first, so launchd will not load it again at the next login.
    await run(["disable", target]);
    // Not loaded is fine; a stop that left it running is said, not swallowed.
    const stopped = await run(["bootout", target]).then(
      () => true,
      () => false,
    );
    // A failed check counts as still running: the stop is only reported done when seen done.
    if (!stopped) return (await launchdState(deps.exec, uid, label).catch(() => ({ pid: -1 })))?.pid != null;
  }
  return false;
}

/** @param {Parameters<typeof toggleSchedule>[0]} deps @param {string} rest owner/repo/file */
async function workflow(deps, rest, on) {
  const file = rest.slice(rest.lastIndexOf("/") + 1);
  const repo = rest.slice(0, rest.lastIndexOf("/"));
  if (!repoAllowlist().includes(repo) || !WORKFLOW_FILE_RE.test(file)) throw new Error("bad workflow");
  await deps.exec(deps.ghBin, ["workflow", on ? "enable" : "disable", file, "--repo", repo], { timeout: TIMEOUT_MS });
}
