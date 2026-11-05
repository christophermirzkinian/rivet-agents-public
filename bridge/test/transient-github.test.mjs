import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExecError } from "../lib/config.mjs";
import { isTransientExec } from "../lib/transient-github.mjs";

test("child failures use the shared classifier without trusting local error text", () => {
  assert.equal(isTransientExec(new ExecError("/bin/gh", { code: 1 }, "notice\nHTTP 502")), true);
  assert.equal(isTransientExec(new ExecError("/bin/gh", { killed: true }, "")), true);
  assert.equal(isTransientExec(new ExecError("/bin/gh", { code: 1 }, "HTTP 401")), false);
  assert.equal(isTransientExec(new Error("HTTP 502 rate limit")), false);
  assert.equal(isTransientExec({ output: [], stderr: "HTTP 429" }), true);
});

test("the installed classifier loads from bridge/lib and scripts alone", () => {
  const installer = readFileSync(new URL("../../scripts/install-bridge.sh", import.meta.url), "utf8");
  // The installer copies the whole repo, so bridge/lib's forwarding modules find scripts/ beside them.
  const rsync = installer.split("\n").find((line) => line.startsWith("rsync "));
  assert.ok(rsync?.includes('"$SRC/" "$STAGE/"'), rsync);
  assert.doesNotMatch(rsync, /--exclude (?:bridge|scripts)\b/);
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-classifier-"));
  try {
    for (const sub of ["bridge/lib", "scripts"]) cpSync(new URL(`../../${sub}/`, import.meta.url), path.join(dir, sub), { recursive: true });
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { isTransientExec } from './bridge/lib/transient-github.mjs';
      import { ExecError } from './bridge/lib/config.mjs';
      if (!isTransientExec(new ExecError('/bin/gh', {code: 1}, 'HTTP 502'))) process.exit(1);
    `], { cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
