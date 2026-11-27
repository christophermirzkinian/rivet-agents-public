import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearedSessionCookie, sessionCookie } from "../src/server/auth.js";
import { loadConfig, sha256 } from "../src/server/config.js";
import { HANDLED_DROP_MS, needRev, openBoard } from "../src/server/http.js";
import { boardSchema, type Board, type Reply } from "../src/shared/board.js";
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

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

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

  it("records the comparison a merge hold is bound to on a video card's reply, and the links on every card's", async () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(120, 7)]);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 1)]);
    const shaOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    for (const [bytes, type] of [[mp4, "video/mp4"], [png, "image/png"]] as const) {
      const put = await fetch(`${server.base}/api/bridge/media/${shaOf(bytes)}`, { method: "PUT", headers: { ...bearer(BOARD_TOKEN), "content-type": type }, body: new Uint8Array(bytes) });
      expect(put.status).toBe(201);
    }
    const cases = [
      { kind: "video", after: { sha256: shaOf(mp4), type: "video/mp4" } },
      { kind: "stills", stills: [{ sha256: shaOf(png), type: "image/png" }] },
      { kind: "video", before: { sha256: shaOf(mp4), type: "video/mp4" } },
      { kind: "video", before: { sha256: shaOf(png), type: "image/png" }, after: { sha256: shaOf(mp4), type: "video/mp4" } },
      { kind: "video", before: { sha256: shaOf(mp4), type: "video/mp4" }, after: { sha256: shaOf(png), type: "image/png" } },
      undefined,
    ] as const;
    const { validateReply } = (await import("../bridge/lib/validate.mjs" as string)) as { validateReply(reply: unknown): { ok: boolean } };
    for (const [n, media] of cases.entries()) {
      const board = structuredClone(REPLY_BOARD) as Board;
      board.needs[0]!.options = [{ label: "Ship it", recommended: true }, { label: "Change it", text: true }];
      board.needs[0]!.links = [{ label: "PR", url: "https://github.com/example-org/example-repo/pull/41", primary: true }];
      if (media) board.needs[0]!.media = media as never;
      else delete board.needs[0]!.media;
      expect((await putBoard(server.base, board)).status).toBe(200);
      const response = await postReply({ clientId: `client-video-${n}`, itemId: board.needs[0]!.id, decision: "choice", choice: "Ship it" });
      expect(response.status).toBe(201);
      const reply = (await response.json()) as Reply;
      // The comparison a merge hold is bound to, on a card with a video: the after media `+` the before media.
      const m = media as { after?: { sha256: string; type: string }; before?: { sha256: string; type: string } } | undefined;
      const hasVideo = [m?.after, m?.before].some((clip) => clip?.type.startsWith("video/"));
      expect(reply.item.videoSha).toBe(hasVideo ? [m?.after, m?.before].flatMap((clip) => (clip ? [clip.sha256] : [])).join("+") : undefined);
      // Links on every card, as shown: a video card's merge hold may be on a PR only a link names.
      expect(reply.item.links).toEqual([{ label: "PR", url: "https://github.com/example-org/example-repo/pull/41" }]);
      expect(validateReply(reply)).toMatchObject({ ok: true });
      const listed = (await (await fetch(`${server.base}/api/replies?limit=10`, { headers: bearer(BOARD_TOKEN) })).json()) as { replies: Reply[] };
      expect(listed.replies.find((item) => item.id === reply.id)?.item.videoSha).toBe(reply.item.videoSha);
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
      ask: "Its tests are green.",
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
    board.needs.push({ id: "dup-labels", kind: "decision", title: "Which?", ask: "Where does it go?", options: [{ label: "Proceed", detail: "Deploy to production" }, { label: "Proceed", detail: "Deploy to staging only", text: true }] });
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

  it("on a card answered in its chat with a note rule, a pick with a note is refused whatever app sent it, then the pick or the note alone is the one answer (a-12)", async () => {
    const card = { id: "in-chat-note", kind: "decision", title: "T", ask: "A", options: [{ label: "Send" }, { label: "Not now" }], inChat: { label: "To the team", noted: "Not sent." } };
    const withCard = (id: string) => server.app.store.putBoard(boardSchema.parse({ ...REPLY_BOARD, needs: [{ ...card, id }] }), null);
    withCard("in-chat-note");
    expect((await postReply({ clientId: "client-noted-1", itemId: "in-chat-note", decision: "choice", choice: "Send", text: "Not like this" })).status).toBe(400);
    expect((await postReply({ clientId: "client-noted-2", itemId: "in-chat-note", decision: "comment", text: "Not like this" })).status).toBe(201);
    // The note came first: a Send after it, from this device or another, is refused.
    const late = await postReply({ clientId: "client-noted-3", itemId: "in-chat-note", decision: "choice", choice: "Send" });
    expect([late.status, ((await late.json()) as { answered: Reply }).answered.decision]).toEqual([409, "comment"]);
    withCard("in-chat-pick");
    expect((await postReply({ clientId: "client-noted-4", itemId: "in-chat-pick", decision: "choice", choice: "Send" })).status).toBe(201);
    for (const [n, after] of [{ decision: "comment", text: "Wait" }, { decision: "choice", choice: "Send" }, { decision: "choice", choice: "Not now" }].entries()) {
      expect((await postReply({ clientId: `client-noted-5${n}`, itemId: "in-chat-pick", ...after })).status).toBe(409);
    }
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

  describe("a comment on a card waiting on your pick", () => {
    const pick = { id: "pick-1", kind: "decision", title: "Which layout?", ask: "A or B?", options: [{ label: "A" }, { label: "B" }] };
    const asked = { id: "ask-1", kind: "question", title: "What colour?", ask: "Say a colour." };
    const gotIt = { id: "news-1", kind: "decision", title: "Shipped", options: [{ label: "Got it" }] };
    const stored = (id: string) => server.app.store.getBoard()!.board.needs.find((need) => need.id === id)!;
    const open = () => openBoard(server.app.store, { failing: () => [] }, server.app.store.getBoard()!.board, new Date())!.needs.map((need) => need.id);
    const note = (id: string, text: string) => fetch(`${server.base}/api/board/needs/${id}/comments`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ text }) });

    beforeEach(() => {
      server.app.store.putBoard(boardSchema.parse({ ...REPLY_BOARD, needs: [pick, asked, gotIt] }), null);
    });

    it("answers a card with options: it leaves Needs you, and a pick or a second comment at that rev is refused with the comment", async () => {
      const rev = await revOf(server.base, cookie, "pick-1");
      expect(open()).toEqual(["pick-1", "ask-1"]);
      expect((await postReply({ clientId: "client-pick-c1", itemId: "pick-1", decision: "comment", text: "Why A?", rev })).status).toBe(201);
      expect(open()).toEqual(["ask-1"]);
      // Your comment is your line in Chat, never a line under the card, and the card's revision stays.
      expect(stored("pick-1").comments).toBeUndefined();
      expect(await revOf(server.base, cookie, "pick-1")).toBe(rev);
      for (const late of [
        await postReply({ clientId: "client-pick-a", itemId: "pick-1", decision: "choice", choice: "A", rev }),
        await postReply({ clientId: "client-pick-c2", itemId: "pick-1", decision: "comment", text: "And B?", rev }),
      ]) {
        expect(late.status).toBe(409);
        expect(await late.json()).toMatchObject({ error: "This card was already answered.", answered: { decision: "comment", text: "Why A?" } });
      }
      expect(open()).toEqual(["ask-1"]);
    });

    it("Answer again after a comment puts the card back, and the pick lands as a change of the comment", async () => {
      const rev = await revOf(server.base, cookie, "pick-1");
      const comment = (await (await postReply({ clientId: "client-again-c", itemId: "pick-1", decision: "comment", text: "Why A?", rev })).json()) as Reply;
      const stream = await connectBridge("image,chat-window,changes");
      const opened = await fetch(`${server.base}/api/board/needs/pick-1/again`, { method: "POST", headers: browser(cookie), body: JSON.stringify({ rev }) });
      expect(opened.status).toBe(200);
      const { item } = (await opened.json()) as { item: { rev: string; again: unknown } };
      expect(item.again).toMatchObject({ n: 1, after: comment.id });
      expect(item.rev).not.toBe(rev);
      expect(server.app.store.latestReopens(["pick-1"]).get("pick-1")).toMatchObject({ replyId: comment.id });
      expect(open()).toEqual(["pick-1", "ask-1"]);
      const picked = await postReply({ clientId: "client-again-p", itemId: "pick-1", decision: "choice", choice: "A", rev: item.rev });
      expect(picked.status).toBe(201);
      expect(((await picked.json()) as Reply).item.changes).toEqual({ replyId: comment.id, decision: "comment" });
      expect(open()).toEqual(["ask-1"]);
      stream.abort();
    });

    it("still takes a comment as a question card's answer: it leaves Needs you and a second reply is refused", async () => {
      expect((await postReply({ clientId: "client-ask-c1", itemId: "ask-1", decision: "comment", text: "Blue" })).status).toBe(201);
      expect(open()).toEqual(["pick-1"]);
      const second = await postReply({ clientId: "client-ask-c2", itemId: "ask-1", decision: "comment", text: "Or green" });
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ error: "This card was already answered.", answered: { decision: "comment", text: "Blue" } });
    });

    it("takes Rivet's line under a choice card and a question card at the same rev, and refuses a Got it card", async () => {
      for (const id of ["pick-1", "ask-1"]) {
        const rev = await revOf(server.base, cookie, id);
        const res = await note(id, "Both fit the phone");
        expect(res.status, id).toBe(201);
        expect(((await res.json()) as { item: { comments: unknown[] } }).item.comments).toEqual([expect.objectContaining({ from: "rivet", text: "Both fit the phone" })]);
        expect(await revOf(server.base, cookie, id), id).toBe(rev);
      }
      expect(open()).toEqual(["pick-1", "ask-1"]);
      const refused = await note("news-1", "x");
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: "card news-1 is a Got it card: answer in its chat" });
      expect(stored("news-1").comments).toBeUndefined();
    });

    it("lets no board write add or drop the lines under a card that is not an update card", async () => {
      expect((await note("pick-1", "Both fit the phone")).status).toBe(201);
      const kept = stored("pick-1").comments;
      expect(kept).toHaveLength(1);
      const forged = [{ from: "owner", text: "I picked B", at: "2026-10-05T00:00:00.000Z" }];
      const write = (comments?: unknown) => putBoard(server.base, { ...REPLY_BOARD, needs: [{ ...pick, ...(comments ? { comments } : {}) }, { ...asked, ...(comments ? { comments } : {}) }] });
      expect((await write()).status).toBe(200);
      expect(stored("pick-1").comments).toEqual(kept);
      expect((await write(forged)).status).toBe(200);
      expect(stored("pick-1").comments).toEqual(kept);
      expect(stored("ask-1").comments).toBeUndefined();
    });

    const again = (rev: string) => fetch(`${server.base}/api/board/needs/pick-1/again`, { method: "POST", headers: browser(cookie), body: JSON.stringify({ rev }) });

    it("takes the pick recorded after a comment at one revision, from when a comment left the card open, as its answer of record", async () => {
      const rev = await revOf(server.base, cookie, "pick-1");
      const card = { id: "pick-1", title: pick.title, kind: "decision" } as const;
      server.app.store.addReply({ clientId: "client-then-comment", itemId: "pick-1", itemTitle: pick.title, decision: "comment", text: "Why A?", rev, item: card });
      const picked = server.app.store.addReply({ clientId: "client-then-pick", itemId: "pick-1", itemTitle: pick.title, decision: "choice", choice: "A", rev, item: card });
      // A further answer is refused with the pick, not the comment before it.
      const refused = await postReply({ clientId: "client-then-late", itemId: "pick-1", decision: "choice", choice: "B", rev });
      expect([refused.status, ((await refused.json()) as { answered: Reply }).answered.id]).toEqual([409, picked.id]);
      // Answer again withdraws the pick, and the next answer changes it.
      const stream = await connectBridge("image,chat-window,changes");
      const opened = await again(rev);
      expect([opened.status, ((await opened.json()) as { item: { again: { after: string } } }).item.again.after]).toEqual([200, picked.id]);
      expect(server.app.store.latestReopens(["pick-1"]).get("pick-1")).toMatchObject({ replyId: picked.id });
      const changed = (await (await postReply({ clientId: "client-then-changed", itemId: "pick-1", decision: "choice", choice: "B" })).json()) as Reply;
      expect(changed.item.changes).toEqual({ replyId: picked.id, decision: "choice", choice: "A" });
      expect(server.app.store.cardAnswer("pick-1", pick.title, "2026-01-01T00:00:00.000Z")?.id).toBe(changed.id);
      stream.abort();
    });

    it("keeps as answered, at the next start, a card whose comment kept nothing while a comment left it open", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "rivet-kept-"));
      let clock = new Date();
      const boot = async () => {
        await server.close();
        server = await startServer({ RIVET_DATA_DIR: dataDir }, { now: () => clock });
        cookie = server.cookie();
      };
      await boot();
      server.app.store.putBoard(boardSchema.parse({ ...REPLY_BOARD, needs: [pick, asked] }), null);
      const rev = needRev(stored("pick-1"));
      const comment = server.app.store.addReply({ clientId: "client-kept-nothing", itemId: "pick-1", itemTitle: pick.title, decision: "comment", text: "Why A?", rev, item: stored("pick-1") });
      server.app.store.markHandled(comment.id);
      expect(server.app.store.keptAnsweredCard("pick-1")).toBeNull();

      await boot();
      const kept = server.app.store.keptAnsweredCard("pick-1");
      expect(kept).toMatchObject({ rev, replyId: comment.id, answeredAt: comment.at });
      expect(server.app.store.keptAnsweredCard("ask-1")).toBeNull();
      const answered = (await (await fetch(`${server.base}/api/answered`, { headers: { cookie } })).json()) as { cards: { card: { id: string } }[] };
      expect(answered.cards.map(({ card }) => card.id)).toEqual(["pick-1"]);
      // Another start changes nothing.
      await boot();
      expect(server.app.store.keptAnsweredCard("pick-1")).toEqual(kept);

      // Once its handled comment takes it off the board, Answer again still finds it.
      clock = new Date(clock.getTime() + HANDLED_DROP_MS + 60_000);
      const served = (await (await fetch(`${server.base}/api/board`, { headers: { authorization: `Bearer ${BOARD_TOKEN}` } })).json()) as { board: Board };
      expect((await putBoard(server.base, served.board)).status).toBe(200);
      expect(server.app.store.getBoard()!.board.needs.map((need) => need.id)).toEqual(["ask-1"]);
      const stream = await connectBridge("image,chat-window,changes");
      expect((await again(rev)).status).toBe(200);
      expect(server.app.store.getBoard()!.board.needs.map((need) => need.id)).toEqual(["ask-1", "pick-1"]);
      stream.abort();
      rmSync(dataDir, { recursive: true, force: true });
    });

    it("at the next start makes such a card its ask's card, and puts its comment in place of an answer kept at an earlier revision only", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "rivet-kept-"));
      const boot = async () => {
        await server.close();
        server = await startServer({ RIVET_DATA_DIR: dataDir });
        cookie = server.cookie();
      };
      await boot();
      const asks = (id: string) => fetch(`${server.base}/api/asks`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ id, words: `Layout ${id}`, stage: "building" }) });
      expect([(await asks("a-linked")).status, (await asks("a-newer")).status]).toEqual([201, 201]);
      const card = (id: string, askId?: string) => ({ ...pick, id, title: `Layout ${id}`, ...(askId ? { askId } : {}) });
      server.app.store.putBoard(boardSchema.parse({ ...REPLY_BOARD, needs: [card("pick-linked", "a-linked"), card("pick-older"), card("pick-same"), card("pick-newer", "a-newer")] }), null);
      const comment = (id: string, rev = needRev(stored(id))) =>
        server.app.store.addReply({ clientId: `client-${id}-${rev}`, itemId: id, itemTitle: stored(id).title, decision: "comment", text: "Why A?", rev, item: stored(id) });
      const comments = Object.fromEntries(["pick-linked", "pick-older", "pick-same", "pick-newer"].map((id) => [id, comment(id)]));
      const before = new Date(Date.now() - 3_600_000).toISOString();
      const after = new Date(Date.now() + 3_600_000).toISOString();
      // Kept at an earlier revision, at this one before its comment, and at another one after it.
      const earlier = comment("pick-older", "rev-earlier");
      server.app.store.keepAnswered(stored("pick-older"), "rev-earlier", earlier.id, before);
      server.app.store.keepAnswered(stored("pick-same"), needRev(stored("pick-same")), comments["pick-same"]!.id, before);
      const later = comment("pick-newer", "rev-later");
      server.app.store.keepAnswered(stored("pick-newer"), "rev-later", later.id, after);

      await boot();
      const kept = (id: string) => server.app.store.keptAnsweredCard(id);
      expect(kept("pick-linked")).toMatchObject({ replyId: comments["pick-linked"]!.id });
      expect(server.app.store.getAsk("a-linked")?.cardId).toBe("pick-linked");
      expect(kept("pick-older")).toMatchObject({ rev: needRev(stored("pick-older")), replyId: comments["pick-older"]!.id, answeredAt: comments["pick-older"]!.at });
      expect(kept("pick-same")).toMatchObject({ replyId: comments["pick-same"]!.id, answeredAt: before });
      expect(kept("pick-newer")).toMatchObject({ rev: "rev-later", replyId: later.id, answeredAt: after });
      expect(server.app.store.getAsk("a-newer")?.cardId).toBeUndefined();
      rmSync(dataDir, { recursive: true, force: true });
    });
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

describe("device session", () => {
  const post = (to: TestServer, code: unknown, headers = browser("")) =>
    fetch(`${to.base}/api/auth/device-session`, { method: "POST", headers, body: JSON.stringify(code === undefined ? {} : { code }) });
  const newCode = async (to: TestServer) =>
    ((await (await fetch(`${to.base}/api/auth/device-code`, { method: "POST", headers: browser(to.cookie()), body: "{}" })).json()) as { code: string }).code;
  const madeByCode = (to: TestServer): number => {
    const db = new DatabaseSync(join(to.dataDir, "rivet.sqlite"));
    const row = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE via = 'device-code'").get() as { n: number };
    db.close();
    return row.n;
  };
  let on: TestServer;

  beforeEach(async () => {
    on = await startServer({ RIVET_DEVICE_SESSION: "on" });
  });

  afterEach(async () => {
    await on.close();
  });

  it("is on only for the value on, exactly", () => {
    for (const value of [undefined, "", "1", "true", "ON", " on", "on "]) expect(loadConfig({ RIVET_DEVICE_SESSION: value }).deviceSession).toBe(false);
    expect(loadConfig({ RIVET_DEVICE_SESSION: "on" }).deviceSession).toBe(true);
  });

  it("off: the route is an unknown auth route, a good code is not spent, and /api/me offers nothing", async () => {
    const code = await newCode(server);
    const off = await post(server, code);
    const unknown = await fetch(`${server.base}/api/auth/nope`, { method: "POST", headers: browser(""), body: JSON.stringify({ code }) });
    expect(off.status).toBe(404);
    expect(off.headers.get("set-cookie")).toBeNull();
    expect(await off.json()).toEqual(await unknown.json());
    expect((await fetch(`${server.base}/api/auth/device-session`, { headers: browser("") })).status).toBe(405);
    expect((await post(server, code, { ...browser(""), origin: "https://evil.example" })).status).toBe(403);
    expect(await (await fetch(`${server.base}/api/me`)).json()).toEqual({ signedIn: false });
    expect(await (await fetch(`${server.base}/api/me`, { headers: { cookie } })).json()).toEqual({ signedIn: true });
    expect(server.app.store.isDeviceCodeValid(sha256(code).toString("hex"))).toBe(true);
  });

  it("on: /api/me offers it, and a good code gives a working session and is spent", async () => {
    expect(await (await fetch(`${on.base}/api/me`)).json()).toEqual({ signedIn: false, deviceSession: true });
    const code = await newCode(on);
    const response = await post(on, ` ${code.toLowerCase()} `);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^__Host-rivet=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict$/);
    const made = setCookie.split(";")[0]!;
    expect(await (await fetch(`${on.base}/api/me`, { headers: { cookie: made } })).json()).toEqual({ signedIn: true, deviceSession: true, deviceSessions: 1, via: "device-code" });
    expect(await (await fetch(`${on.base}/api/me`, { headers: { cookie: on.cookie() } })).json()).toEqual({ signedIn: true, deviceSession: true, deviceSessions: 1 });
    expect(await (await fetch(`${on.base}/api/me`)).json()).toEqual({ signedIn: false, deviceSession: true });
    expect((await fetch(`${on.base}/api/board`, { headers: { cookie: made } })).status).not.toBe(401);
    expect(madeByCode(on)).toBe(1);

    const again = await post(on, code);
    expect(again.status).toBe(403);
    expect(again.headers.get("set-cookie")).toBeNull();
    expect(await again.json()).toMatchObject({ error: "that code is not valid or has expired" });
    const enrol = await fetch(`${on.base}/api/auth/register/options`, { method: "POST", headers: browser(""), body: JSON.stringify({ code }) });
    expect(enrol.status).toBe(403);
    expect(madeByCode(on)).toBe(1);
  });

  it("refuses an expired code, a wrong code and no code", async () => {
    on.app.store.addDeviceCode(sha256("ABCDEFGH").toString("hex"), -1000);
    for (const code of ["ABCDEFGH", "ZZZZ2222", "ABCDEFG", "ABCDEFGHJ", "ABCD EFG", "x".repeat(200)]) {
      const response = await post(on, code);
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.json()).toMatchObject({ error: "that code is not valid or has expired" });
    }
    for (const code of [undefined, "", 12345678, "x".repeat(201)]) expect((await post(on, code)).status).toBe(400);
    expect(madeByCode(on)).toBe(0);
  });

  it("refuses the enrolment token, which stays unspent, even one shaped like a device code", async () => {
    const response = await post(on, ENROLL_TOKEN);
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
    const enrol = await fetch(`${on.base}/api/auth/register/options`, { method: "POST", headers: browser(""), body: JSON.stringify({ code: ENROLL_TOKEN }) });
    expect(enrol.status).toBe(200);

    const short = await startServer({ RIVET_DEVICE_SESSION: "on", RIVET_ENROLL_TOKEN: "ABCD2345" });
    try {
      expect((await post(short, "ABCD2345")).status).toBe(403);
      expect((await post(short, "abcd2345")).status).toBe(403);
      expect(madeByCode(short)).toBe(0);
    } finally {
      await short.close();
    }
  });

  it("refuses a cross-origin post, and the code is not spent", async () => {
    const code = await newCode(on);
    const noOrigin = { "x-rivet": "1", "content-type": "application/json" };
    const noMark = { origin: ORIGIN, "content-type": "application/json" };
    for (const headers of [{ ...browser(""), origin: "https://evil.example" }, noOrigin, noMark]) {
      const response = await post(on, code, headers);
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.json()).toMatchObject({ error: "cross-origin request refused" });
    }
    expect((await post(on, code)).status).toBe(200);
  });

  it("counts toward the auth rate limit per client IP", async () => {
    const code = await newCode(on);
    const hit = (ip: string, value: string) => post(on, value, { ...browser(""), "fly-client-ip": ip });
    for (let i = 0; i < 30; i += 1) expect((await hit("203.0.113.9", "not-a-code")).status).toBe(403);
    expect((await hit("203.0.113.9", code)).status).toBe(429);
    expect(on.app.store.isDeviceCodeValid(sha256(code).toString("hex"))).toBe(true);
    expect((await hit("203.0.113.10", code)).status).toBe(200);
  });

  const enrolWith = (to: TestServer, code: string) =>
    fetch(`${to.base}/api/auth/register/options`, { method: "POST", headers: browser(""), body: JSON.stringify({ code }) });
  const misses = (to: TestServer): number[] => {
    const db = new DatabaseSync(join(to.dataDir, "rivet.sqlite"));
    const rows = db.prepare("SELECT misses FROM device_codes ORDER BY created_at").all() as { misses: number }[];
    db.close();
    return rows.map((row) => row.misses);
  };

  it("voids every live code after 5 wrong guesses, for a code alone and for a passkey's set-up", async () => {
    const first = await newCode(on);
    const second = await newCode(on);
    for (let i = 0; i < 4; i += 1) expect((await post(on, "ZZZZ2222")).status).toBe(403);
    expect((await enrolWith(on, first)).status).toBe(200);
    expect((await post(on, "zzzz3333")).status).toBe(403);
    expect(misses(on)).toEqual([5, 5]);
    expect((await enrolWith(on, first)).status).toBe(403);
    expect((await enrolWith(on, second)).status).toBe(403);
    const refused = await post(on, first);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect((await post(on, second)).status).toBe(403);
    expect(madeByCode(on)).toBe(0);
    // A code made after the guesses starts clean.
    expect((await post(on, await newCode(on))).status).toBe(200);
  });

  it("takes the right code after 4 wrong guesses, and a guess of the wrong shape costs nothing", async () => {
    const code = await newCode(on);
    for (const guess of ["ZZZZ222", "ZZZZ22223", "ZZZZ-222", "", "   ", 12345678]) expect([400, 403]).toContain((await post(on, guess)).status);
    // 8 letters and digits, but with one no code is made from (I L O U 0 1): never right, so no miss.
    for (const guess of ["ZZZZ0000", "ABCD1O23", "illouuuu", "ZZZZ222I", "zzzz222l", "OZZZ2222", "ZZZU2222", "ZZZZ2220", "1ZZZ2222"]) expect((await post(on, guess)).status).toBe(403);
    for (let i = 0; i < 30; i += 1) await post(on, "nope", { ...browser(""), "fly-client-ip": `198.51.100.${i}` });
    expect(misses(on)).toEqual([0]);
    for (let i = 0; i < 4; i += 1) expect((await post(on, "ZZZZ2222")).status).toBe(403);
    expect(misses(on)).toEqual([4]);
    expect((await post(on, code)).status).toBe(200);
  });

  it("counts a wrong guess at a passkey's set-up too, so that route is no free place to test a code; not while the switch is off", async () => {
    const code = await newCode(on);
    for (const guess of ["ZZZZ222", "not-a-code"]) expect([403, 503]).toContain((await enrolWith(on, guess)).status);
    for (const guess of ["ZZZZ0000", "abcd1o23", "ZZZZ222I", "zzzz222l", "OZZZ2222", "ZZZU2222"]) expect((await enrolWith(on, guess)).status).toBe(403);
    expect(misses(on)).toEqual([0]);
    for (let i = 0; i < 3; i += 1) expect((await enrolWith(on, "ZZZZ2222")).status).toBe(403);
    expect((await enrolWith(on, code)).status).toBe(200);
    expect(misses(on)).toEqual([3]);
    for (let i = 0; i < 2; i += 1) expect((await post(on, "ZZZZ2222")).status).toBe(403);
    expect((await post(on, code)).status).toBe(403);
    expect(madeByCode(on)).toBe(0);
    await newCode(server);
    for (let i = 0; i < 6; i += 1) expect((await enrolWith(server, "ZZZZ2222")).status).toBe(403);
    expect(misses(server)).toEqual([0]);
  });

  it("adds up wrong guesses from different addresses", async () => {
    const code = await newCode(on);
    for (let i = 0; i < 5; i += 1) expect((await post(on, "ZZZZ2222", { ...browser(""), "fly-client-ip": `203.0.113.${i + 1}` })).status).toBe(403);
    expect((await post(on, code, { ...browser(""), "fly-client-ip": "203.0.113.99" })).status).toBe(403);
    expect(madeByCode(on)).toBe(0);
  });

  it("counts a used code and an expired one against the codes still live, and nothing while the switch is off", async () => {
    const spent = await newCode(on);
    const live = await newCode(on);
    expect((await post(on, spent)).status).toBe(200);
    expect((await post(on, spent)).status).toBe(403);
    on.app.store.addDeviceCode(sha256("EXPD2345").toString("hex"), -1);
    expect((await post(on, "EXPD2345")).status).toBe(403);
    expect(misses(on).sort()).toEqual([0, 0, 2]);
    expect(on.app.store.isDeviceCodeValid(sha256(live).toString("hex"))).toBe(true);

    const code = await newCode(server);
    for (let i = 0; i < 6; i += 1) expect((await post(server, "ZZZZ2222")).status).toBe(404);
    for (let i = 0; i < 6; i += 1) expect((await enrolWith(server, "ZZZZ2222")).status).toBe(403);
    expect(misses(server)).toEqual([0]);
    expect((await enrolWith(server, code)).status).toBe(200);
  });

  it("still gives one session to two posts at once after wrong guesses, and none once the code is void", async () => {
    const code = await newCode(on);
    for (let i = 0; i < 4; i += 1) await post(on, "ZZZZ2222");
    const responses = await Promise.all([post(on, code), post(on, code)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
    expect(responses.filter((response) => response.headers.get("set-cookie") !== null)).toHaveLength(1);
    expect(madeByCode(on)).toBe(1);

    const next = await newCode(on);
    for (let i = 0; i < 5; i += 1) await post(on, "ZZZZ2222");
    const late = await Promise.all([post(on, next), post(on, next)]);
    expect(late.map((response) => response.status)).toEqual([403, 403]);
    expect(madeByCode(on)).toBe(1);
  });

  describe("signing the desktop apps out", () => {
    const revoke = (to: TestServer, headers: Record<string, string>) => fetch(`${to.base}/api/auth/device-sessions/revoke`, { method: "POST", headers, body: "{}" });
    const byCode = async (to: TestServer) => (await post(to, await newCode(to))).headers.get("set-cookie")!.split(";")[0]!;
    const signedIn = async (to: TestServer, value: string) => ((await (await fetch(`${to.base}/api/me`, { headers: { cookie: value } })).json()) as { signedIn: boolean }).signedIn;

    it("ends every session a code made at once and leaves a passkey's, for a caller signed in by passkey", async () => {
      const passkey = on.cookie();
      const laptop = await byCode(on);
      const other = await byCode(on);
      expect(await (await fetch(`${on.base}/api/me`, { headers: { cookie: passkey } })).json()).toEqual({ signedIn: true, deviceSession: true, deviceSessions: 2 });

      expect((await revoke(on, browser(""))).status).toBe(401);
      expect((await revoke(on, { ...browser(passkey), origin: "https://evil.example" })).status).toBe(403);
      expect((await revoke(on, { cookie: passkey, origin: ORIGIN, "content-type": "application/json" })).status).toBe(403);
      expect((await fetch(`${on.base}/api/auth/device-sessions/revoke`, { headers: browser(passkey) })).status).toBe(405);
      expect(madeByCode(on)).toBe(2);

      const response = await revoke(on, browser(passkey));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ended: 2 });
      expect(response.headers.get("set-cookie")).toBeNull();
      for (const gone of [laptop, other]) {
        expect(await signedIn(on, gone)).toBe(false);
        expect((await fetch(`${on.base}/api/board`, { headers: { cookie: gone } })).status).toBe(401);
        expect((await fetch(`${on.base}/api/chat/stream`, { headers: { cookie: gone } })).status).toBe(401);
        expect((await revoke(on, browser(gone))).status).toBe(401);
      }
      expect(await (await fetch(`${on.base}/api/me`, { headers: { cookie: passkey } })).json()).toEqual({ signedIn: true, deviceSession: true });
      expect((await fetch(`${on.base}/api/board`, { headers: { cookie: passkey } })).status).not.toBe(401);
      expect(await (await revoke(on, browser(passkey))).json()).toEqual({ ended: 0 });
    });

    it("signs the caller out too when a code made its own session", async () => {
      const passkey = on.cookie();
      const laptop = await byCode(on);
      const response = await revoke(on, browser(laptop));
      expect(await response.json()).toEqual({ ended: 1, signedOut: true });
      expect(response.headers.get("set-cookie")).toBe(clearedSessionCookie());
      expect(await signedIn(on, laptop)).toBe(false);
      expect(await signedIn(on, passkey)).toBe(true);
    });

    it("ends a chat stream such a session left open at the stream's next write, before anything more is sent", async () => {
      const laptop = await byCode(on);
      const controller = new AbortController();
      const stream = await fetch(`${on.base}/api/chat/stream`, { headers: { cookie: laptop }, signal: controller.signal });
      expect(stream.status).toBe(200);
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const ended = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return true;
          text += decoder.decode(value, { stream: true });
        }
      })();
      const say = (words: string) => fetch(`${on.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ text: words, new: true }) });
      expect((await say("before")).status).toBe(201);
      for (let i = 0; i < 100 && !text.includes("before"); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(text).toContain("before");
      expect(await (await revoke(on, browser(on.cookie()))).json()).toEqual({ ended: 1 });
      expect((await say("after the sign-out")).status).toBe(201);
      await expect(Promise.race([ended, new Promise((resolve) => setTimeout(() => resolve("still open"), 2_000))])).resolves.toBe(true);
      expect(text).not.toContain("after the sign-out");
      controller.abort();
    });

    it("works with the switch off, and tells a signed-in caller there are such sessions to end", async () => {
      const value = "c".repeat(43);
      server.app.store.addSession(sha256(value).toString("hex"), 60_000, "device-code");
      const laptop = `__Host-rivet=${value}`;
      expect(await (await fetch(`${server.base}/api/me`, { headers: { cookie: laptop } })).json()).toEqual({ signedIn: true, deviceSessions: 1, via: "device-code" });
      expect(await (await fetch(`${server.base}/api/me`)).json()).toEqual({ signedIn: false });
      expect(await (await fetch(`${server.base}/api/me`, { headers: { cookie } })).json()).toEqual({ signedIn: true, deviceSessions: 1 });
      expect(await (await revoke(server, browser(cookie))).json()).toEqual({ ended: 1 });
      expect(await signedIn(server, laptop)).toBe(false);
      expect(await (await fetch(`${server.base}/api/me`, { headers: { cookie } })).json()).toEqual({ signedIn: true });
    });

    it("voids a code made before it, so the code brings no session back and sets up no passkey", async () => {
      const passkey = on.cookie();
      const laptop = await byCode(on);
      const kept = await newCode(on);
      const spare = await newCode(on);
      expect(await (await revoke(on, browser(passkey))).json()).toEqual({ ended: 1 });
      expect(await signedIn(on, laptop)).toBe(false);
      const back = await post(on, kept);
      expect(back.status).toBe(403);
      expect(back.headers.get("set-cookie")).toBeNull();
      expect((await enrolWith(on, spare)).status).toBe(403);
      expect((await enrolWith(on, kept)).status).toBe(403);
      expect(madeByCode(on)).toBe(0);
      // A code made after it works as any other.
      expect((await post(on, await newCode(on))).status).toBe(200);
    });
  });

  describe("a session a code made is the weaker one", () => {
    const byCode = async (to: TestServer) => (await post(to, await newCode(to))).headers.get("set-cookie")!.split(";")[0]!;
    const mint = (to: TestServer, value: string) => fetch(`${to.base}/api/auth/device-code`, { method: "POST", headers: browser(value), body: "{}" });
    const options = (to: TestServer, value: string, body: unknown = {}) =>
      fetch(`${to.base}/api/auth/register/options`, { method: "POST", headers: browser(value), body: JSON.stringify(body) });
    const rows = (to: TestServer, sql: string): Record<string, unknown>[] => {
      const db = new DatabaseSync(join(to.dataDir, "rivet.sqlite"));
      const found = db.prepare(sql).all() as Record<string, unknown>[];
      db.close();
      return found;
    };

    it("makes no device code, where a passkey's session still does", async () => {
      const laptop = await byCode(on);
      const before = rows(on, "SELECT hash FROM device_codes").length;
      const refused = await mint(on, laptop);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: "sign in with a passkey to add a device" });
      expect(rows(on, "SELECT hash FROM device_codes")).toHaveLength(before);
      expect((await mint(on, on.cookie())).status).toBe(200);
      // Switch off, with such a session left over: the same.
      const value = "c".repeat(43);
      server.app.store.addSession(sha256(value).toString("hex"), 60_000, "device-code");
      expect((await mint(server, `__Host-rivet=${value}`)).status).toBe(403);
      expect(rows(server, "SELECT hash FROM device_codes")).toHaveLength(0);
    });

    it("is never taken for a passkey's by running out part-way through the check, and a session that ran out is no one's", () => {
      const { auth, store } = server.app;
      const asks = (value: string) => ({ headers: { cookie: `__Host-rivet=${value}` } }) as Parameters<typeof auth.hasPasskeySession>[0];
      const [code, passkey] = ["c".repeat(43), "p".repeat(43)];
      const real = Date.now;
      let clock: number[] = [];
      // The last time given stays: a check that reads the clock twice sees the session's last instant, then its end.
      Date.now = () => (clock.length > 1 ? clock.shift()! : clock[0]!);
      try {
        clock = [1_000];
        store.addSession(sha256(code).toString("hex"), 60_000, "device-code");
        store.addSession(sha256(passkey).toString("hex"), 60_000);
        clock = [60_999];
        expect([auth.hasPasskeySession(asks(code)), auth.hasPasskeySession(asks(passkey))]).toEqual([false, true]);
        clock = [60_999, 61_000];
        expect(auth.hasPasskeySession(asks(code))).toBe(false);
        clock = [61_000];
        expect([auth.hasPasskeySession(asks(passkey)), auth.hasSession(asks(passkey)), auth.hasSession(asks(code))]).toEqual([false, false, false]);
      } finally {
        Date.now = real;
      }
    });

    it("sets up no passkey on its own word, where a passkey's session still does", async () => {
      const laptop = await byCode(on);
      const refused = await options(on, laptop);
      expect(refused.status).toBe(401);
      expect(await refused.json()).not.toHaveProperty("flowId");
      expect((await options(on, laptop, { code: "ZZZZ2222" })).status).toBe(403);
      expect(on.app.store.listCredentials()).toHaveLength(0);
      expect((await options(on, on.cookie())).status).toBe(200);
      // As a signed-out window would, it needs a code from a device signed in with a passkey.
      expect((await options(on, laptop, { code: await newCode(on) })).status).toBe(200);
    });

    it("cannot renew itself: on day 29 it gets no code to sign in again with, and its 30 days end when they did", async () => {
      const laptop = await byCode(on);
      const made = rows(on, "SELECT hash, expires_at FROM sessions WHERE via = 'device-code'");
      expect(made).toHaveLength(1);
      const db = new DatabaseSync(join(on.dataDir, "rivet.sqlite"));
      db.prepare("UPDATE sessions SET expires_at = ? WHERE via = 'device-code'").run(Date.now() + 24 * 60 * 60 * 1000);
      db.close();
      const day29 = rows(on, "SELECT hash, expires_at FROM sessions WHERE via = 'device-code'");
      expect((await mint(on, laptop)).status).toBe(403);
      expect((await options(on, laptop)).status).toBe(401);
      expect(rows(on, "SELECT hash FROM device_codes WHERE used = 0")).toHaveLength(0);
      expect(rows(on, "SELECT hash, expires_at FROM sessions WHERE via = 'device-code'")).toEqual(day29);
      expect((await fetch(`${on.base}/api/board`, { headers: { cookie: laptop } })).status).not.toBe(401);
      const late = new DatabaseSync(join(on.dataDir, "rivet.sqlite"));
      late.prepare("UPDATE sessions SET expires_at = ? WHERE via = 'device-code'").run(Date.now() - 1);
      late.close();
      expect((await fetch(`${on.base}/api/board`, { headers: { cookie: laptop } })).status).toBe(401);
      expect((await mint(on, laptop)).status).toBe(401);
    });
  });

  it("gives one session when one code is posted twice at once", async () => {
    const code = await newCode(on);
    const responses = await Promise.all([post(on, code), post(on, code)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
    expect(responses.filter((response) => response.headers.get("set-cookie") !== null)).toHaveLength(1);
    expect(madeByCode(on)).toBe(1);
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
