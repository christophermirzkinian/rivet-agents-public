import { afterEach, describe, expect, it } from "vitest";

import { createMorning, morningFacts, morningMerged, localAt, type MorningDeps } from "../src/server/morning.js";
import { setTimeZone } from "../src/shared/when.js";
import { overnightLine } from "../src/shared/words.js";
import type { Board } from "../src/shared/board.js";
import type { PushPayload } from "../src/server/push.js";
import type { MergedPr } from "../src/shared/ops.js";
import { EXAMPLE_BOARD, fakeClock, putBoard, startServer, type TestServer } from "./helpers.js";

// The Morning card at 7am local, one line.

const merged = (n: number, mergedAt: string): MergedPr => ({ repo: "example-repo", number: n, title: `PR ${n}`, url: `https://github.com/x/${n}`, mergedAt, author: "sam" });

function fake(start: string) {
  let at = new Date(start);
  const added: ({ id: string } & Record<string, unknown>)[] = [];
  const errors: string[] = [];
  let board: Board = { updatedAt: "", needs: [], coming: [], chats: [], shipped: [], waitingWM: [] };
  let refuse: number | null = null;
  const deps: MorningDeps = {
    now: () => at,
    addUpdate: (card) => {
      if (refuse) return { status: refuse, error: "the board is full of question cards" };
      if (board.needs.some((need) => need.id === card.id)) return { status: 409, error: "taken" };
      added.push(card);
      board = { ...board, needs: [...board.needs, { kind: "update", ...card } as Board["needs"][number]] };
      return { status: 200 };
    },
    // 2026-10-11 07:00 local is 2026-10-10T20:00Z (AEDT, +11); 9pm the night before is 2026-10-10T10:00Z.
    merged: () => [merged(1, "2026-10-10T09:59:00Z"), merged(2, "2026-10-10T10:00:00Z"), merged(3, "2026-10-10T19:59:00Z"), merged(4, "2026-10-10T20:30:00Z")],
    needs: () => 2,
    board: () => board,
    answered: () => false,
    logger: { error: (message) => void errors.push(message) },
  };
  return {
    deps,
    added,
    errors,
    set: (iso: string) => (at = new Date(iso)),
    refuse: (code: number | null) => (refuse = code),
    clearBoard: () => (board = { ...board, needs: [] }),
  };
}

describe("the Morning card's What you used line", () => {
  const URL = "https://rivet.example/?tab=what-you-used";
  const filed = (at: string, never: number | null) => {
    const morning = fake(at);
    expect(createMorning({ ...morning.deps, neverUsed: () => never, usageUrl: URL }).tick()).toBe("filed");
    return morning.added[0]!;
  };

  it("goes on Mondays only, as one link that opens the page", () => {
    // Mon 30 Nov 2026, 7am local.
    const monday = filed("2026-11-29T20:00:00Z", 41);
    expect(monday.links).toEqual([{ label: "What you used: 41 never used in 30 days ›", url: URL }]);
    expect(monday.ask).not.toContain("What you used");
    // Tue 1 Dec and Sun 6 Dec carry none.
    expect(filed("2026-11-30T20:00:00Z", 41).links).toBeUndefined();
    expect(filed("2026-12-05T20:00:00Z", 41).links).toBeUndefined();
  });

  it("is left out before 30 full days of recording, or with no https page to open", () => {
    expect(filed("2026-11-22T20:00:00Z", null).links).toBeUndefined();
    const morning = fake("2026-11-29T20:00:00Z");
    expect(createMorning({ ...morning.deps, neverUsed: () => 41 }).tick()).toBe("filed");
    expect(morning.added[0]!.links).toBeUndefined();
  });
});

describe("localAt", () => {
  it("finds the instant the zone's clock reads the hour, either side of daylight saving", () => {
    setTimeZone("Pacific/Auckland");
    try {
      expect(localAt("2026-10-11", 7).toISOString()).toBe("2026-10-10T18:00:00.000Z");
      expect(localAt("2026-07-01", 7).toISOString()).toBe("2026-06-30T19:00:00.000Z");
      // The night daylight saving starts (last Sunday in September): 9pm the evening before is still standard time.
      expect(localAt("2026-09-26", 21).toISOString()).toBe("2026-09-26T09:00:00.000Z");
    } finally {
      setTimeZone(undefined);
    }
  });
});

describe("the Morning card", () => {
  it("files nothing before 7am local, then one card at 7am, once, its one line", () => {
    const morning = fake("2026-10-10T19:59:00Z");
    const job = createMorning(morning.deps);
    expect(job.tick()).toBe("early");
    morning.set("2026-10-10T20:00:30Z");
    expect(job.tick()).toBe("filed");
    expect(job.tick()).toBe("there");
    expect(morning.added).toEqual([{ id: "morning-2026-10-11", kind: "decision", title: "Good morning", ask: "Overnight: 2 merged, 2 need you ›", options: [{ label: "Got it" }], push: "fyi" }]);
  });

  it("files today's card once on a restart after 7am, and never one already there or seen", () => {
    const morning = fake("2026-10-11T03:00:00Z");
    expect(createMorning(morning.deps).tick()).toBe("filed");
    // A restart: a new job finds it on the board.
    expect(createMorning(morning.deps).tick()).toBe("there");
    morning.clearBoard();
    expect(createMorning({ ...morning.deps, answered: (id) => id === "morning-2026-10-11" }).tick()).toBe("there");
    expect(morning.added).toHaveLength(1);
    // The next day files the next one.
    morning.set("2026-10-11T20:00:00Z");
    expect(createMorning(morning.deps).tick()).toBe("filed");
    expect(morning.added.map((card) => card.id)).toEqual(["morning-2026-10-11", "morning-2026-10-12"]);
  });

  it("says nothing merged and nothing needs you in the one line (plan §6)", () => {
    const quiet = fake("2026-10-10T20:00:00Z");
    expect(createMorning({ ...quiet.deps, merged: () => [], needs: () => 0 }).tick()).toBe("filed");
    expect(quiet.added[0]!.ask).toBe("Overnight: nothing merged. Nothing needs you.");
    const one = fake("2026-10-10T20:00:00Z");
    expect(createMorning({ ...one.deps, needs: () => 1 }).tick()).toBe("filed");
    expect(one.added[0]!.ask).toBe("Overnight: 2 merged, 1 needs you ›");
    expect(overnightLine(3, 0)).toBe("Overnight: 3 merged. Nothing needs you.");
    expect(overnightLine(0, 2)).toBe("Overnight: nothing merged, 2 need you ›");
    expect(morningFacts(quiet.deps)).toEqual({ day: "2026-10-11", merged: 2, needs: 2 });
  });

  it("keeps trying while the board refuses it, logging the refusal once", () => {
    const morning = fake("2026-10-10T21:00:00Z");
    morning.refuse(507);
    const job = createMorning(morning.deps);
    expect(job.tick()).toBe("failed");
    expect(job.tick()).toBe("failed");
    expect(morning.errors).toHaveLength(1);
    morning.refuse(null);
    expect(job.tick()).toBe("filed");
  });
});

describe("a held Morning push", () => {
  let server: TestServer;
  afterEach(async () => server.close());

  it("leaves the digest unsent when its card is off the board before quiet hours end", async () => {
    const sent: PushPayload[] = [];
    const clock = fakeClock(Date.parse("2026-10-05T19:00:00.000Z")); // 06:00 local, in quiet hours
    server = await startServer({}, { now: clock.now, quiet: true, pushSender: { send: async (_target, body) => (sent.push(JSON.parse(body) as PushPayload), 201) } });
    server.app.push.subscribe({ endpoint: "https://fcm.googleapis.com/fcm/send/morning", keys: { p256dh: "key", auth: "auth" } });
    const card = { id: "morning-2026-10-06", kind: "update", title: "Good morning", ask: "Overnight: nothing merged. Nothing needs you.", thread: "Morning", tag: "Morning" };
    expect((await putBoard(server.base, { ...EXAMPLE_BOARD, needs: [] })).status).toBe(200);
    expect((await putBoard(server.base, { ...EXAMPLE_BOARD, needs: [card] })).status).toBe(200);
    await expect.poll(() => server.app.quiet.heldCount()).toBe(1);
    expect((await putBoard(server.base, { ...EXAMPLE_BOARD, needs: [] })).status).toBe(200);
    clock.advance(2 * 3600_000);
    await server.app.push.flushHeld();
    expect(sent).toHaveLength(0);
    expect(server.app.quiet.heldCount()).toBe(0);
  });

  it("says the cards that need Sam as they stand when it goes, not as they stood when it was held", async () => {
    const sent: PushPayload[] = [];
    const clock = fakeClock(Date.parse("2026-10-05T19:00:00.000Z")); // 06:00 local, in quiet hours
    server = await startServer({}, { now: clock.now, quiet: true, pushSender: { send: async (_target, body) => (sent.push(JSON.parse(body) as PushPayload), 201) } });
    server.app.push.subscribe({ endpoint: "https://fcm.googleapis.com/fcm/send/morning", keys: { p256dh: "key", auth: "auth" } });
    const card = { id: "morning-2026-10-06", kind: "decision", title: "Good morning", ask: overnightLine(2, 3), options: [{ label: "Got it" }], push: "fyi" };
    expect((await putBoard(server.base, { ...EXAMPLE_BOARD, needs: [card] })).status).toBe(200);
    await expect.poll(() => server.app.quiet.heldCount()).toBe(1);
    clock.advance(2 * 3600_000);
    await server.app.push.flushHeld();
    expect(sent.map((payload) => [payload.title, payload.body])).toEqual([["Good morning", overnightLine(2, 0)]]);
  });

  it("rewords one filed in the old lines with its merged count and the needs of now, never nothing merged or the old count", async () => {
    const said = (ask: string) => morningMerged({ ask } as never);
    expect([said(overnightLine(4, 1)), said(overnightLine(0, 2)), said("2 merged overnight\n1 needs you today"), said("Nothing merged overnight"), said("Hello")]).toEqual([4, 0, 2, 0, undefined]);
    const sent: PushPayload[] = [];
    const clock = fakeClock(Date.parse("2026-10-05T19:00:00.000Z")); // 06:00 local, in quiet hours
    server = await startServer({}, { now: clock.now, quiet: true, pushSender: { send: async (_target, body) => (sent.push(JSON.parse(body) as PushPayload), 201) } });
    server.app.push.subscribe({ endpoint: "https://fcm.googleapis.com/fcm/send/morning", keys: { p256dh: "key", auth: "auth" } });
    const card = { id: "morning-2026-10-06", kind: "decision", title: "Good morning", ask: "2 merged overnight\n1 needs you today\nNo asks found\nNo machine warnings", options: [{ label: "Got it" }], push: "fyi" };
    expect((await putBoard(server.base, { ...EXAMPLE_BOARD, needs: [card] })).status).toBe(200);
    await expect.poll(() => server.app.quiet.heldCount()).toBe(1);
    clock.advance(2 * 3600_000);
    await server.app.push.flushHeld();
    expect(sent.map((payload) => payload.body)).toEqual([overnightLine(2, 0)]);
  });
});
