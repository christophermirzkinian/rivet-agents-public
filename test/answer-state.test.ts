import { describe, expect, it, vi } from "vitest";

import type { Reply } from "../src/shared/board.js";
import { answerState } from "../web/src/answer-state.js";

const base: Reply = { id: "r1", itemId: "a", itemTitle: "Card a", decision: "approve", rev: "1", at: "2026-10-20T05:00:00.000Z", handled: false, item: { id: "a", title: "Card a", kind: "approval" } } as Reply;

describe("answerState", () => {
  it("words each state once, Rivet acting on it above every delivery state", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-20T06:00:00.000Z") });
    expect(answerState({ ...base, decision: "seen", handled: true })).toEqual({ text: "Off Cards", tone: "ok" });
    expect(answerState({ ...base, handled: true, actedAt: "2026-10-20T05:10:00.000Z", delivery: { target: "rivet" } } as Reply)).toEqual({
      text: "Acted on by Rivet · 4:10pm",
      tone: "acted",
    });
    expect(answerState({ ...base, delivery: { target: "chat", chat: "zoo", confirmed: false } } as Reply)).toEqual({
      text: "Reached the chat, not confirmed. Check the chat.",
      tone: "warn",
    });
    expect(answerState({ ...base, delivery: { target: "chat", chat: "zoo", confirmed: false, lost: true } } as Reply)).toEqual({
      text: "Didn't reach the chat. Rivet has been told.",
      tone: "warn",
    });
    expect(answerState({ ...base, delivery: { target: "chat", chat: "zoo" } } as Reply).text).toBe("Reached zoo");
    expect(answerState({ ...base, delivery: { target: "rivet" } } as Reply)).toEqual({ text: "Reached Rivet", tone: "ok" });
    expect(answerState({ ...base, error: "tmux pane gone" })).toEqual({ text: "Not delivered yet: tmux pane gone", tone: "warn" });
    expect(answerState({ ...base, error: "x".repeat(200) }).text).toHaveLength("Not delivered yet: ".length + 60);
    expect(answerState(base)).toEqual({ text: "Waiting for the Mac", tone: "wait" });
    expect(answerState(base, true).tone).toBe("wait");
    vi.useRealTimers();
  });
});
