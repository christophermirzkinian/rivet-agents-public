#!/usr/bin/env node
// UserPromptSubmit + PostToolUse: tell the model its context size once it crosses a
// budget line, so PR checkpoints happen before auto-compaction, not after.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { advisory, emit, contextTokens, isMonitor, readStdin, tailLines } from "./lib.mjs";

// One line for both: 70k of headroom under the auto-compaction cut, so the PR
// checkpoint lands well before compaction in the main loop, an implementer and a builder.
// The line is derived, never hardcoded: a session that lowers the window through
// `CLAUDE_CODE_AUTO_COMPACT_WINDOW` would otherwise compact before reaching a fixed
// line and hear no nudge at all, and a line far below the cut fires while the
// session still has most of its context left, which trains the model to ignore it.
const DEFAULT_WINDOW = 200_000;
const HEADROOM = 70_000;
const MIN_BUDGET_LINE = 50_000;

// `100000`, `500k` and the CLI's `200` shorthand all mean tokens.
const parseWindow = (raw) => {
  const match = /^\s*(\d+)\s*k?\s*$/i.exec(String(raw ?? ""));
  if (!match) return null;
  const value = Number(match[1]);
  const tokens = /k\s*$/i.test(raw) || value <= 1000 ? value * 1000 : value;
  return tokens > 0 ? tokens : null;
};

// Same precedence the CLI applies: env override, then this project's setting.
const effectiveWindow = () => {
  const override = parseWindow(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  if (override !== null) return override;
  try {
    const settings = JSON.parse(
      readFileSync(join(process.env.CLAUDE_PROJECT_DIR ?? ".", ".claude", "settings.json"), "utf8"),
    );
    return parseWindow(settings.autoCompactWindow) ?? DEFAULT_WINDOW;
  } catch {
    // No readable setting (a subagent cwd, a stripped checkout): the shipped default.
    return DEFAULT_WINDOW;
  }
};

const WINDOW = effectiveWindow();
const BUDGET_LINE = Math.max(WINDOW - HEADROOM, MIN_BUDGET_LINE);
const k = (tokens) => Math.round(tokens / 1000);
const REPEAT_EVERY = 50_000;
// Only a builder owns a PR checkpoint. A reviewer or explorer nudged mid-run tends to
// cut its findings short, so every other agent runs on unprompted.
const NUDGED_AGENTS = new Set(["implementer", "builder"]);
const SAFE_ID = /^[\w-]+$/;

const readState = (path, fallback) =>
  existsSync(path) ? Number(readFileSync(path, "utf8")) : fallback;

const writeState = (dir, path, value) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, String(value));
};

advisory(async () => {
  const input = await readStdin();
  const note = budgetNote(input);
  if (note) emit({ hookEventName: input.hook_event_name, additionalContext: note });
});

function budgetNote(input) {
  const { session_id: sessionId, agent_id: agentId, transcript_path: transcriptPath } = input;
  if (!transcriptPath || !SAFE_ID.test(sessionId ?? "")) return null;
  if (agentId !== undefined && !SAFE_ID.test(agentId)) return null;

  // A subagent's turns and its type live beside the session transcript.
  const subagentBase = agentId
    ? join(dirname(transcriptPath), sessionId, "subagents", `agent-${agentId}`)
    : null;
  if (subagentBase) {
    let agentType = input.agent_type;
    try {
      agentType ??= JSON.parse(readFileSync(`${subagentBase}.meta.json`, "utf8")).agentType;
    } catch {
      // No meta file: unknown type, no nudge.
    }
    if (!NUDGED_AGENTS.has(agentType)) return null;
  }

  const lines = tailLines(subagentBase ? `${subagentBase}.jsonl` : transcriptPath);
  if (lines === null) return null;

  const stateDir = join(tmpdir(), "claude-context-budget");
  const statePath = join(stateDir, `${sessionId}-${agentId ?? "main"}`);

  const tokens = contextTokens(lines);
  if (tokens === null) return null;
  if (tokens < BUDGET_LINE) {
    rmSync(statePath, { force: true });
    return null;
  }
  // One nudge per band (the line, then every 50k above it), not every call. The main
  // loop auto-compacts at the window, so it normally hears band 0 once; a lower band
  // than last time means compaction ran and that crossing is heard again. Subagents
  // may reach higher bands.
  const band = Math.floor((tokens - BUDGET_LINE) / REPEAT_EVERY);
  if (band === readState(statePath, -1)) return null;
  writeState(stateDir, statePath, band);
  return (
    `Context budget: this ${agentId ? "run" : "session"} is at ~${k(tokens)}k tokens (line: ${k(BUDGET_LINE)}k); auto-compaction is near. At the next clean point write a checkpoint in the PR body (done, next, gotchas; not a new comment, which would land after the self-review evidence and block the merge gate), make sure untriaged review findings and any owner hold are written on the PR rather than only here, and carry on: auto-compaction fires at ~${k(WINDOW)}k. ` +
    (agentId
      ? "Do not stop or hand off for this; finish the task."
      : "`.claude/hooks/session-start.mjs` points a fresh session back at the PR, so never ask the owner to `/clear`.") +
    (!agentId && isMonitor(input.cwd)
      ? " You are the monitor: rewrite your state file now with everything open (asks, holds, PRs, cards, chats), because it is what comes back after compaction or a restart."
      : "")
  );
}
