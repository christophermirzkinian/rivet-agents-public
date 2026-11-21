// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeServer, type FakeServer } from "./conversations-fake.js";

// The whole app on a hosted machine, whose supervisor answers /cloud/*, and on the owner's own machine, which does not.

vi.mock("../web/src/voice.js", async (original) => ({
  ...((await original()) as Record<string, unknown>),
  say: () => {},
  unlockVoice: () => Promise.resolve(true),
  unlockOnTap: () => () => {},
  stopVoice: () => {},
}));

class FakeSource {
  static CLOSED = 2;
  readyState = 1;
  addEventListener() {}
  close() {}
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
let server: FakeServer;
let cloud: Record<string, unknown> = {};

const settle = async () => {
  for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function start(wide = false): Promise<void> {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: wide, media: query, addEventListener() {}, removeEventListener() {} }));
  history.replaceState(null, "", "/");
  await import("../web/src/main.js");
  await settle();
}

beforeEach(() => {
  vi.resetModules();
  server = fakeServer([]);
  cloud = {};
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/me") return Promise.resolve(json({ signedIn: true }));
      if (path.startsWith("/cloud/")) return Promise.resolve(path in cloud ? json(cloud[path]) : new Response("Not found", { status: 404 }));
      return server.fetch(input, init);
    }),
  );
  vi.stubGlobal("EventSource", FakeSource);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  localStorage.clear();
  document.body.replaceChildren(Object.assign(document.createElement("div"), { id: "app" }));
});

afterEach(async () => {
  (await import("../web/src/state.js")).signedOut("");
  (await import("../web/src/cloud-agent.js")).resetCloud();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the agent's name", () => {
  const host = (name: string | null) => (cloud = { "/cloud/agent": { name, setupDone: true, firstPlan: "claude" } });

  async function expectNamed(shown: string): Promise<void> {
    expect(document.querySelector(".home-title")!.textContent!.trim()).toBe(shown);
    const dock = document.querySelector<HTMLElement>('.home-dock [data-key="rivet"]')!;
    expect(dock.textContent!.trim()).toBe(shown);
    expect(dock.getAttribute("aria-label")).toBe(shown);
    expect(document.querySelector(".home-dock")!.getAttribute("aria-label")).toBe(`Decide and ${shown}`);
    expect(document.querySelector("aside.side")!.getAttribute("aria-label")).toBe(`Chat with ${shown}`);

    dock.click();
    await settle();
    const sheet = document.querySelector(".rivet-sheet")!;
    expect(sheet.getAttribute("aria-label")).toBe(shown);
    expect(sheet.querySelector(".chat-title")!.textContent).toBe(shown);
    expect(sheet.querySelector(".chat-text")!.getAttribute("aria-label")).toBe(`Message ${shown}`);
    (await import("../web/src/views/sheet.js")).closeTallSheet();

    (await import("../web/src/views/rivet-summary.js")).openRivetSummary();
    expect(document.querySelector(".rivet-sum .sheet-title")!.textContent).toBe(shown);
    expect(document.querySelector(".rivet-sum")!.getAttribute("aria-label")).toBe(shown);
    expect(document.querySelector('[data-use="desks.rivet.chat"]')!.textContent).toBe(`${shown}'s chat`);
  }

  it("is Rivet on the owner's own machine", async () => {
    await start();
    await expectNamed("Rivet");
  });

  it("is a hosted agent's own name on the band, the dock, its sheet, its chat and its desk's sheet", async () => {
    host("Pip");
    await start();
    await expectNamed("Pip");
  });

  it("is Agent for a hosted agent with no name yet", async () => {
    host(null);
    await start();
    await expectNamed("Agent");
  });

  it("reaches a wide window's chat, which mounts before the supervisor answers", async () => {
    host("Pip");
    await start(true);
    const pane = document.querySelector("aside.side")!;
    expect(pane.getAttribute("aria-label")).toBe("Chat with Pip");
    expect(pane.querySelector(".chat-title")!.textContent).toBe("Pip");
    expect(pane.querySelector(".chat-text")!.getAttribute("aria-label")).toBe("Message Pip");
    expect(pane.querySelector(".chat-empty")!.textContent).toBe("Say anything to Pip.");
  });

  it("leaves a wide window's chat as Rivet on the owner's own machine", async () => {
    await start(true);
    const pane = document.querySelector("aside.side")!;
    expect(pane.querySelector(".chat-title")!.textContent).toBe("Rivet");
    expect(pane.querySelector(".chat-empty")!.textContent).toBe("Say anything to Rivet.");
  });
});

describe("the Connect a plan band", () => {
  it("goes at a sign-out", async () => {
    cloud = { "/cloud/agent": { name: "Pip", setupDone: true, firstPlan: "claude" }, "/cloud/connect/status": { claude: false, chatgpt: false } };
    await start();
    expect(document.getElementById("cloud-connect")).not.toBeNull();
    (await import("../web/src/state.js")).signedOut("");
    await settle();
    expect(document.querySelector(".gate")).not.toBeNull();
    expect(document.getElementById("cloud-connect")).toBeNull();
  });
});
