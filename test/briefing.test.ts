import { describe, expect, it } from "vitest";

import type { Briefing } from "../src/shared/ops.js";
import { composedLabel, sinceLabel } from "../web/src/views/briefing.js";

const briefing: Briefing = {
  id: "2026-09-28-morning", slot: "morning", day: "2026-09-28",
  at: "2026-09-27T21:30:00.000Z", composedAt: "2026-09-27T21:31:00.000Z",
  since: "2026-09-27T08:00:00.000Z", headline: "Morning briefing",
  items: [], shippedSeen: [], seen: [], notes: [],
};

// Expected clocks use standard time in September and daylight-saving time in summer.
const cases = [
  {
    name: "the same local day, even on the previous UTC day", day: "2026-09-28",
    at: "2026-09-27T21:30:00Z", now: "2026-09-28T02:00:00Z",
    since: "Since earlier today, 7:30am", composed: "at 7:30am",
  },
  {
    name: "the previous local day", day: "2026-09-28",
    at: "2026-09-27T08:00:00Z", now: "2026-09-28T02:00:00Z",
    since: "Since yesterday, 6:00pm", composed: "at 6:00pm yesterday",
  },
  {
    name: "an older local date", day: "2026-09-28",
    at: "2026-08-01T08:00:00Z", now: "2026-09-28T02:00:00Z",
    since: "Since Sat 1 Aug", composed: "at 6:00pm Sat 1 Aug",
  },
  {
    name: "an older date that crosses the UTC year boundary", day: "2026-09-28",
    at: "2025-12-31T21:00:00Z", now: "2026-09-28T02:00:00Z",
    since: "Since Thu 1 Jan", composed: "at 8:00am Thu 1 Jan",
  },
  {
    name: "one minute before local midnight, given in UTC", day: "2026-09-28",
    at: "2026-09-27T13:59:00Z", now: "2026-09-27T14:05:00Z",
    since: "Since yesterday, 11:59pm", composed: "at 11:59pm yesterday",
  },
  {
    name: "one minute after local midnight, on the same UTC day", day: "2026-09-28",
    at: "2026-09-27T14:01:00Z", now: "2026-09-27T14:05:00Z",
    since: "Since earlier today, 12:01am", composed: "at 12:01am",
  },
  // Daylight saving starts on the first Sunday in October 2026, 4 Oct: 1:59am jumps to 3:00am.
  {
    name: "just before daylight saving starts on Sun 4 Oct", day: "2026-10-04",
    at: "2026-10-03T15:59:00Z", now: "2026-10-04T01:00:00Z",
    since: "Since earlier today, 1:59am", composed: "at 1:59am",
  },
  {
    name: "just after daylight saving starts on Sun 4 Oct", day: "2026-10-04",
    at: "2026-10-03T16:00:00Z", now: "2026-10-04T01:00:00Z",
    since: "Since earlier today, 3:00am", composed: "at 3:00am",
  },
  {
    name: "yesterday across October's 23-hour local day", day: "2026-10-05",
    at: "2026-10-03T14:30:00Z", now: "2026-10-04T13:30:00Z",
    since: "Since yesterday, 12:30am", composed: "at 12:30am yesterday",
  },
  // It ends on the first Sunday in April 2026, 5 Apr: 2:59am goes back to 2:00am.
  {
    name: "just before daylight saving ends on Sun 5 Apr", day: "2026-04-05",
    at: "2026-04-04T15:59:00Z", now: "2026-04-05T02:00:00Z",
    since: "Since earlier today, 2:59am", composed: "at 2:59am",
  },
  {
    name: "just after daylight saving ends on Sun 5 Apr", day: "2026-04-05",
    at: "2026-04-04T16:00:00Z", now: "2026-04-05T02:00:00Z",
    since: "Since earlier today, 2:00am", composed: "at 2:00am",
  },
  {
    name: "yesterday across April's 25-hour local day", day: "2026-04-06",
    at: "2026-04-04T13:30:00Z", now: "2026-04-05T14:30:00Z",
    since: "Since yesterday, 12:30am", composed: "at 12:30am yesterday",
  },
];

describe("sinceLabel", () => {
  it.each(cases)("labels $name", ({ day, at, since }) => {
    expect(sinceLabel({ ...briefing, day, since: at })).toBe(since);
  });
});

describe("composedLabel", () => {
  it.each(cases)("labels $name", ({ at, now, composed }) => {
    expect(composedLabel({ ...briefing, composedAt: at }, Date.parse(now))).toBe(composed);
  });

  it("uses the supplied now rather than the snapshot's day", () => {
    const snapshot = { ...briefing, day: "2026-10-26", since: "2026-10-25T20:30:00Z", composedAt: "2026-10-25T20:31:00Z" };
    expect(sinceLabel(snapshot)).toBe("Since earlier today, 7:30am");
    expect(composedLabel(snapshot, Date.parse("2026-10-27T02:00:00Z"))).toBe("at 7:31am yesterday");
    expect(composedLabel(snapshot, Date.parse("2026-10-28T02:00:00Z"))).toBe("at 7:31am Mon 26 Oct");
  });
});
