// One holder at a time through a lock dir that holds one file, named by its holder's token (`<pid>-<uuid>`), so no two
// reclaimers that both judged a lock stale can each take it.
//
// A lock is taken by mkdir, then the holder's file, then a look that the file is the dir's only entry. mkdir never
// replaces anything, so a dir another copy made (an old copy's empty dir included) is never taken over. A holder is
// judged by its own file, never by the dir's stat: a reclaimer that paused cannot judge a new holder by the old one's
// age. A stale holder's file is unlinked by its name, which only that holder ever writes, and the dir is then removed
// only while it is empty. An empty dir (a take or a release killed midway, or an old copy's lock) is busy until the
// dir itself is stale. Nothing ever moves, restores or recursively removes a lock.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const HOLDER_RE = /^(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The one file an older lock named its holder in: "owner" (`<pid>-<uuid>`) or "pid".
const LEGACY_FILES = new Set(["owner", "pid"]);
const BUSY = new Set(["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR", "ENOENT"]);

/** True while `pid` runs (or runs as another user). */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Removes `dir` only while it is empty; false when it is gone or another holder's lock now holds it. */
function removeIfEmpty(dir) {
  try {
    fs.rmdirSync(dir);
    return true;
  } catch (error) {
    if (["ENOTEMPTY", "EEXIST", "ENOENT", "ENOTDIR"].includes(error?.code)) return false;
    throw error;
  }
}

/** A legacy holder file's pid: read without waiting and only as a plain file, so a FIFO or a link there never blocks. */
function legacyPid(file) {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const text = fs.fstatSync(fd).isFile() ? fs.readFileSync(fd, "utf8").slice(0, 200) : "";
      const m = /^(\d+)(?:$|[-\s])/.exec(text.trim());
      return m ? Number(m[1]) : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** The holder `name` names: its pid, from a token name or a legacy file's text. */
function holderPid(lock, name) {
  const m = HOLDER_RE.exec(name);
  if (m) return Number(m[1]);
  return LEGACY_FILES.has(name) ? legacyPid(path.join(lock, name)) : null;
}

/**
 * Removes one stale holder file. A token name is only ever written by its own holder, so it is unlinked by name. A
 * legacy name ("owner", "pid") is reused by every old holder, so the file is first moved aside inside the lock and
 * unlinked only if it is the very file judged (same inode and mtime); another holder's is put back. False when
 * another reclaimer took it first.
 */
function removeHolder(lock, name, judged) {
  const file = path.join(lock, name);
  if (HOLDER_RE.test(name)) {
    try {
      fs.unlinkSync(file);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
  const aside = path.join(lock, `.reclaim-${process.pid}-${randomUUID()}`);
  try {
    fs.renameSync(file, aside);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const moved = fs.lstatSync(aside);
  if (moved.ino === judged.ino && moved.mtimeMs === judged.mtimeMs) {
    fs.unlinkSync(aside);
    return true;
  }
  fs.renameSync(aside, file);
  return false;
}

/**
 * Frees `lock` when `stale({ pid, ageMs })` says every holder file in it is gone: `pid` is the file's holder (null
 * when it names none), `ageMs` the file's own age at `now`. An empty dir is judged by its own age with a null pid.
 * True only when this call freed it; a lock another reclaimer freed first, or one a new holder took meanwhile, is left
 * as it is. A plain file at the path (a lock from before the dir shape) is judged the same way and unlinked only if it
 * is still the file judged.
 */
export function reclaim(lock, stale, now = Date.now()) {
  let st;
  try {
    st = fs.lstatSync(lock);
  } catch {
    return false;
  }
  if (st.isFile()) {
    if (!stale({ pid: legacyPid(lock), ageMs: now - st.mtimeMs })) return false;
    try {
      const again = fs.lstatSync(lock);
      if (again.ino !== st.ino || again.mtimeMs !== st.mtimeMs) return false;
      fs.unlinkSync(lock);
      return true;
    } catch {
      return false;
    }
  }
  if (!st.isDirectory()) return false;
  const names = fs.readdirSync(lock);
  if (!names.length) {
    // A dir with no holder file: removed only once the dir itself is stale, judged by its stat from after it was seen
    // empty (the stat above may be a dir freed and remade since), and only while it is still empty.
    let seen;
    try {
      seen = fs.lstatSync(lock);
    } catch {
      return false;
    }
    if (!seen.isDirectory() || seen.ino !== st.ino) return false;
    return stale({ pid: null, ageMs: now - seen.mtimeMs }) && removeIfEmpty(lock);
  }
  const judged = [];
  for (const name of names) {
    let fst;
    try {
      fst = fs.lstatSync(path.join(lock, name));
    } catch (error) {
      // Another reclaimer or the holder's release took it first.
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    // A dir inside is never removed, so nothing past the lock is reached.
    if (!fst.isFile()) throw new Error(`token-lock: ${path.join(lock, name)} is not a holder file`);
    if (!stale({ pid: holderPid(lock, name), ageMs: now - fst.mtimeMs })) return false;
    judged.push([name, fst]);
  }
  for (const [name, fst] of judged) if (!removeHolder(lock, name, fst)) return false;
  return removeIfEmpty(lock);
}

/**
 * One try at `lock`, never waiting: a handle while this process now holds it, else null. `mine()` says whether the
 * lock still holds this holder's file and nothing else; `touch()` marks the holder as still alive; `release()`
 * removes only this holder's file, then the dir while empty.
 */
export function tryLock(lock) {
  const token = `${process.pid}-${randomUUID()}`;
  const file = path.join(lock, token);
  try {
    fs.mkdirSync(lock);
    // ENOENT: the dir was removed as an empty stale one before the file went in.
    fs.writeFileSync(file, "", { flag: "wx" });
  } catch (error) {
    if (BUSY.has(error?.code)) return null;
    throw error;
  }
  const mine = () => {
    try {
      const names = fs.readdirSync(lock);
      return names.length === 1 && names[0] === token;
    } catch {
      return false;
    }
  };
  const release = () => {
    fs.rmSync(file, { force: true });
    try {
      removeIfEmpty(lock);
    } catch {}
  };
  // Another take that wrote into the same dir: both back off, and the last one out removes the dir.
  if (!mine()) {
    release();
    return null;
  }
  return {
    token,
    mine,
    release,
    touch(at = new Date()) {
      try {
        fs.utimesSync(file, at, at);
      } catch {}
    },
  };
}
/** Takes `lock` now, or frees it when `stale` says so and takes it then; null while another holder keeps it. */
export function takeLock(lock, stale, now = Date.now()) {
  const got = tryLock(lock);
  if (got) return got;
  try {
    reclaim(lock, stale, now);
  } catch {}
  return tryLock(lock);
}
