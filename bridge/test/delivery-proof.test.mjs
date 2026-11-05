import assert from "node:assert/strict";
import { test } from "node:test";

import { createBridge } from "../lib/bridge.mjs";
import { holdDialogUp, promptEmpty } from "../lib/delivery-proof.mjs";

const DIALOG = ["Held message from another session", "❯ Deny — drop it and tell the sender it was declined", "  Deliver this message to Claude"];
const EMPTY = ["● done", "─────", "❯ ", "─────", "  bypass permissions on"];

test("the held-message dialog is up only when both its options sit at the bottom of the screen", () => {
  assert.equal(holdDialogUp(DIALOG), true);
  assert.equal(holdDialogUp([...DIALOG, ...Array(25).fill("later chat text")]), false);
  assert.equal(holdDialogUp([DIALOG[1]]), false);
  assert.equal(holdDialogUp(EMPTY), false);
});

test("the input box is empty only when its lowest prompt row holds nothing", () => {
  assert.equal(promptEmpty(EMPTY), true);
  assert.equal(promptEmpty(["❯ typed text"]), false);
  assert.equal(promptEmpty(DIALOG), false);
  assert.equal(promptEmpty(["❯ ", "─────", "❯ original line still in input", "─────"]), false);
  assert.equal(promptEmpty(["❯ ", "─────", "❯ [Pasted text #1 +3 lines]", "─────"]), false);
  assert.equal(promptEmpty(["❯ old", "─────", "❯ ", "─────"]), true);
});

/** @param {string[][]} screens one per read, the last repeated @param {number} [holdWaitMs] */
function bridgeOn(screens, holdWaitMs = 60_000) {
  /** @type {string[]} */
  const sent = [];
  /** @type {string[]} */
  const events = [];
  let clock = 0;
  const chatRunner = {
    list: async () => [],
    read: async () => (screens.length > 1 ? /** @type {string[]} */ (screens.shift()) : screens[0]),
    send: async (/** @type {string} */ _name, /** @type {string} */ line) => {
      sent.push(line);
      return { confirmed: true, stages: ["accepted", "submitted"] };
    },
    start: async () => {},
    interrupt: async () => {},
  };
  const bridge = createBridge(/** @type {any} */ ({
    origin: "https://rivet.example.com", token: "ab".repeat(32), ghBin: "gh", monitorChat: null, chatRunner,
    exec: async () => ({ stdout: "", stderr: "" }), fetch: async () => new Response("{}"), state: {},
    log: (/** @type {string} */ event) => events.push(event),
    now: () => new Date(clock), holdWaitMs, holdPollMs: 1,
  }));
  return { bridge, sent, events, tick: (/** @type {number} */ ms) => (clock += ms) };
}

test("a line waits for the dialog to go before it is typed", async () => {
  const { bridge, sent, events } = bridgeOn([DIALOG, DIALOG, EMPTY]);
  assert.deepEqual(await bridge.sendLine("site-fix", "hello"), { confirmed: true, stages: ["accepted", "submitted"] });
  assert.deepEqual(sent, ["hello"]);
  assert.deepEqual(events, ["hold-dialog-wait"]);
});

test("past the wait the line is typed anyway: text that only looks like the dialog never stops a line for good", async () => {
  const { bridge, sent, events } = bridgeOn([DIALOG], 0);
  await bridge.sendLine("site-fix", "hello");
  assert.deepEqual(sent, ["hello"]);
  assert.deepEqual(events, ["hold-dialog-wait", "hold-dialog-still-up"]);
});
