import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createCommandFamily, validateCommand } from "../lib/actions/command.mjs";
import { ExecError } from "../lib/config.mjs";
import { StateStore } from "../lib/state.mjs";

// GitHub issue writes (event "issue"): the Mac comments, comments then closes as not planned, or labels Start work's
// issue agent:working, with its own gh login.

const MS = "example-org/example-repo";
process.env.RIVET_REPOS = `${MS},example-org/other-repo`;

/** @param {{ fail?: (args: string[]) => Error | null, dir?: string }} [opts] */
function harness(opts = {}) {
  /** @type {{ file: string, args: string[], input?: string }[]} */
  const calls = [];
  /** @type {any[]} */
  const acks = [];
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "rivet-issue-"));
  const ctx = {
    deps: {
      origin: "https://rivet.example",
      token: "tok",
      ghBin: "/usr/local/bin/gh",
      monitorChat: "rivet-app",
      state: new StateStore(path.join(dir, "state.json")),
      log: () => {},
      /** @param {string} file @param {string[]} args @param {{ input?: string }} options */
      exec: async (file, args, options) => {
        calls.push({ file, args, ...(options.input !== undefined ? { input: options.input } : {}) });
        const err = opts.fail?.(args);
        if (err) throw err;
        return { stdout: "", stderr: "" };
      },
      /** @param {string} url @param {RequestInit} init */
      fetch: async (url, init) => {
        assert.ok(url.endsWith("/api/bridge/action-ack"));
        acks.push(JSON.parse(String(init.body)));
        return new Response("{}", { status: 200 });
      },
    },
    listTerminals: async () => [],
    sendLine: async () => ({ confirmed: true, stages: [] }),
  };
  const family = createCommandFamily({ sleep: async () => {} });
  return { family, ctx, calls, acks, dir };
}

const OTHER = "example-org/other-repo";
const write = (over = {}) => ({ id: "issue-write-01", at: "2026-10-13T00:00:00.000Z", repo: MS, issue: 529, op: "comment", text: 'He said "$(rm -rf ~)" `id`', ...over });

test("an issue write is an allowlisted repo's issue, a comment or a close with words, or a label with none", () => {
  assert.equal(validateCommand("issue", write()).ok, true);
  assert.equal(validateCommand("issue", write({ op: "label", text: undefined })).ok, true);
  assert.deepEqual(validateCommand("issue", write({ op: "label" })), { ok: false, id: write().id, reason: "bad-text" });
  assert.equal(validateCommand("issue", write({ repo: OTHER })).ok, true);
  for (const [over, reason] of /** @type {const} */ ([
    [{ repo: "someone/else" }, "bad-repo"],
    [{ repo: undefined }, "bad-repo"],
    [{ issue: 0 }, "bad-issue"],
    [{ issue: "529" }, "bad-issue"],
    [{ op: "delete" }, "bad-op"],
    [{ text: "  " }, "bad-text"],
    [{ text: "x".repeat(2001) }, "bad-text"],
  ])) {
    assert.deepEqual(validateCommand("issue", write(over)), { ok: false, id: write().id, reason });
  }
});

test("a comment goes on with the Mac's gh login, its words on stdin and never in the arguments", async () => {
  const h = harness();
  assert.equal(await h.family.handle("issue", write(), h.ctx), "delivered");
  await h.family.idle();
  assert.deepEqual(h.calls, [{ file: "/usr/local/bin/gh", args: ["issue", "comment", "529", "--repo", MS, "--body-file", "-"], input: 'He said "$(rm -rf ~)" `id`' }]);
  assert.deepEqual(h.acks, [{ id: write().id, status: "succeeded", detail: { reason: "Commented on #529" } }]);
});

test("a close comments first, then closes", async () => {
  const h = harness();
  await h.family.handle("issue", write({ op: "close", text: "Done in #531" }), h.ctx);
  await h.family.idle();
  assert.deepEqual(
    h.calls.map((call) => [call.args, call.input]),
    [
      [["issue", "comment", "529", "--repo", MS, "--body-file", "-"], "Done in #531"],
      [["issue", "close", "529", "--repo", MS, "--reason", "not planned"], undefined],
    ],
  );
  assert.deepEqual(h.acks.at(-1), { id: write().id, status: "succeeded", detail: { reason: "Commented on and closed #529" } });
});

test("another repo's issue is commented on and closed in its own repo, never the first repo's same number", async () => {
  const h = harness();
  await h.family.handle("issue", write({ repo: OTHER, issue: 120, op: "close", text: "Done on the site" }), h.ctx);
  await h.family.idle();
  assert.deepEqual(
    h.calls.map((call) => call.args),
    [
      ["issue", "comment", "120", "--repo", OTHER, "--body-file", "-"],
      ["issue", "close", "120", "--repo", OTHER, "--reason", "not planned"],
    ],
  );
  assert.equal(h.acks.at(-1).status, "succeeded");
});

test("the same write sent again is answered from the journal, never run twice", async () => {
  const h = harness();
  await h.family.handle("issue", write(), h.ctx);
  await h.family.idle();
  // Sent again on the next attach, in this process and after a restart.
  await h.family.handle("issue", write(), h.ctx);
  await h.family.idle();
  const restarted = harness({ dir: h.dir });
  await restarted.family.handle("issue", write(), restarted.ctx);
  await restarted.family.idle();
  assert.equal(h.calls.length + restarted.calls.length, 1);
  assert.deepEqual([...h.acks, ...restarted.acks].map((ack) => ack.status), ["succeeded", "succeeded", "succeeded"]);
});

test("a write a restart stopped mid-comment is reported, not commented again; one stopped before its close closes", async () => {
  const h = harness();
  const journal = path.join(h.dir, "actions.json");
  const entry = (note) => ({ version: 1, actions: [{ id: write().id, kind: "issue", startedAt: "2026-10-13T00:00:00.000Z", acked: false, note }] });
  fs.writeFileSync(journal, JSON.stringify(entry({ commenting: true })));
  const mid = harness({ dir: h.dir });
  await mid.family.handle("issue", write(), mid.ctx);
  await mid.family.idle();
  assert.deepEqual(mid.calls, []);
  assert.equal(mid.acks[0].status, "failed");
  assert.match(mid.acks[0].detail.reason, /restarted while commenting; check #529 on GitHub/);

  const other = harness();
  fs.writeFileSync(path.join(other.dir, "actions.json"), JSON.stringify(entry({ commenting: true, commented: true })));
  const resumed = harness({ dir: other.dir });
  await resumed.family.handle("issue", write({ op: "close", text: "Done" }), resumed.ctx);
  await resumed.family.idle();
  assert.deepEqual(resumed.calls.map((call) => call.args[1]), ["close"]);
  assert.equal(resumed.acks[0].status, "succeeded");
});

test("a refusal says why in a short line, never the words or a token", async () => {
  const token = `ghp_${"A".repeat(36)}`;
  const h = harness({ fail: (args) => (args[1] === "close" ? new ExecError("/usr/local/bin/gh", { code: 1 }, `HTTP 403: token ${token} lacks scope`) : null) });
  await h.family.handle("issue", write({ op: "close", text: "secret words" }), h.ctx);
  await h.family.idle();
  const [ack] = h.acks;
  assert.equal(ack.status, "failed");
  assert.match(ack.detail.reason, /^Commented, but GitHub would not close it: gh exit 1/);
  assert.doesNotMatch(JSON.stringify(ack), new RegExp(`${token}|secret words`));
});

test("a write a restart stopped mid-close is reported, never closed again", async () => {
  const h = harness();
  const entry = { id: write().id, kind: "issue", startedAt: "2026-10-13T00:00:00.000Z", acked: false, note: { commenting: true, commented: true, closing: true } };
  fs.writeFileSync(path.join(h.dir, "actions.json"), JSON.stringify({ version: 1, actions: [entry] }));
  const restarted = harness({ dir: h.dir });
  await restarted.family.handle("issue", write({ op: "close", text: "Done" }), restarted.ctx);
  await restarted.family.idle();
  assert.deepEqual(restarted.calls, []);
  assert.equal(restarted.acks[0].status, "failed");
  assert.match(restarted.acks[0].detail.reason, /restarted while closing; check #529 on GitHub/);
});

test("the same id sent again for another issue, op or words is refused, nothing done", async () => {
  const h = harness({ fail: (args) => (args[1] === "close" ? new ExecError("/usr/local/bin/gh", { code: 1 }, "HTTP 502") : null) });
  await h.family.handle("issue", write({ op: "close", text: "Done" }), h.ctx);
  await h.family.idle();
  const journal = JSON.parse(fs.readFileSync(path.join(h.dir, "actions.json"), "utf8"));
  // The comment went and the close failed; a restart keeps only the steps, as a lost ack would leave it.
  journal.actions[0].last = undefined;
  fs.writeFileSync(path.join(h.dir, "actions.json"), JSON.stringify(journal));
  for (const over of [{ issue: 99, op: "close", text: "Done" }, { repo: OTHER, op: "close", text: "Done" }, { op: "comment", text: "Done" }, { op: "close", text: "Other" }]) {
    const replay = harness({ dir: h.dir });
    await replay.family.handle("issue", write(over), replay.ctx);
    await replay.family.idle();
    assert.deepEqual(replay.calls, []);
    assert.equal(replay.acks[0].status, "failed");
    assert.match(replay.acks[0].detail.reason, /already used for another/);
  }
});

test("the journal never drops a GitHub write the server has not confirmed", async () => {
  const { ActionJournal, JOURNAL_MAX } = await import("../lib/journal.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-journal-"));
  const book = new ActionJournal(path.join(dir, "actions.json"));
  book.start("w1", "issue", "2026-10-13T00:00:00.000Z");
  // Confirmed two days ago: let go. One confirmed just now stays a day, as a send already on its way may still come.
  book.start("w2", "issue", new Date(Date.now() - 2 * 86_400_000).toISOString());
  book.start("w3", "issue", new Date().toISOString());
  book.report("w3", { status: "succeeded" });
  book.acked("w3", book.get("w3")?.last);
  const done = { status: "succeeded" };
  book.report("w2", done);
  book.acked("w2", done);
  const w2 = book.get("w2");
  if (w2) w2.ackedAt = w2.startedAt;
  for (let i = 0; i < JOURNAL_MAX + 5; i++) book.start(`m${i}`, "merge", "2026-10-13T00:01:00.000Z");
  const kept = new ActionJournal(path.join(dir, "actions.json"));
  assert.ok(kept.get("w1"), "the unconfirmed write stays");
  assert.ok(kept.get("w3"), "a write confirmed in the last day stays");
  // Started long ago but confirmed just now: kept a day from the confirm.
  const late = new ActionJournal(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rivet-journal-")), "actions.json"));
  late.start("old", "issue", new Date(Date.now() - 3 * 86_400_000).toISOString());
  late.report("old", { status: "succeeded" });
  late.acked("old", late.get("old")?.last);
  for (let i = 0; i < JOURNAL_MAX + 5; i++) late.start(`m${i}`, "merge", "2026-10-13T00:01:00.000Z");
  assert.ok(late.get("old"), "kept a day from its confirm");
  assert.equal(kept.get("w2"), undefined);
  assert.equal(kept.entries.size, JOURNAL_MAX + 2);
  // Full of unconfirmed writes, other actions are kept over them: an armed merge is never pushed out by the next action.
  const full = new ActionJournal(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rivet-journal-")), "actions.json"));
  for (let i = 0; i < JOURNAL_MAX; i++) full.start(`w${i}`, "issue", "2026-10-13T00:00:00.000Z");
  full.start("merge", "merge", "2026-10-13T00:01:00.000Z");
  full.note("merge", { pr: 1 });
  full.start("schedule", "schedule", "2026-10-13T00:02:00.000Z");
  assert.deepEqual(full.get("merge")?.note, { pr: 1 });
  assert.equal(full.entries.size, JOURNAL_MAX + 2);
});

const label = (over = {}) => write({ op: "label", text: undefined, ...over });

test("Start work's label is made where the repo lacks it, then put on the issue", async () => {
  const h = harness();
  assert.equal(await h.family.handle("issue", label({ repo: OTHER, issue: 20 }), h.ctx), "delivered");
  await h.family.idle();
  assert.deepEqual(
    h.calls.map((call) => call.args),
    [
      ["label", "create", "agent:working", "--repo", OTHER, "--color", "FBCA04", "--description", "A chat is working on this"],
      ["issue", "edit", "20", "--repo", OTHER, "--add-label", "agent:working", "--add-assignee", "@me"],
    ],
  );
  assert.deepEqual(h.acks, [{ id: write().id, status: "succeeded", detail: { reason: "Labelled #20 agent:working" } }]);
});

test("a label the repo already has is used as it is; any other refusal fails the write", async () => {
  const exists = harness({ fail: (args) => (args[0] === "label" ? new ExecError("/usr/local/bin/gh", { code: 1 }, 'label with name "agent:working" already exists; use `--force` to update') : null) });
  await exists.family.handle("issue", label(), exists.ctx);
  await exists.family.idle();
  assert.deepEqual(exists.calls.map((call) => call.args[0]), ["label", "issue"]);
  assert.equal(exists.acks[0].status, "succeeded");

  const refused = harness({ fail: (args) => (args[0] === "label" ? new ExecError("/usr/local/bin/gh", { code: 1 }, "HTTP 403") : null) });
  await refused.family.handle("issue", label(), refused.ctx);
  await refused.family.idle();
  assert.deepEqual(refused.calls.map((call) => call.args[0]), ["label"]);
  assert.equal(refused.acks[0].status, "failed");
  assert.match(refused.acks[0].detail.reason, /^GitHub refused the label/);
});

test("a label a restart stopped mid-way is put on again: a label added twice is one label", async () => {
  const h = harness();
  const entry = { id: write().id, kind: "issue", startedAt: "2026-10-13T00:00:00.000Z", acked: false, note: { labelling: true } };
  fs.writeFileSync(path.join(h.dir, "actions.json"), JSON.stringify({ version: 1, actions: [entry] }));
  const restarted = harness({ dir: h.dir });
  await restarted.family.handle("issue", label(), restarted.ctx);
  await restarted.family.idle();
  assert.deepEqual(restarted.calls.map((call) => call.args[0]), ["label", "issue"]);
  assert.equal(restarted.acks[0].status, "succeeded");
});

test("a close tried again after its comment went closes without a second comment", async () => {
  const h = harness({ fail: (args) => (args[1] === "close" ? new ExecError("/usr/local/bin/gh", { code: 1 }, "HTTP 502") : null) });
  await h.family.handle("issue", write({ op: "close" }), h.ctx);
  await h.family.idle();
  assert.equal(h.acks[0].status, "failed");
  const again = harness({ dir: h.dir });
  await again.family.handle("issue", write({ op: "close", id: "issue-write-02" }), again.ctx);
  await again.family.idle();
  assert.deepEqual(again.calls.map((call) => call.args.slice(0, 2)), [["issue", "close"]]);
  assert.equal(again.acks[0].status, "succeeded");
  const other = harness({ dir: h.dir });
  await other.family.handle("issue", write({ op: "close", issue: 530, id: "issue-write-03" }), other.ctx);
  await other.family.idle();
  assert.deepEqual(other.calls.map((call) => call.args.slice(0, 2)), [["issue", "comment"], ["issue", "close"]]);
});
