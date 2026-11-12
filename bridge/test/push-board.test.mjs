import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "push-board.mjs");
const TOKEN = "cd".repeat(32);
/** @type {{ method?: string, url?: string, auth?: string, ifMatch?: string, type?: string, body: string }[]} */
const seen = [];
const RECORD = {
  id: "r_01",
  itemId: "pr2022-staging",
  itemTitle: "Staging deploy",
  decision: "choice",
  choice: "Option B",
  text: "Staging only; do not deploy production",
  rev: "c82d6c3494e2665f",
  at: "2026-09-28T00:00:00.000Z",
  handled: true,
  item: { id: "pr2022-staging", title: "Staging deploy", kind: "decision", ask: "Deploy staging only?", choiceDetail: "Deploy to staging only", chat: "web", pr: 2022, repo: "example-org/example-repo" },
  delivery: { target: "chat", chat: "web", at: "2026-09-28T00:00:01.000Z", confirmed: true, stages: ["submitted"] },
};
/**
 * The server's board: a PUT stores its body and bumps the version, and while
 * `conflicts` lasts each PUT is a 409 after another writer adds a card.
 * `onGet` runs while a board read is in flight.
 * @type {{ version: number, board: any, conflicts: number, onGet?: () => void }}
 */
const stub = { version: 6, board: null, conflicts: 0 };
/** @param {number} version @param {any} board */
function serve(version, board) {
  Object.assign(stub, { version, board, conflicts: 0, onGet: undefined });
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, ifMatch: req.headers["if-match"], type: req.headers["content-type"], body });
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end("{}");
    if (req.method === "GET" && req.url === "/api/replies/r_01") return res.end(JSON.stringify(RECORD));
    if (req.method === "GET" && req.url?.startsWith("/api/replies/")) return res.writeHead(404).end('{"error":"not found"}');
    if (req.method === "PUT" && req.url?.startsWith("/api/bridge/media/")) {
      setTimeout(() => res.writeHead(201).end("{}"), MEDIA_DELAY_MS);
      return;
    }
    if (req.method === "GET" && req.url === "/api/board") {
      stub.onGet?.();
      return res.end(JSON.stringify({ version: stub.version, updatedAt: null, board: stub.board }));
    }
    if (req.method === "PUT" && req.url === "/api/board") {
      if (body.length > 1024 * 1024) return res.writeHead(413).end('{"error":"board is over 1 MB"}');
      if (stub.conflicts > 0) {
        stub.conflicts--;
        stub.version++;
        stub.board?.needs.push({ id: `race-${stub.version}`, kind: "decision", title: "Raced in" });
        return res.writeHead(409).end('{"error":"stale"}');
      }
      const ifMatch = req.headers["if-match"];
      if (ifMatch !== undefined && ifMatch !== String(stub.version)) return res.writeHead(409).end('{"error":"stale"}');
      stub.board = JSON.parse(body);
      stub.version++;
      return res.end(JSON.stringify({ version: stub.version }));
    }
    res.writeHead(404).end("{}");
  });
});
let origin = "";
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  origin = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});
after(() => server.close());

const MEDIA_DELAY_MS = 600;
/** Runs every AbortSignal.timeout in the script 100 times faster: 30 s is 300 ms, 300 s is 3 s. */
const FAST_TIMEOUTS = `data:text/javascript,${encodeURIComponent("const t = AbortSignal.timeout.bind(AbortSignal); AbortSignal.timeout = (ms) => t(ms / 100);")}`;

/** @param {string[]} args @param {string[]} [nodeArgs] @param {Record<string, string>} [env] @returns {Promise<{ code: number, stdout: string, stderr: string }>} */
function run(args, nodeArgs = [], env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [...nodeArgs, SCRIPT, ...args],
      { env: { PATH: process.env.PATH, RIVET_URL: origin, RIVET_BRIDGE_DEV: "1", RIVET_BOARD_TOKEN: TOKEN, RIVET_REPOS: "example-org/example-repo,example-org/other-repo", ...env }, timeout: 20_000 },
      (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code) : 0, stdout, stderr }),
    );
  });
}

test("--verify prints the server's record of one decision", async () => {
  const r = await run(["--verify", "r_01"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    id: "r_01",
    itemId: "pr2022-staging",
    decision: "choice",
    choice: "Option B",
    text: "Staging only; do not deploy production",
    itemTitle: "Staging deploy",
    rev: "c82d6c3494e2665f",
    item: { ask: "Deploy staging only?", choiceDetail: "Deploy to staging only", pr: 2022, repo: "example-org/example-repo", chat: "web" },
    at: "2026-09-28T00:00:00.000Z",
    delivery: RECORD.delivery,
  });
  assert.equal(seen.at(-1)?.auth, `Bearer ${TOKEN}`);
});

test("--verify of an unknown reply exits 1", async () => {
  const r = await run(["--verify", "r_nope"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no such reply/);
});

test("--media gives each upload and the board PUT after them their own timeouts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-media-"));
  const board = path.join(dir, "board.json");
  fs.writeFileSync(board, JSON.stringify({ updatedAt: "x", needs: [{ id: "pr2022-staging", kind: "approval", title: "Staging deploy" }] }));
  const before = path.join(dir, "before.png");
  const after = path.join(dir, "after.png");
  fs.writeFileSync(before, Buffer.from("89504e470d0a1a0a0001", "hex"));
  fs.writeFileSync(after, Buffer.from("89504e470d0a1a0a0002", "hex"));
  serve(6, null);
  // Two uploads of 600 ms each outlast the 300 ms a single up-front signal would allow the board PUT.
  const out = await run(["--media", "pr2022-staging", "--before", before, "--after", after, board], ["--import", FAST_TIMEOUTS]);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.stdout, "version 7\n");
  assert.equal(seen.filter((r) => r.url?.startsWith("/api/bridge/media/")).length >= 2, true);
  assert.equal(JSON.parse(fs.readFileSync(board, "utf8")).needs[0].media.kind, "before-after");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--still attaches screenshots, alone or under the clips", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-stills-"));
  const board = path.join(dir, "board.json");
  fs.writeFileSync(board, JSON.stringify({ updatedAt: "x", needs: [{ id: "pr2022-staging", kind: "approval", title: "Staging deploy" }] }));
  const shot = (name, byte) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.from(`89504e470d0a1a0a00${byte}`, "hex"));
    return file;
  };
  const a = shot("a.png", "0a");
  const b = shot("b.PNG", "0b");
  const alone = await run(["--media", "pr2022-staging", "--still", a, "--still", b, board]);
  assert.equal(alone.code, 0, alone.stderr);
  const media = JSON.parse(fs.readFileSync(board, "utf8")).needs[0].media;
  assert.equal(media.kind, "stills");
  assert.deepEqual(media.stills.map((s) => s.type), ["image/png", "image/png"]);
  assert.equal(media.stills.length, 2);
  const withClip = await run(["--media", "pr2022-staging", "--after", shot("after.png", "0c"), "--still", a]);
  assert.equal(withClip.code, 0, withClip.stderr);
  const printed = JSON.parse(withClip.stdout).media;
  assert.equal(printed.kind, "video");
  assert.equal(printed.stills.length, 1);
  const video = await run(["--media", "pr2022-staging", "--still", path.join(dir, "clip.mp4")]);
  assert.equal(video.code, 2);
  assert.match(video.stderr, /stills are jpg or png/);
  const nine = await run(["--media", "pr2022-staging", ...Array.from({ length: 9 }, () => ["--still", a]).flat()]);
  assert.equal(nine.code, 2);
  assert.match(nine.stderr, /at most 8 stills/);
  const stray = await run([board, "--still", a]);
  assert.equal(stray.code, 2);
  assert.match(stray.stderr, /go with --media/);
  fs.rmSync(dir, { recursive: true, force: true });
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("--media refuses a clip recorded bigger than the viewport, before any upload", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-corner-"));
  const make = (/** @type {string} */ name, /** @type {string} */ vf) => {
    const file = path.join(dir, name);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=360x640:d=1:r=30", "-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
    return file;
  };
  const clean = make("before.mp4", "scale=720:1280");
  const padded = make("after.mp4", "pad=720:1280:0:0:color=0x7e817e");
  const uploads = () => seen.filter((r) => r.url?.startsWith("/api/bridge/media/")).length;
  const was = uploads();
  const refused = await run(["--media", "pr2022-staging", "--before", clean, "--after", padded]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /after\.mp4: the page sits in the top-left corner, with grey padding along the right edge/);
  assert.match(refused.stderr, /add --skip-corner-check/);
  assert.equal(uploads(), was);
  // A page whose own grey reaches the edge goes through when the operator says so.
  const skipped = await run(["--media", "pr2022-staging", "--after", padded, "--skip-corner-check"]);
  assert.equal(skipped.code, 0, skipped.stderr);
  const stray = await run(["--replies", "--skip-corner-check"]);
  assert.equal(stray.code, 2);
  assert.match(stray.stderr, /--skip-corner-check go with --media/);
  const ok = await run(["--media", "pr2022-staging", "--after", clean]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).media.kind, "video");
  // Without ffmpeg the check is skipped with a warning, never a refusal.
  const bare = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, "--media", "pr2022-staging", "--after", padded],
      { env: { PATH: dir, RIVET_URL: origin, RIVET_BRIDGE_DEV: "1", RIVET_BOARD_TOKEN: TOKEN }, timeout: 20_000 },
      (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code) : 0, stdout, stderr }),
    );
  });
  assert.equal(bare.code, 0, bare.stderr);
  assert.match(bare.stderr, /could not read a frame of after\.mp4 \(is ffmpeg installed\?\); skipped the corner check/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--audio attaches labelled sound clips, and --label only follows an --audio", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-audio-"));
  const board = path.join(dir, "board.json");
  fs.writeFileSync(board, JSON.stringify({ updatedAt: "x", needs: [{ id: "rivet-voice-pick", kind: "decision", title: "Pick a voice" }] }));
  const sound = (name, byte) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([byte])]));
    return file;
  };
  const onyx = sound("onyx.mp3", 1);
  const echo = sound("echo.mp3", 2);
  const out = await run(["--media", "rivet-voice-pick", "--audio", onyx, "--label", "Onyx", "--audio", echo, board]);
  assert.equal(out.code, 0, out.stderr);
  const media = JSON.parse(fs.readFileSync(board, "utf8")).needs[0].media;
  assert.equal(media.kind, "audio");
  assert.deepEqual(
    media.clips.map((c) => [c.type, c.label]),
    [
      ["audio/mpeg", "Onyx"],
      ["audio/mpeg", undefined],
    ],
  );
  const stray = await run(["--media", "rivet-voice-pick", "--label", "Onyx", "--audio", onyx]);
  assert.equal(stray.code, 2);
  assert.match(stray.stderr, /--label names the --audio just before it/);
  const wav = await run(["--media", "rivet-voice-pick", "--audio", path.join(dir, "a.wav")]);
  assert.equal(wav.code, 2);
  assert.match(wav.stderr, /mp3 or m4a/);
  const asVideo = await run(["--media", "rivet-voice-pick", "--after", onyx]);
  assert.equal(asVideo.code, 1);
  assert.match(asVideo.stderr, /sound goes in --audio/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--file attaches PDFs under their own names, alone or with other media", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-pdf-"));
  const board = path.join(dir, "board.json");
  fs.writeFileSync(board, JSON.stringify({ updatedAt: "x", needs: [{ id: "white-paper", kind: "decision", title: "White paper" }] }));
  const pdf = (name, body = "%PDF-1.7\n1 0 obj") => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    return file;
  };
  const paper = pdf("White paper — final?.pdf");
  const alone = await run(["--media", "white-paper", "--file", paper, board]);
  assert.equal(alone.code, 0, alone.stderr);
  const upload = seen.findLast((r) => r.url?.startsWith("/api/bridge/media/"));
  assert.equal(upload?.type, "application/pdf");
  const media = JSON.parse(fs.readFileSync(board, "utf8")).needs[0].media;
  assert.deepEqual(media, {
    kind: "files",
    files: [{ sha256: upload?.url?.slice("/api/bridge/media/".length), type: "application/pdf", name: "White paper final.pdf", bytes: 16 }],
  });

  const shot = path.join(dir, "shot.png");
  fs.writeFileSync(shot, Buffer.from("89504e470d0a1a0a0001", "hex"));
  const mixed = await run(["--media", "white-paper", "--still", shot, "--file", paper, "--file", pdf("(Deck) v2_1.PDF", "%PDF-1.4 deck")]);
  assert.equal(mixed.code, 0, mixed.stderr);
  const printed = JSON.parse(mixed.stdout).media;
  assert.equal(printed.kind, "stills");
  assert.deepEqual(
    printed.files.map((f) => f.name),
    ["White paper final.pdf", "Deck) v2_1.pdf"],
  );
  const odd = await run(["--media", "white-paper", "--file", pdf("....pdf", "%PDF-dots"), "--file", pdf(".. résumé ..pdf", "%PDF-accents")]);
  assert.equal(odd.code, 0, odd.stderr);
  assert.deepEqual(
    JSON.parse(odd.stdout).media.files.map((f) => f.name),
    ["document.pdf", "r sum ..pdf"],
  );

  const notPdf = await run(["--media", "white-paper", "--file", pdf("fake.pdf", "<html>")]);
  assert.equal(notPdf.code, 1);
  assert.match(notPdf.stderr, /fake\.pdf: not a PDF/);
  const zip = await run(["--media", "white-paper", "--file", path.join(dir, "paper.zip")]);
  assert.equal(zip.code, 2);
  assert.match(zip.stderr, /--file takes a pdf, md, txt/);
  const five = await run(["--media", "white-paper", ...Array.from({ length: 5 }, () => ["--file", paper]).flat()]);
  assert.equal(five.code, 2);
  assert.match(five.stderr, /at most 4 documents/);
  const big = path.join(dir, "big.pdf");
  fs.writeFileSync(big, "%PDF-");
  fs.truncateSync(big, 25 * 1024 * 1024 + 1);
  const tooBig = await run(["--media", "white-paper", "--file", big]);
  assert.equal(tooBig.code, 1);
  assert.match(tooBig.stderr, /big\.pdf: empty or over 25 MB/);
  const asClip = await run(["--media", "white-paper", "--after", paper]);
  assert.equal(asClip.code, 1);
  assert.match(asClip.stderr, /a PDF goes in --file/);
  const notes = await run(["--media", "white-paper", "--file", pdf("Sweep notes!.MD", "# Notes"), "--file", pdf("run.log", "ok"), "--file", pdf("....json", "{}")]);
  assert.equal(notes.code, 0, notes.stderr);
  assert.deepEqual(
    JSON.parse(notes.stdout).media.files.map((f) => [f.name, f.type]),
    [
      ["Sweep notes.md", "text/markdown"],
      ["run.log", "text/plain"],
      ["file.json", "application/json"],
    ],
  );
  const stray = await run([board, "--file", paper]);
  assert.equal(stray.code, 2);
  assert.match(stray.stderr, /go with --media/);
  // A text document the redactor would change is refused before it is hashed, never sent redacted; a PDF is not read.
  const secret = await run(["--media", "white-paper", "--file", pdf("creds.md", `token: ghp_${"A1b2".repeat(9)}\n`)]);
  assert.equal(secret.code, 1);
  assert.match(secret.stderr, /creds\.md: That text file holds something the redactor takes out.*Found at line 1 \(github token\)/);
  assert.doesNotMatch(secret.stderr, /A1b2/);
  const huge = await run(["--media", "white-paper", "--file", pdf("huge.log", "ok\n".repeat(128 * 1024 + 1))]);
  assert.equal(huge.code, 1);
  assert.match(huge.stderr, /huge\.log: A text file sent to a card is at most 256 KB/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a board push prints the version and sends If-Match", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-board-"));
  const file = path.join(dir, "board.json");
  fs.writeFileSync(file, JSON.stringify({ updatedAt: "x", needs: [] }));
  serve(6, null);
  const ok = await run([file, "--if-match", "6"]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout, "version 7\n");
  assert.equal(seen.at(-1)?.ifMatch, "6");
  const stale = await run([file, "--if-match", "1"]);
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /stale version \(http 409: stale\)/);
});

const need = (/** @type {string} */ id, title = id) => ({ id, kind: "decision", title });
/** A temp board.json holding `lists`, with a last-push sidecar of `pushed` keys when given. @param {any} lists @param {any} [pushed] */
function boardFile(lists, pushed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-merge-"));
  const file = path.join(dir, "board.json");
  fs.writeFileSync(file, JSON.stringify({ updatedAt: "2026-10-01T00:00:00Z", needs: [], coming: [], chats: [], ...lists }));
  if (pushed) fs.writeFileSync(`${file}.pushed`, JSON.stringify({ version: 1, needs: [], coming: [], chats: [], ...pushed }));
  return { file, read: () => JSON.parse(fs.readFileSync(file, "utf8")), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const boardCalls = (/** @type {number} */ from) => seen.slice(from).filter((r) => r.url === "/api/board");

test("a plain push keeps what other chats added since the last push, and the local copy wins", async () => {
  const b = boardFile({ needs: [need("mine", "Mine, edited")] }, { needs: ["mine"] });
  serve(10, {
    needs: [{ ...need("mine", "Mine, old"), rev: "a1" }, { ...need("theirs"), rev: "b2" }],
    coming: [{ pr: 2901, title: "Board merge" }, { title: "No PR yet" }],
    chats: [{ name: "ace", status: "working" }],
  });
  const from = seen.length;
  const r = await run([b.file]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "version 11\n");
  assert.match(r.stderr, /kept 4 item\(s\) other chats added: needs:theirs, coming:pr:2901, coming:title:No PR yet, chats:ace\n/);
  const [get, put] = boardCalls(from);
  assert.equal(get?.method, "GET");
  assert.equal(put?.method, "PUT");
  assert.equal(put?.ifMatch, "10");
  const sent = JSON.parse(put?.body ?? "");
  assert.deepEqual(sent.needs, [need("mine", "Mine, edited"), need("theirs")]);
  assert.deepEqual(sent.coming, [{ pr: 2901, title: "Board merge" }, { title: "No PR yet" }]);
  assert.deepEqual(sent.chats, [{ name: "ace", status: "working" }]);
  assert.deepEqual(b.read(), sent);
  const { digests, pushedAt, ...keys } = JSON.parse(fs.readFileSync(`${b.file}.pushed`, "utf8"));
  assert.ok(Number.isFinite(Date.parse(pushedAt)));
  assert.deepEqual(keys, {
    version: 11,
    needs: ["mine", "theirs"],
    coming: ["pr:2901", "title:Board merge", "title:No PR yet", "no-pr:No PR yet"],
    chats: ["ace"],
    shipped: [],
  });
  assert.deepEqual(Object.keys(digests), ["mine", "theirs"]);
  b.done();
});

test("a push keeps a shipped row the server moved there from Coming, each repo's PR apart, and a sidecar from before keeps them all", async () => {
  const elsewhere = { pr: 41, repo: "example-org/third-repo", title: "Done", shippedAt: "2026-10-03T00:00:00.000Z" };
  const b = boardFile({ coming: [], shipped: [{ pr: 41, title: "Done" }] }, { needs: [], coming: ["pr:41", "title:Done"], chats: [], shipped: ["pr:example-org/example-repo#41"] });
  serve(5, { coming: [], shipped: [elsewhere, { pr: 41, title: "Done" }] });
  const from = seen.length;
  const r = await run([b.file]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(boardCalls(from).at(-1)?.body ?? "").shipped, [elsewhere, { pr: 41, title: "Done" }]);
  b.done();
  // A sidecar from before shipped was merged knows no shipped row the monitor deleted, so it keeps every server row once.
  const old = boardFile({ shipped: [] }, { needs: [], coming: ["pr:40"], chats: [] });
  serve(6, { shipped: [{ pr: 40, title: "Moved by the server" }] });
  const again = seen.length;
  assert.equal((await run([old.file])).code, 0);
  assert.deepEqual(JSON.parse(boardCalls(again).at(-1)?.body ?? "").shipped, [{ pr: 40, title: "Moved by the server" }]);
  old.done();
  // A shipped row with no PR is its repo's title: another repo's row of the title is not the local one.
  const enquiry = { repo: "example-org/third-repo", title: "Enquiry form", shippedAt: "2026-10-03T00:00:00.000Z" };
  const titled = boardFile({ shipped: [{ title: "Enquiry form" }] }, { needs: [], coming: [], chats: [], shipped: ["title:Enquiry form"] });
  serve(7, { shipped: [enquiry, { title: "Enquiry form" }] });
  const third = seen.length;
  assert.equal((await run([titled.file])).code, 0);
  assert.deepEqual(JSON.parse(boardCalls(third).at(-1)?.body ?? "").shipped, [enquiry, { title: "Enquiry form" }]);
  titled.done();
});

test("a sidecar from before the digests leaves out a removed card; a row with a new PR stays; a restored server keeps all", async () => {
  const b = boardFile({ needs: [need("handled")], coming: [{ pr: 42, title: "Feature" }] }, { needs: ["handled"], coming: ["pr:41", "title:Feature"] });
  serve(5, { needs: [], coming: [] });
  const from = seen.length;
  const r = await run([b.file]);
  assert.equal(r.code, 0, r.stderr);
  const sent = JSON.parse(boardCalls(from).at(-1)?.body ?? "");
  assert.deepEqual(sent.needs, []);
  assert.deepEqual(sent.coming, [{ pr: 42, title: "Feature" }]);
  b.done();
  const restored = boardFile({ needs: [need("kept")] }, { version: 50, needs: ["kept"], digests: {} });
  serve(3, { needs: [] });
  const again = seen.length;
  assert.equal((await run([restored.file])).code, 0);
  assert.deepEqual(JSON.parse(boardCalls(again).at(-1)?.body ?? "").needs, [need("kept")]);
  restored.done();
});

test("Shipped keeps 200 rows after a push adds the server's, the oldest by the server's day left out", async () => {
  // The monitor's file has no server stamps: its oldest row is first, and the server already left it out.
  const local = Array.from({ length: 200 }, (_, i) => ({ pr: 1000 + i, title: `Row ${i}` }));
  const b = boardFile({ shipped: local }, { shipped: local.map((row) => `pr:example-org/example-repo#${row.pr}`) });
  const stamped = local.slice(1).map((row, i) => ({ ...row, shippedAt: new Date(Date.parse("2026-09-01T00:00:00.000Z") + i * 3600_000).toISOString() }));
  serve(8, { shipped: [{ pr: 41, title: "New", shippedAt: "2026-10-04T00:00:00.000Z" }, ...stamped] });
  const from = seen.length;
  assert.equal((await run([b.file])).code, 0);
  const sent = JSON.parse(boardCalls(from).at(-1)?.body ?? "").shipped;
  assert.equal(sent.length, 200);
  assert.deepEqual(sent.map((/** @type {any} */ row) => row.pr), [41, ...local.slice(1).map((row) => row.pr)]);
  b.done();
});

test("a card or Coming row the server removed since the last push is left out, unless the monitor changed the card", async () => {
  const b = boardFile({ needs: [need("handled"), need("asked-again")], coming: [{ pr: 41, title: "Merged" }] });
  serve(1, { needs: [need("handled"), need("asked-again")], coming: [{ pr: 41, title: "Merged" }] });
  assert.equal((await run([b.file])).code, 0);
  const asked = { ...need("asked-again"), title: "Asked again" };
  fs.writeFileSync(b.file, JSON.stringify({ ...b.read(), needs: [need("handled"), asked] }));
  serve(2, { needs: [], coming: [], shipped: [{ pr: 41, title: "Merged" }] });
  const from = seen.length;
  const r = await run([b.file]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /left out 2 item\(s\) the server removed: needs:handled, coming:pr:41\n/);
  const sent = JSON.parse(boardCalls(from).at(-1)?.body ?? "");
  assert.deepEqual(sent.needs, [asked]);
  assert.deepEqual(sent.coming, []);
  assert.deepEqual(sent.shipped, [{ pr: 41, title: "Merged" }]);
  assert.deepEqual(b.read().needs, [asked]);
  assert.deepEqual(b.read().coming, []);
  b.done();
});

test("a key in the last push but gone locally is the monitor's own delete and stays deleted", async () => {
  const b = boardFile({ needs: [need("kept")], chats: [] }, { needs: ["kept", "dropped"], coming: ["pr:7", "title:Seven"], chats: ["old"] });
  serve(3, { needs: [need("kept"), need("dropped")], coming: [{ pr: 7, title: "Seven" }], chats: [{ name: "old" }] });
  const from = seen.length;
  const r = await run([b.file]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, "");
  const sent = JSON.parse(boardCalls(from).at(-1)?.body ?? "");
  assert.deepEqual(sent.needs, [need("kept")]);
  assert.deepEqual(sent.coming, []);
  assert.deepEqual(sent.chats, []);
  b.done();
});

test("a card the monitor deleted stays if you opened it again on the server after that push, and is deleted if before", async () => {
  const again = (/** @type {string} */ at) => ({ n: 1, after: "reply-1", at });
  const later = { ...need("later"), again: again("2026-10-26T02:00:00.000Z") };
  const earlier = { ...need("earlier"), again: again("2026-10-26T00:00:00.000Z") };
  const b = boardFile({ needs: [need("kept")], chats: [] }, { pushedAt: "2026-10-26T01:00:00.000Z", needs: ["kept", "later", "earlier", "dropped"] });
  serve(3, { needs: [need("kept"), later, earlier, need("dropped")] });
  const from = seen.length;
  const r = await run([b.file]);
  assert.equal(r.code, 0, r.stderr);
  const sent = JSON.parse(boardCalls(from).at(-1)?.body ?? "");
  assert.deepEqual(sent.needs, [need("kept"), later]);
  b.done();
});

test("with no last push yet, every server-only item is kept", async () => {
  const b = boardFile({ needs: [need("mine")] });
  serve(4, { needs: [need("mine"), need("theirs")], coming: [{ pr: 12, title: "Twelve" }], chats: [] });
  const r = await run([b.file]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /kept 2 item\(s\) other chats added: needs:theirs, coming:pr:12/);
  assert.deepEqual(
    b.read().needs.map((/** @type {any} */ n) => n.id),
    ["mine", "theirs"],
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(`${b.file}.pushed`, "utf8")).needs, ["mine", "theirs"]);
  b.done();
});

test("the write-back adds kept items to the board file as it is after the push, not as it was read", async () => {
  const b = boardFile({ needs: [need("mine"), need("gone")] }, { needs: ["mine", "gone"] });
  serve(60, { needs: [need("mine"), need("gone"), need("theirs")] });
  stub.onGet = () => fs.writeFileSync(b.file, JSON.stringify({ updatedAt: "2026-10-01T00:01:00Z", needs: [need("mine"), need("fresh")] }));
  const from = seen.length;
  const r = await run([b.file]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(
    JSON.parse(boardCalls(from).at(-1)?.body ?? "").needs.map((/** @type {any} */ n) => n.id),
    ["mine", "gone", "theirs"],
  );
  assert.deepEqual(b.read(), { updatedAt: "2026-10-01T00:01:00Z", needs: [need("mine"), need("fresh"), need("theirs")] });
  b.done();
});

test("a PR row and a title-only row whose title looks like that PR are different rows", async () => {
  const b = boardFile({ coming: [{ pr: 7, title: "Seven" }] }, { coming: ["pr:7", "title:Seven"] });
  serve(70, { needs: [], coming: [{ pr: 7, title: "Seven" }, { title: "#7" }, { title: "pr:7" }] });
  const r = await run([b.file]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /kept 2 item\(s\) other chats added: coming:title:#7, coming:title:pr:7\n/);
  assert.deepEqual(b.read().coming, [{ pr: 7, title: "Seven" }, { title: "#7" }, { title: "pr:7" }]);
  b.done();
});

test("a coming row matches by its PR or its title, so a PR added to a titled row does not duplicate it", async () => {
  const b = boardFile({ coming: [{ title: "Lobby", stage: "building" }] });
  serve(80, { needs: [], coming: [{ title: "Lobby", pr: 2300 }] });
  const from = seen.length;
  const r = await run([b.file]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.deepEqual(JSON.parse(boardCalls(from).at(-1)?.body ?? "").coming, [{ title: "Lobby", stage: "building" }]);
  const deleted = boardFile({}, { coming: ["title:Lobby", "no-pr:Lobby"] });
  serve(81, { needs: [], coming: [{ title: "Lobby", pr: 2300 }] });
  const gone = await run([deleted.file]);
  assert.equal(gone.code, 0, gone.stderr);
  assert.deepEqual(JSON.parse(boardCalls(from).at(-1)?.body ?? "").coming, []);
  // A sidecar from before no-pr keys cannot say Lobby had no PR: the row comes back once rather than drop another PR's.
  const legacy = boardFile({}, { coming: ["pr:7", "title:Lobby"] });
  serve(82, { needs: [], coming: [{ title: "Lobby", pr: 2300 }] });
  assert.equal((await run([legacy.file])).code, 0);
  assert.deepEqual(JSON.parse(boardCalls(from).at(-1)?.body ?? "").coming, [{ title: "Lobby", pr: 2300 }]);
  b.done();
  deleted.done();
  legacy.done();
});

test("a PR number or chat name names a row only within its repo, so another repo's row of the same is kept", async () => {
  const otherRepo = "example-org/other-repo";
  const ours = { name: "web", state: "working", prs: [7] };
  const b = boardFile(
    { coming: [{ pr: 7, title: "Seven", chat: "web" }, { pr: 8, title: "Fix CI" }, { title: "Notes" }], chats: [ours] },
    { coming: ["pr:7", "title:Seven", "pr:8", "title:Fix CI", "title:Notes", "no-pr:Notes"], chats: ["web"] },
  );
  const theirs = { name: "web", state: "working", repo: otherRepo };
  const lab = { name: "lab", state: "working", repo: otherRepo, prs: [7] };
  serve(90, {
    needs: [],
    coming: [{ pr: 7, title: "Seven", chat: "web" }, { pr: 8, title: "Fix CI" }, { title: "Notes" }, { pr: 7, title: "Other seven", chat: "lab" }, { pr: 9, title: "Fix CI" }],
    chats: [ours, theirs, lab],
  });
  const from = seen.length;
  const r = await run([b.file]);
  assert.equal(r.code, 0, r.stderr);
  // The lab row is the other repo's PR 7's only once that chat is read: the chats are merged first.
  assert.match(r.stderr, new RegExp(`kept 4 item\\(s\\) other chats added: coming:pr:${otherRepo}/7, coming:pr:9, chats:${otherRepo}/web, chats:${otherRepo}/lab\n`));
  const sent = JSON.parse(boardCalls(from).at(-1)?.body ?? "");
  assert.deepEqual(sent.coming.map((/** @type {any} */ row) => [row.pr, row.title]), [[7, "Seven"], [8, "Fix CI"], [undefined, "Notes"], [7, "Other seven"], [9, "Fix CI"]]);
  assert.deepEqual(sent.chats, [ours, theirs, lab]);
  const { coming, chats } = JSON.parse(fs.readFileSync(`${b.file}.pushed`, "utf8"));
  assert.deepEqual(chats, ["web", `${otherRepo}/web`, `${otherRepo}/lab`]);
  assert.ok(coming.includes(`pr:${otherRepo}/7`) && coming.includes("pr:7"));
  b.done();
  // The server merged the other repo's PR 7 and dropped its row: the local copy goes, the default repo's PR 7 stays.
  const after = boardFile(
    { coming: [{ pr: 7, title: "Seven", chat: "web" }, { pr: 7, title: "Other seven", chat: "lab" }], chats: [ours, lab] },
    { coming: ["pr:7", "title:Seven", `pr:${otherRepo}/7`, `title:${otherRepo}/Other seven`], chats: ["web", `${otherRepo}/lab`] },
  );
  serve(91, { needs: [], coming: [{ pr: 7, title: "Seven", chat: "web" }], chats: [ours, lab] });
  const again = seen.length;
  const left = await run([after.file]);
  assert.equal(left.code, 0, left.stderr);
  assert.match(left.stderr, new RegExp(`left out 1 item\\(s\\) the server removed: coming:pr:${otherRepo}/7\n`));
  assert.deepEqual(JSON.parse(boardCalls(again).at(-1)?.body ?? "").coming, [{ pr: 7, title: "Seven", chat: "web" }]);
  after.done();
});

test("a title names a row only within its repo, and a new sidecar of PR rows drops no other PR of their title", async () => {
  const otherRepo = "example-org/other-repo";
  const lab = { name: "lab", state: "working", repo: otherRepo, prs: [8] };
  // A default-repo title-only row does not swallow another repo's PR row of the same title.
  const b = boardFile({ coming: [{ title: "Fix CI", chat: "main" }], chats: [lab] });
  serve(95, { needs: [], coming: [{ title: "Fix CI", chat: "main" }, { pr: 8, title: "Fix CI", chat: "lab" }], chats: [lab] });
  const from = seen.length;
  const r = await run([b.file]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`kept 1 item\\(s\\) other chats added: coming:pr:${otherRepo}/8\n`));
  assert.deepEqual(JSON.parse(boardCalls(from).at(-1)?.body ?? "").coming.map((/** @type {any} */ row) => row.pr), [undefined, 8]);
  b.done();
  // A sidecar written now, of PR rows only, holds no no-pr key: another chat's PR 9 of the same title is kept.
  const c = boardFile({ coming: [{ pr: 7, title: "Seven" }] });
  serve(96, { needs: [], coming: [{ pr: 7, title: "Seven" }] });
  assert.equal((await run([c.file])).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${c.file}.pushed`, "utf8")).coming, ["pr:7", "title:Seven"]);
  serve(97, { needs: [], coming: [{ pr: 7, title: "Seven" }, { pr: 9, title: "Seven" }] });
  const again = seen.length;
  const next = await run([c.file]);
  assert.equal(next.code, 0, next.stderr);
  assert.deepEqual(JSON.parse(boardCalls(again).at(-1)?.body ?? "").coming, [{ pr: 7, title: "Seven" }, { pr: 9, title: "Seven" }]);
  c.done();
});

test("a title that reads as a repo is escaped, and a PR row's title key follows its PR", async () => {
  const otherRepo = "example-org/other-repo";
  const lab = { name: "lab", state: "working", repo: otherRepo, prs: [7] };
  // A default-repo title that starts with a repo is not the other repo's row of the rest of it.
  const odd = boardFile({ coming: [{ title: `${otherRepo}/Fix CI` }], chats: [lab] });
  serve(99, { needs: [], coming: [{ title: `${otherRepo}/Fix CI` }, { title: "Fix CI", chat: "lab" }], chats: [lab] });
  const again = seen.length;
  assert.equal((await run([odd.file])).code, 0);
  assert.equal(JSON.parse(boardCalls(again).at(-1)?.body ?? "").coming.length, 2);
  odd.done();
  // A second twin in another repo leaves the PR 7 row's keys as they were pushed, so the server's delete of it holds.
  const twin = { name: "twin", state: "working", prs: [7] };
  const pushed = boardFile({ coming: [{ pr: 7, title: "Seven", chat: "twin" }], chats: [twin] });
  serve(100, { needs: [], coming: [{ pr: 7, title: "Seven", chat: "twin" }], chats: [twin] });
  assert.equal((await run([pushed.file])).code, 0);
  const other = { name: "twin", state: "working", repo: otherRepo, prs: [8] };
  fs.writeFileSync(pushed.file, JSON.stringify({ needs: [], coming: [{ pr: 7, title: "Seven", chat: "twin" }], chats: [twin, other] }));
  serve(101, { needs: [], coming: [], chats: [twin, other] });
  const last = seen.length;
  const gone = await run([pushed.file]);
  assert.equal(gone.code, 0, gone.stderr);
  assert.deepEqual(JSON.parse(boardCalls(last).at(-1)?.body ?? "").coming, []);
  pushed.done();
});

test("two repos' Coming rows of one PR and chat name stay two rows, and keys of other pushed rows never pass a new one off as pushed", async () => {
  const otherRepo = "example-org/other-repo";
  const ours = { name: "lab", state: "working", prs: [7] };
  const theirs = { name: "lab", state: "working", repo: otherRepo, prs: [7] };
  // Once both chats are merged neither row's repo can be told, so the title tells them apart.
  const b = boardFile({ coming: [{ pr: 7, title: "Main seven", chat: "lab" }], chats: [ours] });
  serve(103, { needs: [], coming: [{ pr: 7, title: "Main seven", chat: "lab" }, { pr: 7, title: "Other seven", chat: "lab" }], chats: [ours, theirs] });
  const from = seen.length;
  const r = await run([b.file]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(boardCalls(from).at(-1)?.body ?? "").coming.map((/** @type {any} */ row) => row.title), ["Main seven", "Other seven"]);
  b.done();
  // PR 7 and the title "Fix CI" were pushed, on two default-repo rows: the other repo's PR 7 "Fix CI" another writer added
  // since is new, and kept.
  const pushed = boardFile({ coming: [{ pr: 7, title: "Seven", chat: "lab" }, { pr: 8, title: "Fix CI", chat: "soft" }], chats: [ours] });
  serve(104, { needs: [], coming: [{ pr: 7, title: "Seven", chat: "lab" }, { pr: 8, title: "Fix CI", chat: "soft" }], chats: [ours] });
  assert.equal((await run([pushed.file])).code, 0);
  serve(105, { needs: [], coming: [{ pr: 7, title: "Seven", chat: "lab" }, { pr: 8, title: "Fix CI", chat: "soft" }, { pr: 7, title: "Fix CI", chat: "lab" }], chats: [ours, theirs] });
  const last = seen.length;
  const kept = await run([pushed.file]);
  assert.equal(kept.code, 0, kept.stderr);
  assert.deepEqual(JSON.parse(boardCalls(last).at(-1)?.body ?? "").coming.map((/** @type {any} */ row) => [row.pr, row.title]), [[7, "Seven"], [8, "Fix CI"], [7, "Fix CI"]]);
  pushed.done();
});

test("one PR-less Coming row stands for one server PR row of its title, so another chat's second PR of it is kept", async () => {
  const otherRepo = "example-org/other-repo";
  const chats = [{ name: "lab", state: "working", prs: [7] }, { name: "lab", state: "working", repo: otherRepo, prs: [8] }];
  const seven = { pr: 7, title: "Fix CI", chat: "lab" };
  const eight = { pr: 8, title: "Fix CI", chat: "lab" };
  const rows = (/** @type {number} */ from) => JSON.parse(boardCalls(from).at(-1)?.body ?? "").coming.map((/** @type {any} */ row) => [row.pr, row.title]);
  // The local row stands for PR 7, the first of its title; PR 8 is another writer's.
  const b = boardFile({ coming: [{ title: "Fix CI", chat: "lab" }], chats });
  serve(110, { needs: [], coming: [seven, eight], chats });
  const from = seen.length;
  const r = await run([b.file]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(rows(from), [[undefined, "Fix CI"], [8, "Fix CI"]]);
  b.done();
  // The server's own PR-less row of the title is the local row's twin, so it stands for neither PR row.
  const twin = boardFile({ coming: [{ title: "Fix CI", chat: "lab" }], chats });
  serve(111, { needs: [], coming: [seven, { title: "Fix CI", chat: "lab" }, eight], chats });
  const next = seen.length;
  assert.equal((await run([twin.file])).code, 0);
  assert.deepEqual(rows(next), [[undefined, "Fix CI"], [7, "Fix CI"], [8, "Fix CI"]]);
  twin.done();
  // A pushed PR-less row the monitor deleted since is the monitor's delete of one PR row of its title, not of both.
  const deleted = boardFile({ coming: [{ title: "Fix CI", chat: "lab" }], chats });
  serve(112, { needs: [], coming: [{ title: "Fix CI", chat: "lab" }], chats });
  assert.equal((await run([deleted.file])).code, 0);
  fs.writeFileSync(deleted.file, JSON.stringify({ needs: [], coming: [], chats }));
  serve(113, { needs: [], coming: [seven, eight], chats });
  const since = seen.length;
  assert.equal((await run([deleted.file])).code, 0);
  assert.deepEqual(rows(since), [[8, "Fix CI"]]);
  deleted.done();
  // Pushed once, the local row still stands for PR 7: it is not left out as removed, so PR 7 is not lost with it.
  const placeholder = boardFile({ coming: [{ title: "Fix CI", chat: "lab" }], chats });
  serve(114, { needs: [], coming: [{ title: "Fix CI", chat: "lab" }], chats });
  assert.equal((await run([placeholder.file])).code, 0);
  serve(115, { needs: [], coming: [seven, eight], chats });
  const held = seen.length;
  assert.equal((await run([placeholder.file])).code, 0);
  assert.deepEqual(rows(held), [[undefined, "Fix CI"], [8, "Fix CI"]]);
  placeholder.done();
  // A pushed PR-less row the monitor has since given PR 7 stands for PR 7 alone: another chat's PR 8 is kept.
  const promoted = boardFile({ coming: [{ title: "Fix CI" }] });
  serve(116, { needs: [], coming: [{ title: "Fix CI" }] });
  assert.equal((await run([promoted.file])).code, 0);
  fs.writeFileSync(promoted.file, JSON.stringify({ needs: [], coming: [{ pr: 7, title: "Fix CI" }] }));
  serve(117, { needs: [], coming: [{ pr: 8, title: "Fix CI" }, { pr: 7, title: "Fix CI" }] });
  const given = seen.length;
  assert.equal((await run([promoted.file])).code, 0);
  assert.deepEqual(rows(given), [[7, "Fix CI"], [8, "Fix CI"]]);
  promoted.done();
});

test("a kept PR row of a PR-less row's title is word-checked, left out and written back as its own row", async () => {
  const twin = { title: "Fix CI", what: "Building" };
  // The server's PR 7 text was let through before: the word check reads PR 7's row, not the PR-less row of its title.
  const b = boardFile({ coming: [twin] });
  serve(120, { needs: [], coming: [twin, { pr: 7, title: "Fix CI", what: "Now live" }] });
  const from = seen.length;
  const r = await run([b.file]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(boardCalls(from).at(-1)?.body ?? "").coming.map((/** @type {any} */ row) => row.pr), [undefined, 7]);
  b.done();
  // Pushed with PR 8 beside it, PR 8 the server deleted since stays deleted, though the PR-less row of its title is there.
  const pushed = boardFile({ coming: [twin, { pr: 8, title: "Fix CI" }] });
  serve(121, { needs: [], coming: [twin, { pr: 8, title: "Fix CI" }] });
  assert.equal((await run([pushed.file])).code, 0);
  serve(122, { needs: [], coming: [twin] });
  const since = seen.length;
  const gone = await run([pushed.file]);
  assert.equal(gone.code, 0, gone.stderr);
  assert.deepEqual(JSON.parse(boardCalls(since).at(-1)?.body ?? "").coming, [twin]);
  pushed.done();
  // A PR-less row written to the file during the read stands for the PR row the push kept, so it is written back once.
  const raced = boardFile({ coming: [] });
  serve(123, { needs: [], coming: [{ pr: 7, title: "Lobby" }] });
  stub.onGet = () => fs.writeFileSync(raced.file, JSON.stringify({ needs: [], coming: [{ title: "Lobby", stage: "building" }] }));
  assert.equal((await run([raced.file])).code, 0);
  assert.deepEqual(raced.read().coming, [{ title: "Lobby", stage: "building" }]);
  raced.done();
  // That row stands first for the server's PR-less row of its title, so the kept PR row is written back beside it.
  const both = boardFile({ coming: [] });
  serve(124, { needs: [], coming: [{ title: "Lobby" }, { pr: 7, title: "Lobby" }] });
  stub.onGet = () => fs.writeFileSync(both.file, JSON.stringify({ needs: [], coming: [{ title: "Lobby", stage: "building" }] }));
  assert.equal((await run([both.file])).code, 0);
  assert.deepEqual(both.read().coming, [{ title: "Lobby", stage: "building" }, { pr: 7, title: "Lobby" }]);
  both.done();
  // A PR row pushed as it is gives no PR to the PR-less row of its title the monitor deleted: PR 8, set on it since, stays
  // deleted.
  const unpromoted = boardFile({ coming: [{ title: "Lobby" }, { pr: 7, title: "Lobby" }] });
  serve(125, { needs: [], coming: [{ title: "Lobby" }, { pr: 7, title: "Lobby" }] });
  assert.equal((await run([unpromoted.file])).code, 0);
  fs.writeFileSync(unpromoted.file, JSON.stringify({ needs: [], coming: [{ pr: 7, title: "Lobby" }] }));
  serve(126, { needs: [], coming: [{ pr: 8, title: "Lobby" }, { pr: 7, title: "Lobby" }] });
  const later = seen.length;
  assert.equal((await run([unpromoted.file])).code, 0);
  assert.deepEqual(JSON.parse(boardCalls(later).at(-1)?.body ?? "").coming, [{ pr: 7, title: "Lobby" }]);
  unpromoted.done();
  // So it does with PR 7 first on the server: its own row names it, so it spends no PR-less row's allowance.
  const first = boardFile({ coming: [{ title: "Lobby" }, { pr: 7, title: "Lobby" }] });
  serve(127, { needs: [], coming: [{ title: "Lobby" }, { pr: 7, title: "Lobby" }] });
  assert.equal((await run([first.file])).code, 0);
  fs.writeFileSync(first.file, JSON.stringify({ needs: [], coming: [{ pr: 7, title: "Lobby" }] }));
  serve(128, { needs: [], coming: [{ pr: 7, title: "Lobby" }, { pr: 8, title: "Lobby" }] });
  const reversed = seen.length;
  assert.equal((await run([first.file])).code, 0);
  assert.deepEqual(JSON.parse(boardCalls(reversed).at(-1)?.body ?? "").coming, [{ pr: 7, title: "Lobby" }]);
  first.done();
});

test("a merged board that fits the 1 MB cap is sent compact, and the file stays readable", async () => {
  const MB = 1024 * 1024;
  const needs = Array.from({ length: 190 }, (_, i) => ({ id: `n${i}`, kind: "decision", title: `Card ${i}`, ask: "x".repeat(5000) }));
  const lists = { needs };
  const size = () => JSON.stringify({ updatedAt: "2026-10-01T00:00:00Z", needs: [], coming: [], chats: [], ...lists }).length;
  needs[0].ask += "x".repeat(MB - 400 - size());
  // The cards are new to the base: ones it held that the server lacks would be the server's removals.
  const b = boardFile(lists, { needs: [] });
  serve(90, { needs: [need("theirs")] });
  const from = seen.length;
  const r = await run([b.file]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "version 91\n");
  const body = boardCalls(from).at(-1)?.body ?? "";
  assert.equal(body.includes("\n"), false);
  assert.equal(JSON.stringify(JSON.parse(body), null, 2).length > MB, true);
  assert.equal(fs.statSync(b.file).size <= MB, true);
  assert.equal(b.read().needs.at(-1).id, "theirs");
  b.done();
});

test("a stale version re-reads the board and retries, keeping what raced in", async () => {
  const b = boardFile({ needs: [need("mine")] }, { needs: ["mine"] });
  serve(20, { needs: [need("mine")] });
  stub.conflicts = 1;
  const from = seen.length;
  const r = await run([b.file]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "version 22\n");
  assert.match(r.stderr, /kept 1 item\(s\) other chats added: needs:race-21/);
  assert.deepEqual(
    boardCalls(from).map((c) => `${c.method} ${c.ifMatch ?? ""}`),
    ["GET ", "PUT 20", "GET ", "PUT 21"],
  );
  b.done();
});

test("three stale versions in a row fail and leave the board file alone", async () => {
  const b = boardFile({ needs: [need("mine")] }, { needs: ["mine"] });
  const text = fs.readFileSync(b.file, "utf8");
  serve(30, { needs: [need("mine")] });
  stub.conflicts = 3;
  const from = seen.length;
  const r = await run([b.file]);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /the server board changed during each of 3 tries; nothing was pushed, push again/);
  assert.equal(boardCalls(from).filter((c) => c.method === "PUT").length, 3);
  assert.equal(fs.readFileSync(b.file, "utf8"), text);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${b.file}.pushed`, "utf8")).version, 1);
  b.done();
});

test("--if-match and --replace push the file as it is, with no read and no merge", async () => {
  const b = boardFile({ needs: [need("mine")] });
  const text = fs.readFileSync(b.file, "utf8");
  serve(40, { needs: [need("theirs")] });
  let from = seen.length;
  const pinned = await run([b.file, "--if-match", "40"]);
  assert.equal(pinned.code, 0, pinned.stderr);
  assert.deepEqual(
    boardCalls(from).map((c) => [c.method, c.ifMatch, c.body]),
    [["PUT", "40", text]],
  );
  serve(50, { needs: [need("theirs")] });
  from = seen.length;
  const replaced = await run([b.file, "--replace"]);
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.equal(replaced.stdout, "version 51\n");
  assert.deepEqual(
    boardCalls(from).map((c) => [c.method, c.ifMatch, c.body]),
    [["PUT", undefined, text]],
  );
  assert.equal(fs.readFileSync(b.file, "utf8"), text);
  const both = await run([b.file, "--replace", "--if-match", "1"]);
  assert.equal(both.code, 2);
  assert.match(both.stderr, /pick one of --if-match and --replace/);
  const stray = await run(["--replies", "--replace"]);
  assert.equal(stray.code, 2);
  assert.match(stray.stderr, /--replace only applies to a board push/);
  b.done();
});
