import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommandStore } from "../src/server/commandstore.js";
import { UPDATES_ID } from "../src/shared/conversations.js";
import { allAsksByThread, askProject, asksByThread, cardThreads, statusFacts, threadLinks, threadSteps } from "../src/server/threads.js";
import type { Ask } from "../src/shared/asks.js";
import { NO_REPO, type Reply } from "../src/shared/board.js";
import type { ChatMessage } from "../src/shared/command.js";
import { loneNotice, namedPrs, statusText, threadListSchema, threadPatchSchema, threadStatus, threadTitle, type CardThreadsResponse, type PrRef, type ThreadDetail, type ThreadsResponse, type UntitledThread } from "../src/shared/threads.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, browser, fakeClock, REPLY_BOARD, revOf, startServer, type TestServer } from "./helpers.js";

// The linear-time guards below time CPU, not the wall clock: a loaded runner stalls a run until its CPU quota
// refills, while a quadratic or backtracking parse still costs the CPU it always did.
const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

const T0 = Date.UTC(2026, 9, 2, 1, 0, 0);
const iso = (offset: number) => new Date(T0 + offset).toISOString();

describe("thread store", () => {
  let dataDir: string;
  let store: CommandStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "rivet-threads-"));
    store = new CommandStore(dataDir);
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const owner = (id: string, offset: number, text: string, replyTo?: string) =>
    store.addChat({ id, clientId: `c-${id}`, request: { text, ...(replyTo ? { replyTo, quote: store.quoteOf(replyTo)! } : {}) }, at: iso(offset) }, T0 + offset);
  const rivet = (id: string, offset: number, text: string, replyTo?: string) => store.addChatMessage({ id, from: "rivet", text, at: iso(offset), replyTo });

  it("a message carries the server's insert order, so two stamped in one millisecond keep the order they came in", () => {
    rivet("z-parent", 0, "Parent card");
    rivet("a-answer", 0, "Its answer", "z-parent");
    const [parent, answer] = store.threadMessages("z-parent", 10).messages;
    expect([parent?.id, answer?.id]).toEqual(["z-parent", "a-answer"]);
    expect(parent!.at).toBe(answer!.at);
    expect(answer!.seq).toBeGreaterThan(parent!.seq!);
    expect(store.getChatMessage("a-answer")?.seq).toBe(answer!.seq);
  });

  it("a message starts a thread; its window's follow-ups, answers to any of them and replies to those stack under it", () => {
    owner("c1", 0, "Make the Chat tab threaded\nwith views");
    owner("c2", 2_000, "and phone first");
    rivet("h1", 60_000, "On it.", "c2");
    owner("c3", 120_000, "Also an inbox", "h1");
    rivet("h2", 180_000, "Merged #300.");
    rivet("h3", 200_000, "Hm.", "a-card-reply");
    expect(["c1", "c2", "h1", "c3"].map((id) => store.threadOf(id))).toEqual(["c1", "c1", "c1", "c1"]);
    expect(store.threadOf("h2")).toBe("h2");
    expect(store.threadOf("h3")).toBe("h3");
    expect(store.getChatMessage("c3")).toMatchObject({ threadId: "c1" });
    const rows = store.threadRows();
    expect(rows.map((row) => row.id)).toEqual(["h3", "h2", "c1"]);
    expect(rows[2]).toMatchObject({ count: 4, rootFrom: "owner", rootText: "Make the Chat tab threaded\nwith views", lastFrom: "owner", lastText: "Also an inbox", lastOwnerAt: iso(120_000) });
    expect(rows[0]).toMatchObject({ rootReplyTo: "a-card-reply", lastOwnerAt: null });
    expect(store.threadMessages("c1", 3)).toMatchObject({ more: true, messages: [{ id: "c2" }, { id: "h1" }, { id: "c3" }] });
  });

  it("Chat's timeline keeps card answers and, in a thing, leaves out everything after the line that put its first card there", () => {
    owner("c1", 0, "Make the results row bigger");
    rivet("h1", 1_000, "On it.", "c1");
    store.addChatMessage({ id: "p1", from: "rivet", text: "Card: Plan", at: iso(2_000), thread: "c1", posted: { id: "K", kind: "plan", title: "Plan: results row" } });
    store.fileCard({ card: "K", thread: "c1", via: "chat", stem: null, repo: null, pr: null, chat: null, at: iso(2_000) });
    store.setCardPosted("K", "p1");
    store.addChatMessage({ id: "a1", from: "owner", text: "Yes", at: iso(3_000), card: "K" });
    rivet("h2", 4_000, "Building now.", "p1");
    owner("c2", 3_600_000, "Separate question");
    expect(store.listChat(null, 30).messages.map((message) => message.id)).toEqual(["c1", "h1", "p1", "a1", "h2", "c2"]);
    expect(store.listChat(null, 30, true).messages.map((message) => message.id)).toEqual(["c1", "h1", "p1", "a1", "c2"]);
    // A card a message only mentions (say) files nothing: the conversation stays Chat's.
    store.fileCard({ card: "S", thread: "c2", via: "say", stem: null, repo: null, pr: null, chat: null, at: iso(3_601_000) });
    rivet("h3", 3_602_000, "Answered.", "c2");
    expect(store.listChat(null, 30, true).messages.map((message) => message.id)).toEqual(["c1", "h1", "p1", "a1", "c2", "h3"]);
  });

  it("Chat keeps every line you type in a thing, and Rivet's replies and cards to those lines (2026-10-12)", () => {
    owner("c1", 0, "Top 10 chart libraries research");
    store.addChatMessage({ id: "p1", from: "rivet", text: "Card: Findings", at: iso(1_000), thread: "c1", posted: { id: "F", kind: "decision", title: "Chart research findings" } });
    store.fileCard({ card: "F", thread: "c1", via: "chat", stem: null, repo: null, pr: null, chat: null, at: iso(1_000) });
    store.setCardPosted("F", "p1");
    store.addChatMessage({ id: "a1", from: "owner", text: "Dismissed", at: iso(2_000), card: "F" });
    store.addChatMessage({ id: "h0", from: "rivet", text: "Research agent is idle now.", at: iso(3_000), thread: "c1" });
    // Typed on the thing's page after the Dismiss: no reply, so it lands in the thing.
    const typed = (id: string, offset: number, text: string) =>
      store.addChat({ id, clientId: `c-${id}`, request: { text, conversation: "c1" }, at: iso(offset) }, T0 + offset);
    typed("c2", 60_000, "Settings: make the buttons bigger");
    typed("c3", 61_000, "and the logo wheel");
    rivet("h1", 120_000, "On it, a plan card next.", "c2");
    store.addChatMessage({ id: "p2", from: "rivet", text: "Card: Plan", at: iso(180_000), thread: "c1", replyTo: "c2", posted: { id: "G", kind: "plan", title: "Plan: goblets and logo wheel" } });
    store.fileCard({ card: "G", thread: "c1", via: "chat", stem: null, repo: null, pr: null, chat: null, at: iso(180_000) });
    store.setCardPosted("G", "p2");
    expect(["c2", "c3", "p2"].map((id) => store.threadOf(id))).toEqual(["c1", "c1", "c1"]);
    const ids = store.listChat(null, 30, true).messages.map((message) => message.id);
    expect(ids).toEqual(["c1", "p1", "a1", "c2", "c3", "h1", "p2"]);
  });

  it("reads the thread list again only once a message, a thread's settings or an action changes, whichever connection writes", () => {
    rivet("h1", 0, "One");
    const first = store.threadRows();
    expect(store.threadRows()).toBe(first);
    expect(Object.isFrozen(first[0])).toBe(true);
    rivet("h2", 1_000, "Two");
    const second = store.threadRows();
    expect(second.map((row) => row.id)).toEqual(["h2", "h1"]);
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(join(dataDir, "rivet.sqlite"));
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("INSERT INTO chat_threads (root_id, title, updated_at) VALUES ('h1', 'Named', ?)").run(iso(2_000));
    const named = store.threadRows();
    expect(named).not.toBe(second);
    expect(named.find((row) => row.id === "h1")).toMatchObject({ title: "Named" });
    db.prepare("UPDATE chat_threads SET title = 'Renamed' WHERE root_id = 'h1'").run();
    expect(store.threadRows().find((row) => row.id === "h1")).toMatchObject({ title: "Renamed" });
    const renamed = store.threadRows();
    db.prepare("INSERT INTO audit (id, client_id, kind, at, updated_at, status, request) VALUES ('a1', 'c-a1', 'chat', ?, ?, 'queued', '{}')").run(iso(3_000), iso(3_000));
    expect(store.threadRows()).not.toBe(renamed);
    db.close();
  });

  it("reads every mention, only from threads active since the cutoff, each name once, fast at 50k", () => {
    rivet("cold", -8 * 86_400_000, "Cold #123");
    rivet("hot", 0, "Hot #123");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(join(dataDir, "rivet.sqlite"));
    db.exec("PRAGMA busy_timeout = 5000; BEGIN");
    const insert = db.prepare("INSERT INTO chat_messages (id, sender, text, at, thread_id) VALUES (?, 'rivet', ?, ?, ?)");
    for (let n = 0; n < 25_000; n++) {
      insert.run(`cold-${n}`, `Cold #123 again ${n}`, iso(-8 * 86_400_000 + n), "cold");
      insert.run(`hot-${n}`, `Hot #123 again ${n} build-2`, iso(n), "hot");
    }
    db.exec("COMMIT");
    db.close();
    const started = cpuMs();
    const said = store.threadMentions(["#"], { pr: (ref) => (ref.number === 123 ? ref : null), words: new Set(["build-2"]) }, iso(-7 * 86_400_000));
    expect(cpuMs() - started).toBeLessThan(1_000);
    expect([...said.keys()]).toEqual(["hot"]);
    expect(said.get("hot")).toEqual({ refs: [{ repo: null, number: 123 }], words: new Set(["build-2"]) });
  });

  it("keeps only the PRs and words asked about, wherever and however written, and reads one thread whatever its age", () => {
    rivet("long", -8 * 86_400_000, "Fix #39000");
    for (let n = 0; n < 1_500; n++) rivet(`long-${n}`, n, `#${40_000 + n} step ${n}`, "long");
    rivet("named", 2_000, "And #900, #07, owner/repo#901 and build-2-’s progress; check build-2", "long");
    const keep = { pr: (ref: PrRef) => ([900, 901, 7].includes(ref.number) ? ref : null), words: new Set(["build-2-", "build-2"]) };
    expect(store.threadMentions(["#", "build-2"], keep, iso(-7 * 86_400_000)).get("long")).toEqual({
      refs: [
        { repo: "owner/repo", number: 901 },
        { repo: null, number: 900 },
        { repo: null, number: 7 },
      ],
      words: new Set(["build-2-", "build-2"]),
    });
    const many = Array.from({ length: 1_000 }, (_, n) => String(10_000 + n));
    expect(store.threadMentions([...many, "900"], keep, iso(-7 * 86_400_000)).get("long")!.refs).toHaveLength(3);
    // References to the same number in other repos are not kept: what is kept stays bounded by what was asked.
    for (let n = 0; n < 500; n++) rivet(`repo-${n}`, 3_000 + n, `outsider/r${n}#901`, "long");
    const known = (ref: PrRef) => (ref.number === 901 && (ref.repo === null || ref.repo === "owner/repo") ? ref : null);
    expect(store.threadMentions(["#"], { pr: known, words: new Set() }, iso(-7 * 86_400_000)).get("long")!.refs).toEqual([{ repo: "owner/repo", number: 901 }]);
    // A caller may keep references alike to it as one: every repo's #901 as a bare #901.
    const bare = (ref: PrRef) => (ref.number === 901 ? { repo: null, number: 901 } : null);
    expect(store.threadMentions(["#"], { pr: bare, words: new Set() }, iso(-7 * 86_400_000)).get("long")!.refs).toEqual([{ repo: null, number: 901 }]);
    rivet("cold", -9 * 86_400_000, "Cold #77");
    expect([...store.threadMentions(["#"], { pr: (ref) => (ref.number === 77 ? ref : null), words: new Set() }, "", "cold").entries()]).toEqual([
      ["cold", { refs: [{ repo: null, number: 77 }], words: new Set() }],
    ]);
  });

  it("sets and clears a thread's title, status and project, records when the status was set, and skips a step it has", () => {
    owner("c1", 0, "Threads");
    expect(store.patchThread("c1", { status: "working", project: "rivet", steps: [{ kind: "pr", label: "PR #287", url: "https://github.com/x/y/pull/287" }] }, iso(1_000))).toBe(true);
    expect(store.patchThread("c1", { project: "rivet", steps: [{ kind: "pr", label: "PR #287", url: "https://github.com/x/y/pull/287" }] }, iso(2_000))).toBe(false);
    expect(store.threadRow("c1")).toMatchObject({ status: "working", statusAt: iso(1_000), project: "rivet", title: null });
    store.patchThread("c1", { title: "  Chat threads ", status: "shipped" }, iso(3_000));
    expect(store.threadRow("c1")).toMatchObject({ title: "Chat threads", status: "shipped", statusAt: iso(3_000) });
    expect(store.getChatMessage("c1")).toMatchObject({ project: "rivet" });
    store.patchThread("c1", { title: null, status: null, project: null, clearSteps: true }, iso(4_000));
    expect(store.threadRow("c1")).toMatchObject({ title: null, status: null, statusAt: null, project: null });
    expect(store.threadSteps("c1")).toEqual([]);
    expect(store.getChatMessage("c1")).not.toHaveProperty("project");
  });

  it("sets and clears a tag; the AI pass keeps its title and project apart and only fills a tag nobody set", () => {
    owner("c1", 0, "the night batch reels look blurry on my phone");
    owner("c2", 60_000, "Threads");
    store.patchThread("c1", { tag: "Night Batch" }, iso(1_000));
    expect(store.threadRow("c1")).toMatchObject({ tag: "Night Batch", aiTitle: null, aiTitledAt: null });
    store.setThreadAi("c1", { title: "Sharpen blurry reels", tag: "Reels", project: "work" }, iso(2_000));
    expect(store.threadRow("c1")).toMatchObject({ title: null, tag: "Night Batch", project: null, aiProject: "work", aiTitle: "Sharpen blurry reels", aiTitledAt: iso(2_000) });
    expect(store.getChatMessage("c1")?.project).toBeUndefined();
    // Rivet's later change leaves the AI's columns alone.
    store.patchThread("c1", { title: "Reels", project: "rivet", tag: null }, iso(3_000));
    expect(store.threadRow("c1")).toMatchObject({ title: "Reels", tag: null, project: "rivet", aiProject: "work", aiTitle: "Sharpen blurry reels", aiTitledAt: iso(2_000) });
    // A thread with no row gets one; a given-up pass records only when it ran.
    store.setThreadAi("c2", { title: null, tag: null, project: null }, iso(4_000));
    expect(store.threadRow("c2")).toMatchObject({ title: null, tag: null, project: null, status: null, aiTitle: null, aiTitledAt: iso(4_000) });
  });

  it("tags a thread you moved: a Move picks only the folder, so the AI pass still fills the tag line", () => {
    owner("c1", 0, "the night batch reels look blurry on my phone");
    store.patchThread("c1", { project: "work" }, iso(1_000), true);
    store.setThreadAi("c1", { title: "Sharpen blurry reels", tag: "Night Batch", project: "personal" }, iso(2_000));
    expect(store.threadRow("c1")).toMatchObject({ project: "work", tag: "Night Batch", aiProject: "personal" });
  });

  it("adds the tag and AI columns to a database from before them, keeping every thread's settings", () => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const old = new DatabaseSync(join(dataDir, "rivet.sqlite"));
    old.exec(`CREATE TABLE chat_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, sender TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL,
        reply_to TEXT, quote_from TEXT, quote_text TEXT, thread_id TEXT);
      CREATE TABLE chat_threads (root_id TEXT PRIMARY KEY, title TEXT, status TEXT, status_at TEXT, project TEXT, updated_at TEXT NOT NULL);
      INSERT INTO chat_messages (id, sender, text, at, thread_id) VALUES ('c1', 'owner', 'one', '${iso(0)}', 'c1');
      INSERT INTO chat_threads (root_id, title, status, status_at, project, updated_at) VALUES ('c1', 'Kept', 'shipped', '${iso(1)}', 'work', '${iso(1)}');`);
    old.close();
    store = new CommandStore(dataDir);
    expect(store.threadRow("c1")).toMatchObject({ title: "Kept", status: "shipped", project: "work", tag: null, aiTitle: null, aiTitledAt: null, aiProject: null });
    store.setThreadAi("c1", { title: "One", tag: "Docs Sync", project: null }, iso(2));
    expect(store.threadRow("c1")).toMatchObject({ title: "Kept", status: "shipped", project: "work", tag: "Docs Sync", aiTitle: "One" });
  });

  it("refuses steps past 50 and keeps none of that change", () => {
    owner("c1", 0, "Threads");
    const steps = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ kind: "chat" as const, label: `step ${from + i}` }));
    store.patchThread("c1", { steps: steps(0, 49) }, iso(1));
    expect(() => store.patchThread("c1", { status: "shipped", steps: steps(49, 2) }, iso(2))).toThrow(RangeError);
    expect(store.threadSteps("c1")).toHaveLength(49);
    expect(store.threadRow("c1")?.status).toBeNull();
  });

  it("gives every message from before threads its thread, and keeps every message", () => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const old = new DatabaseSync(join(dataDir, "rivet.sqlite"));
    old.exec(`CREATE TABLE audit (id TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, at TEXT NOT NULL, updated_at TEXT NOT NULL,
        status TEXT NOT NULL, request TEXT NOT NULL, detail TEXT, batch_id TEXT, batch_first_at INTEGER, batch_last_at INTEGER);
      CREATE TABLE chat_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, sender TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL,
        reply_to TEXT, quote_from TEXT, quote_text TEXT);
      INSERT INTO audit (id, client_id, kind, at, updated_at, status, request, batch_id) VALUES
        ('c1', 'k1', 'chat', '${iso(0)}', '${iso(0)}', 'replied', '{"text":"one"}', 'c1'),
        ('c2', 'k2', 'chat', '${iso(1)}', '${iso(1)}', 'replied', '{"text":"two"}', 'c1'),
        ('c3', 'k3', 'chat', '${iso(4)}', '${iso(4)}', 'replied', '{"text":"three"}', 'c3'),
        ('c4', 'k4', 'chat', '${iso(6)}', '${iso(6)}', 'typed', '{"text":"four"}', 'c4');
      INSERT INTO chat_messages (id, sender, text, at, reply_to) VALUES
        ('c1', 'owner', 'one', '${iso(0)}', NULL),
        ('c2', 'owner', 'two', '${iso(1)}', NULL),
        ('h1', 'rivet', 'ok', '${iso(2)}', 'c2'),
        ('h2', 'rivet', 'note', '${iso(3)}', NULL),
        ('c3', 'owner', 'three', '${iso(4)}', 'h1'),
        ('h3', 'rivet', 'old', '${iso(5)}', 'gone'),
        ('c4', 'owner', 'four', '${iso(6)}', NULL);`);
    old.close();
    store = new CommandStore(dataDir);
    expect(["c1", "c2", "h1", "h2", "c3", "h3", "c4"].map((id) => store.threadOf(id))).toEqual(["c1", "c1", "c1", "h2", "c1", "h3", "c4"]);
    expect(store.listChat(null, 30).messages.map((message) => [message.id, message.text])).toEqual([
      ["c1", "one"],
      ["c2", "two"],
      ["h1", "ok"],
      ["h2", "note"],
      ["c3", "three"],
      ["h3", "old"],
      ["c4", "four"],
    ]);
    // Opening it again finds nothing left to fill.
    store.close();
    store = new CommandStore(dataDir);
    expect(store.threadRows().map((row) => [row.id, row.count])).toEqual([
      ["c4", 1],
      ["h3", 1],
      ["c1", 4],
      ["h2", 1],
    ]);
  });
});

describe("thread status and steps", () => {
  const now = new Date(T0);
  const ask = (fields: Partial<Ask>): Ask => ({
    id: "a-1",
    words: "w",
    who: "owner",
    stage: "building",
    prs: [],
    dueHistory: [],
    timeline: [],
    createdAt: iso(-3_600_000),
    stageAt: iso(-3_600_000),
    updatedAt: iso(-3_600_000),
    version: 1,
    ...fields,
  });

  it("titles a thread by its first line, or by what it carried", () => {
    expect(threadTitle("\n  Make it threaded  \nmore")).toBe("Make it threaded");
    expect(threadTitle("", { images: 2 })).toBe("Photos");
    expect(threadTitle("", { files: 1 })).toBe("Document");
    expect(threadTitle("x".repeat(200))).toHaveLength(120);
  });

  it("takes the newer of Rivet's status and the ask's; you writing after it hands the ball back", () => {
    const base = { lastOwnerAt: iso(-7_200_000) };
    expect(threadStatus({ ...base, set: { status: "shipped", at: iso(-60_000) } })).toEqual({ status: "shipped", from: "set" });
    expect(threadStatus({ ...base, set: { status: "shipped", at: iso(-120_000) }, ask: { status: "needs-you", at: iso(-60_000) } })).toEqual({ status: "needs-you", from: "ask" });
    // You answering takes it off Needs you; it is Working again only while the ask is open.
    expect(threadStatus({ ...base, lastOwnerAt: iso(-1_000), set: { status: "needs-you", at: iso(-60_000) } })).toEqual({ status: null, from: null });
    expect(threadStatus({ ...base, lastOwnerAt: iso(-1_000), set: { status: "needs-you", at: iso(-60_000) }, ask: { status: "working", at: iso(-120_000) } })).toEqual({
      status: "working",
      from: "ask",
    });
    expect(threadStatus({ ...base, lastOwnerAt: null })).toEqual({ status: null, from: null });
  });

  it("counts Working only on an open chat, an open PR or an open ask, never on you writing lately or Rivet's say-so", () => {
    const lately = { lastOwnerAt: iso(-1_000) };
    expect(threadStatus(lately)).toEqual({ status: null, from: null });
    expect(threadStatus({ ...lately, set: { status: "working", at: iso(-60_000) } })).toEqual({ status: null, from: null });
    expect(threadStatus({ ...lately, set: { status: "working", at: iso(-60_000) }, ask: { status: "working", at: iso(-120_000) } })).toEqual({ status: "working", from: "ask" });
    expect(threadStatus({ ...lately, ask: { status: "working", at: iso(-60_000) } })).toEqual({ status: "working", from: "ask" });
    expect(threadStatus({ ...lately, chat: "notes-build" })).toEqual({ status: "working", from: "chat", chat: "notes-build" });
    expect(threadStatus({ ...lately, openPr: 3412 })).toEqual({ status: "working", from: "pr", pr: 3412 });
    // Needs you and Done are as they were.
    expect(threadStatus({ lastOwnerAt: null, question: iso(-60_000) })).toEqual({ status: "needs-you", from: "question" });
    expect(threadStatus({ lastOwnerAt: iso(-120_000), merged: { pr: 7, at: iso(-60_000) } })).toEqual({ status: "shipped", from: "merged", pr: 7 });
  });

  it("calls a merge live only when the live mark is no older than the newest merge", () => {
    const base = { lastOwnerAt: iso(-7_200_000) };
    const later = threadStatus({ ...base, merged: { pr: 101, at: iso(-60_000) }, shippedAt: iso(-600_000) });
    expect(later).toEqual({ status: "shipped", from: "merged", pr: 101 });
    expect(statusText({ status: later.status, statusFrom: later.from, statusPr: later.pr })).toBe("Done, PR #101 merged");
    const shipped = threadStatus({ ...base, merged: { pr: 101, at: iso(-600_000) }, shippedAt: iso(-60_000) });
    expect(statusText({ status: shipped.status, statusFrom: shipped.from, statusPr: shipped.pr })).toBe("Done, PR #101 merged and deployed");
  });

  it("links an ask by a message in the thread or by what its first message answers, the latest change winning", () => {
    const rows = [{ id: "t1", rootReplyTo: null }, { id: "t2", rootReplyTo: "card-reply-9" }];
    const threadOf = (id: string) => (id === "m1" || id === "t1" ? "t1" : null);
    const linked = asksByThread(
      [ask({ id: "a-1", replyId: "m1", updatedAt: iso(1) }), ask({ id: "a-2", replyId: "t1", updatedAt: iso(2) }), ask({ id: "a-3", replyId: "card-reply-9" }), ask({ id: "a-4" })],
      rows,
      threadOf,
    );
    expect([...linked].map(([thread, linkedAsk]) => [thread, linkedAsk.id])).toEqual([
      ["t1", "a-2"],
      ["t2", "a-3"],
    ]);
    expect([...allAsksByThread([ask({ id: "a-1", replyId: "m1", updatedAt: iso(1) }), ask({ id: "a-2", replyId: "t1", updatedAt: iso(2) })], rows, threadOf)].map(([thread, all]) => [thread, all.map((one) => one.id)])).toEqual([
      ["t1", ["a-2", "a-1"]],
    ]);
    expect(askProject(ask({ chat: "rivet-chat-threads", repo: "example-org/example-repo" }))).toBe("rivet");
    expect(askProject(ask({ repo: "example-org/other-repo" }))).toBeNull();
    expect(askProject(ask({}))).toBeNull();
  });

  it("builds the timeline from the first message, the ask, Rivet's steps, merged PRs and your OK on a card", () => {
    const reply = (decision: Reply["decision"], pr: number, at: string, choice?: string) =>
      ({ id: `r${pr}${decision}`, itemId: "card", itemTitle: "t", decision, ...(choice ? { choice } : {}), rev: "1", at, handled: true, item: { id: "card", title: "t", kind: "approval", pr, repo: "example-org/example-repo" } }) as Reply;
    const steps = threadSteps({
      row: { id: "c1", rootFrom: "owner" },
      rootAt: iso(0),
      ask: ask({ chat: "rivet-chat-threads", repo: "example-org/example-repo", prs: [287], stage: "shipped", stageAt: iso(50), updatedAt: iso(10), createdAt: iso(5) }),
      stored: [
        { kind: "pr", label: "PR #287", url: "https://github.com/example-org/example-repo/pull/287", at: iso(20) },
        { kind: "pr", label: "PR #12", url: "https://github.com/example-org/other-repo/pull/12", at: iso(21) },
      ],
      merged: [
        { repo: "example-org/example-repo", number: 287, title: "t", url: "https://github.com/example-org/example-repo/pull/287", mergedAt: iso(40) },
        { repo: "example-org/example-repo", number: 12, title: "other repo's 12", url: "https://x", mergedAt: iso(41) },
      ],
      replies: () => [reply("approve", 287, iso(30)), reply("reject", 287, iso(31)), reply("choice", 9999, iso(32), "B")],
    });
    expect(steps.map((step) => [step.kind, step.label])).toEqual([
      ["ask", "You asked"],
      ["chat", "Chat rivet-chat-threads"],
      ["pr", "PR #287"],
      ["pr", "PR #12"],
      ["ok", "Your OK on PR #287"],
      ["pr", "PR #287 merged"],
      ["shipped", "Deployed"],
    ]);
    expect(steps[0]).toMatchObject({ messageId: "c1", auto: true });
  });

  it("asks for card answers by the thread's PRs, and orders steps by the instant they name", () => {
    const asked: { repo: string; number: number }[][] = [];
    const steps = threadSteps({
      row: { id: "c1", rootFrom: "rivet" },
      rootAt: iso(0),
      ask: undefined,
      stored: [
        { kind: "pr", label: "PR #7", url: "https://github.com/example-org/example-repo/pull/7", at: "2026-10-02T01:30:00.000Z" },
        // 10:00 at +10:00 is midnight UTC: before the PR above.
        { kind: "chat", label: "Chat x", at: "2026-10-02T10:00:00+10:00" },
      ],
      merged: [],
      replies: (prs) => (asked.push(prs), []),
    });
    expect(asked).toEqual([[{ repo: "example-org/example-repo", number: 7 }]]);
    expect(steps.map((step) => step.kind)).toEqual(["chat", "pr"]);
    expect(threadPatchSchema.parse({ steps: [{ kind: "pr", label: " PR #7 ", at: "2026-10-02T10:00:00+10:00" }] }).steps).toEqual([
      { kind: "pr", label: "PR #7", at: "2026-10-02T00:00:00.000Z" },
    ]);
    // An offset past ±14:00 is refused, never thrown on.
    expect(threadPatchSchema.safeParse({ steps: [{ kind: "chat", label: "x", at: "2026-10-02T00:00:00+99:99" }] }).success).toBe(false);
  });
});

describe("thread routes", () => {
  let server: TestServer;
  let cookie: string;
  let clock: ReturnType<typeof fakeClock>;
  let seq = 0;

  beforeEach(async () => {
    clock = fakeClock(T0);
    server = await startServer({}, { now: clock.now });
    cookie = server.cookie();
  });

  afterEach(async () => {
    await server.close();
  });

  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = bearer(BOARD_TOKEN)) =>
    fetch(`${server.base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  async function owner(text: string, replyTo?: string): Promise<string> {
    const response = await send("POST", "/api/chat", { clientId: `client-${(seq += 1)}`, text, ...(replyTo ? { replyTo } : {}) }, browser(cookie));
    expect(response.status).toBe(202);
    return ((await response.json()) as { id: string }).id;
  }

  async function rivet(text: string, replyTo?: string, extra: { new?: true; title?: string } = {}): Promise<ChatMessage> {
    const response = await send("POST", "/api/bridge/say", { text, ...(replyTo ? { replyTo } : {}), ...extra });
    expect(response.status).toBe(201);
    return (await response.json()) as ChatMessage;
  }

  /** A say replying to nothing is a Got it card. */
  async function filedCard(text: string): Promise<{ id: string; replyTo?: string; chat?: string }> {
    const response = await send("POST", "/api/bridge/say", { text });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const board = (await (await send("GET", "/api/board")).json()) as { board: { needs: { id: string; replyTo?: string; chat?: string }[] } };
    return board.board.needs.find((need) => need.id === id)!;
  }

  /** The conversation a say replying to nothing was filed in, or null: Rivet's. */
  async function filed(text: string): Promise<string | null> {
    return (await filedCard(text)).replyTo ?? null;
  }

  async function threads(query = "", headers: Record<string, string> = { cookie }): Promise<ThreadsResponse> {
    const response = await send("GET", `/api/threads${query}`, undefined, headers);
    expect(response.status).toBe(200);
    return (await response.json()) as ThreadsResponse;
  }

  it("lists one line per thread, sets status, project, title and steps by any message in it, and serves the thread", async () => {
    const ask = await owner("Upgrade my chat with threads\nand views");
    clock.advance(60_000);
    const ack = await rivet("On it.", ask);
    clock.advance(60_000);
    // A note Rivet starts on its own (say.mjs --new).
    await rivet("The build server is back.", undefined, { new: true });
    let list = await threads();
    // The web lifts a Share restriction only on a list that parses: the server's own must.
    expect(threadListSchema.safeParse(list).success).toBe(true);
    // Rivet's lone note is left out; you writing lately is no link, so your thread is Idle.
    expect(list.threads.map((thread) => [thread.title, thread.status, thread.ball, thread.count])).toEqual([["Upgrade my chat with threads", null, null, 2]]);
    expect(list.open).toMatchObject({ all: 0, none: 0, rivet: 0 });

    expect((await send("PATCH", `/api/threads/${ack.id}`, { status: "needs-you" }, browser(cookie))).status).toBe(400);
    expect((await send("PATCH", `/api/threads/${ack.id}`, { project: "rivet" }, { cookie, "content-type": "application/json" })).status).toBe(403);
    expect((await send("PATCH", `/api/threads/${ack.id}`, { project: "rivet" }, browser("rivet_session=nope"))).status).toBe(401);
    expect((await send("PATCH", "/api/threads/nope", { status: "shipped" })).status).toBe(404);
    expect((await send("PATCH", `/api/threads/${ack.id}`, { status: "done" })).status).toBe(400);
    expect((await send("PATCH", `/api/threads/${ack.id}`, { steps: [{ kind: "pr", label: "PR #1", url: "http://x" }] })).status).toBe(400);
    const patched = await send("PATCH", `/api/threads/${ack.id}`, {
      status: "needs-you",
      project: "rivet",
      title: "Chat threads",
      steps: [{ kind: "pr", label: "PR #287", url: "https://github.com/example-org/example-repo/pull/287" }],
    });
    expect(patched.status).toBe(200);
    const detail = (await patched.json()) as ThreadDetail;
    expect(detail).toMatchObject({ id: ask, title: "Chat threads", status: "needs-you", statusFrom: "set", project: "rivet", ball: "owner", count: 2 });
    expect(detail.steps.map((step) => step.label)).toEqual(["You asked", "PR #287"]);
    expect(detail.messages.map((message) => message.id)).toEqual([ask, ack.id]);

    list = await threads("?view=open");
    expect(list.threads.map((thread) => thread.id)).toEqual([ask]);
    expect(list.open).toMatchObject({ all: 1, rivet: 1, none: 0 });
    expect((await threads("?view=open&project=personal")).threads).toEqual([]);

    // You answering takes it off Needs you; with nothing open on it, it is Idle.
    clock.advance(60_000);
    await owner("Looks good, ship it", ack.id);
    expect((await threads("?view=open")).threads).toEqual([]);
    expect((await threads()).threads.find((thread) => thread.id === ask)).toMatchObject({ status: null, statusFrom: null, ball: null, lastText: "Looks good, ship it" });

    const viaGet = await send("GET", `/api/threads/${ack.id}`, undefined, { cookie });
    expect(((await viaGet.json()) as ThreadDetail).messages).toHaveLength(3);
    expect((await send("GET", "/api/threads/gone", undefined, { cookie })).status).toBe(404);
    expect((await send("GET", "/api/threads", undefined, {})).status).toBe(401);
    expect((await send("GET", "/api/threads?view=new", undefined, { cookie })).status).toBe(400);
    expect((await send("GET", "/api/threads?project=x", undefined, { cookie })).status).toBe(400);
  });

  it("puts Needs you ahead of Working in the open inbox and pages the full list", async () => {
    const first = await owner("first");
    clock.advance(40_000);
    const second = await owner("second");
    clock.advance(40_000);
    const third = await owner("third");
    clock.advance(40_000);
    expect((await send("POST", "/api/asks", { id: "a-2", words: "second", replyId: second, stage: "building" })).status).toBe(201);
    await send("PATCH", `/api/threads/${first}`, { status: "needs-you" });
    await send("PATCH", `/api/threads/${third}`, { status: "parked" });
    expect((await threads("?view=open")).threads.map((thread) => thread.title)).toEqual(["first", "second"]);
    const page = await threads("?limit=2");
    expect(page.threads.map((thread) => thread.title)).toEqual(["third", "second"]);
    expect((await threads(`?limit=2&before=${page.next}`)).threads.map((thread) => thread.title)).toEqual(["first"]);
  });

  it("takes status and project from a linked ask until Rivet sets one later", async () => {
    const ask = await owner("Fix the enquiry form");
    clock.advance(60_000);
    expect((await send("POST", "/api/asks", { id: "a-9", words: "Fix the enquiry form", replyId: ask, stage: "needs-you", chat: "rivet-forms" })).status).toBe(201);
    expect((await threads()).threads[0]).toMatchObject({ status: "needs-you", statusFrom: "ask", project: "rivet", ask: "a-9" });
    clock.advance(60_000);
    await send("PATCH", `/api/threads/${ask}`, { status: "shipped" });
    expect((await threads()).threads[0]).toMatchObject({ status: "shipped", statusFrom: "set" });
  });

  it("lists only threads active in the last 7 days, or the last 24 hours with since=day, counting open ones the same way", async () => {
    const DAY = 86_400_000;
    const old = await owner("Eight days ago");
    clock.advance(DAY);
    const week = await owner("Seven days ago");
    clock.advance(5 * DAY);
    const twoDays = await owner("Two days ago");
    clock.advance(2 * DAY - 3_600_000);
    const today = await owner("An hour ago");
    clock.advance(3_600_000);
    // A change to a thread's settings is not activity: it is still eight days quiet.
    for (const id of [old, twoDays, today]) await send("PATCH", `/api/threads/${id}`, { status: "needs-you" });
    // Exactly seven days quiet is still in this week.
    let list = await threads();
    expect(list.threads.map((thread) => thread.id)).toEqual([today, twoDays, week]);
    // Old is Needs you but out of the window; Week has no status.
    expect(list.open).toMatchObject({ all: 2, none: 2 });
    expect((await threads("?view=open")).threads.map((thread) => thread.id)).toEqual([today, twoDays]);
    const page = await threads("?limit=2");
    expect((await threads(`?limit=2&before=${page.next}`)).threads.map((thread) => thread.id)).toEqual([week]);
    clock.advance(1);
    list = await threads("?since=week");
    expect(list.threads.map((thread) => thread.id)).toEqual([today, twoDays]);
    expect(list.open.all).toBe(2);
    list = await threads("?since=day");
    expect(list.threads.map((thread) => thread.id)).toEqual([today]);
    expect(list.open).toMatchObject({ all: 1, none: 1 });
    expect((await threads("?view=open&since=day")).threads.map((thread) => thread.id)).toEqual([today]);
    expect((await send("GET", "/api/threads?since=month", undefined, { cookie })).status).toBe(400);
    // Every message is still in the flat list.
    const flat = (await (await send("GET", "/api/chat?limit=30", undefined, { cookie })).json()) as { messages: ChatMessage[] };
    expect(flat.messages.map((message) => message.id)).toEqual([old, week, twoDays, today]);
  });

  it("leaves Rivet's lone notes out of Today and This week and their counts; Chat and the thread's link still have them", async () => {
    const mine = await owner("Make the reels faster");
    clock.advance(60_000);
    const note = await rivet("The build server is back.", undefined, { new: true });
    const question = await rivet("Shall I restart the workers?", undefined, { new: true });
    for (const since of ["day", "week"]) {
      const list = await threads(`?since=${since}`);
      // Rivet's question waits on you, so it stays.
      expect(list.threads.map((thread) => thread.id)).toEqual([question.id, mine]);
      expect(list.statuses).toEqual({ all: 2, "needs-you": 1, working: 0, done: 0, idle: 1 });
      expect(list.folders.all).toEqual({ count: 2, needsYou: 1 });
    }
    expect((await send("GET", `/api/threads/${note.id}`, undefined, { cookie })).status).toBe(200);
    const flat = (await (await send("GET", "/api/chat?limit=30", undefined, { cookie })).json()) as { messages: ChatMessage[] };
    expect(flat.messages.map((message) => message.id)).toContain(note.id);
    // Once you answer it, it is a thread like any other.
    clock.advance(60_000);
    await owner("Thanks", note.id);
    expect((await threads("?since=day")).threads.map((thread) => thread.id)).toEqual([note.id, question.id, mine]);
    expect(loneNotice({ startedBy: "rivet", count: 1, status: "shipped" })).toBe(false);
  });

  it("files a Rivet note that answers nothing under the one thread this week naming its PR, ask, card or chat; two or none is Rivet's", async () => {
    const older = await owner("Fix the reel blur, see #400");
    clock.advance(60_000);
    const newer = await owner("And the lobby: example-org/example-repo#400");
    clock.advance(60_000);
    // Both name #400: a wrong conversation is a silent error, Rivet's thread a visible default.
    expect(await filed("PR #400 is merged and live.")).toBeNull();
    expect(await filed("Its link: https://github.com/example-org/example-repo/pull/400")).toBeNull();

    clock.advance(60_000);
    const stepped = await owner("Scroll speed on the page");
    const step = { kind: "pr", label: "PR #500", url: "https://github.com/example-org/example-repo/pull/500" };
    expect((await send("PATCH", `/api/threads/${stepped}`, { steps: [step] })).status).toBe(200);
    expect(await filed("#500 is open.")).toBe(stepped);

    clock.advance(60_000);
    const asked = await owner("Make Invoice Page a new screen");
    const ask = { id: "a-77", words: "Invoice Page", replyId: asked, stage: "building", cardId: "invoice-page-v2", chat: "invoice-page", prs: [600, 601] };
    expect((await send("POST", "/api/asks", ask)).status).toBe(201);
    // The ask's chat goes on the card.
    for (const text of ["a-77 is with the chat now.", "Card invoice-page-v2 is on your feed.", "invoice-page is building it.", "PR #600 opened."]) {
      const card = await filedCard(text);
      expect([text, card.replyTo, card.chat]).toEqual([text, asked, "invoice-page"]);
    }
    // A newer ask in the same thread does not hide the older one's PRs; the newest ask has no chat to put on the card.
    expect((await send("POST", "/api/asks", { id: "a-78", words: "Invoice Page art", replyId: asked, stage: "building", prs: [700] })).status).toBe(201);
    const green = await filedCard("#601 is green.");
    expect([green.replyTo, green.chat]).toEqual([asked, undefined]);

    // No tie, an HTML entity, or a reply: as before.
    expect(await filed("It&#39;s raining at the office.")).toBeNull();
    expect((await rivet("Done, #500 too.", older)).threadId).toBe(older);
    expect((await send("GET", `/api/threads/${newer}`, undefined, { cookie }).then((response) => response.json()) as ThreadDetail).count).toBe(1);
    expect(namedPrs("#1 job; Owner/Repo#12, https://github.com/a/b/pull/7, PR#9 and #12 again")).toEqual([
      { repo: "owner/repo", number: 12 },
      { repo: "a/b", number: 7 },
      { repo: null, number: 12 },
    ]);
    // A repo ending in "-" or "." is still a repo: no bare #410 slips out of it.
    expect(namedPrs("outsider/repo-#410 and v1.#3411")).toEqual([{ repo: "outsider/repo-", number: 410 }]);
  });

  it("never files a Rivet note under a thread quiet for over a week, and filing never moves a thread", async () => {
    await owner("Fix #700");
    clock.advance(60_000);
    const moved = await owner("Clean up #800");
    expect((await send("PATCH", `/api/threads/${moved}`, { project: "personal" }, browser(cookie))).status).toBe(200);
    expect(await filed("#800 merged.")).toBe(moved);
    // Its card is shown in it (2026-10-09), and the thread stays where you moved it.
    expect((await threads()).threads.find((thread) => thread.id === moved)).toMatchObject({ project: "personal", count: 2 });
    clock.advance(7 * 86_400_000 + 1);
    expect(await filed("#700 merged.")).toBeNull();
  });

  it("files a note under a thread active this week by a PR named before the week, or an open chat its messages name", async () => {
    clock.advance(-8 * 86_400_000);
    const root = await owner("Fix #900");
    clock.advance(7 * 86_400_000);
    await owner("Any news?", root);
    clock.advance(86_400_000);
    expect(await filed("#900 merged.")).toBe(root);

    clock.advance(60_000);
    const named = await owner("Is invoice-page-2 done with the reels?");
    const workers = [{ worktreeId: createHash("sha256").update("cs2").digest("hex").slice(0, 16), repo: "example-org/example-repo", chat: "invoice-page-2", connected: true, lastOutputAt: clock.now().getTime(), agent: "claude" }];
    expect((await send("PUT", "/api/bridge/workers", { workers }, bearer(BRIDGE_TOKEN))).status).toBe(200);
    expect(await filed("invoice-page-2 finished the reels.")).toBe(named);
  });

  it("files a note naming 500 PRs, and by a PR its thread wrote with a leading zero", async () => {
    const root = await owner("Is example-org/example-repo#00900 green?");
    clock.advance(60_000);
    expect(await filed(Array.from({ length: 500 }, (_, n) => `#${1_000 + n}`).join(" "))).toBeNull();
    clock.advance(60_000);
    expect(await filed("#900 is green.")).toBe(root);
  });

  it("never files a note under a thread whose last word is Rivet's unanswered question, so it stays Needs you", async () => {
    const asked = await owner("Fix #950");
    clock.advance(60_000);
    await rivet("Merge #950 now?", asked);
    expect((await threads()).threads.find((thread) => thread.id === asked)).toMatchObject({ status: "needs-you", statusFrom: "question" });
    expect(await filed("#950 is green.")).toBeNull();
    expect((await threads()).threads.find((thread) => thread.id === asked)).toMatchObject({ status: "needs-you", statusFrom: "question" });
  });

  it("Rivet's question unanswered for over 3 days no longer puts its thread on Needs you", async () => {
    const asked = await owner("Fix #951");
    clock.advance(60_000);
    await rivet("Merge #951 now?", asked);
    clock.advance(3 * 86_400_000 - 60_000);
    expect((await threads()).threads.find((thread) => thread.id === asked)).toMatchObject({ status: "needs-you", statusFrom: "question" });
    clock.advance(2 * 60_000);
    expect((await threads()).threads.find((thread) => thread.id === asked)).toMatchObject({ status: null, statusFrom: null });
  });

  it("sets and clears a thread's tag, and refuses a long or two-line one", async () => {
    const id = await owner("the night batch reels look blurry");
    expect((await send("PATCH", `/api/threads/${id}`, { tag: "x".repeat(33) })).status).toBe(400);
    expect((await send("PATCH", `/api/threads/${id}`, { tag: "Docs\nSync" })).status).toBe(400);
    const set = await send("PATCH", `/api/threads/${id}`, { tag: " Night Batch " });
    expect(((await set.json()) as ThreadDetail).tag).toBe("Night Batch");
    expect((await threads()).threads[0]).toMatchObject({ id, tag: "Night Batch" });
    await send("PATCH", `/api/threads/${id}`, { tag: null });
    expect((await threads()).threads[0]).toMatchObject({ id, tag: null });
  });

  it("serves the titler this week's untitled threads with clipped text, and takes its answer once, behind Rivet's title", async () => {
    const bridge = bearer(BRIDGE_TOKEN);
    // Rivet's messages carry the real time, so the stale thread is dated back rather than the clock moved on.
    clock.advance(-8 * 86_400_000);
    const stale = await owner("Eight days ago");
    clock.advance(8 * 86_400_000);
    const ask = await owner(`the night batch reels look blurry on my phone\n${"x".repeat(600)}`);
    clock.advance(60_000);
    for (let i = 0; i < 7; i++) await rivet(`reply ${i}`, ask);
    const named = await owner("Fix the enquiry form");
    await send("PATCH", `/api/threads/${named}`, { title: "Enquiry form" });

    expect((await send("GET", "/api/bridge/threads/untitled", undefined, { cookie })).status).toBe(401);
    expect((await send("GET", "/api/bridge/threads/untitled")).status).toBe(401);
    expect((await send("GET", "/api/bridge/threads/untitled?limit=21", undefined, bridge)).status).toBe(400);
    const untitled = (await (await send("GET", "/api/bridge/threads/untitled", undefined, bridge)).json()) as { threads: UntitledThread[] };
    expect(untitled.threads.map((thread) => thread.id)).toEqual([named, ask]);
    const blurry = untitled.threads[1]!;
    expect(blurry.messages.map((message) => message.text.slice(0, 7))).toEqual(["the nig", "reply 1", "reply 2", "reply 3", "reply 4", "reply 5", "reply 6"]);
    expect(blurry.messages[0]!.text).toHaveLength(400);
    expect(blurry.messages[0]!.from).toBe("owner");
    expect(untitled.threads.some((thread) => thread.id === stale)).toBe(false);

    const ai = (id: string, body: unknown, headers = bridge) => send("POST", `/api/bridge/threads/${id}/ai`, body, headers);
    expect((await ai(ask, { title: "Sharpen blurry reels", tag: "Night Batch", project: "work" }, bearer(BOARD_TOKEN))).status).toBe(401);
    expect((await ai(ask, { title: "x".repeat(61), tag: null, project: null })).status).toBe(400);
    expect((await ai(ask, { title: "Two\nlines", tag: null, project: null })).status).toBe(400);
    expect((await ai(ask, { title: "Fine", tag: "x".repeat(33), project: null })).status).toBe(400);
    expect((await ai(ask, { title: "Fine", tag: null, project: "apps" })).status).toBe(400);
    expect((await ai(ask, { title: "Fine", tag: null })).status).toBe(400);
    expect((await ai(ask, { title: "Fine", tag: null, project: null, extra: 1 })).status).toBe(400);
    expect((await ai("nope", { title: "Fine", tag: null, project: null })).status).toBe(404);

    const titled = await ai(ask, { title: "Sharpen blurry reels", tag: "Night Batch", project: "work" });
    expect(titled.status).toBe(200);
    expect((await titled.json()) as ThreadDetail).toMatchObject({ id: ask, title: "Sharpen blurry reels", tag: "Night Batch", project: "work" });
    expect((await ai(named, { title: "Enquiry form broken", tag: "Forms", project: "personal" })).status).toBe(200);
    const list = await threads();
    expect(list.threads.find((thread) => thread.id === named)).toMatchObject({ title: "Enquiry form", tag: "Forms", project: "personal" });
    expect(list.threads.find((thread) => thread.id === ask)).toMatchObject({ title: "Sharpen blurry reels" });
    expect(((await (await send("GET", "/api/bridge/threads/untitled", undefined, bridge)).json()) as { threads: unknown[] }).threads).toEqual([]);
  });

  it("lets the titler's project fill only a thread nothing else gave one", async () => {
    const ask = await owner("Fix the enquiry form");
    clock.advance(60_000);
    expect((await send("POST", "/api/asks", { id: "a-9", words: "Fix the enquiry form", replyId: ask, stage: "needs-you", chat: "rivet-forms" })).status).toBe(201);
    const response = await send("POST", `/api/bridge/threads/${ask}/ai`, { title: "Enquiry form", tag: "Forms", project: "work" }, bearer(BRIDGE_TOKEN));
    expect((await response.json()) as ThreadDetail).toMatchObject({ project: "rivet", tag: "Forms" });
  });

  it("names every app-only thread in appOnly, whatever its age or page", async () => {
    const DAY = 86_400_000;
    const old = await owner("The board deck");
    await send("PATCH", `/api/threads/${old}`, { project: "personal" });
    clock.advance(DAY);
    const set = await owner("Pitch notes");
    await send("PATCH", `/api/threads/${set}`, { project: "personal" });
    clock.advance(7 * DAY);
    const fresh = await owner("Today's topic");
    for (const query of ["", "?since=day", "?view=open", "?view=open&since=day", "?limit=1"]) {
      const list = await threads(query);
      expect(list.threads.map((thread) => thread.id)).not.toContain(old);
      expect(list.appOnly.sort()).toEqual([old, set].sort());
    }
    expect((await threads()).threads.map((thread) => thread.id)).toEqual([fresh, set]);
  });

  it("tells open chat streams when a thread changes", async () => {
    const id = await owner("hello");
    const controller = new AbortController();
    const response = await fetch(`${server.base}/api/chat/stream`, { headers: { cookie }, signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    await send("PATCH", `/api/threads/${id}`, { project: "personal" });
    let text = "";
    while (!text.includes("event: thread")) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain(`data: {"id":"${id}","project":"personal","appOnly":true}`);
    controller.abort();
  });

  const MS = "example-org/example-repo";
  const prUrl = (number: number) => `https://github.com/${MS}/pull/${number}`;
  const PR_BOARD = { ...REPLY_BOARD, needs: REPLY_BOARD.needs.map((need) => (need.id === "pr105-touch" ? { ...need, repo: MS } : need)) };
  const prStep = (number: number) => ({ steps: [{ kind: "pr", label: `PR #${number}`, url: prUrl(number) }] });
  const QUIET = 4 * 86_400_000;

  it("a thread whose messages name an open chat is Building", async () => {
    const chat = await owner("How is invoice-page-2 doing?");
    clock.advance(60_000);
    const word = await owner("Ask the sweeper about it");
    clock.advance(60_000);
    const workers = ["invoice-page-2", "sweeper"].map((name) => ({ worktreeId: createHash("sha256").update(name).digest("hex").slice(0, 16), repo: MS, chat: name, connected: true, lastOutputAt: clock.now().getTime(), agent: "claude" }));
    expect((await send("PUT", "/api/bridge/workers", { workers }, bearer(BRIDGE_TOKEN))).status).toBe(200);
    const byId = new Map((await threads()).threads.map((thread) => [thread.id, thread]));
    expect(byId.get(chat)).toMatchObject({ status: "working", statusFrom: "chat", statusChat: "invoice-page-2" });
    expect(statusText(byId.get(chat)!)).toBe("Building, chat invoice-page-2 is open");
    // A chat id that is a plain word: no link.
    expect(byId.get(word)).toMatchObject({ status: null, statusFrom: null });
  });

  it("a card on a PR or chat a thread's messages name makes it Needs you", async () => {
    const chat = await owner("What is touch-guard doing?");
    clock.advance(60_000);
    expect((await send("PUT", "/api/board", REPLY_BOARD)).status).toBe(200);
    let byId = new Map((await threads()).threads.map((thread) => [thread.id, thread]));
    expect(byId.get(chat)).toMatchObject({ status: "needs-you", statusFrom: "card" });
    // The card has one owner: a newer thread naming its PR takes it.
    const pr = await owner("Is #105 green?");
    clock.advance(60_000);
    byId = new Map((await threads()).threads.map((thread) => [thread.id, thread]));
    expect(byId.get(pr)).toMatchObject({ status: "needs-you", statusFrom: "card", statusPr: 105 });
    expect(byId.get(chat)).toMatchObject({ status: null, statusFrom: null });
  });

  it("a chat id after a comma or in a Markdown link is still named, and an opened thread quiet over a week keeps its links", async () => {
    clock.advance(-8 * 86_400_000);
    const quiet = await owner("Is #105 green?");
    clock.advance(8 * 86_400_000);
    const comma = await owner("Can you check touch-guard,build-2?");
    clock.advance(60_000);
    expect((await send("PUT", "/api/board", REPLY_BOARD)).status).toBe(200);
    let byId = new Map((await threads()).threads.map((thread) => [thread.id, thread]));
    expect(byId.get(comma)).toMatchObject({ status: "needs-you", statusFrom: "card" });
    // A newer thread naming the same chat takes the card: one owner, the most recent winning a tie.
    const link = await owner("See [touch-guard](https://example.com)");
    clock.advance(60_000);
    byId = new Map((await threads()).threads.map((thread) => [thread.id, thread]));
    expect(byId.get(link)).toMatchObject({ status: "needs-you", statusFrom: "card" });
    expect(byId.get(comma)).toMatchObject({ status: null, statusFrom: null });
    expect(byId.has(quiet)).toBe(false);
    // Opened, the quiet thread names the card's PR, but the card stays where the list and the card's Round line put it.
    expect((await send("GET", `/api/threads/${quiet}`, undefined, { cookie })).status).toBe(200);
    const cards = (await (await send("GET", "/api/card-threads", undefined, { cookie })).json()) as CardThreadsResponse;
    expect(cards.cards).toEqual([expect.objectContaining({ card: "pr105-touch", thread: link })]);
  });

  it("a dotted chat id is matched whole, never as its first part", async () => {
    const dotted = await owner("Is build-2.preview up?");
    clock.advance(60_000);
    const plain = await owner("And build-2?");
    clock.advance(60_000);
    const workers = ["build-2", "build-2.preview"].map((name) => ({ worktreeId: createHash("sha256").update(name).digest("hex").slice(0, 16), repo: MS, chat: name, connected: true, lastOutputAt: clock.now().getTime(), agent: "claude" }));
    expect((await send("PUT", "/api/bridge/workers", { workers }, bearer(BRIDGE_TOKEN))).status).toBe(200);
    const byId = new Map((await threads()).threads.map((thread) => [thread.id, thread]));
    expect(byId.get(dotted)).toMatchObject({ status: "working", statusChat: "build-2.preview" });
    expect(byId.get(plain)).toMatchObject({ status: "working", statusChat: "build-2" });
  });

  it("a thread with a deployed step shows Done, deployed", async () => {
    const id = await owner("Ship the lobby fix");
    clock.advance(60_000);
    await send("PATCH", `/api/threads/${id}`, { steps: [...prStep(3401).steps, { kind: "shipped", label: "Deployed on play" }] });
    const done = (await threads()).threads[0]!;
    expect(done).toMatchObject({ status: "shipped", statusFrom: "shipped" });
    expect(statusText(done)).toBe("Done, deployed");
    expect((await threads()).statuses).toMatchObject({ all: 1, done: 1, working: 0 });
    // You writing after it takes it off Done; with nothing open on it, it is Idle.
    clock.advance(60_000);
    await owner("One more thing", id);
    expect((await threads()).threads[0]).toMatchObject({ status: null, statusFrom: null });
  });

  it("an open card on the thread's PR shows Needs you until you answer it", async () => {
    const id = await owner("Approve the touch guard");
    await send("PATCH", `/api/threads/${id}`, prStep(105));
    clock.advance(QUIET);
    expect((await send("PUT", "/api/board", PR_BOARD)).status).toBe(200);
    const waiting = (await threads()).threads[0]!;
    expect(waiting).toMatchObject({ status: "needs-you", statusFrom: "card", statusPr: 105 });
    expect(statusText(waiting)).toBe("Needs you, a card on PR #105 waits for you");
    expect((await threads()).folders).toMatchObject({ all: { count: 1, needsYou: 1 }, projects: { none: { count: 1, needsYou: 1 } } });
    const rev = await revOf(server.base, cookie, "pr105-touch");
    expect((await send("POST", "/api/replies", { clientId: "reply-0001", itemId: "pr105-touch", decision: "approve", rev }, browser(cookie))).status).toBe(201);
    expect((await threads()).threads[0]).toMatchObject({ status: null, statusFrom: null });
  });

  it("gives a card to the thread whose ask names it over newer threads on its PR or chat, and counts only that thread's answers", () => {
    const ask = (id: string, extra: Partial<Ask>) => ({ id, ...extra }) as unknown as Ask;
    const named = { summary: { id: "named", title: "Named", lastAt: iso(0) }, links: threadLinks([ask("a1", { cardId: "card-x" })], []) };
    const byPr = { summary: { id: "by-pr", title: "By PR", lastAt: iso(60_000) }, links: threadLinks([ask("a2", { prs: [335] })], []) };
    const byChat = { summary: { id: "by-chat", title: "By chat", lastAt: iso(120_000) }, links: threadLinks([ask("a3", { chat: "build-pace" })], []) };
    const card = (id: string, rev: string, extra: Record<string, unknown> = {}) => ({ id, rev, ...extra });
    const answer = (id: string, rev: string, extra: Record<string, unknown> = {}) => ({ itemId: id, rev, item: { id, title: id, kind: "approval", ...extra } }) as Pick<Reply, "itemId" | "rev" | "item">;
    // Card x names PR #335 and the chat too, but the first thread's ask names it.
    const answers = [answer("card-x", "r1", { pr: 335 }), answer("card-y", "r1", { pr: 335 }), answer("card-y", "r2", { pr: 335 }), answer("card-z", "r1", { chat: "build-pace" })];
    const asked: string[] = [];
    const repliesFor = (links: ReturnType<typeof threadLinks>) => {
      asked.push(links.ids.join() || links.prs.map((pr) => pr.number).join() || links.chats.map((chat) => chat.chat).join());
      return answers;
    };
    const cards = [card("card-x", "r2", { pr: 335, chat: "build-pace" }), card("card-y", "r3", { pr: 335 }), card("card-z", "r2", { chat: "build-pace" })];
    expect(cardThreads([named, byPr, byChat], cards, repliesFor)).toEqual([
      // Every answer counts once, in the thread that owns its card: card-x's on PR #335 is the named thread's.
      { card: "card-x", thread: "named", title: "Named", round: 2 },
      { card: "card-y", thread: "by-pr", title: "By PR", round: 3 },
      { card: "card-z", thread: "by-chat", title: "By chat", round: 2 },
    ]);
    expect(asked).toEqual(["card-x", "335", "build-pace"]);

    // A thread's Your OK names its own card before one on its PR, and that before one on its chat.
    const both = ask("a4", { cardId: "card-x", prs: [335], chat: "build-pace" });
    const live = { openPrs: new Set<string>(), merged: new Map(), chats: new Set<string>(), cards: [card("card-z", "r2", { chat: "build-pace" }), card("card-y", "r3", { pr: 335 }), card("card-x", "r2")].map((one) => ({ ...one, repo: NO_REPO })) };
    expect(statusFacts(both, [], live).card).toEqual({ id: "card-x" });
    expect(statusFacts(both, [], { ...live, cards: live.cards.slice(0, 2) }).card).toEqual({ id: "card-y", pr: 335 });
    expect(statusFacts(both, [], { ...live, cards: live.cards.slice(0, 1) }).card).toEqual({ id: "card-z" });
  });

  it("ranks what a thread's messages name below its ask's links when it gives a card an owner", () => {
    const ask = (id: string, extra: Partial<Ask>) => ({ id, ...extra }) as unknown as Ask;
    const said = (text: string) => ({ refs: namedPrs(text), words: new Set(text.toLowerCase().split(/\s+/)) });
    const byPr = { summary: { id: "by-pr", title: "By PR", lastAt: iso(0) }, links: threadLinks([ask("a1", { prs: [335] })], []) };
    const byChat = { summary: { id: "by-chat", title: "By chat", lastAt: iso(60_000) }, links: threadLinks([ask("a2", { chat: "build-pace" })], []) };
    const namesPr = { summary: { id: "names-pr", title: "Names PR", lastAt: iso(120_000) }, links: threadLinks([], [], said("is #335 green")) };
    const namesChat = { summary: { id: "names-chat", title: "Names chat", lastAt: iso(180_000) }, links: threadLinks([], [], said("how is build-pace")) };
    const cards = [
      { id: "on-pr", rev: "r1", pr: 335 },
      { id: "on-chat", rev: "r1", chat: "build-pace" },
      { id: "on-both", rev: "r1", pr: 335, chat: "build-pace" },
    ];
    // Newer threads that only name the PR or chat lose to the threads whose asks link them.
    expect(cardThreads([byPr, byChat, namesPr, namesChat], cards, () => []).map((link) => [link.card, link.thread])).toEqual([
      ["on-pr", "by-pr"],
      ["on-chat", "by-chat"],
      ["on-both", "by-pr"],
    ]);
    // With no ask linking them, a named PR outranks a named chat, though the chat's thread is newer.
    expect(cardThreads([namesPr, namesChat], cards, () => []).map((link) => [link.card, link.thread])).toEqual([
      ["on-pr", "names-pr"],
      ["on-chat", "names-chat"],
      ["on-both", "names-pr"],
    ]);
  });

  it("links the cards every ask in a thread names, not just the newest ask's", () => {
    const ask = (id: string, extra: Partial<Ask>) => ({ id, ...extra }) as unknown as Ask;
    const links = threadLinks([ask("newer", { cardId: "card-x", prs: [335] }), ask("older", { cardId: "card-w", chat: "build-pace" })], []);
    expect(links.ids).toEqual(["card-x", "card-w"]);
    expect(links.prs.map((pr) => pr.number)).toEqual([335]);
    expect(links.chats.map((chat) => chat.chat)).toEqual(["build-pace"]);
    const answer = (id: string, rev: string) => ({ itemId: id, rev, item: { id, title: id, kind: "approval" } }) as Pick<Reply, "itemId" | "rev" | "item">;
    const thread = { summary: { id: "t1", title: "Asked twice", lastAt: iso(0) }, links };
    // Card w, named only by the older ask, gets its Round line and its answered history counts.
    expect(cardThreads([thread], [{ id: "card-w", rev: "r2" }], () => [answer("card-w", "r1")])).toEqual([{ card: "card-w", thread: "t1", title: "Asked twice", round: 2 }]);
  });

  it("links an open card to its thread with its round, and names the card the thread waits on", async () => {
    const cardThreads = async (): Promise<CardThreadsResponse> => {
      const response = await send("GET", "/api/card-threads", undefined, { cookie });
      expect(response.status).toBe(200);
      return (await response.json()) as CardThreadsResponse;
    };
    expect((await send("GET", "/api/card-threads", undefined, {})).status).toBe(401);
    expect((await send("GET", "/api/card-threads")).status).toBe(401);
    const older = await owner("Touch guard, first look");
    await send("PATCH", `/api/threads/${older}`, prStep(105));
    clock.advance(60_000);
    const id = await owner("Approve the touch guard");
    await send("PATCH", `/api/threads/${id}`, prStep(105));
    await owner("Something else entirely");
    expect((await cardThreads()).cards).toEqual([]);
    expect((await send("PUT", "/api/board", PR_BOARD)).status).toBe(200);
    // Both threads name PR #105: the card goes with the one active last.
    expect((await cardThreads()).cards).toEqual([{ card: "pr105-touch", thread: id, title: "Approve the touch guard", round: 1 }]);
    expect((await threads()).threads.find((thread) => thread.id === id)).toMatchObject({ statusFrom: "card", statusCard: "pr105-touch" });
    // The older thread on the same PR is not the card's, so it shows no Your OK for it.
    expect((await threads()).threads.find((thread) => thread.id === older)!.statusCard).toBeUndefined();
    const rev = await revOf(server.base, cookie, "pr105-touch");
    expect((await send("POST", "/api/replies", { clientId: "reply-0002", itemId: "pr105-touch", decision: "reject", rev, text: "Not yet" }, browser(cookie))).status).toBe(201);
    expect((await cardThreads()).cards).toEqual([]);
    expect((await threads()).threads.find((thread) => thread.id === id)!.statusCard).toBeUndefined();
    // Asked again, the card is the thread's second round.
    const again = { ...PR_BOARD, needs: PR_BOARD.needs.map((need) => (need.id === "pr105-touch" ? { ...need, title: "Touch action guard, v2" } : need)) };
    expect((await send("PUT", "/api/board", again)).status).toBe(200);
    expect((await cardThreads()).cards).toEqual([{ card: "pr105-touch", thread: id, title: "Approve the touch guard", round: 2 }]);
  });

  it("counts a card's rounds in a thread that only names its PR", async () => {
    const id = await owner("Is #105 ready?");
    clock.advance(60_000);
    expect((await send("PUT", "/api/board", REPLY_BOARD)).status).toBe(200);
    const cardThreads = async () => ((await (await send("GET", "/api/card-threads", undefined, { cookie })).json()) as CardThreadsResponse).cards;
    expect(await cardThreads()).toEqual([expect.objectContaining({ card: "pr105-touch", thread: id, round: 1 })]);
    const rev = await revOf(server.base, cookie, "pr105-touch");
    expect((await send("POST", "/api/replies", { clientId: "reply-0003", itemId: "pr105-touch", decision: "reject", rev, text: "Not yet" }, browser(cookie))).status).toBe(201);
    const again = { ...REPLY_BOARD, needs: REPLY_BOARD.needs.map((need) => (need.id === "pr105-touch" ? { ...need, title: "Touch action guard, v2" } : need)) };
    expect((await send("PUT", "/api/board", again)).status).toBe(200);
    expect(await cardThreads()).toEqual([expect.objectContaining({ card: "pr105-touch", thread: id, round: 2 })]);
  });

  it("a thread quiet past the week owns no card, though its mentions are read from that minute", async () => {
    clock.advance(45_000);
    const id = await owner("Is #105 ready?");
    expect((await send("PUT", "/api/board", REPLY_BOARD)).status).toBe(200);
    const cardOwner = async () =>
      ((await (await send("GET", "/api/card-threads", undefined, { cookie })).json()) as CardThreadsResponse).cards.find((card) => card.card === "pr105-touch")?.thread;
    // The week runs from 35 s past the minute: the message, at 45 s, is in it.
    clock.advance(7 * 86_400_000 - 10_000);
    expect(await cardOwner()).toBe(id);
    // From 50 s past the same minute it is not, though the minute's answer is still kept.
    clock.advance(15_000);
    expect(await cardOwner()).not.toBe(id);
  });

  it("your Move files a thread for good: the titler and the ask never refile it, and Unsorted holds", async () => {
    const id = await owner("Scroll speed on the page");
    const move = (body: unknown) => send("PATCH", `/api/threads/${id}`, body, browser(cookie));
    // A Move picks a project; the tag is Rivet's and the titler's, never the Move's.
    expect((await move({ project: "work", tag: "Night Batch" })).status).toBe(400);
    expect((await move({ project: "work" })).status).toBe(200);
    expect((await send("POST", `/api/bridge/threads/${id}/ai`, { title: "Reel speed", tag: "Docs refresh", project: "personal" }, bearer(BRIDGE_TOKEN))).status).toBe(200);
    let list = await threads();
    expect(list.threads[0]).toMatchObject({ project: "work", title: "Reel speed" });
    expect(Object.keys(list.folders).sort()).toEqual(["all", "projects"]);
    expect(list.folders.projects).toMatchObject({ work: { count: 1 }, personal: { count: 0 } });
    // An app from an older client is ignored: it gets the project's whole folder.
    expect((await threads("?project=work&app=app-a")).threads.map((thread) => thread.id)).toEqual([id]);
    expect((await threads("?project=personal&app=app-b")).threads).toEqual([]);
    expect((await send("GET", "/api/threads?status=open", undefined, { cookie })).status).toBe(400);

    expect((await move({ project: null })).status).toBe(200);
    list = await threads();
    expect(list.threads[0]).toMatchObject({ project: null });
    expect(list.folders.projects).toMatchObject({ none: { count: 1 }, personal: { count: 0 }, work: { count: 0 } });
    expect((await move({ project: "nope" })).status).toBe(400);
  });

  it("keeps a thread the titler files in an app-only project app-only, and one moved out of it still app-only", async () => {
    const weight = await owner("Plot my weight trend");
    await send("POST", `/api/bridge/threads/${weight}/ai`, { title: "Weight trend", tag: null, project: "personal" }, bearer(BRIDGE_TOKEN));
    clock.advance(60_000);
    const corp = await owner("Side Project pitch");
    await send("POST", `/api/bridge/threads/${corp}/ai`, { title: "Pitch deck", tag: null, project: "personal" }, bearer(BRIDGE_TOKEN));
    expect((await send("PATCH", `/api/threads/${corp}`, { project: "rivet" }, browser(cookie))).status).toBe(200);
    const list = await threads();
    expect(list.threads.find((thread) => thread.id === weight)).toMatchObject({ project: "personal" });
    expect(list.threads.find((thread) => thread.id === corp)).toMatchObject({ project: "rivet" });
    expect([...list.appOnly].sort()).toEqual([corp, weight].sort());
  });

  /** An open chat stream, and a wait for a frame on it. */
  async function openStream(): Promise<{ heard: (frame: string) => Promise<void>; close: () => void }> {
    const controller = new AbortController();
    const response = await fetch(`${server.base}/api/chat/stream`, { headers: { cookie }, signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    let text = "";
    return {
      heard: async (frame) => {
        while (!text.includes(frame)) text += new TextDecoder().decode((await reader.read()).value);
      },
      close: () => controller.abort(),
    };
  }

  it("tells open chat streams about both threads when an ask moves from one to another", async () => {
    const first = await owner("Draft the board deck");
    clock.advance(10 * 60_000);
    const second = await owner("Pitch notes");
    expect((await send("POST", "/api/asks", { id: "a-3", words: "Board deck", replyId: first, stage: "queued", chat: "rivet-deck" })).status).toBe(201);
    const stream = await openStream();
    expect((await send("PATCH", "/api/asks/a-3", { replyId: second })).status).toBe(200);
    await stream.heard(`data: {"id":"${first}","project":null,"appOnly":false}`);
    await stream.heard(`data: {"id":"${second}","project":"rivet","appOnly":false}`);
    stream.close();
  });

  it("a thread Rivet filed in an app-only project stays app-only after your Move, while its folder follows the Move", async () => {
    const monitor = await owner("Board deck numbers");
    await send("PATCH", `/api/threads/${monitor}`, { project: "personal" });
    clock.advance(60_000);
    const titled = await owner("Vendor follow-up");
    await send("POST", `/api/bridge/threads/${titled}/ai`, { title: "Vendors", tag: null, project: "personal" }, bearer(BRIDGE_TOKEN));
    clock.advance(60_000);
    const weight = await owner("Weekly weigh-in");
    await send("PATCH", `/api/threads/${weight}`, { project: "personal" });
    await rivet("Logged it", weight);
    const stream = await openStream();
    for (const id of [monitor, titled, weight]) {
      expect((await send("PATCH", `/api/threads/${id}`, { project: "work" }, browser(cookie))).status).toBe(200);
      await stream.heard(`data: {"id":"${id}","project":"work","appOnly":true}`);
    }
    stream.close();
    const list = await threads();
    for (const id of [monitor, titled, weight]) expect(list.threads.find((thread) => thread.id === id)).toMatchObject({ project: "work" });
    expect(list.folders.projects).toMatchObject({ work: { count: 3 }, personal: { count: 0 } });
    // The share path: the list's app-only ids, and every message's project word, still keep them out of a share.
    expect([...list.appOnly].sort()).toEqual([monitor, titled, weight].sort());
    const detail = (await (await send("GET", `/api/threads/${weight}`, undefined, { cookie })).json()) as ThreadDetail;
    expect(detail).toMatchObject({ project: "work", filed: "personal" });
    expect(detail.messages.map((message) => message.project)).toEqual(["personal", "personal"]);
    const { messages } = (await (await send("GET", "/api/chat", undefined, { cookie })).json()) as { messages: ChatMessage[] };
    expect(messages.filter((message) => message.threadId === monitor).map((message) => message.project)).toEqual(["personal"]);
  });

  it("an ask's own card, unanswered on the board, makes its thread Needs you", async () => {
    const id = await owner("Name the skier");
    expect((await send("POST", "/api/asks", { id: "a-9", words: "Name the skier", replyId: id, stage: "queued", cardId: "pr105-touch" })).status).toBe(201);
    clock.advance(QUIET);
    expect((await send("PUT", "/api/board", REPLY_BOARD)).status).toBe(200);
    expect((await threads()).threads[0]).toMatchObject({ id, status: "needs-you", statusFrom: "card" });
  });

  it("keeps Rivet's filing apart from your Move: a filing never undoes a Move, and is never lost under one", async () => {
    // Rivet files a thread where you already moved it; your later Move out still leaves it app-only.
    const same = await owner("Board deck numbers");
    expect((await send("PATCH", `/api/threads/${same}`, { project: "personal" }, browser(cookie))).status).toBe(200);
    expect((await send("PATCH", `/api/threads/${same}`, { project: "personal" })).status).toBe(200);
    expect((await send("PATCH", `/api/threads/${same}`, { project: "work" }, browser(cookie))).status).toBe(200);
    clock.advance(60_000);
    // Your Move into Personal outlasts Rivet filing the thread somewhere else.
    const kept = await owner("Vendor follow-up");
    expect((await send("PATCH", `/api/threads/${kept}`, { project: "personal" }, browser(cookie))).status).toBe(200);
    expect((await send("PATCH", `/api/threads/${kept}`, { project: "work" })).status).toBe(200);
    const list = await threads();
    expect(list.threads.find((thread) => thread.id === same)).toMatchObject({ project: "work" });
    expect(list.threads.find((thread) => thread.id === kept)).toMatchObject({ project: "personal" });
    expect([...list.appOnly].sort()).toEqual([same, kept].sort());
  });

  it("Rivet re-filing a thread out of Personal, with no Move, lets Share come back", async () => {
    const monitor = await owner("Board deck numbers");
    await send("PATCH", `/api/threads/${monitor}`, { project: "personal" });
    clock.advance(60_000);
    const titled = await owner("Vendor follow-up");
    await send("POST", `/api/bridge/threads/${titled}/ai`, { title: "Vendors", tag: null, project: "personal" }, bearer(BRIDGE_TOKEN));
    expect([...(await threads()).appOnly].sort()).toEqual([monitor, titled].sort());
    const stream = await openStream();
    for (const id of [monitor, titled]) {
      expect((await send("PATCH", `/api/threads/${id}`, { project: "work" })).status).toBe(200);
      await stream.heard(`data: {"id":"${id}","project":"work","appOnly":false}`);
    }
    stream.close();
    expect((await threads()).appOnly).toEqual([]);
  });
});
