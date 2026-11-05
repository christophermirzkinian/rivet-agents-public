// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpsResponse } from "../src/shared/ops.js";
import { opsData } from "../web/src/ops-data.js";
import { app } from "../web/src/state.js";

// A Machines fault is still named, and Plan lists it under
// Being done, Rivet's job.

const health = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("../web/src/push-health.js", async (actual) => ({
  ...((await actual()) as typeof import("../web/src/push-health.js")),
  pushHealth: () => health.value,
}));

const ops = await import("../web/src/views/ops.js");

const NOW = "2026-10-20T05:00:00.000Z";
const fixture = (): OpsResponse =>
  ({
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
  }) as unknown as OpsResponse;

let root: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  root = document.createElement("div");
  document.body.replaceChildren(root);
  opsData.opsAt = { mono: performance.now(), wall: Date.now() };
  app.tab = "progress";
  app.opsPage = "machines";
});

afterEach(() => {
  ops.unmount();
  opsData.ops = null;
  health.value = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Machines' faults", () => {
  it("names notifications off on every phone", () => {
    health.value = { configured: true, publicKey: "k", subscriptions: 0, lastRemoval: null };
    opsData.ops = fixture();
    expect(ops.wrongRows(opsData.ops, "machines").rows.map((row) => row.title)).toEqual(["Notifications"]);
  });

  it("names nothing when nothing on Machines is wrong", () => {
    health.value = { configured: true, publicKey: "k", subscriptions: 1, lastRemoval: null };
    opsData.ops = fixture();
    expect(ops.wrongRows(opsData.ops, "machines").rows).toEqual([]);
  });
});
