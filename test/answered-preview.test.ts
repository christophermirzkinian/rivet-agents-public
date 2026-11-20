// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnsweredResponse } from "../src/shared/answered.js";
import type { Need } from "../src/shared/board.js";

type AnsweredRoute = typeof import("../web/src/views/answered.preview.js")["answeredRoute"];

const NOW = "2026-11-01T12:00:00.000Z";
const SENT_AT = "2026-11-01T12:05:00.000Z";
const OPEN: Need = { id: "open-card", kind: "question", title: "Open card", ask: "Which note should be kept?" };

async function load(search = ""): Promise<AnsweredRoute> {
  history.replaceState(null, "", `/preview/desktop.html${search}`);
  return (await import("../web/src/views/answered.preview.js")).answeredRoute;
}

async function list(route: AnsweredRoute, needs: Need[]): Promise<AnsweredResponse> {
  const response = route("/api/answered", "GET", undefined, needs);
  expect(response?.status).toBe(200);
  return response!.json();
}

beforeEach(() => {
  // The preview reads its query and builds its fixture timestamps when imported.
  vi.resetModules();
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date", "setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  history.replaceState(null, "", "/");
});

describe("the Answered preview routes", () => {
  it("returns null for an unrelated URL without changing the needs", async () => {
    const route = await load();
    const needs: Need[] = [{ ...OPEN }];

    expect(route("/api/other", "POST", undefined, needs)).toBeNull();
    expect(needs).toEqual([OPEN]);
  });

  it("serves empty cards and reopens with ?answered=none", async () => {
    const route = await load("?answered=none");
    const needs: Need[] = [{ ...OPEN }];

    expect(await list(route, needs)).toEqual({ cards: [], reopened: [] });
    expect(needs).toEqual([OPEN]);
  });

  it("refuses to reopen an unknown card without changing the needs or Answered", async () => {
    const route = await load();
    const needs: Need[] = [{ ...OPEN }];
    const before = await list(route, needs);

    const response = route("/api/board/needs/missing-card/again", "POST", undefined, needs);

    expect(response?.status).toBe(404);
    expect(await response!.json()).toEqual({ error: "that card is no longer kept" });
    expect(needs).toEqual([OPEN]);
    expect(await list(route, needs)).toEqual(before);
  });

  it("moves a reopened card from Answered to needs and keeps its original reply id", async () => {
    const route = await load("?told=telling");
    const needs: Need[] = [{ ...OPEN }];
    const before = await list(route, needs);
    const chosen = before.cards[0]!;
    const { rev: previousRev, ...originalNeed } = chosen.card;

    const response = route(`/api/board/needs/${encodeURIComponent(chosen.card.id)}/again`, "POST", undefined, needs);

    expect(response?.status).toBe(200);
    expect(needs).toEqual([OPEN, { ...originalNeed, again: { n: 1, after: chosen.reply.id, at: NOW } }]);
    expect(needs[1]).not.toHaveProperty("rev");
    const result = await response!.json();
    expect(result).toEqual({ version: 2, updatedAt: NOW, item: { ...needs[1], rev: "1111111111111111" } });
    expect(result.item.rev).not.toBe(previousRev);

    const after = await list(route, needs);
    expect(after.cards).toEqual(before.cards.slice(1));
    expect(after.reopened).toEqual([
      {
        id: `reopen-${chosen.card.id}`,
        cardId: chosen.card.id,
        rev: result.item.rev,
        at: NOW,
        replyId: chosen.reply.id,
        title: chosen.card.title,
        chat: chosen.card.chat,
        repo: chosen.card.repo,
        earlier: chosen.reply,
      },
    ]);
  });

  it("marks ?told=not-told expired and confirms Send again at the current fixed time", async () => {
    const route = await load("?told=not-told");
    const needs: Need[] = [{ ...OPEN }];
    const chosen = (await list(route, needs)).cards[0]!;
    expect(route(`/api/board/needs/${chosen.card.id}/again`, "POST", undefined, needs)?.status).toBe(200);
    const reopen = (await list(route, needs)).reopened[0]!;
    expect(reopen).toMatchObject({ cardId: chosen.card.id, at: NOW, expired: true });
    expect(reopen).not.toHaveProperty("delivery");
    const needsBeforeSend = structuredClone(needs);

    vi.setSystemTime(new Date(SENT_AT));
    const response = route("/api/answered/reopen-send", "POST", JSON.stringify({ id: reopen.id }), needs);

    expect(response?.status).toBe(200);
    const sent = await response!.json();
    expect(sent).toMatchObject({ id: reopen.id, at: NOW, sentAt: SENT_AT, delivery: { at: SENT_AT, confirmed: true } });
    expect(sent).not.toHaveProperty("expired");
    expect(needs).toEqual(needsBeforeSend);
    expect((await list(route, needs)).reopened).toEqual([sent]);
  });

  it("drops a reopen from the list when its need is removed", async () => {
    const route = await load("?told=telling");
    const needs: Need[] = [{ ...OPEN }];
    const before = await list(route, needs);
    const chosen = before.cards[0]!;
    expect(route(`/api/board/needs/${chosen.card.id}/again`, "POST", undefined, needs)?.status).toBe(200);
    expect((await list(route, needs)).reopened).toHaveLength(1);

    needs.splice(needs.findIndex((need) => need.id === chosen.card.id), 1);

    expect(needs).toEqual([OPEN]);
    expect(await list(route, needs)).toEqual({ cards: before.cards.slice(1), reopened: [] });
  });
});
