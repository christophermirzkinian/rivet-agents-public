import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PushService, type PushPayload, type PushSender } from "../src/server/push.js";
import { DIGEST_RETRY_MS, QuietStore } from "../src/server/quiet.js";
import { Store } from "../src/server/store.js";
import { DEFAULT_QUIET } from "../src/shared/quiet.js";
import { bearer, BOARD_TOKEN, startServer } from "./helpers.js";

const phone = (n = 1) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/retry-${n}`, keys: { p256dh: "key", auth: "auth" } });
const payload: PushPayload = { title: "Needs you", body: "Check this", tag: "retry-card", path: "/?card=retry", level: "needs-you" };

describe("failed immediate pushes", () => {
  let dir: string;
  let store: Store;
  let gate: QuietStore;
  let push: PushService;
  let now: Date;
  let answer: (endpoint: string) => number;
  let attempts: PushPayload[];
  let sender: PushSender;
  const service = () => new PushService(store, null, { error: () => {} }, sender, gate, () => now);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rivet-push-retry-"));
    store = new Store(dir);
    gate = new QuietStore(dir);
    gate.putSettings({ ...DEFAULT_QUIET, enabled: false });
    store.addPushSubscription(phone());
    now = new Date("2026-10-08T02:00:00Z");
    attempts = [];
    answer = () => 503;
    sender = { async send(target, body) { attempts.push(JSON.parse(body)); return answer(target.endpoint); } };
    push = service();
  });
  afterEach(() => { gate.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

  it.each(["status", "throw"])("persists a failed %s, backs off and delivers once after restart", async (failure) => {
    if (failure === "throw") answer = () => { throw new Error("offline"); };
    expect(await push.notify(payload, "card", "rivet:message")).toEqual({ sent: 0, removed: 0 });
    expect(gate.heldCount()).toBe(1);
    gate.close();
    gate = new QuietStore(dir);
    push = service();
    expect(await push.notify(payload, "card", "rivet:message")).toMatchObject({ skipped: "duplicate" });
    expect(attempts).toHaveLength(1);
    expect(await push.flushHeld()).toMatchObject({ sent: 0 });
    answer = () => 201;
    expect(await push.flushHeld()).toBeNull();
    now = new Date(now.getTime() + DIGEST_RETRY_MS);
    expect(await push.flushHeld()).toMatchObject({ sent: 1 });
    expect(attempts.at(-1)).toMatchObject(payload);
    expect(gate.heldCount()).toBe(0);
    expect(await push.flushHeld()).toBeNull();
  });

  it("flushes a failed card before a later card", async () => {
    await push.notify(payload, "card");
    answer = () => 201;
    await push.notify({ ...payload, tag: "next" }, "card");
    expect(attempts.map((p) => p.tag)).toEqual(["retry-card", "retry-card", "next"]);
    expect(gate.heldCount()).toBe(0);
  });

  it("never replays an old held notification over a successful newer notification with the same tag", async () => {
    await push.notify(payload, "card", "rivet:old");
    let calls = 0;
    answer = () => ++calls === 1 ? 503 : 201;
    const newer = { ...payload, body: "New update", path: "/?card=new" };
    expect(await push.notify(newer, "card", "rivet:new")).toMatchObject({ sent: 1 });
    expect(attempts).toHaveLength(3);
    expect(attempts.at(-1)).toMatchObject(newer);
    now = new Date(now.getTime() + DIGEST_RETRY_MS);
    expect(await push.flushHeld()).toBeNull();
    expect(gate.heldCount()).toBe(0);
    expect(await push.notify(payload, "card", "rivet:old")).toMatchObject({ skipped: "duplicate" });
  });

  it.each(["needs-you", "fyi"] as const)("retains a failed %s when the same conversation sends the other notification level", async (level) => {
    const older = { ...payload, level };
    await push.notify(older, "card", "rivet:old");
    let calls = 0;
    answer = () => ++calls === 1 ? 503 : 201;
    const otherLevel = level === "needs-you" ? "fyi" : "needs-you";
    await push.notify({ ...payload, body: "New update", level: otherLevel }, "card", "rivet:new");
    expect(gate.heldCount()).toBe(1);
    now = new Date(now.getTime() + DIGEST_RETRY_MS);
    expect(await push.flushHeld()).toMatchObject({ sent: 1 });
    expect(attempts.at(-1)).toMatchObject(older);
    expect(gate.heldCount()).toBe(0);
  });

  it.each([404, 410, 201])("does not queue terminal or successful status %s", async (status) => {
    answer = () => status;
    await push.notify(payload, "card");
    expect(gate.heldCount()).toBe(0);
  });

  it("keeps a transient failure when another phone was removed, but does not replay partial success", async () => {
    store.addPushSubscription(phone(2));
    answer = (endpoint) => endpoint === phone().endpoint ? 410 : 503;
    expect(await push.notify(payload, "card")).toEqual({ sent: 0, removed: 1 });
    expect(gate.heldCount()).toBe(1);
    answer = () => 201;
    await push.flushHeld();
    store.addPushSubscription(phone());
    answer = (endpoint) => endpoint === phone().endpoint ? 503 : 201;
    expect(await push.notify(payload, "card")).toEqual({ sent: 1, removed: 0 });
    expect(gate.heldCount()).toBe(0);
  });

  it("does not queue unconfigured or unsubscribed sends or tests", async () => {
    await push.sendTest();
    const off = new PushService(store, null, { error: () => {} }, undefined, gate);
    expect(await off.notify(payload, "card")).toMatchObject({ skipped: "unconfigured" });
    push.unsubscribe(phone().endpoint);
    expect(await push.notify(payload, "card")).toMatchObject({ skipped: "no-subscriptions" });
    expect(gate.heldCount()).toBe(0);
  });
});

it("retries the failed say route notification after its 201 response", async () => {
  let status = 503;
  const attempts: PushPayload[] = [];
  const server = await startServer({}, {
    pushSender: { async send(_target, body) { attempts.push(JSON.parse(body)); return status; } },
  });
  try {
    server.app.push.subscribe(phone());
    const response = await fetch(`${server.base}/api/bridge/say`, {
      method: "POST", headers: bearer(BOARD_TOKEN),
      body: JSON.stringify({ text: "Please check the job", new: true, title: "Retry check" }),
    });
    expect(response.status).toBe(201);
    await expect.poll(() => server.app.quiet.heldCount()).toBe(1);
    expect(attempts).toHaveLength(1);
    status = 201;
    expect(await server.app.push.flushHeld()).toMatchObject({ sent: 1 });
    expect(attempts[1]).toEqual(attempts[0]);
    expect(server.app.quiet.heldCount()).toBe(0);
  } finally { await server.close(); }
});
