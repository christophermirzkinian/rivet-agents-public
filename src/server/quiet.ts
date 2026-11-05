import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { DEFAULT_QUIET, parseHhMm, type QuietSettings } from "../shared/quiet.js";
import { minuteOfDay } from "../shared/when.js";
import type { HeldBatch, PushCategory, PushGate, PushLevel, PushPayload, RetryCategory } from "./push.js";
import { RIVET_NAME } from "../shared/names.js";
import { NOTHING_NEEDS_YOU, needYou } from "../shared/words.js";

// See store.ts: node:sqlite goes through createRequire under vitest.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

type DatabaseSync = InstanceType<typeof DatabaseSync>;

/** Held pushes past this many drop the oldest; the digest counts them in its "+N more". */
export const MAX_HELD = 200;
/** A failed digest waits 1 min, then twice as long each time, up to 30 min; after 24 h of failing it is dropped. */
export const DIGEST_RETRY_MS = 60_000;
export const DIGEST_RETRY_MAX_MS = 30 * 60_000;
export const DIGEST_GIVE_UP_MS = 24 * 3600_000;
/** How long, and how many, delivered push keys are remembered, so a retry after a restart is not sent twice. */
const KEY_TTL_MS = 7 * 24 * 3600_000;
export const MAX_PUSH_KEYS = 5000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS push_settings (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS held_pushes (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  json TEXT NOT NULL,
  at   TEXT NOT NULL,
  retry_category TEXT
);
CREATE TABLE IF NOT EXISTS held_meta (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  dropped       INTEGER NOT NULL,
  attempts      INTEGER NOT NULL,
  next_at       TEXT,
  failing_since TEXT,
  unsent        INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO held_meta (id, dropped, attempts) VALUES (1, 0, 0);
CREATE TABLE IF NOT EXISTS push_keys (
  key TEXT PRIMARY KEY,
  at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS push_keys_at ON push_keys (at);
`;

/** True while `now` (wall clock in Rivet's zone) is inside the quiet window; start == end means never. */
export function inQuiet(settings: QuietSettings, now: Date): boolean {
  if (!settings.enabled) return false;
  const start = parseHhMm(settings.start);
  const end = parseHhMm(settings.end);
  if (start === null || end === null || start === end) return false;
  const minute = minuteOfDay(now);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** What goes through quiet hours: only a test push, never an FYI. */
export function breaksThrough(category: PushCategory, level: PushLevel = "needs-you"): boolean {
  return level !== "fyi" && category === "test";
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** A push that states how many ops alerts were pruned unsent before it; saying so needs you, even on an FYI. */
export function withUnsent(payload: PushPayload, unsent: number): PushPayload {
  return unsent > 0 ? { ...payload, body: clip(`+${unsent} earlier alerts not sent. ${payload.body}`, 140), level: "needs-you" } : payload;
}

const needsLead = (needs: number | undefined) => (needs === undefined ? "" : needs ? `${needYou(needs)} now. ` : `${NOTHING_NEEDS_YOU} `);

/**
 * One push for everything held, `dropped` included in the count: a single held push goes as it was.
 * `unsent` ops alerts pruned before they were held are stated first, then `needs`, the cards that need you as it goes.
 */
export function digestPayload(held: readonly PushPayload[], dropped = 0, unsent = 0, needs?: number): PushPayload {
  const total = held.length + dropped;
  if (total === 1 && held.length === 1) return withUnsent(held[0]!, unsent);
  const titles = held.slice(0, 3).map((payload) => payload.title);
  const more = total > titles.length ? ` · +${total - titles.length} more` : "";
  // A dropped push or an unsent alert is not known to be FYI.
  const fyi = dropped === 0 && unsent === 0 && held.every((payload) => payload.level === "fyi");
  return {
    title: `${RIVET_NAME} held ${total} pings while it was quiet`,
    body: clip(`${unsent > 0 ? `+${unsent} earlier alerts not sent. ` : ""}${needsLead(needs)}${titles.join(" · ")}${more}`, 140),
    tag: "quiet-digest",
    path: "/",
    level: fyi ? "fyi" : "needs-you",
  };
}

/** Adds the columns a held_meta table created by an earlier build of this branch lacks. */
function migrate(db: DatabaseSync): void {
  const columns = new Set((db.prepare("PRAGMA table_info(held_meta)").all() as { name: string }[]).map((column) => column.name));
  if (!columns.has("next_at")) db.exec("ALTER TABLE held_meta ADD COLUMN next_at TEXT");
  if (!columns.has("failing_since")) db.exec("ALTER TABLE held_meta ADD COLUMN failing_since TEXT");
  if (!columns.has("unsent")) db.exec("ALTER TABLE held_meta ADD COLUMN unsent INTEGER NOT NULL DEFAULT 0");
  const held = new Set((db.prepare("PRAGMA table_info(held_pushes)").all() as { name: string }[]).map((column) => column.name));
  if (!held.has("key")) db.exec("ALTER TABLE held_pushes ADD COLUMN key TEXT");
  if (!held.has("retry_category")) db.exec("ALTER TABLE held_pushes ADD COLUMN retry_category TEXT");
}

/** Quiet-hours settings and the pushes they hold, on their own connection to the app database. */
export class QuietStore implements PushGate {
  private readonly db: DatabaseSync;
  private readonly maxPushKeys: number;

  /** `maxPushKeys` is only lowered by tests, so the cap is checked without thousands of writes. */
  constructor(dataDir: string, { maxPushKeys = MAX_PUSH_KEYS }: { maxPushKeys?: number } = {}) {
    this.maxPushKeys = maxPushKeys;
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "rivet.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    migrate(this.db);
  }

  close(): void {
    this.db.close();
  }

  settings(): QuietSettings {
    const row = this.db.prepare("SELECT json FROM push_settings WHERE id = 1").get() as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as QuietSettings) : DEFAULT_QUIET;
  }

  putSettings(settings: QuietSettings): void {
    this.db
      .prepare("INSERT INTO push_settings (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json")
      .run(JSON.stringify(settings));
  }

  holds(category: PushCategory, now: Date, level: PushLevel = "needs-you"): boolean {
    const settings = this.settings();
    return inQuiet(settings, now) && !breaksThrough(category, level);
  }

  /**
   * Holds a push; with a key already held or sent it holds nothing, and the key is recorded in the same step.
   * `unsent` pruned ops alerts move into the digest's count with it. Returns the keys of older pushes pruned for room:
   * they are never sent, so their keys are released.
   */
  hold(payload: PushPayload, now: Date, key?: string, unsent = 0, retryCategory?: RetryCategory): string[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (key && !this.recordKey(key, now)) {
        this.db.exec("COMMIT");
        return [];
      }
      this.db.prepare("INSERT INTO held_pushes (json, at, key, retry_category) VALUES (?, ?, ?, ?)")
        .run(JSON.stringify(payload), now.toISOString(), key ?? null, retryCategory ?? null);
      const prune = "FROM held_pushes WHERE id NOT IN (SELECT id FROM held_pushes ORDER BY id DESC LIMIT ?)";
      const keys = (this.db.prepare(`SELECT key ${prune} AND key IS NOT NULL`).all(MAX_HELD) as { key: string }[]).map((row) => row.key);
      for (const prunedKey of keys) this.db.prepare("DELETE FROM push_keys WHERE key = ?").run(prunedKey);
      const pruned = this.db.prepare(`DELETE ${prune}`).run(MAX_HELD).changes;
      if (pruned) this.db.prepare("UPDATE held_meta SET dropped = dropped + ? WHERE id = 1").run(pruned);
      if (unsent > 0) this.db.prepare("UPDATE held_meta SET unsent = unsent + ? WHERE id = 1").run(unsent);
      this.db.exec("COMMIT");
      return keys;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  heldCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM held_pushes").get() as { n: number }).n;
  }

  lastHeldId(): number {
    return (this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM held_pushes").get() as { id: number }).id;
  }

  /** Retires older queued versions of a delivered notification, keeping their deduplication keys. */
  supersede(tag: string, through: number, level: PushLevel = "needs-you"): string[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare("SELECT id, json, key FROM held_pushes WHERE id <= ? ORDER BY id ASC").all(through) as {
        id: number; json: string; key: string | null;
      }[];
      const matching = rows.filter((row) => {
        const payload = JSON.parse(row.json) as PushPayload;
        // The service worker gives FYIs their own tag, so they cannot replace a needs-you ping.
        return payload.tag === tag && (payload.level ?? "needs-you") === level;
      });
      const remove = this.db.prepare("DELETE FROM held_pushes WHERE id = ?");
      for (const row of matching) remove.run(row.id);
      if (this.heldCount() === 0) {
        this.db.prepare("UPDATE held_meta SET attempts = 0, next_at = NULL, failing_since = NULL WHERE id = 1").run();
      }
      this.db.exec("COMMIT");
      return matching.flatMap((row) => row.key === null ? [] : [row.key]);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Takes held pushes out unsent, by key, releasing their keys so a later send is no duplicate; returns the keys taken. */
  withdraw(keys: readonly string[]): string[] {
    if (keys.length === 0) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const taken: string[] = [];
      for (const key of new Set(keys)) {
        if (this.db.prepare("DELETE FROM held_pushes WHERE key = ?").run(key).changes) taken.push(key);
        this.db.prepare("DELETE FROM push_keys WHERE key = ?").run(key);
      }
      if (this.heldCount() === 0) {
        this.db.prepare("UPDATE held_meta SET attempts = 0, next_at = NULL, failing_since = NULL WHERE id = 1").run();
      }
      this.db.exec("COMMIT");
      return taken;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Rewrites a held push's text, by key, keeping its level and its place in the digest; false when none is held under it. */
  reword(key: string, body: string): boolean {
    const row = this.db.prepare("SELECT json FROM held_pushes WHERE key = ?").get(key) as { json: string } | undefined;
    if (!row) return false;
    const payload = { ...(JSON.parse(row.json) as PushPayload), body };
    return this.db.prepare("UPDATE held_pushes SET json = ? WHERE key = ?").run(JSON.stringify(payload), key).changes > 0;
  }

  private recordKey(key: string, now: Date): boolean {
    this.db.prepare("DELETE FROM push_keys WHERE at < ?").run(new Date(now.getTime() - KEY_TTL_MS).toISOString());
    if (this.db.prepare("INSERT INTO push_keys (key, at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING").run(key, now.toISOString()).changes !== 1) return false;
    this.db.prepare("DELETE FROM push_keys WHERE at < (SELECT at FROM push_keys ORDER BY at DESC LIMIT 1 OFFSET ?)").run(this.maxPushKeys - 1);
    return true;
  }

  /** True once a push with this key was held or sent. */
  hasKey(key: string): boolean {
    return this.db.prepare("SELECT 1 FROM push_keys WHERE key = ?").get(key) !== undefined;
  }

  markSent(key: string, now: Date): void {
    this.recordKey(key, now);
  }

  pushKeyCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM push_keys").get() as { n: number }).n;
  }

  private meta(): { dropped: number; attempts: number; next_at: string | null; failing_since: string | null; unsent: number } {
    return this.db.prepare("SELECT dropped, attempts, next_at, failing_since, unsent FROM held_meta WHERE id = 1").get() as {
      dropped: number;
      attempts: number;
      next_at: string | null;
      failing_since: string | null;
      unsent: number;
    };
  }

  /** After the retry wait, releases all rows outside quiet hours or eligible breakthrough retries during them. */
  releasable(now: Date): HeldBatch | null {
    const settings = this.settings();
    const quiet = inQuiet(settings, now);
    const { dropped, next_at, unsent } = this.meta();
    if (next_at && Date.parse(next_at) > now.getTime()) return null;
    const held = this.db.prepare("SELECT id, json, key, retry_category FROM held_pushes ORDER BY id ASC").all() as {
      id: number; json: string; key: string | null; retry_category: RetryCategory | null;
    }[];
    const rows = held.map((row) => ({ ...row, payload: JSON.parse(row.json) as PushPayload }))
      .filter((row) => !quiet || (row.retry_category !== null && breaksThrough(row.retry_category, row.payload.level ?? "needs-you")));
    if (rows.length === 0) {
      if (!quiet && held.length === 0 && dropped) this.db.prepare("UPDATE held_meta SET dropped = 0, attempts = 0, next_at = NULL, failing_since = NULL WHERE id = 1").run();
      return null;
    }
    return {
      upTo: rows[rows.length - 1]!.id,
      ids: rows.map((row) => row.id),
      payloads: rows.map((row) => row.payload),
      keys: rows.flatMap((row) => (row.key === null ? [] : [row.key])),
      bodies: rows.flatMap((row) => (row.key === null ? [] : [{ key: row.key, body: row.payload.body }])),
      dropped: quiet ? 0 : dropped,
      unsent: quiet ? 0 : unsent,
    };
  }

  /** Removes a delivered batch, or counts a failed try; true when the batch was given up on undelivered. */
  settle(batch: HeldBatch, delivered: boolean, now: Date): boolean {
    const meta = this.meta();
    const failingSince = meta.failing_since ?? now.toISOString();
    const giveUp = !delivered && now.getTime() - Date.parse(failingSince) >= DIGEST_GIVE_UP_MS;
    if (!delivered && !giveUp) {
      const wait = Math.min(DIGEST_RETRY_MS * 2 ** Math.min(meta.attempts, 20), DIGEST_RETRY_MAX_MS);
      this.db
        .prepare("UPDATE held_meta SET attempts = attempts + 1, next_at = ?, failing_since = ? WHERE id = 1")
        .run(new Date(now.getTime() + wait).toISOString(), failingSince);
      return false;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // A push given up on was never sent: its key must not mark a later send of it a duplicate.
      const removeKey = this.db.prepare("DELETE FROM push_keys WHERE key IN (SELECT key FROM held_pushes WHERE id = ? AND key IS NOT NULL)");
      const remove = this.db.prepare("DELETE FROM held_pushes WHERE id = ?");
      for (const id of batch.ids) {
        if (giveUp) removeKey.run(id);
        remove.run(id);
      }
      // A digest given up on never stated its unsent count, so the next one does.
      this.db
        .prepare("UPDATE held_meta SET dropped = MAX(0, dropped - ?), unsent = MAX(0, unsent - ?), attempts = 0, next_at = NULL, failing_since = NULL WHERE id = 1")
        .run(batch.dropped, delivered ? batch.unsent : 0);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return giveUp;
  }
}
