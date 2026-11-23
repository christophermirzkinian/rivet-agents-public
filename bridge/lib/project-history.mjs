// A project's History: one commit for each finished step, and Undo to here, which restores an older point as a new
// commit so nothing is ever lost.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { refreshBundle } from "./project-backups.mjs";
import { commitArgs, execRun, hasCommit } from "./repo-home.mjs";

/** @typedef {import("./repo-home.mjs").Run} Run */
/** @typedef {{ run?: Run, backups?: string, log?: (line: string) => void }} StepOpts `backups`: the bundle folder (refreshBundle's default when unset) */

/**
 * Every change in `dir` committed with `message` (its first line), then the project's backup bundle refreshed; null
 * when nothing changed.
 * @param {string} dir @param {string} message @param {StepOpts} [opts]
 * @returns {string | null} the new commit's sha
 */
export function commitStep(dir, message, { run = execRun, backups, log } = {}) {
  const line = String(message ?? "").trim().split("\n")[0].trim();
  if (!line) throw new Error("a step commit needs a message");
  run("git", ["add", "-A"], { cwd: dir });
  if (!run("git", ["status", "--porcelain"], { cwd: dir }).trim()) return null;
  run("git", [...commitArgs(dir, run), "-q", "-m", line], { cwd: dir });
  const sha = run("git", ["rev-parse", "HEAD"], { cwd: dir }).trim();
  refreshBundle(dir, { dest: backups, run, log });
  return sha;
}

/**
 * The project's commits, newest first.
 * @param {string} dir @param {{ run?: Run }} [opts]
 * @returns {{ sha: string, message: string, time: string }[]}
 */
export function history(dir, { run = execRun } = {}) {
  if (!hasCommit(dir, run)) return [];
  return run("git", ["log", "--format=%H%x1f%cI%x1f%s"], { cwd: dir })
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, time, message] = line.split("\x1f");
      return { sha, message, time };
    });
}

/**
 * The files of `dir` as they were at `sha`, as a new commit on top. Changes not yet committed are committed first
 * ("Saved before undo"), so Undo to here can itself be undone. A file no commit holds (untracked or ignored) at a path
 * the old point has (in any case, where git ignores case) is never overwritten, and an ignored file is never left
 * where the old point would not ignore it: the undo is refused, naming them, and nothing changes.
 * @param {string} dir @param {string} sha @param {StepOpts} [opts]
 * @returns {{ saved: string | null, sha: string | null }} the save and undo commits; null for one not needed
 */
export function undoTo(dir, sha, { run = execRun, backups, log } = {}) {
  let target;
  try {
    target = run("git", ["rev-parse", "-q", "--verify", `${sha}^{commit}`], { cwd: dir }).trim();
    run("git", ["merge-base", "--is-ancestor", target, "HEAD"], { cwd: dir });
  } catch {
    throw new Error(`${sha} is not in this project's history`);
  }
  const subject = run("git", ["log", "-1", "--format=%s", target], { cwd: dir }).trim();
  const clashes = untrackedIn(dir, target, run);
  if (clashes.length) throw new Error(`Undo to "${subject}" would overwrite ${clashes.join(", ")}, which no commit holds; move them out first`);
  const exposed = unignoredBy(dir, target, run);
  if (exposed.length) {
    const more = exposed.length > 3 ? ` and ${exposed.length - 3} more` : "";
    throw new Error(`Undo to "${subject}" would stop ignoring ${exposed.slice(0, 3).join(", ")}${more}, so the next step would commit them; move them out first`);
  }
  const saved = commitStep(dir, "Saved before undo", { run, backups, log });
  run("git", ["read-tree", "-u", "--reset", target], { cwd: dir });
  // The index as read-tree left it, never `add -A`: files the old point does not ignore stay out of the commit.
  if (run("git", ["write-tree"], { cwd: dir }).trim() === run("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir }).trim()) return { saved, sha: null };
  run("git", [...commitArgs(dir, run), "-q", "-m", `Undo to "${subject}"`], { cwd: dir });
  const undone = run("git", ["rev-parse", "HEAD"], { cwd: dir }).trim();
  refreshBundle(dir, { dest: backups, run, log });
  return { saved, sha: undone };
}

/**
 * The untracked and ignored paths in `dir` that `target`'s tree would write over: the same path, a folder of it, or a
 * file where it has a folder. A wholly untracked folder is one path, ending in "/".
 * @param {string} dir @param {string} target @param {Run} run
 */
function untrackedIn(dir, target, run) {
  const fold = ignoresCase(dir, run) ? (/** @type {string} */ p) => p.toLowerCase() : (/** @type {string} */ p) => p;
  const files = new Set(treeFiles(dir, target, run).map(fold));
  const folders = new Set([...files].flatMap((file) => file.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))));
  return run("git", ["ls-files", "--others", "--directory", "-z"], { cwd: dir })
    .split("\0")
    .filter(Boolean)
    .filter((p) => {
      const bare = fold(p.replace(/\/$/, ""));
      const parents = bare.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"));
      return files.has(bare) || folders.has(bare) || parents.some((parent) => files.has(parent));
    });
}

/**
 * The paths in `dir` ignored now that `target`'s ignore rules would leave untracked and not ignored, checked against
 * its .gitignore files alone in a scratch work tree (the repo's own excludes still apply). An ignored folder is one
 * path, ending in "/".
 * @param {string} dir @param {string} target @param {Run} run
 */
function unignoredBy(dir, target, run) {
  const ignored = run("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], { cwd: dir }).split("\0").filter(Boolean);
  if (!ignored.length) return [];
  const gitDir = run("git", ["rev-parse", "--absolute-git-dir"], { cwd: dir }).trim();
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "undo-ignores-")));
  try {
    for (const file of treeFiles(dir, target, run).filter((f) => path.posix.basename(f) === ".gitignore")) {
      fs.mkdirSync(path.join(scratch, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(scratch, file), run("git", ["cat-file", "blob", `${target}:${file}`], { cwd: dir }));
    }
    for (const p of ignored) {
      if (p.endsWith("/")) fs.mkdirSync(path.join(scratch, p), { recursive: true });
      else if (!fs.existsSync(path.join(scratch, p))) {
        fs.mkdirSync(path.join(scratch, path.dirname(p)), { recursive: true });
        fs.writeFileSync(path.join(scratch, p), "");
      }
    }
    const still = new Set(
      run("git", ["--git-dir", gitDir, "--work-tree", scratch, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], { cwd: scratch })
        .split("\0")
        .filter(Boolean),
    );
    return ignored.filter((p) => !p.split("/").some((_, i, parts) => still.has(parts.slice(0, i + 1).join("/")) || still.has(`${parts.slice(0, i + 1).join("/")}/`)));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** @param {string} dir @param {string} target @param {Run} run */
const treeFiles = (dir, target, run) => run("git", ["ls-tree", "-r", "-z", "--name-only", target], { cwd: dir }).split("\0").filter(Boolean);

/** Whether git treats paths in `dir` as one whatever their case (core.ignorecase, true on macOS volumes). @param {string} dir @param {Run} run */
function ignoresCase(dir, run) {
  try {
    return run("git", ["config", "--bool", "core.ignorecase"], { cwd: dir }).trim() === "true";
  } catch {
    return false;
  }
}
