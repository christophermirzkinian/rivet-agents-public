import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ancestryCache, provePatchMerges, refreshHistory } from "../lib/ops/ancestry.mjs";
import { parseFlyStatus, parseReleases, releaseSha } from "../lib/ops/fly.mjs";
import { parseMerged } from "../lib/ops/github.mjs";

const exec = promisify(execFile);
const repoName = "example-org/example-repo";
process.env.RIVET_REPOS = repoName;
const sha = "a".repeat(40);

test("source tags and authoritative machine labels", () => {
  assert.equal(releaseSha(`registry.example.test/example-app:direct-${sha.slice(0, 12)}-muyhezyi`), sha.slice(0, 12));
  assert.equal(releaseSha(`registry.example.test/example-app:sha-${sha}`), sha);
  assert.equal(releaseSha(`registry.example.test/example-app:${sha}`), sha);
  for (const tag of ["deployment-abc123", "latest", `direct-${sha.slice(0, 12)}-bad!`]) {
    assert.equal(releaseSha(`registry.example.test/example-app:${tag}`), null);
  }
  assert.equal(releaseSha(`registry.example.test/example-app@sha256:${"a".repeat(64)}`), null);
  assert.equal(releaseSha(`registry.example.test/example-app@sha1:${sha}`), null);
  const machine = (labels) => JSON.stringify({ Machines: [{ updated_at: "2026-10-08T00:00:00Z", image_ref: { labels } }] });
  assert.equal(parseFlyStatus(machine({ RIVET_DEPLOY_SHA: sha, GH_SHA: "b".repeat(40) })).sha, sha.slice(0, 12));
  assert.equal(parseFlyStatus(machine({ GH_SHA: sha })).sha, sha.slice(0, 12));
  const releases = parseReleases(JSON.stringify([{ Version: 1, Status: "complete", CreatedAt: "2026-10-08T00:00:00Z", ImageRef: `registry.example.test/example-app:direct-${sha.slice(0, 12)}-muyhezyi` }]), new Date("2026-10-08"));
  assert.equal(releases[0].sha, sha.slice(0, 12));
});

test("merged collection preserves the merge commit, never a branch head", () => {
  const row = { number: 1, title: "Rivet: A", url: `https://github.com/${repoName}/pull/1`, mergedAt: "2026-10-08T00:00:00Z", mergeCommit: { oid: sha } };
  assert.equal(parseMerged(repoName, JSON.stringify([row]))[0].mergeSha, sha);
  assert.equal(parseMerged(repoName, JSON.stringify([{ ...row, mergeCommit: { oid: "bad" } }]))[0].mergeSha, undefined);
});

test("real git ancestry credits pinned A before B; baseline, failures, rollback and missing objects fail closed", async () => {
  const repo = await mkdtemp(join(tmpdir(), "rivet-ancestry-"));
  const git = (...args) => exec("/usr/bin/git", ["-C", repo, ...args]);
  try {
    await git("init", "-q");
    const commit = async (message) => {
      await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", message);
      return (await git("rev-parse", "HEAD")).stdout.trim();
    };
    const base = await commit("baseline");
    const a = await commit("A");
    const b = await commit("B");
    const at = (minute) => new Date(Date.UTC(2026, 9, 7, 0, 0, minute * 60)).toISOString();
    // Both A and B merge before the pinned A image is released at minute 2.
    const merged = [base, a, b].map((mergeSha, i) => ({ repo: repoName, title: `${["Rivet", "Agents", "Ops"][i]}: ${i}`, mergeSha, mergedAt: at(i === 0 ? 0 : 1 + i / 10) }));
    const release = (version, sha, status = "complete") => ({ version, sha: sha.slice(0, 12), status, at: at(version) });
    const releases = [release(6, b), release(5, a), release(4, b), release(3, b, "failed"), release(2, a), release(1, base)];
    const snapshot = { apps: [{ app: "rivet-agents", releases }] };
    const cache = ancestryCache();
    await provePatchMerges(snapshot, merged, { exec, repo, cache });
    assert.deepEqual(releases.map((r) => r.patchMerges), [undefined, undefined, [b], undefined, [a], undefined]);
    assert.ok(cache.size > 0);
    let comparisons = 0;
    const cachedExec = (...args) => { if (args[1].includes("merge-base")) comparisons++; return exec(...args); };
    await provePatchMerges(snapshot, merged, { exec: cachedExec, repo, cache });
    assert.equal(comparisons, 0);
    releases.at(-1).sha = "f".repeat(40);
    await provePatchMerges(snapshot, merged, { exec, repo, cache });
    assert.ok(releases.every((r) => r.patchMerges === undefined));
    releases.at(-1).sha = base;
    await provePatchMerges(snapshot, merged, { exec, repo, cache });
    assert.deepEqual(releases.find((r) => r.version === 2).patchMerges, [a]);
    for (const mergedAt of [undefined, null, 1, "not-a-date", at(0), at(1)]) {
      await provePatchMerges(snapshot, [{ ...merged[1], mergedAt }], { exec, repo, cache });
      assert.ok(releases.every((r) => r.patchMerges === undefined), `unknown or pre-baseline merge ${mergedAt}`);
    }
    const baselineAt = releases.at(-1).at;
    for (const invalidAt of [undefined, "not-a-date"]) {
      releases.at(-1).at = invalidAt;
      await provePatchMerges(snapshot, merged, { exec, repo, cache });
      assert.ok(releases.every((r) => r.patchMerges === undefined));
    }
    releases.at(-1).at = baselineAt;

    // v2 ships A; v3 rolls back; config releases keep that rollback image until
    // v34 redeploys A. The 30-row cap removes the original shipping evidence.
    const rows = Array.from({ length: 34 }, (_, i) => {
      const version = i + 1;
      const imageSha = version === 2 || version === 34 ? a : base;
      return { Version: version, Status: "complete", CreatedAt: at(version), ImageRef: `registry.example.test/example-app:direct-${imageSha.slice(0, 12)}-test` };
    });
    const truncated = parseReleases(JSON.stringify(rows), new Date("2026-10-08T00:00:00Z"));
    assert.equal(truncated.length, 30);
    assert.equal(truncated.at(-1).version, 5);
    const truncatedSnapshot = { apps: [{ app: "rivet-agents", releases: truncated }] };
    await provePatchMerges(truncatedSnapshot, merged, { exec, repo, cache });
    assert.ok(truncated.every((r) => r.patchMerges === undefined), "redeploy must not recredit a merge shipped outside retained history");
    await provePatchMerges(snapshot, merged, { exec: async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); }, repo, cache });
    assert.ok(releases.every((r) => r.patchMerges === undefined));
    await provePatchMerges(snapshot, merged, { exec: async () => ({ stdout: "true\n" }), repo, cache });
    assert.ok(releases.every((r) => r.patchMerges === undefined));
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("the history clone fetches main with hooks off, and only an absolute clone path", async () => {
  const calls = [];
  const fake = async (file, args, opts) => { calls.push([file, args, opts.timeout]); };
  for (const repo of [undefined, "", "relative/repo"]) await refreshHistory(fake, repo);
  assert.deepEqual(calls, []);
  await refreshHistory(fake, "/nowhere/rivet-bridge/repo");
  assert.deepEqual(calls, [["/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-C", "/nowhere/rivet-bridge/repo", "fetch", "-q", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"], 60_000]]);
});
