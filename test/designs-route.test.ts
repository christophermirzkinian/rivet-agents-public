import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Ask } from "../src/shared/asks.js";
import { DEFAULT_DESIGNS, designsJob, designsLine, THREE_DESIGNS_ID } from "../src/shared/designs.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, browser, startServer, type TestServer } from "./helpers.js";

// POST /api/designs: one ask per card or screen and one line in the owner's name to the monitor, as Start work makes.

describe("3 designs route", () => {
  let server: TestServer;
  let bridges: AbortController[];
  beforeEach(async () => {
    bridges = [];
    server = await startServer();
  });
  afterEach(async () => {
    for (const one of bridges) one.abort();
    await server.close();
  });

  const app = () => browser(server.cookie());
  const post = (body: Record<string, unknown>, headers: Record<string, string> = app()) => fetch(`${server.base}/api/designs`, { method: "POST", headers, body: JSON.stringify(body) });
  const setRow = (value: unknown) => fetch(`${server.base}/api/behaviours/${THREE_DESIGNS_ID}`, { method: "PUT", headers: app(), body: JSON.stringify(value) });
  const addCard = (id: string) =>
    fetch(`${server.base}/api/board/needs/${id}`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ kind: "decision", title: "Pick a look", options: [{ label: "Calm" }, { label: "Bold" }] }) });
  const getAsk = async (id: string) => (await (await fetch(`${server.base}/api/asks/${id}`, { headers: bearer(BOARD_TOKEN) })).json()) as Ask;

  /** The bridge's event stream: the chat lines it has read so far. */
  async function openBridge(): Promise<() => Record<string, unknown>[]> {
    const controller = new AbortController();
    bridges.push(controller);
    const response = await fetch(`${server.base}/api/bridge/events`, { headers: bearer(BRIDGE_TOKEN), signal: controller.signal });
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
    return () =>
      buffer
        .split("\n\n")
        .filter((block) => block.startsWith("event: chat\n"))
        .map((block) => JSON.parse(block.slice(block.indexOf("data: ") + 6)) as Record<string, unknown>);
  }
  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 300 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(check()).toBe(true);
  }

  it("is for a signed-in app on its own origin, with a checked body, while the row is on, for a card on the board", async () => {
    const body = { clientId: "client-0001", card: "pick" };
    expect((await post(body, { "content-type": "application/json" })).status).toBe(401);
    expect((await post(body, { ...app(), origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ ...body, screen: "settings" })).status).toBe(400);
    expect((await post({ clientId: "client-0001" })).status).toBe(400);
    expect((await post(body)).status).toBe(404);
    expect((await setRow({ on: false, model: "app-look" })).status).toBe(200);
    const off = await post({ clientId: "client-0002", screen: "settings" });
    expect(off.status).toBe(409);
    expect(await off.json()).toMatchObject({ error: "3 designs is off in Settings › Behaviours" });
  });

  it("opens one ask for a card and sends the monitor its line once; a retry and a second tap get the same ask", async () => {
    const lines = await openBridge();
    expect((await addCard("pick")).status).toBeLessThan(300);
    const made = await post({ clientId: "client-0001", card: "pick" });
    expect(made.status).toBe(201);
    const first = (await made.json()) as { ask: string; already: boolean };
    expect(first.already).toBe(false);
    expect(await getAsk(first.ask)).toMatchObject({ who: "owner", stage: "queued", words: "3 designs for card pick", source: "designs:card:pick" });

    const line = designsLine(designsJob({ clientId: "client-0001", card: "pick" }, DEFAULT_DESIGNS, null, first.ask)!);
    await until(() => lines().length === 1);
    expect(JSON.stringify(lines()[0])).toContain(JSON.stringify(line).slice(1, -1));

    const retry = await post({ clientId: "client-0001", card: "pick" });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ ask: first.ask });
    const again = await post({ clientId: "client-0002", card: "pick" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ask: first.ask, already: true });
    // A clientId already used for another source is refused.
    expect((await post({ clientId: "client-0001", screen: "chat" })).status).toBe(409);
    // The retry sends the queued line again under its own id, which the bridge types once.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(new Set(lines().map((one) => one.id)).size).toBe(1);
  });

  it("names the row's own model when one is set there", async () => {
    const lines = await openBridge();
    expect((await setRow({ on: true, model: "claude-fable-5-2" })).status).toBe(200);
    const made = await post({ clientId: "client-0003", screen: "settings" });
    expect(made.status).toBe(201);
    const { ask } = (await made.json()) as { ask: string };
    expect(await getAsk(ask)).toMatchObject({ words: "3 designs for the Settings screen", source: "designs:screen:settings" });
    await until(() => lines().length === 1);
    const text = JSON.stringify(lines()[0]);
    expect(text).toContain("Fable 5.2, high effort (set in Settings › Behaviours › 3 designs)");
    expect(text).not.toContain("--reply-to");
  });
});
