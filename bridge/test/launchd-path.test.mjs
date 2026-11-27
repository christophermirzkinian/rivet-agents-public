import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SCRIPT = fileURLToPath(new URL("../../scripts/launchd-path.sh", import.meta.url));

test("a launchd PATH drops checkout and ~/Documents entries, relative ones and repeats", () => {
  const home = path.join(os.tmpdir(), "someone");
  const input = [
    `${home}/code/rivet-agents/node_modules/.bin`,
    `${home}/.cache/node/corepack/v1/pnpm/9.15.9/dist/node-gyp-bin`,
    `${home}/Documents/code/rivet-agents/node_modules/.bin`,
    `${home}/Documents/bin`,
    `${home}/.nvm/versions/node/v24.13.1/bin`,
    "/opt/homebrew/bin",
    "~/.dotnet/tools",
    "",
    "/opt/homebrew/bin",
    `${home}/Documents-not/bin`,
    "/usr/bin",
  ].join(":");
  const out = execFileSync("/bin/bash", ["-c", `. "$1"; launchd_path "$2"`, "test", SCRIPT, input], { encoding: "utf8", env: { HOME: home } });
  assert.equal(out, [`${home}/.nvm/versions/node/v24.13.1/bin`, "/opt/homebrew/bin", `${home}/Documents-not/bin`, "/usr/bin"].join(":"));
});

test("a launchd PATH puts ~/.local/bin first, so a shim there wins over Homebrew's binary", () => {
  const shim = "/home/robot/.local/bin";
  const run = (path) => execFileSync("/bin/bash", ["-c", `. "$1"; launchd_path "$2"`, "test", SCRIPT, path], { encoding: "utf8", env: { HOME: "/home/robot" } });
  assert.equal(run(`/opt/homebrew/bin:${shim}:/usr/bin:${shim}`), `${shim}:/opt/homebrew/bin:/usr/bin`);
  assert.equal(run(shim), shim);
  assert.equal(run("/opt/homebrew/bin:/usr/bin"), "/opt/homebrew/bin:/usr/bin");
});

test("a launchd PATH drops any checkout's .claude/bin, repeated or with a trailing slash", () => {
  const home = "/home/robot";
  const run = (entries) => execFileSync("/bin/bash", ["-c", `. "$1"; launchd_path "$2"`, "test", SCRIPT, entries.join(":")], { encoding: "utf8", env: { HOME: home } });
  assert.equal(
    run([
      `${home}/workspaces/example-repo/monitor/.claude/bin`,
      `${home}/workspaces/example-repo/monitor/.claude/bin`,
      `${home}/runner/wt/credit-issue-sweep-2026-11-25T12-30-00-512Z/.claude/bin`,
      "/srv/checkout/.claude/bin/",
      "/srv/checkout/.claude/bin//",
      `${home}/Documents/`,
      "/opt/homebrew/bin",
      "/opt/homebrew/bin/",
      "/usr/bin",
    ]),
    "/opt/homebrew/bin:/usr/bin",
  );
});

test("a launchd PATH drops Codex's per-run temp dirs and its package's codex-path helper dir", () => {
  const home = "/home/robot";
  const run = (entries) => execFileSync("/bin/bash", ["-c", `. "$1"; launchd_path "$2"`, "test", SCRIPT, entries.join(":")], { encoding: "utf8", env: { HOME: home } });
  assert.equal(
    run([
      `${home}/accounts/1b9a11f1/home/tmp/arg0/codex-arg0JnmtD5`,
      `${home}/accounts/1b9a11f1/home/tmp/arg0/codex-arg0FJ6PYe/`,
      `${home}/.nvm/versions/node/v24.13.1/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex-path`,
      "/opt/homebrew/bin",
      `${home}/tmp/bin`,
      "/usr/bin",
    ]),
    `/opt/homebrew/bin:${home}/tmp/bin:/usr/bin`,
  );
});
