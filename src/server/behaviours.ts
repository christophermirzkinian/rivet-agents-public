import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BEHAVIOURS, type Behaviour, type BehaviourValue } from "../shared/behaviours.js";

// See store.ts: node:sqlite goes through createRequire under vitest.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

// Settings › Behaviours: one row per user and behaviour, its own connection to the app database like PipelineStore.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS behaviours (
  user       TEXT NOT NULL,
  id         TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user, id)
);
`;

/**
 * Rivet has one login today: a session carries no user (auth.ts), so every signed-in session is the owner's and keys
 * its behaviours here. A second login keys by its own user.
 */
export const OWNER = "owner";

// The owner's version has a private list beside the shared one; the public export leaves that file out, so it is read
// only when present and never imported by name.
const PRIVATE_FILE = new URL("../shared/behaviours-extra.ts", import.meta.url);

async function privateBehaviours(): Promise<readonly Behaviour[]> {
  if (!existsSync(fileURLToPath(PRIVATE_FILE))) return [];
  return ((await import(PRIVATE_FILE.href)) as { PRIVATE_BEHAVIOURS: readonly Behaviour[] }).PRIVATE_BEHAVIOURS;
}

/** Every behaviour this build has: the shared list, then the private one where the file is present. */
export const ALL_BEHAVIOURS: readonly Behaviour[] = [...BEHAVIOURS, ...(await privateBehaviours())];

export interface StoredBehaviour {
  value: BehaviourValue;
  /** Null while the default stands. */
  updatedAt: string | null;
}

export class BehavioursStore {
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

  /** The stored value, or the default when none is stored or the stored one no longer fits the knobs. */
  get(user: string, behaviour: Behaviour): StoredBehaviour {
    const row = this.db.prepare("SELECT value, updated_at FROM behaviours WHERE user = ? AND id = ?").get(user, behaviour.id) as { value: string; updated_at: string } | undefined;
    if (row) {
      let stored: unknown;
      try {
        stored = JSON.parse(row.value);
      } catch {
        // A row that is not JSON (a hand edit) falls back to the default, never a 500 for the whole list.
        stored = undefined;
      }
      const parsed = behaviour.knobs.safeParse(stored);
      if (parsed.success) return { value: parsed.data, updatedAt: row.updated_at };
    }
    return { value: behaviour.default, updatedAt: null };
  }

  /** Saves a value its knobs accept; anything else is refused with null and nothing is written. */
  put(user: string, behaviour: Behaviour, value: unknown, at: Date): StoredBehaviour | null {
    const parsed = behaviour.knobs.safeParse(value);
    if (!parsed.success) return null;
    const updatedAt = at.toISOString();
    this.db
      .prepare("INSERT INTO behaviours (user, id, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user, id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(user, behaviour.id, JSON.stringify(parsed.data), updatedAt);
    return { value: parsed.data, updatedAt };
  }
}
