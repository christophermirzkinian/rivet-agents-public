import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Spend } from "../lib.mjs";
import { ExecError } from "../../bridge/lib/config.mjs";
import { redactLog } from "../lib.mjs";
import { opsStatusKey } from "../../bridge/lib/ops-status.mjs";
import { BY, MARKER, commentBody, evidenceAt, parseLabel, readable, savedItems, statusNote, triagePass, trimLog, upsertComment } from "../ci-triage.mjs";

const REPO = "example-org/example-repo";
const HEAD = "a".repeat(40);
const TOKEN = `${"gh"}p_${"Q1w2E3r4T5".repeat(4)}`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ci-triage-"));

test("trimLog keeps the lines around the first real error, without timestamps or colour", () => {
  const log = [
    ...Array.from({ length: 400 }, (_, i) => `2026-10-08T00:00:00.0000000Z noise ${i}`),
    "2026-10-08T00:00:01.0000000Z \x1b[31mFAIL test/a.test.ts > adds\x1b[0m",
    "2026-10-08T00:00:01.0000000Z ##[error]AssertionError: expected 2 to be 3",
    "2026-10-08T00:00:02.0000000Z ##[error]Process completed with exit code 1.",
  ].join("\n");
  const out = trimLog(log);
  assert.match(out, /FAIL test\/a\.test\.ts > adds\n##\[error\]AssertionError/);
  assert.ok(!out.includes("noise 100") && !out.includes("\x1b[") && !/^2026-/m.test(out));
});

test("parseLabel accepts the three labels only and a one-line cause", () => {
  assert.deepEqual(parseLabel({ label: "Flaky", cause: "Port 5173\nin use" }), { label: "flaky", cause: "Port 5173 in use" });
  assert.throws(() => parseLabel({ label: "merge it", cause: "x" }));
  assert.throws(() => parseLabel({ label: "real", cause: "" }));
});

test("commentBody starts with the marker and keeps log text inside code spans", () => {
  const body = commentBody(HEAD, [
    { name: "Repo gates", label: "infra", cause: "Runner lost." },
    { name: "Unit tests", label: "flaky", cause: "Timed out." },
  ]);
  assert.ok(body.startsWith(`${MARKER}\n`));
  assert.match(body, /`Repo gates`: \*\*infra\*\*/);
  assert.match(body, /`Unit tests`: \*\*flaky\*\*/);
  assert.ok(!/claude|haiku|anthropic|generated/i.test(body), "no tool attribution");
  assert.match(statusNote(HEAD, [{ name: "A", label: "real", cause: "Broke." }]), /^CI triage of aaaaaaaaa: A: real failure\. Broke\.$/);
  const hostile = commentBody(HEAD, [{ name: "Gates`, @team", label: "real", cause: "ping @owner, see [x](https://e.vil) `rm`" }]);
  assert.ok(hostile.includes("`Gates', @team`") && hostile.includes("`ping @owner, see [x](https://e.vil) 'rm'`"), "log text stays inside code spans");
});

test("upsertComment never comments once the head has self-review evidence, and edits its own comment in place", async () => {
  const calls = [];
  const open = JSON.stringify({ state: "open", head: { sha: HEAD } });
  // A write's JSON body comes on stdin (`--input -`), kept on its args as `.body`.
  const gh = (comments, pr = open) => async (args, input) => {
    calls.push(Object.assign(args, { body: input === undefined ? undefined : JSON.parse(input).body }));
    if (args.includes("user")) return JSON.stringify({ login: "me" });
    if (args.includes("--paginate")) return JSON.stringify([comments]);
    if (args.at(-1) === `repos/${REPO}/pulls/7`) return pr;
    return "{}";
  };
  const log = () => {};
  const evidence = [{ id: 1, user: { login: "me" }, body: `Self-review (tier: high)\nReviewed head: \`${HEAD}\`` }];
  assert.equal(await upsertComment({ gh: gh(evidence), repo: REPO, pr: 7, head: HEAD, body: `${MARKER}\nx`, log }), "skipped");
  assert.equal(calls.some((a) => a.includes("POST") || a.includes("PATCH")), false);
  const mine = [{ id: 9, user: { login: "me" }, body: `${MARKER}\nold` }, { id: 10, user: { login: "other" }, body: `${MARKER}\nnot mine` }];
  assert.equal(await upsertComment({ gh: gh(mine), repo: REPO, pr: 7, head: HEAD, body: `${MARKER}\nnew`, log }), "edited");
  assert.ok(calls.some((a) => a.includes("PATCH") && a.includes(`repos/${REPO}/issues/comments/9`)));
  assert.equal(await upsertComment({ gh: gh([]), repo: REPO, pr: 7, head: HEAD, body: `${MARKER}\nnew`, log }), "posted");
  assert.equal(await upsertComment({ gh: gh([]), repo: REPO, pr: 7, head: HEAD, body: null, log }), "none");

  // A comment never reads as a merge hold: a line quoting hold wording from a log or answer is left out.
  calls.length = 0;
  assert.equal(await upsertComment({ gh: gh([]), repo: REPO, pr: 7, head: HEAD, body: `${MARKER}\n- unit: real, log says "do not merge until fixed"\n- e2e: flaky`, log }), "posted");
  const sent = calls.find((a) => a.includes("POST"));
  assert.deepEqual(sent.slice(-2), ["--input", "-"], "the body is on stdin, not in gh's arguments");
  assert.equal(sent.body, `${MARKER}\n- e2e: flaky`);

  // Evidence that lands while the comment is written: the comment is deleted, so nothing follows the evidence.
  let lists = 0;
  const racing = async (args) => {
    calls.push(args);
    if (args.includes("user")) return JSON.stringify({ login: "me" });
    if (args.includes("--paginate")) return JSON.stringify([lists++ ? [...evidence, { id: 77, user: { login: "me" }, body: `${MARKER}\nnew` }] : []]);
    if (args.at(-1) === `repos/${REPO}/pulls/7`) return open;
    if (args.includes("POST")) return JSON.stringify({ id: 77 });
    return "{}";
  };
  calls.length = 0;
  assert.equal(await upsertComment({ gh: racing, repo: REPO, pr: 7, head: HEAD, body: `${MARKER}\nnew`, log }), "withdrawn");
  assert.ok(calls.some((a) => a.includes("DELETE") && a.includes(`repos/${REPO}/issues/comments/77`)));

  // The PR moved on: nothing is written for the old head, and evidence for the new head counts too.
  calls.length = 0;
  const moved = JSON.stringify({ state: "open", head: { sha: "c".repeat(40) } });
  assert.equal(await upsertComment({ gh: gh([], moved), repo: REPO, pr: 7, head: HEAD, body: `${MARKER}\nnew`, log }), "stale");
  assert.equal(await upsertComment({ gh: gh([], JSON.stringify({ state: "closed", head: { sha: HEAD } })), repo: REPO, pr: 7, head: HEAD, body: `${MARKER}\nnew`, log }), "stale");
  const newer = [{ id: 2, user: { login: "me" }, created_at: "2026-10-08T01:00:00Z", body: `Self-review (tier: high)\nReviewed head: \`${"c".repeat(40)}\`` }];
  assert.equal(await upsertComment({ gh: gh(newer, moved), repo: REPO, pr: 7, head: HEAD, body: `${MARKER}\nnew`, log }), "skipped");
  assert.equal(calls.some((a) => a.includes("POST") || a.includes("PATCH")), false);

  // A withdrawal that failed is retried: ours written at or after the evidence is deleted on the next attempt.
  calls.length = 0;
  const late = [
    { id: 3, user: { login: "me" }, created_at: "2026-10-08T01:00:00Z", body: `Self-review (tier: high)\nreviewed  HEAD:${HEAD}` },
    { id: 4, user: { login: "me" }, created_at: "2026-10-08T00:30:00Z", updated_at: "2026-10-08T01:00:05Z", body: `${MARKER}\nold` },
    { id: 5, user: { login: "me" }, created_at: "2026-10-08T00:10:00Z", updated_at: "2026-10-08T00:10:00Z", body: `${MARKER}\nolder` },
  ];
  assert.equal(await upsertComment({ gh: gh(late), repo: REPO, pr: 7, head: HEAD, body: `${MARKER}\nnew`, log }), "withdrawn", "a deletion is read back next poll");
  assert.deepEqual(calls.filter((a) => a.includes("DELETE")).map((a) => a.at(-1)), [`repos/${REPO}/issues/comments/4`]);

  // Nothing left to say on a closed PR (its item expired): ours still goes, before the evidence too.
  for (const comments of [mine, [{ ...mine[0], created_at: "2026-10-08T00:00:00Z" }, ...late.slice(0, 1)]]) {
    calls.length = 0;
    assert.equal(await upsertComment({ gh: gh(comments, JSON.stringify({ state: "closed", head: { sha: HEAD } })), repo: REPO, pr: 7, head: HEAD, body: null, log }), "deleted");
    assert.deepEqual(calls.filter((a) => a.includes("DELETE")).map((a) => a.at(-1)), [`repos/${REPO}/issues/comments/9`]);
  }
});

test("evidenceAt reads the evidence line the way the merge gate does", () => {
  const at = (body) => evidenceAt([{ body, created_at: "t" }], [HEAD]);
  for (const line of [`Reviewed head: \`${HEAD}\``, `reviewed head:${HEAD}`, `REVIEWED   HEAD :  \`${HEAD.toUpperCase()}\``, `x\nReviewed head: ${HEAD}  `]) assert.equal(at(`Self-review (tier: high)\n${line}`), "t", line);
  assert.equal(at(`Reviewed head: \`${"b".repeat(40)}\``), null);
  assert.equal(at(`see Reviewed head: \`${HEAD}\``), null);
  assert.equal(evidenceAt([{ body: `Reviewed head: ${HEAD}`, created_at: "2" }, { body: `Reviewed head: ${HEAD}`, created_at: "1" }], [HEAD]), "1");
});

/**
 * Lets a fake GitHub that answers plain and `--paginate --slurp` reads answer `gh api -i` conditional reads too: the
 * first page with a weak ETag of it, a Link to the next page when one has items, and gh's 304 (exit 1, headers on
 * stdout) when If-None-Match matches, as GitHub answers a first page that has a next one too. `reads` collects each conditional read's path and the ETag it sent.
 */
function conditional(inner, reads = []) {
  return async (args, input) => {
    if (!args.includes("-i")) return inner(args, input);
    const p = args.find((a) => a.startsWith("repos/"));
    const h = args.indexOf("-H");
    const sent = h < 0 ? null : args[h + 1].slice("If-None-Match: ".length);
    reads.push({ p, sent });
    const all = JSON.parse(await inner(["api", "--paginate", "--slurp", p]));
    const first = Array.isArray(all) ? all[0] : all;
    const more = Array.isArray(all) && all.slice(1).some((pg) => (Array.isArray(pg) ? pg.length : pg.workflow_runs?.length));
    const etag = `W/"${createHash("sha1").update(JSON.stringify(first)).digest("hex").slice(0, 12)}"`;
    if (sent === etag) throw new ExecError("/bin/gh", { code: 1 }, "gh: HTTP 304", `HTTP/2.0 304 Not Modified\r\nEtag: ${etag}\r\n\r\n`);
    return `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nEtag: ${etag}\r\n${more ? 'Link: <https://api.github.com/x?page=2>; rel="next"\r\n' : ""}\r\n${JSON.stringify(first)}`;
  };
}

test("triagePass labels each failed job once, sets a backlog status only where nobody else has one, and comments", async () => {
  const dir = tmp();
  const prompts = [];
  const rivetCalls = [];
  const posted = [];
  const run = { id: 11, name: "CI", event: "pull_request", head_branch: "feature", head_sha: HEAD, run_attempt: 1, status: "completed", conclusion: "failure", pull_requests: [{ number: 42 }] };
  const mainRun = { id: 12, name: "CI", event: "push", head_branch: "main", head_sha: "b".repeat(40), run_attempt: 1, status: "completed", conclusion: "failure", pull_requests: [] };
  const jobs = {
    11: [
      { id: 101, name: "Repo gates", conclusion: "failure", runner_name: "runner-1", steps: [{ name: "Lint", conclusion: "failure" }] },
      { id: 103, name: "Docs", conclusion: "success" },
    ],
    12: [{ id: 201, name: "Build", conclusion: "failure", steps: [] }],
  };
  const gh = conditional(async (args, input) => {
    const p = args.find((a) => a.startsWith("repos/")) ?? args[1];
    if (p.includes("/pulls?state=open")) return JSON.stringify([[{ number: 42, state: "open", head: { sha: HEAD } }]]);
    if (p.includes("actions/runs?head_sha=")) return JSON.stringify([{ workflow_runs: [run] }]);
    if (p.includes("actions/runs?branch=main")) return JSON.stringify({ workflow_runs: [mainRun] });
    if (p.endsWith("/pulls/42")) return JSON.stringify({ number: 42, state: "open", head: { sha: HEAD } });
    const j = /runs\/(\d+)\/attempts/.exec(p);
    if (j) return JSON.stringify({ jobs: jobs[j[1]] });
    if (p.endsWith("/jobs/101/logs")) return `##[error]eslint: 'x' is unused\nexport GH_TOKEN=${TOKEN}`;
    if (p.endsWith("/jobs/201/logs")) return "##[error]build failed";
    // The PR's comments are the ones posted here.
    if (args.includes("--paginate")) return JSON.stringify([posted.map((a, i) => ({ id: i + 1, user: { login: "me" }, body: a.body }))]);
    if (args[1] === "user") return JSON.stringify({ login: "me" });
    if (args.includes("POST")) return void posted.push(Object.assign(args, { body: JSON.parse(input).body })), "{}";
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  const rivet = async (args) => {
    rivetCalls.push(args);
    if (args[1] === "list") return JSON.stringify({ statuses: [{ kind: "ci", key: "ci_x", by: "someone", state: "investigating" }] });
    return "";
  };
  const deps = {
    gh,
    rivet,
    run: async (input) => {
      prompts.push(input);
      return JSON.stringify({ is_error: false, result: '{"label": "real", "cause": "eslint: x is unused"}', usage: { input_tokens: 900, output_tokens: 40 } });
    },
    spend: new Spend("ci-triage", 1, { dir: path.join(dir, "spend") }),
    now: () => Date.parse("2026-10-08T00:00:00Z"),
    log: () => {},
    stateFile: path.join(dir, "state.json"),
    resultsFile: path.join(dir, "results.jsonl"),
    repo: REPO,
  };
  const first = await triagePass(deps);
  assert.deepEqual(first.rows.map((r) => [r.job, r.label]), [[101, "real"], [201, "real"]]);
  assert.equal(prompts.length, 2);
  assert.ok(!prompts[0].includes(TOKEN), "redacted before it is sent");
  const sets = rivetCalls.filter((a) => a[1] === "set");
  assert.equal(sets.length, 2);
  assert.deepEqual(sets[0].slice(0, 6), ["status", "set", "pr", opsStatusKey("pr", "42", REPO), "--state", "backlog"]);
  assert.equal(sets[0][sets[0].indexOf("--by") + 1], BY);
  assert.equal(sets[1][2], "ci");
  for (const set of sets) assert.equal(set[set.indexOf("--if-match") + 1], "0", "a status nobody has is only created");
  assert.equal(posted.length, 1);
  assert.ok(posted[0].includes(`repos/${REPO}/issues/42/comments`));
  assert.equal(fs.readFileSync(deps.resultsFile, "utf8").trim().split("\n").length, 2);

  // The next poll sees the same runs: nothing is asked, set or posted again, and the comment is read back once.
  rivetCalls.length = 0;
  const again = await triagePass(deps);
  assert.equal(again.rows.length, 0);
  assert.equal(prompts.length, 2);
  assert.deepEqual(rivetCalls.map((a) => a[1]), ["list"]);
  assert.equal(posted.length, 1);
  rivetCalls.length = 0;
  await triagePass(deps);
  assert.equal(rivetCalls.length, 0);
});

test("triagePass leaves another writer's status alone", async () => {
  const dir = tmp();
  const rivetCalls = [];
  const mainRun = { id: 12, name: "CI", event: "push", head_branch: "main", head_sha: "b".repeat(40), run_attempt: 1, status: "completed", conclusion: "failure", pull_requests: [] };
  await triagePass({
    gh: conditional(async (args) => {
      const p = args.find((a) => a.startsWith("repos/"));
      if (p.includes("/pulls?state=open")) return JSON.stringify([[]]);
      if (p.includes("actions/runs?")) return JSON.stringify({ workflow_runs: [mainRun] });
      if (p.includes("/attempts/")) return JSON.stringify({ jobs: [{ id: 301, name: "Build", conclusion: "failure" }] });
      return "##[error]build failed";
    }),
    rivet: async (args) => {
      rivetCalls.push(args);
      return JSON.stringify({ statuses: [{ kind: "ci", key: opsStatusKey("ci", "CI", REPO), by: "fix-ci-chat", state: "investigating" }] });
    },
    run: async () => JSON.stringify({ is_error: false, result: '{"label": "real", "cause": "Build failed."}', usage: { input_tokens: 90, output_tokens: 10 } }),
    spend: new Spend("ci-triage", 1, { dir: path.join(dir, "spend") }),
    now: () => Date.now(),
    log: () => {},
    stateFile: path.join(dir, "state.json"),
    resultsFile: path.join(dir, "results.jsonl"),
    repo: REPO,
  });
  assert.deepEqual(rivetCalls.map((a) => a[1]), ["list"]);
});

test("trimLog redacts the whole log line by line before cutting the window", () => {
  const log = [
    "\uFEFF2026-10-08T00:00:00.0Z Runner name: 'grfjv833tqcy3k4vkaayyc7hvj'",
    "2026-10-08T00:00:00.1Z   GITHUB_TOKEN: ***",
    `2026-10-08T00:00:00.15Z   password: "correct horse battery staple"`,
    `2026-10-08T00:00:00.16Z pushing with ${TOKEN} now`,
    "2026-10-08T00:00:00.18Z {password: correct horse battery staple}",
    ...Array.from({ length: 10 }, (_, i) => `2026-10-08T00:00:00.19Z step ${i}`),
    "2026-10-08T00:00:00.2Z ✖ settles a round",
    "2026-10-08T00:00:00.3Z ##[error]AssertionError: expected 1 to equal 2",
  ].join("\n");
  const out = trimLog(log);
  assert.match(out, /settles a round\n##\[error\]AssertionError/, "a runner name or masked line does not blank the log");
  for (const leak of ["grfjv833", "horse", "battery", "staple", TOKEN, "now"]) assert.ok(!out.includes(leak), `${leak} is gone with its line`);
  assert.deepEqual(redactLog(["  indented line", "\tand a tab"]).split("\n"), ["  indented line", " and a tab"], "trimmed whitespace is not a change");
  // A secret over lines (a block value) cannot be followed through interleaved output: the rest of the log goes.
  for (const between of [[], ["client test: ok"]]) {
    const block = redactLog(["step 1", "server test: credentials: |", ...Array(12).fill("server test:   alpha"), ...between, "server test:   correct horse battery staple", "##[error]boom"]);
    assert.deepEqual(block.split("\n").filter((l) => l !== "[redacted]"), ["step 1"]);
  }
  // So is the log after a secret key's plain value, which YAML lets go on below it, however the lines interleave.
  for (const lines of [
    ["password: correct horse", ...Array(10).fill("  alpha"), "  battery staple", "##[error]boom"],
    ["  password: correct horse", "", "    battery staple", ...Array(12).fill("x"), "##[error]boom"],
    ["server test: password: correct horse", "client test: ok", ...Array(12).fill("server test:   alpha"), "server test:   battery staple", "##[error]boom"],
    ["server test: password: correct horse", "client test: token: masked", "client test: ok", ...Array(12).fill("server test:   alpha"), "server test:   battery staple", "##[error]boom"],
    ["pass\u009b32mword: correct horse", ...Array(12).fill("  alpha"), "  battery staple", "##[error]boom"],
    ["{", '"password":correct horse', ...Array(12).fill("  alpha"), "  battery staple", "}", "##[error]boom"],
    ["{password: correct horse", "battery staple}", ...Array(12).fill("step"), "##[error]boom"],
    ["credentials:\r  correct horse", "client test: ok", ...Array(12).fill("  alpha"), "  battery staple", "##[error]boom"],
    ["server test: password: correct horse", "server test:unit: ok", ...Array(12).fill("server test:   alpha"), "server test:   battery staple", "##[error]boom"],
    // A boolean or number folds into the lines below it outside a step's header, a compound PASS name is a key, and
    // parentheses do not end a YAML value.
    ["server test: password: true", ...Array(10).fill("client test: ok"), "server test:   battery staple", "##[error]boom"],
    ["server test: DB_PASS: correct horse", ...Array(10).fill("client test: ok"), "server test:   battery staple", "##[error]boom"],
    ["server test: (password: correct horse)", ...Array(10).fill("client test: ok"), "server test:   battery staple)", "##[error]boom"],
    // A quoted key is a key whatever its name, a mask covers only a value it covers whole, and a header value that
    // looked whole is followed by the next key.
    ['"pass": correct horse', ...Array(10).fill("  alpha"), "  battery staple", "##[error]boom"],
    ["password: Bearer *** suffix", ...Array(10).fill("  alpha"), "  battery staple", "##[error]boom"],
  ]) {
    const out = redactLog(lines).split("\n");
    assert.deepEqual(out.slice(out.indexOf("[redacted]")).filter((l) => l !== "[redacted]"), [], lines.join(" | ").slice(0, 60));
  }
  // A step's header echoes inputs verbatim, a value over any lines: it is dropped whole, and the step's output kept.
  for (const value of [["true", "  endpoint: local"], ["***"], ["correct horse"]]) {
    const out = redactLog(["##[group]Run example/action@v1", "with:", `  password: ${value[0]}`, ...value.slice(1), ...Array(10).fill("  alpha"), "  correct horse battery staple", "##[endgroup]", "step output", "##[error]boom"]);
    assert.ok(!/alpha|endpoint|horse|battery/.test(out), value[0]);
    assert.deepEqual(out.split("\n").slice(-3), ["##[endgroup]", "step output", "##[error]boom"], value[0]);
  }
  // A secret key whose value ends on its line costs only the lines held after it, and so does a word that is no key.
  for (const lines of [
    ["##[group]Run actions/checkout@v4", "with:", "  token: ***", "  persist-credentials: true", "  fetch-depth: 0", "##[endgroup]", "   indented", ...Array(12).fill("x"), "##[error]boom"],
    ["env:", "  GH_TOKEN: ***", "##[endgroup]", "> test", "   indented", ...Array(12).fill("x"), "##[error]boom"],
    ["+ Received", "  {", '-   "sessionId": "abc",', '+   "sessionId": "abd",', "  }", ...Array(12).fill("x"), "##[error]boom"],
    ["UnauthorizedError: denied", "    at fetch (api.ts:43:1)", ...Array(12).fill("x"), "##[error]boom"],
    ["src/auth.ts:12:3 - error TS2322: no", "    12   const x = 1;", ...Array(12).fill("x"), "##[error]boom"],
    ["[command]/usr/bin/git config --local http.https://github.com/.extraheader AUTHORIZATION: basic ***", "   x", ...Array(12).fill("x"), "##[error]boom"],
    ["PASS: no rem/em font-size", "self-test passed: four fixtures flagged", "Author: Sam", "   indented", ...Array(12).fill("x"), "##[error]boom"],
    ["{ sessionId: 'abc', token: abc def }", "  session: 42", "   indented", ...Array(12).fill("x"), "##[error]boom"],
  ]) assert.equal(redactLog(lines).split("\n").at(-1), "##[error]boom", lines[1]);
  assert.equal(redactLog([`${os.homedir()}/x/y.ts:3 fails`, "/home/runner/work/a.ts fails"], os.homedir()), "~/x/y.ts:3 fails\n~/work/a.ts fails", "a home path is shortened, not dropped");
  const leaked = [["-----BEGIN", "OPENSSH", "PRIVATE", "KEY-----"].join(" "), ...Array.from({ length: 300 }, (_, i) => `b3BlbnNzaC1rZXktdjEAAAAA${i}`), "##[error]boom"].join("\n");
  const hidden = trimLog(leaked);
  assert.ok(!hidden.includes("b3BlbnNzaC1rZXkt"), "a key that starts above the window stays hidden");
  assert.equal(readable(hidden), false, "and a log with nothing left is not sent");
});

test("savedItems drops tampered jobs and items from the state file", () => {
  const items = savedItems({
    good: { head: HEAD, kind: "pr", key: "42", pr: 42, at: 1, jobs: { 1: { name: "Lint", label: "real", cause: `leak ${TOKEN}` }, 2: { name: "x", label: "pwned", cause: "y" } } },
    bad: { head: "nothex", kind: "pr", key: "1", at: 1, jobs: {} },
    far: { head: HEAD, kind: "ci", key: "k", at: 1e20, jobs: {} },
  });
  assert.deepEqual(Object.keys(items), ["good"]);
  assert.deepEqual(Object.keys(items.good.jobs), ["1"]);
  assert.ok(!items.good.jobs[1].cause.includes(TOKEN));
});

test("triagePass stops at the ceiling: nothing read at its start, nothing written once reached", async () => {
  const dir = tmp();
  const calls = [];
  const base = {
    gh: conditional(async (args) => {
      calls.push(["gh", ...args]);
      const p = args.find((a) => a.startsWith("repos/")) ?? "";
      if (p.includes("/pulls?state=open")) return JSON.stringify([[]]);
      if (p.includes("actions/runs?")) return JSON.stringify({ workflow_runs: [{ id: 12, name: "CI", event: "push", head_branch: "main", head_sha: "b".repeat(40), run_attempt: 1, status: "completed", conclusion: "failure" }] });
      if (p.includes("/attempts/")) return JSON.stringify({ jobs: [{ id: 5, name: "Lint", conclusion: "failure" }] });
      return "##[error]eslint failed";
    }),
    rivet: async (args) => void calls.push(["rivet", ...args]) || JSON.stringify({ statuses: [] }),
    run: async () => JSON.stringify({ is_error: false, result: '{"label": "real", "cause": "eslint"}', usage: { input_tokens: 900, output_tokens: 40 } }),
    now: () => Date.now(),
    log: () => {},
    stateFile: path.join(dir, "state.json"),
    resultsFile: path.join(dir, "results.jsonl"),
    repo: REPO,
  };
  const atStart = await triagePass({ ...base, spend: new Spend("capped", 0, { dir: path.join(dir, "spend") }) });
  assert.equal(atStart.capped, true);
  assert.equal(calls.length, 0, "no reads at all");
  const reached = await triagePass({ ...base, spend: new Spend("ci-triage", 0.00001, { dir: path.join(dir, "spend") }) });
  assert.equal(reached.capped, true);
  assert.equal(calls.filter((c) => c[0] === "rivet").length, 0, "no status");
  assert.ok(!fs.existsSync(base.resultsFile) && !fs.existsSync(base.stateFile), "no files");
});

const prRun = (id, created, jobs, more = {}) => ({ id, name: "CI", event: "pull_request", head_sha: HEAD, run_attempt: 1, status: "completed", conclusion: "failure", created_at: created, jobs, ...more });
const mainRun = (id, head, created, jobs, more = {}) => ({ id, name: "CI", event: "push", head_branch: "main", head_sha: head, run_attempt: 1, status: "completed", conclusion: "failure", created_at: created, jobs, ...more });

/** A fake GitHub of open `prs` and `runs` (each with `jobs`) for triagePass, listing in two pages where it paginates. */
function fakeRepo(runs, { prs = [{ number: 42, state: "open", head: { sha: HEAD } }], failLogs = new Set(), queries = [], comments = [], writes = [], reads = [], mainMore = false } = {}) {
  return conditional(async (args, input) => {
    const p = args.find((a) => a.startsWith("repos/")) ?? args[1];
    if (p.includes("/pulls?state=open")) return JSON.stringify([prs.slice(0, 1), prs.slice(1)]);
    if (p.includes("actions/runs?")) {
      queries.push(p);
      const sha = /head_sha=(\w+)/.exec(p)?.[1];
      const want = runs.filter((r) => (sha ? r.event === "pull_request" && r.head_sha === sha : r.event === "push" && r.head_branch === "main"));
      // mainMore: main's list has a next page, as it always has on GitHub.
      if (!sha && mainMore) return JSON.stringify([{ workflow_runs: want }, { workflow_runs: [mainRun(1, "c".repeat(40), "2026-10-01T00:00:00Z", [])] }]);
      return JSON.stringify(sha ? [{ workflow_runs: want.slice(0, 1) }, { workflow_runs: want.slice(1) }] : { workflow_runs: want });
    }
    const one = /\/pulls\/(\d+)$/.exec(p);
    if (one) return JSON.stringify(prs.find((x) => x.number === Number(one[1])) ?? {});
    const j = /runs\/(\d+)\/attempts\/(\d+)\/jobs/.exec(p);
    if (j) {
      queries.push(p);
      const jobs = runs.find((r) => r.id === Number(j[1]) && r.run_attempt === Number(j[2]))?.jobs ?? [];
      return JSON.stringify([{ jobs: jobs.slice(0, 1) }, { jobs: jobs.slice(1) }]);
    }
    const l = /jobs\/(\d+)\/logs$/.exec(p);
    if (l) {
      if (failLogs.has(Number(l[1]))) throw new Error("HTTP 404");
      return `##[error]job ${l[1]} broke`;
    }
    if (args.includes("--paginate")) return JSON.stringify([comments]);
    if (args[1] === "user") return JSON.stringify({ login: "me" });
    writes.push(Object.assign(args, { body: input === undefined ? undefined : JSON.parse(input).body }));
    return JSON.stringify({ id: 1 });
  }, reads);
}

function passDeps(dir, gh, over = {}) {
  let clock = Date.parse("2026-10-08T12:00:00Z");
  const asked = [];
  const statuses = [];
  return {
    asked,
    statuses,
    tick: (ms) => (clock += ms),
    deps: {
      gh,
      rivet: async (args) => {
        if (args[1] === "list") return JSON.stringify({ statuses: [] });
        statuses.push(args);
        return "";
      },
      run: async (input) => {
        asked.push(/Job: (.*)/.exec(input)?.[1]);
        return JSON.stringify({ is_error: false, result: '{"label": "real", "cause": "it broke"}', usage: { input_tokens: 900, output_tokens: 40 } });
      },
      spend: new Spend("ci-triage", 1, { dir: path.join(dir, "spend") }),
      now: () => clock,
      log: () => {},
      stateFile: path.join(dir, "state.json"),
      resultsFile: path.join(dir, "results.jsonl"),
      repo: REPO,
      ...over,
    },
  };
}

test("triagePass reads every run of each open PR's head and main's latest pushes, whatever their age, every page", async () => {
  const dir = tmp();
  const queries = [];
  const prs = [
    { number: 42, state: "open", head: { sha: HEAD } },
    { number: 43, state: "open", draft: true, head: { sha: "d".repeat(40) } },
  ];
  const runs = [
    prRun(2, "2026-10-08T11:00:00Z", [{ id: 21, name: "B", conclusion: "success" }, { id: 22, name: "C", conclusion: "timed_out" }]),
    // Created three days ago and re-run now: a re-run keeps its run's creation time.
    prRun(1, "2026-10-05T08:00:00Z", [{ id: 11, name: "A", conclusion: "failure" }], { run_attempt: 2 }),
    prRun(3, "2026-10-08T09:00:00Z", [{ id: 31, name: "D", conclusion: "timed_out" }], { conclusion: "timed_out" }),
    prRun(4, "2026-10-08T11:30:00Z", [{ id: 41, name: "E", conclusion: "failure" }], { status: "in_progress", conclusion: null }),
    prRun(5, "2026-10-08T11:40:00Z", [{ id: 51, name: "F", conclusion: "failure" }], { head_sha: "d".repeat(40) }),
    mainRun(6, "b".repeat(40), "2026-10-08T10:00:00Z", [{ id: 61, name: "G", conclusion: "failure" }]),
  ];
  const { deps, asked } = passDeps(dir, fakeRepo(runs, { prs, queries }));
  const first = await triagePass(deps);
  assert.deepEqual(first.rows.map((r) => r.job), [11, 31, 61, 22]);
  assert.deepEqual(asked, ["A", "D", "G", "C"]);
  assert.ok(!queries.some((q) => q.includes("d".repeat(40))), "a draft runs no CI and is not read");
  assert.ok(queries.every((q) => !q.includes("created=")), "no date window");
  // 50 jobs to a page: GitHub answers 502 at 100 on a large rerun run.
  const jobLists = queries.filter((q) => q.includes("/jobs?"));
  assert.ok(jobLists.length && jobLists.every((q) => q.endsWith("/jobs?per_page=50")), jobLists.join(" "));
  // The next poll reads the same runs and asks nothing again.
  assert.equal((await triagePass(deps)).rows.length, 0);
  assert.equal(asked.length, 4);
});

test("triagePass reads the open PRs and the run lists conditionally: a 304 serves the cached body, a 200 refreshes it", async () => {
  const dir = tmp();
  const reads = [];
  const failLogs = new Set([11]);
  const runs = [prRun(1, "2026-10-08T11:00:00Z", [{ id: 11, name: "A", conclusion: "failure" }])];
  const { deps, tick } = passDeps(dir, fakeRepo(runs, { failLogs, reads }));
  await triagePass(deps);
  assert.equal(reads.length, 3, "the open PRs, the head's runs, main's pushes");
  assert.ok(reads.every((r) => r.sent === null), "nothing cached yet");
  const etagsOf = () => JSON.parse(fs.readFileSync(deps.stateFile, "utf8")).etags;
  assert.deepEqual(Object.keys(etagsOf()).map((k) => k.replace(/^repos\/[^/]+\/[^/]+\//, "")), ["pulls?state=open&per_page=100", `actions/runs?head_sha=${HEAD}&event=pull_request&per_page=100`, "actions/runs?branch=main&event=push&per_page=30"]);

  // The unchanged lists answer 304 and the cached run is still seen: its job, whose log failed before, is read again.
  reads.length = 0;
  failLogs.clear();
  tick(60_000);
  assert.deepEqual((await triagePass(deps)).rows.map((r) => r.job), [11]);
  assert.equal(reads.length, 3);
  assert.ok(reads.every((r) => /^W\/"[0-9a-f]{12}"$/.test(r.sent)), "the weak ETag goes back as given");

  // A new push to main changes its list: that one answers 200 and the cache holds the new body, the others stay as they were.
  runs.push(mainRun(2, "b".repeat(40), "2026-10-08T11:05:00Z", [{ id: 21, name: "B", conclusion: "failure" }]));
  const before = etagsOf();
  tick(60_000);
  assert.deepEqual((await triagePass(deps)).rows.map((r) => r.job), [21]);
  const after = etagsOf();
  const mainPath = Object.keys(after).find((k) => k.includes("branch=main"));
  assert.notEqual(after[mainPath].etag, before[mainPath].etag);
  assert.deepEqual(after[mainPath].body.workflow_runs.map((r) => r.id), [2]);
  for (const k of Object.keys(after).filter((k) => k !== mainPath)) assert.equal(after[k].etag, before[k].etag);
});

test("main's push list is kept though it has a next page, since only its first page is read: the next pass sends its ETag", async () => {
  const dir = tmp();
  const reads = [];
  const runs = [prRun(1, "2026-10-08T11:00:00Z", [{ id: 11, name: "A", conclusion: "failure" }])];
  const { deps, tick } = passDeps(dir, fakeRepo(runs, { reads, mainMore: true }));
  await triagePass(deps);
  const main = (/** @type {{ p: string }} */ r) => r.p.includes("branch=main");
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(deps.stateFile, "utf8")).etags).some((k) => k.includes("branch=main")));
  reads.length = 0;
  tick(60_000);
  await triagePass(deps);
  assert.match(String(reads.find(main)?.sent), /^W\/"[0-9a-f]{12}"$/);
  assert.equal(reads.filter(main).length, 1, "never a read of the next page");
});

test("triagePass fails on a failed conditional read other than a 304, never serving the cache as fresh", async () => {
  const dir = tmp();
  const runs = [prRun(1, "2026-10-08T11:00:00Z", [{ id: 11, name: "A", conclusion: "failure" }])];
  const gh = fakeRepo(runs);
  let failure;
  const { deps, tick } = passDeps(dir, async (args) => {
    if (failure && args.includes("-i")) throw failure;
    return gh(args);
  });
  await triagePass(deps);
  const saved = fs.readFileSync(deps.stateFile, "utf8");
  for (const error of [
    new ExecError("/bin/gh", { code: 1 }, "gh: API rate limit exceeded (HTTP 403)", 'HTTP/2.0 403 Forbidden\r\nEtag: W/"x"\r\n\r\n'),
    new ExecError("/bin/gh", { code: 1 }, "gh: Get https://api.github.com: dial tcp: no route to host"),
    new Error("spawn gh ENOENT"),
  ]) {
    failure = error;
    tick(60_000);
    await assert.rejects(triagePass(deps), (err) => err === error);
    assert.equal(fs.readFileSync(deps.stateFile, "utf8"), saved, "a failed pass writes nothing");
  }
  // A 304 for a path with nothing cached is not a hit either.
  failure = new ExecError("/bin/gh", { code: 1 }, "gh: HTTP 304", "HTTP/2.0 304 Not Modified\r\n\r\n");
  fs.writeFileSync(deps.stateFile, JSON.stringify({ ...JSON.parse(saved), etags: {} }));
  await assert.rejects(triagePass(deps), (err) => err === failure);
});

test("triagePass keeps cached bodies only for the paths it asked for this pass", async () => {
  const dir = tmp();
  const other = "e".repeat(40);
  const prs = [{ number: 42, state: "open", head: { sha: HEAD } }, { number: 44, state: "open", head: { sha: other } }];
  const runs = [prRun(1, "2026-10-08T11:00:00Z", [], { conclusion: "success" })];
  const { deps, tick } = passDeps(dir, fakeRepo(runs, { prs }));
  const paths = () => Object.keys(JSON.parse(fs.readFileSync(deps.stateFile, "utf8")).etags);
  await triagePass(deps);
  assert.ok(paths().some((k) => k.includes(`head_sha=${other}`)));
  prs.pop();
  tick(60_000);
  await triagePass(deps);
  assert.equal(paths().length, 3);
  assert.ok(!paths().some((k) => k.includes(other)), "a closed PR's head is dropped");
});

test("triagePass reads a list past its first page in full and caches nothing for it", async () => {
  const dir = tmp();
  const reads = [];
  const failLogs = new Set([11, 21]);
  const runs = [
    prRun(1, "2026-10-08T11:00:00Z", [{ id: 11, name: "A", conclusion: "failure" }]),
    prRun(2, "2026-10-08T11:05:00Z", [{ id: 21, name: "B", conclusion: "failure" }]),
  ];
  const { deps, asked, tick } = passDeps(dir, fakeRepo(runs, { reads, failLogs }));
  await triagePass(deps);
  failLogs.clear();
  tick(60_000);
  await triagePass(deps);
  assert.deepEqual(asked.sort(), ["A", "B"], "the second page's run is seen");
  const state = JSON.parse(fs.readFileSync(deps.stateFile, "utf8"));
  assert.ok(!Object.keys(state.etags).some((k) => k.includes("head_sha=")), "the head's list has a next page: not cached");
  assert.equal(reads.filter((r) => r.p.includes("head_sha=") && r.sent).length, 0);
});

test("triagePass retries a job whose log failed, three times in all, and keeps its run open until then", async () => {
  const dir = tmp();
  const failLogs = new Set([11]);
  const runs = [mainRun(1, HEAD, "2026-10-08T11:00:00Z", [{ id: 11, name: "A", conclusion: "failure" }])];
  const { deps, asked, tick } = passDeps(dir, fakeRepo(runs, { failLogs, prs: [] }));
  await triagePass(deps);
  tick(60_000);
  await triagePass(deps);
  assert.deepEqual(asked, []);
  failLogs.clear();
  tick(60_000);
  assert.deepEqual((await triagePass(deps)).rows.map((r) => r.job), [11], "the third try reads it");
  failLogs.add(12);
  runs.push(mainRun(2, HEAD, "2026-10-08T11:01:00Z", [{ id: 12, name: "B", conclusion: "failure" }]));
  for (let i = 0; i < 4; i++) {
    tick(60_000);
    await triagePass(deps);
  }
  let state = JSON.parse(fs.readFileSync(deps.stateFile, "utf8"));
  const key = (/** @type {Record<string, unknown>} */ o, /** @type {string} */ end) => Object.keys(o).some((k) => k.endsWith(end));
  assert.ok(key(state.seen, "|12") && key(state.done, "|2:1") && !key(state.tries, "|12"), "given up after three tries");
  // A try left behind by a job never visited again expires with the rest of the state.
  failLogs.add(13);
  runs.push(mainRun(3, HEAD, "2026-10-08T11:02:00Z", [{ id: 13, name: "C", conclusion: "failure" }]));
  tick(60_000);
  await triagePass(deps);
  runs.pop();
  tick(8 * 86_400_000);
  await triagePass(deps);
  state = JSON.parse(fs.readFileSync(deps.stateFile, "utf8"));
  assert.deepEqual(state.tries, {});
});

test("transient GitHub log failures never mark a job seen; recovery still classifies it", async () => {
  const dir = tmp();
  const runs = [mainRun(1, HEAD, "2026-10-08T11:00:00Z", [{ id: 11, name: "A", conclusion: "failure" }])];
  const gh = fakeRepo(runs, { prs: [] });
  let failure;
  const { deps, asked, tick } = passDeps(dir, async (args) => {
    if (failure && args.some((a) => a.endsWith("/logs"))) throw failure;
    return gh(args);
  });
  for (const error of [
    new ExecError("/bin/gh", { code: 1 }, "gh: HTTP 502"),
    new ExecError("/bin/gh", { code: 1 }, "gh: API rate limit exceeded (HTTP 403)"),
    new ExecError("/bin/gh", { killed: true }, ""),
  ]) {
    failure = error;
    for (let i = 0; i < 5; i++) {
      await triagePass(deps);
      tick(300_000);
      const state = JSON.parse(fs.readFileSync(deps.stateFile, "utf8"));
      assert.deepEqual(state.seen, {});
      assert.deepEqual(state.done, {});
      assert.deepEqual(state.tries, {});
    }
  }
  assert.deepEqual(asked, []);
  failure = undefined;
  assert.deepEqual((await triagePass(deps)).rows.map((r) => r.job), [11]);
  assert.equal(asked.length, 1);
});

test("triagePass keeps main's item on its newest head when an older run is labelled late", async () => {
  const dir = tmp();
  const failLogs = new Set([11]);
  const runs = [
    mainRun(1, "a".repeat(40), "2026-10-08T10:00:00Z", [{ id: 11, name: "Old", conclusion: "failure" }]),
    mainRun(2, "b".repeat(40), "2026-10-08T11:00:00Z", [{ id: 21, name: "New", conclusion: "failure" }]),
  ];
  const { deps, statuses, tick } = passDeps(dir, fakeRepo(runs, { failLogs, prs: [] }));
  await triagePass(deps);
  failLogs.clear();
  tick(60_000);
  const second = await triagePass(deps);
  assert.deepEqual(second.rows.map((r) => r.job), [11], "the late label is still recorded");
  assert.equal(Object.values(second.items)[0].head, "b".repeat(40));
  assert.equal(statuses.filter((a) => a[1] === "set").length, 1, "the status is not rewritten for the older head");
});

test("triagePass follows a re-run and a moved PR: superseded jobs go, an empty item clears its status and comment", async () => {
  const dir = tmp();
  const runs = [prRun(5, "2026-10-08T11:00:00Z", [{ id: 51, name: "Lint", conclusion: "failure" }])];
  const prs = [{ number: 42, state: "open", head: { sha: HEAD } }];
  const comments = [];
  const writes = [];
  let down = true;
  const statuses = [];
  const { deps, tick } = passDeps(dir, fakeRepo(runs, { prs, comments, writes }), {
    rivet: async (args) => {
      if (args[1] === "list") return JSON.stringify({ statuses: statuses.length ? [{ kind: "pr", key: args.key ?? statuses.at(-1)[3], by: BY, version: statuses.length }] : [] });
      if (down) throw new Error("rivet down");
      statuses.push(args);
      return "";
    },
  });
  await triagePass(deps);
  let state = JSON.parse(fs.readFileSync(deps.stateFile, "utf8"));
  assert.equal(Object.values(state.items)[0].pending, true, "kept pending while Rivet is down");
  down = false;
  tick(60_000);
  await triagePass(deps);
  assert.match(statuses[0][statuses[0].indexOf("--note") + 1], /Lint/, "retried without a new failure");
  assert.equal(writes.filter((a) => a.includes("POST")).length, 1);
  // The comment as posted: the read-back finds it unchanged.
  comments.push({ id: 9, user: { login: "me" }, body: writes.find((a) => a.includes("POST")).body });
  tick(60_000);
  await triagePass(deps);
  state = JSON.parse(fs.readFileSync(deps.stateFile, "utf8"));
  assert.equal(Object.values(state.items)[0].check, false, "the comment was read back once");

  // Attempt 2 passes Lint and fails Test, whose log is unreadable: Lint still goes.
  runs[0] = prRun(5, "2026-10-08T11:00:00Z", [{ id: 61, name: "Lint", conclusion: "success" }, { id: 62, name: "Test", conclusion: "failure" }], { run_attempt: 2 });
  const failLogs = new Set([62]);
  deps.gh = fakeRepo(runs, { prs, comments, writes, failLogs });
  tick(60_000);
  await triagePass(deps);
  assert.deepEqual(statuses.at(-1).slice(0, 2), ["status", "clear"], "nothing left: the status is cleared");
  assert.ok(writes.some((a) => a.includes("DELETE") && a.at(-1).endsWith("/comments/9")), "and the comment deleted");
  state = JSON.parse(fs.readFileSync(deps.stateFile, "utf8"));
  assert.deepEqual(state.items, {});

  // The PR moves on: its old head's status and comment go too.
  failLogs.clear();
  runs[0] = prRun(5, "2026-10-08T11:00:00Z", [{ id: 71, name: "Test", conclusion: "failure" }], { run_attempt: 3 });
  tick(60_000);
  await triagePass(deps);
  assert.match(statuses.at(-1)[statuses.at(-1).indexOf("--note") + 1], /Test/);
  writes.length = 0;
  prs[0].head.sha = "c".repeat(40);
  tick(60_000);
  await triagePass(deps);
  assert.deepEqual(statuses.at(-1).slice(0, 2), ["status", "clear"]);
  assert.ok(writes.some((a) => a.includes("DELETE")));
});

test("triagePass reads back a comment a read-back poll had to post again, and does so at the ceiling too", async () => {
  const dir = tmp();
  const runs = [prRun(5, "2026-10-08T11:00:00Z", [{ id: 51, name: "Lint", conclusion: "failure" }])];
  const comments = [];
  const writes = [];
  const { deps, tick } = passDeps(dir, fakeRepo(runs, { comments, writes }));
  await triagePass(deps);
  assert.equal(writes.filter((a) => a.includes("POST")).length, 1);
  // Someone deleted it before the read-back: it is posted again, and that one is read back too.
  tick(60_000);
  await triagePass(deps);
  assert.equal(writes.filter((a) => a.includes("POST")).length, 2);
  let state = JSON.parse(fs.readFileSync(deps.stateFile, "utf8"));
  assert.equal(Object.values(state.items)[0].check, true);

  // At the ceiling the read-back still runs; evidence posted in the comment's second gets the comment deleted.
  const body = writes.at(-1).body;
  comments.push(
    { id: 31, user: { login: "me" }, created_at: "2026-10-08T12:01:00Z", updated_at: "2026-10-08T12:01:00Z", body },
    { id: 32, user: { login: "me" }, created_at: "2026-10-08T12:01:00Z", body: `Self-review (tier: high)\nReviewed head: \`${HEAD}\`` },
  );
  tick(60_000);
  const capped = await triagePass({ ...deps, spend: new Spend("spent", 0, { dir: path.join(dir, "spend") }), run: async () => assert.fail("no model call at the ceiling") });
  assert.equal(capped.capped, true);
  assert.ok(writes.some((a) => a.includes("DELETE") && a.at(-1).endsWith("/comments/31")));
  state = JSON.parse(fs.readFileSync(deps.stateFile, "utf8"));
  assert.equal(Object.values(state.items)[0].check, true, "a deletion is read back too: a listing can miss a comment");
  // Once a read-back finds nothing of ours after the evidence, the checks stop.
  comments.splice(comments.findIndex((c) => c.id === 31), 1);
  tick(60_000);
  writes.length = 0;
  await triagePass({ ...deps, spend: new Spend("spent", 0, { dir: path.join(dir, "spend") }), run: async () => assert.fail("no model call at the ceiling") });
  assert.equal(writes.some((a) => a.includes("DELETE")), false);
  state = JSON.parse(fs.readFileSync(deps.stateFile, "utf8"));
  assert.equal(Object.values(state.items)[0].check, false);
});

test("triagePass gives a run that names its PRs only to those PRs, and keys each PR's work apart", async () => {
  const dir = tmp();
  const prs = [
    { number: 42, state: "open", head: { sha: HEAD } },
    { number: 43, state: "open", head: { sha: HEAD } },
  ];
  const runs = [
    prRun(1, "2026-10-08T11:00:00Z", [{ id: 11, name: "Only 43", conclusion: "failure" }], { pull_requests: [{ number: 43 }] }),
    prRun(2, "2026-10-08T11:01:00Z", [{ id: 21, name: "Both", conclusion: "failure" }], { pull_requests: [] }),
  ];
  const { deps } = passDeps(dir, fakeRepo(runs, { prs }));
  const { rows } = await triagePass(deps);
  assert.deepEqual(rows.map((r) => [r.pr, r.job]).sort(), [[42, 21], [43, 11], [43, 21]]);
});

test("triagePass keeps an item while its head is listed, and clears its status a week after it stops being listed", async () => {
  const dir = tmp();
  const runs = [mainRun(1, HEAD, "2026-10-08T11:00:00Z", [{ id: 11, name: "A", conclusion: "failure" }])];
  const { deps, statuses, tick } = passDeps(dir, fakeRepo(runs, { prs: [] }), {
    rivet: async (args) => {
      if (args[1] === "list") return JSON.stringify({ statuses: [{ kind: "ci", key: Object.values(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).items)[0]?.key, by: BY, version: 3 }] });
      statuses.push(args);
      return "";
    },
  });
  await triagePass(deps);
  for (let day = 0; day < 9; day++) {
    tick(86_400_000);
    await triagePass(deps);
  }
  assert.ok(!statuses.some((a) => a[1] === "clear"), "still listed: kept");
  runs.length = 0;
  for (let day = 0; day < 9; day++) {
    tick(86_400_000);
    await triagePass(deps);
  }
  assert.deepEqual(statuses.filter((a) => a[1] === "clear").map((a) => a.slice(0, 2)), [["status", "clear"]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(deps.stateFile, "utf8")).items, {});
});
