import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import type { Ask } from "../src/shared/asks.js";
import { boardSchema, type Board } from "../src/shared/board.js";
import { RIVET_NAME } from "../src/shared/names.js";
import { HUNG_MS, SNAPSHOT_STALE_MS, TYPED_FRESH_MS, type SnapshotWorker, type WorkersResponse } from "../src/shared/workers.js";
import { Store } from "../src/server/store.js";
import { deriveWorkers, isRivet } from "../src/server/workers.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, oversizedStatus, putBoard, startServer, type TestServer } from "./helpers.js";

const MS = "example-org/example-repo";
const SIDE = "example-org/side-app";

beforeEach(() => {
  vi.stubEnv("RIVET_REPOS", `${MS},${SIDE}`);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function worker(chat: string, extra: Partial<SnapshotWorker> = {}): SnapshotWorker {
  return {
    worktreeId: createHash("sha256").update(`${extra.repo ?? MS}/${chat}`).digest("hex").slice(0, 16),
    repo: MS,
    chat,
    connected: true,
    lastOutputAt: Date.now(),
    agent: "claude",
    ...extra,
  };
}

describe("PUT /api/bridge/workers", () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startServer();
  });
  afterEach(async () => {
    await server.close();
  });

  const put = (body: unknown, headers = bearer(BRIDGE_TOKEN)) =>
    fetch(`${server.base}/api/bridge/workers`, { method: "PUT", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("needs the bridge token", async () => {
    expect((await put({ workers: [] }, bearer(BOARD_TOKEN))).status).toBe(401);
    expect((await put({ workers: [] }, { "content-type": "application/json" })).status).toBe(401);
    expect((await put({ workers: [worker("ace")] })).status).toBe(200);
    expect((await put({ workers: [worker("ace", { branch: "sam/ace" })] })).status).toBe(200);
  });

  it("rejects fields beyond the metadata, such as terminal output", async () => {
    expect((await put({ workers: [{ ...worker("ace"), preview: "$ cat secrets" }] })).status).toBe(400);
    expect((await put({ workers: [worker("ace")], output: "x" })).status).toBe(400);
    expect((await put({ workers: [{ ...worker("ace"), title: "◐ Rivet app" }] })).status).toBe(400);
    expect((await put({ workers: [{ ...worker("ace"), busy: "◐ Rivet app" }] })).status).toBe(400);
    expect(server.app.store.getWorkers()).toBeNull();
  });

  it("rejects malformed repos, bad chats, bad ids and duplicates", async () => {
    for (const bad of [
      worker("ace", { repo: "someone/else/extra" as SnapshotWorker["repo"] }),
      worker("../etc"),
      worker("ace", { chat: "has space" }),
      worker("ace", { worktreeId: "-x" }),
      worker("ace", { worktreeId: `uuid::${join(tmpdir(), "ace")}` }),
      worker("ace", { worktreeId: "ABCDEF0123456789" }),
      worker("ace", { agent: "claude code" }),
      worker("ace", { lastOutputAt: -1 }),
      worker("ace", { lastOutputAt: 1.5 }),
      worker("ace", { branch: "a..b" }),
      worker("ace", { branch: "has space" }),
    ]) {
      expect((await put({ workers: [bad] })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await put({ workers: [worker("ace"), worker("ace")] })).status).toBe(400);
  });

  it("caps the count and the body size", async () => {
    const many = Array.from({ length: 301 }, (_, i) => worker(`c${i}`));
    expect((await put({ workers: many })).status).toBe(400);
    expect(await oversizedStatus(put(`{"workers":[],"pad":"${"x".repeat(300 * 1024)}"}`))).toBe(413);
  });
});

describe("GET /api/workers", () => {
  let server: TestServer;
  let cookie: string;
  beforeEach(async () => {
    server = await startServer({ RIVET_MONITOR_CHAT: "rivet" });
    cookie = server.cookie();
  });
  afterEach(async () => {
    await server.close();
  });

  it("needs a session or the board token", async () => {
    expect((await fetch(`${server.base}/api/workers`)).status).toBe(401);
    expect((await fetch(`${server.base}/api/workers`, { headers: bearer(BRIDGE_TOKEN) })).status).toBe(401);
    expect((await fetch(`${server.base}/api/workers`, { headers: bearer(BOARD_TOKEN) })).status).toBe(200);
  });

  it("takes the repo a chat's work is in from the bridge, only a well-formed one, and boxes the chat by it", async () => {
    const put = (workers: unknown[]) => fetch(`${server.base}/api/bridge/workers`, { method: "PUT", headers: bearer(BRIDGE_TOKEN), body: JSON.stringify({ workers }) });
    expect((await put([worker("gamma", { workRepo: "someone/else/extra" } as never)])).status).toBe(400);
    expect((await put([worker("gamma", { workRepo: "example-org/gamma-app" }), worker("lobby")])).status).toBe(200);
    const body = (await (await fetch(`${server.base}/api/workers`, { headers: bearer(BOARD_TOKEN) })).json()) as WorkersResponse;
    const of = (chat: string) => body.workers.find((w) => w.chat === chat)!;
    expect(of("gamma")).toMatchObject({ repo: MS, project: "example-org/gamma-app", boxFrom: "folder" });
    expect(of("lobby")).toMatchObject({ repo: MS, boxGuess: true });
    expect(of("lobby").project).toBeUndefined();
  });

  it("is empty before the first snapshot", async () => {
    const body = (await (await fetch(`${server.base}/api/workers`, { headers: { cookie } })).json()) as WorkersResponse;
    expect(body).toEqual({ at: null, workers: [] });
  });

  it("names workers, flags Rivet, joins doing and derives state", async () => {
    await putBoard(server.base, {
      updatedAt: "2026-09-28T00:00:00Z",
      needs: [{ id: "n1", kind: "approval", title: "Approve", chat: "checkout" }],
      chats: [{ name: "checkout", state: "waiting", doing: "Waiting on the video OK" }],
    });
    const old = Date.now() - 10 * 60_000;
    const snapshot = {
      workers: [
        worker("rivet"),
        worker("checkout", { lastOutputAt: old }),
        worker("quiet", { lastOutputAt: null }),
        worker("gone", { connected: false }),
      ],
    };
    const res = await fetch(`${server.base}/api/bridge/workers`, { method: "PUT", headers: bearer(BRIDGE_TOKEN), body: JSON.stringify(snapshot) });
    expect(res.status).toBe(200);
    const body = (await (await fetch(`${server.base}/api/workers`, { headers: { cookie } })).json()) as WorkersResponse;
    expect(body.at).toBeTruthy();
    expect(body.workers[0]?.chat).toBe("rivet");
    expect(Object.fromEntries(body.workers.map((w) => [w.chat, w.state]))).toEqual({
      rivet: "working",
      "checkout": "waiting",
      quiet: "idle",
    });
    const [rivet, ...rest] = body.workers;
    expect(rivet).toMatchObject({ name: RIVET_NAME, rivet: true, repo: MS });
    for (const w of rest) {
      expect(w.name).toBe(w.chat);
      expect(w.rivet).toBeUndefined();
    }
    expect(rest.find((w) => w.chat === "checkout")?.doing).toBe("Waiting on the video OK");
    expect(body.workers.some((w) => w.chat === "gone")).toBe(false);
  });
});

describe("deriveWorkers", () => {
  const now = 1_800_000_000_000;
  const board = boardSchema.parse({
    updatedAt: "x",
    needs: [
      { id: "a", kind: "approval", title: "A", chat: "ace" },
      { id: "b", kind: "approval", title: "B", chat: "pond", repo: SIDE },
    ],
    chats: [
      { name: "ace", state: "x", doing: "Doing A" },
      { name: "pond", state: "x", doing: "Kids pond", repo: SIDE },
    ],
  });
  const fresh = new Date(now - 20_000).toISOString();

  function stored(workers: SnapshotWorker[]) {
    return { snapshot: { workers }, at: fresh };
  }

  it("carries the branch each worktree has checked out, and none when the bridge sent none", () => {
    const result = deriveWorkers(stored([worker("ace", { branch: "sam/ace" }), worker("bee")]), board, "rivet", now);
    expect(result.workers.map((w) => [w.chat, w.branch])).toEqual([
      ["ace", "sam/ace"],
      ["bee", undefined],
    ]);
  });

  it("the title glyph beats output time; working with a card open is needsYou, not waiting", () => {
    const result = deriveWorkers(
      stored([
        worker("ace", { lastOutputAt: now - 5 * 60_000, busy: true }),
        worker("quiet", { lastOutputAt: now - 5 * 60_000, busy: true }),
        worker("hung", { lastOutputAt: now - HUNG_MS, busy: true }),
        worker("chatty", { lastOutputAt: now - 1000, busy: false }),
        worker("pond", { repo: SIDE, lastOutputAt: now - 1000, busy: false }),
        worker("old", { lastOutputAt: now - 1000, busy: null }),
      ]),
      board,
      "rivet",
      now,
    );
    const find = (repo: string, chat: string) => result.workers.find((w) => w.repo === repo && w.chat === chat);
    expect(find(MS, "ace")).toMatchObject({ state: "working", needsYou: true });
    expect(find(MS, "quiet")?.state).toBe("working");
    expect(find(MS, "quiet")?.needsYou).toBeUndefined();
    expect(find(MS, "chatty")?.state).toBe("idle");
    expect(find(SIDE, "pond")?.state).toBe("waiting");
    expect(find(SIDE, "pond")?.needsYou).toBeUndefined();
    expect(find(MS, "old")?.state).toBe("working");
    expect(find(MS, "hung")?.state).toBe("idle");
    expect(result.workers.map((w) => [w.chat, w.busy])).toContainEqual(["old", undefined]);
    expect(find(MS, "hung")?.busy).toBe(true);
  });

  it("a card naming a numbered chat waits on the live chat it numbers, unless that numbered chat is live itself", () => {
    const numbered = boardSchema.parse({ updatedAt: "x", needs: [{ id: "t", kind: "approval", title: "T", chat: "docs-sync-73" }] });
    const idle = { lastOutputAt: now - 5 * 60_000, busy: false };
    const one = deriveWorkers(stored([worker("docs-sync", idle)]), numbered, "rivet", now);
    expect(one.workers[0]?.state).toBe("waiting");
    const both = deriveWorkers(stored([worker("docs-sync", idle), worker("docs-sync-73", idle)]), numbered, "rivet", now);
    expect(both.workers.map((w) => [w.chat, w.state])).toEqual([
      ["docs-sync", "idle"],
      ["docs-sync-73", "waiting"],
    ]);
  });

  it("carries each chat's PRs, when its entry last moved, and the Coming item it is delivering", () => {
    const moved = new Date(now - 25 * 60_000).toISOString();
    const workBoard = boardSchema.parse({
      updatedAt: "x",
      chats: [
        { name: "ace", state: "x", prs: [2821], moved },
        { name: "pond", state: "x", repo: SIDE },
      ],
      coming: [
        { title: "Shipped already", chat: "ace", stage: "shipped", pr: 2700 },
        { title: "Town Cinematic button", chat: "ace", stage: "owner-ok", pr: 2821 },
        { title: "Later one", chat: "ace", stage: "building" },
      ],
    });
    const result = deriveWorkers(stored([worker("ace", { busy: true }), worker("pond", { repo: SIDE, busy: true })]), workBoard, "rivet", now);
    expect(result.workers.find((w) => w.chat === "ace")).toMatchObject({
      prs: [2821],
      movedAt: moved,
      delivering: { pr: 2821, title: "Town Cinematic button", stage: "owner-ok" },
    });
    const pond = result.workers.find((w) => w.chat === "pond")!;
    expect([pond.prs, pond.movedAt, pond.delivering]).toEqual([undefined, undefined, undefined]);
  });

  it("a Coming item for a chat name two repos share goes only to the one whose board entry lists its PR", () => {
    const twoBoard = boardSchema.parse({
      updatedAt: "x",
      chats: [
        { name: "charts", state: "x", prs: [2821] },
        { name: "charts", state: "x", repo: SIDE },
      ],
      coming: [{ title: "Third rates", chat: "charts", stage: "review", pr: 2821 }],
    });
    const both = deriveWorkers(stored([worker("charts", { busy: true }), worker("charts", { repo: SIDE, busy: true })]), twoBoard, "rivet", now);
    expect(both.workers.find((w) => w.repo === MS)?.delivering?.pr).toBe(2821);
    expect(both.workers.find((w) => w.repo === SIDE)?.delivering).toBeUndefined();
  });

  it("two repos' chats of one name each deliver their own repo's Coming row; a row of the main repo's chat is not the third repo's", () => {
    const third = "example-org/third-repo";
    const crew = stored([worker("lab", { busy: true }), worker("lab", { repo: third, busy: true })]);
    const twoBoard = boardSchema.parse({
      updatedAt: "x",
      chats: [
        { name: "lab", state: "x", prs: [100], repo: MS },
        { name: "lab", state: "x", prs: [200], repo: third },
      ],
      coming: [
        { title: "Software lab", chat: "lab", stage: "review", pr: 100 },
        { title: "Third lab", chat: "lab", stage: "building", pr: 200 },
      ],
    });
    const both = deriveWorkers(crew, twoBoard, "rivet", now);
    expect(both.workers.find((w) => w.repo === MS)?.delivering).toEqual({ pr: 100, title: "Software lab", stage: "review" });
    expect(both.workers.find((w) => w.repo === third)?.delivering).toEqual({ pr: 200, title: "Third lab", stage: "building" });
    const mainOnly = boardSchema.parse({
      updatedAt: "x",
      chats: [{ name: "lab", state: "x", prs: [100], repo: MS }],
      coming: [{ title: "Software lab", chat: "lab", stage: "review", pr: 100 }],
    });
    const third1 = deriveWorkers(stored([worker("lab", { repo: third, busy: true })]), mainOnly, "rivet", now);
    expect(third1.workers.find((w) => w.repo === third)?.delivering).toBeUndefined();
  });

  it("a quiet chat whose board state reads blocked is blocked; a card for it still says waiting", () => {
    const blockedBoard = boardSchema.parse({
      updatedAt: "x",
      needs: [{ id: "a", kind: "approval", title: "A", chat: "ace" }],
      chats: [
        { name: "ace", state: "blocked on CI" },
        { name: "ci", state: "CI red" },
        { name: "stuck", state: "Stuck" },
        { name: "busy", state: "failing tests" },
        { name: "calm", state: "ready for review" },
      ],
    });
    const quiet = { lastOutputAt: now - 30 * 60_000, busy: false } as const;
    const result = deriveWorkers(
      stored([worker("ace", quiet), worker("ci", quiet), worker("stuck", quiet), worker("busy", { lastOutputAt: now - 1000, busy: true }), worker("calm", quiet)]),
      blockedBoard,
      "rivet",
      now,
    );
    const state = (chat: string) => result.workers.find((w) => w.chat === chat)?.state;
    expect(state("ace")).toBe("waiting");
    expect(state("ci")).toBe("blocked");
    expect(state("stuck")).toBe("blocked");
    expect(state("busy")).toBe("working");
    expect(state("calm")).toBe("idle");
  });

  it("working beats waiting; waiting matches repo and chat; else idle", () => {
    const result = deriveWorkers(
      stored([
        worker("ace", { lastOutputAt: now - 60_000 }),
        worker("ace", { repo: SIDE, lastOutputAt: now - 5 * 60_000 }),
        worker("pond", { repo: SIDE, lastOutputAt: now - 5 * 60_000 }),
        worker("pond", { lastOutputAt: now - 2 * 60_000 }),
      ]),
      board,
      "rivet",
      now,
    );
    const state = (repo: string, chat: string) => result.workers.find((w) => w.repo === repo && w.chat === chat)?.state;
    expect(state(MS, "ace")).toBe("working");
    expect(state(SIDE, "ace")).toBe("idle");
    expect(state(SIDE, "pond")).toBe("waiting");
    expect(state(MS, "pond")).toBe("idle");
  });

  it("joins doing by repo and chat, not chat alone", () => {
    const result = deriveWorkers(
      stored([worker("ace"), worker("ace", { repo: SIDE }), worker("pond"), worker("pond", { repo: SIDE })]),
      board,
      "rivet",
      now,
    );
    const doing = (repo: string, chat: string) => result.workers.find((w) => w.repo === repo && w.chat === chat)?.doing;
    expect(doing(MS, "ace")).toBe("Doing A");
    expect(doing(SIDE, "ace")).toBeUndefined();
    expect(doing(SIDE, "pond")).toBe("Kids pond");
    expect(doing(MS, "pond")).toBeUndefined();
  });

  it("carries a chat's pill fields, read defensively: clamped, cut, and dropped when malformed", () => {
    // Straight from JSON, as a board stored before the schema knew these fields would be: the reader cannot trust it.
    const withStatus = {
      updatedAt: "x",
      chats: [
        { name: "ace", state: "x", what: " Kiosk page flip ", progress: 1.4, etaMinutes: 20.4, updatedAt: "2026-09-30T10:00:00.000Z", stage: "Build", touchedAt: fresh },
        { name: "pond", state: "x", what: "", progress: "half", etaMinutes: -3, updatedAt: "yesterday", stage: "s".repeat(90) },
        { name: "rates", state: "x", doing: "An old entry" },
        { name: "long", state: "x", what: "w".repeat(300), progress: -0.2, etaMinutes: 99_999 },
      ],
    } as unknown as Board;
    const result = deriveWorkers(stored([worker("ace"), worker("pond"), worker("rates"), worker("long")]), withStatus, "rivet", now);
    const pick = (chat: string) => {
      const w = result.workers.find((x) => x.chat === chat)!;
      return { what: w.what, progress: w.progress, etaMinutes: w.etaMinutes, updatedAt: w.updatedAt, stage: w.stage };
    };
    expect(pick("ace")).toEqual({ what: "Kiosk page flip", progress: 1, etaMinutes: 20, updatedAt: "2026-09-30T10:00:00.000Z", stage: "Build" });
    expect(pick("pond")).toEqual({ what: undefined, progress: undefined, etaMinutes: 0, updatedAt: undefined, stage: "s".repeat(40) });
    expect(pick("rates")).toEqual({ what: undefined, progress: undefined, etaMinutes: undefined, updatedAt: undefined, stage: undefined });
    expect(pick("long")).toMatchObject({ what: "w".repeat(200), progress: 0, etaMinutes: 10_080 });
  });

  it.each([now - 60_000, now, now + 60_000])("a chat's typed doing, blocked and progress go a day after its row was last touched; a merged item is not delivering (wall clock %s)", (wallNow) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(wallNow);
    onTestFinished(() => clock.mockRestore());
    const day = (ms: number) => new Date(now - ms).toISOString();
    const typed = boardSchema.parse({
      updatedAt: "x",
      coming: [
        { pr: 3788, title: "Cookie hole", stage: "review", chat: "ace", mergedAt: day(3600_000) },
        { pr: 3790, title: "Pond fix", stage: "building", chat: "bee" },
      ],
      chats: [
        { name: "ace", state: "blocked on you", doing: "Old work", progress: 0.9, touchedAt: day(TYPED_FRESH_MS + 1) },
        { name: "bee", state: "blocked on you", doing: "New work", progress: 0.4, touchedAt: day(TYPED_FRESH_MS - 1000) },
      ],
    });
    // These workers are quiet relative to the derivation clock, whatever today's date is.
    const quiet = { lastOutputAt: now - 10 * 60_000 };
    const result = deriveWorkers(stored([worker("ace", quiet), worker("bee", quiet)]), typed, "rivet", now);
    const pick = (chat: string) => {
      const w = result.workers.find((x) => x.chat === chat)!;
      return { state: w.state, doing: w.doing, progress: w.progress, delivering: w.delivering?.pr };
    };
    expect(pick("ace")).toEqual({ state: "idle", doing: undefined, progress: undefined, delivering: undefined });
    expect(pick("bee")).toEqual({ state: "blocked", doing: "New work", progress: 0.4, delivering: 3790 });
  });

  it("a snapshot older than the stale window has nobody live, Rivet included", () => {
    const workers = [worker("rivet"), worker("ace", { lastOutputAt: now - 1000 })];
    const at = (ms: number) => ({ ...stored(workers), at: new Date(now - ms).toISOString() });
    expect(deriveWorkers(at(SNAPSHOT_STALE_MS), board, "rivet", now).workers).toHaveLength(2);
    const stale = deriveWorkers(at(SNAPSHOT_STALE_MS + 1), board, "rivet", now);
    expect(stale.workers).toEqual([]);
    expect(stale.at).toBe(new Date(now - SNAPSHOT_STALE_MS - 1).toISOString());
  });

  it("only the monitor chat in the default repo is Rivet", () => {
    expect(isRivet({ chat: "rivet", repo: MS }, "rivet")).toBe(true);
    expect(isRivet({ chat: "rivet", repo: SIDE }, "rivet")).toBe(false);
    expect(isRivet({ chat: "ace", repo: MS }, "rivet")).toBe(false);
  });
});

describe("worker names", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rivet-names-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("drops the old name pool's table: a worker goes by its chat name", () => {
    const old = new DatabaseSync(join(dir, "rivet.sqlite"));
    old.exec("CREATE TABLE worker_names (worktree_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)");
    old.close();
    const store = new Store(dir);
    const tables = (store as unknown as { db: { prepare(sql: string): { all(): { name: string }[] } } }).db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    expect(tables).not.toContain("worker_names");
    store.putWorkers({ workers: [worker("ace")] });
    const response = deriveWorkers(store.getWorkers(), null, "rivet", Date.now());
    expect(response.workers.map((w) => w.name)).toEqual(["ace"]);
    store.close();
  });
});

describe("a chat's project", () => {
  const stored = (workers: SnapshotWorker[]) => ({ at: new Date().toISOString(), snapshot: { workers } });
  const board = (chats: unknown[]) => ({ updatedAt: new Date().toISOString(), needs: [], coming: [], chats, shipped: [] }) as unknown as Board;
  const gamma = "example-org/gamma-app";

  it("comes from that repo's chat row, and outlasts typed status on a row left alone for days", () => {
    const old = new Date(Date.now() - TYPED_FRESH_MS * 3).toISOString();
    const chats = [
      { name: "gamma-plan", state: "working", doing: "Old words", project: gamma, touchedAt: old },
      { name: "other", state: "idle", repo: "example-org/other-repo", project: gamma },
    ];
    const { workers } = deriveWorkers(stored([worker("gamma-plan"), worker("other")]) as never, board(chats), "rivet", Date.now());
    const of = (chat: string) => workers.find((w) => w.chat === chat)!;
    expect(of("gamma-plan")).toMatchObject({ repo: MS, project: gamma });
    expect(of("gamma-plan").doing).toBeUndefined();
    expect(of("other").project).toBeUndefined();
  });

  it("is refused on the board when it is not a well-formed repo", () => {
    const row = { updatedAt: new Date().toISOString(), chats: [{ name: "gamma-plan", state: "working", project: "someone/else/extra" }] };
    expect(boardSchema.safeParse(row).success).toBe(false);
    expect(boardSchema.safeParse({ ...row, chats: [{ ...row.chats[0], project: gamma }] }).success).toBe(true);
  });
});

describe("a chat's box", () => {
  const stored = (workers: SnapshotWorker[]) => ({ at: new Date().toISOString(), snapshot: { workers } });
  const board = (chats: unknown[]) => ({ updatedAt: new Date().toISOString(), needs: [], coming: [], chats, shipped: [] }) as unknown as Board;
  const gamma = "example-org/gamma-app" as const;
  const mc = "example-org/design-app" as const;
  const other = "example-org/other-repo" as const;
  const ask = (chat: string, extra: Partial<Ask>) => ({ id: `a-${chat}-${extra.createdAt ?? ""}`, chat, prs: [], stage: "building", createdAt: "2026-11-03T00:00:00.000Z", ...extra }) as Ask;
  const derive = (workers: SnapshotWorker[], chats: unknown[] = [], asks: Ask[] = []) =>
    Object.fromEntries(deriveWorkers(stored(workers) as never, board(chats), "rivet", Date.now(), asks).workers.map((w) => [w.chat, w]));

  it("is the project set on it, over its ask's PRs and the folder its work is in", () => {
    const got = derive([worker("set", { workRepo: mc })], [{ name: "set", state: "working", project: gamma }], [ask("set", { repo: other, prs: [3] })]);
    expect(got.set).toMatchObject({ project: gamma, boxFrom: "set" });
    expect(got.set?.boxGuess).toBeUndefined();
  });

  it("is next the repo of the PRs its newest ask names with a repo; an ask with no repo or no PRs links nothing", () => {
    const asks = [
      ask("linked", { repo: mc, prs: [4], createdAt: "2026-11-01T00:00:00.000Z" }),
      ask("linked", { repo: gamma, prs: [5], createdAt: "2026-11-02T00:00:00.000Z", stage: "done" }),
      ask("linked", { prs: [6], createdAt: "2026-11-03T00:00:00.000Z" }),
      ask("unlinked", { prs: [7] }),
      ask("unlinked", { repo: gamma }),
    ];
    const got = derive([worker("linked", { workRepo: other }), worker("unlinked", { workRepo: other })], [], asks);
    expect(got.linked).toMatchObject({ project: gamma, boxFrom: "pr" });
    expect(got.unlinked).toMatchObject({ project: other, boxFrom: "folder" });
  });

  it("takes no PR link or folder read for a chat name two chats share, so one's work never moves the other: a guess", () => {
    const twin = worker("lab", { workRepo: MS });
    const got = deriveWorkers(stored([twin, { ...worker("lab", { workRepo: gamma }), repo: gamma }]) as never, board([]), "rivet", Date.now(), [ask("lab", { repo: gamma, prs: [7] })]).workers;
    expect(got.map((w) => w.boxGuess)).toEqual([true, true]);
    expect(got.find((w) => w.repo === MS)?.project).toBeUndefined();
    // The bridge reads both twins' folders by the one name, so its reading places neither; nor does a disconnected twin's ask.
    const same = deriveWorkers(stored([worker("lab", { workRepo: gamma }), { ...worker("lab", { workRepo: gamma }), repo: gamma }]) as never, board([]), "rivet", Date.now()).workers;
    expect(same.find((w) => w.repo === MS)).toMatchObject({ boxGuess: true });
    const gone = deriveWorkers(stored([worker("lab", { workRepo: MS }), { ...worker("lab"), repo: gamma, connected: false }]) as never, board([]), "rivet", Date.now(), [ask("lab", { repo: gamma, prs: [7] })]).workers;
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatchObject({ boxFrom: "folder" });
    expect(gone[0]?.project).toBeUndefined();
  });

  it("is the worktree's repo, said, when the folder read is that repo, and a guess when nothing said", () => {
    const got = derive([worker("own", { workRepo: MS }), worker("none"), worker("rivet")]);
    expect(got.own).toMatchObject({ boxFrom: "folder" });
    expect(got.own?.project).toBeUndefined();
    expect(got.none).toMatchObject({ boxGuess: true });
    expect(got.none?.boxFrom).toBeUndefined();
    expect(got.rivet?.boxGuess).toBeUndefined();
  });
});
