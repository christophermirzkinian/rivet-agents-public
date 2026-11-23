// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { Ask } from "../src/shared/asks.js";
import type { OpsStatus } from "../src/shared/ops-status.js";
import type { Worker } from "../src/shared/workers.js";
import { askIdsIn, askSourceLink, linkedAsks, linkedPrs, mergedCards, opsRecordOf, type TicketCard } from "../web/src/views/chat-ticket.js";

const MS = "example-org/example-repo" as const;
const OTHER = "example-org/other-repo" as const;
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 21, 20, minutes)).toISOString();
const ask = (id: string, minutes: number, extra: Partial<Ask> = {}): Ask =>
  ({ id, words: `words of ${id}`, who: "owner", stage: "building", prs: [], dueHistory: [], timeline: [], createdAt: at(minutes), stageAt: at(minutes), updatedAt: at(minutes), version: 1, ...extra }) as Ask;
const row = (extra: Partial<Worker>): Worker => ({ id: "w", name: "N", repo: MS, chat: "build-chat", state: "working", lastOutputAt: 0, ...extra });

describe("the asks a row's ticket links", () => {
  it("reads ask ids from a title or a branch, never from inside a longer word or number", () => {
    expect(askIdsIn("#21 Port change (a-1)")).toEqual(["a-1"]);
    expect(askIdsIn(undefined, "a1-export-port-21")).toEqual(["a-1"]);
    expect(askIdsIn("a-4 then a-4 and a-6")).toEqual(["a-4", "a-6"]);
    expect(askIdsIn("data12 xa-12 a-12x a-923456")).toEqual([]);
    // A bare a12 is a word in a title, and only a branch's start names an ask that way.
    expect(askIdsIn("Use a1 sheet layout", "fix-a12-sheet")).toEqual([]);
  });

  it("a PR row's title names only an ask in the row's repo", () => {
    const pr = row({ id: "pr:x#21", chat: "pr-21", prs: [21], what: "#21 Port change (a-1)" });
    expect(linkedAsks(pr, [ask("a-1", 0, { chat: "build-chat", repo: OTHER })])).toEqual([]);
    expect(linkedAsks(pr, [ask("a-1", 0, { chat: "build-chat" })]).map((one) => one.id)).toEqual(["a-1"]);
  });

  it("a PR row carrying its ask's chat name never links that chat's ask naming only another PR", () => {
    const pr = row({ id: "pr:x#21", chat: "build-chat", prs: [21], what: "#21 Port change" });
    const other = ask("a-1", 0, { chat: "build-chat", prs: [22] });
    const its = ask("a-2", 30, { chat: "build-chat", prs: [21] });
    const plain = ask("a-3", 10, { chat: "build-chat" });
    expect(linkedAsks(pr, [other, its, plain]).map((one) => one.id)).toEqual(["a-2", "a-3"]);
  });

  it("a chat with two open asks links both, newest first, and no finished one", () => {
    const older = ask("a-1", 0, { chat: "build-chat" });
    const newer = ask("a-2", 30, { chat: "build-chat" });
    const done = ask("a-3", 10, { chat: "build-chat", stage: "done" });
    expect(linkedAsks(row({}), [older, done, newer]).map((one) => one.id)).toEqual(["a-2", "a-1"]);
  });

  it("a PR row with no chat links the ask naming its PR, and the one its title or branch names", () => {
    const older = ask("a-1", 0, { chat: "build-chat", prs: [21] });
    const newer = ask("a-2", 30, { chat: "build-chat" });
    const pr = row({ id: "pr:x#21", chat: "pr-21", prs: [21], what: "#21 Port change", branch: "port-change" });
    expect(linkedAsks(pr, [older, newer]).map((one) => one.id)).toEqual(["a-1"]);
    // Another repo's PR of the same number is not this row's.
    expect(linkedAsks(pr, [{ ...older, repo: OTHER }, newer])).toEqual([]);
    const named = row({ id: "pr:x#21", chat: "pr-21", prs: [21], what: "#21 Port change (a-1)", branch: "a1-port-change" });
    expect(linkedAsks(named, [{ ...older, prs: [] }, newer]).map((one) => one.id)).toEqual(["a-1"]);
  });

  it("an ask's PRs are in its repo as its chat's worktree reads it, and a merge from before the ask does not link it", () => {
    const one = ask("a-1", 0, { chat: "build-chat", prs: [21] });
    const pr = row({ id: "pr:x#21", chat: "pr-21", repo: OTHER, prs: [21], what: "#21 Port change" });
    expect(linkedAsks(pr, [one])).toEqual([]);
    const chats = [row({ chat: "build-chat", project: OTHER })];
    expect(linkedAsks(pr, [one], chats).map((a) => a.id)).toEqual(["a-1"]);
    expect(linkedPrs(one, pr, chats, [])).toEqual([{ number: 21, repo: OTHER }]);
    expect(linkedAsks(pr, [one], chats, [{ repo: OTHER, number: 21, at: at(-10) }])).toEqual([]);
    expect(linkedAsks(pr, [one], chats, [{ repo: OTHER, number: 21, at: at(5) }]).map((a) => a.id)).toEqual(["a-1"]);
  });

  it("a chat's doing text or branch never links an ask: only a PR or queue row's title or branch does", () => {
    const mine = ask("a-2", 30, { chat: "build-chat" });
    const other = ask("a-9", 0, { chat: "elsewhere", prs: [9] });
    const working = row({ what: "Hosted build, follows a-9", branch: "a9-follow-up" });
    expect(linkedAsks(working, [mine, other]).map((one) => one.id)).toEqual(["a-2"]);
    expect(linkedAsks(working, [other])).toEqual([]);
    const pr = row({ id: "pr:x#21", chat: "pr-21", prs: [21], what: "#21 Port change, after a-9" });
    expect(linkedAsks(pr, [{ ...mine, chat: "elsewhere", prs: [21] }, other]).map((one) => one.id)).toEqual(["a-2"]);
    expect(linkedAsks(pr, [other]).map((one) => one.id)).toEqual(["a-9"]);
  });

  it("a fix chat with no ask finds its ops record: its chat's newest with work under way, since the chat started", () => {
    const record = (extra: Partial<OpsStatus>): OpsStatus =>
      ({ kind: "disk", key: "data", state: "in-progress", chat: "fix-disk-data-9", since: at(0), updatedAt: at(0), version: 1, ...extra }) as OpsStatus;
    const fix = row({ chat: "fix-disk-data-9", what: "Fixing the red for a-9", branch: "a9-disk" });
    expect(linkedAsks(fix, [ask("a-9", 0, { chat: "build-chat" })])).toEqual([]);
    const newest = record({ updatedAt: at(20), cause: "the volume filled" });
    expect(opsRecordOf(fix, [record({}), newest, record({ chat: "other" })])).toBe(newest);
    expect(opsRecordOf(fix, [record({ repo: OTHER })])).toBeUndefined();
    expect(opsRecordOf(fix, [record({ state: "investigating" })])?.state).toBe("investigating");
    for (const state of ["fixed", "parked", "backlog"] as const) expect(opsRecordOf(fix, [record({ state })])).toBeUndefined();
    const started = row({ chat: "fix-disk-data-9", startedAt: Date.parse(at(10)) });
    expect(opsRecordOf(started, [record({})])).toBeUndefined();
    expect(opsRecordOf(started, [record({}), newest])).toBe(newest);
    // Since the chat started, a record it marked fixed while its PR waits still shows.
    expect(opsRecordOf(started, [record({ state: "fixed", updatedAt: at(30) })])?.state).toBe("fixed");
    expect(opsRecordOf(started, [record({ state: "fixed", updatedAt: at(5) })])).toBeUndefined();
  });

  it("links an ask's source: its Chat line, else the issue it started from, in the repo its chat's worktree reads", () => {
    expect(askSourceLink(ask("a-1", 0, { source: "message:m_1" }), "m_1")).toEqual({ line: "m_1" });
    expect(askSourceLink(ask("a-1", 0, { source: `backlog:${MS}#77` }), null)).toEqual({ issue: 77, href: `https://github.com/${MS}/issues/77` });
    // A backlog source whose repo is not owner/name is not read as one.
    expect(askSourceLink(ask("a-1", 0, { source: `backlog:${MS}#1#2` }), null)).toBeNull();
    expect(askSourceLink(ask("a-1", 0, { issue: 78 }), null)).toEqual({ issue: 78, href: `https://github.com/${MS}/issues/78` });
    expect(askSourceLink(ask("a-1", 0, { chat: "build-chat", issue: 78 }), null, [row({ project: OTHER })])).toEqual({ issue: 78, href: `https://github.com/${OTHER}/issues/78` });
    expect(askSourceLink(ask("a-1", 0), null)).toBeNull();
  });

  it("merges several asks' cards one each, oldest first", () => {
    const card = (id: string, minutes: number) => ({ card: { id, since: at(minutes) } }) as TicketCard;
    expect(mergedCards([[card("b", 20)], [card("a", 10), card("b", 20)]]).map((one) => one.card.id)).toEqual(["a", "b"]);
  });
});
