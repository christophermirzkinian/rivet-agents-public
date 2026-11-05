// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpsResponse, PullRequest } from "../src/shared/ops.js";
import { opsData } from "../web/src/ops-data.js";
import { app, changed } from "../web/src/state.js";
import * as agents from "../web/src/views/agents.js";

const NOW = "2026-10-06T02:00:00.000Z";
const R = "example-org/example-repo";
const pr = (number: number, extra: Partial<PullRequest> = {}): PullRequest => ({
  repo: R,
  number,
  title: `PR ${number}`,
  url: `https://github.com/${R}/pull/${number}`,
  draft: false,
  author: "a",
  labels: [],
  headAt: NOW,
  updatedAt: NOW,
  checks: { state: "pass", passed: 1, failed: 0, pending: 0, failing: [] },
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  app.board = {
    version: 1,
    updatedAt: NOW,
    board: { updatedAt: NOW, needs: [{ id: "n1", kind: "approval", title: "Approve the video?", chat: "invoices", rev: "0123456789abcdef" }], coming: [], chats: [], shipped: [] },
  };
  app.workers = {
    at: NOW,
    workers: [
      { id: "h", name: "Rivet", repo: R, chat: "lead", state: "working", lastOutputAt: null, rivet: true },
      { id: "a", name: "A", repo: R, chat: "kanban", state: "working", lastOutputAt: null, doing: "Agents board", branch: "x/kanban" },
      { id: "b", name: "B", repo: R, chat: "invoices", state: "waiting", lastOutputAt: null },
    ],
  };
  opsData.ops = { now: NOW, github: { at: NOW, prs: [pr(7, { branch: "x/kanban" })], stale: false, sources: null } } as unknown as OpsResponse;
  opsData.at = Date.now();
  app.workersAt = Date.now();
  opsData.opsAt = { mono: performance.now(), wall: Date.now() };
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

const column = (name: string) => agents.cards().filter((card) => card.column === name).map((card) => card.chat);

describe("the agent chats Progress reads", () => {
  it("puts each chat in its column, leaves Rivet out, and links its PR", () => {
    expect(column("review")).toEqual(["kanban"]);
    expect(column("waiting")).toEqual(["invoices"]);
    expect(agents.cards().map((card) => card.chat)).not.toContain("lead");
    expect(column("merged")).toEqual([]);
    expect(agents.cards().find((card) => card.chat === "kanban")?.pr).toEqual({ number: 7, url: `https://github.com/${R}/pull/7` });
  });

  it("moves a chat to waiting once a card waits on you from it", () => {
    app.board!.board!.needs.push({ id: "n2", kind: "approval", title: "Merge the board?", chat: "kanban", rev: "0123456789abcdef" });
    changed();
    expect(column("waiting").sort()).toEqual(["invoices", "kanban"]);
  });

  it("leaves update cards out of the cards waiting on you", () => {
    app.board!.board!.needs.push({ id: "u1", kind: "update", title: "Search box deployed", thread: "Search box", rev: "r1", since: NOW } as never);
    changed();
    expect(agents.needs().map((need) => need.id)).toEqual(["n1"]);
  });

  it("drops the crew once its snapshot is past its age", () => {
    app.workersAt = Date.now() - 10 * 60 * 60_000;
    expect(column("review")).toEqual([]);
    expect(column("waiting")).toEqual(["invoices"]);
  });
});

describe("Progress's copy button", () => {
  it("is one Copy summary, the one Rivet's sheet shows", () => {
    expect([...agents.copyButtons().querySelectorAll(".agents-copy-btn")].map((button) => button.textContent)).toEqual(["Copy summary"]);
  });
});
