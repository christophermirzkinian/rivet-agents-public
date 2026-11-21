// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, call } from "../web/src/api.js";
import { probeCloud, resetCloud } from "../web/src/cloud-agent.js";
import { fellAsleep, isAsleep, onCap, onWake, resetSleep, watchInput } from "../web/src/rivet-sleep.js";

// Rivet Cloud: the app's own timed requests say they are background, and once the machine goes to sleep they stop
// until the next real input, so an ignored open tab cannot keep waking it.

const sent: { path: string; headers: Record<string, string> }[] = [];
let answer = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

watchInput(document);

beforeEach(() => {
  resetSleep();
  sent.length = 0;
  answer = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      sent.push({ path, headers: { ...(init?.headers as Record<string, string>) } });
      return answer();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("rivet-sleep", () => {
  it("marks a request with no input before it as background, and one right after a tap as a visit", async () => {
    await call("GET", "/api/status");
    expect(sent[0]!.headers["x-rivet-background"]).toBe("1");
    document.dispatchEvent(new Event("pointerdown"));
    await call("POST", "/api/replies", { text: "hi" });
    expect(sent[1]!.headers["x-rivet-background"]).toBeUndefined();
    expect(sent[1]!.headers["x-rivet"]).toBe("1");
  });

  it("sends no background request while asleep, and wakes on the next key", async () => {
    fellAsleep();
    await expect(call("GET", "/api/status")).rejects.toBeInstanceOf(ApiError);
    expect(sent).toHaveLength(0);
    const woke = vi.fn();
    onWake(woke);
    document.dispatchEvent(new Event("keydown"));
    expect(woke).toHaveBeenCalledTimes(1);
    expect(isAsleep()).toBe(false);
    await call("GET", "/api/status");
    expect(sent).toHaveLength(1);
  });

  it("falls asleep on an answer marked x-rivet-asleep (the cap page)", async () => {
    answer = () => new Response("capped", { status: 503, headers: { "x-rivet-asleep": "1" } });
    await expect(call("GET", "/api/status")).rejects.toBeInstanceOf(ApiError);
    expect(isAsleep()).toBe(true);
  });

  it("shows the cap page's message and day over the app, sends nothing more in the background, and clears it once served again", async () => {
    answer = () => new Response("capped", { status: 503, headers: { "x-rivet-asleep": "1", "x-rivet-capped-until": String(Date.UTC(2026, 11, 1)) } });
    await expect(call("GET", "/api/status")).rejects.toBeInstanceOf(ApiError);
    const note = document.getElementById("rivet-cap");
    expect(note?.getAttribute("role")).toBe("status");
    expect(note?.textContent).toContain("You've used this month's 200 hours.");
    expect(note?.textContent).toContain("Your Rivet wakes again on 1 December.");
    // Beside the body, so the app and its sheets lay out below it rather than under it.
    expect(note?.parentElement).toBe(document.documentElement);
    expect(note?.nextElementSibling).toBe(document.body);
    for (let i = 0; i < 5; i += 1) await expect(call("GET", "/api/status")).rejects.toBeInstanceOf(ApiError);
    expect(sent).toHaveLength(1);
    answer = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    document.dispatchEvent(new Event("pointerdown"));
    await call("GET", "/api/status");
    expect(document.getElementById("rivet-cap")).toBeNull();
  });

  it("says your agent wakes again on a hosted machine", async () => {
    answer = () => new Response(JSON.stringify({ name: "Pip", setupDone: true, firstPlan: "claude" }), { status: 200, headers: { "content-type": "application/json" } });
    await probeCloud();
    try {
      answer = () => new Response("capped", { status: 503, headers: { "x-rivet-asleep": "1", "x-rivet-capped-until": String(Date.UTC(2026, 11, 1)) } });
      await expect(call("GET", "/api/status")).rejects.toBeInstanceOf(ApiError);
      expect(document.getElementById("rivet-cap")?.textContent).toMatch(/Your agent wakes again on 1\sDecember\./);
    } finally {
      resetCloud();
    }
  });

  it("tells the composer the cap's day while capped, once per change, and null when it lifts", async () => {
    const seen: (string | null)[] = [];
    const stop = onCap((wake) => seen.push(wake));
    answer = () => new Response("capped", { status: 503, headers: { "x-rivet-asleep": "1", "x-rivet-capped-until": String(Date.UTC(2026, 11, 1)) } });
    await expect(call("GET", "/api/status")).rejects.toBeInstanceOf(ApiError);
    document.dispatchEvent(new Event("pointerdown"));
    await expect(call("GET", "/api/status")).rejects.toBeInstanceOf(ApiError);
    const late: (string | null)[] = [];
    onCap((wake) => late.push(wake));
    answer = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    document.dispatchEvent(new Event("pointerdown"));
    await call("GET", "/api/status");
    expect(seen).toEqual([null, "until 1 December", null]);
    expect(late).toEqual(["until 1 December", null]);
    stop();
  });

  it("a plain sleep answer shows no cap message", async () => {
    answer = () => new Response("asleep", { status: 503, headers: { "x-rivet-asleep": "1" } });
    await expect(call("GET", "/api/status")).rejects.toBeInstanceOf(ApiError);
    expect(document.getElementById("rivet-cap")).toBeNull();
  });

  it("after a tap wakes it, the loads in the next 15 s go as a visit, and later timed ones as background again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fellAsleep();
    document.dispatchEvent(new Event("pointerdown"));
    vi.setSystemTime(Date.now() + 14_000);
    await call("GET", "/api/chat");
    expect(sent[0]!.headers["x-rivet-background"]).toBeUndefined();
    vi.setSystemTime(Date.now() + 2_000);
    await call("GET", "/api/chat");
    expect(sent[1]!.headers["x-rivet-background"]).toBe("1");
    // A tap with no sleep before it gives only its own 3 s.
    document.dispatchEvent(new Event("pointerdown"));
    vi.setSystemTime(Date.now() + 4_000);
    await call("GET", "/api/chat");
    expect(sent[2]!.headers["x-rivet-background"]).toBe("1");
  });
});
