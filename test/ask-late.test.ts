import { describe, expect, it } from "vitest";

import type { Ask } from "../src/shared/asks.js";
import { askLateId, askOfLateId, asksPastDue } from "../src/server/asks/late.js";
// @ts-expect-error the bridge is plain ESM without type declarations
import { lateAskLine } from "../bridge/lib/bridge.mjs";

const START = Date.parse("2026-10-26T07:00:00.000Z");
const at = (minutes: number) => new Date(START + minutes * 60_000).toISOString();

const ask = (extra: Partial<Ask> = {}): Ask => ({
  id: "a1",
  words: "Fix the Cards count",
  who: "owner",
  stage: "building",
  chat: "cards-fix",
  prs: [],
  dueAt: at(-5),
  dueHistory: [],
  timeline: [],
  createdAt: at(-120),
  stageAt: at(-120),
  updatedAt: at(-120),
  version: 1,
  ...extra,
});

describe("an ask past its time (plan §3h.4)", () => {
  it("picks only asks in hand, past due and not asked yet", () => {
    const now = new Date(START);
    const asks = [
      ask(),
      ask({ id: "a2", dueAt: at(5) }),
      ask({ id: "a3", stage: "done" }),
      ask({ id: "a4", stage: "needs-you" }),
      ask({ id: "a5", askedForTimeAt: at(-1) }),
      ask({ id: "a6", dueAt: undefined }),
      ask({ id: "a7", source: "pickup:ci/ci" }),
      ask({ id: "a8", stage: "parked" }),
    ];
    expect(asksPastDue(asks, now).map((one) => one.id)).toEqual(["a1"]);
  });

  it("names its question by the ask and its time, and reads the ask back from it", () => {
    const id = askLateId(ask({ id: "fix-2-cards" }));
    expect(id).toBe(`ask-late-fix-2-cards-${START - 5 * 60_000}`);
    expect(askOfLateId(id)).toBe("fix-2-cards");
    expect(askOfLateId("3f1c2a4e-late")).toBeNull();
  });
});

describe("the bridge's line for an ask's time question", () => {
  it("names the ask, its chat and the one command for a new time", () => {
    expect(lateAskLine({ kind: "ask", key: "a1", chat: "cards-fix", dueAt: at(-5) })).toBe(
      `Rivet: ask a1 ran past its done-by time (${at(-5)}). Ask chat cards-fix what held it up. Then give it a new time and the cause: rivet ask set a1 --due "<new time>" --why "<cause>". When it is done: rivet ask set a1 --stage done.`,
    );
    expect(lateAskLine({ kind: "ask", key: "a1", dueAt: at(-5) })).toContain("No chat is named on it");
    expect(lateAskLine({ kind: "ask", key: "A 1", dueAt: at(-5) })).toBeNull();
  });
});
