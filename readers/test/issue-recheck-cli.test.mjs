import assert from "node:assert/strict";
import { test } from "node:test";
import { readerCli, unexpectedArgs } from "./cli-fixture.mjs";

test("issue-recheck rejects unexpected arguments before any work or configuration check", () => {
  for (const repo of [true, false]) {
    for (const args of unexpectedArgs) {
      const result = readerCli("issue-recheck", args, { repo });
      const bad = args.find((arg) => arg !== "--dry-run");
      assert.equal(result.status, 2, JSON.stringify(args));
      assert.equal(result.stderr, `usage: issue-recheck.mjs [--dry-run]: unexpected argument ${JSON.stringify(bad)}\n`);
      assert.equal(result.stdout, "");
      assert.deepEqual(result.calls, [], "no state access, child process, fetch or write");
      assert.deepEqual(result.files, []);
    }
  }
});

test("issue-recheck accepts live and dry-run invocations", () => {
  for (const args of [[], ["--dry-run"], ["--dry-run", "--dry-run"]]) {
    const result = readerCli("issue-recheck", args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /issue-recheck-pass/);
    assert.ok(result.calls.some((call) => call.kind === "execFile" && call.bin === "gh" && call.args.includes("issue") && call.args.includes("list")), "reaches the stubbed issue list");
    assert.equal(result.files.some((file) => /^asks\/reports\/issue-recheck-.*\.md$/.test(file)), args.length === 0);
  }
});
