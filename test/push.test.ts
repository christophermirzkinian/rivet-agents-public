import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Need } from "../src/shared/board.js";
import {
  boardPayloads,
  summaryKeys,
  summaryPushKey,
  CATEGORY_LEVELS,
  cardPayload,
  rivetPayload,
  isPushEndpoint,
  MAX_PUSHES_PER_BOARD,
  needLevel,
  newNeeds,
  PushService,
  type PushOptions,
  type PushSender,
} from "../src/server/push.js";
import { needSchema } from "../src/shared/board.js";
import { MAX_PUSH_SUBSCRIPTIONS, Store, type PushSubscriptionRow } from "../src/server/store.js";
import { bearer, BOARD_TOKEN, browser, EXAMPLE_BOARD, putBoard, startServer, type TestServer } from "./helpers.js";

const VAPID = {
  RIVET_VAPID_PUBLIC_KEY: "BPublicKeyForTests",
  RIVET_VAPID_PRIVATE_KEY: "private-key-for-tests",
  RIVET_VAPID_SUBJECT: "mailto:ops@example.com",
};

function subscription(n: number, host = "fcm.googleapis.com"): PushSubscriptionRow {
  return { endpoint: `https://${host}/fcm/send/device-${n}`, keys: { p256dh: `BKey${n}`, auth: `auth${n}` } };
}

class FakeSender implements PushSender {
  readonly sent: { endpoint: string; payload: Record<string, string>; options: PushOptions }[] = [];
  readonly status = new Map<string, number>();
  async send(target: PushSubscriptionRow, payload: string, options: PushOptions): Promise<number> {
    this.sent.push({ endpoint: target.endpoint, payload: JSON.parse(payload) as Record<string, string>, options });
    return this.status.get(target.endpoint) ?? 201;
  }
}

const need = (id: string, extra: Partial<Need> = {}): Need => ({ id, kind: "approval", title: `Card ${id}`, ...extra });

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("new-need detection", () => {
  it("finds ids that were not on the previous board, in board order", () => {
    expect(newNeeds(null, [need("a"), need("b")]).map((n) => n.id)).toEqual(["a", "b"]);
    expect(newNeeds([need("a")], [need("c"), need("a", { title: "edited" }), need("b")]).map((n) => n.id)).toEqual(["c", "b"]);
    expect(newNeeds([need("a"), need("b")], [need("b")])).toEqual([]);
  });

  it("builds one payload per card with the title and a short ask, opening that card", () => {
    const payload = cardPayload(need("pr2022-checkout", { title: "Daily build", ask: `Watch it. ${"x".repeat(400)}`, risk: "money" }));
    expect(payload.title).toBe("Daily build");
    expect(payload.body.startsWith("Money change. Watch it.")).toBe(true);
    expect(payload.body.length).toBeLessThanOrEqual(140);
    expect(payload.tag).toBe("need-pr2022-checkout");
    expect(payload.path).toBe("/?card=pr2022-checkout");
    expect(cardPayload(need("q")).body).toMatch(/Rivet/);
    expect(cardPayload(need("t", { title: "T".repeat(300) })).title.length).toBeLessThanOrEqual(80);
  });

  it("caps a burst and sums up the rest", () => {
    const burst = Array.from({ length: 12 }, (_, i) => need(`n${i}`));
    const payloads = boardPayloads(burst);
    expect(payloads).toHaveLength(MAX_PUSHES_PER_BOARD);
    expect(payloads.slice(0, -1).map((p) => p.tag)).toEqual(["need-n0", "need-n1", "need-n2", "need-n3"]);
    expect(payloads.at(-1)).toMatchObject({ title: "8 more cards", path: "/" });
    expect(boardPayloads(burst.slice(0, MAX_PUSHES_PER_BOARD))).toHaveLength(MAX_PUSHES_PER_BOARD);
  });
});

describe("push levels", () => {
  it("takes a card's level from its kind, needs-you for a kind not listed", () => {
    for (const kind of ["approval", "decision", "question", "todo", "risk"]) expect(needLevel(need("a", { kind }))).toBe("needs-you");
    for (const kind of ["merged", "shipped", "briefing", "info"]) expect(needLevel(need("a", { kind }))).toBe("fyi");
    for (const kind of ["something-new", "constructor", "__proto__", "toString"]) expect(needLevel(need("a", { kind }))).toBe("needs-you");
  });

  it("lets an explicit push field win, and a risk tag keeps an FYI kind loud", () => {
    expect(needLevel(need("a", { kind: "approval", push: "fyi" }))).toBe("fyi");
    expect(needLevel(need("a", { kind: "merged", push: "needs-you" }))).toBe("needs-you");
    expect(needLevel(need("a", { kind: "merged", risk: "money" }))).toBe("needs-you");
    expect(needSchema.safeParse(need("a", { push: "fyi" })).success).toBe(true);
    expect(needSchema.safeParse({ ...need("a"), push: "loud" }).success).toBe(false);
  });

  it("gives each category a level, and every payload names what it is about", () => {
    expect(CATEGORY_LEVELS).toEqual({ card: "needs-you", "app-down": "needs-you", "deploy-failed": "needs-you", briefing: "fyi", test: "needs-you" });
    expect(cardPayload(need("c1", { kind: "merged" }))).toMatchObject({ level: "fyi", card: "c1" });
    expect(rivetPayload("Hi")).toMatchObject({ chat: "rivet" });
    const burst = (kind: string) => boardPayloads(Array.from({ length: 8 }, (_, i) => need(`n${i}`, { kind: i < 4 ? "approval" : kind }))).at(-1);
    expect(burst("merged")?.level).toBe("fyi");
    expect(burst("question")?.level).toBe("needs-you");
  });

  it("a new card whose keyed push was already held or sent skips only itself; the cards after it still push", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rivet-push-"));
    const store = new Store(dir);
    try {
      store.addPushSubscription(subscription(1));
      const sender = new FakeSender();
      const gate = { hasKey: (key: string) => key === "card:old", lastHeldId: () => 0, holds: () => false, releasable: () => null, supersede: () => [] };
      const service = new PushService(store, null, { error: () => {} }, sender, gate as never);
      await service.notifyNewNeeds([need("old"), need("new")], (one) => (one.id === "old" ? "card:old" : undefined));
      expect(sender.sent.map((s) => s.payload.tag)).toEqual(["need-new"]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds a \"more cards\" summary under the keys of the cards it counts, and unkeyed when any has none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rivet-push-"));
    const store = new Store(dir);
    try {
      store.addPushSubscription(subscription(1));
      const held: (string | undefined)[] = [];
      const gate = { hasKey: () => false, lastHeldId: () => 0, holds: () => true, hold: (_payload: unknown, _now: Date, key?: string) => (held.push(key), []) };
      const service = new PushService(store, null, { error: () => {} }, new FakeSender(), gate as never);
      const burst = Array.from({ length: 7 }, (_, i) => need(`n${i}`));
      await service.notifyNewNeeds(burst, (one) => `key-${one.id}`);
      expect(held.slice(0, 4)).toEqual(["key-n0", "key-n1", "key-n2", "key-n3"]);
      expect(held[4]).toBe(summaryPushKey(["key-n4", "key-n5", "key-n6"]));
      expect(summaryKeys(held[4]!)).toEqual(["key-n4", "key-n5", "key-n6"]);
      held.length = 0;
      await service.notifyNewNeeds(burst, (one) => (one.id === "n5" ? undefined : `key-${one.id}`));
      expect(held[4], "a card it counts has no key: nothing to check it by").toBeUndefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends needs-you at high urgency and an FYI silent at low urgency with a shorter TTL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rivet-push-"));
    const store = new Store(dir);
    try {
      store.addPushSubscription(subscription(1));
      const sender = new FakeSender();
      const service = new PushService(store, null, { error: () => {} }, sender);
      await service.notifyNewNeeds([need("loud"), need("quiet", { kind: "shipped" })]);
      expect(sender.sent.map((s) => [s.payload.tag, s.payload.level, s.payload.silent, s.options.urgency])).toEqual([
        ["need-loud", "needs-you", false, "high"],
        ["need-quiet", "fyi", true, "low"],
      ]);
      expect(sender.sent[1]!.options.TTL).toBeLessThan(sender.sent[0]!.options.TTL);
      expect(sender.sent[1]!.payload.card).toBe("quiet");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("push endpoint allowlist", () => {
  it("allows push services only", () => {
    expect(isPushEndpoint("https://fcm.googleapis.com/fcm/send/x")).toBe(true);
    expect(isPushEndpoint("https://web.push.apple.com/QK")).toBe(true);
    expect(isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isPushEndpoint("http://fcm.googleapis.com/fcm/send/x")).toBe(false);
    expect(isPushEndpoint("https://fcm.googleapis.com@169.254.169.254/")).toBe(false);
    expect(isPushEndpoint("https://user:pw@fcm.googleapis.com/x")).toBe(false);
    expect(isPushEndpoint("https://evilfcm.googleapis.com.example/x")).toBe(false);
    expect(isPushEndpoint("https://169.254.169.254/latest")).toBe(false);
    expect(isPushEndpoint("not a url")).toBe(false);
  });
});

describe("push storage", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rivet-push-"));
    store = new Store(dir);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("upserts, lists, removes, and keeps only the newest subscriptions", () => {
    store.addPushSubscription(subscription(1));
    store.addPushSubscription({ ...subscription(1), keys: { p256dh: "BNew", auth: "new" } });
    expect(store.listPushSubscriptions()).toEqual([{ ...subscription(1), keys: { p256dh: "BNew", auth: "new" } }]);
    expect(store.removePushSubscription(subscription(1).endpoint, "turned-off")).toMatchObject({ reason: "turned-off", status: null, remaining: 0 });
    expect(store.removePushSubscription(subscription(1).endpoint, "turned-off")).toBeNull();
    for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS + 3; i += 1) store.addPushSubscription(subscription(i));
    const kept = store.listPushSubscriptions().map((s) => s.endpoint);
    expect(kept).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);
    expect(kept).not.toContain(subscription(0).endpoint);
    expect(kept).toContain(subscription(MAX_PUSH_SUBSCRIPTIONS + 2).endpoint);
  });

  it("records every removal with its reason, status and host, never the endpoint's path, newest first", () => {
    const at = new Date("2026-09-30T01:29:01.000Z");
    store.addPushSubscription(subscription(1), at);
    store.addPushSubscription(subscription(2, "web.push.apple.com"), at);
    expect(store.countPushSubscriptions()).toBe(2);
    expect(store.removePushSubscription(subscription(2, "web.push.apple.com").endpoint, "turned-off", null, at)).toEqual({
      at: at.toISOString(),
      reason: "turned-off",
      status: null,
      host: "web.push.apple.com",
      remaining: 1,
    });
    store.removePushSubscription(subscription(1).endpoint, "gone", 410, at);
    expect(store.countPushSubscriptions()).toBe(0);
    expect(store.listPushRemovals().map((r) => [r.reason, r.status, r.host, r.remaining])).toEqual([
      ["gone", 410, "fcm.googleapis.com", 0],
      ["turned-off", null, "web.push.apple.com", 1],
    ]);
    expect(JSON.stringify(store.listPushRemovals())).not.toContain("device-");
  });

  it("keeps a phone whose removal record cannot be written", () => {
    store.addPushSubscription(subscription(1));
    const raw = (store as unknown as { db: { exec(sql: string): void } }).db;
    raw.exec("CREATE TRIGGER no_removals BEFORE INSERT ON push_removals BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    expect(() => store.removePushSubscription(subscription(1).endpoint, "gone", 410)).toThrow(/disk full/);
    expect(store.listPushSubscriptions()).toEqual([subscription(1)]);
    for (let i = 2; i <= MAX_PUSH_SUBSCRIPTIONS; i += 1) store.addPushSubscription(subscription(i), new Date(1_000 + i));
    expect(() => store.addPushSubscription(subscription(99), new Date(5_000))).toThrow(/disk full/);
    expect(store.countPushSubscriptions()).toBe(MAX_PUSH_SUBSCRIPTIONS);
  });

  it("records each subscription the cap pushes out", () => {
    for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS; i += 1) expect(store.addPushSubscription(subscription(i), new Date(1_000 + i))).toEqual([]);
    const pruned = store.addPushSubscription(subscription(99), new Date(5_000));
    expect(pruned).toEqual([{ at: new Date(5_000).toISOString(), reason: "cap", status: null, host: "fcm.googleapis.com", remaining: MAX_PUSH_SUBSCRIPTIONS }]);
    expect(store.listPushSubscriptions().map((s) => s.endpoint)).not.toContain(subscription(0).endpoint);
  });

  it("logs a phone the push service drops, and loudly when it was the last one, without the endpoint", async () => {
    const errors: string[] = [];
    const sender = new FakeSender();
    const service = new PushService(store, null, { error: (message: string) => errors.push(message) }, sender);
    store.addPushSubscription(subscription(1));
    store.addPushSubscription(subscription(2));
    sender.status.set(subscription(1).endpoint, 404);
    sender.status.set(subscription(2).endpoint, 410);
    expect(await service.sendTest()).toEqual({ sent: 0, removed: 2 });
    expect(errors).toEqual([
      "[push] removed a phone (fcm.googleapis.com answered 404); 1 left",
      "[push] removed a phone (fcm.googleapis.com answered 410); 0 left",
      "[push] ALERT notifications are off on every phone",
    ]);
    expect(service.health()).toMatchObject({ subscriptions: 0, lastRemoval: { reason: "gone", status: 410, remaining: 0 } });
  });

  it("survives a reopen", () => {
    store.addPushSubscription(subscription(1));
    store.close();
    store = new Store(dir);
    expect(store.listPushSubscriptions()).toEqual([subscription(1)]);
  });

  it("the service skips when unconfigured, prunes gone subscriptions and never sends off the allowlist", async () => {
    const off = new PushService(store, null, { error: () => {} });
    expect(off.configured).toBe(false);
    expect(await off.sendTest()).toEqual({ sent: 0, removed: 0, skipped: "unconfigured" });

    const sender = new FakeSender();
    const on = new PushService(store, null, { error: () => {} }, sender);
    expect(await on.sendTest()).toEqual({ sent: 0, removed: 0, skipped: "no-subscriptions" });
    store.addPushSubscription(subscription(1));
    store.addPushSubscription(subscription(2));
    store.addPushSubscription(subscription(3));
    store.addPushSubscription(subscription(4, "169.254.169.254"));
    sender.status.set(subscription(2).endpoint, 410);
    sender.status.set(subscription(3).endpoint, 500);
    expect(await on.sendTest()).toEqual({ sent: 1, removed: 1 });
    expect(sender.sent.map((s) => s.endpoint)).not.toContain(subscription(4, "169.254.169.254").endpoint);
    expect(store.listPushSubscriptions().map((s) => s.endpoint)).toEqual([
      subscription(1).endpoint,
      subscription(3).endpoint,
      subscription(4, "169.254.169.254").endpoint,
    ]);
  });

  it("an invalid VAPID key turns push off instead of failing the boot, without logging the key", () => {
    const errors: string[] = [];
    const service = new PushService(store, { publicKey: "short", privateKey: "secretish", subject: "mailto:ops@example.com" }, {
      error: (message: string) => errors.push(message),
    });
    expect(service.configured).toBe(false);
    expect(service.publicKey).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors.join()).not.toContain("secretish");
  });
});

describe("push routes", () => {
  let server: TestServer;
  let sender: FakeSender;
  let cookie: string;
  let logs: string[];

  beforeEach(async () => {
    sender = new FakeSender();
    logs = [];
    server = await startServer(VAPID, { pushSender: sender, logs });
    cookie = server.cookie();
  });
  afterEach(async () => server.close());

  const post = (path: string, body: unknown, headers = browser(cookie)) =>
    fetch(`${server.base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

  it("serves the public key to a session only", async () => {
    expect((await fetch(`${server.base}/api/push/config`)).status).toBe(401);
    const config = await fetch(`${server.base}/api/push/config`, { headers: { cookie } });
    expect(await config.json()).toEqual({ configured: true, publicKey: VAPID.RIVET_VAPID_PUBLIC_KEY, subscriptions: 0, lastRemoval: null });
  });

  it("subscribes and unsubscribes with a session and the same-origin headers", async () => {
    const sub = subscription(1);
    expect((await post("/api/push/subscribe", sub, { cookie, "content-type": "application/json" })).status).toBe(403);
    expect((await post("/api/push/subscribe", sub, { ...browser(""), cookie: "" })).status).toBe(401);
    expect((await post("/api/push/subscribe", sub, bearer(BOARD_TOKEN))).status).toBe(403);
    expect((await post("/api/push/subscribe", subscription(1, "169.254.169.254"))).status).toBe(400);
    expect((await post("/api/push/subscribe", { ...sub, keys: { p256dh: "a b", auth: "x" } })).status).toBe(400);
    expect(server.app.store.listPushSubscriptions()).toEqual([]);

    expect((await post("/api/push/subscribe", sub)).status).toBe(200);
    expect(server.app.store.listPushSubscriptions()).toEqual([sub]);
    expect((await post("/api/push/unsubscribe", { endpoint: sub.endpoint }, { cookie, "content-type": "application/json" })).status).toBe(403);
    const config = async () => (await fetch(`${server.base}/api/push/config`, { headers: { cookie } })).json();
    expect(await config()).toMatchObject({ subscriptions: 1, lastRemoval: null });
    expect(await (await post("/api/push/unsubscribe", { endpoint: sub.endpoint })).json()).toEqual({ removed: true });
    expect(server.app.store.listPushSubscriptions()).toEqual([]);
    expect(await config()).toMatchObject({ subscriptions: 0, lastRemoval: { reason: "turned-off", host: "fcm.googleapis.com", remaining: 0 } });
    // A phone that cannot sign up says nothing else, so the server logs each refusal and each sign-up (ask 98z7p).
    expect(logs.filter((line) => /refused|signed up/.test(line))).toEqual([
      "[push] POST /api/push/subscribe refused 403: cross-origin request refused",
      "[push] POST /api/push/subscribe refused 401: sign in first",
      "[push] POST /api/push/subscribe refused 403: cross-origin request refused",
      "[push] POST /api/push/subscribe refused 400: invalid subscription",
      "[push] POST /api/push/subscribe refused 400: invalid subscription",
      "[push] a phone signed up (fcm.googleapis.com); 1 now",
      "[push] POST /api/push/unsubscribe refused 403: cross-origin request refused",
    ]);
    expect(logs.join()).not.toContain(sub.endpoint);
  });

  it("sends a test push", async () => {
    expect((await post("/api/push/test", {}, { cookie, "content-type": "application/json" })).status).toBe(403);
    await post("/api/push/subscribe", subscription(1));
    const test = await post("/api/push/test", {});
    expect(await test.json()).toEqual({ sent: 1, removed: 0 });
    expect(sender.sent[0]!.payload).toMatchObject({ title: "Rivet Agents", tag: "rivet-test", path: "/" });
  });

  it("a board PUT pushes each new card once", async () => {
    await post("/api/push/subscribe", subscription(1));
    expect((await putBoard(server.base)).status).toBe(200);
    await until(() => sender.sent.length >= 2);
    expect(sender.sent.map((s) => s.payload.tag)).toEqual(["need-pr2022-checkout", "need-billing-retry"]);

    const board = structuredClone(EXAMPLE_BOARD) as Omit<typeof EXAMPLE_BOARD, "needs"> & { needs: Record<string, unknown>[] };
    board.needs[0]!.title = "Edited title, same card";
    board.needs.push({ id: "kiosk-order", kind: "question", title: "Order the kiosk", ask: "Order for Friday?" });
    expect((await putBoard(server.base, board)).status).toBe(200);
    await until(() => sender.sent.length >= 3);
    await settle();
    expect(sender.sent.map((s) => s.payload.tag)).toEqual(["need-pr2022-checkout", "need-billing-retry", "need-kiosk-order"]);
    expect(sender.sent[2]!.payload).toMatchObject({ title: "Order the kiosk", body: "Order for Friday?", path: "/?card=kiosk-order" });

    // A stale If-Match writes nothing and pushes nothing.
    board.needs.push({ id: "late", kind: "question", title: "Late" });
    const stale = await fetch(`${server.base}/api/board`, {
      method: "PUT",
      headers: { ...bearer(BOARD_TOKEN), "if-match": "1" },
      body: JSON.stringify(board),
    });
    expect(stale.status).toBe(409);
    await settle();
    expect(sender.sent).toHaveLength(3);
  });
});

describe("push unconfigured", () => {
  it("boots without VAPID and refuses subscribe and test with 503", async () => {
    const server = await startServer();
    try {
      const cookie = server.cookie();
      const config = await fetch(`${server.base}/api/push/config`, { headers: { cookie } });
      expect(await config.json()).toEqual({ configured: false, publicKey: null, subscriptions: 0, lastRemoval: null });
      const subscribe = await fetch(`${server.base}/api/push/subscribe`, { method: "POST", headers: browser(cookie), body: JSON.stringify(subscription(1)) });
      expect(subscribe.status).toBe(503);
      expect((await fetch(`${server.base}/api/push/test`, { method: "POST", headers: browser(cookie), body: "{}" })).status).toBe(503);
      expect((await putBoard(server.base)).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
