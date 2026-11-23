import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createProject, renameProject } from "../lib/new-project.mjs";
import { bundleProjects, defaultBundleDir } from "../lib/project-backups.mjs";
import { linkGitHub, unlinkGitHub } from "../lib/project-github.mjs";
import { commitStep, history, undoTo } from "../lib/project-history.mjs";
import { cleanName, pickProjectName, uniqueProjectName } from "../lib/project-name.mjs";
import { projectsFromFolders } from "../lib/projects.mjs";
import { commitArgs } from "../lib/repo-home.mjs";
import { routeChat } from "../lib/route-chat.mjs";

// The new-project path: naming, create, step commits, History and Undo to here, bundles and Link GitHub.

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@localhost", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@localhost", GIT_CONFIG_NOSYSTEM: "1" };

/** @param {string} dir @param {...string} args */
const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** @param {import("node:test").TestContext} t @param {string} [prefix] */
function tempRoot(t, prefix = "new-project-") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Real git, a fake register that keeps its repo list, and any other command (a fake gh) only recorded. */
function fakes() {
  /** @type {string[][]} */
  const calls = [];
  /** @type {string[]} */
  const registered = [];
  /** @type {import("../lib/repo-home.mjs").Run} */
  const run = (cmd, args, opts = {}) => {
    calls.push([cmd, ...args]);
    if (cmd === "git") return execFileSync("git", args, { cwd: opts.cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return "";
  };
  /** @param {string} dir */
  const register = (dir) => {
    if (registered.includes(dir)) return false;
    registered.push(dir);
    return true;
  };
  return { calls, registered, register, run };
}

/** @param {string} dir @param {Record<string, string>} files */
function write(dir, files) {
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
}

test("a new project's name is 1-3 plain words from the router, or read from the ask", () => {
  const routed = routeChat({ ask: "build me a dog walk booking app" }, { projects: [] });
  assert.ok("newProject" in routed && routed.newProject);
  assert.equal(pickProjectName({ name: routed.newProject.name }), routed.newProject.name);
  assert.equal(pickProjectName({ ask: "make a recipe site for my mum" }), "Recipe site");
  assert.equal(pickProjectName({ name: "  the *dog* walk booking app!! " }), "The dog walk");
  assert.equal(pickProjectName({ name: "", ask: "hello there" }), "New project");
  assert.equal(cleanName("***"), null);
});

test("a name an existing project or folder has gets \" 2\", then \" 3\", and General is never offered", (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, "dog-walk-app"));
  const projects = [{ id: "booking", name: "Dog walk app 2", workspaceRepo: "x", githubRepo: null, folder: null, words: [], paths: [], appOnly: false }];
  assert.equal(uniqueProjectName("Dog walk app", { root }), "Dog walk app 2", "the folder clashes, whatever its case");
  assert.equal(uniqueProjectName("Dog walk app", { projects, root }), "Dog walk app 3", "and so does a project's name");
  assert.equal(uniqueProjectName("Recipes", { projects, root }), "Recipes");
  assert.equal(uniqueProjectName("general"), "General 2");
});

test("createProject makes the repo with a README, a CLAUDE.md and a first commit, and registers it once", (t) => {
  const root = tempRoot(t);
  const { calls, register, registered, run } = fakes();
  const made = createProject({ name: "Dog walk app", root, register, run });
  const dir = path.join(root, "Dog-walk-app");
  assert.deepEqual(made, { dir, name: "Dog walk app", folder: "Dog-walk-app", created: true, registered: true });
  assert.match(fs.readFileSync(path.join(dir, "README.md"), "utf8"), /^# Dog walk app\n/);
  assert.match(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /Never rewrite history/);
  assert.equal(git(dir, "log", "--format=%s").trim(), "Start Dog walk app");
  assert.equal(git(dir, "ls-files").trim(), "CLAUDE.md\nREADME.md");
  assert.deepEqual(registered, [dir]);
  calls.length = 0;
  assert.deepEqual(createProject({ name: "Dog walk app", root, register, run }), { ...made, created: false, registered: false });
  assert.deepEqual(registered, [dir]);
  assert.ok(!calls.some((c) => c.includes("commit")), "a finished project is never committed to again");
  assert.equal(createProject({ name: "../../up/there", root, register, run }).dir, path.join(root, "Up-there"), "a name never names a path");
  assert.throws(() => createProject({ name: "../", root, register, run }), /no letter or digit/);
});

test("a second createProject call completes a project the first left half made", (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, "Recipes");
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  write(dir, { "README.md": "# Recipes\n\nMine.\n" });
  const { register, registered, run } = fakes();
  assert.deepEqual(createProject({ name: "Recipes", root, register, run }), { dir, name: "Recipes", folder: "Recipes", created: true, registered: true });
  assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), "# Recipes\n\nMine.\n", "a file already there is kept");
  assert.equal(git(dir, "ls-files").trim(), "CLAUDE.md\nREADME.md");
  assert.equal(git(dir, "log", "--format=%s").trim(), "Start Recipes");
  assert.deepEqual(registered, [dir]);
});

test("rename moves the folder, keeps its history, registers the new path, and adds \" 2\" on a clash", (t) => {
  const root = tempRoot(t);
  const { register, registered, run } = fakes();
  const { dir } = createProject({ name: "Dog walk app", root, register, run });
  fs.mkdirSync(path.join(root, "Walkies"));
  const renamed = renameProject({ dir, name: "walkies", register });
  const next = path.join(root, "Walkies-2");
  assert.deepEqual(renamed, { dir: next, name: "Walkies 2", folder: "Walkies-2", registered: true });
  assert.ok(!fs.existsSync(dir));
  assert.equal(git(next, "log", "--format=%s").trim(), "Start Dog walk app");
  assert.deepEqual(registered, [dir, next]);
  assert.equal(renameProject({ dir: next, name: "Walkies 2", register }).dir, next, "its own folder is no clash");
});

test("commitStep makes one commit per finished step and none when nothing changed", (t) => {
  const root = tempRoot(t);
  const { register, run } = fakes();
  const { dir } = createProject({ name: "Shop", root, register, run });
  write(dir, { "index.html": "<h1>Shop</h1>\n" });
  const first = commitStep(dir, "Added the front page", { run });
  write(dir, { "cart.js": "export {};\n" });
  fs.rmSync(path.join(dir, "index.html"));
  const second = commitStep(dir, "Added the cart\nand dropped the old page", { run });
  assert.equal(commitStep(dir, "Nothing to see", { run }), null);
  assert.throws(() => commitStep(dir, "  ", { run }), /needs a message/);
  const log = history(dir, { run });
  assert.deepEqual(log.map((c) => c.message), ["Added the cart", "Added the front page", "Start Shop"]);
  assert.deepEqual(log.slice(0, 2).map((c) => c.sha), [second, first]);
  assert.ok(log.every((c) => /^[0-9a-f]{40}$/.test(c.sha) && !Number.isNaN(Date.parse(c.time))));
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("Undo to here adds a commit with the old files and loses nothing, uncommitted work included", (t) => {
  const root = tempRoot(t);
  const { register, run } = fakes();
  const { dir } = createProject({ name: "Shop", root, register, run });
  write(dir, { "index.html": "v1\n" });
  const v1 = /** @type {string} */ (commitStep(dir, "Added the front page", { run }));
  write(dir, { "index.html": "v2\n", "cart.js": "cart\n" });
  const v2 = /** @type {string} */ (commitStep(dir, "Added the cart", { run }));
  write(dir, { "notes.txt": "not committed yet\n" });
  const undone = undoTo(dir, v1, { run });
  assert.ok(undone.saved && undone.sha);
  assert.equal(fs.readFileSync(path.join(dir, "index.html"), "utf8"), "v1\n");
  assert.ok(!fs.existsSync(path.join(dir, "cart.js")) && !fs.existsSync(path.join(dir, "notes.txt")));
  const log = history(dir, { run });
  assert.deepEqual(log.map((c) => c.message), ['Undo to "Added the front page"', "Saved before undo", "Added the cart", "Added the front page", "Start Shop"]);
  assert.equal(git(dir, "show", `${v2}:cart.js`), "cart\n");
  assert.equal(git(dir, "show", `${undone.saved}:notes.txt`), "not committed yet\n");
  assert.equal(git(dir, "rev-parse", "HEAD^{tree}").trim(), git(dir, "rev-parse", `${v1}^{tree}`).trim());
  assert.equal(git(dir, "status", "--porcelain"), "");
  assert.deepEqual(undoTo(dir, undone.sha, { run }), { saved: null, sha: null }, "undo to where it already is changes nothing");
  assert.throws(() => undoTo(dir, "0".repeat(40), { run }), /not in this project's history/);
});

test("Undo to a point before a .gitignore is refused while files it would stop ignoring are there, and commits that point's tree exactly once they are gone", (t) => {
  const root = tempRoot(t);
  const { register, run } = fakes();
  const { dir } = createProject({ name: "Shop", root, register, run });
  const first = git(dir, "rev-parse", "HEAD").trim();
  write(dir, { ".gitignore": ".env\nnode_modules/\n" });
  const ignoring = /** @type {string} */ (commitStep(dir, "Ignored the secrets", { run }));
  write(dir, { "index.html": "v1\n" });
  commitStep(dir, "Added the front page", { run });
  write(dir, { ".env": "KEY=1\n" });
  fs.mkdirSync(path.join(dir, "node_modules"));
  write(dir, { "node_modules/x.js": "x\n" });
  assert.ok(undoTo(dir, ignoring, { run }).sha, "an old point that still ignores them is no problem");
  const head = git(dir, "rev-parse", "HEAD").trim();
  assert.throws(() => undoTo(dir, first, { run }), /would stop ignoring \.env, node_modules\/, so the next step would commit them/);
  assert.equal(git(dir, "rev-parse", "HEAD").trim(), head, "no commit was made");
  assert.equal(commitStep(dir, "Next step", { run }), null, "and they are still ignored");
  assert.equal(git(dir, "log", "--all", "--format=%H", "--", ".env", "node_modules").trim(), "", ".env is in no commit");
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), "KEY=1\n", "and it stays where it was");
  fs.rmSync(path.join(dir, ".env"));
  fs.rmSync(path.join(dir, "node_modules"), { recursive: true });
  const undone = undoTo(dir, first, { run });
  assert.ok(undone.sha && undone.saved === null);
  assert.equal(git(dir, "rev-parse", "HEAD^{tree}").trim(), git(dir, "rev-parse", `${first}^{tree}`).trim());
});

test("Undo is refused when an untracked or ignored file differs only in case from one the old point has, where git ignores case", (t) => {
  const root = tempRoot(t);
  const { register, run } = fakes();
  const { dir } = createProject({ name: "Shop", root, register, run });
  git(dir, "config", "core.ignorecase", "true");
  write(dir, { "Config.env": "OLD=1\n" });
  const old = /** @type {string} */ (commitStep(dir, "Added the settings", { run }));
  fs.rmSync(path.join(dir, "Config.env"));
  write(dir, { ".gitignore": "config.env\n" });
  commitStep(dir, "Dropped the settings", { run });
  write(dir, { "config.env": "NEW=1\n" });
  const head = git(dir, "rev-parse", "HEAD").trim();
  assert.throws(() => undoTo(dir, old, { run }), /would overwrite config\.env, which no commit holds/);
  assert.equal(git(dir, "rev-parse", "HEAD").trim(), head, "no commit was made");
  assert.equal(fs.readFileSync(path.join(dir, "config.env"), "utf8"), "NEW=1\n");
});

test("Undo is refused, naming them, when it would overwrite untracked or ignored files, and changes nothing", (t) => {
  const root = tempRoot(t);
  const { register, run } = fakes();
  const { dir } = createProject({ name: "Shop", root, register, run });
  write(dir, { ".env": "OLD=1\n", "notes.txt": "old notes\n" });
  fs.mkdirSync(path.join(dir, "data"));
  write(dir, { "data/a.json": "{}\n" });
  const old = /** @type {string} */ (commitStep(dir, "Added the settings", { run }));
  fs.rmSync(path.join(dir, ".env"));
  fs.rmSync(path.join(dir, "notes.txt"));
  fs.rmSync(path.join(dir, "data"), { recursive: true });
  write(dir, { ".gitignore": ".env\ndata/\n" });
  commitStep(dir, "Dropped the settings", { run });
  write(dir, { ".env": "NEW=1\n", "notes.txt": "new notes\n", "draft.txt": "mine\n" });
  fs.mkdirSync(path.join(dir, "data"));
  write(dir, { "data/b.json": "[]\n" });
  const head = git(dir, "rev-parse", "HEAD").trim();
  assert.throws(() => undoTo(dir, old, { run }), (err) => {
    assert.match(String(err), /would overwrite \.env, data\/, notes\.txt, which no commit holds/);
    return true;
  });
  assert.equal(git(dir, "rev-parse", "HEAD").trim(), head, "no commit was made");
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), "NEW=1\n");
  assert.equal(fs.readFileSync(path.join(dir, "notes.txt"), "utf8"), "new notes\n");
  assert.equal(git(dir, "status", "--porcelain", "--ignored").split("\n").filter(Boolean).sort().join("|"), "!! .env|!! data/|?? draft.txt|?? notes.txt");
});

test("createProject resumes only a folder it started, never a company repo or an unrelated folder of the name", (t) => {
  const root = tempRoot(t);
  const { register, registered, run } = fakes();
  const company = path.join(root, "Shop");
  fs.mkdirSync(company);
  git(company, "init", "-q", "-b", "main");
  write(company, { "README.md": "# Shop\n" });
  git(company, "add", "README.md");
  git(company, "commit", "-q", "-m", "Start Shop");
  git(company, "remote", "add", "origin", "git@github.com:company/Shop.git");
  assert.throws(() => createProject({ name: "Shop", root, register, run }), /a folder called Shop already exists and isn't a new project/);
  const plain = path.join(root, "Recipes");
  fs.mkdirSync(plain);
  write(plain, { "README.md": "# Recipes\n", "taxes.xlsx": "numbers" });
  assert.throws(() => createProject({ name: "Recipes", root, register, run }), /a folder called Recipes already exists/);
  assert.ok(!fs.existsSync(path.join(plain, ".git")), "nothing is made in it");
  const other = path.join(root, "Notes");
  fs.mkdirSync(other);
  git(other, "init", "-q", "-b", "main");
  write(other, { "a.txt": "a\n" });
  git(other, "add", "a.txt");
  git(other, "commit", "-q", "-m", "My own notes");
  assert.throws(() => createProject({ name: "Notes", root, register, run }), /a folder called Notes already exists/);
  const unborn = path.join(root, "Diary");
  fs.mkdirSync(unborn);
  git(unborn, "init", "-q", "-b", "main");
  write(unborn, { "private.txt": "mine\n" });
  git(unborn, "add", "private.txt");
  const index = git(unborn, "ls-files", "--stage");
  assert.throws(() => createProject({ name: "Diary", root, register, run }), /a folder called Diary already exists/);
  assert.equal(git(unborn, "ls-files", "--stage"), index, "its index is untouched");
  assert.ok(!fs.existsSync(path.join(unborn, "README.md")), "nothing is written in it");
  assert.deepEqual(registered, []);
  const started = path.join(root, "Blog");
  fs.mkdirSync(started);
  write(started, { "README.md": "# Blog\n" });
  assert.equal(createProject({ name: "Blog", root, register, run }).created, true, "a folder holding only its README is finished");
});

test("a git identity is used only when it has both a name and an email; otherwise the stand-in", (t) => {
  const dir = tempRoot(t);
  const { run } = fakes();
  git(dir, "init", "-q", "-b", "main");
  const standIn = ["-c", "user.name=Rivet", "-c", "user.email=rivet@localhost"];
  assert.deepEqual(commitArgs(dir, run).slice(0, 4), standIn, "none");
  git(dir, "config", "user.email", "someone@localhost");
  assert.deepEqual(commitArgs(dir, run).slice(0, 4), standIn, "an email alone");
  git(dir, "config", "--unset", "user.email");
  git(dir, "config", "user.name", "Someone");
  assert.deepEqual(commitArgs(dir, run).slice(0, 4), standIn, "a name alone");
  git(dir, "config", "user.email", "someone@localhost");
  assert.deepEqual(commitArgs(dir, run), ["-c", "commit.gpgsign=false", "commit"], "both");
});

test("bundleProjects writes a verified bundle, its owner's alone, for each project with commits, GitHub or not", (t) => {
  const root = tempRoot(t);
  const { register, run } = fakes();
  const local = createProject({ name: "Shop", root, register, run }).dir;
  write(local, { "a.txt": "a\n" });
  commitStep(local, "Added a", { run });
  const linked = createProject({ name: "Linked", root, register, run }).dir;
  git(linked, "remote", "add", "origin", "git@github.com:someone/Linked.git");
  const empty = path.join(root, "Empty");
  fs.mkdirSync(empty);
  git(empty, "init", "-q");
  const dest = path.join(tempRoot(t, "on-demand-"), "backups");
  const out = bundleProjects({ projects: [local, linked, empty, path.join(root, "gone")], dest, run });
  const bundle = path.join(dest, "shop.bundle");
  assert.deepEqual(out, [
    { dir: local, bundle },
    { dir: linked, bundle: path.join(dest, "linked.bundle") },
    { dir: empty, skipped: "no commits yet" },
    { dir: path.join(root, "gone"), skipped: "no commits yet" },
  ]);
  git(local, "bundle", "verify", "-q", bundle);
  const back = path.join(root, "restored");
  git(root, "clone", "-q", bundle, back);
  assert.equal(fs.readFileSync(path.join(back, "a.txt"), "utf8"), "a\n");
  assert.deepEqual(fs.readdirSync(dest), ["linked.bundle", "shop.bundle"]);
  assert.equal(fs.statSync(dest).mode & 0o777, 0o700);
  for (const name of fs.readdirSync(dest)) assert.equal(fs.statSync(path.join(dest, name)).mode & 0o777, 0o600, name);
  assert.ok(fs.existsSync(defaultBundleDir(root)));
  assert.ok(!projectsFromFolders(root).some((p) => p.name === ".backups"), "the bundle folder is never listed as a project");
});

test("createProject and each step commit refresh the project's bundle, named by its slug; a failed bundle never fails the commit", (t) => {
  const root = tempRoot(t);
  const backups = tempRoot(t, "backups-");
  const { register, run } = fakes();
  /** @type {string[]} */
  const logged = [];
  const log = (/** @type {string} */ line) => logged.push(line);
  const { dir } = createProject({ name: "Recipe site", root, register, run, backups, log });
  const bundle = path.join(backups, "recipe-site.bundle");
  git(dir, "bundle", "verify", "-q", bundle);
  write(dir, { "index.html": "v1\n" });
  const sha = commitStep(dir, "Added the front page", { run, backups, log });
  const main = () => git(root, "bundle", "list-heads", bundle, "refs/heads/main").trim();
  assert.equal(main(), `${sha} refs/heads/main`);
  /** @type {import("../lib/repo-home.mjs").Run} */
  const failing = (cmd, args, opts) => {
    if (args[0] === "bundle") throw new Error("disk full\nmore detail");
    return run(cmd, args, opts);
  };
  write(dir, { "index.html": "v2\n" });
  const kept = commitStep(dir, "Changed the front page", { run: failing, backups, log });
  assert.ok(kept && history(dir, { run })[0].sha === kept, "the commit lands");
  assert.deepEqual(logged, ["Recipe-site: its backup bundle was not refreshed (disk full)"]);
  assert.equal(main(), `${sha} refs/heads/main`, "the last good bundle stays");
  assert.deepEqual(fs.readdirSync(backups), ["recipe-site.bundle"]);
  git(dir, "remote", "add", "origin", "https://github.com/someone/Recipe-site.git");
  write(dir, { "index.html": "v3\n" });
  const linked = commitStep(dir, "Linked now", { run, backups, log });
  assert.equal(main(), `${linked} refs/heads/main`, "a project on GitHub keeps its own copy too");
});

test("rename unregisters the old path and moves the backup bundle to the new name, leaving no stale one", (t) => {
  const root = tempRoot(t);
  const backups = tempRoot(t, "backups-");
  const { register, registered, run } = fakes();
  const { dir } = createProject({ name: "Dog walk app", root, register, run, backups });
  /** @param {string} gone */
  const unregister = (gone) => registered.splice(registered.indexOf(gone), 1);
  const { dir: next } = renameProject({ dir, name: "Walkies", register, unregister, run, backups });
  assert.deepEqual(registered, [next]);
  assert.deepEqual(fs.readdirSync(backups), ["walkies.bundle"]);
  assert.equal(git(root, "bundle", "list-heads", path.join(backups, "walkies.bundle"), "refs/heads/main").trim(), `${git(next, "rev-parse", "HEAD").trim()} refs/heads/main`);
  /** @type {string[]} */
  const logged = [];
  /** @type {import("../lib/repo-home.mjs").Run} */
  const failing = (cmd, args, opts) => {
    if (args[0] === "bundle") throw new Error("disk full");
    return run(cmd, args, opts);
  };
  const third = renameProject({ dir: next, name: "Walks", register, unregister, run: failing, backups, log: (line) => logged.push(line) }).dir;
  assert.deepEqual(registered, [third]);
  assert.deepEqual(fs.readdirSync(backups), ["walkies.bundle"], "a bundle that failed keeps the old name's copy");
  assert.equal(logged.length, 1);
});

test("Link GitHub makes a private repo through gh and pushes, or pushes to the one it has; unlink keeps every local commit", (t) => {
  const root = tempRoot(t);
  const { calls, register, run: base } = fakes();
  let pushFails = false;
  /** @type {import("../lib/repo-home.mjs").Run} */
  const run = (cmd, args, opts = {}) => {
    if (cmd === "git" && args[0] === "push") {
      calls.push([cmd, ...args]);
      if (pushFails) throw new Error("rejected");
      return "";
    }
    const out = base(cmd, args, opts);
    if (cmd === "fake-gh") git(String(opts.cwd), "remote", "add", "origin", `https://github.com/someone/${args[2]}.git`);
    return out;
  };
  const { dir } = createProject({ name: "Dog walk app", root, register, run });
  assert.deepEqual(linkGitHub(dir, { gh: "fake-gh", run }), { repo: "someone/Dog-walk-app", created: true, pushed: true });
  assert.deepEqual(calls.filter((c) => c[0] === "fake-gh"), [["fake-gh", "repo", "create", "Dog-walk-app", "--private", "--source", dir, "--push"]]);
  assert.deepEqual(linkGitHub(dir, { gh: "fake-gh", run }), { repo: "someone/Dog-walk-app", created: false, pushed: true });
  assert.equal(calls.filter((c) => c[0] === "fake-gh").length, 1, "a linked project is never made again");
  assert.deepEqual(calls.filter((c) => c[1] === "push"), [["git", "push", "-u", "origin", "HEAD"]], "but it is pushed");
  pushFails = true;
  assert.throws(() => linkGitHub(dir, { gh: "fake-gh", run }), /rejected/, "a push that fails is never a link done");
  pushFails = false;
  const before = history(dir, { run });
  assert.deepEqual(unlinkGitHub(dir, { run }), ["origin"]);
  assert.equal(git(dir, "remote").trim(), "");
  assert.deepEqual(history(dir, { run }), before);
  assert.throws(() => linkGitHub(dir, { gh: "silent-gh", run }), /no GitHub remote/);
});

test("on Cloud a project is a lowercase folder under /srv/projects and lists as a project there", (t) => {
  const root = path.join(tempRoot(t, "cloud-"), "data", "home", "projects");
  fs.mkdirSync(root, { recursive: true });
  const { register, run } = fakes();
  const name = pickProjectName({ ask: "build me a dog walk booking app", projects: projectsFromFolders(root), root });
  const made = createProject({ name, root, lowercase: true, register, run });
  assert.equal(made.dir, path.join(root, made.folder));
  assert.match(made.folder, /^[a-z0-9-]+$/);
  assert.ok(fs.existsSync(path.join(made.dir, "CLAUDE.md")));
  const listed = projectsFromFolders(root);
  assert.ok(listed.some((p) => p.folder === made.dir));
  assert.equal(pickProjectName({ name, projects: listed, root }), `${name} 2`);
});
