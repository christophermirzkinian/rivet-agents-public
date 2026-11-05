import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { SECURITY_BIN } from "../config.mjs";
import { shapeText } from "../redact-cut.mjs";
import { clip, iso } from "./common.mjs";

// Claude plan usage for the Ops tab and the agents: the share of the 5-hour session
// window and the weekly windows used, and when each resets. The figures are the
// account's own, from the usage endpoint Claude Code's /usage reads, signed with the
// sign-in Claude Code keeps in the Keychain. The sign-in is only read: never
// refreshed, logged or sent anywhere else. An expired one waits for Claude Code to
// refresh it. Each good reading is also written to USAGE_FILE for scripts.

export const CLAUDE_INTERVAL_MS = 2 * 60_000;
export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CREDENTIALS_SERVICE = "Claude Code-credentials";
export const USAGE_FILE = path.join(homedir(), ".rivet-agents", "claude-usage.json");
export const MAX_LIMITS = 12;
const HTTP_TIMEOUT_MS = 15_000;
const KIND_RE = /^[a-z0-9_]{1,40}$/;
const SEVERITIES = new Set(["normal", "warning", "critical"]);

/**
 * The access token from Claude Code's Keychain item; throws a short error that never holds it.
 * @param {import("../config.mjs").Exec} exec
 * @param {() => Date} now
 */
export async function readClaudeToken(exec, now) {
  let raw;
  try {
    raw = (await exec(SECURITY_BIN, ["find-generic-password", "-s", CREDENTIALS_SERVICE, "-w"], { timeout: 10_000, maxBuffer: 64 * 1024 })).stdout;
  } catch {
    throw new Error("no Claude Code sign-in in the Keychain");
  }
  let oauth;
  try {
    oauth = JSON.parse(raw)?.claudeAiOauth;
  } catch {
    throw new Error("Claude Code sign-in is not JSON");
  }
  const token = oauth?.accessToken;
  if (typeof token !== "string" || !/^[\x21-\x7e]{20,4096}$/.test(token)) throw new Error("Claude Code sign-in has no access token");
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now().getTime()) throw new Error("Claude Code sign-in expired; waiting for Claude Code to refresh it");
  return token;
}

/** @param {unknown} value */
function percent(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value * 10) / 10)) : null;
}

/** @param {string} kind @param {any} scope */
function labelOf(kind, scope) {
  // Text the usage API writes: redacted whole before clip cuts it.
  const model = typeof scope?.model?.display_name === "string" ? clip(shapeText(scope.model.display_name, 40), 40) : "";
  const surface = typeof scope?.surface?.display_name === "string" ? clip(shapeText(scope.surface.display_name, 40), 40) : "";
  if (kind === "session") return "Session (5 hr)";
  if (kind === "weekly_all") return "Week (all models)";
  if (model || surface) return `Week (${model || surface})`;
  return clip(kind.replace(/_/g, " "), 60);
}

/**
 * The server's usage rows, as it grades them: which meters apply, their severity and
 * order are its call; the Ops tab and the agents never grade a row themselves.
 * @param {any} body
 */
export function parseUsage(body) {
  /** @type {{ kind: string, label: string, percent: number, severity: string, resetsAt: string | null, active: boolean }[]} */
  const limits = [];
  if (Array.isArray(body?.limits)) {
    for (const row of body.limits) {
      const pct = percent(row?.percent);
      // A kind redaction would change is not sent: the server keys on it.
      if (typeof row?.kind !== "string" || !KIND_RE.test(row.kind) || shapeText(row.kind, Infinity) !== row.kind || pct === null) continue;
      limits.push({
        kind: row.kind,
        label: labelOf(row.kind, row.scope),
        percent: pct,
        severity: SEVERITIES.has(row.severity) ? row.severity : "normal",
        resetsAt: iso(row.resets_at),
        active: row.is_active === true,
      });
    }
  }
  if (!limits.length) throw new Error("usage reply had no limits");
  return limits.slice(0, MAX_LIMITS);
}

/**
 * @param {{ exec: import("../config.mjs").Exec, fetch: typeof fetch, now?: () => Date }} deps
 */
export async function collectClaude(deps) {
  const now = deps.now ?? (() => new Date());
  const token = await readClaudeToken(deps.exec, now);
  const res = await deps.fetch(USAGE_URL, {
    headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`usage http ${res.status}`);
  }
  const limits = parseUsage(await res.json().catch(() => null));
  return { at: now().toISOString(), limits };
}

/** A stale row's age. Never just "old", which the app reads as no reading. @param {number} ms */
function ageNote(ms) {
  const minutes = Math.round(ms / 60_000);
  return minutes < 120 ? `${minutes} min old` : `${Math.round(minutes / 60)} hr old`;
}

/**
 * The last good reading when this pass got none and that reading was a limited week: it stays at 100% until its reset,
 * so the failed read does not blank the meter. Only the week, as the session has moved on, under the reading's own time,
 * so the page says how old it is; its label says "limited" and its age. Null with no such reading.
 * @param {{ file?: string | null, now?: () => Date }} [opts]
 * @returns {{ at: string, limits: ReturnType<typeof parseUsage> } | null}
 */
export function limitedUsage(opts = {}) {
  const file = opts.file === undefined ? USAGE_FILE : opts.file;
  if (file === null) return null;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const week = Array.isArray(doc?.limits) ? doc.limits.find((/** @type {any} */ row) => row?.kind === "weekly_all") : null;
  const pct = percent(week?.percent);
  const now = (opts.now ?? (() => new Date()))().getTime();
  if (pct === null || pct < 100 || !(Date.parse(week.resetsAt) > now) || !Number.isFinite(Date.parse(doc.at))) return null;
  return { at: doc.at, limits: [{ kind: "weekly_all", label: `${labelOf("weekly_all", null)}, limited, ${ageNote(Math.max(0, now - Date.parse(doc.at)))}`, percent: pct, severity: "critical", resetsAt: iso(week.resetsAt), active: false }] };
}

/**
 * The file the agents read: the snapshot plus `session` and `weekly` shortcuts
 * (percent used, reset time), written atomically.
 * @param {{ at: string, limits: ReturnType<typeof parseUsage> }} snapshot
 * @param {string} [file]
 */
export function writeUsageFile(snapshot, file = USAGE_FILE) {
  const pick = (/** @type {string} */ kind) => {
    const row = snapshot.limits.find((limit) => limit.kind === kind);
    return row ? { percent: row.percent, resetsAt: row.resetsAt } : null;
  };
  const doc = { at: snapshot.at, session: pick("session"), weekly: pick("weekly_all"), limits: snapshot.limits };
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o644, flag: "wx" });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return doc;
}
