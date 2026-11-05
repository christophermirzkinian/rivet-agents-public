// Test support: two reclaimers that both judged one lock stale. `withRival` runs `rival()` once, at the
// moment the code under test is about to remove or move `lock` (or a file inside it): after it judged the lock stale,
// before it acted. The rival frees the stale lock and takes it, so the code under test then acts on a fresh lock it
// never judged. A lock that a check-then-remove reclaim frees is then held twice; the token lock is held once.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const REMOVERS = ["rmSync", "unlinkSync", "renameSync", "rmdirSync"];

/** Runs `body()` with the rival armed, restoring node:fs (and its named ESM exports) after; returns body's result. */
export async function withRival(lock, rival, body) {
  const saved = Object.fromEntries(REMOVERS.map((name) => [name, fs[name]]));
  let fired = false;
  const hits = (target) => {
    const p = String(target);
    return p === lock || p.startsWith(`${lock}/`);
  };
  for (const name of REMOVERS) {
    fs[name] = function (target, ...rest) {
      if (!fired && hits(target)) {
        fired = true;
        rival();
      }
      return saved[name].call(this, target, ...rest);
    };
  }
  syncBuiltinESMExports();
  try {
    const result = await body();
    if (!fired) throw new Error(`lock-race: the code under test never removed or moved ${lock}`);
    return result;
  } finally {
    Object.assign(fs, saved);
    syncBuiltinESMExports();
  }
}

/** Sets `path`'s times `ms` into the past, and a lock dir's holder files with it (a holder is judged by its file). */
export function age(path, ms) {
  const at = new Date(Date.now() - ms);
  if (fs.lstatSync(path).isDirectory()) for (const name of fs.readdirSync(path)) fs.utimesSync(`${path}/${name}`, at, at);
  fs.utimesSync(path, at, at);
}
