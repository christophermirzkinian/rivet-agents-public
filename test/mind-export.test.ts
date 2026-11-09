import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mindPutSchema } from "../src/shared/mind.js";
// @ts-expect-error -- a plain .mjs script with no types
import { BODY_MAX, buildGraph, clean, main, zoneMidnight } from "../scripts/mind-export.mjs";

// The exporter (rivet/scripts/mind-export.mjs) on made-up files: what it reads, what it leaves out, and that its
// output is what PUT /api/bridge/mind takes.

const NOW = Date.parse("2026-11-03T01:00:00.000Z");
const TOKEN = `${["gh", "p_"].join("")}${"a1B2".repeat(9)}`;

interface Node {
  id: string;
  kind: string;
  label: string;
  desc: string;
  body: string;
  written: number | null;
}
interface Graph {
  built: number;
  loaded: string[];
  nodes: Node[];
  links: { source: string; target: string; kind: string }[];
}

let dir: string;
const write = (file: string, text: string) => {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), text);
};
const memo = (name: string, title: string, type: string, body: string) => write(`memory/${name}.md`, `---\nname: ${title}\ndescription: ${title} in short\ntype: ${type}\n---\n${body}\n`);
const build = (): Graph => buildGraph({ memory: join(dir, "memory"), notes: join(dir, "notes"), decisions: join(dir, "decisions"), now: NOW });
const byId = (graph: Graph) => new Map(graph.nodes.map((n) => [n.id, n]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mind-export-"));
  memo("water-before-noon", "Water before noon", "feedback", `See [[label-every-pot]].\nThe token was ${TOKEN} once.`);
  memo("label-every-pot", "Label every pot", "feedback", "A pen that lasts.");
  memo("topic-plants", "Plants", "project", "- [Water before noon](water-before-noon.md)\n- [Label every pot](label-every-pot.md)");
  memo("sam-likes-mint", "Sam likes mint", "user", "Keep a pot by the door.");
  memo("no-type", "No type", "planet", "A type the page does not draw.");
  write("memory/index.md", "# Index\n- [Water before noon](water-before-noon.md)\n- [Plants](topic-plants.md)\n");
  write("notes/seed-order.md", "# Seed order\nBeans and peas. See [[water-before-noon]].\n");
  write("notes/shelves/shelf plan.md", "---\ntitle: Shelf plan\ndescription: Three rows\n---\nTallest at the back.\n");
  write("notes/.hidden/skipped.md", "# Skipped\n");
  write("notes/not-markdown.txt", "Skipped too.\n");
  write("decisions/2026-11-02-clay-pots.md", "# Clay pots over plastic\nThey dry evenly.\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("mind-export", () => {
  it("reads memories, hubs, notes and decisions into one graph Rivet takes", () => {
    const graph = build();
    const nodes = byId(graph);
    expect(mindPutSchema.safeParse(graph).success).toBe(true);
    expect(graph.built).toBe(NOW);
    expect(nodes.get("water-before-noon")).toMatchObject({ kind: "memory", type: "feedback", label: "Water before noon", desc: "Water before noon in short" });
    expect(nodes.get("topic-plants")).toMatchObject({ kind: "hub", type: "project", label: "Plants in short" });
    expect(nodes.get("index")).toMatchObject({ kind: "context", type: "context", label: "Index" });
    expect(nodes.get("no-type")).toMatchObject({ type: "reference" });
    expect(nodes.get("note:seed-order")).toMatchObject({ kind: "note", type: "note", label: "Seed order" });
    expect(nodes.get("note:shelves/shelf-plan")).toMatchObject({ kind: "note", label: "Shelf plan", desc: "Three rows" });
    expect(nodes.get("decision:2026-11-02-clay-pots")).toMatchObject({ kind: "decision", type: "decision", label: "Clay pots over plastic", written: zoneMidnight(2026, 10, 2) });
    expect(graph.nodes.map((n) => n.id).join(" ")).not.toMatch(/skipped|not-markdown/);

    const linked = (a: string, b: string, kind: string) => graph.links.some((l) => ((l.source === a && l.target === b) || (l.source === b && l.target === a)) && l.kind === kind);
    expect(linked("water-before-noon", "label-every-pot", "wikilink")).toBe(true);
    expect(linked("topic-plants", "label-every-pot", "hub")).toBe(true);
    expect(linked("index", "water-before-noon", "loaded")).toBe(true);
    expect(linked("note:seed-order", "water-before-noon", "wikilink")).toBe(true);
    expect(new Set(graph.links.map((l) => [l.source, l.target].sort().join(" "))).size).toBe(graph.links.length);

    // Loaded: the index and what it lists.
    expect([...graph.loaded].sort()).toEqual(["index", "topic-plants", "water-before-noon"]);
  });

  it("is a valid empty graph with no folder named, or one that is not there", () => {
    const empty = { built: NOW, loaded: [], nodes: [], links: [] };
    expect(buildGraph({ now: NOW })).toEqual(empty);
    expect(buildGraph({ memory: join(dir, "gone"), notes: join(dir, "gone"), decisions: join(dir, "gone"), now: NOW })).toEqual(empty);
    expect(mindPutSchema.safeParse(empty).success).toBe(true);
  });

  it("reads only the folders named", () => {
    const graph: Graph = buildGraph({ notes: join(dir, "notes"), now: NOW });
    expect(graph.nodes.map((n) => n.kind)).toEqual(["note", "note"]);
    expect(graph.loaded).toEqual([]);
  });

  it("redacts secrets in every text, and cuts a long body at a line", () => {
    const graph = build();
    expect(JSON.stringify(graph)).not.toContain(TOKEN);
    expect(byId(graph).get("water-before-noon")?.body).toContain("[redacted github token]");
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} the quick brown fox jumps over the dog`).join("\n");
    const cut = clean(long);
    expect(cut.length).toBeLessThanOrEqual(BODY_MAX + 2);
    expect(cut.endsWith("\n…")).toBe(true);
    expect(cut.split("\n").at(-2)).toMatch(/^line \d+ the quick brown fox jumps over the dog$/);
  });

  it("leaves off a file Rivet would refuse by its name", () => {
    memo("odd+name", "Odd", "reference", "body");
    expect(byId(build()).has("odd+name")).toBe(false);
  });

  it("keeps a graph under the server's size, with no link to a node it dropped", () => {
    const line = "the quick brown fox jumps over the dog\n".repeat(150);
    for (let i = 0; i < 600; i++) write(`notes/many/${i}.md`, `# Note ${i}\n[[seed-order]]\n${line}`);
    const graph = build();
    expect(graph.nodes.length).toBeLessThan(600);
    expect(mindPutSchema.safeParse(graph).success).toBe(true);
  });

  it("finds midnight in the zone asked for, on a day the clocks change too", () => {
    expect(zoneMidnight(2026, 10, 3, "Asia/Tokyo")).toBe(Date.UTC(2026, 10, 2, 15));
    expect(zoneMidnight(2026, 10, 1, "America/New_York")).toBe(Date.UTC(2026, 10, 1, 4));
    expect(zoneMidnight(2026, 10, 2, "America/New_York")).toBe(Date.UTC(2026, 10, 2, 5));
    expect(zoneMidnight(2026, 0, 15, "UTC")).toBe(Date.UTC(2026, 0, 15));
  });

  describe("main", () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    let log: ReturnType<typeof vi.spyOn>;
    const env = { RIVET_BRIDGE_TOKEN: "ab".repeat(32), RIVET_URL: "http://127.0.0.1:8130" };

    beforeEach(() => {
      fetch.mockClear();
      log = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.stubGlobal("fetch", fetch);
    });
    afterEach(() => {
      log.mockRestore();
      vi.unstubAllGlobals();
    });

    it("writes the graph to a file with --out and sends nothing", async () => {
      const out = join(dir, "graph.json");
      await main(["--memory", join(dir, "memory"), "--notes", join(dir, "notes"), "--decisions", join(dir, "decisions"), "--out", out], {});
      expect(fetch).not.toHaveBeenCalled();
      expect(mindPutSchema.safeParse(JSON.parse(readFileSync(out, "utf8"))).success).toBe(true);
      expect(log.mock.calls[0]?.[0]).toMatch(/ mind nodes=\d+ links=\d+ loaded=3 bytes=\d+ out=/);
    });

    it("reads its folders from the settings, and none set writes an empty graph", async () => {
      const out = join(dir, "graph.json");
      await main(["--out", out], { RIVET_MIND_NOTES_DIR: join(dir, "notes") });
      expect(JSON.parse(readFileSync(out, "utf8")).nodes).toHaveLength(2);
      await main(["--out", out], {});
      expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ loaded: [], nodes: [], links: [] });
    });

    it("sends a new graph once with the bridge token, and not again while it is the same", async () => {
      const args = ["--memory", join(dir, "memory"), "--state", join(dir, "state")];
      await main(args, env);
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
      expect(url).toBe("http://127.0.0.1:8130/api/bridge/mind");
      expect(init.method).toBe("PUT");
      expect(init.headers.authorization).toBe(`Bearer ${env.RIVET_BRIDGE_TOKEN}`);
      expect(mindPutSchema.safeParse(JSON.parse(String(init.body))).success).toBe(true);

      await main(args, env);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[1]?.[0]).toMatch(/ unchanged$/);

      memo("new-one", "A new one", "reference", "Changed.");
      await main(args, env);
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });
});
