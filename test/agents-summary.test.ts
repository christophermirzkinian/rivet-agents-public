import { describe, expect, it } from "vitest";

import type { ComingItem, Need } from "../src/shared/board.js";
import type { PullRequest } from "../src/shared/ops.js";
import { NO_REPO, setDefaultRepo } from "../src/shared/repos.js";
import { clock, dayClock } from "../src/shared/when.js";
import type { KanbanCard } from "../web/src/agents-logic.js";
import { copySummaryText, groupOf } from "../web/src/agents-summary.js";

/** Noon local on a Saturday, so every time below stays on its day in any zone. */
const NOW = new Date(2026, 9, 10, 12, 0).getTime();
const at = (hour: number, day = 10) => new Date(2026, 9, day, hour, 0).toISOString();
const R = "example-org/example-repo";
const HEAD = `Update, ${dayClock(NOW)}`;

const card = (chat: string, extra: Partial<KanbanCard> = {}): KanbanCard => ({
  key: `example-repo\n${chat}`,
  chat,
  repo: R,
  column: "building",
  why: "No PR yet",
  task: null,
  pr: null,
  claims: null,
  updatedAt: null,
  dueAt: null,
  forOk: false,
  ticket: { worker: null, board: null, prs: [], merged: [], cards: [], coming: [], issues: [] },
  ...extra,
});
const pr = (number: number) => ({ number, url: `https://github.com/${R}/pull/${number}` });
const named = (chat: string, number: number, title: string, extra: Partial<KanbanCard> = {}) =>
  card(chat, { pr: pr(number), ...extra, ticket: { ...card(chat).ticket, prs: [{ number, title } as PullRequest], ...extra.ticket } });
const merged = (chat: string, number: number, title: string, when: string) =>
  card(chat, { column: "merged", why: "Merged", pr: pr(number), ticket: { ...card(chat).ticket, merged: [{ number, at: when, url: "", title }] } });
const need = (id: string, extra: Partial<Need> = {}): Need => ({ id, kind: "approval", title: `Card ${id}`, ...extra }) as Need;

describe("Copy summary", () => {
  it("sets out a project's groups in order, with no PR numbers", () => {
    const cards = [
      merged("done", 40, "A weekly report (#40)", at(10)),
      named("review", 41, "Sign-in by link", { column: "review", why: "PR open", dueAt: at(15) }),
      named("build", 42, "Dark mode #42", { why: "Draft PR", dueAt: at(17) }),
      named("next", 43, "Price alerts", { why: "Draft PR", dueAt: at(9, 11) }),
    ];
    expect(copySummaryText(cards, [need("a", { title: "Search box (PR 44): approve the screen", repo: R })], NOW)).toBe(
      [
        HEAD,
        "",
        "example-repo",
        "",
        "Merged today",
        `• A weekly report, done ${clock(at(10))}`,
        "",
        "Coming today",
        `• Sign-in by link, ${clock(at(15))}`,
        "",
        "Being built",
        `• Dark mode, ${clock(at(17))}`,
        "",
        "Needs you (cards)",
        "• Search box: approve the screen",
        "",
        "Tomorrow",
        `• Price alerts, ${clock(at(9, 11))}`,
      ].join("\n"),
    );
  });

  it("says so when there is nothing to tell", () => {
    expect(copySummaryText([], [], NOW)).toBe(`${HEAD}\n\nNothing new right now.`);
    expect(copySummaryText([merged("old", 1, "Older work", at(10, 9))], [], NOW)).toBe(`${HEAD}\n\nNothing new right now.`);
  });

  it("heads every repo with its short name, sorted, and leaves an empty project off", () => {
    const inRepo = (repo: string, chat: string, title: string) => named(chat, 1, title, { repo: `example-org/${repo}`, why: "Draft PR" });
    const cards = [inRepo("zebra", "z", "Zebra work"), inRepo("apple", "a", "Apple work"), { ...merged("m", 2, "Old", at(10, 9)), repo: "example-org/empty" }];
    expect(copySummaryText(cards, [], NOW)).toBe(`${HEAD}\n\napple\n\nBeing built\n• Apple work\n\nzebra\n\nBeing built\n• Zebra work`);
  });

  it("puts a card naming no repo under the default repo, else Other chats", () => {
    const needs = [need("a", { title: "Pick a name" })];
    const before = NO_REPO;
    setDefaultRepo(R);
    expect(copySummaryText([], needs, NOW)).toBe(`${HEAD}\n\nexample-repo\n\nNeeds you (cards)\n• Pick a name`);
    setDefaultRepo(null);
    expect(copySummaryText([], needs, NOW)).toBe(`${HEAD}\n\nOther chats\n\nNeeds you (cards)\n• Pick a name`);
    setDefaultRepo(before);
  });

  it("reads a chat with no PR by its Coming row, else what it is at, else its name", () => {
    const row = card("row", { task: "x", ticket: { ...card("row").ticket, coming: [{ title: "Search box", stage: "building" } as ComingItem] } });
    const task = card("task", { task: "Two builders on the chart\nsecond line" });
    const bare = card("bare-chat");
    const text = copySummaryText([row, task, bare], [], NOW);
    expect(text).toContain("• Search box");
    expect(text).toContain("• Two builders on the chart");
    expect(text).not.toContain("second line");
    expect(text).toContain("• bare-chat");
  });

  it("keeps a merged line merged while it deploys, and lists a merge from today only", () => {
    const deploying = named("ship", 5, "Search box", { column: "review", why: "Deploying" });
    const shipped = { ...deploying, ticket: { ...deploying.ticket, merged: [{ number: 5, at: at(11), url: "", title: "Search box: more results" }] } };
    expect(copySummaryText([shipped], [], NOW)).toBe(`${HEAD}\n\nexample-repo\n\nMerged today\n• Search box: more results, done ${clock(at(11))}`);
  });

  it("lists one thing once when two chats work on it, and leaves a later day's review out", () => {
    const one = named("a", 1, "Search box", { why: "Draft PR", dueAt: at(15) });
    const two = named("b", 1, "Search box", { why: "Draft PR" });
    const monday = named("c", 2, "Four tabs", { column: "review", why: "PR open", dueAt: at(9, 12) });
    expect(copySummaryText([one, two, monday], [], NOW)).toBe(`${HEAD}\n\nexample-repo\n\nBeing built\n• Search box, ${clock(at(15))}`);
  });

  it("reads a card waiting on you by its own repo's PR title", () => {
    const here = named("here", 10, "Two tabs on the chart", { column: "waiting", why: "Your card" });
    const other = { ...named("other", 10, "An enquiry form", { column: "waiting", why: "Your card" }), repo: "example-org/other" };
    expect(copySummaryText([here, other], [need("a", { title: "The tabs", pr: 10, repo: R })], NOW)).toContain("Needs you (cards)\n• Two tabs on the chart");
  });

  it("cuts a long title to one line", () => {
    const text = copySummaryText([named("long", 1, "word ".repeat(40).trim(), { why: "Draft PR" })], [], NOW);
    const line = text.split("\n").find((one) => one.startsWith("• "))!;
    expect(line.length).toBeLessThanOrEqual(102);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("groupOf", () => {
  it("has no group for a card for you or a chat that is done", () => {
    expect(groupOf(card("a", { column: "waiting" }), NOW)).toBeNull();
    expect(groupOf(card("a", { column: "merged" }), NOW)).toBeNull();
  });

  it("reads tomorrow by the calendar, a review as coming, and one held for your OK as being built", () => {
    expect(groupOf(card("a", { dueAt: at(9, 11) }), NOW)).toBe("tomorrow");
    expect(groupOf(card("a", { column: "review" }), NOW)).toBe("coming");
    expect(groupOf(card("a", { column: "review", forOk: true }), NOW)).toBe("building");
    expect(groupOf(card("a"), NOW)).toBe("building");
  });
});
