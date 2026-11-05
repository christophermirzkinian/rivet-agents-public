import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Store, type UsageEventRow } from "../src/server/store.js";
import { createUsageAsks, readable, reworkOf, usageReport } from "../src/server/usage-report.js";
import { FOLD_IDS, LISTED_IDS, UNDO_IDS, type UsageDevice, type UsageReport } from "../src/shared/usage-ids.js";
import { browser, fakeClock, ORIGIN, startServer, type TestServer } from "./helpers.js";

// More › What you used (Sam, 27 Oct): the counts, the never-used list and its 30-day rules, Rework?, Keep for 90 days,
// and the Monday pass's at most 3 Retire? cards a week from Mon 30 Nov.

const DAY = 24 * 60 * 60 * 1000;
const at = (iso: string, plusMs = 0) => new Date(Date.parse(iso) + plusMs).toISOString();
const tap = (when: string, ctl: string, screen = "cards", device: UsageDevice = "phone"): UsageEventRow => ({ at: when, device, kind: "tap", ctl, screen, value: 0 });
const screen = (when: string, id: string, ms: number, device: UsageDevice = "phone"): UsageEventRow => ({ at: when, device, kind: "screen", ctl: id, screen: id, value: ms });
const ids = (rows: { id: string }[] | null) => (rows ?? []).map((row) => row.id);

describe("the What you used report", () => {
  // Recording began 28 Oct 00:00 local (27 Oct 13:00Z); 28 Nov 00:00Z is 31 full days on.
  const first = "2026-10-27T13:00:00.000Z";
  const report = (events: UsageEventRow[], now: string, device: UsageDevice = "phone", from = first) => usageReport({ events, first: from, asks: [], device, now: new Date(now) });

  it("lists every listed id no device used in 30 days, and counts often and rarely per device", () => {
    const events = [
      tap("2026-11-20T01:00:00.000Z", "cards.minimise", "cards", "desktop"),
      ...Array.from({ length: 5 }, (_, i) => tap(at("2026-11-21T01:00:00.000Z", i * DAY), "cards.answer.choice", "decide")),
      tap("2026-11-25T01:00:00.000Z", "dictation.mic", "chat"),
    ];
    const read = report(events, "2026-11-28T00:00:00.000Z");
    expect(read).toMatchObject({ device: "phone", since: "2026-10-28", recorded: 31, days: 30, taps: 6, daysUsed: 5 });
    expect(read.often).toEqual([{ id: "cards.answer.choice", label: "Answer a card", where: "Cards", count: 5, last: "2026-11-25" }]);
    expect(read.rarely).toEqual([{ id: "dictation.mic", label: "Dictation mic", where: "Anywhere", count: 1, last: "2026-11-25" }]);
    const never = ids(read.never);
    // Used on the computer only still counts as used; a meta id, a card outcome and a signed-out id are never listed.
    for (const used of ["cards.minimise", "cards.answer.choice", "dictation.mic", "unknown", "unnamed", "gate.signin", "card.decision.choice"]) expect(never).not.toContain(used);
    expect(never).toContain("toast.undo");
    expect(never).toContain("worker");
    expect(read.never!.every((row) => row.count === 0 && LISTED_IDS.some((entry) => entry.id === row.id))).toBe(true);
    // The computer's own counts.
    expect(report(events, "2026-11-28T00:00:00.000Z", "desktop").rarely.map((row) => row.id)).toEqual(["cards.minimise"]);
  });

  it("counts a phone's Decide and Rivet sheets as the Cards and Chat they show, and Decide's Answered as Answered", () => {
    const tabs = ["cards", "answered", "chat"];
    expect(ids(report([tap("2026-11-25T01:00:00.000Z", "cards.answer.choice", "decide")], "2026-11-28T00:00:00.000Z").never)).toEqual(expect.arrayContaining(tabs));
    const sheets = ["decide", "floor.rivet"].map((id, i) => screen(at("2026-11-25T01:00:00.000Z", i * 60_000), id, 20_000));
    const never = ids(report(sheets, "2026-11-28T00:00:00.000Z").never);
    for (const id of ["cards", "chat"]) expect(never).not.toContain(id);
    // Decide answering open cards only never opened Answered.
    expect(never).toContain("answered");
    expect(never).toContain("progress");
    expect(ids(report([...sheets, tap("2026-11-25T02:00:00.000Z", "decide.seg.answered", "decide")], "2026-11-28T00:00:00.000Z").never)).not.toContain("answered");
  });

  it("keeps the top 10 by count, each with its uses a day", () => {
    const busy = LISTED_IDS.filter((entry) => entry.kind === "control").slice(0, 12);
    const events = busy.flatMap((entry, i) => Array.from({ length: 4 + i * 30 }, (_, n) => tap(at("2026-11-01T00:00:00.000Z", n * 60_000), entry.id)));
    const read = report(events, "2026-11-28T00:00:00.000Z");
    expect(read.often.map((row) => row.id)).toEqual(busy.slice(2).reverse().map((entry) => entry.id));
    expect(read.often[0]).toMatchObject({ count: 334, perDay: 11 });
    expect(read.often.at(-1)!.perDay).toBe(2);
    expect(read.rarely).toEqual([]);
  });

  it("leaves an id out until 30 days after it was added, recording's start counting as the first", () => {
    const events = [tap("2026-11-27T01:00:00.000Z", "cards.answer.choice", "decide")];
    // used.retire was added 30 Oct (29 Oct 13:00Z): listed from 28 Nov 13:00Z, not before.
    expect(ids(report(events, "2026-11-28T12:59:00.000Z").never)).not.toContain("used.retire");
    expect(ids(report(events, "2026-11-28T13:00:00.000Z").never)).toContain("used.retire");
    // An id added before recording began waits 30 days from recording's start, so the page lists nothing before then.
    expect(report(events, "2026-11-26T12:59:00.000Z").never).toBeNull();
    expect(ids(report(events, "2026-11-26T13:00:00.000Z").never)).toContain("toast.undo");
    expect(ids(report(events, "2026-11-26T13:00:00.000Z").never)).not.toContain("used.retire");
  });

  it("reads a young or empty recording as it is, never as 30 days", () => {
    const young = report([tap("2026-11-12T01:00:00.000Z", "toast.undo")], "2026-11-20T00:00:00.000Z", "phone", "2026-11-10T00:00:00.000Z");
    expect(young).toMatchObject({ since: "2026-11-10", recorded: 10, days: 10, taps: 1, opened: 0, daysUsed: 1, never: null });
    // The first event's own local day, 27 Oct 22:32, even before the registry's start: never a later day than it was.
    const early = report([screen("2026-10-27T11:32:00.000Z", "floor", 5000), tap("2026-10-27T11:33:00.000Z", "floor.dock.rivet", "floor")], "2026-10-27T12:30:00.000Z", "phone", "2026-10-27T11:32:00.000Z");
    expect(early).toMatchObject({ since: "2026-10-27", recorded: 0, taps: 1, opened: 1 });
    // How the app was opened (a push, a link) is a marker on the screen under it, no screen opened (review R4.3).
    const pushed = { at: "2026-10-27T11:34:00.000Z", device: "phone", kind: "screen", ctl: "decide.via-push", screen: "floor", value: 0 } as const;
    expect(report([screen("2026-10-27T11:32:00.000Z", "floor", 5000), pushed, screen("2026-10-27T11:35:00.000Z", "decide", 9000)], "2026-10-27T12:30:00.000Z", "phone", "2026-10-27T11:32:00.000Z").opened).toBe(2);
    expect(usageReport({ events: [], first: null, asks: [], device: "phone", now: new Date("2026-12-20T00:00:00.000Z") })).toEqual({
      device: "phone",
      since: null,
      recorded: 0,
      days: 0,
      taps: 0,
      opened: 0,
      daysUsed: 0,
      often: [],
      rarely: [],
      never: null,
      features: [],
    });
  });

  it("gives the folds every feature once, in its area, with both devices' uses, its days, last day and status", () => {
    const events = [
      // 10 phone taps on 3 days and 2 computer ones on a 4th: a lot, both devices together.
      ...Array.from({ length: 10 }, (_, i) => tap(at("2026-11-20T01:00:00.000Z", (i % 3) * DAY + i * 60_000), "chat.compose.send", "chat")),
      tap("2026-11-26T01:00:00.000Z", "chat.compose.send", "chat", "desktop"),
      tap("2026-11-26T02:00:00.000Z", "chat.compose.send", "chat", "desktop"),
      // 12 taps on 2 days: sometimes.
      ...Array.from({ length: 12 }, (_, i) => tap(at("2026-11-21T01:00:00.000Z", (i % 2) * DAY + i * 60_000), "cards.minimise")),
      // A removed id from an old bundle, and Decide opened (it shows the Cards tab on a phone).
      tap("2026-11-22T01:00:00.000Z", "findwork.go", "findwork"),
      screen("2026-11-23T01:00:00.000Z", "decide", 20_000),
      // Answered opened by its segment: the tap and the answered screen it leads to are one visit.
      tap("2026-11-24T01:00:00.000Z", "decide.seg.answered", "decide"),
      screen("2026-11-24T01:00:30.000Z", "answered", 30_000),
    ].sort((a, b) => a.at.localeCompare(b.at));
    const read = report(events, "2026-11-28T00:00:00.000Z");
    const by = new Map(read.features.map((row) => [row.id, row]));
    expect(read.features.map((row) => row.id)).toEqual(FOLD_IDS.map((entry) => entry.id));
    expect(new Set(by.keys()).size).toBe(read.features.length);
    expect(by.get("chat.compose.send")).toEqual({ id: "chat.compose.send", label: "Send a message", area: "Chat", phone: 10, desktop: 2, days: 4, last: "2026-11-26", status: "lot" });
    expect(by.get("cards.minimise")).toMatchObject({ area: "Cards", phone: 12, desktop: 0, days: 2, last: "2026-11-22", status: "some" });
    expect(by.get("findwork.go")).toMatchObject({ area: "Removed", phone: 1, status: "removed", removed: "2026-11-02" });
    expect(by.get("findwork.go")!.retire).toBeUndefined();
    expect(by.get("cards")).toMatchObject({ area: "Cards", phone: 1, status: "some" });
    expect(by.get("answered")).toMatchObject({ area: "Decide", phone: 1, days: 1 });
    expect(by.get("decide.seg.answered")).toMatchObject({ phone: 1 });
    expect(by.get("worker")).toEqual({ id: "worker", label: "Worker sheet", area: "Sheets", phone: 0, desktop: 0, days: 0, status: "untouched", retire: true });
    expect(by.get("settings.push.test")).toMatchObject({ area: "Settings", status: "unclear", retire: true });
    // A meta id, a card outcome and a signed-out id are no feature.
    for (const id of ["unknown", "unnamed", "gate.signin", "card.decision.choice"]) expect(by.has(id)).toBe(false);
    // Retire? sits exactly on the never-used rows.
    expect(read.features.filter((row) => row.retire).map((row) => row.id)).toEqual(ids(read.never).sort((a, b) => FOLD_IDS.findIndex((e) => e.id === a) - FOLD_IDS.findIndex((e) => e.id === b)));
    // Before 30 days, no row offers Retire?.
    expect(report(events, "2026-11-20T00:00:00.000Z").features.some((row) => row.retire)).toBe(false);
  });
});

describe("Rework?", () => {
  const base = Date.parse("2026-11-20T00:00:00.000Z");
  const t = (s: number) => new Date(base + s * 1000).toISOString();

  it("says Rework for a sheet left in under 3 s with no tap inside, at least 3 times", () => {
    const quick = [screen(t(2), "worker", 2000), screen(t(12), "worker", 2900), screen(t(22), "worker", 1000)];
    expect(reworkOf(quick).get("worker")).toEqual({ opens: 3, quick: 3 });
    // Twice is not enough; a 3 s stay is not quick.
    expect(reworkOf(quick.slice(0, 2)).has("worker")).toBe(false);
    expect(reworkOf([...quick.slice(0, 2), screen(t(22), "worker", 3000)]).has("worker")).toBe(false);
    // A tap inside one of them makes it a use, not a glance.
    expect(reworkOf([...quick.slice(0, 2), tap(t(21), "cards.minimise", "worker"), screen(t(22), "worker", 2000)]).has("worker")).toBe(false);
    // Quick in fewer than half its opens: it is mostly used.
    const long = (s: number) => screen(t(s), "worker", 30_000);
    expect(reworkOf([...quick, long(100), long(200), long(300)]).get("worker")).toEqual({ opens: 6, quick: 3 });
    expect(reworkOf([...quick, long(100), long(200), long(300), long(400)]).has("worker")).toBe(false);
  });

  it("never says Rework for a sheet closed with a screen over it, whose time went to that screen (review R4.2)", () => {
    // A phone's Decide with none open stands on Answered: closing it records Answered's minute, then Decide's 0 ms.
    const withAnswered = (s: number) => [screen(t(s), "answered", 60_000), screen(t(s), "decide", 0)];
    const read = reworkOf([...withAnswered(60), ...withAnswered(130), ...withAnswered(200)]);
    expect(read.has("decide")).toBe(false);
    // Decide left quick on its own, three times, is still a quick leave.
    expect(reworkOf([screen(t(2), "decide", 900), screen(t(12), "decide", 800), screen(t(22), "decide", 700)]).get("decide")).toEqual({ opens: 3, quick: 3 });
    // Search over Progress as the app went to the background (top first): Search's quick leave still counts (review R5.1).
    const hidden = (s: number) => [screen(t(s), "search", 1500), screen(t(s), "progress", 60_000)];
    expect(reworkOf([...hidden(300), ...hidden(400), ...hidden(500)]).get("search")).toEqual({ opens: 3, quick: 3 });
  });

  it("says Rework for an action undone within 5 s in at least 30% of its uses", () => {
    const uses = (undone: number, after = 4) =>
      Array.from({ length: 10 }, (_, i) => [tap(t(i * 60), "cards.answer.choice", "decide"), ...(i < undone ? [tap(t(i * 60 + after), "toast.undo", "decide")] : [])]).flat();
    expect(reworkOf(uses(3)).get("cards.answer.choice")).toEqual({ uses: 10, undone: 3 });
    expect(reworkOf(uses(2)).has("cards.answer.choice")).toBe(false);
    expect(reworkOf(uses(3, 6)).has("cards.answer.choice")).toBe(false);
    // An undo is no use of its own.
    expect(reworkOf(uses(3)).has("toast.undo")).toBe(false);
    // A move between screens before the Undo (the toast stays up) undoes nothing: the answer before it was undone.
    const moved = Array.from({ length: 3 }, (_, i) => [tap(t(i * 60), "cards.answer.choice", "decide"), tap(t(i * 60 + 1), "shell.rail.readings", "cards"), tap(t(i * 60 + 2), "cards.undo", "more")]).flat();
    expect(reworkOf(moved).get("cards.answer.choice")).toEqual({ uses: 3, undone: 3 });
    expect(reworkOf(moved).has("shell.rail.readings")).toBe(false);
    // So is a move through the menu (review R1.3).
    const menu = Array.from({ length: 3 }, (_, i) => [tap(t(i * 60), "cards.answer.choice", "decide"), tap(t(i * 60 + 1), "menu.row.usage", "cards"), tap(t(i * 60 + 2), "cards.undo", "usage")]).flat();
    expect(reworkOf(menu).get("cards.answer.choice")).toEqual({ uses: 3, undone: 3 });
    expect(reworkOf(menu).has("menu.row.usage")).toBe(false);
  });

  it("puts the numbers on the row of the device they came from", () => {
    const events = Array.from({ length: 3 }, (_, i) => screen(t(i * 10), "worker", 1500));
    const now = new Date("2026-11-28T00:00:00.000Z");
    const phone = usageReport({ events, first: "2026-10-27T13:00:00.000Z", asks: [], device: "phone", now });
    expect(phone.rarely).toEqual([{ id: "worker", label: "Worker sheet", where: "Screens", count: 3, last: "2026-11-20", rework: { opens: 3, quick: 3 } }]);
    expect(usageReport({ events, first: "2026-10-27T13:00:00.000Z", asks: [], device: "desktop", now }).rarely).toEqual([]);
  });
});

describe("reading the stored events (27 Oct, the first hour's real events)", () => {
  const scroll = (when: string, id: string, value: number): UsageEventRow => ({ at: when, device: "phone", kind: "scroll", ctl: id, screen: id, value });
  const z = (hms: string) => `2026-11-02T${hms}Z`;
  // Closing Rivet's pane on the Floor: the Chat tab was under it for 605 ms, untapped, its time begun as the pane left.
  const rivetClose = (from: string): UsageEventRow[] => [
    tap(at(from, 0), "floor.dock.rivet", "floor"),
    screen(at(from, 681), "floor", 2865),
    screen(at(from, 1227), "floor.rivet", 1224),
    screen(at(from, 1832), "chat", 605),
    scroll(at(from, 1832), "chat", 100),
    tap(at(from, 2437), "floor.dock.rivet", "floor"),
    screen(at(from, 2941), "floor", 606),
  ];
  // Closing Decide: the Cards view for 356 ms.
  const decideClose = (from: string): UsageEventRow[] => [
    tap(at(from, 0), "cards.answer.choice", "decide"),
    screen(at(from, 382), "decide", 14725),
    screen(at(from, 738), "cards", 356),
    screen(at(from, 2498), "floor", 1760),
  ];

  it("drops a tab flashed as a sheet closed, and keeps a tab he was on or tapped in", () => {
    const kept = readable([...rivetClose(z("01:00:00.000")), ...decideClose(z("01:10:00.000"))]);
    expect(kept.filter((event) => event.kind === "screen").map((event) => event.ctl)).toEqual(["floor", "floor.rivet", "floor", "decide", "floor"]);
    // Cards with its time before Decide opened: a real visit.
    const back = [screen(z("02:00:00.000"), "decide", 4000), screen(z("02:00:00.300"), "cards", 900 + 300)];
    expect(readable(back).map((event) => event.ctl)).toEqual(["decide", "cards"]);
    // A tap inside it: a real visit.
    const tapped = [screen(z("02:00:00.000"), "decide", 4000), tap(z("02:00:00.200"), "cards.minimise", "cards"), screen(z("02:00:00.300"), "cards", 300)];
    expect(readable(tapped).filter((event) => event.kind === "screen").map((event) => event.ctl)).toEqual(["decide", "cards"]);
    // 1.5 s or more: a real visit.
    expect(readable([screen(z("02:00:00.000"), "floor.rivet", 4000), screen(z("02:00:01.500"), "chat", 1500)]).map((event) => event.ctl)).toEqual(["floor.rivet", "chat"]);
    // Only a phone's stale tab flashes: a short Floor visit after a More page, or a computer's, is real.
    expect(readable([screen(z("02:00:00.000"), "more.costs", 4000), screen(z("02:00:01.000"), "floor", 1000)]).map((event) => event.ctl)).toEqual(["more.costs", "floor"]);
    const wide = [screen(z("02:00:00.000"), "more.costs", 4000, "desktop"), screen(z("02:00:01.000"), "progress", 1000, "desktop")];
    expect(readable(wide)).toEqual(wide);
    // A sheet that flashed is not a tab: kept for Rework? to judge.
    expect(readable([screen(z("02:00:00.000"), "floor", 4000), screen(z("02:00:00.300"), "worker", 300)]).map((event) => event.ctl)).toEqual(["floor", "worker"]);
  });

  it("reads an event recorded 2 or 3 times as one, and the same tap or visit after 450 ms or its own time as two", () => {
    const twice = [screen(z("03:00:03.559"), "chat.thing", 4542), screen(z("03:00:03.571"), "chat.thing", 4542), screen(z("03:00:03.573"), "chat.thing", 4542)];
    expect(readable(twice)).toEqual([twice[0]]);
    // A copy 434 ms on, and a screen's copy within its own time: one visit, and the flash after it still found.
    const late = [screen(z("03:00:39.731"), "floor.rivet", 5029), screen(z("03:00:40.165"), "floor.rivet", 5029), screen(z("03:00:40.533"), "chat", 802), screen(z("03:00:40.967"), "chat", 802)];
    expect(readable(late)).toEqual([late[0]]);
    const taps = [tap(z("03:00:00.000"), "chat.compose.send", "chat"), tap(z("03:00:01.100"), "chat.compose.send", "chat")];
    expect(readable(taps)).toEqual(taps);
    // Four answers 600 ms apart are four, each set against the last one kept.
    const answers = [0, 600, 1200, 1800].map((ms) => tap(at(z("03:00:00.000"), ms), "cards.answer.choice", "decide"));
    expect(readable(answers)).toEqual(answers);
    // The same screen again after its own time is a new visit.
    const again = [screen(z("03:00:00.000"), "worker", 1200), screen(z("03:00:01.300"), "worker", 1200)];
    expect(readable(again)).toEqual(again);
    // A copy on the other device is its own event.
    const both = [tap(z("03:00:00.000"), "chat.compose.send", "chat"), tap(z("03:00:00.010"), "chat.compose.send", "chat", "desktop")];
    expect(readable(both)).toEqual(both);
  });

  it("no longer says Rework for Chat or Cards from the flashes, and counts the copies once", () => {
    const events = [
      ...Array.from({ length: 5 }, (_, i) => rivetClose(z(`04:0${i}:00.000`))).flat(),
      ...Array.from({ length: 3 }, (_, i) => decideClose(z(`05:0${i}:00.000`))).flat(),
      ...Array.from({ length: 3 }, () => tap(z("06:00:00.000"), "chat.compose.send", "floor.rivet")),
    ];
    // Read as stored, both read Rework? (the page showed it, 27 Oct).
    expect(reworkOf(events).has("chat")).toBe(true);
    expect(reworkOf(events).has("cards")).toBe(true);
    const read = usageReport({ events, first: "2026-10-27T13:00:00.000Z", asks: [], device: "phone", now: new Date("2026-11-03T00:00:00.000Z") });
    const rows = [...read.often, ...read.rarely];
    expect(rows.find((row) => row.id === "chat")).toBeUndefined();
    expect(rows.find((row) => row.id === "cards")).toBeUndefined();
    expect(rows.find((row) => row.id === "chat.compose.send")?.count).toBe(1);
    // Rivet's pane itself, opened and shut in 1.2 s untapped, is a real quick leave: Rework? judges it as before.
    expect(rows.filter((row) => row.rework).map((row) => row.id)).toEqual(["floor.rivet"]);
  });
});

describe("Retire? cards", () => {
  let dir: string;
  let store: Store;
  let now: Date;
  let cards: ({ id: string } & Record<string, unknown>)[];
  let refuse: boolean;
  const errors: string[] = [];
  const make = () =>
    createUsageAsks({
      store,
      now: () => now,
      logger: { error: (message) => void errors.push(message) },
      addUpdate: (card) => {
        if (refuse) return { status: 409, error: "the board is full" };
        cards.push(card);
        return { status: 200 };
      },
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rivet-usage-"));
    store = new Store(dir);
    cards = [];
    refuse = false;
    errors.length = 0;
    // Recording's first event: 28 Oct 00:00Z.
    store.addUsage({ device: "phone", events: [[0, "tap", "cards.answer.choice", "decide", 1]] }, new Date("2026-10-28T00:00:00.000Z"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const neverOf = (asks: ReturnType<typeof make>, device: UsageDevice = "phone") => asks.report(device, now).never ?? [];

  it("makes a decision card with Retire, Keep and Rework from the page's chip, once", () => {
    now = new Date("2026-11-29T23:00:00.000Z");
    const asks = make();
    expect(asks.ask("toast.undo", "retire", "phone")).toEqual({ card: "usage-retire-2026-11-30-toast.undo" });
    expect(cards[0]).toMatchObject({ id: "usage-retire-2026-11-30-toast.undo", kind: "decision", title: "Retire Undo on a toast? Not tapped in 30 days." });
    const options = cards[0]!.options as { label: string; detail: string }[];
    expect(options.map((option) => option.label)).toEqual(["Retire", "Keep", "Rework"]);
    expect(options[0]!.detail).toContain("Its PR removes it from the app.");
    expect(asks.ask("worker", "retire", "phone")).toEqual({ card: "usage-retire-2026-11-30-worker" });
    expect(cards[1]!.title).toBe("Retire Worker sheet? Not opened in 30 days.");
    // Asked once: the page shows it asked, and a second tap is refused.
    expect(neverOf(asks).find((row) => row.id === "toast.undo")!.asked).toBe("asked");
    expect(asks.ask("toast.undo", "retire", "phone")).toMatchObject({ status: 409 });
    // Only a listed id, only one never used, and Rework only on its numbers.
    expect(asks.ask("unknown", "retire", "phone")).toMatchObject({ status: 400 });
    store.addUsage({ device: "desktop", events: [[0, "tap", "dictation.mic", "chat", 0]] }, now);
    expect(asks.ask("dictation.mic", "retire", "phone")).toMatchObject({ status: 409 });
    expect(asks.ask("dictation.mic", "rework", "desktop")).toMatchObject({ status: 409 });
    expect(cards).toHaveLength(2);
  });

  it("asks Rework? for a row the folds show past Used often's first 10", () => {
    now = new Date("2026-11-29T23:00:00.000Z");
    const busy = LISTED_IDS.filter((entry) => entry.kind === "control" && !UNDO_IDS.has(entry.id)).slice(0, 11);
    store.addUsage({ device: "phone", events: busy.flatMap((entry) => Array.from({ length: 20 }, (_, n): [number, "tap", string, string, number] => [n * 1000, "tap", entry.id, "cards", 0])) }, new Date("2026-11-29T00:00:00.000Z"));
    // The 12th busiest is undone each time it is used.
    const undone = "cards.minimise";
    store.addUsage({ device: "phone", events: Array.from({ length: 4 }, (_, n): [number, "tap", string, string, number][] => [[n * 10_000 + 1000, "tap", undone, "cards", 0], [n * 10_000, "tap", "toast.undo", "cards", 0]]).flat() }, new Date("2026-11-29T01:00:00.000Z"));
    const asks = make();
    const read = asks.report("phone", now);
    expect(read.often.map((row) => row.id)).not.toContain(undone);
    expect(read.features.find((row) => row.id === undone)!.rework).toEqual({ uses: 4, undone: 4 });
    expect(asks.ask(undone, "rework", "phone")).toEqual({ card: `usage-rework-2026-11-30-${undone}` });
  });

  it("makes no card from a chip before 30 days of recording", () => {
    now = new Date("2026-11-20T00:00:00.000Z");
    expect(make().ask("toast.undo", "retire", "phone")).toMatchObject({ status: 409 });
    expect(cards).toEqual([]);
  });

  it("holds an id off Retire?, page and pass, for 90 days after Keep", () => {
    now = new Date("2026-11-29T23:00:00.000Z");
    const asks = make();
    const { card } = asks.ask("toast.undo", "retire", "phone") as { card: string };
    now = new Date(now.getTime() + DAY);
    // Rework first, then Keep 20 days on: a replay of the older Rework reply (its clientId again) never undoes the Keep.
    asks.answered(card, "Rework", new Date(now.getTime() - 20 * DAY).toISOString());
    asks.answered(card, "Keep", now.toISOString());
    asks.answered(card, "Rework", new Date(now.getTime() - 20 * DAY).toISOString());
    expect(neverOf(asks).find((row) => row.id === "toast.undo")!.asked).toBe("kept");
    // A card that is no ask's changes nothing.
    asks.answered("morning-2026-12-01", "Keep", now.toISOString());
    // The next Monday's pass passes it over.
    now = new Date("2026-12-06T20:00:00.000Z");
    make().weekly();
    expect(cards.slice(1).map((one) => one.id)).not.toContain("usage-retire-2026-12-07-toast.undo");
    // 90 days after the Keep it is back on Retire?.
    now = new Date(Date.parse("2026-11-30T23:00:00.000Z") + 90 * DAY - 1000);
    expect(neverOf(make()).find((row) => row.id === "toast.undo")!.asked).toBe("kept");
    now = new Date(Date.parse("2026-11-30T23:00:00.000Z") + 90 * DAY + 1000);
    expect(neverOf(make()).find((row) => row.id === "toast.undo")!.asked).toBeUndefined();
  });

  it("sends at most 3 Retire? cards a week, on Monday from 7am, restarts included", () => {
    // Mon 30 Nov, 6:59am and 7am local.
    now = new Date("2026-11-29T19:59:00.000Z");
    expect(make().weekly()).toBe(0);
    now = new Date("2026-11-29T20:00:00.000Z");
    const asks = make();
    expect(asks.weekly()).toBe(3);
    expect(asks.weekly()).toBe(0);
    expect(make().weekly()).toBe(0);
    expect(cards.every((one) => (one.title as string).startsWith("Retire ") && (one.options as { label: string }[]).length === 3)).toBe(true);
    expect(cards.map((one) => one.id).every((id) => id.startsWith("usage-retire-2026-11-30-"))).toBe(true);
    // Tuesday sends none; the next Monday sends 3 more, none asked before.
    now = new Date("2026-11-30T20:00:00.000Z");
    expect(make().weekly()).toBe(0);
    now = new Date("2026-12-06T20:00:00.000Z");
    expect(make().weekly()).toBe(3);
    expect(new Set(cards.map((one) => (one.id as string).replace(/^usage-retire-\d{4}-\d{2}-\d{2}-/, ""))).size).toBe(6);
  });

  it("sends none before Mon 30 Nov 2026 or before 30 full days of recording", () => {
    // Mon 23 Nov, 7am local.
    now = new Date("2026-11-22T20:00:00.000Z");
    expect(make().weekly()).toBe(0);
    // Recording that began on 5 Nov has 24 full days on Mon 30 Nov, 31 on Mon 7 Dec.
    store.close();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "rivet-usage-"));
    store = new Store(dir);
    store.addUsage({ device: "phone", events: [[0, "tap", "cards.answer.choice", "decide", 1]] }, new Date("2026-11-05T00:00:00.000Z"));
    now = new Date("2026-11-29T20:00:00.000Z");
    expect(make().weekly()).toBe(0);
    now = new Date("2026-12-06T20:00:00.000Z");
    expect(make().weekly()).toBe(3);
  });

  it("tries again on the next tick when the board refuses a card, and stores no ask for it", () => {
    now = new Date("2026-11-29T20:00:00.000Z");
    const asks = make();
    refuse = true;
    expect(asks.weekly()).toBe(0);
    expect(store.usageAsks("2026-01-01T00:00:00.000Z")).toEqual([]);
    expect(errors).toHaveLength(3);
    refuse = false;
    expect(asks.weekly()).toBe(3);
  });
});

describe("GET /api/usage/report and POST /api/usage/ask", () => {
  let server: TestServer;
  let cookie: string;
  let clock: ReturnType<typeof fakeClock>;

  beforeEach(async () => {
    clock = fakeClock(Date.parse("2026-10-28T00:00:00.000Z"));
    server = await startServer(undefined, { now: clock.now });
    cookie = server.cookie();
  });

  afterEach(async () => {
    await server.close();
  });

  const read = async (query = "") => {
    const res = await fetch(`${server.base}/api/usage/report${query}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    return (await res.json()) as UsageReport;
  };
  const ask = (body: unknown, headers = browser(cookie)) => fetch(`${server.base}/api/usage/ask`, { method: "POST", headers, body: JSON.stringify(body) });

  it("needs Sam's session, and a same-origin request to ask", async () => {
    expect((await fetch(`${server.base}/api/usage/report`)).status).toBe(401);
    expect((await ask({ id: "toast.undo", ask: "retire", device: "phone" }, { "content-type": "application/json", origin: ORIGIN })).status).toBe(401);
    expect((await ask({ id: "toast.undo", ask: "retire", device: "phone" }, { ...browser(cookie), origin: "https://evil.example" })).status).toBe(403);
    expect((await ask({ id: "toast.undo", ask: "retire", device: "phone", note: "hi" })).status).toBe(400);
  });

  it("reads phone first, says how young the recording is, then makes a card and keeps Keep through the reply", async () => {
    expect(await read()).toMatchObject({ device: "phone", since: null, never: null });
    const sent = await fetch(`${server.base}/api/usage`, {
      method: "POST",
      headers: browser(cookie),
      body: JSON.stringify({ device: "phone", events: [[0, "tap", "cards.answer.choice", "decide", 1]] }),
    });
    expect(sent.status).toBe(204);
    expect(await read()).toMatchObject({ device: "phone", since: "2026-10-28", recorded: 0, days: 1, taps: 1, never: null });
    expect(await read("?device=desktop")).toMatchObject({ device: "desktop", since: "2026-10-28", taps: 0 });
    expect((await ask({ id: "toast.undo", ask: "retire", device: "phone" })).status).toBe(409);

    clock.advance(33 * DAY);
    const made = await ask({ id: "toast.undo", ask: "retire", device: "phone" });
    expect(made.status).toBe(201);
    const { card } = (await made.json()) as { card: string };
    const need = server.app.store.getBoard()!.board.needs.find((one) => one.id === card)!;
    expect(need).toMatchObject({ kind: "decision", title: "Retire Undo on a toast? Not tapped in 30 days." });

    // Sam's Keep, as the reply route stores it, reaches the ask.
    server.app.store.addReply({ clientId: "c-keep", itemId: card, itemTitle: need.title, decision: "choice", choice: "Keep", rev: "a".repeat(16), item: need as never });
    expect((await read()).never!.find((row) => row.id === "toast.undo")!.asked).toBe("kept");
  });
});
