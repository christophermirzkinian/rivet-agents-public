// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import type { BoardChat, ComingItem, ServedBoard } from "../src/shared/board.js";
import type { Worker } from "../src/shared/workers.js";
import { app } from "../web/src/state.js";
import { comingRowRepo } from "../web/src/views/board.js";
import { resetComingSheet } from "../web/src/views/coming-sheet.js";
import { closeSheet } from "../web/src/views/sheet.js";
import { resetComingFilter } from "../web/src/views/coming-filter.js";

const MS = "example-org/example-repo";
const HOUR = 3600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function render(lists: { chats?: BoardChat[]; coming?: ComingItem[] }, workers: Partial<Worker>[] = []): void {
  const board = { updatedAt: ago(0), needs: [], coming: [], chats: [], shipped: [], ...lists } as unknown as ServedBoard;
  app.board = { version: 1, updatedAt: board.updatedAt, board };
  app.workers = {
    at: ago(0),
    workers: [{ id: "h", name: "Rivet", repo: MS, chat: "rivet-main", state: "working", lastOutputAt: null, rivet: true }, ...workers].map((worker) => ({
      id: `w-${worker.chat}`,
      name: worker.chat!,
      repo: MS,
      state: "idle",
      lastOutputAt: null,
      ...worker,
    })) as Worker[],
  };
  app.workersAt = Date.now();
}

afterEach(() => {
  closeSheet();
  resetComingSheet();
  document.body.replaceChildren();
  localStorage.clear();
  resetComingFilter();
  app.board = null;
  app.workers = null;
  app.workersAt = null;
});

describe("a Coming row's repo", () => {
  it("is the board's for its chat, else where its one live terminal is", () => {
    const coming = [
      { title: "Notes", stage: "building", chat: "notes-slices", touchedAt: ago(HOUR) },
      { title: "Repo fix", stage: "building", chat: "fix", touchedAt: ago(HOUR) },
    ] as ComingItem[];
    const chats = [
      { name: "notes-slices", state: "working" },
      { name: "fix", state: "working", repo: "example-org/example-repo" },
    ] as BoardChat[];
    render({ coming, chats }, [
      { chat: "notes-slices", state: "working", repo: "example-org/notes" },
      // The board names example-repo for "fix", so the other repo's chat of that name is not it.
      { chat: "fix", state: "working", repo: "example-org/other" },
    ]);
    expect(comingRowRepo(chats, coming[0]!)).toBe("example-org/notes");
    expect(comingRowRepo(chats, coming[1]!)).toBe("example-org/example-repo");
    // A chat the board does not list is found where its one live terminal is.
    expect(comingRowRepo(chats, { title: "Elsewhere", chat: "notes-slices", pr: 4 } as ComingItem)).toBe("example-org/notes");
    expect(comingRowRepo([], { title: "Elsewhere", chat: "notes-slices", pr: 4 } as ComingItem)).toBe("example-org/notes");
  });
});
