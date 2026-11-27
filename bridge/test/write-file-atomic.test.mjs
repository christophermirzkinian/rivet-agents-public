import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("atomic writer replaces UTF-8 content, preserves mode, and leaves no temporary file", async (t) => {
  const { writeFileAtomic } = await import("../lib/write-file-atomic.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "old", { mode: 0o640 });
  const mask = process.umask(0o077);
  try {
    writeFileAtomic(file, "new café\n");
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    writeFileAtomic(path.join(dir, "new.json"), "new");
    assert.equal(fs.statSync(path.join(dir, "new.json")).mode & 0o777, 0o600);
  } finally {
    process.umask(mask);
  }
  assert.equal(fs.readFileSync(file, "utf8"), "new café\n");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["new.json", "state.json"]);
});

test("atomic writer keeps the old content and cleans up after a partial write fails", async (t) => {
  const { writeFileAtomic } = await import("../lib/write-file-atomic.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "old\n");
  const write = fs.writeFileSync;
  const failure = new Error("partial write failed");
  t.mock.method(fs, "writeFileSync", (fd) => {
    assert.equal(typeof fd, "number");
    write(fd, "{");
    throw failure;
  });
  assert.throws(() => writeFileAtomic(file, "replacement"), (error) => error === failure);
  assert.equal(fs.readFileSync(file, "utf8"), "old\n");
  assert.deepEqual(fs.readdirSync(dir), ["state.json"]);
});

test("atomic writer keeps the old content and cleans up when rename fails", async (t) => {
  const { writeFileAtomic } = await import("../lib/write-file-atomic.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "old");
  const failure = new Error("rename failed");
  t.mock.method(fs, "renameSync", () => { throw failure; });
  assert.throws(() => writeFileAtomic(file, "new"), (error) => error === failure);
  assert.equal(fs.readFileSync(file, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(dir), ["state.json"]);
});
