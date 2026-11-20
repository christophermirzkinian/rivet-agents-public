// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MindPut } from "../src/shared/mind.js";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const BUILT = Date.parse("2026-11-20T09:30:00.000Z");
const GRAPH: MindPut = {
  built: BUILT,
  loaded: ["note:Orchid"],
  nodes: [
    { id: "note:Orchid", kind: "memory", type: "reference", label: "Amber notebook", desc: "Cobalt summary", body: "# Jade notes\nA quiet afternoon.", written: 123456789 },
    { id: "note:Birch", kind: "hub", type: "project", label: "Silver notebook", desc: "Other summary", body: "A quiet evening.", written: null },
  ],
  links: [{ source: "note:Orchid", target: "note:Birch", kind: "wikilink" }],
};

const reply = (graph: MindPut) => new Response(JSON.stringify(graph), { headers: { "content-type": "application/json" } });
const load = () => import("../web/src/views/mind.preview.js");

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  history.replaceState(null, "", "/?mind=local");
  vi.stubGlobal("fetch", vi.fn(async () => reply(GRAPH)));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  history.replaceState(null, "", "/");
  vi.resetModules();
});

describe("mindPreview", () => {
  it("returns no graph or received time in empty mode without fetching", async () => {
    history.replaceState(null, "", "/?mind=empty");
    const { mindPreview } = await load();
    const response = await mindPreview("/api/mind");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ graph: null, receivedAt: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps graph metadata and links but leaves node text for the detail route", async () => {
    const { mindPreview } = await load();
    const response = await mindPreview("/api/mind");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      graph: {
        built: BUILT,
        loaded: ["note:Orchid"],
        nodes: [
          { id: "note:Orchid", kind: "memory", type: "reference", label: "Amber notebook", written: 123456789 },
          { id: "note:Birch", kind: "hub", type: "project", label: "Silver notebook", written: null },
        ],
        links: [{ source: "note:Orchid", target: "note:Birch", kind: "wikilink" }],
      },
      receivedAt: "2026-11-20T09:30:00.000Z",
    });
  });

  it("returns exactly the requested node's text and a 404 for an unknown id", async () => {
    const { mindPreview } = await load();
    const known = await mindPreview("/api/mind/node?id=note%3AOrchid");
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual({ id: "note:Orchid", desc: "Cobalt summary", body: "# Jade notes\nA quiet afternoon." });
    const unknown = await mindPreview("/api/mind/node?id=missing");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "no such node" });
  });

  it.each([
    ["label", "aMbEr"],
    ["id", "oRcHiD"],
    ["description", "cObAlT"],
    ["body", "jAdE"],
  ])("searches the %s case insensitively", async (_field, query) => {
    const { mindPreview } = await load();
    const response = await mindPreview(`/api/mind/search?q=${encodeURIComponent(query)}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ids: ["note:Orchid"] });
  });

  it.each(["memory", "reference", "123456789", "wikilink", "no-such-words"])("does not search metadata or unmatched words: %s", async (query) => {
    const { mindPreview } = await load();
    expect(await (await mindPreview(`/api/mind/search?q=${query}`)).json()).toEqual({ ids: [] });
  });

  it.each(["/api/mind/search?q=", "/api/mind/search"])("returns no matches for an empty or absent query: %s", async (url) => {
    const { mindPreview } = await load();
    expect(await (await mindPreview(url)).json()).toEqual({ ids: [] });
  });

  it("shares one pending fetch across concurrent routes and reuses it for later requests", async () => {
    let resolveFetch!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchGraph = vi.fn(() => pending);
    vi.stubGlobal("fetch", fetchGraph);
    const { mindPreview } = await load();
    const requests = [
      mindPreview("/api/mind"),
      mindPreview("/api/mind/node?id=note%3ABirch"),
      mindPreview("/api/mind/search?q=QUIET"),
    ] as const;
    expect(fetchGraph).toHaveBeenCalledTimes(1);
    // The Mac-local graph file under /preview/ (its name stays out of the public export).
    expect(fetchGraph).toHaveBeenCalledWith(expect.stringMatching(/^\/preview\/mind-local\.json$/));
    resolveFetch(reply(GRAPH));
    const [graph, node, search] = await Promise.all(requests);
    expect((await graph.json()).receivedAt).toBe("2026-11-20T09:30:00.000Z");
    expect(await node.json()).toEqual({ id: "note:Birch", desc: "Other summary", body: "A quiet evening." });
    expect(await search.json()).toEqual({ ids: ["note:Orchid", "note:Birch"] });

    await mindPreview("/api/mind");
    await mindPreview("/api/mind/node?id=note%3AOrchid");
    await mindPreview("/api/mind/search?q=Amber");
    expect(fetchGraph).toHaveBeenCalledTimes(1);
  });
});
