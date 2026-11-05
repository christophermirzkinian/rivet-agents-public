import { describe, expect, it } from "vitest";

import { AREA_TABLE, areaMatches, FOLD_IDS, USAGE_AREAS, USAGE_IDS, usageArea } from "../src/shared/usage-ids.js";

// What you used's folds (Sam, 3 Nov): every registry id lands in exactly one area, from the one table.

describe("What you used's areas", () => {
  it("puts every registry id in exactly one area, and every removed one in Removed", () => {
    const stray = USAGE_IDS.filter((entry) => areaMatches(entry).length !== 1).map((entry) => `${entry.id}: ${areaMatches(entry).join(", ") || "none"}`);
    expect(stray).toEqual([]);
    for (const entry of USAGE_IDS) expect(usageArea(entry)).toBe(entry.removed ? "Removed" : areaMatches(entry)[0]);
    expect(USAGE_IDS.filter((entry) => entry.removed).every((entry) => usageArea(entry) === "Removed")).toBe(true);
  });

  it("names only real screens and registry groups, and leaves no area empty", () => {
    const screens = new Set(USAGE_IDS.filter((entry) => entry.kind === "screen").map((entry) => entry.id));
    const groups = new Set(USAGE_IDS.filter((entry) => entry.kind !== "screen").map((entry) => entry.where));
    for (const [area, { where, screens: named }] of Object.entries(AREA_TABLE)) {
      for (const id of named) expect(screens, `${area}: ${id}`).toContain(id);
      for (const group of where) expect(groups, `${area}: ${group}`).toContain(group);
    }
    const shown = new Set(FOLD_IDS.map(usageArea));
    expect(USAGE_AREAS.filter((area) => !shown.has(area))).toEqual([]);
  });
});
