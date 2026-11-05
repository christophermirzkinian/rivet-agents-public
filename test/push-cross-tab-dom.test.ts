// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OFF = "rivet.push.off";
const ENDPOINT = "https://push.example.test/phone";
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const config = { configured: true, publicKey: "BPublicKeyForTests", subscriptions: 0, lastRemoval: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Hold one actual browser/server step; later calls (from the other tab) proceed normally. */
function pauseNext<T extends unknown[], R>(mock: ReturnType<typeof vi.fn<(...args: T) => Promise<R>>>) {
  const entered = deferred<void>();
  const release = deferred<void>();
  const run = mock.getMockImplementation()!;
  mock.mockImplementationOnce(async (...args: T) => {
    entered.resolve();
    await release.promise;
    return run(...args);
  });
  return { entered: entered.promise, release: () => release.resolve() };
}

function browser(locks = false) {
  const rows = new Set<string>();
  let subscription: PushSubscription | null = null;
  const unsubscribe = vi.fn(async () => { subscription = null; return true; });
  const phone = {
    endpoint: ENDPOINT,
    toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: "key", auth: "auth" } }),
    unsubscribe,
  } as unknown as PushSubscription;
  const subscribe = vi.fn(async () => { subscription = phone; return phone; });
  const getSubscription = vi.fn(async () => subscription);
  const registration = { pushManager: { subscribe, getSubscription } } as unknown as ServiceWorkerRegistration;
  const register = vi.fn(async () => registration);
  const getRegistration = vi.fn(async () => registration);
  const worker = { register, getRegistration, ready: Promise.resolve(registration) };
  const requestPermission = vi.fn(async (): Promise<NotificationPermission> => "granted");
  vi.stubGlobal("Notification", { permission: "granted", requestPermission });
  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: worker });
  // Separate module instances share this real FIFO, just as tabs share the browser's lock manager.
  let tail = Promise.resolve();
  const request = vi.fn((_name: string, _options: unknown, run: () => Promise<unknown>) => {
    const result = tail.then(run);
    tail = result.then(() => undefined, () => undefined);
    return result;
  });
  Object.defineProperty(navigator, "locks", { configurable: true, value: locks ? { request } : undefined });
  const readConfig = vi.fn(async () => json(config));
  const post = vi.fn(async () => { rows.add(ENDPOINT); return json({ ok: true }); });
  const remove = vi.fn(async () => { rows.delete(ENDPOINT); return json({ removed: true }); });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/push/config") return readConfig();
    if (url === "/api/push/subscribe") return post();
    if (url === "/api/push/unsubscribe") return remove();
    throw new Error(`Unexpected request: ${url}`);
  }));
  return { rows, phone, subscribe, unsubscribe, getSubscription, register, getRegistration, worker,
    requestPermission, readConfig, post, remove, request, subscription: () => subscription };
}

async function tabs() {
  const first = await import("../web/src/push.js");
  vi.resetModules();
  const second = await import("../web/src/push.js");
  return { first, second };
}

// Attach rejection handling immediately: cancellation is expected while the other tab is still working.
const outcome = (promise: Promise<unknown>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));

beforeEach(() => { vi.resetModules(); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("push operations across tabs", () => {
  it("a newer enable queued behind disable completes without reconciliation deadlocking the lock", async () => {
    const b = browser(true);
    const { first, second } = await tabs();
    await first.enablePush();
    const removal = pauseNext(b.remove);
    const older = outcome(first.disablePush());
    await removal.entered;
    const newer = second.enablePush();
    removal.release();
    expect(await older).toHaveProperty("error");
    await expect(newer).resolves.toBe("on");
    expect(b.subscription()).not.toBeNull();
    expect(b.rows.has(ENDPOINT)).toBe(true);
  });

  it.each([false, true])("a stale permission guard read cannot reclaim intent after a newer disable (Web Locks: %s)", async (locks) => {
    const b = browser(locks);
    const { first, second } = await tabs();
    const prompt = pauseNext(b.requestPermission);
    const older = outcome(first.enablePush());
    await prompt.entered;
    const get = localStorage.getItem.bind(localStorage);
    let reads = 0;
    let newer: Promise<unknown> | undefined;
    vi.spyOn(localStorage, "getItem").mockImplementation((key) => {
      const value = get(key);
      // The second guard is inside the lock callback, immediately before the old
      // implementation wrote its intent again. Return the read begun before Turn off.
      if (key === "rivet.push.operation" && ++reads === 2) newer = outcome(second.disablePush());
      return value;
    });
    prompt.release();
    expect(await older).toHaveProperty("error");
    expect(newer).toBeDefined();
    expect(await newer).toEqual({ value: "off" });
    await second.resyncPush();
    expect(b.subscription()).toBeNull();
    expect(b.rows.size).toBe(0);
  });

  it("cleanup does not capture a newer on revision after reading the old off preference", async () => {
    const b = browser();
    const { first, second } = await tabs();
    const subscribe = pauseNext(b.subscribe);
    const older = outcome(first.enablePush());
    await subscribe.entered;
    await second.disablePush();
    const get = localStorage.getItem.bind(localStorage);
    let reads = 0;
    let injected = false;
    vi.spyOn(localStorage, "getItem").mockImplementation((key) => {
      const value = get(key);
      if (key === "rivet.push.operation" && ++reads === 2) {
        injected = true;
        // A separate process completes Turn on between storage reads. Its existing
        // browser subscription is the one the paused subscribe just produced.
        localStorage.setItem(key, "on:newer-tab");
        localStorage.removeItem(OFF);
        b.rows.add(ENDPOINT);
      }
      return value;
    });
    subscribe.release();
    await older;
    expect(injected).toBe(true);
    expect(b.subscription()).not.toBeNull();
    expect(b.rows.has(ENDPOINT)).toBe(true);
  });

  it.each([false, true])("repairs a browser unsubscribe that finishes after its deadline and a newer enable (Web Locks: %s)", async (locks) => {
    vi.useFakeTimers();
    const b = browser(locks);
    const { first, second } = await tabs();
    await first.enablePush();
    const removal = pauseNext(b.unsubscribe);
    const older = outcome(first.disablePush());
    await removal.entered;
    await vi.advanceTimersByTimeAsync(first.PUSH_STEP_MS + 1);
    expect(await older).toHaveProperty("error");
    await expect(second.enablePush()).resolves.toBe("on");
    removal.release();
    // Drain the late browser completion and its reconciliation without calling resync
    // from the test: the expired operation itself must repair its delayed side effect.
    await vi.advanceTimersByTimeAsync(0);
    expect(b.subscription()).not.toBeNull();
    expect(b.rows.has(ENDPOINT)).toBe(true);
  });

  it("honours the legacy opt-out before any stamped choice", async () => {
    const b = browser();
    localStorage.setItem(OFF, "1");
    const { first } = await tabs();
    await first.resyncPush();
    expect(b.subscribe).not.toHaveBeenCalled();
    expect(b.post).not.toHaveBeenCalled();
  });

  it.each(["enable", "disable"] as const)("does not report a successful %s when its shared choice cannot be saved", async (operation) => {
    const b = browser();
    const { first } = await tabs();
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("storage blocked"); });
    await expect(operation === "enable" ? first.enablePush() : first.disablePush()).rejects.toThrow("Could not save");
    expect(b.post).not.toHaveBeenCalled();
    expect(b.remove).not.toHaveBeenCalled();
  });

  describe.each([false, true])("storage interleavings (Web Locks: %s)", (locks) => {
    it.each(["off removal", "operation write"] as const)("keeps the next resync off when disable interleaves with the older enable's %s", async (stage) => {
      const b = browser(locks);
      const { first, second } = await tabs();
      let newer: Promise<unknown> | undefined;
      let injected = false;
      const disable = () => {
        if (injected) return;
        injected = true;
        newer = outcome(second.disablePush());
      };
      // Another browser process can run between consecutive synchronous localStorage calls.
      // Inject at the storage boundary; a promise pause would miss both reported schedules.
      if (stage === "off removal") {
        const remove = localStorage.removeItem.bind(localStorage);
        vi.spyOn(localStorage, "removeItem").mockImplementation((key) => {
          if (key === OFF) disable();
          remove(key);
        });
      } else {
        const set = localStorage.setItem.bind(localStorage);
        vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
          set(key, value);
          if (key === "rivet.push.operation") disable();
        });
      }
      await outcome(first.enablePush());
      expect(injected).toBe(true);
      expect(await newer).toEqual({ value: "off" });
      const postsBeforeResync = b.post.mock.calls.length;
      await second.resyncPush();
      expect(b.post).toHaveBeenCalledTimes(postsBeforeResync);
      expect(b.subscription()).toBeNull();
      expect(b.rows.size).toBe(0);
    });
  });

  it.each(["enable", "resync"] as const)("a late %s cleanup cannot delete the latest enable's server subscription", async (operation) => {
    const b = browser();
    const { first, second } = await tabs();
    const subscribe = pauseNext(b.subscribe);
    const older = outcome(operation === "enable" ? first.enablePush() : first.resyncPush());
    await subscribe.entered;
    await second.disablePush();
    const removal = pauseNext(b.remove);
    subscribe.release();
    await removal.entered;
    await expect(second.enablePush()).resolves.toBe("on");
    expect(b.rows.has(ENDPOINT)).toBe(true);
    removal.release();
    await older;
    expect(b.rows.has(ENDPOINT)).toBe(true);
    expect(b.subscription()).not.toBeNull();
    expect(localStorage.getItem(OFF)).toBeNull();
  });

  it("a direct disable whose server deletion lands late preserves the newer enable", async () => {
    const b = browser();
    const { first, second } = await tabs();
    await first.enablePush();
    const removal = pauseNext(b.remove);
    const older = outcome(first.disablePush());
    await removal.entered;
    await expect(second.enablePush()).resolves.toBe("on");
    removal.release();
    await older;
    expect(b.rows.has(ENDPOINT)).toBe(true);
    expect(b.subscription()).not.toBeNull();
    expect(localStorage.getItem(OFF)).toBeNull();
  });

  it("a browser unsubscribe completing after a newer enable restores a live subscription", async () => {
    const b = browser();
    const { first, second } = await tabs();
    await first.enablePush();
    const removal = pauseNext(b.unsubscribe);
    const older = outcome(first.disablePush());
    await removal.entered;
    await expect(second.enablePush()).resolves.toBe("on");
    removal.release();
    await older;
    expect(b.subscription()).not.toBeNull();
    expect(b.rows.has(ENDPOINT)).toBe(true);
    expect(localStorage.getItem(OFF)).toBeNull();
  });

  it.each([false, true])("a delayed permission prompt cannot undo Turn off (Web Locks: %s)", async (locks) => {
    const b = browser(locks);
    const { first, second } = await tabs();
    const permission = pauseNext(b.requestPermission);
    const older = outcome(first.enablePush());
    await permission.entered;
    await expect(second.disablePush()).resolves.toBe("off");
    permission.release();
    expect(await older).toHaveProperty("error");
    expect(localStorage.getItem(OFF)).toBe("1");
    expect(b.subscribe).not.toHaveBeenCalled();
    expect(b.post).not.toHaveBeenCalled();
  });

  it.each(["register", "config", "ready", "subscription"] as const)("Turn off wins while an older enable awaits %s", async (stage) => {
    const b = browser();
    const { first, second } = await tabs();
    let gate: { entered: Promise<void>; release: () => void };
    if (stage === "ready") {
      const entered = deferred<void>();
      const ready = deferred<ServiceWorkerRegistration>();
      Object.defineProperty(b.worker, "ready", { get() { entered.resolve(); return ready.promise; } });
      gate = { entered: entered.promise, release: () => ready.resolve({ pushManager: { subscribe: b.subscribe, getSubscription: b.getSubscription } } as unknown as ServiceWorkerRegistration) };
    } else {
      gate = stage === "register" ? pauseNext(b.register) : stage === "config" ? pauseNext(b.readConfig) : pauseNext(b.getSubscription);
    }
    const older = outcome(first.enablePush());
    await gate.entered;
    await second.disablePush();
    gate.release();
    expect(await older).toHaveProperty("error");
    expect(localStorage.getItem(OFF)).toBe("1");
    expect(b.subscribe).not.toHaveBeenCalled();
    expect(b.post).not.toHaveBeenCalled();
  });

  it.each(["enable", "resync"] as const)("removes a browser subscription that arrives after Turn off during %s", async (operation) => {
    const b = browser();
    const { first, second } = await tabs();
    const gate = pauseNext(b.subscribe);
    const older = outcome(operation === "enable" ? first.enablePush() : first.resyncPush());
    await gate.entered;
    await second.disablePush();
    gate.release();
    await older;
    expect(localStorage.getItem(OFF)).toBe("1");
    expect(b.subscription()).toBeNull();
    expect(b.unsubscribe).toHaveBeenCalledOnce();
    expect(b.post).not.toHaveBeenCalled();
    expect(b.rows.size).toBe(0);
  });

  it.each(["enable", "resync"] as const)("removes a server subscription whose POST lands after Turn off during %s", async (operation) => {
    const b = browser();
    const { first, second } = await tabs();
    const gate = pauseNext(b.post);
    const older = outcome(operation === "enable" ? first.enablePush() : first.resyncPush());
    await gate.entered;
    await second.disablePush();
    gate.release();
    await older;
    expect(localStorage.getItem(OFF)).toBe("1");
    expect(b.subscription()).toBeNull();
    expect(b.rows.size).toBe(0);
    expect(b.post).toHaveBeenCalledOnce();
  });

  it("queues Turn off behind a running POST and cleans up before releasing the lock", async () => {
    const b = browser(true);
    const { first, second } = await tabs();
    const gate = pauseNext(b.post);
    const older = outcome(first.enablePush());
    await gate.entered;
    const off = second.disablePush();
    expect(localStorage.getItem(OFF)).toBe("1");
    expect(b.getRegistration).not.toHaveBeenCalled();
    gate.release();
    await older;
    await expect(off).resolves.toBe("off");
    expect(b.rows.size).toBe(0);
    expect(b.subscription()).toBeNull();
  });

  it.each(["registration", "subscription"] as const)("an older disable stops after its delayed %s read when another tab turns on", async (stage) => {
    const b = browser();
    const { first, second } = await tabs();
    await first.enablePush();
    const gate = stage === "registration" ? pauseNext(b.getRegistration) : pauseNext(b.getSubscription);
    const older = outcome(first.disablePush());
    await gate.entered;
    await expect(second.enablePush()).resolves.toBe("on");
    gate.release();
    expect(await older).toHaveProperty("error");
    expect(b.remove).not.toHaveBeenCalled();
    expect(b.unsubscribe).not.toHaveBeenCalled();
    expect(b.subscription()).toBe(b.phone);
    expect(b.rows.has(ENDPOINT)).toBe(true);
    expect(localStorage.getItem(OFF)).toBeNull();
  });

  it("an older disable cannot unsubscribe the newer explicit enable after its server wait", async () => {
    const b = browser();
    const { first, second } = await tabs();
    await first.enablePush();
    const entered = deferred<void>();
    const release = deferred<void>();
    // The DELETE has landed; only its response is delayed, allowing a later POST to restore it.
    const remove = b.remove.getMockImplementation()!;
    b.remove.mockImplementationOnce(async () => {
      const response = await remove();
      entered.resolve();
      await release.promise;
      return response;
    });
    const older = outcome(first.disablePush());
    await entered.promise;
    await expect(second.enablePush()).resolves.toBe("on");
    release.resolve();
    expect(await older).toHaveProperty("error");
    expect(b.unsubscribe).not.toHaveBeenCalled();
    expect(b.subscription()).toBe(b.phone);
    expect(b.rows.has(ENDPOINT)).toBe(true);
    expect(localStorage.getItem(OFF)).toBeNull();
  });

  it("a latest explicit enable can turn notifications back on after cancelling an older prompt", async () => {
    const b = browser(true);
    const { first, second } = await tabs();
    const prompt = pauseNext(b.requestPermission);
    const older = outcome(first.enablePush());
    await prompt.entered;
    await second.disablePush();
    await expect(second.enablePush()).resolves.toBe("on");
    prompt.release();
    expect(await older).toHaveProperty("error");
    expect(localStorage.getItem(OFF)).toBeNull();
    expect(b.subscription()).toBe(b.phone);
    expect(b.post).toHaveBeenCalledOnce();
  });

  it("an old resync does not revive after another tab turns off then on again", async () => {
    const b = browser();
    const { first, second } = await tabs();
    const gate = pauseNext(b.readConfig);
    const older = first.resyncPush();
    await gate.entered;
    await second.disablePush();
    await expect(second.enablePush()).resolves.toBe("on");
    gate.release();
    await older;
    expect(localStorage.getItem(OFF)).toBeNull();
    expect(b.subscribe).toHaveBeenCalledOnce();
    expect(b.post).toHaveBeenCalledOnce();
    expect(b.subscription()).toBe(b.phone);
  });
});
