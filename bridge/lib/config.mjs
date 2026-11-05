import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTransientText } from "./github-classifier.mjs";

export const DEFAULT_URL = "http://127.0.0.1:8130";
/** The Keychain service the tokens are read from (never written here); the account is the setting's name. */
export const KEYCHAIN_SERVICE = "rivet-agents";
export const SECURITY_BIN = "/usr/bin/security";

const TOKEN_RE = /^[0-9a-fA-F]{64}$/;

/**
 * @typedef {(file: string, args: string[], opts: { timeout: number, maxBuffer?: number, input?: string, cwd?: string, env?: Record<string, string> })
 *   => Promise<{ stdout: string, stderr: string }>} Exec
 *   `input` goes to the command's stdin, so owner text never sits in its arguments; `env` is added to the token-free env.
 */

/** Rejects with this instead of execFile's error, whose message echoes every argument. */
export class ExecError extends Error {
  /**
   * @param {string} bin
   * @param {{ code?: unknown, signal?: unknown, killed?: unknown }} info
   * @param {string} stderr
   * @param {string} [stdout] kept for tools that report through stdout on a non-zero exit
   */
  constructor(bin, info, stderr, stdout = "") {
    const detail = info.killed ? "timed out" : `exit ${info.code ?? "?"}${info.signal ? ` ${info.signal}` : ""}`;
    super(`${path.basename(bin)} ${detail}`);
    this.code = info.code;
    // Keep classification without retaining arguments or the full stderr.
    this.transientGitHub = Boolean(info.killed) || info.code === "ETIMEDOUT" || isTransientText(stderr);
    this.stderrFirstLine = String(stderr ?? "").split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
    this.stdout = String(stdout ?? "");
  }
}

/**
 * The empty directory `claude -p` runs in, made if missing: the CLI lists its working directory's files at start, and a
 * big one (such as $TMPDIR) makes every call slow. Nothing writes into it.
 * @param {string} [home]
 */
export function claudeCwd(home = os.homedir()) {
  const dir = path.join(home, ".rivet-agents", "bridge", "claude-cwd");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A copy of `env` without any Rivet credential: every RIVET_*TOKEN* variable, today's and any added later.
 * @param {NodeJS.ProcessEnv} env
 */
export function withoutRivetTokens(env) {
  const out = { ...env };
  for (const key of Object.keys(out)) if (/^RIVET_.*TOKEN/i.test(key)) delete out[key];
  return out;
}

/**
 * The command that runs `file`: a `#!` script through its interpreter, as the kernel would, anything else as it is.
 * Under launchd, exec'ing a script inside an app bundle can stall on the system's code assessment, which interactive
 * shells skip; running its interpreter directly does not. Only `#!<absolute interpreter> [one argument]` is rewritten;
 * any other first line runs as is.
 * @param {string} file @param {string[]} args @param {(file: string) => string} [readHead] the file's first bytes
 * @returns {{ file: string, args: string[] }}
 */
export function scriptCommand(file, args, readHead = firstBytes) {
  let head = "";
  try {
    head = readHead(file);
  } catch {}
  const end = head.indexOf("\n");
  if (!head.startsWith("#!") || end < 0) return { file, args };
  const [interpreter, ...rest] = head.slice(2, end).trim().split(/[ \t]+/);
  if (!interpreter || !path.isAbsolute(interpreter) || rest.length > 1) return { file, args };
  return { file: interpreter, args: [...rest, file, ...args] };
}

/** The first 256 bytes of a regular file; non-blocking, so a FIFO in its place cannot hang the event loop. */
function firstBytes(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) return "";
    const buf = Buffer.alloc(256);
    return buf.toString("utf8", 0, fs.readSync(fd, buf, 0, buf.length, 0));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * execFile with no shell, a timeout, and an environment without Rivet tokens; a script runs through its interpreter.
 * @returns {Exec}
 */
export function makeExec() {
  const env = withoutRivetTokens(process.env);
  return (file, args, { timeout, maxBuffer = 4 * 1024 * 1024, input, cwd, env: extra }) => {
    if (!path.isAbsolute(file)) return Promise.reject(new Error("binary path must be absolute"));
    const command = scriptCommand(file, args);
    return new Promise((resolve, reject) => {
      const child = execFile(
        command.file,
        command.args,
        { timeout, maxBuffer, cwd, env: extra ? { ...env, ...extra } : env, shell: false, windowsHide: true, encoding: "utf8" },
        (err, stdout, stderr) => {
          if (err) reject(new ExecError(file, /** @type {any} */ (err), stderr, stdout));
          else resolve({ stdout, stderr });
        },
      );
      if (input !== undefined) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(input);
      }
    });
  };
}

/**
 * Absolute path of an executable on PATH, resolved once at startup.
 * @param {string} name
 * @param {string} [envPath]
 */
export function resolveBin(name, envPath = process.env.PATH ?? "") {
  for (const dir of envPath.split(":")) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {}
  }
  throw new Error(`${name} not found on PATH`);
}

/**
 * The server origin from RIVET_URL: https, or http only for localhost.
 * @param {string | undefined} raw
 */
export function serverOrigin(raw = DEFAULT_URL) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("RIVET_URL is not a valid URL");
  }
  if (url.username || url.password) throw new Error("RIVET_URL must not carry credentials");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error("RIVET_URL must be https (http only for localhost)");
  return url.origin;
}

/** sha256 of the token as stored, first 12 hex. @param {string} token */
export function fingerprint(token) {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12);
}

/**
 * Reads a Rivet token: the environment variable of that name, else the login Keychain (service `rivet-agents`, account
 * the name). Read only: nothing here writes the Keychain.
 * @param {Exec} exec
 * @param {"RIVET_BRIDGE_TOKEN" | "RIVET_BOARD_TOKEN"} name
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function readToken(exec, name, env = process.env) {
  let token;
  if (env[name]) {
    token = String(env[name]);
  } else {
    let out;
    try {
      out = await exec(SECURITY_BIN, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"], { timeout: 10_000, maxBuffer: 64 * 1024 });
    } catch {
      throw new Error(`could not read ${name} from the environment or the Keychain`);
    }
    token = out.stdout.replace(/\r?\n$/, "");
  }
  if (!TOKEN_RE.test(token)) throw new Error(`${name} is not 64 hex characters`);
  return token;
}

/**
 * One log line: ISO time, event, key=value fields. Callers pass ids and statuses
 * only, never tokens or reply text.
 * @param {string} event
 * @param {Record<string, unknown>} [fields]
 */
export function formatLog(event, fields = {}) {
  const parts = [new Date().toISOString(), event];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const s = String(v).replace(/[\x00-\x20\x7f-\x9f"]+/g, "_").slice(0, 200);
    parts.push(`${k}=${s}`);
  }
  return parts.join(" ");
}
