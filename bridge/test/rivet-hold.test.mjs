import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readHolds } from "../lib/holds-file.mjs";
import { HOLD_OPENING, parseArgs, run } from "../../scripts/rivet.mjs";

const TOKEN = "ab".repeat(32);
const ENV = { RIVET_BRIDGE_DEV: "1", RIVET_BOARD_TOKEN: TOKEN, RIVET_URL: "http://localhost:5999", RIVET_REPOS: "example-org/example-repo", PATH: "" };
const NOW = "2026-10-01T02:00:00.000Z";
const URL_OF = "https://github.com/example-org/example-repo/pull/42";

/**
 * gh and the holds routes in memory, every gh call recorded.
 * @param {{ pr?: Record<string, unknown>, comments?: any[], reviews?: any[], me?: string, ghFail?: string }} [opts]
 */
function fakeMac(opts = {}) {
  const gh = /** @type {{ args: string[], input?: string }[]} */ ([]);
  const server = /** @type {{ method: string, path: string, body?: any }[]} */ ([]);
  const comments = [...(opts.comments ?? [])];
  const exec = async (/** @type {string} */ _file, /** @type {string[]} */ args, /** @type {any} */ o = {}) => {
    gh.push({ args, input: o.input });
    if (opts.ghFail && args.includes(opts.ghFail)) throw Object.assign(new Error("gh exit 1"), { stderrFirstLine: "HTTP 502", stdout: "" });
    const out = (/** @type {unknown} */ doc) => ({ stdout: `${JSON.stringify(doc)}\n`, stderr: "" });
    if (args[0] === "pr" && args[1] === "view") return out({ state: "OPEN", isDraft: false, body: "", labels: [], url: URL_OF, ...opts.pr });
    if (args[0] === "pr" && args[1] === "ready") return { stdout: "", stderr: "" };
    if (args[0] === "api" && args[1] === "user") return out({ login: opts.me ?? "sam" });
    if (args.includes("POST")) return out({ url: `${URL_OF}#issuecomment-9` });
    if (args.includes("PATCH")) return out({ id: 1 });
    const route = String(args[2]);
    const rows = route.endsWith("/reviews") ? (opts.reviews ?? []) : route.includes("/issues/") ? comments : [];
    return { stdout: rows.map((row) => JSON.stringify(row)).join("\n"), stderr: "" };
  };
  const fetchFn = async (/** @type {string | URL} */ url, /** @type {RequestInit} */ init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";
    server.push({ method, path: u.pathname, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(method === "PUT" ? { added: true } : { removed: 1 }), { status: 200 });
  };
  return { gh, server, exec, fetch: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchFn)) };
}

/** @param {string[]} argv @param {ReturnType<typeof fakeMac>} mac @param {{ file?: string, env?: NodeJS.ProcessEnv }} [over] */
async function cli(argv, mac, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-hold-"));
  const holdsFile = over.file ?? path.join(dir, "holds.json");
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    env: over.env ?? ENV,
    now: () => new Date(NOW),
    exec: mac.exec,
    fetch: mac.fetch,
    bin: () => "gh",
    holdsFile,
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
  });
  return { code, stdout, stderr, holdsFile };
}

const posted = (/** @type {ReturnType<typeof fakeMac>} */ mac) => mac.gh.filter((c) => c.args.includes("POST"));

test("hold and unhold parse a PR and its reason", () => {
  const o = parseArgs(["hold", "42", "--reason", "not until Friday", "--repo", "example-org/second-repo"]);
  assert.deepEqual([o.cmd, o.args, o.fields.reason, o.repo], ["hold", ["42"], "not until Friday", "example-org/second-repo"]);
  assert.throws(() => parseArgs(["hold", "42"]), /hold needs --reason/);
});

test("hold writes the file and the board, makes a draft and posts the hold line", async () => {
  const mac = fakeMac();
  const r = await cli(["hold", "42", "--reason", "not until Friday"], mac);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readHolds(r.holdsFile).holds, [{ pr: 42, reason: "not until Friday" }]);
  assert.deepEqual(mac.server.map((c) => [c.method, c.path, c.body]), [["PUT", "/api/ops/holds/42", { reason: "not until Friday" }]]);
  assert.ok(mac.gh.some((c) => c.args.join(" ") === "pr ready 42 --repo example-org/example-repo --undo"));
  const body = JSON.parse(/** @type {string} */ (posted(mac)[0].input)).body;
  assert.ok(body.startsWith(HOLD_OPENING));
  assert.match(body, /> not until Friday/);
  assert.match(body, /rivet unhold 42/);
});

test("hold repeated on a held draft adds nothing", async () => {
  const body = `${HOLD_OPENING} the owner's OK is relayed.`;
  const mac = fakeMac({ pr: { isDraft: true }, comments: [{ id: 1, login: "sam", url: `${URL_OF}#issuecomment-1`, body }] });
  const first = await cli(["hold", "42", "--reason", "wait"], mac);
  assert.equal(first.code, 0, first.stderr);
  const again = await cli(["hold", "42", "--reason", "wait"], mac, { file: first.holdsFile });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(readHolds(first.holdsFile).holds.length, 1);
  assert.deepEqual(posted(mac), []);
  assert.ok(!mac.gh.some((c) => c.args.includes("ready")));
});

test("hold on a closed PR writes the hold and makes no draft", async () => {
  const mac = fakeMac({ pr: { state: "MERGED" } });
  const r = await cli(["hold", "42", "--reason", "wait"], mac);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /#42 is merged, so not made a draft/);
  assert.ok(!mac.gh.some((c) => c.args.includes("ready")));
});

test("a step that fails is named, the others still run and the exit is not clean", async () => {
  const mac = fakeMac({ ghFail: "ready" });
  const r = await cli(["hold", "42", "--reason", "wait"], mac);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /draft: gh pr ready --undo failed/);
  assert.equal(readHolds(r.holdsFile).holds.length, 1);
  assert.equal(posted(mac).length, 1);
});

test("hold and unhold with no repo say so and touch nothing", async () => {
  for (const argv of [["hold", "42", "--reason", "wait"], ["unhold", "42"]]) {
    const mac = fakeMac();
    const r = await cli(argv, mac, { env: { ...ENV, RIVET_REPOS: "" } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no repo: pass --repo owner\/name or set RIVET_REPOS/);
    assert.deepEqual(mac.gh, []);
    assert.deepEqual(mac.server, []);
  }
});

test("unhold clears the file and the board, releases its own comment and leaves the draft", async () => {
  const body = `${HOLD_OPENING} the owner's OK is relayed.`;
  const mine = { id: 7, login: "sam", url: `${URL_OF}#issuecomment-7`, body };
  const theirs = { id: 8, login: "pat", url: `${URL_OF}#issuecomment-8`, body: "Looks fine." };
  const mac = fakeMac({ comments: [mine, theirs] });
  const held = await cli(["hold", "42", "--reason", "wait"], fakeMac());
  const r = await cli(["unhold", "42", "--reason", "go ahead"], mac, { file: held.holdsFile });
  assert.deepEqual(readHolds(held.holdsFile).holds, []);
  assert.deepEqual(mac.server.map((c) => [c.method, c.path]), [["DELETE", "/api/ops/holds/42"]]);
  const patched = mac.gh.filter((c) => c.args.includes("PATCH"));
  assert.deepEqual(patched.map((c) => c.args[3]), ["repos/example-org/example-repo/issues/comments/7"]);
  assert.equal(JSON.parse(/** @type {string} */ (patched[0].input)).body, "Released 2026-10-01: go ahead");
  assert.match(r.stdout, /left as it is; gh pr ready when it should merge/);
  assert.ok(!mac.gh.some((c) => c.args.includes("ready")));
});

test("unhold names every hold still in force", async () => {
  const mac = fakeMac({
    pr: { labels: [{ name: "do-not-merge" }] },
    comments: [{ id: 8, login: "pat", url: `${URL_OF}#issuecomment-8`, body: "hold: not yet, says Pat" }],
  });
  const r = await cli(["unhold", "42"], mac);
  assert.equal(r.code, 1, r.stdout);
  const shown = `${r.stdout}${r.stderr}`;
  assert.match(shown, /label do-not-merge/);
  assert.match(shown, /issuecomment-8: .*not yet, says Pat/);
});
