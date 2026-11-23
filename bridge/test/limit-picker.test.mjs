import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AUTOPILOT_FRESH_MS, pickAccount, readAutopilot, readingProblems, roomOrder, takesPart, writeAutopilot } from "../lib/limit-picker.mjs";

const NOW = Date.parse("2026-11-22T00:00:00Z");
const H = 3600_000;
const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "limit-picker-"));
let n = 0;
const file = () => path.join(dir, `s${++n}`, "settings.json");

/** A status-file account row: weekly %, its reset in hours from NOW, and the rest as given. */
const row = (/** @type {string} */ account, /** @type {number} */ weekly, /** @type {number} */ resetH, /** @type {Record<string, unknown>} */ more = {}) => ({
  account,
  weekly: { percent: weekly, resetsAt: iso(NOW + resetH * H) },
  session: { percent: 0, resetsAt: iso(NOW + 2 * H) },
  readAt: iso(NOW - 2 * 60_000),
  error: null,
  ...more,
});
const KNOBS = { switchAt: 85, nearestReset: true, now: NOW };

test("the nearest weekly reset with room is picked first; with nearestReset off, the most room", () => {
  const rows = [row("a", 10, 100), row("b", 60, 20), row("c", 30, 50)];
  assert.deepEqual(pickAccount(rows, KNOBS), { pick: "b" });
  assert.deepEqual(pickAccount(rows, { ...KNOBS, nearestReset: false }), { pick: "a" });
  const tie = [row("a", 40, 30), row("b", 20, 30)];
  assert.deepEqual(pickAccount(tie, KNOBS), { pick: "b" }, "same reset: the most room");
  assert.equal([row("x", 50, 10), row("y", 50, 5)].sort(roomOrder({ nearestReset: false, now: NOW }))[0].account, "y", "same room: the nearest reset");
});

test("a window past its reset ranks as empty, with its next reset unknown", () => {
  // a read 90% a week that reset an hour ago: it has the most room, and its next reset is not the passed one.
  const rows = [row("a", 90, -1), row("b", 40, 30)];
  assert.deepEqual(pickAccount(rows, { ...KNOBS, nearestReset: false }), { pick: "a" });
  assert.deepEqual(pickAccount(rows, KNOBS), { pick: "b" });
});

test("the switch point is a hard line, on either window", () => {
  assert.deepEqual(pickAccount([row("a", 84.9, 10)], KNOBS), { pick: "a" });
  assert.ok("wait" in pickAccount([row("a", 85, 10)], KNOBS));
  const session = row("a", 10, 10, { session: { percent: 85, resetsAt: iso(NOW + H) } });
  assert.deepEqual(pickAccount([session, row("b", 50, 100)], KNOBS), { pick: "b" });
  // A window past its reset is empty again.
  const reset = row("a", 100, -1);
  assert.deepEqual(pickAccount([reset], KNOBS), { pick: "a" });
});

test("only the accounts taking part are picked; an empty list means all", () => {
  const rows = [row("a", 10, 10), row("b", 20, 50)];
  assert.deepEqual(pickAccount(rows, { ...KNOBS, takePart: ["b"] }), { pick: "b" });
  assert.deepEqual(pickAccount(rows, { ...KNOBS, takePart: [] }), { pick: "a" });
  assert.equal(takesPart("a", []), true);
  assert.equal(takesPart("a", ["b"]), false);
});

test("a stale, failed, signed-out or weekless reading names no account; an idle one's reading stands", () => {
  const rows = [
    row("old", 1, 1, { readAt: iso(NOW - 31 * 60_000) }),
    row("err", 1, 1, { error: "no reading" }),
    row("out", 1, 1, { signedOut: true }),
    row("never", 1, 1, { signedIn: false }),
    row("week", 0, 1, { weekly: { percent: 0, resetsAt: null, unread: true } }),
  ];
  assert.ok("wait" in pickAccount(rows, KNOBS));
  assert.deepEqual(pickAccount([...rows, row("idle", 40, 90, { idle: true, readAt: iso(NOW - 30 * H) })], KNOBS), { pick: "idle" });
});

test("all full: it waits, saying when the first room comes back, or null when no reset is known", () => {
  // a: weekly back in 50 h. b: both windows full, so its room comes back with the later one, 30 h. c: not taking part.
  const rows = [
    row("a", 90, 50),
    row("b", 95, 30, { session: { percent: 99, resetsAt: iso(NOW + 3 * H) } }),
    row("c", 99, 1),
  ];
  assert.deepEqual(pickAccount(rows, { ...KNOBS, takePart: ["a", "b"] }), { wait: { until: iso(NOW + 30 * H) } });
  assert.deepEqual(pickAccount([row("a", 90, 50, { weekly: { percent: 90, resetsAt: null } })], KNOBS), { wait: { until: null } });
  assert.deepEqual(pickAccount([], KNOBS), { wait: { until: null } });
});

test("readAutopilot is on only for a fresh, well-formed file that says on", () => {
  const good = { on: true, switchAt: 85, nearestReset: true, accounts: ["a", "b"] };
  const f = file();
  writeAutopilot(good, { file: f, now: NOW });
  assert.deepEqual(readAutopilot({ file: f, now: NOW + AUTOPILOT_FRESH_MS }), { ...good, wake: false });
  const w = file();
  writeAutopilot({ ...good, wake: true }, { file: w, now: NOW });
  assert.deepEqual(readAutopilot({ file: w, now: NOW }), { ...good, wake: true });
  assert.equal((fs.statSync(f).mode & 0o777).toString(8), "644");
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ["settings.json"], "no temp file left beside it");
  const off = { on: false };
  assert.deepEqual(readAutopilot({ file: path.join(dir, "missing.json"), now: NOW }), off, "missing");
  assert.deepEqual(readAutopilot({ file: f, now: NOW + AUTOPILOT_FRESH_MS + 1 }), off, "stale");
  assert.deepEqual(readAutopilot({ file: f, now: NOW - 61_000 }), off, "dated in the future");
  const bad = (/** @type {unknown} */ doc, /** @type {string} */ why) => {
    const g = file();
    fs.mkdirSync(path.dirname(g), { recursive: true });
    fs.writeFileSync(g, typeof doc === "string" ? doc : JSON.stringify(doc));
    assert.deepEqual(readAutopilot({ file: g, now: NOW }), off, why);
  };
  const at = iso(NOW);
  bad("{not json", "malformed");
  bad([good], "a list");
  bad(null, "null");
  bad({ ...good, at, extra: 1 }, "an extra key");
  bad({ ...good, on: false, at }, "on: false");
  bad({ ...good, on: "yes", at }, "on not a boolean");
  bad({ ...good, switchAt: 49, at }, "switch point too low");
  bad({ ...good, switchAt: 100, at }, "switch point too high");
  bad({ ...good, switchAt: 85.5, at }, "switch point not whole");
  bad({ ...good, nearestReset: 1, at }, "nearestReset not a boolean");
  bad({ ...good, wake: "yes", at }, "wake not a boolean");
  bad({ ...good, accounts: ["Bad Name"], at }, "an account name that is no dir");
  bad({ ...good, accounts: Array.from({ length: 17 }, (_, i) => `a${i}`), at }, "too many accounts");
  bad({ ...good }, "no time");
  bad({ ...good, at: "yesterday" }, "a time that is no time");
});

test("readingProblems names a weekless reply and a failed or old read; idle, signed-out and never signed-in accounts are skipped", () => {
  const rows = [
    row("ok", 10, 10),
    row("week", 0, 10, { weekly: { percent: 0, resetsAt: null, unread: true } }),
    row("err", 0, 10, { error: "usage reply had no windows", weekly: null, session: null, readAt: null }),
    row("old", 10, 10, { readAt: iso(NOW - 46 * 60_000) }),
    row("idle", 10, 10, { idle: true, readAt: iso(NOW - 30 * H) }),
    row("idleweek", 0, 10, { idle: true, weekly: { percent: 0, resetsAt: null, unread: true } }),
    row("out", 0, 10, { signedOut: true, error: "signed out", readAt: null }),
    // The usage job status file's row for a dir with no sign-in, and a reader's row that says so.
    row("never", 0, 10, { error: "not signed in", weekly: null, session: null, readAt: null }),
    row("nosign", 0, 10, { signedIn: false, error: "no reading", readAt: null }),
  ];
  const said = readingProblems(rows, { now: NOW }).map((p) => [p.account.account, p.problem]);
  assert.deepEqual(said, [["week", "no week"], ["err", "no reading"], ["old", "no reading"]]);
  assert.deepEqual(readingProblems(rows, { now: NOW, takePart: ["ok", "old"] }).map((p) => p.account.account), ["old"]);
});
