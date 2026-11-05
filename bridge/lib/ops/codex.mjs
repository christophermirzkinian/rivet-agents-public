import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { iso } from "./common.mjs";

// OpenAI (Codex) plan usage for the Ops Usage tab: the signed-in account's windows and purchased credits. A Codex
// app-server started under CODEX_HOME (~/.codex when unset) answers `account/rateLimits/read` and `account/read`. Only
// those replies are read; the sign-in in CODEX_HOME is never opened, logged or sent anywhere. A home's reading is kept for
// CODEX_READ_TTL_MS, so a pass starts no app-server for a home read within it; a home that fails or hangs keeps its last
// reading, marked stale, on its own row. Rows ride on the Claude usage PUT after the Claude rows, kinds
// `codex_<n>_<window>`. OpenAI sends no grading, so the bridge grades them: 90% used is a warning, 100% critical.

export const CODEX_INTERVAL_MS = 5 * 60_000;
/** Rows older than this are dropped rather than shown as current. */
export const CODEX_STALE_MS = 15 * 60_000;
/** A home read within this is not read again: at most one app-server per home per five minutes. */
export const CODEX_READ_TTL_MS = 5 * 60_000;
/** A failed home's last good reading shows, marked stale, for this long; after it, "no reading". */
const CODEX_KEEP_MS = 6 * 60 * 60_000;
const RPC_TIMEOUT_MS = 20_000;
const MAX_ACCOUNTS = 4;
const MASK_RE = /^[a-z0-9._-]{1,2}$/i;

/** @typedef {{ kind: string, label: string, percent: number, severity: "normal" | "warning" | "critical", resetsAt: string | null, active: false, credits?: number | null, unlimited?: boolean }} Row */
/** @typedef {{ mins: number | null, percent: number | null, resetsAt: number | null }} Window */
/** @typedef {{ windows: Window[], credits: { unlimited: boolean, balance: number | null } | null }} Limits */
/** @typedef {{ limits: Limits | null, signedIn: boolean | null, email: string | null }} Reading */

// A plain address and nothing else.
const ACCOUNT_EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;

/**
 * Who a home is signed in as, from an `account/read` reply. A reply naming no account is signed out; an error or a
 * malformed reply is unknown, never signed out.
 * @param {any} message @returns {{ signedIn: boolean | null, email: string | null }}
 */
export function parseCodexAccountRead(message) {
  const result = message && typeof message === "object" && !message.error ? message.result : null;
  if (!result || typeof result !== "object" || !("account" in result)) return { signedIn: null, email: null };
  if (!result.account) return { signedIn: false, email: null };
  const email = result.account.email;
  return { signedIn: true, email: typeof email === "string" && ACCOUNT_EMAIL_RE.test(email) ? email : null };
}

/** "ch***" from an email; "?***" when it has no usable start. @param {unknown} email */
function maskOf(email) {
  const start = typeof email === "string" ? email.split("@")[0]?.slice(0, 2) ?? "" : "";
  return `${MASK_RE.test(start) ? start : "?"}***`;
}

/** @param {any} window @returns {Window | null} */
function windowOf(window) {
  if (!window || typeof window !== "object") return null;
  const num = (/** @type {unknown} */ v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const used = num(window.usedPercent);
  return {
    mins: num(window.windowDurationMins),
    percent: used === null ? null : Math.min(100, Math.max(0, Math.round(used * 10) / 10)),
    resetsAt: num(window.resetsAt),
  };
}

/**
 * One `account/rateLimits/read` reply: its windows and credits, or null when it has none.
 * @param {any} message
 * @returns {Limits | null}
 */
export function parseCodexLimits(message) {
  const limits = message && typeof message === "object" && !message.error ? message.result?.rateLimits : null;
  if (!limits || typeof limits !== "object") return null;
  const windows = [windowOf(limits.primary), windowOf(limits.secondary)].filter((w) => w !== null);
  if (!windows.length) return null;
  const c = limits.credits;
  const balance = c && typeof c === "object" ? Number(c.balance) : NaN;
  const credits = c && typeof c === "object" ? { unlimited: c.unlimited === true, balance: Number.isFinite(balance) && balance >= 0 && balance <= 1e9 ? balance : null } : null;
  return { windows, credits };
}

/** "5 hr", "week", or the window's length. @param {number | null} mins */
function windowName(mins) {
  if (mins === 300) return "5 hr";
  if (mins === 10_080) return "week";
  if (mins === null) return "window";
  return mins % 1440 === 0 ? `${mins / 1440} days` : `${Math.round(mins / 60)} hr`;
}

const WARN_PCT = 90;

/** @param {number | null} percent @returns {Row["severity"]} */
function severityOf(percent) {
  return percent === null ? "normal" : percent >= 100 ? "critical" : percent >= WARN_PCT ? "warning" : "normal";
}

/**
 * Usage rows, one per window per account, shortest window first. Every label names
 * its window ("5 hr", "week"), so a reset under a bar is that window's. The longest
 * window's row also carries the account's credits as fields (the Spend card reads
 * them). An account with no reply shows one "no reading" row; `note` ("stale", "signed out") rides on every label.
 * @param {{ mask: string, note?: string, limits: Limits | null }[]} accounts
 * @returns {Row[]}
 */
export function codexRows(accounts) {
  /** @type {Row[]} */
  const rows = [];
  accounts.forEach((account, i) => {
    const n = i + 1;
    const active = account.note ?? "";
    if (!account.limits) {
      rows.push({ kind: `codex_${n}`, label: `${account.mask} (${[active, "no reading"].filter(Boolean).join(", ")})`, percent: 0, severity: "normal", resetsAt: null, active: false });
      return;
    }
    const windows = [...account.limits.windows].sort((a, b) => (a.mins ?? Infinity) - (b.mins ?? Infinity));
    windows.forEach((window, w) => {
      const longest = w === windows.length - 1;
      const notes = [active, window.percent === null ? "no reading" : ""].filter(Boolean);
      const name = windowName(window.mins);
      const credits = account.limits?.credits ?? null;
      rows.push({
        kind: `codex_${n}_${name.replace(/\s+/g, "")}`.slice(0, 40),
        label: `${account.mask}, ${name}${notes.length ? ` (${notes.join(", ")})` : ""}`.slice(0, 60),
        percent: window.percent ?? 0,
        severity: severityOf(window.percent),
        resetsAt: window.percent === null || window.resetsAt === null ? null : iso(window.resetsAt * 1000),
        active: false,
        ...(longest ? { credits: credits?.balance ?? null, unlimited: credits?.unlimited === true } : {}),
      });
    });
  });
  return rows;
}

/**
 * Asks a Codex app-server running under `home` for its rate limits and its sign-in: `account/rateLimits/read` and
 * `account/read` (no refresh asked: a chat on the home owns its sign-in). Whatever has not answered by the timeout
 * stays unknown. The server runs in its own process group, killed whole when the read ends, so a hung server or a child
 * it started never outlives the read.
 * @param {string} codexBin @param {string} home
 * @param {{ spawn?: typeof spawn, timeoutMs?: number }} [opts]
 * @returns {Promise<Reading>}
 */
export function readCodexAccount(codexBin, home, opts = {}) {
  const run = opts.spawn ?? spawn;
  return new Promise((resolve) => {
    let settled = false;
    /** @type {import("node:child_process").ChildProcess} */
    let child;
    /** @type {Limits | null} */
    let limits = null;
    let who = { signedIn: /** @type {boolean | null} */ (null), email: /** @type {string | null} */ (null) };
    let answered = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child) {
        try {
          if (!child.pid) throw new Error("no pid");
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill?.("SIGKILL");
        }
      }
      resolve({ limits, ...who });
    };
    const timer = setTimeout(finish, opts.timeoutMs ?? RPC_TIMEOUT_MS);
    try {
      // From the home, never the bridge's own directory: a project .codex there would load first.
      child = run(codexBin, ["app-server"], { cwd: home, env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "ignore"], detached: true });
    } catch {
      finish();
      return;
    }
    child.on("error", finish);
    child.on("close", finish);
    // A server that exits mid-handshake breaks the pipe: an unhandled EPIPE would take the whole bridge down.
    child.stdin?.on("error", finish);
    const send = (/** @type {unknown} */ message) => {
      if (child.stdin && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    let buffer = "";
    child.stdout?.on("data", (data) => {
      buffer += String(data);
      if (buffer.length > 1024 * 1024) return finish();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message?.id === 1) {
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} });
          send({ jsonrpc: "2.0", id: 3, method: "account/read", params: { refreshToken: false } });
        } else if (message?.id === 2 || message?.id === 3) {
          if (message.id === 2) limits = parseCodexLimits(message);
          else who = parseCodexAccountRead(message);
          if (++answered === 2) finish();
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "rivet-agents-bridge", title: "Rivet Agents", version: "0.0.1" } } });
  });
}

/** @typedef {{ at: number, limits: Limits | null, signedIn: boolean | null, mask: string | null, goodAt: number | null }} Cached */

/**
 * The Codex home, or none when it is not on this Mac. @param {NodeJS.ProcessEnv} [env]
 * @returns {{ id: string, home: string }[]}
 */
export function codexHomes(env = process.env) {
  const home = env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return fs.existsSync(home) ? [{ id: "default", home }] : [];
}

/**
 * Every home's rows. A home read within CODEX_READ_TTL_MS is not read again; the rest are read at once, each
 * capped by its own timeout, so one hung home never holds up the pass or the others. A read that fails keeps the home's
 * last good reading, marked stale, for up to six hours.
 * @param {{ codexBin: string, read?: typeof readCodexAccount, now?: () => number, cache?: Map<string, Cached>, list?: typeof codexHomes }} deps
 */
export async function collectCodex(deps) {
  const read = deps.read ?? readCodexAccount;
  const now = deps.now ?? Date.now;
  const cache = deps.cache ?? new Map();
  const homes = (deps.list ?? codexHomes)().slice(0, MAX_ACCOUNTS);
  for (const id of [...cache.keys()]) if (!homes.some((h) => h.id === id)) cache.delete(id);
  await Promise.all(
    homes.map(async ({ id, home }) => {
      const was = cache.get(id);
      const t = now();
      if (was && t - was.at < CODEX_READ_TTL_MS) return;
      /** @type {Reading} */
      let got = { limits: null, signedIn: null, email: null };
      try {
        got = await read(deps.codexBin, home);
      } catch {
        // A reader that throws is a failed read, never a failed pass.
      }
      const mask = got.email ? maskOf(got.email) : was?.mask ?? null;
      if (got.limits) cache.set(id, { at: t, limits: got.limits, signedIn: got.signedIn, mask, goodAt: t });
      else if (got.signedIn === false) cache.set(id, { at: t, limits: null, signedIn: false, mask, goodAt: null });
      else cache.set(id, { at: t, limits: was?.limits ?? null, signedIn: got.signedIn ?? was?.signedIn ?? null, mask, goodAt: was?.goodAt ?? null });
    }),
  );
  const t = now();
  return codexRows(
    homes.map(({ id }) => {
      const c = cache.get(id);
      const kept = c?.goodAt != null && t - c.goodAt < CODEX_KEEP_MS;
      const note = c?.signedIn === false ? "signed out" : kept && c.goodAt !== c.at ? "stale" : "";
      return { mask: c?.mask ?? "?***", note, limits: kept ? c.limits : null };
    }),
  );
}
