import assert from "node:assert/strict";
import { test } from "node:test";

import { BODY_MAX, createIssueFamily, ISSUE_QUERY, issueArgs, parseIssue } from "../lib/actions/issue.mjs";

// An issue opened in the app (event "issue.read"): one gh graphql call, then PUT /api/bridge/issue with the bridge token.

const REPO = "example-org/example-repo";
process.env.RIVET_REPOS = REPO;
const NOW = new Date("2026-11-03T02:50:00.000Z");
const ID = "issue-read-1";

const reply = (issue) => JSON.stringify({ data: { repository: { issue } } });
const ISSUE = {
  title: "Dark-theme chart draws the daily line indigo",
  body: "**What happens.** Indigo `#4b3bf5`.\n\nLine two",
  author: { login: "sam" },
  createdAt: "2026-11-02T03:10:00Z",
  state: "OPEN",
  url: "https://github.com/whatever",
  comments: { totalCount: 2 },
  labels: { nodes: [{ name: "type:bug" }, { name: "" }] },
};

test("asks for the one issue with the query fixed and the repo and number passed as values", () => {
  const args = issueArgs(REPO, 20);
  assert.deepEqual(args, ["api", "graphql", "-f", `query=${ISSUE_QUERY}`, "-f", "o=example-org", "-f", "n=example-repo", "-F", "i=20"]);
  assert.match(ISSUE_QUERY, /title body author \{ login \} createdAt state url comments \{ totalCount \} labels\(first: 10\)/);
});

test("keeps the body's lines, cuts the body and makes its own GitHub URL", () => {
  const detail = parseIssue(reply(ISSUE), REPO, 20, NOW);
  assert.deepEqual(detail, {
    repo: REPO,
    number: 20,
    title: "Dark-theme chart draws the daily line indigo",
    body: "**What happens.** Indigo `#4b3bf5`.\n\nLine two",
    author: "sam",
    createdAt: "2026-11-02T03:10:00.000Z",
    state: "open",
    url: `https://github.com/${REPO}/issues/20`,
    comments: 2,
    labels: ["type:bug"],
    at: NOW.toISOString(),
  });
  const closed = parseIssue(reply({ ...ISSUE, body: "Line one\nLine two", state: "CLOSED", author: null }), REPO, 20, NOW);
  assert.match(closed.body, /\n/);
  assert.equal(closed.state, "closed");
  assert.equal(closed.author, null);
  const long = parseIssue(reply({ ...ISSUE, body: "word ".repeat(10_000) }), REPO, 20, NOW);
  assert.ok(long.body.length <= BODY_MAX);
  assert.equal(parseIssue(reply(null), REPO, 20, NOW), null);
});

test("redacts a secret its author pasted", () => {
  const secret = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
  const detail = parseIssue(reply({ ...ISSUE, body: `token ${secret} here` }), REPO, 20, NOW);
  assert.ok(!detail.body.includes(secret));
});

test("reads on the event, PUTs the reading with the bridge token, and drops a repo off the list or a second read under way", async () => {
  /** @type {any[]} */
  const calls = [];
  /** @type {any[]} */
  const puts = [];
  let release = () => {};
  const gate = new Promise((resolve) => (release = resolve));
  const ctx = {
    deps: {
      origin: "https://rivet.example",
      token: "tok",
      ghBin: "/usr/local/bin/gh",
      log: () => {},
      exec: async (file, args) => {
        calls.push({ file, args });
        await gate;
        return { stdout: reply(ISSUE), stderr: "" };
      },
      fetch: async (url, init) => {
        puts.push({ url, init });
        return new Response("{}", { status: 200 });
      },
    },
  };
  const family = createIssueFamily({ now: () => NOW });
  assert.deepEqual([...family.events], ["issue.read"]);
  assert.equal(await family.handle("issue.read", { id: ID, repo: "someone/else", issue: 20 }, ctx), "dropped");
  assert.equal(await family.handle("issue.read", { id: ID, repo: REPO, issue: 0 }, ctx), "dropped");
  assert.equal(await family.handle("issue.read", { id: ID, repo: REPO, issue: 20 }, ctx), "delivered");
  assert.equal(await family.handle("issue.read", { id: ID, repo: REPO, issue: 20 }, ctx), "duplicate");
  release();
  for (let i = 0; i < 50 && !puts.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.length, 1);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].url, "https://rivet.example/api/bridge/issue");
  assert.equal(puts[0].init.method, "PUT");
  assert.equal(puts[0].init.headers.authorization, "Bearer tok");
  assert.equal(JSON.parse(puts[0].init.body).number, 20);
  // Done, the next tap reads again.
  assert.equal(await family.handle("issue.read", { id: ID, repo: REPO, issue: 20 }, ctx), "delivered");
});
