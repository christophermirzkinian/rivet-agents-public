import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, browser, putBoard, REPLY_BOARD, revOf, startServer, type TestServer } from "./helpers.js";

let server: TestServer;
let cookie: string;

beforeEach(async () => {
  server = await startServer();
  cookie = server.cookie();
  await putBoard(server.base, REPLY_BOARD);
});

afterEach(async () => {
  await server.close();
});

interface Stream {
  events(): { event: string; id: string; data: Record<string, unknown> }[];
  waitFor(count: number): Promise<void>;
  closed: Promise<void>;
  abort(): void;
}

async function connect(features = ""): Promise<Stream> {
  const controller = new AbortController();
  const response = await fetch(`${server.base}/api/bridge/events`, { headers: { ...bearer(BRIDGE_TOKEN), ...(features ? { "x-rivet-bridge-features": features } : {}) }, signal: controller.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
  let buffer = "";
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const closed = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
      }
    } catch {
      // aborted
    }
  })();
  const events = () =>
    buffer
      .split("\n\n")
      .filter((block) => block.startsWith("event:"))
      .map((block) => {
        const fields = Object.fromEntries(block.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]));
        return { event: fields.event!, id: fields.id!, data: JSON.parse(fields.data!) as Record<string, unknown> };
      });
  const waitFor = async (count: number) => {
    for (let i = 0; i < 200 && events().length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events().length).toBeGreaterThanOrEqual(count);
  };
  return { events, waitFor, closed, abort: () => controller.abort() };
}

/** Gives the card a new revision, so another answer is not refused as a second one to the same revision. */
function revise(itemId: string, tag: string): void {
  const board = structuredClone(server.app.store.getBoard()!.board);
  const need = board.needs.find((item) => item.id === itemId)!;
  need.ask = `${need.ask ?? need.title} (${tag})`;
  server.app.store.putBoard(board, null);
}

async function reply(clientId: string, decision = "approve"): Promise<{ id: string }> {
  revise("pr105-touch", clientId);
  const response = await fetch(`${server.base}/api/replies`, {
    method: "POST",
    headers: browser(cookie),
    body: JSON.stringify({ clientId, itemId: "pr105-touch", decision, ...(decision === "reject" ? { text: "Fix the touch target" } : {}), rev: await revOf(server.base, cookie, "pr105-touch") }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

const ack = (body: unknown) =>
  fetch(`${server.base}/api/bridge/ack`, { method: "POST", headers: bearer(BRIDGE_TOKEN), body: JSON.stringify(body) });

describe("bridge SSE", () => {
  it("requires the bridge token", async () => {
    expect((await fetch(`${server.base}/api/bridge/events`, { headers: bearer(BOARD_TOKEN) })).status).toBe(401);
    expect((await ack({ id: "x" })).status).toBe(404);
    expect((await fetch(`${server.base}/api/bridge/ack`, { method: "POST", headers: bearer(BOARD_TOKEN), body: "{}" })).status).toBe(401);
  });

  it("replays undelivered replies oldest first, then streams new ones", async () => {
    const first = await reply("client-1001");
    const second = await reply("client-1002", "reject");

    const stream = await connect();
    await stream.waitFor(2);
    expect(stream.events().map((e) => [e.event, e.id])).toEqual([
      ["reply", first.id],
      ["reply", second.id],
    ]);
    expect(stream.events()[0]!.data).toMatchObject({ id: first.id, decision: "approve", item: { chat: "touch-guard" } });

    const status = (await (await fetch(`${server.base}/api/status`, { headers: { cookie } })).json()) as {
      bridge: { connected: boolean; lastSeenAt: string };
    };
    expect(status.bridge.connected).toBe(true);
    expect(status.bridge.lastSeenAt).toBeTruthy();

    const third = await reply("client-1003", "reject");
    await stream.waitFor(3);
    expect(stream.events()[2]!.id).toBe(third.id);
    stream.abort();
  });

  it("holds complete option details through an older bridge and replays them after upgrade", async () => {
    expect((await putBoard(server.base, {
      ...REPLY_BOARD,
      needs: [...REPLY_BOARD.needs, { id: "detail-card", kind: "decision", title: "Deploy", options: [{ label: "Proceed", detail: "Deploy to staging only" }] }],
    })).status).toBe(200);
    const choose = async (clientId: string) => {
      revise("detail-card", clientId);
      const response = await fetch(`${server.base}/api/replies`, {
        method: "POST", headers: browser(cookie),
        body: JSON.stringify({ clientId, itemId: "detail-card", decision: "choice", choice: "Proceed", rev: await revOf(server.base, cookie, "detail-card") }),
      });
      expect(response.status).toBe(201);
      return await response.json() as { id: string };
    };
    const pending = await choose("detail-before");
    const old = await connect("image,chat-window,long-chat,images,files,reply-images,card-merge,dismiss");
    const live = await choose("detail-during");
    const plain = await reply("plain-during");
    await old.waitFor(1);
    expect(old.events().map((event) => event.id)).toEqual([plain.id]);
    expect((await ack({ id: plain.id, delivery: { target: "chat", chat: "touch-guard", at: new Date().toISOString() } })).status).toBe(200);
    old.abort();
    await old.closed;
    const fresh = await connect("choice-detail");
    await fresh.waitFor(2);
    expect(fresh.events().map((event) => event.id)).toEqual([pending.id, live.id]);
    const third = await choose("detail-after");
    await fresh.waitFor(3);
    expect(fresh.events()[2]!.id).toBe(third.id);
    for (const event of fresh.events()) expect(event.data).toMatchObject({ item: { choiceDetail: "Deploy to staging only" }, handled: false });
    fresh.abort();
  });

  it("an ack with delivery marks the reply handled and it is not replayed", async () => {
    const created = await reply("client-2001");
    const other = await reply("client-2002", "reject");

    const delivered = await ack({
      id: created.id,
      delivery: { target: "chat", chat: "touch-guard", at: new Date().toISOString() },
      github: { url: "https://github.com/example-org/example-repo/pull/2022#issuecomment-1" },
    });
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toMatchObject({
      id: created.id,
      handled: true,
      delivery: { target: "chat" },
      github: { url: expect.stringContaining("issuecomment") },
    });
    expect((await ack({ id: created.id, delivery: { target: "rivet", at: new Date().toISOString() } })).status).toBe(200);
    const again = (await (await ack({ id: created.id })).json()) as { delivery: { target: string } };
    expect(again.delivery.target).toBe("chat");

    const failed = await ack({ id: other.id, github: { error: "gh timed out" }, error: "no terminal" });
    expect(await failed.json()).toMatchObject({ handled: false, github: { error: "gh timed out" }, error: "no terminal" });

    const stream = await connect();
    await stream.waitFor(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stream.events().map((e) => e.id)).toEqual([other.id]);
    stream.abort();

    const unhandled = (await (await fetch(`${server.base}/api/replies?handled=false`, { headers: bearer(BOARD_TOKEN) })).json()) as {
      replies: { id: string }[];
    };
    expect(unhandled.replies.map((r) => r.id)).toEqual([other.id]);
  });

  it("a new connection closes the previous one", async () => {
    const first = await connect();
    const second = await connect();
    await first.closed;
    await reply("client-3001");
    await second.waitFor(1);
    expect(first.events()).toEqual([]);
    second.abort();
    await second.closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const status = (await (await fetch(`${server.base}/api/status`, { headers: { cookie } })).json()) as { bridge: { connected: boolean } };
    // Still shown as connected: a dropped bridge has OFFLINE_GRACE_MS to come back (bridge-status.test.ts).
    expect(status.bridge.connected).toBe(true);
  });

  it("stores confirmed and stages, and a confirmed delivery replaces an unconfirmed one", async () => {
    const created = await reply("client-4001");
    const at = new Date().toISOString();
    const first = await ack({ id: created.id, delivery: { target: "chat", chat: "touch-guard", at, confirmed: false, stages: ["github", "terminal-send"] } });
    expect(await first.json()).toMatchObject({ handled: true, delivery: { confirmed: false, stages: ["github", "terminal-send"] } });

    const confirmed = await ack({ id: created.id, delivery: { target: "chat", chat: "touch-guard", at, confirmed: true, stages: ["github", "terminal-send", "echo-seen"] } });
    expect(await confirmed.json()).toMatchObject({ delivery: { confirmed: true, stages: ["github", "terminal-send", "echo-seen"] } });

    const later = await ack({ id: created.id, delivery: { target: "rivet", at, confirmed: false } });
    expect(await later.json()).toMatchObject({ delivery: { target: "chat", confirmed: true } });

    const record = await fetch(`${server.base}/api/replies/${created.id}`, { headers: bearer(BOARD_TOKEN) });
    expect(await record.json()).toMatchObject({ delivery: { confirmed: true } });
  });

  it("every reply the server streams passes the bridge's own validator", async () => {
    const bridgePath = "../bridge/lib/validate.mjs";
    const { validateReply } = (await import(bridgePath)) as { validateReply: (raw: unknown) => { ok: boolean; reason?: string } };
    const board = structuredClone(REPLY_BOARD) as typeof REPLY_BOARD;
    Object.assign(board.needs[1]!, { repo: "example-org/other-repo", issue: 12, chat: "..x" });
    await putBoard(server.base, board);
    const billing = await revOf(server.base, cookie, "billing-retry");
    await fetch(`${server.base}/api/replies`, {
      method: "POST",
      headers: browser(cookie),
      body: JSON.stringify({ clientId: "client-5001", itemId: "billing-retry", decision: "choice", choice: "Ship it", confirm: true, text: "x".repeat(4000), rev: billing }),
    });
    await reply("client-5002", "reject");
    const stream = await connect();
    await stream.waitFor(2);
    stream.abort();
    for (const event of stream.events()) expect(validateReply(event.data)).toMatchObject({ ok: true });
    const repos = stream.events().map((event) => (event.data as { item: { id: string; repo?: string } }).item);
    expect(repos.find((item) => item.id === "billing-retry")?.repo).toBe("example-org/other-repo");
    expect(repos.find((item) => item.id !== "billing-retry")?.repo).toBeUndefined();
  });

  it("rejects an ack whose delivery fields are malformed", async () => {
    const created = await reply("client-6001");
    const at = new Date().toISOString();
    expect((await ack({ id: created.id, delivery: { target: "chat", at, confirmed: "yes" } })).status).toBe(400);
    expect((await ack({ id: created.id, delivery: { target: "chat", at, stages: "github" } })).status).toBe(400);
  });

  it("rejects a malformed ack", async () => {
    expect((await ack({ id: "../x" })).status).toBe(400);
    expect((await ack({ id: "abc", delivery: { target: "shell", at: "now" } })).status).toBe(400);
    expect((await ack({ id: "abc", github: { url: "javascript:alert(1)" } })).status).toBe(400);
  });
});

