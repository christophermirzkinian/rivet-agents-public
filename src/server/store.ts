import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { ANSWERED_KEEP_MS, cardFromReply, DONE_ASK_STAGES, type Reopen } from "../shared/answered.js";
import { type Ask, type AskStage } from "../shared/asks.js";
import { FILE_TYPES, type Board, type BridgeAck, type Decision, type FileRef, type FileType, type Need, type PushRemoval, type PushRemovalReason, type Reply, type ReplyItem } from "../shared/board.js";
import { IMAGE_TYPES } from "../shared/command.js";
import { NO_REPO } from "../shared/board.js";
import type { OpsDismissal } from "../shared/ops-dismiss.js";
import { upgradeOpsStatus, type OpsStatus } from "../shared/ops-status.js";
import { MAX_USAGE_EVENTS_PER_DAY, USAGE_KEEP_MS, type UsageAsk, type UsageBatch, type UsageCount, type UsageDevice, type UsageEventKind } from "../shared/usage-ids.js";
import type { WorkerSnapshot } from "../shared/workers.js";
import { stemOf, WAIT_PREFIX, yesKey } from "./asks/waits.js";

// Loaded through createRequire rather than a static import: Vite 5's builtin
// list predates `node:sqlite`, so under vitest a static import is resolved as a
// bare package named "sqlite" and fails.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

type DatabaseSync = InstanceType<typeof DatabaseSync>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS credentials (
  id           TEXT PRIMARY KEY,
  public_key   BLOB NOT NULL,
  counter      INTEGER NOT NULL,
  transports   TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  hash       TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS spent_enroll_tokens (
  hash     TEXT PRIMARY KEY,
  spent_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS device_codes (
  hash       TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS board (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  json       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS replies (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL UNIQUE,
  item_id      TEXT NOT NULL,
  item_title   TEXT NOT NULL,
  decision     TEXT NOT NULL,
  choice       TEXT,
  text         TEXT,
  rev          TEXT NOT NULL,
  at           TEXT NOT NULL,
  item         TEXT NOT NULL,
  handled      INTEGER NOT NULL DEFAULT 0,
  handled_at   TEXT,
  delivered_at TEXT,
  delivery     TEXT,
  github       TEXT,
  error        TEXT,
  image        TEXT,
  files        TEXT,
  images       TEXT,
  acted_at     TEXT
);
CREATE INDEX IF NOT EXISTS replies_pending ON replies (handled, delivered_at, at);
CREATE INDEX IF NOT EXISTS replies_item ON replies (item_id, at);
CREATE TABLE IF NOT EXISTS workers (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL,
  at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS asks (
  id         TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status_at  TEXT NOT NULL,
  version    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS asks_created ON asks (created_at, id);
CREATE TABLE IF NOT EXISTS ops_status (
  kind       TEXT NOT NULL,
  key        TEXT NOT NULL,
  json       TEXT NOT NULL,
  state      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version    INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
);
-- Your Dismiss on a red Ops item, with the item's mark when you dismissed it (src/shared/ops-dismiss.ts).
CREATE TABLE IF NOT EXISTS ops_dismissals (
  kind TEXT NOT NULL,
  key  TEXT NOT NULL,
  mark TEXT NOT NULL,
  at   TEXT NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- Every phone the server dropped and why: a silent prune once left you with no notifications for two days (ask 98z7p).
CREATE TABLE IF NOT EXISTS push_removals (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  reason    TEXT NOT NULL,
  status    INTEGER,
  host      TEXT NOT NULL,
  remaining INTEGER NOT NULL
);
-- Rate-limit windows, kept on disk so a restart does not refill an allowance. Keys are IPs or session hashes.
CREATE TABLE IF NOT EXISTS rate_hits (
  scope    TEXT NOT NULL,
  key      TEXT NOT NULL,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS rate_hits_reset ON rate_hits (reset_at);
-- Each update card you saw, as you saw it, for the Updates stream's Show older once it leaves the board.
CREATE TABLE IF NOT EXISTS seen_updates (
  id      TEXT PRIMARY KEY,
  rev     TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  card    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS seen_updates_at ON seen_updates (seen_at DESC, id DESC);
-- Cards and Done rows you minimised, at the revision you did: every phone counts the same deck (2026-10-26).
CREATE TABLE IF NOT EXISTS minimised (
  key TEXT PRIMARY KEY,
  rev TEXT NOT NULL,
  at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS minimised_at ON minimised (at DESC);
-- Each card you answered, as you answered it, kept 30 days for Cards' Answered list and Reopen.
CREATE TABLE IF NOT EXISTS answered_cards (
  id          TEXT PRIMARY KEY,
  rev         TEXT NOT NULL,
  answered_at TEXT NOT NULL,
  reply_id    TEXT NOT NULL,
  card        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS answered_cards_at ON answered_cards (answered_at DESC, id DESC);
-- Each Reopen, and the bridge's notice of it to Rivet's chat.
CREATE TABLE IF NOT EXISTS reopens (
  id           TEXT PRIMARY KEY,
  card_id      TEXT NOT NULL,
  rev          TEXT NOT NULL,
  at           TEXT NOT NULL,
  reply_id     TEXT NOT NULL,
  title        TEXT NOT NULL,
  chat         TEXT,
  repo         TEXT NOT NULL,
  merged       INTEGER NOT NULL DEFAULT 0,
  sent_at      TEXT,
  delivered_at TEXT,
  confirmed    INTEGER,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS reopens_card ON reopens (card_id, at);
-- What you used: each screen, tap and card answer by its registry id (shared/usage-ids.ts), never any
-- text. Kept 90 days, pruned on insert. got is when the server took it, for the daily cap; app_at its ms by the app's
-- clock, which names it when the app sends it again.
CREATE TABLE IF NOT EXISTS usage_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  got    TEXT NOT NULL,
  device TEXT NOT NULL,
  kind   TEXT NOT NULL,
  ctl    TEXT NOT NULL,
  screen TEXT NOT NULL,
  value  INTEGER NOT NULL,
  app_at INTEGER
);
CREATE INDEX IF NOT EXISTS usage_events_at ON usage_events (at);
CREATE INDEX IF NOT EXISTS usage_events_ctl ON usage_events (ctl, at);
CREATE INDEX IF NOT EXISTS usage_events_got ON usage_events (device, got);
-- What you used's Retire? and Rework? cards: the id each asks about, and your answer (Keep hides it 90 days).
CREATE TABLE IF NOT EXISTS usage_asks (
  card        TEXT PRIMARY KEY,
  ctl         TEXT NOT NULL,
  ask         TEXT NOT NULL,
  weekly      INTEGER NOT NULL,
  at          TEXT NOT NULL,
  answer      TEXT,
  answered_at TEXT
);
`;

/** More than the board and today's Done hold; the oldest drop first. */
export const MAX_MINIMISED = 200;

/** One user with a few devices; the oldest subscription goes past this. */
export const MAX_PUSH_SUBSCRIPTIONS = 20;
/** Removal records kept, newest first. */
export const MAX_PUSH_REMOVALS = 200;

export interface StoredCredential {
  id: string;
  publicKey: Uint8Array;
  counter: number;
  transports?: string[];
}

export interface StoredBoard {
  board: Board;
  version: number;
  updatedAt: string;
}

export interface StoredWorkers {
  snapshot: WorkerSnapshot;
  at: string;
}

/** A push endpoint's host, never its path (a capability to push to that phone) nor a parse error that would quote it. */
export function pushHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname.toLowerCase() || "unknown";
  } catch {
    return "unknown";
  }
}

export interface PushSubscriptionRow {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface NewReply {
  clientId: string;
  itemId: string;
  itemTitle: string;
  decision: Decision;
  choice?: string;
  text?: string;
  image?: string;
  images?: string[];
  files?: FileRef[];
  rev: string;
  item: ReplyItem;
}

type Row = Record<string, unknown>;

const DAY_MS = 24 * 60 * 60 * 1000;

function toReply(row: Row): Reply {
  const reply: Reply = {
    id: row.id as string,
    itemId: row.item_id as string,
    itemTitle: row.item_title as string,
    decision: row.decision as Decision,
    rev: row.rev as string,
    at: row.at as string,
    handled: row.handled === 1,
    item: JSON.parse(row.item as string) as ReplyItem,
  };
  if (typeof row.client_id === "string") reply.clientId = row.client_id;
  if (row.choice !== null) reply.choice = row.choice as string;
  if (row.text !== null) reply.text = row.text as string;
  if (typeof row.image === "string") reply.image = row.image;
  if (typeof row.images === "string") reply.images = JSON.parse(row.images) as string[];
  if (typeof row.files === "string") reply.files = JSON.parse(row.files) as FileRef[];
  if (row.handled_at !== null) reply.handledAt = row.handled_at as string;
  if (typeof row.acted_at === "string") reply.actedAt = row.acted_at;
  if (row.delivery !== null) reply.delivery = JSON.parse(row.delivery as string) as Reply["delivery"];
  if (row.github !== null) reply.github = JSON.parse(row.github as string) as Reply["github"];
  if (row.error !== null) reply.error = row.error as string;
  return reply;
}

function toReopen(row: Row): Reopen {
  return {
    id: row.id as string,
    cardId: row.card_id as string,
    rev: row.rev as string,
    at: row.at as string,
    replyId: row.reply_id as string,
    title: row.title as string,
    ...(typeof row.chat === "string" ? { chat: row.chat } : {}),
    ...(row.repo ? { repo: row.repo as string } : {}),
    ...(row.merged === 1 ? { merged: true as const } : {}),
    ...(typeof row.sent_at === "string" ? { sentAt: row.sent_at } : {}),
    ...(typeof row.delivered_at === "string" ? { delivery: { at: row.delivered_at, confirmed: row.confirmed === 1 } } : {}),
    ...(typeof row.error === "string" ? { error: row.error } : {}),
  };
}

// A thread's PRs and chats go in as one JSON parameter each (json_each), so any number of them never grows the SQL
// expression past SQLite's depth limit. A reply naming no repo is NO_REPO's, bound after each JSON parameter.
const LINK_REPO = "LOWER(COALESCE(json_extract(item, '$.repo'), ?)) = json_extract(link.value, '$.repo')";
const FOR_PRS = `EXISTS (SELECT 1 FROM json_each(?) AS link WHERE json_extract(item, '$.pr') = json_extract(link.value, '$.number') AND ${LINK_REPO})`;

/** The PRs for FOR_PRS, deduped, repos lower-cased. */
function prsParam(prs: readonly { repo: string; number: number }[]): string {
  return JSON.stringify([...new Map(prs.map((pr) => [`${pr.repo.toLowerCase()}#${pr.number}`, { repo: pr.repo.toLowerCase(), number: pr.number }])).values()]);
}

/** One stored usage event, as What you used reads it. */
export interface UsageEventRow {
  at: string;
  device: UsageDevice;
  kind: UsageEventKind;
  ctl: string;
  screen: string;
  value: number;
}

/** A Retire? or Rework? card and its answer. */
export interface UsageAskRow {
  card: string;
  ctl: string;
  ask: UsageAsk;
  /** The Monday pass made it, not a tap on the page. */
  weekly: boolean;
  at: string;
  answer: string | null;
  answeredAt: string | null;
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly askListeners = new Set<(ask: Ask, previous: Ask | null) => void>();
  private readonly replyListeners = new Set<(reply: Reply) => void>();
  private readonly noteListeners = new Set<(note: { card: string; text: string; at: string }) => void>();
  private readonly replyAckedListeners = new Set<(reply: Reply) => void>();
  private readonly boardListeners = new Set<(board: Board) => void>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "rivet.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Columns added after the first deploy (v1, 2026-09-28) to a table that already exists. */
  private migrate(): void {
    const columns = (table: string) =>
      new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name));
    if (!columns("replies").has("rev")) this.db.exec("ALTER TABLE replies ADD COLUMN rev TEXT NOT NULL DEFAULT ''");
    if (!columns("replies").has("image")) this.db.exec("ALTER TABLE replies ADD COLUMN image TEXT");
    if (!columns("replies").has("files")) this.db.exec("ALTER TABLE replies ADD COLUMN files TEXT");
    if (!columns("replies").has("images")) this.db.exec("ALTER TABLE replies ADD COLUMN images TEXT");
    if (!columns("usage_events").has("app_at")) this.db.exec("ALTER TABLE usage_events ADD COLUMN app_at INTEGER");
    // An event the app sent again after a lost answer is the same one by the app's clock; rows without it are all distinct.
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS usage_events_once ON usage_events (device, app_at, kind, ctl, screen, value)");
    // Handled with no delivery could only have been marked by Rivet himself: that was acting on it.
    if (!columns("replies").has("acted_at")) {
      this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE replies ADD COLUMN acted_at TEXT;
        UPDATE replies SET acted_at = handled_at WHERE handled = 1 AND delivered_at IS NULL;
        COMMIT;`);
    }
    // Workers went by a name from a pool; they go by their chat name now.
    this.db.exec("DROP TABLE IF EXISTS worker_names");
    this.backfillAnswered();
  }

  /**
   * Once: the cards answered in the 30 days before answered cards were kept, each rebuilt (cardFromReply) from the
   * answer of record to its latest answered revision, the first one to it, as Reopen names it (firstReplyAt), so every
   * one of them shows on Answered and reopens too. An answer from before replies carried a revision names none to
   * reopen, and is left out.
   */
  private backfillAnswered(): void {
    if (this.db.prepare("SELECT 1 FROM meta WHERE key = 'answered_backfill'").get()) return;
    const since = new Date(Date.now() - ANSWERED_KEEP_MS).toISOString();
    const answered = this.db
      .prepare(
        `SELECT * FROM replies WHERE decision <> 'seen' AND rev <> '' AND COALESCE(json_extract(item, '$.kind'), '') <> 'update'
           AND item_id NOT LIKE 'schedule-%' AND item_id IN (SELECT item_id FROM replies WHERE at >= ? AND decision <> 'seen')
         ORDER BY at, rowid`,
      )
      .all(since) as Row[];
    const latest = new Map<string, string>();
    const first = new Map<string, Row>();
    for (const row of answered) {
      latest.set(row.item_id as string, row.rev as string);
      const key = `${row.item_id as string}\n${row.rev as string}`;
      if (!first.has(key)) first.set(key, row);
    }
    const rows = [...latest].map(([itemId, rev]) => first.get(`${itemId}\n${rev}`)!);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.prepare("INSERT OR IGNORE INTO answered_cards (id, rev, answered_at, reply_id, card) VALUES (?, ?, ?, ?, ?)");
      for (const row of rows) {
        const reply = toReply(row);
        insert.run(reply.itemId, reply.rev, reply.at, reply.id, JSON.stringify(cardFromReply(reply)));
      }
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('answered_backfill', ?)").run(new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  /** The single user's WebAuthn user handle, created on first use. */
  userId(): Uint8Array {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'user_id'").get() as Row | undefined;
    if (row) return Buffer.from(row.value as string, "base64url");
    const id = randomBytes(32);
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('user_id', ?)").run(id.toString("base64url"));
    return id;
  }

  /** Counts a hit in `key`'s window, which opens at its first hit and lasts `windowMs`; returns the window's count. */
  countHit(scope: string, key: string, windowMs: number): number {
    const now = Date.now();
    this.db.prepare("DELETE FROM rate_hits WHERE reset_at <= ?").run(now);
    const row = this.db
      .prepare(
        `INSERT INTO rate_hits (scope, key, count, reset_at) VALUES (?, ?, 1, ?)
         ON CONFLICT (scope, key) DO UPDATE SET count = count + 1 RETURNING count`,
      )
      .get(scope, key, now + windowMs) as Row;
    return Number(row.count);
  }

  // Credentials

  listCredentials(): StoredCredential[] {
    return (this.db.prepare("SELECT * FROM credentials ORDER BY created_at").all() as Row[]).map((row) => this.toCredential(row));
  }

  getCredential(id: string): StoredCredential | null {
    const row = this.db.prepare("SELECT * FROM credentials WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toCredential(row) : null;
  }

  addCredential(credential: StoredCredential): void {
    this.db
      .prepare("INSERT INTO credentials (id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(
        credential.id,
        credential.publicKey,
        credential.counter,
        credential.transports ? JSON.stringify(credential.transports) : null,
        Date.now(),
      );
  }

  touchCredential(id: string, counter: number): void {
    this.db.prepare("UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?").run(counter, Date.now(), id);
  }

  private toCredential(row: Row): StoredCredential {
    return {
      id: row.id as string,
      publicKey: new Uint8Array(row.public_key as Uint8Array),
      counter: row.counter as number,
      ...(row.transports ? { transports: JSON.parse(row.transports as string) as string[] } : {}),
    };
  }

  // Sessions (hashes only)

  addSession(hash: string, ttlMs: number): void {
    const now = Date.now();
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    this.db.prepare("INSERT INTO sessions (hash, created_at, expires_at) VALUES (?, ?, ?)").run(hash, now, now + ttlMs);
  }

  hasSession(hash: string): boolean {
    return this.db.prepare("SELECT 1 FROM sessions WHERE hash = ? AND expires_at > ?").get(hash, Date.now()) !== undefined;
  }

  deleteSession(hash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE hash = ?").run(hash);
  }

  // Enrolment

  isEnrollTokenSpent(hash: string): boolean {
    return this.db.prepare("SELECT 1 FROM spent_enroll_tokens WHERE hash = ?").get(hash) !== undefined;
  }

  /** Returns false when the token was already spent. */
  spendEnrollToken(hash: string): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO spent_enroll_tokens (hash, spent_at) VALUES (?, ?)")
      .run(hash, Date.now());
    return Number(result.changes) === 1;
  }

  addDeviceCode(hash: string, ttlMs: number): number {
    const now = Date.now();
    this.db.prepare("DELETE FROM device_codes WHERE expires_at <= ?").run(now);
    this.db
      .prepare("INSERT INTO device_codes (hash, created_at, expires_at) VALUES (?, ?, ?)")
      .run(hash, now, now + ttlMs);
    return now + ttlMs;
  }

  isDeviceCodeValid(hash: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM device_codes WHERE hash = ? AND used = 0 AND expires_at > ?")
        .get(hash, Date.now()) !== undefined
    );
  }

  /** Returns false when the code is unknown, expired or already used. */
  useDeviceCode(hash: string): boolean {
    const result = this.db
      .prepare("UPDATE device_codes SET used = 1 WHERE hash = ? AND used = 0 AND expires_at > ?")
      .run(hash, Date.now());
    return Number(result.changes) === 1;
  }

  // Board

  getBoard(): StoredBoard | null {
    const row = this.db.prepare("SELECT json, version, updated_at FROM board WHERE id = 1").get() as Row | undefined;
    if (!row) return null;
    return { board: JSON.parse(row.json as string) as Board, version: row.version as number, updatedAt: row.updated_at as string };
  }

  boardVersion(): number {
    const row = this.db.prepare("SELECT version FROM board WHERE id = 1").get() as Row | undefined;
    return row ? (row.version as number) : 0;
  }

  /** Writes the board unless `ifVersion` is given and stale; returns null on a conflict. */
  putBoard(board: Board, ifVersion: number | null): { version: number; updatedAt: string } | null {
    const current = this.boardVersion();
    if (ifVersion !== null && ifVersion !== current) return null;
    const version = current + 1;
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO board (id, json, version, updated_at) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET json = excluded.json, version = excluded.version, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(board), version, updatedAt);
    for (const listener of this.boardListeners) listener(board);
    return { version, updatedAt };
  }

  /** Hears each board as it is written (the Media tab records its cards' photos and videos); returns the unsubscribe. */
  onBoard(listener: (board: Board) => void): () => void {
    this.boardListeners.add(listener);
    return () => this.boardListeners.delete(listener);
  }

  // Asks

  /**
   * Newest first (created_at, then id), at most `limit`. `doneSince` keeps finished asks (shipped, parked, done) only when
   * their stage changed at or after it; `before` starts after that ask in the same order. The `status` column holds the stage.
   */
  listAsks(opts: { limit: number; stage?: AskStage; doneSince?: string; before?: { createdAt: string; id: string } }): Ask[] {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.stage !== undefined) {
      where.push("status = ?");
      args.push(opts.stage);
    }
    if (opts.doneSince !== undefined) {
      where.push("(status NOT IN ('shipped', 'parked', 'done') OR status_at >= ?)");
      args.push(opts.doneSince);
    }
    if (opts.before) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      args.push(opts.before.createdAt, opts.before.createdAt, opts.before.id);
    }
    // The bounded default list puts unfinished asks first, so its limit drops recent finished ones before anything still open.
    const sql = `SELECT json FROM asks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${opts.doneSince !== undefined ? "status IN ('shipped', 'parked', 'done'), " : ""}created_at DESC, id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, opts.limit) as Row[];
    return rows.map((row) => JSON.parse(row.json as string) as Ask);
  }

  countAsks(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM asks").get() as Row).n);
  }

  /**
   * Ask ids that actions name (a Town tell's or Team Chat post's `request.ask`), made or not: the command store's
   * audit rows, in this same file. One held by an action whose ask is not made yet is still taken.
   */
  heldAskIds(id?: string): string[] {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit'").get()) return [];
    const held = "json_extract(request, '$.ask.id')";
    const rows = (id === undefined ? this.db.prepare(`SELECT ${held} AS id FROM audit WHERE ${held} IS NOT NULL`).all() : this.db.prepare(`SELECT ${held} AS id FROM audit WHERE ${held} = ?`).all(id)) as Row[];
    return rows.map((row) => String(row.id));
  }

  /** Your chat line `id` (a Town tell or a typed message), for an ask made from it; null for anything else. */
  ownerMessage(id: string): { text: string; at: string } | null {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit'").get()) return null;
    const row = this.db.prepare("SELECT at, json_extract(request, '$.text') AS text FROM audit WHERE id = ? AND kind = 'chat'").get(id) as Row | undefined;
    return row && typeof row.text === "string" && row.text.trim() !== "" ? { text: row.text, at: String(row.at) } : null;
  }

  /** Which of `cardIds` an ask names as its card while that ask is shipped or done (`DONE_ASK_STAGES`): Answered's Show done. */
  finishedAskCards(cardIds: readonly string[]): Set<string> {
    if (!cardIds.length) return new Set();
    const rows = this.db
      .prepare(
        `SELECT DISTINCT json_extract(json, '$.cardId') AS card FROM asks
         WHERE status IN (${DONE_ASK_STAGES.map(() => "?").join(", ")}) AND json_extract(json, '$.cardId') IN (SELECT value FROM json_each(?))`,
      )
      .all(...DONE_ASK_STAGES, JSON.stringify(cardIds)) as Row[];
    return new Set(rows.map((row) => String(row.card)));
  }

  getAsk(id: string): Ask | null {
    const row = this.db.prepare("SELECT json FROM asks WHERE id = ?").get(id) as Row | undefined;
    return row ? (JSON.parse(row.json as string) as Ask) : null;
  }

  /** Hears each card answer as it is stored, and again when it is retried (the conversation it lands in). */
  onReply(listener: (reply: Reply) => void): () => void {
    this.replyListeners.add(listener);
    return () => this.replyListeners.delete(listener);
  }

  /** Hears Rivet's line under an update card (rivet card note), so it lands in the card's conversation too. */
  onCardNote(listener: (note: { card: string; text: string; at: string }) => void): () => void {
    this.noteListeners.add(listener);
    return () => this.noteListeners.delete(listener);
  }

  cardNoted(note: { card: string; text: string; at: string }): void {
    for (const listener of this.noteListeners) listener(note);
  }

  /** Hears each answer the bridge acks as delivered, and again on each repeated ack. */
  onReplyAcked(listener: (reply: Reply) => void): () => void {
    this.replyAckedListeners.add(listener);
    return () => this.replyAckedListeners.delete(listener);
  }

  /** A retried answer (same clientId): the listeners hear it again, so what one lost to a restart is made good. */
  replayReply(reply: Reply): void {
    for (const listener of this.replyListeners) listener(reply);
  }

  /** Calls `listener` with each ask once it is stored, and what it replaced (null for a new one); returns the unsubscribe. */

  onAsk(listener: (ask: Ask, previous: Ask | null) => void): () => void {
    this.askListeners.add(listener);
    return () => this.askListeners.delete(listener);
  }

  /** False when the id is taken. */
  addAsk(ask: Ask): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO asks (id, json, status, created_at, status_at, version) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ask.id, JSON.stringify(ask), ask.stage, ask.createdAt, ask.stageAt, ask.version);
    if (Number(result.changes) !== 1) return false;
    for (const listener of this.askListeners) listener(ask, null);
    return true;
  }

  /** Writes `ask` over the stored one only while that is still at `fromVersion`; false when it moved on. */
  replaceAsk(ask: Ask, fromVersion: number): boolean {
    const previous = this.getAsk(ask.id);
    const result = this.db
      .prepare("UPDATE asks SET json = ?, status = ?, status_at = ?, version = ? WHERE id = ? AND version = ?")
      .run(JSON.stringify(ask), ask.stage, ask.stageAt, ask.version, ask.id, fromVersion);
    if (Number(result.changes) !== 1) return false;
    for (const listener of this.askListeners) listener(ask, previous);
    return true;
  }

  // Push subscriptions

  /** Stores or refreshes a phone; past the cap the oldest go, each recorded as a `cap` removal and returned. */
  addPushSubscription(subscription: PushSubscriptionRow, now = new Date()): PushRemoval[] {
    // One savepoint with the cap's removals, so a failed removal record never leaves the store over the cap.
    this.db.exec("SAVEPOINT push_add");
    try {
      const pruned = this.addAndCap(subscription, now);
      this.db.exec("RELEASE push_add");
      return pruned;
    } catch (error) {
      this.db.exec("ROLLBACK TO push_add; RELEASE push_add");
      throw error;
    }
  }

  private addAndCap(subscription: PushSubscriptionRow, now: Date): PushRemoval[] {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
      )
      .run(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, now.getTime());
    const over = this.db
      .prepare(
        `SELECT endpoint FROM push_subscriptions WHERE endpoint NOT IN
           (SELECT endpoint FROM push_subscriptions ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
      )
      .all(MAX_PUSH_SUBSCRIPTIONS) as Row[];
    return over.flatMap((row) => this.removePushSubscription(row.endpoint as string, "cap", null, now) ?? []);
  }

  /**
   * Deletes a phone and records why, in one savepoint so a phone is never gone without its record (it nests inside
   * any outer transaction); the record, or null when the server did not hold it.
   */
  removePushSubscription(endpoint: string, reason: PushRemovalReason, status: number | null = null, now = new Date()): PushRemoval | null {
    this.db.exec("SAVEPOINT push_removal");
    try {
      if (Number(this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint).changes) !== 1) {
        this.db.exec("RELEASE push_removal");
        return null;
      }
      const removal: PushRemoval = { at: now.toISOString(), reason, status, host: pushHost(endpoint), remaining: this.countPushSubscriptions() };
      this.db
        .prepare("INSERT INTO push_removals (at, reason, status, host, remaining) VALUES (?, ?, ?, ?, ?)")
        .run(removal.at, removal.reason, removal.status, removal.host, removal.remaining);
      this.db.prepare("DELETE FROM push_removals WHERE id NOT IN (SELECT id FROM push_removals ORDER BY id DESC LIMIT ?)").run(MAX_PUSH_REMOVALS);
      this.db.exec("RELEASE push_removal");
      return removal;
    } catch (error) {
      this.db.exec("ROLLBACK TO push_removal; RELEASE push_removal");
      throw error;
    }
  }

  countPushSubscriptions(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get() as Row).n);
  }

  /** Removal records, newest first. */
  listPushRemovals(limit = MAX_PUSH_REMOVALS): PushRemoval[] {
    return (this.db.prepare("SELECT * FROM push_removals ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map((row) => ({
      at: row.at as string,
      reason: row.reason as PushRemovalReason,
      status: row.status === null ? null : Number(row.status),
      host: row.host as string,
      remaining: Number(row.remaining),
    }));
  }

  hasPushSubscription(endpoint: string): boolean {
    return this.db.prepare("SELECT 1 FROM push_subscriptions WHERE endpoint = ?").get(endpoint) !== undefined;
  }

  listPushSubscriptions(): PushSubscriptionRow[] {
    return (this.db.prepare("SELECT * FROM push_subscriptions ORDER BY created_at, rowid").all() as Row[]).map((row) => ({
      endpoint: row.endpoint as string,
      keys: { p256dh: row.p256dh as string, auth: row.auth as string },
    }));
  }

  // Replies

  getReply(id: string): Reply | null {
    const row = this.db.prepare("SELECT * FROM replies WHERE id = ?").get(id) as Row | undefined;
    return row ? toReply(row) : null;
  }

  /**
   * The answer to card `itemId`, titled `title`, at or after `since`: the first answer to that showing of it, not to
   * an older or later card under the same id, or the answer that changed it through Answer again.
   */
  cardAnswer(itemId: string, title: string, since: string): Reply | null {
    let row = this.db.prepare("SELECT * FROM replies WHERE item_id = ? AND item_title = ? AND at >= ? ORDER BY at, rowid LIMIT 1").get(itemId, title, since) as
      | Row
      | undefined;
    const changed = this.db.prepare("SELECT * FROM replies WHERE item_id = ? AND json_extract(item, '$.changes.replyId') = ? ORDER BY at, rowid LIMIT 1");
    // Each change names an earlier answer, and Answer again counts to 1000.
    for (let n = 0; row && n < 1000; n += 1) {
      const next = changed.get(itemId, row.id as string) as Row | undefined;
      if (!next) break;
      row = next;
    }
    return row ? toReply(row) : null;
  }

  /** The first answer recorded to this revision of a card, the one of record, or its first `decision`; null when it has none. */
  firstReplyAt(itemId: string, rev: string, decision?: Decision): Reply | null {
    const row = (
      decision
        ? this.db.prepare("SELECT * FROM replies WHERE item_id = ? AND rev = ? AND decision = ? ORDER BY at, rowid LIMIT 1").get(itemId, rev, decision)
        : this.db.prepare("SELECT * FROM replies WHERE item_id = ? AND rev = ? ORDER BY at, rowid LIMIT 1").get(itemId, rev)
    ) as Row | undefined;
    return row ? toReply(row) : null;
  }

  /** Every answer recorded to this revision of a card, first first. */
  repliesAt(itemId: string, rev: string): Reply[] {
    return (this.db.prepare("SELECT * FROM replies WHERE item_id = ? AND rev = ? ORDER BY at, rowid").all(itemId, rev) as Row[]).map(toReply);
  }

  /** Keeps an update card as you saw it, the newest revision you saw per card: Show older reads it off the board. */
  keepSeenUpdate(card: Need, rev: string, seenAt: string): void {
    this.db
      .prepare(
        `INSERT INTO seen_updates (id, rev, seen_at, card) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET rev = excluded.rev, seen_at = excluded.seen_at, card = excluded.card
         WHERE excluded.seen_at >= seen_updates.seen_at`,
      )
      .run(card.id, rev, seenAt, JSON.stringify(card));
  }

  /** Whether this revision of the card is kept already. */
  hasSeenUpdate(id: string, rev: string): boolean {
    return this.db.prepare("SELECT 1 FROM seen_updates WHERE id = ? AND rev = ?").get(id, rev) !== undefined;
  }

  /** Kept update cards, the last seen first, from after `before` (a page's last seen_at and id) on, at most `limit`. */
  seenUpdates(before: { seenAt: string; id: string } | null, limit: number): { card: Need; rev: string; seenAt: string }[] {
    const rows = (
      before
        ? this.db
            .prepare("SELECT id, rev, seen_at, card FROM seen_updates WHERE seen_at < ? OR (seen_at = ? AND id < ?) ORDER BY seen_at DESC, id DESC LIMIT ?")
            .all(before.seenAt, before.seenAt, before.id, limit)
        : this.db.prepare("SELECT id, rev, seen_at, card FROM seen_updates ORDER BY seen_at DESC, id DESC LIMIT ?").all(limit)
    ) as Row[];
    return rows.map((row) => ({ card: JSON.parse(row.card as string) as Need, rev: row.rev as string, seenAt: row.seen_at as string }));
  }

  /** Keeps a card as you answered it, at `rev`, your answer `replyId`: the newest answer per card stands. Drops those past 30 days. */
  keepAnswered(card: Need, rev: string, replyId: string, answeredAt: string): void {
    this.db
      .prepare(
        `INSERT INTO answered_cards (id, rev, answered_at, reply_id, card) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET rev = excluded.rev, answered_at = excluded.answered_at, reply_id = excluded.reply_id, card = excluded.card
         WHERE excluded.answered_at >= answered_cards.answered_at`,
      )
      .run(card.id, rev, answeredAt, replyId, JSON.stringify(card));
    this.pruneAnswered(new Date(Date.parse(answeredAt) - ANSWERED_KEEP_MS).toISOString());
  }

  /** The kept answered cards answered at or after `since`, the newest answer first, at most `limit`, each with that answer. */
  keptAnswered(since: string, limit: number): { card: Need; rev: string; reply: Reply }[] {
    const rows = this.db
      .prepare(
        `SELECT a.card AS kept_card, a.rev AS kept_rev, r.* FROM answered_cards a JOIN replies r ON r.id = a.reply_id
         WHERE a.answered_at >= ? ORDER BY a.answered_at DESC, a.id DESC LIMIT ?`,
      )
      .all(since, limit) as Row[];
    return rows.map((row) => ({ card: JSON.parse(row.kept_card as string) as Need, rev: row.kept_rev as string, reply: toReply(row) }));
  }

  /** One kept answered card, or null. */
  keptAnsweredCard(id: string): { card: Need; rev: string; replyId: string; answeredAt: string } | null {
    const row = this.db.prepare("SELECT * FROM answered_cards WHERE id = ?").get(id) as Row | undefined;
    return row ? { card: JSON.parse(row.card as string) as Need, rev: row.rev as string, replyId: row.reply_id as string, answeredAt: row.answered_at as string } : null;
  }

  /**
   * Drops the answered cards and Reopens from before `before`. A merged Reopen stays: a later Reopen of the same card
   * carries its `merged` on, so no answer down the line arms the merge that ran again.
   */
  pruneAnswered(before: string): void {
    this.db.prepare("DELETE FROM answered_cards WHERE answered_at < ?").run(before);
    this.db.prepare("DELETE FROM reopens WHERE at < ? AND merged = 0").run(before);
  }

  /** Records a Reopen, its notice not yet delivered. */
  addReopen(reopen: { cardId: string; rev: string; at: string; replyId: string; title: string; chat?: string; repo?: string; merged?: boolean }): Reopen {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO reopens (id, card_id, rev, at, reply_id, title, chat, repo, merged) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, reopen.cardId, reopen.rev, reopen.at, reopen.replyId, reopen.title, reopen.chat ?? null, reopen.repo ?? NO_REPO, reopen.merged ? 1 : 0);
    return this.getReopen(id)!;
  }

  getReopen(id: string): Reopen | null {
    const row = this.db.prepare("SELECT * FROM reopens WHERE id = ?").get(id) as Row | undefined;
    return row ? toReopen(row) : null;
  }

  /** The latest Reopen of each card among `ids`. */
  latestReopens(ids: readonly string[]): Map<string, Reopen> {
    if (!ids.length) return new Map();
    const rows = this.db
      .prepare(
        `SELECT * FROM reopens o WHERE card_id IN (SELECT value FROM json_each(?))
           AND NOT EXISTS (SELECT 1 FROM reopens l WHERE l.card_id = o.card_id AND (l.at > o.at OR (l.at = o.at AND l.rowid > o.rowid)))`,
      )
      .all(JSON.stringify([...new Set(ids)])) as Row[];
    return new Map(rows.map((row) => [row.card_id as string, toReopen(row)]));
  }

  /** The Reopens whose notice the bridge has not delivered, offered (or sent again) since `since`, oldest first. */
  undeliveredReopens(since: string): Reopen[] {
    return (this.db.prepare("SELECT * FROM reopens WHERE delivered_at IS NULL AND COALESCE(sent_at, at) >= ? ORDER BY at, rowid").all(since) as Row[]).map(toReopen);
  }

  /** Offers an undelivered Reopen's notice again from `at` (Send again): null when there is none, or it was delivered. */
  resendReopen(id: string, at: string): Reopen | null {
    const changed = this.db.prepare("UPDATE reopens SET sent_at = ?, error = NULL WHERE id = ? AND delivered_at IS NULL").run(at, id).changes;
    return changed ? this.getReopen(id) : null;
  }

  /** The bridge's ack of a Reopen's notice: the first delivery stands, a confirmed one replacing an unconfirmed one. */
  ackReopen(id: string, ack: { delivered: boolean; confirmed?: boolean; error?: string }, at: string): Reopen | null {
    if (ack.delivered) {
      this.db
        .prepare(
          `UPDATE reopens SET delivered_at = COALESCE(delivered_at, ?), confirmed = MAX(COALESCE(confirmed, 0), ?), error = NULL WHERE id = ?`,
        )
        .run(at, ack.confirmed ? 1 : 0, id);
    } else {
      this.db.prepare("UPDATE reopens SET error = ? WHERE id = ? AND delivered_at IS NULL").run(ack.error ?? "not delivered", id);
    }
    return this.getReopen(id);
  }

  getReplyByClientId(clientId: string): Reply | null {
    const row = this.db.prepare("SELECT * FROM replies WHERE client_id = ?").get(clientId) as Row | undefined;
    return row ? toReply(row) : null;
  }

  addReply(input: NewReply): Reply {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO replies (id, client_id, item_id, item_title, decision, choice, text, rev, at, item, image, files, images)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.clientId,
        input.itemId,
        input.itemTitle,
        input.decision,
        input.choice ?? null,
        input.text ?? null,
        input.rev,
        new Date().toISOString(),
        JSON.stringify(input.item),
        input.image ?? null,
        input.files ? JSON.stringify(input.files) : null,
        input.images ? JSON.stringify(input.images) : null,
      );
    const reply = this.getReply(id)!;
    for (const listener of this.replyListeners) listener(reply);
    return reply;
  }

  /** A file of any type is in the media store (CommandStore's table, in this same database file). */
  hasMedia(sha: string): boolean {
    return this.db.prepare("SELECT 1 FROM media WHERE sha = ?").get(sha) !== undefined;
  }

  /** An image you can attach is in the media store. That table is CommandStore's, in this same database file. */
  hasImage(sha: string): boolean {
    const row = this.db.prepare("SELECT type FROM media WHERE sha = ?").get(sha) as Row | undefined;
    return row !== undefined && (IMAGE_TYPES as readonly string[]).includes(row.type as string);
  }

  /** A document you can attach is in the media store: its type, one of FILE_TYPES, or null. */
  /** The stored size of these images together; one no longer stored counts as nothing. */
  imageBytes(shas: readonly string[]): number {
    const size = this.db.prepare("SELECT size FROM media WHERE sha = ?");
    return shas.reduce((total, sha) => total + (((size.get(sha) as Row | undefined)?.size as number | undefined) ?? 0), 0);
  }

  fileType(sha: string): FileType | null {
    const row = this.db.prepare("SELECT type FROM media WHERE sha = ?").get(sha) as Row | undefined;
    return row !== undefined && (FILE_TYPES as readonly string[]).includes(row.type as string) ? (row.type as FileType) : null;
  }

  /**
   * Your answers on cards for any of `prs` (a card names no repo for NO_REPO), newest first: a thread's "Your
   * OK" however long ago it was given, and however many answers other repos' PRs of the same number have.
   */
  repliesForPrs(prs: readonly { repo: string; number: number }[], limit: number): Reply[] {
    if (!prs.length) return [];
    return (
      this.db.prepare(`SELECT * FROM replies WHERE ${FOR_PRS} ORDER BY at DESC, rowid DESC LIMIT ?`).all(prsParam(prs), NO_REPO, limit) as Row[]
    ).map(toReply);
  }

  /** Your answers on cards a thread links: by card id, or for one of its PRs or chats (no repo is NO_REPO), newest first. */
  repliesLinked(
    links: { ids: readonly string[]; prs: readonly { repo: string; number: number }[]; chats: readonly { repo: string; chat: string }[] },
    limit: number,
  ): Reply[] {
    if (!links.ids.length && !links.prs.length && !links.chats.length) return [];
    const ids = [...new Set(links.ids)];
    const chats = [...new Map(links.chats.map((chat) => [`${chat.repo.toLowerCase()}#${chat.chat.toLowerCase()}`, { repo: chat.repo.toLowerCase(), chat: chat.chat.toLowerCase() }])).values()];
    return (
      this.db
        .prepare(
          `SELECT * FROM replies WHERE item_id IN (SELECT value FROM json_each(?)) OR ${FOR_PRS}
           OR EXISTS (SELECT 1 FROM json_each(?) AS link WHERE LOWER(json_extract(item, '$.chat')) = json_extract(link.value, '$.chat') AND ${LINK_REPO})
           ORDER BY at DESC, rowid DESC LIMIT ?`,
        )
        .all(JSON.stringify(ids), prsParam(links.prs), NO_REPO, JSON.stringify(chats), NO_REPO, limit) as Row[]
    ).map(toReply);
  }

  /** The cards among `ids` you have answered, each as `<id>\n<rev>`: a card asked again has a new rev. */
  answeredCards(ids: readonly string[]): Set<string> {
    if (!ids.length) return new Set();
    const rows = this.db.prepare(`SELECT DISTINCT item_id, rev FROM replies WHERE item_id IN (${ids.map(() => "?").join(", ")})`).all(...ids) as Row[];
    return new Set(rows.map((row) => `${row.item_id as string}\n${row.rev as string}`));
  }

  /**
   * Minimises `key` at `rev`, or opens it again with `rev` null; past MAX_MINIMISED the oldest go. `at` is stored 1 ms
   * past the newest stored one when it is not later, so two minimised in the same millisecond keep the order they came
   * in, for the listing and the trim alike.
   */
  setMinimised(key: string, rev: string | null, at: string): void {
    if (rev === null) {
      this.db.prepare("DELETE FROM minimised WHERE key = ?").run(key);
      return;
    }
    const newest = (this.db.prepare("SELECT MAX(at) AS at FROM minimised").get() as Row | undefined)?.at as string | null | undefined;
    const after = newest ? Date.parse(newest) : NaN;
    if (Number.isFinite(after) && !(Date.parse(at) > after)) at = new Date(after + 1).toISOString();
    this.db.prepare("INSERT INTO minimised (key, rev, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET rev = excluded.rev, at = excluded.at").run(key, rev, at);
    this.db.prepare("DELETE FROM minimised WHERE key NOT IN (SELECT key FROM minimised ORDER BY at DESC, key DESC LIMIT ?)").run(MAX_MINIMISED);
  }

  /** What you minimised, as [key, rev], oldest first. */
  minimised(): [string, string][] {
    const rows = this.db.prepare("SELECT key, rev FROM minimised ORDER BY at, key").all() as Row[];
    return rows.map((row) => [row.key as string, row.rev as string]);
  }

  /**
   * Each wait whose latest answer across all its cards is Yes, by asks/waits.ts yesKey (its id's stem, repo and PR)
   * → that answer's time, so a wait you said yes to is known after its card has left the board, and a later answer
   * on any of its cards (Answer again, a reopened copy) is the one that counts. A later answer other than Yes on a
   * PR's Your OK ends every earlier Yes for that PR.
   */
  waitYeses(): Map<string, string> {
    const rows = this.db
      .prepare(
        `SELECT item_id, choice, json_extract(item, '$.repo') AS repo, json_extract(item, '$.pr') AS pr, MAX(at) AS at
         FROM replies WHERE item_id LIKE 'wait-%' GROUP BY item_id, repo, pr`,
      )
      .all() as Row[];
    const latest = new Map<string, { at: string; yes: boolean; pr?: string }>();
    // Each card's latest answer, whichever of a wait's cards it is: a no on one of them ends an earlier yes on another.
    const lastNo = new Map<string, number>();
    for (const row of rows) {
      const stem = stemOf(row.item_id as string);
      const repo = typeof row.repo === "string" ? row.repo : undefined;
      const pr = typeof row.pr === "number" ? row.pr : undefined;
      const key = yesKey(stem, repo, pr);
      const at = row.at as string;
      const yes = row.choice === "Yes";
      const asksOk = pr !== undefined && stem.startsWith(`${WAIT_PREFIX}ok-`);
      const prKey = asksOk ? `${repo ?? NO_REPO}#${pr}` : undefined;
      if (!yes && prKey) lastNo.set(prKey, Math.max(lastNo.get(prKey) ?? -Infinity, Date.parse(at)));
      if (!(Date.parse(latest.get(key)?.at ?? "") >= Date.parse(at))) latest.set(key, { at, yes, ...(prKey ? { pr: prKey } : {}) });
    }
    return new Map([...latest].flatMap(([key, one]) => (one.yes && !(one.pr && Date.parse(one.at) < (lastNo.get(one.pr) ?? -Infinity)) ? [[key, one.at] as const] : [])));
  }

  /** The cards among `ids` you have answered, `<id>\n<rev>` → your last answer to that revision. */
  answerTimes(ids: readonly string[]): Map<string, string> {
    if (!ids.length) return new Map();
    const rows = this.db.prepare(`SELECT item_id, rev, MAX(at) AS at FROM replies WHERE item_id IN (${ids.map(() => "?").join(", ")}) GROUP BY item_id, rev`).all(...ids) as Row[];
    return new Map(rows.map((row) => [`${row.item_id as string}\n${row.rev as string}`, row.at as string]));
  }

  /** The cards among `ids` whose answer was handled (delivered to its chat, or marked Handled) at or before `before`, each as `<id>\n<rev>`. */
  handledCards(ids: readonly string[], before: string): Set<string> {
    if (!ids.length) return new Set();
    const rows = this.db
      .prepare(`SELECT DISTINCT item_id, rev FROM replies WHERE handled = 1 AND handled_at IS NOT NULL AND handled_at <= ? AND item_id IN (${ids.map(() => "?").join(", ")})`)
      .all(before, ...ids) as Row[];
    return new Set(rows.map((row) => `${row.item_id as string}\n${row.rev as string}`));
  }

  /** How many answers the `acted: false` list holds, however few of them it returns. */
  countUnactedReplies(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM replies WHERE (delivered_at IS NOT NULL OR handled = 1) AND acted_at IS NULL").get() as { n: number };
    return row.n;
  }

  listReplies(options: { handled?: boolean; acted?: false; limit: number; items?: readonly string[] }): Reply[] {
    if (options.acted === false) {
      // Answers that reached Rivet or a chat and nobody has acted on yet: a work queue, oldest first. A cap drops the
      // oldest, never the newest: the list once hid every new answer behind 100 old ones.
      return (
        this.db
          .prepare("SELECT * FROM replies WHERE (delivered_at IS NOT NULL OR handled = 1) AND acted_at IS NULL ORDER BY at DESC, rowid DESC LIMIT ?")
          .all(options.limit) as Row[]
      )
        .reverse()
        .map(toReply);
    }
    if (options.items) {
      const handled = options.handled === undefined ? "" : `AND handled = ${options.handled ? 1 : 0}`;
      return (
        this.db
          .prepare(`SELECT * FROM replies WHERE item_id IN (SELECT value FROM json_each(?)) ${handled} ORDER BY at DESC, rowid DESC LIMIT ?`)
          .all(JSON.stringify([...new Set(options.items)]), options.limit) as Row[]
      ).map(toReply);
    }
    if (options.handled === undefined) {
      return (this.db.prepare("SELECT * FROM replies ORDER BY at DESC, rowid DESC LIMIT ?").all(options.limit) as Row[]).map(toReply);
    }
    // Unhandled replies are a work queue, so they come oldest first.
    const order = options.handled ? "DESC" : "ASC";
    return (
      this.db
        .prepare(`SELECT * FROM replies WHERE handled = ? ORDER BY at ${order}, rowid ${order} LIMIT ?`)
        .all(options.handled ? 1 : 0, options.limit) as Row[]
    ).map(toReply);
  }

  /** Replies the bridge still has to carry, oldest first. */
  undeliveredReplies(): Reply[] {
    return (
      this.db
        .prepare("SELECT * FROM replies WHERE delivered_at IS NULL AND handled = 0 ORDER BY at ASC, rowid ASC")
        .all() as Row[]
    ).map(toReply);
  }

  markHandled(id: string): Reply | null {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE replies SET handled = 1, handled_at = COALESCE(handled_at, ?), acted_at = COALESCE(acted_at, ?) WHERE id = ?").run(now, now, id);
    return this.getReply(id);
  }

  applyAck(ack: BridgeAck): Reply | null {
    const existing = this.getReply(ack.id);
    if (!existing) return null;
    const now = new Date().toISOString();
    if (ack.delivery) {
      // The first delivery stands, except that a confirmed one replaces an unconfirmed one. `handled` says the answer
      // reached the session, so a line reported lost or unproved leaves it unhandled, until a later proof clears it.
      const delivery =
        !existing.delivery || (existing.delivery.confirmed !== true && ack.delivery.confirmed === true)
          ? ack.delivery
          : existing.delivery;
      const reached = delivery.lost || delivery.unproved ? 0 : 1;
      this.db
        .prepare(
          `UPDATE replies SET
             delivered_at = COALESCE(delivered_at, ?),
             delivery = ?,
             handled = MAX(handled, ?),
             handled_at = CASE WHEN ? = 1 THEN COALESCE(handled_at, ?) ELSE handled_at END
           WHERE id = ?`,
        )
        .run(now, JSON.stringify(delivery), reached, reached, now, ack.id);
    }
    if (ack.github) {
      const merged = { ...existing.github, ...ack.github };
      if (ack.github.url) delete merged.error;
      this.db.prepare("UPDATE replies SET github = ? WHERE id = ?").run(JSON.stringify(merged), ack.id);
    }
    if (ack.error !== undefined || ack.delivery) {
      this.db.prepare("UPDATE replies SET error = ? WHERE id = ?").run(ack.delivery ? null : (ack.error ?? null), ack.id);
    }
    const reply = this.getReply(ack.id)!;
    if (ack.delivery) for (const listener of this.replyAckedListeners) listener(reply);
    return reply;
  }

  // Workers

  /** Stores the bridge's latest snapshot. */
  putWorkers(snapshot: WorkerSnapshot, now = Date.now()): string {
    const at = new Date(now).toISOString();
    this.db
      .prepare(
        `INSERT INTO workers (id, json, at) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET json = excluded.json, at = excluded.at`,
      )
      .run(JSON.stringify(snapshot), at);
    return at;
  }

  // Ops statuses

  /** Newest change first. */
  listOpsStatuses(): OpsStatus[] {
    const rows = this.db.prepare("SELECT json FROM ops_status ORDER BY updated_at DESC, kind, key").all() as Row[];
    return rows.map((row) => upgradeOpsStatus(JSON.parse(row.json as string) as Record<string, unknown>));
  }

  countOpsStatuses(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM ops_status").get() as Row).n);
  }

  getOpsStatus(kind: string, key: string): OpsStatus | null {
    const row = this.db.prepare("SELECT json FROM ops_status WHERE kind = ? AND key = ?").get(kind, key) as Row | undefined;
    return row ? upgradeOpsStatus(JSON.parse(row.json as string) as Record<string, unknown>) : null;
  }

  /**
   * The next status version, counted across every record and never handed out twice, so a version read before a clear
   * or a prune cannot match the record made after it. It also passes every stored version.
   */
  nextOpsStatusVersion(): number {
    const row = this.db
      .prepare(
        `INSERT INTO meta (key, value) SELECT 'ops_status_version', CAST(COALESCE(MAX(version), 0) + 1 AS TEXT) FROM ops_status WHERE true
         ON CONFLICT (key) DO UPDATE SET value = CAST(MAX(CAST(meta.value AS INTEGER), CAST(excluded.value AS INTEGER) - 1) + 1 AS TEXT)
         RETURNING value`,
      )
      .get() as Row;
    return Number(row.value);
  }

  /** False when the item already has a record. */
  addOpsStatus(status: OpsStatus): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO ops_status (kind, key, json, state, updated_at, version) VALUES (?, ?, ?, ?, ?, ?)")
      .run(status.kind, status.key, JSON.stringify(status), status.state, status.updatedAt, status.version);
    return Number(result.changes) === 1;
  }

  /** Writes `status` over the stored one only while that is still at `fromVersion`; false when it moved on. */
  replaceOpsStatus(status: OpsStatus, fromVersion: number): boolean {
    const result = this.db
      .prepare("UPDATE ops_status SET json = ?, state = ?, updated_at = ?, version = ? WHERE kind = ? AND key = ? AND version = ?")
      .run(JSON.stringify(status), status.state, status.updatedAt, status.version, status.kind, status.key, fromVersion);
    return Number(result.changes) === 1;
  }

  /** Deletes the record, and with `fromVersion` only while it is still at that version. */
  deleteOpsStatus(kind: string, key: string, fromVersion?: number): boolean {
    const result =
      fromVersion === undefined
        ? this.db.prepare("DELETE FROM ops_status WHERE kind = ? AND key = ?").run(kind, key)
        : this.db.prepare("DELETE FROM ops_status WHERE kind = ? AND key = ? AND version = ?").run(kind, key, fromVersion);
    return Number(result.changes) === 1;
  }

  /** Deletes fixed records last changed before `before`; the count deleted. */
  pruneFixedOpsStatuses(before: string): number {
    return Number(this.db.prepare("DELETE FROM ops_status WHERE state = 'fixed' AND updated_at < ?").run(before).changes);
  }

  // Ops dismissals

  /** Newest first. */
  listOpsDismissals(): OpsDismissal[] {
    const rows = this.db.prepare("SELECT kind, key, mark, at FROM ops_dismissals ORDER BY at DESC, kind, key").all() as Row[];
    return rows.map((row) => ({ kind: row.kind, key: row.key, mark: row.mark, at: row.at }) as OpsDismissal);
  }

  countOpsDismissals(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM ops_dismissals").get() as Row).n);
  }

  /** Creates the item's dismissal or replaces it with this mark. */
  putOpsDismissal(dismissal: OpsDismissal): void {
    this.db
      .prepare("INSERT INTO ops_dismissals (kind, key, mark, at) VALUES (?, ?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET mark = excluded.mark, at = excluded.at")
      .run(dismissal.kind, dismissal.key, dismissal.mark, dismissal.at);
  }

  /** False when the item had none. */
  deleteOpsDismissal(kind: string, key: string): boolean {
    return Number(this.db.prepare("DELETE FROM ops_dismissals WHERE kind = ? AND key = ?").run(kind, key).changes) === 1;
  }

  /** Deletes dismissals made before `before`; the count deleted. */
  pruneOpsDismissals(before: string): number {
    return Number(this.db.prepare("DELETE FROM ops_dismissals WHERE at < ?").run(before).changes);
  }


  // What you used

  /**
   * Stores one batch, each event stamped at `sentAt` less its `t`, and drops events past the keep window. The batch was
   * checked against the registry (usageBatchSchema), so every id is a fixed registry string. False, storing nothing,
   * when the device's events taken in the last day would pass MAX_USAGE_EVENTS_PER_DAY.
   */
  addUsage(batch: UsageBatch, sentAt: Date): boolean {
    const sent = sentAt.getTime();
    const got = sentAt.toISOString();
    const write = this.db.prepare("INSERT OR IGNORE INTO usage_events (at, got, device, kind, ctl, screen, value, app_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const today = this.db
        .prepare("SELECT COUNT(*) AS n FROM usage_events WHERE device = ? AND got > ?")
        .get(batch.device, new Date(sent - DAY_MS).toISOString()) as Row;
      if (Number(today.n) + batch.events.length > MAX_USAGE_EVENTS_PER_DAY) {
        this.db.exec("ROLLBACK");
        return false;
      }
      for (const [t, kind, id, screen, value] of batch.events) {
        write.run(new Date(sent - t).toISOString(), got, batch.device, kind, id, screen, value, batch.sentAt === undefined ? null : batch.sentAt - t);
      }
      this.db.prepare("DELETE FROM usage_events WHERE at < ?").run(new Date(sent - USAGE_KEEP_MS).toISOString());
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Each id's use by `device` since `since`: count and last use, and the median value of its screens, cards and scrolls. */
  usageSummary(since: string, device: UsageDevice): { since: string | null; counts: UsageCount[] } {
    const rows = this.db
      .prepare("SELECT kind, ctl, at, value FROM usage_events WHERE at >= ? AND device = ? ORDER BY kind, ctl, value")
      .all(since, device) as Row[];
    const first = this.db.prepare("SELECT MIN(at) AS at FROM usage_events WHERE device = ?").get(device) as Row;
    const groups = new Map<string, { kind: UsageEventKind; id: string; last: string; values: number[] }>();
    for (const row of rows) {
      const key = `${row.kind as string} ${row.ctl as string}`;
      let entry = groups.get(key);
      if (!entry) groups.set(key, (entry = { kind: row.kind as UsageEventKind, id: row.ctl as string, last: row.at as string, values: [] }));
      if ((row.at as string) > entry.last) entry.last = row.at as string;
      entry.values.push(Number(row.value));
    }
    const counts = [...groups.values()].map(({ kind, id, last, values }): UsageCount => {
      const count = { kind, id, count: values.length, last };
      // A tap's value is a position, not an amount: no median.
      const mid = values.length >> 1;
      const median = values.length % 2 ? values[mid]! : Math.round((values[mid - 1]! + values[mid]!) / 2);
      return kind === "tap" ? count : { ...count, median };
    });
    return { since: (first.at as string | null) ?? null, counts };
  }

  /** What you used's one read: every device's events since `since`, oldest first, on the `at` index. */
  usageEvents(since: string): UsageEventRow[] {
    return this.db.prepare("SELECT at, device, kind, ctl, screen, value FROM usage_events WHERE at >= ? ORDER BY at, id").all(since) as unknown as UsageEventRow[];
  }

  /** The first event kept on any device, or null. */
  usageFirstAt(): string | null {
    return ((this.db.prepare("SELECT MIN(at) AS at FROM usage_events").get() as Row).at as string | null) ?? null;
  }

  addUsageAsk(ask: Omit<UsageAskRow, "answer" | "answeredAt">): void {
    this.db.prepare("INSERT INTO usage_asks (card, ctl, ask, weekly, at) VALUES (?, ?, ?, ?, ?)").run(ask.card, ask.ctl, ask.ask, ask.weekly ? 1 : 0, ask.at);
  }

  /** The asks made, or answered, since `since`. */
  usageAsks(since: string): UsageAskRow[] {
    const rows = this.db.prepare("SELECT * FROM usage_asks WHERE at >= ? OR answered_at >= ? ORDER BY at").all(since, since) as Row[];
    return rows.map((row) => ({
      card: row.card as string,
      ctl: row.ctl as string,
      ask: row.ask as UsageAsk,
      weekly: row.weekly === 1,
      at: row.at as string,
      answer: (row.answer as string | null) ?? null,
      answeredAt: (row.answered_at as string | null) ?? null,
    }));
  }

  /** Your answer on an ask's card; false when the card is no ask's or holds a later answer (a replayed older reply). */
  answerUsageAsk(card: string, answer: string, at: string): boolean {
    return Number(this.db.prepare("UPDATE usage_asks SET answer = ?, answered_at = ? WHERE card = ? AND (answered_at IS NULL OR answered_at <= ?)").run(answer, at, card, at).changes) > 0;
  }

  getWorkers(): StoredWorkers | null {
    const row = this.db.prepare("SELECT json, at FROM workers WHERE id = 1").get() as Row | undefined;
    if (!row) return null;
    const snapshot = JSON.parse(row.json as string) as WorkerSnapshot;
    return { snapshot, at: row.at as string };
  }
}
