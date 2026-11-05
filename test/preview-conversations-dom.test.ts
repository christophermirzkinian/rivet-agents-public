// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

// The dev previews answer the Chat tab's conversation routes, so their chat pane shows an empty list, not an error.

const real = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = real;
  vi.resetModules();
});

describe.each([
  ["ops", () => import("../web/src/views/ops.preview.js"), "Say anything to Rivet. Each piece of work gets a page of its own."],
])("the %s preview", (_name, load, shown) => {
  it("answers the list as empty and any conversation as gone, and its Chat tab shows its Chat page", async () => {
    history.replaceState(null, "", "/?tab=chat");
    document.body.innerHTML = '<div id="app"></div>';
    await load();
    expect(await (await window.fetch("/api/conversations")).json()).toEqual({ conversations: [], older: 0, unread: 0 });
    expect((await window.fetch("/api/conversations/k1")).status).toBe(404);
    await vi.waitFor(() => expect(document.querySelector(".chat-scroll")?.textContent).toContain(shown));
  });
});
