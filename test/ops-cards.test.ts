import { describe, expect, it } from "vitest";

import {
  AUTO_FIX_FAILURES_FOR_CARD,
  cardBreaksQuiet,
  cardId,
  cardReason,
  CARD_REASON_WORDS,
  isMoneyText,
  lateAfterMs,
  LATE_GRACE_MS,
  LATE_OPEN_CAP_MS,
  type CardItem,
} from "../src/shared/ops-cards.js";

const NOW = new Date("2026-10-24T02:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3600_000;
const item = (extra: Partial<CardItem> = {}): CardItem => ({ kind: "ci", key: "build", title: "Build is red", startedAt: ago(60_000), ...extra });

describe("the Ops card rule", () => {
  it("keeps a fresh ordinary item away from Sam", () => {
    expect(cardReason(item(), NOW)).toBeNull();
    expect(cardReason(item({ startedAt: ago(23 * HOUR) }), NOW)).toBeNull();
  });

  it("cards money and billing items at once, by flag or by their words", () => {
    expect(cardReason(item({ money: true }), NOW)).toBe("money");
    expect(cardReason(item({ title: "Invoice failed for notes-app" }), NOW)).toBe("money");
    expect(cardReason(item({ text: "The billing total is out by 3 cents" }), NOW)).toBe("money");
    expect(cardReason(item({ key: "invoice-reconciler" }), NOW)).toBe("money");
    expect(isMoneyText("Subscription renewal refused")).toBe(true);
    expect(isMoneyText("Invoices went negative after a duplicate charge")).toBe(true);
    for (const word of ["money", "billing", "invoice", "invoices", "subscription", "subscriptions"]) expect(isMoneyText(`A ${word} failed`), word).toBe(true);
    // Routine infrastructure words that only look like money.
    expect(isMoneyText("Retired worker withdrawn; replacement booting")).toBe(false);
    expect(isMoneyText("API credits reader: JSON parsing failed")).toBe(false);
    expect(isMoneyText("Upload failed")).toBe(false);
    expect(isMoneyText("Moneybags", "billinged", "unsettled", "better", "debitor")).toBe(false);
    expect(isMoneyText("Scans the code for known security problems.")).toBe(false);
  });

  it("cards a hold Sam placed, a decision, and an auto-fix that failed twice", () => {
    expect(cardReason(item({ hold: true }), NOW)).toBe("hold");
    expect(cardReason(item({ decision: true }), NOW)).toBe("decision");
    expect(cardReason(item({ autoFixFailures: AUTO_FIX_FAILURES_FOR_CARD - 1 }), NOW)).toBeNull();
    expect(cardReason(item({ autoFixFailures: AUTO_FIX_FAILURES_FOR_CARD }), NOW)).toBe("fix-failed");
  });

  it("cards an app only once it is still down 15 minutes into a record Rivet holds", () => {
    expect(cardReason(item({ kind: "app", down: true }), NOW)).toBeNull();
    expect(cardReason(item({ kind: "app", down: true, rivetRecordSince: ago(14 * 60_000) }), NOW)).toBeNull();
    expect(cardReason(item({ kind: "app", down: true, rivetRecordSince: ago(16 * 60_000) }), NOW)).toBe("app-down");
    expect(cardReason(item({ kind: "app", down: false, rivetRecordSince: ago(16 * 60_000) }), NOW)).toBeNull();
  });

  it("says Rivet picked up an app down, never that it restarted one or is working on it: its pick-up only opens a fix chat", () => {
    expect(CARD_REASON_WORDS["app-down"]).toBe("Rivet picked it up, and the app is still down over 15 minutes in.");
  });

  it("cards a late item once its done-by time has passed by the grace, whatever its age; 24 hours with none", () => {
    const startedAt = ago(5 * HOUR);
    const due = (hours: number) => new Date(NOW.getTime() - 5 * HOUR + hours * HOUR).toISOString();
    expect(lateAfterMs({ startedAt, dueAt: due(2) })).toBe(2 * HOUR + LATE_GRACE_MS);
    expect(cardReason(item({ startedAt, dueAt: due(2) }), NOW)).toBe("late");
    // Missed an hour ago: still inside the grace.
    expect(cardReason(item({ startedAt, dueAt: due(4) }), NOW)).toBeNull();
    // Missed by more than the grace: late, well under 24 hours.
    expect(cardReason(item({ startedAt: ago(10 * HOUR), dueAt: ago(3 * HOUR) }), NOW)).toBe("late");
    expect(cardReason(item({ startedAt: ago(25 * HOUR), dueAt: ago(5 * HOUR) }), NOW)).toBe("late");
    // A done-by time still ahead is never late, however long the item has been open.
    expect(cardReason(item({ startedAt: ago(30 * HOUR), dueAt: ago(-HOUR) }), NOW)).toBeNull();
    expect(cardReason(item({ startedAt: ago(48 * HOUR), dueAt: ago(-20 * HOUR) }), NOW)).toBeNull();
    // No done-by time: 24 hours.
    expect(lateAfterMs({ startedAt })).toBe(24 * HOUR);
    expect(cardReason(item({ startedAt: ago(23 * HOUR) }), NOW)).toBeNull();
    expect(cardReason(item({ startedAt: ago(25 * HOUR) }), NOW)).toBe("late");
    // A done-by time before the start is no plan at all.
    expect(lateAfterMs({ startedAt, dueAt: ago(9 * HOUR) })).toBe(24 * HOUR);
  });

  it("still cards an item open 72 hours, so a done-by time moved on before each one passes cannot hold it back for ever", () => {
    const ahead = ago(-2 * HOUR);
    expect(lateAfterMs({ startedAt: ago(100 * HOUR), dueAt: ahead })).toBe(LATE_OPEN_CAP_MS);
    expect(cardReason(item({ startedAt: ago(LATE_OPEN_CAP_MS - 60_000), dueAt: ahead }), NOW)).toBeNull();
    expect(cardReason(item({ startedAt: ago(LATE_OPEN_CAP_MS + 60_000), dueAt: ahead }), NOW)).toBe("late");
  });

  it("keeps two owned items off Sam's board while their done-by time is ahead", () => {
    const dueAt = "2026-10-25T03:00:00.000Z";
    const pr = item({ kind: "pr", key: "6381", title: "Nightly backup cores", startedAt: "2026-10-24T07:09:27.806Z", dueAt });
    const coming = item({ kind: "coming", key: "nightly-backup-cores", title: "Nightly backup cores", startedAt: "2026-10-23T21:07:03.211Z", dueAt });
    for (const at of ["2026-10-24T21:15:00.000Z", "2026-10-25T02:59:00.000Z", "2026-10-25T04:59:00.000Z"]) {
      expect(cardReason(pr, new Date(at)), at).toBeNull();
      expect(cardReason(coming, new Date(at)), at).toBeNull();
    }
    // Once the done-by time has passed by the grace, both may card.
    expect(cardReason(pr, new Date("2026-10-25T05:01:00.000Z"))).toBe("late");
    expect(cardReason(coming, new Date("2026-10-25T05:01:00.000Z"))).toBe("late");
  });

  it("tries the reasons in order: an app down beats money, money beats a hold, a hold beats late", () => {
    // A qualifying app down always breaks quiet hours, even with a money word in its note.
    expect(cardReason(item({ kind: "app", down: true, rivetRecordSince: ago(16 * 60_000), text: "billing check failing" }), NOW)).toBe("app-down");
    expect(cardReason(item({ money: true, hold: true }), NOW)).toBe("money");
    expect(cardReason(item({ hold: true, startedAt: ago(48 * HOUR) }), NOW)).toBe("hold");
  });

  it("lets only an app down break quiet hours; the rest wait for the digest", () => {
    expect(cardBreaksQuiet("app-down")).toBe(true);
    for (const reason of ["money", "hold", "decision", "fix-failed", "late"] as const) expect(cardBreaksQuiet(reason)).toBe(false);
  });

  it("names an item's one card from the item alone, so a later pass updates it", () => {
    const one = cardId({ kind: "ci", key: "build" });
    expect(cardId({ kind: "ci", key: "build" })).toBe(one);
    expect(one).toMatch(/^ops-card-ci-build-[0-9a-z]{7}$/);
    expect(cardId({ kind: "pr", key: "build" })).not.toBe(one);
    // A reopened key is a new incident with a new card.
    const first = cardId({ kind: "ci", key: "build", incident: "2026-10-24T01:00:00.000Z" });
    expect(cardId({ kind: "ci", key: "build", incident: "2026-10-24T01:00:00.000Z" })).toBe(first);
    expect(cardId({ kind: "ci", key: "build", incident: "2026-10-25T01:00:00.000Z" })).not.toBe(first);
    // A card withdrawn and back is a new card: each generation has its own id, and the first is unchanged.
    expect(cardId({ kind: "ci", key: "build", incident: "i1", generation: 0 })).toBe(cardId({ kind: "ci", key: "build", incident: "i1" }));
    const second = cardId({ kind: "ci", key: "build", incident: "i1", generation: 1 });
    expect(second).not.toBe(cardId({ kind: "ci", key: "build", incident: "i1" }));
    expect(cardId({ kind: "ci", key: "build", incident: "i1", generation: 2 })).not.toBe(second);
    const long = "a".repeat(60);
    expect(cardId({ kind: "ci", key: `${long}x` })).not.toBe(cardId({ kind: "ci", key: `${long}y` }));
    const repo = ["example-org", "Example Repo"].join("/");
    expect(cardId({ kind: "pr", key: `${repo}#12` })).toMatch(/^[A-Za-z0-9._-]{1,100}$/);
  });
});
