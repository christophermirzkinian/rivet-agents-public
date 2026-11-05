// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { MERGE_READY } from "../src/shared/answers.js";
import type { ServedNeed } from "../src/shared/board.js";
import type { ChatMessage } from "../src/shared/command.js";
import { chatBadge } from "../src/shared/conversations.js";
import { answerKind, stopText, thingCards, thingFacts, thingSize, thingStep, type ThingCard } from "../web/src/views/thing.js";

const at = (minute: number) => new Date(Date.UTC(2030, 0, 1, 0, minute)).toISOString();
const posted = (id: string, minute: number, kind: string, title: string, ask?: string): ChatMessage => ({
  id: `p-${id}`,
  from: "rivet",
  text: `Card: ${title}`,
  at: at(minute),
  threadId: "t1",
  posted: { id, kind, title, ...(ask ? { ask } : {}) },
});
const answer = (card: string, minute: number): ChatMessage => ({ id: `a-${card}`, from: "owner", text: "Yes", at: at(minute), threadId: "t1", card });
const need = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: "decision", title: id, ...extra }) as unknown as ServedNeed;
const card = (kind: string, title: string, extra: Partial<ThingCard> = {}): ThingCard => ({ id: title, kind, title, at: at(1), answeredAt: null, ...extra });

describe("a thing's step", () => {
  it("is plan until the plan card is answered, then building", () => {
    expect(thingStep([], null).step).toBe("plan");
    expect(thingStep([card("plan", "Plan: picks row")], null).step).toBe("plan");
    expect(thingStep([card("decision", "Plan: picks row", { answeredAt: at(2) })], null).step).toBe("building");
  });

  it("is building on an open or draft PR, merged once it merges, whatever the cards say", () => {
    expect(thingStep([], { phase: null, stage: "open" }).step).toBe("building");
    expect(thingStep([], { phase: "building", stage: "none" }).step).toBe("building");
    expect(thingStep([card("plan", "Plan")], { phase: null, stage: "merged" }).step).toBe("merged");
    expect(thingStep([], { phase: "deployed", stage: "none" }).step).toBe("merged");
  });

  it("is review on a review card, your look on a card with a video or stills, merged on an answered merge-ready card", () => {
    const plan = card("plan", "Plan", { answeredAt: at(2) });
    expect(thingStep([plan, card("decision", "Review: 3 lenses clean")], null).step).toBe("review");
    expect(thingStep([plan, card("video", "Picks row at 320")], null).step).toBe("look");
    expect(thingStep([plan, card("decision", "Stills", { need: need("x", { media: { kind: "stills", items: [] } }) })], null).step).toBe("look");
    expect(thingStep([plan, card(MERGE_READY, "Merge #706")], null).step).toBe("building");
    expect(thingStep([plan, card(MERGE_READY, "Merge #706", { answeredAt: at(5) })], null).step).toBe("merged");
    expect(thingStep([plan, card("merged", "Merged #706")], null).step).toBe("merged");
  });
});

describe("a thing's facts", () => {
  it("reads its cards in order, each once, with your answer and the board's copy", () => {
    const messages = [posted("plan-1", 1, "plan", "Plan: picks row"), answer("plan-1", 2), posted("plan-1", 3, "plan", "Plan: picks row"), posted("v-1", 4, "video", "Picks row")];
    const cards = thingCards(messages, [need("v-1")]);
    expect(cards.map((one) => [one.id, one.answeredAt, !!one.need])).toEqual([
      ["plan-1", at(2), false],
      ["v-1", null, true],
    ]);
  });

  it("a rejection or a comment is no answer to the step: the plan stays at plan, the merge-ready card is not merged", () => {
    const said = (card: string, minute: number, text: string): ChatMessage => ({ ...answer(card, minute), text });
    const messages = [posted("plan-1", 1, "plan", "Plan: picks row"), said("plan-1", 2, "Rejected: fix and resubmit"), posted("m-1", 3, MERGE_READY, "Merge #706"), said("m-1", 4, "Chose: No")];
    const cards = thingCards(messages, []);
    expect(cards.map((one) => [one.id, one.answeredAt, one.rejectedAt ?? null])).toEqual([
      ["plan-1", null, at(2)],
      ["m-1", null, at(4)],
    ]);
    expect(thingStep(cards, null).step).toBe("plan");
    expect(thingStep([card("plan", "Plan", { answeredAt: at(2) }), card(MERGE_READY, "Merge", { answeredAt: null })], null).step).toBe("building");
    // A no-word is a whole word: "Normal merge" and "Check and merge" are picks, not refusals.
    const picked = thingCards([posted("m-2", 5, MERGE_READY, "Merge #707"), said("m-2", 6, "Chose: Normal merge"), posted("m-3", 7, MERGE_READY, "Merge #708"), said("m-3", 8, "Chose: Check and merge")], []);
    expect(picked.map((one) => [one.id, one.answeredAt, one.rejectedAt ?? null])).toEqual([
      ["m-2", at(6), null],
      ["m-3", at(8), null],
    ]);
  });

  it("takes the ETA from the newest card that has one, the size from the plan card, and the preview link from a card's links", () => {
    const messages = [posted("plan-1", 1, "plan", "Plan: picks row", "Five colour picks. Size M."), posted("b-1", 2, "decision", "Engine wired"), posted("b-2", 3, "decision", "UI next")];
    const board = [
      need("b-1", { eta: "2:30pm", links: [{ label: "preview link", url: "https://app.example/preview/settings" }] }),
      need("b-2", { links: [{ label: "PR", url: "https://github.com/x/y/pull/1" }] }),
    ];
    const facts = thingFacts(messages, board, { phase: null, stage: "open", stagePr: "#706", links: { prs: [], chats: ["settings-page"], tag: null } });
    expect(facts).toMatchObject({ step: "building", eta: "2:30pm", size: "M", lab: "https://app.example/preview/settings", pr: "#706", chat: "settings-page" });
    expect(thingFacts(messages, [], null)).toMatchObject({ eta: null, lab: null, pr: null, chat: null, size: "M" });
  });

  it("reads the size from the plan card's own field first, and only from a plan card", () => {
    expect(thingSize([card("plan", "Plan", { need: need("p", { size: "l" }) })])).toBe("L");
    expect(thingSize([card("plan", "Plan: size S")])).toBe("S");
    expect(thingSize([card("decision", "Copy: size S")])).toBeNull();
    expect(thingSize([card("plan", "Plan: size XL")])).toBeNull();
  });
});

describe("your answer", () => {
  it("reads plain English answers", () => {
    expect(["Chose: Yes, keep it", "Chose: Yes", "Approved: go", "Yes", "Done"].map(answerKind)).toEqual(["yes", "yes", "yes", "yes", "yes"]);
    expect(["Chose: No", "No", "Rejected: fix it"].map(answerKind)).toEqual(["no", "no", "no"]);
    // A choice that holds the merge on the owner is a no.
    expect(["Chose: Held for you", "Chose: Holding for you", "Chose: Waiting on you"].map(answerKind)).toEqual(["no", "no", "no"]);
  });

});

describe("Stop it", () => {
  it("names the chat when one is known", () => {
    expect(stopText("settings-page", "Settings picks")).toBe("Stop settings-page: Settings picks");
    expect(stopText(null, "Settings picks")).toBe("Stop this: Settings picks");
  });
});

describe("the Chat badge", () => {
  const row = (unread: number, thing: boolean, markedUnread = false) => ({ unread, thing, markedUnread });
  it("counts Chat once for all its unread lines, and each thing with an unread reply", () => {
    expect(chatBadge([])).toBe(0);
    expect(chatBadge([row(2, false), row(1, false)])).toBe(1);
    expect(chatBadge([row(0, false), row(1, true), row(3, true), row(0, true)])).toBe(2);
    expect(chatBadge([row(1, false), row(1, true), row(0, true, true)])).toBe(3);
  });
});
