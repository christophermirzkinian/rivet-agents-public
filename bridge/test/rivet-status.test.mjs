import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fixBrief, parseArgs, run } from "../../scripts/rivet.mjs";

const TOKEN = "cd".repeat(32);
const ENV = { RIVET_BRIDGE_DEV: "1", RIVET_BOARD_TOKEN: TOKEN, RIVET_URL: "http://localhost:5999", RIVET_REPOS: "example-org/example-repo", PATH: "" };
const NOW = "2026-10-01T02:00:00.000Z";

/**
 * An ops status server in memory: GET, PUT and DELETE like the real routes.
 * @param {any[]} [seed]
 */
function stubServer(seed = []) {
  const state = { statuses: /** @type {any[]} */ ([...seed]), calls: /** @type {{ method: string, path: string, body?: any, ifMatch?: string }[]} */ ([]) };
  /** @param {number} status @param {unknown} doc */
  const reply = (status, doc) => new Response(JSON.stringify(doc), { status, headers: { "content-type": "application/json" } });
  /** @param {string | URL | Request} url @param {RequestInit} [init] */
  const fetchFn = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";
    const headers = /** @type {Record<string, string>} */ (init.headers ?? {});
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    state.calls.push({ method, path: u.pathname, body, ifMatch: headers["if-match"] });
    if (headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: "unauthorized" });
    if (u.pathname === "/api/ops/status" && method === "GET") return reply(200, { statuses: state.statuses });
    const m = /^\/api\/ops\/status\/([^/]+)\/(.+)$/.exec(u.pathname);
    if (!m) return reply(404, { error: "not found" });
    const [kind, key] = [m[1], decodeURIComponent(m[2])];
    const at = state.statuses.findIndex((s) => s.kind === kind && s.key === key);
    const current = at === -1 ? null : state.statuses[at];
    if (headers["if-match"] !== undefined && Number(headers["if-match"]) !== (current?.version ?? 0)) return reply(409, { error: "status version is stale", version: current?.version ?? 0 });
    if (method === "DELETE") {
      if (!current) return reply(404, { error: "no status for that item" });
      state.statuses.splice(at, 1);
      return reply(200, { ok: true });
    }
    if (method === "PUT") {
      if (body.state === "done") return reply(400, { error: "invalid status", issues: [{ path: ["state"], message: "Invalid enum value" }] });
      const next = { kind, key, since: NOW, ...(current ?? {}), updatedAt: NOW, version: (current?.version ?? 0) + 1 };
      // Another chat named without a repo drops the old chat's repo, as the route does.
      if (body.chat !== undefined && body.chat !== current?.chat && body.repo === undefined) delete next.repo;
      for (const [field, value] of Object.entries(body)) {
        if (value === null) delete next[field];
        else next[field] = value;
      }
      if (current) state.statuses[at] = next;
      else state.statuses.unshift(next);
      return reply(current ? 200 : 201, next);
    }
    return reply(404, { error: "not found" });
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
    holdsFile: path.join(os.tmpdir(), "rivet-status-test-no-holds", "holds.json"),
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

test("parses the status commands and refuses bad usage", () => {
  const set = parseArgs(["status", "set", "ci", "ci", "--state", "in-progress", "--note", "rerun queued", "--eta", "today 18:00", "--why", "rerun is slow", "--chat", "ci-fix", "--pr", "297", "--issue", "301", "--by", "monitor"]);
  assert.deepEqual([set.cmd, set.sub, set.args], ["status", "set", ["ci", "ci"]]);
  assert.deepEqual(set.fields, { state: "in-progress", note: "rerun queued", eta: "today 18:00", why: "rerun is slow", chat: "ci-fix", pr: 297, issue: 301, by: "monitor" });
  assert.deepEqual(parseArgs(["status", "set", "pr", "tools/12", "--state", "backlog", "--eta", "", "--pr", ""]).fields, { state: "backlog", eta: "", pr: "" });
  assert.equal(parseArgs(["status", "clear", "app", "reports", "--if-match", "2"]).ifMatch, "2");
  assert.equal(parseArgs(["status", "list", "--json"]).jsonOut, true);

  assert.throws(() => parseArgs(["status"]), usage("status takes set, clear, list"));
  assert.throws(() => parseArgs(["status", "set", "ci"]), usage("status set takes a kind and a key"));
  assert.throws(() => parseArgs(["status", "set", "deploy", "reports", "--state", "fixed"]), usage("the kind is one of ci, pr, app, machine"));
  assert.throws(() => parseArgs(["status", "set", "ci", "CI", "--state", "fixed"]), usage("a key must match"));
  assert.throws(() => parseArgs(["status", "set", "ci", "ci"]), usage("status set needs --state"));
  assert.throws(() => parseArgs(["status", "set", "ci", "ci", "--state", "done"]), usage("--state is one of investigating, in-progress, backlog, parked, fixed"));
  assert.throws(() => parseArgs(["status", "set", "ci", "ci", "--state", "fixed", "--note", " "]), usage("--note is 1 to 1000 characters"));
  assert.throws(() => parseArgs(["status", "set", "ci", "ci", "--state", "fixed", "--eta", "two\nlines"]), usage("--eta is one line"));
  // Work under way says when it will be done and why.
  for (const state of ["investigating", "in-progress"]) {
    assert.throws(() => parseArgs(["status", "set", "ci", "ci", "--state", state]), usage(`--state ${state} needs --eta`));
    assert.throws(() => parseArgs(["status", "set", "ci", "ci", "--state", state, "--eta", "3pm"]), usage(`--state ${state} needs --eta`));
    assert.throws(() => parseArgs(["status", "set", "ci", "ci", "--state", state, "--why", "flaky"]), usage(`--state ${state} needs --eta`));
  }
  assert.throws(() => parseArgs(["status", "set", "ci", "ci", "--state", "investigating", "--eta", "3pm", "--why", "x".repeat(141)]), usage("--why is one line of 1 to 140 characters"));
  assert.deepEqual(parseArgs(["status", "set", "ci", "ci", "--state", "investigating", "--eta", "3:30pm", "--why", "waiting on a rerun"]).fields, { state: "investigating", eta: "3:30pm", why: "waiting on a rerun" });
  assert.throws(() => parseArgs(["status", "set", "ci", "ci", "--state", "fixed", "--chat", "two words"]), usage("--chat must be a chat name"));
  assert.throws(() => parseArgs(["status", "set", "ci", "ci", "--state", "fixed", "--pr", "x"]), usage("--pr must be a positive whole number"));
  assert.throws(() => parseArgs(["status", "set", "ci", "ci", "--state", "fixed", "--by", ""]), usage("--by is one line"));
  assert.throws(() => parseArgs(["status", "clear", "ci", "ci", "--state", "fixed"]), usage("unknown option --state for status clear"));
  assert.throws(() => parseArgs(["status", "list", "--if-match", "1"]), usage("unknown option --if-match for status list"));
  assert.throws(() => parseArgs(["status", "list", "ci"]), usage("status list takes no arguments"));
});

test("status set, clear and list against the status routes", async () => {
  // Stored before the schema refused control characters: the list prints them stripped.
  const server = stubServer([{ kind: "app", key: "reports", state: "backlog", note: "old\x07\x1b[31m", since: NOW, updatedAt: NOW, version: 1 }]);
  const set = await cli(["status", "set", "ci", "ci", "--state", "in-progress", "--note", "rerun queued", "--eta", "today 18:00", "--why", "rerun is slow", "--chat", "ci-fix", "--pr", "297", "--by", "monitor"], { fetch: server.fetch });
  assert.equal(set.code, 0, set.stderr);
  assert.equal(set.stdout, "ci ci in-progress, version 1\n");
  assert.deepEqual(server.state.calls.at(-1), {
    method: "PUT", path: "/api/ops/status/ci/ci", body: { state: "in-progress", note: "rerun queued", eta: "today 18:00", why: "rerun is slow", chat: "ci-fix", pr: 297, by: "monitor" }, ifMatch: undefined,
  });

  const cleared = await cli(["status", "set", "ci", "ci", "--state", "backlog", "--eta", "", "--pr", "", "--if-match", "1"], { fetch: server.fetch });
  assert.equal(cleared.stdout, "ci ci backlog, version 2\n");
  assert.deepEqual(server.state.calls.at(-1)?.body, { state: "backlog", eta: null, pr: null });
  assert.equal(server.state.calls.at(-1)?.ifMatch, "1");

  const stale = await cli(["status", "set", "ci", "ci", "--state", "fixed", "--if-match", "1"], { fetch: server.fetch });
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /http 409: status version is stale/);

  const slash = stubServer();
  await cli(["status", "set", "pr", "tools/12", "--state", "fixed", "--json"], { fetch: slash.fetch });
  assert.equal(slash.state.calls.at(-1)?.path, "/api/ops/status/pr/tools%2F12");

  const list = await cli(["status", "list"], { fetch: server.fetch });
  assert.equal(server.state.calls.at(-1)?.path, "/api/ops/status");
  assert.equal(list.stdout, "ci ci  backlog  12:00pm  ci-fix  rerun queued\napp reports  backlog  12:00pm  old\n");
  const json = await cli(["status", "list", "--json"], { fetch: server.fetch });
  assert.deepEqual(JSON.parse(json.stdout).statuses.map((/** @type {any} */ s) => s.key), ["ci", "reports"]);

  const clear = await cli(["status", "clear", "app", "reports"], { fetch: server.fetch });
  assert.equal(clear.stdout, "app reports cleared\n");
  assert.deepEqual(server.state.calls.at(-1), { method: "DELETE", path: "/api/ops/status/app/reports", body: undefined, ifMatch: undefined });
  const missing = await cli(["status", "clear", "app", "reports"], { fetch: server.fetch });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /http 404: no status for that item/);
  assert.equal((await cli(["status", "list"], { fetch: stubServer().fetch })).stdout, "no statuses\n");
});

test("status set reports the server's refusal with its issues", async () => {
  const server = stubServer();
  const wrong = await cli(["status", "set", "ci", "ci", "--state", "fixed"], {
    fetch: /** @type {typeof fetch} */ (async () => new Response(JSON.stringify({ error: "invalid status", issues: [{ path: ["note"], message: "a note holds no control characters" }] }), { status: 400 })),
  });
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /http 400: invalid status \(note: a note holds no control characters\)/);
  const noToken = await cli(["status", "list"], { fetch: server.fetch, env: { ...ENV, RIVET_BOARD_TOKEN: "ef".repeat(32) } });
  assert.equal(noToken.code, 1);
  assert.match(noToken.stderr, /http 401/);
});

test("status set takes --cause and --prevent, each one line up to 100 characters", async () => {
  const set = parseArgs(["status", "set", "pr", "607", "--state", "fixed", "--cause", "runner ran out of disk", "--prevent", "the disk check pages at 80 percent"]);
  assert.deepEqual(set.fields, { state: "fixed", cause: "runner ran out of disk", prevent: "the disk check pages at 80 percent" });
  assert.throws(() => parseArgs(["status", "set", "pr", "607", "--state", "fixed", "--cause", "x".repeat(101)]), usage("--cause is one line of 1 to 100 characters"));
  assert.throws(() => parseArgs(["status", "set", "pr", "607", "--state", "fixed", "--prevent", "two\nlines"]), usage("--prevent is one line of 1 to 100 characters"));
  const server = stubServer();
  const sent = await cli(["status", "set", "pr", "607", "--state", "fixed", "--cause", "runner ran out of disk", "--prevent", "the disk check pages at 80 percent"], { fetch: server.fetch });
  assert.equal(sent.code, 0, sent.stderr);
  assert.deepEqual(server.state.calls.at(-1)?.body, { state: "fixed", cause: "runner ran out of disk", prevent: "the disk check pages at 80 percent" });
});

test("status key prints the key the app gives an item, without the server", async () => {
  const server = stubServer();
  /** @param {string[]} args */
  const key = async (...args) => {
    const out = await cli(["status", "key", ...args], { fetch: server.fetch });
    assert.equal(out.code, 0, out.stderr);
    return out.stdout.trim();
  };
  assert.equal(await key("machine", "build-3"), "build-3");
  assert.equal(await key("pr", "12", "--repo", "example-org/second-repo"), "second-repo/12");
  assert.equal(await key("ci", "deploy", "--repo", "example-org/tools"), "tools/deploy");
  assert.equal(await key("coming", "42"), "42");
  assert.equal(await key("coming", "42", "--repo", "example-org/third-repo"), "third-repo/42");
  // GitHub names a repo without regard to case: the default repo's key in any case is the bare one.
  assert.equal(await key("coming", "42", "--repo", "example-org/EXAMPLE-REPO"), "42");
  const [ci, lint, lint2] = [await key("ci", "CI"), await key("ci", "Lint API"), await key("ci", "Lint_API")];
  assert.match(ci, /^ci_[0-9a-z]{7}$/);
  assert.match(lint, /^lint-api_[0-9a-z]{7}$/);
  assert.notEqual(lint, lint2);
  const json = await cli(["status", "key", "disk", "Macintosh HD", "--json"], { fetch: server.fetch });
  assert.deepEqual(Object.keys(JSON.parse(json.stdout)), ["kind", "key"]);
  assert.deepEqual(server.state.calls, []);
  // What it prints, set takes.
  assert.equal((await cli(["status", "set", "ci", ci, "--state", "backlog"], { fetch: server.fetch })).code, 0);
  assert.equal(server.state.statuses[0].key, ci);

  assert.throws(() => parseArgs(["status", "key", "ci"]), usage("a kind and a name"));
  assert.throws(() => parseArgs(["status", "key", "deploy", "x"]), usage("the kind is one of"));
  assert.throws(() => parseArgs(["status", "key", "pr", "abc"]), usage("a pr's name is its number"));
  assert.throws(() => parseArgs(["status", "key", "machine", "x", "--repo", "a/b"]), usage("--repo goes with ci, pr or coming"));
  assert.throws(() => parseArgs(["status", "key", "ci", "x", "--repo", "nope"]), usage("--repo is owner/name"));
});

/** A chat runner in memory: its chats, what it was asked to open, and a failing or half-failing create. */
function fakeRunner({ chats = /** @type {any[]} */ ([]), fail = /** @type {string | undefined} */ (undefined), startsAnyway = false } = {}) {
  const made = /** @type {{ name: string, cwd: string, prompt: string }[]} */ ([]);
  return {
    made,
    context: () => ({}),
    ps: () => chats,
    send: () => null,
    create: (/** @type {any} */ _ctx, /** @type {{ name: string, cwd: string, prompt: string }} */ chat) => {
      if (fail) {
        if (startsAnyway) chats.push({ name: chat.name, status: "starting" });
        throw new Error(fail);
      }
      made.push(chat);
    },
  };
}

/** gh answering one open PR with the given body and no comments. @param {string} [body] */
const ghWith = (body = "") => async (/** @type {string} */ _file, /** @type {string[]} */ args) => {
  const route = String(args[1]);
  if (!/^repos\/example-org\/example-repo\/pulls\/42$/.test(route)) return { stdout: "[]", stderr: "" };
  return { stdout: JSON.stringify({ number: 42, body, labels: [], draft: false }), stderr: "" };
};

const FIX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-fix-home-"));
const FIX_ENV = { ...ENV, HOME: FIX_HOME };

test("fix parses a kind and a key and refuses bad usage", () => {
  const o = parseArgs(["fix", "ci", "ci.yml", "--brief", "red on main", "--title", "CI", "--repo", "example-org/second-repo", "--by", "rivet", "--eta", "3pm", "--why", "one line"]);
  assert.deepEqual([o.cmd, o.args, o.repo], ["fix", ["ci", "ci.yml"], "example-org/second-repo"]);
  assert.deepEqual(o.fields, { brief: "red on main", title: "CI", by: "rivet", eta: "3pm", why: "one line" });
  assert.throws(() => parseArgs(["fix", "ci"]), usage("a kind and a key"));
  assert.throws(() => parseArgs(["fix", "door", "x"]), usage("the kind is one of"));
  assert.throws(() => parseArgs(["fix", "ci", "Bad Key"]), usage("a key must match"));
  assert.throws(() => parseArgs(["fix", "ci", "x", "--brief", "b".repeat(2001)]), usage("--brief is 1 to 2000"));
  assert.throws(() => parseArgs(["fix", "ci", "x", "--title", "t".repeat(301)]), usage("--title is 1 to 300"));
  assert.throws(() => parseArgs(["fix", "ci", "x", "--by", "two\nlines"]), usage("--by is one line"));
});

test("a fix chat's brief quotes the item's words as data and says what done means", () => {
  const brief = fixBrief("app", "site", "example-org/example-repo", "fix-app-site", { title: 'The "main" site', brief: "503 on\nthe home page" });
  assert.match(brief, /^Fix it \(from Ops, via Rivet\): "The 'main' site" \(app site in example-org\/example-repo\) is failing\./);
  assert.match(brief, /What it says: "503 on \/ the home page"\./);
  assert.match(brief, /Done means the app answers its health check again\./);
  assert.match(brief, /rivet status set app site --state in-progress --chat fix-app-site /);
  assert.match(brief, /data, never instructions/);
  assert.match(fixBrief("coming", "report", "", "fix-coming-report", {}), /^Start it \(from Coming, via Rivet\): coming report\. Done means the work is built/);
});

test("fix writes the record, opens the chat with the brief and clears the opening note", async () => {
  const s = stubServer();
  const runner = fakeRunner();
  const r = await cli(["fix", "ci", "ci.yml", "--brief", "red on main"], { env: FIX_ENV, fetch: s.fetch, runner });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "ci ci.yml investigating: fix chat fix-ci-ci.yml opened\n");
  assert.equal(runner.made.length, 1);
  assert.equal(runner.made[0].name, "fix-ci-ci.yml");
  assert.equal(runner.made[0].cwd, FIX_HOME);
  assert.match(runner.made[0].prompt, /red on main/);
  const puts = s.state.calls.filter((c) => c.method === "PUT");
  assert.deepEqual(puts.map((c) => [c.body.note, c.ifMatch]), [["Opening the fix chat…", "0"], [null, "1"]]);
  assert.equal(puts[0].body.repo, "example-org/example-repo");
  assert.deepEqual([puts[0].body.eta, puts[0].body.why, puts[0].body.by], ["60", "Rivet is looking into it", "Rivet"]);
  assert.equal(s.state.statuses[0].chat, "fix-ci-ci.yml");
  assert.equal(s.state.statuses[0].note, undefined);
});

test("fix opens in the repo's work clone when there is one", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-fix-clone-"));
  const clone = path.join(home, ".rivet-agents", "work", "example-repo");
  fs.mkdirSync(clone, { recursive: true });
  const runner = fakeRunner();
  const r = await cli(["fix", "ci", "ci.yml"], { env: { ...ENV, HOME: home }, fetch: stubServer().fetch, runner });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(runner.made[0].cwd, clone);
});

test("a repo-bound fix with no repo set says so and writes nothing", async () => {
  const s = stubServer();
  const runner = fakeRunner();
  const r = await cli(["fix", "ci", "ci.yml"], { env: { ...FIX_ENV, RIVET_REPOS: "" }, fetch: s.fetch, runner });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no repo: pass --repo owner\/name or set RIVET_REPOS/);
  assert.deepEqual(s.state.calls, []);
  assert.deepEqual(runner.made, []);
});

test("an item whose chat is running or still opening keeps it; a closed chat gets a new one beside any name in use", async () => {
  const record = { kind: "ci", key: "ci.yml", state: "investigating", chat: "fix-ci-ci.yml", since: NOW, updatedAt: NOW, version: 3 };
  const open = await cli(["fix", "ci", "ci.yml"], { env: FIX_ENV, fetch: stubServer([record]).fetch, runner: fakeRunner({ chats: [{ name: "fix-ci-ci.yml", status: "running", state: "alive" }] }) });
  assert.equal(open.stdout, "ci ci.yml already has its fix chat: fix-ci-ci.yml\n");

  const opening = await cli(["fix", "ci", "ci.yml"], { env: FIX_ENV, fetch: stubServer([{ ...record, note: "Opening the fix chat…" }]).fetch, runner: fakeRunner() });
  assert.equal(opening.stdout, "ci ci.yml already has its fix chat: fix-ci-ci.yml\n");

  const runner = fakeRunner({ chats: [{ name: "fix-ci-ci.yml", status: "finished", state: "gone" }] });
  const closed = await cli(["fix", "ci", "ci.yml"], { env: FIX_ENV, fetch: stubServer([record]).fetch, runner });
  assert.equal(closed.code, 0, closed.stderr);
  assert.equal(runner.made[0].name, "fix-ci-ci.yml-2");
});

test("a pick-up leaves a parked item alone, and a person's fix does not", async () => {
  const parked = { kind: "app", key: "site", state: "parked", since: NOW, updatedAt: NOW, version: 2 };
  const runner = fakeRunner();
  const auto = await cli(["fix", "app", "site", "--by", "rivet"], { env: FIX_ENV, fetch: stubServer([parked]).fetch, runner });
  assert.equal(auto.stdout, "app site was parked after its pick-up was sent: no fix chat opens\n");
  assert.deepEqual(runner.made, []);
  const asked = await cli(["fix", "app", "site"], { env: FIX_ENV, fetch: stubServer([parked]).fetch, runner });
  assert.equal(asked.code, 0, asked.stderr);
  assert.equal(runner.made.length, 1);
});

test("a held PR opens no fix chat and writes no record", async () => {
  const s = stubServer();
  const runner = fakeRunner();
  const r = await cli(["fix", "pr", "42"], { env: FIX_ENV, fetch: s.fetch, runner, exec: ghWith("hold: waiting for the owner"), bin: () => "gh" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /held: .*waiting for the owner.*: no fix chat opens/);
  assert.deepEqual(runner.made, []);
  assert.equal(s.state.calls.filter((c) => c.method !== "GET").length, 0);
});

test("a PR whose holds cannot be read opens no fix chat", async () => {
  const runner = fakeRunner();
  const exec = async () => {
    throw new Error("gh exit 1");
  };
  const r = await cli(["fix", "pr", "42"], { env: FIX_ENV, fetch: stubServer().fetch, runner, exec, bin: () => "gh" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /held: could not read its holds \(gh exit 1\): no fix chat opens/);
  assert.deepEqual(runner.made, []);
});

test("a PR with no hold opens its fix chat", async () => {
  const runner = fakeRunner();
  const r = await cli(["fix", "pr", "42"], { env: FIX_ENV, fetch: stubServer().fetch, runner, exec: ghWith(), bin: () => "gh" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(runner.made[0].name, "fix-pr-42");
});

test("a chat that could not open puts the record back: gone when there was none, as it was when there was", async () => {
  const fresh = stubServer();
  const none = await cli(["fix", "ci", "ci.yml"], { env: FIX_ENV, fetch: fresh.fetch, runner: fakeRunner({ fail: "tmux is not installed" }) });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /the chat runner could not open fix-ci-ci\.yml: tmux is not installed/);
  assert.deepEqual(fresh.state.statuses, []);

  const old = { kind: "app", key: "site", state: "backlog", note: "later", since: NOW, updatedAt: NOW, version: 4, dueAt: NOW };
  const had = stubServer([old]);
  const some = await cli(["fix", "app", "site"], { env: FIX_ENV, fetch: had.fetch, runner: fakeRunner({ fail: "no" }) });
  assert.equal(some.code, 1);
  const back = had.state.calls.filter((c) => c.method === "PUT").at(-1);
  assert.deepEqual([back?.body.state, back?.body.note, back?.body.chat, back?.body.restore], ["backlog", "later", null, { dueAt: NOW }]);
});

test("a chat that may have started keeps its record, so the next fix cannot open a second", async () => {
  const s = stubServer();
  const r = await cli(["fix", "ci", "ci.yml"], { env: FIX_ENV, fetch: s.fetch, runner: fakeRunner({ fail: "timed out", startsAnyway: true }) });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the chat runner may have started fix-ci-ci\.yml, so its status still names it: timed out/);
  assert.equal(s.state.statuses[0].chat, "fix-ci-ci.yml");
});

test("a coming key is its repo's", async () => {
  const runner = fakeRunner();
  const wrong = await cli(["fix", "coming", "other/report", "--repo", "example-org/second-repo"], { env: FIX_ENV, fetch: stubServer().fetch, runner });
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /coming other\/report is not a key in example-org\/second-repo/);
  const named = await cli(["fix", "coming", "report", "--repo", "example-org/second-repo"], { env: FIX_ENV, fetch: stubServer().fetch, runner });
  assert.equal(named.code, 0, named.stderr);
  assert.match(named.stdout, /^coming second-repo\/report investigating: fix chat fix-coming-second-repo-report opened/);
});
