import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { zoneDay } from "../../bridge/lib/spend.mjs";
import { Spend } from "../lib.mjs";
import { batchPrompt, mainView, memoryPass, missing, parseBatch, parseNotes, readBlobs, references, splitNote, wordsFound } from "../memory-check.mjs";

const TOKEN = `${"gh"}p_${"Q1w2E3r4T5".repeat(4)}`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "memory-check-"));

test("references reads files, pnpm scripts, flags and code names from code spans, and skips what it cannot look up", () => {
  const refs = references(
    "Run `pnpm check:fast` and `node scripts/send-report.mjs --pr 1`; see `tools/lib/cost.mjs`, `usageCost()`, `--no-reply`, `KNOWN_SOURCES`, `~/notes/x.md`, `/tmp/y.json`, `14ee21bd2`, `#461`, `end()`, `ok`, `pnpm install --frozen-lockfile`, `pnpm run install`, `../shared/src/protocol.ts`, `client/dist/index.html`.",
  );
  assert.deepEqual(refs, [
    { kind: "script", name: "check:fast" },
    { kind: "file", name: "scripts/send-report.mjs" },
    { kind: "flag", name: "--pr" },
    { kind: "file", name: "tools/lib/cost.mjs" },
    { kind: "name", name: "usageCost" },
    { kind: "flag", name: "--no-reply" },
    { kind: "name", name: "KNOWN_SOURCES" },
    { kind: "name", name: "end" },
    { kind: "script", name: "install" },
    { kind: "file", name: "shared/src/protocol.ts" },
  ]);
});

test("missing checks files by path or suffix, scripts by package.json, names by main's code", () => {
  const main = { files: ["tools/lib/cost.mjs", "scripts/send-report.mjs"], scripts: new Set(["check:fast"]), found: new Set(["usageCost"]) };
  const refs = [
    { kind: "file", name: "lib/cost.mjs" },
    { kind: "file", name: "scripts/gone.mjs" },
    { kind: "script", name: "check:fast" },
    { kind: "script", name: "old:script" },
    { kind: "name", name: "usageCost" },
    { kind: "flag", name: "--gone-flag" },
  ];
  assert.deepEqual(missing(refs, main).map((r) => r.name), ["scripts/gone.mjs", "old:script", "--gone-flag"]);
});

test("wordsFound finds names as whole words, as git grep -w -F does, and skips binary files", () => {
  const texts = ["const fooBar = 1;\nrun --pr 4 and x--prz\nLiveStage.sync3D();\n", "Class.method_x\n", "\0 binaryOnlyName\n"].map((t) => Buffer.from(t));
  const names = ["fooBar", "foo", "--pr", "LiveStage.sync3D", "Stage.sync3D", "Class.method", "binaryOnlyName", "absentName", "--prz"];
  assert.deepEqual([...wordsFound(texts, names)].sort(), ["--pr", "LiveStage.sync3D", "fooBar"]);
  // A name on a later line, or only in a later file, is still found; a repeat in the names is one name.
  assert.deepEqual([...wordsFound([Buffer.from("a\n"), Buffer.from("b\nlateName\n")], ["lateName", "lateName"])], ["lateName"]);
});

test("readBlobs reads blobs in one git cat-file and never fetches: one the clone lacks is null", async () => {
  const repo = tmp();
  execFileSync("git", ["init", "-q", repo]);
  const file = path.join(repo, "a.mjs");
  fs.writeFileSync(file, "export const answer = 42;\n");
  const oid = execFileSync("git", ["-C", repo, "hash-object", "-w", file], { encoding: "utf8" }).trim();
  const absent = "f".repeat(oid.length);
  const read = await readBlobs("git", repo)([oid, absent]);
  assert.equal(read.get(oid)?.toString(), "export const answer = 42;\n");
  assert.equal(read.get(absent), null);
  assert.throws(() => parseBatch(Buffer.from(`${oid} blob 99\nshort\n`), [oid]), /unexpected/);
});

test("memoryPass searches a code file that shares its contents with a package.json", async () => {
  const memoryDir = tmp();
  fs.writeFileSync(path.join(memoryDir, "name.md"), "---\ndescription: d\n---\nCall `someHelper()`.");
  const shared = "f".repeat(40);
  const text = '{"scripts":{"someHelper":"node x"}}';
  const git = async (/** @type {string[]} */ args) => {
    if (args[0] === "rev-parse") return `${SHA}\n`;
    if (args[0] === "ls-tree") return `100644 blob ${shared}\tdocs/a.md\x00100644 blob ${shared}\tz/package.json\x00`;
    if (args[0] === "show") return text;
    return "";
  };
  const dir = tmp();
  const prompts = [];
  await memoryPass({
    git,
    blobs: async (/** @type {string[]} */ oids) => new Map(oids.map((o) => [o, Buffer.from(text)])),
    run: async (input) => {
      prompts.push(input);
      return answerStale(input);
    },
    spend: new Spend("memory-check", 0.5, { dir: path.join(dir, "spend") }),
    now: () => new Date("2026-10-08T16:00:00Z"),
    log: () => {},
    memoryDir,
    dir,
  });
  assert.deepEqual(prompts, []);
});

test("memoryPass calls no name missing when main's code could not all be read", async () => {
  for (const [blobs, asked] of [[emptyBlobs, true], [async (/** @type {string[]} */ oids) => new Map(oids.map((o) => [o, null])), false]]) {
    const memoryDir = tmp();
    fs.writeFileSync(path.join(memoryDir, "name.md"), "---\ndescription: d\n---\nCall `retiredHelper()`.");
    const dir = tmp();
    const prompts = [];
    const logs = [];
    await memoryPass({
      git: fakeGit([]),
      blobs,
      run: async (input) => {
        prompts.push(input);
        return answerStale(input);
      },
      spend: new Spend("memory-check", 0.5, { dir: path.join(dir, "spend") }),
      now: () => new Date("2026-10-08T16:00:00Z"),
      log: (event) => logs.push(event),
      memoryDir,
      dir,
    });
    assert.equal(prompts.some((p) => p.includes("retiredHelper")), asked);
    assert.equal(logs.includes("memory-check-code-unread"), !asked);
  }
});

test("mainView repacks a clone of many packs with its own timeout, and a repack that fails leaves the view whole", async () => {
  for (const [packs, fails, repacked] of [[51, false, true], [50, false, false], [7706, true, true]]) {
    const calls = [];
    const logs = [];
    const base = fakeGit(calls);
    const git = async (/** @type {string[]} */ args, /** @type {number | undefined} */ timeoutMs) => {
      if (args[0] === "count-objects") return `count: 0\nsize: 0\nin-pack: 9\npacks: ${packs}\nsize-pack: 1\n`;
      if (args[0] === "repack") {
        calls.push([...args, timeoutMs]);
        if (fails) throw new Error("git timed out");
        return "";
      }
      return base(args);
    };
    const view = await mainView(git, emptyBlobs, SHA, ["someHelper"], (event) => logs.push(event));
    const repack = calls.find((c) => c[0] === "repack");
    assert.equal(Boolean(repack), repacked);
    if (repack) assert.deepEqual(repack, ["repack", "-a", "-d", "-q", 600_000]);
    assert.equal(logs.includes("memory-check-repacked"), repacked && !fails);
    assert.equal(logs.includes("memory-check-repack-failed"), fails);
    assert.ok(view.found instanceof Set && view.scripts?.has("check:fast"));
  }
});

test("parseNotes keeps asked notes with a boolean verdict; a stale one needs a why", () => {
  const out = parseNotes({ notes: [{ id: "n1", stale: true, why: "cost.mjs moved" }, { id: "n2", stale: true, why: "" }, { id: "n3", stale: "yes" }, { id: "n9", stale: false }] }, new Set(["n1", "n2", "n3"]));
  assert.deepEqual(Object.fromEntries(out), { n1: { stale: true, why: "cost.mjs moved" } });
  // The model's why is plain text in the report: no image, link, mention or emphasis.
  const [marked] = parseNotes({ notes: [{ id: "n1", stale: true, why: "![x](https://e.example/a.png) @team **gone** `x`" }] }, new Set(["n1"])).values();
  assert.ok(!/!\[|\]\(|[*`@]/.test(marked.why), marked.why);
  assert.deepEqual(splitNote("---\nname: a\ndescription: The note\n---\nBody"), { description: "The note", body: "Body" });
});

test("references read flags a repo command is given, calls with arguments, qualified names, Dockerfiles and places in files", () => {
  const refs = references(
    "`pnpm check:fast --retired-option`, `pnpm install --frozen-lockfile`, `node scripts/x.mjs --pr 1 --dry-run=yes`, `advance(now)`, `LiveStage.sync3D`, `round()`, `end()`, `apply(now, delta)`, `tick(clock.now())`, `retiredAdvance(clamp(clock.now()))`, `app.example.org`, `Dockerfile.web`, `scripts/gone.mjs:42`, `a/b.ts#L3-L9`.",
  );
  assert.deepEqual(refs, [
    { kind: "script", name: "check:fast" },
    { kind: "flag", name: "--retired-option" },
    { kind: "file", name: "scripts/x.mjs" },
    { kind: "flag", name: "--pr" },
    { kind: "flag", name: "--dry-run" },
    { kind: "name", name: "advance" },
    { kind: "name", name: "sync3D" },
    { kind: "name", name: "round" },
    { kind: "name", name: "end" },
    { kind: "name", name: "apply" },
    { kind: "name", name: "tick" },
    { kind: "name", name: "retiredAdvance" },
    { kind: "file", name: "Dockerfile.web" },
    { kind: "file", name: "scripts/gone.mjs" },
    { kind: "file", name: "a/b.ts" },
  ]);
});

const SHA = "a".repeat(40);
const [CODE, PKG, PNG] = ["b", "c", "d"].map((c) => c.repeat(40));

/** A fake readers' clone: main has a code file, a package.json and an image; the clone has none of their contents. */
function fakeGit(calls, { showFails = false } = {}) {
  return async (args) => {
    calls.push(args);
    if (args[0] === "show" && showFails) throw new Error("git exited 128");
    if (args[0] === "rev-parse") return `${SHA}\n`;
    if (args[0] === "ls-tree") return `100644 blob ${CODE}\ttools/lib/cost.mjs\x00100644 blob ${PKG}\tpackage.json\x00100644 blob ${PNG}\tassets/big.png\x00`;
    if (args[0] === "rev-list") return `${SHA}\n${"e".repeat(40)} \n?${CODE}\n?${PKG}\n?${PNG}\n`;
    if (args[0] === "show") return JSON.stringify({ scripts: { "check:fast": "x" } });
    return "";
  };
}

/** The clone's code, read: every file empty. */
const emptyBlobs = async (/** @type {string[]} */ oids) => new Map(oids.map((o) => [o, Buffer.alloc(0)]));

/** A memory folder with an index, a current note and a stale one carrying a token (in text, in a code span, in its description). */
function memory() {
  const memoryDir = tmp();
  fs.writeFileSync(path.join(memoryDir, "INDEX.md"), "- index `scripts/gone.mjs`");
  fs.writeFileSync(path.join(memoryDir, "good.md"), "---\ndescription: fine\n---\nUse `tools/lib/cost.mjs`, as `stale.md` said.");
  fs.writeFileSync(path.join(memoryDir, "stale.md"), `---\ndescription: old ${TOKEN}\n---\nRun \`scripts/gone.mjs\`.\nWith token ${TOKEN}.\nOr \`${TOKEN}\`.`);
  return memoryDir;
}

const answerStale = (input) => JSON.stringify({ is_error: false, result: JSON.stringify({ notes: [{ id: "n1", stale: true, why: "scripts/gone.mjs is not on main" }] }), usage: { input_tokens: 300, output_tokens: 30 } });

test("memoryPass checks against main, asks only about notes with a missing name, redacts, and edits no memory", async () => {
  const memoryDir = memory();
  const dir = tmp();
  const before = Object.fromEntries(fs.readdirSync(memoryDir).map((f) => [f, fs.readFileSync(path.join(memoryDir, f), "utf8")]));
  const prompts = [];
  const calls = [];
  const result = await memoryPass({
    git: fakeGit(calls),
    blobs: emptyBlobs,
    run: async (input) => {
      prompts.push(input);
      return answerStale(input);
    },
    spend: new Spend("memory-check", 0.5, { dir: path.join(dir, "spend") }),
    now: () => new Date("2026-10-08T16:00:00Z"),
    log: () => {},
    memoryDir,
    dir,
  });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /stale\.md/);
  assert.ok(!prompts[0].includes("good.md") && !prompts[0].includes(TOKEN));
  assert.ok(!fs.readFileSync(result.file, "utf8").includes(TOKEN));
  // Only the code and package.json contents main has and the clone lacks are fetched, in one batch.
  const prefetch = calls.filter((a) => a[0] === "-c");
  assert.deepEqual(prefetch.map((a) => a.slice(a.indexOf("origin") + 1)), [[CODE, PKG]]);
  assert.ok(calls[0].includes("--no-write-fetch-head"), "the shared clone's FETCH_HEAD is left alone");
  assert.equal(path.basename(result.file), `memory-check-${zoneDay(new Date("2026-10-08T16:00:00Z"))}.md`);
  assert.match(fs.readFileSync(result.file, "utf8"), /## Likely stale\n\n- `stale\.md` — scripts\/gone\.mjs is not on main \(missing: `scripts\/gone\.mjs`\)/);
  assert.deepEqual(Object.fromEntries(fs.readdirSync(memoryDir).map((f) => [f, fs.readFileSync(path.join(memoryDir, f), "utf8")])), before, "memory untouched");
});

test("memoryPass writes no report at the ceiling, or when a call takes the day to it", async () => {
  for (const usage of [null, { input_tokens: 2_000_000, output_tokens: 10 }]) {
    const memoryDir = memory();
    const dir = tmp();
    const spend = new Spend("memory-check", 0.5, { dir: path.join(dir, "spend") });
    if (!usage) spend.charge(0.6);
    let asked = 0;
    const result = await memoryPass({
      git: fakeGit([]),
      blobs: emptyBlobs,
      run: async () => {
        asked += 1;
        return JSON.stringify({ is_error: false, result: JSON.stringify({ notes: [{ id: "n1", stale: true, why: "gone" }] }), usage });
      },
      spend,
      now: () => new Date("2026-10-08T16:00:00Z"),
      log: () => {},
      memoryDir,
      dir,
    });
    assert.equal(result.file, null);
    assert.equal(result.capped, true);
    assert.equal(asked, usage ? 1 : 0);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".md")), []);
  }
});

test("memoryPass redacts a note whole, skips a note named with a secret, and never calls a script missing it could not read", async () => {
  const memoryDir = tmp();
  fs.writeFileSync(path.join(memoryDir, "secret.md"), "---\ndescription: d\n---\npassword:\n  `canarySecret`\nkey: |\n  `winterSunrise`\nUse `scripts/removed.mjs`.");
  fs.writeFileSync(path.join(memoryDir, "plain.md"), "---\ndescription: d\n---\nUse `scripts/removed.mjs`.");
  fs.writeFileSync(path.join(memoryDir, "marked.md"), "---\ndescription: d\n---\n**password**:\n  `boldSecretValue`\nUse `scripts/removed.mjs`.");
  // A note is not a runner's log: a step header in it hides no key, and a one-word PASS key opens a plain value.
  fs.writeFileSync(path.join(memoryDir, "header.md"), "---\ndescription: d\n---\n##[group]Run step\npassword:\n##[endgroup]\n  `headerSecretValue`\nUse `scripts/removed.mjs`.");
  fs.writeFileSync(path.join(memoryDir, "pass.md"), `---\ndescription: d\n---\npass: first\n${"  alpha\n".repeat(10)}  \`passSecretValue\`\nUse \`scripts/removed.mjs\`.`);
  fs.writeFileSync(path.join(memoryDir, `${TOKEN}.md`), "---\ndescription: d\n---\nUse `scripts/also-removed.mjs`.");
  // A name that would close the report's code span, and a pipe, which would hang a read: neither is read.
  fs.writeFileSync(path.join(memoryDir, "note` @team.md"), "---\ndescription: d\n---\nUse `scripts/also-removed.mjs`.");
  execFileSync("mkfifo", [path.join(memoryDir, "hang.md")]);
  fs.writeFileSync(path.join(memoryDir, "script.md"), "---\ndescription: d\n---\nRun `pnpm check:fast`.");
  const dir = tmp();
  const prompts = [];
  const logs = [];
  const result = await memoryPass({
    git: fakeGit([], { showFails: true }),
    blobs: emptyBlobs,
    run: async (input) => {
      prompts.push(input);
      return answerStale(input);
    },
    spend: new Spend("memory-check", 0.5, { dir: path.join(dir, "spend") }),
    now: () => new Date("2026-10-08T16:00:00Z"),
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
    memoryDir,
    dir,
  });
  const text = [...prompts, fs.readFileSync(result.file, "utf8"), ...logs].join("\n");
  assert.match(prompts.join("\n"), /plain\.md/, "a note with no secret is asked about");
  for (const secret of ["canarySecret", "winterSunrise", "boldSecretValue", "headerSecretValue", "passSecretValue", TOKEN, "@team", "hang.md"]) {
    assert.ok(!text.includes(secret), secret);
  }
  assert.ok(!prompts.join("\n").includes("script.md"), "a script main's package.json could not be read for is not missing");
  assert.ok(logs.some((l) => l.includes("memory-check-scripts-unread")));
});


test("a note's lines are picked from it redacted whole: a block's header above one keeps its value out", () => {
  const prompt = batchPrompt([{ id: "n1", file: "note.md", description: "a note", gone: [{ name: "scripts/gone.mjs", kind: "script" }], body: "password: |\n  hunter2 scripts/gone.mjs\nrun scripts/gone.mjs" }]);
  assert.ok(!prompt.includes("hunter2"), prompt);
  const plain = batchPrompt([{ id: "n2", file: "note.md", description: "a note", gone: [{ name: "scripts/gone.mjs", kind: "script" }], body: "intro\nrun scripts/gone.mjs" }]);
  assert.match(plain, /run scripts\/gone\.mjs/, "a plain note still shows its line");
});
