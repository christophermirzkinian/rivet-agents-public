import { describe, expect, it } from "vitest";

import { clock, dayClock, dayDate, dayHeading, wallClock, hourLabel, isToday, maybeWhen, monthName, moved, movedTwice, setTimeZone, shortDate, localDay, weekday, when } from "../src/shared/when.js";
import {
  ALREADY_MERGED,
  CHANGE_IT,
  CHAT_TOLD,
  NO_ANSWERED,
  REOPEN,
  SEND_AGAIN,
  answeredTab,
  openTab,
  reopenedBand,
  youAnswered,
  IN_HAND,
  NEEDS_YOU,
  NOTHING_NEEDS_YOU,
  YES,
  deployedAt,
  doneAt,
  needYou,
  noTimeYet,
  allMinimised,
  showMinimised,
  questionFrom,
  slipped,
  slippedTwice,
  stageWord,
  yourOk,
} from "../src/shared/words.js";

// Mon 26 Oct 2026, 2:00pm in the test zone (UTC+11).
const NOW = Date.parse("2026-10-26T03:00:00Z");
const at = (local: string) => Date.parse(`${local}+11:00`);

describe("when.ts: one time style (§3d)", () => {
  it("writes a 12-hour clock with no space, tilde or capitals", () => {
    expect(clock(at("2026-10-26T18:10:00"))).toBe("6:10pm");
    expect(clock(at("2026-10-26T09:05:00"))).toBe("9:05am");
    expect(clock(at("2026-10-26T00:00:00"))).toBe("12:00am");
    expect(clock(at("2026-10-26T12:30:00"))).toBe("12:30pm");
  });

  it("takes an ISO string, epoch milliseconds or a Date", () => {
    const t = at("2026-10-26T18:10:00");
    expect(clock(new Date(t).toISOString())).toBe("6:10pm");
    expect(clock(new Date(t))).toBe("6:10pm");
  });

  it("says the clock alone today and the weekday on another day", () => {
    expect(when(at("2026-10-26T18:10:00"), NOW)).toBe("6:10pm");
    expect(when(at("2026-10-26T00:05:00"), NOW)).toBe("12:05am");
    expect(when(at("2026-10-27T09:00:00"), NOW)).toBe("Tue 9:00am");
    expect(when(at("2026-10-25T23:59:00"), NOW)).toBe("Sun 11:59pm");
  });

  it("adds the date once a weekday alone would name the wrong week", () => {
    expect(when(at("2026-11-01T09:00:00"), NOW)).toBe("Sun 9:00am");
    expect(when(at("2026-11-03T09:00:00"), NOW)).toBe("Tue 3 Nov 9:00am");
    expect(when(at("2026-10-19T09:00:00"), NOW)).toBe("Mon 19 Oct 9:00am");
  });

  it("counts today by the zone's day, not UTC's or the phone's", () => {
    // 11:30pm UTC Sunday is 10:30am Monday in the zone.
    const morning = Date.parse("2026-10-25T23:30:00Z");
    expect(localDay(morning)).toBe("2026-10-26");
    expect(isToday(morning, NOW)).toBe(true);
    expect(when(morning, NOW)).toBe("10:30am");
    expect(isToday(at("2026-10-25T23:59:00"), NOW)).toBe(false);
  });

  it("stays on the set zone's clock across a daylight-saving change", () => {
    // New York left EDT for EST at 2am on Sun 1 Nov 2026.
    setTimeZone("America/New_York");
    try {
      const before = Date.parse("2026-11-01T04:30:00Z"); // Sun 12:30am EDT (UTC-4)
      const after = Date.parse("2026-11-02T15:00:00Z"); // Mon 10:00am EST (UTC-5)
      expect(when(before, after)).toBe("Sun 12:30am");
      expect(when(after, after)).toBe("10:00am");
      // Summer and winter both land on the wall time given.
      expect(clock("2026-07-01T09:00:00")).toBe("9:00am");
      expect(clock("2026-12-01T09:00:00")).toBe("9:00am");
    } finally {
      setTimeZone(undefined);
    }
  });

  it("says a moved time as the promise and the move", () => {
    expect(moved(at("2026-10-26T19:00:00"), at("2026-10-26T18:10:00"), NOW)).toBe("Now 7:00pm, was 6:10pm");
    expect(moved(at("2026-10-27T09:00:00"), at("2026-10-26T18:10:00"), NOW)).toBe("Now Tue 9:00am, was 6:10pm");
    expect(movedTwice(at("2026-10-26T20:30:00"), NOW)).toBe("Now 8:30pm, moved twice");
  });

  it("reads a zoneless time as the zone's wall clock, whatever the phone's zone", () => {
    expect(when("2026-10-26T18:10:00", NOW)).toBe("6:10pm");
    expect(when("2026-10-26T18:10", NOW)).toBe("6:10pm");
    expect(localDay("2026-10-26")).toBe("2026-10-26");
    expect(when("2026-10-27", NOW)).toBe("Tue 12:00am");
    expect(clock("2026-07-01T09:00:00")).toBe("9:00am");
  });

  it("writes nothing, never throws, for a time past the range a Date can hold", () => {
    expect(clock(8_640_000_000_000_001)).toBe("");
    expect(localDay(-8_640_000_000_000_001)).toBe("");
    expect(when(8_640_000_000_000_001, NOW)).toBe("");
    expect(when(at("2026-10-26T18:10:00"), 8_640_000_000_000_001)).toBe("Mon 26 Oct 6:10pm");
    expect(isToday(NOW, 8_640_000_000_000_001)).toBe(false);
  });

  it("writes nothing, never throws, for a zoneless string that is no real time", () => {
    expect(clock("2026-13-01T09:00")).toBe("");
    expect(clock("2026-10-26T25:00")).toBe("");
    expect(when("2026-02-30", NOW)).toBe("");
  });

  it("reads an expanded-year zoneless time as the zone's too", () => {
    expect(clock("+002026-10-26T18:10:00")).toBe("6:10pm");
  });

  it("keeps centuries apart for years 0-99 and a zone's old seconds offset", () => {
    expect(when("0099-10-26T12:00:00Z", "1999-10-26T12:00:00Z")).not.toBe(clock("0099-10-26T12:00:00Z"));
    // This zone kept local mean time, UTC+11:39:04, until 1868.
    setTimeZone("Pacific/Auckland");
    try {
      expect(localDay("1800-01-01T23:59:30")).toBe("1800-01-01");
    } finally {
      setTimeZone(undefined);
    }
  });

  it("dates both ends of a move a week apart that would share a weekday", () => {
    expect(moved(at("2026-10-27T09:00:00"), at("2026-10-20T09:00:00"), NOW)).toBe("Now Tue 27 Oct 9:00am, was Tue 20 Oct 9:00am");
  });

  it("writes a date without a clock by the zone's calendar", () => {
    // 11:30pm UTC Sunday is Monday 26 Oct in the zone.
    const morning = Date.parse("2026-10-25T23:30:00Z");
    expect(weekday(morning)).toBe("Mon");
    expect(dayClock(morning)).toBe("Mon 10:30am");
    expect(shortDate(morning)).toBe("26 Oct");
    expect(dayDate(morning)).toBe("Mon 26 Oct");
    expect(monthName(morning)).toBe("October");
    expect(monthName(morning, "short")).toBe("Oct");
  });

  it("adds the year to a date only when now is given and the year differs", () => {
    const last = at("2025-12-31T09:00:00");
    expect(shortDate(last)).toBe("31 Dec");
    expect(shortDate(last, NOW)).toBe("31 Dec 2025");
    expect(shortDate(at("2026-10-24T09:00:00"), NOW)).toBe("24 Oct");
    expect(dayDate(last, NOW)).toBe("Wed 31 Dec 2025");
  });

  it("heads a day's group Today, Yesterday, or its weekday and date", () => {
    expect(dayHeading(at("2026-10-26T00:05:00"), NOW)).toBe("Today");
    expect(dayHeading(at("2026-10-25T23:59:00"), NOW)).toBe("Yesterday");
    expect(dayHeading(at("2026-10-24T09:00:00"), NOW)).toBe("Sat 24 Oct");
    expect(dayHeading(at("2025-12-31T09:00:00"), NOW)).toBe("Wed 31 Dec 2025");
    expect(dayHeading("soon", NOW)).toBe("");
  });

  it("shows a wall-clock setting 12-hour, keeping anything else as given", () => {
    expect(["22:00", "07:00", "00:30", "12:00"].map(wallClock)).toEqual(["10:00pm", "7:00am", "12:30am", "12:00pm"]);
    expect(["24:00", "7:00", ""].map(wallClock)).toEqual(["24:00", "7:00", ""]);
  });

  it("labels a chart's hours 12-hour, in the zone", () => {
    expect(hourLabel(at("2026-10-26T18:00:00"))).toBe("6pm");
    expect(hourLabel(at("2026-10-26T00:00:00"))).toBe("12am");
    expect(hourLabel(at("2026-10-26T12:00:00"))).toBe("12pm");
  });

  it("writes nothing for a time that does not parse, never Invalid Date", () => {
    expect([weekday("soon"), dayClock("soon"), shortDate("soon"), dayDate("soon"), monthName("soon"), hourLabel("soon")]).toEqual(["", "", "", "", "", ""]);
    expect(clock("soon")).toBe("");
    expect(when("soon", NOW)).toBe("");
    expect(localDay(Number.NaN)).toBe("");
    expect(isToday("soon", NOW)).toBe(false);
  });

  it("gives a missing stamp as null, and a stamp as when() gives it", () => {
    expect([maybeWhen(undefined), maybeWhen(null), maybeWhen(""), maybeWhen("soon", NOW)]).toEqual([null, null, null, null]);
    expect(maybeWhen(NOW, NOW)).toBe(when(NOW, NOW));
  });
});

describe("words.ts: one word for each state (§3c)", () => {
  it("says nothing waits on you one way", () => {
    expect(NOTHING_NEEDS_YOU).toBe("Nothing needs you.");
    expect(NEEDS_YOU).toBe("Needs you");
    expect(needYou(1)).toBe("1 needs you");
    expect(needYou(3)).toBe("3 need you");
    expect(allMinimised(1)).toBe("1 card waits for you, minimised.");
    expect(allMinimised(15)).toBe("15 cards wait for you, all minimised.");
    expect([showMinimised(1), showMinimised(2)]).toEqual(["Show it ›", "Show them ›"]);
  });

  it("names each stage in hand with one word", () => {
    expect(IN_HAND).toEqual({ building: "Building", "push-queue": "Push queue", review: "In review", merging: "Merging", deploying: "Deploying" });
  });

  it("says a slipped time with its reason on the same line", () => {
    expect(slipped(at("2026-10-26T19:00:00"), at("2026-10-26T18:10:00"), "tests were red", NOW)).toBe(
      "Now 7:00pm, was 6:10pm · tests were red",
    );
    expect(slipped(at("2026-10-26T19:00:00"), at("2026-10-26T18:10:00"), "  ", NOW)).toBe("Now 7:00pm, was 6:10pm");
    expect(slippedTwice(at("2026-10-26T20:30:00"), "deploy queue", NOW)).toBe("Now 8:30pm, moved twice · deploy queue");
    expect(slippedTwice(at("2026-10-26T20:30:00"), undefined, NOW)).toBe("Now 8:30pm, moved twice");
  });

  it("says no time yet with when it was asked", () => {
    expect(noTimeYet(at("2026-10-26T17:42:00"), NOW)).toBe("No time yet, asked 5:42pm");
    expect(noTimeYet()).toBe("No time yet");
  });

  it("says finished as Done or Deployed with the time, never Live", () => {
    expect(doneAt(at("2026-10-26T14:05:00"), NOW)).toBe("Done 2:05pm");
    expect(deployedAt(at("2026-10-25T14:05:00"), NOW)).toBe("Deployed Sun 2:05pm");
  });

  it("has one word for every stage an ask can be in", () => {
    const done = at("2026-10-26T14:05:00");
    expect(stageWord("queued")).toBe("Queued");
    expect(stageWord("building")).toBe("Building");
    expect(stageWord("review")).toBe("In review");
    expect(stageWord("needs-you")).toBe("Needs you");
    expect(stageWord("merging")).toBe("Merging");
    expect(stageWord("deploying")).toBe("Deploying");
    expect(stageWord("parked")).toBe("Parked");
    expect(stageWord("done")).toBe("Done");
    expect(stageWord("done", done, NOW)).toBe("Done 2:05pm");
    expect(stageWord("shipped")).toBe("Deployed");
    expect(stageWord("shipped", done, NOW)).toBe("Deployed 2:05pm");
  });

  it("titles the cards Rivet makes for a wait", () => {
    expect(yourOk("Lobby tiles: new art first")).toBe("Your OK: Lobby tiles: new art first");
    expect(questionFrom("Web Cache: the chart draws 12 new rows")).toBe("Question from Web Cache: the chart draws 12 new rows");
    expect([YES, CHANGE_IT]).toEqual(["Yes", "Change it"]);
  });

  it("words the Answered side of Cards", () => {
    expect([openTab(3), answeredTab(12)]).toEqual(["Open 3", "Answered 12"]);
    expect(youAnswered("Yes", at("2026-10-26T18:10:00"), NOW)).toBe("You: Yes · 6:10pm");
    expect(youAnswered("15 minutes", at("2026-10-25T09:00:00"), NOW)).toBe("You: 15 minutes · Sun 9:00am");
    expect(reopenedBand(at("2026-10-26T13:05:00"), "Yes", NOW)).toBe("Reopened by you at 1:05pm. Your answer was Yes.");
    expect(CHAT_TOLD).toEqual({ told: "Its chat is told.", telling: "Telling its chat…", unconfirmed: "Not confirmed yet.", "not-told": "Its chat was not told." });
    expect([REOPEN, SEND_AGAIN]).toEqual(["Reopen", "Send again"]);
    expect(ALREADY_MERGED).toBe("Already merged; a new answer is a follow-up.");
    expect(NO_ANSWERED).toBe("No answered cards in the last 30 days.");
  });
});
