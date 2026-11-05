import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommandStore } from "../src/server/commandstore.js";
import { RETENTION_LAST_KEY, retentionTick } from "../src/server/retention.js";
import { AUDIT_KEEP_MS, CONVERSATION_KEEP_MS, UPDATES_ID } from "../src/shared/conversations.js";

const MS = "example-org/example-repo";
const NOW = new Date("2027-06-01T00:30:00.000Z");
const OLD = "2026-10-01T00:00:00.000Z";
const RECENT = "2027-05-20T00:00:00.000Z";
const BEFORE = new Date(NOW.getTime() - CONVERSATION_KEEP_MS!).toISOString();
const AUDIT_BEFORE = new Date(NOW.getTime() - AUDIT_KEEP_MS).toISOString();

describe("retention sweep", () => {
  let dir: string;
  let commands: CommandStore;
  const db = () => (commands as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown } } }).db;
  const count = (sql: string, ...args: unknown[]) => Number((db().prepare(sql).get(...args) as { n: number }).n);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rivet-retention-"));
    commands = new CommandStore(dir);
  });
  afterEach(() => {
    commands.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A conversation of your line and Rivet's reply, both at `at`, with its finished action, a step, a PR link and a card. */
  const conversation = (id: string, at: string) => {
    commands.addAction({ id, clientId: id, kind: "send", request: { repo: MS, chat: "fix-login", text: `hello ${id}`, quote: { from: "rivet", text: "q" } }, at });
    db().prepare("UPDATE audit SET status = 'replied' WHERE id = ?").run(id);
    commands.addChatMessage({ id, from: "owner", text: `hello ${id}`, at });
    commands.addChatMessage({ id: `${id}-r`, from: "rivet", text: "on it", at, replyTo: id });
    db().prepare("INSERT INTO chat_thread_steps (root_id, kind, label, at) VALUES (?, 'pr', 'PR', ?)").run(id, at);
    db().prepare("INSERT INTO conversation_prs (thread, pr) VALUES (?, ?)").run(id, `${MS.toLowerCase()}#${id}`);
    db().prepare("INSERT INTO card_conversations (card, thread, via, at) VALUES (?, ?, 'say', ?)").run(`card-${id}`, `${id}-r`, at);
  };
  const present = (id: string) => commands.getChatMessage(id) !== null;

  it("counts only, by default: a closed, quiet conversation is due; nothing is deleted", () => {
    conversation("old", OLD);
    commands.patchConversation("old", { closed: true }, OLD);
    const logged: string[] = [];
    expect(retentionTick(commands, NOW, undefined, (line) => logged.push(line))).toEqual({ conversations: 1, messages: 2, audit: 0, prStages: 0 });
    expect(present("old") && present("old-r")).toBe(true);
    expect(commands.getAction("old")!.text).toBe("hello old");
    expect(logged).toEqual(["[rivet] retention: would delete 1 conversations (2 messages), 0 audit rows, 0 PR stages"]);
    expect(JSON.parse(commands.getMeta(RETENTION_LAST_KEY)!)).toMatchObject({ apply: false, conversations: 1 });
    expect(retentionTick(commands, new Date(NOW.getTime() + 60_000), undefined, () => {}), "once an hour").toBeNull();
  });

  it("deletes a closed or done, unpinned, quiet conversation whole and blanks its actions' words", () => {
    for (const id of ["closed", "done", "pinned", "open", "fresh"]) conversation(id, id === "fresh" ? RECENT : OLD);
    commands.patchConversation("closed", { closed: true }, OLD);
    commands.patchConversation("done", { done: true }, OLD);
    commands.patchConversation("pinned", { pinned: true, done: true }, OLD);
    commands.patchConversation("fresh", { closed: true }, RECENT);
    db().prepare("INSERT INTO find_work_conversations (repo, issue, root) VALUES (?, 1, 'closed')").run(MS);
    db().prepare("INSERT INTO pr_stages (pr, stage, at) VALUES (?, 'merged', ?)").run(`${MS.toLowerCase()}#closed`, OLD);
    db().prepare("INSERT INTO pr_stages (pr, stage, at) VALUES (?, 'merged', ?)").run(`${MS.toLowerCase()}#pinned`, OLD);

    expect(commands.sweepRetention(BEFORE, AUDIT_BEFORE, true, 500)).toEqual({ conversations: 2, messages: 4, audit: 0, prStages: 1 });
    expect(["closed", "closed-r", "done", "done-r"].some(present)).toBe(false);
    expect(["pinned", "open", "fresh"].every(present), "pinned, open and recent stay").toBe(true);
    for (const id of ["closed", "done"]) {
      expect(count("SELECT COUNT(*) AS n FROM chat_threads WHERE root_id = ?", id)).toBe(0);
      expect(count("SELECT COUNT(*) AS n FROM chat_thread_steps WHERE root_id = ?", id)).toBe(0);
      expect(count("SELECT COUNT(*) AS n FROM conversation_prs WHERE thread = ?", id)).toBe(0);
      expect(commands.cardConversation(`card-${id}`)).toBeNull();
      expect(commands.getAction(id)).toMatchObject({ kind: "send", text: "" });
      expect(commands.getAction(id)!.quote).toBeUndefined();
    }
    expect(count("SELECT COUNT(*) AS n FROM find_work_conversations")).toBe(0);
    // closed's PR is no longer linked and its stage is stale; pinned's is still linked.
    expect(count("SELECT COUNT(*) AS n FROM pr_stages")).toBe(1);
    expect(commands.cardConversation("card-pinned")).not.toBeNull();
    expect(commands.getAction("pinned")!.text).toBe("hello pinned");
  });

  it("follows the list: a message after Close reopens it, and you writing after Done undoes it", () => {
    for (const id of ["reopened", "undone", "swept"]) conversation(id, OLD);
    commands.patchConversation("reopened", { closed: true }, "2026-09-30T00:00:00.000Z");
    commands.patchConversation("undone", { done: true }, "2026-09-30T00:00:00.000Z");
    db().prepare("UPDATE chat_threads SET closed_at = ?, swept_at = ? WHERE root_id = 'swept'").run(OLD, OLD);
    expect(commands.sweepRetention(BEFORE, AUDIT_BEFORE, true, 500)).toEqual({ conversations: 0, messages: 0, audit: 0, prStages: 0 });
    expect(["reopened", "undone", "swept"].every(present)).toBe(true);
  });

  it("keeps a conversation whose action is still unfinished: blanking a queued action's words would lose it", () => {
    for (const id of ["queued", "finished"]) {
      conversation(id, OLD);
      commands.patchConversation(id, { closed: true }, OLD);
    }
    db().prepare("UPDATE audit SET status = 'queued' WHERE id = 'queued'").run();
    expect(commands.sweepRetention(BEFORE, AUDIT_BEFORE, false, 500)).toMatchObject({ conversations: 1, messages: 2 });
    expect(commands.sweepRetention(BEFORE, AUDIT_BEFORE, true, 500)).toMatchObject({ conversations: 1, messages: 2 });
    expect(present("queued") && commands.getAction("queued")!.text === "hello queued").toBe(true);
    expect(present("finished")).toBe(false);
  });

  it("count-only changes nothing: every table's rows and the media files are as they were, its two meta keys aside", () => {
    const ancient = "2025-01-01T00:00:00.000Z";
    const image = "a".repeat(64);
    commands.putMedia(image, "image/jpeg", 10, 1);
    writeFileSync(join(dir, image), "jpeg");
    conversation("old", ancient);
    commands.addChatMessage({ id: "old-photo", from: "rivet", text: "", at: ancient, images: [image], thread: "old" });
    commands.patchConversation("old", { closed: true }, ancient);
    db().prepare("UPDATE audit SET status = 'replied' WHERE id = 'old'").run();
    commands.addAction({ id: "stale", clientId: "stale", kind: "send", request: { repo: MS, chat: "fix-login", text: "x" }, at: ancient });
    db().prepare("UPDATE audit SET status = 'replied' WHERE id = 'stale'").run();
    db().prepare("INSERT INTO pr_stages (pr, stage, at) VALUES (?, 'merged', ?)").run(`${MS.toLowerCase()}#old`, ancient);
    const tables = () =>
      (db().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name") as unknown as { all(): { name: string }[] })
        .all()
        .map(({ name }) => [name, (db().prepare(`SELECT * FROM "${name}" ORDER BY rowid`) as unknown as { all(): unknown[] }).all().filter((row) => !String((row as { key?: unknown }).key).startsWith("retention."))]);
    const was = JSON.stringify(tables());
    expect(retentionTick(commands, NOW, false, () => {})).toEqual({ conversations: 1, messages: 3, audit: 2, prStages: 1 });
    expect(JSON.stringify(tables())).toBe(was);
    expect(existsSync(join(dir, image))).toBe(true);
  });

  it("counts exactly what applying would delete, audit and PR stages freed by it included", () => {
    const ancient = "2025-01-01T00:00:00.000Z";
    conversation("old", ancient);
    commands.patchConversation("old", { closed: true }, ancient);
    db().prepare("UPDATE audit SET status = 'replied' WHERE id = 'old'").run();
    db().prepare("INSERT INTO pr_stages (pr, stage, at) VALUES (?, 'merged', ?)").run(`${MS.toLowerCase()}#old`, ancient);
    const due = commands.sweepRetention(BEFORE, AUDIT_BEFORE, false, 500);
    expect(due).toEqual({ conversations: 1, messages: 2, audit: 1, prStages: 1 });
    expect(present("old") && commands.getAction("old")!.text === "hello old").toBe(true);
    expect(count("SELECT COUNT(*) AS n FROM pr_stages")).toBe(1);
    expect(commands.sweepRetention(BEFORE, AUDIT_BEFORE, true, 500)).toEqual(due);
  });

  it("deletes PR stages in batches too", () => {
    for (let i = 0; i < 5; i += 1) db().prepare("INSERT INTO pr_stages (pr, stage, at) VALUES (?, 'merged', ?)").run(`${MS.toLowerCase()}#${i}`, OLD);
    expect(commands.sweepRetention(BEFORE, AUDIT_BEFORE, true, 2).prStages).toBe(2);
    expect(commands.sweepRetention(BEFORE, AUDIT_BEFORE, false, 2).prStages, "a count is not batched").toBe(3);
  });

  it("never sweeps the seeded rooms, and keeps every conversation with no window", () => {
    commands.addChatMessage({ id: "u", from: "rivet", text: "update", at: OLD, thread: UPDATES_ID });
    commands.patchConversation(UPDATES_ID, { done: true }, OLD);
    conversation("closed", OLD);
    commands.patchConversation("closed", { closed: true }, OLD);
    expect(commands.sweepRetention(null, AUDIT_BEFORE, true, 500)).toEqual({ conversations: 0, messages: 0, audit: 0, prStages: 0 });
    expect(commands.sweepRetention(BEFORE, AUDIT_BEFORE, true, 500).conversations).toBe(1);
    expect(present("u")).toBe(true);
  });

  it("deletes a finished action past a year only once its message is gone", () => {
    const ancient = "2026-01-01T00:00:00.000Z";
    commands.addAction({ id: "kept", clientId: "kept", kind: "send", request: { repo: MS, chat: "fix-login", text: "a" }, at: ancient });
    commands.addChatMessage({ id: "kept", from: "owner", text: "a", at: ancient });
    commands.addAction({ id: "gone", clientId: "gone", kind: "send", request: { repo: MS, chat: "fix-login", text: "b" }, at: ancient });
    commands.addAction({ id: "queued", clientId: "queued", kind: "send", request: { repo: MS, chat: "fix-login", text: "c" }, at: ancient });
    commands.addAction({ id: "young", clientId: "young", kind: "send", request: { repo: MS, chat: "fix-login", text: "d" }, at: RECENT });
    for (const id of ["kept", "gone", "young"]) db().prepare("UPDATE audit SET status = 'replied' WHERE id = ?").run(id);
    expect(commands.sweepRetention(BEFORE, AUDIT_BEFORE, false, 500).audit).toBe(1);
    expect(commands.sweepRetention(BEFORE, AUDIT_BEFORE, true, 500).audit).toBe(1);
    expect(["kept", "gone", "queued", "young"].map((id) => commands.getAction(id) !== null)).toEqual([true, false, true, true]);
  });

  it("deletes about a batch, oldest first, never splitting a conversation", () => {
    for (const [id, at] of [["a", "2026-09-01T00:00:00.000Z"], ["b", "2026-09-02T00:00:00.000Z"], ["c", "2026-09-03T00:00:00.000Z"]] as const) {
      conversation(id, at);
      commands.patchConversation(id, { closed: true }, at);
    }
    expect(commands.sweepRetention(BEFORE, AUDIT_BEFORE, true, 3)).toMatchObject({ conversations: 1, messages: 2 });
    expect(commands.sweepRetention(BEFORE, AUDIT_BEFORE, true, 1)).toMatchObject({ conversations: 1, messages: 2 });
    expect(["a", "b", "c"].map(present)).toEqual([false, false, true]);
  });
});
