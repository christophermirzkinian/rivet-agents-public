import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExecError } from "../lib/config.mjs";

// when.mjs reads the zone as it loads: a fixed UTC+11, for the day below.
process.env.RIVET_TIME_ZONE = "Pacific/Guadalcanal";
process.env.RIVET_REPOS = "example-org/example-repo";
const { NO_RUN, resetWords, restReset, scheduledRun } = await import("../lib/scheduled-run.mjs");

const RESET = Date.UTC(2026, 9, 8, 6, 56, 29);
const NOW = Date.UTC(2026, 9, 8, 6, 40, 0);
const refused = () => new ExecError("/bin/gh", { code: 1 }, "gh: API rate limit exceeded for user ID 1. (HTTP 403)\n", "");

/** @param {Partial<Parameters<typeof scheduledRun>[2]>} [over] */
function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-run-"));
  /** @type {string[]} */
  const lines = [];
  let resets = 0;
  const deps = {
    now: () => NOW,
    streakFile: path.join(dir, "job-github-streak.json"),
    reset: async () => {
      resets += 1;
      return RESET;
    },
    print: (/** @type {string} */ line) => lines.push(line),
    ...over,
  };
  return { deps, lines, streak: deps.streakFile, resets: () => resets };
}

test("a run GitHub turned away for its budget says when it resets and exits 0", async () => {
  const s = setup();
  assert.equal(await scheduledRun("ci-triage", async () => { throw refused(); }, s.deps), 0);
  assert.equal(s.resets(), 1);
  assert.equal(s.lines.length, 1);
  assert.match(s.lines[0], / ci-triage-skipped reason=HTTP_403 rate-limited, resets at 5:56pm$/);
  assert.ok(fs.existsSync(s.streak), "the run of skips is remembered");
});

test("an outage is a skip too, with no reset to look up; a reset GitHub did not send is said so", async () => {
  const s = setup();
  const outage = new ExecError("/bin/gh", { code: 1 }, "gh: HTTP 502: Bad Gateway\n", "");
  assert.equal(await scheduledRun("fly-errors", async () => { throw outage; }, s.deps), 0);
  assert.equal(s.resets(), 0);
  assert.match(s.lines[0], /fly-errors-skipped reason=HTTP_502 GitHub unavailable$/);
  const u = setup({ reset: async () => null });
  await scheduledRun("player-text", async () => { throw refused(); }, u.deps);
  assert.match(u.lines[0], /rate-limited, reset time unknown$/);
});

test("skips turn red after the grace hour, and a good run ends the streak", async () => {
  const s = setup();
  await scheduledRun("issue-recheck", async () => { throw refused(); }, s.deps);
  const later = { ...s.deps, now: () => NOW + 61 * 60_000 };
  assert.equal(await scheduledRun("issue-recheck", async () => { throw refused(); }, later), 1);
  assert.match(s.lines[1], /issue-recheck-failed error=rate-limited,_resets_at_5:56pm_for_61_min/);
  assert.equal(await scheduledRun("issue-recheck", async () => {}, later), 0);
  assert.ok(!fs.existsSync(s.streak));
  // The streak starts again from the next refusal.
  assert.equal(await scheduledRun("issue-recheck", async () => { throw refused(); }, later), 0);
});

test("any other failure exits 1 as before, and a run's own exit code is kept", async () => {
  const s = setup();
  /** @type {unknown[]} */
  const failed = [];
  const local = new Error("quotes a rate limit but is local");
  assert.equal(await scheduledRun("regions", async () => { throw local; }, { ...s.deps, fail: (err) => failed.push(err) }), 1);
  assert.deepEqual(failed, [local]);
  assert.equal(await scheduledRun("ci-triage", async () => { throw new ExecError("/bin/gh", { code: 1 }, "gh: Not Found (HTTP 404)", ""); }, s.deps), 1);
  assert.match(s.lines[0], /^\S+ ci-triage-failed error=gh_exit_1$/);
  assert.equal(await scheduledRun("regions", async () => 2, s.deps), 2);
  assert.equal(s.resets(), 0);
  assert.ok(!fs.existsSync(s.streak));
});

test("the reset comes from a refused call's headers; an answer means none is known", async () => {
  const head = "HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Reset: 1791442589\r\nX-Ratelimit-Used: 5000\r\n\r\n{}";
  /** @type {string[][]} */
  const calls = [];
  const exec = async (/** @type {string} */ _bin, /** @type {string[]} */ args) => {
    calls.push(args);
    throw Object.assign(new Error("gh exit 1"), { stdout: head });
  };
  assert.equal(await restReset({ exec, ghBin: "/bin/gh" }), 1791442589 * 1000);
  assert.deepEqual(calls[0].slice(0, 2), ["api", "-i"]);
  assert.equal(await restReset({ exec: async () => ({ stdout: "HTTP/2.0 200 OK\r\n\r\n3" }), ghBin: "/bin/gh" }), null);
  assert.equal(await restReset({ exec: async () => { throw new Error("spawn failed"); }, ghBin: "/bin/gh" }), null);
  // A reset past midnight says its day, as when.mjs says every time.
  assert.equal(resetWords(Date.UTC(2026, 9, 8, 13, 5, 0), NOW), "Fri 12:05am");
  delete process.env.RIVET_REPOS;
  const none = [];
  assert.equal(await restReset({ exec: async (...args) => none.push(args), ghBin: "/bin/gh" }), null, "no repo set: nothing to ask");
  assert.deepEqual(none, []);
  process.env.RIVET_REPOS = "example-org/example-repo";
});

test("a run that did nothing (its lock busy) keeps the streak, and a failed git fetch is GitHub's trouble too", async () => {
  const s = setup();
  await scheduledRun("ci-triage", async () => { throw refused(); }, s.deps);
  assert.equal(await scheduledRun("ci-triage", async () => NO_RUN, s.deps), 0);
  assert.ok(fs.existsSync(s.streak), "a busy run is no good run");
  const later = { ...s.deps, now: () => NOW + 61 * 60_000 };
  assert.equal(await scheduledRun("ci-triage", async () => { throw refused(); }, later), 1, "so the grace hour still runs out");
  const r = setup();
  const fetch = new ExecError("/usr/bin/git", { code: 1 }, "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com\n");
  assert.equal(await scheduledRun("sweep", async () => { throw fetch; }, r.deps), 0);
  assert.match(r.lines[0], /sweep-skipped reason=no_answer GitHub unavailable$/);
});

test("a skip logs no word of the child's output", async () => {
  const s = setup();
  const secret = "gh" + "p_" + "A".repeat(36);
  const err = new ExecError("/bin/gh", { code: 1 }, `GH_TOKEN=${secret}\nHTTP 502\n`);
  assert.equal(await scheduledRun("ci-triage", async () => { throw err; }, s.deps), 0);
  assert.match(s.lines[0], / ci-triage-skipped reason=no_answer GitHub unavailable$/);
  const later = { ...s.deps, now: () => NOW + 61 * 60_000 };
  assert.equal(await scheduledRun("ci-triage", async () => { throw err; }, later), 1);
  assert.ok(s.lines.every((line) => !line.includes(secret) && !line.includes("GH_TOKEN")), s.lines.join("\n"));
});
