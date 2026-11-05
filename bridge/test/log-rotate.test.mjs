import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { rotateLog } from "../lib/log-rotate.mjs";

test("rotateLog: past the cap the log becomes .1 and is cut in place; under it, and missing, nothing moves", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-log-"));
  try {
    const log = path.join(dir, "rivet-bridge.log");
    assert.equal(rotateLog(log, 10), false, "no log yet");
    fs.writeFileSync(log, "0123456789");
    assert.equal(rotateLog(log, 10), false, "at the cap");
    // An appending writer, as launchd's, keeps writing to the same file after the cut.
    const fd = fs.openSync(log, "a");
    fs.writeSync(fd, "abc\n");
    assert.equal(rotateLog(log, 10), true);
    assert.equal(fs.readFileSync(`${log}.1`, "utf8"), "0123456789abc\n");
    assert.equal(fs.statSync(log).size, 0);
    fs.writeSync(fd, "next\n");
    fs.closeSync(fd);
    assert.equal(fs.readFileSync(log, "utf8"), "next\n", "the next line starts the file");
    fs.writeFileSync(log, "x".repeat(11));
    assert.equal(rotateLog(log, 10), true);
    assert.equal(fs.readFileSync(`${log}.1`, "utf8"), "x".repeat(11), "one old file, replaced");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateLog follows no symlink: a linked log is left alone, and a linked .1 is replaced, not written through", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-log-"));
  try {
    const log = path.join(dir, "rivet-bridge.log");
    const other = path.join(dir, "other.txt");
    fs.writeFileSync(other, "y".repeat(20));
    fs.symlinkSync(other, log);
    assert.throws(() => rotateLog(log, 10), { code: "ELOOP" }, "a linked log is not opened");
    assert.equal(fs.readFileSync(other, "utf8"), "y".repeat(20));
    fs.unlinkSync(log);
    fs.writeFileSync(log, "x".repeat(11));
    fs.symlinkSync(other, `${log}.1`);
    assert.equal(rotateLog(log, 10), true);
    assert.equal(fs.readFileSync(other, "utf8"), "y".repeat(20), "the link's target is untouched");
    assert.equal(fs.lstatSync(`${log}.1`).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(`${log}.1`, "utf8"), "x".repeat(11));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
