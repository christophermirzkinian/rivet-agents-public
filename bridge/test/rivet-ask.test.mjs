import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EMPTY_DONE_REFUSAL, emptyDoneLine } from "../lib/asks.mjs";
import { nextAskId, parseArgs, parseDueTime, run, when } from "../../scripts/rivet.mjs";

const TOKEN = "cd".repeat(32);
/** A fixed zone with no daylight saving, so clock times read the same on any machine. */
const ZONE = "Pacific/Port_Moresby";
const ENV = { RIVET_BRIDGE_DEV: "1", RIVET_BOARD_TOKEN: TOKEN, RIVET_URL: "http://localhost:5999", RIVET_TIME_ZONE: ZONE, PATH: "" };
const NOW = "2026-10-01T02:00:00.000Z";
/** What a move to done says is done: 6 words or more, as the Done card needs. */
const SAID = "The banner chart now shows a week";

/**
 * An asks server in memory: GET, POST and PATCH like the real routes.
 * @param {any[]} [seed] @param {Record<string, string>} [messages] your messages by id, for POST from
 */
function stubServer(seed = [], messages = {}) {
  const state = { asks: /** @type {any[]} */ ([...seed]), held: /** @type {string[] | undefined} */ (undefined), workers: /** @type {any[] | undefined} */ (undefined), chats: /** @type {any[] | undefined} */ ([]), calls: /** @type {{ method: string, path: string, body?: any, ifMatch?: string }[]} */ ([]) };
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
    // With no chats given the read fails, as with no server: the ask is written unchecked.
    if (u.pathname === "/api/workers" && method === "GET" && state.workers) return reply(200, { workers: state.workers });
    if (u.pathname === "/api/board" && method === "GET" && state.chats) return reply(200, { version: 6, board: { needs: [], coming: [], chats: state.chats } });
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
    if (m && method === "GET") {
      const ask = state.asks.find((a) => a.id === decodeURIComponent(m[1]));
      return ask ? reply(200, ask) : reply(404, { error: "no such ask" });
    }
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
  assert.equal(parseArgs(["ask", "status", "a-1", "done", "--note", SAID, "--if-match", "3"]).ifMatch, "3");
  assert.equal(parseArgs(["ask", "open", "x", "--repo", "example-org/example-repo"]).fields.repo, "example-org/example-repo");
  assert.equal(parseArgs(["ask", "list", "--all"]).all, true);
  assert.equal(parseArgs(["ask", "status", "a-1", "needs-you", "--card", "c1"]).fields.stage, "needs-you");
  // The server cards a needs-you ask itself (asks/waits.ts), so a needs-you write names no card.
  assert.equal(parseArgs(["ask", "status", "a-1", "needs-you"]).fields.cardId, undefined);
  assert.equal(parseArgs(["ask", "set", "a-1", "--stage", "needs-you"]).fields.cardId, undefined);
  assert.equal(parseArgs(["ask", "status", "a-1", "review"]).fields.stage, "review");
  assert.equal(parseArgs(["ask", "close", "a-1", "done", "--note", SAID]).fields.stage, "done");
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

test("a move to done says what is done in 6 words or more: --done items, else --note, else --why", async () => {
  const empty = usage(EMPTY_DONE_REFUSAL);
  assert.throws(() => parseArgs(["ask", "close", "a-1", "done", "--note", "answered"]), empty);
  assert.throws(() => parseArgs(["ask", "set", "a-1", "--stage", "done", "--why", "done"]), empty);
  assert.throws(() => parseArgs(["ask", "status", "a-1", "done", "--note", "Done. Fixed. Closed. Finished. Answered. Done."]), empty);
  assert.throws(() => parseArgs(["ask", "close", "a-1", "done", "--note", "the chart shows a week"]), empty);
  // With no line given here, the ask's stored why may say it (or it is already done): the server decides.
  assert.equal(parseArgs(["ask", "close", "a-1", "done"]).fields.stage, "done");
  // The --done items are the line, so a long note does not cover short items.
  assert.throws(() => parseArgs(["ask", "close", "a-1", "done", "--note", SAID, "--done", "Chart"]), empty);
  assert.equal(parseArgs(["ask", "close", "a-1", "done", "--note", SAID]).fields.note, SAID);
  assert.equal(parseArgs(["ask", "set", "a-1", "--stage", "done", "--why", SAID]).fields.why, SAID);
  assert.deepEqual(parseArgs(["ask", "close", "a-1", "done", "--done", "Chart shows a week", "--done", "Totals per day"]).doneItems, ["Chart shows a week", "Totals per day"]);
  // A slash or bracket is no word: done said over and over is still only done.
  assert.equal(emptyDoneLine("done / done / done / done"), true);
  assert.equal(emptyDoneLine("(done) (done) (done) (done) (done) (done)"), true);
  assert.equal(emptyDoneLine("Shipped the Windows app, signed and tested"), false);
  assert.throws(() => parseArgs(["ask", "close", "a-1", "done", "--note", "(done) (done) (done) (done) (done) (done)"]), empty);
  // Off a move to done there is nothing to say, and listing the done asks is a filter.
  assert.equal(parseArgs(["ask", "close", "a-1", "shipped"]).fields.stage, "shipped");
  assert.equal(parseArgs(["ask", "list", "--stage", "done"]).fields.stage, "done");

  const server = stubServer([mk({ id: "a-1" })]);
  const refused = await cli(["ask", "close", "a-1", "done", "--note", "answered"], { fetch: server.fetch });
  assert.equal(refused.code, 2);
  assert.ok(refused.stderr.includes(EMPTY_DONE_REFUSAL), refused.stderr);
  const why = await cli(["ask", "set", "a-1", "--stage", "done", "--why", "done"], { fetch: server.fetch });
  assert.equal(why.code, 2);
  assert.ok(why.stderr.includes(EMPTY_DONE_REFUSAL), why.stderr);
  assert.deepEqual(server.state.calls, [], "nothing is sent");
  const closed = await cli(["ask", "close", "a-1", "done", "--note", SAID], { fetch: server.fetch });
  assert.equal(closed.code, 0, closed.stderr);
  assert.deepEqual(server.state.calls.at(-1)?.body, { stage: "done", note: SAID });
  assert.equal(server.state.asks[0].stage, "done");
});

test("parses the done card's --done and --media, and refuses them off a move to done", () => {
  const set = parseArgs(["ask", "set", "a-1", "--stage", "done", "--done", SAID, "--done", "B", "--media", "shot.png"]);
  assert.deepEqual([set.fields, set.doneItems, set.doneMedia, set.media.stills], [{ stage: "done" }, [SAID, "B"], "shot.png", ["shot.png"]]);
  const close = parseArgs(["ask", "close", "a-1", "done", "--done", SAID, "--media", "clip.MP4", "--poster", "first.jpg", "--skip-corner-check"]);
  assert.deepEqual([close.doneItems, close.media.after, close.media.poster, close.media.skipCorner, close.media.stills], [[SAID], "clip.MP4", "first.jpg", true, []]);
  assert.deepEqual(parseArgs(["ask", "status", "a-1", "done", "--done", SAID]).doneItems, [SAID]);
  assert.equal(parseArgs(["ask", "close", "a-1", "done", "--note", SAID, "--media", "shot.jpeg"]).doneMedia, "shot.jpeg");
  const three = ["--done", SAID, "--done", "2", "--done", "3"];
  assert.equal(parseArgs(["ask", "set", "a-1", "--stage", "done", ...three]).doneItems?.length, 3);
  assert.equal(parseArgs(["ask", "set", "a-1", "--stage", "done", "--done", "word ".repeat(32)]).doneItems?.[0].length, 160);

  const off = usage("go with a move to done");
  assert.throws(() => parseArgs(["ask", "set", "a-1", "--done", "A"]), off);
  assert.throws(() => parseArgs(["ask", "set", "a-1", "--stage", "building", "--done", "A"]), off);
  assert.throws(() => parseArgs(["ask", "set", "a-1", "--note", "n", "--media", "shot.png"]), off);
  assert.throws(() => parseArgs(["ask", "status", "a-1", "shipped", "--done", "A"]), off);
  assert.throws(() => parseArgs(["ask", "close", "a-1", "shipped", "--media", "shot.png"]), off);
  assert.throws(() => parseArgs(["ask", "close", "a-1", "parked", "--issue", "3", "--done", "A"]), off);
  assert.throws(() => parseArgs(["ask", "set", "a-1", "--stage", "done", ...three, "--done", "4"]), usage("at most 3 --done items"));
  assert.throws(() => parseArgs(["ask", "set", "a-1", "--stage", "done", "--done", "two\nlines"]), usage("--done is one line of 1 to 160"));
  assert.throws(() => parseArgs(["ask", "set", "a-1", "--stage", "done", "--done", "x".repeat(161)]), usage("--done is one line of 1 to 160"));
  assert.throws(() => parseArgs(["ask", "set", "a-1", "--stage", "done", "--done", "  "]), usage("--done is one line of 1 to 160"));
  assert.throws(() => parseArgs(["ask", "set", "a-1", "--stage", "done", "--media", "notes.pdf"]), usage("--media is a png or jpg still, or an mp4 clip"));
  assert.throws(() => parseArgs(["ask", "set", "a-1", "--stage", "done", "--media", "clip.webm"]), usage("--media is a png or jpg still, or an mp4 clip"));
  assert.throws(() => parseArgs(["ask", "set", "a-1", "--stage", "done", "--media", "a.png", "--media", "b.png"]), usage("--media is one still or one clip"));
  assert.throws(() => parseArgs(["ask", "set", "a-1", "--stage", "done", "--media", "a.png", "--poster", "p.png"]), usage("--poster and --skip-corner-check go with an mp4 --media"));
  assert.throws(() => parseArgs(["ask", "close", "a-1", "done", "--skip-corner-check"]), usage("--poster and --skip-corner-check go with an mp4 --media"));
  // The other ask commands take none of them.
  assert.throws(() => parseArgs(["ask", "open", "x", "--done", "A"]), usage("unknown option --done"));
  assert.throws(() => parseArgs(["ask", "list", "--media", "a.png"]), usage("unknown option --media"));
});

/**
 * stubServer with the media store's PUT beside it, and every request in order.
 * @param {any[]} seed
 * @param {number} [putStatus] what the media PUT answers
 */
function mediaServer(seed, putStatus = 201) {
  const server = stubServer(seed);
  const media = /** @type {{ sha256: string, type: string }[]} */ ([]);
  const order = /** @type {string[]} */ ([]);
  /** @param {string | URL | Request} url @param {RequestInit} [init] */
  const fetchFn = async (url, init = {}) => {
    const u = new URL(String(url));
    order.push(`${init.method ?? "GET"} ${u.pathname}`);
    if (!u.pathname.startsWith("/api/bridge/media/")) return server.fetch(url, init);
    if (putStatus !== 201) return new Response(JSON.stringify({ error: "the media store is full" }), { status: putStatus, headers: { "content-type": "application/json" } });
    media.push({ sha256: u.pathname.slice("/api/bridge/media/".length), type: /** @type {Record<string, string>} */ (init.headers)["content-type"] });
    return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
  };
  return { ...server, media, order, fetch: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchFn)) };
}

/** ffprobe saying a png of this size, and ffmpeg decoding a frame with something in it. @param {number} width @param {number} height */
function stillExec(width, height) {
  /** @type {import("../lib/config.mjs").Exec} */
  return async (bin, args) => {
    if (bin === "/fake/ffprobe") return { stdout: JSON.stringify({ streams: [{ codec_name: "png", width, height }], format: { format_name: "png_pipe" } }), stderr: "" };
    fs.writeFileSync(/** @type {string} */ (args.at(-1)), Buffer.from(Array.from({ length: 64 * 64 * 4 }, (_, i) => (i % 4 === 3 ? 255 : (i * 37) % 256))));
    return { stdout: "", stderr: "" };
  };
}

test("--done items ride on the move to done", async () => {
  const server = mediaServer([mk({ id: "a-1" }), mk({ id: "a-2" }), mk({ id: "a-3" }), mk({ id: "a-4" })]);
  const patches = () => server.state.calls.filter((call) => call.method === "PATCH");
  const set = await cli(["ask", "set", "a-1", "--stage", "done", "--done", SAID, "--done", "B"], { fetch: server.fetch });
  assert.equal(set.code, 0, set.stderr);
  assert.deepEqual(patches().at(-1), { method: "PATCH", path: "/api/asks/a-1", body: { stage: "done", done: [SAID, "B"] }, ifMatch: undefined });
  const close = await cli(["ask", "close", "a-2", "done", "--note", "shipped", "--done", "The banner chart shows a week"], { fetch: server.fetch });
  assert.equal(close.code, 0, close.stderr);
  assert.deepEqual(patches().at(-1)?.body, { stage: "done", note: "shipped", done: ["The banner chart shows a week"] });
  const status = await cli(["ask", "status", "a-3", "done", "--done", SAID, "--done", "2", "--done", "3"], { fetch: server.fetch });
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(patches().at(-1)?.body, { stage: "done", done: [SAID, "2", "3"] });
  // A move with no --done sends none.
  assert.equal((await cli(["ask", "close", "a-4", "done", "--note", SAID], { fetch: server.fetch })).code, 0);
  assert.deepEqual(patches().at(-1)?.body, { stage: "done", note: SAID });
  assert.deepEqual(server.media, []);
});

test("--media is checked, uploaded, then named on the move to done; a still over 1600 px exits 5 with nothing sent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-done-"));
  const png = path.join(dir, "shot.png");
  const bytes = Buffer.from("89504e470d0a1a0a0000", "hex");
  fs.writeFileSync(png, bytes);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const deps = { bin: (/** @type {string} */ name) => `/fake/${name}`, tmpdir: dir };

  const server = mediaServer([mk({ id: "a-1" }), mk({ id: "a-2" })]);
  const sent = await cli(["ask", "close", "a-1", "done", "--done", "The banner is on the Lab", "--media", png], { ...deps, fetch: server.fetch, exec: stillExec(720, 1558) });
  assert.equal(sent.code, 0, sent.stderr);
  assert.deepEqual(server.media, [{ sha256, type: "image/png" }]);
  assert.deepEqual(server.order, [`PUT /api/bridge/media/${sha256}`, "PATCH /api/asks/a-1"], "uploaded before the ask names it");
  assert.deepEqual(server.state.calls.at(-1)?.body, { stage: "done", done: ["The banner is on the Lab"], doneMedia: { kind: "stills", stills: [{ sha256, type: "image/png" }] } });
  // 1600 px on the longest side is the most a still may be.
  const edge = await cli(["ask", "set", "a-2", "--stage", "done", "--note", SAID, "--media", png], { ...deps, fetch: server.fetch, exec: stillExec(1600, 900) });
  assert.equal(edge.code, 0, edge.stderr);
  assert.deepEqual(server.state.calls.at(-1)?.body, { stage: "done", note: SAID, doneMedia: { kind: "stills", stills: [{ sha256, type: "image/png" }] } });

  const big = mediaServer([mk({ id: "a-1" })]);
  const refused = await cli(["ask", "close", "a-1", "done", "--done", SAID, "--media", png], { ...deps, fetch: big.fetch, exec: stillExec(2000, 900) });
  assert.equal(refused.code, 5);
  assert.match(refused.stderr, /rivet: shot\.png: 2000x900, over 1600 px on its longest side; scale it down \(sips -Z 1600 shot\.png\)/);
  assert.deepEqual(big.order, [], "nothing uploaded or patched");
  assert.deepEqual(big.media, []);
  assert.equal(big.state.asks[0].stage, "queued");
});

test("past the pre-flight, a picture the server will not take costs the picture, not the close", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-done-"));
  const png = path.join(dir, "shot.png");
  const bytes = Buffer.from("89504e470d0a1a0a0000", "hex");
  fs.writeFileSync(png, bytes);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const deps = { bin: (/** @type {string} */ name) => `/fake/${name}`, tmpdir: dir };

  const full = mediaServer([mk({ id: "a-1" })], 507);
  const closed = await cli(["ask", "close", "a-1", "done", "--done", "The banner is on the Lab", "--media", png], { ...deps, fetch: full.fetch, exec: stillExec(720, 1558) });
  assert.equal(closed.code, 0, closed.stderr);
  assert.match(closed.stderr, /rivet: the picture did not go up \(.*the media store is full.*\); closing the ask without it\n/);
  assert.deepEqual(full.order, [`PUT /api/bridge/media/${sha256}`, "PATCH /api/asks/a-1"]);
  assert.deepEqual(full.state.calls.at(-1)?.body, { stage: "done", done: ["The banner is on the Lab"] });
  assert.equal(full.state.asks[0].stage, "done");
  assert.deepEqual(full.media, []);
  // A pre-flight problem is still exit 5 with nothing sent.
  const big = mediaServer([mk({ id: "a-1" })], 507);
  const refused = await cli(["ask", "close", "a-1", "done", "--done", SAID, "--media", png], { ...deps, fetch: big.fetch, exec: stillExec(2000, 900) });
  assert.equal(refused.code, 5);
  assert.deepEqual(big.order, []);
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

test("an ask's --chat a short tail off a live chat's name is refused; one not on the Town yet is noted; an unread Town warns", async () => {
  const server = stubServer([mk({ id: "a-7" }), mk({ id: "a-9", repo: "sam/side-tool" })]);
  server.state.workers = [
    { chat: "build-chat-21", repo: "example-org/example-repo" },
    { chat: "side-chat", repo: "sam/side-tool" },
    // A row with no chat name is skipped, never matched.
    { chat: null, repo: "example-org/example-repo" },
  ];
  const writes = () => server.state.calls.filter((call) => call.method !== "GET").length;
  const town = { fetch: server.fetch, env: { ...ENV, RIVET_REPOS: "example-org/example-repo" } };

  const tailed = await cli(["ask", "set", "a-7", "--chat", "build-chat-21-fd"], town);
  assert.equal(tailed.code, 2);
  assert.equal(tailed.stderr, "rivet: no chat is named build-chat-21-fd on the Town; did you mean build-chat-21? pass --chat build-chat-21, or --force to write build-chat-21-fd as it is\n");
  // A set checks the ask's own repo's chats, naming a repo other than the main one; it has no --repo to pass.
  const away = await cli(["ask", "set", "a-9", "--chat", "side-chat-fd"], town);
  assert.equal(away.code, 2);
  assert.match(away.stderr, /did you mean side-chat in sam\/side-tool\? pass --chat side-chat, or --force to write side-chat-fd as it is\n$/);
  // An open or status reads the main repo's chats unless --repo names another, which the hint then names.
  const opened = await cli(["ask", "open", "glow", "--chat", "side-chat-fd"], town);
  assert.deepEqual([opened.code, opened.stderr], [0, "rivet: note: side-chat-fd is not on the Town yet\n"]);
  const there = await cli(["ask", "status", "a-7", "building", "--chat", "side-chat-fd", "--repo", "sam/side-tool"], town);
  assert.equal(there.code, 2);
  assert.match(there.stderr, /pass --chat side-chat --repo sam\/side-tool, or --force/);
  // A status with no --repo keeps the ask's own repo, so it reads that repo's chats: a-9's is side-tool's.
  const asksRepo = await cli(["ask", "status", "a-9", "building", "--chat", "side-chat-fd"], town);
  assert.equal(asksRepo.code, 2);
  assert.match(asksRepo.stderr, /did you mean side-chat in sam\/side-tool\? pass --chat side-chat --repo sam\/side-tool, or --force/);
  // a-7 names none, so it is in the main repo, where side-chat is not; another repo's exact name never lets a tail through.
  const mainAsk = await cli(["ask", "status", "a-7", "building", "--chat", "side-chat-fd"], town);
  assert.deepEqual([mainAsk.code, mainAsk.stderr], [0, "rivet: note: side-chat-fd is not on the Town yet\n"]);
  assert.equal(writes(), 2);
  server.state.workers.push({ chat: "build-chat-21-fd", repo: "sam/side-tool" });
  const elsewhere = await cli(["ask", "status", "a-7", "building", "--chat", "build-chat-21-fd"], town);
  assert.equal(elsewhere.code, 2);
  const setElsewhere = await cli(["ask", "set", "a-7", "--chat", "build-chat-21-fd"], town);
  assert.equal(setElsewhere.code, 2);
  server.state.workers.pop();
  // An ask that cannot be read checks every repo's chats.
  const noAsk = await cli(["ask", "status", "a-40", "building", "--chat", "side-chat-fd"], town);
  assert.equal(noAsk.code, 2);
  assert.equal(writes(), 2);

  const exact = await cli(["ask", "set", "a-7", "--chat", "build-chat-21"], town);
  assert.deepEqual([exact.code, exact.stderr], [0, ""]);
  // Only a tail added off a live name is a near miss: one cut off, a numbered name used again and a long tail are notes.
  for (const chat of ["build-chat", "build-chat-21-2", "build-chat-21-12", "build-chat-21-follow-up", "null-ab"]) {
    const noted = await cli(["ask", "set", "a-7", "--chat", chat], town);
    assert.deepEqual([noted.code, noted.stderr], [0, `rivet: note: ${chat} is not on the Town yet\n`]);
  }
  const forced = await cli(["ask", "set", "a-7", "--chat", "build-chat-21-fd", "--force"], town);
  assert.deepEqual([forced.code, forced.stderr], [0, ""]);
  assert.equal(server.state.asks[0].chat, "build-chat-21-fd");

  server.state.workers = undefined;
  const unread = await cli(["ask", "set", "a-7", "--chat", "build-chat-21-xy"], town);
  assert.equal(unread.code, 0, unread.stderr);
  assert.match(unread.stderr, /^rivet: warning: could not read the chats on the Town \(.+\): --chat build-chat-21-xy is written unchecked\n$/);
  assert.equal(server.state.asks[0].chat, "build-chat-21-xy");
});

test("a status record's or a card's --chat a short tail off a live chat's name is refused before it is written", async () => {
  const server = stubServer();
  server.state.workers = [{ chat: "build-chat-21", repo: "sam/side-tool" }];
  const status = await cli(["status", "set", "disk", "data", "--state", "parked", "--chat", "build-chat-21-fd"], { fetch: server.fetch });
  assert.equal(status.code, 2);
  assert.match(status.stderr, /did you mean build-chat-21 in sam\/side-tool\? pass --chat build-chat-21, or --force/);
  const card = await cli(["card", "add", "c1", "--kind", "update", "--title", "Done", "--chat", "build-chat-21-fd"], { fetch: server.fetch });
  assert.equal(card.code, 2);
  assert.match(card.stderr, /did you mean build-chat-21 in sam\/side-tool\?/);
  assert.equal(server.state.calls.filter((call) => call.method !== "GET").length, 0);
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
  const closed = await cli(["ask", "close", "a-20", "done", "--note", SAID], { fetch: server.fetch });
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
  // Listing the done asks is a filter, never a move to done that must say what is done.
  const done = await cli(["ask", "list", "--stage", "done", "--json"], { fetch: server.fetch });
  assert.equal(done.code, 0, done.stderr);
  assert.equal(server.state.calls.at(-1)?.path, "/api/asks?stage=done");
  assert.deepEqual(JSON.parse(done.stdout).asks.map((/** @type {any} */ a) => a.id), ["a-20"]);
  const all =await cli(["ask", "list", "--all"], { fetch: server.fetch });
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
  // A clock time in RIVET_TIME_ZONE: 3pm on 1 October is 05:00Z.
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
  assert.deepEqual(parseDueTime("2026-10-01T02:00:00+02:00", now, ZONE), { error: "--due must be ahead of now" });
  assert.deepEqual(parseDueTime("2026-10-02T02:00:00+02:00", now, ZONE), { dueAt: "2026-10-02T00:00:00.000Z" });
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

