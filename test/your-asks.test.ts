import { describe, expect, it } from "vitest";

import type { Ask } from "../src/shared/asks.js";
import { askRows } from "../web/src/views/your-asks.js";

const NOW = new Date(2026, 9, 20, 16, 0).getTime();
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const ask = (id: string, over: Partial<Ask> = {}): Ask => ({
  id,
  words: `Ask ${id}`,
  who: "owner",
  stage: "queued",
  prs: [],
  dueHistory: [],
  timeline: [],
  createdAt: at(-60),
  stageAt: at(-60),
  updatedAt: at(-60),
  version: 1,
  ...over,
});

describe("Your asks", () => {
  it("lists the open asks newest first, with their stage, PR and chat on one line", () => {
    const { open } = askRows([ask("old", { createdAt: at(-120) }), ask("new", { stage: "building", progress: 0.4, prs: [7], chat: "lab-rates" })], NOW);
    expect(open.map((row) => row.id)).toEqual(["new", "old"]);
    expect(open[0]).toMatchObject({ title: "Ask new", progress: 0.4, go: { chat: "lab-rates", repo: undefined } });
    expect(open[0]!.sub).toContain("#7");
  });

  it("opens a needs-you ask's card, and says it needs you", () => {
    const { open } = askRows([ask("n", { stage: "needs-you", cardId: "c-1" })], NOW);
    expect(open[0]).toMatchObject({ tone: "needs", go: { card: "c-1" } });
  });

  it("gives an ask due later its time, and one whose time passed no time yet", () => {
    const { open } = askRows([ask("due", { dueAt: at(90), createdAt: at(-1) }), ask("late", { dueAt: at(-5) })], NOW);
    expect(open.map((row) => row.tone)).toEqual(["due", "asked"]);
    expect(open[0]!.right).toMatch(/^by /);
  });

  it("keeps only the asks finished today on this phone, newest first, and never a parked one", () => {
    const yesterday = new Date(2026, 9, 19, 23, 0).toISOString();
    const { open, finished } = askRows(
      [ask("a", { stage: "shipped", stageAt: at(-30) }), ask("b", { stage: "shipped", stageAt: at(-10) }), ask("c", { stage: "shipped", stageAt: yesterday }), ask("p", { stage: "parked", stageAt: at(-5) })],
      NOW,
    );
    expect(open).toEqual([]);
    expect(finished.map((row) => row.id)).toEqual(["b", "a"]);
    expect(finished.every((row) => row.tone === "finished")).toBe(true);
  });
});
