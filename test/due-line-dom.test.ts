// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Ask } from "../src/shared/asks.js";
import { when } from "../src/shared/when.js";
import { askLine, DONE_MAX, DONE_MIN, doneAsks, dueLine, dueTitle, dueWords } from "../web/src/views/due-line.js";
import { chatLabel, CHUNK_GAP_MS, startsChunk } from "../web/src/views/chat.js";

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
        ask("a-3", "Needs a word", { stage: "needs-you", dueAt: at(-30) }),
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

describe("Chat's due button, a plain clock in the head", () => {
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const serve = (asks: Ask[]) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ asks }), { status: 200, headers: { "content-type": "application/json" } }))),
    );
  const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

  afterEach(() => vi.unstubAllGlobals());

  it("is hidden while nothing in hand has a time", async () => {
    serve([ask("a-1", "No time")]);
    const due = dueLine(() => {});
    await settle();
    expect(due.el.matches("button.chat-due")).toBe(true);
    expect(due.el.hidden).toBe(true);
    expect(due.el.children).toHaveLength(0);
  });

  it("shows a clock and no time or title, the words only in its label", async () => {
    const dueAt = soon(20);
    serve([ask("a-2", "Later", { dueAt: soon(90) }), ask("a-1", "Sooner", { short: "Results row", dueAt })]);
    const due = dueLine(() => {});
    await settle();
    expect(due.el.hidden).toBe(false);
    expect(due.el.dataset.use).toBe("chat.due.open");
    expect(due.el.classList.contains("late")).toBe(false);
    expect(due.el.textContent).toBe("");
    expect(due.el.children).toHaveLength(1);
    expect(due.el.querySelector(":scope > .icon-btn-icon svg")).not.toBeNull();
    expect(due.el.getAttribute("aria-label")).toBe(`Next ${when(dueAt)} · Results row, 1 more. Show what is done and due`);
    // Another read keeps the one clock.
    due.refresh();
    await settle();
    expect(due.el.children).toHaveLength(1);
    // Off over a thing's page.
    due.setActive(false);
    expect(due.el.hidden).toBe(true);
  });

  it("turns late while an ask is past its time, and says the late time in its label", async () => {
    const dueAt = soon(-40);
    serve([ask("a-1", "Late one", { short: "Pipeline month", dueAt })]);
    const due = dueLine(() => {});
    await settle();
    expect(due.el.hidden).toBe(false);
    expect(due.el.classList.contains("late")).toBe(true);
    expect(due.el.textContent).toBe("");
    expect(due.el.getAttribute("aria-label")).toBe(`Late ${when(dueAt)} · Pipeline month. Show what is done and due`);
  });
});

describe("Chat's Done tab", () => {
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const serve = (asks: Ask[]) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ asks }), { status: 200, headers: { "content-type": "application/json" } }))),
    );
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("lists deployed and done asks newest first, never parked, in hand or a pick-up", () => {
    const { list } = doneAsks(
      [
        ask("a-1", "Old", { stage: "done", stageAt: at(-300) }),
        ask("a-2", "New", { stage: "shipped", stageAt: at(-10) }),
        ask("a-3", "Parked", { stage: "parked", stageAt: at(-5) }),
        ask("a-4", "Building", { stageAt: at(-1) }),
        ask("a-5", "Picked up", { stage: "done", source: "pickup:ops-9", stageAt: at(-2) }),
      ],
      NOW,
    );
    expect(list.map((one) => one.id)).toEqual(["a-2", "a-1"]);
  });

  it("keeps the last day, at least the last few on a quiet day, at most a page", () => {
    const hours = (n: number, h: number) => Array.from({ length: n }, (_, i) => ask(`a-${h}-${i}`, "x", { stage: "done", stageAt: at(-h * 60 - i) }));
    // Two today and six older: the last DONE_MIN, two of them today.
    expect(doneAsks([...hours(2, 1), ...hours(6, 30)], NOW)).toMatchObject({ list: { length: DONE_MIN }, today: 2 });
    // Eight today and six older: the day's eight only.
    expect(doneAsks([...hours(8, 1), ...hours(6, 30)], NOW).list).toHaveLength(8);
    // A stage time well ahead of this clock is not today's.
    expect(doneAsks([ask("a-9", "x", { stage: "done", stageAt: at(60) })], NOW).today).toBe(0);
    // A busy day stops at a page.
    expect(doneAsks(hours(DONE_MAX + 5, 1), NOW).list).toHaveLength(DONE_MAX);
  });

  it("shows the clock while something was done in the last day, even with nothing timed", async () => {
    serve([ask("a-1", "Shipped", { stage: "shipped", stageAt: ago(2) })]);
    const due = dueLine(() => {});
    await settle();
    expect(due.el.hidden).toBe(false);
    expect(due.el.classList.contains("late")).toBe(false);
    expect(due.el.getAttribute("aria-label")).toBe("Nothing has a time. Show what is done and due");
  });

  it("stays hidden when the only done asks are older than a day", async () => {
    serve([ask("a-1", "Shipped", { stage: "shipped", stageAt: ago(30) })]);
    const due = dueLine(() => {});
    await settle();
    expect(due.el.hidden).toBe(true);
  });

  it("opens on Up next, and the Done tab lists what finished with its time, stage and PR", async () => {
    const jump = vi.fn();
    const shipped = ago(2);
    serve([
      ask("a-2", "Next one", { short: "Results row", dueAt: new Date(Date.now() + 3_600_000).toISOString() }),
      ask("a-1", "Shipped", { short: "Photo album", stage: "shipped", stageAt: shipped, prs: [12], source: "message:m7" }),
    ]);
    const due = dueLine(jump);
    document.body.append(due.el);
    await settle();
    due.el.click();
    const tabs = [...document.querySelectorAll<HTMLElement>(".chat-due-tab")];
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual(["Done, 1", "Up next, 1"]);
    expect(tabs.map((tab) => tab.dataset.useValue)).toEqual(["1", "2"]);
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".chat-due-pane")!.textContent).toContain("Results row");
    tabs[0]!.click();
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    const row = document.querySelector<HTMLButtonElement>(".chat-due-pane .chat-due-row.done")!;
    expect(row.textContent).toContain("Photo album");
    expect(row.querySelector("small")!.textContent).toBe("Deployed · a-1 · #12");
    expect(row.querySelector(".chat-due-row-time")!.textContent).toBe(when(shipped));
    row.click();
    expect(jump).toHaveBeenCalledWith("m7");
  });

  it("opens on Done when nothing has a time", async () => {
    serve([ask("a-1", "Shipped", { stage: "done", stageAt: ago(1) })]);
    const due = dueLine(() => {});
    await settle();
    due.el.click();
    expect(document.querySelector('.chat-due-tab[data-tab="done"]')!.getAttribute("aria-selected")).toBe("true");
  });
});

describe("Chat's chunk headings", () => {
  // 00:00Z on 1 Jan 2030 is 11am in local; its midnight is 13:00Z.
  const at = (minutes: number) => new Date(Date.UTC(2030, 0, 1, 0, minutes)).toISOString();

  it("the first line starts a chunk", () => {
    expect(startsChunk(at(0), undefined)).toBe(true);
    expect(startsChunk(at(0), "not a time")).toBe(true);
  });

  it("a line within the hour, on the same day, does not", () => {
    expect(startsChunk(at(5), at(0))).toBe(false);
    expect(startsChunk(at(59), at(0))).toBe(false);
    expect(startsChunk(new Date(Date.parse(at(0)) + CHUNK_GAP_MS - 1).toISOString(), at(0))).toBe(false);
  });

  it("an hour or more since the line before does", () => {
    expect(CHUNK_GAP_MS).toBe(60 * 60_000);
    expect(startsChunk(at(60), at(0))).toBe(true);
    expect(startsChunk(at(200), at(0))).toBe(true);
  });

  it("a new local day does, however short the gap", () => {
    expect(startsChunk(at(785), at(775))).toBe(true);
    // The same ten minutes either side of midnight UTC, mid-morning in local, do not.
    expect(startsChunk(at(1445), at(1435))).toBe(false);
  });

  it("a line with no time, or one that does not parse, starts none", () => {
    expect(startsChunk(undefined, at(0))).toBe(false);
    expect(startsChunk(undefined, undefined)).toBe(false);
    expect(startsChunk("not a time", at(0))).toBe(false);
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
