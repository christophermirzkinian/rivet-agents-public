import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import * as runner from "../../scripts/chat-runner.mjs";
import { main, parseArgs, Usage } from "../../scripts/rivet-chat.mjs";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const skip = hasTmux ? false : "tmux is not installed";

let root;
let ctx;
let workdir;

const waitFor = async (fn, ms = 5_000) => {
  const until = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > until) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

before(() => {
  if (!hasTmux) return;
  // A short root: a unix socket path has a length limit.
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
  const home = path.join(root, "home");
  workdir = path.join(root, "work");
  fs.mkdirSync(home);
  fs.mkdirSync(workdir);
  const agent = path.join(root, "agent.sh");
  fs.writeFileSync(agent, '#!/bin/sh\necho "agent up: $*"\nwhile IFS= read -r line; do echo "got:$line"; done\n', { mode: 0o755 });
  const env = { PATH: process.env.PATH, HOME: home, TMUX_TMPDIR: root, SECRET_TOKEN: "not-for-the-pane" };
  ctx = runner.context({ env, home, socket: "rivet-chat-test", bins: { claude: agent, codex: agent } });
});

after(() => {
  if (!hasTmux) return;
  runner.tmux(ctx, ["kill-server"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("parseArgs refuses an unknown option and a value flag with no value", () => {
  assert.throws(() => parseArgs(["ls", "--nope"]), Usage);
  assert.throws(() => parseArgs(["send", "a", "--text"]), Usage);
  assert.deepEqual(parseArgs(["read", "a", "--lines", "5"]), { command: "read", args: ["a"], flags: { lines: "5" } });
});

test("launchFor puts the user's extra args first and the prompt after --", () => {
  const c = runner.context({ env: { RIVET_CLAUDE_ARGS: "--model x", TMUX_TMPDIR: os.tmpdir() }, socket: "unused" });
  assert.deepEqual(runner.launchFor(c, "claude", "logout"), { command: "claude", args: ["--model", "x", "--", "logout"] });
  assert.throws(() => runner.launchFor(c, "other"), /claude or codex/);
});

test("new, ls, send, read and close a chat on a throwaway socket", { skip }, async () => {
  const lines = [];
  const out = (line) => lines.push(line);
  assert.equal(await main(["new", "first", "--cwd", workdir, "--prompt", "hello there"], { ctx, out }), 0);
  assert.match(lines.at(-1), /^first running in /);

  const registry = fs.statSync(ctx.registry);
  assert.equal(registry.mode & 0o777, 0o600);

  await main(["ls", "--json"], { ctx, out });
  const rows = JSON.parse(lines.at(-1));
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.name, "first");
  assert.equal(row.session, "first");
  assert.equal(row.worktree, fs.realpathSync(workdir));
  assert.equal(row.repo, null);
  assert.equal(row.status, "running");
  assert.equal(row.state, "alive");
  assert.equal(row.provider, "claude");

  const started = await waitFor(() => runner.read(ctx, "first").includes("agent up: -- hello there"));
  assert.ok(started, runner.read(ctx, "first"));
  // The spec file removed itself, and the pane never saw a secret from the caller's environment.
  assert.deepEqual(fs.readdirSync(path.join(path.dirname(ctx.registry), "launch")), []);

  assert.equal(await main(["send", "first", "--text", "echo $SECRET_TOKEN"], { ctx, out }), 0);
  const got = await waitFor(() => /got:echo \$SECRET_TOKEN/.test(runner.read(ctx, "first")));
  assert.ok(got, runner.read(ctx, "first"));
  assert.doesNotMatch(runner.read(ctx, "first", { lines: 200 }), /not-for-the-pane/);

  await main(["read", "first", "--lines", "3"], { ctx, out });
  assert.ok(lines.at(-1).split("\n").length <= 3);

  await assert.rejects(main(["new", "first", "--cwd", workdir], { ctx, out }), /already a chat/);

  assert.equal(await main(["close", "first"], { ctx, out }), 0);
  assert.equal(lines.at(-1), "first finished");
  assert.equal(runner.sessions(ctx).has("first"), false);
  await main(["ls", "--json"], { ctx, out });
  const closed = JSON.parse(lines.at(-1))[0];
  assert.equal(closed.status, "finished");
  assert.equal(closed.state, "gone");
  assert.throws(() => runner.send(ctx, "first", "x"), /no tmux session/);
});

test("new refuses a missing directory and a bad name, and leaves no entry", { skip }, async () => {
  await assert.rejects(main(["new", "nodir", "--cwd", path.join(root, "missing")], { ctx }), /does not exist/);
  await assert.rejects(main(["new", "-bad"], { ctx, cwd: workdir }), /bad chat name/);
  assert.equal(runner.readRegistry(ctx).chats.nodir, undefined);
});

test("a registry that cannot be parsed refuses every write", { skip }, async () => {
  const c = runner.context({ env: ctx.env, home: path.join(root, "home2"), socket: "rivet-chat-test" });
  fs.mkdirSync(path.dirname(c.registry), { recursive: true });
  fs.writeFileSync(c.registry, "{not json");
  await assert.rejects(main(["new", "x", "--cwd", workdir], { ctx: c }), /cannot be parsed/);
});
