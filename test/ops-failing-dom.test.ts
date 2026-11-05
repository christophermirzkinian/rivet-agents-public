// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpsResponse } from "../src/shared/ops.js";
import { opsData } from "../web/src/ops-data.js";
import { app } from "../web/src/state.js";
import { clearWords, opsStatus } from "../web/src/views/progress-mark.js";
import * as ops from "../web/src/views/ops.js";

const NOW = "2026-10-02T03:00:00.000Z";
/** A push two hours old: its red counts. */
const PUSHED = "2026-10-02T01:00:00.000Z";

function opsFixture(redCi: number, failingSchedules: number, failingPrs = 0, youngPrs = 0, runs: unknown[] = []): OpsResponse {
  const pr = (number: number, state: "fail" | "pass", headAt = PUSHED) => ({
    repo: "example-org/example-repo", number, title: `PR ${number}`, url: `https://github.com/x/pull/${number}`, draft: false, author: "mirz", labels: [],
    headAt, updatedAt: NOW, checks: { state, passed: 1, failed: state === "fail" ? 1 : 0, pending: 0, failing: state === "fail" ? ["lint"] : [] },
  });
  return {
    now: NOW,
    bridge: { connected: true },
    github: { at: NOW, prs: [...Array.from({ length: failingPrs }, (_, i) => pr(100 + i, "fail")), ...Array.from({ length: youngPrs }, (_, i) => pr(200 + i, "fail", "2026-10-02T02:30:00.000Z")), pr(99, "pass")], runs, runners: null, queue: null, merged: null, sources: null, stale: false },
    mac: { at: NOW, stale: false, name: "This Mac", volumes: [], load: { one: 1, five: 1, fifteen: 1, cpus: 8 }, memory: { freePct: 40, pressure: "normal" }, uptimeSec: 3600, runners: [], chatRunner: true },
    claude: null,
    flyAt: null,
    flyStale: false,
    flySource: null,
    healthStaleSince: null,
    apps: [],
    summary: { needs: 0, redCi, failingSchedules, appsDown: 0, disk: { freePct: 41, tone: "ok" } },
  } as unknown as OpsResponse;
}

let root: HTMLElement;
/** The breaks the open page reads, as [kind, title, line]: what Plan lists under Being done. */
const wrong = () => ops.wrongRows(opsData.ops, app.opsPage).rows.map((row) => [row.kind, row.title, row.line]);
/** The rows that light Machines' pill, as [kind, name, line]. */
const machineRows = () => ops.wrongRows(opsData.ops, "machines").rows.map((row) => [row.kind, row.title, row.line]);
const show = (redCi: number, failing: number, failingPrs = 0, youngPrs = 0, runs: unknown[] = []) => {
  opsData.ops = opsFixture(redCi, failing, failingPrs, youngPrs, runs);
  ops.unmount();
  ops.mount(root);
};

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ entries: [] }), { headers: { "content-type": "application/json" } }))));
  root = document.createElement("div");
  document.body.replaceChildren(root);
  opsData.at = Date.now();
  opsData.opsAt = { mono: performance.now(), wall: Date.now() };
  app.tab = "progress";
  app.opsPage = "code";
});

afterEach(() => {
  ops.unmount();
  opsData.ops = null;
  opsData.at = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("The breaks Plan lists under Being done", () => {
  it("lists red on main the snapshot lacks and failing schedules as rows, the schedules row opening Schedules", () => {
    show(1, 0);
    expect(wrong()).toEqual([["ci", "1 red on main", "Workflow runs the snapshot lacks"]]);

    show(1, 1);
    expect(wrong()).toEqual([
      ["ci", "1 red on main", "Workflow runs the snapshot lacks"],
      ["schedule", "1 schedule failing", "Timed jobs, on Ops Machines"],
    ]);

    show(0, 1);
    expect(wrong()).toEqual([["schedule", "1 schedule failing", "Timed jobs, on Ops Machines"]]);
  });

  it("lists open PRs whose checks fail, three then the rest, so a green main never reads all clear above failing PRs", () => {
    show(0, 0, 7);
    expect(wrong()).toEqual([
      ["pr", "#100 PR 100", "1 check failed: lint"],
      ["pr", "#101 PR 101", "1 check failed: lint"],
      ["pr", "#102 PR 102", "1 check failed: lint"],
      ["pr", "4 more red PRs", null],
    ]);

    show(0, 0, 1);
    expect(wrong()).toEqual([["pr", "#100 PR 100", "1 check failed: lint"]]);

    show(2, 0, 3);
    expect(wrong().map((row) => row[0])).toEqual(["ci", "pr", "pr", "pr"]);

    show(0, 1, 4);
    expect(wrong().map((row) => row[0])).toEqual(["pr", "pr", "pr", "pr", "schedule"]);
  });

  it("leaves a PR red for under an hour and a one-off run's red off Plan: Rivet is on nothing", () => {
    const oneOff = { repo: "example-org/example-repo", id: 7, attempt: 1, workflow: "Integration tests (base)", title: "base", status: "completed", conclusion: "failure", event: "workflow_dispatch", sha: "a".repeat(40), url: "https://github.com/x/actions/runs/7", createdAt: PUSHED, updatedAt: PUSHED };
    show(0, 0, 0, 2, [oneOff]);
    expect(wrong()).toEqual([]);
    expect(opsStatus().mark).toMatchObject({ dot: null, line: null, owned: null });
    expect(clearWords().mood).toBe("happy");
    // Both still show on Code: the PRs under Pull requests, the run under Main and CI.
    expect(root.textContent).toContain("2 failing");
    expect(root.textContent).toContain("1 one-off run red");
    // An hour on, the same push's red counts.
    show(0, 0, 1, 1, [oneOff]);
    expect(wrong()).toEqual([["pr", "#100 PR 100", "1 check failed: lint"]]);
    // Rivet's job, not a mark and no ask of your: no "Rivet on N" line (plan §3f), and he stays happy.
    expect(opsStatus().mark).toMatchObject({ dot: null, line: null, owned: null });
    expect(clearWords().mood).toBe("happy");
  });

  it("never reads All clear when the PRs could not be read", () => {
    show(0, 0);
    opsData.ops = {
      ...opsFixture(0, 0),
      github: { at: NOW, prs: [], runs: [], runners: null, queue: null, merged: null, stale: false, sources: { prs: { failed: ["example-repo"], at: null }, runs: { failed: [], at: NOW }, merged: { failed: [], at: NOW }, runners: { failed: [], at: NOW }, queue: { failed: [], at: NOW } } },
    } as unknown as OpsResponse;
    ops.unmount();
    ops.mount(root);
    expect(wrong()).toEqual([]);
    expect(root.textContent).not.toContain("All clear");
    expect(root.querySelector(".ops-notices")!.textContent).toContain("GitHub unreachable for pull requests (example-repo)");
    // The PRs are Code's reading: Machines, which reads GitHub's runners, does not say it.
    ops.unmount();
    app.tab = "progress";
    app.opsPage = "machines";
    ops.mount(root);
    expect(root.querySelector(".ops-notices")?.textContent ?? "").not.toContain("pull requests");
  });

  it("drops red CI from a failed or old runs source, and then lists every failing schedule", () => {
    // A source that answered sends no time of its own, as the bridge's collector does.
    const fine = { failed: [], at: null };
    const runs = (state: { failed: string[]; at: string | null }, failingSchedulesAll = 1, at = NOW) => {
      const base = opsFixture(1, 0);
      opsData.ops = {
        ...base,
        github: { ...base.github!, at, sources: { prs: fine, runs: state, merged: fine, runners: fine, queue: fine } },
        summary: { ...base.summary, failingSchedulesAll },
      } as unknown as OpsResponse;
      ops.unmount();
      ops.mount(root);
    };
    runs(fine);
    expect(wrong().map((row) => row[0])).toEqual(["ci"]);
    // The schedule the summary left out as red CI counts again once red CI is unknown.
    runs({ failed: ["example-repo"], at: NOW });
    expect(wrong()).toEqual([["schedule", "1 schedule failing", "Timed jobs, on Ops Machines"]]);
    runs(fine, 1, new Date(Date.parse(NOW) - 10 * 60_000).toISOString());
    expect(wrong().map((row) => row[0])).toEqual(["schedule"]);
    runs({ failed: ["example-repo"], at: null }, 0);
    expect(wrong()).toEqual([]);
    expect(root.querySelector(".ops-notices")!.textContent).toContain("GitHub unreachable for main runs (example-repo)");
  });

  it("lists no failing schedule from an old schedules reading, judged on the clock since Ops answered", () => {
    const schedulesAt = (at: string | null | undefined) => {
      const base = opsFixture(0, 1);
      opsData.ops = { ...base, summary: { ...base.summary, schedulesAt: at } } as OpsResponse;
      ops.unmount();
      ops.mount(root);
    };
    schedulesAt(NOW);
    expect(wrong().map((row) => row[0])).toEqual(["schedule"]);
    schedulesAt(new Date(Date.parse(NOW) - 4 * 60_000).toISOString());
    expect(wrong()).toEqual([]);
    schedulesAt(null);
    expect(wrong()).toEqual([]);
    // A cached answer ages: past the schedules' window it lists nothing, from a server with or without the time.
    opsData.opsAt = { mono: performance.now() - 4 * 60_000, wall: Date.now() };
    schedulesAt(NOW);
    expect(wrong()).toEqual([]);
    schedulesAt(undefined);
    expect(wrong()).toEqual([]);
  });
});

describe("Ops folds and quiet faults", () => {
  it("lists an app with no URL whose Fly checks fail as a break", () => {
    opsData.ops = {
      ...opsFixture(0, 0),
      apps: [{ id: "secret", name: "Secret App", app: "secret-app", health: { state: "no-check" }, fly: { status: "deployed", version: 3, sha: null, machines: { started: 1, total: 1 }, checks: { passing: 0, total: 1 }, updatedAt: NOW, lastRelease: { status: "complete", at: NOW } } }],
      flyAt: NOW,
      // Another app's Fly fetch failing leaves this one's reading current.
      flySource: { failed: ["other-app"], at: NOW },
    } as unknown as OpsResponse;
    app.tab = "progress";
    app.opsPage = "machines";
    ops.unmount();
    ops.mount(root);
    expect(wrong()).toEqual([["app", "Secret App", "Fly checks: 0 of 1 passing"]]);
    opsData.ops = { ...opsData.ops, flySource: { failed: ["secret-app"], at: NOW } } as unknown as OpsResponse;
    ops.unmount();
    ops.mount(root);
    // Fly unreachable for this app: its old reading is no fault, and no All clear either.
    expect(wrong()).toEqual([]);
    expect(root.querySelector(".ops-notices")!.textContent).toContain("Fly unreachable for secret-app");
  });

  it("lists an app with no URL that is awake with a failing Fly check, but not one with no machine started", () => {
    const sleeper = (started: number, total: number, passing: number, checks: number) => ({
      id: "paper-trail", name: "Paper Trail", app: "paper-trail", health: { state: "no-check" },
      fly: { status: "deployed", version: 3, sha: null, machines: { started, total }, checks: { passing, total: checks }, updatedAt: NOW, lastRelease: { status: "complete", at: NOW } },
    });
    const show = (g: ReturnType<typeof sleeper>) => {
      opsData.ops = { ...opsFixture(0, 0), apps: [g], flyAt: NOW } as unknown as OpsResponse;
      app.tab = "progress";
      app.opsPage = "machines";
      ops.unmount();
      ops.mount(root);
    };
    show(sleeper(1, 1, 0, 1));
    expect(wrong()).toEqual([["app", "Paper Trail", "Fly checks: 0 of 1 passing"]]);
    // Asleep: the stopped machine keeps a stale "warning" check, which is no fault.
    show(sleeper(0, 1, 0, 1));
    expect(wrong()).toEqual([]);
    // One awake and failing beside a stopped spare is amber too; one awake and passing is fine.
    show(sleeper(1, 2, 0, 2));
    expect(wrong()).toEqual([["app", "Paper Trail", "Fly checks: 0 of 2 passing"]]);
    show(sleeper(1, 1, 1, 1));
    expect(wrong()).toEqual([]);
  });

  it("drops only the PRs of a repo that could not be read: the other repos' red PRs stay on Plan", () => {
    const base = opsFixture(0, 0, 1);
    const other = { ...base.github!.prs[0]!, repo: "example-org/other-repo", number: 88, title: "PR 88" };
    const sources = { prs: { failed: ["other-repo"], at: null }, runs: { failed: [], at: NOW }, merged: { failed: [], at: NOW }, runners: { failed: [], at: NOW }, queue: { failed: [], at: NOW } };
    opsData.ops = { ...base, github: { ...base.github!, prs: [...base.github!.prs, other], sources } } as unknown as OpsResponse;
    ops.unmount();
    ops.mount(root);
    expect(wrong()).toEqual([["pr", "#100 PR 100", "1 check failed: lint"]]);
    expect(opsStatus().mark.owned).toBeNull();
    expect(root.querySelector(".ops-notices")!.textContent).toContain("GitHub unreachable for pull requests (other-repo)");
  });

  it("lists an offline runner as a Machines break, an empty pool as nothing, and a failed read as unknown", () => {
    const base = opsFixture(0, 0);
    const sources = { prs: { failed: [], at: NOW }, runs: { failed: [], at: NOW }, merged: { failed: [], at: NOW }, runners: { failed: [] as string[], at: NOW }, queue: { failed: [], at: NOW } };
    app.tab = "progress";
    app.opsPage = "machines";
    const pool = (runners: { name: string; status: string; busy: boolean }[], read = sources) => {
      opsData.ops = { ...base, github: { ...base.github!, sources: read, runners: { complete: true, online: 0, busy: 0, offline: runners.length, runners } } } as unknown as OpsResponse;
      ops.unmount();
      ops.mount(root);
    };
    pool([]);
    expect(machineRows()).toEqual([]);
    const down = [{ name: "example-runner-1", status: "offline", busy: false }];
    pool(down);
    expect(machineRows()).toEqual([["runner", "example-runner-1", "CI runner offline"]]);
    pool(down, { ...sources, runners: { failed: ["example-repo"], at: NOW } });
    expect(machineRows()).toEqual([]);
  });

  it("opens a folded section a search points at, even one he closed", () => {
    show(0, 0);
    ops.focusSection("timeline");
    const timeline = () => root.querySelector<HTMLDetailsElement>('[data-section="timeline"]')!;
    expect(timeline().open).toBe(true);
    timeline().open = false;
    timeline().dispatchEvent(new Event("toggle"));
    ops.unmount();
    ops.mount(root);
    expect(timeline().open).toBe(false);
    ops.focusSection("timeline");
    expect(timeline().open).toBe(true);
  });
});

describe("Ops folds remember taps only", () => {
  it("keeps a fold a search opened open across the redraw that follows, and an automatic open is not a tap", () => {
    show(0, 0);
    ops.focusSection("actions");
    const answers = () => root.querySelector<HTMLDetailsElement>('[data-section="actions"]')!;
    expect(answers().open).toBe(true);
    // The shell's mount redraws again at once, with nothing pending.
    ops.unmount();
    ops.mount(root);
    expect(answers().open).toBe(true);
    // A fold built open fires toggle with no change of state: that is not a tap, and a real tap still closes it.
    answers().dispatchEvent(new Event("toggle"));
    answers().open = false;
    answers().dispatchEvent(new Event("toggle"));
    ops.unmount();
    ops.mount(root);
    expect(answers().open).toBe(false);
  });
});
