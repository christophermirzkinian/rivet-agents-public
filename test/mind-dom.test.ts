// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type MindNode, type MindPut, type MindResponse } from "../src/shared/mind.js";
import { when } from "../src/shared/when.js";
import { app } from "../web/src/state.js";
import { endSession } from "../web/src/session.js";
import { mountShell } from "../web/src/views/shell.js";
import { stubCanvas } from "./canvas-stub.js";

// More › Rivet's mind: the empty state, the chips and a dot's sheet. force-graph draws to a canvas happy-dom does not
// have, so a stand-in keeps the handlers the page gives it.

type Handler = (...args: unknown[]) => unknown;
const drawn = vi.hoisted(() => ({ graphs: [] as Record<string, Handler | undefined>[] }));
vi.mock("force-graph", () => ({
  default: class {
    constructor() {
      const handlers: Record<string, Handler | undefined> = {};
      const force = { strength: () => force, distanceMax: () => force, distance: () => force };
      const self: object = new Proxy(
        {},
        {
          get: (_target, key: string) => {
            if (key === "then") return undefined;
            if (key === "d3Force") return (_name: string, fn?: unknown) => (fn === undefined ? force : self);
            if (key === "zoom") return (z?: number) => (z === undefined ? 1 : self);
            return (...args: unknown[]) => {
              if (!args.length) return handlers[key];
              handlers[key] = args[0] as Handler;
              return self;
            };
          },
        },
      );
      drawn.graphs.push(handlers);
      return self;
    }
  },
}));

const NOW = Date.parse("2026-11-03T01:00:00.000Z");
const node = (id: string, extra: Partial<MindNode> = {}): MindNode => ({ id, kind: "memory", type: "feedback", label: id, desc: "", body: "", written: null, ...extra });
const GRAPH: MindPut = {
  built: NOW,
  loaded: ["index", "water-noon"],
  nodes: [
    node("index", { kind: "context", type: "context", label: "Index" }),
    node("topic-plants", { kind: "hub", type: "project", label: "Plants" }),
    node("water-noon", { label: "Water before noon", desc: "morning is best", body: "Why: **the leaves dry** by evening. See [[label-pots]].", written: NOW - 3_600_000 }),
    node("label-pots", { label: "Label every pot", written: NOW - 5 * 864e5 }),
    node("note:seed-order", { kind: "note", type: "note", label: "Seed order", written: NOW - 600_000 }),
  ],
  links: [
    { source: "index", target: "water-noon", kind: "loaded" },
    { source: "topic-plants", target: "water-noon", kind: "hub" },
    { source: "topic-plants", target: "label-pots", kind: "hub" },
    { source: "water-noon", target: "label-pots", kind: "wikilink" },
  ],
};
const dots = (g: MindPut): MindResponse => ({ graph: { ...g, nodes: g.nodes.map(({ desc: _d, body: _b, ...dot }) => dot) }, receivedAt: new Date(g.built).toISOString() });
const reply = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
const answer = (graph: MindPut | null) =>
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const u = new URL(String(url), "http://x");
      if (u.pathname === "/api/mind") return reply(graph ? dots(graph) : { graph: null, receivedAt: null });
      const n = graph?.nodes.find((one) => one.id === u.searchParams.get("id"));
      if (u.pathname === "/api/mind/node" && n) return reply({ id: n.id, desc: n.desc, body: n.body });
      if (u.pathname === "/api/mind/search") return reply({ ids: graph?.nodes.filter((one) => one.body.includes(u.searchParams.get("q") ?? "")).map((one) => one.id) ?? [] });
      return new Promise(() => {});
    }),
  );

let unmount: (() => void) | null = null;
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const open = async () => {
  app.tab = "more";
  app.morePage = "mind";
  unmount = mountShell(document.body.firstElementChild as HTMLElement);
  await settle();
  await settle();
};
const chips = () =>
  [...document.querySelectorAll<HTMLElement>(".mind-chip")].map((chip) => ({
    text: chip.textContent,
    pressed: chip.getAttribute("aria-pressed"),
    dot: chip.querySelector(".mind-dot")?.className ?? null,
  }));
const chip = (text: string) => [...document.querySelectorAll<HTMLElement>(".mind-chip")].find((one) => one.textContent?.startsWith(text))!;
const graph = () => drawn.graphs.at(-1)!;
const tap = (id: string) => graph().onNodeClick!({ id });
const view = (label: string) => [...document.querySelectorAll<HTMLElement>(".mind-view")].find((one) => one.textContent === label)!.click();
const sections = () => [...document.querySelectorAll<HTMLElement>(".mind-sec")].map((one) => `${one.querySelector(".mind-sec-name")!.textContent} ${one.querySelector(".mind-n")!.textContent}`);
const section = (text: string) => [...document.querySelectorAll<HTMLElement>(".mind-sec")].find((one) => one.textContent?.startsWith(text))!;
const rows = () => [...document.querySelectorAll<HTMLElement>(".mind-row")].map((one) => one.textContent);
const row = (text: string) => [...document.querySelectorAll<HTMLElement>(".mind-row")].find((one) => one.textContent?.startsWith(text))!;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  stubCanvas();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  document.body.replaceChildren(document.createElement("div"));
  drawn.graphs.length = 0;
  localStorage.removeItem("rivet.mind.view");
});

afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  endSession();
  app.tab = "cards";
  app.morePage = null;
  vi.useRealTimers();
});

describe("the Rivet's mind page", () => {
  it("lists what is always loaded first, then the topics, opens a section to its memories and a row to its sheet", async () => {
    answer(GRAPH);
    await open();
    expect(drawn.graphs).toHaveLength(1);
    view("List");
    await settle();
    expect(document.querySelector(".mind")!.classList.contains("is-list")).toBe(true);
    expect(sections()).toEqual(["Always loaded 2", "Plants 2", "Notes 1"]);
    expect(rows()).toEqual([]);
    section("Plants").click();
    expect(rows()).toEqual(["About this topic", "Label every pot", "Water before noon"]);
    expect(section("Plants").getAttribute("aria-expanded")).toBe("true");
    row("Label").click();
    await settle();
    expect(document.querySelector(".mind-sheet")!.classList.contains("is-open")).toBe(true);
    expect(document.querySelector(".mind-title")!.textContent).toBe("Label every pot");
    section("Plants").click();
    expect(rows()).toEqual([]);
  });

  it("narrows the list with the search and the chips, and opens what it found", async () => {
    answer(GRAPH);
    await open();
    view("List");
    chip("Today").click();
    expect(sections()).toEqual(["Always loaded 1", "Plants 1", "Notes 1"]);
    expect(rows()).toEqual(["Water before noon", "Water before noon", "Seed order"]);
    section("Always").click();
    expect(rows()).toEqual(["Water before noon", "Seed order"]);
    chip("Today").click();
    expect(rows()).toEqual([]);
    chip("Feedback").click();
    expect(sections()).toEqual(["Always loaded 1", "Plants 0", "Notes 1"]);
    chip("Feedback").click();
    const input = document.querySelector<HTMLInputElement>(".mind-q")!;
    input.value = "label";
    input.dispatchEvent(new Event("input"));
    expect(sections()).toEqual(["Plants 1"]);
    expect(rows()).toEqual(["Label every pot"]);
    input.value = "nothing has this";
    input.dispatchEvent(new Event("input"));
    expect(document.querySelector(".mind-list")!.textContent).toBe("Nothing here matches.");
  });

  it("files a memory under its topic whichever way the export kept their one link", async () => {
    answer({
      ...GRAPH,
      nodes: [...GRAPH.nodes, node("named", { label: "Names its topic" }), node("listed", { label: "Listed by wikilink" }), node("alone", { label: "On its own" })],
      links: [...GRAPH.links, { source: "named", target: "topic-plants", kind: "wikilink" }, { source: "topic-plants", target: "listed", kind: "wikilink" }],
    });
    await open();
    view("List");
    expect(sections()).toEqual(["Always loaded 2", "Plants 4", "No topic yet 1", "Notes 1"]);
    section("No topic").click();
    expect(rows()).toEqual(["On its own"]);
    section("Plants").click();
    expect(rows()).toEqual(["About this topic", "Label every pot", "Listed by wikilink", "Names its topic", "Water before noon", "On its own"]);
  });

  it("keeps the keyboard on a row when the server's search redraws the list", async () => {
    answer(GRAPH);
    await open();
    view("List");
    const input = document.querySelector<HTMLInputElement>(".mind-q")!;
    input.value = "label";
    input.dispatchEvent(new Event("input"));
    const was = row("Label");
    was.focus();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await settle();
    expect(was.isConnected).toBe(false);
    expect(document.activeElement?.textContent).toBe("Label every pot");
  });

  it("opens on the view last picked, and draws no map until the map is asked for", async () => {
    answer(GRAPH);
    await open();
    view("List");
    expect(localStorage.getItem("rivet.mind.view")).toBe("list");
    unmount?.();
    drawn.graphs.length = 0;
    document.body.replaceChildren(document.createElement("div"));
    await open();
    expect(document.querySelector(".mind")!.classList.contains("is-list")).toBe(true);
    expect(document.querySelector('[data-use="mind.view.list"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(drawn.graphs).toHaveLength(0);
    view("Map");
    await settle();
    await settle();
    expect(drawn.graphs).toHaveLength(1);
    expect(localStorage.getItem("rivet.mind.view")).toBe("map");
  });

  it("says it couldn't load in plain words, with Try again, when the server fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } }))),
    );
    await open();
    expect(document.querySelector(".reading-failed-words")?.textContent).toBe("Couldn't load Rivet's mind.");
    expect(document.querySelector(".reading-failed .reading-btn")?.textContent).toBe("Try again");
    expect(document.body.textContent).not.toMatch(/Request failed|Pull to try again|boom/);
  });

  it("keeps a drawn map when a refresh fails and says so over it, with its time and Refresh", async () => {
    answer(GRAPH);
    await open();
    expect(document.querySelector(".mind-reading .reading-at")!.textContent).toMatch(/^Updated /);
    expect(document.querySelector(".mind-reading .reading-stale")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } }))));
    document.querySelector<HTMLElement>(".mind-reading .reading-btn")!.click();
    await settle();
    expect(drawn.graphs).toHaveLength(1);
    expect(document.querySelector(".mind-reading .reading-stale")!.textContent).toBe("Couldn't refresh. These are the last numbers read.");
    expect(document.querySelector(".mind-reading .reading-btn")!.textContent).toBe("Refresh");
    expect(document.body.textContent).not.toMatch(/Request failed|boom/);
  });

  it("never calls a map not sent yet the last numbers read when a refresh fails", async () => {
    answer(null);
    await open();
    expect(document.querySelector(".mind-note")!.textContent).toContain("Nothing here yet.");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } }))));
    document.querySelector<HTMLElement>(".mind .reading-btn")!.click();
    await settle();
    expect(document.querySelector(".reading-failed-words")!.textContent).toBe("Couldn't load Rivet's mind.");
    expect(document.body.textContent).not.toContain("last numbers read");
  });

  it.each([
    ["no map has come", null],
    ["the map is empty", { built: NOW, loaded: [], nodes: [], links: [] }],
  ])("says how to fill it when %s, and draws nothing", async (_why, map) => {
    answer(map);
    await open();
    expect(document.querySelector(".mind-note")?.textContent).toBe("Nothing here yet. Set RIVET_MIND_MEMORY_DIR, RIVET_MIND_NOTES_DIR or RIVET_MIND_DECISIONS_DIR on your Mac, then run scripts/install-mind.sh.");
    expect(document.querySelector(".mind-stage")).toBeNull();
    expect(drawn.graphs).toHaveLength(0);
  });

  it("counts the map, gives a chip to each mode and type, and draws every dot", async () => {
    answer(GRAPH);
    await open();
    expect(document.querySelector(".mind-sub")?.textContent).toBe("5 things · 4 links");
    expect(chips()).toEqual([
      { text: "Today2", pressed: "false", dot: null },
      { text: "Loaded now2", pressed: "false", dot: null },
      { text: "Feedback2", pressed: "true", dot: "mind-dot t-feedback" },
      { text: "Project1", pressed: "true", dot: "mind-dot t-project" },
      { text: "Reference0", pressed: "true", dot: "mind-dot t-reference" },
      { text: "User0", pressed: "true", dot: "mind-dot t-user" },
      { text: "Notes1", pressed: "true", dot: "mind-dot t-note" },
      { text: "Decisions0", pressed: "true", dot: "mind-dot t-decision" },
    ]);
    expect(drawn.graphs).toHaveLength(1);
    expect(graph().graphData).toBeDefined();
  });

  it("says what Today and Loaded now pick out, and a type chip turns its dots off", async () => {
    answer(GRAPH);
    await open();
    chip("Today").click();
    expect(chip("Today").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".mind-banner.is-shown")?.textContent).toBe("Last 24 hours: 2 written or changed");
    chip("Loaded now").click();
    expect(chip("Today").getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector(".mind-banner.is-shown")?.textContent).toBe("In Rivet's window now: 2 of 5: your memory index and what it lists");
    chip("Loaded now").click();
    expect(document.querySelector(".mind-banner.is-shown")).toBeNull();
    chip("Feedback").click();
    expect(chip("Feedback").classList.contains("is-off")).toBe(true);
    const visible = graph().nodeVisibility as (n: unknown) => boolean;
    expect(visible({ type: "feedback" })).toBe(false);
    expect(visible({ type: "project" })).toBe(true);
  });

  it("finds a name at once and a body's words from the server", async () => {
    answer(GRAPH);
    await open();
    const input = document.querySelector<HTMLInputElement>(".mind-q")!;
    input.value = "label";
    input.dispatchEvent(new Event("input"));
    expect(document.querySelector(".mind-hits")?.textContent).toBe("1 found");
    input.value = "leaves";
    input.dispatchEvent(new Event("input"));
    expect(document.querySelector(".mind-hits")?.textContent).toBe("0 found");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await settle();
    expect(document.querySelector(".mind-hits")?.textContent).toBe("1 found");
  });

  it("opens a dot's sheet: its name, kind, time, its words on the tap, and its links to follow", async () => {
    answer(GRAPH);
    await open();
    tap("water-noon");
    const sheet = document.querySelector<HTMLElement>(".mind-sheet")!;
    expect(sheet.classList.contains("is-open")).toBe(true);
    expect(sheet.querySelector(".mind-title")?.textContent).toBe("Water before noon");
    expect([...sheet.querySelectorAll(".mind-tag")].map((t) => t.textContent)).toEqual(["Memory · feedback", `Written ${when(NOW - 3_600_000)}`, "In the window now"]);
    expect(sheet.querySelector(".mind-desc")?.textContent).toBe("Reading…");
    await settle();
    expect(sheet.querySelector(".mind-desc")?.textContent).toBe("morning is best");
    expect(sheet.querySelector(".mind-body")?.textContent).toBe("Why: the leaves dry by evening. See label-pots.");
    expect(sheet.querySelector(".mind-lh")?.textContent).toBe("Links · 3");
    expect([...sheet.querySelectorAll<HTMLElement>(".mind-link")].map((l) => l.dataset.id)).toEqual(["index", "topic-plants", "label-pots"]);

    sheet.querySelector<HTMLElement>('.mind-link[data-id="topic-plants"]')!.click();
    expect(sheet.querySelector(".mind-title")?.textContent).toBe("Plants");
    sheet.querySelector<HTMLElement>(".mind-close")!.click();
    expect(sheet.classList.contains("is-open")).toBe(false);
  });
});
