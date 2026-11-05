import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { opsStatusKey } from "../src/shared/ops-status-key.js";
import type { OpsStatus } from "../src/shared/ops-status.js";
import type { GithubSnapshot, OpsResponse, PullRequest, WorkflowRun } from "../src/shared/ops.js";
import { setKnownRepos } from "../src/shared/repos.js";
import type { Schedule } from "../src/shared/schedules.js";
import { JobsStore } from "../src/server/jobs.js";
import { staleRecords, type ClearReadings } from "../src/server/ops/auto-clear.js";
import { createOps } from "../src/server/ops/service.js";
import { Store } from "../src/server/store.js";

const REPO = "example-org/example-repo";
const NOW = new Date("2026-10-24T08:00:00.000Z");
const SINCE = "2026-10-12T07:40:00.000Z";

const status = (extra: Partial<OpsStatus>): OpsStatus => ({ kind: "pr", key: "6075", state: "in-progress", since: SINCE, updatedAt: SINCE, version: 1, ...extra });
const run = (conclusion: string, createdAt: string, extra: Partial<WorkflowRun> = {}): WorkflowRun =>
  ({ repo: REPO, id: 1, attempt: 1, workflow: "CI", status: "completed", conclusion, event: "push", sha: "a", createdAt, updatedAt: createdAt, title: "main", url: "https://github.com/x", ...extra }) as WorkflowRun;
const github = (extra: Partial<GithubSnapshot & { stale: boolean }> = {}): NonNullable<OpsResponse["github"]> =>
  ({
    at: NOW.toISOString(),
    stale: false,
    prs: [],
    prsComplete: true,
    runs: [],
    runners: null,
    queue: null,
    merged: null,
    closed: null,
    sources: { prs: { failed: [], at: null }, runs: { failed: [], at: null }, merged: { failed: [], at: null }, runners: { failed: [], at: null }, queue: { failed: [], at: null } },
    ...extra,
  }) as NonNullable<OpsResponse["github"]>;
const readings = (extra: Partial<ClearReadings> = {}): ClearReadings => ({ github: github(), merged: [], closed: [], schedules: null, ...extra });
const merged = (number: number, repo = REPO) => ({ repo, number, title: "t", url: "u", mergedAt: "2026-10-20T00:00:00.000Z", author: "a" });

describe("Stale Ops records clear themselves", () => {
  beforeAll(() => setKnownRepos([REPO, "example-org/other-repo"]));
  afterAll(() => setKnownRepos([]));

  it("sets a PR's record fixed when it merges or closes, and leaves it while it may be open", () => {
    expect(staleRecords([status({})], readings({ merged: [merged(6075)] }))).toEqual([{ status: status({}), note: "merged" }]);
    const backlog = status({ state: "backlog", key: "6232" });
    expect(staleRecords([backlog], readings({ merged: [merged(6232)] }))).toEqual([{ status: backlog, note: "merged" }]);
    // Another repo's PR of the same number is another record.
    expect(staleRecords([status({})], readings({ merged: [merged(6075, "example-org/other-repo")], github: github({ prsComplete: false }) }))).toEqual([]);
    expect(staleRecords([status({ key: "other-repo/6075" })], readings({ merged: [merged(6075, "example-org/other-repo")] }))).toHaveLength(1);
    const closed = [{ repo: REPO, number: 6075, closedAt: "2026-10-20T00:00:00.000Z" }];
    expect(staleRecords([status({})], readings({ closed }))).toEqual([{ status: status({}), note: "closed" }]);
    // Reopened, or the open list cannot say: it stays.
    const open = { repo: REPO, number: 6075 } as PullRequest;
    expect(staleRecords([status({})], readings({ closed, github: github({ prs: [open] }) }))).toEqual([]);
    expect(staleRecords([status({})], readings({ closed, github: github({ prsComplete: false }) }))).toEqual([]);
    expect(staleRecords([status({})], readings({ closed, github: github({ stale: true }) }))).toEqual([]);
    expect(staleRecords([status({})], readings({ closed, github: null }))).toEqual([]);
    // Reopened and its record written since the open list was read: the closed list is older news.
    expect(staleRecords([status({ updatedAt: NOW.toISOString() })], readings({ closed }))).toEqual([]);
    // Past the lists' days or cap: a complete, fresh open list read after the record's last change, without it.
    expect(staleRecords([status({})], readings())).toEqual([{ status: status({}), note: "merged or closed" }]);
    expect(staleRecords([status({ key: "other-repo/12" })], readings())).toEqual([{ status: status({ key: "other-repo/12" }), note: "merged or closed" }]);
    expect(staleRecords([status({ updatedAt: NOW.toISOString() })], readings())).toEqual([]);
    expect(staleRecords([status({})], readings({ github: github({ prsComplete: false }) }))).toEqual([]);
    expect(staleRecords([status({ key: "unknown-repo/12" }), status({ key: "not-a-number" })], readings())).toEqual([]);
  });

  it("sets a ci record fixed once its workflow's next run on main passes", () => {
    const ci = status({ kind: "ci", key: opsStatusKey("ci", "CI") });
    const after = run("success", "2026-10-13T00:00:00Z");
    expect(staleRecords([ci], readings({ github: github({ runs: [run("failure", "2026-10-12T07:00:00Z"), after] }) }))).toEqual([{ status: ci }]);
    // The latest is still red, or the green came before the record: the run it was written about.
    expect(staleRecords([ci], readings({ github: github({ runs: [after, run("failure", "2026-10-14T00:00:00Z")] }) }))).toEqual([]);
    expect(staleRecords([ci], readings({ github: github({ runs: [run("success", "2026-10-12T07:00:00Z")] }) }))).toEqual([]);
    // Another workflow's green, a one-off run's green, or a reading that cannot say: it stays.
    expect(staleRecords([ci], readings({ github: github({ runs: [run("success", "2026-10-13T00:00:00Z", { workflow: "Lint" })] }) }))).toEqual([]);
    const lint = status({ kind: "ci", key: opsStatusKey("ci", "Remote run") });
    expect(staleRecords([lint], readings({ github: github({ runs: [run("success", "2026-10-13T00:00:00Z", { workflow: "Remote run", event: "workflow_dispatch" })] }) }))).toEqual([]);
    expect(staleRecords([ci], readings({ github: github({ runs: [after], stale: true }) }))).toEqual([]);
    const failedRuns = github({ runs: [after] });
    failedRuns.sources!.runs.failed = ["example-repo"];
    expect(staleRecords([ci], readings({ github: failedRuns }))).toEqual([]);
    // Another repo's failed fetch says nothing about this one.
    const otherFailed = github({ runs: [after] });
    otherFailed.sources!.runs.failed = ["other-repo"];
    expect(staleRecords([ci], readings({ github: otherFailed }))).toEqual([{ status: ci }]);
    // A rerun keeps the run's createdAt: it passed when it finished.
    const rerun = run("success", "2026-10-12T07:00:00Z", { attempt: 2, updatedAt: "2026-10-12T08:00:00Z" });
    expect(staleRecords([ci], readings({ github: github({ runs: [rerun] }) }))).toEqual([{ status: ci }]);
    // A dispatched CI's green leaves a push's red standing.
    const dispatched = run("success", "2026-10-14T00:00:00Z", { event: "workflow_dispatch" });
    expect(staleRecords([ci], readings({ github: github({ runs: [run("failure", "2026-10-13T00:00:00Z"), dispatched] }) }))).toEqual([]);
    // A push's red aged out of the reading is not a push's green; a green latest push, from before a dispatch's red, is.
    expect(staleRecords([ci], readings({ github: github({ runs: [dispatched] }) }))).toEqual([]);
    expect(staleRecords([ci], readings({ github: github({ runs: [run("success", "2026-10-12T07:00:00Z"), dispatched] }) }))).toEqual([{ status: ci }]);
    expect(staleRecords([ci], readings({ github: github({ runs: [after, dispatched] }) }))).toEqual([{ status: ci }]);
    // The nightly schedule skips the secret scan too: it is no push's stand-in, nor clears a push's red.
    const nightly = run("success", "2026-10-13T12:00:00Z", { event: "schedule" });
    expect(staleRecords([ci], readings({ github: github({ runs: [run("failure", "2026-10-13T00:00:00Z"), nightly] }) }))).toEqual([]);
    expect(staleRecords([ci], readings({ github: github({ runs: [run("failure", "2026-10-13T00:00:00Z"), nightly, dispatched] }) }))).toEqual([]);
  });

  it("sets a schedule record fixed once its next run passes", () => {
    const record = status({ kind: "schedule", key: "nightly" });
    const schedule = (result: string, at: string, runs?: { at: string; result: string }[]) => [{ id: "nightly", source: "github", lastRun: { at, result }, runs }] as unknown as Schedule[];
    expect(staleRecords([record], readings({ schedules: schedule("ok", "2026-10-13T00:00:00Z") }))).toEqual([{ status: record }]);
    expect(staleRecords([record], readings({ schedules: schedule("failed", "2026-10-13T00:00:00Z") }))).toEqual([]);
    expect(staleRecords([record], readings({ schedules: schedule("ok", "2026-10-12T00:00:00Z") }))).toEqual([]);
    expect(staleRecords([record], readings({ schedules: null }))).toEqual([]);
    // A GitHub run created before the record and finished after it passed after it.
    const finished = schedule("ok", "2026-10-12T07:00:00Z", [{ at: "2026-10-12T08:00:00Z", result: "ok" }]);
    expect(staleRecords([record], readings({ schedules: finished }))).toEqual([{ status: record }]);
    // A source whose fetch failed resends its cached runs.
    const source = (ok: boolean) => [{ source: "github", ok }];
    expect(staleRecords([record], readings({ schedules: finished, scheduleSources: source(false) }))).toEqual([]);
    expect(staleRecords([record], readings({ schedules: finished, scheduleSources: source(true) }))).toEqual([{ status: record }]);
    // The newest finished run decides: a rerun of an older run that failed since, or a pass under a running run.
    const rerunFailed = schedule("ok", "2026-10-13T00:00:00Z", [{ at: "2026-10-13T00:01:00Z", result: "ok" }, { at: "2026-10-13T00:03:00Z", result: "failed" }]);
    expect(staleRecords([record], readings({ schedules: rerunFailed }))).toEqual([]);
    expect(staleRecords([record], readings({ schedules: schedule("running", "2026-10-13T01:00:00Z", [{ at: "2026-10-13T00:01:00Z", result: "ok" }]) }))).toEqual([{ status: record }]);
    expect(staleRecords([record], readings({ schedules: schedule("running", "2026-10-13T01:00:00Z") }))).toEqual([]);
  });

  it("leaves parked and fixed records, and other kinds, alone", () => {
    const ends = readings({ merged: [merged(6075)], github: github({ runs: [run("success", "2026-10-13T00:00:00Z")] }) });
    expect(staleRecords([status({ state: "parked" }), status({ state: "fixed" }), status({ kind: "ci", key: opsStatusKey("ci", "CI"), state: "parked" })], ends)).toEqual([]);
    expect(staleRecords([status({ kind: "app", key: "6075" }), status({ kind: "coming", key: "6075" })], ends)).toEqual([]);
  });

  it("sets a machine's pick-up waiting on a time fixed once it reads back up", () => {
    const waiting = status({ kind: "machine", key: "mac", state: "backlog", askedForTimeAt: SINCE });
    const parked = status({ kind: "machine", key: "mac", state: "parked" });
    expect(staleRecords([waiting, parked], readings({ backlogGreen: () => true }))).toEqual([{ status: waiting }]);
    expect(staleRecords([waiting], readings({ backlogGreen: () => false }))).toEqual([]);
    expect(staleRecords([waiting], readings())).toEqual([]);
  });

  it("sets a pick-up waiting on a time fixed once it has ended, an open PR's too", () => {
    const waiting = status({ kind: "app", key: opsStatusKey("app", "notes-app"), state: "backlog", askedForTimeAt: SINCE });
    const pr = status({ state: "backlog", askedForTimeAt: SINCE });
    const ended = (one: OpsStatus) => one === waiting || one === pr;
    const open = github({ prs: [{ repo: REPO, number: 6075 } as PullRequest] });
    expect(staleRecords([waiting, pr, status({})], readings({ github: open, backlogGreen: ended }))).toEqual([{ status: waiting }, { status: pr }]);
    // Not ended, or no reading: it stays.
    expect(staleRecords([waiting, pr], readings({ github: open, backlogGreen: () => false }))).toEqual([]);
    expect(staleRecords([waiting, pr], readings({ github: open }))).toEqual([]);
  });

  it("on the server: a merged PR's record is set fixed with no Fix result card, and a parked one stays", () => {
    const dir = mkdtempSync(join(tmpdir(), "rivet-clear-"));
    const store = new Store(dir);
    const cards: unknown[] = [];
    const ops = createOps({
      dataDir: dir,
      store,
      bridge: { status: () => ({ connected: true }) as never },
      push: { notify: async () => ({}) as never, flushHeld: async () => null, onDigestSettled: () => () => {}, onDigestRelease: () => () => {}, onDigestReword: () => () => {} } as never,
      checks: [],
      fetch: (async () => new Response("")) as typeof fetch,
      now: () => NOW,
      logger: { error: () => {} },
      addUpdate: (card) => {
        cards.push(card);
        return { status: 200 };
      },
    });
    store.addOpsStatus(status({ chat: "fix-pr-6075", note: "rebasing", version: store.nextOpsStatusVersion() }));
    store.addOpsStatus(status({ key: "6218", state: "parked", version: store.nextOpsStatusVersion() }));
    ops.store.put("merged", [merged(6075), merged(6218)], NOW);
    ops.clearStale();
    ops.settleFixes();
    expect(store.getOpsStatus("pr", "6075")).toMatchObject({ state: "fixed", note: "merged", by: "Rivet", chat: "fix-pr-6075", since: SINCE });
    expect(store.getOpsStatus("pr", "6218")).toMatchObject({ state: "parked" });
    expect(cards).toEqual([]);
    ops.close();
  });

  it("on the server: a job's record is set fixed by its first green run, with its Fix result card", () => {
    const dir = mkdtempSync(join(tmpdir(), "rivet-clear-"));
    const store = new Store(dir);
    const cards: { id: string; title: string }[] = [];
    let at = new Date("2026-10-24T06:00:00.000Z");
    const ops = createOps({
      dataDir: dir,
      store,
      bridge: { status: () => ({ connected: true }) as never },
      push: { notify: async () => ({}) as never, flushHeld: async () => null, onDigestSettled: () => () => {}, onDigestRelease: () => () => {}, onDigestReword: () => () => {} } as never,
      checks: [],
      fetch: (async () => new Response("")) as typeof fetch,
      now: () => at,
      logger: { error: () => {} },
      addUpdate: (card) => {
        cards.push(card as { id: string; title: string });
        return { status: 200 };
      },
    });
    const jobs = new JobsStore(dir);
    jobs.create("j-aaaaaaaa", { name: "Notes App up", words: "check Notes App is up", kind: "check", check: { probe: "up", app: "notes-app", where: "mac", onRed: "card" }, when: { every: "day", at: "07:00" }, cards: "red" }, at);
    const runOnce = (run: string, state: "green" | "red") => {
      expect(jobs.start("j-aaaaaaaa", { run, state: "start", manual: true }, at)).toMatchObject({ go: true });
      jobs.finish("j-aaaaaaaa", { run, state }, at);
    };
    const key = opsStatusKey("schedule", "job-j-aaaaaaaa");
    store.addOpsStatus(status({ kind: "schedule", key, chat: "fix-notes-up", note: "Fly machine restarted", version: store.nextOpsStatusVersion() }));
    runOnce("run-00000001", "red");
    ops.settleFixes();
    ops.clearStale();
    expect(store.getOpsStatus("schedule", key)).toMatchObject({ state: "in-progress" });
    at = new Date("2026-10-24T07:00:00.000Z");
    runOnce("run-00000002", "green");
    ops.settleFixes();
    ops.clearStale();
    expect(store.getOpsStatus("schedule", key)).toMatchObject({ state: "fixed", note: "Fly machine restarted" });
    expect(cards.map((card) => card.title)).toEqual(["Notes App up passing again: Fly machine restarted"]);
    jobs.close();
    ops.close();
  });

  it("on the server: a ci record the fix-result pass saw red is set fixed and still gets its card, retried when refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "rivet-clear-"));
    const store = new Store(dir);
    const cards: { id: string; title: string }[] = [];
    let full = true;
    const ops = createOps({
      dataDir: dir,
      store,
      bridge: { status: () => ({ connected: true }) as never },
      push: { notify: async () => ({}) as never, flushHeld: async () => null, onDigestSettled: () => () => {}, onDigestRelease: () => () => {}, onDigestReword: () => () => {} } as never,
      checks: [],
      fetch: (async () => new Response("")) as typeof fetch,
      now: () => NOW,
      logger: { error: () => {} },
      addUpdate: (card) => {
        if (full) return { status: 507, error: "the board is full" };
        cards.push(card as { id: string; title: string });
        return { status: 200 };
      },
    });
    const key = opsStatusKey("ci", "CI");
    const lint = opsStatusKey("ci", "Lint");
    store.addOpsStatus(status({ kind: "ci", key, note: "flaky test pinned", version: store.nextOpsStatusVersion() }));
    store.addOpsStatus(status({ kind: "ci", key: lint, version: store.nextOpsStatusVersion() }));
    ops.store.put("fixSeenRed", [`ci/${key}/${SINCE}`], NOW);
    ops.store.put("github", github({ runs: [run("success", "2026-10-13T00:00:00Z"), run("success", "2026-10-13T00:00:00Z", { workflow: "Lint" })] }), NOW);
    ops.settleFixes();
    ops.clearStale();
    expect(store.getOpsStatus("ci", key)).toMatchObject({ state: "fixed", note: "flaky test pinned" });
    expect(store.getOpsStatus("ci", lint)).toMatchObject({ state: "fixed" });
    expect(cards).toEqual([]);
    // The board has room again: the seen-red fix gets its card, the record that only ended gets none.
    full = false;
    ops.settleFixes();
    ops.settleFixes();
    expect(cards.map((card) => card.title)).toEqual(["CI green on main: flaky test pinned"]);
    ops.close();
  });
});
