import { repoAllowlist } from "../../../src/shared/repos.ts";
import { readMergeHolds } from "../merge-holds.mjs";
import { redactKeepingLines, shapeText } from "../redact-cut.mjs";

// The optional merge from a card, off unless RIVET_MERGE=on and only for a repo in RIVET_REPOS. One pass: every read
// comes first and any read that fails refuses, then one plain merge command that GitHub itself judges. The merge goes
// through `gh pr merge` alone, with no admin flag and no REST call, so a ruleset or branch protection always has the
// last word, and a refusal from GitHub is the answer: nothing tries again. Nothing deploys.

const GH_TIMEOUT_MS = 30_000;
const MERGE_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_NAMED = 5;
const MAX_REASON = 200;

/** GitHub's merge states with nothing blocking: UNSTABLE is a red check that is not a required one. */
const MERGE_STATES = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

/**
 * @typedef {{ exec: import("../config.mjs").Exec, ghBin: string }} MergeDeps
 * @typedef {{ repo: string, pr: number, headSha: string }} MergeAsk
 * @typedef {{ status: "merged" | "refused" | "failed", detail: Record<string, unknown> }} MergeAnswer
 */

/** @param {string} reason @returns {MergeAnswer} */
const refused = (reason) => ({ status: "refused", detail: { reason } });

/** @param {any} doc @returns {MergeAnswer} */
const mergedAnswer = (doc) => ({ status: "merged", detail: typeof doc.url === "string" ? { url: doc.url } : {} });

/** @param {unknown} err */
const firstLine = (err) => shapeText(String(/** @type {any} */ (err)?.stderrFirstLine || /** @type {any} */ (err)?.message || "error"), MAX_REASON);

/** The PR as `gh pr view` gives it. @param {MergeDeps} deps @param {MergeAsk} v */
async function prState(deps, v) {
  const { stdout } = await deps.exec(deps.ghBin, ["pr", "view", String(v.pr), "--repo", v.repo, "--json", "number,state,isDraft,mergeable,mergeStateStatus,headRefOid,url"],
    { timeout: GH_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
  const doc = JSON.parse(stdout);
  if (doc?.number !== v.pr) throw new Error("gh pr view returned an unexpected shape");
  return doc;
}

/**
 * Why the PR's required checks do not allow a merge, or null when there is at least one and each passed. `gh pr checks`
 * exits non-zero for a red or pending check with the list still on stdout. A branch with no required checks has nothing
 * that proves it green, so it refuses too. A skipped check is not a green one.
 * @param {MergeDeps} deps @param {MergeAsk} v
 * @returns {Promise<string | null>}
 */
export async function requiredChecksProblem(deps, v) {
  let stdout = "";
  /** @type {unknown} */
  let failure = null;
  try {
    ({ stdout } = await deps.exec(deps.ghBin, ["pr", "checks", String(v.pr), "--repo", v.repo, "--required", "--json", "name,bucket"], { timeout: GH_TIMEOUT_MS, maxBuffer: MAX_BUFFER }));
  } catch (err) {
    failure = err;
    stdout = String(/** @type {any} */ (err)?.stdout ?? "");
  }
  if (failure !== null && /no required checks/i.test(firstLine(failure))) return "this branch has no required checks, so nothing shows the PR is green";
  let rows;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return `the required checks could not be read: ${firstLine(failure)}`;
  }
  if (!Array.isArray(rows)) return "the required checks could not be read";
  if (rows.length === 0) return "this branch has no required checks, so nothing shows the PR is green";
  const notGreen = rows.filter((row) => row?.bucket !== "pass");
  if (notGreen.length === 0 && failure === null) return null;
  if (notGreen.length === 0) return `the required checks could not be read: ${firstLine(failure)}`;
  const names = notGreen.slice(0, MAX_NAMED).map((row) => `${shapeText(String(row?.name ?? "unnamed"), 60)} (${shapeText(String(row?.bucket ?? "unknown"), 20)})`);
  return `required checks are not all green: ${names.join(", ")}`;
}

/**
 * Why the PR as GitHub shows it cannot merge, or null.
 * @param {any} doc @param {MergeAsk} v
 * @returns {string | null}
 */
export function prProblem(doc, v) {
  if (doc.state !== "OPEN") return `PR ${v.pr} is not open (${shapeText(String(doc.state), 20)})`;
  if (doc.isDraft !== false) return `PR ${v.pr} is a draft`;
  if (doc.headRefOid !== v.headSha) return "the head changed since you looked";
  if (doc.mergeable !== "MERGEABLE") return `PR ${v.pr} is not mergeable (${shapeText(String(doc.mergeable), 20)})`;
  if (!MERGE_STATES.has(doc.mergeStateStatus)) return `GitHub would not merge PR ${v.pr} as it stands (${shapeText(String(doc.mergeStateStatus), 20)})`;
  return null;
}

/**
 * Runs the merge once, or says why not.
 * @param {MergeDeps & { env?: NodeJS.ProcessEnv, holdsFile?: string, now?: number, tried?: boolean, beforeMerge?: () => void }} deps
 *   tried: an earlier run reached the merge command, so this one only reports what happened
 * @param {MergeAsk} v
 * @returns {Promise<MergeAnswer>}
 */
export async function runMerge(deps, v) {
  const env = deps.env ?? process.env;
  if (env.RIVET_MERGE !== "on") return refused("merging from a card is off (RIVET_MERGE)");
  if (!repoAllowlist(env).includes(v.repo)) return refused(`${v.repo} is not in RIVET_REPOS`);
  let doc;
  try {
    doc = await prState(deps, v);
  } catch (err) {
    return refused(`the PR could not be read: ${firstLine(err)}`);
  }
  if (deps.tried) {
    if (doc.state === "MERGED" && doc.headRefOid === v.headSha) return mergedAnswer(doc);
    return { status: "failed", detail: { reason: "the Mac restarted during this merge; check the PR before trying again" } };
  }
  const problem = prProblem(doc, v);
  if (problem) return refused(problem);
  const checks = await requiredChecksProblem(deps, v);
  if (checks) return refused(checks);
  let held;
  try {
    held = await readMergeHolds({ repo: v.repo, pr: v.pr, holdsFile: deps.holdsFile, now: deps.now, shown: redactKeepingLines,
      gh: async (args) => (await deps.exec(deps.ghBin, args, { timeout: GH_TIMEOUT_MS, maxBuffer: MAX_BUFFER })).stdout });
  } catch (err) {
    return refused(`the holds could not be read: ${firstLine(err)}`);
  }
  if (held.view.head?.sha !== v.headSha) return refused("the head changed since you looked");
  const holds = [...held.holds, ...held.closing];
  if (holds.length) return refused(`PR ${v.pr} is on hold: ${holds.map((hold) => shapeText(hold, MAX_REASON)).join("; ")}`);
  deps.beforeMerge?.();
  try {
    await deps.exec(deps.ghBin, ["pr", "merge", String(v.pr), "--repo", v.repo, "--squash", "--match-head-commit", v.headSha,
      ...(held.squashTitle ? ["--subject", held.squashTitle] : [])], { timeout: MERGE_TIMEOUT_MS });
  } catch (err) {
    // A command that timed out may still have merged, so what GitHub shows decides the answer.
    const after = await prState(deps, v).catch(() => null);
    return after?.state === "MERGED" ? mergedAnswer(after) : refused(`GitHub refused the merge: ${firstLine(err)}`);
  }
  const after = await prState(deps, v).catch(() => null);
  if (after?.state !== "MERGED") return { status: "failed", detail: { reason: "GitHub took the merge but does not show it merged yet; check the PR" } };
  return mergedAnswer(after);
}
