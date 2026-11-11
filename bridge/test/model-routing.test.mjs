import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import table from "../../config/model-jobs.json" with { type: "json" };
import { createCommandFamily, validateCommand } from "../lib/actions/command.mjs";
import { ActionJournal } from "../lib/journal.mjs";
import { readModelReport, sendModelReport, validPicks, writePicks } from "../lib/model-routing.mjs";
import { StateStore } from "../lib/state.mjs";

const defaults = () => Object.fromEntries(table.jobs.map((job) => [job.key, { model: job.models[0], effort: job.effort }]));

/** A family writing into a temp dir, with every ack and report PUT recorded. */
function harness(dir, extra = {}) {
  const acks = [];
  const reports = [];
  const logs = [];
  /** Each ack and report in the order sent. */
  const order = [];
  const fetch = async (url, init) => {
    if (url.endsWith("/api/bridge/action-ack")) {
      acks.push(JSON.parse(init.body));
      order.push("ack");
    } else if (url.endsWith("/api/bridge/models")) {
      assert.equal(init.method, "PUT");
      assert.equal(init.headers.authorization, "Bearer tok");
      reports.push(JSON.parse(init.body));
      order.push("report");
      if (h.reportFails) return new Response("{}", { status: 502 });
      if (h.reportStale) return new Response(JSON.stringify({ ok: true, stale: true }), { status: 200 });
    } else throw new Error(`unexpected ${url}`);
    return new Response("{}", { status: 200 });
  };
  const ctx = {
    deps: { origin: "https://rivet.test", token: "tok", fetch, state: new StateStore(path.join(dir, "state.json")), log: (event, data) => logs.push({ event, ...data }) },
    listTerminals: async () => [],
    sendLine: async () => ({ confirmed: true, stages: [] }),
  };
  const file = path.join(dir, "rivet", "model-routing.json");
  const statusFile = path.join(dir, "rivet", "model-routing-status.json");
  const family = createCommandFamily({ sleep: async () => {}, repoRoot: () => null, modelRoutingFile: file, modelStatusFile: statusFile, ...extra });
  const h = { acks, reports, order, logs, ctx, family, file, statusFile, reportFails: false, reportStale: false };
  return h;
}

async function inTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-models-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("models: the picks are written whole, private, with no temp file left; reported, then acked succeeded", () =>
  inTemp(async (dir) => {
    const h = harness(dir);
    const jobs = { ...defaults(), monitor: { model: "claude-fable-5-2", effort: "xhigh" } };
    assert.equal(await h.family.handle("models", { id: "m1", at: "2026-11-11T08:14:00.000Z", models: jobs, base: null }, h.ctx), "delivered");
    await h.family.idle();
    const doc = JSON.parse(fs.readFileSync(h.file, "utf8"));
    assert.deepEqual(doc.jobs, jobs);
    assert.deepEqual(Object.keys(doc.updated).sort(), ["action", "at", "by"]);
    assert.equal(doc.updated.action, "m1");
    assert.equal(fs.statSync(h.file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(h.file)), ["model-routing.json"]);
    assert.equal(h.acks.length, 1);
    assert.equal(h.acks[0].status, "succeeded");
    assert.match(h.acks[0].detail.reason, /read back/);
    assert.equal(h.reports.length, 1);
    assert.deepEqual(h.reports[0].file.jobs, jobs);
    assert.equal(h.reports[0].file.updated.action, "m1");
    assert.deepEqual(h.order, ["report", "ack"]);
  }));

test("models: a report the server turns away is logged, and the write is still acked", () =>
  inTemp(async (dir) => {
    const h = harness(dir);
    h.reportFails = true;
    await h.family.handle("models", { id: "f1", at: "2026-11-11T08:14:00.000Z", models: defaults(), base: null }, h.ctx);
    await h.family.idle();
    assert.deepEqual(h.order, ["report", "ack"]);
    assert.equal(h.acks[0].status, "succeeded");
    assert.ok(h.logs.some((l) => l.event === "models-report-failed" && l.id === "f1"));
  }));

test("models: a pick off the allowed list is refused and nothing is written, and reported after the ack", () =>
  inTemp(async (dir) => {
    const h = harness(dir);
    for (const [id, models] of [
      ["bad1", { ...defaults(), monitor: { model: "gpt-6.1-sol", effort: "high" } }],
      ["bad2", { ...defaults(), "night-jobs": { model: "gpt-6.1-sol", effort: "max" } }],
      ["bad3", { ...defaults(), "work-chats": { model: "claude-sonnet-5", effort: "high" } }],
      ["bad4", { ...defaults(), extra: { model: "claude-opus-5-5", effort: "high" } }],
      ["bad5", "everything"],
    ]) {
      assert.equal(await h.family.handle("models", { id, at: "2026-11-11T08:14:00.000Z", models, base: null }, h.ctx), "delivered");
    }
    await h.family.idle();
    assert.equal(fs.existsSync(h.file), false);
    assert.deepEqual(h.acks.map((a) => a.status), ["refused", "refused", "refused", "refused", "refused"]);
    assert.deepEqual(h.order, Array(5).fill(["ack", "report"]).flat());
  }));

/** The picks file as a save `action` wrote it. */
function writeFile(file, jobs, action) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ jobs, updated: { at: "2026-11-11T08:00:00.000Z", by: "The owner (Rivet)", action } }));
}

test("models: a save made over the file the screen saw is written; one made over an older view is refused, the file left as it was", () =>
  inTemp(async (dir) => {
    const h = harness(dir);
    writeFile(h.file, defaults(), "a1");
    const before = fs.readFileSync(h.file, "utf8");
    const fable = { ...defaults(), monitor: { model: "claude-fable-5-2", effort: "high" } };
    for (const [id, base] of [["stale", "a0"], ["none", null], ["missing", undefined]]) {
      await h.family.handle("models", { id, at: "2026-11-11T08:14:00.000Z", models: fable, ...(base === undefined ? {} : { base }) }, h.ctx);
    }
    await h.family.idle();
    assert.equal(fs.readFileSync(h.file, "utf8"), before);
    assert.deepEqual(h.acks.map((a) => a.status), ["refused", "refused", "refused"]);
    assert.equal(h.acks[0].detail.reason, "Changed on another screen first, so nothing was written. Showing the latest.");
    assert.equal(h.acks[1].detail.reason, h.acks[0].detail.reason);
    assert.match(h.acks[2].detail.reason, /nothing was written/);
    await h.family.handle("models", { id: "ok", at: "2026-11-11T08:14:00.000Z", models: fable, base: "a1" }, h.ctx);
    await h.family.idle();
    const doc = JSON.parse(fs.readFileSync(h.file, "utf8"));
    assert.equal(doc.updated.action, "ok");
    assert.deepEqual(doc.jobs, fable);
    assert.equal(h.acks[3].status, "succeeded");
  }));

test("models: a picks file there but unreadable is refused, nothing written", () =>
  inTemp(async (dir) => {
    const h = harness(dir);
    fs.mkdirSync(path.dirname(h.file), { recursive: true });
    fs.writeFileSync(h.file, "not json");
    await h.family.handle("models", { id: "u1", at: "2026-11-11T08:14:00.000Z", models: defaults(), base: null }, h.ctx);
    await h.family.idle();
    assert.equal(fs.readFileSync(h.file, "utf8"), "not json");
    assert.equal(h.acks[0].status, "refused");
    assert.equal(h.acks[0].detail.reason, "Can't read the Mac's picks file, so nothing was written.");
    assert.deepEqual(h.order, ["ack", "report"]);
  }));

test("models: a failed write is reported before its ack and again after it", { skip: process.getuid?.() === 0 && "root writes through 0o500" }, () =>
  inTemp(async (dir) => {
    const h = harness(dir);
    // A folder the temp file can't be made in.
    fs.mkdirSync(path.dirname(h.file), { recursive: true });
    fs.chmodSync(path.dirname(h.file), 0o500);
    try {
      await h.family.handle("models", { id: "w1", at: "2026-11-11T08:14:00.000Z", models: defaults(), base: null }, h.ctx);
      await h.family.idle();
    } finally {
      fs.chmodSync(path.dirname(h.file), 0o700);
    }
    assert.equal(h.acks[0].status, "failed");
    assert.deepEqual(h.order, ["report", "ack", "report"]);
  }));

test("models: two quick saves are written one after another, so the last one wins", () =>
  inTemp(async (dir) => {
    const h = harness(dir);
    const first = { ...defaults(), monitor: { model: "claude-fable-5-2", effort: "high" } };
    const second = { ...defaults(), monitor: { model: "claude-opus-5-5", effort: "max" } };
    await h.family.handle("models", { id: "q1", at: "2026-11-11T08:14:00.000Z", models: first, base: null }, h.ctx);
    await h.family.handle("models", { id: "q2", at: "2026-11-11T08:14:01.000Z", models: second, base: "q1" }, h.ctx);
    await h.family.idle();
    const doc = JSON.parse(fs.readFileSync(h.file, "utf8"));
    assert.deepEqual(doc.jobs, second);
    assert.equal(doc.updated.action, "q2");
    assert.deepEqual(h.acks.map((a) => [a.id, a.status]), [["q1", "succeeded"], ["q2", "succeeded"]]);
  }));

test("models: the same action sent again is answered from the journal, not written twice", () =>
  inTemp(async (dir) => {
    const h = harness(dir);
    const jobs = defaults();
    await h.family.handle("models", { id: "r1", at: "2026-11-11T08:14:00.000Z", models: jobs, base: null }, h.ctx);
    await h.family.idle();
    const written = fs.statSync(h.file).mtimeMs;
    await h.family.handle("models", { id: "r1", at: "2026-11-11T08:14:00.000Z", models: jobs, base: null }, h.ctx);
    await h.family.idle();
    assert.equal(fs.statSync(h.file).mtimeMs, written);
    assert.deepEqual(h.acks.map((a) => a.status), ["succeeded", "succeeded"]);
    assert.ok(h.logs.some((l) => l.event === "models-repeat"));
  }));

test("validPicks takes exactly the allowlist", () => {
  assert.deepEqual(validPicks(defaults()), defaults());
  assert.equal(validPicks({ ...defaults(), "review-lens": { model: "claude-haiku-5-5", effort: "high" } }), null);
  assert.equal(validPicks({ ...defaults(), monitor: { model: "opus", effort: "high" } }), null);
  assert.equal(validPicks({ ...defaults(), "review-lens": { model: "gpt-6.1-sol", effort: "high" } }), null);
  assert.ok(validPicks({ ...defaults(), "review-lens": { model: "gpt-6.1-sol", effort: "xhigh" } }));
  assert.ok(validPicks({ ...defaults(), "review-lens": { model: "claude-fable-5-2", effort: "max" } }));
  assert.equal(validPicks({ ...defaults(), "review-lens": { model: "claude-opus-5-5", effort: "low" } }), null);
  assert.equal(validPicks({ ...defaults(), "review-lens": { model: "claude-fable-5-2", effort: "medium" } }), null);
  assert.ok(validPicks({ ...defaults(), "review-lens": { model: "claude-opus-5-5", effort: "high" } }));
  assert.ok(validPicks({ ...defaults(), monitor: { model: "claude-opus-5-5", effort: "low" } }));
  assert.ok(validPicks({ ...defaults(), "night-jobs": { model: "gpt-6.1-sol", effort: "low" } }));
  const { monitor: _, ...missing } = defaults();
  assert.equal(validPicks(missing), null);
  assert.equal(validPicks(null), null);
});

test("readModelReport: no file is no picks; status keeps only well-formed fallbacks for known jobs", () =>
  inTemp(async (dir) => {
    const file = path.join(dir, "model-routing.json");
    const statusFile = path.join(dir, "model-routing-status.json");
    const { readAt: first, run, ...none } = await readModelReport({ file, statusFile });
    assert.deepEqual(none, { file: null, status: {} });
    assert.ok(Number.isInteger(first) && first > 0);
    assert.ok(typeof run === "string" && run.length > 0 && run.length <= 100);
    assert.equal((await readModelReport({ file, statusFile })).run, run, "one run for the process");
    // The shape scripts/model-routing.mjs writeModelStatus writes.
    const at = "2026-11-11T08:00:00.000Z";
    const fable = { model: "claude-fable-5-2", effort: "high" };
    const fallback = { picked: fable, model: "claude-opus-5-5", effort: "high", reason: "Fable has no room (weekly 86%): Opus 5.5 until it does", at };
    const resolved = { picked: fable, ...fable, reason: "resolved at chat start", at };
    const refused = { picked: null, model: "claude-haiku-5-5", effort: "medium", reason: null, at };
    fs.writeFileSync(
      statusFile,
      JSON.stringify({ jobs: { "hard-problem": fallback, monitor: resolved, "small-jobs": refused, nobody: fallback, "work-chats": { ...fallback, extra: 1 } } }),
    );
    fs.writeFileSync(file, "not json");
    const report = await readModelReport({ file, statusFile });
    assert.equal(report.file, null);
    assert.equal(typeof report.fileError, "string");
    assert.deepEqual(report.status, {
      "hard-problem": { model: "claude-opus-5-5", effort: "high", reason: fallback.reason, at },
      "small-jobs": { model: "claude-haiku-5-5", effort: "medium", reason: "", at },
    });
    // A flat file (no "jobs") is not the writer's shape: nothing shown.
    fs.writeFileSync(statusFile, JSON.stringify({ "hard-problem": fallback }));
    assert.deepEqual((await readModelReport({ file, statusFile })).status, {});
  }));

test("readModelReport: each report is stamped when it was read, later than the one before even within one ms", () =>
  inTemp(async (dir) => {
    const opts = { file: path.join(dir, "model-routing.json"), statusFile: path.join(dir, "model-routing-status.json") };
    const stamps = [];
    for (let i = 0; i < 5; i += 1) stamps.push((await readModelReport(opts)).readAt);
    for (let i = 1; i < stamps.length; i += 1) assert.ok(stamps[i] > stamps[i - 1], `${stamps[i]} after ${stamps[i - 1]}`);
  }));

test("sendModelReport: reports leave one at a time, in the order they were read", () =>
  inTemp(async (dir) => {
    const opts = { file: path.join(dir, "model-routing.json"), statusFile: path.join(dir, "model-routing-status.json") };
    /** @type {number[]} */
    const sent = [];
    let inFlight = 0;
    const fetch = async (/** @type {string} */ _url, /** @type {RequestInit} */ init) => {
      inFlight += 1;
      assert.equal(inFlight, 1);
      const { readAt } = JSON.parse(String(init.body));
      await new Promise((resolve) => setTimeout(resolve, sent.length === 0 ? 30 : 1));
      sent.push(readAt);
      inFlight -= 1;
      return new Response(null, { status: 200 });
    };
    const deps = { origin: "http://bridge.test", token: "t", fetch: /** @type {typeof globalThis.fetch} */ (/** @type {unknown} */ (fetch)) };
    await Promise.all([sendModelReport(deps, opts), sendModelReport(deps, opts), sendModelReport(deps, opts)]);
    assert.equal(sent.length, 3);
    assert.ok(sent[0] < sent[1] && sent[1] < sent[2]);
  }));

test("models event: the payload's picks are passed on, so a bad one is refused rather than dropped", () => {
  const ok = validateCommand("models", { id: "v1", at: "2026-11-11T08:14:00.000Z", models: "anything", base: "a1" });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.models, "anything");
  assert.equal(ok.value.base, "a1");
});

test("models after a restart: an unfinished save answered on reconnect is reported after its ack", () =>
  inTemp(async (dir) => {
    const h = harness(dir);
    await h.family.handle("actions.outstanding", { id: "o1", actions: [{ id: "lost1", kind: "models" }] }, h.ctx);
    await h.family.idle();
    assert.equal(h.acks[0].id, "lost1");
    assert.deepEqual(h.order, ["ack", "report"]);
  }));

test("models after a restart: a save the picks file took is acked succeeded; one it didn't, failed", () =>
  inTemp(async (dir) => {
    const journal = new ActionJournal(path.join(dir, "actions.json"));
    journal.start("took", "models", "2026-11-11T08:14:00.000Z");
    journal.start("lost", "models", "2026-11-11T08:15:00.000Z");
    const h = harness(dir);
    writeFile(h.file, defaults(), "took");
    await h.family.handle("actions.outstanding", { id: "o1", actions: [{ id: "took", kind: "models" }] }, h.ctx);
    await h.family.idle();
    assert.equal(h.acks[0].id, "took");
    assert.equal(h.acks[0].status, "succeeded");
    assert.equal(h.acks[0].detail.reason, "Saved to model-routing.json and read back.");
    writeFile(h.file, defaults(), "other");
    await h.family.handle("actions.outstanding", { id: "o2", actions: [{ id: "lost", kind: "models" }] }, h.ctx);
    await h.family.idle();
    assert.equal(h.acks[1].id, "lost");
    assert.equal(h.acks[1].status, "failed");
    assert.match(h.acks[1].detail.reason, /^the Mac restarted while saving these picks/);
    assert.deepEqual(h.order, ["ack", "report", "ack", "report"]);
  }));

test("models: a write that fails after its rename, with the file holding the save, is reported then acked succeeded", () =>
  inTemp(async (dir) => {
    const h = harness(dir, {
      writePicks: async (picks, opts) => {
        await writePicks(picks, opts);
        return { status: "failed", reason: "wrote model-routing.json but could not flush its folder: EIO" };
      },
    });
    const fable = { ...defaults(), monitor: { model: "claude-fable-5-2", effort: "high" } };
    await h.family.handle("models", { id: "f1", at: "2026-11-11T08:14:00.000Z", models: fable, base: null }, h.ctx);
    await h.family.idle();
    assert.equal(JSON.parse(fs.readFileSync(h.file, "utf8")).updated.action, "f1");
    assert.equal(h.acks[0].status, "succeeded");
    assert.equal(h.acks[0].detail.reason, "Saved to model-routing.json and read back.");
    assert.deepEqual(h.order, ["report", "ack"]);
    assert.equal(h.reports[0].file.updated.action, "f1");
  }));

test("models: the base is read as the report reads it, so a file whose updated block is out of shape takes base null", () =>
  inTemp(async (dir) => {
    const h = harness(dir);
    fs.mkdirSync(path.dirname(h.file), { recursive: true });
    fs.writeFileSync(h.file, JSON.stringify({ jobs: defaults(), updated: { action: "a1", at: "bad" } }));
    assert.equal((await readModelReport({ file: h.file, statusFile: h.statusFile })).file.updated, undefined);
    await h.family.handle("models", { id: "b1", at: "2026-11-11T08:14:00.000Z", models: defaults(), base: null }, h.ctx);
    await h.family.idle();
    assert.equal(h.acks[0].status, "succeeded");
    assert.equal(JSON.parse(fs.readFileSync(h.file, "utf8")).updated.action, "b1");
  }));

test("models reports carry the bridge's run, and one the server answers stale is logged", () =>
  inTemp(async (dir) => {
    const h = harness(dir);
    h.reportStale = true;
    await h.family.handle("models", { id: "r1", at: "2026-11-11T08:14:00.000Z", models: defaults(), base: null }, h.ctx);
    await h.family.idle();
    assert.equal(typeof h.reports[0].run, "string");
    assert.ok(h.reports[0].run.length > 0);
    const stale = h.logs.filter((line) => line.event === "models-report-stale");
    assert.equal(stale.length, 1);
    assert.deepEqual(Object.keys(stale[0]).sort(), ["event", "readAt", "run"]);
    assert.equal(h.acks[0].status, "succeeded");
  }));
