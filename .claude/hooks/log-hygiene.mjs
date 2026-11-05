#!/usr/bin/env node
// PostToolUse(Bash): when a command has just put a long log into context, say so, so
// the next one goes to a file. Advisory only: it measures output and blocks nothing.
import { advisory, emit, readStdin } from "./lib.mjs";

const LONG_OUTPUT_CHARS = 10_000;

advisory(async () => {
  const input = await readStdin();
  const response = input.tool_response;
  if (response === undefined) return;
  const chars = (typeof response === "string" ? response : JSON.stringify(response)).length;
  if (chars < LONG_OUTPUT_CHARS) return;

  emit({
    hookEventName: "PostToolUse",
    additionalContext: `Log hygiene: that command put ~${Math.round(chars / 1000)}k characters into context, and every later turn re-reads them. Send long output to a file in a temporary folder and let the exit code be the verdict: \`<cmd> > "$LOG" 2>&1; echo "rc=$?"\`. On a non-zero rc, grep the failure lines and Read log ranges as needed. An empty grep is not a pass; rc=0 is.`,
  });
});
