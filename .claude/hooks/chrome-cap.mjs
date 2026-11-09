#!/usr/bin/env node
// PreToolUse + PostToolUse(Bash): a cap on the headless Chrome browsers one chat runs on this machine, because a few
// parallel browser workers can use up its memory. RIVET_CHROME_CAP sets it (default 2). A nudge only: it denies nothing
// and kills nothing.
//
// It counts browsers, not processes (one browser is several, and only its main process has no --type=), and only
// this chat's: below this Claude process, or left running with their working folder in this chat's worktree, since a
// `( … ) &` that outlives its shell is reparented away from Claude and that was the incident's shape.
//
// What it cannot see: browsers started and closed inside one foreground command, because it only looks between
// commands. So before a command runs it also reads the text for the two ways a chat asks for many at once.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { advisory, emit, readStdin } from "./lib.mjs";

const CAP = /^[1-9]\d{0,2}$/.test(process.env.RIVET_CHROME_CAP ?? "") ? Number(process.env.RIVET_CHROME_CAP) : 2;
const SAFE_ID = /^[\w-]+$/;
const SHELL_MS = 2_000;
// The executable leads a ps line. An absolute path may hold spaces, and a word starting with - means it has ended, so
// `/bin/zsh -c …/headless_shell` is a shell. So may a `./` one; a bare relative one (`vendor/…/headless_shell`) has none. The shells are always headless; a full Chrome only with the flag.
const BROWSER = /^(?:\.{0,2}\/(?:(?:(?! -).)*\/)?|[^\s/.]\S*\/)?(?:(chrome-headless-shell|headless_shell)|google chrome(?: for testing| canary)?|chrome|chromium)(?=\s|$)/i;
// A command sent to another machine is not on this one; only the segment that sends it is skipped.
const OFF_THIS_MACHINE = /^(?:\w+=\S*\s+)*ssh\s/;
const ASKS_FOR_MANY = [
  // Every -P after xargs: the last one wins on some systems, so all are read.
  /(?<=\bxargs\b.*)\s-P\s*(\d+)/g,
  /\bparallel\b[^|;&]*?\s(?:-j\s*|--jobs[= ])(\d+)/g,
  /(?:^|\s)--workers[= ](\d+)/g,
];
// The command's own segments, comments dropped: `a; b`, `a && b`, `a | b`, one per line.
const segments = (command) =>
  command
    .split(/\n|;|&&|\|\||\||&(?!>)/)
    // A # opens a comment only where no quote could be holding it (`--grep 'case #one'`).
    .map((part) => (/['"]/.test(part) ? part : part.replace(/(?:^|\s)#.*$/, "")).trim())
    .filter(Boolean);
const BROKEN_THROTTLE = /\$\(\s*jobs\b/;

const isHeadlessBrowser = (command) => {
  const match = BROWSER.exec(command);
  if (!match) return false;
  const args = command.slice(match[0].length);
  // Only the browser's main process has no --type=.
  if (/\s--type=/.test(args)) return false;
  return match[1] !== undefined || /\s--headless(?:[=\s]|$)/.test(args);
};

const processes = () => {
  const table = new Map();
  const out = execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8", timeout: SHELL_MS, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) table.set(Number(match[1]), { ppid: Number(match[2]), command: match[3] });
  }
  return table;
};

// The Claude process this hook runs under. Bash commands carry CLAUDE_PID; without it, the nearest `claude` above.
const chatRoot = (table) => {
  const fromEnv = Number(process.env.CLAUDE_PID);
  if (Number.isInteger(fromEnv) && fromEnv > 1) return fromEnv;
  for (let pid = process.ppid, hops = 0; pid > 1 && hops < 16; hops += 1) {
    const entry = table.get(pid);
    if (!entry) return null;
    if (isClaude(entry)) return pid;
    pid = entry.ppid;
  }
  return null;
};

const isClaude = (entry) => basename(entry.command.split(" ")[0]) === "claude";

// "mine" below this chat's Claude, "other" below another chat's, "orphan" below neither (reparented to the init process).
const ancestry = (table, pid, root) => {
  for (let at = table.get(pid)?.ppid ?? 0, hops = 0; at > 1 && hops < 64; hops += 1) {
    if (at === root) return "mine";
    const entry = table.get(at);
    if (!entry) return "orphan";
    if (isClaude(entry)) return "other";
    at = entry.ppid;
  }
  return "orphan";
};

// pid -> working folder, for the browsers not under this chat's Claude process.
const workingFolders = (pids) => {
  const folders = new Map();
  if (pids.length === 0) return folders;
  let out = "";
  try {
    out = execFileSync("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"], { encoding: "utf8", timeout: SHELL_MS, stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    // lsof exits 1 when one of the pids has gone, and still prints the others.
    out = typeof error.stdout === "string" ? error.stdout : "";
  }
  let pid = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null) folders.set(pid, line.slice(1));
  }
  return folders;
};

// A worktree under .claude/worktrees is usually another chat's, so it is not this chat's folder.
const inChatFolder = (folder, chatDir) => {
  if (!folder || !chatDir) return false;
  if (folder !== chatDir && !folder.startsWith(chatDir + sep)) return false;
  return !folder.startsWith(join(chatDir, ".claude", "worktrees") + sep);
};

const ownBrowsers = (input) => {
  const table = processes();
  const browsers = [...table].filter(([, entry]) => isHeadlessBrowser(entry.command)).map(([pid]) => pid);
  if (browsers.length === 0) return 0;
  const root = chatRoot(table);
  const lines = browsers.map((pid) => [pid, ancestry(table, pid, root)]);
  const below = lines.filter(([, line]) => line === "mine").map(([pid]) => pid);
  // Another chat's browser is that chat's even in this folder; only an orphan is placed by its folder.
  const others = lines.filter(([, line]) => line === "orphan").map(([pid]) => pid);
  const chatDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
  const folders = workingFolders(others);
  return below.length + others.filter((pid) => inChatFolder(folders.get(pid), chatDir)).length;
};

// One nudge per new high, heard again once the chat has gone back to the cap and over it again.
const overCapNote = (input, count) => {
  const id = input.session_id;
  const statePath = SAFE_ID.test(id ?? "") ? join(tmpdir(), "claude-chrome-cap", id) : null;
  if (count <= CAP) {
    if (statePath) rmSync(statePath, { force: true });
    return null;
  }
  if (statePath) {
    let told = 0;
    try {
      told = Number(readFileSync(statePath, "utf8")) || 0;
    } catch {
      // Nothing told yet.
    }
    if (count <= told) return null;
    mkdirSync(join(tmpdir(), "claude-chrome-cap"), { recursive: true, mode: 0o700 });
    // A rename replaces a symlink at the state path rather than writing through it.
    const fresh = `${statePath}.${process.pid}`;
    writeFileSync(fresh, String(count), { flag: "wx", mode: 0o600 });
    renameSync(fresh, statePath);
  }
  return `Chrome cap: this chat has ${count} headless Chrome browsers running; the cap on this machine is ${CAP}. Start no more until these finish, and run the rest in fixed lanes. Close only browsers you started, by their own PID, never by name pattern. Check with \`pgrep -f chrome-headless-shell | wc -l\` (that count is every chat's).`;
};

const commandNote = (input) => {
  const command = input.tool_input?.command;
  if (typeof command !== "string") return null;
  const local = segments(command).filter((part) => !OFF_THIS_MACHINE.test(part));
  if (BROKEN_THROTTLE.test(command)) {
    return `Chrome cap: \`$(jobs …)\` throttles nothing in zsh, because the subshell has no jobs, so every worker starts at once. If this starts headless Chrome, use fixed lanes or \`xargs -P ${CAP}\`.`;
  }
  const asked = local.flatMap((part) => ASKS_FOR_MANY.flatMap((pattern) => [...part.matchAll(pattern)].map((match) => Number(match[1]))));
  // xargs -P 0 means as many as it can.
  const over = asked.filter((workers) => workers === 0 || workers > CAP);
  if (over.length) {
    const workers = over.includes(0) ? 0 : Math.max(...over);
    return `Chrome cap: this command asks for ${workers === 0 ? "unlimited" : workers} parallel workers. If they drive headless Chrome, the cap on this machine is ${CAP}; use ${CAP} here. Anything else is fine as it is.`;
  }
  return null;
};

advisory(async () => {
  const input = await readStdin();
  const event = input.hook_event_name;
  if (event !== "PreToolUse" && event !== "PostToolUse") return;
  // Each check fails alone: an unreadable process table must not cost the note about the command, or the reverse.
  let notes = [];
  try {
    notes.push(overCapNote(input, ownBrowsers(input)));
  } catch {
    // No ps here, or it timed out: say nothing.
  }
  if (event === "PreToolUse") notes.push(commandNote(input));
  notes = notes.filter(Boolean);
  if (notes.length) emit({ hookEventName: event, additionalContext: notes.join("\n\n") });
});
