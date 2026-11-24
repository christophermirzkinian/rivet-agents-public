import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CHAT_CLI, createChatRunner, runnerTerminal, submitState } from "../lib/chat-source.mjs";

const RULE = "─".repeat(80);
/** A Claude screen with `input` in its box. @param {string} input */
const SCREEN = (input) => ["some output", RULE, `❯ ${input}`, RULE, "status row"];
/** @param {object[]} rows */
const LS = (rows) => JSON.stringify(rows);
const ROW = { name: "site-fix", provider: "claude", state: "alive", status: "running", started: "2026-01-02T03:04:05.000Z", worktree: "/tmp/w", repo: "example-org/example-repo", branch: "main", title: "✳ idle", lastOutputAt: 5 };

test("the CLI is the runner's in the same app folder as the bridge", () => {
  assert.match(CHAT_CLI, /scripts[/\\]rivet-chat\.mjs$/);
});

test("a runner row is a Terminal named by the chat; a finished one is left out; a dead one is pending", () => {
  assert.deepEqual(runnerTerminal(ROW), {
    handle: "site-fix",
    name: "site-fix",
    worktreePath: "/tmp/w",
    repo: "example-org/example-repo",
    connected: true,
    writable: true,
    agentIdentity: "claude",
    pending: false,
    lastOutputAt: 5,
    title: "✳ idle",
    branch: "refs/heads/main",
    startedAt: Date.parse(ROW.started),
  });
  assert.equal(runnerTerminal({ ...ROW, state: "gone", status: "finished" }), null);
  const dead = /** @type {any} */ (runnerTerminal({ ...ROW, state: "dead" }));
  assert.deepEqual([dead.connected, dead.writable, dead.pending], [false, false, true]);
  assert.equal(runnerTerminal({ provider: "claude" }), null);
  assert.equal(runnerTerminal(null), null);
});

test("submitState reads only the input box", () => {
  const line = "From the owner: look at the board please";
  assert.equal(submitState(SCREEN(""), line), "submitted");
  assert.equal(submitState(SCREEN(line), line), "in-input");
  assert.equal(submitState([`> ${line}`, ...SCREEN("")], line), "submitted", "the line above the box is the chat having taken it");
  const wrapped = [RULE, `❯ ${line.slice(0, 20)}`, `  ${line.slice(20)}`, RULE, "status"];
  assert.equal(submitState(wrapped, line), "in-input");
  assert.equal(submitState([RULE, "❯ [Pasted text #1 +3 lines]", RULE], line), "in-input");
  assert.equal(submitState(["no box here"], line), "unknown");
});

test("submitState: rules that are not the box, or a box half drawn, are never counted as submitted", () => {
  const line = "From the owner: look at the board please";
  assert.equal(submitState([RULE, "old output", RULE, `❯ ${line}`], line), "unknown");
  assert.equal(submitState([RULE, "a table in the output", RULE, "more output"], line), "unknown");
});

/**
 * A runner whose CLI answers from `screens` (one per read, the last repeated).
 * @param {{ rows?: object[], screens?: string[][] }} [o]
 */
function harness(o = {}) {
  /** @type {{ args: string[], input?: string }[]} */
  const calls = [];
  const screens = [...(o.screens ?? [SCREEN("")])];
  const exec = async (/** @type {string} */ file, /** @type {string[]} */ args, /** @type {any} */ opts) => {
    assert.equal(file, "/node");
    assert.equal(args[0], "/cli");
    calls.push({ args: args.slice(1), ...(opts.input !== undefined ? { input: opts.input } : {}) });
    const cmd = args[1];
    if (cmd === "ls") return { stdout: LS(o.rows ?? [ROW]), stderr: "" };
    if (cmd === "read") return { stdout: `${(screens.length > 1 ? screens.shift() : screens[0])?.join("\n")}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const runner = createChatRunner({ exec, nodeBin: "/node", cli: "/cli", cwd: "/tmp/home", sleep: async () => {} });
  return { runner, calls };
}

test("list, read, interrupt and start run the runner's CLI; a prompt and a line go on stdin only", async () => {
  const { runner, calls } = harness();
  assert.equal((await runner.list())[0].handle, "site-fix");
  assert.deepEqual(await runner.read("site-fix", 3), SCREEN(""));
  await runner.interrupt("site-fix");
  await runner.start("chat-r01", "the first line");
  assert.deepEqual(calls, [
    { args: ["ls", "--json"] },
    { args: ["read", "site-fix", "--lines", "3"] },
    { args: ["interrupt", "site-fix"] },
    { args: ["new", "chat-r01", "--cwd", "/tmp/home", "--prompt-file", "-"], input: "the first line" },
  ]);
});

test("a new chat with no folder given opens in RIVET_CHAT_DIR when it is a real folder, else home", async (t) => {
  // The temp folder itself sits under a link on macOS (/var is /private/var).
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-dir-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const was = process.env.RIVET_CHAT_DIR;
  t.after(() => (was === undefined ? delete process.env.RIVET_CHAT_DIR : (process.env.RIVET_CHAT_DIR = was)));
  const chat = path.join(base, "chat");
  fs.mkdirSync(chat);
  fs.symlinkSync(chat, path.join(base, "link"));
  const started = async (/** @type {string | undefined} */ dir) => {
    if (dir === undefined) delete process.env.RIVET_CHAT_DIR;
    else process.env.RIVET_CHAT_DIR = dir;
    /** @type {string[][]} */
    const calls = [];
    const exec = async (/** @type {string} */ _file, /** @type {string[]} */ args) => (calls.push(args.slice(1)), { stdout: "", stderr: "" });
    await createChatRunner({ exec, nodeBin: "/node", cli: "/cli" }).start("chat-r02", "hi");
    return calls[0]?.[calls[0].indexOf("--cwd") + 1];
  };
  assert.equal(await started(chat), chat);
  assert.equal(await started(undefined), os.homedir());
  assert.equal(await started("chat"), os.homedir(), "a relative path");
  assert.equal(await started(path.join(base, "missing")), os.homedir());
  assert.equal(await started(path.join(base, "link")), os.homedir(), "a link");
  // One runner, as the bridge keeps: the folder is read again at each start.
  /** @type {string[][]} */
  const calls = [];
  const exec = async (/** @type {string} */ _file, /** @type {string[]} */ args) => (calls.push(args.slice(1)), { stdout: "", stderr: "" });
  const runner = createChatRunner({ exec, nodeBin: "/node", cli: "/cli" });
  process.env.RIVET_CHAT_DIR = chat;
  await runner.start("chat-r03", "hi");
  fs.rmSync(chat, { recursive: true });
  fs.symlinkSync(os.homedir(), chat);
  await runner.start("chat-r04", "hi");
  assert.deepEqual(calls.map((args) => args[args.indexOf("--cwd") + 1]), [chat, os.homedir()]);
});

test("a line is confirmed only when the screen moved and the box is empty", async () => {
  const line = "hello there, a line long enough";
  const ok = harness({ screens: [SCREEN(""), ["moved", ...SCREEN("")]] });
  assert.deepEqual(await ok.runner.send("site-fix", line), { confirmed: true, stages: ["accepted", "submitted"] });
  assert.deepEqual(ok.calls.find((c) => c.args[0] === "send"), { args: ["send", "site-fix", "--text-file", "-"], input: line });
  // An unchanged screen is an agent that has not read it.
  const still = harness({ screens: [SCREEN("")] });
  assert.deepEqual(await still.runner.send("site-fix", line), { confirmed: false, stages: ["accepted"] });
});

test("a line still in the input gets one more Enter", async () => {
  const line = "SWALLOW this line long enough";
  const { runner, calls } = harness({ screens: [SCREEN(""), SCREEN(line), SCREEN(line), SCREEN(line), ["moved", ...SCREEN("")]] });
  assert.equal((await runner.send("site-fix", line)).confirmed, true);
  assert.equal(calls.filter((c) => c.args.join(" ") === "send site-fix --text ").length, 1);
});

test("a chat that is not Claude is typed to and left unconfirmed", async () => {
  const { runner, calls } = harness({ rows: [{ ...ROW, provider: "codex" }] });
  assert.deepEqual(await runner.send("site-fix", "hi"), { confirmed: false, stages: ["accepted"] });
  assert.equal(calls.filter((c) => c.args[0] === "read").length, 0);
});

test("a runner listing that is not a list is an error", async () => {
  const exec = async () => ({ stdout: "{}", stderr: "" });
  await assert.rejects(createChatRunner({ exec, nodeBin: "/node", cli: "/cli" }).list(), /unexpected rivet-chat ls output/);
});
