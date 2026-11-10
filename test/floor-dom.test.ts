// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpsResponse } from "../src/shared/ops.js";
import type { OpsStatus } from "../src/shared/ops-status.js";
import { opsData } from "../web/src/ops-data.js";
import type { ServedNeed } from "../src/shared/board.js";
import { NOTHING_NEEDS_YOU } from "../src/shared/words.js";
import { when } from "../src/shared/when.js";
import { app, boardRead, changed, go, landing } from "../web/src/state.js";
import { decideShown, openCards } from "../web/src/views/decide-sheet.js";
import { openConversation } from "../web/src/views/chat.js";
import { closeSheet, closeTallSheet } from "../web/src/views/sheet.js";
import { runnerItem } from "../web/src/views/ops-status.js";
import { mountShell } from "../web/src/views/shell.js";
import * as asks from "../web/src/views/your-asks.js";
import type { Ask } from "../src/shared/asks.js";
import { stubCanvas } from "./canvas-stub.js";
import { fakeServer } from "./conversations-fake.js";
import { serveSummary } from "./summary-served.js";
import type * as Voice from "../web/src/voice.js";

// The phones' notification health, as Settings reads it: off unless a test turns it on.
const health = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("../web/src/push-health.js", async (actual) => ({
  ...((await actual()) as typeof import("../web/src/push-health.js")),
  pushHealth: () => health.value,
}));

vi.mock("../web/src/voice.js", async (original) => ({
  ...(await original<typeof Voice>()),
  say: () => {},
  unlockVoice: () => Promise.resolve(true),
  unlockOnTap: () => () => {},
  stopVoice: () => {},
}));

// The app's frame: on a phone no tab bar, the menu button on the band, Your asks, and a dock of Decide N and Rivet.
// Cards, Chat and a page are sheets over it, so an old tab id, a link or a push lands where it went. A wide window's
// rail is the menu: Your asks, Decide or a page fill the middle column, and Rivet's chat stays on the right. The Floor,
// the desks then Plan, is a menu page like any other.

const NOW = "2026-10-07T05:00:00.000Z";
const ops = (): OpsResponse =>
  ({
    now: NOW,
    healthStaleSince: null,
    bridge: { connected: true },
    github: { at: NOW, stale: false, prs: [], runs: [] },
    mac: { at: NOW, stale: false, volumes: [], load: { one: 1, five: 1, fifteen: 1, cpus: 8 }, memory: { freePct: 40, pressure: "normal" }, uptimeSec: 3600, runners: [], chatRunner: true },
    claude: { at: NOW, stale: false, limits: [] },
    flyAt: NOW,
    flyStale: false,
    flySource: null,
    summary: { needs: 0, redCi: 0, failingSchedules: 0, disk: { freePct: 41, tone: "ok" } },
  }) as unknown as OpsResponse;
const record = (extra: Partial<OpsStatus>): OpsStatus => ({ kind: "app", key: "site", state: "in-progress", since: NOW, updatedAt: NOW, version: 1, ...extra }) as OpsStatus;
const show = (statuses: OpsStatus[] | null = null) => {
  opsData.ops = ops();
  opsData.statuses = statuses;
  opsData.opsAt = { mono: performance.now(), wall: Date.now() };
};

let unmount: (() => void) | null = null;
const mount = () => {
  unmount?.();
  unmount = mountShell(document.body.firstElementChild as HTMLElement);
};
const wide = (on: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: on, media: query, addEventListener() {}, removeEventListener() {} }));
const button = (key: string) => document.querySelector<HTMLButtonElement>(`.home-dock [data-key="${key}"]`)!;
/** The tall sheet open over the home screen, by its class: decide-sheet, rivet-sheet or page-sheet. */
const sheet = () => document.querySelector<HTMLElement>(".sheet.is-tall");
const kind = () => ["decide-sheet", "rivet-sheet", "page-sheet"].find((one) => sheet()?.classList.contains(one)) ?? null;
/** A menu row: the phone's drawer opened from the band's button, or the rail's. */
const menuRow = (key: string) => {
  if (!document.querySelector(".tabs .menu-row")) document.querySelector<HTMLButtonElement>(".menu-open")!.click();
  return document.querySelector<HTMLButtonElement>(`.menu-row[data-key="${key}"]`)!;
};
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
/** Android's Back: the history entry the top sheet took goes, and its popstate closes it. */
const back = async () => {
  window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  await settle();
};
const card = (id: string, extra: Partial<ServedNeed> = {}): ServedNeed =>
  ({ id, rev: `rev-${id}`, kind: "decision", title: `Card ${id}`, ask: "Which one?", chat: `chat-${id}`, since: new Date(Date.parse(NOW) - 60_000).toISOString(), options: [{ label: "Yes" }, { label: "No" }], ...extra }) as ServedNeed;
const deal = (needs: ServedNeed[], minimised: [string, string][] = []) => {
  app.board = { version: 1, updatedAt: NOW, board: { updatedAt: NOW, needs, coming: [], chats: [], shipped: [] }, minimised } as never;
  changed();
};

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  stubCanvas();
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  wide(false);
  document.body.replaceChildren(document.createElement("div"));
  app.tab = "progress";
  app.morePage = null;
  app.front = null;
  show();
});

afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  opsData.ops = null;
  opsData.statuses = null;
  opsData.opsAt = { mono: 0, wall: 0 };
  closeSheet();
  closeTallSheet();
  app.board = null;
  app.summary = null;
  app.tab = "progress";
  app.morePage = null;
  vi.useRealTimers();
});

describe("the app's frame", () => {
  it("a phone has no tab bar: the menu button and the band on top, the map, and a dock of Decide and Rivet", () => {
    mount();
    expect(document.querySelector(".tabs, .phone-tabs, .tab")).toBeNull();
    const band = document.querySelector(".topbar.home-band")!;
    expect(band.firstElementChild?.className).toBe("menu-open");
    expect(band.firstElementChild?.getAttribute("aria-label")).toBe("Menu");
    expect([...band.children].map((one) => one.className)).toEqual(["menu-open", "home-status", "floor-line"]);
    expect(band.querySelector(".home-status")!.textContent!.trim()).toBe("Your asks");
    expect(document.querySelector('.view[data-tab="home"] .home .home-asks')).not.toBeNull();
    expect([...document.querySelectorAll<HTMLElement>(".home-dock button")].map((one) => one.dataset.key)).toEqual(["decide", "rivet"]);
    expect(sheet()).toBeNull();
  });


  it("the desktop rail is the menu, then the Chat tool; a page fills the middle column under its own name", () => {
    wide(true);
    mount();
    const rows = () => [...document.querySelectorAll<HTMLElement>(".tabs .menu-row")];
    expect(rows().map((one) => one.dataset.key)).toEqual(["asks", "floor", "usage", "machines", "code", "mind", "what-you-used", "home", "media", "settings"]);
    expect(rows().map((one) => one.querySelector(".menu-name")?.textContent)).toEqual(["Your asks", "Floor", "Usage", "Machines", "Code", "Rivet's mind", "What you used", "Home", "Media", "Settings"]);
    expect([...document.querySelectorAll<HTMLElement>(".tabs .rail-tool")].map((one) => one.dataset.key)).toEqual(["Chat"]);
    expect(document.querySelector(".home-dock")).toBeNull();
    expect(document.querySelector('.view[data-tab="home"] .home')).not.toBeNull();
    expect(document.querySelector("aside.side .chat")).not.toBeNull();
    expect(rows()[0]!.getAttribute("aria-current")).toBe("page");

    rows()[2]!.click();
    expect(document.querySelector('.view[data-tab="page"] .more-page[data-page="usage"]')).not.toBeNull();
    expect(document.querySelector(".topbar-title")?.textContent).toBe("Usage");
    expect(document.querySelector(".topbar .home-back, .topbar [aria-label='Back to Readings']")).toBeNull();
    expect(rows()[2]!.getAttribute("aria-current")).toBe("page");
    expect(rows()[0]!.hasAttribute("aria-current")).toBe(false);
    expect(sheet()).toBeNull();
    rows()[0]!.click();
    expect(document.querySelector('.view[data-tab="home"] .home')).not.toBeNull();
  });

  it("on a wide window a decision opens in the middle pane, chat staying on the right; Close goes back to Your asks", async () => {
    wide(true);
    mount();
    deal([card("d1"), card("d2")]);
    const { showCard } = await import("../web/src/views/feed.js");
    showCard("d2");
    await settle();
    expect(sheet()).toBeNull();
    expect(app.tab).toBe("cards");
    expect(document.querySelector('.view[data-tab="decide"].decide-pane .card.top')?.getAttribute("data-need")).toBe("d2");
    expect(decideShown()).toBe("d2");
    expect(document.querySelector("aside.side .chat")).not.toBeNull();
    // Your asks' menu row stays lit under it: a decision opens where Your asks was.
    expect(document.querySelector('.tabs .menu-row[data-key="asks"]')!.getAttribute("aria-current")).toBe("page");
    // Its way back is in words in the header, not the sheet's down arrow.
    expect(document.querySelector(".decide-pane .decide-close")).toBeNull();
    const homeBack = document.querySelector<HTMLButtonElement>(".topbar .home-back, .home-back")!;
    expect(homeBack.textContent).toBe("‹ Your asks");
    homeBack.click();
    expect(document.querySelector(".home-back")).toBeNull();
    expect(app.tab).toBe("progress");
    expect(document.querySelector('.view[data-tab="home"] .home')).not.toBeNull();
    expect(decideShown()).toBeNull();
  });

  it("on a wide window Decide › Answered keeps its switch in the pane", async () => {
    wide(true);
    app.tab = "cards";
    mount();
    deal([]);
    await settle();
    const seg = (id: string) => document.querySelector<HTMLButtonElement>(`.decide-pane .decide-seg[data-seg="${id}"]`)!;
    expect(seg("answered").getAttribute("aria-pressed")).toBe("true");
    seg("open").click();
    expect(document.querySelector(".decide-pane .decide-none")?.textContent).toBe(NOTHING_NEEDS_YOU);
  });
});

describe("Decide N", () => {
  it("is the open decision cards: gold while any wait, its number the sheet's of N and Open N, none for a minimised one", async () => {
    deal([card("a"), card("b"), card("c"), card("u", { kind: "update", thread: "Release notes" })], [["c", "rev-c"]]);
    mount();
    const decide = button("decide");
    expect(decide.classList.contains("has-cards")).toBe(true);
    expect(decide.querySelector(".home-decide-n")?.textContent).toBe("2");
    expect(decide.getAttribute("aria-label")).toBe("Decide, 2 decisions");
    decide.click();
    await settle();
    expect(kind()).toBe("decide-sheet");
    expect(sheet()!.querySelector(".decide-name")?.textContent).toBe("example-repo");
    expect(sheet()!.querySelector(".decide-count")?.textContent).toMatch(/^1 of 2 · /);
    expect(sheet()!.querySelector('.decide-seg[data-seg="open"]')?.textContent).toBe("Open 2");
    deal([]);
    expect(button("decide").classList.contains("has-cards")).toBe(false);
    expect(button("decide").querySelector(".home-decide-n")?.textContent).toBe("0");
  });

  it("agrees with the map: every agent's ? is an open card, and the pill counts no more agents than Decide N's cards", () => {
    deal([card("a", { chat: "intro" }), card("b", { chat: "menu" }), card("c", { chat: "menu" })], [["c", "rev-c"]]);
    app.workersAt = Date.now();
    app.workers = {
      at: NOW,
      workers: [
        { id: "w1", name: "w1", repo: "example-org/example-repo", chat: "intro", state: "working", lastOutputAt: Date.parse(NOW) },
        { id: "w2", name: "w2", repo: "example-org/example-repo", chat: "menu", state: "working", lastOutputAt: Date.parse(NOW) },
        { id: "w3", name: "w3", repo: "example-org/example-repo", chat: "sidebar", state: "working", lastOutputAt: Date.parse(NOW) },
      ],
    } as never;
    try {
      go("floor");
      mount();
      const n = Number(button("decide").querySelector(".home-decide-n")?.textContent);
      expect(n).toBe(openCards().length);
      expect(n).toBe(2);
      const asking = document.querySelectorAll(".desk-agent.is-asking").length;
      expect(asking).toBe(2);
      expect(asking).toBeLessThanOrEqual(n);
      expect([...document.querySelectorAll(".desk-count")].map((pill) => pill.textContent)).toContain(`${asking} need you`);
    } finally {
      app.workers = null;
      app.workersAt = null;
    }
  });
});

describe("each sheet over the home screen", () => {
  it.each([
    ["decide", "decide-sheet", "cards"],
    ["rivet", "rivet-sheet", "chat"],
  ])("%s opens its sheet, and Back closes it to the bare home screen", async (key, cls, tab) => {
    deal([card("a")]);
    mount();
    button(key).click();
    await settle();
    expect(kind()).toBe(cls);
    expect(app.tab).toBe(tab);
    await back();
    expect(sheet()).toBeNull();
    expect(app.tab).toBe("progress");
    expect(document.querySelector('.view[data-tab="home"] .home')).not.toBeNull();
  });

  it("a dock tap opens its sheet before the home screen redraws, which waits until it has slid up; Rivet's thread lands after the first frame", () => {
    (HTMLElement.prototype as unknown as { getAnimations: () => unknown[] }).getAnimations = () => [];
    vi.useRealTimers();
    vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.stubGlobal("requestAnimationFrame", (then: FrameRequestCallback) => setTimeout(() => then(performance.now()), 16));
    try {
      for (const [key, cls] of [["rivet", "rivet-sheet"], ["decide", "decide-sheet"]] as const) {
        mount();
        const lists = document.querySelector(".home-band")!;
        const drawn = lists.firstElementChild;
        button(key).click();
        expect(kind()).toBe(cls);
        expect(lists.firstElementChild).toBe(drawn);
        if (key === "rivet") {
          expect(sheet()!.querySelector(".chat-thread")!.childElementCount).toBe(0);
          expect(sheet()!.querySelector(".chat textarea")).not.toBeNull();
          vi.advanceTimersByTime(20);
          expect(sheet()!.querySelector(".chat-thread")!.childElementCount).toBeGreaterThan(0);
        }
        vi.advanceTimersByTime(300);
        expect(lists.firstElementChild).not.toBe(drawn);
        closeTallSheet();
        vi.advanceTimersByTime(300);
        expect(app.tab).toBe("progress");
      }
    } finally {
      delete (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations;
      vi.useRealTimers();
    }
  });

  it("Rivet's sheet marks itself as showing his chat for the push watcher", async () => {
    mount();
    button("rivet").click();
    await settle();
    expect(sheet()!.hasAttribute("data-shows-chat")).toBe(true);
    expect(sheet()!.querySelector(".home-chat")!.childElementCount).toBeGreaterThan(0);
  });

  it("a menu row closes the drawer and opens its page in a sheet under the page's name, with no back arrow; Close and Back go home", async () => {
    mount();
    document.querySelector<HTMLButtonElement>(".menu-open")!.click();
    expect(document.querySelector(".menu-sheet")).not.toBeNull();
    expect(document.querySelector('.menu-row[data-key="costs"], .menu-row[data-key="scheduled"]')).toBeNull();
    menuRow("usage").click();
    await settle();
    expect(document.querySelector(".menu-sheet")).toBeNull();
    expect(kind()).toBe("page-sheet");
    expect([app.tab, app.morePage]).toEqual(["more", "usage"]);
    expect(sheet()!.querySelector(".home-sheet-title")?.textContent).toBe("Usage");
    expect(sheet()!.querySelector('[aria-label="Back to Readings"]')).toBeNull();
    expect(sheet()!.querySelector('.more-page[data-page="usage"]')).not.toBeNull();
    await back();
    expect(sheet()).toBeNull();
    expect(app.tab).toBe("progress");
    menuRow("machines").click();
    await settle();
    expect(sheet()!.querySelector(".home-sheet-title")?.textContent).toBe("Machines");
    sheet()!.querySelector<HTMLButtonElement>(".home-sheet-head .btn, .home-sheet-head button:last-child")!.click();
    await settle();
    expect(app.tab).toBe("progress");
  });

  it("the drawer's Your asks row closes it and leaves the bare home screen", async () => {
    mount();
    menuRow("asks").click();
    await settle();
    expect(document.querySelector(".menu-sheet")).toBeNull();
    expect(sheet()).toBeNull();
    expect(app.tab).toBe("progress");
  });

  it("the Floor row opens the desks then a live Plan in a page sheet, with no second Your asks; Back goes home", async () => {
    mount();
    menuRow("floor").click();
    await settle();
    expect(kind()).toBe("page-sheet");
    expect([app.tab, app.morePage]).toEqual(["more", "floor"]);
    expect(sheet()!.querySelector(".home-sheet-title")?.textContent).toBe("Floor");
    const page = sheet()!.querySelector<HTMLElement>('.more-page[data-page="floor"] .floor')!;
    expect([...page.children].map((one) => one.className)).toEqual(["progress-scene", "floor-room", "progress-plan"]);
    expect(page.querySelector(".floor-stage .desks-grid, .floor-stage .desk.is-rivet")).not.toBeNull();
    expect(page.querySelector(".home-dock, .home-asks")).toBeNull();
    expect(document.querySelectorAll(".home-asks")).toHaveLength(1);
    expect(app.opsPage).toBe("plan");
    // Ops draws into the Floor's Plan, and keeps drawing on each change.
    const plan = page.querySelector<HTMLElement>(".progress-plan")!;
    plan.append(Object.assign(document.createElement("i"), { className: "stale-mark" }));
    changed();
    expect(plan.querySelector(".stale-mark")).toBeNull();
    await back();
    expect(sheet()).toBeNull();
    expect(app.tab).toBe("progress");
    expect(document.querySelector(".floor")).toBeNull();
  });

  it("the Floor's Agent Chat row opens the Team room in Chat", async () => {
    mount();
    menuRow("floor").click();
    await settle();
    const row = sheet()!.querySelector<HTMLElement>(".floor-room")!;
    expect(row.textContent).toContain("Agent Chat");
    row.click();
    await settle();
    expect(app.tab).toBe("chat");
    expect(openConversation()).toBe("team-room");
  });

  it("widening puts the menu on the rail", async () => {
    const heard: (() => void)[] = [];
    const query = { matches: false, addEventListener: (_: string, listener: () => void) => heard.push(listener), removeEventListener() {} };
    vi.stubGlobal("matchMedia", (media: string) => Object.assign(query, { media }));
    mount();
    button("rivet").click();
    await settle();
    expect(kind()).toBe("rivet-sheet");
    query.matches = true;
    for (const listener of heard) listener();
    await settle();
    expect(document.querySelector(".tabs .menu-row")).not.toBeNull();
  });

  it("a clip in full screen covers Rivet's chat inside his sheet, so nothing in it reads as seen", async () => {
    const { coveredOver } = await import("../web/src/push.js");
    mount();
    button("rivet").click();
    await settle();
    const chatHost = sheet()!.querySelector(".home-chat")!;
    expect(coveredOver(chatHost)).toBe(false);
    const video = Object.assign(document.createElement("video"), { webkitDisplayingFullscreen: true });
    document.body.append(video);
    expect(coveredOver(chatHost)).toBe(true);
    video.remove();
  });

  it("Back on the bare home screen opens nothing: the app has no entry of its own to go back to", async () => {
    mount();
    const entries = history.length;
    await back();
    expect(sheet()).toBeNull();
    expect(app.tab).toBe("progress");
    expect(history.length).toBe(entries);
  });
});

describe("old tab ids", () => {
  it.each([
    ["cards", "cards", null],
    ["progress", "progress", null],
    ["chat", "chat", null],
    ["more", "progress", null],
    ["feed", "cards", null],
    ["yard", "progress", null],
    ["agents", "progress", null],
    ["ops", "progress", null],
    ["plan", "progress", null],
    ["home", "more", "home"],
    ["media", "more", "media"],
    ["usage", "more", "usage"],
    ["costs", "progress", null],
    ["machines", "more", "machines"],
    ["scheduled", "progress", null],
    ["floor", "more", "floor"],
    ["code", "more", "code"],
    ["settings", "more", "settings"],
    ["no-such-tab", "progress", null],
  ])("%s lands on %s %s", (id, tabId, page) => {
    expect(landing(id)).toEqual({ tab: tabId, page });
    go(id);
    expect([app.tab, page ? app.morePage : null]).toEqual([tabId, page]);
  });

  it.each([
    ["feed", "decide-sheet"],
    ["cards", "decide-sheet"],
    ["chat", "rivet-sheet"],
    ["more", null],
    ["costs", null],
    ["scheduled", null],
    ["usage", "page-sheet"],
    ["yard", null],
    ["ops", null],
    ["progress", null],
  ])("saved as %s, a phone opens Your asks with %s over it", async (id, cls) => {
    deal([card("a")]);
    go(id);
    mount();
    await settle();
    expect(document.querySelector('.view[data-tab="home"] .home')).not.toBeNull();
    expect(kind()).toBe(cls);
  });

  it("a Cards link opened before the first board read shows its open cards once the read lands, not Answered", async () => {
    app.board = null;
    app.tab = "cards";
    mount();
    await settle();
    expect(kind()).toBe("decide-sheet");
    deal([card("a")]);
    await settle();
    expect(sheet()!.querySelector('.decide-seg[data-seg="open"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(decideShown()).toBe("a");
  });

  it("Cards with nothing open opens the Decide sheet on Answered, and says nothing needs you on Open", async () => {
    deal([]);
    app.tab = "cards";
    mount();
    await settle();
    expect(kind()).toBe("decide-sheet");
    expect(sheet()!.querySelector('.decide-seg[data-seg="answered"]')?.getAttribute("aria-pressed")).toBe("true");
    sheet()!.querySelector<HTMLButtonElement>('.decide-seg[data-seg="open"]')!.click();
    await settle();
    expect(sheet()!.querySelector(".decide-none")).not.toBeNull();
    expect(decideShown()).toBeNull();
  });

  it("with every card minimised says they wait, never Nothing needs you, and Show them › opens the first", async () => {
    deal([card("a"), card("b")], [["a", "rev-a"], ["b", "rev-b"]]);
    app.tab = "cards";
    mount();
    await settle();
    sheet()!.querySelector<HTMLButtonElement>('.decide-seg[data-seg="open"]')!.click();
    await settle();
    expect(sheet()!.querySelector(".decide-none")?.textContent).toBe("2 cards wait for you, all minimised.Show them ›");
    expect(sheet()!.textContent).not.toContain(NOTHING_NEEDS_YOU);
    // The tab never says Open 0 over that line; Decide N stays the open cards.
    expect(sheet()!.querySelector('.decide-seg[data-seg="open"]')?.textContent).toBe("Minimised 2");
    expect(button("decide").querySelector(".home-decide-n")?.textContent).toBe("0");
    sheet()!.querySelector<HTMLButtonElement>(".decide-none .clear-min")!.click();
    await settle();
    expect(decideShown()).toBe("a");
    expect(sheet()!.querySelector(".decide-name")?.textContent).toBe("example-repo");
    expect(sheet()!.querySelector(".decide-count")?.textContent).toMatch(/^1 of 1 · /);
    expect(sheet()!.querySelector('.decide-seg[data-seg="open"]')?.textContent).toBe("Open 1");
    expect(button("decide").querySelector(".home-decide-n")?.textContent).toBe("1");
  });
});

describe("the band's one line", () => {
  const MIN = 60_000;
  const lineEl = () => document.querySelector<HTMLElement>(".home-band .floor-line")!;
  const say = () => lineEl().querySelector<HTMLElement>(".floor-line-say");
  const on = () => lineEl().classList.contains("is-on");
  const job = (id: string, minutes: number): Ask =>
    ({ id, words: `Job ${id}`, who: "owner", stage: "building", chat: `chat-${id}`, prs: [], dueHistory: [], timeline: [], dueAt: new Date(Date.parse(NOW) + minutes * MIN).toISOString(), createdAt: NOW, stageAt: NOW, updatedAt: NOW, version: 1 }) as Ask;
  /** Your asks as the server serves them, read into the Floor. */
  const serveAsks = async (served: Ask[]) => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).includes("/api/asks") ? new Response(JSON.stringify({ asks: served }), { status: 200, headers: { "content-type": "application/json" } }) : new Promise(() => {}))));
    await asks.refresh();
  };
  const runnerDown = () => {
    opsData.ops = {
      ...opsData.ops!,
      github: { at: NOW, stale: false, prs: [], runs: [], runners: { complete: true, detailsComplete: true, online: 1, busy: 0, offline: 1, runners: [{ name: "ci-box-0", status: "online", busy: false }, { name: "ci-box-1", status: "offline", busy: false }] }, queue: { queuedJobs: 0, jobsComplete: true, runsComplete: true }, sources: null },
    } as unknown as OpsResponse;
  };
  const usageNear = () => {
    opsData.ops = { ...opsData.ops!, claude: { at: NOW, stale: false, limits: [95, 90, 92, 88].map((percent, i) => ({ kind: `account_${i + 1}`, label: `Account a${i}***`, percent, severity: "warning", resetsAt: null, active: i === 0 })) } } as unknown as OpsResponse;
  };

  afterEach(async () => {
    await serveAsks([]);
  });

  it("is hidden while nothing is for you: the band is just its title", () => {
    mount();
    expect(on()).toBe(false);
    expect(lineEl().hasAttribute("inert")).toBe(true);
    expect(lineEl().getAttribute("aria-hidden")).toBe("true");
    // A line folded away keeps its last words, so it fades out as it was; the rest of the band says only Rivet's name.
    const shown = [...document.querySelector(".home-band")!.children].filter((one) => one !== lineEl());
    expect(shown.map((one) => one.textContent!.trim()).join("")).toBe("Your asks");
  });

  it("says the first of: cards waiting, a job due within the hour, a machine amber or red, Usage near its cap", async () => {
    runnerDown();
    usageNear();
    await serveAsks([job("soon", 30), job("later", 90)]);
    mount();
    deal([card("d1"), card("d2")]);
    expect(on()).toBe(true);
    expect([lineEl().hasAttribute("inert"), lineEl().hasAttribute("aria-hidden")]).toEqual([false, false]);
    expect(say()!.dataset.use).toBe("floor.line.cards");
    expect(say()!.textContent).toBe("2 cards wait for you›");
    expect(say()!.getAttribute("aria-label")).toBe("2 cards wait for you, open Decide");
    expect(say()!.className).toBe("floor-line-say t-cards");
    // Decide N in the dock still says the count as well.
    expect(document.querySelector(".home-decide .home-decide-n")?.textContent).toBe("2");

    deal([card("d1")]);
    expect(say()!.textContent).toBe("1 card waits for you›");

    deal([]);
    expect(say()!.dataset.use).toBe("floor.line.due");
    expect(say()!.querySelector(".floor-line-lead")!.textContent).toMatch(/^By \d{1,2}:\d{2}[ap]m ·$/);
    expect(say()!.querySelector(".floor-line-text")!.textContent).toBe("Job soon");

    await serveAsks([job("later", 90)]);
    expect(say()!.dataset.use).toBe("floor.line.machine");
    expect(say()!.querySelector(".floor-line-text")!.textContent).toBe("ci-box-1 needs a look");
    expect(say()!.className).toBe("floor-line-say t-bad");

    show();
    usageNear();
    changed();
    expect(say()!.dataset.use).toBe("floor.line.usage");
    expect(say()!.querySelector(".floor-line-text")!.textContent).toBe("Usage 3.6 of 4 · near the cap");

    show();
    changed();
    expect(on()).toBe(false);
    expect(lineEl().hasAttribute("inert")).toBe(true);
    expect(lineEl().getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps its one element across repaints, so it opens and closes in place", () => {
    mount();
    const el = lineEl();
    deal([card("d1")]);
    expect(lineEl()).toBe(el);
    deal([]);
    expect(lineEl()).toBe(el);
    expect(el.parentElement).toBe(document.querySelector(".home-band"));
  });

  it("each tap goes where the thing is: Decide, the job's own row, Machines, Usage", async () => {
    mount();
    deal([card("d1")]);
    say()!.click();
    expect(kind()).toBe("decide-sheet");
    closeTallSheet();
    deal([]);

    await serveAsks([job("soon", 30)]);
    say()!.click();
    await settle();
    expect(document.querySelector(".cmd-worker-sheet")?.getAttribute("aria-label")).toBeTruthy();
    closeSheet();
    await serveAsks([]);

    runnerDown();
    changed();
    say()!.click();
    expect(kind()).toBe("page-sheet");
    expect(app.morePage).toBe("machines");
    closeTallSheet();

    show();
    usageNear();
    changed();
    say()!.click();
    expect(kind()).toBe("page-sheet");
    expect(app.morePage).toBe("usage");
  });

  it("names only machines: a phone with notifications off is Settings', so Usage near its cap still shows", () => {
    usageNear();
    health.value = { configured: true, publicKey: "k", subscriptions: 0, lastRemoval: null };
    try {
      mount();
      expect(say()!.dataset.use).toBe("floor.line.usage");
    } finally {
      health.value = null;
    }
  });

  it("names an amber machine, as Machines draws it, but not one whose reading is old", () => {
    const tight = { ...opsData.ops!.mac!, memory: { freePct: 12, pressure: "warn" } };
    opsData.ops = { ...opsData.ops!, mac: tight } as unknown as OpsResponse;
    mount();
    expect(say()!.dataset.use).toBe("floor.line.machine");
    expect(say()!.querySelector(".floor-line-text")!.textContent).toBe("Mac needs a look");
    expect(say()!.className).toBe("floor-line-say t-warn");

    show();
    opsData.ops = { ...opsData.ops!, mac: { ...tight, stale: true } } as unknown as OpsResponse;
    changed();
    expect(on()).toBe(false);
  });

  it("leaves a machine you parked calm, as Plan does", () => {
    const parkedRecord = { kind: "runner", key: runnerItem("ci-box-1").key, state: "parked", by: "rivet", since: NOW, updatedAt: NOW, version: 1 } as OpsStatus;
    show([parkedRecord]);
    runnerDown();
    mount();
    expect(on()).toBe(false);

    show();
    runnerDown();
    changed();
    expect(say()!.dataset.use).toBe("floor.line.machine");
    expect(say()!.querySelector(".floor-line-text")!.textContent).toBe("ci-box-1 needs a look");
  });

  it("counts every machine, not the rows Machines folds them into", () => {
    const names = ["ci-box-1", "ci-box-2", "ci-box-3", "ci-box-4", "ci-box-5"];
    opsData.ops = {
      ...opsData.ops!,
      github: { at: NOW, stale: false, prs: [], runs: [], runners: { complete: true, detailsComplete: true, online: 1, busy: 0, offline: 5, runners: [{ name: "ci-box-0", status: "online", busy: false }, ...names.map((name) => ({ name, status: "offline", busy: false }))] }, queue: { queuedJobs: 0, jobsComplete: true, runsComplete: true }, sources: null },
    } as unknown as OpsResponse;
    mount();
    expect(say()!.dataset.use).toBe("floor.line.machine");
    expect(say()!.querySelector(".floor-line-text")!.textContent).toBe("ci-box-1 needs a look · 4 more");
  });

  it("says near the cap only of a current Usage reading", () => {
    usageNear();
    opsData.ops = { ...opsData.ops!, claude: { ...opsData.ops!.claude!, stale: true } } as unknown as OpsResponse;
    mount();
    expect(on()).toBe(false);
  });

  it("gives a record's current deadline, never the first one of the pick-up ask it stands in for", async () => {
    const pickup = (minutes: number): Ask => ({ ...job("pickup", minutes), who: "rivet", source: "pickup:app/site" }) as Ask;
    const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * MIN).toISOString();
    // The record moved two hours on: nothing is due within the hour, though the ask's own time is ten minutes off.
    show([record({ dueAt: at(120) } as Partial<OpsStatus>)]);
    await serveAsks([pickup(10)]);
    mount();
    expect(on()).toBe(false);

    // The record is due in twenty minutes: the line gives its time, not the ask's five.
    show([record({ dueAt: at(20) } as Partial<OpsStatus>)]);
    await serveAsks([pickup(5)]);
    changed();
    expect(say()!.dataset.use).toBe("floor.line.due");
    const lead = say()!.querySelector(".floor-line-lead")!.textContent!;
    const by = `by ${when(at(20), Date.parse(NOW))}`;
    expect(lead).toBe(`${by.charAt(0).toUpperCase()}${by.slice(1)} ·`);
    expect(say()!.querySelector(".floor-line-text")!.textContent).not.toBe("Job pickup");
  });
});

describe("Usage at the head of the menu drawer", () => {
  it("its tile closes the drawer and opens its page", () => {
    mount();
    document.querySelector<HTMLButtonElement>(".home-band .menu-open")!.click();
    const tile = document.querySelector<HTMLButtonElement>('.menu-sheet [data-key="tile-usage"]')!;
    expect(tile.nextElementSibling?.classList.contains("menu")).toBe(true);
    tile.click();
    expect(document.querySelector(".menu-sheet")).toBeNull();
    expect(kind()).toBe("page-sheet");
    expect(app.morePage).toBe("usage");
  });
});

describe("the ops mark on the menu button and the Machines row", () => {
  it("is an amber dot while an ask has no time or has moved twice, never for a first slip", () => {
    // An ask past its time, with none given since: No time yet.
    serveSummary([{ dueAt: "2026-10-07T04:00:00.000Z" }]);
    mount();
    const open = () => document.querySelector<HTMLButtonElement>(".menu-open")!;
    expect(open().querySelector(".menu-dot")!.className).toBe("menu-dot t-warn");
    expect(open().getAttribute("aria-label")).toBe("Menu, 1 no time yet");
    const machines = menuRow("machines");
    expect(machines.querySelector(".badge")!.className).toBe("badge t-warn");
    expect(machines.getAttribute("aria-label")).toBe("Machines, 1 no time yet");
    closeSheet();
    // A time ahead, moved once or not at all, is no mark.
    serveSummary([{ dueAt: "2026-10-07T06:00:00.000Z", dueHistory: [{ at: "2026-10-07T04:30:00.000Z", dueAt: "2026-10-07T06:00:00.000Z", was: "2026-10-07T04:00:00.000Z" }] }]);
    mount();
    expect(open().querySelector(".menu-dot")).toBeNull();
    expect(menuRow("machines").querySelector(".badge")).toBeNull();
  });
});

describe("links and pushes, as main.ts opens them", () => {
  const needs = [card("d1"), card("d2"), card("u1", { kind: "update", thread: "Release notes", rev: "1".repeat(16) })];
  let posted: Record<string, unknown>[] = [];
  let fromWorker: ((event: MessageEvent) => void) | null = null;
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const flush = async () => {
    for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const viewing = () => posted.filter((one) => one.type === "viewing").at(-1);
  /** The state the last start() booted: signing it out tears its shell down, so no Floor keeps ticking after the test. */
  let booted: typeof import("../web/src/state.js") | null = null;

  beforeEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const server = fakeServer([{ id: "k1", from: "owner", text: "Results row", at: "2030-01-01T00:01:00.000Z", status: "replied", threadId: "k1" }], { k1: { title: "Menu results row" } });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/me") return Promise.resolve(json({ signedIn: true }));
        if (url === "/api/board") return Promise.resolve(json({ version: 1, updatedAt: NOW, board: { updatedAt: NOW, needs, coming: [], chats: [], shipped: [] } }));
        if (url === "/api/answered") return Promise.resolve(json({ cards: [], reopened: [] }));
        return server.fetch(input, init);
      }),
    );
    vi.stubGlobal("EventSource", class { static CLOSED = 2; readyState = 1; addEventListener() {} close() {} });
    posted = [];
    fromWorker = null;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        controller: { postMessage: (message: Record<string, unknown>) => posted.push(message) },
        register: () => Promise.reject(new Error("no worker here")),
        addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
          if (type === "message") fromWorker = listener;
        },
        removeEventListener: () => {},
      },
    });
    localStorage.clear();
  });

  afterEach(() => {
    booted?.signedOut("");
    booted = null;
    Reflect.deleteProperty(navigator, "serviceWorker");
  });

  async function start(address: string) {
    vi.resetModules();
    history.replaceState(null, "", address);
    document.body.replaceChildren(Object.assign(document.createElement("div"), { id: "app" }));
    await import("../web/src/main.js");
    await flush();
    booted = await import("../web/src/state.js");
    return { state: booted, decide: await import("../web/src/views/decide-sheet.js"), chat: await import("../web/src/views/chat.js") };
  }
  const push = async (data: Record<string, unknown>) => {
    fromWorker!(new MessageEvent("message", { data }));
    await flush();
  };

  it("/ opens the bare home screen, Decide N saying what waits", async () => {
    const { state } = await start("/");
    expect(state.app.tab).toBe("progress");
    expect(document.querySelector('.view[data-tab="home"] .home')).not.toBeNull();
    expect(sheet()).toBeNull();
    expect(button("decide").querySelector(".home-decide-n")?.textContent).toBe("2");
  });

  it("a decision's ?card= opens the Decide sheet on it over the home screen, and the worker hears that card is on screen", async () => {
    const { decide } = await start("/?card=d2");
    expect(kind()).toBe("decide-sheet");
    expect(decide.decideShown()).toBe("d2");
    expect(document.querySelector('.view[data-tab="home"] .home')).not.toBeNull();
    expect(viewing()).toMatchObject({ card: "d2" });
    expect(location.search).toBe("");
  });

  it("a ?card= link to a card minimised here opens it in full in the Decide sheet", async () => {
    const read = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input) === "/api/board"
        ? Promise.resolve(json({ version: 1, updatedAt: NOW, board: { updatedAt: NOW, needs, coming: [], chats: [], shipped: [] }, minimised: [["d2", "rev-d2"]] }))
        : read(input, init),
    );
    const { decide } = await start("/?card=d2");
    expect(kind()).toBe("decide-sheet");
    expect(decide.decideShown()).toBe("d2");
  });

  it("the Decide sheet opened over Progress reads Answered, so its switch and list fill", async () => {
    const { state } = await start("/?card=d1");
    expect(state.app.tab).toBe("progress");
    expect(kind()).toBe("decide-sheet");
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === "/api/answered")).toBe(true);
  });

  it("an update's ?card= opens the card in full in its own sheet over the home screen", async () => {
    const { state } = await start("/?card=u1");
    expect(sheet()).toBeNull();
    expect(state.app.tab).toBe("progress");
    expect(document.querySelector(`.home .progress-news`)).toBeNull();
    expect(document.querySelector(`.sheet.update-sheet [data-need="u1"]`)).not.toBeNull();
  });

  it("Rivet's sheet opens on the conversation: one head row, then the More topics row and the first bubble, no search or stage list over them", async () => {
    const { chat } = await start("/");
    button("rivet").click();
    await flush();
    const head = sheet()!.querySelector<HTMLElement>(".home-sheet-head")!;
    // His face, Rivet and Read aloud, then Close: the chat's head is the sheet's, never a second row under it.
    expect(head.querySelector(".chat-head .chat-title")!.textContent).toBe("Rivet");
    expect(head.querySelector(".chat-head .chat-tools")).not.toBeNull();
    const section = sheet()!.querySelector<HTMLElement>(".home-chat > .chat")!;
    expect(section.querySelector(".chat-head")).toBeNull();
    // Over the messages only the More topics row shows; search waits inside it.
    const over = [...section.children].slice(0, [...section.children].indexOf(section.querySelector(".chat-scroll")!));
    expect(over.filter((one) => !(one as HTMLElement).hidden).map((one) => one.className)).toEqual(["chat-topics-row"]);
    expect(section.querySelector<HTMLElement>(".chat-search")!.hidden).toBe(true);
    expect(section.querySelector('.chat-scroll .chat-msg[data-id="k1"]')).not.toBeNull();
    // A topic's page keeps the one head row and has no stage list over its talk.
    chat.showConversation("k1");
    await flush();
    expect(head.querySelector<HTMLElement>(".chat-head")!.hidden).toBe(false);
    expect(section.querySelector(".thing-head .chat-speak")).toBeNull();
    expect(section.querySelector(".thing-steps")).toBeNull();
  });

  it("in Rivet's sheet, Back from a topic opened off More topics comes back to the list, then to Chat, and the sheet stays open", async () => {
    await start("/");
    button("rivet").click();
    await flush();
    const section = sheet()!.querySelector<HTMLElement>(".home-chat > .chat")!;
    const open = section.querySelector<HTMLButtonElement>(".chat-topics-open")!;
    open.focus();
    open.click();
    await flush();
    expect(section.classList.contains("topics")).toBe(true);
    // Focus goes with the row to its Back arrow, never to the page.
    expect(document.activeElement?.classList.contains("chat-topics-back")).toBe(true);
    section.querySelector<HTMLButtonElement>('.chat-topic[data-id="k1"]')!.click();
    await flush();
    section.querySelector<HTMLButtonElement>(".thing-back")!.click();
    await flush();
    expect(sheet()).not.toBeNull();
    expect(section.classList.contains("topics")).toBe(true);
    section.querySelector<HTMLButtonElement>(".chat-topics-back")!.click();
    await flush();
    expect(sheet()).not.toBeNull();
    expect(section.classList.contains("topics")).toBe(false);
    expect(document.activeElement?.classList.contains("chat-topics-open")).toBe(true);
  });

  it("in Rivet's sheet, Back over Share on a topic opened off More topics closes Share alone and keeps the topic", async () => {
    await start("/");
    button("rivet").click();
    await flush();
    const section = sheet()!.querySelector<HTMLElement>(".home-chat > .chat")!;
    section.querySelector<HTMLButtonElement>(".chat-topics-open")!.click();
    await flush();
    section.querySelector<HTMLButtonElement>('.chat-topic[data-id="k1"]')!.click();
    await flush();
    const topic = history.state;
    expect(topic?.chatScreen).toBe("k1");
    // Share's pop-up, as the topic's Share button opens it: no history entry of its own. The app's own copy of sheet.ts,
    // which start() loaded afresh.
    const { openSheet } = await import("../web/src/views/sheet.js");
    openSheet("Share", { mount() {}, unmount() {} });
    expect(document.querySelector(".sheet:not(.is-tall)")).not.toBeNull();
    // The sheet stops the event before any later listener, so wait on the traversal's task, not on popstate.
    history.back();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flush();
    expect(document.querySelector(".sheet:not(.is-tall)")).toBeNull();
    expect(sheet()).not.toBeNull();
    expect(section.classList.contains("topics")).toBe(false);
    expect(section.querySelector(".thing-back")).not.toBeNull();
    expect(history.state).toEqual(topic);
  });

  it.each(["/?tab=chat", "/?conversation=k1", "/?tab=chat&conversation=k1"])("%s opens Rivet's sheet, which the worker hears as the chat on screen", async (address) => {
    const { chat } = await start(address);
    expect(kind()).toBe("rivet-sheet");
    if (address.includes("k1")) expect(chat.openConversation()).toBe("k1");
    const open = chat.openConversation();
    expect(viewing()).toMatchObject({ tab: "chat", ...(open ? { chat: open } : {}) });
  });

  it("the worker's open-card puts a decision in the Decide sheet and an update in its own sheet over the home screen", async () => {
    const { decide, state } = await start("/");
    await push({ type: "open-card", id: "d2" });
    expect(kind()).toBe("decide-sheet");
    expect(decide.decideShown()).toBe("d2");
    await push({ type: "open-card", id: "u1" });
    expect(sheet()).toBeNull();
    expect(state.app.tab).toBe("progress");
    expect(document.querySelector(`.sheet.update-sheet [data-need="u1"]`)).not.toBeNull();
  });

  it("the worker's open-tab opens the sheet its id names, and a conversation in Rivet's", async () => {
    const { chat, state } = await start("/");
    await push({ type: "open-tab", tab: "chat" });
    expect(kind()).toBe("rivet-sheet");
    await push({ type: "open-tab", tab: "usage" });
    expect(kind()).toBe("page-sheet");
    await push({ type: "open-tab", tab: "progress" });
    expect(sheet()).toBeNull();
    await push({ type: "open-tab", tab: "feed", conversation: "k1" });
    expect(kind()).toBe("rivet-sheet");
    expect(chat.openConversation()).toBe("k1");
    expect(state.app.tab).toBe("chat");
  });

  it("closing Rivet's sheet with a conversation open goes back past its entries too, so the next Back is the phone's", async () => {
    const { chat } = await start("/");
    await push({ type: "open-tab", tab: "chat" });
    chat.showConversation("k1");
    await flush();
    expect(chat.openConversation()).toBe("k1");
    expect(chat.historyDepth()).toBe(1);
    const go = vi.spyOn(history, "go").mockImplementation(() => {});
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    document.querySelector<HTMLButtonElement>(".rivet-sheet .decide-close")!.click();
    expect(sheet()).toBeNull();
    expect(go).toHaveBeenCalledWith(-2);
    expect(back).not.toHaveBeenCalled();
    go.mockRestore();
    back.mockRestore();
  });

  it("closing Rivet's sheet on a topic opened off More topics goes back past the list's entry too", async () => {
    await start("/");
    button("rivet").click();
    await flush();
    const section = sheet()!.querySelector<HTMLElement>(".home-chat > .chat")!;
    section.querySelector<HTMLButtonElement>(".chat-topics-open")!.click();
    await flush();
    section.querySelector<HTMLButtonElement>('.chat-topic[data-id="k1"]')!.click();
    await flush();
    expect(history.state).toMatchObject({ chatScreen: "k1", chatDepth: 2 });
    const go = vi.spyOn(history, "go").mockImplementation(() => {});
    document.querySelector<HTMLButtonElement>(".rivet-sheet .decide-close")!.click();
    expect(sheet()).toBeNull();
    expect(go).toHaveBeenCalledWith(-3);
    go.mockRestore();
  });

  it("Back from one conversation to the last keeps Rivet's sheet open on it", async () => {
    const { chat } = await start("/");
    await push({ type: "open-tab", tab: "chat" });
    chat.showConversation("k1");
    await flush();
    const k1: unknown = history.state;
    chat.showConversation("k2");
    await flush();
    expect(chat.historyDepth()).toBe(2);
    // The phone's Back: the entry under is the first conversation's.
    history.replaceState(k1, "");
    window.dispatchEvent(new PopStateEvent("popstate", { state: k1 }));
    await settle();
    expect(sheet()).not.toBeNull();
    expect(chat.openConversation()).toBe("k1");
    expect(chat.historyDepth()).toBe(1);
  });

  it("closing Rivet's sheet on Chat takes its one entry back, as before", async () => {
    const { chat } = await start("/");
    await push({ type: "open-tab", tab: "chat" });
    expect(chat.historyDepth()).toBe(0);
    const go = vi.spyOn(history, "go").mockImplementation(() => {});
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    document.querySelector<HTMLButtonElement>(".rivet-sheet .decide-close")!.click();
    expect(back).toHaveBeenCalledTimes(1);
    expect(go).not.toHaveBeenCalled();
    go.mockRestore();
    back.mockRestore();
  });

  it("Back closes a pushed sheet to the home screen, and the worker hears no card on screen", async () => {
    const { state } = await start("/?card=d1");
    expect(viewing()).toMatchObject({ card: "d1" });
    await back();
    await flush();
    expect(sheet()).toBeNull();
    expect(state.app.tab).toBe("progress");
    expect(viewing()?.card).toBeUndefined();
  });

  const middle = () => document.querySelector("main.view")?.getAttribute("data-tab");
  it.each([
    ["cards", "decide"],
    ["feed", "decide"],
    ["progress", "home"],
    ["desks", "home"],
    ["ops", "home"],
    ["plan", "home"],
    ["more", "home"],
    ["costs", "home"],
    ["usage", "page"],
    ["chat", "home"],
  ])("on a wide window ?tab=%s opens %s in the middle column, with no sheet and the chat on the right", async (id, shown) => {
    wide(true);
    const { state } = await start(`/?tab=${id}`);
    expect(middle()).toBe(shown);
    expect(state.app.morePage).toBe(id === "usage" ? "usage" : null);
    expect(sheet()).toBeNull();
    expect(document.querySelector("aside.side .chat")).not.toBeNull();
  });

  it("on a wide window a decision's ?card= opens it in the middle pane, and the worker hears that card is on screen", async () => {
    wide(true);
    const { decide, state } = await start("/?card=d2");
    expect([state.app.tab, middle(), sheet()]).toEqual(["cards", "decide", null]);
    expect(document.querySelector(".decide-pane .card.top")?.getAttribute("data-need")).toBe("d2");
    expect(decide.decideShown()).toBe("d2");
    expect(viewing()).toMatchObject({ card: "d2" });
    expect(location.search).toBe("");
  });

  it("on a wide window a ?card= link to a card minimised here opens it in full in the pane", async () => {
    wide(true);
    const read = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input) === "/api/board"
        ? Promise.resolve(json({ version: 1, updatedAt: NOW, board: { updatedAt: NOW, needs, coming: [], chats: [], shipped: [] }, minimised: [["d2", "rev-d2"]] }))
        : read(input, init),
    );
    const { decide } = await start("/?card=d2");
    expect(document.querySelector(".decide-pane .card.top")?.getAttribute("data-need")).toBe("d2");
    expect(decide.decideShown()).toBe("d2");
  });

  it("on a wide window the worker hears both the pane's card and the conversation open beside it", async () => {
    wide(true);
    const { chat } = await start("/?conversation=k1");
    expect(chat.openConversation()).toBe("k1");
    await push({ type: "open-card", id: "d2" });
    expect(middle()).toBe("decide");
    expect(viewing()).toMatchObject({ card: "d2", chat: "k1" });
  });

  it("on a wide window ?conversation= opens it in the chat on the right, over the home screen", async () => {
    wide(true);
    const { chat } = await start("/?conversation=k1");
    expect([middle(), sheet()]).toEqual(["home", null]);
    expect(chat.openConversation()).toBe("k1");
    expect(document.querySelector("aside.side .chat")).not.toBeNull();
  });

  it("on a wide window the worker's open-card puts a decision in the middle pane and an update in its own sheet over it; open-tab names the column", async () => {
    wide(true);
    const { decide, state } = await start("/");
    expect([middle(), sheet()]).toEqual(["home", null]);
    await push({ type: "open-card", id: "d2" });
    expect([middle(), sheet(), decide.decideShown()]).toEqual(["decide", null, "d2"]);
    await push({ type: "open-card", id: "u1" });
    expect([state.app.tab, middle(), sheet()]).toEqual(["cards", "decide", null]);
    expect(document.querySelector(`.sheet.update-sheet [data-need="u1"]`)).not.toBeNull();
    await push({ type: "open-tab", tab: "usage" });
    expect([middle(), sheet()]).toEqual(["page", null]);
    await push({ type: "open-tab", tab: "cards" });
    expect([middle(), sheet()]).toEqual(["decide", null]);
  });
});

describe("the home screen before and between reads", () => {
  const pills = () => [...document.querySelectorAll<HTMLElement>(".home-band .floor-line .floor-line-say")];
  const lineOn = () => document.querySelector(".home-band .floor-line")!.classList.contains("is-on");

  afterEach(() => {
    app.notice = null;
    app.offline = null;
    app.loadedAt = null;
    app.slowRead = false;
  });

  it("a board the server has no snapshot of yet (board: null) is not read: a dash, the reading card, never all clear", () => {
    mount();
    app.board = { version: 0, updatedAt: null, board: null } as never;
    changed();
    expect(boardRead()).toBe("reading");
    expect([button("decide").querySelector(".home-decide-n")?.textContent, button("decide").getAttribute("aria-label")]).toEqual(["–", "Decide, not read yet"]);
    button("decide").click();
    expect(sheet()!.querySelector(".decide-wait")).not.toBeNull();
    expect(sheet()!.textContent).not.toContain(NOTHING_NEEDS_YOU);
    // A read that fails then is a failed first read, with no "cards as of" for cards never shown.
    app.loadedAt = Date.parse(NOW);
    app.notice = "Request failed (500)";
    changed();
    expect(boardRead()).toBe("failed");
    expect(pills().some((one) => one.dataset.key === "line-offline")).toBe(false);
  });

  it("the dock's Rivet keeps the neutral face until a board is read, then smiles", () => {
    mount();
    const face = () => {
      const el = document.querySelector(".home-dock .home-rivet-face")!;
      return el.classList.contains("is-happy") ? "happy" : el.classList.contains("is-thinking") ? "thinking" : "other";
    };
    app.board = { version: 0, updatedAt: null, board: null } as never;
    changed();
    expect(face()).toBe("thinking");
    app.notice = "Request failed (500)";
    changed();
    expect(face()).toBe("thinking");
    app.notice = null;
    deal([]);
    expect(face()).toBe("happy");
  });

  it("a wide window's header carries the stale-cards pill", () => {
    wide(true);
    mount();
    deal([]);
    const end = () => document.querySelector<HTMLElement>(".topbar .topbar-end")!;
    expect(end().querySelector('[data-key="alert-offline"]')).toBeNull();
    app.loadedAt = Date.parse(NOW) - 5 * 60_000;
    // A 429 with the network up is a failed read too: Rivet's name, never the server's words.
    app.notice = "Request failed (429)";
    changed();
    const stale = end().querySelector<HTMLElement>('[data-key="alert-offline"]')!;
    expect([stale.className, stale.getAttribute("role"), stale.textContent]).toEqual(["pill pill-alert warn", "status", `Can't reach Rivet · cards as of ${when(app.loadedAt)}`]);
    app.notice = null;
    app.offline = "offline";
    changed();
    expect(end().querySelector('[data-key="alert-offline"]')!.textContent).toBe(`Offline · cards as of ${when(app.loadedAt)}`);
    go("cards");
    changed();
    expect(end().querySelector('[data-key="alert-offline"]')).toBeNull();
    expect(document.querySelectorAll(".feed-offline").length).toBe(1);
  });

  it("Decide's count is a dash, never 0, until the board has loaded", () => {
    mount();
    const n = () => button("decide").querySelector(".home-decide-n")?.textContent;
    expect([n(), button("decide").getAttribute("aria-label"), button("decide").classList.contains("has-cards")]).toEqual(["–", "Decide, not read yet", false]);
    deal([]);
    expect(n()).toBe("0");
    deal([card("d1")]);
    expect(n()).toBe("1");
  });

  it("Decide while reading shows a placeholder card and no Answered or Open 0; a failed read shows Rivet and Try again", () => {
    mount();
    button("decide").click();
    const segs = sheet()!.querySelector<HTMLElement>(".decide-segs")!;
    expect(segs.hidden).toBe(true);
    expect(sheet()!.querySelector(".decide-wait .decide-wait-card")).not.toBeNull();
    expect(sheet()!.querySelector(".decide-wait")!.textContent).toBe("Reading your cards…");
    expect(sheet()!.textContent).not.toContain(NOTHING_NEEDS_YOU);
    const reads = vi.fn((_url: RequestInfo | URL) => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", reads);
    app.notice = "Request failed (500)";
    changed();
    const failed = sheet()!.querySelector<HTMLElement>(".decide-failed")!;
    expect(failed.querySelector(".rivet")).not.toBeNull();
    expect(failed.textContent).toContain("Couldn't read your cards.");
    failed.querySelector<HTMLButtonElement>("button")!.click();
    expect(sheet()!.querySelector(".decide-failed")).toBeNull();
    expect(sheet()!.querySelector(".decide-wait")).not.toBeNull();
    expect(reads.mock.calls.some(([url]) => String(url).includes("/api/board"))).toBe(true);
    deal([card("d1")]);
    expect([segs.hidden, sheet()!.querySelector(".decide-wait")]).toEqual([false, null]);
  });

  it("a read that fails after a load puts an offline strip on the band, and the phone's Decide sheet its offline bar", () => {
    mount();
    deal([]);
    app.loadedAt = Date.parse(NOW) - 5 * 60_000;
    app.offline = "offline";
    changed();
    const strip = pills().find((one) => one.dataset.key === "line-offline")!;
    expect(strip.textContent).toBe(`Offline · cards as of ${when(app.loadedAt)}`);
    button("decide").click();
    expect(sheet()!.querySelector(".feed-offline")!.textContent).toContain(`Offline · cards as of ${when(app.loadedAt)}`);
    app.offline = null;
    changed();
    // The line folds away with its last words kept, so it fades out as it was.
    expect(lineOn()).toBe(false);
    expect(sheet()!.querySelector(".feed-offline")).toBeNull();
    // A refused read (a 429) with the network up: the sheet says so over its stale cards, as the band does.
    app.notice = "Request failed (429)";
    changed();
    expect(sheet()!.querySelector(".feed-offline")!.textContent).toContain(`Can't reach Rivet · cards as of ${when(app.loadedAt)}`);
  });
});
