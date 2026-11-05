import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reclaim, takeLock, tryLock } from "../lib/token-lock.mjs";
import { age, withRival } from "../../scripts/lock-race-fixture.mjs";

const HOLDER = ["0c0e0a1b", "2c3d", "4e5f", "8a9b", "0c1d2e3f4a5b"].join("-");

const scratch = () => mkdtempSync(join(tmpdir(), "token-lock-"));
const byAge = (ms) => ({ ageMs }) => ageMs > ms;
const DEAD_PID = 2 ** 22 + 12345;

test("one holder at a time; release frees it, and only its own file goes", () => {
  const dir = scratch();
  const lock = join(dir, "lock");
  const a = tryLock(lock);
  assert.ok(a?.mine());
  assert.equal(tryLock(lock), null);
  a.release();
  assert.deepEqual(readdirSync(dir), []);
  const b = tryLock(lock);
  a.release();
  assert.ok(b.mine(), "a second release by the old holder leaves the new lock");
  b.release();
  rmSync(dir, { recursive: true });
});

test("an empty dir is busy until it is stale, and a fresh lock is never reclaimed", () => {
  const dir = scratch();
  const lock = join(dir, "lock");
  mkdirSync(lock);
  assert.equal(tryLock(lock), null, "an empty dir is a take midway, or an old copy's lock");
  assert.equal(reclaim(lock, byAge(60_000)), false);
  age(lock, 120_000);
  const a = takeLock(lock, byAge(60_000));
  assert.ok(a?.mine(), "a stale empty dir is removed and taken");
  assert.equal(reclaim(lock, byAge(60_000)), false);
  assert.ok(a.mine());
  rmSync(dir, { recursive: true });
});

test("a holder is judged by its own file: a stale dir with a new holder's file in it is kept", () => {
  const dir = scratch();
  const lock = join(dir, "lock");
  const a = tryLock(lock);
  age(lock, 120_000);
  a.release();
  // The old holder let go and a new one took the lock while the dir's stat stayed old.
  const b = tryLock(lock);
  utimesSync(lock, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  assert.equal(reclaim(lock, byAge(60_000)), false);
  assert.ok(b.mine());
  b.touch(new Date(Date.now() - 120_000));
  assert.equal(reclaim(lock, byAge(60_000)), true, "touch() moves the holder's own file");
  rmSync(dir, { recursive: true });
});

test("a take that finds another file beside its own backs off", () => {
  const dir = scratch();
  const lock = join(dir, "lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), "1");
  assert.equal(tryLock(lock), null);
  assert.deepEqual(readdirSync(lock), ["owner"], "only its own file is removed");
  rmSync(dir, { recursive: true });
});

test("a legacy holder file replaced after it was judged is put back, not removed", () => {
  const dir = scratch();
  const lock = join(dir, "lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), String(DEAD_PID));
  age(lock, 120_000);
  let swapped = false;
  const stale = ({ ageMs }) => {
    if (!swapped) {
      swapped = true;
      // An old copy freed the lock and took it again between the judgement and the removal.
      rmSync(join(lock, "owner"));
      writeFileSync(join(lock, "owner"), String(process.pid));
    }
    return ageMs > 60_000;
  };
  assert.equal(reclaim(lock, stale), false);
  assert.deepEqual(readdirSync(lock), ["owner"]);
  rmSync(dir, { recursive: true });
});

test("two reclaimers that both judged a lock stale: the lock is held once", async () => {
  const dir = scratch();
  const lock = join(dir, "lock");
  tryLock(lock);
  age(lock, 120_000);
  let rival = null;
  const late = await withRival(lock, () => (rival = takeLock(lock, byAge(60_000))), () => takeLock(lock, byAge(60_000)));
  assert.ok(rival?.mine(), "the rival freed the stale lock and holds it");
  assert.equal(late, null, "the late reclaimer does not also hold it");
  rmSync(dir, { recursive: true });
});

test("a stale lock is judged by its holder's pid, and the legacy owner and pid files are read", () => {
  const dir = scratch();
  const lock = join(dir, "lock");
  const live = tryLock(lock);
  assert.equal(reclaim(lock, ({ pid }) => pid !== process.pid), false);
  live.release();
  for (const [name, text] of [["owner", `${DEAD_PID}-${HOLDER}`], ["pid", String(DEAD_PID)]]) {
    mkdirSync(lock);
    writeFileSync(join(lock, name), text);
    let seen;
    assert.equal(reclaim(lock, ({ pid }) => ((seen = pid), true)), true);
    assert.equal(seen, DEAD_PID);
    assert.deepEqual(readdirSync(dir), []);
  }
  writeFileSync(lock, `${DEAD_PID} ${HOLDER}`);
  assert.ok(takeLock(lock, ({ pid }) => pid === DEAD_PID)?.mine(), "a plain-file lock from before the dir shape is taken over");
  rmSync(dir, { recursive: true });
});

test("a dir inside a stale lock is never removed", () => {
  const dir = scratch();
  const lock = join(dir, "lock");
  mkdirSync(join(lock, "keep"), { recursive: true });
  age(lock, 120_000);
  assert.throws(() => reclaim(lock, byAge(60_000)));
  assert.deepEqual(readdirSync(lock), ["keep"]);
  rmSync(dir, { recursive: true });
});

test("an empty dir is judged by its stat from after it was seen empty, not one freed and remade meanwhile", () => {
  const dir = scratch();
  const lock = join(dir, "lock");
  mkdirSync(lock);
  age(lock, 120_000);
  // Between this reclaimer's first stat and its readdir, the old dir is freed and an old copy makes a fresh one.
  const real = fs.readdirSync;
  let fired = false;
  fs.readdirSync = (target, ...rest) => {
    if (!fired && String(target) === lock) {
      fired = true;
      fs.rmdirSync(lock);
      fs.mkdirSync(lock);
    }
    return real(target, ...rest);
  };
  try {
    assert.equal(reclaim(lock, byAge(60_000)), false, "the fresh empty dir is busy");
  } finally {
    fs.readdirSync = real;
  }
  assert.ok(fired);
  assert.deepEqual(readdirSync(dir), ["lock"], "and is left in place");
  rmSync(dir, { recursive: true });
});
