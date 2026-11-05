import { defaultRepo } from "../../../src/shared/repos.ts";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA = /^[0-9a-f]{7,40}$/;
export const MAX_ANCESTRY_CACHE = 10_000;
const PASS_BUDGET_MS = 10_000;

/**
 * Fetch main into the bridge's own history clone (RIVET_HISTORY_REPO, never a working checkout), hooks off and bounded,
 * so merges and releases after the last bridge install reach it.
 * @param {(file: string, args: string[], opts: { timeout: number }) => Promise<unknown>} exec @param {unknown} repo
 */
export async function refreshHistory(exec, repo) {
  if (typeof repo !== "string" || !repo.startsWith("/")) return;
  await exec("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-C", repo, "fetch", "-q", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"], { timeout: 60_000 });
}

/** Immutable full-SHA pairs only. Unknown evidence is retried next pass. */
export function ancestryCache() { return new Map(); }

/**
 * Annotate each Fly app's releases with proven newly shipped merge commits. The oldest
 * successful release is a baseline, never a patch note. Any unknown earlier
 * release blocks credit: absence cannot be inferred from dates or partial history.
 * No fetch, checkout, or other git mutation; a shallow clone cannot prove absence.
 */
export async function provePatchMerges(snapshot, merged, { exec, repo, cache = ancestryCache() }) {
  // Never reuse proof calculated against an older merged-list snapshot.
  for (const app of snapshot.apps) for (const release of app.releases) delete release.patchMerges;
  if (typeof repo !== "string" || !repo.startsWith("/")) return;
  const deadline = Date.now() + PASS_BUDGET_MS;
  const git = async (args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("ancestry budget exhausted");
    return exec("/usr/bin/git", ["--no-replace-objects", "-C", repo, ...args], { timeout: Math.min(1500, remaining), maxBuffer: 1024 * 1024 });
  };
  try {
    if ((await git(["rev-parse", "--is-shallow-repository"])).stdout.trim() !== "false") return;
  } catch { return; }
  const resolved = new Map();
  const resolve = async (sha) => {
    if (typeof sha !== "string" || !SHA.test(sha)) return null;
    if (resolved.has(sha)) return resolved.get(sha);
    let full = null;
    try {
      const result = (await git(["rev-parse", "--verify", `${sha}^{commit}`])).stdout.trim();
      if (FULL_SHA.test(result)) full = result;
    } catch { /* Missing/ambiguous objects are unknown, not absent. */ }
    resolved.set(sha, full);
    return full;
  };
  const contains = async (merge, release) => {
    const a = await resolve(merge);
    const b = await resolve(release);
    if (!a || !b) return null;
    const key = `${a}:${b}`;
    if (cache.has(key)) return cache.get(key);
    let result;
    try {
      await git(["merge-base", "--is-ancestor", a, b]);
      result = true;
    } catch (err) {
      // Exit 1 means not an ancestor; missing objects/timeouts have other codes.
      if (err?.code !== 1) return null;
      result = false;
    }
    cache.set(key, result);
    while (cache.size > MAX_ANCESTRY_CACHE) cache.delete(cache.keys().next().value);
    return result;
  };
  const repoName = defaultRepo();
  for (const app of snapshot.apps) {
    const releases = app.releases.filter((r) => r.status === "complete").sort((a, b) => a.version - b.version);
    // A rollback may make the baseline omit a PR shipped before the retained window.
    // Only merges after that baseline can be proved first shipped here. Dates bound
    // history eligibility; they never establish whether an image contains a merge.
    const baselineAt = typeof releases[0]?.at === "string" ? Date.parse(releases[0].at) : NaN;
    if (!Number.isFinite(baselineAt)) continue;
    for (const pr of merged.slice(0, 600)) {
      const mergedAt = typeof pr.mergedAt === "string" ? Date.parse(pr.mergedAt) : NaN;
      if (!Number.isFinite(mergedAt) || mergedAt <= baselineAt) continue;
      if (pr.repo !== repoName || !FULL_SHA.test(pr.mergeSha ?? "")) continue;
      for (let i = 0; i < releases.length; i++) {
        const release = releases[i];
        const included = await contains(pr.mergeSha, release.sha);
        if (included === null) break;
        if (!included) continue;
        if (i > 0) (release.patchMerges ??= []).push(pr.mergeSha);
        // Baseline matches and rollbacks/redeploys must never receive a second credit.
        break;
      }
    }
  }
}
