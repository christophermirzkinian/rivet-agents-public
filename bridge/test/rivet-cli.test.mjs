import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cardBody, parseArgs, run, stdinArgs } from "../../scripts/rivet.mjs";

const TOKEN = "cd".repeat(32);
const ENV = { RIVET_BRIDGE_DEV: "1", RIVET_BOARD_TOKEN: TOKEN, RIVET_URL: "http://localhost:5999", PATH: "" };
const NOW = new Date("2026-10-01T02:00:00.000Z");

/** @param {string} msg */
function usage(msg) {
  return (/** @type {any} */ err) => err.constructor.name === "UsageError" && err.message.includes(msg);
}

/** A board server in memory, enough of the real one's per-item routes to drive the CLI. */
function stubServer() {
  const state = {
    version: 0,
    /** @type {{ updatedAt: string, needs: any[] }} */
    board: { updatedAt: "", needs: [] },
    /** @type {Set<string>} */
    media: new Set(),
    /** @type {{ method: string, path: string, body?: any, ifMatch?: string, type?: string }[]} */
    calls: [],
    handled: /** @type {string[]} */ ([]),
    /** The conversation each card was filed in, by card id; the CLI's lookup after add is not counted in calls. */
    filed: /** @type {Record<string, { id: string, title: string, via: string }>} */ ({}),
    merges: /** @type {{ from: string, into: string }[]} */ ([]),
  };
  /** @param {number} status @param {unknown} doc */
  const reply = (status, doc) => new Response(JSON.stringify(doc), { status, headers: { "content-type": "application/json" } });
  /** @param {any} base @param {Record<string, unknown>} patch */
  const merge = (base, patch) => {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) if (v === null) delete out[k];
    else out[k] = v;
    return out;
  };
  /** @param {string | URL | Request} url @param {RequestInit} [init] */
  const fetchFn = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";
    const headers = /** @type {Record<string, string>} */ (init.headers ?? {});
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    if (u.pathname.startsWith("/api/card-conversations/")) {
      const card = decodeURIComponent(u.pathname.slice("/api/card-conversations/".length));
      return reply(200, { card, conversation: state.filed[card] ?? null });
    }
    const merging = /^\/api\/conversations\/([^/]+)\/merge$/.exec(u.pathname);
    if (merging && method === "POST") {
      if (merging[1] === body.into) return reply(409, { error: "a conversation cannot merge into itself" });
      state.merges.push({ from: merging[1], into: body.into });
      return reply(200, { moved: 3, conversation: { id: body.into, title: "Page packages" } });
    }
    state.calls.push({ method, path: `${u.pathname}${u.search}`, body, ifMatch: headers["if-match"], type: headers["content-type"] });
    if (headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: "unauthorized" });
    if (u.pathname.startsWith("/api/bridge/media/")) {
      state.media.add(u.pathname.slice("/api/bridge/media/".length));
      return reply(201, {});
    }
    if (u.pathname === "/api/board") return reply(200, { version: state.version, updatedAt: state.board.updatedAt || null, board: state.board });
    if (u.pathname === "/api/replies") return reply(200, { replies: [{ id: "r_01", handled: false }] });
    const handled = /^\/api\/replies\/([^/]+)\/handled$/.exec(u.pathname);
    if (handled) {
      if (handled[1] !== "r_01") return reply(404, { error: "no such reply" });
      state.handled.push(handled[1]);
      return reply(200, { id: handled[1], handled: true });
    }
    const m = /^\/api\/board\/needs\/([^/]+)$/.exec(u.pathname);
    if (!m) return reply(404, { error: "not found" });
    if (headers["if-match"] !== undefined && Number(headers["if-match"]) !== state.version)
      return reply(409, { error: "board version is stale", version: state.version });
    const key = decodeURIComponent(m[1]);
    const rows = state.board.needs;
    let index = rows.findIndex((/** @type {any} */ row) => row.id === key);
    if (method === "DELETE") {
      if (index < 0) return reply(404, { error: "no such card" });
      rows.splice(index, 1);
    } else if (method === "PUT") {
      if (u.searchParams.get("create") === "only" && index >= 0) return reply(409, { error: `card ${key} already exists` });
      const need = { ...body, id: key };
      if (index < 0) index = rows.push(need) - 1;
      else rows[index] = need;
    } else if (method === "PATCH") {
      if (index < 0) return reply(404, { error: "no such card" });
      rows[index] = merge(rows[index], body);
    } else return reply(405, { error: "method not allowed" });
    state.version += 1;
    state.board.updatedAt = NOW.toISOString();
    return reply(200, { version: state.version, updatedAt: NOW.toISOString(), ...(method === "DELETE" ? {} : { item: rows[index] }) });
  };
  return { state, fetch: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchFn)) };
}

/**
 * Runs the CLI with captured output.
 * @param {string[]} argv
 * @param {Partial<import("../../scripts/rivet.mjs").Deps>} [deps]
 */
async function cli(argv, deps = {}) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    env: ENV,
    now: () => NOW,
    bin: (name) => `/fake/${name}`,
    exec: async () => {
      throw new Error("no exec in this test");
    },
    tmpdir: fs.mkdtempSync(path.join(os.tmpdir(), "rivet-cli-")),
    folderRepo: async () => undefined,
    ...deps,
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
  });
  return { code, stdout, stderr };
}

test("verify prints the selected option detail from the saved reply", async () => {
  const saved = { id: "r_01", decision: "choice", choice: "Proceed", item: { choiceDetail: "Deploy to staging only" } };
  const result = await cli(["verify", "r_01"], { fetch: async () => new Response(JSON.stringify(saved), { status: 200 }) });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).item.choiceDetail, "Deploy to staging only");
});

test("verify omits malformed legacy choice detail and retains the full bounded detail", async () => {
  for (const detail of [null, {}, 4, [], "", "  ", "x".repeat(1001), "x\n".repeat(489) + "Deploy to staging only"]) {
    const saved = { id: "r_01", decision: "choice", choice: "Proceed", item: { choiceDetail: detail } };
    const result = await cli(["verify", "r_01"], { fetch: async () => new Response(JSON.stringify(saved), { status: 200 }) });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).item.choiceDetail, typeof detail === "string" && detail.trim() && detail.length <= 1000 ? detail : undefined);
  }
});

test("parses every command", () => {
  assert.equal(parseArgs([]).cmd, "help");
  assert.equal(parseArgs(["--help"]).cmd, "help");
  assert.deepEqual(parseArgs(["board", "--out", "b.json"]).out, "b.json");
  const add = parseArgs(["card", "add", "pick-one", "--title", "Pick", "--pr", "202", "--option", "A", "--recommended", "--short", "a", "--option", "B", "--text-option", "--link", "PR=https://github.com/x/y/pull/1", "--primary", "--replace", "--if-match", "4"]);
  assert.equal(add.sub, "add");
  assert.deepEqual(add.args, ["pick-one"]);
  assert.deepEqual(add.fields, { title: "Pick", pr: 202 });
  assert.deepEqual(add.options, [{ label: "A", recommended: true, short: "a" }, { label: "B", text: true }]);
  assert.deepEqual(add.links, [{ label: "PR", url: "https://github.com/x/y/pull/1", primary: true }]);
  assert.equal(add.replace, true);
  assert.equal(add.ifMatch, "4");
  const edit = parseArgs(["card", "edit", "pick-one", "--unset", "risk", "--unset", "media", "--json", "-", "--json-out"]);
  assert.deepEqual(edit.unset, ["risk", "media"]);
  assert.equal(edit.json, "-");
  assert.equal(edit.jsonOut, true);
  assert.deepEqual(parseArgs(["card", "drop", "a", "b", "--json"]).args, ["a", "b"]);
  assert.equal(parseArgs(["card", "add", "x", "--pr", "7", "--repo", "example-org/example-repo"]).fields.repo, "example-org/example-repo");
  assert.throws(() => parseArgs(["card", "add", "x", "--repo", "example-repo"]), /--repo is owner\/name/);
  assert.equal(parseArgs(["replies"]).cmd, "replies");
  assert.deepEqual(parseArgs(["handled", "r_01", "r_02"]).args, ["r_01", "r_02"]);
  assert.deepEqual(parseArgs(["verify", "r_01"]).args, ["r_01"]);
  assert.deepEqual(parseArgs(["media", "check", "a.mp4", "--viewport", "390x844"]).args, ["a.mp4"]);
  const ls = parseArgs(["chat", "ls", "--json"]);
  assert.deepEqual([ls.cmd, ls.sub, ls.jsonOut], ["chat", "ls", true]);
  const send = parseArgs(["chat", "send", "duel-trio", "--text", "hello"]);
  assert.deepEqual([send.sub, send.args, send.text], ["send", ["duel-trio"], "hello"]);
  assert.equal(parseArgs(["chat", "send", "duel-trio", "--text-file", "-"]).textFile, "-");
  const show = parseArgs(["conversation", "show", "m_1", "--json"]);
  assert.deepEqual([show.cmd, show.sub, show.args, show.jsonOut], ["thread", "show", ["m_1"], true]);
  assert.equal(parseArgs(["thread", "list", "--open"]).open, true);
  assert.equal(parseArgs(["conversation", "done", "m_1"]).sub, "done");
  const set = parseArgs(["thread", "set", "m_1", "--status", "none", "--tag", "Lobby", "--step", "PR #12", "--step", "Shipped it", "--kind", "shipped"]);
  assert.deepEqual([set.fields, set.threadSteps], [{ status: null, tag: "Lobby" }, [{ label: "PR #12", kind: "pr" }, { label: "Shipped it", kind: "shipped" }]]);
});

test("refuses bad usage", () => {
  const cases = /** @type {[string[], string][]} */ ([
    [["nope"], "unknown command"],
    [["card"], "card takes add, edit, drop"],
    [["card", "add"], "one card id"],
    [["card", "add", "a", "b"], "one card id"],
    [["card", "add", "bad id!"], "must match"],
    [["card", "add", "a", "--recommended"], "--option before it"],
    [["card", "add", "a", "--primary"], "--link before it"],
    [["card", "add", "a", "--link", "nourl"], "<label>=<https url>"],
    [["card", "add", "a", "--link", "x=http://x"], "<label>=<https url>"],
    [["card", "add", "a", "--pr", "0"], "positive whole number"],
    [["card", "add", "a", "--reply", "yes"], "--reply takes text"],
    [["card", "add", "a", "--unset", "risk"], "unknown option --unset"],
    [["card", "edit", "a", "--replace"], "unknown option --replace"],
    [["card", "edit", "a"], "needs something to change"],
    [["card", "edit", "a", "--unset", "id"], "cannot unset id"],
    [["card", "edit", "a", "--risk", "money", "--unset", "risk"], "both set and unset"],
    [["card", "add", "a", "--ask", "x", "--ask-file", "f"], "pick one of --ask and --ask-file"],
    [["card", "add", "a", "--still", "a.gif"], "stills are jpg or png"],
    [["card", "add", "a", "--poster", "p.jpg"], "--poster, --skip-corner-check, --viewport, --allow-webm and --skip-preflight go with"],
    [["card", "add", "a", "--skip-preflight"], "--skip-preflight go with"],
    [["card", "add", "a", "--still", "s.png", "--viewport", "390"], "--viewport is WxH"],
    [["card", "drop", "a", "--allow-webm"], "unknown option --allow-webm"],
    [["media", "check"], "one or more files, or --before and --after"],
    [["media", "look", "a.mp4"], "media takes check"],
    [["card", "add", "a", "--title"], "--title needs a value"],
    [["card", "drop"], "one or more card ids"],
    [["card", "drop", "a", "--title", "x"], "unknown option --title"],
    [["board", "extra"], "no arguments"],
    [["verify"], "one reply id"],
    [["coming", "set", "2480"], "unknown command coming"],
    [["relay", "ace", "hi"], "unknown command relay"],
    [["chat", "set", "duel"], "chat takes ls, send"],
    [["chat", "ls", "extra"], "no arguments"],
    [["chat", "send", "a b", "--text", "hi"], "chat name"],
    [["chat", "send", "duel"], "needs --text or --text-file"],
    [["chat", "send", "duel", "--text", "hi", "--text-file", "f"], "not both"],
    [["chat", "send", "duel", "--text", " "], "--text is 1 to"],
    [["chat", "send", "duel", "--text", "hi", "--json"], "unknown option --json"],
    [["ask", "archive"], "ask takes open, set, status, close, list"],
    [["conversation", "split", "m_1"], "conversation takes show, list, done, undone, merge"],
    [["thread", "set", "m_1", "--project", "x"], "unknown option --project"],
  ]);
  for (const [argv, msg] of cases) assert.throws(() => parseArgs(argv), usage(msg), argv.join(" "));
});

test("usage errors exit 2 and help exits 0", async () => {
  const bad = await cli(["card", "add"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /card add takes one card id/);
  const help = await cli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /rivet card add/);
  assert.equal((await cli([])).code, 2);
});

test("builds a card from flags over the JSON, with --unset as null", () => {
  const add = parseArgs(["card", "add", "cam", "--title", "From flags", "--option", "A", "--risk", "money"]);
  assert.deepEqual(cardBody(add, { title: "From JSON", ask: "Kept", options: [{ label: "old" }] }, NOW), {
    title: "From flags",
    ask: "Kept",
    options: [{ label: "A" }],
    risk: "money",
    kind: "decision",
    since: NOW.toISOString(),
  });
  assert.deepEqual(cardBody(parseArgs(["card", "add", "cam", "--kind", "question", "--since", "2026-09-01T00:00:00Z"]), {}, NOW), {
    kind: "question",
    since: "2026-09-01T00:00:00Z",
  });
  const edit = parseArgs(["card", "edit", "cam", "--title", "New", "--unset", "ask", "--unset", "risk"]);
  assert.deepEqual(cardBody(edit, { pr: 1 }, NOW), { pr: 1, title: "New", ask: null, risk: null });
});

test("--step builds a todo card's steps and --push sets its level", () => {
  const todo = parseArgs(["card", "add", "tax", "--kind", "todo", "--title", "Add the tax form", "--step", "Open it", "--step", "Paste it", "--push", "needs-you"]);
  assert.deepEqual(cardBody(todo, {}, NOW), {
    kind: "todo",
    title: "Add the tax form",
    push: "needs-you",
    steps: ["Open it", "Paste it"],
    since: NOW.toISOString(),
  });
  assert.equal(parseArgs(["card", "edit", "shipped", "--push", "fyi"]).fields.push, "fyi");
  assert.throws(() => parseArgs(["card", "add", "x", "--push", "loud"]), /--push is one of needs-you, fyi/);
  assert.throws(() => parseArgs(["card", "add", "x", "--step", " "]), /a step is 1 to 300 characters/);
  assert.throws(() => parseArgs(["card", "add", "x", ...Array.from({ length: 13 }, (_, n) => ["--step", `s${n}`]).flat()]), /at most 12 steps/);
  assert.throws(() => parseArgs(["card", "edit", "x", "--step", "a", "--unset", "steps"]), /steps is both set and unset/);
});

test("a card's --pr with no --repo is the working folder's repo's PR; outside any checkout it names no repo", async () => {
  const server = stubServer();
  let folder = /** @type {string | undefined} */ ("example-org/example-repo");
  let asked = 0;
  const folderRepo = async () => {
    asked += 1;
    return folder;
  };
  const added = await cli(["card", "add", "bb", "--title", "Build", "--pr", "27", "--option", "Merge"], { fetch: server.fetch, folderRepo });
  assert.equal(added.code, 0, added.stderr);
  assert.equal(server.state.board.needs[0].repo, "example-org/example-repo");

  // --repo is taken as given, and an edit that names no PR keeps the stored card's repo.
  const named = await cli(["card", "add", "ms", "--title", "Main", "--pr", "7", "--repo", "example-org/other-repo"], { fetch: server.fetch, folderRepo });
  assert.equal(named.code, 0, named.stderr);
  assert.equal(server.state.board.needs[1].repo, "example-org/other-repo");
  const before = asked;
  assert.equal((await cli(["card", "edit", "bb", "--title", "Build, ready"], { fetch: server.fetch, folderRepo })).code, 0);
  assert.equal(asked, before);
  assert.equal(server.state.board.needs[0].repo, "example-org/example-repo");

  // A PR an edit's --json names is resolved as --pr is.
  const json = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rivet-card-")), "card.json");
  fs.writeFileSync(json, JSON.stringify({ pr: 29 }));
  const viaJson = await cli(["card", "edit", "ms", "--json", json], { fetch: server.fetch, folderRepo });
  assert.equal(viaJson.code, 0, viaJson.stderr);
  assert.equal(server.state.board.needs[1].repo, "example-org/example-repo");

  // Outside any checkout an edit naming a PR clears the stored repo, and an added card names none.
  folder = undefined;
  const retarget = await cli(["card", "edit", "bb", "--pr", "28"], { fetch: server.fetch, folderRepo });
  assert.equal(retarget.code, 0, retarget.stderr);
  assert.equal(server.state.board.needs[0].repo, undefined);
  const loose = await cli(["card", "add", "none", "--title", "Main", "--pr", "8"], { fetch: server.fetch, folderRepo });
  assert.equal(loose.code, 0, loose.stderr);
  assert.equal(server.state.board.needs.find((/** @type {any} */ n) => n.id === "none").repo, undefined);

  // The folder's repo comes from its origin remote; a folder that is no checkout names none; an origin that is not a
  // GitHub URL is refused, nothing written.
  /** @param {(args: string[]) => { stdout: string }} answer */
  const git = (answer) => /** @type {import("../lib/config.mjs").Exec} */ (async (bin, args) => {
    assert.equal(bin, "/fake/git");
    assert.deepEqual(args.slice(2), ["remote", "get-url", "origin"]);
    return { ...answer(args), stderr: "" };
  });
  const viaGit = await cli(["card", "add", "g1", "--title", "G", "--pr", "4"], { fetch: server.fetch, folderRepo: undefined, exec: git(() => ({ stdout: "git@github.com:example-org/example-repo.git\n" })) });
  assert.equal(viaGit.code, 0, viaGit.stderr);
  assert.equal(server.state.board.needs.find((/** @type {any} */ n) => n.id === "g1").repo, "example-org/example-repo");
  const noCheckout = await cli(["card", "add", "g2", "--title", "G", "--pr", "4"], {
    fetch: server.fetch,
    folderRepo: undefined,
    exec: git(() => {
      throw Object.assign(new Error("git failed"), { stderrFirstLine: "fatal: not a git repository (or any of the parent directories): .git" });
    }),
  });
  assert.equal(noCheckout.code, 0, noCheckout.stderr);
  assert.equal(server.state.board.needs.find((/** @type {any} */ n) => n.id === "g2").repo, undefined);
  const count = server.state.board.needs.length;
  const elsewhere = await cli(["card", "add", "g3", "--title", "G", "--pr", "4"], { fetch: server.fetch, folderRepo: undefined, exec: git(() => ({ stdout: "https://example.com/x/y.git\n" })) });
  assert.equal(elsewhere.code, 2);
  assert.match(elsewhere.stderr, /origin is not a GitHub URL: give --repo/);
  assert.equal(server.state.board.needs.length, count);
});

test("card add, edit and drop against the board routes", async () => {
  const server = stubServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-card-"));
  const ask = path.join(dir, "ask.txt");
  fs.writeFileSync(ask, "Which camera?\n");
  const json = path.join(dir, "card.json");
  fs.writeFileSync(json, JSON.stringify({ title: "From JSON", links: [{ label: "Video", url: "https://example.com/v" }] }));

  const added = await cli(["card", "add", "pick-one", "--json", json, "--ask-file", ask, "--option", "Chase", "--recommended"], { fetch: server.fetch });
  assert.equal(added.code, 0, added.stderr);
  assert.equal(added.stdout, "added card pick-one, version 1\n");
  assert.equal(server.state.calls.at(-1)?.path, "/api/board/needs/pick-one?create=only");
  assert.deepEqual(server.state.board.needs[0], {
    title: "From JSON",
    links: [{ label: "Video", url: "https://example.com/v" }],
    ask: "Which camera?",
    options: [{ label: "Chase", recommended: true }],
    kind: "decision",
    since: NOW.toISOString(),
    id: "pick-one",
  });

  const again = await cli(["card", "add", "pick-one", "--title", "x"], { fetch: server.fetch });
  assert.equal(again.code, 1);
  assert.match(again.stderr, /http 409: card pick-one already exists \(add --replace to overwrite it\)/);
  const replaced = await cli(["card", "add", "pick-one", "--title", "Replaced", "--replace", "--json-out"], { fetch: server.fetch });
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.equal(JSON.parse(replaced.stdout).item.title, "Replaced");
  assert.equal(server.state.calls.at(-1)?.path, "/api/board/needs/pick-one");

  const png = path.join(dir, "shot.png");
  fs.writeFileSync(png, Buffer.from("89504e470d0a1a0a0000", "hex"));
  /** @type {import("../lib/config.mjs").Exec} */
  const probeExec = async (bin, args) => {
    if (bin === "/fake/ffprobe") return { stdout: JSON.stringify({ streams: [{ codec_name: "png", width: 780, height: 1688 }], format: { format_name: "png_pipe" } }), stderr: "" };
    fs.writeFileSync(/** @type {string} */ (args.at(-1)), Buffer.from(Array.from({ length: 64 * 64 * 4 }, (_, i) => (i % 4 === 3 ? 255 : (i * 37) % 256))));
    return { stdout: "", stderr: "" };
  };
  const edited = await cli(["card", "edit", "pick-one", "--unset", "since", "--still", png, "--if-match", "2"], { fetch: server.fetch, exec: probeExec });
  assert.equal(edited.code, 0, edited.stderr);
  assert.equal(edited.stdout, "edited card pick-one, version 3\n");
  const patch = server.state.calls.at(-1);
  assert.equal(patch?.method, "PATCH");
  assert.equal(patch?.ifMatch, "2");
  assert.deepEqual(Object.keys(patch?.body ?? {}), ["since", "media"]);
  assert.equal(patch?.body.since, null);
  assert.equal(patch?.body.media.kind, "stills");
  assert.ok(server.state.media.has(patch?.body.media.stills[0].sha256), "uploaded before the card names it");
  assert.equal(server.state.board.needs[0].since, undefined);

  const stale = await cli(["card", "edit", "pick-one", "--title", "x", "--if-match", "1"], { fetch: server.fetch });
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /http 409: board version is stale/);
  assert.equal((await cli(["card", "edit", "nope", "--title", "x"], { fetch: server.fetch })).code, 1);

  const dropped = await cli(["card", "drop", "pick-one", "gone"], { fetch: server.fetch });
  assert.equal(dropped.code, 1);
  assert.equal(dropped.stdout, "dropped card pick-one, version 4\n");
  assert.match(dropped.stderr, /card gone: http 404/);
  assert.deepEqual(server.state.board.needs, []);
});

test("board, replies and handled", async () => {
  const server = stubServer();
  for (const id of ["a", "b", "c", "d", "e"]) assert.equal((await cli(["card", "add", id, "--title", id.toUpperCase()], { fetch: server.fetch })).code, 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-board-"));
  const out = path.join(dir, "board.json");
  const board = await cli(["board", "--out", out], { fetch: server.fetch });
  assert.equal(board.stdout, `version 5 written to ${out}\n`);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).version, 5);
  assert.equal(JSON.parse((await cli(["board"], { fetch: server.fetch })).stdout).version, 5);

  assert.deepEqual(JSON.parse((await cli(["replies"], { fetch: server.fetch })).stdout), { replies: [{ id: "r_01", handled: false }] });
  const handled = await cli(["handled", "r_01", "r_02"], { fetch: server.fetch });
  assert.equal(handled.code, 1);
  assert.equal(handled.stdout, "handled r_01\n");
  assert.match(handled.stderr, /reply r_02: http 404/);
});

test("card drop with --if-match follows the version each drop returns", async () => {
  const server = stubServer();
  server.state.version = 5;
  server.state.board.needs.push({ id: "a", kind: "decision", title: "A" }, { id: "b", kind: "decision", title: "B" });
  const r = await cli(["card", "drop", "a", "b", "--if-match", "5"], { fetch: server.fetch });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "dropped card a, version 6\ndropped card b, version 7\n");
  assert.deepEqual(server.state.calls.map((call) => call.ifMatch), ["5", "6"]);

  server.state.board.needs.push({ id: "c", kind: "decision", title: "C" });
  server.state.version = 9;
  const stale = await cli(["card", "drop", "c", "--if-match", "7"], { fetch: server.fetch });
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /board version is stale/);
});

test("card add --reply-to files it in your ask's conversation and says where; conversation merge moves a stray", async () => {
  const server = stubServer();
  assert.deepEqual(parseArgs(["card", "add", "page-v2-486", "--title", "t", "--reply-to", "9410d117-aaaa"]).fields, { title: "t", replyTo: "9410d117-aaaa" });
  assert.throws(() => parseArgs(["card", "add", "x", "--title", "t", "--reply-to", "not an id"]), usage("--reply-to"));
  const merge = parseArgs(["conversation", "merge", "ceaa1361", "--into", "9410d117"]);
  assert.deepEqual([merge.sub, merge.args, merge.into], ["merge", ["ceaa1361"], "9410d117"]);
  assert.throws(() => parseArgs(["conversation", "merge", "ceaa1361"]), usage("--into"));

  server.state.filed["page-v2-486"] = { id: "9410d117", title: "Page packages", via: "reply-to" };
  const added = await cli(["card", "add", "page-v2-486", "--title", "Lobby v2", "--reply-to", "9410d117"], { fetch: server.fetch });
  assert.equal(added.code, 0, added.stderr);
  assert.equal(server.state.board.needs[0].replyTo, "9410d117");
  assert.equal(added.stderr, "rivet: card page-v2-486 is in conversation \"Page packages\" (9410d117, by reply-to)\n");
  // A decision nothing links: the CLI says your answer would start a new one; an update card nothing links says nothing.
  const loose = await cli(["card", "add", "kids-cooking", "--title", "Pick one"], { fetch: server.fetch });
  assert.match(loose.stderr, /card kids-cooking joins no conversation yet: your answer starts a new one\. Pass --reply-to/);
  const update = await cli(["card", "add", "upd-note", "--kind", "update", "--title", "Merged"], { fetch: server.fetch });
  assert.equal(update.code, 0, update.stderr);
  assert.equal(update.stderr, "");

  const merged = await cli(["conversation", "merge", "ceaa1361", "--into", "9410d117"], { fetch: server.fetch });
  assert.equal(merged.code, 0, merged.stderr);
  assert.equal(merged.stdout, "merged ceaa1361 into 9410d117: 3 message(s) moved · Page packages\n");
  assert.deepEqual(server.state.merges, [{ from: "ceaa1361", into: "9410d117" }]);
  const self = await cli(["conversation", "merge", "9410d117", "--into", "9410d117"], { fetch: server.fetch });
  assert.equal(self.code, 1);
  assert.match(self.stderr, /cannot merge into itself/);
});

test("card add --kind update takes a thread and a tag, and nothing that asks", async () => {
  const server = stubServer();
  const added = await cli(["card", "add", "rp-deployed", "--kind", "update", "--thread", "report-page", "--tag", "Deployed", "--title", "Second stage deployed", "--ask", "Marker found.", "--pr", "4021"], { fetch: server.fetch });
  assert.equal(added.code, 0, added.stderr);
  assert.deepEqual(server.state.board.needs[0], {
    kind: "update",
    thread: "report-page",
    tag: "Deployed",
    title: "Second stage deployed",
    ask: "Marker found.",
    pr: 4021,
    since: NOW.toISOString(),
    id: "rp-deployed",
  });
  for (const [flags, word] of /** @type {const} */ ([[["--option", "Yes"], "--option"], [["--reply", "text"], "--reply"], [["--risk", "money"], "--risk"], [["--step", "Do it"], "--step"]])) {
    const refused = await cli(["card", "add", "u2", "--kind", "update", "--title", "x", ...flags], { fetch: server.fetch });
    assert.equal(refused.code, 2, word);
    assert.match(refused.stderr, new RegExp(`an update card takes no ${word}`));
  }
  assert.equal(server.state.board.needs.length, 1);
});

test("a merged, shipped, info or briefing card is refused: finished work takes no card, and it names the decision and Got it cards", async () => {
  const server = stubServer();
  for (const kind of ["merged", "shipped", "info", "briefing"]) {
    const refused = await cli(["card", "add", "fyi", "--kind", kind, "--title", "Merged #402"], { fetch: server.fetch });
    assert.equal(refused.code, 2, kind);
    assert.match(refused.stderr, /finished work takes no card, close its ask with rivet ask close <id> done\|shipped; what you must confirm is --kind decision with an --option for each choice; progress and status are --kind decision --option "Got it"/);
  }
  const tagged = await cli(["card", "add", "q", "--title", "Ship it?", "--tag", "Merged"], { fetch: server.fetch });
  assert.equal(tagged.code, 2);
  assert.match(tagged.stderr, /--tag goes with --kind update/);
  assert.equal(server.state.board.needs.length, 0);
});

test("card add|edit <id> --args - reads the card's flags from stdin as a JSON array; anything else is refused", () => {
  const words = ["--title", "T", "--option", "Yes", "--recommended"];
  assert.deepEqual(stdinArgs(["card", "add", "x", "--args", "-", "--replace"], () => JSON.stringify(words)), ["card", "add", "x", ...words, "--replace"]);
  assert.deepEqual(stdinArgs(["card", "add", "x", "--title", "T"], () => assert.fail("no stdin read")), ["card", "add", "x", "--title", "T"]);
  const refused = (/** @type {string[]} */ argv, stdin = "[]") => assert.throws(() => stdinArgs(argv, () => stdin), /--args/);
  refused(["card", "drop", "x", "--args", "-"]);
  refused(["board", "--args", "-"]);
  refused(["card", "add", "--args", "-"]);
  refused(["card", "add", "x", "--args", "file.json"]);
  refused(["card", "add", "x", "--args", "-", "--args", "-"]);
  refused(["card", "add", "x", "--args", "-"], '{"title":"T"}');
  refused(["card", "add", "x", "--args", "-"], '["--title", 1]');
  refused(["card", "add", "x", "--args", "-"], '["--args", "-"]');
});

test("card note posts Rivet's answer for the server to put under the card", async () => {
  /** @type {{ method: string, path: string, body: any }[]} */
  const calls = [];
  const fetchFn = async (/** @type {string} */ url, /** @type {RequestInit} */ init = {}) => {
    calls.push({ method: init.method ?? "GET", path: new URL(url).pathname, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ version: 4, updatedAt: NOW.toISOString(), item: { id: "u1" } }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const noted = await cli(["card", "note", "u1", "--text", "the lockfile is fixed"], { fetch: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchFn)) });
  assert.equal(noted.code, 0, noted.stderr);
  assert.equal(noted.stdout, "noted card u1, version 4\n");
  assert.deepEqual(calls, [{ method: "POST", path: "/api/board/needs/u1/comments", body: { text: "the lockfile is fixed" } }]);
  assert.throws(() => parseArgs(["card", "note", "u1"]), usage("card note needs --text"));
  assert.throws(() => parseArgs(["card", "note", "u1", "--text", " "]), usage("--text is 1 to 1000"));
});

test("card flags carry the card's proof, checked like the other card flags", async () => {
  const add = parseArgs(["card", "add", "p", "--title", "Ship?", "--ci", "red", "--ci-note", "2 failing", "--review", "findings", "--review-note", "1 open", "--why", "It changes the lobby", "--holding", "Video wait", "--holding", "Owner hold"]);
  assert.deepEqual(cardBody(add, {}, NOW).evidence, { ci: "red", ciNote: "2 failing", review: "findings", reviewNote: "1 open", why: "It changes the lobby", holding: ["Video wait", "Owner hold"] });
  assert.throws(() => parseArgs(["card", "add", "p", "--title", "x", "--ci", "yellow"]), usage("--ci is one of green, red, running"));
  assert.throws(() => parseArgs(["card", "add", "p", "--title", "x", "--review", "ok"]), usage("--review is one of clean, findings, running"));
  assert.throws(() => parseArgs(["card", "add", "p", "--title", "x", "--why", " "]), usage("--why is 1 to 300 characters"));
  assert.throws(() => parseArgs(["card", "add", "p", "--title", "x", "--ci-note", "n".repeat(121)]), usage("--ci-note is 1 to 120 characters"));
  assert.throws(() => parseArgs(["card", "add", "p", "--title", "x", ...Array.from({ length: 6 }, (_, n) => ["--holding", `h${n}`]).flat()]), usage("at most 5 --holding"));
  assert.throws(() => parseArgs(["card", "edit", "p", "--why", "x", "--unset", "evidence"]), usage("evidence is both set and unset"));
  assert.throws(() => parseArgs(["board", "--why", "x"]), usage("unknown option --why"));

  const server = stubServer();
  const update = await cli(["card", "add", "u", "--kind", "update", "--title", "Merged", "--why", "x"], { fetch: server.fetch });
  assert.equal(update.code, 2);
  assert.match(update.stderr, /an update card takes no --ci, --review, --why or --holding/);
  assert.equal(server.state.board.needs.length, 0);
});

test("replies --unacted reads the answers nobody has acted on", async () => {
  /** @type {string[]} */
  const paths = [];
  const fetchFn = async (/** @type {string} */ url) => {
    const u = new URL(url);
    paths.push(`${u.pathname}${u.search}`);
    return new Response(JSON.stringify({ replies: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const f = /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchFn));
  assert.equal((await cli(["replies", "--unacted"], { fetch: f })).code, 0);
  assert.equal((await cli(["replies"], { fetch: f })).code, 0);
  assert.deepEqual(paths, ["/api/replies?acted=false&limit=500", "/api/replies?handled=false"]);
  const capped = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => new Response(JSON.stringify({ replies: [{ id: "r" }], total: 3 }), { status: 200, headers: { "content-type": "application/json" } })));
  const shown = await cli(["replies", "--unacted"], { fetch: capped });
  assert.match(shown.stderr, /newest 1 of 3 answers/);
  assert.throws(() => parseArgs(["board", "--unacted"]), usage("unknown option --unacted"));
});

test("chat ls and chat send go through the chat runner", async () => {
  /** @type {unknown[][]} */
  const calls = [];
  const rows = [{ name: "duel-trio", session: "duel-trio", status: "running", state: "alive", provider: "claude", worktree: path.join(os.tmpdir(), "duel-trio") }];
  const runner = {
    context: (/** @type {any} */ opts) => {
      calls.push(["context", opts.env === ENV]);
      return { ctx: 1 };
    },
    ps: (/** @type {any} */ ctx) => {
      calls.push(["ps", ctx]);
      return rows;
    },
    send: (/** @type {any} */ ctx, /** @type {string} */ name, /** @type {string} */ text) => {
      calls.push(["send", ctx, name, text]);
      return { ...rows[0], session: name };
    },
  };
  const fetchFn = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => assert.fail("chat never calls the server")));
  const listed = await cli(["chat", "ls", "--json"], { runner, fetch: fetchFn });
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), rows);
  assert.deepEqual(calls, [["context", true], ["ps", { ctx: 1 }]]);
  const plain = await cli(["chat", "ls"], { runner, fetch: fetchFn });
  assert.equal(plain.stdout, `duel-trio  alive  claude  ${rows[0].worktree}\n`);

  calls.length = 0;
  const sent = await cli(["chat", "send", "duel-trio", "--text", "run the tests"], { runner, fetch: fetchFn });
  assert.equal(sent.code, 0, sent.stderr);
  assert.equal(sent.stdout, "sent to duel-trio\n");
  assert.deepEqual(calls, [["context", true], ["send", { ctx: 1 }, "duel-trio", "run the tests"]]);
  const fromStdin = await cli(["chat", "send", "duel-trio", "--text-file", "-"], { runner, fetch: fetchFn, readStdin: () => "two\nlines\n" });
  assert.equal(fromStdin.code, 0, fromStdin.stderr);
  assert.deepEqual(calls.at(-1), ["send", { ctx: 1 }, "duel-trio", "two\nlines"]);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rivet-chat-")), "msg.txt");
  fs.writeFileSync(file, "from a file\n");
  assert.equal((await cli(["chat", "send", "duel-trio", "--text-file", file], { runner, fetch: fetchFn })).code, 0);
  assert.deepEqual(calls.at(-1), ["send", { ctx: 1 }, "duel-trio", "from a file"]);
  const blank = await cli(["chat", "send", "duel-trio", "--text-file", "-"], { runner, fetch: fetchFn, readStdin: () => "\n" });
  assert.equal(blank.code, 2);
  const failing = await cli(["chat", "send", "gone", "--text", "hi"], {
    runner: { ...runner, send: () => { throw new Error("rivet-chat: no chat gone"); } },
    fetch: fetchFn,
  });
  assert.equal(failing.code, 1);
  assert.match(failing.stderr, /no chat gone/);
});
