import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { yesKey } from "../src/server/asks/waits.js";
import { CommandStore } from "../src/server/commandstore.js";
import { Store } from "../src/server/store.js";
import { NO_REPO } from "../src/shared/board.js";

const HOME = "example-org/example-repo";
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

describe("store migration", () => {
  it("adds replies.rev to a database written by the first deploy", () => {
    const dir = mkdtempSync(join(tmpdir(), "rivet-migrate-"));
    const old = new DatabaseSync(join(dir, "rivet.sqlite"));
    old.exec(`CREATE TABLE replies (id TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE, item_id TEXT NOT NULL,
      item_title TEXT NOT NULL, decision TEXT NOT NULL, choice TEXT, text TEXT, at TEXT NOT NULL, item TEXT NOT NULL,
      handled INTEGER NOT NULL DEFAULT 0, handled_at TEXT, delivered_at TEXT, delivery TEXT, github TEXT, error TEXT)`);
    old.close();
    const store = new Store(dir);
    store.close();
    const db = new DatabaseSync(join(dir, "rivet.sqlite"));
    const columns = (db.prepare("PRAGMA table_info(replies)").all() as { name: string }[]).map((c) => c.name);
    db.close();
    expect(columns).toContain("rev");
  });

  it("adds replies.images, and a reply stored with one image or file before it reads as it did", () => {
    const dir = mkdtempSync(join(tmpdir(), "rivet-migrate-"));
    const old = new DatabaseSync(join(dir, "rivet.sqlite"));
    old.exec(`CREATE TABLE replies (id TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE, item_id TEXT NOT NULL,
      item_title TEXT NOT NULL, decision TEXT NOT NULL, choice TEXT, text TEXT, rev TEXT NOT NULL DEFAULT '', at TEXT NOT NULL,
      item TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0, handled_at TEXT, delivered_at TEXT, delivery TEXT, github TEXT,
      error TEXT, image TEXT, files TEXT)`);
    const file = { sha256: "c".repeat(64), name: "Brief.pdf" };
    old
      .prepare("INSERT INTO replies (id, client_id, item_id, item_title, decision, rev, at, item, image, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("r-old", "client-old-1", "q", "Card q", "comment", "0123456789abcdef", "2026-09-30T00:00:00.000Z", JSON.stringify({ id: "q", title: "Card q", kind: "question" }), "a".repeat(64), JSON.stringify([file]));
    old.close();
    const store = new Store(dir);
    const reply = store.getReply("r-old")!;
    expect(reply).toMatchObject({ image: "a".repeat(64), files: [file] });
    expect(reply).not.toHaveProperty("images");
    const many = store.addReply({
      clientId: "client-new-1",
      itemId: "q",
      itemTitle: "Card q",
      decision: "comment",
      images: ["a".repeat(64), "b".repeat(64)],
      rev: "0123456789abcdef",
      item: { id: "q", title: "Card q", kind: "question" },
    });
    expect(store.getReply(many.id)).toMatchObject({ images: ["a".repeat(64), "b".repeat(64)] });
    expect(store.getReply(many.id)).not.toHaveProperty("image");
    store.close();
  });

  it("finds a thread's card answers by PR however many newer answers there are", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "rivet-store-")));
    const answer = (n: number, pr?: number, repo?: string) =>
      store.addReply({
        clientId: `client-pr-${n}`,
        itemId: `card-${n}`,
        itemTitle: "Card",
        decision: "approve",
        rev: "0123456789abcdef",
        item: { id: `card-${n}`, title: "Card", kind: "approval", ...(pr !== undefined ? { pr } : {}), ...(repo ? { repo } : {}) },
      });
    const ok = answer(0, 3287, HOME);
    const other = store.addReply({
      clientId: "client-other",
      itemId: "card-g",
      itemTitle: "Card",
      decision: "approve",
      rev: "0123456789abcdef",
      item: { id: "card-g", title: "Card", kind: "approval", pr: 12, repo: "example-org/other-repo" },
    });
    // Newer answers on other PRs, and on a repo-less #12, never crowd them out.
    for (let n = 1; n <= 520; n++) answer(n, n % 3 === 0 ? 12 : n % 2 ? 9000 + n : undefined);
    expect(store.listReplies({ limit: 500 }).some((reply) => reply.id === ok.id)).toBe(false);
    expect(store.repliesForPrs([{ repo: HOME, number: 3287 }, { repo: "example-org/other-repo", number: 12 }], 5).map((reply) => reply.id)).toEqual([other.id, ok.id]);
    expect(store.repliesForPrs([], 500)).toEqual([]);
    expect(store.repliesForPrs([{ repo: NO_REPO, number: 12 }], 500)).toHaveLength(173);
    // A thread naming 1,050 PRs (some twice) still reads, however many PRs its asks name.
    const many = Array.from({ length: 1_050 }, (_, n) => ({ repo: NO_REPO, number: 9001 + 2 * n }));
    expect(store.repliesForPrs([...many, ...many.slice(0, 10), { repo: HOME.toUpperCase(), number: 3287 }], 1_000)).toHaveLength(174);
    store.close();
  });

  it("finds a thread's card answers by its card, PRs and chats however many newer answers there are", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "rivet-store-")));
    const answer = (n: number, extra: Record<string, unknown> = {}) =>
      store.addReply({
        clientId: `client-link-${n}`,
        itemId: `card-${n}`,
        itemTitle: "Card",
        decision: "approve",
        rev: "0123456789abcdef",
        item: { id: `card-${n}`, title: "Card", kind: "approval", ...extra },
      });
    const named = answer(0);
    const pr = answer(1, { pr: 3287, repo: HOME });
    const chat = answer(2, { chat: "Docs-Sync-Pace" });
    answer(3, { chat: "docs-sync-pace", repo: "example-org/other-repo" });
    for (let n = 4; n <= 520; n++) answer(n, { pr: 9000 + n });
    const links = { ids: ["card-0"], prs: [{ repo: HOME, number: 3287 }], chats: [{ repo: NO_REPO, chat: "docs-sync-pace" }] };
    expect(store.repliesLinked(links, 500).map((reply) => reply.id)).toEqual([chat.id, pr.id, named.id]);
    expect(store.repliesLinked({ ids: [], prs: [], chats: [] }, 500)).toEqual([]);
    // A thread naming 1,050 PRs (some twice) and as many chats still reads, however long its links grow.
    const many = Array.from({ length: 1_050 }, (_, n) => ({ repo: NO_REPO, number: 9004 + n }));
    const wide = { ids: ["card-0"], prs: [...many, ...many.slice(0, 10), { repo: HOME.toUpperCase(), number: 3287 }], chats: many.map((pr) => ({ repo: NO_REPO, chat: `chat-${pr.number}` })) };
    expect(store.repliesLinked(wide, 500)).toHaveLength(500);
    expect(store.repliesLinked(wide, 1_000)).toHaveLength(519);
    store.close();
  });
});

describe("acted on", () => {
  it("counts an answer Rivet marked by hand before acted_at existed as acted on, and a delivered one as not yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "rivet-migrate-"));
    const old = new DatabaseSync(join(dir, "rivet.sqlite"));
    old.exec(`CREATE TABLE replies (id TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE, item_id TEXT NOT NULL,
      item_title TEXT NOT NULL, decision TEXT NOT NULL, choice TEXT, text TEXT, rev TEXT NOT NULL DEFAULT '', at TEXT NOT NULL,
      item TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0, handled_at TEXT, delivered_at TEXT, delivery TEXT, github TEXT,
      error TEXT, image TEXT, files TEXT, images TEXT)`);
    const insert = old.prepare("INSERT INTO replies (id, client_id, item_id, item_title, decision, at, item, handled, handled_at, delivered_at) VALUES (?, ?, 'q', 'Card q', 'approve', ?, '{}', ?, ?, ?)");
    insert.run("r-hand", "c-hand", "2026-10-01T00:00:00.000Z", 1, "2026-10-01T01:00:00.000Z", null);
    insert.run("r-sent", "c-sent", "2026-10-01T00:01:00.000Z", 1, "2026-10-01T00:02:00.000Z", "2026-10-01T00:02:00.000Z");
    insert.run("r-wait", "c-wait", "2026-10-01T00:03:00.000Z", 0, null, null);
    old.close();
    const store = new Store(dir);
    expect(store.getReply("r-hand")?.actedAt).toBe("2026-10-01T01:00:00.000Z");
    expect(store.getReply("r-sent")).not.toHaveProperty("actedAt");
    expect(store.listReplies({ acted: false, limit: 10 }).map((reply) => reply.id)).toEqual(["r-sent"]);
    store.close();
    // A second open migrates nothing again.
    const reopened = new Store(dir);
    expect(reopened.getReply("r-sent")).not.toHaveProperty("actedAt");
    reopened.close();
  });

  it("sets acted_at only when Rivet marks an answer handled, never on the bridge's ack, and lists the rest oldest first", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "rivet-acted-")));
    const add = (clientId: string) =>
      store.addReply({ clientId, itemId: "q", itemTitle: "Card q", decision: "approve", rev: "0123456789abcdef", item: { id: "q", title: "Card q", kind: "question" } });
    const first = add("client-acted-1");
    const second = add("client-acted-2");
    add("client-acted-3");
    const acked = store.applyAck({ id: first.id, delivery: { target: "rivet", at: new Date().toISOString() } })!;
    expect(acked.handled).toBe(true);
    expect(acked).not.toHaveProperty("actedAt");
    store.applyAck({ id: second.id, delivery: { target: "chat", chat: "pine", at: new Date().toISOString() } });
    expect(store.listReplies({ acted: false, limit: 10 }).map((reply) => reply.id)).toEqual([first.id, second.id]);
    const acted = store.markHandled(first.id)!;
    expect(acted.handledAt).toBe(acked.handledAt);
    expect(acted.actedAt! >= acked.handledAt!).toBe(true);
    expect(store.markHandled(first.id)?.actedAt).toBe(acted.actedAt);
    expect(store.listReplies({ acted: false, limit: 10 }).map((reply) => reply.id)).toEqual([second.id]);
    expect(store.listReplies({ acted: false, limit: 1 })).toHaveLength(1);
    store.close();
  });

  it("a cap on the acted-false list drops the oldest and still reads oldest first, with the true total", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "rivet-acted-")));
    const ids = ["client-cap-1", "client-cap-2", "client-cap-3"].map((clientId) => {
      const reply = store.addReply({ clientId, itemId: "q", itemTitle: "Card q", decision: "approve", rev: "0123456789abcdef", item: { id: "q", title: "Card q", kind: "question" } });
      store.applyAck({ id: reply.id, delivery: { target: "rivet", at: new Date().toISOString() } });
      return reply.id;
    });
    expect(store.listReplies({ acted: false, limit: 2 }).map((reply) => reply.id)).toEqual([ids[1], ids[2]]);
    expect(store.countUnactedReplies()).toBe(3);
    store.close();
  });

  it("a line with no proof it landed leaves the answer unhandled, and a later proof clears it", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "rivet-acted-")));
    const reply = store.addReply({ clientId: "client-unproved-1", itemId: "q", itemTitle: "Card q", decision: "approve", rev: "0123456789abcdef", item: { id: "q", title: "Card q", kind: "question" } });
    const at = new Date().toISOString();
    expect(store.applyAck({ id: reply.id, delivery: { target: "rivet", at, confirmed: false, unproved: true } })!.handled).toBe(false);
    expect(store.applyAck({ id: reply.id, delivery: { target: "rivet", at, confirmed: true } })!.handled).toBe(true);
  });

  it("a line reported lost leaves the answer unhandled and not replayed, and a later proof clears it", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "rivet-acted-")));
    const reply = store.addReply({ clientId: "client-lost-1", itemId: "q", itemTitle: "Card q", decision: "approve", rev: "0123456789abcdef", item: { id: "q", title: "Card q", kind: "question" } });
    const at = new Date().toISOString();
    const lost = store.applyAck({ id: reply.id, delivery: { target: "rivet", at, confirmed: false, lost: true } })!;
    expect(lost.handled).toBe(false);
    expect(lost).not.toHaveProperty("handledAt");
    expect(lost.delivery?.lost).toBe(true);
    expect(store.listReplies({ handled: false, limit: 10 }).map((r) => r.id)).toEqual([reply.id]);
    expect(store.listReplies({ acted: false, limit: 10 }).map((r) => r.id)).toEqual([reply.id]);
    expect(store.undeliveredReplies()).toEqual([]);
    const proved = store.applyAck({ id: reply.id, delivery: { target: "rivet", at, confirmed: true } })!;
    expect(proved.handled).toBe(true);
    expect(typeof proved.handledAt).toBe("string");
    store.close();
  });

  it("an unconfirmed delivery from a bridge without the proof still counts as handled", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "rivet-acted-")));
    const reply = store.addReply({ clientId: "client-old-1", itemId: "q", itemTitle: "Card q", decision: "approve", rev: "0123456789abcdef", item: { id: "q", title: "Card q", kind: "question" } });
    expect(store.applyAck({ id: reply.id, delivery: { target: "rivet", at: new Date().toISOString(), confirmed: false } })!.handled).toBe(true);
    store.close();
  });
});

describe("rate limit counts", () => {
  afterEach(() => vi.useRealTimers());

  it("survive reopening the database, so a restart does not refill an allowance", () => {
    const dir = mkdtempSync(join(tmpdir(), "rivet-rate-"));
    const first = new Store(dir);
    for (let i = 1; i <= 3; i++) expect(first.countHit("auth", "203.0.113.7", 60_000)).toBe(i);
    first.close();
    const reopened = new Store(dir);
    expect(reopened.countHit("auth", "203.0.113.7", 60_000)).toBe(4);
    expect(reopened.countHit("tts", "203.0.113.7", 60_000)).toBe(1);
    reopened.close();
  });

  it("start a fresh window once one ends, and prune every ended window", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
    const dir = mkdtempSync(join(tmpdir(), "rivet-rate-"));
    const store = new Store(dir);
    for (let i = 0; i < 50; i++) store.countHit("auth", `198.51.100.${i}`, 60_000);
    store.countHit("tts", "a".repeat(64), 10 * 60_000);
    vi.setSystemTime(new Date("2026-10-09T00:00:59.999Z"));
    expect(store.countHit("auth", "198.51.100.0", 60_000)).toBe(2);
    vi.setSystemTime(new Date("2026-10-09T00:01:00Z"));
    expect(store.countHit("auth", "198.51.100.0", 60_000)).toBe(1);
    store.close();
    const db = new DatabaseSync(join(dir, "rivet.sqlite"));
    const rows = db.prepare("SELECT scope, key FROM rate_hits ORDER BY scope").all();
    db.close();
    expect(rows).toEqual([
      { scope: "auth", key: "198.51.100.0" },
      { scope: "tts", key: "a".repeat(64) },
    ]);
  });
});

describe("wait yeses", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T00:00:00.000Z"));
    const dir = mkdtempSync(join(tmpdir(), "rivet-yeses-"));
    new CommandStore(dir).close();
    const store = new Store(dir);
    let n = 0;
    const answer = (itemId: string, kind: string, decision: "approve" | "choice" | "reject", choice?: string, pr = 2483) => {
      vi.setSystemTime(new Date(Date.parse("2026-10-29T00:00:00.000Z") + ++n * 60_000));
      const item = { id: itemId, title: "Daily build v2", kind, pr, repo: HOME };
      return store.addReply({ clientId: `client-${n}`, itemId, itemTitle: item.title, decision, ...(choice ? { choice } : {}), rev: "0123456789abcdef", item: item as never });
    };
    const close = () => store.close();
    return { store, answer, close };
  }
  const OK_KEY = yesKey("wait-ok-0123456789ab", HOME, 2483);

  it("a later answer other than Yes on a PR's Your OK ends every earlier yes for it", () => {
    const { store, answer, close } = setup();
    answer("wait-ok-0123456789ab-a", "decision", "choice", "Change it");
    expect(store.waitYeses().size).toBe(0);
    const ok = answer("wait-ok-0123456789ab-b", "decision", "choice", "Yes");
    expect([...store.waitYeses()]).toEqual([[OK_KEY, ok.at]]);
    answer("wait-ok-0123456789ab-c", "decision", "choice", "Change it", 2484);
    expect([...store.waitYeses()]).toEqual([[OK_KEY, ok.at]]);
    answer("wait-ok-0123456789ab-d", "decision", "choice", "Change it");
    expect(store.waitYeses().size).toBe(0);
    close();
  });
});
