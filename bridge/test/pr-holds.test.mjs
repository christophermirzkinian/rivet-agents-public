import assert from "node:assert/strict";
import test from "node:test";
import { allHolds, currentTexts, holdLine, holdLines, isRelease, isVideoWaitLine, prHold, videoWaitOnly } from "../lib/pr-holds.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileHolds } from "../lib/holds-file.mjs";
import { NOTE_AFTER_YES, RECORD_LADDER, RECORD_YES } from "./decision-records.mjs";

const OWNER = ["example-owner"];
const owner = (body) => ({ login: "example-owner", body });

/**
 * Asserts that a parse stays linear on a large input: at 8 times the size it costs well under the 64 times a quadratic
 * pass or a backtracking regex costs. Each size's best of five runs is read in CPU time, not wall-clock time, so a
 * loaded runner that stalls a run does not fail it, and a reading over the bound is taken again, up to three times
 *.
 * @param {(text: string) => unknown} parse @param {(k: number) => string} input the input at k times its smallest size
 */
function assertLinear(parse, input) {
  const cpu = () => {
    const { user, system } = process.cpuUsage();
    return user + system;
  };
  const sizes = [input(1), input(8)];
  let growth = Infinity;
  const linear = () => {
    const best = [Infinity, Infinity];
    for (let run = 0; run < 5; run += 1) {
      for (const [i, text] of sizes.entries()) {
        const started = cpu();
        parse(text);
        best[i] = Math.min(best[i], cpu() - started);
      }
    }
    growth = best[1] / best[0];
    return growth < 32;
  };
  assert.ok([0, 1, 2].some(linear), `${sizes[1].slice(0, 8)}… costs ${growth.toFixed(1)} times as much at 8 times the size`);
}

test("explicit approval conditions survive Markdown line wrapping", () => {
  const words = "The decision holds: merge only after the owner approves.".split(" ");
  const wrapped = words.slice(1).map((_, index) => `${words.slice(0, index + 1).join(" ")}\n${words.slice(index + 1).join(" ")}`);
  wrapped.push(words.join("\n"));
  wrapped.push("Merge only after\nthe owner approves.", "Merge only after the owner\napproves.");
  for (const body of wrapped.flatMap(text => [text, ...["> ", "> > "].map(prefix => text.split("\n").map(line => `${prefix}${line}`).join("\n"))])) {
    assert.ok(holdLine(body), body);
    assert.ok(holdLines([body]), body);
    assert.equal(prHold({ body, comments: [] }, OWNER)?.where, "body", body);
    assert.equal(prHold({ body: "", comments: [owner(body)] }, OWNER)?.where, "comment", body);
  }
  assert.equal(holdLine("The decision holds: the established\nbehavior remains."), null);
  assert.equal(holdLine("> The decision holds: the established\n> behavior remains."), null);
});

test("the checkpoint line \"Owner holds: none (…)\" is no hold; an aside that conditions it still holds", () => {
  for (const body of ["- Owner holds: none (the owner approved the plan)", "- **Owner holds:** none (the owner OKed it)", "Owner holds: none (the owner approved the plan).", "- Owner holds: none (the owner has signed off on the video)"]) {
    assert.equal(holdLine(body), null, body);
    assert.equal(holdLines([body]), null, body);
    assert.equal(prHold({ body, comments: [] }, OWNER), null, body);
  }
  for (const body of [
    "- Owner holds: none (until the owner approves)",
    "- Owner holds: none (the owner hasn't seen it)",
    "- Owner holds: none (only after the owner signs off)",
    "- Owner holds: none (the owner approved the plan); do not merge until #650 lands",
    "Owner holds: none (the owner says: Hold: security review required)",
    "- Holds: none (Owner hold: the owner must playtest the build)",
    "- Owner holds: none (on condition the owner approves)",
    "Owner holds: none (the owner says: stop this PR)",
    "Owner holds: none (the owner: this PR remains blocked)",
    "- Owner holds: none (see the thread)",
    "Owner holds: none (the owner vetoed this PR; previous approval is void)",
    "Owner holds: none (the owner approved pausing this PR)",
    "Owner holds: none (the owner revoked approval)",
  ]) {
    assert.equal(holdLine(body), body, body);
    assert.equal(holdLines([body]), body, body);
  }
});

test("plural hold labels remain distinct from the verb in prose", () => {
  for (const body of [
    "The 2026-10-08 decision holds: the established behavior remains.",
    "The invariant holds: every request has one outcome.",
    "[Holds: none]",
    "[Owner holds: none].",
  ]) {
    assert.equal(holdLine(body), null, body);
    assert.equal(holdLines([body]), null, body);
    assert.equal(prHold({ body, comments: [] }, OWNER), null, body);
    assert.equal(prHold({ body: "", comments: [owner(body)] }, OWNER), null, body);
  }
  for (const body of [
    "Holds: waiting for the video.",
    "Checkpoint; holds: waiting for the video.",
    "Remaining holds: dependency #123 pending.",
    "External dependency holds: ticket #123 pending.",
    "| Holds | Waiting for ticket #123 |",
    "| Holds | Awaiting the owner approval |",
    "| Status | Holds: waiting for the video |",
    "Checkpoint (Holds: waiting for the video)",
    "[Holds: waiting for the video]",
    "The owner holds: waiting for the video.",
    "The decision holds: unchanged. Owner hold: waiting for the video.",
    "The decision holds: merge only after the owner approves.",
    "The 2026-10-08 decision holds: merge only after the owner approves.",
    "The 2026-10-08 decision holds: unchanged. Remaining holds: ticket #123 pending.",
    "[Holds: none] Owner hold: waiting for the video.",
    "[Owner holds: none]*.",
  ]) {
    assert.equal(holdLine(body), body, body);
    assert.equal(holdLines([body]), body, body);
    assert.deepEqual(prHold({ body: "", comments: [owner(body)] }, OWNER), { where: "comment", line: body });
  }
  const qualified = "[Owner holds: none]*.\n\n* Only after the owner approves.";
  assert.equal(holdLine(qualified), "[Owner holds: none]*.");
  assert.equal(holdLines([qualified]), "[Owner holds: none]*.");
  assert.deepEqual(prHold({ body: qualified, comments: [] }, OWNER), { where: "body", line: "[Owner holds: none]*." });
});

test("explicit blocked-PR comments override contradictory no-hold status", () => {
  for (const [body, line] of [
    ["This PR must remain blocked; the following status is false. No owner hold.", "This PR must remain blocked; the following status is false. No owner hold."],
    ["No owner hold.\n(Only after the owner approves; until then this PR remains blocked.)", "(Only after the owner approves; until then this PR remains blocked.)"],
  ]) {
    assert.equal(holdLine(body), line);
    assert.equal(holdLines([body]), line, "the second reading uses the same parser");
    assert.deepEqual(prHold({ body: "", comments: [owner(body)] }, OWNER), { where: "comment", line });
  }
  for (const body of [
    "This PR must not remain blocked. No owner hold.",
    "This PR does not remain blocked. No owner hold.",
    "This PR is no longer blocked. No owner hold.",
    "Hold released: this PR no longer remains blocked.",
  ]) {
    assert.equal(holdLine(body), null, body);
    assert.equal(holdLines([body]), null, body);
    assert.equal(prHold({ body: "", comments: [owner(body)] }, OWNER), null, body);
  }
});

test("hold lines anywhere in a text, in the forms agents and the monitor write", () => {
  for (const line of [
    "hold",
    "Hold — waiting on the owner",
    "On hold until Monday",
    "do not merge yet",
    "**Owner hold:** waiting on the video",
    "**Owner hold: do not merge before the owner's OK on the stills.**",
    "- Merge hold from the monitor until #379 lands.",
    "- Hold: merge waits for #379",
    "- Owner hold, from the monitor: ask before any site deploy.",
    "Checkpoint (round 2, head 98e0881b6). Hold: merge waits for #379, then merge main.",
    "Checkpoint: PR #375, head 13df31a. Holds: no merge before the owner's OK on the stills",
    "Owner holds: waiting for the owner to approve the video.",
    "- Merge\thold from the monitor until #379 lands.",
    "- Merge\u00a0hold from the monitor until #379 lands.",
    "Hold: video approval pending; no deploy hold.",
    "No deploy hold; owner hold: waiting for the owner.",
    "Hold: none of this should merge until the owner approves.",
    "Holds: none, but do not merge before the video",
    "Hold: **none** of this should merge until the owner approves.",
    "Hold: none approved yet; wait for the owner to sign off.",
    "_Hold_ until the owner approves the video.",
    "Don\u2019t merge until the owner approves the video.",
    "Checkpoint: head abc; holds: waiting for the owner to approve the video.",
    "#379 merged; hold until the owner approves the video.",
    "No owner hold may be released until the owner approves the video.",
    "Dependency landed, hold until the owner approves the video.",
    "- [ ] Hold until the owner approves the video.",
    "**Owner holds** \u2014 waiting for the owner to approve the video.",
    "**Owner holds** - waiting for the owner to approve the video.",
    "**Owner** hold \u2014 waiting for the owner to approve the video.",
    "No owner hold, including this PR\u2019s, may be released until the owner approves the video.",
    "+ Hold until the owner approves the video.",
    "1) Hold until the owner approves the video.",
    "Hold released \u2014 but hold until the video is in.",
    "On **hold** until the owner approves the video.",
    "#379 merged; but **hold** until the owner approves the video.",
    "No owner holds may be released until the owner approves the video.",
    "PR #384 is on hold until the owner approves the video.",
    "#379 merged; please hold until the owner approves the video.",
    "Do **not** merge until the owner approves the video.",
    "No owner hold, even if CI is green, may be released until the owner approves the video.",
    "Dependency landed, but please hold for the owner to approve the video.",
    "Dependency landed; but still hold for the owner's video approval.",
    "## Owner holds",
    "## Holds",
    "Hold released only after the owner approves the video; approval is still pending.",
    "Status: `hold` \u2014 waiting for the owner to approve the video.",
    "We should hold: the owner has not approved the video yet.",
    "We should hold this PR until the owner approves the video.",
    "We should hold the merge until the owner approves the video.",
    "| Owner holds | Video approval pending |",
    "Hold released upon video approval; approval is still pending.",
    "No merge until the owner OKs the new video and stills.",
    "320x693, with paths below. **Waiting on the owner's OK before merge.**",
    "- the owner: Ship (Rivet card report-bigger-3, 2026-10-02). Merges in its main-hold turn.",
    "- Next: incremental review of 792e51d, evidence with the owner's words, the gate, then merge on his OK.",
    "Round 2 dispositioned in the evidence comment, deferred #352. Waiting only on the merge-order hold below.",
    "Merges on the queue owner's word.",
    "- Merge only on the monitor's word.",
    "- Remaining: local checks, evidence comment, gate, merge on the monitor's word (confirmed after #329).",
    "draft until then; no merge or deploy",
    "`split-report` (merge held until #379 lands).",
    "The owner chose \"Yes, go\". Merging waits on the round-1 review fixes and the deploy-hold check.",
    "- local-branch-one, local commit c977226dc, not pushed): held until #378 merges, per the brief.",
    "**the owner OKed the stills on 2026-10-02 (Rivet card town-desks). The merge waits on the main hold.**",
    "> Don't merge this one",
    "- Stills at 412\u00d7915 go to the owner's board first. Nothing merges before his OK.",
  ]) {
    assert.equal(holdLine(`Checkpoint\n\n${line}\nmore`), line.trim(), line);
    assert.equal(holdLine(`Checkpoint\r${line}\r\nmore`), line.trim(), `${line} (CR line endings)`);
  }
});

test("lines that are not holds", () => {
  for (const line of [
    "Holding off is fine by me",
    "Owner holds: none",
    "- Holds: none on this PR.",
    "Owner holds: none, untriaged findings: none, open threads: 0.",
    "Coverage thresholds: 100%; unit tests passed.",
    "Android QA: App info instructions (press and hold) verified; screenshots attached.",
    "Round 3: no findings. No untriaged findings, no owner hold, no open threads.",
    "Checkpoint: no owner hold, all findings triaged.",
    "No owner holds. Untriaged findings: none yet. Open threads: none. Deploy after merge waits for the monitor's go.",
    "Owner holds: none \u2014 all findings triaged.",
    "| Owner holds | none |",
    "The following invariants must hold:",
    "No owner hold, but CI is still running.",
    "  - PLACE is held until a re-read adopts the round, with a bounded backoff.",
    "- Hold check: `hold-safe.mjs 3769` from an origin/main checkout (4b2102a0+) \u2014 SAFE, rc=0.",
    "It moves a container on its CPUs only if all of these hold:",
    "- `dispatch` feeds `LostPlacement.hold`; dropping `lostPlacement.hold(...)` fails a test.",
    "The owner chose \"Merci\" on the stills at 412. Hold released; merge follows the three-lens gate.",
    "No owner holds; hold-safe SAFE. Untriaged findings: none.",
    "Hold-safe: exit 0 (no fingerprint path).",
    "**Owner hold:** none",
    "- Hold: none.",
    "No owner holds.",
    "There is no hold on this PR.",
    "Owner holds, untriaged findings and open threads go on the PR.",
  ]) {
    assert.equal(holdLine(line), null, line);
  }
});

test("a footnote mark keeps a 'no hold' a hold; paired emphasis does not", () => {
  for (const held of [
    "No owner hold*.\n\n* Only after the owner approves.",
    "No owner hold*",
    "No hold**.",
    "Holds: none*.",
    "No owner hold*. See *the notes*.",
    "No owner holds*.",
    "\\*No owner hold*.\n\n* Only after the owner approves.",
    "`*No owner hold`*.\n\n* Only after the owner approves.",
    "`*`No owner hold*.\n\n* Only after the owner approves.",
    "\\` `*No owner hold` `*.\n\n* Only after the owner approves.",
    "Owner hold: none, only after the owner approves.",
    "No owner hold, pending the video.",
    "No owner hold, regardless of CI, may be released until the owner approves.",
    "Owner hold: none, only\nafter the owner approves the video.",
    "No owner hold\u2014without exception\u2014may be released until the owner approves.",
  ]) assert.ok(holdLine(held), held);
  for (const free of ["**No owner hold**.", "*No owner hold.*", "No **owner hold**.", "`No owner hold`.", "**Holds:** none.", "**No _owner hold_.**", "## Holds\n\n* None.", "*No **owner hold***.", "**No *owner hold***.", "No owner hold, only CI remains.", "No owner hold \u2014 all findings triaged."]) assert.equal(holdLine(free), null, free);
  // Marks pair in linear time.
  for (const long of [(k) => "*".repeat(7_500 * k) + "x", (k) => "*a ".repeat(2_500 * k), (k) => "*_`".repeat(3_750 * k)]) assertLinear(holdLine, long);
  assert.deepEqual(prHold({ body: "Checks green. No owner hold*.\n\n* Only after the owner approves.", comments: [] }, OWNER), { where: "body", line: "Checks green. No owner hold*." });
  assert.ok(holdLine("Do **not** merge") && holdLine("Don\u2019t merge"));
});

test("a holds heading over None is not a hold", () => {
  assert.equal(holdLine("## Owner holds\n\nNone."), null);
  assert.equal(holdLine("## Holds\n- Owner hold: the video"), "## Holds");
});

test("only an owner comment that opens with a release line is a release", () => {
  for (const text of ["Unhold", "Hold released", "Hold released.", "Unhold - #379 merged", "Hold released: the owner chose Ship it", "- **Release hold** — the owner OK'd the stills", "Lift the hold"]) {
    assert.equal(isRelease(text), true, text);
  }
  for (const text of [
    "Hold released? No, keep waiting.",
    "Released hold on #379.",
    "Hold released on #379",
    "That releases the owner hold.",
    "Owner hold released: the owner chose Ship it",
    "Checkpoint.\nHold released",
    "release hold, go",
    "> Hold released\nThat is an example for later; keep waiting.",
    "    Unhold\n\nExample syntax only; still awaiting approval.",
    "\nHold released\nExample only; keep waiting.",
    "-     Unhold\n\n  Example syntax only; still awaiting approval.",
    "Unhold-related documentation is still a draft.",
  ]) {
    assert.equal(isRelease(text), false, text);
  }
});

test("a PR's hold: body first, then the newest unreleased owner comment hold", () => {
  assert.deepEqual(prHold({ body: "Summary\n**Owner hold:** waiting on the video", comments: [] }, OWNER), {
    where: "body",
    line: "**Owner hold:** waiting on the video",
  });
  assert.equal(prHold({ body: "", comments: [{ login: "someone-else", body: "do not merge" }] }, OWNER), null);
  const held = { body: "", comments: [owner("Checkpoint.\n- Hold: merge waits for #379")] };
  assert.deepEqual(prHold(held, OWNER), { where: "comment", line: "- Hold: merge waits for #379" });
  assert.deepEqual(prHold({ ...held, comments: [...held.comments, owner("Round 2 is clean.")] }, OWNER)?.line, "- Hold: merge waits for #379");
  assert.equal(prHold({ ...held, comments: [...held.comments, owner("Hold released: #379 merged")] }, OWNER), null);
  assert.equal(prHold({ ...held, comments: [...held.comments, { login: "someone-else", body: "Unhold" }] }, OWNER)?.line, "- Hold: merge waits for #379");
  const rehold = prHold({ ...held, comments: [...held.comments, owner("Hold released\n\n**Owner hold:** a new one")] }, OWNER);
  assert.equal(rehold?.line, "**Owner hold:** a new one", "a release clears only the holds before it");
  assert.equal(prHold({ body: "- Owner hold: stills", comments: [owner("Unhold")] }, OWNER)?.where, "body", "a body hold ends only when it is edited out");
  const sameLine = prHold({ ...held, comments: [...held.comments, owner("Hold released: dependency landed; **Owner hold:** video approval pending.")] }, OWNER);
  assert.equal(sameLine?.line, "Hold released: dependency landed; **Owner hold:** video approval pending.", "a hold on the release line itself still counts");
  const bare = prHold({ ...held, comments: [...held.comments, owner("Hold released: #379 merged; hold until the owner approves the video.")] }, OWNER);
  assert.equal(bare?.line, "Hold released: #379 merged; hold until the owner approves the video.");
});

test("a long comment parses in linear time", () => {
  const parse = (text) => [isRelease(text), holdLine(text)];
  for (const text of [(k) => "Unhold" + " ".repeat(7_500 * k) + "x", (k) => "Hold:" + " ".repeat(7_500 * k) + "x", (k) => ": " + " ".repeat(7_500 * k) + "x", (k) => "hold" + "_".repeat(7_500 * k), (k) => "1.".repeat(3_750 * k) + "x", (k) => "- ".repeat(3_750 * k) + "x", (k) => "Owner holds: none," + " ".repeat(7_500 * k) + "x", (k) => "Hold" + " ".repeat(7_500 * k) + "x", (k) => "## Owner holds\nNone" + " ".repeat(7_500 * k) + "x", (k) => "## Holds\nNone.\n\n".repeat(500 * k)]) assertLinear(parse, text);
});

test("text that only names a hold is not one: a decision record's question, a quoted hold a release lifts, a file name", () => {
  const record = (fields, after = "") => `**Owner decision (via Rivet): CHOSE: Ship**\nItem: \`ship-1\` — Ship it?\n${fields}\nCard revision: \`abc\`\n\n${after}Verify: node ~/.rivet-agents/app/scripts/push-board.mjs --verify 1-2\n\n<!-- rivet-reply:1-2 decision=choice -->`;
  const free = [
    RECORD_YES,
    RECORD_LADDER,
    NOTE_AFTER_YES,
    RECORD_YES.replace(/\n/g, "\r\n"),
    record("Asked: Hold the PR until the owner signs off? Do not merge before then."),
    // The headline as written after the app became Rivet; comments already on GitHub keep "via Rivet".
    record("Asked: Hold the PR until the owner signs off? Do not merge before then.").replace("(via Rivet)", "(via Rivet)"),
    RECORD_YES.replace("(via Rivet)", "(via Rivet)"),
    "His yes also lifts the \"do not merge\" note in the body.",
    "Checks pass. Your approval also releases the \u201cdo not merge\u201d label on this PR.",
    "1. The owner's yes lifts the \u00abdo not merge\u00bb note.",
    "## Notes\n\nHis yes lifts the \"do not merge\" note. Her yes lifts the \"Owner hold\" line.",
    "- Checks pass.\n  - His yes lifts the \"do not merge\" note.\n- The ladder is only five steps.",
    "Reads `rivet/bridge/lib/holds-file.mjs` and `--holds-file`.",
    "- rivet/bridge/lib/holds-file.mjs: not affected",
    // A reply id as validate.mjs takes it, and a quoted release of an approval condition.
    record("Asked: Hold until the owner signs off?").replace("rivet-reply:1-2 ", "rivet-reply:r.01_x "),
    "His yes lifts the \"merge only after the owner approves\" note.",
    "Checks green.\nHis yes also lifts the \"do not merge\" note in the body.\nThe ladder is final.",
  ];
  for (const body of free) {
    assert.equal(holdLine(body), null, body);
    assert.equal(holdLines([body]), null, body);
    assert.equal(prHold({ body, comments: [] }, OWNER), null, body);
  }
  assert.equal(holdLines([RECORD_YES, NOTE_AFTER_YES, RECORD_LADDER]), null);
  const held = [
    // The record's answer and the owner's own words are read.
    [record("Asked: Ship it?\nChoice: Hold until the video"), "Choice: Hold until the video"],
    [record("Asked: Ship it?\nChoice detail: do not merge before the owner signs off"), "Choice detail: do not merge before the owner signs off"],
    [record("Asked: Ship it?", "> Hold until the owner signs off\n\n"), "> Hold until the owner signs off"],
    [record("Asked: Ship it?", "Owner hold: the video\n\n"), "Owner hold: the video"],
    // Only a whole record: no reply marker, a different headline, or a question line past the fields.
    [RECORD_LADDER.slice(0, RECORD_LADDER.lastIndexOf("<!-- rivet-reply:")), RECORD_LADDER.split("\n")[2]],
    [RECORD_LADDER.replace("**Owner decision (via Rivet):", "**Decision:"), RECORD_LADDER.split("\n")[2]],
    [record("Asked: Ship it?", "Asked: do not merge yet\n\n"), "Asked: do not merge yet"],
    ["Asked: Hold the PR until the owner signs off?", "Asked: Hold the PR until the owner signs off?"],
    // A quoted hold is cut only as what a release lifts, and only that phrase.
    ["Do not lift the \"do not merge\" note", "Do not lift the \"do not merge\" note"],
    ["Don\u2019t remove the \"do not merge\" label", "Don\u2019t remove the \"do not merge\" label"],
    ["Never   clear the \u00abdo not merge\u00bb note", "Never   clear the \u00abdo not merge\u00bb note"],
    ["This lifts the \"do not merge\" note only after the owner approves", "This lifts the \"do not merge\" note only after the owner approves"],
    ["This lifts the \"do not merge\" note; Owner hold: the video", "This lifts the \"do not merge\" note; Owner hold: the video"],
    ["Keep the \"do not merge\" note", "Keep the \"do not merge\" note"],
    // Nor where its sentence has a negation or a condition anywhere, a soft wrap included.
    ["Do not ever lift the \"do not merge\" note.", "Do not ever lift the \"do not merge\" note."],
    ["Do not yet remove the \"do not merge\" note.", "Do not yet remove the \"do not merge\" note."],
    ["Remove the \"do not merge\" note, but only after the owner approves.", "Remove the \"do not merge\" note, but only after the owner approves."],
    ["This lifts the \"do not merge\" note, only after the owner approves.", "This lifts the \"do not merge\" note, only after the owner approves."],
    ["Only after the owner signs off, remove the \"do not merge\" note.", "Only after the owner signs off, remove the \"do not merge\" note."],
    ["Lift the \"do not merge\" note as soon as the owner signs off.", "Lift the \"do not merge\" note as soon as the owner signs off."],
    ["This lifts the \"do not merge\" note\nonly after the owner approves.", "This lifts the \"do not merge\" note"],
    ["Please do not\nlift the \"do not merge\" note.", "lift the \"do not merge\" note."],
    // Only a whole sentence of the one release shape is cut: a closed set of subjects, no other word, a full stop, and a
    // line that opens it.
    ["Do n**ot** remove the \"do not merge\" note.", "Do n**ot** remove the \"do not merge\" note."],
    ["We cannot remove the \"do not merge\" note.", "We cannot remove the \"do not merge\" note."],
    ["Please do not\nunder any circumstances\nor for any reason\nin this review\nremove the \"do not merge\" note.", "remove the \"do not merge\" note."],
    ["Do not, e.g.\nremove the \"do not merge\" note.", "remove the \"do not merge\" note."],
    ["Never do the following:\n\n- Remove the \"do not merge\" note.", "- Remove the \"do not merge\" note."],
    ["Never do the following:\n\n- His yes lifts the \"do not merge\" note.", "- His yes lifts the \"do not merge\" note."],
    ["Do not pretend that\nhis yes lifts the \"do not merge\" note.", "his yes lifts the \"do not merge\" note."],
    ["Nobody's yes lifts the \"do not merge\" note.", "Nobody's yes lifts the \"do not merge\" note."],
    ["His yes never lifts the \"do not merge\" note.", "His yes never lifts the \"do not merge\" note."],
    ["His yes lifts the \"do not merge\" note only after the owner signs.", "His yes lifts the \"do not merge\" note only after the owner signs."],
    ["His yes lifts the \"do not merge\" note\nonly after the owner signs.", "His yes lifts the \"do not merge\" note"],
    ["Merging releases the \u201cOwner hold\u201d line; CI is green.", "Merging releases the \u201cOwner hold\u201d line; CI is green."],
    // Nor where a word that can deny or condition it stands in its block, the block's lead, or the block after (#506
    // round 3).
    ["Do not assume, e.g. his yes lifts the \"do not merge\" note.", "Do not assume, e.g. his yes lifts the \"do not merge\" note."],
    ["Do not assume, e.g. His yes lifts the \"do not merge\" note.", "Do not assume, e.g. His yes lifts the \"do not merge\" note."],
    ["His yes lifts the \"do not merge\" note. But only after the owner signs off.", "His yes lifts the \"do not merge\" note. But only after the owner signs off."],
    ["His yes lifts the \"do not merge\" note.\nBut only after the owner signs off.", "His yes lifts the \"do not merge\" note."],
    ["His yes lifts the \"do not merge\" note.\n\nBut only after the owner signs off.", "His yes lifts the \"do not merge\" note."],
    ["**Never assume the following:**\n\n- His yes lifts the \"do not merge\" note.", "- His yes lifts the \"do not merge\" note."],
    ["**Never assume the following**\n\n- His yes lifts the \"do not merge\" note.", "- His yes lifts the \"do not merge\" note."],
    ["Never assume these:\n\n1. Checks pass.\n2. His yes lifts the \"do not merge\" note.", "2. His yes lifts the \"do not merge\" note."],
    // The whole block before, a sibling item that opens with such a word, and a denial.
    ["His yes lifts the \"do not merge\" note. That is a lie; the owner rejected the release.", "His yes lifts the \"do not merge\" note. That is a lie; the owner rejected the release."],
    ["Never assume any of these\nstatements are true\n\n- His yes lifts the \"do not merge\" note.", "- His yes lifts the \"do not merge\" note."],
    ["Never assume these statements are true.\n\n- His yes lifts the \"do not merge\" note.", "- His yes lifts the \"do not merge\" note."],
    ["- His yes lifts the \"do not merge\" note.\n- But only after the owner signs off.", "- His yes lifts the \"do not merge\" note."],
    ["- His yes lifts the \"do not merge\" note.\n- **Only** after the owner signs off.", "- His yes lifts the \"do not merge\" note."],
    // A nested item reads every item it is nested under, and a nested item after it.
    ["- Only after the owner signs off\n\n  - His yes lifts the \"do not merge\" note.", "- His yes lifts the \"do not merge\" note."],
    ["- Only after the owner signs off\n  - Checks pass.\n  - His yes lifts the \"do not merge\" note.", "- His yes lifts the \"do not merge\" note."],
    ["- His yes lifts the \"do not merge\" note.\n  - This needs the owner first.", "- His yes lifts the \"do not merge\" note."],
    // A plural label still holds; only a name joined by a dash is not one.
    ["Holds - the video", "Holds - the video"],
    ["Owner holds \u2014 the video", "Owner holds \u2014 the video"],
    ["Holds -- the video", "Holds -- the video"],
  ];
  for (const [body, line] of held) {
    assert.equal(holdLine(body), line, body);
    assert.equal(holdLines([body]), line, body);
  }
  // A record never releases a hold before it.
  assert.equal(holdLines(["Do not merge until the owner signs off.", RECORD_YES]), "Do not merge until the owner signs off.");
  // The nested list's text grows with the square of its lines: 8 times the text is √8 times the lines.
  for (const text of [(k) => "lift the \"x\" note\n".repeat(2_500 * k), (k) => `${"x".repeat(7_500 * k)}\n`.repeat(7).replace("x", "lift the \"x\" "), (k) => "lift " + " ".repeat(7_500 * k) + "x", (k) => "not" + " ".repeat(7_500 * k) + "lift the \"x\"", (k) => "lifts the \"" + "x".repeat(7_500 * k), (k) => "His yes lifts the \"x\" note.\n".repeat(2_500 * k), (k) => "a." + " ".repeat(7_500 * k) + "his yes lifts the \"x\" note.", (k) => "- His yes lifts the \"x\" note\n".repeat(2_500 * k), (k) => "His yes lifts the \"x\" note. But\n".repeat(2_500 * k), (k) => Array.from({ length: Math.sqrt(500_000 * k) }, (_, i) => `${" ".repeat(i)}- His yes lifts the "x" note.`).join("\n"), (k) => `**Owner decision (via Rivet): x**${"\n".repeat(3_750 * k)}`]) {
    assertLinear((body) => holdLines([body]), text);
  }
});

test("a hold or wait on the owner, his card, video or word holds, whatever word holds it", () => {
  for (const line of [
    "Merge held for the owner",
    "Held for the owner",
    "Held for the owner's video OK",
    "- Merge held for the owner's sign off.",
    "Mobile held till the owner approves.",
    "Held pending the owner's approval.",
    "Holding for the owner.",
    "Still holding for the owner's video OK.",
    "Merge is held for the owner.",
    "This PR has been held for the owner since the video.",
    "We hold for the owner.",
    "Kept held for his card.",
    "Held on the owner's card.",
    "Held: the owner's video.",
    "Checks green; held for the video.",
    "Holding until the owner signs off.",
    "Merge holding on the monitor.",
    "Held for the monitor's word. Not to merge without it.",
    "Held by the owner.",
    "Holding merge for the video OK.",
    "Green, awaiting the owner.",
    "Gate clean; waits on the owner's OK.",
    "Waiting for the owner's approval.",
    "Merge **held** for _the owner_.",
    "Held for final approval from the owner.",
    "Held for the owners' video approval.",
    "This PR awaits the owner’s OK.",
    "This PR waits until the owner approves.",
    "This PR is held until after the owner approves.",
    "This PR is not held for the owner but for the owner.",
    "This PR isn't held for the owner, only for the owner.",
    "Nothing is waiting on the owner except this PR.",
    "Nothing is waiting on the owner except this pull request.",
    "Nothing is waiting on the owner but this PR, which is.",
    "Nothing is waiting on the owner, but this PR still is.",
    "Nothing waits on the owner except this PR for now.",
    "Nothing waits on the owner except this PR waiting for another day.",
    "Nothing waits on the owner except for one item: this PR.",
    "Nothing waits on the owner, except waiting for another day.",
    "Nothing is waiting on the owner, but this change is waiting on CI.",
    "Nothing waits on the owner, but this PR is waiting for now.",
    "Nothing is waiting on the owner, but this PR is still waiting.",
    "Nothing is waiting on the owner, but it is waiting for the owner's video.",
    "Nothing is waiting on the owner except this PR as well as #590.",
    "Nothing waits on the owner, but this PR is held for the owner's video.",
    "- Stays a draft until the owner approves the combined export video.",
    "- Branch export-symbols. Draft until the owner approves the combined video.",
    "Merge and deploy only on the owner's yes.",
  ]) {
    assert.equal(holdLine(`Checkpoint\n\n${line}\nmore`), line, line);
    assert.equal(holdLines([line]), line, `${line} (the second reading)`);
    assert.deepEqual(prHold({ body: "", comments: [owner(line)] }, OWNER), { where: "comment", line }, `${line} (a comment)`);
  }
  // A soft wrap does not end it.
  for (const [body, line] of [
    ["Checks green. Merge held for\nthe owner's video OK.", "held for the owner's video"],
    ["> Merge held\n> for the owner.", "held for the owner"],
    ["Gate clean; waiting\non the owner.", "waiting on the owner"],
    ["This PR is not held for the owner,\n  only for the owner.", "not held for the owner, only for the owner"],
  ]) {
    assert.equal(holdLine(body), line, body);
    assert.equal(holdLines([body]), line, body);
  }
  // The past tells how a hold ended; a job's own "held" and "waits" are no hold.
  for (const line of [
    "## Approval\n\nMerge was held for the owner's video; he OK'd it at 10:53am: \"yes ship it\".",
    "It had been held for the owner until his yes.",
    "The row is held on the card until it settles.",
    "His condition held: \"Flop looks amazing\" on 19 Sep.",
    "Lenses clean; waiting on CI.",
    "- Branch `ui-drift/report-bar`, head `99b093db84`. Nothing is waiting on the owner.",
    "The owner OK'd the video at 8:50am; nothing waits on the owner.",
    "This PR is not held for the owner.",
    "Deploy after merge waits for the monitor's go.",
    "Nothing is waiting on the owner, but CI is still running.",
    "## Approval\n\nThis PR was a draft until the owner approved the video; the owner said \u00abyes ship it\u00bb.",
    "It was still held for the owner until his yes.",
    "- R2.2 the lobby pass held card names to the 16px default: fixed.",
    // Nor across a soft wrap.
    "## Approval\n\nMerge was\nheld for the owner's video; he said \u00abyes ship it\u00bb.",
    "Nothing is\nwaiting on the owner.",
    "> Merge was\n> held for the owner.",
    // A "Held:" heading over "None" is none.
    "## Held:\n\nNone.",
  ]) {
    assert.equal(holdLine(line), null, line);
    assert.equal(holdLines([line]), null, line);
  }
  // A sentence that lifts a quoted hold is not cut while the rest of its line still waits on him.
  const lifted = 'The owner\'s yes lifts the "held for the owner" note. Awaiting his response.';
  assert.equal(holdLine(lifted), lifted);
  assert.equal(holdLines([lifted]), lifted);
});

// #602: lines from PR bodies and comments that stopped clean PRs on 2026-10-20 and -21, verbatim.
test("lines that describe holds, approvals before merge, waits elsewhere or another PR's hold are not holds", () => {
  for (const line of [
    // #608 body and comment: the feature is about PRs on hold.
    "- PRs on hold stay amber and say who holds them.",
    "Rivet shows PRs on hold as a calm line.",
    // #603: product prose.
    "- Admins can put a job on hold with a reason.",
    // #606, #608, #601: where an approval went before the merge.
    "The approval video goes to the owner before merge.",
    "- The stills went to the owner for an OK before merge.",
    "The list went to the monitor before merge.",
    "- The stills (sign-in methods, Apple linked, lobby menu) went to the owner for his OK before merge.",
    "- Stills: Feed off, Feed blocked, Settings, Ops pill. Sent to the monitor before merge.",
    "Before/after video at 320\u00d7693 goes to the owner for approval before merge.",
    // #607 and #602: something else waits, mid-sentence.
    "- Before: the lobby showed that job as waiting for a review slot.",
    "- The split script's dry run prints counts; the real run waits for the monitor's OK.",
    // #606, #606: a checkpoint that says there is no hold.
    "- PR #606, branch x, head abc1234. No owner hold. Untriaged findings: none.",
    "Checkpoint: head abc1234; no owner hold; open threads: 0.",
    // #600, #602: released and lifted holds.
    "- Owner hold released: the owner approved the stills on Rivet.",
    "Holds: none from the owner. The monitor's freeze was lifted, so that pause is lifted.",
    "Merge hold lifted.",
  ]) assert.equal(holdLine(`Checkpoint\n\n${line}\nmore`), null, line);
});

test("real holds still hold", () => {
  for (const line of [
    "**Hold:** do not merge until the owner OKs the stills below. This is a visual change awaiting his approval.",
    "- Owner hold: merge waits for the owner's OK on the stills.",
    "- Owner hold: the real split waits for the monitor's OK on the dry-run counts.",
    "**Draft until the owner approves the video.**",
    "- **Owner holds:** draft and HELD.",
    "- Monitor freeze: main is frozen for #533. This PR does not merge until the monitor unfreezes.",
    "Rivet hold: wait for the monitor's word.",
    "This PR is on hold until the owner OKs the video.",
    "Merge waits for the owner's OK on the stills.",
    "Waiting on the owner's OK before merge.",
    "Do not merge yet.",
    "Owner hold released only after the owner approves the video.",
  ]) assert.equal(holdLine(`Checkpoint\n\n${line}\nmore`), line, line);
});

test("this PR by number, approval still required before merge, waits in tables and conditional releases still hold", () => {
  for (const text of [
    "(PR #610, do not merge)",
    "(PR 7, do not merge)",
    // Another repository's PR in brackets is not told apart from this one's, so it holds too.
    "Same fix as the sync tool (other-repo PR 96, do not merge).",
    "(Owner hold: do not merge this PR; dependency other-repo PR 96, do not merge)",
    "Require owner approval\nbefore merge.",
    "The owner\u2019s OK before merge\nis mandatory.",
    "Owner hold released for v1.2 only after #620 lands.",
    "We no longer require owner approval before merge, except for this PR.",
    "PR #7 is on hold.",
    "PR #7 awaits the owner.",
    "PR #610 is on hold pending #620.",
    "Require owner approval before merge.",
    "The owner\u2019s OK before merge is mandatory.",
    "Owner hold released? No; #620 is still pending.",
    "Hold released? No, keep waiting.",
    "Owner hold released: only after #620 lands.",
    "Owner hold released\nonly after the owner approves the final checklist; approval is still pending.",
    // #621: a release's condition after a line break or a mark.
    "Hold released\nonly after the owner approves the final checklist.",
    "Hold released\nonce the owner approves.",
    "> Hold released\n> only after the owner approves.",
    "Hold lifted\n\nwhen the owner approves.",
    "Hold released: only after the owner approves.",
    "Hold released, but only after the owner approves.",
    "Hold released \u2014 once the owner approves.",
    "Hold released (pending the video).",
    "Hold released.\nOnly after the owner approves.",
    "Owner hold released.\nOnly after the owner approves.",
    // #621 review: a condition anywhere in the release's paragraph, emphasis, task boxes and multi-word holds that wrap.
    "Hold released.\nAnd **only** after the owner approves.",
    "Owner hold released.\nAnd **only** after the owner approves.",
    "Hold released.\nProvided the owner approves.",
    "Owner hold released.\nProvided the owner approves.",
    "Hold released\n- [ ] only after the owner approves the final checklist.",
    "Hold released: agreed,\nbut only after the owner approves.",
    `Hold released: ${"the gate is clean ".repeat(130)}`,
    "No owner hold,\nonly after the owner approves.",
    "No owner hold, (only after the owner approves).",
    "## Holds\nNone.\nOnly after the owner approves.",
    "Do not\nmerge until I approve.",
    "Don\u2019t\nmerge yet.",
    "No\nmerge until the owner OKs the stills.",
    "This PR is on\nhold.",
    // #621 round 2: a next paragraph opening with a condition word, a continuation past the window, a blocked PR.
    "Hold released.\n\nOnly after the owner approves.",
    "Owner hold released.\n\nAfter merging, deploy the update.",
    `Hold released\n\nfor ${"x ".repeat(1100)}only after the owner approves.`,
    "This PR must remain\nblocked.",
    // #621 round 3: a condition later in the next paragraph's first sentence, or past a window ending at the blank line.
    "Hold released.\n\nOn condition that the owner approves.",
    "Hold released.\n\nAs long as the owner approves first.",
    "Hold released.\n\nIn case the owner objects, wait.",
    `Hold released: ${"x".repeat(1995)}.\n\nOnly after the owner approves.`,
    `Hold released.\n\n${"y".repeat(3000)} only after the owner approves.`,
    // #621 round 4: a numbered item's mark, a quoted soft wrap inside a condition phrase.
    "Owner hold released.\n\n1. Only after the owner approves.",
    "Hold released.\n\n- [ ] 2) Only after the owner approves.",
    "Hold released.\n\n> As long\n> as the owner approves.",
    // #621 round 5: a nested numbered item or an abbreviation's stop does not end the sentence read.
    "Owner hold released.\n\n- Criteria:\n  1. Only after the owner approves.",
    "Hold released.\n\nSee item 2. Only after the owner approves.",
    "Hold released.\n\nE.g. only after the owner approves.",
    // #621 round 6: the next paragraph is read whole, so no mark inside it hides a condition; a condition word
    // anywhere in it keeps the release, failing closed (a heading's section, a test note with "not").
    "Hold released.\n\nSee item **2**. Only after the owner approves.",
    "Hold released.\n\n## Note\nOnly after the owner approves.",
    "Hold released.\n\nMerge follows the three-lens gate. It does not wait.",
    // #621 round 7: a window's cut end is not a paragraph's end; a heading or label paragraph reads on.
    `Hold released.\n\n${"x".repeat(1997)}\nOnly after the owner approves.`,
    `Hold released: ${"x".repeat(1984)}\nOnly after the owner approves.`,
    "Hold released.\n\n## Note\n\nOnly after the owner approves.",
    "Hold released.\n\nNote:\n\nOnly after the owner approves.",
    // #621 round 8: an underlined heading reads on too.
    "Hold released.\n\n## Note\n\nApproval details\n----------------\n\nOnly after the owner approves.",
    "Hold released.\n\nNote\n===\n\nOnly after the owner approves.",
    // #621 round 9: any paragraph whose last line ends no sentence reads on (an empty heading over a label, a list),
    // failing closed (a list closed by a rule keeps a later unrelated paragraph's condition).
    "Owner hold released.\n\n##\nApproval details:\n\nOnly after the owner approves.",
    "Hold released.\n\n- CI green\n- Video OK\n\nOnly after the owner approves.",
    // #621 round 10: a loose list item's indented continuation is read too.
    "Owner hold released.\n\n- CI green\n- Video OK\n\n- Approval details.\n\n  Only after the owner approves.",
    "Hold released.\n\n> - Done.\n>\n>   Only after the owner approves.",
    "Hold released.\n\n- Done.\n\n\n  Only after the owner approves.",
    "Hold released.\n\n- Done.\n\n \n  Only after the owner approves.",
    "Hold released.\n\n> - Done.\n>\n>\n>   Only after the owner approves.",
    `Hold released.\n\n- Done.\n\n${" ".repeat(2100)}\n  Only after the owner approves.`,
    `Hold released.\n\n- Done.\n\n \tOnly after the owner approves.\n${"PASS\n".repeat(600)}`,
    "Hold released.\n\n- Done.\n\n Only after the owner approves.",
    "Hold released.\n\n> - Done.\n>\n> \tOnly after the owner approves.",
    "Hold released.\n\n- Done.\n\n  > Only after the owner approves.",
    "Hold released.\n\n> - Done.\n>\n>  > Only after the owner approves.",
    "| Status | Waiting on the owner |",
    "We are waiting on the owner.",
  ]) {
    assert.ok(holdLine(`Checkpoint\n\n${text}\nmore`), text);
    assert.ok(holdLines([`Checkpoint\n\n${text}\nmore`]), text);
  }
  // The second reading's fallback reads the same checkpoint negations the bridge does.
  for (const text of [
    "Checkpoint: no owner hold, all findings triaged.",
    "Owner holds: none from the owner.",
    "Hold: none from the owner.",
    "- **No owner hold.**",
    "Status: no owner hold.",
    "Owner hold released: the owner approved.",
    "Hold released\nfor the merge; the gate is clean.",
    "Hold released.\nMerge follows the three-lens gate.",
    "Do not\n\nMerge plan: squash.",
    "Hold released.\n\n1. Merge follows the gate.",
    "Hold released.\n\nAll checks green.\n\nThe parser does not wait.",
    "Hold released.\n\n## Tests\n\nAll green.\n\nNot a hold.",
    "Owner hold released: the owner approved.\n\n#6213 is fixed.\n\nAfter merging, deploy the update.",
    "Hold released.\n\n- Done.\n\nNot a hold.",
    "> Hold released.\n>\n> Done.\n>\n> Not a hold.",
    `Owner hold released: the owner approved.\n\nAll checks green.\n\n\`\`\`text\n${"PASS parser regression suite\n".repeat(100)}\`\`\``,
  ]) assert.equal(holdLines([`Checkpoint\n\n${text}\nmore`]), null, text);
  const edge = `Hold released: ${"x".repeat(1995)}.\n\nOnly after the owner approves.`;
  assert.ok(holdLines([edge]), "a window ending at the blank line still reads the next paragraph");
  // A release comment whose condition wraps releases nothing.
  const held = { body: "", comments: [owner("- Hold: merge waits for #379")] };
  assert.ok(prHold({ ...held, comments: [...held.comments, owner("Hold released\nonly after the owner approves.")] }, OWNER));
  assert.ok(prHold({ body: "", comments: [owner("Hold released\nonly after the owner approves.")] }, OWNER), "the conditioned release is itself read");
  assert.ok(prHold({ ...held, comments: [...held.comments, owner("Hold released.\n\n> As long\n> as the owner approves.")] }, OWNER), "a quoted wrap in a condition releases nothing");
  // A plain release with a second line releases.
  assert.equal(prHold({ ...held, comments: [...held.comments, owner("Hold released\nAll checks green.")] }, OWNER), null);
  assert.equal(prHold({ ...held, comments: [...held.comments, owner("Hold released: once the owner approves")] }, OWNER)?.line, "Hold released: once the owner approves");
});

const yes = "**Owner decision (via Rivet): CHOSE: Yes, put it on the site**\nItem: `x` \u2014 ship it?\n<!-- rivet-reply:abc decision=choice -->";
const stale = { body: "Checkpoint\n- **Owner holds:** draft and HELD.", posted: "2026-10-20T04:14:00Z", changed: "2026-10-20T04:20:00Z", association: "OWNER" };

// The monitor's rule (2026-10-21): a yes releases only if it can be tied to this PR's hold, else only "Hold released:".
// A yes cannot be: what it means depends on the card's question, so no yes releases a hold.
test("an owner's Rivet yes releases no hold, whatever its question, before or after ready for review", () => {
  const record = { body: yes, posted: "2026-10-20T04:56:34Z", changed: "2026-10-20T04:56:34Z", association: "OWNER" };
  const asked = (ask) => ({ ...record, body: yes.replace("ship it?", `ship it?\nAsked: ${ask}`) });
  for (const answer of [record, { ...record, body: yes.replace("CHOSE: Yes, put it on the site", "APPROVED") }, asked("Merge on the owner’s approval?"), asked("Continue holding for the owner?"), asked("Ship it?")]) {
    // As the PR was read before the yes was dropped: out of draft after the yes.
    assert.ok(holdLines(currentTexts(/** @type {any} */ ({ body: "", notes: [stale, answer], readyAt: ["2026-10-20T04:57:49Z"], draft: false }))), answer.body);
  }
  // #598's stale checkpoint is released by the owner's "Hold released:" comment instead.
  assert.equal(holdLines(currentTexts({ body: "", notes: [stale, record, { ...record, body: "Hold released: the owner said yes on the card." }] })), null);
});

test("an owner release comment supersedes earlier comment holds; anyone else's does not, and its own text is still read", () => {
  const release = { body: "Hold released: the owner chose Ship it.", posted: "2026-10-20T05:00:00Z", changed: "2026-10-20T05:00:00Z", association: "OWNER" };
  assert.equal(holdLines(currentTexts({ body: "", notes: [stale, release], draft: true })), null);
  assert.ok(holdLines(currentTexts({ body: "", notes: [stale, { ...release, association: "NONE" }], draft: false })));
  assert.ok(holdLines(currentTexts({ body: "", notes: [stale, { ...release, association: null }], draft: false })));
  assert.ok(holdLines(currentTexts({ body: "", notes: [stale, { ...release, posted: "garbage" }], draft: false })));
  assert.ok(holdLines(currentTexts({ body: "", notes: [{ ...release, body: "Hold released: the freeze.\nOwner hold: the owner still wants the video." }], draft: false })));
  // A release on a comment of several lines; not one that is conditional or carries a hold of its own.
  assert.equal(holdLines(currentTexts({ body: "", notes: [stale, { ...release, body: "Release hold: the owner approved.\nAll checks green." }], draft: false })), null);
  assert.ok(holdLines(currentTexts({ body: "", notes: [stale, { ...release, body: "Hold released: only after #620 lands." }], draft: false })));
  assert.ok(holdLines(currentTexts({ body: "", notes: [stale, { ...release, body: "Hold released: no, still waiting on the owner." }], draft: false })));
  assert.ok(holdLines(currentTexts({ body: "", notes: [stale, { ...release, body: "Hold released: agreed,\nbut only after #620 lands." }], draft: false })));
  // #621: every condition word cutReleased reads also keeps a release comment from releasing.
  assert.ok(holdLines(currentTexts({ body: "", notes: [stale, { ...release, body: "Hold released\nProviding the owner approves." }], draft: false })));
  // A `rivet hold` comment ends only when `rivet unhold` edits it.
  const rivet = { ...stale, body: "Owner hold: do not merge until the owner's OK is relayed." };
  assert.ok(holdLines(currentTexts({ body: "", notes: [rivet, release], draft: false })));
  assert.ok(holdLines(currentTexts({ body: "", notes: [{ ...rivet, body: "**Owner hold:** do not merge until the owner OKs the video." }, release], draft: false })));
});

test("videoWaitOnly: every hold in the texts is a whole-line wait for the owner's video OK", () => {
  const video = "**Merge waits for the owner's OK on the video.**";
  assert.equal(videoWaitOnly([`## Summary\nNew reels.\n\n${video}\n`]), true);
  assert.equal(videoWaitOnly([`## Summary\r\n- ${video}\r\n`, "Looks good."]), true);
  // Another hold anywhere, before or after, in the body or a comment, keeps it a real hold.
  assert.equal(videoWaitOnly([`${video}\n\nOwner hold: the owner wants to try it first`]), false);
  assert.equal(videoWaitOnly([`${video}\nHold: dependency #639 first\nOwner hold: the owner must playtest first`]), false);
  assert.equal(videoWaitOnly([video, "Owner hold: the owner plays it first"]), false);
  assert.equal(videoWaitOnly([`Do not merge:\n${video}`]), false);
  // A line that carries the video wait on is more than the wait.
  assert.equal(videoWaitOnly(["Merge waits for the owner's OK on the video\nand legal sign off."]), false);
  assert.equal(videoWaitOnly(["Owner hold: the owner OKs the video\nOnly after the owner signs off too."]), false);
  assert.equal(videoWaitOnly(["> Owner hold: the owner OKs the video\n> and the owner signs off the production rollout."]), false);
  assert.equal(videoWaitOnly([`- ${video}\n  - and his in-person playtest`]), false);
  assert.equal(videoWaitOnly([`## Summary\n- ${video}\n- Faster tiles`]), false);
  assert.equal(videoWaitOnly([`## Summary\n- Faster tiles\n- ${video}`]), true);
  // A decision record quoting the wait beside the body's wait stays no hold of its own.
  assert.equal(videoWaitOnly([video, "**Owner decision (via Rivet): CHOSE**\nItem: out-1 — the video\nAsked: Merge waits for the owner's OK on the video.\nChoice: Yes, keep it\n\n<!-- rivet-reply:r1 decision=choice -->"]), true);
  // No hold at all, or a video line that is not a whole wait.
  assert.equal(videoWaitOnly(["## Summary\nFaster tiles.", "No owner hold."]), false);
  assert.equal(videoWaitOnly(["Owner hold: the owner wants to playtest the visual overhaul before merge"]), false);
  assert.equal(videoWaitOnly(["Owner hold: the owner says do not merge until legal signs off; approval video attached."]), false);
  // A settled decision record is no hold, so nothing to wait on.
  assert.equal(videoWaitOnly(["**Owner decision (via Rivet): CHOSE**\nItem: out-1 — Approval video\nAsked: Owner hold: waiting for the owner\nChoice: Yes, keep it\n\n<!-- rivet-reply:r1 decision=choice -->"]), false);
  for (const line of [video, "**Owner hold:** the owner OKs the video", "> - Waiting for the owner's sign off on the before/after video."]) assert.ok(isVideoWaitLine(line), line);
  for (const line of ["Owner hold: the owner wants to try it first", "Video: https://example.com/clip.mp4", "Do not merge", "The owner OKed the video.", "Do not merge until the owner OKs the video"])
    assert.ok(!isVideoWaitLine(line), line);
});


test("the Ops release card's own copy, quoted in a PR's prose, and prose using the word are not holds", () => {
  for (const text of [
    "The owner got an Ops card \"You placed a hold on it… Release the hold\".",
    "The owner got an Ops card \"You placed a hold on it and it is waiting for you.\"",
    "He chose \"Release the hold\".",
    // Prose using the word.
    "  - the machinery, release order and floor rules still hold",
  ]) assert.equal(holdLines([text]), null, text);
});

test("videoWaitOnly: a list item after the wait may carry it on, so it is a hold", () => {
  assert.equal(videoWaitOnly(["+ Owner hold: the owner OKs the video\n+ and the owner signs off the production rollout."]), false);
  assert.equal(videoWaitOnly(["- Owner hold: the owner OKs the video\n- Only after the owner signs off too."]), false);
  assert.equal(videoWaitOnly(["- Owner hold: the owner OKs the video\n\n## Testing\n- vitest"]), true);
  assert.equal(videoWaitOnly(["- Owner hold: the owner OKs the video\n## Testing"]), true);
  assert.equal(videoWaitOnly(["- Owner hold: the owner OKs the video\n\n  and the owner signs off the production rollout."]), false);
  assert.equal(videoWaitOnly(["Owner hold: the owner OKs the video\n#6200 must land first."]), false);
  assert.equal(videoWaitOnly(["Owner hold: the owner OKs the video\n\nFaster tiles."]), false);
});

test("allHolds reads every hold line in order, up to its cap, so the owner's is found behind another's", () => {
  const monitor = "Monitor hold: until the owner opens the ruleset window";
  const stack = "Hold: STACK until #639 lands; no owner hold.";
  const his = "Owner hold: do not merge until I finish playtesting";
  assert.deepEqual(allHolds([`## Summary\n${monitor}\n\n${stack}`, his]), [monitor, stack, his]);
  assert.deepEqual(allHolds([monitor, stack, his], 2), [monitor, stack]);
  assert.deepEqual(allHolds(["No hold here."]), []);
  // The same line twice is one hold.
  assert.deepEqual(allHolds([monitor, monitor]), [monitor]);
  // Past five of the monitor's, his is still read.
  const five = [1, 2, 3, 4, 5].map((n) => `Monitor hold: until #100${n} lands`).join("\n");
  assert.equal(allHolds([five, his]).at(-1), his);
  // A hold read across lines ends only its own text's reading.
  const wrapped = "Agent is holding for\nthe monitor";
  assert.notEqual(holdLines([wrapped]), null);
  assert.equal(allHolds([wrapped, his]).at(-1), his);
  // In the same text, its paragraph is set aside and the reading goes on.
  assert.equal(allHolds([`${wrapped}\n\nThe owner (hold): wait for my playtest.`]).at(-1), "The owner (hold): wait for my playtest.");
  assert.deepEqual(allHolds([`${wrapped}\n\nMerge held for\nthe owner`]).length, 2);
  // Two wrapped holds in one paragraph: only the first's lines are set aside.
  assert.equal(allHolds([`${wrapped}.\nMerge held for\nthe owner.`]).length, 2);
  assert.equal(allHolds([`${wrapped}\nMerge held for\nthe owner`]).length, 2);
  // Wrapped past six lines: its paragraph is set aside.
  assert.equal(allHolds(["Agent is holding\nthis\nPR\nback\nfor\nthe\nmonitor\n\nMerge held for\nthe owner"]).length, 2);
});

test("a verb \"hold:\" in prose is no hold; labels and real holds still hold", () => {
  for (const body of [
    // #668: the verb, not a label.
    "- Queue's authoritative-server and single-writer rules hold: the single worker owns the row, and no client field decides an outcome.",
    "### Why it is safe\n- The queue-path invariants hold: a job runs once, after its row is durable.",
    "## Depends on\nDepends on:\n#6680 lands first.\n\n## Why it is safe\n- The queue-path invariants hold: a job runs once, after its row is durable.",
    "- The reconciler reads one table.\n\n- The queue-path invariants hold: a job runs once, after its row is durable.",
    // #668's own section: a list item's lead-in governs only its sub-items.
    "## Change\n- `Worker` now books each scheduled placement using on-demand's answers:\n  - an exact replay waits for the original.\n- The durable table was not reused.\n- Queue's authoritative-server and single-writer rules hold: the single worker owns the row.",
    // #669's checkpoint line.
    "Checkpoint: PR #669, branch x, head 228b431fb4. Owner holds: none. Untriaged findings: none. Open threads: none.",
  ]) {
    assert.equal(holdLine(body), null, body);
    assert.equal(holdLines([body]), null, body);
    assert.equal(prHold({ body, comments: [] }, OWNER), null, body);
  }
  for (const [body, line] of [
    // #600, #658: real holds.
    ["**Hold: the owner rejected 20 Oct; parked.** This PR stays a draft and does not merge.", "**Hold: the owner rejected 20 Oct; parked.** This PR stays a draft and does not merge."],
    ["- Draft on purpose; do not merge. Label `notice:skip`.", "- Draft on purpose; do not merge. Label `notice:skip`."],
    // A label before "hold:": any word but the closed set, or too few clause words before a plural.
    ["The owner hold: the video is not approved yet.", "The owner hold: the video is not approved yet."],
    ["Status of the video hold: waiting on the owner.", "Status of the video hold: waiting on the owner."],
    ["Status of the Ops hold: the owner rejected this build.", "Status of the Ops hold: the owner rejected this build."],
    ["Status of the approvals hold: the owner rejected the build.", "Status of the approvals hold: the owner rejected the build."],
    ["- Ops hold: until #620 lands.", "- Ops hold: until #620 lands."],
    ["- Merge rules hold: the owner's OK first.", "- Merge rules hold: the owner's OK first."],
    ["The PR, its deploy and its hold: the owner decides.", "The PR, its deploy and its hold: the owner decides."],
    ["Note, rules hold: wait for the owner.", "Note, rules hold: wait for the owner."],
    ["Status of the rules hold: the owner rejected this build.", "Status of the rules hold: the owner rejected this build."],
    ["1) Merge constraints hold: the owner rejected this build.", "1) Merge constraints hold: the owner rejected this build."],
    ["a) Merge rules hold: the owner rejected this build.", "a) Merge rules hold: the owner rejected this build."],
    ["- [x] Merge constraints hold: the owner rejected this build.", "- [x] Merge constraints hold: the owner rejected this build."],
    ["**Merge rules hold:** the owner rejected this build.", "**Merge rules hold:** the owner rejected this build."],
    ["We should still hold: the owner rejected this build.", "We should still hold: the owner rejected this build."],
    ["The invariants we rely on still hold: the owner must approve first.", "The invariants we rely on still hold: the owner must approve first."],
    ["This PR is blocked until the queue invariants hold: duplicate rows are still reproducible.", "This PR is blocked until the queue invariants hold: duplicate rows are still reproducible."],
    ["Merge only when the single-writer rules hold: the worker owns the row.", "Merge only when the single-writer rules hold: the worker owns the row."],
    ["Do not merge yet, as the engine's single-writer rules hold: the owner decides.", "Do not merge yet, as the engine's single-writer rules hold: the owner decides."],
    ["This PR is blocked until\nall queue invariants hold: duplicate rows are still reproducible.", "all queue invariants hold: duplicate rows are still reproducible."],
    ["Merge only when v1.2's new queue invariants hold: duplicate rows are still reproducible.", "Merge only when v1.2's new queue invariants hold: duplicate rows are still reproducible."],
    ["This PR cannot proceed without proof that all queue invariants hold: duplicate rows are still reproducible.", "This PR cannot proceed without proof that all queue invariants hold: duplicate rows are still reproducible."],
    ["This PR is blocked until\nthe newly introduced\nqueue safety invariants hold: duplicate rows are still reproducible.", "queue safety invariants hold: duplicate rows are still reproducible."],
    ["PR needs proof queue invariants hold: duplicate rows.", "PR needs proof queue invariants hold: duplicate rows."],
    ["Awaiting confirmation the queue invariants hold: duplicate rows are still reproducible.", "Awaiting confirmation the queue invariants hold: duplicate rows are still reproducible."],
    ["The queue invariants hold: duplicate rows are still reproducible.", "The queue invariants hold: duplicate rows are still reproducible."],
    ["Pending-approval single-writer rules hold: the owner decides.", "Pending-approval single-writer rules hold: the owner decides."],
    ["This PR is blocked until:\n- all queue-path invariants hold: duplicate rows are still reproducible.", "- all queue-path invariants hold: duplicate rows are still reproducible."],
    ["This PR is blocked until:\n- CI is green.\n- Queue's single-writer rules hold: duplicate rows are still reproducible.", "- Queue's single-writer rules hold: duplicate rows are still reproducible."],
    ["This PR is blocked until:\n\n- The queue-path invariants hold: duplicate rows are still reproducible.", "- The queue-path invariants hold: duplicate rows are still reproducible."],
    ["Merge only when v1.2's single-writer rules hold: duplicate rows are still reproducible.", "Merge only when v1.2's single-writer rules hold: duplicate rows are still reproducible."],
    ["This PR is blocked until:\n#6680 lands.\n- The queue-path invariants hold: duplicate rows are still reproducible.", "- The queue-path invariants hold: duplicate rows are still reproducible."],
    ["This PR is blocked until\n- The queue-path invariants hold: duplicate rows are still reproducible.", "- The queue-path invariants hold: duplicate rows are still reproducible."],
    ["This PR is blocked until\n\n- The queue-path invariants hold: duplicate rows are still reproducible.", "- The queue-path invariants hold: duplicate rows are still reproducible."],
    ["## Merge conditions\nThis PR is blocked until:\n\n### Queue\n- The queue-path invariants hold: duplicate rows are still reproducible.", "- The queue-path invariants hold: duplicate rows are still reproducible."],
    ["Blocked until:\n- CI is green.\n\n## Queue\n- The queue-path invariants hold: duplicate rows are still reproducible.", "- The queue-path invariants hold: duplicate rows are still reproducible."],
    ["- Merge blocked until:\n- The queue-path invariants hold: duplicate rows are still reproducible.", "- The queue-path invariants hold: duplicate rows are still reproducible."],
    ["## Merge blocked pending proof\n- The queue-path invariants hold: duplicate rows are still reproducible.", "- The queue-path invariants hold: duplicate rows are still reproducible."],
    ["This PR is blocked until the following checks pass.\n- The queue-path invariants hold: duplicate rows are still reproducible.", "- The queue-path invariants hold: duplicate rows are still reproducible."],
    ["The release-freeze rules hold: this PR stays parked through Friday.", "The release-freeze rules hold: this PR stays parked through Friday."],
    ["The queue-path rules hold: nothing merges before Friday.", "The queue-path rules hold: nothing merges before Friday."],
    ["The release-moratorium rules hold: leave it unmerged through Friday.", "The release-moratorium rules hold: leave it unmerged through Friday."],
    ["The new-release rules hold: nothing ships through Friday.", "The new-release rules hold: nothing ships through Friday."],
    ["The new-release rules hold:\n  leave it unmerged through Friday.", "The new-release rules hold:"],
    ["- The two-person rules hold: PR must remain suspended through Friday.", "- The two-person rules hold: PR must remain suspended through Friday."],
    ["The two-person rules hold: still vetoed by both maintainers.", "The two-person rules hold: still vetoed by both maintainers."],
    ["**The new-release rules hold:**\n- leave it unmerged through Friday.", "**The new-release rules hold:**"],
    ["- Still to prove:\n  - The queue-path invariants hold: duplicate rows are still reproducible.", "- The queue-path invariants hold: duplicate rows are still reproducible."],
    ["This PR is blocked until: the queue-path invariants hold: duplicate rows are still reproducible.", "This PR is blocked until: the queue-path invariants hold: duplicate rows are still reproducible."],
    ["Hold released --pending the owner's approval.", "Hold released --pending the owner's approval."],
    ["Hold released--pending #620.", "Hold released--pending #620."],
    ["Hold released --wait for the owner.", "Hold released --wait for the owner."],
    ["- Hold released--unless #620 lands.", "- Hold released--unless #620 lands."],
    ["- Hold released.\n- CI: green.\n- Release condition: the owner must approve first.", "- Hold released."],
    ["- Hold released.\n- CI is green.\n- Checks complete.\n\nOnly after the owner approves.", "- Hold released."],
    ["- Hold released.\n\t- Next: CI.\n\t- Only after the owner approves.", "- Hold released."],
    ["- Hold released: the owner OK'd it.\n- Next: CI.", null],
  ]) {
    assert.equal(holdLine(body), line, body);
    assert.equal(holdLines([body]), line, body);
  }
  // The second reading's reading still catches what the bridge's "these/they/must hold:" excuse lets past.
  for (const body of ["Merge must hold: the owner rejected this build.", "We must hold: the owner rejected this build."]) assert.equal(holdLines([body]), body);
  for (const long of [
    (k) => `${"a".repeat(4_000 * k)} b rules hold: x`,
    (k) => `- ${"a b c rules hold. ".repeat(1_000 * k)}a b rules hold: x`,
    (k) => `@${" ".repeat(20_000 * k)}a-b c-d rules hold: x`,
    (k) => `@${"a".repeat(20_000 * k)}'s c-d rules hold: x`,
    (k) => `${"x".repeat(20_000 * k)}.${"\n".repeat(20_000 * k)}`,
    (k) => `- a-b c-d rules hold: ${"x ".repeat(20_000 * k)}`,
  ]) assertLinear((body) => holdLines([body]), long);
});
