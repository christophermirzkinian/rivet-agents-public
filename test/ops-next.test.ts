import { describe, expect, it } from "vitest";

import { buildNext, nextWhen, MAX_NEXT_ROWS } from "../src/shared/ops-next.js";
import type { Schedule } from "../src/shared/schedules.js";

// 1pm on Saturday 24 Oct local time (UTC+11).
const NOW = new Date("2026-10-24T02:00:00.000Z");
const schedule = (extra: Partial<Schedule>): Schedule =>
  ({ id: "mac:nightly", source: "mac", name: "Nightly tidy", what: "", on: true, group: "daily", nextRun: "2026-10-24T08:00:00.000Z", runs: [], lastRun: null, ...extra }) as unknown as Schedule;

describe("the Plan page's Next list", () => {
  it("spells a local time out the same way on every machine", () => {
    expect(nextWhen(new Date("2026-10-24T08:00:00.000Z"))).toBe("Sat 24 Oct, 7:00pm");
    expect(nextWhen(new Date("2026-10-23T13:05:00.000Z"))).toBe("Sat 24 Oct, 12:05am");
    expect(nextWhen(new Date("2026-10-24T01:00:00.000Z"))).toBe("Sat 24 Oct, 12:00pm");
    expect(nextWhen(new Date("2026-11-03T13:00:00.000Z"), true)).toBe("Wed 4 Nov");
  });

  it("lists daily and weekly schedules with a next run in the coming week, soonest first", () => {
    const rows = buildNext({
      now: NOW,
      schedules: [
        schedule({ id: "b", name: "Later", nextRun: "2026-10-26T01:00:00.000Z", group: "weekly" }),
        schedule({ id: "a", name: "Tonight" }),
      ],
    });
    expect(rows).toEqual([
      { key: "schedule:a", title: "Tonight", at: "2026-10-24T08:00:00.000Z", when: "Sat 24 Oct, 7:00pm", allDay: false, source: "schedule" },
      { key: "schedule:b", title: "Later", at: "2026-10-26T01:00:00.000Z", when: "Mon 26 Oct, 12:00pm", allDay: false, source: "schedule" },
    ]);
  });

  it("leaves out anything undated: turned off, always on, no next run, already past, or too far off", () => {
    const rows = buildNext({
      now: NOW,
      schedules: [
        schedule({ id: "off", on: false }),
        schedule({ id: "always", group: "always-on" }),
        schedule({ id: "all-day", group: "all-day" }),
        schedule({ id: "none", nextRun: null }),
        schedule({ id: "past", nextRun: "2026-10-24T01:00:00.000Z" }),
        schedule({ id: "far", nextRun: "2026-11-02T01:00:00.000Z" }),
      ],
    });
    expect(rows).toEqual([]);
    expect(buildNext({ now: NOW, schedules: null })).toEqual([]);
  });

  it("takes the Scheduled page's jobs, when they have a next run in the week", () => {
    const rows = buildNext({ now: NOW, schedules: [], jobs: [{ key: "j1", title: "Weekly tidy", at: "2026-10-25T00:00:00.000Z" }, { key: "j2", title: "Far", at: "2026-12-01T00:00:00.000Z" }] });
    expect(rows).toEqual([{ key: "job:j1", title: "Weekly tidy", at: "2026-10-25T00:00:00.000Z", when: "Sun 25 Oct, 11:00am", allDay: false, source: "job" }]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: MAX_NEXT_ROWS + 5 }, (_, i) => schedule({ id: `s${i}`, name: `Job ${i}`, nextRun: new Date(NOW.getTime() + (i + 1) * 60_000).toISOString() }));
    expect(buildNext({ now: NOW, schedules: many })).toHaveLength(MAX_NEXT_ROWS);
  });
});
