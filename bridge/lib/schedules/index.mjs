import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { repoAllowlist } from "../../../src/shared/repos.ts";
import { serverError } from "../board-client.mjs";
import { conditionalGet } from "../conditional-gh.mjs";
import { JOB_LABEL_RE } from "../jobs.mjs";
import { shapeText } from "../redact-cut.mjs";
import { clip, iso, parseJson } from "../ops/common.mjs";
import { LAUNCHCTL_BIN } from "../ops/mac.mjs";
import { cronWords, launchdWords, nextCalendar, nextCron, wordsFor } from "./words.mjs";

// The Schedules tab's feed: every timed or always-on job, read live each pass from the
// Mac's dev.rivet-agents.* launchd jobs and the scheduled workflows of the repos in
// RIVET_REPOS. The Mac every minute, GitHub every five. A source that fails keeps its
// last good items, and the snapshot says so. Reading changes nothing; toggle.mjs is the
// only writer.

export const SCHEDULES_INTERVAL_MS = 60_000;
export const SLOW_INTERVAL_MS = 5 * 60_000;
const UNAUTHORIZED_MS = 5 * 60_000;
const TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 15_000;
/** Workflow files read per pass; the rest wait for the next one (each is cached by its blob sha). */
const MAX_WORKFLOW_READS = 60;
export const MAX_ITEMS = 100;
/** Finished runs sent per schedule, newest first: the server cards two failed in a row. */
export const MAX_RECENT_RUNS = 5;
/** Runs read from each list, so a burst of re-runs still going leaves MAX_RECENT_RUNS finished ones. */
const RUNS_PER_PAGE = 4 * MAX_RECENT_RUNS;

export const AGENTS_DIR = path.join(os.homedir(), "Library", "LaunchAgents");
/** The Mac jobs' finished runs, kept across restarts: launchd itself remembers only the last. */
export const MAC_RUNS_FILE = path.join(os.homedir(), ".rivet-agents", "bridge", "schedule-runs.json");
export const PLUTIL_BIN = "/usr/bin/plutil";
const LABEL_PREFIX = "dev.rivet-agents.";
export const LABEL_RE = /^dev\.rivet-agents\.[a-z0-9][a-z0-9.-]{0,80}$/;
export const WORKFLOW_FILE_RE = /^[A-Za-z0-9._-]{1,100}\.ya?ml$/;
/** The bridge and the server: either switched off from the app, nothing could switch it back on. */
export const BRIDGE_LABEL = "dev.rivet-agents.bridge";
export const SERVER_LABEL = "dev.rivet-agents.server";
export const LOCKED_LABELS = new Set([BRIDGE_LABEL, SERVER_LABEL]);

export const CANNOT = Object.freeze({
  bridge: "The app needs this to reach the Mac. Switched off, nothing here could switch it back on.",
  pullRequests: "Switching it off would also stop its checks on pull requests: GitHub turns off the whole workflow, not just its timer.",
  otherEvents: "It also runs on pushes or other events: GitHub turns off the whole workflow, not just its timer.",
  unreadable: "Its triggers could not be read, so it is left as it is.",
});

/**
 * @typedef {"daily" | "weekly" | "all-day" | "always-on"} Group
 * @typedef {"ok" | "failed" | "skipped" | "running" | "unknown"} RunResult
 * @typedef {{ at: string | null, result: RunResult, note?: string, url?: string }} LastRun
 * @typedef {{ id: string, at: string, result: "ok" | "failed" | "skipped" | "unknown", url?: string }} RecentRun
 * @typedef {{ count: number, runs: RecentRun[] }} MacHistory a timed job's last run count seen, and its finished runs
 * @typedef {{ can: true } | { can: false, why: string }} Toggle
 * @typedef {"mac" | "github"} Source
 * @typedef {{ id: string, source: Source, name: string, what: string, when: string, group: Group, on: boolean,
 *   lastRun: LastRun | null, runs?: RecentRun[], nextRun: string | null, toggle: Toggle }} Schedule
 * @typedef {{ source: Source, ok: boolean, at: string | null, error?: string }} SourceState
 * @typedef {import("../config.mjs").Exec} Exec
 */

/** @param {unknown} err */
function short(err) {
  const e = /** @type {any} */ (err);
  // Never empty: the server takes a source's error only as one to 160 characters.
  // Redacted whole before clip cuts it: a source's error is sent to Rivet and shown.
  return clip(shapeText(String(e?.message ?? "error").replaceAll(os.homedir(), "~"), 120), 120) || "error";
}

// The Mac's launchd jobs

/**
 * What `launchctl print` says of one job, or null when it is not loaded.
 * @param {Exec} exec @param {number} uid @param {string} label
 */
export async function launchdState(exec, uid, label) {
  let stdout;
  try {
    ({ stdout } = await exec(LAUNCHCTL_BIN, ["print", `gui/${uid}/${label}`], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }));
  } catch (err) {
    // 113: "Could not find service" — the job is not loaded.
    if (/** @type {any} */ (err)?.code === 113 || /Could not find service/i.test(String(/** @type {any} */ (err)?.stderrFirstLine ?? ""))) return null;
    throw err;
  }
  const field = (/** @type {string} */ name) => new RegExp(`^\\s*${name} = (.+)$`, "m").exec(stdout)?.[1]?.trim();
  const pid = Number(field("pid"));
  const runs = Number(field("runs"));
  const exitRaw = field("last exit code");
  const exit = exitRaw && /^-?\d+/.test(exitRaw) ? Number(/^-?\d+/.exec(exitRaw)?.[0]) : null;
  const signal = field("last terminating signal");
  return { pid: Number.isInteger(pid) && pid > 0 ? pid : null, runs: Number.isInteger(runs) ? runs : null, exit, signal: signal ? clip(signal, 60) : null };
}

/** @param {{ exit: number | null, signal: string | null }} state */
export function exitWords(state) {
  if (state.signal) return `Stopped by a signal (${state.signal})`;
  if (state.exit === null || state.exit === 0) return undefined;
  if (state.exit === 127) return "The script it runs is missing (exit 127)";
  if (state.exit === 126) return "The script it runs can't be started (exit 126)";
  return `Exit code ${state.exit}`;
}

/** The newest time either of a job's log files was written. @param {any} plist */
function logWritten(plist) {
  let newest = 0;
  for (const file of [plist.StandardOutPath, plist.StandardErrorPath]) {
    if (typeof file !== "string" || !path.isAbsolute(file)) continue;
    try {
      newest = Math.max(newest, statSync(file).mtimeMs);
    } catch {
      // No log yet.
    }
  }
  return newest || null;
}

/**
 * launchd keeps a job's run count since it was loaded and its last exit status. A count that moved since the last one
 * seen is a finished run, timed when it was seen: a log's write time can't stand in, as some jobs never write theirs.
 * - A count more than one up means runs went by unseen: an "unknown" run goes in before it, so no streak spans them.
 * - A count that went down is a reload or a restart, and the run after it is a new one.
 * - A job seen for the first time has no known finish time, so that run is "unknown" too.
 * @param {Map<string, MacHistory>} history @param {string} label
 * @param {{ pid: number | null, runs: number | null, exit: number | null, signal: string | null } | null} state @param {number} now
 */
function macRuns(history, label, state, now) {
  const seen = history.get(label);
  if (!state || state.pid || state.runs === null) return seen?.runs ?? [];
  const count = state.runs;
  if (seen?.count === count) return seen.runs;
  if (state.exit === null) {
    // Loaded and not yet run: only the count to start from.
    history.set(label, { count, runs: seen?.runs ?? [] });
    return seen?.runs ?? [];
  }
  const at = /** @type {string} */ (iso(now));
  const result = !seen ? "unknown" : state.exit === 0 && !state.signal ? "ok" : "failed";
  /** @type {RecentRun[]} */
  const added = [{ id: clip(`${count}:${state.exit}@${at}`, 120), at, result }];
  if (seen && count > seen.count + 1) added.push({ id: clip(`missed:${seen.count + 1}-${count - 1}@${at}`, 120), at: /** @type {string} */ (iso(now - 1)), result: "unknown" });
  const runs = [...added, ...(seen?.runs ?? [])].slice(0, MAX_RECENT_RUNS);
  history.set(label, { count, runs });
  return runs;
}

/** Labels marked disabled in launchd's override database. @param {string} stdout */
export function parseDisabled(stdout) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const m of stdout.matchAll(/"([^"]+)"\s*=>\s*(disabled|true)/g)) out.add(m[1]);
  return out;
}

/**
 * `history` is each timed job's finished runs as this bridge saw them, newest first: launchd keeps only the last.
 * @param {{ exec: Exec, now: number, agentsDir?: string, uid?: number, macZone?: string,
 *   plists: Map<string, { mtime: number, plist: any }>, history?: Map<string, MacHistory> }} deps
 * @returns {Promise<Schedule[]>}
 */
export async function collectMac({ exec, now, agentsDir = AGENTS_DIR, uid = process.getuid?.() ?? 501, macZone, plists, history = new Map() }) {
  const zone = macZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // A label is the item's id, which toggles key on: one that redaction would change is not sent at all.
  // The owner's own jobs are on Ops › Scheduled, which the server keeps.
  const files = readdirSync(agentsDir)
    .filter((f) => f.endsWith(".plist") && LABEL_RE.test(f.slice(0, -6)) && !JOB_LABEL_RE.test(f.slice(0, -6)) && shapeText(f.slice(0, -6), Infinity) === f.slice(0, -6))
    .sort();
  const disabled = parseDisabled((await exec(LAUNCHCTL_BIN, ["print-disabled", `gui/${uid}`], { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 })).stdout);
  /** @type {Schedule[]} */
  const out = [];
  for (const file of files) {
    const label = file.slice(0, -6);
    const full = path.join(agentsDir, file);
    const mtime = statSync(full).mtimeMs;
    let cached = plists.get(label);
    if (!cached || cached.mtime !== mtime) {
      const { stdout } = await exec(PLUTIL_BIN, ["-convert", "json", "-o", "-", full], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 });
      cached = { mtime, plist: parseJson(stdout, "plutil") };
      plists.set(label, cached);
    }
    const plist = cached.plist ?? {};
    // launchd runs a job by its Label; a file named for another label is not this job.
    if (plist.Label !== label) continue;
    const words = wordsFor(label, shapeText(label.slice(LABEL_PREFIX.length), 80));
    const sched = launchdWords(plist, zone);
    const state = await launchdState(exec, uid, label);
    // On is launchd's lasting setting: disabled is off even mid-run, so the switch can always turn it back on.
    const on = state !== null && !disabled.has(label);
    const written = logWritten(plist);
    /** @type {LastRun | null} */
    let lastRun;
    if (sched.group === "always-on") {
      lastRun = state?.pid
        ? { at: null, result: "running" }
        : { at: iso(written), result: on ? "failed" : "unknown", note: on ? (exitWords(state ?? { exit: null, signal: null }) ?? "Not running") : "Not running" };
    } else if (state?.pid) {
      lastRun = { at: iso(written), result: "running" };
    } else if (state && state.exit !== null) {
      const note = exitWords(state);
      lastRun = { at: iso(written), result: state.exit === 0 && !state.signal ? "ok" : "failed", ...(note ? { note } : {}) };
    } else {
      lastRun = written ? { at: iso(written), result: "unknown", note: "Last log written" } : null;
    }
    // An always-on job never finishes as ok, and the tab already shows it down: it gets no run history, so never a card.
    const runs = sched.group === "always-on" ? undefined : macRuns(history, label, state, now);
    let nextRun = null;
    if (on && sched.calendar) nextRun = iso(nextCalendar(sched.calendar, now));
    else if (on && sched.interval && written && written + sched.interval * 1000 > now) nextRun = iso(written + sched.interval * 1000);
    out.push({
      id: `mac:${label}`,
      source: "mac",
      name: words.name,
      what: words.what,
      when: clip(sched.when, 120),
      group: sched.group,
      on,
      lastRun,
      ...(runs ? { runs } : {}),
      nextRun,
      toggle: LOCKED_LABELS.has(label) ? { can: false, why: CANNOT.bridge } : { can: true },
    });
  }
  return out;
}

// GitHub scheduled workflows

/**
 * The events that start a workflow, its cron lines, and whether a manual run takes inputs, read from the file's text.
 * Handles `on: push`, `on: [push, schedule]` and the block form.
 * @param {string} text
 * @returns {{ triggers: string[], crons: string[], unsure?: true, dispatchInputs?: true } | null}
 */
export function workflowTriggers(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^(on|"on"|'on'|true):/.test(l));
  if (start < 0) return null;
  const inline = lines[start].replace(/^[^:]+:\s*/, "").replace(/\s+#.*$/, "").trim();
  if (inline) {
    const names = inline.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    return names.every((n) => /^[a-z_]+$/.test(n)) ? { triggers: names, crons: [] } : null;
  }
  const triggers = [];
  const crons = [];
  let unsure = false;
  let dispatchInputs = false;
  let indent = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const lead = /^(\s*)/.exec(line)?.[1].length ?? 0;
    if (lead === 0) break;
    if (indent < 0) indent = lead;
    // An event key at the block's own indent, bare or quoted. Anything else there is a form this
    // reader doesn't know, so the workflow is marked unsure and its switch stays locked.
    if (lead === indent && !/^\s*-/.test(line)) {
      const key = new RegExp(`^ {${indent}}(["']?)([A-Za-z_]+)\\1\\s*:`).exec(line);
      if (key) triggers.push(key[2]);
      else unsure = true;
    } else if (lead < indent) unsure = true;
    if (triggers.at(-1) === "workflow_dispatch" && /\binputs\s*:/.test(line)) dispatchInputs = true;
    const cron = /cron:\s*["']?([^"'#]+?)["']?\s*(#.*)?$/.exec(line);
    if (cron) crons.push(cron[1].trim());
  }
  return triggers.length ? { triggers, crons, ...(unsure ? { unsure: true } : {}), ...(dispatchInputs ? { dispatchInputs: true } : {}) } : null;
}

const TIMER_ONLY = new Set(["schedule", "workflow_dispatch"]);

/**
 * @typedef {{ sha: string, parsed: { triggers: string[], crons: string[], unsure?: true, dispatchInputs?: true, name: string } | null }} WorkflowFile
 * Every read is a GET sent with the ETag of its last answer: the folders, states and runs it reads change a few times a
 * day, a 304 costs none of the owner's hourly REST budget, and every tool on the account shares it.
 * @typedef {Pick<ReturnType<typeof import("../ops/false-alarm.mjs").createFalseAlarmRetry>, "held">} FalseAlarm
 * @param {{ exec: Exec, ghBin: string, now: number, repos?: readonly string[], files: Map<string, WorkflowFile>, etags?: import("../conditional-gh.mjs").EtagStore,
 *   falseAlarm?: FalseAlarm | null }} deps (falseAlarm: a red run waiting on its one re-run shows as running)
 * @returns {Promise<Schedule[]>}
 */
export async function collectGithub({ exec, ghBin, now, repos = repoAllowlist(), files, etags = new Map(), falseAlarm = null }) {
  const gh = async (/** @type {string[]} */ args) => (await exec(ghBin, args, { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })).stdout;
  const get = conditionalGet(gh, etags);
  const read = async (/** @type {string} */ p, /** @type {string} */ jq) => (await get(p, jq)).body;
  let reads = 0;
  /** @type {Schedule[]} */
  const out = [];
  for (const repo of repos) {
    let listing;
    try {
      listing = parseJson(await read(`repos/${repo}/contents/.github/workflows`, "[.[] | {name, path, sha}]"), "gh");
    } catch (err) {
      // A repo with no workflows folder answers 404: nothing scheduled there.
      const e = /** @type {any} */ (err);
      if (/Not Found|HTTP 404/.test(`${e?.stderrFirstLine ?? ""} ${e?.stdout ?? ""}`)) continue;
      throw err;
    }
    if (!Array.isArray(listing)) continue;
    /** @type {{ file: string, parsed: NonNullable<WorkflowFile["parsed"]> }[]} */
    const scheduled = [];
    for (const entry of listing) {
      // A file name is part of the item's id: one that redaction would change is not sent at all.
      if (typeof entry?.name !== "string" || !WORKFLOW_FILE_RE.test(entry.name) || shapeText(entry.name, Infinity) !== entry.name || typeof entry.sha !== "string") continue;
      const key = `${repo}/.github/workflows/${entry.name}`;
      let cached = files.get(key);
      if (!cached || cached.sha !== entry.sha) {
        if (reads >= MAX_WORKFLOW_READS) continue;
        reads++;
        const content = await read(`repos/${repo}/contents/.github/workflows/${entry.name}`, ".content");
        const text = Buffer.from(content.replace(/\s+/g, ""), "base64").toString("utf8");
        const triggers = workflowTriggers(text);
        const name = /^name:\s*["']?(.+?)["']?\s*$/m.exec(text)?.[1] ?? entry.name;
        // A name that sanitises to nothing (`name: " "`) is no name: the server takes none empty.
        cached = { sha: entry.sha, parsed: triggers ? { ...triggers, name: clip(shapeText(name, 80), 80) || clip(entry.name, 80) } : null };
        files.set(key, cached);
      }
      if (cached.parsed?.triggers.includes("schedule")) scheduled.push({ file: entry.name, parsed: cached.parsed });
    }
    if (!scheduled.length) continue;
    /** @type {Map<string, string>} */
    const states = new Map();
    // One page usually holds them all; a repo with more is read whole.
    const page = parseJson(await read(`repos/${repo}/actions/workflows?per_page=100`, "{total: .total_count, rows: [.workflows[] | [.path, .state] | @tsv]}"), "gh");
    const rows = Array.isArray(page?.rows) && page.total === page.rows.length
      ? page.rows.join("\n")
      : await gh(["api", `repos/${repo}/actions/workflows`, "--paginate", "--jq", ".workflows[] | [.path, .state] | @tsv"]);
    for (const line of String(rows).split("\n")) {
      const [p, state] = line.split("\t");
      if (p && state) states.set(path.basename(p), state.trim());
    }
    const defaultBranch = (await read(`repos/${repo}`, ".default_branch")).trim();
    for (const { file, parsed } of scheduled) {
      const key = `${repo}/.github/workflows/${file}`;
      const words = wordsFor(key, parsed.name);
      const when = parsed.crons
        .map((c) => cronWords(c, "UTC", now))
        .filter((w) => w !== null);
      const on = states.get(file) === "active";
      const next = on ? parsed.crons.map((c) => nextCron(c, now, "UTC")).filter((t) => t !== null).sort((a, b) => /** @type {number} */ (a) - /** @type {number} */ (b))[0] : null;
      /** @type {LastRun | null} */
      let lastRun = null;
      /** @type {RecentRun[]} */
      const runs = [];
      // Its timer runs, and the manual ones on the default branch: a fix proved by a re-run shows
      // at once, not at the next timer. Pull request, push and other-branch runs never count, nor
      // manual runs of a workflow that takes inputs: those can run less than the timer does,
      // so their green proves nothing about it.
      const manual = defaultBranch && parsed.triggers.includes("workflow_dispatch") && !parsed.dispatchInputs && !parsed.unsure;
      const queries = ["event=schedule", ...(manual ? [`event=workflow_dispatch&branch=${encodeURIComponent(defaultBranch)}`] : [])];
      /** @type {string[]} */
      const runLines = [];
      for (const query of queries) {
        const text = await read(
          `repos/${repo}/actions/workflows/${file}/runs?${query}&per_page=${RUNS_PER_PAGE}`,
          '.workflow_runs[] | [.id, .created_at, .updated_at, .status, .conclusion // "", .html_url, .run_attempt] | @tsv',
        );
        runLines.push(...text.split("\n").filter((l) => l.trim() && l.trim() !== "null"));
      }
      // Newest started first across both lists; ISO times sort as text.
      runLines.sort((a, b) => (b.split("\t")[1] ?? "").localeCompare(a.split("\t")[1] ?? ""));
      for (const runLine of runLines) {
        const [id, at, finishedAt, status, conclusion, url, attempt] = runLine.split("\t");
        let result = status !== "completed" ? "running" : conclusion === "success" ? "ok" : conclusion === "skipped" || conclusion === "cancelled" ? "skipped" : "failed";
        if (result === "failed" && falseAlarm && /^\d+$/.test(id ?? "")) {
          const run = { repo, id: Number(id), attempt: Number(attempt) || 1, workflow: parsed.name, status, conclusion: conclusion || null, createdAt: String(at), updatedAt: String(finishedAt) };
          if (await falseAlarm.held(run)) result = "running";
        }
        const link = url && /^https:\/\/github\.com\//.test(url) ? { url: clip(url, 300) } : {};
        lastRun ??= {
          at: iso(at),
          result: /** @type {RunResult} */ (result),
          ...(result === "failed" ? { note: clip(`Finished: ${conclusion || "unknown"}`, 60) } : {}),
          ...link,
        };
        const done = iso(finishedAt);
        if (result !== "running" && /^\d+$/.test(id ?? "") && done) runs.push({ id: /** @type {string} */ (id), at: done, result: /** @type {RecentRun["result"]} */ (result), ...link });
      }
      // The newest finished, as the server reads them: a long run that finished last is kept.
      runs.sort((a, b) => b.at.localeCompare(a.at)).splice(MAX_RECENT_RUNS);
      const timerOnly = parsed.triggers.every((t) => TIMER_ONLY.has(t));
      out.push({
        id: `github:${repo}/${file}`,
        source: "github",
        name: words.name,
        what: words.what,
        when: clip(when.length ? when.map((w) => w.when).join("; ") : "Custom schedule", 120),
        group: when[0]?.group ?? "daily",
        on,
        lastRun,
        runs,
        nextRun: next ? iso(next) : null,
        toggle: parsed.unsure
          ? { can: false, why: CANNOT.unreadable }
          : timerOnly
            ? { can: true }
            : { can: false, why: parsed.triggers.some((t) => t.startsWith("pull_request")) ? CANNOT.pullRequests : CANNOT.otherEvents },
      });
    }
  }
  return out;
}

// The Mac jobs' run history

/** A missing or unreadable file is an empty history: the next finished runs start it again. @param {string | undefined} file */
export function readMacRuns(file) {
  /** @type {Map<string, MacHistory>} */
  const out = new Map();
  if (!file) return out;
  try {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    for (const [label, entry] of Object.entries(doc ?? {})) {
      if (!LABEL_RE.test(label) || !Number.isInteger(entry?.count) || !Array.isArray(entry?.runs)) continue;
      /** @type {RecentRun[]} */
      const runs = entry.runs.flatMap((/** @type {any} */ r) => {
        const at = iso(r?.at);
        return typeof r?.id === "string" && r.id && at && ["ok", "failed", "unknown"].includes(r.result) ? [{ id: clip(r.id, 120), at, result: r.result }] : [];
      });
      out.set(label, { count: entry.count, runs: runs.slice(0, MAX_RECENT_RUNS) });
    }
  } catch {
    // Starts empty.
  }
  return out;
}

/** @param {string} file @param {Map<string, MacHistory>} history */
function writeMacRuns(file, history) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(history))}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

// The loop

/** Wakes the loop for an early pass (after a toggle). */
let wake = () => {};
export function wakeSchedules() {
  wake();
}

/**
 * Keeps per-source caches and the last good items of each source, so one failing
 * source never blanks the others.
 * `runsFile` keeps the Mac jobs' run history across restarts; without one it lasts as long as the collector.
 * @param {{ exec: Exec, ghBin: string, now?: () => Date,
 *   log?: (event: string, fields?: Record<string, unknown>) => void, agentsDir?: string, repos?: readonly string[], runsFile?: string,
 *   falseAlarm?: FalseAlarm | null }} deps
 */
export function createCollector(deps) {
  const nowMs = () => (deps.now ?? (() => new Date()))().getTime();
  const plists = new Map();
  const macHistory = readMacRuns(deps.runsFile);
  const files = new Map();
  /** @type {import("../conditional-gh.mjs").EtagStore} */
  const etags = new Map();
  /** @type {Map<Source, { items: Schedule[], state: SourceState, lastTry: number }>} */
  const kept = new Map();

  /** @param {Source} source @param {() => Promise<Schedule[]>} read */
  async function run(source, read) {
    const prior = kept.get(source);
    try {
      const items = await read();
      kept.set(source, { items, state: { source, ok: true, at: new Date(nowMs()).toISOString() }, lastTry: nowMs() });
    } catch (err) {
      deps.log?.("schedules-source-failed", { source, error: short(err) });
      kept.set(source, { items: prior?.items ?? [], state: { source, ok: false, at: prior?.state.at ?? null, error: short(err) }, lastTry: nowMs() });
    }
  }

  const readers = {
    mac: async () => {
      const before = JSON.stringify([...macHistory]);
      const items = await collectMac({ exec: deps.exec, now: nowMs(), agentsDir: deps.agentsDir, plists, history: macHistory });
      if (deps.runsFile && JSON.stringify([...macHistory]) !== before) {
        try {
          writeMacRuns(deps.runsFile, macHistory);
        } catch (err) {
          deps.log?.("schedules-runs-file-failed", { error: short(err) });
        }
      }
      return items;
    },
    github: () => collectGithub({ exec: deps.exec, ghBin: deps.ghBin, now: nowMs(), repos: deps.repos, files, etags, falseAlarm: deps.falseAlarm }),
  };

  return {
    /**
     * One pass. The Mac always; GitHub when its five minutes are up, or `force`.
     * @param {{ force?: boolean, only?: Source }} [options]
     */
    async collect(options = {}) {
      for (const source of /** @type {Source[]} */ (["mac", "github"])) {
        if (options.only && options.only !== source) continue;
        const slow = source === "github";
        const prior = kept.get(source);
        if (slow && !options.force && !options.only && prior && nowMs() - prior.lastTry < SLOW_INTERVAL_MS) continue;
        await run(source, readers[source]);
      }
      return this.snapshot();
    },
    snapshot() {
      const sources = [...kept.values()].map((k) => k.state);
      const items = [...kept.values()].flatMap((k) => k.items).slice(0, MAX_ITEMS);
      return { at: new Date(nowMs()).toISOString(), items, sources };
    },
    /** @param {string} id */
    find(id) {
      return [...kept.values()].flatMap((k) => k.items).find((item) => item.id === id) ?? null;
    },
  };
}

/** @type {ReturnType<typeof createCollector> | null} */
let shared = null;
/** The collector the loop runs, so a toggle can re-read the same caches. */
export function sharedCollector() {
  return shared;
}

/**
 * Sends the snapshot every minute with the bridge token.
 * @param {{ origin: string, token: string, fetch: typeof fetch, exec: Exec, ghBin: string,
 *   log: (event: string, fields?: Record<string, unknown>) => void, stop: AbortSignal, now?: () => Date, runsFile?: string,
 *   falseAlarm?: FalseAlarm | null }} deps
 *   (runsFile: the Mac jobs' run history, MAC_RUNS_FILE unless a test names its own; falseAlarm: the Ops loop's
 *   one re-run of a CI run that failed on a GitHub hiccup, whose held runs show as running here too)
 */
export async function runSchedulesLoop(deps) {
  const collector = createCollector({ ...deps, runsFile: deps.runsFile ?? MAC_RUNS_FILE });
  shared = collector;
  const headers = { authorization: `Bearer ${deps.token}`, "content-type": "application/json" };
  while (!deps.stop.aborted) {
    let delay = SCHEDULES_INTERVAL_MS;
    try {
      const snapshot = await collector.collect();
      const res = await deps.fetch(`${deps.origin}/api/bridge/schedules`, {
        method: "PUT",
        headers,
        body: JSON.stringify(snapshot),
        redirect: "error",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      // A 400 names the fields it refused: one bad item drops the whole snapshot.
      if (!res.ok && res.status !== 401 && res.status !== 403) throw new Error(`/api/bridge/schedules ${await serverError(res, { issues: true })}`);
      await res.body?.cancel().catch(() => {});
      if (!res.ok) delay = UNAUTHORIZED_MS;
    } catch (err) {
      deps.log("schedules-failed", { error: short(err) });
    }
    await new Promise((resolve) => {
      if (deps.stop.aborted) return resolve(undefined);
      const done = () => {
        clearTimeout(timer);
        deps.stop.removeEventListener("abort", done);
        wake = () => {};
        resolve(undefined);
      };
      const timer = setTimeout(done, delay);
      deps.stop.addEventListener("abort", done, { once: true });
      wake = done;
    });
  }
  shared = null;
}
