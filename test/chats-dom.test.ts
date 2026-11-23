// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BEHAVIOURS, type BehaviourRow } from "../src/shared/behaviours.js";
import { CHATS_ID, CHATS_STALE_MS, DEFAULT_CHATS } from "../src/shared/chats.js";
import { app, refresh, resetSession } from "../web/src/state.js";
import { behavioursPanel, loadBehaviours } from "../web/src/views/behaviours.js";
import { mountDesks } from "../web/src/views/desks.js";

vi.mock("../web/src/views/toast.js", async (actual) => ({ ...((await actual()) as Record<string, unknown>), flash: vi.fn() }));

// Chats run themselves in Settings › Behaviours (its switch is the close knob, its selects numbers that stay settable
// with closing off) and its count on Progress.

const { knobs: _knobs, default: _default, chip: _chip, ...entry } = BEHAVIOURS.find((one) => one.id === CHATS_ID)!;
const chatsRow = (value = DEFAULT_CHATS): BehaviourRow => ({
  ...entry,
  value,
  chip: "3 chats open · cap 10",
  updatedAt: null,
  report: { note: "Last pass: 2 closed, 1 kept", detail: null },
});

let listed: BehaviourRow[];
let puts: { url: string; body: unknown }[];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  resetSession();
  listed = [chatsRow()];
  puts = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (init.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      puts.push({ url, body });
      return json({ ...listed[0], value: body });
    }
    if (url === "/api/behaviours") return json({ behaviours: listed });
    return json({ error: "not found" }, 404);
  });
});

async function row(): Promise<HTMLElement> {
  await loadBehaviours();
  document.body.replaceChildren(behavioursPanel(() => {}));
  return document.querySelector<HTMLElement>(`.bhv-row[data-id="${CHATS_ID}"]`)!;
}

describe("the Chats row in Settings › Behaviours", () => {
  it("shows the count as its chip, the last pass under its line, and its three selects", async () => {
    const shown = await row();
    expect(shown.querySelector(".bhv-side .bhv-chip")?.textContent).toBe("3 chats open · cap 10");
    expect(shown.querySelector(".bhv-state")?.textContent).toBe("Last pass: 2 closed, 1 kept");
    expect([...shown.querySelectorAll(".bhv-knob-label")].map((label) => label.textContent)).toEqual(["Chat cap", "Pull backlog after idle", "Small issues each night"]);
    expect(shown.querySelector<HTMLSelectElement>('[data-knob="cap"] select')!.value).toBe("10");
    expect(shown.querySelector<HTMLSelectElement>('[data-knob="nightly"] select')!.options[0]!.textContent).toBe("Off");
  });

  it("saves its switch to the close knob", async () => {
    const toggle = (await row()).querySelector<HTMLInputElement>(".bhv-switch")!;
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(puts).toEqual([{ url: `/api/behaviours/${CHATS_ID}`, body: { ...DEFAULT_CHATS, close: false } }]));
  });

  it("saves a select's pick as a number", async () => {
    const idle = (await row()).querySelector<HTMLSelectElement>('[data-knob="idleMinutes"] select')!;
    idle.value = "45";
    idle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(puts).toEqual([{ url: `/api/behaviours/${CHATS_ID}`, body: { ...DEFAULT_CHATS, idleMinutes: 45 } }]));
  });

  it("keeps its selects settable with closing off", async () => {
    listed = [chatsRow({ ...DEFAULT_CHATS, close: false })];
    const shown = await row();
    expect(shown.querySelector<HTMLInputElement>(".bhv-switch")!.checked).toBe(false);
    const selects = [...shown.querySelectorAll<HTMLSelectElement>(".bhv-knob select")];
    expect(selects).toHaveLength(3);
    expect(selects.every((select) => !select.disabled)).toBe(true);
    selects[2]!.value = "0";
    selects[2]!.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(puts).toEqual([{ url: `/api/behaviours/${CHATS_ID}`, body: { ...DEFAULT_CHATS, close: false, nightly: 0 } }]));
  });
});

describe("the chats count on Progress", () => {
  const line = () => {
    const desks = mountDesks();
    const text = desks.el.querySelector("[data-chats]")?.textContent ?? null;
    desks.stop();
    return text;
  };

  it("shows the count, or can't tell, and nothing before the first read", () => {
    expect(line()).toBeNull();
    app.chatsLine = "3 chats open · cap 10";
    expect(line()).toBe("3 chats open · cap 10");
    app.chatsLine = "Can't tell";
    expect(line()).toBe("Can't tell");
  });

  /** refresh()'s reads: the board waits on `boardGate`; /api/chats answers `chats()`, or fails when that is null. */
  const stubReads = (chats: () => Response | null, boardGate: Promise<void> = Promise.resolve()) =>
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/board") {
        await boardGate;
        const board = { updatedAt: "2026-11-22T00:00:00.000Z", needs: [], coming: [], chats: [], shipped: [] };
        return json({ version: 1, updatedAt: board.updatedAt, board });
      }
      if (url === "/api/status") return json({ board: { version: 1, updatedAt: null }, bridge: { connected: true, lastSeenAt: null } });
      if (url.startsWith("/api/replies")) return json({ replies: [] });
      if (url === "/api/chats") return chats() ?? json({ error: "down" }, 503);
      return json({ error: "not found" }, 404);
    });

  it("can't tell from a count with no time left on it", async () => {
    for (const leftMs of [null, 0, -5]) {
      resetSession();
      stubReads(() => json({ line: "3 chats open · cap 10", leftMs }));
      expect(await refresh()).toBe(true);
      expect(line()).toBe("Can't tell");
    }
  });

  it("times the count as its own read lands, not as a slower read beside it does", async () => {
    let open = () => {};
    stubReads(() => json({ line: "3 chats open · cap 10", leftMs: 60_000 }), new Promise<void>((done) => (open = done)));
    const readAt = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(readAt);
    const reading = refresh();
    await new Promise((done) => setTimeout(done, 50));
    vi.spyOn(Date, "now").mockReturnValue(readAt + 30_000);
    open();
    expect(await reading).toBe(true);
    expect(app.chatsLineUntil).toBe(readAt + 60_000);
    vi.restoreAllMocks();
  });

  it("goes back to can't tell when the server would stop keeping its report, and a failed read never extends it", async () => {
    let chats: Response | null = json({ line: "3 chats open · cap 10", leftMs: CHATS_STALE_MS - 9 * 60_000 });
    stubReads(() => chats);
    const readAt = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(readAt);
    expect(await refresh()).toBe(true);
    expect(line()).toBe("3 chats open · cap 10");
    chats = null;
    vi.spyOn(Date, "now").mockReturnValue(readAt + 30_000);
    await refresh();
    vi.spyOn(Date, "now").mockReturnValue(readAt + 60_000);
    await refresh();
    expect(line()).toBe("3 chats open · cap 10");
    vi.spyOn(Date, "now").mockReturnValue(readAt + 60_000 + 1_000);
    expect(line()).toBe("Can't tell");
    vi.restoreAllMocks();
    resetSession();
    expect(app.chatsLineUntil).toBeNull();
  });
});
