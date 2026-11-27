import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import * as runner from "../../scripts/chat-runner.mjs";
import { forcedLog } from "../lib/chat-guard.mjs";
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
  fs.writeFileSync(agent, '#!/bin/sh\necho "agent up as $RIVET_CHAT_NAME: $*"\nwhile IFS= read -r line; do echo "got:$line"; done\n', { mode: 0o755 });
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
  assert.throws(() => runner.launchFor(c, "other"), { message: "rivet-chat: --provider is claude, codex or copilot, not other" });
});

test("launchFor gives a Copilot chat its prompt as one option's value, after the user's extra args; only a hosted agent's allows every tool and path", () => {
  const env = { RIVET_COPILOT_ARGS: "--model z", RIVET_CLAUDE_ARGS: "--model x", RIVET_CODEX_NO_SANDBOX: "1", TMUX_TMPDIR: os.tmpdir() };
  const plain = runner.context({ env, socket: "unused" });
  assert.deepEqual([plain.bins.copilot, plain.bins["copilot-status"]], ["copilot", "copilot-status"]);
  assert.deepEqual(runner.launchFor(plain, "copilot", "hi"), { command: "copilot", args: ["--no-auto-update", "--disable-builtin-mcps", "--secret-env-vars=COPILOT_GITHUB_TOKEN", "--model", "z", "--interactive=hi"] });
  assert.deepEqual(runner.launchFor(plain, "copilot"), { command: "copilot", args: ["--no-auto-update", "--disable-builtin-mcps", "--secret-env-vars=COPILOT_GITHUB_TOKEN", "--model", "z"] });
  const hosted = runner.context({ env: { ...env, RIVET_AGENT_FILE: "/nonexistent/agent.json" }, socket: "unused", bins: { copilot: "/opt/copilot" } });
  assert.deepEqual(runner.launchFor(hosted, "copilot", "hi"), { command: "/opt/copilot", args: ["--allow-all-tools", "--allow-all-paths", "--no-auto-update", "--disable-builtin-mcps", "--secret-env-vars=COPILOT_GITHUB_TOKEN", "--model", "z", "--interactive=hi"] });
  assert.deepEqual(runner.launchFor(hosted, "copilot").args, ["--allow-all-tools", "--allow-all-paths", "--no-auto-update", "--disable-builtin-mcps", "--secret-env-vars=COPILOT_GITHUB_TOKEN", "--model", "z"]);
  const bare = runner.context({ env: { TMUX_TMPDIR: os.tmpdir(), RIVET_AGENT_FILE: "/nonexistent/agent.json" }, socket: "unused" });
  assert.deepEqual(runner.launchFor(bare, "copilot").args, ["--allow-all-tools", "--allow-all-paths", "--no-auto-update", "--disable-builtin-mcps", "--secret-env-vars=COPILOT_GITHUB_TOKEN"]);
  // A prompt that names a subcommand or a flag stays inside that one argument.
  for (const prompt of ["--help", "logout", "--allow-all-urls --yolo", "-- --yolo", "a=b"]) {
    for (const c of [plain, hosted]) {
      const { args } = runner.launchFor(c, "copilot", prompt);
      assert.deepEqual(args, [...runner.launchFor(c, "copilot").args, `--interactive=${prompt}`], prompt);
      assert.ok(!args.includes("--"), "no bare -- for Copilot");
    }
    assert.ok(!runner.launchFor(plain, "copilot", prompt).args.some((arg) => /^--allow|^--yolo/.test(arg)), `${prompt}: a chat that is not a hosted agent's allows nothing`);
  }
  assert.ok(!runner.launchFor(hosted, "copilot", "hi").args.some((arg) => /^--yolo$|^--allow-all$|^--allow-all-urls$/.test(arg)), "URLs it still asks about");
  assert.deepEqual([...runner.PROVIDERS], ["claude", "codex", "copilot"]);
});

test("a pane is given none of Copilot's own environment variables, and the runner's source names none", () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "scripts", "chat-runner.mjs"), "utf8");
  const list = /^const PANE_ENV = (\[[^\]]*\]);$/m.exec(text);
  assert.ok(list, "PANE_ENV is one list of names");
  const names = JSON.parse(list[1]);
  assert.ok(names.includes("PATH") && names.includes("HOME"));
  assert.deepEqual(names.filter((name) => /^COPILOT_|^GH_|^GITHUB_/.test(name)), []);
  for (const name of ["COPILOT_API_URL", "COPILOT_GITHUB_TOKEN", "COPILOT_DEBUG_GITHUB_API_URL", "COPILOT_AUTO_UPDATE"]) assert.ok(!text.includes(name), name);
  assert.deepEqual([...new Set(text.match(/[A-Z0-9_]*COPILOT_[A-Za-z0-9_]*/g) ?? [])], ["RIVET_COPILOT_ARGS"], "the one name with COPILOT_ in it is Rivet's own");
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

  const started = await waitFor(() => runner.read(ctx, "first").includes("agent up as first: -- hello there"));
  assert.ok(started, runner.read(ctx, "first"));
  // The pane knows its chat's name (RIVET_CHAT_NAME, which card add takes for --chat). The spec file removed itself, and
  // the pane never saw a secret from the caller's environment.
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

test("launchFor with no agent file is the command line it always was; a hosted Codex chat asks as Claude's does", () => {
  const env = { RIVET_CLAUDE_ARGS: "--model x", RIVET_CODEX_ARGS: "--model y", RIVET_CODEX_NO_SANDBOX: "1", TMUX_TMPDIR: os.tmpdir() };
  const plain = runner.context({ env, socket: "unused" });
  assert.deepEqual(runner.launchFor(plain, "claude", "hi"), { command: "claude", args: ["--model", "x", "--", "hi"] });
  assert.deepEqual(runner.launchFor(plain, "codex", "hi"), { command: "codex", args: ["--model", "y", "--", "hi"] });
  const hosted = runner.context({ env: { ...env, RIVET_AGENT_FILE: "/nonexistent/agent.json" }, socket: "unused" });
  assert.deepEqual(runner.launchFor(hosted, "claude", "hi"), { command: "claude", args: ["--model", "x", "--", "hi"] });
  const open = runner.launchFor(hosted, "codex", "hi").args;
  assert.deepEqual(open.slice(-8), ["--sandbox", "danger-full-access", "--ask-for-approval", "on-request", "--model", "y", "--", "hi"]);
  for (const setting of ["features.hooks=false", "features.computer_use=false", "features.multi_agent=false", "notify=[]"]) assert.ok(open.includes(setting), setting);
  const sandboxed = runner.context({ env: { TMUX_TMPDIR: os.tmpdir(), RIVET_AGENT_FILE: "/nonexistent/agent.json" }, socket: "unused" });
  assert.deepEqual(runner.launchFor(sandboxed, "codex").args.slice(-4), ["--sandbox", "read-only", "--ask-for-approval", "on-request"]);
});

test("a hosted agent's chat starts on its first plan and, at that plan's limit, asks once only when the other is signed in", { skip }, async () => {
  const home = path.join(root, "home3");
  fs.mkdirSync(home);
  const agentFile = path.join(root, "agent.json");
  fs.writeFileSync(agentFile, JSON.stringify({ firstPlan: "chatgpt" }));
  const limited = path.join(root, "limited.sh");
  fs.writeFileSync(limited, "#!/bin/sh\necho '■ You’ve hit your usage limit. Upgrade to Pro or try again at 3:05 PM.'\nwhile IFS= read -r line; do echo \"got:$line\"; done\n", { mode: 0o755 });
  const c = runner.context({ env: { ...ctx.env, HOME: home, RIVET_AGENT_FILE: agentFile }, home, socket: "rivet-chat-test", bins: { claude: ctx.bins.claude, codex: limited } });
  assert.equal(runner.create(c, { name: "plans", cwd: workdir }).provider, "codex");
  await waitFor(() => /usage limit/.test(runner.read(c, "plans")));
  const posts = [];
  const post = (ask) => posts.push(ask);
  const copilotOut = { code: 1, lines: ["Not connected"] };
  assert.deepEqual(await runner.limitCheck(c, { post, status: (_ctx, plan) => (plan === "copilot" ? copilotOut : { code: 0, lines: ['{"loggedIn": false}'] }) }), []);
  assert.deepEqual(await runner.limitCheck(c, { post, status: () => ({ code: null, lines: [] }) }), [], "a status that could not be read is not signed in, and asks nothing");
  assert.deepEqual(posts, []);
  const statuses = [];
  const signedIn = (_ctx, plan) => (statuses.push(plan), { code: 0, lines: ['{"loggedIn": true}'] });
  const asked = await runner.limitCheck(c, { post, status: signedIn });
  assert.deepEqual(statuses, ["claude"], "the first signed in is the one offered, and no later plan's status is read");
  assert.equal(asked.length, 1);
  assert.deepEqual(posts, asked);
  assert.equal(asked[0].text, "ChatGPT is at its limit until 3:05 pm. Chat plans waits for it. Claude is ready: ask your agent to start a new chat on Claude. New chats start on the plan that goes first: change it on the Plans page.");
  const firstSeen = runner.readRegistry(c).chats.plans.limitSeen.at;
  assert.equal(asked[0].since, firstSeen, "since is when the screen first showed this limit, before any ask");
  assert.deepEqual(await runner.limitCheck(c, { post, status: signedIn }), [], "asked once");
  // A post the board never took asks again with the same since, so the card it may have made is found, not doubled.
  const fresh = runner.context({ env: c.env, home, socket: "rivet-chat-test", bins: c.bins, now: () => Date.now() + 86_400_000 });
  runner.withRegistry(fresh, (doc) => void delete doc.chats.plans.limitAsked);
  assert.deepEqual(await runner.limitCheck(fresh, { post: () => Promise.reject(new Error("not taken")), status: signedIn }), [], "a post that throws is logged, not thrown");
  const again = await runner.limitCheck(fresh, { post, status: signedIn });
  assert.equal(again[0].since, firstSeen, "the next day too");
  // A limit that clears and comes back is a new one, with a new since, though it says the same.
  runner.withRegistry(fresh, (doc) => void delete doc.chats.plans.limitSeen);
  runner.withRegistry(fresh, (doc) => void delete doc.chats.plans.limitAsked);
  const later = await runner.limitCheck(fresh, { post, status: signedIn });
  assert.notEqual(later[0].since, firstSeen);
  // A post that throws for one chat leaves the next to be asked, and its own chat is asked again next time.
  fs.writeFileSync(agentFile, JSON.stringify({ firstPlan: "chatgpt", name: "Pip" }));
  assert.equal(runner.create(c, { name: "plans2", cwd: workdir }).provider, "codex");
  await waitFor(() => /usage limit/.test(runner.read(c, "plans2")));
  runner.withRegistry(c, (doc) => void delete doc.chats.plans.limitAsked);
  const tried = [];
  const posted = await runner.limitCheck(c, {
    post: (ask) => {
      tried.push(ask.name);
      if (ask.name === "plans") throw new Error("board down");
    },
    status: signedIn,
  });
  assert.deepEqual(tried.sort(), ["plans", "plans2"]);
  assert.deepEqual(posted.map((ask) => ask.name), ["plans2"]);
  assert.match(posted[0].text, /ask Pip to start a new chat on Claude/);
  assert.equal(posted[0].chat, `plans2 ${runner.readRegistry(c).chats.plans2.started}`);
  assert.equal(runner.readRegistry(c).chats.plans.limitAsked, undefined);
  runner.close(c, "plans2");
  assert.equal(runner.list(c).find((one) => one.name === "plans").provider, "codex", "never moved to the other plan");
  runner.close(c, "plans");

  const plain = runner.context({ env: { ...ctx.env, HOME: home }, home, socket: "rivet-chat-test", bins: { claude: limited, codex: limited } });
  assert.equal(runner.create(plain, { name: "plain", cwd: workdir }).provider, "claude");
  assert.deepEqual(await runner.limitCheck(plain, { post: () => assert.fail("no agent file posts nothing"), status: () => assert.fail("nor reads a status") }), []);
  runner.close(plain, "plain");
});

test("a hosted agent's chat whose plan is signed out starts nothing and says so; one it cannot tell about starts as before", { skip }, async () => {
  const home = path.join(root, "home4");
  fs.mkdirSync(home);
  const agentFile = path.join(root, "agent-out.json");
  fs.writeFileSync(agentFile, JSON.stringify({ firstPlan: "claude" }));
  const reads = path.join(root, "status-reads");
  // A CLI that answers its status as `status` says, noting the folder it was asked in, and is otherwise the agent.
  const cli = (name, status) => {
    const file = path.join(root, `${name}.sh`);
    fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = auth ] || [ "$1" = login ]; then pwd >> ${reads}; ${status}; fi\necho "agent up as $RIVET_CHAT_NAME: $*"\nwhile IFS= read -r line; do echo "got:$line"; done\n`, { mode: 0o755 });
    return file;
  };
  const claudeOut = cli("claude-out", `echo '{"loggedIn": false}'; exit 1`);
  const claudeOn = cli("claude-on", `echo '{"loggedIn": true}'; exit 0`);
  const codexOut = cli("codex-out", "echo 'Not logged in' >&2; exit 1");
  const codexOn = cli("codex-on", "echo 'Logged in using ChatGPT'; exit 0");
  // No Copilot on this machine: a copilot-status that is not there, never one the machine running the test may have.
  const noCopilot = path.join(root, "no-copilot-status");
  const hosted = (bins) => runner.context({ env: { ...ctx.env, HOME: home, RIVET_AGENT_FILE: agentFile }, home, socket: "rivet-chat-test", bins: { "copilot-status": noCopilot, ...bins } });
  const nothingStarted = (c, name) => {
    assert.equal(runner.readRegistry(c).chats[name], undefined, `${name} has no registry entry`);
    assert.equal(runner.sessions(c).has(name), false, `${name} has no tmux session`);
  };

  const both = hosted({ claude: claudeOut, codex: codexOut });
  await assert.rejects(main(["new", "out-1", "--cwd", workdir, "--prompt", "hello there"], { ctx: both }), { message: "rivet-chat: no chat started. Claude isn't connected. Connect Claude or ChatGPT on the Plans page." });
  nothingStarted(both, "out-1");
  assert.deepEqual([...new Set(fs.readFileSync(reads, "utf8").trim().split("\n"))], [fs.realpathSync(home)], "a status is read from the home folder, never the chat's own");
  assert.throws(() => runner.create(both, { name: "out-1b", cwd: workdir, provider: "codex" }), { message: "rivet-chat: no chat started. ChatGPT isn't connected. Connect Claude or ChatGPT on the Plans page." }, "a machine with no copilot-status names the two plans it can connect");
  nothingStarted(both, "out-1b");

  // A machine that has copilot-status can connect GitHub Copilot, so the words name it: signed out, or with no answer.
  const copilotStatus = (name, answer) => {
    const file = path.join(root, `${name}.sh`);
    fs.writeFileSync(file, `#!/bin/sh\n${answer}\n`, { mode: 0o755 });
    return file;
  };
  const three = hosted({ claude: claudeOut, codex: codexOut, "copilot-status": copilotStatus("copilot-status-out-4", "echo 'Not connected'; exit 1") });
  assert.throws(() => runner.create(three, { name: "out-1c", cwd: workdir }), { message: "rivet-chat: no chat started. Claude isn't connected. Connect Claude, ChatGPT or GitHub Copilot on the Plans page." });
  nothingStarted(three, "out-1c");
  assert.throws(() => runner.create(three, { name: "out-1d", cwd: workdir, provider: "codex" }), { message: "rivet-chat: no chat started. ChatGPT isn't connected. Connect Claude, ChatGPT or GitHub Copilot on the Plans page." });
  const unsure = hosted({ claude: claudeOut, codex: codexOut, "copilot-status": copilotStatus("copilot-status-unsure-4", "exit 3") });
  assert.throws(() => runner.create(unsure, { name: "out-1e", cwd: workdir }), { message: "rivet-chat: no chat started. Claude isn't connected. Connect Claude, ChatGPT or GitHub Copilot on the Plans page." }, "only a copilot-status that is not there takes GitHub Copilot off the words");

  const other = hosted({ claude: claudeOut, codex: codexOn });
  assert.throws(() => runner.create(other, { name: "out-2", cwd: workdir }), { message: "rivet-chat: no chat started. Claude isn't connected. Connect Claude, or make ChatGPT first, on the Plans page." });
  nothingStarted(other, "out-2");
  assert.deepEqual(runner.list(other), [], "and none on the other plan in its place");

  const named = hosted({ claude: claudeOn, codex: codexOut });
  assert.throws(() => runner.create(named, { name: "out-3", cwd: workdir, provider: "codex" }), { message: "rivet-chat: no chat started. ChatGPT isn't connected. Connect ChatGPT on the Plans page. Claude goes first and is connected." });
  nothingStarted(named, "out-3");

  for (const [name, status] of [["unknown-1", "echo 'not json'; exit 1"], ["unknown-2", "sleep 0; exit 3"], ["on-1", `echo '{"loggedIn": true}'; exit 0`]]) {
    fs.rmSync(reads, { force: true });
    const c = hosted({ claude: cli(`claude-${name}`, status), codex: codexOut });
    assert.equal(runner.create(c, { name, cwd: workdir }).status, "running", `${name}: only a definite signed-out answer refuses`);
    assert.equal(fs.readFileSync(reads, "utf8").trim(), fs.realpathSync(home), `${name}: its status was read once, and the other plan's not at all`);
    runner.close(c, name);
  }

  fs.rmSync(reads, { force: true });
  const plain = runner.context({ env: { ...ctx.env, HOME: home }, home, socket: "rivet-chat-test", bins: { claude: claudeOut, codex: codexOut } });
  assert.equal(runner.create(plain, { name: "plain-out", cwd: workdir }).provider, "claude");
  assert.equal(fs.existsSync(reads), false, "with no agent file no status is read");
  runner.close(plain, "plain-out");
});

test("a hosted agent's Copilot chat starts on copilot with every tool and path allowed, its sign-in read from copilot-status; signed out, it starts nothing", { skip }, async () => {
  const home = path.join(root, "home5");
  fs.mkdirSync(home);
  const agentFile = path.join(root, "agent-copilot.json");
  fs.writeFileSync(agentFile, JSON.stringify({ firstPlan: "copilot" }));
  const reads = path.join(root, "copilot-reads");
  const script = (name, body) => {
    const file = path.join(root, `${name}.sh`);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  // A fake copilot-status: it notes the folder it was asked in, its arguments and how many COPILOT_ variables it was given.
  const status = (name, answer) => script(name, `echo "$(pwd)|$#|$(env | grep -c '^COPILOT_')" >> ${reads}; ${answer}`);
  const agentUp = 'echo "agent up as $RIVET_CHAT_NAME: $* [$(env | grep -c \'^COPILOT_\') copilot vars]"\nwhile IFS= read -r line; do echo "got:$line"; done';
  const cli = (name, answer) => script(name, `if [ "$1" = auth ] || [ "$1" = login ]; then ${answer}; fi\n${agentUp}`);
  const copilot = script("copilot-agent", agentUp);
  const copilotOn = status("copilot-status-on", "exit 0");
  const copilotOut = status("copilot-status-out", "echo 'Not connected'; exit 1");
  const claudeOut = cli("claude-out-5", `echo '{"loggedIn": false}'; exit 1`);
  const claudeOn = cli("claude-on-5", `echo '{"loggedIn": true}'; exit 0`);
  const codexOut = cli("codex-out-5", "echo 'Not logged in' >&2; exit 1");
  const codexOn = cli("codex-on-5", "echo 'Logged in using ChatGPT'; exit 0");
  // The caller's environment holds Copilot's own variables; none is the runner's to pass on.
  const callerEnv = { ...ctx.env, HOME: home, COPILOT_API_URL: "http://127.0.0.1:9", COPILOT_GITHUB_TOKEN: "not-for-the-pane", COPILOT_AUTO_UPDATE: "1" };
  const hosted = (bins) => runner.context({ env: { ...callerEnv, RIVET_AGENT_FILE: agentFile }, home, socket: "rivet-chat-test", bins: { copilot, ...bins } });
  const nothingStarted = (c, name) => {
    assert.equal(runner.readRegistry(c).chats[name], undefined, `${name} has no registry entry`);
    assert.equal(runner.sessions(c).has(name), false, `${name} has no tmux session`);
  };

  const on = hosted({ claude: claudeOut, codex: codexOut, "copilot-status": copilotOn });
  const entry = runner.create(on, { name: "cp-1", cwd: workdir, prompt: "hello there" });
  assert.deepEqual([entry.provider, entry.status], ["copilot", "running"], "with no provider named, the plan that goes first");
  assert.equal(fs.readFileSync(reads, "utf8").trim(), `${fs.realpathSync(home)}|0|0`, "copilot-status is run once, in the home folder, with no arguments and none of Copilot's variables");
  const up = "agent up as cp-1: --allow-all-tools --allow-all-paths --no-auto-update --disable-builtin-mcps --secret-env-vars=COPILOT_GITHUB_TOKEN --interactive=hello there [0 copilot vars]";
  assert.ok(await waitFor(() => runner.read(on, "cp-1").replace(/\n/g, "").includes(up.replace(/\n/g, ""))), runner.read(on, "cp-1"));
  assert.doesNotMatch(runner.read(on, "cp-1", { lines: 200 }), /not-for-the-pane/);
  assert.equal(await main(["new", "cp-2", "--cwd", workdir, "--provider", "copilot", "--prompt", "--help"], { ctx: on, out: () => {} }), 0);
  assert.ok(await waitFor(() => runner.read(on, "cp-2").replace(/\n/g, "").includes("--disable-builtin-mcps --secret-env-vars=COPILOT_GITHUB_TOKEN --interactive=--help [0 copilot vars]")), runner.read(on, "cp-2"));
  assert.equal(runner.list(on).find((one) => one.name === "cp-2").provider, "copilot");
  for (const name of ["cp-1", "cp-2"]) runner.close(on, name);

  const out = hosted({ claude: claudeOut, codex: codexOut, "copilot-status": copilotOut });
  await assert.rejects(main(["new", "cp-out-1", "--cwd", workdir, "--provider", "copilot", "--prompt", "hello there"], { ctx: out }), { message: "rivet-chat: no chat started. GitHub Copilot isn't connected. Connect Claude, ChatGPT or GitHub Copilot on the Plans page." });
  nothingStarted(out, "cp-out-1");
  const one = hosted({ claude: claudeOut, codex: codexOn, "copilot-status": copilotOut });
  assert.throws(() => runner.create(one, { name: "cp-out-2", cwd: workdir }), { message: "rivet-chat: no chat started. GitHub Copilot isn't connected. Connect GitHub Copilot, or make ChatGPT first, on the Plans page." });
  nothingStarted(one, "cp-out-2");
  const two = hosted({ claude: claudeOn, codex: codexOn, "copilot-status": copilotOut });
  assert.throws(() => runner.create(two, { name: "cp-out-3", cwd: workdir }), { message: "rivet-chat: no chat started. GitHub Copilot isn't connected. Connect GitHub Copilot, or make Claude or ChatGPT first, on the Plans page." });
  nothingStarted(two, "cp-out-3");
  assert.deepEqual(runner.list(two).filter((one) => one.status === "running"), [], "and none on another plan in its place");

  // Copilot as another plan: connected, the words name it; and a plan named for one chat is the one checked.
  fs.writeFileSync(agentFile, JSON.stringify({ firstPlan: "claude" }));
  const claudeFirst = hosted({ claude: claudeOut, codex: codexOut, "copilot-status": copilotOn });
  assert.throws(() => runner.create(claudeFirst, { name: "cp-out-4", cwd: workdir }), { message: "rivet-chat: no chat started. Claude isn't connected. Connect Claude, or make GitHub Copilot first, on the Plans page." });
  const both = hosted({ claude: claudeOut, codex: codexOn, "copilot-status": copilotOn });
  assert.throws(() => runner.create(both, { name: "cp-out-5", cwd: workdir }), { message: "rivet-chat: no chat started. Claude isn't connected. Connect Claude, or make ChatGPT or GitHub Copilot first, on the Plans page." });
  const named = hosted({ claude: claudeOn, codex: codexOut, "copilot-status": copilotOut });
  assert.throws(() => runner.create(named, { name: "cp-out-6", cwd: workdir, provider: "copilot" }), { message: "rivet-chat: no chat started. GitHub Copilot isn't connected. Connect GitHub Copilot on the Plans page. Claude goes first and is connected." });
  for (const name of ["cp-out-4", "cp-out-5", "cp-out-6"]) nothingStarted(named, name);

  // Only exit 1 with the line "Not connected" is signed out; any other answer, or no copilot-status, starts the chat.
  fs.writeFileSync(agentFile, JSON.stringify({ firstPlan: "copilot" }));
  for (const [name, answer] of [["cp-unknown-1", "echo 'Not connected'; exit 2"], ["cp-unknown-2", "echo 'Error: keychain locked'; exit 1"], ["cp-unknown-3", "exit 1"]]) {
    fs.rmSync(reads, { force: true });
    const c = hosted({ claude: claudeOn, codex: codexOn, "copilot-status": status(`status-${name}`, answer) });
    assert.equal(runner.create(c, { name, cwd: workdir }).provider, "copilot", `${name}: only a definite signed-out answer refuses`);
    assert.equal(fs.readFileSync(reads, "utf8").trim(), `${fs.realpathSync(home)}|0|0`, `${name}: its status was read once`);
    runner.close(c, name);
  }
  const absent = hosted({ claude: claudeOn, codex: codexOn, "copilot-status": path.join(root, "no-copilot-status") });
  assert.equal(runner.create(absent, { name: "cp-absent", cwd: workdir }).provider, "copilot");
  runner.close(absent, "cp-absent");

  // With no agent file: no status is read and nothing is allowed.
  fs.rmSync(reads, { force: true });
  const plain = runner.context({ env: callerEnv, home, socket: "rivet-chat-test", bins: { claude: claudeOut, codex: codexOut, copilot, "copilot-status": copilotOut } });
  assert.equal(runner.create(plain, { name: "cp-plain", cwd: workdir, provider: "copilot", prompt: "logout" }).provider, "copilot");
  assert.ok(await waitFor(() => runner.read(plain, "cp-plain").replace(/\n/g, "").includes("agent up as cp-plain: --no-auto-update --disable-builtin-mcps --secret-env-vars=COPILOT_GITHUB_TOKEN --interactive=logout [0 copilot vars]")), runner.read(plain, "cp-plain"));
  assert.equal(fs.existsSync(reads), false, "with no agent file no status is read");
  assert.equal(runner.create(plain, { name: "cp-default", cwd: workdir }).provider, "claude", "and a chat with no provider named is Claude's");
  for (const name of ["cp-plain", "cp-default"]) runner.close(plain, name);
});

test("at a plan's limit the chat's card names the first other plan that is signed in, GitHub Copilot when it is the one; a Copilot chat's limit is never read", { skip }, async () => {
  const home = path.join(root, "home6");
  fs.mkdirSync(home);
  const agentFile = path.join(root, "agent-limit.json");
  fs.writeFileSync(agentFile, JSON.stringify({ firstPlan: "chatgpt" }));
  const limited = path.join(root, "limited-6.sh");
  fs.writeFileSync(limited, "#!/bin/sh\necho '■ You’ve hit your usage limit. Upgrade to Pro or try again at 3:05 PM.'\nwhile IFS= read -r line; do echo \"got:$line\"; done\n", { mode: 0o755 });
  const statusOn = path.join(root, "copilot-status-on-6.sh");
  fs.writeFileSync(statusOn, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const c = runner.context({ env: { ...ctx.env, HOME: home, RIVET_AGENT_FILE: agentFile }, home, socket: "rivet-chat-test", bins: { claude: ctx.bins.claude, codex: limited, copilot: limited, "copilot-status": statusOn } });
  assert.equal(runner.create(c, { name: "lim-1", cwd: workdir }).provider, "codex");
  await waitFor(() => /usage limit/.test(runner.read(c, "lim-1")));
  const ON = { claude: { code: 0, lines: ['{"loggedIn": true}'] }, chatgpt: { code: 0, lines: ["Logged in using ChatGPT"] }, copilot: { code: 0, lines: [] } };
  const OUT = { claude: { code: 1, lines: ['{"loggedIn": false}'] }, chatgpt: { code: 1, lines: ["Not logged in"] }, copilot: { code: 1, lines: ["Not connected"] } };
  const reader = (answers, statuses = []) => Object.assign((_ctx, plan) => (statuses.push(plan), answers[plan]), { statuses });
  const posts = [];
  const post = (ask) => posts.push(ask);

  const none = reader(OUT);
  assert.deepEqual(await runner.limitCheck(c, { post, status: none }), []);
  assert.deepEqual(none.statuses, ["claude", "copilot"], "each other plan, in their order");
  const unknown = reader({ claude: OUT.claude, copilot: { code: 2, lines: ["Not connected"] } });
  assert.deepEqual(await runner.limitCheck(c, { post, status: unknown }), [], "a Copilot it cannot tell about is not offered");
  assert.deepEqual(posts, []);

  const copilotOnly = reader({ ...OUT, copilot: ON.copilot });
  const asked = await runner.limitCheck(c, { post, status: copilotOnly });
  assert.deepEqual(copilotOnly.statuses, ["claude", "copilot"]);
  assert.deepEqual(asked.map((ask) => [ask.name, ask.plan, ask.until]), [["lim-1", "chatgpt", "3:05 pm"]]);
  assert.equal(asked[0].text, "ChatGPT is at its limit until 3:05 pm. Chat lim-1 waits for it. GitHub Copilot is ready: ask your agent to start a new chat on GitHub Copilot. New chats start on the plan that goes first: change it on the Plans page.");
  assert.deepEqual(posts, asked);
  assert.deepEqual(await runner.limitCheck(c, { post, status: copilotOnly }), [], "asked once");
  runner.withRegistry(c, (doc) => void delete doc.chats["lim-1"].limitAsked);
  const bothOn = reader(ON);
  const again = await runner.limitCheck(c, { post, status: bothOn });
  assert.deepEqual(bothOn.statuses, ["claude"], "Claude comes first, and Copilot's status is not read");
  assert.match(again[0].text, /Claude is ready: ask your agent to start a new chat on Claude\./);
  assert.equal(runner.list(c).find((one) => one.name === "lim-1").provider, "codex", "never moved to another plan");
  runner.close(c, "lim-1");

  // A Copilot chat whose screen shows another plan's limit words: Copilot's limit is not read, so no status is and no card is made.
  assert.equal(runner.create(c, { name: "lim-2", cwd: workdir, provider: "copilot" }).provider, "copilot");
  await waitFor(() => /usage limit/.test(runner.read(c, "lim-2")));
  assert.deepEqual(await runner.limitCheck(c, { post: () => assert.fail("a Copilot chat posts nothing"), status: () => assert.fail("nor reads a status") }), []);
  assert.equal(runner.readRegistry(c).chats["lim-2"].limitAsked, undefined);
  runner.close(c, "lim-2");
});

test("projectLists: RIVET_PROJECTS_FILE's list, else one project per work clone, each its RIVET_REPOS repo", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rc-lists-"));
  for (const name of ["trip-planner", "recipe-box"]) fs.mkdirSync(path.join(home, ".rivet-agents", "work", name), { recursive: true });
  const lists = runner.projectLists({ RIVET_REPOS: "example-org/trip-planner" }, home);
  assert.deepEqual(lists.projects.map((p) => [p.id, p.githubRepo]), [["recipe-box", null], ["trip-planner", "example-org/trip-planner"], ["general", null]]);
  assert.deepEqual([lists.products, lists.worktreeRoots], [[], []]);
  const file = path.join(home, "lists.json");
  fs.writeFileSync(file, JSON.stringify([{ id: "notes", name: "Notes", workspaceRepo: "notes", githubRepo: "example-org/notes", folder: null, words: ["notebook"], paths: [], appOnly: false }]));
  assert.deepEqual(runner.projectLists({ RIVET_PROJECTS_FILE: file }, home).projects.map((p) => p.id), ["notes", "general"]);
});

test("create given a repo refuses a prompt that plainly belongs to another repo's project; --force-project opens and logs it once, after the chat runs", { skip }, () => {
  const home = fs.mkdtempSync(path.join(root, "guard-"));
  for (const name of ["trip-planner", "recipe-box"]) fs.mkdirSync(path.join(home, ".rivet-agents", "work", name), { recursive: true });
  const said = [];
  const c = runner.context({ env: { ...ctx.env, HOME: home }, home, socket: "rivet-chat-test", bins: ctx.bins, log: (line) => said.push(line) });
  const log = forcedLog(home);
  const start = (name, more) => runner.create(c, { name, cwd: workdir, prompt: "pack the trip planner bags", repo: "example-org/recipe-box", ...more });
  assert.throws(() => start("bags-1", {}), /^Error: rivet-chat: This ask matches trip-planner \(.+\), not example-org\/recipe-box\. Use --force-project "<reason>" to open it there anyway\.$/);
  assert.equal(runner.readRegistry(c).chats["bags-1"], undefined);
  assert.throws(() => start("bags-1", { forceProject: " " }), /--force-project needs a reason/);
  start("bags-1", { forceProject: "shared bags" });
  const lines = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map(({ time, ...rest }) => rest), [{ chat: "bags-1", forced: "example-org/recipe-box", routed: "trip-planner", reason: "shared bags" }]);
  // Its caller logged it; and with no repo and a cwd in no clone, or the routed repo, there is no check.
  start("bags-2", { forceProject: "shared bags", forceLogged: true });
  start("bags-3", { repo: undefined });
  start("bags-4", { repo: "example-org/trip-planner" });
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1);
  // A log that cannot be written never undoes the open.
  fs.rmSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(path.dirname(log), "");
  assert.equal(start("bags-5", { forceProject: "shared bags" }).status, "running");
  assert.ok(said.some((line) => /bags-5's forced open was not logged/.test(line)), said.join("\n"));
  for (const name of ["bags-1", "bags-2", "bags-3", "bags-4", "bags-5"]) runner.close(c, name);
});

test("new with no repo is guarded as the work clone its cwd is in; --force-project opens it and logs it once", { skip }, async () => {
  const home = fs.mkdtempSync(path.join(root, "clone-"));
  const clone = (name) => path.join(home, ".rivet-agents", "work", name);
  for (const name of ["trip-planner", "recipe-box"]) fs.mkdirSync(path.join(clone(name), "src"), { recursive: true });
  const c = runner.context({ env: { ...ctx.env, HOME: home }, home, socket: "rivet-chat-test", bins: ctx.bins, log: () => {} });
  await assert.rejects(main(["new", "pack-1", "--cwd", path.join(clone("recipe-box"), "src"), "--prompt", "pack the trip planner bags"], { ctx: c, out: () => {} }), /This ask matches trip-planner \(.+\), not recipe-box\./);
  assert.equal(runner.readRegistry(c).chats["pack-1"], undefined);
  await main(["new", "pack-2", "--cwd", clone("trip-planner"), "--prompt", "pack the trip planner bags"], { ctx: c, out: () => {} });
  assert.equal(runner.create(c, { name: "pack-1", cwd: clone("recipe-box"), prompt: "pack the trip planner bags", forceProject: "shared bags" }).status, "running");
  const lines = fs.readFileSync(forcedLog(home), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map(({ time, ...rest }) => rest), [{ chat: "pack-1", forced: "recipe-box", routed: "trip-planner", reason: "shared bags" }]);
  for (const name of ["pack-1", "pack-2"]) runner.close(c, name);
});

test("the cwd's own project is checked even with a repo named, a ~/ folder counts, and a clone's folder outranks its origin", { skip }, () => {
  const home = fs.mkdtempSync(path.join(root, "own-"));
  const clone = (name) => path.join(home, ".rivet-agents", "work", name);
  for (const name of ["trip-planner", "recipe-box"]) fs.mkdirSync(clone(name), { recursive: true });
  const c = runner.context({ env: { ...ctx.env, HOME: home }, home, socket: "rivet-chat-test", bins: ctx.bins, log: () => {} });
  // A repo that fits the ask never lets a chat open in another project's folder.
  assert.throws(() => runner.create(c, { name: "own-1", cwd: clone("recipe-box"), repo: "trip-planner", prompt: "pack the trip planner bags" }), /This ask matches trip-planner \(.+\), not recipe-box\./);
  // When the named repo and the folder both mismatch, a forced open logs the folder the chat runs in.
  runner.create(c, { name: "own-5", cwd: clone("recipe-box"), repo: "example-org/notes", prompt: "pack the trip planner bags", forceProject: "shared notes" });
  assert.equal(JSON.parse(fs.readFileSync(forcedLog(home), "utf8").trim()).forced, "recipe-box");
  // A clone whose origin names another repo is still its folder's project.
  assert.equal(spawnSync("git", ["init", "-q", clone("recipe-box")]).status, 0);
  assert.equal(spawnSync("git", ["-C", clone("recipe-box"), "remote", "add", "origin", "https://github.com/example-org/cookbook.git"]).status, 0);
  assert.equal(runner.create(c, { name: "own-2", cwd: clone("recipe-box"), prompt: "in recipe-box fix the header" }).status, "running");
  // Folders written from home.
  const routes = path.join(home, "routes");
  for (const name of ["trip-planner", "recipe-box"]) fs.mkdirSync(path.join(routes, name), { recursive: true });
  const file = path.join(home, "route-list.json");
  const entry = (id, words) => ({ id, name: id, workspaceRepo: id, githubRepo: null, folder: `~/routes/${id}`, words, paths: [], appOnly: false });
  fs.writeFileSync(file, JSON.stringify([entry("recipe-box", ["recipe box"]), entry("trip-planner", ["trip planner"])]));
  const t = runner.context({ env: { ...ctx.env, HOME: home, RIVET_PROJECTS_FILE: file }, home, socket: "rivet-chat-test", bins: ctx.bins, log: () => {} });
  assert.throws(() => runner.create(t, { name: "own-3", cwd: path.join(routes, "recipe-box"), prompt: "pack the trip planner bags" }), /This ask matches trip-planner \(.+\), not recipe-box\./);
  // A sub-folder whose name starts with two dots is still inside its project's folder.
  fs.mkdirSync(path.join(routes, "recipe-box", "..notes"));
  assert.throws(() => runner.create(t, { name: "own-4", cwd: path.join(routes, "recipe-box", "..notes"), prompt: "pack the trip planner bags" }), /This ask matches trip-planner \(.+\), not recipe-box\./);
  for (const name of ["own-2", "own-5"]) runner.close(c, name);
});
