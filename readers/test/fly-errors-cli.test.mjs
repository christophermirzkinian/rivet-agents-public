import assert from "node:assert/strict";
import { test } from "node:test";
import { readerCli, unexpectedArgs } from "./cli-fixture.mjs";

test("fly-errors rejects unexpected arguments before any work or configuration check", () => {
  for (const repo of [true, false]) {
    for (const args of unexpectedArgs) {
      const result = readerCli("fly-errors", args, { repo });
      const bad = args.find((arg) => arg !== "--dry-run");
      assert.equal(result.status, 2, JSON.stringify(args));
      assert.equal(result.stderr, `usage: fly-errors.mjs [--dry-run]: unexpected argument ${JSON.stringify(bad)}\n`);
      assert.equal(result.stdout, "");
      assert.deepEqual(result.calls, [], "no state access, child process, fetch or write");
      assert.deepEqual(result.files, []);
    }
  }
});

test("fly-errors accepts live and dry-run invocations", () => {
  for (const args of [[], ["--dry-run"], ["--dry-run", "--dry-run"]]) {
    const result = readerCli("fly-errors", args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /fly-errors-pass/);
    assert.ok(result.calls.some((call) => call.kind === "execFile" && call.bin === "flyctl"), "reaches the stubbed Fly app list");
    assert.equal(result.files.includes("asks/readers/fly-errors-state.json"), args.length === 0);
  }
});
