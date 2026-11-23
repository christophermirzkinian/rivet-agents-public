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
  assert.deepEqual(await runner.limitCheck(c, { post, status: () => ({ code: 0, lines: ['{"loggedIn": false}'] }) }), []);
  assert.deepEqual(await runner.limitCheck(c, { post, status: () => ({ code: null, lines: [] }) }), [], "a status that could not be read is not signed in, and asks nothing");
  assert.deepEqual(posts, []);
  const statuses = [];
  const signedIn = (_ctx, plan) => (statuses.push(plan), { code: 0, lines: ['{"loggedIn": true}'] });
  const asked = await runner.limitCheck(c, { post, status: signedIn });
  assert.deepEqual(statuses, ["claude"]);
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
