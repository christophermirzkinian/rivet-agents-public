import { describe, expect, it } from "vitest";

import { answeredAsk, answeredDone, answeredShown, cardFromReply, DONE_ASK_STAGES, prKey, type AnsweredCard, type DoneFacts } from "../src/shared/answered.js";
import type { Ask } from "../src/shared/asks.js";
import type { Reply, ServedNeed } from "../src/shared/board.js";
import { answeredChip, askDone, NO_ANSWERED, noAnsweredIn, youSaidCalledOff, youSaidUnderWay } from "../src/shared/words.js";

// Show done on Cards › Answered: which answered cards are finished, and what a chip keeps.

const NOW = Date.parse("2026-10-26T08:00:00.000Z");
const NONE: DoneFacts = { merged: new Set(), finishedCards: new Set() };

function entry(id: string, reply: Partial<Reply> = {}, card: Partial<ServedNeed> = {}, hoursAgo = 1): AnsweredCard {
  return {
    card: { id, kind: "decision", title: `Card ${id}`, rev: "r1", ...card } as ServedNeed,
    reply: { id: `r-${id}`, itemId: id, itemTitle: `Card ${id}`, decision: "approve", rev: "r1", at: new Date(NOW - hoursAgo * 3600_000).toISOString(), handled: true, item: { id, title: `Card ${id}`, kind: "decision" }, ...reply },
  };
}

describe("answeredDone", () => {
  it("is finished when the answer closed it: Done, Dismissed, or an outcome's Yes, keep it", () => {
    expect(answeredDone(entry("a", { decision: "done" }), NONE)).toBe(true);
    expect(answeredDone(entry("a", { decision: "dismiss" }), NONE)).toBe(true);
    expect(answeredDone(entry("a", { decision: "choice", choice: "Yes, keep it" }), NONE)).toBe(true);
    expect(answeredDone(entry("a", { decision: "choice", choice: "Change it" }), NONE)).toBe(false);
    // A merge-ready card's option of the same words only arms a merge.
    expect(answeredDone(entry("a", { decision: "choice", choice: "Yes, keep it" }, { kind: "merge-ready" }), NONE)).toBe(false);
    // Rebuilt from its answer, it is a decision card; the answer still names it merge-ready.
    const rebuilt = { itemId: "old", itemTitle: "Old", decision: "choice" as const, choice: "Yes, keep it", item: { id: "old", title: "Old", kind: "merge-ready", pr: 123 } };
    expect(answeredDone(entry("old", rebuilt, { ...cardFromReply(rebuilt) }), NONE)).toBe(false);
    expect(answeredDone(entry("a", { decision: "approve" }), NONE)).toBe(false);
    expect(answeredDone(entry("a", { decision: "comment", text: "done already" }), NONE)).toBe(false);
  });

  it("is finished when its PR merged, in its own repo", () => {
    const merged = { ...NONE, merged: new Set([prKey(undefined, 6586)]) };
    expect(answeredDone(entry("a", {}, { pr: 6586 }), merged)).toBe(true);
    expect(answeredDone(entry("a", {}, { pr: 6587 }), merged)).toBe(false);
    expect(answeredDone(entry("a", {}, { pr: 6586, repo: "example-org/other-repo" as ServedNeed["repo"] }), merged)).toBe(false);
    // A card rebuilt from its answer alone names its PR on the answer.
    expect(answeredDone(entry("a", { item: { id: "a", title: "Card a", kind: "decision", pr: 6586 } }), merged)).toBe(true);
    expect(prKey(undefined, 1)).toBe("example-org/example-repo#1");
    expect(prKey("Example-Org/Example-Repo", 1)).toBe("example-org/example-repo#1");
  });

  it("is finished when an ask naming it is live or done, never parked", () => {
    expect(DONE_ASK_STAGES).toEqual(["shipped", "done"]);
    expect(answeredDone(entry("plan-x"), { ...NONE, finishedCards: new Set(["plan-x"]) })).toBe(true);
    expect(answeredDone(entry("plan-y"), { ...NONE, finishedCards: new Set(["plan-x"]) })).toBe(false);
  });

  it("never reads the title's words", () => {
    expect(answeredDone(entry("a", {}, { title: "Done: merged and deployed" }), NONE)).toBe(false);
  });
});

describe("answeredShown", () => {
  const list = [entry("new", {}, {}, 1), { ...entry("done", {}, {}, 5), done: true as const }, entry("day", {}, {}, 20), entry("two", {}, {}, 30), entry("old", {}, {}, 72)];
  const ids = (window: Parameters<typeof answeredShown>[1], done: boolean) => answeredShown(list, window, done, NOW).map((one) => one.card.id);

  it("keeps the answers inside the chip's hours, All every one", () => {
    expect(ids(6, true)).toEqual(["new", "done"]);
    expect(ids(24, true)).toEqual(["new", "done", "day"]);
    expect(ids(48, true)).toEqual(["new", "done", "day", "two"]);
    expect(ids(null, true)).toEqual(["new", "done", "day", "two", "old"]);
  });

  it("drops the finished ones while Show done is off", () => {
    expect(ids(6, false)).toEqual(["new"]);
    expect(ids(null, false)).toEqual(["new", "day", "two", "old"]);
  });
});

describe("Answered words", () => {
  it("labels the chips 6h to All, and says why no row is left", () => {
    expect([6, 12, 24, 48, null].map(answeredChip)).toEqual(["6h", "12h", "24h", "48h", "All"]);
    expect(noAnsweredIn(null, 0)).toBe(NO_ANSWERED);
    expect(noAnsweredIn(24, 0)).toBe("No answered cards in the last 24 hours.");
    expect(noAnsweredIn(6, 1)).toBe("The one card answered in the last 6 hours is done.");
    expect(noAnsweredIn(null, 3)).toBe("All 3 cards answered in the last 30 days are done.");
  });

  it("says an answered card under way, done and called off", () => {
    expect(youSaidUnderWay("Yes", "building")).toBe("You said Yes · Building");
    expect(youSaidUnderWay("Change it “slower”", "review")).toBe("You said Change it “slower” · In review");
    expect(youSaidUnderWay("Yes", "needs-you")).toBe("You said Yes · Needs you");
    expect(askDone("deployed with PR 3990")).toBe("Done: deployed with PR 3990");
    expect(askDone()).toBe("Done");
    expect(youSaidCalledOff("Yes", "you kept the old chime")).toBe("You said Yes · Called off: you kept the old chime");
    expect(youSaidCalledOff("Yes")).toBe("You said Yes · Called off");
  });
});

describe("answeredAsk", () => {
  const AT = "2026-11-15T01:00:00.000Z";
  const ask = (stage: Ask["stage"], timeline: Ask["timeline"] = []): Pick<Ask, "id" | "stage" | "stageAt" | "timeline"> => ({ id: "a-1", stage, stageAt: AT, timeline });

  it("is none with no ask, or for a Dismiss", () => {
    expect(answeredAsk({ decision: "approve" }, null)).toBeNull();
    expect(answeredAsk({ decision: "dismiss" }, ask("building"))).toBeNull();
  });

  it("is under way at the ask's stage while it is open", () => {
    for (const stage of ["queued", "building", "push-queue", "review", "needs-you", "merging", "deploying"] as const) {
      expect(answeredAsk({ decision: "approve" }, ask(stage))).toEqual({ state: "underWay", id: "a-1", stage, stageAt: AT });
    }
  });

  it("is done when the ask is live or done, with the note it closed on", () => {
    const closed = ask("done", [
      { at: "2026-11-15T00:00:00.000Z", stage: "building", note: "on it" },
      { at: AT, stage: "done", note: "merged in PR 8170" },
      { at: "2026-11-15T02:00:00.000Z", note: "a later note" },
    ]);
    expect(answeredAsk({ decision: "approve" }, closed)).toEqual({ state: "done", id: "a-1", stage: "done", stageAt: AT, note: "merged in PR 8170" });
    expect(answeredAsk({ decision: "choice" }, ask("shipped"))).toEqual({ state: "done", id: "a-1", stage: "shipped", stageAt: AT });
  });

  it("is called off when the ask is parked, never done", () => {
    expect(answeredAsk({ decision: "approve" }, ask("parked", [{ at: AT, stage: "parked", note: "The owner dropped it" }]))).toEqual({ state: "calledOff", id: "a-1", stage: "parked", stageAt: AT, note: "The owner dropped it" });
    expect(answeredAsk({ decision: "approve" }, ask("parked"))).toEqual({ state: "calledOff", id: "a-1", stage: "parked", stageAt: AT });
  });
});
