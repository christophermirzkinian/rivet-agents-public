import { afterEach, describe, expect, it } from "vitest";

import { boardSchema, MAX_SHIPPED, NO_REPO, type Board } from "../src/shared/board.js";
import { markMerged, settleComing, stampBoard, type MergedPr } from "../src/server/stamps.js";
import { bearer, BOARD_TOKEN, browser, EXAMPLE_BOARD, fakeClock, putBoard, startServer, type TestServer } from "./helpers.js";

const T0 = "2026-10-03T08:00:00.000Z";
const T1 = "2026-10-03T09:00:00.000Z";

const board = (over: Partial<Board> = {}): Board => boardSchema.parse({ ...structuredClone(EXAMPLE_BOARD), ...over });

describe("stampBoard", () => {
  it("stamps every row of a first board, and a new shipped row once", () => {
    const first = stampBoard(null, board(), T0);
    expect(first.chats[0]).toMatchObject({ name: "rivet-app", touchedAt: T0 });
    expect(first.coming[0]).toMatchObject({ pr: 2100, touchedAt: T0 });
    expect(first.shipped[0]).toMatchObject({ pr: 105, shippedAt: T0, touchedAt: T0 });
  });

  it("keeps stamps across a push that re-sends the same rows without them, and replaces sent values", () => {
    const first = stampBoard(null, board(), T0);
    const sent = board({ shipped: [{ pr: 105, title: "Touch action guard", deployed: "partial", deployedNote: "deploying", shippedAt: "2020-01-01T00:00:00Z" }] });
    const again = stampBoard(first, sent, T1);
    expect(again.chats[0]!.touchedAt).toBe(T0);
    expect(again.coming[0]!.touchedAt).toBe(T0);
    expect(again.shipped[0]).toMatchObject({ shippedAt: T0, touchedAt: T0 });
  });

  it("a changed row, or the row a per-item write names, is touched; shippedAt never moves", () => {
    const first = stampBoard(null, board(), T0);
    const changed = stampBoard(first, board({ shipped: [{ pr: 105, title: "Touch action guard", deployed: true }] }), T1);
    expect(changed.shipped[0]).toMatchObject({ shippedAt: T0, touchedAt: T1 });
    const named = stampBoard(first, board(), T1, { section: "coming", index: 0 });
    expect(named.coming[0]!.touchedAt).toBe(T1);
    expect(named.chats[0]!.touchedAt).toBe(T0);
  });

  it("key order does not count as a change", () => {
    const first = stampBoard(null, board({ coming: [{ title: "Docs refresh", stage: "building" }] }), T0);
    const reordered = stampBoard(first, board({ coming: [{ stage: "building", title: "Docs refresh" } as never] }), T1);
    expect(reordered.coming[0]!.touchedAt).toBe(T0);
  });

  it("a title names the row only when neither side has a PR", () => {
    const first = stampBoard(null, board({ shipped: [{ pr: 105, title: "Touch action guard" }, { title: "Enquiry form" }] }), T0);
    const next = stampBoard(first, board({ shipped: [{ pr: 9999, title: "Touch action guard" }, { pr: 2106, title: "Enquiry form" }] }), T1);
    expect(next.shipped.map((row) => row.shippedAt)).toEqual([T1, T1]);
    const titled = stampBoard(first, board({ shipped: [{ pr: 105, title: "Renamed" }, { title: "Enquiry form" }] }), T1);
    expect(titled.shipped.map((row) => row.shippedAt)).toEqual([T0, T0]);
  });

  it("a row stored before the stamps starts at its updatedAt; a shipped one takes its stored at, else null for a day not known", () => {
    const old = board({
      coming: [{ pr: 2100, title: "Docs refresh", updatedAt: "2026-09-30T01:00:00Z" }],
      chats: [{ name: "rivet-app", state: "working" }],
    });
    const next = stampBoard(old, old, T1);
    expect(next.coming[0]!.touchedAt).toBe("2026-09-30T01:00:00Z");
    expect(next.chats[0]!.touchedAt).toBe(T1);
    expect(next.shipped[0]).toHaveProperty("shippedAt", null);
    expect(stampBoard(next, old, "2026-10-04T00:00:00.000Z").shipped[0]!.shippedAt).toBeNull();
    const timed = board({ shipped: [{ title: "Enquiry form", at: "2026-09-30T12:41:23Z" } as never, { title: "Later", at: "2027-01-01T00:00:00Z" } as never] });
    expect(stampBoard(timed, timed, T1).shipped.map((row) => row.shippedAt)).toEqual(["2026-09-30T12:41:23Z", null]);
    expect(stampBoard(timed, board({ shipped: [{ title: "New today" }] }), T1).shipped[0]!.shippedAt).toBe(T1);
    expect(stampBoard(next, old, "2026-10-04T00:00:00.000Z").coming[0]!.touchedAt).toBe("2026-09-30T01:00:00Z");
  });

  it("an at a writer sends is never taken as shippedAt, however often it is sent", () => {
    const legacy = board({ shipped: [{ pr: 105, title: "Touch action guard" }] });
    const sent = board({ shipped: [{ pr: 105, title: "Touch action guard", at: "2026-10-02T00:00:00Z" } as never] });
    const once = stampBoard(legacy, sent, T0);
    const twice = stampBoard(once, sent, T1);
    expect([once.shipped[0]!.shippedAt, twice.shipped[0]!.shippedAt]).toEqual([null, null]);
    const sentNull = board({ shipped: [{ pr: 105, title: "Touch action guard", shippedAt: null }] });
    expect(stampBoard(twice, sentNull, T1).shipped[0]!.shippedAt).toBeNull();
    expect(stampBoard(null, sentNull, T1).shipped[0]!.shippedAt).toBe(T1);
  });

  it("mergedAt is the server's: a sent one is dropped, a stored one kept across pushes", () => {
    const sent = board({ coming: [{ pr: 2100, title: "Docs refresh", mergedAt: "2026-10-01T00:00:00Z" }] });
    expect(stampBoard(null, sent, T0).coming[0]!.mergedAt).toBeUndefined();
    const stored = board({ coming: [{ pr: 2100, title: "Docs refresh", mergedAt: "2026-10-02T00:00:00Z", touchedAt: T0 }] });
    const pushed = stampBoard(stored, board({ coming: [{ pr: 2100, title: "Docs refresh" }] }), T1);
    expect(pushed.coming[0]).toMatchObject({ mergedAt: "2026-10-02T00:00:00Z", touchedAt: T0 });
    expect(stampBoard(stored, sent, T1).coming[0]!.mergedAt).toBe("2026-10-02T00:00:00Z");
  });

  it("chats are known by name and repo", () => {
    const first = stampBoard(null, board({ chats: [{ name: "fix", state: "working" }] }), T0);
    const other = stampBoard(first, board({ chats: [{ name: "fix", state: "working" }, { name: "fix", state: "working", repo: "example-org/other-repo" }] }), T1);
    expect(other.chats.map((chat) => chat.touchedAt)).toEqual([T0, T1]);
  });
});

describe("settleComing", () => {
  const OTHER = "example-org/other-repo";
  const mergedPr = (number: number, mergedAt = T0): MergedPr => ({ repo: NO_REPO, number, title: "x", url: "https://github.com/x", mergedAt });
  const closedPr = (number: number) => ({ repo: NO_REPO, number, closedAt: T0 });

  it("keeps the newest shipped rows when a merge would take Shipped over its cap", () => {
    const full = Array.from({ length: MAX_SHIPPED }, (_, i) => ({ pr: 1000 + i, title: `Old ${i}` }));
    const settled = settleComing(board({ coming: [{ pr: 41, title: "New" }], shipped: full }), { merged: [mergedPr(41)], closed: [], now: T1 })!;
    expect(settled.board.shipped).toHaveLength(MAX_SHIPPED);
    expect(settled.board.shipped[0]).toMatchObject({ pr: 41, shippedAt: T0 });
    expect(boardSchema.safeParse(settled.board).success).toBe(true);
  });

  it("over the cap leaves out the oldest by day, not the last in the list", () => {
    const dated = Array.from({ length: MAX_SHIPPED - 1 }, (_, i) => ({ pr: 1000 + i, title: `Today ${i}`, shippedAt: T1 }));
    const old = [...dated.slice(0, 5), { pr: 999, title: "Undated" }, ...dated.slice(5)];
    const settled = settleComing(board({ coming: [{ pr: 41, title: "Late" }], shipped: old }), { merged: [mergedPr(41, "2026-09-23T00:00:00.000Z")], closed: [], now: T1 })!;
    expect(settled.board.shipped).toHaveLength(MAX_SHIPPED);
    expect(settled.board.shipped.map((row) => row.pr)).toEqual([41, ...dated.map((row) => row.pr)]);
  });

  it("drops a Coming row whose PR already has its repo's Shipped row, after the merge left GitHub's list", () => {
    const b = board({ coming: [{ pr: 41, title: "Back again" }, { pr: 42, title: "Other repo's 42" }], shipped: [{ pr: 41, title: "Done" }, { pr: 42, repo: OTHER, title: "Other" }] });
    expect(settleComing(b, { merged: [], closed: [], now: T1 })!.board.coming.map((item) => item.pr)).toEqual([42]);
  });

  it("keeps a reopened PR whose old closure is still in the closed list", () => {
    const b = board({ coming: [{ pr: 41, title: "Reopened" }] });
    expect(settleComing(b, { merged: [], closed: [closedPr(41)], open: [{ repo: NO_REPO, number: 41 }], now: T1 })).toBeNull();
    expect(settleComing(b, { merged: [], closed: [closedPr(41)], now: T1 })!.board.coming).toEqual([]);
    // A failed open-PR reading cannot say the PR was not reopened, so no closure counts.
    expect(settleComing(b, { merged: [], closed: [closedPr(41)], open: null, now: T1 })).toBeNull();
  });

  it("returns the index the kept row ends at", () => {
    const b = board({ coming: [{ pr: 41, title: "Merged" }, { pr: 43, title: "Kept" }, { pr: 44, title: "After" }] });
    const settled = settleComing(b, { merged: [mergedPr(41)], closed: [], now: T1, keep: 1 })!;
    expect(settled.keep).toBe(0);
    expect(settled.board.coming[settled.keep!]).toMatchObject({ pr: 43 });
  });

  it("stamps two repos' shipped rows of one PR number apart", () => {
    const first = stampBoard(null, board({ shipped: [{ pr: 41, title: "Home" }] }), T0);
    const again = stampBoard(first, board({ shipped: [{ pr: 41, repo: OTHER, title: "Other" }, { pr: 41, title: "Home" }] }), T1);
    expect(again.shipped.map((row) => row.shippedAt)).toEqual([T1, T0]);
  });

  it("stamps two repos' PR-less rows of one title apart, and keeps one repo's row across a push", () => {
    const chats = [{ name: "site", state: "working", repo: OTHER }];
    const first = stampBoard(null, board({ chats, coming: [{ title: "Lobby art", stage: "building" }], shipped: [{ title: "Enquiry form" }] }), T0);
    const both = stampBoard(
      first,
      board({ chats, coming: [{ title: "Lobby art", stage: "building", chat: "site" }, { title: "Lobby art", stage: "building" }], shipped: [{ title: "Enquiry form", repo: OTHER }, { title: "Enquiry form" }] }),
      T1,
    );
    expect(both.coming.map((row) => row.touchedAt)).toEqual([T1, T0]);
    expect(both.shipped.map((row) => row.shippedAt)).toEqual([T1, T0]);
    const again = stampBoard(both, board({ chats, coming: [{ title: "Lobby art", stage: "building", chat: "site" }] }), "2026-10-03T10:00:00.000Z");
    expect(again.coming[0]!.touchedAt).toBe(T1);
  });
});

describe("markMerged", () => {
  const merged = (repo: string, number: number): MergedPr => ({ repo, number, title: "x", url: "https://github.com/x", mergedAt: "2026-10-02T00:00:00Z" });
  const OTHER = "example-org/other-repo";

  it("marks a row merged in its chat's repo only", () => {
    const b = board({
      chats: [{ name: "site", state: "working", repo: OTHER }],
      coming: [
        { pr: 41, title: "Other form", chat: "site" },
        { pr: 41, title: "Home forty-one" },
        { pr: 42, title: "Home forty-two", chat: "nobody" },
      ],
    });
    expect(markMerged(b, [merged(NO_REPO, 41)])!.coming.map((item) => item.mergedAt)).toEqual([undefined, "2026-10-02T00:00:00Z", undefined]);
    expect(markMerged(b, [merged(OTHER, 41), merged(NO_REPO, 42)])!.coming.map((item) => item.mergedAt)).toEqual(["2026-10-02T00:00:00Z", undefined, "2026-10-02T00:00:00Z"]);
  });

  it("leaves a row two repos claim, one live, or one already marked; null when nothing changes", () => {
    const b = board({
      chats: [{ name: "fix", state: "x" }, { name: "fix", state: "x", repo: OTHER }],
      coming: [{ pr: 41, title: "Ambiguous", chat: "fix" }, { pr: 43, title: "Live", stage: "shipped" }, { pr: 44, title: "Done", mergedAt: "2026-09-01T00:00:00Z" }],
    });
    expect(markMerged(b, [merged(NO_REPO, 41), merged(OTHER, 41), merged(NO_REPO, 43), merged(NO_REPO, 44)])).toBeNull();
  });

  it("a stored null mergedAt from before the field is accepted and counts as not merged", () => {
    const b = board({ coming: [{ pr: 45, title: "Old row", mergedAt: null }] });
    expect(markMerged(b, [merged(NO_REPO, 45)])!.coming[0]!.mergedAt).toBe("2026-10-02T00:00:00Z");
  });

  it("the same PR number in two repos stays two rows: a whole-board push never copies one's merge to the other", () => {
    const chats = [{ name: "site", state: "working", repo: OTHER }, { name: "fix", state: "working" }];
    const coming = [{ pr: 41, title: "Other form", chat: "site" }, { pr: 41, title: "Home forty-one", chat: "fix" }];
    const marked = markMerged(stampBoard(null, board({ chats, coming }), "2026-10-03T00:00:00.000Z"), [merged(OTHER, 41)])!;
    expect(marked.coming.map((item) => item.mergedAt)).toEqual(["2026-10-02T00:00:00Z", undefined]);
    const pushed = stampBoard(marked, board({ chats, coming }), "2026-10-03T01:00:00.000Z");
    expect(pushed.coming.map((item) => item.mergedAt)).toEqual(["2026-10-02T00:00:00Z", undefined]);
  });

  it("a row whose chat changes within one repo keeps its merge; a chat moved to another repo does not carry it", () => {
    const home = [{ name: "fix", state: "working" }];
    const done = stampBoard(null, board({ chats: home, coming: [{ pr: 41, title: "Done", chat: "fix" }] }), "2026-10-03T00:00:00.000Z");
    const marked = markMerged(done, [merged(NO_REPO, 41)])!;
    const unchatted = stampBoard(marked, board({ chats: home, coming: [{ pr: 41, title: "Done" }] }), "2026-10-04T00:00:00.000Z");
    expect(unchatted.coming[0]!.mergedAt).toBe("2026-10-02T00:00:00Z");

    const other = markMerged(stampBoard(null, board({ chats: [{ name: "fix", state: "x", repo: OTHER }], coming: [{ pr: 41, title: "Other", chat: "fix" }] }), "2026-10-03T00:00:00.000Z"), [merged(OTHER, 41)])!;
    const moved = stampBoard(other, board({ chats: home, coming: [{ pr: 41, title: "Home forty-one", chat: "fix" }] }), "2026-10-04T00:00:00.000Z");
    expect(moved.coming[0]!.mergedAt).toBeUndefined();
  });

  it("a namesake chat in another repo, added and removed, never wipes a stored merge", () => {
    const home = [{ name: "fix", state: "idle" }];
    const coming = [{ pr: 41, title: "Done", chat: "fix" }];
    const marked = markMerged(stampBoard(null, board({ chats: home, coming }), "2026-10-03T00:00:00.000Z"), [merged(NO_REPO, 41)])!;
    const both = stampBoard(marked, board({ chats: [...home, { name: "fix", state: "idle", repo: OTHER }], coming }), "2026-10-04T00:00:00.000Z");
    expect(both.coming[0]!.mergedAt).toBe("2026-10-02T00:00:00Z");
    const back = stampBoard(both, board({ chats: home, coming }), "2026-10-05T00:00:00.000Z");
    expect(back.coming[0]!.mergedAt).toBe("2026-10-02T00:00:00Z");
    const other = stampBoard(both, board({ chats: [{ name: "fix", state: "idle", repo: OTHER }], coming }), "2026-10-05T00:00:00.000Z");
    expect(other.coming[0]!.mergedAt).toBeUndefined();
    const others = [OTHER, "example-org/side-app"].map((repo) => ({ name: "fix", state: "idle", repo, prs: [41] }));
    const elsewhere = stampBoard(marked, board({ chats: others, coming }), "2026-10-05T00:00:00.000Z");
    expect(elsewhere.coming[0]!.mergedAt).toBeUndefined();
  });

  it("one stored merge on a chat two repos claim goes to the row of its title only, so settling keeps the other repo's PR", () => {
    const THIRD = "example-org/third-repo";
    const home = [{ name: "lab", state: "idle", prs: [7] }];
    const marked = markMerged(stampBoard(null, board({ chats: home, coming: [{ pr: 7, title: "Software seven", chat: "lab" }] }), "2026-10-03T00:00:00.000Z"), [merged(NO_REPO, 7)])!;
    const chats = [...home, { name: "lab", state: "working", repo: THIRD, prs: [7] }];
    for (const coming of [
      [{ pr: 7, title: "Software seven", chat: "lab" }, { pr: 7, title: "Third seven", chat: "lab" }],
      [{ pr: 7, title: "Third seven", chat: "lab" }, { pr: 7, title: "Software seven", chat: "lab" }],
    ]) {
      const pushed = stampBoard(marked, board({ chats, coming }), "2026-10-04T00:00:00.000Z");
      expect(pushed.coming.map((item) => [item.title, item.mergedAt])).toEqual(coming.map(({ title }) => [title, title === "Software seven" ? "2026-10-02T00:00:00Z" : undefined]));
      const settled = settleComing(pushed, { merged: [], closed: [], now: "2026-10-04T00:00:00.000Z" })!;
      expect(settled.board.coming.map((item) => item.title)).toEqual(["Third seven"]);
    }
    // Neither row has its title: which one it was is not known, so neither takes the merge and settling drops neither.
    for (const coming of [
      [{ pr: 7, title: "Seven, renamed", chat: "lab" }, { pr: 7, title: "Third seven", chat: "lab" }],
      [{ pr: 7, title: "Third seven", chat: "lab" }, { pr: 7, title: "Seven, renamed", chat: "lab" }],
    ]) {
      const renamed = stampBoard(marked, board({ chats, coming }), "2026-10-04T00:00:00.000Z");
      expect(renamed.coming.map((item) => item.mergedAt)).toEqual([undefined, undefined]);
      expect(settleComing(renamed, { merged: [], closed: [], now: "2026-10-04T00:00:00.000Z" })).toBeNull();
    }
    // A row whose repo is known to be the stored row's takes it before a row of its title on the claimed chat.
    const moved = [...chats, { name: "soft", state: "working", prs: [7] }];
    for (const title of ["Software seven", "Third seven"]) {
      const coming = [{ pr: 7, title, chat: "lab" }, { pr: 7, title: "Seven, renamed", chat: "soft" }];
      const known = stampBoard(marked, board({ chats: moved, coming }), "2026-10-04T00:00:00.000Z");
      expect(known.coming.map((item) => item.mergedAt)).toEqual([undefined, "2026-10-02T00:00:00Z"]);
      expect(settleComing(known, { merged: [], closed: [], now: "2026-10-04T00:00:00.000Z" })!.board.coming.map((item) => item.title)).toEqual([title]);
    }
    // Two rows of its title: the unchanged one takes it; two changed ones leave it to neither.
    const titled = [{ pr: 7, title: "Software seven", chat: "lab", app: "Third" }, { pr: 7, title: "Software seven", chat: "lab" }];
    expect(stampBoard(marked, board({ chats, coming: titled }), "2026-10-04T00:00:00.000Z").coming.map((item) => item.mergedAt)).toEqual([undefined, "2026-10-02T00:00:00Z"]);
    const changed = [titled[0]!, { ...titled[1]!, app: "Software" }];
    expect(stampBoard(marked, board({ chats, coming: changed }), "2026-10-04T00:00:00.000Z").coming.map((item) => item.mergedAt)).toEqual([undefined, undefined]);
    // Two rows of the PR whose repo is known are both its PR: both keep the merge and settle.
    const twice = [{ pr: 7, title: "Software seven", chat: "lab", app: "A" }, { pr: 7, title: "Software seven", chat: "lab", app: "B" }];
    const both = stampBoard(marked, board({ chats: home, coming: twice }), "2026-10-04T00:00:00.000Z");
    expect(both.coming.map((item) => item.mergedAt)).toEqual(["2026-10-02T00:00:00Z", "2026-10-02T00:00:00Z"]);
    expect(settleComing(both, { merged: [], closed: [], now: "2026-10-04T00:00:00.000Z" })!.board.coming).toEqual([]);
    // Renamed alone on the chat, it is still the stored row.
    const alone = stampBoard(marked, board({ chats, coming: [{ pr: 7, title: "Seven, renamed", chat: "lab" }] }), "2026-10-04T00:00:00.000Z");
    expect(alone.coming[0]!.mergedAt).toBe("2026-10-02T00:00:00Z");
  });

  it("a stored merge whose repo is unknown never crosses to a repo by the chat's name", () => {
    const coming = [{ pr: 41, title: "Done", chat: "fix", mergedAt: "2026-09-01T00:00:00Z" }];
    const stored = { ...board({ chats: [{ name: "fix", state: "idle" }, { name: "fix", state: "idle", repo: OTHER }] }), coming } as Board;
    const next = stampBoard(stored, board({ chats: [{ name: "fix", state: "idle", repo: OTHER }], coming }), "2026-10-05T00:00:00.000Z");
    expect(next.coming[0]!.mergedAt).toBeUndefined();
    const home = { ...board({ chats: [{ name: "fix", state: "idle" }] }), coming } as Board;
    const others = [OTHER, "example-org/side-app"].map((repo) => ({ name: "fix", state: "idle", repo, prs: [41] }));
    const away = stampBoard(home, board({ chats: others, coming }), "2026-10-05T00:00:00.000Z");
    expect(away.coming[0]!.mergedAt).toBeUndefined();
  });
});

describe("board writes stamp rows", () => {
  let server: TestServer;
  afterEach(async () => server?.close());

  it("whole-board pushes, rivet chat set and coming set keep working, with the server's stamps", async () => {
    const clock = fakeClock(Date.parse(T0));
    server = await startServer({}, { now: clock.now });
    expect((await putBoard(server.base)).status).toBe(200);
    clock.advance(3600_000);
    expect((await putBoard(server.base)).status).toBe(200);
    const patch = (path: string, body: unknown) =>
      fetch(`${server.base}${path}`, { method: "PATCH", headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) });
    const chat = await patch("/api/board/chats/rivet-app", { state: "review" });
    expect(chat.status).toBe(200);
    expect(((await chat.json()) as { item: unknown }).item).toMatchObject({ name: "rivet-app", state: "review", touchedAt: T1 });
    expect((await patch("/api/board/coming/2200", { title: "Data Import", stage: "building" })).status).toBe(200);
    const read = (await (await fetch(`${server.base}/api/board`, { headers: browser(server.cookie()) })).json()) as { board: Board };
    expect(read.board.coming.map((item) => [item.pr, item.touchedAt])).toEqual([
      [2100, T0],
      [2200, T1],
    ]);
    expect(read.board.shipped[0]).toMatchObject({ pr: 105, shippedAt: T0, touchedAt: T0 });
  });
});
