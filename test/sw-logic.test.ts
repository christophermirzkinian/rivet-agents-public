import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import "../web/public/sw-logic.js";

interface View {
  id: string;
  tab: string | null;
  card: string | null;
  chat: string | null;
  visible: boolean;
  focused: boolean;
}
type Plan = { action: "show" | "silent" | "skip"; refresh: string[] };
const { shouldNotify, notificationOptions, untilAck, refreshId, ACK_MS } = (
  globalThis as unknown as {
    rivetPush: {
      shouldNotify(viewing: (View | undefined)[], payload: Record<string, unknown>, ua: string): Plan;
      notificationOptions(payload: Record<string, unknown>, silent: boolean): Record<string, unknown>;
      untilAck(waiting: Map<string, () => void>, id: string, ms: number): Promise<boolean>;
      refreshId(crypto: unknown): string;
      ACK_MS: number;
    };
  }
).rivetPush;

const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const IPHONE_PWA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

const view = (extra: Partial<View> = {}): View => ({ id: "w1", tab: "feed", card: "c1", chat: null, visible: true, focused: true, ...extra });

describe("shouldNotify", () => {
  it("skips a push for the card or chat a focused, visible window shows, and refreshes that window", () => {
    expect(shouldNotify([view()], { card: "c1" }, ANDROID)).toEqual({ action: "skip", refresh: ["w1"] });
    expect(shouldNotify([view({ tab: "chat", card: null, chat: "k1" })], { chat: "k1" }, ANDROID)).toEqual({ action: "skip", refresh: ["w1"] });
  });

  it("matches a push from before conversations, chat \"rivet\" beside its conversation, by that conversation", () => {
    expect(shouldNotify([view({ tab: "chat", card: null, chat: "k1" })], { chat: "rivet", conversation: "k1" }, ANDROID)).toEqual({ action: "skip", refresh: ["w1"] });
    expect(shouldNotify([view({ tab: "chat", card: null, chat: "k2" })], { chat: "rivet", conversation: "k1" }, ANDROID).action).toBe("show");
  });

  it("shows it for another card, a hidden or unfocused window, or a window with no report", () => {
    expect(shouldNotify([view()], { card: "c2" }, ANDROID)).toEqual({ action: "show", refresh: [] });
    expect(shouldNotify([view({ visible: false })], { card: "c1" }, ANDROID).action).toBe("show");
    expect(shouldNotify([view({ focused: false })], { card: "c1" }, ANDROID).action).toBe("show");
    expect(shouldNotify([undefined], { card: "c1" }, ANDROID).action).toBe("show");
    expect(shouldNotify([], { card: "c1" }, ANDROID).action).toBe("show");
    expect(shouldNotify([view({ card: null })], { title: "digest" }, ANDROID).action).toBe("show");
  });

  it("still shows one on iOS and Safari, silent", () => {
    expect(shouldNotify([view()], { card: "c1" }, IPHONE_PWA)).toEqual({ action: "silent", refresh: ["w1"] });
    expect(shouldNotify([view()], { card: "c1" }, MAC_SAFARI).action).toBe("silent");
  });
});

describe("notificationOptions", () => {
  it("rings for needs-you and keeps an FYI silent under its own tag", () => {
    expect(notificationOptions({ title: "A", body: "b", tag: "need-a", path: "/?card=a", level: "needs-you" }, false)).toMatchObject({
      tag: "need-a",
      silent: false,
      data: { path: "/?card=a" },
    });
    const fyi = notificationOptions({ title: "A", body: "b", tag: "need-a", path: "/", level: "fyi" }, false);
    expect(fyi).toMatchObject({ tag: "fyi-need-a", silent: true });
    expect(fyi).not.toHaveProperty("vibrate");
    expect(notificationOptions({ title: "A", tag: "need-a", level: "needs-you" }, true).silent).toBe(true);
  });

  it("carries the card and its revision, so the page can close it once answered", () => {
    expect(notificationOptions({ title: "A", tag: "need-a", path: "/?card=a", card: "a", rev: "r1", level: "fyi" }, false).data).toMatchObject({
      path: "/?card=a",
      card: "a",
      rev: "r1",
    });
    expect(notificationOptions({ title: "A", tag: "rivet", path: "/" }, false).data).not.toHaveProperty("card");
  });
});

describe("untilAck", () => {
  afterEach(() => vi.useRealTimers());

  it("resolves true on an ack in time and false once the time runs out", async () => {
    vi.useFakeTimers();
    const waiting = new Map<string, () => void>();
    const acked = untilAck(waiting, "1", ACK_MS);
    const late = untilAck(waiting, "2", ACK_MS);
    waiting.get("1")!();
    await vi.advanceTimersByTimeAsync(ACK_MS);
    await expect(acked).resolves.toBe(true);
    await expect(late).resolves.toBe(false);
    expect(waiting.size).toBe(0);
  });
});

describe("sw.js", () => {
  type Listener = (event: Record<string, unknown>) => void;
  afterEach(() => vi.useRealTimers());

  /** Windows acknowledge every refresh, as a page that redraws does, unless `ack` is false. */
  function boot(
    ua: string,
    windows: { id: string; visibilityState: string; focused: boolean }[],
    ack = true,
    crypto: unknown = globalThis.crypto,
    stall: { matchAll?: boolean; focus?: boolean } = {},
  ) {
    const listeners = new Map<string, Listener>();
    const shown: { title: string; options: Record<string, unknown> }[] = [];
    const posted: { id: string; message: unknown }[] = [];
    const badges: number[] = [];
    const opened: string[] = [];
    const clients = windows.map((w) => ({
      ...w,
      focus: () => (stall.focus ? new Promise(() => {}) : Promise.resolve(w)),
      postMessage: (message: { type: string; id: string }) => {
        posted.push({ id: w.id, message });
        if (ack && message.type === "refresh") queueMicrotask(() => listeners.get("message")!({ data: { type: "refresh-ack", id: message.id }, source: { id: w.id } }));
      },
    }));
    const pub = join(import.meta.dirname, "..", "web", "public");
    const context: Record<string, unknown> = {
      addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
      clients: {
        matchAll: () => (stall.matchAll ? new Promise(() => {}) : Promise.resolve(clients)),
        claim: async () => {},
        openWindow: async (path: string) => void opened.push(path),
      },
      registration: {
        showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }),
        getNotifications: async () => shown,
      },
      navigator: { userAgent: ua, setAppBadge: async (n: number) => void badges.push(n) },
      location: { origin: "https://app.example" },
      URL,
      crypto,
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
      importScripts: (path: string) => runInContext(readFileSync(join(pub, path), "utf8"), context),
    };
    context.self = context;
    createContext(context);
    runInContext(readFileSync(join(pub, "sw.js"), "utf8"), context);
    const report = (id: string, data: Record<string, unknown>) => listeners.get("message")!({ data: { type: "viewing", ...data }, source: { id } });
    const ackFor = (id: string) => listeners.get("message")!({ data: { type: "refresh-ack", id }, source: { id: "w1" } });
    const push = (payload: Record<string, unknown>) => {
      let done: Promise<unknown> = Promise.resolve();
      listeners.get("push")!({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => (done = p) });
      return done;
    };
    const click = (path: string) => {
      let done: Promise<unknown> = Promise.resolve();
      listeners.get("notificationclick")!({ notification: { close: () => {}, data: { path } }, waitUntil: (p: Promise<unknown>) => (done = p) });
      return done;
    };
    return { report, push, ackFor, click, shown, posted, badges, opened };
  }

  it("refreshes the window showing the card instead of notifying, and notifies once it moves on", async () => {
    const sw = boot(ANDROID, [{ id: "w1", visibilityState: "visible", focused: true }]);
    await sw.push({ title: "Card", tag: "need-c1", path: "/?card=c1", card: "c1", level: "needs-you" });
    expect(sw.shown).toHaveLength(1);

    sw.report("w1", { tab: "feed", card: "c1", visible: true });
    await sw.push({ title: "Card", tag: "need-c1", path: "/?card=c1", card: "c1", level: "needs-you" });
    expect(sw.shown).toHaveLength(1);
    expect(sw.posted).toEqual([{ id: "w1", message: { type: "refresh", id: expect.any(String), card: "c1" } }]);

    sw.report("w1", { tab: "feed", card: "c1", visible: false });
    await sw.push({ title: "Card", tag: "need-c1", path: "/?card=c1", card: "c1", level: "needs-you" });
    expect(sw.shown).toHaveLength(2);
  });

  it("shows an FYI silent and leaves the badge to the app", async () => {
    const sw = boot(ANDROID, []);
    await sw.push({ title: "Merged", tag: "need-m", path: "/", card: "m", level: "fyi" });
    expect(sw.shown[0]!.options).toMatchObject({ silent: true, tag: "fyi-need-m" });
    expect(sw.badges).toEqual([]);
    expect(readFileSync(join(import.meta.dirname, "..", "web", "public", "sw.js"), "utf8")).not.toContain("setAppBadge");
  });

  it("tells the window showing the chat that the refresh is for the chat", async () => {
    const sw = boot(ANDROID, [{ id: "w1", visibilityState: "visible", focused: true }]);
    sw.report("w1", { tab: "chat", chat: "k1", visible: true });
    await sw.push({ title: "Rivet", tag: "rivet-chat", path: "/?conversation=k1", chat: "k1", level: "needs-you" });
    expect(sw.shown).toHaveLength(0);
    expect(sw.posted).toEqual([{ id: "w1", message: { type: "refresh", id: expect.any(String), chat: "k1" } }]);
  });

  it("names the conversation in the refresh for a push from before conversations", async () => {
    const sw = boot(ANDROID, [{ id: "w1", visibilityState: "visible", focused: true }]);
    sw.report("w1", { tab: "chat", chat: "k1", visible: true });
    await sw.push({ title: "Rivet", tag: "rivet-chat", path: "/?conversation=k1", chat: "rivet", conversation: "k1", level: "needs-you" });
    expect(sw.shown).toHaveLength(0);
    expect(sw.posted).toEqual([{ id: "w1", message: { type: "refresh", id: expect.any(String), chat: "k1" } }]);
  });

  it("shows a push and still ids a refresh where crypto has no randomUUID", async () => {
    const lone = boot(ANDROID, [], true, {});
    await lone.push({ title: "Card", card: "c1", level: "needs-you" });
    expect(lone.shown).toHaveLength(1);

    const sw = boot(ANDROID, [{ id: "w1", visibilityState: "visible", focused: true }], true, {});
    sw.report("w1", { tab: "feed", card: "c1", visible: true });
    await sw.push({ title: "Card", card: "c1", level: "needs-you" });
    expect(sw.shown).toHaveLength(0);
    expect((sw.posted[0]!.message as { id: string }).id).toMatch(/^\d+-[0-9a-z]+$/);
    expect(refreshId({})).not.toBe(refreshId({}));
  });

  it("gives each refresh a random id, so an ack meant for an earlier worker's refresh never cancels this one", async () => {
    vi.useFakeTimers();
    const sw = boot(ANDROID, [{ id: "w1", visibilityState: "visible", focused: true }], false);
    sw.report("w1", { tab: "chat", chat: "k1", visible: true });
    const first = sw.push({ title: "Rivet", chat: "k1", level: "needs-you" });
    const second = sw.push({ title: "Rivet", chat: "k1", level: "needs-you" });
    await vi.advanceTimersByTimeAsync(0);
    const ids = sw.posted.map((post) => (post.message as { id: string }).id);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[0]).not.toBe(ids[1]);
    sw.ackFor("1");
    sw.ackFor(ids[1]!);
    await vi.advanceTimersByTimeAsync(ACK_MS);
    await Promise.all([first, second]);
    expect(sw.shown).toHaveLength(1);
  });

  it("notifies after all when the window never acknowledges the refresh", async () => {
    vi.useFakeTimers();
    const sw = boot(ANDROID, [{ id: "w1", visibilityState: "visible", focused: true }], false);
    sw.report("w1", { tab: "chat", chat: "k1", visible: true });
    const done = sw.push({ title: "Rivet", body: "hi", tag: "rivet-chat", path: "/?conversation=k1", chat: "k1", level: "needs-you" });
    await vi.advanceTimersByTimeAsync(ACK_MS - 1);
    expect(sw.posted).toHaveLength(1);
    expect(sw.shown).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(sw.shown).toEqual([{ title: "Rivet", options: notificationOptions({ body: "hi", tag: "rivet-chat", path: "/?conversation=k1", level: "needs-you" }, false) }]);
  });

  it("still notifies when looking up the open windows stalls", async () => {
    vi.useFakeTimers();
    const sw = boot(ANDROID, [{ id: "w1", visibilityState: "visible", focused: true }], true, globalThis.crypto, { matchAll: true });
    const done = sw.push({ title: "Card", tag: "need-c1", path: "/?card=c1", card: "c1", level: "needs-you" });
    await vi.advanceTimersByTimeAsync(3_000);
    await done;
    expect(sw.shown).toHaveLength(1);
  });

  it("a tap opens a new window when the window lookup stalls, but not when only its focus stalls", async () => {
    vi.useFakeTimers();
    const win = { id: "w1", visibilityState: "visible", focused: false };
    const quick = boot(ANDROID, [win]);
    await quick.click("/?card=c1");
    expect(quick.posted).toEqual([{ id: "w1", message: { type: "open-card", id: "c1" } }]);
    expect(quick.opened).toEqual([]);

    const lookup = boot(ANDROID, [win], true, globalThis.crypto, { matchAll: true });
    const looked = lookup.click("/?card=c1");
    await vi.advanceTimersByTimeAsync(3_000);
    await looked;
    expect(lookup.opened).toEqual(["/?card=c1"]);

    const focus = boot(ANDROID, [win], true, globalThis.crypto, { focus: true });
    const focused = focus.click("/?tab=chat");
    await vi.advanceTimersByTimeAsync(3_000);
    await focused;
    expect(focus.posted).toEqual([{ id: "w1", message: { type: "open-tab", tab: "chat" } }]);
    expect(focus.opened).toEqual([]);
  });

  it("on an iPhone shows the on-screen card silently instead of skipping it", async () => {
    const sw = boot(IPHONE_PWA, [{ id: "w1", visibilityState: "visible", focused: true }]);
    sw.report("w1", { tab: "feed", card: "c1", visible: true });
    await sw.push({ title: "Card", tag: "need-c1", path: "/", card: "c1", level: "needs-you" });
    expect(sw.shown.map((s) => s.options.silent)).toEqual([true]);
    expect(sw.posted).toEqual([{ id: "w1", message: { type: "refresh", id: expect.any(String), card: "c1" } }]);
  });

  it("on an iPhone rings once the window never acknowledges the refresh, say scrolled up above the reply", async () => {
    vi.useFakeTimers();
    const sw = boot(IPHONE_PWA, [{ id: "w1", visibilityState: "visible", focused: true }], false);
    sw.report("w1", { tab: "chat", chat: "k1", visible: true });
    const done = sw.push({ title: "Rivet", body: "hi", tag: "rivet-chat", path: "/?conversation=k1", chat: "k1", level: "needs-you" });
    await vi.advanceTimersByTimeAsync(ACK_MS - 1);
    expect(sw.posted).toHaveLength(1);
    expect(sw.shown).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(sw.shown.map((s) => s.options.silent)).toEqual([false]);
  });
});
