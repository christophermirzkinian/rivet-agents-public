// @vitest-environment happy-dom
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServedNeed } from "../src/shared/board.js";
import type { Worker } from "../src/shared/workers.js";

// A card's push on the phone opens its card in the Decide sheet.

const R = "example-org/example-repo";
const NOW = Date.now();
const worker = (id: string, chat: string): Worker => ({ id, name: id, repo: R, chat, state: "working", lastOutputAt: NOW - 30_000 }) as Worker;
const need = (id: string, chat: string): ServedNeed =>
  ({ id, rev: `rev-${id}`, kind: "decision", title: `Card ${id}`, ask: "Which one?", chat, since: new Date(NOW - 60_000).toISOString(), options: [{ label: "Glow" }, { label: "Bounce" }, { label: "Keep" }] }) as ServedNeed;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const sheet = (): HTMLElement | null => document.querySelector<HTMLElement>(".sheet.is-tall.decide-sheet");
const shownTitle = () => sheet()?.querySelector(".decide-card .card-title")?.textContent ?? sheet()?.querySelector(".decide-card [data-need]")?.getAttribute("data-need");

describe("a card's push on the phone", () => {
  class FakeSource {
    static CLOSED = 2;
    readyState = 1;
    addEventListener() {}
    close() {}
  }
  const workers = { at: new Date(NOW).toISOString(), workers: [worker("b", "invoices")] };
  let board: { version: number; updatedAt: string; board: { updatedAt: string; needs: ServedNeed[]; coming: never[]; chats: never[]; shipped: never[] } };
  let sw: EventTarget;

  beforeEach(() => {
    vi.resetModules();
    board = { version: 1, updatedAt: new Date(NOW).toISOString(), board: { updatedAt: new Date(NOW).toISOString(), needs: [need("n1", "invoices")], coming: [], chats: [], shipped: [] } };
    sw = Object.assign(new EventTarget(), { controller: null, ready: new Promise(() => {}), getRegistration: async () => undefined, register: async () => undefined });
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: sw });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/me") return json({ signedIn: true });
        if (url === "/api/board") return json(board);
        if (url === "/api/workers") return json(workers);
        if (url === "/api/status") return json({ board: { version: 1, updatedAt: null }, bridge: { connected: true, lastSeenAt: null } });
        if (url.startsWith("/api/replies")) return json({ replies: [] });
        return json({ error: "not found" }, 404);
      }),
    );
    vi.stubGlobal("EventSource", FakeSource);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    localStorage.clear();
    history.replaceState(null, "", "/");
    document.body.replaceChildren(Object.assign(document.createElement("div"), { id: "app" }));
  });

  afterEach(async () => {
    // Signing out tears down the shell main.js mounted, so no home screen keeps ticking after the test.
    (await import("../web/src/state.js")).signedOut("");
    (await import("../web/src/views/sheet.js")).closeTallSheet();
    Reflect.deleteProperty(navigator, "serviceWorker");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a cold ?card= link to a card the first read lacks opens it once a second read has it; signing out closes the sheet", async () => {
    history.replaceState(null, "", "/?card=n7");
    let reads = 0;
    const boardRead = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (String(input) === "/api/board" && ++reads === 2) board.board.needs.push(need("n7", "invoices"));
      return boardRead(input);
    });
    await import("../web/src/main.js");
    await flush();
    const { decideShown } = await import("../web/src/views/decide-sheet.js");
    expect(decideShown()).toBe("n7");
    // A 401 on the next read signs out: the sheet hangs off the page, and goes with the shell.
    vi.mocked(fetch).mockImplementation(async (input) => (String(input) === "/api/board" ? json({ error: "signed out" }, 401) : boardRead(input)));
    await (await import("../web/src/state.js")).refresh();
    await flush();
    expect(document.querySelector(".decide-sheet")).toBeNull();
    expect(decideShown()).toBeNull();
  });

  it("a push still waiting on the open sheet's Back opens nothing once a 401 signs out", async () => {
    await import("../web/src/main.js");
    await flush();
    const { decideShown } = await import("../web/src/views/decide-sheet.js");
    sw.dispatchEvent(new MessageEvent("message", { data: { type: "open-card", id: "n1" } }));
    await flush();
    expect(decideShown()).toBe("n1");
    board.board.needs.push(need("n2", "invoices"));
    (await import("../web/src/state.js")).app.board!.board!.needs.push(need("n2", "invoices"));
    // The sheet's Back has not landed yet when the 401 comes: only its 400 ms fallback is left to run the push.
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    sw.dispatchEvent(new MessageEvent("message", { data: { type: "open-card", id: "n2" } }));
    const boardRead = vi.mocked(fetch).getMockImplementation()!;
    // One 401 signs out; the push's own read after it must not bring the card back over sign-in.
    let ended = false;
    vi.mocked(fetch).mockImplementation(async (input) => (String(input) === "/api/board" && !ended ? ((ended = true), json({ error: "signed out" }, 401)) : boardRead(input)));
    await (await import("../web/src/state.js")).refresh();
    // Past the sheet's Back fallback (400 ms).
    await new Promise((resolve) => setTimeout(resolve, 450));
    await flush();
    expect(document.querySelector(".decide-sheet")).toBeNull();
    expect(decideShown()).toBeNull();
    back.mockRestore();
  });

  it("opens the card's Decide sheet over Progress, not the Cards list, and a card not yet on the board after a refresh", async () => {
    await import("../web/src/main.js");
    await flush();
    const { app } = await import("../web/src/state.js");
    const { decideShown } = await import("../web/src/views/decide-sheet.js");
    app.tab = "chat";

    sw.dispatchEvent(new MessageEvent("message", { data: { type: "open-card", id: "n1" } }));
    await flush();
    expect(app.tab).toBe("progress");
    expect(decideShown()).toBe("n1");
    expect(document.querySelector(".decide-sheet")).not.toBeNull();

    // A card pushed a moment ago that this app has not read yet: it reads the board again and opens it.
    board.board.needs.push(need("n9", "invoices"));
    sw.dispatchEvent(new MessageEvent("message", { data: { type: "open-card", id: "n9" } }));
    await flush();
    expect(app.tab).toBe("progress");
    expect(decideShown()).toBe("n9");
  });
});
