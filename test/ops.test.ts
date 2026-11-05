import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error the bridge is plain ESM without type declarations
import { collectFly } from "../bridge/lib/ops/fly.mjs";
// @ts-expect-error the bridge is plain ESM without type declarations
import { collectGithub, emptyGithubCache } from "../bridge/lib/ops/github.mjs";
// @ts-expect-error the bridge is plain ESM without type declarations
import { collectMac } from "../bridge/lib/ops/mac.mjs";
// @ts-expect-error the bridge is plain ESM without type declarations
import { parseUsage } from "../bridge/lib/ops/claude.mjs";
// @ts-expect-error the bridge is plain ESM without type declarations
import { showsToken, TOKEN } from "../bridge/test/padded-token.mjs";
import { boardSchema, type BoardResponse } from "../src/shared/board.js";
import { brokenOnMain, isOneOff, longRed, PR_RED_GRACE_MS, newImage, offlineSince, resetText, retiredRunners, zoneClock, type Briefing, type FlySnapshot, type GithubSnapshot, type MacSnapshot, type OpsResponse, type WorkflowRun } from "../src/shared/ops.js";
import { DEFAULT_QUIET, type QuietSettings } from "../src/shared/quiet.js";
import { setTimeZone } from "../src/shared/when.js";
import { rankSearch, type SearchItem } from "../src/shared/search.js";
import { briefingPayload, composeBriefing, currentSlot, type BriefingInputs } from "../src/server/ops/briefing.js";
import { briefingNoteSchema, claudeUsageSnapshotSchema, flySnapshotSchema, githubSnapshotSchema, macSnapshotSchema } from "../src/server/ops/schema.js";
import { loadConfig, type HealthCheck } from "../src/server/config.js";
import { createOps } from "../src/server/ops/service.js";
import { alertSummary, buildOps, buildTimeline, deployAlerts, downAlerts } from "../src/server/ops/view.js";
import { ALERT_BATCH, MAX_PUSH_ATTEMPTS, MAX_QUEUED_ALERTS, OpsStore, PUSH_RETRY_MS, type QueuedPush } from "../src/server/ops/store.js";
import { PushService, TEST_PAYLOAD, type PushReport, type PushSender } from "../src/server/push.js";
import { breaksThrough, DIGEST_GIVE_UP_MS, DIGEST_RETRY_MAX_MS, digestPayload, inQuiet, MAX_HELD, QuietStore } from "../src/server/quiet.js";
import { Store, type PushSubscriptionRow } from "../src/server/store.js";
import { ciOwnedItem, type OwnedItem } from "../src/shared/ops-owned.js";
import { opsStatusKey } from "../src/shared/ops-status-key.js";
import type { OpsStatus } from "../src/shared/ops-status.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, browser, EXAMPLE_BOARD, fakeClock, putBoard, revOf, startServer, type TestServer } from "./helpers.js";

const MS = "example-org/example-repo";
// loadConfig sets the known repos for the whole process, so a load in a test names the ones the fixtures use.
const REPOS = `${MS},example-org/other-repo,example-org/third-repo,example-org/mobile-app`;
const at = (iso: string) => new Date(iso);
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function deployAlert(i: number, expiresAt: Date): QueuedPush {
  return {
    key: `release:app-${i}:1`,
    category: "deploy-failed",
    payload: { title: `App ${i} deploy failed`, body: "Fly release v1 failed.", tag: `deploy-${i}`, path: "/" },
    expiresAt,
  };
}

const RUN: WorkflowRun = {
  repo: MS,
  id: 900,
  attempt: 1,
  workflow: "CI",
  title: "Rivet phase 1",
  status: "completed",
  conclusion: "failure",
  event: "push",
  sha: "a".repeat(40),
  url: "https://github.com/example-org/example-repo/actions/runs/900",
  createdAt: "2026-09-28T01:00:00.000Z",
  updatedAt: "2026-09-28T01:20:00.000Z",
  failedJobs: ["Deploy Notes App to Fly"],
};

const fine = { failed: [], at: "2026-09-28T02:00:00.000Z" };
const OK_SOURCES: GithubSnapshot["sources"] = { prs: fine, runs: fine, merged: fine, runners: fine, queue: fine };

function github(extra: Partial<GithubSnapshot> = {}): GithubSnapshot {
  return {
    at: "2026-09-28T02:00:00.000Z",
    prs: [
      {
        repo: MS,
        number: 2177,
        title: "Rivet v2: Ops board",
        url: "https://github.com/example-org/example-repo/pull/2177",
        draft: true,
        author: "example-org",
        labels: ["notes:skip"],
        headAt: "2026-09-28T01:00:00.000Z",
        updatedAt: "2026-09-28T01:00:00.000Z",
        checks: { state: "fail", passed: 3, failed: 1, pending: 0, failing: ["rivet tests"] },
      },
    ],
    runs: [RUN],
    runners: { online: 2, busy: 1, offline: 1, runners: [{ name: "mac-1", status: "online", busy: true }] },
    queue: { queuedRuns: 1, runningRuns: 1, queuedJobs: 3 },
    merged: [
      {
        repo: MS,
        number: 216,
        title: "Phases 2-4",
        url: "https://github.com/example-org/example-repo/pull/216",
        mergedAt: "2026-09-27T23:00:00.000Z",
        author: "example-org",
      },
    ],
    sources: OK_SOURCES,
    ...extra,
  };
}

function mac(freeFraction = 0.4, extra: Partial<MacSnapshot> = {}): MacSnapshot {
  return {
    at: "2026-09-28T02:00:00.000Z",
    name: "test-mac",
    volumes: [{ label: "Data", totalBytes: 1000, freeBytes: Math.round(1000 * freeFraction), runners: true }],
    load: { one: 2, five: 2, fifteen: 2, cpus: 12 },
    memory: { freePct: 40, pressure: "normal" },
    uptimeSec: 3600,
    runners: [{ name: "mac-1", alive: true }],
    chatRunner: true,
    ...extra,
  };
}

const FLY: FlySnapshot = {
  at: "2026-09-28T02:00:00.000Z",
  source: { failed: [], at: null },
  apps: [
    {
      app: "notes-app",
      status: "deployed",
      version: 12,
      sha: "c".repeat(12),
      machines: { started: 1, total: 1 },
      checks: { passing: 1, total: 1 },
      updatedAt: "2026-09-28T01:00:00.000Z",
      releases: [
        { version: 12, status: "failed", at: "2026-09-28T01:30:00.000Z" },
        { version: 11, status: "complete", at: "2026-09-27T01:00:00.000Z" },
      ],
    },
  ],
};

describe("bridge payload bounds", () => {
  beforeEach(() => vi.stubEnv("RIVET_REPOS", REPOS));
  afterEach(() => vi.unstubAllEnvs());

  it("accepts optional completeness metadata and rejects malformed coverage", () => {
    const old = github();
    expect(githubSnapshotSchema.safeParse(old).success).toBe(true);
    expect(githubSnapshotSchema.parse(old).prsComplete).toBeUndefined();
    const current = { ...old, prsComplete: false,
      queue: { queuedRuns: 9, runningRuns: 0, queuedJobs: 8, sampledRuns: 8, runsComplete: true, jobsComplete: false },
      runners: { online: 100, busy: 1, offline: 0, runners: [], complete: false, detailsComplete: false } };
    expect(githubSnapshotSchema.safeParse(current).success).toBe(true);
    expect(githubSnapshotSchema.safeParse({ ...current, prsComplete: "yes" }).success).toBe(false);
    expect(githubSnapshotSchema.safeParse({ ...current, queue: { ...current.queue, sampledRuns: -1 } }).success).toBe(false);
    expect(githubSnapshotSchema.safeParse({ ...current, runners: { ...current.runners, detailsComplete: 1 } }).success).toBe(false);
  });

  it("accepts well-formed snapshots", () => {
    expect(githubSnapshotSchema.safeParse(github()).success).toBe(true);
    expect(macSnapshotSchema.safeParse(mac()).success).toBe(true);
    expect(flySnapshotSchema.safeParse(FLY).success).toBe(true);
  });

  it("refuses oversized lists, unknown repos, stray keys and paths", () => {
    const pr = github().prs[0]!;
    expect(githubSnapshotSchema.safeParse(github({ prs: Array.from({ length: 301 }, (_, i) => ({ ...pr, number: i + 1 })) })).success).toBe(false);
    expect(githubSnapshotSchema.safeParse(github({ runs: Array.from({ length: 151 }, (_, i) => ({ ...RUN, id: i + 1 })) })).success).toBe(false);
    expect(githubSnapshotSchema.safeParse(github({ prs: [{ ...pr, repo: "someone/else" }] })).success).toBe(false);
    expect(githubSnapshotSchema.safeParse(github({ prs: [{ ...pr, title: "x".repeat(301) }] })).success).toBe(false);
    expect(githubSnapshotSchema.safeParse(github({ prs: [{ ...pr, url: "https://evil.example/pull/1" }] })).success).toBe(false);
    expect(githubSnapshotSchema.safeParse({ ...github(), transcript: "hi" }).success).toBe(false);
    expect(githubSnapshotSchema.safeParse(github({ prs: [{ ...pr, branch: "fix/lost-note-12" }] })).success).toBe(true);
    const progress = { headSha: "a".repeat(40), hold: "Owner hold: Sam OKs it", ciStartedAt: "2026-09-28T01:50:00.000Z" };
    expect(githubSnapshotSchema.safeParse({ ...github({ prs: [{ ...pr, ...progress }] }), ciTypicalMin: 21 }).success).toBe(true);
    expect(githubSnapshotSchema.safeParse(github({ prs: [{ ...pr, ...progress, headSha: "abc" }] })).success).toBe(false);
    expect(githubSnapshotSchema.safeParse(github({ prs: [{ ...pr, ...progress, hold: "x".repeat(201) }] })).success).toBe(false);
    expect(githubSnapshotSchema.safeParse({ ...github(), ciTypicalMin: 0 }).success).toBe(false);
    for (const branch of ["", "a..b", "has space", "x".repeat(201), join(homedir(), ".ssh", "id"), "a//b", ".hidden", "a/.b", "a/"]) expect(githubSnapshotSchema.safeParse(github({ prs: [{ ...pr, branch }] })).success, branch).toBe(false);
    expect(macSnapshotSchema.safeParse(mac(0.4, { volumes: [{ label: homedir(), totalBytes: 1, freeBytes: 1, runners: false }] })).success).toBe(false);
    const volume = mac().volumes[0]!;
    expect(macSnapshotSchema.safeParse(mac(0.4, { volumes: Array.from({ length: 13 }, () => volume) })).success).toBe(false);
    expect(macSnapshotSchema.safeParse({ ...mac(), path: homedir() }).success).toBe(false);
    const app = FLY.apps[0]!;
    expect(flySnapshotSchema.safeParse({ ...FLY, apps: [{ ...app, app: "Bad App" }] }).success).toBe(false);
    expect(flySnapshotSchema.safeParse({ ...FLY, apps: Array.from({ length: 101 }, () => app) }).success).toBe(false);
    expect(flySnapshotSchema.safeParse({ ...FLY, apps: [{ ...app, releases: Array.from({ length: 31 }, () => app.releases[0]) }] }).success).toBe(false);
    expect(flySnapshotSchema.safeParse({ ...FLY, apps: [{ ...app, email: "x@y.z" }] }).success).toBe(false);
  });

  it("bounds briefing notes", () => {
    expect(briefingNoteSchema.safeParse({ text: "Notes App is back" }).success).toBe(true);
    expect(briefingNoteSchema.safeParse({ text: "x".repeat(281) }).success).toBe(false);
    expect(briefingNoteSchema.safeParse({ text: "two\nlines" }).success).toBe(false);
    expect(briefingNoteSchema.safeParse({ text: "   " }).success).toBe(false);
  });

  it("accepts what the bridge collectors produce", async () => {
    const exec = async (bin: string, args: string[]) => {
      const joined = args.join(" ");
      let stdout = "[]";
      if (bin === "gh" && args[1] === "graphql")
        stdout = JSON.stringify({
          data: {
            repository: {
              pullRequests: {
                nodes: [
                  {
                    number: 7,
                    title: "A\ttitle",
                    url: "https://github.com/example-org/other-repo/pull/7",
                    isDraft: false,
                    updatedAt: "2026-09-28T00:00:00Z",
                    author: { login: "app/renovate" },
                    labels: { nodes: [{ name: "hold" }] },
                    commits: { nodes: [{ commit: { committedDate: "2026-09-28T00:00:00Z", statusCheckRollup: null } }] },
                  },
                ],
              },
            },
          },
        });
      else if (bin === "gh" && joined.includes("/actions/runners")) stdout = JSON.stringify([{ name: "mac-1", status: "online", busy: false }]);
      else if (bin === "gh" && joined.includes("length")) stdout = "0";
      else if (bin === "/bin/df") stdout = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 100 50 50 50% /System/Volumes/Data\n/dev/disk9 100 99 1 99% /Volumes/My Disk\n";
      else if (bin === "/usr/sbin/sysctl") stdout = "3\n";
      else if (bin === "/bin/launchctl") stdout = "PID\tStatus\tLabel\n1\t0\tactions.runner.x.mac-1\n";
      else if (bin === "flyctl")
        stdout = args[0] === "status" ? JSON.stringify({ Status: "Deployed", Machines: [{ state: "started" }] }) : JSON.stringify([{ Version: 1, Status: "complete", CreatedAt: "2026-09-27T00:00:00Z" }]);
      return { stdout, stderr: "" };
    };
    const now = () => at("2026-09-28T02:00:00Z");
    const gh = await collectGithub({ exec, ghBin: "gh", now, cache: emptyGithubCache() });
    expect(githubSnapshotSchema.safeParse(gh).error?.issues).toBeUndefined();
    const m = await collectMac({ exec, now, host: { hostname: () => "test-mac", loadavg: () => [1, 1, 1], cpus: () => [{}], uptime: () => 1 } });
    expect(macSnapshotSchema.safeParse(m).error?.issues).toBeUndefined();
    expect(m.volumes.map((v: { label: string }) => v.label)).toEqual(["Data", "External 1"]);
    const fly = await collectFly({ exec, flyBin: "flyctl", apps: ["rivet-agents"], now });
    expect(flySnapshotSchema.safeParse(fly).error?.issues).toBeUndefined();
  });

  it("accepts a GitHub snapshot whose names held secrets: redacted whole, each in its bound, a login kept, a patterned field fitted", async () => {
    const repo = "example-org/example-repo";
    const author = "a1".repeat(16);
    const grown = `${"ok ".repeat(34)}password=x`;
    const run = (id: number, workflowName: string, status: string, conclusion: string) => ({
      databaseId: id, workflowName, displayTitle: "t", status, conclusion, event: "push", headSha: "a".repeat(40),
      url: `https://github.com/${repo}/actions/runs/${id}`, createdAt: "2026-09-28T01:00:00Z", updatedAt: "2026-09-28T01:20:00Z",
    });
    const check = { __typename: "CheckRun", name: "ok ".repeat(35) + TOKEN, status: "COMPLETED", conclusion: "FAILURE" };
    const pr = {
      number: 7, title: "t", url: `https://github.com/${repo}/pull/7`, isDraft: false, updatedAt: "2026-09-28T00:00:00Z", author: { login: author }, labels: { nodes: [] },
      commits: { nodes: [{ commit: { committedDate: "2026-09-28T00:00:00Z", statusCheckRollup: { contexts: { nodes: [check] } } } }] },
    };
    const exec = async (_bin: string, args: string[]) => {
      const joined = args.join(" ");
      let stdout = "[]";
      if (args[1] === "graphql") stdout = JSON.stringify({ data: { repository: { pullRequests: { nodes: [pr] } } } });
      else if (joined.includes(`repos/${repo}/actions/runs?branch=main&`))
        stdout = JSON.stringify([run(900, grown, "completed", "failure"), { ...run(901, "safe ".repeat(22) + TOKEN, "in_progress", ""), event: "a_okofzbelfcruwdqqgtekzwreichx" }]);
      else if (joined.includes("/actions/runners")) stdout = JSON.stringify({ total_count: 2, runners: [{ name: author, status: "online", busy: false }, { name: "runner-1", status: "online", busy: true }] });
      else if (joined.includes("/actions/runs/900/jobs")) stdout = JSON.stringify([`${"job ".repeat(27)}  ${TOKEN}`, grown]);
      else if (joined.includes("length")) stdout = "0";
      return { stdout, stderr: "" };
    };
    const gh = await collectGithub({ exec, ghBin: "gh", now: () => at("2026-09-28T02:00:00Z"), cache: emptyGithubCache() });
    expect(githubSnapshotSchema.safeParse(gh).error?.issues).toBeUndefined();
    expect(showsToken(JSON.stringify(gh))).toBe(false);
    expect(gh.prs.find((p: { number: number }) => p.number === 7)?.author).toBe(author);
    expect(gh.runs.map((r: { id: number }) => r.id).sort()).toEqual([900, 901]);
    expect(gh.runs.find((r: { id: number }) => r.id === 900)?.failedJobs).toHaveLength(2);
    expect(gh.runs.find((r: { id: number }) => r.id === 901)?.event).toBe("redacted");
    expect(gh.runners?.runners.map((r: { name: string }) => r.name)).toEqual(["redacted", "runner-1"]);
    expect([gh.runners?.online, gh.runners?.busy]).toEqual([2, 1]);
  });
});

describe("reset countdown", () => {
  const at = (iso: string) => Date.parse(iso);
  // 2026-10-01T03:00Z is Thu 14:00 local time (UTC+11).
  const now = at("2026-10-01T03:00:00.000Z");

  it("shows the time and the countdown under a day", () => {
    expect(resetText("2026-10-01T07:14:00.000Z", now)).toBe("resets 6:14pm, in 4h 14m");
    expect(resetText("2026-10-01T03:09:00.000Z", now)).toBe("resets 2:09pm, in 9m");
    expect(resetText("2026-10-01T03:00:20.000Z", now)).toBe("resets 2:00pm, in 1m");
    expect(resetText("2026-10-02T02:59:00.000Z", now)).toBe("resets Fri 1:59pm, in 23h 59m");
  });

  it("adds the weekday and the days once a day or more out, 1 day singular", () => {
    expect(resetText("2026-10-02T03:00:00.000Z", now)).toBe("resets Fri 2:00pm, in 1 day, 0h 0m");
    expect(resetText("2026-10-02T04:05:00.000Z", now)).toBe("resets Fri 3:05pm, in 1 day, 1h 5m");
    expect(resetText("2026-10-03T02:59:00.000Z", now)).toBe("resets Sat 1:59pm, in 1 day, 23h 59m");
    expect(resetText("2026-10-03T03:00:00.000Z", now)).toBe("resets Sat 2:00pm, in 2 days, 0h 0m");
    expect(resetText("2026-10-08T13:00:00.000Z", now)).toBe("resets Fri 12:00am, in 7 days, 10h 0m");
  });

  it("counts real time across a clock change while the label keeps local clock time", () => {
    setTimeZone("Pacific/Auckland");
    try {
      // Sunday 27 September's clocks skip an hour: midnight Saturday to midnight Monday is two calendar days, an hour short.
      expect(resetText("2026-09-27T11:00:00.000Z", at("2026-09-25T12:00:00.000Z"))).toBe("resets Mon 12:00am, in 1 day, 23h 0m");
      // 01:30 to 04:00 on the change night is 1h 30m, not 2h 30m.
      expect(resetText("2026-09-26T15:00:00.000Z", at("2026-09-26T13:30:00.000Z"))).toBe("resets 4:00am, in 1h 30m");
    } finally {
      setTimeZone(undefined);
    }
  });

  it("says resetting now when due, and nothing without a valid time", () => {
    expect(resetText("2026-10-01T03:00:00.000Z", now)).toBe("resetting now");
    expect(resetText("2026-10-01T02:00:00.000Z", now)).toBe("resetting now");
    expect(resetText(null, now)).toBeNull();
    expect(resetText("soon", now)).toBeNull();
  });
});

describe("briefing slots", () => {
  it("picks 07:30 and 18:00 local, else yesterday evening", () => {
    // UTC+11: 07:30 local is 20:30 UTC the day before, 18:00 local is 07:00 UTC.
    expect(currentSlot(at("2026-09-27T20:29:00Z")).id).toBe("2026-09-27-evening");
    expect(currentSlot(at("2026-09-27T20:30:00Z")).id).toBe("2026-09-28-morning");
    expect(currentSlot(at("2026-09-28T07:00:00Z")).id).toBe("2026-09-28-evening");
    expect(currentSlot(at("2026-09-28T07:00:00Z")).at.toISOString()).toBe("2026-09-28T07:00:00.000Z");
  });

  it("follows daylight saving in both directions", () => {
    setTimeZone("Pacific/Auckland");
    try {
      // UTC+13 from 2026-09-27: 07:30 local is 18:30 UTC the day before.
      expect(currentSlot(at("2026-09-28T18:30:00Z")).id).toBe("2026-09-29-morning");
      expect(currentSlot(at("2026-09-28T18:29:00Z")).id).toBe("2026-09-28-evening");
      expect(currentSlot(at("2026-09-29T05:00:00Z")).at.toISOString()).toBe("2026-09-29T05:00:00.000Z");
      // The switch morning itself: 07:30 on 2026-09-27 is 18:30 UTC on 09-26.
      expect(currentSlot(at("2026-09-26T18:30:00Z")).at.toISOString()).toBe("2026-09-26T18:30:00.000Z");
      // Back to UTC+12 on 2026-04-05.
      expect(currentSlot(at("2026-04-05T06:00:00Z")).id).toBe("2026-04-05-evening");
      expect(currentSlot(at("2026-04-04T18:30:00Z")).id).toBe("2026-04-04-evening");
      expect(currentSlot(at("2026-04-04T19:30:00Z")).id).toBe("2026-04-05-morning");
    } finally {
      setTimeZone(undefined);
    }
  });
});

function inputs(extra: Partial<BriefingInputs> = {}): BriefingInputs {
  const board = boardSchema.parse(EXAMPLE_BOARD);
  return {
    board,
    github: github(),
    merged: github().merged ?? [],
    fly: FLY,
    apps: [],
    mac: mac(),
    macStale: false,
    previous: null,
    ...extra,
  };
}

describe("composeBriefing", () => {
  const slot = currentSlot(at("2026-09-27T21:30:00Z"));
  const now = at("2026-09-27T21:31:00Z");

  it("covers shipped, failures, apps and the Mac, and leaves needs to the live row", () => {
    const b = composeBriefing(inputs(), slot, at("2026-09-28T02:00:00Z"));
    expect(b.id).toBe("2026-09-28-morning");
    expect(b.items.map((item) => item.key)).toEqual(["shipped", "failures", "apps", "mac"]);
    const shipped = b.items[0]!;
    expect(shipped.title).toBe("1 PR merged, 1 more shipped");
    expect(shipped.lines).toEqual(["Shipped: Touch action guard", "example-repo #216 Phases 2-4"]);
    const failures = b.items[1]!;
    expect(failures.tone).toBe("bad");
    expect(failures.lines).toEqual(["example-repo: CI failure", "notes-app v12 release failed", "Deploy Notes App to Fly"]);
    expect(b.headline).toMatch(/^1 merged · 1 shipped · 1 red · 2 failed deploys/);
    expect(b.headline).not.toContain("$");
  });

  it("counts a shipped row for a merged PR once, as the merge", () => {
    const board = boardSchema.parse({ ...EXAMPLE_BOARD, shipped: [{ pr: 216, title: "Phases 2-4 shipped" }] });
    const b = composeBriefing(inputs({ board }), slot, at("2026-09-28T02:00:00Z"));
    const shipped = b.items.find((item) => item.key === "shipped")!;
    expect(shipped.title).toBe("1 PR merged");
    expect(shipped.lines).toEqual(["example-repo #216 Phases 2-4"]);
    expect(b.headline).toMatch(/^1 merged · 1 red/);
  });

  it("leaves a hand-started run's red out of the briefing, as Ops and Rivet leave it out", () => {
    const oneOff: WorkflowRun = { ...RUN, workflow: "Nightly report (base)", event: "workflow_dispatch" };
    const b = composeBriefing(inputs({ github: github({ runs: [oneOff] }) }), slot, at("2026-09-28T02:00:00Z"));
    expect(b.headline).not.toMatch(/\bred\b/);
  });

  it("says the Mac's memory and runners calmly when its record says someone is on it", () => {
    const sick = mac(0.4, { memory: { freePct: 3, pressure: "critical" }, runners: [{ name: "runner-1", alive: false }] });
    const brief = (owned: (item: OwnedItem) => boolean) =>
      composeBriefing(inputs({ mac: sick, github: github({ runs: [] }), fly: null, owned }), slot, at("2026-09-28T02:00:00Z"));
    const onIt = brief((item) => item.kind === "machine" && item.key === "mac");
    expect(onIt.items.find((one) => one.key === "mac")).toMatchObject({
      tone: "info",
      title: "Agents on it: Mac",
      lines: ["Memory pressure critical, agents on it", "1 runner not running, agents on it"],
    });
    expect(onIt.headline).not.toContain("Mac warning");
    // A memory warning is no fault of the Mac item: it stays amber whoever is on the Mac.
    const amber = composeBriefing(
      inputs({ mac: mac(0.4, { memory: { freePct: 12, pressure: "warn" } }), github: github({ runs: [] }), fly: null, owned: (item) => item.key === "mac" }),
      slot,
      at("2026-09-28T02:00:00Z"),
    );
    expect(amber.items.find((one) => one.key === "mac")).toMatchObject({ tone: "warn", lines: ["Memory pressure warn"] });
    const nobody = brief(() => false);
    expect(nobody.items.find((one) => one.key === "mac")).toMatchObject({ tone: "warn", title: "Mac needs a look" });
    expect(nobody.headline).toContain("Mac warning");
  });

  it("says a down app and a full disk someone is on calmly, and keeps the ones nobody is on red", () => {
    const down = { state: "down" as const, status: 502, ms: 90, checkedAt: "2026-09-28T01:50:00.000Z", since: "2026-09-28T01:40:00.000Z", fails: 3 };
    const app = (id: string, name: string) => ({ id, name, app: null, url: "https://x.example/health", health: down, fly: null });
    const apps = [app("notes-app", "Notes App"), app("tasks-app", "Tasks App")];
    const owned = (item: OwnedItem) => item.key === "notes-app" || item.kind === "disk";
    const b = composeBriefing(inputs({ apps, mac: mac(0.02), github: github({ runs: [] }), fly: null, owned }), slot, at("2026-09-28T02:00:00Z"));
    const item = (key: string) => b.items.find((one) => one.key === key)!;
    expect(item("apps")).toMatchObject({ tone: "bad", title: "1 app down", lines: ["Tasks App (HTTP 502)", "Notes App (HTTP 502), agents on it"] });
    expect(item("mac")).toMatchObject({ tone: "info", title: "Agents on it: Mac", lines: ["Data: 2% free, agents on it"] });
    expect(b.headline).not.toContain("Mac warning");
    expect(b.headline).toContain("1 down · Agents on it: 1 down");

    // With only the owned app down, the item is calm and the headline has no "down" of its own.
    const calm = composeBriefing(inputs({ apps: [apps[0]!], github: github({ runs: [] }), fly: null, owned }), slot, at("2026-09-28T02:00:00Z"));
    expect(calm.items.find((one) => one.key === "apps")).toMatchObject({ tone: "info", title: "Agents on it: 1 app down" });
    expect(calm.headline).not.toMatch(/(^|· )1 down/);
    // Without the test, as before, it is red.
    expect(composeBriefing(inputs({ apps: [apps[0]!] }), slot, at("2026-09-28T02:00:00Z")).items.find((one) => one.key === "apps")?.tone).toBe("bad");
  });

  it("says calmly in its push a break someone took on after it was composed; while nobody is, as it was", () => {
    const down = { state: "down" as const, status: 502, ms: 90, checkedAt: "2026-09-28T01:50:00.000Z", since: "2026-09-28T01:40:00.000Z", fails: 3 };
    const app = (id: string, name: string) => ({ id, name, app: null, url: "https://x.example/health", health: down, fly: null });
    const apps = [app("notes-app", "Notes App"), app("tasks-app", "Tasks App")];
    const owned = (item: OwnedItem) => item.key === "notes-app" || item.kind === "disk";
    const given = { apps, mac: mac(0.02), github: github({ runs: [] }), fly: null };
    const b = composeBriefing(inputs(given), slot, at("2026-09-28T02:00:00Z"));
    expect(b.headline).toBe("1 merged · 1 shipped · 2 down · Mac warning");
    expect(briefingPayload(b).body).toBe(b.headline);
    expect(briefingPayload(b, () => false).body, "nobody on anything: as composed").toBe(b.headline);
    // Taken on since: the push says it as a briefing composed now would.
    const calm = briefingPayload(b, owned).body;
    expect(calm).toBe(composeBriefing(inputs({ ...given, owned }), slot, at("2026-09-28T02:00:00Z")).headline);
    expect(calm).toBe("1 merged · 1 shipped · 1 down · Agents on it: 1 down");
    // A Mac warning with a cause no record clears (the chat runner down) stays.
    const noChat = composeBriefing(inputs({ ...given, mac: { ...mac(0.02), chatRunner: false } }), slot, at("2026-09-28T02:00:00Z"));
    expect(briefingPayload(noChat, owned).body).toContain("Mac warning");
    // One stored before the counts were kept says its headline as it was.
    expect(briefingPayload({ ...b, alarms: undefined }, owned).body).toBe(b.headline);
    // Composed while someone was on Notes App and the disk, nobody on them any more: each is a break again, and one
    // taken on instead (Tasks App) does not hide them.
    const onNotes = composeBriefing(inputs({ ...given, owned }), slot, at("2026-09-28T02:00:00Z"));
    expect(briefingPayload(onNotes, () => false).body).toBe(b.headline);
    expect(briefingPayload(onNotes, (item) => item.key === "tasks-app").body).toBe("1 merged · 1 shipped · 1 down · Agents on it: 1 down · Mac warning");
  });

  it("is deterministic for the same inputs", () => {
    expect(composeBriefing(inputs(), slot, now)).toEqual(composeBriefing(inputs(), slot, now));
  });

  it("lists only what changed since the previous briefing", () => {
    const first = composeBriefing(inputs(), slot, at("2026-09-28T00:00:00Z"));
    const next = composeBriefing(inputs({ previous: first }), currentSlot(at("2026-09-28T07:00:00Z")), at("2026-09-28T07:01:00Z"));
    expect(next.since).toBe(first.composedAt);
    expect(next.items[0]!.title).toBe("Nothing merged since the last briefing");
  });

  it("keys shipped rows on the PR, then the stamp, so a title edit is not shipped again", () => {
    const rows = [{ pr: 105, title: "Touch action guard" }, { title: "Menu tidy", shippedAt: "2026-09-27T20:00:00Z" }, { title: "Font swap" }];
    const first = composeBriefing(inputs({ merged: [], board: boardSchema.parse({ ...EXAMPLE_BOARD, shipped: rows }) }), slot, at("2026-09-28T00:00:00Z"));
    expect(first.shippedSeen).toEqual(["pr:105", "at:2026-09-27T20:00:00Z", "title:Font swap"]);
    const renamed = [{ pr: 105, title: "Touch guard, live" }, { title: "Menu tidy, live", shippedAt: "2026-09-27T20:00:00Z" }, { title: "Font swap, live" }];
    const board = boardSchema.parse({ ...EXAMPLE_BOARD, shipped: renamed });
    const next = composeBriefing(inputs({ merged: [], board, previous: first }), currentSlot(at("2026-09-28T07:00:00Z")), at("2026-09-28T07:01:00Z"));
    expect(next.items.find((item) => item.key === "shipped")?.lines).toEqual(["Shipped: Font swap, live"]);
  });

  it("still matches a briefing stored with bare shipped titles", () => {
    const first = { ...composeBriefing(inputs({ merged: [] }), slot, at("2026-09-28T00:00:00Z")), shippedSeen: ["Touch action guard"] };
    const next = composeBriefing(inputs({ merged: [], previous: first }), currentSlot(at("2026-09-28T07:00:00Z")), at("2026-09-28T07:01:00Z"));
    expect(next.items.find((item) => item.key === "shipped")?.title).toBe("Nothing merged since the last briefing");
    expect(next.shippedSeen).toEqual(["pr:105"]);
  });

  it("includes a merge the bridge delivered after the last briefing's cutoff, once", () => {
    const first = composeBriefing(inputs({ merged: [] }), slot, at("2026-09-28T00:00:00Z"));
    const lateMerge = { ...github().merged![0]!, number: 217, mergedAt: "2026-09-27T23:30:00.000Z" };
    const nextSlot = currentSlot(at("2026-09-28T07:00:00Z"));
    const next = composeBriefing(inputs({ merged: [lateMerge], previous: first }), nextSlot, at("2026-09-28T07:01:00Z"));
    expect(next.items[0]!.lines).toContain("example-repo #217 Phases 2-4");
    const after = composeBriefing(inputs({ merged: [lateMerge], previous: next }), currentSlot(at("2026-09-28T21:00:00Z")), at("2026-09-28T21:01:00Z"));
    expect(after.items[0]!.lines.some((line) => line.includes("#217"))).toBe(false);
  });

  it("carries seen ids forward when a source drops an event for one briefing", () => {
    const merge = { ...github().merged![0]!, number: 2171, mergedAt: "2026-09-27T21:00:00.000Z" };
    const first = composeBriefing(inputs({ merged: [merge] }), slot, at("2026-09-27T21:31:00Z"));
    expect(first.items[0]!.lines.some((line) => line.includes("#2171"))).toBe(true);
    const gap = composeBriefing(inputs({ merged: [], previous: first }), currentSlot(at("2026-09-28T07:00:00Z")), at("2026-09-28T07:01:00Z"));
    expect(gap.seen?.map((entry) => entry.id)).toContain(`pr:${MS}#2171`);
    const back = composeBriefing(inputs({ merged: [merge], previous: gap }), currentSlot(at("2026-09-28T08:00:00Z")), at("2026-09-28T08:01:00Z"));
    expect(back.items[0]!.lines.some((line) => line.includes("#2171"))).toBe(false);
  });

  it("reports stale GitHub, Fly and app data instead of good news", () => {
    const later = at("2026-09-28T02:30:00Z");
    const apps = [
      {
        id: "notes-app",
        name: "Notes App",
        app: "notes-app",
        url: "https://notes-app.example.com/health",
        health: { state: "up" as const, status: 200, ms: 90, checkedAt: "2026-09-28T02:00:00.000Z", since: null, fails: 0 },
        fly: null,
      },
    ];
    const b = composeBriefing(inputs({ github: github({ runs: [] }), fly: { ...FLY, apps: [] }, apps }), currentSlot(later), later);
    const failures = b.items.find((item) => item.key === "failures")!;
    expect(failures.title).toBe("Main and Fly deploys unknown");
    expect(failures.lines).toEqual(["GitHub data from 1:00pm, stale", "Fly data from 1:00pm, stale"]);
    const appItem = b.items.find((item) => item.key === "apps")!;
    expect(appItem.title).toBe("App health unknown");
    expect(appItem.tone).toBe("warn");
    expect(appItem.lines[0]).toBe("App checks from 1:00pm, stale");
    const fresh = composeBriefing(inputs({ github: github({ runs: [], at: "2026-09-28T02:25:00.000Z" }), fly: { ...FLY, apps: [], at: "2026-09-28T02:25:00.000Z" } }), currentSlot(later), later);
    expect(fresh.items.find((item) => item.key === "failures")!.title).toBe("Main is green, no failed deploys");
    const flyStale = composeBriefing(inputs({ github: github({ runs: [], at: "2026-09-28T02:25:00.000Z" }), fly: { ...FLY, apps: [], at: "2026-09-28T01:00:00.000Z" } }), currentSlot(later), later);
    expect(flyStale.items.find((item) => item.key === "failures")!.title).toBe("Main is green, Fly deploys unknown");
  });

  it("never calls main green when GitHub was unreachable", () => {
    const down = { failed: ["example-repo"], at: "2026-09-28T01:48:00.000Z" };
    const b = composeBriefing(inputs({ github: github({ runs: [], sources: { ...OK_SOURCES, runs: down } }) }), slot, now);
    const failures = b.items.find((item) => item.key === "failures")!;
    expect(failures.tone).toBe("warn");
    expect(failures.title).toBe("Main status unknown, no failed deploys seen");
    expect(failures.lines[0]).toBe("GitHub unreachable for main runs (example-repo), data from Mon 28 Sept 12:48pm");
    const none = composeBriefing(inputs({ github: null }), slot, now).items.find((item) => item.key === "failures")!;
    expect(none.title).not.toMatch(/green/);
  });

  it("never reports no failed deploys while Fly is unreachable or has sent nothing", () => {
    const later = at("2026-09-28T02:00:00Z");
    const down: FlySnapshot = { ...FLY, apps: [], source: { failed: ["notes-app"], at: "2026-09-28T01:48:00.000Z" } };
    const failures = composeBriefing(inputs({ github: github({ runs: [] }), fly: down }), slot, later).items.find((item) => item.key === "failures")!;
    expect(failures.tone).toBe("warn");
    expect(failures.title).toBe("Main is green, Fly deploys unknown");
    expect(failures.lines).toEqual(["Fly unreachable for notes-app, data from Mon 28 Sept 12:48pm"]);
    const none = composeBriefing(inputs({ github: github({ runs: [] }), fly: null }), slot, later).items.find((item) => item.key === "failures")!;
    expect(none.title).toBe("Main is green, Fly deploys unknown");
    expect(none.lines).toEqual(["No Fly data yet"]);
    const view = buildOps({ now: later, bridgeConnected: true, board: null, github: null, mac: null, fly: down, checks: [], health: {} });
    expect(view.flySource).toEqual(down.source);
  });

  it("reads seen ids stored as plain strings, and keeps the cutoff exact when none can be read", () => {
    const lateMerge = { ...github().merged![0]!, number: 217, mergedAt: "2026-09-27T23:30:00.000Z" };
    const first = composeBriefing(inputs({ merged: [lateMerge] }), slot, at("2026-09-28T00:00:00Z"));
    expect(first.items[0]!.lines).toContain("example-repo #217 Phases 2-4");
    const nextSlot = currentSlot(at("2026-09-28T07:00:00Z"));
    const legacy = { ...first, seen: [`pr:${MS}#217`] } as unknown as Briefing;
    const next = composeBriefing(inputs({ merged: [lateMerge], previous: legacy }), nextSlot, at("2026-09-28T07:01:00Z"));
    expect(next.items[0]!.lines.some((line) => line.includes("#217"))).toBe(false);
    expect(next.seen?.map((entry) => entry.id)).toContain(`pr:${MS}#217`);
    const garbled = { ...first, seen: [42] } as unknown as Briefing;
    const exact = composeBriefing(inputs({ merged: [lateMerge], previous: garbled }), nextSlot, at("2026-09-28T07:01:00Z"));
    expect(exact.items[1]!.lines.some((line) => line.includes("#217"))).toBe(false);
  });

  it("warns on low disk, pressure, dead runners and a stale Mac", () => {
    const low = composeBriefing(inputs({ mac: mac(0.04, { memory: { freePct: 5, pressure: "critical" }, chatRunner: false }) }), slot, now);
    const macItem = low.items.find((item) => item.key === "mac")!;
    expect(macItem.tone).toBe("bad");
    expect(macItem.lines).toEqual(["Data: 4% free", "Memory pressure critical", "Chat runner down"]);
    const noRunner = composeBriefing(inputs({ mac: mac(0.5, { chatRunner: false }) }), slot, now).items.find((item) => item.key === "mac")!;
    expect(noRunner.lines).toContain("Chat runner down");
    const amber = composeBriefing(inputs({ mac: mac(0.1) }), slot, now).items.find((item) => item.key === "mac")!;
    expect(amber.tone).toBe("warn");
    expect(composeBriefing(inputs({ macStale: true }), slot, now).items.find((item) => item.key === "mac")!.lines).toEqual([
      "Mac health from 1:00pm, stale",
    ]);
  });
});

class FakeSender implements PushSender {
  readonly sent: Record<string, string>[] = [];
  calls = 0;
  /** What the push service answers; a thrown error is a network failure. */
  answer: () => number = () => 201;
  async send(_target: PushSubscriptionRow, payload: string): Promise<number> {
    this.calls += 1;
    const status = this.answer();
    if (status >= 200 && status < 300) this.sent.push(JSON.parse(payload) as Record<string, string>);
    return status;
  }
}

describe("quiet hours", () => {
  const quiet: QuietSettings = DEFAULT_QUIET;

  it("wraps midnight local time", () => {
    expect(inQuiet(quiet, at("2026-09-28T11:00:00Z"))).toBe(true); // 22:00 local
    expect(inQuiet(quiet, at("2026-09-28T10:59:00Z"))).toBe(false);
    expect(inQuiet(quiet, at("2026-09-27T19:59:00Z"))).toBe(true); // 06:59 local
    expect(inQuiet(quiet, at("2026-09-27T20:00:00Z"))).toBe(false);
    expect(inQuiet({ ...quiet, enabled: false }, at("2026-09-28T11:00:00Z"))).toBe(false);
    expect(inQuiet({ ...quiet, start: "09:00", end: "09:00" }, at("2026-09-28T11:00:00Z"))).toBe(false);
    expect(inQuiet({ ...quiet, start: "13:00", end: "15:00" }, at("2026-09-28T03:00:00Z"))).toBe(true);
  });

  it("lets only tests through", () => {
    expect(breaksThrough("app-down")).toBe(false);
    expect(breaksThrough("deploy-failed")).toBe(false);
    expect(breaksThrough("card")).toBe(false);
    expect(breaksThrough("briefing")).toBe(false);
    expect(breaksThrough("test")).toBe(true);
  });

  it("never lets an FYI break through", () => {
    expect(breaksThrough("test", "fyi")).toBe(false);
    expect(breaksThrough("test", "needs-you")).toBe(true);
    for (const category of ["app-down", "deploy-failed"] as const) {
      expect(breaksThrough(category, "fyi")).toBe(false);
      expect(breaksThrough(category, "needs-you")).toBe(false);
    }
  });

  it("makes a digest FYI only when everything it holds is", () => {
    const p = (n: number, level: "fyi" | "needs-you") => ({ title: `Card ${n}`, body: "b", tag: `t${n}`, path: "/", level });
    expect(digestPayload([p(1, "fyi"), p(2, "fyi")]).level).toBe("fyi");
    expect(digestPayload([p(1, "fyi"), p(2, "needs-you")]).level).toBe("needs-you");
    expect(digestPayload([p(1, "fyi"), { ...p(2, "fyi"), level: undefined }]).level).toBe("needs-you");
    expect(digestPayload([p(1, "fyi"), p(2, "fyi")], 3).level).toBe("needs-you");
    expect(digestPayload([p(1, "fyi")]).level).toBe("fyi");
    expect(digestPayload([p(1, "fyi")], 0, 2)).toMatchObject({ level: "needs-you", body: "+2 earlier alerts not sent. b" });
  });

  it("digests several held pushes into one and passes a single one through", () => {
    const p = (n: number) => ({ title: `Card ${n}`, body: "b", tag: `t${n}`, path: "/" });
    expect(digestPayload([p(1)])).toEqual(p(1));
    const digest = digestPayload([p(1), p(2), p(3), p(4), p(5)]);
    expect(digest.title).toBe("Rivet held 5 pings while it was quiet");
    expect(digest.body).toBe("Card 1 · Card 2 · Card 3 · +2 more");
    expect(digest.tag).toBe("quiet-digest");
    expect(digestPayload([p(1)], 4).title).toBe("Rivet held 5 pings while it was quiet");
    expect(digestPayload([p(1), p(2)], 250).body).toBe("Card 1 · Card 2 · +250 more");
    expect(digestPayload([p(1), p(2)], 0, 5).body).toBe("+5 earlier alerts not sent. Card 1 · Card 2");
    expect(digestPayload([p(1)], 0, 5)).toEqual({ ...p(1), body: "+5 earlier alerts not sent. b", level: "needs-you" });
  });

  it("opens a digest with what needs you as it goes, and passes a single held push through as it was", () => {
    const p = (n: number) => ({ title: `Card ${n}`, body: "b", tag: `t${n}`, path: "/" });
    expect(digestPayload([p(1), p(2)], 0, 0, 3).body).toBe("3 need you now. Card 1 · Card 2");
    expect(digestPayload([p(1), p(2)], 0, 0, 1).body).toBe("1 needs you now. Card 1 · Card 2");
    expect(digestPayload([p(1), p(2)], 0, 0, 0).body).toBe("Nothing needs you. Card 1 · Card 2");
    expect(digestPayload([p(1), p(2)], 0, 2, 0).body).toBe("+2 earlier alerts not sent. Nothing needs you. Card 1 · Card 2");
    expect(digestPayload([p(1)], 0, 0, 3)).toEqual(p(1));
    const long = Array.from({ length: 3 }, (_, n) => ({ ...p(n), title: "x".repeat(60) }));
    expect(digestPayload(long, 0, 0, 2).body).toHaveLength(140);
  });

  describe("PushService with a QuietStore", () => {
    let dir: string;
    let store: Store;
    let gate: QuietStore;
    let clock: Date;
    let sender: FakeSender;
    let push: PushService;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "rivet-quiet-"));
      store = new Store(dir);
      gate = new QuietStore(dir);
      store.addPushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/one", keys: { p256dh: "BKey", auth: "auth" } });
      clock = at("2026-09-28T13:00:00Z"); // 00:00 local
      sender = new FakeSender();
      push = new PushService(store, null, { error: () => {} }, sender, gate, () => clock);
    });
    afterEach(() => {
      gate.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("holds every push but a test, then sends one digest", async () => {
      expect((await push.notify({ title: "Card A", body: "", tag: "a", path: "/" }, "card")).skipped).toBe("quiet");
      expect((await push.notify({ title: "Briefing", body: "", tag: "b", path: "/" }, "briefing")).skipped).toBe("quiet");
      expect((await push.notify({ title: "Notes down", body: "", tag: "d", path: "/" }, "app-down")).skipped).toBe("quiet");
      expect((await push.sendTest()).sent).toBe(1);
      expect(sender.sent).toHaveLength(1);
      expect(gate.heldCount()).toBe(3);
      expect(await push.flushHeld()).toBeNull();

      clock = at("2026-09-28T21:00:00Z"); // 08:00 local
      const before = sender.sent.length;
      expect((await push.flushHeld())?.sent).toBe(1);
      expect(sender.sent.slice(before).map((p) => p.title)).toEqual(["Rivet held 3 pings while it was quiet"]);
      expect(gate.heldCount()).toBe(0);
      expect(await push.flushHeld()).toBeNull();
    });

    it("opens the digest with the needs count its lead hook reads as it goes", async () => {
      let needs = 4;
      const stop = push.onDigestLead(() => needs);
      await push.notify({ title: "Card A", body: "", tag: "a", path: "/" }, "card");
      await push.notify({ title: "Card B", body: "", tag: "b", path: "/" }, "card");
      needs = 0;
      clock = at("2026-09-28T21:00:00Z");
      await push.flushHeld();
      expect(sender.sent.map((p) => p.body)).toEqual(["Nothing needs you. Card A · Card B"]);
      stop();
      clock = at("2026-09-28T13:00:00Z");
      await push.notify({ title: "Card C", body: "", tag: "c", path: "/" }, "card");
      await push.notify({ title: "Card D", body: "", tag: "d", path: "/" }, "card");
      clock = at("2026-09-29T21:00:00Z");
      await push.flushHeld();
      expect(sender.sent.at(-1)?.body).toBe("Card C · Card D");
    });

    it("holds an FYI sent under a breakthrough category", async () => {
      expect(gate.holds("test", clock, "fyi")).toBe(true);
      expect(gate.holds("test", clock)).toBe(false);
      expect((await push.sendTest()).sent).toBe(1);
      expect(sender.sent.map((p) => p.title)).toEqual([TEST_PAYLOAD.title]);
    });

    it("flushes the digest before the first push after quiet hours", async () => {
      await push.notify({ title: "Card A", body: "", tag: "a", path: "/" }, "card");
      clock = at("2026-09-28T22:00:00Z");
      await push.notify({ title: "Card B", body: "", tag: "b", path: "/" }, "card");
      expect(sender.sent.map((p) => p.title)).toEqual(["Card A", "Card B"]);
    });

    it("keeps the digest through a failed send and a restart, and sends it once it works", async () => {
      await push.notify({ title: "Card A", body: "", tag: "a", path: "/" }, "card");
      await push.notify({ title: "Card B", body: "", tag: "b", path: "/" }, "card");
      clock = at("2026-09-28T21:00:00Z");
      sender.answer = () => 503;
      expect((await push.flushHeld())?.sent).toBe(0);
      sender.answer = () => {
        throw new Error("network down");
      };
      clock = at("2026-09-28T21:01:00Z");
      expect((await push.flushHeld())?.sent).toBe(0);
      expect(gate.heldCount()).toBe(2);

      gate.close();
      gate = new QuietStore(dir);
      push = new PushService(store, null, { error: () => {} }, sender, gate, () => clock);
      sender.answer = () => 201;
      expect(await push.flushHeld(), "the retry wait survives the restart").toBeNull();
      clock = at("2026-09-28T21:03:00Z");
      expect((await push.flushHeld())?.sent).toBe(1);
      expect(sender.sent.map((p) => p.title)).toEqual(["Rivet held 2 pings while it was quiet"]);
      expect(gate.heldCount()).toBe(0);
    });

    it("backs a failing digest off, doubling to 30 minutes, and gives up after a day", async () => {
      const errors: string[] = [];
      push = new PushService(store, null, { error: (line: string) => errors.push(line) }, sender, gate, () => clock);
      await push.notify({ title: "Card A", body: "", tag: "a", path: "/" }, "card");
      clock = at("2026-09-28T21:00:00Z");
      sender.answer = () => 503;
      await push.flushHeld();
      expect(sender.calls).toBe(1);
      // Thirty pushes in a row while the provider is down try the digest once, not thirty times.
      for (let i = 0; i < 30; i++) await push.notify({ title: `Alert ${i}`, body: "", tag: `x${i}`, path: "/" }, "app-down");
      expect(sender.calls).toBe(31);
      expect(gate.heldCount()).toBe(1);

      const waits: number[] = [];
      let last = clock.getTime();
      for (let i = 0; i < 8; i++) {
        let step = 0;
        while ((await push.flushHeld()) === null) {
          clock = new Date(clock.getTime() + 60_000);
          step += 1;
          if (step > 40) throw new Error("digest never became due");
        }
        waits.push(Math.round((clock.getTime() - last) / 60_000));
        last = clock.getTime();
      }
      expect(waits).toEqual([1, 2, 4, 8, 16, 30, 30, 30]);
      expect(gate.heldCount()).toBe(1);

      clock = new Date(at("2026-09-28T21:00:00Z").getTime() + DIGEST_GIVE_UP_MS + DIGEST_RETRY_MAX_MS);
      await push.flushHeld();
      expect(gate.heldCount()).toBe(0);
      expect(errors.some((line) => /gave up on the quiet-hours digest/.test(line))).toBe(true);
      expect(await push.flushHeld()).toBeNull();
    });

    it("holds or sends a keyed push once, even when it is retried after a restart", async () => {
      const payload = { title: "Morning briefing", body: "", tag: "b", path: "/" };
      expect((await push.notify(payload, "briefing", "ops:briefing:x")).skipped).toBe("quiet");
      expect((await push.notify(payload, "briefing", "ops:briefing:x")).skipped).toBe("duplicate");
      expect(gate.heldCount()).toBe(1);
      clock = at("2026-09-28T21:00:00Z");
      expect((await push.notify({ ...payload, tag: "c" }, "briefing", "ops:briefing:y")).sent).toBe(1);
      gate.close();
      gate = new QuietStore(dir);
      push = new PushService(store, null, { error: () => {} }, sender, gate, () => clock);
      expect((await push.notify({ ...payload, tag: "c" }, "briefing", "ops:briefing:y")).skipped).toBe("duplicate");
    });

    it("clears an outbox entry that was held just before a restart without holding it twice", async () => {
      const ops = createOps({
        dataDir: dir,
        store,
        bridge: { status: () => ({ connected: true }) as never },
        push,
        checks: [],
        fetch: (async () => new Response("")) as typeof fetch,
        now: () => clock,
        logger: { error: () => {} },
      });
      const briefing = composeBriefing(
        { board: null, github: null, merged: [], fly: null, apps: [], mac: null, macStale: true, previous: null },
        currentSlot(clock),
        clock,
      );
      const payload = { title: "Evening briefing", body: "", tag: "b", path: "/" };
      ops.store.addBriefing(briefing, { key: `briefing:${briefing.id}`, category: "briefing", payload, expiresAt: at("2026-09-29T00:00:00Z") }, clock);
      // The pass before the restart held the push but never cleared its outbox entry.
      await push.notify(payload, "briefing", `ops:briefing:${briefing.id}`);
      await ops.deliverPushes();
      expect(gate.heldCount()).toBe(1);
      expect(ops.store.pendingPushes()).toBe(0);
      ops.close();
    });

    it("remembers at most its cap of push keys, dropping the oldest", () => {
      // A small cap: MAX_PUSH_KEYS rows are thousands of commits, too slow for a busy runner.
      const cap = 50;
      const small = new QuietStore(dir, { maxPushKeys: cap });
      const start = clock.getTime();
      for (let i = 0; i < cap + 10; i++) small.markSent(`ops:k${i}`, new Date(start + i));
      expect(small.pushKeyCount()).toBe(cap);
      expect(small.hasKey("ops:k9")).toBe(false);
      expect(small.hasKey("ops:k10")).toBe(true);
      expect(small.hasKey(`ops:k${cap + 9}`)).toBe(true);
      small.close();
    });

    it("states pruned alerts in the push, or in the digest once quiet hours hold it, until one is delivered", async () => {
      const alert = { title: "Notes App deploy failed", body: "Fly release v12 failed.", tag: "d", path: "/" };
      expect((await push.notify(alert, "deploy-failed", "ops:a", 5)).skipped).toBe("quiet");
      gate.close();
      gate = new QuietStore(dir);
      push = new PushService(store, null, { error: () => {} }, sender, gate, () => clock);
      clock = at("2026-09-28T21:00:00Z");
      sender.answer = () => 503;
      expect((await push.flushHeld())?.sent).toBe(0);
      sender.answer = () => 201;
      clock = at("2026-09-28T21:01:00Z");
      expect((await push.flushHeld())?.sent).toBe(1);
      expect(sender.sent.map((p) => p.body)).toEqual(["+5 earlier alerts not sent. Fly release v12 failed."]);
      expect((await push.notify({ ...alert, tag: "e" }, "deploy-failed", "ops:b", 2)).sent).toBe(1);
      expect(sender.sent.at(-1)?.body).toBe("+2 earlier alerts not sent. Fly release v12 failed.");
      clock = at("2026-09-29T13:00:00Z");
      await push.notify({ ...alert, tag: "f" }, "deploy-failed", "ops:c");
      clock = at("2026-09-29T21:00:00Z");
      await push.flushHeld();
      expect(sender.sent.at(-1)?.body).toBe("Fly release v12 failed.");
    });

    it("moves the pruned-alert count into the digest when quiet hours hold the alert that carried it", async () => {
      const ops = createOps({
        dataDir: dir,
        store,
        bridge: { status: () => ({ connected: true }) as never },
        push,
        checks: [],
        fetch: (async () => new Response("")) as typeof fetch,
        now: () => clock,
        logger: { error: () => {} },
      });
      const expires = new Date(clock.getTime() + 3600_000);
      for (let r = 0; r < 41; r++) ops.store.raiseAlerts(Array.from({ length: 5 }, (_, i) => deployAlert(r * 5 + i, expires)), clock, alertSummary);
      expect(ops.store.duePushes(clock).unlisted).toBe(5);
      await ops.deliverPushes();
      expect(ops.store.duePushes(clock).unlisted).toBe(0);
      expect(gate.heldCount()).toBe(MAX_QUEUED_ALERTS);
      clock = at("2026-09-28T21:00:00Z");
      await push.flushHeld();
      expect(sender.sent[0]?.body).toMatch(/^\+5 earlier alerts not sent\. App 5 deploy failed/);
      ops.close();
    });

    it("tells an alert quiet hours held once the digest is delivered, and raises it again when the digest is given up on", async () => {
      const ops = createOps({
        dataDir: dir,
        store,
        bridge: { status: () => ({ connected: true }) as never },
        push,
        checks: [],
        fetch: (async () => new Response("")) as typeof fetch,
        now: () => clock,
        logger: { error: () => {} },
      });
      const raise = (i: number) => ops.store.raiseAlerts([deployAlert(i, new Date(clock.getTime() + 3600_000))], clock, alertSummary);
      expect(raise(1)).toHaveLength(1);
      await ops.deliverPushes();
      expect(gate.heldCount()).toBe(1);
      expect(ops.store.pendingPushes()).toBe(0);
      expect(ops.store.alertCount(), "held, not yet told").toBe(0);
      expect(raise(1), "held, so not raised twice").toEqual([]);

      sender.answer = () => 503;
      clock = at("2026-09-28T21:00:00Z");
      await push.flushHeld();
      clock = new Date(clock.getTime() + DIGEST_GIVE_UP_MS + DIGEST_RETRY_MAX_MS);
      await push.flushHeld();
      expect(gate.heldCount()).toBe(0);
      expect(ops.store.alertCount()).toBe(0);
      sender.answer = () => 201;
      expect(raise(1), "the digest gave up, so it raises again").toHaveLength(1);
      await ops.deliverPushes();
      expect(sender.sent.at(-1)?.title).toBe("App 1 deploy failed");
      expect(ops.store.alertCount()).toBe(1);

      clock = at("2026-09-30T13:00:00Z");
      expect(raise(2)).toHaveLength(1);
      await ops.deliverPushes();
      expect(ops.store.alertCount()).toBe(1);
      clock = at("2026-09-30T21:00:00Z");
      await push.flushHeld();
      expect(sender.sent.at(-1)?.title).toBe("App 2 deploy failed");
      expect(ops.store.alertCount(), "the digest was delivered").toBe(2);
      expect(raise(2)).toEqual([]);
      ops.close();
    });

    it("leaves a held alert out of the digest once someone is on its break, and raises it again once nobody is", async () => {
      const checks = [1, 2].map((i) => ({ name: `app-${i}`, url: `https://app-${i}.example/health` }));
      const ops = createOps({
        dataDir: dir,
        store,
        bridge: { status: () => ({ connected: true }) as never },
        push,
        checks,
        fetch: (async () => new Response("")) as typeof fetch,
        now: () => clock,
        logger: { error: () => {} },
      });
      const raise = (i: number) => ops.store.raiseAlerts([deployAlert(i, new Date(clock.getTime() + 3600_000))], clock, alertSummary);
      const record = (i: number, state: OpsStatus["state"]) => {
        const key = opsStatusKey("app", `app-${i}`);
        const current = store.getOpsStatus("app", key);
        const next = { kind: "app" as const, key, state, since: clock.toISOString(), updatedAt: clock.toISOString(), version: store.nextOpsStatusVersion() };
        expect(current ? store.replaceOpsStatus(next, current.version) : store.addOpsStatus(next)).toBe(true);
      };
      expect(raise(1)).toHaveLength(1);
      expect(raise(2)).toHaveLength(1);
      await ops.deliverPushes();
      expect(gate.heldCount()).toBe(2);

      // App 1 is taken on before quiet hours end: the digest carries only app 2, which nobody is on.
      record(1, "in-progress");
      clock = at("2026-09-28T21:00:00Z");
      await push.flushHeld();
      expect(sender.sent.map((payload) => payload.title)).toEqual(["App 2 deploy failed"]);
      expect(gate.heldCount()).toBe(0);
      expect(ops.store.alertCount(), "app 2 told, app 1 not").toBe(1);
      expect(raise(1), "never told, so it raises again").toHaveLength(1);
      expect(raise(2)).toEqual([]);

      record(1, "backlog");
      clock = at("2026-09-28T21:01:00Z");
      await ops.deliverPushes();
      expect(sender.sent.at(-1)?.title, "nobody on it: sent, not a duplicate of the withdrawn push").toBe("App 1 deploy failed");
      expect(ops.store.alertCount()).toBe(2);
      ops.close();
    });

    it("leaves a held deploy job out of the digest once someone is on its workflow, after its run has left the snapshot", async () => {
      const checks = [1, 2].map((i) => ({ name: `app-${i}`, url: `https://app-${i}.example/health` }));
      const ops = createOps({
        dataDir: dir,
        store,
        bridge: { status: () => ({ connected: true }) as never },
        push,
        checks,
        fetch: (async () => new Response("")) as typeof fetch,
        now: () => clock,
        logger: { error: () => {} },
      });
      const run = (id: number, workflow: string, app: number): WorkflowRun => ({ ...RUN, id, workflow, updatedAt: clock.toISOString(), failedJobs: [`Deploy App ${app} to Fly`] });
      await ops.putGithub(github({ at: clock.toISOString(), runs: [run(901, "CI", 1), run(902, "Deploy", 2)] }));
      expect(gate.heldCount()).toBe(2);

      // Twenty later runs push both out of the snapshot; then someone takes on CI, and nobody Deploy.
      const later = Array.from({ length: 20 }, (_, i) => ({ ...RUN, id: 1000 + i, conclusion: "success" as const, updatedAt: clock.toISOString(), failedJobs: [] }));
      await ops.putGithub(github({ at: clock.toISOString(), runs: later }));
      const key = ciOwnedItem(run(901, "CI", 1)).key;
      expect(store.addOpsStatus({ kind: "ci", key, state: "investigating", since: clock.toISOString(), updatedAt: clock.toISOString(), version: store.nextOpsStatusVersion() })).toBe(true);
      clock = at("2026-09-28T21:00:00Z");
      await push.flushHeld();
      expect(sender.sent.map((payload) => payload.title)).toEqual(["Deploy App 2 failed"]);
      ops.close();
    });

    describe("a briefing naming a break someone took on after it was composed", () => {
      const checks = [{ name: "app-1", url: "https://app-1.example.com/health" }];
      const service = () =>
        createOps({ dataDir: dir, store, bridge: { status: () => ({ connected: true }) as never }, push, checks, fetch: (async () => new Response("")) as typeof fetch, now: () => clock, logger: { error: () => {} } });
      const record = (state: OpsStatus["state"]) => {
        const key = opsStatusKey("app", "app-1");
        const current = store.getOpsStatus("app", key);
        const next = { kind: "app" as const, key, state, since: clock.toISOString(), updatedAt: clock.toISOString(), version: store.nextOpsStatusVersion() };
        expect(current ? store.replaceOpsStatus(next, current.version) : store.addOpsStatus(next)).toBe(true);
      };
      const downNow = (ops: ReturnType<typeof service>) =>
        ops.store.put("health", { "app-1": { state: "down", status: 502, ms: 90, checkedAt: clock.toISOString(), since: clock.toISOString(), fails: 3 } }, clock);

      it("held for quiet hours, says it calmly in the digest; while nobody is on it, as composed", async () => {
        gate.putSettings({ ...DEFAULT_QUIET, end: "08:00" });
        clock = at("2026-09-27T20:31:00Z"); // 07:31 local, quiet until 08:00
        const ops = service();
        downNow(ops);
        const briefing = await ops.briefingTick();
        expect(briefing?.headline).toMatch(/(^|· )1 down/);
        expect(gate.heldCount()).toBe(1);
        record("investigating");
        clock = at("2026-09-27T21:01:00Z");
        await push.flushHeld();
        expect(sender.sent.map((payload) => payload.body)).toEqual([briefing!.headline.replace("1 down", "Agents on it: 1 down")]);
        // Reworded, it is still FYI: a quiet push.
        expect(sender.sent[0]).toMatchObject({ level: "fyi", silent: true });

        // The evening one, nobody on it: it goes as composed.
        record("backlog");
        gate.putSettings({ ...DEFAULT_QUIET, start: "17:00" });
        clock = at("2026-09-28T08:01:00Z"); // 19:01 local
        downNow(ops);
        const evening = await ops.briefingTick();
        expect(evening?.headline).toMatch(/(^|· )1 down/);
        expect(gate.heldCount()).toBe(1);
        clock = at("2026-09-28T21:01:00Z");
        await push.flushHeld();
        expect(sender.sent.at(-1)?.body).toBe(evening!.headline);
        ops.close();
      });

      it("retried after a failed send, says it calmly", async () => {
        clock = at("2026-09-27T21:01:00Z"); // 08:01 local, past quiet hours
        sender.answer = () => 500;
        const ops = service();
        downNow(ops);
        const briefing = await ops.briefingTick();
        expect(sender.sent).toEqual([]);
        expect(ops.store.pendingPushes()).toBe(1);
        record("in-progress");
        sender.answer = () => 201;
        clock = new Date(clock.getTime() + PUSH_RETRY_MS);
        await ops.deliverPushes();
        expect(sender.sent.map((payload) => payload.body)).toEqual([briefing!.headline.replace("1 down", "Agents on it: 1 down")]);
        expect(sender.sent[0]).toMatchObject({ level: "fyi", silent: true });
        ops.close();
      });
    });

    it("settles only the pushes in the digest it sent: one held while it was sending keeps waiting", async () => {
      const settled: [boolean, readonly string[]][] = [];
      push.onDigestSettled((delivered, keys) => settled.push([delivered, keys]));
      await push.notify({ title: "Card A", body: "", tag: "a", path: "/" }, "card", "k1");
      clock = at("2026-09-28T21:00:00Z");
      sender.answer = () => {
        clock = at("2026-09-28T13:30:00Z");
        void push.notify({ title: "Card B", body: "", tag: "b", path: "/" }, "card", "k2");
        return 201;
      };
      await push.flushHeld();
      expect(settled).toEqual([[true, ["k1"]]]);
      expect(gate.heldCount()).toBe(1);
      expect(gate.hasKey("k2")).toBe(true);
    });

    it("releases the key of a push pruned from the hold for room, and tells Ops it was never sent", async () => {
      const ops = createOps({
        dataDir: dir,
        store,
        bridge: { status: () => ({ connected: true }) as never },
        push,
        checks: [],
        fetch: (async () => new Response("")) as typeof fetch,
        now: () => clock,
        logger: { error: () => {} },
      });
      const raise = () => ops.store.raiseAlerts([deployAlert(1, new Date(clock.getTime() + 3600_000))], clock, alertSummary);
      expect(raise()).toHaveLength(1);
      await ops.deliverPushes();
      expect(gate.hasKey("ops:release:app-1:1")).toBe(true);
      expect(raise(), "held").toEqual([]);
      for (let i = 0; i < MAX_HELD; i++) await push.notify({ title: `Card ${i}`, body: "", tag: `t${i}`, path: "/" }, "card", `card-${i}`);
      expect(gate.hasKey("ops:release:app-1:1"), "pruned, never sent").toBe(false);
      expect(raise(), "untold, so it raises again").toHaveLength(1);
      await ops.deliverPushes();
      expect(gate.hasKey("ops:release:app-1:1"), "held again, not a duplicate").toBe(true);
      expect(ops.store.alertCount()).toBe(0);
      ops.close();
    });

    it("sends one digest when two flushes race", async () => {
      await push.notify({ title: "Card A", body: "", tag: "a", path: "/" }, "card");
      clock = at("2026-09-28T21:00:00Z");
      await Promise.all([push.flushHeld(), push.flushHeld()]);
      expect(sender.sent).toHaveLength(1);
    });

    it("counts pushes past the hold cap in the digest", async () => {
      for (let i = 0; i < MAX_HELD + 7; i++) await push.notify({ title: `Card ${i}`, body: "", tag: `t${i}`, path: "/" }, "card");
      expect(gate.heldCount()).toBe(MAX_HELD);
      clock = at("2026-09-28T21:00:00Z");
      await push.flushHeld();
      expect(sender.sent[0]?.title).toBe(`Rivet held ${MAX_HELD + 7} pings while it was quiet`);
      expect(sender.sent[0]?.body).toBe(`Card 7 · Card 8 · Card 9 · +${MAX_HELD + 4} more`);
      await push.notify({ title: "Card Z", body: "", tag: "z", path: "/" }, "card");
      expect(sender.sent.at(-1)?.title).toBe("Card Z");
    });

    it("keeps held pushes across a restart", async () => {
      await push.notify({ title: "Card A", body: "", tag: "a", path: "/" }, "card");
      gate.close();
      gate = new QuietStore(dir);
      expect(gate.heldCount()).toBe(1);
    });
  });
});

describe("schema upgrades", () => {
  // Tables as e5baf52 created them, then held_meta as 64e84d7 added it.
  const E5BAF52 = `
    CREATE TABLE push_settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
    CREATE TABLE held_pushes (id INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE ops_snapshots (kind TEXT PRIMARY KEY, json TEXT NOT NULL, received_at TEXT NOT NULL);
    CREATE TABLE briefings (id TEXT PRIMARY KEY, json TEXT NOT NULL, composed_at TEXT NOT NULL);
    CREATE TABLE ops_alerts (key TEXT PRIMARY KEY, at TEXT NOT NULL);`;
  const ROUND_1 = `
    CREATE TABLE held_meta (id INTEGER PRIMARY KEY CHECK (id = 1), dropped INTEGER NOT NULL, attempts INTEGER NOT NULL);
    INSERT INTO held_meta (id, dropped, attempts) VALUES (1, 2, 1);`;

  for (const [name, schema] of [["e5baf52", E5BAF52], ["64e84d7", E5BAF52 + ROUND_1]] as const) {
    it(`opens a database from ${name} and still holds, sends and queues pushes`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "rivet-upgrade-"));
      const db = new DatabaseSync(join(dir, "rivet.sqlite"));
      db.exec(schema);
      db.prepare("INSERT INTO held_pushes (json, at) VALUES (?, ?)").run(JSON.stringify({ title: "Card A", body: "", tag: "a", path: "/" }), "2026-09-28T13:00:00.000Z");
      db.close();
      const store = new Store(dir);
      const gate = new QuietStore(dir);
      const ops = new OpsStore(dir);
      try {
        store.addPushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/one", keys: { p256dh: "BKey", auth: "auth" } });
        let clock = at("2026-09-28T13:00:00Z");
        const sender = new FakeSender();
        const push = new PushService(store, null, { error: () => {} }, sender, gate, () => clock);
        expect((await push.notify({ title: "Card B", body: "", tag: "b", path: "/" }, "card", "ops:b", 3)).skipped).toBe("quiet");
        clock = at("2026-09-28T21:00:00Z");
        expect((await push.flushHeld())?.sent).toBe(1);
        expect(sender.sent[0]?.body).toMatch(/^\+3 earlier alerts not sent\. Card A · Card B/);
        expect(gate.heldCount()).toBe(0);
        const expires = at("2026-09-28T23:00:00Z");
        expect(ops.raiseAlerts([deployAlert(1, expires)], clock, alertSummary)).toHaveLength(1);
        expect(ops.duePushes(clock)).toMatchObject({ dropped: 0, unlisted: 0 });
        expect(ops.duePushes(clock).due).toHaveLength(1);
      } finally {
        ops.close();
        gate.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("search ranking", () => {
  const now = at("2026-09-28T02:00:00Z").getTime();
  const item = (key: string, title: string, extra: Partial<SearchItem> = {}): SearchItem => ({
    kind: "pr",
    key,
    title,
    open: { type: "tab", tab: "ops" },
    ...extra,
  });

  it("ranks exact and prefix title matches above detail matches", () => {
    const items = [
      item("c", "Billing retry queue", { detail: "notes" }),
      item("a", "Notes App"),
      item("b", "Notes App v5 idle", { kind: "timeline" }),
      item("d", "Something", { detail: "notes app mention" }),
    ];
    expect(rankSearch(items, "notes app", now).map((i) => i.key)).toEqual(["a", "b", "d"]);
  });

  it("needs every term, ignores case and accents, and dedupes by key", () => {
    const items = [item("a", "Café Menu"), item("a", "Café Menu"), item("b", "Menu Café lobby")];
    expect(rankSearch(items, "CAFE menu", now).map((i) => i.key)).toEqual(["a", "b"]);
    expect(rankSearch(items, "cafe rocket", now)).toEqual([]);
    expect(rankSearch(items, "c", now)).toEqual([]);
  });

  it("prefers cards over older items with the same match, and recent over old", () => {
    const items = [
      item("old", "Frog Notes", { kind: "timeline", at: "2026-09-01T00:00:00.000Z" }),
      item("new", "Frog Notes", { kind: "timeline", at: "2026-09-28T01:00:00.000Z" }),
      item("card", "Frog Notes", { kind: "card" }),
    ];
    expect(rankSearch(items, "frog", now).map((i) => i.key)).toEqual(["card", "new", "old"]);
    const app = item("app", "Notes App", { kind: "app" });
    const deploy = item("deploy", "Notes App v57", { kind: "timeline", at: "2026-09-28T01:30:00.000Z" });
    expect(rankSearch([deploy, app], "notes", now).map((i) => i.key)).toEqual(["app", "deploy"]);
  });
});

describe("timeline and alerts", () => {
  const now = at("2026-09-28T02:00:00Z");
  const checks: HealthCheck[] = [{ name: "notes-app", url: "https://notes-app.example.com/health" }];

  it("groups merged PRs, deploys and shipped items by local day", () => {
    const board = boardSchema.parse({ ...EXAMPLE_BOARD, shipped: [{ ...EXAMPLE_BOARD.shipped[0], shippedAt: "2026-09-28T01:00:00.000Z" }] });
    const t = buildTimeline({ now, merged: github().merged ?? [], fly: FLY, board });
    expect(t.days.map((d) => d.day)).toEqual(["2026-09-28", "2026-09-27"]);
    const today = t.days[0]!.events.map((e) => e.kind).sort();
    expect(today).toEqual(["deploy-failed", "merged", "shipped"]);
    expect(t.days[0]!.events.find((e) => e.kind === "merged")?.url).toBe("https://github.com/example-org/example-repo/pull/216");
    expect(zoneClock(at("2026-09-27T23:00:00Z")).day).toBe("2026-09-28");
    expect(t.repos).toContain("example-repo");
  });

  it("marks the Ops view stale when GitHub or the app checks stopped", () => {
    const health = { "notes-app": { state: "up" as const, status: 200, ms: 90, checkedAt: "2026-09-28T01:40:00.000Z", since: null, fails: 0 } };
    const view = buildOps({ now, bridgeConnected: true, board: null, github: github({ at: "2026-09-28T01:40:00.000Z" }), mac: null, fly: null, checks, health });
    expect(view.github?.stale).toBe(true);
    expect(view.healthStaleSince).toBe("2026-09-28T01:40:00.000Z");
    const current = buildOps({ now, bridgeConnected: true, board: null, github: github(), mac: null, fly: null, checks, health: { "notes-app": { ...health["notes-app"], checkedAt: "2026-09-28T01:59:00.000Z" } } });
    expect(current.github?.stale).toBe(false);
    expect(current.healthStaleSince).toBeNull();
  });

  it("counts failing schedules beside red CI, once: one whose newest failed run is red on main is already in red CI", () => {
    const base = { now, bridgeConnected: true, board: null, github: github(), mac: null, fly: null, checks: [], health: {} };
    expect(buildOps(base).summary).toMatchObject({ redCi: 1, failingSchedules: 0 });
    const other = "https://github.com/example-org/example-repo/actions/runs/901";
    expect(buildOps({ ...base, failingRuns: [RUN.url, other, null] }).summary).toMatchObject({ redCi: 1, failingSchedules: 2, failingSchedulesAll: 3 });
    expect(buildOps({ ...base, github: null, failingRuns: [RUN.url] }).summary).toMatchObject({ redCi: 0, failingSchedules: 1 });
  });

  it("leaves a one-off run's red out of red CI, and a schedule whose failed run it is still counts as failing", () => {
    const oneOff: WorkflowRun = { ...RUN, id: 950, workflow: "Nightly report (base)", event: "workflow_dispatch", url: "https://github.com/example-org/example-repo/actions/runs/950" };
    const green: WorkflowRun = { ...RUN, conclusion: "success" };
    const base = { now, bridgeConnected: true, board: null, mac: null, fly: null, checks: [], health: {} };
    expect(buildOps({ ...base, github: github({ runs: [green, oneOff] }) }).summary).toMatchObject({ redCi: 0 });
    expect(buildOps({ ...base, github: github({ runs: [green, oneOff] }), failingRuns: [oneOff.url] }).summary).toMatchObject({ redCi: 0, failingSchedules: 1 });
    // A real failure on main still counts, beside the one-off.
    expect(buildOps({ ...base, github: github({ runs: [RUN, oneOff] }) }).summary).toMatchObject({ redCi: 1 });
    expect(brokenOnMain([RUN, oneOff]).map((run) => run.id)).toEqual([900]);
    // A one-off run of the same workflow after an automatic failure neither hides it nor clears it; the next push run does.
    const report = { ...oneOff, event: "push", conclusion: "failure" } as const;
    const sameRed: WorkflowRun = { ...oneOff, id: 951, createdAt: "2026-09-28T01:30:00.000Z" };
    expect(brokenOnMain([report, sameRed]).map((run) => run.id)).toEqual([950]);
    expect(brokenOnMain([report, { ...sameRed, conclusion: "success" }]).map((run) => run.id)).toEqual([950]);
    expect(brokenOnMain([report, { ...report, id: 952, conclusion: "success", createdAt: "2026-09-28T01:40:00.000Z" }])).toEqual([]);
    // CI's own dispatches are main's runs: an idle feeder runs every suite of the CI workflow that way.
    const idle: WorkflowRun = { ...RUN, id: 960, event: "workflow_dispatch", createdAt: "2026-09-28T01:30:00.000Z" };
    expect(isOneOff(idle)).toBe(false);
    expect(brokenOnMain([{ ...RUN, conclusion: "success" }, idle]).map((run) => run.id)).toEqual([960]);
    // Its green skips the push-only secret scan: it clears a dispatch's red, never a push's.
    const idleGreen: WorkflowRun = { ...idle, id: 961, conclusion: "success", createdAt: "2026-09-28T01:40:00.000Z" };
    expect(brokenOnMain([RUN, idleGreen]).map((run) => run.id)).toEqual([900]);
    expect(brokenOnMain([{ ...RUN, conclusion: "success" }, idle, idleGreen])).toEqual([]);
    expect(brokenOnMain([RUN, idle, idleGreen, { ...RUN, id: 962, conclusion: "success", createdAt: "2026-09-28T01:50:00.000Z" }])).toEqual([]);
    // The nightly schedule skips it too: its green never clears a push's red, nor stands in for a push.
    const nightly: WorkflowRun = { ...RUN, id: 963, event: "schedule", conclusion: "success", createdAt: "2026-09-28T01:35:00.000Z" };
    expect(brokenOnMain([RUN, nightly]).map((run) => run.id)).toEqual([900]);
    expect(brokenOnMain([RUN, nightly, idleGreen]).map((run) => run.id)).toEqual([900]);
    expect(brokenOnMain([{ ...nightly, conclusion: "failure" }]).map((run) => run.id)).toEqual([963]);
  });

  it("counts a PR's red only once its head is over an hour old, and a head of unknown age at once", () => {
    const at = Date.parse("2026-09-28T02:00:00.000Z");
    const pr = (state: "fail" | "pass" | "pending", ago: number | null) => ({ headAt: ago === null ? null : new Date(at - ago).toISOString(), checks: { state, passed: 0, failed: 0, pending: 0, failing: [] } });
    expect(longRed(pr("fail", PR_RED_GRACE_MS - 1), at)).toBe(false);
    expect(longRed(pr("fail", PR_RED_GRACE_MS), at)).toBe(true);
    expect(longRed(pr("fail", 3 * PR_RED_GRACE_MS), at)).toBe(true);
    expect(longRed(pr("fail", null), at)).toBe(true);
    // A head dated ahead of the clock counts at once, beyond a few minutes' skew: a commit date is the author's to set.
    expect(longRed(pr("fail", -60_000), at)).toBe(false);
    expect(longRed(pr("fail", -24 * PR_RED_GRACE_MS), at)).toBe(true);
    expect(longRed(pr("pending", 3 * PR_RED_GRACE_MS), at)).toBe(false);
    expect(longRed(pr("pass", 3 * PR_RED_GRACE_MS), at)).toBe(false);
  });

  it("accepts the bridge's own Claude usage rows, weekly and scoped labels included", () => {
    const limits = parseUsage({
      limits: [
        { kind: "session", percent: 85, severity: "warning", resets_at: "2026-09-28T04:30:00+00:00", is_active: true },
        { kind: "weekly_all", percent: 43, severity: "normal", resets_at: "2026-10-03T17:00:00+00:00" },
        { kind: "weekly_scoped", percent: 22, severity: "normal", resets_at: null, scope: { model: { display_name: "Opus" } } },
      ],
    });
    const parsed = claudeUsageSnapshotSchema.safeParse({ at: "2026-09-28T02:00:00.000Z", limits });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.limits.map((limit) => limit.label)).toEqual(["Session (5 hr)", "Week (all models)", "Week (Opus)"]);
    expect(claudeUsageSnapshotSchema.safeParse({ at: "2026-09-28T02:00:00.000Z", limits: [{ ...limits[0], label: "a\nb" }] }).success).toBe(false);
  });

  it("accepts the bridge's Codex credit fields, and rejects a negative figure", () => {
    const limits = [
      { kind: "session", label: "Session (5 hr)", percent: 40, severity: "normal" as const, resetsAt: null, active: true },
      { kind: "codex_1_week", label: "sa***, week", percent: 93, severity: "warning" as const, resetsAt: null, active: false, credits: 61_467, unlimited: false },
    ];
    const at = "2026-09-28T02:00:00.000Z";
    expect(claudeUsageSnapshotSchema.safeParse({ at, limits }).success).toBe(true);
    expect(claudeUsageSnapshotSchema.safeParse({ at, limits: [{ ...limits[1], credits: -1 }] }).success).toBe(false);
  });

  it("marks Claude usage stale ten minutes after the last reading", () => {
    const limits = [{ kind: "session", label: "Session (5 hours)", percent: 40, severity: "normal" as const, resetsAt: null, active: true }];
    const base = { now, bridgeConnected: true, board: null, github: null, mac: null, fly: null, checks: [], health: {} };
    expect(buildOps({ ...base, claude: { at: "2026-09-28T01:51:00.000Z", limits } }).claude?.stale).toBe(false);
    expect(buildOps({ ...base, claude: { at: "2026-09-28T01:49:00.000Z", limits } }).claude?.stale).toBe(true);
    expect(buildOps(base).claude).toBeNull();
  });

  it("counts every app that is down, and says one that gave no answer", () => {
    const down = { state: "down" as const, status: null, ms: null, checkedAt: "2026-09-28T01:59:00.000Z", since: "2026-09-28T01:50:00.000Z", fails: 9 };
    const both = [...checks, { name: "tasks-app", url: "https://tasks-app.example.com/ready" }];
    const appDown = buildOps({ now, bridgeConnected: true, board: null, github: github(), mac: null, fly: FLY, checks: both, health: { "tasks-app": down, "notes-app": down } });
    expect(appDown.summary.appsDown).toBe(2);
    const appItem = (apps: typeof appDown.apps) => composeBriefing(inputs({ apps }), currentSlot(now), now).items.find((item) => item.key === "apps")!;
    expect(appItem(appDown.apps).title).toBe("2 apps down");
    const onlyTasks = appDown.apps.filter((g) => g.name !== "notes-app");
    expect(appItem(onlyTasks).title).toBe("1 app down");
    expect(appItem(onlyTasks).lines).toEqual(["tasks-app (no answer)"]);
  });

  it("links a shipped item only when it has a PR", () => {
    const board = boardSchema.parse({ ...EXAMPLE_BOARD, shipped: [{ title: "Menu tidy", shippedAt: "2026-09-27T01:00:00.000Z" }] });
    const event = buildTimeline({ now, merged: [], fly: null, board }).days[0]!.events[0]!;
    expect(event).toEqual({ kind: "shipped", at: "2026-09-27T01:00:00.000Z", repo: "example-repo", title: "Menu tidy" });
  });

  it("dates shipped rows by shippedAt; one without it, outside the window or already a merged row is left out", () => {
    const merged = github().merged ?? [];
    const board = boardSchema.parse({
      ...EXAMPLE_BOARD,
      shipped: [
        { pr: 2122, title: "Old, before the stamps" },
        { pr: 2123, title: "Day not known", shippedAt: null },
        { pr: 2244, title: "Weeks old", shippedAt: "2026-09-01T01:00:00.000Z" },
        { pr: merged[0]!.number, title: "Merged already", shippedAt: "2026-09-28T01:00:00.000Z" },
        { pr: 2300, title: "Yesterday's", shippedAt: "2026-09-26T22:00:00.000Z" },
      ],
    });
    const shipped = buildTimeline({ now, merged, fly: null, board }).days.flatMap((d) => d.events.filter((e) => e.kind === "shipped").map((e) => `${d.day} ${e.title}`));
    expect(shipped).toEqual(["2026-09-27 Yesterday's"]);
  });

  it("raises a failed prod deploy once from Fly and from the deploy job", () => {
    const alerts = deployAlerts({ now, fly: FLY, github: github() });
    expect(alerts.map((a) => a.category)).toEqual(["deploy-failed", "deploy-failed"]);
    expect(deployAlerts({ now: at("2026-09-28T09:00:00Z"), fly: FLY, github: github() })).toEqual([]);
    const rerun = deployAlerts({ now, fly: null, github: github({ runs: [{ ...RUN, attempt: 2 }] }) });
    expect(rerun[0]?.key).not.toBe(alerts[1]?.key);
  });

  it("never alerts on a dev channel's deploy or going down, and still does on a -demo app", () => {
    const jobs = ["Deploy Notes App (dev) to Fly", "Deploy notes-app-dev to Fly", "Deploy Devtools to Fly"];
    expect(deployAlerts({ now, fly: null, github: github({ runs: [{ ...RUN, failedJobs: jobs }] }) }).map((alert) => alert.payload.title)).toEqual([
      "Deploy Devtools failed",
    ]);
    const down = { state: "down" as const, status: 502, ms: 90, checkedAt: "2026-09-28T01:50:00.000Z", since: "2026-09-28T01:40:00.000Z", fails: 3 };
    const apps = ["notes-app-dev", "tasks-dev", "notes-app-demo"].map((name) => ({ name, url: "https://x.example.com/health" }));
    const view = buildOps({ now, bridgeConnected: true, board: null, github: null, mac: null, fly: null, checks: apps, health: Object.fromEntries(apps.map((app) => [app.name, down])) });
    expect(downAlerts(view.apps).map((alert) => alert.key)).toEqual(["down:notes-app-demo:2026-09-28T01:40:00.000Z"]);
  });

  it("counts a Fly release as a deploy, and alerts on one, only when its image changed", () => {
    const image = "registry.example.com/notes-app:direct-aaaaaaaaaaaa-1";
    const releases = (latest: string | undefined, status = "failed") => ({
      ...FLY,
      apps: [
        {
          ...FLY.apps[0]!,
          releases: [
            { version: 13, status, at: "2026-09-28T01:40:00.000Z", ...(latest ? { image: latest } : {}) },
            { version: 12, status: "failed", at: "2026-09-28T01:30:00.000Z", image: "registry.example.com/notes-app:direct-bbbbbbbbbbbb-2" },
            { version: 11, status: "complete", at: "2026-09-27T01:00:00.000Z", image },
          ],
        },
      ],
    });
    expect(flySnapshotSchema.safeParse(releases(image)).success).toBe(true);
    const flyAlerts = (fly: FlySnapshot) => deployAlerts({ now, fly, github: null }).map((alert) => alert.key);
    // v13 failed on the image v11 runs: a secrets change, not a deploy. v12 tried a new one.
    expect(flyAlerts(releases(image))).toEqual(["release:notes-app:12"]);
    expect(flyAlerts(releases(undefined))).toEqual(["release:notes-app:13", "release:notes-app:12"]);
    const deploys = (fly: FlySnapshot) =>
      buildTimeline({ now, merged: [], fly, board: null }).days.flatMap((day) => day.events.map((event) => event.title));
    expect(deploys(releases(image, "complete"))).toEqual(["notes-app v12"]);
    expect(deploys(releases("registry.example.com/notes-app:direct-cccccccccccc-3", "complete"))).toEqual(["notes-app v13", "notes-app v12"]);

    // The last complete release before it, whatever order the snapshot lists them in.
    const a = "registry.example.com/notes-app:direct-aaaaaaaaaaaa-1";
    const b = "registry.example.com/notes-app:direct-bbbbbbbbbbbb-2";
    const shuffled = [
      { version: 1, status: "complete", at: "2026-09-27T01:00:00.000Z", image: a },
      { version: 2, status: "complete", at: "2026-09-27T02:00:00.000Z", image: b },
      { version: 3, status: "failed", at: "2026-09-28T01:40:00.000Z", image: a },
    ];
    expect(newImage(shuffled, shuffled[2]!)).toBe(true);
    // Nothing to compare with: neither an alert nor the timeline guesses it was a deploy.
    const alone = { version: 3, status: "failed", at: "2026-09-28T01:40:00.000Z", image: a };
    expect(newImage([alone], alone)).toBe(false);
    expect(flyAlerts({ ...FLY, apps: [{ ...FLY.apps[0]!, releases: [alone] }] })).toEqual([]);
    expect(deploys({ ...FLY, apps: [{ ...FLY.apps[0]!, releases: [{ ...alone, status: "complete" }] }] })).toEqual([]);
  });
});

describe("ops service", () => {
  let dir: string;
  let store: Store;
  let clock: Date;
  const pushed: { title: string; category: string }[] = [];
  let answer: () => Promise<PushReport>;

  const NOTES = "notes-app";

  function service(checks: HealthCheck[] = []) {
    return createOps({
      dataDir: dir,
      store,
      bridge: { status: () => ({ connected: true }) as never },
      push: {
        notify: async (payload, category) => {
          const report = await answer();
          if (report.sent || report.skipped === "quiet") pushed.push({ title: payload.title, category });
          return report;
        },
        flushHeld: async () => null,
        onDigestSettled: () => () => {}, onDigestRelease: () => () => {},
        onDigestReword: () => () => {},
      },
      checks,
      fetch: (async () => new Response("")) as typeof fetch,
      now: () => clock,
      logger: { error: () => {} },
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rivet-ops-"));
    store = new Store(dir);
    pushed.length = 0;
    answer = async () => ({ sent: 1, removed: 0 });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stamps a snapshot dated ahead of the server with its arrival, so a fast Mac clock cannot keep it fresh", async () => {
    clock = new Date("2026-10-01T01:00:00Z");
    const ops = service([]);
    const ahead = new Date("2026-10-01T01:20:00Z").toISOString();
    ops.putMac(mac(0.4, { at: ahead }));
    await ops.putGithub(github({ at: ahead, sources: OK_SOURCES }));
    expect(ops.view().mac).toMatchObject({ at: clock.toISOString(), stale: false });
    expect(ops.view().github).toMatchObject({ at: clock.toISOString(), stale: false });
    // Collection stops: twenty minutes on, both are stale, not fresh until the Mac's clock catches up.
    clock = new Date("2026-10-01T01:20:00Z");
    expect(ops.view().mac?.stale).toBe(true);
    expect(ops.view().github?.stale).toBe(true);
    // A clock behind keeps its own, older time.
    const behind = new Date("2026-10-01T01:19:00Z").toISOString();
    ops.putMac(mac(0.4, { at: behind }));
    expect(ops.view().mac?.at).toBe(behind);
    ops.close();
  });

  it("composes one briefing per slot, survives a restart, and pushes only when on time", async () => {
    clock = at("2026-09-27T20:31:00Z");
    let ops = service();
    const first = await ops.briefingTick();
    expect(first?.id).toBe("2026-09-28-morning");
    expect(await ops.briefingTick()).toBeNull();
    ops.close();

    ops = service();
    clock = at("2026-09-27T23:00:00Z");
    expect(await ops.briefingTick()).toBeNull();
    expect(pushed).toEqual([{ title: "Morning briefing", category: "briefing" }]);

    // The evening slot composed four hours late is stored, not pushed.
    clock = at("2026-09-28T11:00:00Z");
    const late = await ops.briefingTick();
    expect(late?.id).toBe("2026-09-28-evening");
    expect(late?.since).toBe(first?.composedAt);
    expect(pushed).toHaveLength(1);
    ops.close();
  });

  it("attaches notes to the latest briefing and keeps the last five", async () => {
    clock = at("2026-09-27T20:31:00Z");
    const ops = service();
    expect(ops.addNote("too early")).toBeNull();
    await ops.briefingTick();
    for (let i = 1; i <= 6; i++) ops.addNote(`note ${i}`);
    expect(ops.latestBriefing()?.notes.map((n) => n.text)).toEqual(["note 2", "note 3", "note 4", "note 5", "note 6"]);
    ops.close();
  });

  it("retries a briefing push that failed, across a restart, until it is delivered", async () => {
    clock = at("2026-09-27T20:31:00Z");
    answer = async () => ({ sent: 0, removed: 0 });
    let ops = service();
    expect((await ops.briefingTick())?.id).toBe("2026-09-28-morning");
    expect(pushed).toEqual([]);
    expect(ops.store.pendingPushes()).toBe(1);
    ops.close();

    ops = service();
    answer = async () => {
      throw new Error("push service down");
    };
    clock = new Date(clock.getTime() + PUSH_RETRY_MS);
    await ops.deliverPushes();
    expect(ops.store.pendingPushes()).toBe(1);

    answer = async () => ({ sent: 1, removed: 0 });
    await ops.deliverPushes();
    expect(pushed, "a retry waits its turn").toEqual([]);
    clock = new Date(clock.getTime() + PUSH_RETRY_MS);
    await ops.deliverPushes();
    expect(pushed).toEqual([{ title: "Morning briefing", category: "briefing" }]);
    expect(ops.store.pendingPushes()).toBe(0);
    ops.close();
  });

  it("sends a briefing stored before a restart that came before its push", async () => {
    clock = at("2026-09-27T20:31:00Z");
    let ops = service();
    const briefing = composeBriefing(
      { board: null, github: null, merged: [], fly: null, apps: [], mac: null, macStale: true, previous: null },
      currentSlot(clock),
      clock,
    );
    ops.store.addBriefing(briefing, { key: `briefing:${briefing.id}`, category: "briefing", payload: { title: "Morning briefing", body: "", tag: "b", path: "/" }, expiresAt: at("2026-09-28T00:30:00Z") }, clock);
    ops.close();

    ops = service();
    expect(await ops.briefingTick()).toBeNull();
    await ops.deliverPushes();
    expect(pushed).toEqual([{ title: "Morning briefing", category: "briefing" }]);
    ops.close();
  });

  it("drops a briefing push once its slot is stale or it ran out of tries", async () => {
    clock = at("2026-09-27T20:31:00Z");
    answer = async () => ({ sent: 0, removed: 0, skipped: "no-subscriptions" });
    const ops = service();
    await ops.briefingTick();
    for (let i = 1; i < MAX_PUSH_ATTEMPTS; i++) {
      clock = new Date(clock.getTime() + PUSH_RETRY_MS);
      await ops.deliverPushes();
    }
    expect(ops.store.pendingPushes()).toBe(1);
    clock = new Date(clock.getTime() + PUSH_RETRY_MS);
    await ops.deliverPushes();
    expect(ops.store.pendingPushes()).toBe(0);
    ops.close();
  });

  it("retries a failed alert push and still raises each alert once", async () => {
    clock = at("2026-09-28T02:00:00Z");
    answer = async () => ({ sent: 0, removed: 0 });
    const ops = service();
    await ops.putFly(FLY);
    expect(pushed).toEqual([]);
    answer = async () => ({ sent: 0, removed: 0, skipped: "quiet" });
    clock = new Date(clock.getTime() + PUSH_RETRY_MS);
    await ops.putFly(FLY);
    expect(pushed.filter((p) => p.category === "deploy-failed")).toHaveLength(1);
    clock = new Date(clock.getTime() + PUSH_RETRY_MS);
    await ops.putFly(FLY);
    expect(pushed).toHaveLength(1);
    ops.close();
  });

  // The briefing and push alerts use the app's ownership test, so a break an agent is on wakes nobody.
  const record = (kind: OpsStatus["kind"], key: string, state: OpsStatus["state"]) => {
    const current = store.getOpsStatus(kind, key);
    const next = { kind, key, state, since: "2026-09-28T01:00:00.000Z", updatedAt: clock.toISOString(), version: store.nextOpsStatusVersion() };
    expect(current ? store.replaceOpsStatus(next, current.version) : store.addOpsStatus(next)).toBe(true);
  };

  it("sends no failed-deploy push for an app someone is on, and still sends the red workflow's deploy job nobody is on", async () => {
    clock = at("2026-09-28T02:00:00Z");
    record("app", opsStatusKey("app", NOTES), "in-progress");
    const ops = service();
    await ops.putFly(FLY);
    expect(pushed).toEqual([]);
    await ops.putGithub(github());
    expect(pushed).toEqual([{ title: "Deploy Notes App failed", category: "deploy-failed" }]);
    ops.close();

    // A deploy job is the red workflow's: a record on it owns the job.
    pushed.length = 0;
    record("ci", ciOwnedItem(RUN).key, "investigating");
    const again = service();
    await again.putGithub(github({ runs: [{ ...RUN, attempt: 2 }] }));
    expect(pushed).toEqual([]);
    again.close();
  });

  it("drops a queued alert whose break someone took on before its retry, and raises it again once nobody is on it", async () => {
    clock = at("2026-09-28T02:00:00Z");
    answer = async () => ({ sent: 0, removed: 0 });
    const ops = service();
    await ops.putFly(FLY);
    await ops.putGithub(github());
    expect(ops.store.pendingPushes()).toBeGreaterThan(0);
    record("app", opsStatusKey("app", NOTES), "in-progress");
    record("ci", ciOwnedItem(RUN).key, "investigating");
    answer = async () => ({ sent: 1, removed: 0 });
    clock = new Date(clock.getTime() + PUSH_RETRY_MS);
    await ops.deliverPushes();
    expect(pushed).toEqual([]);
    expect(ops.store.pendingPushes()).toBe(0);
    record("app", opsStatusKey("app", NOTES), "backlog");
    await ops.putFly(FLY);
    expect(pushed).toEqual([{ title: "notes-app deploy failed", category: "deploy-failed" }]);
    ops.close();
  });

  it("drops a queued deploy job's retry once someone is on its workflow, after its run has left the snapshot, and sends the rest", async () => {
    clock = at("2026-09-28T02:00:00Z");
    answer = async () => ({ sent: 0, removed: 0 });
    const ops = service();
    await ops.putGithub(github({ runs: [RUN, { ...RUN, id: 901, workflow: "Deploy", failedJobs: ["Deploy Tasks App to Fly"] }] }));
    expect(ops.store.pendingPushes()).toBe(2);
    await ops.putGithub(github({ runs: Array.from({ length: 20 }, (_, i) => ({ ...RUN, id: 1000 + i, conclusion: "success" as const, failedJobs: [] })) }));
    record("ci", ciOwnedItem(RUN).key, "investigating");
    answer = async () => ({ sent: 1, removed: 0 });
    clock = new Date(clock.getTime() + PUSH_RETRY_MS);
    await ops.deliverPushes();
    expect(pushed).toEqual([{ title: "Deploy Tasks App failed", category: "deploy-failed" }]);
    expect(ops.store.pendingPushes()).toBe(0);
    ops.close();

    // One queued before owners were kept takes its workflow at the next start, while the snapshot still has its run.
    pushed.length = 0;
    answer = async () => ({ sent: 0, removed: 0 });
    const legacy = service();
    await legacy.putGithub(github({ runs: [{ ...RUN, id: 950 }] }));
    const old = { key: "deployjob:950:1:Notes App", category: "deploy-failed" as const, payload: { title: "Deploy Notes App failed", body: "", tag: "d", path: "/" }, expiresAt: new Date(clock.getTime() + 3600_000) };
    expect(legacy.store.raiseAlerts([old], clock, alertSummary)).toEqual([old.key]);
    legacy.close();
    const restarted = service();
    await restarted.putGithub(github({ runs: Array.from({ length: 20 }, (_, i) => ({ ...RUN, id: 2000 + i, conclusion: "success" as const, failedJobs: [] })) }));
    answer = async () => ({ sent: 1, removed: 0 });
    clock = new Date(clock.getTime() + PUSH_RETRY_MS);
    await restarted.deliverPushes();
    expect(pushed, "its workflow is still investigating").toEqual([]);
    expect(restarted.store.pendingPushes()).toBe(0);
    restarted.close();
  });

  it("sends no down push for an app someone is on; once its record says backlog, the spell alerts", async () => {
    clock = at("2026-09-28T02:00:00Z");
    const probed = [{ name: NOTES, url: "https://notes.example/health" }];
    record("app", opsStatusKey("app", NOTES), "investigating");
    const ops = createOps({
      dataDir: dir,
      store,
      bridge: { status: () => ({ connected: true }) as never },
      push: { notify: async (payload, category) => (pushed.push({ title: payload.title, category }), { sent: 1, removed: 0 }), flushHeld: async () => null, onDigestSettled: () => () => {}, onDigestRelease: () => () => {}, onDigestReword: () => () => {} },
      checks: probed,
      fetch: (async () => new Response("", { status: 502 })) as typeof fetch,
      now: () => clock,
      logger: { error: () => {} },
    });
    for (let i = 0; i < 5; i += 1) await ops.probeTick();
    expect(ops.view().apps[0]?.health.state).toBe("down");
    expect(pushed).toEqual([]);
    record("app", opsStatusKey("app", NOTES), "backlog");
    await ops.probeTick();
    expect(pushed).toEqual([{ title: "notes-app is down", category: "app-down" }]);
    ops.close();
  });

  it("briefs a red workflow and a failed deploy someone is on as agents on it, not red", async () => {
    clock = at("2026-09-28T08:01:00Z");
    record("ci", ciOwnedItem(RUN).key, "in-progress");
    record("app", opsStatusKey("app", NOTES), "in-progress");
    const ops = service();
    await ops.putFly({ ...FLY, at: clock.toISOString() });
    await ops.putGithub(github({ at: clock.toISOString() }));
    pushed.length = 0;
    const briefing = (await ops.briefingTick())!;
    const failures = briefing.items.find((item) => item.key === "failures")!;
    expect(failures.tone).toBe("info");
    expect(failures.title).toBe("Agents on it: 1 red workflow on main, 2 failed deploys");
    expect(briefing.headline).toContain("Agents on it: 1 red, 2 failed deploys");
    expect(briefing.headline).not.toMatch(/(^|· )\d+ (red|failed deploys?)\b/);
    ops.close();
  });

  const alert = (i: number, expiresAt: Date): QueuedPush => ({
    key: `release:app-${i}:1`,
    category: "deploy-failed",
    payload: { title: `App ${i} deploy failed`, body: "Fly release v1 failed.", tag: `deploy-${i}`, path: "/" },
    expiresAt,
  });

  it("drops a dev-channel alert an older server queued instead of sending it", async () => {
    clock = at("2026-09-28T02:00:00Z");
    answer = async () => ({ sent: 1, removed: 0 });
    const ops = service();
    const expiresAt = new Date(clock.getTime() + 3600_000);
    const payload = { title: "x", body: "", tag: "x", path: "/" };
    const queued = [
      "down:notes-dev:2026-09-28T01:50:00.000Z",
      "down:tasks-dev:2026-09-28T01:50:00.000Z",
      "release:files-dev:4",
      "deployjob:9:1:Tasks App (dev)",
      "release:notes-app:13",
    ].map((key) => ({ key, category: key.startsWith("down") ? ("app-down" as const) : ("deploy-failed" as const), payload: { ...payload, title: key }, expiresAt }));
    ops.store.raiseAlerts(queued, clock, alertSummary);
    await ops.deliverPushes();
    expect(pushed.map((p) => p.title)).toEqual(["release:notes-app:13"]);
    expect(ops.store.pendingPushes()).toBe(0);
    ops.close();
  });

  it("caps the alert record", () => {
    clock = at("2026-09-28T02:00:00Z");
    // A small cap: MAX_ALERTS rows are thousands of commits, too slow for a busy runner.
    const cap = 40;
    const store = new OpsStore(dir, { maxAlerts: cap });
    for (let i = 0; i < cap + 25; i++) {
      const sent = new Date(clock.getTime() + i);
      store.raiseAlerts([alert(i, sent)], sent, alertSummary);
      store.pushDelivered(alert(i, sent).key, sent);
    }
    expect(store.alertCount()).toBe(cap);
    expect(store.raiseAlerts([alert(cap + 24, clock)], clock, alertSummary)).toEqual([]);
    store.close();
  });

  it("records an alert as told only once its push is delivered, and raises it again when the outbox gives up", () => {
    clock = at("2026-09-28T02:00:00Z");
    const store = new OpsStore(dir);
    const expires = new Date(clock.getTime() + 3600_000);
    expect(store.raiseAlerts([alert(1, expires)], clock, alertSummary)).toEqual([alert(1, expires).key]);
    expect(store.raiseAlerts([alert(1, expires)], clock, alertSummary), "waiting in the outbox").toEqual([]);
    expect(store.alertCount()).toBe(0);
    for (let n = 0; n < MAX_PUSH_ATTEMPTS; n++) store.pushFailed(alert(1, expires).key, clock);
    expect(store.duePushes(clock).dropped).toBe(1);
    expect(store.raiseAlerts([alert(1, expires)], clock, alertSummary), "given up, so raised again").toEqual([alert(1, expires).key]);
    store.pushDelivered(alert(1, expires).key, clock);
    expect(store.alertCount()).toBe(1);
    expect(store.raiseAlerts([alert(1, expires)], clock, alertSummary)).toEqual([]);

    // Every alert a summary push carries is told with it.
    const many = Array.from({ length: ALERT_BATCH + 1 }, (_, i) => alert(10 + i, expires));
    expect(store.raiseAlerts(many, clock, alertSummary)).toHaveLength(ALERT_BATCH + 1);
    store.pushDelivered(alertSummary(many).key, clock);
    expect(store.alertCount()).toBe(ALERT_BATCH + 2);
    expect(store.raiseAlerts(many, clock, alertSummary)).toEqual([]);
    store.close();
  });

  it("leaves an alert pruned for room untold, so it raises again while it holds", () => {
    clock = at("2026-09-28T02:00:00Z");
    const store = new OpsStore(dir);
    const expires = new Date(clock.getTime() + 3600_000);
    for (let i = 0; i <= MAX_QUEUED_ALERTS; i++) store.raiseAlerts([alert(i, expires)], clock, alertSummary);
    expect(store.pendingPushes()).toBe(MAX_QUEUED_ALERTS);
    expect(store.alertCount()).toBe(0);
    expect(store.raiseAlerts([alert(0, expires)], clock, alertSummary)).toEqual([alert(0, expires).key]);
    expect(store.raiseAlerts([alert(2, expires)], clock, alertSummary), "still queued").toEqual([]);
    store.close();
  });

  it("puts an alert an older server recorded as told while its push was still queued back to waiting on that push", () => {
    clock = at("2026-09-28T02:00:00Z");
    const db = new DatabaseSync(join(dir, "rivet.sqlite"));
    db.exec(`
      CREATE TABLE ops_alerts (key TEXT PRIMARY KEY, at TEXT NOT NULL);
      CREATE TABLE ops_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, category TEXT NOT NULL, json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, retry_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE ops_outbox_meta (id INTEGER PRIMARY KEY CHECK (id = 1), dropped INTEGER NOT NULL);
      INSERT INTO ops_outbox_meta (id, dropped) VALUES (1, 0);`);
    const expires = new Date(clock.getTime() + 3600_000);
    const queued = alert(1, expires);
    db.prepare("INSERT INTO ops_alerts (key, at) VALUES (?, ?), (?, ?)").run(queued.key, clock.toISOString(), alert(2, expires).key, clock.toISOString());
    db.prepare("INSERT INTO ops_outbox (key, category, json, retry_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(
      queued.key, queued.category, JSON.stringify(queued.payload), clock.toISOString(), expires.toISOString());
    db.close();
    const store = new OpsStore(dir);
    expect(store.alertCount(), "the delivered one stays told").toBe(1);
    expect(store.raiseAlerts([queued], clock, alertSummary), "waiting in the outbox").toEqual([]);
    for (let n = 0; n < MAX_PUSH_ATTEMPTS; n++) store.pushFailed(queued.key, clock);
    expect(store.duePushes(clock).dropped).toBe(1);
    expect(store.raiseAlerts([queued, alert(2, expires)], clock, alertSummary), "given up, so raised again").toEqual([queued.key]);
    store.close();
    // Every boot runs it again, and a told alert with nothing queued is left alone.
    const again = new OpsStore(dir);
    expect(again.alertCount()).toBe(1);
    expect(again.pendingPushes()).toBe(1);
    again.close();
  });

  it("puts the alerts of an older server's queued summary back to waiting on it: those of its first key's raise and kind", () => {
    clock = at("2026-09-28T02:00:00Z");
    const db = new DatabaseSync(join(dir, "rivet.sqlite"));
    db.exec(`
      CREATE TABLE ops_alerts (key TEXT PRIMARY KEY, at TEXT NOT NULL);
      CREATE TABLE ops_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, category TEXT NOT NULL, json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, retry_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE ops_outbox_meta (id INTEGER PRIMARY KEY CHECK (id = 1), dropped INTEGER NOT NULL);
      INSERT INTO ops_outbox_meta (id, dropped) VALUES (1, 0);`);
    const expires = new Date(clock.getTime() + 3600_000);
    const many = Array.from({ length: ALERT_BATCH + 1 }, (_, i) => alert(i, expires));
    const summary = alertSummary(many);
    const told = db.prepare("INSERT INTO ops_alerts (key, at) VALUES (?, ?)");
    for (const one of many) told.run(one.key, clock.toISOString());
    // Told before, in another raise; and one of another kind in the same raise.
    told.run(alert(50, expires).key, new Date(clock.getTime() - 60_000).toISOString());
    told.run("down:notes-app:2026-09-28T01:00:00.000Z", clock.toISOString());
    db.prepare("INSERT INTO ops_outbox (key, category, json, retry_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(
      summary.key, summary.category, JSON.stringify(summary.payload), clock.toISOString(), expires.toISOString());
    db.close();
    const store = new OpsStore(dir);
    expect(store.alertCount()).toBe(2);
    expect(store.raiseAlerts(many, clock, alertSummary), "waiting on the summary").toEqual([]);
    for (let n = 0; n < MAX_PUSH_ATTEMPTS; n++) store.pushFailed(summary.key, clock);
    expect(store.duePushes(clock).dropped).toBe(1);
    expect(store.raiseAlerts([...many, alert(50, expires)], clock, alertSummary), "given up, so raised again").toEqual(many.map((one) => one.key));
    store.close();
  });

  it("sends many new alerts from one snapshot as one summary push", async () => {
    clock = at("2026-09-28T02:00:00Z");
    const ops = service();
    const expires = new Date(clock.getTime() + 3600_000);
    expect(ops.store.raiseAlerts(Array.from({ length: 12 }, (_, i) => alert(i, expires)), clock, alertSummary)).toHaveLength(12);
    expect(ops.store.pendingPushes()).toBe(1);
    ops.store.raiseAlerts(Array.from({ length: ALERT_BATCH }, (_, i) => alert(100 + i, expires)), clock, alertSummary);
    expect(ops.store.pendingPushes()).toBe(1 + ALERT_BATCH);
    await ops.deliverPushes();
    expect(pushed[0]).toEqual({ title: "12 deploys failed", category: "deploy-failed" });
    expect(pushed).toHaveLength(1 + ALERT_BATCH);
    expect(alertSummary(Array.from({ length: 12 }, (_, i) => alert(i, expires))).payload.body).toBe("App 0, App 1, App 2 +9");
    ops.close();
  });

  it("never drops a queued briefing for room, and counts dropped alerts in the next push", async () => {
    clock = at("2026-09-27T20:31:00Z");
    answer = async () => ({ sent: 0, removed: 0 });
    const ops = service();
    await ops.briefingTick();
    const expires = new Date(clock.getTime() + 3600_000);
    for (let r = 0; r < 50; r++)
      ops.store.raiseAlerts(Array.from({ length: 5 }, (_, i) => alert(r * 5 + i, expires)), clock, alertSummary);
    expect(ops.store.pendingPushes()).toBe(1 + MAX_QUEUED_ALERTS);
    const unsent: number[] = [];
    answer = async () => ({ sent: 1, removed: 0 });
    const spy = createOps({
      dataDir: dir,
      store,
      bridge: { status: () => ({ connected: true }) as never },
      push: {
        notify: async (_payload, _category, _key, count = 0) => {
          unsent.push(count);
          return { sent: 1, removed: 0 };
        },
        flushHeld: async () => null,
        onDigestSettled: () => () => {}, onDigestRelease: () => () => {},
        onDigestReword: () => () => {},
      },
      checks: [],
      fetch: (async () => new Response("")) as typeof fetch,
      now: () => new Date(clock.getTime() + PUSH_RETRY_MS),
      logger: { error: () => {} },
    });
    await spy.deliverPushes();
    expect(unsent).toHaveLength(1 + MAX_QUEUED_ALERTS);
    expect(unsent.filter((count) => count > 0)).toEqual([50]);
    expect(unsent[0], "a briefing never carries the count").toBe(0);
    expect(spy.store.pendingPushes()).toBe(0);
    expect(spy.store.duePushes(clock).unlisted).toBe(0);
    spy.close();
    ops.close();
  });

  it("reads a GitHub snapshot stored before sources existed without crashing", async () => {
    clock = at("2026-09-28T02:00:00Z");
    const ops = service();
    const { sources: _gone, ...old } = github({ runs: [{ ...RUN }] });
    delete (old.runs[0] as Partial<WorkflowRun>).attempt;
    ops.store.put("github", old as GithubSnapshot, clock);
    expect(ops.store.get("github")?.sources).toBeNull();
    expect(ops.store.get("github")?.runs[0]?.attempt).toBe(1);
    const { source: _none, ...oldFly } = FLY;
    ops.store.put("fly", oldFly as FlySnapshot, clock);
    expect(ops.store.get("fly")?.source).toBeNull();
    const view = ops.view();
    expect(view.github?.sources).toBeNull();
    expect(view.summary.redCi).toBe(1);
    clock = at("2026-09-27T20:31:00Z");
    const briefing = await ops.briefingTick();
    expect(briefing?.items.find((item) => item.key === "failures")?.tone).toBe("bad");
    ops.close();
  });

  it("raises each deploy alert once", async () => {
    clock = at("2026-09-28T02:00:00Z");
    const ops = service();
    await ops.putFly(FLY);
    await ops.putFly(FLY);
    expect(pushed.filter((p) => p.category === "deploy-failed")).toHaveLength(1);
    ops.close();
  });
});

describe("ops routes", () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it("needs the bridge token for bridge PUTs and a session for reads", async () => {
    const put = (path: string, body: unknown, token = BRIDGE_TOKEN) =>
      fetch(`${server.base}${path}`, { method: "PUT", headers: bearer(token), body: JSON.stringify(body) });
    expect((await put("/api/bridge/ops/github", github(), "d".repeat(64))).status).toBe(401);
    expect((await put("/api/bridge/ops/github", { ...github(), extra: 1 })).status).toBe(400);
    expect((await put("/api/bridge/ops/github", github())).status).toBe(200);
    expect((await put("/api/bridge/ops/mac", mac())).status).toBe(200);
    const usage = {
      at: new Date().toISOString(),
      limits: [{ kind: "session", label: "Session (5 hours)", percent: 85, severity: "warning", resetsAt: new Date(Date.now() + 3600_000).toISOString(), active: true }],
    };
    expect((await put("/api/bridge/ops/claude", usage, "d".repeat(64))).status).toBe(401);
    expect((await put("/api/bridge/ops/claude", { ...usage, token: "x" })).status).toBe(400);
    expect((await put("/api/bridge/ops/claude", { ...usage, limits: [{ ...usage.limits[0], percent: 101 }] })).status).toBe(400);
    expect((await put("/api/bridge/ops/claude", { ...usage, limits: [] })).status).toBe(400);
    expect((await put("/api/bridge/ops/claude", usage)).status).toBe(200);
    expect((await put("/api/bridge/ops/fly", FLY)).status).toBe(200);
    expect((await fetch(`${server.base}/api/ops`)).status).toBe(401);
    await putBoard(server.base);

    const res = await fetch(`${server.base}/api/ops`, { headers: browser(server.cookie()) });
    expect(res.status).toBe(200);
    const view = (await res.json()) as { summary: { needs: number; redCi: number }; github: { prs: unknown[]; merged: unknown }; mac: unknown; claude: unknown };
    expect(view.summary.needs).toBe(2);
    expect(view.summary.redCi).toBe(1);
    expect(view.github.prs).toHaveLength(1);
    expect(view.mac).not.toBeNull();
    expect(view.claude).toMatchObject({ stale: false, limits: [{ kind: "session", percent: 85, severity: "warning" }] });

    const timeline = await fetch(`${server.base}/api/ops/timeline`, { headers: browser(server.cookie()) });
    expect(timeline.status).toBe(200);
  });

  it("answers a note with 404 before the first briefing", async () => {
    const res = await fetch(`${server.base}/api/bridge/briefing-note`, { method: "POST", headers: bearer(BRIDGE_TOKEN), body: JSON.stringify({ text: "hello" }) });
    expect(res.status).toBe(404);
    const bad = await fetch(`${server.base}/api/bridge/briefing-note`, { method: "POST", headers: bearer(BRIDGE_TOKEN), body: JSON.stringify({ text: "a\nb" }) });
    expect(bad.status).toBe(400);
    const briefing = await fetch(`${server.base}/api/briefing`, { headers: browser(server.cookie()) });
    expect(await briefing.json()).toEqual({ briefing: null });
  });

  it("reads and saves quiet hours with the same-origin guard", async () => {
    const get = await fetch(`${server.base}/api/settings/push`, { headers: browser(server.cookie()) });
    expect(get.status).toBe(200);
    const settings = { ...DEFAULT_QUIET, start: "23:00", end: "06:30" };
    const noHeader = await fetch(`${server.base}/api/settings/push`, {
      method: "PUT",
      headers: { ...browser(server.cookie()), "x-rivet": "" },
      body: JSON.stringify(settings),
    });
    expect(noHeader.status).toBe(403);
    const bad = await fetch(`${server.base}/api/settings/push`, { method: "PUT", headers: browser(server.cookie()), body: JSON.stringify({ ...settings, start: "25:00" }) });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${server.base}/api/settings/push`, { method: "PUT", headers: browser(server.cookie()), body: JSON.stringify(settings) });
    expect(ok.status).toBe(200);
    expect(server.app.quiet.settings()).toEqual(settings);
    for (const start of ["24:00", "7:00"]) {
      const refused = await fetch(`${server.base}/api/settings/push`, { method: "PUT", headers: browser(server.cookie()), body: JSON.stringify({ ...DEFAULT_QUIET, start }) });
      expect(refused.status).toBe(400);
    }
    const defaults = await fetch(`${server.base}/api/settings/push`, { method: "PUT", headers: browser(server.cookie()), body: JSON.stringify(DEFAULT_QUIET) });
    expect(defaults.status).toBe(200);
  });

  it("searches history on the server", async () => {
    const res = await fetch(`${server.base}/api/ops/search?q=ab`, { headers: browser(server.cookie()) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
    expect((await fetch(`${server.base}/api/ops/search?q=${"x".repeat(500)}`, { headers: browser(server.cookie()) })).status).toBe(200);
  });

  it("moves a Coming row whose PR GitHub shows merged to Shipped, dated by the merge, and drops one closed unmerged", async () => {
    const putGithub = (body: Partial<GithubSnapshot>) =>
      fetch(`${server.base}/api/bridge/ops/github`, { method: "PUT", headers: bearer(BRIDGE_TOKEN), body: JSON.stringify(github({ at: new Date().toISOString(), prsComplete: true, ...body })) });
    const board = async () => ((await (await fetch(`${server.base}/api/board`, { headers: browser(server.cookie()) })).json()) as BoardResponse).board!;
    const mergedAt = github().merged![0]!.mergedAt;
    await putBoard(server.base, { ...EXAMPLE_BOARD, coming: [{ pr: 216, title: "Phases 2-4", stage: "review" }, { pr: 2100, title: "Notes export" }, { pr: 2200, title: "Dropped idea" }] });
    const closed = [{ repo: "example-org/example-repo", number: 2200, closedAt: mergedAt }];
    expect((await putGithub({ merged: github().merged, closed })).status).toBe(200);
    const after = await board();
    expect(after.coming.map((item) => item.pr)).toEqual([2100]);
    expect(after.shipped.find((row) => row.pr === 216)).toMatchObject({ title: "Phases 2-4", shippedAt: mergedAt });
    // An older bridge sends no closed list; a push of the same rows moves them again.
    expect((await putGithub({ merged: github().merged })).status).toBe(200);
    expect((await putBoard(server.base, { ...EXAMPLE_BOARD, coming: [{ pr: 216, title: "Phases 2-4", stage: "review" }, { pr: 2100, title: "Notes export" }, { pr: 2200, title: "Dropped idea" }] })).status).toBe(200);
    expect((await board()).coming.map((item) => item.pr)).toEqual([2100]);
  });

  it("keeps a reopened Coming row omitted from capped PR readings on ingestion and board writes", async () => {
    const repo = "example-org/other-repo";
    const row = { pr: 301, chat: "reopened", title: "Reopened" };
    const chats = [{ name: "reopened", state: "working" as const, repo, prs: [301] }];
    const read = async () => ((await (await fetch(`${server.base}/api/board`, { headers: browser(server.cookie()) })).json()) as BoardResponse).board!;
    await putBoard(server.base, { ...EXAMPLE_BOARD, coming: [row], chats });
    const prs = Array.from({ length: 300 }, (_, i) => ({ ...github().prs[0]!, number: i + 1 }));
    const closed = [{ repo, number: 301, closedAt: github().at }];
    for (const prsComplete of [false, undefined]) {
      const snapshot = github({ at: new Date().toISOString(), prs, prsComplete, closed, merged: [] });
      expect((await fetch(`${server.base}/api/bridge/ops/github`, { method: "PUT", headers: bearer(BRIDGE_TOKEN), body: JSON.stringify(snapshot) })).status).toBe(200);
      expect((await read()).coming.map((item) => item.pr)).toEqual([301]);
      // A later whole-board write consults the cached closure and the same capped snapshot.
      expect((await putBoard(server.base, { ...EXAMPLE_BOARD, coming: [row], chats })).status).toBe(200);
      expect((await read()).coming.map((item) => item.pr)).toEqual([301]);
    }
    const expired = github({ at: new Date(Date.now() - 6 * 60_000).toISOString(), prs, prsComplete: true, closed, merged: [] });
    expect((await fetch(`${server.base}/api/bridge/ops/github`, { method: "PUT", headers: bearer(BRIDGE_TOKEN), body: JSON.stringify(expired) })).status).toBe(200);
    expect((await read()).coming.map((item) => item.pr)).toEqual([301]);
    expect((await putBoard(server.base, { ...EXAMPLE_BOARD, coming: [row], chats })).status).toBe(200);
    expect((await read()).coming.map((item) => item.pr)).toEqual([301]);
    expect((await fetch(`${server.base}/api/bridge/ops/github`, { method: "PUT", headers: bearer(BRIDGE_TOKEN), body: JSON.stringify(github({ at: new Date().toISOString(), prs, prsComplete: true, closed, merged: [] })) })).status).toBe(200);
    expect((await read()).coming).toEqual([]);
  });

  it("a Coming row written after GitHub's list already shows its PR merged goes to Shipped as it is stored", async () => {
    expect((await fetch(`${server.base}/api/bridge/ops/github`, { method: "PUT", headers: bearer(BRIDGE_TOKEN), body: JSON.stringify(github()) })).status).toBe(200);
    expect((await putBoard(server.base, { ...EXAMPLE_BOARD, coming: [{ pr: 216, title: "Phases 2-4", stage: "review" }] })).status).toBe(200);
    const read = (await (await fetch(`${server.base}/api/board`, { headers: browser(server.cookie()) })).json()) as BoardResponse;
    expect(read.board!.coming).toEqual([]);
    expect(read.board!.shipped.find((row) => row.pr === 216)?.shippedAt).toBe(github().merged![0]!.mergedAt);
  });

  it("a Coming write answers with its own row when settlement moves the rows above it", async () => {
    expect((await fetch(`${server.base}/api/bridge/ops/github`, { method: "PUT", headers: bearer(BRIDGE_TOKEN), body: JSON.stringify(github()) })).status).toBe(200);
    expect((await putBoard(server.base, { ...EXAMPLE_BOARD, coming: [] })).status).toBe(200);
    const patch = async (pr: number, body: unknown) =>
      (await (await fetch(`${server.base}/api/board/coming/${pr}`, { method: "PATCH", headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) })).json()) as { item?: { pr?: number } };
    expect((await patch(216, { title: "Phases 2-4" })).item?.pr).toBe(216);
    expect((await patch(2300, { title: "Next" })).item).toMatchObject({ pr: 2300, title: "Next" });
    const read = (await (await fetch(`${server.base}/api/board`, { headers: browser(server.cookie()) })).json()) as BoardResponse;
    expect(read.board!.coming.map((item) => item.pr)).toEqual([2300]);
  });

  it("need-you counts leave out a card you answered at its rev, as the Feed does, in Ops and the crew", async () => {
    await putBoard(server.base);
    const cookie = server.cookie();
    const workers = {
      workers: [{ worktreeId: "0123456789abcdef", repo: "example-org/example-repo", chat: "checkout-feedback", connected: true, lastOutputAt: 0, agent: "claude", busy: false }],
    };
    expect((await fetch(`${server.base}/api/bridge/workers`, { method: "PUT", headers: bearer(BRIDGE_TOKEN), body: JSON.stringify(workers) })).status).toBe(200);
    const read = async () => ({
      needs: ((await (await fetch(`${server.base}/api/ops`, { headers: browser(cookie) })).json()) as { summary: { needs: number } }).summary.needs,
      crew: ((await (await fetch(`${server.base}/api/workers`, { headers: browser(cookie) })).json()) as { workers: { state: string }[] }).workers[0]?.state,
    });
    expect(await read()).toEqual({ needs: 2, crew: "waiting" });
    const rev = await revOf(server.base, cookie, "pr2022-checkout");
    const posted = await fetch(`${server.base}/api/replies`, {
      method: "POST",
      headers: browser(cookie),
      body: JSON.stringify({ clientId: "client-0002", itemId: "pr2022-checkout", decision: "comment", text: "Looks good", rev }),
    });
    expect(posted.status).toBe(201);
    expect(await read()).toEqual({ needs: 1, crew: "idle" });
  });

  it("opens a reply hit on that reply, not the latest few Your answers lists", async () => {
    await putBoard(server.base);
    const cookie = server.cookie();
    const rev = await revOf(server.base, cookie, "pr2022-checkout");
    const posted = await fetch(`${server.base}/api/replies`, {
      method: "POST",
      headers: browser(cookie),
      body: JSON.stringify({ clientId: "client-0001", itemId: "pr2022-checkout", decision: "choice", choice: "Approve and merge", rev }),
    });
    expect(posted.status).toBe(201);
    const { id } = (await posted.json()) as { id: string };
    const res = await fetch(`${server.base}/api/ops/search?q=checkout%20button`, { headers: browser(cookie) });
    const { results } = (await res.json()) as { results: SearchItem[] };
    expect(results.find((item) => item.kind === "reply")).toMatchObject({ key: `reply:${id}`, open: { type: "reply", id } });
  });
});

it("refuses any two Rivet tokens that are the same", () => {
  const token = "4a".repeat(32);
  expect(() => loadConfig({ RIVET_BOARD_TOKEN: token, RIVET_BRIDGE_TOKEN: ` ${token} ` })).toThrow("RIVET_BOARD_TOKEN and RIVET_BRIDGE_TOKEN must be different tokens");
  expect(() => loadConfig({ RIVET_BOARD_TOKEN: BRIDGE_TOKEN, RIVET_ENROLL_TOKEN: BRIDGE_TOKEN })).toThrow("RIVET_BOARD_TOKEN and RIVET_ENROLL_TOKEN must be different tokens");
  expect(() => loadConfig({ RIVET_BRIDGE_TOKEN: BOARD_TOKEN, RIVET_ENROLL_TOKEN: BOARD_TOKEN })).toThrow("RIVET_BRIDGE_TOKEN and RIVET_ENROLL_TOKEN must be different tokens");
  expect(() => loadConfig({ RIVET_BOARD_TOKEN: BRIDGE_TOKEN, RIVET_BRIDGE_TOKEN: BRIDGE_TOKEN })).toThrow();
  expect(loadConfig({ RIVET_BOARD_TOKEN: BOARD_TOKEN, RIVET_BRIDGE_TOKEN: BRIDGE_TOKEN, RIVET_REPOS: REPOS }).bridgeTokenDigest).not.toBeNull();
});

it("calls a runner retired once it has read offline in a row for over a week", () => {
  const load = (offline: string[], online: string[] = []) => ({
    online: online.length,
    busy: 0,
    offline: offline.length,
    runners: [...offline.map((name) => ({ name, status: "offline" as const, busy: false })), ...online.map((name) => ({ name, status: "online" as const, busy: false }))],
  });
  const day = (n: number) => new Date(Date.parse("2026-10-01T01:00:00Z") + n * 86_400_000).toISOString();
  let since = offlineSince({}, load(["mac-1", "old-1"]), day(0));
  since = offlineSince(since, load(["mac-1", "old-1"]), day(3));
  expect(since).toEqual({ "mac-1": day(0), "old-1": day(0) });
  expect(retiredRunners(since, new Date(day(7)))).toEqual([]);
  // mac-1 came back and went again: its spell starts over. A runner GitHub stops listing drops out.
  since = offlineSince(offlineSince(since, load(["old-1"], ["mac-1"]), day(4)), load(["mac-1", "old-1"]), day(5));
  expect(retiredRunners(since, new Date(Date.parse(day(7)) + 1))).toEqual(["old-1"]);
  expect(offlineSince(since, load([], ["mac-1"]), day(8))).toEqual({});
});


it("validates SHA release evidence and carries it through the timeline without leaking failed-release proof", () => {
  const mergeSha = "a".repeat(40);
  const sha = "b".repeat(12);
  const merged = [{ repo: MS, number: 3524, title: "Rivet: accurate patch notes", url: `https://github.com/${MS}/pull/3524`, mergedAt: "2026-09-27T02:00:00.000Z", author: "owner", mergeSha }];
  expect(githubSnapshotSchema.safeParse(github({ merged })).success).toBe(true);
  expect(githubSnapshotSchema.safeParse(github({ merged: [{ ...merged[0]!, mergeSha: "bad" }] })).success).toBe(false);
  const fly = { ...FLY, apps: [{ ...FLY.apps[0]!, app: "rivet-agents", releases: [
    { version: 3, status: "failed", at: "2026-09-28T01:30:00.000Z", sha, patchMerges: [mergeSha] },
    { version: 2, status: "complete", at: "2026-09-28T01:00:00.000Z", sha, patchMerges: [mergeSha] },
  ] }] };
  const parsed = flySnapshotSchema.parse(fly);
  const events = buildTimeline({ now: new Date(FLY.at), merged, fly: { ...parsed, source: parsed.source ?? null }, board: null }).days.flatMap((day) => day.events);
  expect(events.find((event) => event.kind === "merged")?.mergeSha).toBe(mergeSha);
  expect(events.find((event) => event.kind === "deploy")).toMatchObject({ sha, patchMerges: [mergeSha] });
  expect(events.find((event) => event.kind === "deploy-failed")?.patchMerges).toBeUndefined();
  for (const invalid of [{ sha: "not-sha" }, { patchMerges: ["bad"] }, { patchMerges: Array(601).fill(mergeSha) }, { proof: true }]) {
    expect(flySnapshotSchema.safeParse({ ...fly, apps: [{ ...fly.apps[0], releases: [{ ...fly.apps[0]!.releases[0], ...invalid }] }] }).success).toBe(false);
  }
});
