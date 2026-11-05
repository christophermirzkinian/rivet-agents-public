import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { takesDecision, threadKey } from "../src/shared/answers.js";
import { boardSchema, needSchema } from "../src/shared/board.js";
import type { ChatPage } from "../src/shared/command.js";
import { UPDATES_ID } from "../src/shared/conversations.js";
import { MAX_CARDS, needRev, openBoard, makeCardRoom, UPDATE_KEEP_MS, withoutHandled, withServerFields } from "../src/server/http.js";
import { boardPayloads, cardPayload, needLevel } from "../src/server/push.js";
import { bearer, BOARD_TOKEN, browser, fakeClock, putBoard, revOf, startServer, type TestServer } from "./helpers.js";

// Filler the server's redactor leaves as it is: one long run of a letter reads to it as a token, and a line
// past 4096 characters is withheld. `n` bytes as JSON writes it: lines of words, each line break two bytes there.
const LINE = `${"word ".repeat(799)}word\n`;
const filler = (n: number) => LINE.repeat(Math.floor(n / (LINE.length + 1))) + "word ".repeat(n).slice(0, n % (LINE.length + 1));

const BASE = { updatedAt: "2026-10-05T00:00:00.000Z", coming: [], chats: [], shipped: [] };
const update = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: "update", title: `Update ${id}`, tag: "Merged", ...extra });
const question = { id: "q1", kind: "decision", title: "Ship it?" };
const AT = "2026-10-05T01:00:00.000Z";

describe("the update card's shape", () => {
  it("takes a thread, a tag and comments, and nothing that asks", () => {
    expect(needSchema.safeParse(update("u1", { thread: "Docs Sync", comments: [{ from: "owner", text: "nice", at: "2026-10-05T00:00:00.000Z" }] })).success).toBe(true);
    for (const asks of [{ options: [{ label: "Yes" }] }, { reply: "text" }, { risk: "money" }]) {
      expect(needSchema.safeParse(update("u1", asks)).success, JSON.stringify(asks)).toBe(false);
    }
  });

  it("keeps thread, tag and comments to update cards", () => {
    for (const news of [{ thread: "main" }, { tag: "Merged" }, { comments: [] }]) {
      expect(needSchema.safeParse({ ...question, ...news }).success, JSON.stringify(news)).toBe(false);
    }
  });

  it("takes Seen or a comment, and only it takes Seen", () => {
    expect(["seen", "comment"].filter((decision) => takesDecision({ kind: "update" }, decision))).toEqual(["seen", "comment"]);
    expect(["approve", "reject", "choice", "done"].some((decision) => takesDecision({ kind: "update" }, decision))).toBe(false);
    expect(takesDecision({ kind: "decision" }, "seen")).toBe(false);
    expect(takesDecision({ kind: "todo" }, "seen")).toBe(false);
  });

  it("is the one card Dismiss does not take: every other kind does", () => {
    expect(takesDecision({ kind: "update" }, "dismiss")).toBe(false);
    for (const kind of ["question", "decision", "approval", "merge-ready", "todo"]) expect(takesDecision({ kind }, "dismiss"), kind).toBe(true);
  });

  it("is a new revision when a comment lands under it", () => {
    const card = needSchema.parse(update("u1", { thread: "main" }));
    expect(needRev({ ...card, comments: [{ from: "rivet", text: "on it", at: "2026-10-05T00:00:00.000Z" }] })).not.toBe(needRev(card));
  });
});

describe("what the server owns on an update card", () => {
  it("fills the thread its writer left out: the app of its PR's Coming row, else its chat, else Rivet", () => {
    const board = {
      ...BASE,
      coming: [{ pr: 4021, title: "Egypt stage", app: "Docs Sync" }, { pr: 7, title: "Blank app", app: " " }],
      needs: [update("a", { pr: 4021, chat: "docs-sync-visual" }), update("b", { pr: 9, chat: "admin-page" }), update("c"), update("d", { thread: "main", pr: 4021 }), update("e", { pr: 7, chat: "fixer" }), question],
    };
    const filled = boardSchema.parse(withServerFields(null, board, AT));
    expect(filled.needs.map((need) => need.thread)).toEqual(["Docs Sync", "admin-page", "Rivet", "main", "fixer", undefined]);
    expect(threadKey("Docs Sync")).toBe(threadKey("docs-sync"));
  });

  it("takes the app from the Coming row of its PR in its own repo, and none from a row two repos claim", () => {
    const markets = "example-org/third-repo";
    const board = {
      ...BASE,
      chats: [{ name: "lab", state: "working", repo: markets, prs: [7] }, { name: "twin", state: "a", prs: [8] }, { name: "twin", state: "b", repo: markets, prs: [8] }],
      coming: [{ pr: 7, title: "Reports seven", chat: "lab", app: "Reports" }, { pr: 8, title: "Twin", chat: "twin", app: "Twin app" }],
      needs: [update("a", { pr: 7, chat: "docs-sync" }), update("b", { pr: 7, chat: "lab", repo: markets }), update("c", { pr: 8, chat: "twin" })],
    };
    const filled = boardSchema.parse(withServerFields(null, board, AT));
    expect(filled.needs.map((need) => need.thread)).toEqual(["docs-sync", "Reports", "twin"]);
  });

  it("keeps the stored comments whatever a write says, so a stale write erases none and no writer speaks for you", () => {
    const said = { from: "owner" as const, text: "why red?", at: "2026-10-05T00:00:00.000Z" };
    const stored = boardSchema.parse({ ...BASE, needs: [update("u", { thread: "main", comments: [said] })] });
    const stale = { ...BASE, needs: [update("u", { thread: "main" })] };
    expect(boardSchema.parse(withServerFields(stored, stale, AT)).needs[0]!.comments).toEqual([said]);
    const forged = { from: "owner", text: "I approved this", at: "2026-10-05T00:02:00.000Z" };
    const sent = { ...BASE, needs: [update("u", { thread: "main", comments: [forged, { from: "rivet", text: "x", at: "z" }] })] };
    expect(boardSchema.parse(withServerFields(stored, sent, AT)).needs[0]!.comments).toEqual([said]);
    expect(boardSchema.parse(withServerFields(null, sent, AT)).needs[0]!.comments).toBeUndefined();
  });

  it("stamps the since its writer left out: the stored card's, else the write's time, and one sent stays as sent", () => {
    const stored = boardSchema.parse({ ...BASE, needs: [update("u", { thread: "main", since: "2026-10-05T00:30:00.000Z" })] });
    const sent = { ...BASE, needs: [update("u", { thread: "main" }), update("v", { thread: "main" }), update("w", { thread: "main", since: "2026-10-05T00:10:00.000Z" }), question] };
    expect(boardSchema.parse(withServerFields(stored, sent, AT)).needs.map((need) => need.since)).toEqual(["2026-10-05T00:30:00.000Z", AT, "2026-10-05T00:10:00.000Z", undefined]);
  });

  it("never stores seen: it is served from the replies", () => {
    const written = withServerFields(null, { ...BASE, needs: [update("u", { thread: "main", seen: true })] }, AT) as { needs: Record<string, unknown>[] };
    expect(written.needs[0]).not.toHaveProperty("seen");
  });
});

describe("an update card written with no since", () => {
  let server: TestServer;
  afterEach(async () => server.close());

  it("is stamped once by the server, by PUT /api/board and PUT /api/board/needs/<id>, and keeps that time on later writes", async () => {
    const clock = fakeClock(Date.parse("2026-10-05T01:00:00.000Z"));
    server = await startServer({}, { now: clock.now });
    const sinceOf = (id: string) => server.app.store.getBoard()!.board.needs.find((need) => need.id === id)?.since;
    // Stored as update cards before the server took new ones as Got it cards (2026-11-01), with no since yet.
    const legacy = (id: string) => {
      const stored = server.app.store.getBoard();
      expect(server.app.store.putBoard({ ...BASE, ...stored?.board, needs: [...(stored?.board.needs ?? []), needSchema.parse(update(id, { thread: "main" }))] }, stored?.version ?? null)).toBeTruthy();
    };
    legacy("a");
    expect((await putBoard(server.base, { ...BASE, needs: [update("a", { thread: "main" })] })).status).toBe(200);
    expect(sinceOf("a")).toBe("2026-10-05T01:00:00.000Z");
    clock.advance(60_000);
    legacy("b");
    const put = (id: string) => fetch(`${server.base}/api/board/needs/${id}`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ kind: "update", title: `Update ${id}`, thread: "main" }) });
    expect((await put("b")).status).toBe(200);
    expect(sinceOf("b")).toBe("2026-10-05T01:01:00.000Z");
    clock.advance(60_000);
    expect((await put("a")).status).toBe(200);
    expect((await putBoard(server.base, server.app.store.getBoard()!.board)).status).toBe(200);
    expect((await putBoard(server.base, { ...BASE, needs: [update("a", { thread: "main" }), update("b", { thread: "main" })] })).status).toBe(200);
    expect([sinceOf("a"), sinceOf("b")]).toEqual(["2026-10-05T01:00:00.000Z", "2026-10-05T01:01:00.000Z"]);
  });
});

describe("the update card's push", () => {
  it("is always quiet and tagged by thread, so a newer one replaces it", () => {
    const card = needSchema.parse(update("u1", { thread: "Docs Sync", tag: "Deployed", ask: "Marker found.", push: "needs-you" }));
    expect(needLevel(card)).toBe("fyi");
    expect(cardPayload(card)).toMatchObject({ tag: "thread-docs-sync", level: "fyi", body: "Deployed · Docs Sync. Marker found.", path: "/?card=u1" });
  });

  it("is one per thread when several land together", () => {
    const needs = [update("a", { thread: "main" }), update("b", { thread: "Main" }), update("c", { thread: "Docs Sync" }), question].map((need) => needSchema.parse(need));
    expect(boardPayloads(needs).map((payload) => payload.card)).toEqual(["b", "c", "q1"]);
  });
});

describe("update cards on the board", () => {
  let server: TestServer;
  let cookie: string;

  beforeEach(async () => {
    server = await startServer();
    cookie = server.cookie();
    expect((await putBoard(server.base, { ...BASE, needs: [question] })).status).toBe(200);
    // Stored as an update card before the server took new ones as Got it cards (2026-11-01).
    const stored = server.app.store.getBoard()!;
    const u1 = needSchema.parse(update("u1", { thread: "main", chat: "fixer", since: new Date().toISOString() }));
    expect(server.app.store.putBoard({ ...stored.board, needs: [...stored.board.needs, u1] }, stored.version)).toBeTruthy();
  });

  afterEach(async () => {
    await server.close();
  });

  const reply = async (decision: string, extra: Record<string, unknown> = {}) =>
    fetch(`${server.base}/api/replies`, {
      method: "POST",
      headers: browser(cookie),
      body: JSON.stringify({ clientId: `client-${decision}-${Math.random().toString(36).slice(2, 10)}`, itemId: "u1", decision, rev: await revOf(server.base, cookie, "u1"), ...extra }),
    });

  it("never counts as needing you", () => {
    const stored = server.app.store.getBoard()!.board;
    expect(openBoard(server.app.store, { failing: () => [] }, stored, new Date())!.needs.map((need) => need.id)).toEqual(["q1"]);
  });

  it("takes Seen as handled at once, sent to no chat and filed in no conversation", async () => {
    const sent: unknown[] = [];
    const send = server.app.bridge.send.bind(server.app.bridge);
    server.app.bridge.send = (r) => (sent.push(r), send(r));
    const res = await reply("seen");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { handled: boolean; id: string };
    expect(body.handled).toBe(true);
    expect(sent).toEqual([]);
    expect(server.app.store.undeliveredReplies()).toEqual([]);
    const conversations = (await (await fetch(`${server.base}/api/conversations`, { headers: browser(cookie) })).json()) as { conversations: { title: string | null }[] };
    expect(conversations.conversations.some((conversation) => conversation.title === "Update u1")).toBe(false);
  });

  it("refuses an update card answering you (an outcome: a decision card), but keeps one stored before", async () => {
    const answered = await fetch(`${server.base}/api/replies`, {
      method: "POST",
      headers: browser(cookie),
      body: JSON.stringify({ clientId: "client-q1-yes", itemId: "q1", decision: "approve", rev: await revOf(server.base, cookie, "q1") }),
    });
    expect(answered.status).toBe(201);
    const { id: answer } = (await answered.json()) as { id: string };
    const card = (body: Record<string, unknown>) =>
      fetch(`${server.base}/api/board/needs/${String(body.id)}?create=only`, { method: "PUT", headers: { ...bearer(BOARD_TOKEN), "content-type": "application/json" }, body: JSON.stringify(body) });
    const refused = await card(update("u2", { replyTo: answer }));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/^card u2 answers one of your asks, so it is not an update card.*--kind decision/);
    expect((await card({ id: "u3", kind: "decision", title: "Shipped", replyTo: answer, options: [{ label: "Yes, keep it" }, { label: "Change it", text: true }] })).status).toBe(200);
    // An update card stored before the rule is left alone: a whole-board write that keeps it as it is passes.
    const stored = server.app.store.getBoard()!;
    expect(server.app.store.putBoard({ ...stored.board, needs: [...stored.board.needs, { ...update("u4", { replyTo: answer }), thread: "main" }] }, stored.version)).toBeTruthy();
    const now = server.app.store.getBoard()!.board;
    expect((await putBoard(server.base, { ...now, updatedAt: "2026-10-06T00:00:00.000Z" })).status).toBe(200);
    // Pointing it at his answer anew is refused.
    expect((await putBoard(server.base, { ...now, needs: now.needs.map((need) => (need.id === "u1" ? { ...need, replyTo: answer } : need)) })).status).toBe(400);
    // A full board refuses it too, before making room would drop it unseen.
    const full = Array.from({ length: MAX_CARDS }, (_, index) => ({ id: `d${index}`, kind: "decision", title: `Decision ${index}` }));
    expect((await putBoard(server.base, { ...BASE, needs: full })).status).toBe(200);
    const atCap = await card(update("u5", { replyTo: answer }));
    expect(atCap.status).toBe(400);
    expect(((await atCap.json()) as { error: string }).error).toMatch(/^card u5 answers one of your asks/);
  });

  it("refuses an answer an update card does not take", async () => {
    expect((await reply("approve")).status).toBe(400);
  });

  it("puts your comment under the card, so the card is new again, and sends it on", async () => {
    const before = await revOf(server.base, cookie, "u1");
    const res = await reply("comment", { text: "what broke it?" });
    expect(res.status).toBe(201);
    const card = server.app.store.getBoard()!.board.needs.find((need) => need.id === "u1")!;
    expect(card.comments).toEqual([expect.objectContaining({ from: "owner", text: "what broke it?" })]);
    expect(await revOf(server.base, cookie, "u1")).not.toBe(before);
    expect(server.app.store.undeliveredReplies().map((r) => r.decision)).toEqual(["comment"]);
  });

  it("takes Rivet's answer from the board token, stamped by the server, so the card is new again", async () => {
    const before = await revOf(server.base, cookie, "u1");
    const note = (id: string, body: unknown, headers = bearer(BOARD_TOKEN)) => fetch(`${server.base}/api/board/needs/${id}/comments`, { method: "POST", headers, body: JSON.stringify(body) });
    const res = await note("u1", { text: " understood ", at: "z", from: "owner" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { item: { comments: unknown[] } }).item.comments).toEqual([{ from: "rivet", text: "understood", at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) }]);
    expect(await revOf(server.base, cookie, "u1")).not.toBe(before);
    expect((await note("u1", { text: "x" }, browser(cookie))).status).toBe(401);
    expect((await note("q1", { text: "x" })).status).toBe(409);
    expect((await note("nope", { text: "x" })).status).toBe(404);
    expect((await note("u1", { text: " " })).status).toBe(400);
  });

  it("puts Rivet's note in the conversation of your comment, as a reply to it, and marks your comment read", async () => {
    const note = (text: string) => fetch(`${server.base}/api/board/needs/u1/comments`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ text }) });
    const notify = vi.spyOn(server.app.push, "notify");
    // No comment from you yet: the line stays under the card alone.
    expect((await note("first")).status).toBe(201);
    const chat = async () => ((await (await fetch(`${server.base}/api/chat?limit=50`, { headers: browser(cookie) })).json()) as ChatPage).messages.filter((one) => one.id !== UPDATES_ID);
    expect(await chat()).toEqual([]);
    const comment = (await (await reply("comment", { text: "what broke it?" })).json()) as { id: string };
    expect((await note("the cache, fixed in #200")).status).toBe(201);
    const messages = await chat();
    expect(new Set(messages.map((one) => one.threadId)).size).toBe(1);
    expect(messages.map((message) => [message.from, message.text, message.replyTo, message.ack?.text])).toEqual([
      ["owner", "Comment: what broke it?", undefined, "replied below"],
      ["rivet", "the cache, fixed in #200", comment.id, undefined],
    ]);
    expect(notify).toHaveBeenCalledTimes(1);
    notify.mockRestore();
  });

  it("refuses Rivet's line on a stale If-Match, and one that would take the board past 1 MB", async () => {
    const version = server.app.store.boardVersion();
    const note = (text: string, ifMatch?: number) =>
      fetch(`${server.base}/api/board/needs/u1/comments`, { method: "POST", headers: { ...bearer(BOARD_TOKEN), ...(ifMatch === undefined ? {} : { "if-match": String(ifMatch) }) }, body: JSON.stringify({ text }) });
    expect((await note("old", version - 1)).status).toBe(409);
    expect((await note("current", version)).status).toBe(201);
    const room = 1_000_000 - Buffer.byteLength(JSON.stringify(server.app.store.getBoard()!.board)) - 600;
    expect((await putBoard(server.base, { ...BASE, needs: [question, update("u1", { thread: "main", notes: filler(room) })] })).status).toBe(200);
    expect((await note("word ".repeat(200))).status).toBe(413);
    expect((await note("fits")).status).toBe(201);
  });

  it("takes a comment after Seen on the same revision, but not a second Seen", async () => {
    const rev = await revOf(server.base, cookie, "u1");
    expect((await reply("seen")).status).toBe(201);
    const again = await reply("seen", { rev });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "This card was already answered.", answered: { decision: "seen" } });
    expect((await reply("comment", { rev, text: "Nice" })).status).toBe(201);
  });

  it("takes one comment after Seen when the board is too full to show it, never a second at that revision", async () => {
    const room = 1_000_000 - Buffer.byteLength(JSON.stringify(server.app.store.getBoard()!.board)) - 600;
    expect((await putBoard(server.base, { ...BASE, needs: [question, update("u1", { thread: "main", chat: "fixer", notes: filler(room) })] })).status).toBe(200);
    const rev = await revOf(server.base, cookie, "u1");
    expect((await reply("seen")).status).toBe(201);
    expect((await reply("comment", { rev, text: "word ".repeat(200) })).status).toBe(201);
    expect(await revOf(server.base, cookie, "u1")).toBe(rev);
    const second = await reply("comment", { rev, text: "and another" });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "This card was already answered.", answered: { decision: "comment" } });
  });

  it("opens no new revision of an update card: it takes a comment instead", async () => {
    const rev = await revOf(server.base, cookie, "u1");
    expect((await reply("seen")).status).toBe(201);
    const res = await fetch(`${server.base}/api/board/needs/u1/again`, { method: "POST", headers: browser(cookie), body: JSON.stringify({ rev }) });
    expect(res.status).toBe(400);
  });

  it("keeps a seen update card on the board for a week, then drops it", async () => {
    expect((await reply("seen")).status).toBe(201);
    const stored = server.app.store.getBoard()!.board;
    const soon = new Date(Date.now() + 7 * 3600_000);
    expect(withoutHandled(server.app.store, stored, soon)).toBeNull();
    const kept = withoutHandled(server.app.store, stored, new Date(Date.now() + UPDATE_KEEP_MS + 60_000));
    expect(kept!.needs.map((need) => need.id)).toEqual(["q1"]);
  });

  it("answers a card written into a full board with that card, after making room", async () => {
    const fill = Array.from({ length: MAX_CARDS - 2 }, (_, i) => update(`n${i}`, { thread: "main", since: new Date(Date.UTC(2026, 9, 5, 0, i)).toISOString() }));
    expect((await putBoard(server.base, { ...BASE, needs: [question, update("u1", { thread: "main", chat: "fixer" }), ...fill] })).status).toBe(200);
    const res = await fetch(`${server.base}/api/board/needs/q-new?create=only`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ kind: "decision", title: "Ship it?" }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { item: { id: string; rev: string } }).item).toMatchObject({ id: "q-new", rev: expect.any(String) });
    expect(server.app.store.getBoard()!.board.needs).toHaveLength(MAX_CARDS);
  });

  it("serves an update card you saw marked seen, however many answers came after", async () => {
    expect((await reply("seen")).status).toBe(201);
    const served = (await (await fetch(`${server.base}/api/board`, { headers: browser(cookie) })).json()) as { board: { needs: { id: string; seen?: true }[] } };
    expect(served.board.needs.map((need) => [need.id, need.seen])).toEqual([["q1", undefined], ["u1", true]]);
  });

  it("makes room past the cap by dropping update cards, the seen and oldest first, never a question", async () => {
    expect((await reply("seen")).status).toBe(201);
    const stored = server.app.store.getBoard()!.board;
    const fresh = Array.from({ length: MAX_CARDS - 1 }, (_, i) => update(`n${i}`, { thread: "main", since: new Date(Date.UTC(2026, 9, 5, 0, i)).toISOString() }));
    const full = { ...stored, needs: [...stored.needs, ...fresh] };
    const roomy = makeCardRoom(server.app.store, full) as { needs: { id: string }[] };
    expect(roomy.needs).toHaveLength(MAX_CARDS);
    expect(roomy.needs.map((need) => need.id)).not.toContain("u1");
    expect(roomy.needs[0]!.id).toBe("q1");
    const fuller = makeCardRoom(server.app.store, { ...full, needs: [...full.needs, update("late", { thread: "main" })] }) as { needs: { id: string }[] };
    expect(fuller.needs.map((need) => need.id)).not.toContain("u1");
    expect(fuller.needs.map((need) => need.id)).toContain("q1");
  });
});
