// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HomeResponse, HomeSnapshot } from "../src/shared/home.js";
import { controlWords, HOME_STALE_MS, homeState, tileWords } from "../web/src/home-data.js";
import { endSession } from "../web/src/session.js";
import * as home from "../web/src/views/home-assistant.js";

const NOW = "2026-10-25T02:00:00.000Z";
const ago = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
const LAMP = "0123456789abcdef";
const FAN = "fedcba9876543210";
const READING: HomeSnapshot = {
  at: ago(2),
  haReachable: true,
  tiles: [
    { label: "Reading one", value: "21.5", unit: "units" },
    { label: "Reading two", value: "open", unit: null },
    { label: "Gone quiet", value: null, unit: null },
  ],
  buttons: [
    { id: LAMP, label: "Lamp on" },
    { id: FAN, label: "Fan off" },
  ],
};

let root: HTMLElement;
let answer: HomeResponse;
let post: () => Response;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const text = () => root.textContent ?? "";
const buttons = () => [...root.querySelectorAll<HTMLButtonElement>(".ha-button")];

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  answer = { snapshot: READING, receivedAt: ago(2) };
  post = () => json({ ok: true });
  root = document.createElement("div");
  document.body.replaceChildren(root);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/home/control") && init?.method === "POST") return post();
      if (url.startsWith("/api/home")) return json(answer);
      return json({});
    }),
  );
});

afterEach(() => {
  home.unmount();
  endSession();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const posted = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/home/control").map(([, init]) => JSON.parse(String(init!.body)) as unknown);

describe("the Home page", () => {
  it("draws the user's tiles and buttons, a dash for no reading, and when the bridge checked in", async () => {
    home.mount(root);
    await flush();
    expect([...root.querySelectorAll(".ha-tile")].map((one) => one.textContent)).toEqual(["21.5 unitsReading one", "openReading two", "–Gone quiet"]);
    expect(buttons().map((one) => one.textContent)).toEqual(["Lamp on", "Fan off"]);
    expect(text()).toMatch(/Bridge checked in at (?:[A-Z][a-z]{2} )?\d{1,2}:\d\d[ap]m/);
  });

  it("says how to set it up when the bridge has sent nothing, and draws no tiles", async () => {
    answer = { snapshot: null, receivedAt: null };
    home.mount(root);
    await flush();
    expect(text()).toContain("RIVET_HA_URL");
    expect(text()).toContain("RIVET_HA_TOKEN");
    expect(text()).toContain("~/.rivet-agents/home.json");
    expect(root.querySelector(".ha-tile")).toBeNull();
    expect(root.querySelector(".ha-foot")).toBeNull();
  });

  it("says to fill in home.json when Home Assistant answers and nothing is listed", async () => {
    answer = { snapshot: { at: ago(1), haReachable: true, tiles: [], buttons: [] }, receivedAt: ago(1) };
    home.mount(root);
    await flush();
    expect(text()).toContain("Add tiles and buttons to ~/.rivet-agents/home.json");
  });

  it("sends a tap once as the button's id, with every button held while it waits", async () => {
    let release: (response: Response) => void = () => {};
    post = () => new Promise<Response>((resolve) => (release = resolve)) as unknown as Response;
    home.mount(root);
    await flush();
    buttons()[1]!.click();
    await flush();
    expect(buttons().every((one) => one.disabled)).toBe(true);
    expect(buttons()[1]!.getAttribute("aria-busy")).toBe("true");
    buttons()[0]!.click();
    expect(posted()).toEqual([{ button: FAN }]);
    release(json({ ok: true }));
    await flush();
    expect(buttons().some((one) => one.disabled)).toBe(false);
    expect(root.querySelector(".ha-note")).toBeNull();
  });

  it("says a refusal in plain words", async () => {
    post = () => json({ error: "unknown_button" }, 502);
    home.mount(root);
    await flush();
    buttons()[0]!.click();
    await flush();
    expect(root.querySelector(".ha-note[role=status]")?.textContent).toBe("That button isn't in home.json any more.");
  });

  it("says a press on an offline device changed nothing", async () => {
    post = () => json({ error: "offline" }, 502);
    home.mount(root);
    await flush();
    buttons()[0]!.click();
    await flush();
    expect(root.querySelector(".ha-note[role=status]")?.textContent).toBe("The device is offline, so nothing changed. Check that it has power and is on the network.");
  });

  it("says the bridge is offline once it stops checking in, with no stale tiles or buttons", async () => {
    answer = { snapshot: READING, receivedAt: ago(42) };
    home.mount(root);
    await flush();
    expect(text()).toContain("The bridge is offline.");
    expect(text()).toMatch(/Bridge checked in at /);
    expect(root.querySelector(".ha-tile")).toBeNull();
    expect(buttons()).toEqual([]);
  });

  it("says when the bridge can't reach Home Assistant", async () => {
    answer = { snapshot: { at: ago(1), haReachable: false }, receivedAt: ago(1) };
    home.mount(root);
    await flush();
    expect(text()).toContain("The bridge can't reach Home Assistant.");
    expect(root.querySelector(".ha-tile")).toBeNull();
  });
});

describe("the Home words", () => {
  it("say a reading with its unit, or a dash", () => {
    expect(tileWords({ value: "21.5", unit: "units" })).toBe("21.5 units");
    expect(tileWords({ value: "open", unit: null })).toBe("open");
    expect(tileWords({ value: null, unit: "units" })).toBe("–");
  });

  it("name each state from the response", () => {
    const now = Date.parse(NOW);
    expect(homeState(null, now).state).toBe("not-set-up");
    expect(homeState({ snapshot: null, receivedAt: null }, now).state).toBe("not-set-up");
    expect(homeState({ snapshot: READING, receivedAt: ago(1) }, now).state).toBe("ok");
    expect(homeState({ snapshot: READING, receivedAt: new Date(now - HOME_STALE_MS - 1).toISOString() }, now).state).toBe("offline");
    expect(homeState({ snapshot: { at: ago(1), haReachable: false }, receivedAt: ago(1) }, now).state).toBe("no-ha");
  });

  it("say each code plainly, and a code they don't know as a failed try", () => {
    for (const code of ["bridge_offline", "not_set_up", "unknown_button", "offline", "timeout", "too_many_tries", "busy"]) expect(controlWords(code)).not.toBe(controlWords("home_assistant"));
    expect(controlWords("anything else")).toBe("Home Assistant couldn't do that. Try again.");
  });
});
