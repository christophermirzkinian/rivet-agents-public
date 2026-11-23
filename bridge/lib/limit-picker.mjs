// Limit autopilot's picker: which account new work should go to when the one it is on is full, read from the account
// usage job's status file. The owner's version runs it from the bridge (a private loop writes the settings file below
// each minute from Settings › Behaviours) and from the account usage job and the wake job, which import this file.
//
// The settings file is the only switch those jobs read. It counts only while the bridge keeps rewriting it: a file that
// is missing, malformed, says off, or is older than AUTOPILOT_FRESH_MS turns the autopilot off, and every job goes back
// to what it did before the autopilot existed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AUTOPILOT_FILE = process.env.RIVET_LIMIT_AUTOPILOT_FILE || path.join(os.homedir(), ".rivet", "limit-autopilot", "settings.json");
export const AUTOPILOT_FRESH_MS = 10 * 60_000;
const FUTURE_SKEW_MS = 60_000;
/** An account's dir name under the usage job's accounts root. */
const ACCOUNT_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const MAX_ACCOUNTS = 16;
const KEYS = new Set(["on", "switchAt", "nearestReset", "accounts", "wake", "at"]);
/** A reading older than this names no account: the usage job reads one not in use every 30 minutes. */
export const PICK_FRESH_MS = 30 * 60_000;
export const READING_STALE_MS = 45 * 60_000;
/** The usage job status file's error for an account dir with no sign-in; its rows there carry no signedIn flag. */
const NOT_SIGNED_IN = "not signed in";

/**
 * @typedef {{ percent?: number, resetsAt?: string | null, unread?: boolean } | null | undefined} Window
 * @typedef {{ account?: string, weekly?: Window, session?: Window, readAt?: string | null, error?: string | null,
 *   signedIn?: boolean, signedOut?: boolean, idle?: boolean }} AccountReading
 * @typedef {{ on: true, switchAt: number, nearestReset: boolean, accounts: string[], wake: boolean } | { on: false }} Autopilot
 */

/**
 * The autopilot's knobs while the bridge keeps the file fresh, else `{ on: false }`. `wake`: the bridge has the wake
 * script and runs the wake pass itself, so the scheduled run may stand aside.
 * @param {{ file?: string, now?: number }} [opts]
 * @returns {Autopilot}
 */
export function readAutopilot({ file = AUTOPILOT_FILE, now = Date.now() } = {}) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { on: false };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Object.keys(doc).every((key) => KEYS.has(key))) return { on: false };
  const { on, switchAt, nearestReset, accounts, wake, at } = doc;
  const written = typeof at === "string" ? Date.parse(at) : NaN;
  if (on !== true || !Number.isFinite(written) || now - written > AUTOPILOT_FRESH_MS || written - now > FUTURE_SKEW_MS) return { on: false };
  if (!Number.isInteger(switchAt) || switchAt < 50 || switchAt > 99 || typeof nearestReset !== "boolean") return { on: false };
  if (!Array.isArray(accounts) || accounts.length > MAX_ACCOUNTS || !accounts.every((name) => typeof name === "string" && ACCOUNT_RE.test(name))) return { on: false };
  if (wake !== undefined && typeof wake !== "boolean") return { on: false };
  return { on: true, switchAt, nearestReset, accounts: [...accounts], wake: wake === true };
}

/**
 * Writes the settings file whole (beside it, then renamed over it), stamped with `now`.
 * @param {{ on: boolean, switchAt?: number, nearestReset?: boolean, accounts?: string[], wake?: boolean }} value
 * @param {{ file?: string, now?: number }} [opts]
 */
export function writeAutopilot(value, { file = AUTOPILOT_FILE, now = Date.now() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...value, at: new Date(now).toISOString() })}\n`, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

/** An empty list means every account takes part. @param {string} name @param {readonly string[]} accounts */
export const takesPart = (name, accounts) => accounts.length === 0 || accounts.includes(name);

/** A window's percent, 0 once its reset has passed; null when there is none. @param {Window} w @param {number} now */
function used(w, now) {
  if (!w || typeof w.percent !== "number" || !Number.isFinite(w.percent)) return null;
  const reset = Date.parse(w.resetsAt ?? "");
  return Number.isFinite(reset) && reset <= now ? 0 : w.percent;
}

/** A window's reset time; Infinity when unknown, as is the next one once the reset has passed. @param {Window} w @param {number} now */
const resetMs = (w, now) => {
  const t = Date.parse(w?.resetsAt ?? "");
  return Number.isFinite(t) && t > now ? t : Infinity;
};
const score = (/** @type {AccountReading} */ a, /** @type {number} */ now) => Math.max(used(a.weekly, now) ?? 0, used(a.session, now) ?? 0);

/**
 * Orders accounts with room: the nearest weekly reset first (its week is used or lost), then the most room; or the most
 * room first, then the nearest reset.
 * @param {{ nearestReset: boolean, now?: number }} opts
 * @returns {(x: AccountReading, y: AccountReading) => number}
 */
export function roomOrder({ nearestReset, now = Date.now() }) {
  return nearestReset
    ? (x, y) => resetMs(x.weekly, now) - resetMs(y.weekly, now) || score(x, now) - score(y, now)
    : (x, y) => score(x, now) - score(y, now) || resetMs(x.weekly, now) - resetMs(y.weekly, now);
}

/**
 * The account new work should go to: one taking part, signed in, read without error within `freshMs` (an idle account's
 * reading stands, as nothing has used it since), with a week it could read and every window under `switchAt`. With none,
 * when the first room comes back: the soonest moment one taking-part account's full windows have all reset (null when no
 * reset time is known).
 * @param {readonly AccountReading[]} accounts the usage job status file's `accounts`
 * @param {{ switchAt: number, nearestReset: boolean, takePart?: readonly string[], now?: number, freshMs?: number }} opts
 * @returns {{ pick: string } | { wait: { until: string | null } }}
 */
export function pickAccount(accounts, { switchAt, nearestReset, takePart = [], now = Date.now(), freshMs = PICK_FRESH_MS }) {
  const taking = accounts.filter((a) => typeof a?.account === "string" && takesPart(a.account, takePart) && a.signedIn !== false && a.signedOut !== true && !a.error);
  const room = taking.filter((a) => {
    const read = Date.parse(a.readAt ?? "");
    const fresh = a.idle === true || (Number.isFinite(read) && now - read <= freshMs);
    const weekly = used(a.weekly, now);
    const session = used(a.session, now);
    return fresh && a.weekly?.unread !== true && weekly !== null && weekly < switchAt && (session ?? 0) < switchAt;
  });
  const best = [...room].sort(roomOrder({ nearestReset, now }))[0];
  if (best?.account) return { pick: best.account };
  /** @type {number[]} */
  const back = [];
  for (const a of taking) {
    const full = [a.weekly, a.session].filter((w) => (used(w, now) ?? 0) >= switchAt);
    if (!full.length) continue;
    const at = Math.max(...full.map((w) => resetMs(w, now)));
    if (Number.isFinite(at)) back.push(at);
  }
  return { wait: { until: back.length ? new Date(Math.min(...back)).toISOString() : null } };
}

/**
 * Taking-part accounts whose reading cannot be trusted: "no week" (the usage reply had no weekly window, so 0% is a
 * guess) or "no reading" (signed in and in use, but the last read failed or is older than `staleMs`). A signed-out
 * account is left out (it has its own red), as is a dir never signed in (only a sign-in fixes it), and an idle one,
 * whose last reading stands by design.
 * @param {readonly AccountReading[]} accounts
 * @param {{ takePart?: readonly string[], now?: number, staleMs?: number }} [opts]
 * @returns {{ account: AccountReading, problem: "no week" | "no reading" }[]}
 */
export function readingProblems(accounts, { takePart = [], now = Date.now(), staleMs = READING_STALE_MS } = {}) {
  /** @type {{ account: AccountReading, problem: "no week" | "no reading" }[]} */
  const problems = [];
  for (const a of accounts) {
    if (typeof a?.account !== "string" || !takesPart(a.account, takePart) || a.signedIn === false || a.error === NOT_SIGNED_IN || a.signedOut === true || a.idle === true) continue;
    if (a.weekly?.unread === true) {
      problems.push({ account: a, problem: "no week" });
      continue;
    }
    const read = Date.parse(a.readAt ?? "");
    if (a.error || !Number.isFinite(read) || now - read > staleMs) problems.push({ account: a, problem: "no reading" });
  }
  return problems;
}
