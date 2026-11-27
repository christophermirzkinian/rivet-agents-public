// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PushConfigResponse } from "../src/shared/board.js";
import * as api from "../web/src/api.js";
import { loadPushHealth, onPushChanged, pushChanged, pushHealth } from "../web/src/push-health.js";
import { endSession } from "../web/src/session.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const health = (subscriptions: number): PushConfigResponse => ({ configured: true, publicKey: "test", subscriptions, lastRemoval: null });
beforeEach(() => endSession());
afterEach(() => { vi.restoreAllMocks(); endSession(); });

it("keeps newer push health when overlapping reads resolve out of order", async () => {
  const older = deferred<PushConfigResponse>();
  const newer = deferred<PushConfigResponse>();
  vi.spyOn(api, "pushConfig").mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const first = loadPushHealth();
  const second = loadPushHealth();
  newer.resolve(health(2));
  await second;
  older.resolve(health(0));
  await first;
  expect(pushHealth()).toEqual(health(2));
});

it("invalidates a read from before a push change while the confirming read is still pending", async () => {
  const older = deferred<PushConfigResponse>();
  const newer = deferred<PushConfigResponse>();
  vi.spyOn(api, "pushConfig").mockResolvedValueOnce(health(1)).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  await loadPushHealth();
  const first = loadPushHealth();
  const changed = pushChanged();
  older.resolve(health(0));
  await first;
  expect(pushHealth()).toEqual(health(1));
  newer.resolve(health(2));
  await changed;
  expect(pushHealth()).toEqual(health(2));
});

it("invalidates old health before notifying push-change listeners", async () => {
  const older = deferred<PushConfigResponse>();
  vi.spyOn(api, "pushConfig").mockReturnValueOnce(older.promise).mockResolvedValue(health(2));
  const first = loadPushHealth();
  const stop = onPushChanged(() => { older.resolve(health(0)); });
  try {
    await pushChanged();
    await first;
    expect(pushHealth()).toEqual(health(2));
  } finally { stop(); }
});
