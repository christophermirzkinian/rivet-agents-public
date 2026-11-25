// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Settings › Devices › "Sign out desktop apps": there only where a device can sign in by a code alone, or one still is.

const DEFAULT_PUSH = { enabled: false, start: "22:00", end: "07:00", breakthrough: { appDown: true, deployFailed: true, capHit: true }, held: 0, quietNow: false };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let me: Record<string, unknown>;
let meStatus: number;
let revoke: () => Response;
let posts: string[];

/** A browser that can take notifications and has this server's push set up: allowed and subscribed, or not yet asked. */
function allowPush(subscribed: boolean) {
  const registration = { pushManager: { getSubscription: () => Promise.resolve(subscribed ? { endpoint: "https://fcm.googleapis.com/fcm/send/old" } : null) } };
  vi.stubGlobal("Notification", { permission: subscribed ? "granted" : "default" });
  vi.stubGlobal("PushManager", function PushManager() {});
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: () => Promise.resolve(registration) } });
  const real = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) =>
    String(input) === "/api/push/config" ? Promise.resolve(json({ configured: true, publicKey: "BPublicKeyForTests", subscriptions: 1, lastRemoval: null })) : real(input, init),
  );
}

async function mountSettings() {
  const state = await import("../web/src/state.js");
  state.app.status = { board: { version: 1, updatedAt: null }, bridge: { connected: true, lastSeenAt: null } };
  const signedOut: string[] = [];
  state.whenSignedOut((message) => signedOut.push(message));
  const settings = await import("../web/src/views/settings.js");
  const root = document.createElement("div");
  const toasts = document.createElement("div");
  document.body.replaceChildren(root, toasts);
  (await import("../web/src/views/toast.js")).mountToasts(toasts);
  settings.mount(root);
  await flush();
  const named = (words: string) => [...root.querySelectorAll("button")].find((button) => button.textContent === words) ?? null;
  return { root, signedOut, named, unmount: () => settings.unmount() };
}

beforeEach(() => {
  vi.resetModules();
  me = { signedIn: true };
  meStatus = 200;
  posts = [];
  revoke = () => json({ ended: 2 });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (init.method === "POST") posts.push(url);
      if (url === "/api/me") return Promise.resolve(json(me, meStatus));
      if (url === "/api/settings/push") return Promise.resolve(json(DEFAULT_PUSH));
      if (url === "/api/auth/device-code") return Promise.resolve(json({ error: "sign in with a passkey to add a device" }, 403));
      if (url === "/api/auth/device-sessions/revoke") return Promise.resolve(revoke());
      return Promise.resolve(json({ error: "not found" }, 404));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Sign out desktop apps", () => {
  it("is not in Settings when the server takes no code alone and no such session is live", async () => {
    const { named, unmount } = await mountSettings();
    expect(named("Add a device")).not.toBeNull();
    expect(named("Sign out desktop apps")).toBeNull();
    unmount();
  });

  it("offers no Add a device in a window a code alone signed in, and says where one is added", async () => {
    me = { signedIn: true, deviceSession: true, deviceSessions: 1, via: "device-code" };
    const { root, named, unmount } = await mountSettings();
    expect(named("Add a device")).toBeNull();
    expect(root.querySelector(".device")!.textContent).toContain("Add a device from a phone or computer signed in with a passkey.");
    expect(posts).toEqual([]);
    expect(named("Sign out desktop apps")).not.toBeNull();
    unmount();
  });

  it("shows that line, and no error, when the server refuses Add a device in a window that had not heard how it signed in", async () => {
    me = { error: "unavailable" };
    meStatus = 503;
    const { root, named, unmount } = await mountSettings();
    named("Add a device")!.click();
    await flush();
    expect(posts).toEqual(["/api/auth/device-code"]);
    expect(named("Add a device")).toBeNull();
    expect(root.querySelector(".device")!.textContent).toContain("Add a device from a phone or computer signed in with a passkey.");
    expect(document.body.textContent).not.toContain("sign in with a passkey to add a device");
    unmount();
  });

  it.each([
    ["not yet turned on", false, "Turn on notifications"],
    ["on", true, "Turn off"],
  ])("offers no notifications set-up in a window a code alone signed in (%s), and says where they are turned on", async (_name, subscribed, offered) => {
    allowPush(subscribed);
    const passkey = await mountSettings();
    await flush();
    expect(passkey.named(offered)).not.toBeNull();
    passkey.unmount();

    vi.resetModules();
    me = { signedIn: true, deviceSession: true, deviceSessions: 1, via: "device-code" };
    const { root, named, unmount } = await mountSettings();
    await flush();
    const panel = root.querySelector(".notify")!;
    expect(panel.textContent).toContain("Turn on notifications from a phone or computer signed in with a passkey.");
    expect(panel.querySelector("button")).toBeNull();
    for (const words of ["Turn on notifications", "Send a test", "Turn off"]) expect(named(words)).toBeNull();
    expect(posts).toEqual([]);
    unmount();
  });

  it("keeps Add a device for a passkey's session while desktop apps are signed in", async () => {
    me = { signedIn: true, deviceSession: true, deviceSessions: 1 };
    const { root, named, unmount } = await mountSettings();
    expect(named("Add a device")).not.toBeNull();
    expect(root.querySelector(".device")!.textContent).not.toContain("signed in with a passkey");
    unmount();
  });

  it.each([
    ["the server takes a code alone", { signedIn: true, deviceSession: true }],
    ["the switch is off and such a session is still live", { signedIn: true, deviceSessions: 1 }],
  ])("is there when %s, asks first, and Cancel sends nothing", async (_name, answer) => {
    me = answer;
    const { root, named, unmount } = await mountSettings();
    named("Sign out desktop apps")!.click();
    expect(posts).toEqual([]);
    expect(root.querySelector(".device-desktop")!.textContent).toContain("Each needs a new code to come back.");
    named("Cancel")!.click();
    expect(posts).toEqual([]);
    expect(named("Sign out desktop apps")).not.toBeNull();
    expect(named("Sign them out")).toBeNull();
    unmount();
  });

  it("ends them on the second tap, keeps this device signed in, and goes once none is left and the switch is off", async () => {
    me = { signedIn: true, deviceSessions: 2 };
    const { signedOut, named, unmount } = await mountSettings();
    named("Sign out desktop apps")!.click();
    me = { signedIn: true };
    named("Sign them out")!.click();
    await flush();
    await flush();
    expect(posts).toEqual(["/api/auth/device-sessions/revoke"]);
    expect(signedOut).toEqual([]);
    expect(document.body.textContent).toContain("2 desktop apps signed out.");
    expect(named("Sign out desktop apps")).toBeNull();
    expect(named("Sign out")).not.toBeNull();
    unmount();
  });

  it("signs this device out too when its own session was one of them", async () => {
    me = { signedIn: true, deviceSession: true, deviceSessions: 1 };
    revoke = () => json({ ended: 1, signedOut: true });
    const { signedOut, named, unmount } = await mountSettings();
    named("Sign out desktop apps")!.click();
    named("Sign them out")!.click();
    await flush();
    expect(signedOut).toEqual(["Signed out."]);
    unmount();
  });

  it("says so and stays signed in when the server could not be reached", async () => {
    me = { signedIn: true, deviceSession: true };
    revoke = () => json({ error: "too many attempts, wait a minute" }, 429);
    const { signedOut, named, unmount } = await mountSettings();
    named("Sign out desktop apps")!.click();
    named("Sign them out")!.click();
    await flush();
    expect(signedOut).toEqual([]);
    expect(document.body.textContent).toContain("Not signed out: Too many tries. Wait a minute, then try again.");
    expect(named("Sign them out")!.disabled).toBe(false);
    unmount();
  });
});
