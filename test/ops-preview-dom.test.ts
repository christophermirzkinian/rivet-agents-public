// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.resetModules();
});

it("a reading's desktop URL loads the Ops fixtures and renders the page under More", async () => {
  history.replaceState(null, "", "/preview/desktop.html?tab=more&page=usage");
  document.body.innerHTML = '<div id="app"></div>';
  await (await import("../web/src/views/desktop.preview-entry.js")).previewReady;
  await vi.waitFor(async () => {
    const snapshot = await (await window.fetch("/api/ops")).json();
    expect(snapshot.github.prs.length).toBeGreaterThan(0);
    expect(snapshot.bridge).toBeDefined();
    expect(document.querySelector(".more-page[data-page=usage] .ops")).not.toBeNull();
    expect(document.body.textContent).not.toContain("Loading Ops");
  });
});
