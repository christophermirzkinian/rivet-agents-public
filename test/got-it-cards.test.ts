import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GOT_IT } from "../src/shared/answers.js";
import { MAX_CARDS, openBoard, makeCardRoom } from "../src/server/http.js";
import { bearer, BOARD_TOKEN, browser, putBoard, revOf, startServer, type TestServer } from "./helpers.js";

// Whatever a writer sends as an
// update (or as a kind-less card), the board stores a decision card with one option, "Got it", and that tap drops it.
const BASE = { updatedAt: "2026-11-01T00:00:00.000Z", coming: [], chats: [], shipped: [] };
const question = { id: "q1", kind: "decision", title: "Ship it?" };

describe("a card written as an update", () => {
  let server: TestServer;
  let cookie: string;

  beforeEach(async () => {
    server = await startServer();
    cookie = server.cookie();
    expect((await putBoard(server.base, { ...BASE, needs: [question] })).status).toBe(200);
  });

  afterEach(async () => {
    await server.close();
  });

  const stored = (id: string) => server.app.store.getBoard()!.board.needs.find((need) => need.id === id);
  const putNeed = (id: string, body: Record<string, unknown>) =>
    fetch(`${server.base}/api/board/needs/${id}?create=only`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) });
  const tap = async (id: string, decision: string, extra: Record<string, unknown> = {}) =>
    fetch(`${server.base}/api/replies`, {
      method: "POST",
      headers: browser(cookie),
      body: JSON.stringify({ clientId: `client-${id}-${Math.random().toString(36).slice(2, 10)}`, itemId: id, decision, rev: await revOf(server.base, cookie, id), ...extra }),
    });

  it("is stored as a decision card with one option, Got it, its tag leading its title", async () => {
    expect((await putNeed("u1", { kind: "update", title: "#931 merged", tag: "Merged", thread: "Lobby", ask: "Deploying next." })).status).toBe(200);
    const card = stored("u1")!;
    expect(card).toMatchObject({ kind: "decision", title: "Merged: #931 merged", ask: "Deploying next.", options: [{ label: GOT_IT }] });
    expect(card).not.toHaveProperty("thread");
    expect(card).not.toHaveProperty("tag");
  });

  it("is a Got it card from a whole-board write too, while an update card stored before is left as it is", async () => {
    const board = server.app.store.getBoard()!;
    expect(server.app.store.putBoard({ ...board.board, needs: [...board.board.needs, { id: "old", kind: "update", title: "Old news", thread: "main" }] }, board.version)).toBeTruthy();
    const now = server.app.store.getBoard()!.board;
    expect((await putBoard(server.base, { ...now, needs: [...now.needs, { id: "new", kind: "update", title: "Fresh news" }] })).status).toBe(200);
    expect(stored("old")).toMatchObject({ kind: "update", title: "Old news" });
    expect(stored("new")).toMatchObject({ kind: "decision", title: "Fresh news", options: [{ label: GOT_IT }] });
  });

  it("is a Got it card when say.mjs posts news, and an outcome still takes Yes, keep it and Change it", async () => {
    const say = (body: object) => fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) });
    const res = await say({ text: "Nightly ran clean", tag: "Nightly" });
    expect(res.status).toBe(201);
    const news = server.app.store.getBoard()!.board.needs.find((need) => need.id.startsWith("upd-"))!;
    expect(news).toMatchObject({ kind: "decision", options: [{ label: GOT_IT }] });
    expect(news.title).toMatch(/^Nightly: /);
  });

  it("drops off the board at one tap of Got it, sending nothing to a chat", async () => {
    expect((await putNeed("u1", { kind: "update", title: "Deployed", chat: "fixer" })).status).toBe(200);
    const sent: unknown[] = [];
    const send = server.app.bridge.send.bind(server.app.bridge);
    server.app.bridge.send = (reply) => (sent.push(reply), send(reply));
    const res = await tap("u1", "choice", { choice: GOT_IT });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { handled: boolean }).handled).toBe(true);
    expect(sent).toEqual([]);
    expect(server.app.store.undeliveredReplies()).toEqual([]);
    expect(stored("u1")).toBeUndefined();
    expect(stored("q1")).toBeDefined();
  });

  it("never counts as needing you, as it is news, and makes room on a full board before any question", async () => {
    expect((await putNeed("u1", { kind: "update", title: "Deployed" })).status).toBe(200);
    const board = server.app.store.getBoard()!.board;
    expect(openBoard(server.app.store, { failing: () => [] }, board, new Date())!.needs.map((need) => need.id)).toEqual(["q1"]);
    const questions = Array.from({ length: MAX_CARDS - 1 }, (_, index) => ({ id: `d${index}`, kind: "decision", title: `Decision ${index}` }));
    const roomy = makeCardRoom(server.app.store, { ...board, needs: [...board.needs, ...questions] }) as { needs: { id: string }[] };
    expect(roomy.needs).toHaveLength(MAX_CARDS);
    expect(roomy.needs.map((need) => need.id)).not.toContain("u1");
  });

  it("is dated and quiet when written with no since or push, so a full board drops older news first", async () => {
    expect((await putNeed("u1", { kind: "update", title: "Deployed" })).status).toBe(200);
    expect((await putNeed("g1", { kind: "decision", title: "News", options: [{ label: GOT_IT }] })).status).toBe(200);
    expect(stored("u1")).toMatchObject({ push: "fyi", since: expect.any(String) });
    expect(stored("g1")).toMatchObject({ push: "fyi", since: expect.any(String) });
  });

  it("files no message in a conversation at a tap of Got it", async () => {
    expect((await putNeed("u1", { kind: "update", title: "Deployed", chat: "fixer" })).status).toBe(200);
    const res = await tap("u1", "choice", { choice: GOT_IT });
    expect(res.status).toBe(201);
    const listed = async (query: string) => JSON.stringify(await (await fetch(`${server.base}/api/conversations${query}`, { headers: browser(cookie) })).json());
    expect(await listed("")).not.toContain("Got it");
    expect(await listed("?older=1")).not.toContain("Got it");
  });

  it("files no message when the same tap is retried after the card left", async () => {
    expect((await putNeed("u1", { kind: "update", title: "Deployed", chat: "fixer" })).status).toBe(200);
    const body = JSON.stringify({ clientId: "client-retry-1", itemId: "u1", decision: "choice", choice: GOT_IT, rev: await revOf(server.base, cookie, "u1") });
    const post = () => fetch(`${server.base}/api/replies`, { method: "POST", headers: browser(cookie), body });
    expect((await post()).status).toBe(201);
    expect(stored("u1")).toBeUndefined();
    expect((await post()).status).toBeLessThan(300);
    // Again once its id has gone to another card.
    expect((await putNeed("u1", { kind: "decision", title: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] })).status).toBe(200);
    expect((await post()).status).toBeLessThan(300);
    const listed = async (query: string) => JSON.stringify(await (await fetch(`${server.base}/api/conversations${query}`, { headers: browser(cookie) })).json());
    expect(await listed("")).not.toContain("Got it");
    expect(await listed("?older=1")).not.toContain("Got it");
  });

  it("sends a note written with Got it on to its chat, and still drops the card", async () => {
    expect((await putNeed("u1", { kind: "update", title: "Deployed", chat: "fixer" })).status).toBe(200);
    const res = await tap("u1", "choice", { choice: GOT_IT, text: "tell Sam too" });
    expect(res.status).toBe(201);
    expect(server.app.store.undeliveredReplies().map((reply) => reply.text)).toEqual(["tell Sam too"]);
    expect(stored("u1")).toBeUndefined();
  });

  it("is refused when it answers one of your asks, sent as an update or as a Got it card: an outcome keeps Yes, keep it / Change it", async () => {
    const answered = await tap("q1", "approve");
    expect(answered.status).toBe(201);
    const { id: answer } = (await answered.json()) as { id: string };
    const asUpdate = await putNeed("o1", { kind: "update", title: "Shipped", replyTo: answer });
    expect(asUpdate.status).toBe(400);
    const asGotIt = await putNeed("o2", { kind: "decision", title: "Shipped", replyTo: answer, options: [{ label: GOT_IT }] });
    expect(asGotIt.status).toBe(400);
    expect(((await asGotIt.json()) as { error: string }).error).toMatch(/^card o2 answers one of your asks/);
  });

  it("redacts a title its tag joins into a secret", async () => {
    expect((await putNeed("u1", { kind: "update", tag: "password", title: "correct horse battery staple" })).status).toBe(200);
    expect(stored("u1")!.title).toBe("password: [redacted]");
  });

  it("refuses a card whose option is null with a 400, not a crash", async () => {
    expect((await putNeed("bad", { kind: "decision", title: "Pick one", options: [null] })).status).toBe(400);
  });

  it("still takes a comment, sent on to its chat like any decision card's", async () => {
    expect((await putNeed("u1", { kind: "update", title: "Deployed", chat: "fixer" })).status).toBe(200);
    const res = await tap("u1", "comment", { text: "why so slow?" });
    expect(res.status).toBe(201);
    expect(server.app.store.undeliveredReplies().map((reply) => reply.decision)).toEqual(["comment"]);
    expect(stored("u1")).toBeDefined();
  });
});
