// Spend collector: reads Claude Code session transcripts on the Mac, read-only,
// and sums them into today's and this month's spend in the owner's time. Only numbers
// and chat/repo/model names leave this module, never message content.
//
// Measured spend comes from cost-state lines: {"type":"cost-state","sessionId",
// "totalCostUSD","startTime","totalDuration","modelUsage":{model:{costUSD,...}}},
// no timestamp. Their figures are cumulative for one process run of a session
// (sessionId + startTime), so each record adds its increase over that run's
// high-water mark, per model. Claude Code writes them only when a session saves
// (exit, resume, /clear), at startTime + totalDuration. A record covers the
// session's assistant messages (parent and subagents) from startTime to then:
// its increase is spread across them, weighted by each message's token cost, and
// each share lands on that message's own day.
//
// Assistant messages no record covers yet are reported as estimated spend, at
// their token cost at PRICES, keyed by message id so a re-read adds nothing.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { repoAllowlist } from "../../src/shared/repos.ts";
import { localZone } from "./schedules/words.mjs";

export const DEFAULT_PROJECTS_DIR = path.join(homedir(), ".claude", "projects");
export const DEFAULT_SPEND_STATE_FILE = path.join(homedir(), ".rivet-agents", "bridge", "spend-state.json");
export const SPEND_INTERVAL_MS = 5 * 60_000;
/** How long after a day or month ends its totals are still sent, so a late crossing is caught. */
export const PERIOD_GRACE_MS = 2 * 3600_000;
/** Kept well under the server's 1,000 chat rows, 50 models and 256 KiB. */
export const MAX_CHAT_ROWS = 150;
export const MAX_MODELS = 20;
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * USD per million tokens: [input, output, cache read, cache write], plus a one-hour
 * cache write rate where it is published; without one, every write is at the cache write rate.
 * Fitted by least squares to the cumulative tokens and costUSD in cost-state records:
 * - Opus 5.5: 12 claude-opus-5-5[1m] runs, zero residual; the plain runs agree.
 * - Opus 4.8: 6 runs, zero residual (the published Opus 4 rates).
 * - Opus 5: 10 runs with the 1 : 5 : 0.1 : 1.25 shape, within 2%.
 * - Sonnet 5: 124 runs with the same shape; the month's total within 5%.
 * - Sonnet 5.5: the same shape and rates as Sonnet 5; a run's costUSD matches exactly.
 * - Fable 5.1: 13 runs, four free rates, every run within 3%.
 * - Haiku 4.5: the published rates; under $1 of local data to fit. Kept for history.
 * - Haiku 5.5: the published rates for a prompt of 100k tokens or fewer,
 *   one-hour writes included; LONG_PROMPT_PRICES has the rates above that.
 * An unknown model is priced as Opus 5.5.
 */
export const PRICES = Object.freeze({
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-opus-4-8": [5, 25, 0.5, 6.25],
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-fable-5-1": [10.8, 47.6, 0.25, 20.3],
  "claude-haiku-4-5": [1, 5, 0.1, 1.25],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125, 0.2],
});
const DEFAULT_PRICE = PRICES["claude-opus-5-5"];

/**
 * The rates for a message whose prompt (input, cache read and cache write tokens)
 * is over LONG_PROMPT_TOKENS, for the models priced by prompt length.
 */
export const LONG_PROMPT_PRICES = Object.freeze({
  "claude-haiku-5-5": [0.5, 2.5, 0.05, 0.625, 1],
});
export const LONG_PROMPT_TOKENS = 100_000;

const CHUNK = 8 * 1024 * 1024;
const RUN_TTL_DAYS = 120;
const LABEL_TTL_DAYS = 62;
const MODEL_RE = /^[A-Za-z0-9._:@\[\]-]{1,100}$/;
const NAME_RE = /^(?!\.)[A-Za-z0-9._-]{1,100}$/;
const SESSION_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** @type {Map<string, Intl.DateTimeFormat>} */
const dayFormats = new Map();

/** Calendar day of an instant in the owner's zone as "YYYY-MM-DD". @param {Date | number} at */
export function zoneDay(at) {
  const zone = localZone();
  let format = dayFormats.get(zone);
  if (!format) dayFormats.set(zone, (format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })));
  const parts = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** @type {Map<number, string>} */
const dayCache = new Map();
let dayCacheZone = "";
/** zoneDay for epoch ms, cached per quarter hour (every zone's offset is a multiple of one). @param {number} ms */
function dayOfMs(ms) {
  const zone = localZone();
  if (zone !== dayCacheZone) {
    dayCache.clear();
    dayCacheZone = zone;
  }
  const k = Math.floor(ms / 900_000);
  let day = dayCache.get(k);
  if (!day) {
    if (dayCache.size > 100_000) dayCache.clear();
    day = zoneDay(k * 900_000);
    dayCache.set(k, day);
  }
  return day;
}

/**
 * An instant no later than the start of the month containing `at` in the owner's zone
 * (no zone is further ahead of UTC than 14 hours).
 * @param {Date} at
 */
export function monthStartLowerBound(at) {
  const [y, m] = zoneDay(at).split("-").map(Number);
  return Date.UTC(/** @type {number} */ (y), /** @type {number} */ (m) - 1, 1) - 14 * 3600_000;
}

/** Claude Code's project folder name: the launch cwd with every "/" and "." as "-". @param {string} p */
export function encodeProjectPath(p) {
  return p.replace(/[/.]/g, "-");
}

/**
 * @typedef {{ repo: string, chat: string, seen: string }} Label
 * @typedef {Record<string, Label>} Labels keyed by project folder name
 */

/**
 * The repo and chat a project folder's sessions ran in, as learnt from their
 * transcripts' `cwd`; anything else is "other". Never guessed from the folder name.
 * @param {string} dirName
 * @param {Labels} labels
 * @returns {{ repo: string, chat?: string }}
 */
export function projectLabel(dirName, labels) {
  const label = Object.hasOwn(labels, dirName) ? labels[dirName] : undefined;
  return label ? { repo: label.repo, ...(label.chat ? { chat: label.chat } : {}) } : { repo: "other" };
}

/**
 * Learns a project folder's label from a transcript line's `cwd`, only when the
 * cwd is the folder's own launch path and has a folder named for a repo in
 * RIVET_REPOS. The chat is exactly the one segment after that folder, if there is
 * one; nothing below it is kept. The path itself never leaves the Mac.
 * @param {SpendState} state
 * @param {string} project
 * @param {string} cwd
 * @param {string} today
 */
function learnCwd(state, project, cwd, today) {
  if (cwd.length > 4096) return false;
  if (project !== encodeProjectPath(cwd) && project !== cwd.replace(/[^A-Za-z0-9-]/g, "-")) return false;
  const names = repoAllowlist().map((repo) => repo.slice(repo.indexOf("/") + 1));
  const parts = cwd.split("/");
  const at = parts.findIndex((part) => names.includes(part));
  if (at < 0) return false;
  const chat = parts[at + 1];
  state.labels[project] = { repo: parts[at], ...(chat && NAME_RE.test(chat) ? { chat } : {}), seen: today };
  return true;
}

/** "claude-opus-5-5[1m]", "claude-haiku-4-5-20251001" and a dated "claude-haiku-5-5-…" to their price-table names. @param {string} model */
export function baseModel(model) {
  return model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
}

/**
 * The USD cost of one assistant message's usage.
 * @param {string} model
 * @param {any} usage
 */
export function usageCost(model, usage) {
  const n = (/** @type {unknown} */ v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const base = baseModel(model);
  const prompt = n(usage?.input_tokens) + n(usage?.cache_read_input_tokens) + n(usage?.cache_creation_input_tokens);
  const price =
    (prompt > LONG_PROMPT_TOKENS ? /** @type {Record<string, number[]>} */ (LONG_PROMPT_PRICES)[base] : undefined) ??
    /** @type {Record<string, number[]>} */ (PRICES)[base] ??
    DEFAULT_PRICE;
  const writes = n(usage?.cache_creation_input_tokens);
  const hourWrites = price[4] === undefined ? 0 : Math.min(writes, n(usage?.cache_creation?.ephemeral_1h_input_tokens));
  return (
    (n(usage?.input_tokens) * price[0] +
      n(usage?.output_tokens) * price[1] +
      n(usage?.cache_read_input_tokens) * price[2] +
      (writes - hourWrites) * price[3] +
      hourWrites * (price[4] ?? 0)) /
    1e6
  );
}

/**
 * @typedef {{ ino: number, offset: number, line: number, lastTs: string | null, lastTsLine: number, skipped?: number }} FileState
 * @typedef {{ models: Record<string, number>, seen: string }} RunState
 * @typedef {[at: number, model: string, usd: number]} PendingMessage
 * @typedef {{ msgs: Record<string, PendingMessage>, covered: [number, number][] }} SessionState
 *   msgs: assistant messages no cost-state covers yet, by message id
 *   covered: [from, to) epoch-ms windows that saved cost-states already cover
 * @typedef {{ version: 5, files: Record<string, FileState>, runs: Record<string, RunState>,
 *   sessions: Record<string, SessionState>, labels: Labels,
 *   buckets: Record<string, Record<string, Record<string, number>>> }} SpendState
 *   buckets: measured spend by day, project folder and base model
 */

/** @returns {SpendState} */
export function emptyState() {
  return { version: 5, files: {}, runs: {}, sessions: {}, labels: {}, buckets: {} };
}

/** @param {string} file @returns {SpendState} */
export function loadSpendState(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    if (doc?.version === 5 && doc.files && doc.runs && doc.sessions && doc.labels && doc.buckets) return doc;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return emptyState();
  }
  // A corrupt or older file starts clean: everything rebuilds from the transcripts.
  return emptyState();
}

/** @param {string} file @param {SpendState} state */
export function saveSpendState(file, state) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(state)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** @param {unknown} v */
function isTimestamp(v) {
  return typeof v === "string" && v.length <= 64 && Number.isFinite(Date.parse(v));
}

/** @param {any} record */
function isRun(record) {
  return SESSION_RE.test(String(record.sessionId ?? "")) && Number.isFinite(record.startTime);
}

/**
 * Applies one cost-state record to the run high-water marks.
 * @param {SpendState} state
 * @param {any} record
 * @param {string} seenDay
 * @returns {Record<string, number>} the increase per base model
 */
export function applyCostState(state, record, seenDay) {
  /** @type {Record<string, number>} */
  const delta = {};
  if (!isRun(record)) return delta;
  const key = `${record.sessionId}|${record.startTime}`;
  const run = (state.runs[key] ??= { models: {}, seen: seenDay });
  run.seen = seenDay;
  /** @type {Record<string, number>} */
  const models = {};
  const usage = record.modelUsage && typeof record.modelUsage === "object" ? record.modelUsage : {};
  for (const [model, u] of Object.entries(usage)) {
    const cost = /** @type {any} */ (u)?.costUSD;
    if (MODEL_RE.test(model) && Number.isFinite(cost) && cost >= 0) models[model] = cost;
  }
  if (Object.keys(models).length === 0 && Number.isFinite(record.totalCostUSD) && record.totalCostUSD >= 0) {
    models.unknown = record.totalCostUSD;
  }
  for (const [model, cost] of Object.entries(models)) {
    const before = run.models[model] ?? 0;
    if (cost > before) {
      const base = baseModel(model);
      delta[base] = (delta[base] ?? 0) + cost - before;
      run.models[model] = cost;
    }
  }
  return delta;
}

/**
 * @param {SpendState} state
 * @param {string} project
 * @param {string} day
 * @param {string} model
 * @param {number} usd
 */
function addMeasured(state, project, day, model, usd) {
  const byModel = ((state.buckets[day] ??= {})[project] ??= {});
  byModel[model] = (byModel[model] ?? 0) + usd;
}

/** @param {SpendState} state @param {string} sessionKey @returns {SessionState} */
function sessionOf(state, sessionKey) {
  return (state.sessions[sessionKey] ??= { msgs: {}, covered: [] });
}

/** @param {SessionState} session @param {number} at */
function isCovered(session, at) {
  return session.covered.some(([from, to]) => at >= from && at < to);
}

/** @param {[number, number][]} windows */
function mergeWindows(windows) {
  const sorted = [...windows].sort((a, b) => a[0] - b[0]);
  /** @type {[number, number][]} */
  const out = [];
  for (const [from, to] of sorted) {
    const last = out.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/**
 * Settles one cost-state: the session's pending messages in [from, to) are
 * covered by it. Its measured increase is spread across them by cost (each
 * model's across that model's messages, else across all of them) onto each
 * message's day, and they leave the estimate. A zero increase still
 * covers them, so a re-read transcript never counts its messages twice.
 * Returns the increase it had no messages to spread over.
 * @param {SpendState} state
 * @param {string} sessionKey
 * @param {string} project
 * @param {Record<string, number>} delta
 * @param {number} from
 * @param {number} to
 * @returns {Record<string, number>}
 */
function settle(state, sessionKey, project, delta, from, to) {
  const session = sessionOf(state, sessionKey);
  /** @type {PendingMessage[]} */
  const covered = [];
  for (const [id, msg] of Object.entries(session.msgs)) {
    if (msg[0] >= from && msg[0] < to) {
      covered.push(msg);
      delete session.msgs[id];
    }
  }
  session.covered = mergeWindows([...session.covered, [from, to]]);
  /** @type {Record<string, number>} */
  const unplaced = {};
  for (const [model, usd] of Object.entries(delta)) {
    let weights = covered.filter((msg) => msg[1] === model && msg[2] > 0);
    if (weights.length === 0) weights = covered.filter((msg) => msg[2] > 0);
    const total = weights.reduce((sum, msg) => sum + msg[2], 0);
    if (total <= 0) {
      unplaced[model] = usd;
      continue;
    }
    /** @type {Record<string, number>} */
    const byDay = {};
    for (const msg of weights) {
      const day = dayOfMs(msg[0]);
      byDay[day] = (byDay[day] ?? 0) + (usd * msg[2]) / total;
    }
    for (const [day, share] of Object.entries(byDay)) addMeasured(state, project, day, model, share);
  }
  return unplaced;
}

/**
 * @typedef {{ maxLineBytes?: number, chunkBytes?: number }} ReadLimits
 */

/**
 * Reads one transcript from its saved offset to its last complete line. A line
 * longer than maxLineBytes is skipped unread, and the offset moves past it.
 * @param {SpendState} state
 * @param {string} file absolute path
 * @param {string} key the file's key in state.files
 * @param {string} project the project folder name
 * @param {string} sessionKey `<project>/<sessionId>`; a subagent transcript shares its parent's
 * @param {fs.Stats} st
 * @param {string} today the day, for run bookkeeping
 * @param {ReadLimits} [limits]
 */
export async function scanFile(state, file, key, project, sessionKey, st, today, limits = {}) {
  const maxLine = limits.maxLineBytes ?? MAX_LINE_BYTES;
  const chunkBytes = limits.chunkBytes ?? CHUNK;
  let fstate = state.files[key];
  if (!fstate || fstate.ino !== st.ino || st.size < fstate.offset) {
    // New, replaced or truncated: read from the start. Run high-water marks, message
    // ids and covered windows keep anything already counted from counting again.
    fstate = { ino: st.ino, offset: 0, line: 0, lastTs: null, lastTsLine: -1 };
  }
  if (st.size === fstate.offset) {
    state.files[key] = fstate;
    return 0;
  }
  // A cost-state without totalDuration covers up to the next timestamped line, or
  // the file's mtime; what it cannot spread lands at its nearest timestamped line.
  /** @type {{ line: number, prevTs: string | null, prevLine: number, delta: Record<string, number>, from: number }[]} */
  let deferred = [];
  const settleDeferred = (/** @type {string | null} */ nextTs, /** @type {number} */ nextLine) => {
    for (const p of deferred) {
      const to = nextTs ? Date.parse(nextTs) : st.mtimeMs + 1;
      const rest = settle(state, sessionKey, project, p.delta, p.from, to);
      let ts = p.prevTs;
      if (nextTs && (!ts || nextLine - p.line < p.line - p.prevLine)) ts = nextTs;
      const day = zoneDay(new Date(ts ?? st.mtime.toISOString()));
      for (const [model, usd] of Object.entries(rest)) addMeasured(state, project, day, model, usd);
    }
    deferred = [];
  };

  let records = 0;
  let labelled = Object.hasOwn(state.labels, project);
  /** @param {string} text @param {number} lineNo */
  const handle = (text, lineNo) => {
    if (text.trim() === "") return;
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      return;
    }
    if (!obj || typeof obj !== "object") return;
    if (obj.type === "cost-state") {
      records += 1;
      const delta = applyCostState(state, obj, today);
      if (!isRun(obj)) return;
      if (Number.isFinite(obj.totalDuration) && obj.totalDuration >= 0) {
        // A record covers up to its own write time only: a stale or repeated one
        // further down the file must not take newer unsaved messages with it.
        const to = obj.startTime + obj.totalDuration + 1;
        const rest = settle(state, sessionKey, project, delta, obj.startTime, to);
        const day = zoneDay(new Date(to - 1));
        for (const [model, usd] of Object.entries(rest)) addMeasured(state, project, day, model, usd);
      } else {
        deferred.push({ line: lineNo, prevTs: fstate.lastTs, prevLine: fstate.lastTsLine, delta, from: obj.startTime });
      }
      return;
    }
    if (!labelled && typeof obj.cwd === "string") labelled = learnCwd(state, project, obj.cwd, today);
    if (!isTimestamp(obj.timestamp)) return;
    settleDeferred(obj.timestamp, lineNo);
    fstate.lastTs = obj.timestamp;
    fstate.lastTsLine = lineNo;
    const message = obj.type === "assistant" ? obj.message : null;
    if (!message || typeof message.model !== "string" || !MODEL_RE.test(message.model) || typeof message.id !== "string") return;
    const at = Date.parse(obj.timestamp);
    const session = sessionOf(state, sessionKey);
    if (isCovered(session, at)) return;
    const model = baseModel(message.model);
    const cost = usageCost(model, message.usage);
    // Streaming writes one line per content block with the same id: count it once, at its largest usage.
    const id = message.id.slice(0, 200);
    const prev = session.msgs[id];
    if (!prev) session.msgs[id] = [at, model, cost];
    else if (cost > prev[2]) prev[2] = cost;
  };

  const fh = await fs.promises.open(file, "r");
  try {
    let pos = fstate.offset;
    /** @type {Buffer[]} */
    let parts = [];
    let partLen = 0;
    let oversized = false;
    while (pos < st.size) {
      const want = Math.min(chunkBytes, st.size - pos);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      const data = buf.subarray(0, bytesRead);
      let start = 0;
      for (;;) {
        const nl = data.indexOf(0x0a, start);
        if (nl === -1) break;
        const len = partLen + nl - start;
        const lineNo = fstate.line;
        fstate.line += 1;
        fstate.offset += len + 1;
        if (oversized || len > maxLine) {
          fstate.skipped = (fstate.skipped ?? 0) + 1;
        } else {
          const text = partLen ? Buffer.concat([...parts, data.subarray(start, nl)]).toString("utf8") : data.toString("utf8", start, nl);
          handle(text, lineNo);
        }
        parts = [];
        partLen = 0;
        oversized = false;
        start = nl + 1;
      }
      // A line still being written stays unread until its newline lands; an
      // oversized one is not kept in memory, only measured.
      if (start < data.length) {
        partLen += data.length - start;
        if (partLen > maxLine) {
          oversized = true;
          parts = [];
        } else if (!oversized) {
          parts.push(data.subarray(start));
        }
      }
    }
  } finally {
    await fh.close();
  }
  settleDeferred(null, -1);
  state.files[key] = fstate;
  return records;
}

/**
 * @param {string} file
 * @returns {Promise<fs.Stats | null>}
 */
async function statFile(file) {
  try {
    return await fs.promises.stat(file);
  } catch {
    return null;
  }
}

/**
 * Scans every session transcript touched this month: each session's
 * subagent transcripts (`<project>/<session>/subagents/*.jsonl`) first, so
 * their messages are pending when the parent's cost-state arrives, then
 * `<project>/<session>.jsonl`.
 * @param {SpendState} state
 * @param {{ projectsDir?: string, now?: Date } & ReadLimits} [opts]
 */
export async function collect(state, { projectsDir = DEFAULT_PROJECTS_DIR, now = new Date(), ...limits } = {}) {
  // During the grace window the ended month's totals are still sent, so its transcripts are still read.
  const since = monthStartLowerBound(new Date(now.getTime() - PERIOD_GRACE_MS));
  const today = zoneDay(now);
  let files = 0;
  let records = 0;
  /** @type {Set<string>} */
  const present = new Set();
  let projects;
  try {
    projects = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") projects = [];
    else throw err;
  }
  /** @param {string} file @param {string} key @param {string} project @param {string} sessionKey */
  const visit = async (file, key, project, sessionKey) => {
    const st = await statFile(file);
    if (!st?.isFile()) return;
    present.add(key);
    if (st.mtimeMs < since && !state.files[key]) return;
    files += 1;
    records += await scanFile(state, file, key, project, sessionKey, st, today, limits);
  };
  for (const dirent of projects) {
    if (!dirent.isDirectory()) continue;
    const dir = path.join(projectsDir, dirent.name);
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    /** @type {Set<string>} */
    const sessions = new Set();
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) sessions.add(entry.name.slice(0, -".jsonl".length));
      else if (entry.isDirectory() && SESSION_RE.test(entry.name)) sessions.add(entry.name);
    }
    for (const session of [...sessions].sort()) {
      if (!SESSION_RE.test(session)) continue;
      const sessionKey = `${dirent.name}/${session}`;
      let subagents = [];
      try {
        subagents = (await fs.promises.readdir(path.join(dir, session, "subagents"))).filter((n) => n.endsWith(".jsonl")).sort();
      } catch {}
      for (const name of subagents) {
        await visit(path.join(dir, session, "subagents", name), `${sessionKey}/subagents/${name}`, dirent.name, sessionKey);
      }
      await visit(path.join(dir, `${session}.jsonl`), `${sessionKey}.jsonl`, dirent.name, sessionKey);
    }
  }
  prune(state, now, present);
  let skipped = 0;
  for (const f of Object.values(state.files)) skipped += f.skipped ?? 0;
  return { files, records, skipped };
}

/**
 * Drops measured days, pending messages and covered windows before last month,
 * runs not seen for RUN_TTL_DAYS, labels not seen for LABEL_TTL_DAYS unless
 * their project still has spend kept, and offsets of files that are gone.
 * @param {SpendState} state
 * @param {Date} now
 * @param {Set<string>} present
 */
function prune(state, now, present) {
  const [y, m] = zoneDay(now).split("-").map(Number);
  const prev = m === 1 ? `${/** @type {number} */ (y) - 1}-12` : `${y}-${String(/** @type {number} */ (m) - 1).padStart(2, "0")}`;
  const prevStart = monthStartLowerBound(new Date(`${prev}-15T00:00:00Z`));
  for (const day of Object.keys(state.buckets)) if (day.slice(0, 7) < prev) delete state.buckets[day];
  for (const [key, session] of Object.entries(state.sessions)) {
    for (const [id, msg] of Object.entries(session.msgs)) if (dayOfMs(msg[0]).slice(0, 7) < prev) delete session.msgs[id];
    session.covered = session.covered.filter(([, to]) => to >= prevStart);
    if (Object.keys(session.msgs).length === 0 && session.covered.length === 0) delete state.sessions[key];
  }
  const runCutoff = zoneDay(new Date(now.getTime() - RUN_TTL_DAYS * 86400_000));
  for (const [key, run] of Object.entries(state.runs)) if (run.seen < runCutoff) delete state.runs[key];
  const labelCutoff = zoneDay(new Date(now.getTime() - LABEL_TTL_DAYS * 86400_000));
  const spending = new Set(Object.values(state.buckets).flatMap((projects) => Object.keys(projects)));
  for (const key of Object.keys(state.sessions)) spending.add(key.slice(0, key.lastIndexOf("/")));
  for (const [key, label] of Object.entries(state.labels)) if (label.seen < labelCutoff && !spending.has(key)) delete state.labels[key];
  for (const key of Object.keys(state.files)) if (!present.has(key)) delete state.files[key];
}

/** @param {number} n */
const round = (n) => Math.round(n * 1e4) / 1e4;

/**
 * @param {SpendState} state
 * @param {(day: string) => boolean} includeDay
 */
function bucket(state, includeDay) {
  let measured = 0;
  let estimated = 0;
  /** @type {Record<string, number>} */
  const byModel = {};
  /** @type {Map<string, { repo: string, chat?: string, usd: number, estimatedUSD: number }>} */
  const byChat = new Map();
  /** @type {Map<string, { repo: string, chat?: string, usd: number, estimatedUSD: number }>} */
  const rowByProject = new Map();
  /** @param {string} project */
  const rowOf = (project) => {
    let row = rowByProject.get(project);
    if (row) return row;
    const label = projectLabel(project, state.labels);
    const k = `${label.repo}/${label.chat ?? ""}`;
    row = byChat.get(k);
    if (!row) byChat.set(k, (row = { ...label, usd: 0, estimatedUSD: 0 }));
    rowByProject.set(project, row);
    return row;
  };
  for (const [day, projects] of Object.entries(state.buckets)) {
    if (!includeDay(day)) continue;
    for (const [project, models] of Object.entries(projects)) {
      const row = rowOf(project);
      for (const [model, usd] of Object.entries(models)) {
        measured += usd;
        byModel[model] = (byModel[model] ?? 0) + usd;
        row.usd += usd;
      }
    }
  }
  for (const [sessionKey, session] of Object.entries(state.sessions)) {
    const project = sessionKey.slice(0, sessionKey.lastIndexOf("/"));
    for (const [at, model, usd] of Object.values(session.msgs)) {
      if (!includeDay(dayOfMs(at))) continue;
      const row = rowOf(project);
      estimated += usd;
      byModel[model] = (byModel[model] ?? 0) + usd;
      row.usd += usd;
      row.estimatedUSD += usd;
    }
  }
  return {
    totalUSD: round(measured + estimated),
    measuredUSD: round(measured),
    estimatedUSD: round(estimated),
    byModel: Object.fromEntries(topModels(byModel).map(([k, v]) => [k, round(v)])),
    byChat: topChats([...byChat.values()]).map((row) => ({ ...row, usd: round(row.usd), estimatedUSD: round(row.estimatedUSD) })),
  };
}

/** The MAX_MODELS - 1 biggest models, the rest summed as "other". @param {Record<string, number>} byModel */
function topModels(byModel) {
  const sorted = Object.entries(byModel).sort((a, b) => b[1] - a[1]);
  if (sorted.length <= MAX_MODELS) return sorted;
  const keep = sorted.slice(0, MAX_MODELS - 1).filter(([model]) => model !== "other");
  const rest = sorted.filter((entry) => !keep.includes(entry)).reduce((sum, [, usd]) => sum + usd, 0);
  return [...keep, /** @type {[string, number]} */ (["other", rest])];
}

/**
 * At most MAX_CHAT_ROWS rows. Past that, the biggest are kept and the rest are
 * summed into one chat-less row per repo.
 * @param {{ repo: string, chat?: string, usd: number, estimatedUSD: number }[]} rows
 */
function topChats(rows) {
  const sorted = rows.sort((a, b) => b.usd - a.usd);
  if (sorted.length <= MAX_CHAT_ROWS) return sorted;
  const budget = Math.max(0, MAX_CHAT_ROWS - new Set(sorted.map((row) => row.repo)).size);
  const keep = new Set(sorted.filter((row) => row.chat !== undefined).slice(0, budget));
  /** @type {Map<string, { repo: string, usd: number, estimatedUSD: number }>} */
  const folded = new Map();
  for (const row of sorted) {
    if (keep.has(row)) continue;
    let sum = folded.get(row.repo);
    if (!sum) folded.set(row.repo, (sum = { repo: row.repo, usd: 0, estimatedUSD: 0 }));
    sum.usd += row.usd;
    sum.estimatedUSD += row.estimatedUSD;
  }
  return [...keep, ...folded.values()].sort((a, b) => b.usd - a.usd);
}

/**
 * The payload for PUT /api/bridge/spend: numbers and names only. For
 * PERIOD_GRACE_MS after a day or month ends it also carries that period's
 * final totals, so spend just before midnight is still seen.
 * @param {SpendState} state
 * @param {{ now?: Date }} [opts]
 */
export function aggregate(state, { now = new Date() } = {}) {
  const day = zoneDay(now);
  const month = day.slice(0, 7);
  const prevDay = zoneDay(new Date(now.getTime() - PERIOD_GRACE_MS));
  const prevMonth = prevDay.slice(0, 7);
  return {
    generatedAt: now.toISOString(),
    timeZone: localZone(),
    day,
    month,
    today: bucket(state, (d) => d === day),
    thisMonth: bucket(state, (d) => d.startsWith(`${month}-`)),
    ...(prevDay !== day ? { previousDay: { day: prevDay, spend: bucket(state, (d) => d === prevDay) } } : {}),
    ...(prevMonth !== month ? { previousMonth: { month: prevMonth, spend: bucket(state, (d) => d.startsWith(`${prevMonth}-`)) } } : {}),
  };
}

/**
 * Collects, saves the offsets, and sends the aggregate.
 * @param {{ origin: string, token: string, fetch: typeof fetch, stateFile?: string, projectsDir?: string,
 *   now?: () => Date, log: (event: string, fields?: Record<string, unknown>) => void }} deps
 */
export async function pushSpend(deps) {
  const stateFile = deps.stateFile ?? DEFAULT_SPEND_STATE_FILE;
  const now = deps.now ?? (() => new Date());
  const state = loadSpendState(stateFile);
  const started = Date.now();
  const { files, records, skipped } = await collect(state, { projectsDir: deps.projectsDir, now: now() });
  saveSpendState(stateFile, state);
  const body = aggregate(state, { now: now() });
  const res = await deps.fetch(`${deps.origin}/api/bridge/spend`, {
    method: "PUT",
    headers: { authorization: `Bearer ${deps.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`spend http ${res.status}`);
  }
  await res.body?.cancel().catch(() => {});
  deps.log("spend-pushed", {
    files,
    records,
    skippedLines: skipped,
    today: body.today.totalUSD,
    todayEstimated: body.today.estimatedUSD,
    month: body.thisMonth.totalUSD,
    ms: Date.now() - started,
  });
  return body;
}

/**
 * Pushes spend now and then every SPEND_INTERVAL_MS until `stop` aborts. A failed
 * run is logged and retried on the next tick.
 * @param {Parameters<typeof pushSpend>[0] & { stop: AbortSignal, intervalMs?: number }} deps
 */
export async function runSpendLoop(deps) {
  const intervalMs = deps.intervalMs ?? SPEND_INTERVAL_MS;
  while (!deps.stop.aborted) {
    try {
      await pushSpend(deps);
    } catch (err) {
      deps.log("spend-failed", { error: err instanceof Error ? err.message.slice(0, 200) : "error" });
    }
    await new Promise((resolve) => {
      // A stop that lands during the push has already fired: its listener would never run.
      if (deps.stop.aborted) return resolve(undefined);
      const t = setTimeout(done, intervalMs);
      function done() {
        clearTimeout(t);
        deps.stop.removeEventListener("abort", done);
        resolve(undefined);
      }
      deps.stop.addEventListener("abort", done, { once: true });
    });
  }
}
