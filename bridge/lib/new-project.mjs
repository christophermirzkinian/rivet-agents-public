// A new project for work that has no repo: `<root>/<folder>` as its own git repo with a README, a short CLAUDE.md and
// a first commit, then registered through the caller's `register`. The owner's root is ~/code, Cloud's
// /srv/projects (lowercase folders), Public's its projects root.
import fs from "node:fs";
import path from "node:path";

import { bundleFile, refreshBundle } from "./project-backups.mjs";
import { cleanName, projectFolder, uniqueProjectName } from "./project-name.mjs";
import { ensureRepoHome, execRun, hasCommit } from "./repo-home.mjs";

/** @typedef {import("./repo-home.mjs").Run} Run */
/** @typedef {(dir: string) => boolean} Register adds a folder to the repo list, answering whether it was added now */

/** @param {string} name */
const readme = (name) => `# ${name}\n\nA new project. Its history is kept as commits, one for each finished step.\n`;

/** @param {string} name */
const claudeMd = (name) =>
  `# ${name}\n\n` +
  "This project is its own git repo, and its owner never sees git.\n\n" +
  "- Commit after each finished step, with a plain-words message (\"Added the booking form\"): the commits are the project's History.\n" +
  "- Never rewrite history. Undo to here restores an older point as a new commit.\n";

/** @param {string} entry */
const ownFile = (entry) => entry === "README.md" || entry === "CLAUDE.md";

/**
 * Whether `dir` is missing or one a createProject for `name` started: nothing but its README.md or CLAUDE.md, in no
 * repo or in one with no commit, no remote and nothing else staged; or a repo with no remote whose first commit is
 * `Start <name>`.
 * @param {string} dir @param {string} name @param {Run} run
 */
function startedHere(dir, name, run) {
  if (!fs.existsSync(dir)) return true;
  if (!fs.existsSync(path.join(dir, ".git"))) return fs.readdirSync(dir).every(ownFile);
  if (run("git", ["remote"], { cwd: dir }).trim()) return false;
  if (!hasCommit(dir, run)) {
    const staged = run("git", ["ls-files", "-z"], { cwd: dir }).split("\0").filter(Boolean);
    return staged.every(ownFile) && fs.readdirSync(dir).every((entry) => entry === ".git" || ownFile(entry));
  }
  const [first] = run("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: dir }).trim().split("\n");
  return run("git", ["log", "-1", "--format=%B", first], { cwd: dir }).trim() === `Start ${name}`;
}

/**
 * The project `name` names (cleaned to plain words, so it never names a path), made or finished: a second call
 * completes a project a first call left half made, and any other folder of its name throws. Its backup bundle is made
 * in `backups` (refreshBundle's default when unset).
 * @param {{ name: string, root: string, lowercase?: boolean, register?: Register, run?: Run, backups?: string, log?: (line: string) => void }} opts
 * @returns {{ dir: string, name: string, folder: string, created: boolean, registered: boolean }}
 */
export function createProject({ name: raw, root, lowercase = false, register, run = execRun, backups, log }) {
  const name = cleanName(raw);
  const folder = name && projectFolder(name, { lowercase });
  if (!name || !folder) throw new Error(`"${raw}" has no letter or digit to name a project by`);
  if (!startedHere(path.join(root, folder), name, run)) throw new Error(`a folder called ${folder} already exists and isn't a new project`);
  const home = ensureRepoHome({ root, folder, files: { "README.md": readme(name), "CLAUDE.md": claudeMd(name) }, message: `Start ${name}`, register, run });
  refreshBundle(home.dir, { dest: backups, run, log });
  return { ...home, name, folder };
}

/**
 * The project at `dir` under a new name: its folder moves (in the same root), the old path is unregistered and the new
 * one registered, and its backup bundle takes the new name. The name gets " 2" and so on while another project or
 * folder has it.
 * @param {{ dir: string, name: string, projects?: import("./projects.mjs").Project[], lowercase?: boolean, register?: Register, unregister?: (dir: string) => void, run?: Run, backups?: string, log?: (line: string) => void }} opts
 * @returns {{ dir: string, name: string, folder: string, registered: boolean }}
 */
export function renameProject({ dir, name, projects = [], lowercase = false, register = () => false, unregister = () => {}, run = execRun, backups, log }) {
  const root = path.dirname(dir);
  const others = projects.filter((p) => !p.folder || path.resolve(p.folder) !== path.resolve(dir));
  const newName = uniqueProjectName(name, { projects: others, root, except: path.basename(dir) });
  const folder = projectFolder(newName, { lowercase });
  const next = path.join(root, folder);
  if (next !== dir) {
    fs.renameSync(dir, next);
    unregister(dir);
    const bundle = refreshBundle(next, { dest: backups, run, log });
    const old = bundleFile(dir, backups);
    if (bundle && bundle !== old) fs.rmSync(old, { force: true });
  }
  return { dir: next, name: newName, folder, registered: register(next) };
}
