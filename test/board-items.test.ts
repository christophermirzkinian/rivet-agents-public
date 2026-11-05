import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PushSender } from "../src/server/push.js";
import type { PushSubscriptionRow } from "../src/server/store.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, browser, EXAMPLE_BOARD, putBoard, startServer, type TestServer } from "./helpers.js";

// Filler the server's redactor leaves as it is: one long run of a letter reads to it as a token, and a line
// past 4096 characters is withheld. `n` bytes as JSON writes it: lines of words, each line break two bytes there.
const LINE = `${"word ".repeat(799)}word\n`;
const filler = (n: number) => LINE.repeat(Math.floor(n / (LINE.length + 1))) + "word ".repeat(n).slice(0, n % (LINE.length + 1));

class FakeSender implements PushSender {
  readonly tags: string[] = [];
  async send(_target: PushSubscriptionRow, payload: string): Promise<number> {
    this.tags.push((JSON.parse(payload) as { tag: string }).tag);
    return 201;
  }
}

const VAPID = {
  RIVET_VAPID_PUBLIC_KEY: "BPublicKeyForTests",
  RIVET_VAPID_PRIVATE_KEY: "private-key-for-tests",
  RIVET_VAPID_SUBJECT: "mailto:ops@example.com",
};
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(120, 7)]);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

let server: TestServer;
let sender: FakeSender;
let cookie: string;

beforeEach(async () => {
  sender = new FakeSender();
  server = await startServer(VAPID, { pushSender: sender });
  cookie = server.cookie();
});

afterEach(async () => {
  await server.close();
});

function send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${server.base}${path}`, {
    method,
    headers: { ...bearer(BOARD_TOKEN), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function board(): Promise<{ version: number; board: typeof EXAMPLE_BOARD & Record<string, unknown> }> {
  const response = await fetch(`${server.base}/api/board`, { headers: bearer(BOARD_TOKEN) });
  expect(response.status).toBe(200);
  return (await response.json()) as { version: number; board: typeof EXAMPLE_BOARD & Record<string, unknown> };
}

/** Rows without the server's stamps (stamps.test.ts covers those). */
function bare<T>(rows: T[]): T[] {
  return rows.map((row) => {
    const { touchedAt: _touched, shippedAt: _shipped, ...rest } = row as Record<string, unknown>;
    return rest as T;
  });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

describe("GET /api/board", () => {
  it("takes the board token or a session, with the version as its ETag", async () => {
    expect((await fetch(`${server.base}/api/board`)).status).toBe(401);
    expect((await fetch(`${server.base}/api/board`, { headers: bearer(BRIDGE_TOKEN) })).status).toBe(401);
    const empty = await fetch(`${server.base}/api/board`, { headers: bearer(BOARD_TOKEN) });
    expect(empty.headers.get("etag")).toBe('"0"');
    expect(await empty.json()).toEqual({ version: 0, updatedAt: null, board: null, minimised: [] });

    await putBoard(server.base);
    const read = await fetch(`${server.base}/api/board`, { headers: bearer(BOARD_TOKEN) });
    expect(read.headers.get("etag")).toBe('"1"');
    const body = (await read.json()) as { board: { needs: { rev: string }[] } };
    expect(body.board.needs[0]!.rev).toMatch(/^[0-9a-f]{16}$/);
    expect((await fetch(`${server.base}/api/board`, { headers: { cookie } })).status).toBe(200);
  });
});

describe("board needs", () => {
  it.each(["repair", "drop"])("keeps unrelated writes and individual %s possible beside two ambiguous legacy cards", async (action) => {
    const legacy = structuredClone(EXAMPLE_BOARD);
    const options = [{ label: "Proceed", detail: "Production" }, { label: "Proceed", detail: "Staging only" }];
    const ambiguous = ["legacy-a", "legacy-b"].map((id) => ({ id, kind: "decision", title: "Where?", options }));
    server.app.store.putBoard({ ...legacy, needs: ambiguous } as never, null);
    expect((await send("PUT", "/api/board/needs/unrelated", { kind: "question", title: "Which colour?" })).status).toBe(200);
    expect((await send("PATCH", "/api/board/chats/new-chat", { state: "working", doing: "Unrelated work" })).status).toBe(200);
    expect((await send("PATCH", "/api/board/coming/2200", { title: "Unrelated product" })).status).toBe(200);
    for (const id of ["legacy-a", "legacy-b"]) {
      const result = action === "repair"
        ? await send("PATCH", `/api/board/needs/${id}`, { options: [{ label: "Proceed", detail: "Staging only" }] })
        : await send("DELETE", `/api/board/needs/${id}`);
      expect(result.status).toBe(200);
    }
    const stored = (await board()).board;
    expect(stored.needs.find((need) => need.id === "unrelated")?.title).toBe("Which colour?");
    expect(stored.chats.find((chat) => chat.name === "new-chat")?.doing).toBe("Unrelated work");
    expect(stored.coming.find((item) => item.pr === 2200)?.title).toBe("Unrelated product");
    for (const id of ["legacy-a", "legacy-b"]) {
      const need = stored.needs.find((item) => item.id === id);
      if (action === "repair") expect(need?.options).toEqual([{ label: "Proceed", detail: "Staging only" }]);
      else expect(need).toBeUndefined();
    }
  });

  it("creates on an empty board, replaces, and create=only refuses an existing card", async () => {
    const card = { kind: "decision", title: "Pick a camera", options: [{ label: "Chase" }] };
    const created = await send("PUT", "/api/board/needs/cam-pick?create=only", card);
    expect(created.status).toBe(200);
    expect(created.headers.get("etag")).toBe('"1"');
    const body = (await created.json()) as { version: number; updatedAt: string; item: { id: string; rev: string } };
    expect(body).toMatchObject({ version: 1, item: { id: "cam-pick", title: "Pick a camera" } });
    expect(body.item.rev).toMatch(/^[0-9a-f]{16}$/);
    const stored = await board();
    expect(stored.board.needs.map((need) => need.id)).toEqual(["cam-pick"]);
    expect(stored.board.coming).toEqual([]);

    const again = await send("PUT", "/api/board/needs/cam-pick?create=only", card);
    expect(again.status).toBe(409);

    const replaced = await send("PUT", "/api/board/needs/cam-pick", { id: "cam-pick", kind: "question", title: "Which camera?" });
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({ version: 2, item: { kind: "question", title: "Which camera?" } });
    expect((await board()).board.needs[0]).not.toHaveProperty("options");
  });

  it("keeps a replaced card in place and refuses a body id that is not the URL's", async () => {
    await putBoard(server.base);
    expect((await send("PUT", "/api/board/needs/pr2022-checkout", { id: "other", kind: "x", title: "y" })).status).toBe(400);
    expect((await send("PUT", "/api/board/needs/pr2022-checkout", { kind: "approval", title: "Daily build v2" })).status).toBe(200);
    expect((await board()).board.needs.map((need) => need.title)).toEqual(["Daily build v2", "Billing retry queue"]);
  });

  it("patches by merging, null removes a field, and the id cannot change", async () => {
    await putBoard(server.base);
    const patched = await send("PATCH", "/api/board/needs/pr2022-checkout", { title: "Daily build: patched", ask: null, risk: "money" });
    expect(patched.status).toBe(200);
    const { item } = (await patched.json()) as { item: Record<string, unknown> };
    expect(item).toMatchObject({ id: "pr2022-checkout", title: "Daily build: patched", risk: "money", pr: 2022 });
    expect(item).not.toHaveProperty("ask");
    const need = (await board()).board.needs[0]!;
    expect(need).not.toHaveProperty("ask");
    expect(need.options).toHaveLength(2);

    expect((await send("PATCH", "/api/board/needs/pr2022-checkout", { id: "renamed" })).status).toBe(400);
    expect((await send("PATCH", "/api/board/needs/pr2022-checkout", { id: null })).status).toBe(400);
    expect((await send("PATCH", "/api/board/needs/pr2022-checkout", { title: null })).status).toBe(400);
    expect((await send("PATCH", "/api/board/needs/pr2022-checkout", [])).status).toBe(400);
  });

  it("404s a patch or delete of a missing card and a bad id", async () => {
    await putBoard(server.base);
    expect((await send("PATCH", "/api/board/needs/nope", { title: "x" })).status).toBe(404);
    expect((await send("DELETE", "/api/board/needs/nope")).status).toBe(404);
    expect((await send("DELETE", "/api/board/needs/..")).status).toBe(404);
    expect((await send("DELETE", "/api/board/needs/a%20b")).status).toBe(404);
    expect((await send("DELETE", "/api/board/needs/%E0%A4%A")).status).toBe(404);
    expect((await board()).version).toBe(1);
  });

  it("deletes a card", async () => {
    await putBoard(server.base);
    const dropped = await send("DELETE", "/api/board/needs/billing-retry");
    expect(dropped.status).toBe(200);
    expect(await dropped.json()).toMatchObject({ version: 2 });
    expect((await board()).board.needs.map((need) => need.id)).toEqual(["pr2022-checkout"]);
  });

  it("honours If-Match: stale is 409 with the version, fresh writes", async () => {
    await putBoard(server.base);
    const stale = await send("PATCH", "/api/board/needs/billing-retry", { title: "x" }, { "if-match": "0" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "board version is stale", version: 1 });
    const fresh = await send("PATCH", "/api/board/needs/billing-retry", { title: "x" }, { "if-match": '"1"' });
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toMatchObject({ version: 2 });
    expect((await send("DELETE", "/api/board/needs/billing-retry", undefined, { "if-match": "1" })).status).toBe(409);
    expect((await send("DELETE", "/api/board/needs/billing-retry", undefined, { "if-match": "nope" })).status).toBe(400);
  });

  it("needs the board token", async () => {
    const card = { kind: "decision", title: "x" };
    expect((await fetch(`${server.base}/api/board/needs/a`, { method: "PUT", body: JSON.stringify(card) })).status).toBe(401);
    expect((await send("PUT", "/api/board/needs/a", card, { authorization: `Bearer ${BRIDGE_TOKEN}` })).status).toBe(401);
    expect((await fetch(`${server.base}/api/board/needs/a`, { method: "PUT", headers: browser(cookie), body: JSON.stringify(card) })).status).toBe(401);
  });

  it("pushes a new card and not a patched one", async () => {
    await fetch(`${server.base}/api/push/subscribe`, {
      method: "POST",
      headers: browser(cookie),
      body: JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/device-1", keys: { p256dh: "BKey1", auth: "auth1" } }),
    });
    expect((await send("PUT", "/api/board/needs/fresh-card", { kind: "decision", title: "Fresh" })).status).toBe(200);
    await settle();
    expect(sender.tags).toEqual(["need-fresh-card"]);
    expect((await send("PATCH", "/api/board/needs/fresh-card", { title: "Fresh, edited" })).status).toBe(200);
    expect((await send("PUT", "/api/board/needs/fresh-card", { kind: "decision", title: "Fresh, replaced" })).status).toBe(200);
    await settle();
    expect(sender.tags).toEqual(["need-fresh-card"]);
  });

  it("refuses media that is not on the server with 422", async () => {
    const media = { kind: "video", after: { sha256: sha(MP4), type: "video/mp4" } };
    const refused = await send("PUT", "/api/board/needs/clip", { kind: "approval", title: "Clip", media });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toContain(sha(MP4).slice(0, 12));
    const upload = await fetch(`${server.base}/api/bridge/media/${sha(MP4)}`, {
      method: "PUT",
      headers: { ...bearer(BOARD_TOKEN), "content-type": "video/mp4" },
      body: new Uint8Array(MP4),
    });
    expect(upload.status).toBe(201);
    expect((await send("PUT", "/api/board/needs/clip", { kind: "approval", title: "Clip", media })).status).toBe(200);
  });

  it("validates the card against the board schema", async () => {
    const bad = await send("PUT", "/api/board/needs/bad", { kind: "decision", title: "x", links: [{ label: "l", url: "javascript:1" }] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid board" });
  });
});

describe("board chats, coming and sections", () => {
  it("a whole-board write neither drops nor restores a chat's project", async () => {
    const gamma = "example-org/gamma-app";
    await putBoard(server.base);
    await send("PATCH", "/api/board/chats/gamma-plan", { state: "working", project: gamma });
    const row = async () => (await board()).board.chats.find((chat) => chat.name === "gamma-plan") as { project?: string } | undefined;
    const push = async (project?: string) => {
      const { version, board: now } = await board();
      const chats = (now.chats as { name: string; project?: string }[]).map(({ project: _kept, ...chat }) => (chat.name === "gamma-plan" && project ? { ...chat, project } : chat));
      expect((await send("PUT", "/api/board", { ...now, chats }, { "If-Match": String(version) })).status).toBe(200);
    };
    await push();
    expect((await row())?.project).toBe(gamma);
    await send("PATCH", "/api/board/chats/gamma-plan", { project: null });
    expect((await row())?.project).toBeUndefined();
    await push(gamma);
    expect((await row())?.project).toBeUndefined();
  });

  it("upserts and deletes a chat row by name", async () => {
    await putBoard(server.base);
    const added = await send("PATCH", "/api/board/chats/duel-trio", { state: "working", doing: "Tickets" });
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ item: { name: "duel-trio", state: "working", doing: "Tickets" } });
    const merged = await send("PATCH", "/api/board/chats/rivet-app", { doing: null, progress: 0.5 });
    expect(bare([((await merged.json()) as { item: Record<string, unknown> }).item])[0]).toEqual({
      name: "rivet-app",
      state: "working",
      prs: [],
      moved: "2026-09-28T03:55:18.875Z",
      progress: 0.5,
    });
    expect((await send("PATCH", "/api/board/chats/new-chat", { doing: "no state" })).status).toBe(400);
    expect((await send("PATCH", "/api/board/chats/rivet-app", { name: "other" })).status).toBe(400);
    expect((await send("DELETE", "/api/board/chats/rivet-app")).status).toBe(200);
    expect((await send("DELETE", "/api/board/chats/rivet-app")).status).toBe(404);
    expect((await board()).board.chats.map((chat) => chat.name)).toEqual(["duel-trio"]);
  });

  it("upserts and deletes coming rows by PR number or title", async () => {
    await putBoard(server.base);
    const byPr = await send("PATCH", "/api/board/coming/2100", { stage: "review", etaMinutes: 20 });
    expect(await byPr.json()).toMatchObject({ item: { pr: 2100, title: "Docs refresh", stage: "review", etaMinutes: 20 } });
    expect((await send("PATCH", "/api/board/coming/2200", { stage: "building" })).status).toBe(400);
    expect((await send("PATCH", "/api/board/coming/2200", { title: "Data Import" })).status).toBe(200);
    expect((await send("PATCH", "/api/board/coming/2200", { pr: 2201 })).status).toBe(400);
    const byTitle = await send("PATCH", `/api/board/coming/${encodeURIComponent("Lobby tiles: new art")}`, { stage: "building" });
    expect(await byTitle.json()).toMatchObject({ item: { title: "Lobby tiles: new art", stage: "building" } });
    expect((await board()).board.coming.map((row) => row.title)).toEqual(["Docs refresh", "Data Import", "Lobby tiles: new art"]);

    expect((await send("DELETE", `/api/board/coming/${encodeURIComponent("Lobby tiles: new art")}`)).status).toBe(200);
    expect((await send("DELETE", "/api/board/coming/2100")).status).toBe(200);
    expect((await send("DELETE", "/api/board/coming/2100")).status).toBe(404);
    expect(bare((await board()).board.coming)).toEqual([{ pr: 2200, title: "Data Import" }]);
  });

  it("addresses a coming row by title with by=title, so a title of digits works and a bare number is a PR", async () => {
    await putBoard(server.base);
    expect((await send("PATCH", "/api/board/coming/2100?by=title", { stage: "building" })).status).toBe(200);
    expect(bare((await board()).board.coming)).toEqual([{ pr: 2100, title: "Docs refresh" }, { title: "2100", stage: "building" }]);
    expect((await send("PATCH", `/api/board/coming/${encodeURIComponent("Docs refresh")}?by=title`, { etaMinutes: 5 })).status).toBe(200);
    expect((await send("DELETE", "/api/board/coming/2100")).status).toBe(200);
    expect(bare((await board()).board.coming)).toEqual([{ title: "2100", stage: "building" }]);
    expect((await send("DELETE", "/api/board/coming/2100")).status).toBe(404);
    expect((await send("DELETE", "/api/board/coming/2100?by=pr")).status).toBe(400);
    expect((await send("DELETE", "/api/board/coming/2100?by=title")).status).toBe(200);
    expect((await board()).board.coming).toEqual([]);
  });

  it("refuses a coming change that gives a second row the same PR or title", async () => {
    await putBoard(server.base, { ...EXAMPLE_BOARD, coming: [{ pr: 2100, title: "Docs refresh" }, { pr: 2200, title: "Data Import" }, { title: "Lobby" }] });
    const renamed = await send("PATCH", "/api/board/coming/2200", { title: "Docs refresh" });
    expect(renamed.status).toBe(409);
    expect(await renamed.json()).toEqual({ error: 'a coming row is already titled "Docs refresh"' });
    const numbered = await send("PATCH", "/api/board/coming/Lobby", { pr: 2100 });
    expect(numbered.status).toBe(409);
    expect(await numbered.json()).toEqual({ error: "PR 2100 already has a coming row" });
    expect((await send("PATCH", "/api/board/coming/2300", { title: "Lobby" })).status).toBe(409);
    expect((await send("PATCH", "/api/board/coming/Lobby", { pr: 2300 })).status).toBe(200);
    expect((await send("PATCH", "/api/board/coming/2200", { title: "Data Import", stage: "review" })).status).toBe(200);
    expect((await board()).version).toBe(3);
  });

  it("refuses to change or drop a row that matches more than one", async () => {
    await putBoard(server.base, {
      ...EXAMPLE_BOARD,
      coming: [{ pr: 2100, title: "A" }, { pr: 2100, title: "B" }],
      chats: [{ name: "twin", state: "a" }, { name: "twin", state: "b" }],
    });
    const patch = await send("PATCH", "/api/board/coming/2100", { stage: "review" });
    expect(patch.status).toBe(409);
    expect(((await patch.json()) as { error: string }).error).toMatch(/^2 coming rows match/);
    expect((await send("DELETE", "/api/board/coming/2100")).status).toBe(409);
    expect((await send("PATCH", "/api/board/chats/twin", { state: "c" })).status).toBe(409);
    expect((await send("DELETE", "/api/board/chats/twin")).status).toBe(409);
    expect((await board()).version).toBe(1);
  });

  it("names a chat or coming row within its repo with ?repo=, and refuses a clash only within one repo", async () => {
    const third = "example-org/third-repo";
    await putBoard(server.base, {
      ...EXAMPLE_BOARD,
      coming: [{ pr: 7, title: "Seven", chat: "site" }, { pr: 7, title: "Third seven", chat: "lab" }],
      chats: [{ name: "site", state: "a", prs: [7] }, { name: "site", state: "b", repo: third }, { name: "lab", state: "c", repo: third, prs: [7] }],
    });
    // Two chats and two rows answer the bare key: the repo picks one, by the URL or by a chat's body.
    expect((await send("PATCH", "/api/board/coming/7", { stage: "review" })).status).toBe(409);
    expect((await send("PATCH", `/api/board/coming/7?repo=${encodeURIComponent(third)}`, { stage: "review" })).status).toBe(200);
    expect((await send("PATCH", "/api/board/chats/site", { state: "d" })).status).toBe(409);
    expect((await send("PATCH", "/api/board/chats/site", { state: "d", repo: third })).status).toBe(200);
    expect((await send("PATCH", `/api/board/chats/site?repo=${encodeURIComponent(third)}`, { repo: null })).status).toBe(400);
    expect((await send("PATCH", "/api/board/coming/7?repo=nope/nope/nope", { stage: "review" })).status).toBe(400);
    expect((await send("DELETE", "/api/board/needs/x?repo=" + encodeURIComponent(third))).status).toBe(400);
    // A PR or title another repo already has is no clash; one in the same repo is.
    expect((await send("PATCH", "/api/board/coming/Seven?by=title", { title: "Third seven" })).status).toBe(200);
    expect((await send("PATCH", "/api/board/coming/Third%20seven?by=title&repo=" + encodeURIComponent(third), { pr: 8 })).status).toBe(200);
    const { board: after } = await board();
    expect(after.coming.map((row) => [row.pr, row.title, (row as { stage?: string }).stage])).toEqual([
      [7, "Third seven", undefined],
      [8, "Third seven", "review"],
    ]);
    expect(after.chats.map((row) => [row.name, row.state])).toEqual([["site", "a"], ["site", "d"], ["lab", "c"]]);
    // Its PR 7 row would pass to the third repo's site, so the home repo's site goes only once that row has.
    const software = "?repo=example-org%2Fexample-repo";
    expect((await send("DELETE", `/api/board/chats/site${software}`)).status).toBe(409);
    expect((await send("DELETE", `/api/board/coming/7${software}`)).status).toBe(200);
    expect((await send("DELETE", `/api/board/chats/site${software}`)).status).toBe(200);
    expect((await board()).board.chats.map((row) => row.state)).toEqual(["d", "c"]);
    // ?repo= on a chat set makes that repo's chat when it has none, and never moves another repo's of the name.
    expect((await send("PATCH", "/api/board/chats/lab?repo=example-org%2Fexample-repo", { state: "e" })).status).toBe(200);
    expect((await board()).board.chats.map((row) => [row.name, row.state, (row as { repo?: string }).repo])).toEqual([["site", "d", third], ["lab", "c", third], ["lab", "e", undefined]]);
  });

  it("refuses a chat change that moves a coming row into a repo where its PR or title is taken", async () => {
    const third = "example-org/third-repo";
    await putBoard(server.base, {
      ...EXAMPLE_BOARD,
      coming: [{ pr: 7, title: "Software seven", chat: "soft" }, { pr: 7, title: "Third seven", chat: "lab" }, { pr: 9, title: "Software seven", chat: "lab" }],
      chats: [{ name: "soft", state: "a" }, { name: "lab", state: "b", repo: third }],
    });
    const pr = await send("PATCH", "/api/board/coming/Third%20seven?by=title", { chat: "soft" });
    expect(pr.status).toBe(409);
    expect(await pr.json()).toEqual({ error: "PR 7 already has a coming row" });
    const title = await send("PATCH", "/api/board/coming/9", { chat: "soft" });
    expect(title.status).toBe(409);
    expect(await title.json()).toEqual({ error: 'a coming row is already titled "Software seven"' });
    expect((await send("PATCH", "/api/board/coming/9", { chat: "lab", stage: "review" })).status).toBe(200);
    // Moving the lab chat itself to the home repo takes its rows there, where PR 7 is taken.
    const moved = await send("PATCH", "/api/board/chats/lab", { repo: null });
    expect(moved.status).toBe(409);
    expect(await moved.json()).toEqual({ error: "moving the chat would give example-org/example-repo two coming rows of PR 7" });
    expect((await send("PATCH", "/api/board/chats/soft", { state: "b" })).status).toBe(200);
    // So does a new home repo lab holding PR 7: the lab row of PR 7 would be its. One holding nothing makes the lab
    // rows two repos' (neither guessed), which moves none.
    const software = "?repo=example-org%2Fexample-repo";
    const holding = await send("PATCH", `/api/board/chats/lab${software}`, { state: "c", prs: [7] });
    expect(holding.status).toBe(409);
    expect(await holding.json()).toEqual({ error: "moving the chat would give example-org/example-repo two coming rows of PR 7" });
    expect((await send("PATCH", `/api/board/chats/lab${software}`, { state: "c" })).status).toBe(200);
    // Deleting the third repo's lab hands its rows to the home repo's lab; deleting soft moves nothing.
    const gone = await send("DELETE", "/api/board/chats/lab?repo=example-org%2Fthird-repo");
    expect(gone.status).toBe(409);
    expect(await gone.json()).toEqual({ error: "deleting the chat would move its coming row of PR 7 to example-org/example-repo: drop or move the row first" });
    expect((await send("DELETE", "/api/board/chats/soft")).status).toBe(200);
    // A repo's last chat of the name leaves its rows the default repo's, where settlement would drop one of a shipped PR.
    await putBoard(server.base, {
      ...EXAMPLE_BOARD,
      coming: [{ pr: 7, title: "Third seven", chat: "lab" }, { pr: 8, title: "Third eight", chat: "other" }],
      chats: [{ name: "lab", state: "a", repo: third, prs: [7] }, { name: "other", state: "b", repo: third, prs: [8] }],
      shipped: [{ pr: 7, title: "Software seven" }],
    });
    const last = await send("DELETE", "/api/board/chats/lab?repo=example-org%2Fthird-repo");
    expect(last.status).toBe(409);
    expect(await last.json()).toEqual({ error: "deleting the chat would move its coming row of PR 7 to example-org/example-repo: drop or move the row first" });
    // The same with nothing shipped: settlement could still drop it on the default repo's PR 8 closing.
    expect((await send("DELETE", "/api/board/chats/other?repo=example-org%2Fthird-repo")).status).toBe(409);
    expect((await send("DELETE", `/api/board/coming/8?repo=${encodeURIComponent(third)}`)).status).toBe(200);
    expect((await send("DELETE", "/api/board/chats/other?repo=example-org%2Fthird-repo")).status).toBe(200);
  });

  it("refuses a whole-board PUT whose chats move a kept coming row as a chat's own routes could not", async () => {
    const third = "example-org/third-repo";
    const start = {
      ...EXAMPLE_BOARD,
      coming: [{ pr: 7, title: "Software seven", chat: "lab" }],
      chats: [{ name: "lab", state: "a", prs: [7] }, { name: "lab", state: "b", repo: third, prs: [8] }],
      shipped: [{ pr: 7, title: "Third seven", repo: third }],
    };
    expect((await putBoard(server.base, start)).status).toBe(200);
    // Dropping the home lab hands the row to the third repo's lab, where PR 7 has shipped: settlement would drop it. Not a
    // 409, which push-board retries as a stale version. A new title keeps the row the PR's.
    const refusal = { error: `dropping a chat would move its coming row of PR 7 to ${third}: drop or move the row first` };
    for (const coming of [start.coming, [{ ...start.coming[0]!, title: "Software seven v2" }]]) {
      const dropped = await putBoard(server.base, { ...start, coming, chats: [start.chats[1]!] });
      expect(dropped.status).toBe(422);
      expect(await dropped.json()).toEqual(refusal);
    }
    expect((await board()).board.coming).toEqual([expect.objectContaining({ title: "Software seven" })]);
    // A chat changed, not dropped, may move it, but not where its PR shipped or another row has it.
    const moved = await putBoard(server.base, { ...start, chats: [{ ...start.chats[0]!, repo: third }, start.chats[1]!] });
    expect(moved.status).toBe(422);
    expect(await moved.json()).toEqual({ error: `the board's chats would move the coming row of PR 7 to ${third}, where PR 7 has shipped` });
    const taken = await putBoard(server.base, {
      ...start,
      coming: [...start.coming, { pr: 7, title: "Third seven", chat: "other" }],
      chats: [{ ...start.chats[0]!, repo: third }, start.chats[1]!, { name: "other", state: "c", repo: third }],
      shipped: [],
    });
    expect(taken.status).toBe(422);
    expect(await taken.json()).toEqual({ error: `the board's chats would give ${third} two coming rows of PR 7` });
    // A PUT that drops the row with its chat, or a row it adds, is the writer's to make.
    expect((await putBoard(server.base, { ...start, coming: [], chats: [start.chats[1]!] })).status).toBe(200);
    expect((await putBoard(server.base, { ...start, coming: [{ pr: 9, title: "Third nine", chat: "lab" }], chats: [start.chats[1]!] })).status).toBe(200);
    // A repo's last chat of the name leaves its row the default repo's, where settlement could drop it on that repo's PR
    // closing, shipped or not: dropping it is refused as its DELETE is.
    const sole = { ...EXAMPLE_BOARD, coming: [{ pr: 8, title: "Third eight", chat: "lab" }], chats: [{ name: "lab", state: "a", repo: third, prs: [8] }] };
    expect((await putBoard(server.base, sole)).status).toBe(200);
    const last = await putBoard(server.base, { ...sole, chats: [] });
    expect(last.status).toBe(422);
    expect(await last.json()).toEqual({ error: "dropping a chat would move its coming row of PR 8 to example-org/example-repo: drop or move the row first" });
    // A row two repos claimed may not leave both for a third; one of them taking it is settling it (round 2).
    const kids = "example-org/side-app";
    const two = { ...EXAMPLE_BOARD, coming: [{ pr: 7, title: "Seven", chat: "lab" }], chats: [{ name: "lab", state: "a", repo: third, prs: [7] }, { name: "lab", state: "b", repo: kids, prs: [7] }] };
    expect((await putBoard(server.base, two)).status).toBe(200);
    expect((await putBoard(server.base, { ...two, chats: [] })).status).toBe(422);
    expect((await putBoard(server.base, { ...two, chats: [two.chats[0]!] })).status).toBe(200);
    // A numbered name with a chat of its own reads that chat: dropping the unused base chat moves nothing.
    const numbered = { ...EXAMPLE_BOARD, coming: [{ pr: 7, title: "Seven", chat: "lab-1" }], chats: [{ name: "lab-1", state: "a", repo: third }, { name: "lab", state: "b" }] };
    expect((await putBoard(server.base, numbered)).status).toBe(200);
    expect((await putBoard(server.base, { ...numbered, chats: [{ name: "lab-1", state: "a" }] })).status).toBe(200);
    // A numbered name whose base chat does not hold its PR reads that chat's repo or the default; dropping the chat is no
    // settling into the default, which no chat claimed (round 3).
    const base = { ...EXAMPLE_BOARD, coming: [{ pr: 7, title: "Third seven", chat: "lab-1" }], chats: [{ name: "lab", state: "a", repo: third, prs: [8] }] };
    expect((await putBoard(server.base, base)).status).toBe(200);
    expect((await putBoard(server.base, { ...base, chats: [] })).status).toBe(422);
  });

  it("refuses a coming row's move into a repo where its PR shipped", async () => {
    const third = "example-org/third-repo";
    await putBoard(server.base, {
      ...EXAMPLE_BOARD,
      coming: [{ pr: 7, title: "Third seven", chat: "lab" }],
      chats: [{ name: "lab", state: "a", repo: third }, { name: "soft", state: "b" }],
      shipped: [{ pr: 7, title: "Software seven" }],
    });
    const moved = await send("PATCH", "/api/board/coming/7", { chat: "soft" });
    expect(moved.status).toBe(409);
    expect(await moved.json()).toEqual({ error: "PR 7 has shipped in example-org/example-repo" });
    expect((await send("PATCH", "/api/board/coming/7", { stage: "review" })).status).toBe(200);
    // So is one narrowed from two repos to the one where its PR shipped (round 2).
    await putBoard(server.base, {
      ...EXAMPLE_BOARD,
      coming: [{ pr: 7, title: "Seven", chat: "lab" }],
      chats: [{ name: "lab", state: "a", prs: [7] }, { name: "lab", state: "b", repo: third, prs: [7] }, { name: "soft", state: "c" }],
      shipped: [{ pr: 7, title: "Software seven" }],
    });
    expect((await send("PATCH", "/api/board/coming/7", { chat: "soft" })).status).toBe(409);
    // Nor narrowed onto a repo where another row has its PR (round 3).
    await putBoard(server.base, {
      ...EXAMPLE_BOARD,
      coming: [{ pr: 7, title: "Seven", chat: "lab" }, { pr: 7, title: "Taken", chat: "soft" }],
      chats: [{ name: "lab", state: "a", prs: [7] }, { name: "lab", state: "b", repo: third, prs: [7] }, { name: "soft", state: "c" }],
    });
    const narrowed = await send("PATCH", "/api/board/coming/Seven?by=title", { chat: "soft" });
    expect(narrowed.status).toBe(409);
    expect(await narrowed.json()).toEqual({ error: "PR 7 already has a coming row" });
  });

  it("refuses an item write that would take the board over 1 MB", async () => {
    expect((await putBoard(server.base, { ...EXAMPLE_BOARD, padding: filler(900_000) })).status).toBe(200);
    const big = await send("PUT", "/api/board/needs/notes", { kind: "decision", title: "Notes", notes: filler(200_000) });
    expect(big.status).toBe(413);
    expect((await board()).version).toBe(1);
    expect((await send("PUT", "/api/board/needs/notes", { kind: "decision", title: "Notes", notes: filler(1000) })).status).toBe(200);
  });

  it("keeps the whole-board PUT's request-size limit when schema defaults grow the body", async () => {
    const body = { updatedAt: "2026-10-01T00:00:00.000Z", needs: [], padding: "" };
    body.padding = filler(1_000_000 - 10 - JSON.stringify(body).length);
    expect((await putBoard(server.base, body)).status).toBe(200);
  });

  it("lets an item write through a stored board over 1 MB unless it grows the board", async () => {
    const body = { updatedAt: "2026-10-01T00:00:00.000Z", needs: EXAMPLE_BOARD.needs, padding: "" };
    body.padding = filler(1_000_000 - 10 - JSON.stringify(body).length);
    expect((await putBoard(server.base, body)).status).toBe(200);
    const size = () => Buffer.byteLength(JSON.stringify(server.app.store.getBoard()!.board));
    const before = size();
    expect(before).toBeGreaterThan(1_000_000);

    expect((await send("PATCH", "/api/board/needs/billing-retry", { title: "Billing retry queue, longer" })).status).toBe(413);
    expect((await board()).version).toBe(1);
    expect((await send("PATCH", "/api/board/needs/billing-retry", { title: "Billing retry QUEUE" })).status).toBe(200);
    expect(size()).toBe(before);
    expect((await send("PATCH", "/api/board/needs/billing-retry", { title: "Billing" })).status).toBe(200);
    expect(size()).toBeLessThan(before);
    expect((await send("PUT", "/api/board/shipped", [])).status).toBe(200);
    expect((await board()).version).toBe(4);
  });

  it("replaces shipped whole", async () => {
    await putBoard(server.base);
    const shipped = [{ pr: 2300, title: "Results row", deployed: true }];
    const put = await send("PUT", "/api/board/shipped", shipped);
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ version: 2, item: shipped });
    expect((await send("PATCH", "/api/board/shipped", [])).status).toBe(405);
    const stored = await board();
    expect(bare(stored.board.shipped)).toEqual(shipped);
    expect(stored.board.needs).toHaveLength(2);
  });

  it("still takes a whole-board PUT, which overwrites item edits", async () => {
    await putBoard(server.base);
    await send("PATCH", "/api/board/needs/billing-retry", { title: "edited" });
    const put = await putBoard(server.base);
    expect(await put.json()).toMatchObject({ version: 3 });
    expect((await board()).board.needs[1]!.title).toBe("Billing retry queue");
  });
});
