import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { makeExec, resolveBin } from "../lib/config.mjs";
import { folderRepo, prRepo, remoteRepo } from "../lib/folder-repo.mjs";

// A card's --pr with no --repo names the working folder's repo's PR, never silently the default repo's.

process.env.RIVET_REPOS = "example-org/example-repo,example-org/Other-Repo";

const SAY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "say.mjs");

/** A checkout whose origin is url, or none when url is undefined. @param {string | undefined} url */
function checkout(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "folder-repo-"));
  execFileSync("git", ["init", "-q", dir]);
  if (url !== undefined) execFileSync("git", ["-C", dir, "remote", "add", "origin", url]);
  return dir;
}

test("a GitHub remote, https or ssh, is its owner/name; any other remote is none", () => {
  assert.equal(remoteRepo("https://github.com/example-org/Other-Repo.git\n"), "example-org/Other-Repo");
  assert.equal(remoteRepo("https://x-access-token:secret@github.com/example-org/Other-Repo"), "example-org/Other-Repo");
  assert.equal(remoteRepo("git@github.com:example-org/example-repo.git"), "example-org/example-repo");
  assert.equal(remoteRepo("ssh://git@github.com/example-org/third-repo.git"), "example-org/third-repo");
  // Any host case, and a port, are still GitHub.
  assert.equal(remoteRepo("https://GitHub.com/example-org/Other-Repo.git"), "example-org/Other-Repo");
  assert.equal(remoteRepo("ssh://git@github.com:22/example-org/Other-Repo.git"), "example-org/Other-Repo");
  assert.equal(remoteRepo("/home/someone/repos/Big-Beam"), undefined);
  assert.equal(remoteRepo("https://gitlab.com/example-org/Other-Repo.git"), undefined);
});

test("--pr with no --repo: the default repo outside another repo's checkout, that repo inside one, refused for an unknown one", () => {
  assert.equal(prRepo(27, undefined), undefined);
  assert.equal(prRepo(27, "example-org/example-repo"), undefined);
  assert.equal(prRepo(27, "example-org/Other-Repo"), "example-org/Other-Repo");
  // Spelled as the allow-list spells it, whatever case the remote has.
  assert.equal(prRepo(27, "Example-Org/other-repo"), "example-org/Other-Repo");
  assert.throws(() => prRepo(27, "someone/else"), /--pr 27 has no --repo and this folder is someone\/else, which Rivet does not know: give --repo/);
});

test("the folder's repo is read from its origin remote; no checkout or no origin is none; what can't be read is refused", async () => {
  const exec = makeExec();
  const git = () => resolveBin("git");
  assert.equal(await folderRepo(exec, git, checkout("git@github.com:example-org/Other-Repo.git")), "example-org/Other-Repo");
  assert.equal(await folderRepo(exec, git, checkout(undefined)), undefined);
  assert.equal(await folderRepo(exec, git, fs.mkdtempSync(path.join(os.tmpdir(), "folder-repo-"))), undefined);
  // Never the default repo when the folder's repo is unknown: an origin that is no GitHub URL (its token
  // unechoed), no git, or a git that fails otherwise.
  await assert.rejects(folderRepo(exec, git, checkout("https://" + "tok3n" + "@" + "gitlab.com/x/y.git")), (err) => {
    assert.match(/** @type {Error} */ (err).message, /this folder's origin is not a GitHub URL: give --repo/);
    assert.doesNotMatch(/** @type {Error} */ (err).message, /tok3n/);
    return true;
  });
  const noGit = () => {
    throw new Error("git not found on PATH");
  };
  await assert.rejects(folderRepo(exec, noGit, os.tmpdir()), /could not be read \(no git\): give --repo/);
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), "folder-repo-"));
  fs.writeFileSync(path.join(broken, ".git"), `gitdir: ${path.join(broken, "missing")}\n`);
  await assert.rejects(folderRepo(exec, git, broken), /could not be read \(git exit 128\): give --repo/);
  const timedOut = async () => {
    throw Object.assign(new Error("git timed out"), { stderrFirstLine: "" });
  };
  await assert.rejects(folderRepo(timedOut, git, os.tmpdir()), /could not be read \(git timed out\): give --repo/);
});

test("say.mjs refuses a card's --pr with no --repo in an unknown repo's checkout, before anything is sent", () => {
  const dir = checkout("https://github.com/someone/else.git");
  const r = spawnSync(process.execPath, [SAY, "--reply-to", "m1", "--card", "--text", "Done", "--pr", "7"], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH, RIVET_URL: "http://127.0.0.1:9", RIVET_REPOS: process.env.RIVET_REPOS },
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--pr 7 has no --repo and this folder is someone\/else, which Rivet does not know/);
});
