// A home for work as its own small git repo: a folder, its first files and a first commit, then registered with the
// app that lists repos (the caller's `register`). The General home and every new project are made this way.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** @typedef {(cmd: string, args: string[], opts?: { cwd?: string }) => string} Run */

/** @type {Run} */
export const execRun = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** @param {string} dir @param {Run} run */
export function hasCommit(dir, run) {
  if (!fs.existsSync(path.join(dir, ".git"))) return false;
  try {
    run("git", ["rev-parse", "-q", "--verify", "HEAD"], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

/** @param {string} dir @param {Run} run */
function hasIdentity(dir, run) {
  try {
    return ["user.email", "user.name"].every((key) => run("git", ["config", key], { cwd: dir }).trim() !== "");
  } catch {
    return false;
  }
}

/** `git commit` with a stand-in identity when the box has none, and never signed. @param {string} dir @param {Run} run */
export const commitArgs = (dir, run) => [...(hasIdentity(dir, run) ? [] : ["-c", "user.name=Rivet", "-c", "user.email=rivet@localhost"]), "-c", "commit.gpgsign=false", "commit"];

/**
 * `<root>/<folder>` as its own git repo holding `files` (name to text) in a first commit, then `register(dir)`, which
 * answers whether it registered the folder now. Each step is skipped when already done, and a file already there is
 * kept as it is.
 * @param {{ root: string, folder: string, files: Record<string, string>, message: string, register?: (dir: string) => boolean, run?: Run }} opts
 * @returns {{ dir: string, created: boolean, registered: boolean }}
 */
export function ensureRepoHome({ root, folder, files, message, register = () => false, run = execRun }) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  let created = false;
  // A first commit is the test, not a .git folder: a run cut short after `git init` (no git identity on a new box,
  // a signing failure) is finished on the next call rather than registered as an empty repo.
  if (!hasCommit(dir, run)) {
    if (!fs.existsSync(path.join(dir, ".git"))) run("git", ["init", "-q", "-b", "main"], { cwd: dir });
    for (const [name, text] of Object.entries(files)) {
      if (!fs.existsSync(path.join(dir, name))) fs.writeFileSync(path.join(dir, name), text);
    }
    run("git", ["add", ...Object.keys(files)], { cwd: dir });
    run("git", [...commitArgs(dir, run), "-q", "-m", message], { cwd: dir });
    created = true;
  }
  return { dir, created, registered: register(dir) };
}
