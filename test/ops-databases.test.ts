import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { itemGreen } from "../src/server/ops/fixes.js";
import { itemId, machineReds, NO_PICKUPS, planPickups } from "../src/server/ops/pickup.js";
import { recordOf } from "../src/shared/ops-owned.js";
import { createOps } from "../src/server/ops/service.js";
import { Store } from "../src/server/store.js";
import { databaseProblem, databaseTrouble, DATABASE_TROUBLE_MS, redDatabases, type FlyApp, type FlySnapshot, type OpsResponse } from "../src/shared/ops.js";
import type { OpsStatus } from "../src/shared/ops-status.js";

// A database app ran 21 days with one of its three machines stopped and Ops never went red: no rule read a stopped
// machine. The list of database apps has its own tests (ops-databases-private.test.ts).

const DB = "orders-db";
const T0 = Date.parse("2026-11-27T00:00:00.000Z");
const MIN = 60_000;

const app = (name: string, started: number, total: number, passing = total * 3, checks = total * 3): FlyApp => ({
  app: name,
  status: "deployed",
  version: 1,
  sha: null,
  machines: { started, total },
  checks: { passing, total: checks },
  updatedAt: null,
  releases: [],
});
const snapshot = (at: number, apps: FlyApp[], failed: string[] = []): FlySnapshot => ({ at: new Date(at).toISOString(), apps, source: { failed, at: failed.length ? new Date(at - 5 * MIN).toISOString() : null } });

describe("when a database's trouble began (databaseTrouble)", () => {
  const at = (ms: number) => new Date(T0 + ms).toISOString();

  it("starts at the first troubled reading, keeps that start, and ends on a good one", () => {
    const began = databaseTrouble({}, [DB], snapshot(T0, [app(DB, 2, 3)]), at(0));
    expect(began).toEqual({ [DB]: at(0) });
    expect(databaseTrouble(began, [DB], snapshot(T0 + 5 * MIN, [app(DB, 2, 3)]), at(5 * MIN))).toEqual({ [DB]: at(0) });
    expect(databaseTrouble(began, [DB], snapshot(T0 + 10 * MIN, [app(DB, 3, 3)]), at(10 * MIN))).toEqual({});
  });

  it("counts checks not passing and no machines at all, and nothing else", () => {
    expect(databaseTrouble({}, [DB], snapshot(T0, [app(DB, 3, 3, 6, 9)]), at(0))).toEqual({ [DB]: at(0) });
    expect(databaseTrouble({}, [DB], snapshot(T0, [app(DB, 0, 0)]), at(0))).toEqual({ [DB]: at(0) });
    // An app that is no listed database is never tracked, and a database no longer listed drops out.
    expect(databaseTrouble({ gone: at(0) }, [DB], snapshot(T0, [app("rivet-app", 0, 1), app(DB, 3, 3)]), at(0))).toEqual({});
  });

  it("neither starts nor ends a trouble from a read that failed", () => {
    // The bridge resends the last good data for a failed app: well in it is not well now, and troubled in it is not new.
    expect(databaseTrouble({ [DB]: at(0) }, [DB], snapshot(T0 + 5 * MIN, [app(DB, 3, 3)], [DB]), at(5 * MIN))).toEqual({ [DB]: at(0) });
    expect(databaseTrouble({}, [DB], snapshot(T0 + 5 * MIN, [app(DB, 2, 3)], [DB]), at(5 * MIN))).toEqual({});
    // Failed before it was ever read: named in failed, absent from the apps.
    expect(databaseTrouble({}, [DB], snapshot(T0 + 5 * MIN, [], [DB]), at(5 * MIN))).toEqual({});
  });

  it("starts a trouble for a listed database the reading neither read nor failed, and keeps its start", () => {
    // An old bridge whose list stops short of it: unread is not well. (A name Fly does not know fails its read instead.)
    expect(databaseTrouble({}, [DB], snapshot(T0 + 5 * MIN, []), at(5 * MIN))).toEqual({ [DB]: at(5 * MIN) });
    expect(databaseTrouble({ [DB]: at(0) }, [DB], snapshot(T0 + 5 * MIN, []), at(5 * MIN))).toEqual({ [DB]: at(0) });
    expect(databaseTrouble({ [DB]: at(0) }, [DB], snapshot(T0 + 5 * MIN, [app(DB, 3, 3)]), at(5 * MIN))).toEqual({});
  });
});

describe("what a red database row says (databaseProblem)", () => {
  const status = (started: number, total: number, passing: number, checks: number, agoMs: number) => ({ app: DB, machines: { started, total }, checks: { passing, total: checks }, troubleSince: new Date(T0 - agoMs).toISOString() });

  it("is not red at 14 minutes, nor at 15 exactly, and is at 16", () => {
    expect(DATABASE_TROUBLE_MS).toBe(15 * MIN);
    expect(databaseProblem(status(2, 3, 9, 9, 14 * MIN), T0)).toBeNull();
    expect(databaseProblem(status(2, 3, 9, 9, 15 * MIN), T0)).toBeNull();
    expect(databaseProblem(status(2, 3, 9, 9, 16 * MIN), T0)).toBe("2 of 3 machines running for 16 minutes");
  });

  it("says machines, checks, or both, and for how long", () => {
    expect(databaseProblem(status(2, 3, 9, 9, 21 * 24 * 60 * MIN), T0)).toBe("2 of 3 machines running for 21 days");
    expect(databaseProblem(status(3, 3, 6, 9, 2 * 60 * MIN), T0)).toBe("Checks 6 of 9 passing for 2 hours");
    expect(databaseProblem(status(2, 3, 6, 9, 60 * MIN), T0)).toBe("2 of 3 machines running, checks 6 of 9 passing for 1 hour");
    expect(databaseProblem(status(0, 0, 0, 0, 25 * 60 * MIN), T0)).toBe("No machines for 1 day");
  });

  it("is null for a database that reads well, has no start, or is not read yet", () => {
    expect(databaseProblem(status(3, 3, 9, 9, 60 * MIN), T0)).toBeNull();
    expect(databaseProblem({ ...status(2, 3, 9, 9, 0), troubleSince: null }, T0)).toBeNull();
    expect(databaseProblem({ app: DB, machines: null, checks: null, troubleSince: null }, T0)).toBeNull();
    expect(databaseProblem({ app: DB, machines: null, checks: null, troubleSince: new Date(T0 - 15 * MIN).toISOString() }, T0)).toBeNull();
  });

  it("says a database left unread for over 15 minutes is not read", () => {
    const unread = (ms: number) => ({ app: DB, machines: null, checks: null, troubleSince: new Date(T0 - ms).toISOString() });
    expect(databaseProblem(unread(16 * MIN), T0)).toBe("Not read from Fly for 16 minutes");
    expect(databaseProblem(unread(3 * 60 * MIN), T0)).toBe("Not read from Fly for 3 hours");
  });
});

describe("a database's red in Ops", () => {
  function setup(databases: string[] = [DB]) {
    let clock = T0;
    const ops = createOps({
      dataDir: mkdtempSync(join(tmpdir(), "rivet-databases-ops-")),
      store: new Store(mkdtempSync(join(tmpdir(), "rivet-databases-store-"))),
      bridge: { status: () => ({ connected: true }) as never },
      push: { notify: async () => ({}) as never, flushHeld: async () => null, onDigestSettled: () => () => {}, onDigestRelease: () => () => {}, onDigestReword: () => () => {} } as never,
      checks: [],
      databases,
      fetch: (async () => new Response("")) as typeof fetch,
      now: () => new Date(clock),
      logger: { error: () => {} },
    });
    const put = async (minutes: number, apps: FlyApp[], failed: string[] = []) => {
      clock = T0 + minutes * MIN;
      await ops.putFly(snapshot(clock, apps, failed));
    };
    const reds = (minutes?: number) => {
      if (minutes !== undefined) clock = T0 + minutes * MIN;
      return machineReds(ops.view()).map((item) => [itemId(item), item.name, item.detail]);
    };
    return { ops, put, reds };
  }

  it("is not red at 14 minutes, is at 16, and clears on the first reading with every machine started", async () => {
    const { put, reds } = setup();
    await put(0, [app(DB, 2, 3)]);
    expect(reds()).toEqual([]);
    await put(14, [app(DB, 2, 3)]);
    expect(reds()).toEqual([]);
    await put(16, [app(DB, 2, 3)]);
    expect(reds()).toEqual([[`machine/${DB}`, DB, "2 of 3 machines running for 16 minutes"]]);
    await put(21, [app(DB, 3, 3)]);
    expect(reds()).toEqual([]);
    // A new trouble starts its own 15 minutes.
    await put(26, [app(DB, 2, 3)]);
    await put(36, [app(DB, 2, 3)]);
    expect(reds()).toEqual([]);
  });

  it("is red on checks not passing, and on no machines at all", async () => {
    const checks = setup();
    await checks.put(0, [app(DB, 3, 3, 6, 9)]);
    await checks.put(16, [app(DB, 3, 3, 6, 9)]);
    expect(checks.reds()).toEqual([[`machine/${DB}`, DB, "Checks 6 of 9 passing for 16 minutes"]]);
    const none = setup();
    await none.put(0, [app(DB, 0, 0)]);
    await none.put(16, [app(DB, 0, 0)]);
    expect(none.reds()).toEqual([[`machine/${DB}`, DB, "No machines for 16 minutes"]]);
  });

  it("a failed read shows no red and leaves the start alone, so the red is back with the next good reading", async () => {
    const { ops, put, reds } = setup();
    await put(0, [app(DB, 2, 3)]);
    await put(16, [app(DB, 2, 3)]);
    expect(reds()).toHaveLength(1);
    // The bridge resends the last data it had for the app it could not read.
    await put(21, [app(DB, 2, 3)], [DB]);
    expect(reds()).toEqual([]);
    expect(ops.view().databases?.[0]?.troubleSince).toBe(new Date(T0).toISOString());
    expect(ops.view().flySource?.failed).toEqual([DB]);
    await put(26, [app(DB, 2, 3)]);
    expect(reds()).toEqual([[`machine/${DB}`, DB, "2 of 3 machines running for 26 minutes"]]);
    // A failed read is no start either.
    const fresh = setup();
    await fresh.put(0, [app(DB, 2, 3)], [DB]);
    await fresh.put(20, [app(DB, 2, 3)]);
    expect(fresh.reds()).toEqual([]);
  });

  it("is red when a current reading leaves a listed database out for over 15 minutes, and clears once it is read well", async () => {
    // A bridge still capped below the list sends the checks's apps and never the database.
    const { ops, put, reds } = setup();
    await put(0, [app("rivet-rivet", 1, 1)]);
    await put(14, [app("rivet-rivet", 1, 1)]);
    expect(reds()).toEqual([]);
    await put(16, [app("rivet-rivet", 1, 1)]);
    expect(reds()).toEqual([[`machine/${DB}`, DB, "Not read from Fly for 16 minutes"]]);
    expect(ops.view().databases).toEqual([{ app: DB, machines: null, checks: null, troubleSince: new Date(T0).toISOString() }]);
    await put(18, [app("rivet-rivet", 1, 1), app(DB, 3, 3)]);
    expect(reds()).toEqual([]);
  });

  it("a record parked on an earlier trouble does not own the next one: it is red again and picked up", async () => {
    const { ops, put } = setup();
    const iso = (minutes: number) => new Date(T0 + minutes * MIN).toISOString();
    const parked = { kind: "machine", key: DB, state: "parked", since: iso(17), updatedAt: iso(17), version: 1, by: "monitor" } as OpsStatus;
    const monitor = { id: "monitor", name: "monitor", repo: "example-org/example-repo", chat: "monitor", state: "working", lastOutputAt: null } as never;
    const tick = (minutes: number, state = NO_PICKUPS) =>
      planPickups({ red: machineReds(ops.view()), statuses: [parked], workers: [monitor], held: new Set(), monitorChat: "monitor", state, now: new Date(T0 + minutes * MIN) });
    await put(0, [app(DB, 2, 3)]);
    await put(16, [app(DB, 2, 3)]);
    expect(machineReds(ops.view())[0]).toMatchObject({ key: DB, since: iso(0) });
    // Parked at 17 minutes: the pick-up stays off it however long this trouble lasts.
    const quiet = tick(18);
    await put(40, [app(DB, 2, 3)]);
    expect(tick(40, quiet.state).start).toEqual([]);
    const still = machineReds(ops.view())[0]!;
    expect(recordOf(still, [parked], still.since)).toBe(parked);
    // It recovers, then a machine stops again: trouble that began after the record was parked.
    await put(45, [app(DB, 3, 3)]);
    await put(50, [app(DB, 2, 3)]);
    await put(66, [app(DB, 2, 3)]);
    const again = machineReds(ops.view());
    expect(again.map((item) => [item.key, item.detail, item.since])).toEqual([[DB, "2 of 3 machines running for 16 minutes", iso(50)]]);
    expect(recordOf(again[0]!, [parked], again[0]!.since)).toBeNull();
    const first = tick(66);
    expect(tick(80, first.state).start.map((item) => itemId(item))).toEqual([`machine/${DB}`]);
  });

  it("shows no red from a Fly reading gone old", async () => {
    const { put, reds } = setup();
    await put(0, [app(DB, 2, 3)]);
    await put(16, [app(DB, 2, 3)]);
    expect(reds(30)).toHaveLength(1);
    expect(reds(40)).toEqual([]);
  });

  it("keeps the start across a restart of the server", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rivet-databases-restart-"));
    let clock = T0;
    const make = () =>
      createOps({
        dataDir,
        store: new Store(mkdtempSync(join(tmpdir(), "rivet-databases-store-"))),
        bridge: { status: () => ({ connected: true }) as never },
        push: { notify: async () => ({}) as never, flushHeld: async () => null, onDigestSettled: () => () => {}, onDigestRelease: () => () => {}, onDigestReword: () => () => {} } as never,
        checks: [],
        databases: [DB],
        fetch: (async () => new Response("")) as typeof fetch,
        now: () => new Date(clock),
        logger: { error: () => {} },
      });
    await make().putFly(snapshot(T0, [app(DB, 2, 3)]));
    clock = T0 + 16 * MIN;
    const again = make();
    await again.putFly(snapshot(clock, [app(DB, 2, 3)]));
    expect(machineReds(again.view()).map((item) => item.detail)).toEqual(["2 of 3 machines running for 16 minutes"]);
  });

  it("a record on a database is green only on a current reading of it taken after the record began", () => {
    const now = new Date(T0 + 60 * MIN).toISOString();
    const base = { now, flyAt: now, flyStale: false, flySource: null, bridge: { connected: true }, apps: [] } as unknown as OpsResponse;
    const record = { kind: "machine", key: DB, since: new Date(T0).toISOString() } as OpsStatus;
    const well = { app: DB, machines: { started: 3, total: 3 }, checks: { passing: 9, total: 9 }, troubleSince: null };
    const green = (view: Partial<OpsResponse>) => itemGreen(record, { view: { ...base, ...view } } as never);
    expect(green({ databases: [well] })).toBe(true);
    expect(green({ databases: [{ ...well, machines: { started: 2, total: 3 }, troubleSince: new Date(T0).toISOString() }] })).toBe(false);
    expect(green({ databases: [well], flySource: { failed: [DB], at: null } })).toBeNull();
    expect(green({ databases: [well], flyStale: true })).toBeNull();
    expect(green({ databases: [{ ...well, machines: null, checks: null }] })).toBeNull();
    // In trouble again but not yet red (under 15 minutes): not back, so the record is not marked fixed before a relapse.
    expect(green({ databases: [{ ...well, machines: { started: 2, total: 3 }, troubleSince: new Date(T0 + 55 * MIN).toISOString() }] })).toBeNull();
    expect(redDatabases({ ...base, databases: [well] })).toEqual([]);
  });
});
