// The bridge's own log: launchd writes stdout and stderr to ~/.rivet-agents/logs/bridge.log
// (scripts/install-bridge.sh) and nothing rotated it. Past LOG_MAX_BYTES it is copied to `.1`, the one old file kept,
// and cut to nothing in place: launchd appends, so its next line lands at the start. No sudo, no newsyslog.

import { closeSync, constants, fstatSync, ftruncateSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOG_PATH = join(homedir(), ".rivet-agents", "logs", "bridge.log");
export const LOG_MAX_BYTES = 10 * 1024 * 1024;
const CHECK_MS = 10 * 60_000;

/**
 * Rotates `path` when it is past `maxBytes`. True when it rotated; a missing log is false. Neither file is followed
 * through a symlink: the log is held open with O_NOFOLLOW, and `.1` is unlinked and made afresh with O_EXCL.
 */
export function rotateLog(path = LOG_PATH, maxBytes = LOG_MAX_BYTES) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= maxBytes) return false;
    try {
      unlinkSync(`${path}.1`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const old = openSync(`${path}.1`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try {
      const chunk = Buffer.alloc(1024 * 1024);
      for (let at = 0, n; (n = readSync(fd, chunk, 0, chunk.length, at)) > 0; at += n) {
        // A short write is written on from where it stopped; the live log is cut only once all of it is in .1.
        for (let done = 0; done < n; ) done += writeSync(old, chunk, done, n - done);
      }
    } finally {
      closeSync(old);
    }
    ftruncateSync(fd, 0);
    return true;
  } finally {
    closeSync(fd);
  }
}

/**
 * Checks the log now and every ten minutes until `stop`.
 * @param {{ stop: AbortSignal, log: (event: string, fields?: Record<string, unknown>) => void, path?: string }} ctx
 */
export function runLogRotateLoop({ stop, log, path = LOG_PATH }) {
  const check = () => {
    try {
      if (rotateLog(path)) log("log-rotated", { path });
    } catch (error) {
      log("log-rotate-failed", { error: String(error) });
    }
  };
  check();
  const timer = setInterval(check, CHECK_MS);
  timer.unref();
  stop.addEventListener("abort", () => clearInterval(timer), { once: true });
}
