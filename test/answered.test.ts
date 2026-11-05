import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cardFromReply, type AnsweredResponse } from "../src/shared/answered.js";
import { needSchema, type Reply } from "../src/shared/board.js";
import { Store } from "../src/server/store.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, browser, fakeClock, putBoard, revOf, startServer, type TestServer } from "./helpers.js";

// Cards' Answered list and Reopen: every card you answered is kept 30 days, and any of them reopens,
// its chat told through the bridge.

const BASE = { updatedAt: "2026-10-26T00:00:00.000Z", coming: [], chats: [], shipped: [] };
const plan = { id: "plan-6586", kind: "decision", title: "Rivet review plan", ask: "Go with it?", chat: "cards-progress-2", pr: 6586 };
const other = { id: "q-other", kind: "question", title: "Which day?" };

describe("Answered and Reopen", () => {
  let server: TestServer;
  let cookie: string;
  let clock: ReturnType<typeof fakeClock>;

  beforeEach(async () => {
    clock = fakeClock();
    server = await startServer(undefined, { now: clock.now });
    cookie = server.cookie();
  });

  afterEach(async () => {
    await server.close();
  });

  const answer = async (itemId: string, body: Record<string, unknown>) => {
    const res = await fetch(`${server.base}/api/replies`, {
      method: "POST",
      headers: browser(cookie),
      body: JSON.stringify({ clientId: `client-${Math.random().toString(36).slice(2, 12)}`, itemId, rev: await revOf(server.base, cookie, itemId), ...body }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as Reply;
  };
  const answered = async (headers: Record<string, string> = { cookie }) => {
    const res = await fetch(`${server.base}/api/answered`, { headers });
    expect(res.status).toBe(200);
    return (await res.json()) as AnsweredResponse;
  };
  const reopen = (id: string, rev: string) => fetch(`${server.base}/api/board/needs/${id}/again`, { method: "POST", headers: browser(cookie), body: JSON.stringify({ rev }) });

  /** The bridge's event stream: the events read so far, and a wait for more. */
  async function connect(features: string) {
    const controller = new AbortController();
    const response = await fetch(`${server.base}/api/bridge/events`, { headers: { ...bearer(BRIDGE_TOKEN), "x-rivet-bridge-features": features }, signal: controller.signal });
    expect(response.status).toBe(200);
    let buffer = "";
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
        }
      } catch {
        // aborted
      }
    })();
    const reopens = () =>
      buffer
        .split("\n\n")
        .filter((block) => block.startsWith("event: reopen\n"))
        .map((block) => JSON.parse(block.slice(block.indexOf("data: ") + 6)) as Record<string, unknown>);
    const waitFor = async (count: number) => {
      for (let i = 0; i < 200 && reopens().length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(reopens().length).toBeGreaterThanOrEqual(count);
    };
    return { reopens, waitFor, abort: () => controller.abort() };
  }

  it("keeps an answered card once it leaves the board, with his answer; read with his session only", async () => {
    expect((await putBoard(server.base, { ...BASE, needs: [plan, other] })).status).toBe(200);
    const reply = await answer("plan-6586", { decision: "approve" });
    // Answered and still on the board: the board's copy.
    const onBoard = await answered();
    expect(onBoard.cards).toEqual([{ card: expect.objectContaining({ id: "plan-6586", title: "Rivet review plan", pr: 6586 }), reply: expect.objectContaining({ id: reply.id, decision: "approve" }) }]);
    expect((await putBoard(server.base, { ...BASE, needs: [other] })).status).toBe(200);
    const off = await answered();
    expect(off.cards.map(({ card }) => card.id)).toEqual(["plan-6586"]);
    expect(off.cards[0]!.card.rev).toBe(reply.rev);
    expect(off.reopened).toEqual([]);
    expect((await fetch(`${server.base}/api/answered`)).status).toBe(401);
    expect((await fetch(`${server.base}/api/answered`, { headers: bearer(BOARD_TOKEN) })).status).toBe(401);
  });

  it("never reopens a card Rivet no longer raises: an ask's or a moved time's card", async () => {
    expect((await putBoard(server.base, { ...BASE, needs: [plan] })).status).toBe(200);
    for (const id of ["wait-ask-6535f7edd50e-mvpu11d0", "wait-moved-e2e64b20a15c-mvpu11d0"]) {
      const res = await reopen(id, "r1");
      expect(res.status, id).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/no longer asks/);
    }
    // A card still raised is not refused as retired, one named late- included: no answer yet, so the Reopen's own rule answers.
    expect(((await (await reopen("plan-6586", await revOf(server.base, cookie, "plan-6586"))).json()) as { error: string }).error).not.toMatch(/no longer asks/);
    expect(((await reopen("late-release-choice", "r1")).json() as Promise<{ error: string }>).then((body) => body.error)).resolves.not.toMatch(/no longer asks/);
  });

  it("marks the answered cards whose work is finished: its PR shipped, or the ask naming it live or done; never parked or the others", async () => {
    const later = { id: "plan-later", kind: "decision", title: "Later plan", ask: "Go?", chat: "cards-progress-3" };
    const stopped = { id: "plan-stopped", kind: "decision", title: "Stopped plan", ask: "Go?", chat: "cards-progress-3" };
    expect((await putBoard(server.base, { ...BASE, needs: [plan, other, later, stopped] })).status).toBe(200);
    await answer("plan-6586", { decision: "approve" });
    await answer("q-other", { decision: "comment", text: "Tuesday" });
    await answer("plan-later", { decision: "approve" });
    await answer("plan-stopped", { decision: "approve" });
    const before = await answered();
    expect(before.cards.filter((entry) => entry.done)).toEqual([]);
    expect((await putBoard(server.base, { ...BASE, needs: [], shipped: [{ pr: 6586, title: "Rivet review plan" }] })).status).toBe(200);
    const ask = await fetch(`${server.base}/api/asks`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ id: "later-ask", words: "Later plan", cardId: "plan-later", stage: "done" }) });
    expect(ask.status, await ask.clone().text()).toBe(201);
    const parked = await fetch(`${server.base}/api/asks`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ id: "stopped-ask", words: "Stopped plan", cardId: "plan-stopped", stage: "parked" }) });
    expect(parked.status, await parked.clone().text()).toBe(201);
    const after = await answered();
    expect(Object.fromEntries(after.cards.map((entry) => [entry.card.id, entry.done ?? false]))).toEqual({ "plan-6586": true, "q-other": false, "plan-later": true, "plan-stopped": false });
  });

  it("reopens a card off the board: back on the open deck, its chat told once the bridge acks, the first answer kept", async () => {
    expect((await putBoard(server.base, { ...BASE, needs: [{ ...plan, repo: "example-org/example-repo" }, other] })).status).toBe(200);
    const first = await answer("plan-6586", { decision: "approve" });
    expect((await putBoard(server.base, { ...BASE, needs: [other] })).status).toBe(200);
    const stream = await connect("image,chat-window,changes,reopen");
    const res = await reopen("plan-6586", first.rev);
    expect(res.status).toBe(200);
    const { item } = (await res.json()) as { item: { rev: string; again: unknown } };
    expect(item.again).toEqual({ n: 1, after: first.id, at: expect.any(String) });
    expect(await revOf(server.base, cookie, "plan-6586")).toBe(item.rev);
    // The writer's next push, without it, keeps it: a card the server added stays (push-board.mjs merges it in).
    await stream.waitFor(1);
    const [event] = stream.reopens();
    expect(event).toEqual({ id: expect.any(String), itemId: "plan-6586", title: "Rivet review plan", chat: "cards-progress-2", repo: "example-org/example-repo", at: expect.any(String), earlier: { replyId: first.id, decision: "approve" } });
    // Open again: off Answered, onto the reopened list, the notice pending until its ack.
    const pending = await answered();
    expect(pending.cards).toEqual([]);
    expect(pending.reopened).toEqual([expect.objectContaining({ cardId: "plan-6586", rev: item.rev, replyId: first.id, earlier: expect.objectContaining({ id: first.id }) })]);
    expect(pending.reopened[0]!.delivery).toBeUndefined();
    const ack = (body: unknown, headers = bearer(BRIDGE_TOKEN)) => fetch(`${server.base}/api/bridge/reopen-ack`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await ack({ id: event!.id, delivered: true, confirmed: true }, bearer(BOARD_TOKEN))).status).toBe(401);
    expect((await ack({ id: "nope", delivered: true })).status).toBe(404);
    expect((await ack({ id: event!.id, delivered: true, confirmed: true })).status).toBe(200);
    expect((await answered()).reopened[0]!.delivery).toEqual({ at: expect.any(String), confirmed: true });
    // The new answer is a change of the first; once it is in, the card is answered again at its new revision.
    const changed = await answer("plan-6586", { decision: "comment", text: "Hold it" });
    expect(changed.item.changes).toEqual({ replyId: first.id, decision: "approve" });
    const after = await answered();
    expect(after.cards.map(({ reply }) => reply.id)).toEqual([changed.id]);
    expect(after.reopened).toEqual([]);
    // A tap on a revision no longer kept is refused.
    expect((await reopen("plan-6586", first.rev)).status).toBe(409);
    expect((await reopen("never-kept", first.rev)).status).toBe(404);
    stream.abort();
  });

  it("offers a Reopen's notice again on each connect until a bridge that takes one acks it", async () => {
    expect((await putBoard(server.base, { ...BASE, needs: [plan] })).status).toBe(200);
    const first = await answer("plan-6586", { decision: "reject", text: "Not yet" });
    const old = await connect("image,chat-window,changes");
    expect((await reopen("plan-6586", first.rev)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(old.reopens()).toEqual([]);
    old.abort();
    const updated = await connect("image,chat-window,changes,reopen");
    await updated.waitFor(1);
    expect(updated.reopens()[0]).toMatchObject({ itemId: "plan-6586", earlier: { replyId: first.id, decision: "reject" } });
    updated.abort();
  });

  it("says a notice never delivered in 24 hours was not told, and Send again offers it for another 24", async () => {
    expect((await putBoard(server.base, { ...BASE, needs: [plan] })).status).toBe(200);
    const first = await answer("plan-6586", { decision: "approve" });
    const old = await connect("image,chat-window,changes");
    expect((await reopen("plan-6586", first.rev)).status).toBe(200);
    const [pending] = (await answered()).reopened;
    expect(pending).not.toHaveProperty("expired");
    clock.advance(24 * 3600_000 + 1000);
    const [expired] = (await answered()).reopened;
    expect(expired).toMatchObject({ id: pending!.id, expired: true });
    old.abort();
    // An expired notice is no longer offered on connect.
    const updated = await connect("image,chat-window,changes,reopen");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(updated.reopens()).toEqual([]);
    const send = (id: string, headers = browser(cookie)) => fetch(`${server.base}/api/answered/reopen-send`, { method: "POST", headers, body: JSON.stringify({ id }) });
    expect((await send(pending!.id, { cookie, "content-type": "application/json" })).status).toBe(403);
    expect((await send("nope")).status).toBe(404);
    expect((await send(pending!.id)).status).toBe(200);
    await updated.waitFor(1);
    expect(updated.reopens()[0]).toMatchObject({ id: pending!.id, itemId: "plan-6586", at: pending!.at });
    expect((await answered()).reopened[0]).not.toHaveProperty("expired");
    const ack = await fetch(`${server.base}/api/bridge/reopen-ack`, { method: "POST", headers: { ...bearer(BRIDGE_TOKEN), "content-type": "application/json" }, body: JSON.stringify({ id: pending!.id, delivered: true, confirmed: true }) });
    expect(ack.status).toBe(200);
    expect((await send(pending!.id)).status).toBe(409);
    updated.abort();
  });

  it("refuses a Reopen onto a deck that already holds the most cards a board write takes", async () => {
    expect((await putBoard(server.base, { ...BASE, needs: [plan] })).status).toBe(200);
    const first = await answer("plan-6586", { decision: "approve" });
    const full = Array.from({ length: 200 }, (_, i) => ({ id: `q-${i}`, kind: "question", title: `Which ${i}?` }));
    expect((await putBoard(server.base, { ...BASE, needs: full })).status).toBe(200);
    const stream = await connect("image,chat-window,changes,reopen");
    const res = await reopen("plan-6586", first.rev);
    expect([res.status, await res.json()]).toEqual([409, { error: "the board already holds 200 cards" }]);
    expect((await putBoard(server.base, { ...BASE, needs: full.slice(1) })).status).toBe(200);
    expect((await reopen("plan-6586", first.rev)).status).toBe(200);
    expect((await putBoard(server.base, { ...BASE, needs: full.slice(1) })).status).toBe(200);
    stream.abort();
  });

  it("names the card's chat as it was reopened, though a later write gives the card another", async () => {
    expect((await putBoard(server.base, { ...BASE, needs: [plan] })).status).toBe(200);
    const first = await answer("plan-6586", { decision: "approve" });
    expect((await putBoard(server.base, { ...BASE, needs: [other] })).status).toBe(200);
    // A bridge that takes changes but not the notice: the Reopen lands, its notice waits.
    const older = await connect("image,chat-window,changes");
    expect((await reopen("plan-6586", first.rev)).status).toBe(200);
    older.abort();
    expect((await putBoard(server.base, { ...BASE, needs: [{ ...plan, title: "Someone else's", chat: "another-chat" }, other] })).status).toBe(200);
    const stream = await connect("image,chat-window,changes,reopen");
    await stream.waitFor(1);
    expect(stream.reopens()[0]).toMatchObject({ itemId: "plan-6586", title: "Rivet review plan", chat: "cards-progress-2", earlier: { replyId: first.id } });
    stream.abort();
  });
});

describe("cards answered before the server kept them", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rivet-answered-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rebuilds each from the answer of record to its latest revision, once, so every one shows and reopens", () => {
    const first = new Store(dir);
    const item = { id: "old-plan", kind: "plan", title: "Old plan", ask: "Go?", pr: 6000 } as const;
    first.addReply({ clientId: "c1", itemId: "old-plan", itemTitle: "Old plan", decision: "comment", text: "hm", rev: "a".repeat(16), item });
    const latest = first.addReply({ clientId: "c2", itemId: "old-plan", itemTitle: "Old plan", decision: "approve", rev: "b".repeat(16), item });
    // A second answer to the same revision, from before they were refused: the first stays the answer of record.
    first.addReply({ clientId: "c2b", itemId: "old-plan", itemTitle: "Old plan", decision: "reject", rev: "b".repeat(16), item });
    // From before replies carried a revision: nothing to reopen.
    first.addReply({ clientId: "c5", itemId: "no-rev", itemTitle: "Older", decision: "approve", rev: "", item: { id: "no-rev", kind: "decision", title: "Older" } });
    first.addReply({ clientId: "c3", itemId: "old-update", itemTitle: "Merged", decision: "seen", rev: "c".repeat(16), item: { id: "old-update", kind: "update", title: "Merged" } });
    first.addReply({ clientId: "c4", itemId: "no-kind", itemTitle: "Which?", decision: "comment", text: "Tuesday", rev: "d".repeat(16), item: { id: "no-kind", title: "Which?" } as never });
    first.close();
    const db = new DatabaseSync(join(dir, "rivet.sqlite"));
    db.exec("DELETE FROM answered_cards; DELETE FROM meta WHERE key = 'answered_backfill'");
    db.close();
    const store = new Store(dir);
    const kept = store.keptAnswered(new Date(0).toISOString(), 10);
    expect(kept.map(({ card }) => card.id).sort()).toEqual(["no-kind", "old-plan"]);
    const oldPlan = kept.find(({ card }) => card.id === "old-plan")!;
    expect(oldPlan.rev).toBe("b".repeat(16));
    expect(oldPlan.reply.id).toBe(latest.id);
    expect(needSchema.safeParse(oldPlan.card).success).toBe(true);
    store.close();
  });

  it("gives a card that asked for a yes Yes / Change it and its PR link, and any other card a box to type in", () => {
    const yes = cardFromReply({ itemId: "p", itemTitle: "Plan", item: { id: "p", kind: "merge-ready", title: "Plan", pr: 12, repo: "example-org/example-repo", merge: true } });
    expect(yes).toMatchObject({ kind: "decision", links: [{ label: "PR #12", url: "https://github.com/example-org/example-repo/pull/12" }] });
    expect((yes as { options?: unknown[] }).options?.length).toBeGreaterThan(0);
    expect(yes).not.toHaveProperty("merge");
    const text = cardFromReply({ itemId: "q", itemTitle: "Which day?", item: { id: "q", title: "Which day?" } as never });
    expect(text).toMatchObject({ kind: "question", title: "Which day?" });
    expect(text).not.toHaveProperty("options");
    for (const card of [yes, text]) expect(needSchema.safeParse(card).success).toBe(true);
  });
});

