import assert from "node:assert/strict";
import { test } from "node:test";
import { guessStepKind } from "../lib/threads.mjs";
import { parseArgs, run } from "../../scripts/rivet.mjs";

const TOKEN = "cd".repeat(32);
const ENV = { RIVET_BRIDGE_DEV: "1", RIVET_BOARD_TOKEN: TOKEN, RIVET_URL: "http://localhost:5999", RIVET_TIME_ZONE: "Pacific/Port_Moresby", PATH: "" };
const NOW = "2026-10-01T02:00:00.000Z";
const PR_URL = "https://github.com/example-org/example-repo/pull/328";

const THREAD = {
  id: "m-root",
  title: "Make the website menu bigger",
  status: null,
  statusFrom: null,
  project: null,
  ball: null,
  startedBy: "owner",
  count: 3,
  lastAt: "2026-09-30T23:00:00.000Z",
  lastFrom: "rivet",
  lastText: "on it",
};

/** A threads server in memory: any message of m-root names it, PATCH applies like the real route. */
function stubServer() {
  const state = {
    thread: {
      ...THREAD,
      steps: [{ kind: "ask", label: "You asked", at: "2026-09-30T20:00:00.000Z", auto: true, messageId: "m-root" }],
      messages: [
        { id: "m-root", from: "owner", text: "Make the website menu bigger", at: "2026-09-30T20:00:00.000Z" },
        { id: "m-2", from: "rivet", text: "on it", at: "2026-09-30T23:00:00.000Z" },
      ],
      more: false,
    },
    calls: /** @type {{ method: string, path: string, query: string, body?: any }[]} */ ([]),
  };
  /** @param {number} status @param {unknown} doc */
  const reply = (status, doc) => new Response(JSON.stringify(doc), { status, headers: { "content-type": "application/json" } });
  /** @param {string | URL | Request} url @param {RequestInit} [init] */
  const fetchFn = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";
    const headers = /** @type {Record<string, string>} */ (init.headers ?? {});
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    state.calls.push({ method, path: u.pathname, query: u.search, body });
    if (headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: "unauthorized" });
    if (u.pathname === "/api/threads" && method === "GET") {
      const { steps, messages, more, ...summary } = state.thread;
      return reply(200, { threads: [summary], open: { all: 0, none: 0 } });
    }
    const m = /^\/api\/threads\/(.+)$/.exec(u.pathname);
    if (!m || !["m-root", "m-2"].includes(decodeURIComponent(m[1]))) return reply(404, { error: "no such thread" });
    if (method === "GET") return reply(200, state.thread);
    if (method !== "PATCH") return reply(404, { error: "not found" });
    if (body.status === "done") return reply(400, { error: "invalid thread change", issues: [{ path: ["status"], message: "Invalid enum value" }] });
    const next = { ...state.thread };
    for (const key of ["title", "status", "project", "tag"]) if (key in body) next[key] = body[key];
    if (body.clearSteps) next.steps = next.steps.filter((step) => step.auto);
    next.steps = [...next.steps, ...(body.steps ?? []).map((/** @type {any} */ step) => ({ at: NOW, ...step }))];
    state.thread = next;
    return reply(200, next);
  };
  return { state, fetch: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchFn)) };
}

/**
 * @param {string[]} argv
 * @param {Partial<import("../../scripts/rivet.mjs").Deps>} [deps]
 */
async function cli(argv, deps = {}) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    env: ENV,
    now: () => new Date(NOW),
    exec: async () => {
      throw new Error("no exec in this test");
    },
    ...deps,
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
  });
  return { code, stdout, stderr };
}

/** @param {string} msg */
function usage(msg) {
  return (/** @type {any} */ err) => err.constructor.name === "UsageError" && err.message.includes(msg);
}

test("guesses a step's stage from its label, then a pull link", () => {
  assert.equal(guessStepKind("PR #328"), "pr");
  assert.equal(guessStepKind("opened #12"), "pr");
  assert.equal(guessStepKind("see github.com/x/y/pull/4"), "pr");
  assert.equal(guessStepKind("Shipped to dev"), "shipped");
  assert.equal(guessStepKind("deployed"), "shipped");
  assert.equal(guessStepKind("Shipped it"), "shipped");
  assert.equal(guessStepKind("Your OK"), "ok");
  assert.equal(guessStepKind("approved"), "ok");
  assert.equal(guessStepKind("Chat site-menu"), "chat");
  assert.equal(guessStepKind("Ask recorded"), "ask");
  assert.equal(guessStepKind("Merged", PR_URL), "pr");
  assert.equal(guessStepKind("Merged", "https://example.com/pull"), null);
  assert.equal(guessStepKind("Merged"), null);
  assert.equal(guessStepKind("support"), null);
});

test("parses thread set, show and list", () => {
  const set = parseArgs([
    "thread", "set", "m-2", "--status", "needs-you", "--title", "Menu size",
    "--step", "Merged", "--kind", "pr", "--url", PR_URL, "--at", "2026-10-01T01:00:00Z",
    "--step", "Shipped to dev",
    "--step", "Looked at it", "--kind", "chat",
    "--clear-steps", "--json",
  ]);
  assert.deepEqual([set.cmd, set.sub, set.args], ["thread", "set", ["m-2"]]);
  assert.deepEqual(set.fields, { status: "needs-you", title: "Menu size" });
  assert.deepEqual(set.threadSteps, [
    { label: "Merged", kind: "pr", url: PR_URL, at: "2026-10-01T01:00:00Z" },
    { label: "Shipped to dev", kind: "shipped" },
    { label: "Looked at it", kind: "chat" },
  ]);
  assert.equal(set.clearSteps, true);
  assert.equal(set.jsonOut, true);

  assert.deepEqual(parseArgs(["thread", "set", "m-2", "--status", "none", "--title", ""]).fields, { status: null, title: null });
  assert.deepEqual(parseArgs(["thread", "set", "m-2", "--status", ""]).fields, { status: null });
  assert.deepEqual(parseArgs(["thread", "set", "m-2", "--title", "none"]).fields, { title: "none" });
  assert.equal(parseArgs(["thread", "set", "m-2", "--clear-steps"]).clearSteps, true);

  const show = parseArgs(["thread", "show", "m-2", "--json"]);
  assert.deepEqual([show.sub, show.args, show.jsonOut], ["show", ["m-2"], true]);
  const list = parseArgs(["thread", "list", "--open"]);
  assert.deepEqual([list.sub, list.open], ["list", true]);
});

test("refuses bad thread usage", () => {
  assert.throws(() => parseArgs(["thread"]), usage("thread takes set, show, list"));
  assert.throws(() => parseArgs(["thread", "set"]), usage("thread set takes one message id"));
  assert.throws(() => parseArgs(["thread", "set", "a b", "--status", "shipped"]), usage("a message id must match"));
  assert.throws(() => parseArgs(["thread", "set", "m-2"]), usage("thread set needs something to set"));
  assert.throws(() => parseArgs(["thread", "set", "m-2", "--status", "done"]), usage("--status is none or one of working, needs-you, shipped, parked"));
  assert.throws(() => parseArgs(["thread", "set", "m-2", "--project", "rivet"]), usage("unknown option --project for thread set"));
  assert.throws(() => parseArgs(["thread", "set", "m-2", "--title", "x".repeat(121)]), usage("--title is one line of 1 to 120"));
  assert.throws(() => parseArgs(["thread", "set", "m-2", "--title", "two\nlines"]), usage("--title is one line"));
  assert.throws(() => parseArgs(["thread", "set", "m-2", "--kind", "pr"]), usage("--kind modifies the --step before it"));
  assert.throws(() => parseArgs(["thread", "set", "m-2", "--step", "PR #1", "--kind", "pr", "--kind", "ok"]), usage("one --kind per --step"));
  assert.throws(() => parseArgs(["thread", "set", "m-2", "--step", "Merged"]), usage('step "Merged": say which stage with --kind'));
  assert.throws(() => parseArgs(["thread", "set", "m-2", "--step", "PR #1", "--kind", "merged"]), usage("--kind is one of ask, chat, pr, ok, shipped"));
  assert.throws(() => parseArgs(["thread", "set", "m-2", "--step", "PR #1", "--url", "http://github.com/x"]), usage("--url is an https link"));
  assert.throws(() => parseArgs(["thread", "set", "m-2", "--step", "PR #1", "--at", "yesterday"]), usage("--at is an ISO time"));
  assert.throws(() => parseArgs(["thread", "set", "m-2", "--step", " "]), usage("a step is one line of 1 to 200"));
  assert.throws(() => parseArgs(["thread", "set", "m-2", "--step", "x".repeat(201), "--kind", "ask"]), usage("a step is one line of 1 to 200"));
  assert.throws(() => parseArgs(["thread", "set", "m-2", "--if-match", "1", "--status", "shipped"]), usage("unknown option --if-match for thread set"));
  assert.throws(() => parseArgs(["thread", "show", "m-2", "--status", "shipped"]), usage("unknown option --status for thread show"));
  assert.throws(() => parseArgs(["thread", "list", "m-2"]), usage("thread list takes no arguments"));
  assert.throws(() => parseArgs(["thread", "list", "--project", "rivet"]), usage("unknown option --project for thread list"));
});

test("usage errors exit 2 and send nothing", async () => {
  const server = stubServer();
  const guess = await cli(["thread", "set", "m-2", "--step", "Merged"], { fetch: server.fetch });
  assert.equal(guess.code, 2);
  assert.match(guess.stderr, /say which stage with --kind/);
  const bare = await cli(["thread", "set", "m-2"], { fetch: server.fetch });
  assert.equal(bare.code, 2);
  assert.equal(server.state.calls.length, 0);
});

test("thread set sends the brief's example as one PATCH and prints the summary", async () => {
  const server = stubServer();
  const set = await cli(["thread", "set", "m-2", "--status", "shipped", "--step", "PR #328", "--url", PR_URL], { fetch: server.fetch });
  assert.equal(set.code, 0, set.stderr);
  assert.equal(set.stdout, "thread m-root: Done · 2 steps\n");
  assert.deepEqual(server.state.calls.at(-1), {
    method: "PATCH", path: "/api/threads/m-2", query: "", body: { status: "shipped", steps: [{ kind: "pr", label: "PR #328", url: PR_URL }] },
  });

  const cleared = await cli(["thread", "set", "m-root", "--status", "none", "--title", "", "--clear-steps", "--json"], { fetch: server.fetch });
  assert.equal(cleared.code, 0, cleared.stderr);
  assert.deepEqual(server.state.calls.at(-1)?.body, { title: null, status: null, clearSteps: true });
  assert.equal(JSON.parse(cleared.stdout).steps.length, 1);

  const unknown = await cli(["thread", "set", "m-9", "--status", "shipped"], { fetch: server.fetch });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /http 404: no such thread/);
});

test("thread set --tag sets the thread's tag, none or an empty one clears it, and a long or two-line one is refused", async () => {
  assert.deepEqual(parseArgs(["thread", "set", "m-2", "--tag", "Dashboard"]).fields, { tag: "Dashboard" });
  assert.deepEqual(parseArgs(["thread", "set", "m-2", "--tag", "none"]).fields, { tag: null });
  assert.deepEqual(parseArgs(["thread", "set", "m-2", "--tag", ""]).fields, { tag: null });
  assert.throws(() => parseArgs(["thread", "set", "m-2", "--tag", "x".repeat(33)]), usage("--tag is one line of 1 to 32 characters, or none to clear it"));
  assert.throws(() => parseArgs(["thread", "set", "m-2", "--tag", "two\nlines"]), usage("--tag is one line"));
  assert.throws(() => parseArgs(["thread", "list", "--tag", "x"]), usage("unknown option --tag for thread list"));

  const server = stubServer();
  const set = await cli(["thread", "set", "m-2", "--tag", "Dashboard", "--json"], { fetch: server.fetch });
  assert.equal(set.code, 0, set.stderr);
  assert.deepEqual(server.state.calls.at(-1), { method: "PATCH", path: "/api/threads/m-2", query: "", body: { tag: "Dashboard" } });
  assert.equal(JSON.parse(set.stdout).tag, "Dashboard");
  const cleared = await cli(["thread", "set", "m-2", "--tag", "none"], { fetch: server.fetch });
  assert.equal(cleared.code, 0, cleared.stderr);
  assert.deepEqual(server.state.calls.at(-1)?.body, { tag: null });
});

test("thread show and list print one plain line each", async () => {
  const server = stubServer();
  await cli(["thread", "set", "m-2", "--status", "needs-you", "--step", "PR #328", "--url", PR_URL], { fetch: server.fetch });

  const show = await cli(["thread", "show", "m-2"], { fetch: server.fetch });
  assert.equal(show.code, 0, show.stderr);
  assert.equal(
    show.stdout,
    [
      "Make the website menu bigger",
      "Needs you · 2 steps · 3 messages · m-root",
      "steps:",
      "  Ask      You asked",
      `  PR       PR #328  ${PR_URL}`,
      "last 2 messages:",
      "  6:00am  owner   Make the website menu bigger",
      "  9:00am  rivet   on it",
      "",
    ].join("\n"),
  );
  assert.equal(JSON.parse((await cli(["thread", "show", "m-2", "--json"], { fetch: server.fetch })).stdout).id, "m-root");

  const list = await cli(["thread", "list", "--open"], { fetch: server.fetch });
  assert.equal(list.code, 0, list.stderr);
  assert.equal(list.stdout, "Needs you  Make the website menu bigger  9:00am  m-root\n");
  assert.equal(server.state.calls.at(-1)?.query, "?view=open&limit=300");
  const all = await cli(["thread", "list", "--json"], { fetch: server.fetch });
  assert.equal(JSON.parse(all.stdout).threads[0].id, "m-root");
  assert.equal(server.state.calls.at(-1)?.query, "?view=all&limit=300");
});

test("conversation done and undone PATCH the conversation with done, by any message of it", async () => {
  /** @type {{ method: string, path: string, body?: any }[]} */
  const calls = [];
  let done = false;
  /** @param {string | URL | Request} url @param {RequestInit} [init] */
  const fetchFn = async (url, init = {}) => {
    const u = new URL(String(url));
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? "GET", path: u.pathname, body });
    done = body.done;
    const doc = { ...THREAD, steps: [], messages: [], more: false, conversation: { id: "m-root", done } };
    return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
  };
  const deps = { fetch: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchFn)) };
  const first = await cli(["conversation", "done", "m-2"], deps);
  assert.equal(first.code, 0);
  assert.equal(first.stdout, "conversation m-root: done · Make the website menu bigger\n");
  assert.deepEqual(calls.at(-1), { method: "PATCH", path: "/api/conversations/m-2", body: { done: true } });
  const second = await cli(["conversation", "undone", "m-2"], deps);
  assert.equal(second.stdout, "conversation m-root: not done · Make the website menu bigger\n");
  assert.deepEqual(calls.at(-1)?.body, { done: false });

  assert.throws(() => parseArgs(["conversation", "done"]), usage("conversation done takes one message id"));
  assert.throws(() => parseArgs(["conversation", "done", "a b"]), usage("a message id must match"));
  assert.throws(() => parseArgs(["conversation", "finish", "m-2"]), usage("conversation takes show, list, done, undone"));
  // show and list are still the thread commands.
  assert.deepEqual([parseArgs(["conversation", "show", "m-2"]).cmd, parseArgs(["conversation", "list"]).cmd], ["thread", "thread"]);
});
