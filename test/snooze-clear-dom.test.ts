// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";

it("loading the app drops the 30-minute snoozes Later used to store, so no card stays hidden", async () => {
  localStorage.setItem("rivet.snoozed", JSON.stringify({ a: { rev: "r1", until: Date.now() + 30 * 60_000 } }));
  vi.resetModules();
  await import("../web/src/state.js");
  expect(localStorage.getItem("rivet.snoozed")).toBeNull();
});
