import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { CostRow } from "../shared/costs.js";

// See store.ts: node:sqlite goes through createRequire under vitest.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

// Its own connection to the app database, like SchedulesStore: the Costs page's rows Rivet set, one per service.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS costs (
  service TEXT PRIMARY KEY,
  json    TEXT NOT NULL
);
`;

export class CostsStore {
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

  list(): CostRow[] {
    const rows = this.db.prepare("SELECT json FROM costs ORDER BY service").all() as { json: string }[];
    return rows.map((row) => JSON.parse(row.json) as CostRow);
  }

  has(service: string): boolean {
    return this.db.prepare("SELECT 1 FROM costs WHERE service = ?").get(service) !== undefined;
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM costs").get() as { n: number }).n;
  }

  put(row: CostRow): void {
    this.db.prepare("INSERT INTO costs (service, json) VALUES (?, ?) ON CONFLICT (service) DO UPDATE SET json = excluded.json").run(row.service, JSON.stringify(row));
  }

  /** False when no row had that service. */
  delete(service: string): boolean {
    return this.db.prepare("DELETE FROM costs WHERE service = ?").run(service).changes > 0;
  }
}
