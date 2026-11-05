import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { makeExec, resolveBin } from "../lib/config.mjs";
import { briefNames, chatStems, createWorkRepos, workRepo } from "../lib/work-repo.mjs";

// A chat's repo from where its work is: its clone by name, else its brief, read on the Mac.

const MAIN = "example-org/example-repo";
const SECOND = "example-org/second-repo";
const THIRD = "example-org/third-repo";
process.env.RIVET_REPOS = [MAIN, SECOND, THIRD].join(",");

/** A home with ~/.rivet-agents/work and ~/.rivet-agents/briefs. */
function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-repo-"));
  fs.mkdirSync(path.join(dir, ".rivet-agents", "work"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".rivet-agents", "briefs"), { recursive: true });
  return dir;
}

/** A checkout at ~/.rivet-agents/work/<rel> whose origin is url. @param {string} dir @param {string} rel @param {string} url */
function clone(dir, rel, url) {
  const at = path.join(dir, ".rivet-agents", "work", rel);
  fs.mkdirSync(at, { recursive: true });
  execFileSync("git", ["init", "-q", at]);
  execFileSync("git", ["-C", at, "remote", "add", "origin", url]);
}

/** @param {string} dir @param {string} name @param {string} text */
const brief = (dir, name, text) => fs.writeFileSync(path.join(dir, ".rivet-agents", "briefs", `${name}.md`), text);

const deps = (dir) => ({ exec: makeExec(), git: () => resolveBin("git"), home: dir });

test("a chat's stems: its name, less its suffix, less a stage word", () => {
  assert.deepEqual(chatStems("second-work-plan-2"), ["second-work-plan-2", "second-work-plan", "second-work"]);
  assert.deepEqual(chatStems("second-trailer-build"), ["second-trailer-build", "second-trailer"]);
  assert.deepEqual(chatStems("shape-pack-a3"), ["shape-pack-a3", "shape-pack"]);
  assert.deepEqual(chatStems("town-box-auto"), ["town-box-auto"]);
  // Never a path step: `..-build` would read ~/.rivet-agents itself.
  assert.deepEqual(chatStems("..-build"), []);
});

test("a clone named by a stem, its repo folder first, is the chat's work", async () => {
  const dir = home();
  clone(dir, "second-work/repo", `https://github.com/${SECOND}.git`);
  assert.equal(await workRepo(deps(dir), { chat: "second-work-plan", repo: MAIN }), SECOND);
  clone(dir, "daily-notes", `git@github.com:${THIRD.toLowerCase()}.git`);
  // Spelled as the allow-list spells it.
  assert.equal(await workRepo(deps(dir), { chat: "daily-notes", repo: MAIN }), THIRD);
  // A clone of a repo Rivet does not know is no answer; the brief is read next.
  clone(dir, "other/repo", "https://github.com/someone/else.git");
  brief(dir, "other", `Work in ${SECOND}.`);
  assert.equal(await workRepo(deps(dir), { chat: "other", repo: MAIN }), SECOND);
});

test("the brief: an explicit line wins, else the one repo its folders and words name", async () => {
  const dir = home();
  brief(dir, "second-plan", `Repo: ${SECOND} (not in this folder). Also see ${THIRD}.`);
  assert.equal(await workRepo(deps(dir), { chat: "second-plan-2", repo: MAIN }), SECOND);
  clone(dir, "shape-tools/repo", `https://github.com/${THIRD}`);
  brief(dir, "shape-pack-build", "Read ~/.rivet-agents/work/shape-tools/ first.");
  assert.equal(await workRepo(deps(dir), { chat: "shape-pack-build", repo: MAIN }), THIRD);
  brief(dir, "both", `Box ${SECOND} and ${THIRD} chats.`);
  assert.equal(await workRepo(deps(dir), { chat: "both", repo: MAIN }), undefined);
  brief(dir, "nothing", "Fix the lobby tile.");
  assert.equal(await workRepo(deps(dir), { chat: "nothing", repo: MAIN }), MAIN);
  brief(dir, "unknown", "Project: someone/else\nWork in example-org/second-repo too.");
  assert.equal(await workRepo(deps(dir), { chat: "unknown", repo: MAIN }), undefined);
  // A brief that is not a regular file (a FIFO would block the loop) is unread.
  execFileSync("mkfifo", [path.join(dir, ".rivet-agents", "briefs", "fifo.md")]);
  assert.equal(await workRepo(deps(dir), { chat: "fifo", repo: MAIN }), undefined);
  // No brief and no clone: unread.
  assert.equal(await workRepo(deps(dir), { chat: "no-brief", repo: MAIN }), undefined);
});

test("a brief's names: never a path, only the repos and folder names", () => {
  assert.deepEqual(briefNames("**Repo:** `example-org/second-repo`"), { explicit: SECOND, folders: [], spelled: [] });
  assert.deepEqual(briefNames("Repo: /opt/x/work/example/thing"), { folders: [], spelled: [] });
  assert.deepEqual(briefNames(`See ~/.rivet-agents/work/tool-x/. and https://github.com/${SECOND}/pull/3`), { folders: ["tool-x"], spelled: [SECOND] });
});

test("a huge brief reads in linear time: a million blank lines never stalls the loop", () => {
  const started = performance.now();
  assert.deepEqual(briefNames(`${"\n".repeat(1_000_000)}x`), { folders: [], spelled: [] });
  assert.ok(performance.now() - started < 1000);
  // The explicit line still reads with leading spaces and a quote mark, on one line only.
  assert.equal(briefNames("  > Project: example-org/second-repo").explicit, "example-org/second-repo");
  assert.equal(briefNames("Project:\nexample-org/second-repo").explicit, undefined);
});

test("a git that fails or hangs is unread, never a throw", async () => {
  const dir = home();
  clone(dir, "second", `https://github.com/${SECOND}`);
  const exec = async () => {
    throw Object.assign(new Error("timed out"), { stderrFirstLine: "" });
  };
  assert.equal(await workRepo({ exec, git: () => "git", home: dir }, { chat: "second", repo: MAIN }), undefined);
  const noGit = () => {
    throw new Error("git not found on PATH");
  };
  assert.equal(await workRepo({ exec: makeExec(), git: noGit, home: dir }, { chat: "second", repo: MAIN }), undefined);
});

test("each chat's answer is held ten minutes", async () => {
  const dir = home();
  let t = 0;
  let runs = 0;
  const exec = makeExec();
  const counted = async (/** @type {any[]} */ ...args) => {
    runs++;
    return exec(...args);
  };
  clone(dir, "second", `https://github.com/${SECOND}`);
  const read = createWorkRepos({ exec: /** @type {any} */ (counted), git: () => resolveBin("git"), home: dir, now: () => t });
  assert.equal(await read({ chat: "second", repo: MAIN }), SECOND);
  const first = runs;
  t = 9 * 60_000;
  assert.equal(await read({ chat: "second", repo: MAIN }), SECOND);
  assert.equal(runs, first);
  t = 11 * 60_000;
  await read({ chat: "second", repo: MAIN });
  assert.ok(runs > first);
});
