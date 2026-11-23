import assert from "node:assert/strict";
import { test } from "node:test";

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DashError, dashRefusal, holdSayCard, MAX_SAY_IMAGES, parseArgs, postSay, readPdf, sayBody } from "../../scripts/say.mjs";
import { releaseForYes } from "../lib/card-holds.mjs";

const SAY = fileURLToPath(new URL("../../scripts/say.mjs", import.meta.url));
// A video card holds only the main repository's PRs: the first of RIVET_REPOS.
process.env.RIVET_REPOS = "example-org/example-repo,example-org/other-repo";

// Rivet's photos and video in his chat answer: say.mjs takes them by absolute path and sends their store shas.

test("say takes up to three absolute jpg or png photos and one absolute mp4, text optional", () => {
  assert.deepEqual(parseArgs(["--image", "/a/one.png", "--image", "/a/two.JPG", "--reply-to", "m1"]), {
    images: ["/a/one.png", "/a/two.JPG"],
    replyTo: "m1",
  });
  assert.deepEqual(parseArgs(["--text", "Photo test", "--video", "/a/clip.mp4"]), { images: [], text: "Photo test", video: "/a/clip.mp4" });
  assert.deepEqual(parseArgs(["--text", "hi"]), { images: [], text: "hi" });
  const four = ["1", "2", "3", "4"].flatMap((n) => ["--image", `/a/${n}.png`]);
  assert.equal(MAX_SAY_IMAGES, 3);
  assert.throws(() => parseArgs(four), /at most 3 images/);
});

test("say refuses a relative path, a URL, the wrong kind of file, a repeat and a second video", () => {
  assert.throws(() => parseArgs(["--image", "still.png"]), /absolute path of a jpg or png/);
  assert.throws(() => parseArgs(["--image", "https://example.com/still.png"]), /absolute path of a jpg or png/);
  assert.throws(() => parseArgs(["--image", "/a/clip.mp4"]), /absolute path of a jpg or png/);
  assert.throws(() => parseArgs(["--video", "/a/clip.webm"]), /absolute path of an mp4/);
  assert.throws(() => parseArgs(["--video", "clip.mp4"]), /absolute path of an mp4/);
  assert.throws(() => parseArgs(["--image", "/a/s.png", "--image", "/a/s.png"]), /given twice/);
  assert.throws(() => parseArgs(["--video", "/a/a.mp4", "--video", "/a/b.mp4"]), /one --video at most/);
  assert.throws(() => parseArgs(["--image"]), /--image needs a value/);
  assert.throws(() => parseArgs(["--image", "/a/s.png", "--reply-to", "../x"]), /--reply-to must match/);
});

test("the say request names photos and video by sha, once each, and leaves out what is not there", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const v = "c".repeat(64);
  assert.deepEqual(
    sayBody("", "m1", [
      { role: "image", sha256: a },
      { role: "image", sha256: b },
      { role: "image", sha256: a },
      { role: "video", sha256: v },
    ]),
    { replyTo: "m1", images: [a, b], video: v },
  );
  assert.deepEqual(sayBody("hi", undefined, []), { text: "hi" });
});

test("say --new starts a conversation, --title names it; neither replies to anything", () => {
  assert.deepEqual(parseArgs(["--new", "--title", "Nightly report 3 Oct", "--text", "6 PRs merged"]), {
    images: [],
    new: true,
    title: "Nightly report 3 Oct",
    text: "6 PRs merged",
  });
  assert.throws(() => parseArgs(["--new", "--reply-to", "m1", "--text", "x"]), /replies to nothing/);
  assert.throws(() => parseArgs(["--title", "x", "--text", "x"]), /--new/);
  assert.throws(() => parseArgs(["--new", "--title", " ", "--text", "x"]), /--title is 1 to 120/);
  assert.deepEqual(sayBody("6 PRs merged", undefined, [], { new: true, title: " Nightly " }), { text: "6 PRs merged", new: true, title: "Nightly" });
  // Every existing caller sends exactly what it did.
  assert.deepEqual(sayBody("done", "m1", []), { text: "done", replyTo: "m1" });
});

test("say --card answers a message with an outcome card; --tag and --thread go on a card only", () => {
  assert.deepEqual(parseArgs(["--reply-to", "m1", "--card", "--tag", "Deployed", "--text", "the new build deployed"]), {
    images: [],
    replyTo: "m1",
    card: true,
    tag: "Deployed",
    text: "the new build deployed",
  });
  assert.deepEqual(parseArgs(["--thread", "the new build", "--tag", "Merged", "--text", "PR 4050 merged"]), { images: [], thread: "the new build", tag: "Merged", text: "PR 4050 merged" });
  assert.throws(() => parseArgs(["--card", "--text", "x"]), /--card answers a message/);
  assert.throws(() => parseArgs(["--reply-to", "m1", "--tag", "Deployed", "--text", "x"]), /go on an update card .*a reply to you takes neither/);
  assert.throws(() => parseArgs(["--new", "--thread", "the new build", "--text", "x"]), /go on an update card/);
  assert.throws(() => parseArgs(["--tag", " ", "--text", "x"]), /--tag is 1 to 40/);
  assert.throws(() => parseArgs(["--thread", "x".repeat(81), "--text", "x"]), /--thread is 1 to 80/);
  assert.throws(() => parseArgs(["--tag"]), /--tag needs a value/);
  assert.deepEqual(sayBody("the new build deployed", "m1", [], { card: true, tag: " Deployed " }), { text: "the new build deployed", replyTo: "m1", card: true, tag: "Deployed" });
  assert.deepEqual(sayBody("PR 4050 merged", undefined, [], { thread: "the new build" }), { text: "PR 4050 merged", thread: "the new build" });
});

test("say --card --pr names the PR an outcome card is about, --repo its repo; on an outcome card only", () => {
  assert.deepEqual(parseArgs(["--reply-to", "m1", "--card", "--text", "The new reels", "--pr", "6500"]), { images: [], replyTo: "m1", card: true, text: "The new reels", pr: 6500 });
  assert.deepEqual(parseArgs(["--reply-to", "m1", "--card", "--text", "x", "--pr", "7", "--repo", "example-org/other-repo"]), {
    images: [],
    replyTo: "m1",
    card: true,
    text: "x",
    pr: 7,
    repo: "example-org/other-repo",
  });
  assert.throws(() => parseArgs(["--reply-to", "m1", "--text", "x", "--pr", "6500"]), /--pr names the PR of an outcome card/);
  assert.throws(() => parseArgs(["--text", "x", "--pr", "6500"]), /--pr names the PR of an outcome card/);
  assert.throws(() => parseArgs(["--reply-to", "m1", "--card", "--text", "x", "--repo", "example-org/other-repo"]), /--repo names the PR's repo/);
  assert.throws(() => parseArgs(["--reply-to", "m1", "--card", "--text", "x", "--pr", "0"]), /--pr takes a PR number/);
  assert.throws(() => parseArgs(["--reply-to", "m1", "--card", "--text", "x", "--pr", "7", "--repo", "not-a-repo"]), /--repo takes owner\/name/);
  assert.deepEqual(sayBody("The new reels", "m1", [], { card: true, pr: 6500 }), { text: "The new reels", replyTo: "m1", card: true, pr: 6500 });
  assert.deepEqual(sayBody("x", "m1", [], { card: true, pr: 7, repo: "example-org/other-repo" }), { text: "x", replyTo: "m1", card: true, pr: 7, repo: "example-org/other-repo" });
});

test("say --card --ask names the ask an outcome card is about, so it stays under way; on an outcome card only", () => {
  assert.deepEqual(parseArgs(["--reply-to", "m1", "--card", "--text", "The new reels", "--ask", "a-1"]), { images: [], replyTo: "m1", card: true, text: "The new reels", ask: "a-1" });
  assert.deepEqual(sayBody("The new reels", "m1", [], { card: true, ask: "a-1" }), { text: "The new reels", replyTo: "m1", card: true, ask: "a-1" });
  assert.deepEqual(sayBody("hi", "m1", [], { ask: "a-1" }), { text: "hi", replyTo: "m1" });
  assert.throws(() => parseArgs(["--reply-to", "m1", "--text", "x", "--ask", "a-1"]), /--ask names the ask of an outcome card/);
  assert.throws(() => parseArgs(["--reply-to", "m1", "--card", "--text", "x", "--ask", "A 601"]), /--ask takes an ask id/);
  assert.throws(() => parseArgs(["--reply-to", "m1", "--card", "--text", "x", "--ask"]), /--ask takes an ask id/);
});

test("say --ack sets the status line on your message: a reply id and the words, nothing else", () => {
  assert.deepEqual(parseArgs(["--reply-to", "m1", "--ack", "building it, ~9:45"]), { images: [], replyTo: "m1", ack: "building it, ~9:45" });
  assert.deepEqual(sayBody("", "m1", [], { ack: " building it, ~9:45 " }), { replyTo: "m1", ack: "building it, ~9:45" });
  assert.throws(() => parseArgs(["--ack", "building it"]), /--reply-to/);
  // A bare --ack, last on the line, is an ack too: refused, it sent nothing and left his line with no status.
  assert.deepEqual(parseArgs(["--reply-to", "m1", "--ack"]), { images: [], replyTo: "m1", ack: "on it" });
  assert.throws(() => parseArgs(["--reply-to", "m1", "--text"]), /--text needs a value/);
  // Only last on the line: before another flag it still names the flag it swallowed, and sends nothing.
  assert.throws(() => parseArgs(["--ack", "--reply-to", "m1"]), /--ack got "--reply-to" as its value/);
  assert.throws(() => parseArgs(["--reply-to", "m1", "--ack", "x", "--text", "y"]), /nothing else/);
  assert.throws(() => parseArgs(["--reply-to", "m1", "--ack", "x", "--card"]), /nothing else/);
  assert.throws(() => parseArgs(["--reply-to", "m1", "--ack", " "]), /--ack is 1 to 120/);
});

test("say --file takes one absolute pdf on a chat line, never on a card or with an ack", () => {
  assert.deepEqual(parseArgs(["--reply-to", "m1", "--file", "/a/Quarterly report.PDF"]), { images: [], replyTo: "m1", file: "/a/Quarterly report.PDF" });
  assert.deepEqual(parseArgs(["--new", "--text", "Your quarterly report", "--file", "/a/p.pdf"]), { images: [], new: true, text: "Your quarterly report", file: "/a/p.pdf" });
  assert.throws(() => parseArgs(["--reply-to", "m1", "--file", "p.pdf"]), /absolute path of a pdf/);
  assert.throws(() => parseArgs(["--reply-to", "m1", "--file", "/a/p.png"]), /absolute path of a pdf/);
  assert.throws(() => parseArgs(["--reply-to", "m1", "--file", "/a/p.pdf.exe"]), /absolute path of a pdf/);
  assert.throws(() => parseArgs(["--reply-to", "m1", "--file", "/a/p.pdf", "--file", "/a/q.pdf"]), /one --file at most/);
  assert.throws(() => parseArgs(["--reply-to", "m1", "--file"]), /--file needs a value/);
  assert.throws(() => parseArgs(["--text", "update", "--file", "/a/p.pdf"]), /not a card/);
  assert.throws(() => parseArgs(["--reply-to", "m1", "--card", "--text", "x", "--file", "/a/p.pdf"]), /not a card/);
  assert.throws(() => parseArgs(["--reply-to", "m1", "--ack", "on it", "--file", "/a/p.pdf"]), /--ack is a status line/);
});

test("say --file reads only a real PDF of 25 MB at most, and sends it under its own name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "say-pdf-"));
  try {
    const good = path.join(dir, "Quarterly: report.pdf");
    fs.writeFileSync(good, "%PDF-1.7\nhello");
    const read = readPdf(good);
    assert.equal(read.type, "application/pdf");
    assert.match(read.sha256, /^[0-9a-f]{64}$/);
    const renamed = path.join(dir, "page.pdf");
    fs.writeFileSync(renamed, "<html><script>x</script>");
    assert.throws(() => readPdf(renamed), /not a PDF/);
    const empty = path.join(dir, "empty.pdf");
    fs.writeFileSync(empty, "");
    assert.throws(() => readPdf(empty), /empty or over 25 MB/);
    const big = path.join(dir, "big.pdf");
    fs.writeFileSync(big, "%PDF-");
    fs.truncateSync(big, 25 * 1024 * 1024 + 1);
    assert.throws(() => readPdf(big), /over the 25 MB limit/);
    assert.throws(() => readPdf(path.join(dir, "missing.pdf")), /file not found/);
    assert.throws(() => readPdf(dir + "/"), /not a file|file not found/);

    assert.deepEqual(sayBody("", "m1", [{ role: "file", sha256: read.sha256, file: good }]), {
      replyTo: "m1",
      files: [{ sha256: read.sha256, name: "Quarterly report.pdf" }],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// `say --reply-to <id> --text --stdin < file` sent the owner the word "--stdin", each "sent <id>" as normal.
test("say refuses a flag swallowed as the message: --text --stdin, --ack --stdin and the other text flags", () => {
  assert.throws(() => parseArgs(["--reply-to", "m1", "--text", "--stdin"]), (err) => {
    assert.ok(err instanceof DashError);
    assert.equal(err.message, '--text got "--stdin" as its message; for a file use --stdin alone. Nothing was sent');
    return true;
  });
  assert.throws(() => parseArgs(["--reply-to", "m1", "--ack", "--stdin"]), DashError);
  assert.throws(() => parseArgs(["--reply-to", "m1", "--ack", "--stdin"]), /--ack got "--stdin" as its value/);
  for (const flag of ["--title", "--tag", "--thread", "--reply-to"]) assert.throws(() => parseArgs([flag, "--new"]), DashError);
  assert.throws(() => parseArgs(["--reply-to", "m1", "--text", "--help"]), DashError);
  assert.throws(() => parseArgs(["--reply-to", "m1", "--text", "-h"]), DashError);
  assert.deepEqual(parseArgs(["--reply-to", "m1", "--text", "Merged -- the gate was green"]), { images: [], replyTo: "m1", text: "Merged -- the gate was green" });
  assert.equal(dashRefusal("--stdin", "  --x\n"), '--stdin got "--x" as its message; a message never starts with --. Nothing was sent');
  assert.equal(dashRefusal("--stdin", "Done -- the PR merged"), undefined);
  assert.equal(dashRefusal("--text", "- one bullet"), undefined);
});

/**
 * Runs say.mjs against a stub board on 127.0.0.1 (never the real thread or the Keychain) with the message on stdin.
 * @param {string[]} args @param {string} stdin
 */
async function runSay(args, stdin) {
  /** @type {unknown[]} */
  const posts = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      posts.push({ url: req.url, body: JSON.parse(body || "null") });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "stub-1" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "say-dash-"));
  try {
    const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
    const child = spawn(process.execPath, [SAY, ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, RIVET_URL: `http://127.0.0.1:${port}`, RIVET_BRIDGE_DEV: "1", RIVET_BOARD_TOKEN: "0".repeat(64) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.end(stdin);
    const code = await new Promise((resolve) => child.on("close", resolve));
    return { code, stdout, stderr, posts };
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("say sends nothing when the message on stdin starts with --, and sends one that has -- later on", async () => {
  const refused = await runSay(["--reply-to", "m1", "--stdin"], "--x\nthe rest\n");
  assert.equal(refused.code, 2);
  assert.equal(refused.stderr, 'say: --stdin got "--x / the rest" as its message; a message never starts with --. Nothing was sent\n');
  assert.deepEqual(refused.posts, []);

  const swallowed = await runSay(["--reply-to", "m1", "--text", "--stdin"], "the real words\n");
  assert.equal(swallowed.code, 2);
  assert.match(swallowed.stderr, /^say: --text got "--stdin" as its message; for a file use --stdin alone\. Nothing was sent\n$/);
  assert.deepEqual(swallowed.posts, []);

  const sent = await runSay(["--reply-to", "m1", "--stdin"], "Merged -- the gate was green\n");
  assert.equal(sent.stderr, "");
  assert.equal(sent.code, 0);
  assert.equal(sent.stdout, "sent stub-1\n");
  assert.deepEqual(sent.posts, [{ url: "/api/bridge/say", body: { text: "Merged -- the gate was green", replyTo: "m1" } }]);
});

test("say --card with a video holds the merge of the PR the server stored on the card, and throws when it cannot", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "say-hold-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "holds.json");
  const video = { kind: "video", after: { sha256: "a".repeat(64), type: "video/mp4" } };
  const needs = [
    { id: "vc-1", title: "Menu redesign: crests", pr: 41, media: video },
    { id: "vc-2", title: "OTHER", pr: 5, repo: "example-org/other-repo", media: video },
  ];
  /** @type {any[]} */
  const reads = [];
  const fetchFn = /** @type {typeof fetch} */ (async (url, init) => {
    reads.push({ url, auth: /** @type {any} */ (init?.headers).authorization });
    return new Response(JSON.stringify({ version: 1, board: { needs } }), { status: 200 });
  });
  const now = new Date("2026-11-14T03:00:00.000Z");
  const o = { origin: "http://127.0.0.1:1", token: "t", fetch: fetchFn, file, now };
  assert.deepEqual(await holdSayCard("vc-1", o), ["held #41 until the owner's yes on video card vc-1 (holds.json)"]);
  assert.deepEqual(reads, [{ url: "http://127.0.0.1:1/api/board", auth: "Bearer t" }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).map((/** @type {any} */ h) => [h.pr, h.card, h.since]), [[41, "vc-1", now.toISOString()]]);
  assert.deepEqual(await holdSayCard("vc-2", o), ["card vc-2 is about example-org/other-repo#5: holds.json holds only example-org/example-repo PRs, so no merge hold was placed"]);
  await assert.rejects(holdSayCard("vc-9", o), /card vc-9 is not on the board/);
  const down = /** @type {typeof fetch} */ (async () => new Response("{}", { status: 503 }));
  await assert.rejects(holdSayCard("vc-1", { ...o, fetch: down }), /board read: http 503/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 1);
});

test("say --card with a video holds its PR before the post, moves the hold to the card the server names, and keeps it when unsure", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "say-pending-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = new Date("2026-11-14T03:00:00.000Z");
  const hold = { pr: 41, text: "Menu redesign: crests", video: { sha256: "a".repeat(64), type: "video/mp4" } };
  const media = { kind: "video", after: hold.video };
  const read = (/** @type {string} */ file) => JSON.parse(fs.readFileSync(file, "utf8")).map((/** @type {any} */ h) => [h.pr, h.card]);
  /**
   * @param {(file: string) => Response | Promise<Response>} answer the POST's answer, given the holds file as it stands then
   * @param {any[]} [needs]
   */
  async function post(answer, needs = [{ id: "vc-1", pr: 41, media }]) {
    const file = path.join(fs.mkdtempSync(path.join(dir, "h-")), "holds.json");
    /** @type {string[]} */
    const lines = [];
    /** @type {unknown[]} */
    let atPost = [];
    const fetchFn = /** @type {typeof fetch} */ (async (url) => {
      if (String(url).endsWith("/api/bridge/say")) {
        atPost = read(file);
        return answer(file);
      }
      return new Response(JSON.stringify({ version: 1, board: { needs } }), { status: 200 });
    });
    const r = await postSay({ text: hold.text, card: true }, { origin: "http://127.0.0.1:1", token: "t", fetch: fetchFn, file, now, hold, out: (l) => lines.push(`out ${l}`), err: (l) => lines.push(`err ${l}`) });
    return { ...r, lines, atPost, held: fs.existsSync(file) ? read(file) : [] };
  }
  const ok = (/** @type {unknown} */ doc) => () => new Response(JSON.stringify(doc), { status: 200 });

  const sent = await post(ok({ id: "m1", card: "vc-1" }));
  assert.equal(sent.code, 0);
  assert.equal(sent.atPost.length, 1);
  assert.match(String(/** @type {any[]} */ (sent.atPost[0])[1]), /^say-pending-[0-9a-f-]{36}$/);
  assert.deepEqual(sent.held, [[41, "vc-1"]]);
  assert.deepEqual(sent.lines, ["out sent m1", "err held #41 until the owner's yes on video card vc-1 (holds.json)"]);

  // A PR the server found itself is held beside it.
  const found = await post(ok({ id: "m1", card: "vc-1" }), [{ id: "vc-1", pr: 41, ask: "and PR #42", media }]);
  assert.deepEqual(found.held, [[41, "vc-1"], [42, "vc-1"]]);

  // A refusal takes the provisional hold back; an unsure answer keeps it.
  const refused = await post(() => new Response(JSON.stringify({ error: "bad reply" }), { status: 400 }));
  assert.deepEqual([refused.code, refused.posted, refused.held], [1, false, []]);
  assert.deepEqual(refused.lines, ["err http 400: bad reply"]);
  // The say route's 409 for a reply into the old Updates writes nothing first, so the hold goes too (2026-11-16).
  const updates = await post(() => new Response(JSON.stringify({ error: "that line is in the old Updates, which shows nowhere now: send it again without --reply-to" }), { status: 409 }));
  assert.deepEqual([updates.code, updates.posted, updates.held], [1, false, []]);
  for (const answer of [() => new Response("{}", { status: 503 }), () => new Response("{}", { status: 409 }), () => Promise.reject(new Error("socket hang up"))]) {
    const unsure = await post(answer);
    assert.equal(unsure.code, 1);
    assert.equal(unsure.held.length, 1);
    assert.match(unsure.lines.join("\n"), /the merge hold on #41 is kept, as the card may be up \(if it is not: rivet unhold --card say-pending-[0-9a-f-]{36}\)/);
  }

  // Posted, but the board cannot be read: the hold stays, under the card's id, and say fails loudly.
  const blind = await post(ok({ id: "m1", card: "vc-1" }), []);
  assert.deepEqual([blind.code, blind.posted, blind.held], [1, true, [[41, "vc-1"]]]);
  assert.match(blind.lines.at(-1) ?? "", /^err WARNING a PR the server found on video card vc-1 may not be held \(card vc-1 is not on the board\): #41 is held until his yes \(by hand: rivet unhold --card vc-1\); tell the monitor$/);
  // No card named: the provisional hold stays.
  const nameless = await post(ok({ id: "m1" }));
  assert.equal(nameless.code, 1);
  assert.match(String(nameless.held[0][1]), /^say-pending-/);
  assert.match(nameless.lines.at(-1) ?? "", /WARNING the server named no card .* after it, rivet unhold --card say-pending-[0-9a-f-]{36}$/);

  // A hold that cannot be written sends nothing.
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "[{\"pr\": 1}]");
  let posts = 0;
  const r = await postSay({ text: "x", card: true }, { origin: "http://127.0.0.1:1", token: "t", fetch: /** @type {typeof fetch} */ (async () => (posts++, new Response("{}"))), file: bad, now, hold, out: () => {}, err: () => {} });
  assert.deepEqual([r.code, r.posted, posts], [1, false, 0]);
});

test("say does not hold again a PR his yes released between the post and the board read; one the server found is held", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "say-race-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "holds.json");
  const now = new Date("2026-11-14T03:00:00.000Z");
  const hold = { pr: 41, text: "Menu redesign: crests", video: { sha256: "a".repeat(64), type: "video/mp4" } };
  const needs = [{ id: "vc-1", pr: 41, ask: "and PR #42", media: { kind: "video", after: hold.video } }];
  const fetchFn = /** @type {typeof fetch} */ (async (url) => {
    if (String(url).endsWith("/api/bridge/say")) return new Response(JSON.stringify({ id: "m1", card: "vc-1" }), { status: 200 });
    // The bridge takes his yes on the card before the board read answers.
    assert.deepEqual(releaseForYes({ itemId: "vc-1", at: "2026-11-14T03:00:01.000Z", decision: "approve", item: { pr: 41, video: hold.video } }, { file }).released, [41]);
    return new Response(JSON.stringify({ version: 1, board: { needs } }), { status: 200 });
  });
  const r = await postSay({ text: hold.text, card: true }, { origin: "http://127.0.0.1:1", token: "t", fetch: fetchFn, file, now, hold, out: () => {}, err: () => {} });
  assert.deepEqual([r.code, r.posted], [0, true]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).map((/** @type {any} */ h) => [h.pr, h.card]), [[42, "vc-1"]]);
});

test("say prints the card checker's refusal whole and each of its warnings", async () => {
  const refusal = `the update card was refused: card checker: card upd-1: ${"the title has 13 words (at most 12), ".repeat(8)}keep each item short`;
  /** @param {number} status @param {unknown} doc */
  const post = async (status, doc) => {
    /** @type {string[]} */
    const lines = [];
    const fetchFn = /** @type {typeof fetch} */ (async () => new Response(JSON.stringify(doc), { status }));
    const r = await postSay({ text: "x" }, { origin: "http://127.0.0.1:1", token: "t", fetch: fetchFn, out: (l) => lines.push(`out ${l}`), err: (l) => lines.push(`err ${l}`) });
    return { code: r.code, lines };
  };
  assert.deepEqual(await post(422, { error: refusal }), { code: 1, lines: [`err http 422: ${refusal}`] });
  assert.deepEqual(await post(201, { id: "upd-1", card: "upd-1", warnings: ["card upd-1: still 1 is 900×1700", "card upd-1: the ask is long"] }), {
    code: 0,
    lines: ["out sent upd-1", "err card checker warning: card upd-1: still 1 is 900×1700", "err card checker warning: card upd-1: the ask is long"],
  });
});
