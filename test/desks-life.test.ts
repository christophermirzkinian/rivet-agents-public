// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NEEDS_YOU } from "../src/shared/words.js";

import type { Ask } from "../src/shared/asks.js";
import type { TimelineEvent, TimelineResponse } from "../src/shared/ops.js";
import type { Worker } from "../src/shared/workers.js";

const { agentLines, mergedBy, placeBubble, recentMerges, short } = await import("../web/src/views/desks-life.js");
const { mountDesks } = await import("../web/src/views/desks.js");
const { app, changed } = await import("../web/src/state.js");
const { opsData } = await import("../web/src/ops-data.js");
const { MOOD_WORDS } = await import("../web/src/rivet/rivet.js");

const MS = "example-org/example-repo";
const NOW = Date.parse("2026-10-25T09:00:00+11:00");

function worker(id: string, name: string, extra: Partial<Worker> = {}): Worker {
  return { id, name, repo: MS, chat: `chat-${id}`, state: "working", lastOutputAt: NOW - 30_000, ...extra } as Worker;
}

function merge(number: number, minutesAgo: number, extra: Partial<TimelineEvent> = {}): TimelineEvent {
  return { kind: "merged", at: new Date(NOW - minutesAgo * 60_000).toISOString(), repo: "example-repo", title: `PR ${number} (#${number})`, number, ...extra };
}

const timeline = (...events: TimelineEvent[]): TimelineResponse => ({ days: [{ day: "2026-10-25", events }], repos: ["example-repo"] });

/** Never a time or a duration: the 2026-10-24 rule, kept in the bubbles too. */
const TIMEY = /\d{1,2}:\d{2}|\b(am|pm|min|mins|minutes?|hours?|by)\b|no time/i;

describe("what an agent says", () => {
  it("says only what its record holds, never a time and never its name", () => {
    const riley = worker("r", "Riley", { what: "Chart idle loop", stage: "Checking it on a phone", progress: 0.45, etaMinutes: 20, updatedAt: new Date(NOW).toISOString() });
    const lines = agentLines(riley);
    expect(lines).toEqual(["Checking it on a phone: Chart idle loop", "Chart idle loop: 45% done"]);
    for (const line of lines) {
      expect(line).not.toMatch(TIMEY);
      expect(line).not.toContain("Riley");
    }
  });

  it("puts a wait on you first, and your OK as the wait it is", () => {
    expect(agentLines(worker("a", "Nina", { state: "waiting" }))).toEqual([NEEDS_YOU]);
    // Waiting with no open decision card (its seat has no ?): it does not say Needs you (review R1.9).
    expect(agentLines(worker("a", "Nina", { state: "waiting" }), [], undefined, false)).not.toContain(NEEDS_YOU);
    expect(agentLines(worker("a", "Nina", { state: "waiting", what: "Duel skill video", progress: 0.5 }))).toEqual([`${NEEDS_YOU}: Duel skill video`]);
    expect(agentLines(worker("b", "Otto", { needsYou: true, delivering: { title: "Smoker app", stage: "owner-ok" } }))).toEqual([
      NEEDS_YOU,
      `${NEEDS_YOU}: Smoker app`,
    ]);
    expect(agentLines(worker("c", "Ivy", { delivering: { title: "Runner image refresh", stage: "review" } }))).toEqual(["In review: Runner image refresh"]);
  });

  it("says its chat's ask row when it has one, in step with Your asks, never the record", () => {
    const at = new Date(NOW).toISOString();
    const row = (over: Partial<Ask>): Ask =>
      ({ id: "1", words: "Search box polish", who: "owner", stage: "building", prs: [], dueHistory: [], timeline: [], createdAt: at, stageAt: at, updatedAt: at, version: 1, ...over }) as Ask;
    const otto = worker("o", "Otto", { what: "Old record words", stage: "Checking it on a phone", progress: 0.9 });
    expect(agentLines(otto, [], row({ progress: 0.4 }))).toEqual(["Building: Search box polish", "Search box polish: 40% done"]);
    expect(agentLines(otto, [], row({ stage: "review", progress: 0.4 }))).toEqual(["In review: Search box polish"]);
    // Its ask's own merge still comes first; an older PR the chat still lists never pushes the row's words out (review R2.1).
    const merged = agentLines({ ...otto, prs: [419] }, [merge(419, 2, { title: "Search polish" })], row({ prs: [419] }));
    expect(merged).toEqual(["Merged: Search polish", "Building: Search box polish"]);
    const older = agentLines({ ...otto, prs: [419, 420] }, [merge(419, 2, { title: "Search polish" })], row({ prs: [420], progress: 0.4 }));
    expect(older).toEqual(["Building: Search box polish", "Search box polish: 40% done"]);
    for (const line of agentLines(otto, [], row({ dueAt: new Date(NOW + 3600_000).toISOString() }))) expect(line).not.toMatch(TIMEY);
  });

  it("makes nothing up: a record with nothing to say says nothing", () => {
    expect(agentLines(worker("a", "Nina"))).toEqual([]);
    expect(agentLines(worker("a", "Nina", { state: "idle", what: "Lobby" }))).toEqual([]);
    expect(agentLines(worker("a", "Nina", { what: "Lobby" }))).toEqual(["Building: Lobby"]);
  });

  it("says its own merge first, and keeps to two short lines", () => {
    const jordan = worker("j", "Jordan", { what: "Search review fixes", stage: "Merging", progress: 0.9, prs: [419] });
    const lines = agentLines(jordan, [merge(419, 2, { title: "Results: the review's three fixes" })]);
    // A merge's PR title runs to a short title too: the server's when it sent one, else cut at a word.
    expect(lines).toEqual(["Merged: Results: the review's three…", "Merging: Search review fixes"]);
    expect(agentLines(jordan, [merge(419, 2, { title: "Results: the review's three fixes", short: "Results: review fixes" })])[0]).toBe("Merged: Results: review fixes");
    expect(short("A very long description of the work that keeps going and going past the limit", 30)).toBe("A very long description of…");
  });
});

describe("Rivet's news", () => {
  it("is the merges and ships of the last 12 hours, newest first", () => {
    const read = timeline(merge(1, 60), merge(2, 5), merge(3, 13 * 60), { ...merge(4, 1), kind: "deploy" }, { ...merge(5, 30), kind: "shipped" });
    expect(recentMerges(read, NOW).map((event) => event.number)).toEqual([2, 5, 1]);
  });

  it("finds the agent whose PR merged by branch, PR or Coming item, in its own repo only", () => {
    const crew = [worker("a", "Nina", { branch: "fix/lobby" }), worker("b", "Otto", { prs: [12] }), worker("c", "Ivy", { delivering: { pr: 13, title: "x", stage: "merging" } })];
    expect(mergedBy(merge(11, 1, { branch: "fix/lobby" }), crew)?.id).toBe("a");
    expect(mergedBy(merge(12, 1), crew)?.id).toBe("b");
    expect(mergedBy(merge(13, 1), crew)?.id).toBe("c");
    expect(mergedBy(merge(12, 1, { repo: "other-repo" }), crew)).toBeUndefined();
  });
});

describe("where a bubble stands", () => {
  const room = { x: 0, y: 0, w: 400, h: 400 };
  const by = { x: 180, y: 180, w: 40, h: 40 };

  it("never on a name, a bubble or the speaker", () => {
    const spot = placeBubble({ w: 120, h: 30 }, by, room, [{ x: 100, y: 120, w: 200, h: 50 }], [])!;
    expect(spot.side).toBe("below");
    expect(spot.y).toBeGreaterThanOrEqual(by.y + by.h);
  });

  it("nowhere when there is no room", () => {
    expect(placeBubble({ w: 380, h: 300 }, by, room, [], [])).toBeNull();
  });

  it("over as little else as it can", () => {
    expect(placeBubble({ w: 120, h: 30 }, by, room, [], [{ x: 0, y: 0, w: 400, h: 175 }])!.side).toBe("below");
  });
});

/** A floor laid out by hand: happy-dom lays nothing out. Rivet up top, each agent's square on its own row. */
function layOut(reduced: boolean, wide?: (el: HTMLElement) => [number, number, number, number] | null): void {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }));
  const box = (el: HTMLElement): [number, number, number, number] => {
    const own = wide?.(el);
    if (own) return own;
    if (el.classList.contains("desks")) return [0, 0, 412, 900];
    if (el.classList.contains("desks-say")) {
      const max = parseFloat(el.style.maxWidth) || 260;
      return [parseFloat(el.style.left) || 0, parseFloat(el.style.top) || 0, Math.min(max, (el.textContent ?? "").length * 8 + 24), 37];
    }
    if (el.classList.contains("rivet")) {
      if (el.closest(".desk.is-rivet")) return [168, 120, 76, 76];
      const rows = [...document.querySelectorAll(".desk-agent .rivet")];
      return [40, 320 + rows.indexOf(el) * 110, 36, 36];
    }
    return [-5000, -5000, 0, 0];
  };
  type Size = "offsetLeft" | "offsetTop" | "offsetWidth" | "offsetHeight" | "clientWidth" | "clientHeight";
  const spy = (key: Size, get: (el: HTMLElement) => number) =>
    vi.spyOn(HTMLElement.prototype, key, "get").mockImplementation(function (this: HTMLElement) {
      return get(this);
    });
  spy("offsetLeft", (el) => box(el)[0]);
  spy("offsetTop", (el) => box(el)[1]);
  spy("offsetWidth", (el) => box(el)[2]);
  spy("offsetHeight", (el) => box(el)[3]);
  spy("clientWidth", (el) => box(el)[2]);
  spy("clientHeight", (el) => box(el)[3]);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const [x, y, w, h] = box(this);
    return { x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON() {} } as DOMRect;
  });
}

const CREW = [
  worker("a", "Nina", { what: "Chart redesign", progress: 0.4 }),
  worker("b", "Otto", { state: "waiting", what: "Duel skill video" }),
  worker("c", "Ivy", { what: "Price feed retries", stage: "Checking it on a phone" }),
];

let stops: (() => void)[] = [];
function mount(): HTMLElement {
  app.workersAt = Date.now();
  app.workers = { at: new Date().toISOString(), workers: CREW };
  const desks = mountDesks();
  stops.push(desks.stop);
  document.body.append(desks.el);
  changed();
  return desks.el;
}

const said = (el: HTMLElement) => [...el.querySelectorAll(".desks-say")].map((bubble) => bubble.textContent ?? "");

describe("the floor's life", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "requestAnimationFrame", "cancelAnimationFrame"] });
    opsData.timeline = null;
  });

  afterEach(() => {
    for (const stop of stops) stop();
    stops = [];
    app.workers = null;
    app.workersAt = null;
    app.board = null;
    opsData.timeline = null;
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("with reduced motion, nobody flies and the bubbles stand still", () => {
    layOut(true);
    const el = mount();
    vi.advanceTimersByTime(2_000);
    const first = said(el);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(2);
    vi.advanceTimersByTime(30_000);
    expect(said(el)).toEqual(first);
    expect(el.querySelector(".is-away, .has-away, .desk-burst")).toBeNull();
    expect([...el.querySelectorAll<HTMLElement>(".desk-agent .rivet")].every((bot) => !bot.style.transform)).toBe(true);
  });

  it("with motion, agents take turns: one or two bubbles at a time, each its own record's words", () => {
    // The rolls that choose a trip are fixed (a small seeded generator), so who flies where is the same on every run:
    // with Math.random free, an unlucky run of trips left only two speakers heard in the window.
    let seed = 7;
    vi.spyOn(Math, "random").mockImplementation(() => (seed = (seed * 16807) % 2147483647) / 2147483647);
    layOut(false);
    // Otto waits on a decision card, so he says Needs you (one waiting with none does not).
    const at = new Date(NOW).toISOString();
    app.board = { version: 1, updatedAt: at, board: { updatedAt: at, needs: [{ id: "n-b", rev: "r", kind: "decision", title: "Duel", chat: "chat-b", since: at, options: [{ label: "Yes" }] }], coming: [], chats: [], shipped: [] } } as never;
    const el = mount();
    const allowed = new Set(CREW.flatMap((w) => agentLines(w)));
    const heard = new Set<string>();
    let flew = false;
    for (let t = 0; t < 40; t++) {
      vi.advanceTimersByTime(500);
      const now = said(el);
      expect(now.length).toBeLessThanOrEqual(2);
      for (const words of now) {
        expect(allowed).toContain(words);
        heard.add(words);
      }
      flew ||= !!el.querySelector(".desk-agent .rivet.is-away");
    }
    expect(heard.size).toBeGreaterThanOrEqual(3);
    expect(flew).toBe(true);
  });

  it("an agent on a trip goes up to Rivet's desk, never into another project's box", () => {
    // The roll pinned where a non-report line used to pick another project's desk: 0.5 ≤ 0.6 < 0.75.
    vi.spyOn(Math, "random").mockReturnValue(0.6);
    const RIVET_SLAB: [number, number, number, number] = [540, 200, 200, 40];
    layOut(false, (el) => {
      if (el.classList.contains("desks")) return [0, 0, 1280, 900];
      if (el.classList.contains("desk-slab")) {
        if (el.closest(".desk.is-rivet")) return RIVET_SLAB;
        const i = [...document.querySelectorAll(".desk.is-project")].indexOf(el.closest(".desk.is-project")!);
        return [60 + i * 420, 780, 360, 30];
      }
      if (el.classList.contains("is-project")) {
        const i = [...document.querySelectorAll(".desk.is-project")].indexOf(el);
        return [40 + i * 420, 340, 400, 500];
      }
      return null;
    });
    app.workersAt = Date.now();
    app.workers = { at: new Date().toISOString(), workers: [...CREW, worker("d", "Bea", { repo: "sam/example-repo", what: "Bombs: too many, not fun" })] };
    const desks = mountDesks();
    stops.push(desks.stop);
    document.body.append(desks.el);
    changed();
    expect(desks.el.querySelectorAll(".desk.is-project").length).toBe(2);
    const landings: { x: number; y: number }[] = [];
    for (let t = 0; t < 60; t++) {
      vi.advanceTimersByTime(250);
      const flyer = desks.el.querySelector<HTMLElement>(".desks-flyer");
      const move = flyer?.style.transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/);
      if (flyer && move) landings.push({ x: parseFloat(flyer.style.left) + parseFloat(move[1]!), y: parseFloat(flyer.style.top) + parseFloat(move[2]!) });
    }
    expect(landings.length).toBeGreaterThan(0);
    const [sx, sy, sw, sh] = RIVET_SLAB;
    for (const at of landings) {
      // Beside his desk (a square's width and a gap either side), level with it or up by his face: never down in a box.
      expect(at.x).toBeGreaterThanOrEqual(sx - 36 - 10 - 1);
      expect(at.x).toBeLessThanOrEqual(sx + sw + 10 + 1);
      expect(at.y).toBeLessThan(sy + sh);
    }
  });

  it("cheers a merge made while the floor is open, never one it found on opening", () => {
    layOut(false);
    opsData.timeline = timeline(merge(418, 40));
    const el = mount();
    const rivet = () => el.querySelector<HTMLElement>(".desk.is-rivet")!;
    expect(rivet().classList.contains("is-cheer")).toBe(false);

    opsData.timeline = timeline(merge(418, 40), merge(410, 30));
    changed();
    expect(rivet().classList.contains("is-cheer")).toBe(false);

    opsData.timeline = timeline(merge(418, 40), merge(410, 30), merge(419, 1, { title: "Results: the review's three fixes" }));
    changed();
    expect(rivet().classList.contains("is-cheer")).toBe(true);
    expect(rivet().querySelector(".desk-mood")!.textContent).toBe(MOOD_WORDS.happy);
    expect(said(el)).toContain("Merged: Results: the review's three…");

    vi.advanceTimersByTime(5_000);
    expect(rivet().classList.contains("is-cheer")).toBe(false);
    expect(rivet().querySelector(".desk-mood")!.textContent).not.toBe(MOOD_WORDS.happy);
  });

  it("stopped with a turn, a trip and a bubble pending, the floor leaves no timer behind, and a late paint starts none", () => {
    let seed = 7;
    vi.spyOn(Math, "random").mockImplementation(() => (seed = (seed * 16807) % 2147483647) / 2147483647);
    layOut(false);
    // A fresh Ops reading, so mounting starts no request whose deadline would count as a timer left (review R1.2).
    opsData.at = Date.now();
    const el = mount();
    vi.advanceTimersByTime(6_000);
    expect(said(el).length).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    stops.pop()!();
    expect(vi.getTimerCount()).toBe(0);
    changed();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(30_000);
    expect(said(el)).toEqual([]);
  });
});
