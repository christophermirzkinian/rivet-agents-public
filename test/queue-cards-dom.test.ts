// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { comingBar, comingFill } from "../web/src/views/queue-cards.js";

describe("the coming bar", () => {
  it("marks the stage on a bar through every stage, and none on an old title-only item", () => {
    const bar = comingBar({ pr: 2480, title: "Search box: results row", app: "Search box", stage: "review", etaMinutes: 20, updatedAt: "2026-09-30T01:55:00Z" })!;
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(bar.querySelectorAll(".qc-tick")).toHaveLength(5);
    expect(bar.querySelector<HTMLElement>(".qc-fill")!.style.width).toBe("25.00%");
    expect(bar.querySelector<HTMLElement>(".qc-tick")!.style.left).toBe("16.67%");
    expect(comingBar({ title: "Price chart", stage: "shipped" })!.classList.contains("done")).toBe(true);
    expect(comingBar({ title: "Admin switch" })).toBeNull();
  });

  it("keeps progress inside the stage's share of the bar", () => {
    expect(comingFill({ stage: "building", progress: 0.9 })).toBeCloseTo(1 / 6);
    expect(comingFill({ stage: "merging", progress: 0 })).toBeCloseTo(3 / 6);
    expect(comingFill({ stage: "review" })).toBeCloseTo(1.5 / 6);
    expect(comingFill({ progress: 0.4 })).toBe(0.4);
    expect(comingFill({})).toBeNull();
  });
});
