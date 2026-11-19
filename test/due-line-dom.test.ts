// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import type { Ask } from "../src/shared/asks.js";
import { askLine, dueTitle, dueWords } from "../web/src/views/due-line.js";
import { chatLabel } from "../web/src/views/chat.js";

const NOW = Date.parse("2026-11-19T07:00:00.000Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const ask = (id: string, words: string, over: Partial<Ask> = {}): Ask => ({
  id,
  words,
  who: "owner",
  stage: "building",
  prs: [],
  dueHistory: [],
  timeline: [],
  createdAt: at(-60),
  stageAt: at(-60),
  updatedAt: at(-60),
  version: 1,
  ...over,
});
const title = (one: Ask) => dueTitle(one);

describe("Chat's due line", () => {
  it("is hidden when nothing unfinished has a time", () => {
    expect(dueWords([], NOW, title)).toBeNull();
    expect(dueWords([ask("a-1", "No time"), ask("a-2", "Done", { stage: "done", dueAt: at(-5) })], NOW, title)).toBeNull();
  });

  it("names the next ask by its time, and how many more", () => {
    const words = dueWords([ask("a-2", "Later", { dueAt: at(90) }), ask("a-1", "Sooner", { short: "Results row", dueAt: at(20) })], NOW, title);
    expect(words).toMatchObject({ late: 0, title: "Results row", more: 1 });
    expect(words!.time).toBeTruthy();
  });

  it("leads with what is late, the soonest past first", () => {
    const words = dueWords(
      [ask("a-3", "Next one", { dueAt: at(30) }), ask("a-2", "Late two", { dueAt: at(-10) }), ask("a-1", "Late one", { short: "Pipeline month", dueAt: at(-40) })],
      NOW,
      title,
    );
    expect(words).toMatchObject({ late: 2, title: "Pipeline month", more: 2 });
  });

  it("leaves out an ask waiting on the owner and a pick-up, as the server's late rule does", () => {
    const words = dueWords(
      [
        ask("a-3", "Needs him", { stage: "needs-you", dueAt: at(-30) }),
        ask("a-2", "Picked up", { source: "pickup:ops-9", dueAt: at(-20) }),
        ask("a-1", "In hand", { dueAt: at(15) }),
      ],
      NOW,
      title,
    );
    expect(words).toMatchObject({ late: 0, title: "In hand", more: 0 });
  });

  it("cuts long words to a short title", () => {
    expect(dueTitle(ask("a-1", "Make the checkout results row thirty percent taller on the phone"))).toMatch(/…$/);
    expect(dueTitle(ask("a-1", "Words"), "Its conversation")).toBe("Its conversation");
  });

  it("goes to the line the ask was asked in, else the line it answered", () => {
    expect(askLine(ask("a-1", "x", { source: "message:m9" }))).toBe("m9");
    expect(askLine(ask("a-1", "x", { replyId: "m4" }))).toBe("m4");
    expect(askLine(ask("a-1", "x"))).toBeNull();
  });
});

describe("a run's label on Chat", () => {
  it("is the ask id and title, else the title, Update for Updates", () => {
    expect(chatLabel({ title: "Checkout results row", ask: "a-12" })).toBe("a-12 · Checkout results row");
    expect(chatLabel({ title: "Checkout results row" })).toBe("Checkout results row");
    expect(chatLabel({ title: "Updates", updates: true })).toBe("Update");
    expect(chatLabel(undefined)).toBeNull();
  });
});
