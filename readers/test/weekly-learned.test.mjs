import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cardAddCall, cardId, chooseProposals, emptyState, groupLearned, lookBackLine, pass, renderCard, runWeekly, syncAnswers } from "../weekly-learned.mjs";

const NOW = new Date("2026-10-25T09:00:00Z");
const ago = (days) => new Date(NOW.getTime() - days * 24 * 3600_000).toISOString();
const fix = (kind, key, days, said = {}) => ({ id: `${kind}/${key}@${ago(days + 0.5)}`, kind, key, at: ago(days), ...said });
const status = (kind, key, days, said = {}) => ({ kind, key, state: "fixed", since: ago(days + 0.5), updatedAt: ago(days), ...said });
const proposed = (key, days, answer, answeredDays) => ({ key, card: "weekly-learned-x", text: key, count: 1, kind: "ci", at: ago(days), ...(answer ? { answer, answeredAt: ago(answeredDays) } : {}) });

test("fixes group by their prevent line, whatever its case, punctuation, numbers or PR numbers", () => {
  const groups = groupLearned(
    [
      fix("ci", "a", 1, { prevent: "Retry the runner once (#638)" }),
      fix("runner", "b", 2, { prevent: "retry the runner once." }),
      fix("app", "c", 3, { prevent: "Alert when an app is down 3 min" }),
      fix("app", "d", 3, { prevent: "Alert when an app is down 15 min" }),
    ],
    NOW,
  );
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.count), [2, 2]);
  assert.ok(groups.every((g) => !/#638/.test(g.text)));
});

test("a cause is the line when there is no prevent, and a prevent line wins over the cause", () => {
  const groups = groupLearned([fix("ci", "a", 1, { cause: "Flaky DNS" }), fix("ci", "b", 1, { cause: "Flaky DNS", prevent: "Retry on DNS errors" })], NOW);
  assert.deepEqual(groups.map((g) => g.text).sort(), ["Flaky DNS", "Retry on DNS errors"]);
});

test("a fix with no line is proposed by nobody, however often its item was fixed", () => {
  assert.deepEqual(groupLearned([fix("machine", "desk", 1), fix("machine", "desk", 2), fix("machine", "desk", 3), fix("ci", "a", 1), fix("ci", "a", 2), fix("pr", "638", 1), fix("pr", "638", 2)], NOW), []);
});

test("a prevent line that is only a PR number says nothing: the cause is used, and with no cause there is no group", () => {
  const groups = groupLearned([fix("machine", "desk", 1, { prevent: "#660", cause: "Stacked heavy lanes" }), fix("machine", "mac", 2, { prevent: "PR 660", cause: "stacked heavy lanes." })], NOW);
  assert.deepEqual(groups.map((g) => [g.text, g.count]), [["Stacked heavy lanes", 2]]);
  assert.deepEqual(groupLearned([fix("machine", "desk", 1, { prevent: "#660" }), fix("machine", "desk", 2, { prevent: "PR 660" }), fix("machine", "desk", 3, { cause: "660" })], NOW), []);
});

test("two fixes of one item more than a week apart count once, and old fixes are not read", () => {
  assert.deepEqual(groupLearned([fix("ci", "a", 8, { prevent: "x" })], NOW), []);
  assert.deepEqual(groupLearned([fix("disk", "d", 1, { prevent: "Prune caches" }), fix("disk", "d", 9, { prevent: "Prune caches" })], NOW).map((g) => g.count), [1]);
});

test("groups come most fixes first", () => {
  const groups = groupLearned([fix("ci", "a", 1, { prevent: "one" }), fix("pr", "638", 1, { cause: "two" }), fix("pr", "638", 2, { cause: "two" }), fix("pr", "638", 3, { cause: "two" })], NOW);
  assert.deepEqual(groups.map((g) => [g.text, g.count]), [["two", 3], ["one", 1]]);
});

test("at most 3 are proposed", () => {
  const fixes = ["a", "b", "c", "d", "e"].map((word) => fix("ci", word, 1, { prevent: `stop ${word}` }));
  const groups = groupLearned(fixes, NOW);
  assert.equal(groups.length, 5);
  const chosen = chooseProposals(groups, emptyState(), NOW);
  assert.equal(chosen.length, 3);
  assert.equal(renderCard(chosen, cardId(NOW)).ask.split("\n").length, 3);
});

test("the card is a heading, up to 3 short bullets in plain words, Yes and Not now, with no PR numbers", () => {
  const card = renderCard(groupLearned([fix("pr", "638", 1, { prevent: "Re-run checks on PR #638 after a runner restart" })], NOW), cardId(NOW));
  assert.match(card.id, /^weekly-learned-20261025$/);
  assert.equal(card.title, "Rivet's week: handle this by itself?");
  assert.deepEqual(card.options, ["Yes", "Not now"]);
  assert.equal(card.ask, "- Re-run checks on after a runner restart (fixed once)");
  assert.doesNotMatch(card.ask, /#\d|PR \d|Shepherd|Recurring job/);
});

test("a week of fixes with no lines posts no card", async () => {
  const h = harness({ statuses: [status("machine", "desk", 1), status("ci", "a", 2)] });
  await runWeekly(h.deps("propose"));
  assert.deepEqual(h.calls.cards, []);
});

test("a proposal turned down is not proposed again for 30 days, then may be", () => {
  const groups = groupLearned([fix("ci", "a", 1, { prevent: "stop a" })], NOW);
  const key = groups[0].key;
  assert.equal(chooseProposals(groups, { fixes: [], proposed: [proposed(key, 29, "no", 29)] }, NOW).length, 0);
  assert.equal(chooseProposals(groups, { fixes: [], proposed: [proposed(key, 40, "no", 29.9)] }, NOW).length, 0);
  assert.equal(chooseProposals(groups, { fixes: [], proposed: [proposed(key, 40, "no", 31)] }, NOW).length, 1);
});

test("an accepted or still-unanswered proposal is not put up again, a stale unanswered one is", () => {
  const groups = groupLearned([fix("ci", "a", 1, { prevent: "stop a" })], NOW);
  const key = groups[0].key;
  assert.equal(chooseProposals(groups, { fixes: [], proposed: [proposed(key, 5, "yes", 4)] }, NOW).length, 0);
  assert.equal(chooseProposals(groups, { fixes: [], proposed: [proposed(key, 7)] }, NOW).length, 0);
  assert.equal(chooseProposals(groups, { fixes: [], proposed: [proposed(key, 14)] }, NOW).length, 1);
});

test("the first Yes or Not now to a card's newest revision is its answer; a comment is none", () => {
  const state = { fixes: [], proposed: [proposed("k", 1)] };
  assert.deepEqual(syncAnswers(state, [{ itemId: "weekly-learned-x", decision: "comment", rev: "r1", at: ago(0.5) }, { itemId: "other", decision: "reject", rev: "r1", at: ago(0.4) }]), []);
  const answered = syncAnswers(state, [
    { itemId: "weekly-learned-x", decision: "choice", choice: "Not now", rev: "r1", at: ago(0.3) },
    { itemId: "weekly-learned-x", decision: "choice", choice: "Yes", rev: "r1", at: ago(0.2) },
  ]);
  assert.equal(answered.length, 1);
  assert.equal(state.proposed[0].answer, "no");
});

test("Answer again: the newest revision's answer replaces the old one, in either direction", () => {
  const state = { fixes: [], proposed: [proposed("k", 1)] };
  const no = { itemId: "weekly-learned-x", decision: "choice", choice: "Not now", rev: "r1", at: ago(0.3) };
  const yes = { itemId: "weekly-learned-x", decision: "choice", choice: "Yes", rev: "r2", at: ago(0.2) };
  syncAnswers(state, [yes, no]);
  assert.equal(state.proposed[0].answer, "yes");
  assert.equal(state.proposed[0].answeredAt, yes.at);
  assert.equal(syncAnswers(state, [yes, no]).length, 0);
  syncAnswers(state, [{ ...no, rev: "r3", at: ago(0.1) }, yes, no]);
  assert.equal(state.proposed[0].answer, "no");
});

test("two answers in one millisecond: the one that came last is the answer, as the server lists them newest first", () => {
  const state = { fixes: [], proposed: [proposed("k", 1)] };
  const at = ago(0.2);
  const no = { itemId: "weekly-learned-x", decision: "choice", choice: "Not now", rev: "r1", at };
  const yes = { itemId: "weekly-learned-x", decision: "choice", choice: "Yes", rev: "r2", at };
  syncAnswers(state, [yes, no]);
  assert.equal(state.proposed[0].answer, "yes");
  syncAnswers(state, [{ ...no, rev: "r3" }, yes, no]);
  assert.equal(state.proposed[0].answer, "no");
});

function harness({ statuses = [], state = emptyState(), replies = async () => [], addCard } = {}) {
  const calls = { cards: [], saves: [], logs: [] };
  return {
    calls,
    deps: (mode, over = {}) => ({
      mode,
      now: NOW,
      state,
      statuses: async () => statuses,
      replies,
      addCard: addCard ?? (async (card) => void calls.cards.push(card)),
      save: (s) => void calls.saves.push(structuredClone(s)),
      nonce: () => "n1",
      log: (event) => void calls.logs.push(event),
      ...over,
    }),
  };
}

test("no card at all when there is nothing to propose", async () => {
  const none = harness({ statuses: [status("ci", "a", 1), status("app", "g", 2)] });
  await runWeekly(none.deps("propose"));
  assert.deepEqual(none.calls.cards, []);
  assert.ok(none.calls.logs.includes("nothing-to-propose"));
  const empty = harness();
  await runWeekly(empty.deps("propose"));
  assert.deepEqual(empty.calls.cards, []);
});

test("no card when everything is held off by an earlier answer", async () => {
  const key = groupLearned([fix("ci", "a", 1, { prevent: "stop a" })], NOW)[0].key;
  const h = harness({ statuses: [status("ci", "a", 1, { prevent: "stop a" })], state: { fixes: [], proposed: [proposed(key, 10, "no", 10)] } });
  await runWeekly(h.deps("propose"));
  assert.deepEqual(h.calls.cards, []);
});

test("propose posts one card and remembers what it put up; a second run the same day posts none", async () => {
  const h = harness({ statuses: ["a", "b", "c", "d"].map((w) => status("ci", w, 1, { prevent: `stop ${w}` })) });
  const state = await runWeekly(h.deps("propose"));
  assert.equal(h.calls.cards.length, 1);
  assert.equal(state.proposed.length, 3);
  const again = harness({ state });
  await runWeekly(again.deps("propose"));
  assert.deepEqual(again.calls.cards, []);
});

test("record keeps the list of fixes and posts no card; a line back on the same item across two hourly runs counts twice", async () => {
  const first = harness({ statuses: [status("runner", "r", 3, { cause: "Disk full" })] });
  const state1 = await runWeekly(first.deps("record"));
  const second = harness({ statuses: [status("runner", "r", 1, { cause: "Disk full" })], state: state1 });
  const state2 = await runWeekly(second.deps("record"));
  assert.deepEqual([first.calls.cards, second.calls.cards], [[], []]);
  assert.equal(state2.fixes.length, 2);
  assert.equal(groupLearned(state2.fixes, NOW)[0].count, 2);
});

test("a create whose answer was lost keeps its proposals pending; the next run sends it again under the same id", async () => {
  const lost = harness({ statuses: [status("ci", "a", 1, { prevent: "stop a" })], addCard: async () => Promise.reject(new Error("timed out")) });
  await assert.rejects(runWeekly(lost.deps("propose")), /timed out/);
  const kept = lost.calls.saves.at(-1);
  assert.equal(kept.proposed.length, 1);
  assert.equal(kept.proposed[0].pending, true);
  const replied = [];
  const retry = harness({ state: kept, replies: async (cards) => (replied.push(...cards), []) });
  const after = await runWeekly(retry.deps("record"));
  assert.deepEqual(retry.calls.cards.map((c) => c.id), [cardId(NOW, "n1")]);
  assert.equal(after.proposed[0].pending, undefined);
  assert.deepEqual(replied, [cardId(NOW, "n1")]);
});

test("a card id carries a random suffix, so a card made first under the plain Sunday id is never read as ours", async () => {
  const h = harness({ statuses: [status("ci", "a", 1, { prevent: "stop a" })], replies: async () => [{ itemId: cardId(NOW), decision: "choice", choice: "Yes", rev: "r1", at: ago(0.1) }] });
  const after = await runWeekly(h.deps("propose"));
  assert.equal(h.calls.cards[0].id, "weekly-learned-20261025-n1");
  assert.equal(after.proposed[0].card, "weekly-learned-20261025-n1");
  const next = harness({ state: after, replies: h.deps("record").replies });
  assert.equal((await runWeekly(next.deps("record"))).proposed[0].answer, undefined);
});

test("an 'already exists' answer to the retry means the first create landed; other failures keep it pending", async () => {
  const state = { fixes: [], proposed: [{ ...proposed("k", 0.1), card: cardId(NOW, "n1"), pending: true }] };
  const exists = harness({ state, addCard: async () => Promise.reject(Object.assign(new Error("rivet exit 1"), { stderrFirstLine: "rivet: http 409: card x already exists" })) });
  assert.equal((await runWeekly(exists.deps("record"))).proposed[0].pending, undefined);
  const down = harness({ state, addCard: async () => Promise.reject(new Error("down")) });
  assert.equal((await runWeekly(down.deps("record"))).proposed[0].pending, true);
});

test("a pending card older than 3 days is dropped, not sent", async () => {
  const state = { fixes: [], proposed: [{ ...proposed("k", 4), pending: true }] };
  const h = harness({ state });
  assert.deepEqual((await runWeekly(h.deps("record"))).proposed, []);
  assert.deepEqual(h.calls.cards, []);
});

test("a rejection answered late is kept 30 days from the answer, though the card was posted over 60 days ago", async () => {
  const state = { fixes: [], proposed: [proposed("said:stop a", 63, "no", 4)] };
  const h = harness({ state, statuses: [status("ci", "a", 1, { prevent: "stop a" })], replies: async () => [] });
  const after = await runWeekly(h.deps("propose"));
  assert.equal(after.proposed.length, 1);
  assert.deepEqual(h.calls.cards, []);
});

test("an answered card is read again while its answer is under 30 days old", async () => {
  const asked = [];
  const state = { fixes: [], proposed: [proposed("k", 20, "yes", 19), { ...proposed("j", 50, "no", 40), card: "weekly-learned-old" }] };
  const h = harness({ state, replies: async (cards) => (asked.push(...cards), []) });
  await runWeekly(h.deps("record"));
  assert.deepEqual(asked, ["weekly-learned-x"]);
});

function passDeps({ mode, at = NOW, held = false, due = null, ran = [] }) {
  const calls = { due, ran, logs: [] };
  return {
    calls,
    deps: {
      mode,
      now: at,
      lock: () => (held ? null : () => calls.logs.push("released")),
      readDue: () => calls.due,
      writeDue: (when) => (calls.due = when),
      clearDue: () => (calls.due = null),
      run: async (m, week) => void ran.push(m) || (calls.week = week),
      log: (event) => calls.logs.push(event),
    },
  };
}

test("a Sunday run that cannot get the lock leaves a marker, and the next hourly run proposes and clears it", async () => {
  const busy = passDeps({ mode: "propose", held: true });
  await pass(busy.deps);
  assert.deepEqual(busy.calls.ran, []);
  assert.equal(busy.calls.due, NOW.toISOString());
  const next = passDeps({ mode: "record", at: new Date(NOW.getTime() + 3600_000), due: busy.calls.due });
  await pass(next.deps);
  assert.deepEqual(next.calls.ran, ["propose"]);
  assert.equal(next.calls.due, null);
});

test("an hourly run that cannot get the lock leaves no marker; a marker over 3 days old is no debt", async () => {
  const busy = passDeps({ mode: "record", held: true });
  await pass(busy.deps);
  assert.equal(busy.calls.due, null);
  const stale = passDeps({ mode: "record", due: ago(4) });
  await pass(stale.deps);
  assert.deepEqual(stale.calls.ran, ["record"]);
});

test("a propose run that fails keeps the marker for the next run", async () => {
  const failing = passDeps({ mode: "record", due: ago(0.1) });
  failing.deps.run = async () => Promise.reject(new Error("down"));
  await assert.rejects(pass(failing.deps), /down/);
  assert.equal(failing.calls.due, ago(0.1));
});

test("a Sunday propose run that holds the lock but fails leaves the marker, and the next hourly run proposes and clears it", async () => {
  const failing = passDeps({ mode: "propose" });
  failing.deps.run = async () => Promise.reject(new Error("status down"));
  await assert.rejects(pass(failing.deps), /status down/);
  assert.equal(failing.calls.due, NOW.toISOString());
  const next = passDeps({ mode: "record", at: new Date(NOW.getTime() + 3600_000), due: failing.calls.due });
  await pass(next.deps);
  assert.deepEqual(next.calls.ran, ["propose"]);
  assert.equal(next.calls.due, null);
});

test("a Sunday propose run that finishes clears its own marker; an older marker is not renewed by a retry", async () => {
  const done = passDeps({ mode: "propose" });
  await pass(done.deps);
  assert.equal(done.calls.due, null);
  const retry = passDeps({ mode: "record", due: ago(2) });
  retry.deps.run = async () => Promise.reject(new Error("down"));
  await assert.rejects(pass(retry.deps), /down/);
  assert.equal(retry.calls.due, ago(2));
});

test("a retry after midnight keeps the due week: it sends the saved card and makes no second one", async () => {
  const marker = passDeps({ mode: "record", at: new Date(NOW.getTime() + 6 * 3600_000), due: NOW.toISOString() });
  await pass(marker.deps);
  assert.deepEqual(marker.calls.ran, ["propose"]);
  assert.equal(marker.calls.week.toISOString(), NOW.toISOString());
  const monday = new Date(NOW.getTime() + 6 * 3600_000);
  const fixes = ["a", "b", "c", "d"].map((k) => fix("ci", k, 1, { prevent: `stop ${k}` }));
  const saved = { fixes, proposed: [{ ...proposed("said:stop a", 0.2), card: cardId(NOW, "n1"), pending: true }] };
  const h = harness({ state: saved });
  const after = await runWeekly(h.deps("propose", { now: monday, week: NOW }));
  assert.deepEqual(h.calls.cards.map((c) => c.id), [cardId(NOW, "n1")]);
  assert.equal(after.proposed.length, 1);
  assert.equal(after.proposed[0].pending, undefined);
});

test("the run's fix observations are saved before an answer read can fail", async () => {
  const state = { fixes: [], proposed: [proposed("k", 1)] };
  const h = harness({ state, statuses: [status("ci", "a", 1, { prevent: "stop a" })], replies: async () => Promise.reject(new Error("down")) });
  await assert.rejects(runWeekly(h.deps("propose")), /down/);
  assert.equal(h.calls.saves.at(-1).fixes.length, 1);
});

test("a status list that cannot be read stops the run before any save or post", async () => {
  const h = harness();
  await assert.rejects(runWeekly(h.deps("propose", { statuses: async () => Promise.reject(new Error("down")) })), /down/);
  assert.deepEqual([h.calls.cards, h.calls.saves], [[], []]);
});

test("a Yes is recorded in the state; answers that cannot be read stop a propose run", async () => {
  const key = groupLearned([fix("ci", "a", 1, { prevent: "stop a" })], NOW)[0].key;
  const state = { fixes: [], proposed: [{ ...proposed(key, 6), card: "weekly-learned-20261019" }] };
  const yes = harness({ state, replies: async () => [{ itemId: "weekly-learned-20261019", decision: "choice", choice: "Yes", at: ago(1) }] });
  const after = await runWeekly(yes.deps("record"));
  assert.equal(after.proposed[0].answer, "yes");
  assert.ok(yes.calls.logs.includes("accepted"));
  const broken = harness({ state, statuses: [status("ci", "b", 1, { prevent: "stop b" })], replies: async () => Promise.reject(new Error("down")) });
  await assert.rejects(runWeekly(broken.deps("propose")), /down/);
  assert.deepEqual(broken.calls.cards, []);
});

const handlerLog = (...entries) => entries.map(([handler, decision, days = 1]) => JSON.stringify({ handler, decision, reason: "why", at: ago(days) })).join("\n");

test("the look-back counts what the handlers did this week, one line", () => {
  const log = handlerLog(
    ["main-rerun", "rerun"], ["main-rerun", "rerun"], ["main-rerun", "rerun"],
    ["pr-rerun", "rerun"],
    ["main-rerun", "passed"], ["pr-rerun", "passed"], ["main-rerun", "passed"],
    ["main-rerun", "stayed-red"],
  );
  assert.equal(lookBackLine(log, NOW), "Re-ran 4 checks, 3 passed, 1 stayed red.");
  assert.equal(lookBackLine(handlerLog(["main-rerun", "rerun"]), NOW), "Re-ran 1 check, 0 passed, 0 stayed red.");
});

test("the look-back says nothing when the handlers did nothing: plan mode, refusals and old lines count for nothing", () => {
  assert.equal(lookBackLine("", NOW), "");
  const log = handlerLog(
    ["main-rerun", "would-rerun"], ["main-rerun", "refused"], ["main-rerun", "waiting"], ["pr-rerun", "would-rerun"],
    ["main-rerun", "rerun", 7], ["main-rerun", "passed", 8],
    ["main-rerun", "rerun", -1], ["other", "rerun"],
  );
  assert.equal(lookBackLine(log, NOW), "");
  assert.equal(lookBackLine("not json\n{\"handler\":\"main-rerun\",\"decision\":\"rerun\"}\nnull\n", NOW), "");
});

test("the look-back joins the Sunday card when one posts, and is no part of it otherwise", () => {
  const groups = [{ text: "Restart it", count: 2 }];
  assert.equal(renderCard(groups, "id").ask, "- Restart it (fixed 2 times)");
  assert.equal(renderCard(groups, "id", "Re-ran 1 check, 1 passed, 0 stayed red.").ask, "- Restart it (fixed 2 times)\n\nRe-ran 1 check, 1 passed, 0 stayed red.");
});

test("the card goes to rivet with its title, ask and options on stdin, never in the arguments", () => {
  const call = cardAddCall({ id: "learned-1", title: "Stop a", ask: "Should we?", options: ["Yes", "No"] }, "sam");
  assert.deepEqual(call.args, ["card", "add", "learned-1", "--args", "-"]);
  assert.deepEqual(JSON.parse(call.input), ["--kind", "decision", "--title", "Stop a", "--ask", "Should we?", "--option", "Yes", "--option", "No", "--chat", "sam"]);
  assert.ok(!JSON.parse(cardAddCall({ id: "learned-1", title: "Stop a", ask: "Should we?", options: ["Yes"] }).input).includes("--chat"), "no chat named, none sent");
});
