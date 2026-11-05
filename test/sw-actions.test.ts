import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

import "../web/public/sw-logic.js";

// Answering from the notification: Yes / No / Later on a card's push, Seen on an update's.

type Plan = { kind: "later" | "open" } | { kind: "answer"; body: Record<string, unknown> };
const { notificationOptions, clickPlan, sendAnswer } = (
  globalThis as unknown as {
    rivetPush: {
      notificationOptions(payload: Record<string, unknown>, silent: boolean, maxActions?: number): Record<string, unknown>;
      clickPlan(data: unknown, action: string, clientId: string): Plan;
      sendAnswer(fetch: (url: string, init: RequestInit) => Promise<Response>, origin: string, body: unknown): Promise<boolean>;
    };
  }
).rivetPush;

const CARD = {
  title: "Ship Login Flow?",
  tag: "need-c1",
  path: "/?card=c1",
  card: "c1",
  rev: "0123456789abcdef",
  level: "needs-you",
  actions: [
    { action: "yes", title: "Yes" },
    { action: "no", title: "No" },
    { action: "later", title: "Later" },
  ],
  answers: { yes: { decision: "approve" }, no: { decision: "reject" } },
};

describe("notificationOptions with buttons", () => {
  it("shows as many buttons as the browser does and keeps the card, its rev and the answers for the tap", () => {
    const options = notificationOptions(CARD, false, 2);
    expect(options.actions).toEqual([
      { action: "yes", title: "Yes" },
      { action: "no", title: "No" },
    ]);
    expect(options.data).toEqual({ path: "/?card=c1", card: "c1", rev: "0123456789abcdef", answers: CARD.answers });
    expect(notificationOptions(CARD, false).actions).toHaveLength(3);
  });

  it("adds nothing to a push without buttons", () => {
    const options = notificationOptions({ title: "Rivet", body: "hi", path: "/" }, false, 2);
    expect(options).not.toHaveProperty("actions");
    expect(options.data).toEqual({ path: "/" });
  });
});

describe("clickPlan", () => {
  const data = { path: CARD.path, card: CARD.card, rev: CARD.rev, answers: { ...CARD.answers, seen: undefined } };

  it("answers Yes with the card's id and the rev the push was made at, and opens the card on a bare No", () => {
    expect(clickPlan(data, "yes", "push-abc12345")).toEqual({
      kind: "answer",
      body: { clientId: "push-abc12345", itemId: "c1", decision: "approve", rev: "0123456789abcdef" },
    });
    // A notification made before 2026-10-13 may still carry a bare reject: it opens the card, where the reject asks why.
    expect(clickPlan(data, "no", "push-abc12345")).toEqual({ kind: "open" });
  });

  it("picks an option by its label", () => {
    const ask = { ...data, answers: { yes: { decision: "choice", choice: "Yes" }, no: { decision: "choice", choice: "No" } } };
    expect(clickPlan(ask, "no", "push-abc12345")).toMatchObject({ kind: "answer", body: { decision: "choice", choice: "No" } });
  });

  it("marks an update Seen", () => {
    const update = { path: "/?card=u1", card: "u1", rev: "fedcba9876543210", answers: { seen: { decision: "seen" } } };
    expect(clickPlan(update, "seen", "push-abc12345")).toMatchObject({ kind: "answer", body: { itemId: "u1", decision: "seen" } });
  });

  it("only closes on Later, and opens the card on the notification itself or anything it cannot answer", () => {
    expect(clickPlan(data, "later", "push-abc12345")).toEqual({ kind: "later" });
    expect(clickPlan(data, "", "push-abc12345")).toEqual({ kind: "open" });
    expect(clickPlan({ path: "/" }, "yes", "push-abc12345")).toEqual({ kind: "open" });
    expect(clickPlan({ ...data, rev: undefined }, "yes", "push-abc12345")).toEqual({ kind: "open" });
  });
});

describe("sendAnswer", () => {
  it("posts as the app does, with the session cookie and the CSRF header", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = await sendAnswer(async (url, init) => (calls.push({ url, init }), new Response("{}", { status: 200 })), "https://app.example", { itemId: "c1" });
    expect(ok).toBe(true);
    expect(calls[0]!.url).toBe("https://app.example/api/replies");
    expect(calls[0]!.init).toMatchObject({ method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-rivet": "1" } });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ itemId: "c1" });
  });

  it("is false on a stale rev (409), any refusal, or no network", async () => {
    expect(await sendAnswer(async () => new Response("{}", { status: 409 }), "https://app.example", {})).toBe(false);
    expect(await sendAnswer(async () => new Response("{}", { status: 401 }), "https://app.example", {})).toBe(false);
    expect(await sendAnswer(async () => Promise.reject(new TypeError("offline")), "https://app.example", {})).toBe(false);
  });
});

describe("the worker's notificationclick", () => {
  type Listener = (event: unknown) => void;

  function boot(status: number) {
    const listeners = new Map<string, Listener>();
    const opened: string[] = [];
    const posted: unknown[] = [];
    const fetched: { url: string; body: unknown }[] = [];
    const pub = join(import.meta.dirname, "..", "web", "public");
    const context: Record<string, unknown> = {
      addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
      clients: {
        matchAll: async () => [{ id: "w1", postMessage: (message: unknown) => posted.push(message) }],
        claim: async () => {},
        openWindow: async (path: string) => void opened.push(path),
      },
      registration: { showNotification: async () => {} },
      navigator: { userAgent: "Android Chrome" },
      location: { origin: "https://app.example" },
      fetch: async (url: string, init: RequestInit) => (fetched.push({ url, body: JSON.parse(String(init.body)) }), new Response("{}", { status })),
      URL,
      crypto,
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
      importScripts: (path: string) => runInContext(readFileSync(join(pub, path), "utf8"), context),
    };
    context.self = context;
    createContext(context);
    runInContext(readFileSync(join(pub, "sw.js"), "utf8"), context);
    const click = (action: string) => {
      let done: Promise<unknown> = Promise.resolve();
      const data = { path: "/?card=c1", card: "c1", rev: "0123456789abcdef", answers: CARD.answers };
      listeners.get("notificationclick")!({ action, notification: { close: () => {}, data }, waitUntil: (p: Promise<unknown>) => (done = p) });
      return done;
    };
    return { click, opened, posted, fetched };
  }

  it("answers Yes from the notification and only tells an open window to redraw", async () => {
    const sw = boot(200);
    await sw.click("yes");
    expect(sw.fetched).toEqual([{ url: "https://app.example/api/replies", body: expect.objectContaining({ itemId: "c1", decision: "approve", rev: "0123456789abcdef" }) }]);
    expect((sw.fetched[0]!.body as { clientId: string }).clientId).toMatch(/^push-[A-Za-z0-9_-]{8,}$/);
    expect(sw.posted).toEqual([{ type: "refresh", card: "c1" }]);
    expect(sw.opened).toEqual([]);
  });

  it("opens the app on the card when the server refuses a late tap", async () => {
    const sw = boot(409);
    await sw.click("yes");
    expect(sw.fetched).toHaveLength(1);
    expect(sw.posted).toEqual([]);
    expect(sw.opened).toEqual(["/?card=c1"]);
  });

  it("opens the card on a bare No and posts nothing, so the reject asks why", async () => {
    const sw = boot(200);
    await sw.click("no");
    expect(sw.fetched).toEqual([]);
    expect(sw.opened).toEqual(["/?card=c1"]);
  });

  it("sends nothing on Later, and opens the card on a tap on the notification itself", async () => {
    const sw = boot(200);
    await sw.click("later");
    expect(sw.fetched).toEqual([]);
    expect(sw.opened).toEqual([]);
    await sw.click("");
    expect(sw.fetched).toEqual([]);
    expect(sw.opened).toEqual(["/?card=c1"]);
  });
});
