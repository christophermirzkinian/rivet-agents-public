import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { socketPathFor } from "../../scripts/chat-runner.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const READERS = [
  { job: "chat-watch", script: "chat-watch.mjs" },
  { job: "ci-triage", script: "ci-triage.mjs" },
  { job: "issue-recheck", script: "issue-recheck.mjs" },
  { job: "fly-errors", script: "fly-errors.mjs" },
  { job: "memory-check", script: "memory-check.mjs" },
  { job: "weekly-learned", script: "weekly-learned.mjs", args: ["record"] },
];
const CLIS = ["claude", "gh", "git", "flyctl", "tmux", "launchctl"];

/** What each stand-in CLI prints. It runs inside the stand-in, so it brings its own requires. */
function answers(name, args) {
  const fs = require("node:fs");
  const path = require("node:path");
  const head = "a1".repeat(20);
  if (name === "claude") return JSON.stringify({ is_error: false, result: "{}", usage: { input_tokens: 10, output_tokens: 5 } });
  if (name === "flyctl") {
    const line = (level, message, ago) => JSON.stringify({ level, instance: "e286", message, timestamp: new Date(Date.now() - ago).toISOString(), meta: {} });
    // The first read of an app holds back its first lines, as what opened them is out of sight.
    const filler = Array.from({ length: 100 }, (_, i) => line("info", `the sync loop ran ${i}`, 2000));
    return `${filler.join("\n")}\n${line("error", "the sync loop failed", 1000)}\n`;
  }
  if (name === "tmux") {
    if (args.includes("list-sessions")) return "sam\n";
    if (args.includes("list-panes")) return "%1 0 123\n";
    if (args.includes("capture-pane")) return "╭─ top\n✽ Building the sync\n";
    const format = args.at(-1);
    return format === "#{@rivet_chat}" ? "sam\n" : format === "#{window_activity}" ? "1800000000\n" : "◐ x\n";
  }
  if (name === "git") {
    const at = args[0] === "-C" ? args.slice(2) : args;
    if (at[0] === "rev-parse") return `${head}\n`;
    if (at[0] === "ls-tree") return `100644 blob ${"b2".repeat(20)}\tREADME.md\0`;
    if (at[0] === "count-objects") return "packs: 0\n";
    return "";
  }
  const at = args[0] === "-R" ? args.slice(2) : args;
  if (at[0] === "repo") {
    fs.mkdirSync(path.join(at[3], ".git"), { recursive: true });
    return "";
  }
  if (at[0] === "issue") return JSON.stringify([{ number: 1, title: "Sync drops rows", body: "", labels: [], createdAt: "2026-01-01T00:00:00Z" }]);
  if (at.includes("--jq")) return "main\n";
  if (at.includes("-i")) {
    const runs = { workflow_runs: [{ id: 7, name: "Build", created_at: "2026-01-01T00:00:00Z", head_sha: head, run_attempt: 1, status: "completed", conclusion: "failure" }] };
    return `HTTP/2.0 200 OK\r\netag: "e"\r\n\r\n${JSON.stringify(at.at(-1).includes("/pulls") ? [] : runs)}`;
  }
  if (at.includes("--slurp")) return JSON.stringify([{ jobs: [{ id: 9, name: "test", conclusion: "failure", runner_name: "r1", steps: [{ number: 1, name: "run", conclusion: "failure" }] }] }]);
  return "2026-01-01T00:00:00Z running\n2026-01-01T00:00:01Z Error: an assertion failed\n";
}

/** A folder of stand-in CLIs that log every call to calls.log. */
function fakeBin(dir) {
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "answers.js"), `module.exports = ${answers.toString()};\n`);
  for (const name of CLIS) {
    const reads = name === "claude" ? 'require("node:fs").readFileSync(0);' : "";
    const body = `#!${process.execPath}
${reads}
require("node:fs").appendFileSync(require("node:path").join(__dirname, "calls.log"), ${JSON.stringify(name)} + " " + process.argv.slice(2).join(" ") + "\\n");
process.stdout.write(require("./answers.js")(${JSON.stringify(name)}, process.argv.slice(2)));
`;
    fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
  }
}

/** The stand-in server: an empty board, and an empty answer to the rest. */
let server;
let url;
before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/api/board")) res.setHeader("etag", '"1"');
    res.end(JSON.stringify(req.url.startsWith("/api/board") ? { version: 1, board: { chats: [], needs: [] } } : { statuses: [], replies: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** A home with stand-in CLIs, a memory folder with a note, and one running chat in the runner's registry. */
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "readers-gate-"));
  const bin = path.join(home, "bin");
  fakeBin(bin);
  const memory = path.join(home, "memory");
  fs.mkdirSync(memory);
  fs.writeFileSync(path.join(memory, "topic.md"), "The sync lives in `src/gone-file.ts`.\n");
  const socketPath = socketPathFor({}, "rivet-chat");
  const chats = path.join(home, ".rivet-agents", "chats");
  fs.mkdirSync(chats, { recursive: true });
  const chat = { name: "sam", session: "sam", provider: "claude", status: "running", paneId: "%1", socketPath, worktree: home };
  fs.writeFileSync(path.join(chats, "registry.json"), JSON.stringify({ chats: { sam: chat } }));
  return { home, bin, memory };
}

const SETTINGS = ({ memory }) => ({
  RIVET_REPOS: "example-org/example-repo",
  RIVET_FLY_APPS: "sample-app",
  RIVET_MIND_MEMORY_DIR: memory,
  RIVET_URL: url,
  RIVET_BOARD_TOKEN: "cd".repeat(32),
});

const install = (home) => {
  fs.mkdirSync(path.join(home, ".rivet-agents", "readers"), { recursive: true });
  fs.writeFileSync(path.join(home, ".rivet-agents", "readers", "installed"), "");
};

/** Runs a reader in the home, on nothing of this machine's own environment. */
function runIn({ home, bin }, reader, env) {
  const child = spawn(process.execPath, [path.join(ROOT, "readers", reader.script), ...(reader.args ?? [])], {
    cwd: home,
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: os.tmpdir(), TZ: "UTC", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, out })));
}

const calls = ({ bin }) => {
  try {
    return fs.readFileSync(path.join(bin, "calls.log"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

/** Quiet: exit 0, at most one line, and not one CLI started. */
function assertQuiet(world, { code, out }) {
  assert.equal(code, 0, out);
  assert.ok(out.trim().split("\n").length <= 1, out);
  assert.deepEqual(calls(world), []);
}

for (const reader of READERS) {
  test(`${reader.job}: off by default, no CLI runs`, async () => {
    const world = makeHome();
    assertQuiet(world, await runIn(world, reader, SETTINGS(world)));
  });

  test(`${reader.job}: on without the install, no CLI runs`, async () => {
    const world = makeHome();
    assertQuiet(world, await runIn(world, reader, { ...SETTINGS(world), RIVET_READERS: "on" }));
  });

  test(`${reader.job}: the install without on, no CLI runs`, async () => {
    const world = makeHome();
    install(world.home);
    assertQuiet(world, await runIn(world, reader, SETTINGS(world)));
  });

  test(`${reader.job}: with both open and nothing set, it stays quiet`, async () => {
    const world = makeHome();
    install(world.home);
    assertQuiet(world, await runIn(world, reader, { RIVET_READERS: "on" }));
  });
}

for (const reader of READERS.filter((r) => r.job !== "weekly-learned")) {
  test(`${reader.job}: with both set it runs, and reaches the model`, async () => {
    const world = makeHome();
    install(world.home);
    const result = await runIn(world, reader, { ...SETTINGS(world), RIVET_READERS: "on" });
    assert.ok(calls(world).some((line) => line.startsWith("claude ")), `${result.out}\n${calls(world).join("\n")}`);
    assert.equal(result.code, 0, result.out);
  });
}

test("weekly-learned: with both set it runs", async () => {
  const world = makeHome();
  install(world.home);
  const result = await runIn(world, READERS.at(-1), { ...SETTINGS(world), RIVET_READERS: "on" });
  assert.equal(result.code, 0, result.out);
  assert.ok(!result.out.includes("weekly-learned-off"), result.out);
  assert.ok(fs.existsSync(path.join(world.home, ".rivet-agents", "readers", "weekly-learned.json")), result.out);
});

test("a reader makes its clone once, through gh, under the home's readers folder", async () => {
  const world = makeHome();
  install(world.home);
  const reader = READERS.find((r) => r.job === "issue-recheck");
  await runIn(world, reader, { ...SETTINGS(world), RIVET_READERS: "on" });
  await runIn(world, reader, { ...SETTINGS(world), RIVET_READERS: "on" });
  const clones = calls(world).filter((line) => line.startsWith("gh repo clone"));
  assert.equal(clones.length, 1);
  assert.ok(clones[0].includes(path.join(world.home, ".rivet-agents", "readers", "clones", "example-org", "example-repo")), clones[0]);
});

test("every reader enters through the gate, and only lib.mjs reaches the CLI", () => {
  for (const { script } of READERS) {
    const source = fs.readFileSync(path.join(ROOT, "readers", script), "utf8");
    assert.match(source, /runReader\(JOB, main\)/, script);
    assert.doesNotMatch(source, /makeClaudeRun|scheduledRun/, script);
  }
});

test("install-readers.sh --dry-run prints each job and changes nothing", async () => {
  const world = makeHome();
  const before = fs.readdirSync(world.home).sort();
  const child = spawn("/bin/bash", [path.join(ROOT, "scripts", "install-readers.sh"), "--dry-run"], {
    env: { HOME: world.home, PATH: `${world.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  for (const name of ["chat-watch", "ci-triage", "issue-recheck", "fly-errors", "memory-check", "weekly-learned-record", "weekly-learned"]) {
    assert.ok(out.includes(`<string>dev.rivet-agents.reader-${name}</string>`), name);
  }
  assert.deepEqual(fs.readdirSync(world.home).sort(), before);
  assert.ok(!fs.existsSync(path.join(world.home, ".rivet-agents", "readers", "installed")), "no marker from a dry run");
  assert.ok(!calls(world).some((line) => line.startsWith("launchctl ")), "launchd is left alone");
});
