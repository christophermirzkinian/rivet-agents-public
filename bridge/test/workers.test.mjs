import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridge, runWorkerFeed, UNAUTHORIZED_MS, WORKERS_INTERVAL_MS } from "../lib/bridge.mjs";
import { branchName, liveWorkersByRepo, MAX_WORKERS, opaqueWorkerId, titleBusy, workerSnapshot } from "../lib/workers.mjs";

process.env.RIVET_REPOS = "example-org/example-repo,example-org/other-repo";

const ORIGIN = "https://rivet.example.com";
const TOKEN = "ab".repeat(32);
const SECRET = "sk-live-terminal-output";

/** A runner chat as chat-source.mjs runnerTerminal makes it. @param {string} chat @param {object} [extra] */
const term = (chat, extra = {}) => ({
  handle: chat,
  name: chat,
  worktreePath: `/tmp/chats/${chat}`,
  branch: "refs/heads/some-branch",
  title: `✳ claude ${SECRET}`,
  connected: true,
  writable: true,
  agentIdentity: "claude",
  lastOutputAt: 1_790_000_000_000,
  ...extra,
});

test("snapshot carries metadata only: no output, title words or paths", () => {
  const { workers } = workerSnapshot([term("site-fix", { preview: `$ echo ${SECRET}`, repo: "example-org/other-repo", startedAt: 1_790_000_000_123 })]);
  assert.deepEqual(workers, [
    {
      worktreeId: opaqueWorkerId("site-fix"),
      repo: "example-org/other-repo",
      chat: "site-fix",
      connected: true,
      lastOutputAt: 1_790_000_000_000,
      agent: "claude",
      busy: false,
      branch: "some-branch",
      startedAt: 1_790_000_000_123,
    },
  ]);
  assert.ok(!JSON.stringify(workers).includes(SECRET));
  assert.ok(!JSON.stringify(workers).includes("/tmp/chats"));
});

test("a chat with no repo of its own counts under the default repo; with no repos set it is left out", () => {
  assert.equal(workerSnapshot([term("a")]).workers[0].repo, "example-org/example-repo");
  const saved = process.env.RIVET_REPOS;
  delete process.env.RIVET_REPOS;
  try {
    assert.deepEqual(workerSnapshot([term("a")]).workers, []);
  } finally {
    process.env.RIVET_REPOS = saved;
  }
});

test("drops non-agent and malformed chats, and a name redaction would change", () => {
  const token = "gh" + "p_" + "a".repeat(36);
  const { workers } = workerSnapshot([term("ok"), term("shell", { agentIdentity: undefined }), term("../x"), term(token)]);
  assert.deepEqual(workers.map((w) => w.chat), ["ok"]);
});

test("a pending chat is still on the board, its busy state unknown; a disconnected one reads no title", () => {
  const { workers } = workerSnapshot([term("p", { connected: false, writable: false, pending: true, title: "⠋ working" })]);
  assert.equal(workers[0].connected, true);
  assert.equal(workers[0].busy, null);
});

test("reads only the title's status glyph: spinner busy, ✳ idle, anything else unknown", () => {
  assert.equal(titleBusy("⠋ claude"), true);
  assert.equal(titleBusy("◐ claude"), true);
  assert.equal(titleBusy("✳ claude"), false);
  assert.equal(titleBusy("claude"), null);
  assert.equal(titleBusy(undefined), null);
});

test("a branch is sent only when plain", () => {
  assert.equal(branchName("refs/heads/feature/x"), "feature/x");
  assert.equal(branchName("refs/heads/../x"), null);
  assert.equal(branchName("abc123"), null);
});

test("worker ids are opaque hashes", () => {
  assert.match(opaqueWorkerId("site-fix"), /^[0-9a-f]{16}$/);
  assert.notEqual(opaqueWorkerId("a"), opaqueWorkerId("b"));
});

test("caps the snapshot, newest output first", () => {
  const many = Array.from({ length: MAX_WORKERS + 5 }, (_, i) => term(`c${i}`, { lastOutputAt: i }));
  const { workers } = workerSnapshot(many);
  assert.equal(workers.length, MAX_WORKERS);
  assert.equal(workers[0].chat, `c${MAX_WORKERS + 4}`);
});

test("--check counts live chats per repo in RIVET_REPOS, zeros included", () => {
  assert.equal(liveWorkersByRepo([term("a"), term("b", { connected: false })]), "example-org/example-repo 1, example-org/other-repo 0");
});

/** @param {{ statuses?: number[], terminals?: object[] }} [o] */
function feedHarness(o = {}) {
  /** @type {{ url: string, init: any }[]} */
  const puts = [];
  const statuses = [...(o.statuses ?? [200])];
  const chatRunner = {
    list: async () => o.terminals ?? [term("site-fix", { startedAt: 1_790_000_000_123 })],
    read: async () => [],
    send: async () => ({ confirmed: true, stages: [] }),
    start: async () => {},
    interrupt: async () => {},
  };
  const fetch = async (/** @type {string} */ url, /** @type {any} */ init) => {
    puts.push({ url, init });
    const status = statuses.length > 1 ? /** @type {number} */ (statuses.shift()) : statuses[0];
    return new Response(status === 400 ? JSON.stringify({ error: "bad" }) : "{}", { status });
  };
  const bridge = createBridge(/** @type {any} */ ({ origin: ORIGIN, token: TOKEN, ghBin: "gh", monitorChat: null, chatRunner, exec: async () => ({ stdout: "", stderr: "" }), fetch, state: {}, log: () => {}, listRetryMs: [] }));
  return { bridge, puts };
}

test("pushWorkers PUTs the snapshot with the bridge token", async () => {
  const { bridge, puts } = feedHarness();
  assert.equal(await bridge.pushWorkers(), 1);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].url, `${ORIGIN}/api/bridge/workers`);
  assert.equal(puts[0].init.method, "PUT");
  assert.equal(puts[0].init.redirect, "error");
  assert.equal(puts[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!puts[0].init.body.includes(SECRET));
  assert.equal(JSON.parse(puts[0].init.body).workers[0].chat, "site-fix");
});

test("pushWorkers sends again without start times when an older server refuses the snapshot", async () => {
  const { bridge, puts } = feedHarness({ statuses: [400, 200] });
  assert.equal(await bridge.pushWorkers(), 1);
  assert.equal(puts.length, 2);
  assert.equal(JSON.parse(puts[0].init.body).workers[0].startedAt, 1_790_000_000_123);
  assert.equal("startedAt" in JSON.parse(puts[1].init.body).workers[0], false);
  const refused = feedHarness({ statuses: [400], terminals: [term("a")] });
  await assert.rejects(refused.bridge.pushWorkers(), /workers http 400/);
  assert.equal(refused.puts.length, 1);
});

test("the feed repeats every interval, logs count changes and backs off on 401", async () => {
  for (const [status, wantDelay, wantEvent] of /** @type {const} */ ([
    [200, WORKERS_INTERVAL_MS, "workers"],
    [401, UNAUTHORIZED_MS, "workers-unauthorized"],
    [500, WORKERS_INTERVAL_MS, "workers-failed"],
  ])) {
    const { bridge } = feedHarness({ statuses: [status] });
    const stop = new AbortController();
    /** @type {number[]} */
    const delays = [];
    /** @type {string[]} */
    const events = [];
    await runWorkerFeed(bridge, {
      stop: stop.signal,
      log: (event) => events.push(event),
      sleep: async (ms) => {
        delays.push(ms);
        if (delays.length === 2) stop.abort();
      },
    });
    assert.deepEqual(delays, [wantDelay, wantDelay]);
    assert.deepEqual(events, status === 200 ? [wantEvent] : [wantEvent, wantEvent]);
  }
});
