#!/usr/bin/env node
// One shard of `pnpm test` (vitest, then node --test), for CI's Rivet checks matrix.
//
//   node scripts/test-shard.mjs <index>/<total>
//   node scripts/test-shard.mjs --list <index>/<total>
//
// vitest splits its own files (--shard). The node --test files are the matches
// of package.json's `test` globs, sorted, every <total>th from <index>; --list
// prints them, so the shards together run every file once. vitest 2's `list`
// ignores --shard, so its files are not listed.
import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The node --test globs of package.json's `test` script, which must stay `vitest run && node --test '<glob>'...`. */
function nodeGlobs(testScript) {
  const match = /^vitest run && node --test((?: '[^']+')+)$/.exec(testScript);
  if (!match) throw new Error(`package.json's test script is not \`vitest run && node --test '<glob>'...\`: ${testScript}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map(([, glob]) => glob);
}

/** Shard `index` of `total`'s node --test files, relative to Rivet's root. */
function nodeFiles(index, total) {
  const globs = nodeGlobs(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.test);
  const matched = globs.map((glob) => globSync(glob, { cwd: root }));
  // A glob gone stale would drop its files from every shard unnoticed.
  const empty = globs.filter((_, at) => matched[at].length === 0);
  if (empty.length) throw new Error(`package.json's test globs match no files: ${empty.join(" ")}`);
  const files = [...new Set(matched.flat())].sort();
  return files.filter((_, at) => at % total === index - 1);
}

function main(argv) {
  const list = argv[0] === "--list";
  const spec = /^(\d+)\/(\d+)$/.exec(argv[list ? 1 : 0] ?? "");
  if (!spec || Number(spec[1]) < 1 || Number(spec[1]) > Number(spec[2])) throw new Error("usage: node scripts/test-shard.mjs [--list] <index>/<total>");
  const files = nodeFiles(Number(spec[1]), Number(spec[2]));
  if (list) {
    for (const file of files) console.log(file);
    return;
  }
  const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
  run(join(root, "node_modules", ".bin", "vitest"), ["run", `--shard=${spec[0]}`]);
  // With no files, node --test would look for tests everywhere.
  if (files.length) run(process.execPath, ["--test", ...files]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error?.message ?? error);
    process.exit(1);
  }
}
