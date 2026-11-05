import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import { runHook } from "./run-hook.mjs";

const CHAT = 500;
const SHELL = "/opt/playwright/chromium_headless_shell-1228/chrome-mac/headless_shell";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHAT_DIR = "/work/this-chat";

const withTmp = (fn) => {
  const tmp = mkdtempSync(join(tmpdir(), "chrome-cap-"));
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

/** rows are [pid, ppid, command] as a stub ps prints them; cwds is what a stub lsof says. */
function runCap(tmp, rows, { cwds = {}, event = "PostToolUse", command = "true", session = "S1", env = {} } = {}) {
  const stubs = join(tmp, "stubs");
  mkdirSync(stubs, { recursive: true });
  const table = join(tmp, "ps.txt");
  writeFileSync(table, rows.map(([pid, ppid, text]) => `${pid} ${ppid} ${text}\n`).join(""));
  const folders = join(tmp, "lsof.txt");
  writeFileSync(folders, Object.entries(cwds).map(([pid, folder]) => `p${pid}\nfcwd\nn${folder}\n`).join(""));
  for (const [name, source] of [["ps", table], ["lsof", folders]]) {
    writeFileSync(join(stubs, name), `#!/bin/sh\ncat "${source}"\n`);
    chmodSync(join(stubs, name), 0o755);
  }
  return runHook(
    "chrome-cap.mjs",
    { hook_event_name: event, session_id: session, cwd: CHAT_DIR, tool_input: { command } },
    { TMPDIR: tmp, PATH: `${stubs}${delimiter}${process.env.PATH}`, CLAUDE_PID: String(CHAT), CLAUDE_PROJECT_DIR: CHAT_DIR, ...env },
  );
}

const browsers = (count, parent = CHAT, start = 1000) =>
  Array.from({ length: count }, (_, i) => [start + i, parent, `${SHELL} --headless --no-sandbox`]);

const note = (result) => {
  assert.ok(!JSON.stringify(result).includes("permissionDecision"));
  return result.hookSpecificOutput.additionalContext;
};

test("the cap itself is allowed and one more is told", () =>
  withTmp((tmp) => {
    assert.equal(runCap(tmp, browsers(2)), null);
    const result = runCap(tmp, browsers(3));
    assert.equal(result.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(note(result), /3 headless Chrome/);
    assert.match(note(result), /never by name pattern/);
  }));

test("RIVET_CHROME_CAP sets the cap, and a bad value keeps the default", () =>
  withTmp((tmp) => {
    assert.equal(runCap(tmp, browsers(4), { env: { RIVET_CHROME_CAP: "4" } }), null);
    assert.match(note(runCap(tmp, browsers(5), { env: { RIVET_CHROME_CAP: "4" } })), /cap on this machine is 4/);
    assert.match(note(runCap(tmp, browsers(6), { env: { RIVET_CHROME_CAP: "none" } })), /cap on this machine is 2/);
  }));

test("a browser counts once however many helpers it has", () =>
  withTmp((tmp) => {
    const rows = browsers(2);
    ["renderer", "gpu-process", "utility", "zygote", "renderer", "renderer"].forEach((kind, i) =>
      rows.push([2000 + i, 1000, `${SHELL} --type=${kind} --headless`]),
    );
    rows.push([2100, 1000, "/opt/playwright/chrome-mac/chrome_crashpad_handler --monitor-self"]);
    assert.equal(runCap(tmp, rows), null);
  }));

test("each browser shape counts", () => {
  for (const command of [
    "/cache/chrome-headless-shell --headless",
    `${SHELL} --disable-gpu`,
    "./headless_shell --disable-gpu",
    "vendor/chrome-mac/headless_shell --disable-gpu",
    "./vendor/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --headless",
    `${SHELL} about:blank --disable-gpu`,
    SHELL,
    `${CHROME} --headless=new --disable-gpu`,
    `${CHROME} --disable-gpu --headless`,
    "/x/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --headless",
    "/x/Chromium.app/Contents/MacOS/Chromium --headless",
  ])
    withTmp((tmp) => {
      const rows = [0, 1, 2].map((i) => [1000 + i, CHAT, command]);
      assert.match(note(runCap(tmp, rows)), /3 headless Chrome/, command);
    });
});

test("what only looks like a headless browser does not count", () => {
  for (const command of [
    `${CHROME} --remote-debugging-port=9222`,
    `${CHROME} Helper (Renderer) --type=renderer --headless`,
    `/bin/zsh -c ${SHELL} --headless`,
    "node scripts/shoot.mjs --headless",
    "node /x/headless_shell --headless",
    "rg chrome-headless-shell --headless",
  ])
    withTmp((tmp) => {
      const rows = [0, 1, 2, 3, 4].map((i) => [1000 + i, CHAT, command]);
      assert.equal(runCap(tmp, rows), null, command);
    });
});

test("another chat's browsers are not this chat's", () =>
  withTmp((tmp) => {
    const rows = [...browsers(2), ...browsers(6, 900, 3000), [900, 1, "claude"]];
    const cwds = Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [3000 + i, "/work/other-chat"]));
    assert.equal(runCap(tmp, rows, { cwds }), null);
  }));

test("browsers outliving their shell are found by their folder", () =>
  withTmp((tmp) => {
    // `( … ) &` has exited, so nothing links the browsers to Claude any more.
    const rows = [[800, 1, "node export.mjs"], ...browsers(3, 800)];
    const cwds = { 1000: CHAT_DIR, 1001: `${CHAT_DIR}/app`, 1002: `${CHAT_DIR}-2` };
    assert.equal(runCap(tmp, rows, { cwds }), null);
    cwds[1002] = CHAT_DIR;
    assert.match(note(runCap(tmp, rows, { cwds })), /3 headless Chrome/);
  }));

test("another chat's browsers in this folder stay that chat's", () =>
  withTmp((tmp) => {
    const rows = [[900, 1, "/opt/bin/claude --resume"], ...browsers(3, 900)];
    const cwds = { 1000: CHAT_DIR, 1001: CHAT_DIR, 1002: CHAT_DIR };
    assert.equal(runCap(tmp, rows, { cwds }), null);
    rows[0] = [900, 1, "node export.mjs"];
    assert.match(note(runCap(tmp, rows, { cwds })), /3 headless Chrome/);
  }));

test("the state file is never written through a symlink", () =>
  withTmp((tmp) => {
    const victim = join(tmp, "victim.txt");
    writeFileSync(victim, "keep me");
    const state = join(tmp, "claude-chrome-cap");
    mkdirSync(state, { mode: 0o700 });
    symlinkSync(victim, join(state, "S1"));
    assert.match(note(runCap(tmp, browsers(3))), /3 headless/);
    assert.equal(readFileSync(victim, "utf8"), "keep me");
    assert.equal(lstatSync(join(state, "S1")).isSymbolicLink(), false);
    assert.equal(runCap(tmp, browsers(3)), null);
  }));

test("a worktree under this chat's folder is not this chat's folder", () =>
  withTmp((tmp) => {
    const cwds = Object.fromEntries([0, 1, 2].map((i) => [1000 + i, `${CHAT_DIR}/.claude/worktrees/another`]));
    assert.equal(runCap(tmp, browsers(3, 800), { cwds }), null);
  }));

test("it says so once per high and again after falling back", () =>
  withTmp((tmp) => {
    assert.ok(runCap(tmp, browsers(3)));
    assert.equal(runCap(tmp, browsers(3)), null);
    assert.equal(runCap(tmp, browsers(3), { event: "PreToolUse" }), null);
    assert.match(note(runCap(tmp, browsers(5))), /5 headless/);
    assert.equal(runCap(tmp, browsers(4)), null);
    assert.equal(runCap(tmp, browsers(2)), null);
    assert.match(note(runCap(tmp, browsers(3))), /3 headless/);
    assert.ok(runCap(tmp, browsers(3), { session: "S2" }));
  }));

test("real processes through the real ps", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "chrome-cap-"));
  // No stub: what ps really prints, for processes named as a browser, under a stand-in chat.
  const children = [0, 1, 2].map(() => spawn("/bin/sleep", ["60"], { argv0: SHELL, stdio: "ignore" }));
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const out = runHook("chrome-cap.mjs", { hook_event_name: "PostToolUse", session_id: "S1", cwd: tmp }, { TMPDIR: tmp, CLAUDE_PID: String(process.pid), CLAUDE_PROJECT_DIR: tmp });
    assert.match(note(out), /3 headless Chrome/);
  } finally {
    for (const child of children) child.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a command asking for many is told first", () => {
  for (const command of [
    "ls *.json | xargs -P 8 -n1 node scripts/shoot.mjs",
    "xargs -P8 -n1 node shoot.mjs < list",
    "xargs -n1 -P 0 node shoot.mjs < list",
    "parallel -j 6 node shoot.mjs ::: a b",
    "parallel --jobs=6 node shoot.mjs ::: a b",
    "node scripts/capture.mjs --workers 3",
    "npx playwright test --workers=4",
    "npx playwright test smoke --workers=2; npx playwright test full --workers=8",
    "xargs -P2 -n1 true < first.txt; xargs -P8 -n1 node capture.mjs < urls.txt",
    "ssh build-box true && xargs -P8 -n1 node capture.mjs < urls.txt",
    "npx playwright test --workers=8 # a comment",
    "cd app\nnpx playwright test --workers=6",
    "npx playwright test --grep 'case #one' --workers=8",
    "xargs -P2 -P8 -n1 node capture.mjs < urls.txt",
  ])
    withTmp((tmp) => assert.match(note(runCap(tmp, [], { event: "PreToolUse", command })), /parallel workers/, command));
});

test("the throttle that throttles nothing is named", () =>
  withTmp((tmp) => {
    for (const command of [
      "for i in {1..16}; do while (( $(jobs -r | wc -l) >= 4 )); do sleep 1; done; node export.mjs $i & done",
      "for i in {1..16}; do while (( $(\njobs -r | wc -l\n) >= 4 )); do sleep 1; done; node export.mjs $i & done",
    ])
      assert.match(note(runCap(tmp, [], { event: "PreToolUse", command })), /throttles nothing/);
  }));

test("commands within the cap or on another machine say nothing", () => {
  for (const command of [
    "git status",
    "xargs -P 2 -n1 node shoot.mjs < list",
    "npx playwright test --workers=2",
    "npx vitest run --maxWorkers=4 a.test.ts",
    "ssh build-box 'xargs -P 8 node shoot.mjs'",
    "git log # xargs -P 8 in a comment",
  ])
    withTmp((tmp) => assert.equal(runCap(tmp, [], { event: "PreToolUse", command }), null, command));
  // After the command has run it is too late to be told, so only the count speaks.
  withTmp((tmp) => assert.equal(runCap(tmp, [], { command: "xargs -P 8 -n1 node shoot.mjs" }), null));
});

test("a broken ps costs the count and not the command note", () =>
  withTmp((tmp) => {
    const stubs = join(tmp, "broken");
    mkdirSync(stubs);
    writeFileSync(join(stubs, "ps"), "#!/bin/sh\nexit 3\n");
    chmodSync(join(stubs, "ps"), 0o755);
    const env = { TMPDIR: tmp, PATH: `${stubs}${delimiter}${process.env.PATH}` };
    const payload = (command) => ({ hook_event_name: "PreToolUse", session_id: "S1", tool_input: { command } });
    assert.match(note(runHook("chrome-cap.mjs", payload("xargs -P 8 x"), env)), /parallel workers/);
    assert.equal(runHook("chrome-cap.mjs", payload("git status"), env), null);
  }));
