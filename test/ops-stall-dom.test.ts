// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET_TIMEOUT_MS } from "../web/src/api.js";
import { opsData, refreshOps } from "../web/src/ops-data.js";

// An Ops request whose headers came back but whose body never finished held refreshOps' one in-flight promise
// open, so every later refresh waited on it and Ops never updated again until a reload.

let asked: string[];

/** /api/ops answers 200 and then never finishes its body, until the request is aborted, as a real fetch does. */
function stallingFetch(url: string, init?: RequestInit): Promise<Response> {
  asked.push(url);
  const signal = init?.signal ?? null;
  if (url === "/api/ops" && asked.filter((path) => path === "/api/ops").length === 1) {
    const json = () =>
      new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      });
    return Promise.resolve({ ok: true, status: 200, json } as unknown as Response);
  }
  const body = url === "/api/briefing" ? { briefing: null } : url === "/api/ops/timeline" ? { events: [] } : url === "/api/ops/status" ? { statuses: [] } : { now: new Date().toISOString(), summary: {} };
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
}

beforeEach(() => {
  asked = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("fetch", vi.fn(stallingFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  opsData.ops = null;
  opsData.error = null;
});

describe("Ops refresh with a stalled answer", () => {
  it("gives the stalled request up after GET_TIMEOUT_MS, so the next refresh asks again", async () => {
    const first = refreshOps();
    // While it is stuck, a second refresh shares the one in flight rather than piling up.
    expect(refreshOps()).toBe(first);
    await vi.advanceTimersByTimeAsync(GET_TIMEOUT_MS - 1);
    let settled = false;
    void first.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(opsData.error).toMatch(/took too long/);
    const second = refreshOps();
    expect(second).not.toBe(first);
    await second;
    expect(asked.filter((path) => path === "/api/ops")).toHaveLength(2);
    expect(opsData.ops).not.toBeNull();
    expect(opsData.error).toBeNull();
  });
});
