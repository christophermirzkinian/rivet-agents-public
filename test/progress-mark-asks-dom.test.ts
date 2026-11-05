// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ask } from "../src/shared/asks.js";
import { summarize } from "../src/shared/summary.js";
import { opsData } from "../web/src/ops-data.js";
import { app } from "../web/src/state.js";
import { navMark, opsStatus } from "../web/src/views/progress-mark.js";
import * as asks from "../web/src/views/your-asks.js";

// One rule lights the Progress mark, opens Rivet's own and colours a row amber: no time yet or moved twice, across
// Your asks and Rivet's own alike. The mark reads the summary GET /api/summary makes of the same asks; the
// rows count by the same functions (src/shared/summary.ts). A file of its own, since the asks read stays between tests.

const NOW = Date.parse("2026-10-20T05:00:00.000Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const QUEUE = [{ chat: "on-it", repo: "example-org/example-repo" as const, position: 1, at: 0 }];
const ask = (id: string, over: Partial<Ask> = {}): Ask => ({ id, chat: "on-it", words: `Ask ${id}`, who: "owner", stage: "building", prs: [], dueHistory: [], timeline: [], createdAt: at(-60), stageAt: at(-60), updatedAt: at(-60), version: 1, ...over });

const badge = () => {
  const el = navMark(opsStatus().mark);
  return el ? `${el.className}:${el.textContent}` : null;
};

let el: HTMLElement;

/** Your asks as the server serves `served`, mounted and read, with the summary the server makes of them. */
async function mountWith(served: Ask[]): Promise<void> {
  app.workers = { at: new Date(NOW).toISOString(), workers: [], pushQueue: QUEUE };
  app.summary = summarize({ needs: [], minimised: new Map(), board: null, crew: { workers: [], lapsed: false }, asks: served, statuses: [], queue: QUEUE, prs: [], merged: [], now: NOW });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ asks: served }), { status: 200, headers: { "content-type": "application/json" } })));
  asks.mount(el);
  await vi.waitFor(() => expect(asks.openAsks().map((one) => one.id)).toEqual(served.map((one) => one.id)));
}

const row = (id: string) => el.querySelector<HTMLElement>(`[data-ask="${id}"]`);
const fold = () => el.querySelector<HTMLButtonElement>('.plan-fold[data-fold="own"]');

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  el = document.createElement("div");
  document.body.replaceChildren(el);
  app.tab = "progress";
  app.board = null;
  opsData.ops = null;
  opsData.statuses = null;
});

afterEach(() => {
  asks.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("the Progress mark's one count", () => {
  it("lights for a Your asks row with no time yet, and not for one moved once", async () => {
    const moved = [{ at: at(-30), dueAt: at(60), was: at(-20), why: "tests were red" }];
    await mountWith([ask("once", { dueAt: at(60), dueHistory: moved })]);
    expect(row("once")!.classList.contains("is-counted")).toBe(false);
    expect(row("once")!.querySelector(".ask-when")!.className).toBe("ask-when is-moved");
    expect(badge()).toBeNull();
    await mountWith([ask("once", { dueAt: at(60), dueHistory: moved }), ask("passed", { dueAt: at(-10), askedForTimeAt: at(-5) })]);
    expect(row("passed")!.classList.contains("is-counted")).toBe(true);
    expect(row("passed")!.querySelector(".ask-when")!.textContent).toBe("No time yet, asked 3:55pm");
    expect(badge()).toBe("badge t-warn:!");
    expect(el.querySelectorAll(".ask-row.is-counted")).toHaveLength(1);
    expect(app.summary!.asks).toMatchObject({ noTime: 1, moved: 0 });
  });

  it("counts an amber No time yet pick-up: Rivet's own opens on its own and the mark lights", async () => {
    await mountWith([ask("pickup-passed", { who: "rivet", source: "pickup:ci/main", dueAt: at(-10) })]);
    expect(fold()!.getAttribute("aria-expanded")).toBe("true");
    expect(row("pickup-passed")!.classList.contains("is-counted")).toBe(true);
    expect(row("pickup-passed")!.querySelector(".ask-when")!.textContent).toBe("No time yet");
    expect(badge()).toBe("badge t-warn:!");
  });

  it("keeps a pick-up that never had a time plain: no amber, no mark, and the fold stays as it was", async () => {
    await mountWith([ask("pickup-never", { who: "rivet", source: "pickup:app/paper-trail", stage: "queued" })]);
    if (fold()!.getAttribute("aria-expanded") === "true") fold()!.click();
    asks.mount(el);
    expect(fold()!.getAttribute("aria-expanded")).toBe("false");
    fold()!.click();
    expect(row("pickup-never")!.classList.contains("is-counted")).toBe(false);
    expect(row("pickup-never")!.querySelector(".ask-when")).toBeNull();
    expect(app.summary!.asks).toMatchObject({ noTime: 0, moved: 0 });
    expect(badge()).toBeNull();
  });
});

describe("Your asks' count", () => {
  it("puts an ask nothing is moving in a closed Not moving fold, out of the number, and opens it on a tap", async () => {
    // Nothing reads as not moving until Ops has answered.
    opsData.ops = { now: new Date(NOW).toISOString(), github: { at: new Date(NOW).toISOString(), stale: false, prsComplete: true, prs: [], runs: [] } } as never;
    opsData.opsAt = { mono: performance.now(), wall: Date.now() };
    await mountWith([ask("moving", { dueAt: at(30) }), ask("still", { chat: "gone", dueAt: at(60) })]);
    expect(el.querySelector(".asks-head")!.textContent).toBe("In hand · 1");
    expect(app.summary!.asks.inHand).toBe(1);
    const fold = el.querySelector<HTMLElement>('.plan-fold[data-fold="still"]')!;
    expect(fold.textContent).toContain("Not moving · 1");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(row("still")).toBeNull();
    fold.click();
    expect(row("still")).not.toBeNull();
  });

  it("is the rows listed above the folds, a Needs-you row included, as the summary counts asks in hand", async () => {
    const moved = [
      { at: at(-30), dueAt: at(10), was: at(-20) },
      { at: at(-5), dueAt: at(60), was: at(10), why: "tests were red" },
    ];
    await mountWith([
      ask("timed", { dueAt: at(30) }),
      ask("passed", { dueAt: at(-10) }),
      ask("twice", { who: "owner", dueAt: at(60), dueHistory: moved }),
      ask("waiting-on-you", { stage: "needs-you" }),
      ask("mine", { who: "rivet", dueAt: at(-5) }),
      ask("shipped", { stage: "done", stageAt: at(-5) }),
    ]);
    const shown = el.querySelectorAll(".your-asks > .asks-rows:first-of-type > li");
    expect(row("waiting-on-you")!.closest(".asks-rows")).toBe(el.querySelector(".your-asks > .asks-rows"));
    expect(shown).toHaveLength(4);
    expect(el.querySelector(".asks-head")!.textContent).toBe(`In hand · ${shown.length}`);
    expect(app.summary!.asks.inHand).toBe(shown.length);
    // Rivet's own folds; Done today is a list; no Could start next.
    expect([...el.querySelectorAll<HTMLElement>(".plan-fold")].map((one) => one.dataset.fold)).toEqual(["own"]);
    expect(el.textContent).not.toContain("Could start next");
    // The mark counts the amber rows, Rivet's own included, and never the Needs-you one (its card counts it).
    expect(app.summary!.asks).toMatchObject({ noTime: 2, moved: 1 });
    expect(badge()).toBe("badge t-warn:!");
  });
});

describe("Your asks' reads and rows", () => {
  it("opens the card a Needs-you ask names", async () => {
    app.board = { board: { needs: [{ id: "agent-5", kind: "question", title: "Ask n", rev: "r1" }] } } as never;
    await mountWith([ask("n", { stage: "needs-you", cardId: "agent-5" })]);
    const go = row("n")!;
    expect(go.tagName).toBe("BUTTON");
    expect(go.querySelector(".ask-when")!.textContent).toBe("Needs you ›");
    go.click();
    await vi.waitFor(() => expect(app.front).toBe("agent-5"));
  });

  it("opens Cards on Needs you for a Needs-you ask that another card stands for", async () => {
    app.board = { board: { needs: [{ id: "agent-17", kind: "question", title: "Merge #17?", pr: 17, rev: "r1" }] } } as never;
    app.tab = "progress";
    const { chat: _chat, ...bare } = ask("p", { stage: "needs-you", prs: [17] });
    await mountWith([bare]);
    const go = row("p")!;
    expect(go.tagName).toBe("BUTTON");
    go.click();
    await vi.waitFor(() => expect(app.tab).toBe("cards"));
  });

  it("keeps the latest read when an older one lands after it", async () => {
    const replies: ((served: Ask[]) => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((done) => replies.push((served) => done(new Response(JSON.stringify({ asks: served }), { status: 200, headers: { "content-type": "application/json" } }))))),
    );
    const older = asks.refresh();
    const newer = asks.refresh();
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    replies[1]!([ask("newer")]);
    await newer;
    replies[0]!([]);
    await older;
    expect(asks.openAsks().map((one) => one.id)).toEqual(["newer"]);
  });
});

describe("Progress's folds on a fresh visit", () => {
  it("opens with every list folded again, however the last visit left them", async () => {
    const served = [ask("mine"), ask("pickup-never", { who: "rivet", source: "pickup:app/paper-trail", stage: "queued" })];
    await mountWith(served);
    fold()!.click();
    expect(fold()!.getAttribute("aria-expanded")).toBe("true");
    asks.unmount();
    await mountWith(served);
    expect(fold()!.getAttribute("aria-expanded")).toBe("false");
    expect(row("pickup-never")).toBeNull();
  });
});
