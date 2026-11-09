import assert from "node:assert/strict";
import { test } from "node:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MAX_SAY_IMAGES, parseArgs, readPdf, sayBody } from "../../scripts/say.mjs";

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

test("say --ack sets the status line on your message: a reply id and the words, nothing else", () => {
  assert.deepEqual(parseArgs(["--reply-to", "m1", "--ack", "building it, ~9:45"]), { images: [], replyTo: "m1", ack: "building it, ~9:45" });
  assert.deepEqual(sayBody("", "m1", [], { ack: " building it, ~9:45 " }), { replyTo: "m1", ack: "building it, ~9:45" });
  assert.throws(() => parseArgs(["--ack", "building it"]), /--reply-to/);
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
