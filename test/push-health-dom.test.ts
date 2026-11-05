// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PushConfigResponse } from "../src/shared/board.js";

// Android blocked the app's notifications, the push service then answered 410 and the server dropped the only
// phone, and nothing said so for two days. The app now says so, shows the way back, and re-subscribes once allowed.

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
const CONFIG: PushConfigResponse = {
  configured: true,
  publicKey: "BPublicKeyForTests",
  subscriptions: 1,
  lastRemoval: null,
};
const GONE: PushConfigResponse = {
  ...CONFIG,
  subscriptions: 0,
  lastRemoval: {
    at: "2026-09-30T01:29:01.000Z",
    reason: "gone",
    status: 410,
    host: "fcm.googleapis.com",
    remaining: 0,
  },
};

let permission: NotificationPermission;
let subscription: { endpoint: string; toJSON: () => unknown } | null;
let subscribe: ReturnType<typeof vi.fn>;
let posted: string[];

function stubBrowser(config: PushConfigResponse, standalone = true) {
  vi.stubGlobal("Notification", {
    get permission() {
      return permission;
    },
    requestPermission: () => Promise.resolve(permission),
  });
  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: standalone && query.includes("standalone"),
  }));
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  subscribe = vi.fn(() => {
    subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/new",
      toJSON: () => ({
        endpoint: "https://fcm.googleapis.com/fcm/send/new",
        keys: { p256dh: "BKey", auth: "auth" },
      }),
    };
    return Promise.resolve(subscription);
  });
  const registration = {
    pushManager: {
      getSubscription: () => Promise.resolve(subscription),
      subscribe,
    },
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: () => Promise.resolve(registration),
      register: () => Promise.resolve(registration),
      ready: Promise.resolve(registration),
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (init.method === "POST") posted.push(url);
      if (url === "/api/push/config") return Promise.resolve(json(config));
      return Promise.resolve(json({ ok: true }));
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  permission = "granted";
  subscription = null;
  posted = [];
  localStorage.clear();
  document.body.replaceChildren();
});

afterEach(() => vi.unstubAllGlobals());

describe("which alarm", () => {
  it("is loud when this phone blocks them or no phone gets them, quiet otherwise", async () => {
    const { pushAlarm } = await import("../web/src/push-health.js");
    expect(pushAlarm(CONFIG, "granted")).toBeNull();
    expect(pushAlarm(CONFIG, "denied")).toBe("blocked");
    expect(pushAlarm(GONE, "granted")).toBe("none");
    expect(pushAlarm(GONE, "default")).toBe("none");
    expect(pushAlarm({ ...GONE, configured: false }, "denied")).toBeNull();
    expect(pushAlarm(null, "denied")).toBeNull();
  });
});

describe("the banner", () => {
  it("says notifications are off on every phone, why, and turns them on with one tap", async () => {
    stubBrowser(GONE);
    const health = await import("../web/src/push-health.js");
    await health.loadPushHealth();
    const banner = health.pushBanner()!;
    expect(banner.textContent).toContain("Notifications are off on every phone");
    expect(banner.textContent).toMatch(/30 Sept?( \d{4})? at 12:29pm/);
    expect(banner.textContent).toMatch(/blocked for Rivet Agents/);
    const turnOn = [...banner.querySelectorAll("button")].find((b) => b.textContent === "Turn on")!;
    turnOn.click();
    await vi.waitFor(() => expect(posted).toContain("/api/push/subscribe"));
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("tells a blocked Android phone how to unblock Rivet Agents from the app's own settings", async () => {
    permission = "denied";
    stubBrowser(CONFIG);
    const health = await import("../web/src/push-health.js");
    await health.loadPushHealth();
    const banner = health.pushBanner()!;
    expect(banner.textContent).toContain("Notifications are blocked on this phone");
    expect(banner.textContent).toContain("They're blocked for Rivet Agents on this phone");
    expect([...banner.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Press and hold the Rivet Agents icon on your Home Screen, then tap App info.",
      "Tap Notifications and turn on Allow notifications.",
      "Come back here and tap Turn on.",
    ]);
  });

  it("still says no phone gets them when this one is blocked and was the last (the 2026-09-30 case)", async () => {
    permission = "denied";
    stubBrowser(GONE);
    const health = await import("../web/src/push-health.js");
    await health.loadPushHealth();
    const banner = health.pushBanner()!;
    expect(banner.textContent).toContain("Notifications are off on every phone");
    expect(banner.querySelectorAll("li")).toHaveLength(3);
  });

  it("is gone while a phone gets them", async () => {
    stubBrowser(CONFIG);
    const health = await import("../web/src/push-health.js");
    await health.loadPushHealth();
    expect(health.pushBanner()).toBeNull();
  });
});

describe("resync", () => {
  const OFF = "rivet.push.off";

  it("subscribes a phone that allows them but has no subscription and was never turned off (your phone on 2026-10-01)", async () => {
    stubBrowser(GONE);
    const { resyncPush } = await import("../web/src/push.js");
    await resyncPush();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(posted).toEqual(["/api/push/subscribe"]);
  });

  it("re-sends a subscription the phone still has, without making a new one", async () => {
    stubBrowser(GONE);
    subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/old", toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/old", keys: { p256dh: "BKey", auth: "auth" } }) };
    const { resyncPush } = await import("../web/src/push.js");
    await resyncPush();
    expect(subscribe).not.toHaveBeenCalled();
    expect(posted).toEqual(["/api/push/subscribe"]);
  });

  it("never subscribes a phone Settings turned off, or one that has not allowed them", async () => {
    stubBrowser(GONE);
    const { disablePush, resyncPush } = await import("../web/src/push.js");
    await disablePush();
    expect(localStorage.getItem(OFF)).toBe("1");
    await resyncPush();
    localStorage.removeItem(OFF);
    permission = "default";
    await resyncPush();
    expect(subscribe).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it("does nothing while a Turn off is still running, and Turn on clears the off record", async () => {
    stubBrowser(GONE);
    subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/old", toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/old", keys: { p256dh: "BKey", auth: "auth" } }) };
    Object.assign(subscription, { unsubscribe: () => Promise.resolve(true) });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const real = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => (String(input) === "/api/push/unsubscribe" ? gate.then(() => real(input, init)) : real(input, init)));
    const { disablePush, resyncPush } = await import("../web/src/push.js");
    const off = disablePush();
    await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toContain("/api/push/unsubscribe"));
    await resyncPush();
    release();
    await off;
    expect(localStorage.getItem(OFF)).toBe("1");
    expect(posted).toEqual(["/api/push/unsubscribe"]);
    const { enablePush } = await import("../web/src/push.js");
    await enablePush();
    expect(localStorage.getItem(OFF)).toBeNull();
  });

  it("stands down when Turn off lands while it waits on the server", async () => {
    stubBrowser(GONE);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const real = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => (String(input) === "/api/push/config" ? gate.then(() => real(input, init)) : real(input, init)));
    const { disablePush, resyncPush } = await import("../web/src/push.js");
    const resync = resyncPush();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await disablePush();
    release();
    await resync;
    expect(subscribe).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it("stands down when its subscription read finishes after a Turn off has finished", async () => {
    stubBrowser(GONE);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { disablePush, resyncPush } = await import("../web/src/push.js");
    const registration = await navigator.serviceWorker.getRegistration("/");
    const read = registration!.pushManager.getSubscription.bind(registration!.pushManager);
    const old = { endpoint: "https://fcm.googleapis.com/fcm/send/old", toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/old", keys: { p256dh: "BKey", auth: "auth" } }) };
    let calls = 0;
    registration!.pushManager.getSubscription = () => (++calls === 1 ? gate.then(() => old as unknown as PushSubscription) : read());
    const resync = resyncPush();
    await vi.waitFor(() => expect(calls).toBe(1));
    await disablePush();
    release();
    await resync;
    expect(subscribe).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it("finishes a Turn on whose server step failed, on the next resync", async () => {
    localStorage.setItem(OFF, "1");
    stubBrowser(GONE);
    const real = vi.mocked(fetch).getMockImplementation()!;
    let down = true;
    vi.mocked(fetch).mockImplementation((input, init) =>
      down && String(input) === "/api/push/subscribe" ? Promise.resolve(json({ error: "push is not configured" }, 503)) : real(input, init),
    );
    const { enablePush, resyncPush } = await import("../web/src/push.js");
    await expect(enablePush()).rejects.toThrow();
    expect(localStorage.getItem(OFF)).toBeNull();
    down = false;
    posted = [];
    await resyncPush();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(posted).toEqual(["/api/push/subscribe"]);
  });
});
