// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jobScheduleKey, type Job, type JobsResponse } from "../src/shared/jobs.js";
import { opsStatusKey } from "../src/shared/ops-status-key.js";
import type { OpsResponse } from "../src/shared/ops.js";
import { opsData, resetOps } from "../web/src/ops-data.js";
import { app, subscribe } from "../web/src/state.js";
import * as ops from "../web/src/views/ops.js";
import { jobsApi, loadJobs, openRedJobs, redJobsEl, resetScheduled } from "../web/src/views/scheduled.js";
import { closeSheet } from "../web/src/views/sheet.js";
import { statusParts } from "../web/src/views/status-line.js";

// 9:00am Saturday 24 Oct 2026 local time.
const NOW = "2026-10-23T22:00:00.000Z";

function job(extra: Partial<Job> = {}): Job {
  return {
    id: "j-aaaaaaaa",
    name: "Notes app up",
    words: "every morning check Notes app is up",
    kind: "check",
    check: { probe: "up", app: "notes-app", where: "mac", onRed: "card" },
    when: { every: "day", at: "07:00" },
    cards: "red",
    state: "active",
    createdAt: "2026-10-20T00:00:00.000Z",
    activeSince: "2026-10-20T00:00:00.000Z",
    whenText: "Daily 7:00am",
    nextRun: "2026-10-24T20:00:00.000Z",
    lastRun: { id: "r-00000001", at: "2026-10-23T20:00:00.000Z", finishedAt: "2026-10-23T20:04:00.000Z", result: "green", line: "notes-app is up: https://notes.example.com/healthz answered 200." },
    runs: [],
    redStreak: 0,
    owned: false,
    ...extra,
  };
}

const view = (jobs: Job[]): JobsResponse => ({ at: NOW, jobs, limits: { active: jobs.filter((one) => one.state === "active").length, maxActive: 10, tasksToday: 1, maxTasksToday: 6 } });

let root: HTMLElement;
let calls: { method: string; url: string; body: unknown }[];

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit = {}) => {
      calls.push({ method: init.method ?? "GET", url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Promise(() => {});
    }),
  );
  root = document.createElement("div");
  document.body.replaceChildren(root);
  opsData.ops = { now: NOW, summary: { needs: 0, redCi: 0, failingSchedules: 0, appsDown: 0 }, apps: [] } as unknown as OpsResponse;
  app.tab = "progress";
});

afterEach(() => {
  stop();
  closeSheet();
  resetScheduled();
  resetOps();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// The red jobs sheet's body, redrawn on every change as the sheet's is.
let stop = () => {};
const mountJobs = () => {
  stop();
  const paint = () => root.replaceChildren(redJobsEl());
  stop = subscribe(paint);
  paint();
};
const redraw = mountJobs;
const redRun = { id: "r-00000002", at: "2026-10-23T20:00:00.000Z", result: "red" as const, line: "down" };
const rowRed = () => root.querySelector("[data-job] .ops-dot.t-bad") !== null;
const rows = () => [...root.querySelectorAll<HTMLElement>("[data-job]")];
const buttonIn = (el: Element, label: string) => [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;

describe("the red jobs sheet", () => {
  it("lists only the red jobs, with your words and local times, and the status line's part opens it", () => {
    const red = job({ id: "j-bbbbbbbb", name: "Open issues", kind: "task", check: undefined, words: "look over the open issues", whenText: "Mondays 9:00am", redStreak: 2, lastRun: { id: "r-00000002", at: "2026-10-23T20:00:00.000Z", result: "missed" } });
    resetScheduled(view([job(), red, job({ id: "j-cccccccc", name: "Typecheck", state: "paused", check: { script: "typecheck", where: "mac", onRed: "card" } })]));
    mountJobs();
    expect(rows().map((row) => row.dataset.job)).toEqual(["j-bbbbbbbb"]);
    expect(rows()[0]!.textContent).toContain("Last: Missed 7:00am (2 in a row)");
    expect(rows()[0]!.textContent).toContain("“look over the open issues”");
    expect(rows()[0]!.textContent).toContain("Mondays 9:00am · a chat · card only if red");
    expect(buttonIn(rows()[0]!, "Delete").className).toBe("btn ghost");
    const part = statusParts().find((one) => one.key === "jobs")!;
    expect(part.text).toBe("1 job red");
    part.open();
    const sheet = document.querySelector<HTMLElement>(".sheet")!;
    expect(sheet.getAttribute("aria-label")).toBe("Red jobs");
    expect([...sheet.querySelectorAll<HTMLElement>("[data-job]")].map((row) => row.dataset.job)).toEqual(["j-bbbbbbbb"]);
  });

  it("says a failed read of the jobs in plain words, never the server's", async () => {
    const get = vi.spyOn(jobsApi, "get").mockRejectedValue(new Error("Request failed (500)"));
    await loadJobs();
    mountJobs();
    expect(root.textContent).toBe("Couldn't read the jobs.");
    get.mockResolvedValueOnce(view([job({ redStreak: 1, lastRun: redRun })]));
    await loadJobs();
    await loadJobs();
    expect(root.querySelector(".jobs-limits")!.textContent).toBe("Couldn't read the jobs again.");
    get.mockRestore();
  });

  it("opens from a search hit or a Plan row for the jobs, as the status line's does", () => {
    resetScheduled(view([job({ redStreak: 1, lastRun: redRun })]));
    ops.focusSection("jobs");
    expect(document.querySelector(".sheet")?.getAttribute("aria-label")).toBe("Red jobs");
  });

  it("believes the server on a parked job: one it reads as nobody's stays red, one it reads as owned amber", () => {
    const red = (owned: boolean) => job({ redStreak: 1, owned, lastRun: { id: "r-00000002", at: "2026-10-23T20:00:00.000Z", result: "red", line: "down" } });
    const at = "2026-10-23T19:00:00.000Z";
    opsData.statuses = [{ kind: "schedule", key: opsStatusKey("schedule", jobScheduleKey(red(false).id)), state: "parked", note: "leave it", since: at, updatedAt: at, version: 1 }];
    opsData.statusesLoaded = true;
    resetScheduled(view([red(false)]));
    mountJobs();
    expect(statusParts().find((part) => part.key === "jobs")).toMatchObject({ text: "1 job red", tone: "bad" });
    expect(rows()[0]!.querySelector(".job-last")!.textContent).not.toContain("an agent is on it");
    resetScheduled(view([red(true)]));
    expect(statusParts().find((part) => part.key === "jobs")).toMatchObject({ text: "1 job red · agents on it", tone: "warn" });
    opsData.statuses = [];
  });

  it("shows a red job someone is on amber, on its row and the status line", () => {
    const red = (owned: boolean) => job({ redStreak: 1, owned, lastRun: { id: "r-00000002", at: "2026-10-23T20:00:00.000Z", result: "red", line: "down" } });
    resetScheduled(view([red(true)]));
    mountJobs();
    expect(statusParts().find((part) => part.key === "jobs")).toMatchObject({ text: "1 job red · agents on it", tone: "warn" });
    expect(rows()[0]!.querySelectorAll(".t-bad")).toHaveLength(0);
    expect(rows()[0]!.querySelector(".ops-dot.t-warn")).not.toBeNull();
    expect(rows()[0]!.querySelector(".job-last.t-warn")!.textContent).toContain("· an agent is on it");
    expect(buttonIn(rows()[0]!, "Dismiss")).toBeUndefined();
    resetScheduled(view([red(false)]));
    expect(statusParts().find((part) => part.key === "jobs")).toMatchObject({ text: "1 job red", tone: "bad" });
    redraw();
    expect(rowRed()).toBe(true);
  });

  it("dismisses a red job nobody is on, which leaves the pill, the mark and the status line until a new red streak, and brings it back", async () => {
    opsData.statuses = [];
    opsData.statusesLoaded = true;
    const red = (since: string) => job({ redStreak: 1, redSince: since, lastRun: { id: "r-00000002", at: since, result: "red", line: "down" } });
    resetScheduled(view([red("2026-10-23T20:00:00.000Z")]));
    mountJobs();
    buttonIn(rows()[0]!, "Dismiss").click();
    await vi.waitFor(() => expect(calls.find((call) => call.method === "PUT")?.url).toBe(`/api/ops/dismissals/schedule/${encodeURIComponent(opsStatusKey("schedule", jobScheduleKey("j-aaaaaaaa")))}`));
    redraw();
    expect(rows()[0]!.querySelectorAll(".t-bad")).toHaveLength(0);
    expect(rows()[0]!.querySelector(".job-last")!.textContent).toContain("· dismissed");
    expect(statusParts().some((part) => part.key === "jobs")).toBe(false);
    expect(rowRed()).toBe(false);
    // A new red streak is a new mark: red again, with its Dismiss.
    resetScheduled(view([red("2026-10-24T20:00:00.000Z")]));
    redraw();
    expect(rowRed()).toBe(true);
    expect(buttonIn(rows()[0]!, "Dismiss")).toBeDefined();
    // Bring back undoes a Dismiss of the same streak.
    resetScheduled(view([red("2026-10-23T20:00:00.000Z")]));
    redraw();
    buttonIn(rows()[0]!, "Bring back").click();
    redraw();
    expect(rowRed()).toBe(true);
  });

  it("offers no Dismiss until the list of statuses has loaded, as who is on a job is unknown before then", () => {
    const red = job({ redStreak: 1, lastRun: { id: "r-00000002", at: "2026-10-23T20:00:00.000Z", result: "red", line: "down" } });
    resetScheduled(view([red]));
    mountJobs();
    expect(buttonIn(rows()[0]!, "Dismiss")).toBeUndefined();
    expect(rowRed()).toBe(true);
    opsData.statuses = [];
    opsData.statusesLoaded = true;
    resetScheduled(view([red]));
    redraw();
    expect(buttonIn(rows()[0]!, "Dismiss")).toBeDefined();
    expect(rowRed()).toBe(true);
  });

  it("asks once before a pause or a delete, and runs at once", () => {
    resetScheduled(view([job({ redStreak: 1, lastRun: redRun }), job({ id: "j-dddddddd", name: "Zed check", redStreak: 1, lastRun: redRun })]));
    mountJobs();
    buttonIn(rows()[0]!, "Pause").click();
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
    expect(document.body.textContent).toContain("Pause Notes app up?");
    buttonIn(document.body, "Pause it").click();
    expect(rows()[0]!.textContent).toContain("Pausing…");
    expect(buttonIn(rows()[0]!, "Run now").disabled).toBe(true);
    buttonIn(rows()[1]!, "Run now").click();
    const writes = calls.filter((call) => call.method !== "GET");
    expect(writes.map((call) => [call.method, call.url, (call.body as { op?: string }).op])).toEqual([
      ["PATCH", "/api/jobs/j-aaaaaaaa", "pause"],
      ["PATCH", "/api/jobs/j-dddddddd", "run"],
    ]);
    expect(rows()[1]!.textContent).toContain("Starting…");
  });

  it("returns to Red jobs after a confirm, where a Delete the Mac could not take says so", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit = {}) => {
        if (init.method === "DELETE") return Promise.resolve(new Response(JSON.stringify({ error: "offline" }), { status: 503, headers: { "content-type": "application/json" } }));
        return new Promise(() => {});
      }),
    );
    resetScheduled(view([job({ redStreak: 1, lastRun: redRun })]));
    openRedJobs();
    const sheetRow = () => document.querySelector<HTMLElement>(".sheet [data-job]")!;
    buttonIn(sheetRow(), "Delete").click();
    buttonIn(document.body, "Delete it").click();
    expect(document.querySelector(".sheet")?.getAttribute("aria-label")).toBe("Red jobs");
    await vi.waitFor(() => expect(sheetRow().querySelector(".job-status.bad")?.textContent).toBe("The Mac is offline. Try again when the bridge is back."));
  });

  it("redraws the sheet's row on a Dismiss and a Bring back, with no other change", async () => {
    opsData.statuses = [];
    opsData.statusesLoaded = true;
    resetScheduled(view([job({ redStreak: 1, redSince: "2026-10-23T20:00:00.000Z", lastRun: { id: "r-00000002", at: "2026-10-23T20:00:00.000Z", result: "red", line: "down" } })]));
    openRedJobs();
    const sheetRow = () => document.querySelector<HTMLElement>(".sheet [data-job]")!;
    buttonIn(sheetRow(), "Dismiss").click();
    await vi.waitFor(() => expect(sheetRow().querySelector(".job-last")!.textContent).toContain("· dismissed"));
    buttonIn(sheetRow(), "Bring back").click();
    await vi.waitFor(() => expect(buttonIn(sheetRow(), "Dismiss")).toBeDefined());
  });

  it("has a way in from Machines, where the status line is hidden", () => {
    resetScheduled(view([job({ redStreak: 1, lastRun: redRun })]));
    // Machines draws once Ops has a reading (reading.ts); the red jobs are their own read.
    opsData.ops = { ...opsData.ops!, bridge: { connected: true } } as OpsResponse;
    app.opsPage = "machines";
    ops.mount(root);
    const open = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "1 job red ›")!;
    expect(open.dataset.use).toBe("jobs.red.open");
    open.click();
    expect(document.querySelector(".sheet")?.getAttribute("aria-label")).toBe("Red jobs");
    ops.unmount();
  });

  it("keeps the way in on Machines while Ops has no reading, read or failed", () => {
    resetScheduled(view([job({ redStreak: 1, lastRun: redRun })]));
    opsData.ops = null;
    app.opsPage = "machines";
    for (const error of [null, "Request failed (500)"]) {
      opsData.error = error;
      ops.mount(root);
      expect(root.querySelector(error ? ".reading.is-failed" : ".reading.is-pending")).not.toBeNull();
      const open = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "1 job red ›")!;
      expect(open.dataset.use).toBe("jobs.red.open");
      ops.unmount();
    }
    opsData.error = null;
  });

  it("shows a red job's failed Delete with its reason", () => {
    resetScheduled(view([job({ redStreak: 1, lastRun: redRun, note: "Delete did not go through: launchctl refused it. Try again." })]));
    mountJobs();
    expect(rows()[0]!.querySelector(".job-status.bad")!.textContent).toBe("Delete did not go through: launchctl refused it. Try again.");
  });

  it("says when none is red", () => {
    resetScheduled(view([job()]));
    mountJobs();
    expect(root.textContent).toContain("No job is red now.");
    expect(statusParts().some((part) => part.key === "jobs")).toBe(false);
  });
});
