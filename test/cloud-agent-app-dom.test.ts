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
/** The owner's own server's answer for /cloud/* (http.ts): a JSON 404, the one definite "not hosted". */
let ownMachine = false;

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
  ownMachine = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/me") return Promise.resolve(json({ signedIn: true }));
      if (path.startsWith("/cloud/") && ownMachine) return Promise.resolve(new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } }));
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

describe("a hosted agent with no plan connected", () => {
  const LOCKED = "Sending is off until Claude or ChatGPT is connected.";
  const host = (status?: { claude: boolean; chatgpt: boolean }) =>
    (cloud = { "/cloud/agent": { name: "Pip", setupDone: true, firstPlan: "claude" }, ...(status ? { "/cloud/connect/status": status } : {}) });
  const pane = () => document.querySelector("aside.side")!;
  const box = () => pane().querySelector<HTMLTextAreaElement>(".chat-text")!;
  const sendButton = () => pane().querySelector<HTMLButtonElement>(".chat-send")!;
  const line = () => pane().querySelector<HTMLAnchorElement>(".chat-compose-box .noplan-line")!;
  const sends = () => vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === "/api/chat" && init?.method === "POST").length;
  /** The app comes back to the front, which reads the plans again (main.ts). */
  const comeBack = async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
  };
  const expectOpen = () => {
    expect(document.querySelector(".noplan-box")).toBeNull();
    expect(box().disabled).toBe(false);
    expect(line().hidden).toBe(true);
    expect(pane().querySelector(".chat-field .noplan-mark")!.hasAttribute("hidden")).toBe(true);
  };
  const expectLocked = () => {
    expect(document.querySelector(".noplan-box")).not.toBeNull();
    expect(box().disabled).toBe(true);
    expect(sendButton().disabled).toBe(true);
    expect(pane().querySelector(".chat-field .noplan-mark")!.hasAttribute("hidden")).toBe(false);
    expect(line().hidden).toBe(false);
    expect(line().textContent).toBe(LOCKED);
    expect(line().getAttribute("href")).toBe("/cloud/setup/connect");
  };

  it("says to connect one on the home screen, locks the message box and sends nothing", async () => {
    const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
    host({ claude: false, chatgpt: false });
    await start(true);
    const says = document.querySelector(".home .noplan-box")!;
    expect(says.querySelector(".noplan-title")!.textContent).toBe("Connect Claude or ChatGPT to start");
    expect(says.querySelector(".noplan-words")!.textContent).toBe("Pip can't take jobs until one is connected. It takes about a minute.");
    const connect = says.querySelector<HTMLButtonElement>("button")!;
    expect(connect.textContent).toBe("Connect now");
    expect(connect.dataset.use).toBe("cloud.connect-band");
    connect.click();
    expect(assign).toHaveBeenCalledWith("/cloud/setup/connect");
    expectLocked();
    box().value = "Hello";
    sendButton().click();
    await settle();
    expect(sends()).toBe(0);
    expect(document.body.textContent).not.toMatch(/Rivet|Rivet/);
    assign.mockRestore();
  });

  it("says so on a phone's home screen too, and its chat sheet is locked", async () => {
    host({ claude: false, chatgpt: false });
    await start();
    expect(document.querySelector(".home .noplan-box")).not.toBeNull();
    document.querySelector<HTMLElement>('.home-dock [data-key="rivet"]')!.click();
    await settle();
    const sheet = document.querySelector(".rivet-sheet")!;
    expect(sheet.querySelector<HTMLTextAreaElement>(".chat-text")!.disabled).toBe(true);
    expect(sheet.querySelector(".noplan-line")!.textContent).toBe(LOCKED);
  });

  it("unlocks with no reload once a plan is connected", async () => {
    host({ claude: false, chatgpt: false });
    await start(true);
    expectLocked();
    host({ claude: false, chatgpt: true });
    await comeBack();
    expectOpen();
    box().value = "Hello";
    sendButton().click();
    await settle();
    expect(sends()).toBe(1);
  });

  it("unlocks by itself on the next status read while the desk stays in front", async () => {
    host({ claude: false, chatgpt: false });
    await start(true);
    expectLocked();
    host({ claude: true, chatgpt: false });
    vi.advanceTimersByTime(15_000);
    await settle();
    expectOpen();
    expect(document.querySelector(".noplan-box")).toBeNull();
  });

  it("locks nothing while the status is unread", async () => {
    host();
    await start(true);
    expectOpen();
  });

  it("locks when a send comes back refused for want of a plan, with no raw error and no second send", async () => {
    host({ claude: true, chatgpt: false });
    await start(true);
    expectOpen();
    const answered = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input) === "/api/chat" && init?.method === "POST"
        ? Promise.resolve(new Response(JSON.stringify({ error: "no-plan", connect: "/cloud/setup/connect" }), { status: 409, headers: { "content-type": "application/json" } }))
        : answered(input, init),
    );
    box().value = "Hello";
    sendButton().click();
    await settle();
    expect(sends()).toBe(1);
    expectLocked();
    expect(box().value).toBe("Hello");
    expect(pane().querySelector(".chat-hint")!.textContent).toBe("");
    expect(document.body.textContent).not.toContain("no-plan");
    sendButton().click();
    await settle();
    expect(sends()).toBe(1);
  });

  it("goes at a sign-out", async () => {
    host({ claude: false, chatgpt: false });
    await start();
    expect(document.querySelector(".noplan-box")).not.toBeNull();
    (await import("../web/src/state.js")).signedOut("");
    await settle();
    expect(document.querySelector(".gate")).not.toBeNull();
    expect(document.querySelector(".noplan-box")).toBeNull();
  });
});

describe("the owner's own machine", () => {
  it("shows no box, locks nothing and asks its server for no plans", async () => {
    ownMachine = true;
    await start(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(document.querySelector(".noplan-box, .noplan-line:not([hidden])")).toBeNull();
    const pane = document.querySelector("aside.side")!;
    expect(pane.querySelector<HTMLTextAreaElement>(".chat-text")!.disabled).toBe(false);
    expect(pane.querySelector<HTMLButtonElement>(".chat-send")!.disabled).toBe(false);
    const asked = vi.mocked(fetch).mock.calls.map(([input]) => String(input)).filter((path) => path.startsWith("/cloud/"));
    expect(asked).toEqual(["/cloud/agent"]);
  });
});
