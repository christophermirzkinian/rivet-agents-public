import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { count, keptFromLog, readKnobCap, readRunner, report } from "../lib/chat-count.mjs";
import { closePass, decide, HEARTBEAT_FRESH_MS, parseArgs, readHeartbeat, realIo, stance, takeLock, writeAtomic, writeHeartbeat } from "../lib/chats-close.mjs";

const NOW = Date.parse("2026-11-22T10:00:00Z");
const HOUR = 3600_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chats-close-"));
let n = 0;
const scratch = () => path.join(dir, `t${++n}`);
const HAS_MKFIFO = spawnSync("sh", ["-c", "command -v mkfifo"]).status === 0;

/** A finished chat: idle two hours, clean, pushed, no PR. */
const chat = (over = {}) => ({
  path: "/w/done", name: "done", agents: [{ state: "done", updatedAt: NOW - 2 * HOUR }], lastTurnAt: NOW - 2 * HOUR,
  git: { slug: "o/r", head: "abc", branch: "feat", dirty: false, unpushed: false }, signIn: "", shell: "", ...over,
});
const ctx = (over = {}) => ({
  now: NOW, protected: ["mon"], protectedFolder: "keepme", keepList: new Set(["pinned"]), cards: [], boardChats: [], asks: [],
  heldPrs: new Set(), merged: new Map([["o/r", new Set()]]), openPrs: new Map([["o/r", []]]), ...over,
});
const PR = { number: 12, headRefName: "feat", headRefOid: "zzz" };

test("a finished chat closes; an open PR, a waiting card, a hold or an unfinished ask keeps it", () => {
  assert.deepEqual(decide(chat(), ctx()), { verdict: "close", reason: "" });
  assert.deepEqual(decide(chat(), ctx({ openPrs: new Map([["o/r", [PR]]]) })), { verdict: "keep", reason: "open-pr #12" });
  assert.equal(decide(chat(), ctx({ openPrs: new Map([["o/r", [{ ...PR, headRefName: "x", headRefOid: "abc" }]]]) })).reason, "open-pr #12");
  assert.equal(decide(chat(), ctx({ openPrs: new Map([["o/r", [PR]]]), heldPrs: new Set([12]) })).reason, "hold #12");
  assert.equal(decide(chat({ prHeld: true }), ctx({ openPrs: new Map([["o/r", [PR]]]) })).reason, "hold #12");
  assert.equal(decide(chat(), ctx({ cards: [{ id: "c1", kind: "decision", chat: "Done" }] })).reason, "board-card c1");
  assert.equal(decide(chat(), ctx({ cards: [{ id: "c1", kind: "update", chat: "done" }] })).verdict, "close");
  assert.equal(decide(chat(), ctx({ asks: [{ id: "a-1", chat: "done", stage: "queued" }] })).reason, "ask a-1 queued");
  assert.equal(decide(chat(), ctx({ asks: [{ id: "a-1", chat: "other", stage: "queued" }] })).verdict, "close");
  for (const stage of ["done", "parked", "live"]) assert.equal(decide(chat(), ctx({ asks: [{ id: "a-1", chat: "done", stage }] })).verdict, "close", stage);
});

test("every earlier keep rule still holds, in its order", () => {
  const keep = (c, x = {}) => decide(chat(c), ctx(x)).reason;
  assert.equal(keep({ name: "mon" }), "protected");
  assert.equal(keep({ path: "/w/keepme/x" }), "protected");
  assert.equal(keep({ displayName: "Pinned" }), "keep-list");
  assert.equal(keep({ agents: [{ state: "working", updatedAt: null }] }), "active (agent working)");
  assert.equal(keep({ shell: "pnpm test" }), "running-shell (pnpm test)");
  assert.equal(keep({}, { boardChats: [{ name: "done", state: "waiting" }] }), "board-state waiting");
  assert.equal(keep({}, { boardChats: [{ name: "done", state: "working", touchedAt: new Date(NOW - 10 * 60_000).toISOString() }] }), "active (board working 10m ago)");
  assert.equal(keep({ lastTurnAt: NOW - 5 * 60_000 }), "active (last turn 5m ago)");
  assert.equal(keep({ lastTurnAt: null, agents: [] }), "idle-unknown");
  assert.equal(keep({ git: null }), "not-git");
  assert.equal(keep({ git: { ...chat().git, dirty: true } }), "dirty");
  assert.equal(keep({ git: { ...chat().git, unpushed: true } }), "unpushed");
  assert.equal(decide(chat({ git: { ...chat().git, unpushed: true } }), ctx({ merged: new Map([["o/r", new Set(["abc"])]]) })).verdict, "close");
  assert.equal(keep({}, { openPrs: new Map() }), "open-pr-unknown");
  assert.equal(keep({ signIn: "qemu-system" }), "owner-sign-in (qemu-system)");
});

test("the bridge closes only on mode bridge with its switch on; the cron stands aside for a fresh heartbeat", () => {
  const fresh = { by: "bridge", at: new Date(NOW - 60_000).toISOString() };
  const old = { by: "bridge", at: new Date(NOW - 16 * 60_000).toISOString() };
  assert.equal(stance({ from: "bridge", mode: "bridge", rowClose: true, heartbeat: null, now: NOW }), "close");
  assert.equal(stance({ from: "bridge", mode: "bridge", rowClose: false, heartbeat: null, now: NOW }), "list");
  assert.equal(stance({ from: "bridge", mode: "close", rowClose: true, heartbeat: null, now: NOW }), "list");
  assert.equal(stance({ from: "cron", mode: "close", rowClose: false, heartbeat: fresh, now: NOW }), "close");
  assert.equal(stance({ from: "cron", mode: "bridge", rowClose: false, heartbeat: fresh, now: NOW }), "aside");
  assert.equal(stance({ from: "cron", mode: "bridge", rowClose: false, heartbeat: old, now: NOW }), "close");
  assert.equal(stance({ from: "cron", mode: "bridge", rowClose: false, heartbeat: null, now: NOW }), "close");
  assert.equal(stance({ from: "cron", mode: "list", rowClose: false, heartbeat: fresh, now: NOW }), "list");
  assert.ok(16 * 60_000 > HEARTBEAT_FRESH_MS);
  for (const mode of ["close", "bridge"]) assert.equal(stance({ from: "cron", mode, rowClose: false, heartbeat: old, now: NOW, knobsClose: false }), "list", `${mode}: the switch off`);
  assert.equal(stance({ from: "cron", mode: "bridge", rowClose: false, heartbeat: old, now: NOW, knobsClose: true }), "close");
});

// The closer's lock is a darwin kernel lock (O_EXLOCK); CI's Linux runs skip these.
const darwinOnly = { skip: process.platform !== "darwin" && "the kernel lock is darwin-only", timeout: 30_000 };

test("a held lock turns a second closer away until its release; the file stays", darwinOnly, () => {
  const file = scratch();
  const release = takeLock(file);
  assert.ok(release);
  assert.equal(takeLock(file), null);
  assert.equal(fs.readFileSync(file, "utf8"), `${process.pid}\n`);
  release();
  release();
  assert.ok(fs.existsSync(file));
  const again = takeLock(file);
  assert.ok(again);
  again();
});

test("a lock path that is a hard link to another file is refused, and that file is left as it was", darwinOnly, () => {
  const file = scratch();
  const other = scratch();
  fs.writeFileSync(other, '{"keep":true}\n');
  fs.linkSync(other, file);
  assert.equal(takeLock(file), null);
  assert.equal(fs.readFileSync(other, "utf8"), '{"keep":true}\n');
  const folder = scratch();
  fs.mkdirSync(folder);
  assert.throws(() => takeLock(folder));
});

test("a leftover lock file with no holder is taken", darwinOnly, () => {
  const file = scratch();
  fs.writeFileSync(file, JSON.stringify({ pid: 101, at: new Date(NOW).toISOString() }));
  const release = takeLock(file);
  assert.ok(release);
  assert.equal(fs.readFileSync(file, "utf8"), `${process.pid}\n`);
  release();
});

test("a closer killed with SIGKILL while it holds the lock frees it for the next", darwinOnly, async (t) => {
  const file = scratch();
  const ready = `${file}.ready`;
  const lib = new URL("../lib/chats-close.mjs", import.meta.url).href;
  const holder = spawn(process.execPath, ["--input-type=module", "-e", `
    import { takeLock } from ${JSON.stringify(lib)};
    import { writeFileSync } from "node:fs";
    if (!takeLock(${JSON.stringify(file)})) process.exit(2);
    writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  `], { stdio: "ignore" });
  const exited = new Promise((done) => holder.once("exit", done));
  t.after(() => holder.kill("SIGKILL"));
  for (let i = 0; !fs.existsSync(ready); i++) {
    if (i > 200) throw new Error("the holder never took the lock");
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal(takeLock(file), null);
  holder.kill("SIGKILL");
  await exited;
  const release = takeLock(file);
  assert.ok(release);
  release();
});

test("off darwin the lock is an exclusive create, removed on release", () => {
  const file = scratch();
  const release = takeLock(file, { platform: "linux" });
  assert.ok(release);
  assert.equal(takeLock(file, { platform: "linux" }), null);
  release();
  assert.equal(fs.existsSync(file), false);
});

test("an atomic write makes a new temp file each time and never writes through one already there", (t) => {
  const file = scratch();
  const victim = scratch();
  fs.writeFileSync(victim, "keep");
  fs.symlinkSync(victim, `${file}.${process.pid}.tmp`);
  /** @type {[string, unknown][]} */
  const opens = [];
  const open = fs.openSync;
  t.mock.method(fs, "openSync", (/** @type {any[]} */ ...args) => {
    opens.push([String(args[0]), args[1]]);
    return /** @type {any} */ (open)(...args);
  });
  writeAtomic(file, "one");
  writeAtomic(file, "two");
  assert.equal(fs.readFileSync(file, "utf8"), "two");
  assert.equal(fs.readFileSync(victim, "utf8"), "keep");
  assert.deepEqual(opens.map(([, flag]) => flag), ["wx", "wx"]);
  assert.notEqual(opens[0][0], opens[1][0]);
  assert.ok(opens.every(([name]) => name.includes(`.${process.pid}.`)));
  t.mock.restoreAll();
  const taken = `${file}.taken`;
  fs.symlinkSync(victim, taken);
  t.mock.method(fs, "openSync", (/** @type {any[]} */ ...args) => /** @type {any} */ (open)(taken, ...args.slice(1)));
  assert.throws(() => writeAtomic(file, "three"), { code: "EEXIST" });
  assert.equal(fs.readFileSync(victim, "utf8"), "keep", "a name already taken fails the write");
  assert.equal(fs.readFileSync(file, "utf8"), "two");
});

test("the cron's commands run only before its deadline, and no longer than it", () => {
  const io = realIo(dir, {}, { deadline: Date.now() - 1, onDeadline: () => { throw new Error("past the deadline"); } });
  assert.throws(() => io.run("true", []), /past the deadline/);
  const soon = realIo(dir, {}, { deadline: Date.now() + 300, onDeadline: () => { throw new Error("past the deadline"); } });
  const started = Date.now();
  assert.throws(() => soon.run("sleep", ["5"]), (/** @type {any} */ e) => e.code === "ETIMEDOUT" || e.signal === "SIGKILL");
  assert.ok(Date.now() - started < 3000);
  assert.throws(() => soon.run("true", []), /past the deadline/);
});

test("a command that ignores SIGTERM is still killed at the deadline", () => {
  const stopped = () => {
    throw new Error("past the deadline");
  };
  /** @type {[string, string[]][]} */
  const traps = [
    ["sh", ["-c", "trap '' TERM; sleep 3"]],
    [process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 3000)"]],
  ];
  for (const [cmd, args] of traps) {
    const io = realIo(dir, {}, { deadline: Date.now() + 500, onDeadline: stopped });
    const started = Date.now();
    assert.throws(() => io.run(cmd, args), (/** @type {any} */ e) => e.signal === "SIGKILL");
    assert.ok(Date.now() - started < 2000, `${path.basename(cmd)} took ${Date.now() - started} ms`);
  }
});

/** A pass on fakes: one finished chat in the app, with the mode, heartbeat and lock given. */
function harness({ mode, beat = null, lock = null, knobs = null }) {
  const base = scratch();
  fs.mkdirSync(base, { recursive: true });
  const heartbeatFile = path.join(base, "closer.json");
  const lockFile = path.join(base, "closer.lock");
  const knobsFile = path.join(base, "knobs.json");
  if (knobs !== null) fs.writeFileSync(knobsFile, knobs);
  if (beat !== null) writeHeartbeat(beat, heartbeatFile);
  if (lock === "held") takeLock(lockFile);
  if (lock === "leftover") fs.writeFileSync(lockFile, "4194311\n");
  const calls = [];
  const lines = [];
  const files = new Map([["/mode", `${mode}\n`]]);
  const io = {
    now: () => NOW,
    run: (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      const a = args.join(" ");
      if (cmd === "app" && a.startsWith("terminal list")) return JSON.stringify({ result: { terminals: [{ handle: "t1", worktreePath: "/w/done", title: "✳ idle" }, { handle: "t2", worktreePath: "/w/busy", title: "⠋ work" }], truncated: false } });
      if (cmd === "app" && a.startsWith("worktree ps")) return JSON.stringify({ result: { worktrees: [{ path: "/w/done", agents: [{ state: "done", updatedAt: NOW - 2 * HOUR }] }, { path: "/w/busy", agents: [{ state: "working", updatedAt: NOW }] }] } });
      if (a.includes(" board --out ")) {
        files.set(args[args.length - 1], JSON.stringify({ board: { needs: [], chats: [] } }));
        return "";
      }
      if (a.includes(" ask list ")) return "[]";
      if (cmd === "ps" || cmd === "lsof") return "";
      if (cmd === "git") return { "remote get-url origin": "https://github.com/o/r.git", "rev-parse HEAD": "abc", "rev-parse --abbrev-ref HEAD": "feat" }[args.slice(2).join(" ")] ?? "";
      if (cmd === "gh") return "[]";
      return "{}";
    },
    read: (p) => {
      if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(p);
    },
    exists: () => false,
    write: () => {},
    mtime: () => 0,
    append: (_p, s) => lines.push(s.trim()),
    lastTurnAt: () => null,
    mentionsDevice: () => false,
    runner: () => [],
    holds: () => [],
    ownerLogins: async () => [],
  };
  const cfg = { protected: [], protectedFolder: null, app: "app", keepListFile: null, modeFile: "/mode", logFile: "/log" };
  const pass = (from, rowClose = true) => closePass({ from, rowClose, io, cfg, home: base, tmp: base, heartbeatFile, lockFile, knobsFile });
  return { base, pass, calls, lines, closes:() => calls.filter((c) => c.startsWith("app terminal close")) };
}

test("cron: a fresh heartbeat stands aside and runs nothing; a 16-minute-old one closes", async () => {
  const fresh = harness({ mode: "bridge", beat: NOW - 60_000 });
  assert.equal((await fresh.pass("cron")).stance, "aside");
  assert.deepEqual(fresh.calls, []);
  assert.match(fresh.lines[0], / list - none bridge closes$/);

  const stale = harness({ mode: "bridge", beat: NOW - 16 * 60_000 });
  const result = await stale.pass("cron");
  assert.equal(result.stance, "close");
  assert.deepEqual(stale.closes(), ["app terminal close --terminal t1 --json"]);
  assert.deepEqual(result.closed, ["done"]);
  assert.ok(stale.lines.some((l) => / close done closed closed$/.test(l)));
  assert.ok(stale.calls.some((c) => c.endsWith("chat drop done")));
});

test("cron: the switch off in the knobs file, or a knobs file it cannot read, lists and closes nothing; no knobs file closes as before", async () => {
  const off = JSON.stringify({ close: false, cap: 10, idleMinutes: 30, nightly: 5, at: new Date(NOW).toISOString() });
  for (const mode of ["bridge", "close"]) {
    const h = harness({ mode, beat: NOW - 16 * 60_000, knobs: off });
    const result = await h.pass("cron");
    assert.deepEqual([result.stance, result.closed], ["list", []], mode);
    assert.deepEqual(h.closes(), []);
    assert.ok(h.lines.some((l) => / list done would-close \(all tests pass\)$/.test(l)));
  }
  for (const knobs of ["{", "null", JSON.stringify({ cap: 10 }), JSON.stringify({ close: "true" })]) {
    const h = harness({ mode: "bridge", beat: NOW - 16 * 60_000, knobs });
    const result = await h.pass("cron");
    assert.deepEqual([result.stance, result.closed], ["list", []], knobs);
    assert.deepEqual(h.closes(), []);
  }
  const unreadable = harness({ mode: "close", knobs: "" });
  fs.chmodSync(path.join(unreadable.base, "knobs.json"), 0o000);
  assert.deepEqual((await unreadable.pass("cron")).stance, "list", "unreadable");
  const on = JSON.stringify({ close: true, cap: 10, idleMinutes: 30, nightly: 5, at: new Date(NOW).toISOString() });
  for (const plant of [
    (/** @type {string} */ at) => fs.symlinkSync(path.join(at, "gone.json"), path.join(at, "knobs.json")),
    (/** @type {string} */ at) => (fs.writeFileSync(path.join(at, "real.json"), on), fs.symlinkSync(path.join(at, "real.json"), path.join(at, "knobs.json"))),
    (/** @type {string} */ at) => fs.mkdirSync(path.join(at, "knobs.json")),
  ]) {
    const h = harness({ mode: "close" });
    plant(h.base);
    const result = await h.pass("cron");
    assert.deepEqual([result.stance, result.closed], ["list", []], "a link, dangling or not, or a folder");
  }
  const none = harness({ mode: "bridge", beat: NOW - 16 * 60_000 });
  assert.deepEqual((await none.pass("cron")).closed, ["done"], "no knobs file");
});

test("a held lock: the cron skips; the bridge counts and closes nothing; a leftover lock file is taken", darwinOnly, async () => {
  const cron = harness({ mode: "close", lock: "held" });
  assert.equal((await cron.pass("cron")).stance, "locked");
  assert.deepEqual(cron.closes(), []);
  assert.match(cron.lines[0], /run skipped: another closer runs$/);

  const bridge = harness({ mode: "bridge", lock: "held" });
  const counted = await bridge.pass("bridge");
  assert.deepEqual([counted.stance, counted.open, counted.working, counted.closed], ["locked", 2, 1, []]);
  assert.deepEqual(bridge.closes(), []);
  assert.deepEqual(bridge.lines, [], "the bridge logs only the passes it closes in");

  const dead = harness({ mode: "bridge", lock: "leftover" });
  assert.deepEqual((await dead.pass("bridge")).closed, ["done"]);
});

test("the bridge with its switch off, or before the mode flips, only counts", async () => {
  for (const [mode, rowClose] of [["bridge", false], ["close", true]]) {
    const h = harness({ mode });
    const result = await h.pass("bridge", rowClose);
    assert.deepEqual([result.stance, result.open, result.closed], ["list", 2, []], mode);
    assert.deepEqual(h.closes(), []);
  }
});

test("the count, the kept list from the log, and the cap the bridge wrote", () => {
  const numbers = count({ terminals: [{ worktreePath: "/w/a", title: "⠋ x" }, { worktreePath: "/w/b", title: "✳ y" }, { worktreePath: "/w/c", title: "Setup" }], runner: [{ worktree: "/w/b" }] });
  assert.deepEqual([numbers.chats, numbers.working, numbers.both], [2, 1, 1]);
  const log = keptFromLog("22/11/2026 08:00 +00 close a keep active (agent working)\n22/11/2026 08:00 +00 close b keep open-pr #4\n");
  assert.deepEqual(log.kept, [{ name: "b", reason: "open-pr #4" }]);
  assert.match(report(numbers, log, { cap: 7, app: "app" }), /\(cap 7\)/);
  const file = scratch();
  assert.equal(readKnobCap(file), 10);
  fs.writeFileSync(file, JSON.stringify({ cap: 6, idleMinutes: 30, nightly: 5, at: new Date().toISOString() }));
  assert.equal(readKnobCap(file), 6);
  fs.writeFileSync(file, "{");
  assert.equal(readKnobCap(file), null);
  const link = scratch();
  fs.writeFileSync(file, JSON.stringify({ cap: 6 }));
  fs.symlinkSync(file, link);
  assert.equal(readKnobCap(link), null, "a link is never followed");
  const dangling = scratch();
  fs.symlinkSync(scratch(), dangling);
  assert.equal(readKnobCap(dangling), null, "a dangling link is not a missing file");
  const folder = scratch();
  fs.mkdirSync(folder);
  assert.equal(readKnobCap(folder), null, "a folder");
});

test("the heartbeat is read only from a plain file: a link or a folder at its path reads as none, so the cron takes over", () => {
  const file = scratch();
  writeHeartbeat(Date.now(), file);
  assert.equal(readHeartbeat(file)?.by, "bridge");
  const link = scratch();
  fs.symlinkSync(file, link);
  assert.equal(readHeartbeat(link), null, "a link is never followed");
  const folder = scratch();
  fs.mkdirSync(folder);
  assert.equal(readHeartbeat(folder), null, "a folder");
  assert.equal(readHeartbeat(scratch()), null, "nothing there");
});

test("a FIFO at the knobs or heartbeat path: the cron lists, the cap reads as unreadable, the heartbeat reads as none, and no read waits on a writer", { skip: !HAS_MKFIFO && "no mkfifo here", timeout: 30_000 }, () => {
  const fifo = scratch();
  execFileSync("mkfifo", [fifo]);
  for (const [lib, name, want] of [["../lib/chats-close.mjs", "readKnobsClose", false], ["../lib/chat-count.mjs", "readKnobCap", null], ["../lib/chats-close.mjs", "readHeartbeat", null]]) {
    const read = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(new URL(lib, import.meta.url).href)}); process.stdout.write(JSON.stringify(m.${name}(${JSON.stringify(fifo)})));`], { encoding: "utf8", timeout: 5_000 });
    assert.equal(read.status, 0, `${name} blocked or failed: ${read.signal ?? read.stderr}`);
    assert.equal(JSON.parse(read.stdout), want, name);
  }
});

test("the runner's open chats count as the backlog puller counts them, not only a live pane", () => {
  const on = scratch();
  fs.writeFileSync(on, "");
  const rows = [
    { worktree: "/w/alive", live: "alive", status: "running" },
    { worktree: "/w/resumes", live: "gone", status: "running", resume: true },
    { worktree: "/w/socket", live: "socket other", status: "running" },
    { worktree: "/w/foreign", live: "foreign", status: "finished" },
    { worktree: "/w/starting", live: "gone", status: "starting" },
    { worktree: "/w/kept", live: "gone", status: "running", keepAlive: true },
    { worktree: "/w/lost", live: "gone", status: "running" },
    { worktree: "/w/finished", live: "gone", status: "finished", resume: true },
    { worktree: "relative", live: "alive", status: "running" },
  ];
  const open = readRunner(() => JSON.stringify(rows), { on, cli: "/x" }).map((r) => r.worktree);
  assert.deepEqual(open, ["/w/alive", "/w/resumes", "/w/socket", "/w/foreign", "/w/starting", "/w/kept"]);
  assert.equal(count({ terminals: [], runner: readRunner(() => JSON.stringify([rows[1]]), { on, cli: "/x" }) }).chats, 1, "gone with a restart due");
});

test("the command line: cron, or the bridge with its switch and absolute command paths", () => {
  assert.deepEqual(parseArgs(["--from", "cron"]), { from: "cron", close: false, bins: {} });
  assert.deepEqual(parseArgs(["--from", "bridge", "--close", "on", "--bin", "gh=/opt/gh"]), { from: "bridge", close: true, bins: { gh: "/opt/gh" } });
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(["--from", "cron", "--bin", "gh=relative"]), /unknown argument/);
});
