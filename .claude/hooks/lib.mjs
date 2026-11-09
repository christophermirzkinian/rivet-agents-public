import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readSync, writeSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const TAIL_BYTES = 2 * 1024 * 1024;

// The transcript tail, read once per hook invocation so several measurements can
// share the pass. null = unreadable; callers must not read that as "empty".
export function tailLines(transcriptPath) {
  let fd;
  try {
    fd = openSync(transcriptPath, "r");
  } catch {
    return null;
  }
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8").split("\n");
  } finally {
    closeSync(fd);
  }
}

// Context size = what the last model call re-read: its input plus both cache legs.
// null = no usable entry in the tail; callers must not read that as "small".
export function contextTokens(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"usage"')) continue;
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const usage = entry?.message?.usage;
    if (!usage) continue;
    const tokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);
    // Synthetic and interrupted entries carry an all-zero usage block.
    if (tokens > 0) return tokens;
  }
  return null;
}

export const readStdin = async () => {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
};

// A hook that throws or exits non-zero can block the call it watches. These hooks are
// advisory, so any failure of their own means: say nothing.
export const advisory = (main) =>
  main().catch(() => {}).finally(() => process.exit(0));

// process.exit() can beat an async pipe write, so hook output is written synchronously.
export const emit = (hookSpecificOutput) =>
  writeSync(1, JSON.stringify({ hookSpecificOutput }));

// What session-start.mjs injects of the monitor's two files, in characters (the state
// file first, then the job file). Claude Code swaps hook output over 10,000 characters
// for a short preview, so the two shares and the headers must fit under that together.
export const MONITOR_STATE_CHARS = 6_000;
export const MONITOR_JOB_CHARS = 2_700;
export const HOOK_CONTEXT_CHARS = 10_000;

export const defaultBranch = () => process.env.RIVET_DEFAULT_BRANCH || "main";

export const monitorChat = () => process.env.RIVET_MONITOR_CHAT?.trim() || null;

// The monitor is the chat whose working folder is named RIVET_MONITOR_CHAT. Unset means
// no chat here is the monitor.
export const isMonitor = (cwd) => {
  const chat = monitorChat();
  return chat !== null && basename(process.env.CLAUDE_PROJECT_DIR ?? cwd ?? "") === chat;
};

const rivetCli = () => {
  if (process.env.RIVET_BIN) return existsSync(process.env.RIVET_BIN) ? [process.env.RIVET_BIN] : null;
  const script = fileURLToPath(new URL("../../scripts/rivet.mjs", import.meta.url));
  return existsSync(script) ? [process.execPath, script] : null;
};

// Put a card on the board without waiting for the server: the CLI runs detached, and a
// card id that is already up is refused there, so one id per day is at most one card a
// day. Best effort: a failed post is tried again by the next start that finds the same
// problem. false when there is no CLI here.
export function postCard(id, flags) {
  const cli = rivetCli();
  if (!cli) return false;
  const [file, ...script] = cli;
  // An unrunnable CLI must not take the hook down with an unhandled 'error'.
  const child = spawn(file, [...script, "card", "add", id, ...flags], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return true;
}

// YYYYMMDD in this machine's local time, for once-a-day card ids.
export const dayStamp = (date = new Date()) =>
  `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
