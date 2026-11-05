import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeChannel, OFFLINE_GRACE_MS } from "../src/server/events.js";

/** A fake SSE response whose close the test fires, as a dropped bridge does. */
function connection(): { response: ServerResponse; close: () => void } {
  let onClose = () => {};
  const response = {
    writeHead: () => {},
    write: () => true,
    on: (event: string, listener: () => void) => {
      if (event === "close") onClose = listener;
    },
    end: () => {},
  } as unknown as ServerResponse;
  return { response, close: () => onClose() };
}

describe("bridge status", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a bridge that reconnects within the grace never shows as offline; one gone longer does", () => {
    expect(OFFLINE_GRACE_MS).toBeGreaterThanOrEqual(90_000);
    const channel = new BridgeChannel();
    expect(channel.status().connected).toBe(false);
    const first = connection();
    channel.attach(first.response, []);
    expect(channel.status().connected).toBe(true);

    // A normal reconnect: the bridge drops and is back about 30 s later.
    first.close();
    vi.advanceTimersByTime(30_000);
    expect(channel.status().connected).toBe(true);
    const second = connection();
    channel.attach(second.response, []);
    expect(channel.status().connected).toBe(true);

    // Really gone: still shown until the grace runs out, offline after it.
    second.close();
    vi.advanceTimersByTime(OFFLINE_GRACE_MS - 1);
    expect(channel.status().connected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(channel.status().connected).toBe(false);
  });

  it("the bridge's other uploads never stretch the grace: only its event stream counts", () => {
    const channel = new BridgeChannel();
    const stream = connection();
    channel.attach(stream.response, []);
    stream.close();
    // Worker uploads keep arriving every 20 s while the stream stays down.
    for (let at = 0; at < OFFLINE_GRACE_MS; at += 20_000) {
      vi.advanceTimersByTime(20_000);
      channel.seen();
    }
    expect(channel.status().connected).toBe(false);
  });
});
