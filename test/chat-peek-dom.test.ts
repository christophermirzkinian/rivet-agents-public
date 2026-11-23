// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import type { LogsResponse } from "../src/shared/command.js";
import { logFeed } from "../src/shared/log-feed.js";
import { screenView } from "../src/shared/screen-view.js";
import type { Worker } from "../src/shared/workers.js";
import * as api from "../web/src/api.js";
import { ApiError } from "../web/src/api.js";
import * as cmd from "../web/src/command-api.js";
import { opsData } from "../web/src/ops-data.js";
import { app, changed } from "../web/src/state.js";
import { dueText, openChatPeek, type PeekFacts } from "../web/src/views/chat-peek.js";
import { askTime } from "../web/src/views/your-asks.js";
import { closeSheet, closeTallSheet } from "../web/src/views/sheet.js";

const MS = "example-org/example-repo" as const;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const worker: Worker = { id: "w1", name: "Nina", repo: MS, chat: "search-calls", state: "working", lastOutputAt: Date.now() };
const facts = (over: Partial<PeekFacts> = {}): PeekFacts => ({ worker, title: "Search box: results move up", project: "example-repo", asks: [], stage: "In review", time: null, prs: [{ number: 21, repo: worker.repo }], ...over });

let reads: (LogsResponse | null)[] = [];
let subscribe: MockInstance<typeof cmd.subscribeLogs>;
let poll: MockInstance<typeof cmd.getLogsIfChanged>;
let answered: MockInstance<typeof api.getAnswered>;
let statuses: MockInstance<typeof api.getOpsStatuses>;
const logs = (lines: string[], times: (string | null)[] = []): LogsResponse => ({ repo: MS, chat: worker.chat, lines, times, updatedAt: null, leaseUntil: null, screen: screenView(lines), feed: logFeed(lines, times) });

beforeEach(() => {
  app.status = { board: { version: 1, updatedAt: new Date().toISOString() }, bridge: { connected: true, lastSeenAt: new Date().toISOString() } } as never;
  app.workersAt = Date.now();
  app.workers = { at: new Date().toISOString(), workers: [worker] };
  subscribe = vi.spyOn(cmd, "subscribeLogs").mockResolvedValue({ leaseUntil: "later" });
  answered = vi.spyOn(api, "getAnswered").mockResolvedValue({ cards: [], reopened: [] });
  statuses = vi.spyOn(api, "getOpsStatuses").mockResolvedValue({ statuses: [] } as never);
  // Unread, the sheet keeps the list's row; a test that needs the whole ask serves it.
  vi.spyOn(api, "getAsk").mockRejectedValue(new Error("not served"));
  poll = vi.spyOn(cmd, "getLogsIfChanged").mockImplementation(async () => {
    const next = reads.length > 1 ? reads.shift()! : (reads[0] ?? null);
    return next ? { logs: next, etag: "e" } : null;
  });
});

afterEach(() => {
  closeTallSheet();
  subscribe.mockRestore();
  poll.mockRestore();
  answered.mockRestore();
  statuses.mockRestore();
  opsData.statuses = null;
  app.board = null;
  reads = [];
  app.status = null;
  app.workers = null;
  app.workersAt = null;
  document.body.replaceChildren();
});

const box = () => document.querySelector<HTMLElement>(".peek-screen")!;
/** Its last words: the Activity row from its chat with the role `last said`. */
const lastSaid = () => [...document.querySelectorAll<HTMLElement>(".peek-act")].find((row) => row.querySelector(".peek-role")!.textContent === "last said");

describe("the map's chat sheet", () => {
  it("sets out its screen to read: labelled tools with coloured results, its words as text, no terminal noise", async () => {
    reads = [
      logs(
        [
          "⏺ Bash(pnpm vitest run callouts)",
          "  ⎿  ✓ 14 passed (2.1s)",
          "⏺ Bash(pnpm test:e2e)",
          "  ⎿  Error: 2 failed",
          "⏺ Callouts now sit in the top band, clear of the chart.",
          "✽ Waiting for CI… (2m 10s · ↓ 1.2k tokens)",
          "────────────",
          "❯",
          "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
        ],
        [null, null, null, null, "2026-11-02T04:20:00.000Z", null, null, null, null],
      ),
    ];
    openChatPeek(worker, () => facts());
    await settle();
    await settle();
    const calls = [...box().querySelectorAll(".peek-call")].map((call) => [call.querySelector(".peek-tool-name")!.textContent, call.querySelector(".peek-tool-detail")!.textContent]);
    expect(calls).toEqual([
      ["Bash", "pnpm vitest run callouts"],
      ["Bash", "pnpm test:e2e"],
    ]);
    expect([...box().querySelectorAll(".peek-result li")].map((li) => [li.textContent, li.getAttribute("data-tone")])).toEqual([
      ["✓ 14 passed (2.1s)", "ok"],
      ["Error: 2 failed", "bad"],
    ]);
    expect(box().querySelector(".peek-said")!.textContent).toBe("Callouts now sit in the top band, clear of the chart.");
    expect(box().lastElementChild!.textContent).toBe("Busy · 2m 10s");
    expect(box().textContent).not.toMatch(/bypass|❯|─|tokens/);
    expect(lastSaid()!.querySelector(".peek-act-text")!.textContent).toBe("Callouts now sit in the top band, clear of the chart.");
    expect(lastSaid()!.querySelector(".peek-act-at")).not.toBeNull();
    expect(document.querySelector(".peek-note")!.textContent).toBe("Masked on the Mac · every 2s");
  });

  it("takes its last words from what the box shows as said, not a tool under way", async () => {
    reads = [logs(["⏺ Still tracing #72.", "⏺ Reading the freeze decision note", "⎿  $ sed -n 1,30p docs/a.md"])];
    openChatPeek(worker, () => facts());
    await settle();
    await settle();
    expect(lastSaid()!.querySelector(".peek-act-text")!.textContent).toBe("Still tracing #72.");
    expect(lastSaid()!.querySelector(".peek-act-at")).toBeNull();
  });

  it("keeps the newest in view as it updates, unless you have scrolled up", async () => {
    reads = [logs(["⏺ One."]), logs(["⏺ One.", "⏺ Two."]), logs(["⏺ One.", "⏺ Two.", "⏺ Three."])];
    openChatPeek(worker, () => facts());
    const el = box();
    let top = 0;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 300 });
    Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (value: number) => void (top = value) });
    await settle();
    await settle();
    expect(top).toBe(1000);
    // Scrolled up to read: a new line leaves the place.
    top = 200;
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await settle();
    expect(el.textContent).toContain("Two.");
    expect(top).toBe(200);
    // Back at the foot: it follows again.
    top = 700;
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await settle();
    expect(el.textContent).toContain("Three.");
    expect(top).toBe(1000);
  });

  it("says why there is no screen for a PR row, a closed chat and the Mac offline, with the facts still shown", async () => {
    const pr: Worker = { ...worker, id: "pr:example-org/example-repo#21", chat: "pr-21" };
    openChatPeek(pr, () => facts({ worker: pr }));
    expect(box().textContent).toContain("no chat open on the Mac");
    expect(document.querySelector(".peek-strip")!.textContent).toContain("#21");
    expect(subscribe).not.toHaveBeenCalled();
    closeTallSheet();
    // Each PR links in its own repo: an ask's in side-repo and the worktree's signal PR in example-repo, side by side.
    openChatPeek(pr, () => facts({ worker: pr, prs: [{ number: 34, repo: "sam/side-repo" }, { number: 37, repo: worker.repo }] }));
    expect([...document.querySelectorAll<HTMLAnchorElement>(".peek-strip a.peek-pr")].map((a) => a.href.replace("https://github.com/", ""))).toEqual(["sam/side-repo/pull/34", "example-org/example-repo/pull/37"]);
    closeTallSheet();
    const gone: Worker = { ...worker, chat: "gone-chat" };
    openChatPeek(gone, () => facts({ worker: gone }));
    expect(box().textContent).toBe("This chat has closed. Nothing of its screen is kept.");
    closeTallSheet();
    app.status = { board: { version: 1, updatedAt: new Date().toISOString() }, bridge: { connected: false, lastSeenAt: null } } as never;
    openChatPeek(worker, () => facts());
    expect(box().textContent).toContain("The Mac is offline");
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("polls quickly until its screen lands, and with none after 6s says why rather than wait on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    try {
      reads = [logs([])];
      openChatPeek(worker, () => facts());
      await vi.advanceTimersByTimeAsync(5_500);
      expect(box().textContent).toBe("Waiting for its screen…");
      // Every 500ms until the first lines land: the open's own read and eleven more.
      expect(poll).toHaveBeenCalledTimes(12);
      // The Mac has sent nothing: a lease stuck behind a delivery, or a terminal gone.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(box().textContent).toBe("The Mac has not sent its screen yet. It may be busy, or this chat's terminal may have closed. Still asking.");
      // The Mac is reading, but has no lines it can show masked.
      reads = [{ ...logs([]), updatedAt: new Date().toISOString() }];
      await vi.advanceTimersByTimeAsync(500);
      expect(box().textContent).toBe("The Mac is reading its screen but has nothing it can show masked yet. Still reading.");
      // Its screen lands: it shows, and the poll goes back to every 2s.
      reads = [logs(["⏺ Working on it."])];
      await vi.advanceTimersByTimeAsync(500);
      expect(box().textContent).toContain("Working on it.");
      const calls = poll.mock.calls.length;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(poll.mock.calls.length - calls).toBe(2);
      expect(box().textContent).toContain("Working on it.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("with its lease refused, says the refusal in the box after 6s, not Waiting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    subscribe.mockRejectedValue(new ApiError(409, "that chat is not open right now"));
    try {
      reads = [logs([])];
      openChatPeek(worker, () => facts());
      await vi.advanceTimersByTimeAsync(6_500);
      expect(box().textContent).toBe("That chat is not running right now.");
      expect(document.querySelector(".peek-note")!.textContent).toBe("That chat is not running right now.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says why after 6s when its reads fail or never answer, not only when they come back empty", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    try {
      poll.mockRejectedValue(new ApiError(503, "bridge offline"));
      openChatPeek(worker, () => facts());
      await vi.advanceTimersByTimeAsync(6_500);
      expect(box().textContent).toBe("The Mac is offline.");
      closeTallSheet();
      poll.mockImplementation(() => new Promise(() => {}));
      openChatPeek(worker, () => facts());
      await vi.advanceTimersByTimeAsync(6_500);
      expect(box().textContent).toBe("The Mac has not sent its screen yet. It may be busy, or this chat's terminal may have closed. Still asking.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("with its screen gone (a lapsed lease read again from nothing), says why 6s later, not Waiting on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    try {
      reads = [logs(["⏺ Working on it."])];
      openChatPeek(worker, () => facts());
      await vi.advanceTimersByTimeAsync(10_000);
      expect(box().textContent).toContain("Working on it.");
      reads = [logs([])];
      await vi.advanceTimersByTimeAsync(2_000);
      expect(box().textContent).toBe("Waiting for its screen…");
      await vi.advanceTimersByTimeAsync(6_500);
      expect(box().textContent).toBe("The Mac has not sent its screen yet. It may be busy, or this chat's terminal may have closed. Still asking.");
      reads = [logs(["⏺ Back again."])];
      await vi.advanceTimersByTimeAsync(500);
      expect(box().textContent).toContain("Back again.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops its screen when its chat closes while open, and releases the log on close", async () => {
    reads = [logs(["⏺ Working on it."])];
    const release = vi.spyOn(cmd, "releaseLogs").mockResolvedValue({ ok: true });
    try {
      openChatPeek(worker, () => facts());
      await settle();
      await settle();
      expect(box().textContent).toContain("Working on it.");
      app.workers = { at: new Date().toISOString(), workers: [] };
      changed();
      expect(box().textContent).toBe("This chat has closed. Nothing of its screen is kept.");
      expect(lastSaid()).toBeUndefined();
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      release.mockRestore();
    }
  });
});

describe("the chat sheet as a ticket", () => {
  const t = (minutes: number) => new Date(Date.UTC(2026, 10, 18, 21, minutes)).toISOString();
  const still = (n: string) => ({ sha256: n.repeat(64), type: "image/png" as const, name: "s.png", bytes: 10 });
  const ask = {
    id: "a-1",
    words: "Give me three boxes at the top.",
    who: "owner" as const,
    stage: "review" as const,
    chat: worker.chat,
    prs: [41],
    dueHistory: [{ at: t(20), dueAt: t(90), was: t(30), why: "the CI queue is 3 deep" }],
    timeline: [
      { at: t(0), stage: "building" as const, by: "rivet" },
      { at: t(50), stage: "review" as const, by: worker.chat, note: "PR #41 ready" },
    ],
    createdAt: t(0),
    stageAt: t(50),
    updatedAt: t(50),
    version: 3,
  };
  const plan = { id: "plan-1", rev: "r1", kind: "plan", title: "Three boxes across the top", askId: "a-1", chat: worker.chat, since: t(5), points: ["The rows stay below."], size: "S", media: { kind: "stills", stills: [still("a"), still("b")] } };
  const reply = { id: "rp", itemId: "plan-1", itemTitle: plan.title, decision: "choice", choice: "B", text: "Needs you first", rev: "r1", at: t(10), handled: true, item: { id: "plan-1", title: plan.title, kind: "plan" } };

  it("opens on Ticket: his words, the plan he picked from, the stills on its cards; the strip and meta over the tabs", async () => {
    answered.mockResolvedValue({ cards: [{ card: plan, reply }], reopened: [] } as never);
    reads = [logs(["⏺ Waiting for CI."])];
    openChatPeek(worker, () => facts({ ask: ask as never, stageKey: "review", prs: [{ number: 41, repo: MS }] }));
    await settle();
    await settle();
    const pane = (name: string) => document.querySelector<HTMLElement>(`.peek-pane[data-pane="${name}"]`)!;
    expect([pane("ticket").hidden, pane("activity").hidden, pane("screen").hidden]).toEqual([false, true, true]);
    expect(document.querySelector(".peek-meta")!.textContent).toMatch(/^a-1 · asked .+ · due moved once$/);
    expect(pane("ticket").querySelector(".peek-words")!.textContent).toBe("Give me three boxes at the top.");
    const box0 = pane("ticket").querySelectorAll(".peek-box")[1]!;
    expect(box0.querySelector("p")!.textContent).toBe("Three boxes across the top");
    expect([...box0.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["The rows stay below."]);
    expect([...box0.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["Picked", "Size"]);
    expect([...pane("ticket").querySelectorAll<HTMLImageElement>(".peek-pic img")].map((img) => img.getAttribute("src"))).toEqual([`/media/${"a".repeat(64)}`, `/media/${"b".repeat(64)}`]);
    // Its screen runs behind the tabs: the last words reach Activity without opening Screen.
    expect(lastSaid()!.querySelector(".peek-act-text")!.textContent).toBe("Waiting for CI.");
  });

  it("Activity lists what happened oldest first, filters by who, and says Lenses has nothing yet rather than invent rows", async () => {
    answered.mockResolvedValue({ cards: [{ card: plan, reply }], reopened: [] } as never);
    reads = [logs([])];
    openChatPeek(worker, () => facts({ ask: ask as never }), "activity");
    await settle();
    await settle();
    const texts = () => [...document.querySelectorAll(".peek-act .peek-act-text")].map((p) => p.textContent);
    expect(texts()).toEqual(["Opened at Building", "Plan card sent: Three boxes across the top", "Picked BNeeds you first", expect.stringMatching(/^Due moved .+ → .+: the CI queue is 3 deep$/), "Moved to In review: PR #41 ready"]);
    expect(document.querySelector(".peek-tab-n")!.textContent).toBe("5");
    expect(document.querySelector<HTMLElement>('.peek-pane[data-pane="ticket"]')!.hidden).toBe(true);
    expect(document.querySelector('.peek-tab[data-tab="activity"]')!.getAttribute("aria-selected")).toBe("true");
    const chip = (who: string) => document.querySelector<HTMLButtonElement>(`.peek-filter[data-who="${who}"]`)!;
    chip("you").click();
    // His typed words sit in a <q>, which the CSS sets in curly quotes.
    expect(texts()).toEqual(["Picked BNeeds you first"]);
    expect(document.querySelector(".peek-act q.peek-words")!.textContent).toBe("Needs you first");
    chip("chat").click();
    expect(texts()).toEqual(["Plan card sent: Three boxes across the top", "Moved to In review: PR #41 ready"]);
    chip("lenses").click();
    expect(texts()).toEqual([]);
    expect(document.querySelector(".peek-act-note")!.textContent).toBe("Review findings don't come to this list yet.");
    expect(chip("lenses").getAttribute("aria-pressed")).toBe("true");
    document.querySelector<HTMLButtonElement>('.peek-tab[data-tab="screen"]')!.click();
    expect(document.querySelector<HTMLElement>('.peek-pane[data-pane="screen"]')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('.peek-pane[data-pane="activity"]')!.hidden).toBe(true);
  });

  it("keeps to its own ask: another ask's, another repo's and older cards stay out; Picked is the plan's own answer; `by` credits only who it names", async () => {
    const other = { ...plan, id: "plan-0", askId: "a-2", title: "An older ask's plan", media: { kind: "stills", stills: [still("z")] } };
    const elsewhere = { ...plan, id: "plan-x", askId: undefined, repo: "sam/other-repo", title: "Another repo's plan" };
    const before = { ...plan, id: "plan-old", askId: undefined, since: t(-30), title: "Before the ask" };
    const loose = { id: "dec-1", rev: "r1", kind: "decision", title: "Keep it?", chat: worker.chat, since: t(40) };
    const looseReply = { ...reply, id: "rp-2", itemId: "dec-1", itemTitle: "Keep it?", choice: "Yes, keep it", text: undefined, at: t(45), item: { id: "dec-1", title: "Keep it?", kind: "decision" } };
    answered.mockResolvedValue({ cards: [{ card: other, reply }, { card: elsewhere }, { card: before }, { card: plan, reply }, { card: loose, reply: looseReply }], reopened: [] } as never);
    const withBy = { ...ask, timeline: [...ask.timeline, { at: t(55), note: "imported", by: "an import" }, { at: t(56), note: "no author" }] };
    reads = [logs([])];
    openChatPeek(worker, () => facts({ ask: withBy as never }), "activity");
    await settle();
    await settle();
    const ticket = document.querySelector<HTMLElement>('.peek-pane[data-pane="ticket"]')!;
    expect(ticket.querySelectorAll(".peek-box")[1]!.querySelector("p")!.textContent).toBe("Three boxes across the top");
    expect([...ticket.querySelectorAll(".peek-box")[1]!.querySelectorAll("dd")][0]!.textContent).toMatch(/^B, /);
    expect(ticket.querySelectorAll(".peek-pic").length).toBe(2);
    const texts = () => [...document.querySelectorAll(".peek-act .peek-act-text")].map((p) => p.textContent);
    expect(texts().join("\n")).not.toMatch(/older ask|Another repo|Before the ask/);
    // A loose card from the chat after the ask counts.
    expect(texts()).toContain("Picked Yes, keep it");
    const chip = (who: string) => document.querySelector<HTMLButtonElement>(`.peek-filter[data-who="${who}"]`)!;
    chip("rivet").click();
    expect(texts()).toEqual(["Opened at Building"]);
    chip("all").click();
    const names = [...document.querySelectorAll(".peek-act .peek-act-name")].map((n) => n.textContent);
    expect(names).toContain("an import");
    expect(names).toContain("The ask");
  });

  it("says it could not read its cards when the read fails, not that there are none, and tries again", async () => {
    vi.useFakeTimers();
    try {
      answered.mockRejectedValueOnce(new Error("offline"));
      reads = [logs([])];
      openChatPeek(worker, () => facts({ ask: ask as never }));
      await vi.advanceTimersByTimeAsync(0);
      const text = () => document.querySelector('.peek-pane[data-pane="ticket"]')!.textContent;
      expect(text()).toContain("Could not read its cards. Trying again shortly.");
      expect(text()).not.toContain("No plan card for this yet.");
      answered.mockResolvedValue({ cards: [{ card: plan, reply }], reopened: [] } as never);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(text()).toContain("Three boxes across the top");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the whole ask for Activity: the list's row has only its newest event, which is never called the opening", async () => {
    const row = { ...ask, timeline: ask.timeline.slice(-1), version: 3 };
    reads = [logs([])];
    openChatPeek(worker, () => facts({ ask: { ...row, stage: "building", timeline: [{ at: t(50), stage: "building" as const, by: "rivet" }] } as never }), "activity");
    await settle();
    await settle();
    const texts = () => [...document.querySelectorAll(".peek-act .peek-act-text")].map((p) => p.textContent);
    expect(texts()).toContain("Moved to Building");
    expect(texts()).not.toContain("Opened at Building");
    closeTallSheet();
    vi.mocked(api.getAsk).mockResolvedValue(ask as never);
    openChatPeek(worker, () => facts({ ask: row as never }), "activity");
    await settle();
    await settle();
    expect(vi.mocked(api.getAsk)).toHaveBeenLastCalledWith("a-1");
    expect(texts()).toContain("Opened at Building");
    expect(texts()).toContain("Moved to In review: PR #41 ready");
  });

  it("reads the whole ask again when the list's row moves to a newer version, keeping its history meanwhile", async () => {
    let listed: Record<string, unknown> = { ...ask, timeline: ask.timeline.slice(-1) };
    vi.mocked(api.getAsk).mockResolvedValue(ask as never);
    reads = [logs([])];
    openChatPeek(worker, () => facts({ ask: listed as never }), "activity");
    await settle();
    await settle();
    const texts = () => [...document.querySelectorAll(".peek-act .peek-act-text")].map((p) => p.textContent);
    expect(texts()).toContain("Opened at Building");
    const moved = { at: t(70), stage: "merging" as const, by: worker.chat };
    const v4 = { ...ask, stage: "merging", timeline: [...ask.timeline, moved], version: 4 };
    vi.mocked(api.getAsk).mockResolvedValue(v4 as never);
    listed = { ...v4, timeline: [moved] };
    changed();
    // Before the read lands, the history stays and the new event joins it.
    expect(texts()).toContain("Opened at Building");
    await settle();
    expect(vi.mocked(api.getAsk)).toHaveBeenCalledTimes(2);
    expect(texts()).toContain("Opened at Building");
    expect(texts().some((text) => text?.startsWith("Moved to Merging"))).toBe(true);
  });

  it("counts a chat's card in its project's repo, and not one in a repo that is none of its", async () => {
    const project = "sam/side-repo";
    const inProject = { ...plan, id: "plan-p", askId: undefined, repo: project, title: "Project PR plan" };
    const stray = { ...plan, id: "plan-s", askId: undefined, repo: "sam/other-repo", title: "Stray plan" };
    answered.mockResolvedValue({ cards: [{ card: inProject }, { card: stray }], reopened: [] } as never);
    reads = [logs([])];
    openChatPeek({ ...worker, project }, () => facts({ worker: { ...worker, project }, ask: { ...ask, repo: undefined } as never }), "activity");
    await settle();
    await settle();
    const all = [...document.querySelectorAll(".peek-act .peek-act-text")].map((p) => p.textContent).join("\n");
    expect(all).toContain("Project PR plan");
    expect(all).not.toContain("Stray plan");
  });

  it("with no ask, takes no card from before the chat started: a reused name keeps the old chat's cards out", async () => {
    const old = { ...plan, id: "plan-old", askId: undefined, since: t(-60), title: "Earlier chat's plan" };
    const mine = { ...plan, id: "plan-new", askId: undefined, since: t(5), title: "This chat's plan" };
    answered.mockResolvedValue({ cards: [{ card: old }, { card: mine }], reopened: [] } as never);
    reads = [logs([])];
    const started = { ...worker, startedAt: Date.parse(t(0)) };
    openChatPeek(started, () => facts({ worker: started }), "activity");
    await settle();
    await settle();
    const all = [...document.querySelectorAll(".peek-act .peek-act-text")].map((p) => p.textContent).join("\n");
    expect(all).toContain("This chat's plan");
    expect(all).not.toContain("Earlier chat's plan");
  });

  it("says the ask's promise in the strip as a due time", () => {
    const now = Date.parse(t(0));
    const due = { ...ask, dueHistory: [], dueAt: t(60) };
    expect(dueText({ ask: due as never, time: { text: askTime(due as never, now)!.text, tone: "due" } }, now)).toMatch(/^Due \S+$/);
    const moved = { ...ask, dueAt: t(60) };
    const promise = askTime(moved as never, now)!.text;
    expect(promise).toMatch(/^now /);
    expect(dueText({ ask: moved as never, time: { text: `2nd in queue · ${promise}`, tone: null } }, now)).toMatch(/^2nd in queue · due \S+$/);
    expect(dueText({ ask: moved as never, time: { text: "tests red 9:00am", tone: "asked" } }, now)).toBe("tests red 9:00am");
  });

  it("with no ask and no cards, every part says so instead of showing nothing", async () => {
    reads = [logs([])];
    openChatPeek(worker, () => facts({ prs: [] }));
    await settle();
    await settle();
    const text = document.querySelector('.peek-pane[data-pane="ticket"]')!.textContent;
    expect(text).toContain("No ask is linked to this chat.");
    expect(text).toContain("No plan card for this yet.");
    expect(text).toContain("No pictures on its cards yet.");
    expect(document.querySelector<HTMLElement>(".peek-meta")!.hidden).toBe(true);
    expect(document.body.textContent).not.toMatch(/\blive\b|refund/i);
  });
});

describe("the ticket's Description: every ask, record or PR the row is about", () => {
  const t = (minutes: number) => new Date(Date.UTC(2026, 10, 21, 20, minutes)).toISOString();
  const mk = (id: string, minutes: number, extra: Record<string, unknown> = {}) =>
    ({ id, words: `the words of ${id}`, who: "owner", stage: "building", chat: worker.chat, prs: [], dueHistory: [], timeline: [{ at: t(minutes), stage: "building" }], createdAt: t(minutes), stageAt: t(minutes), updatedAt: t(minutes), version: 1, ...extra }) as never;
  const ticket = () => document.querySelector<HTMLElement>('.peek-pane[data-pane="ticket"]')!;
  const description = () => ticket().querySelector<HTMLElement>(".peek-box")!;

  it("lists each linked ask newest first: its writeup, then his words, its id, who asked and a link to where", async () => {
    const newer = mk("a-2", 30, { why: "One line on what the change is for.", source: "message:m_7" });
    const older = mk("a-1", 0, { source: `backlog:${MS}#77` });
    const plan = { id: "plan-2", rev: "r1", kind: "plan", title: "Port change plan", askId: "a-1", chat: worker.chat, since: t(5), points: [] };
    app.board = { board: { needs: [plan] } } as never;
    reads = [logs([])];
    openChatPeek(worker, () => facts({ ask: newer, asks: [newer, older] }));
    await settle();
    await settle();
    expect(ticket().querySelector(".peek-h .peek-aside")!.textContent).toBe("2 asks");
    const [first, second] = [...description().querySelectorAll<HTMLElement>(".peek-ask")];
    expect([...first!.children].map((el) => el.className || el.tagName)).toEqual(["peek-writeup", "P", "peek-from", "peek-sources"]);
    expect(first!.querySelector(".peek-writeup")!.textContent).toBe("One line on what the change is for.");
    expect(first!.querySelector(".peek-words")!.textContent).toBe("the words of a-2");
    expect(first!.querySelector(".peek-from")!.textContent).toMatch(/^a-2 · You · /);
    // No writeup is made up for an ask with none.
    expect(second!.querySelector(".peek-writeup")).toBeNull();
    expect(second!.querySelector(".peek-words")!.textContent).toBe("the words of a-1");
    const issue = second!.querySelector<HTMLAnchorElement>('a[data-use="desks.chat.issue-link"]')!;
    expect([issue.textContent, issue.getAttribute("href")]).toEqual(["Issue#77 ›", `https://github.com/${MS}/issues/77`]);
    // The older ask's plan card is on the ticket too.
    expect(ticket().querySelectorAll(".peek-box")[1]!.querySelector("p")!.textContent).toBe("Port change plan");
    expect(ticket().textContent).not.toContain("No ask is linked");

    const open = first!.querySelector<HTMLButtonElement>('button[data-use="desks.chat.open-line"]')!;
    expect(open.textContent).toBe("Open in Chat ›");
    open.click();
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(document.querySelector(".peek-sheet")).toBeNull();
    expect(app.tab).toBe("chat");
  });

  it("one ask's aside: the ask when it has a writeup or is not his, your words when it is only his words", async () => {
    for (const [extra, aside] of [[{ who: "partner" }, "the ask"], [{ why: "A writeup." }, "the ask"], [{}, "your words"]] as const) {
      const one = mk("a-2", 30, extra);
      reads = [logs([])];
      openChatPeek(worker, () => facts({ ask: one, asks: [one] }));
      await settle();
      expect(ticket().querySelector(".peek-h .peek-aside")!.textContent).toBe(aside);
      expect(description().querySelector('[data-use="desks.chat.open-line"]')).toBeNull();
      closeTallSheet();
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
  });

  it("an ask linked through a PR shows that PR beside its source; the cards are the chat's own ask's", async () => {
    const live: Worker = { ...worker, prs: [21] };
    const mine = mk("a-2", 30);
    const viaPr = mk("a-1", 0, { chat: "elsewhere", prs: [21], source: "message:m_7" });
    const plan = { id: "plan-1", rev: "r1", kind: "plan", title: "Port change plan", askId: "a-1", chat: "elsewhere", since: t(5), points: [] };
    app.board = { board: { needs: [plan] } } as never;
    reads = [logs([])];
    openChatPeek(live, () => facts({ worker: live, ask: mine, asks: [mine, viaPr] }));
    await settle();
    await settle();
    const [first, second] = [...description().querySelectorAll<HTMLElement>(".peek-ask")];
    expect(first!.querySelector(".peek-sources")).toBeNull();
    const sources = [...second!.querySelector(".peek-sources")!.children].map((el) => el.getAttribute("data-use"));
    expect(sources).toEqual(["desks.chat.open-line", "desks.chat.pr-link"]);
    expect(second!.querySelector<HTMLAnchorElement>('a[data-use="desks.chat.pr-link"]')!.getAttribute("href")).toBe(`https://github.com/${MS}/pull/21`);
    expect(ticket().querySelectorAll(".peek-box")[1]!.textContent).toContain("No plan card");
    closeTallSheet();
    await new Promise((resolve) => setTimeout(resolve, 450));

    // With no ask of its own, a PR row's cards are its linked asks'.
    const pr: Worker = { ...worker, id: `pr:${MS}#21`, chat: "pr-21", prs: [21], what: "#21 Port change" };
    reads = [logs([])];
    openChatPeek(pr, () => facts({ worker: pr, ask: viaPr, asks: [viaPr] }));
    await settle();
    await settle();
    expect(ticket().querySelectorAll(".peek-box")[1]!.querySelector("p")!.textContent).toBe("Port change plan");
    closeTallSheet();
    await new Promise((resolve) => setTimeout(resolve, 450));

    // The linked ask's chat's newer plan card, which names no ask, is that chat's next ask's, never this PR's.
    const newer = { id: "plan-2", rev: "r1", kind: "plan", title: "Next ask plan", chat: "elsewhere", since: t(40), points: [] };
    app.board = { board: { needs: [plan, newer] } } as never;
    reads = [logs([])];
    openChatPeek(pr, () => facts({ worker: pr, ask: viaPr, asks: [viaPr] }));
    await settle();
    await settle();
    expect(ticket().querySelectorAll(".peek-box")[1]!.querySelector("p")!.textContent).toBe("Port change plan");
    closeTallSheet();
    await new Promise((resolve) => setTimeout(resolve, 450));

    // A chat with no ask of its own lists the ask naming its PR, but its cards stay its own.
    const own = { id: "plan-3", rev: "r1", kind: "plan", title: "Its own plan", chat: worker.chat, since: t(20), points: [] };
    app.board = { board: { needs: [plan, own] } } as never;
    reads = [logs([])];
    openChatPeek(live, () => facts({ worker: live, asks: [viaPr] }));
    await settle();
    await settle();
    expect(description().querySelector(".peek-from")!.textContent).toContain("a-1");
    expect(ticket().querySelectorAll(".peek-box")[1]!.querySelector("p")!.textContent).toBe("Its own plan");
    closeTallSheet();
    await new Promise((resolve) => setTimeout(resolve, 450));

    // A card it sent naming the linked ask is its own too.
    const sent = { id: "plan-4", rev: "r1", kind: "plan", title: "Its plan for a-1", askId: "a-1", chat: worker.chat, since: t(30), points: [] };
    app.board = { board: { needs: [plan, own, sent] } } as never;
    reads = [logs([])];
    openChatPeek(live, () => facts({ worker: live, asks: [viaPr] }));
    await settle();
    await settle();
    expect(ticket().querySelectorAll(".peek-box")[1]!.querySelector("p")!.textContent).toBe("Its plan for a-1");
    closeTallSheet();
    await new Promise((resolve) => setTimeout(resolve, 450));

    // A map row that borrows its ask's chat name still takes only the cards naming the ask.
    const borrowed: Worker = { ...pr, chat: "elsewhere" };
    app.board = { board: { needs: [plan, newer] } } as never;
    reads = [logs([])];
    openChatPeek(borrowed, () => facts({ worker: borrowed, ask: viaPr, asks: [viaPr] }));
    await settle();
    await settle();
    expect(ticket().querySelectorAll(".peek-box")[1]!.querySelector("p")!.textContent).toBe("Port change plan");
  });

  it("a fix chat with no ask shows its ops record: what holds it up, then what it is about, its state and due time", async () => {
    const fix: Worker = { ...worker, chat: "fix-disk-data-9" };
    const record = { kind: "disk", key: "data", state: "in-progress", chat: fix.chat, repo: MS, cause: "the volume filled", note: "a note", eta: "by 3:30pm", since: t(0), updatedAt: t(10), version: 2 };
    statuses.mockResolvedValue({ statuses: [record] } as never);
    reads = [logs([])];
    openChatPeek(fix, () => facts({ worker: fix, prs: [] }));
    await settle();
    await settle();
    expect(description().querySelector(".peek-writeup")!.textContent).toBe("the volume filled");
    expect(description().querySelector(".peek-from")!.textContent).toBe("Red: disk · data · In hand · due by 3:30pm");
    expect(ticket().textContent).not.toContain("No ask is linked");
    const open = description().querySelector<HTMLButtonElement>('button[data-use="desks.chat.open-ops"]')!;
    expect(open.textContent).toBe("Open in Ops ›");
    open.click();
    expect(document.querySelector(".sheet:not(.is-tall) .sheet-title")).not.toBeNull();
    closeSheet();
  });

  it("a PR row with nothing else linked shows its PR's title and a link to it; a chat shows the link alone", async () => {
    const pr: Worker = { ...worker, id: `pr:${MS}#34`, chat: "pr-34", what: "#34 Port change" };
    reads = [logs([])];
    openChatPeek(pr, () => facts({ worker: pr, prs: [{ number: 34, repo: MS }] }));
    await settle();
    await settle();
    expect(description().querySelector("p")!.textContent).toBe("Port change");
    const link = description().querySelector<HTMLAnchorElement>('a[data-use="desks.chat.pr-link"]')!;
    expect(link.getAttribute("href")).toBe(`https://github.com/${MS}/pull/34`);
    expect(ticket().textContent).not.toContain("No ask is linked");
    closeTallSheet();
    await new Promise((resolve) => setTimeout(resolve, 450));

    const live: Worker = { ...worker, what: "Its own words on what it does" };
    reads = [logs([])];
    openChatPeek(live, () => facts({ worker: live, prs: [{ number: 34, repo: MS }] }));
    await settle();
    await settle();
    expect([...description().children].map((el) => el.className)).toEqual(["peek-sources"]);
    expect(description().textContent).not.toContain("Its own words");
  });
});
