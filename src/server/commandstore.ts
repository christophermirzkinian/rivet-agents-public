import type { JobAction } from "../shared/jobs.js";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { AskCreate } from "../shared/asks.js";
import { MAX_CHAT_FILES, type FileRef, type FileType, type Need } from "../shared/board.js";
import {
  chatImages,
  chatWindowText,
  FINAL_STATUSES,
  imageFields,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGES,
  quoteText,
  type ActionDetail,
  type ActionKind,
  type ActionStatus,
  type AuditEntry,
  type ChatFile,
  type ChatMessage,
  type ChatQuote,
  type PostedCard,
  type ChatPage,
  type MediaType,
} from "../shared/command.js";
import type { ModelPicks } from "../shared/models.js";
import {
  CUTOVER_KEY,
  SEED_IDS,
  TEAM_ROOM_ID,
  TEAM_ROOM_ROOT_TEXT,
  TEAM_ROOM_TITLE,
  UPDATES_ID,
  UPDATES_ROOT_TEXT,
  UPDATES_TITLE,
} from "../shared/conversations.js";
import type { MediaItemType, MediaSource } from "../shared/media.js";
import { searchNeedles } from "../shared/names.js";
import { NO_REPO } from "../shared/board.js";
import { APP_ONLY_PROJECTS, MAX_THREAD_STEPS, MAX_THREAD_TITLE, textMentions, threadTitle, type Mentions, type PrRef, type StepKind, type ThreadPatch, type ThreadProject, type ThreadStatus } from "../shared/threads.js";

// See store.ts: node:sqlite goes through createRequire under vitest.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

type DatabaseSync = InstanceType<typeof DatabaseSync>;

// Its own connection to the same database file as Store, like FactoryStore.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit (
  id         TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL,
  at         TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status     TEXT NOT NULL,
  request    TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit (at);
-- Alerts from other services (POST /api/alerts/*), kept only as long as their hourly limit needs them.
CREATE TABLE IF NOT EXISTS alerts (
  kind TEXT NOT NULL,
  at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_kind_at ON alerts (kind, at);
CREATE TABLE IF NOT EXISTS chat_messages (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  id       TEXT NOT NULL UNIQUE,
  sender   TEXT NOT NULL,
  text     TEXT NOT NULL,
  at       TEXT NOT NULL,
  reply_to TEXT
);
-- A chat thread's settings, keyed by its first message; a thread nobody set anything on has no row.
CREATE TABLE IF NOT EXISTS chat_threads (
  root_id    TEXT PRIMARY KEY,
  title      TEXT,
  status     TEXT,
  status_at  TEXT,
  project    TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_thread_steps (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id TEXT NOT NULL,
  kind    TEXT NOT NULL,
  label   TEXT NOT NULL,
  url     TEXT,
  at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_thread_steps_root ON chat_thread_steps (root_id, seq);
CREATE TABLE IF NOT EXISTS media (
  sha        TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_used  INTEGER NOT NULL
);
`;

// The Media tab's record: each photo and video Rivet sent you, by card (ref: card id) or chat message (ref: its
// id). A video keeps its card's poster. Rows stay when their file is evicted; the list shows only stored files.
const MEDIA_SEEN = `
CREATE TABLE IF NOT EXISTS media_seen (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  sha          TEXT NOT NULL,
  kind         TEXT NOT NULL,
  poster       TEXT,
  source       TEXT NOT NULL,
  ref          TEXT NOT NULL,
  title        TEXT,
  conversation TEXT,
  at           TEXT NOT NULL,
  UNIQUE (source, ref, sha)
);
CREATE INDEX IF NOT EXISTS media_seen_at ON media_seen (at, seq);
CREATE INDEX IF NOT EXISTS media_seen_sha ON media_seen (sha);
CREATE INDEX IF NOT EXISTS media_seen_poster ON media_seen (poster);
`;
/**
 * At most this many records per file, the newest kept: card ids are the board token's to pick, so one file could
 * otherwise gather rows without end.
 */
export const MEDIA_SEEN_PER_SHA = 20;
const TRIM_SEEN = `DELETE FROM media_seen WHERE seq IN (
  SELECT seq FROM (SELECT seq, ROW_NUMBER() OVER (PARTITION BY sha ORDER BY at DESC, seq DESC) AS n FROM media_seen) WHERE n > ${MEDIA_SEEN_PER_SHA})`;
/** The ref of a file from a card shown before the record: a card id cannot hold ":" (ID_PATTERN), so none can match. */
export const EARLIER_REF = "earlier:";
export const EARLIER_TITLE = "Earlier card";
/** The `meta` key set once the files from before the record are recorded. */
const EARLIER_KEY = "media_seen.earlier";
const STORED = "EXISTS (SELECT 1 FROM media WHERE media.sha = ?)";

/**
 * A count every write to what threadRows reads moves, whichever connection or statement makes it, so a thread list
 * read while it holds is still current (2026-10-05: re-reading every thread on each poll ran the machine out of CPU).
 */
const CHAT_VERSION = `
CREATE TABLE IF NOT EXISTS chat_version (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL);
INSERT OR IGNORE INTO chat_version (id, n) VALUES (1, 0);
${["chat_messages", "chat_threads", "audit"]
  .flatMap((table) =>
    ["INSERT", "UPDATE", "DELETE"].map(
      (event) => `CREATE TRIGGER IF NOT EXISTS ${table}_${event.toLowerCase()}_version AFTER ${event} ON ${table} BEGIN UPDATE chat_version SET n = n + 1; END;`,
    ),
  )
  .join("\n")}
`;

/** A chat window flushes 10 s after its last message, and never later than 30 s after its first. */
export const BATCH_QUIET_MS = 10_000;
export const BATCH_CAP_MS = 30_000;
/** How much of a thread's first and last message the thread list reads: its title and one-line preview need far less. */
const THREAD_TEXT_READ = 1000;
/**
 * A window holds this much text, joined, up to MAX_CHAT_IMAGES photos of MAX_CHAT_IMAGE_BYTES together (one photo
 * for a bridge from before several photos) and up to MAX_CHAT_FILES documents; a message past any of them opens the
 * next window.
 */
export const BATCH_MAX_TEXT = 20_000;
/** A bridge from before long chat gathers a window of at most this many characters, and takes text up to the next. */
export const SHORT_CHAT_WINDOW_TEXT = 3800;
export const SHORT_CHAT_BRIDGE_TEXT = 4000;
/** A bridge from before chat windows cuts the typed text at this many characters. */
export const OLD_BRIDGE_CHAT_TEXT = 2000;

// A chat window's lead and members carry the lead's id in batch_id; only the
// lead has the timing, and only the lead goes to the bridge, with every
// member's text. Members' statuses are written with the lead's.
function migrate(db: DatabaseSync): void {
  const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name));
  const audit = columns("audit");
  if (!audit.has("batch_id")) db.exec("ALTER TABLE audit ADD COLUMN batch_id TEXT");
  if (!audit.has("batch_first_at")) db.exec("ALTER TABLE audit ADD COLUMN batch_first_at INTEGER");
  if (!audit.has("batch_last_at")) db.exec("ALTER TABLE audit ADD COLUMN batch_last_at INTEGER");
  db.exec("CREATE INDEX IF NOT EXISTS audit_batch ON audit (batch_id)");
  const chat = columns("chat_messages");
  if (!chat.has("quote_from")) db.exec("ALTER TABLE chat_messages ADD COLUMN quote_from TEXT");
  if (!chat.has("quote_text")) db.exec("ALTER TABLE chat_messages ADD COLUMN quote_text TEXT");
  if (!chat.has("thread_id")) db.exec("ALTER TABLE chat_messages ADD COLUMN thread_id TEXT");
  // Rivet's own photos and video, as JSON { images?, video? }; your live on your chat action's request.
  if (!chat.has("media")) db.exec("ALTER TABLE chat_messages ADD COLUMN media TEXT");
  // Rivet's ack on your message, { text, at } (say.mjs --ack, 2026-10-06).
  if (!chat.has("ack")) db.exec("ALTER TABLE chat_messages ADD COLUMN ack TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS chat_messages_thread ON chat_messages (thread_id, seq)");
  const threads = columns("chat_threads");
  if (!threads.has("tag")) db.exec("ALTER TABLE chat_threads ADD COLUMN tag TEXT");
  if (!threads.has("ai_title")) db.exec("ALTER TABLE chat_threads ADD COLUMN ai_title TEXT");
  if (!threads.has("ai_titled_at")) db.exec("ALTER TABLE chat_threads ADD COLUMN ai_titled_at TEXT");
  if (!threads.has("ai_project")) db.exec("ALTER TABLE chat_threads ADD COLUMN ai_project TEXT");
  if (!threads.has("moved_at")) db.exec("ALTER TABLE chat_threads ADD COLUMN moved_at TEXT");
  if (!threads.has("rivet_project")) {
    db.exec("ALTER TABLE chat_threads ADD COLUMN rivet_project TEXT");
    db.exec("UPDATE chat_threads SET rivet_project = project WHERE moved_at IS NULL");
  }
  // Conversations: your read marker, Close and rename; `meta` (Store's too) keeps when the list started.
  if (!threads.has("read_at")) db.exec("ALTER TABLE chat_threads ADD COLUMN read_at TEXT");
  if (!threads.has("closed_at")) db.exec("ALTER TABLE chat_threads ADD COLUMN closed_at TEXT");
  if (!threads.has("owner_title")) db.exec("ALTER TABLE chat_threads ADD COLUMN owner_title TEXT");
  // Your marked unread and pin, and Rivet's done (2026-10-05).
  if (!threads.has("unread_at")) db.exec("ALTER TABLE chat_threads ADD COLUMN unread_at TEXT");
  if (!threads.has("pinned_at")) db.exec("ALTER TABLE chat_threads ADD COLUMN pinned_at TEXT");
  if (!threads.has("done_at")) db.exec("ALTER TABLE chat_threads ADD COLUMN done_at TEXT");
  // When the merged-and-quiet sweep closed it, or you reopened it (2026-10-05).
  if (!threads.has("swept_at")) db.exec("ALTER TABLE chat_threads ADD COLUMN swept_at TEXT");
  // The last stage GitHub showed each PR a conversation links, so one past the bridge's 14 days keeps its colour.
  db.exec("CREATE TABLE IF NOT EXISTS pr_stages (pr TEXT PRIMARY KEY, stage TEXT NOT NULL, at TEXT NOT NULL)");
  // Every PR a conversation has linked, kept: a link read from its messages lapses after a quiet week or once the PR
  // closes, and its stage icon should not.
  // A PR is one link whatever its case (GitHub's repo names are case-insensitive).
  db.exec("CREATE TABLE IF NOT EXISTS conversation_prs (thread TEXT NOT NULL, pr TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY (thread, pr))");
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  // The conversation each card was filed in (2026-10-09, one conversation per thing): `thread` is a message of it, so a
  // merge needs no rewrite here; `posted` is Rivet's message that shows the card in it. The rest is what a later card
  // is matched on when its writer names no conversation.
  db.exec(`CREATE TABLE IF NOT EXISTS card_conversations (
    card TEXT PRIMARY KEY, thread TEXT NOT NULL, via TEXT NOT NULL, posted TEXT,
    stem TEXT, repo TEXT, pr INTEGER, chat TEXT, at TEXT NOT NULL)`);
  // An older page's conversation for each issue (the page is gone and nothing adds to it): `root`
  // is a message of it, so a merge needs no rewrite. Kept: such a thread stays whole, out of splitPlan, until retention.
  db.exec("CREATE TABLE IF NOT EXISTS find_work_conversations (repo TEXT NOT NULL, issue INTEGER NOT NULL, root TEXT NOT NULL, PRIMARY KEY (repo, issue))");
  fillThreads(db);
  const fresh = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_seen'").get() === undefined;
  db.exec(MEDIA_SEEN);
  // Rivet's chat photos and video from before the record, once; the board's cards are recorded as the app starts.
  if (fresh) {
    const record = "INSERT OR IGNORE INTO media_seen (sha, kind, source, ref, conversation, at)";
    const from = "c.id, COALESCE(c.thread_id, c.id), c.at FROM chat_messages c";
    const stored = (sha: string) => `EXISTS (SELECT 1 FROM media WHERE media.sha = ${sha})`;
    db.exec(`${record} SELECT image.value, 'image', 'chat', ${from}, json_each(c.media, '$.images') AS image
      WHERE c.sender = 'rivet' AND ${stored("image.value")} ORDER BY c.seq`);
    db.exec(`${record} SELECT json_extract(c.media, '$.video'), 'video', 'chat', ${from}
      WHERE c.sender = 'rivet' AND ${stored("json_extract(c.media, '$.video')")} ORDER BY c.seq`);
    db.exec(TRIM_SEEN);
  }
}

/**
 * Gives every message from before threads its thread, oldest first: what it answers when that is a known message, its
 * chat window's lead for a later member, else itself. Only adds the column's value; nothing else is touched.
 */
function fillThreads(db: DatabaseSync): void {
  if (Number((db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id IS NULL").get() as Row).n) === 0) return;
  const rows = db
    .prepare("SELECT m.id, m.reply_to, m.thread_id, a.batch_id FROM chat_messages m LEFT JOIN audit a ON a.id = m.id ORDER BY m.seq")
    .all() as Row[];
  const threads = new Map<string, string>();
  const update = db.prepare("UPDATE chat_messages SET thread_id = ? WHERE id = ?");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const id = row.id as string;
      const replyTo = row.reply_to as string | null;
      const batch = row.batch_id as string | null;
      let thread = row.thread_id as string | null;
      if (thread === null) {
        thread = (replyTo !== null ? threads.get(replyTo) : undefined) ?? (batch !== null && batch !== id ? threads.get(batch) : undefined) ?? id;
        update.run(thread, id);
      }
      threads.set(id, thread);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** What the owner asked for, as stored with the audit row. */
export interface ActionRequest {
  repo?: string;
  chat?: string;
  pr?: number;
  headSha?: string;
  target?: string;
  schedule?: string;
  on?: boolean;
  text?: string;
  image?: string;
  images?: string[];
  files?: FileRef[];
  replyTo?: string;
  quote?: ChatQuote;
  /** The conversation you typed it in (null: you started a new one); its thread, once stored. */
  conversation?: string | null;
  /** The ask this line names, made after it by its id: a retry or a bridge attach makes it when it is missing. */
  ask?: AskCreate;
  /** A GitHub write on an issue (kind "issue"): a backlog issue's Start work label or Close. */
  issue?: number;
  op?: "comment" | "close" | "label";
  /** A scheduled job's change on the Mac (routes/jobs.ts). */
  job?: JobAction;
  /** Settings › Who does what: every job's model and effort (kind "models"), and the save the screen picked them over. */
  models?: ModelPicks;
  base?: string | null;
}

type Row = Record<string, unknown>;

/** What one retention sweep deleted, or with `apply` false all it would. */
export interface RetentionCounts {
  conversations: number;
  messages: number;
  audit: number;
  prStages: number;
}

/** Documents in order, each once: a file sent twice in one window is named once. */
function uniqueFiles(files: readonly FileRef[]): FileRef[] {
  const seen = new Set<string>();
  return files.filter((file) => !seen.has(file.sha256) && seen.add(file.sha256));
}

function deadline(lead: Row): number {
  return Math.min((lead.batch_last_at as number) + BATCH_QUIET_MS, (lead.batch_first_at as number) + BATCH_CAP_MS);
}

function toEntry(row: Row): AuditEntry {
  const request = JSON.parse(row.request as string) as ActionRequest;
  const entry: AuditEntry = {
    id: row.id as string,
    clientId: row.client_id as string,
    kind: row.kind as ActionKind,
    at: row.at as string,
    updatedAt: row.updated_at as string,
    status: row.status as ActionStatus,
    ...request,
  };
  if (row.detail !== null) entry.detail = JSON.parse(row.detail as string) as ActionDetail;
  return entry;
}

const CHAT_STATUS: Partial<Record<ActionStatus, ChatMessage["status"]>> = {
  collecting: "collecting",
  queued: "sent",
  typed: "typed",
  unconfirmed: "unconfirmed",
  failed: "failed",
  replied: "replied",
};

function toMessage(row: Row): ChatMessage {
  const message: ChatMessage = {
    id: row.id as string,
    from: row.sender as ChatMessage["from"],
    text: row.text as string,
    at: row.at as string,
  };
  if (typeof row.seq === "number") message.seq = row.seq;
  if (row.reply_to !== null) message.replyTo = row.reply_to as string;
  message.threadId = (row.thread_id as string | null) ?? message.id;
  // An app-only project Rivet filed it in outlasts your Move.
  const project = typeof row.thread_rivet_project === "string" && APP_ONLY_PROJECTS.has(row.thread_rivet_project as ThreadProject) ? row.thread_rivet_project : row.thread_project;
  if (typeof project === "string") message.project = project;
  if (typeof row.quote_text === "string") message.quote = { from: row.quote_from as ChatQuote["from"], text: row.quote_text };
  // Your message shares its id with the chat action, whose request holds the images and files.
  if (typeof row.request === "string") {
    const request = JSON.parse(row.request) as ActionRequest;
    Object.assign(message, imageFields(chatImages(request)), request.files ? { files: request.files } : {});
  }
  if (typeof row.media === "string") {
    const media = JSON.parse(row.media) as { images?: string[]; video?: string; files?: ChatFile[]; card?: string; posted?: PostedCard; team?: { from: string; to: string } };
    if (media.team) message.team = { from: media.team.from, to: media.team.to };
    Object.assign(
      message,
      imageFields(media.images ?? []),
      media.video ? { video: media.video } : {},
      media.files?.length ? { files: media.files } : {},
      media.card ? { card: media.card } : {},
      media.posted ? { posted: media.posted } : {},
    );
  }
  if (typeof row.card_title === "string") message.cardTitle = row.card_title;
  const status = typeof row.status === "string" ? CHAT_STATUS[row.status as ActionStatus] : undefined;
  if (message.from === "owner" && status) message.status = status;
  if (typeof row.ack === "string") message.ack = JSON.parse(row.ack) as NonNullable<ChatMessage["ack"]>;
  return message;
}

/**
 * A card answer's card title: the one stored with the answer, else the line that posted the card (its filing's, else any
 * line that posted it) or Rivet's own card line, so an old answer names its card though the card left the board.
 */
/** Stop it's line ("Stop <chat>: <title>", "Stop this: <title>"): it is about the page it was sent on, so never splits off. */
const STOP_LINE = /^Stop [^:\n]+: /;

/** One conversation splitting off: its root message, the conversation it leaves, and the messages and cards that move. */
export interface SplitGroup {
  root: string;
  from: string;
  title: string;
  messages: string[];
  cards: string[];
  /** The root's text: a card line's title names the new conversation. */
  text: string;
}

const CARD_TITLE = `CASE WHEN m.sender = 'owner' AND m.media IS NOT NULL AND json_extract(m.media, '$.card') IS NOT NULL THEN COALESCE(
    json_extract(m.media, '$.cardTitle'),
    (SELECT json_extract(p.media, '$.posted.title') FROM card_conversations c JOIN chat_messages p ON p.id = c.posted WHERE c.card = json_extract(m.media, '$.card')),
    (SELECT json_extract(p.media, '$.posted.title') FROM chat_messages p WHERE p.sender = 'rivet' AND p.media IS NOT NULL AND json_extract(p.media, '$.posted.id') = json_extract(m.media, '$.card') ORDER BY p.seq DESC LIMIT 1),
    (SELECT substr(p.text, 7, length(p.text) - 8) FROM chat_messages p WHERE p.sender = 'rivet' AND p.media IS NOT NULL AND json_extract(p.media, '$.card') = json_extract(m.media, '$.card') AND p.text LIKE 'Card: % ›' ORDER BY p.seq DESC LIMIT 1)
  ) END`;

/** A chat message with its window's status and request, its thread's project and, for a card answer, its card's title. */
const MESSAGE_SELECT = `SELECT m.*, a.status, a.request, t.project AS thread_project, t.rivet_project AS thread_rivet_project,
  ${CARD_TITLE} AS card_title FROM chat_messages m
  LEFT JOIN audit a ON a.id = m.id LEFT JOIN chat_threads t ON t.root_id = m.thread_id`;

/** One thread as the list sees it: its first and newest messages, and what Rivet set on it. */
export interface ThreadRow {
  id: string;
  count: number;
  lastSeq: number;
  rootFrom: ChatMessage["from"];
  rootText: string;
  rootReplyTo: string | null;
  rootImages: number;
  rootFiles: number;
  lastFrom: ChatMessage["from"];
  lastText: string;
  /** Rivet's PDFs on the last word (say.mjs --file): a file-only answer reads "File", not "Photo". */
  lastFiles?: number;
  lastAt: string;
  /** The last word's time: lastFrom, lastText and lastAsks pass over a card shown inline (posted), which is no one's word. */
  lastWordAt: string;
  /** The last message asks you: its text ends with "?" (read in full: lastText is cut short), or it opens a question card. */
  lastAsks: boolean;
  lastOwnerAt: string | null;
  title: string | null;
  status: ThreadStatus | null;
  statusAt: string | null;
  project: ThreadProject | null;
  /** The project Rivet last set: your Move writes `project` only. */
  rivetProject: ThreadProject | null;
  tag: string | null;
  aiTitle: string | null;
  aiTitledAt: string | null;
  aiProject: ThreadProject | null;
  /** When you last moved it: its stored project and tag then stand, even empty, over the ask's and the titler's. */
  movedAt: string | null;
  /** Your rename: it wins over Rivet's title and the titler's. */
  ownerTitle: string | null;
  /** The time of the newest message you have read in it. */
  readAt: string | null;
  /** When you closed it; a message since reopens it. */
  closedAt: string | null;
  /** When you marked it unread; reading it clears this. */
  unreadAt: string | null;
  /** When you pinned it. */
  pinnedAt: string | null;
  /** When Rivet marked it done; you writing after it undoes it. */
  doneAt: string | null;
  /** When you reopened it (or, before 2026-10-10, the merged sweep closed it): a Reopen keeps it listed two hours. */
  sweptAt: string | null;
}

export interface StoredStep {
  kind: StepKind;
  label: string;
  url?: string;
  at: string;
}

/** How many PR links a conversation keeps (conversation_prs): its current ones always, then the newest. */
export const CONVERSATION_PRS_KEPT = 100;

export class CommandStore {
  private readonly db: DatabaseSync;
  /** threadRows' last answer, while the chat version it was read at holds. */
  private rows: { version: number; rows: readonly ThreadRow[] } | null = null;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "rivet.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    migrate(this.db);
    this.db.exec(CHAT_VERSION);
  }

  close(): void {
    this.db.close();
  }

  /** Records a new action, or returns the row that clientId already made. */
  addAction(input: { id: string; clientId: string; kind: ActionKind; request: ActionRequest; at: string }): { entry: AuditEntry; created: boolean } {
    const existing = this.getActionByClientId(input.clientId);
    if (existing) return { entry: existing, created: false };
    this.db
      .prepare("INSERT INTO audit (id, client_id, kind, at, updated_at, status, request) VALUES (?, ?, ?, ?, ?, 'queued', ?)")
      .run(input.id, input.clientId, input.kind, input.at, input.at, JSON.stringify(input.request));
    return { entry: this.getAction(input.id)!, created: true };
  }

  /**
   * An action and your chat line for it in one transaction, so a retry or a bridge attach never finds one without
   * the other; a clientId already used returns its pair.
   */
  addActionWithMessage(
    input: { id: string; clientId: string; kind: ActionKind; request: ActionRequest; at: string },
    message: Omit<Parameters<CommandStore["addChatMessage"]>[0], "id" | "at">,
  ): { entry: AuditEntry; message: ChatMessage | null; created: boolean } {
    const existing = this.getActionByClientId(input.clientId);
    if (existing) return { entry: existing, message: this.getChatMessage(existing.id), created: false };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO audit (id, client_id, kind, at, updated_at, status, request) VALUES (?, ?, ?, ?, ?, 'queued', ?)")
        .run(input.id, input.clientId, input.kind, input.at, input.at, JSON.stringify(input.request));
      const stored = this.addChatMessage({ ...message, id: input.id, at: input.at });
      this.db.exec("COMMIT");
      return { entry: this.getAction(input.id)!, message: stored, created: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getAction(id: string): AuditEntry | null {
    const row = this.db.prepare("SELECT * FROM audit WHERE id = ?").get(id) as Row | undefined;
    return row ? toEntry(row) : null;
  }

  getActionByClientId(clientId: string): AuditEntry | null {
    const row = this.db.prepare("SELECT * FROM audit WHERE client_id = ?").get(clientId) as Row | undefined;
    return row ? toEntry(row) : null;
  }

  /**
   * Opens a chat window led by this message, or adds it to the open one. A window past its deadline, or one this
   * message's images or text would overfill, is closed first and returned for the bridge.
   */
  addChat(
    input: { id: string; clientId: string; request: ActionRequest; at: string },
    now: number,
    maxText = BATCH_MAX_TEXT,
    maxImages = MAX_CHAT_IMAGES,
  ): { entry: AuditEntry; closed: AuditEntry | null } {
    const existing = this.getActionByClientId(input.clientId);
    if (existing) return { entry: existing, closed: null };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let closed: AuditEntry | null = null;
      let lead: string | null = null;
      const open = this.db
        .prepare("SELECT * FROM audit WHERE kind = 'chat' AND status = 'collecting' AND batch_id = id ORDER BY rowid DESC LIMIT 1")
        .get() as Row | undefined;
      if (open) {
        const batch = this.combined(toEntry(open));
        const text = chatWindowText([batch.text, input.request.text]);
        const images = [...chatImages(batch), ...chatImages(input.request)];
        // A bridge that cannot take this window's photos must still receive new text independently.
        const photosFit =
          images.length <= maxImages &&
          (chatImages(input.request).length === 0 || this.imageBytes(images) <= MAX_CHAT_IMAGE_BYTES);
        const filesFit = !input.request.files || uniqueFiles([...(batch.files ?? []), ...input.request.files]).length <= MAX_CHAT_FILES;
        // A reply leads its own window, so the window's one line says what it answers; a window holds one conversation.
        const conversation = input.request.conversation;
        const sameConversation = conversation === undefined || (conversation !== null && this.threadOf(open.id as string) === conversation);
        const fits = now < deadline(open) && photosFit && filesFit && text.length <= maxText && !input.request.replyTo && sameConversation;
        if (fits) lead = open.id as string;
        else closed = this.flush(open.id as string, input.at);
      }
      this.db
        .prepare(
          `INSERT INTO audit (id, client_id, kind, at, updated_at, status, request, batch_id, batch_first_at, batch_last_at)
           VALUES (?, ?, 'chat', ?, ?, 'collecting', ?, ?, ?, ?)`,
        )
        .run(input.id, input.clientId, input.at, input.at, JSON.stringify(input.request), lead ?? input.id, lead ? null : now, lead ? null : now);
      if (lead) this.db.prepare("UPDATE audit SET batch_last_at = ? WHERE id = ?").run(now, lead);
      const { conversation } = input.request;
      this.addChatMessage({
        id: input.id,
        from: "owner",
        text: input.request.text ?? "",
        at: input.at,
        replyTo: input.request.replyTo,
        quote: input.request.quote,
        // A new conversation starts at this message, never joining the window open before it.
        ...(conversation === null ? { thread: input.id } : conversation !== undefined ? { thread: conversation } : {}),
      });
      this.db.exec("COMMIT");
      return { entry: this.getAction(input.id)!, closed };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Closes every chat window whose deadline has passed; each comes back as its lead, carrying the whole window. */
  flushDue(now: number, at: string): AuditEntry[] {
    const due = this.db
      .prepare(
        `SELECT id FROM audit WHERE kind = 'chat' AND status = 'collecting' AND batch_id = id
           AND MIN(batch_last_at + ?, batch_first_at + ?) <= ? ORDER BY rowid`,
      )
      .all(BATCH_QUIET_MS, BATCH_CAP_MS, now) as Row[];
    return due.map((row) => this.flush(row.id as string, at)).filter((entry): entry is AuditEntry => entry !== null);
  }

  /** Moves a window from collecting to queued, lead and members together. */
  private flush(lead: string, at: string): AuditEntry | null {
    const result = this.db.prepare("UPDATE audit SET status = 'queued', updated_at = ? WHERE batch_id = ? AND status = 'collecting'").run(at, lead);
    return Number(result.changes) > 0 ? this.combined(this.getAction(lead)!) : null;
  }

  /** These images' stored sizes together; one no longer stored counts as nothing. */
  imageBytes(images: readonly string[]): number {
    return images.reduce((total, sha) => total + (this.getMedia(sha)?.size ?? 0), 0);
  }

  /** A lead as the bridge sees it: every member's text in order as one line (chatWindowText), and the window's images and files in order, once each. */
  private combined(lead: AuditEntry): AuditEntry {
    const requests = (this.db.prepare("SELECT request FROM audit WHERE batch_id = ? ORDER BY rowid").all(lead.id) as Row[]).map(
      (row) => JSON.parse(row.request as string) as ActionRequest,
    );
    if (requests.length === 0) return lead;
    const { text: _text, image: _image, images: _images, files: _files, ...rest } = lead;
    const text = chatWindowText(requests.map((request) => request.text));
    const files = uniqueFiles(requests.flatMap((request) => request.files ?? []));
    return { ...rest, ...(text ? { text } : {}), ...imageFields([...new Set(requests.flatMap(chatImages))]), ...(files.length ? { files } : {}) };
  }

  /**
   * What you attached to a chat message, as Rivet fetches it: a lead's whole window, a member's own message; null
   * for an id that is no chat message.
   */
  chatAttachments(id: string): { images: string[]; files: FileRef[] } | null {
    const entry = this.getAction(id);
    if (!entry || entry.kind !== "chat") return null;
    const whole = this.leadOf(id) === id ? this.combined(entry) : entry;
    return { images: chatImages(whole), files: whole.files ?? [] };
  }

  /** The lead of `id`'s chat window; `id` itself for a lead, an unbatched row or an unknown id. */
  private leadOf(id: string): string {
    const row = this.db.prepare("SELECT COALESCE(batch_id, id) AS lead FROM audit WHERE id = ?").get(id) as Row | undefined;
    return (row?.lead as string | undefined) ?? id;
  }

  /** The chat messages in `id`'s window, oldest first; just `id` for anything else. */
  batchIds(id: string): string[] {
    const ids = (
      this.db.prepare("SELECT id FROM audit WHERE batch_id = (SELECT batch_id FROM audit WHERE id = ?) ORDER BY rowid").all(id) as Row[]
    ).map((row) => row.id as string);
    return ids.length ? ids : [id];
  }

  /**
   * A final status never changes again, so a late or replayed ack cannot undo a result. A member names its window:
   * the lead and every member move together, so no member keeps a status of its own.
   */
  updateAction(named: string, status: ActionStatus, detail: ActionDetail | undefined, at: string): AuditEntry | null {
    const id = this.leadOf(named);
    const current = this.getAction(id);
    if (!current) return null;
    if (FINAL_STATUSES.has(current.status)) return current;
    this.db
      .prepare("UPDATE audit SET status = ?, detail = COALESCE(?, detail), updated_at = ? WHERE id = ? OR batch_id = ?")
      .run(status, detail ? JSON.stringify(detail) : null, at, id, id);
    return this.getAction(id);
  }

  listAudit(limit: number): AuditEntry[] {
    return (this.db.prepare("SELECT * FROM audit ORDER BY at DESC, rowid DESC LIMIT ?").all(limit) as Row[]).map(toEntry);
  }

  /**
   * Actions other than chat and GitHub issue writes (both sent again instead) with no outcome yet, newest first so a pile of old rows cannot crowd out recent ones; the bridge answers for them after a
   * reconnect. A send or pause is done once it is typed or unconfirmed.
   */
  outstandingActions(since: string, limit: number): { id: string; kind: ActionKind }[] {
    const final = [...FINAL_STATUSES];
    return (
      this.db
        .prepare(
          `SELECT id, kind FROM audit WHERE kind NOT IN ('chat', 'issue') AND at >= ? AND status NOT IN (${final.map(() => "?").join(", ")})
             AND NOT (kind IN ('send', 'pause') AND status IN ('typed', 'unconfirmed'))
           ORDER BY at DESC, rowid DESC LIMIT ?`,
        )
        .all(since, ...final, limit) as Row[]
    ).map((row) => ({ id: row.id as string, kind: row.kind as ActionKind }));
  }

  /** GitHub issue writes the bridge has not answered yet, oldest first: each attach sends them again. */
  queuedIssueWrites(): AuditEntry[] {
    return (this.db.prepare("SELECT * FROM audit WHERE kind = 'issue' AND status = 'queued' ORDER BY at, rowid").all() as Row[]).map(toEntry);
  }

  /** One issue's GitHub writes, newest first. */
  issueWrites(repo: string, issue: number, limit: number): AuditEntry[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM audit WHERE kind = 'issue' AND json_extract(request, '$.repo') = ? AND json_extract(request, '$.issue') = ? ORDER BY at DESC, rowid DESC LIMIT ?",
        )
        .all(repo, issue, limit) as Row[]
    ).map(toEntry);
  }

  /** Closes still waiting, however old (the Mac may be off for hours), and those done since `since`, newest first. */
  recentCloses(since: string): AuditEntry[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM audit WHERE kind = 'issue' AND json_extract(request, '$.op') = 'close' AND (status = 'queued' OR (status = 'succeeded' AND updated_at >= ?)) ORDER BY at DESC, rowid DESC",
        )
        .all(since) as Row[]
    ).map(toEntry);
  }

  /** Chat lines the bridge has not typed yet, oldest first: each window's lead with the whole window, never a member. */
  queuedChat(): AuditEntry[] {
    return (
      this.db
        .prepare("SELECT * FROM audit WHERE kind = 'chat' AND status = 'queued' AND (batch_id IS NULL OR batch_id = id) ORDER BY at, rowid")
        .all() as Row[]
    ).map((row) => this.combined(toEntry(row)));
  }

  addChatMessage(message: {
    id: string;
    from: ChatMessage["from"];
    text: string;
    at: string;
    replyTo?: string;
    quote?: ChatQuote;
    images?: readonly string[];
    video?: string;
    /** Rivet's PDF (say.mjs --file), with its size. */
    files?: readonly ChatFile[];
    /** The thread a message that answers nothing joins, instead of starting its own; its own id starts one. */
    thread?: string;
    /** A card answer's card: the message's id is the reply's. */
    card?: string;
    /** The title the card had when it was answered. */
    cardTitle?: string;
    /** Rivet's message putting a card in this conversation. */
    posted?: PostedCard;
    /** A Team room message between two agents. */
    team?: { from: string; to: string };
  }): ChatMessage {
    const media =
      message.images?.length || message.video || message.files?.length || message.card || message.posted || message.team
        ? JSON.stringify({ images: message.images, video: message.video, files: message.files?.length ? message.files : undefined, card: message.card, cardTitle: message.cardTitle, posted: message.posted, team: message.team })
        : null;
    this.db
      .prepare("INSERT OR IGNORE INTO chat_messages (id, sender, text, at, reply_to, quote_from, quote_text, thread_id, media) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        message.id,
        message.from,
        message.text,
        message.at,
        message.replyTo ?? null,
        message.quote?.from ?? null,
        message.quote?.text ?? null,
        this.threadFor(message.id, message.replyTo, message.thread),
        media,
      );
    const stored = this.getChatMessage(message.id)!;
    // Your own photos are on your chat action's request, never here; only what Rivet sends goes to Media.
    if (message.from === "rivet") {
      const conversation = stored.threadId ?? stored.id;
      for (const sha of message.images ?? []) this.recordSeen({ sha, kind: "image", source: "chat", ref: message.id, conversation, at: message.at });
      if (message.video) this.recordSeen({ sha: message.video, kind: "video", source: "chat", ref: message.id, conversation, at: message.at });
    }
    return stored;
  }

  /** A new message's thread: what it answers, when that is a message here; its window's lead, for a later member; else its own. */
  private threadFor(id: string, replyTo: string | undefined, thread: string | undefined): string {
    if (replyTo !== undefined) {
      const answered = this.threadOf(replyTo);
      if (answered) return answered;
    }
    if (thread === id) return id;
    if (thread !== undefined) return this.threadOf(thread) ?? id;
    const lead = this.leadOf(id);
    return (lead !== id ? this.threadOf(lead) : null) ?? id;
  }

  /** The thread `id` is in; null for an id that is no chat message. */
  threadOf(id: string): string | null {
    const row = this.db.prepare("SELECT COALESCE(thread_id, id) AS thread FROM chat_messages WHERE id = ?").get(id) as Row | undefined;
    return (row?.thread as string | undefined) ?? null;
  }

  /** A conversation has a title or a project from Rivet's side (patchThread), whoever set it. */
  threadFiled(id: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM chat_threads WHERE root_id = ? AND (title IS NOT NULL OR project IS NOT NULL OR rivet_project IS NOT NULL)").get(id) !==
      undefined
    );
  }

  /** The conversation of the latest message replying to `id`. */
  repliedIn(id: string): string | null {
    const row = this.db.prepare("SELECT COALESCE(thread_id, id) AS thread FROM chat_messages WHERE reply_to = ? ORDER BY seq DESC LIMIT 1").get(id) as Row | undefined;
    return (row?.thread as string | undefined) ?? null;
  }

  /** Your latest answer to the card (your comment on it, say), as your message; null when you have none. */
  cardAnswer(card: string): ChatMessage | null {
    const row = this.db
      .prepare("SELECT id FROM chat_messages WHERE sender = 'owner' AND media IS NOT NULL AND json_extract(media, '$.card') = ? ORDER BY seq DESC LIMIT 1")
      .get(card) as Row | undefined;
    return row ? this.getChatMessage(row.id as string) : null;
  }

  /** The conversation of the card's latest answer, so a card answered again (a new rev) answers in the same one. */
  cardThread(card: string): string | null {
    const row = this.db
      .prepare(
        "SELECT COALESCE(thread_id, id) AS thread FROM chat_messages WHERE media IS NOT NULL AND json_extract(media, '$.card') = ? AND COALESCE(thread_id, id) != ? ORDER BY seq DESC LIMIT 1",
      )
      .get(card, TEAM_ROOM_ID) as Row | undefined;
    return (row?.thread as string | undefined) ?? null;
  }

  /** The conversation a card was filed in (its message's, so a merge moves it too), and by which rule; null when none. */
  cardConversation(card: string): { thread: string; via: string; posted: string | null } | null {
    const row = this.db.prepare("SELECT thread, via, posted FROM card_conversations WHERE card = ?").get(card) as Row | undefined;
    if (!row) return null;
    return { thread: this.threadOf(row.thread as string) ?? (row.thread as string), via: row.via as string, posted: (row.posted as string | null) ?? null };
  }

  /**
   * Files a card once: a later write of the same card never moves it (your merge does, through its message). `again`:
   * the card left the board and came back, so this filing replaces the old one (2026-10-20) and its posted line is unset.
   */
  fileCard(input: { card: string; thread: string; via: string; stem: string | null; repo: string | null; pr: number | null; chat: string | null; at: string; again?: true }): boolean {
    const filed =
      Number(
        this.db
          .prepare(`INSERT OR ${input.again ? "REPLACE" : "IGNORE"} INTO card_conversations (card, thread, via, stem, repo, pr, chat, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(input.card, input.thread, input.via, input.stem, input.repo, input.pr, input.chat, input.at).changes,
      ) > 0;
    return filed;
  }

  /**
   * Stores the card's title on your answers from before titles were kept (2026-10-20), from `titleOf` (the answer's
   * own reply), so an old answer names its card once the card and any line that posted it are gone. Returns how many.
   */
  backfillCardTitles(titleOf: (id: string) => string | undefined): number {
    const rows = this.db
      .prepare("SELECT id FROM chat_messages WHERE sender = 'owner' AND media IS NOT NULL AND json_extract(media, '$.card') IS NOT NULL AND json_extract(media, '$.cardTitle') IS NULL")
      .all() as Row[];
    const set = this.db.prepare("UPDATE chat_messages SET media = json_set(media, '$.cardTitle', ?) WHERE id = ?");
    let done = 0;
    for (const row of rows) {
      const title = titleOf(row.id as string);
      if (title) done += Number(set.run(title, row.id as string).changes);
    }
    return done;
  }

  /** Your card answers whose card is filed nowhere, newest first. */
  unfiledAnswers(): { id: string; card: string; at: string }[] {
    return this.db
      .prepare(
        `SELECT id, json_extract(media, '$.card') AS card, at FROM chat_messages
          WHERE sender = 'owner' AND media IS NOT NULL AND json_extract(media, '$.card') IS NOT NULL
            AND json_extract(media, '$.card') NOT IN (SELECT card FROM card_conversations)
          ORDER BY seq DESC`,
      )
      .all() as { id: string; card: string; at: string }[];
  }

  /** Every filed card's id, by the conversation it is in now; a say card's own line and rules speak for it already. */
  filedCards(): Map<string, string[]> {
    const rows = this.db
      .prepare("SELECT c.card, COALESCE(m.thread_id, m.id) AS thread FROM card_conversations c JOIN chat_messages m ON m.id = c.thread WHERE c.via <> 'say'")
      .all() as Row[];
    const filed = new Map<string, string[]>();
    for (const row of rows) filed.set(row.thread as string, [...(filed.get(row.thread as string) ?? []), row.card as string]);
    return filed;
  }

  /**
   * The conversations each of `cards` is in: filed there (a say card too), or shown by a card line of Rivet's, as a
   * question card filed before cards were (2026-10-09) is only.
   */
  conversationsOfCards(cards: readonly string[]): Map<string, string[]> {
    const found = new Map<string, Set<string>>();
    if (!cards.length) return new Map();
    const marks = cards.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT c.card, COALESCE(m.thread_id, m.id) AS thread FROM card_conversations c JOIN chat_messages m ON m.id = c.thread WHERE c.card IN (${marks})
         UNION
         SELECT json_extract(media, '$.card') AS card, COALESCE(thread_id, id) AS thread FROM chat_messages
          WHERE sender = 'rivet' AND media IS NOT NULL AND json_extract(media, '$.card') IN (${marks})`,
      )
      .all(...cards, ...cards) as Row[];
    for (const row of rows) found.set(row.thread as string, (found.get(row.thread as string) ?? new Set()).add(row.card as string));
    return new Map([...found].map(([thread, ids]) => [thread, [...ids]]));
  }

  /** Names the line a card's message answers: a card posted before 2026-10-12, or one now answering another line. */
  linkPostedReply(message: string, replyTo: string): boolean {
    return this.db.prepare("UPDATE chat_messages SET reply_to = ? WHERE id = ? AND reply_to IS NOT ?").run(replyTo, message, replyTo).changes > 0;
  }

  /** Records Rivet's message that shows the card in its conversation. */
  setCardPosted(card: string, message: string): void {
    this.db.prepare("UPDATE card_conversations SET posted = ? WHERE card = ?").run(message, card);
  }

  /**
   * The conversation of the newest card filed with the same stem, PR or chat (the first of those that matches), for a
   * card whose writer named none. Server-owned conversations never take one.
   */
  filedLike(match: { stem: string | null; repo: string; pr: number | null; chat: string | null }): { thread: string; via: "stem" | "pr" | "chat" } | null {
    const tries: ["stem" | "pr" | "chat", string, unknown[]][] = [];
    // A stem joins only the same repo's cards, on the same PR or with none: deploy-4861 and deploy-4900 are two things.
    // A card filed with no repo (null) is the default repo's.
    if (match.stem !== null)
      tries.push(
        match.pr === null
          ? ["stem", "stem = ? AND lower(COALESCE(repo, ?)) = lower(?)", [match.stem, NO_REPO, match.repo]]
          : ["stem", "stem = ? AND lower(COALESCE(repo, ?)) = lower(?) AND (pr IS NULL OR pr = ?)", [match.stem, NO_REPO, match.repo, match.pr]],
      );
    if (match.pr !== null) tries.push(["pr", "pr = ? AND lower(COALESCE(repo, ?)) = lower(?)", [match.pr, NO_REPO, match.repo]]);
    if (match.chat !== null) tries.push(["chat", "chat = ? AND lower(COALESCE(repo, ?)) = lower(?)", [match.chat, NO_REPO, match.repo]]);
    for (const [via, where, args] of tries) {
      for (const row of this.db.prepare(`SELECT thread FROM card_conversations WHERE ${where} ORDER BY at DESC, rowid DESC LIMIT 5`).all(...(args as string[])) as Row[]) {
        const thread = this.threadOf(row.thread as string);
        if (thread && !SEED_IDS.includes(thread)) return { thread, via };
      }
    }
    return null;
  }

  /**
   * Moves every message of conversation `from` into `into` (your Merge into…, or the tidy of 2026-10-09): their
   * thread, Rivet's steps, the PRs it linked and its Media rows. `into` keeps its id, title and settings; `from`'s
   * settings go. Answers how many messages moved: 0 when `from` is no longer a conversation of its own.
   */
  mergeConversation(from: string, into: string): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const moved = Number(this.db.prepare("UPDATE chat_messages SET thread_id = ? WHERE COALESCE(thread_id, id) = ?").run(into, from).changes);
      if (moved > 0) {
        this.db.prepare("UPDATE chat_thread_steps SET root_id = ? WHERE root_id = ?").run(into, from);
        this.db.prepare("INSERT OR IGNORE INTO conversation_prs (thread, pr) SELECT ?, pr FROM conversation_prs WHERE thread = ?").run(into, from);
        this.db.prepare("DELETE FROM conversation_prs WHERE thread = ?").run(from);
        this.db.prepare("UPDATE media_seen SET conversation = ? WHERE conversation = ?").run(into, from);
        this.db.prepare("DELETE FROM chat_threads WHERE root_id = ?").run(from);
      }
      this.db.exec("COMMIT");
      return moved;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * What splits off (2026-10-20): in each conversation (only `only`, when given; never a server-owned one or a Find more
   * work issue's), every root, and the messages that chain to it. A root is a line you typed with no Reply and no card
   * on the page of a conversation it did not start (sent naming that conversation: never a merged-in conversation's
   * first line, nor a Stop it). A message chains by the line it replies to; a
   * card answer, to its card's line; a card's line, to the line or card its card named (`cardReplyTo`, from the board).
   * Everything else stays. A root that starts its conversation is no root, so a split never plans the same move twice.
   */
  splitPlan(only: string | null, cardReplyTo: ReadonlyMap<string, string>): SplitGroup[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.sender, m.text, m.reply_to, COALESCE(m.thread_id, m.id) AS thread, json_extract(m.media, '$.card') AS card, json_extract(m.media, '$.posted.id') AS posted,
                json_extract(a.request, '$.conversation') AS typed_in
           FROM chat_messages m LEFT JOIN audit a ON a.id = m.id
          WHERE COALESCE(m.thread_id, m.id) NOT IN (${SEED_IDS.map(() => "?").join(", ")})
            AND COALESCE(m.thread_id, m.id) NOT IN (SELECT COALESCE(f.thread_id, f.id) FROM find_work_conversations w JOIN chat_messages f ON f.id = w.root)
            ${only === null ? "" : "AND COALESCE(m.thread_id, m.id) = ?"}
          ORDER BY m.seq`,
      )
      .all(...SEED_IDS, ...(only === null ? [] : [only])) as Row[];
    const filings = this.db.prepare("SELECT card, posted FROM card_conversations").all() as Row[];
    const filed = new Map(filings.flatMap((row) => (typeof row.posted === "string" ? [[row.card as string, row.posted]] : [])));
    // A card filed by its answer alone (no posted line) still has a conversation, so an ask replying to it follows it there.
    const anyFiled = new Set(filings.map((row) => row.card as string));
    const byThread = new Map<string, Row[]>();
    for (const row of rows) byThread.set(row.thread as string, [...(byThread.get(row.thread as string) ?? []), row]);
    const groups: SplitGroup[] = [];
    for (const [thread, messages] of byThread) {
      const byId = new Map(messages.map((row) => [row.id as string, row]));
      const lineOf = new Map<string, string>();
      for (const row of messages) if (typeof row.posted === "string") lineOf.set(row.posted, row.id as string);
      // A say card is Rivet's own line carrying the card, filed with no posted line.
      for (const row of messages) if (row.sender === "rivet" && typeof row.card === "string" && !lineOf.has(row.card)) lineOf.set(row.card, row.id as string);
      const cardLine = (card: string): Row | undefined => byId.get(filed.get(card) ?? "") ?? byId.get(lineOf.get(card) ?? "");
      const followsCard = (posted: string): boolean => {
        const named = cardReplyTo.get(posted);
        return named !== undefined && (anyFiled.has(named) || lineOf.has(named));
      };
      const isRoot = (row: Row): boolean =>
        row.id !== thread &&
        ((row.sender === "owner" && row.card === null && row.reply_to === null && row.typed_in === thread && !STOP_LINE.test(String(row.text))));
      const parent = (row: Row): Row | undefined => {
        if (typeof row.reply_to === "string" && byId.has(row.reply_to)) return byId.get(row.reply_to);
        if (typeof row.card === "string" && row.sender === "owner") return cardLine(row.card);
        if (typeof row.posted === "string") {
          const named = cardReplyTo.get(row.posted);
          return named === undefined ? undefined : (byId.get(named) ?? cardLine(named));
        }
        return undefined;
      };
      const rootOf = (row: Row): string | null => {
        const seen = new Set<string>();
        for (let up: Row | undefined = row; up && !seen.has(up.id as string); up = parent(up)) {
          if (isRoot(up)) return up.id as string;
          seen.add(up.id as string);
        }
        return null;
      };
      const moving = new Map<string, Row[]>();
      for (const row of messages) {
        if (row.id === thread) continue;
        const root = rootOf(row);
        if (root !== null) moving.set(root, [...(moving.get(root) ?? []), row]);
      }
      for (const [root, members] of moving) {
        const cards = members.flatMap((row) =>
          typeof row.posted === "string" && filed.get(row.posted) === row.id
            ? [row.posted]
            : row.sender === "rivet" && typeof row.card === "string" && lineOf.get(row.card) === row.id
              ? [row.card]
              : [],
        );
        groups.push({ root, from: thread, title: this.conversationTitle(root) ?? "", messages: members.map((row) => row.id as string), cards, text: byId.get(root)!.text as string });
      }
    }
    return groups;
  }

  /**
   * Moves what splitPlan planned into conversations of their own; each keeps the app-only folder it left. `appOnly`:
   * the app-only project of each conversation the plan splits that is app-only, however it came to be (threads.summaries).
   */
  splitConversations(plan: readonly SplitGroup[], appOnly: ReadonlyMap<string, ThreadProject>, at: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const group of plan) {
        for (const id of group.messages) {
          this.db.prepare("UPDATE chat_messages SET thread_id = ? WHERE id = ?").run(group.root, id);
          this.db.prepare("UPDATE card_conversations SET thread = ? WHERE posted = ?").run(group.root, id);
          this.db.prepare("UPDATE media_seen SET conversation = ? WHERE source = 'chat' AND ref = ?").run(group.root, id);
        }
        // A conversation in the app only, whether Rivet, its ask, the titler or your Move put it there, keeps what leaves
        // it there, and stays there itself when the ask that kept it so leaves with a moved line.
        const kept = appOnly.get(group.from);
        if (kept) for (const id of [group.root, group.from]) this.writeThreadPatch(id, { project: kept }, at, false);
        for (const card of group.cards) {
          // A say card's filing has no posted line: it moves with Rivet's line that carries it, wherever it was filed
          // (a merge leaves a filing on the merged-in conversation's id).
          this.db.prepare("UPDATE card_conversations SET thread = ? WHERE card = ?").run(group.root, card);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * In each thread with a message since `since` (only `thread`, when given), what its messages holding any of `needles'
   * (lower case) name that the caller asks about: the PR reference `keep.pr` returns for each (null drops it; it may
   * return a plainer one, so references alike to the caller are kept once) and words in `keep.words`, each once,
   * by thread. Every message counts wherever it names a link, and what is kept is bounded by what was asked. One JSON
   * parameter holds the needles, so no count of them reaches SQLite's expression-depth limit.
   */
  threadMentions(
    needles: readonly string[],
    keep: { pr: (ref: PrRef) => PrRef | null; words: ReadonlySet<string> },
    since: string,
    thread?: string,
  ): Map<string, Mentions> {
    const found = new Map<string, { refs: Map<string, PrRef>; words: Set<string> }>();
    if (needles.length === 0) return new Map();
    const rows = this.db
      .prepare(
        `SELECT COALESCE(thread_id, id) AS thread, text
           FROM chat_messages
          WHERE COALESCE(thread_id, id) IN (SELECT COALESCE(thread_id, id) FROM chat_messages WHERE at >= ?${thread === undefined ? "" : " AND COALESCE(thread_id, id) = ?"})
            AND EXISTS (SELECT 1 FROM json_each(?) WHERE instr(lower(text), value) > 0)`,
      )
      .iterate(since, ...(thread === undefined ? [] : [thread]), JSON.stringify([...new Set(needles)])) as Iterable<Row>;
    for (const row of rows) {
      const { refs, words } = textMentions(row.text as string);
      let kept = found.get(row.thread as string);
      for (const named of refs) {
        const ref = keep.pr(named);
        if (!ref) continue;
        if (!kept) found.set(row.thread as string, (kept = { refs: new Map(), words: new Set() }));
        kept.refs.set(`${ref.repo ?? ""}#${ref.number}`, ref);
      }
      for (const word of words) {
        if (!keep.words.has(word)) continue;
        if (!kept) found.set(row.thread as string, (kept = { refs: new Map(), words: new Set() }));
        kept.words.add(word);
      }
    }
    return new Map([...found].map(([id, kept]) => [id, { refs: [...kept.refs.values()], words: kept.words }]));
  }

  /** The newest chat message's seq, 0 with none: messages are only ever added, so it moves whenever any text does. */
  /** Bumped by every change to a chat message, a thread's settings or an audit row. */
  chatVersion(): number {
    return Number((this.db.prepare("SELECT n FROM chat_version WHERE id = 1").get() as Row).n);
  }

  lastChatSeq(): number {
    return Number((this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM chat_messages").get() as Row).seq);
  }

  /** Each thread's latest message time, by thread. */
  threadLatest(): Map<string, string> {
    const rows = this.db.prepare("SELECT COALESCE(thread_id, id) AS thread, MAX(at) AS at FROM chat_messages GROUP BY COALESCE(thread_id, id)").all() as Row[];
    return new Map(rows.map((row) => [row.thread as string, row.at as string]));
  }

  /** Every thread, newest message first; read again only once a chat message, thread or audit row has changed. */
  threadRows(): readonly ThreadRow[] {
    const version = Number((this.db.prepare("SELECT n FROM chat_version WHERE id = 1").get() as Row).n);
    if (this.rows?.version !== version) this.rows = { version, rows: Object.freeze(this.readThreadRows().map((row) => Object.freeze(row))) };
    return this.rows.rows;
  }

  private readThreadRows(): ThreadRow[] {
    const rows = this.db
      .prepare(
        `SELECT g.thread_id, g.n, g.last_seq, g.last_owner_at,
                r.sender AS root_from, SUBSTR(r.text, 1, ?) AS root_text, r.reply_to AS root_reply_to,
                COALESCE(json_array_length(ra.request, '$.images'), json_array_length(r.media, '$.images'), CASE WHEN json_type(ra.request, '$.image') IS NULL THEN 0 ELSE 1 END) AS root_images,
                COALESCE(json_array_length(ra.request, '$.files'), json_array_length(r.media, '$.files'), 0) AS root_files,
                COALESCE(json_array_length(l.media, '$.files'), 0) AS last_files,
                l.sender AS last_from, SUBSTR(l.text, 1, ?) AS last_text, a.at AS last_at, l.at AS word_at,
                json_extract(l.media, '$.team.from') AS last_team_from, json_extract(l.media, '$.team.to') AS last_team_to,
                (SUBSTR(RTRIM(l.text, ' ' || char(9) || char(10) || char(13)), -1) = '?'
                  OR json_extract(l.media, '$.card') LIKE 'ask-%') AS last_asks,
                t.title, t.status, t.status_at, t.project, t.rivet_project, t.tag, t.ai_title, t.ai_titled_at, t.ai_project, t.moved_at,
                t.owner_title, t.read_at, t.closed_at, t.unread_at, t.pinned_at, t.done_at, t.swept_at
           FROM (SELECT COALESCE(thread_id, id) AS thread_id, COUNT(*) AS n, MAX(seq) AS last_seq,
                        MAX(CASE WHEN json_extract(media, '$.posted') IS NULL THEN seq END) AS word_seq,
                        MAX(CASE WHEN sender = 'owner' THEN at END) AS last_owner_at
                   FROM chat_messages GROUP BY COALESCE(thread_id, id)) g
           JOIN chat_messages r ON r.id = g.thread_id
           LEFT JOIN audit ra ON ra.id = r.id
           JOIN chat_messages a ON a.seq = g.last_seq
           JOIN chat_messages l ON l.seq = COALESCE(g.word_seq, g.last_seq)
           LEFT JOIN chat_threads t ON t.root_id = g.thread_id
          ORDER BY g.last_seq DESC`,
      )
      .all(THREAD_TEXT_READ, THREAD_TEXT_READ) as Row[];
    return rows.map((row) => {
      return {
        id: row.thread_id as string,
        count: Number(row.n),
        lastSeq: Number(row.last_seq),
        rootFrom: row.root_from as ChatMessage["from"],
        rootText: row.root_text as string,
        rootReplyTo: (row.root_reply_to as string | null) ?? null,
        rootImages: Number(row.root_images ?? 0),
        rootFiles: Number(row.root_files ?? 0),
        lastFrom: row.last_from as ChatMessage["from"],
        // A Team room message names who wrote to whom.
        lastText: typeof row.last_team_from === "string" ? `${row.last_team_from} → ${row.last_team_to as string}: ${row.last_text as string}` : (row.last_text as string),
        lastFiles: Number(row.last_files ?? 0),
        lastAt: row.last_at as string,
        lastWordAt: row.word_at as string,
        lastAsks: Number(row.last_asks) === 1,
        lastOwnerAt: (row.last_owner_at as string | null) ?? null,
        title: (row.title as string | null) ?? null,
        status: (row.status as ThreadStatus | null) ?? null,
        statusAt: (row.status_at as string | null) ?? null,
        project: (row.project as ThreadProject | null) ?? null,
        rivetProject: (row.rivet_project as ThreadProject | null) ?? null,
        tag: (row.tag as string | null) ?? null,
        aiTitle: (row.ai_title as string | null) ?? null,
        aiTitledAt: (row.ai_titled_at as string | null) ?? null,
        aiProject: (row.ai_project as ThreadProject | null) ?? null,
        movedAt: (row.moved_at as string | null) ?? null,
        ownerTitle: (row.owner_title as string | null) ?? null,
        readAt: (row.read_at as string | null) ?? null,
        closedAt: (row.closed_at as string | null) ?? null,
        unreadAt: (row.unread_at as string | null) ?? null,
        pinnedAt: (row.pinned_at as string | null) ?? null,
        doneAt: (row.done_at as string | null) ?? null,
        sweptAt: (row.swept_at as string | null) ?? null,
      };
    });
  }

  /** Rivet's steps on every thread, keyed by thread, each in the order set. */
  allThreadSteps(): Map<string, StoredStep[]> {
    const steps = new Map<string, StoredStep[]>();
    for (const row of this.db.prepare("SELECT root_id, kind, label, url, at FROM chat_thread_steps ORDER BY seq").all() as Row[]) {
      const list = steps.get(row.root_id as string) ?? [];
      list.push({ kind: row.kind as StepKind, label: row.label as string, ...(row.url !== null ? { url: row.url as string } : {}), at: row.at as string });
      steps.set(row.root_id as string, list);
    }
    return steps;
  }

  /** One thread's row; null when no message starts it. */
  threadRow(id: string): ThreadRow | null {
    return this.threadRows().find((row) => row.id === id) ?? null;
  }

  /** A thread's messages, oldest first: the newest `limit`, and whether older ones were left out. */
  threadMessages(id: string, limit: number): { messages: ChatMessage[]; more: boolean } {
    const rows = this.db
      .prepare(`${MESSAGE_SELECT} WHERE COALESCE(m.thread_id, m.id) = ? ORDER BY m.seq DESC LIMIT ?`)
      .all(id, limit + 1) as Row[];
    return { messages: rows.slice(0, limit).map(toMessage).reverse(), more: rows.length > limit };
  }

  /** A thread's messages older than its message `before`, as threadMessages pages them; null when `before` is not in it. */
  threadMessagesBefore(id: string, before: string, limit: number): { messages: ChatMessage[]; more: boolean } | null {
    const anchor = this.db.prepare("SELECT seq FROM chat_messages WHERE id = ? AND COALESCE(thread_id, id) = ?").get(before, id) as Row | undefined;
    if (!anchor) return null;
    const rows = this.db
      .prepare(`${MESSAGE_SELECT} WHERE COALESCE(m.thread_id, m.id) = ? AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`)
      .all(id, anchor.seq as number, limit + 1) as Row[];
    return { messages: rows.slice(0, limit).map(toMessage).reverse(), more: rows.length > limit };
  }

  /** Rivet's steps on a thread, in the order set. */
  threadSteps(id: string): StoredStep[] {
    return (this.db.prepare("SELECT kind, label, url, at FROM chat_thread_steps WHERE root_id = ? ORDER BY seq").all(id) as Row[]).map((row) => ({
      kind: row.kind as StepKind,
      label: row.label as string,
      ...(row.url !== null ? { url: row.url as string } : {}),
      at: row.at as string,
    }));
  }

  /**
   * Applies Rivet's change to thread `id` (a thread's first message): a null clears a field, a status records when it
   * was set, a step already there (same stage, label and link) is skipped, and steps past MAX_THREAD_STEPS are refused.
   * False when nothing changed. `moved` is your Move: it records when, so the titler never refiles the thread.
   */
  patchThread(id: string, patch: ThreadPatch, at: string, moved = false): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.writeThreadPatch(id, patch, at, moved);
      this.db.exec("COMMIT");
      return changed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** patchThread's write, inside the caller's transaction. */
  private writeThreadPatch(id: string, patch: ThreadPatch, at: string, moved: boolean): boolean {
    {
      const current = this.db.prepare("SELECT title, status, status_at, project, rivet_project, tag, moved_at FROM chat_threads WHERE root_id = ?").get(id) as Row | undefined;
      // Rivet's filing moves the folder only while you never moved it: your Move keeps the folder you chose.
      const filesFolder = moved || current?.moved_at == null;
      const next = {
        title: patch.title !== undefined ? patch.title?.trim() ?? null : ((current?.title as string | null | undefined) ?? null),
        status: patch.status !== undefined ? patch.status : ((current?.status as string | null | undefined) ?? null),
        project: patch.project !== undefined && filesFolder ? patch.project : ((current?.project as string | null | undefined) ?? null),
        tag: patch.tag !== undefined ? patch.tag : ((current?.tag as string | null | undefined) ?? null),
      };
      const rivetProject = !moved && patch.project !== undefined ? patch.project : ((current?.rivet_project as string | null | undefined) ?? null);
      const statusAt = patch.status !== undefined ? (patch.status === null ? null : at) : ((current?.status_at as string | null | undefined) ?? null);
      let changed =
        next.title !== ((current?.title as string | null | undefined) ?? null) ||
        next.project !== ((current?.project as string | null | undefined) ?? null) ||
        rivetProject !== ((current?.rivet_project as string | null | undefined) ?? null) ||
        next.tag !== ((current?.tag as string | null | undefined) ?? null) ||
        patch.status !== undefined;
      if (patch.clearSteps && Number(this.db.prepare("DELETE FROM chat_thread_steps WHERE root_id = ?").run(id).changes) > 0) changed = true;
      const steps = this.threadSteps(id);
      for (const step of patch.steps ?? []) {
        if (steps.some((have) => have.kind === step.kind && have.label === step.label.trim() && have.url === step.url)) continue;
        if (steps.length >= MAX_THREAD_STEPS) throw new RangeError(`a thread holds at most ${MAX_THREAD_STEPS} steps`);
        const stored = { kind: step.kind, label: step.label.trim(), ...(step.url ? { url: step.url } : {}), at: step.at ?? at };
        this.db.prepare("INSERT INTO chat_thread_steps (root_id, kind, label, url, at) VALUES (?, ?, ?, ?, ?)").run(id, stored.kind, stored.label, stored.url ?? null, stored.at);
        steps.push(stored);
        changed = true;
      }
      if (changed || moved) {
        this.db
          .prepare(
            `INSERT INTO chat_threads (root_id, title, status, status_at, project, rivet_project, tag, moved_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (root_id) DO UPDATE SET title = excluded.title, status = excluded.status, status_at = excluded.status_at,
               project = excluded.project, rivet_project = excluded.rivet_project, tag = excluded.tag, moved_at = COALESCE(excluded.moved_at, chat_threads.moved_at),
               updated_at = excluded.updated_at`,
          )
          .run(id, next.title, next.status, statusAt, next.project, rivetProject, next.tag, moved ? at : null, at);
      }
      return changed;
    }
  }

  /**
   * Records the AI titler's pass on thread `id`: its title and project (kept apart, so Rivet's and the ask's always
   * win), and its tag where none is set and you never moved it.
   */
  setThreadAi(id: string, ai: { title: string | null; tag: string | null; project: ThreadProject | null }, at: string): void {
    this.db
      .prepare(
        `INSERT INTO chat_threads (root_id, tag, ai_title, ai_titled_at, ai_project, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (root_id) DO UPDATE SET tag = COALESCE(chat_threads.tag, excluded.tag),
           ai_title = excluded.ai_title, ai_titled_at = excluded.ai_titled_at, ai_project = excluded.ai_project, updated_at = excluded.updated_at`,
      )
      .run(id, ai.tag, ai.title, at, ai.project, at);
  }

  /**
   * When the conversation list started: it holds conversations with a message since. Stamped once, the first time the
   * list is read (`now`), so it opens as a blank slate the day the app first shows it.
   */
  cutover(now: string): string {
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(CUTOVER_KEY, now);
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(CUTOVER_KEY) as Row).value as string;
  }

  /** Starts the Updates conversation the first time anything needs it: its root message and its title. */
  ensureUpdates(at: string): void {
    this.ensureRoot(UPDATES_ID, UPDATES_ROOT_TEXT, UPDATES_TITLE, at);
  }

  /**
   * The retention sweep. A conversation closed or done as the list shows it (isClosed, isDone), not pinned, its
   * newest message before `conversationsBefore` (null: none), goes whole: messages, settings, steps, PR links, card and
   * Find more work links, and its actions' words (as pruneTeamRoom). Then a finished action before `auditBefore` whose
   * message is gone, and a PR stage unchanged since `conversationsBefore` that no conversation links. `apply` true
   * deletes about `batch` rows of each, oldest first, in one transaction. False only reads: it counts all that is due,
   * those freed by the due conversations included, and writes nothing. A conversation with an action still unfinished
   * (queued for the bridge, say) is never due: blanking its words would lose it.
   */
  sweepRetention(conversationsBefore: string | null, auditBefore: string, apply: boolean, batch: number): RetentionCounts {
    const before = conversationsBefore ?? "";
    const finals = JSON.stringify([...FINAL_STATUSES]);
    // Conversations due, oldest first; with no window ("") none is.
    const due = `SELECT c.root, c.n, c.last FROM (
        SELECT COALESCE(thread_id, id) AS root, MAX(at) AS last, MAX(CASE WHEN sender = 'owner' THEN at END) AS last_owner, COUNT(*) AS n
        FROM chat_messages GROUP BY COALESCE(thread_id, id)
      ) c JOIN chat_threads t ON t.root_id = c.root
      WHERE c.last < $before AND t.pinned_at IS NULL
        AND ((t.closed_at IS NOT NULL AND t.closed_at IS NOT t.swept_at AND t.closed_at >= c.last)
          OR (t.done_at IS NOT NULL AND (c.last_owner IS NULL OR c.last_owner <= t.done_at)))
        AND c.root NOT IN (SELECT value FROM json_each($seeds))
        AND c.root NOT IN (SELECT COALESCE(m.thread_id, m.id) FROM audit a JOIN chat_messages m ON m.id = a.id
          WHERE a.status NOT IN (SELECT value FROM json_each($finals)))`;
    const seeds = JSON.stringify(SEED_IDS);
    if (!apply) {
      const row = this.db
        .prepare(
          `WITH due AS (${due})
           SELECT (SELECT COUNT(*) FROM due) AS conversations, (SELECT COALESCE(SUM(n), 0) FROM due) AS messages,
             (SELECT COUNT(*) FROM audit WHERE at < $audit AND status IN (SELECT value FROM json_each($finals))
                AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.id = audit.id AND COALESCE(m.thread_id, m.id) NOT IN (SELECT root FROM due))) AS audit,
             (SELECT COUNT(*) FROM pr_stages WHERE at < $before
                AND NOT EXISTS (SELECT 1 FROM conversation_prs c WHERE c.pr = pr_stages.pr AND c.thread NOT IN (SELECT root FROM due))) AS stages`,
        )
        .get({ $before: before, $seeds: seeds, $audit: auditBefore, $finals: finals }) as Row;
      return { conversations: Number(row.conversations), messages: Number(row.messages), audit: Number(row.audit), prStages: Number(row.stages) };
    }
    const counts: RetentionCounts = { conversations: 0, messages: 0, audit: 0, prStages: 0 };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // COALESCE(thread_id, id) = root, written so the thread and id indexes serve it.
      const of = "(thread_id = $root OR (thread_id IS NULL AND id = $root))";
      const ids = `SELECT id FROM chat_messages WHERE ${of}`;
      for (const row of this.db.prepare(`${due} ORDER BY c.last, c.root`).all({ $before: before, $seeds: seeds, $finals: finals }) as Row[]) {
        if (counts.conversations && counts.messages + (row.n as number) > batch) break;
        const root = row.root as string;
        this.db.prepare(`UPDATE audit SET request = json_set(json_remove(request, '$.quote'), '$.text', '') WHERE id IN (${ids})`).run({ $root: root });
        this.db.prepare(`DELETE FROM card_conversations WHERE thread IN (${ids})`).run({ $root: root });
        this.db.prepare(`DELETE FROM find_work_conversations WHERE root IN (${ids})`).run({ $root: root });
        this.db.prepare("DELETE FROM conversation_prs WHERE thread = ?").run(root);
        this.db.prepare("DELETE FROM chat_thread_steps WHERE root_id = ?").run(root);
        this.db.prepare("DELETE FROM chat_threads WHERE root_id = ?").run(root);
        counts.messages += Number(this.db.prepare(`DELETE FROM chat_messages WHERE ${of}`).run({ $root: root }).changes);
        counts.conversations += 1;
      }
      counts.audit = Number(
        this.db
          .prepare(
            `DELETE FROM audit WHERE rowid IN (SELECT rowid FROM audit WHERE at < ? AND status IN (SELECT value FROM json_each(?))
               AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.id = audit.id) ORDER BY at LIMIT ?)`,
          )
          .run(auditBefore, finals, batch).changes,
      );
      counts.prStages = Number(
        this.db
          .prepare(
            `DELETE FROM pr_stages WHERE rowid IN (SELECT rowid FROM pr_stages WHERE at < ?
               AND NOT EXISTS (SELECT 1 FROM conversation_prs c WHERE c.pr = pr_stages.pr) ORDER BY at LIMIT ?)`,
          )
          .run(before, batch).changes,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return counts;
  }

  getMeta(key: string): string | null {
    return ((this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined)?.value as string | undefined) ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** True when `key` was there. */
  deleteMeta(key: string): boolean {
    return Number(this.db.prepare("DELETE FROM meta WHERE key = ?").run(key).changes) > 0;
  }

  /** A server-owned conversation with a fixed id: its root message and its title, once. */
  /** Starts the Team room the first time an agent message needs it. */
  ensureTeamRoom(at: string): void {
    this.ensureRoot(TEAM_ROOM_ID, TEAM_ROOM_ROOT_TEXT, TEAM_ROOM_TITLE, at);
  }

  /** The Team room's agent messages from `since` up to `until` (ISO), oldest first: the hourly summary's counts. */
  teamMessages(since: string, until: string): { from: string; to: string; text: string }[] {
    const rows = this.db
      .prepare(
        `SELECT json_extract(media, '$.team.from') AS sender_chat, json_extract(media, '$.team.to') AS recipient, text FROM chat_messages
          WHERE thread_id = ? AND json_extract(media, '$.team.from') IS NOT NULL AND at >= ? AND at < ? ORDER BY seq`,
      )
      .all(TEAM_ROOM_ID, since, until) as Row[];
    return rows.map((row) => ({ from: row.sender_chat as string, to: row.recipient as string, text: row.text as string }));
  }

  /** Deletes the Team room's messages older than `before` (ISO), its heading aside: the room keeps a week. */
  pruneTeamRoom(before: string): number {
    // Your room lines share their action's id: its audit row keeps the action, not your words or the agent line you quoted.
    this.db
      .prepare(
        "UPDATE audit SET request = json_set(json_remove(request, '$.quote'), '$.text', '') WHERE id IN (SELECT id FROM chat_messages WHERE thread_id = ? AND id != ? AND at < ?)",
      )
      .run(TEAM_ROOM_ID, TEAM_ROOM_ID, before);
    return Number(this.db.prepare("DELETE FROM chat_messages WHERE thread_id = ? AND id != ? AND at < ?").run(TEAM_ROOM_ID, TEAM_ROOM_ID, before).changes);
  }

  private ensureRoot(id: string, text: string, title: string, at: string): void {
    if (this.threadOf(id)) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT OR IGNORE INTO chat_messages (id, sender, text, at, thread_id) VALUES (?, 'rivet', ?, ?, ?)")
        .run(id, text, at, id);
      this.db
        .prepare("INSERT INTO chat_threads (root_id, title, updated_at) VALUES (?, ?, ?) ON CONFLICT (root_id) DO UPDATE SET title = COALESCE(chat_threads.title, excluded.title)")
        .run(id, title, at);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Rivet's words in each conversation since you last read it and since `since` (the cutover), by thread: a "Card: … ›" line or a card shown inline never counts; the Team room has none. */
  unreadCounts(since: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(m.thread_id, m.id) AS thread, COUNT(*) AS n
           FROM chat_messages m LEFT JOIN chat_threads t ON t.root_id = COALESCE(m.thread_id, m.id)
          WHERE m.sender = 'rivet' AND m.id NOT IN (${SEED_IDS.map(() => "?").join(", ")}) AND COALESCE(m.thread_id, m.id) != ? AND m.at >= ?
            AND (t.read_at IS NULL OR m.at > t.read_at)
            AND (m.media IS NULL OR (json_extract(m.media, '$.card') IS NULL AND json_extract(m.media, '$.posted') IS NULL))
          GROUP BY COALESCE(m.thread_id, m.id)`,
      )
      .all(...SEED_IDS, TEAM_ROOM_ID, since) as Row[];
    return new Map(rows.map((row) => [row.thread as string, Number(row.n)]));
  }

  /** What your app shows as a conversation's name: your rename, else Rivet's title, else the titler's, else its first line. */
  conversationTitle(id: string): string | null {
    const row = this.db
      .prepare(
        `SELECT m.text, t.owner_title, t.title, t.ai_title FROM chat_messages m LEFT JOIN chat_threads t ON t.root_id = m.id WHERE m.id = ?`,
      )
      .get(id) as Row | undefined;
    if (!row) return null;
    return ((row.owner_title ?? row.title ?? row.ai_title) as string | null) ?? threadTitle(row.text as string);
  }

  /**
   * Your change to conversation `id`: a rename (null clears it), Close or reopen, your read marker, moved to the
   * time of `read` (a message of it; true for its newest) and never back, which also clears a marked unread; marked
   * unread or not; pinned or not. Rivet's `done` marks it done or not. False when nothing changed.
   */
  patchConversation(
    id: string,
    patch: { title?: string | null; closed?: boolean; read?: true | string; unread?: boolean; pinned?: boolean; done?: boolean },
    at: string,
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db
        .prepare("SELECT owner_title, read_at, closed_at, unread_at, pinned_at, done_at, swept_at FROM chat_threads WHERE root_id = ?")
        .get(id) as Row | undefined;
      const was = (key: string) => ((current?.[key] as string | null | undefined) ?? null);
      const flag = (key: string, set: boolean | undefined) => (set === undefined ? was(key) : set ? (was(key) ?? at) : null);
      const title = patch.title !== undefined ? patch.title : was("owner_title");
      // Pinning it or marking it unread brings it back to the list; closing it puts both away.
      const closedAt = patch.closed !== undefined ? (patch.closed ? at : null) : patch.unread || patch.pinned ? null : was("closed_at");
      let readAt = was("read_at");
      let unreadAt = patch.closed ? null : flag("unread_at", patch.unread);
      if (patch.read !== undefined) {
        const read = (
          patch.read === true
            ? this.db.prepare("SELECT MAX(at) AS at FROM chat_messages WHERE COALESCE(thread_id, id) = ?").get(id)
            : this.db.prepare("SELECT at FROM chat_messages WHERE id = ? AND COALESCE(thread_id, id) = ?").get(patch.read, id)
        ) as Row | undefined;
        if (!read?.at) throw new RangeError("that message is not in this conversation");
        if (readAt === null || (read.at as string) > readAt) readAt = read.at as string;
        unreadAt = null;
      }
      const pinnedAt = patch.closed ? null : flag("pinned_at", patch.pinned);
      const doneAt = patch.done === undefined ? was("done_at") : patch.done ? at : null;
      // Reopen also brings back pre-cutover rows that were never explicitly closed. Its marker keeps them listed two
      // hours (the idle rule counts it as a message), as does pinning or marking a closed one unread.
      const newest = (this.db.prepare("SELECT MAX(at) AS at FROM chat_messages WHERE COALESCE(thread_id, id) = ?").get(id) as Row | undefined)?.at as
        | string
        | null
        | undefined;
      const wasClosed = was("closed_at") !== null && (newest == null || was("closed_at")! >= newest);
      const sweptAt = patch.closed === false || (wasClosed && closedAt === null) ? at : was("swept_at");
      const next: Record<string, string | null> = {
        owner_title: title,
        read_at: readAt,
        closed_at: closedAt,
        unread_at: unreadAt,
        pinned_at: pinnedAt,
        done_at: doneAt,
        swept_at: sweptAt,
      };
      const changed = Object.entries(next).some(([key, value]) => value !== was(key));
      if (changed) {
        this.db
          .prepare(
            `INSERT INTO chat_threads (root_id, owner_title, read_at, closed_at, unread_at, pinned_at, done_at, swept_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (root_id) DO UPDATE SET owner_title = excluded.owner_title, read_at = excluded.read_at, closed_at = excluded.closed_at,
               unread_at = excluded.unread_at, pinned_at = excluded.pinned_at, done_at = excluded.done_at, swept_at = excluded.swept_at,
               updated_at = excluded.updated_at`,
          )
          .run(id, title, readAt, closedAt, unreadAt, pinnedAt, doneAt, sweptAt, at);
      }
      this.db.exec("COMMIT");
      return changed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Marks each conversation read up to its newest message and clears its marked unread; the ones that changed. */
  readAll(ids: readonly string[], at: string): string[] {
    const changed: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const newest = this.db.prepare("SELECT MAX(at) AS at FROM chat_messages WHERE COALESCE(thread_id, id) = ?");
      const current = this.db.prepare("SELECT read_at, unread_at FROM chat_threads WHERE root_id = ?");
      const write = this.db.prepare(
        `INSERT INTO chat_threads (root_id, read_at, unread_at, updated_at) VALUES (?, ?, NULL, ?)
         ON CONFLICT (root_id) DO UPDATE SET read_at = excluded.read_at, unread_at = NULL, updated_at = excluded.updated_at`,
      );
      for (const id of ids) {
        const last = (newest.get(id) as Row | undefined)?.at as string | null | undefined;
        if (!last) continue;
        const row = current.get(id) as Row | undefined;
        const readAt = (row?.read_at as string | null | undefined) ?? null;
        const next = readAt !== null && readAt >= last ? readAt : last;
        if (next === readAt && ((row?.unread_at as string | null | undefined) ?? null) === null) continue;
        write.run(id, next, at);
        changed.push(id);
      }
      this.db.exec("COMMIT");
      return changed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Records the PRs each conversation links now (`owner/repo#n`); a link once made stays, up to
   * CONVERSATION_PRS_KEPT a conversation, the oldest no longer linked going first.
   */
  rememberConversationPrs(links: ReadonlyMap<string, readonly string[]>): void {
    const write = this.db.prepare("INSERT OR IGNORE INTO conversation_prs (thread, pr) VALUES (?, ?)");
    // Its current links, then the newest of the rest up to the cap.
    const trim = this.db.prepare(
      `DELETE FROM conversation_prs WHERE thread = ? AND pr NOT IN (SELECT value FROM json_each(?))
         AND rowid NOT IN (SELECT rowid FROM conversation_prs WHERE thread = ? AND pr NOT IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC LIMIT ?)`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [thread, prs] of links) {
        let added = false;
        for (const pr of prs) added = Number(write.run(thread, pr).changes) > 0 || added;
        const current = JSON.stringify(prs);
        if (added) trim.run(thread, current, thread, current, Math.max(0, CONVERSATION_PRS_KEPT - new Set(prs.map((pr) => pr.toLowerCase())).size));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Every PR each conversation ever linked, by conversation. */
  conversationPrs(): Map<string, string[]> {
    const found = new Map<string, string[]>();
    for (const row of this.db.prepare("SELECT thread, pr FROM conversation_prs ORDER BY rowid").all() as Row[]) {
      const list = found.get(row.thread as string) ?? [];
      list.push(row.pr as string);
      found.set(row.thread as string, list);
    }
    return found;
  }

  /** The stage last recorded for each PR key asked for (`owner/repo#n`, lower case). */
  prStages(keys: readonly string[]): Map<string, string> {
    const found = new Map<string, string>();
    const read = this.db.prepare("SELECT stage FROM pr_stages WHERE pr = ?");
    for (const key of new Set(keys)) {
      const row = read.get(key) as Row | undefined;
      if (row) found.set(key, row.stage as string);
    }
    return found;
  }

  /** Records each PR's stage as GitHub shows it now; writes only what changed. */
  rememberPrStages(stages: ReadonlyMap<string, string>, at: string): void {
    if (!stages.size) return;
    const write = this.db.prepare(
      "INSERT INTO pr_stages (pr, stage, at) VALUES (?, ?, ?) ON CONFLICT (pr) DO UPDATE SET stage = excluded.stage, at = excluded.at WHERE pr_stages.stage <> excluded.stage",
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [key, stage] of stages) write.run(key, stage, at);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Records one alert of `kind` at `at` unless `limit` were already recorded in the `windowMs` before it, and forgets
   * older ones. In the database, so a restart keeps the count; only the alert routes write here.
   */
  takeAlert(kind: string, at: Date, limit: number, windowMs: number): boolean {
    const since = new Date(at.getTime() - windowMs).toISOString();
    this.db.prepare("DELETE FROM alerts WHERE kind = ? AND at <= ?").run(kind, since);
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind = ?").get(kind) as { n: number };
    if (Number(row.n) >= limit) return false;
    this.db.prepare("INSERT INTO alerts (kind, at) VALUES (?, ?)").run(kind, at.toISOString());
    return true;
  }

  /** What a reply to `id` shows of it; null for an id that is no chat message. */
  quoteOf(id: string): ChatQuote | null {
    const message = this.getChatMessage(id);
    return message ? { from: message.from, text: quoteText(message) } : null;
  }

  getChatMessage(id: string): ChatMessage | null {
    const row = this.db
      .prepare(`${MESSAGE_SELECT} WHERE m.id = ?`)
      .get(id) as Row | undefined;
    return row ? toMessage(row) : null;
  }

  /**
   * Newest first, `limit` at a time, older than the message `before`. A seed root (SEED_IDS) is a heading, not a message,
   * and the Team room's traffic is no news for the desktop strip's dot. With `chat`, the Chat tab's one conversation
   * (2026-10-11): no Updates and no card answers, and in a thing nothing after its first card's line, which stays as
   * the way to its page, but your typed lines and Rivet's lines and cards that answer one (2026-10-12).
   */
  listChat(before: string | null, limit: number, chat = false): ChatPage {
    const cursor = before === null ? null : (this.db.prepare("SELECT seq FROM chat_messages WHERE id = ?").get(before) as Row | undefined);
    if (before !== null && !cursor) return { messages: [], older: null };
    const chatOnly = chat
      ? ` AND COALESCE(m.thread_id, m.id) != ?
         AND (m.sender = 'owner'
           OR EXISTS (SELECT 1 FROM chat_messages q WHERE q.id = m.reply_to AND q.sender = 'owner'
             AND NOT (q.media IS NOT NULL AND json_extract(q.media, '$.card') IS NOT NULL))
           OR NOT EXISTS (SELECT 1 FROM card_conversations c JOIN chat_messages p ON p.id = c.posted
             WHERE c.via <> 'say' AND COALESCE(p.thread_id, p.id) = COALESCE(m.thread_id, m.id) AND p.seq < m.seq))`
      : "";
    const rows = this.db
      .prepare(
        `${MESSAGE_SELECT} WHERE m.seq < ? AND m.id NOT IN (${SEED_IDS.map(() => "?").join(", ")}) AND COALESCE(m.thread_id, m.id) != ?${chatOnly} ORDER BY m.seq DESC LIMIT ?`,
      )
      .all(cursor ? (cursor.seq as number) : Number.MAX_SAFE_INTEGER, ...SEED_IDS, TEAM_ROOM_ID, ...(chat ? [UPDATES_ID] : []), limit + 1) as Row[];
    const messages = rows.slice(0, limit).map(toMessage).reverse();
    return { messages, older: rows.length > limit ? messages[0]!.id : null };
  }

  /** Rivet answered: the message it names, or every line typed so far when it names none; each with its whole window. */
  /**
   * Sets Rivet's ack on the newest of your messages in `replyTo`'s window, replacing an earlier one. The message
   * acked; null when `replyTo` is none of your.
   */
  setAck(replyTo: string, text: string, at: string): string | null {
    const id = this.batchIds(this.leadOf(replyTo)).at(-1)!;
    const changed = this.db.prepare("UPDATE chat_messages SET ack = ? WHERE id = ? AND sender = 'owner'").run(JSON.stringify({ text, at }), id).changes;
    return changed ? id : null;
  }

  markReplied(replyTo: string | undefined, at: string): string[] {
    const ids = replyTo
      ? [this.leadOf(replyTo)]
      : (
          this.db.prepare("SELECT DISTINCT COALESCE(batch_id, id) AS lead FROM audit WHERE kind = 'chat' AND status IN ('typed', 'unconfirmed')").all() as Row[]
        ).map((row) => row.lead as string);
    const changed: string[] = [];
    for (const id of ids) {
      const entry = this.getAction(id);
      if (!entry || entry.kind !== "chat" || FINAL_STATUSES.has(entry.status)) continue;
      this.db.prepare("UPDATE audit SET status = 'replied', updated_at = ? WHERE id = ? OR batch_id = ?").run(at, id, id);
      changed.push(...this.batchIds(id));
    }
    return changed;
  }

  /** Case-insensitive substring search over both sides of the chat, newest first, with each one's conversation; a seed heading is no message. */
  searchChat(query: string, limit: number): { id: string; from: ChatMessage["from"]; text: string; at: string; thread: string }[] {
    const needle = query.trim();
    if (!needle) return [];
    // Stored text keeps the old name; "Rivet Ops" finds a "Rivet Ops" title (names.ts searchNeedles).
    const [pattern, old] = searchNeedles(needle).map((words) => `%${words.replace(/[\\%_]/g, (char) => `\\${char}`)}%`) as [string, string];
    return (
      this.db
        .prepare(
          `SELECT id, sender, text, at, COALESCE(thread_id, id) AS thread FROM chat_messages
            WHERE (text LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\') AND id NOT IN (${SEED_IDS.map(() => "?").join(", ")}) ORDER BY seq DESC LIMIT ?`,
        )
        .all(pattern, old, ...SEED_IDS, limit) as Row[]
    ).map((row) => ({ id: row.id as string, from: row.sender as ChatMessage["from"], text: row.text as string, at: row.at as string, thread: row.thread as string }));
  }

  /** Conversations whose title (your, else Rivet's, else the titler's) has `query` in it, case-insensitive, newest first. */
  searchTitles(query: string, limit: number): { id: string; title: string; at: string }[] {
    const needle = query.trim();
    if (!needle) return [];
    // Stored text keeps the old name; "Rivet Ops" finds a "Rivet Ops" title (names.ts searchNeedles).
    const [pattern, old] = searchNeedles(needle).map((words) => `%${words.replace(/[\\%_]/g, (char) => `\\${char}`)}%`) as [string, string];
    return (
      this.db
        .prepare(
          `SELECT t.root_id AS id, COALESCE(t.owner_title, t.title, t.ai_title) AS title, MAX(m.at) AS at FROM chat_threads t
             JOIN chat_messages m ON COALESCE(m.thread_id, m.id) = t.root_id
            WHERE (COALESCE(t.owner_title, t.title, t.ai_title) LIKE ? ESCAPE '\\' OR COALESCE(t.owner_title, t.title, t.ai_title) LIKE ? ESCAPE '\\') GROUP BY t.root_id ORDER BY MAX(m.seq) DESC LIMIT ?`,
        )
        .all(pattern, old, limit) as Row[]
    ).map((row) => ({ id: row.id as string, title: row.title as string, at: row.at as string }));
  }

  putMedia(sha: string, type: MediaType | FileType, size: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO media (sha, type, size, created_at, last_used) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (sha) DO UPDATE SET last_used = excluded.last_used`,
      )
      .run(sha, type, size, new Date(now).toISOString(), now);
  }

  getMedia(sha: string): { sha: string; type: MediaType | FileType; size: number } | null {
    const row = this.db.prepare("SELECT sha, type, size FROM media WHERE sha = ?").get(sha) as Row | undefined;
    return row ? { sha: row.sha as string, type: row.type as MediaType | FileType, size: row.size as number } : null;
  }

  touchMedia(sha: string, now: number): void {
    this.db.prepare("UPDATE media SET last_used = ? WHERE sha = ?").run(now, sha);
  }

  mediaBytes(): number {
    return Number((this.db.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM media").get() as Row).total);
  }

  /**
   * In eviction order: files Media does not record, least recently used first; then Media's, the longest ago sent
   * first (a file sent again counts from its latest sending; a poster goes with its video).
   */
  mediaByAge(): { sha: string; size: number; lastUsed: number }[] {
    return (
      this.db
        .prepare(
          `WITH sent AS (
             SELECT sha, MAX(at) AS at FROM (SELECT sha, at FROM media_seen UNION ALL SELECT poster, at FROM media_seen WHERE poster IS NOT NULL) GROUP BY sha
           )
           SELECT m.sha, m.size, m.last_used FROM media m LEFT JOIN sent ON sent.sha = m.sha
           ORDER BY sent.at IS NOT NULL, sent.at, m.last_used, m.created_at`,
        )
        .all() as Row[]
    ).map((row) => ({
      sha: row.sha as string,
      size: row.size as number,
      lastUsed: row.last_used as number,
    }));
  }

  /** Drops the file's row and its Media records with it. */
  deleteMedia(sha: string): void {
    this.db.prepare("DELETE FROM media WHERE sha = ?").run(sha);
    this.db.prepare("DELETE FROM media_seen WHERE sha = ?").run(sha);
    this.db.prepare("UPDATE media_seen SET poster = NULL WHERE poster = ?").run(sha);
  }

  /** One Media record, only for a file the store holds; a file's oldest records past MEDIA_SEEN_PER_SHA go. */
  private recordSeen(row: { sha: string; kind: "image" | "video"; poster?: string | null; source: MediaSource; ref: string; title?: string; conversation?: string; at: string }): void {
    const added = this.db
      .prepare(`INSERT OR IGNORE INTO media_seen (sha, kind, poster, source, ref, title, conversation, at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${STORED}`)
      .run(row.sha, row.kind, row.poster ?? null, row.source, row.ref, row.title ?? null, row.conversation ?? null, row.at, row.sha);
    if (!added.changes) return;
    this.db
      .prepare(`DELETE FROM media_seen WHERE sha = ? AND seq NOT IN (SELECT seq FROM media_seen WHERE sha = ? ORDER BY at DESC, seq DESC LIMIT ${MEDIA_SEEN_PER_SHA})`)
      .run(row.sha, row.sha);
  }

  /**
   * Records the photos and videos (not sounds or documents) each card names, as of `at`; a card's media already
   * recorded keep their first time and title. `stored`: the board the app starts with, whose files date from their
   * upload (never later than `at`), as the time they were first shown is not known.
   */
  recordCards(needs: readonly Need[], at: string, stored = false): void {
    const created = this.db.prepare("SELECT created_at FROM media WHERE sha = ?");
    for (const need of needs) {
      const media = need.media;
      if (!media) continue;
      for (const ref of [media.before, media.after, ...(media.stills ?? [])]) {
        if (!ref) continue;
        const video = ref.type.startsWith("video/");
        const upload = stored ? ((created.get(ref.sha256) as Row | undefined)?.created_at as string | undefined) : undefined;
        this.recordSeen({
          sha: ref.sha256,
          kind: video ? "video" : "image",
          poster: video ? (media.poster?.sha256 ?? null) : null,
          source: "card",
          ref: need.id,
          title: need.title,
          at: upload !== undefined && upload < at ? upload : at,
        });
      }
    }
  }

  /**
   * Once: every photo and video the store still holds from before the record that is neither recorded nor your own
   * upload (on his answers, chat requests or answer messages), as an Earlier card from its upload. Run after the
   * board's cards are recorded, so those keep their titles. Needs Store's `replies` table, in the same file.
   */
  recordEarlier(): void {
    if (this.db.prepare("SELECT 1 FROM meta WHERE key = ?").get(EARLIER_KEY)) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `WITH mine AS (
             SELECT image AS sha FROM replies WHERE image IS NOT NULL
             UNION SELECT one.value FROM replies, json_each(replies.images) AS one
             UNION SELECT json_extract(request, '$.image') FROM audit WHERE json_extract(request, '$.image') IS NOT NULL
             UNION SELECT one.value FROM audit, json_each(audit.request, '$.images') AS one
             UNION SELECT one.value FROM chat_messages c, json_each(c.media, '$.images') AS one WHERE c.sender = 'owner'
           )
           INSERT OR IGNORE INTO media_seen (sha, kind, source, ref, title, at)
           SELECT m.sha, CASE WHEN m.type LIKE 'video/%' THEN 'video' ELSE 'image' END, 'card', ? || m.sha, ?, m.created_at FROM media m
           WHERE m.type IN ('image/jpeg', 'image/png', 'video/mp4', 'video/webm')
             AND NOT EXISTS (SELECT 1 FROM media_seen s WHERE s.sha = m.sha OR s.poster = m.sha)
             AND m.sha NOT IN (SELECT sha FROM mine WHERE sha IS NOT NULL)
           ORDER BY m.created_at`,
        )
        .run(EARLIER_REF, EARLIER_TITLE);
      this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(EARLIER_KEY, new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Media's records whose file is still stored, newest first, after the `before` cursor; one more than `limit` says there are more. */
  mediaSeen(before: { at: string; seq: number } | null, limit: number): MediaSeenRow[] {
    return (
      this.db
        .prepare(
          `SELECT s.seq, s.sha, m.type, p.sha AS poster, s.source, s.ref, s.title, s.conversation, s.at
           FROM media_seen s JOIN media m ON m.sha = s.sha LEFT JOIN media p ON p.sha = s.poster
           WHERE m.type IN ('image/jpeg', 'image/png', 'video/mp4', 'video/webm') AND (? IS NULL OR s.at < ? OR (s.at = ? AND s.seq < ?))
           ORDER BY s.at DESC, s.seq DESC LIMIT ?`,
        )
        .all(before?.at ?? null, before?.at ?? null, before?.at ?? null, before?.seq ?? 0, limit + 1) as Row[]
    ).map((row) => ({
      seq: row.seq as number,
      sha: row.sha as string,
      type: row.type as MediaItemType,
      poster: (row.poster as string | null) ?? null,
      source: row.source as MediaSource,
      ref: row.ref as string,
      title: (row.title as string | null) ?? null,
      conversation: (row.conversation as string | null) ?? null,
      at: row.at as string,
    }));
  }
}

export interface MediaSeenRow {
  seq: number;
  sha: string;
  type: MediaItemType;
  poster: string | null;
  source: MediaSource;
  ref: string;
  title: string | null;
  conversation: string | null;
  at: string;
}
