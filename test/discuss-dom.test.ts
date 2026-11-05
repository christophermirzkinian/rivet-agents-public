// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { MAX_CHAT_TEXT } from "../src/shared/command.js";
import { app } from "../web/src/state.js";
import { discussButton, discussPrefix } from "../web/src/views/discuss.js";
import { clearToasts, mountToasts } from "../web/src/views/toast.js";

// Discuss this on an item's pop-up: Chat opens on a new message that names the item.

const PREFIX = discussPrefix("Quote form", "card", ["PR #23"]);

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  app.tab = "progress";
});

describe("Discuss this", () => {
  // First: a draft startDraft holds for a chat that never mounted here would stand in for the stored one.
  it("says so when an unsent message is too long to take the item, and leaves that message as it is", () => {
    const long = "x".repeat(MAX_CHAT_TEXT - 5);
    localStorage.setItem("rivet.chat.draft", long);
    const toasts = document.createElement("div");
    document.body.append(toasts);
    mountToasts(toasts);
    discussButton(PREFIX, () => {}).click();
    expect(app.tab).toBe("chat");
    expect(localStorage.getItem("rivet.chat.draft")).toBe(long);
    expect(toasts.querySelector(".flash.warn")?.textContent).toBe("Your unsent message is too long to add this item to. Send or shorten it first.");
    clearToasts();
    mountToasts(null);
  });
  it("names the item, its kind and refs, as quoted data", () => {
    expect(PREFIX).toBe("About “Quote form” (card, PR #23): ");
    expect(discussPrefix('Fix "it"\nnow \u00abplease\u00bb', "card", ["id c-1"])).toBe("About “Fix it now ’please’” (card, id c-1): ");
  });

  it("closes the pop-up and opens Chat on a new message about the item", () => {
    let closed = 0;
    const btn = discussButton(PREFIX, () => void (closed += 1));
    document.body.append(btn);
    btn.click();
    expect(closed).toBe(1);
    expect(app.tab).toBe("chat");
    expect(localStorage.getItem("rivet.chat.draft")).toBe(PREFIX);
  });

});
