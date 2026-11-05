import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { runHook } from "./run-hook.mjs";

let tmp;
let root;
let transcript;

const usage = (tokens) =>
  JSON.stringify({ message: { usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 1000 } } });

const at = (tokens, path = transcript) => writeFileSync(path, `${usage(tokens)}\n`);

const hook = (input = {}, env = {}) => {
  const out = runHook(
    "context-budget.mjs",
    { hook_event_name: "PostToolUse", session_id: "S1", transcript_path: transcript, cwd: root, ...input },
    { TMPDIR: tmp, CLAUDE_PROJECT_DIR: root, ...env },
  );
  return out?.hookSpecificOutput ?? null;
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "context-budget-"));
  root = join(tmp, "this-chat");
  mkdirSync(root);
  transcript = join(tmp, "S1.jsonl");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

test("under the line says nothing", () => {
  at(100_000);
  assert.equal(hook(), null);
});

test("the line is told once per band, and again after compaction", () => {
  at(131_000);
  const first = hook();
  assert.equal(first.hookEventName, "PostToolUse");
  assert.match(first.additionalContext, /~131k tokens \(line: 130k\)/);
  assert.match(first.additionalContext, /checkpoint in the PR body/);
  at(140_000);
  assert.equal(hook(), null);
  at(181_000);
  assert.match(hook().additionalContext, /~181k/);
  at(60_000);
  assert.equal(hook(), null);
  at(131_000);
  assert.match(hook().additionalContext, /~131k/);
});

test("the line follows the auto-compaction window, with a floor", () => {
  at(60_000);
  assert.match(hook({}, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100k" }).additionalContext, /line: 50k/);
  rmSync(join(tmp, "claude-context-budget"), { recursive: true });
  at(400_000);
  assert.equal(hook({}, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500" }), null);
});

test("a project setting sets the window", () => {
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ autoCompactWindow: 150_000 }));
  at(81_000);
  assert.match(hook().additionalContext, /line: 80k/);
});

test("only a builder or an implementer is nudged among subagents", () => {
  const dir = join(tmp, "S1", "subagents");
  mkdirSync(dir, { recursive: true });
  at(135_000, join(dir, "agent-a1.jsonl"));
  writeFileSync(join(dir, "agent-a1.meta.json"), JSON.stringify({ agentType: "reviewer" }));
  assert.equal(hook({ agent_id: "a1" }), null);
  writeFileSync(join(dir, "agent-a1.meta.json"), JSON.stringify({ agentType: "builder" }));
  const note = hook({ agent_id: "a1" });
  assert.match(note.additionalContext, /this run is at ~135k/);
  assert.match(note.additionalContext, /Do not stop or hand off/);
});

test("the monitor is told to save its state, and only the monitor", () => {
  at(131_000);
  assert.match(hook({}, { RIVET_MONITOR_CHAT: "this-chat" }).additionalContext, /You are the monitor: rewrite your state file/);
  rmSync(join(tmp, "claude-context-budget"), { recursive: true });
  assert.doesNotMatch(hook({}, { RIVET_MONITOR_CHAT: "other-chat" }).additionalContext, /You are the monitor/);
  rmSync(join(tmp, "claude-context-budget"), { recursive: true });
  assert.doesNotMatch(hook().additionalContext, /You are the monitor/);
});

test("nothing usable says nothing", () => {
  assert.equal(hook({ transcript_path: join(tmp, "none.jsonl") }), null);
  writeFileSync(transcript, "not json\n{\"message\":{\"usage\":{\"input_tokens\":0}}}\n");
  assert.equal(hook(), null);
  at(131_000);
  assert.equal(hook({ session_id: "../up" }), null);
  assert.equal(runHook("context-budget.mjs", "not json", { TMPDIR: tmp }), null);
});
