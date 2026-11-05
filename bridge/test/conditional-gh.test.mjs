import assert from "node:assert/strict";
import test from "node:test";
import { conditionalGet, MAX_ETAGS, splitResponse } from "../lib/conditional-gh.mjs";

const ok = (/** @type {string} */ etag, /** @type {string} */ body) => `HTTP/2.0 200 OK\r\nEtag: ${etag}\r\nX-Ratelimit-Remaining: 4000\r\n\r\n${body}`;
const notModified = "HTTP/2.0 304 Not Modified\r\nEtag: \"a1\"\r\nX-Ratelimit-Remaining: 3990\r\n\r\n";
/** gh's own failure: exit 1, stdout kept. @param {string} stdout */
const exit1 = (stdout) => Object.assign(new Error("gh exit 1"), { stdout });

test("a GET sends the ETag of its last 200 and a 304 answers with the body kept", async () => {
  /** @type {string[][]} */
  const calls = [];
  const answers = [ok('"a1"', "[1]\n"), exit1(notModified), ok('W/"b2"', "[2]\n")];
  const get = conditionalGet(async (args) => {
    calls.push(args);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return /** @type {string} */ (next);
  }, new Map());
  assert.deepEqual(await get("repos/x/y/actions/variables", ".v"), { body: "[1]\n", head: "HTTP/2.0 200 OK\r\nEtag: \"a1\"\r\nX-Ratelimit-Remaining: 4000", cached: false });
  assert.deepEqual(calls[0], ["api", "-i", "repos/x/y/actions/variables", "--jq", ".v"]);
  const again = await get("repos/x/y/actions/variables", ".v");
  assert.deepEqual(calls[1], ["api", "-i", "-H", 'If-None-Match: "a1"', "repos/x/y/actions/variables", "--jq", ".v"]);
  assert.equal(again.body, "[1]\n");
  assert.ok(again.cached);
  assert.match(again.head, /X-Ratelimit-Remaining: 3990/, "a 304 still carries the rate limit");
  // The body changed: the new ETag replaces the old.
  assert.equal((await get("repos/x/y/actions/variables", ".v")).body, "[2]\n");
  assert.deepEqual(calls[2].slice(2, 4), ["-H", 'If-None-Match: "a1"']);
});

test("the same path with another jq is another answer, and other failures pass through", async () => {
  const store = new Map();
  const get = conditionalGet(async (args) => {
    if (args.includes("-H")) throw exit1("HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\n\r\n{}");
    return ok('"e"', args.at(-1) ?? "");
  }, store);
  await get("p", ".a");
  assert.equal((await get("p", ".b")).body, ".b", "no If-None-Match for a jq not asked before");
  await assert.rejects(get("p", ".a"), /gh exit 1/);
  // A 304 with nothing kept (a restart lost it) is not an answer.
  const lost = conditionalGet(async () => {
    throw exit1(notModified);
  }, new Map());
  await assert.rejects(lost("p"), /gh exit 1/);
});

test("only a 200 with a well-formed ETag is kept, and the store keeps the most recently used", async () => {
  const store = new Map();
  let etag = '"x\r\nInjected: 1"';
  const get = conditionalGet(async () => ok(etag, "b"), store);
  await get("p");
  assert.equal(store.size, 0, "a header that is not an ETag is never sent back");
  etag = '"ok"';
  for (let i = 0; i <= MAX_ETAGS; i += 1) await get(`p${i}`);
  assert.equal(store.size, MAX_ETAGS);
  assert.ok(!store.has("p0") && store.has(`p${MAX_ETAGS}`));
  // Output without a status line (a fake, or gh without -i) is passed on and not kept.
  const plain = conditionalGet(async () => "[]", new Map());
  assert.deepEqual(await plain("q"), { body: "[]", head: "", cached: false });
});

test("splitResponse reads the status, headers and body of gh api -i", () => {
  assert.deepEqual(splitResponse("HTTP/1.1 304 Not Modified\nEtag: \"a\"\n\n"), { status: 304, head: "HTTP/1.1 304 Not Modified\nEtag: \"a\"", body: "" });
  assert.equal(splitResponse("{}"), null);
});
