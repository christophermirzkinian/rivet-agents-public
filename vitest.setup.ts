// Every Vitest project in the repo runs this before each test.
//
// Vitest 3.2.6 reports task updates from a throttled timer, and birpc gives
// each call 60 s. The worker reads the reply only when its event loop turns,
// and tests chain through promise microtasks, so a file of synchronous tests
// that runs past 60 s fails with `Timeout calling "onTaskUpdate"` even though
// every test passed. On a loaded CI host a 10 s file can take 70 s.
//
// One macrotask per test lets the loop read those replies. It uses Node's own
// setImmediate, so a test that fakes timers cannot stall it.
//
// Under CI the default test and hook timeouts get a 30 s floor. A loaded CI
// host stretched passing tests past Vitest's 5 s default, a different test in
// a different package every run. A larger timeout a package config sets is
// kept, and one a test or hook passes itself still wins. It is set before the
// yield hook registers, so that hook gets the floor too; Vitest resets the
// config after each file and runs this file again before the next.
//
// Wired through the root vitest.config.ts (Vitest finds the nearest config by
// walking up, so it covers every package without one) and through each
// package's own config; scripts/vitest-yield-setup.test.mjs checks both.
import { setImmediate } from "node:timers";
import { beforeEach, vi } from "vitest";

// Expected times in the tests are written for UTC+11 with no daylight saving.
// The server's setTimeZone falls back to the runtime zone, so fix that zone here.
// shared/when.ts reads the zone once as it loads, so board.js (which pulls it in)
// is imported only after this; a static import would hoist above it.
process.env.TZ = "Etc/GMT-11";
const { setDefaultRepo } = await import("./src/shared/board.js");
const { setKnownRepos } = await import("./src/shared/repos.js");
// A row naming no repo is the default repo's; the fixtures' default is this one.
setDefaultRepo("example-org/example-repo");
setKnownRepos(["example-org/example-repo", "example-org/other-repo", "example-org/third-repo", "example-org/mobile-app"]);

const CI_TIMEOUT_FLOOR_MS = 30_000;

if (process.env.CI && process.env.CI !== "false" && process.env.CI !== "0") {
  // Vitest has no public getter for the resolved config; this is the object
  // vi.setConfig writes to. Missing, the floor still applies.
  const config = (globalThis as { __vitest_worker__?: { config?: { testTimeout?: number; hookTimeout?: number } } }).__vitest_worker__?.config;
  const floored = {
    testTimeout: Math.max(config?.testTimeout ?? 0, CI_TIMEOUT_FLOOR_MS),
    hookTimeout: Math.max(config?.hookTimeout ?? 0, CI_TIMEOUT_FLOOR_MS),
  };
  vi.setConfig(floored);
  // vi keeps the worker state of its first import. A worker reused without
  // isolation runs a later pool task against a newer config object, which
  // vi.setConfig no longer reaches, so write the current one too.
  if (config) Object.assign(config, floored);
}

beforeEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

// happy-dom 20 keeps each MutationObserver's callback only through a WeakRef
// (MutationObserverListener: `callback: new WeakRef((record) => this.report(record))`),
// and nothing else holds that function, so the first garbage collection quietly
// stops every observer in the file. Where a collection lands moves with load and
// test order. A browser keeps an observer while its target lives, and happy-dom 21
// holds the callback strongly; until that bump, this setup holds it
// on the listener from the moment it observes. It reaches happy-dom through the window's
// own Node, so a package needs no import of its own; under node or jsdom there
// is nothing to wrap.
type MutationListener = { callback?: { deref?: () => unknown } };
const domNode = (globalThis as unknown as { Node?: { prototype: Record<symbol, unknown> } }).Node;
const observeMutations =
  domNode && Object.getOwnPropertySymbols(domNode.prototype).find((symbol) => symbol.description === "observeMutations");
const heldMutationCallbacks = Symbol.for("rivet.heldMutationCallbacks");
// happy-dom stays loaded across the files a worker runs; wrap it once.
if (domNode && observeMutations && !domNode.prototype[heldMutationCallbacks]) {
  const proto = domNode.prototype;
  proto[heldMutationCallbacks] = true;
  const observe = proto[observeMutations] as (this: unknown, listener: MutationListener) => void;
  proto[observeMutations] = function (this: unknown, listener: MutationListener) {
    const callback = listener.callback?.deref?.();
    if (callback) listener.callback = { deref: () => callback };
    observe.call(this, listener);
  };
}
