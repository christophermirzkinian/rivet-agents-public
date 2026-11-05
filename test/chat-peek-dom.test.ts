// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import type { LogsResponse } from "../src/shared/command.js";
import { logFeed } from "../src/shared/log-feed.js";
import { screenView } from "../src/shared/screen-view.js";
import type { Worker } from "../src/shared/workers.js";
import { ApiError } from "../web/src/api.js";
import * as cmd from "../web/src/command-api.js";
import { app, changed } from "../web/src/state.js";
import { openChatPeek, type PeekFacts } from "../web/src/views/chat-peek.js";
import { closeTallSheet } from "../web/src/views/sheet.js";

const MS = "example-org/example-repo" as const;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const worker: Worker = { id: "w1", name: "Nina", repo: MS, chat: "search-calls", state: "working", lastOutputAt: Date.now() };
const facts = (over: Partial<PeekFacts> = {}): PeekFacts => ({ worker, title: "Search box: results move up", project: "example-repo", stage: "In review", time: null, prs: [{ number: 7321, repo: worker.repo }], ...over });

let reads: (LogsResponse | null)[] = [];
let subscribe: MockInstance<typeof cmd.subscribeLogs>;
let poll: MockInstance<typeof cmd.getLogsIfChanged>;
const logs = (lines: string[], times: (string | null)[] = []): LogsResponse => ({ repo: MS, chat: worker.chat, lines, times, updatedAt: null, leaseUntil: null, screen: screenView(lines), feed: logFeed(lines, times) });

beforeEach(() => {
  app.status = { board: { version: 1, updatedAt: new Date().toISOString() }, bridge: { connected: true, lastSeenAt: new Date().toISOString() } } as never;
  app.workersAt = Date.now();
  app.workers = { at: new Date().toISOString(), workers: [worker] };
  subscribe = vi.spyOn(cmd, "subscribeLogs").mockResolvedValue({ leaseUntil: "later" });
  poll = vi.spyOn(cmd, "getLogsIfChanged").mockImplementation(async () => {
    const next = reads.length > 1 ? reads.shift()! : (reads[0] ?? null);
    return next ? { logs: next, etag: "e" } : null;
  });
});

afterEach(() => {
  closeTallSheet();
  subscribe.mockRestore();
  poll.mockRestore();
  reads = [];
  app.status = null;
  app.workers = null;
  app.workersAt = null;
  document.body.replaceChildren();
});

const box = () => document.querySelector<HTMLElement>(".peek-screen")!;

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
    expect(document.querySelector(".peek-last")!.textContent).toBe("Callouts now sit in the top band, clear of the chart.");
    expect(document.querySelector(".peek-last-block .peek-h")!.textContent).toMatch(/^Last said · /);
    expect(document.querySelector(".peek-note")!.textContent).toBe("Masked on the Mac · every 2s");
  });

  it("takes its last words from what the box shows as said, not a tool under way", async () => {
    reads = [logs(["⏺ Still tracing #72.", "⏺ Reading the freeze decision note", "⎿  $ sed -n 1,30p docs/a.md"])];
    openChatPeek(worker, () => facts());
    await settle();
    await settle();
    expect(document.querySelector(".peek-last")!.textContent).toBe("Still tracing #72.");
    expect(document.querySelector(".peek-last-block .peek-h")!.textContent).toBe("Last said");
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
    const pr: Worker = { ...worker, id: "pr:example-org/example-repo#7321", chat: "pr-7321" };
    openChatPeek(pr, () => facts({ worker: pr }));
    expect(box().textContent).toContain("no chat open on the Mac");
    expect(document.querySelector(".peek-facts")!.textContent).toContain("#7321");
    expect(subscribe).not.toHaveBeenCalled();
    closeTallSheet();
    // Each PR links in its own repo: an ask's in side-repo and the worktree's signal PR in example-repo, side by side.
    openChatPeek(pr, () => facts({ worker: pr, prs: [{ number: 34, repo: "sam/side-repo" }, { number: 7437, repo: worker.repo }] }));
    expect([...document.querySelectorAll<HTMLAnchorElement>(".peek-prs a")].map((a) => a.href.replace("https://github.com/", ""))).toEqual(["sam/side-repo/pull/34", "example-org/example-repo/pull/7437"]);
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
      expect(document.querySelector<HTMLElement>(".peek-last-block")!.hidden).toBe(true);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      release.mockRestore();
    }
  });
});
