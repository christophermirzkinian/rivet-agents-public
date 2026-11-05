import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BadAnswer, CLAUDE_ARGS, CliError, MAX_STRIKES, cliDetail, makeClaudeRun, parseAnswer, runTitlerLoop, titlePass, titlePrompt, TITLER_MODEL } from "../lib/threads-titler.mjs";

const FAKE_KEY = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwx"].join("-");

const SECRET = "the dashboard chart looks blurry on my phone";

/** The CLI's --output-format json answer with `result` as the model's text. */
const cliOut = (result, extra = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result, ...extra });

/** An in-memory server: the untitled list and every POST the titler makes. */
function fakeServer(threads) {
  const state = { threads: [...threads], posts: [], gets: 0, status: 200 };
  /** @type {typeof fetch} */
  const fetch = async (url, init) => {
    const { pathname, search } = new URL(String(url));
    if (state.status !== 200) return new Response("{}", { status: state.status });
    assert.equal(init?.headers?.authorization, "Bearer tok");
    if (init?.method === "GET" && pathname === "/api/bridge/threads/untitled") {
      state.gets++;
      assert.equal(search, "?limit=10");
      return Response.json({ threads: state.threads });
    }
    const match = /^\/api\/bridge\/threads\/([^/]+)\/ai$/.exec(pathname);
    if (init?.method === "POST" && match) {
      const id = decodeURIComponent(match[1]);
      state.posts.push({ id, body: JSON.parse(String(init.body)) });
      state.threads = state.threads.filter((thread) => thread.id !== id);
      return Response.json({ id });
    }
    return new Response("{}", { status: 404 });
  };
  return { state, fetch };
}

const THREAD = { id: "m-1", project: null, messages: [{ from: "owner", text: SECRET }, { from: "rivet", text: "On it." }] };

test("runs Haiku at low effort in print mode with no tools, settings or MCP, and asks for strict JSON", () => {
  const args = [...CLAUDE_ARGS];
  assert.equal(args[0], "-p");
  assert.equal(args[args.indexOf("--model") + 1], TITLER_MODEL);
  assert.equal(TITLER_MODEL, "claude-haiku-5-5");
  assert.equal(args[args.indexOf("--effort") + 1], "low");
  // Haiku 5.5 answers a non-default temperature, top_p or top_k with a 400.
  assert.ok(!args.some((arg) => /temperature|top[_-]?[pk]/i.test(arg)));
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  for (const flag of ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) assert.ok(args.includes(flag), flag);
  // Message text goes on stdin, never in the arguments.
  assert.match(args[args.indexOf("--system-prompt") + 1], /one JSON object/);
  assert.equal(titlePrompt(THREAD), `Thread messages, oldest first:\n[Owner] ${SECRET}\n[Rivet] On it.\n\nAnswer with the JSON object only.`);
  assert.match(titlePrompt({ project: "rivet", messages: [{ from: "owner", text: "" }] }), /^Project already set: rivet\n.*\n\[Owner\] \(a photo or file\)/);
});

test("parses the answer, fenced or not, and refuses what does not fit", () => {
  assert.deepEqual(parseAnswer(cliOut('```json\n{"title": "Sharpen blurry chart.", "tag": "Dashboard", "project": "rivet"}\n```')), {
    title: "Sharpen blurry chart",
    tag: "Dashboard",
    project: "rivet",
  });
  assert.deepEqual(parseAnswer(cliOut('{"title":"Fix the form","tag":"","project":"apps"}')), { title: "Fix the form", tag: null, project: null });
  assert.throws(() => parseAnswer(cliOut("I can't help with that.")), BadAnswer);
  assert.throws(() => parseAnswer(cliOut(JSON.stringify({ title: "x".repeat(61), tag: null, project: null }))), BadAnswer);
  assert.throws(() => parseAnswer(cliOut(JSON.stringify({ title: "two\nlines", tag: null, project: null }))), BadAnswer);
  assert.throws(() => parseAnswer(cliOut(JSON.stringify({ title: "Fine", tag: "x".repeat(33), project: null }))), BadAnswer);
  assert.throws(() => parseAnswer(cliOut(JSON.stringify({ tag: "x", project: null }))), BadAnswer);
  // The CLI's own failures are not the thread's fault.
  assert.throws(() => parseAnswer("not json"), CliError);
  assert.throws(() => parseAnswer(cliOut("Not logged in", { is_error: true, subtype: "error_during_execution" })), CliError);
});

test("titles each untitled thread once and never logs message text", async () => {
  const server = fakeServer([THREAD, { id: "m-2", project: "rivet", messages: [{ from: "owner", text: "Pitch deck for Thursday" }] }]);
  const inputs = [];
  const logs = [];
  const run = async (input) => {
    inputs.push(input);
    return cliOut(input.includes("dashboard") ? '{"title":"Sharpen blurry chart","tag":"Dashboard","project":"rivet"}' : '{"title":"Pitch deck outline","tag":"Pitch deck","project":null}');
  };
  const strikes = new Map();
  const call = makeCall(server.fetch);
  assert.deepEqual(await titlePass({ call, run, strikes, log: (event, fields) => logs.push([event, fields]) }), { titled: 2, gaveUp: 0 });
  assert.deepEqual(server.state.posts, [
    { id: "m-1", body: { title: "Sharpen blurry chart", tag: "Dashboard", project: "rivet" } },
    { id: "m-2", body: { title: "Pitch deck outline", tag: "Pitch deck", project: null } },
  ]);
  assert.equal(inputs.length, 2);
  assert.ok(inputs[0].includes(SECRET));
  assert.deepEqual(logs, [["threads-titled", { titled: 2, gaveUp: 0 }]]);
  assert.ok(!JSON.stringify(logs).includes("dashboard"));
});

test("a bad answer is a strike; the third gives the thread up with an all-null answer", async () => {
  const server = fakeServer([THREAD]);
  const logs = [];
  const strikes = new Map();
  const call = makeCall(server.fetch);
  const run = async () => cliOut(`Here you go: ${SECRET}`);
  for (let pass = 1; pass < MAX_STRIKES; pass++) {
    assert.deepEqual(await titlePass({ call, run, strikes, log: (event, fields) => logs.push([event, fields]) }), { titled: 0, gaveUp: 0 });
    assert.equal(strikes.get("m-1"), pass);
  }
  assert.deepEqual(server.state.posts, []);
  assert.deepEqual(await titlePass({ call, run, strikes, log: (event, fields) => logs.push([event, fields]) }), { titled: 0, gaveUp: 1 });
  assert.deepEqual(server.state.posts, [{ id: "m-1", body: { title: null, tag: null, project: null } }]);
  assert.equal(strikes.size, 0);
  assert.ok(!JSON.stringify(logs).includes("dashboard"));
});

test("a failing CLI ends the pass with no strike, and the loop tries again next pass", async () => {
  const server = fakeServer([THREAD, { ...THREAD, id: "m-2" }]);
  const logs = [];
  const stop = new AbortController();
  let runs = 0;
  let passes = 0;
  await runTitlerLoop({
    origin: "http://localhost:5999",
    token: "tok",
    fetch: server.fetch,
    claudeBin: null,
    run: async () => {
      runs++;
      if (runs === 1) throw new Error("claude timed out");
      return cliOut('{"title":"Sharpen blurry chart","tag":"Dashboard","project":"rivet"}');
    },
    log: (event, fields) => logs.push([event, fields]),
    stop: stop.signal,
    sleep: async (ms) => {
      passes++;
      assert.equal(ms, 120_000);
      if (passes === 2) stop.abort();
    },
  });
  assert.deepEqual(logs[0], ["threads-titler-failed", { error: "claude timed out" }]);
  assert.deepEqual(server.state.posts.map((post) => post.id), ["m-1", "m-2"]);
  assert.equal(server.state.gets, 2);
});

test("an unauthorized server waits five minutes; no claude on PATH turns the titler off", async () => {
  const server = fakeServer([THREAD]);
  server.state.status = 401;
  const stop = new AbortController();
  const delays = [];
  await runTitlerLoop({
    origin: "http://localhost:5999",
    token: "tok",
    fetch: server.fetch,
    claudeBin: null,
    run: async () => assert.fail("no run without a list"),
    log: () => {},
    stop: stop.signal,
    sleep: async (ms) => {
      delays.push(ms);
      stop.abort();
    },
  });
  assert.deepEqual(delays, [300_000]);

  const logs = [];
  await runTitlerLoop({ origin: "http://x", token: "tok", fetch: server.fetch, claudeBin: null, log: (event, fields) => logs.push([event, fields]), stop: new AbortController().signal });
  assert.deepEqual(logs, [["threads-titler-off", { reason: "claude not on PATH" }]]);
});

/** titlePass's `call`, as runTitlerLoop builds it, over a fake fetch. */
function makeCall(fetch) {
  return async (path, method, body) => {
    const res = await fetch(`http://localhost:5999${path}`, { method, headers: { authorization: "Bearer tok" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return res.json();
  };
}

test("a shutdown during a pass ends the batch there and the loop with no interval's wait", async () => {
  const server = fakeServer([THREAD, { ...THREAD, id: "m-2" }]);
  const stop = new AbortController();
  let runs = 0;
  const loop = runTitlerLoop({
    origin: "http://localhost:5999",
    token: "tok",
    fetch: server.fetch,
    claudeBin: null,
    run: async () => {
      runs++;
      stop.abort();
      return cliOut('{"title":"Sharpen blurry chart","tag":"Dashboard","project":"rivet"}');
    },
    log: () => {},
    stop: stop.signal,
  });
  let timer;
  const hung = new Promise((resolve) => {
    timer = setTimeout(() => resolve("hung"), 1_000);
  });
  assert.equal(await Promise.race([loop.then(() => "done"), hung]), "done");
  clearTimeout(timer);
  assert.equal(runs, 1);
  assert.deepEqual(server.state.posts.map((post) => post.id), ["m-1"]);
});

// From a big $TMPDIR every call's `rg --files` is slow.
test("the CLI runs in the bridge's own empty directory, not the temp directory", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "titler-cwd-"));
  const savedHome = process.env.HOME;
  try {
    const stub = path.join(home, "claude");
    fs.writeFileSync(stub, "#!/bin/sh\ncat >/dev/null\npwd -P\n");
    fs.chmodSync(stub, 0o755);
    process.env.HOME = home;
    const cwd = (await makeClaudeRun(stub, ["-p"], 10_000)("hi")).trim();
    const dir = path.join(home, ".rivet-agents", "bridge", "claude-cwd");
    assert.equal(cwd, fs.realpathSync(dir));
    assert.notEqual(cwd, fs.realpathSync(os.tmpdir()));
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/** A stub `claude` that reads stdin, prints `record` as its JSON answer and exits with `code`. */
function stubCli(dir, name, record, code) {
  const stub = path.join(dir, name);
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(record));
  fs.writeFileSync(stub, `#!/bin/sh\ncat >/dev/null\ncat "${path.join(dir, `${name}.json`)}"\nexit ${code}\n`);
  fs.chmodSync(stub, 0o755);
  return stub;
}

/** The record the CLI prints when the model declines a thread, with exit 1. */
const REFUSAL = { type: "result", subtype: "success", is_error: true, stop_reason: "refusal", terminal_reason: "api_error", api_error_status: null, num_turns: 2, result: `API Error: Haiku 5.5 can't help with this. ${SECRET}` };

test("cliDetail names why from the record's fixed fields only, never its text", () => {
  assert.equal(cliDetail(JSON.stringify(REFUSAL)), "refused");
  assert.equal(cliDetail(JSON.stringify({ is_error: true, api_error_status: 401, result: `Invalid API key ${FAKE_KEY}` })), "api 401");
  assert.equal(cliDetail(JSON.stringify({ is_error: true, subtype: "error_max_budget_usd" })), "error_max_budget_usd");
  assert.equal(cliDetail(JSON.stringify({ is_error: true, subtype: "success", terminal_reason: "api_error" })), "api_error");
  assert.equal(cliDetail(JSON.stringify({ is_error: true, subtype: "Not logged in · run /login" })), "");
  assert.equal(cliDetail("Not logged in"), "");
  assert.throws(() => parseAnswer(JSON.stringify({ ...REFUSAL, is_error: true })), BadAnswer);
  assert.throws(() => parseAnswer(cliOut("x", { is_error: true, subtype: "error_max_budget_usd" })), /claude error_max_budget_usd/);
});

test("a refusal that exits 1 is a strike, not a failure that ends every pass, and the next thread is titled", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "titler-refusal-"));
  const savedHome = process.env.HOME;
  try {
    process.env.HOME = dir;
    const refuse = makeClaudeRun(stubCli(dir, "refuse", REFUSAL, 1), ["-p"], 10_000);
    const answer = makeClaudeRun(stubCli(dir, "answer", JSON.parse(cliOut('{"title":"Fix the chart","tag":null,"project":"rivet"}')), 0), ["-p"], 10_000);
    const server = fakeServer([THREAD, { ...THREAD, id: "m-2", messages: [{ from: "owner", text: "fix the chart" }] }]);
    const logs = [];
    const strikes = new Map();
    const call = makeCall(server.fetch);
    const run = (input) => (input.includes(SECRET) ? refuse(input) : answer(input));
    const log = (event, fields) => logs.push([event, fields]);
    assert.deepEqual(await titlePass({ call, run, strikes, log }), { titled: 1, gaveUp: 0 });
    assert.deepEqual(logs[0], ["threads-titler-bad-answer", { thread: "m-1", strike: 1, reason: "the model refused" }]);
    for (let pass = 2; pass < MAX_STRIKES; pass++) await titlePass({ call, run, strikes, log });
    assert.deepEqual(await titlePass({ call, run, strikes, log }), { titled: 0, gaveUp: 1 });
    assert.deepEqual(server.state.posts.map((post) => post.id), ["m-2", "m-1"]);
    assert.deepEqual(server.state.posts[1].body, { title: null, tag: null, project: null });
    assert.ok(!JSON.stringify(logs).includes("dashboard"));
  } finally {
    process.env.HOME = savedHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a CLI failure's log line says why in a few words, with no key or message text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "titler-reason-"));
  const savedHome = process.env.HOME;
  try {
    process.env.HOME = dir;
    const key = FAKE_KEY;
    const run = makeClaudeRun(stubCli(dir, "claude", { type: "result", subtype: "success", is_error: true, api_error_status: 401, result: `Invalid API key ${key} ${SECRET}` }, 1), ["-p"], 10_000);
    const server = fakeServer([THREAD]);
    const logs = [];
    const stop = new AbortController();
    await runTitlerLoop({ origin: "http://localhost:5999", token: "tok", fetch: server.fetch, claudeBin: null, run, log: (event, fields) => logs.push([event, fields]), stop: stop.signal, sleep: async () => stop.abort() });
    assert.deepEqual(logs, [["threads-titler-failed", { error: "claude exit 1: api 401" }]]);
    assert.deepEqual(server.state.posts, []);
  } finally {
    process.env.HOME = savedHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
