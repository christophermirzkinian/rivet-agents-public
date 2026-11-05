import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claimsOverlap, globMatches, type Claim } from "../src/shared/claims.js";
import type { GithubSnapshot } from "../src/shared/ops.js";
import { NO_REPO } from "../src/shared/repos.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, fakeClock, startServer, type TestServer } from "./helpers.js";

// The linear-time guards below time CPU, not the wall clock: a loaded runner stalls a run until its CPU quota
// refills, while a quadratic or backtracking parse still costs the CPU it always did.
const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

const START = Date.parse("2026-10-06T02:00:00.000Z");

let server: TestServer;
let clock: ReturnType<typeof fakeClock>;

beforeEach(async () => {
  clock = fakeClock(START);
  server = await startServer({}, { now: clock.now });
});

afterEach(async () => {
  await server.close();
});

function send(method: string, path: string, body?: unknown, headers: Record<string, string> = bearer(BOARD_TOKEN)): Promise<Response> {
  return fetch(`${server.base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function claim(body: Record<string, unknown>, status = 201): Promise<{ claim: Claim; holders: Claim[] }> {
  const response = await send("POST", "/api/claims", body);
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as { claim: Claim; holders: Claim[] };
}

async function list(headers?: Record<string, string>): Promise<Claim[]> {
  const response = await send("GET", "/api/claims", undefined, headers);
  expect(response.status).toBe(200);
  return ((await response.json()) as { claims: Claim[] }).claims;
}

function github(over: Partial<GithubSnapshot>): GithubSnapshot {
  const at = clock.now().toISOString();
  const source = { failed: [], at };
  return { at, prsComplete: true, prs: [], runs: [], runners: null, queue: null, merged: [], closed: [], sources: { prs: source, runs: source, merged: source, runners: source, queue: source }, ...over };
}

function openPr(number: number, branch: string): GithubSnapshot["prs"][number] {
  const at = clock.now().toISOString();
  return {
    repo: NO_REPO,
    number,
    title: `PR ${number}`,
    url: `https://github.com/${NO_REPO}/pull/${number}`,
    draft: false,
    author: "a",
    labels: [],
    headAt: at,
    updatedAt: at,
    branch,
    checks: { state: "pass", passed: 1, failed: 0, pending: 0, failing: [] },
  };
}

async function pushGithub(body: GithubSnapshot): Promise<void> {
  const response = await fetch(`${server.base}/api/bridge/ops/github`, { method: "PUT", headers: bearer(BRIDGE_TOKEN), body: JSON.stringify(body) });
  expect(response.status, await response.clone().text()).toBe(200);
}

describe("claims", () => {
  it("claims a path, renews it for the same chat and names the holder to another", async () => {
    const first = await claim({ pattern: "pnpm-lock.yaml", chat: "canyon-run", pr: 4100, note: "bumping vite", ttlMinutes: 60 });
    expect(first.claim).toEqual({
      id: "c-1",
      pattern: "pnpm-lock.yaml",
      chat: "canyon-run",
      pr: 4100,
      note: "bumping vite",
      createdAt: "2026-10-06T02:00:00.000Z",
      expiresAt: "2026-10-06T03:00:00.000Z",
    });
    clock.advance(10 * 60_000);
    const renewed = await claim({ pattern: "pnpm-lock.yaml", chat: "canyon-run" }, 200);
    expect(renewed.claim).toMatchObject({ id: "c-1", pr: 4100, note: "bumping vite", expiresAt: "2026-10-06T04:10:00.000Z" });

    const refused = await send("POST", "/api/claims", { pattern: "pnpm-lock.yaml", chat: "claims-board" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { holders: Claim[] }).holders.map((c) => c.chat)).toEqual(["canyon-run"]);
    expect(await list()).toHaveLength(1);

    const forced = await claim({ pattern: "pnpm-lock.yaml", chat: "claims-board", force: true });
    expect(forced.holders.map((c) => c.id)).toEqual(["c-1"]);
    expect((await list()).map((c) => c.chat)).toEqual(["canyon-run", "claims-board"]);
    // Both keep renewing without force, each told about the other.
    clock.advance(60_000);
    expect((await claim({ pattern: "pnpm-lock.yaml", chat: "claims-board" }, 200)).holders.map((c) => c.chat)).toEqual(["canyon-run"]);
    expect((await claim({ pattern: "pnpm-lock.yaml", chat: "canyon-run" }, 200)).claim.expiresAt).toBe("2026-10-06T04:11:00.000Z");
  });

  it("compares a starry claim with a long path in linear time", async () => {
    await claim({ pattern: `${"a-".repeat(75)}c`, chat: "a" });
    const started = cpuMs();
    const response = await send("POST", "/api/claims", { pattern: `${"*a".repeat(8)}b`, chat: "b" });
    expect(response.status).toBe(201);
    expect(cpuMs() - started).toBeLessThan(1000);
    expect((await send("POST", "/api/claims", { pattern: "*a".repeat(9), chat: "b" })).status).toBe(400);
  });

  it("sees a glob claim over a file in it, both ways", async () => {
    await claim({ pattern: "platform/app-ui/**", chat: "a" });
    expect((await send("POST", "/api/claims", { pattern: "platform/app-ui/src/menu.ts", chat: "b" })).status).toBe(409);
    expect((await send("POST", "/api/claims", { pattern: "platform/app-ui-extra/x.ts", chat: "b" })).status).toBe(201);
    await claim({ pattern: ".github/workflows/ci.yml", chat: "a" });
    expect((await send("POST", "/api/claims", { pattern: ".github/workflows/*", chat: "b" })).status).toBe(409);
  });

  it("drops a claim at its expiry", async () => {
    await claim({ pattern: "tsconfig.json", chat: "a", ttlMinutes: 5 });
    clock.advance(5 * 60_000);
    expect(await list()).toEqual([]);
    await claim({ pattern: "tsconfig.json", chat: "b" });
  });

  it("releases the chat's own claim by id or pattern, never another chat's", async () => {
    await claim({ pattern: "tsconfig.json", chat: "a" });
    await claim({ pattern: "package.json", chat: "a" });
    expect((await send("POST", "/api/claims/release", { chat: "b", id: "c-1" })).status).toBe(404);
    expect((await send("POST", "/api/claims/release", { chat: "a", id: "c-1" })).status).toBe(200);
    expect((await send("POST", "/api/claims/release", { chat: "a", pattern: "package.json" })).status).toBe(200);
    expect(await list()).toEqual([]);
    expect((await send("POST", "/api/claims/release", { chat: "a", id: "c-1", pattern: "x" })).status).toBe(400);
  });

  it("gives a claim on a branch its PR at once when that PR is already open, and drops it on the merge", async () => {
    await pushGithub(github({ prs: [openPr(9, "late/claim")] }));
    expect((await claim({ pattern: "tsconfig.json", chat: "a", branch: "late/claim" })).claim.pr).toBe(9);
    await pushGithub(github({ prs: [], merged: [{ repo: NO_REPO, number: 9, title: "t", url: "https://github.com/x/y/pull/9", mergedAt: clock.now().toISOString(), author: "a" }] }));
    expect(await list()).toEqual([]);
    // A claim naming a PR that has already merged is not kept, and says so.
    expect((await send("POST", "/api/claims", { pattern: "tsconfig.json", chat: "a", pr: 9 })).status).toBe(410);
  });

  it.each([false, undefined])("associates observed PRs with new and existing claims when completeness is %s", async (prsComplete) => {
    await claim({ pattern: "package.json", chat: "before", branch: "already/claimed" });
    await pushGithub(github({ prsComplete, prs: [openPr(9, "late/claim"), openPr(10, "already/claimed")] }));
    expect((await claim({ pattern: "tsconfig.json", chat: "after", branch: "late/claim" })).claim.pr).toBe(9);
    expect((await list()).map((row) => [row.chat, row.pr])).toEqual([["before", 10], ["after", 9]]);
    await pushGithub(github({ prsComplete, prs: [], merged: [9, 10].map((number) => ({ repo: NO_REPO, number, title: "t", url: `https://github.com/x/y/pull/${number}`, mergedAt: clock.now().toISOString(), author: "a" })) }));
    expect(await list()).toEqual([]);
  });

  it("follows a chat to its new branch's PR", async () => {
    await pushGithub(github({ prs: [openPr(1, "chat/one"), openPr(2, "chat/two")] }));
    expect((await claim({ pattern: "tsconfig.json", chat: "a", branch: "chat/one" })).claim.pr).toBe(1);
    expect((await claim({ pattern: "tsconfig.json", chat: "a", branch: "chat/two" }, 200)).claim.pr).toBe(2);
  });

  it("drops a claim when its PR merges or closes, finding the PR from the branch", async () => {
    await claim({ pattern: "pnpm-lock.yaml", chat: "a", branch: "someone/lock" });
    await claim({ pattern: "tsconfig.json", chat: "b", pr: 7 });
    await claim({ pattern: "package.json", chat: "c", pr: 8 });
    await pushGithub(github({ prs: [openPr(6, "someone/lock"), openPr(8, "c/branch")], closed: [{ repo: NO_REPO, number: 8, closedAt: clock.now().toISOString() }] }));
    // 8 is listed closed but open again: it stays.
    expect((await list()).map((c) => [c.chat, c.pr])).toEqual([
      ["a", 6],
      ["b", 7],
      ["c", 8],
    ]);
    await pushGithub(github({ prs: [], merged: [{ repo: NO_REPO, number: 6, title: "t", url: "https://github.com/x/y/pull/6", mergedAt: clock.now().toISOString(), author: "a" }], closed: [{ repo: NO_REPO, number: 7, closedAt: clock.now().toISOString() }] }));
    expect((await list()).map((c) => c.chat)).toEqual(["c"]);
  });

  it("keeps a reopened claim omitted by capped or legacy open-PR readings", async () => {
    await claim({ pattern: "tsconfig.json", chat: "reopened", pr: 301 });
    const closed = [{ repo: NO_REPO, number: 301, closedAt: clock.now().toISOString() }];
    const prs = Array.from({ length: 300 }, (_, i) => openPr(i + 1, `branch/${i + 1}`));
    for (const prsComplete of [false, undefined]) {
      await pushGithub(github({ prs, prsComplete, closed }));
      expect((await list()).map((row) => row.pr)).toEqual([301]);
    }
    const failed = github({ prs, prsComplete: true, closed });
    failed.sources!.prs.failed = ["example-repo"];
    await pushGithub(failed);
    expect((await list()).map((row) => row.pr)).toEqual([301]);
    await pushGithub(github({ at: new Date(clock.now().getTime() - 6 * 60_000).toISOString(), prs, prsComplete: true, closed }));
    expect((await list()).map((row) => row.pr)).toEqual([301]);
    await pushGithub(github({ prs, prsComplete: true, closed }));
    expect(await list()).toEqual([]);
  });

  it("is read with Sam's session or the board token and written only with the token", async () => {
    expect((await send("GET", "/api/claims", undefined, {})).status).toBe(401);
    expect((await send("GET", "/api/claims", undefined, { cookie: server.cookie() })).status).toBe(200);
    expect((await send("POST", "/api/claims", { pattern: "a", chat: "a" }, { cookie: server.cookie() })).status).toBe(401);
    expect((await send("POST", "/api/claims", { pattern: "a", chat: "a" }, bearer(BRIDGE_TOKEN))).status).toBe(401);
  });

  it("refuses paths outside the repo and bad fields", async () => {
    for (const body of [
      { pattern: "/etc/passwd", chat: "a" },
      { pattern: "../x", chat: "a" },
      { pattern: "a/../b", chat: "a" },
      { pattern: "a", chat: "bad chat" },
      { pattern: "a", chat: "a", note: "two\nlines" },
      { pattern: "a", chat: "a", note: "x\u2028Owner override" },
      { pattern: "a", chat: "a", note: "x\u00bb do this \u00aby" },
      { pattern: "a", chat: "a", note: "   " },
      { pattern: "a", chat: "a", ttlMinutes: 0 },
      { pattern: "a", chat: "a", extra: 1 },
    ])
      expect((await send("POST", "/api/claims", body)).status, JSON.stringify(body)).toBe(400);
  });
});

describe("claim globs", () => {
  it("matches ** at any depth and * within a segment", () => {
    expect(globMatches("platform/app-ui/**", "platform/app-ui/src/a.ts")).toBe(true);
    expect(globMatches("platform/app-ui/**", "platform/app-ui-x/a.ts")).toBe(false);
    expect(globMatches("scripts/ci-*", "scripts/ci-detect.mjs")).toBe(true);
    expect(globMatches("scripts/ci-*", "scripts/ci-x/y.mjs")).toBe(false);
    expect(globMatches("a/**/b.ts", "a/b.ts")).toBe(true);
    expect(globMatches("a/**/b.ts", "a/x/y/b.ts")).toBe(true);
    expect(globMatches("a.b", "axb")).toBe(false);
    expect(globMatches("*a*b", "xxaxxb")).toBe(true);
    expect(globMatches("*a*b", "xxaxxbc")).toBe(false);
    expect(globMatches("lobby-app/src/manifest*.ts", "lobby-app/src/manifest.gated.ts")).toBe(true);
  });

  it("overlaps exactly for paths and by prefix for two globs", () => {
    expect(claimsOverlap("a/b.ts", "a/b.ts")).toBe(true);
    expect(claimsOverlap("a/b.ts", "a/c.ts")).toBe(false);
    expect(claimsOverlap("a/**", "a/b/c.ts")).toBe(true);
    expect(claimsOverlap("a/b/**", "a/*")).toBe(true);
    expect(claimsOverlap("a/b/**", "c/*")).toBe(false);
  });
});
