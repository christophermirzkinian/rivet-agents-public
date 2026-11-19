import { execFileSync } from "node:child_process";
import { copyFileSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const list = (shard: string) => execFileSync(process.execPath, ["scripts/test-shard.mjs", "--list", shard], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);

describe("test-shard", () => {
  it("CI's three shards run every node --test file once", () => {
    const shards = ["1/3", "2/3", "3/3"].map(list);
    const all = list("1/1");
    // Every glob in package.json's `test` script, the Rivet lane's bridge tests among them.
    const globs = [...JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.test.matchAll(/'([^']+)'/g)].map(([, glob]) => glob);
    expect(globs).toContain("bridge/test/*.test.mjs");
    expect(all).toEqual(globs.flatMap((glob) => globSync(glob, { cwd: root })).sort());
    expect(shards.flat().sort()).toEqual(all);
    for (const shard of shards) expect(shard.length).toBeGreaterThan(0);
  });

  it("refuses a shard outside its total", () => {
    for (const shard of ["0/3", "4/3", "3", ""]) expect(() => execFileSync(process.execPath, ["scripts/test-shard.mjs", "--list", shard], { cwd: root, stdio: "pipe" })).toThrow();
  });

  it("refuses a test glob that matches no files", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-shard-"));
    try {
      mkdirSync(join(dir, "scripts"));
      mkdirSync(join(dir, "kept", "test"), { recursive: true });
      copyFileSync(join(root, "scripts", "test-shard.mjs"), join(dir, "scripts", "test-shard.mjs"));
      writeFileSync(join(dir, "kept", "test", "a.test.mjs"), "");
      const shard = (globs: string) => {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: `vitest run && node --test ${globs}` } }));
        return execFileSync(process.execPath, ["scripts/test-shard.mjs", "--list", "1/1"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
      };
      expect(shard("'kept/test/*.test.mjs'")).toBe("kept/test/a.test.mjs\n");
      expect(() => shard("'kept/test/*.test.mjs' 'gone/test/*.test.mjs'")).toThrow(/gone\/test\/\*\.test\.mjs/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
