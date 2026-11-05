import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONTROL_WAIT_MS } from "../src/server/routes/home.js";

import { HOME_BUTTONS_MAX, homeControlAckSchema, homeControlSchema, homeSnapshotSchema, HOME_TILES_MAX, type HomeResponse, type HomeSnapshot } from "../src/shared/home.js";
import { bearer, BRIDGE_TOKEN, browser, ORIGIN, startServer, type TestServer } from "./helpers.js";

const AT = "2026-10-25T02:00:00.000Z";
const BUTTON = "0123456789abcdef";
const READING: HomeSnapshot = {
  at: AT,
  haReachable: true,
  tiles: [
    { label: "Reading one", value: "21.5", unit: "units" },
    { label: "Gone quiet", value: null, unit: null },
  ],
  buttons: [{ id: BUTTON, label: "Lamp on" }],
};
const ID = ["6f1c1a2e", "1b7a", "4c1e", "9a43", "0d6f5f0f6b11"].join("-");

let server: TestServer;
let logs: string[];
beforeEach(async () => {
  logs = [];
  server = await startServer({}, { logs });
});
afterEach(async () => {
  await server.close();
});

const put = (body: unknown, headers: Record<string, string> = bearer(BRIDGE_TOKEN)) =>
  fetch(`${server.base}/api/bridge/home`, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
const control = (headers: Record<string, string>, body: unknown = { button: BUTTON }) =>
  fetch(`${server.base}/api/home/control`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const ack = (body: unknown, headers: Record<string, string> = bearer(BRIDGE_TOKEN)) =>
  fetch(`${server.base}/api/bridge/home/control-ack`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });

/** The bridge's event stream, offering `features`; what it has read so far. */
async function openBridge(features: string): Promise<{ events(): { event: string; data: Record<string, unknown> }[]; abort(): void }> {
  const controller = new AbortController();
  const response = await fetch(`${server.base}/api/bridge/events`, { headers: { ...bearer(BRIDGE_TOKEN), "x-rivet-bridge-features": features }, signal: controller.signal });
  expect(response.status).toBe(200);
  let buffer = "";
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
      }
    } catch {}
  })();
  const events = () =>
    buffer
      .split("\n\n")
      .filter((block) => block.startsWith("event:"))
      .map((block) => {
        const fields = Object.fromEntries(block.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]));
        return { event: fields.event!, data: JSON.parse(fields.data!) as Record<string, unknown> };
      });
  return { events, abort: () => controller.abort() };
}

async function waitForEvent(bridge: Awaited<ReturnType<typeof openBridge>>, name: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 300; i++) {
    const found = bridge.events().find((one) => one.event === name);
    if (found) return found.data;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no ${name} event`);
}

describe("the Home snapshot", () => {
  it("takes a reading and the Home Assistant down shape, nothing more", () => {
    const tile = { label: "One", value: "1", unit: null };
    const button = { id: BUTTON, label: "Press" };
    expect(homeSnapshotSchema.safeParse(READING).success).toBe(true);
    expect(homeSnapshotSchema.safeParse({ at: AT, haReachable: true, tiles: [], buttons: [] }).success).toBe(true);
    expect(homeSnapshotSchema.safeParse({ at: AT, haReachable: false }).success).toBe(true);
    expect(homeSnapshotSchema.safeParse({ at: AT, haReachable: false, tiles: [] }).success).toBe(false);
    expect(homeSnapshotSchema.safeParse({ ...READING, extra: 1 }).success).toBe(false);
    expect(homeSnapshotSchema.safeParse({ ...READING, tiles: [{ ...tile, entity_id: "sensor.example_reading" }] }).success).toBe(false);
    expect(homeSnapshotSchema.safeParse({ ...READING, buttons: [{ ...button, service: "light.turn_on" }] }).success).toBe(false);
    expect(homeSnapshotSchema.safeParse({ ...READING, buttons: [{ ...button, id: "light.turn_on" }] }).success).toBe(false);
  });

  it("caps the lists and their words", () => {
    const tile = { label: "One", value: "1", unit: null };
    const button = { id: BUTTON, label: "Press" };
    const tiles = (count: number, one: unknown = tile) => homeSnapshotSchema.safeParse({ ...READING, tiles: Array.from({ length: count }, () => one) }).success;
    expect(tiles(HOME_TILES_MAX)).toBe(true);
    expect(tiles(HOME_TILES_MAX + 1)).toBe(false);
    expect(homeSnapshotSchema.safeParse({ ...READING, buttons: Array.from({ length: HOME_BUTTONS_MAX + 1 }, () => button) }).success).toBe(false);
    expect(tiles(1, { ...tile, label: "x".repeat(65) })).toBe(false);
    expect(tiles(1, { ...tile, label: "" })).toBe(false);
    expect(tiles(1, { ...tile, value: "x".repeat(97) })).toBe(false);
    expect(tiles(1, { ...tile, unit: "x".repeat(33) })).toBe(false);
  });

  it("takes only a button id and the ack's own codes", () => {
    expect(homeControlSchema.safeParse({ button: BUTTON }).success).toBe(true);
    expect(homeControlSchema.safeParse({ button: "light.turn_on" }).success).toBe(false);
    expect(homeControlSchema.safeParse({ button: BUTTON, entity_id: "light.example_lamp" }).success).toBe(false);
    expect(homeControlAckSchema.safeParse({ id: ID, ok: false, error: "unknown_button" }).success).toBe(true);
    expect(homeControlAckSchema.safeParse({ id: ID, ok: false, error: "refused by the service" }).success).toBe(false);
    expect(homeControlAckSchema.safeParse({ id: ID, ok: true, host: "x" }).success).toBe(false);
  });
});

describe("PUT /api/bridge/home and GET /api/home", () => {
  const read = async () => (await (await fetch(`${server.base}/api/home`, { headers: { cookie: server.cookie() } })).json()) as HomeResponse;

  it("needs the bridge token to write and a session to read", async () => {
    expect((await put(READING, {})).status).toBe(401);
    expect((await put(READING, bearer("d".repeat(64)))).status).toBe(401);
    expect((await fetch(`${server.base}/api/home`)).status).toBe(401);
  });

  it("keeps the last snapshot, and has nothing until one comes", async () => {
    expect(await read()).toEqual({ snapshot: null, receivedAt: null });

    expect((await put(READING)).status).toBe(200);
    const kept = await read();
    expect(kept.snapshot).toEqual(READING);
    expect(typeof kept.receivedAt).toBe("string");

    expect((await put({ at: AT, haReachable: false })).status).toBe(200);
    expect((await read()).snapshot).toEqual({ at: AT, haReachable: false });
  });

  it("redacts what Home Assistant said before keeping it", async () => {
    const token = `${"gh"}p_${"a1B2".repeat(9)}`;
    const leaky: HomeSnapshot = { at: AT, haReachable: true, tiles: [{ label: "Reading one", value: token, unit: null }], buttons: [] };
    expect((await put(leaky)).status).toBe(200);
    const stored = JSON.stringify((await read()).snapshot);
    expect(stored).not.toContain(token);
    expect(stored).toContain("[redacted");
  });

  it("refuses a malformed or oversized snapshot", async () => {
    expect((await put({ at: AT })).status).toBe(400);
    expect((await put({ ...READING, pad: "x".repeat(17_000) })).status).toBe(413);
  });
});

describe("POST /api/home/control", () => {
  it("needs a session and the app's own origin", async () => {
    const cookie = server.cookie();
    expect((await control({ origin: ORIGIN, "x-rivet": "1", "content-type": "application/json" })).status).toBe(401);
    expect((await control({ ...browser(cookie), origin: "https://evil.example" })).status).toBe(403);
    const noHeader: Record<string, string> = { ...browser(cookie) };
    delete noHeader["x-rivet"];
    expect((await control(noHeader)).status).toBe(403);
  });

  it("says the bridge is offline when none is connected is connected, or one too old to know the event", async () => {
    const cookie = server.cookie();
    const offline = await control(browser(cookie));
    expect(offline.status).toBe(503);
    expect(await offline.json()).toEqual({ error: "bridge_offline" });
    const old = await openBridge("image,chat-window,home");
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await control(browser(cookie))).status).toBe(503);
      expect(old.events().some((one) => one.event === "home-control")).toBe(false);
    } finally {
      old.abort();
    }
  });

  it("refuses a bad button without saying what was sent", async () => {
    const response = await control(browser(server.cookie()), { button: "<b>reboot</b>" });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(JSON.stringify({ error: "invalid_button" }));
    expect((await control(browser(server.cookie()), `{"button":"${BUTTON}","pad":"${"x".repeat(300)}"}`)).status).toBe(413);
  });

  it("hands the button id to the bridge, waits for its ack and answers ok; one at a time", async () => {
    const bridge = await openBridge("home-control");
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const cookie = server.cookie();
      const pending = control(browser(cookie));
      const event = await waitForEvent(bridge, "home-control");
      expect(Object.keys(event).sort()).toEqual(["button", "id", "until"]);
      expect(event.button).toBe(BUTTON);
      // The bridge must be done 2 s before the server's wait ends.
      const until = event.until as number;
      expect(until).toBeGreaterThan(Date.now() + CONTROL_WAIT_MS - 8_000);
      expect(until).toBeLessThanOrEqual(Date.now() + CONTROL_WAIT_MS - 2_000);
      const busy = await control(browser(cookie));
      expect(busy.status).toBe(409);
      expect(await busy.json()).toEqual({ error: "busy" });
      expect((await ack({ id: event.id, ok: true })).status).toBe(200);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(JSON.stringify({ ok: true }));
      expect((await ack({ id: event.id, ok: true })).status).toBe(404);
    } finally {
      bridge.abort();
    }
  });

  it("passes on the bridge's error code, refuses a forged ack, and limits taps", async () => {
    const bridge = await openBridge("home-control");
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await ack({ id: ID, ok: true }, { ...browser(server.cookie()) })).status).toBe(401);
      expect((await ack({ id: ID, ok: false, error: "kaboom" })).status).toBe(400);

      const pending = control(browser(server.cookie()));
      const event = await waitForEvent(bridge, "home-control");
      await ack({ id: event.id, ok: false, error: "unknown_button" });
      const response = await pending;
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "unknown_button" });
    } finally {
      bridge.abort();
    }
    const cookie = server.cookie();
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) statuses.push((await control(browser(cookie), { button: "nope" })).status);
    expect(statuses.at(-2)).toBe(400);
    expect(statuses.at(-1)).toBe(429);
  });

  it("gives up with 504 when the bridge never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const bridge = await openBridge("home-control");
    try {
      await vi.advanceTimersByTimeAsync(50);
      const pending = control(browser(server.cookie()));
      for (let i = 0; i < 100 && !bridge.events().some((one) => one.event === "home-control"); i++) await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(CONTROL_WAIT_MS);
      const response = await pending;
      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({ error: "timeout" });
    } finally {
      vi.useRealTimers();
      bridge.abort();
    }
  });
});
