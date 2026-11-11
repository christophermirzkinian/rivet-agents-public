import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import table from "../../config/model-jobs.json" with { type: "json" };

// Settings › Who does what on the Mac: the owner's picks, checked again against config/model-jobs.json (the server's
// allowlist too), written to ~/.rivet/model-routing.json in one step, and the file and the readers' fallbacks
// (~/.rivet/model-routing-status.json) reported to the server so Settings shows what the Mac holds.

const RIVET_DIR = path.join(os.homedir(), ".rivet");
export const MODEL_ROUTING_FILE = process.env.RIVET_MODEL_ROUTING_FILE || path.join(RIVET_DIR, "model-routing.json");
export const MODEL_STATUS_FILE = process.env.RIVET_MODEL_STATUS_FILE || path.join(RIVET_DIR, "model-routing-status.json");
export const UPDATED_BY = "The owner (Rivet)";
export const REPORT_POLL_MS = 60_000;
export const REPORT_EVERY_MS = 5 * 60_000;
const HTTP_TIMEOUT_MS = 15_000;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]{0,59}$/;

/** @typedef {{ model: string, effort: string }} Pick */
/** @typedef {Record<string, Pick>} Picks */

/** @param {unknown} v */
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Every job exactly once, each on a model and effort its allowlist takes; null for anything else.
 * @param {unknown} raw
 * @returns {Picks | null}
 */
export function validPicks(raw) {
  if (!isRecord(raw)) return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  if (Object.keys(r).length !== table.jobs.length) return null;
  /** @type {Picks} */
  const picks = {};
  for (const job of table.jobs) {
    const pick = r[job.key];
    if (!isRecord(pick) || Object.keys(pick).length !== 2) return null;
    const { model, effort } = /** @type {Record<string, unknown>} */ (pick);
    if (typeof model !== "string" || typeof effort !== "string" || !job.models.includes(model)) return null;
    const narrowed = /** @type {Record<string, string[] | undefined> | undefined} */ (/** @type {{ efforts?: unknown }} */ (job).efforts);
    const allowed = narrowed?.[model] ?? /** @type {Record<string, { efforts: string[] }>} */ (table.models)[model]?.efforts ?? [];
    if (!allowed.includes(effort)) return null;
    picks[job.key] = { model, effort };
  }
  return picks;
}

/** Platforms that cannot open or flush a folder say so with these; any other failure is one. */
const DIR_SYNC_REFUSED = new Set(["EISDIR", "EINVAL", "ENOTSUP"]);

/**
 * Flushes the folder, so the rename itself survives a power cut.
 * @param {string} dir
 */
async function syncDir(dir) {
  /** @type {import("node:fs/promises").FileHandle | undefined} */
  let handle;
  try {
    handle = await fsp.open(dir, "r");
    await handle.sync();
  } catch (err) {
    if (!DIR_SYNC_REFUSED.has(/** @type {NodeJS.ErrnoException} */ (err).code ?? "")) throw err;
  } finally {
    await handle?.close();
  }
}

/**
 * Writes the picks file in one step (a temp file beside it, flushed, renamed over it, the folder flushed), 0600, and reads it back.
 * @param {Picks} picks
 * @param {{ file?: string, action: string, now?: () => Date }} opts
 * @returns {Promise<{ status: "succeeded" | "failed", reason: string }>}
 */
export async function writePicks(picks, { file = MODEL_ROUTING_FILE, action, now = () => new Date() }) {
  const doc = { jobs: picks, updated: { at: now().toISOString(), by: UPDATED_BY, action } };
  const dir = path.dirname(file);
  const temp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const handle = await fsp.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(doc, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temp, file);
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    return { status: "failed", reason: `could not write ${path.basename(file)}: ${err instanceof Error ? err.message.slice(0, 160) : "error"}` };
  }
  try {
    await syncDir(dir);
  } catch (err) {
    return { status: "failed", reason: `wrote ${path.basename(file)} but could not flush its folder: ${err instanceof Error ? err.message.slice(0, 160) : "error"}` };
  }
  let back;
  try {
    back = JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (err) {
    return { status: "failed", reason: `wrote ${path.basename(file)} but could not read it back: ${err instanceof Error ? err.message.slice(0, 160) : "error"}` };
  }
  if (!isDeepStrictEqual(back, doc)) return { status: "failed", reason: `${path.basename(file)} read back different from what was written` };
  return { status: "succeeded", reason: savedReason(file) };
}

/** A save's succeeded ack reason. @param {string} [file] */
export const savedReason = (file = MODEL_ROUTING_FILE) => `Saved to ${path.basename(file)} and read back.`;

/** @param {string} file */
async function readJsonFile(file) {
  try {
    return { value: JSON.parse(await fsp.readFile(file, "utf8")) };
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return { missing: true };
    return { error: err instanceof Error ? err.message.slice(0, 200) : "error" };
  }
}

/**
 * The save the picks file holds now, as a save's `base` names it: its `updated.action`, else null (a missing file too);
 * undefined when the file is there but can't be read or parsed.
 * @param {string} [file]
 * @returns {Promise<string | null | undefined>}
 */
export async function currentBase(file = MODEL_ROUTING_FILE) {
  const read = await readJsonFile(file);
  if ("missing" in read) return null;
  if ("error" in read) return undefined;
  // The same rule as the report's, so the base the screen sends from it is the one the Mac computes.
  return validUpdated(isRecord(read.value) ? /** @type {Record<string, unknown>} */ (read.value).updated : undefined)?.action ?? null;
}

/** @param {unknown} v */
function validUpdated(v) {
  if (!isRecord(v)) return null;
  const u = /** @type {Record<string, unknown>} */ (v);
  if (typeof u.at !== "string" || Number.isNaN(Date.parse(u.at)) || typeof u.by !== "string" || u.by.length > 100) return null;
  if (u.action !== undefined && (typeof u.action !== "string" || u.action.length > 100)) return null;
  return { at: new Date(u.at).toISOString(), by: u.by, ...(typeof u.action === "string" ? { action: u.action } : {}) };
}

const STATUS_KEYS = new Set(["picked", "model", "effort", "reason", "at"]);

/**
 * One job's row of the status file scripts/model-routing.mjs writeModelStatus keeps: `{ picked: {model, effort} | null,
 * model, effort, reason, at }`. Only a move off the pick is a fallback Settings shows; a row the launcher wrote with the
 * pick itself ("resolved at chat start") is not one.
 * @param {unknown} v
 */
function validStatus(v) {
  if (!isRecord(v)) return null;
  const s = /** @type {Record<string, unknown>} */ (v);
  if (!Object.keys(s).every((key) => STATUS_KEYS.has(key))) return null;
  if (typeof s.model !== "string" || !MODEL_ID_RE.test(s.model)) return null;
  if (typeof s.effort !== "string" || !EFFORTS.has(s.effort)) return null;
  if (s.reason !== undefined && s.reason !== null && (typeof s.reason !== "string" || s.reason.length > 200)) return null;
  if (typeof s.at !== "string" || Number.isNaN(Date.parse(s.at))) return null;
  if (isRecord(s.picked)) {
    const picked = /** @type {Record<string, unknown>} */ (s.picked);
    if (picked.model === s.model && picked.effort === s.effort) return null;
  } else if (s.picked !== undefined && s.picked !== null) return null;
  return { model: s.model, effort: s.effort, reason: typeof s.reason === "string" ? s.reason : "", at: new Date(s.at).toISOString() };
}

/** This bridge process: readAt rises only within one, so the server compares it only between reports of the same run. */
const RUN = randomUUID();
let lastReadAt = 0;
/** The loop's reports and each save's, one at a time, so they leave in the order they were read. */
let reports = Promise.resolve();

/**
 * What PUT /api/bridge/models carries: this process's run and when it was read (ms, rising within the run, so the server
 * keeps the newest), the picks file (only its known jobs) or null, and each job's fallback from the status file; a
 * missing status file is none, an entry for an unknown job or out of shape is dropped.
 * @param {{ file?: string, statusFile?: string }} [opts]
 */
export async function readModelReport({ file = MODEL_ROUTING_FILE, statusFile = MODEL_STATUS_FILE } = {}) {
  const readAt = Math.max(Date.now(), lastReadAt + 1);
  lastReadAt = readAt;
  /** @type {{ run: string, readAt: number, file: { jobs: Record<string, unknown>, updated?: object } | null, fileError?: string, status: Record<string, object> }} */
  const report = { run: RUN, readAt, file: null, status: {} };
  const picks = await readJsonFile(file);
  if ("value" in picks) {
    const v = picks.value;
    if (isRecord(v) && isRecord(v.jobs)) {
      const jobs = Object.fromEntries(table.jobs.filter((job) => job.key in v.jobs).map((job) => [job.key, v.jobs[job.key]]));
      const updated = validUpdated(v.updated);
      report.file = { jobs, ...(updated ? { updated } : {}) };
    } else report.fileError = `${path.basename(file)} has no jobs`;
  } else if ("error" in picks) report.fileError = `${path.basename(file)} unreadable: ${picks.error}`.slice(0, 300);
  const status = await readJsonFile(statusFile);
  if ("value" in status && isRecord(status.value) && isRecord(status.value.jobs)) {
    const rows = /** @type {Record<string, unknown>} */ (status.value.jobs);
    for (const job of table.jobs) {
      const one = Object.hasOwn(rows, job.key) ? validStatus(rows[job.key]) : null;
      if (one) report.status[job.key] = one;
    }
  }
  return report;
}

/**
 * @param {ReportDeps} deps
 * @param {{ file?: string, statusFile?: string }} [opts]
 * @returns {Promise<void>}
 */
export function sendModelReport(deps, opts) {
  const turn = reports.then(() => putModelReport(deps, opts));
  reports = turn.catch(() => {});
  return turn;
}

/** @typedef {{ origin: string, token: string, fetch: typeof fetch, log: (event: string, fields?: Record<string, unknown>) => void }} ReportDeps */

/**
 * @param {ReportDeps} deps
 * @param {{ file?: string, statusFile?: string }} [opts]
 */
async function putModelReport(deps, opts) {
  const report = await readModelReport(opts);
  const res = await deps.fetch(`${deps.origin}/api/bridge/models`, {
    method: "PUT",
    headers: { authorization: `Bearer ${deps.token}`, "content-type": "application/json" },
    body: JSON.stringify(report),
    redirect: "error",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`models report http ${res.status}`);
  }
  const answer = await res.json().catch(() => null);
  if (isRecord(answer) && answer.stale === true) deps.log("models-report-stale", { run: report.run, readAt: report.readAt });
}

/** @param {string} file */
const mtime = (file) => fsp.stat(file).then((s) => s.mtimeMs, () => null);

/**
 * Reports on each kick (the bridge's connect), then each minute either file changed, and every five minutes regardless.
 * @param {ReportDeps & { stop: AbortSignal, file?: string, statusFile?: string, now?: () => number }} deps
 */
export function runModelReportLoop(deps) {
  const now = deps.now ?? Date.now;
  const files = { file: deps.file ?? MODEL_ROUTING_FILE, statusFile: deps.statusFile ?? MODEL_STATUS_FILE };
  let kicked = true;
  /** @type {(() => void) | null} */
  let wake = null;
  let sentAt = -Infinity;
  let seen = "";
  const kick = () => {
    kicked = true;
    wake?.();
  };
  const done = (async () => {
    while (!deps.stop.aborted) {
      const stamp = JSON.stringify([await mtime(files.file), await mtime(files.statusFile)]);
      if (kicked || stamp !== seen || now() - sentAt >= REPORT_EVERY_MS) {
        kicked = false;
        try {
          await sendModelReport(deps, files);
          sentAt = now();
          seen = stamp;
        } catch (err) {
          deps.log("models-report-failed", { error: err instanceof Error ? err.message.slice(0, 200) : "error" });
        }
      }
      if (kicked || deps.stop.aborted) continue;
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          deps.stop.removeEventListener("abort", finish);
          resolve(undefined);
        };
        const timer = setTimeout(finish, REPORT_POLL_MS);
        wake = finish;
        deps.stop.addEventListener("abort", finish);
      });
      wake = null;
    }
  })();
  return { done, kick };
}
