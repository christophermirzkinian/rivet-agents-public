// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeServer, type FakeServer } from "./conversations-fake.js";

// The app as a link or a notification opens it: main.ts reads the address once, at start, so each test loads it anew.

vi.mock("../web/src/voice.js", async (original) => ({
  ...(await original<typeof import("../web/src/voice.js")>()),
  say: () => {},
  unlockVoice: () => Promise.resolve(true),
  unlockOnTap: () => () => {},
  stopVoice: () => {},
}));

let server: FakeServer;

class FakeSource {
  static CLOSED = 2;
  readyState = 1;
  addEventListener() {}
  close() {}
}

const settle = async () => {
  for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function start(address: string): Promise<typeof import("../web/src/views/chat.js")> {
  history.replaceState(null, "", address);
  await import("../web/src/main.js");
  await settle();
  return import("../web/src/views/chat.js");
}

beforeEach(() => {
  vi.resetModules();
  server = fakeServer(
    [
      { id: "k1", from: "owner", text: "Results row", at: "2030-01-01T00:01:00.000Z", status: "replied", threadId: "k1" },
      { id: "k2", from: "rivet", text: "PR #341 is up", at: "2030-01-01T00:02:00.000Z", threadId: "k1" },
      { id: "g1", from: "owner", text: "quote form", at: "2030-01-01T00:03:00.000Z", status: "replied", threadId: "g1" },
    ],
    { k1: { title: "Results row", unread: 1, thing: true }, g1: { title: "quote enquiry form", unread: 2 }, k9: { unread: 3 } },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "/api/me" ? Promise.resolve(new Response(JSON.stringify({ signedIn: true }), { status: 200, headers: { "content-type": "application/json" } })) : server.fetch(input, init),
    ),
  );
  vi.stubGlobal("EventSource", FakeSource);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  localStorage.clear();
  document.body.replaceChildren(Object.assign(document.createElement("div"), { id: "app" }));
});

afterEach(async () => {
  // Signing out tears down the shell main.js mounted, so no home screen keeps ticking after the test.
  (await import("../web/src/state.js")).signedOut("");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a link into a conversation", () => {
  it("/?conversation=<id> opens Chat on that conversation, and the address is left clean", async () => {
    const chat = await start("/?conversation=k1");
    expect(chat.openConversation()).toBe("k1");
    expect(document.querySelector(".thing-title")!.textContent).toBe("Results row");
    expect(location.search).toBe("");
  });

  it("/?tab=chat&conversation=<id> does the same", async () => {
    const chat = await start("/?tab=chat&conversation=g1");
    expect(chat.openConversation()).toBe("g1");
  });

  it("an old Threads link opens the conversation its message is in", async () => {
    const chat = await start("/?tab=chat&thread=k2");
    expect(chat.openConversation()).toBe("k1");
    expect(server.requests).toContain("GET /api/conversations/k2");
  });

  it("Chat at its newest reads its own lines and a thing's, whose replies it shows (2026-11-16), and Rivet's dot clears", async () => {
    await start("/?tab=chat");
    expect(document.querySelector(".rivet-sheet .home-chat")).not.toBeNull();
    expect(server.posted).toContainEqual({ ids: ["g1", "k1", "k9"], action: "read" });
    const rivet = document.querySelector('.home-dock [data-key="rivet"]')!;
    expect(rivet.getAttribute("aria-label")).toBe("Rivet");
    expect(rivet.querySelector(".home-dot")).toBeNull();
  });

  it("Chat scrolled up from its newest reads nothing, and Rivet's dot counts Chat once and each thing with an unread reply", async () => {
    // Nothing in happy-dom lays out: Chat stands 1000px tall, scrolled to its top.
    const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
    const top = vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockReturnValue(0);
    try {
      await start("/?tab=chat");
      expect(document.querySelector(".rivet-sheet .home-chat")).not.toBeNull();
      expect(server.posted.filter((body) => body.action === "read")).toEqual([]);
      // The home screen's dock carries the Chat tab's count as Rivet's dot, its number said to a screen reader.
      const rivet = document.querySelector('.home-dock [data-key="rivet"]')!;
      expect(rivet.getAttribute("aria-label")).toBe("Rivet, 2 unread");
      expect(rivet.querySelector(".home-dot")).not.toBeNull();
    } finally {
      height.mockRestore();
      top.mockRestore();
    }
  });

});
