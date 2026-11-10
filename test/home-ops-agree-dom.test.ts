// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withWaits } from "../src/server/asks/waits.js";
import { deriveWorkers } from "../src/server/workers.js";
import type { Ask } from "../src/shared/asks.js";
import type { Board, BoardChat, ComingItem } from "../src/shared/board.js";
import type { OpsStatus } from "../src/shared/ops-status.js";
import { opsStatusKey } from "../src/shared/ops-status-key.js";
import { summarize } from "../src/shared/summary.js";
import { NEEDS_YOU } from "../src/shared/words.js";
import { opsData } from "../web/src/ops-data.js";
import { app, changed, deck, needsYou, summary } from "../web/src/state.js";
import { fixedToday, ownRows } from "../web/src/views/ops-plan.js";
import { asksLine, clearWords, opsStatus } from "../web/src/views/progress-mark.js";
import { mountShell } from "../web/src/views/shell.js";
import { askRows } from "../web/src/views/your-asks.js";
import { openCards } from "../web/src/views/decide-sheet.js";
import { closeTallSheet } from "../web/src/views/sheet.js";
import { stubCanvas } from "./canvas-stub.js";

// Every count Rivet shows agrees with GET /api/summary: the Decide badge, the mark, the Cards empty line, and the rows
// Your asks lists. summary.test.ts holds the route to summarize; this holds the screens to the route, fed the same board
// and records.

const NOW = "2026-10-26T04:00:00.000Z";
const REPO = "example-org/example-repo";
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const MIN = 60_000;
const QUEUE = [{ chat: "on-it", repo: REPO as "example-org/example-repo", position: 1, at: Date.parse(NOW) }];
const ask = (id: string, over: Partial<Ask> = {}): Ask =>
  ({ id, chat: "on-it", words: `Ask ${id}`, who: "owner", stage: "building", prs: [], dueHistory: [], timeline: [], createdAt: ago(60 * MIN), stageAt: ago(60 * MIN), updatedAt: ago(60 * MIN), version: 1, ...over }) as Ask;
const twice = [
  { at: ago(30 * MIN), dueAt: ago(10 * MIN), was: ago(40 * MIN) },
  { at: ago(5 * MIN), dueAt: ago(-90 * MIN), was: ago(10 * MIN), why: "deploy queue" },
];
/** Timed for 3:30pm, passed, moved twice, at Your OK, and Rivet's own passed. */
const asks = [
  ask("timed", { dueAt: ago(-30 * MIN) }),
  ask("passed", { dueAt: ago(20 * MIN) }),
  ask("twice", { who: "owner", dueAt: ago(-90 * MIN), dueHistory: twice }),
  ask("paper-trail", { stage: "needs-you" }),
  ask("mine", { who: "rivet", dueAt: ago(5 * MIN) }),
];

const row = (pr: number, extra: Partial<ComingItem> = {}): ComingItem => ({ pr, title: `Row ${pr}`, stage: "building", updatedAt: NOW, touchedAt: NOW, ...extra });
const need = (id: string, rev: string) => ({ id, rev, kind: "question", title: `Card ${id}`, reply: "text", since: ago(60_000) });
const record = (extra: Partial<OpsStatus> & Record<string, unknown>): OpsStatus =>
  ({ kind: "pr", key: "x", state: "in-progress", since: ago(3600_000), updatedAt: ago(60_000), version: 1, ...extra }) as OpsStatus;

/** The board and records both sides read, and the summary the route makes of them. */
function serve(parts: { needs: ReturnType<typeof need>[]; minimised: [string, string][]; coming: ComingItem[]; statuses: OpsStatus[]; asks?: Ask[] }) {
  const board = { updatedAt: NOW, needs: parts.needs, chats: [], coming: parts.coming, shipped: [] };
  app.board = { version: 1, updatedAt: NOW, board, minimised: parts.minimised } as never;
  opsData.statuses = parts.statuses;
  app.workers = { at: NOW, workers: [], pushQueue: QUEUE };
  app.summary = summarize({
    needs: parts.needs,
    minimised: new Map(parts.minimised),
    board: board as never,
    statuses: parts.statuses,
    crew: { workers: [], lapsed: false },
    asks: parts.asks ?? [],
    queue: QUEUE,
    prs: [],
    merged: [],
    now: Date.parse(NOW),
  });
  return app.summary;
}

let unmount: (() => void) | null = null;
const mount = () => {
  unmount?.();
  unmount = mountShell(document.body.firstElementChild as HTMLElement);
};
/** The phone's Decide N, in the home screen's dock. */
const decideN = () => document.querySelector(".home-decide.has-cards .home-decide-n")?.textContent ?? null;
/** The Floor, where the desks are. */
const floor = () => {
  app.tab = "more";
  app.morePage = "floor";
  mount();
};

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  stubCanvas();
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  document.body.replaceChildren(document.createElement("div"));
  app.tab = "cards";
});

afterEach(() => {
  unmount?.();
  unmount = null;
  app.board = null;
  app.summary = null;
  app.workers = null;
  app.workersAt = null;
  opsData.statuses = null;
  opsData.ops = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("Home and Progress agree with the summary", () => {
  it("with cards waiting and asks in hand: the badge, the mark, the empty line and Your asks' rows", () => {
    const served = serve({
      needs: [need("a", "a1"), need("b", "b1"), need("c", "c1")],
      minimised: [["a", "a1"]],
      coming: [],
      statuses: [
        // Rivet's own, timed for 4:00pm; and one fixed today.
        record({ key: opsStatusKey("pr", "2600", REPO), dueAt: "2026-10-26T05:00:00.000Z" }),
        record({ kind: "app", key: "paper-trail", state: "fixed", updatedAt: ago(3600_000) }),
      ],
      asks,
    });
    expect(served).toEqual({ needsYou: 2, minimised: 1, asks: { inHand: 4, noTime: 2, moved: 1 }, nextDoneAt: ago(-30 * MIN) });
    expect(summary()).toEqual(served);
    mount();
    expect(decideN()).toBe(String(served.needsYou));
    expect(deck().length - served.minimised).toBe(served.needsYou);

    // Your asks lists the same asks: in hand is every row above the folds, Your OK's too; amber is what the mark counts.
    const rows = askRows(asks, Date.parse(NOW), ownRows(), fixedToday());
    expect(rows.open).toHaveLength(served.asks.inHand);
    expect([...rows.open, ...rows.own].filter((row) => row.counted)).toHaveLength(served.asks.noTime + served.asks.moved);

    expect(opsStatus().mark).toMatchObject({ dot: "warn", line: "2 no time yet · 1 moved twice" });
    expect(asksLine()).toBe("Your asks: 4 in hand, next done 3:30pm");
  });

  it("a Coming row at Your OK counts once, as its card: needsYou, never in the asks", () => {
    const before = serve({ needs: [], minimised: [], coming: [row(2200)], statuses: [], asks });
    const okCard = { ...need("wait-ok", "w1"), kind: "decision", title: "Your OK: Row 2500", pr: 2500 };
    const served = serve({ needs: [okCard], minimised: [], coming: [row(2200), row(2500, { stage: "owner-ok" })], statuses: [], asks });
    expect(served).toEqual({ ...before, needsYou: 1 });
    mount();
    expect(decideN()).toBe("1");
    expect(opsStatus().mark).toMatchObject({ line: "2 no time yet · 1 moved twice" });
  });

  it("with every card minimised: no badge, the heading says the card waits, and the asks line to Progress", () => {
    const served = serve({ needs: [need("a", "a1")], minimised: [["a", "a1"]], coming: [], statuses: [], asks: [asks[0]!] });
    expect(served).toMatchObject({ needsYou: 0, minimised: 1, asks: { inHand: 1, noTime: 0 } });
    mount();
    expect(decideN()).toBeNull();
    expect(opsStatus().mark).toMatchObject({ dot: null, line: null });
    expect(clearWords()).toMatchObject({ mood: "happy", title: "1 card waits for you, minimised.", lede: "", agents: "Your asks: 1 in hand, next done 3:30pm" });
  });

  it("a minimise tap counts at once, before the summary is read again", () => {
    serve({ needs: [need("a", "a1"), need("b", "b1")], minimised: [], coming: [], statuses: [] });
    expect(summary()).toMatchObject({ needsYou: 2, minimised: 0 });
    app.board = { ...app.board!, minimised: [["b", "b1"]] } as never;
    expect(summary()).toMatchObject({ needsYou: 1, minimised: 1 });
    expect(app.summary).toMatchObject({ needsYou: 2 });
  });
});

/**
 * A board as the server serves it: its wait cards made by withWaits from the Coming rows and chats, and the crew derived
 * from the bridge's snapshot and those cards (a quiet chat a card names waits on you).
 */
function serveWaits(parts: { coming: ComingItem[]; chats: BoardChat[] }) {
  const written = { updatedAt: NOW, needs: [], coming: parts.coming, chats: parts.chats, shipped: [] } as unknown as Board;
  // No answers yet, so no revision is read (server/http.ts's needRev pulls in the server's config).
  const board = withWaits({ board: written, stored: null, asks: [], answers: new Map(), rev: () => "", room: 200, now: new Date(NOW) });
  const snapshot = [
    { worktreeId: "wt-search", repo: REPO, chat: "notes-search", connected: true, lastOutputAt: Date.parse(NOW) - 5_000, agent: "claude" },
    { worktreeId: "wt-trail", repo: REPO, chat: "paper-trail", connected: true, lastOutputAt: Date.parse(NOW) - 400_000, agent: "claude" },
  ];
  const workers = deriveWorkers({ at: NOW, snapshot: { workers: snapshot } } as never, board, "rivet", Date.parse(NOW));
  return show(board, workers);
}

/** Puts a served board and crew in the app, with the summary GET /api/summary makes of them. */
function show(board: Board, workers: ReturnType<typeof deriveWorkers>) {
  const needs = board.needs.map((one, i) => ({ ...one, rev: String(i).repeat(16) }));
  app.board = { version: 1, updatedAt: NOW, board: { ...board, needs }, minimised: [] } as never;
  app.workers = workers;
  app.workersAt = Date.parse(NOW);
  opsData.statuses = [];
  app.summary = summarize({ needs, minimised: new Map(), board, crew: { workers: workers.workers, lapsed: false }, asks: [], statuses: [], queue: [], prs: [], merged: [], now: Date.parse(NOW) });
  return { board, workers, served: app.summary };
}

/** Every place that shows something waiting on you, against summary().needsYou: the mismatches, none when they agree. */
function disagreements(): string[] {
  const want = summary()!.needsYou;
  app.tab = "cards";
  mount();
  const shown: Record<string, number> = {
    badge: Number(decideN() ?? 0),
    nav: needsYou(),
    deck: deck().length,
  };
  floor();
  // Each chat waiting on you says Needs you under its agent on the map.
  shown.bubble = document.querySelectorAll(".desk.is-project .desk-agent-meta.is-needs").length;
  const desk = document.querySelector(".desk.is-rivet .desk-mood")?.textContent ?? null;
  return [
    ...Object.entries(shown).flatMap(([where, count]) => (count === want ? [] : [`${where} ${count}, summary ${want}`])),
    ...((desk === NEEDS_YOU) === want > 0 ? [] : [`desk ${desk}, summary ${want}`]),
  ];
}

describe("every needs-you on Cards and Progress is the summary's", () => {
  const building = row(2200, { chat: "notes-search", etaMinutes: 90 });
  const search: BoardChat = { name: "notes-search", state: "working", doing: "Results row", touchedAt: NOW };

  it("with nothing waiting: no badge, Needs you 0, no Needs you bubble and Rivet's desk calm", () => {
    const { served } = serveWaits({ coming: [building], chats: [search] });
    expect(served.needsYou).toBe(0);
    expect(disagreements()).toEqual([]);
    expect(document.querySelector(".desk.is-rivet .desk-mood")?.textContent).not.toBe(NEEDS_YOU);
  });

  it("with only a Got it card: it is on the Feed, but no badge, Needs you 0 and Rivet's desk calm", () => {
    const written = { updatedAt: NOW, needs: [], coming: [building], chats: [search], shipped: [] } as unknown as Board;
    const { workers } = serveWaits({ coming: [building], chats: [search] });
    const news = { id: "got-it-news", kind: "decision", title: "FYI: nightly ran clean", chat: "notes-search", options: [{ label: "Got it" }], push: "fyi", since: NOW };
    const board = { ...written, needs: [news] } as unknown as Board;
    const served = { ...show(board, workers).served, needsYou: 0 };
    app.summary = served;
    expect(deck().map((card) => card.id)).toEqual(["got-it-news"]);
    expect(summary()!.needsYou).toBe(0);
    expect(needsYou()).toBe(0);
    floor();
    expect(document.querySelector(".desk.is-rivet .desk-mood")?.textContent).not.toBe(NEEDS_YOU);
    // Its chat's desk, working, has no Needs you bubble either, and Decide counts nothing.
    expect(document.querySelectorAll(".desk.is-project .desk-agent-meta.is-needs")).toHaveLength(0);
    app.tab = "cards";
    mount();
    expect(decideN()).toBeNull();
    // Still a card he can open and tap away: the sheet and the pane walk it (openCards), only the counts leave it out.
    expect(openCards().map((card) => card.id)).toEqual(["got-it-news"]);
  });

  it("with one Coming row at Your OK: its one card, the badge, its desk's bubble and Rivet's desk all say 1", () => {
    const ok = row(2488, { title: "Paper Trail idle loop", chat: "paper-trail", stage: "owner-ok", touchedAt: ago(20 * 60_000) });
    const { served, board, workers } = serveWaits({ coming: [building, ok], chats: [search, { name: "paper-trail", state: "idle" }] });
    expect(board.needs.map((card) => [card.id.split("-").slice(0, 2).join("-"), card.title, card.chat])).toEqual([["wait-ok", "Your OK: Paper Trail idle loop", "paper-trail"]]);
    expect(workers.workers.find((one) => one.chat === "paper-trail")?.state).toBe("waiting");
    expect(served.needsYou).toBe(1);
    expect(disagreements()).toEqual([]);
    expect(document.querySelector(".desk.is-project .desk-agent-meta.is-needs")?.textContent).toBe(NEEDS_YOU);
  });

  it("can't tell the old preview's lie: needs emptied with its waiting chat left, the map follows the cards, not the chat", () => {
    const ok = row(2488, { title: "Paper Trail idle loop", chat: "paper-trail", stage: "owner-ok", touchedAt: ago(20 * 60_000) });
    const { board, workers } = serveWaits({ coming: [building, ok], chats: [search, { name: "paper-trail", state: "idle" }] });
    show({ ...board, needs: [] }, workers);
    expect(summary()!.needsYou).toBe(0);
    expect(workers.workers.find((one) => one.chat === "paper-trail")?.state).toBe("waiting");
    expect(disagreements()).toEqual([]);
  });
});

/** The menu drawer, opened from its button when it is not open. */
const drawer = (): HTMLElement => {
  if (!document.querySelector(".menu-sheet .menu-tile")) document.querySelector<HTMLElement>(".menu-open")!.click();
  return document.querySelector<HTMLElement>(".menu-sheet .menu-tile")!.parentElement!;
};
/** The drawer's tile and its number. */
const tileEl = (key: string) => drawer().querySelector<HTMLElement>(`[data-key="tile-${key}"]`)!;
const tile = (key: string) => tileEl(key).querySelector(".menu-tile-n")?.textContent ?? null;

/** /api/ops as the Usage page reads it: Claude's four accounts at 0.4 of 4. */
function serveOps(): void {
  opsData.ops = {
    now: NOW,
    bridge: { connected: true },
    github: null,
    claude: { at: NOW, limits: [10, 10, 10, 10].map((percent, i) => ({ kind: `account_${i + 1}`, label: `Account a${i}***`, percent, severity: "normal", resetsAt: ago(-3 * 24 * 60 * MIN), active: i === 0 })) },
    mac: null,
    flyAt: null,
    flyStale: false,
    flySource: null,
    healthStaleSince: null,
    apps: [],
    summary: { needs: 0, redCi: 0, failingSchedules: 0, appsDown: 0, disk: { freePct: 40, tone: "ok" } },
  } as unknown as typeof opsData.ops;
  opsData.at = Date.now();
  opsData.opsAt = { mono: performance.now(), wall: Date.now() };
}

describe("the menu's Usage number, its own screen's", () => {
  it("says a dash for a reading not in yet, never a 0", () => {
    mount();
    expect(tile("usage")).toBe("–");
    expect(tileEl("usage").nextElementSibling?.classList.contains("menu")).toBe(true);
  });

  it("is the Usage page's figure", async () => {
    serveOps();
    mount();
    expect(tile("usage")).toBe("0.4 of 4");
    // Usage's tile opens Usage, whose Claude figure is the tile's, as More's Usage row says it.
    const usage = tileEl("usage");
    const said = [tile("usage"), usage.getAttribute("aria-label")];
    usage.click();
    await vi.waitFor(() => expect(document.querySelector('.page-sheet .usage-hero[data-section="claude"] .usage-lines')).not.toBeNull());
    // Usage leads with what is left; its used figure, the tile's, is the line under the meter.
    const used = document.querySelector('.page-sheet .usage-hero[data-section="claude"] .usage-lines')?.textContent?.split(" used")[0];
    const of = document.querySelector('.page-sheet .usage-hero[data-section="claude"] .reading-lead-words')?.textContent?.replace(/ left$/, "");
    expect(`${used} ${of}`).toBe(said[0]);
    expect(said[1]).toBe("Usage, Claude 0.4 of 4 weekly limits used");
  });

  it("with no account read Usage is out of every account, as Usage says it", async () => {
    serveOps();
    const ops = opsData.ops!;
    // No account read: this account's own week stands in for one of the four.
    ops.claude = {
      at: NOW,
      limits: [
        { kind: "weekly_all", label: "Weekly (all models)", percent: 62, severity: "normal", resetsAt: ago(-3 * 24 * 60 * MIN) },
        ...["st", "aa", "bb", "cc"].map((who, i) => ({ kind: `account_${i + 1}`, label: `Account ${who}*** (no reading)`, percent: 0, severity: "normal", resetsAt: null })),
      ],
    } as unknown as typeof ops.claude;
    mount();
    expect(tile("usage")).toBe("0.6 of 4");
    expect(tileEl("usage").getAttribute("aria-label")).toBe("Usage, Claude 0.6 of 4 weekly limits used, 3 accounts not read");

    tileEl("usage").click();
    await vi.waitFor(() => expect(document.querySelector('.page-sheet .usage-hero[data-section="claude"] .reading-lead-words')).not.toBeNull());
    expect(document.querySelector('.page-sheet .usage-hero[data-section="claude"] .reading-lead-words')?.textContent).toBe("of 4 left");
  });

  it("a tile keeps the keyboard's focus when a new reading changes its colour", () => {
    serveOps();
    mount();
    const usage = () => tileEl("usage");
    usage().focus();
    expect(usage().className).toContain("t-ok");
    const claude = opsData.ops!.claude!;
    opsData.ops = { ...opsData.ops!, claude: { ...claude, limits: claude.limits.map((limit) => ({ ...limit, percent: 100, severity: "critical" as const })) } };
    changed();
    expect(usage().className).not.toContain("t-ok");
    expect(document.activeElement).toBe(usage());
  });
});
