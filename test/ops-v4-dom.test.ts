// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClaudeLimit, OpsResponse } from "../src/shared/ops.js";
import type { Schedule, SchedulesResponse } from "../src/shared/schedules.js";
import { opsData } from "../web/src/ops-data.js";
import { app } from "../web/src/state.js";
import * as ops from "../web/src/views/ops.js";
import { ownRows } from "../web/src/views/ops-plan.js";
import { scheduleLines } from "../web/src/views/schedules.js";

// Ops is one tab with pills, Machines lists the schedules read only, and every header carries Claude's week. It opens on
// Plan, the readings one tap down.

const NOW = "2026-10-11T01:00:00.000Z";
const limit = (kind: string, percent: number, resetsAt: string | null = null): ClaudeLimit =>
  ({ kind, label: `Account ${kind}`, percent, severity: "normal", resetsAt, active: false }) as ClaudeLimit;

function fixture(extra: Partial<Record<string, unknown>> = {}): OpsResponse {
  return {
    now: NOW,
    healthStaleSince: null,
    bridge: { connected: true },
    github: { at: NOW, stale: false, prs: [], runs: [] },
    claude: { at: NOW, stale: false, limits: [] },
    flyAt: NOW,
    flyStale: false,
    flySource: null,
    apps: [],
    summary: { needs: 0, redCi: 0, failingSchedules: 0, appsDown: 0, disk: { freePct: 41, tone: "ok" } },
    ...extra,
  } as unknown as OpsResponse;
}

let root: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  root = document.createElement("div");
  document.body.replaceChildren(root);
  opsData.opsAt = { mono: performance.now(), wall: Date.now() };
  app.tab = "progress";
});

afterEach(() => {
  ops.unmount();
  opsData.ops = null;
  opsData.statuses = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Ops's Plan", () => {
  it("lists an app down as Rivet's own, no time made up, with no Fix it or Investigate button", () => {
    const down = { id: "paper-trail", name: "Paper Trail", app: "paper-trail", health: { state: "down", status: 503, ms: null, checkedAt: NOW, since: NOW, fails: 3 }, fly: null };
    opsData.ops = fixture({ apps: [down], summary: { needs: 0, redCi: 0, failingSchedules: 0, appsDown: 1, disk: { freePct: 41, tone: "ok" } } });
    app.opsPage = "plan";
    ops.mount(root);
    expect(root.querySelector('[data-plan-group="doing"]')).toBeNull();
    expect(ownRows().map((row) => [row.title, row.dueAt, row.eta])).toEqual([["Paper Trail", null, null]]);
    expect(root.textContent).not.toMatch(/Fix it|Investigate/);
  });
});

describe("Ops's pages", () => {
  it("land an old Ops link on Plan, whatever page was open last", () => {
    opsData.ops = fixture();
    app.opsPage = "machines";
    ops.openOps();
    expect([app.tab, app.morePage, app.opsPage]).toEqual(["more", "floor", "plan"]);
  });

  it("start on Plan whatever page an older build stored", async () => {
    localStorage.setItem("rivet.ops.tab", "usage");
    vi.resetModules();
    const fresh = await import("../web/src/state.js");
    expect(fresh.app.opsPage).toBe("plan");
    localStorage.removeItem("rivet.ops.tab");
  });
});

describe("Machines' schedules", () => {
  it("are one line each, name · next run · last result, failing first, with no switch", () => {
    const at = "2026-10-11T00:30:00.000Z";
    const items = [
      { id: "mac:dev.rivet-agents.nightly", name: "Nightly", on: true, group: "daily", nextRun: "2026-10-11T09:00:00.000Z", lastRun: { result: "ok", at } },
      { id: "mac:dev.rivet-agents.scan", name: "Security scan", on: true, group: "daily", nextRun: null, lastRun: { result: "failed", at } },
      { id: "mac:dev.rivet-agents.old", name: "Old", on: false, group: "weekly", nextRun: null, lastRun: null },
      { id: "mac:idle", name: "Idle pass", on: true, group: "always-on", nextRun: null, lastRun: null },
    ] as unknown as Schedule[];
    const view: SchedulesResponse = { at: NOW, stale: false, items, sources: {} as SchedulesResponse["sources"] };
    expect(scheduleLines(view, Date.parse(NOW)).map((line) => [line.name, line.next, line.last, line.tone])).toEqual([
      ["Security scan", "No next run", "Failed 11:30am", "bad"],
      ["Idle pass", "Always on", "No run yet", "idle"],
      ["Nightly", "next 8:00pm", "OK 11:30am", "ok"],
      ["Old", "Off", "No run yet", "idle"],
    ]);
  });
});
