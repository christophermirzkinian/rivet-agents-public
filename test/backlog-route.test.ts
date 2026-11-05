import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Ask } from "../src/shared/asks.js";
import { MAX_BACKLOG_ASKS, type BacklogResponse, type BacklogSnapshot } from "../src/shared/backlog.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, browser, fakeClock, startServer, type TestServer } from "./helpers.js";

const MS = "example-org/example-repo" as const;
const THIRD = "example-org/third-repo" as const;
const START = Date.parse("2026-11-02T10:00:00.000Z");

function snapshot(over: Partial<BacklogSnapshot> = {}): BacklogSnapshot {
  return {
    at: new Date(START).toISOString(),
    repos: [
      {
        repo: MS,
        total: 400,
        logs: 14,
        ownerTotal: 34,
        owner: [{ number: 7356, title: "Search: results stay in order", updatedAt: "2026-11-02T09:00:00.000Z", labels: ["autonomy:owner"] }],
        recent: [{ number: 300, title: "Chat runner: a chat at its limit stays stuck", updatedAt: "2026-11-01T09:00:00.000Z", labels: ["type:bug"] }],
        bugs: [],
      },
    ],
    ...over,
  };
}

describe("Backlog routes", () => {
  let server: TestServer;
  let clock: ReturnType<typeof fakeClock>;
  beforeEach(async () => {
    clock = fakeClock(START);
    server = await startServer({}, { now: clock.now });
  });
  afterEach(async () => {
    await server.close();
  });

  const put = (body: unknown, token = BRIDGE_TOKEN) => fetch(`${server.base}/api/bridge/ops/backlog`, { method: "PUT", headers: bearer(token), body: JSON.stringify(body) });
  const read = () => fetch(`${server.base}/api/backlog`, { headers: browser(server.cookie()) });
  const ask = (body: Record<string, unknown>) => fetch(`${server.base}/api/asks`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) });

  it("takes the bridge's reading with the bridge token only, and rejects extra fields and bodies", async () => {
    expect((await put(snapshot(), BOARD_TOKEN)).status).toBe(401);
    expect((await put(snapshot(), "d".repeat(64))).status).toBe(401);
    expect((await put({ ...snapshot(), extra: 1 })).status).toBe(400);
    const withBody = snapshot();
    (withBody.repos[0]!.recent[0] as unknown as Record<string, unknown>).body = "a whole issue body";
    expect((await put(withBody)).status).toBe(400);
    expect((await put(snapshot({ repos: [{ ...snapshot().repos[0]!, repo: "someone/else" as typeof MS }] }))).status).toBe(400);
    const tooMany = snapshot();
    tooMany.repos[0]!.owner = Array.from({ length: 21 }, (_, i) => ({ number: i + 1, title: "t", updatedAt: "2026-11-02T09:00:00.000Z", labels: [] }));
    expect((await put(tooMany)).status).toBe(400);
    const longTitle = snapshot();
    longTitle.repos[0]!.recent[0]!.title = "x".repeat(301);
    expect((await put(longTitle)).status).toBe(400);
    expect((await put(snapshot())).status).toBe(200);
  });

  it("serves the reading and every ask not started or parked, newest first, to a signed-in app only", async () => {
    expect((await fetch(`${server.base}/api/backlog`)).status).toBe(401);
    const empty = (await (await read()).json()) as BacklogResponse;
    expect(empty).toEqual({ at: null, stale: true, repos: {}, asks: [], started: [], closing: [] });

    expect((await ask({ id: "a-1", words: "Start Sam's new apps", why: "Waits on you to send Sam's apps" })).status).toBe(201);
    clock.advance(60_000);
    expect((await ask({ id: "a-2", words: "Online search for the build check", repo: THIRD, stage: "parked" })).status).toBe(201);
    clock.advance(60_000);
    expect((await ask({ id: "a-3", words: "A thing already building", stage: "building" })).status).toBe(201);
    expect((await put(snapshot())).status).toBe(200);

    const body = (await (await read()).json()) as BacklogResponse;
    expect(body.at).toBe(new Date(START).toISOString());
    expect(body.stale).toBe(false);
    expect(Object.keys(body.repos)).toEqual([MS]);
    expect(body.repos[MS]!.ownerTotal).toBe(34);
    expect(body.asks.map((one) => [one.id, one.stage])).toEqual([
      ["a-2", "parked"],
      ["a-1", "queued"],
    ]);
    expect(body.asks[1]).toMatchObject({ words: "Start Sam's new apps", why: "Waits on you to send Sam's apps", short: expect.any(String) });
    expect(body.asks[0]).toMatchObject({ repo: THIRD });
    expect(body.asks[0]).not.toHaveProperty("timeline");

    clock.advance(21 * 60_000);
    expect(((await (await read()).json()) as BacklogResponse).stale).toBe(true);
  });

  it("keeps a repo the next reading left out at its own older reading, and serves it stale while the others are fresh", async () => {
    const third = { repo: THIRD, total: 5, logs: 0, ownerTotal: 0, owner: [], recent: [], bugs: [] };
    expect((await put(snapshot({ repos: [...snapshot().repos, third] }))).status).toBe(200);
    clock.advance(21 * 60_000);
    const later = new Date(START + 21 * 60_000).toISOString();
    expect((await put(snapshot({ at: later }))).status).toBe(200);

    const body = (await (await read()).json()) as BacklogResponse;
    expect(body.at).toBe(later);
    expect(body.stale).toBe(false);
    expect(body.repos[MS]).toMatchObject({ at: later, stale: false, ownerTotal: 34 });
    expect(body.repos[THIRD]).toMatchObject({ at: new Date(START).toISOString(), stale: true, total: 5 });
  });

  it("finishes a Yes when its issue closes after it: done when completed, parked when not planned, and nothing else moves", async () => {
    const getAsk = async (id: string) => (await (await fetch(`${server.base}/api/asks/${id}`, { headers: bearer(BOARD_TOKEN) })).json()) as Ask;
    expect((await ask({ id: "a-1", words: "Yes from the backlog: example-repo#300", source: `backlog:${MS}#300`, repo: MS, issue: 300 })).status).toBe(201);
    expect((await ask({ id: "a-2", words: "Yes from the backlog: third-repo#12", source: `backlog:${THIRD}#12`, repo: THIRD, issue: 12, stage: "building" })).status).toBe(201);
    expect((await ask({ id: "a-3", words: "Yes from the backlog: example-repo#301", source: `backlog:${MS}#301`, repo: MS, issue: 301 })).status).toBe(201);
    // Sam's own words naming an issue, a Yes whose issue is still open, one already parked by hand, and a Yes that
    // needs Sam stay put.
    expect((await ask({ id: "a-4", words: "Fix the search filter", repo: MS, issue: 7302 })).status).toBe(201);
    expect((await ask({ id: "a-5", words: "Yes from the backlog: example-repo#7303", source: `backlog:${MS}#7303`, repo: MS, issue: 7303 })).status).toBe(201);
    expect((await ask({ id: "a-6", words: "Yes from the backlog: example-repo#7304", source: `backlog:${MS}#7304`, repo: MS, issue: 7304, stage: "parked" })).status).toBe(201);
    expect((await ask({ id: "a-7", words: "Yes from the backlog: example-repo#7305", source: `backlog:${MS}#7305`, repo: MS, issue: 7305, stage: "needs-you" })).status).toBe(201);

    // A reading before any close moves nothing; an older bridge's reading has no closed list at all.
    expect((await put(snapshot())).status).toBe(200);
    expect((await getAsk("a-1")).stage).toBe("queued");

    clock.advance(10 * 60_000);
    const closedAt = new Date(clock.now()).toISOString();
    const reading = snapshot({ at: closedAt });
    reading.repos[0]!.closed = [
      { number: 300, closedAt, reason: "completed" },
      { number: 301, closedAt, reason: "not_planned" },
      { number: 7302, closedAt, reason: "completed" },
      { number: 7304, closedAt, reason: "completed" },
      { number: 7305, closedAt, reason: "completed" },
    ];
    reading.repos.push({ repo: THIRD, total: 1, logs: 0, ownerTotal: 0, owner: [], recent: [], bugs: [], closed: [{ number: 12, closedAt, reason: "duplicate" }] });
    expect((await put(reading)).status).toBe(200);

    const done = await getAsk("a-1");
    expect(done).toMatchObject({ stage: "done", stageAt: closedAt });
    expect(done.timeline.at(-1)).toEqual({ at: closedAt, stage: "done", note: "Issue #300 closed", by: "rivet" });
    expect((await getAsk("a-2")).timeline.at(-1)).toMatchObject({ stage: "parked", note: "Issue #12 closed as a duplicate" });
    expect((await getAsk("a-3")).timeline.at(-1)).toMatchObject({ stage: "parked", note: "Issue #301 closed as not planned" });
    expect((await getAsk("a-4")).stage).toBe("queued");
    expect((await getAsk("a-5")).stage).toBe("queued");
    expect((await getAsk("a-7")).stage).toBe("needs-you");
    const parked = await getAsk("a-6");
    expect(parked.stage).toBe("parked");
    expect(parked.timeline.some((event) => event.note?.startsWith("Issue"))).toBe(false);

    // The next reading still lists the closes: nothing moves twice.
    clock.advance(5 * 60_000);
    expect((await put({ ...reading, at: new Date(clock.now()).toISOString() })).status).toBe(200);
    expect((await getAsk("a-1")).version).toBe(done.version);
  });

  it("finishes nothing from a late reading, one no newer than the last, or a replay, which cannot know of an issue reopened since", async () => {
    const getAsk = async (id: string) => (await (await fetch(`${server.base}/api/asks/${id}`, { headers: bearer(BOARD_TOKEN) })).json()) as Ask;
    expect((await ask({ id: "a-1", words: "Yes from the backlog: example-repo#300", source: `backlog:${MS}#300`, repo: MS, issue: 300 })).status).toBe(201);
    const closed = [{ number: 300, closedAt: new Date(START - 60_000).toISOString(), reason: "completed" as const }];
    clock.advance(30 * 60_000);
    const late = snapshot();
    late.repos[0]!.closed = closed;
    expect((await put(late)).status).toBe(200);
    expect((await getAsk("a-1")).stage).toBe("queued");

    expect((await put(snapshot({ at: new Date(clock.now()).toISOString() }))).status).toBe(200);
    const older = snapshot({ at: new Date(clock.now().getTime() - 60_000).toISOString() });
    older.repos[0]!.closed = closed;
    expect((await put(older)).status).toBe(200);
    expect((await getAsk("a-1")).stage).toBe("queued");
    // The same older reading again: a replay, so still nothing.
    expect((await put(older)).status).toBe(200);
    expect((await getAsk("a-1")).stage).toBe("queued");

    clock.advance(5 * 60_000);
    const current = snapshot({ at: new Date(clock.now()).toISOString() });
    current.repos[0]!.closed = closed;
    expect((await put(current)).status).toBe(200);
    expect((await getAsk("a-1")).stage).toBe("done");
  });

  it("keeps the newest reading that counted, so a late one between older ones, or a future-dated one sent again, finishes nothing", async () => {
    const getAsk = async (id: string) => (await (await fetch(`${server.base}/api/asks/${id}`, { headers: bearer(BOARD_TOKEN) })).json()) as Ask;
    expect((await ask({ id: "a-1", words: "Yes from the backlog: example-repo#300", source: `backlog:${MS}#300`, repo: MS, issue: 300 })).status).toBe(201);
    const closed = [{ number: 300, closedAt: new Date(START - 60_000).toISOString(), reason: "completed" as const }];
    const at = (ms: number) => new Date(clock.now().getTime() + ms).toISOString();

    expect((await put(snapshot({ at: at(0) }))).status).toBe(200);
    clock.advance(15 * 60_000);
    // A late reading, older than the one that counted, must not drag the mark back for a fresh but older one after it.
    expect((await put(snapshot({ at: at(-25 * 60_000) }))).status).toBe(200);
    const older = snapshot({ at: at(-19 * 60_000) });
    older.repos[0]!.closed = closed;
    expect((await put(older)).status).toBe(200);
    expect((await getAsk("a-1")).stage).toBe("queued");

    // A reading dated a minute ahead of the server counts once by its own time. Sent again later, it is a replay.
    const ahead = snapshot({ at: at(60_000) });
    expect((await put(ahead)).status).toBe(200);
    clock.advance(5 * 60_000);
    ahead.repos[0]!.closed = closed;
    expect((await put(ahead)).status).toBe(200);
    expect((await getAsk("a-1")).stage).toBe("queued");

    // A reading dated far ahead (a wrong bridge clock) finishes nothing and holds back no reading after it.
    const wrong = snapshot({ at: at(365 * 86_400_000) });
    wrong.repos[0]!.closed = closed;
    expect((await put(wrong)).status).toBe(200);
    expect((await getAsk("a-1")).stage).toBe("queued");

    clock.advance(5 * 60_000);
    const current = snapshot({ at: at(0) });
    current.repos[0]!.closed = closed;
    expect((await put(current)).status).toBe(200);
    expect((await getAsk("a-1")).stage).toBe("done");
  });

  it("starts the mark just past now over a stored reading, so nothing sent before it finishes asks", async () => {
    const getAsk = async (id: string) => (await (await fetch(`${server.base}/api/asks/${id}`, { headers: bearer(BOARD_TOKEN) })).json()) as Ask;
    expect((await ask({ id: "a-1", words: "Yes from the backlog: example-repo#300", source: `backlog:${MS}#300`, repo: MS, issue: 300 })).status).toBe(201);
    const closed = [{ number: 300, closedAt: new Date(START - 60_000).toISOString(), reason: "completed" as const }];
    const at = (ms: number) => new Date(clock.now().getTime() + ms).toISOString();
    // Stored as now, but sets no mark: like a store from before the mark existed.
    expect((await put(snapshot({ at: at(10 * 60_000) }))).status).toBe(200);
    const older = snapshot({ at: at(-60_000) });
    older.repos[0]!.closed = closed;
    expect((await put(older)).status).toBe(200);
    expect((await getAsk("a-1")).stage).toBe("queued");
    // A late reading leaves the mark where it was. A reading sent a minute ahead before the upgrade, replayed now, still
    // counts for nothing.
    expect((await put(snapshot({ at: at(-25 * 60_000) }))).status).toBe(200);
    const early = snapshot({ at: at(60_000) });
    early.repos[0]!.closed = closed;
    expect((await put(early)).status).toBe(200);
    expect((await getAsk("a-1")).stage).toBe("queued");

    clock.advance(5 * 60_000);
    const current = snapshot({ at: at(0) });
    current.repos[0]!.closed = closed;
    expect((await put(current)).status).toBe(200);
    expect((await getAsk("a-1")).stage).toBe("done");
  });

  it("rejects a closed issue with an unknown reason or a body", async () => {
    const reading = snapshot();
    reading.repos[0]!.closed = [{ number: 1, closedAt: "2026-11-02T09:00:00.000Z", reason: "reopened" as "completed" }];
    expect((await put(reading)).status).toBe(400);
    reading.repos[0]!.closed = [{ number: 1, closedAt: "2026-11-02T09:00:00.000Z", reason: "completed", body: "x" } as never];
    expect((await put(reading)).status).toBe(400);
  });

  it("caps queued and parked asks apart, so many newer parked asks never push out one not started", async () => {
    expect((await ask({ id: "a-1", words: "The oldest ask, not started" })).status).toBe(201);
    for (let i = 2; i <= MAX_BACKLOG_ASKS + 2; i++) {
      clock.advance(1000);
      expect((await ask({ id: `a-${i}`, words: `Parked ${i}`, stage: "parked" })).status).toBe(201);
    }
    const body = (await (await read()).json()) as BacklogResponse;
    const parked = body.asks.filter((one) => one.stage === "parked");
    expect(parked).toHaveLength(MAX_BACKLOG_ASKS);
    expect(parked.at(-1)!.id).toBe("a-3");
    expect(body.asks.at(-1)).toMatchObject({ id: "a-1", stage: "queued" });
  }, 60_000);
});
