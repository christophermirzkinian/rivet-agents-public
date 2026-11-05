#!/usr/bin/env node
//
// GitHub out of budget or out of reach: a scheduled job whose
// gh, git or HTTP call failed this way logs the run as skipped and exits 0,
// since the next run retries. A failure counts only when the call itself
// failed (a child's stderr, its timeout, or GitHub's HTTP answer), never an
// error built from local data, even one that quotes "rate limit".
//
// Out of budget or reach is a rate limit or 429, a 5xx, a connection, DNS, TLS or SSH
// connect failure, a reset or early EOF, or another fetch moving a ref under
// this one (`cannot lock ref '…': is at X but expected Y`). A lock git could
// not take for any other reason stays a failure. Every phrase holds a space,
// which a ref name git quotes back cannot. The phrases are a POSIX ERE so a
// shell script (grep -E) can match the same list.
//
// Skips stay green for TRANSIENT_GRACE_MS from the first in a row (a spent
// budget hour resets inside it), so a fault that only looks passing still
// turns red. A job keeps the start of its run in a streak file and removes the
// file once its GitHub calls succeed.
//
// CLI, for shell jobs (the failed child's stderr on stdin):
//   node scripts/transient-github.mjs classify
//       exit 0 when the text is GitHub's passing trouble, else 1.
//   node scripts/transient-github.mjs skip <streak file> [--transient]
//       exit 0 and print the reason: skip this run. Exit 1: not transient, fail
//       as before. Exit 2 and print why: transient for TRANSIENT_GRACE_MS or
//       more, or the streak could not be saved. --transient: the caller
//       already knows (its own timeout stopped the call).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isMain } from "./is-main.mjs";

export const TRANSIENT_ERE =
  "rate limit|HTTP (429|5[0-9][0-9])|returned error: (429|5[0-9][0-9])|error connecting to|Failed to connect to|Empty reply from server|i/o timeout|TLS handshake timeout|connection reset|Could not resolve host|unexpected EOF|early EOF|remote end hung up unexpectedly|HTTP/2 stream [0-9]+ (reset|was not closed cleanly)|cannot lock ref '[^']*': is at [0-9a-f]+ but expected [0-9a-f]+|connect to host|Connection timed out|Connection closed by remote host";
// bash's own parse error, not gh's.
export const NOT_TRANSIENT_ERE = "unexpected EOF while";
const TRANSIENT = new RegExp(TRANSIENT_ERE, "i");
const NOT_TRANSIENT = new RegExp(NOT_TRANSIENT_ERE, "i");
export const TRANSIENT_GRACE_MS = 60 * 60_000;

/** Whether a line of the text names a passing GitHub condition (grep -iE, line by line). */
export function isTransientText(text) {
  return String(text ?? "").split("\n").some((line) => TRANSIENT.test(line) && !NOT_TRANSIENT.test(line));
}

/** A child's stderr when it wrote any (a Buffer without `encoding`), else the error's message. */
export function whyOf(err) {
  return String(err?.stderr ?? "").trim() || String(err?.message || err).trim();
}

/**
 * Whether a gh or git run failed on a passing GitHub condition. Only a child
 * run counts (execFileSync's error or spawnSync's result, both carry its
 * `output`), so an error raised over local data never does. A run stopped by
 * its timeout is known by its code, whatever it printed first.
 */
export function isTransient(err) {
  return typeof err === "object" && err !== null && "output" in err && ((err.code ?? err.error?.code) === "ETIMEDOUT" || isTransientText(whyOf(err)));
}

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_CLOSED"]);

/** Whether fetch() rejected because the network failed or its AbortSignal.timeout fired. */
export function isTransientFetchError(err) {
  return err?.name === "TimeoutError" || (err?.name === "TypeError" && NETWORK_CODES.has(err.cause?.code));
}

/** Whether GitHub's HTTP answer is passing: a 5xx, a 429, or a 403 for a spent primary or secondary rate limit. */
export function isTransientResponse({ status, headers, body = "" }) {
  if (status >= 500 || status === 429) return true;
  return status === 403 && (headers?.get("x-ratelimit-remaining") === "0" || headers?.has("retry-after") || /rate limit/i.test(body));
}

/** A transient failure at `now`: the state that remembers when the run of them began, and whether it is still a skip. */
export function transientTick(state, now) {
  // A clock set back starts the run again rather than holding it green.
  const since = Math.min(state.transientSince ?? now, now);
  return { state: { ...state, transientSince: since }, skip: now - since < TRANSIENT_GRACE_MS, minutes: Math.round((now - since) / 60_000) };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

/**
 * Records a transient failure at `now` in the JSON file at `path`, keeping its
 * other keys. A missing file starts the run; a file that is there but cannot
 * be read throws and is left as it is, as does a save that fails.
 */
export function transientStreak(path, now) {
  let prev = {};
  try {
    prev = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  const t = transientTick(prev, now);
  writeJson(path, t.state);
  return t;
}

/** The job's GitHub calls succeeded: the run of skips is over. */
export function endTransientStreak(path) {
  rmSync(path, { force: true });
}

/** The line of a failed run's stderr that names the trouble, else its first, for a log ("timed out" when it printed nothing). */
export function reasonOf(text) {
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  return (lines.find((line) => isTransientText(line)) ?? lines[0] ?? "timed out").slice(0, 300);
}

export function main(argv, stdin, now = Date.now()) {
  const [command, path, ...flags] = argv;
  if (command === "classify") return { code: isTransientText(stdin) ? 0 : 1, out: "" };
  if (command !== "skip" || !path) return { code: 64, out: "usage: transient-github.mjs classify | skip <streak file> [--transient] < stderr" };
  if (!flags.includes("--transient") && !isTransientText(stdin)) return { code: 1, out: "" };
  const why = reasonOf(stdin);
  let t;
  try {
    t = transientStreak(path, now);
  } catch (err) {
    return { code: 2, out: `${why}; streak not saved: ${String(err?.message ?? err).slice(0, 150)}` };
  }
  return t.skip ? { code: 0, out: why } : { code: 2, out: `transient for ${t.minutes} min: ${why}` };
}

if (isMain(import.meta.url)) {
  const { code, out } = main(process.argv.slice(2), readFileSync(0, "utf8"));
  if (out) console.log(out);
  process.exitCode = code;
}
