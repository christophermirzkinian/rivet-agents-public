import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_USAGE_EVENTS, MAX_USAGE_EVENTS_PER_DAY, USAGE_BATCHES_PER_MINUTE, USAGE_IDS, USAGE_KEEP_MS, usageBatchSchema, type UsageSummary } from "../src/shared/usage-ids.js";
import { browser, fakeClock, ORIGIN, startServer, type TestServer } from "./helpers.js";

// What you used (Sam, 27 Oct): the app's screens and taps go up by registry id only, are kept 90 days, and come back
// as a count, a last use and a median per id.

const DAY = 24 * 60 * 60 * 1000;

describe("the usage registry", () => {
  it("has unique ids of the fixed shape, each with a label, a place and a day", () => {
    const seen = new Set<string>();
    for (const entry of USAGE_IDS) {
      expect(entry.id, entry.id).toMatch(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
      expect(entry.id.length).toBeLessThanOrEqual(64);
      expect(seen.has(entry.id), `${entry.id} twice`).toBe(false);
      seen.add(entry.id);
      expect(entry.label.length, entry.id).toBeGreaterThan(0);
      expect(entry.where.length, entry.id).toBeGreaterThan(0);
      expect(entry.added, entry.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (entry.removed) expect(entry.removed > entry.added, entry.id).toBe(true);
    }
  });

  it("takes a tap on a control, a screen on a screen, and refuses an id outside its kind", () => {
    const batch = (event: unknown[]) => usageBatchSchema.safeParse({ device: "phone", events: [event] }).success;
    expect(batch([0, "tap", "cards.approve", "cards", 0])).toBe(true);
    expect(batch([0, "screen", "decide", "decide", 4200])).toBe(true);
    expect(batch([0, "card", "card.decision.choice", "decide", 9000])).toBe(true);
    expect(batch([0, "scroll", "chat", "chat", 70])).toBe(true);
    // A screen named as a tap, a control as a screen, a short view as a scroll.
    expect(batch([0, "tap", "decide", "decide", 0])).toBe(false);
    expect(batch([0, "screen", "cards.approve", "cards", 0])).toBe(false);
    expect(batch([0, "scroll", "more", "more", 50])).toBe(false);
    // Anything that is not a registry id: words, a card id, a screen that is no screen.
    expect(batch([0, "tap", "Ship it to Sam", "cards", 0])).toBe(false);
    expect(batch([0, "tap", "cards.approve", "plan-6586", 0])).toBe(false);
    expect(batch([0, "tap", "cards.approve", "cards", 0, "extra"])).toBe(false);
    expect(batch([0, "tap", "cards.approve", "cards", 1.5])).toBe(false);
    expect(batch([-1, "tap", "cards.approve", "cards", 0])).toBe(false);
    expect(batch([USAGE_KEEP_MS + 1, "tap", "cards.approve", "cards", 0])).toBe(false);
    expect(usageBatchSchema.safeParse({ device: "phone", events: [[0, "tap", "cards.approve", "cards", 0]], note: "hi" }).success).toBe(false);
    expect(usageBatchSchema.safeParse({ device: "tablet", events: [[0, "tap", "cards.approve", "cards", 0]] }).success).toBe(false);
  });
});

describe("POST /api/usage and the summary", () => {
  let server: TestServer;
  let cookie: string;
  let clock: ReturnType<typeof fakeClock>;

  beforeEach(async () => {
    clock = fakeClock(Date.parse("2026-11-02T00:00:00.000Z"));
    server = await startServer(undefined, { now: clock.now });
    cookie = server.cookie();
  });

  afterEach(async () => {
    await server.close();
  });

  const send = (body: unknown, headers = browser(cookie)) => fetch(`${server.base}/api/usage`, { method: "POST", headers, body: JSON.stringify(body) });
  const summary = async (query = "") => {
    const res = await fetch(`${server.base}/api/usage/summary${query}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    return (await res.json()) as UsageSummary;
  };
  const rows = () => {
    const db = new DatabaseSync(join(server.dataDir, "rivet.sqlite"));
    try {
      return db.prepare("SELECT at, device, kind, ctl, screen, value FROM usage_events ORDER BY id").all();
    } finally {
      db.close();
    }
  };

  it("stores a batch stamped by the server's clock, and sums it per id", async () => {
    const res = await send({
      device: "phone",
      events: [
        [5000, "screen", "decide", "decide", 4000],
        [3000, "tap", "cards.answer.choice", "decide", 2],
        [2000, "tap", "cards.answer.choice", "decide", 1],
        [1000, "screen", "decide", "decide", 1000],
        [0, "screen", "decide", "decide", 9000],
      ],
    });
    expect(res.status).toBe(204);
    expect(rows()[0]).toEqual({ at: "2026-11-01T23:59:55.000Z", device: "phone", kind: "screen", ctl: "decide", screen: "decide", value: 4000 });

    const body = await summary();
    expect(body).toMatchObject({ days: 30, device: "phone", since: "2026-11-01T23:59:55.000Z" });
    expect(body.counts).toContainEqual({ kind: "screen", id: "decide", count: 3, last: "2026-11-02T00:00:00.000Z", median: 4000 });
    expect(body.counts).toContainEqual({ kind: "tap", id: "cards.answer.choice", count: 2, last: "2026-11-01T23:59:58.000Z" });
    // The computer's uses are its own.
    expect(await summary("?device=desktop")).toEqual({ days: 30, device: "desktop", since: null, counts: [] });
  });

  it("stores an event the app sends again once, by the app's clock, and keeps a same tap made at another time", async () => {
    const sentAt = 1_800_000_000_000;
    const first = { device: "phone", sentAt, events: [[2000, "screen", "chat.thing", "chat.thing", 4542], [1000, "tap", "cards.approve", "cards", 0]] };
    expect((await send(first)).status).toBe(204);
    // Its answer was lost: the next send carries it again, beside a tap made since, each aged from the new send.
    clock.advance(60_000);
    const again = {
      device: "phone",
      sentAt: sentAt + 60_000,
      events: [[62_000, "screen", "chat.thing", "chat.thing", 4542], [61_000, "tap", "cards.approve", "cards", 0], [0, "tap", "cards.approve", "cards", 0]],
    };
    expect((await send(again)).status).toBe(204);
    expect((await send(again)).status).toBe(204);
    expect(rows().map((row) => (row as { ctl: string }).ctl)).toEqual(["chat.thing", "cards.approve", "cards.approve"]);
    // The phone and the computer are apart.
    expect((await send({ ...first, device: "desktop" })).status).toBe(204);
    expect(rows()).toHaveLength(5);
  });

  it("takes the middle pair's mean as the median of an even count", async () => {
    expect((await send({ device: "phone", events: [[1, "screen", "decide", "decide", 1000], [0, "screen", "decide", "decide", 9000]] })).status).toBe(204);
    expect((await summary()).counts).toContainEqual(expect.objectContaining({ id: "decide", count: 2, median: 5000 }));
  });

  it("takes at most 5000 events a device a day, counted when they arrive, however far back they are dated", async () => {
    const old = [80 * DAY, "tap", "cards.approve", "cards", 0];
    const full = Array.from({ length: MAX_USAGE_EVENTS }, () => old);
    for (let sent = 0; sent < MAX_USAGE_EVENTS_PER_DAY; sent += MAX_USAGE_EVENTS) {
      expect((await send({ device: "phone", events: full })).status).toBe(204);
      clock.advance(1100);
    }
    expect((await send({ device: "phone", events: [old] })).status).toBe(429);
    // The computer has its own day.
    expect((await send({ device: "desktop", events: [old] })).status).toBe(204);
    expect(rows()).toHaveLength(MAX_USAGE_EVENTS_PER_DAY + 1);
    clock.advance(DAY);
    expect((await send({ device: "phone", events: [old] })).status).toBe(204);
  });

  it("refuses the whole batch when one id is not in the registry, and stores none of it", async () => {
    const res = await send({ device: "phone", events: [[0, "tap", "cards.approve", "cards", 0], [0, "tap", "Rivet review plan", "cards", 0]] });
    expect(res.status).toBe(400);
    expect(rows()).toEqual([]);
  });

  it("needs Sam's session and a same-origin request", async () => {
    const event = { device: "phone", events: [[0, "tap", "cards.approve", "cards", 0]] };
    expect((await send(event, { origin: ORIGIN, "x-rivet": "1", "content-type": "application/json" })).status).toBe(401);
    expect((await send(event, { ...browser(cookie), "x-rivet": "0" })).status).toBe(403);
    expect((await send(event, { ...browser(cookie), origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(`${server.base}/api/usage/summary`)).status).toBe(401);
    expect(rows()).toEqual([]);
  });

  it("takes at most 200 events and 32 KB a batch", async () => {
    const tap = [0, "tap", "cards.approve", "cards", 0];
    expect((await send({ device: "phone", events: Array.from({ length: MAX_USAGE_EVENTS }, () => tap) })).status).toBe(204);
    expect((await send({ device: "phone", events: Array.from({ length: MAX_USAGE_EVENTS + 1 }, () => tap) })).status).toBe(400);
    expect((await send({ device: "phone", events: [tap], pad: "x".repeat(33 * 1024) })).status).toBe(413);
    expect((await send({ device: "phone", events: [] })).status).toBe(400);
  });

  it("takes 60 batches a minute", async () => {
    const event = { device: "desktop", events: [[0, "tap", "shell.rail.floor", "progress", 0]] };
    for (let i = 0; i < USAGE_BATCHES_PER_MINUTE; i += 1) expect((await send(event)).status).toBe(204);
    expect((await send(event)).status).toBe(429);
  });

  it("keeps 90 days of events and drops the older ones on the next batch", async () => {
    expect((await send({ device: "phone", events: [[0, "tap", "cards.approve", "cards", 0]] })).status).toBe(204);
    clock.advance(89 * DAY);
    expect((await send({ device: "phone", events: [[0, "tap", "cards.reject", "cards", 0]] })).status).toBe(204);
    expect(rows().map((row) => row.ctl)).toEqual(["cards.approve", "cards.reject"]);
    clock.advance(2 * DAY);
    expect((await send({ device: "phone", events: [[0, "tap", "cards.undo", "cards", 0]] })).status).toBe(204);
    expect(rows().map((row) => row.ctl)).toEqual(["cards.reject", "cards.undo"]);
  });

  it("counts only the asked window, and refuses a window past the keep", async () => {
    expect((await send({ device: "phone", events: [[0, "tap", "cards.approve", "cards", 0]] })).status).toBe(204);
    clock.advance(10 * DAY);
    expect((await send({ device: "phone", events: [[0, "tap", "cards.approve", "cards", 0]] })).status).toBe(204);
    expect((await summary("?days=7")).counts).toEqual([{ kind: "tap", id: "cards.approve", count: 1, last: new Date(clock.now()).toISOString() }]);
    expect((await summary("?days=30")).counts[0]!.count).toBe(2);
    const res = await fetch(`${server.base}/api/usage/summary?days=91`, { headers: { cookie } });
    expect(res.status).toBe(400);
  });
});
