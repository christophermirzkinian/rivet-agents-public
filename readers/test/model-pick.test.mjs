import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CLAUDE_ARGS, TITLER_EFFORT, TITLER_MODEL, makeClaudeRun, titlerArgs } from "../../bridge/lib/threads-titler.mjs";
import { TASK_MODEL, chatArgs } from "../../bridge/lib/jobs.mjs";
import { READER_MODEL, Spend, ask, failedCallUsd, makeReaderRun, parseCliOutput, readerArgs, readersOn } from "../lib.mjs";
import { MAX_PICK_FILE_BYTES, readModelPick } from "../../bridge/lib/model-pick.mjs";
import { ROW_CLAUDE_ARGS, rowTitlerArgs } from "../../bridge/lib/row-titler.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-pick-"));
const picks = path.join(dir, "model-routing.json");
process.env.RIVET_MODEL_ROUTING_FILE = picks;
const pick = (jobs) => fs.writeFileSync(picks, JSON.stringify({ jobs, updated: { at: "2026-11-11T08:36:00+11:00", by: "owner", action: "set" } }));
const flag = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const SPEC = { name: "Issues", words: "look over the open issues", kind: "task", cron: "0 9 * * 1" };
const PATHS = { rivet: "/home/someone/rivet-rivet/bin/rivet", logDir: "/home/someone/.rivet/jobs/logs" };
const chat = () => chatArgs("j-abc12345", "r-run-0002", SPEC, PATHS);

test("with no file, or a pick its list does not allow, every job runs as before", () => {
  fs.rmSync(picks, { force: true });
  const before = { titler: titlerArgs(), reader: readerArgs("low", "sys"), chat: chat() };
  assert.equal(titlerArgs(), CLAUDE_ARGS);
  assert.equal(flag(before.titler, "--model"), TITLER_MODEL);
  assert.equal(flag(before.titler, "--effort"), TITLER_EFFORT);
  assert.equal(flag(before.reader, "--model"), READER_MODEL);
  assert.equal(flag(before.reader, "--effort"), "low");
  assert.equal(rowTitlerArgs(), ROW_CLAUDE_ARGS);
  assert.equal(flag(before.chat, "--model"), TASK_MODEL);
  assert.equal(flag(before.chat, "--effort"), null);
  for (const bad of [
    "not json",
    JSON.stringify({ jobs: [] }),
    JSON.stringify({ jobs: { "small-jobs": { model: "claude-fable-5-2", effort: "low" }, "work-chats": { model: "claude-haiku-5-5", effort: "high" } } }),
    JSON.stringify({ jobs: { "small-jobs": { model: "haiku", effort: "low" }, "work-chats": { model: "opus", effort: "high" } } }),
    JSON.stringify({ jobs: { "small-jobs": { model: "claude-sonnet-5", effort: "low" }, "work-chats": { model: "claude-sonnet-5", effort: "high" } } }),
    JSON.stringify({ jobs: { "small-jobs": { model: "claude-opus-5-5", effort: "huge" }, "work-chats": { model: "claude-opus-5-5" } } }),
  ]) {
    fs.writeFileSync(picks, bad);
    assert.equal(readModelPick("small-jobs"), null, bad);
    assert.equal(readModelPick("work-chats"), null, bad);
    assert.deepEqual(titlerArgs(), before.titler);
    assert.deepEqual(readerArgs("low", "sys"), before.reader);
    assert.deepEqual(chat(), before.chat);
  }
});

test("a picks file that is a FIFO, a link to one, or larger than 64 KiB reads as no pick, without blocking", (t) => {
  const jobs = { "small-jobs": { model: "claude-opus-5-5", effort: "high" } };
  const huge = path.join(dir, "huge.json");
  fs.writeFileSync(huge, JSON.stringify({ jobs, pad: "x".repeat(MAX_PICK_FILE_BYTES) }));
  assert.equal(readModelPick("small-jobs", huge), null);
  const fifo = path.join(dir, "picks.fifo");
  if (spawnSync("mkfifo", [fifo]).status !== 0) return t.skip("mkfifo is not available here");
  const link = path.join(dir, "picks-link.json");
  fs.symlinkSync(fifo, link);
  assert.equal(readModelPick("small-jobs", fifo), null);
  assert.equal(readModelPick("small-jobs", link), null);
});

test("a Small jobs pick sets the titlers' and readers' model and effort", () => {
  pick({ "small-jobs": { model: "claude-opus-5-5", effort: "high" } });
  try {
    assert.deepEqual([flag(titlerArgs(), "--model"), flag(titlerArgs(), "--effort")], ["claude-opus-5-5", "high"]);
    assert.deepEqual([flag(rowTitlerArgs(), "--model"), flag(rowTitlerArgs(), "--effort")], ["claude-opus-5-5", "high"]);
    assert.deepEqual([flag(readerArgs("low", "sys"), "--model"), flag(readerArgs("low", "sys"), "--effort")], ["claude-opus-5-5", "high"]);
    fs.rmSync(picks);
    assert.equal(rowTitlerArgs(), ROW_CLAUDE_ARGS);
  } finally {
    fs.rmSync(picks, { force: true });
  }
});

test("a reader call is priced and recorded on the model it was launched on, whatever the pick says by its end", { skip: !readersOn() && "the readers are off on this computer" }, async () => {
  const usage = { input_tokens: 10_000, output_tokens: 1000 };
  const answer = JSON.stringify({ is_error: false, result: "{}", usage });
  assert.ok(parseCliOutput(answer, "claude-opus-5-5").usd > parseCliOutput(answer).usd);
  assert.ok(failedCallUsd(new Error("x"), "hi", "claude-opus-5-5") > failedCallUsd(new Error("x"), "hi"));
  const stub = path.join(dir, "claude-reader");
  fs.writeFileSync(stub, `#!/bin/sh\ncat >/dev/null\necho '${answer}'\n`, { mode: 0o755 });
  const run = makeReaderRun(stub, { job: "memory-check", effort: "low", system: "sys" });
  const spendDir = fs.mkdtempSync(path.join(dir, "spend-"));
  pick({ "small-jobs": { model: "claude-opus-5-5", effort: "high" } });
  try {
    const spend = new Spend("memory-check", 100, { dir: spendDir });
    // The owner switches Small jobs to Haiku while the Opus call runs.
    await ask({ run: (input, launched) => run(input, (model) => (launched(model), fs.rmSync(picks))), spend, input: "hi" });
    assert.equal(spend.today.usd, parseCliOutput(answer, "claude-opus-5-5").usd);
    assert.equal(JSON.parse(fs.readFileSync(spend.file, "utf8")).model, "claude-opus-5-5");
  } finally {
    fs.rmSync(picks, { force: true });
  }
});

test("a Work chats pick sets an owner job's chat effort, and its model unless it is Fable", () => {
  pick({ "work-chats": { model: "claude-opus-5-5", effort: "max" } });
  try {
    assert.deepEqual([flag(chat(), "--model"), flag(chat(), "--effort")], ["claude-opus-5-5", "max"]);
    // Fable never runs here: the task's login has no room check, so it starts on Opus 5.5.
    pick({ "work-chats": { model: "claude-fable-5-2", effort: "xhigh" } });
    const args = chat();
    assert.equal(flag(args, "--model"), TASK_MODEL);
    assert.equal(TASK_MODEL, "claude-opus-5-5");
    assert.equal(flag(args, "--effort"), "xhigh");
    assert.equal(args.filter((arg) => arg === "--model").length, 1);
  } finally {
    fs.rmSync(picks, { force: true });
  }
});

test("a run made with a function asks it at each call, so a new pick reaches the next call", async () => {
  const stub = path.join(dir, "claude");
  fs.writeFileSync(stub, "#!/bin/sh\necho \"$@\"\n", { mode: 0o755 });
  let effort = "low";
  const run = makeClaudeRun(stub, () => ["-p", "--effort", effort], 10_000);
  assert.equal((await run("hi")).trim(), "-p --effort low");
  effort = "max";
  assert.equal((await run("hi")).trim(), "-p --effort max");
});
