// The chat runner: the one way any script lists, starts, sends to, reads and closes a chat, over the registry
// (~/.rivet-agents/chats/registry.json) and tmux. Every tmux call goes through tmux() with `-S <socket path>`: the
// path `-L <socket>` (RIVET_CHAT_TMUX_SOCKET, default rivet-chat) names under this context's TMUX_TMPDIR, so nothing
// here ever reaches another tmux server, even one of the same name. Every path comes from the context, so a test runs
// on a throwaway HOME and socket.
//
// A chat is keyed by its name and runs plain `claude` or `codex` on the user's own login, in an existing directory, in
// a tmux session of the same name. Its pane runs `/usr/bin/env -i /bin/sh <spec>`: the spec, written 0600 and removed
// by its first line, sets only an allowlisted environment and execs the agent, so the pane's pid is the agent's and
// leads its own process group, and no argv carries an environment value. The registry has one writer at a time (a
// lock dir naming its owner), is written to a temp file and renamed (0600), and a registry that cannot be parsed, or
// is a link, refuses every write.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const PROVIDERS = new Set(["claude", "codex"]);
const SOCKET_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// The tmux server keeps the environment it was started with, so it gets only these, never a secret.
const TMUX_ENV = new Set(["PATH", "HOME", "TERM", "LANG", "TMPDIR", "TMUX_TMPDIR", "USER", "LOGNAME", "SHELL"]);
// All a pane is given of the caller's environment.
const PANE_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];
const LOCK_STALE_MS = 30_000;
const SPEC_MAX_AGE_MS = 10 * 60_000;
const CLOSE_WAIT_MS = 3_000;
const PANE_TERM = "screen-256color";
const SEND_PIECE_BYTES = 8_000;
// A spec path tmux records with one spelling, so no other argv can pass for it.
const PLAIN_PATH_RE = /^[A-Za-z0-9._/@+-]+$/;

/**
 * The runner's context: every root and dependency, injectable. `bins` maps a provider to the program it runs
 * (default its own name on PATH).
 */
export function context(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const socket = opts.socket ?? env.RIVET_CHAT_TMUX_SOCKET ?? "rivet-chat";
  if (!SOCKET_RE.test(socket) || socket.toLowerCase() === "default") throw new Error(`rivet-chat: bad tmux socket name ${JSON.stringify(socket)}`);
  return {
    home,
    env,
    socket,
    socketPath: opts.socketPath ?? socketPathFor(env, socket),
    registry: opts.registry ?? path.join(home, ".rivet-agents", "chats", "registry.json"),
    tmuxBin: opts.tmuxBin ?? "tmux",
    bins: { claude: "claude", codex: "codex", ...(opts.bins ?? {}) },
    now: opts.now ?? (() => Date.now()),
    lockWaitMs: opts.lockWaitMs ?? 10_000,
  };
}

const iso = (ms) => new Date(ms).toISOString();
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** The socket path tmux gives `-L <socket>` under `env`'s TMUX_TMPDIR: `<realpath of it, or /tmp>/tmux-<uid>/<socket>`. */
export function socketPathFor(env, socket) {
  const dir = env.TMUX_TMPDIR || "/tmp";
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    real = path.resolve(dir);
  }
  return path.join(real, `tmux-${process.getuid()}`, socket);
}

/** The one tmux call: always on the runner's own socket, never on the user's tmux config. */
export function tmux(ctx, args, { inherit = false } = {}) {
  const env = Object.fromEntries(Object.entries(ctx.env).filter(([name]) => TMUX_ENV.has(name) || name.startsWith("LC_")));
  // tmux makes and checks its socket's dir only for -L; with -S both are done here: a dir of this user's alone, never a link.
  const dir = path.dirname(ctx.socketPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o007) !== 0) {
    throw new Error(`rivet-chat: ${dir} is not a tmux socket dir of this user's alone; nothing is run on it`);
  }
  // -u: a launchd job has no locale, and without it tmux prints _ for every non-ASCII mark.
  const r = spawnSync(ctx.tmuxBin, ["-S", ctx.socketPath, "-f", "/dev/null", "-u", ...args], {
    env,
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    ...(inherit ? {} : { timeout: 15_000 }),
  });
  return { ok: !r.error && r.status === 0, status: r.status, stdout: r.stdout ?? "", stderr: r.stderr || r.error?.message || "" };
}

/** The session names on the runner's server; empty when no server runs. Throws when tmux itself cannot be asked. */
export function sessions(ctx) {
  const r = tmux(ctx, ["list-sessions", "-F", "#{session_name}"]);
  if (r.ok) return new Set(r.stdout.split("\n").filter(Boolean));
  if (/no server running|error connecting to|No such file/.test(r.stderr)) return new Set();
  throw new Error(`rivet-chat: tmux cannot list sessions (${r.stderr.trim().slice(0, 200)})`);
}

const paneText = (ctx, id, format) => {
  const r = tmux(ctx, ["display-message", "-p", "-t", id, format]);
  return r.ok ? r.stdout.replace(/\n$/, "") : null;
};

/**
 * The chat's own pane: the one it recorded, marked with its name (`@rivet_chat`). Gone is no session; foreign is a
 * session of that name with no pane of the chat's, which nothing here acts on.
 */
function paneState(ctx, entry) {
  const r = tmux(ctx, ["list-panes", "-s", "-t", `=${entry.session}`, "-F", "#{pane_id} #{pane_dead} #{pane_pid}"]);
  if (!r.ok) return sessions(ctx).has(entry.session) ? { state: "foreign" } : { state: "gone" };
  const pane = r.stdout.split("\n").map((line) => /^(%\d+) ([01]) (\d*)$/.exec(line)).find((m) => m && m[1] === entry.paneId);
  if (!pane || paneText(ctx, pane[1], "#{@rivet_chat}") !== entry.name) return { state: "foreign" };
  return pane[2] === "1" ? { state: "dead", paneId: pane[1] } : { state: "alive", paneId: pane[1], pid: Number(pane[3]) };
}

// --- the registry ---

export class RegistryBusy extends Error {}
const emptyRegistry = () => ({ version: 1, chats: {} });

/** The registry, or an empty one when there is no file. Throws on a file that cannot be parsed, or one that is not a plain file. */
export function readRegistry(ctx) {
  let fd;
  try {
    fd = fs.openSync(ctx.registry, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT") return emptyRegistry();
    if (error?.code === "ELOOP") throw new Error(`rivet-chat: ${ctx.registry} is a link; nothing is written until it is fixed by hand`);
    throw error;
  }
  let text;
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`rivet-chat: ${ctx.registry} is not a plain file; nothing is written until it is fixed by hand`);
    text = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new Error(`rivet-chat: ${ctx.registry} cannot be parsed (${error.message}); nothing is written until it is fixed by hand`);
  }
  if (!doc || typeof doc !== "object" || !doc.chats || typeof doc.chats !== "object" || Array.isArray(doc.chats)) {
    throw new Error(`rivet-chat: ${ctx.registry} is not a chat registry; nothing is written until it is fixed by hand`);
  }
  return doc;
}

const pidDead = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
};

const HOLDER_RE = /^(\d+)-[0-9a-f-]{36}$/i;

/**
 * Runs `fn(mine)` holding the registry's lock: a dir holding one file named by its holder (`<pid>-<uuid>`), made aside
 * and renamed into place, so a held lock is never an empty dir. A lock whose holder is dead, or that names none and is
 * older than LOCK_STALE_MS, is freed file by file, then removed only while empty.
 */
function withLock(ctx, fn) {
  const lock = `${ctx.registry}.lock`;
  const token = `${process.pid}-${randomUUID()}`;
  const mine = () => fs.existsSync(path.join(lock, token));
  fs.mkdirSync(path.dirname(ctx.registry), { recursive: true, mode: 0o700 });
  const start = Date.now();
  for (;;) {
    const made = `${lock}.${token}`;
    fs.mkdirSync(made);
    fs.writeFileSync(path.join(made, token), "");
    try {
      fs.renameSync(made, lock);
      break;
    } catch (error) {
      fs.rmSync(made, { recursive: true, force: true });
      if (!["EEXIST", "ENOTEMPTY", "ENOENT"].includes(error?.code)) throw error;
    }
    try {
      const names = fs.readdirSync(lock);
      const holder = names.length === 1 ? HOLDER_RE.exec(names[0]) : null;
      if (holder ? pidDead(Number(holder[1])) : Date.now() - fs.lstatSync(lock).mtimeMs > LOCK_STALE_MS) {
        for (const name of names) fs.unlinkSync(path.join(lock, name));
        fs.rmdirSync(lock);
      }
    } catch {}
    if (Date.now() - start > ctx.lockWaitMs) throw new RegistryBusy(`rivet-chat: ${lock} stayed locked`);
    pause(20);
  }
  try {
    return fn(mine);
  } finally {
    if (mine()) {
      fs.rmSync(path.join(lock, token), { force: true });
      try {
        fs.rmdirSync(lock);
      } catch {}
    }
  }
}

/** Runs `fn(doc)` holding the registry's lock and writes the doc back (temp file, then rename, 0600); returns fn's result. */
export function withRegistry(ctx, fn) {
  return withLock(ctx, (mine) => {
    const doc = readRegistry(ctx);
    const result = fn(doc);
    const tmp = `${ctx.registry}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (!mine()) {
      fs.rmSync(tmp, { force: true });
      throw new RegistryBusy(`rivet-chat: ${ctx.registry}.lock was taken; nothing written`);
    }
    fs.renameSync(tmp, ctx.registry);
    return result;
  });
}

/** The chat `ref` names: its name, its tmux session, or its directory (when one chat runs there). */
export function findChat(doc, ref) {
  const all = Object.values(doc.chats);
  const byName = all.find((e) => e.name === ref || e.session === ref);
  if (byName) return byName;
  if (path.isAbsolute(ref)) {
    const byDir = all.filter((e) => e.worktree === path.resolve(ref) && e.status !== "finished");
    if (byDir.length === 1) return byDir[0];
    if (byDir.length > 1) throw new Error(`rivet-chat: ${ref} has ${byDir.length} chats (${byDir.map((e) => e.name).join(", ")}); name one`);
  }
  throw new Error(`rivet-chat: no chat ${ref}`);
}

// --- launching ---

const extraArgs = (value) => String(value ?? "").split(/\s+/).filter(Boolean);

/** A chat's argv: the provider's program, the user's extra args (RIVET_CLAUDE_ARGS / RIVET_CODEX_ARGS), then its prompt. */
export function launchFor(ctx, provider, prompt = null) {
  if (!PROVIDERS.has(provider)) throw new Error(`rivet-chat: --provider is claude or codex, not ${provider}`);
  const args = extraArgs(provider === "codex" ? ctx.env.RIVET_CODEX_ARGS : ctx.env.RIVET_CLAUDE_ARGS);
  // `--`: a prompt that names a subcommand (`logout`) or a flag must never run as one.
  return { command: ctx.bins[provider], args: prompt ? [...args, "--", prompt] : args };
}

const launchDir = (ctx) => path.join(path.dirname(ctx.registry), "launch");

/** Removes launch files no pane ran within SPEC_MAX_AGE_MS (a pane removes its own as it starts). */
function sweepSpecs(ctx) {
  let names;
  try {
    names = fs.readdirSync(launchDir(ctx));
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(launchDir(ctx), name);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (name.endsWith(".sh") && stat?.isFile() && Date.now() - stat.mtimeMs > SPEC_MAX_AGE_MS) fs.rmSync(file, { force: true });
  }
}

/** Starts `launch` in a new session for `entry`, marks its pane with the chat's name, and returns { paneId, pid }. */
function startPane(ctx, entry, launch) {
  const env = { LANG: "en_US.UTF-8" };
  for (const name of PANE_ENV) if (ctx.env[name] !== undefined) env[name] = ctx.env[name];
  env.TERM = PANE_TERM;
  const lines = ['rm -f -- "$0"'];
  for (const [name, value] of Object.entries(env)) {
    if (ENV_NAME_RE.test(name) && !String(value).includes("\0")) lines.push(`export ${name}=${quote(value)}`);
  }
  lines.push(`cd -- ${quote(entry.worktree)} || exit 1`, `exec ${[launch.command, ...launch.args].map(quote).join(" ")}`);
  sweepSpecs(ctx);
  const spec = path.join(launchDir(ctx), `${randomUUID()}.sh`);
  if (!PLAIN_PATH_RE.test(spec)) throw new Error(`rivet-chat: ${launchDir(ctx)} has a character tmux would quote; a chat starts only from a plain path`);
  fs.mkdirSync(path.dirname(spec), { recursive: true, mode: 0o700 });
  fs.writeFileSync(spec, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
  // remain-on-exit keeps a pane whose agent exited, so its exit is told apart from a server that went away.
  const server = ["set-option", "-g", "remain-on-exit", "on", ";", "set-option", "-g", "default-terminal", PANE_TERM, ";"];
  const r = tmux(ctx, [...server, "new-session", "-d", "-P", "-F", "#{pane_id} #{pane_pid}", "-s", entry.session, "-c", entry.worktree, "-x", "200", "-y", "50", "/usr/bin/env", "-i", "/bin/sh", spec]);
  if (!r.ok) {
    fs.rmSync(spec, { force: true });
    throw new Error(`rivet-chat: tmux could not start ${entry.session} (${r.stderr.trim().slice(0, 200)})`);
  }
  const [paneId = "", pid = ""] = r.stdout.trim().split("\n").at(-1).split(" ");
  if (!/^%\d+$/.test(paneId) || !tmux(ctx, ["set-option", "-p", "-t", paneId, "@rivet_chat", entry.name]).ok) {
    tmux(ctx, ["kill-session", "-t", `=${entry.session}`]);
    throw new Error(`rivet-chat: tmux could not mark ${entry.session} as its chat's`);
  }
  return { paneId, pid: Number(pid) || null };
}

/** The `owner/name` a checkout's origin names, or null. */
export function originRepo(dir) {
  const r = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.error || r.status !== 0) return null;
  const m = /[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/*$/.exec(r.stdout.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

// --- the API ---

export const list = (ctx) => Object.values(readRegistry(ctx).chats);

/**
 * Every registry chat with its tmux state: alive, dead (its agent exited), gone (no session) or foreign. An alive
 * one also has its pane's title and last output time.
 */
export function ps(ctx) {
  const live = sessions(ctx);
  return list(ctx).map((entry) => {
    if (entry.socketPath !== ctx.socketPath) return { ...entry, state: `socket ${entry.socketPath ?? "(none)"}` };
    if (!live.has(entry.session)) return { ...entry, state: "gone" };
    const pane = paneState(ctx, entry);
    if (pane.state !== "alive") return { ...entry, state: pane.state };
    const activity = Number(paneText(ctx, pane.paneId, "#{window_activity}"));
    return { ...entry, state: "alive", title: paneText(ctx, pane.paneId, "#{pane_title}") ?? "", ...(activity > 0 ? { lastOutputAt: activity * 1000 } : {}) };
  });
}

/** Starts a chat named `name` running `provider` in the existing directory `cwd`. */
export function create(ctx, { name, cwd, provider = "claude", prompt = null }) {
  if (!NAME_RE.test(name ?? "")) throw new Error(`rivet-chat: bad chat name ${JSON.stringify(name)}`);
  if (prompt != null && typeof prompt !== "string") throw new Error("rivet-chat: a prompt is text");
  const launch = launchFor(ctx, provider, prompt || null);
  let dir;
  try {
    dir = fs.realpathSync(cwd);
  } catch {
    throw new Error(`rivet-chat: ${cwd} does not exist`);
  }
  if (!fs.statSync(dir).isDirectory()) throw new Error(`rivet-chat: ${dir} is not a directory`);
  const held = readRegistry(ctx).chats[name];
  if (held && held.status !== "finished") throw new Error(`rivet-chat: ${name} is already a chat (${held.status}); close it first`);
  if (sessions(ctx).has(name)) throw new Error(`rivet-chat: tmux session ${name} already exists`);
  const entry = {
    name, session: name, worktree: dir, repo: originRepo(dir), provider, socket: ctx.socket, socketPath: ctx.socketPath,
    paneId: null, pid: null, status: "starting", started: iso(ctx.now()),
  };
  withRegistry(ctx, (doc) => {
    if (doc.chats[name] && doc.chats[name].status !== "finished") throw new Error(`rivet-chat: ${name} is already a chat`);
    doc.chats[name] = entry;
  });
  let pane;
  try {
    pane = startPane(ctx, entry, launch);
  } catch (error) {
    withRegistry(ctx, (doc) => {
      if (doc.chats[name]?.started === entry.started && doc.chats[name].status === "starting") delete doc.chats[name];
    });
    throw error;
  }
  return withRegistry(ctx, (doc) => {
    Object.assign(doc.chats[name], { ...pane, status: "running" });
    return { ...doc.chats[name] };
  });
}

/** The registry chat `ref` names, refused when it runs on another tmux server than this context's. */
function chatHere(ctx, ref) {
  const entry = findChat(readRegistry(ctx), ref);
  if (entry.socketPath !== ctx.socketPath) throw new Error(`rivet-chat: ${entry.session} runs on tmux socket ${entry.socketPath}, not ${ctx.socketPath}`);
  return entry;
}

/** The chat with its live pane, refused when it has none. */
function runningChat(ctx, ref) {
  const entry = chatHere(ctx, ref);
  const pane = paneState(ctx, entry);
  if (pane.state === "gone") throw new Error(`rivet-chat: ${entry.session} has no tmux session`);
  if (pane.state === "foreign") throw new Error(`rivet-chat: tmux session ${entry.session} has no pane of the chat's`);
  return entry;
}

/** `text` in pieces tmux takes: one command over about 16 KB is refused as too long. Never splits a character. */
export function sendPieces(text) {
  const pieces = [];
  let piece = "";
  let bytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > SEND_PIECE_BYTES) {
      pieces.push(piece);
      piece = "";
      bytes = 0;
    }
    piece += ch;
    bytes += size;
  }
  return piece ? [...pieces, piece] : pieces;
}

/** Types `text` into the chat, then Enter. */
export function send(ctx, ref, text) {
  const entry = runningChat(ctx, ref);
  for (const keys of [...sendPieces(text).map((piece) => ["-l", "--", piece]), ["Enter"]]) {
    const r = tmux(ctx, ["send-keys", "-t", entry.paneId, ...keys]);
    if (!r.ok) throw new Error(`rivet-chat: send to ${entry.session} failed (${r.stderr.trim().slice(0, 200)})`);
  }
  return entry;
}

/** Escape: the agent's own pause. */
export function interrupt(ctx, ref) {
  const entry = runningChat(ctx, ref);
  const r = tmux(ctx, ["send-keys", "-t", entry.paneId, "Escape"]);
  if (!r.ok) throw new Error(`rivet-chat: interrupt of ${entry.session} failed (${r.stderr.trim().slice(0, 200)})`);
  return entry;
}

/** The last `lines` lines of the chat's screen. */
export function read(ctx, ref, { lines = 60 } = {}) {
  const entry = runningChat(ctx, ref);
  const n = Math.max(1, Math.min(10_000, Number(lines) || 60));
  const r = tmux(ctx, ["capture-pane", "-p", "-J", "-t", entry.paneId, "-S", `-${n}`]);
  if (!r.ok) throw new Error(`rivet-chat: read of ${entry.session} failed (${r.stderr.trim().slice(0, 200)})`);
  return r.stdout.replace(/\s+$/, "").split("\n").slice(-n).join("\n");
}

/** Attaches this terminal to the chat. */
export function attach(ctx, ref) {
  const entry = runningChat(ctx, ref);
  return tmux(ctx, ["attach-session", "-t", `=${entry.session}`], { inherit: true }).status ?? 1;
}

const pgidOf = (pid) => {
  const r = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const pgid = Number(r.stdout?.trim());
  return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
};
const groupAlive = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

/**
 * Ends the chat's own process group (its pane's pid leads it), never anything found by name, then its session. A
 * session with no pane of the chat's is left alone. Returns whether a session is left.
 */
function stopSession(ctx, entry) {
  const pane = paneState(ctx, entry);
  if (pane.state === "gone") return false;
  if (pane.state === "foreign") return true;
  if (pane.state === "alive") {
    const pgid = pgidOf(pane.pid);
    if (pgid && pgid === pane.pid && pgid > 1 && pgid !== pgidOf(process.pid)) {
      try {
        process.kill(-pgid, "SIGTERM");
      } catch {}
      const until = Date.now() + CLOSE_WAIT_MS;
      while (groupAlive(pgid) && Date.now() < until) pause(50);
      if (groupAlive(pgid)) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {}
      }
    }
  }
  tmux(ctx, ["kill-session", "-t", `=${entry.session}`]);
  return sessions(ctx).has(entry.session);
}

/** Marks the chat finished, then stops its session. */
export function close(ctx, ref) {
  const entry = chatHere(ctx, ref);
  const done = withRegistry(ctx, (doc) => {
    const e = doc.chats[entry.name];
    if (e && e.status !== "finished") Object.assign(e, { status: "finished", finishedAt: iso(ctx.now()) });
    return { ...(e ?? entry) };
  });
  return { ...done, sessionLeft: stopSession(ctx, done) };
}
