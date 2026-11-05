import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { boardSchema, type OlderUpdatesResponse } from "../src/shared/board.js";
import { keepSeenOnBoard } from "../src/server/routes/updates.js";
import { bearer, BOARD_TOKEN, browser, putBoard, revOf, startServer, type TestServer } from "./helpers.js";

// The Updates stream's Show older: a seen update card is kept as you saw it, and read back off the board.

const BASE = { updatedAt: "2026-10-05T00:00:00.000Z", coming: [], chats: [], shipped: [] };
const update = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: "update", title: `Update ${id}`, tag: "Merged", thread: "Docs Sync", ...extra });
const question = { id: "q1", kind: "decision", title: "Ship it?" };

describe("Show older", () => {
  let server: TestServer;
  let cookie: string;

  beforeEach(async () => {
    server = await startServer();
    cookie = server.cookie();
  });

  afterEach(async () => {
    await server.close();
  });

  const seen = async (id: string) => {
    const res = await fetch(`${server.base}/api/replies`, {
      method: "POST",
      headers: browser(cookie),
      body: JSON.stringify({ clientId: `client-${id}-${Math.random().toString(36).slice(2, 10)}`, itemId: id, decision: "seen", rev: await revOf(server.base, cookie, id) }),
    });
    expect(res.status).toBe(201);
  };
  // Update cards stored before the server took new ones as Got it cards (2026-11-01).
  const legacy = (needs: Record<string, unknown>[]) => {
    const since = new Date().toISOString();
    const board = boardSchema.parse({ ...BASE, needs: needs.map((need) => (need.kind === "update" ? { since, ...need } : need)) });
    expect(server.app.store.putBoard(board, null)).toBeTruthy();
  };
  const older = (query = "", headers: Record<string, string> = { cookie }) => fetch(`${server.base}/api/updates/older${query}`, { headers });
  const page = async (query = "") => {
    const res = await older(query);
    expect(res.status).toBe(200);
    return (await res.json()) as OlderUpdatesResponse;
  };

  it("serves a seen update card once it is off the board, whole: its thread, tag, line and PR", async () => {
    legacy([question, update("u1", { ask: "Deployed at 3pm.", pr: 4200 }), update("u2")]);
    await seen("u1");
    // On the board, it shows in the stream itself.
    expect((await page()).cards).toEqual([]);
    expect((await putBoard(server.base, { ...BASE, needs: [question, update("u2")] })).status).toBe(200);
    const body = await page();
    expect(body.next).toBeNull();
    expect(body.cards).toEqual([
      expect.objectContaining({ id: "u1", kind: "update", title: "Update u1", tag: "Merged", thread: "Docs Sync", ask: "Deployed at 3pm.", pr: 4200, seen: true, rev: expect.stringMatching(/^[0-9a-f]{16}$/), seenAt: expect.any(String) }),
    ]);
  });

  it("reads with your session only: never the board token, never no one", async () => {
    expect((await older("", {})).status).toBe(401);
    expect((await older("", bearer(BOARD_TOKEN))).status).toBe(401);
    expect((await older()).status).toBe(200);
  });

  it("pages the last seen first, and an unseen card that left is not one", async () => {
    legacy([update("a"), update("b"), update("c"), update("d")]);
    for (const id of ["a", "b", "c"]) await seen(id);
    expect((await putBoard(server.base, { ...BASE, needs: [question] })).status).toBe(200);
    const first = await page("?limit=2");
    expect(first.cards.map((card) => card.id)).toEqual(["c", "b"]);
    expect(first.next).toEqual({ before: first.cards[1]!.seenAt, id: "b" });
    const second = await page(`?limit=2&before=${encodeURIComponent(first.next!.before)}&id=${first.next!.id}`);
    expect(second.cards.map((card) => card.id)).toEqual(["a"]);
    expect(second.next).toBeNull();
  });

  it("keeps a card seen before Seen kept it, as the app starts", async () => {
    legacy([update("old")]);
    await seen("old");
    (server.app.store as unknown as { db: { exec(sql: string): void } }).db.exec("DELETE FROM seen_updates");
    keepSeenOnBoard(server.app.store);
    expect((await putBoard(server.base, { ...BASE, needs: [question] })).status).toBe(200);
    expect((await page()).cards.map((card) => card.id)).toEqual(["old"]);
  });

  it("refuses a malformed page", async () => {
    expect((await older("?before=2026-10-01T00:00:00.000Z")).status).toBe(400);
    expect((await older("?before=nope&id=a")).status).toBe(400);
    expect((await older("?before=2026-10-01T00:00:00.000Z&id=../x")).status).toBe(400);
    // A fractional limit reads whole cards, not a SQLite error.
    expect((await older("?limit=1.5")).status).toBe(200);
  });
});
