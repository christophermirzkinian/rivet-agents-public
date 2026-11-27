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

  // A database app ran 21 days with a machine stopped and nothing went red.
  it("names a database with a machine stopped for over 15 minutes, and counts it", () => {
    health.value = { configured: true, publicKey: "k", subscriptions: 1, lastRemoval: null };
    const since = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
    const database = (app: string, started: number, passing: number, minutes: number | null) => ({ app, machines: { started, total: 3 }, checks: { passing, total: 9 }, troubleSince: minutes === null ? null : since(minutes) });
    opsData.ops = {
      ...fixture(),
      databases: [database("orders-db", 2, 6, 21 * 24 * 60), database("users-db", 3, 6, 120), database("billing-db", 2, 9, 14), database("demo-db", 3, 9, null)],
    } as OpsResponse;
    const wrong = ops.wrongRows(opsData.ops, "machines");
    expect(wrong.rows.map((row) => [row.kind, row.tone, row.title, row.line])).toEqual([
      ["machine", "bad", "orders-db", "2 of 3 machines running, checks 6 of 9 passing for 21 days"],
      ["machine", "bad", "users-db", "Checks 6 of 9 passing for 2 hours"],
    ]);
    expect(wrong.count).toBe(2);
    expect(wrong.rows[0]!.item).toMatchObject({ kind: "machine", key: "orders-db", title: "orders-db", failedAt: since(21 * 24 * 60) });
    // Plan lists it as a failed item; the Apps and Code groups do not.
    expect(ops.failedItems(opsData.ops).map((item) => item.key)).toEqual(["orders-db", "users-db"]);
    expect(ops.wrongRows(opsData.ops, "apps").rows).toEqual([]);
    // Fly unreachable for the app, or its reading old, names no row: the notice says so.
    expect(ops.wrongRows({ ...opsData.ops, flySource: { failed: ["orders-db"], at: null } } as OpsResponse, "machines").rows.map((row) => row.title)).toEqual(["users-db"]);
    expect(ops.wrongRows({ ...opsData.ops, flyStale: true } as OpsResponse, "machines").rows).toEqual([]);
    // Each row points at Machines' Databases section, which lists the red ones only, each with what is wrong.
    expect(wrong.rows.map((row) => row.section)).toEqual(["databases", "databases"]);
    ops.mount(root);
    const section = root.querySelector('[data-section="databases"]')!;
    expect(section.querySelector(".ops-sec-title")?.textContent).toBe("Databases");
    // It leads the page, over the machines' "All N working" and outside the grid of the other sections.
    const hero = root.querySelector('[data-section="boxes"]')!;
    expect(section.compareDocumentPosition(hero) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(section.closest(".ops-grid")).toBeNull();
    expect(section.querySelector(".ops-sec-line")?.textContent).toBe("2 need a look");
    expect([...section.querySelectorAll(".ops-row")].map((row) => [row.querySelector(".ops-row-title")?.textContent, row.querySelector(".ops-row-meta")?.textContent])).toEqual([
      ["orders-db", "2 of 3 machines running, checks 6 of 9 passing for 21 days"],
      ["users-db", "Checks 6 of 9 passing for 2 hours"],
    ]);
  });

  it("says in grey how many databases were not checked when Fly could not be read, never a red row or a count", () => {
    health.value = { configured: true, publicKey: "k", subscriptions: 1, lastRemoval: null };
    const since = new Date(Date.parse(NOW) - 60 * 60_000).toISOString();
    const databases = [
      { app: "orders-db", machines: { started: 2, total: 3 }, checks: { passing: 9, total: 9 }, troubleSince: since },
      { app: "billing-db", machines: { started: 3, total: 3 }, checks: { passing: 9, total: 9 }, troubleSince: null },
    ];
    // The whole reading is old: the red row goes, and the section stays to say why.
    opsData.ops = { ...fixture(), databases, flyStale: true } as OpsResponse;
    expect(ops.wrongRows(opsData.ops, "machines").count).toBe(0);
    ops.mount(root);
    let section = root.querySelector('[data-section="databases"]')!;
    expect(section.querySelector(".ops-sec-line")?.textContent).toBe("Not checked");
    expect(section.querySelector(".ops-sec-line")?.classList.contains("t-bad")).toBe(false);
    expect(section.querySelector("[data-databases-unchecked]")?.textContent).toBe("Fly could not be read: 2 databases not checked");
    expect(section.querySelectorAll(".ops-row, .s-bad, .pill")).toHaveLength(0);
    ops.unmount();
    // Fly failed for one: the other's red row stands beside the grey line.
    opsData.ops = { ...fixture(), databases: [{ ...databases[1]!, machines: { started: 2, total: 3 }, troubleSince: since }, databases[0]!], flySource: { failed: ["orders-db"], at: null } } as OpsResponse;
    ops.mount(root);
    section = root.querySelector('[data-section="databases"]')!;
    expect(section.querySelector(".ops-sec-line")?.textContent).toBe("1 needs a look");
    expect([...section.querySelectorAll(".ops-row-title")].map((el) => el.textContent)).toEqual(["billing-db"]);
    expect(section.querySelector("[data-databases-unchecked]")?.textContent).toBe("Fly could not be read: 1 database not checked");
  });

  it("a record from before a database's current trouble does not own it", async () => {
    const { databaseItem, statusOf } = await import("../web/src/views/ops-status.js");
    const since = new Date(Date.parse(NOW) - 60 * 60_000).toISOString();
    const database = { app: "orders-db", machines: { started: 2, total: 3 }, checks: { passing: 9, total: 9 }, troubleSince: since };
    const record = (updatedAt: string) => ({ kind: "machine", key: "orders-db", state: "parked", since: updatedAt, updatedAt, version: 1 });
    const older = record(new Date(Date.parse(since) - 60_000).toISOString());
    const newer = record(new Date(Date.parse(since) + 60_000).toISOString());
    opsData.ops = { ...fixture(), databases: [database] } as OpsResponse;
    try {
      opsData.statuses = [older] as never;
      expect(statusOf(databaseItem(database, "2 of 3 machines running for 1 hour"))).toBeNull();
      opsData.statuses = [newer] as never;
      expect(statusOf(databaseItem(database, "2 of 3 machines running for 1 hour"))).toMatchObject({ state: "parked" });
    } finally {
      opsData.statuses = null;
    }
  });

  it("draws no Databases section while no database is red", () => {
    health.value = { configured: true, publicKey: "k", subscriptions: 1, lastRemoval: null };
    opsData.ops = { ...fixture(), databases: [{ app: "billing-db", machines: { started: 3, total: 3 }, checks: { passing: 9, total: 9 }, troubleSince: null }] } as OpsResponse;
    ops.mount(root);
    expect(root.querySelector('[data-section="boxes"]')).not.toBeNull();
    expect(root.querySelector('[data-section="databases"]')).toBeNull();
    expect(root.textContent).not.toContain("billing-db");
  });

  it("names nothing when nothing on Machines is wrong", () => {
    health.value = { configured: true, publicKey: "k", subscriptions: 1, lastRemoval: null };
    opsData.ops = fixture();
    expect(ops.wrongRows(opsData.ops, "machines").rows).toEqual([]);
  });
});
