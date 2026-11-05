import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs, run } from "../../scripts/rivet.mjs";

const TOKEN = "cd".repeat(32);
const ENV = { RIVET_BRIDGE_DEV: "1", RIVET_BOARD_TOKEN: TOKEN, RIVET_URL: "http://localhost:5999", PATH: "" };
const NOW = "2026-10-06T02:00:00.000Z";

/** @param {Record<string, unknown>} over */
const held = (over = {}) => ({ id: "c-1", pattern: "pnpm-lock.yaml", chat: "report-run", pr: 410, note: "bumping vite", createdAt: NOW, expiresAt: "2026-10-06T04:00:00.000Z", ...over });

/** A claims server in memory: one held claim, refusing any other chat's claim on it. */
function stubServer() {
  const calls = /** @type {{ method: string, path: string, body?: any }[]} */ ([]);
  /** @param {number} status @param {unknown} doc */
  const reply = (status, doc) => new Response(JSON.stringify(doc), { status, headers: { "content-type": "application/json" } });
  /** @param {string | URL | Request} url @param {RequestInit} [init] */
  const fetchFn = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (/** @type {any} */ (init.headers).authorization !== `Bearer ${TOKEN}`) return reply(401, { error: "unauthorized" });
    if (path === "/api/claims" && method === "GET") return reply(200, { claims: [held()] });
    if (path === "/api/claims" && method === "POST") {
      if (body.pattern === "pnpm-lock.yaml" && body.chat !== "report-run" && !body.force) return reply(409, { error: "held by another chat", holders: [held()] });
      return reply(201, { claim: { id: "c-2", createdAt: NOW, expiresAt: "2026-10-06T03:30:00.000Z", ...body }, holders: [] });
    }
    if (path === "/api/claims/release") return body.id === "c-1" && body.chat === "report-run" ? reply(200, { released: held() }) : reply(404, { error: `${body.chat} holds no such claim` });
    return reply(404, { error: "not found" });
  };
  return { calls, fetch: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchFn)) };
}

/** @param {string[]} argv @param {typeof fetch} fetchFn */
async function cli(argv, fetchFn) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    env: ENV,
    fetch: fetchFn,
    now: () => new Date(NOW),
    exec: async () => {
      throw new Error("no exec in this test");
    },
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
  });
  return { code, stdout, stderr };
}

/** @param {string} msg */
const usage = (msg) => (/** @type {any} */ err) => err.constructor.name === "UsageError" && err.message.includes(msg);

test("parses claim add, release and list, and refuses bad usage", () => {
  const add = parseArgs(["claim", "add", "web/src/ui/**", "--chat", "claims-board", "--pr", "419", "--note", "menu tokens", "--ttl", "1h30m", "--force"]);
  assert.deepEqual([add.cmd, add.sub, add.args, add.fields], ["claim", "add", ["web/src/ui/**"], { chat: "claims-board", pr: 419, note: "menu tokens", ttlMinutes: 90, force: true }]);
  for (const [ttl, minutes] of [["2h", 120], ["45m", 45], ["45", 45], ["24h", 1440]]) assert.equal(parseArgs(["claim", "add", "a", "--chat", "c", "--ttl", String(ttl)]).fields.ttlMinutes, minutes);
  assert.deepEqual(parseArgs(["claim", "release", "c-3", "--chat", "c"]).args, ["c-3"]);
  assert.equal(parseArgs(["claim", "list", "--json"]).jsonOut, true);

  assert.throws(() => parseArgs(["claim", "add", "a"]), usage("needs --chat"));
  assert.throws(() => parseArgs(["claim", "add", "../a", "--chat", "c"]), usage("repo-relative"));
  assert.throws(() => parseArgs(["claim", "add", "/etc/hosts", "--chat", "c"]), usage("repo-relative"));
  assert.throws(() => parseArgs(["claim", "add", "a", "--chat", "c", "--ttl", "25h"]), usage("--ttl"));
  assert.throws(() => parseArgs(["claim", "add", "a", "--chat", "c", "--ttl", "0"]), usage("--ttl"));
  assert.throws(() => parseArgs(["claim", "add", "a", "--chat", "bad chat"]), usage("--chat"));
  assert.throws(() => parseArgs(["claim", "release", "c-1", "--chat", "c", "--note", "x"]), usage("unknown option --note"));
  assert.throws(() => parseArgs(["claim", "list", "x"]), usage("no arguments"));
  assert.throws(() => parseArgs(["claim", "take", "a"]), usage("claim takes add, release, list"));
});

test("claim add names the holder and exits 1 while another chat holds the path", async () => {
  const server = stubServer();
  const refused = await cli(["claim", "add", "pnpm-lock.yaml", "--chat", "claims-board"], server.fetch);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /pnpm-lock\.yaml is held/);
  assert.match(refused.stderr, /c-1 pnpm-lock\.yaml {2}report-run #410 {2}until 3:00pm {2}bumping vite/);

  const claimed = await cli(["claim", "add", "settings.json", "--chat", "claims-board", "--ttl", "90m"], server.fetch);
  assert.equal(claimed.code, 0, claimed.stderr);
  assert.match(claimed.stdout, /^claimed c-2 settings\.json {2}claims-board {2}until 2:30pm/);
  assert.deepEqual(server.calls.at(-1)?.body, { pattern: "settings.json", chat: "claims-board", ttlMinutes: 90 });
});

test("claim release and list", async () => {
  const server = stubServer();
  const released = await cli(["claim", "release", "c-1", "--chat", "report-run"], server.fetch);
  assert.equal(released.code, 0, released.stderr);
  assert.match(released.stdout, /^released c-1 pnpm-lock\.yaml/);
  const byPath = await cli(["claim", "release", "pnpm-lock.yaml", "--chat", "other"], server.fetch);
  assert.equal(byPath.code, 1);
  assert.deepEqual(server.calls.at(-1)?.body, { chat: "other", pattern: "pnpm-lock.yaml" });

  const list = await cli(["claim", "list"], server.fetch);
  assert.equal(list.stdout, "c-1 pnpm-lock.yaml  report-run #410  until 3:00pm  bumping vite\n");
  const json = await cli(["claim", "list", "--json"], server.fetch);
  assert.equal(JSON.parse(json.stdout).claims[0].chat, "report-run");
});
