import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { MAX_SHORT_SOURCE, shownTitle, type PendingShortTitle } from "../shared/short-titles.js";

// See store.ts: node:sqlite goes through createRequire under vitest.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

// The short titles, keyed by a hash of the words they name, on their own connection to the app database. A row's
// words are queued the first time a list serves them; nothing on a write path waits on the model. The bridge's Haiku
// pass reads the queue and answers each with a title, or null when it gave up (the row keeps its fallback).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS short_titles (
  hash      TEXT PRIMARY KEY,
  text      TEXT NOT NULL,
  title     TEXT,
  done      INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT NOT NULL -- when the words were last served, to the day
);
CREATE INDEX IF NOT EXISTS short_titles_queue ON short_titles (done, queued_at);
`;

/** Titles not served for this long are dropped; words served after that are queued again. */
const KEEP_MS = 30 * 24 * 3600_000;
/** The table keeps at most this many rows, the most recently served. */
const MAX_ROWS = 5_000;
/** A served row's time is written back at most this often. */
const SEEN_EVERY_MS = 24 * 3600_000;

/** The key of a row's words: SHA-256 of them with their spacing evened out. */
export function shortHash(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}

export class ShortTitles {
  private readonly db: InstanceType<typeof DatabaseSync>;
  /** What the table holds: a hash to its title (null while queued or given up) and when it was last served. */
  private readonly known = new Map<string, { title: string | null; seen: number }>();

  constructor(dataDir: string, now: Date = new Date()) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "rivet.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.prune(now);
  }

  /**
   * The short title `words` wear now: Haiku's when it has named them, else the trimmed first clause. Words not seen
   * before are queued for the bridge. `chat` is the chat's name, given to Haiku beside a chat's own status line.
   */
  of(words: string, chat?: string, now: Date = new Date()): string {
    const context = chat ? `Chat: ${chat}\n` : "";
    // The key is the whole of the words; Haiku reads only their first MAX_SHORT_SOURCE characters.
    const hash = shortHash(`${context}${words}`);
    const at = now.getTime();
    const row = this.known.get(hash);
    if (!row) {
      this.known.set(hash, { title: null, seen: at });
      this.db.prepare("INSERT OR IGNORE INTO short_titles (hash, text, queued_at) VALUES (?, ?, ?)").run(hash, `${context}${words.slice(0, MAX_SHORT_SOURCE)}`, now.toISOString());
      // Pruned in steps, so a flood of new words rereads the table once per thousand, not once each.
      if (this.known.size > MAX_ROWS + 1_000) this.prune(now);
    } else if (at - row.seen >= SEEN_EVERY_MS) {
      row.seen = at;
      this.db.prepare("UPDATE short_titles SET queued_at = ? WHERE hash = ?").run(now.toISOString(), hash);
    }
    return shownTitle(this.known.get(hash)?.title, words);
  }

  /** Drops rows not served for KEEP_MS and all but the MAX_ROWS most recently served, then rereads the table. */
  private prune(now: Date): void {
    this.db.prepare("DELETE FROM short_titles WHERE queued_at < ?").run(new Date(now.getTime() - KEEP_MS).toISOString());
    this.db.prepare("DELETE FROM short_titles WHERE hash NOT IN (SELECT hash FROM short_titles ORDER BY queued_at DESC, hash LIMIT ?)").run(MAX_ROWS);
    this.known.clear();
    const rows = this.db.prepare("SELECT hash, title, queued_at FROM short_titles").all() as { hash: string; title: string | null; queued_at: string }[];
    for (const row of rows) this.known.set(row.hash, { title: row.title, seen: Date.parse(row.queued_at) });
  }

  /** The queued rows, newest first. */
  pending(limit: number): PendingShortTitle[] {
    return this.db.prepare("SELECT hash, text FROM short_titles WHERE done = 0 ORDER BY queued_at DESC, hash LIMIT ?").all(limit) as unknown as PendingShortTitle[];
  }

  /** Records Haiku's title for `hash`, or null when it gave up. False when no row has that hash. */
  put(hash: string, title: string | null): boolean {
    const result = this.db.prepare("UPDATE short_titles SET title = ?, done = 1 WHERE hash = ?").run(title, hash);
    if (!result.changes) return false;
    const row = this.known.get(hash);
    if (row) row.title = title;
    return true;
  }

  close(): void {
    this.db.close();
  }
}
