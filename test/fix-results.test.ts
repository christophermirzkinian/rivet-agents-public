import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { opsStatusKey } from "../src/shared/ops-status-key.js";
import type { OpsStatus } from "../src/shared/ops-status.js";
import type { Health, OpsResponse, PullRequest, WorkflowRun } from "../src/shared/ops.js";
import { HANDLER_BY } from "../src/shared/ops-owned.js";
import { setKnownRepos } from "../src/shared/repos.js";
import { backlogGreen, fixCard, fixResults, itemGreen, FIX_RESULT_WINDOW_MS } from "../src/server/ops/fixes.js";
import { createOps } from "../src/server/ops/service.js";
import { Store } from "../src/server/store.js";

const NOW = new Date("2026-10-05T08:00:00.000Z");
const SINCE = "2026-10-05T07:40:00.000Z";

const status = (extra: Partial<OpsStatus>): OpsStatus => ({ kind: "app", key: "tasks-app", state: "investigating", since: SINCE, updatedAt: SINCE, version: 1, ...extra });
const health = (state: Health["state"], at = NOW.toISOString()): Health => ({ state, status: state === "up" ? 200 : 502, ms: 40, checkedAt: at, since: SINCE, fails: state === "down" ? 5 : 0 });
const view = (extra: Partial<OpsResponse> = {}): OpsResponse =>
  ({ github: null, healthStaleSince: null, apps: [{ id: "tasks-app", name: "Tasks App", health: health("down"), fly: null }], ...extra }) as unknown as OpsResponse;
const run = (conclusion: string, createdAt: string): WorkflowRun =>
  ({ repo: "example-org/example-repo", workflow: "CI", status: "completed", conclusion, createdAt, updatedAt: createdAt, title: "main", url: "https://github.com/x" }) as unknown as WorkflowRun;
const pr = (state: PullRequest["checks"]["state"]): PullRequest => ({ repo: "example-org/example-repo", number: 177, title: "Notes list", checks: { state, passed: 1, failed: 0, pending: 0, failing: [] } }) as unknown as PullRequest;

describe("Fix result", () => {
  beforeAll(() => setKnownRepos(["example-org/example-repo", "example-org/other-repo"]));
  afterAll(() => setKnownRepos([]));

  it("reads each kind's item green or red from the readings, and unknown when they cannot say", () => {
    expect(itemGreen(status({}), { view: view(), schedules: null })).toBe(false);
    const up = view({ apps: [{ id: "tasks-app", name: "Tasks App", health: health("up"), fly: null }] as OpsResponse["apps"] });
    expect(itemGreen(status({}), { view: up, schedules: null })).toBe(true);
    expect(itemGreen(status({}), { view: { ...up, healthStaleSince: SINCE }, schedules: null })).toBeNull();
    expect(itemGreen(status({ key: "notes-app" }), { view: up, schedules: null })).toBeNull();
    // Down is down whatever Fly says; back up needs Fly's reading of the app to be current.
    const flown = (state: Health["state"]) => view({ apps: [{ id: "tasks-app", name: "Tasks App", app: "tasks-app", health: health(state), fly: { lastRelease: { status: "complete" } } }] as never });
    expect(itemGreen(status({}), { view: { ...flown("down"), flyStale: true }, schedules: null })).toBe(false);
    expect(itemGreen(status({}), { view: { ...flown("up"), flyStale: true }, schedules: null })).toBeNull();
    // Fly's first read of the app failed, so it has no Fly record at all: still not known to be back up.
    const unread = view({ apps: [{ id: "tasks-app", name: "Tasks App", app: "tasks-app", health: health("up"), fly: null }] as never });
    expect(itemGreen(status({}), { view: { ...unread, flySource: { failed: ["tasks-app"], at: null } }, schedules: null })).toBeNull();
    expect(itemGreen(status({}), { view: { ...flown("up"), flySource: { failed: ["tasks-app"], at: null } }, schedules: null })).toBeNull();
    // An app with no check is not probed: awake with a failing Fly check it is not back up; stopped or passing, it is.
    const unchecked = (started: number, passing: number, total = 1) =>
      view({ apps: [{ id: "tasks-app", name: "Tasks App", app: "tasks-app", health: health("no-check"), fly: { machines: { started, total }, checks: { passing, total }, lastRelease: { status: "complete" } } }] as never });
    expect(itemGreen(status({}), { view: unchecked(1, 0), schedules: null })).toBe(false);
    expect(itemGreen(status({}), { view: unchecked(0, 0), schedules: null })).toBe(true);
    expect(itemGreen(status({}), { view: unchecked(1, 1), schedules: null })).toBe(true);
    // One awake and failing beside a stopped spare is not back up either.
    expect(itemGreen(status({}), { view: unchecked(1, 0, 2), schedules: null })).toBe(false);
    // A stale or failed Fly reading says nothing, failing check or not.
    expect(itemGreen(status({}), { view: { ...unchecked(1, 0), flyStale: true }, schedules: null })).toBeNull();

    const github = (runs: WorkflowRun[], prs: PullRequest[], failed: string[] = []) =>
      view({ github: { stale: false, runs, prs, sources: { runs: { failed }, prs: { failed: [] } } } as unknown as OpsResponse["github"] });
    const ci = status({ kind: "ci", key: "ci_0zh2u01" });
    expect(itemGreen(ci, { view: github([run("failure", SINCE), run("success", NOW.toISOString())], []), schedules: null })).toBe(true);
    expect(itemGreen(ci, { view: github([run("failure", NOW.toISOString())], []), schedules: null })).toBe(false);
    expect(itemGreen(ci, { view: github([run("success", NOW.toISOString())], [], ["example-repo"]), schedules: null })).toBeNull();
    const red = status({ kind: "pr", key: "177" });
    expect(itemGreen(red, { view: github([], [pr("pass")]), schedules: null })).toBe(true);
    expect(itemGreen(red, { view: github([], [pr("pending")]), schedules: null })).toBeNull();

    const sched = status({ kind: "schedule", key: "nightly" });
    const item = (result: string) => [{ id: "nightly", name: "Nightly sweep", lastRun: { at: NOW.toISOString(), result } }] as never;
    expect(itemGreen(sched, { view: view(), schedules: item("ok") })).toBe(true);
    expect(itemGreen(sched, { view: view(), schedules: item("failed") })).toBe(false);
    expect(itemGreen(sched, { view: view(), schedules: null })).toBeNull();
    expect(itemGreen(status({ kind: "machine", key: "mac" }), { view: view(), schedules: null })).toBeNull();
  });

  it("reads a machine, a Mac volume and a runner green only when every reading that shows it is current", () => {
    const at = NOW.toISOString();
    const old = "2026-10-05T07:30:00.000Z";
    const mac = (free: number, macAt = at) => ({ at: macAt, stale: false, memory: { pressure: "normal", freePct: 40 }, runners: [], volumes: [{ label: "Data", totalBytes: 100, freeBytes: free }] });
    const runners = (state: string, githubAt = at) => ({ at: githubAt, stale: false, runs: [], prs: [], sources: { runs: { failed: [] }, prs: { failed: [] }, runners: { failed: [] } }, runners: { runners: [{ name: "runner-1", status: state }] } });
    const read = (extra: Record<string, unknown>) => ({ view: view({ now: at, bridge: { connected: true }, ...extra } as Partial<OpsResponse>), schedules: null });
    const mine = status({ kind: "machine", key: "mac" });
    const disk = status({ kind: "disk", key: opsStatusKey("disk", "Data") });
    const runner = status({ kind: "runner", key: opsStatusKey("runner", "runner-1") });

    expect(itemGreen(mine, read({ mac: mac(50) }))).toBe(true);
    expect(itemGreen(disk, read({ mac: mac(50) }))).toBe(true);
    expect(itemGreen(disk, read({ mac: mac(1) }))).toBe(false);
    expect(itemGreen(runner, read({ github: runners("online") }))).toBe(true);
    expect(itemGreen(runner, read({ github: runners("offline") }))).toBe(false);
    // Out of date, not read, or not in the reading at all: cannot say.
    expect(itemGreen(mine, read({ mac: mac(50, old) }))).toBeNull();
    expect(itemGreen(status({ kind: "machine", key: "other" }), read({ mac: mac(50) }))).toBeNull();
    expect(itemGreen(status({ kind: "disk", key: opsStatusKey("disk", "Backup") }), read({ mac: mac(50) }))).toBeNull();
    expect(itemGreen(runner, read({ github: runners("online", old) }))).toBeNull();
    expect(itemGreen(runner, read({ github: { ...runners("online"), sources: { runs: { failed: [] }, prs: { failed: [] }, runners: { failed: ["example-repo"] } } } }))).toBeNull();
  });

  it("never reads a machine, volume or runner back up from a measurement that failed or an older reading", () => {
    const at = NOW.toISOString();
    const mac = (pressure: string) => ({ at, stale: false, memory: { pressure, freePct: 40 }, runners: [], volumes: [{ label: "Data", totalBytes: 0, freeBytes: 0 }] });
    const runners = (state: string, failed: string[] = []) => ({ at, stale: false, runs: [], prs: [], sources: { runs: { failed: [] }, prs: { failed: [] }, runners: { failed } }, runners: { runners: [{ name: "runner-1", status: state }] } });
    const read = (extra: Record<string, unknown>) => ({ view: view({ now: at, bridge: { connected: true }, ...extra } as Partial<OpsResponse>), schedules: null });
    const mine = status({ kind: "machine", key: "mac" });
    // A measurement that failed is no recovery: the Mac's memory unknown, a volume with no size.
    expect(itemGreen(mine, read({ mac: mac("unknown") }))).toBeNull();
    expect(itemGreen(status({ kind: "disk", key: opsStatusKey("disk", "Data") }), read({ mac: mac("normal") }))).toBeNull();
    // A runner retired is out of the count.
    const runner = status({ kind: "runner", key: opsStatusKey("runner", "runner-1") });
    expect(itemGreen(runner, read({ github: runners("offline"), retiredRunners: ["runner-1"] }))).toBe(true);
    // A reading from before the failure began is the one the record was written against.
    expect(itemGreen({ ...runner, since: "2026-10-05T08:00:01.000Z" }, read({ github: runners("online") }))).toBeNull();
  });

  it("ends a machine's, a Mac volume's or a runner's pick-up waiting on a time only on a green read since it began", () => {
    const at = NOW.toISOString();
    const mac = (free: number, macAt = at) => ({ at: macAt, stale: false, memory: { pressure: "normal", freePct: 40 }, runners: [], volumes: [{ label: "Data", totalBytes: 100, freeBytes: free }] });
    const runners = (state: string) => ({ at, stale: false, runs: [], prs: [], sources: { runs: { failed: [] }, prs: { failed: [] }, runners: { failed: [] } }, runners: { runners: [{ name: "runner-1", status: state }] } });
    const read = (extra: Record<string, unknown>) => ({ view: view({ now: at, bridge: { connected: true }, ...extra } as Partial<OpsResponse>), schedules: null });
    const waiting = (kind: OpsStatus["kind"], key: string) => status({ kind, key, state: "backlog", askedForTimeAt: SINCE, why: "queue full" });
    const disk = waiting("disk", opsStatusKey("disk", "Data"));
    expect(backlogGreen(disk, read({ mac: mac(50) }))).toBe(true);
    expect(backlogGreen(waiting("machine", "mac"), read({ mac: mac(50) }))).toBe(true);
    expect(backlogGreen(waiting("runner", opsStatusKey("runner", "runner-1")), read({ github: runners("online") }))).toBe(true);
    // Still red, a reading from before the record began (still current: the Mac's limit is 5 minutes), or none.
    expect(backlogGreen(disk, read({ mac: mac(1) }))).toBe(false);
    expect(backlogGreen({ ...disk, since: at }, read({ mac: mac(50, "2026-10-05T07:59:00.000Z") }))).toBe(false);
    expect(backlogGreen(disk, read({}))).toBe(false);
    expect(backlogGreen(waiting("runner", opsStatusKey("runner", "runner-1")), read({ github: runners("offline") }))).toBe(false);
    // A record a chat is on is the fix-result pass's, not this one's.
    expect(backlogGreen({ ...disk, state: "investigating" }, read({ mac: mac(50) }))).toBe(false);
  });

  it("ends a pick-up waiting on a time only on a green read since the record began, for an app or a PR", () => {
    const waiting = status({ state: "backlog", askedForTimeAt: SINCE });
    const app = (at: string, fly: unknown = null, flyAt: string | null = null) =>
      ({ view: view({ flyAt, apps: [{ id: "tasks-app", name: "Tasks App", app: "tasks-app", health: health("up", at), fly }] as OpsResponse["apps"] }), schedules: null });
    expect(backlogGreen(waiting, app(NOW.toISOString()))).toBe(true);
    // A health check, or a Fly reading, from before the record began cannot say.
    expect(backlogGreen(waiting, app("2026-10-05T07:30:00.000Z"))).toBe(false);
    const flown = { lastRelease: { status: "complete" }, machines: [] };
    expect(backlogGreen(waiting, app(NOW.toISOString(), flown, "2026-10-05T07:30:00.000Z"))).toBe(false);
    expect(backlogGreen(waiting, app(NOW.toISOString(), flown, NOW.toISOString()))).toBe(true);
    // An app with no check has no health check time: its Fly reading since the record began says.
    const unchecked = (fly: unknown, flyAt: string | null) =>
      ({ view: view({ flyAt, apps: [{ id: "tasks-app", name: "Tasks App", app: "tasks-app", health: { ...health("up"), state: "no-check", checkedAt: null }, fly }] as OpsResponse["apps"] }), schedules: null });
    expect(backlogGreen(waiting, unchecked(flown, NOW.toISOString()))).toBe(true);
    expect(backlogGreen(waiting, unchecked(flown, "2026-10-05T07:30:00.000Z"))).toBe(false);
    expect(backlogGreen(waiting, unchecked(null, NOW.toISOString()))).toBe(false);
    // Still down, a record a chat is on, or a kind with no green reading: not this pass's.
    expect(backlogGreen(waiting, { view: view(), schedules: null })).toBe(false);
    expect(backlogGreen(status({}), app(NOW.toISOString()))).toBe(false);
    expect(backlogGreen(status({ kind: "machine", key: "mac", state: "backlog", askedForTimeAt: SINCE }), { view: view(), schedules: null })).toBe(false);
    const prs = (at: string) => ({ view: view({ github: { at, stale: false, runs: [], prs: [pr("pass")], sources: { runs: { failed: [] }, prs: { failed: [] } } } as unknown as OpsResponse["github"] }), schedules: null });
    const red = status({ kind: "pr", key: "177", state: "backlog", askedForTimeAt: SINCE });
    expect(backlogGreen(red, prs(NOW.toISOString()))).toBe(true);
    expect(backlogGreen(red, prs("2026-10-05T07:30:00.000Z"))).toBe(false);
  });

  it("reads a ci item's runs as the Ops mark does: one-offs dropped, only a push's green clears a push's red", () => {
    const github = (runs: WorkflowRun[]) => ({ view: view({ github: { stale: false, runs, prs: [], sources: { runs: { failed: [] }, prs: { failed: [] } } } as unknown as OpsResponse["github"] }), schedules: null });
    const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
    const as = (one: WorkflowRun, extra: Partial<WorkflowRun>) => ({ ...one, ...extra }) as WorkflowRun;
    const ci = status({ kind: "ci", key: "ci_0zh2u01" });
    // A dispatched CI's green over a push's red: main's push is still red.
    expect(itemGreen(ci, github([run("failure", at(0)), as(run("success", at(1)), { event: "workflow_dispatch" })]))).toBe(false);
    expect(itemGreen(ci, github([run("success", at(0)), as(run("success", at(1)), { event: "workflow_dispatch" })]))).toBe(true);
    expect(itemGreen(ci, github([as(run("success", at(1)), { event: "workflow_dispatch" })]))).toBeNull();
    expect(itemGreen(ci, github([run("success", at(0)), as(run("failure", at(1)), { event: "workflow_dispatch" })]))).toBe(false);
    // Another workflow's one-off neither clears its automatic red nor reads red over its automatic green.
    const lint = status({ kind: "ci", key: opsStatusKey("ci", "Lint", "example-org/example-repo") });
    const linted = (conclusion: string, extra: Partial<WorkflowRun> = {}) => as(run(conclusion, extra.createdAt ?? at(0)), { workflow: "Lint", ...extra });
    expect(itemGreen(lint, github([linted("failure"), linted("success", { createdAt: at(1), event: "workflow_dispatch" })]))).toBe(false);
    expect(itemGreen(lint, github([linted("success"), linted("failure", { createdAt: at(1), event: "workflow_dispatch" })]))).toBe(true);
    expect(itemGreen(lint, github([linted("failure", { event: "workflow_dispatch" })]))).toBeNull();
    // The nightly schedule skips the secret scan as a dispatch does: no push's stand-in.
    const nightly = as(run("success", at(1)), { event: "schedule" });
    expect(itemGreen(ci, github([run("failure", at(0)), nightly]))).toBe(false);
    expect(itemGreen(ci, github([run("failure", at(0)), nightly, as(run("success", at(2)), { event: "workflow_dispatch" })]))).toBe(false);
    expect(itemGreen(ci, github([run("success", at(0)), nightly]))).toBe(true);
    // A push's red retained under a dispatch's green from before the record is still red, not "cannot say".
    expect(itemGreen(status({ kind: "ci", key: "ci_0zh2u01", since: at(10) }), github([run("failure", at(0)), as(run("success", at(5)), { event: "workflow_dispatch" })]))).toBe(false);
    // A green from before the failure began, the latest finished while the red run is rerun, cannot say.
    expect(itemGreen(ci, github([run("success", SINCE), as(run("failure", at(0)), { status: "in_progress", conclusion: null })]))).toBeNull();
  });

  it("reads a schedule's newest finished run, not lastRun alone", () => {
    const sched = status({ kind: "schedule", key: "nightly" });
    const item = (lastRun: object, runs?: object[]) => [{ id: "nightly", name: "Nightly sweep", lastRun, ...(runs ? { runs } : {}) }] as never;
    // The newest created passed, then a rerun of an older one failed after it: failing, as failingStreak reads it.
    const rerun = item({ at: "2026-10-05T07:50:00.000Z", result: "ok" }, [
      { id: "2", at: "2026-10-05T07:50:00.000Z", result: "ok" },
      { id: "1", at: "2026-10-05T07:55:00.000Z", result: "failed" },
    ]);
    expect(itemGreen(sched, { view: view(), schedules: rerun })).toBe(false);
    // A pass under a running one reads green.
    expect(itemGreen(sched, { view: view(), schedules: item({ at: null, result: "running" }, [{ id: "1", at: NOW.toISOString(), result: "ok" }]) })).toBe(true);
    expect(itemGreen(sched, { view: view(), schedules: item({ at: null, result: "running" }) })).toBeNull();
    // The failed run is rerun: it leaves the finished runs while it runs, and the pass before the failure cannot say.
    expect(itemGreen(sched, { view: view(), schedules: item({ at: null, result: "running" }, [{ id: "0", at: "2026-10-05T07:00:00.000Z", result: "ok" }]) })).toBeNull();
  });

  it("titles the card from the item's name and the record's last note, in the fix chat's thread, one id per failure", () => {
    const up = view({ apps: [{ id: "tasks-app", name: "Tasks App", health: health("up"), fly: null }] as OpsResponse["apps"] });
    const card = fixCard(status({ note: "Machine restarted, health check OK\nmore detail", chat: "fix-app-tasks-app" }), { view: up, schedules: null });
    expect(card).toEqual({ id: expect.stringMatching(/^fix-app-tasks-app-[0-9a-f]{12}$/), title: "Tasks App back up: Machine restarted, health check OK", tag: "Fixed", chat: "fix-app-tasks-app" });
    expect(fixCard(status({ kind: "pr", key: "177" }), { view: up, schedules: null })).toMatchObject({ title: "#177 checks pass", pr: 177 });
    // Two long keys sharing their first 40 characters, or one key failing twice, never share a card.
    const long = "a".repeat(50);
    const ids = [status({ key: `${long}x` }), status({ key: `${long}y` }), status({ since: NOW.toISOString() })].map((one) => fixCard(one, { view: up, schedules: null }).id);
    expect(new Set([...ids, card.id]).size).toBe(4);
    // Red main in another repo: its card carries that repo, so a reply reaches its fix chat there.
    const other = { ...run("success", SINCE), repo: "example-org/other-repo" } as WorkflowRun;
    expect(fixCard(status({ kind: "ci", key: "other-repo/ci" }), { view: view({ github: { runs: [other], prs: [] } as never }), schedules: null })).toMatchObject({ repo: "example-org/other-repo" });
    expect(fixCard(status({ kind: "pr", key: "other-repo/88" }), { view: up, schedules: null })).toMatchObject({ pr: 88, repo: "example-org/other-repo" });
    // Any other record carries its fix chat's repo, so the card opens that repo's conversation.
    expect(fixCard(status({ chat: "fix-app-tasks-app", repo: "example-org/other-repo" }), { view: up, schedules: null })).toMatchObject({ chat: "fix-app-tasks-app", repo: "example-org/other-repo" });
    expect(fixCard(status({ chat: "fix-app-tasks-app", repo: "example-org/example-repo" }), { view: up, schedules: null })).not.toHaveProperty("repo");
  });

  it("posts nothing for an automatic handler's record: its result is in the handlers' log", () => {
    const seen = new Set<string>();
    const red = { view: view(), schedules: null };
    const green = { view: view({ apps: [{ id: "tasks-app", name: "Tasks App", health: health("up"), fly: null }] as OpsResponse["apps"] }), schedules: null };
    const mine = status({ by: HANDLER_BY });
    expect(fixResults([mine], red, NOW, seen)).toEqual([]);
    expect(fixResults([mine], green, NOW, seen)).toEqual([]);
    expect(fixResults([{ ...mine, state: "fixed", updatedAt: NOW.toISOString() }], green, NOW, seen)).toEqual([]);
    expect(seen.size).toBe(0);
  });

  it("acts on an item only once it was read red and then green, and on a record set fixed within the window", () => {
    const seen = new Set<string>();
    const red = { view: view(), schedules: null };
    const green = { view: view({ apps: [{ id: "tasks-app", name: "Tasks App", health: health("up"), fly: null }] as OpsResponse["apps"] }), schedules: null };
    // Green with no red seen first: an old record for something that recovered long ago posts nothing.
    expect(fixResults([status({})], green, NOW, seen)).toEqual([]);
    expect(fixResults([status({})], red, NOW, seen)).toEqual([]);
    expect(fixResults([status({})], green, NOW, seen)).toEqual([{ status: status({}), green: true }]);
    const fixed = status({ state: "fixed", updatedAt: NOW.toISOString() });
    expect(fixResults([fixed], green, NOW, seen)).toEqual([{ status: fixed, green: false }]);
    expect(fixResults([fixed], green, new Date(NOW.getTime() + FIX_RESULT_WINDOW_MS + 1), seen)).toEqual([]);
    // Set fixed while the item still reads red: no "back up" card yet.
    expect(fixResults([fixed], red, NOW, seen)).toEqual([]);
    // A record gone from the store is forgotten.
    expect(seen.size).toBe(0);
  });

  it("on the server: sets the record fixed and posts the card once when the app comes back up, across a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "rivet-fix-"));
    const store = new Store(dir);
    const clock = NOW;
    const cards: Record<string, unknown>[] = [];
    let full = false;
    const make = () => createOps({
      dataDir: dir,
      store,
      bridge: { status: () => ({ connected: true }) as never },
      push: { notify: async () => ({}) as never, flushHeld: async () => null, onDigestSettled: () => () => {}, onDigestRelease: () => () => {}, onDigestReword: () => () => {} } as never,
      checks: [{ name: "tasks-app", url: "https://tasks-app.example/health" }],
      fetch: (async () => new Response("")) as typeof fetch,
      now: () => clock,
      logger: { error: () => {} },
      addUpdate: (card) => {
        if (full) return { status: 507, error: "the board is full" };
        if (cards.some((one) => one.id === card.id)) return { status: 409, error: "exists" };
        cards.push(card);
        return { status: 200 };
      },
    });
    store.addOpsStatus(status({ chat: "fix-app-tasks-app", note: "Machine restarted, health check OK", version: store.nextOpsStatusVersion() }));
    const first = make();
    first.store.put("health", { "tasks-app": health("down") }, clock);
    first.settleFixes();
    expect(cards).toEqual([]);
    first.close();
    // Restarted: the red reading is remembered, and a refused card leaves the record under way to try again.
    const ops = make();
    ops.store.put("health", { "tasks-app": health("up") }, clock);
    full = true;
    ops.settleFixes();
    expect(cards).toEqual([]);
    expect(store.getOpsStatus("app", "tasks-app")).toMatchObject({ state: "investigating" });
    full = false;
    ops.settleFixes();
    ops.settleFixes();
    expect(cards).toEqual([{ id: expect.stringMatching(/^fix-app-tasks-app-[0-9a-f]{12}$/), title: "tasks-app back up: Machine restarted, health check OK", tag: "Fixed", chat: "fix-app-tasks-app" }]);
    expect(store.getOpsStatus("app", "tasks-app")).toMatchObject({ state: "fixed", by: "Rivet", since: SINCE });
    ops.close();
  });
});
