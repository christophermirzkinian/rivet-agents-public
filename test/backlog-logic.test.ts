import { describe, expect, it } from "vitest";

import type { BacklogAsk, BacklogIssue, BacklogRepo, BacklogResponse, BacklogStart } from "../src/shared/backlog.js";
import type { PullRequest } from "../src/shared/ops.js";
import { backlogOf, homeOf, moreLabel, projectName } from "../web/src/backlog-logic.js";

const MS = "example-org/example-repo" as const;
const OTHER = "example-org/other-repo" as const;
const NOW = Date.parse("2026-11-02T10:30:00.000Z");

const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const ask = (id: string, over: Partial<BacklogAsk> = {}): BacklogAsk => ({ id, words: `Ask ${id}`, stage: "queued", prs: [], createdAt: day(1), stageAt: day(1), ...over });
const issue = (number: number, over: Partial<BacklogIssue> = {}): BacklogIssue => ({ number, title: `Issue ${number}`, updatedAt: day(1), labels: [], ...over });
const repo = (over: Partial<BacklogRepo> = {}): BacklogRepo => ({ repo: MS, total: 0, logs: 0, ownerTotal: 0, owner: [], recent: [], bugs: [], ...over });
const data = (repos: BacklogRepo[], asks: BacklogAsk[] = []): BacklogResponse => ({
  at: day(0),
  stale: false,
  repos: Object.fromEntries(repos.map((one) => [one.repo, { ...one, at: day(0), stale: false }])),
  asks,
});
const draft = (number: number, title: string, over: Partial<PullRequest> = {}) => ({ repo: MS, number, title, draft: true, updatedAt: day(1), ...over }) as PullRequest;

describe("backlogOf", () => {
  it("lists asks to start, then parked, then your call, drafts and other issues, in that order", () => {
    const reading = repo({
      total: 30,
      logs: 4,
      ownerTotal: 3,
      owner: [issue(10, { labels: ["autonomy:owner"], updatedAt: day(3) }), issue(11, { labels: ["autonomy:owner"], updatedAt: day(1) })],
      recent: [
        issue(11, { labels: ["autonomy:owner"] }),
        issue(20, { updatedAt: day(1) }),
        issue(21, { labels: ["type:bug"], updatedAt: day(5) }),
        issue(22, { labels: ["type:log"] }),
        issue(23, { labels: ["bug"], updatedAt: day(2) }),
      ],
    });
    const asks = [ask("a-3", { stage: "parked", createdAt: day(0) }), ask("a-2", { createdAt: day(1), why: "Plan with you tonight" }), ask("a-1", { createdAt: day(2) })];
    const prs = [draft(50, "Chart: brighter lines"), draft(51, "Not a draft", { draft: false }), draft(52, "Other repo", { repo: OTHER })];
    const backlog = backlogOf(MS, data([reading], asks), prs, NOW);
    expect(backlog.sections.map((one) => one.id)).toEqual(["asks", "call", "drafts", "issues"]);
    const [asksSection, call, drafts, other] = backlog.sections;
    expect(asksSection!.rows.map((row) => [row.key, row.tag])).toEqual([["ask-a-2", "start"], ["ask-a-1", "start"], ["ask-a-3", "parked"]]);
    expect(asksSection!.rows[0]!.sub).toBe("Plan with you tonight · 1 Nov");
    expect(call!.rows.map((row) => row.key)).toEqual(["issue-11", "issue-10"]);
    expect(call!.rows.every((row) => row.tag === "call")).toBe(true);
    expect(call!.count).toBe(3);
    expect(drafts!.rows.map((row) => [row.key, row.url])).toEqual([["pr-50", `https://github.com/${MS}/pull/50`]]);
    // Bugs first, then newest; logs and your-call issues left out.
    expect(other!.rows.map((row) => row.key)).toEqual(["issue-23", "issue-21", "issue-20"]);
    expect(other!.rows[0]!.url).toBe(`https://github.com/${MS}/issues/23`);
    expect(backlog.head).toBe("2 to start · 1 parked · 3 your call · 26 issues");
    expect(backlog.foot).toEqual({ label: "All open issues on GitHub ›", url: `https://github.com/${MS}/issues` });
  });

  it("shows an issue an ask names once, as the ask's row, naming the issue", () => {
    const reading = repo({ repo: OTHER, total: 2, ownerTotal: 1, owner: [issue(11, { labels: ["autonomy:owner"] })], recent: [issue(11, { labels: ["autonomy:owner"] }), issue(8)] });
    const backlog = backlogOf(OTHER, data([reading], [ask("a-9", { repo: OTHER, issue: 11, stage: "parked", why: "You said Park this", createdAt: day(1) })]), [], NOW);
    expect(backlog.sections.map((one) => one.id)).toEqual(["asks", "issues"]);
    expect(backlog.sections[0]!.rows[0]).toMatchObject({ tag: "parked", sub: "You said Park this · other-repo #11 · 1 Nov", url: `https://github.com/${OTHER}/issues/11` });
    expect(backlog.sections[1]!.rows.map((row) => row.key)).toEqual(["issue-8"]);
  });

  it("leaves a log out of Needs your call and its count, though it is labelled for your call too", () => {
    const reading = repo({
      total: 5,
      logs: 1,
      ownerTotal: 2,
      owner: [issue(1, { labels: ["autonomy:owner"] }), issue(2, { labels: ["autonomy:owner", "type:log"] })],
    });
    const backlog = backlogOf(MS, data([reading]), [], NOW);
    const call = backlog.sections.find((one) => one.id === "call")!;
    expect(call.rows.map((row) => row.key)).toEqual(["issue-1"]);
    expect(call.count).toBeNull();
    expect(backlog.head).toBe("1 your call · 4 issues");
  });

  it("puts an open bug the newest list missed first in Other issues", () => {
    const reading = repo({ total: 3, recent: [issue(20, { updatedAt: day(1) }), issue(21, { updatedAt: day(0) })], bugs: [issue(5, { labels: ["type:bug"], updatedAt: day(30) })] });
    const other = backlogOf(MS, data([reading]), [], NOW).sections.find((one) => one.id === "issues")!;
    expect(other.rows.map((row) => row.key)).toEqual(["issue-5", "issue-21", "issue-20"]);
  });

  it("counts an issue an ask names once, as the ask: never in a section's count or the head's", () => {
    const reading = repo({
      repo: OTHER,
      total: 4,
      ownerTotal: 2,
      owner: [issue(11, { labels: ["autonomy:owner"] }), issue(12, { labels: ["autonomy:owner"] })],
      recent: [issue(8), issue(9)],
    });
    const asks = [ask("a-1", { repo: OTHER, issue: 11 }), ask("a-2", { repo: OTHER, issue: 9 })];
    const backlog = backlogOf(OTHER, data([reading], asks), [], NOW);
    const [, call, other] = backlog.sections;
    expect(call!.rows.map((row) => row.key)).toEqual(["issue-12"]);
    expect(call!.count).toBeNull();
    expect(other!.rows.map((row) => row.key)).toEqual(["issue-8"]);
    expect(other!.count).toBeNull();
    expect(backlog.head).toBe("2 to start · 1 your call · 2 issues");
  });

  it("says nothing waits when a project has nothing, and opens the repo on GitHub with no reading", () => {
    const backlog = backlogOf(OTHER, { at: null, stale: true, repos: {}, asks: [] }, [], NOW);
    expect(backlog.sections).toEqual([]);
    expect(backlog.head).toBe("");
    expect(backlog.foot).toEqual({ label: "Open other-repo on GitHub ›", url: `https://github.com/${OTHER}/issues` });
  });

  it("has no GitHub link for chats with no repo", () => {
    expect(backlogOf("", { at: null, stale: true, repos: {}, asks: [] }, [], NOW).foot).toBeNull();
  });

  it("shows the first few rows of a section, then N more", () => {
    const asks = Array.from({ length: 8 }, (_, i) => ask(`a-${i + 1}`, { stage: i < 2 ? "queued" : "parked", createdAt: day(i) }));
    const reading = repo({ total: 9, recent: Array.from({ length: 7 }, (_, i) => issue(i + 1)) });
    const [asksSection, other] = backlogOf(MS, data([reading], asks), [], NOW).sections;
    expect(asksSection!.shown).toBe(4);
    expect(moreLabel(asksSection!)).toBe("4 more parked ›");
    expect(other!.shown).toBe(5);
    expect(moreLabel(other!)).toBe("2 more ›");
    expect(other!.count).toBe(9);
  });

  it("shows an issue Start work began once, in Started, its ask off Your asks, and an issue Close closed nowhere", () => {
    const WEIGHT = "example-org/weight-log" as const;
    const reading = repo({ repo: WEIGHT, total: 4, recent: [issue(20, { title: "Dark-theme chart draws the line indigo" }), issue(21), issue(22), issue(23)] });
    const start = (n: number, over: Partial<BacklogStart> = {}): BacklogStart => ({ repo: WEIGHT, issue: n, ask: `a-${n}`, words: `Start work on weight-log #${n}: Issue ${n} as it read`, at: "2026-11-02T02:52:00.000Z", stage: "queued", ...over });
    const response: BacklogResponse = {
      ...data([reading], [ask("a-20", { repo: WEIGHT, issue: 20, words: "Start work on weight-log #20: x" }), ask("a-1", { repo: WEIGHT }), ask("a-23", { repo: WEIGHT, issue: 23, stage: "parked" })]),
      started: [start(20), start(21, { chat: "weight-chart", stage: "building" }), start(23)],
      closing: [{ repo: WEIGHT, issue: 22 }, { repo: WEIGHT, issue: 23 }],
    };
    const backlog = backlogOf(WEIGHT, response, [], NOW);
    expect(backlog.sections.map((one) => one.id)).toEqual(["started", "asks"]);
    const [started, asks] = backlog.sections;
    expect(started!.rows.map((row) => [row.key, row.tag, row.title, row.sub, row.issue])).toEqual([
      ["started-20", "started", "Dark-theme chart draws the line indigo", "#20 · Started 1:52pm", 20],
      ["started-21", "started", "Issue 21", "#21 · On it: weight-chart", 21],
    ]);
    expect(asks!.rows.map((row) => row.key)).toEqual(["ask-a-1"]);
    expect(backlog.head).toBe("2 started · 1 to start");
  });

  it("opens an issue's row in the app, and an ask's or a draft's as before", () => {
    const reading = repo({ total: 2, recent: [issue(20)] });
    const backlog = backlogOf(MS, data([reading], [ask("a-1", { issue: 7 })]), [draft(50, "Chart: brighter lines")], NOW);
    expect(backlog.sections.flatMap((one) => one.rows).map((row) => [row.key, row.issue])).toEqual([
      ["ask-a-1", null],
      ["pr-50", null],
      ["issue-20", 20],
    ]);
  });
});

describe("projects", () => {
  it("reads a project as its repo's short name, and a chat with none as Other chats", () => {
    expect(projectName(MS)).toBe("example-repo");
    expect(projectName("")).toBe("Other chats");
  });

  it("homes a chat at its own project, else its repo", () => {
    expect(homeOf({ repo: MS })).toBe(MS);
    expect(homeOf({ repo: MS, project: OTHER })).toBe(OTHER);
  });
});
