import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { MindGraph, MindNodeResponse, MindPut, MindResponse } from "../shared/mind.js";

// See store.ts: node:sqlite goes through createRequire under vitest.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

// Its own connection to the app database, like PipelineStore: only the latest graph is kept. The dots and links are one
// row, read whole by the page; each node's words are a row of their own, read on a tap and searched.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS mind_graph (
  one         INTEGER PRIMARY KEY CHECK (one = 1),
  json        TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mind_nodes (
  id   TEXT PRIMARY KEY,
  desc TEXT NOT NULL,
  body TEXT NOT NULL,
  hay  TEXT NOT NULL
);
`;

const SEARCH_MAX = 2000;

export class MindStore {
  private readonly db: InstanceType<typeof DatabaseSync>;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "rivet.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  read(): MindResponse {
    const row = this.db.prepare("SELECT json, received_at FROM mind_graph WHERE one = 1").get() as { json: string; received_at: string } | undefined;
    return row ? { graph: JSON.parse(row.json) as MindGraph, receivedAt: row.received_at } : { graph: null, receivedAt: null };
  }

  node(id: string): MindNodeResponse | null {
    const row = this.db.prepare("SELECT id, desc, body FROM mind_nodes WHERE id = ?").get(id) as MindNodeResponse | undefined;
    return row ? { id: row.id, desc: row.desc, body: row.body } : null;
  }

  /** The ids whose label, id, description or body holds `query`, any case. */
  search(query: string): string[] {
    const like = `%${query.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.db.prepare("SELECT id FROM mind_nodes WHERE hay LIKE ? ESCAPE '\\' LIMIT ?").all(like, SEARCH_MAX) as { id: string }[];
    return rows.map((row) => row.id);
  }

  /** The graph sent replaces the one kept, whole. */
  put(graph: MindPut, at: Date): void {
    const dots: MindGraph = { built: graph.built, loaded: graph.loaded, nodes: graph.nodes.map(({ desc: _desc, body: _body, ...dot }) => dot), links: graph.links };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO mind_graph (one, json, received_at) VALUES (1, ?, ?) ON CONFLICT (one) DO UPDATE SET json = excluded.json, received_at = excluded.received_at").run(JSON.stringify(dots), at.toISOString());
      this.db.exec("DELETE FROM mind_nodes");
      const insert = this.db.prepare("INSERT INTO mind_nodes (id, desc, body, hay) VALUES (?, ?, ?, ?)");
      for (const node of graph.nodes) insert.run(node.id, node.desc, node.body, `${node.label}\n${node.id}\n${node.desc}\n${node.body}`.toLowerCase());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
