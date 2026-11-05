import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearedSessionCookie, sessionCookie } from "../src/server/auth.js";
import type { Board, Reply } from "../src/shared/board.js";
import {
  bearer,
  BOARD_TOKEN,
  BRIDGE_TOKEN,
  browser,
  ENROLL_TOKEN,
  EXAMPLE_BOARD,
  ORIGIN,
  oversizedStatus,
  putBoard,
  rawGet,
  REPLY_BOARD,
  revOf,
  startServer,
  type TestServer,
} from "./helpers.js";

let server: TestServer;
let cookie: string;

beforeEach(async () => {
  server = await startServer();
  cookie = server.cookie();
});

afterEach(async () => {
  await server.close();
});

/** Posts a reply, filling in the card's current rev unless the test sets one. */
async function postReply(body: Record<string, unknown>, headers = browser(cookie)): Promise<Response> {
  const rev = "rev" in body ? body.rev : await revOf(server.base, cookie, body.itemId as string).catch(() => "0".repeat(16));
  return fetch(`${server.base}/api/replies`, { method: "POST", headers, body: JSON.stringify({ ...body, rev }) });
}

/** Opens the bridge stream saying these features, so the server knows what the bridge takes; abort closes it. */
async function connectBridge(features: string): Promise<AbortController> {
  const controller = new AbortController();
  const response = await fetch(`${server.base}/api/bridge/events`, { headers: { ...bearer(BRIDGE_TOKEN), "x-rivet-bridge-features": features }, signal: controller.signal });
  expect(response.status).toBe(200);
  return controller;
}

/** Gives the card a new revision, so another answer is not refused as a second one to the same revision. */
function revise(itemId: string, tag: string): void {
  const board = structuredClone(server.app.store.getBoard()!.board);
  const need = board.needs.find((item) => item.id === itemId)!;
  need.ask = `${need.ask ?? need.title} (${tag})`;
  server.app.store.putBoard(board, null);
}

describe("health and headers", () => {
  it("answers /healthz with JSON only and sets security headers", async () => {
    const response = await fetch(`${server.base}/healthz`, { headers: { accept: "text/html" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({ ok: true });
    // blob: images and fetches and blob: audio (read-aloud) are the only allowances past 'self'.
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' blob:; media-src 'self' blob:; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("strict-transport-security")).toBeNull();
  });

  it("sends HSTS in production", async () => {
    const prod = await startServer({ NODE_ENV: "production", RIVET_ORIGIN: "https://rivet.example.com" });
    try {
      const response = await fetch(`${prod.base}/healthz`);
      expect(response.headers.get("strict-transport-security")).toMatch(/max-age=\d+/);
    } finally {
      await prod.close();
    }
  });
});

describe("PUT /api/board", () => {
  it("requires the board token", async () => {
    const body = JSON.stringify(EXAMPLE_BOARD);
    expect((await fetch(`${server.base}/api/board`, { method: "PUT", body })).status).toBe(401);
    expect((await fetch(`${server.base}/api/board`, { method: "PUT", headers: bearer(BRIDGE_TOKEN), body })).status).toBe(401);
    expect((await fetch(`${server.base}/api/board`, { method: "PUT", headers: { ...browser(cookie) }, body })).status).toBe(401);
  });

  it("stores the board, bumps the version and honours If-Match", async () => {
    const first = await putBoard(server.base);
    expect(first.status).toBe(200);
    const written = (await first.json()) as { version: number; updatedAt: string };
    expect(written.version).toBe(1);
    expect(Date.parse(written.updatedAt)).not.toBeNaN();

    const stale = await fetch(`${server.base}/api/board`, {
      method: "PUT",
      headers: { ...bearer(BOARD_TOKEN), "if-match": "0" },
      body: JSON.stringify(EXAMPLE_BOARD),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ version: 1 });

    const pinned = await fetch(`${server.base}/api/board`, {
      method: "PUT",
      headers: { ...bearer(BOARD_TOKEN), "if-match": '"1"' },
      body: JSON.stringify(EXAMPLE_BOARD),
    });
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toMatchObject({ version: 2 });

    const read = await fetch(`${server.base}/api/board`, { headers: { cookie } });
    expect(read.status).toBe(200);
    const body = (await read.json()) as { version: number; board: typeof EXAMPLE_BOARD };
    expect(body.version).toBe(2);
    expect(body.board.needs[0]!.id).toBe("pr2022-checkout");
  });

  it("rejects an invalid board and a body over 1 MB", async () => {
    const bad = structuredClone(EXAMPLE_BOARD);
    bad.needs[0]!.links![0]!.url = "javascript:alert(1)";
    expect((await putBoard(server.base, bad)).status).toBe(400);

    const huge = { ...EXAMPLE_BOARD, padding: "x".repeat(1_100_000) };
    expect(await oversizedStatus(putBoard(server.base, huge))).toBe(413);
  });

  it("needs a session or the board token to read the board", async () => {
    expect((await fetch(`${server.base}/api/board`)).status).toBe(401);
    expect((await fetch(`${server.base}/api/board`, { headers: bearer(BRIDGE_TOKEN) })).status).toBe(401);
    expect((await fetch(`${server.base}/api/board`, { headers: bearer(BOARD_TOKEN) })).status).toBe(200);
  });
});

describe("POST /api/replies", () => {
  beforeEach(async () => {
    await putBoard(server.base, REPLY_BOARD);
  });

  it("records a choice with an item snapshot", async () => {
    const response = await postReply({
      clientId: "client-0001",
      itemId: "pr2022-checkout",
      decision: "choice",
      choice: "Approve and merge",
      text: "  looks great  ",
    });
    expect(response.status).toBe(201);
    const reply = (await response.json()) as Record<string, unknown>;
    expect(reply).toMatchObject({
      itemId: "pr2022-checkout",
      itemTitle: EXAMPLE_BOARD.needs[0]!.title,
      decision: "choice",
      choice: "Approve and merge",
      text: "looks great",
      handled: false,
      item: {
        id: "pr2022-checkout",
        kind: "approval",
        chat: "checkout-feedback",
        pr: 2022,
      },
    });
    expect(reply.item).not.toHaveProperty("repo");
    expect(reply.clientId).toBe("client-0001");
    const listed = (await (await fetch(`${server.base}/api/replies`, { headers: { cookie } })).json()) as { replies: { clientId?: string }[] };
    expect(listed.replies.map((item) => item.clientId)).toContain("client-0001");
  });

  it("keeps the selected detail after replacement, deletion and an idempotent retry", async () => {
    const board = structuredClone(REPLY_BOARD) as Board;
    board.needs[0]!.options = [{ label: "Proceed", detail: "Deploy to staging only" }, { label: "Wait", detail: "Do not deploy" }];
    expect((await putBoard(server.base, board)).status).toBe(200);
    const body = { clientId: "client-detail-01", itemId: board.needs[0]!.id, decision: "choice", choice: "Proceed", rev: await revOf(server.base, cookie, board.needs[0]!.id) };
    const response = await postReply(body);
    expect(response.status).toBe(201);
    const reply = await response.json() as Reply;
    expect(reply.item.choiceDetail).toBe("Deploy to staging only");
    const ambiguous = structuredClone(board);
    ambiguous.needs[0]!.options!.push({ label: "Proceed", detail: "Deploy to production" });
    server.app.store.putBoard(ambiguous, null);
    const historicalRetry = await postReply(body);
    expect(historicalRetry.status).toBe(200);
    expect((await historicalRetry.json()).item.choiceDetail).toBe("Deploy to staging only");
    board.needs[0]!.options![0]!.detail = "Deploy to production";
    expect((await putBoard(server.base, board)).status).toBe(200);
    for (const remove of [false, true]) {
      if (remove) expect((await putBoard(server.base, { ...board, needs: [] })).status).toBe(200);
      const record = await fetch(`${server.base}/api/replies/${reply.id}`, { headers: bearer(BOARD_TOKEN) });
      expect((await record.json()).item.choiceDetail).toBe("Deploy to staging only");
      const retry = await postReply(body);
      expect(retry.status).toBe(200);
      expect((await retry.json()).item.choiceDetail).toBe("Deploy to staging only");
    }
  });

  it("omits missing or malformed legacy option details without refusing the answer", async () => {
    const validatePath = "../bridge/lib/validate.mjs";
    const { validateReply } = (await import(validatePath)) as { validateReply(reply: unknown): { ok: boolean } };
    for (const [n, detail] of [undefined, null, 12, {}, [], "", "  ", "x".repeat(1001), "x".repeat(1000)].entries()) {
      const board = structuredClone(REPLY_BOARD) as Board;
      board.needs[0]!.options = [{ label: "Proceed", detail }] as never;
      server.app.store.putBoard(board, null);
      const response = await postReply({ clientId: `client-detail-${n + 10}`, itemId: board.needs[0]!.id, decision: "choice", choice: "Proceed" });
      expect(response.status).toBe(201);
      const reply = await response.json();
      if (typeof detail === "string" && detail.length === 1000) expect(reply.item.choiceDetail).toBe(detail);
      else expect(reply).not.toHaveProperty("item.choiceDetail");
      expect(validateReply(reply)).toMatchObject({ ok: true });
      const comment = await postReply({ clientId: `client-comment-${n + 10}`, itemId: board.needs[0]!.id, decision: "comment", text: "Later" });
      expect(await comment.json()).not.toHaveProperty("item.choiceDetail");
    }
  });

  it("404s an item that is not on the board", async () => {
    const response = await postReply({ clientId: "client-0002", itemId: "gone-item", decision: "approve" });
    expect(response.status).toBe(404);
  });

  it("400s a choice that is not one of the item's options", async () => {
    const response = await postReply({ clientId: "client-0003", itemId: "pr2022-checkout", decision: "choice", choice: "Merge it anyway" });
    expect(response.status).toBe(400);
    const noText = await postReply({ clientId: "client-0004", itemId: "pr2022-checkout", decision: "comment", text: "   " });
    expect(noText.status).toBe(400);
    const tooLong = await postReply({ clientId: "client-0005", itemId: "pr2022-checkout", decision: "comment", text: "x".repeat(4001) });
    expect(tooLong.status).toBe(400);
  });

  it("400s a bare approve on a card with options or a typed-answer question", async () => {
    const onOptions = await postReply({ clientId: "client-0050", itemId: "pr2022-checkout", decision: "approve" });
    expect(onOptions.status).toBe(400);
    expect(await onOptions.json()).toMatchObject({ error: "pick one of the options" });

    const board = structuredClone(EXAMPLE_BOARD) as typeof EXAMPLE_BOARD & { needs: Record<string, unknown>[] };
    board.needs.push({ id: "freeze-changes", kind: "question", title: "What should change?" });
    board.needs.push({ id: "freeze-note", kind: "approval", title: "Anything else?", reply: "text" });
    expect((await putBoard(server.base, board)).status).toBe(200);
    for (const [index, itemId] of ["freeze-changes", "freeze-note"].entries()) {
      const approve = await postReply({ clientId: `client-005${index + 1}`, itemId, decision: "approve" });
      expect(approve.status).toBe(400);
      expect(await approve.json()).toMatchObject({ error: "this card needs a typed answer" });
      const typed = await postReply({ clientId: `client-006${index + 1}`, itemId, decision: "comment", text: "Make the ice bluer" });
      expect(typed.status).toBe(201);
    }
  });

  it("400s an option that asks for a note when the note is missing", async () => {
    const board = structuredClone(EXAMPLE_BOARD) as typeof EXAMPLE_BOARD & { needs: Record<string, unknown>[] };
    board.needs.push({
      id: "freeze-merge",
      kind: "decision",
      title: "Merge Freeze 3D?",
      options: [{ label: "Merge as is" }, { label: "Change something (type what)", text: true }],
    });
    expect((await putBoard(server.base, board)).status).toBe(200);
    const bare = await postReply({ clientId: "client-0040", itemId: "freeze-merge", decision: "choice", choice: "Change something (type what)" });
    expect(bare.status).toBe(400);
    const noted = await postReply({
      clientId: "client-0041",
      itemId: "freeze-merge",
      decision: "choice",
      choice: "Change something (type what)",
      text: "Bigger ice cubes",
    });
    expect(noted.status).toBe(201);
    revise("freeze-merge", "again");
    const plain = await postReply({ clientId: "client-0042", itemId: "freeze-merge", decision: "choice", choice: "Merge as is" });
    expect(plain.status).toBe(201);
  });

  it("refuses ambiguous legacy option labels with or without a typed note", async () => {
    const board = structuredClone(EXAMPLE_BOARD) as typeof EXAMPLE_BOARD & { needs: Record<string, unknown>[] };
    board.needs.push({ id: "dup-labels", kind: "decision", title: "Which?", options: [{ label: "Proceed", detail: "Deploy to production" }, { label: "Proceed", detail: "Deploy to staging only", text: true }] });
    expect((await putBoard(server.base, board)).status).toBe(200);
    server.app.store.putBoard(board as never, null);
    for (const [index, text] of [undefined, "Staging only"].entries()) {
      const result = await postReply({ clientId: `client-ambiguous-${index}`, itemId: "dup-labels", decision: "choice", choice: "Proceed", text });
      expect(result.status).toBe(400);
      expect(await result.json()).toMatchObject({ error: "this card has ambiguous option labels; ask for a corrected card" });
      expect(server.app.store.getReplyByClientId(`client-ambiguous-${index}`)).toBeNull();
    }
  });

  it("a todo card takes Done, Reject or a comment, and only a todo card takes Done", async () => {
    const board = structuredClone(EXAMPLE_BOARD) as typeof EXAMPLE_BOARD & { needs: Record<string, unknown>[] };
    board.needs.push({ id: "tax", kind: "todo", title: "Add the tax form in App Store Connect", steps: ["Sign in", "Open Agreements"], risk: "money", options: [{ label: "Later" }] });
    board.needs.push({ id: "old-todo", kind: "todo", title: "Renew the old certificate", steps: ["Open the portal"] });
    expect((await putBoard(server.base, board)).status).toBe(200);
    for (const [index, refused] of [{ decision: "approve" }, { decision: "choice", choice: "Later" }].entries()) {
      const response = await postReply({ clientId: `client-0070${index}`, itemId: "tax", ...refused });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "this card takes Done, Reject, Dismiss or a comment" });
    }
    expect((await postReply({ clientId: "client-00710", itemId: "pr2022-checkout", decision: "done" })).status).toBe(400);
    expect((await postReply({ clientId: "client-00711", itemId: "tax", decision: "comment", text: "Which form?" })).status).toBe(201);
    // With no Dismiss on the Feed, a todo that is way off is rejected with your why (2026-10-13).
    // A reject always says why: one with no words is refused, as an old app or notification would send.
    expect((await postReply({ clientId: "client-00714", itemId: "old-todo", decision: "reject", text: "   " })).status).toBe(400);
    expect((await postReply({ clientId: "client-00713", itemId: "old-todo", decision: "reject", text: "Not needed, the certificate moved" })).status).toBe(201);
    // Done is not an approval, so a risk on the card asks for no confirm tap.
    revise("tax", "answered");
    const done = await postReply({ clientId: "client-00712", itemId: "tax", decision: "done" });
    expect(done.status).toBe(201);
    expect(await done.json()).toMatchObject({ decision: "done", item: { kind: "todo", title: "Add the tax form in App Store Connect" } });
  });

  it("keeps a todo card's steps in the reply after the card is dropped", async () => {
    const board = structuredClone(EXAMPLE_BOARD) as typeof EXAMPLE_BOARD & { needs: Record<string, unknown>[] };
    board.needs.push({ id: "tax", kind: "todo", title: "Add the tax form", steps: ["Sign in", "Open Agreements", "Add the tax form"] });
    expect((await putBoard(server.base, board)).status).toBe(200);
    const done = await postReply({ clientId: "client-00720", itemId: "tax", decision: "done" });
    expect(await done.json()).toMatchObject({ item: { steps: ["Sign in", "Open Agreements", "Add the tax form"] } });
    expect((await putBoard(server.base)).status).toBe(200);
    const list = (await (await fetch(`${server.base}/api/replies`, { headers: { cookie } })).json()) as { replies: Reply[] };
    expect(list.replies.find((reply) => reply.itemId === "tax")?.item.steps).toEqual(["Sign in", "Open Agreements", "Add the tax form"]);
    const comment = await postReply({ clientId: "client-00721", itemId: "billing-retry", decision: "comment", text: "Later" });
    expect(await comment.json()).not.toHaveProperty("item.steps");
  });

  it("leaves out steps a board stored before they were checked, so the bridge still takes the reply", async () => {
    const validatePath = "../bridge/lib/validate.mjs";
    const { validateReply } = (await import(validatePath)) as { validateReply(reply: unknown): { ok: boolean } };
    for (const [n, need] of [
      [0, { id: "legacy-a", kind: "todo", title: "Task", steps: "Sign in" }],
      [1, { id: "legacy-b", kind: "approval", title: "Old task", steps: [] }],
      [2, { id: "legacy-c", kind: "approval", title: "Old steps", steps: ["Sign in"] }],
    ] as const) {
      const board = structuredClone(EXAMPLE_BOARD) as typeof EXAMPLE_BOARD & { needs: unknown[] };
      board.needs.push(need);
      server.app.store.putBoard(board as never, null);
      const decision = need.kind === "todo" ? "done" : "approve";
      const res = await postReply({ clientId: `client-0073${n}`, itemId: need.id, decision });
      expect(res.status).toBe(201);
      const reply = await res.json();
      expect(reply).not.toHaveProperty("item.steps");
      expect(validateReply(reply)).toMatchObject({ ok: true });
    }
  });

  it("428s a risk item approved without the confirm tap", async () => {
    expect((await postReply({ clientId: "client-0006", itemId: "billing-cap", decision: "approve" })).status).toBe(428);
    expect((await postReply({ clientId: "client-0007", itemId: "billing-retry", decision: "choice", choice: "Ship it" })).status).toBe(428);
    expect((await postReply({ clientId: "client-0008", itemId: "billing-retry", decision: "reject", text: "Not this week" })).status).toBe(201);
    const confirmed = await postReply({ clientId: "client-0009", itemId: "billing-cap", decision: "approve", confirm: true });
    expect(confirmed.status).toBe(201);
    expect(await confirmed.json()).toMatchObject({ item: { risk: "money" } });
  });

  it("is idempotent on clientId", async () => {
    const body = { clientId: "client-0010", itemId: "pr105-touch", decision: "approve" };
    const first = await postReply(body);
    const second = await postReply(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const [a, b] = (await Promise.all([first.json(), second.json()])) as { id: string }[];
    expect(b!.id).toBe(a!.id);
    const list = (await (await fetch(`${server.base}/api/replies`, { headers: { cookie } })).json()) as { replies: unknown[] };
    expect(list.replies).toHaveLength(1);
  });

  it("takes the first answer to a card revision and refuses a later one from another client, until the card changes", async () => {
    const first = await postReply({ clientId: "client-first", itemId: "pr2022-checkout", decision: "choice", choice: "Approve and merge" });
    expect(first.status).toBe(201);
    const recorded = (await first.json()) as Reply;
    for (const [n, second] of [
      { decision: "reject", text: "No, hold it" },
      { decision: "choice", choice: "Approve and merge" },
      { decision: "comment", text: "Wait" },
      { decision: "dismiss" },
    ].entries()) {
      const response = await postReply({ clientId: `client-second-${n}`, itemId: "pr2022-checkout", ...second });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "This card was already answered.", answered: { id: recorded.id, decision: "choice", choice: "Approve and merge" } });
    }
    // The first answer's own retry still replays it.
    expect((await postReply({ clientId: "client-first", itemId: "pr2022-checkout", decision: "choice", choice: "Approve and merge" })).status).toBe(200);
    const list = (await (await fetch(`${server.base}/api/replies`, { headers: { cookie } })).json()) as { replies: Reply[] };
    expect(list.replies.filter((reply) => reply.itemId === "pr2022-checkout").map((reply) => reply.id)).toEqual([recorded.id]);

    // A new revision of the card can be answered.
    const board = structuredClone(REPLY_BOARD) as Board;
    board.needs.find((need) => need.id === "pr2022-checkout")!.ask = "The new build: merge it?";
    expect((await putBoard(server.base, board)).status).toBe(200);
    expect((await postReply({ clientId: "client-next-rev", itemId: "pr2022-checkout", decision: "reject", text: "Not this one" })).status).toBe(201);
  });

  it("Answer again makes an answered card a new revision, whose answer is recorded as a change of the first", async () => {
    const again = (rev: unknown, id = "pr2022-checkout", headers = browser(cookie)) =>
      fetch(`${server.base}/api/board/needs/${id}/again`, { method: "POST", headers, body: JSON.stringify({ rev }) });
    const rev = await revOf(server.base, cookie, "pr2022-checkout");
    expect(await (await again(rev)).json()).toMatchObject({ error: "this card has no answer to change yet" });
    const first = (await (await postReply({ clientId: "client-first", itemId: "pr2022-checkout", decision: "reject", text: "No" })).json()) as Reply;
    expect((await again(rev, "pr2022-checkout", { cookie, origin: ORIGIN, "content-type": "application/json" })).status).toBe(403);
    // Only a bridge whose chat line names the answer changed takes one.
    expect(await (await again(rev)).json()).toEqual({ error: "The Mac's bridge hasn't connected since the server restarted. Try again in a minute." });
    const old = await connectBridge("image,chat-window");
    expect([(await again(rev)).status, await (await again(rev)).json()]).toEqual([424, { error: "The Mac's bridge needs updating before an answer can be changed." }]);
    old.abort();
    const stream = await connectBridge("image,chat-window,changes");
    const opened = await again(rev);
    expect(opened.status).toBe(200);
    const { item } = (await opened.json()) as { item: { rev: string; again: unknown } };
    expect(item).toMatchObject({ again: { n: 1, after: first.id } });
    expect(item.rev).not.toBe(rev);
    expect(await revOf(server.base, cookie, "pr2022-checkout")).toBe(item.rev);
    // A second tap on the old revision is refused: the card changed.
    expect((await again(rev)).status).toBe(409);
    // The old revision still refuses a second answer; the new one takes one, as a change of the first.
    expect((await postReply({ clientId: "client-old", itemId: "pr2022-checkout", decision: "comment", text: "Hm", rev })).status).toBe(409);
    const changed = await postReply({ clientId: "client-changed", itemId: "pr2022-checkout", decision: "comment", text: "Go ahead after all" });
    expect(changed.status).toBe(201);
    expect(((await changed.json()) as Reply).item.changes).toEqual({ replyId: first.id, decision: "reject" });
    expect((await postReply({ clientId: "client-third", itemId: "pr2022-checkout", decision: "dismiss" })).status).toBe(409);

    // A board write that sends the card unchanged keeps the new revision; a writer's own again goes; a changed card drops it.
    const served = (await (await fetch(`${server.base}/api/board`, { headers: { authorization: `Bearer ${BOARD_TOKEN}` } })).json()) as { board: Board };
    expect((await putBoard(server.base, served.board)).status).toBe(200);
    expect(await revOf(server.base, cookie, "pr2022-checkout")).toBe(item.rev);
    const forged = structuredClone(REPLY_BOARD) as Board;
    forged.needs.find((need) => need.id === "pr105-touch")!.again = { n: 3, after: first.id };
    expect((await putBoard(server.base, forged)).status).toBe(200);
    expect(server.app.store.getBoard()!.board.needs.find((need) => need.id === "pr105-touch")!.again).toBeUndefined();
    expect(server.app.store.getBoard()!.board.needs.find((need) => need.id === "pr2022-checkout")!.again).toEqual({ n: 1, after: first.id, at: expect.any(String) });
    revise("pr2022-checkout", "new build");
    const board = structuredClone(server.app.store.getBoard()!.board);
    delete board.needs.find((need) => need.id === "pr2022-checkout")!.again;
    board.needs.find((need) => need.id === "pr2022-checkout")!.ask = "Another build: merge it?";
    expect((await putBoard(server.base, board)).status).toBe(200);
    expect(server.app.store.getBoard()!.board.needs.find((need) => need.id === "pr2022-checkout")!.again).toBeUndefined();
    expect((await again(rev, "no-such-card")).status).toBe(404);

    // Answer again stops at 1000 changes, as far as Media follows them.
    const worn = structuredClone(server.app.store.getBoard()!.board);
    const wornNeed = worn.needs.find((need) => need.id === "pr2022-checkout")!;
    wornNeed.again = { n: 1000, after: first.id };
    server.app.store.putBoard(worn, null);
    const wornRev = await revOf(server.base, cookie, "pr2022-checkout");
    expect((await postReply({ clientId: "client-worn", itemId: "pr2022-checkout", decision: "reject", text: "no" })).status).toBe(201);
    const tooMany = await again(wornRev);
    expect([tooMany.status, await tooMany.json()]).toEqual([409, { error: "this card's answer has been changed too many times" }]);
    stream.abort();
  });

  it("refuses cross-site and header-less posts (CSRF)", async () => {
    const body = { clientId: "client-0011", itemId: "pr105-touch", decision: "approve" };
    const noHeader = await postReply(body, { cookie, origin: ORIGIN, "content-type": "application/json" });
    expect(noHeader.status).toBe(403);
    const otherOrigin = await postReply(body, { ...browser(cookie), origin: "https://evil.example" });
    expect(otherOrigin.status).toBe(403);
    const noOrigin = await postReply(body, { cookie, "x-rivet": "1", "content-type": "application/json" });
    expect(noOrigin.status).toBe(403);
    const logout = await fetch(`${server.base}/api/auth/logout`, { method: "POST", headers: { cookie, "x-rivet": "1" } });
    expect(logout.status).toBe(403);
  });

  it("needs a session", async () => {
    const response = await postReply(
      { clientId: "client-0012", itemId: "pr105-touch", decision: "approve" },
      { ...browser("__Host-rivet=" + "A".repeat(43)) },
    );
    expect(response.status).toBe(401);
  });
});

describe("card rev", () => {
  beforeEach(async () => {
    await putBoard(server.base);
  });

  const changed = (edit: (need: (typeof EXAMPLE_BOARD)["needs"][number]) => void) => {
    const board = structuredClone(EXAMPLE_BOARD);
    edit(board.needs[0]!);
    return board;
  };

  it("serves a 16-hex rev per need that ignores fields the card does not pin", async () => {
    const rev = await revOf(server.base, cookie, "pr2022-checkout");
    expect(rev).toMatch(/^[0-9a-f]{16}$/);
    expect(await revOf(server.base, cookie, "billing-retry")).not.toBe(rev);
    await putBoard(server.base, { ...changed((need) => (need.since = "2026-09-28T05:00:00.000Z")), updatedAt: "2026-09-28T05:00:00.000Z" });
    expect(await revOf(server.base, cookie, "pr2022-checkout")).toBe(rev);
  });

  it.each<[string, (need: (typeof EXAMPLE_BOARD)["needs"][number]) => void]>([
    ["title", (need) => (need.title = "Daily build: a different ask")],
    ["ask", (need) => (need.ask = "Now approve the other thing")],
    ["option label", (need) => (need.options![0]!.label = "Approve and ship")],
    ["link url", (need) => (need.links![0]!.url = "https://claude.ai/artifact/other")],
    ["risk", (need) => ((need as Record<string, unknown>).risk = "auth")],
    ["reply", (need) => ((need as Record<string, unknown>).reply = "text")],
    ["option text", (need) => ((need.options![1] as Record<string, unknown>).text = true)],
  ])("409s a reply to a card whose %s changed", async (_field, edit) => {
    const rev = await revOf(server.base, cookie, "pr2022-checkout");
    await putBoard(server.base, changed(edit));
    expect(await revOf(server.base, cookie, "pr2022-checkout")).not.toBe(rev);
    const response = await postReply({ clientId: "client-rev-1", itemId: "pr2022-checkout", decision: "reject", text: "Fix the jump", rev });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "this card changed; look again" });
  });

  it("409s a Done on a todo card whose steps changed, order included", async () => {
    const todo = (steps: string[]) => {
      const board = structuredClone(EXAMPLE_BOARD) as typeof EXAMPLE_BOARD & { needs: Record<string, unknown>[] };
      board.needs.push({ id: "tax", kind: "todo", title: "Add the tax form", steps });
      return board;
    };
    await putBoard(server.base, todo(["Sign in", "Open Agreements"]));
    const rev = await revOf(server.base, cookie, "tax");
    await putBoard(server.base, todo(["Open Agreements", "Sign in"]));
    expect(await revOf(server.base, cookie, "tax")).not.toBe(rev);
    await putBoard(server.base, todo(["Sign in", "Open Tax Forms"]));
    expect(await revOf(server.base, cookie, "tax")).not.toBe(rev);
    const response = await postReply({ clientId: "client-rev-todo", itemId: "tax", decision: "done", rev });
    expect(response.status).toBe(409);
  });

  it("requires a rev", async () => {
    const response = await fetch(`${server.base}/api/replies`, {
      method: "POST",
      headers: browser(cookie),
      body: JSON.stringify({ clientId: "client-rev-2", itemId: "pr2022-checkout", decision: "reject", text: "Fix the jump" }),
    });
    expect(response.status).toBe(400);
  });

  it("idempotency compares the whole answer", async () => {
    const rev = await revOf(server.base, cookie, "pr2022-checkout");
    const body = { clientId: "client-idem-1", itemId: "pr2022-checkout", decision: "choice", choice: "Approve and merge", text: "yes", rev };
    const first = (await (await postReply(body)).json()) as { id: string; rev: string };
    expect(first.rev).toBe(rev);

    const retry = await postReply({ ...body, text: "  yes  " });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { id: string }).id).toBe(first.id);

    for (const change of [
      { itemId: "billing-retry" },
      { decision: "reject", choice: undefined },
      { choice: "Send changes (write them below)" },
      { text: "no" },
      { text: undefined },
      { rev: "0123456789abcdef" },
    ]) {
      const response = await postReply({ ...body, ...change });
      expect(response.status, JSON.stringify(change)).toBe(409);
    }
  });
});

describe("GET /api/replies/:id", () => {
  it("returns the record to the board token or a session, 404 when unknown", async () => {
    await putBoard(server.base, REPLY_BOARD);
    const created = (await (await postReply({ clientId: "client-get-1", itemId: "pr105-touch", decision: "approve" })).json()) as { id: string };

    const byToken = await fetch(`${server.base}/api/replies/${created.id}`, { headers: bearer(BOARD_TOKEN) });
    expect(byToken.status).toBe(200);
    expect(await byToken.json()).toMatchObject({ id: created.id, itemId: "pr105-touch", decision: "approve", handled: false });
    expect((await fetch(`${server.base}/api/replies/${created.id}`, { headers: { cookie } })).status).toBe(200);

    expect((await fetch(`${server.base}/api/replies/${created.id}`)).status).toBe(401);
    expect((await fetch(`${server.base}/api/replies/${created.id}`, { headers: bearer(BRIDGE_TOKEN) })).status).toBe(401);
    expect((await fetch(`${server.base}/api/replies/00000000-0000-0000-0000-000000000000`, { headers: bearer(BOARD_TOKEN) })).status).toBe(404);
    expect((await fetch(`${server.base}/api/replies/..`, { headers: bearer(BOARD_TOKEN) })).status).toBe(404);
    // A malformed escape is an unknown id, not a server fault.
    const garbled = await fetch(`${server.base}/api/replies/%E0`, { headers: bearer(BOARD_TOKEN) });
    expect(garbled.status).toBe(404);
    expect(await garbled.json()).toEqual({ error: "no such reply" });
  });
});

describe("reply listing and the handled fallback", () => {
  it("lists only the named cards' answers with ?item=, however many others came after (the regions job)", async () => {
    await putBoard(server.base);
    const mine = (await (await postReply({ clientId: "client-item-1", itemId: "pr2022-checkout", decision: "reject", text: "Fix the jump" })).json()) as { id: string };
    for (let i = 0; i < 3; i++) await postReply({ clientId: `client-item-other-${i}`, itemId: "billing-retry", decision: "approve" });
    const list = async (query: string) => fetch(`${server.base}/api/replies?${query}`, { headers: bearer(BOARD_TOKEN) });
    const res = await list("limit=1&item=pr2022-checkout&item=nothing-here");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { replies: { id: string }[] }).replies.map((r) => r.id)).toEqual([mine.id]);
    expect((await list("item=..")).status).toBe(400);
    expect((await list(Array.from({ length: 101 }, (_, i) => `item=card-${i}`).join("&"))).status).toBe(400);
  });

  it("lists unhandled replies for the board token and marks them handled", async () => {
    await putBoard(server.base);
    const created = (await (await postReply({ clientId: "client-0020", itemId: "pr2022-checkout", decision: "reject", text: "Fix the jump" })).json()) as { id: string };

    const unhandled = await fetch(`${server.base}/api/replies?handled=false&limit=10`, { headers: bearer(BOARD_TOKEN) });
    expect(unhandled.status).toBe(200);
    expect(((await unhandled.json()) as { replies: { id: string }[] }).replies.map((r) => r.id)).toEqual([created.id]);

    expect((await fetch(`${server.base}/api/replies`, { headers: bearer(BRIDGE_TOKEN) })).status).toBe(401);
    expect((await fetch(`${server.base}/api/replies/${created.id}/handled`, { method: "POST", headers: browser(cookie) })).status).toBe(401);

    const handled = await fetch(`${server.base}/api/replies/${created.id}/handled`, { method: "POST", headers: bearer(BOARD_TOKEN) });
    expect(handled.status).toBe(200);
    expect(await handled.json()).toMatchObject({ id: created.id, handled: true });

    const after = (await (await fetch(`${server.base}/api/replies?handled=false`, { headers: bearer(BOARD_TOKEN) })).json()) as { replies: unknown[] };
    expect(after.replies).toEqual([]);
    expect((await fetch(`${server.base}/api/replies/nope/handled`, { method: "POST", headers: bearer(BOARD_TOKEN) })).status).toBe(404);
    expect((await fetch(`${server.base}/api/replies/%E0/handled`, { method: "POST", headers: bearer(BOARD_TOKEN) })).status).toBe(404);
  });

  it("lists with ?acted=false the answers handled but not yet acted on, under the same token rules", async () => {
    await putBoard(server.base);
    const created = (await (await postReply({ clientId: "client-0021", itemId: "pr2022-checkout", decision: "reject", text: "Fix the jump" })).json()) as { id: string };
    const unacted = async () =>
      ((await (await fetch(`${server.base}/api/replies?acted=false`, { headers: bearer(BOARD_TOKEN) })).json()) as { replies: { id: string }[] }).replies.map((r) => r.id);
    expect(await unacted()).toEqual([]);
    expect((await fetch(`${server.base}/api/replies?acted=false`, { headers: bearer(BRIDGE_TOKEN) })).status).toBe(401);
    expect((await fetch(`${server.base}/api/replies?acted=false`, { headers: browser(cookie) })).status).toBe(200);
    const handled = (await (await fetch(`${server.base}/api/replies/${created.id}/handled`, { method: "POST", headers: bearer(BOARD_TOKEN) })).json()) as { actedAt?: string };
    expect(typeof handled.actedAt).toBe("string");
    expect(await unacted()).toEqual([]);
  });
});

describe("token routes without tokens", () => {
  it("answer 503 when the token is unset", async () => {
    const bare = await startServer({ RIVET_BOARD_TOKEN: "", RIVET_BRIDGE_TOKEN: "", RIVET_ENROLL_TOKEN: "" });
    try {
      expect((await putBoard(bare.base)).status).toBe(503);
      expect((await fetch(`${bare.base}/api/replies/x/handled`, { method: "POST", headers: bearer(BOARD_TOKEN) })).status).toBe(503);
      expect((await fetch(`${bare.base}/api/bridge/events`, { headers: bearer(BRIDGE_TOKEN) })).status).toBe(503);
      expect((await fetch(`${bare.base}/api/bridge/ack`, { method: "POST", headers: bearer(BRIDGE_TOKEN), body: "{}" })).status).toBe(503);
      const enrol = await fetch(`${bare.base}/api/auth/register/options`, {
        method: "POST",
        headers: browser(""),
        body: JSON.stringify({ code: ENROLL_TOKEN }),
      });
      expect(enrol.status).toBe(503);
    } finally {
      await bare.close();
    }
  });
});

describe("session cookie", () => {
  it("is __Host-, HttpOnly, Secure, SameSite=Strict, Path=/ and 30 days", () => {
    const cookieHeader = sessionCookie("abc");
    expect(cookieHeader.startsWith("__Host-rivet=abc;")).toBe(true);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=2592000"]) {
      expect(cookieHeader).toContain(flag);
    }
    expect(cookieHeader).not.toMatch(/Domain=/i);
  });

  it("logout clears it with the same flags and ends the session", async () => {
    const response = await fetch(`${server.base}/api/auth/logout`, { method: "POST", headers: browser(cookie), body: "{}" });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBe(clearedSessionCookie());
    expect(await (await fetch(`${server.base}/api/me`, { headers: { cookie } })).json()).toEqual({ signedIn: false });
  });
});

describe("passkey boundary", () => {
  const registerOptions = (headers: Record<string, string>, body: unknown = {}) =>
    fetch(`${server.base}/api/auth/register/options`, { method: "POST", headers, body: JSON.stringify(body) });

  it("refuses registration without an enrol token, session or device code", async () => {
    expect((await registerOptions(browser(""))).status).toBe(401);
    expect((await registerOptions(browser(""), { code: "f".repeat(64) })).status).toBe(403);
    expect((await registerOptions(browser(""), { code: "ABCDEFGH" })).status).toBe(403);
  });

  it("offers registration for the unspent enrol token, a session and a fresh device code", async () => {
    const enrol = await registerOptions(browser(""), { code: ENROLL_TOKEN });
    expect(enrol.status).toBe(200);
    const body = (await enrol.json()) as { flowId: string; options: { rp: { id: string }; authenticatorSelection: Record<string, string> } };
    expect(body.flowId).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(body.options.rp.id).toBe("localhost");
    expect(body.options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });

    expect((await registerOptions(browser(cookie))).status).toBe(200);

    const device = await fetch(`${server.base}/api/auth/device-code`, { method: "POST", headers: browser(cookie), body: "{}" });
    expect(device.status).toBe(200);
    const { code } = (await device.json()) as { code: string };
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect((await registerOptions(browser(""), { code })).status).toBe(200);
    expect((await registerOptions(browser(""), { code: code.toLowerCase() })).status).toBe(200);
  });

  it("refuses a spent enrol token", async () => {
    server.app.store.spendEnrollToken((await import("../src/server/config.js")).sha256(ENROLL_TOKEN).toString("hex"));
    expect((await registerOptions(browser(""), { code: ENROLL_TOKEN })).status).toBe(403);
  });

  it("device codes need a session", async () => {
    const response = await fetch(`${server.base}/api/auth/device-code`, { method: "POST", headers: browser(""), body: "{}" });
    expect(response.status).toBe(401);
  });

  it("login options require user verification and a verify needs a live flow", async () => {
    const options = await fetch(`${server.base}/api/auth/login/options`, { method: "POST", headers: browser(""), body: "{}" });
    expect(options.status).toBe(200);
    expect(((await options.json()) as { options: { userVerification: string } }).options.userVerification).toBe("required");
    const verify = await fetch(`${server.base}/api/auth/login/verify`, {
      method: "POST",
      headers: browser(""),
      body: JSON.stringify({ flowId: "x".repeat(24), response: { id: "abc" } }),
    });
    expect(verify.status).toBe(400);
  });

  it("rate-limits auth routes per client IP", async () => {
    const hit = (ip: string) =>
      fetch(`${server.base}/api/auth/login/options`, { method: "POST", headers: { ...browser(""), "fly-client-ip": ip }, body: "{}" });
    for (let i = 0; i < 30; i += 1) expect((await hit("203.0.113.9")).status).toBe(200);
    expect((await hit("203.0.113.9")).status).toBe(429);
    expect((await hit("203.0.113.10")).status).toBe(200);
  });
});

describe("static files", () => {
  it("serves index.html with no-cache and hashed assets immutably", async () => {
    const index = await fetch(`${server.base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toMatch(/^text\/html/);
    expect(index.headers.get("cache-control")).toBe("no-cache");
    expect(await index.text()).toContain("<title>Rivet</title>");
    const asset = await fetch(`${server.base}/assets/main-abc123.js`);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(asset.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(await asset.text()).toBe("console.log(1)");
  });

  it("falls back to index.html for navigations only", async () => {
    const nav = await fetch(`${server.base}/board`, { headers: { accept: "text/html" } });
    expect(nav.status).toBe(200);
    expect(await nav.text()).toContain("<title>Rivet</title>");
    expect((await fetch(`${server.base}/missing.js`, { headers: { accept: "*/*" } })).status).toBe(404);
    expect((await fetch(`${server.base}/api/nope`, { headers: { accept: "text/html" } })).status).toBe(404);
  });

  it("opens the chat for a share the service worker was not there to keep", async () => {
    const form = new FormData();
    form.append("text", "hello");
    const response = await fetch(`${server.base}/share-target`, { method: "POST", body: form, redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/?tab=chat");
  });

  it.each(["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/..%5csecret.txt", "/%2e%2e%2fdata/rivet.sqlite"])(
    "does not escape the web root via %s",
    async (path) => {
      const response = await rawGet(server.port, path, { accept: "*/*" });
      expect(response.body).not.toContain("top secret");
      expect(response.body).not.toContain("SQLite");
      const nav = await rawGet(server.port, path, { accept: "text/html" });
      expect(nav.body).not.toContain("top secret");
    },
  );
});
