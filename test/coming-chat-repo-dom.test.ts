// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { settleComing } from "../src/server/stamps.js";
import type { Board, BoardChat, ComingItem, ServedBoard } from "../src/shared/board.js";
import { NO_REPO } from "../src/shared/repos.js";
import { app, changed } from "../web/src/state.js";
import { choiceText, comingKey, openComingSheet } from "../web/src/views/coming-sheet.js";
import { comingChatRepo } from "../web/src/views/queue-cards.js";
import { closeSheet } from "../web/src/views/sheet.js";
import { closeWorkerSheet, openWorkerSheet } from "../web/src/views/worker-sheet.js";

const OTHER = "example-org/other-repo";
const MS = "example-org/example-repo";
const ITEM: ComingItem = { pr: 41, title: "Other repo menu fix", stage: "building", chat: "fix-menu" };

function setBoard(chats: BoardChat[], coming: ComingItem[] = [ITEM]): ServedBoard {
  const board = { updatedAt: "2026-10-01T01:00:00Z", needs: [], chats, coming, shipped: [] } as unknown as ServedBoard;
  app.board = { version: 1, updatedAt: board.updatedAt, board } as never;
  return board;
}

/** Opens the first Coming item's sheet, as Plan's row does; returns what Open chat was called with. */
function openFirstComing(board: ServedBoard): [string, string | undefined][] {
  const opened: [string, string | undefined][] = [];
  openComingSheet(board.coming[0]!, (name, repo) => opened.push([name, repo]));
  return opened;
}

const openChatButton = () => [...document.querySelectorAll<HTMLButtonElement>(".sheet .cs-actions button")].find((btn) => btn.textContent === "Open chat")!;
const prLink = () => document.querySelector<HTMLAnchorElement>(".sheet .cs-pr")!.getAttribute("href");

afterEach(() => {
  closeSheet();
  closeWorkerSheet();
  document.body.replaceChildren();
  localStorage.clear();
  app.board = null;
  vi.unstubAllGlobals();
});

describe("Coming → Open chat", () => {
  it("opens the chat, and links the PR, in the repo that holds the item's PR when two repos share the chat's name", () => {
    const opened = openFirstComing(
      setBoard([
        { name: "fix-menu", state: "working", repo: MS, prs: [2901] },
        { name: "fix-menu", state: "working", repo: OTHER, prs: [41] },
      ] as BoardChat[]),
    );
    expect(prLink()).toBe(`https://github.com/${OTHER}/pull/41`);
    openChatButton().click();
    expect(opened).toEqual([["fix-menu", OTHER]]);
  });

  it("follows the board as it is now: a chat that appears after the sheet opened takes its repo", () => {
    const opened = openFirstComing(setBoard([]));
    expect(prLink()).toBe(`https://github.com/${MS}/pull/41`);
    setBoard([{ name: "fix-menu", state: "working", repo: OTHER, prs: [41] }] as BoardChat[]);
    changed();
    expect(prLink()).toBe(`https://github.com/${OTHER}/pull/41`);
    openChatButton().click();
    expect(opened).toEqual([["fix-menu", OTHER]]);
  });

  it("does not let the board's order choose between two repos claiming the same chat and PR", () => {
    const a = { name: "fix-menu", state: "working", repo: OTHER, prs: [41] } as BoardChat;
    const b = { name: "fix-menu", state: "working", repo: "example-org/third-repo", prs: [41] } as BoardChat;
    expect(comingChatRepo([a, b], "fix-menu", 41)).toBeNull();
    expect(comingChatRepo([b, a], "fix-menu", 41)).toBeNull();
    // One repo among them answers, whichever chat comes first.
    expect(comingChatRepo([{ ...a, prs: [7] }, a], "fix-menu", 41)).toBe(OTHER);
    expect(comingChatRepo([a], "fix-menu")).toBe(OTHER);
    expect(comingChatRepo([], "fix-menu", 41)).toBeUndefined();
  });

  it("keeps a numbered Coming row whose chat has moved to another PR, whatever the default repo's PR of that number did", () => {
    const G = OTHER;
    const t = "2026-10-06T00:00:00Z";
    const board = { updatedAt: t, needs: [], chats: [{ name: "fix-menu", state: "working", repo: G, prs: [42] }], coming: [{ title: "Other repo menu fix", chat: "fix-menu-73", pr: 41 }], shipped: [{ pr: 41, title: "Unrelated" }] } as unknown as Board;
    const settled = settleComing(board, { merged: [], closed: [{ repo: NO_REPO, number: 41, closedAt: t }], open: [{ repo: G, number: 41 }], now: t });
    expect((settled?.board ?? board).coming).toHaveLength(1);
  });

  it("reads a numbered name no chat has as its chat's", () => {
    const a = { name: "fix-menu", state: "working", repo: OTHER, prs: [41] } as BoardChat;
    expect(comingChatRepo([a], "fix-menu-73", 41)).toBe(OTHER);
    expect(comingChatRepo([a], "fix-menu-73", 7)).toBeNull();
    expect(comingChatRepo([a], 7 as unknown as string, 41)).toBeUndefined();
    expect(comingChatRepo([a, { name: "fix-menu-73", state: "working" } as BoardChat], "fix-menu-73", 41)).toBe("example-org/example-repo");
  });

  it("offers no Open chat and no GitHub link when two repos claim the chat, rather than guessing the default repo", () => {
    openFirstComing(
      setBoard([
        { name: "fix-menu", state: "working", repo: OTHER, prs: [41] },
        { name: "fix-menu", state: "working", repo: "example-org/third-repo", prs: [41] },
        { name: "fix-menu", state: "working", repo: MS, prs: [2901] },
      ] as BoardChat[]),
    );
    expect(openChatButton()).toBeUndefined();
    expect(document.querySelector(".sheet .cs-pr")).toBeNull();
    expect(document.querySelector(".sheet .cs-facts")!.textContent).toContain("fix-menu, in more than one repo");
  });
});

describe("worker sheet PR links", () => {
  it("links the board chat's PRs to GitHub in the chat's own repo, and not a same-named chat's in another", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    setBoard([
      { name: "fix-menu", state: "working", repo: MS, prs: [2901] },
      { name: "fix-menu", state: "working", repo: OTHER, prs: [41, 42] },
    ] as BoardChat[]);
    openWorkerSheet({ id: "w1", name: "fix-menu", repo: OTHER, chat: "fix-menu", state: "working", lastOutputAt: null });
    const facts = document.querySelector(".cmd-worker-sheet .scene-facts")!;
    expect([...facts.querySelectorAll("dt")].map((dt) => dt.textContent)).toContain("PRs");
    expect([...facts.querySelectorAll<HTMLAnchorElement>("a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["#41", `https://github.com/${OTHER}/pull/41`],
      ["#42", `https://github.com/${OTHER}/pull/42`],
    ]);
  });

  it("uses a live worker's own PRs when the board has not loaded", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    openWorkerSheet({ id: "w1", name: "fix-menu", repo: OTHER, chat: "fix-menu", state: "working", lastOutputAt: null, prs: [41] });
    expect([...document.querySelectorAll<HTMLAnchorElement>(".cmd-worker-sheet .scene-facts a")].map((a) => a.getAttribute("href"))).toEqual([
      `https://github.com/${OTHER}/pull/41`,
    ]);
  });

  it("keys Start it's record within the item's repo, the default repo's as before", () => {
    const item = { pr: 42, title: "Search tile", chat: "search" } as ComingItem;
    expect([comingKey(item), comingKey(item, NO_REPO), comingKey(item, OTHER)]).toEqual(["42", "42", "other-repo/42"]);
    expect(choiceText(item, "start")).toContain("run rivet fix coming 42 --title");
    expect(choiceText(item, "start", OTHER)).toContain(`run rivet fix coming other-repo/42 --repo ${OTHER} --title`);
  });
});
