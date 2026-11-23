import assert from "node:assert/strict";
import test from "node:test";
import { ExecError } from "../lib/config.mjs";
import { GhLoginFault, GhLoginUnread, LOGIN_TRIES, makeGh } from "../lib/gh-login.mjs";

const GH = "/bin/gh";
const TOKEN = `gho_${"A1b2C3d4E5".repeat(4)}`;
const isRead = (/** @type {string[]} */ args) => args.length === 2 && args[0] === "auth" && args[1] === "token";

/**
 * A stand-in for makeExec's exec. `reads` answers each `gh auth token` in turn (the last one repeats): a string is its
 * stdout, an Error its failure. Every other call answers "ok", or rejects with `fail`.
 * @param {{ reads?: (string | Error)[], env?: NodeJS.ProcessEnv, fail?: Error }} [over]
 */
function setup({ reads = [`${TOKEN}\n`], env = {}, fail } = {}) {
  /** @type {{ file: string, args: string[], opts: any }[]} */
  const calls = [];
  /** @type {{ file: string, args: string[], opts: any }[]} */
  const readCalls = [];
  /** @type {[string, Record<string, unknown>][]} */
  const logs = [];
  /** @type {number[]} */
  const sleeps = [];
  /** @type {import("../lib/config.mjs").Exec} */
  const exec = async (file, args, opts) => {
    if (isRead(args)) {
      readCalls.push({ file, args, opts });
      const answer = reads[Math.min(readCalls.length, reads.length) - 1];
      if (answer instanceof Error) throw answer;
      return { stdout: answer, stderr: "" };
    }
    calls.push({ file, args, opts });
    if (fail) throw fail;
    return { stdout: "ok", stderr: "" };
  };
  const gh = makeGh(exec, GH, {
    env,
    sleep: async (ms) => void sleeps.push(ms),
    pauseMs: 7,
    log: (event, fields) => void logs.push([event, fields]),
  });
  return { gh, calls, readCalls, logs, sleeps };
}

const unread = () => new ExecError(GH, { code: 1 }, "no oauth token found for github.com\n", "");
/** The pauses of one whole failed read at the test's pauseMs of 7: 7, 14, 28, … */
const PAUSES = Array.from({ length: LOGIN_TRIES - 1 }, (_, n) => 7 * 2 ** n);

test("the login is read once and every gh call gets it as GH_TOKEN, never in its arguments", async () => {
  const s = setup();
  for (let n = 0; n < 5; n += 1) assert.deepEqual(await s.gh(["api", `repos/o/r/pulls/${n}`], { timeout: 60_000 }), { stdout: "ok", stderr: "" });
  assert.equal(s.readCalls.length, 1);
  assert.equal(s.readCalls[0].file, GH);
  assert.equal(s.readCalls[0].opts.timeout, 20_000);
  assert.equal(s.readCalls[0].opts.env, undefined);
  assert.equal(s.calls.length, 5);
  for (const call of s.calls) {
    assert.equal(call.file, GH);
    assert.deepEqual(call.opts, { timeout: 60_000, env: { GH_TOKEN: TOKEN } });
    assert.ok(!call.args.join(" ").includes(TOKEN));
  }
  assert.deepEqual(s.sleeps, []);
  assert.deepEqual(s.logs, []);
});

test("first calls made together share one read", async () => {
  const s = setup();
  await Promise.all([1, 2, 3, 4].map((n) => s.gh(["pr", "view", String(n)], { timeout: 1_000 })));
  assert.equal(s.readCalls.length, 1);
  assert.equal(s.calls.length, 4);
  for (const call of s.calls) assert.equal(call.opts.env.GH_TOKEN, TOKEN);
});

test("a read that fails is tried again after a pause, and the login it then gets is kept", async () => {
  const s = setup({ reads: [unread(), `${TOKEN}\n`] });
  await s.gh(["api", "user"], { timeout: 1_000 });
  await s.gh(["api", "user"], { timeout: 1_000 });
  assert.equal(s.readCalls.length, 2);
  assert.deepEqual(s.sleeps, [7]);
  assert.deepEqual(s.calls.map((c) => c.opts.env.GH_TOKEN), [TOKEN, TOKEN]);
  assert.deepEqual(s.logs, []);
});

test("an empty or many-line answer is a failed try", async () => {
  const s = setup({ reads: ["", "  \n", `${TOKEN}\nsecond line\n`, `${TOKEN}\r\n`] });
  await s.gh(["api", "user"], { timeout: 1_000 });
  assert.equal(s.readCalls.length, 4);
  assert.deepEqual(s.sleeps, [7, 14, 28], "each pause is twice the one before");
  assert.equal(s.calls[0].opts.env.GH_TOKEN, TOKEN);
});

test("with every try failed no gh call is made: each throws GhLoginUnread, it is said once, and nothing reads again", async () => {
  const s = setup({ reads: [unread()] });
  const opts = { timeout: 1_000, env: { GH_PAGER: "cat" } };
  const thrown = await Promise.all([s.gh(["api", "a"], opts), s.gh(["api", "b"], opts)].map((p) => p.catch((err) => err)));
  for (const err of thrown) assert.ok(err instanceof GhLoginUnread);
  assert.equal(s.readCalls.length, LOGIN_TRIES);
  assert.deepEqual(s.sleeps, PAUSES);
  assert.equal(s.calls.length, 0, "no call goes out logged out");
  await assert.rejects(s.gh(["api", "c"], opts), GhLoginUnread);
  await assert.rejects(s.gh.ready(), GhLoginUnread);
  assert.equal(s.readCalls.length, LOGIN_TRIES, "a failed read is not repeated for a later call");
  assert.deepEqual(s.sleeps, PAUSES);
  assert.equal(s.calls.length, 0);
  assert.deepEqual(s.logs, [["gh-login-unread", { tries: LOGIN_TRIES }]]);
});

test("ready() reads the login before any call, and a later call uses that read", async () => {
  const s = setup();
  await s.gh.ready();
  assert.equal(s.readCalls.length, 1);
  assert.equal(s.calls.length, 0);
  await s.gh(["api", "user"], { timeout: 1_000 });
  assert.equal(s.readCalls.length, 1);
  assert.equal(s.calls[0].opts.env.GH_TOKEN, TOKEN);
  const given = setup({ env: { GH_TOKEN: "x" } });
  await given.gh.ready();
  assert.equal(given.readCalls.length, 0, "a login already in the environment needs no read");
});

test("with GH_TOKEN or GITHUB_TOKEN already set, gh is called as it is and nothing is read", async () => {
  for (const env of [{ GH_TOKEN: "x" }, { GITHUB_TOKEN: "y" }]) {
    const s = setup({ env });
    const opts = { timeout: 1_000 };
    assert.deepEqual(await s.gh(["api", "user"], opts), { stdout: "ok", stderr: "" });
    assert.equal(s.readCalls.length, 0);
    assert.equal(s.calls[0].opts, opts);
  }
  const empty = setup({ env: { GH_TOKEN: "", GITHUB_TOKEN: "" } });
  await empty.gh(["api", "user"], { timeout: 1_000 });
  assert.equal(empty.readCalls.length, 1, "an empty variable is no login");
  assert.equal(empty.calls[0].opts.env.GH_TOKEN, TOKEN);
});

test("the caller's own options and env are kept beside GH_TOKEN", async () => {
  const s = setup();
  const opts = { timeout: 120_000, maxBuffer: 64 * 1024 * 1024, input: "body", cwd: "/tmp", env: { GH_PAGER: "cat" } };
  await s.gh(["issue", "comment", "1", "--body-file", "-"], opts);
  assert.deepEqual(s.calls[0].opts, { ...opts, env: { GH_PAGER: "cat", GH_TOKEN: TOKEN } });
  assert.deepEqual(opts.env, { GH_PAGER: "cat" }, "the caller's object is not written to");
});

test("a gh call that fails with the login in its environment throws exec's own error, with no login in it", async () => {
  const failed = new ExecError(GH, { code: 1 }, "gh: Not Found (HTTP 404)\n", "");
  const s = setup({ fail: failed });
  const thrown = await s.gh(["api", "user"], { timeout: 1_000 }).catch((err) => err);
  assert.equal(thrown, failed);
  assert.equal(s.calls[0].opts.env.GH_TOKEN, TOKEN);
  assert.ok(!`${thrown.message} ${JSON.stringify(thrown)} ${thrown.stack}`.includes(TOKEN));
  assert.deepEqual(s.logs, []);
});

test("a logger that throws does not change what the calls that follow do", async () => {
  /** @type {import("../lib/config.mjs").Exec} */
  const exec = async (_file, args) => {
    if (isRead(args)) throw unread();
    return { stdout: "ok", stderr: "" };
  };
  const gh = makeGh(exec, GH, { env: {}, sleep: async () => {}, log: () => { throw new Error("stdout is gone"); } });
  for (let n = 0; n < 2; n += 1) await assert.rejects(gh(["api", "user"], { timeout: 1_000 }), GhLoginUnread);
});

test("the login is in no log line and no error", async () => {
  const s = setup({ reads: [new ExecError(GH, { code: 1 }, "no oauth token found for github.com\n", `${TOKEN}\n`), `${TOKEN}\n${TOKEN}\n`, unread()] });
  /** @type {unknown[]} */
  const thrown = [];
  for (let n = 0; n < 2; n += 1) await s.gh(["api", "user"], { timeout: 1_000 }).catch((err) => thrown.push(err));
  assert.equal(thrown.length, 2);
  assert.equal(s.calls.length, 0);
  for (const err of thrown) {
    assert.ok(err instanceof GhLoginUnread);
    assert.equal(/** @type {Error} */ (err).message, "gh login unreadable");
    assert.equal(/** @type {any} */ (err).cause, undefined, "nothing of the child's error is carried");
  }
  assert.equal(s.readCalls.length, LOGIN_TRIES);
  assert.deepEqual(s.logs, [["gh-login-unread", { tries: LOGIN_TRIES }]]);
  for (const text of [JSON.stringify(s.logs), ...thrown.map((err) => `${/** @type {Error} */ (err).message} ${JSON.stringify(err)} ${/** @type {Error} */ (err).stack}`)]) {
    assert.ok(!text.includes(TOKEN));
  }
  // A failed read's output reaches no later call: the call that follows a good read carries only that read's login.
  const OTHER = `gho_${"Z9y8X7w6V5".repeat(4)}`;
  const later = setup({ reads: [new ExecError(GH, { code: 1 }, "no oauth token found for github.com\n", `${TOKEN}\n`), `${TOKEN}\n${TOKEN}\n`, `${OTHER}\n`] });
  await later.gh(["api", "user"], { timeout: 1_000 });
  assert.equal(later.calls.length, 1);
  assert.equal(later.calls[0].opts.env.GH_TOKEN, OTHER);
  assert.ok(!JSON.stringify(later.calls).includes(TOKEN), "a failed read's output goes nowhere");
});

test("a read our own limit cut short is a slow keychain too: tried again, and kept on a later good read", async () => {
  const timedOut = [
    new ExecError(GH, { killed: true, signal: "SIGKILL" }, ""),
    new ExecError(GH, { killed: true, signal: "SIGTERM", code: null }, ""),
    new ExecError(GH, { code: "ETIMEDOUT" }, ""),
  ];
  const s = setup({ reads: [...timedOut, `${TOKEN}\n`] });
  await s.gh(["api", "user"], { timeout: 1_000 });
  assert.equal(s.readCalls.length, 4);
  assert.equal(s.calls[0].opts.env.GH_TOKEN, TOKEN);
  const never = setup({ reads: [timedOut[0]] });
  await assert.rejects(never.gh.ready(), GhLoginUnread);
  assert.equal(never.readCalls.length, LOGIN_TRIES);
  assert.deepEqual(never.sleeps, PAUSES);
});

test("a read that fails for any other reason fails the run at once with gh's exit only, and nothing gh wrote", async () => {
  const PAT = `github_pat_11${"ABCDEFGH".repeat(8)}`;
  const faults = [
    new ExecError(GH, { code: 1 }, "unknown command \"token\" for \"gh auth\"\n", `${TOKEN}\n`),
    new ExecError(GH, { code: "ENOENT" }, "", ""),
    new ExecError(GH, { code: null, signal: "SIGABRT" }, "dyld[1]: Library not loaded: libfoo.dylib\n", ""),
    new ExecError(GH, { code: 1 }, `failed to parse config: bad value ${TOKEN}\n`, ""),
    new ExecError(GH, { code: 1 }, `bad login ${PAT}\n`, ""),
    new Error(`spawn failed ${TOKEN}`),
  ];
  for (const fault of faults) {
    const s = setup({ reads: [fault] });
    const thrown = await s.gh.ready().catch((err) => err);
    assert.ok(thrown instanceof GhLoginFault, String(fault.message));
    assert.ok(!(thrown instanceof GhLoginUnread));
    assert.equal(s.readCalls.length, 1, "a fault is not tried again");
    assert.deepEqual(s.sleeps, []);
    const shown = `${thrown.message} ${JSON.stringify(thrown)} ${thrown.stack}`;
    assert.ok(!shown.includes(TOKEN) && !shown.includes(PAT) && !shown.includes("bad value") && !shown.includes("dyld"));
    await assert.rejects(s.gh(["api", "user"], { timeout: 1_000 }), GhLoginFault);
    assert.equal(s.calls.length, 0);
    assert.equal(s.readCalls.length, 1);
  }
  const s = setup({ reads: [faults[0]] });
  assert.equal((await s.gh.ready().catch((err) => err)).message, "gh auth token failed: gh exit 1");
});
