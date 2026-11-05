import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveChatTerminal } from "../lib/terminals.mjs";

/** @param {Record<string, unknown>} [over] */
const chat = (over = {}) => ({ handle: "site-fix", name: "site-fix", connected: true, writable: true, agentIdentity: "claude", ...over });

test("a chat is found by its name when it is live, writable and runs an agent", () => {
  assert.deepEqual(resolveChatTerminal([chat()], "site-fix"), { handle: "site-fix" });
  assert.deepEqual(resolveChatTerminal([chat({ connected: false })], "site-fix"), { handle: null, reason: "no-terminal" });
  assert.deepEqual(resolveChatTerminal([chat({ writable: false })], "site-fix"), { handle: null, reason: "no-terminal" });
  assert.deepEqual(resolveChatTerminal([chat({ agentIdentity: undefined })], "site-fix"), { handle: null, reason: "no-terminal" });
  assert.deepEqual(resolveChatTerminal([chat()], "other"), { handle: null, reason: "no-terminal" });
});

test("with a repo, a same-named chat in another repo never takes the line; a chat with no repo still does", () => {
  assert.deepEqual(resolveChatTerminal([chat({ repo: "example-org/other-repo" })], "site-fix", "example-org/example-repo"), { handle: null, reason: "no-terminal" });
  assert.deepEqual(resolveChatTerminal([chat({ repo: "example-org/Example-Repo" })], "site-fix", "example-org/example-repo"), { handle: "site-fix" });
  assert.deepEqual(resolveChatTerminal([chat()], "site-fix", "example-org/example-repo"), { handle: "site-fix" });
});

test("two live chats of one name are ambiguous", () => {
  assert.deepEqual(resolveChatTerminal([chat(), chat()], "site-fix"), { handle: null, reason: "ambiguous" });
});
