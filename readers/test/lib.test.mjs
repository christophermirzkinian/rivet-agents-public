import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { shapeText } from "../../bridge/lib/redact-cut.mjs";
import { redactLines } from "../../bridge/lib/redact.mjs";
import { zoneDay } from "../../bridge/lib/spend.mjs";
import { claudeArgs } from "../../bridge/lib/threads-titler.mjs";
import { BadAnswer, CeilingReached, CliError, READER_MAX_OUTPUT_TOKENS, READER_MODEL, ReadersOff, Spend, appendJsonl, ask, failedCallUsd, oneLine, parseCliOutput, plainText, redact, redactLog, takeLock, writeJsonAtomic, makeReaderRun, makeRivetCli, readersOn } from "../lib.mjs";

// The linear-time guards below time CPU, not the wall clock: a loaded runner stalls a run until its CPU quota
// refills, while a quadratic or backtracking parse still costs the CPU it always did.
const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "readers-"));
const USERS = ["", "Users", ""].join("/");
const cli = (result, usage = { input_tokens: 1000, output_tokens: 100 }) => JSON.stringify({ is_error: false, subtype: "success", result, usage });
const TOKEN = `${"gh"}p_${"A1b2C3d4E5".repeat(4)}`;

test("readers run Haiku 5.5 through the titler's flags, with no sampling parameters", () => {
  const args = claudeArgs(READER_MODEL, "low", "sys");
  assert.equal(READER_MODEL, "claude-haiku-5-5");
  assert.deepEqual(args.slice(0, 5), ["-p", "--model", "claude-haiku-5-5", "--effort", "low"]);
  assert.ok(args.includes("--no-session-persistence") && args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  for (const flag of ["--temperature", "--top-p", "--top_p", "--top-k", "--top_k"]) assert.ok(!args.includes(flag));
});

test("parseCliOutput returns the answer's object and prices it at Haiku 5.5's row", () => {
  const { answer, usd } = parseCliOutput(cli('Here: {"state": "working"}'));
  assert.deepEqual(answer, { state: "working" });
  assert.equal(usd, (1000 * 0.1 + 100 * 0.5) / 1e6);
});

test("parseCliOutput: an error answer is a CliError, prose with no object a BadAnswer, both carrying the cost", () => {
  const error = JSON.stringify({ is_error: true, subtype: "error_during_execution", usage: { input_tokens: 10 } });
  assert.throws(() => parseCliOutput(error), (err) => err instanceof CliError && err.usd > 0);
  assert.throws(() => parseCliOutput(cli("no object here")), (err) => err instanceof BadAnswer && err.usd > 0);
  assert.throws(() => parseCliOutput(cli("[1, 2]")), BadAnswer);
  assert.throws(() => parseCliOutput("not json"), CliError);
  const refused = JSON.stringify({ type: "result", subtype: "success", is_error: true, stop_reason: "refusal", result: "API Error: declined" });
  assert.throws(() => parseCliOutput(refused), (err) => err instanceof CliError && err.message === "claude refused");
});

test("redact and redactLog read a secret's key through the Markdown marks closing over it", () => {
  for (const key of ["**password**", "*token*", "`api_key`", "**`DB_PASSWORD`**", "~~secret~~", "**password**\u200b", '**"password"**', '`"password"`', '"**password**"', '__"password"__', "__password__"]) {
    assert.ok(!redact(`${key}: hunter2value`).includes("hunter2value"), key);
    assert.ok(!redactLog([`${key}:`, "  hunter2value"]).includes("hunter2value"), key);
  }
  assert.equal(redactLog(["**Round** ends: soon", "`scripts/x.mjs`"]), "**Round** ends: soon\n`scripts/x.mjs`");
  // Marks after a word or an underscore that the name runs on from.
  for (const key of ["ENV_**PASSWORD**", "DB_**password**", "prefix**password**"]) {
    assert.ok(!redact(`${key}: hunter2`).includes("hunter2"), key);
    assert.ok(!redactLog([`${key}: hunter2`]).includes("hunter2"), key);
    assert.ok(!redactLog([`${key}:`, "  hunter2"]).includes("hunter2"), key);
  }
  // Keys the readers read through quotes too, and the lines a marked key's value may run over.
  for (const line of [`a_'**secret**: [hunter2`, `prefix"**client_secret**": "hunter2 two`, `  "**client_secret**"": "hunter2`]) {
    assert.ok(!redact(line).includes("hunter2"), line);
    assert.ok(!redactLog([line]).includes("hunter2"), line);
  }
  assert.ok(!redactLog(["ENV_**PASSWORD**: x", ...Array(35).fill("padding"), "hunter2"]).includes("hunter2"));
  // An array opened far into a line stays open to its closing bracket.
  assert.ok(!redactLog([`{"note": "${"n".repeat(2_100)}", "password": [`, ...Array(45).fill('  "pad",'), '  "hunter2"', "]}"]).includes("hunter2"));
  // A key read on its logical line: marks before a continuation, the name or the separator carried over, spaced marks.
  const continued = [["**password**\\", ": copperLake"], ["password\\", "**: copperLake"], ["**pass\\", "word**: copperLake"], ["**password**\\", "  **: copperLake"]];
  for (const lines of continued) {
    assert.ok(!redact(lines).includes("copperLake"), lines[0]);
    assert.ok(!redactLog(lines).includes("copperLake"), lines[0]);
  }
  // Quotes alone are JSON's, read by the redactor itself; marks that close over no key stay.
  assert.equal(redact('{"name": "x"} and **Why:** `scripts/x.mjs`'), '{"name": "x"} and **Why:** `scripts/x.mjs`');
  // A step header's closing line is read as any other.
  assert.ok(!redactLog(["##[group]Run step", "##[endgroup] password: `copperLake`"]).includes("copperLake"));
  // Text that is not a runner's log has no step headers, and a one-word PASS key opens a plain value there.
  const note = (/** @type {string[]} */ lines) => redactLog(lines, undefined, { runnerLog: false });
  assert.ok(!note(["##[group]Run step", "password:", "##[endgroup]", "  `copperLake`"]).includes("copperLake"));
  assert.ok(!note(["pass: first", ...Array(10).fill("  alpha"), "  `copperLake`"]).includes("copperLake"));
  assert.equal(redactLog(["PASS: 12 tests", ...Array(10).fill("ok"), "next"]).split("\n").at(-1), "next");
  // A quoted key stays quoted, so a one-word PASS key that was quoted still opens a plain value in a runner's log.
  assert.ok(!redactLog(['**"pass"**: first', ...Array(10).fill("  alpha"), "  copperLake"]).includes("copperLake"));
  // A plain value opened on a continued line holds the rest.
  assert.ok(!note(["**password**\\", ": first", ...Array(10).fill("  alpha"), "  `copperLake`"]).includes("copperLake"));
  // A continued line is dropped whole, one line out for each line in, and only it and the held lines when it has no
  // secret in it.
  const tail = Array.from({ length: 11 }, (_, i) => `line ${i}`);
  assert.deepEqual(redactLog(["echo a\\", "  b", ...tail]).split("\n"), [...Array(12).fill("[redacted]"), "line 10"]);
  // Split and joined as the redactor splits and joins: a token joined to the word before it, a key before two
  // backslashes, a key split at a Unicode line break.
  const hiding = [["prefix\\", "Bearer copperLake"], ["**password**\\\\", ": copperLake"], ["**pass\\\u2028word**: copperLake"], ["**pass\\\u2029word**: copperLake"]];
  for (const lines of hiding) {
    assert.ok(!redact(lines).includes("copperLake"), JSON.stringify(lines));
    assert.ok(!redactLog(lines).includes("copperLake"), JSON.stringify(lines));
  }
  // One line out for each line in, whatever breaks a line holds.
  assert.equal(redactLog(["a\u2028b", "c\\", "d", "e"]).split("\n").length, 4);
  // A line is read whole (controls out) and in the parts the redactor splits it into: a key joined by a control, a
  // token after one, a terminal title, an authorisation scheme split over continued lines.
  const broken = [..."\r\v\f\x85".split("").map((c) => [`pass${c}word: copperLake`]), ["prefix\rBearer copperLake"], ["\u001b]0;password:\u2028copperLake\u0007"], ["prefix\\", "Bear\\", "er copperLake"]];
  for (const lines of broken) {
    assert.ok(!redact(lines).includes("copperLake"), JSON.stringify(lines));
    assert.ok(!redactLog(lines).includes("copperLake"), JSON.stringify(lines));
  }
  // A step header that starts after a break inside a line is still a header, and its opening row goes too.
  assert.ok(!redactLog(["progress\u2028##[group]Run step", "  copperLake", "##[endgroup]"]).includes("copperLake"));
  assert.ok(!redactLog(["progress\r##[group]Run echo copperLake", "##[endgroup]"]).includes("copperLake"));
  // A key split over a continuation, and a secret's state opened behind a break, drop the rest.
  const opened = [
    ["api\\", "_key:", ...Array(10).fill("  alpha"), "  copperLake"],
    ["se\\", "cret='", ...Array(10).fill("alpha"), "copperLake", "'"],
    ["password:\rfirst", ...Array(10).fill("  alpha"), "  copperLake"],
    ["prefix\r--password '", ...Array(10).fill("alpha"), "copperLake", "'"],
    ["api\r_key:\rfirst", ...Array(10).fill("  alpha"), "  copperLake"],
    ["prefix\r-u 'admin:\\", ...Array(11).fill("alpha"), "copperLake", "'"],
    ["password: '\r##[group]Run step", "##[endgroup]", "copperLake", "'"],
    ["curl --us\\", "er 'admin:\r##[group]Run step", "##[endgroup]", ...Array(10).fill("alpha"), "copperLake", "'"],
  ];
  // Inside an open header too.
  for (const lines of [
    ["##[group]Run curl --us\\", "er 'admin:\r##[group]Run step", "##[endgroup]", ...Array(10).fill("alpha"), "copperLake", "'", "##[endgroup]"],
    ["##[group]Run step", "curl --us\\", "er 'admin:\r##[group]Run step", "##[endgroup]", ...Array(10).fill("alpha"), "copperLake", "'"],
  ]) {
    assert.ok(!redactLog(lines).includes("copperLake"), JSON.stringify(lines[1]));
  }
  for (const lines of opened) {
    assert.ok(!redact(lines).includes("copperLake"), JSON.stringify(lines[0]));
    assert.ok(!redactLog(lines).includes("copperLake"), JSON.stringify(lines[0]));
    assert.ok(!note(lines).includes("copperLake"), JSON.stringify(lines[0]));
  }
  // A text's own CRLF endings are not breaks inside a line.
  assert.equal(redact("Tests passed\r\nsee `scripts/x.mjs`\r\n"), "Tests passed\nsee `scripts/x.mjs`\n");
  assert.equal(redactLog(["Tests passed\r", "next\r"]), "Tests passed\nnext");
});

test("redact and redactLog take linear time in a line's length: a long token or run of marks is scanned once", () => {
  // A marked name's line is read as written too, where a long name has no colon right after it.
  // Backtracking grows quadratically (about 10 s at this length before the fix); a linear read takes tens of ms, so 1 s leaves headroom on a loaded runner.
  const n = 16_384;
  // An underscore run before a separator, with no quote after it, and a flag with a long name
  // and no separator (round 5).
  for (const line of [`**${"password".repeat(n)}**: hunter2`, `password${"_".repeat(131_072)}: x`, `--${"password".repeat(n)}`, `--${"password".repeat(n)}!`]) {
    const took = Math.min(
      ...[0, 1, 2].map(() => {
        const started = cpuMs();
        redactLog([line]);
        redactLines([line], { inKey: false }, "/synthetic");
        return cpuMs() - started;
      }),
    );
    assert.ok(took < 1_000, `${line.slice(0, 12)}: ${took} ms`);
  }
  // An escape keeps a line under the inspection limit whole, so the rules run on it before it is cut (review round 6).
  for (const count of [1024, 2048, 4096, 8191]) {
    const line = `--${"password".repeat(count)}\\t`;
    const took = Math.min(
      ...[0, 1, 2].map(() => {
        const started = cpuMs();
        redactLines([line], { inKey: false }, "/synthetic");
        return cpuMs() - started;
      }),
    );
    assert.ok(took < 1_000, `${count}: ${took} ms`);
  }
  // Long hyphenated runs, each dash a fresh start for a name scan (review round 7).
  for (const size of [4096, 16_384, 64_512]) {
    const fill = (/** @type {string} */ unit, head = "", tail = "") => head + unit.repeat(Math.floor((size - head.length - tail.length) / unit.length)) + tail;
    for (const line of [fill("--", "", "password\\t"), fill("password-", "--", "\\t"), fill("--password", "", "\\t")]) {
      const took = Math.min(
        ...[0, 1, 2].map(() => {
          const started = cpuMs();
          redactLines([line], { inKey: false }, "/synthetic");
          return cpuMs() - started;
        }),
      );
      assert.ok(took < 1_000, `${line.slice(0, 12)} ×${size}: ${took} ms`);
    }
  }
  for (const line of ["a".repeat(32_768), "_".repeat(32_768), `password${"_".repeat(32_768)}x`, `${"*".repeat(32_768)}password`, "password".repeat(16_384)]) {
    for (const run of [() => redact(line), () => redactLog([line]), () => redact([`${line}\\`, " b"])]) {
      const started = cpuMs();
      run();
      assert.ok(cpuMs() - started < 300, `${line.slice(0, 20)}… took too long`);
    }
  }
});

test("redactLog reads a line of many secret keys in linear time", () => {
  // Each key counted the brackets of the whole line again: about 1.9 s for 3,000 keys before the fix, tens of ms after.
  const keys = JSON.stringify(Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`TOKEN_${i}`, []])));
  for (const line of [keys, "token: *** ".repeat(5000)]) {
    const took = Math.min(
      ...[0, 1, 2].map(() => {
        const started = cpuMs();
        redactLog([line, "next"], "/synthetic");
        return cpuMs() - started;
      }),
    );
    assert.ok(took < 300, `${line.slice(0, 12)}: ${took} ms`);
  }
});

test("redactLog judges a long line on the redactor's whole output, and clips it only after", () => {
  // The secret sits past the length cap: clipped first, the line read as unchanged and the value's next line went out.
  const plainValue = redactLog(["tidy ".repeat(120) + "password: correct horse", "  battery staple"]);
  assert.ok(!plainValue.includes("battery") && !plainValue.includes("horse"), plainValue);
  assert.deepEqual(plainValue.split("\n"), ["[redacted]", "[redacted]"]);
  const inline = redactLog(["tidy ".repeat(120) + "API_KEY=rose", "after"]).split("\n");
  assert.ok(!inline.join("\n").includes("rose"));
  assert.deepEqual(inline, ["[redacted]", "[redacted]"]);
  // A long clean line is still kept, cut at the cap, and the line after it is read as usual.
  const [long, next] = redactLog(["tidy ".repeat(200), "after"]).split("\n");
  assert.ok(long.length === 500 && long.endsWith("…") && "tidy ".repeat(200).startsWith(long.slice(0, -1)), long);
  assert.equal(next, "after");
  // Past what is judged whole, a line is dropped unread, in time: a run of dashes is quadratic for the redactor unclipped.
  for (const size of [8000, 8001, 64_000]) {
    const started = cpuMs();
    const out = redactLog(["-".repeat(size), "after"]).split("\n");
    assert.ok(cpuMs() - started < 1_000, `${size}: too slow`);
    if (size > 8000) assert.equal(out[0], "[redacted]");
  }
});

test("redact and oneLine take secrets and home paths out; oneLine flattens and caps", () => {
  const home = os.homedir();
  assert.ok(!redact([`token ${TOKEN}`, `${home}/x`]).includes(TOKEN));
  assert.ok(!redact(`${home}/secret/place`).includes(home));
  const line = oneLine(`Pushing\n\twith ${TOKEN}\u2028now`, 200);
  assert.ok(!line.includes(TOKEN) && !/[\n\t\u2028]/.test(line));
  assert.equal(Array.from(oneLine("word ".repeat(80), 100)).length, 100);
  assert.equal(oneLine(42, 100), "");
  // A value of several words goes whole, and so does everything after it.
  for (const leak of ["password: correct horse battery staple", "password: !!str cedar maple birch"]) {
    const out = redact([leak, "next line"]);
    assert.ok(!/horse|battery|staple|cedar|maple|birch|next line/.test(out), out);
  }
});

test("an invisible character inside a token is taken out before oneLine folds spaces, so the token is redacted whole", () => {
  for (const code of [0xfeff, 0x200b, 0x200d, 0x2060]) {
    const line = oneLine(`fix ${TOKEN.slice(0, 8)}${String.fromCharCode(code)}${TOKEN.slice(8)} today`, 200);
    assert.ok(!line.includes(TOKEN.slice(0, 8)) && !line.includes(TOKEN.slice(8, 20)), `${code}: ${line}`);
  }
});

test("oneLine joins a continued line and redacts with the lines kept before it folds them into one", () => {
  const join = String.fromCharCode(92, 10);
  const token = `${["gh", "p_"].join("")}${"Z".repeat(8)}${join}${"Z".repeat(28)}`;
  for (const raw of [`pass${join}word=hunter2`, token, `ok\nDB_PASS${join}WORD=hunter2 later`, `fine\r\n${TOKEN.slice(0, 10)}${join}${TOKEN.slice(10)}`]) {
    const line = oneLine(raw, 200);
    assert.ok(!/hunter2|ZZZZ|gh[p]_/.test(line) && !line.includes(TOKEN.slice(10)), `${JSON.stringify(raw.slice(0, 12))}: ${line}`);
    assert.ok(!/[\n\r]/.test(line), line);
  }
  assert.equal(oneLine("first line\nsecond  line", 200), "first line second line");
});

test("oneLine redacts each line as written as well as joined: a join that takes away a word boundary hides nothing", () => {
  const secret = Buffer.from("user:pass").toString("base64");
  const raw = `prefix${String.fromCharCode(92, 10)}Basic ${secret}`;
  for (const said of [oneLine(raw, 200), shapeText(oneLine(raw, 200), 300)]) assert.ok(!said.includes(secret), said);
});

test("oneLine redacts the folded line last: a scheme and its value on two lines meet only in the fold", () => {
  const secret = Buffer.from("user:pass").toString("base64");
  for (const raw of [`Basic\n${secret}`, `Basic\r\n\n${secret}`, `auth: Bearer\u2028${secret}`]) {
    const said = oneLine(raw, 200);
    assert.ok(!said.includes(secret), `${JSON.stringify(raw)}: ${said}`);
  }
});

test("home paths are shortened before a line is cut, so no token head the cut left reaches the shown line", () => {
  for (const n of [140, 141, 142, 143]) {
    const said = redact(`note: ${`${USERS}alice/ `.repeat(n)}${TOKEN}`);
    assert.ok(!said.includes(TOKEN.slice(0, 4)), `${n}: ${said.slice(-40)}`);
    assert.ok(said.startsWith("note: ~/ ~/"), said.slice(0, 40));
  }
});

test("Spend stops at the ceiling, logs it once a day, and starts again the next day", () => {
  const dir = tmp();
  const logs = [];
  let now = new Date("2026-10-08T01:00:00Z");
  const spend = new Spend("job", 0.01, { dir, now: () => now, log: (event) => logs.push(event) });
  spend.check();
  spend.charge(0.006);
  spend.charge(0.006);
  spend.save();
  assert.throws(() => spend.check(), CeilingReached);
  assert.throws(() => spend.check(), CeilingReached);
  assert.deepEqual(logs, ["reader-ceiling"]);
  // A new process the same day reads the file and stays stopped, without logging again.
  assert.throws(() => new Spend("job", 0.01, { dir, now: () => now, log: (event) => logs.push(event) }).check(), CeilingReached);
  assert.equal(logs.length, 1);
  const first = zoneDay(now);
  now = new Date("2026-10-10T01:00:00Z");
  spend.check();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8"));
  assert.equal(saved.model, "claude-haiku-5-5");
  assert.equal(saved.days[first].calls, 2);
  assert.ok(saved.days[first].stoppedAt);
});

test("ask checks the ceiling first, charges every answer, and wraps a failed CLI", async () => {
  const dir = tmp();
  const spend = new Spend("job", 1, { dir });
  assert.deepEqual(await ask({ run: async () => cli('{"ok": true}'), spend, input: "x" }), { ok: true });
  await assert.rejects(ask({ run: async () => cli("nothing"), spend, input: "x" }), BadAnswer);
  const before = spend.today.usd;
  await assert.rejects(ask({ run: async () => { throw new Error("claude timed out"); }, spend, input: "x".repeat(3000) }), CliError);
  assert.equal(spend.today.calls, 3, "a failed run is charged too");
  assert.ok(spend.today.usd > before, "an estimate when the CLI printed no usage");
  const printed = Object.assign(new Error("claude exit 1"), { stdout: JSON.stringify({ is_error: true, usage: { input_tokens: 1_000_000 } }) });
  await assert.rejects(ask({ run: async () => { throw printed; }, spend, input: "x" }), CliError);
  assert.ok(spend.today.usd >= 0.1, "the usage the CLI printed before failing");
  const capped = new Spend("capped", 0, { dir });
  let ran = false;
  await assert.rejects(ask({ run: async () => { ran = true; return cli("{}"); }, spend: capped, input: "x" }), CeilingReached);
  assert.equal(ran, false);
});

test("Spend fails closed on a broken, emptied or tampered file", () => {
  const dir = tmp();
  const now = () => new Date("2026-10-08T01:00:00Z");
  const logs = [];
  fs.writeFileSync(path.join(dir, "neg.json"), JSON.stringify({ days: { [zoneDay(now())]: { usd: -1e6, calls: 0 } } }));
  assert.throws(() => new Spend("neg", 6, { dir, now, log: (e) => logs.push(e) }).check(), CeilingReached);
  fs.writeFileSync(path.join(dir, "bad.json"), "{not json");
  assert.throws(() => new Spend("bad", 6, { dir, now, log: (e) => logs.push(e) }).check(), CeilingReached);
  assert.deepEqual(logs, ["reader-spend-unreadable", "reader-ceiling", "reader-spend-unreadable", "reader-ceiling"]);
  fs.writeFileSync(path.join(dir, "null.json"), "null");
  assert.throws(() => new Spend("null", 6, { dir, now }).check(), CeilingReached);
  // Tomorrow the rewritten file is whole again.
  new Spend("bad", 6, { dir, now: () => new Date("2026-10-10T01:00:00Z") }).check();
});

test("the file writers never write through a planted link", () => {
  const dir = tmp();
  const target = path.join(dir, "holds.json");
  fs.writeFileSync(target, "[]");
  fs.symlinkSync(target, path.join(dir, "alerts.jsonl"));
  assert.throws(() => appendJsonl(path.join(dir, "alerts.jsonl"), [{ a: 1 }]));
  fs.linkSync(target, path.join(dir, "hard.jsonl"));
  assert.throws(() => appendJsonl(path.join(dir, "hard.jsonl"), [{ a: 1 }]));
  fs.symlinkSync(target, path.join(dir, "status.json"));
  writeJsonAtomic(path.join(dir, "status.json"), { ok: true });
  assert.equal(fs.readFileSync(target, "utf8"), "[]");
  assert.equal(fs.lstatSync(path.join(dir, "status.json")).isSymbolicLink(), false);
});

test("takeLock lets one pass run at a time and takes over a dead holder's lock", () => {
  const dir = tmp();
  const release = takeLock("job", { dir });
  assert.ok(release);
  fs.writeFileSync(path.join(dir, "job.lock"), `${process.ppid}\n`);
  assert.equal(takeLock("job", { dir }), null, "a live holder keeps it");
  fs.writeFileSync(path.join(dir, "job.lock"), "999999999\n");
  const again = takeLock("job", { dir });
  assert.ok(again, "a dead holder's lock is taken over");
  release?.();
  assert.ok(fs.existsSync(path.join(dir, "job.lock")), "an old release never removes a lock another run holds");
  again();
  assert.equal(fs.existsSync(path.join(dir, "job.lock")), false);
});

test("takeLock breaks a dead holder's lock one run at a time; a dead breaker's guard clears after a minute", () => {
  const dir = tmp();
  const lock = path.join(dir, "job.lock");
  fs.writeFileSync(lock, "999999999:dead\n");
  fs.writeFileSync(`${lock}.break`, "999999998:other\n");
  assert.equal(takeLock("job", { dir }), null, "another run is breaking it");
  assert.equal(fs.readFileSync(lock, "utf8"), "999999999:dead\n", "and the lock is left to that run");
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(`${lock}.break`, old, old);
  assert.equal(takeLock("job", { dir }), null, "a stale guard is cleared, not used");
  assert.equal(fs.existsSync(`${lock}.break`), false);
  const release = takeLock("job", { dir });
  assert.ok(release, "the next run takes the dead lock over");
  assert.equal(fs.existsSync(`${lock}.break`), false, "and drops its guard");
  release();
});

test("a failed call with no usage is charged for every request it may make: prompt bytes, earlier output and a capped answer", () => {
  const input = "\u20ac".repeat(1000);
  const floor = (4 * ((Buffer.byteLength(input) + 8000 + 3 * READER_MAX_OUTPUT_TOKENS) * 0.1 + READER_MAX_OUTPUT_TOKENS * 0.5)) / 1e6;
  assert.ok(failedCallUsd(new Error("claude timed out"), input) >= floor);
});

test("takeLock: an empty lock is busy while fresh and taken over once a minute old; a live breaker's guard is kept", () => {
  const dir = tmp();
  const lock = path.join(dir, "job.lock");
  fs.writeFileSync(lock, "");
  assert.equal(takeLock("job", { dir }), null, "a run may be writing it now");
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lock, old, old);
  const release = takeLock("job", { dir });
  assert.ok(release, "a broken empty lock is taken over");
  assert.equal(fs.readFileSync(lock, "utf8").length > 0, true, "and a new lock is never empty");
  release();
  fs.writeFileSync(lock, "999999999:dead\n");
  fs.writeFileSync(`${lock}.break`, `${process.ppid}:live\n`);
  fs.utimesSync(`${lock}.break`, old, old);
  assert.equal(takeLock("job", { dir }), null);
  assert.equal(fs.readFileSync(`${lock}.break`, "utf8"), `${process.ppid}:live\n`, "an old guard whose run is alive stays");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "no temp files left behind");
});

test("an invisible character before a name keeps the value out of a reader's text and log", () => {
  const line = "x­Bearer qzvtkfake";
  for (const out of [redact(line), redactLog([line])]) assert.ok(!String(out).includes("qzvtkfake"), JSON.stringify(out));
});

test("the readers keep a bidi control in until redaction", () => {
  const hidden = (out) => !String(out).normalize("NFKC").includes("qzvtkfake");
  assert.ok(hidden(redact("x\u200eBearer qzvtkfake")), "redact");
  assert.ok(hidden(redactLog(["x\u200eBearer qzvtkfake"])), "redactLog");
});

test("a look-alike or split secret's name holds its value past the log hold", () => {
  const hidden = (out) => !String(out).normalize("NFKC").includes("qzvtkfake");
  const filler = Array.from({ length: 10 }, (_, i) => `  line ${i}`);
  for (const key of ["\uFF50assword: first", "pass\u200bword: first"]) {
    const out = redactLog([key, ...filler, "  qzvtkfake"]);
    assert.ok(hidden(out), `${JSON.stringify(key)} -> ${JSON.stringify(out)}`);
  }
});

test("a look-alike secret's block a progress line ends in one reading still withholds the rest of the log", () => {
  const out = redactLog(["\uFF50assword: |", "  first", ...Array(12).fill("progress"), "  qzvtkfake"]);
  assert.ok(!out.normalize("NFKC").includes("qzvtkfake"), JSON.stringify(out));
});

test("an invisible character before a step header or inside a home path hides nothing", () => {
  assert.ok(!redactLog(["\u200b##[group]Run echo setup", "  qzvtkfake", "##[endgroup]"]).includes("qzvtkfake"));
  for (const quote of ["\u200b", "\uFF02", '"']) {
    const out = redactLog([`/home/alice${quote}password: qzvtkfake`, "second"]);
    assert.ok(!out.normalize("NFKC").includes("qzvtkfake"), JSON.stringify(out));
  }
});

test("a home path's name before a label, and markup inside a word, hide no secret", () => {
  assert.ok(!redactLog(["/home/password=qzvtkfake", "second"]).includes("qzvtkfake"));
  assert.ok(!redactLog(["/home/\uFF50\uFF41**ssword**=qzvtkfake"], "/synthetic").includes("qzvtkfake"));
  assert.ok(!redactLog(["/home/api-**key**=qzvtkfake"], "/synthetic").includes("qzvtkfake"));
  assert.equal(redactLog([`${USERS}author/docs`], "/synthetic"), "~/docs");
  assert.ok(!plainText("pa<ss>word=qzvtkfake").includes("password"));
  assert.ok(!plainText("api<->key=qzvtkfake").includes("qzvtkfake"));
  assert.equal(plainText("**bold** and `code` and snake_case"), "bold and code and snake case");
});

test("readersOn: only RIVET_READERS=on with the marker on disk", () => {
  const marker = path.join(tmp(), "installed");
  assert.equal(readersOn({}, marker), false);
  assert.equal(readersOn({ RIVET_READERS: "on" }, marker), false);
  fs.writeFileSync(marker, "");
  assert.equal(readersOn({}, marker), false);
  for (const word of ["1", "ON", "true", "off", ""]) assert.equal(readersOn({ RIVET_READERS: word }, marker), false);
  assert.equal(readersOn({ RIVET_READERS: "on" }, marker), true);
});

test("makeReaderRun: with the readers off there is no runner, and nothing starts", () => {
  const dir = tmp();
  const seen = path.join(dir, "ran");
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!/bin/sh\ntouch "${seen}"\n`, { mode: 0o755 });
  const was = process.env.RIVET_READERS;
  delete process.env.RIVET_READERS;
  try {
    assert.throws(() => makeReaderRun(bin, { effort: "low", system: "x" }), ReadersOff);
  } finally {
    if (was !== undefined) process.env.RIVET_READERS = was;
  }
  assert.ok(!fs.existsSync(seen));
});

test("makeRivetCli hands the board token to the rivet child alone, and passes input", async () => {
  const token = "cd".repeat(32);
  const was = process.env.RIVET_BOARD_TOKEN;
  process.env.RIVET_BOARD_TOKEN = token;
  try {
    const seen = [];
    const exec = async (file, args, opts) => (seen.push({ file, args, opts }), { stdout: "printed" });
    assert.equal(await makeRivetCli(exec)(["board"], "body"), "printed");
    assert.equal(seen[0].file, process.execPath);
    assert.match(seen[0].args[0], /scripts[/\\]rivet\.mjs$/);
    assert.deepEqual(seen[0].args.slice(1), ["board"]);
    assert.equal(seen[0].opts.input, "body");
    assert.equal(seen[0].opts.env.RIVET_BOARD_TOKEN, token);
  } finally {
    if (was === undefined) delete process.env.RIVET_BOARD_TOKEN;
    else process.env.RIVET_BOARD_TOKEN = was;
  }
});
