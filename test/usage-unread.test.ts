import { describe, expect, it } from "vitest";

import { type ClaudeLimit, limitUnread, unreadSince } from "../src/shared/ops.js";

const row = (label: string): ClaudeLimit => ({ kind: "account_1", label, percent: 0, severity: "normal", resetsAt: null, active: false });

// An account with no current reading says when its last one was, and is unread either way.
describe("unread usage rows", () => {
  it("reads 'no reading since' as unread and gives its time", () => {
    expect(limitUnread(row("Account hh*** (active, no reading since 08:04)"))).toBe(true);
    expect(unreadSince(row("Account hh*** (active, no reading since 08:04)"))).toBe("08:04");
    expect(unreadSince(row("Account hh*** (no reading since 19 Nov 23:04)"))).toBe("19 Nov 23:04");
  });

  it("keeps plain 'no reading' and 'old' unread, with no time", () => {
    expect(limitUnread(row("Account hh*** (no reading)"))).toBe(true);
    expect(unreadSince(row("Account hh*** (no reading)"))).toBeNull();
    expect(limitUnread(row("Account hh*** (old)"))).toBe(true);
    expect(limitUnread(row("Account hh*** (active)"))).toBe(false);
    expect(unreadSince(row("Account hh*** (active)"))).toBeNull();
  });
});
