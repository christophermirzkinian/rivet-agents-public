// Backups of projects, GitHub or not: one `git bundle --all` per project, `<dest>/<slug>.bundle`, readable by its owner
// alone. A step commit refreshes its project's bundle where the project can be read (refreshBundle); bundleProjects
// remakes many on demand. Cloud has its volume snapshots instead.
import fs from "node:fs";
import path from "node:path";

import { slug } from "./projects.mjs";
import { execRun, hasCommit } from "./repo-home.mjs";

/** @typedef {import("./repo-home.mjs").Run} Run */

/** Where a projects root's bundles go unless the caller names a folder; a dot folder, so it is never listed as a project. @param {string} root */
export const defaultBundleDir = (root) => path.join(root, ".backups");

/** `dir`'s bundle file in `dest`. @param {string} dir @param {string} [dest] */
export const bundleFile = (dir, dest = defaultBundleDir(path.dirname(dir))) => path.join(dest, `${slug(path.basename(dir))}.bundle`);

/**
 * Writes `dir`'s bundle beside its target and renames it over it, so a failed bundle leaves the last good one in place.
 * @param {string} dir @param {string} dest @param {Run} run
 */
function writeBundle(dir, dest, run) {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  fs.chmodSync(dest, 0o700);
  const bundle = bundleFile(dir, dest);
  const part = `${bundle}.part`;
  run("git", ["bundle", "create", "-q", part, "--all"], { cwd: dir });
  fs.chmodSync(part, 0o600);
  fs.renameSync(part, bundle);
  return bundle;
}

/**
 * The bundle of each project dir with commits. One project failing never stops the rest.
 * @param {{ projects: string[], dest: string, run?: Run }} opts
 * @returns {{ dir: string, bundle?: string, skipped?: string, error?: string }[]}
 */
export function bundleProjects({ projects, dest, run = execRun }) {
  return projects.map((dir) => {
    try {
      if (!hasCommit(dir, run)) return { dir, skipped: "no commits yet" };
      return { dir, bundle: writeBundle(dir, dest, run) };
    } catch (err) {
      return { dir, error: /** @type {Error} */ (err).message.split("\n")[0] };
    }
  });
}

/**
 * `dir`'s bundle remade after a commit; null when the project has no commit or the bundle failed, which is logged and
 * never thrown.
 * @param {string} dir @param {{ dest?: string, run?: Run, log?: (line: string) => void }} [opts]
 * @returns {string | null} the bundle
 */
export function refreshBundle(dir, { dest = defaultBundleDir(path.dirname(dir)), run = execRun, log = console.warn } = {}) {
  try {
    if (!hasCommit(dir, run)) return null;
    return writeBundle(dir, dest, run);
  } catch (err) {
    log(`${path.basename(dir)}: its backup bundle was not refreshed (${/** @type {Error} */ (err).message.split("\n")[0]})`);
    return null;
  }
}
