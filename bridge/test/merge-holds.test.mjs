import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { conditionalReads } from "../lib/conditional-gh.mjs";
import { closingRefs, readMergeHolds, HOLD_LABELS } from "../lib/merge-holds.mjs";
import { redactKeepingLines } from "../lib/redact-cut.mjs";
import { showsToken, TOKEN } from "./padded-token.mjs";
import { NOTE_AFTER_YES, RECORD_LADDER, RECORD_YES } from "./decision-records.mjs";

// The linear-time guards below time CPU, not the wall clock: a loaded runner stalls a run until its CPU quota
// refills, while a quadratic or backtracking parse still costs the CPU it always did.
const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-hold-reader-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const routes = {
    "pulls/7": { number: 7, body: "", labels: [] },
    "issues/7/comments?per_page=100&page=1": [],
    "pulls/7/reviews?per_page=100&page=1": [],
    "pulls/7/comments?per_page=100&page=1": [],
    ...overrides,
  };
  const options = { repo: "o/r", pr: 7, holdsFile: path.join(dir, "fixture.json"), gh: async (args) => {
    calls.push(args);
    const value = routes[args[1].replace("repos/o/r/", "")];
    if (value instanceof Error) throw value;
    return JSON.stringify(value);
  } };
  return { options, calls };
}

test("a hold line is shown from the text redacted whole, and still holds when redaction takes it", async (t) => {
  const join = String.fromCharCode(92, 10);
  for (const body of ["password: |\n  Owner hold: hunter2", `${TOKEN.slice(0, 30)}${join}${TOKEN.slice(30)} Owner hold: wait`]) {
    for (const surface of ["pulls/7", "issues/7/comments?per_page=100&page=1"]) {
      const { options } = fixture(t, { [surface]: surface === "pulls/7" ? { number: 7, body, labels: [] } : [{ user: { login: "sam" }, body }] });
      const { holds } = await readMergeHolds({ ...options, shown: redactKeepingLines });
      const said = holds.join(" ");
      assert.ok(holds.length === 0 && !said.includes("hunter2") && !said.includes(TOKEN.slice(0, 4)) && !showsToken(said), said);
    }
  }
});

test("a hold line on any surface, from any author, holds nothing and is still read into the texts", async (t) => {
  for (const surface of ["pulls/7", "issues/7/comments?per_page=100&page=1", "pulls/7/reviews?per_page=100&page=1", "pulls/7/comments?per_page=100&page=1"]) {
    const value = surface === "pulls/7" ? { number: 7, body: "Owner hold: wait", labels: [] } : [{ user: { login: "stranger" }, body: "Owner hold: wait" }, { body: "Hold released: ship" }];
    const { options, calls } = fixture(t, { [surface]: value });
    const read = await readMergeHolds(options);
    assert.deepEqual(read.holds, []);
    assert.ok(read.texts.includes("Owner hold: wait"));
    assert.ok(calls.every((a) => !a[1].includes("/timeline")));
  }
});

test("all pages are read, issue comment order and texts order are preserved", async (t) => {
  const comments = Array.from({ length: 100 }, (_, i) => ({ body: `comment ${i}` }));
  const { options } = fixture(t, {
    "pulls/7": { number: 7, body: "body", labels: [] },
    "issues/7/comments?per_page=100&page=1": comments,
    "issues/7/comments?per_page=100&page=2": [{ body: "Hold: page two" }],
    "pulls/7/reviews?per_page=100&page=1": [{ body: "review" }],
    "pulls/7/comments?per_page=100&page=1": [{ body: "inline" }],
  });
  const read = await readMergeHolds(options);
  assert.deepEqual(read.comments, [...comments.map((c) => c.body), "Hold: page two"]);
  assert.deepEqual(read.texts, ["body", ...read.comments, "review", "inline"]);
  assert.deepEqual(read.holds, []);
});

// GitHub as `gh api -i` answers the hold reads: an ETag of each answer, a Link to the next page of a full one, and a
// 304 with no body for an If-None-Match that names the answer as it stands.
function github(routes) {
  const calls = [];
  const answers = [];
  const gh = async (args) => {
    calls.push(args);
    const route = args.at(-1).replace("repos/o/r/", "");
    const value = routes[route];
    if (value instanceof Error) throw value;
    const body = JSON.stringify(value);
    if (!args.includes("-i")) return (answers.push(`plain ${route}`), body);
    const etag = `W/"${createHash("sha1").update(body).digest("hex")}"`;
    if (args.includes(`If-None-Match: ${etag}`)) {
      answers.push(`304 ${route}`);
      throw Object.assign(new Error("gh: HTTP 304"), { stdout: `HTTP/2.0 304 Not Modified\r\nEtag: ${etag}\r\n\r\n` });
    }
    answers.push(`200 ${route}`);
    const next = Array.isArray(value) && value.length === 100 && routes[route.replace(/page=(\d+)$/, (_, n) => `page=${Number(n) + 1}`)]?.length ? 'Link: <https://api.github.com/next>; rel="next"\r\n' : "";
    return `HTTP/2.0 200 OK\r\nEtag: ${etag}\r\n${next}\r\n${body}`;
  };
  return { gh, calls, answers };
}
const SURFACES = ["pulls/7", "issues/7/comments?per_page=100&page=1", "pulls/7/reviews?per_page=100&page=1", "pulls/7/comments?per_page=100&page=1"];

test("a read through conditionalReads sends each surface's ETag again, and a 304 on all four reads as the first did", async (t) => {
  const { options } = fixture(t);
  const routes = { "pulls/7": { number: 7, body: "body", labels: [{ name: "on-hold" }], draft: true }, [SURFACES[1]]: [{ body: "a comment" }], [SURFACES[2]]: [{ body: "a review" }], [SURFACES[3]]: [{ body: "inline" }] };
  const api = github(routes);
  const reads = { ...options, forMerge: false, gh: conditionalReads(api.gh, new Map()) };
  const first = await readMergeHolds(reads);
  assert.deepEqual(api.calls, SURFACES.map((route) => ["api", "-i", `repos/o/r/${route}`]));
  const sent = api.calls.length;
  const second = await readMergeHolds(reads);
  assert.deepEqual(api.answers.slice(sent), SURFACES.map((route) => `304 ${route}`));
  assert.ok(api.calls.slice(sent).every((args) => args[2] === "-H" && /^If-None-Match: W\/"[0-9a-f]+"$/.test(args[3])));
  assert.deepEqual(second, first);
  assert.deepEqual([second.holds, second.texts, second.view.draft], [["label on-hold"], ["body", "a comment", "a review", "inline"], true]);
  // A read with the reader's own gh is the plain one: no ETag, and the same answer.
  const plain = github(routes);
  assert.deepEqual(await readMergeHolds({ ...options, forMerge: false, gh: plain.gh }), first);
  assert.deepEqual(plain.calls, SURFACES.map((route) => ["api", `repos/o/r/${route}`]));
});

test("a changed surface answers 200 and replaces what was kept: a new label holds on the next read, and its removal frees it", async (t) => {
  const { options } = fixture(t);
  const routes = { "pulls/7": { number: 7, body: "", labels: [] }, [SURFACES[1]]: [], [SURFACES[2]]: [], [SURFACES[3]]: [] };
  const api = github(routes);
  const reads = { ...options, forMerge: false, gh: conditionalReads(api.gh, new Map()) };
  assert.deepEqual((await readMergeHolds(reads)).holds, []);
  routes["pulls/7"] = { number: 7, body: "", labels: [{ name: "do-not-merge" }] };
  routes[SURFACES[1]] = [{ body: "a new comment" }];
  api.answers.length = 0;
  const held = await readMergeHolds(reads);
  assert.deepEqual(api.answers, ["200 pulls/7", `200 ${SURFACES[1]}`, `304 ${SURFACES[2]}`, `304 ${SURFACES[3]}`]);
  assert.deepEqual([held.holds, held.comments], [["label do-not-merge"], ["a new comment"]]);
  api.answers.length = 0;
  assert.deepEqual((await readMergeHolds(reads)).holds, ["label do-not-merge"]);
  assert.deepEqual(api.answers, SURFACES.map((route) => `304 ${route}`));
  routes["pulls/7"] = { number: 7, body: "", labels: [] };
  assert.deepEqual((await readMergeHolds(reads)).holds, []);
  // holds.json is read from the file each time, whatever GitHub answers.
  fs.writeFileSync(options.holdsFile, JSON.stringify([{ pr: 7, reason: "owner review" }]));
  api.answers.length = 0;
  assert.deepEqual((await readMergeHolds(reads)).holds, ["holds file: owner review"]);
  assert.deepEqual(api.answers, SURFACES.map((route) => `304 ${route}`));
});

test("a list of more than one page is never kept: page 1 answers 200 each read and later pages are read plainly", async (t) => {
  const { options } = fixture(t);
  const full = Array.from({ length: 100 }, (_, i) => ({ body: `comment ${i}` }));
  const routes = { "pulls/7": { number: 7, body: "", labels: [] }, [SURFACES[1]]: full, "issues/7/comments?per_page=100&page=2": [{ body: "page two" }], [SURFACES[2]]: [], [SURFACES[3]]: [] };
  const api = github(routes);
  const store = new Map();
  const reads = { ...options, forMerge: false, gh: conditionalReads(api.gh, store) };
  const expected = ["200 pulls/7", `200 ${SURFACES[1]}`, "plain issues/7/comments?per_page=100&page=2", `200 ${SURFACES[2]}`, `200 ${SURFACES[3]}`];
  assert.equal((await readMergeHolds(reads)).comments.length, 101);
  assert.deepEqual(api.answers, expected);
  assert.ok(!store.has(`repos/o/r/${SURFACES[1]}`));
  routes["issues/7/comments?per_page=100&page=2"] = [{ body: "page two" }, { body: "a later comment" }];
  api.answers.length = 0;
  assert.equal((await readMergeHolds(reads)).comments.at(-1), "a later comment");
  assert.deepEqual(api.answers, [`304 pulls/7`, expected[1], expected[2], `304 ${SURFACES[2]}`, `304 ${SURFACES[3]}`]);
  // A one-page list that grows past the page loses what was kept of it.
  const grown = { ...routes, [SURFACES[2]]: [{ body: "review" }] };
  const kept = new Map();
  const growing = { ...options, forMerge: false, gh: conditionalReads(github(grown).gh, kept) };
  await readMergeHolds(growing);
  assert.ok(kept.has(`repos/o/r/${SURFACES[2]}`));
  grown[SURFACES[2]] = Array.from({ length: 100 }, () => ({ body: "review" }));
  grown["pulls/7/reviews?per_page=100&page=2"] = [{ body: "review 101" }];
  assert.ok((await readMergeHolds(growing)).texts.includes("review 101"));
  assert.ok(!kept.has(`repos/o/r/${SURFACES[2]}`));
});

test("a failed or malformed answer through conditionalReads fails closed, and a 304 with nothing kept is no answer", async (t) => {
  for (const surface of SURFACES) {
    for (const bad of [new Error("HTTP 503"), {}, null, [{ body: 1 }]]) {
      const { options } = fixture(t);
      const routes = { "pulls/7": { number: 7, body: "", labels: [] }, [SURFACES[1]]: [], [SURFACES[2]]: [], [SURFACES[3]]: [], [surface]: bad };
      await assert.rejects(readMergeHolds({ ...options, forMerge: false, gh: conditionalReads(github(routes).gh, new Map()) }));
    }
  }
  const { options } = fixture(t);
  const lost = async () => { throw Object.assign(new Error("gh: HTTP 304"), { stdout: "HTTP/2.0 304 Not Modified\r\n\r\n" }); };
  await assert.rejects(readMergeHolds({ ...options, forMerge: false, gh: conditionalReads(lost, new Map()) }), /HTTP 304/);
});

test("API errors and malformed responses fail closed on every surface", async (t) => {
  for (const surface of ["pulls/7", "issues/7/comments?per_page=100&page=1", "pulls/7/reviews?per_page=100&page=1", "pulls/7/comments?per_page=100&page=1"]) {
    for (const bad of [new Error("HTTP 503"), {}, null, [{ body: 1 }], [{ text: "missing body" }]]) {
      await assert.rejects(readMergeHolds(fixture(t, { [surface]: bad }).options));
    }
  }
  for (const body of [undefined, 1]) await assert.rejects(readMergeHolds(fixture(t, { "pulls/7": { number: 7, body, labels: [] } }).options));
  const { options } = fixture(t);
  await assert.rejects(readMergeHolds({ ...options, gh: async () => "{truncated" }));
});

test("null body is a legitimate empty GitHub body", async (t) => {
  const { options } = fixture(t, { "pulls/7": { number: 7, body: null, labels: [] }, "pulls/7/reviews?per_page=100&page=1": [{ body: null }] });
  assert.deepEqual((await readMergeHolds(options)).holds, []);
});

test("pagination bound fails closed instead of accepting a truncated list", async (t) => {
  const overrides = {};
  for (let page = 1; page <= 20; page++) overrides[`issues/7/comments?per_page=100&page=${page}`] = Array.from({ length: 100 }, () => ({ body: "fine" }));
  await assert.rejects(readMergeHolds(fixture(t, overrides).options), /pagination exhausted/);
});

test("local fixture holds and malformed local data fail closed", async (t) => {
  const { options } = fixture(t);
  fs.writeFileSync(options.holdsFile, JSON.stringify([{ pr: 7, reason: "owner review" }]));
  assert.match((await readMergeHolds(options)).holds.join(" "), /owner review/);
  fs.writeFileSync(options.holdsFile, "bad JSON");
  assert.match((await readMergeHolds(options)).holds.join(" "), /not valid JSON/);
});

test("The decision records and the note after them hold nothing; a label, holds.json or a hold comment still holds", async (t) => {
  const settled = [RECORD_YES, NOTE_AFTER_YES, RECORD_LADDER].map((body) => ({ user: { login: "example-owner" }, body }));
  const { options } = fixture(t, { "issues/7/comments?per_page=100&page=1": settled });
  assert.deepEqual((await readMergeHolds(options)).holds, []);
  assert.deepEqual((await readMergeHolds({ ...options, shown: redactKeepingLines })).holds, []);
  const labelled = fixture(t, { "pulls/7": { number: 7, body: "", labels: [{ name: "do-not-merge" }] }, "issues/7/comments?per_page=100&page=1": settled });
  assert.deepEqual((await readMergeHolds(labelled.options)).holds, ["label do-not-merge"]);
  fs.writeFileSync(options.holdsFile, JSON.stringify([{ pr: 7, reason: "owner review" }]));
  assert.match((await readMergeHolds(options)).holds.join(" "), /owner review/);
  const later = fixture(t, { "issues/7/comments?per_page=100&page=1": [...settled, { user: { login: "sam" }, body: "Hold until the owner signs off." }] });
  assert.deepEqual((await readMergeHolds(later.options)).holds, []);
});

// #505: GitHub closes what a closing keyword in the squash text names, an open pull request included.
test("closingRefs reads every closing keyword form, with the repository it names, and no prose number", () => {
  const refs = closingRefs([
    "fix #1, Fixes: #2 and RESOLVED  GH-3",
    "closes o/other.repo#4; fixed https://github.com/a/b/pull/5 and resolves github.com/a/b/issues/6",
    "a hotfix #7 is still read; Fixes o/.github#8 and fix :  https://github.com/o/.github/issues/9",
    "fixed in #10, #11 fixes it, fix #12abc, Fix (#13), closes #14th, fixes o/..#15, fixes o/.#16",
  ], "o/r");
  assert.deepEqual(refs.map((r) => [r.phrase, r.repo, r.number]), [
    ["fix #1", "o/r", 1], ["Fixes: #2", "o/r", 2], ["RESOLVED GH-3", "o/r", 3],
    ["closes o/other.repo#4", "o/other.repo", 4], ["fixed https://github.com/a/b/pull/5", "a/b", 5], ["resolves github.com/a/b/issues/6", "a/b", 6],
    ["fix #7", "o/r", 7], ["Fixes o/.github#8", "o/.github", 8], ["fix : https://github.com/o/.github/issues/9", "o/.github", 9],
  ]);
});

test("closingRefs reads a long run of spaces in linear time", () => {
  const started = cpuMs();
  assert.deepEqual(closingRefs(Array.from({ length: 100 }, () => `fix${" ".repeat(60_000)}x`), "o/r"), []);
  // The quadratic form took about 10 s per text here.
  assert.ok(cpuMs() - started < 2_000, `${cpuMs() - started} ms`);
});

const open = { number: 7, title: "t", commits: 1, body: "", labels: [], state: "open", head: { sha: "a".repeat(40) } };
const row = (sha = "b".repeat(40), message = "m") => ({ sha, commit: { message } });

test("an open PR's commit list is read whole, to its head and its count, or the read refuses", async (t) => {
  const full = Array.from({ length: 100 }, () => row());
  const { options, calls } = fixture(t, { "pulls/7": { ...open, commits: 201 }, "pulls/7/commits?per_page=100&page=1": full,
    "pulls/7/commits?per_page=100&page=2": full, "pulls/7/commits?per_page=100&page=3": [row("a".repeat(40))] });
  const read = await readMergeHolds(options);
  assert.deepEqual([read.holds, read.closing, read.squashTitle], [[], [], "t (#7)"]);
  assert.equal(calls.filter((a) => a[1].includes("/commits?")).length, 3);
  await assert.rejects(readMergeHolds(fixture(t, { "pulls/7": { ...open, commits: 251 } }).options), /251 commits; GitHub lists 250/);
  for (const [commits, rows, error] of [[2, [row("a".repeat(40))], /has 1 of the PR's 2 commits/], [1, [row()], /does not reach the head/],
    [1, [], /has 0 of the PR's 1 commits/], [undefined, [row("a".repeat(40))], /malformed commit count/]]) {
    await assert.rejects(readMergeHolds(fixture(t, { "pulls/7": { ...open, commits }, "pulls/7/commits?per_page=100&page=1": rows }).options), error);
  }
  // One commit squashes under its own subject; more under the PR's title.
  const one = fixture(t, { "pulls/7": open, "pulls/7/commits?per_page=100&page=1": [row("a".repeat(40), "Own subject\n\nbody")] });
  assert.equal((await readMergeHolds(one.options)).squashTitle, "Own subject (#7)");
  // A closed or merged PR closes nothing more: its squash is not read.
  const closed = fixture(t, { "pulls/7": { ...open, state: "closed" } });
  assert.deepEqual([(await readMergeHolds(closed.options)).closing, (await readMergeHolds(closed.options)).squashTitle], [[], null]);
  assert.ok(closed.calls.every((a) => !a[1].includes("/commits?")));
});

test("a read that is not for a merge skips the closing references, so a commit count over GitHub's list still reads", async (t) => {
  const { options, calls } = fixture(t, { "pulls/7": { ...open, commits: 251, body: "fixes #12" } });
  const read = await readMergeHolds({ ...options, forMerge: false });
  assert.deepEqual([read.holds, read.closing, read.squashTitle], [[], [], null]);
  assert.ok(calls.every((a) => !a[1].includes("/commits?") && !a[1].includes("issues/12")));
  await assert.rejects(readMergeHolds(options), /251 commits; GitHub lists 250/);
});

test("a closing refusal is kept apart from the holds, and its phrase is shown as the text redacted whole shows it", async (t) => {
  const targets = { "issues/484": { number: 484, state: "open", pull_request: {} }, "issues/12": { number: 12, state: "open" } };
  const plain = fixture(t, { "pulls/7": { ...open, body: "Goes before the fix #484; fixes #12" }, "pulls/7/commits?per_page=100&page=1": [row("a".repeat(40))], ...targets });
  const read = await readMergeHolds({ ...plain.options, shown: redactKeepingLines });
  assert.deepEqual(read.holds, []);
  assert.deepEqual(read.closing.map((c) => c.split(",")[0]), ['closing keyword "fix #484" names open pull request #484']);
  // A password that reads as a closing keyword still refuses, and is never shown.
  const secret = fixture(t, { "pulls/7": { ...open, body: "password: |\n  fix #484" }, "pulls/7/commits?per_page=100&page=1": [row("a".repeat(40))], ...targets });
  const hidden = await readMergeHolds({ ...secret.options, shown: redactKeepingLines });
  assert.equal(hidden.closing.length, 1);
  assert.equal(hidden.closing[0], "a closing keyword redacted here names an issue or pull request, which GitHub would close at the squash; reword it");
  // Nor is the repository or number it names: it refuses unread, so no read's error can carry them either.
  const named = fixture(t, { "pulls/7": { ...open, body: "password: |\n  fixes o/hunter2#9\n  fixes #12" }, "pulls/7/commits?per_page=100&page=1": [row("a".repeat(40))], ...targets });
  const quiet = await readMergeHolds({ ...named.options, shown: redactKeepingLines });
  assert.deepEqual(quiet.closing, [hidden.closing[0]]);
  assert.ok(!named.calls.some((a) => a[1].includes("hunter2") || a[1].endsWith("issues/12")), "no lookup of a hidden target");
  // Shown elsewhere in another case, it is read as it is shown.
  const cased = fixture(t, { "pulls/7": { ...open, body: "password: |\n  fixes o/Hunter2#9" }, "pulls/7/commits?per_page=100&page=1": [row("a".repeat(40), "m\n\nfixes o/hunter2#9")],
    "repos/o/hunter2/issues/9": { number: 9, state: "open", pull_request: {} } });
  assert.equal((await readMergeHolds({ ...cased.options, shown: redactKeepingLines })).closing.length, 1);
  assert.ok(!cased.calls.some((a) => a[1].includes("Hunter2")), "the hidden spelling is never read");
});
