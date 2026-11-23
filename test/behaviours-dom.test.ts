// @vitest-environment happy-dom
import fs from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { type BehaviourRow, cardCheckerBehaviour } from "../src/shared/behaviours.js";
import { CARD_CHECKER_ID, DEFAULT_CARD_CHECKER } from "../src/shared/card-check.js";
import { changed, resetSession } from "../web/src/state.js";
import { behavioursPanel, LATE_READ_MS, loadBehaviours, REREAD_MS } from "../web/src/views/behaviours.js";
import { loadChatPrefs } from "../web/src/views/chat-prefs.js";
import { mount, openTab, unmount } from "../web/src/views/settings.js";
import { chatReplyStylePicker, readChatReplyStyle } from "../web/src/views/chat-reply-style.js";
import { chatTextSizePicker } from "../web/src/views/chat-text-size.js";
import { flash } from "../web/src/views/toast.js";

// No generic on actual(): a scanner the repo runs cannot parse its closing `>()`.
vi.mock("../web/src/views/toast.js", async (actual) => ({ ...((await actual()) as Record<string, unknown>), flash: vi.fn() }));
vi.mock("../web/src/state.js", async (actual) => {
  const real = (await actual()) as typeof import("../web/src/state.js");
  return { ...real, changed: vi.fn(real.changed) };
});

// Settings › Behaviours against a fake server: rows grouped in order, the send delay shown only where its route answers,
// and each switch saving to its own route.

const base = { scope: "all", updatedAt: null, chip: null } as const;
const ROWS: BehaviourRow[] = [
  { ...base, id: "alerts.quiet-hours", group: "Alerts", name: "Quiet hours", line: "Holds pushes overnight", control: "linked", link: "quiet", value: {} },
  { ...base, id: "chat.send-delay", group: "Chat", name: "Send delay", line: "Seconds to cancel", control: "endpoint", endpoint: "/api/settings/chat-send-delay", value: null },
  { ...base, id: "work.live", group: "Work", name: "A live switch", line: "Stored here", control: "live", value: { on: true } },
  { ...base, id: CARD_CHECKER_ID, group: "Work", name: "Card checker", line: "Checks every card", control: "live", value: { ...DEFAULT_CARD_CHECKER }, selects: cardCheckerBehaviour.selects },
  {
    ...base,
    id: "reader.github",
    group: "Ops",
    name: "GitHub reading",
    line: "PRs and CI runs",
    control: "live",
    value: { on: true, fresh: 15 },
    chip: "fresh 15 min",
    choices: { key: "fresh", switch: true, label: "GitHub reading freshness", options: [{ value: 15, label: "fresh 15 min" }, { value: 30, label: "fresh 30 min" }] },
  },
  { ...base, id: "work.mine", group: "Work", name: "Mine", line: "The owner's", scope: "private", control: "always-on", value: { on: true } },
  { ...base, id: "ops.reds", group: "Ops", name: "Pick up reds", line: "A fix job", control: "always-on", value: { on: true } },
  { ...base, id: "own.pings", group: "Yours only", name: "Pings", line: "A push", scope: "private", control: "always-on", value: { on: true } },
];

const SWITCHES: BehaviourRow[] = [
  { ...base, id: "work.free", group: "Work", name: "Free", line: "A file", scope: "private", control: "switch", value: { on: true }, switch: { state: "absent" } },
  { ...base, id: "work.held", group: "Work", name: "Held", line: "A file", scope: "private", control: "switch", value: { on: false }, switch: { state: "other", line: "held for the release" } },
  { ...base, id: "work.away", group: "Work", name: "Away", line: "A file", scope: "private", control: "switch", value: { on: false }, switch: { state: "offline" } },
];

let listed: BehaviourRow[];
let lists: number;
let putAnswer: ((row: BehaviourRow, body: Record<string, unknown>) => Response | Promise<Response>) | null;
let delayStatus: number;
let listStatus: number;
let listGate: Promise<void> | null;
let puts: { url: string; body: unknown }[];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  resetSession();
  vi.mocked(flash).mockClear();
  listed = ROWS;
  lists = 0;
  putAnswer = null;
  delayStatus = 200;
  listStatus = 200;
  listGate = null;
  puts = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (init.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      puts.push({ url, body });
      if (url === "/api/settings/chat-send-delay") return delayStatus === 200 ? json(body) : json({ error: "busy" }, delayStatus);
      const row = listed.find((each) => url === `/api/behaviours/${each.id}`)!;
      if (putAnswer) return putAnswer(row, body);
      return json({ ...row, value: body, updatedAt: "2026-11-22T00:00:00.000Z" });
    }
    if (url === "/api/behaviours") {
      lists += 1;
      // The list as it stood when asked, answered once the gate opens.
      const [behaviours, status, gate] = [listed, listStatus, listGate];
      listGate = null;
      await gate;
      return status === 200 ? json({ behaviours }) : json({ error: "busy" }, status);
    }
    if (url === "/api/settings/chat-send-delay") return delayStatus === 200 ? json({ on: true, seconds: 10 }) : json({ error: "not found" }, delayStatus);
    return json({ error: "not found" }, 404);
  });
});

async function shown(open: (section: string) => void = () => {}): Promise<HTMLElement> {
  await loadBehaviours();
  const panel = behavioursPanel(open);
  document.body.replaceChildren(panel);
  return panel;
}

const row = (panel: HTMLElement, id: string) => panel.querySelector<HTMLElement>(`.bhv-row[data-id="${id}"]`);

describe("Settings › Behaviours", () => {
  it("groups rows in the tab's order, with the owner's own group last", async () => {
    const panel = await shown();
    expect([...panel.querySelectorAll(".bhv-group")].map((heading) => heading.textContent)).toEqual(["Chat", "Work", "Ops", "Alerts", "Yours only"]);
    expect([...panel.querySelectorAll<HTMLElement>('[data-group="Work"] .bhv-row')].map((item) => item.dataset.id)).toEqual(["work.live", CARD_CHECKER_ID, "work.mine"]);
  });

  it("puts a report row's group at the top, showing its words and no control", async () => {
    const report = { note: "The summary", detail: "The detail under it" };
    listed = [...ROWS, { ...base, id: "versions.report", group: "Versions", name: "A report", line: "Reported", control: "report", value: null, report }];
    const panel = await shown();
    expect(panel.querySelector(".bhv-group")!.textContent).toBe("Versions");
    const sync = row(panel, "versions.report")!;
    expect([...sync.querySelectorAll(".bhv-state")].map((line) => line.textContent)).toEqual([report.note, report.detail]);
    expect(sync.querySelector(".bhv-side")!.children).toHaveLength(0);
  });

  it("tags a private row outside the owner's group, and no row inside it", async () => {
    const panel = await shown();
    expect(row(panel, "work.mine")?.querySelector(".bhv-tag")?.textContent).toBe("Yours only");
    expect(row(panel, "own.pings")?.querySelector(".bhv-tag")).toBeNull();
    expect(row(panel, "ops.reds")?.querySelector(".bhv-tag")).toBeNull();
  });

  it("shows an always-on row's switch on and disabled", async () => {
    const panel = await shown();
    const toggle = row(panel, "ops.reds")!.querySelector<HTMLInputElement>(".bhv-switch")!;
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
    expect(row(panel, "ops.reds")!.textContent).toContain("always on");
  });

  it("hides the send delay while its route answers 404", async () => {
    delayStatus = 404;
    const panel = await shown();
    expect(row(panel, "chat.send-delay")).toBeNull();
    expect([...panel.querySelectorAll(".bhv-group")].map((heading) => heading.textContent)).not.toContain("Chat");
  });

  it("shows the send delay as not loaded when its route fails another way", async () => {
    delayStatus = 500;
    const panel = await shown();
    const delay = row(panel, "chat.send-delay")!;
    expect(delay.textContent).toContain("Couldn't load");
    expect(delay.querySelector("input")).toBeNull();
  });

  it("shows the send delay with its seconds where its route answers, and saves a change there", async () => {
    const panel = await shown();
    const delay = row(panel, "chat.send-delay")!;
    const seconds = delay.querySelector<HTMLSelectElement>("select.bhv-chip")!;
    expect(seconds.value).toBe("10");
    seconds.value = "5";
    seconds.dispatchEvent(new Event("change"));
    const toggle = delay.querySelector<HTMLInputElement>(".bhv-switch")!;
    expect(toggle.checked).toBe(true);
    await vi.waitFor(() => expect(puts).toEqual([{ url: "/api/settings/chat-send-delay", body: { on: true, seconds: 5 } }]));
  });

  it("saves a live switch to its row's route", async () => {
    const panel = await shown();
    const toggle = row(panel, "work.live")!.querySelector<HTMLInputElement>(".bhv-switch")!;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(puts).toEqual([{ url: "/api/behaviours/work.live", body: { on: false } }]));
    await vi.waitFor(() => expect(flash).toHaveBeenCalledWith("Saved."));
  });

  it("shows a row's choices as a select in place of its chip, and saves the pick beside its switch", async () => {
    const panel = await shown();
    const reader = row(panel, "reader.github")!;
    expect(reader.querySelectorAll(".bhv-chip").length).toBe(1);
    const fresh = reader.querySelector<HTMLSelectElement>("select.bhv-chip")!;
    expect(fresh.getAttribute("aria-label")).toBe("GitHub reading freshness");
    expect([...fresh.options].map((option) => option.textContent)).toEqual(["fresh 15 min", "fresh 30 min"]);
    expect(fresh.value).toBe("15");
    fresh.value = "30";
    fresh.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(puts).toEqual([{ url: "/api/behaviours/reader.github", body: { on: true, fresh: 30 } }]));
  });

  it("shows the card checker's rules under its switch, each saving the whole value", async () => {
    const panel = await shown();
    const checker = row(panel, CARD_CHECKER_ID)!;
    const knobs = [...checker.querySelectorAll<HTMLElement>(".bhv-knob")];
    expect(knobs.map((knob) => knob.querySelector(".bhv-knob-label")?.textContent)).toEqual([
      "Heading and 3 bullets",
      "Every option pictured",
      "Stills 1600 px or less",
      "Videos at the card size",
      "Private links by email",
      "Thick coloured edge",
    ]);
    const options = checker.querySelector<HTMLSelectElement>('[data-knob="options"] select')!;
    expect(options.value).toBe("block");
    expect([...options.options].map((option) => option.textContent)).toEqual(["Block", "Warn"]);
    const edge = checker.querySelector('[data-knob="edge"]')!;
    expect(edge.querySelector("select")).toBeNull();
    expect(edge.querySelector(".bhv-note")?.textContent).toBe("Warn only");
    options.value = "warn";
    options.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(puts).toEqual([{ url: `/api/behaviours/${CARD_CHECKER_ID}`, body: { ...DEFAULT_CARD_CHECKER, options: "warn" } }]));
  });

  it("disables the card checker's rules while it is off", async () => {
    const panel = await shown();
    const toggle = row(panel, CARD_CHECKER_ID)!.querySelector<HTMLInputElement>(".bhv-switch")!;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(puts).toEqual([{ url: `/api/behaviours/${CARD_CHECKER_ID}`, body: { ...DEFAULT_CARD_CHECKER, on: false } }]));
    await vi.waitFor(() => expect(flash).toHaveBeenCalledWith("Saved."));
    const selects = [...row(behavioursPanel(() => {}), CARD_CHECKER_ID)!.querySelectorAll<HTMLSelectElement>(".bhv-knob select")];
    expect(selects).toHaveLength(5);
    expect(selects.every((select) => select.disabled)).toBe(true);
  });

  it("opens a linked row's section", async () => {
    const open = vi.fn();
    const panel = await shown(open);
    row(panel, "alerts.quiet-hours")!.querySelector<HTMLButtonElement>("button")!.click();
    expect(open).toHaveBeenCalledWith("quiet");
  });
});

describe("Settings › Behaviours file switches", () => {
  beforeEach(() => {
    listed = SWITCHES;
  });

  const toggleOf = (panel: HTMLElement, id: string) => row(panel, id)!.querySelector<HTMLInputElement>(".bhv-switch")!;
  const stateOf = (panel: HTMLElement, id: string) => row(panel, id)!.querySelector(".bhv-state")?.textContent ?? null;

  it("shows a file it didn't write as paused by its first line, with the switch off and disabled", async () => {
    const panel = await shown();
    expect(stateOf(panel, "work.held")).toBe("Paused: held for the release");
    expect(toggleOf(panel, "work.held").checked).toBe(false);
    expect(toggleOf(panel, "work.held").disabled).toBe(true);
  });

  it("shows a switch with no Mac report as not connected and disabled", async () => {
    const panel = await shown();
    expect(stateOf(panel, "work.away")).toBe("Mac not connected");
    expect(toggleOf(panel, "work.away").disabled).toBe(true);
  });

  it("shows every switch stopped while the alarm's stop is on", async () => {
    listed = SWITCHES.map((each) => ({ ...each, value: { on: false }, switch: { state: "stopped" } }));
    const panel = await shown();
    for (const each of SWITCHES) {
      expect(stateOf(panel, each.id)).toBe("Stopped by the alarm");
      expect(toggleOf(panel, each.id).disabled).toBe(true);
    }
  });

  it("leaves a free switch enabled with no state line, and toasts what the Mac did", async () => {
    putAnswer = (each, body) => json({ ...each, value: body, switch: { state: "ours" }, done: "paused" });
    const panel = await shown();
    expect(stateOf(panel, "work.free")).toBeNull();
    const toggle = toggleOf(panel, "work.free");
    expect(toggle.disabled).toBe(false);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(flash).toHaveBeenCalledWith("Free is paused."));
    expect(puts).toEqual([{ url: "/api/behaviours/work.free", body: { on: false } }]);
  });

  it("toasts the Mac's pause though the file reads stopped by the time it answers", async () => {
    putAnswer = (each, body) => json({ ...each, value: body, switch: { state: "stopped" }, done: "paused" });
    const panel = await shown();
    const toggle = toggleOf(panel, "work.free");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(flash).toHaveBeenCalledWith("Free is paused."));
    document.body.replaceChildren(behavioursPanel(() => {}));
    expect(stateOf(document.body, "work.free")).toBe("Stopped by the alarm");
  });

  it("says both when a STOP landed as the pause was written", async () => {
    putAnswer = (each, body) => json({ ...each, value: body, switch: { state: "stopped" }, done: "paused-then-stopped" });
    const panel = await shown();
    const toggle = toggleOf(panel, "work.free");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(flash).toHaveBeenCalledWith("Paused. The alarm stopped work too."));
  });

  it("names the other words when the Mac found the switch already paused by them", async () => {
    putAnswer = (each, body) => json({ ...each, value: body, switch: { state: "other", line: "held by hand" }, done: "already-paused" });
    const panel = await shown();
    const toggle = toggleOf(panel, "work.free");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(flash).toHaveBeenCalledWith("Free was already paused by other words: held by hand"));
  });

  const stoppedFree = () => SWITCHES.map((each) => (each.id === "work.free" ? { ...each, switch: { state: "stopped" as const } } : each));
  const gated = () => {
    let open!: () => void;
    listGate = new Promise((resolve) => (open = resolve));
    return () => open();
  };

  it("drops a load's answer once a later load has landed", async () => {
    await shown();
    const open = gated();
    const stale = loadBehaviours();
    listed = stoppedFree();
    await loadBehaviours();
    open();
    await stale;
    expect(stateOf(behavioursPanel(() => {}), "work.free")).toBe("Stopped by the alarm");
  });

  it("drops a load's answer once a save has answered after it began", async () => {
    putAnswer = (each, body) => json({ ...each, value: body, switch: { state: "ours" }, done: "paused" });
    const panel = await shown();
    const open = gated();
    const stale = loadBehaviours();
    const toggle = toggleOf(panel, "work.free");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(flash).toHaveBeenCalledWith("Free is paused."));
    open();
    await stale;
    expect(toggleOf(behavioursPanel(() => {}), "work.free").checked).toBe(false);
  });

  it("reads a refused switch again rather than setting it back to the row the tap found", async () => {
    let answer!: (response: Response) => void;
    putAnswer = () => new Promise((resolve) => (answer = resolve));
    const panel = await shown();
    const toggle = toggleOf(panel, "work.free");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    listed = stoppedFree();
    await loadBehaviours();
    listStatus = 503;
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    answer(json({ error: "Stopped by the alarm. Nothing changed." }, 409));
    await vi.waitFor(() => expect(lists).toBe(3));
    await vi.waitFor(() => expect(behavioursPanel(() => {}).textContent).toMatch(/Couldn't load/));
    expect(stateOf(behavioursPanel(() => {}), "work.free")).toBe("Stopped by the alarm");
  });

  /** Runs `fn` with the half-minute timer faked and the page visible. */
  async function onTimer(fn: () => Promise<void>): Promise<void> {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    try {
      await fn();
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
      vi.useRealTimers();
    }
  }

  it("holds the timed re-read while a save waits", () =>
    onTimer(async () => {
      let answer!: (response: Response) => void;
      putAnswer = () => new Promise((resolve) => (answer = resolve));
      const panel = await shown();
      const toggle = toggleOf(panel, "work.free");
      toggle.checked = false;
      toggle.dispatchEvent(new Event("change"));
      vi.advanceTimersByTime(REREAD_MS);
      await Promise.resolve();
      expect(lists).toBe(1);
      await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
      answer(json({ ...SWITCHES[0], value: { on: false }, switch: { state: "ours" }, done: "paused" }));
      await vi.waitFor(() => expect(flash).toHaveBeenCalledWith("Free is paused."));
      vi.advanceTimersByTime(REREAD_MS);
      await vi.waitFor(() => expect(lists).toBe(2));
    }));

  it("reads on the timer with a control in hand, and redraws only once it lets go", () =>
    onTimer(async () => {
      const panel = await shown();
      const toggle = toggleOf(panel, "work.free");
      toggle.focus();
      expect(document.activeElement).toBe(toggle);
      listed = SWITCHES.map((each) => (each.id === "work.free" ? { ...each, value: { on: false }, switch: { state: "ours" as const } } : each));
      vi.mocked(changed).mockClear();
      vi.advanceTimersByTime(REREAD_MS);
      await vi.waitFor(() => expect(toggleOf(behavioursPanel(() => {}), "work.free").checked).toBe(false));
      expect(lists).toBe(2);
      expect(changed).not.toHaveBeenCalled();
      vi.advanceTimersByTime(REREAD_MS);
      await vi.waitFor(() => expect(lists).toBe(3));
      toggle.blur();
      expect(changed).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    }));

  it("in mounted Settings, a tap that takes focus from a held select after a timed read lands its switch", () =>
    onTimer(async () => {
      listed = [...ROWS, ...SWITCHES];
      const el = document.createElement("div");
      document.body.replaceChildren(el);
      mount(el);
      try {
        openTab("behaviours");
        await vi.waitFor(() => expect(el.querySelector('select.bhv-chip')).not.toBeNull());
        await new Promise((resolve) => setTimeout(resolve, 20));
        el.querySelector<HTMLSelectElement>("select.bhv-chip")!.focus();
        listed = [...ROWS, ...SWITCHES.map((each) => (each.id === "work.held" ? { ...each, switch: { state: "other" as const, line: "held longer" } } : each))];
        vi.advanceTimersByTime(REREAD_MS);
        await vi.waitFor(() => expect(lists).toBe(2));
        await new Promise((resolve) => setTimeout(resolve, 0));
        // A press moves focus first and clicks on release: a click lands only on the switch still on the page.
        const pressed = toggleOf(el, "work.free");
        pressed.focus();
        if (pressed.isConnected) pressed.click();
        await vi.waitFor(() => expect(puts).toEqual([{ url: "/api/behaviours/work.free", body: { on: false } }]));
        await vi.waitFor(() => expect(stateOf(el, "work.held")).toBe("Paused: held longer"));
      } finally {
        unmount();
      }
    }));

  it("in mounted Settings, a press held past the click window still lands its switch on release", () =>
    onTimer(async () => {
      listed = [...ROWS, ...SWITCHES];
      const el = document.createElement("div");
      document.body.replaceChildren(el);
      mount(el);
      try {
        openTab("behaviours");
        await vi.waitFor(() => expect(el.querySelector('select.bhv-chip')).not.toBeNull());
        await new Promise((resolve) => setTimeout(resolve, 20));
        el.querySelector<HTMLSelectElement>("select.bhv-chip")!.focus();
        listed = [...ROWS, ...SWITCHES.map((each) => (each.id === "work.held" ? { ...each, switch: { state: "other" as const, line: "held longer" } } : each))];
        vi.advanceTimersByTime(REREAD_MS);
        await vi.waitFor(() => expect(lists).toBe(2));
        await new Promise((resolve) => setTimeout(resolve, 0));
        const pressed = toggleOf(el, "work.free");
        pressed.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        pressed.focus();
        await new Promise((resolve) => setTimeout(resolve, 500));
        pressed.dispatchEvent(new Event("pointerup", { bubbles: true }));
        if (pressed.isConnected) pressed.click();
        await vi.waitFor(() => expect(puts).toEqual([{ url: "/api/behaviours/work.free", body: { on: false } }]));
        await vi.waitFor(() => expect(stateOf(el, "work.held")).toBe("Paused: held longer"));
      } finally {
        unmount();
      }
    }));

  it("redraws at once, control in hand or not, when a switch meets a STOP", () =>
    onTimer(async () => {
      const panel = await shown();
      toggleOf(panel, "work.free").focus();
      listed = stoppedFree();
      vi.mocked(changed).mockClear();
      vi.advanceTimersByTime(REREAD_MS);
      await vi.waitFor(() => expect(changed).toHaveBeenCalled());
      expect(stateOf(behavioursPanel(() => {}), "work.free")).toMatch(/^Stopped by/);
    }));

  it("keeps the reported state, disabled, while a tap waits for the Mac", async () => {
    let answer!: (response: Response) => void;
    putAnswer = () => new Promise((resolve) => (answer = resolve));
    const panel = await shown();
    const toggle = toggleOf(panel, "work.free");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    const pending = behavioursPanel(() => {});
    document.body.replaceChildren(pending);
    expect(toggleOf(pending, "work.free").checked).toBe(true);
    expect(toggleOf(pending, "work.free").disabled).toBe(true);
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    answer(json({ ...SWITCHES[0], value: { on: false }, switch: { state: "ours" }, done: "paused" }));
    await vi.waitFor(() => expect(flash).toHaveBeenCalledWith("Free is paused."));
    const after = behavioursPanel(() => {});
    expect(toggleOf(after, "work.free").checked).toBe(false);
    expect(toggleOf(after, "work.free").disabled).toBe(false);
  });

  it("puts every switch inside a label that is at least a finger's width each way", async () => {
    const panel = await shown();
    for (const each of SWITCHES) {
      const hit = toggleOf(panel, each.id).parentElement!;
      expect(hit.tagName).toBe("LABEL");
      expect(hit.className).toBe("bhv-hit");
    }
    const css = fs.readFileSync("web/src/views/behaviours.css", "utf8");
    const rule = /\.bhv-hit \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/min-width: var\(--tap\);/);
    expect(rule).toMatch(/min-height: var\(--tap\);/);
  });

  it("on a timed-out tap says it may have gone through, and reads the rows again a few seconds later", async () => {
    putAnswer = () => json({ error: "The Mac didn't answer in time." }, 504);
    const panel = await shown();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const toggle = toggleOf(panel, "work.free");
      toggle.checked = false;
      toggle.dispatchEvent(new Event("change"));
      await vi.waitFor(() => expect(flash).toHaveBeenCalledWith("The Mac didn't answer in time. It may have gone through.", "error"));
      expect(lists).toBe(1);
      vi.advanceTimersByTime(LATE_READ_MS);
      await vi.waitFor(() => expect(lists).toBe(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it("toasts a refusal and reads the rows again", async () => {
    putAnswer = () => json({ error: "Stopped by the alarm. Nothing changed." }, 409);
    const panel = await shown();
    const toggle = toggleOf(panel, "work.free");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(flash).toHaveBeenCalledWith("Stopped by the alarm. Nothing changed.", "error"));
    await vi.waitFor(() => expect(lists).toBe(2));
  });
});

describe("Settings › Behaviours after a failed load or save", () => {
  it("reads the server again after a live row's save fails", async () => {
    putAnswer = () => json({ error: "busy" }, 503);
    const panel = await shown();
    const toggle = row(panel, "work.live")!.querySelector<HTMLInputElement>(".bhv-switch")!;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(lists).toBe(2));
  });

  it("reads the server again after the send delay's save fails", async () => {
    const panel = await shown();
    delayStatus = 503;
    const seconds = row(panel, "chat.send-delay")!.querySelector<HTMLSelectElement>("select.bhv-chip")!;
    seconds.value = "5";
    seconds.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(lists).toBe(2));
  });

  it("offers a retry when the send delay didn't load, which loads it", async () => {
    delayStatus = 500;
    const panel = await shown();
    delayStatus = 200;
    row(panel, "chat.send-delay")!.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => {
      document.body.replaceChildren(behavioursPanel(() => {}));
      expect(document.querySelector<HTMLSelectElement>('.bhv-row[data-id="chat.send-delay"] select.bhv-chip')?.value).toBe("10");
    });
    expect(lists).toBe(2);
  });

  it("keeps rows from an earlier read under a failed reload's notice, whose retry loads them", async () => {
    await shown();
    listStatus = 503;
    await loadBehaviours();
    const panel = behavioursPanel(() => {});
    document.body.replaceChildren(panel);
    expect(panel.firstElementChild?.textContent).toMatch(/^Couldn't load behaviours\. These may be out of date\.Try again$/);
    expect(row(panel, "work.live")).not.toBeNull();
    listStatus = 200;
    panel.querySelector<HTMLButtonElement>('[data-use="settings.behaviours.retry"]')!.click();
    await vi.waitFor(() => expect(lists).toBe(3));
    await vi.waitFor(() => expect(behavioursPanel(() => {}).textContent).not.toMatch(/Couldn't load/));
  });

  it("reads the rows again every half minute while the tab is on screen, and stops once it is gone", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    try {
      await shown();
      expect(lists).toBe(1);
      vi.advanceTimersByTime(REREAD_MS);
      await vi.waitFor(() => expect(lists).toBe(2));
      document.body.replaceChildren();
      vi.advanceTimersByTime(REREAD_MS * 3);
      expect(lists).toBe(2);
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
      vi.useRealTimers();
    }
  });
});

describe("reply style and text size in the store", () => {
  const PREFS: BehaviourRow[] = [
    { ...base, id: "chat.reply-style", group: "Chat", name: "Reply style", line: "How long", control: "live", value: { style: "normal" }, choices: { key: "style", options: [{ value: "short", label: "Short" }, { value: "normal", label: "Normal" }, { value: "detailed", label: "Detailed" }] } },
    { ...base, id: "chat.text-size", group: "Chat", name: "Text size", line: "How big", control: "live", value: { size: "m" }, choices: { key: "size", options: [{ value: "s", label: "Small" }, { value: "m", label: "Medium" }, { value: "l", label: "Large" }] } },
  ];

  beforeEach(() => {
    localStorage.clear();
    listed = PREFS;
  });

  it("keeps a pick already on the phone: the first list with none stored saves it once, and the row shows it", async () => {
    localStorage.setItem("rivet.chat.textSize", "l");
    localStorage.setItem("rivet.chat.replyStyle", "short");
    putAnswer = (each, body) => json({ ...each, value: body, updatedAt: "2026-11-22T00:00:00.000Z" });
    const panel = await shown();
    expect(puts.sort((a, b) => a.url.localeCompare(b.url))).toEqual([
      { url: "/api/behaviours/chat.reply-style", body: { style: "short" } },
      { url: "/api/behaviours/chat.text-size", body: { size: "l" } },
    ]);
    expect(row(panel, "chat.text-size")!.querySelector<HTMLSelectElement>("select")!.value).toBe("l");
    expect(row(panel, "chat.reply-style")!.querySelector<HTMLSelectElement>("select")!.value).toBe("short");
    expect(localStorage.getItem("rivet.chat.textSize")).toBe("l");
  });

  it("saves nothing when the phone has no pick, and lets a stored value replace the phone's copy", async () => {
    await shown();
    expect(puts).toEqual([]);
    localStorage.setItem("rivet.chat.textSize", "s");
    listed = PREFS.map((each) => (each.id === "chat.text-size" ? { ...each, value: { size: "l" }, updatedAt: "2026-11-22T00:00:00.000Z" } : each));
    await loadBehaviours();
    expect(puts.filter((put) => put.url.endsWith("chat.text-size"))).toEqual([]);
    expect(localStorage.getItem("rivet.chat.textSize")).toBe("l");
    expect(document.documentElement.dataset.chatText).toBe("l");
  });

  it("saves a pick made in the row, and Chat's copy follows it", async () => {
    putAnswer = (each, body) => json({ ...each, value: body, updatedAt: "2026-11-22T00:00:00.000Z" });
    const panel = await shown();
    const select = row(panel, "chat.reply-style")!.querySelector<HTMLSelectElement>("select")!;
    select.value = "detailed";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(puts).toEqual([{ url: "/api/behaviours/chat.reply-style", body: { style: "detailed" } }]));
    await vi.waitFor(() => expect(localStorage.getItem("rivet.chat.replyStyle")).toBe("detailed"));
    expect(readChatReplyStyle()).toBe("detailed");
  });

  it("saves a phone's pick once when the app and Settings both list before it lands", async () => {
    localStorage.setItem("rivet.chat.textSize", "l");
    let land = () => {};
    const landed = new Promise<void>((resolve) => (land = resolve));
    putAnswer = (each, body) => {
      const answer = json({ ...each, value: body, updatedAt: "2026-11-22T00:00:00.000Z" });
      return landed.then(() => answer);
    };
    const both = Promise.all([loadChatPrefs(), loadBehaviours()]);
    await vi.waitFor(() => expect(lists).toBe(2));
    land();
    await both;
    expect(puts).toEqual([{ url: "/api/behaviours/chat.text-size", body: { size: "l" } }]);
  });

  it("shows the phone's pick, not the default, when saving it to the store fails", async () => {
    localStorage.setItem("rivet.chat.textSize", "l");
    putAnswer = () => json({ error: "busy" }, 503);
    const panel = await shown();
    expect(row(panel, "chat.text-size")!.querySelector<HTMLSelectElement>("select")!.value).toBe("l");
    expect(localStorage.getItem("rivet.chat.textSize")).toBe("l");
  });

  it("reads the store again when a pick made in Chat fails to save", async () => {
    putAnswer = () => json({ error: "busy" }, 503);
    const picker = chatTextSizePicker();
    document.body.replaceChildren(picker);
    picker.querySelector<HTMLButtonElement>(".chat-size-s")!.click();
    await vi.waitFor(() => expect(flash).toHaveBeenCalledWith("Couldn't save the text size. Try again.", "error"));
    await vi.waitFor(() => expect(lists).toBe(1));
  });

  it("paints Chat's text size and reply style buttons again from the store after a failed save", async () => {
    const stored = { ...base, updatedAt: "2026-11-22T00:00:00.000Z", group: "Chat", control: "live" } as const;
    listed = [
      { ...stored, id: "chat.text-size", name: "Text size", line: "How big", value: { size: "m" } },
      { ...stored, id: "chat.reply-style", name: "Reply style", line: "How long", value: { style: "normal" } },
    ];
    putAnswer = () => json({ error: "busy" }, 503);
    const size = chatTextSizePicker();
    const style = chatReplyStylePicker();
    document.body.replaceChildren(size, style);
    const checked = (el: HTMLElement) => [...el.querySelectorAll("button")].filter((button) => button.getAttribute("aria-checked") === "true").map((button) => button.dataset.use);
    size.querySelector<HTMLButtonElement>(".chat-size-s")!.click();
    expect(checked(size)).toEqual(["chat.text-size.s"]);
    await vi.waitFor(() => expect(checked(size)).toEqual(["chat.text-size.m"]));
    style.querySelector<HTMLButtonElement>('[data-use="chat.reply-style.detailed"]')!.click();
    expect(checked(style)).toEqual(["chat.reply-style.detailed"]);
    await vi.waitFor(() => expect(checked(style)).toEqual(["chat.reply-style.normal"]));
  });

  it("saves a pick made in Chat to the store", async () => {
    const picker = chatTextSizePicker();
    document.body.replaceChildren(picker);
    picker.querySelector<HTMLButtonElement>(".chat-size-s")!.click();
    await vi.waitFor(() => expect(puts).toEqual([{ url: "/api/behaviours/chat.text-size", body: { size: "s" } }]));
    expect(localStorage.getItem("rivet.chat.textSize")).toBe("s");
  });
});
