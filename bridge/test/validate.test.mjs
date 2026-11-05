import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_STEP, MAX_STEPS, progressFieldProblems, validateReply } from "../lib/validate.mjs";

process.env.RIVET_REPOS = "example-org/example-repo,example-org/other-repo";
import { reply } from "./fixtures.mjs";

test("accepts a valid reply and defaults the repo", () => {
  const v = validateReply(reply({ text: "ship it", choice: "Approve" }));
  assert.equal(v.ok, true);
  assert.equal(v.reply.item.repo, "example-org/example-repo");
  assert.equal(v.reply.item.pr, 2022);
  assert.equal(v.reply.text, "ship it");
  assert.equal(v.reply.choice, "Approve");
});

test("keeps bounded choice detail and omits malformed legacy context without rejecting the reply", () => {
  for (const detail of [undefined, null, 4, {}, [], "", "  ", "x".repeat(1001), "x".repeat(1000), "Deploy to staging only"]) {
    const v = validateReply(reply({ decision: "choice", choice: "Proceed" }, { choiceDetail: detail }));
    assert.equal(v.ok, true);
    assert.equal(v.reply.item.choiceDetail, typeof detail === "string" && detail.trim() && detail.length <= 1000 ? detail : undefined);
  }
  assert.equal(validateReply(reply({ decision: "comment", text: "Later" }, { choiceDetail: "Deploy" })).reply.item.choiceDetail, undefined);
});

test("keeps only known fields", () => {
  const v = validateReply(reply({ extra: "x" }, { links: [], risk: "money" }));
  assert.equal(v.ok, true);
  assert.deepEqual(Object.keys(v.reply.item).sort(), ["chat", "id", "kind", "pr", "repo", "risk", "title"]);
  assert.equal("extra" in v.reply, false);
});

test("accepts any well-formed repo and null optional fields", () => {
  for (const repo of ["example-org/example-repo", "example-org/other-repo", "someone/else"]) {
    assert.equal(validateReply(reply({}, { repo })).ok, true);
  }
  const v = validateReply(reply({ text: null, choice: null }, { chat: null, pr: null, issue: 7, repo: null }));
  assert.equal(v.ok, true);
  assert.equal(v.reply.item.issue, 7);
  assert.equal("chat" in v.reply.item, false);
});

const bad = [
  ["not an object", "nope", "not-an-object"],
  ["bad id", reply({ id: "a b" }), "bad-id"],
  ["dot id", reply({ id: ".." }), "bad-id"],
  ["long id", reply({ id: "a".repeat(101) }), "bad-id"],
  ["bad itemId", reply({ itemId: "x/y" }), "bad-itemId"],
  ["bad decision", reply({ decision: "merge" }), "bad-decision"],
  ["note is not accepted", reply({ decision: "note" }), "bad-decision"],
  ["choice without label", reply({ decision: "choice" }), "choice-missing"],
  ["empty choice", reply({ decision: "choice", choice: "  " }), "bad-choice"],
  ["long text", reply({ text: "x".repeat(4001) }), "bad-text"],
  ["text not string", reply({ text: 5 }), "bad-text"],
  ["missing item", { ...reply(), item: undefined }, "bad-item"],
  ["item id mismatch", reply({}, { id: "other" }), "item-id-mismatch"],
  ["repo with no owner", reply({}, { repo: "example-repo" }), "bad-repo"],
  ["repo injection", reply({}, { repo: "example-org/example-repo/../x" }), "bad-repo"],
  ["negative pr", reply({}, { pr: -1 }), "bad-pr"],
  ["fractional pr", reply({}, { pr: 1.5 }), "bad-pr"],
  ["string pr", reply({}, { pr: "12" }), "bad-pr"],
  ["zero issue", reply({}, { issue: 0 }), "bad-issue"],
  ["chat with slash", reply({}, { chat: "../monitor" }), "bad-chat"],
  ["chat with flag", reply({}, { chat: "--help me" }), "bad-chat"],
  ["bad risk", reply({}, { risk: "yolo" }), "bad-risk"],
  ["title not string", reply({}, { title: 42 }), "bad-title"],
];
for (const [name, raw, reason] of bad) {
  test(`drops ${name}`, () => {
    const v = validateReply(raw);
    assert.equal(v.ok, false);
    assert.equal(v.reason, reason);
  });
}

test("a drop names the id only when it is well formed", () => {
  assert.equal(validateReply(reply({ decision: "x" })).id, "r_01");
  assert.equal(validateReply(reply({ id: "\u001b[2J" })).id, "?");
});

test("keeps the answered revision and ask; rejects malformed ones", () => {
  const v = validateReply(reply({ rev: "c82d6c3494e2665f" }, { ask: "Deploy staging?" }));
  assert.equal(v.ok, true);
  assert.equal(v.reply.rev, "c82d6c3494e2665f");
  assert.equal(v.reply.item.ask, "Deploy staging?");
  assert.equal(validateReply(reply({ rev: "" })).ok, true);
  assert.deepEqual(validateReply(reply({ rev: "C82D;rm" })), { ok: false, id: "r_01", reason: "bad-rev" });
  assert.deepEqual(validateReply(reply({}, { ask: 7 })), { ok: false, id: "r_01", reason: "bad-ask" });
});

test("keeps a todo card's steps within the card's bounds", () => {
  const v = validateReply(reply({ decision: "done" }, { kind: "todo", steps: ["Open Fly", "Rotate the key"] }));
  assert.equal(v.ok, true);
  assert.deepEqual(v.reply.item.steps, ["Open Fly", "Rotate the key"]);
  assert.equal(validateReply(reply({ decision: "done" }, { kind: "todo", steps: Array(MAX_STEPS).fill("s") })).ok, true);
  for (const steps of [[], "Open Fly", [" "], [7], Array(MAX_STEPS + 1).fill("s"), ["x".repeat(MAX_STEP + 1)]]) {
    assert.deepEqual(validateReply(reply({ decision: "done" }, { kind: "todo", steps })), { ok: false, id: "r_01", reason: "bad-steps" });
  }
});

test("progressFieldProblems passes old entries and the full shape", () => {
  assert.deepEqual(progressFieldProblems({ needs: [], coming: [{ title: "Old" }], chats: [{ name: "a", state: "idle" }] }), []);
  const full = { title: "t", pr: 1, app: "g", what: "w", stage: "owner-ok", progress: 0.5, etaMinutes: 20, chat: "a-b", updatedAt: "2026-09-30T00:00:00Z", requestedAt: "2026-09-29T23:00:00Z" };
  assert.deepEqual(progressFieldProblems({ coming: [full], chats: [{ name: "a", state: "x", stage: "CI", what: "w", progress: 1, etaMinutes: 0 }] }), []);
  assert.deepEqual(progressFieldProblems({}), []);
});

test("progressFieldProblems names each bad field, and a null counts as set", () => {
  const problems = progressFieldProblems({
    coming: [{ title: "t", stage: "shipping", progress: 2, etaMinutes: 1.5 }, { title: "u", app: null, pr: 1_000_000_001, requestedAt: 5 }, "x"],
    chats: [{ name: "a", state: "x", stage: "", etaMinutes: -1 }],
  });
  assert.deepEqual(problems, [
    "coming[0].stage must be one of building, review, owner-ok, merging, deploying, shipped",
    "coming[0].progress must be a number from 0 to 1",
    "coming[0].etaMinutes must be whole minutes from 0 to 10080",
    "coming[1].pr must be a PR number",
    "coming[1].app must be 1 to 80 characters",
    "coming[1].requestedAt must be an ISO timestamp",
    "coming[2] is not an object",
    "chats[0].stage must be 1 to 40 characters",
    "chats[0].etaMinutes must be whole minutes from 0 to 10080",
  ]);
});
