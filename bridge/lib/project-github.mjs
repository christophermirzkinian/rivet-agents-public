// Link GitHub: a project made with no repo gets a private GitHub repo of the same name holding all its history.
// Unlink drops the GitHub remote and keeps every local commit.
import path from "node:path";

import { remoteRepo } from "./folder-repo.mjs";
import { execRun } from "./repo-home.mjs";

/** @typedef {import("./repo-home.mjs").Run} Run */

/**
 * `dir`'s GitHub remotes, each as its remote name and owner/name.
 * @param {string} dir @param {Run} [run]
 * @returns {{ remote: string, repo: string }[]}
 */
export function githubRemotes(dir, run = execRun) {
  /** @type {Map<string, string>} */
  const found = new Map();
  for (const line of run("git", ["remote", "-v"], { cwd: dir }).split("\n")) {
    const [remote, url] = line.split(/\s+/);
    const repo = url ? remoteRepo(url) : undefined;
    if (remote && repo) found.set(remote, repo);
  }
  return [...found].map(([remote, repo]) => ({ remote, repo }));
}

/**
 * A private GitHub repo named `name` (the folder's name by default) made from `dir` and pushed, through `gh`. A
 * project already on GitHub is pushed to it. A push that fails throws, so a link is never reported done without one.
 * @param {string} dir @param {{ gh?: string, name?: string, run?: Run }} [opts]
 * @returns {{ repo: string, created: boolean, pushed: true }}
 */
export function linkGitHub(dir, { gh = "gh", name = path.basename(dir), run = execRun } = {}) {
  const [linked] = githubRemotes(dir, run);
  if (linked) {
    run("git", ["push", "-u", linked.remote, "HEAD"], { cwd: dir });
    return { repo: linked.repo, created: false, pushed: true };
  }
  run(gh, ["repo", "create", name, "--private", "--source", dir, "--push"], { cwd: dir });
  const [made] = githubRemotes(dir, run);
  if (!made) throw new Error(`gh repo create left ${dir} with no GitHub remote`);
  return { repo: made.repo, created: true, pushed: true };
}

/**
 * `dir`'s GitHub remotes removed; its commits and the GitHub repo itself are untouched.
 * @param {string} dir @param {{ run?: Run }} [opts]
 * @returns {string[]} the remotes removed
 */
export function unlinkGitHub(dir, { run = execRun } = {}) {
  const remotes = githubRemotes(dir, run).map(({ remote }) => remote);
  for (const remote of remotes) run("git", ["remote", "remove", remote], { cwd: dir });
  return remotes;
}
