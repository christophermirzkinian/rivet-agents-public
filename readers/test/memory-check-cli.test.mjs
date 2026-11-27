import assert from "node:assert/strict";
import { test } from "node:test";
import { readerCli, unexpectedArgs } from "./cli-fixture.mjs";

test("memory-check rejects unexpected arguments before any work or configuration check", () => {
  for (const repo of [true, false]) {
    for (const args of unexpectedArgs) {
      const result = readerCli("memory-check", args, { repo });
      const bad = args.find((arg) => arg !== "--dry-run");
      assert.equal(result.status, 2, JSON.stringify(args));
      assert.equal(result.stderr, `usage: memory-check.mjs [--dry-run]: unexpected argument ${JSON.stringify(bad)}\n`);
      assert.equal(result.stdout, "");
      assert.deepEqual(result.calls, [], "no state access, child process, fetch or write");
      assert.deepEqual(result.files, []);
    }
  }
});

test("memory-check accepts live and dry-run invocations", () => {
  for (const args of [[], ["--dry-run"], ["--dry-run", "--dry-run"]]) {
    const result = readerCli("memory-check", args, { directories: ["memory"] });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /memory-check-pass/);
    assert.ok(result.calls.some((call) => call.kind === "readdirSync" && call.file === "memory"), "reaches the empty memory folder");
    assert.ok(result.calls.some((call) => call.kind === "execFile" && call.bin === "git" && call.args.includes("rev-parse")), "reaches the stubbed main read");
    assert.equal(result.files.some((file) => /^asks\/reports\/memory-check-.*\.md$/.test(file)), args.length === 0);
  }
});
