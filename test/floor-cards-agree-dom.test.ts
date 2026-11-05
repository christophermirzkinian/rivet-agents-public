// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Ask } from "../src/shared/asks.js";
import type { Reply, ServedNeed } from "../src/shared/board.js";
import type { Worker } from "../src/shared/workers.js";

// Seven stored cards, each answered at its current revision, and two chats on the map with an ask still at needs-you. The Floor's
// pill, Decide N and Cards must say the same thing.

const ASKS = vi.hoisted(() => ({ open: [] as unknown[] }));
vi.mock("../web/src/views/your-asks.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openAsks: () => ASKS.open,
}));

const R = "example-org/example-repo";
const NOW = Date.now();
const iso = (ago: number) => new Date(NOW - ago * 60_000).toISOString();
const SEVEN: [id: string, rev: string, decision: Reply["decision"]][] = [
  ["out-76b444aa", "a824312710eee7da", "choice"],
  ["out-dc75deca", "8026f137f50ee3a9", "comment"],
  ["keeps-breaking-dc10", "050b1ce88ea6e9f5", "choice"],
  ["out-1bd2869b", "ae29c2216ac23423", "choice"],
  ["out-a1279a2b", "1986d6e22a6023da", "choice"],
  ["out-07eb8de8", "95b8e4ffaf79f055", "choice"],
  ["out-a652a90d", "0d445382e5ceb787", "comment"],
];
const CHATS: Record<string, string> = { "out-a1279a2b": "cover-build", "out-a652a90d": "site-study" };

const need = ([id, rev]: (typeof SEVEN)[number], i: number): ServedNeed =>
  ({ id, rev, kind: "decision", title: `Card ${i + 1}`, ask: "Which one?", since: iso(90 - i), options: [{ label: "Yes" }, { label: "No" }], ...(CHATS[id] ? { chat: CHATS[id] } : {}) }) as ServedNeed;
const reply = ([id, rev, decision]: (typeof SEVEN)[number], i: number): Reply =>
  ({ id: `reply-${id}`, itemId: id, itemTitle: `Card ${i + 1}`, decision, rev, at: iso(60 - i), handled: true }) as Reply;
const worker = (id: string, chat: string): Worker => ({ id, name: id, repo: R, chat, state: "waiting", lastOutputAt: NOW - 30_000 }) as Worker;
const ask = (id: string, chat: string): Ask => ({ id, words: `Ask ${id}`, who: "owner", stage: "needs-you", prs: [], chat, createdAt: iso(120), updatedAt: iso(5) }) as unknown as Ask;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("the Floor and Cards on the board of 4 Nov", async () => {
  const { deskBubble, mountDesks } = await import("../web/src/views/desks.js");
  const { agentLines } = await import("../web/src/views/desks-life.js");
  const { askingCards, cardsOf, openDecide } = await import("../web/src/views/decide-sheet.js");
  const { closeTallSheet } = await import("../web/src/views/sheet.js");
  const { app, changed } = await import("../web/src/state.js");
  const feed = await import("../web/src/views/feed.js");
  let stop = () => {};

  const pills = () => [...document.querySelectorAll(".desk-count")].map((pill) => pill.textContent);
  const seg = (id: string) => document.querySelector(`.decide-seg[data-seg="${id}"]`)?.textContent;

  beforeEach(() => {
    const needs = SEVEN.map(need);
    const answered = { cards: SEVEN.map((row, i) => ({ card: needs[i], reply: reply(row, i) })), reopened: [] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).includes("/api/answered") ? json(answered) : json({ error: "not found" }, 404))));
    app.tab = "progress";
    app.front = null;
    app.held.clear();
    app.board = { version: 1, updatedAt: iso(0), board: { updatedAt: iso(0), needs, coming: [], chats: [], shipped: [] } };
    app.replies.clear();
    SEVEN.forEach((row, i) => app.replies.set(row[0], reply(row, i)));
    app.workersAt = Date.now();
    app.workers = { at: iso(0), workers: [worker("a", "cover-build"), worker("b", "site-study")] };
    ASKS.open = [ask("a-3", "cover-build"), ask("a-4", "site-study")];
    const desks = mountDesks();
    stop = desks.stop;
    document.body.replaceChildren(desks.el);
    changed();
  });

  afterEach(() => {
    closeTallSheet();
    feed.resetFeed();
    stop();
    app.workers = null;
    app.workersAt = null;
    app.board = null;
    app.replies.clear();
    ASKS.open = [];
    changed();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("says no one needs you while every card is answered, though two asks still sit at needs-you", () => {
    expect(askingCards()).toHaveLength(0);
    expect(pills()).toEqual([]);
    expect([...document.querySelectorAll(".desk-agent-meta")].map((meta) => meta.textContent)).toEqual(["Waiting", "Waiting"]);
    expect(document.querySelector(".desk-agent.is-asking")).toBeNull();
  });

  it("keeps Needs you out of the bubble over a chat with no open card, and in it with one", () => {
    const row = ask("a-3", "cover-build");
    expect(agentLines(worker("a", "cover-build"), [], row, false)).toEqual(["Ask a-3"]);
    expect(agentLines(worker("a", "cover-build"), [], row, true)).toEqual(["Needs you: Ask a-3"]);
  });

  it("keeps a Coming item at owner-ok from saying Needs you with no open card, and lets it with one", () => {
    const w = { ...worker("a", "cover-build"), delivering: { title: "Bull Rider plan", stage: "owner-ok" } } as Worker;
    expect(deskBubble(w, [], NOW, false)).toEqual({ text: "Waiting", tone: null });
    expect(deskBubble(w, [], NOW, true).text).toBe("Needs you");
    expect(agentLines(w, [], undefined, false).join(" ")).not.toContain("Needs you");
    expect(agentLines(w, [], undefined, true).join(" ")).toContain("Needs you");
  });

  it("keeps a chat's own stage words from saying Needs you with no open card", () => {
    const w = { ...worker("a", "cover-build"), stage: "Needs you" } as Worker;
    expect(deskBubble(w, [], NOW, false).text).toBe("Waiting");
    expect(agentLines(w, [], undefined, false).join(" ")).not.toContain("Needs you");
    expect(deskBubble({ ...w, stage: "Tuning" } as Worker, [], NOW, false).text).toBe("Tuning");
  });

  it("finds an open card filed under the chat's project by the ask that names it, and takes no other chat's card there", () => {
    const P = "sam/side-repo";
    const w = { ...worker("a", "side-a"), project: P } as Worker;
    const card = (id: string, chat?: string) => ({ ...need(SEVEN[0]!, 0), id, repo: P, ...(chat ? { chat } : {}) }) as ServedNeed;
    const filed = { ...ask("a-1", "side-a"), repo: P, cardId: "named" } as Ask;
    expect(cardsOf(w, [w], [card("named")], [filed]).map((one) => one.id)).toEqual(["named"]);
    expect(cardsOf(w, [w], [card("by-chat", "side-a")], [])).toEqual([]);
  });

  it("keeps both chats on the map, so the fix hides no work", () => {
    expect(document.querySelectorAll(".desk-agent")).toHaveLength(2);
  });

  it("lists all seven under Answered, with Open 0", async () => {
    openDecide([], { answered: true });
    await flush();
    changed();
    await flush();
    expect(seg("open")).toBe("Open 0");
    expect(document.querySelectorAll("[data-reply]")).toHaveLength(7);
  });

  it("counts a card again the moment one is open: the pill, Decide N and Open all say 2", () => {
    app.replies.delete("out-a1279a2b");
    app.replies.delete("out-a652a90d");
    changed();
    expect(askingCards().map((card) => card.id).sort()).toEqual(["out-a1279a2b", "out-a652a90d"]);
    expect(pills()).toEqual(["2 need you"]);
    openDecide(["out-a1279a2b"]);
    expect(seg("open")).toBe("Open 2");
  });
});
