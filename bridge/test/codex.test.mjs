import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { CODEX_READ_TTL_MS, codexHomes, codexRows, collectCodex, parseCodexAccountRead, parseCodexLimits, readCodexAccount } from "../lib/ops/codex.mjs";

const reply = (rateLimits) => ({ id: 2, result: { rateLimits } });
const week = (usedPercent) => parseCodexLimits(reply({ primary: { usedPercent, windowDurationMins: 10080, resetsAt: null } }));

// Fixture strings shaped like what must never be printed as an account's email: a JWT, a URL password, a header.
const NOT_AN_EMAIL = ["eyJfixture0.eyJfixture1.sig", "https://u:fixture@host.example", "Bearer fixture@x.y", "a@b", ""];

/** Two homes for the collector: the reads are faked, so neither is on disk. */
const HOMES = ["aaa-1", "bbb-2"].map((id) => ({ id, home: path.join(tmpdir(), id, "home") }));
const list = () => HOMES;

test("codexHomes: CODEX_HOME when it is there, and no home when it is not", () => {
  const home = mkdtempSync(path.join(tmpdir(), "codex-home-"));
  try {
    assert.deepEqual(codexHomes({ CODEX_HOME: `  ${home}  ` }), [{ id: "default", home }]);
    assert.deepEqual(codexHomes({ CODEX_HOME: path.join(home, "missing") }), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("collectCodex: a home signed back in whose usage read fails is no longer signed out", async () => {
  let t = 1_000_000;
  const cache = new Map();
  let got = { limits: null, signedIn: false, email: null };
  const pass = () => collectCodex({ codexBin: "/bin/codex", list, read: async (_, home) => (home.includes("bbb-2") ? got : { limits: week(5), signedIn: true, email: "cc@example.com" }), now: () => t, cache });
  assert.deepEqual((await pass()).map((row) => row.label), ["cc***, week", "?*** (signed out, no reading)"]);
  t += CODEX_READ_TTL_MS;
  got = { limits: null, signedIn: true, email: "bb@example.com" };
  assert.deepEqual((await pass()).map((row) => row.label), ["cc***, week", "bb*** (no reading)"]);
});

test("parseCodexAccountRead: no account is signed out; an error or a malformed reply is unknown; only a plain address is kept", () => {
  assert.deepEqual(parseCodexAccountRead({ id: 3, result: { account: { email: "cc@example.com" } } }), { signedIn: true, email: "cc@example.com" });
  for (const email of NOT_AN_EMAIL) assert.deepEqual(parseCodexAccountRead({ id: 3, result: { account: { email } } }), { signedIn: true, email: null }, email);
  assert.deepEqual(parseCodexAccountRead({ id: 3, result: { account: null } }), { signedIn: false, email: null });
  assert.deepEqual(parseCodexAccountRead({ id: 3, error: { message: "no" } }), { signedIn: null, email: null });
  assert.deepEqual(parseCodexAccountRead({ id: 3, result: "x" }), { signedIn: null, email: null });
});

test("codexRows: every window named, shortest first, the week's row carries credits as fields, graded at 90/100; no reply is 'no reading'", () => {
  const weekly = parseCodexLimits(reply({ primary: { usedPercent: 47.04, windowDurationMins: 10080, resetsAt: 1_760_000_000 }, credits: { hasCredits: true, unlimited: false, balance: "61900.4" } }));
  const both = parseCodexLimits(
    reply({ primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1_760_000_000 }, secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_759_990_000 }, credits: { unlimited: true } }),
  );
  assert.deepEqual(
    codexRows([
      { mask: "bb***", limits: weekly },
      { mask: "cc***", note: "stale", limits: both },
      { mask: "zz***", limits: null },
      { mask: "so***", note: "signed out", limits: null },
    ]),
    [
      { kind: "codex_1_week", label: "bb***, week", percent: 47, severity: "normal", resetsAt: "2025-10-09T08:53:20.000Z", active: false, credits: 61900.4, unlimited: false },
      { kind: "codex_2_5hr", label: "cc***, 5 hr (stale)", percent: 12, severity: "normal", resetsAt: "2025-10-09T06:06:40.000Z", active: false },
      { kind: "codex_2_week", label: "cc***, week (stale)", percent: 100, severity: "critical", resetsAt: "2025-10-09T08:53:20.000Z", active: false, credits: null, unlimited: true },
      { kind: "codex_3", label: "zz*** (no reading)", percent: 0, severity: "normal", resetsAt: null, active: false },
      { kind: "codex_4", label: "so*** (signed out, no reading)", percent: 0, severity: "normal", resetsAt: null, active: false },
    ],
  );
  const busy = parseCodexLimits(reply({ primary: { usedPercent: 90, windowDurationMins: 10080, resetsAt: 1 }, credits: { unlimited: false, balance: "0" } }));
  assert.deepEqual(codexRows([{ mask: "hh***", limits: busy }])[0], {
    kind: "codex_1_week",
    label: "hh***, week",
    percent: 90,
    severity: "warning",
    resetsAt: "1970-01-01T00:00:01.000Z",
    active: false,
    credits: 0,
    unlimited: false,
  });
  // A balance no account can have is no reading: it must never fail the server's schema and with it the whole Claude PUT.
  for (const balance of ["-1", "1e12"])
    assert.equal(parseCodexLimits(reply({ primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1 }, credits: { unlimited: false, balance } }))?.credits?.balance, null);
  assert.equal(parseCodexLimits({ id: 2, error: { message: "no" } }), null);
  assert.equal(parseCodexLimits(reply({})), null);
});

test("collectCodex reads each home under its own CODEX_HOME, at most once per TTL, and keeps a failed home's reading marked stale", async () => {
  let t = 1_000_000;
  const cache = new Map();
  const reads = [];
  /** @type {Record<string, () => Promise<any>>} */
  let answer = {
    "aaa-1": async () => ({ limits: week(5), signedIn: true, email: "cc@example.com" }),
    "bbb-2": async () => ({ limits: week(40), signedIn: true, email: "bb@example.com" }),
  };
  const read = async (bin, home) => {
    const id = path.basename(path.dirname(home));
    reads.push([bin, id]);
    return answer[id]();
  };
  const pass = () => collectCodex({ codexBin: "/bin/codex", list, read, now: () => t, cache });
  const labels = (rows) => rows.map((row) => `${row.label} ${row.percent}`);

  assert.deepEqual(labels(await pass()), ["cc***, week 5", "bb***, week 40"]);
  assert.deepEqual(reads, [
    ["/bin/codex", "aaa-1"],
    ["/bin/codex", "bbb-2"],
  ]);
  // Within the TTL no app-server starts at all.
  t += CODEX_READ_TTL_MS - 1;
  assert.deepEqual(labels(await pass()), ["cc***, week 5", "bb***, week 40"]);
  assert.equal(reads.length, 2);

  // Past it: one home's read throws, the other answers nothing; both keep their last reading, marked stale.
  t += 1;
  answer = {
    "aaa-1": async () => {
      throw new Error("spawn failed");
    },
    "bbb-2": async () => ({ limits: null, signedIn: null, email: null }),
  };
  assert.deepEqual(labels(await pass()), ["cc***, week (stale) 5", "bb***, week (stale) 40"]);
  assert.equal(reads.length, 4);

  // A home that reports signed out shows so on its own row; the other recovers.
  t += CODEX_READ_TTL_MS;
  answer = {
    "aaa-1": async () => ({ limits: week(7), signedIn: true, email: "cc@example.com" }),
    "bbb-2": async () => ({ limits: null, signedIn: false, email: null }),
  };
  assert.deepEqual(labels(await pass()), ["cc***, week 7", "bb*** (signed out, no reading) 0"]);

  // After six hours with no good reading, a stale home is "no reading".
  t += CODEX_READ_TTL_MS;
  const unknown = async () => ({ limits: null, signedIn: null, email: null });
  answer = { "aaa-1": unknown, "bbb-2": unknown };
  assert.deepEqual(labels(await pass()), ["cc***, week (stale) 7", "bb*** (signed out, no reading) 0"]);
  t += 6 * 60 * 60_000;
  assert.deepEqual(labels(await pass()), ["cc*** (no reading) 0", "bb*** (signed out, no reading) 0"]);
});

test("collectCodex: a hung home times out on its own row and never stalls the pass or the other home", async () => {
  const silent = () => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill() {} });
  const read = (bin, home) =>
    home.includes("aaa-1") ? readCodexAccount(bin, home, { spawn: silent, timeoutMs: 50 }) : Promise.resolve({ limits: week(9), signedIn: true, email: "bb@example.com" });
  const started = Date.now();
  const rows = await collectCodex({ codexBin: "/bin/codex", list, read, cache: new Map() });
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(
    rows.map((row) => row.label),
    ["?*** (no reading)", "bb***, week"],
  );
});

test("collectCodex: with no Codex home there are no rows, and the default list reads CODEX_HOME", async () => {
  assert.deepEqual(await collectCodex({ codexBin: "/bin/codex", list: () => [], read: async () => assert.fail("no read") }), []);
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(tmpdir(), "no-such-codex-home");
  try {
    assert.deepEqual(await collectCodex({ codexBin: "/bin/codex", read: async () => assert.fail("no read") }), []);
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before;
  }
});

test("readCodexAccount speaks initialize then account/rateLimits/read and account/read, and gives up on silence", async () => {
  /** A fake app-server answering line by line. */
  const fake = (answer) => (bin, args, opts) => {
    assert.deepEqual(args, ["app-server"]);
    assert.equal(opts.env.CODEX_HOME, "/home/a");
    assert.equal(opts.cwd, "/home/a");
    assert.equal(opts.detached, true);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), killed: false, kill() { this.killed = true; } });
    const sent = [];
    child.stdin.on("data", (chunk) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        const message = JSON.parse(line);
        sent.push(message.method);
        if (!answer) continue;
        if (message.id === 1) child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
        if (message.id === 2) child.stdout.write(`noise\n${JSON.stringify(reply({ primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1 } }))}\n`);
        if (message.id === 3) {
          assert.deepEqual(message.params, { refreshToken: false });
          child.stdout.write(`${JSON.stringify({ id: 3, result: { account: { email: "cc@example.com" } } })}\n`);
        }
      }
    });
    fake.sent = sent;
    fake.child = child;
    return child;
  };
  const talk = fake(true);
  assert.deepEqual(await readCodexAccount("/bin/codex", "/home/a", { spawn: talk }), {
    limits: { windows: [{ mins: 10080, percent: 30, resetsAt: 1 }], credits: null },
    signedIn: true,
    email: "cc@example.com",
  });
  assert.deepEqual(fake.sent, ["initialize", "initialized", "account/rateLimits/read", "account/read"]);
  assert.equal(fake.child.killed, true);
  const nothing = { limits: null, signedIn: null, email: null };
  assert.deepEqual(await readCodexAccount("/bin/codex", "/home/a", { spawn: fake(false), timeoutMs: 20 }), nothing);
  assert.deepEqual(
    await readCodexAccount("/bin/codex", "/home/a", {
      spawn: () => {
        throw new Error("ENOENT");
      },
    }),
    nothing,
  );
  // A server that closes its input mid-handshake: the broken pipe ends the read, never the bridge.
  const broken = () =>
    Object.assign(new EventEmitter(), {
      stdin: new Writable({ write: (_chunk, _enc, done) => done(Object.assign(new Error("broken pipe"), { code: "EPIPE" })) }),
      stdout: new PassThrough(),
      kill() {},
    });
  assert.deepEqual(await readCodexAccount("/bin/codex", "/home/a", { spawn: broken, timeoutMs: 200 }), nothing);
});

test("readCodexAccount kills a hung server's whole process group, children too", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-hang-"));
  try {
    const bin = path.join(dir, "codex");
    const pidFile = path.join(dir, "child.pid");
    // A server that starts a child of its own and then never answers.
    writeFileSync(bin, `#!/bin/sh\nsleep 30 &\necho $! > "${pidFile}"\nsleep 30\n`);
    chmodSync(bin, 0o755);
    const home = path.join(dir, "home");
    mkdirSync(home);
    // The read's timer is set before it spawns, so on a loaded runner it could fire before the shell had even forked
    // its child. This spawn returns only once the child's PID is on disk; the timer cannot fire while it blocks.
    const spawnOnceForked = (/** @type {Parameters<typeof spawn>} */ ...args) => {
      const child = spawn(...args);
      const deadline = Date.now() + 15_000;
      while (!/^\d+\n$/u.test(existsSync(pidFile) ? readFileSync(pidFile, "utf8") : "") && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return child;
    };
    assert.deepEqual(await readCodexAccount(bin, home, { spawn: spawnOnceForked, timeoutMs: 200 }), { limits: null, signedIn: null, email: null });
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(pid > 0);
    let alive = true;
    for (let i = 0; i < 80 && alive; i += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 25));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "the server's child outlived the read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
