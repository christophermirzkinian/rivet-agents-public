import { describe, expect, it, vi } from "vitest";

import { closeAnswered } from "../web/src/push.js";

/** A registration showing one notification per card id; undefined is a notification with no card in its data. */
function registration(cards: (string | undefined | null)[]) {
  const shown = cards.map((card) => ({ data: card === null ? null : card === undefined ? { path: "/" } : { card, rev: "1" }, close: vi.fn() }));
  return { shown, registration: { getNotifications: async () => shown as unknown as Notification[] } };
}

describe("closeAnswered", () => {
  it("closes every card notification no longer waiting, and never one with no card", async () => {
    const { shown, registration: found } = registration(["a", "b", undefined, null, "c"]);
    await closeAnswered(new Set(["b"]), found);
    expect(shown.map((notification) => notification.close.mock.calls.length)).toEqual([1, 0, 0, 0, 1]);
  });

  it("does nothing without a service worker, or when notifications cannot be read", async () => {
    await expect(closeAnswered(new Set(), null)).resolves.toBeUndefined();
    await expect(closeAnswered(new Set(), { getNotifications: () => Promise.reject(new Error("denied")) })).resolves.toBeUndefined();
  });
});
