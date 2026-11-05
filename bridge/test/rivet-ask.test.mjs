import assert from "node:assert/strict";
import { test } from "node:test";
import { nextAskId, parseArgs, parseDueTime, run, when } from "../../scripts/rivet.mjs";

const TOKEN = "cd".repeat(32);
/** A fixed UTC+10 zone, so clock times read the same on any machine. */
const ZONE = "Etc/GMT-10";
const ENV = { RIVET_BRIDGE_DEV: "1", RIVET_BOARD_TOKEN: TOKEN, RIVET_URL: "http://localhost:5999", RIVET_TIME_ZONE: ZONE, PATH: "" };
const NOW = "2026-10-01T02:00:00.000Z";

/**
 * An asks server in memory: GET, POST and PATCH like the real routes.
 * @param {any[]} [seed] @param {Record<string, string>} [messages] your messages by id, for POST from
 */
function stubServer(seed = [], messages = {}) {
  const state = { asks: /** @type {any[]} */ ([...seed]), held: /** @type {string[] | undefined} */ (undefined), calls: /** @type {{ method: string, path: string, body?: any, ifMatch?: string }[]} */ ([]) };
  /** @param {number} status @param {unknown} doc */
  const reply = (status, doc) => new Response(JSON.stringify(doc), { status, headers: { "content-type": "application/json" } });
  /** @param {string | URL | Request} url @param {RequestInit} [init] */
  const fetchFn = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";
    const headers = /** @type {Record<string, string>} */ (init.headers ?? {});
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    state.calls.push({ method, path: `${u.pathname}${u.search}`, body, ifMatch: headers["if-match"] });
    if (headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: "unauthorized" });
    if (u.pathname === "/api/asks" && method === "GET") {
      const stage = u.searchParams.get("stage");
      const rows = [...state.asks].reverse().filter((a) => !stage || a.stage === stage);
      if (u.searchParams.get("all") !== "1") return reply(200, { asks: rows });
      // Pages of two, so every --all caller has to follow `next`.
      const from = Number(u.searchParams.get("before") ?? 0);
      return reply(200, { asks: rows.slice(from, from + 2), ...(from + 2 < rows.length ? { next: String(from + 2) } : {}) });
    }
    if (u.pathname === "/api/asks" && method === "POST") {
      if (state.asks.some((a) => a.id === body.id)) return reply(409, { error: `ask ${body.id} already exists` });
      if (state.held?.includes(body.id)) return reply(409, { error: `ask ${body.id} is held` });
      const { note, by, from, due, ...rest } = body;
      if (from !== undefined) {
        if (!messages[from]) return reply(404, { error: `no message ${from}` });
        rest.words ??= messages[from];
        rest.replyId ??= from;
      }
      if (rest.words === undefined) return reply(400, { error: "an ask needs words" });
      const ask = { who: "owner", stage: "queued", prs: [], ...rest, ...(due ? { dueAt: due } : {}), dueHistory: [], createdAt: body.createdAt ?? NOW, updatedAt: NOW, version: 1 };
      ask.timeline = [{ at: ask.createdAt, stage: ask.stage, ...(note ? { note } : {}) }];
      state.asks.push(ask);
      return reply(201, ask);
    }
    const m = /^\/api\/asks\/([^/]+)$/.exec(u.pathname);
    if (m && method === "PATCH") {
      const ask = state.asks.find((a) => a.id === decodeURIComponent(m[1]));
      if (!ask) return reply(404, { error: "no such ask" });
      if (headers["if-match"] !== undefined && Number(headers["if-match"]) !== ask.version) return reply(409, { error: "ask version is stale", version: ask.version });
      const { note, prs, due, ...rest } = body;
      if (due !== undefined && ask.dueAt !== undefined && Date.parse(due) > Date.parse(ask.dueAt) + 10 * 60_000) {
        if (!rest.why) return reply(400, { error: "a later time is a move: it needs a why" });
        ask.dueHistory = [...(ask.dueHistory ?? []), { at: NOW, dueAt: due, was: ask.dueAt, why: rest.why }];
      }
      if (due !== undefined) ask.dueAt = due;
      const moved = rest.stage !== undefined && rest.stage !== ask.stage;
      Object.assign(ask, rest);
      if (prs) ask.prs = [...new Set([...ask.prs, ...prs])];
      if (moved || note) ask.timeline.push({ at: NOW, ...(moved ? { stage: rest.stage } : {}), ...(note ? { note } : {}) });
      ask.version += 1;
      return reply(200, ask);
    }
    return reply(404, { error: "not found" });
  };
  return { state, fetch: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchFn)) };
}

/** A stored ask with the fields every one has. @param {Record<string, unknown>} fields */
function mk(fields) {
  return { words: "x", who: "owner", stage: "queued", prs: [], dueHistory: [], timeline: [], createdAt: NOW, stageAt: NOW, updatedAt: NOW, version: 1, ...fields };
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

test("parses the ask commands and refuses bad usage", () => {
  const open = parseArgs(["ask", "open", "make it bigger", "--who", "owner", "--card", "c1", "--pr", "12", "--pr", "13", "--chat", "quiz-app", "--reply", "r_1"]);
  assert.deepEqual([open.cmd, open.sub, open.args, open.prs], ["ask", "open", ["make it bigger"], [12, 13]]);
  assert.deepEqual(open.fields, { who: "owner", cardId: "c1", chat: "quiz-app", replyId: "r_1" });
  assert.equal(parseArgs(["ask", "close", "a-1", "parked", "--issue", "266"]).fields.issue, 266);
  assert.equal(parseArgs(["ask", "status", "a-1", "done", "--if-match", "3"]).ifMatch, "3");
  assert.equal(parseArgs(["ask", "open", "x", "--repo", "example-org/example-repo"]).fields.repo, "example-org/example-repo");
  assert.equal(parseArgs(["ask", "list", "--all"]).all, true);
  assert.equal(parseArgs(["ask", "status", "a-1", "needs-you", "--card", "c1"]).fields.stage, "needs-you");
  // The server cards a needs-you ask itself (asks/waits.ts), so a needs-you write names no card.
  assert.equal(parseArgs(["ask", "status", "a-1", "needs-you"]).fields.cardId, undefined);
  assert.equal(parseArgs(["ask", "set", "a-1", "--stage", "needs-you"]).fields.cardId, undefined);
  assert.equal(parseArgs(["ask", "status", "a-1", "review"]).fields.stage, "review");
  assert.equal(parseArgs(["ask", "close", "a-1", "done"]).fields.stage, "done");
  assert.equal(parseArgs(["ask", "list", "--status", "building"]).fields.stage, "building");
  assert.equal(parseArgs(["ask", "list", "--stage", "needs-you"]).fields.stage, "needs-you");
  const from = parseArgs(["ask", "open", "--from", "m_9", "--who", "rivet", "--stage", "building", "--due", "90", "--why", "two PRs"]);
  assert.deepEqual([from.args, from.fields], [[], { from: "m_9", who: "rivet", stage: "building", due: "90", why: "two PRs" }]);
  const set = parseArgs(["ask", "set", "a-1", "--stage", "review", "--due", "3pm", "--why", "CI", "--progress", "0.5", "--note", "n", "--chat", "c", "--pr", "4", "--card", "k1", "--if-match", "2"]);
  assert.deepEqual([set.args, set.fields, set.prs, set.ifMatch], [["a-1"], { stage: "review", due: "3pm", why: "CI", progress: 0.5, note: "n", chat: "c", cardId: "k1" }, [4], "2"]);
  assert.throws(() => parseArgs(["ask"]), usage("ask takes open, set, status, close, list"));
  assert.throws(() => parseArgs(["ask", "open"]), usage("your words in quotes"));
  assert.throws(() => parseArgs(["ask", "open", "x", "--who", "someone"]), usage("--who is owner, rivet"));
  assert.throws(() => parseArgs(["ask", "open", "x", "--id", "A_1"]), usage("--id must match"));
  assert.throws(() => parseArgs(["ask", "open", "x", "--note", "n"]), usage("unknown option --note for ask open"));
  assert.throws(() => parseArgs(["ask", "open", "--from", "bad id"]), usage("--from is a message id"));
  assert.throws(() => parseArgs(["ask", "status", "a-1", "finished"]), usage("the stage is one of"));
  assert.throws(() => parseArgs(["ask", "close", "a-1", "merged"]), usage("shipped, done or parked"));
  assert.throws(() => parseArgs(["ask", "close", "a-1", "building"]), usage("shipped, done or parked"));
  assert.throws(() => parseArgs(["ask", "close", "a-1", "parked"]), usage("close parked needs --issue N"));
  assert.throws(() => parseArgs(["ask", "close", "a-1", "shipped", "--issue", "3"]), usage("--issue goes with parked"));
  assert.throws(() => parseArgs(["ask", "list", "--status", "finished"]), usage("--stage is one of"));
  assert.throws(() => parseArgs(["ask", "open", "x", "--if-match", "1"]), usage("unknown option --if-match"));
  assert.throws(() => parseArgs(["ask", "status", "a-1", "shipped", "--repo", "example-repo"]), usage("--repo is owner/name"));
  assert.throws(() => parseArgs(["ask", "set", "a-1"]), usage("ask set needs something to set"));
  assert.throws(() => parseArgs(["ask", "set", "a-1", "--progress", "2"]), usage("--progress is a number from 0 to 1"));
  assert.throws(() => parseArgs(["ask", "set", "a-1", "--why", "two\nlines"]), usage("--why is one line"));
  assert.throws(() => parseArgs(["ask", "set", "a-1", "--why", "y".repeat(201)]), usage("--why is one line of 1 to 200"));
  assert.throws(() => parseArgs(["ask", "set", "a-1", "--stage", "finished"]), usage("--stage is one of"));
});

test("needs-you may name its card, and the list shows each ask's stage, due time and moves", async () => {
  const server = stubServer([
    mk({ id: "a-1", words: "pretend ask one", stage: "building" }),
    mk({ id: "a-2", words: "pretend ask two", stage: "needs-you", dueAt: "2026-10-01T08:10:00.000Z" }),
    mk({ id: "a-3", words: "pretend ask three", stage: "review", dueAt: "2026-10-06T23:00:00.000Z", dueHistory: [{ at: NOW, dueAt: "2026-10-06T23:00:00.000Z", was: NOW, why: "CI" }] }),
  ]);
  const waiting = await cli(["ask", "status", "a-1", "needs-you", "--card", "c1"], { fetch: server.fetch });
  assert.equal(waiting.code, 0, waiting.stderr);
  assert.equal(waiting.stdout, "a-1 needs-you, version 2\n");
  assert.deepEqual(server.state.calls.map((call) => [call.method, call.path, call.body]), [["PATCH", "/api/asks/a-1", { stage: "needs-you", cardId: "c1" }]]);

  const list = await cli(["ask", "list"], { fetch: server.fetch });
  assert.equal(
    list.stdout,
    "a-3  review, due Wed 9:00am, moved 1  2026-10-01  pretend ask three\na-2  needs-you, due 6:10pm  2026-10-01  pretend ask two\na-1  needs-you  2026-10-01  pretend ask one\n",
  );
  await cli(["ask", "list", "--status", "needs-you"], { fetch: server.fetch });
  assert.equal(server.state.calls.at(-1)?.path, "/api/asks?stage=needs-you");
});

test("ask open, status, close and list against the asks routes", async () => {
  // Stored before the schema refused control characters: the list prints them stripped.
  const server = stubServer([mk({ id: "a-7", words: "older\x07\x1b[31m", stage: "shipped" })], { m_9: "make the font bigger" });
  const opened = await cli(["ask", "open", "make the cards bigger", "--chat", "quiz-app", "--pr", "255", "--due", "90", "--why", "two PRs"], { fetch: server.fetch });
  assert.equal(opened.code, 0, opened.stderr);
  assert.equal(opened.stdout, "a-8\n");
  assert.deepEqual(server.state.calls.at(-1)?.body, { id: "a-8", words: "make the cards bigger", why: "two PRs", chat: "quiz-app", due: "2026-10-01T03:30:00.000Z", prs: [255] });
  assert.equal(server.state.calls.at(-2)?.path, "/api/asks?all=1");

  const explicit = await cli(["ask", "open", "glow", "--id", "lamp-glow", "--who", "rivet", "--json"], { fetch: server.fetch });
  assert.equal(JSON.parse(explicit.stdout).who, "rivet");
  const taken = await cli(["ask", "open", "glow", "--id", "lamp-glow"], { fetch: server.fetch });
  assert.equal(taken.code, 1);
  assert.match(taken.stderr, /http 409: ask lamp-glow already exists/);

  // From your message: the server fills your words.
  const fromMessage = await cli(["ask", "open", "--from", "m_9", "--id", "a-20", "--who", "rivet", "--json"], { fetch: server.fetch });
  assert.equal(fromMessage.code, 0, fromMessage.stderr);
  assert.deepEqual(server.state.calls.at(-1)?.body, { id: "a-20", who: "rivet", from: "m_9" });
  assert.deepEqual([JSON.parse(fromMessage.stdout).words, JSON.parse(fromMessage.stdout).replyId], ["make the font bigger", "m_9"]);

  const status = await cli(["ask", "status", "a-8", "building", "--note", "relayed", "--pr", "256", "--card", "card-255", "--repo", "example-org/example-repo"], { fetch: server.fetch });
  assert.equal(status.stdout, "a-8 building, due 1:30pm, version 2\n");
  assert.deepEqual(server.state.calls.at(-1), {
    method: "PATCH", path: "/api/asks/a-8", body: { stage: "building", note: "relayed", cardId: "card-255", repo: "example-org/example-repo", prs: [256] }, ifMatch: undefined,
  });

  const stale = await cli(["ask", "close", "a-8", "shipped", "--if-match", "1"], { fetch: server.fetch });
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /http 409: ask version is stale/);
  const parked = await cli(["ask", "close", "a-8", "parked", "--issue", "266", "--note", "after Lisbon"], { fetch: server.fetch });
  assert.equal(parked.stdout, "a-8 parked #266, due 1:30pm, version 3\n");
  assert.deepEqual(server.state.calls.at(-1)?.body, { stage: "parked", note: "after Lisbon", issue: 266 });
  const closed = await cli(["ask", "close", "a-20", "done"], { fetch: server.fetch });
  assert.equal(closed.stdout, "a-20 done, version 2\n");

  const list = await cli(["ask", "list"], { fetch: server.fetch });
  assert.equal(server.state.calls.at(-1)?.path, "/api/asks");
  assert.equal(
    list.stdout,
    "a-20  done  2026-10-01  make the font bigger\nlamp-glow  queued  2026-10-01  glow\na-8  parked #266, due 1:30pm  2026-10-01  quiz-app  make the cards bigger\na-7  shipped  2026-10-01  older\n",
  );
  const shipped = await cli(["ask", "list", "--stage", "shipped", "--json"], { fetch: server.fetch });
  assert.equal(server.state.calls.at(-1)?.path, "/api/asks?stage=shipped");
  assert.deepEqual(JSON.parse(shipped.stdout).asks.map((/** @type {any} */ a) => a.id), ["a-7"]);
  const all = await cli(["ask", "list", "--all"], { fetch: server.fetch });
  assert.equal(all.stdout, list.stdout);
  assert.deepEqual(server.state.calls.slice(-2).map((call) => call.path), ["/api/asks?all=1", "/api/asks?all=1&before=2"]);
  assert.equal((await cli(["ask", "list"], { fetch: stubServer().fetch })).stdout, "no asks\n");
});

test("ask set sends an absolute due, and a later one needs a why", async () => {
  const server = stubServer([mk({ id: "a-1", stage: "building" })]);
  const first = await cli(["ask", "set", "a-1", "--due", "90", "--progress", "0.25", "--stage", "review"], { fetch: server.fetch });
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(server.state.calls.at(-1)?.body, { stage: "review", progress: 0.25, due: "2026-10-01T03:30:00.000Z" });
  assert.equal(first.stdout, "a-1 review, due 1:30pm, version 2\n");
  // A clock time in RIVET_TIME_ZONE (UTC+10 here): 3pm on 1 October is 05:00Z.
  const moved = await cli(["ask", "set", "a-1", "--due", "3pm", "--why", "CI is slow"], { fetch: server.fetch });
  assert.equal(moved.code, 0, moved.stderr);
  assert.deepEqual(server.state.calls.at(-1)?.body, { why: "CI is slow", due: "2026-10-01T05:00:00.000Z" });
  assert.equal(moved.stdout, "a-1 review, due 3:00pm, moved 1, version 3\n");
  const unexplained = await cli(["ask", "set", "a-1", "--due", "tonight"], { fetch: server.fetch });
  assert.equal(unexplained.code, 1);
  assert.match(unexplained.stderr, /http 400: a later time is a move: it needs a why/);
  const before = server.state.calls.length;
  const unreadable = await cli(["ask", "set", "a-1", "--due", "soonish"], { fetch: server.fetch });
  assert.equal(unreadable.code, 2);
  assert.match(unreadable.stderr, /--due is minutes/);
  const tooFar = await cli(["ask", "set", "a-1", "--due", "2026-10-09T00:00:00Z"], { fetch: server.fetch });
  assert.equal(tooFar.code, 2);
  assert.match(tooFar.stderr, /at most 7 days out/);
  assert.equal(server.state.calls.slice(before).some((call) => call.method === "PATCH"), false);
});

test("parseDueTime reads minutes, clock times in the zone and ISO times; when prints the zone's 12-hour clock", async () => {
  const now = new Date(NOW);
  assert.deepEqual(parseDueTime("90", now, ZONE), { dueAt: "2026-10-01T03:30:00.000Z" });
  assert.deepEqual(parseDueTime("2h", now, ZONE), { dueAt: "2026-10-01T04:00:00.000Z" });
  assert.deepEqual(parseDueTime("3:30pm", now, ZONE), { dueAt: "2026-10-01T05:30:00.000Z" });
  assert.deepEqual(parseDueTime("15:30", now, ZONE), { dueAt: "2026-10-01T05:30:00.000Z" });
  assert.deepEqual(parseDueTime("tonight", now, ZONE), { dueAt: "2026-10-01T13:00:00.000Z" });
  // Already past today in the zone (it is noon there): tomorrow's.
  assert.deepEqual(parseDueTime("9am", now, ZONE), { dueAt: "2026-10-01T23:00:00.000Z" });
  // The same words in another zone name another instant.
  assert.deepEqual(parseDueTime("3pm", now, "UTC"), { dueAt: "2026-10-01T15:00:00.000Z" });
  assert.deepEqual(parseDueTime("2026-10-01T10:00:00+10:00", now, ZONE), { error: "--due must be ahead of now" });
  assert.deepEqual(parseDueTime("2026-10-02T10:00:00+10:00", now, ZONE), { dueAt: "2026-10-02T00:00:00.000Z" });
  assert.match(/** @type {any} */ (parseDueTime("0", now, ZONE)).error, /ahead of now/);
  assert.match(/** @type {any} */ (parseDueTime("2026-10-09T00:00:00Z", now, ZONE)).error, /at most 7 days/);
  assert.match(/** @type {any} */ (parseDueTime("later", now, ZONE)).error, /--due is minutes/);
  // New York's clocks go forward at 2am on 8 March 2026: 2:30am does not happen that night.
  assert.match(/** @type {any} */ (parseDueTime("2:30am", new Date("2026-03-08T05:00:00Z"), "America/New_York")).error, /does not happen/);
  assert.deepEqual(parseDueTime("3:30am", new Date("2026-03-08T05:00:00Z"), "America/New_York"), { dueAt: "2026-03-08T07:30:00.000Z" });
  assert.equal(when("2026-10-01T08:10:00.000Z", now, ZONE), "6:10pm");
  assert.equal(when("2026-10-06T23:00:00.000Z", now, ZONE), "Wed 9:00am");
  assert.equal(when("2026-10-09T23:00:00.000Z", now, ZONE), "Sat 10 Oct 9:00am");
  const badZone = await cli(["ask", "set", "a-1", "--due", "3pm"], { env: { ...ENV, RIVET_TIME_ZONE: "Nowhere/Land" }, fetch: stubServer([mk({ id: "a-1" })]).fetch });
  assert.equal(badZone.code, 2);
  assert.match(badZone.stderr, /RIVET_TIME_ZONE Nowhere\/Land is not a time zone/);
});

test("nextAskId takes the next number after the highest a-<n>", () => {
  assert.equal(nextAskId([]), "a-1");
  assert.equal(nextAskId([{ id: "a-2" }, { id: "a-10" }, { id: "l-99" }, { id: "a-x" }]), "a-11");
  // No digit limit; past 40 characters, the lowest free one.
  assert.equal(nextAskId([{ id: "a-999999999" }, { id: "a-1000000000" }]), "a-1000000001");
  assert.equal(nextAskId([{ id: `a-${"9".repeat(38)}` }, { id: "a-1" }]), "a-2");
});

test("ask open moves past an id the server says an action holds, a few times at most, never the same one twice", async () => {
  const server = stubServer([mk({ id: "a-999999999" }), mk({ id: "a-1000000000" })]);
  server.state.held = ["a-1000000001"];
  const opened = await cli(["ask", "open", "next one"], { fetch: server.fetch });
  assert.equal(opened.code, 0, opened.stderr);
  assert.equal(opened.stdout, "a-1000000002\n");
  const posts = server.state.calls.filter((call) => call.method === "POST").map((call) => call.body.id);
  assert.deepEqual(posts, ["a-1000000001", "a-1000000002"]);
  server.state.held = Array.from({ length: 10 }, (_, i) => `a-${1000000003 + i}`);
  const stuck = await cli(["ask", "open", "again"], { fetch: server.fetch });
  assert.equal(stuck.code, 1);
  const tried = server.state.calls.filter((call) => call.method === "POST").map((call) => call.body.id).slice(2);
  assert.equal(tried.length, 5);
  assert.equal(new Set(tried).size, 5);
});

