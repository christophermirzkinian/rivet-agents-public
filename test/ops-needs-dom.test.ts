// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Reply, ServedBoard, ServedNeed } from "../src/shared/board.js";
import { opsData } from "../web/src/ops-data.js";
import { app, deck } from "../web/src/state.js";
import * as ops from "../web/src/views/ops.js";

// The chip used to say 2 needs you, pressing it showed 0. It counted
// the board's cards; the Needs you list it opens leaves out a card he already answered (Rivet drops it later) and a
// card in its undo window. Both now count deck(), as the app badge does; Plan's lede says it.

const NOW = Date.parse("2026-10-01T05:00:00.000Z");

const need = (id: string, rev: string): ServedNeed =>
  ({ id, kind: "approval", title: `pretend card ${id}`, ask: "a pretend question", options: [], rev, since: "2026-10-01T04:00:00.000Z" }) as unknown as ServedNeed;

let root: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  localStorage.clear();
  root = document.createElement("div");
  document.body.replaceChildren(root);
  opsData.at = Date.now();
  const board = { updatedAt: "2026-10-01T04:00:00.000Z", needs: [need("answered", "r1"), need("held", "r2"), need("open", "r3")], coming: [], chats: [], shipped: [] };
  app.board = { version: 1, updatedAt: board.updatedAt, board: board as unknown as ServedBoard } as never;
  // Answered at the card's current rev: it stays on the board until Rivet drops it.
  app.replies.set("answered", { id: "x", itemId: "answered", itemTitle: "", decision: "approve", rev: "r1", at: "2026-10-01T04:30:00.000Z" } as unknown as Reply);
  app.held.add("held");
  app.tab = "progress";
  app.opsPage = "plan";
});

afterEach(() => {
  ops.unmount();
  app.board = null;
  app.replies.clear();
  app.held.clear();
  opsData.ops = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Plan leaves the card count to Cards", () => {
  it("counts the cards Decide shows, not the board's cards", () => {
    ops.mount(root);
    expect(root.querySelector(".plan-lede")).toBeNull();
    expect(deck().map((card) => card.id)).toEqual(["open"]);
  });

  it("has no Plan lede when every card is answered or held", () => {
    app.replies.set("open", { id: "y", itemId: "open", itemTitle: "", decision: "approve", rev: "r3", at: "2026-10-01T04:40:00.000Z" } as unknown as Reply);
    ops.mount(root);
    expect(root.querySelector(".plan-lede")).toBeNull();
    expect(deck()).toEqual([]);
  });
});
