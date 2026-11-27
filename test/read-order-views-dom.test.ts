// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LogsResponse } from "../src/shared/command.js";
import type { SchedulesResponse } from "../src/shared/schedules.js";
import { screenView } from "../src/shared/screen-view.js";
import * as api from "../web/src/api.js";
import * as cmd from "../web/src/command-api.js";
import { app, resetSession } from "../web/src/state.js";
import { openNotDone } from "../web/src/views/chat-not-done.js";
import * as ops from "../web/src/views/ops.js";
import { scheduleApi } from "../web/src/views/schedules.js";
import { closeSheet } from "../web/src/views/sheet.js";
import * as toast from "../web/src/views/toast.js";
import { liveLog } from "../web/src/views/worker-sheet.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const worker = { repo: "example-org/example-repo", chat: "read-order" } as const;
const logs = (text: string): LogsResponse => ({ ...worker, lines: [text], times: [], updatedAt: null, leaseUntil: null, screen: screenView([text]), feed: [] });
let stopLog: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  resetSession();
  document.body.replaceChildren();
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  stopLog?.();
  stopLog = undefined;
  ops.unmount();
  closeSheet();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("does not reopen the newer not-done sheet after it closes and an older read arrives", async () => {
  const older = deferred<Awaited<ReturnType<typeof api.getAsks>>>();
  const newer = deferred<Awaited<ReturnType<typeof api.getAsks>>>();
  vi.spyOn(api, "getAsks").mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const first = openNotDone(vi.fn());
  const second = openNotDone(vi.fn());
  newer.resolve({ asks: [] });
  await second;
  expect(document.querySelector(".sheet-backdrop:not(.is-leaving)")).not.toBeNull();
  closeSheet();
  older.resolve({ asks: [] });
  await first;
  expect(document.querySelector(".sheet-backdrop:not(.is-leaving)")).toBeNull();
});

it("ignores a superseded not-done error and a read from a reset session", async () => {
  const older = deferred<Awaited<ReturnType<typeof api.getAsks>>>();
  const newer = deferred<Awaited<ReturnType<typeof api.getAsks>>>();
  vi.spyOn(api, "getAsks").mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const flash = vi.spyOn(toast, "flash");
  const signedOut = vi.fn();
  const first = openNotDone(signedOut);
  const second = openNotDone(signedOut);
  older.reject(new api.ApiError(401, "old failure"));
  await first;
  resetSession();
  newer.resolve({ asks: [] });
  await second;
  expect(signedOut).not.toHaveBeenCalled();
  expect(flash).not.toHaveBeenCalled();
  expect(document.querySelector(".sheet-backdrop:not(.is-leaving)")).toBeNull();
});

it("reads the live log one at a time, so reads slower than the tick still land and carry the newest ETag", async () => {
  type Read = Awaited<ReturnType<typeof cmd.getLogsIfChanged>>;
  const reads: ReturnType<typeof deferred<Read>>[] = [];
  vi.spyOn(cmd, "subscribeLogs").mockResolvedValue({ leaseUntil: "later" });
  vi.spyOn(cmd, "releaseLogs").mockResolvedValue({ ok: true });
  const poll = vi.spyOn(cmd, "getLogsIfChanged").mockImplementation(() => {
    const read = deferred<Read>();
    reads.push(read);
    return read.promise;
  });
  const render = vi.fn();
  stopLog = liveLog(worker, vi.fn(), render).stop;
  await settle();
  // No lines yet, so the tick polls fast; a read still out takes every tick until it answers.
  await vi.advanceTimersByTimeAsync(3_000);
  expect(poll).toHaveBeenCalledTimes(1);
  reads[0]!.resolve({ logs: logs("first"), etag: "first-tag" });
  await settle();
  expect(render.mock.lastCall?.[0].lines).toEqual(["first"]);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(poll).toHaveBeenCalledTimes(2);
  expect(poll.mock.lastCall?.[2]).toBe("first-tag");
  reads[1]!.reject(new api.ApiError(500, "slow failure"));
  await settle();
  await vi.advanceTimersByTimeAsync(4_000);
  expect(poll).toHaveBeenCalledTimes(3);
  stopLog();
  stopLog = undefined;
  reads[2]!.resolve({ logs: logs("after stop"), etag: "late" });
  await settle();
  expect(render.mock.lastCall?.[0].lines).toEqual(["first"]);
});

it.each([false, true])("keeps newer Ops schedules when the older refresh settles (failure: %s)", async (failure) => {
  const older = deferred<SchedulesResponse>();
  const newer = deferred<SchedulesResponse>();
  const get = vi.spyOn(scheduleApi, "get").mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  app.opsPage = "machines";
  void ops.refresh();
  void ops.refresh();
  expect(get).toHaveBeenCalledTimes(2);
  const snapshot = (name: string): SchedulesResponse => ({ at: new Date().toISOString(), stale: false, items: [{ id: "mac:dev.rivet-agents.test", source: "mac", name, what: "Test", when: "Daily", group: "daily", on: true, lastRun: null, nextRun: null, toggle: { can: true }, runs: [] }], sources: [] });
  newer.resolve(snapshot("Newer schedule"));
  await settle();
  if (failure) older.reject(new Error("old failure"));
  else older.resolve(snapshot("Older schedule"));
  await settle();
  const root = document.createElement("div");
  document.body.append(root);
  ops.mount(root);
  expect(root.textContent).toContain("Newer schedule");
  expect(root.textContent).not.toContain("Older schedule");
  expect(root.textContent).not.toContain("couldn't refresh");
});
