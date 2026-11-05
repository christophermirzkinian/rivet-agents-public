import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  boardSchema,
  COMING_STAGES,
  decisionSchema,
  MAX_ETA,
  MAX_ETA_MINUTES,
  MAX_CHOICE,
  MAX_POINT,
  MAX_POINTS,
  MAX_REPLY_TEXT,
  MAX_STEP,
  MAX_STEPS,
  replyCreateSchema,
} from "../src/shared/board.js";
import { EXAMPLE_BOARD } from "./helpers.js";

const clone = () => structuredClone(EXAMPLE_BOARD) as typeof EXAMPLE_BOARD & Record<string, unknown>;

describe("board schema", () => {
  it.each(["decision", "question", "approval"])("keeps publishing compatible with duplicate option labels on a %s card", (kind) => {
    const board = clone();
    const need = board.needs[0]!;
    need.kind = kind;
    need.options![1]!.label = need.options![0]!.label;
    const parsed = boardSchema.safeParse(board);
    expect(parsed.success).toBe(true);
  });

  it("accepts the board Rivet publishes today and keeps unknown keys", () => {
    const board = clone();
    board.extra = { future: true };
    (board.needs[0] as Record<string, unknown>).note = "kept";
    const parsed = boardSchema.parse(board);
    expect(parsed.needs[0]!.id).toBe("pr2022-checkout");
    expect((parsed as Record<string, unknown>).extra).toEqual({ future: true });
    expect((parsed.needs[0] as Record<string, unknown>).note).toBe("kept");
  });

  it("accepts a board as Rivet writes it (live as a boolean, shipped rows without a PR)", () => {
    const sample = JSON.parse(readFileSync(new URL("./fixtures/board-sample.json", import.meta.url), "utf8"));
    const parsed = boardSchema.safeParse(sample);
    expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
  });

  it("defaults missing lists to empty", () => {
    const parsed = boardSchema.parse({ updatedAt: "2026-09-28T03:55:18.875Z" });
    expect(parsed.needs).toEqual([]);
  });

  it.each(["javascript:alert(1)", "http://example.com", "data:text/html,hi", "not a url"])("rejects link %s", (url) => {
    const board = clone();
    board.needs[0]!.links![0]!.url = url;
    expect(boardSchema.safeParse(board).success).toBe(false);
  });

  it.each(["has space", "../etc", "", "x".repeat(101), "a/b"])("rejects need id %j", (id) => {
    const board = clone();
    board.needs[0]!.id = id;
    expect(boardSchema.safeParse(board).success).toBe(false);
  });

  it("rejects a bad chat name, risk or repo, and duplicate ids", () => {
    const badChat = clone();
    badChat.needs[0]!.chat = "rm -rf /";
    expect(boardSchema.safeParse(badChat).success).toBe(false);

    const badRisk = clone();
    (badRisk.needs[1] as Record<string, unknown>).risk = "vibes";
    expect(boardSchema.safeParse(badRisk).success).toBe(false);

    const badRepo = clone();
    (badRepo.needs[0] as Record<string, unknown>).repo = "not a repo";
    expect(boardSchema.safeParse(badRepo).success).toBe(false);

    const dupe = clone();
    dupe.needs[1]!.id = dupe.needs[0]!.id;
    expect(boardSchema.safeParse(dupe).success).toBe(false);
  });

  it("caps reply text at 4000 characters", () => {
    const base = { clientId: "client-0001", itemId: "pr2022-checkout", decision: "comment", rev: "0123456789abcdef" };
    expect(replyCreateSchema.safeParse({ ...base, text: "x".repeat(4000) }).success).toBe(true);
    expect(replyCreateSchema.safeParse({ ...base, text: "x".repeat(4001) }).success).toBe(false);
    expect(replyCreateSchema.safeParse({ ...base, decision: "merge" }).success).toBe(false);
  });

  it("requires a well-formed rev and caps choice at 200", () => {
    const base = { clientId: "client-0001", itemId: "pr2022-checkout", decision: "choice", choice: "OK", rev: "0123456789abcdef" };
    expect(replyCreateSchema.safeParse(base).success).toBe(true);
    const { rev: _rev, ...noRev } = base;
    expect(replyCreateSchema.safeParse(noRev).success).toBe(false);
    expect(replyCreateSchema.safeParse({ ...base, rev: "XYZ" }).success).toBe(false);
    expect(replyCreateSchema.safeParse({ ...base, choice: "x".repeat(201) }).success).toBe(false);
  });

  it("takes several photos as images, and an older client's single image or file exactly as before", () => {
    const base = { clientId: "client-0001", itemId: "pr2022-checkout", decision: "comment", rev: "0123456789abcdef" };
    const [a, b] = ["a".repeat(64), "b".repeat(64)];
    const file = { sha256: "c".repeat(64), name: "Brief.pdf" };
    expect(replyCreateSchema.safeParse({ ...base, image: a }).data).toEqual({ ...base, image: a });
    expect(replyCreateSchema.safeParse({ ...base, image: a, files: [file] }).data).toEqual({ ...base, image: a, files: [file] });
    expect(replyCreateSchema.safeParse({ ...base, images: [a, b], files: [file] }).data).toEqual({ ...base, images: [a, b], files: [file] });
    expect(replyCreateSchema.safeParse({ ...base, images: Array.from({ length: 10 }, (_, i) => i.toString(16).repeat(64)) }).success).toBe(true);
    expect(replyCreateSchema.safeParse({ ...base, images: Array.from({ length: 11 }, (_, i) => i.toString(16).repeat(64)) }).success).toBe(false);
    expect(replyCreateSchema.safeParse({ ...base, images: [a, a] }).success).toBe(false);
    expect(replyCreateSchema.safeParse({ ...base, image: a, images: [b] }).success).toBe(false);
    expect(replyCreateSchema.safeParse({ ...base, images: [] }).success).toBe(false);
  });
});

describe("todo cards", () => {
  const todo = { id: "tax", kind: "todo", title: "Add the tax form in App Store Connect", steps: ["Sign in", "Open Agreements"] };
  const parses = (need: Record<string, unknown>) => boardSchema.safeParse({ updatedAt: "2026-10-01T00:00:00Z", needs: [need] }).success;

  it("keeps a todo card's steps", () => {
    expect(boardSchema.parse({ updatedAt: "2026-10-01T00:00:00Z", needs: [todo] }).needs[0]!.steps).toEqual(["Sign in", "Open Agreements"]);
  });

  it("a todo card needs steps, and no other kind takes them", () => {
    const { steps: _steps, ...bare } = todo;
    expect(parses(bare)).toBe(false);
    expect(parses({ ...todo, kind: "approval" })).toBe(false);
  });

  it("takes 1 to 12 steps of 1 to 300 characters, none blank", () => {
    expect(parses({ ...todo, steps: Array.from({ length: MAX_STEPS }, (_, i) => `Step ${i}`) })).toBe(true);
    expect(parses({ ...todo, steps: Array.from({ length: MAX_STEPS + 1 }, (_, i) => `Step ${i}`) })).toBe(false);
    expect(parses({ ...todo, steps: [] })).toBe(false);
    expect(parses({ ...todo, steps: ["x".repeat(MAX_STEP)] })).toBe(true);
    expect(parses({ ...todo, steps: ["x".repeat(MAX_STEP + 1)] })).toBe(false);
    expect(parses({ ...todo, steps: [""] })).toBe(false);
    expect(parses({ ...todo, steps: ["   "] })).toBe(false);
    expect(parses({ ...todo, steps: [3] })).toBe(false);
  });

  it("done is a decision, for the bridge too", async () => {
    expect(replyCreateSchema.safeParse({ clientId: "client-0001", itemId: "tax", decision: "done", rev: "0123456789abcdef" }).success).toBe(true);
    const bridgePath = "../bridge/lib/validate.mjs";
    const bridge = (await import(bridgePath)) as { DECISIONS: readonly string[] };
    expect([...bridge.DECISIONS]).toEqual([...decisionSchema.options]);
  });
});

describe("board schema agrees with the bridge validator", () => {
  it.each(["example-org/example-repo", "example-org/other-repo"])("accepts well-formed repo %s", (repo) => {
    const board = clone();
    (board.needs[0] as Record<string, unknown>).repo = repo;
    expect(boardSchema.safeParse(board).success).toBe(true);
  });

  it.each(["example-repo", "example-org/example-repo/extra", "-org/example-repo", "example org/example-repo"])("rejects malformed repo %s", (repo) => {
    const board = clone();
    (board.needs[0] as Record<string, unknown>).repo = repo;
    expect(boardSchema.safeParse(board).success).toBe(false);
  });

  it.each([".", "..", "..."])("rejects dot-only id and chat %j", (value) => {
    const id = clone();
    id.needs[0]!.id = value;
    expect(boardSchema.safeParse(id).success).toBe(false);
    const chat = clone();
    chat.needs[0]!.chat = value;
    expect(boardSchema.safeParse(chat).success).toBe(false);
    expect(replyCreateSchema.safeParse({ clientId: "client-0001", itemId: value, decision: "approve", rev: "0123456789abcdef" }).success).toBe(false);
  });

  it("rejects blank and over-long option labels", () => {
    const blank = clone();
    blank.needs[0]!.options![0]!.label = "   ";
    expect(boardSchema.safeParse(blank).success).toBe(false);
    const long = clone();
    long.needs[0]!.options![0]!.label = "x".repeat(201);
    expect(boardSchema.safeParse(long).success).toBe(false);
  });

  it("the bridge's reply limits are the server's", async () => {
    const bridgePath = "../bridge/lib/validate.mjs";
    const bridge = (await import(bridgePath)) as { MAX_TEXT: number; MAX_CHOICE: number };
    expect(bridge.MAX_TEXT).toBe(MAX_REPLY_TEXT);
    expect(bridge.MAX_CHOICE).toBe(MAX_CHOICE);
  });

  it("the bridge's coming stages and ETA cap are the server's", async () => {
    const bridgePath = "../bridge/lib/validate.mjs";
    const bridge = (await import(bridgePath)) as { COMING_STAGES: readonly string[]; MAX_ETA_MINUTES: number };
    expect([...bridge.COMING_STAGES]).toEqual([...COMING_STAGES]);
    expect(bridge.MAX_ETA_MINUTES).toBe(MAX_ETA_MINUTES);
  });
});

describe("coming and chats progress fields", () => {
  it("a title-only coming item and a name-only chat still parse", () => {
    const parsed = boardSchema.parse({ updatedAt: "2026-09-30T00:00:00Z", coming: [{ title: "Old shape" }], chats: [{ name: "docs-refresh", state: "idle" }] });
    expect(parsed.coming).toEqual([{ title: "Old shape" }]);
    expect(parsed.chats[0]).toEqual({ name: "docs-refresh", state: "idle" });
  });

  it("keeps every new coming field and the chat progress fields", () => {
    const item = { pr: 2480, title: "Data Import results", app: "Data Import", what: "Results row", stage: "review", progress: 0.3, etaMinutes: 20, chat: "quiz-round", updatedAt: "2026-09-30T01:00:00Z", requestedAt: "2026-09-29T22:10:00Z" };
    const chat = { name: "quiz-round", state: "working", what: "Results row", stage: "CI", progress: 0.5, etaMinutes: 10, updatedAt: "2026-09-30T01:00:00Z" };
    const parsed = boardSchema.parse({ updatedAt: "2026-09-30T01:00:00Z", coming: [item], chats: [chat] });
    expect(parsed.coming[0]).toEqual(item);
    expect(parsed.chats[0]).toEqual(chat);
  });

  it.each([
    ["an unknown stage", { stage: "shipping" }],
    ["progress over 1", { progress: 1.2 }],
    ["a fractional ETA", { etaMinutes: 2.5 }],
    ["an ETA over a week", { etaMinutes: MAX_ETA_MINUTES + 1 }],
    ["a null stage", { stage: null }],
    ["a blank app", { app: "" }],
    ["a numeric requestedAt", { requestedAt: 1_759_190_000_000 }],
  ])("refuses a coming item with %s", (_, extra) => {
    expect(boardSchema.safeParse({ updatedAt: "2026-09-30T00:00:00Z", coming: [{ title: "x", ...extra }] }).success).toBe(false);
  });
});

describe("plan cards", () => {
  const plan = { id: "picks", kind: "plan", title: "Five colour picks", points: ["Pick 5 at the start", "Save between rounds"], size: "M", eta: "~2:30pm" };
  const parses = (need: Record<string, unknown>) => boardSchema.safeParse({ updatedAt: "2026-10-11T00:00:00Z", needs: [need] }).success;

  it("keeps a plan's points, size and ETA", () => {
    const [parsed] = boardSchema.parse({ updatedAt: "2026-10-11T00:00:00Z", needs: [plan] }).needs;
    expect([parsed!.points, parsed!.size, parsed!.eta]).toEqual([["Pick 5 at the start", "Save between rounds"], "M", "~2:30pm"]);
    const { points: _points, size: _size, eta: _eta, ...bare } = plan;
    expect(parses(bare)).toBe(true);
  });

  it("takes 1 to 8 points of at most 200 characters, none blank, a size of S, M or L, and an ETA of at most 40", () => {
    expect(parses({ ...plan, points: Array.from({ length: MAX_POINTS }, (_, i) => `Point ${i}`) })).toBe(true);
    expect(parses({ ...plan, points: Array.from({ length: MAX_POINTS + 1 }, (_, i) => `Point ${i}`) })).toBe(false);
    expect(parses({ ...plan, points: [] })).toBe(false);
    expect(parses({ ...plan, points: ["  "] })).toBe(false);
    expect(parses({ ...plan, points: ["x".repeat(MAX_POINT)] })).toBe(true);
    expect(parses({ ...plan, points: ["x".repeat(MAX_POINT + 1)] })).toBe(false);
    expect(parses({ ...plan, size: "XL" })).toBe(false);
    expect(parses({ ...plan, eta: "x".repeat(MAX_ETA) })).toBe(true);
    expect(parses({ ...plan, eta: "x".repeat(MAX_ETA + 1) })).toBe(false);
    expect(parses({ ...plan, eta: " " })).toBe(false);
  });

  it("a plan takes no options or reply, and no other kind takes points, a size or an ETA", () => {
    expect(parses({ ...plan, options: [{ label: "Go" }, { label: "Wait" }] })).toBe(false);
    expect(parses({ ...plan, reply: "text" })).toBe(false);
    for (const field of [{ points: ["a"] }, { size: "S" }, { eta: "today" }]) expect(parses({ id: "d", kind: "decision", title: "Pick", ...field })).toBe(false);
  });
});
