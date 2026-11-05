import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readRerunRecord, reserveRerun, underLock } from "../lib/rerun-guard.mjs";

// The re-run record's lock is a darwin kernel lock (O_EXLOCK); CI's Linux runs skip this, and scripts/check-local.mjs
// runs it on the Mac.
const darwinOnly = { skip: process.platform !== "darwin" && "the kernel lock is darwin-only", timeout: 30_000 };

test("a live holder in another process keeps the re-run record's lock, paused or not, and its death frees it at once", darwinOnly, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rerun-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "auto-handlers", "reruns.json");
  const ready = path.join(dir, "holder.pid");
  const guard = new URL("../lib/rerun-guard.mjs", import.meta.url).href;
  const holder = spawn(process.execPath, ["--input-type=module", "-e", `
    import { underLock } from ${JSON.stringify(guard)};
    import { writeFileSync } from "node:fs";
    underLock(${JSON.stringify(file)}, () => { writeFileSync(${JSON.stringify(ready)}, String(process.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });
  `], { stdio: "ignore" });
  const exited = new Promise((done) => holder.once("exit", done));
  t.after(() => holder.kill("SIGKILL"));
  for (let i = 0; !fs.existsSync(ready); i++) {
    if (i > 200) throw new Error("the holder never took the lock");
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.throws(() => underLock(file, () => "wrote", { waitMs: 300 }), /the re-run record is locked/);
  // A writer paused past any age a takeover would trust still holds it.
  holder.kill("SIGSTOP");
  assert.throws(() => underLock(file, () => "wrote", { waitMs: 300 }), /the re-run record is locked/);
  holder.kill("SIGKILL");
  await exited;
  assert.ok(fs.existsSync(`${file}.lock`), "a killed holder's lock file is left behind");
  assert.equal(underLock(file, () => "wrote", { waitMs: 0 }), "wrote");
  const job = { job: "Leg / Checks", sha: "a".repeat(40), at: new Date().toISOString(), run: 1, attempt: 1, cause: "false alarm", result: /** @type {const} */ ("pending") };
  assert.equal(reserveRerun([job], Date.now(), file), null);
  assert.equal(readRerunRecord(file).length, 1);
});
