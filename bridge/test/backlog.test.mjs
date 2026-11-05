import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecError } from "../lib/config.mjs";
import { BACKLOG_MAX_BYTES, backlogArgs, backlogQuery, collectBacklog, fitBacklog, MAX_BUGS, MAX_CLOSED, MAX_OWNER, MAX_RECENT, parseBacklog } from "../lib/ops/backlog.mjs";

const NOW = new Date("2026-11-02T10:30:00.000Z");
const REPOS = Array.from({ length: 12 }, (_, i) => (i ? `example-org/repo-${i}` : "example-org/example-repo"));
const QUERY = backlogQuery(REPOS.length);
process.env.RIVET_REPOS = REPOS.join(",");

/** @param {number} number @param {Record<string, unknown>} [over] */
const issue = (number, over = {}) => ({ number, title: `Issue ${number}`, updatedAt: "2026-11-02T09:00:00Z", labels: { nodes: [{ name: "type:bug" }] }, ...over });

/** @param {Record<string, unknown>} [over] */
const repoNode = (over = {}) => ({
  open: { totalCount: 12 },
  logs: { totalCount: 2 },
  owner: { totalCount: 3, nodes: [issue(7, { labels: { nodes: [{ name: "autonomy:owner" }] } })] },
  recent: { nodes: [issue(9), issue(8)] },
  bugs: { nodes: [issue(9)] },
  ...over,
});

/** @param {(args: string[]) => Promise<{ stdout: string, stderr: string }>} answer */
function fakeExec(answer) {
  /** @type {{ bin: string, args: string[] }[]} */
  const calls = [];
  /** @type {import("../lib/config.mjs").Exec} */
  const exec = async (bin, args) => {
    calls.push({ bin, args });
    return answer(args);
  };
  return { exec, calls };
}

test("one gh graphql call reads every repo: a fixed query, each repo's owner and name passed as values", async () => {
  const data = Object.fromEntries(REPOS.map((_, i) => [`r${i}`, repoNode()]));
  const { exec, calls } = fakeExec(async () => ({ stdout: JSON.stringify({ data }), stderr: "" }));
  const snapshot = await collectBacklog({ exec, ghBin: "/usr/bin/gh", now: () => NOW });
  assert.equal(calls.length, 1);
  const [{ bin, args }] = calls;
  assert.equal(bin, "/usr/bin/gh");
  assert.deepEqual(args.slice(0, 3), ["api", "graphql", "-f"]);
  assert.equal(args[3], `query=${QUERY}`);
  for (const repo of REPOS) assert.ok(!QUERY.includes(repo.split("/")[1]), `${repo} is a value, not query text`);
  assert.ok(!/\bbody\b/.test(QUERY), "no bodies are asked for");
  assert.match(QUERY, /labels: \["type:log"\]/);
  assert.match(QUERY, /labels: \["autonomy:owner"\], first: 20/);
  assert.match(QUERY, new RegExp(`recent: issues\\(states: OPEN, first: ${MAX_RECENT},`));
  assert.equal(MAX_RECENT, 100);
  assert.ok(args.includes("o0=example-org") && args.includes("n0=example-repo"));
  assert.ok(args.includes("o1=example-org") && args.includes("n1=repo-1"));
  assert.deepEqual(args, backlogArgs(REPOS));
  assert.equal(snapshot.at, NOW.toISOString());
  assert.equal(snapshot.repos.length, REPOS.length);
  assert.deepEqual(snapshot.repos[0], {
    repo: REPOS[0],
    total: 12,
    logs: 2,
    ownerTotal: 3,
    owner: [{ number: 7, title: "Issue 7", updatedAt: "2026-11-02T09:00:00.000Z", labels: ["autonomy:owner"] }],
    recent: [
      { number: 9, title: "Issue 9", updatedAt: "2026-11-02T09:00:00.000Z", labels: ["type:bug"] },
      { number: 8, title: "Issue 8", updatedAt: "2026-11-02T09:00:00.000Z", labels: ["type:bug"] },
    ],
    bugs: [{ number: 9, title: "Issue 9", updatedAt: "2026-11-02T09:00:00.000Z", labels: ["type:bug"] }],
    closed: [],
  });
});

test("reads each repo's 50 latest closed issues, number, close time and reason only, so a Yes finishes when its issue closes", () => {
  assert.match(QUERY, new RegExp(`closed: issues\\(states: CLOSED, first: ${MAX_CLOSED}, orderBy: \\{ field: UPDATED_AT, direction: DESC \\}\\) \\{ nodes \\{ number closedAt stateReason \\} \\}`));
  assert.equal(MAX_CLOSED, 50);
  const nodes = [
    { number: 1, closedAt: "2026-11-02T09:00:00Z", stateReason: "COMPLETED" },
    { number: 2, closedAt: "2026-11-02T08:00:00Z", stateReason: "NOT_PLANNED" },
    { number: 3, closedAt: "2026-11-02T07:00:00Z", stateReason: "DUPLICATE" },
    { number: 4, closedAt: "2026-11-02T06:00:00Z", stateReason: null },
    { number: 5, closedAt: "2026-11-02T05:00:00Z", stateReason: "SOMETHING_NEW" },
    { number: 6, closedAt: null, stateReason: "COMPLETED" },
    { number: -1, closedAt: "2026-11-02T05:00:00Z", stateReason: "COMPLETED" },
  ];
  const closed = parseBacklog(JSON.stringify({ data: { r0: repoNode({ closed: { nodes } }) } }), NOW, REPOS).repos[0].closed;
  assert.deepEqual(closed, [
    { number: 1, closedAt: "2026-11-02T09:00:00.000Z", reason: "completed" },
    { number: 2, closedAt: "2026-11-02T08:00:00.000Z", reason: "not_planned" },
    { number: 3, closedAt: "2026-11-02T07:00:00.000Z", reason: "duplicate" },
    { number: 4, closedAt: "2026-11-02T06:00:00.000Z", reason: "completed" },
  ]);
  const many = Array.from({ length: 80 }, (_, i) => ({ number: i + 1, closedAt: "2026-11-02T05:00:00Z", stateReason: "COMPLETED" }));
  assert.equal(parseBacklog(JSON.stringify({ data: { r0: repoNode({ closed: { nodes: many } }) } }), NOW, REPOS).repos[0].closed.length, MAX_CLOSED);
});

test("reads each repo's first 20 open bugs", () => {
  assert.match(QUERY, new RegExp(`bugs: issues\\(states: OPEN, labels: \\["type:bug", "bug"\\], first: ${MAX_BUGS},`));
  assert.equal(MAX_BUGS, 20);
  const bugs = parseBacklog(JSON.stringify({ data: { r0: repoNode({ bugs: { nodes: Array.from({ length: 30 }, (_, i) => issue(i + 1)) } }) } }), NOW, REPOS).repos[0].bugs;
  assert.deepEqual(bugs.map((one) => one.number), Array.from({ length: MAX_BUGS }, (_, i) => i + 1));
});

test("caps rows, labels and titles, keeps no other field, and leaves out a repo GitHub could not read", () => {
  const many = (n) => Array.from({ length: n }, (_, i) => issue(i + 1, { body: "secret body", author: { login: "x" } }));
  const labels = { nodes: Array.from({ length: 15 }, (_, i) => ({ name: `label-${i}`.padEnd(80, "x") })) };
  const stdout = JSON.stringify({
    data: {
      r0: repoNode({ owner: { totalCount: 30, nodes: many(30) }, recent: { nodes: [...many(120), issue(99, { title: "T".repeat(500), labels })] } }),
      r1: null,
    },
  });
  const snapshot = parseBacklog(stdout, NOW, REPOS);
  assert.deepEqual(snapshot.repos.map((one) => one.repo), [REPOS[0]]);
  const [repo] = snapshot.repos;
  assert.equal(repo.owner.length, MAX_OWNER);
  assert.equal(repo.ownerTotal, 30);
  assert.equal(repo.recent.length, MAX_RECENT);
  for (const one of [...repo.owner, ...repo.recent]) assert.deepEqual(Object.keys(one).sort(), ["labels", "number", "title", "updatedAt"]);
  assert.ok(!JSON.stringify(snapshot).includes("secret body"));
  const long = parseBacklog(JSON.stringify({ data: { r0: repoNode({ recent: { nodes: [issue(99, { title: "T".repeat(500), labels })] } }) } }), NOW, REPOS).repos[0].recent[0];
  assert.ok(long.title.length <= 300);
  assert.equal(long.labels.length, 10);
  assert.ok(long.labels.every((name) => name.length <= 50));
});

test("a gh exit with the readable repos' answer on stdout keeps that answer; any other failure throws", async () => {
  const partial = JSON.stringify({ data: { r0: repoNode(), r1: null }, errors: [{ message: "Could not resolve to a Repository" }] });
  const failing = fakeExec(async () => {
    throw new ExecError("/usr/bin/gh", { code: 1 }, "gh: Could not resolve", partial);
  });
  const kept = await collectBacklog({ exec: failing.exec, ghBin: "/usr/bin/gh", now: () => NOW });
  assert.deepEqual(kept.repos.map((one) => one.repo), [REPOS[0]]);
  const down = fakeExec(async () => {
    throw new ExecError("/usr/bin/gh", { code: 1 }, "HTTP 502", "");
  });
  await assert.rejects(collectBacklog({ exec: down.exec, ghBin: "/usr/bin/gh", now: () => NOW }), /gh exit 1/);
  const junk = fakeExec(async () => ({ stdout: "not json", stderr: "" }));
  await assert.rejects(collectBacklog({ exec: junk.exec, ghBin: "/usr/bin/gh", now: () => NOW }), /non-JSON/);
});

test("a pass over the server's size cap is cut to fit, the newest lists first and the counts whole", () => {
  const row = (number) => ({ number, title: "x".repeat(300), updatedAt: "2026-11-02T09:00:00.000Z", labels: Array.from({ length: 10 }, (_, i) => `label-${i}-${"y".repeat(40)}`) });
  const rows = (n, from) => Array.from({ length: n }, (_, i) => row(from + i));
  const repos = REPOS.map((repo, r) => ({ repo, total: 500, logs: 0, ownerTotal: 20, owner: rows(MAX_OWNER, r * 1000), recent: rows(MAX_RECENT, r * 1000 + 100), bugs: rows(MAX_BUGS, r * 1000 + 300) }));
  const big = { at: NOW.toISOString(), repos };
  assert.ok(Buffer.byteLength(JSON.stringify(big)) > BACKLOG_MAX_BYTES);
  const fitted = fitBacklog(big);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= BACKLOG_MAX_BYTES);
  assert.ok(BACKLOG_MAX_BYTES < 512 * 1024);
  for (const [i, one] of fitted.repos.entries()) {
    assert.equal(one.total, 500);
    assert.equal(one.owner.length, MAX_OWNER);
    assert.ok(one.recent.length < MAX_RECENT);
    assert.deepEqual(one.recent, repos[i].recent.slice(0, one.recent.length));
  }
  const small = { at: NOW.toISOString(), repos: repos.slice(0, 1) };
  assert.equal(fitBacklog(small), small);
});

test("a pass whose owner rows alone pass the cap still fits, the owner's cut last", () => {
  const row = (number) => ({ number, title: "語".repeat(300), updatedAt: "2026-11-02T09:00:00.000Z", labels: Array.from({ length: 10 }, (_, i) => `${i}${"語".repeat(49)}`) });
  const repos = REPOS.map((repo, r) => ({ repo, total: 50, logs: 0, ownerTotal: 40, owner: Array.from({ length: MAX_OWNER }, (_, i) => row(r * 100 + i)), recent: [], bugs: [] }));
  const big = { at: NOW.toISOString(), repos };
  assert.ok(Buffer.byteLength(JSON.stringify(big)) > BACKLOG_MAX_BYTES);
  const fitted = fitBacklog(big);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= BACKLOG_MAX_BYTES);
  for (const [i, one] of fitted.repos.entries()) {
    assert.equal(one.ownerTotal, 40);
    assert.ok(one.owner.length < MAX_OWNER);
    assert.deepEqual(one.owner, repos[i].owner.slice(0, one.owner.length));
  }
});

