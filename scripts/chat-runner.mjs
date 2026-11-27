// The chat runner: the one way any script lists, starts, sends to, reads and closes a chat, over the registry
// (~/.rivet-agents/chats/registry.json) and tmux. Every tmux call goes through tmux() with `-S <socket path>`: the
// path `-L <socket>` (RIVET_CHAT_TMUX_SOCKET, default rivet-chat) names under this context's TMUX_TMPDIR, so nothing
// here ever reaches another tmux server, even one of the same name. Every path comes from the context, so a test runs
// on a throwaway HOME and socket.
//
// A chat is keyed by its name and runs plain `claude` or `codex` on the user's own login, in an existing directory, in
// a tmux session of the same name. Its pane runs `/usr/bin/env -i /bin/sh <spec>`: the spec, written 0600 and removed
// by its first line, sets only an allowlisted environment and execs the agent, so the pane's pid is the agent's and
// leads its own process group, and no argv carries an environment value. RIVET_CHAT_NAME in that environment names
// the chat to its agent. The registry has one writer at a time (a
// lock dir naming its owner), is written to a temp file and renamed (0600), and a registry that cannot be parsed, or
// is a link, refuses every write.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logForced, mismatch, refusal as misplacedRefusal } from "../bridge/lib/chat-guard.mjs";
import { agentName, CHAT_PROVIDER, codexChatArgs, connected, copilotChatArgs, FIRST_PLAN_UNREAD, firstPlan, limitWords, notConnectedLine, otherPlans, PLAN_NAMES, planOfProvider, plansHere, plansOn, screenLimit, STATUS_ARGS, STATUS_BIN } from "../bridge/lib/job-drivers.mjs";
import { loadProjects, projectsFromFolders } from "../bridge/lib/projects.mjs";
import { repoAllowlist } from "../src/shared/repos.ts";

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const PROVIDERS = new Set(["claude", "codex", "copilot"]);
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
 * (default its own name on PATH), and `copilot-status` to the program that says whether Copilot is signed in.
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
    bins: { claude: "claude", codex: "codex", copilot: "copilot", "copilot-status": "copilot-status", ...(opts.bins ?? {}) },
    now: opts.now ?? (() => Date.now()),
    lockWaitMs: opts.lockWaitMs ?? 10_000,
    routeLists: opts.routeLists ?? (() => projectLists(env, home)),
    log: opts.log ?? ((line) => process.stderr.write(`${line}\n`)),
  };
}

/**
 * The projects a chat's ask is routed among: the list RIVET_PROJECTS_FILE names, else one per work clone under
 * ~/.rivet-agents/work, each the RIVET_REPOS repo of its folder's name. No product registry: products are a monorepo's.
 */
export function projectLists(env, home) {
  if (env.RIVET_PROJECTS_FILE) return { projects: loadProjects({ file: env.RIVET_PROJECTS_FILE }), products: [], worktreeRoots: [] };
  const repos = repoAllowlist(env);
  const projects = projectsFromFolders(path.join(home, ".rivet-agents", "work")).map((p) => ({ ...p, githubRepo: repos.find((repo) => repo.split("/").pop()?.toLowerCase() === p.workspaceRepo.toLowerCase()) ?? null }));
  return { projects, products: [], worktreeRoots: [] };
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

/**
 * A chat's argv: the provider's program, the user's extra args (RIVET_CLAUDE_ARGS / RIVET_CODEX_ARGS /
 * RIVET_COPILOT_ARGS), then its prompt.
 */
export function launchFor(ctx, provider, prompt = null) {
  if (!PROVIDERS.has(provider)) throw new Error(`rivet-chat: --provider is claude, codex or copilot, not ${provider}`);
  if (provider === "copilot") {
    // Copilot takes a chat's first words as an option's value, and after `=` words that name a flag are never read as one.
    const args = [...copilotChatArgs(ctx.env), ...extraArgs(ctx.env.RIVET_COPILOT_ARGS)];
    return { command: ctx.bins.copilot, args: prompt ? [...args, `--interactive=${prompt}`] : args };
  }
  const extra = extraArgs(provider === "codex" ? ctx.env.RIVET_CODEX_ARGS : ctx.env.RIVET_CLAUDE_ARGS);
  // A hosted agent's Codex chat asks as its Claude chat does (bridge/lib/job-drivers.mjs codexChatArgs).
  const args = provider === "codex" && plansOn(ctx.env) ? [...codexChatArgs(ctx.env), ...extra] : extra;
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
  // The chat's own name, which `rivet card add` takes for --chat when none is given, so an answer comes back to this
  // chat. The pane has no TMUX, so tmux cannot tell its agent the name.
  env.RIVET_CHAT_NAME = entry.name;
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

/** The project whose folder (`~/` read as `home`) most closely holds the real path `dir`, or undefined. */
function cloneOf(dir, lists, home) {
  let best;
  let depth = -1;
  for (const p of lists.projects) {
    if (!p.folder) continue;
    let folder;
    try {
      folder = fs.realpathSync(p.folder === "~" || p.folder.startsWith("~/") ? path.join(home, p.folder.slice(1)) : p.folder);
    } catch {
      continue;
    }
    const rel = path.relative(folder, dir);
    const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    if (inside && folder.length > depth) {
      best = p;
      depth = folder.length;
    }
  }
  return best;
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

/** @param {NodeJS.ProcessEnv} env */
function firstProvider(env) {
  const plan = firstPlan(env);
  if (!plan) throw new Error(`rivet-chat: ${FIRST_PLAN_UNREAD} (RIVET_AGENT_FILE), so no chat started`);
  return CHAT_PROVIDER[plan];
}

/**
 * A hosted agent's chat runs on its owner's own plan, so one whose plan is definitely signed out is refused before
 * anything starts; a status that gave no answer starts it as it always has. The other plans' status only chooses the
 * words: a chat never moves to one by itself.
 */
function refuseSignedOut(ctx, provider) {
  if (!plansOn(ctx.env)) return;
  const plan = planOfProvider(provider);
  if (connected(plan, signInStatus(ctx, plan)) !== false) return;
  const others = otherPlans(plan).map((other) => ({ other, ran: signInStatus(ctx, other) }));
  const on = others.filter(({ other, ran }) => connected(other, ran) === true).map(({ other }) => other);
  // A machine with no copilot-status cannot connect GitHub Copilot, so the words there do not name it.
  const here = plansHere(!others.some(({ other, ran }) => other === "copilot" && ran.missing));
  throw new Error(`rivet-chat: no chat started. ${notConnectedLine(plan, false, on, firstPlan(ctx.env), here)}.`);
}

/**
 * Starts a chat named `name` running `provider` in the existing directory `cwd`. With no provider named, a hosted
 * agent's chat runs on its first plan (RIVET_AGENT_FILE's firstPlan), any other on Claude; one whose agent file cannot
 * be read, or whose plan is signed out, starts none. A prompt that plainly belongs to another repo's project than the chat's is refused unless
 * `forceProject` gives a reason, which is logged once the chat runs (bridge/lib/chat-guard.mjs), unless `forceLogged`
 * says its caller logged it. The prompt is checked against `repo` (owner/name) when given and against the project `cwd`
 * is in: the project folder holding it, else its origin.
 */
export function create(ctx, { name, cwd, provider = plansOn(ctx.env) ? firstProvider(ctx.env) : "claude", prompt = null, repo = null, forceProject = null, forceLogged = false }) {
  if (!NAME_RE.test(name ?? "")) throw new Error(`rivet-chat: bad chat name ${JSON.stringify(name)}`);
  if (prompt != null && typeof prompt !== "string") throw new Error("rivet-chat: a prompt is text");
  if (forceProject !== null && (typeof forceProject !== "string" || !forceProject.trim())) throw new Error("rivet-chat: --force-project needs a reason");
  let dir;
  try {
    dir = fs.realpathSync(cwd);
  } catch {
    throw new Error(`rivet-chat: ${cwd} does not exist`);
  }
  if (!fs.statSync(dir).isDirectory()) throw new Error(`rivet-chat: ${dir} is not a directory`);
  let misplaced = null;
  let forced = null;
  if (prompt) {
    try {
      const lists = ctx.routeLists();
      // The ask must fit both the repo named and the project the chat actually runs in: its folder, else its origin.
      const own = cloneOf(dir, lists, ctx.home)?.workspaceRepo ?? originRepo(dir) ?? null;
      // The folder the chat runs in first, so a forced open logs that project.
      for (const candidate of new Set([own, repo || null].filter(Boolean))) {
        misplaced = mismatch({ ask: prompt, forced: candidate }, lists);
        if (misplaced) {
          forced = candidate;
          break;
        }
      }
    } catch (err) {
      ctx.log(`rivet-chat: warning: the project lists could not be read, so ${name} opens unguarded (${err.message})`);
    }
  }
  if (misplaced && forceProject === null) throw new Error(`rivet-chat: ${misplacedRefusal(misplaced)}`);
  const launch = launchFor(ctx, provider, prompt || null);
  const held = readRegistry(ctx).chats[name];
  if (held && held.status !== "finished") throw new Error(`rivet-chat: ${name} is already a chat (${held.status}); close it first`);
  if (sessions(ctx).has(name)) throw new Error(`rivet-chat: tmux session ${name} already exists`);
  refuseSignedOut(ctx, provider);
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
  const running = withRegistry(ctx, (doc) => {
    Object.assign(doc.chats[name], { ...pane, status: "running" });
    return { ...doc.chats[name] };
  });
  // A log that fails never undoes an open, which a caller would retry into a second chat.
  if (misplaced && !forceLogged) {
    try {
      logForced({ home: ctx.home, chat: name, forced, routed: misplaced.routed.id, reason: forceProject, now: ctx.now() });
    } catch (error) {
      ctx.log(`rivet-chat: ${name}'s forced open was not logged (${error.message})`);
    }
  }
  return running;
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

/**
 * A plan's sign-in status from its own CLI (Copilot's from `copilot-status`), in the environment a pane gets:
 * { code, lines }, stdout then stderr (Codex says "Not logged in" on stderr). A CLI that would not start or ran out of
 * time has code null. It is read from the home folder, never a chat's own, whose project settings could answer for the plan.
 */
function signInStatus(ctx, plan) {
  const env = Object.fromEntries(PANE_ENV.filter((name) => ctx.env[name] !== undefined).map((name) => [name, ctx.env[name]]));
  const r = spawnSync(ctx.bins[STATUS_BIN[plan]] ?? STATUS_BIN[plan], [...STATUS_ARGS[plan]], { cwd: ctx.home, env, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) return { code: null, lines: [], missing: /** @type {NodeJS.ErrnoException} */ (r.error).code === "ENOENT" };
  return { code: r.status, lines: plan === "claude" ? String(r.stdout ?? "").split("\n") : `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n"), missing: false };
}

/**
 * A hosted agent's chats whose screen ends on their plan's usage limit, each asked about once: when another plan is
 * signed in, `post` gets the card's words; no chat is ever moved to another plan. A chat's mark goes once its screen no
 * longer shows the limit, so a later limit asks again. Nothing is read on a machine with no agent file.
 * The agent runtime's supervisor calls it once a minute and posts each ask as a board card.
 * @param {ReturnType<typeof context>} ctx
 * `since` is when the chat's screen first showed this limit, the same on every ask about it until the screen clears;
 * `chat` is the chat itself, its name and start. A post that throws is logged and the next chat is asked.
 * @param {{ post: (ask: { chat: string, name: string, plan: string, until: string | null, since: string, text: string }) => Promise<unknown> | unknown, status?: typeof signInStatus }} d
 */
export async function limitCheck(ctx, { post, status = signInStatus }) {
  if (!plansOn(ctx.env)) return [];
  const asked = [];
  for (const entry of ps(ctx)) {
    if (entry.state !== "alive") continue;
    let lines;
    try {
      lines = read(ctx, entry.name, { lines: 40 }).split("\n");
    } catch {
      continue;
    }
    const plan = planOfProvider(entry.provider);
    const hit = screenLimit(entry.provider, lines);
    const mark = hit ? `${plan} ${hit.until ?? ""}` : null;
    // When this limit was first seen on the chat's screen: it tells one limit from the next, whatever it says or the day.
    const seen = !mark ? null : entry.limitSeen?.mark === mark ? entry.limitSeen : { mark, at: iso(ctx.now()) };
    if ((entry.limitAsked ?? null) === mark && (entry.limitSeen ?? null) === seen) continue;
    /** @param {string | null | undefined} asks the chat's asked mark, or undefined to leave it */
    const remember = (asks) =>
      withRegistry(ctx, (doc) => {
        const e = doc.chats[entry.name];
        if (!e || e.started !== entry.started) return;
        if (seen) e.limitSeen = seen;
        else delete e.limitSeen;
        if (asks) e.limitAsked = asks;
        else if (asks === null) delete e.limitAsked;
      });
    if (hit) {
      if (entry.limitSeen !== seen) remember(undefined);
      if ((entry.limitAsked ?? null) === mark) continue;
      // The first of the other plans that is signed in, in their order.
      const other = otherPlans(plan).find((one) => connected(one, status(ctx, one)) === true);
      if (!other) continue;
      const Other = PLAN_NAMES[other];
      const ask = {
        chat: `${entry.name} ${entry.started}`,
        name: entry.name,
        plan,
        until: hit.until,
        since: seen.at,
        text: `${limitWords(plan, hit.until)}. Chat ${entry.name} waits for it. ${Other} is ready: ask ${agentName(ctx.env) ?? "your agent"} to start a new chat on ${Other}. New chats start on the plan that goes first: change it on the Plans page.`,
      };
      try {
        await post(ask);
      } catch (err) {
        // One chat's post that fails leaves the others to be asked; this one is asked again next time.
        process.stderr.write(`rivet-chat: limit card for ${entry.name} not posted (${err instanceof Error ? err.message : String(err)})\n`);
        continue;
      }
      asked.push(ask);
    }
    remember(mark);
  }
  return asked;
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
