import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatLog } from "../bridge/lib/config.mjs";
import { holdLines } from "../bridge/lib/pr-holds.mjs";
import { MAX_LOG_LINE, SECRET_NAME, SECRET_WORDS, heldTo, keyReadings, redactCutTop, redactLines, shortenHome, shown } from "../bridge/lib/redact.mjs";
import { scheduledRun } from "../bridge/lib/scheduled-run.mjs";
import { usageCost, zoneDay } from "../bridge/lib/spend.mjs";
import { clipUnits, plain, readings } from "../bridge/lib/templates.mjs";
import { claudeArgs, cliDetail, makeClaudeRun } from "../bridge/lib/threads-titler.mjs";

// What every reader shares: small jobs that read on a cheap model. A reader sends redacted text to the local Claude
// Code CLI, the client the titler uses, and takes back one JSON object of fixed fields. What it reads is data, never
// instructions: the answer can only fill those fields, and each job decides what it does with them. Each job has a
// daily spend ceiling, priced with spend.mjs's rows; at the ceiling it stops for the day and logs that once.
//
// Readers cost money, so they stay off until the user has said so twice: RIVET_READERS=on in the settings, and
// scripts/install-readers.sh run on this computer. readersOn is that one check. Every reader asks it first, and
// makeReaderRun, the only way to the CLI, refuses without it.

export const READER_MODEL = "claude-haiku-5-5";
export const READERS_DIR = path.join(os.homedir(), ".rivet-agents", "readers");
export const SPEND_DIR = path.join(READERS_DIR, "spend");
/** Written by scripts/install-readers.sh and removed by its --uninstall. */
export const INSTALL_MARKER = path.join(READERS_DIR, "installed");
const CLI_TIMEOUT_MS = 90_000;
/** The most a reader call may write, thinking included: far above any batch's answer, and the bound a failed call is charged at. */
export const READER_MAX_OUTPUT_TOKENS = 8000;
const HISTORY_DAYS = 31;

/** The CLI failed, was signed out, timed out or answered an error: try again next run. */
export class CliError extends Error {}
/** The answer had no JSON object, or its fields were wrong. */
export class BadAnswer extends Error {}
/** Today's spend reached the job's ceiling. */
export class CeilingReached extends Error {}
/** A runner was asked for with the readers off. */
export class ReadersOff extends Error {}

/**
 * The one gate: whether readers may run here. Both must hold, RIVET_READERS=on and the installer's marker on disk.
 * @param {Record<string, string | undefined>} [env] @param {string} [marker]
 */
export function readersOn(env = process.env, marker = INSTALL_MARKER) {
  return env.RIVET_READERS === "on" && fs.existsSync(marker);
}

/**
 * A reader's run from its schedule: with the readers off, one log line and exit 0, and `main` never starts.
 * @param {string} job @param {() => Promise<any>} main
 * @returns {Promise<number>}
 */
export async function runReader(job, main) {
  if (readersOn()) return scheduledRun(job, main);
  console.log(formatLog(`${job}-off`, {}));
  return 0;
}

/**
 * A runner for one reader: the titler's CLI flags with this job's effort and system prompt, and its output capped.
 * It runs on the user's own `claude` login.
 * @param {string} bin absolute path of `claude`
 * @param {{ job: string, effort: "low" | "medium", system: string, timeoutMs?: number }} opts
 * @returns {(input: string) => Promise<string>}
 */
export function makeReaderRun(bin, { effort, system, timeoutMs = CLI_TIMEOUT_MS }) {
  if (!readersOn()) throw new ReadersOff("readers are off");
  return makeClaudeRun(bin, claudeArgs(READER_MODEL, effort, system), timeoutMs, { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(READER_MAX_OUTPUT_TOKENS) });
}

/**
 * The answer's JSON object and the call's cost from the CLI's `--output-format json` output.
 * @param {string} stdout
 * @returns {{ answer: Record<string, unknown>, usd: number }}
 */
export function parseCliOutput(stdout) {
  let outer;
  try {
    outer = JSON.parse(stdout);
  } catch {
    throw new CliError("claude printed no JSON");
  }
  const usd = outer && typeof outer === "object" ? usageCost(READER_MODEL, outer.usage) : 0;
  if (outer?.is_error !== false || typeof outer.result !== "string") {
    const err = new CliError(`claude ${cliDetail(stdout) || "error"}`);
    /** @type {any} */ (err).usd = usd;
    throw err;
  }
  const text = outer.result;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let answer = null;
  try {
    answer = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : null;
  } catch {
    answer = null;
  }
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    const err = new BadAnswer("no JSON object in the answer");
    /** @type {any} */ (err).usd = usd;
    throw err;
  }
  return { answer, usd };
}

/** A line break the bridge's redactor splits a line at before it reads it (its display then shows none of them). */
const INNER_BREAK = /\r\n|[\r\v\f\x85\u2028\u2029]/;

/** A secret's name anywhere in a text, read from where a name starts (from inside a long token it was quadratic). */
const SECRET_WORD = new RegExp(`(?<![A-Za-z0-9_.-])${SECRET_NAME}`, "i");

/** @param {string} v */
const squash = (v) => v.replace(/\s+/g, "");

/** Whether the bridge's redactor, reading a line alone, changes it. @param {string} line @param {string | undefined} home */
function changesAlone(line, home) {
  const [one, ...more] = redactLines([line], { inKey: false }, home, { rest: false });
  return more.length > 0 || typeof one !== "string" || squash(one) !== squash(line);
}

/**
 * A line is read whole, as the redactor shows it, with its breaks and controls out (`pass\rword: v` reads as
 * `password: v`). A line that holds a break the redactor splits at is read in its parts too (`prefix\rBearer v`): it
 * is clean only if it has no secret's name in it and neither reading changes it. One that is not may hide where a
 * secret's state opens (`api\r_key:\rfirst`, `prefix\r-u '…\`), so it drops the rest of the text wherever it is.
 * @param {string} raw @param {string | undefined} home
 */
function breaksHide(raw, home) {
  if (!INNER_BREAK.test(raw)) return false;
  if (SECRET_WORD.test(raw) || changesAlone(shown(raw), home)) return true;
  return raw.split(INNER_BREAK).some((part) => changesAlone(shown(part), home));
}

/**
 * Lines grouped as the bridge's redactor joins them: a line that ends in a backslash, any number of them, and the lines
 * it carries on to are one logical line.
 * @param {string[]} lines the lines as the redactor shows them
 */
function logicalLines(lines) {
  /** @type {number[][]} */
  const groups = [];
  let open = false;
  lines.forEach((line, i) => {
    if (open) groups[groups.length - 1].push(i);
    else groups.push([i]);
    open = line.endsWith("\\");
  });
  return groups;
}

/**
 * Whether a continued line (several lines a backslash joins) may hold a secret: a secret's name anywhere in it, as
 * written or joined (`api\` then `_key:`), or the joined line or any line of it that the redactor changes alone. A
 * continued line is dropped whole whatever this says, since the redactor's join can take a value's word boundary away
 * (`prefix\`, `Bear\`, `er v`); one that may hold a secret drops the rest.
 * @param {string[]} group @param {string | undefined} home
 */
function mayHoldSecret(group, home) {
  const parts = group.map((line, i) => (i < group.length - 1 ? line.slice(0, -1) : line));
  const joined = parts.join("");
  if (SECRET_WORD.test(group.join("")) || SECRET_WORD.test(joined)) return true;
  return changesAlone(shown(joined), home) || parts.some((line) => changesAlone(shown(line), home));
}

/**
 * Text redacted with the bridge's redactor (secrets, tokens, home paths) as one message in its rest mode: from the
 * first secret on, its value to the end of the line and every later line are dropped, so a value of several words
 * cannot leak past the first. A continued line is dropped whole; from one that may hold a secret, or a line whose
 * breaks may hide one, the rest is dropped. With `cutTop` (a terminal's screen, whose top was cut off) the lines are
 * redacted as a read with its top cut (`redactCutTop`): held back to column 0, IP addresses and wrapped tokens covered.
 * @param {string | string[]} text @param {{ cutTop?: boolean }} [options]
 */
export function redact(text, options = {}) {
  const raw = (Array.isArray(text) ? text : [String(text ?? "")]).flatMap((one) => String(one).split(/\r?\n/));
  const lines = raw.map(shown);
  /** @type {string[]} */
  const kept = [];
  let stop = false;
  for (const group of logicalLines(lines)) {
    const physical = group.map((i) => lines[i]);
    if (group.some((i) => breaksHide(raw[i], undefined)) || (group.length > 1 && mayHoldSecret(physical, undefined))) {
      stop = true;
      break;
    }
    // One at a time: a group of very many lines passed as arguments throws (past V8's limit).
    if (group.length === 1) kept.push(physical[0]);
    else for (let n = 0; n < group.length; n++) kept.push("[redacted]");
  }
  const out = options.cutTop ? redactCutTop(kept, undefined, { rest: true }, heldTo(lines)) : redactLines(kept, { inKey: false }, undefined, { rest: true });
  return (stop ? [...out, "[redacted]"] : out).join("\n");
}

/** Lines dropped after any line the redactor changed: a value it lost track of (a brace value) can go on below it. */
const LOG_HOLD_LINES = 10;

/**
 * The longest line redactLog judges on the redactor's whole output: past it some shapes cost the redactor quadratic
 * time unclipped (a run of `-`: 200 ms at 20,000), so a longer line is dropped unjudged.
 */
const MAX_JUDGED_LINE = 16 * MAX_LOG_LINE;

/** The redactor's secret names with no PASS, AUTH or SESSION alone. */
const LONG_SECRET_NAME = new RegExp(
  "^[A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API[-_]?KEY|ACCESS[-_]?KEY|PRIVATE[-_]?KEY|CLIENT[-_]?KEY|CREDENTIALS?|COOKIE|DSN|DATABASE[-_]URL|CONN(?:ECTION)?[-_]?STRING|SIGNING[-_]?KEY|WEBHOOK)[A-Za-z0-9_.-]*$",
  "i",
);

/**
 * Whether a secret name is a key here. One word found only through PASS, AUTH or SESSION (`PASS`, `passed`, `Author`,
 * `session`) is a word a log prints, not a key; a compound one (`DB_PASS`, `dbPass`, `SESSION_KEY`) is a key.
 * @param {string} name
 */
const secretKeyName = (name) => LONG_SECRET_NAME.test(name) || !/^(?:[a-z]+|[A-Z]+|[A-Z][a-z]+)$/.test(name);

/**
 * A secret key as YAML writes one: quoted (`"token":`), or bare with a space or the line's end after its colon
 * (`password: `). An error's name (`TokenExpiredError: jwt expired`) is not a key, nor is a path (`token.ts:12`). A name is
 * its whole run of name characters, taken once (as a secret name it backtracked over a long run with no colon after it).
 */
const NAME = `(?=[A-Za-z0-9_.-]*?${SECRET_WORDS})(?=([A-Za-z0-9_.-]+))`;
const SECRET_KEY = new RegExp(`(?<![A-Za-z0-9_.-])(?:(["'])${NAME}\\2\\1\\s*:|${NAME}\\3(?<!error|exception)\\s*:(?=\\s|$))`, "gi");

/** A value GitHub masked whole, alone or after an auth scheme: GitHub masks every line of a secret it knows. */
const MASKED = /^(?:(?:basic|bearer|token)\s+)?\*{3}(?:\s+\*{3})*$/i;


/**
 * How many of YAML's flow brackets each prefix of a text leaves open (`[` and `{` less `]` and `}`): counted once a line,
 * as a count per key over its prefix and its rest was quadratic on a line of many keys. @param {string} text
 */
const depths = (text) => {
  const open = new Int32Array(text.length + 1);
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    open[i + 1] = open[i] + (char === "[" || char === "{" ? 1 : char === "]" || char === "}" ? -1 : 0);
  }
  return open;
};
const NONBLANK = /\S/g;

/**
 * Whether a changed line has a secret key with a YAML plain value, which can go on over any later lines (in a runner's
 * log, not a one-word PASS, AUTH or SESSION key, which a log prints as a word). Not one:
 * an empty, bracketed, block or quoted value, which the redactor follows over lines itself; a value GitHub masked whole;
 * a value inside `{…}` or `[…]` closed later on the line, where YAML ends it.
 * @param {string} line
 * @param {boolean} [runnerLog]
 */
function opensPlainValue(line, runnerLog = true) {
  const keys = [...line.matchAll(SECRET_KEY)];
  if (keys.length === 0) return false;
  const open = depths(line);
  for (const [n, key] of keys.entries()) {
    if (runnerLog && key[3] !== undefined && !secretKeyName(key[3])) continue;
    const end = key.index + key[0].length;
    const before = open[key.index];
    if (before > 0 && open[line.length] - open[end] <= -before) continue;
    // Only the last key's value can be blank or masked whole: a later key in it is neither.
    if (n === keys.length - 1) {
      const value = line.slice(end).trim();
      if (value === "" || MASKED.test(value)) continue;
    }
    NONBLANK.lastIndex = end;
    if (/^[{[|>"']/.test(NONBLANK.exec(line)?.[0] ?? "")) continue;
    return true;
  }
  return false;
}

/**
 * A log for the model, line by line: the redactor's log mode, and any line it changed dropped whole (`[redacted]`)
 * with the LOG_HOLD_LINES after it, so a value of several words never leaves half-redacted. The rest of the log is
 * dropped once the redactor opens a secret that runs over lines (a block value, a private key), or once it changes a
 * line where a secret key has a plain value (`password: correct horse`), which YAML lets go on over later lines:
 * interleaved output can hide where such a value ends, so no guess is made. A value that ends on its line (GitHub's
 * `***`, a quoted string, one inside `{…}` closed on the line) costs only the held lines. A step's header (from the
 * runner's `##[group]Run` to its `##[endgroup]`) is dropped whole: it echoes inputs and environment verbatim. Unlike
 * redact(), a random-looking name (a CI runner's) costs a few lines, not the rest of the log. Each line is read as the
 * redactor shows it (escape sequences and controls out, tabs as spaces), home paths are shortened to ~ as the redactor
 * does, whitespace it trims is not a change, and a line is judged whole before it is cut at its length cap (one past
 * MAX_JUDGED_LINE is dropped). A line that holds a break the
 * redactor splits at is read in its parts too, and dropped if either reading finds anything. A continued line (a
 * backslash carries it on) is dropped whole, and with the rest when it may hold a secret.
 *
 * Text that is not a runner's log (`{ runnerLog: false }`, a memory note) has no step headers, and every secret name
 * is a key there: `pass: first` opens a plain value as `password: first` does.
 * @param {string[]} lines
 * @param {{ runnerLog?: boolean }} [options]
 */
export function redactLog(lines, home = os.homedir(), { runnerLog = true } = {}) {
  /** @type {{ inKey: boolean, secret?: unknown }} */
  const state = { inKey: false };
  const out = [];
  let hold = 0;
  let rest = false;
  /** Inside a step's header, where the runner echoes the step's script, inputs and environment, values verbatim. */
  let header = false;
  /** @type {{ raw: string, line: string }[]} The lines of a continued line read so far. */
  let group = [];
  const drop = (/** @type {number} */ n) => {
    for (let i = 0; i < n; i += 1) out.push("[redacted]");
  };
  const flush = () => {
    if (!group.length) return;
    const parts = group;
    group = [];
    if (rest) return drop(parts.length);
    if (parts.length > 1) {
      // A continued line: dropped whole, and with the rest when it may hold a secret.
      drop(parts.length);
      hold = LOG_HOLD_LINES;
      if (mayHoldSecret(parts.map((p) => p.line), home) || parts.some((p) => breaksHide(p.raw, home))) rest = true;
      return;
    }
    const [{ raw, line }] = parts;
    // Judged on the redactor's output unclipped, and clipped only after: a clip can take a secret away with its
    // marker, and the line would pass as unchanged. A line too long to read whole is dropped as changed.
    const whole = line.length <= MAX_JUDGED_LINE;
    const [one, ...more] = redactLines([line], state, home, { rest: false, max: whole ? Infinity : MAX_LOG_LINE });
    const same = whole && typeof one === "string" && squash(one) === squash(line);
    if (!breaksHide(raw, home) && more.length === 0 && same) {
      out.push(hold > 0 ? "[redacted]" : clipUnits(line, MAX_LOG_LINE));
      hold = Math.max(0, hold - 1);
    } else {
      out.push("[redacted]");
      hold = LOG_HOLD_LINES;
      // A break can hide where a secret's state opens (`password:\rfirst`, `prefix\r--password '`): the rest goes.
      // In every reading: a look-alike or invisible character in the key (`ｐassword:`) opens the value as well.
      if (readings(line).flatMap(keyReadings).some((one) => opensPlainValue(one, runnerLog)) || breaksHide(raw, home)) rest = true;
    }
    const forms = Object.values(state.forms ?? {}).flatMap((form) => [form, ...(form.alts ?? [])]);
    if ([state, ...(state.alts ?? []), ...forms].some((one) => one.secret || one.inKey)) rest = true;
  };
  for (const given of lines) {
    // A line's own CRLF ending is not a break inside it.
    const raw = String(given).replace(/\r$/, "");
    let line = shown(raw);
    // A step header starts on a line, or on any part of it the redactor splits a line into, in any reading: an
    // invisible character before it hides none. Only the written line closes one.
    const lead = plain(line);
    const starts = (/** @type {string} */ mark) => lead.startsWith(mark) || raw.split(INNER_BREAK).some((p) => plain(shown(p)).startsWith(mark));
    // A header opened after a break inside the row, which the runner never writes (it writes a header on its own
    // line), inside a header or out of one: the row, and what it may have cut off before it, cannot be read safely,
    // so the rest goes.
    if (runnerLog && !lead.startsWith("##[group]Run ") && starts("##[group]Run ")) {
      flush();
      out.push("[redacted]");
      rest = true;
      header = true;
      continue;
    }
    if (header) {
      // Dropped whole, unread: nothing in it is the step's output, and a value there can run over any lines. Its
      // closing line is read as any other.
      header = !line.startsWith("##[endgroup]");
      if (header) {
        flush();
        out.push("[redacted]");
        continue;
      }
    }
    if (runnerLog && lead.startsWith("##[group]Run ")) header = true;
    line = home && home !== "/" ? line.split(home).join("~") : line;
    group.push({ raw, line: shortenHome(line) });
    if (!line.endsWith("\\")) flush();
  }
  flush();
  return out.join("\n");
}

/**
 * One line of model text, safe to show: control characters out, whitespace collapsed, redacted again, at most `max`
 * characters. Empty when nothing is left.
 * @param {unknown} value
 * @param {number} max
 */
export function oneLine(value, max) {
  if (typeof value !== "string") return "";
  // Redacted in both readings before the fold: each line as written (a join can take away a word boundary, as in
  // `prefix\` over `Basic …`), then with continued lines joined (`pass\` over `word=…`). A fold first would split a key
  // or token at a line break, and the redactor would see neither whole.
  const each = redact(value.split(/\r\n|[\r\n\v\f\x85\u2028\u2029]/));
  const joined = redact(each.replace(/\\\n/g, "").split("\n"));
  const folded = joined.split("\n").map(shown).join(" ").replace(/\s+/g, " ").trim();
  // Once more on the one line: the fold can put a scheme beside its value (`Basic` over `<b64>`).
  const clean = redact(folded).replace(/\s+/g, " ").trim();
  const cps = Array.from(clean);
  return cps.length > max ? `${cps.slice(0, max - 1).join("").trimEnd()}…` : clean;
}

/**
 * A job's spend for today in the configured time zone, kept in SPEND_DIR/<job>.json with the last month's daily totals.
 * `charge` adds one call's cost; `check` throws CeilingReached once today's total is at the ceiling. The first time
 * today's total reaches it, that is logged. A spend file that cannot be read back, or whose today is not a plain
 * total, counts as at the ceiling for today: a broken file stops the job rather than freeing its budget. A dry run's
 * calls are real spend, so they are kept too.
 */
export class Spend {
  /**
   * @param {string} job
   * @param {number} ceilingUsd
   * @param {{ dir?: string, now?: () => Date, log?: (event: string, fields?: Record<string, unknown>) => void }} [opts]
   */
  constructor(job, ceilingUsd, { dir = SPEND_DIR, now = () => new Date(), log = () => {} } = {}) {
    this.job = job;
    this.ceilingUsd = ceilingUsd;
    this.file = path.join(dir, `${job}.json`);
    this.now = now;
    this.log = log;
    this.state = this.#load();
  }

  #load() {
    const today = zoneDay(this.now());
    let state = null;
    let exists = true;
    try {
      state = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (err) {
      exists = /** @type {any} */ (err)?.code !== "ENOENT";
    }
    const days = state && typeof state.days === "object" && state.days && !Array.isArray(state.days) ? state.days : {};
    const broken = exists && days !== state?.days;
    const kept = days[today];
    const valid = kept === undefined || (kept && Number.isFinite(kept.usd) && kept.usd >= 0 && Number.isInteger(kept.calls) && kept.calls >= 0);
    if (broken || !valid) {
      this.log("reader-spend-unreadable", { job: this.job, file: path.basename(this.file) });
      return { days: { [today]: { usd: this.ceilingUsd, calls: 0, unreadable: true } }, today };
    }
    return { days: { ...days, [today]: kept ?? { usd: 0, calls: 0 } }, today };
  }

  get today() {
    return this.state.days[this.state.today];
  }

  /** Throws CeilingReached when today's spend is at the ceiling. */
  check() {
    if (zoneDay(this.now()) !== this.state.today) this.state = this.#load();
    if (this.#stopIfAtCeiling()) throw new CeilingReached(`${this.job} reached its $${this.ceilingUsd} ceiling for ${this.state.today}`);
  }

  /** @param {number} usd */
  charge(usd) {
    const day = this.today;
    day.usd = Math.round((day.usd + (Number.isFinite(usd) && usd > 0 ? usd : 0)) * 1e7) / 1e7;
    day.calls += 1;
    this.#stopIfAtCeiling();
  }

  /** True at the ceiling; the first time today, records and logs the stop. */
  #stopIfAtCeiling() {
    const day = this.today;
    if (day.usd < this.ceilingUsd) return false;
    if (!day.stoppedAt) {
      day.stoppedAt = this.now().toISOString();
      this.save();
      this.log("reader-ceiling", { job: this.job, usd: day.usd.toFixed(4), ceiling: this.ceilingUsd, calls: day.calls });
    }
    return true;
  }

  /** True once today's spend is at the ceiling, without throwing. */
  get capped() {
    if (zoneDay(this.now()) !== this.state.today) this.state = this.#load();
    return this.#stopIfAtCeiling();
  }

  save() {
    const keep = Object.keys(this.state.days).sort().slice(-HISTORY_DAYS);
    const days = Object.fromEntries(keep.map((day) => [day, this.state.days[day]]));
    writeJsonAtomic(this.file, { job: this.job, model: READER_MODEL, ceilingUsd: this.ceilingUsd, days });
  }
}

/** Requests one CLI call may make: the first, and up to three recoveries after an answer reaches the output cap. */
const CLI_REQUESTS_PER_CALL = 4;

/**
 * A failed call's cost: its usage when the CLI printed it before failing, otherwise an upper bound. Each of the call's
 * requests is counted at a token per prompt byte (no token is shorter), the system prompt and CLI overhead, the output
 * of the requests before it, and a full capped answer (READER_MAX_OUTPUT_TOKENS, which every reader run sets). A run of
 * failures so reaches the ceiling no later than the same calls would have.
 * @param {unknown} err @param {string} input
 */
export function failedCallUsd(err, input) {
  const stdout = /** @type {any} */ (err)?.stdout;
  try {
    const usage = typeof stdout === "string" && stdout ? JSON.parse(stdout)?.usage : null;
    if (usage && typeof usage === "object") return usageCost(READER_MODEL, usage);
  } catch {
    // No usable usage: estimate below.
  }
  const prompt = Buffer.byteLength(input, "utf8") + 8000 + (CLI_REQUESTS_PER_CALL - 1) * READER_MAX_OUTPUT_TOKENS;
  return CLI_REQUESTS_PER_CALL * usageCost(READER_MODEL, { input_tokens: prompt, output_tokens: READER_MAX_OUTPUT_TOKENS });
}

/**
 * Asks the model once: checks the ceiling, runs the CLI, charges the cost (an error answer or a failed run is charged
 * too), and returns the parsed answer's object.
 * @param {{ run: (input: string) => Promise<string>, spend: Spend, input: string }} deps
 */
export async function ask({ run, spend, input }) {
  spend.check();
  let stdout;
  try {
    stdout = await run(input);
  } catch (err) {
    spend.charge(failedCallUsd(err, input));
    spend.save();
    throw new CliError(err instanceof Error ? err.message.slice(0, 120) : "claude failed");
  }
  try {
    const { answer, usd } = parseCliOutput(stdout);
    spend.charge(usd);
    return answer;
  } catch (err) {
    spend.charge(/** @type {any} */ (err).usd ?? 0);
    throw err;
  } finally {
    spend.save();
  }
}

/**
 * Writes JSON through a fresh temporary file (created exclusively, so a planted link is never followed) renamed over
 * the target, which replaces a link rather than writing through it.
 * @param {string} file @param {unknown} value
 */
export function writeJsonAtomic(file, value) {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Writes text the same way as writeJsonAtomic.
 * @param {string} file @param {string} text
 */
export function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Appends JSON lines, refusing to write through a symbolic or hard link at `file`.
 * @param {string} file @param {unknown[]} rows
 */
export function appendJsonl(file, rows) {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new Error(`${path.basename(file)} is not a plain file of its own`);
    fs.writeSync(fd, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Runs scripts/rivet.mjs and returns what it printed. makeExec keeps tokens from every child, so the board token is handed
 * to this child alone.
 * @param {(file: string, args: string[], opts: any) => Promise<{ stdout: string }>} exec
 * @returns {(args: string[], input?: string) => Promise<string>}
 */
export function makeRivetCli(exec) {
  const cli = fileURLToPath(new URL("../scripts/rivet.mjs", import.meta.url));
  const token = process.env.RIVET_BOARD_TOKEN;
  return async (args, input) => (await exec(process.execPath, [cli, ...args], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, ...(input === undefined ? {} : { input }), ...(token ? { env: { RIVET_BOARD_TOKEN: token } } : {}) })).stdout;
}

/**
 * The readers' own clone of `repo`, made on first use through the user's `gh` login: no working tree, and no file
 * contents until read. macOS keeps launchd jobs out of ~/Documents, so a checkout there could not serve.
 * @param {string} repo owner/name @param {(args: string[]) => Promise<unknown>} gh
 * @returns {Promise<string>} the clone's folder
 */
export async function readerClone(repo, gh) {
  const dir = path.join(READERS_DIR, "clones", ...repo.split("/"));
  if (!fs.existsSync(path.join(dir, ".git"))) await gh(["repo", "clone", repo, dir, "--", "--quiet", "--no-checkout", "--single-branch", "--filter=blob:none"]);
  return dir;
}

/**
 * Takes the job's run lock, so a manual run and the scheduled one never overlap (their spend and state writes would
 * lose each other's). Returns a release function, or null while another live process holds it.
 * @param {string} job @param {{ dir?: string }} [opts]
 * @returns {(() => void) | null}
 */
export function takeLock(job, { dir = SPEND_DIR } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${job}.lock`);
  const mine = `${process.pid}:${randomBytes(6).toString("hex")}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      createLock(file, mine);
      // Released only while the file is still this run's, never a lock another run took over.
      return () => {
        if (readOr(file) === mine) fs.rmSync(file, { force: true });
      };
    } catch (err) {
      if (/** @type {any} */ (err)?.code !== "EEXIST") throw err;
      let held;
      try {
        held = fs.readFileSync(file, "utf8");
      } catch (readErr) {
        if (/** @type {any} */ (readErr)?.code === "ENOENT") continue;
        throw readErr;
      }
      if (!abandoned(file, held)) return null;
      if (!breakDeadLock(file, held, mine)) return null;
    }
  }
  return null;
}

/**
 * Removes a dead holder's lock, one run at a time: two runs that both saw it dead would otherwise each remove the
 * other's replacement. Under the break guard the lock goes only if it still holds the dead holder's text (a lock's
 * text is unique to its run). A run that died mid-break leaves its guard, cleared by a later run once it is abandoned
 * and still the same guard.
 * @param {string} file @param {string} held @param {string} mine
 */
function breakDeadLock(file, held, mine) {
  const guard = `${file}.break`;
  try {
    createLock(guard, mine);
  } catch (err) {
    if (/** @type {any} */ (err)?.code !== "EEXIST") throw err;
    const text = readOr(guard);
    if (ageMs(guard) > STALE_LOCK_MS && abandoned(guard, text) && readOr(guard) === text) fs.rmSync(guard, { force: true });
    return false;
  }
  try {
    if (readOr(file) !== held) return false;
    fs.rmSync(file, { force: true });
    return true;
  } finally {
    if (readOr(guard) === mine) fs.rmSync(guard, { force: true });
  }
}

const STALE_LOCK_MS = 60_000;

/**
 * Creates a lock file whole or not at all: written to a temp file, then linked into place (EEXIST when one is there).
 * A fresh lock is never empty, so an empty one is always a broken one.
 * @param {string} file @param {string} text
 */
function createLock(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Whether a lock or guard's run is gone: its pid is dead (or this process's own, left by an earlier run), or it names
 * no pid and is over a minute old (a broken file: createLock never leaves one empty).
 * @param {string} file @param {string} text
 */
function abandoned(file, text) {
  const pid = Number.parseInt(text, 10);
  if (Number.isInteger(pid) && pid > 0) return pid === process.pid || !alive(pid);
  return ageMs(file) > STALE_LOCK_MS;
}

/** @param {string} file */
function ageMs(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** @param {string} file */
function readOr(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {any} */ (err)?.code === "EPERM";
  }
}

/** @param {string} file @param {any} fallback */
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Runs `fn` over `items` with at most `limit` at once, in order of start.
 * @template T, R
 * @param {T[]} items @param {number} limit @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const EVIDENCE_HEAD_RE = /^\s*reviewed\s+head\s*:\s*`?([0-9a-f]{40})`?\s*$/gim;

/**
 * When the first self-review evidence for any of `heads` was posted, or null.
 * @param {any[]} comments @param {string[]} heads
 */
export function evidenceAt(comments, heads) {
  const want = new Set(heads.map((h) => h.toLowerCase()));
  let at = null;
  for (const c of comments) {
    if (typeof c?.body !== "string") continue;
    const hit = [...c.body.matchAll(EVIDENCE_HEAD_RE)].some((m) => want.has(m[1].toLowerCase()));
    const when = String(c.created_at ?? "");
    if (hit && (at === null || when < at)) at = when;
  }
  return at;
}

/**
 * Posts or edits the PR's one triage comment, only while the PR is open at the triaged head and neither that head nor
 * the PR's current one has self-review evidence: anything after the evidence blocks the merge gate. Whenever evidence
 * is found, this job's comments written at or after it are deleted, so a withdrawal that failed is retried next poll.
 * With nothing to say (`body` null), every comment of this job's on the PR is deleted, whatever the PR's state.
 * A comment never reads as a merge hold (`readMergeHolds` reads every PR comment, code spans included): a line with hold
 * wording, quoted from a diff, a log or an answer, is left out, and a body that still reads as one is not written.
 * @param {{ gh: (args: string[], input?: string) => Promise<string>, repo: string, pr: number, head: string, body: string | null, marker: string, job: string, log: (event: string, fields?: Record<string, unknown>) => void }} c
 */
export async function upsertMarkedComment({ gh, repo, pr, head, body: wanted, marker, job, log }) {
  let body = wanted;
  if (body) {
    const lines = body.split("\n");
    const kept = lines.filter((l) => holdLines([l]) === null).join("\n");
    if (kept !== body) log(`${job}-comment-hold-wording`, { pr, lines: lines.length - kept.split("\n").length });
    body = holdLines([kept]) === null ? kept : null;
  }
  const list = async () => JSON.parse(await gh(["api", "--paginate", "--slurp", `repos/${repo}/issues/${pr}/comments?per_page=100`])).flat();
  const read = async () => JSON.parse(await gh(["api", `repos/${repo}/pulls/${pr}`]));
  const login = JSON.parse(await gh(["api", "user"]))?.login;
  /** @param {any[]} cs */
  const ours = (cs) => cs.filter((c) => c?.user?.login === login && typeof c.body === "string" && c.body.startsWith(marker));
  /** Deletes ours written at or after evidence: how many, or null with no evidence. @param {any[]} cs @param {string[]} heads */
  const clear = async (cs, heads) => {
    const at = evidenceAt(cs, heads);
    if (at === null) return null;
    let deleted = 0;
    for (const c of ours(cs)) {
      if (String(c.updated_at ?? c.created_at ?? "") < at) continue;
      await gh(["api", "-X", "DELETE", `repos/${repo}/issues/comments/${c.id}`]);
      deleted++;
    }
    return deleted;
  };

  let comments = await list();
  // Nothing left to say (a re-run passed, flaky triage has it, or the item expired): ours go, open PR or not, before
  // evidence or after. A deletion adds no activity.
  if (!body) {
    const old = ours(comments);
    for (const c of old) await gh(["api", "-X", "DELETE", `repos/${repo}/issues/comments/${c.id}`]);
    return old.length ? "deleted" : "none";
  }
  let current = await read();
  const deleted = await clear(comments, [head, String(current?.head?.sha ?? "")]);
  if (deleted !== null) {
    log(`${job}-comment-skipped`, { pr, reason: "evidence-posted" });
    return deleted ? "withdrawn" : "skipped";
  }
  if (current?.state !== "open" || current?.head?.sha !== head) return "stale";
  const mine = ours(comments)[0];
  if (mine?.body === body) return "same";
  // The body goes on stdin, never in gh's arguments (rivet/bridge/lib/config.mjs Exec).
  const input = JSON.stringify({ body });
  if (mine) await gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${mine.id}`, "--input", "-"], input);
  else await gh(["api", "-X", "POST", `repos/${repo}/issues/${pr}/comments`, "--input", "-"], input);
  comments = await list();
  current = await read();
  if ((await clear(comments, [head, String(current?.head?.sha ?? "")])) !== null) {
    log(`${job}-comment-withdrawn`, { pr, reason: "evidence-posted" });
    return "withdrawn";
  }
  return mine ? "edited" : "posted";
}

/**
 * Model text made safe to show on GitHub: no mentions, issue references or markup.
 * @param {string} text
 */
export function plainText(text) {
  // Markup between two letters is a space: taken out, it joins them into a word the redactor never read (`pa<ss>word`).
  const shown = text
    .replace(/@/g, "(at)")
    .replace(/(?<=[\p{L}\p{N}])(?:[<>`*_[\]|]|~(?!\/))+(?=[\p{L}\p{N}])/gu, " ")
    .replace(/[<>`*_[\]|]|~(?!\/)/g, "")
    .replace(/#(?=\d)/g, "no. ")
    .trim();
  // Redacted once more: taking markup out can still make a label (`api<->key=` reads `api-key=`).
  return redact(shown).replace(/\s+/g, " ").trim();
}
