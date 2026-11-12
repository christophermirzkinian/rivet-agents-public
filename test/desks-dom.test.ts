// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NEEDS_YOU, NOTHING_NEEDS_YOU } from "../src/shared/words.js";

import type { Ask } from "../src/shared/asks.js";
import type { PullRequest, TimelineEvent } from "../src/shared/ops.js";
import type { PushQueueRow, Worker } from "../src/shared/workers.js";
import type * as State from "../web/src/state.js";

const CARDS = vi.hoisted(() => ({ waiting: 0, minimised: 0 }));
// Rivet's mood counts stub cards; with none set, the real deck counts, as the map's ? marks read it (openCards). The
// minimised tests stand the deck in too, so the deck less the counted cards is the minimised ones.
vi.mock("../web/src/state.js", async (importOriginal) => {
  const real = await importOriginal<typeof State>();
  const stub = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}` }));
  return {
    ...real,
    countedCards: () => (CARDS.waiting || CARDS.minimised ? stub(CARDS.waiting) : real.countedCards()),
    deck: () => (CARDS.minimised ? stub(CARDS.waiting + CARDS.minimised) : real.deck()),
  };
});

const ASKS = vi.hoisted(() => ({ open: [] as unknown[] }));
vi.mock("../web/src/views/your-asks.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openAsks: () => ASKS.open,
}));

const BACKLOG = vi.hoisted(() => ({ reads: 0, answer: null as unknown, issue: null as unknown, started: [] as unknown[][], closed: [] as unknown[][] }));
vi.mock("../web/src/api.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getBacklog: async () => {
    BACKLOG.reads += 1;
    return BACKLOG.answer;
  },
  getBacklogIssue: async () => BACKLOG.issue,
  startBacklogIssue: async (...args: unknown[]) => {
    BACKLOG.started.push(args);
    return { ask: "a-9", already: false, start: { repo: args[0], issue: args[1], ask: "a-9", words: "", at: new Date().toISOString(), stage: "queued" } };
  },
  closeBacklogIssue: async (...args: unknown[]) => {
    BACKLOG.closed.push(args);
    return { close: { id: "act-1", status: "waiting", at: new Date().toISOString() } };
  },
}));

const CHATS = vi.hoisted(() => ({ opened: [] as unknown[][] }));
vi.mock("../web/src/views/worker-sheet.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openChatSheet: (...args: unknown[]) => CHATS.opened.push(args),
}));

const { askOf, deskBubble, mountDesks, peekFacts, rowTitle, underWay } = await import("../web/src/views/desks.js");
const { opsData } = await import("../web/src/ops-data.js");
const { app, changed } = await import("../web/src/state.js");

const MS = "example-org/example-repo" as const;
const OTHER = "example-org/other-repo";
const SIDE = "example-org/side-repo";

function worker(id: string, name: string, extra: Partial<Worker> = {}): Worker {
  return { id, name, repo: MS, chat: `chat-${id}`, state: "working", lastOutputAt: Date.now() - 30_000, ...extra } as Worker;
}

function crew(...workers: Worker[]): void {
  app.workersAt = Date.now();
  app.workers = { at: new Date().toISOString(), workers };
  changed();
}

const knownProjects = () => {
  opsData.timeline = { days: [], repos: [MS, OTHER, SIDE] } as never;
};

let stops: (() => void)[] = [];
function mount(): HTMLElement {
  const desks = mountDesks();
  stops.push(desks.stop);
  document.body.append(desks.el);
  return desks.el;
}

const moodOf = (el: HTMLElement) => el.querySelector<HTMLElement>(".desk.is-rivet")!.dataset.mood;
const deskNames = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".desk.is-project")].map((desk) => desk.querySelector(".desk-head .desk-name")!.textContent);

const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const ask = (id: string, over: Partial<Ask> = {}): Ask => ({
  id,
  words: `Ask ${id}`,
  who: "owner",
  stage: "building",
  prs: [],
  dueHistory: [],
  timeline: [],
  createdAt: at(-60),
  stageAt: at(-60),
  updatedAt: at(-60),
  version: 1,
  ...over,
});

// The home as it is once the board has loaded; a test of the first read sets app.board back to null itself.
beforeEach(() => {
  app.board = { version: 1, updatedAt: at(0), board: { updatedAt: at(0), needs: [], coming: [], chats: [], shipped: [] } } as never;
});

afterEach(() => {
  app.board = null;
  CARDS.waiting = 0;
  CARDS.minimised = 0;
  // An empty floor forgets the desks it has shown, so the next test spawns its own.
  crew();
  for (const stop of stops) stop();
  stops = [];
  app.workers = null;
  app.workersAt = null;
  opsData.timeline = null;
  document.body.replaceChildren();
});

describe("the desks", () => {
  it("never asks for a time: each agent's line is its chat's ask row in short, else its stage", () => {
    ASKS.open = [ask("1", { chat: "chat-c", dueAt: at(30) })];
    crew(
      worker("a", "Nina", { what: "Sidebar redesign", stage: "In review" }),
      worker("b", "Otto", { what: "Menu audit", delivering: { title: "Menu audit", stage: "building" } }),
      worker("c", "Ivy", { what: "Menu" }),
    );
    const el = mount();
    expect(el.textContent).not.toMatch(/no time given|Ask for a time/);
    expect(el.querySelectorAll(".desk-ask-time")).toHaveLength(0);
    const metas = [...el.querySelectorAll(".desk-agent-meta")].map((meta) => meta.textContent);
    expect(metas.slice(0, 2)).toEqual(["In review", "Building"]);
    expect(metas[2]).toMatch(/^Building · by /);
    // The ask's own words name the agent's job.
    expect(el.querySelectorAll(".desk-agent-what")[2]!.textContent).toBe("Ask 1");
    ASKS.open = [];
  });

  it("seats a chat under the project set on it, its asks still found through the worktree's repo or the project's", () => {
    const other = SIDE;
    ASKS.open = [ask("mine", { chat: "side-a", stage: "building" }), ask("theirs", { chat: "side-b", repo: other, stage: "merging" })];
    crew(worker("a", "Nina"), worker("b", "Otto", { chat: "side-a", project: other }), worker("c", "Ivy", { chat: "side-b", project: other }));
    const el = mount();
    expect(deskNames(el)).toEqual(["example-repo", "side-repo"]);
    const box = el.querySelector<HTMLElement>(`.desk[data-desk="${SIDE}"]`)!;
    expect(box.querySelectorAll(".desk-agent")).toHaveLength(2);
    expect([...box.querySelectorAll(".desk-agent-what")].map((row) => row.textContent)).toEqual(["Ask mine", "Ask theirs"]);
    expect(el.querySelector(`.desk[data-desk="${MS}"]`)!.querySelectorAll(".desk-agent")).toHaveLength(1);
    ASKS.open = [];
  });

  it("gives each project with a chat at work its own desk, its agents named by their job, the rest dashed slots", () => {
    crew(
      worker("a", "Nina", { what: "Sidebar redesign", progress: 0.4, etaMinutes: 50, updatedAt: new Date().toISOString() }),
      worker("b", "Otto", { repo: OTHER, chat: "site-report" }),
      worker("c", "Ivy", { doing: "Menu layout audit" }),
      worker("h", "Rivet", { rivet: true }),
      worker("d", "Rex", { state: "idle" }),
    );
    const el = mount();
    expect(deskNames(el)).toEqual(["example-repo", "other-repo"]);
    const first = el.querySelector<HTMLElement>(`.desk[data-desk="${MS}"]`)!;
    expect([...first.querySelectorAll(".desk-agent-what")].map((what) => what.textContent)).toEqual(["Sidebar redesign", "Menu layout audit"]);
    // With no ask row, the chat's own share is the bar; the line never says a second time.
    expect(first.querySelector<HTMLElement>(".desk-agent-fill")!.style.width).toBe("40%");
    expect(first.querySelector(".desk-agent-meta")!.textContent).not.toMatch(/by |%/);
    expect(first.querySelector(".desk-count")!.textContent).toBe("2 building");
    expect(el.querySelector(`.desk[data-desk="${OTHER}"] .desk-agent-what`)!.textContent).toBe("site-report");
  });

  it("draws no projects row before any repo is read", () => {
    expect(mount().querySelector(".desks-idle")).toBeNull();
  });

  it("names every project in one row under the boxes, the ones with no box dimmed", () => {
    knownProjects();
    const el = mount();
    const slots = () => [...el.querySelectorAll<HTMLElement>(".desks-idle .desk-slot")];
    const quiet = () => slots().filter((slot) => slot.classList.contains("is-quiet")).map((slot) => slot.textContent);
    const all = ["example-repo", "other-repo", "side-repo"];
    expect(slots().map((slot) => slot.textContent)).toEqual(all);
    expect(quiet()).toEqual(all);
    // Each name is a button that opens its backlog; none is a tab.
    expect(slots().every((slot) => slot.tagName === "BUTTON" && slot.getAttribute("type") === "button" && slot.dataset.use === "desks.project")).toBe(true);
    expect(el.querySelector(".desks-idle [role=tab]")).toBeNull();
    crew(worker("a", "Nina"), worker("b", "Otto", { repo: OTHER }));
    expect(slots().map((slot) => slot.textContent)).toEqual(all);
    expect(quiet()).toEqual(["side-repo"]);
    expect(el.querySelector(`.desk-slot[data-place="${OTHER}"]`)!.classList.contains("is-quiet")).toBe(false);
  });

  it("opens a project's backlog from its name: the asks and issues as read, an ask opening its chat, Back closing it", async () => {
    const { closeTallSheet } = await import("../web/src/views/sheet.js");
    knownProjects();
    BACKLOG.reads = 0;
    CHATS.opened = [];
    BACKLOG.answer = {
      at: at(-40),
      stale: true,
      repos: {
        [MS]: {
          repo: MS,
          total: 386,
          logs: 0,
          ownerTotal: 1,
          owner: [{ number: 56, title: "Header: icons edge to edge", updatedAt: at(-60), labels: ["autonomy:owner"] }],
          recent: [{ number: 73, title: "Chat runner: a chat at its limit stays stuck", updatedAt: at(-60), labels: [] }],
          bugs: [],
          at: at(-40),
          stale: true,
        },
      },
      asks: [{ id: "a-5", words: "Start the new pages", stage: "queued", prs: [], chat: "new-pages", createdAt: at(-60), stageAt: at(-60) }],
    };
    const el = mount();
    el.querySelector<HTMLButtonElement>(`.desk-slot[data-place="${MS}"]`)!.click();
    const sheet = document.querySelector<HTMLElement>(".sheet.backlog-sheet")!;
    expect(sheet.querySelector(".home-sheet-title")!.textContent).toBe("example-repo");
    expect(sheet.querySelector(".backlog-head-sub")!.textContent).toBe("Loading…");
    await vi.waitFor(() => expect(sheet.querySelector(".backlog-section")).not.toBeNull());
    expect(BACKLOG.reads).toBe(1);
    expect(sheet.querySelector(".backlog-head-sub")!.textContent).toBe("1 to start · 1 your call · 386 issues");
    expect(sheet.querySelector(".backlog-note")!.textContent).toMatch(/^GitHub list from /);
    expect([...sheet.querySelectorAll(".backlog-heading")].map((one) => one.firstChild!.textContent)).toEqual(["Your asks", "Needs your call", "Other issues"]);
    expect([...sheet.querySelectorAll(".backlog-tag")].map((one) => one.textContent)).toEqual(["Not started", "Issue", "Issue"]);
    const github = sheet.querySelector<HTMLButtonElement>('.backlog-row[data-key="issue-56"]')!;
    // An issue opens in the sheet.
    expect(github.dataset.use).toBe("backlog.issue");
    const all = sheet.querySelector<HTMLAnchorElement>(".backlog-all")!;
    expect([all.textContent, all.getAttribute("href"), all.target]).toEqual(["All open issues on GitHub ›", `https://github.com/${MS}/issues`, "_blank"]);
    sheet.querySelector<HTMLButtonElement>('.backlog-row[data-key="ask-a-5"]')!.click();
    await vi.waitFor(() => expect(CHATS.opened).toEqual([["new-pages", MS, "ask-a-5", "backlog"]]));
    expect(document.querySelector(".sheet.backlog-sheet")).toBeNull();

    BACKLOG.answer = { at: null, stale: true, repos: {}, asks: [] };
    el.querySelector<HTMLButtonElement>(`.desk-slot[data-place="${SIDE}"]`)!.click();
    const quiet = document.querySelector<HTMLElement>(".sheet.backlog-sheet")!;
    await vi.waitFor(() => expect([...quiet.querySelectorAll(".backlog-note")].map((one) => one.textContent)).toEqual(["GitHub list not read yet", "Nothing waiting"]));
    expect(quiet.querySelector(".backlog-all")!.textContent).toBe("Open side-repo on GitHub ›");
    quiet.querySelector<HTMLButtonElement>('[data-use="backlog.close"]')!.click();
    await vi.waitFor(() => expect(document.querySelector(".sheet.backlog-sheet")).toBeNull());
    closeTallSheet();
  });

  it("opens an issue in the sheet: what its author wrote, Start work once, Close on a second tap, Back to the list", async () => {
    const { closeTallSheet } = await import("../web/src/views/sheet.js");
    knownProjects();
    BACKLOG.started = [];
    BACKLOG.closed = [];
    const recent = [{ number: 73, title: "Chat runner: a chat at its limit stays stuck", updatedAt: at(-60), labels: [] }];
    BACKLOG.answer = { at: at(-1), stale: false, repos: { [MS]: { repo: MS, total: 1, logs: 0, ownerTotal: 0, owner: [], recent, bugs: [], at: at(-1), stale: false } }, asks: [] };
    BACKLOG.issue = {
      detail: { repo: MS, number: 73, title: "Chat runner: a chat at its limit stays stuck", body: "**What happens.** It stays stuck.", author: "sam", createdAt: at(-120), state: "open", url: `https://github.com/${MS}/issues/73`, comments: 2, labels: [], at: at(0) },
      pending: false,
      start: null,
      close: null,
      chat: null,
    };
    try {
      const el = mount();
      el.querySelector<HTMLButtonElement>(`.desk-slot[data-place="${MS}"]`)!.click();
      const sheet = document.querySelector<HTMLElement>(".sheet.backlog-sheet")!;
      await vi.waitFor(() => expect(sheet.querySelector('.backlog-row[data-key="issue-73"]')).not.toBeNull());
      sheet.querySelector<HTMLButtonElement>('.backlog-row[data-key="issue-73"]')!.click();
      expect(sheet.querySelector(".home-sheet-title")!.textContent).toBe("example-repo · #73");
      await vi.waitFor(() => expect(sheet.querySelector(".backlog-issue-meta")!.textContent).toMatch(/^Opened by sam · .+ · 2 comments$/));
      expect(sheet.querySelector(".backlog-head-sub")!.textContent).toBe("Issue · open");
      expect(sheet.querySelector(".backlog-issue-chips")!.textContent).toBe("No labels");
      await vi.waitFor(() => expect(sheet.querySelector(".backlog-md")!.textContent).toContain("It stays stuck."));
      expect(sheet.querySelector(".backlog-md")!.innerHTML).not.toContain("<script");
      expect([...sheet.querySelectorAll(".backlog-issue-foot [data-use]")].map((one) => (one as HTMLElement).dataset.use)).toEqual(["backlog.issue.start", "backlog.issue.ask", "backlog.issue.close", "backlog.issue.github"]);

      const start = sheet.querySelector<HTMLButtonElement>('[data-use="backlog.issue.start"]')!;
      start.click();
      await vi.waitFor(() => expect(start.textContent).toMatch(/^Started /));
      start.click();
      expect(BACKLOG.started).toHaveLength(1);
      expect(BACKLOG.started[0]!.slice(0, 2)).toEqual([MS, 73]);

      const close = sheet.querySelector<HTMLButtonElement>('[data-use="backlog.issue.close"]')!;
      close.click();
      expect(close.textContent).toBe("Tap again to close");
      expect(sheet.querySelector(".backlog-issue-note")!.textContent).toBe("Closes #73 as not needed, with a comment.");
      expect(BACKLOG.closed).toHaveLength(0);
      close.click();
      await vi.waitFor(() => expect(BACKLOG.closed).toHaveLength(1));
      // Close goes back to the list, read again, and the sheet stays open.
      await vi.waitFor(() => expect(sheet.querySelector(".home-sheet-title")!.textContent).toBe("example-repo"));
      expect(document.querySelector(".sheet.backlog-sheet")).not.toBeNull();

      sheet.querySelector<HTMLButtonElement>('.backlog-row[data-key="issue-73"]')!.click();
      expect(sheet.querySelector(".home-sheet-title")!.textContent).toBe("example-repo · #73");
      sheet.querySelector<HTMLButtonElement>('[data-use="backlog.issue.back"]')!.click();
      await vi.waitFor(() => expect(sheet.querySelector(".home-sheet-title")!.textContent).toBe("example-repo"));
      expect(document.querySelector(".sheet.backlog-sheet")).not.toBeNull();
    } finally {
      closeTallSheet();
    }
  });

  it("paints a project's drafts when Ops lands after its list, and says the newest hold nothing when only counts are left", async () => {
    const { closeTallSheet } = await import("../web/src/views/sheet.js");
    const { noteDismissal } = await import("../web/src/ops-data.js");
    const repo = (name: string, over: Record<string, unknown> = {}) => ({ repo: name, total: 0, logs: 0, ownerTotal: 0, owner: [], recent: [], bugs: [], at: at(-1), stale: false, ...over });
    knownProjects();
    opsData.at = Date.now();
    BACKLOG.answer = { at: at(-1), stale: false, repos: { [MS]: repo(MS) }, asks: [] };
    try {
      const el = mount();
      el.querySelector<HTMLButtonElement>(`.desk-slot[data-place="${MS}"]`)!.click();
      const sheet = document.querySelector<HTMLElement>(".sheet.backlog-sheet")!;
      await vi.waitFor(() => expect([...sheet.querySelectorAll(".backlog-note")].map((one) => one.textContent)).toEqual(["Nothing waiting"]));
      const pr = { repo: MS, number: 61, title: "Settings table", url: "", draft: true, author: "sam", labels: [], headAt: at(-30), updatedAt: at(-5), checks: { state: "pass", passed: 1, failed: 0, pending: 0, failing: [] } };
      opsData.opsAt = { mono: performance.now(), wall: Date.now() };
      opsData.ops = { now: new Date().toISOString(), github: { at: new Date().toISOString(), stale: false, prs: [pr] } } as never;
      noteDismissal("pr", "1", null);
      expect([...sheet.querySelectorAll(".backlog-heading")].map((one) => one.firstChild!.textContent)).toEqual(["Drafts nobody is on"]);
      expect(sheet.querySelector('.backlog-row[data-key="pr-61"]')).not.toBeNull();
      closeTallSheet();
      await vi.waitFor(() => expect(document.querySelector(".sheet.backlog-sheet")).toBeNull());

      BACKLOG.answer = { at: at(-1), stale: false, repos: { [OTHER]: repo(OTHER, { total: 30 }) }, asks: [] };
      el.querySelector<HTMLButtonElement>(`.desk-slot[data-place="${OTHER}"]`)!.click();
      const counted = document.querySelector<HTMLElement>(".sheet.backlog-sheet")!;
      await vi.waitFor(() => expect(counted.querySelector(".backlog-head-sub")!.textContent).toBe("30 issues"));
      expect([...counted.querySelectorAll(".backlog-note")].map((one) => one.textContent)).toEqual(["None of the newest to show: the rest are on GitHub below"]);
      closeTallSheet();

      // A list opened with "N more" stays open when Ops lands and nothing on the sheet changed.
      const recent = Array.from({ length: 7 }, (_, i) => ({ number: 100 + i, title: `Issue ${i}`, updatedAt: at(-60 - i), labels: [] }));
      BACKLOG.answer = { at: at(-1), stale: false, repos: { [OTHER]: repo(OTHER, { total: 7, recent }) }, asks: [] };
      await vi.waitFor(() => expect(document.querySelector(".sheet.backlog-sheet")).toBeNull());
      el.querySelector<HTMLButtonElement>(`.desk-slot[data-place="${OTHER}"]`)!.click();
      const long = document.querySelector<HTMLElement>(".sheet.backlog-sheet")!;
      await vi.waitFor(() => expect(long.querySelectorAll(".backlog-row")).toHaveLength(5));
      long.querySelector<HTMLButtonElement>(".backlog-more")!.click();
      expect(long.querySelectorAll(".backlog-row")).toHaveLength(7);
      noteDismissal("pr", "2", null);
      expect(long.querySelectorAll(".backlog-row")).toHaveLength(7);
      expect(long.querySelector(".backlog-more")).toBeNull();
      closeTallSheet();
    } finally {
      opsData.ops = null;
      opsData.at = 0;
    }
  });

  it("says in each bubble what the chat's ask row says, in short: one time, never a second one", () => {
    const w = worker("a", "Nina", { stage: "In review" });
    const now = Date.now();
    expect(deskBubble(w, [], now)).toEqual({ text: "In review", tone: null });
    // Needs you only with an open card behind it: an ask left at needs-you reads as the chat does.
    expect(deskBubble(w, [ask("1", { chat: "chat-a", stage: "needs-you" })], now)).toEqual({ text: "In review", tone: null });
    expect(deskBubble(w, [ask("1", { chat: "chat-a", stage: "needs-you" })], now, true)).toEqual({ text: NEEDS_YOU, tone: "needs" });
    expect(deskBubble(w, [ask("1", { chat: "chat-a", dueAt: at(30) })], now).text).toMatch(/^Building · by /);
    expect(deskBubble(w, [ask("1", { chat: "chat-a", askedForTimeAt: at(-5), dueAt: at(-10) })], now)).toEqual({ text: "Building · no time yet", tone: "asked" });
    const moved = deskBubble(w, [ask("1", { chat: "chat-a", dueAt: at(40), dueHistory: [{ at: at(-20), dueAt: at(40), was: at(-20) }] })], now);
    // Moved once is no mark, so its bubble is plain; moved twice is counted and amber, as its row.
    expect([moved.text.startsWith("Building · now "), moved.tone]).toEqual([true, null]);
    const twice = deskBubble(w, [ask("1", { chat: "chat-a", dueAt: at(40), dueHistory: [{ at: at(-30), dueAt: at(-10), was: at(-40) }, { at: at(-20), dueAt: at(40), was: at(-10) }] })], now);
    expect([twice.text.startsWith("Building · now "), twice.tone]).toEqual([true, "moved"]);
    // The chat's newest open ask, in its own repo; a finished one or another repo's same-named chat never speaks for it.
    const asks = [
      ask("old", { chat: "chat-a", stage: "review", createdAt: at(-90) }),
      ask("new", { chat: "chat-a", stage: "merging", createdAt: at(-10) }),
      ask("done", { chat: "chat-a", stage: "done", createdAt: at(-1) }),
      ask("other", { chat: "chat-a", repo: OTHER, stage: "needs-you", createdAt: at(-2) }),
    ];
    expect(deskBubble(w, asks, now).text).toBe("Merging");
  });

  it("shows Rivet's desk alone and clear when nothing is at work, working while an agent is live, asking while cards wait", () => {
    const el = mount();
    expect(moodOf(el)).toBe("happy");
    expect(el.querySelectorAll(".desk.is-project")).toHaveLength(0);
    expect(el.querySelector(".desk.is-rivet .desk-mood")!.textContent).toBe(NOTHING_NEEDS_YOU);
    crew(worker("a", "Nina"));
    expect(moodOf(el)).toBe("working");
    CARDS.waiting = 2;
    changed();
    expect(moodOf(el)).toBe("asking");
    crew();
    expect(moodOf(el)).toBe("asking");
    CARDS.waiting = 0;
    changed();
    expect(moodOf(el)).toBe("happy");
  });

  it("with only minimised cards waiting, Rivet's desk says they wait, all minimised, never Needs you", () => {
    CARDS.minimised = 3;
    const el = mount();
    expect(moodOf(el)).toBe("happy");
    expect(el.querySelector(".desk.is-rivet .desk-mood")!.textContent).toBe("3 cards wait for you, all minimised.");
    expect(el.querySelector(".desk.is-rivet")!.getAttribute("aria-label")).toBe("Rivet, 3 cards wait for you, all minimised.");
    CARDS.minimised = 1;
    changed();
    expect(el.querySelector(".desk.is-rivet .desk-mood")!.textContent).toBe("1 card waits for you, minimised.");
    // An open card on top of them asks, as ever.
    CARDS.waiting = 1;
    changed();
    expect([moodOf(el), el.querySelector(".desk.is-rivet .desk-mood")!.textContent]).toEqual(["asking", NEEDS_YOU]);
  });

  it("marks amber only an agent holding an open decision card, saying Needs you over its time; one waiting with none reads Waiting", () => {
    const card = (id: string, chat: string) => ({ id, rev: `r-${id}`, kind: "decision", title: `Card ${id}`, chat, since: at(-5), options: [{ label: "Yes" }] });
    app.board = { version: 1, updatedAt: at(0), board: { updatedAt: at(0), needs: [card("n1", "chat-b"), card("n2", "chat-c")], coming: [], chats: [], shipped: [] } } as never;
    ASKS.open = [ask("1", { chat: "chat-c", dueAt: at(30) }), ask("2", { chat: "chat-a", dueAt: at(30) })];
    try {
      crew(
        worker("a", "Nina", { what: "Build it" }),
        worker("b", "Otto", { what: "Intro video", state: "waiting", progress: 0.9 }),
        worker("c", "Ivy", { what: "Asks", needsYou: true }),
        worker("d", "Rex", { what: "Idle loop", state: "waiting" }),
      );
      const el = mount();
      const rows = [...el.querySelectorAll<HTMLElement>(".desk-agent")];
      expect(rows.map((row) => row.classList.contains("is-asking"))).toEqual([false, true, true, false]);
      expect(rows[1]!.querySelector(".desk-agent-meta")!.textContent).toBe(NEEDS_YOU);
      expect(rows[1]!.querySelector(".rivet")!.classList.contains("is-asking")).toBe(true);
      // At work with a card and a time: its words say Needs you, in amber, not its time.
      expect(rows[2]!.querySelector(".desk-agent-meta")!.textContent).toBe(NEEDS_YOU);
      expect(rows[2]!.querySelector(".desk-agent-meta")!.classList.contains("is-needs")).toBe(true);
      expect(rows[0]!.querySelector(".desk-agent-meta")!.textContent).toMatch(/^Building · by /);
      expect(rows[3]!.querySelector(".desk-agent-meta")!.textContent).toBe("Waiting");
      // The pills split the room: Nina building, Otto and Ivy needing you; Rex, waiting with no card, in neither.
      expect([...el.querySelectorAll(".desk-count")].map((pill) => pill.textContent)).toEqual(["2 need you", "1 building"]);
    } finally {
      app.board = null;
      ASKS.open = [];
    }
  });

  it("seats an idle agent whose open ask names a card on another chat, which the server reads idle: its ? and count", () => {
    const card = { id: "menu-idle", rev: "r-k", kind: "decision", title: "Menu idle loop", chat: "menu-colours", since: at(-5), options: [{ label: "v5" }] };
    app.board = { version: 1, updatedAt: at(0), board: { updatedAt: at(0), needs: [card], coming: [], chats: [], shipped: [] } } as never;
    ASKS.open = [ask("1", { chat: "chat-b", stage: "needs-you", cardId: "menu-idle" })];
    try {
      crew(worker("a", "Nina"), worker("b", "Otto", { state: "idle" }), worker("c", "Ivy", { state: "idle" }));
      const el = mount();
      const rows = [...el.querySelectorAll<HTMLElement>(".desk-agent")];
      expect(rows.map((row) => row.querySelector(".desk-agent-name")?.textContent ?? row.textContent)).toHaveLength(2);
      expect(rows[1]!.querySelector(".desk-agent-ask")).not.toBeNull();
      expect([...el.querySelectorAll(".desk-count")].map((pill) => pill.textContent)).toEqual(["1 needs you", "1 building"]);
    } finally {
      app.board = null;
      ASKS.open = [];
    }
  });

  it("reads an ask's cardId as its agent's card, though the card names another chat: a ?, counted, and opened first", async () => {
    const { decideShown } = await import("../web/src/views/decide-sheet.js");
    const { closeTallSheet } = await import("../web/src/views/sheet.js");
    const card = { id: "menu-idle", rev: "r-k", kind: "decision", title: "Menu idle loop", chat: "menu-colours", since: at(-5), options: [{ label: "v5" }, { label: "v6" }] };
    const other = { ...card, id: "intro", rev: "r-i", title: "Intro", chat: "chat-a" };
    app.board = { version: 1, updatedAt: at(0), board: { updatedAt: at(0), needs: [other, card], coming: [], chats: [], shipped: [] } } as never;
    ASKS.open = [ask("1", { chat: "chat-b", stage: "needs-you", cardId: "menu-idle" })];
    try {
      crew(worker("a", "Nina"), worker("b", "Otto", { state: "waiting" }), worker("c", "Ivy"));
      const el = mount();
      const rows = [...el.querySelectorAll<HTMLElement>(".desk-agent")];
      expect(rows.map((row) => !!row.querySelector(".desk-agent-ask"))).toEqual([true, true, false]);
      expect(rows[1]!.querySelector(".desk-agent-meta")!.textContent).toBe(NEEDS_YOU);
      expect([...el.querySelectorAll(".desk-count")].map((pill) => pill.textContent)).toEqual(["2 need you", "1 building"]);
      rows[1]!.querySelector<HTMLButtonElement>("button.desk-agent-tap")!.click();
      expect(decideShown()).toBe("menu-idle");
    } finally {
      closeTallSheet();
      app.board = null;
      ASKS.open = [];
    }
  });

  it("opens a row's chat sheet from a row with no card, and Decide from a row with one", async () => {
    const { decideShown } = await import("../web/src/views/decide-sheet.js");
    const { closeTallSheet } = await import("../web/src/views/sheet.js");
    const card = { id: "menu-idle", rev: "r-k", kind: "decision", title: "Menu idle loop", chat: "chat-b", since: at(-5), options: [{ label: "v5" }, { label: "v6" }] };
    app.board = { version: 1, updatedAt: at(0), board: { updatedAt: at(0), needs: [card], coming: [], chats: [], shipped: [] } } as never;
    ASKS.open = [ask("1", { chat: "chat-a", words: "the callouts should be off the page", stage: "review", prs: [21] })];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ error: "the Mac bridge is offline" }), { status: 503 }));
    try {
      crew(worker("a", "Nina"), worker("b", "Otto", { state: "waiting" }));
      const el = mount();
      const tap = (id: string) => el.querySelector<HTMLButtonElement>(`.desk-agent[data-agent="${id}"] button.desk-agent-tap`)!;
      expect([tap("a").dataset.use, tap("b").dataset.use]).toEqual(["desks.worker.open-chat", "desks.worker.open-card"]);
      tap("a").click();
      const sheet = document.querySelector<HTMLElement>(".sheet.peek-sheet")!;
      expect(sheet).not.toBeNull();
      expect(sheet.querySelector(".peek-title")!.textContent).toBe(el.querySelector('.desk-agent[data-agent="a"] .desk-agent-what')!.textContent);
      const facts = [...sheet.querySelectorAll(".peek-facts dt")].map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]);
      expect(facts).toEqual([
        ["You asked", "the callouts should be off the page"],
        ["Stage", "In review"],
        ["PR", "#21 ›"],
      ]);
      expect(sheet.querySelector(".peek-screen-head .peek-h")!.textContent).toBe("Its screen");
      expect(sheet.textContent).not.toMatch(/live log/i);
      // Read only: nothing to type in.
      expect(sheet.querySelector("textarea, input")).toBeNull();
      expect(decideShown()).toBeNull();
      closeTallSheet();
      tap("b").click();
      expect(decideShown()).toBe("menu-idle");
    } finally {
      closeTallSheet();
      fetchSpy.mockRestore();
      app.board = null;
      ASKS.open = [];
    }
  });

  it("spawns a desk the first time it appears, not when the floor rebuilds or the tab comes back", () => {
    crew(worker("a", "Nina", { what: "One" }));
    const el = mount();
    expect(el.querySelector(`.desk[data-desk="${MS}"]`)!.classList.contains("is-spawn")).toBe(true);
    crew(worker("a", "Nina", { what: "One, further on" }), worker("b", "Otto", { repo: OTHER, what: "Two" }));
    expect(el.querySelector(`.desk[data-desk="${MS}"]`)!.classList.contains("is-spawn")).toBe(false);
    expect(el.querySelector(`.desk[data-desk="${OTHER}"]`)!.classList.contains("is-spawn")).toBe(true);
    // A rebuild with nothing new spawns nothing.
    crew(worker("a", "Nina", { what: "One, nearly done" }), worker("b", "Otto", { repo: OTHER, what: "Two" }));
    expect(el.querySelectorAll(".desk.is-spawn")).toHaveLength(0);
    // Back on the tab: the same desks are already on the floor.
    const again = mount();
    expect(again.querySelectorAll(".desk.is-project")).toHaveLength(2);
    expect(again.querySelectorAll(".desk.is-spawn")).toHaveLength(0);
    // A project that went quiet and starts again spawns its desk again.
    crew(worker("a", "Nina", { what: "One" }));
    expect(el.querySelector(`.desk[data-desk="${OTHER}"]`)).toBeNull();
    crew(worker("a", "Nina", { what: "One" }), worker("b", "Otto", { repo: OTHER, what: "Two" }));
    expect(el.querySelector(`.desk[data-desk="${OTHER}"]`)!.classList.contains("is-spawn")).toBe(true);
  });

  it("rebuilds when an ask's stage moves, so its line and bubble never say the old stage", () => {
    ASKS.open = [ask("1", { chat: "chat-a", stage: "review", dueAt: at(-30) })];
    crew(worker("a", "Nina"));
    const el = mount();
    const desk = el.querySelector(".desk.is-project")!;
    const meta = desk.querySelector(".desk-agent-meta")!.textContent;
    changed();
    expect(desk.isConnected).toBe(true);
    ASKS.open = [ask("1", { chat: "chat-a", stage: "merging", dueAt: at(-30) })];
    changed();
    expect(meta).toBe("In review · no time yet");
    expect(el.querySelector(".desk-agent-meta")!.textContent).toBe("Merging · no time yet");
    expect(desk.isConnected).toBe(false);
    ASKS.open = [];
  });

  it("reads a chat's own ask over a newer one of its project's chat of the same name, and the project's only with none of its own", () => {
    const other = SIDE;
    const otto = worker("b", "Otto", { chat: "build", project: other });
    const row = (id: string, repo: string, createdAt: string) => ({ id, chat: "build", repo, stage: "building", createdAt }) as Ask;
    const theirs = row("theirs", other, "2026-11-02T02:00:00.000Z");
    const own = row("own", MS, "2026-11-02T01:00:00.000Z");
    expect(askOf(otto, [theirs, own])?.id).toBe("own");
    expect(askOf(otto, [theirs])?.id).toBe("theirs");
    expect(askOf(worker("c", "Ivy", { chat: "build" }), [theirs])).toBeUndefined();
  });

  it("a scroll just before the map goes never wakes its bubbles and trips again", () => {
    vi.useFakeTimers();
    try {
      crew(worker("a", "Nina"), worker("b", "Otto", { repo: OTHER }));
      const desks = mountDesks();
      document.body.append(desks.el);
      desks.el.querySelector(".desks-grid")!.dispatchEvent(new Event("scroll"));
      desks.stop();
      vi.advanceTimersByTime(2_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("paints nothing once stopped, so a late read never wakes a map no longer shown", () => {
    const desks = mountDesks();
    desks.stop();
    crew(worker("a", "Nina"));
    desks.paint();
    expect(desks.el.querySelector(".desk.is-project")).toBeNull();
  });

  it("shows no worker's personal name anywhere on the floor", () => {
    const names = ["Nina", "Otto", "Ivy", "Rex", "Lou", "Kit", "Zed", "Bea"];
    crew(
      ...names.map((name, i) =>
        worker(`w${i}`, name, i % 2 ? { chat: `chat-${i}` } : { what: `Job ${i}`, repo: i % 4 ? OTHER : MS, state: i === 2 ? "waiting" : "working" }),
      ),
    );
    CARDS.waiting = 1;
    changed();
    const el = mount();
    const text = el.textContent ?? "";
    expect(el.querySelectorAll(".desk-agent")).toHaveLength(8);
    const shown = names.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
    expect(shown).toEqual([]);
  });
});

describe("the work counts", () => {
  // The Desks tab, the desks and Coming count one crew.
  it("Desks' N at work, the desks' N working and Coming's In progress all count the same live chats", async () => {
    const { workingCount } = await import("../web/src/state.js");
    const { shownComing } = await import("../web/src/views/board.js");
    const { comingFilterBar, comingRows } = await import("../web/src/views/coming-filter.js");
    const at = new Date().toISOString();
    const coming = [
      { title: "Sidebar redesign", stage: "building", chat: "chat-a", updatedAt: at },
      // Stages that say on their way, with no chat at work on them: not In progress.
      { title: "Old review", stage: "review", chat: "chat-gone", updatedAt: at },
      { title: "Old build", stage: "building", updatedAt: at },
      { title: "Half-width menu", stage: "owner-ok", chat: "chat-c", updatedAt: at },
      { title: "Release notes", stage: "shipped", chat: "chat-a" },
    ];
    const board = { coming, chats: [], shipped: [], needs: [] } as unknown as Parameters<typeof shownComing>[0];
    const inProgress = () => {
      const rows = shownComing(board);
      const bar = comingFilterBar(rows, () => {}, comingRows(rows).held);
      return Number(bar.querySelector('[data-filter="in-progress"] .cfilter-n')?.textContent);
    };
    const working = (el: HTMLElement) =>
      [...el.querySelectorAll(".desk-count:not(.is-asking)")].reduce((sum, pill) => sum + Number(/^(\d+) building$/.exec(pill.textContent ?? "")?.[1]), 0);

    const el = mount();
    const crews: Worker[][] = [
      [],
      [worker("a", "Nina")],
      [
        worker("a", "Nina"),
        // At work with no Coming row, and at work while its only item waits on you: each still one In progress row.
        worker("b", "Otto", { repo: OTHER, chat: "site-report", doing: "Site report" }),
        worker("c", "Ivy", { needsYou: true }),
        worker("d", "Rex", { state: "waiting" }),
        worker("h", "Rivet", { rivet: true }),
        worker("e", "Lou", { state: "idle" }),
      ],
    ];
    for (const one of crews) {
      crew(...one);
      const n = workingCount();
      expect(n).toBe(one.filter((w) => w.state === "working" && !w.rivet).length);
      expect(working(el)).toBe(n);
      expect(inProgress()).toBe(n);
    }

    // A lapsed crew counts nobody, everywhere.
    app.workersAt = Date.now() - 24 * 3600_000;
    changed();
    expect(workingCount()).toBe(0);
    expect(working(el)).toBe(0);
    expect(inProgress()).toBe(0);
  });

  it("gives each chat its own repo's row: two chats of one name in two repos never share or swap one", async () => {
    const { comingRowRepo, shownComing } = await import("../web/src/views/board.js");
    const at = new Date().toISOString();
    const board = {
      coming: [{ title: "Site fix", stage: "building", chat: "fix", updatedAt: at }],
      chats: [{ name: "fix", state: "working", repo: OTHER }],
      shipped: [],
      needs: [],
    } as unknown as Parameters<typeof shownComing>[0];
    crew(worker("m", "Nina", { chat: "fix", what: "Menu tiles fix" }), worker("g", "Otto", { chat: "fix", repo: OTHER }));
    const rows = shownComing(board);
    expect(rows.map((row) => row.title)).toEqual(["Site fix", "Menu tiles fix"]);
    // The other repo's chat holds that repo's row; the first repo's chat keeps its own.
    expect(comingRowRepo(board!.chats, rows[0]!)).toBe(OTHER);
    expect(comingRowRepo(board!.chats, rows[1]!) ?? MS).toBe(MS);
  });

  it("opens Copy summary and his chat when Rivet is tapped, the pipeline groups gone to Your asks", () => {
    const el = mount();
    const rivet = el.querySelector<HTMLButtonElement>("button.desk.is-rivet")!;
    expect(rivet).not.toBeNull();
    rivet.click();
    const sheet = document.querySelector<HTMLElement>(".sheet.rivet-sum")!;
    expect(sheet.getAttribute("aria-label")).toBe("Rivet");
    expect(sheet.querySelectorAll(".rivet-sum-group, .rivet-sum-lead")).toHaveLength(0);
    const buttons = [...sheet.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toEqual(expect.arrayContaining(["Copy summary", "Rivet's chat", "Close"]));
  });
});

describe("a crowded floor", () => {
  const card = (id: string, chat: string) => ({ id, rev: `r-${id}`, kind: "decision", title: `Card ${id}`, chat, since: at(-5), options: [{ label: "Yes" }] });
  /** 43 chats: 40 building in the first repo (the 40th left off), two waiting with no card in the other, and last a chat holding a card. */
  const many = () => [
    ...Array.from({ length: 40 }, (_, i) => worker(`w${i}`, `W${i}`, { what: `Job ${i}` })),
    worker("w40", "W40", { repo: OTHER, what: "Job 40", state: "waiting" }),
    worker("w41", "W41", { repo: OTHER, what: "Job 41", state: "waiting" }),
    worker("w42", "W42", { what: "Job 42" }),
  ];
  const rest = () => document.querySelector<HTMLElement>(".sheet.desks-rest-sheet");
  const whats = (root: ParentNode) => [...root.querySelectorAll(".desk-agent-what")].map((what) => what.textContent);

  // Rivet's sheet, opened by a test above, would take the first Back.
  beforeEach(async () => (await import("../web/src/views/sheet.js")).closeSheet());
  afterEach(async () => {
    (await import("../web/src/views/sheet.js")).closeTallSheet();
    app.board = null;
  });

  it("seats 40 and ends on 3 more ›, every agent holding a card kept though last; the pills count the whole team", () => {
    app.board = { version: 1, updatedAt: at(0), board: { updatedAt: at(0), needs: [card("n1", "chat-w42")], coming: [], chats: [], shipped: [] } } as never;
    crew(...many());
    const el = mount();
    expect(el.querySelectorAll(".desk-agent")).toHaveLength(40);
    const more = el.querySelector<HTMLButtonElement>("button.desks-more")!;
    expect(more.textContent).toBe("3 more ›");
    // The last row of the map, under the desks.
    expect(more.previousElementSibling!.classList.contains("desks-grid")).toBe(true);
    expect(whats(el)).toContain("Job 42");
    expect(el.querySelector('.desk-agent[data-agent="w42"] .desk-agent-tap[data-use="desks.worker.open-card"]')).not.toBeNull();
    expect(whats(el)).not.toContain("Job 39");
    // The other repo's two wait in the sheet, so its desk is not drawn, nor shown as a project with nothing at work.
    expect(deskNames(el)).toEqual(["example-repo"]);
    expect([...el.querySelectorAll(".desk-count")].map((pill) => pill.textContent)).toEqual(["1 needs you", "40 building"]);
  });

  it("a tap on 3 more › opens the other three under their projects with their rows' words; it follows the crew and Back closes it", async () => {
    crew(...many());
    const el = mount();
    el.querySelector<HTMLButtonElement>("button.desks-more")!.click();
    const sheet = rest()!;
    expect(sheet.querySelector(".home-sheet-title")!.textContent).toBe("3 more under way");
    expect([...sheet.querySelectorAll(".desks-rest-group > .desk-name")].map((name) => name.textContent)).toEqual(["example-repo", "other-repo"]);
    // With no card on the floor, the last building one is left off: the building go before those waiting.
    expect(whats(sheet)).toEqual(["Job 42", "Job 40", "Job 41"]);
    expect([...sheet.querySelectorAll(".desk-agent-meta")].map((meta) => meta.textContent)).toEqual(["Building", "Waiting", "Waiting"]);
    crew(...many(), worker("w43", "W43", { repo: OTHER, what: "Job 43", state: "waiting" }));
    expect(el.querySelector("button.desks-more")!.textContent).toBe("4 more ›");
    expect(rest()!.querySelector(".home-sheet-title")!.textContent).toBe("4 more under way");
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rest()).toBeNull();
  });

  it("seats 40 though 41 hold cards, and the other holder's row in 2 more › keeps its ?", () => {
    const all = Array.from({ length: 42 }, (_, i) => worker(`w${i}`, `W${i}`, { what: `Job ${i}` }));
    const needs = all.slice(0, 41).map((w, i) => card(`n${i}`, `chat-${w.id}`));
    app.board = { version: 1, updatedAt: at(0), board: { updatedAt: at(0), needs, coming: [], chats: [], shipped: [] } } as never;
    crew(...all);
    const el = mount();
    expect(el.querySelectorAll(".desk-agent")).toHaveLength(40);
    expect(el.querySelector("button.desks-more")!.textContent).toBe("2 more ›");
    el.querySelector<HTMLButtonElement>("button.desks-more")!.click();
    expect(whats(rest()!)).toEqual(["Job 40", "Job 41"]);
    expect(rest()!.querySelector('.desk-agent[data-agent="w40"] .desk-agent-ask')).not.toBeNull();
  });

  it("marks a chat whose project is a guess with a quiet ?, on the map and in N more ›, never the needs-you ?", () => {
    const all = Array.from({ length: 42 }, (_, i) => worker(`w${i}`, `W${i}`, { what: `Job ${i}`, ...(i % 2 ? {} : { boxGuess: true }) }));
    crew(...all);
    const el = mount();
    const guess = el.querySelector<HTMLElement>('.desk-agent[data-agent="w0"] .desk-agent-guess')!;
    expect([guess.textContent, guess.getAttribute("role"), guess.getAttribute("aria-label")]).toEqual(["?", "img", "Its project is a guess"]);
    expect(guess.classList.contains("desk-agent-ask")).toBe(false);
    expect(el.querySelector('.desk-agent[data-agent="w1"] .desk-agent-guess')).toBeNull();
    el.querySelector<HTMLButtonElement>("button.desks-more")!.click();
    expect([...rest()!.querySelectorAll(".desk-agent")].map((row) => row.querySelector(".desk-agent-guess") !== null)).toEqual([true, false]);
  });

  it("shows every chat and no more row with 40 at work", () => {
    crew(...many().slice(0, 40));
    const el = mount();
    expect(el.querySelectorAll(".desk-agent")).toHaveLength(40);
    expect(el.querySelector(".desks-more")).toBeNull();
  });

  it("stays on two lines with no headings at 14 rows, and goes to one line under stage headings at 15", () => {
    crew(...many().slice(0, 14));
    const el = mount();
    expect(el.classList.contains("is-crowded")).toBe(false);
    expect(el.querySelectorAll(".desk-agent.is-line, .desk-stage")).toHaveLength(0);
    crew(...many().slice(0, 15));
    expect(el.classList.contains("is-crowded")).toBe(true);
    expect(el.querySelectorAll(".desk-agent.is-line")).toHaveLength(15);
    expect([...el.querySelectorAll(".desk-stage")].map((one) => one.textContent)).toEqual(["Building"]);
  });
});

describe("everything under way", () => {
  const OWN = "sam";
  const pull = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({
    repo: MS,
    number,
    title: `PR ${number}`,
    url: "",
    draft: false,
    author: OWN,
    labels: [],
    headAt: at(-30),
    updatedAt: at(-5),
    checks: { state: "pass", passed: 1, failed: 0, pending: 0, failing: [] },
    ...over,
  });
  const entry = (chat: string, position: number, over: Partial<PushQueueRow> = {}): PushQueueRow => ({ chat, repo: MS, position, at: Date.now(), ...over });
  const merge = (minutes: number, number: number, over: Partial<TimelineEvent> = {}): TimelineEvent => ({ kind: "merged", at: at(-minutes), repo: "example-repo", title: `Merged ${number} (#${number})`, number, ...over });
  const read = (prs: PullRequest[] = [], events: TimelineEvent[] = []) => {
    opsData.at = Date.now();
    opsData.opsAt = { mono: performance.now(), wall: Date.now() };
    opsData.ops = { now: new Date().toISOString(), github: { at: new Date().toISOString(), stale: false, prs } } as never;
    opsData.timeline = { days: [{ day: "today", events }], repos: [MS] } as never;
  };
  const queued = (...rows: PushQueueRow[]) => {
    app.workers!.pushQueue = rows;
    changed();
  };
  const ids = () => underWay().map((w) => w.id);
  const metaOf = (el: HTMLElement, id: string) => el.querySelector(`.desk-agent[data-agent="${id}"] .desk-agent-meta`);
  const pills = (el: HTMLElement) => [...el.querySelectorAll(".desk-count")].map((pill) => pill.textContent);

  afterEach(() => {
    opsData.ops = null;
    opsData.timeline = null;
    opsData.at = 0;
    ASKS.open = [];
    app.board = null;
  });

  it("seats an idle chat with an ask past queued, a queue entry or an open PR; not one with a queued ask and no signal, nor a plain idle one", () => {
    read([pull(7, { branch: "feature" })]);
    ASKS.open = [ask("1", { chat: "chat-a", stage: "review" }), ask("2", { chat: "chat-b", stage: "queued" }), ask("3", { chat: "chat-c", stage: "queued" })];
    crew(
      worker("a", "A", { state: "idle" }),
      worker("b", "B", { state: "idle" }),
      worker("c", "C", { state: "idle" }),
      worker("d", "D", { state: "idle", branch: "feature" }),
      worker("e", "E", { state: "idle" }),
      worker("h", "Rivet", { rivet: true }),
    );
    queued(entry("chat-c", 1));
    expect(ids().sort()).toEqual(["a", "c", "d"]);
  });

  it("gives a queue entry with no terminal its own row, Rivet's none, and an ask whose chat has gone with no signal none", () => {
    read();
    ASKS.open = [ask("1", { chat: "gone" }), ask("2", { chat: "queued-chat", stage: "push-queue", words: "Queued chat's ask" })];
    crew(worker("h", "Rivet", { rivet: true, chat: "rivet-main" }));
    queued(entry("queued-chat", 1), entry("rivet-main", 2));
    expect(ids()).toEqual([`queue:${MS}/queued-chat`]);
    const el = mount();
    expect(el.querySelector(".desk-agent-what")!.textContent).toBe("Queued chat's ask");
    expect(metaOf(el, `queue:${MS}/queued-chat`)!.textContent).toBe("Push queue · 1st");
  });

  it("holds a PR by its repo too: the same number in two repos is two rows", () => {
    const other = OTHER;
    read([pull(7), pull(7, { repo: other })]);
    expect(ids()).toEqual([`pr:${MS}#7`, `pr:${other}#7`]);
  });

  it("an older ask of a chat claims none of its PRs: each keeps its own row", () => {
    read([pull(7), pull(8)]);
    crew();
    ASKS.open = [ask("old", { chat: "c1", prs: [7, 8], createdAt: at(-60) }), ask("new", { chat: "c1", prs: [], createdAt: at(-5) })];
    changed();
    expect(ids()).toEqual([`pr:${MS}#7`, `pr:${MS}#8`]);
    expect(underWay().map((w) => w.chat)).toEqual(["pr-7", "pr-8"]);
  });

  it("a connected chat's newer ask leaves its older ask's PRs rows of their own", () => {
    read([pull(7), pull(8)]);
    crew(worker("a", "Nina", { chat: "c1" }));
    ASKS.open = [ask("old", { chat: "c1", prs: [7, 8], createdAt: at(-60) }), ask("new", { chat: "c1", stage: "building", prs: [], createdAt: at(-5) })];
    changed();
    expect(underWay().map((w) => w.chat)).toEqual(["c1", "pr-7", "pr-8"]);
  });

  it("a chat's board PRs from its older ask keep rows of their own under its newer ask", () => {
    read([pull(7), pull(8)]);
    crew(worker("a", "Nina", { chat: "c1", prs: [7, 8] }));
    ASKS.open = [ask("old", { chat: "c1", prs: [7, 8], createdAt: at(-60) }), ask("new", { chat: "c1", stage: "building", prs: [], createdAt: at(-5) })];
    changed();
    expect(underWay().map((w) => w.chat)).toEqual(["c1", "pr-7", "pr-8"]);
  });

  it("an ask with no repo names its PRs in the default repo, not its chat's", () => {
    read([pull(7, { repo: OTHER, branch: "elsewhere" })]);
    crew(worker("a", "Nina", { chat: "c1", repo: OTHER, project: MS, branch: "feature-x" }));
    ASKS.open = [ask("new", { chat: "c1", prs: [7], createdAt: at(-5) })];
    changed();
    expect(underWay().map((w) => w.id)).toEqual(["a", `pr:${OTHER}#7`]);
  });

  it("an ask's open PR does not hide a merge from before the ask", () => {
    read([pull(42)], [merge(10, 41)]);
    crew();
    ASKS.open = [ask("new", { chat: "c1", prs: [41, 42], createdAt: at(-5) })];
    changed();
    expect(underWay().map((w) => w.chat)).toEqual(["c1", "pr-41"]);
  });

  it("a merge from before the ask keeps its own row, not the new ask's", () => {
    read([], [merge(10, 41)]);
    crew();
    ASKS.open = [ask("new", { chat: "c1", prs: [41], createdAt: at(-5) })];
    changed();
    expect(underWay().map((w) => w.chat)).toEqual(["pr-41"]);
  });

  it("a queue entry with no branch or PR joins no PR that also has no branch", () => {
    read([pull(7, { branch: undefined })]);
    crew();
    queued(entry("queued-chat", 1));
    expect(ids()).toEqual([`queue:${MS}/queued-chat`, `pr:${MS}#7`]);
  });

  it("a lapsed crew loses its chats and queue, not the GitHub readings", () => {
    read([pull(7)]);
    crew(worker("a", "A"));
    queued(entry("queued-chat", 1));
    app.workersAt = Date.now() - 24 * 3600_000;
    changed();
    expect(ids()).toEqual([`pr:${MS}#7`]);
  });

  it("a release's patch merges take every PR it deployed off the map", () => {
    read([], [merge(5, 41, { mergeSha: "aaaa1111" }), merge(4, 42, { mergeSha: "bbbb2222" }), { kind: "deploy", at: at(-2), repo: "example-repo", title: "Deployed", sha: "bbbb2222", patchMerges: ["aaaa1111", "bbbb2222"] } as TimelineEvent]);
    expect(ids()).toEqual([]);
  });

  it("seats an open PR with no chat, whoever wrote it, titled by its number; no draft and none a row holds", () => {
    read([pull(7), pull(8, { author: "someone" }), pull(9, { draft: true }), pull(10, { branch: "held" })]);
    crew(worker("a", "A", { branch: "held" }));
    expect(ids()).toEqual(["a", `pr:${MS}#7`, `pr:${MS}#8`]);
    const el = mount();
    expect(el.querySelector(`.desk-agent[data-agent="pr:${MS}#7"] .desk-agent-what`)!.textContent).toMatch(/^#7 /);
  });

  it("seats a PR merged in the last half hour with no chat, until a deploy or shipped event says it went out", () => {
    read([], [merge(10, 7), merge(40, 8), merge(10, 9, { mergeSha: "abcdef123456" }), { kind: "deploy", at: at(-2), repo: "example-repo", title: "Deploy", sha: "abcdef1" } as TimelineEvent, merge(10, 11), { kind: "shipped", at: at(-1), repo: "example-repo", title: "Shipped", number: 11 } as TimelineEvent]);
    crew();
    expect(ids()).toEqual([`merged:${MS}#7`]);
    const el = mount();
    const row = `merged:${MS}#7`;
    expect(metaOf(el, row)!.textContent).toMatch(/^Deploying · since /);
    // The timeline names the repo short; its sheet links the PR once, in the full repo.
    expect(peekFacts(row)!.prs).toEqual([{ number: 7, repo: MS }]);
  });

  it("says the true stage and its time on two lines: place and promise, tests red in amber, since, No time yet", () => {
    read([pull(7, { ciStartedAt: at(-10) }), pull(8, { checks: { state: "fail", passed: 0, failed: 1, pending: 0, failing: ["CI complete"] }, ciStartedAt: at(-9) }), pull(9)]);
    ASKS.open = [
      ask("1", { chat: "chat-q", stage: "push-queue", dueAt: at(45) }),
      ask("2", { chat: "chat-r", stage: "review", prs: [7], dueAt: at(45) }),
      ask("3", { chat: "chat-s", stage: "review", prs: [8] }),
      ask("4", { chat: "chat-m", stage: "merging", prs: [9] }),
      ask("5", { chat: "chat-l", stage: "building", dueAt: at(-5) }),
    ];
    crew(worker("q", "Q"), worker("r", "R"), worker("s", "S"), worker("m", "M"), worker("l", "L"));
    queued(entry("chat-q", 3));
    const el = mount();
    expect(metaOf(el, "q")!.textContent).toMatch(/^Push queue · 3rd · by /);
    expect(metaOf(el, "r")!.textContent).toMatch(/^In review · by /);
    expect(metaOf(el, "s")!.textContent).toMatch(/^In review · tests red /);
    expect(metaOf(el, "s")!.classList.contains("is-asked")).toBe(true);
    expect(metaOf(el, "m")!.textContent).toMatch(/^Merging · since /);
    expect(metaOf(el, "l")!.textContent).toMatch(/^Building · No time yet|no time yet/i);
    expect(pills(el)).toEqual(["1 merging", "2 in review", "1 push queue", "1 building"]);
    expect(el.querySelector(".is-crowded, .desk-stage")).toBeNull();
    expect(el.textContent).not.toMatch(/\blive\b/i);
  });

  it("at 15 rows: one line each under the stages in order, no Needs you heading, its row in gold with › and whole-row tap, each row's time alone", () => {
    const card = { id: "n1", rev: "r-n1", kind: "decision", title: "Card", chat: "chat-n", since: at(-5), options: [{ label: "Yes" }] };
    app.board = { version: 1, updatedAt: at(0), board: { updatedAt: at(0), needs: [card], coming: [], chats: [], shipped: [] } } as never;
    read([pull(7), pull(8)], [merge(10, 6)]);
    ASKS.open = [ask("1", { chat: "chat-q", stage: "push-queue", dueAt: at(45) }), ask("2", { chat: "chat-b", dueAt: at(45) }), ask("3", { chat: "chat-w0", stage: "merging", prs: [8] })];
    crew(worker("n", "N"), worker("q", "Q"), worker("b", "B"), ...Array.from({ length: 10 }, (_, i) => worker(`w${i}`, `W${i}`)));
    queued(entry("chat-q", 3));
    const el = mount();
    expect(el.classList.contains("is-crowded")).toBe(true);
    expect([...el.querySelectorAll(".desk-stage")].map((one) => one.textContent)).toEqual(["Deploying", "Merging", "In review", "Push queue", "Building"]);
    expect(pills(el)).toEqual(["1 needs you", "1 deploying", "1 merging", "1 in review", "1 push queue", "10 building"]);
    expect(metaOf(el, "n")!.textContent).toBe(`${NEEDS_YOU} ›`);
    expect(metaOf(el, "n")!.classList.contains("is-needs")).toBe(true);
    expect(el.querySelector('.desk-agent[data-agent="n"] .desk-agent-tap[data-use="desks.worker.open-card"]')).not.toBeNull();
    expect(metaOf(el, "q")!.textContent).toMatch(/^3rd · by /);
    expect(metaOf(el, "b")!.textContent).toMatch(/^by /);
    const list = el.querySelector(`.desk[data-desk="${MS}"] .desk-agents`)!;
    expect(list.children[0]!.matches('.desk-agent[data-agent="n"]')).toBe(true);
    expect(el.querySelectorAll(".desk-agent")).toHaveLength(15);
  });

  it("a crowded Push queue reads in queue order, whatever the crew's order", () => {
    read();
    ASKS.open = [ask("1", { chat: "chat-c", stage: "push-queue" }), ask("2", { chat: "chat-a", stage: "push-queue" }), ask("3", { chat: "chat-b", stage: "push-queue" })];
    crew(worker("c", "C"), worker("a", "A"), worker("b", "B"), ...Array.from({ length: 12 }, (_, i) => worker(`w${i}`, `W${i}`)));
    queued(entry("chat-a", 1), entry("chat-b", 2), entry("chat-c", 3));
    const el = mount();
    const queue = [...el.querySelectorAll(".desk-agent")].filter((row) => /^\d+(st|nd|rd|th)/.test(row.querySelector(".desk-agent-meta")!.textContent ?? ""));
    expect(queue.map((row) => row.getAttribute("data-agent"))).toEqual(["a", "b", "c"]);
  });

  it("rebuilds when a row's place moves, though its stage stays", () => {
    read();
    ASKS.open = [ask("1", { chat: "chat-q", stage: "push-queue" })];
    crew(worker("q", "Q"));
    queued(entry("chat-q", 3));
    const el = mount();
    expect(metaOf(el, "q")!.textContent).toBe("Push queue · 3rd");
    queued(entry("chat-q", 2));
    expect(metaOf(el, "q")!.textContent).toBe("Push queue · 2nd");
  });
});

describe("a row's title (short titles)", () => {
  it("a chat with nothing to say reads its name cut to the short-title limit", () => {
    const title = rowTitle(worker("w1", "x", { chat: "rivet-short-titles-review-feedback-followup" }));
    expect(title.length).toBeLessThanOrEqual(32);
    expect(title.endsWith("…")).toBe(true);
    expect(rowTitle(worker("w2", "x", { chat: "site-go-live" }))).not.toMatch(/\blive\b/i);
  });

  it("a home screen row's title runs to two lines' worth before it is cut", () => {
    const chat = "rivet-short-titles-review-feedback-followup-and-the-second-line-of-it-too";
    const two = rowTitle(worker("w1", "x", { chat }), undefined, 60);
    expect(two.length).toBeGreaterThan(32);
    expect(two.length).toBeLessThanOrEqual(60);
    crew(worker("w1", "x", { chat }));
    const el = mount();
    expect(el.querySelector(".desk-agent-what")!.textContent).toBe(two);
  });
});

describe("Rivet's desk before the board has loaded", () => {
  const words = (el: HTMLElement) => el.querySelector(".desk.is-rivet .desk-mood")!.textContent;

  beforeEach(() => {
    app.board = null;
    app.notice = null;
    app.offline = null;
    app.slowRead = false;
  });

  afterEach(() => {
    app.notice = null;
    app.offline = null;
    app.slowRead = false;
  });

  it("reads the home with a neutral face, never a tick or Nothing needs you, then says still reading", () => {
    const el = mount();
    expect([moodOf(el), words(el)]).toEqual(["thinking", "Reading the home…"]);
    expect(el.textContent).not.toContain(NOTHING_NEEDS_YOU);
    expect(el.querySelector(".desks-retry")).toBeNull();
    app.slowRead = true;
    changed();
    expect([moodOf(el), words(el)]).toEqual(["thinking", "Still reading…"]);
  });

  it("a first read that failed says it can't reach Rivet, and Try again reads the board again", () => {
    const reads = vi.fn((_url: RequestInfo | URL) => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", reads);
    app.notice = "Request failed (500)";
    changed();
    const el = mount();
    expect([moodOf(el), words(el)]).toEqual(["thinking", "Can't reach Rivet."]);
    el.querySelector<HTMLButtonElement>(".desks-retry")!.click();
    expect(words(el)).toBe("Reading the home…");
    expect(el.querySelector(".desks-retry")).toBeNull();
    expect(reads.mock.calls.some(([url]) => String(url).includes("/api/board"))).toBe(true);
    vi.unstubAllGlobals();
  });

  it("once the board has come, says what it holds", () => {
    const el = mount();
    app.board = { version: 1, updatedAt: at(0), board: { updatedAt: at(0), needs: [], coming: [], chats: [], shipped: [] } } as never;
    changed();
    expect(moodOf(el)).not.toBe("thinking");
    expect(words(el)).not.toMatch(/reading|reach/i);
  });
});
