import { describe, expect, it, vi } from "vitest";

const closed: Set<string>[] = [];
type Push = typeof import("../web/src/push.js");
vi.mock("../web/src/push.js", async (actual) => ({
  ...((await actual()) as Push),
  closeAnswered: async (keep: Set<string>) => void closed.push(keep),
}));

const { app, closeAnsweredCards } = await import("../web/src/state.js");

describe("closeAnsweredCards and Undo", () => {
  it("keeps the notification of a card whose answer still sits in its Undo window", () => {
    app.held.add("waiting-undo");
    closeAnsweredCards();
    expect(closed.at(-1)?.has("waiting-undo")).toBe(true);
    app.held.delete("waiting-undo");
    closeAnsweredCards();
    expect(closed.at(-1)?.has("waiting-undo")).toBe(false);
  });
});
