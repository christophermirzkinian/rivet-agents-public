import assert from "node:assert/strict";
import { test } from "node:test";

import { runHook } from "./run-hook.mjs";

const hook = (toolResponse) => runHook("log-hygiene.mjs", { tool_name: "Bash", tool_response: toolResponse });

test("a long output is told to go to a file", () => {
  const out = hook("x".repeat(12_000)).hookSpecificOutput;
  assert.equal(out.hookEventName, "PostToolUse");
  assert.match(out.additionalContext, /~12k characters/);
  assert.ok(!("permissionDecision" in out));
});

test("a structured response is measured too", () => {
  assert.ok(hook({ stdout: "x".repeat(12_000), stderr: "" }));
});

test("a short output, no output and unreadable input say nothing", () => {
  assert.equal(hook("x".repeat(9_000)), null);
  assert.equal(runHook("log-hygiene.mjs", { tool_name: "Bash" }), null);
  assert.equal(runHook("log-hygiene.mjs", "not json"), null);
});
