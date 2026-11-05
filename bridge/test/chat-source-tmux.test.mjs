import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createChatRunner } from "../lib/chat-source.mjs";
import { makeExec } from "../lib/config.mjs";
import { resolveChatTerminal } from "../lib/terminals.mjs";

// The real runner CLI and real tmux, on a throwaway HOME and a private socket: the fixtures can't show what tmux does
// with a line or a key, and the runner is the bridge's only way to a chat.
const cli = fileURLToPath(new URL("../../scripts/rivet-chat.mjs", import.meta.url));
const tmuxBin = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
const NO_TMUX = tmuxBin && spawnSync(tmuxBin, ["-V"]).status === 0 ? false : "no tmux";
// CI sets this, so a runner image that loses tmux fails here instead of skipping.
if (process.env.RIVET_REQUIRE_TMUX && NO_TMUX) throw new Error("RIVET_REQUIRE_TMUX is set and this runner has no tmux");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-source-tmux-")));
const tmuxDir = fs.realpathSync(fs.mkdtempSync("/tmp/cst-"));
const socket = `chat-source-test-${randomBytes(4).toString("hex")}`;
const home = path.join(root, "home");
const bin = path.join(root, "bin");
const work = path.join(root, "work");
for (const dir of [home, bin, work]) fs.mkdirSync(dir, { recursive: true });

// A stand-in for Claude's screen: what it was given, an input box between two rules, and a status row. It sets a title.
// A line starting SWALLOW loses its first Enter, as a long paste can.
fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env node
process.stdin.setRawMode(true);
process.stdout.write("\\u001b]0;\\u2810 stand-in\\u0007");
const rows = [];
let input = "";
let swallowed = false;
const rule = "\\u2500".repeat(60);
const draw = () => process.stdout.write("\\u001b[2J\\u001b[H" + [...rows.slice(-8), rule, "\\u276f " + input, rule, "status row"].join("\\r\\n"));
draw();
process.stdin.on("data", (b) => {
  for (const ch of b.toString()) {
    if (ch === "\\u001b") rows.push("<ESC>");
    else if (ch === "\\r") {
      if (input.startsWith("SWALLOW") && !swallowed) { swallowed = true; continue; }
      if (input) rows.push("got:" + (input.length > 200 ? "long " + input.length + " " + (/^(x+)$/.test(input) ? "whole" : "broken") : input));
      input = "";
    } else input += ch;
  }
  draw();
});
`, { mode: 0o755 });

const env = {
  PATH: `${bin}:${path.dirname(process.execPath)}:${tmuxBin ? `${path.dirname(tmuxBin)}:` : ""}/usr/bin:/bin`,
  HOME: home,
  TMUX_TMPDIR: tmuxDir,
  RIVET_CHAT_TMUX_SOCKET: socket,
};
after(() => {
  if (tmuxBin) spawnSync(tmuxBin, ["-L", socket, "kill-server"], { env, stdio: "ignore" });
  fs.rmSync(tmuxDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

const chatRunner = createChatRunner({ exec: makeExec(), cli, cwd: work, env });

/** @param {string} what @param {() => Promise<unknown>} fn */
async function until(what, fn, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const screen = async (/** @type {string} */ handle) => (await chatRunner.read(handle, 40)).join("\n");

test("no registry is an empty list, not an error", { skip: NO_TMUX }, async () => {
  assert.deepEqual(await chatRunner.list(), []);
});

test("two chats: each is reached alone by name, with lines, long lines and Pause", { skip: NO_TMUX }, async () => {
  await chatRunner.start("one", "first prompt for one");
  await chatRunner.start("two", "first prompt for two");
  const terminals = await chatRunner.list();
  assert.equal(terminals.length, 2);
  assert.equal(resolveChatTerminal(terminals, "one").handle, "one");
  assert.equal(resolveChatTerminal(terminals, "two").handle, "two");
  await until("the stand-in's screen", async () => (await screen("one")).includes("status row") && (await screen("two")).includes("status row"));

  const row = (await chatRunner.list()).find((t) => t.handle === "one");
  assert.match(String(row?.title), /stand-in/, "the agent's title reaches the board's working or idle");

  assert.deepEqual(await chatRunner.send("one", "From the owner: to chat one"), { confirmed: true, stages: ["accepted", "submitted"] });
  assert.match(await screen("one"), /got:From the owner: to chat one/);
  assert.doesNotMatch(await screen("two"), /to chat one/);

  await chatRunner.interrupt("two");
  await until("the Escape", async () => (await screen("two")).includes("<ESC>"));
  assert.doesNotMatch(await screen("one"), /<ESC>/, "Pause reached only its own chat");

  // The board takes a line this long; one tmux command does not.
  const long = await chatRunner.send("one", "x".repeat(20_000));
  assert.equal(long.confirmed, true);
  assert.match(await screen("one"), /got:long 20000 whole/);

  // A first Enter lost gets one more; the line arrives once.
  assert.equal((await chatRunner.send("one", "SWALLOW the first Enter")).confirmed, true);
  const seen = (await screen("one")).match(/got:SWALLOW/g) ?? [];
  assert.equal(seen.length, 1);

  // A session killed has not finished: it is held as pending, and nothing can type to it.
  const listed = JSON.parse(spawnSync(process.execPath, [cli, "ls", "--json"], { env, encoding: "utf8" }).stdout);
  const session = listed.find((/** @type {any} */ c) => c.name === "one")?.session;
  assert.ok(session);
  spawnSync(tmuxBin, ["-L", socket, "kill-session", "-t", session], { env, stdio: "ignore" });
  const gone = await chatRunner.list();
  assert.equal(gone.length, 2);
  const held = /** @type {any} */ (gone.find((t) => t.handle === "one"));
  assert.deepEqual([held.pending, held.connected, held.writable], [true, false, false]);
  assert.equal(resolveChatTerminal(gone, "one").handle, null);
  assert.equal(resolveChatTerminal(gone, "two").handle, "two");
  await assert.rejects(chatRunner.send("one", "to a dead chat"));
});
