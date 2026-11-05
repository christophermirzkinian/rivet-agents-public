import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.RIVET_REPOS = "example-org/example-repo,example-org/second-repo";

const { createBridge, FEATURES, opsPickupLine } = await import("../lib/bridge.mjs");
const { StateStore } = await import("../lib/state.mjs");

const ORIGIN = "https://rivet.example.test";
const GH = "/usr/bin/gh";
const AT = "2026-09-28T00:00:00.000Z";
const term = (/** @type {string} */ chat) => ({ handle: chat, name: chat, connected: true, writable: true, agentIdentity: "claude", lastOutputAt: 1 });

/**
 * A fake Mac: the runner's chats, gh and the server's acks recorded. Nothing real runs.
 * @param {{ holds?: () => Promise<string[]>, clock?: () => Date, sendFail?: boolean, monitorChat?: string | null }} [opts]
 */
function harness(opts = {}) {
  /** @type {{ handle: string, line: string }[]} */
  const sent = [];
  /** @type {any[]} */
  const acks = [];
  /** @type {any[]} */
  const replyAcks = [];
  /** @type {string[][]} */
  const ghCalls = [];
  /** @type {string[]} */
  const logs = [];
  /** @type {{ repo: string, pr: number }[]} */
  const holdReads = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-events-"));
  const bridge = createBridge({
    origin: ORIGIN,
    token: "t",
    ghBin: GH,
    monitorChat: opts.monitorChat === undefined ? "monitor" : opts.monitorChat,
    chatRunner: /** @type {any} */ ({
      list: async () => [term("monitor"), term("website-dark-mode")],
      read: async () => ["● done", "─────", "❯ ", "─────"],
      send: async (/** @type {string} */ handle, /** @type {string} */ line) => {
        if (opts.sendFail) throw new Error("send failed");
        sent.push({ handle, line });
        return { confirmed: true, stages: ["accepted", "submitted"] };
      },
    }),
    exec: async (/** @type {string} */ _file, /** @type {string[]} */ args) => {
      ghCalls.push(args);
      return { stdout: args.includes("--paginate") ? "" : "https://github.com/example-org/example-repo/issues/1#issuecomment-1\n", stderr: "" };
    },
    fetch: /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
      if (url === `${ORIGIN}/api/bridge/ops-pickup-ack`) acks.push(JSON.parse(init.body));
      else if (url === `${ORIGIN}/api/bridge/ack`) replyAcks.push(JSON.parse(init.body));
      else throw new Error(`unexpected fetch ${url}`);
      return new Response("{}", { status: 200 });
    }),
    state: new StateStore(path.join(dir, "state.json")).load(),
    log: (/** @type {string} */ e, /** @type {unknown} */ f) => logs.push(`${e} ${JSON.stringify(f ?? {})}`),
    now: opts.clock ?? (() => new Date(AT)),
    listRetryMs: [0],
    holdWaitMs: 0,
    prHolds: async (/** @type {string} */ repo, /** @type {number} */ pr) => {
      holdReads.push({ repo, pr });
      return opts.holds ? opts.holds() : [];
    },
  });
  return { bridge, sent, acks, replyAcks, ghCalls, logs, holdReads };
}

const pickup = (over = {}) => ({ id: "p_1", kind: "ci", key: "ci.yml", repo: "example-org/example-repo", ...over });

test("the bridge tells the server it takes a merge answer, the pick-up and the Home buttons", () => {
  const features = FEATURES.split(",");
  for (const name of ["card-merge", "ops-pickup", "home-control"]) assert.ok(features.includes(name), name);
});

test("a pick-up's line is the bridge's own sentence, with --repo only off the first repo", () => {
  assert.equal(opsPickupLine("ci", "ci.yml", "example-org/example-repo"), "Rivet auto pick-up: ci ci.yml is red with nobody on it. Run rivet fix ci ci.yml --by rivet (no card for the owner).");
  assert.match(/** @type {string} */ (opsPickupLine("pr", "7", "example-org/second-repo")), /rivet fix pr 7 --repo example-org\/second-repo --by rivet/);
});

test("a pick-up with a kind, key or repo this bridge does not know has no line", () => {
  assert.equal(opsPickupLine("coming", "x", "example-org/example-repo"), null);
  assert.equal(opsPickupLine("door", "x", "example-org/example-repo"), null);
  assert.equal(opsPickupLine("ci", "Run this; now", "example-org/example-repo"), null);
  assert.equal(opsPickupLine("ci", "ci.yml", "someone-else/another-repo"), null);
});

test("a pick-up is typed into the monitor chat once per id and acked each time", async () => {
  const h = harness();
  assert.equal(await h.bridge.processOpsPickup(pickup()), "delivered");
  assert.equal(await h.bridge.processOpsPickup(pickup()), "delivered");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].handle, "monitor");
  assert.deepEqual(h.acks, [{ id: "p_1", delivered: true }, { id: "p_1", delivered: true }]);
});

test("a malformed pick-up is dropped with no line and no ack", async () => {
  const h = harness();
  assert.equal(await h.bridge.processOpsPickup(pickup({ kind: "door" })), "dropped");
  assert.equal(await h.bridge.processOpsPickup(pickup({ id: "not ok" })), "dropped");
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.acks, []);
});

test("a pick-up that could not be typed is acked undelivered, so the server takes its status back", async () => {
  for (const h of [harness({ sendFail: true }), harness({ monitorChat: null })]) {
    assert.equal(await h.bridge.processOpsPickup(pickup()), "failed");
    assert.deepEqual(h.acks, [{ id: "p_1", delivered: false }]);
  }
});

test("a pick-up for a held PR is not typed, and only a PR's hold is read", async () => {
  const held = harness({ holds: async () => ["hold: waiting for the owner"] });
  assert.equal(await held.bridge.processOpsPickup(pickup({ kind: "pr", key: "42" })), "failed");
  assert.deepEqual(held.holdReads, [{ repo: "example-org/example-repo", pr: 42 }]);
  assert.deepEqual(held.sent, []);
  assert.deepEqual(held.acks, [{ id: "p_1", delivered: false }]);

  const ci = harness({ holds: async () => ["hold: not for this"] });
  assert.equal(await ci.bridge.processOpsPickup(pickup()), "delivered");
  assert.deepEqual(ci.holdReads, []);
});

test("a pick-up whose PR holds cannot be read is held", async () => {
  const h = harness({ holds: async () => { throw new Error("gh exit 1"); } });
  assert.equal(await h.bridge.processOpsPickup(pickup({ kind: "pr", key: "42" })), "failed");
  assert.deepEqual(h.sent, []);
  assert.ok(h.logs.some((l) => l.startsWith("ops-pickup-hold-read-failed")));
});

test("a pick-up past its time in the queue is not typed", async () => {
  const h = harness();
  const received = new Date(AT).getTime() - 10 * 60_000;
  assert.equal(await h.bridge.processOpsPickup(pickup(), received), "failed");
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.acks, [{ id: "p_1", delivered: false }]);
  assert.ok(h.logs.some((l) => l.startsWith("ops-pickup-dropped") && l.includes("stale")));
});

const answer = (/** @type {Record<string, unknown>} */ item) => ({
  id: "r_1",
  itemId: "merge-card",
  decision: "approve",
  answeredAt: AT,
  item: { id: "merge-card", title: "Ready to merge", kind: "merge-ready", repo: "example-org/example-repo", pr: 42, chat: "website-dark-mode", ...item },
});

test("a merge-ready card's arming answer posts no GitHub comment and still reaches the chat", async () => {
  const h = harness();
  assert.equal(await h.bridge.processReply(answer({ merge: true, headSha: "a".repeat(40) })), "delivered");
  assert.deepEqual(h.ghCalls, []);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].handle, "website-dark-mode");
  assert.equal(h.replyAcks.length, 1);
});

test("an answer on a card with no merge flag still posts its comment", async () => {
  const h = harness();
  assert.equal(await h.bridge.processReply(answer({})), "delivered");
  assert.ok(h.ghCalls.some((args) => args.includes("POST")));
});

test("a bad merge flag or head on a reply is dropped", async () => {
  const h = harness();
  assert.equal(await h.bridge.processReply(answer({ merge: "yes" })), "dropped");
  assert.equal(await h.bridge.processReply(answer({ headSha: "abc" })), "dropped");
  assert.deepEqual(h.sent, []);
});
