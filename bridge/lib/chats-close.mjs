#!/usr/bin/env node
// Finished chats close themselves (with
// the owner's switch and knobs in Settings › Behaviours › Chats run themselves). A chat (a worktree with terminals in
// the workspace app) closes only when ALL hold, checked in this order; the first that fails is logged as the reason it
// is kept:
//   protected   never: the names and folder chats-extra.mjs lists
//   keep-list   never: a name in the keep list (folder name or the app's display name)
//   idle        judged by state, never by screen output (an idle Claude screen keeps printing). Kept when
//               its agent is working, when a shell runs under it (the Bash tool or a background job: a zsh/bash/sh -c
//               process in its tree), when its board state is waiting or stuck (or working, touched in the last 60
//               min), or when its last real turn (newest entry time inside its Claude transcripts, not the file time)
//               or agent update is under 60 min old. With no known time at all it is kept (idle-unknown).
//   git clean   no uncommitted or untracked changes
//   pushed      HEAD on an origin ref, or equal to a merged PR's head (the repo squash-merges)
//   no hold     its open PR is not held: in the holds file, or by a hold line in the PR's body or an owner comment
//   no open PR  no open PR whose head branch or head commit is this chat's
//   no card     no open (non-update) board card from this chat
//   no ask      no Rivet ask on this chat that is not finished
//   no sign-in  no Android emulator, iOS simulator or browser started from its tree
// Close = the app's `terminal close --terminal <h>` for each terminal, then `rivet chat drop <name>` (404 fine), then
// what it left orphaned in its folder is ended by pid (endLeftovers). One line per chat to the close log, and one for
// the left-overs it ended.
//
// Two closers, one at a time. The bridge (lib/chats-loop.mjs) runs this file with --from bridge every five minutes, and
// the scheduled cleaner with --from cron; the mode file says which closes:
//   close    the cron closes; the bridge only counts
//   bridge   the bridge closes while its row's switch is on, and writes a heartbeat each pass; the cron stands aside
//            while the heartbeat is under 15 minutes old and takes over when it is older or missing
//   other    nothing closes; the cron logs what it would close
// The row's switch off (close false in the knobs file the bridge writes), or a knobs file that cannot be read, keeps
// the cron to listing in any mode.
// A pass that may close holds the closer's kernel lock (takeLock); the cron's whole pass stops at ten minutes.
//   node ~/rivet/bridge/lib/chats-close.mjs --from cron
//   node ~/rivet/bridge/lib/chats-close.mjs --from bridge --close on|off [--bin <name>=<path>]   prints the pass

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FINISHED_STAGES, stageOfAsk } from "./asks.mjs";
import { chatsConfig, count, KNOBS_FILE, readRunner, readTerminals } from "./chat-count.mjs";
import { scriptCommand } from "./config.mjs";
import { HOLDS_FILE, readHolds } from "./holds-file.mjs";
import { prHold } from "./pr-holds.mjs";

const HOUR = 60 * 60 * 1000;
export const CHATS_DIR = path.join(os.homedir(), ".rivet", "chats");
export const HEARTBEAT_FILE = path.join(CHATS_DIR, "closer.json");
export const LOCK_FILE = path.join(CHATS_DIR, "closer.lock");
export const HEARTBEAT_FRESH_MS = 15 * 60_000;
// O_EXLOCK from darwin's <sys/fcntl.h>; node's fs.constants does not export it.
const O_EXLOCK = 0x20;
// The cron pass's whole run, as the bridge kills its own pass at ten minutes (lib/chats-loop.mjs).
export const CRON_DEADLINE_MS = 10 * 60_000;
// The merged heads change only as PRs merge: one read each half hour is enough to tell a squash-merged chat.
const MERGED_MAX_AGE_MS = 30 * 60_000;
const RIVET_CLI = fileURLToPath(new URL("../../scripts/rivet.mjs", import.meta.url));
// A process from the chat's tree (or under one) matching this holds an owner sign-in.
const SIGN_IN = /qemu-system|\bemulator(64)?\b|Simulator\.app|simctl|launchd_sim|chrome|chromium|firefox|webkit|msedge|playwright|puppeteer/i;
// A shell running a command (the Bash tool, a background job); login shells (-/bin/zsh -l) are not.
const SHELL = /^(\S*\/)?(zsh|bash|sh)\s+(-\S+\s+)*-c\b/;
// Phrases in a chat's transcript that say it started a device, when a device is running now.
const DEVICE_WORDS = /simctl (boot|openurl|launch)|open -a Simulator|emulator -avd|emulator @|adb (shell|install|reverse)/;

/** The log's time: `22/11/2026 20:53 <zone>`, in this machine's zone. @param {number} ms */
const stampOf = (ms) =>
  new Date(ms).toLocaleString("en-AU", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).replace(",", "");

/** owner/name from an origin URL, or "" @param {string} url */
export const repoSlug = (url) => (url || "").trim().replace(/^(git@github\.com:|https:\/\/github\.com\/)/, "").replace(/\.git$/, "");

/** Claude's transcript folder for a working directory. @param {string} home @param {string} dir */
export const transcriptDir = (home, dir) => path.join(home, ".claude", "projects", dir.replace(/[^A-Za-z0-9]/g, "-"));

/**
 * @typedef {{ number: number, headRefName: string, headRefOid: string }} OpenPr
 * @typedef {{ slug: string, head: string, branch: string, dirty: boolean, unpushed: boolean }} ChatGit
 * @typedef {{ path: string, name: string, displayName?: string, agents: { state?: string, updatedAt: number | null }[],
 *   lastTurnAt: number | null, git: ChatGit | null, signIn: string, shell: string, prHeld?: boolean }} Chat
 * @typedef {{ now: number, protected: string[], protectedFolder: string | null, keepList: Set<string>,
 *   cards: { id: string, kind?: string, chat?: string }[], boardChats: { name?: string, state?: string, touchedAt?: string, updatedAt?: string }[],
 *   asks: { id: string, chat?: string, stage?: string, status?: string }[], heldPrs: Set<number>,
 *   merged: Map<string, Set<string>>, openPrs: Map<string, OpenPr[]> }} Context
 */

/** This chat's open PR, by head branch or head commit. @param {ChatGit} g @param {OpenPr[]} open */
export const matchPr = (g, open) => open.find((p) => (g.branch && g.branch !== "HEAD" && p.headRefName === g.branch) || p.headRefOid === g.head);

/**
 * The pure decision for one chat.
 * @param {Chat} chat @param {Context} ctx
 * @returns {{ verdict: "keep" | "close", reason: string }}
 */
export function decide(chat, ctx) {
  const keep = (/** @type {string} */ reason) => ({ verdict: /** @type {const} */ ("keep"), reason });
  const names = [chat.name, chat.displayName].filter((n) => typeof n === "string" && n).map((n) => /** @type {string} */ (n).toLowerCase());
  if (names.some((n) => ctx.protected.includes(n)) || (ctx.protectedFolder !== null && chat.path.split("/").includes(ctx.protectedFolder))) return keep("protected");
  if (names.some((n) => ctx.keepList.has(n))) return keep("keep-list");

  const cut = ctx.now - HOUR;
  const ago = (/** @type {number} */ t) => `${Math.round((ctx.now - t) / 60000)}m`;
  if (chat.agents.some((a) => a.state === "working")) return keep("active (agent working)");
  if (chat.shell) return keep(`running-shell (${chat.shell})`);
  const b = ctx.boardChats.find((c) => c.name && names.includes(c.name.toLowerCase()));
  if (b && (b.state === "waiting" || b.state === "stuck")) return keep(`board-state ${b.state}`);
  const touched = b ? Date.parse(b.touchedAt || b.updatedAt || "") : NaN;
  if (b?.state === "working" && touched > cut) return keep(`active (board working ${ago(touched)} ago)`);
  const known = /** @type {number[]} */ ([chat.lastTurnAt, ...chat.agents.map((a) => a.updatedAt)].filter((t) => t != null));
  const recent = known.find((t) => t > cut);
  if (recent != null) return keep(`active (last turn ${ago(recent)} ago)`);
  if (!known.length) return keep("idle-unknown");

  const g = chat.git;
  if (!g) return keep("not-git");
  if (g.dirty) return keep("dirty");
  if (g.unpushed && !ctx.merged.get(g.slug)?.has(g.head)) return keep("unpushed");
  const open = ctx.openPrs.get(g.slug);
  if (!open) return keep("open-pr-unknown");
  const pr = matchPr(g, open);
  if (pr && (ctx.heldPrs.has(pr.number) || chat.prHeld)) return keep(`hold #${pr.number}`);
  if (pr) return keep(`open-pr #${pr.number}`);

  const card = ctx.cards.find((c) => c.kind !== "update" && c.chat && names.includes(c.chat.toLowerCase()));
  if (card) return keep(`board-card ${card.id}`);
  const ask = ctx.asks.find((a) => typeof a.chat === "string" && names.includes(a.chat.toLowerCase()) && !FINISHED_STAGES.includes(stageOfAsk(/** @type {any} */ (a))));
  if (ask) return keep(`ask ${ask.id} ${stageOfAsk(/** @type {any} */ (ask))}`);

  if (chat.signIn) return keep(`owner-sign-in (${chat.signIn})`);
  return { verdict: "close", reason: "" };
}

/**
 * What this pass may do: "close", "list" (decide and report, close nothing) or "aside" (the cron, while the bridge
 * closes). The bridge closes only on mode "bridge" with its row's switch on; the cron never while the knobs file says
 * the switch is off or anything at its path cannot be read as a plain file (knobsClose false; null when there is none).
 * @param {{ from: "bridge" | "cron", mode: string, rowClose: boolean, heartbeat: unknown, now: number, knobsClose?: boolean | null }} o
 * @returns {"close" | "list" | "aside"}
 */
export function stance({ from, mode, rowClose, heartbeat, now, knobsClose = null }) {
  if (from === "bridge") return mode === "bridge" && rowClose ? "close" : "list";
  if (knobsClose === false) return "list";
  if (mode === "close") return "close";
  if (mode !== "bridge") return "list";
  return heartbeatFresh(heartbeat, now) ? "aside" : "close";
}

/** @param {unknown} heartbeat @param {number} now */
export function heartbeatFresh(heartbeat, now) {
  const beat = /** @type {{ by?: unknown, at?: unknown } | null} */ (heartbeat);
  if (beat?.by !== "bridge" || typeof beat.at !== "string") return false;
  const age = now - Date.parse(beat.at);
  return age >= -60_000 && age < HEARTBEAT_FRESH_MS;
}

/**
 * The heartbeat, or null when there is none or it cannot be read. Only a plain file is read: a link, a FIFO or a
 * folder at its path reads as no heartbeat (so the cron takes over) and is never opened for a blocking read.
 * @param {string} [file]
 */
export function readHeartbeat(file = HEARTBEAT_FILE) {
  try {
    return JSON.parse(readPlainFile(file));
  } catch {
    return null;
  }
}

let tmpCount = 0;

/**
 * Replaces a file in one rename, so a reader sees the old one or the new one. The temp file is new (O_EXCL), so a
 * file or link already at its name fails the write rather than being written through. @param {string} file @param {string} text
 */
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${++tmpCount}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, text);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * The knobs file's text, read only when it is a plain file. Throws ENOENT when nothing is at the path, and refuses a
 * link (dangling or not), a FIFO, a folder or a socket without reading it.
 * @param {string} file
 */
function readPlainFile(file) {
  // O_NOFOLLOW refuses a link; O_NONBLOCK opens a FIFO at once, where a blocking open or read would hang the pass.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${file} is not a plain file`);
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The row's switch as the bridge last wrote it; null when nothing is at the knobs path. Anything there (a link, a FIFO,
 * a folder, a file that cannot be read) without a true/false close reads as off, as the backlog puller's readCap
 * starts nothing on one.
 * @param {string} [file]
 */
export function readKnobsClose(file = KNOBS_FILE) {
  let text;
  try {
    text = readPlainFile(file);
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT" ? null : false;
  }
  try {
    const close = JSON.parse(text)?.close;
    return typeof close === "boolean" ? close : false;
  } catch {
    return false;
  }
}

/** @param {number} now @param {string} [file] */
export const writeHeartbeat = (now, file = HEARTBEAT_FILE) => writeAtomic(file, `${JSON.stringify({ by: "bridge", at: new Date(now).toISOString() })}\n`);

/**
 * The closer's lock: its release, or null while another closer holds it (or the lock path is not a plain file with
 * one name). On darwin, where the closers run, it is a
 * kernel lock (O_EXLOCK) on a file that is never removed, so the OS frees a dead holder's lock and no takeover step can
 * race (as the holds file's lock); the pid written in it is for people only.
 * Elsewhere (the tests on CI's Linux) it is an exclusive create with no takeover.
 * @param {string} [file] @param {{ platform?: string }} [o]
 * @returns {(() => void) | null}
 */
export function takeLock(file = LOCK_FILE, { platform = process.platform } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (platform !== "darwin") {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === "EEXIST") return null;
      throw err;
    }
    return () => fs.rmSync(file, { force: true });
  }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | O_EXLOCK | fs.constants.O_NONBLOCK, 0o600);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === "EAGAIN" || code === "EWOULDBLOCK") return null;
    throw err;
  }
  // O_NOFOLLOW stops a symlink, not a hard link: writing through one would overwrite the file it shares.
  const st = fs.fstatSync(fd);
  if (!st.isFile() || st.nlink !== 1) {
    fs.closeSync(fd);
    return null;
  }
  fs.ftruncateSync(fd, fs.writeSync(fd, `${process.pid}\n`, 0));
  let held = true;
  return () => {
    if (held) fs.closeSync(fd);
    held = false;
  };
}

/** Processes started from a tree: cwd or command line inside it, and everything under those. Returns the first command matching re, or "". */
function fromTree(/** @type {string} */ dir, /** @type {Proc[]} */ procs, /** @type {Map<number, string>} */ cwds, /** @type {RegExp} */ re) {
  const inTree = (/** @type {string} */ s) => s === dir || s.startsWith(dir + "/") || s.includes(dir + "/") || s.endsWith(dir);
  /** @type {Map<number, Proc[]>} */
  const kids = new Map();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) || []), p]);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const todo = procs.filter((p) => inTree(p.command) || (cwds.get(p.pid) && inTree(/** @type {string} */ (cwds.get(p.pid))))).map((p) => p.pid);
  const seen = new Set();
  while (todo.length) {
    const pid = /** @type {number} */ (todo.pop());
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = byPid.get(pid);
    if (p && re.test(p.command)) return p.command;
    for (const k of kids.get(pid) || []) todo.push(k.pid);
  }
  return "";
}

/** @typedef {{ pid: number, ppid: number, command: string }} Proc */

/** An emulator, simulator or browser started from a tree: its program name, or "". @param {string} dir @param {Proc[]} procs @param {Map<number, string>} cwds */
export const signInFrom = (dir, procs, cwds) => /** @type {string} */ (fromTree(dir, procs, cwds, SIGN_IN).split(/\s+/)[0].split("/").pop()).slice(0, 40);

/** A shell running a command from a tree (the Bash tool or a background job): what it runs, or "". @param {string} dir @param {Proc[]} procs @param {Map<number, string>} cwds */
export function shellFrom(dir, procs, cwds) {
  const c = fromTree(dir, procs, cwds, SHELL);
  if (!c) return "";
  const cmd = c.replace(SHELL, "").replace(/source \S+shell-snapshots\S+ 2>\/dev\/null \|\| true && /, "").replace(/export PATH=\S+ && /, "").trim();
  return (cmd || c).replace(/\s+/g, " ").slice(0, 60);
}

/** @param {string} text @returns {Proc[]} */
export const parsePs = (text) =>
  /** @type {RegExpExecArray[]} */ (text.split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean)).map((m) => ({ pid: +m[1], ppid: +m[2], command: m[3] }));

/** @param {string} text */
export const parseLsofCwd = (text) => {
  /** @type {Map<number, string>} */
  const cwds = new Map();
  let pid = 0;
  for (const l of text.split("\n")) {
    if (l[0] === "p") pid = +l.slice(1);
    else if (l[0] === "n" && pid) cwds.set(pid, l.slice(1));
  }
  return cwds;
};

/** The newest entry time (ms) inside the .jsonl transcripts under a dir, two levels deep, or null. Claude touches a
 * transcript's file time with no new entry, so the time is read from the entries: the tail of each file newer than the best so far.
 * @param {string} dir */
export function lastTurn(dir) {
  /** @type {[string, number][]} */
  const files = [];
  const walk = (/** @type {string} */ d, /** @type {number} */ depth) => {
    let names;
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 2) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".jsonl"))
        try {
          files.push([p, fs.statSync(p).mtimeMs]);
        } catch {}
    }
  };
  walk(dir, 0);
  /** @type {number | null} */
  let best = null;
  for (const [p, mtime] of files.sort((x, y) => y[1] - x[1])) {
    if (best != null && mtime <= best) break; // an entry is never newer than its file
    const t = lastEntryTime(p);
    if (t != null && (best == null || t > best)) best = t;
  }
  return best;
}

/** The newest "timestamp" in a transcript's last 256 KB, or null. @param {string} p */
function lastEntryTime(p) {
  let fd;
  try {
    fd = fs.openSync(p, "r");
    const size = fs.fstatSync(fd).size, n = Math.min(size, 256 << 10), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    /** @type {number | null} */
    let best = null;
    for (const m of buf.toString("utf8").matchAll(/"timestamp":"([^"]+)"/g)) {
      const t = Date.parse(m[1]);
      if (!Number.isNaN(t) && (best == null || t > best)) best = t;
    }
    return best;
  } catch {
    return null;
  } finally {
    if (fd != null)
      try {
        fs.closeSync(fd);
      } catch {}
  }
}

/** Whether a transcript from the last 2 days mentions starting a device. @param {string} dir @param {number} now */
function transcriptMentionsDevice(dir, now) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((n) => {
    const p = path.join(dir, n);
    try {
      return n.endsWith(".jsonl") && fs.statSync(p).mtimeMs > now - 48 * HOUR && DEVICE_WORDS.test(fs.readFileSync(p, "utf8"));
    } catch {
      return false;
    }
  });
}

/**
 * @param {string} home @param {Record<string, string>} [bins] a command's absolute path by its name
 * @param {{ deadline?: number, onDeadline?: () => never }} [stop] each command runs only before the deadline (ms),
 *   and is killed (SIGKILL, which it cannot ignore) when it runs past it
 */
export const realIo = (home, bins = {}, { deadline = Infinity, onDeadline = () => process.exit(1) } = {}) => ({
  run: (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {import("node:child_process").ExecFileSyncOptions} */ opts = {}) => {
    const left = deadline - Date.now();
    if (left <= 0) onDeadline();
    // A #! script runs through its interpreter, as the bridge's own calls do (config.mjs scriptCommand).
    const c = bins[cmd] ? scriptCommand(bins[cmd], args) : { file: cmd, args };
    return String(execFileSync(c.file, c.args, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"], ...opts, timeout: Math.min(60_000, left), killSignal: "SIGKILL" }));
  },
  now: () => Date.now(),
  read: (/** @type {string} */ p) => fs.readFileSync(p, "utf8"),
  exists: (/** @type {string} */ p) => fs.existsSync(p),
  write: (/** @type {string} */ p, /** @type {string} */ s) => writeAtomic(p, s),
  mtime: (/** @type {string} */ p) => fs.statSync(p).mtimeMs,
  append: (/** @type {string} */ p, /** @type {string} */ s) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, s);
  },
  kill: (/** @type {number} */ pid, /** @type {NodeJS.Signals | 0} */ signal) => process.kill(pid, signal),
  pause: (/** @type {number} */ ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  lastTurnAt: (/** @type {string} */ dir) => lastTurn(transcriptDir(home, dir)),
  mentionsDevice: (/** @type {string} */ dir, /** @type {number} */ now) => transcriptMentionsDevice(transcriptDir(home, dir), now),
  runner: (/** @type {{ ignoreSwitch?: boolean }} */ opts = {}) =>
    readRunner((file, args) => {
      const left = deadline - Date.now();
      if (left <= 0) onDeadline();
      return String(execFileSync(file, args, { encoding: "utf8", timeout: Math.min(60_000, left), killSignal: "SIGKILL", maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "pipe"] }));
    }, opts),
  holds: () => readHolds(HOLDS_FILE).holds,
  ownerLogins: async () => [],
});

const LEFTOVER_WAIT_MS = 3_000;

/** `ps -axo pid=,ppid=,tty=,command=`; tty is "??" (macOS) or "?" (Linux) with no controlling terminal.
 * @param {string} text @returns {(Proc & { tty: string })[]} */
export const parsePsTty = (text) =>
  /** @type {RegExpExecArray[]} */ (text.split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(l)).filter(Boolean)).map((m) => ({ pid: +m[1], ppid: +m[2], tty: m[3], command: m[4] }));

const NO_TTY_RE = /^\?\??$/;
// Shared daemons, sign-ins and editors, never a chat's left-over: these only spare, never select. The multiplexers, adb
// and terminal editors (a headless one may hold unsaved buffers) by program name (a shared server daemonises in whatever
// folder first started it), the rest anywhere in the command line.
const SPARE_BIN_RE = /^(tmux|screen|zellij|dtach|abduco|adb|n?vim|vi|emacs(client)?|nano|hx|helix|kak|micro)$/i;
// Any macOS app bundle (an editor `code .` started detached), and ssh's shared connection master and the key agents.
const SPARE_CMD_RE = new RegExp(`${SIGN_IN.source}|Electron|Code Helper|Cursor|\\.app/Contents/MacOS/|\\[mux\\]|ssh-agent|gpg-agent`, "i");
/** @param {string} command */
export const spareLeftover = (command) => SPARE_BIN_RE.test(path.basename(command.split(/\s+/)[0])) || SPARE_CMD_RE.test(command);

/**
 * Ends what a closed chat left orphaned in its folder (a dev server outlives its terminal and keeps the folder from the
 * disk reaper), read again now, not from the pass's start. A root is a process with its cwd in the folder, parent pid 1
 * and no terminal; the targets are the roots and their descendants whose cwd is in the folder too. So an owner's shell or
 * editor, a split pane, and an open chat's agent (each with a terminal and a live parent) are never touched. Nothing is
 * ever selected by name; a shared daemon or sign-in (spareLeftover) is spared by name, with everything under it.
 * By exact pid: SIGTERM, then SIGKILL for one still there after LEFTOVER_WAIT_MS. Never pid 1, this process or an
 * ancestor of it. An open chat (`others`) at the same folder leaves everything ("shared"); one nested inside keeps its
 * own, and one enclosing this folder spares nothing. Nothing when the folder is no absolute path three folders deep, is
 * home or above it, or ps/lsof cannot be read (null). Returns what it signalled.
 * @param {Io} io @param {string} dir @param {string[]} others
 * @returns {Proc[] | null | "shared"}
 */
export function endLeftovers(io, dir, others) {
  if (!path.isAbsolute(dir)) return [];
  const forms = [...new Set([path.resolve(dir), canon(dir)])];
  const home = canon(os.homedir());
  if (forms.some((d) => d.split("/").filter(Boolean).length < 3 || home === d || home.startsWith(d + "/"))) return [];
  const otherForms = others.filter((o) => path.isAbsolute(o)).flatMap((o) => [path.resolve(o), canon(o)]);
  if (otherForms.some((o) => forms.includes(o))) return "shared";
  const nested = otherForms.filter((o) => forms.some((d) => o.startsWith(d + "/")));
  const within = (/** @type {string[]} */ dirs, /** @type {string} */ cwd) => dirs.some((d) => cwd === d || cwd.startsWith(d + "/"));
  /** @param {(Proc & { tty: string })[]} procs @param {Map<number, string>} cwds */
  const targets = (procs, cwds) => {
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    if (!byPid.has(process.pid)) return null;
    const spared = new Set([process.pid]);
    for (let p = byPid.get(process.pid), i = 0; p && p.ppid > 1 && i < 256; p = byPid.get(p.ppid), i++) spared.add(p.ppid);
    /** @type {Map<number, number[]>} */
    const kids = new Map();
    for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
    const ok = (/** @type {Proc | undefined} */ p) => {
      const cwd = p && cwds.get(p.pid);
      return Boolean(p && p.pid > 1 && !spared.has(p.pid) && !spareLeftover(p.command) && cwd !== undefined && within(forms, cwd) && !within(nested, cwd));
    };
    const todo = procs.filter((p) => p.ppid === 1 && NO_TTY_RE.test(p.tty) && ok(p)).map((p) => p.pid);
    const found = new Set();
    while (todo.length) {
      const pid = /** @type {number} */ (todo.pop());
      if (found.has(pid)) continue;
      found.add(pid);
      for (const kid of kids.get(pid) ?? []) if (ok(byPid.get(kid))) todo.push(kid);
    }
    return procs.filter((p) => found.has(p.pid));
  };
  const read = () => {
    try {
      return targets(parsePsTty(io.run("ps", ["-axo", "pid=,ppid=,tty=,command="])), parseLsofCwd(io.run("lsof", ["-nP", "-a", "-d", "cwd", "-Fpn"])));
    } catch {
      return null;
    }
  };
  const found = read();
  if (!found) return null;
  for (const p of found) {
    try {
      io.kill(p.pid, "SIGTERM");
    } catch {}
  }
  const running = (/** @type {Proc} */ p) => {
    try {
      io.kill(p.pid, 0);
      return true;
    } catch (e) {
      return /** @type {any} */ (e)?.code === "EPERM";
    }
  };
  const until = Date.now() + LEFTOVER_WAIT_MS;
  while (found.some(running) && Date.now() < until) io.pause(50);
  // Read again before the SIGKILL: a pid that ended since may be another process's now.
  const still = new Set((found.some(running) ? read() ?? [] : []).map((p) => p.pid));
  for (const p of found.filter((f) => still.has(f.pid) && running(f))) {
    try {
      io.kill(p.pid, "SIGKILL");
    } catch {}
  }
  return found;
}

/** @typedef {ReturnType<typeof realIo>} Io */
/** @typedef {Awaited<ReturnType<typeof chatsConfig>>} ChatsCfg */

/**
 * @typedef {{ stance: "close" | "list" | "aside" | "locked", at: string, open?: number, working?: number, partial?: boolean,
 *   aborted?: string, kept: { name: string, reason: string }[], closed: string[] }} PassResult
 */

/**
 * One pass: the stance, then the count and each chat's verdict, closing when the stance and the lock allow.
 * @param {{ from: "bridge" | "cron", rowClose?: boolean, io: Io, cfg: ChatsCfg, home: string, tmp?: string,
 *   heartbeatFile?: string, lockFile?: string, knobsFile?: string }} o
 * @returns {Promise<PassResult>}
 */
export async function closePass({ from, rowClose = false, io, cfg, home, tmp = os.tmpdir(), heartbeatFile = HEARTBEAT_FILE, lockFile = LOCK_FILE, knobsFile = KNOBS_FILE }) {
  const now = io.now();
  const at = new Date(now).toISOString();
  let mode = "";
  try {
    mode = io.read(cfg.modeFile).trim();
  } catch {}
  let st = stance({ from, mode, rowClose, heartbeat: readHeartbeat(heartbeatFile), now, knobsClose: from === "cron" ? readKnobsClose(knobsFile) : null });
  // The cron logs every pass, as it always has; the bridge only the passes it closes in.
  const stamp = stampOf(now);
  const logs = () => from === "cron" || st === "close";
  const line = (/** @type {string} */ chat, /** @type {string} */ verdict, /** @type {string} */ reason) => {
    if (logs()) io.append(cfg.logFile, `${stamp} ${st === "close" ? "close" : "list"} ${chat} ${verdict} ${reason}\n`);
  };
  /** @type {PassResult} */
  const result = { stance: st, at, kept: [], closed: [] };
  if (st === "aside") {
    line("-", "none", "bridge closes");
    return result;
  }
  /** @type {(() => void) | null} */
  let release = null;
  if (st === "close") {
    release = takeLock(lockFile);
    if (!release) {
      if (from === "cron") {
        line("-", "none", "run skipped: another closer runs");
        return { ...result, stance: "locked" };
      }
      st = "list";
      result.stance = "locked";
    }
  }
  try {
    return await gatherAndClose({ st, io, cfg, home, tmp, now, line, result });
  } finally {
    release?.();
  }
}

/**
 * @param {{ st: "close" | "list", io: Io, cfg: ChatsCfg, home: string, tmp: string, now: number, result: PassResult,
 *   line: (chat: string, verdict: string, reason: string) => void }} o
 * @returns {Promise<PassResult>}
 */
async function gatherAndClose({ st, io, cfg, home, tmp, now, line, result }) {
  const abort = (/** @type {string} */ why) => {
    line("-", "none", `run skipped: ${why}`);
    return { ...result, aborted: why };
  };
  const json = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {import("node:child_process").ExecFileSyncOptions} */ opts = {}) => JSON.parse(io.run(cmd, args, opts));

  /** @type {Array<{ handle: string, worktreePath?: string, title?: string }>} */
  let terminals = [];
  /** @type {Array<{ path: string, displayName?: string, agents?: { state?: string, updatedAt?: number }[] }>} */
  let worktrees = [];
  let partial = false;
  if (cfg.app) {
    const app = cfg.app;
    try {
      const list = readTerminals((file, args) => io.run(file, args), app);
      terminals = list.terminals;
      partial = list.truncated;
      worktrees = json(app, ["worktree", "ps", "--json", "--limit", "1000"]).result.worktrees;
    } catch {
      return abort(`${app} unreachable`);
    }
  }
  /** @type {Array<{ worktree: string, title?: string }>} */
  let runner = [];
  try {
    runner = io.runner();
  } catch {
    partial = true;
  }
  const numbers = count({ terminals, runner });
  Object.assign(result, { open: numbers.chats, working: numbers.working, partial });

  let keepList = new Set();
  if (cfg.keepListFile) {
    try {
      const k = JSON.parse(io.read(cfg.keepListFile));
      keepList = new Set((Array.isArray(k) ? k : k.keep).map((/** @type {unknown} */ n) => String(n).toLowerCase()));
    } catch {
      return abort("keep list unreadable");
    }
  }

  const boardFile = path.join(tmp, `.chats-close-board-${process.pid}.json`);
  let cards, boardChats, asks;
  try {
    io.run(process.execPath, [RIVET_CLI, "board", "--out", boardFile]);
    const board = JSON.parse(io.read(boardFile)).board;
    cards = board.needs;
    boardChats = board.chats || [];
  } catch {
    return abort("rivet board unreadable");
  } finally {
    fs.rmSync(boardFile, { force: true });
  }
  try {
    const out = json(process.execPath, [RIVET_CLI, "ask", "list", "--all", "--json"]);
    asks = Array.isArray(out) ? out : out.asks;
    if (!Array.isArray(asks)) throw new Error("no asks");
  } catch {
    return abort("rivet asks unreadable");
  }
  /** @type {Set<number>} */
  const heldPrs = new Set();
  try {
    for (const h of io.holds()) {
      const until = typeof h.until === "string" ? Date.parse(h.until) : Infinity;
      if (typeof h.pr === "number" && until > now) heldPrs.add(h.pr);
    }
  } catch {
    return abort("holds file unreadable");
  }

  /** @type {Proc[]} */
  let procs = [];
  /** @type {Map<number, string>} */
  let cwds = new Map();
  try {
    procs = parsePs(io.run("ps", ["-axo", "pid=,ppid=,command="]));
    cwds = parseLsofCwd(io.run("lsof", ["-nP", "-a", "-d", "cwd", "-Fpn"]));
  } catch {
    return abort("ps/lsof failed");
  }
  const deviceUp = procs.some((p) => /launchd_sim|qemu-system/.test(p.command));

  /** @type {Map<string, typeof terminals>} */
  const byPath = new Map();
  for (const t of terminals) {
    if (!t.worktreePath) continue;
    if (!byPath.has(t.worktreePath)) byPath.set(t.worktreePath, []);
    /** @type {typeof terminals} */ (byPath.get(t.worktreePath)).push(t);
  }
  const wtByPath = new Map(worktrees.map((w) => [w.path, w]));

  const git = (/** @type {string} */ p, /** @type {string[]} */ ...args) => io.run("git", ["-C", p, ...args]).trim();
  /** @type {Context} */
  const ctx = { now, protected: cfg.protected, protectedFolder: cfg.protectedFolder, keepList, cards, boardChats, asks, heldPrs, merged: new Map(), openPrs: new Map() };
  const fetched = new Set();
  const fetchOpen = (/** @type {string} */ slug) => {
    if (fetched.has(slug) || !slug.includes("/")) return;
    fetched.add(slug);
    try {
      ctx.openPrs.set(slug, json("gh", ["pr", "list", "-R", slug, "--state", "open", "--limit", "500", "--json", "number,headRefName,headRefOid"]));
    } catch {}
  };
  const fetchMerged = (/** @type {string} */ slug) => {
    if (ctx.merged.has(slug)) return;
    const f = path.join(CHATS_DIR, `merged-${slug.replace(/\//g, "_")}`);
    try {
      const fresh = io.exists(f) && now - io.mtime(f) < MERGED_MAX_AGE_MS;
      const heads = fresh ? io.read(f) : io.run("gh", ["pr", "list", "-R", slug, "--state", "merged", "--limit", "1500", "--json", "headRefOid", "-q", ".[].headRefOid"]);
      ctx.merged.set(slug, new Set(heads.split("\n").filter(Boolean)));
      if (!fresh) io.write(f, heads);
    } catch {
      ctx.merged.set(slug, new Set());
    }
  };
  const owners = await io.ownerLogins();
  /** A hold line in the PR's body or a standing owner comment; a PR that cannot be read is only kept as open. @param {string} slug @param {number} n */
  const prHeld = (slug, n) => {
    try {
      const pr = json("gh", ["pr", "view", String(n), "-R", slug, "--json", "body,comments"]);
      const comments = (pr.comments ?? []).map((/** @type {any} */ c) => ({ login: String(c.author?.login ?? ""), body: String(c.body ?? "") }));
      return prHold({ body: String(pr.body ?? ""), comments }, owners) !== null;
    } catch {
      return false;
    }
  };

  /** @type {Array<{ worktree: string }> | undefined} */
  let runnerAll;
  for (const [dir, terms] of [...byPath].sort(([a], [b]) => a.localeCompare(b))) {
    const w = wtByPath.get(dir);
    /** @type {Chat} */
    const chat = {
      path: dir, name: path.basename(dir), displayName: w?.displayName,
      agents: (w?.agents || []).map((a) => ({ state: a.state, updatedAt: a.updatedAt ?? null })),
      lastTurnAt: io.lastTurnAt(dir), git: null, signIn: "", shell: shellFrom(dir, procs, cwds),
    };
    try {
      const slug = repoSlug(git(dir, "remote", "get-url", "origin"));
      chat.git = {
        slug,
        head: git(dir, "rev-parse", "HEAD"),
        branch: git(dir, "rev-parse", "--abbrev-ref", "HEAD"),
        dirty: git(dir, "status", "--porcelain") !== "",
        unpushed: git(dir, "rev-list", "-1", "HEAD", "--not", "--remotes=origin") !== "",
      };
      fetchOpen(slug);
      if (chat.git.unpushed) fetchMerged(slug);
      const pr = ctx.openPrs.has(slug) ? matchPr(chat.git, /** @type {OpenPr[]} */ (ctx.openPrs.get(slug))) : undefined;
      if (pr && !heldPrs.has(pr.number)) chat.prHeld = prHeld(slug, pr.number);
    } catch {}
    chat.signIn = signInFrom(dir, procs, cwds) || (deviceUp && io.mentionsDevice(dir, now) ? "device in its transcript" : "");

    let { verdict, reason } = /** @type {{ verdict: string, reason: string }} */ (decide(chat, ctx));
    if (verdict === "close" && st === "list") {
      verdict = "would-close";
      reason = "(all tests pass)";
    } else if (verdict === "close") {
      try {
        for (const t of terms) io.run(/** @type {string} */ (cfg.app), ["terminal", "close", "--terminal", t.handle, "--json"]);
        verdict = "closed";
        reason = "closed";
        try {
          io.run(process.execPath, [RIVET_CLI, "chat", "drop", chat.name]);
        } catch {} // a 404 is fine
      } catch (e) {
        verdict = "close-failed";
        reason = String(/** @type {any} */ (e).stderr || /** @type {any} */ (e).message || e).split("\n")[0].slice(0, 120);
      }
    }
    line(chat.name, verdict, reason);
    // A partial list may leave out an open chat nested in this folder, whose processes are its own.
    if (verdict === "closed" && partial) line(chat.name, "left-overs", "not ended: the open chats were not all read");
    else if (verdict === "closed") {
      // Read with the runner's switch ignored: its sessions may still be live with the switch off.
      try {
        runnerAll ??= io.runner({ ignoreSwitch: true });
      } catch {}
      // Give the closed terminal's processes time to exit, so what they leave is orphaned (parent pid 1, no terminal)
      // when it is read: no later pass sees this chat again.
      if (runnerAll) io.pause(LEFTOVER_WAIT_MS);
      // The runner's chats are all open, so one at this very folder means the folder is shared.
      const ended = runnerAll ? endLeftovers(io, dir, [...[...byPath.keys()].filter((d) => d !== dir), ...runnerAll.map((r) => r.worktree)]) : "unread";
      if (ended === "unread") line(chat.name, "left-overs", "not ended: the runner chats could not be read");
      else if (!ended) line(chat.name, "left-overs", "not ended: ps/lsof failed");
      else if (ended === "shared") line(chat.name, "left-overs", "not ended: another open chat shares the folder");
      else if (ended.length) line(chat.name, "left-overs", `ended ${ended.map((p) => `${p.pid} ${p.command.replace(/\s+/g, " ").slice(0, 60)}`).join(", ")}`);
    }
    if (verdict === "keep" && !/^(active\b|protected$)/.test(reason)) result.kept.push({ name: chat.name, reason });
    if (verdict === "closed") result.closed.push(chat.name);
  }
  return result;
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ from: "bridge" | "cron" | null, close: boolean, bins: Record<string, string> }} */
  const o = { from: null, close: false, bins: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from" && (argv[i + 1] === "bridge" || argv[i + 1] === "cron")) o.from = /** @type {"bridge" | "cron"} */ (argv[++i]);
    else if (a === "--close" && (argv[i + 1] === "on" || argv[i + 1] === "off")) o.close = argv[++i] === "on";
    else if (a === "--bin" && /^[a-z]+=\//.test(argv[i + 1] ?? "")) {
      const [name, ...rest] = argv[++i].split("=");
      o.bins[name] = rest.join("=");
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!o.from) throw new Error("usage: chats-close.mjs --from cron | --from bridge --close on|off [--bin <name>=<path>]");
  return o;
}

const canon = (/** @type {string} */ p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

if (process.argv[1] && canon(process.argv[1]) === canon(fileURLToPath(import.meta.url))) {
  const o = parseArgs(process.argv.slice(2));
  const home = os.homedir();
  const cfg = await chatsConfig();
  /** @type {{ deadline?: number, onDeadline?: () => never }} */
  let stop = {};
  if (o.from === "cron") {
    const onDeadline = () => {
      try {
        fs.mkdirSync(path.dirname(cfg.logFile), { recursive: true });
        fs.appendFileSync(cfg.logFile, `${stampOf(Date.now())} close - none run stopped: past ten minutes\n`);
      } catch {}
      process.exit(1);
    };
    stop = { deadline: Date.now() + CRON_DEADLINE_MS, onDeadline };
    setTimeout(onDeadline, CRON_DEADLINE_MS).unref();
  }
  const result = await closePass({ from: /** @type {"bridge" | "cron"} */ (o.from), rowClose: o.close, io: realIo(home, o.bins, stop), cfg, home, tmp: process.env.AUTO_CLOSE_TMP || undefined });
  if (o.from === "bridge") process.stdout.write(`${JSON.stringify(result)}\n`);
}
