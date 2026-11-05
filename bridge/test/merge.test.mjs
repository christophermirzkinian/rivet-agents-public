import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ExecError } from "../lib/config.mjs";
import { createCommandFamily, validateCommand } from "../lib/actions/command.mjs";
import { runMerge } from "../lib/actions/merge.mjs";

const REPO = "example-org/example-repo";
const HEAD = "a".repeat(40);
const PR = 42;
const ASK = { repo: REPO, pr: PR, headSha: HEAD };
const ENV = { RIVET_MERGE: "on", RIVET_REPOS: REPO };
const GREEN = [{ name: "build", bucket: "pass" }, { name: "test", bucket: "pass" }];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-test-"));
const NO_HOLDS_FILE = path.join(dir, "none.json");

function prView(over = {}) {
  return { number: PR, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: HEAD, url: "https://example.test/pr/42", ...over };
}

/**
 * A `gh` that answers from fixtures and records every call. `api` paths are the ones readMergeHolds reads.
 * @param {{ view?: object | Error, afterMerge?: object, checks?: unknown, checksError?: Error, labels?: {name: string}[], body?: string, comments?: {body: string}[],
 *   apiError?: Error, restHead?: string, mergeError?: Error }} [o]
 */
function fakeGh(o = {}) {
  /** @type {string[][]} */
  const calls = [];
  let merged = false;
  const exec = async (/** @type {string} */ _bin, /** @type {string[]} */ args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      if (o.view instanceof Error) throw o.view;
      return { stdout: JSON.stringify(merged ? (o.afterMerge ?? prView({ state: "MERGED" })) : prView(o.view)) };
    }
    if (args[0] === "pr" && args[1] === "checks") {
      if (o.checksError) throw o.checksError;
      return { stdout: JSON.stringify(o.checks ?? GREEN) };
    }
    if (args[0] === "pr" && args[1] === "merge") {
      if (o.mergeError) throw o.mergeError;
      merged = true;
      return { stdout: "" };
    }
    if (args[0] === "api") {
      if (o.apiError) throw o.apiError;
      const url = args.find((arg) => arg.startsWith("repos/")) ?? "";
      if (/\/pulls\/\d+\/commits/.test(url)) return { stdout: JSON.stringify([{ sha: o.restHead ?? HEAD, commit: { message: "A plain change" } }]) };
      if (/\/pulls\/\d+(\?|$)/.test(url)) {
        return { stdout: JSON.stringify({ number: PR, state: "open", title: "A plain change", body: o.body ?? "", labels: o.labels ?? [], commits: 1, head: { sha: o.restHead ?? HEAD } }) };
      }
      if (/\/issues\/\d+\/comments/.test(url)) return { stdout: JSON.stringify(o.comments ?? []) };
      return { stdout: "[]" };
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { exec, calls, ghBin: "gh" };
}

const ran = (/** @type {string[][]} */ calls) => calls.some((args) => args[0] === "pr" && args[1] === "merge");
const run = (/** @type {ReturnType<typeof fakeGh>} */ gh, over = {}) => runMerge({ ...gh, env: ENV, holdsFile: NO_HOLDS_FILE, now: 0, ...over }, ASK);

/** @param {ReturnType<typeof fakeGh>} gh @param {RegExp} reason @param {object} [over] */
async function assertRefused(gh, reason, over) {
  const answer = await run(gh, over);
  assert.equal(answer.status, "refused");
  assert.match(String(answer.detail.reason), reason);
  assert.equal(ran(gh.calls), false, "a refusal must not reach the merge command");
}

test("a green, mergeable PR with no holds merges through one plain command", async () => {
  const gh = fakeGh();
  const answer = await run(gh);
  assert.deepEqual(answer, { status: "merged", detail: { url: "https://example.test/pr/42" } });
  const merges = gh.calls.filter((args) => args[0] === "pr" && args[1] === "merge");
  assert.equal(merges.length, 1);
  assert.deepEqual(merges[0].slice(0, 7), ["pr", "merge", String(PR), "--repo", REPO, "--squash", "--match-head-commit"]);
  assert.equal(merges[0][7], HEAD);
});

test("no call ever carries an admin flag, auto-merge or a REST write", async () => {
  const gh = fakeGh();
  await run(gh);
  for (const args of gh.calls) {
    assert.ok(!args.includes("--admin"));
    assert.ok(!args.includes("--auto"));
    assert.ok(!args.some((arg) => /^(PUT|POST|PATCH|DELETE)$/i.test(arg)), `a write in ${args.join(" ")}`);
    assert.ok(!(args[0] === "api" && args.some((arg) => /\/merge\b/.test(arg))));
    assert.ok(!args.includes("deploy"));
  }
});

test("refuses while RIVET_MERGE is not on, before any read", async () => {
  for (const value of [undefined, "", "off", "true", "ON"]) {
    const gh = fakeGh();
    await assertRefused(gh, /off/, { env: { RIVET_REPOS: REPO, ...(value === undefined ? {} : { RIVET_MERGE: value }) } });
    assert.equal(gh.calls.length, 0);
  }
});

test("refuses a repo outside RIVET_REPOS, before any read", async () => {
  for (const env of [{ RIVET_MERGE: "on" }, { RIVET_MERGE: "on", RIVET_REPOS: "example-org/other-repo" }]) {
    const gh = fakeGh();
    await assertRefused(gh, /not in RIVET_REPOS/, { env });
    assert.equal(gh.calls.length, 0);
  }
});

test("refuses when the PR cannot be read", async () => {
  await assertRefused(fakeGh({ view: new ExecError("gh", { code: 1 }, "HTTP 502") }), /could not be read/);
});

test("refuses a closed, merged or draft PR", async () => {
  await assertRefused(fakeGh({ view: { state: "CLOSED" } }), /not open/);
  await assertRefused(fakeGh({ view: { state: "MERGED" } }), /not open/);
  await assertRefused(fakeGh({ view: { isDraft: true } }), /draft/);
});

test("refuses when the head moved since the tap", async () => {
  await assertRefused(fakeGh({ view: { headRefOid: "b".repeat(40) } }), /head changed/);
  await assertRefused(fakeGh({ restHead: "b".repeat(40) }), /head changed/);
});

test("refuses a PR GitHub does not call mergeable", async () => {
  for (const mergeable of ["CONFLICTING", "UNKNOWN", null]) {
    await assertRefused(fakeGh({ view: { mergeable } }), /not mergeable/);
  }
});

test("refuses every blocked merge state, a ruleset's among them", async () => {
  for (const mergeStateStatus of ["BLOCKED", "BEHIND", "DIRTY", "DRAFT", "UNKNOWN", null]) {
    await assertRefused(fakeGh({ view: { mergeStateStatus } }), /would not merge/);
  }
});

test("refuses unless every required check passed", async () => {
  for (const bucket of ["fail", "pending", "skipping", "cancel"]) {
    await assertRefused(fakeGh({ checks: [{ name: "build", bucket: "pass" }, { name: "test", bucket }] }), new RegExp(`not all green: test \\(${bucket}\\)`));
  }
});

test("a red check's non-zero exit still names the check", async () => {
  const checksError = new ExecError("gh", { code: 1 }, "", JSON.stringify([{ name: "test", bucket: "fail" }]));
  await assertRefused(fakeGh({ checksError }), /not all green: test \(fail\)/);
});

test("refuses a branch with no required checks", async () => {
  await assertRefused(fakeGh({ checks: [] }), /no required checks/);
  await assertRefused(fakeGh({ checksError: new ExecError("gh", { code: 1 }, "no required checks reported on the 'main' branch") }), /no required checks/);
});

test("refuses when the required checks cannot be read", async () => {
  await assertRefused(fakeGh({ checksError: new ExecError("gh", { code: 1 }, "HTTP 502") }), /could not be read/);
  await assertRefused(fakeGh({ checks: { not: "a list" } }), /could not be read/);
  await assertRefused(fakeGh({ checksError: new ExecError("gh", { code: 1 }, "boom", JSON.stringify(GREEN)) }), /could not be read/);
});

test("refuses a PR with a hold line in its body or a comment", async () => {
  await assertRefused(fakeGh({ body: "HOLD: waiting on the owner" }), /on hold/);
  await assertRefused(fakeGh({ comments: [{ body: "HOLD: waiting on the owner" }] }), /on hold/);
});

test("refuses a PR with a hold label", async () => {
  await assertRefused(fakeGh({ labels: [{ name: "do-not-merge" }] }), /on hold/);
});

test("refuses a PR in the holds file, and on a holds file it cannot trust", async () => {
  const held = path.join(dir, "held.json");
  fs.writeFileSync(held, JSON.stringify([{ pr: PR, reason: "waiting on a review" }]));
  await assertRefused(fakeGh(), /waiting on a review/, { holdsFile: held });
  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, "not json");
  await assertRefused(fakeGh(), /nothing merges/, { holdsFile: broken });
});

test("refuses when the holds cannot be read", async () => {
  await assertRefused(fakeGh({ apiError: new ExecError("gh", { code: 1 }, "HTTP 502") }), /holds could not be read/);
});

test("a refusal from GitHub is the answer: one attempt, no retry, no other route", async () => {
  const gh = fakeGh({ mergeError: new ExecError("gh", { code: 1 }, "Repository rule violations found") });
  const answer = await run(gh);
  assert.equal(answer.status, "refused");
  assert.match(String(answer.detail.reason), /GitHub refused the merge: Repository rule violations found/);
  assert.equal(gh.calls.filter((args) => args[0] === "pr" && args[1] === "merge").length, 1);
  assert.ok(!gh.calls.flat().includes("--admin"));
});

test("an earlier run that reached the merge command never runs it again", async () => {
  const done = fakeGh({ view: { state: "MERGED" } });
  assert.equal((await run(done, { tried: true })).status, "merged");
  assert.equal(ran(done.calls), false);
  const open = fakeGh();
  assert.equal((await run(open, { tried: true })).status, "failed");
  assert.equal(ran(open.calls), false);
});

test("the wire shape: a merge needs a repo, a PR number and a full head", () => {
  assert.deepEqual(validateCommand("merge", { id: "m1", ...ASK }), { ok: true, value: { id: "m1", ...ASK } });
  for (const [change, reason] of [[{ repo: "nope" }, "bad-repo"], [{ repo: undefined }, "bad-repo"], [{ pr: 0 }, "bad-pr"], [{ pr: "42" }, "bad-pr"], [{ headSha: "abc" }, "bad-head"]]) {
    const v = validateCommand("merge", { id: "m1", ...ASK, ...(/** @type {object} */ (change)) });
    assert.equal(v.ok, false);
    assert.equal(/** @type {any} */ (v).reason, reason);
  }
});

/** A command family over a real journal and a recording ack. */
function family(/** @type {ReturnType<typeof fakeGh>} */ gh) {
  /** @type {any[]} */
  const acks = [];
  const state = { file: path.join(fs.mkdtempSync(path.join(dir, "fam-")), "state.json") };
  const ctx = {
    deps: {
      ...gh, state, origin: "http://bridge.test", token: "t", log: () => {},
      fetch: async (/** @type {string} */ _url, /** @type {{ body: string }} */ init) => {
        acks.push(JSON.parse(init.body));
        return { ok: true, status: 200, text: async () => "" };
      },
    },
  };
  const command = createCommandFamily({ sleep: async () => {}, env: ENV, holdsFile: NO_HOLDS_FILE, now: () => 0 });
  return { command, ctx, acks };
}

test("the family acks a merged PR, and a repeat tap repeats the answer without merging twice", async () => {
  const gh = fakeGh();
  const { command, ctx, acks } = family(gh);
  const raw = { id: "m1", ...ASK };
  assert.equal(await command.handle("merge", raw, /** @type {any} */ (ctx)), "delivered");
  assert.equal(await command.handle("merge", raw, /** @type {any} */ (ctx)), "duplicate");
  assert.equal(gh.calls.filter((args) => args[0] === "pr" && args[1] === "merge").length, 1);
  assert.deepEqual(acks.map((ack) => ack.status), ["merged", "merged"]);
});

test("the family acks a malformed merge as refused, and drops one with no id", async () => {
  const gh = fakeGh();
  const { command, ctx, acks } = family(gh);
  assert.equal(await command.handle("merge", { id: "m2", ...ASK, pr: -1 }, /** @type {any} */ (ctx)), "delivered");
  assert.equal(acks[0].status, "refused");
  assert.match(acks[0].reason ?? acks[0].detail?.reason, /not well formed/);
  assert.equal(await command.handle("merge", { ...ASK }, /** @type {any} */ (ctx)), "dropped");
  assert.equal(gh.calls.length, 0);
});
