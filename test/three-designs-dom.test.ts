// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BehaviourRow } from "../src/shared/behaviours.js";
import type { ServedNeed } from "../src/shared/board.js";
import { THREE_DESIGNS_ID } from "../src/shared/designs.js";
import { app } from "../web/src/state.js";
import { cardMenu } from "../web/src/views/feed.js";
import { menuList } from "../web/src/views/menu.js";
import { noteDesignsRow } from "../web/src/views/three-designs.js";
import { mountToasts } from "../web/src/views/toast.js";

// The "3 designs" button on the phone's card menu and at the menu's foot: shown only while its Behaviours row is on.

const row = (on: boolean) => ({ id: THREE_DESIGNS_ID, value: { on, model: "app-look" }, updatedAt: null }) as unknown as BehaviourRow;
const decision: ServedNeed = { id: "pick", kind: "decision", title: "Pick a look", ask: "Which one?", rev: "r1" };
const update: ServedNeed = { id: "news", kind: "update", title: "Merged", thread: "main", tag: "Merged", rev: "r2" };
const designsIn = (rows: HTMLElement[]) => rows.find((one) => one.matches('[data-use="cards.designs"]'));
const flushed = () => new Promise((resolve) => setTimeout(resolve, 0));

let posted: unknown[];

beforeEach(() => {
  posted = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === "/api/designs") posted.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ask: "a-12", already: posted.length > 1 }), { status: 201, headers: { "content-type": "application/json" } });
    }),
  );
  mountToasts(document.body);
  app.tab = "progress";
  app.morePage = null;
});

afterEach(() => {
  noteDesignsRow(row(false));
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  app.tab = "progress";
  app.morePage = null;
});

describe("3 designs", () => {
  it("is on a decision's card menu only while its row is on, never on an update", async () => {
    expect(designsIn(cardMenu(decision))).toBeUndefined();
    noteDesignsRow(row(true));
    expect(designsIn(cardMenu(update))).toBeUndefined();
    // A Got it card is news stored as a decision; the route's open board leaves it out, so it offers no button either.
    expect(designsIn(cardMenu({ ...decision, id: "news-2", options: [{ label: "Got it" }] }))).toBeUndefined();
    const button = designsIn(cardMenu(decision))!;
    expect(button.textContent).toBe("3 designs");
    button.click();
    await flushed();
    expect(posted).toEqual([{ clientId: expect.stringMatching(/^[A-Za-z0-9_-]{8,100}$/), card: "pick" }]);
    expect(document.querySelector(".toast.flash")?.textContent).toBe("Asked for 3 designs");
    noteDesignsRow(row(false));
    expect(designsIn(cardMenu(decision))).toBeUndefined();
  });

  it("sits at the menu's foot while on and asks for the screen on now", async () => {
    const foot = () => menuList().lastElementChild as HTMLElement;
    expect(foot().dataset.key).not.toBe("designs");
    noteDesignsRow(row(true));
    expect(foot().dataset.key).toBe("designs");
    expect(foot().textContent).toBe("3 designs of this screen");
    app.tab = "more";
    app.morePage = "settings";
    foot().click();
    await flushed();
    app.tab = "chat";
    foot().click();
    await flushed();
    app.tab = "progress";
    app.morePage = null;
    foot().click();
    await flushed();
    expect(posted).toEqual([expect.objectContaining({ screen: "settings" }), expect.objectContaining({ screen: "chat" }), expect.objectContaining({ screen: "main" })]);
    expect(document.querySelector(".toast.flash")?.textContent).toBe("Already asked: a-12");
  });
});
