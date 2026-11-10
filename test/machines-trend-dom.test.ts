// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MachineHistoryResponse, MachineMetric } from "../src/shared/machines.js";
import type { OpsResponse } from "../src/shared/ops.js";
import { opsData } from "../web/src/ops-data.js";
import { app, changed } from "../web/src/state.js";
import * as ops from "../web/src/views/ops.js";
import { clampWindow, resetTrend, runs, windowLabel, xTicks, yTop } from "../web/src/views/machines-trend.js";

const NOW = Date.parse("2026-10-08T01:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const MAC = { at: new Date(NOW - 2 * MIN).toISOString(), stale: false, name: "This Mac", volumes: [], load: { one: 1, five: 1, fifteen: 1, cpus: 8 }, memory: { freePct: 50, pressure: "normal" }, uptimeSec: 3600, runners: [], chatRunner: true };

/** Three hours of readings every 5 minutes, ending at NOW. */
function history(): MachineHistoryResponse {
  const t = Array.from({ length: 37 }, (_, i) => (NOW - (36 - i) * 5 * MIN) / 1000);
  const col = (v: (i: number) => number | null) => t.map((_, i) => v(i));
  const series = (id: string, name: string, values: Partial<Record<MachineMetric, (number | null)[]>>) => ({ id, name, t, values });
  return {
    now: new Date(NOW).toISOString(),
    machines: [
      series("this-mac", "This Mac", { cpuUsedPct: col((i) => 40 + i), loadPct: col(() => 90), memUsedPct: col(() => 70), diskFreePct: col(() => 23) }),
      // The laptop went quiet for the last 30 minutes: a gap, never zeros.
      series("laptop", "Laptop", { cpuUsedPct: col((i) => (i > 30 ? null : 20)), loadPct: col((i) => (i > 30 ? null : 1186)), batteryPct: col((i) => (i > 30 ? null : 100)) }),
      series("build-box", "Build Box", { cpuUsedPct: col(() => 62), loadPct: col(() => 150), memUsedPct: col(() => 36) }),
      series("tablet", "Tablet", { batteryPct: col(() => 100) }),
    ],
  };
}

let root: HTMLElement;
let fetched: string[];
const legend = () => [...root.querySelectorAll<HTMLElement>(".trend-legend li")].map((li) => [li.querySelector(".trend-name")?.textContent, li.querySelector(".trend-value")?.textContent]);
const note = () => root.querySelector(".trend-note")?.textContent ?? null;
const pill = (label: string) => [...root.querySelectorAll<HTMLButtonElement>(".trend .ops-filter-btn")].find((b) => b.textContent === label)!;
const plot = () => root.querySelector<HTMLElement>(".trend-plot")!;
const lines = () => root.querySelectorAll(".trend-plot path.trend-line").length;
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

function pointer(type: string, id: number, x: number, y = 100): void {
  plot().dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, pointerType: "touch", button: 0 }));
}

async function mount(answer: MachineHistoryResponse | Error = history()): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string) => {
      if (!path.startsWith("/api/machines/")) return Promise.resolve(new Response("{}", { status: 200 }));
      fetched.push(path);
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(new Response(JSON.stringify(path.includes("since=") ? { now: new Date(NOW).toISOString(), machines: [] } : answer), { status: 200 }));
    }),
  );
  opsData.ops = { now: new Date(NOW).toISOString(), bridge: { connected: true }, apps: [], summary: { needs: 0, redCi: 0, failingSchedules: 0, appsDown: 0, disk: { freePct: 41, tone: "ok" } }, mac: MAC } as unknown as OpsResponse;
  app.tab = "progress";
  app.opsPage = "machines";
  ops.mount(root);
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  localStorage.clear();
  resetTrend();
  fetched = [];
  root = document.createElement("div");
  document.body.replaceChildren(root);
  opsData.at = Date.now();
  opsData.opsAt = { mono: performance.now(), wall: Date.now() };
});

afterEach(() => {
  ops.unmount();
  opsData.ops = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Machines trend", () => {
  it("sits under this Mac on Machines with one line per machine that has CPU readings, the rest named in a note", async () => {
    await mount();
    expect(fetched).toEqual(["/api/machines/history"]);
    const trend = root.querySelector<HTMLElement>('[data-section="trend"]')!;
    expect(root.querySelector('[data-section="boxes"]')!.compareDocumentPosition(trend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pill("CPU").getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector(".trend .ops-sec-line")?.textContent).toBe("CPU in use: 100% = every core busy");
    expect(pill("24h").getAttribute("aria-pressed")).toBe("true");
    expect(lines()).toBe(3);
    // The laptop's last reading, not a zero for the half hour it has been quiet.
    expect(legend()).toEqual([
      ["This Mac", "76%"],
      ["Laptop", "20%"],
      ["Build Box", "62%"],
    ]);
    expect(note()).toBe("No CPU readings in this range: Tablet");
    // The CPU in use tops out at every core busy.
    expect([...root.querySelectorAll(".trend-tick")].map((t) => t.textContent).filter((t) => t?.endsWith("%"))).toEqual(["0%", "25%", "50%", "75%", "100%"]);
  });

  it("keeps the load per core as its own pill, past 100% when jobs wait, its axis labels whole", async () => {
    await mount();
    const base = () => Number(root.querySelector(".trend-base")!.getAttribute("x1"));
    expect(base()).toBe(46);
    pill("Load").click();
    expect(pill("Load").getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector(".trend .ops-sec-line")?.textContent).toBe("Load: 100% = a job per core; above it, jobs wait");
    expect(legend()).toEqual([
      ["This Mac", "90%"],
      ["Laptop", "1186%"],
      ["Build Box", "150%"],
    ]);
    expect([...root.querySelectorAll(".trend-tick")].map((t) => t.textContent)).toContain("1000%");
    // "1000%" is a character past "100%": the plot moves over by one, so the label is never cut.
    expect(base()).toBe(55);
    // Dragged back before the readings, the peak is out of view: the scale under the finger stays as it was.
    pill("1h").click();
    pointer("pointerdown", 1, 300);
    pointer("pointermove", 1, 312);
    pointer("pointermove", 1, 312 + 4 * 293);
    pointer("pointerup", 1, 312 + 4 * 293);
    await settle();
    expect(root.querySelector(".trend-empty")?.textContent).toBe("No load readings in this range.");
    expect(base()).toBe(55);
    pill("CPU").click();
    expect(base()).toBe(46);
  });

  it("switches metric with its pill: each machine keeps its colour, and one with no readings is left out", async () => {
    await mount();
    const colour = () => Object.fromEntries([...root.querySelectorAll<HTMLElement>(".trend-legend li")].map((li) => [li.dataset.machine, li.querySelector<HTMLElement>(".trend-key")!.style.background]));
    const before = colour();
    pill("Battery").click();
    expect(pill("Battery").getAttribute("aria-pressed")).toBe("true");
    expect(pill("CPU").getAttribute("aria-pressed")).toBe("false");
    expect(legend().map(([name]) => name)).toEqual(["Laptop", "Tablet"]);
    expect(colour().laptop).toBe(before.laptop);
    expect(note()).toBe("No battery readings in this range: This Mac, Build Box");
  });

  it("changes the range with its pills, and says so when a range holds no readings", async () => {
    await mount();
    pill("1h").click();
    expect(pill("1h").getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector(".trend-window")?.textContent).toBe(windowLabel(NOW - HOUR, NOW));
    // Over the last hour the laptop has 30 minutes of readings, then its gap.
    expect(legend().map(([name]) => name)).toEqual(["This Mac", "Laptop", "Build Box"]);
    // The first move past a tap's slack claims the drag; the chart then follows the finger. 302 px is the hour.
    pointer("pointerdown", 1, 300);
    pointer("pointermove", 1, 312);
    pointer("pointermove", 1, 312 + 4 * 302);
    pointer("pointerup", 1, 312 + 4 * 302);
    await settle();
    // Dragged four hours back: before the readings start, nothing to draw.
    expect(root.querySelector(".trend-empty")?.textContent).toBe("No CPU readings in this range.");
    expect(pill("1h").getAttribute("aria-pressed")).toBe("false");
  });

  it("drags back through time, and Now brings it back", async () => {
    await mount();
    pill("6h").click();
    const now = root.querySelector<HTMLButtonElement>(".trend-now")!;
    expect(now.hidden).toBe(true);
    pointer("pointerdown", 1, 200);
    pointer("pointermove", 1, 212);
    pointer("pointermove", 1, 262);
    pointer("pointerup", 1, 262);
    await settle();
    expect(now.hidden).toBe(false);
    expect(root.querySelector(".trend-window")?.textContent).not.toBe(windowLabel(NOW - 6 * HOUR, NOW));
    now.click();
    expect(now.hidden).toBe(true);
    expect(pill("6h").getAttribute("aria-pressed")).toBe("true");
  });

  it("pinches to zoom in, and a tap shows the readings at a time", async () => {
    await mount();
    pointer("pointerdown", 1, 150);
    pointer("pointerdown", 2, 250);
    pointer("pointermove", 1, 50);
    pointer("pointermove", 2, 350);
    pointer("pointerup", 1, 50);
    pointer("pointerup", 2, 350);
    await settle();
    // Three times the spread: a third of the span, no range pill fits it.
    expect(RANGE_LABELS.some((label) => pill(label).getAttribute("aria-pressed") === "true")).toBe(false);
    pill("1h").click();
    pointer("pointerdown", 1, 200);
    pointer("pointerup", 1, 200);
    expect(root.querySelector(".trend-at")?.textContent).toMatch(/^At /);
    expect(root.querySelectorAll(".trend-pick").length).toBe(3);
  });

  it("keeps a touch the chart has not yet read from the page's pull to refresh", async () => {
    await mount();
    const heard: string[] = [];
    root.addEventListener("touchmove", () => heard.push("page"));
    pointer("pointerdown", 1, 200, 100);
    pointer("pointermove", 1, 201, 104);
    plot().dispatchEvent(new Event("touchmove", { bubbles: true }));
    expect(heard).toEqual([]);
  });

  it("clears a finger lifted off the chart, so the next touch is a tap, not a pinch with it", async () => {
    await mount();
    pill("1h").click();
    pointer("pointerdown", 1, 200);
    pointer("pointermove", 1, 212);
    // The finger leaves the chart and lifts elsewhere on the page.
    document.body.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 50, clientY: 600, bubbles: true, pointerType: "touch" }));
    pointer("pointerdown", 2, 200);
    pointer("pointerup", 2, 200);
    expect(root.querySelector(".trend-at")?.textContent).toMatch(/^At /);
  });

  it("keeps focus on a pill while Ops renders again around it", async () => {
    await mount();
    pill("Memory").focus();
    ops.mount(root);
    await settle();
    expect(document.activeElement).toBe(pill("Memory"));
  });

  it("shows a failed load and no lines rather than an empty chart that looks idle", async () => {
    await mount(new Error("offline"));
    expect(lines()).toBe(0);
    // Plain words, never the error's own.
    expect(root.querySelector(".trend-empty")?.textContent).toBe("Couldn't load the readings.");
  });

  it("draws a week of unbroken readings as one line, not dots where it thins them", async () => {
    const t = Array.from({ length: 7 * 288 }, (_, i) => (NOW - (7 * 288 - 1 - i) * 5 * MIN) / 1000);
    await mount({ now: new Date(NOW).toISOString(), machines: [{ id: "this-mac", name: "This Mac", t, values: { cpuUsedPct: t.map((_, i) => (i % 7) * 10) } }] });
    pill("7d").click();
    expect(lines()).toBe(1);
    expect(root.querySelectorAll(".trend-dot").length).toBe(0);
    expect(root.querySelector(".trend-window")?.textContent).toBe("Thu 1 Oct – Thu 8 Oct");
  });

  it("takes an answer of another shape as a failed load, and Machines still renders", async () => {
    await mount({ entries: [] } as unknown as MachineHistoryResponse);
    expect(root.querySelector('[data-section="boxes"]')).not.toBeNull();
    expect(root.querySelector(".trend-empty")?.textContent).toBe("Couldn't load the readings.");
  });

  it("says a top-up that failed under the lines it kept, never the old figures as the latest unsaid", async () => {
    await mount();
    expect(lines()).toBeGreaterThan(0);
    expect(root.querySelector(".trend-failed")).toBeNull();
    ops.unmount();
    vi.stubGlobal("fetch", vi.fn((path: string) => (path.startsWith("/api/machines/") ? Promise.resolve(new Response("{}", { status: 500 })) : Promise.resolve(new Response("{}", { status: 200 })))));
    opsData.ops = { ...opsData.ops!, mac: { ...MAC, at: new Date(NOW).toISOString() } } as OpsResponse;
    ops.mount(root);
    await settle();
    expect(lines()).toBeGreaterThan(0);
    expect(root.querySelector(".trend-failed")?.textContent).toBe("Couldn't refresh the readings. These are from the last read.");
  });

  it("tops up only after the Mac reports again", async () => {
    await mount();
    ops.unmount();
    opsData.ops = { ...opsData.ops!, mac: { ...MAC, at: new Date(NOW).toISOString() } } as OpsResponse;
    ops.mount(root);
    await settle();
    expect(fetched).toEqual(["/api/machines/history", `/api/machines/history?since=${NOW / 1000}`]);
  });
});

describe("Machines trend redraws", () => {
  it("keeps the chart as drawn through an Ops redraw that changes nothing it shows, and draws it again when one does", async () => {
    await mount();
    const drawn = plot().querySelector("svg");
    expect(drawn).not.toBeNull();
    changed();
    await settle();
    expect(plot().querySelector("svg")).toBe(drawn);
    pill("6h").click();
    expect(plot().querySelector("svg")).not.toBe(drawn);
    const six = plot().querySelector("svg");
    // A minute on, the window has moved: the next redraw draws it again.
    vi.setSystemTime(NOW + MIN);
    changed();
    await settle();
    expect(plot().querySelector("svg")).not.toBe(six);
  });
});

const RANGE_LABELS = ["1h", "6h", "24h", "7d"];

describe("Machines trend geometry", () => {
  it("breaks a line where readings stop for more than three checks", () => {
    const at = (m: number, v = 1) => ({ t: m * MIN, v });
    expect(runs([at(0), at(5), at(10), at(40), at(45), at(90)]).map((run) => run.length)).toEqual([3, 2, 1]);
  });

  it("tops the axis at 100%, or in steps of 50 past it", () => {
    expect(yTop(37)).toBe(100);
    expect(yTop(100)).toBe(100);
    expect(yTop(101)).toBe(150);
    expect(yTop(1430)).toBe(1450);
  });

  it("keeps a window within the kept week, and following now at now", () => {
    expect(clampWindow(NOW + HOUR, HOUR, NOW)).toEqual({ end: null, span: HOUR });
    expect(clampWindow(NOW - 30 * 24 * HOUR, HOUR, NOW)).toEqual({ end: NOW - 7 * 24 * HOUR + HOUR, span: HOUR });
    expect(clampWindow(NOW - HOUR, 60_000, NOW).span).toBe(30 * MIN);
    expect(clampWindow(NOW, 30 * 24 * HOUR, NOW).span).toBe(7 * 24 * HOUR);
  });

  it("labels time on the device's clock, and the day at midnight", () => {
    const labels = xTicks(Date.parse("2026-10-07T10:00:00Z"), Date.parse("2026-10-08T10:00:00Z"), 300).map((tick) => tick.label);
    expect(labels).toContain("Thu");
    expect(labels.every((label) => /^(\d{1,2}(:\d\d)?[ap]m|[A-Z][a-z]{2})$/.test(label))).toBe(true);
  });
});
