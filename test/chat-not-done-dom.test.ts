// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Ask } from "../src/shared/asks.js";
import { PROMISE_KEEPER_ID, type BehaviourRow } from "../src/shared/behaviours.js";
import { resetSession } from "../web/src/state.js";
import { behavioursPanel, loadBehaviours } from "../web/src/views/behaviours.js";
import { chatNotDoneItem, notDone, notDoneList } from "../web/src/views/chat-not-done.js";
import { flash } from "../web/src/views/toast.js";

// No generic on actual(): a scanner the repo runs cannot parse its closing `>()`.
vi.mock("../web/src/views/toast.js", async (actual) => ({ ...((await actual()) as Record<string, unknown>), flash: vi.fn() }));

// The Promise keeper's two screens: Chat's "Anything I asked not done?" list, and its minutes in Settings.

const NOW = Date.parse("2026-11-21T22:00:00.000Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const ask = (id: string, extra: Partial<Ask> = {}): Ask => ({
  id,
  words: `Ask ${id}`,
  who: "owner",
  stage: "building",
  prs: [],
  dueHistory: [],
  timeline: [],
  createdAt: at(-120),
  stageAt: at(-120),
  updatedAt: at(-120),
  version: 1,
  ...extra,
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

let asks: Ask[];
let puts: { url: string; body: unknown }[];
const ROW: BehaviourRow = {
  id: PROMISE_KEEPER_ID,
  group: "Work",
  name: "Promise keeper",
  line: "Puts a time a chat promises on its ask, and asks before it slips",
  scope: "all",
  control: "live",
  value: { on: true, warnMinutes: 15 },
  updatedAt: null,
  chip: "15 min before",
};

beforeEach(() => {
  resetSession();
  vi.mocked(flash).mockClear();
  document.body.replaceChildren();
  asks = [];
  puts = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (init.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      puts.push({ url, body });
      return json({ ...ROW, value: body, updatedAt: "2026-11-22T00:00:00.000Z" });
    }
    if (url === "/api/asks") return json({ asks });
    if (url === "/api/behaviours") return json({ behaviours: [ROW] });
    return json({ error: "not found" }, 404);
  });
});

describe("Anything I asked not done?", () => {
  it("lists his open asks late first, then by time, then those with no time, newest first", () => {
    const rows = notDone(
      [
        ask("no-time-old", { createdAt: at(-300) }),
        ask("due-later", { dueAt: at(90) }),
        ask("late-long", { dueAt: at(-60) }),
        ask("finished", { stage: "done", dueAt: at(-90) }),
        ask("theirs", { who: "rivet", dueAt: at(-30) }),
        ask("no-time-new", { createdAt: at(-10) }),
        ask("late-just", { dueAt: at(-5) }),
      ],
      NOW,
    );
    expect(rows.map((row) => row.id)).toEqual(["late-long", "late-just", "due-later", "no-time-new", "no-time-old"]);
    expect(rows.map((row) => row.late)).toEqual([true, true, false, false, false]);
    expect(rows[0]!.time).toMatch(/^Late: due /);
    expect(rows[2]!.time).toMatch(/^Due /);
    expect(rows[3]!.time).toBe("No time yet");
  });

  it("does not call late an ask waiting on him", () => {
    const rows = notDone([ask("waits", { stage: "needs-you", dueAt: at(-90) }), ask("late", { dueAt: at(-60) })], NOW);
    // The late one first, though the one waiting on him was due earlier.
    expect(rows.map((row) => [row.id, row.late])).toEqual([["late", true], ["waits", false]]);
    expect(rows[1]!.time).toMatch(/^Due /);
  });

  it("titles a row by the ask's short line, else its first line, clipped", () => {
    const rows = notDone([ask("a", { short: "Cards count" }), ask("b", { words: `\n${"x".repeat(200)}\nmore` })], NOW);
    expect(rows.find((row) => row.id === "a")?.title).toBe("Cards count");
    const long = rows.find((row) => row.id === "b")!.title;
    expect(Array.from(long)).toHaveLength(90);
    expect(long.endsWith("…")).toBe(true);
  });

  it("says nothing is left when every ask is done", () => {
    expect(notDoneList([]).textContent).toBe("Nothing. Everything you asked is done.");
  });

  it("opens a sheet from Chat's options with the count, the late count and each row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    asks = [ask("late", { dueAt: at(-5), short: "Late one" }), ask("soon", { dueAt: at(30), short: "Soon one" })];
    const picked = vi.fn();
    const item = chatNotDoneItem(picked, () => {});
    document.body.append(item);
    expect(item.getAttribute("role")).toBe("menuitem");
    expect(item.dataset.use).toBe("chat.not-done");
    item.click();
    expect(picked).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(document.querySelector(".chat-not-done")).not.toBeNull());
    expect(document.body.textContent).toContain("2 not done");
    expect(document.body.textContent).not.toContain("1 late");
    const rows = [...document.querySelectorAll<HTMLElement>(".chat-not-done-row")];
    expect(rows.map((row) => row.dataset.ask)).toEqual(["late", "soon"]);
    expect(rows[0]!.classList.contains("is-late")).toBe(true);
    expect(rows[0]!.querySelector(".chat-not-done-title")?.textContent).toBe("Late one");
    vi.useRealTimers();
  });
});

describe("the Promise keeper's minutes in Settings", () => {
  it("picks the minutes before, saved with the switch's value", async () => {
    await loadBehaviours();
    const panel = behavioursPanel(() => {});
    document.body.replaceChildren(panel);
    const select = panel.querySelector<HTMLSelectElement>(`.bhv-row[data-id="${PROMISE_KEEPER_ID}"] select.bhv-chip`)!;
    expect([...select.options].map((option) => option.textContent)).toEqual(["5 min before", "10 min before", "15 min before", "30 min before", "60 min before"]);
    expect(select.value).toBe("15");
    select.value = "30";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ url: `/api/behaviours/${PROMISE_KEEPER_ID}`, body: { on: true, warnMinutes: 30 } });
  });
});
