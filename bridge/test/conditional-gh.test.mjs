import assert from "node:assert/strict";
import test from "node:test";
import { conditionalGet, conditionalReads, MAX_ETAGS, splitResponse } from "../lib/conditional-gh.mjs";

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

test("with onePage an answer with a next page is never kept, and max bounds the store", async () => {
  const store = new Map();
  /** @type {string[][]} */
  const calls = [];
  let link = 'Link: <https://api.github.com/repositories/1/issues/7/comments?per_page=100&page=2>; rel="next", <https://api.github.com/x?page=3>; rel="last"\r\n';
  const get = conditionalGet(async (args) => (calls.push(args), `HTTP/2.0 200 OK\r\nEtag: W/"a"\r\n${link}\r\n[1]`), store, { onePage: true, max: 2 });
  assert.equal((await get("list")).body, "[1]");
  assert.equal((await get("list")).body, "[1]");
  assert.equal(store.size, 0);
  assert.ok(calls.every((args) => !args.includes("-H")), "nothing kept, so no ETag is sent");
  // The last page names a first and a prev, never a next: it is the whole answer when it is page 1.
  link = 'Link: <https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=1>; rel="first"\r\n';
  await get("list");
  assert.deepEqual([...store.keys()], ["list"]);
  // The list grew a next page: the answer kept goes.
  link = 'link: <https://api.github.com/x?page=2>; rel="next"\r\n';
  await get("list");
  assert.equal(store.size, 0);
  link = "";
  for (const path of ["a", "b", "c"]) await get(path);
  assert.deepEqual([...store.keys()], ["b", "c"]);
  // Without onePage a page is kept whatever follows it, as before.
  const every = new Map();
  await conditionalGet(async () => `HTTP/2.0 200 OK\r\nEtag: "a"\r\nLink: <https://api.github.com/x?page=2>; rel="next"\r\n\r\n[]`, every)("list");
  assert.equal(every.size, 1);
});

test("conditionalReads asks a reader's unpaged and page 1 reads with their ETags, and passes every other call on", async () => {
  /** @type {string[][]} */
  const calls = [];
  const store = new Map();
  let etag = 'W/"v1"';
  let body = "[1]";
  const gh = conditionalReads(async (args) => {
    calls.push(args);
    if (!args.includes("-i")) return "plain";
    if (args.includes(`If-None-Match: ${etag}`)) throw exit1("HTTP/2.0 304 Not Modified\r\n\r\n");
    return ok(etag, body);
  }, store);
  for (const path of ["repos/o/r/pulls/7", "repos/o/r/issues/7/comments?per_page=100&page=1", "repos/o/r/pulls?page=1&state=open"]) {
    calls.length = 0;
    assert.equal(await gh(["api", path]), "[1]");
    assert.equal(await gh(["api", path]), "[1]", "a 304 resolves the body kept");
    assert.deepEqual(calls, [["api", "-i", path], ["api", "-i", "-H", 'If-None-Match: W/"v1"', path]]);
  }
  // A changed answer replaces the one kept, and its ETag is the next one sent.
  [etag, body] = ['W/"v2"', "[2]"];
  calls.length = 0;
  assert.equal(await gh(["api", "repos/o/r/pulls/7"]), "[2]");
  assert.equal(await gh(["api", "repos/o/r/pulls/7"]), "[2]");
  assert.deepEqual(calls.map((args) => args[3] ?? null), ['If-None-Match: W/"v1"', 'If-None-Match: W/"v2"']);
  assert.equal(store.get("repos/o/r/pulls/7").body, "[2]");
  // A later page, a call with flags and a call that is no GET of a path go to gh as they came, and nothing is kept.
  const size = store.size;
  for (const args of [["api", "repos/o/r/issues/7/comments?per_page=100&page=2"], ["api", "repos/o/r/pulls/7/comments?page=12"], ["api", "repos/o/r/pulls/7", "--jq", ".body"], ["pr", "view"]]) {
    calls.length = 0;
    assert.equal(await gh(args), "plain");
    assert.deepEqual(calls, [args]);
  }
  assert.equal(store.size, size);
  // A failure that is no 304 is thrown as it came.
  await assert.rejects(conditionalReads(async () => { throw exit1("HTTP/2.0 502 Bad Gateway\r\n\r\n"); }, new Map())(["api", "p"]), /gh exit 1/);
});

test("splitResponse reads the status, headers and body of gh api -i", () => {
  assert.deepEqual(splitResponse("HTTP/1.1 304 Not Modified\nEtag: \"a\"\n\n"), { status: 304, head: "HTTP/1.1 304 Not Modified\nEtag: \"a\"", body: "" });
  assert.equal(splitResponse("{}"), null);
});
