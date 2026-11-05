import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MACHINE_HISTORY_MS, type MachineHistoryResponse } from "../src/shared/machines.js";
import { MachineHistory } from "../src/server/ops/machines.js";
import { bearer, BRIDGE_TOKEN, browser, startServer, type TestServer } from "./helpers.js";

const T0 = new Date("2026-10-08T00:00:00Z");
const min = (n: number) => new Date(T0.getTime() + n * 60_000);
const desk = (cpuUsedPct: number) => ({ id: "desk", name: "Desk Mac", readings: { cpuUsedPct, memUsedPct: 40, diskFreePct: 23 } });
const phone = { id: "iphone-13", name: "iPhone 13", readings: { batteryPct: 100 } };

const dirs: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rivet-machines-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Machines history store", () => {
  it("keeps one row per machine per check, each metric aligned to its times, and only what a machine sent", () => {
    const history = new MachineHistory(dataDir());
    expect(history.record([desk(55), phone, { id: "server", name: "Server" }], min(0))).toBe(2);
    expect(history.record([desk(61.6), { ...phone, readings: {} }], min(5))).toBe(1);
    const read = history.read(min(6));
    expect(read.now).toBe(min(6).toISOString());
    const byId = Object.fromEntries(read.machines.map((m) => [m.id, m]));
    expect(Object.keys(byId).sort()).toEqual(["desk", "iphone-13"]);
    expect(byId.desk).toEqual({
      id: "desk",
      name: "Desk Mac",
      t: [min(0).getTime() / 1000, min(5).getTime() / 1000],
      values: { cpuUsedPct: [55, 62], memUsedPct: [40, 40], diskFreePct: [23, 23] },
    });
    // No CPU, memory or CI readings on a phone: the metrics are absent, never zeros.
    expect(byId["iphone-13"]!.values).toEqual({ batteryPct: [100] });
    history.close();
  });

  it("pads a metric a machine only sometimes sends with nulls, never zeros", () => {
    const history = new MachineHistory(dataDir());
    history.record([{ id: "laptop", name: "Laptop", readings: { cpuUsedPct: 10 } }], min(0));
    history.record([{ id: "laptop", name: "Laptop", readings: { cpuUsedPct: 12, batteryPct: 80 } }], min(5));
    history.record([{ id: "laptop", name: "Laptop", readings: { cpuUsedPct: 14 } }], min(10));
    expect(history.read(min(11)).machines[0]!.values).toEqual({ cpuUsedPct: [10, 12, 14], batteryPct: [null, 80, null] });
    history.close();
  });

  it("adds at most one row a minute per machine, so a burst of reports cannot flood it", () => {
    const history = new MachineHistory(dataDir());
    expect(history.record([desk(10)], min(0))).toBe(1);
    expect(history.record([desk(11)], new Date(min(0).getTime() + 30_000))).toBe(0);
    expect(history.record([desk(12)], min(1.5))).toBe(1);
    expect(history.count()).toBe(2);
    history.close();
  });

  it("drops readings older than the week it keeps", () => {
    const history = new MachineHistory(dataDir());
    history.record([desk(10)], min(0));
    history.record([desk(20)], min(60));
    history.record([desk(30)], new Date(min(0).getTime() + MACHINE_HISTORY_MS + 60_000));
    expect(history.count()).toBe(2);
    expect(history.read(new Date(min(0).getTime() + MACHINE_HISTORY_MS + 120_000)).machines[0]!.values.cpuUsedPct).toEqual([20, 30]);
    history.close();
  });

  it("never holds more than its row cap: the oldest go first", () => {
    const history = new MachineHistory(dataDir(), { maxRows: 5 });
    for (let i = 0; i < 12; i++) history.record([desk(i)], min(i * 5));
    expect(history.count()).toBe(5);
    expect(history.read(min(60)).machines[0]!.values.cpuUsedPct).toEqual([7, 8, 9, 10, 11]);
    history.close();
  });

  it("survives a restart", () => {
    const dir = dataDir();
    const first = new MachineHistory(dir);
    first.record([desk(42), phone], min(0));
    first.close();
    const again = new MachineHistory(dir);
    const read = again.read(min(1));
    expect(read.machines.map((m) => [m.id, m.values])).toEqual(
      expect.arrayContaining([
        ["desk", { cpuUsedPct: [42], memUsedPct: [40], diskFreePct: [23] }],
        ["iphone-13", { batteryPct: [100] }],
      ]),
    );
    again.close();
  });

  it("keeps the CPU in use and the load per core apart", () => {
    const history = new MachineHistory(dataDir());
    history.record([{ id: "laptop", name: "Laptop", readings: { cpuUsedPct: 93, loadPct: 1186 } }], min(0));
    expect(history.read(min(1)).machines[0]!.values).toEqual({ cpuUsedPct: [93], loadPct: [1186] });
    history.close();
  });

  it("reads only the rows after `since`, for the app's top-up", () => {
    const history = new MachineHistory(dataDir());
    history.record([desk(10)], min(0));
    history.record([desk(20)], min(5));
    const read = history.read(min(6), min(0).getTime() / 1000);
    expect(read.machines[0]!.t).toEqual([min(5).getTime() / 1000]);
    expect(read.machines[0]!.values.cpuUsedPct).toEqual([20]);
    history.close();
  });
});

describe("GET /api/machines/history", () => {
  let server: TestServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("serves the Mac's readings to the session only, after `since` when asked", async () => {
    server = await startServer();
    const mac = {
      at: new Date().toISOString(),
      name: "Desk Mac",
      volumes: [{ label: "Data", totalBytes: 100, freeBytes: 23, runners: false }],
      load: { one: 4, five: 3, fifteen: 2, cpus: 8 },
      memory: { freePct: 60, pressure: "normal" },
      uptimeSec: 100,
      runners: [],
      chatRunner: true,
    };
    expect((await fetch(`${server.base}/api/bridge/ops/mac`, { method: "PUT", headers: bearer(BRIDGE_TOKEN), body: JSON.stringify(mac) })).status).toBe(200);
    expect((await fetch(`${server.base}/api/machines/history`)).status).toBe(401);
    const all = (await (await fetch(`${server.base}/api/machines/history`, { headers: browser(server.cookie()) })).json()) as MachineHistoryResponse;
    expect(all.machines).toEqual([{ id: "Desk Mac", name: "Desk Mac", t: [expect.any(Number)], values: { loadPct: [50], memUsedPct: [40], diskFreePct: [23] } }]);
    const after = (await (await fetch(`${server.base}/api/machines/history?since=${all.machines[0]!.t[0]}`, { headers: browser(server.cookie()) })).json()) as MachineHistoryResponse;
    expect(after.machines).toEqual([]);
  });
});
