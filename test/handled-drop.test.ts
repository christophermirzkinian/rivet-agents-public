import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { boardSchema } from "../src/shared/board.js";
import { HANDLED_DROP_MS, needRev, withoutHandled } from "../src/server/http.js";
import { Store } from "../src/server/store.js";
import { EXAMPLE_BOARD } from "./helpers.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "rivet-drop-"));
  const store = new Store(dir);
  let clock = new Date();
  const board = boardSchema.parse(EXAMPLE_BOARD);
  store.putBoard(board, null);
  const answer = (index: number) => {
    const need = board.needs[index]!;
    return store.addReply({ clientId: `client-${need.id}-${Math.random()}`, itemId: need.id, itemTitle: need.title, decision: "comment", rev: needRev(need), item: need });
  };
  const dropHandled = () => {
    const next = withoutHandled(store, store.getBoard()!.board, clock);
    if (next) store.putBoard(next, store.boardVersion());
  };
  const ids = () => store.getBoard()!.board.needs.map((need) => need.id);
  const later = (ms: number) => (clock = new Date(clock.getTime() + ms));
  return { store, board, answer, dropHandled, ids, later };
}

describe("handled cards leave the board", () => {
  it("drops a card six hours after its answer was handled, and keeps one answered but not yet handled", () => {
    const { store, answer, dropHandled, ids, later } = setup();
    store.markHandled(answer(0).id);
    answer(1);
    later(HANDLED_DROP_MS - 60_000);
    dropHandled();
    expect(ids()).toEqual(["pr2022-checkout", "billing-retry"]);
    later(2 * 60_000);
    dropHandled();
    expect(ids()).toEqual(["billing-retry"]);
  });

  it("keeps a card asked again after the handled answer", () => {
    const { store, board, answer, dropHandled, ids, later } = setup();
    store.markHandled(answer(1).id);
    const asked = { ...board, needs: board.needs.map((need) => (need.id === "billing-retry" ? { ...need, title: "Billing retry queue, again" } : need)) };
    store.putBoard(asked, store.boardVersion());
    later(HANDLED_DROP_MS + 60_000);
    dropHandled();
    expect(ids()).toEqual(["pr2022-checkout", "billing-retry"]);
  });
});

describe("needRev and a card's proof", () => {
  it("a changed proof is a new revision, and a card without one keeps its old revision", () => {
    const card = { id: "m", kind: "merge-ready", title: "Merge", ask: "Merge?", pr: 1, headSha: "a".repeat(40) } as Parameters<typeof needRev>[0];
    const clean = needRev({ ...card, evidence: { review: "clean" } } as typeof card);
    expect(needRev({ ...card, evidence: { review: "findings" } } as typeof card)).not.toBe(clean);
    expect(needRev({ ...card })).not.toBe(clean);
    expect(needRev({ ...card, evidence: undefined } as typeof card)).toBe(needRev(card));
  });
});
