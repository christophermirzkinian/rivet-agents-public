import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  aggregate,
  baseModel,
  collect,
  emptyState,
  encodeProjectPath,
  loadSpendState,
  monthStartLowerBound,
  projectLabel,
  pushSpend,
  runSpendLoop,
  saveSpendState,
  usageCost,
  zoneDay,
} from "../lib/spend.mjs";

// A UTC+10 zone with daylight saving, and two repos: the Mac's own settings must not change these tests.
const ZONE = "Antarctica/Macquarie";
process.env.RIVET_TIME_ZONE = ZONE;
process.env.RIVET_REPOS = "example-org/example-repo,example-org/other-repo";

// The test sessions run in the folder example-repo/sample-chat; every line carries that cwd.
const HOME = os.homedir();
const CWD = `${HOME}/code/example-repo/sample-chat`;
const PROJECT = encodeProjectPath(CWD);
const SECRET = "the secret prompt text";

/** @param {Record<string, unknown>} fields */
const line = (fields) => `${JSON.stringify(fields)}\n`;
const user = (/** @type {string} */ timestamp) => line({ type: "user", timestamp, cwd: CWD, message: { content: SECRET } });
const meta = () => line({ type: "last-prompt", lastPrompt: SECRET });
// Opus 5.5 output is $20 per million tokens, so 50k output tokens cost $1.
/** @param {string} timestamp @param {string} id @param {number} outputTokens @param {string} [model] */
const asst = (timestamp, id, outputTokens, model = "claude-opus-5-5") =>
  line({ type: "assistant", timestamp, cwd: CWD, sessionId: "s1", message: { id, model, content: SECRET, usage: { output_tokens: outputTokens } } });
/** @param {number} startTime @param {Record<string, number>} models @param {string} [sessionId] @param {number} [totalDuration] */
const cost = (startTime, models, sessionId = "s1", totalDuration = undefined) =>
  line({
    type: "cost-state",
    sessionId,
    ...(totalDuration === undefined ? {} : { totalDuration }),
    totalCostUSD: Object.values(models).reduce((a, b) => a + b, 0),
    startTime,
    modelUsage: Object.fromEntries(Object.entries(models).map(([m, c]) => [m, { inputTokens: 1, costUSD: c }])),
  });

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-spend-"));
  const projects = path.join(root, "projects");
  fs.mkdirSync(path.join(projects, PROJECT), { recursive: true });
  return { root, projects, file: path.join(projects, PROJECT, "s1.jsonl") };
}

const NOW = new Date("2026-09-28T06:00:00.000Z"); // 16:00 local
/** Writes with an mtime of `at`, so the month filter sees the test's clock, not the real one. */
function put(/** @type {string} */ file, /** @type {string} */ body, at = NOW) {
  fs.writeFileSync(file, body);
  fs.utimesSync(file, at, at);
}
function add(/** @type {string} */ file, /** @type {string} */ body, at = NOW) {
  fs.appendFileSync(file, body);
  fs.utimesSync(file, at, at);
}
const agg = (/** @type {any} */ state, now = NOW) => aggregate(state, { now });

test("zoneDay: midnight, the month edge, and both DST changes", () => {
  assert.equal(zoneDay(new Date("2026-09-27T13:59:59.999Z")), "2026-09-27");
  assert.equal(zoneDay(new Date("2026-09-27T14:00:00.000Z")), "2026-09-28");
  assert.equal(zoneDay(new Date("2026-09-30T14:00:00.000Z")), "2026-10-01");
  // Daylight time from 2026-10-04 02:00: midnight moves to 13:00Z.
  assert.equal(zoneDay(new Date("2026-10-03T13:59:59.000Z")), "2026-10-03");
  assert.equal(zoneDay(new Date("2026-10-03T14:00:00.000Z")), "2026-10-04");
  assert.equal(zoneDay(new Date("2026-10-04T12:59:59.000Z")), "2026-10-04");
  assert.equal(zoneDay(new Date("2026-10-04T13:00:00.000Z")), "2026-10-05");
  // Back to standard time on 2026-04-05 03:00: that day runs 13:00Z to 14:00Z the next day.
  assert.equal(zoneDay(new Date("2026-04-04T13:00:00.000Z")), "2026-04-05");
  assert.equal(zoneDay(new Date("2026-04-05T13:59:59.000Z")), "2026-04-05");
  assert.equal(zoneDay(new Date("2026-04-05T14:00:00.000Z")), "2026-04-06");
});

/** Runs `fn` with `zone` as the configured zone, then puts the test zone back. @param {string} zone @param {() => void} fn */
function inZone(zone, fn) {
  process.env.RIVET_TIME_ZONE = zone;
  try {
    fn();
  } finally {
    process.env.RIVET_TIME_ZONE = ZONE;
  }
}

test("zoneDay and the month's lower bound hold in a quarter-hour zone and at UTC+14", () => {
  inZone("Asia/Kathmandu", () => {
    // UTC+5:45: midnight falls at 18:15Z, a day edge a whole-hour offset would miss.
    assert.equal(zoneDay(new Date("2026-09-27T18:14:59.000Z")), "2026-09-27");
    assert.equal(zoneDay(new Date("2026-09-27T18:15:00.000Z")), "2026-09-28");
  });
  inZone("Pacific/Kiritimati", () => {
    assert.equal(zoneDay(new Date("2026-09-30T09:59:59.000Z")), "2026-09-30");
    assert.equal(zoneDay(new Date("2026-09-30T10:00:00.000Z")), "2026-10-01");
    // The first instant of the month is at or after the bound, in the zone furthest ahead.
    assert.ok(monthStartLowerBound(new Date("2026-10-15T00:00:00.000Z")) <= Date.parse("2026-09-30T10:00:00.000Z"));
  });
  inZone("Pacific/Pago_Pago", () => {
    assert.equal(zoneDay(new Date("2026-10-01T10:59:59.000Z")), "2026-09-30");
    assert.equal(zoneDay(new Date("2026-10-01T11:00:00.000Z")), "2026-10-01");
    assert.ok(monthStartLowerBound(new Date("2026-10-15T00:00:00.000Z")) <= Date.parse("2026-10-01T11:00:00.000Z"));
  });
});

test("projectLabel returns only a label learnt from cwd, never a guess from the folder name", () => {
  const labels = { "-home-sam-code-example-repo-site": { repo: "example-repo", chat: "site", seen: "2026-09-28" } };
  assert.deepEqual(projectLabel("-home-sam-code-example-repo-site", labels), { repo: "example-repo", chat: "site" });
  assert.deepEqual(projectLabel("-home-sam-code-example-repo-site-clients", labels), { repo: "other" });
  assert.deepEqual(projectLabel("-home-sam-code-other-repo-x-private-chat", labels), { repo: "other" });
  assert.deepEqual(projectLabel("constructor", labels), { repo: "other" });
});

/** One session in its own project folder, launched at `launch`, whose lines carry `cwds`. */
async function labelOf(/** @type {string} */ launch, /** @type {(string | undefined)[]} */ cwds) {
  const t = tmp();
  const project = encodeProjectPath(launch);
  fs.mkdirSync(path.join(t.projects, project), { recursive: true });
  const lines = cwds.map((cwd) => line({ type: "user", timestamp: "2026-09-28T00:59:00.000Z", ...(cwd ? { cwd } : {}), message: { content: SECRET } }));
  put(path.join(t.projects, project, "s2.jsonl"), lines.join("") + line({ type: "assistant", timestamp: "2026-09-28T01:00:00.000Z", sessionId: "s2", message: { id: "m1", model: "claude-opus-5-5", usage: { output_tokens: 50_000 } } }));
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  const out = agg(state);
  return { rows: out.today.byChat, json: JSON.stringify(out) };
}

test("a chat's usage counts under the repo named in RIVET_REPOS and the folder after it", async () => {
  const launch = `${HOME}/code/other-repo/paint-box`;
  const { rows } = await labelOf(launch, [launch]);
  assert.deepEqual(rows, [{ repo: "other-repo", chat: "paint-box", usd: 1, estimatedUSD: 1 }]);
});

test("a session in the repo's own folder counts under the repo, with no chat", async () => {
  const launch = `${HOME}/code/other-repo`;
  const { rows } = await labelOf(launch, [launch]);
  assert.deepEqual(rows, [{ repo: "other-repo", usd: 1, estimatedUSD: 1 }]);
});

test("a folder name is never decoded: with no cwd, a repo-looking folder is other", async () => {
  const { rows } = await labelOf(`${HOME}/code/example-repo/x/private-chat`, [undefined]);
  assert.deepEqual(rows, [{ repo: "other", usd: 1, estimatedUSD: 1 }]);
});

test("a session in a repo's subfolder takes the one segment after the repo, and nothing below it leaves", async () => {
  const launch = `${HOME}/code/other-repo/chat/clients/confidential/customer`;
  const { rows, json } = await labelOf(launch, [launch]);
  assert.deepEqual(rows, [{ repo: "other-repo", chat: "chat", usd: 1, estimatedUSD: 1 }]);
  for (const secret of ["clients", "confidential", "customer", HOME]) assert.ok(!json.includes(secret), secret);
});

test("only the first repo name in the path is read: a nested one is not a second label", async () => {
  const launch = `${HOME}/code/other-repo/chat/fixtures/example-repo/confidential-client`;
  const { rows, json } = await labelOf(launch, [launch]);
  assert.deepEqual(rows, [{ repo: "other-repo", chat: "chat", usd: 1, estimatedUSD: 1 }]);
  for (const secret of ["example-repo", "confidential-client", "fixtures"]) assert.ok(!json.includes(secret), secret);
});

test("with no repo set every session is other, and nothing fails", async (t) => {
  const repos = process.env.RIVET_REPOS;
  delete process.env.RIVET_REPOS;
  t.after(() => { process.env.RIVET_REPOS = repos; });
  const { rows } = await labelOf(CWD, [CWD]);
  assert.deepEqual(rows, [{ repo: "other", usd: 1, estimatedUSD: 1 }]);
});

test("a label older than its TTL is kept while its project still has spend, and dropped once it has none", async () => {
  const t = tmp();
  put(t.file, user("2026-09-28T00:59:00.000Z") + asst("2026-09-28T01:00:00.000Z", "m1", 50_000));
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  state.labels[PROJECT].seen = "2026-06-01";
  state.labels["-idle-project"] = { repo: "other-repo", chat: "idle", seen: "2026-06-01" };
  await collect(state, { projectsDir: t.projects, now: NOW });
  assert.deepEqual(agg(state).today.byChat, [{ repo: "example-repo", chat: "sample-chat", usd: 1, estimatedUSD: 1 }]);
  assert.equal(Object.hasOwn(state.labels, "-idle-project"), false);
});

test("a rejected cwd never falls through to a guess", async () => {
  // Not the launch path (a later cd), and an unknown repo.
  const launch = `${HOME}/code/example-repo/x/private-chat`;
  let { rows } = await labelOf(launch, [`${HOME}/code/example-repo/x`]);
  assert.deepEqual(rows, [{ repo: "other", usd: 1, estimatedUSD: 1 }]);
  ({ rows } = await labelOf(`${HOME}/code/someone-else/chat`, [`${HOME}/code/someone-else/chat`]));
  assert.deepEqual(rows, [{ repo: "other", usd: 1, estimatedUSD: 1 }]);
});

test("a cost-state adds its increase at the nearest timestamped line, per model", async () => {
  const t = tmp();
  put(
    t.file,
    user("2026-09-28T01:00:00.000Z") + meta() + cost(1, { opus: 10, sonnet: 1 }) + user("2026-09-28T02:00:00.000Z"),
  );
  const state = emptyState();
  const r = await collect(state, { projectsDir: t.projects, now: NOW });
  assert.equal(r.records, 1);
  const out = agg(state);
  assert.equal(out.today.totalUSD, 11);
  assert.deepEqual(out.today.byModel, { opus: 10, sonnet: 1 });
  assert.deepEqual(out.today.byChat, [{ repo: "example-repo", chat: "sample-chat", usd: 11, estimatedUSD: 0 }]);
  assert.equal(out.thisMonth.totalUSD, 11);
  assert.ok(!JSON.stringify(out).includes(SECRET));
});

test("the nearer neighbour wins: a following timestamp closer than the preceding one", async () => {
  const t = tmp();
  // Preceding timestamp is yesterday (local) and three lines back; the next is one line on, today.
  put(t.file, user("2026-09-27T12:00:00.000Z") + meta() + meta() + cost(1, { opus: 4 }) + user("2026-09-27T14:30:00.000Z"));
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  assert.equal(agg(state).today.totalUSD, 4);
});

test("local day boundary: 13:59Z and 14:00Z land on different days", async () => {
  const t = tmp();
  put(
    t.file,
    user("2026-09-27T13:59:00.000Z") + cost(1, { opus: 3 }) + user("2026-09-27T14:01:00.000Z") + cost(1, { opus: 8 }),
  );
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  assert.deepEqual(Object.keys(state.buckets).sort(), ["2026-09-27", "2026-09-28"]);
  const out = agg(state);
  assert.equal(out.today.totalUSD, 5);
  assert.equal(out.thisMonth.totalUSD, 8);
});

test("DST: after the October change, today starts at 13:00Z", async () => {
  const t = tmp();
  const now = new Date("2026-10-05T02:00:00.000Z");
  put(
    t.file,
    user("2026-10-04T12:59:00.000Z") + cost(1, { opus: 2 }) + user("2026-10-04T13:00:30.000Z") + cost(1, { opus: 7 }),
    now,
  );
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now });
  const out = agg(state, now);
  assert.equal(out.day, "2026-10-05");
  assert.equal(out.today.totalUSD, 5);
  assert.equal(out.thisMonth.totalUSD, 7);
});

test("a session restart is a new run: both runs count in full", async () => {
  const t = tmp();
  put(
    t.file,
    user("2026-09-28T01:00:00.000Z") + cost(1000, { opus: 10 }) + user("2026-09-28T02:00:00.000Z") + cost(2000, { opus: 3 }),
  );
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  assert.equal(agg(state).today.totalUSD, 13);
});

test("out-of-order records in one run: a stale lower total adds nothing, and nothing is counted twice", async () => {
  const t = tmp();
  put(
    t.file,
    user("2026-09-28T03:00:00.000Z") +
      cost(1, { opus: 5 }) +
      cost(1, { opus: 8 }) +
      user("2026-09-28T01:00:00.000Z") +
      cost(1, { opus: 6 }) +
      cost(1, { opus: 8 }) +
      cost(1, { opus: 9, sonnet: 1 }),
  );
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  const out = agg(state);
  assert.equal(out.today.totalUSD, 10);
  assert.deepEqual(out.today.byModel, { opus: 9, sonnet: 1 });
});

test("a truncated last line waits for its newline and then counts once", async () => {
  const t = tmp();
  const head = user("2026-09-28T01:00:00.000Z");
  const tail = cost(1, { opus: 5 });
  put(t.file, head + tail.slice(0, 40));
  const state = emptyState();
  let r = await collect(state, { projectsDir: t.projects, now: NOW });
  assert.equal(r.records, 0);
  assert.equal(state.files[`${PROJECT}/s1.jsonl`].offset, Buffer.byteLength(head));
  assert.equal(agg(state).today.totalUSD, 0);

  add(t.file, tail.slice(40));
  r = await collect(state, { projectsDir: t.projects, now: NOW });
  assert.equal(r.records, 1);
  assert.equal(agg(state).today.totalUSD, 5);
  r = await collect(state, { projectsDir: t.projects, now: NOW });
  assert.equal(r.records, 0);
  assert.equal(agg(state).today.totalUSD, 5);
});

test("incremental offsets survive a save and load, and only new lines are read", async () => {
  const t = tmp();
  const stateFile = path.join(t.root, "state", "spend-state.json");
  put(t.file, user("2026-09-28T01:00:00.000Z") + cost(1, { opus: 5 }));
  let state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  saveSpendState(stateFile, state);
  assert.equal((fs.statSync(stateFile).mode & 0o777).toString(8), "600");

  state = loadSpendState(stateFile);
  const size = fs.statSync(t.file).size;
  assert.equal(state.files[`${PROJECT}/s1.jsonl`].offset, size);
  let r = await collect(state, { projectsDir: t.projects, now: NOW });
  assert.equal(r.records, 0);

  add(t.file, user("2026-09-28T02:00:00.000Z") + cost(1, { opus: 12 }));
  r = await collect(state, { projectsDir: t.projects, now: NOW });
  assert.equal(r.records, 1);
  assert.equal(agg(state).today.totalUSD, 12);
  assert.equal(state.files[`${PROJECT}/s1.jsonl`].offset, fs.statSync(t.file).size);
});

test("a rewritten file is read again without counting its runs twice", async () => {
  const t = tmp();
  const body = user("2026-09-28T01:00:00.000Z") + cost(1, { opus: 5 }) + user("2026-09-28T01:30:00.000Z") + cost(1, { opus: 6 });
  put(t.file, body);
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  fs.rmSync(t.file);
  put(t.file, user("2026-09-28T01:00:00.000Z") + cost(1, { opus: 5 }));
  const r = await collect(state, { projectsDir: t.projects, now: NOW });
  assert.equal(r.records, 1);
  assert.equal(agg(state).today.totalUSD, 6);
});

test("files untouched this local month are skipped; old day buckets are pruned", async () => {
  const t = tmp();
  fs.writeFileSync(t.file, user("2026-08-10T01:00:00.000Z") + cost(1, { opus: 50 }));
  const old = new Date("2026-08-10T02:00:00.000Z");
  fs.utimesSync(t.file, old, old);
  const state = emptyState();
  state.buckets["2026-07-31"] = { [PROJECT]: { opus: 1 } };
  state.buckets["2026-08-31"] = { [PROJECT]: { opus: 1 } };
  const r = await collect(state, { projectsDir: t.projects, now: NOW });
  assert.equal(r.files, 0);
  assert.deepEqual(Object.keys(state.buckets), ["2026-08-31"]);
  assert.equal(agg(state).thisMonth.totalUSD, 0);
});

test("lines that are not JSON, and cost-states without a session, are skipped", async () => {
  const t = tmp();
  put(
    t.file,
    "not json\n" + user("2026-09-28T01:00:00.000Z") + line({ type: "cost-state", totalCostUSD: 99, startTime: 1 }) + cost(1, { opus: 2 }),
  );
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  assert.equal(agg(state).today.totalUSD, 2);
});

test("pushSpend sends the aggregate with the bridge token and keeps the offsets", async () => {
  const t = tmp();
  const stateFile = path.join(t.root, "spend-state.json");
  put(t.file, user("2026-09-28T01:00:00.000Z") + cost(1, { opus: 5 }));
  /** @type {any[]} */
  const sent = [];
  const fetchFn = async (/** @type {string} */ url, /** @type {any} */ init) => {
    sent.push({ url, init });
    return new Response("{}", { status: 200 });
  };
  const logs = [];
  await pushSpend({
    origin: "https://rivet.test",
    token: "ab".repeat(32),
    fetch: /** @type {any} */ (fetchFn),
    stateFile,
    projectsDir: t.projects,
    now: () => NOW,
    log: (e, f) => logs.push([e, f]),
  });
  assert.equal(sent[0].url, "https://rivet.test/api/bridge/spend");
  assert.equal(sent[0].init.method, "PUT");
  assert.equal(sent[0].init.headers.authorization, `Bearer ${"ab".repeat(32)}`);
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.today.totalUSD, 5);
  assert.equal(body.timeZone, ZONE);
  assert.ok(!sent[0].init.body.includes(SECRET));
  assert.ok(fs.existsSync(stateFile));
});

test("usageCost prices each token kind at the model's rates", () => {
  assert.equal(usageCost("claude-opus-5-5", { output_tokens: 1e6 }), 20);
  assert.equal(
    usageCost("claude-opus-5-5[1m]", { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }),
    4 + 20 + 0.2 + 5,
  );
  assert.equal(usageCost("claude-haiku-4-5-20251001", { input_tokens: 1e6 }), 1);
  assert.equal(usageCost("claude-sonnet-5-5", { output_tokens: 1e6 }), 10);
  assert.equal(usageCost("claude-someday-9", { output_tokens: 1e6 }), 20);
});

test("Haiku 5.5 is priced by prompt length, split at 100k prompt tokens", () => {
  assert.equal(baseModel("claude-haiku-5-5-20261007"), "claude-haiku-5-5");
  assert.equal(baseModel("claude-haiku-5-5[1m]"), "claude-haiku-5-5");
  const near = (/** @type {number} */ a, /** @type {number} */ b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
  // 100k prompt tokens exactly: the short-prompt card.
  near(usageCost("claude-haiku-5-5", { input_tokens: 40_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 10_000, output_tokens: 1e6 }),
    (40_000 * 0.1 + 50_000 * 0.01 + 10_000 * 0.125) / 1e6 + 0.5);
  // One token over, counting cache reads and writes: every kind at the long-prompt card.
  near(usageCost("claude-haiku-5-5-20261007", { input_tokens: 40_001, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 10_000, output_tokens: 1e6 }),
    (40_001 * 0.5 + 50_000 * 0.05 + 10_000 * 0.625) / 1e6 + 2.5);
  // Models with one card ignore prompt length.
  assert.equal(usageCost("claude-haiku-4-5", { input_tokens: 2e5 }), 0.2);
});

test("Haiku 5.5 prices one-hour cache writes at its one-hour rate", () => {
  const near = (/** @type {number} */ a, /** @type {number} */ b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
  // Short prompt: 60k one-hour and 20k five-minute writes.
  near(usageCost("claude-haiku-5-5", { cache_creation_input_tokens: 80_000, cache_creation: { ephemeral_1h_input_tokens: 60_000, ephemeral_5m_input_tokens: 20_000 } }),
    (60_000 * 0.2 + 20_000 * 0.125) / 1e6);
  // Long prompt: 200k one-hour writes at $1.
  near(usageCost("claude-haiku-5-5", { input_tokens: 10_000, output_tokens: 1000, cache_creation_input_tokens: 200_000, cache_creation: { ephemeral_1h_input_tokens: 200_000 } }),
    (10_000 * 0.5 + 1000 * 2.5 + 200_000 * 1) / 1e6);
  // A breakdown larger than the flat count never prices more writes than were made.
  near(usageCost("claude-haiku-5-5", { cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 5000 } }), (1000 * 0.2) / 1e6);
  // A model with no published one-hour rate keeps its single write rate.
  assert.equal(usageCost("claude-opus-5-5", { cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_1h_input_tokens: 1e6 } }), 5);
});

test("a saved delta spreads over the session's messages by cost, each share on its own local day", async () => {
  const t = tmp();
  // Local 27th 20:00 ($1 of tokens), then the 28th 09:00 ($3); the session saves $8 on the 28th.
  put(
    t.file,
    asst("2026-09-27T10:00:00.000Z", "m1", 50_000) +
      asst("2026-09-27T23:00:00.000Z", "m2", 150_000) +
      cost(1, { "claude-opus-5-5[1m]": 8 }),
  );
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  assert.deepEqual(state.buckets["2026-09-27"], { [PROJECT]: { "claude-opus-5-5": 2 } });
  const out = agg(state);
  assert.equal(out.today.measuredUSD, 6);
  assert.equal(out.today.estimatedUSD, 0);
  assert.equal(out.thisMonth.totalUSD, 8);
});

test("streamed lines of one message id count once, at their largest usage", async () => {
  const t = tmp();
  put(
    t.file,
    asst("2026-09-28T01:00:00.000Z", "m1", 50_000) +
      asst("2026-09-28T01:00:01.000Z", "m1", 150_000) +
      asst("2026-09-28T01:00:02.000Z", "m1", 100_000) +
      asst("2026-09-28T01:05:00.000Z", "m2", 50_000),
  );
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  assert.equal(agg(state).today.estimatedUSD, 4);
});

test("a message id split across two reads still counts once", async () => {
  const t = tmp();
  put(t.file, asst("2026-09-28T01:00:00.000Z", "m1", 50_000));
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  add(t.file, asst("2026-09-28T01:00:01.000Z", "m1", 100_000));
  await collect(state, { projectsDir: t.projects, now: NOW });
  assert.equal(agg(state).today.estimatedUSD, 2);
});

test("the estimate is replaced by the measured figure when the session saves, never counted twice", async () => {
  const t = tmp();
  put(t.file, asst("2026-09-28T01:00:00.000Z", "m1", 100_000) + asst("2026-09-28T01:10:00.000Z", "m2", 50_000));
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  let out = agg(state);
  assert.deepEqual([out.today.measuredUSD, out.today.estimatedUSD, out.today.totalUSD], [0, 3, 3]);
  assert.deepEqual(out.today.byChat, [{ repo: "example-repo", chat: "sample-chat", usd: 3, estimatedUSD: 3 }]);

  add(t.file, cost(1, { "claude-opus-5-5": 3.3 }) + asst("2026-09-28T02:00:00.000Z", "m3", 25_000));
  await collect(state, { projectsDir: t.projects, now: NOW });
  out = agg(state);
  assert.deepEqual([out.today.measuredUSD, out.today.estimatedUSD, out.today.totalUSD], [3.3, 0.5, 3.8]);

  add(t.file, cost(1, { "claude-opus-5-5": 3.8 }));
  await collect(state, { projectsDir: t.projects, now: NOW });
  out = agg(state);
  assert.deepEqual([out.today.measuredUSD, out.today.estimatedUSD, out.today.totalUSD], [3.8, 0, 3.8]);
  assert.deepEqual(Object.values(state.sessions).map((s) => s.msgs), [{}]);
});

test("a session with no cost-state at all is all estimate", async () => {
  const t = tmp();
  put(t.file, user("2026-09-28T01:00:00.000Z") + asst("2026-09-28T01:01:00.000Z", "m1", 75_000, "claude-sonnet-5"));
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  const out = agg(state);
  assert.deepEqual([out.today.measuredUSD, out.today.estimatedUSD], [0, 0.75]);
  assert.deepEqual(out.today.byModel, { "claude-sonnet-5": 0.75 });
  assert.equal(out.thisMonth.estimatedUSD, 0.75);
});

test("subagent transcripts join their parent's estimate and are replaced by the parent's saved delta", async () => {
  const t = tmp();
  const subDir = path.join(t.projects, PROJECT, "s1", "subagents");
  fs.mkdirSync(subDir, { recursive: true });
  put(path.join(subDir, "agent-a1.jsonl"), asst("2026-09-28T01:02:00.000Z", "sub1", 100_000));
  put(t.file, asst("2026-09-28T01:00:00.000Z", "m1", 50_000));
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  assert.equal(agg(state).today.estimatedUSD, 3);

  add(t.file, asst("2026-09-28T01:05:00.000Z", "m2", 50_000) + cost(1, { "claude-opus-5-5": 4.4 }));
  await collect(state, { projectsDir: t.projects, now: NOW });
  const out = agg(state);
  assert.deepEqual([out.today.measuredUSD, out.today.estimatedUSD], [4.4, 0]);
});

const ms = (/** @type {string} */ iso) => Date.parse(iso);
const subagentFile = (/** @type {ReturnType<typeof tmp>} */ t, name = "agent-a1.jsonl") => {
  const dir = path.join(t.projects, PROJECT, "s1", "subagents");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
};

test("an oversized line is skipped without being held in memory, and the offset moves past it", async () => {
  const t = tmp();
  const limits = { maxLineBytes: 1024, chunkBytes: 64 };
  const first = asst("2026-09-28T01:00:00.000Z", "m1", 50_000);
  const huge = user("2026-09-28T01:01:00.000Z").replace(SECRET, SECRET.repeat(400));
  put(t.file, first + huge.slice(0, 3000));
  const state = emptyState();
  let r = await collect(state, { projectsDir: t.projects, now: NOW, ...limits });
  const key = `${PROJECT}/s1.jsonl`;
  assert.equal(state.files[key].offset, Buffer.byteLength(first));
  assert.equal(r.skipped, 0);

  add(t.file, huge.slice(3000) + asst("2026-09-28T01:02:00.000Z", "m2", 50_000));
  r = await collect(state, { projectsDir: t.projects, now: NOW, ...limits });
  assert.equal(r.skipped, 1);
  assert.equal(state.files[key].offset, fs.statSync(t.file).size);
  // Every normal line here spans several 64-byte chunks and still parses.
  assert.equal(agg(state).today.estimatedUSD, 2);
});

test("a transcript replaced on a new inode with the same content counts nothing twice", async () => {
  const t = tmp();
  const sub = subagentFile(t);
  put(sub, asst("2026-09-28T02:05:00.000Z", "sub1", 150_000));
  put(t.file, asst("2026-09-28T01:00:00.000Z", "m1", 50_000) + cost(1, { "claude-opus-5-5": 1 }) + asst("2026-09-28T02:00:00.000Z", "m2", 100_000));
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  const totals = () => {
    const out = agg(state);
    return [out.today.measuredUSD, out.today.estimatedUSD, out.today.totalUSD];
  };
  assert.deepEqual(totals(), [1, 5, 6]);
  for (const file of [t.file, sub]) {
    const body = fs.readFileSync(file, "utf8");
    fs.rmSync(file);
    put(file, body);
  }
  await collect(state, { projectsDir: t.projects, now: NOW });
  assert.deepEqual(totals(), [1, 5, 6]);
});

test("a parent's cost-state covers subagent messages up to the time it was written, not the parent's last line", async () => {
  const t = tmp();
  const start = ms("2026-09-28T00:59:00.000Z");
  const written = ms("2026-09-28T01:15:00.000Z");
  put(subagentFile(t), asst("2026-09-28T01:10:00.000Z", "sub1", 100_000) + asst("2026-09-28T01:20:00.000Z", "sub2", 50_000));
  put(t.file, asst("2026-09-28T01:00:00.000Z", "m1", 50_000) + cost(start, { "claude-opus-5-5": 3 }, "s1", written - start));
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  const out = agg(state);
  // $1 parent + $2 subagent are the $3 saved; the 01:20 subagent message is after the save.
  assert.deepEqual([out.today.measuredUSD, out.today.estimatedUSD, out.today.totalUSD], [3, 1, 4]);
});

test("without totalDuration, a cost-state covers up to the file's mtime", async () => {
  const t = tmp();
  put(subagentFile(t), asst("2026-09-28T01:10:00.000Z", "sub1", 100_000));
  put(t.file, asst("2026-09-28T01:00:00.000Z", "m1", 50_000) + cost(1, { "claude-opus-5-5": 3 }), new Date("2026-09-28T01:15:00.000Z"));
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  const out = agg(state);
  assert.deepEqual([out.today.measuredUSD, out.today.estimatedUSD], [3, 0]);
});

test("a run that never saved keeps its estimate when a later run of the session saves", async () => {
  const t = tmp();
  const start = ms("2026-09-28T02:00:00.000Z");
  put(
    t.file,
    asst("2026-09-28T01:00:00.000Z", "m1", 50_000) +
      user("2026-09-28T02:00:30.000Z") +
      asst("2026-09-28T02:01:00.000Z", "m2", 100_000) +
      cost(start, { "claude-opus-5-5": 2.2 }, "s1", 120_000),
  );
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  const out = agg(state);
  assert.deepEqual([out.today.measuredUSD, out.today.estimatedUSD], [2.2, 1]);
});

test("measured model names drop the context-size and date suffixes, so each model appears once", async () => {
  const t = tmp();
  put(
    t.file,
    asst("2026-09-28T01:00:00.000Z", "m1", 50_000, "claude-opus-5-5[1m]") +
      cost(1, { "claude-opus-5-5[1m]": 2, "claude-haiku-4-5-20251001": 0.5 }) +
      asst("2026-09-28T02:00:00.000Z", "m2", 50_000, "claude-opus-5-5"),
  );
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  assert.deepEqual(agg(state).today.byModel, { "claude-opus-5-5": 3, "claude-haiku-4-5": 0.5 });
});

test("for two hours after a local day or month ends, its final totals are still sent", () => {
  const state = emptyState();
  state.labels[PROJECT] = { repo: "example-repo", chat: "sample-chat", seen: "2026-09-30" };
  state.buckets["2026-09-30"] = { [PROJECT]: { opus: 51 } };
  state.buckets["2026-10-01"] = { [PROJECT]: { opus: 2 } };
  // 00:30 on 1 October, local.
  let out = aggregate(state, { now: new Date("2026-09-30T14:30:00.000Z") });
  assert.equal(out.today.totalUSD, 2);
  assert.equal(out.previousDay?.day, "2026-09-30");
  assert.equal(out.previousDay?.spend.totalUSD, 51);
  assert.equal(out.previousMonth?.month, "2026-09");
  assert.equal(out.previousMonth?.spend.totalUSD, 51);
  // 02:30: the grace is over.
  out = aggregate(state, { now: new Date("2026-09-30T16:30:00.000Z") });
  assert.equal(out.previousDay, undefined);
  assert.equal(out.previousMonth, undefined);
  // An ordinary midnight carries only the day.
  state.buckets["2026-09-29"] = { [PROJECT]: { opus: 7 } };
  out = aggregate(state, { now: new Date("2026-09-29T14:10:00.000Z") });
  assert.equal(out.previousDay?.day, "2026-09-29");
  assert.equal(out.previousMonth, undefined);
});

test("the payload stays under the server's row, model and size limits", () => {
  const state = emptyState();
  const day = "2026-09-28";
  state.buckets[day] = {};
  const repo = "R".repeat(100);
  for (let i = 0; i < 1001; i++) {
    const chat = `chat-${String(i).padStart(4, "0")}-${"x".repeat(88)}`;
    const project = `-home-sam-code-${repo}-${chat}`;
    state.labels[project] = { repo, chat, seen: day };
    /** @type {Record<string, number>} */
    const models = {};
    for (let m = 0; m < 3; m++) models[`model-${(i + m) % 60}`] = i + 1;
    state.buckets[day][project] = models;
  }
  const out = aggregate(state, { now: NOW });
  const total = out.today.totalUSD;
  const close = (/** @type {number} */ a, /** @type {number} */ b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
  assert.equal(out.today.byChat.length, 150);
  assert.ok(Object.keys(out.today.byModel).length <= 20);
  close(out.today.byChat.reduce((sum, row) => sum + row.usd, 0), total);
  close(Object.values(out.today.byModel).reduce((sum, usd) => sum + usd, 0), total);
  // The folded rest stays under its own repo, with no chat.
  assert.equal(out.today.byChat.filter((row) => row.repo === repo && row.chat === undefined).length, 1);
  assert.equal(out.today.byChat.some((row) => row.repo === "other"), false);
  // The worst case: today, this month and both grace periods at once.
  const body = JSON.stringify({ ...out, previousDay: { day, spend: out.today }, previousMonth: { month: "2026-08", spend: out.today } });
  assert.ok(Buffer.byteLength(body) < 200 * 1024, `payload ${Buffer.byteLength(body)} bytes`);
});

test("past the row limit the biggest chats keep their rows and the rest fold under their own repo", () => {
  const state = emptyState();
  const day = "2026-09-28";
  state.buckets[day] = {};
  const ws = "-home-sam-code";
  for (let i = 0; i < 150; i++) {
    const project = `${ws}-other-repo-chat-${i}`;
    state.labels[project] = { repo: "other-repo", chat: `chat-${i}`, seen: day };
    state.buckets[day][project] = { opus: 10 };
  }
  state.labels[`${ws}-example-repo-fx`] = { repo: "example-repo", chat: "fx", seen: day };
  state.buckets[day][`${ws}-example-repo-fx`] = { opus: 5 };

  const rows = aggregate(state, { now: NOW }).today.byChat;
  assert.ok(rows.length <= 150);
  assert.deepEqual(rows.find((row) => row.repo === "example-repo"), { repo: "example-repo", usd: 5, estimatedUSD: 0 });
  assert.equal(rows.reduce((sum, row) => sum + row.usd, 0), 1505);
});

test("a repeated or stale cost-state covers only up to its own write time", async () => {
  const t = tmp();
  const start = ms("2026-09-28T00:59:00.000Z");
  const saved = cost(start, { "claude-opus-5-5": 1 }, "s1", ms("2026-09-28T01:05:00.000Z") - start);
  put(t.file, asst("2026-09-28T01:00:00.000Z", "m1", 50_000) + saved + asst("2026-09-28T01:10:00.000Z", "m2", 100_000) + saved);
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  const out = agg(state);
  assert.deepEqual([out.today.measuredUSD, out.today.estimatedUSD, out.today.totalUSD], [1, 2, 3]);
});

test("a transcript from the month that just ended is still read on the first scan of the grace window (DST)", async () => {
  const t = tmp();
  // 23:59 on 31 October, local (daylight time, UTC+11); the scan runs at 00:01 on 1 November.
  const written = new Date("2026-10-31T12:59:00.000Z");
  put(t.file, asst(written.toISOString(), "m1", 50_000), written);
  const now = new Date("2026-10-31T13:01:00.000Z");
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now });
  const out = aggregate(state, { now });
  assert.equal(out.day, "2026-11-01");
  assert.equal(out.today.totalUSD, 0);
  assert.deepEqual([out.previousDay?.day, out.previousDay?.spend.totalUSD], ["2026-10-31", 1]);
  assert.deepEqual([out.previousMonth?.month, out.previousMonth?.spend.totalUSD], ["2026-10", 1]);
});

test("a session in a deleted folder takes its repo and chat from the transcript's cwd, never the path", async () => {
  const t = tmp();
  const root = `${HOME}/code/other-repo/colour.mixer`;
  const project = encodeProjectPath(`${root}/web`);
  fs.mkdirSync(path.join(t.projects, project));
  const file = path.join(t.projects, project, "s2.jsonl");
  const cwdLine = (/** @type {string} */ cwd) => line({ type: "user", timestamp: "2026-09-28T00:59:00.000Z", cwd, message: { content: SECRET } });
  put(file, cwdLine(`${HOME}/elsewhere`) + cwdLine(`${root}/web`) + asst("2026-09-28T01:00:00.000Z", "m1", 50_000));
  const state = emptyState();
  await collect(state, { projectsDir: t.projects, now: NOW });
  const out = agg(state);
  assert.deepEqual(out.today.byChat, [{ repo: "other-repo", chat: "colour.mixer", usd: 1, estimatedUSD: 1 }]);
  assert.ok(!JSON.stringify(out).includes(HOME));
  // A cwd in an unknown repo, or that the session was not launched from, teaches nothing.
  const other = encodeProjectPath(`${HOME}/code/unknown/x`);
  fs.mkdirSync(path.join(t.projects, other));
  put(path.join(t.projects, other, "s3.jsonl"), cwdLine(`${HOME}/code/unknown/x`) + cwdLine(`${root}/web`) + asst("2026-09-28T01:00:00.000Z", "m2", 50_000));
  await collect(state, { projectsDir: t.projects, now: NOW });
  assert.equal(agg(state).today.byChat.find((row) => row.repo === "other")?.usd, 1);
});

test("runSpendLoop: a stop that lands during a push ends the loop at once, not after the interval", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spend-stop-"));
  const stop = new AbortController();
  const started = Date.now();
  await runSpendLoop({
    stop: stop.signal,
    intervalMs: 5_000,
    stateFile: path.join(dir, "state.json"),
    projectsDir: path.join(dir, "projects"),
    origin: "http://127.0.0.1:9",
    token: "t",
    log: () => {},
    fetch: async () => {
      stop.abort();
      throw new Error("stopped mid-push");
    },
  });
  assert.ok(Date.now() - started < 1_000, `loop waited ${Date.now() - started} ms after the stop`);
  fs.rmSync(dir, { recursive: true, force: true });
});
