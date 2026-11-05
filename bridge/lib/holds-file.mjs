import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { sanitizeLine } from "./templates.mjs";

// Holds kept beside the PRs, a JSON array of { pr, reason, until? }: an entry holds that
// PR's merge. A missing file holds nothing; one that is there but unreadable or malformed
// holds every merge (fails closed).

export const HOLDS_FILE = path.join(homedir(), ".rivet-agents", "holds.json");

/** @param {unknown} entry */
function wellFormed(entry) {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const e = /** @type {Record<string, unknown>} */ (entry);
  if (typeof e.reason !== "string") return false;
  if (!(Number.isSafeInteger(e.pr) && /** @type {number} */ (e.pr) > 0)) return false;
  return e.until === undefined || (typeof e.until === "string" && Number.isFinite(Date.parse(e.until)));
}

/**
 * The holds file for a writer: its text (null when there is none) and its entries.
 * Throws when it cannot be read, is not JSON or has a malformed entry, so a writer
 * never replaces what it could not read.
 * @param {string} [file]
 * @returns {{ text: string | null, holds: Record<string, unknown>[] }}
 */
export function readHolds(file = HOLDS_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return { text: null, holds: [] };
    throw err;
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON; fix it by hand`);
  }
  if (!Array.isArray(doc) || !doc.every(wellFormed)) throw new Error(`${file} is malformed; fix it by hand`);
  return { text, holds: doc };
}

/**
 * Replaces the holds file in one rename from a synced temp file beside it, so a
 * reader sees the old file or the new one, never half of one. Refused when the
 * file no longer has the text `was` (null: there was none), so a write between
 * the read and this one is not lost.
 * @param {unknown[]} holds @param {string | null} was @param {string} [file]
 */
export function writeHolds(holds, was, file = HOLDS_FILE) {
  // A list a reader would refuse is never written: it would hold every merge until fixed by hand.
  // The text that would be written is what is checked, so inherited keys or a toJSON cannot slip past; its
  // objects are rebuilt with no prototype, so a key on Object.prototype cannot stand in for a missing one.
  const text = `${JSON.stringify(holds, null, 2)}\n`;
  let doc;
  try {
    doc = JSON.parse(text, (_key, value) =>
      typeof value === "object" && value !== null && !Array.isArray(value) ? Object.assign(Object.create(null), value) : value,
    );
  } catch {
    doc = undefined;
  }
  if (!Array.isArray(doc)) throw new Error(`refusing to write ${file}: the new holds are not a list; nothing written`);
  const bad = doc.findIndex((entry) => !wellFormed(entry));
  if (bad !== -1) throw new Error(`refusing to write ${file}: entry ${bad} is malformed; nothing written`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o644);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    let now = null;
    try {
      now = fs.readFileSync(file, "utf8");
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") throw err;
    }
    if (now !== was) throw new Error(`${file} changed while this ran; nothing written, run it again`);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

const LOCK_WAIT_MS = 10_000;
// O_EXLOCK from darwin's <sys/fcntl.h>; node's fs.constants does not export it.
export const O_EXLOCK = 0x20;

/**
 * Takes `<file>.lock`, waiting up to `waitMs` for a live holder; returns its release. On
 * darwin, where the CLI runs, it is a kernel lock (O_EXLOCK) on a file that is never
 * removed, so the OS frees a dead holder's lock and no takeover step can race. Elsewhere
 * (the tests on Linux) it is an exclusive create with no takeover: a dead holder's file stays
 * until someone removes it, and the refusal names it.
 * @param {string} lock @param {number} waitMs @param {string} platform
 * @returns {() => void}
 */
function takeLock(lock, waitMs, platform) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      if (platform === "darwin") {
        const fd = fs.openSync(lock, fs.constants.O_RDWR | fs.constants.O_CREAT | O_EXLOCK | fs.constants.O_NONBLOCK, 0o644);
        return () => fs.closeSync(fd);
      }
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
      return () => fs.rmSync(lock, { force: true });
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code !== "EEXIST" && code !== "EAGAIN" && code !== "EWOULDBLOCK") throw err;
    }
    if (Date.now() > deadline) throw new Error(`${lock} is held by another writer${platform === "darwin" ? "" : " (or one that died: remove it once none runs)"}; nothing written, run it again`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

/**
 * Changes the holds file under `<file>.lock`, so two writers never both read the same
 * file and the second rename drops the first one's entries. `change` gets the entries
 * and returns the new list, or null to leave the file as it is.
 * @template T
 * @param {(holds: Record<string, unknown>[]) => { holds: unknown[] | null, result: T }} change
 * @param {{ file?: string, waitMs?: number, platform?: string }} [opts]
 * @returns {T}
 */
export function updateHolds(change, { file = HOLDS_FILE, waitMs = LOCK_WAIT_MS, platform = process.platform } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const release = takeLock(`${file}.lock`, waitMs, platform);
  try {
    const { text, holds } = readHolds(file);
    const next = change(holds);
    // Only { holds: [...] | null, result } is a change; anything else (the bare list, undefined, no holds key) writes nothing.
    // Read once: a getter could answer the check one way and the write another.
    const want = typeof next === "object" && next !== null && !Array.isArray(next) && Object.hasOwn(next, "holds") ? next.holds : undefined;
    if (want !== null && !Array.isArray(want)) {
      throw new Error(`refusing to write ${file}: the change did not return { holds: [...] or null, result }; nothing written`);
    }
    if (want !== null) writeHolds(want, text, file);
    return next.result;
  } finally {
    release();
  }
}

/**
 * The holds file's lines that hold `pr`'s merge, for the confirm sheet and the refusal.
 * @param {number} pr @param {{ file?: string, now?: number }} [opts]
 * @returns {string[]}
 */
export function fileHolds(pr, { file = HOLDS_FILE, now = Date.now() } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return [];
    return [`holds file: cannot be read (${sanitizeLine(/** @type {Error} */ (err).message, 80)}), so nothing merges`];
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return ["holds file: not valid JSON, so nothing merges"];
  }
  if (!Array.isArray(doc) || !doc.every(wellFormed)) return ["holds file: malformed, so nothing merges"];
  return doc
    .filter((entry) => entry.pr === pr && (entry.until === undefined || Date.parse(entry.until) > now))
    // Never cut here: the bridge redacts a hold whole and only then cuts it to the merge preview's 200 UTF-16 units.
    .map((entry) => `holds file: ${entry.reason}${entry.until ? ` (until ${entry.until})` : ""}`);
}
