import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { zoneDay } from "../../bridge/lib/spend.mjs";
import { Spend } from "../lib.mjs";
import { batchPrompt, clusters, mentions, namedPaths, parseLog, parseVerdicts, recheckPass, report } from "../issue-recheck.mjs";

const TOKEN = `${"gh"}p_${"Q1w2E3r4T5".repeat(4)}`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "issue-recheck-"));

test("namedPaths finds repo paths, once each, and never a parent-relative one", () => {
  assert.deepEqual(namedPaths("See app/sync/src/mirror.ts and ./tools/lib/cost.mjs, again app/sync/src/mirror.ts; not ../etc/passwd.md or a.ts"), [
    "app/sync/src/mirror.ts",
    "tools/lib/cost.mjs",
  ]);
});

test("mentions keeps commits that name an issue after it was opened", () => {
  const commits = [
    { sha: "a".repeat(40), at: "2026-10-05T00:00:00Z", subject: "fix(sync): keep dead rows (#460)", body: "" },
    { sha: "b".repeat(40), at: "2026-09-01T00:00:00Z", subject: "older work on #460", body: "" },
    { sha: "c".repeat(40), at: "2026-10-05T00:00:00Z", subject: "see abc#460 and #999", body: "" },
  ];
  const out = mentions(commits, [{ number: 460, createdAt: "2026-10-01T00:00:00Z" }]);
  assert.deepEqual(out.get(460), [{ sha: "aaaaaaaaa", subject: "fix(sync): keep dead rows (#460)" }]);
  assert.equal(out.has(999), false);
  const many = [
    { sha: "f".repeat(40), at: "2026-10-06T00:00:00Z", subject: "refs #460", body: "#460 again, #460, and #460" },
    { sha: "a".repeat(40), at: "2026-10-05T00:00:00Z", subject: "fix #460", body: "" },
  ];
  assert.deepEqual(mentions(many, [{ number: 460, createdAt: "2026-10-01T00:00:00Z" }]).get(460), [
    { sha: "fffffffff", subject: "refs #460" },
    { sha: "aaaaaaaaa", subject: "fix #460" },
  ], "one entry per commit, however often it names the issue");
});

test("parseLog reads git's record and unit separators", () => {
  const sha = "d".repeat(40);
  assert.deepEqual(parseLog(`${sha}\x1f2026-10-05T00:00:00+11:00\x1fsubject\x1fbody line\x1e\n`), [{ sha, at: "2026-10-05T00:00:00+11:00", subject: "subject", body: "body line" }]);
  assert.deepEqual(parseLog("garbage\x1e"), []);
});

test("parseVerdicts keeps asked issues and valid links, and an unsure fixed or duplicate stays open", () => {
  const asked = new Set([1, 2, 3, 4, 5, 6]);
  const open = new Set([1, 2, 3, 4, 5, 6, 7]);
  const v = parseVerdicts(
    {
      issues: [
        { n: 1, verdict: "fixed", sure: true, why: "Commit abc1234 fixes it" },
        { n: 2, verdict: "fixed", sure: false, why: "Not conclusive; treat as open" },
        { n: 3, verdict: "duplicate", sure: true, of: 7, why: "Same ask as #7" },
        { n: 4, verdict: "duplicate", sure: true, of: 4, why: "itself" },
        { n: 5, verdict: "group", of: 99, why: "closed partner" },
        { n: 6, verdict: "close it now", why: "x" },
        { n: 8, verdict: "fixed", sure: true, why: "never asked" },
      ],
    },
    asked,
    open,
  );
  assert.deepEqual(Object.fromEntries(v), {
    1: { verdict: "fixed", of: null, why: "Commit abc1234 fixes it" },
    2: { verdict: "open", of: null, why: "Not conclusive; treat as open" },
    3: { verdict: "duplicate", of: 7, why: "Same ask as #7" },
  });
});

test("clusters joins group links into sets, largest first", () => {
  const v = new Map([
    [5, { verdict: "group", of: 3 }],
    [3, { verdict: "group", of: 1 }],
    [9, { verdict: "group", of: 8 }],
    [4, { verdict: "duplicate", of: 2 }],
  ]);
  assert.deepEqual(clusters(v), [[1, 3, 5], [8, 9]]);
});

test("recheckPass redacts what it sends, writes the dated report and closes nothing", async () => {
  const dir = tmp();
  const prompts = [];
  const ghCalls = [];
  const issues = [
    { number: 10, title: "Sync drops a row", body: `In app/sync/src/mirror.ts (token ${TOKEN})`, labels: [{ name: "bug" }], createdAt: "2026-10-01T00:00:00Z" },
    { number: 11, title: "Same sync row drop", body: "dup", labels: [], createdAt: "2026-10-02T00:00:00Z" },
  ];
  const sha = "e".repeat(40);
  const result = await recheckPass({
    gh: async (args) => {
      ghCalls.push(args);
      return JSON.stringify(issues);
    },
    git: async (args) => {
      if (args[0] === "rev-parse") return `${sha}\n`;
      if (args[0] === "log" && args.includes("--")) return "";
      if (args[0] === "log") return `${sha}\x1f2026-10-03T00:00:00Z\x1ffix(sync): keep the row (#10)\x1f\x1e`;
      return "";
    },
    run: async (input) => {
      prompts.push(input);
      const result = JSON.stringify({ issues: [{ n: 10, verdict: "fixed", sure: true, why: "Commit eeeeeeeee names it" }, { n: 11, verdict: "duplicate", sure: true, of: 10, why: "Same drop" }] });
      return JSON.stringify({ is_error: false, result, usage: { input_tokens: 2000, output_tokens: 80 } });
    },
    spend: new Spend("issue-recheck", 2, { dir: path.join(dir, "spend") }),
    now: () => new Date("2026-10-08T12:30:00Z"),
    log: () => {},
    dir,
  });
  assert.equal(prompts.length, 1);
  assert.ok(!prompts[0].includes(TOKEN), "redacted before it is sent");
  assert.match(prompts[0], /commit eeeeeeeee names it: fix\(sync\): keep the row \(#10\)/);
  assert.match(prompts[0], /app\/sync\/src\/mirror\.ts: unchanged since it was opened/);
  assert.equal(path.basename(result.file), `issue-recheck-${zoneDay(new Date("2026-10-08T12:30:00Z"))}.md`);
  const md = fs.readFileSync(result.file, "utf8");
  assert.match(md, /## Likely already fixed\n\n- #10 Sync drops a row — Commit eeeeeeeee names it/);
  assert.match(md, /#11 Same sync row drop → duplicate of #10/);
  assert.deepEqual(ghCalls.map((a) => a.slice(0, 2)), [["issue", "list"]], "reads issues only");
});

test("batchPrompt fences each issue and lists the numbers to answer", () => {
  const p = batchPrompt([{ number: 3, title: "T", body: "B", labels: [], createdAt: "2026-10-01T00:00:00Z", evidence: [] }], "#3: T");
  assert.match(p, /--- Issue #3: T\nOpened: 2026-10-01; labels: none/);
  assert.match(p, /\(none found\)/);
  assert.match(p, /one entry for each of: #3\.$/);
});

test("report says how many were not checked and why", () => {
  const md = report({ date: "2026-10-08", head: "f".repeat(40), issues: [{ number: 1, title: "A" }, { number: 2, title: "B" }], verdicts: new Map(), unchecked: 2, usd: 2, capped: true });
  assert.match(md, /not checked: 2 \(daily spend ceiling reached\)/);
  assert.match(md, /## Likely already fixed\n\nNone\./);
});

test("recheckPass stops at the ceiling: nothing read at its start, no report once reached", async () => {
  const dir = tmp();
  const calls = [];
  const issues = Array.from({ length: 30 }, (_, i) => ({ number: i + 1, title: `Issue ${i + 1}`, body: "", labels: [], createdAt: "2026-10-01T00:00:00Z" }));
  const base = {
    gh: async (args) => void calls.push(args) || JSON.stringify(issues),
    git: async (args) => void calls.push(args) || (args[0] === "rev-parse" ? `${"e".repeat(40)}\n` : ""),
    run: async () => JSON.stringify({ is_error: false, result: '{"issues": []}', usage: { input_tokens: 900000, output_tokens: 40 } }),
    now: () => new Date("2026-10-08T12:30:00Z"),
    log: () => {},
    dir,
  };
  const atStart = await recheckPass({ ...base, spend: new Spend("capped", 0, { dir: path.join(dir, "spend") }) });
  assert.equal(atStart.capped, true);
  assert.equal(calls.length, 0, "no reads at all");
  const reached = await recheckPass({ ...base, spend: new Spend("issue-recheck", 0.5, { dir: path.join(dir, "spend") }) });
  assert.equal(reached.capped, true);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".md")), [], "no report");
});

test("recheckPass reads one pinned commit, leaves FETCH_HEAD alone and redacts labels", async () => {
  const dir = tmp();
  const prompts = [];
  const gitCalls = [];
  const sha = "c".repeat(40);
  const issues = [{ number: 14, title: "T", body: "See app/sync/src/mirror.ts", labels: [{ name: `bug ${TOKEN}` }], createdAt: "2026-10-01T00:00:00Z" }];
  const result = await recheckPass({
    gh: async () => JSON.stringify(issues),
    git: async (args) => {
      gitCalls.push(args);
      return args[0] === "rev-parse" ? `${sha}\n` : "";
    },
    run: async (input) => {
      prompts.push(input);
      return JSON.stringify({ is_error: false, result: '{"issues": []}', usage: { input_tokens: 500, output_tokens: 20 } });
    },
    spend: new Spend("issue-recheck", 2, { dir: path.join(dir, "spend") }),
    now: () => new Date("2026-10-08T12:30:00Z"),
    log: () => {},
    dir,
  });
  assert.deepEqual(gitCalls[0], ["fetch", "--quiet", "--no-write-fetch-head", "origin"]);
  assert.deepEqual(gitCalls.slice(2).map((a) => a.find((x) => x.startsWith(sha) || x === "origin/HEAD")), [sha, `${sha}:app/sync/src/mirror.ts`, sha]);
  assert.deepEqual(gitCalls[3].slice(0, 3), ["rev-parse", "--verify", "--quiet"], "a path is looked up in the trees, never read");
  assert.ok(!prompts[0].includes(TOKEN), "label redacted before it is sent");
  assert.equal((fs.statSync(result.file).mode & 0o777).toString(8), "600");
});

test("recheckPass reads the last fetched main when the fetch fails, and redacts titles in the index", async () => {
  const dir = tmp();
  const prompts = [];
  const events = [];
  const issues = [{ number: 12, title: `Leaked ${TOKEN} in a title`, body: "", labels: [], createdAt: "2026-10-01T00:00:00Z" }];
  const result = await recheckPass({
    gh: async () => JSON.stringify(issues),
    git: async (args) => {
      if (args[0] === "fetch") throw new Error("cannot lock ref 'refs/remotes/origin/main'");
      return args[0] === "rev-parse" ? `${"e".repeat(40)}\n` : "";
    },
    run: async (input) => {
      prompts.push(input);
      return JSON.stringify({ is_error: false, result: '{"issues": [{"n": 12, "verdict": "open", "why": ""}]}', usage: { input_tokens: 500, output_tokens: 20 } });
    },
    spend: new Spend("issue-recheck", 2, { dir: path.join(dir, "spend") }),
    now: () => new Date("2026-10-08T12:30:00Z"),
    log: (event) => events.push(event),
    dir,
  });
  assert.ok(events.includes("issue-recheck-fetch-failed"));
  assert.equal(prompts.length, 1);
  assert.ok(!prompts[0].includes(TOKEN), "title redacted before it is sent");
  assert.ok(!fs.readFileSync(result.file, "utf8").includes(TOKEN));
});

test("a commit subject is redacted before it is cut, so a token past the cut leaves no head", () => {
  const subject = `Fix #7 ${"x ".repeat(52)}${TOKEN}`;
  const found = mentions([{ sha: "a".repeat(40), at: "2026-10-02T00:00:00Z", subject, body: "" }], [{ number: 7, createdAt: "2026-10-01T00:00:00Z" }]);
  const said = JSON.stringify([...found.values()]);
  assert.ok(found.get(7)?.length === 1 && !said.includes(TOKEN.slice(0, 4)), said);
});
