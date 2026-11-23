#!/usr/bin/env node
// The open chats, counted once each. A chat is one worktree
// with a live pane, in the workspace app or the chat runner, idle or not; then the chats the last close pass kept though
// nothing was running in them, with its reason. The cap is the one Settings › Behaviours › Chats run themselves sets,
// as the bridge last wrote it.
//   node ~/rivet/bridge/lib/chat-count.mjs     the "## Chats" numbers in the health report

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const KNOBS_FILE = path.join(os.homedir(), ".rivet", "backlog-puller", "knobs.json");
export const DEFAULT_CAP = 10;
const RUNNER_ON = path.join(os.homedir(), ".rivet", "chats", "runner-on");
const RUNNER_CLI = path.join(os.homedir(), ".rivet", "chats", "bin", "rivet-chat.mjs");

/** @param {string} dir */
const canon = (dir) => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
};

/**
 * The private names when chats-extra.mjs is there; without it no chat is protected by name and no app is read.
 * @returns {Promise<{ protected: string[], protectedFolder: string | null, app: string | null, keepListFile: string | null,
 *   modeFile: string, logFile: string }>}
 */
export async function chatsConfig() {
  const dir = path.join(os.homedir(), ".rivet", "chats");
  return { protected: [], protectedFolder: null, app: null, keepListFile: null, modeFile: path.join(dir, "close.mode"), logFile: path.join(dir, "close.log") };
}

// Claude Code's title: ✳ while it waits, a spinner glyph (◐◓◑◒, braille dots) while it works. Anything else (a shell,
// no title) is not working.
const IDLE = /^✳/;
const WORKING = /^[\u25D0-\u25D3\u2800-\u28FF\u00B7\u2722-\u273D]/;

/**
 * @param {{ terminals: Array<{ worktreePath?: string, title?: string }>, runner: Array<{ worktree: string, title?: string }> }} input
 * The app's terminals as its list gives them; runner chats that have a live pane. The app's "Setup" shell is never a chat.
 */
export function count({ terminals, runner }) {
  /** @type {Map<string, { worktree: string, name: string, from: Set<string>, working: boolean }>} */
  const chats = new Map();
  const add = (/** @type {string} */ worktree, /** @type {string | undefined} */ title, /** @type {string} */ from) => {
    const key = canon(worktree);
    const chat = chats.get(key) ?? { worktree: key, name: path.basename(key), from: new Set(), working: false };
    chat.from.add(from);
    if (WORKING.test(title ?? "") && !IDLE.test(title ?? "")) chat.working = true;
    chats.set(key, chat);
  };
  for (const t of terminals) if (t.worktreePath && t.title !== "Setup") add(t.worktreePath, t.title, "app");
  for (const r of runner) add(r.worktree, r.title, "runner");
  const all = [...chats.values()];
  const working = all.filter((c) => c.working).length;
  return {
    chats: all.length,
    working,
    idle: all.length - working,
    app: all.filter((c) => c.from.has("app")).length,
    runner: all.filter((c) => c.from.has("runner")).length,
    both: all.filter((c) => c.from.size > 1).length,
    names: all.map((c) => c.name).sort(),
  };
}

// The close log: `21/11/2026 08:03 <zone> close <name> keep <reason>`, one line per chat per run.
const LINE = /^(\d\d\/\d\d\/\d{4} \d\d:\d\d \S+) (\S+) (\S+) (keep|close) (.*)$/;
// Still in use, so not finished: a working agent or a recent turn, or a protected chat.
const NOT_FINISHED = /^(active\b|protected$)/;

/** The last close run's kept chats that are finished: `{ at, kept: [{ name, reason }] }`; at is null with no run. @param {string} text */
export function keptFromLog(text) {
  const lines = /** @type {RegExpExecArray[]} */ (text.split("\n").map((l) => LINE.exec(l)).filter(Boolean));
  if (!lines.length) return { at: null, kept: [] };
  const at = lines[lines.length - 1][1];
  const kept = lines.filter((m) => m[1] === at && m[4] === "keep" && !NOT_FINISHED.test(m[5])).map((m) => ({ name: m[3], reason: m[5] }));
  return { at, kept };
}

/**
 * @param {ReturnType<typeof count>} numbers @param {ReturnType<typeof keptFromLog>} log
 * @param {{ cap: number | null, app?: string | null }} o cap null: the bridge's cap could not be read
 */
export function report(numbers, log, { cap, app }) {
  const out = [`chats=${numbers.chats} idle=${numbers.idle} working=${numbers.working} (cap ${cap ?? "unread"}) — ${app ?? "app"} ${numbers.app}, runner ${numbers.runner}, ${numbers.both} in both`];
  if (!log.at) out.push("kept: no close run in the log");
  else if (!log.kept.length) out.push(`kept (close run ${log.at}): none`);
  else out.push(`kept (close run ${log.at}): ${log.kept.length}`, ...log.kept.map((k) => `  ${k.name}: ${k.reason}`));
  return out.join("\n");
}

/**
 * The knobs file's text, read only when it is a plain file. Throws ENOENT when nothing is at the path, and refuses a
 * link (dangling or not), a FIFO, a folder or a socket without reading it.
 * @param {string} file
 */
function readPlainFile(file) {
  // O_NOFOLLOW refuses a link; O_NONBLOCK opens a FIFO at once, where a blocking open or read would hang the count.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${file} is not a plain file`);
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** The cap the bridge last wrote; no file is the default, anything there that is not a readable plain file is null. @param {string} [file] */
export function readKnobCap(file = KNOBS_FILE) {
  let text;
  try {
    text = readPlainFile(file);
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT" ? DEFAULT_CAP : null;
  }
  try {
    const cap = JSON.parse(text)?.cap;
    return Number.isInteger(cap) && cap >= 1 && cap <= 20 ? cap : null;
  } catch {
    return null;
  }
}

/**
 * The app's terminals. Throws when its list cannot be read; `truncated` is a list cut short.
 * @param {(file: string, args: string[]) => string} run @param {string} app
 */
export function readTerminals(run, app) {
  const list = JSON.parse(run(app, ["terminal", "list", "--limit", "1000", "--json"]));
  const terminals = list?.result?.terminals;
  if (!Array.isArray(terminals)) throw new Error("unexpected terminal list");
  return { terminals, truncated: list.result.truncated === true };
}

/**
 * The runner's open chats, as count() takes them: none while its switch is off, unless `ignoreSwitch` (its sessions
 * may still be live with the switch off). Throws when it cannot be read. Open as
 * the backlog puller counts them (scripts/backlog-puller.mjs mergeChats): a live pane, a session it cannot see into
 * (another socket, or foreign), or one not finished that is starting or due a restart.
 * @param {(file: string, args: string[]) => string} run
 */
export function readRunner(run, { on = RUNNER_ON, cli = RUNNER_CLI, ignoreSwitch = false } = {}) {
  if (!ignoreSwitch && !fs.existsSync(on)) return [];
  const rows = JSON.parse(run(process.execPath, [cli, "ls", "--json"]));
  if (!Array.isArray(rows)) throw new Error("unexpected runner list");
  return rows.flatMap((row) => {
    if (typeof row?.worktree !== "string" || !path.isAbsolute(row.worktree)) return [];
    const live = String(row.live ?? "");
    const open = live === "alive" || live === "foreign" || live.startsWith("socket ") || (row.status !== "finished" && (row.status === "starting" || Boolean(row.resume) || Boolean(row.keepAlive)));
    return open ? [{ worktree: row.worktree, title: typeof row.title === "string" ? row.title : undefined }] : [];
  });
}

async function main() {
  const cfg = await chatsConfig();
  const run = (/** @type {string} */ file, /** @type {string[]} */ args) => execFileSync(file, args, { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
  const errors = [];
  /** @type {Array<{ worktreePath?: string, title?: string }>} */
  let terminals = [];
  if (cfg.app) {
    try {
      const list = readTerminals(run, cfg.app);
      terminals = list.terminals;
      if (list.truncated) errors.push(`${cfg.app} list cut short`);
    } catch (error) {
      errors.push(`${cfg.app} unreadable (${String(/** @type {Error} */ (error).message).split("\n")[0].slice(0, 80)})`);
    }
  }
  /** @type {Array<{ worktree: string, title?: string }>} */
  let runner = [];
  try {
    runner = readRunner(run);
  } catch (error) {
    errors.push(`runner unreadable (${String(/** @type {Error} */ (error).message).split("\n")[0].slice(0, 80)})`);
  }
  /** @type {ReturnType<typeof keptFromLog>} */
  let log = { at: null, kept: [] };
  try {
    log = keptFromLog(fs.readFileSync(cfg.logFile, "utf8"));
  } catch {}
  console.log(report(count({ terminals, runner }), log, { cap: readKnobCap(), app: cfg.app }));
  // A count with a source missing is a home, never the number.
  if (errors.length) console.log(`partial: ${errors.join("; ")}`);
}

if (process.argv[1] && canon(process.argv[1]) === canon(fileURLToPath(import.meta.url))) await main();
