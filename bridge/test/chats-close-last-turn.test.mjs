import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { lastTurn, realIo } from "../lib/chats-close.mjs";

const NOW = Date.parse("2026-11-22T10:00:00Z");
const HOUR = 3600_000;
const entry = (/** @type {number} */ at) => JSON.stringify({ timestamp: new Date(at).toISOString() });

/** Real transcripts with explicit mtimes, isolated and removed after each test. @param {import("node:test").TestContext} t */
function transcripts(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chats-close-last-turn-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (/** @type {string} */ name, /** @type {string} */ text, mtime = NOW) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    fs.utimesSync(file, new Date(mtime), new Date(mtime));
    assert.equal(fs.statSync(file).mtimeMs, mtime, "the fixture has the exact requested mtime");
    return file;
  };
  return { root, write };
}

test("lastTurn finds a recent nested turn when the newest-modified transcript holds only old entries", (t) => {
  const { root, write } = transcripts(t);
  const recent = NOW - 5 * 60_000;
  write("newest.jsonl", [entry(NOW - 3 * HOUR), entry(NOW - 2 * HOUR)].join("\n"), NOW);
  write("session/subagents/older.jsonl", entry(recent), NOW - 60_000);

  assert.equal(lastTurn(root), recent, "a touched old transcript cannot hide recent activity two folders down");
});

test("lastTurn tolerates malformed lines and an unfinished timestamp while retaining the greatest valid timestamp", (t) => {
  const { root, write } = transcripts(t);
  const recent = NOW - 5 * 60_000;
  write("damaged.jsonl", [
    "not JSON",
    entry(NOW - 2 * HOUR),
    '{"broken":}',
    "",
    entry(recent),
    entry(NOW - HOUR),
    '{"timestamp":"2026-11-22T09:',
  ].join("\n"));

  assert.equal(lastTurn(root), recent, "damaged lines do not discard valid turns or make the last line authoritative");
});

test("lastTurn counts a complete timestamp in a partial JSON line as activity", (t) => {
  const { root, write } = transcripts(t);
  const recent = NOW - 5 * 60_000;
  write("partial.jsonl", `${entry(NOW - HOUR)}\n{"timestamp":"${new Date(recent).toISOString()}","message":`);

  assert.equal(lastTurn(root), recent, "an unfinished JSON record still supplies its complete timestamp");
});

test("lastTurn returns null for missing folders and an empty transcript folder", (t) => {
  const { root } = transcripts(t);

  assert.equal(lastTurn(path.join(root, "missing")), null, "a missing transcript folder is harmless");
  assert.equal(lastTurn(path.join(root, "missing", "nested")), null, "missing ancestors are harmless");
  assert.equal(lastTurn(root), null, "an empty folder has no known turn");
});

test("lastTurn ignores timestamps that do not parse, returning null only when no valid timestamp remains", (t) => {
  const { root, write } = transcripts(t);
  const invalid = ["not-a-date", "", "2026-99-99T25:61:61Z"].map((timestamp) => JSON.stringify({ timestamp })).join("\n");
  write("invalid.jsonl", invalid);
  assert.equal(lastTurn(root), null, "unparseable timestamps do not become a known turn or NaN");

  const recent = NOW - 5 * 60_000;
  write("invalid.jsonl", `${invalid}\n${entry(recent)}\n${invalid}`);
  assert.equal(lastTurn(root), recent, "invalid timestamps before and after a valid turn cannot poison the result");
});

test("lastTurn excludes non-transcript files and transcripts more than two folders below the root", (t) => {
  const { root, write } = transcripts(t);
  write("session/subagents/turn.jsonl", entry(NOW - HOUR));
  write("notes.txt", entry(NOW));
  write("session/subagents/deeper/ignored.jsonl", entry(NOW));

  assert.equal(lastTurn(root), NOW - HOUR, "only .jsonl files within the documented depth supply turns");
});

for (const [offset, position] of [[-1000, "below"], [0, "equal to"], [1000, "above"]]) {
  test(`lastTurn ${offset > 0 ? "reads" : "prunes"} a transcript whose mtime is ${position} the best turn timestamp`, (t) => {
    const { root, write } = transcripts(t);
    const best = NOW - HOUR;
    const first = write("first.jsonl", entry(best), NOW);
    const candidate = write("candidate.jsonl", entry(best + offset), best + offset);
    const opened = [];
    const open = fs.openSync;
    // Observe real reads: a correct result alone cannot prove that an older file was pruned.
    t.mock.method(fs, "openSync", (/** @type {any[]} */ ...args) => {
      opened.push(String(args[0]));
      return Reflect.apply(open, fs, args);
    });

    assert.equal(lastTurn(root), offset > 0 ? best + offset : best);
    assert.deepEqual(opened, offset > 0 ? [first, candidate] : [first], "the prune boundary is mtime <= best");
  });
}

test("realIo.lastTurnAt reads the worktree's encoded transcript folder under the supplied temporary home", (t) => {
  const { root, write } = transcripts(t);
  const recent = NOW - 5 * 60_000;
  write(".claude/projects/-work-demo-app/session.jsonl", entry(recent));
  const io = realIo(root);

  assert.equal(io.lastTurnAt("/work/demo-app"), recent, "the caller reaches the real transcript lookup");
  assert.equal(io.lastTurnAt("/work/missing"), null, "a worktree without transcripts has no known turn");
});
