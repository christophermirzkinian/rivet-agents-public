import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cardHoldPrs, definitiveRefusal, dropCardHold, holdForCard, isVideoCard, isYes, rekeyCardHold, releaseForYes } from "../lib/card-holds.mjs";
import { readHolds } from "../lib/holds-file.mjs";

const VIDEO = { kind: "video", after: { sha256: "a".repeat(64), type: "video/mp4" } };
const MAIN = "example-org/example-repo";
// The main repository is the first of RIVET_REPOS, read on each call.
process.env.RIVET_REPOS = `${MAIN},example-org/other-repo`;
const OTHER = { pr: 9, reason: "The owner: not yet" };

/** A holds.json in a fresh folder. @param {unknown[]} [doc] */
function holdsFile(t, doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "card-holds-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "holds.json");
  if (doc) fs.writeFileSync(file, JSON.stringify(doc));
  return file;
}

test("a video card is one with a before or after video; stills, audio and files are not", () => {
  assert.equal(isVideoCard({ media: VIDEO }), true);
  assert.equal(isVideoCard({ media: { kind: "video", before: { type: "video/webm" } } }), true);
  assert.equal(isVideoCard({ media: { kind: "stills", stills: [{ type: "image/png" }] } }), false);
  assert.equal(isVideoCard({ media: { kind: "video", after: { type: "image/jpeg" } } }), false);
  assert.equal(isVideoCard({}), false);
  assert.equal(isVideoCard({ media: null }), false);
});

test("the PRs a card holds: its main-repo PR and those its title or ask names; another repo's are not held", () => {
  assert.deepEqual(cardHoldPrs({ pr: 41 }), [41]);
  assert.deepEqual(cardHoldPrs({ pr: 41, repo: MAIN.toLowerCase() }), [41]);
  assert.deepEqual(cardHoldPrs({ title: "Menu redesign: PR #41 and pr 42", ask: "See pull request #43, PR#44. Not MPR 9 or PR #12a" }), [41, 42, 43, 44]);
  assert.deepEqual(cardHoldPrs({ pr: 7, title: "https://github.com/example-org/example-repo/pull/7 again" }), [7]);
  assert.deepEqual(cardHoldPrs({ pr: 5, repo: "example-org/other-repo", title: "PR #5" }), []);
  // A main-repo link is that repo's PR whatever the card's own repo.
  assert.deepEqual(cardHoldPrs({ pr: 5, repo: "example-org/other-repo", ask: "after https://github.com/example-org/example-repo/pull/41" }), [41]);
  assert.deepEqual(cardHoldPrs({ pr: 0, title: "PR #0" }), []);
});

test("a bare #n and example-repo#n are the main repo's PRs; another repo's #n, an HTML &#39; and one digit are not", () => {
  assert.deepEqual(cardHoldPrs({ title: "Checkout restyle (#41)" }), [41]);
  assert.deepEqual(cardHoldPrs({ ask: "PR: #41" }), [41]);
  assert.deepEqual(cardHoldPrs({ ask: "PRs #41, #42" }), [41, 42]);
  assert.deepEqual(cardHoldPrs({ ask: "PR #41 and #42" }), [41, 42]);
  assert.deepEqual(cardHoldPrs({ ask: "#41 is the one" }), [41]);
  assert.deepEqual(cardHoldPrs({ ask: "example-repo#41 and EXAMPLE-REPO#42" }), [41, 42]);
  assert.deepEqual(cardHoldPrs({ ask: "example-org/example-repo#41, EXAMPLE-ORG/Example-Repo#42" }), [41, 42]);
  assert.deepEqual(cardHoldPrs({ ask: "example-org/other-repo#5, someone/example-repo#6, x.example-repo#7, it&#39;s, a#81, path/#82, #8, #12a" }), []);
  // The main repo named in full holds whatever the card's own repo; a bare #n on another repo's card is that repo's.
  assert.deepEqual(cardHoldPrs({ repo: "example-org/other-repo", ask: "#55 after example-org/example-repo#41" }), [41]);
});

test("a card's links hold the main-repo PRs they point at; another repo's link does not", () => {
  assert.deepEqual(cardHoldPrs({ links: [{ label: "PR", url: "https://github.com/example-org/example-repo/pull/41" }] }), [41]);
  assert.deepEqual(cardHoldPrs({ repo: "example-org/other-repo", links: [{ label: "PR", url: "https://github.com/example-org/example-repo/pull/41" }] }), [41]);
  assert.deepEqual(cardHoldPrs({ links: [{ label: "PR", url: "https://github.com/example-org/other-repo/pull/5" }, { label: "x" }, null] }), []);
});

test("a new video re-stamps the card's holds; another card's stay as they were", (t) => {
  const old = { pr: 41, reason: "video card vc-1 waits", card: "vc-1", since: "2026-11-14T01:00:00.000Z" };
  const other = { pr: 41, reason: "video card vc-2 waits", card: "vc-2", since: "2026-11-14T01:00:00.000Z" };
  const file = holdsFile(t, [old, other]);
  const now = new Date("2026-11-14T05:00:00.000Z");
  assert.deepEqual(holdForCard({ id: "vc-1", pr: 41, media: VIDEO }, { file, now }), [{ pr: 41, added: false }]);
  assert.deepEqual(readHolds(file).holds, [old, other], "no restamp asked, nothing changed");
  assert.deepEqual(holdForCard({ id: "vc-1", pr: 41, media: VIDEO }, { file, now, restamp: true }), [{ pr: 41, added: false }]);
  assert.deepEqual(readHolds(file).holds, [{ ...old, since: now.toISOString(), video: VIDEO.after.sha256 }, other]);
  // A before-only video binds the hold to it (the server's videoSha), so a yes to the earlier after video keeps it.
  holdForCard({ id: "vc-1", pr: 41, media: { kind: "video", before: { sha256: "b".repeat(64), type: "video/mp4" } } }, { file, now, restamp: true });
  assert.deepEqual(readHolds(file).holds, [{ ...old, since: now.toISOString(), video: "b".repeat(64) }, other]);
});

test("rekeyCardHold moves a provisional id's holds to the card's id, once per PR", (t) => {
  const pending = { pr: 41, reason: "video card say-pending-1 waits", card: "say-pending-1", since: "2026-11-14T01:00:00.000Z" };
  const file = holdsFile(t, [OTHER, pending]);
  assert.deepEqual(rekeyCardHold("say-pending-1", "vc-1", { file }), [41]);
  assert.deepEqual(readHolds(file).holds, [
    OTHER,
    { pr: 41, reason: "video card vc-1 waits for the owner's yes; his yes on that card releases it (by hand: rivet unhold --card vc-1)", card: "vc-1", since: pending.since },
  ]);
  assert.deepEqual(rekeyCardHold("say-pending-1", "vc-1", { file }), []);
});

test("rekeyCardHold keeps the moved hold beside one another write placed under the card's id, so that write's rollback leaves it", (t) => {
  const pending = { pr: 41, reason: "video card say-pending-2 waits", card: "say-pending-2", since: "2026-11-14T01:00:00.000Z" };
  const theirs = { pr: 41, reason: "video card vc-2 waits", card: "vc-2", since: "2026-11-14T01:00:01.000Z", write: "w-b" };
  const file = holdsFile(t, [theirs, pending]);
  assert.deepEqual(rekeyCardHold("say-pending-2", "vc-2", { file }), [41]);
  assert.deepEqual(dropCardHold("vc-2", { file, prs: [41], write: "w-b" }), [41]);
  assert.deepEqual(readHolds(file).holds.map((h) => [h.pr, h.card]), [[41, "vc-2"]]);
});

test("a landed write's re-stamp records its board version, and an older write's late re-stamp changes nothing", (t) => {
  const card = (/** @type {string} */ sha) => ({ id: "vc-3", pr: 41, media: { after: { sha256: sha, type: "video/mp4" } } });
  const file = holdsFile(t, []);
  holdForCard(card("c".repeat(64)), { file, restamp: true, version: 6, now: new Date("2026-11-14T02:00:00.000Z") });
  const before = readHolds(file).holds;
  assert.deepEqual(before.map((h) => [h.video, h.version]), [["c".repeat(64), 6]]);
  assert.deepEqual(holdForCard(card("b".repeat(64)), { file, restamp: true, version: 5, now: new Date("2026-11-14T02:00:05.000Z") }), [{ pr: 41, added: false }]);
  assert.deepEqual(readHolds(file).holds, before);
});

test("a definitive refusal is a 4xx other than 408, 409 and 429", () => {
  for (const status of [400, 401, 403, 404, 412, 413, 422]) assert.equal(definitiveRefusal(status), true, String(status));
  for (const status of [408, 409, 429, 500, 502, 503, 200, NaN]) assert.equal(definitiveRefusal(status), false, String(status));
});

test("holdForCard holds each PR once per card, and nothing for a card with no video or no PR", (t) => {
  const file = holdsFile(t, [{ pr: 9, reason: "The owner: not yet" }]);
  const now = new Date("2026-11-14T03:00:00.000Z");
  assert.deepEqual(holdForCard({ id: "plain", pr: 41 }, { file, now }), []);
  assert.deepEqual(holdForCard({ id: "nopr", media: VIDEO, title: "Theme refresh" }, { file, now }), []);
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify([{ pr: 9, reason: "The owner: not yet" }]));
  assert.deepEqual(holdForCard({ id: "vc-1", pr: 41, media: VIDEO }, { file, now }), [{ pr: 41, added: true }]);
  assert.deepEqual(holdForCard({ id: "vc-1", pr: 41, media: VIDEO, title: "and PR #42" }, { file, now }), [{ pr: 41, added: false }, { pr: 42, added: true }]);
  const { holds } = readHolds(file);
  assert.deepEqual(holds.slice(1), [
    { pr: 41, reason: "video card vc-1 waits for the owner's yes; his yes on that card releases it (by hand: rivet unhold --card vc-1)", card: "vc-1", since: now.toISOString(), video: VIDEO.after.sha256 },
    { pr: 42, reason: "video card vc-1 waits for the owner's yes; his yes on that card releases it (by hand: rivet unhold --card vc-1)", card: "vc-1", since: now.toISOString(), video: VIDEO.after.sha256 },
  ]);
  assert.deepEqual(dropCardHold("vc-1", { file, prs: [42] }), [42]);
  assert.deepEqual(readHolds(file).holds.map((h) => h.pr), [9, 41]);
  assert.deepEqual(dropCardHold("vc-1", { file }), [41]);
  assert.deepEqual(readHolds(file).holds, [{ pr: 9, reason: "The owner: not yet" }]);
  assert.deepEqual(dropCardHold("vc-1", { file }), []);
});

test("a write marks the holds on its card's PRs, new and reused, and its rollback drops only those still marked", (t) => {
  const file = holdsFile(t, [OTHER]);
  const now = new Date("2026-11-14T03:00:00.000Z");
  assert.deepEqual(holdForCard({ id: "vc-1", pr: 41, media: VIDEO }, { file, now, write: "w-a" }), [{ pr: 41, added: true }]);
  assert.equal(readHolds(file).holds[1].write, "w-a");
  // Writer B reuses A's hold with no new video, and takes it; B's own new hold is B's too.
  assert.deepEqual(holdForCard({ id: "vc-1", pr: 41, title: "and #42", media: VIDEO }, { file, now, write: "w-b" }), [{ pr: 41, added: false }, { pr: 42, added: true }]);
  assert.deepEqual(readHolds(file).holds.map((h) => [h.pr, h.write]), [[9, undefined], [41, "w-b"], [42, "w-b"]]);
  assert.deepEqual(dropCardHold("vc-1", { file, prs: [41], write: "w-a" }), []);
  assert.deepEqual(dropCardHold("vc-1", { file, prs: [42], write: "w-b" }), [42]);
  assert.deepEqual(readHolds(file).holds.map((h) => h.pr), [9, 41]);
});

test("holdForCard leaves the PRs in skip as they are, even when the card has no hold on them", (t) => {
  const file = holdsFile(t, []);
  const now = new Date("2026-11-14T03:00:00.000Z");
  assert.deepEqual(holdForCard({ id: "vc-1", pr: 41, ask: "and PR #42", media: VIDEO }, { file, now, skip: [41] }), [{ pr: 42, added: true }]);
  assert.deepEqual(readHolds(file).holds.map((h) => h.pr), [42]);
});

test("a yes is approve, a choice whose whole label is one, or a merge-arming answer; Keep it held is not", () => {
  for (const choice of ["Yes, keep it", " yes ", "Yes.", "Yes!", "Yes, merge it", "Yes, ship it", "Approve", "Approved", "OK", "okay", "Ship it", "Merge it", "LGTM", "Looks good."])
    assert.equal(isYes({ decision: "choice", choice }), true, choice);
  for (const choice of ["Keep it held", "Keep it on hold", "Keep it", "Change it", "Send to the owner", "Not yet", "Yesterday's was better", "okey", "okay ship", "Yes, but slower", "Yes!!", "Hold it"])
    assert.equal(isYes({ decision: "choice", choice }), false, choice);
  assert.equal(isYes({ decision: "approve" }), true);
  assert.equal(isYes({ decision: "choice", choice: "Merge", item: { merge: true } }), true);
  for (const decision of ["reject", "comment", "done", "dismiss", "seen"]) assert.equal(isYes({ decision, choice: "Yes" }), false, decision);
});

test("his yes releases only the answered card's holds; another card's on the same PR and the monitor's stay", (t) => {
  const older = { pr: 41, reason: "video card out-old waits", card: "out-old", since: "2026-11-14T01:00:00.000Z" };
  const mine = { pr: 41, reason: "video card out-new waits", card: "out-new", since: "2026-11-14T02:00:00.000Z" };
  const newer = { pr: 41, reason: "video card out-later waits", card: "out-later", since: "2026-11-14T03:00:00.000Z" };
  const elsewhere = { pr: 8200, reason: "video card out-x waits", card: "out-x", since: "2026-11-14T00:00:00.000Z" };
  const monitor = { pr: 41, reason: "deploy order" };
  const owner = { pr: 41, reason: "The owner: hold it", app: "example-app" };
  const file = holdsFile(t, [older, mine, newer, elsewhere, monitor, owner]);
  const before = fs.readFileSync(file, "utf8");
  const at = "2026-11-14T04:00:00.000Z";
  assert.deepEqual(releaseForYes({ itemId: "out-new", at, decision: "choice", choice: "Change it" }, { file }), { released: [], kept: [] });
  assert.deepEqual(releaseForYes({ itemId: "out-new", at, decision: "choice", choice: "Keep it held" }, { file }), { released: [], kept: [] });
  assert.deepEqual(releaseForYes({ itemId: "out-none", at, decision: "approve" }, { file }), { released: [], kept: [] });
  assert.equal(fs.readFileSync(file, "utf8"), before, "nothing changed, nothing written");
  assert.deepEqual(releaseForYes({ itemId: "out-new", at, decision: "choice", choice: "Yes, keep it", item: { pr: 41 } }, { file }), {
    released: [41],
    kept: [{ pr: 41, card: "out-old" }, { pr: 41, card: "out-later" }],
  });
  assert.deepEqual(readHolds(file).holds, [older, newer, elsewhere, monitor, owner]);
  // A replay finds nothing left.
  assert.deepEqual(releaseForYes({ itemId: "out-new", at, decision: "approve", item: { pr: 41 } }, { file }), { released: [], kept: [] });
});

test("a yes given before the card's newest video, or with no time, keeps its hold", (t) => {
  const restamped = { pr: 41, reason: "video card vc-1 waits", card: "vc-1", since: "2026-11-14T05:00:00.000Z" };
  const file = holdsFile(t, [restamped]);
  const before = fs.readFileSync(file, "utf8");
  const item = { pr: 41 };
  const earlier = { released: [], kept: [{ pr: 41, card: "vc-1", why: "earlier" }] };
  assert.deepEqual(releaseForYes({ itemId: "vc-1", at: "2026-11-14T04:59:59.999Z", decision: "approve", item }, { file }), earlier);
  assert.deepEqual(releaseForYes({ itemId: "vc-1", decision: "approve", item }, { file }), earlier);
  assert.deepEqual(releaseForYes({ itemId: "vc-1", at: "not a time", decision: "approve", item }, { file }), earlier);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(releaseForYes({ itemId: "vc-1", at: restamped.since, decision: "approve", item }, { file }), { released: [41], kept: [] });
  assert.deepEqual(readHolds(file).holds, []);
});

test("his yes releases only the holds the revision he answered covers: the PRs it names and the video it showed", (t) => {
  const A = { sha256: "a".repeat(64), type: "video/mp4" };
  const B = { sha256: "b".repeat(64), type: "video/mp4" };
  const since = "2026-11-14T01:00:00.000Z";
  const onB = { pr: 41, reason: "video card vid waits", card: "vid", since, video: B.sha256 };
  const unbound = { pr: 42, reason: "video card vid waits", card: "vid", since };
  const file = holdsFile(t, [onB, unbound]);
  const at = "2026-11-14T02:00:00.000Z";
  // A yes to the old video A, whenever it is processed, keeps B's hold; an entry with no video goes by the PRs only.
  assert.deepEqual(releaseForYes({ itemId: "vid", at, decision: "approve", item: { pr: 41, title: "and #42", video: A } }, { file }), {
    released: [42],
    kept: [{ pr: 41, card: "vid", why: "video" }],
  });
  // A revision with no after video, or one that does not name the PR, keeps it too.
  assert.deepEqual(releaseForYes({ itemId: "vid", at, decision: "approve", item: { pr: 41 } }, { file }).kept, [{ pr: 41, card: "vid", why: "video" }]);
  assert.deepEqual(releaseForYes({ itemId: "vid", at, decision: "approve", item: { pr: 50, video: B } }, { file }).kept, [{ pr: 41, card: "vid", why: "unnamed" }]);
  assert.deepEqual(readHolds(file).holds, [onB]);
  assert.deepEqual(releaseForYes({ itemId: "vid", at, decision: "approve", item: { pr: 41, video: B } }, { file }), { released: [41], kept: [] });
  assert.deepEqual(readHolds(file).holds, []);
});

test("a reused card id: a yes to the revision about the new PR and video releases that PR only", (t) => {
  const file = holdsFile(t, []);
  const A = { sha256: "a".repeat(64), type: "video/mp4" };
  const B = { sha256: "b".repeat(64), type: "video/mp4" };
  holdForCard({ id: "vid", pr: 41, media: { kind: "video", after: A } }, { file, now: new Date("2026-11-14T01:00:00.000Z") });
  const now = new Date("2026-11-14T02:00:00.000Z");
  holdForCard({ id: "vid", pr: 50, media: { kind: "video", after: B } }, { file, now, restamp: true });
  assert.deepEqual(readHolds(file).holds.map((h) => [h.pr, h.video]), [[41, B.sha256], [50, B.sha256]]);
  const yes = releaseForYes({ itemId: "vid", at: "2026-11-14T03:00:00.000Z", decision: "approve", item: { pr: 50, video: B } }, { file });
  assert.deepEqual(yes, { released: [50], kept: [{ pr: 41, card: "vid", why: "unnamed" }] });
  assert.deepEqual(readHolds(file).holds.map((h) => h.pr), [41]);
});

test("a hold is bound to the whole comparison, so a yes to the old before beside the same after keeps it", (t) => {
  const file = holdsFile(t, [OTHER]);
  const [A, B, C] = ["a", "b", "c"].map((x) => x.repeat(64));
  const at = "2026-11-14T06:00:00.000Z";
  const card = (before) => ({ id: "vc-9", pr: 41, media: { kind: "video", before: { sha256: before, type: "video/mp4" }, after: { sha256: B, type: "video/mp4" } } });
  holdForCard(card(C), { file, now: new Date("2026-11-14T05:00:00.000Z") });
  assert.equal(readHolds(file).holds[1].video, `${B}+${C}`);
  const yes = (videoSha) => ({ itemId: "vc-9", at, decision: "approve", item: { pr: 41, video: { sha256: B, type: "video/mp4" }, ...(videoSha ? { videoSha } : {}) } });
  // His yes on the old comparison (before A, after B), however late, keeps the hold on the new one (before C).
  assert.deepEqual(releaseForYes(yes(`${B}+${A}`), { file }), { released: [], kept: [{ pr: 41, card: "vc-9", why: "video" }] });
  // An older server sends only the after video: it matches no comparison, so the hold stays (fails safe).
  assert.deepEqual(releaseForYes(yes(), { file }).released, []);
  assert.deepEqual(releaseForYes(yes(`${B}+${C}`), { file }).released, [41]);
  assert.deepEqual(readHolds(file).holds, [OTHER]);
});

test("a before video beside an after image binds both, so a yes to the old after image keeps the new one held", (t) => {
  const file = holdsFile(t, [OTHER]);
  const [A, B, C] = ["a", "b", "c"].map((x) => x.repeat(64));
  const card = (after) => ({ id: "vc-10", pr: 41, media: { kind: "video", before: { sha256: A, type: "video/mp4" }, after: { sha256: after, type: "image/png" } } });
  holdForCard(card(C), { file, now: new Date("2026-11-14T05:00:00.000Z") });
  assert.equal(readHolds(file).holds[1].video, `${C}+${A}`);
  const yes = (videoSha) => ({ itemId: "vc-10", at: "2026-11-14T06:00:00.000Z", decision: "approve", item: { pr: 41, videoSha } });
  assert.deepEqual(releaseForYes(yes(`${B}+${A}`), { file }).released, []);
  assert.deepEqual(releaseForYes(yes(A), { file }).released, [], "an older server's before-only key matches nothing");
  assert.deepEqual(releaseForYes(yes(`${C}+${A}`), { file }).released, [41]);
});

test("with no repo in RIVET_REPOS no card holds a PR, and the next call reads the variable again", (t) => {
  const saved = process.env.RIVET_REPOS;
  t.after(() => (process.env.RIVET_REPOS = saved));
  process.env.RIVET_REPOS = "";
  assert.deepEqual(cardHoldPrs({ pr: 41, title: "PR #42", links: [{ label: "PR", url: "https://github.com/example-org/example-repo/pull/43" }] }), []);
  process.env.RIVET_REPOS = "example-org/second-repo";
  assert.deepEqual(cardHoldPrs({ pr: 41, title: "example-repo#42 and second-repo#44" }), [41, 44]);
});
