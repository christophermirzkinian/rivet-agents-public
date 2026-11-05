import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { askMoves, stageSignal, type PullRequest, type StageReadings } from "../src/shared/ask-stages.js";
import type { Ask } from "../src/shared/asks.js";
import type { PushQueueRow, Worker } from "../src/shared/workers.js";
import { syncAskStages } from "../src/server/asks/stages.js";
import { Store } from "../src/server/store.js";

const REPO = "example-org/example-repo" as const;
const NOW = new Date("2026-11-02T00:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

const ask = (id: string, over: Partial<Ask> = {}): Ask => ({
  id,
  words: `Ask ${id}`,
  who: "owner",
  stage: "building",
  chat: "c1",
  repo: REPO,
  prs: [],
  dueHistory: [],
  timeline: [],
  createdAt: at(-60),
  stageAt: at(-60),
  updatedAt: at(-60),
  version: 1,
  ...over,
});
const worker = (chat: string, over: Partial<Worker> = {}): Worker => ({ id: `wt::${chat}`, name: chat, repo: REPO, chat, state: "idle", lastOutputAt: null, ...over });
const pr = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({ repo: REPO, number, draft: false, ...over });
const entry = (chat: string, over: Partial<PushQueueRow> = {}): PushQueueRow => ({ chat, repo: REPO, position: 1, at: NOW.getTime(), ...over });
const reading = (over: Partial<StageReadings> = {}): StageReadings => ({ queue: [], prs: [], merged: [], ...over });

describe("stageSignal's precedence", () => {
  const on = { chat: "c1", repos: [REPO], prs: [7], branch: "b1" };
  const merged = [{ repo: REPO, number: 7, at: at(-5) }];

  it("the queue, then an open PR, then a merge, then nothing", () => {
    expect(stageSignal(on, reading({ queue: [entry("c1")], prs: [pr(7)], merged }))?.stage).toBe("push-queue");
    expect(stageSignal(on, reading({ prs: [pr(7)], merged }))?.stage).toBe("review");
    expect(stageSignal(on, reading({ merged }))?.stage).toBe("deploying");
    expect(stageSignal(on, reading())).toBeNull();
  });

  it("a draft is no review", () => {
    expect(stageSignal(on, reading({ prs: [pr(7, { draft: true })] }))).toBeNull();
  });

  it("joins by the PRs named, by the chat's branch, and by the queue entry's PR or branch", () => {
    expect(stageSignal(on, reading({ prs: [pr(9, { branch: "b1" })] }))).toMatchObject({ stage: "review", pr: 9 });
    expect(stageSignal(on, reading({ prs: [pr(9, { branch: "other" })] }))).toBeNull();
    expect(stageSignal(on, reading({ queue: [entry("c1", { pr: 11 })], prs: [pr(11)] }))).toMatchObject({ stage: "push-queue", pr: 11, open: { number: 11 } });
    expect(stageSignal(on, reading({ queue: [entry("c1", { branch: "b2" })], prs: [pr(12, { branch: "b2" })] }))).toMatchObject({ stage: "push-queue", pr: 12 });
  });

  it("a same-numbered PR or same-named chat in another repo joins nothing, and a short repo name is the same repo", () => {
    const web = "example-org/web-app" as const;
    expect(stageSignal(on, reading({ prs: [pr(7, { repo: web })] }))).toBeNull();
    expect(stageSignal(on, reading({ queue: [entry("c1", { repo: web })] }))).toBeNull();
    expect(stageSignal(on, reading({ merged: [{ repo: "example-repo", number: 7, at: at(-5) }] }))?.stage).toBe("deploying");
  });

  it("a merge from before the ask is an earlier job's, on its checkout or named for context", () => {
    const old = [{ repo: REPO, number: 3, branch: "b1", at: at(-120) }];
    expect(stageSignal({ ...on, prs: [], since: at(-60) }, reading({ merged: old }))).toBeNull();
    expect(stageSignal({ ...on, prs: [3], since: at(-60) }, reading({ merged: old }))).toBeNull();
    expect(stageSignal({ ...on, prs: [3], since: at(-180) }, reading({ merged: old }))?.stage).toBe("deploying");
  });
});

describe("askMoves", () => {
  it("an ask with no repo names its chat's project's PRs, never the default repo's of the same number", () => {
    const web = "example-org/web-app" as const;
    const bare = ask("ask-240", { repo: undefined, prs: [34, 35] });
    const main = pr(34);
    const inBox = [worker("c1", { project: web })];
    expect(askMoves([bare], inBox, reading({ prs: [main] }))).toEqual([]);
    expect(askMoves([bare], inBox, reading({ prs: [main, pr(34, { repo: web })] }))[0]).toMatchObject({ stage: "review" });
    expect(askMoves([bare], inBox, reading({ merged: [{ repo: REPO, number: 35, at: at(-5) }] }))).toEqual([]);
    // An ask with a repo, or a chat with no project, reads as before.
    expect(askMoves([{ ...bare, repo: REPO }], inBox, reading({ prs: [main] }))[0]).toMatchObject({ stage: "review" });
    expect(askMoves([bare], [worker("c1")], reading({ prs: [main] }))[0]).toMatchObject({ stage: "review" });
  });

  it("an ask's named PR is its own repo's, not the same number in its chat's repo", () => {
    const mobile = "example-org/mobile-app" as const;
    const otherRepo = "example-org/other-repo" as const;
    const other = pr(7, { repo: otherRepo, branch: "elsewhere" });
    expect(askMoves([ask("a1", { repo: mobile, stage: "building", prs: [7] })], [worker("c1", { repo: otherRepo, project: mobile, branch: "feature-x" })], reading({ prs: [other] }))).toEqual([]);
  });

  it("a queue entry's PR is in the entry's repo, whatever else its branch matches", () => {
    const mobile = "example-org/mobile-app" as const;
    const otherRepo = "example-org/other-repo" as const;
    const moves = askMoves([ask("a1", { repo: mobile })], [worker("c1", { repo: otherRepo, project: mobile, branch: "feature-x" })], reading({ queue: [entry("c1", { repo: otherRepo, pr: 7, branch: "feature-x" })], prs: [pr(8, { repo: mobile, branch: "feature-x" })] }));
    expect(moves[0]?.stage).toBe("push-queue");
    expect(moves[0]?.pr).toBeUndefined();
  });

  it("a project's ask working in another repo moves with its PR but does not name it: its numbers mean its own repo", () => {
    const mobile = "example-org/mobile-app" as const;
    const moves = askMoves([ask("a1", { repo: mobile })], [worker("c1", { project: mobile, branch: "b1" })], reading({ prs: [pr(7318, { branch: "b1" })] }));
    expect(moves).toHaveLength(1);
    expect(moves[0]?.stage).toBe("review");
    expect(moves[0]?.pr).toBeUndefined();
  });

  it("never moves Needs you, parked, live or done, whatever the readings say", () => {
    const readings = reading({ queue: [entry("c1")], prs: [pr(7)] });
    for (const stage of ["needs-you", "parked", "shipped", "done"] as const) {
      expect(askMoves([ask("a", { stage, prs: [7] })], [worker("c1")], readings)).toEqual([]);
    }
  });

  it("leaves a queued ask with no signal as it is, and moves one with a signal", () => {
    expect(askMoves([ask("a", { stage: "queued" })], [worker("c1")], reading())).toEqual([]);
    expect(askMoves([ask("a", { stage: "queued" })], [worker("c1")], reading({ queue: [entry("c1")] }))[0]?.stage).toBe("push-queue");
  });

  it("moves only the chat's newest open ask", () => {
    const moves = askMoves([ask("old", { createdAt: at(-90) }), ask("new", { createdAt: at(-10) })], [worker("c1")], reading({ queue: [entry("c1")] }));
    expect(moves.map((move) => move.ask.id)).toEqual(["new"]);
  });

  it("a chat gone from its terminal still moves by its queue entry, its repo the entry's when the ask names another", () => {
    const web = "example-org/web-app" as const;
    expect(askMoves([ask("a")], [], reading({ queue: [entry("c1", { repo: web })] }))[0]?.stage).toBe("push-queue");
  });

  it("an ask of no chat moves by the PRs it names", () => {
    const { chat: _chat, ...bare } = ask("a", { prs: [7] });
    expect(askMoves([bare], [], reading({ prs: [pr(7)] }))[0]).toMatchObject({ stage: "review" });
  });

  it("says nothing when the stage already holds and the PR is on the ask's list", () => {
    expect(askMoves([ask("a", { stage: "review", prs: [7] })], [worker("c1")], reading({ prs: [pr(7)] }))).toEqual([]);
  });
});

describe("syncAskStages", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ask-stages-"));
    store = new Store(dir);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the stage and the PR it joined by, keeping the timeline and the promise, with the version up one", () => {
    const earlier = { at: at(-60), stage: "building" as const, by: "rivet" as const };
    store.addAsk(ask("a", { dueAt: at(60), timeline: [earlier] }));
    syncAskStages(store, [worker("c1", { branch: "b1" })], reading({ prs: [pr(9, { branch: "b1" })] }), NOW);
    const saved = store.listAsks({ limit: 10, doneSince: NOW.toISOString() })[0]!;
    expect(saved).toMatchObject({ stage: "review", prs: [9], dueAt: at(60), version: 2 });
    expect(saved.timeline[0]).toEqual(earlier);
    expect(saved.timeline.at(-1)).toMatchObject({ stage: "review", by: "rivet" });
  });

  it("adds a joined PR to the ask's list without touching its stage when the stage holds, and keeps the PRs it had", () => {
    store.addAsk(ask("a", { stage: "review", prs: [3] }));
    syncAskStages(store, [worker("c1", { branch: "b1" })], reading({ prs: [pr(9, { branch: "b1" })] }), NOW);
    expect(store.listAsks({ limit: 10, doneSince: NOW.toISOString() })[0]).toMatchObject({ stage: "review", prs: [3, 9] });
  });

  it("writes nothing when nothing changes: the same reading twice leaves the version where the first put it", () => {
    store.addAsk(ask("a"));
    const readings = reading({ queue: [entry("c1")] });
    syncAskStages(store, [worker("c1")], readings, NOW);
    syncAskStages(store, [worker("c1")], readings, NOW);
    expect(store.listAsks({ limit: 10, doneSince: NOW.toISOString() })[0]).toMatchObject({ stage: "push-queue", version: 2 });
  });

  it("a hand-set stage on an ask with no signal stays", () => {
    store.addAsk(ask("a", { stage: "review" }));
    syncAskStages(store, [worker("c1")], reading(), NOW);
    expect(store.listAsks({ limit: 10, doneSince: NOW.toISOString() })[0]).toMatchObject({ stage: "review", version: 1 });
  });
});
