import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runnerTerminal } from "../../bridge/lib/chat-source.mjs";
import { test } from "node:test";
import { Spend } from "../lib.mjs";
import {
  BOARD_STATE,
  DOING_EVERY_MS,
  GONE_CONFIRM_MS,
  GONE_DROP_MS,
  OWNED_ROW_MS,
  RECHECK_MS,
  REALERT_MS,
  STALL_MS,
  baseName,
  batchPrompt,
  boardWrite,
  finalState,
  goneRules,
  liveNames,
  parseBatch,
  screenText,
  watchPass,
  watchedChats,
} from "../chat-watch.mjs";

const REPO = "example-org/example-repo";
process.env.RIVET_REPOS = REPO;
const M = REPO;
const G = "example-org/other-repo";
const TOKEN = `${"gh"}p_${"Z9y8X7w6V5".repeat(4)}`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "chat-watch-"));
const term = (chat, extra = {}) => ({ handle: chat, name: chat, repo: REPO, connected: true, writable: true, agentIdentity: "claude", lastOutputAt: 1, title: "◐ x", ...extra });
/** A list that shows just these chats. */
const listing = (deps, names) => ({ ...deps, chatRunner: { ...deps.chatRunner, list: async () => names.map((n) => term(n)) } });
/** Screens that no longer read. */
const unreadable = (deps) => ({ ...deps, chatRunner: { ...deps.chatRunner, read: async () => Promise.reject(new Error("timed out")) } });
const rules = (board, live, gone, now, prevLive = null) => goneRules(board, live, gone, now, "lead", prevLive);

test("watchedChats keeps connected agent chats whose row of their own name is on the board in their repo", () => {
  const terminals = [
    term("alpha"),
    term("beta", { agentIdentity: "" }),
    term("gamma", { connected: false }),
    term("delta", { repo: undefined }),
    term("other", { repo: G }),
    term("not-on-board"),
  ];
  const board = [{ name: "alpha", state: "working" }, { name: "beta" }, { name: "gamma" }, { name: "delta" }, { name: "other" }];
  const chats = watchedChats(terminals, board);
  assert.deepEqual(chats.map((c) => [c.chat, c.handle, c.repo]), [["alpha", "alpha", REPO], ["delta", "delta", REPO]]);
});

test("screenText redacts the whole screen before it keeps the last 60 lines", () => {
  const out = screenText(["password:", "swordfish", ...Array(59).fill("ordinary")]);
  assert.ok(!out.includes("swordfish"));
  assert.equal(out.split("\n").length, 60);
});

test("screenText holds back a screen whose top was cut, to its first line at column 0 past the top", () => {
  // A value whose header scrolled off above the screen, and a top line that may end a value begun above.
  const out = screenText(["    Q7m2V9z4R1p6-rest-of-key", "    second-part-of-it", "\u23fa Done", "  ok"]);
  assert.equal(out, "\u23fa Done\nok");
  assert.ok(!screenText(['abc-tail-of-a-quoted-value"', "\u23fa Done"]).includes("abc-tail"));
  // A header among the held lines still hides its value below them.
  assert.ok(!screenText(["\u23fa top", "password:", "swordfish", "  more"]).includes("swordfish"));
});

test("screenText covers IP addresses and a token the terminal wrapped onto the next line", () => {
  const out = screenText(["\u23fa top", "\u23fa Output: Q7m2V9z4R1p6", "K8w3J5n0 then done", "\u23fa Connected to 203.0.113.7:443 and 2001:db8::1."]);
  assert.equal(out, "\u23fa Output: [redacted]\n[redacted] then done\n\u23fa Connected to [redacted-ip]:443 and [redacted-ip].");
});

test("screenText holds a quoted value's close at column 0, and a token wrapped from a held line", () => {
  // PASSWORD="red / blue / green" with its first line scrolled off: column 0 does not end a quoted value.
  assert.equal(screenText(["red", "blue", 'green"', "\u23fa next"]), "\u23fa next");
  // An escaped quote is not counted.
  assert.equal(screenText(["top", 'echo "a \\" b" ok', "\u23fa shown"]), 'echo "a \\" b" ok\n\u23fa shown');
  // The token's head is held; its tail on the first line shown is still covered.
  assert.equal(screenText(["Output: Q7m2V9z4R1p6", "K8w3J5n0 then done", "\u23fa more"]), "[redacted] then done\n\u23fa more");
  // An IPv6 address ending in an IPv4 one is covered whole.
  assert.equal(screenText(["top", `to 2001:db8:abcd:1234:5678:9abc:192.0.2.128 and ::ffff:${["10", "0", "0", "1"].join(".")} now`]), "to [redacted-ip] and [redacted-ip] now");
});

test("screenText holds a quoted value's close that looks like an opener, and a single-quoted value's close", () => {
  // PASSWORD="head / red / copper lake / NAME="hello: the quote after NAME= closes PASSWORD.
  assert.equal(screenText(["red", "copper lake", 'NAME="hello', "\u23fa done"]), "\u23fa done");
  for (const rows of [["red", "blue", 'token=green"', "\u23fa done"], ["red", "blue", "green\"; TOKEN='tail", "done'", "\u23fa done"]]) {
    const out = screenText(rows);
    assert.ok(!/blue|green|tail/.test(out), out);
  }
  // PASSWORD='red / blue / green'.
  assert.equal(screenText(["red", "blue", "green'", "\u23fa done"]), "\u23fa done");
  // A single quote inside a double-quoted value is no close of it: the hold runs to the later close.
  const inside = screenText(["red", "users' notes", "copper lake", 'green"', "\u23fa done"]);
  assert.equal(inside, "\u23fa done");
  // A triple-quoted value's literal quotes are no close of it either.
  const triple = screenText(["red", 'a"b', "users' notes", "copper lake", 'green"""', "⏺ done"]);
  assert.equal(triple, "⏺ done");
  const tripleSingle = screenText(["red", 'a"b', "users' notes", "'''", "copper lake", 'green"""', "⏺ done"]);
  assert.equal(tripleSingle, "⏺ done");
  // An apostrophe within a word holds nothing.
  assert.equal(screenText(["top", "it's done", "\u23fa Sam's next"]), "it's done\n\u23fa Sam's next");
  assert.equal(screenText(["top", "we don't", "you're here", "\u23fa ok"]), "we don't\nyou're here\n\u23fa ok");
  // PASSWORD='head / red / blue / green'tail: a close glued to a word is still a close.
  assert.equal(screenText(["red", "blue", "green'tail", "\u23fa done"]), "\u23fa done");
  // PASSWORD=" over a value that changes quote kind: `"""'''` closes the double quote and opens a single one, so
  // `copper lake` is still in it until the last `'''`.
  assert.equal(screenText(["red", `"""'''`, "copper lake", "'''", "\u23fa done"]), "\u23fa done");
  assert.equal(screenText(["red", `x"'y`, "copper lake", "z'", "\u23fa done"]), "\u23fa done");
  // Counting a glued quote moves no hold earlier than main's count of the rest: PASSWORD=" or PASSWORD='head above.
  assert.equal(screenText(["red", "green'tail", "copper lake", "users' notes", "\u23fa done"]), "\u23fa done");
  assert.equal(screenText(["red", "blue'green'", "\u23fa done"]), "\u23fa done");
  // Names and elisions with an apostrophe are prose too.
  assert.equal(screenText(["top", "I'm ready.", "Ask O'Brien at 8 o'clock, y'all"]), "I'm ready.\nAsk O'Brien at 8 o'clock, y'all");
});

test("screenText covers an IP address, a secret's name and a token's rest that the terminal wrapped", () => {
  assert.equal(screenText(["top", "host 203.0.", "113.7 up"]), "host [redacted-ip]\n[redacted-ip] up");
  assert.ok(!screenText(["top", "Output: pass", "word: hunter2"]).includes("hunter2"));
  assert.ok(!screenText(["top", "Output: Q7m2V9z4R1p6K8w3J5n0", "Ab9Z2q then done"]).includes("Ab9Z2q"));
});

test("screenText drops what follows a secret's name the terminal wrapped, beside a marker or in a plain value", () => {
  const block = screenText(["Q7m2V9z4R1p6K8w3J5n0", "CONFIGURATION_WORKER_SERVICE_PASS", "WORD: |", "  copper lake", "  battery staple"]);
  assert.ok(!/copper|battery/.test(block), block);
  const besideMarker = screenText(["Q7m2V9z4R1p6K8w3J5n0", "CONFIGURATION_WORKER_SERVICE_PASS", "WORD: copper lake", "  battery staple"]);
  assert.ok(!/copper|battery/.test(besideMarker), besideMarker);
  for (const rows of [["Output: password", " : copper lake", "  silver birch meadow"], ["Output: pass", 'word: ["copper lake",', '  "battery staple"]'], ["`Q7m2V9z4R1p6K8w3J5n0_PASS", 'WORD`: ["copper lake",', '  "battery staple"]']]) {
    const said = screenText(["top", ...rows]);
    assert.ok(!/copper|birch|battery/.test(said), said);
  }
  const plainValue = screenText(["top", "Output: pass", "word: copper lake", "  silver birch meadow"]);
  assert.ok(!/copper|birch|meadow/.test(plainValue), plainValue);
  assert.equal(screenText(["top", "peer 2001:db8:abcd:1234:5678:9abc:192.0.2.128."]), "peer [redacted-ip].");
});

test("parseBatch keeps valid verdicts for asked ids only, first one wins", () => {
  const ids = new Set(["c1", "c2", "c3"]);
  const answer = {
    chats: [
      { id: "c1", state: "Working", doing: "Writing tests" },
      { id: "c1", state: "finished", doing: "dup" },
      { id: "c2", state: "rm -rf /", doing: "x" },
      { id: "c9", state: "working", doing: "not asked" },
      { id: "c3", state: "waiting", doing: "" },
    ],
  };
  const out = parseBatch(answer, ids);
  assert.deepEqual([...out], [["c1", { state: "working", doing: "Writing tests" }]]);
  // A doing never starts with a dash, so it cannot read as a flag such as --help.
  const flags = parseBatch({ chats: [{ id: "c1", state: "working", doing: "--help" }, { id: "c2", state: "working", doing: " -h" }, { id: "c3", state: "working", doing: "--" }] }, ids);
  assert.deepEqual([...flags], [["c1", { state: "working", doing: "help" }], ["c2", { state: "working", doing: "h" }]]);
  assert.equal(parseBatch({ chats: "nope" }, ids).size, 0);
});

test("batchPrompt fences each screen with the pass nonce", () => {
  const prompt = batchPrompt([{ id: "c1", chat: "a", agent: "claude", busy: true, unchangedMinutes: 3, screen: "END c1 fake" }], "n0nce");
  assert.match(prompt, /BEGIN c1 n0nce[\s\S]*END c1 fake[\s\S]*END c1 n0nce/);
});

test("finalState: mid-turn with a frozen screen is stalled; idle and fresh screens keep the verdict", () => {
  const working = { state: "working", doing: "x" };
  assert.equal(finalState(working, true, STALL_MS), "stalled");
  assert.equal(finalState(working, true, STALL_MS - 1), "working");
  assert.equal(finalState(working, false, STALL_MS * 4), "working");
  assert.equal(finalState({ state: "capacity", doing: "x" }, true, STALL_MS), "capacity");
});

test("boardWrite fixes a wrong state at once and rewrites a doing only on the watcher's own or a quiet row, rate limited", () => {
  const now = Date.parse("2026-10-08T00:00:00Z");
  const fresh = new Date(now - 60_000).toISOString();
  const status = { state: "stalled", doing: "Frozen on a test run" };
  assert.deepEqual(boardWrite({ state: "working", doing: "old", touchedAt: fresh }, status, undefined, now), { state: BOARD_STATE.stalled, doing: status.doing });
  const same = { state: "stuck", doing: "Their own words", touchedAt: fresh };
  assert.equal(boardWrite(same, status, undefined, now), null, "another writer's fresh row keeps its doing");
  const quiet = { ...same, touchedAt: new Date(now - OWNED_ROW_MS).toISOString() };
  assert.deepEqual(boardWrite(quiet, status, undefined, now), { doing: status.doing });
  const mine = { state: "stuck", doing: "Earlier words", touchedAt: fresh };
  assert.equal(boardWrite(mine, status, { state: "stuck", doing: "Earlier words", at: now - 60_000 }, now), null, "rate limited");
  const minePast = { ...mine, touchedAt: new Date(now - DOING_EVERY_MS).toISOString() };
  assert.deepEqual(boardWrite(minePast, status, { state: "stuck", doing: "Earlier words", at: now - DOING_EVERY_MS }, now), { doing: status.doing });
  // Someone else changed the row after the watcher's write, keeping its doing: it is theirs now.
  assert.equal(boardWrite(mine, status, { state: "stuck", doing: "Earlier words", at: now - DOING_EVERY_MS }, now), null);
  assert.equal(boardWrite({ state: "stuck", doing: status.doing }, status, undefined, now), null);
});

/** A fake world: board rows, terminals and screens, and a model that answers from a table. */
function world({ screens, board, verdicts, now, version = { value: 7 } }) {
  const calls = { lists: 0, reads: [], set: [], prompts: [], versions: [] };
  const deps = {
    monitor: "lead",
    chatRunner: {
      list: async () => {
        calls.lists++;
        return Object.keys(screens).map((chat) => term(chat));
      },
      read: async (chat) => {
        calls.reads.push(chat);
        // A screen's top line is never shown (`heldTo`): each test screen is the lines below it.
        return ["\u256d\u2500 top", ...screens[chat].split("\n")];
      },
    },
    board: async () => ({ version: version.value, chats: board }),
    setChat: async (name, fields, v) => void (calls.set.push([name, fields]), calls.versions.push(v)),
    dropChat: async (name, repo, v) => void (calls.set.push(repo ? [name, "drop", repo] : [name, "drop"]), calls.versions.push(v)),
    run: async (input) => {
      calls.prompts.push(input);
      const chats = [...input.matchAll(/^BEGIN (c\d+) \S+\nChat: (\S+)/gm)].map(([, id, chat]) => ({ id, ...verdicts[chat] }));
      return JSON.stringify({ is_error: false, result: JSON.stringify({ chats }), usage: { input_tokens: 500, output_tokens: 50 } });
    },
    now: () => now.value,
    log: () => {},
  };
  return { deps, calls };
}

test("watchPass: reads, asks in one batch, writes the board, alerts, and writes status files; never sends to a chat", async () => {
  const dir = tmp();
  const now = { value: Date.parse("2026-10-08T00:00:00Z") };
  const board = [
    { name: "alpha", state: "working", doing: "old", touchedAt: "2026-10-01T00:00:00Z" },
    { name: "beta", state: "working", doing: "b", touchedAt: "2026-10-01T00:00:00Z" },
  ];
  const screens = { alpha: `pushing with ${TOKEN}\n✽ Thinking… (3s)`, beta: "Should I merge? (y/n)" };
  const { deps, calls } = world({
    now,
    board,
    screens,
    verdicts: { alpha: { state: "working", doing: "Pushing the branch" }, beta: { state: "waiting", doing: "Asks whether to merge" } },
  });
  const spend = new Spend("chat-watch", 6, { dir: path.join(dir, "spend") });
  const result = await watchPass({ ...deps, spend, dir });

  assert.deepEqual(calls.reads.sort(), ["alpha", "beta"], "each screen read once");
  assert.equal(calls.prompts.length, 1, "one batch for two chats");
  assert.ok(!calls.prompts[0].includes(TOKEN), "redacted before it is sent");
  assert.deepEqual(calls.set, [
    ["alpha", { doing: "Pushing the branch" }],
    ["beta", { state: "waiting", doing: "Asks whether to merge" }],
  ]);
  assert.deepEqual(calls.versions, [7, 7], "each write carries the board version it was decided on");
  const status = JSON.parse(fs.readFileSync(path.join(dir, "chat-status.json"), "utf8"));
  assert.deepEqual(status.chats.map((c) => [c.chat, c.repo, c.status, c.doing]), [
    ["alpha", REPO, "working", "Pushing the branch"],
    ["beta", REPO, "waiting", "Asks whether to merge"],
  ]);
  for (const c of status.chats) assert.ok(c.updatedAt && c.since && c.agent === "claude");
  const alerts = fs.readFileSync(path.join(dir, "alerts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(alerts.map((a) => [a.chat, a.state]), [["beta", "waiting"]]);
  assert.equal(result.counts.asked, 2);
  assert.ok(spend.today.usd > 0);

  // Two minutes on, same screens: nothing is asked or written, and the waiting chat is not alerted again.
  now.value += 120_000;
  board[0].doing = "Pushing the branch";
  board[1].state = "waiting";
  board[1].doing = "Asks whether to merge";
  const again = await watchPass({ ...deps, spend, dir });
  assert.equal(calls.prompts.length, 1);
  assert.equal(again.counts.reused, 2);
  assert.equal(calls.set.length, 2);
  assert.equal(fs.readFileSync(path.join(dir, "alerts.jsonl"), "utf8").trim().split("\n").length, 1);

  // An hour on, still waiting: asked again (RECHECK_MS) and alerted again (REALERT_MS); alpha's screen moved on.
  now.value += Math.max(RECHECK_MS, REALERT_MS);
  screens.alpha = "✽ Thinking… (61m)";
  await watchPass({ ...deps, spend, dir });
  assert.equal(calls.prompts.length, 2);
  assert.equal(fs.readFileSync(path.join(dir, "alerts.jsonl"), "utf8").trim().split("\n").length, 2);
});

test("watchPass: a screen whose text for the model changes is asked again, even when the redactor reads both alike", async () => {
  const dir = tmp();
  const now = { value: Date.parse("2026-10-08T00:00:00Z") };
  const board = [{ name: "alpha", state: "working", doing: "x", touchedAt: "2026-10-01T00:00:00Z" }];
  const screens = { alpha: "  Do you want to proceed?" };
  const { deps, calls } = world({ now, board, screens, verdicts: { alpha: { state: "working", doing: "Working" } } });
  const spend = new Spend("chat-watch", 6, { dir: path.join(dir, "spend") });
  await watchPass({ ...deps, spend, dir });
  now.value += 120_000;
  // The indent the redactor trims goes, so the line is no longer held back and the model sees it.
  screens.alpha = "Do you want to proceed?";
  await watchPass({ ...deps, spend, dir });
  assert.equal(calls.prompts.length, 2);
  assert.ok(calls.prompts[1].includes("Do you want to proceed?"));
});

test("watchPass: a mid-turn screen frozen past STALL_MS is stalled on the board and alerted", async () => {
  const dir = tmp();
  const now = { value: Date.parse("2026-10-08T00:00:00Z") };
  const board = [{ name: "alpha", state: "working", doing: "x", touchedAt: "2026-10-01T00:00:00Z" }];
  const { deps, calls } = world({ now, board, screens: { alpha: "✽ Running tests… (10m)" }, verdicts: { alpha: { state: "working", doing: "Running tests" } } });
  const spend = new Spend("chat-watch", 6, { dir: path.join(dir, "spend") });
  await watchPass({ ...deps, spend, dir });
  now.value += STALL_MS;
  board[0].doing = "Running tests";
  await watchPass({ ...deps, spend, dir });
  assert.deepEqual(calls.set.at(-1), ["alpha", { state: "stuck", doing: "Running tests" }]);
  const alerts = fs.readFileSync(path.join(dir, "alerts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(alerts.map((a) => a.state), ["stalled"]);
});

test("watchPass: dry run writes nothing; at the ceiling it asks nothing and keeps the last verdicts", async () => {
  const dir = tmp();
  const now = { value: Date.parse("2026-10-08T00:00:00Z") };
  const board = [{ name: "alpha", state: "working", doing: "x", touchedAt: "2026-10-01T00:00:00Z" }];
  const { deps, calls } = world({ now, board, screens: { alpha: "hello" }, verdicts: { alpha: { state: "finished", doing: "Merged and reported" } } });
  await watchPass({ ...deps, spend: new Spend("chat-watch", 6, { dir: path.join(dir, "spend") }), dir, dryRun: true });
  assert.equal(calls.set.length, 0);
  assert.ok(!fs.existsSync(path.join(dir, "chat-status.json")) && !fs.existsSync(path.join(dir, "alerts.jsonl")));
  assert.ok(fs.existsSync(path.join(dir, "spend", "chat-watch.json")), "a dry run's calls are real spend");

  const capped = await watchPass({ ...deps, spend: new Spend("capped", 0, { dir: path.join(dir, "spend") }), dir });
  assert.equal(capped.capped, true);
  assert.equal(calls.prompts.length, 1, "no call past the ceiling");
  assert.deepEqual([calls.lists, calls.reads.length], [1, 1], "no reads either: the job stops for the day");
  assert.ok(!fs.existsSync(path.join(dir, "chat-status.json")), "and writes nothing");
});

test("watchPass: a changed screen whose call fails is asked again next pass, and its old verdict is not written", async () => {
  const dir = tmp();
  const now = { value: Date.parse("2026-10-08T00:00:00Z") };
  const board = [{ name: "alpha", state: "done", doing: "Merged", touchedAt: "2026-10-01T00:00:00Z" }];
  const screens = { alpha: "All merged." };
  const { deps, calls } = world({ now, board, screens, verdicts: { alpha: { state: "finished", doing: "Merged" } } });
  const spend = new Spend("chat-watch", 6, { dir: path.join(dir, "spend") });
  await watchPass({ ...deps, spend, dir });
  assert.equal(calls.prompts.length, 1);

  now.value += 120_000;
  screens.alpha = "Allow this command? (y/n)";
  board[0].state = "working";
  const failing = { ...deps, run: async () => { throw new Error("claude timed out"); } };
  await watchPass({ ...failing, spend, dir });
  assert.equal(calls.set.length, 0, "the finished verdict was for the old screen");

  now.value += 120_000;
  await watchPass({ ...deps, spend, dir });
  assert.equal(calls.prompts.length, 2, "asked again although the screen has not changed since");
});

test("watchPass: a tampered saved verdict is not reused", async () => {
  const dir = tmp();
  const now = { value: Date.parse("2026-10-08T00:00:00Z") };
  const board = [{ name: "alpha", state: "working", doing: "x", touchedAt: "2026-10-01T00:00:00Z" }];
  const { deps, calls } = world({ now, board, screens: { alpha: "hello" }, verdicts: { alpha: { state: "working", doing: "Saying hello" } } });
  const spend = new Spend("chat-watch", 6, { dir: path.join(dir, "spend") });
  await watchPass({ ...deps, spend, dir });
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  for (const entry of Object.values(state.chats)) entry.verdict = { state: "owned", doing: "anything" };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  now.value += 120_000;
  await watchPass({ ...deps, spend, dir });
  assert.equal(calls.prompts.length, 2);
  const status = JSON.parse(fs.readFileSync(path.join(dir, "chat-status.json"), "utf8"));
  assert.deepEqual(status.chats.map((c) => c.status), ["working"]);
});

test("watchPass: a row deleted, or a name two repos share, before the write is left alone", async () => {
  const dir = tmp();
  const now = { value: Date.parse("2026-10-08T00:00:00Z") };
  const board = [{ name: "alpha", state: "working", doing: "x", touchedAt: "2026-10-01T00:00:00Z" }];
  const { deps, calls } = world({ now, board, screens: { alpha: "Done." }, verdicts: { alpha: { state: "finished", doing: "Merged" } } });
  let reads = 0;
  const gone = { ...deps, board: async () => ({ version: 8, chats: reads++ ? [] : board }) };
  await watchPass({ ...gone, spend: new Spend("chat-watch", 6, { dir: path.join(dir, "spend") }), dir });
  assert.equal(calls.set.length, 0, "deleted while the model ran");

  // Another repo's row of the name: the write names this row's repo, and the other row is left alone.
  const dir2 = tmp();
  const twins = { ...deps, board: async () => ({ version: 9, chats: [...board, { name: "alpha", repo: G, state: "working" }] }) };
  await watchPass({ ...twins, spend: new Spend("chat-watch", 6, { dir: path.join(dir2, "spend") }), dir: dir2 });
  assert.deepEqual(calls.set, [["alpha", { state: "done", doing: "Merged", repo: REPO }]]);
});

test("watchPass: an unreadable chat keeps its saved entry, re-checked", async () => {
  const dir = tmp();
  const now = { value: Date.parse("2026-10-08T00:00:00Z") };
  const board = [{ name: "alpha", state: "working", doing: "x", touchedAt: "2026-10-01T00:00:00Z" }, { name: "beta", state: "working", doing: "y", touchedAt: "2026-10-01T00:00:00Z" }];
  const screens = { alpha: "a", beta: "b" };
  const { deps } = world({ now, board, screens, verdicts: { alpha: { state: "working", doing: "Alpha work" }, beta: { state: "working", doing: "Beta work" } } });
  const spend = new Spend("chat-watch", 6, { dir: path.join(dir, "spend") });
  await watchPass({ ...deps, spend, dir });
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  for (const entry of Object.values(state.chats)) entry.status = entry.chat === "alpha" ? { state: "working", doing: `leak ${TOKEN}` } : { state: "pwned", doing: "x" };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  now.value += 120_000;
  await watchPass({ ...unreadable(deps), spend, dir });
  const status = JSON.parse(fs.readFileSync(path.join(dir, "chat-status.json"), "utf8"));
  assert.deepEqual(status.chats.map((c) => c.chat), ["alpha"], "an invalid saved status is dropped");
  assert.ok(!JSON.stringify(status).includes(TOKEN), "a saved doing is redacted again");

});

test("watchPass: the pass that reaches the ceiling writes nothing it read", async () => {
  const dir = tmp();
  const now = { value: Date.parse("2026-10-08T00:00:00Z") };
  const board = [{ name: "alpha", state: "working", doing: "x", touchedAt: "2026-10-01T00:00:00Z" }];
  const { deps, calls } = world({ now, board, screens: { alpha: "Merge? (y/n)" }, verdicts: { alpha: { state: "waiting", doing: "Asks to merge" } } });
  const result = await watchPass({ ...deps, spend: new Spend("chat-watch", 0.00001, { dir: path.join(dir, "spend") }), dir });
  assert.equal(calls.prompts.length, 1);
  assert.equal(result.capped, true);
  assert.equal(calls.set.length, 0, "no board write");
  assert.ok(!fs.existsSync(path.join(dir, "chat-status.json")) && !fs.existsSync(path.join(dir, "alerts.jsonl")), "no feed, no alert");
});

test("watchPass: a saved time no Date can hold is replaced, never thrown on", async () => {
  const dir = tmp();
  const now = { value: Date.parse("2026-10-08T00:00:00Z") };
  const board = [{ name: "alpha", state: "working", doing: "x", touchedAt: "2026-10-01T00:00:00Z" }];
  const { deps } = world({ now, board, screens: { alpha: "a" }, verdicts: { alpha: { state: "working", doing: "Alpha work" } } });
  const spend = new Spend("chat-watch", 6, { dir: path.join(dir, "spend") });
  await watchPass({ ...deps, spend, dir });
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  for (const entry of Object.values(state.chats)) Object.assign(entry, { updatedAt: 1e20, since: -1e20, sameSince: 1e20, askedAt: 1e20 });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  now.value += 120_000;
  await watchPass({ ...deps, spend, dir });
  now.value += 120_000;
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  await watchPass({ ...unreadable(deps), spend, dir });
  const status = JSON.parse(fs.readFileSync(path.join(dir, "chat-status.json"), "utf8"));
  assert.equal(status.chats.length, 1);
  for (const c of status.chats) assert.ok(Date.parse(c.updatedAt) && Date.parse(c.since));
});

test("baseName and watchedChats: a chat is watched under its own row; a suffixed one its base row lists is not added; never the monitor", () => {
  assert.equal(baseName("sky-lane-3b"), "sky-lane");
  assert.equal(baseName("bug-label-keys-5572"), "bug-label-keys");
  assert.equal(baseName("blue-tile-set-v2"), null);
  assert.equal(baseName("alpha"), null);
  const board = [{ name: "alpha", state: "working" }, { name: "beta", state: "working" }, { name: "gamma-c4", state: "working" }, { name: "lead", state: "working" }];
  const terminals = [term("alpha-3b"), term("beta"), term("beta-7f"), term("gamma-c4"), term("new-one"), term("lead"), term("lead-e3")];
  const listed = watchedChats(terminals, board, { monitor: "lead" });
  // The app joins a chat to its row by its own name, so a screen's line goes only there; the monitor's row is its own.
  assert.deepEqual(listed.map((c) => [c.chat, c.name]), [["beta", "beta"], ["gamma-c4", "gamma-c4"]]);
  const all = watchedChats(terminals, board, { unlisted: true, monitor: "lead" });
  assert.deepEqual(all.filter((c) => c.add).map((c) => [c.chat, c.name]), [["new-one", "new-one"]], "never the monitor, nor a chat its base row lists");
  // A chat its base row lists is still watched, for its alerts and status, but no row is written for it.
  assert.deepEqual(all.filter((c) => c.row === null && !c.add).map((c) => c.chat), ["alpha-3b", "beta-7f"]);
  // A name only another repo's row holds is added in its own repo.
  const elsewhere = watchedChats([term("shared")], [{ name: "shared", repo: G, state: "working" }], { unlisted: true });
  assert.deepEqual(elsewhere.filter((c) => c.add).map((c) => [c.chat, c.repo]), [["shared", REPO]]);
  // A chat in another repo gets its own row while the default repo has one of its name; a row naming no repo still stands
  // for a chat in a repo with no row of its name, as the app reads it.
  const lab = term("lab", { repo: G });
  const own = watchedChats([lab], [{ name: "lab", repo: REPO, state: "working" }], { unlisted: true });
  assert.deepEqual(own.filter((c) => c.add).map((c) => c.repo), [G]);
  assert.deepEqual(watchedChats([lab], [{ name: "lab", state: "working" }], { unlisted: true }).filter((c) => c.add), []);
  // A chat outside the default repo is added under its own repo.
  const other = watchedChats([term("grill", { repo: G })], [], { unlisted: true });
  assert.deepEqual(other.map((c) => [c.chat, c.repo]), [["grill", G]]);
  // With no monitor set no chat is held back.
  assert.ok(watchedChats([term("lead")], [], { unlisted: true }).some((c) => c.chat === "lead"));
});

test("goneRules: a closed chat is done after GONE_CONFIRM_MS, dropped once gone GONE_DROP_MS; never a live, monitor or twin row", () => {
  const now = Date.parse("2026-10-20T00:00:00Z");
  const recent = new Date(now - 60 * 60_000).toISOString();
  const old = new Date(now - GONE_DROP_MS - 60_000).toISOString();
  const board = [
    { name: "closed", state: "working", touchedAt: recent },
    { name: "stale", state: "done", touchedAt: old },
    { name: "alive", state: "working", touchedAt: old },
    { name: "suffixed", state: "working", touchedAt: old },
    { name: "alive-96", state: "waiting", touchedAt: old },
    { name: "lead", state: "working", touchedAt: old },
    { name: "lead-12", state: "working", touchedAt: old },
    { name: "twin", state: "working", touchedAt: old },
    { name: "twin", repo: G, state: "working", touchedAt: old },
  ];
  const live = liveNames([term("alive"), term("suffixed-5572"), term("shell-only", { agentIdentity: null }), term("off", { connected: false })]);
  assert.deepEqual([...live], [`${M}\nalive`, `${M}\nsuffixed-5572`]);
  const first = rules(board, live, {}, now);
  assert.deepEqual(first.actions, [], "the first sighting only notes it");
  // Each repo's twin is its own row.
  assert.deepEqual(Object.keys(first.gone), [`${M}\nclosed`, `${M}\nstale`, `${M}\ntwin`, `${G}\ntwin`]);
  assert.equal(first.gone[`${M}\nstale`].since, Date.parse(old), "counted from the row's last write");
  assert.deepEqual(rules(board, live, first.gone, now + GONE_CONFIRM_MS - 1).actions, []);
  const later = rules(board, live, first.gone, now + GONE_CONFIRM_MS);
  assert.deepEqual(later.actions, [
    { name: "closed", repo: M, op: "done" },
    { name: "stale", repo: M, op: "drop" },
    { name: "twin", repo: M, op: "drop" },
    { name: "twin", repo: G, op: "drop" },
  ]);
  // Done is written once; a day after its last write the closed row goes too.
  const marked = board.map((row) => (row.name === "closed" ? { ...row, state: "done" } : row));
  assert.deepEqual(rules(marked, live, later.gone, now + GONE_CONFIRM_MS + 60_000).actions.filter((a) => a.name === "closed"), []);
  assert.deepEqual(rules(marked, live, later.gone, Date.parse(recent) + GONE_DROP_MS + 1).actions.filter((a) => a.name === "closed"), [{ name: "closed", repo: M, op: "drop" }]);
  // A chat that comes back is forgotten as gone.
  assert.deepEqual(Object.keys(rules(board, new Set([...live, `${M}\nclosed`, `${M}\nstale`, "twin"]), later.gone, now).gone), []);
  // A twin's chat running in one repo keeps only that repo's row.
  assert.deepEqual(rules(board, new Set([...live, `${G}\ntwin`]), later.gone, now + GONE_CONFIRM_MS).actions.filter((a) => a.name === "twin"), [{ name: "twin", repo: M, op: "drop" }]);
  // A tampered saved entry starts over.
  assert.deepEqual(rules(board, live, { [`${M}\nclosed`]: { seenAt: "x", since: 1 } }, now + GONE_CONFIRM_MS).actions.filter((a) => a.name === "closed"), []);
  // A chat the last pass saw running counts from when it was first seen gone, however old its row: done, not dropped.
  // A bare name, as a state.json from before repos were kept saved it, counts in any repo.
  const ranOn = rules(board, live, {}, now, new Set(["stale"]));
  assert.equal(ranOn.gone[`${M}\nstale`].since, now);
  assert.deepEqual(rules(board, live, ranOn.gone, now + GONE_CONFIRM_MS, new Set()).actions.filter((a) => a.name === "stale"), []);
  // A row written after its chat was seen gone counts again from that sighting: not dropped on its old timer.
  const rewritten = board.map((row) => (row.name === "stale" ? { ...row, touchedAt: new Date(now + 60_000).toISOString() } : row));
  const reset = rules(rewritten, live, first.gone, now + GONE_CONFIRM_MS);
  assert.deepEqual(reset.actions.filter((a) => a.name === "stale"), []);
  assert.equal(reset.gone[`${M}\nstale`].since, now + GONE_CONFIRM_MS);
  // With no monitor set its row is a row like any other.
  assert.deepEqual(Object.keys(goneRules([{ name: "lead", state: "working", touchedAt: old }], new Set(), {}, now).gone), [`${M}\nlead`]);
});

test("goneRules: a closed default-repo row is not kept alive by another repo's chat of its name, unless it names no repo and that repo has no row", () => {
  const now = Date.parse("2026-10-20T00:00:00Z");
  const old = new Date(now - GONE_DROP_MS - 60_000).toISOString();
  const elsewhere = liveNames([term("lab", { repo: G })]);
  assert.deepEqual([...elsewhere], [`${G}\nlab`]);
  const named = [{ name: "lab", repo: M, state: "working", touchedAt: old }];
  assert.deepEqual(Object.keys(rules(named, elsewhere, {}, now).gone), [`${M}\nlab`]);
  // The app reads a row naming no repo as the one chat of its name elsewhere, so it stays while that runs...
  const bare = [{ name: "lab", state: "working", touchedAt: old }];
  assert.deepEqual(rules(bare, elsewhere, {}, now).gone, {});
  // ...but not once that repo has a row of its own.
  assert.deepEqual(Object.keys(rules([...bare, { name: "lab", repo: G, state: "working", touchedAt: old }], elsewhere, {}, now).gone), [`${M}\nlab`]);
});

test("watchPass: adds a running unlisted chat from its screen, marks a closed one done, drops one gone a day; the monitor is left alone", async () => {
  const dir = tmp();
  const now = { value: Date.parse("2026-10-20T00:00:00Z") };
  const board = [
    { name: "lead", state: "working", doing: "Relaying", touchedAt: "2026-10-01T00:00:00Z" },
    { name: "closed", state: "working", doing: "Was building", touchedAt: new Date(now.value - 3 * 60 * 60_000).toISOString() },
    { name: "ancient", state: "done", doing: "Merged", touchedAt: "2026-10-10T00:00:00Z" },
  ];
  const screens = { lead: "monitor", fresh: "✽ Writing tests" };
  const { deps, calls } = world({ now, board, screens, verdicts: { fresh: { state: "working", doing: "Writing the sync tests" }, lead: { state: "finished", doing: "Wrapping up" } } });
  const spend = new Spend("chat-watch", 6, { dir: path.join(dir, "spend") });
  const first = await watchPass({ ...deps, spend, dir });
  assert.deepEqual(calls.set, [["fresh", { state: "working", doing: "Writing the sync tests" }]], "added; nothing closed on a first sighting");
  assert.equal(first.counts.added, 1);

  now.value += GONE_CONFIRM_MS;
  board.push({ name: "fresh", state: "working", doing: "Writing the sync tests", touchedAt: new Date(now.value).toISOString() });
  const second = await watchPass({ ...deps, spend, dir });
  assert.deepEqual(calls.set.slice(1), [["closed", { state: "done" }], ["ancient", "drop"]]);
  assert.deepEqual([second.counts.done, second.counts.dropped], [1, 1]);
  assert.ok(!calls.set.some(([name]) => name === "lead"));

  // A set monitor missing from the list closes nothing: that list says nothing about who closed.
  const dir2 = tmp();
  const blind = world({ now, board: [{ name: "closed", state: "working", touchedAt: "2026-10-01T00:00:00Z" }], screens: {}, verdicts: {} });
  const spend2 = new Spend("chat-watch", 6, { dir: path.join(dir2, "spend") });
  await watchPass({ ...blind.deps, spend: spend2, dir: dir2 });
  now.value += GONE_CONFIRM_MS;
  await watchPass({ ...blind.deps, spend: spend2, dir: dir2 });
  assert.deepEqual(blind.calls.set, []);

  // A default-repo chat added while another repo has a row of its name names its repo, so that row is left alone.
  const dir3 = tmp();
  const twin = world({ now, board: [{ name: "lead", state: "working" }, { name: "fresh", repo: G, state: "working", doing: "Other work" }], screens, verdicts: { fresh: { state: "working", doing: "Writing the sync tests" } } });
  await watchPass({ ...twin.deps, spend: new Spend("chat-watch", 6, { dir: path.join(dir3, "spend") }), dir: dir3 });
  assert.deepEqual(twin.calls.set, [["fresh", { state: "working", doing: "Writing the sync tests", repo: M }]]);
});

test("watchPass: with no monitor set a closed chat is still marked done, and a running one left alone", async () => {
  const dir = tmp();
  const now = { value: Date.parse("2026-10-20T00:00:00Z") };
  const board = [
    { name: "closed", state: "working", touchedAt: new Date(now.value - 60 * 60_000).toISOString() },
    { name: "running", state: "working", doing: "Building", touchedAt: new Date(now.value).toISOString() },
  ];
  const { deps, calls } = world({ now, board, screens: { running: "✽ Building" }, verdicts: { running: { state: "working", doing: "Building" } } });
  const spend = new Spend("chat-watch", 6, { dir: path.join(dir, "spend") });
  await watchPass({ ...deps, monitor: null, spend, dir });
  now.value += GONE_CONFIRM_MS;
  await watchPass({ ...deps, monitor: null, spend, dir });
  assert.deepEqual(calls.set, [["closed", { state: "done" }]]);
});

test("watchPass: a chat that opens during the pass, even between two closes, is not marked done", async () => {
  const dir = tmp();
  const now = { value: Date.parse("2026-10-20T00:00:00Z") };
  const board = [
    { name: "lead", state: "working" },
    { name: "early", state: "working", touchedAt: "2026-10-19T23:00:00Z" },
    { name: "late", state: "working", touchedAt: "2026-10-19T23:00:00Z" },
  ];
  const { deps, calls } = world({ now, board, screens: { lead: "m" }, verdicts: {} });
  const spend = new Spend("chat-watch", 6, { dir: path.join(dir, "spend") });
  await watchPass({ ...deps, spend, dir });
  now.value += GONE_CONFIRM_MS;
  // The pass's list, the close's list and early's show neither; late opens before its own close is decided.
  let lists = 0;
  const opening = {
    ...deps,
    chatRunner: {
      ...deps.chatRunner,
      list: async () => [term("lead"), ...(lists === 1 ? [term("brief")] : []), ...(lists++ >= 3 ? [term("late")] : [])],
    },
  };
  await watchPass({ ...opening, spend, dir });
  assert.deepEqual(calls.set, [["early", { state: "done" }]]);
  // What the late read showed is kept: late is no longer counted gone.
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.deepEqual(Object.keys(saved.gone), [`${M}\nearly`]);
  // A chat seen running in any read of the pass is remembered, so its gone time counts from the next pass's sighting.
  assert.deepEqual(saved.live, [`${M}\nbrief`, `${M}\nlate`, `${M}\nlead`]);
});

test("watchPass: a chat the pass's own list shows, gone by the close's read, keeps its row on an old timer", async () => {
  const dir = tmp();
  const now = { value: Date.parse("2026-10-20T00:00:00Z") };
  const board = [
    { name: "lead", state: "working" },
    { name: "back", state: "done", doing: "Merged", touchedAt: "2026-10-10T00:00:00Z" },
  ];
  const { deps, calls } = world({ now, board, screens: { lead: "m", back: "✽ Merged" }, verdicts: { back: { state: "finished", doing: "Merged" } } });
  const spend = new Spend("chat-watch", 6, { dir: path.join(dir, "spend") });
  const closed = listing(deps, ["lead"]);
  await watchPass({ ...closed, spend, dir });
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).gone[`${M}\nback`], "counted gone on its old row");
  now.value += GONE_CONFIRM_MS;
  // Back on the pass's list, closed again by the close's first read.
  let lists = 0;
  const flicker = { ...deps, chatRunner: { ...deps.chatRunner, list: async () => [term("lead"), ...(lists++ === 0 ? [term("back")] : [])] } };
  await watchPass({ ...flicker, spend, dir });
  assert.deepEqual(calls.set.filter(([name]) => name === "back"), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).gone[`${M}\nback`].since, now.value);
});

test("watchPass: a chat the pass's list shows is remembered when the cleanup fails, so a close soon after does not drop it", async () => {
  const dir = tmp();
  const now = { value: Date.parse("2026-10-20T00:00:00Z") };
  const board = [
    { name: "lead", state: "working" },
    { name: "back", state: "done", doing: "Merged", touchedAt: "2026-10-10T00:00:00Z" },
  ];
  const { deps, calls } = world({ now, board, screens: { lead: "m", back: "✽ Merged" }, verdicts: { back: { state: "finished", doing: "Merged" } } });
  const spend = new Spend("chat-watch", 6, { dir: path.join(dir, "spend") });
  const closed = listing(deps, ["lead"]);
  await watchPass({ ...closed, spend, dir });
  now.value += GONE_CONFIRM_MS;
  // Back on the pass's list; the cleanup's read then fails.
  let lists = 0;
  const failing = {
    ...deps,
    chatRunner: {
      ...deps.chatRunner,
      list: async () => {
        if (lists++ === 0) return [term("lead"), term("back")];
        throw new Error("timed out");
      },
    },
  };
  await watchPass({ ...failing, spend, dir });
  now.value += 2 * 60_000;
  await watchPass({ ...closed, spend, dir });
  assert.deepEqual(calls.set.filter(([name]) => name === "back"), []);
});

test("liveNames: a connected agent chat counts, and one the runner has not seen finish; a bare shell does not", () => {
  const live = liveNames([term("alive"), term("starting", { connected: false, pending: true }), term("shell", { agentIdentity: "" }), term("off", { connected: false })]);
  assert.deepEqual([...live], [`${M}\nalive`, `${M}\nstarting`]);
});

/** The world, its list replaced by rows in the shape the runner prints. `lost`: the list fails. */
function runnerWorld({ screens, board, now, rows, lost }) {
  const w = world({ screens, board, verdicts: {}, now });
  const list = async () => {
    if (lost?.value) throw new Error("runner down");
    return rows.flatMap((row) => runnerTerminal({ provider: "claude", status: "running", state: "alive", ...row }) ?? []);
  };
  return { ...w, deps: { ...w.deps, chatRunner: { list, read: async () => ["x"] } } };
}
const dropped = (calls) => calls.set.filter(([, fields]) => fields === "drop").map(([name]) => name);

test("a runner chat with no running agent is not closed: no all finished, no drop", async () => {
  const dir = tmp();
  const now = { value: Date.parse("2026-10-08T00:00:00Z") };
  const old = "2026-10-01T00:00:00Z";
  const board = [
    { name: "lead", state: "working", doing: "m", touchedAt: old },
    { name: "tmux-chat", state: "working", doing: "still going", touchedAt: old },
  ];
  const { deps, calls } = runnerWorld({ screens: {}, board, now, rows: [{ name: "lead" }, { name: "tmux-chat", state: "gone" }] });
  const spend = new Spend("chat-watch", 6, { dir: path.join(dir, "spend") });
  for (let i = 0; i < 4; i += 1) {
    await watchPass({ ...deps, spend, dir });
    now.value += 10 * 60_000;
  }
  assert.deepEqual(dropped(calls), []);
  assert.ok(!calls.set.some(([name, fields]) => name === "tmux-chat" && fields?.state === "finished"), "not marked finished");
});

test("the runner failing is no cleanup: every chat it held stays on the board", async () => {
  const dir = tmp();
  const now = { value: Date.parse("2026-10-08T00:00:00Z") };
  const old = "2026-10-01T00:00:00Z";
  const board = [
    { name: "lead", state: "working", doing: "m", touchedAt: old },
    { name: "tmux-chat", state: "working", doing: "going", touchedAt: old },
  ];
  const lost = { value: true };
  const { deps, calls } = runnerWorld({ screens: {}, board, now, lost, rows: [{ name: "lead" }, { name: "tmux-chat" }] });
  const spend = new Spend("chat-watch", 6, { dir: path.join(dir, "spend") });
  for (let i = 0; i < 4; i += 1) {
    await assert.rejects(watchPass({ ...deps, spend, dir }), /runner down/);
    now.value += 10 * 60_000;
  }
  assert.deepEqual(dropped(calls), []);
});

test("a chat already counting down to gone is not dropped on the pass the list fails, and goes once it answers", async () => {
  const dir = tmp();
  const now = { value: Date.parse("2026-10-08T00:00:00Z") };
  const old = "2026-10-01T00:00:00Z";
  const board = [
    { name: "lead", state: "working", doing: "m", touchedAt: old },
    { name: "really-gone", state: "working", doing: "going", touchedAt: old },
  ];
  const lost = { value: false };
  const { deps, calls } = runnerWorld({ screens: {}, board, now, lost, rows: [{ name: "lead" }] });
  const spend = new Spend("chat-watch", 6, { dir: path.join(dir, "spend") });
  const pass = async () => {
    await watchPass({ ...deps, spend, dir });
    now.value += 6 * 60_000;
  };
  await pass();
  lost.value = true;
  await assert.rejects(pass(), /runner down/);
  now.value += 6 * 60_000;
  assert.deepEqual(dropped(calls), [], "the failed pass does not finish the countdown");
  lost.value = false;
  await pass();
  assert.deepEqual([...new Set(dropped(calls))], ["really-gone"], "once the list answers, a chat really gone still goes");
});

test("a failed list keeps every saved status: the feed does not lose a chat for that pass", async () => {
  const dir = tmp();
  const now = { value: Date.parse("2026-10-08T00:00:00Z") };
  const old = "2026-10-01T00:00:00Z";
  const board = [
    { name: "lead", state: "working", doing: "m", touchedAt: old },
    { name: "tmux-chat", state: "working", doing: "going", touchedAt: old },
  ];
  const lost = { value: false };
  const { deps } = runnerWorld({ screens: {}, board, now, lost, rows: [{ name: "lead" }, { name: "tmux-chat" }] });
  deps.run = async (input) => JSON.stringify({ is_error: false, result: JSON.stringify({ chats: [...input.matchAll(/^BEGIN (c\d+) /gm)].map(([, id]) => ({ id, state: "working", doing: "on it" })) }), usage: { input_tokens: 1, output_tokens: 1 } });
  const spend = new Spend("chat-watch", 6, { dir: path.join(dir, "spend") });
  const saved = () => Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).chats);
  await watchPass({ ...deps, spend, dir });
  assert.ok(saved().some((key) => key.endsWith("tmux-chat")), "the chat was read");
  lost.value = true;
  now.value += 60_000;
  await assert.rejects(watchPass({ ...deps, spend, dir }), /runner down/);
  assert.ok(saved().some((key) => key.endsWith("tmux-chat")), "the chat was kept");
});
