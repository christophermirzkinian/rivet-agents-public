import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { StoredBacklog } from "../../shared/backlog.js";
import type { Briefing, ClaudeUsageSnapshot, ClosedPr, FlySnapshot, GithubSnapshot, Health, MacSnapshot, MergedPr } from "../../shared/ops.js";
import type { CardBook } from "../../shared/ops-cards.js";
import type { HomeSnapshot } from "../../shared/home.js";
import type { OwnedItem } from "../../shared/ops-owned.js";
import type { OwnerHold } from "../../shared/owner-holds.js";
import type { PickupState } from "./pickup.js";
import type { PushCategory, PushPayload } from "../push.js";
import type { LateLog } from "./late.js";

// See store.ts: node:sqlite goes through createRequire under vitest.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

type DatabaseSync = InstanceType<typeof DatabaseSync>;

// Its own connection to the app database, so the ops area needs no edit in Store.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS ops_snapshots (
  kind        TEXT PRIMARY KEY,
  json        TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS briefings (
  id          TEXT PRIMARY KEY,
  json        TEXT NOT NULL,
  composed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ops_alerts (
  key TEXT PRIMARY KEY,
  at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ops_alerts_at ON ops_alerts (at);
CREATE TABLE IF NOT EXISTS ops_alert_pending (
  key  TEXT PRIMARY KEY,
  push TEXT NOT NULL,
  held INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ops_alert_pending_push ON ops_alert_pending (push);
CREATE TABLE IF NOT EXISTS ops_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL UNIQUE,
  category   TEXT NOT NULL,
  json       TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  retry_at   TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ops_outbox_meta (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  dropped INTEGER NOT NULL
);
INSERT OR IGNORE INTO ops_outbox_meta (id, dropped) VALUES (1, 0);
`;

// Before ops_alert_pending, an alert was recorded as told when its push was queued: one still undelivered waits on it again.
const UNTELL_QUEUED = `
INSERT INTO ops_alert_pending (key, push) SELECT key, key FROM ops_alerts WHERE key IN (SELECT key FROM ops_outbox) ON CONFLICT (key) DO NOTHING;
DELETE FROM ops_alerts WHERE key IN (SELECT key FROM ops_outbox);
`;

export const KEEP_BRIEFINGS = 120;
const ALERT_TTL_MS = 30 * 24 * 3600_000;
export const MAX_ALERTS = 2000;
/** An undelivered push is tried this many times, a minute apart, before it is dropped. */
export const MAX_PUSH_ATTEMPTS = 10;
export const PUSH_RETRY_MS = 60_000;
/** Past this many new alerts of one kind from one snapshot, they are queued as one summary push. */
export const ALERT_BATCH = 5;
/** Queued alert pushes past this many drop the oldest, counted for the next alert push; briefings are never dropped for room. */
export const MAX_QUEUED_ALERTS = 200;

export type OpsCategory = Exclude<PushCategory, "test" | "card">;

export interface OutboxItem {
  key: string;
  category: OpsCategory;
  payload: PushPayload;
  attempts: number;
}

/** A push to send once its record is stored: it stays queued until delivered or `expiresAt`. */
export interface QueuedPush {
  key: string;
  category: OpsCategory;
  payload: PushPayload;
  expiresAt: Date;
  /** The item whose owner silences the alert, kept with it while it waits: a deploy job's red workflow. */
  owner?: OwnedItem;
}

/** An alert a queued push carries, and the item recorded as its owner when it was queued, if any. */
export interface PendingAlert {
  key: string;
  owner: OwnedItem | null;
}

interface Snapshots {
  github: GithubSnapshot;
  merged: MergedPr[];
  /** PRs closed unmerged, for the Coming rows that leave the Feed. */
  closed: ClosedPr[];
  mac: MacSnapshot;
  claude: ClaudeUsageSnapshot;
  fly: FlySnapshot;
  health: Record<string, Health>;
  /** The Home page's last snapshot from the bridge, and the server's time it came in. */
  home: { snapshot: HomeSnapshot; receivedAt: string };
  /** When each runner that reads offline first did, in a row, to tell a retired runner from a down one. */
  runnersOffline: Record<string, string>;
  /** The bridge's last reading of each repo's open issues, for a project's backlog sheet. */
  backlog: StoredBacklog;
  /** The bridge's own time on the newest backlog reading that finished asks: only a later one finishes more. */
  backlogClosesAt: string;
  /** The Fix result cards already posted, by id, oldest first (ops/fixes.ts). */
  fixResults: string[];
  /** Failures with work under way read red at a pass (`kind/key/since`), kept across restarts (ops/fixes.ts). */
  fixSeenRed: string[];
  /** What the late sweeper did about each failure with work under way, by `kind/key/since` (ops/late.ts). */
  late: Record<string, LateLog>;
  /** The Ops cards posted and their generations (ops/cards.ts). */
  opsCards: CardBook;
  /** The local day the daily fold of old Done records last ran (shared/ops-done.ts). */
  doneFoldDay: string;
  /** The auto pick-up's clocks, starts and cards (ops/pickup.ts). */
  pickup: PickupState;
  /** Your own holds, as rivet hold records them: the one source of an Ops hold card (shared/owner-holds.ts). */
  ownerHolds: OwnerHold[];
}

export class OpsStore {
  private readonly db: DatabaseSync;
  private readonly maxAlerts: number;

  /** `maxAlerts` is only lowered by tests, so the cap is checked without thousands of writes. */
  constructor(dataDir: string, { maxAlerts = MAX_ALERTS }: { maxAlerts?: number } = {}) {
    this.maxAlerts = maxAlerts;
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "rivet.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    const pending = new Set((this.db.prepare("PRAGMA table_info(ops_alert_pending)").all() as { name: string }[]).map((column) => column.name));
    if (!pending.has("owner")) this.db.exec("ALTER TABLE ops_alert_pending ADD COLUMN owner TEXT");
    this.tx(() => {
      this.db.exec(UNTELL_QUEUED);
      this.untellLegacySummaries();
    });
  }

  /**
   * A legacy summary push (`summary:<first key>:<n>`) names only its first alert. The old server recorded every alert of
   * one raise at the same instant and summed one kind per push, so the summary's alerts are those recorded with its first
   * key's time and kind prefix. At worst an alert of another kind sharing the prefix and instant is untold, and repeats once.
   */
  private untellLegacySummaries(): void {
    const summaries = this.db
      .prepare("SELECT key FROM ops_outbox WHERE key LIKE 'summary:%' AND key NOT IN (SELECT push FROM ops_alert_pending)")
      .all() as { key: string }[];
    for (const { key } of summaries) {
      const first = /^summary:(.+):\d+$/.exec(key)?.[1];
      if (!first) continue;
      const kind = first.slice(0, first.indexOf(":") + 1);
      this.db
        .prepare(
          `INSERT INTO ops_alert_pending (key, push) SELECT key, ? FROM ops_alerts
           WHERE at = (SELECT at FROM ops_alerts WHERE key = ?) AND substr(key, 1, ?) = ? ON CONFLICT (key) DO NOTHING`,
        )
        .run(key, first, kind.length, kind);
      this.db.prepare("DELETE FROM ops_alerts WHERE key IN (SELECT key FROM ops_alert_pending WHERE push = ?)").run(key);
    }
  }

  close(): void {
    this.db.close();
  }

  get<K extends keyof Snapshots>(kind: K): Snapshots[K] | null {
    const row = this.db.prepare("SELECT json FROM ops_snapshots WHERE kind = ?").get(kind) as { json: string } | undefined;
    if (!row) return null;
    const value = JSON.parse(row.json) as Snapshots[K];
    // Snapshots stored before `sources`/`source` and run attempts were reported.
    if (kind === "github") {
      const github = value as GithubSnapshot;
      github.sources ??= null;
      for (const run of github.runs) run.attempt ??= 1;
    }
    if (kind === "fly") (value as FlySnapshot).source ??= null;
    return value;
  }

  put<K extends keyof Snapshots>(kind: K, value: Snapshots[K], at: Date): void {
    this.db
      .prepare(
        `INSERT INTO ops_snapshots (kind, json, received_at) VALUES (?, ?, ?)
         ON CONFLICT (kind) DO UPDATE SET json = excluded.json, received_at = excluded.received_at`,
      )
      .run(kind, JSON.stringify(value), at.toISOString());
  }

  getBriefing(id: string): Briefing | null {
    const row = this.db.prepare("SELECT json FROM briefings WHERE id = ?").get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Briefing) : null;
  }

  latestBriefing(): Briefing | null {
    return this.listBriefings(1)[0] ?? null;
  }

  listBriefings(limit: number): Briefing[] {
    const rows = this.db.prepare("SELECT json FROM briefings ORDER BY composed_at DESC, id DESC LIMIT ?").all(limit) as { json: string }[];
    return rows.map((row) => JSON.parse(row.json) as Briefing);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private enqueue(push: QueuedPush, at: Date): void {
    this.db
      .prepare("INSERT INTO ops_outbox (key, category, json, retry_at, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING")
      .run(push.key, push.category, JSON.stringify(push.payload), at.toISOString(), push.expiresAt.toISOString());
    if (push.category === "briefing") return;
    const pruned = this.db
      .prepare(
        `DELETE FROM ops_outbox WHERE category != 'briefing'
         AND id NOT IN (SELECT id FROM ops_outbox WHERE category != 'briefing' ORDER BY id DESC LIMIT ?)`,
      )
      .run(MAX_QUEUED_ALERTS).changes;
    if (!pruned) return;
    this.db.prepare("UPDATE ops_outbox_meta SET dropped = dropped + ? WHERE id = 1").run(pruned);
    // A count says nothing of which alert it was: a pruned alert is untold, and raises again while it holds.
    this.db.prepare("DELETE FROM ops_alert_pending WHERE held = 0 AND push NOT IN (SELECT key FROM ops_outbox)").run();
  }

  /** Stores a briefing once per slot id, with its push queued in the same step; false when that slot already has one. */
  addBriefing(briefing: Briefing, push: QueuedPush | null = null, at = new Date(briefing.composedAt)): boolean {
    return this.tx(() => {
      const result = this.db
        .prepare("INSERT INTO briefings (id, json, composed_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING")
        .run(briefing.id, JSON.stringify(briefing), briefing.composedAt);
      if (result.changes !== 1) return false;
      this.db
        .prepare("DELETE FROM briefings WHERE id NOT IN (SELECT id FROM briefings ORDER BY composed_at DESC, id DESC LIMIT ?)")
        .run(KEEP_BRIEFINGS);
      if (push) this.enqueue(push, at);
      return true;
    });
  }

  replaceBriefing(briefing: Briefing): void {
    this.db.prepare("UPDATE briefings SET json = ? WHERE id = ?").run(JSON.stringify(briefing), briefing.id);
  }

  /**
   * Queues the alerts neither told nor waiting in the outbox, so each alert pushes once; a key is recorded as told when its
   * push is delivered, and raises again if the outbox gives up on it. More than ALERT_BATCH new alerts of one kind go as
   * `summarise(group)`. Returns the new keys.
   */
  raiseAlerts(pushes: readonly QueuedPush[], at: Date, summarise: (group: QueuedPush[]) => QueuedPush): string[] {
    return this.tx(() => {
      this.db.prepare("DELETE FROM ops_alerts WHERE at < ?").run(new Date(at.getTime() - ALERT_TTL_MS).toISOString());
      const told = this.db.prepare("SELECT 1 FROM ops_alerts WHERE key = ? UNION ALL SELECT 1 FROM ops_alert_pending WHERE key = ?");
      const seen = new Set<string>();
      const fresh = pushes.filter((push) => !seen.has(push.key) && seen.add(push.key) && !told.get(push.key, push.key));
      if (!fresh.length) return [];
      const pending = this.db.prepare("INSERT INTO ops_alert_pending (key, push, owner) VALUES (?, ?, ?)");
      const queue = (push: QueuedPush, alerts: readonly QueuedPush[]) => {
        this.enqueue(push, at);
        for (const alert of alerts) pending.run(alert.key, push.key, alert.owner ? JSON.stringify(alert.owner) : null);
      };
      const groups = new Map<OpsCategory, QueuedPush[]>();
      for (const push of fresh) groups.set(push.category, [...(groups.get(push.category) ?? []), push]);
      for (const group of groups.values()) {
        if (group.length <= ALERT_BATCH) for (const push of group) queue(push, [push]);
        else queue(summarise(group), group);
      }
      return fresh.map((push) => push.key);
    });
  }

  alertCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM ops_alerts").get() as { n: number }).n;
  }

  /**
   * Pushes due now, oldest first, after dropping the expired and the worn out (`dropped`).
   * `unlisted` counts alert pushes pruned for room that no push has mentioned yet.
   */
  duePushes(now: Date): { due: OutboxItem[]; dropped: number; unlisted: number } {
    const dropped = this.tx(() => {
      // An alert given up on was never told: it raises again while it holds.
      this.db
        .prepare("DELETE FROM ops_alert_pending WHERE push IN (SELECT key FROM ops_outbox WHERE expires_at <= ? OR attempts >= ?)")
        .run(now.toISOString(), MAX_PUSH_ATTEMPTS);
      return this.db.prepare("DELETE FROM ops_outbox WHERE expires_at <= ? OR attempts >= ?").run(now.toISOString(), MAX_PUSH_ATTEMPTS).changes;
    });
    const rows = this.db
      .prepare("SELECT key, category, json, attempts FROM ops_outbox WHERE retry_at <= ? ORDER BY id ASC")
      .all(now.toISOString()) as { key: string; category: OpsCategory; json: string; attempts: number }[];
    return {
      due: rows.map((row) => ({ key: row.key, category: row.category, payload: JSON.parse(row.json) as PushPayload, attempts: row.attempts })),
      dropped: Number(dropped),
      unlisted: (this.db.prepare("SELECT dropped FROM ops_outbox_meta WHERE id = 1").get() as { dropped: number }).dropped,
    };
  }

  /** A delivered push mentioned `count` pruned alerts. */
  clearUnlisted(count: number): void {
    this.db.prepare("UPDATE ops_outbox_meta SET dropped = MAX(0, dropped - ?) WHERE id = 1").run(count);
  }

  pushDelivered(key: string, at: Date): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM ops_outbox WHERE key = ?").run(key);
      const told = this.db
        .prepare("INSERT INTO ops_alerts (key, at) SELECT key, ? FROM ops_alert_pending WHERE push = ? ON CONFLICT (key) DO NOTHING")
        .run(at.toISOString(), key).changes;
      this.db.prepare("DELETE FROM ops_alert_pending WHERE push = ?").run(key);
      if (told) this.db.prepare("DELETE FROM ops_alerts WHERE key NOT IN (SELECT key FROM ops_alerts ORDER BY at DESC LIMIT ?)").run(this.maxAlerts);
    });
  }

  /** Quiet hours hold the push: it leaves the outbox, and its alerts wait on the digest (`digestSettled`). */
  pushHeld(key: string): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM ops_outbox WHERE key = ?").run(key);
      this.db.prepare("UPDATE ops_alert_pending SET held = 1 WHERE push = ?").run(key);
    });
  }

  /**
   * Held `pushes` were settled: delivered in a digest, their alerts are told; never sent (the digest given up on, or pruned
   * from the hold), they are untold and raise again. A push held since is not among them and keeps waiting.
   */
  digestSettled(delivered: boolean, pushes: readonly string[], at: Date): void {
    this.tx(() => {
      const tell = this.db.prepare("INSERT INTO ops_alerts (key, at) SELECT key, ? FROM ops_alert_pending WHERE held = 1 AND push = ? ON CONFLICT (key) DO NOTHING");
      const settle = this.db.prepare("DELETE FROM ops_alert_pending WHERE held = 1 AND push = ?");
      for (const push of pushes) {
        if (delivered) tell.run(at.toISOString(), push);
        settle.run(push);
      }
      if (delivered && pushes.length) this.db.prepare("DELETE FROM ops_alerts WHERE key NOT IN (SELECT key FROM ops_alerts ORDER BY at DESC LIMIT ?)").run(this.maxAlerts);
    });
  }

  /** A queued push that is no longer sent: it leaves the outbox untold, so its alerts raise again while they hold. */
  /** The alerts a queued push carries: its own, or a summary's each, with the owner item each was queued with. */
  pendingAlerts(push: string): PendingAlert[] {
    const rows = this.db.prepare("SELECT key, owner FROM ops_alert_pending WHERE push = ? ORDER BY key").all(push) as { key: string; owner: string | null }[];
    return rows.map((row) => ({ key: row.key, owner: row.owner ? (JSON.parse(row.owner) as OwnedItem) : null }));
  }

  /** Names the owner of each pending alert queued before owners were kept, where `ownerOf` can. */
  fillOwners(ownerOf: (key: string) => OwnedItem | null): void {
    const rows = this.db.prepare("SELECT key FROM ops_alert_pending WHERE owner IS NULL").all() as { key: string }[];
    const fill = this.db.prepare("UPDATE ops_alert_pending SET owner = ? WHERE key = ? AND owner IS NULL");
    this.tx(() => {
      for (const { key } of rows) {
        const owner = ownerOf(key);
        if (owner) fill.run(JSON.stringify(owner), key);
      }
    });
  }

  pushDropped(key: string): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM ops_outbox WHERE key = ?").run(key);
      this.db.prepare("DELETE FROM ops_alert_pending WHERE push = ?").run(key);
    });
  }

  pushFailed(key: string, now: Date): void {
    this.db
      .prepare("UPDATE ops_outbox SET attempts = attempts + 1, retry_at = ? WHERE key = ?")
      .run(new Date(now.getTime() + PUSH_RETRY_MS).toISOString(), key);
  }

  pendingPushes(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM ops_outbox").get() as { n: number }).n;
  }
}
