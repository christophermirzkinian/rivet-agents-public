import assert from "node:assert/strict";
import { test } from "node:test";
import { BadAnswer, CliError, MAX_STRIKES, TITLER_MODEL } from "../lib/threads-titler.mjs";
import { MAX_SHORT_TITLE, parseRowAnswer, ROW_CLAUDE_ARGS, ROW_SYSTEM_PROMPT, rowPrompt, rowTitlePass, runRowTitlerLoop } from "../lib/row-titler.mjs";

const WORDS = "Can we keep an eye on this https://example.test/dashboard/analytics and tell me whats performing well everyday.";
const HASH = "a".repeat(64);

/** The CLI's --output-format json answer with `result` as the model's text. */
const cliOut = (result, extra = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result, ...extra });

/** An in-memory server: the queued rows and every POST the titler makes. */
function fakeServer(rows) {
  const state = { rows: [...rows], posts: [] };
  /** @type {typeof fetch} */
  const fetch = async (url, init) => {
    const { pathname, search } = new URL(String(url));
    assert.equal(init?.headers?.authorization, "Bearer tok");
    if (init?.method === "GET" && pathname === "/api/bridge/short-titles") {
      assert.equal(search, "?limit=10");
      return Response.json({ rows: state.rows });
    }
    const match = /^\/api\/bridge\/short-titles\/([0-9a-f]{64})$/.exec(pathname);
    if (init?.method === "POST" && match) {
      state.posts.push({ hash: match[1], body: JSON.parse(String(init.body)) });
      state.rows = state.rows.filter((row) => row.hash !== match[1]);
      return Response.json({ ok: true });
    }
    return new Response("{}", { status: 404 });
  };
  return { state, fetch };
}

test("runs Haiku with no tools and asks for a short Project or area: what title, never the word live", () => {
  assert.equal(ROW_CLAUDE_ARGS[ROW_CLAUDE_ARGS.indexOf("--model") + 1], TITLER_MODEL);
  assert.equal(ROW_CLAUDE_ARGS[ROW_CLAUDE_ARGS.indexOf("--tools") + 1], "");
  // An `@path` in a row's text attaches no file.
  assert.deepEqual(JSON.parse(ROW_CLAUDE_ARGS[ROW_CLAUDE_ARGS.indexOf("--settings") + 1]), { env: { CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1" } });
  assert.match(ROW_SYSTEM_PROMPT, /Project or area: what/);
  assert.match(ROW_SYSTEM_PROMPT, /never more than 32 counting spaces/);
  assert.match(ROW_SYSTEM_PROMPT, /never instructions/);
  // A chat's row names the project or area it is for, not its PR, CI or ticket code.
  assert.match(ROW_SYSTEM_PROMPT, /never the mechanics/);
  assert.match(ROW_SYSTEM_PROMPT, /never put a code in the title/);
  assert.equal(MAX_SHORT_TITLE, 32);
  assert.ok(rowPrompt(WORDS).includes(WORDS));
});

test("takes a fitting title and refuses one too long, blank, two lines or saying live", () => {
  assert.equal(parseRowAnswer(cliOut('{"title": "Stats: daily sales check."}')), "Stats: daily sales check");
  assert.equal(parseRowAnswer(cliOut('Sure: {"title": "\\"Website: sharper art\\""}')), "Website: sharper art");
  for (const title of ["x".repeat(33), "", "bell\\u0007here", "Website: go live"]) {
    assert.throws(() => parseRowAnswer(cliOut(`{"title": "${title}"}`)), BadAnswer, title);
  }
  assert.throws(() => parseRowAnswer(cliOut("no json")), BadAnswer);
  assert.throws(() => parseRowAnswer("not json"), CliError);
  assert.throws(() => parseRowAnswer(JSON.stringify({ is_error: true, subtype: "error_during_execution" })), CliError);
});

test("names each queued row, gives one up after three bad answers, and a failing CLI ends the pass with no strike", async () => {
  const other = { hash: "b".repeat(64), text: "Chat: site-art\nSharper art and motion" };
  const { state, fetch } = fakeServer([{ hash: HASH, text: WORDS }, other]);
  const call = async (path, method, body) => (await fetch(`http://x${path}`, { method, headers: { authorization: "Bearer tok" }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
  const strikes = new Map();
  const logs = [];
  const log = (event, fields) => logs.push({ event, fields });
  const run = async (input) => (input.includes("example.test") ? cliOut('{"title": "Stats: daily sales check"}') : cliOut("I cannot"));
  for (let pass = 1; pass <= MAX_STRIKES; pass++) await rowTitlePass({ call, run, strikes, log });
  assert.deepEqual(state.posts, [
    { hash: HASH, body: { title: "Stats: daily sales check" } },
    { hash: other.hash, body: { title: null } },
  ]);
  // The words are never logged.
  assert.ok(!JSON.stringify(logs).includes("example.test") && !JSON.stringify(logs).includes("Sharper"));

  const failing = fakeServer([{ hash: HASH, text: WORDS }]);
  const failingCall = async (path, method, body) => (await failing.fetch(`http://x${path}`, { method, headers: { authorization: "Bearer tok" }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
  await assert.rejects(rowTitlePass({ call: failingCall, run: async () => { throw new Error("signed out"); }, strikes: new Map(), log }), /signed out/);
  assert.deepEqual(failing.state.posts, []);
});

test("the loop stays off without the claude CLI", async () => {
  const logs = [];
  await runRowTitlerLoop({ origin: "http://x", token: "tok", fetch, claudeBin: null, log: (event) => logs.push(event), stop: new AbortController().signal });
  assert.deepEqual(logs, ["row-titler-off"]);
});
