import type { MindNode, MindPut, MindResponse } from "../../../src/shared/mind.js";
import { mindLabels, mindSelect } from "./mind.js";

// More › Rivet's mind in the login-free preview (desktop.html?tab=more&page=mind): a small made-up map, or with
// &mind=local the map `node scripts/mind-export.mjs --out web/preview/mind-local.json` built from your own folders
// (git-ignored, never committed), or with &mind=empty no map yet.

const now = Date.now();
const node = (id: string, kind: MindNode["kind"], type: MindNode["type"], label: string, hoursAgo: number | null, desc = "", body = ""): MindNode => ({
  id,
  kind,
  type,
  label,
  desc,
  body,
  written: hoursAgo === null ? null : now - hoursAgo * 36e5,
});

const SMALL: MindPut = {
  built: now,
  loaded: ["index", "topic-plants.md", "topic-tools.md", "water-before-noon.md"],
  nodes: [
    node("index", "context", "context", "Index", 2, "Every memory, one line each", "# Index\nThe short list first."),
    node("topic-plants.md", "hub", "project", "Plants", 50, "What to grow and when"),
    node("topic-tools.md", "hub", "project", "Tools", 80, "What is on the shelf"),
    node("water-before-noon.md", "memory", "feedback", "Water before noon", 5, "Morning is best", "Water before noon.\n\nWhy: the leaves dry by evening."),
    node("label-every-pot.md", "memory", "feedback", "Label every pot", 70, "A pen that lasts"),
    node("spare-trowel.md", "memory", "reference", "The spare trowel", 100, "Top shelf, on the left"),
    node("sam-likes-mint.md", "memory", "user", "Sam likes mint", 300, "Keep a pot by the door"),
    node("note:seed-order", "note", "note", "Seed order", 1, "Beans, peas and basil"),
    node("note:shelf-plan", "note", "note", "Shelf plan", 20, "Three rows, tallest at the back"),
    node("decision:clay-pots", "decision", "decision", "Clay pots over plastic", 200, "They dry evenly"),
  ],
  links: [
    { source: "index", target: "topic-plants.md", kind: "loaded" },
    { source: "index", target: "topic-tools.md", kind: "loaded" },
    { source: "index", target: "water-before-noon.md", kind: "loaded" },
    { source: "topic-plants.md", target: "water-before-noon.md", kind: "hub" },
    { source: "topic-plants.md", target: "label-every-pot.md", kind: "hub" },
    { source: "topic-tools.md", target: "spare-trowel.md", kind: "hub" },
    { source: "water-before-noon.md", target: "label-every-pot.md", kind: "wikilink" },
  ],
};

const which = new URLSearchParams(location.search).get("mind");
let full: Promise<MindPut | null> | null = null;
const graph = () =>
  (full ??= which === "empty" ? Promise.resolve(null) : which === "local" ? fetch("/preview/mind-local.json").then((r) => r.json() as Promise<MindPut>) : Promise.resolve(SMALL));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The answer to a /api/mind… request, as the server would give it. */
export async function mindPreview(url: string): Promise<Response> {
  const g = await graph();
  const params = new URL(url, location.origin).searchParams;
  if (url.startsWith("/api/mind/node")) {
    const n = g?.nodes.find((one) => one.id === params.get("id"));
    return n ? json({ id: n.id, desc: n.desc, body: n.body }) : json({ error: "no such node" }, 404);
  }
  if (url.startsWith("/api/mind/search")) {
    const q = (params.get("q") ?? "").toLowerCase();
    return json({ ids: q ? (g?.nodes ?? []).filter((n) => `${n.label} ${n.id} ${n.desc} ${n.body}`.toLowerCase().includes(q)).map((n) => n.id) : [] });
  }
  const answer: MindResponse = g
    ? { graph: { built: g.built, loaded: g.loaded, nodes: g.nodes.map(({ desc: _d, body: _b, ...dot }) => dot), links: g.links }, receivedAt: new Date(g.built).toISOString() }
    : { graph: null, receivedAt: null };
  return json(answer);
}

/** The labels drawn on the last frame, for the stills' word check, and a sheet opened by id. */
Object.assign(window, { mindLabels, mindSelect });
