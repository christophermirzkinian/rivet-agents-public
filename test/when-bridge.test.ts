import { describe, expect, it } from "vitest";

// @ts-expect-error -- the bridge's plain-JS copy has no type declarations
import * as bridge from "../bridge/lib/when.mjs";
import { clock, dayDate, when } from "../src/shared/when.js";
import { etaWords } from "../web/src/views/plan-time.js";

// The bridge and the CLI say every time through bridge/lib/when.mjs, a copy of src/shared/when.ts's rule: the
// two must give the same words for the same instant, across a day's edges, a week's and both daylight-saving changes.

const NOWS = ["2026-10-26T09:22:00Z", "2026-10-03T15:30:00Z", "2026-04-04T14:30:00Z", "2026-12-31T12:59:00Z"].map(Date.parse);
const OFFSETS_H = [-24 * 9, -24 * 7, -24 * 6 - 5, -30, -13, -1, 0, 0.5, 2, 11, 14, 23, 25, 24 * 6 + 3, 24 * 7, 24 * 30];

describe("bridge when.mjs", () => {
  it("says every instant as src/shared/when.ts does", () => {
    const differ: string[] = [];
    for (const now of NOWS)
      for (const h of OFFSETS_H) {
        const at = now + h * 3600_000;
        for (const shape of [at, new Date(at).toISOString(), new Date(at)]) {
          if (bridge.when(shape, now) !== when(shape, now)) differ.push(`${new Date(at).toISOString()} at ${new Date(now).toISOString()}: ${bridge.when(shape, now)} vs ${when(shape, now)}`);
          if (bridge.clock(shape) !== clock(shape)) differ.push(`clock ${new Date(at).toISOString()}`);
          if (bridge.dated(shape) !== `${dayDate(shape)} ${clock(shape)}`) differ.push(`dated ${new Date(at).toISOString()}`);
        }
      }
    expect(differ).toEqual([]);
  });

  it("gives nothing for a time that does not parse, as when.ts does", () => {
    for (const bad of ["", "soon", Number.NaN, 9e15]) {
      expect(bridge.when(bad, NOWS[0])).toBe("");
      expect(bridge.dated(bad)).toBe("");
    }
  });
});

describe("Plan's eta words", () => {
  const written = "2026-10-26T06:10:00Z"; // 5:10pm local
  it("says an eta that names a time through when(), read at the record's write time", () => {
    expect(etaWords("60", written, written)).toBe("by 6:10pm");
    expect(etaWords("by 6pm", written, written)).toBe("by 6:00pm");
    expect(etaWords("9am", written, written)).toBe("by Tue 9:00am");
    expect(etaWords("tonight", written, written)).toBe("by 11:00pm");
  });

  it("says an ISO eta through when() even when it is before the write time or there is none", () => {
    expect(etaWords("2026-10-26T06:00:00Z", written, written)).toBe("by 5:00pm");
    expect(etaWords("2026-10-26T06:00:00Z", undefined, written)).toBe("by 5:00pm");
  });

  it("shows one it cannot read, or with no write time, as said", () => {
    expect(etaWords("by Sat 9:00am", written, written)).toBe("by Sat 9:00am");
    expect(etaWords("soon", written, written)).toBe("by soon");
    expect(etaWords("60")).toBe("in 60 min");
  });
});
