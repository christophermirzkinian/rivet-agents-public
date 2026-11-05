// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BRIEFING_STALE_MS, FLY_STALE_MS, GITHUB_STALE_MS, type OpsResponse } from "../src/shared/ops.js";
import { flyCurrent, opsData, resetOps } from "../web/src/ops-data.js";
import { app, resetSession, type OpsPage } from "../web/src/state.js";
import { failedItems, mount, unmount } from "../web/src/views/ops.js";

const NOW = "2026-10-08T00:00:00.000Z";
let root: HTMLElement;
function fixture(): OpsResponse {
  return {
    now: NOW, bridge: { connected: true }, mac: null, claude: null,
    github: { at: NOW, stale: false, sources: null, merged: null,
      prs: [{ repo: "owner/repo", number: 1, title: "Failed PR", url: "https://github.com/x/pull/1", draft: false, author: "a", labels: [], updatedAt: NOW, checks: { state: "fail", passed: 0, failed: 1, pending: 0, failing: ["lint"] } }],
      runs: [{ repo: "owner/repo", id: 1, attempt: 1, workflow: "CI", title: "Build", status: "in_progress", conclusion: null, event: "push", sha: "abc", url: "https://github.com/x/actions/runs/1", createdAt: NOW, updatedAt: NOW }],
      runners: { online: 0, offline: 1, busy: 0, runners: [{ name: "runner", status: "offline", busy: false }] }, queue: { queuedJobs: 2 },
    },
    flyAt: NOW, flyStale: false, flySource: null, healthStaleSince: null,
    apps: [{ id: "app", name: "App", app: "example-app", health: { state: "down", status: 503, ms: null, checkedAt: NOW, since: NOW, fails: 3 }, fly: { version: 1, machines: { started: 1, total: 1 }, checks: { passing: 0, total: 1 }, status: "deployed", lastRelease: { status: "failed", version: 1, at: NOW } } }],
    summary: { needs: 0, redCi: 0, failingSchedules: 0, appsDown: 1, disk: { freePct: null, tone: "info" } },
  } as unknown as OpsResponse;
}
function show(page: OpsPage) { unmount(); app.tab = "progress"; app.opsPage = page; mount(root); }
const section = (id: string) => root.querySelector(`[data-section="${id}"]`)!;
const line = (id: string) => section(id).querySelector(".ops-sec-line")!;
/** The named breaks of one kind: what Plan lists under Being done. */
const broken = (kind: string) => failedItems(opsData.ops).filter((item) => item.kind === kind);
beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  root = document.createElement("div"); document.body.replaceChildren(root);
  opsData.ops = fixture(); opsData.at = Date.now(); opsData.opsAt = { mono: performance.now(), wall: Date.now() };
});
afterEach(() => { unmount(); opsData.ops = null; vi.unstubAllGlobals(); vi.useRealTimers(); });

it("expires PR, main, runner and queue claims on the device", () => {
  opsData.opsAt.wall -= GITHUB_STALE_MS + 1;
  show("code");
  expect(line("prs").textContent).toContain("no current reading");
  expect(line("prs").textContent).not.toContain("failing");
  expect(section("prs").querySelector(".s-bad,.t-bad,.ops-checks-bar")).toBeNull();
  expect(line("main").textContent).toContain("no current reading");
  expect(section("main").textContent).not.toContain("Running now");
  expect(section("main").querySelector(".s-bad,.s-ok")).toBeNull();
  show("machines");
  expect(line("runners").textContent).not.toContain("busy");
  expect(section("runners").querySelector(".s-bad,.t-bad,.t-ok")).toBeNull();
});

it("handles failed PR, runs and runner sources while queue stays current", () => {
  opsData.ops!.github!.sources = { prs: { failed: ["repo"], at: NOW }, runs: { failed: ["repo"], at: NOW }, runners: { failed: ["repo"], at: NOW }, queue: { failed: [], at: NOW } } as never;
  show("code");
  expect(line("prs").textContent).not.toContain("failing");
  expect(line("main").textContent).toContain("no current reading");
  expect(root.querySelector(".ops-pill")).toBeNull();
  show("machines");
  expect(line("runners").textContent).toContain("2+ jobs queued in sample");
  expect(line("runners").textContent).not.toContain("offline");
});

it("dates stale health in apps without down actions, independently of Fly", () => {
  opsData.ops!.healthStaleSince = NOW;
  opsData.ops!.flySource = { at: NOW, failed: ["example-app"] };
  show("machines");
  expect(line("apps").textContent).toContain("No current health reading");
  expect(section("apps").textContent).toContain("no current Fly reading");
  expect(section("apps").querySelector(".s-bad,.t-bad")).toBeNull();
  expect(broken("app")).toHaveLength(0);
  opsData.ops!.flySource = null;
  show("machines");
  expect(section("apps").querySelector(".s-warn")).not.toBeNull();
});

it("expires Fly separately and honours missing dates and per-app failures", () => {
  expect(flyCurrent(opsData.ops!, "example-app")).toBe(true);
  opsData.opsAt.wall -= BRIEFING_STALE_MS + 1;
  expect(flyCurrent(opsData.ops!, "example-app")).toBe(true);
  opsData.opsAt.wall -= FLY_STALE_MS;
  expect(flyCurrent(opsData.ops!, "example-app")).toBe(false);
  show("machines");
  expect(section("apps").querySelector(".s-bad,.s-warn")).toBeNull();
  opsData.opsAt.wall = Date.now(); opsData.ops!.flyAt = null;
  expect(flyCurrent(opsData.ops!, "example-app")).toBe(false);
});

it("qualifies partial PR, runner and job counts, including legacy snapshots", () => {
  show("code");
  expect(line("prs").textContent).toContain("1+ open PRs fetched");
  show("machines");
  expect(line("runners").textContent).toContain("0+/0+ busy");
  expect(section("runners").textContent).toContain("Runner list is a fetched sample");
  opsData.ops!.github!.prsComplete = true;
  opsData.ops!.github!.runners!.complete = true;
  opsData.ops!.github!.runners!.detailsComplete = true;
  opsData.ops!.github!.queue!.jobsComplete = true;
  show("code");
  expect(line("prs").textContent).toContain("1 open PR");
  expect(line("prs").textContent).not.toContain("+");
  show("machines");
  expect(line("runners").textContent).toContain("2 jobs queued");
  expect(section("runners").textContent).not.toContain("fetched sample");
});

it("dates retained readings from the failed source, not the new envelope", () => {
  const old = "2026-10-07T20:00:00.000Z";
  opsData.ops!.github!.sources = { prs: { failed: ["repo"], at: old }, runs: { failed: ["repo"], at: old }, runners: { failed: ["repo"], at: old }, queue: { failed: [], at: NOW } } as never;
  show("code");
  expect(section("prs").querySelector(".ops-pr-status")!.textContent).toContain("7:00am");
  expect(line("main").textContent).toContain("7:00am");
  show("machines");
  expect(section("runners").querySelector(".ops-row")!.textContent).toContain("7:00am");
  opsData.ops!.flySource = { failed: ["example-app"], at: null };
  show("machines");
  expect(section("apps").textContent).toContain("no reading · no current Fly reading");
});

it("qualifies offline details separately from complete totals and explains the queue sample", () => {
  opsData.ops!.github!.runners!.complete = true;
  opsData.ops!.github!.runners!.detailsComplete = false;
  opsData.ops!.github!.queue!.queuedJobs = 0;
  opsData.ops!.github!.queue!.sampledRuns = 50;
  show("machines");
  expect(line("runners").textContent).toContain("0/0 busy");
  expect(line("runners").textContent).toContain("1+ offline");
  expect(line("runners").textContent).toContain("0+ jobs queued in sample");
  const offline = [...section("runners").querySelectorAll(".ops-stat")].find((stat) => stat.querySelector(".ops-stat-l")?.textContent === "offline");
  expect(offline?.querySelector(".ops-stat-n")?.textContent).toBe("1+");
  expect(section("runners").textContent).toContain("Checked 50 runs; job list may be incomplete.");
  opsData.ops!.github!.queue!.jobsComplete = true;
  show("machines");
  expect(section("runners").textContent).not.toContain("job list may be incomplete");
});

it("expires checks already fourteen minutes old after two minutes on the device", () => {
  opsData.ops!.apps[0]!.health.checkedAt = new Date(Date.parse(NOW) - 14 * 60_000).toISOString();
  opsData.ops!.apps[0]!.fly = null;
  show("machines");
  expect(line("apps").textContent).toContain("1 down");
  expect(broken("app")).toHaveLength(1);
  opsData.opsAt.wall -= 2 * 60_000;
  show("machines");
  expect(line("apps").textContent).toContain("No current health reading");
  expect(section("apps").querySelector(".s-bad,.t-bad")).toBeNull();
  expect(broken("app")).toHaveLength(0);
});

it("counts only eligible sampled offline runners when omitted rows may be Macs", () => {
  const runners = opsData.ops!.github!.runners!;
  Object.assign(runners, { online: 50, offline: 10, busy: 0, complete: true, detailsComplete: false,
    runners: Array.from({ length: 50 }, (_, n) => ({ name: `example-runner-${n}`, status: "online", busy: false })),
  });
  show("machines");
  expect(line("runners").textContent).not.toContain("offline");
  expect(line("runners").classList.contains("t-warn")).toBe(false);
  expect(broken("runner")).toHaveLength(0);
  runners.runners[0] = { name: "example-runner-down", status: "offline", busy: false };
  show("machines");
  expect(line("runners").textContent).toContain("1+ offline");
  expect(broken("runner")).toHaveLength(1);
});

it("a new sign-in shows Ops loading, never the last session's reading", () => {
  show("machines");
  const last = line("runners").textContent!;
  expect(last).toContain("offline");
  expect(root.textContent).not.toContain("Loading Ops…");
  // The last session's recorded holds go too: a stale one would keep a chat at your OK.
  opsData.ownerHolds = [{ pr: 1, repo: "owner/repo", reason: "You: hold", at: NOW }];
  // What main.ts does on sign-in; the new session's own read never answers here.
  resetOps();
  resetSession();
  show("machines");
  expect(opsData.ops).toBeNull();
  expect(opsData.statuses).toBeNull();
  expect(opsData.ownerHolds).toBeNull();
  expect(root.textContent).toContain("Loading Ops…");
  expect(root.textContent).not.toContain(last);
});
