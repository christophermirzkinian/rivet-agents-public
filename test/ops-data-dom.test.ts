// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { BRIEFING_STALE_MS, CLAUDE_STALE_MS, GITHUB_STALE_MS, MAC_STALE_MS, type OpsResponse } from "../src/shared/ops.js";
import { healthCurrent, macCurrent, opsAge, opsData, readingAge, refreshOps, schedulesCurrent, watchOps } from "../web/src/ops-data.js";

import { SCHEDULES_STALE_MS } from "../src/shared/schedules.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Every server's answer has its summary; refreshOps refuses one without it. */
const summary = { needs: 0, redCi: 0, failingSchedules: 0, appsDown: 0, disk: { freePct: null, tone: "ok" } };

/** An Ops answer whose GitHub reading has `leftMs` before it goes out of date. */
function ops(leftMs: number) {
  const now = Date.now();
  return { now: new Date(now).toISOString(), summary, github: { at: new Date(now - GITHUB_STALE_MS + leftMs).toISOString(), stale: false } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  opsData.ops = null;
  opsData.at = 0;
  opsData.opsAt = { mono: 0, wall: 0 };
});

describe("Ops answers without a summary", () => {
  it("refuses one as a failed load and keeps the last good reading, so the status line never reads past it", async () => {
    const answers = [ops(60_000), {}];
    vi.stubGlobal("fetch", vi.fn((path: string) => Promise.resolve(json(path === "/api/ops" ? answers.shift() : path === "/api/ops/timeline" ? { events: [] } : { briefing: null }))));
    await refreshOps();
    const good = opsData.ops;
    expect(good?.summary).toBeDefined();
    await refreshOps();
    expect(opsData.ops).toBe(good);
    expect(opsData.error).toBe("Ops answered without its summary.");
  });

  it("still signs out when another part was refused for the session", async () => {
    const signedOut = vi.spyOn(await import("../web/src/state.js"), "signedOut").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn((path: string) => Promise.resolve(path === "/api/ops" ? json({}) : new Response('{"error":"sign in"}', { status: 401, headers: { "content-type": "application/json" } }))));
    await refreshOps();
    expect(signedOut).toHaveBeenCalledOnce();
    signedOut.mockRestore();
  });
});

describe("an Ops read still pending at sign-in", () => {
  const refused = () => new Response('{"error":"sign in"}', { status: 401, headers: { "content-type": "application/json" } });

  it("neither signs the new session out nor holds up its own read", async () => {
    const { resetSession, whenSignedOut } = await import("../web/src/state.js");
    const signOuts: string[] = [];
    whenSignedOut((message) => signOuts.push(message));
    let releaseOld!: () => void;
    const old = new Promise<Response>((resolve) => (releaseOld = () => resolve(refused())));
    let opsReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => (path === "/api/ops" && ++opsReads === 1 ? old : Promise.resolve(json(path === "/api/ops" ? ops(60_000) : path === "/api/ops/timeline" ? { events: [] } : { briefing: null })))),
    );
    resetSession();
    const before = refreshOps();
    resetSession();
    const after = refreshOps();
    expect(opsReads).toBe(2);
    await after;
    expect(opsData.ops?.summary).toBeDefined();
    releaseOld();
    await before;
    expect(signOuts).toEqual([]);
    whenSignedOut(() => {});
  });

  it("does not fill the new session's Ops with the old one's answer", async () => {
    const { resetSession } = await import("../web/src/state.js");
    let releaseOld!: () => void;
    const old = new Promise<Response>((resolve) => (releaseOld = () => resolve(json(ops(60_000)))));
    vi.stubGlobal("fetch", vi.fn((path: string) => (path === "/api/ops" ? old : Promise.resolve(json(path === "/api/ops/timeline" ? { events: [] } : { briefing: null })))));
    resetSession();
    const before = refreshOps();
    resetSession();
    releaseOld();
    await before;
    expect(opsData.ops).toBeNull();
  });
});

describe("Ops data freshness", () => {
  it("dates the Ops answer from its own arrival, not from a slower timeline", async () => {
    let releaseTimeline!: () => void;
    const timeline = new Promise<Response>((resolve) => (releaseTimeline = () => resolve(json({ events: [] }))));
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => (path === "/api/ops" ? Promise.resolve(json(ops(60_000))) : path === "/api/ops/timeline" ? timeline : Promise.resolve(json({ briefing: null })))),
    );
    const done = refreshOps();
    await wait(20);
    const arrived = performance.now();
    await wait(80);
    releaseTimeline();
    await done;
    expect(opsData.ops).not.toBeNull();
    expect(opsData.opsAt.mono).toBeLessThanOrEqual(arrived);
  });

  it("dates a slow answer from when it was asked, so its transit never counts as fresh", async () => {
    let release!: () => void;
    const slow = new Promise<Response>((resolve) => (release = () => resolve(json(ops(60_000)))));
    vi.stubGlobal("fetch", vi.fn((path: string) => (path === "/api/ops" ? slow : path === "/api/ops/timeline" ? Promise.resolve(json({ events: [] })) : Promise.resolve(json({ briefing: null })))));
    const asked = performance.now();
    const done = refreshOps();
    await wait(100);
    release();
    await done;
    expect(opsData.opsAt.mono).toBeLessThan(asked + 50);
    expect(opsAge()).toBeGreaterThanOrEqual(90);
  });

  it("ages the answer by the longer clock: a wall clock set back, or a monotonic one that stood still through sleep", () => {
    opsData.opsAt = { mono: performance.now(), wall: Date.now() + 3_600_000 };
    expect(opsAge()).toBeLessThan(1_000);
    opsData.opsAt = { mono: performance.now(), wall: Date.now() - 300_000 };
    expect(opsAge()).toBeGreaterThanOrEqual(300_000);
  });

  it("repaints when GitHub's reading goes out of date, though no poll answers", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => {
        if (calls++ >= 2) return new Promise(() => {});
        return Promise.resolve(path === "/api/ops" ? json(ops(120)) : path === "/api/ops/timeline" ? json({ events: [] }) : json({ briefing: null }));
      }),
    );
    const listener = vi.fn();
    const stop = watchOps(listener);
    await wait(60);
    expect(listener).toHaveBeenCalledTimes(1);
    await wait(250);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });
  it("repaints at the check timestamp's expiry instead of fifteen minutes after arrival", async () => {
    let answered = false;
    vi.stubGlobal("fetch", vi.fn((path: string) => {
      if (answered) return new Promise(() => {});
      if (path === "/api/ops") {
        const now = Date.now();
        return Promise.resolve(json({ now: new Date(now).toISOString(), summary, healthStaleSince: null,
          apps: [{ health: { checkedAt: new Date(now - BRIEFING_STALE_MS + 120).toISOString() } }],
        }));
      }
      return Promise.resolve(json(path === "/api/ops/timeline" ? { events: [] } : { briefing: null }));
    }));
    const listener = vi.fn();
    const stop = watchOps(listener);
    await wait(60);
    answered = true;
    expect(healthCurrent(opsData.ops!)).toBe(true);
    const calls = listener.mock.calls.length;
    await wait(250);
    expect(healthCurrent(opsData.ops!)).toBe(false);
    expect(listener.mock.calls.length).toBeGreaterThan(calls);
    stop();
  });

});


describe("Ops remaining reading deadlines", () => {
  it.each(["failed", "hung"])("notifies at each individual deadline while a poll is %s, despite offset and backwards wall clocks", async (mode) => {
    const serverNow = Date.parse("2026-10-01T03:00:00Z");
    const deviceNow = serverNow - 3_600_000;
    vi.useFakeTimers({ now: deviceNow, toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const stamp = (limit: number, left: number) => new Date(serverNow - limit + left).toISOString();
    const answer = {
      now: new Date(serverNow).toISOString(),
      healthStaleSince: "old",
      mac: { at: stamp(MAC_STALE_MS, 1_000), stale: false },
      claude: { at: stamp(CLAUDE_STALE_MS, 2_000), stale: false },
      summary: { schedulesAt: stamp(SCHEDULES_STALE_MS, 3_000) },
    } as unknown as OpsResponse;
    let initial = true;
    let release!: () => void;
    const hanging = new Promise<Response>((resolve) => { release = () => resolve(new Response(null, { status: 503 })); });
    vi.stubGlobal("fetch", vi.fn((path: string) => {
      if (!initial && path === "/api/ops") return mode === "hung" ? hanging : Promise.reject(new Error("down"));
      return Promise.resolve(json(path === "/api/ops" ? answer : path === "/api/ops/timeline" ? { events: [] } : path === "/api/ops/statuses" ? { statuses: [] } : { briefing: null }));
    }));
    await refreshOps();
    const current = () => [macCurrent(answer), readingAge(answer, answer.claude!.at) <= CLAUDE_STALE_MS, schedulesCurrent(answer)];
    const listener = vi.fn();
    const stop = watchOps(listener);
    initial = false;
    const pending = refreshOps();
    if (mode === "failed") await pending;
    // A backwards adjustment must not extend any of the readings' lives.
    vi.setSystemTime(deviceNow - 3_600_000);
    listener.mockClear();
    try {
      expect(current()).toEqual([true, true, true]);
      for (let expired = 1; expired <= 3; expired++) {
        await vi.advanceTimersByTimeAsync(expired === 1 ? 1_050 : 1_000);
        expect(current()).toEqual(Array.from({ length: 3 }, (_, index) => index >= expired));
        expect(listener).toHaveBeenCalledTimes(expired);
      }
    } finally {
      stop();
      release();
      await pending;
    }
  });
});
