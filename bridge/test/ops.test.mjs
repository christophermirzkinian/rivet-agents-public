import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { CLAUDE_INTERVAL_MS, limitedUsage, parseUsage, readClaudeToken, USAGE_URL, writeUsageFile } from "../lib/ops/claude.mjs";
import { clip, iso } from "../lib/ops/common.mjs";
import { collectFly, emptyFlyCache, flyApps, MAX_RELEASES, parseFlyStatus, parseReleases } from "../lib/ops/fly.mjs";
import { checksSummary, collectGithub, emptyGithubCache, MAX_PRS, parseCiRuns, parseClosed, parseJobNames, parseMerged, parsePullRequests, parseRunners, parseRuns, PR_QUERY } from "../lib/ops/github.mjs";
import { OPS_INTERVAL_MS, runOpsLoop } from "../lib/ops/index.mjs";
import { collectMac, parseDf, parseLaunchctl, parseReadOnly, pressureOf, volumesFrom } from "../lib/ops/mac.mjs";
import { paddings, showsToken, TOKEN } from "./padded-token.mjs";

const NOW = new Date("2026-09-28T02:00:00.000Z");
const MS = "example-org/example-repo";
process.env.RIVET_REPOS = `${MS},example-org/other-repo`;
process.env.RIVET_FLY_APPS = "rivet-agents";
delete process.env.RIVET_HA_URL;

const PR_DOC = {
  data: {
    repository: {
      pullRequests: {
        nodes: [
          {
            number: 2177,
            title: "Rivet v2: Ops board\u0007 and briefings",
            url: "https://github.com/example-org/example-repo/pull/2177",
            isDraft: true,
            updatedAt: "2026-09-28T01:00:00Z",
            author: { login: "sam" },
            labels: { nodes: [{ name: "notify:skip" }, { name: "hold" }] },
            commits: {
              nodes: [
                {
                  commit: {
                    committedDate: "2026-09-28T00:30:00Z",
                    statusCheckRollup: {
                      contexts: {
                        nodes: [
                          { __typename: "CheckRun", name: "typecheck", status: "COMPLETED", conclusion: "SUCCESS" },
                          { __typename: "CheckRun", name: "rivet tests", status: "COMPLETED", conclusion: "FAILURE" },
                          { __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: null },
                          { __typename: "StatusContext", context: "docs/check", state: "ERROR" },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          },
          { number: 12, title: "bad url", url: "https://evil.example/pull/12", isDraft: false, updatedAt: "2026-09-28T01:00:00Z" },
          { number: 2180, title: "No checks", url: "https://github.com/example-org/example-repo/pull/2180", isDraft: false, updatedAt: "2026-09-27T01:00:00Z", author: { login: "app/dependabot" } },
        ],
      },
    },
  },
};

const RUNS = [
  {
    databaseId: 900,
    workflowName: "CI",
    displayTitle: "Rivet phase 1",
    status: "completed",
    conclusion: "failure",
    event: "push",
    headSha: "a".repeat(40),
    url: "https://github.com/example-org/example-repo/actions/runs/900",
    createdAt: "2026-09-28T01:00:00Z",
    updatedAt: "2026-09-28T01:20:00Z",
  },
  {
    databaseId: 901,
    workflowName: "CI",
    displayTitle: "ok",
    status: "in_progress",
    conclusion: "",
    event: "push",
    headSha: "b".repeat(40),
    url: "https://github.com/example-org/example-repo/actions/runs/901",
    createdAt: "2026-09-28T01:30:00Z",
    updatedAt: "2026-09-28T01:31:00Z",
  },
  { databaseId: -1, workflowName: "bad", status: "completed", headSha: "zz", url: "x", createdAt: "nope" },
];

const DF = `Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1   971350180  10571468 106223244    10%    /
devfs                  207       207         0   100%    /dev
/dev/disk3s6     971350180   4194328 106223244     4%    /System/Volumes/VM
/dev/disk3s5     971350180 850022112 106223244    89%    /System/Volumes/Data
map auto_home            0         0         0   100%    /System/Volumes/Data/home
/dev/disk5s1    1953514584 1900000000  53514584    98%    /Volumes/CI Scratch
/dev/disk7s1       1000000    900000    100000    90%    /Library/Developer/CoreSimulator/Volumes/iOS_22A
`;

const LAUNCHCTL = `PID\tStatus\tLabel
512\t0\tactions.runner.example-org-example-repo.mac-10
-\t0\tactions.runner.example-org-example-repo.mac-2
733\t0\tactions.runner.example-org-example-repo.mac-1
901\t0\tcom.example.tool.1234.5678
-\t0\tcom.apple.something
`;

const FLY_STATUS = {
  Name: "rivet-agents",
  Status: "deployed",
  Version: 42,
  Hostname: "hidden-host.example.test",
  Machines: [
    {
      state: "started",
      updated_at: "2026-09-28T01:00:00Z",
      image_ref: { labels: { GH_SHA: "c".repeat(40) } },
      config: { env: { SECRET: "nope" }, metadata: { fly_release_version: "42" } },
      checks: [
        { name: "http", status: "passing", output: "ok" },
        { name: "tcp", status: "critical", output: "refused" },
      ],
      private_ip: "fdaa::1",
    },
    { state: "stopped", updated_at: "2026-09-27T01:00:00Z", checks: [] },
    { state: "started", updated_at: "2026-09-26T01:00:00Z", checks: [] },
  ],
};

const FLY_RELEASES = [
  { Version: 42, Status: "complete", CreatedAt: "2026-09-28T01:00:00Z", User: { Email: "sam@example.com" }, Description: "Deploy image", ImageRef: "registry.example.test/rivet-agents:direct-bf616155653b-mus7f66d" },
  { Version: 41, Status: "failed", CreatedAt: "2026-09-27T01:00:00Z", User: { Email: "sam@example.com" }, ImageRef: "bad image; rm -rf" },
  { Version: 3, Status: "complete", CreatedAt: "2026-08-01T01:00:00Z" },
];

/**
 * A fake exec keyed on the command line, recording every call.
 * @param {(bin: string, args: string[]) => string | Error} answer
 */
function fakeExec(answer) {
  /** @type {{ bin: string, args: string[] }[]} */
  const calls = [];
  /** @type {import("../lib/config.mjs").Exec} */
  const exec = async (bin, args) => {
    calls.push({ bin, args: [...args] });
    const out = answer(bin, args);
    if (out instanceof Error) throw out;
    return { stdout: out, stderr: "" };
  };
  return { exec, calls };
}

test("clip keeps one line under the limit without splitting a character", () => {
  assert.equal(clip("a\nb", 10), "a / b");
  assert.equal(clip("x".repeat(20), 10).length, 10);
  assert.equal(clip("😀".repeat(10), 5), "😀😀…");
  assert.equal(clip(42, 10), "");
});

test("checksSummary counts pass, fail and pending and names the failures", () => {
  const nodes = PR_DOC.data.repository.pullRequests.nodes[0].commits?.nodes[0].commit.statusCheckRollup.contexts.nodes ?? [];
  assert.deepEqual(checksSummary(nodes), { state: "fail", passed: 1, failed: 2, pending: 1, failing: ["rivet tests", "docs/check"] });
  assert.equal(checksSummary([]).state, "none");
  assert.equal(checksSummary([{ __typename: "CheckRun", name: "x", status: "QUEUED" }]).state, "pending");
});

test("checksSummary excludes only demonstrably superseded cancelled checks", () => {
  const check = (id, createdAt, extra = {}) => ({
    __typename: "CheckRun", id, name: "Repo gates", status: "COMPLETED", conclusion: "CANCELLED",
    startedAt: createdAt,
    checkSuite: { id: `suite-${id}`, createdAt, app: { id: "actions" }, workflowRun: { workflow: { id: "ci" } } },
    ...extra,
  });
  const old = check("old", "2026-09-28T00:00:00Z");
  const pass = check("new", "2026-09-28T01:00:00Z", { conclusion: "SUCCESS" });
  const pending = { ...pass, status: "QUEUED", conclusion: null, startedAt: null };
  assert.deepEqual(checksSummary([old, pass]), { state: "pass", passed: 1, failed: 0, pending: 0, failing: [] });
  assert.deepEqual(checksSummary([pending, old]), { state: "pending", passed: 0, failed: 0, pending: 1, failing: [] });
  assert.equal(checksSummary([old]).failed, 1);
  assert.equal(checksSummary([{ ...old, startedAt: null }, pass]).failed, 1, "suite creation cannot date an unstarted cancelled rerun");
  assert.equal(checksSummary([pass, check("latest", "2026-09-28T02:00:00Z")]).failed, 1, "the latest cancellation stays red");
  assert.equal(checksSummary([{ ...old, conclusion: "FAILURE" }, pass]).failed, 1, "real failures are never suppressed");
  assert.equal(checksSummary([{ ...old, conclusion: "TIMED_OUT" }, pass]).failed, 1);
  for (const replacement of [
    { ...pass, name: "Other job" },
    { ...pass, checkSuite: { ...pass.checkSuite, app: { id: "other-app" } } },
    { ...pass, checkSuite: { ...pass.checkSuite, workflowRun: { workflow: { id: "other-workflow" } } } },
    { ...pass, checkSuite: null },
    { ...pass, startedAt: null, checkSuite: { ...pass.checkSuite, createdAt: "invalid" } },
    { ...pass, startedAt: old.startedAt, checkSuite: { ...pass.checkSuite, createdAt: old.checkSuite.createdAt } },
    { ...pass, id: old.id },
    { __typename: "StatusContext", context: old.name, state: "SUCCESS" },
  ]) assert.equal(checksSummary([old, replacement]).failed, 1, "uncertain or unrelated replacements leave cancellation visible");
  assert.equal(checksSummary([{ ...old, startedAt: "2026-09-28T02:00:00Z" }, pass]).failed, 1, "a later rerun in an older suite is not superseded");
  const rerun = { ...pass, checkSuite: old.checkSuite };
  assert.equal(checksSummary([check("cancelled", "2026-09-28T01:00:00Z"), { ...old, conclusion: "SUCCESS", startedAt: "2026-09-28T03:00:00Z" }]).state, "pass", "a successful rerun of an older suite supersedes the cancellation");
  assert.equal(checksSummary([old, rerun]).state, "pass", "same-suite reruns use their start times");
  assert.equal(checksSummary([old, { ...rerun, startedAt: null }]).failed, 1);
  assert.match(PR_QUERY, /id name status conclusion startedAt/);
  assert.match(PR_QUERY, /checkSuite \{ id createdAt app \{ id \} workflowRun \{ workflow \{ id \}/);
});

test("parsePullRequests keeps GitHub URLs only and strips control characters", () => {
  const prs = parsePullRequests(MS, JSON.stringify(PR_DOC));
  assert.deepEqual(
    prs.map((p) => p.number),
    [2177, 2180],
  );
  assert.match(prs[0].title, /^Rivet v2: Ops board ?and briefings$/);
  assert.ok(!/[\u0000-\u001f]/.test(prs[0].title));
  assert.deepEqual(prs[0].labels, ["notify:skip", "hold"]);
  assert.equal(prs[0].draft, true);
  assert.equal(prs[0].headAt, "2026-09-28T00:30:00.000Z");
  assert.equal(prs[1].author, "dependabot");
  assert.equal(prs[1].checks.state, "none");
  assert.equal(prs[0].branch, undefined);
  const branched = (extra) => parsePullRequests(MS, JSON.stringify({ data: { repository: { pullRequests: { nodes: [{ ...PR_DOC.data.repository.pullRequests.nodes[0], ...extra }] } } } }))[0].branch;
  assert.equal(branched({ headRefName: "sam/tidy-fix", isCrossRepository: false }), "sam/tidy-fix");
  // A fork's branch name says nothing about the chats here, and a name outside the pattern is dropped.
  assert.equal(branched({ headRefName: "main", isCrossRepository: true }), undefined);
  assert.equal(branched({ headRefName: "a..b", isCrossRepository: false }), undefined);
  // Only a PR GitHub says is from this repo carries one.
  assert.equal(branched({ headRefName: "fix/ci" }), undefined);
  assert.equal(branched({ headRefName: "fix/ci", isCrossRepository: null }), undefined);
  assert.throws(() => parsePullRequests(MS, "{}"), /no pull requests/);
  assert.throws(() => parsePullRequests(MS, "<html>"), /non-JSON/);
});

test("a PR body's hold reaches Ops redacted, a token after any padding neither whole nor a head", () => {
  const hold = (/** @type {string} */ body) => parsePullRequests(MS, JSON.stringify({ data: { repository: { pullRequests: { nodes: [{ ...PR_DOC.data.repository.pullRequests.nodes[0], body }] } } } }))[0].hold;
  const said = hold("Owner hold: rotate API_KEY=hunter2");
  assert.ok(typeof said === "string" && said.startsWith("Owner hold: rotate API_KEY=") && !said.includes("hunter2"), said);
  for (const { kind, n, padding } of paddings(200)) {
    const out = hold(`Owner hold: ${padding}${TOKEN}`);
    assert.ok(!showsToken(out), `${kind} ${n}: ${out}`);
  }
  // The hold line is read from the body redacted whole: a block's header or a continued line above it marks a secret.
  const block = hold("password: |\n  Owner hold: hunter2");
  assert.ok(typeof block === "string" && !block.includes("hunter2"), block);
  const continued = hold(`${TOKEN.slice(0, 30)}${String.fromCharCode(92, 10)}${TOKEN.slice(30)} Owner hold: wait`);
  assert.ok(typeof continued === "string" && !continued.includes(TOKEN.slice(0, 4)) && !showsToken(continued), continued);
});

test("each PR carries its head commit and its body's first hold line", () => {
  const node = (extra) => ({ ...PR_DOC.data.repository.pullRequests.nodes[0], ...extra });
  const head = "a".repeat(40);
  const commits = (oid) => ({ commits: { nodes: [{ commit: { ...PR_DOC.data.repository.pullRequests.nodes[0].commits.nodes[0].commit, oid } }] } });
  const doc = { data: { repository: { pullRequests: { nodes: [
    node({ number: 1, ...commits(head), body: "## Summary\nFaster tiles.\n\n**Owner hold:** Sam OKs the video first\n" }),
    node({ number: 2, ...commits("not-a-sha"), body: "## Holds\nNone.\n\nNo owner hold." }),
    node({ number: 3, body: null }),
  ] } } } };
  const prs = parsePullRequests(MS, JSON.stringify(doc));
  assert.equal(prs[0].headSha, head);
  assert.equal(prs[0].hold, "**Owner hold:** Sam OKs the video first");
  assert.equal(prs[1].headSha, undefined);
  assert.equal(prs[1].hold, undefined, "a Holds heading over None and \"No owner hold\" hold nothing");
  assert.equal(prs[2].hold, undefined);
  assert.match(PR_QUERY, /commit \{ oid committedDate/);
  assert.match(PR_QUERY, /updatedAt body headRefName/);
});

test("a PR's hold is read from its newest comments too, a later owner release ending it, as the merge guard reads them", () => {
  const node = (extra) => ({ ...PR_DOC.data.repository.pullRequests.nodes[0], body: "## Summary\nFaster tiles.", ...extra });
  const note = (body, at, authorAssociation = "OWNER") => ({ body, createdAt: at, updatedAt: at, authorAssociation });
  const hold = note("Owner hold: Sam plays it first", "2026-09-28T01:00:00Z");
  const doc = { data: { repository: { pullRequests: { nodes: [
    node({ number: 1, comments: { nodes: [hold] } }),
    node({ number: 2, comments: { nodes: [hold, note("Hold released: Sam played it", "2026-09-28T01:30:00Z")] } }),
    node({ number: 3, comments: { nodes: [hold, note("Hold released: Sam played it", "2026-09-28T01:30:00Z", "NONE")] } }),
    node({ number: 4 }),
    // A review summary holds too, and as the merge guard reads it a later release never supersedes it.
    node({ number: 5, reviews: { nodes: [{ body: "Owner hold: Sam plays it first", submittedAt: "2026-09-28T01:00:00Z", authorAssociation: "OWNER" }] }, comments: { nodes: [note("Hold released: Sam played it", "2026-09-28T01:30:00Z")] } }),
    node({ number: 6, comments: { nodes: [hold, ...Array.from({ length: 12 }, (_, i) => note(`CI rerun ${i}`, "2026-09-28T02:00:00Z"))] } }),
  ] } } } };
  assert.deepEqual(parsePullRequests(MS, JSON.stringify(doc)).map((pr) => pr.hold), [
    "Owner hold: Sam plays it first",
    undefined,
    "Owner hold: Sam plays it first",
    undefined,
    "Owner hold: Sam plays it first",
    "Owner hold: Sam plays it first",
  ]);
  // Deep enough that ordinary comments after a hold do not push it out of the read.
  assert.match(PR_QUERY, /comments\(last: 100\) \{ nodes \{ authorAssociation body createdAt updatedAt \} \}/);
  assert.match(PR_QUERY, /reviews\(last: 100\) \{ nodes \{ authorAssociation body submittedAt \} \}/);
});

test("parseCiRuns takes the median passing first attempt and the start of each head's run still going", () => {
  const sha = (c) => c.repeat(40);
  const run = (head, minutes, extra = {}) => ({ attempt: 1, status: "completed", conclusion: "success", headSha: sha(head), startedAt: "2026-09-28T00:00:00Z", updatedAt: new Date(Date.parse("2026-09-28T00:00:00Z") + minutes * 60_000).toISOString(), ...extra });
  const runs = [
    run("a", 10), run("b", 20), run("c", 22), run("d", 30), run("e", 90),
    run("f", 5, { conclusion: "failure" }),
    run("f", 6, { attempt: 2 }),
    run("f", 0, { status: "in_progress", conclusion: null, startedAt: "2026-09-28T01:50:00Z" }),
    run("f", 0, { status: "queued", conclusion: null, startedAt: "2026-09-28T01:40:00Z" }),
    { headSha: "nope", status: "in_progress" },
  ];
  const ci = parseCiRuns(JSON.stringify(runs));
  assert.equal(ci.typicalMin, 22, "failures and reruns are not typical");
  assert.equal(ci.started.get(sha("f")), "2026-09-28T01:50:00.000Z", "the newest run on the head");
  assert.equal(ci.started.size, 1);
  assert.equal(parseCiRuns(JSON.stringify(runs.slice(0, 4))).typicalMin, null, "four runs are too few to call typical");
  assert.throws(() => parseCiRuns("{}"), /no runs/);
});

test("collectGithub adds the CI start to a PR on the same head", async () => {
  const head = "d".repeat(40);
  const node = { ...PR_DOC.data.repository.pullRequests.nodes[0], number: 3859, isDraft: false };
  node.commits = { nodes: [{ commit: { ...node.commits.nodes[0].commit, oid: head } }] };
  const doc = { data: { repository: { pullRequests: { nodes: [node, { ...node, number: 3860 }] } } } };
  const ciRuns = [
    ...["1", "2", "3", "4", "5"].map((c) => ({ attempt: 1, status: "completed", conclusion: "success", headSha: c.repeat(40), startedAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:20:00Z" })),
    { attempt: 1, status: "in_progress", conclusion: null, headSha: head, startedAt: "2026-09-28T01:52:00Z", updatedAt: "2026-09-28T01:58:00Z" },
  ];
  const answer = (/** @type {string} */ bin, /** @type {string[]} */ args) => {
    if (args[1] === "graphql") return args.includes("name=example-repo") ? JSON.stringify(doc) : JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } });
    if (isCiRuns(args)) return JSON.stringify(ciRuns);
    return ghAnswer(bin, args);
  };
  const { exec } = fakeExec(answer);
  const snap = await collectGithub({ exec, ghBin: "gh", now: () => NOW, cache: emptyGithubCache() });
  const pr = (n) => snap.prs.find((p) => p.number === n);
  assert.equal(pr(3859).ciStartedAt, "2026-09-28T01:52:00.000Z");
  assert.equal(snap.ciTypicalMin, 20);
  assert.equal(pr(3859).hold, undefined, "no holds file read");
  // The merge holds file holds a PR as the merge guard reads it.
  const holdsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ops-holds-")), "holds.json");
  fs.writeFileSync(holdsFile, JSON.stringify([{ pr: 3860, reason: "waits behind the tile PR" }]));
  const filed = await collectGithub({ exec, ghBin: "gh", now: () => NOW, cache: emptyGithubCache(), holdsFile });
  assert.deepEqual(filed.prs.map((p) => [p.number, p.hold]), [[3859, undefined], [3860, "holds file: waits behind the tile PR"]]);

  // A failed CI read keeps no old run starts, which a rerun since would make look overdue.
  const cache = emptyGithubCache();
  let ciDown = false;
  const flaky = fakeExec((bin, args) => (isCiRuns(args) && ciDown ? new Error("gh: 502") : answer(bin, args)));
  await collectGithub({ exec: flaky.exec, ghBin: "gh", now: () => NOW, cache });
  ciDown = true;
  const stale = await collectGithub({ exec: flaky.exec, ghBin: "gh", now: () => NOW, cache });
  assert.equal(stale.prs.find((p) => p.number === 3859).ciStartedAt, undefined);
  assert.equal(stale.ciTypicalMin, undefined);
});

test("collectGithub marks a PR whose only hold is the video wait, from the raw texts and raw labels; a holds file entry unmarks it", async () => {
  const video = "**Merge waits for the owner's OK on the video.**";
  const node = (number, body) => ({ ...PR_DOC.data.repository.pullRequests.nodes[0], number, isDraft: false, labels: { nodes: [] }, body });
  const doc = { data: { repository: { pullRequests: { nodes: [
    node(3861, `## Summary\nNew reels.\n\n${video}\n`),
    node(3862, `${video}\n\nOwner hold: Sam wants to try it first\n`),
    node(3863, `## Summary\nNew reels.\n\n${video}\n`),
    node(3864, `${video}\n\npassword: |\n  Owner hold: Sam requires a security review first\n`),
    { ...node(3865, `${video}\n`), labels: { nodes: [{ name: "token=owner-hold" }] } },
    { ...node(3866, `${video}\n`), labels: { nodes: [{ name: "wip" }] } },
    node(3867, "Monitor hold: until the owner opens the ruleset window\n\nOwner hold: Sam wants to try it first\n"),
    node(3868, `Hold:${"Z".repeat(210)}\n`),
  ] } } } };
  const answer = (/** @type {string} */ bin, /** @type {string[]} */ args) => {
    if (args[1] === "graphql") return args.includes("name=example-repo") ? JSON.stringify(doc) : JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } });
    return ghAnswer(bin, args);
  };
  const { exec } = fakeExec(answer);
  const holdsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ops-holds-")), "holds.json");
  fs.writeFileSync(holdsFile, JSON.stringify([{ pr: 3863, reason: "waits behind the tile PR" }, { pr: 3863, reason: "Sam: wait for my playtest" }, { pr: 3868, reason: "Sam: wait for my playtest" }]));
  const snap = await collectGithub({ exec, ghBin: "gh", now: () => NOW, cache: emptyGithubCache(), holdsFile });
  assert.deepEqual(snap.prs.map((p) => [p.number, p.hold, p.videoWait]), [
    [3861, video, true],
    [3862, video, undefined],
    [3863, video, undefined],
    [3864, video, undefined],
    [3865, video, undefined],
    [3866, video, true],
    // A second hold after the monitor's own is sent too, in `holds`.
    [3867, "Monitor hold: until the owner opens the ruleset window", undefined],
    // A body hold that shapes to nothing leaves the holds-file hold as the one shown.
    [3868, "holds file: Sam: wait for my playtest", undefined],
  ]);
  assert.deepEqual(snap.prs.find((p) => p.number === 3867).holds, ["Monitor hold: until the owner opens the ruleset window", "Owner hold: Sam wants to try it first"]);
  assert.equal(snap.prs.find((p) => p.number === 3861).holds, undefined, "one hold line sends no list");
  // Every holds-file entry is sent, beside the text hold.
  assert.deepEqual(snap.prs.find((p) => p.number === 3863).holds, [video, "holds file: waits behind the tile PR", "holds file: Sam: wait for my playtest"]);
});

test("parseRuns drops malformed runs and reads an empty conclusion as null", () => {
  const runs = parseRuns(MS, JSON.stringify(RUNS));
  assert.equal(runs.length, 2);
  assert.equal(runs[0].conclusion, "failure");
  assert.equal(runs[1].conclusion, null);
  assert.equal(runs[1].status, "in_progress");
});

test("parseRunners counts online, busy and offline", () => {
  const load = parseRunners(
    JSON.stringify([
      { name: "mac-2", status: "online", busy: true },
      { name: "mac-10", status: "online", busy: false },
      { name: "mac-1", status: "offline", busy: false },
      { name: "bad\nname", status: "online", busy: true },
    ]),
  );
  assert.deepEqual(
    { online: load.online, busy: load.busy, offline: load.offline },
    { online: 2, busy: 1, offline: 1 },
  );
  assert.deepEqual(
    load.runners.map((r) => r.name),
    ["mac-1", "mac-2", "mac-10"],
  );
});

test("parseClosed keeps the number and close time, and skips a row without them", () => {
  const closed = parseClosed("example-org/other-repo", JSON.stringify([{ number: 41, closedAt: "2026-10-03T01:00:00Z" }, { number: 0, closedAt: "2026-10-03T01:00:00Z" }, { number: 42 }]));
  assert.deepEqual(closed, [{ repo: "example-org/other-repo", number: 41, closedAt: "2026-10-03T01:00:00.000Z" }]);
});

test("parseMerged keeps number, title, url, time and author", () => {
  const merged = parseMerged(
    MS,
    JSON.stringify([
      { number: 2160, title: "Phases 2-4", url: "https://github.com/example-org/example-repo/pull/2160", mergedAt: "2026-09-27T10:00:00Z", author: { login: "sam" } },
      { number: 0, title: "bad" },
    ]),
  );
  assert.deepEqual(merged, [
    { repo: MS, number: 2160, title: "Phases 2-4", url: "https://github.com/example-org/example-repo/pull/2160", mergedAt: "2026-09-27T10:00:00.000Z", author: "sam" },
  ]);
});

test("parseMerged keeps a merged PR's head branch from this repo, never a fork's or a bad one", () => {
  const row = (number, extra) => ({ number, title: "t", url: `https://github.com/${MS}/pull/${number}`, mergedAt: "2026-09-27T10:00:00Z", author: { login: "a" }, ...extra });
  const merged = parseMerged(
    MS,
    JSON.stringify([
      row(1, { headRefName: "sam/team-room", isCrossRepository: false }),
      row(2, { headRefName: "sam/fork", isCrossRepository: true }),
      row(3, { headRefName: "../bad", isCrossRepository: false }),
      row(4, {}),
    ]),
  );
  assert.deepEqual(
    merged.map((pr) => [pr.number, pr.branch]),
    [
      [1, "sam/team-room"],
      [2, undefined],
      [3, undefined],
      [4, undefined],
    ],
  );
});

/** The repo a read of main's runs asks for, or null. @param {string[]} args */
const mainRunsOf = (args) => /^repos\/([^/]+\/[^/]+)\/actions\/runs\?branch=main&/.exec(args.find((a) => a.startsWith("repos/")) ?? "")?.[1] ?? null;
/** A read of the PR CI runs. @param {string[]} args */
const isCiRuns = (args) => args.some((a) => a.includes("/actions/workflows/ci.yml/runs?"));

/** @param {string} _bin @param {string[]} args */
function ghAnswer(_bin, args) {
  const joined = args.join(" ");
  if (args[0] === "api" && args[1] === "graphql") return JSON.stringify(PR_DOC);
  if (mainRunsOf(args)) return mainRunsOf(args) === MS ? JSON.stringify(RUNS) : "[]";
  if (isCiRuns(args)) return JSON.stringify(RUNS);
  if (joined.includes("/actions/runs/900/jobs")) return JSON.stringify(["Deploy Rivet to Fly", "unit"]);
  if (joined.includes("/actions/runners")) return JSON.stringify({ total_count: 1, runners: [{ name: "mac-1", status: "online", busy: true }] });
  if (joined.includes("actions/runs?status=queued")) return JSON.stringify({ total_count: 2, ids: [700, 701] });
  if (joined.includes("actions/runs?status=in_progress")) return JSON.stringify({ total_count: 1, ids: [901] });
  if (joined.includes("/jobs?per_page=50&filter=latest") && joined.includes("length")) return JSON.stringify({ total_count: 2, read: 2, queued: 2 });
  if (args[0] === "pr" && args[1] === "list") return "[]";
  return new Error(`unexpected gh ${joined}`);
}

test("queue sampling distinguishes discovery and job coverage, including exact limits", async () => {
  for (const [runCount, discovered, jobCount, expectedRuns, expectedJobs] of [
    [8, 8, 100, true, true], [9, 9, 100, true, false], [1, 1, 101, true, false],
    [50, 50, 1, true, false], [51, 50, 1, false, false],
  ]) {
    const { exec, calls } = fakeExec((bin, args) => {
      const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
      if (path.includes("actions/runs?status=queued")) return JSON.stringify({ total_count: runCount, ids: Array.from({ length: discovered }, (_, i) => 700 + i) });
      if (path.includes("actions/runs?status=in_progress")) return JSON.stringify({ total_count: 0, ids: [] });
      if (path.includes("/jobs?per_page=50&filter=latest") && args.at(-1).includes("queued")) {
        const page = Number(/&page=(\d+)$/.exec(path)?.[1]);
        const read = Math.max(0, Math.min(50, jobCount - (page - 1) * 50));
        return JSON.stringify({ total_count: jobCount, read, queued: read });
      }
      return ghAnswer(bin, args);
    });
    const snap = await collectGithub({ exec, ghBin: "gh", now: () => NOW, cache: emptyGithubCache() });
    assert.equal(snap.queue.runsComplete, expectedRuns);
    assert.equal(snap.queue.jobsComplete, expectedJobs);
    assert.equal(snap.queue.sampledRuns, Math.min(discovered, 8));
    assert.equal(snap.queue.queuedJobs, Math.min(discovered, 8) * Math.min(jobCount, 100));
    assert.equal(calls.filter((c) => c.args.at(-1)?.includes("{total_count, read:")).length, Math.min(discovered, 8) * Math.min(2, Math.ceil(jobCount / 50)), "50 to a page, 2 pages at most");
  }
});

test("the runner list and both run lists, read every cycle, send their ETag; a 304 serves the last answer", async () => {
  const etagged = (/** @type {string} */ body, /** @type {string} */ tag) => `HTTP/2.0 200 OK\r\nEtag: "${tag}"\r\n\r\n${body}`;
  const conditional = (/** @type {string} */ bin, /** @type {string[]} */ args) => {
    const path = args.find((a) => a.startsWith("repos/")) ?? "";
    const every = path.includes("/actions/runners?") || mainRunsOf(args) === MS || isCiRuns(args);
    if (!every) return ghAnswer(bin, args);
    const tag = path.includes("/actions/runners?") ? "runners" : isCiRuns(args) ? "ci" : "main";
    if (args.includes(`If-None-Match: "${tag}"`)) return Object.assign(new Error("gh: HTTP 304"), { stdout: `HTTP/2.0 304 Not Modified\r\nEtag: "${tag}"\r\n\r\n` });
    return etagged(String(ghAnswer(bin, args)), tag);
  };
  const { exec, calls } = fakeExec(conditional);
  const cache = emptyGithubCache();
  const first = await collectGithub({ exec, ghBin: "gh", now: () => NOW, cache });
  const before = calls.length;
  const second = await collectGithub({ exec, ghBin: "gh", now: () => new Date(NOW.getTime() + 60_000), cache });
  const repeated = calls.slice(before).filter((c) => c.args.some((a) => a.includes("/actions/runners?")) || mainRunsOf(c.args) === MS || isCiRuns(c.args));
  assert.equal(repeated.length, 3);
  for (const c of repeated) assert.equal(c.args[1], "-i", c.args.join(" "));
  assert.deepEqual(repeated.map((c) => c.args[3]), ['If-None-Match: "main"', 'If-None-Match: "ci"', 'If-None-Match: "runners"']);
  assert.deepEqual(second.runners, first.runners);
  assert.deepEqual(second.runs.map((r) => r.id), first.runs.map((r) => r.id));
  assert.deepEqual(second.sources.runners, { failed: [], at: null });
  assert.deepEqual(second.sources.runs, { failed: [], at: null });
});

test("a run starting between queue reads is counted once", async () => {
  const { exec } = fakeExec((bin, args) => {
    if (args.join(" ").includes("actions/runs?status=in_progress")) return JSON.stringify({ total_count: 1, ids: [700] });
    return ghAnswer(bin, args);
  });
  const snap = await collectGithub({ exec, ghBin: "gh", now: () => NOW, cache: emptyGithubCache() });
  assert.equal(snap.queue.sampledRuns, 2);
  assert.equal(snap.queue.queuedJobs, 4);
});

test("runner aggregate coverage differs from the 50 detail rows", () => {
  for (const total of [50, 100, 101]) {
    const load = parseRunners(JSON.stringify({ total_count: total, runners: Array.from({ length: Math.min(total, 100) }, (_, i) => ({ name: `runner-${i}`, status: "online", busy: true })) }));
    assert.equal(load.online, Math.min(total, 100));
    assert.equal(load.complete, total <= 100);
    assert.equal(load.detailsComplete, total <= 50);
    assert.equal(load.runners.length, 50);
  }
  const legacy = parseRunners("[]");
  assert.equal(legacy.complete, false);
  assert.equal(legacy.detailsComplete, false);
});

test("PR completeness covers per-repo and combined limits and survives failures", async () => {
  for (const [perRepo, otherRepo, more, expected] of [[300, 0, false, true], [300, 0, true, false], [200, 101, false, false]]) {
    let fail = false;
    const { exec } = fakeExec((bin, args) => {
      if (args[1] !== "graphql") return ghAnswer(bin, args);
      if (fail) return new Error("offline");
      const total = args.includes("name=example-repo") ? perRepo : args.includes("name=other-repo") ? otherRepo : 0;
      const cursor = args.find((arg) => arg.startsWith("cursor="));
      const offset = cursor ? Number(cursor.slice(7)) : 0;
      const nodes = Array.from({ length: Math.min(50, Math.max(0, total - offset)) }, (_, i) => ({ ...PR_DOC.data.repository.pullRequests.nodes[0], number: offset + i + 1 }));
      return JSON.stringify({ data: { repository: { pullRequests: { nodes, pageInfo: { hasNextPage: offset + nodes.length < total || (more && total > 0), endCursor: String(offset + nodes.length) } } } } });
    });
    const cache = emptyGithubCache();
    const first = await collectGithub({ exec, ghBin: "gh", now: () => NOW, cache });
    assert.equal(first.prs.length, 300);
    assert.equal(first.prsComplete, expected);
    fail = true;
    const retained = await collectGithub({ exec, ghBin: "gh", now: () => NOW, cache });
    assert.equal(retained.prsComplete, expected);
    assert.deepEqual(retained.prs, first.prs);
    assert.ok(retained.sources.prs.failed.length > 0);
  }
});

test("collectGithub builds a snapshot with fixed argument arrays and caches slow parts", async () => {
  const { exec, calls } = fakeExec(ghAnswer);
  const cache = emptyGithubCache();
  const snap = await collectGithub({ exec, ghBin: "/opt/gh", now: () => NOW, cache });
  assert.equal(snap.at, NOW.toISOString());
  assert.equal(snap.prs.length, 4);
  assert.equal(snap.runs.length, 2);
  assert.deepEqual(snap.runs[0].failedJobs, ["Deploy Rivet to Fly", "unit"]);
  assert.deepEqual(snap.queue, { queuedRuns: 2, runningRuns: 1, queuedJobs: 6, runsComplete: true, jobsComplete: true, sampledRuns: 3 });
  assert.equal(snap.runners?.busy, 1);
  assert.deepEqual(snap.merged, []);
  assert.ok(calls.every((c) => c.bin === "/opt/gh"));
  const graphql = calls.find((c) => c.args[1] === "graphql");
  assert.deepEqual(graphql?.args, ["api", "graphql", "-f", `query=${PR_QUERY}`, "-f", "owner=example-org", "-f", "name=example-repo"]);
  assert.ok(calls.some((c) => c.args.join(" ").includes("merged:>=2026-09-14")));
  // Runners are fetched last, after the slow queue and merged lookups, so their reading is current when it is sent.
  assert.match(calls.at(-1)?.args.join(" ") ?? "", /\/actions\/runners/);

  const before = calls.length;
  const again = await collectGithub({ exec, ghBin: "/opt/gh", now: () => NOW, cache });
  const second = calls.slice(before);
  assert.equal(again.merged, null, "merged is only sent on refresh cycles");
  assert.ok(!second.some((c) => c.args.join(" ").includes("/runs/900/jobs")), "failed jobs come from the cache");
  assert.deepEqual(again.runs[0].failedJobs, ["Deploy Rivet to Fly", "unit"]);
  assert.deepEqual(second.filter((c) => mainRunsOf(c.args)).map((c) => mainRunsOf(c.args)), [MS], "only the main repo's runs refresh every cycle");
  assert.ok(second.some((c) => c.args.includes(`repos/${MS}/actions/workflows/ci.yml/runs?event=pull_request&per_page=60`)));
  assert.ok(!second.some((c) => c.args[0] === "pr"));
  assert.ok(!second.some((c) => c.args.join(" ").includes("/actions/runs?status=")), "the queue is read on refresh cycles");
  assert.deepEqual(again.queue, snap.queue);
});

test("a queue read that failed is tried again the next cycle, not the next refresh", async () => {
  const cache = emptyGithubCache();
  const down = fakeExec((bin, args) => (args.join(" ").includes("/actions/runs?status=") ? new Error("503") : ghAnswer(bin, args)));
  const first = await collectGithub({ exec: down.exec, ghBin: "gh", now: () => NOW, cache });
  assert.equal(first.queue, null);
  const { exec, calls } = fakeExec(ghAnswer);
  const next = await collectGithub({ exec, ghBin: "gh", now: () => NOW, cache });
  assert.ok(calls.some((c) => c.args.join(" ").includes("/actions/runs?status=queued")));
  assert.equal(next.queue?.queuedRuns, 2);
});

test("collectGithub reads older PR pages, deduplicates overlaps and retains the complete cache on a later-page failure", async () => {
  const node = (number) => ({ ...PR_DOC.data.repository.pullRequests.nodes[0], number });
  const page = (nodes, hasNextPage, endCursor) => JSON.stringify({ data: { repository: { pullRequests: { nodes, pageInfo: { hasNextPage, endCursor } } } } });
  let failure = null;
  const { exec, calls } = fakeExec((bin, args) => {
    if (args[1] !== "graphql" || !args.includes("name=example-repo")) return ghAnswer(bin, args);
    if (args.includes("cursor=older-page")) return failure ?? page([node(50), node(51)], false, null);
    return page(Array.from({ length: 50 }, (_, i) => node(i + 1)), true, "older-page");
  });
  const cache = emptyGithubCache();
  const first = await collectGithub({ exec, ghBin: "gh", now: () => NOW, cache });
  assert.equal(first.prs.filter((pr) => pr.repo === MS).length, 51);
  assert.ok(first.prs.some((pr) => pr.repo === MS && pr.number === 51));
  assert.equal(calls.filter((c) => c.args[1] === "graphql" && c.args.includes("name=example-repo")).length, 2);
  assert.deepEqual(first.sources.prs.failed, []);
  assert.match(PR_QUERY, /after: \$cursor/);
  assert.match(PR_QUERY, /pageInfo \{ hasNextPage endCursor \}/);

  for (const badPage of [new Error("page two unavailable"), "not json", JSON.stringify({ errors: [{ message: "partial" }], data: { repository: { pullRequests: { nodes: [node(52)] } } } }),
    page([], true, "older-page"), page([], true, null)]) {
    failure = badPage;
    const later = new Date(NOW.getTime() + 60_000);
    const stale = await collectGithub({ exec, ghBin: "gh", now: () => later, cache });
    assert.deepEqual(stale.prs, first.prs, "no partial page replaces the complete list");
    assert.deepEqual(stale.sources.prs, { failed: ["example-repo"], at: NOW.toISOString() });
  }
  failure = null;
  const recovered = await collectGithub({ exec, ghBin: "gh", now: () => NOW, cache });
  assert.deepEqual(recovered.sources.prs.failed, []);
});

test("collectGithub bounds pagination at MAX_PRS and limits requests for short pages", async () => {
  for (const pageSize of [50, 49, 1]) {
    let pages = 0;
    const { exec } = fakeExec((bin, args) => {
      if (args[1] !== "graphql" || !args.includes("name=example-repo")) return ghAnswer(bin, args);
      const offset = pages++ * pageSize;
      return JSON.stringify({ data: { repository: { pullRequests: {
        nodes: Array.from({ length: pageSize }, (_, i) => ({ ...PR_DOC.data.repository.pullRequests.nodes[0], number: offset + i + 1 })),
        pageInfo: { hasNextPage: true, endCursor: `page-${pages}` },
      } } } });
    });
    const cache = emptyGithubCache();
    const previous = parsePullRequests(MS, JSON.stringify(PR_DOC));
    cache.prs.set(MS, { value: previous, at: NOW.toISOString(), ok: true });
    const snap = await collectGithub({ exec, ghBin: "gh", now: () => NOW, cache });
    assert.equal(pages, MAX_PRS / 50);
    if (pageSize === 50) {
      assert.equal(snap.prs.filter((pr) => pr.repo === MS).length, MAX_PRS);
      assert.deepEqual(snap.sources.prs.failed, []);
    } else {
      assert.deepEqual(snap.prs.filter((pr) => pr.repo === MS), previous);
      assert.deepEqual(snap.sources.prs.failed, ["example-repo"], "request exhaustion cannot publish an incomplete list as fresh");
    }
    assert.ok(snap.prs.length <= MAX_PRS);
  }
});

test("collectGithub survives a failing repo and optional parts", async () => {
  const { exec } = fakeExec((bin, args) => {
    if (args.includes("owner=example-org") && args.includes("name=other-repo")) return new Error("boom");
    if (args.join(" ").includes("/actions/runners")) return new Error("403");
    return ghAnswer(bin, args);
  });
  /** @type {string[]} */
  const events = [];
  const snap = await collectGithub({ exec, ghBin: "gh", now: () => NOW, cache: emptyGithubCache(), log: (e) => events.push(e) });
  assert.equal(snap.prs.length, 2);
  assert.equal(snap.runners, null);
  assert.deepEqual(snap.sources.prs, { failed: ["other-repo"], at: null });
  assert.deepEqual(snap.sources.runners, { failed: ["example-repo"], at: null });
  assert.deepEqual(snap.sources.runs, { failed: [], at: null });
  assert.ok(events.includes("ops-github-prs-failed"));
  assert.ok(events.includes("ops-github-runners-failed"));
});

test("collectGithub keeps red main and the last PRs through a failed fetch, and says so", async () => {
  const cache = emptyGithubCache();
  const first = await collectGithub({ exec: fakeExec(ghAnswer).exec, ghBin: "gh", now: () => NOW, cache });
  assert.equal(first.runs[0].conclusion, "failure");
  assert.deepEqual(first.sources.runs, { failed: [], at: null });

  const later = new Date(NOW.getTime() + 60_000);
  const { exec } = fakeExec((bin, args) => (args.includes("name=example-repo") || args.join(" ").includes("/actions/") ? new Error("503") : ghAnswer(bin, args)));
  const snap = await collectGithub({ exec, ghBin: "gh", now: () => later, cache });
  assert.equal(snap.at, later.toISOString());
  assert.equal(snap.runs[0].id, 900, "main's last runs are kept, not replaced by an empty list");
  assert.equal(snap.runs[0].conclusion, "failure");
  assert.equal(snap.prs.length, 4, "the failed repo's PRs are kept");
  assert.equal(snap.prsComplete, first.prsComplete);
  assert.deepEqual(snap.runners, first.runners);
  assert.deepEqual(snap.queue, first.queue);
  assert.deepEqual(snap.sources.runs, { failed: ["example-repo"], at: NOW.toISOString() });
  assert.deepEqual(snap.sources.prs, { failed: ["example-repo"], at: NOW.toISOString() });
  assert.deepEqual(snap.sources.runners, { failed: ["example-repo"], at: NOW.toISOString() });

  const recovered = await collectGithub({ exec: fakeExec(ghAnswer).exec, ghBin: "gh", now: () => later, cache });
  assert.deepEqual(recovered.sources.runs, { failed: [], at: null });
  assert.deepEqual(recovered.sources.prs, { failed: [], at: null });
});

test("collectGithub looks a rerun's failed jobs up again", async () => {
  const cache = emptyGithubCache();
  await collectGithub({ exec: fakeExec(ghAnswer).exec, ghBin: "gh", now: () => NOW, cache });
  const rerun = RUNS.map((run) => (run.databaseId === 900 ? { ...run, attempt: 2 } : run));
  const { exec, calls } = fakeExec((bin, args) => {
    if (mainRunsOf(args)) return mainRunsOf(args) === MS ? JSON.stringify(rerun) : "[]";
    if (args.join(" ").includes("/actions/runs/900/jobs")) return JSON.stringify(["e2e"]);
    return ghAnswer(bin, args);
  });
  const snap = await collectGithub({ exec, ghBin: "gh", now: () => NOW, cache });
  assert.ok(calls.some((c) => c.args.join(" ").includes("/runs/900/jobs")));
  assert.equal(snap.runs[0].attempt, 2);
  assert.deepEqual(snap.runs[0].failedJobs, ["e2e"]);
});

test("parseDf and volumesFrom send fixed labels only, never a path or a disk's name", () => {
  const rows = parseDf(`${DF}/dev/disk9s1 1000 500 500 50% /Volumes/Sam Photos\n/dev/disk8s1 2000 500 1500 25% /Volumes/Backup\n`);
  const volumes = volumesFrom(rows, "/dev/disk5s1");
  assert.deepEqual(volumes, [
    { label: "Data", totalBytes: 971350180 * 1024, freeBytes: 106223244 * 1024, runners: false },
    { label: "External 1", totalBytes: 2000 * 1024, freeBytes: 1500 * 1024, runners: false },
    { label: "Runners", totalBytes: 1953514584 * 1024, freeBytes: 53514584 * 1024, runners: true },
    { label: "External 2", totalBytes: 1000 * 1024, freeBytes: 500 * 1024, runners: false },
  ]);
  const sent = JSON.stringify(volumes);
  for (const leak of ["/", "Scratch", "Photos", "Backup", "Sam"]) assert.ok(!sent.includes(leak), leak);
  const onData = volumesFrom(rows, "/dev/disk3s5");
  assert.deepEqual(onData.map((v) => [v.label, v.runners]), [["Data", true], ["External 1", false], ["External 2", false], ["External 3", false]]);
  const rootOnly = volumesFrom(parseDf("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk1 100 50 50 50% /\n"), "/dev/disk1");
  assert.deepEqual(rootOnly, [{ label: "System", totalBytes: 102400, freeBytes: 51200, runners: true }]);
});

test("an opened installer disk image is no disk: read-only volumes under /Volumes are left out", () => {
  const readOnly = parseReadOnly(
    [
      "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
      "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)",
      "/dev/disk7s1 on /Volumes/Some App 1.0 (hfs, local, nodev, nosuid, read-only, noowners, quarantine, mounted by x)",
      "/dev/disk8s1 on /Volumes/Backup (apfs, local, nodev, nosuid, journaled, noowners)",
    ].join("\n"),
  );
  assert.deepEqual([...readOnly], ["/", "/Volumes/Some App 1.0"]);
  const rows = parseDf(`${DF}/dev/disk7s1 1000 999 1 100% /Volumes/Some App 1.0\n/dev/disk8s1 2000 500 1500 25% /Volumes/Backup\n`);
  const volumes = volumesFrom(rows, "/dev/disk5s1", readOnly);
  assert.deepEqual(volumes.map((v) => v.label), ["Data", "External 1", "Runners"]);
  assert.equal(volumes[1].totalBytes, 2000 * 1024);
  assert.ok(!JSON.stringify(volumes).includes(String(1000 * 1024)));
});

test("parseLaunchctl reads runner and chat supervisor liveness by label", () => {
  assert.deepEqual(parseLaunchctl(LAUNCHCTL), {
    runners: [
      { name: "mac-1", alive: true },
      { name: "mac-2", alive: false },
      { name: "mac-10", alive: true },
    ],
    chatRunner: false,
  });
  // A label holding a made-up token shape is sent as a word the server's pattern takes, never as read.
  const fake = `ghp_${"Fake0".repeat(8)}`;
  assert.deepEqual(parseLaunchctl(`PID\tStatus\tLabel\n7\t0\tactions.runner.owner-repo.${fake}\n`).runners, [{ name: "redacted", alive: true }]);
  // A made-up JWT shape spans dots: the whole label is judged, not just its last part.
  const jwt = `eyJ${"hbGciOiJIUzI1NiJ9"}.eyJ${"zdWIiOiJmYWtlIn0"}.${"Fake0".repeat(8)}`;
  assert.deepEqual(parseLaunchctl(`PID\tStatus\tLabel\n7\t0\tactions.runner.owner-repo.${jwt}\n`).runners, [{ name: "redacted", alive: true }]);
  assert.equal(pressureOf("1\n"), "normal");
  assert.equal(pressureOf("2"), "warn");
  assert.equal(pressureOf("4"), "critical");
});

test("collectMac runs fixed binaries and reports load, memory and uptime", async () => {
  const { exec, calls } = fakeExec((bin, args) => {
    if (bin === "/bin/df" && args.length === 2) return DF;
    if (bin === "/bin/df") return "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 971350180 850022112 106223244 89% /System/Volumes/Data\n";
    if (bin === "/usr/sbin/sysctl" && args[1] === "kern.memorystatus_level") return "37\n";
    if (bin === "/usr/sbin/sysctl") return "2\n";
    if (bin === "/bin/launchctl") return LAUNCHCTL;
    if (bin === "/sbin/mount") return "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled)\n";
    return new Error("unexpected");
  });
  const host = { hostname: () => "sam-mac", loadavg: () => [3.456, 2.5, 1], cpus: () => /** @type {any} */ (new Array(12).fill({})), uptime: () => 86_400.7 };
  const mac = await collectMac({ exec, now: () => NOW, host, runnerRoot: "/nowhere/actions-runner", env: {} });
  assert.equal(mac.at, NOW.toISOString());
  assert.equal(mac.volumes[0].runners, true);
  assert.deepEqual(mac.load, { one: 3.46, five: 2.5, fifteen: 1, cpus: 12 });
  assert.deepEqual(mac.memory, { freePct: 37, pressure: "warn" });
  assert.equal(mac.uptimeSec, 86_400);
  assert.equal(mac.name, "sam-mac");
  assert.equal(mac.chatRunner, false);
  assert.equal(mac.runners.length, 3);
  assert.ok(!JSON.stringify(mac).includes("/nowhere"));
  assert.deepEqual(
    [...new Set(calls.map((c) => c.bin))],
    ["/bin/df", "/sbin/mount", "/usr/sbin/sysctl", "/bin/launchctl"],
  );
  const named = await collectMac({ exec, now: () => NOW, host, runnerRoot: "/nowhere/actions-runner", env: { RIVET_MACHINE_NAME: "  Build box  " } });
  assert.equal(named.name, "Build box", "the setting wins over the host name");
  const blank = await collectMac({ exec, now: () => NOW, host, runnerRoot: "/nowhere/actions-runner", env: { RIVET_MACHINE_NAME: "   " } });
  assert.equal(blank.name, "sam-mac");
});

test("collectMac reports unreadable memory as unknown and fails the pass without launchctl", async () => {
  let launchctl = true;
  const { exec } = fakeExec((bin) => {
    if (bin === "/bin/df") return DF;
    if (bin === "/usr/sbin/sysctl") return new Error("sysctl failed");
    if (bin === "/bin/launchctl") return launchctl ? LAUNCHCTL : new Error("launchctl failed");
    return new Error("unexpected");
  });
  const host = { hostname: () => "sam-mac", loadavg: () => [1, 1, 1], cpus: () => /** @type {any} */ ([{}]), uptime: () => 1 };
  const mac = await collectMac({ exec, now: () => NOW, host, runnerRoot: "/nowhere/actions-runner" });
  assert.deepEqual(mac.memory, { freePct: 0, pressure: "unknown" });
  launchctl = false;
  await assert.rejects(collectMac({ exec, now: () => NOW, host, runnerRoot: "/nowhere/actions-runner" }), /launchctl failed/);
});

test("flyApps reads the comma list in RIVET_FLY_APPS, and no setting means no apps", () => {
  assert.deepEqual(flyApps({ RIVET_FLY_APPS: "rivet-agents, example-app ,,Not An App" }), ["rivet-agents", "example-app"]);
  assert.deepEqual(flyApps({}), []);
});

test("parseFlyStatus keeps status fields only", () => {
  const status = parseFlyStatus(JSON.stringify(FLY_STATUS));
  assert.deepEqual(status, {
    status: "deployed",
    version: 42,
    sha: "c".repeat(12),
    machines: { started: 2, total: 3 },
    checks: { passing: 1, total: 2 },
    updatedAt: "2026-09-28T01:00:00.000Z",
  });
  const text = JSON.stringify(status);
  for (const secret of ["SECRET", "fdaa", "refused", "hidden-host"]) assert.ok(!text.includes(secret), secret);
});

test("parseReleases keeps 14 days of version, status, time and a well-formed image, never the author", () => {
  const releases = parseReleases(JSON.stringify(FLY_RELEASES), NOW);
  assert.deepEqual(releases, [
    { version: 42, status: "complete", at: "2026-09-28T01:00:00.000Z", image: "registry.example.test/rivet-agents:direct-bf616155653b-mus7f66d", sha: "bf616155653b" },
    { version: 41, status: "failed", at: "2026-09-27T01:00:00.000Z" },
    // Older than 14 days, kept as the last complete release before v41.
    { version: 3, status: "complete", at: "2026-08-01T01:00:00.000Z" },
  ]);
  assert.ok(!JSON.stringify(releases).includes("example.com"));
});

test("parseReleases always adds the last complete release before the oldest it keeps, within the cap", () => {
  const old = { Version: 1, Status: "complete", CreatedAt: "2026-08-01T01:00:00Z" };
  // Even when the oldest kept is complete: it is compared with its own baseline.
  const complete = parseReleases(JSON.stringify([{ Version: 2, Status: "complete", CreatedAt: "2026-09-27T01:00:00Z" }, old]), NOW);
  assert.deepEqual(complete.map((r) => r.version), [2, 1]);
  assert.deepEqual(parseReleases(JSON.stringify([old]), NOW), []);
  const many = Array.from({ length: MAX_RELEASES + 5 }, (_, i) => ({ Version: 100 - i, Status: "failed", CreatedAt: "2026-09-27T01:00:00Z" }));
  const capped = parseReleases(JSON.stringify([...many, old]), NOW);
  assert.equal(capped.length, MAX_RELEASES);
  assert.deepEqual(capped.at(-1), { version: 1, status: "complete", at: "2026-08-01T01:00:00.000Z" });
});

test("collectFly skips invalid app names and a failing app", async () => {
  const { exec, calls } = fakeExec((_bin, args) => {
    if (args.at(-1) === "example-down") return new Error("Could not find App");
    return JSON.stringify(args[0] === "status" ? FLY_STATUS : FLY_RELEASES);
  });
  const snap = await collectFly({ exec, flyBin: "/opt/flyctl", apps: ["rivet-agents", "example-down", "Bad;rm -rf", "-a"], now: () => NOW });
  assert.deepEqual(
    snap.apps.map((a) => a.app),
    ["rivet-agents"],
  );
  assert.equal(snap.apps[0].releases.length, 3);
  assert.deepEqual(calls[0], { bin: "/opt/flyctl", args: ["status", "--json", "-a", "rivet-agents"] });
  assert.ok(calls.every((c) => c.args.at(-1) === "rivet-agents" || c.args.at(-1) === "example-down"));
  assert.deepEqual(snap.source, { failed: ["example-down"], at: null });
});

test("collectFly keeps each app's last good data through a failed fetch, and says so", async () => {
  let loggedOut = false;
  const { exec } = fakeExec((_bin, args) => (loggedOut ? new Error("not logged in") : JSON.stringify(args[0] === "status" ? FLY_STATUS : FLY_RELEASES)));
  const cache = emptyFlyCache();
  const apps = ["rivet-agents"];
  const first = await collectFly({ exec, flyBin: "/opt/flyctl", apps, now: () => NOW, cache });
  assert.deepEqual(first.source, { failed: [], at: null });
  loggedOut = true;
  const later = new Date(NOW.getTime() + 5 * 60_000);
  const failed = await collectFly({ exec, flyBin: "/opt/flyctl", apps, now: () => later, cache });
  assert.equal(failed.at, later.toISOString());
  assert.deepEqual(failed.apps, first.apps);
  assert.deepEqual(failed.source, { failed: ["rivet-agents"], at: NOW.toISOString() });
  loggedOut = false;
  const back = await collectFly({ exec, flyBin: "/opt/flyctl", apps, now: () => later, cache });
  assert.deepEqual(back.source, { failed: [], at: null });
});

test("runOpsLoop PUTs each snapshot with the bridge token and backs off on 401", async () => {
  const usageDir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-usage-"));
  const usageFile = path.join(usageDir, "claude-usage.json");
  /** @type {{ method: string, url: string, auth: string | null, body: any }[]} */
  const seen = [];
  const stop = new AbortController();
  const token = "ab".repeat(32);
  /** @type {typeof fetch} */
  const fetchFn = async (input, init) => {
    const url = String(input);
    seen.push({ method: String(init?.method), url, auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/ops/github")) return new Response("{}", { status: 401 });
    if (url === USAGE_URL) return new Response(JSON.stringify(USAGE_BODY));
    return new Response("{}");
  };
  const { exec } = fakeExec((bin, args) => {
    if (bin === "/usr/bin/security") return CREDENTIALS;
    if (bin === "/opt/flyctl") return JSON.stringify(args[0] === "status" ? FLY_STATUS : FLY_RELEASES);
    if (bin === "/bin/df") return DF;
    if (bin === "/usr/sbin/sysctl") return "50\n";
    if (bin === "/bin/launchctl") return LAUNCHCTL;
    return ghAnswer(bin, args);
  });
  /** @type {number[]} */
  const sleeps = [];
  /** @type {string[]} */
  const events = [];
  const done = runOpsLoop({
    origin: "https://rivet.test",
    token,
    fetch: fetchFn,
    exec,
    ghBin: "gh",
    flyBin: "/opt/flyctl",
    log: (e) => events.push(e),
    stop: stop.signal,
    now: () => NOW,
    usageFile,
    holdsFile: null,
    sleep: async (ms) => {
      sleeps.push(ms);
      stop.abort();
    },
  });
  await done;
  const puts = seen.filter((s) => s.method === "PUT");
  assert.deepEqual(puts.map((s) => s.url).sort(), [
    "https://rivet.test/api/bridge/ops/backlog",
    "https://rivet.test/api/bridge/ops/claude",
    "https://rivet.test/api/bridge/ops/fly",
    "https://rivet.test/api/bridge/ops/github",
    "https://rivet.test/api/bridge/ops/mac",
  ]);
  assert.ok(seen.filter((s) => s.url.startsWith("https://rivet.test/")).every((s) => s.auth === `Bearer ${token}`));
  // The Claude sign-in goes to the usage endpoint only, never to the Rivet server.
  assert.deepEqual(seen.filter((s) => s.auth === `Bearer ${CLAUDE_TOKEN}`).map((s) => s.url), [USAGE_URL]);
  assert.ok(!seen.some((s) => JSON.stringify(s.body ?? "").includes(CLAUDE_TOKEN)));
  assert.equal(puts.find((s) => s.url.endsWith("/claude"))?.body.limits[0].percent, 85);
  assert.deepEqual(Object.keys(puts.find((s) => s.url.endsWith("/claude"))?.body).sort(), ["at", "limits"]);
  const file = JSON.parse(fs.readFileSync(usageFile, "utf8"));
  assert.deepEqual(file.session, { percent: 85, resetsAt: "2026-09-28T04:30:00.400Z" });
  assert.equal(file.limits.length, 3);
  fs.rmSync(usageDir, { recursive: true, force: true });
  assert.ok(sleeps.includes(CLAUDE_INTERVAL_MS));
  assert.deepEqual(
    puts.find((s) => s.url.endsWith("/fly"))?.body.apps.map((/** @type {any} */ a) => a.app),
    ["rivet-agents"],
  );
  assert.ok(sleeps.includes(OPS_INTERVAL_MS));
  assert.ok(sleeps.includes(5 * 60_000), "a 401 backs off five minutes");
  assert.ok(events.includes("ops-github-failed"));
});

test("the github and Fly PUTs carry the merge commit and the release's source sha", async () => {
  const mergeSha = "d".repeat(40);
  const stop = new AbortController();
  const sent = new Map();
  const events = [];
  const { exec } = fakeExec((bin, args) => {
    if (bin === "/opt/flyctl") return JSON.stringify(args[0] === "status" ? FLY_STATUS : FLY_RELEASES);
    if (bin === "gh" && args[0] === "pr" && args.includes("merged")) return JSON.stringify([
      { number: 3524, title: "Rivet: patch notes", url: `https://github.com/${MS}/pull/3524`, mergedAt: NOW.toISOString(), mergeCommit: { oid: mergeSha } },
    ]);
    return bin.startsWith("/") ? (bin === "/bin/df" ? DF : bin === "/bin/launchctl" ? LAUNCHCTL : "1\n") : ghAnswer(bin, args);
  });
  await runOpsLoop({
    origin: "https://rivet.test", token: "ab".repeat(32), exec, ghBin: "gh", flyBin: "/opt/flyctl",
    fetch: async (input, init) => {
      if (init?.method === "PUT") sent.set(String(input).split("/").at(-1), JSON.parse(String(init.body)));
      return new Response("{}");
    },
    log: (event) => events.push(event), stop: stop.signal, now: () => NOW,
    usageFile: null, holdsFile: null, sleep: async () => stop.abort(),
  });
  assert.equal(sent.get("github").merged[0].mergeSha, mergeSha);
  assert.equal(sent.get("fly").apps[0].releases[0].sha, "bf616155653b");
  assert.ok(!events.includes("ops-github-failed"));
  assert.ok(!events.includes("ops-fly-failed"));
});

test("runOpsLoop without flyctl runs no Fly loop", async () => {
  const stop = new AbortController();
  /** @type {string[]} */
  const urls = [];
  /** @type {string[]} */
  const events = [];
  const { exec } = fakeExec((bin, args) => (bin.startsWith("/") ? (bin === "/bin/df" ? DF : bin === "/bin/launchctl" ? LAUNCHCTL : "1\n") : ghAnswer(bin, args)));
  await runOpsLoop({
    origin: "https://rivet.test",
    token: "ab".repeat(32),
    fetch: async (input) => {
      urls.push(String(input));
      return new Response("{}");
    },
    exec,
    ghBin: "gh",
    flyBin: null,
    log: (e) => events.push(e),
    stop: stop.signal,
    now: () => NOW,
    usageFile: null,
    holdsFile: null,
    sleep: async () => stop.abort(),
  });
  assert.ok(events.includes("ops-fly-off"));
  assert.ok(!urls.some((u) => u.includes("fly")));
});

const CLAUDE_TOKEN = "sk-ant-oat01-" + "x".repeat(40);
const CREDENTIALS = JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE_TOKEN, refreshToken: "r", expiresAt: NOW.getTime() + 3600_000 } });
const USAGE_BODY = {
  five_hour: { utilization: 85, resets_at: "2026-09-28T04:30:00.4+00:00" },
  limits: [
    { kind: "session", group: "session", percent: 85, severity: "warning", resets_at: "2026-09-28T04:30:00.4+00:00", scope: null, is_active: true },
    { kind: "weekly_all", group: "weekly", percent: 43.26, severity: "normal", resets_at: "2026-10-03T17:00:00+00:00", scope: null, is_active: false },
    { kind: "weekly_scoped", group: "weekly", percent: 22, severity: "odd", resets_at: null, scope: { model: { display_name: "Fable\u0007" } }, is_active: false },
    { kind: "Bad Kind", percent: 10 },
    { kind: "session", percent: "85" },
  ],
};

test("parseUsage redacts a scope's display name before it is cut", () => {
  // A made-up secret shape only.
  const [row] = parseUsage({ limits: [{ kind: "weekly_opus", percent: 10, scope: { model: { display_name: "password=not-a-real-pass-42" } } }] });
  assert.match(row.label, /^Week \(password=\s?\[redacted\]\)$/);
  // A kind is the row's key: one holding a made-up token shape is not sent at all.
  assert.deepEqual(parseUsage({ limits: [{ kind: `ghp_${"fake0".repeat(7)}f`, percent: 10 }, { kind: "session", percent: 5 }] }).map((r) => r.kind), ["session"]);
});

test("parseUsage keeps the server's rows, labels and severity, and drops malformed ones", () => {
  assert.deepEqual(parseUsage(USAGE_BODY), [
    { kind: "session", label: "Session (5 hr)", percent: 85, severity: "warning", resetsAt: "2026-09-28T04:30:00.400Z", active: true },
    { kind: "weekly_all", label: "Week (all models)", percent: 43.3, severity: "normal", resetsAt: "2026-10-03T17:00:00.000Z", active: false },
    { kind: "weekly_scoped", label: "Week (Fable)", percent: 22, severity: "normal", resetsAt: null, active: false },
  ]);
  assert.throws(() => parseUsage({ five_hour: { utilization: 10 } }), /no limits/);
  assert.throws(() => parseUsage(null), /no limits/);
});

test("readClaudeToken reads the Keychain item, and never puts the token in an error", async () => {
  const { exec, calls } = fakeExec(() => CREDENTIALS);
  assert.equal(await readClaudeToken(exec, () => NOW), CLAUDE_TOKEN);
  assert.deepEqual(calls[0], { bin: "/usr/bin/security", args: ["find-generic-password", "-s", "Claude Code-credentials", "-w"] });
  const expired = fakeExec(() => JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE_TOKEN, expiresAt: NOW.getTime() - 1 } }));
  await assert.rejects(readClaudeToken(expired.exec, () => NOW), (err) => /expired/.test(String(err)) && !String(err).includes(CLAUDE_TOKEN));
  await assert.rejects(readClaudeToken(fakeExec(() => new Error("no item")).exec, () => NOW), /no Claude Code sign-in/);
  await assert.rejects(readClaudeToken(fakeExec(() => "{}").exec, () => NOW), /no access token/);
});

test("writeUsageFile writes session and weekly shortcuts atomically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-usage-"));
  const file = path.join(dir, "nested", "claude-usage.json");
  const limits = parseUsage(USAGE_BODY);
  writeUsageFile({ at: NOW.toISOString(), limits }, file);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(doc.weekly, { percent: 43.3, resetsAt: "2026-10-03T17:00:00.000Z" });
  assert.equal(doc.limits.length, 3);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["claude-usage.json"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("limitedUsage gives the last reading of a limited week until its reset, and nothing else", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-usage-"));
  const file = path.join(dir, "claude-usage.json");
  const resetsAt = new Date(NOW.getTime() + 30 * 3_600_000).toISOString();
  const at = new Date(NOW.getTime() - 3_600_000).toISOString();
  const usage = (percent, resets = resetsAt) => writeUsageFile({ at, limits: [{ kind: "session", label: "Session (5 hr)", percent: 40, severity: "normal", resetsAt: null, active: false }, { kind: "weekly_all", label: "Week (all models)", percent, severity: "critical", resetsAt: resets, active: false }] }, file);
  usage(100);
  assert.deepEqual(limitedUsage({ file, now: () => NOW }), {
    at,
    limits: [{ kind: "weekly_all", label: "Week (all models), limited, 60 min old", percent: 100, severity: "critical", resetsAt, active: false }],
  });
  assert.equal(limitedUsage({ file, now: () => new Date(NOW.getTime() + 31 * 3_600_000) }), null, "past its reset the week is no longer limited");
  usage(99);
  assert.equal(limitedUsage({ file, now: () => NOW }), null);
  usage(100, null);
  assert.equal(limitedUsage({ file, now: () => NOW }), null, "no reset time, no claim");
  assert.equal(limitedUsage({ file: path.join(dir, "missing.json"), now: () => NOW }), null);
  assert.equal(limitedUsage({ file: null }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("iso returns null past year 9999 instead of throwing or writing a six-digit year", () => {
  assert.equal(iso(1e20), null);
  assert.equal(iso(8.64e15), null);
  assert.equal(iso(Date.UTC(9999, 11, 31, 23, 59, 59, 999)), "9999-12-31T23:59:59.999Z");
  assert.equal(iso(Date.parse("2026-10-01T00:00:00Z")), "2026-10-01T00:00:00.000Z");
});

// briefing-note.mjs against a local server.
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "briefing-note.mjs");
const NOTE_TOKEN = "ef".repeat(32);
/** @type {{ url?: string, auth?: string, body: string }[]} */
const noted = [];
let noteStatus = 200;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    noted.push({ url: req.url, auth: req.headers.authorization, body });
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${NOTE_TOKEN}`) return res.writeHead(401).end("{}");
    if (noteStatus === 404) return res.writeHead(404).end('{"error":"no briefing yet"}');
    res.end('{"briefing":"2026-09-28-am","notes":1}');
  });
});
let origin = "";
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  origin = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});
after(() => server.close());

/** @param {string[]} args @returns {Promise<{ code: number, stdout: string, stderr: string }>} */
function note(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { PATH: process.env.PATH, RIVET_URL: origin, RIVET_BRIDGE_DEV: "1", RIVET_BRIDGE_TOKEN: NOTE_TOKEN }, timeout: 20_000 },
      (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code) : 0, stdout, stderr }),
    );
  });
}

test("briefing-note posts one line with the bridge token", async () => {
  noteStatus = 200;
  const r = await note(["--text", "The site\nis back up"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /noted on 2026-09-28-am/);
  assert.deepEqual(noted.at(-1), { url: "/api/bridge/briefing-note", auth: `Bearer ${NOTE_TOKEN}`, body: JSON.stringify({ text: "The site / is back up" }) });
});

test("briefing-note refuses empty, long and unknown input before sending", async () => {
  const count = noted.length;
  assert.equal((await note(["--text", "   "])).code, 2);
  assert.equal((await note(["--text", "x".repeat(281)])).code, 2);
  assert.equal((await note(["--bogus"])).code, 2);
  assert.equal((await note([])).code, 2);
  assert.equal(noted.length, count);
});

test("briefing-note explains a missing briefing", async () => {
  noteStatus = 404;
  const r = await note(["--text", "hello"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no briefing yet/);
});

test("ops snapshot PUT retries once without the fields the server rejected", async () => {
  const stop = new AbortController();
  const github = [];
  const { exec } = fakeExec((bin, args) => {
    if (bin === "/usr/bin/security") throw new Error("no credentials");
    if (bin === "/bin/df") return DF;
    if (bin === "/usr/sbin/sysctl") return "50\n";
    if (bin === "/bin/launchctl") return LAUNCHCTL;
    if (args[0] === "api" && args[1] === "graphql") {
      const doc = structuredClone(PR_DOC);
      for (const pr of doc.data.repository.pullRequests.nodes) Object.assign(pr, { headRefName: "feature/compat", isCrossRepository: false });
      return JSON.stringify(doc);
    }
    return ghAnswer(bin, args);
  });
  await runOpsLoop({
    origin: "https://rivet.test", token: "ab".repeat(32), exec, ghBin: "gh", flyBin: null,
    fetch: async (url, init) => {
      if (String(url).endsWith("/ops/github")) {
        const body = JSON.parse(init.body);
        github.push(body);
        return Response.json({ issues: [{ code: "unrecognized_keys", path: ["prs", 0], keys: ["branch"] }] }, { status: 400 });
      }
      return Response.json({});
    },
    log: () => {}, stop: stop.signal, now: () => NOW, usageFile: null, holdsFile: null,
    sleep: async () => { stop.abort(); },
  });
  assert.equal(github.length, 2);
  assert.ok(github[0].prs.length > 0);
  assert.ok(github[0].prs.some((pr) => "branch" in pr));
  assert.ok(github[1].prs.every((pr) => !("branch" in pr)));
});

test("PR, run and merged titles, labels and branches reach the Ops tab redacted", () => {
  const branch = `fix/${TOKEN}`;
  const pr = { ...PR_DOC.data.repository.pullRequests.nodes[0], isCrossRepository: false, headRefName: branch,
    title: "Rotate API_KEY=hunter2", labels: { nodes: [{ name: `label ${TOKEN}` }] } };
  const prs = parsePullRequests(MS, JSON.stringify({ data: { repository: { pullRequests: { nodes: [pr] } } } }));
  const runs = parseRuns(MS, JSON.stringify([{ ...RUNS[0], displayTitle: "Rotate API_KEY=hunter2" }]));
  const merged = parseMerged(MS, JSON.stringify([{ number: 8, url: "https://github.com/example-org/example-repo/pull/8", mergedAt: "2026-10-09T00:00:00Z", isCrossRepository: false,
    headRefName: branch, title: `Rotate ${TOKEN}`, author: { login: "alice" } }]));
  assert.deepEqual([prs.length, runs.length, merged.length], [1, 1, 1], "every row read");
  const said = JSON.stringify({ prs, runs, merged });
  assert.ok(!said.includes("hunter2") && !showsToken(said), said);
  assert.equal(prs[0].branch ?? null, null);
  assert.equal(merged[0].branch ?? null, null);
});

test("the Ops snapshot carries no secret from a label, a workflow name or a failed job, and a hold label stays readable", async () => {
  const node = { ...PR_DOC.data.repository.pullRequests.nodes[0], labels: { nodes: [{ name: "hold API_KEY=hunter2" }] } };
  const doc = { data: { repository: { pullRequests: { ...PR_DOC.data.repository.pullRequests, nodes: [node] } } } };
  const { exec } = fakeExec((bin, args) => {
    if (args[0] === "api" && args[1] === "graphql") return JSON.stringify(doc);
    if (mainRunsOf(args) === MS) return JSON.stringify(RUNS.map((run) => ({ ...run, workflowName: "CI API_KEY=hunter2" })));
    if (args.join(" ").includes("/actions/runs/900/jobs")) return JSON.stringify(["unit API_KEY=hunter2"]);
    return ghAnswer(bin, args);
  });
  const snap = await collectGithub({ exec, ghBin: "gh", now: () => NOW, cache: emptyGithubCache() });
  const said = JSON.stringify(snap);
  assert.ok(snap.prs.length && snap.runs.length, "rows read");
  assert.ok(!said.includes("hunter2"), said);
  const pr = snap.prs.find((p) => p.number === node.number);
  assert.match(pr.labels[0], /^hold /);
});

test("workflow, check and failed-job names are redacted whole before they are clipped: no token head reaches Ops", () => {
  const names = ["ok ".repeat(35) + TOKEN, `${"job ".repeat(27)}  ${TOKEN}`, "safe ".repeat(22) + TOKEN, ...[...paddings(120)].map(({ padding }) => padding + TOKEN)];
  for (const name of names) {
    const [run] = parseRuns(MS, JSON.stringify([{ ...RUNS[0], workflowName: name }]));
    const [job] = parseJobNames(JSON.stringify([name]));
    const { failing } = checksSummary([{ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "FAILURE" }]);
    for (const said of [run.workflow, job ?? "", failing[0]]) {
      assert.ok(!showsToken(said) && said.length <= 120, `${JSON.stringify(name.slice(0, 30))}…: ${said}`);
    }
  }
});

test("the Ops snapshot's last pass keeps a field in its bound, a PR author's login as it is, and a patterned field one its pattern takes", async () => {
  const author = "a1".repeat(16);
  const name = `${"ok ".repeat(34)}password=x`;
  const nodes = PR_DOC.data.repository.pullRequests.nodes.map((n) => (n.number === 2177 ? { ...n, author: { login: author } } : n));
  const doc = { data: { repository: { pullRequests: { ...PR_DOC.data.repository.pullRequests, nodes } } } };
  const { exec } = fakeExec((bin, args) => {
    if (args[0] === "api" && args[1] === "graphql") return JSON.stringify(doc);
    if (mainRunsOf(args) === MS) return JSON.stringify(RUNS.map((run) => ({ ...run, workflowName: name })));
    if (args.join(" ").includes("/actions/runs/900/jobs")) return JSON.stringify([name]);
    if (args.join(" ").includes("/actions/runners")) return JSON.stringify({ total_count: 1, runners: [{ name: author, status: "online", busy: false }] });
    return ghAnswer(bin, args);
  });
  const snap = await collectGithub({ exec, ghBin: "gh", now: () => NOW, cache: emptyGithubCache() });
  assert.equal(name.length, 112);
  assert.deepEqual(snap.runners?.runners.map((r) => r.name), ["redacted"]);
  assert.ok(snap.runs.length, "runs read");
  for (const run of snap.runs) {
    assert.ok(run.workflow.length <= 120 && !run.workflow.includes("=x"), run.workflow);
    for (const job of run.failedJobs ?? []) assert.ok(job.length <= 120 && !job.includes("=x"), job);
  }
  assert.equal(snap.prs.find((pr) => pr.number === 2177)?.author, author);
});

test("a run's failed jobs are read 50 to a page, every page", async () => {
  const { exec, calls } = fakeExec((bin, args) => {
    if (args.join(" ").includes("/actions/runs/900/jobs")) return `${JSON.stringify(["unit"])}\n${JSON.stringify(["e2e"])}\n`;
    return ghAnswer(bin, args);
  });
  const snap = await collectGithub({ exec, ghBin: "gh", now: () => NOW, cache: emptyGithubCache() });
  const read = calls.find((c) => c.args.join(" ").includes("/runs/900/jobs"));
  assert.ok(read.args.some((arg) => /\/jobs\?per_page=50&/.test(arg)) && read.args.includes("--paginate"));
  assert.deepEqual(snap.runs.find((run) => run.failedJobs?.length)?.failedJobs, ["unit", "e2e"]);
  assert.throws(() => parseJobNames(""), /no jobs/);
});

async function claudePut({ security, lastUsage = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-usage-"));
  if (lastUsage) writeUsageFile(lastUsage, path.join(dir, "claude-usage.json"));
  /** @type {{ url: string, body: any }[]} */
  const puts = [];
  /** @type {{ event: string, fields: any }[]} */
  const events = [];
  const stop = new AbortController();
  const { exec } = fakeExec((bin, args) => {
    if (bin === "/usr/bin/security") {
      if (security === "fail") throw new Error("no item");
      return CREDENTIALS;
    }
    if (bin === "/bin/df") return DF;
    if (bin === "/usr/sbin/sysctl") return "50\n";
    if (bin === "/bin/launchctl") return LAUNCHCTL;
    return ghAnswer(bin, args);
  });
  await runOpsLoop({
    origin: "https://rivet.test", token: "ab".repeat(32), exec, ghBin: "gh", flyBin: null,
    fetch: async (input, init) => {
      const url = String(input);
      if (init?.method === "PUT") puts.push({ url, body: JSON.parse(String(init.body)) });
      if (url === USAGE_URL) return new Response(JSON.stringify(USAGE_BODY));
      return new Response("{}");
    },
    log: (event, fields) => events.push({ event, fields }), stop: stop.signal, now: () => NOW,
    usageFile: path.join(dir, "claude-usage.json"), holdsFile: null,
    sleep: async () => stop.abort(),
  });
  return { events, claude: puts.filter((p) => p.url.endsWith("/ops/claude")), usage: path.join(dir, "claude-usage.json") };
}

test("a failed read on a limited account still PUTs its week at 100% with the reset, and leaves the usage file as it was", async () => {
  const at = new Date(NOW.getTime() - 3_600_000).toISOString();
  const resetsAt = new Date(NOW.getTime() + 30 * 3_600_000).toISOString();
  const week = (percent) => ({ kind: "weekly_all", label: "Week (all models)", percent, severity: "critical", resetsAt, active: false });
  const limited = await claudePut({ security: "fail", lastUsage: { at, limits: [week(100)] } });
  assert.ok(limited.events.some((e) => e.event === "ops-claude-usage-failed"));
  const body = limited.claude[0].body;
  assert.deepEqual(body.limits.find((/** @type {any} */ l) => l.kind === "weekly_all"), { ...week(100), label: "Week (all models), limited, 60 min old" });
  assert.equal(JSON.parse(fs.readFileSync(limited.usage, "utf8")).limits[0].label, "Week (all models)");
  // A week with room is not carried over: a failed read of it stays no reading.
  const room = await claudePut({ security: "fail", lastUsage: { at, limits: [week(60)] } });
  assert.equal(room.claude[0]?.body.limits.some((/** @type {any} */ l) => l.kind === "weekly_all") ?? false, false);
});

test("the Mac always sends chatRunner, from the supervisor's job", async () => {
  const listing = (rows) => `PID\tStatus\tLabel\n${rows.join("\n")}\n`;
  assert.equal(parseLaunchctl(listing(["123\t0\tdev.rivet-agents.chat-supervisor"])).chatRunner, true);
  assert.equal(parseLaunchctl(listing(["-\t0\tdev.rivet-agents.chat-supervisor"])).chatRunner, false);
  assert.equal(parseLaunchctl(listing(["123\t0\tdev.rivet-agents.other"])).chatRunner, false);
  const collect = (row) => collectMac({ exec: async (file) => ({ stdout: file.endsWith("launchctl") ? listing([row]) : "", stderr: "" }), now: () => new Date(0), runnerRoot: "/nowhere" });
  assert.equal((await collect("123\t0\tdev.rivet-agents.chat-supervisor")).chatRunner, true);
  assert.equal((await collect("123\t0\tdev.rivet-agents.other")).chatRunner, false);
});

