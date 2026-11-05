import { describe, expect, it } from "vitest";

import type { Need } from "../src/shared/board.js";
import type { PullRequest, TimelineResponse } from "../src/shared/ops.js";
import type { Worker } from "../src/shared/workers.js";
import { byColumn, kanban, type KanbanInput } from "../web/src/agents-logic.js";

const NOW = Date.parse("2026-10-06T02:00:00Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const R = "example-org/example-repo";

const worker = (chat: string, extra: Partial<Worker> = {}): Worker => ({ id: chat, name: chat, repo: R, chat, state: "working", lastOutputAt: NOW, ...extra });
const pr = (number: number, extra: Partial<PullRequest> = {}): PullRequest => ({
  repo: R,
  number,
  title: `PR ${number}`,
  url: `https://github.com/${R}/pull/${number}`,
  draft: false,
  author: "a",
  labels: [],
  headAt: at(30),
  updatedAt: at(20),
  checks: { state: "pass", passed: 3, failed: 0, pending: 0, failing: [] },
  ...extra,
});
const need = (id: string, extra: Partial<Need> = {}): Need => ({ id, kind: "approval", title: `Card ${id}`, ...extra }) as Need;
const merged = (number: number, minutesAgo: number, branch?: string): TimelineResponse => ({
  repos: [R],
  days: [{ day: "2026-10-06", events: [{ kind: "merged", at: at(minutesAgo), repo: R, title: `PR ${number}`, number, ...(branch ? { branch } : {}) }] }],
});

function input(extra: Partial<KanbanInput>): KanbanInput {
  return { now: NOW, workers: [], chats: [], coming: [], cards: [], prs: [], timeline: null, claims: null, ...extra };
}
const columnOf = (cards: ReturnType<typeof kanban>, chat: string) => cards.find((card) => card.chat === chat)?.column;

describe("Agents board columns", () => {
  it("puts a working chat with no PR, or a draft PR, in Building", () => {
    const cards = kanban(input({ workers: [worker("a"), worker("b", { prs: [10] })], prs: [pr(10, { draft: true })] }));
    expect(columnOf(cards, "a")).toBe("building");
    expect(columnOf(cards, "b")).toBe("building");
  });

  it("puts an open PR in review, and one with CI running in review too, said so", () => {
    const cards = kanban(
      input({
        workers: [worker("a", { prs: [10] }), worker("b", { branch: "x/b" }), worker("c", { prs: [12] })],
        prs: [pr(10), pr(11, { branch: "x/b", ciStartedAt: at(3) }), pr(12, { checks: { state: "pending", passed: 1, failed: 0, pending: 2, failing: [] } })],
      }),
    );
    expect(columnOf(cards, "a")).toBe("review");
    expect(cards.find((card) => card.chat === "a")?.why).toBe("PR open");
    for (const chat of ["b", "c"]) expect([columnOf(cards, chat), cards.find((card) => card.chat === chat)?.why]).toEqual(["review", "CI running"]);
    expect(cards.find((card) => card.chat === "b")?.pr?.number).toBe(11);
  });

  it("puts a chat you have a card for in Waiting on you, ahead of every other column, and a held PR in its own", () => {
    const cards = kanban(
      input({
        workers: [worker("a", { prs: [10] }), worker("b", { prs: [11] }), worker("c-73"), worker("d", { prs: [12] })],
        prs: [pr(10, { ciStartedAt: at(1) }), pr(11, { draft: true, hold: "**Owner hold:** video" }), pr(12)],
        cards: [need("n1", { chat: "a" }), need("n2", { chat: "c-73" }), need("n3", { pr: 12 })],
      }),
    );
    expect(columnOf(cards, "a")).toBe("waiting");
    expect(columnOf(cards, "b")).toBe("building");
    expect(cards.find((card) => card.chat === "b")?.why).toBe("Draft PR · Held: video");
    expect(columnOf(cards, "c-73")).toBe("waiting");
    expect(columnOf(cards, "d")).toBe("waiting");
  });

  it("matches a numbered card name to its live chat, and a card in another repo to no chat here", () => {
    const cards = kanban(input({ workers: [worker("search-box")], cards: [need("n1", { chat: "search-box-73" }), need("n2", { chat: "search-box", repo: "example-org/other-repo" })] }));
    expect(columnOf(cards, "search-box")).toBe("waiting");
    expect(cards.find((card) => card.chat === "search-box")?.why).toBe("Your card: Card n1");
  });

  it("keeps a chat whose PR merged in the last 24 h in Merged, even once the chat has closed, and drops it after", () => {
    const fresh = kanban(input({ workers: [worker("a", { prs: [10] })], chats: [{ name: "b", state: "done", prs: [11] }], timeline: merged(10, 60) }));
    expect(columnOf(fresh, "a")).toBe("merged");
    const closed = kanban(input({ chats: [{ name: "b", state: "done", prs: [11] }], timeline: merged(11, 23 * 60) }));
    expect(columnOf(closed, "b")).toBe("merged");
    const old = kanban(input({ chats: [{ name: "b", state: "done", prs: [11] }], timeline: merged(11, 25 * 60) }));
    expect(columnOf(old, "b")).toBeUndefined();
    // Still open, the chat is back to Building once the day is up.
    expect(columnOf(kanban(input({ workers: [worker("a", { prs: [10] })], timeline: merged(10, 25 * 60) })), "a")).toBe("building");
  });

  it("ties a merge to the chat on its head branch, named on the board or not", () => {
    const timeline = merged(10, 30, "x/a");
    expect(columnOf(kanban(input({ workers: [worker("a", { branch: "x/a" }), worker("b", { branch: "x/b" })], timeline })), "a")).toBe("merged");
    expect(columnOf(kanban(input({ workers: [worker("b", { branch: "x/b" })], timeline })), "b")).toBe("building");
  });

  it("reads a merge from a Coming row's stamp too", () => {
    const cards = kanban(input({ coming: [{ title: "Duel", chat: "duel", pr: 40, mergedAt: at(30) }] }));
    expect(columnOf(cards, "duel")).toBe("merged");
    expect(cards[0]?.task).toBe("Duel");
  });

  it("puts an open PR ahead of an earlier merge: the chat is on its next PR", () => {
    const cards = kanban(input({ workers: [worker("a", { prs: [10, 11] })], prs: [pr(11)], timeline: merged(10, 30) }));
    expect(columnOf(cards, "a")).toBe("review");
    expect(cards[0]?.pr?.number).toBe(11);
  });

  it("leaves out a closed chat with nothing open, waiting or merged lately, and Rivet is never passed in", () => {
    expect(kanban(input({ chats: [{ name: "old", state: "done" }] }))).toEqual([]);
  });

  it("shows claims only once the claims API answers, grouped by chat", () => {
    expect(kanban(input({ workers: [worker("a")] }))[0]?.claims).toBeNull();
    const cards = kanban(
      input({
        workers: [worker("a"), worker("b")],
        claims: [
          { chat: "a", pattern: "pnpm-lock.yaml" },
          { chat: "a", pattern: "web/src/views/**" },
        ],
      }),
    );
    expect(cards.find((card) => card.chat === "a")?.claims).toEqual(["pnpm-lock.yaml", "web/src/views/**"]);
    expect(cards.find((card) => card.chat === "b")?.claims).toEqual([]);
  });

  it("shows a claim on the default repo's chat of its name only, not another repo's", () => {
    const other = "example-org/other-repo";
    const cards = kanban(input({ workers: [worker("lab"), worker("lab", { id: "m-lab", repo: other })], claims: [{ chat: "lab", pattern: "web/**" }] }));
    expect(cards.map((card) => [card.repo, card.claims])).toEqual(
      expect.arrayContaining([
        [R, ["web/**"]],
        [other, []],
      ]),
    );
    expect(cards).toHaveLength(2);
    expect(kanban(input({ workers: [worker("lab", { repo: other })], claims: [{ chat: "lab", pattern: "web/**" }] }))[0]?.claims).toEqual([]);
  });

  it("takes the task from what the chat says it is doing, and the newest update time", () => {
    const [card] = kanban(input({ workers: [worker("a", { doing: "Kanban view", updatedAt: at(5), movedAt: at(50) })], chats: [{ name: "a", state: "working", updatedAt: at(9) }] }));
    expect(card?.task).toBe("Kanban view");
    expect(card?.updatedAt).toBe(at(5));
  });

  it("with GitHub out of date, claims no PR column it cannot see", () => {
    const cards = kanban(input({ workers: [worker("a", { prs: [10] })], prs: null }));
    expect(columnOf(cards, "a")).toBe("building");
  });

  it("joins a Coming row to the chat in its own repo only", () => {
    const G = "example-org/other-repo";
    const cards = kanban(
      input({
        workers: [worker("fix-menu"), worker("fix-menu", { repo: G, id: "g" })],
        chats: [{ name: "fix-menu", state: "working", repo: G, prs: [41] }],
        coming: [{ title: "Menu", chat: "fix-menu", pr: 41 }],
        prs: [pr(41, { hold: "Owner hold: x" })],
      }),
    );
    expect(cards.find((card) => card.repo === R)?.column).toBe("building");
  });

  it("reads a numbered card name against the chats of its own repo", () => {
    const G = "example-org/other-repo";
    const cards = kanban(input({ workers: [worker("search-box"), worker("search-box-73", { repo: G, id: "g" })], cards: [need("n1", { chat: "search-box-73" })] }));
    expect(cards.find((card) => card.repo === R)?.column).toBe("waiting");
  });

  it("keeps a chat with a card waiting on you after the chat has closed and left the board", () => {
    const cards = kanban(input({ cards: [need("n1", { chat: "release-fix" })] }));
    expect(cards.map((card) => [card.chat, card.column])).toEqual([["release-fix", "waiting"]]);
  });

  it("calls no chat Merged while its other PRs' state is unknown", () => {
    const chat = worker("a", { prs: [10, 11] });
    expect(columnOf(kanban(input({ workers: [chat], prs: null, timeline: merged(10, 30) })), "a")).toBe("building");
    expect(kanban(input({ workers: [chat], prs: null, timeline: merged(10, 30) }))[0]?.why).toBe("PR state unknown: GitHub is behind");
    expect(columnOf(kanban(input({ workers: [chat], prs: [], prsFailed: ["example-repo"], timeline: merged(10, 30) })), "a")).toBe("building");
    // Every PR of it merged: nothing unknown is left.
    expect(columnOf(kanban(input({ workers: [worker("a", { prs: [10] })], prs: null, timeline: merged(10, 30) })), "a")).toBe("merged");
  });

  it("counts pending checks as CI running even beside a failed one", () => {
    const failing = pr(10, { checks: { state: "fail", passed: 1, failed: 1, pending: 2, failing: ["x"] } });
    expect(kanban(input({ workers: [worker("a", { prs: [10] })], prs: [failing] })).map((card) => [card.column, card.why])).toEqual([["review", "CI running"]]);
  });

  it("keeps a closed chat in Merged by its branch name", () => {
    const cards = kanban(input({ chats: [{ name: "flaky", state: "done" }], timeline: merged(10, 30, "sam/flaky") }));
    expect(columnOf(cards, "flaky")).toBe("merged");
  });

  it("keeps a closed chat out of Merged while a PR on its branch is open", () => {
    const B = "sam/flaky";
    const cards = kanban(input({ chats: [{ name: "flaky", state: "done" }], prs: [pr(11, { branch: B })], timeline: merged(10, 30, B) }));
    expect(columnOf(cards, "flaky")).toBe("review");
  });

  it("reads a numbered card name against a closed chat too, never making a second card", () => {
    const cards = kanban(input({ chats: [{ name: "search-box", state: "done", prs: [10] }], cards: [need("n1", { chat: "search-box-73" })], timeline: merged(10, 30) }));
    expect(cards.map((card) => [card.chat, card.column])).toEqual([["search-box", "waiting"]]);
  });

  it("reads a numbered board row and its card as the open chat's", () => {
    const cards = kanban(input({ workers: [worker("search-box")], chats: [{ name: "search-box-73", state: "review", doing: "Rush timing" }], cards: [need("n1", { chat: "search-box-73" })] }));
    expect(cards.map((card) => [card.chat, card.column, card.task])).toEqual([["search-box", "waiting", "Rush timing"]]);
  });

  it("keeps every numbered row's PRs on the open chat, and its Coming rows too", () => {
    const cards = kanban(
      input({
        workers: [worker("search-box")],
        chats: [
          { name: "search-box-73", state: "review", prs: [10] },
          { name: "search-box-74", state: "review", prs: [11] },
        ],
        coming: [{ title: "Rush", chat: "search-box-73", pr: 10 }],
        prs: [pr(11, { hold: "Owner hold: x" })],
        timeline: merged(10, 30),
      }),
    );
    expect(cards.map((card) => [card.chat, card.column, card.why, card.pr?.number])).toEqual([["search-box", "review", "PR open · Held: x", 11]]);
  });

  it("notes a hold label in the chat's own column", () => {
    const cards = kanban(input({ workers: [worker("a", { prs: [10] })], prs: [pr(10, { labels: ["do-not-merge"] })] }));
    expect(cards.map((card) => [card.chat, card.column, card.why])).toEqual([["a", "review", "PR open · Held: do-not-merge"]]);
  });

  it("keeps a Coming row waiting on your OK out of Waiting on you: an open chat stays in its column, a closed one is left off", () => {
    const coming = [
      { title: "Approve access", chat: "closed-chat", stage: "owner-ok" as const },
      { title: "Video", chat: "cover", stage: "owner-ok" as const },
    ];
    const cards = kanban(input({ workers: [worker("cover")], coming }));
    expect(cards.map((card) => [card.chat, card.column, card.why])).toEqual([["cover", "building", "No PR yet"]]);
  });

  it("keeps a closed chat's merge of the last day in Merged under its branch's name, once", () => {
    const timeline: TimelineResponse = {
      repos: [R],
      days: [
        {
          day: "2026-10-06",
          events: [
            { kind: "merged", at: at(30), repo: R, title: "PR 10", number: 10, branch: "sam/gone" },
            { kind: "merged", at: at(40), repo: R, title: "PR 11", number: 11, branch: "sam/agents-kanban" },
            { kind: "merged", at: at(50), repo: R, title: "PR 12", number: 12, branch: "sam/held" },
            { kind: "merged", at: at(25 * 60), repo: R, title: "PR 13", number: 13, branch: "sam/old" },
            { kind: "merged", at: at(20), repo: R, title: "PR 14", number: 14, branch: "dependabot/npm/x" },
          ],
        },
      ],
    };
    const cards = kanban(input({ workers: [worker("kanban", { branch: "sam/agents-kanban" })], chats: [{ name: "board-row", state: "done", prs: [12] }], timeline }));
    expect(cards.map((card) => [card.chat, card.column, card.pr?.number])).toEqual([
      ["gone", "merged", 10],
      ["kanban", "merged", 11],
      ["board-row", "merged", 12],
    ]);
  });

  it("links the PR that puts a chat in Waiting on you, not its newest, and a held chat's newest open PR", () => {
    const cards = kanban(
      input({
        workers: [worker("a", { prs: [10, 11] }), worker("b", { prs: [12, 13] }), worker("c", { prs: [14, 15] })],
        prs: [pr(10), pr(11), pr(12), pr(13), pr(14, { hold: "Owner hold: x" }), pr(15)],
        cards: [need("n1", { chat: "a", pr: 10 }), need("n2", { pr: 12 })],
      }),
    );
    expect(cards.map((card) => [card.chat, card.column, card.pr?.number, card.pr?.url])).toEqual([
      ["a", "waiting", 10, `https://github.com/${R}/pull/10`],
      ["b", "waiting", 12, `https://github.com/${R}/pull/12`],
      ["c", "review", 15, `https://github.com/${R}/pull/15`],
    ]);
  });

  it("reads a numbered Coming row against the board's chats like a card", () => {
    const cards = kanban(
      input({ chats: [{ name: "search-box", state: "review", prs: [10] }], prs: [pr(10)], coming: [{ title: "Rush", chat: "search-box-73", pr: 10 }], cards: [need("n1", { chat: "search-box-73" })] }),
    );
    expect(cards.map((card) => [card.chat, card.column])).toEqual([["search-box", "waiting"]]);
  });

  it("links a closed chat's merge by the timeline's own URL and owner/name repo", () => {
    const timeline: TimelineResponse = {
      repos: ["example-repo"],
      days: [{ day: "2026-10-06", events: [{ kind: "merged", at: at(30), repo: "example-repo", title: "PR 10", number: 10, url: `https://github.com/${R}/pull/10`, branch: "sam/gone" }] }],
    };
    const cards = kanban(input({ timeline }));
    expect(cards.map((card) => [card.chat, card.repo, card.pr?.url])).toEqual([["gone", R, `https://github.com/${R}/pull/10`]]);
  });

  it("keeps a numbered branch's merge on its closed board chat", () => {
    const cards = kanban(input({ chats: [{ name: "search-box", state: "done" }], timeline: merged(10, 30, "sam/search-box-73") }));
    expect(cards.map((card) => [card.chat, card.column, card.pr?.number])).toEqual([["search-box", "merged", 10]]);
  });

  it("links the PR a waiting card names even once it has merged", () => {
    const cards = kanban(input({ workers: [worker("a", { prs: [10, 11] })], prs: [pr(11)], cards: [need("n1", { chat: "a", pr: 10 })], timeline: merged(10, 30) }));
    expect(cards.map((card) => [card.column, card.pr?.number])).toEqual([["waiting", 10]]);
  });

  it("puts a numbered Coming row in the repo of the board chat holding its PR, and claims its merge there only", () => {
    const G = "example-org/other-repo";
    const cards = kanban(
      input({
        chats: [
          { name: "search-box", repo: R, state: "done" },
          { name: "search-box", repo: G, state: "review", prs: [10] },
        ],
        prs: [pr(10, { repo: G, url: `https://github.com/${G}/pull/10` })],
        coming: [{ title: "Search box OK", chat: "search-box-73", pr: 10, stage: "owner-ok" }],
        timeline: merged(10, 30, "sam/gone"),
      }),
    );
    expect(cards.map((card) => [card.repo, card.chat, card.column, card.pr?.number])).toEqual([
      [G, "search-box", "review", 10],
      [R, "gone", "merged", 10],
    ]);
    expect(cards[0]?.ticket.coming.map((item) => item.title)).toEqual(["Search box OK"]);
  });

  it("reads a hold label the way the bridge compares them", () => {
    const cards = kanban(input({ workers: [worker("a", { prs: [10] })], prs: [pr(10, { labels: ["do_not_merge"] })] }));
    expect(cards.map((card) => card.column)).toEqual(["review"]);
    expect(cards[0]?.why).toMatch(/^PR open · Held: /);
  });

  it("reads a closed chat's numbered branch as its own for open PRs too", () => {
    const cards = kanban(
      input({ chats: [{ name: "search-box", state: "done" }], prs: [pr(11, { branch: "sam/search-box-73", hold: "Owner hold: x" })], timeline: merged(10, 30, "sam/search-box-73") }),
    );
    expect(cards.map((card) => [card.chat, card.column, card.why, card.pr?.number])).toEqual([["search-box", "review", "PR open · Held: x", 11]]);
  });

  it("never gives a closed chat a branch an open chat has checked out", () => {
    const cards = kanban(input({ workers: [worker("new-work", { branch: "x/search-box-73" })], chats: [{ name: "search-box", state: "done" }], prs: [pr(11, { branch: "x/search-box-73", hold: "Owner hold: x" })] }));
    expect(cards.map((card) => [card.chat, card.column, card.why, card.pr?.number])).toEqual([["new-work", "review", "PR open · Held: x", 11]]);
  });

  it("never gives an open chat a merge from a branch it no longer has checked out", () => {
    const cards = kanban(input({ workers: [worker("a", { branch: "x/new-work" })], timeline: merged(10, 30, "x/a") }));
    expect(cards.map((card) => [card.chat, card.column])).toEqual([["a", "building"]]);
  });

  it("reads a spelled-out hold label as the bridge does", () => {
    const cards = kanban(input({ workers: [worker("a", { prs: [10] })], prs: [pr(10, { labels: ["owner-h-o-l-d"] })] }));
    expect(cards.map((card) => [card.column, card.why])).toEqual([["review", "PR open · Held: owner-h-o-l-d"]]);
  });

  it("keeps a live chat's held draft PR in Building, noted, until you have a card for it", () => {
    const held = pr(10, { draft: true, hold: "**Owner hold:** visual overhaul. Do not merge until you OK the video" });
    const building = kanban(input({ workers: [worker("cover", { prs: [10] })], prs: [held] }));
    expect(building.map((card) => [card.chat, card.column, card.why, card.pr?.number])).toEqual([
      ["cover", "building", "Draft PR · Held: visual overhaul. Do not merge until you OK the video", 10],
    ]);
    const waiting = kanban(input({ workers: [worker("cover", { prs: [10] })], prs: [held], cards: [need("n1", { pr: 10 })] }));
    expect(waiting.map((card) => [card.chat, card.column, card.why, card.pr?.number])).toEqual([["cover", "waiting", "Your card: Card n1", 10]]);
  });

  it("never lets a Coming row's numbered name take a card from its live chat", () => {
    const cards = kanban(input({ workers: [worker("search-box")], coming: [{ title: "Going", chat: "search-box-73" }], cards: [need("n1", { chat: "search-box-73" })] }));
    expect(columnOf(cards, "search-box")).toBe("waiting");
  });

  it("takes no PR from what the crew says it is delivering (joined by name only)", () => {
    const delivering = worker("fix-menu", { delivering: { title: "Menu", pr: 41 } });
    expect(columnOf(kanban(input({ workers: [delivering], prs: [pr(41, { hold: "Owner hold: x" })] })), "fix-menu")).toBe("building");
  });

  it("keeps a merged chat in review while its merge or deploy is still going, then Done", () => {
    const shipping = (stage: "deploying" | "shipped") =>
      kanban(input({ workers: [worker("a", { prs: [10] })], prs: [], timeline: merged(10, 5), coming: [{ title: "Rush", pr: 10, chat: "a", stage }] })).map((card) => [card.column, card.why]);
    expect(shipping("deploying")).toEqual([["review", "Deploying"]]);
    expect(shipping("shipped")[0]![0]).toBe("merged");
    // Once the merge settles its Coming row, the chat's own stage still says it.
    const settled = kanban(input({ workers: [worker("a", { prs: [10] })], chats: [{ name: "a", state: "working", stage: "Deploying rivet" }], timeline: merged(10, 5) }));
    expect(settled.map((card) => [card.column, card.why])).toEqual([["review", "Deploying"]]);
    // A stage typed days ago is stale, as the server reads it: no deploy is going.
    const old = kanban(input({ workers: [worker("a", { prs: [10] })], chats: [{ name: "a", state: "working", stage: "Deploying rivet", updatedAt: "2026-10-03T09:00:00.000Z" }], timeline: merged(10, 5) }));
    expect(old.map((card) => card.column)).toEqual(["merged"]);
  });

  it("dues a chat from its ETA and last progress write, and leaves it off without one", () => {
    const due = (extra: Partial<Worker>) => kanban(input({ workers: [worker("a", extra)] }))[0]!.dueAt;
    expect(due({ etaMinutes: 45, updatedAt: "2026-10-06T09:00:00.000Z" })).toBe("2026-10-06T09:45:00.000Z");
    expect(due({ updatedAt: "2026-10-06T09:00:00.000Z" })).toBeNull();
    // Its row marked done, the old ETA is gone: still open or closed with a PR, it is never late.
    const eta = { etaMinutes: 45, updatedAt: "2026-10-06T09:00:00.000Z" };
    const done = (live: boolean) =>
      kanban(input({ workers: live ? [worker("a", eta)] : [], chats: [{ name: "a", state: "done", prs: [10], ...eta }], prs: [pr(10)] }))[0]!.dueAt;
    expect(done(true)).toBeNull();
    expect(done(false)).toBeNull();
  });

  it("groups every column, empty ones too", () => {
    const columns = byColumn(kanban(input({ workers: [worker("a")] })));
    expect(Object.keys(columns)).toEqual(["building", "waiting", "review", "merged"]);
    expect(columns.building.map((card) => card.chat)).toEqual(["a"]);
  });
});
