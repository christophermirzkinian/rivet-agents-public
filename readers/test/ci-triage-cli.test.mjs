import assert from "node:assert/strict";
import { test } from "node:test";
import { readerCli, unexpectedArgs } from "./cli-fixture.mjs";

test("ci-triage rejects unexpected arguments before any work", () => {
  for (const args of unexpectedArgs) {
    const result = readerCli("ci-triage", args);
    const bad = args.find((arg) => arg !== "--dry-run");
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stderr, `usage: ci-triage.mjs [--dry-run]: unexpected argument ${JSON.stringify(bad)}\n`);
    assert.equal(result.stdout, "");
    assert.deepEqual(result.calls, [], "no state access, child process, fetch or write");
    assert.deepEqual(result.files, []);
  }
});

test("ci-triage accepts live and dry-run invocations", () => {
  for (const args of [[], ["--dry-run"], ["--dry-run", "--dry-run"]]) {
    const result = readerCli("ci-triage", args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /ci-triage-pass/);
    assert.ok(result.calls.some((call) => call.kind === "execFile" && call.args.includes("-i")), "reaches the stubbed GitHub poll");
    assert.equal(result.files.includes("asks/readers/ci-triage-state.json"), args.length === 0);
  }
});
