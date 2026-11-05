import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dated } from "../../bridge/lib/when.mjs";
import { Spend, plainText } from "../lib.mjs";
import {
  LABEL,
  MARKER,
  errorsPass,
  flyApps,
  isError,
  issueBody,
  newErrors,
  parseErrors,
  parseLogStream,
  signature,
  tsKey,
} from "../fly-errors.mjs";

const TOKEN = `${"gh"}p_${"Q1w2E3r4T5".repeat(4)}`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fly-errors-"));
const NOW = Date.parse("2026-10-08T02:30:00Z");
const entry = (ts, message, level = "info") => ({ level, instance: "e286", message, region: "lhr", timestamp: ts, meta: {} });
const stream = (entries) => entries.map((e) => JSON.stringify(e, null, 2)).join("\n");

test("parseLogStream reads flyctl's pretty-printed objects and skips the rest", () => {
  const text = `${stream([entry("2026-10-08T02:00:00Z", 'a } { "quoted" brace')])}\nnot json {\n${stream([entry("2026-10-08T02:01:00.5Z", "b")])}`;
  assert.deepEqual(parseLogStream(text).map((e) => e.message), ['a } { "quoted" brace', "b"]);
});

test("issueBody says its window's times with their day, as when.mjs does", () => {
  const c = { key: "k", app: "web-api", example: "boom", count: 2, first: NOW - 50 * 60_000, last: NOW };
  assert.ok(issueBody(c, { title: "t", steps: [] }).includes(`between ${dated(c.first)} and ${dated(c.last)}.`));
});

test("tsKey pads fractions so timestamps sort as text", () => {
  assert.equal(tsKey("2026-10-08T01:19:10.657716Z"), "2026-10-08T01:19:10.657716000Z");
  assert.ok(tsKey("2026-10-08T01:19:10.657716Z") < tsKey("2026-10-08T01:19:10.657716123Z"));
  assert.equal(tsKey("2026-10-08T01:19:10Z"), "2026-10-08T01:19:10.000000000Z");
  assert.equal(tsKey("yesterday"), "");
});

test("flyApps reads the comma list once each, and nothing set is an empty list", () => {
  assert.deepEqual(flyApps({ RIVET_FLY_APPS: " web-api, site ,web-api,,Not Valid" }), ["site", "web-api"]);
  assert.deepEqual(flyApps({}), []);
  assert.deepEqual(flyApps({ RIVET_FLY_APPS: "" }), []);
});

test("isError and signature fold repeats of one error together", () => {
  assert.ok(isError({ level: "error", message: "x" }));
  assert.ok(isError({ level: "info", message: '{"msg":"scheduler_tick_error","error":"canceling statement"}' }));
  assert.ok(!isError({ level: "info", message: "GET /health 200 errors=0" }));
  assert.equal(
    signature(`machine ID 148e2737a4d389 lease held by ${["3f2b7c1e", "0a1b", "4c2d", "9e8f", "0123456789ab"].join("-")} until 2026-10-08T02:00:00Z (attempt 3)`),
    signature(`machine ID 9d81e2a7b3c401 lease held by ${["0f2b7c1e", "0a1b", "4c2d", "9e8f", "0123456789ff"].join("-")} until 2026-10-08T03:10:00Z (attempt 12)`),
  );
});

test("newErrors reads the last hour on first sight, then only what is new, and redacts across entries", () => {
  const entries = [
    entry("2026-10-08T01:00:00Z", "old error before the hour", "error"),
    entry("2026-10-08T02:10:00Z", "boom error one", "error"),
    entry("2026-10-08T02:20:00.1Z", "fine"),
  ];
  const first = newErrors(entries, undefined, NOW);
  assert.deepEqual(first.errors.map((e) => e.text), ["boom error one"]);
  assert.equal(first.seen.last, "2026-10-08T02:20:00.100000000Z");
  const later = [...entries, entry("2026-10-08T02:20:00.1Z", "same instant error", "error"), entry("2026-10-08T02:25:00Z", "next error", "error")];
  const second = newErrors(later, first.seen, NOW);
  assert.deepEqual(second.errors.map((e) => e.text), ["same instant error", "next error"]);
  const secret = [entry("2026-10-08T02:26:00Z", `GH_TOKEN=${TOKEN}`), entry("2026-10-08T02:26:01Z", "error right after it", "error")];
  const third = newErrors(secret, second.seen, NOW);
  assert.deepEqual(third.errors.map((e) => e.text), [""], "inside the redactor's hold: counted, not described");
  assert.ok(!JSON.stringify(third).includes(TOKEN));
});

test("newErrors keeps a secret's continuation hidden in the next poll, and holds the first lines after a gap", () => {
  const before = [entry("2026-10-08T02:00:00Z", "config loaded"), entry("2026-10-08T02:10:00Z", "password: |")];
  const first = newErrors(before, undefined, NOW);
  const next = newErrors([...before, entry("2026-10-08T02:11:00Z", "  correct horse error staple")], first.seen, NOW);
  assert.deepEqual(next.errors.map((e) => e.text), [""]);
  assert.ok(!JSON.stringify(next).includes("horse"));
  assert.equal(next.gap, false);
  // Nothing before the new entries: the batch does not reach back to the last read.
  const burst = Array.from({ length: 12 }, (_, i) => entry(`2026-10-08T02:2${Math.floor(i / 6)}:${String(i * 5).padStart(2, "0")}Z`, `boom error ${i}`, "error"));
  const after = newErrors(burst, first.seen, NOW);
  assert.equal(after.gap, true);
  assert.deepEqual(after.errors.map((e) => e.text).slice(9), ["", "boom error 10", "boom error 11"]);
});

test("newErrors holds a secret's burst in the next poll after its opening scrolls out, and a quiet app is not held", () => {
  const filler = (from, n) => Array.from({ length: n }, (_, i) => entry(new Date(Date.parse(from) + i * 1000).toISOString(), "tick"));
  const at = (s) => new Date(Date.parse("2026-10-08T02:05:00Z") + s * 1000).toISOString();
  const one = [...filler("2026-10-08T02:00:00Z", 6), entry(at(0), "password: |"), ...["  aa", "  bb", "  cc"].map((m, i) => entry(at(i + 1), m))];
  const first = newErrors(one, undefined, NOW);
  assert.equal(first.seen.heldAt, tsKey(at(3)));
  // The header has scrolled out of the next batch; eleven more lines of its burst have not been read.
  const burst = Array.from({ length: 11 }, (_, i) => entry(at(i + 4), i === 10 ? "  correct horse error staple" : `  line${i}`));
  const two = [...one.slice(-3), ...burst, ...filler("2026-10-08T02:07:00Z", 12), entry("2026-10-08T02:09:00Z", "later error", "error")];
  const second = newErrors(two, first.seen, NOW);
  assert.deepEqual(second.errors.map((e) => e.text), ["", "later error"]);
  assert.ok(!JSON.stringify(second).includes("horse"));
  assert.equal(second.gap, false);
  // A slow burst: indented lines ten seconds apart over two minutes, between unindented ones that are read.
  for (const colour of ["", "\x1b[32m", "\u200b"]) {
    const slow = [...one.slice(-3), ...Array.from({ length: 11 }, (_, i) => entry(at(13 + i * 10), `${colour}  ${i === 10 ? "correct horse error staple" : "aa"}`)), entry(at(200), "error sync failed", "error"), ...filler(at(201), 85)];
    const third = newErrors(slow, first.seen, NOW + 600_000);
    assert.deepEqual(third.errors.map((e) => e.text), ["", "error sync failed"]);
    assert.ok(!JSON.stringify(third).includes("horse"));
  }
  // A coloured error line is an error, read as the redactor shows it.
  const red = newErrors([...filler("2026-10-08T02:00:00Z", 3), entry("2026-10-08T02:20:00Z", "\x1b[31merror: sync stuck\x1b[0m")], { last: tsKey("2026-10-08T02:00:02Z") }, NOW);
  assert.deepEqual(red.errors.map((e) => e.text), ["error: sync stuck"]);
  // A quiet app's first read holds its first lines; the next poll's are read.
  const quiet = filler("2026-10-08T02:10:00Z", 5);
  const q1 = newErrors(quiet, undefined, NOW);
  assert.equal(q1.seen.heldAt, undefined);
  const q2 = newErrors([...quiet, entry("2026-10-08T02:20:00Z", "error sync failed", "error")], q1.seen, NOW);
  assert.deepEqual(q2.errors.map((e) => e.text), ["error sync failed"]);
});

test("newErrors reads only the last hour when the cursor is older (the computer was off)", () => {
  const stale = { last: "2026-10-07T02:00:00.000000000Z", atLast: [] };
  const got = newErrors([entry("2026-10-07T02:05:00Z", "yesterday error", "error"), entry("2026-10-08T02:00:00Z", "today error", "error")], stale, NOW);
  assert.deepEqual(got.errors.map((e) => e.text), ["today error"]);
});

test("signature keeps HTTP status codes and folds other numbers", () => {
  assert.notEqual(signature("error POST /orders status=400"), signature("error POST /orders status=500"));
  assert.notEqual(signature('error {"code": 404}'), signature('error {"code": 502}'));
  assert.notEqual(signature("upstream HTTP/1.1 502 error"), signature("upstream HTTP/1.1 503 error"));
  assert.notEqual(signature("error POST /api/orders 500"), signature("error POST /api/orders 400"));
  assert.equal(signature("error took 250 ms"), signature("error took 300 ms"));
  const long = `/orders/${"segment/".repeat(10)}x`;
  assert.notEqual(signature(`error POST ${long} 400`), signature(`error POST ${long} 500`));
  assert.equal(signature("error status=500 after 3 tries"), "error status=500 after N tries");
});

test("parseErrors keeps checked fields only, and safe text notifies nobody", () => {
  const v = parseErrors(
    {
      errors: [
        { k: 1, real: true, open: null, sure: true, title: "Jobs stall @sam see #12", steps: ["Look at `flyctl logs`", 5] },
        { k: 2, real: true, open: 99, sure: true, title: "x", steps: [] },
        { k: 3, real: "yes", open: null, sure: true, title: "x" },
        { k: 9, real: false, open: null, sure: true, title: "" },
      ],
    },
    3,
    new Set([12]),
  );
  assert.deepEqual([...v.keys()], [1]);
  assert.equal(v.get(1).title, "Jobs stall (at)sam see no. 12");
  assert.deepEqual(v.get(1).steps, ["Look at flyctl logs"]);
  assert.equal(plainText("<b>[x](y)</b>"), "b x(y)/b");
  assert.equal(plainText("~~gone~~ Inspect ~/app/logs/error.log"), "gone Inspect ~/app/logs/error.log");
  assert.throws(() => parseErrors({ nope: [] }, 1, new Set()), /no errors list/);
});

/** A fake Fly, GitHub and model for errorsPass. */
function world({ issues = [], closed = [], answer, logs }) {
  const calls = { gh: [], prompts: [], created: [] };
  let nextIssue = 900;
  return {
    calls,
    deps: (dir, over = {}) => {
      let saved = {};
      const d = {
        gh: async (args, input) => {
          calls.gh.push(args);
          if (args[0] === "issue" && args[1] === "list") return JSON.stringify(args.includes("all") ? [...issues, ...closed] : issues);
          if (args[0] === "api" && args.includes("POST")) {
            // The issue goes on stdin as one JSON body, kept on its args as `.issue`: no text in the arguments.
            assert.deepEqual(args, ["api", "-X", "POST", "repos/example-org/example-repo/issues", "--input", "-", "--jq", ".html_url"]);
            const issue = JSON.parse(input);
            Object.assign(args, { issue, input });
            calls.created.push(args);
            const n = nextIssue++;
            issues.push({ number: n, title: issue.title, body: issue.body, createdAt: new Date(NOW).toISOString() });
            return `https://github.com/o/r/issues/${n}\n`;
          }
          throw new Error(`unexpected gh ${args.join(" ")}`);
        },
        fly: async (args) => {
          // Fly's batch reaches back past the hour, so the first read has what came before its new entries.
          return stream([entry("2026-10-08T00:00:00Z", "booted"), ...(logs[args[2]] ?? [])]);
        },
        apps: ["site", "web-api"],
        repo: "example-org/example-repo",
        run: async (input) => {
          calls.prompts.push(input);
          const result = JSON.stringify(typeof answer === "function" ? answer(input) : answer);
          return JSON.stringify({ is_error: false, result, usage: { input_tokens: 3000, output_tokens: 200 } });
        },
        spend: new Spend("fly-errors", 2, { dir: path.join(dir, "spend") }),
        now: () => NOW,
        log: () => {},
        load: () => saved,
        save: (s) => {
          saved = JSON.parse(JSON.stringify(s));
        },
        append: () => {},
        ...over,
      };
      return d;
    },
  };
}

test("errorsPass files at most 5 real, sure, new errors an hour, labelled, with a marker, and sends nothing unredacted", async () => {
  const dir = tmp();
  const kinds = "abcdefg".split("");
  const logs = {
    "web-api": [
      ...kinds.map((k, i) => entry(`2026-10-08T02:0${i}:00Z`, `error kind${k} failed in job`, "error")),
      entry("2026-10-08T02:09:00Z", `token leak ${TOKEN} error`, "error"),
      // The redactor holds the 10 lines after a secret, whichever poll they come in.
      ...Array.from({ length: 10 }, (_, i) => entry(`2026-10-08T02:1${i}:30Z`, "tick")),
    ],
    "site": [entry("2026-10-08T02:05:00Z", "health check error during deploy", "error")],
  };
  // Health checks are noise; every other signature is real.
  const answer = (input) => ({
    errors: input
      .split("\n")
      .filter((l) => /^\d+\. app /.test(l))
      .map((l) => ({ k: Number(l.split(".")[0]), real: !l.includes("health check"), open: null, sure: true, title: `Broken ${l.split(".")[0]}`, steps: ["Check the job logs"] })),
  });
  const w = world({ issues: [{ number: 12, title: `Old ${TOKEN}`, body: "", createdAt: "2026-10-01T00:00:00Z" }], answer, logs });
  const d = w.deps(dir);
  const result = await errorsPass(d);
  assert.equal(w.calls.prompts.length, 1);
  assert.ok(!w.calls.prompts[0].includes(TOKEN), "logs and titles redacted before the model");
  assert.equal(w.calls.prompts[0].match(/^\d+\. app /gm).length, 8, "the fully redacted line is counted, never asked about");
  assert.equal(result.filed.length, 5);
  for (const args of w.calls.created) {
    assert.deepEqual(args.issue.labels, [LABEL]);
    assert.match(args.issue.body, new RegExp(`^<!-- ${MARKER}: [0-9a-f]{16} -->`));
    assert.ok(!args.input.includes(TOKEN));
    assert.ok(!/claude|haiku|generated with/i.test(args.input), "no tool attribution");
  }
  // Ten minutes later: no new ask inside the hour.
  const again = await errorsPass({ ...d, now: () => NOW + 10 * 60 * 1000 });
  assert.equal(w.calls.prompts.length, 1);
  assert.equal(again.filed.length, 0);
  // An hour later everything recurs: only the two real ones left over are asked about and filed.
  logs["web-api"].push(...kinds.map((k, i) => entry(`2026-10-08T03:2${i}:00Z`, `error kind${k} failed in job`, "error")));
  logs["site"].push(entry("2026-10-08T03:25:00Z", "health check error during deploy", "error"));
  const hour = await errorsPass({ ...d, now: () => NOW + 61 * 60 * 1000 });
  assert.equal(w.calls.prompts.length, 2);
  assert.equal(w.calls.prompts[1].match(/^\d+\. app /gm).length, 2);
  assert.ok(!w.calls.prompts[1].includes("health check"), "dismissed for a day");
  assert.equal(hour.filed.length, 2);
  assert.equal(new Set(w.calls.created.map((a) => a.issue.body.split("\n")[0])).size, 7, "seven signatures, one issue each");
});

test("errorsPass counts this job's issues from the last hour toward the limit, even with its state lost", async () => {
  const dir = tmp();
  const ours = Array.from({ length: 4 }, (_, i) => ({ number: 50 + i, title: "t", body: `<!-- ${MARKER}: ${String(i).padStart(16, "0")} -->`, createdAt: new Date(NOW - 20 * 60 * 1000).toISOString() }));
  const logs = { "web-api": Array.from({ length: 3 }, (_, i) => entry(`2026-10-08T02:0${i}:00Z`, `error new${"abc"[i]}`, "error")) };
  const answer = { errors: [1, 2, 3].map((k) => ({ k, real: true, open: null, sure: true, title: `New ${k}`, steps: [] })) };
  const w = world({ issues: ours, answer, logs });
  const result = await errorsPass(w.deps(dir));
  assert.equal(result.filed.length, 1);
});

test("errorsPass counts this job's closed issues from the last hour toward the limit too", async () => {
  const dir = tmp();
  const closed = Array.from({ length: 4 }, (_, i) => ({ number: 60 + i, title: "t", body: `<!-- ${MARKER}: ${String(i).padStart(16, "1")} -->`, createdAt: new Date(NOW - 20 * 60 * 1000).toISOString() }));
  const logs = { "web-api": Array.from({ length: 3 }, (_, i) => entry(`2026-10-08T02:0${i}:00Z`, `error new${"abc"[i]}`, "error")) };
  const answer = { errors: [1, 2, 3].map((k) => ({ k, real: true, open: null, sure: true, title: `New ${k}`, steps: [] })) };
  const w = world({ closed, answer, logs });
  const result = await errorsPass(w.deps(dir));
  assert.equal(result.filed.length, 1);
});

test("errorsPass acts on nothing from a call that takes the day to its ceiling", async () => {
  const dir = tmp();
  const logs = { "web-api": [entry("2026-10-08T02:00:00Z", "error sync failed", "error")] };
  const answer = { errors: [{ k: 1, real: true, open: null, sure: true, title: "Sync", steps: [] }] };
  const w = world({ answer, logs });
  let saves = 0;
  const d = w.deps(dir, { spend: new Spend("near", 0.000001, { dir: path.join(dir, "spend") }), save: () => saves++ });
  const result = await errorsPass(d);
  assert.equal(w.calls.prompts.length, 1);
  assert.equal(result.capped, true);
  assert.equal(w.calls.created.length, 0);
  assert.equal(saves, 0);
});

test("errorsPass asks again on the next pass after a bad answer", async () => {
  const dir = tmp();
  const logs = { "web-api": [entry("2026-10-08T02:00:00Z", "error sync failed", "error")] };
  let bad = true;
  const answer = () => (bad ? { nope: 1 } : { errors: [{ k: 1, real: true, open: null, sure: true, title: "Sync", steps: [] }] });
  const w = world({ answer, logs });
  const d = w.deps(dir);
  await errorsPass(d);
  assert.equal(w.calls.created.length, 0);
  bad = false;
  await errorsPass({ ...d, now: () => NOW + 10 * 60 * 1000 });
  assert.equal(w.calls.prompts.length, 2);
  assert.equal(w.calls.created.length, 1);
});

test("errorsPass asks again about signatures an answer left out, and a failed ask loses nothing collected since the last one", async () => {
  const dir = tmp();
  const logs = { "web-api": [entry("2026-10-08T02:00:00Z", "error sync failed", "error")] };
  let mode = "empty";
  const answer = (input) => {
    if (mode === "empty") return { errors: [] };
    if (mode === "bad") return { nope: 1 };
    return { errors: input.split("\n").filter((l) => /^\d+\. app /.test(l)).map((l) => ({ k: Number(l.split(".")[0]), real: true, open: null, sure: true, title: "T", steps: [] })) };
  };
  const w = world({ answer, logs });
  const d = w.deps(dir);
  await errorsPass(d);
  mode = "ok";
  await errorsPass({ ...d, now: () => NOW + 10 * 60 * 1000 });
  assert.equal(w.calls.prompts.length, 2);
  assert.equal(w.calls.created.length, 1);
  // An error collected ten minutes after an answered ask, then a failed hourly ask: the retry still has it.
  logs["web-api"].push(entry("2026-10-08T02:45:00Z", "error sync stuck", "error"));
  await errorsPass({ ...d, now: () => NOW + 20 * 60 * 1000 });
  mode = "bad";
  await errorsPass({ ...d, now: () => NOW + 75 * 60 * 1000 });
  mode = "ok";
  await errorsPass({ ...d, now: () => NOW + 85 * 60 * 1000 });
  assert.equal(w.calls.prompts.length, 4);
  assert.match(w.calls.prompts[3], /sync stuck/);
  assert.equal(w.calls.created.length, 2);
});

test("errorsPass keeps what it collected while no ask has been answered yet", async () => {
  const dir = tmp();
  const logs = { "web-api": [entry("2026-10-08T02:00:00Z", "error sync failed", "error")] };
  let mode = "bad";
  const answer = (input) =>
    mode === "bad" ? { nope: 1 } : { errors: input.split("\n").filter((l) => /^\d+\. app /.test(l)).map((l) => ({ k: Number(l.split(".")[0]), real: true, open: null, sure: true, title: "T", steps: [] })) };
  const w = world({ answer, logs });
  const d = w.deps(dir);
  for (const m of [0, 10, 20, 30, 40, 50]) await errorsPass({ ...d, now: () => NOW + m * 60 * 1000 });
  mode = "ok";
  await errorsPass({ ...d, now: () => NOW + 60 * 60 * 1000 });
  assert.equal(w.calls.prompts.length, 7);
  assert.match(w.calls.prompts[6], /sync failed/);
  assert.equal(w.calls.created.length, 1);
});

test("errorsPass treats an unsure match to an open issue as not covered", async () => {
  const dir = tmp();
  const logs = { "web-api": [entry("2026-10-08T02:00:00Z", "error statement timeout", "error")] };
  let sure = false;
  const answer = () => ({ errors: [{ k: 1, real: true, open: 12, sure, title: "Timeouts", steps: [] }] });
  const w = world({ issues: [{ number: 12, title: "Other", body: "", createdAt: "2026-10-01T00:00:00Z" }], answer, logs });
  const d = w.deps(dir);
  await errorsPass(d);
  assert.equal(w.calls.created.length, 0);
  // Re-asked once the day's dismissal ends, and a sure match then covers it.
  logs["web-api"].push(entry("2026-10-09T03:00:00Z", "error statement timeout", "error"));
  sure = true;
  const later = NOW + 25 * 60 * 60 * 1000;
  await errorsPass({ ...d, now: () => later });
  assert.equal(w.calls.prompts.length, 2);
  logs["web-api"].push(entry("2026-10-09T04:00:00Z", "error statement timeout", "error"));
  await errorsPass({ ...d, now: () => later + 61 * 60 * 1000 });
  assert.equal(w.calls.prompts.length, 2, "covered by #12 while it is open");
});

test("errorsPass reads nothing at the ceiling, and a dry run files and saves nothing", async () => {
  const dir = tmp();
  const logs = { "web-api": [entry("2026-10-08T02:00:00Z", "error x", "error")] };
  const answer = { errors: [{ k: 1, real: true, open: null, sure: true, title: "X", steps: [] }] };
  const w = world({ issues: [], answer, logs });
  const touched = [];
  const capped = await errorsPass(w.deps(dir, { spend: new Spend("capped", 0, { dir: path.join(dir, "spend") }), fly: async () => void touched.push("fly") }));
  assert.equal(capped.capped, true);
  assert.deepEqual(touched, []);
  let saves = 0;
  const dry = await errorsPass(w.deps(dir, { dryRun: true, save: () => saves++ }));
  assert.equal(dry.filed.length, 1);
  assert.equal(w.calls.created.length, 0);
  assert.equal(saves, 0);
});

test("a Fly error message is redacted before it is cut, so a token past the cut leaves no head", () => {
  const first = newErrors([entry("2026-10-08T02:00:00Z", "start")], undefined, NOW);
  const next = newErrors([entry("2026-10-08T02:00:00Z", "start"), entry("2026-10-08T02:10:00Z", "a normal line"), entry("2026-10-08T02:11:00Z", `${" ".repeat(1994)}${TOKEN}`, "error")], first.seen, NOW);
  const said = JSON.stringify(next);
  assert.equal(next.errors.length, 1);
  assert.ok(!said.includes(TOKEN.slice(0, 4)), said);
});
