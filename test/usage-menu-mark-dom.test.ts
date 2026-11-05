// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClaudeLimit, OpsResponse } from "../src/shared/ops.js";
import type { OpsStatus } from "../src/shared/ops-status.js";
import { opsData } from "../web/src/ops-data.js";
import { app } from "../web/src/state.js";
import { menuList } from "../web/src/views/menu.js";
import { navMark } from "../web/src/views/progress-mark.js";
import { mountShell } from "../web/src/views/shell.js";
import { stubCanvas } from "./canvas-stub.js";
import { serveSummary } from "./summary-served.js";

// The ops mark, a dot on the phone's menu button and a badge on the menu's Machines row, is Plan's: amber "!" only
// while an ask has no time or has moved twice. Usage at 95%, red CI or a red PR mark nothing; their pages show them.

const NOW = "2026-10-07T05:00:00.000Z";
const accounts = (...pcts: number[]) =>
  pcts.map((pct, i) => ({ kind: `account_${i + 1}`, label: `Account a${i}***`, percent: pct, severity: pct >= 90 ? "critical" : "normal", resetsAt: null, active: false }) as ClaudeLimit);

function fixture(limits: ClaudeLimit[], extra: Partial<Record<string, unknown>> = {}): OpsResponse {
  return {
    now: NOW,
    healthStaleSince: null,
    bridge: { connected: true },
    github: { at: NOW, stale: false, prs: [], runs: [] },
    mac: { at: NOW, stale: false, volumes: [], load: { one: 1, five: 1, fifteen: 1, cpus: 8 }, memory: { freePct: 40, pressure: "normal" }, uptimeSec: 3600 },
    claude: { at: NOW, stale: false, limits },
    flyAt: NOW,
    flyStale: false,
    flySource: null,
    summary: { needs: 0, redCi: 0, failingSchedules: 0, disk: { freePct: 41, tone: "ok" } },
    ...extra,
  } as unknown as OpsResponse;
}

const show = (ops: OpsResponse, statuses: OpsStatus[] | null = null) => {
  opsData.ops = ops;
  opsData.statuses = statuses;
  opsData.opsAt = { mono: performance.now(), wall: Date.now() };
};
let unmount: (() => void) | null = null;
const mount = () => {
  unmount?.();
  unmount = mountShell(document.body.firstElementChild as HTMLElement);
};
/** The phone's menu button, and the menu's Machines row, which took over In hand's mark. */
const button = () => document.querySelector<HTMLElement>(".menu-open")!;
const machines = () => menuList().querySelector<HTMLElement>('.menu-row[data-key="machines"]')!;
const record = (extra: Partial<OpsStatus>): OpsStatus => ({ kind: "schedule", key: "nightly", state: "in-progress", since: NOW, updatedAt: NOW, version: 1, ...extra }) as OpsStatus;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  stubCanvas();
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  document.body.replaceChildren(document.createElement("div"));
  app.tab = "cards";
});

afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  opsData.ops = null;
  opsData.statuses = null;
  opsData.opsAt = { mono: 0, wall: 0 };
  app.summary = null;
  vi.useRealTimers();
});

describe("The menu's marks", () => {
  it("mark nothing for Usage at 95% and red CI: Progress says what Rivet is on", () => {
    const github = { at: NOW, stale: false, prs: [{ title: "Fix", checks: { state: "fail", failing: [] } }], runs: [] };
    show(fixture(accounts(95, 95), { github, summary: { needs: 0, redCi: 3, failingSchedules: 0, disk: { freePct: 41, tone: "ok" } } }));
    mount();
    expect(button().querySelector(".menu-dot")).toBeNull();
    expect(machines().querySelector(".badge")).toBeNull();
    expect(document.querySelector(".floor-dock .badge.t-bad, .floor-dock .badge.t-warn")).toBeNull();
    expect(button().getAttribute("aria-label")).toBe("Menu");
  });

  it("are an amber \"!\" while an ask has moved twice", () => {
    show(fixture([]), [record({ dueAt: "2026-10-07T06:00:00.000Z" })]);
    serveSummary([{ chat: "c1", stage: "building", dueAt: "2026-10-07T08:00:00.000Z", dueHistory: [{ at: "2026-10-07T06:00:00.000Z", dueAt: "2026-10-07T07:00:00.000Z", was: "2026-10-07T06:30:00.000Z" }, { at: "2026-10-07T06:50:00.000Z", dueAt: "2026-10-07T08:00:00.000Z", was: "2026-10-07T07:00:00.000Z" }] }], [{ chat: "c1", repo: "example-org/example-repo", position: 1, at: Date.now() }]);
    mount();
    const amber = machines().querySelector(".badge")!;
    expect([amber.className, amber.textContent, amber.getAttribute("aria-label")]).toEqual(["badge t-warn", "!", "1 moved twice"]);
    expect(button().querySelector(".menu-dot")?.className).toBe("menu-dot t-warn");
    expect(button().getAttribute("aria-label")).toBe("Menu, 1 moved twice");

    // No other row or button carries a mark of its kind: Decide counts, Rivet has a dot, the rest have none.
    expect(menuList().querySelectorAll(".badge")).toHaveLength(1);
    for (const other of document.querySelectorAll(".floor-dock [data-key]")) expect(other.querySelector(".badge.t-bad, .badge.t-warn")).toBeNull();
  });

  it("draws every mark from the same badge, named for a screen reader", () => {
    const amber = navMark({ dot: "warn", line: null })!;
    expect(amber.className).toBe("badge t-warn");
    expect(amber.getAttribute("aria-label")).toBe("an ask has no time");
    expect(navMark({ dot: null, line: null })).toBeNull();
  });
});

describe("The rail's Machines row's mark on the desktop", () => {
  it("is the same badge, amber while an ask has moved twice", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }));
    show(fixture([]), [record({ dueAt: "2026-10-07T06:00:00.000Z" })]);
    serveSummary([{ stage: "building", dueAt: "2026-10-07T08:00:00.000Z", dueHistory: [{ at: "2026-10-07T06:00:00.000Z", dueAt: "2026-10-07T07:00:00.000Z", was: "2026-10-07T06:30:00.000Z" }, { at: "2026-10-07T06:50:00.000Z", dueAt: "2026-10-07T08:00:00.000Z", was: "2026-10-07T07:00:00.000Z" }] }]);
    mount();
    const rail = document.querySelector<HTMLElement>('.tabs .menu-row[data-key="machines"]')!;
    expect(document.querySelector(".tabs.phone-tabs")).toBeNull();
    const amber = rail.querySelector(".badge")!;
    expect([amber.className, amber.textContent]).toEqual(["badge t-warn", "!"]);
  });
});
