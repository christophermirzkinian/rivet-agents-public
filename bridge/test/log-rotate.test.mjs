import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LOG_MAX_BYTES, rotateLog, runLogRotateLoop } from "../lib/log-rotate.mjs";

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

function withRotateLoop(t, work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-log-loop-"));
  const file = path.join(dir, "bridge.log");
  const stop = new AbortController();
  const events = [];
  t.mock.timers.enable({ apis: ["setInterval"] });
  const setInterval = globalThis.setInterval;
  const clearInterval = globalThis.clearInterval;
  const handles = new Map();
  // Keep node:test's scheduling, with unref-capable handles even on versions returning numeric IDs.
  globalThis.setInterval = (callback, ms) => {
    const handle = { unref() {} };
    handles.set(handle, setInterval(callback, ms));
    return handle;
  };
  globalThis.clearInterval = (handle) => clearInterval(handles.get(handle));
  try {
    work({
      file, stop, events,
      start: () => runLogRotateLoop({ stop: stop.signal, path: file, log: (event, fields) => events.push({ event, ...fields }) }),
    });
  } finally {
    stop.abort();
    globalThis.setInterval = setInterval;
    globalThis.clearInterval = clearInterval;
    t.mock.timers.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("runLogRotateLoop rotates an oversized log immediately", (t) => {
  withRotateLoop(t, (h) => {
    const contents = Buffer.alloc(LOG_MAX_BYTES + 1, "a");
    fs.writeFileSync(h.file, contents);
    h.start();
    assert.equal(fs.statSync(h.file).size, 0);
    assert.ok(fs.readFileSync(`${h.file}.1`).equals(contents));
    assert.deepEqual(h.events, [{ event: "log-rotated", path: h.file }]);
  });
});

test("runLogRotateLoop rotates a log that grows at the ten-minute check", (t) => {
  withRotateLoop(t, (h) => {
    const first = Buffer.from("first line\n");
    fs.writeFileSync(h.file, first);
    h.start();
    assert.deepEqual(h.events, []);
    const growth = Buffer.alloc(LOG_MAX_BYTES, "b");
    fs.appendFileSync(h.file, growth);
    t.mock.timers.tick(600_000 - 1);
    assert.equal(fs.statSync(h.file).size, first.length + growth.length);
    assert.equal(fs.existsSync(`${h.file}.1`), false);
    t.mock.timers.tick(1);
    assert.equal(fs.statSync(h.file).size, 0);
    assert.ok(fs.readFileSync(`${h.file}.1`).equals(Buffer.concat([first, growth])));
    assert.deepEqual(h.events, [{ event: "log-rotated", path: h.file }]);
  });
});

test("runLogRotateLoop leaves logs under and exactly at the limit alone across checks", (t) => {
  withRotateLoop(t, (h) => {
    fs.writeFileSync(h.file, "short log\n");
    fs.writeFileSync(`${h.file}.1`, "previous rotation\n");
    h.start();
    t.mock.timers.tick(600_000);
    assert.equal(fs.readFileSync(h.file, "utf8"), "short log\n");
    const contents = Buffer.alloc(LOG_MAX_BYTES, "c");
    fs.writeFileSync(h.file, contents);
    t.mock.timers.tick(600_000);
    t.mock.timers.tick(600_000);
    assert.ok(fs.readFileSync(h.file).equals(contents));
    assert.equal(fs.readFileSync(`${h.file}.1`, "utf8"), "previous rotation\n");
    assert.deepEqual(h.events, []);
  });
});

test("runLogRotateLoop logs a real rotation failure and retries at the next interval", (t) => {
  withRotateLoop(t, (h) => {
    const contents = Buffer.alloc(LOG_MAX_BYTES + 1, "d");
    fs.writeFileSync(h.file, contents);
    fs.mkdirSync(`${h.file}.1`); // unlink cannot replace a directory; the original log must survive.
    h.start();
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].event, "log-rotate-failed");
    assert.ok(h.events[0].error.includes(`${h.file}.1`));
    assert.ok(fs.readFileSync(h.file).equals(contents));
    fs.rmdirSync(`${h.file}.1`);
    t.mock.timers.tick(600_000 - 1);
    assert.equal(h.events.length, 1, "failure does not trigger an immediate retry");
    assert.ok(fs.readFileSync(h.file).equals(contents));
    t.mock.timers.tick(1);
    assert.equal(fs.statSync(h.file).size, 0);
    assert.ok(fs.readFileSync(`${h.file}.1`).equals(contents));
    assert.deepEqual(h.events[1], { event: "log-rotated", path: h.file });
    assert.equal(h.events.length, 2);
  });
});

test("runLogRotateLoop abort stops later checks even if the log grows oversized", (t) => {
  withRotateLoop(t, (h) => {
    fs.writeFileSync(h.file, "before abort\n");
    h.start();
    h.stop.abort();
    const contents = Buffer.alloc(LOG_MAX_BYTES + 1, "e");
    fs.writeFileSync(h.file, contents);
    t.mock.timers.tick(600_000);
    t.mock.timers.tick(600_000);
    assert.ok(fs.readFileSync(h.file).equals(contents));
    assert.equal(fs.existsSync(`${h.file}.1`), false);
    assert.deepEqual(h.events, []);
  });
});
