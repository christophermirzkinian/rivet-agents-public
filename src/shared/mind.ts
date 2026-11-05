import { z } from "zod";

// Rivet's mind: the user's own memories, notes and decisions as one graph. scripts/mind-export.mjs reads the folders
// they name on the Mac and sends the whole graph (`PUT /api/bridge/mind`, bridge token); the server keeps only the
// latest. The page reads it without the texts (`GET /api/mind`) and asks for one node's text on a tap
// (`GET /api/mind/node`).

export const MIND_KINDS = ["memory", "hub", "context", "note", "decision"] as const;
export const MIND_TYPES = ["feedback", "project", "reference", "user", "note", "decision", "context"] as const;
export const MIND_LINK_KINDS = ["wikilink", "hub", "loaded"] as const;
export type MindKind = (typeof MIND_KINDS)[number];
export type MindType = (typeof MIND_TYPES)[number];

/** Markdown read as words, the way the page shows them: links and wiki links as their text, no bold or code marks. Each
 * line on its own, so the lines stay as they were; read again until nothing changes, so a mark in a mark goes too. */
export function mindMarksGone(s: string): string {
  // Every pass that changes the text makes it shorter, so this ends.
  for (;;) {
    const next = s
      .replace(/\[\[([^\]|\n]+)(\|[^\]\n]*)?\]\]/g, "$1")
      .replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, "$1")
      .replace(/\*\*|`/g, "");
    if (next === s) return s;
    s = next;
  }
}

/** The bodies are cut to MIND_BODY_MAX each on the Mac, and the exporter keeps the newest nodes under this. */
export const MIND_MAX_BYTES = 3 * 1024 * 1024;
export const MIND_NODES_MAX = 5000;
export const MIND_LINKS_MAX = 20_000;
export const MIND_LABEL_MAX = 120;
export const MIND_DESC_MAX = 400;
/** The exporter's cut (BODY_MAX, 6000) and the "…" it ends a cut body with. */
export const MIND_BODY_MAX = 6016;
export const MIND_QUERY_MAX = 100;

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/);

export const mindNodeSchema = z
  .object({
    id,
    kind: z.enum(MIND_KINDS),
    type: z.enum(MIND_TYPES),
    label: z.string().min(1).max(MIND_LABEL_MAX),
    desc: z.string().max(MIND_DESC_MAX),
    written: z.number().int().min(0).max(8.64e15).nullable(),
    body: z.string().max(MIND_BODY_MAX),
  })
  .strict();

const linkSchema = z.object({ source: id, target: id, kind: z.enum(MIND_LINK_KINDS) }).strict();

export const mindPutSchema = z
  .object({
    built: z.number().int().min(0).max(8.64e15),
    loaded: z.array(id).max(MIND_NODES_MAX),
    nodes: z.array(mindNodeSchema).max(MIND_NODES_MAX),
    links: z.array(linkSchema).max(MIND_LINKS_MAX),
  })
  .strict()
  .superRefine((graph, ctx) => {
    const ids = new Set<string>();
    for (const node of graph.nodes) {
      if (ids.has(node.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a node id twice", path: ["nodes"] });
      ids.add(node.id);
    }
    if (graph.links.some((link) => !ids.has(link.source) || !ids.has(link.target))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a link to no node", path: ["links"] });
    if (graph.loaded.some((one) => !ids.has(one))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a loaded id with no node", path: ["loaded"] });
  });
export type MindPut = z.infer<typeof mindPutSchema>;
export type MindNode = z.infer<typeof mindNodeSchema>;
export type MindLink = MindPut["links"][number];

/** A node as the page first reads it: no description, no body. */
export type MindDot = Omit<MindNode, "desc" | "body">;

export interface MindGraph {
  built: number;
  loaded: string[];
  nodes: MindDot[];
  links: MindLink[];
}

/** GET /api/mind: the latest graph, or null before the first arrives. */
export interface MindResponse {
  graph: MindGraph | null;
  receivedAt: string | null;
}

/** GET /api/mind/node?id=: one node's words. */
export interface MindNodeResponse {
  id: string;
  desc: string;
  body: string;
}

/** GET /api/mind/search?q=: the ids whose name, description or text holds the words. */
export interface MindSearchResponse {
  ids: string[];
}

export interface MindPutResponse {
  ok: true;
  nodes: number;
  links: number;
}

/** What a node is, in its sheet's tag. */
export const MIND_KIND_WORDS: Record<MindKind, string> = {
  memory: "Memory",
  hub: "Topic hub",
  context: "Index",
  note: "Note",
  decision: "Decision",
};
