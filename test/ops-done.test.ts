import { describe, expect, it } from "vitest";

import { doneToday, foldDue, foldedDone } from "../src/shared/ops-done.js";
import type { OpsStatus } from "../src/shared/ops-status.js";

// 1pm on Saturday 24 Oct local time (UTC+11).
const NOW = new Date("2026-10-24T02:00:00.000Z");
const fixed = (key: string, updatedAt: string, extra: Partial<OpsStatus> = {}): OpsStatus => ({ kind: "ci", key, state: "fixed", since: updatedAt, updatedAt, version: 1, ...extra });
const noCard = () => false;

const todayEarly = fixed("today-early", "2026-10-23T13:30:00.000Z"); // 12:30am local today
const todayLate = fixed("today-late", "2026-10-24T01:00:00.000Z"); // noon local today
const lastNight = fixed("last-night", "2026-10-23T10:00:00.000Z"); // 9pm local yesterday, 16 hours ago
const old = fixed("old", "2026-10-22T02:00:00.000Z");
const working: OpsStatus = { ...fixed("working", "2026-10-24T01:30:00.000Z"), state: "in-progress" };

describe("the Plan page's Done list", () => {
  it("shows only what was fixed today local time, newest first", () => {
    expect(doneToday([old, todayEarly, working, lastNight, todayLate], NOW, noCard).map((one) => one.key)).toEqual(["today-late", "today-early"]);
  });

  it("keeps a fixed record with an open card on the list, however old", () => {
    const open = (status: Pick<OpsStatus, "kind" | "key">) => status.key === "old";
    expect(doneToday([old, lastNight], NOW, open).map((one) => one.key)).toEqual(["old"]);
  });

  it("folds fixed records away 24 hours after they were fixed, unless their card is open", () => {
    expect(foldedDone([old, lastNight, todayLate, working], NOW, noCard).map((one) => one.key)).toEqual(["old"]);
    expect(foldedDone([old], NOW, () => true)).toEqual([]);
    // 16 hours is not yet a day: last night's record is off the list but not removed.
    expect(foldedDone([lastNight], NOW, noCard)).toEqual([]);
  });

  it("runs the daily fold once a local day, from 4am", () => {
    expect(foldDue(NOW, null)).toBe(true);
    expect(foldDue(NOW, "2026-10-23")).toBe(true);
    expect(foldDue(NOW, "2026-10-24")).toBe(false);
    expect(foldDue(new Date("2026-10-23T16:59:00.000Z"), "2026-10-23")).toBe(false);
    expect(foldDue(new Date("2026-10-23T17:00:00.000Z"), "2026-10-23")).toBe(true);
  });
});
