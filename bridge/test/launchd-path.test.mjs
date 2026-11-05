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
