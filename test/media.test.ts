import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CommandStore, EARLIER_TITLE, MEDIA_SEEN_PER_SHA } from "../src/server/commandstore.js";
import { MEDIA_CAP_BYTES, MediaStore } from "../src/server/media.js";
import { Store } from "../src/server/store.js";
import { boardSchema, needSchema } from "../src/shared/board.js";
import { MEDIA_PAGE_MAX, type MediaPage } from "../src/shared/media.js";
import { bearer, BOARD_TOKEN, browser, EXAMPLE_BOARD, putBoard, revOf, startServer, type TestServer } from "./helpers.js";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

const sha = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (n: number) => Buffer.concat([PNG_MAGIC, Buffer.alloc(100, n)]);
const mp4 = (n: number) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(100, n)]);
const ref = (body: Buffer, type: "image/png" | "video/mp4") => ({ sha256: sha(body), type });

const servers: TestServer[] = [];
const stores: { close(): void }[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const server of servers.splice(0)) await server.close();
});

async function serve(dataDir = mkdtempSync(join(tmpdir(), "rivet-media-"))): Promise<{ server: TestServer; dataDir: string; cookie: string }> {
  const server = await startServer({ RIVET_DATA_DIR: dataDir });
  servers.push(server);
  return { server, dataDir, cookie: server.cookie() };
}

function commandStore(dataDir: string): CommandStore {
  const store = new CommandStore(dataDir);
  stores.push(store);
  return store;
}

async function upload(server: TestServer, body: Buffer, type: string): Promise<void> {
  const response = await fetch(`${server.base}/api/bridge/media/${sha(body)}`, { method: "PUT", headers: { ...bearer(BOARD_TOKEN), "content-type": type }, body: new Uint8Array(body) });
  expect(response.status).toBe(201);
}

async function list(server: TestServer, cookie: string, before?: string): Promise<MediaPage> {
  const response = await fetch(`${server.base}/api/media${before ? `?before=${encodeURIComponent(before)}` : ""}`, { headers: { cookie } });
  expect(response.status).toBe(200);
  return (await response.json()) as MediaPage;
}

const STILLS_CARD = {
  id: "demo-reels",
  kind: "approval",
  title: "Night Batch: the new reels",
  ask: "Do the reels read at a glance?",
  since: "2026-10-01T02:00:00.000Z",
};

describe("GET /api/media", () => {
  it("is gated by the session like the board", async () => {
    const { server, cookie } = await serve();
    expect((await fetch(`${server.base}/api/media`)).status).toBe(401);
    expect((await fetch(`${server.base}/api/board`)).status).toBe(401);
    expect((await fetch(`${server.base}/api/media`, { headers: bearer(BOARD_TOKEN) })).status).toBe(401);
    expect((await fetch(`${server.base}/api/media`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${server.base}/api/media?before=nonsense`, { headers: { cookie } })).status).toBe(400);
  });

  it("keeps a dropped card's stills past the cap, evicting files Media does not record first, and still lists them", async () => {
    const { server, dataDir, cookie } = await serve();
    const [a, b, c] = [png(1), png(2), png(3)];
    await upload(server, a, "image/png");
    await upload(server, b, "image/png");
    const card = { ...STILLS_CARD, media: { kind: "stills", stills: [ref(a, "image/png"), ref(b, "image/png")] } };
    const shown = new Date().toISOString();
    expect((await putBoard(server.base, { ...EXAMPLE_BOARD, needs: [...EXAMPLE_BOARD.needs, card] })).status).toBe(200);
    expect((await putBoard(server.base, EXAMPLE_BOARD)).status).toBe(200);

    // Past the 15-minute grace, and used longer ago than anything else: least recently used alone would drop them first.
    const commands = commandStore(dataDir);
    commands.touchMedia(sha(a), 0);
    commands.touchMedia(sha(b), 0);
    const big = "1".repeat(64);
    const small = "2".repeat(64);
    commands.putMedia(big, "video/mp4", MEDIA_CAP_BYTES, 1_000);
    commands.putMedia(small, "image/png", 10, 500);
    await upload(server, c, "image/png");

    expect(commands.getMedia(small)).toBeNull();
    expect(commands.getMedia(big)).toBeNull();
    for (const body of [a, b, c]) expect(commands.getMedia(sha(body))).not.toBeNull();
    expect(existsSync(join(dataDir, "media", sha(a)))).toBe(true);
    expect(existsSync(join(dataDir, "media", sha(b)))).toBe(true);

    const page = await list(server, cookie);
    expect(page.items.map((item) => item.sha).sort()).toEqual([sha(a), sha(b)].sort());
    for (const item of page.items) {
      expect(item).toMatchObject({ type: "image/png", source: "card", title: STILLS_CARD.title, card: { id: STILLS_CARD.id, onBoard: false } });
      // When the board showed it, never the card's older `since`.
      expect(item.at >= shown).toBe(true);
    }
  });

  it("gives an answered card your decision and its ask, and a card still up onBoard", async () => {
    const { server, cookie } = await serve();
    const [a, clip, poster] = [png(4), mp4(5), png(6)];
    for (const [body, type] of [[a, "image/png"], [clip, "video/mp4"], [poster, "image/png"]] as const) await upload(server, body, type);
    const answered = { ...STILLS_CARD, options: [{ label: "Ship it" }, { label: "Not yet" }], media: { kind: "stills", stills: [ref(a, "image/png")] } };
    const open = { id: "quiz-sky", kind: "fyi", title: "Quiz app: the sky", media: { kind: "video", after: ref(clip, "video/mp4"), poster: ref(poster, "image/png") } };
    await putBoard(server.base, { ...EXAMPLE_BOARD, needs: [answered, open] });
    const rev = await revOf(server.base, cookie, answered.id);
    const reply = await fetch(`${server.base}/api/replies`, {
      method: "POST",
      headers: browser(cookie),
      body: JSON.stringify({ clientId: "client-media-1", itemId: answered.id, decision: "choice", choice: "Ship it", text: "lovely", rev }),
    });
    expect(reply.status).toBe(201);
    await putBoard(server.base, { ...EXAMPLE_BOARD, needs: [open] });

    const { items } = await list(server, cookie);
    const still = items.find((item) => item.sha === sha(a))!;
    expect(still.card).toMatchObject({ id: answered.id, onBoard: false, ask: STILLS_CARD.ask, answer: { decision: "choice", choice: "Ship it", text: "lovely" } });
    const video = items.find((item) => item.sha === sha(clip))!;
    expect(video).toMatchObject({ type: "video/mp4", poster: sha(poster), source: "card", card: { id: "quiz-sky", onBoard: true } });
    expect(video.card!.answer).toBeUndefined();
    // The poster thumbnails its video; it is not a photo of its own.
    expect(items.some((item) => item.sha === sha(poster))).toBe(false);
    // Newest first: one board write showed both, the clip recorded after the still.
    expect(items.map((item) => item.sha)).toEqual([sha(clip), sha(a)]);
  });

  it("lists Rivet's chat photos and video under their conversation, and pages newest first", async () => {
    const { server, dataDir, cookie } = await serve();
    const commands = commandStore(dataDir);
    const total = MEDIA_PAGE_MAX + 5;
    for (let i = 0; i < total; i += 1) {
      const image = `${(i % 16).toString(16)}${String(i).padStart(63, "0")}`;
      commands.putMedia(image, "image/jpeg", 10, 1);
      // Pairs share a time, so the cursor has to break the tie.
      commands.addChatMessage({ id: `m${i}`, from: "rivet", text: "", at: new Date(Date.UTC(2026, 9, 1, 0, Math.floor(i / 2))).toISOString(), images: [image], thread: `m${i - (i % 2)}` });
    }
    const first = await list(server, cookie);
    expect(first.items).toHaveLength(MEDIA_PAGE_MAX);
    expect(first.next).not.toBeNull();
    const second = await list(server, cookie, first.next!);
    expect(second.next).toBeNull();
    const all = [...first.items, ...second.items];
    expect(new Set(all.map((item) => item.sha)).size).toBe(total);
    expect(all.map((item) => item.chat!.message)).toEqual(Array.from({ length: total }, (_, i) => `m${total - 1 - i}`));
    expect(all[0]).toMatchObject({ source: "chat", chat: { conversation: `m${total - 1 - ((total - 1) % 2)}` } });

    // A message the retention sweep deleted keeps its photo, with nothing to open.
    (commands as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db.prepare("DELETE FROM chat_messages WHERE id = ?").run(`m${total - 1}`);
    const [gone, kept] = (await list(server, cookie)).items;
    expect(gone).toMatchObject({ source: "chat", title: "Chat" });
    expect(gone!.chat).toBeUndefined();
    expect(kept!.chat!.message).toBe(`m${total - 2}`);
  });
});

describe("the Media record", () => {
  it("records Rivet's chat media, never your own photos, and backfills them once into an older database", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rivet-media-"));
    const first = new CommandStore(dataDir);
    const [photo, clip, mine] = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
    first.putMedia(photo, "image/png", 10, 1);
    first.putMedia(clip, "video/mp4", 10, 1);
    first.putMedia(mine, "image/jpeg", 10, 1);
    first.addChatMessage({ id: "h1", from: "rivet", text: "Here it is", at: "2026-10-02T01:00:00.000Z", images: [photo], video: clip });
    first.addChatMessage({ id: "c1", from: "owner", text: "Mine", at: "2026-10-02T02:00:00.000Z", images: [mine], card: "demo-reels" });
    expect(first.mediaSeen(null, 10).map((row) => [row.sha, row.source, row.ref])).toEqual([
      [clip, "chat", "h1"],
      [photo, "chat", "h1"],
    ]);
    first.close();

    // A database from before the record: the table is not there yet.
    const raw = new DatabaseSync(join(dataDir, "rivet.sqlite"));
    raw.exec("DROP TABLE media_seen");
    raw.close();
    const reopened = commandStore(dataDir);
    const rows = reopened.mediaSeen(null, 10);
    expect(rows.map((row) => [row.sha, row.source, row.ref, row.conversation, row.at])).toEqual([
      [clip, "chat", "h1", "h1", "2026-10-02T01:00:00.000Z"],
      [photo, "chat", "h1", "h1", "2026-10-02T01:00:00.000Z"],
    ]);
    expect(rows.find((row) => row.sha === clip)!.type).toBe("video/mp4");
  });

  it("records the board the app starts with from each file's upload, then the store's other pictures once as earlier cards", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rivet-media-"));
    const [still, later, earlier, clip, answer, request, sound, again] = ["d", "e", "f", "1", "2", "3", "4", "5"].map((n) => n.repeat(64)) as [
      string, string, string, string, string, string, string, string,
    ];
    const uploaded = Date.parse("2026-09-30T00:00:00.000Z");
    const before = new CommandStore(dataDir);
    before.putMedia(still, "image/png", 10, uploaded);
    // Stored "after" this start: dated now, never in the future.
    before.putMedia(later, "image/png", 10, Date.now() + 86_400_000);
    before.putMedia(earlier, "image/jpeg", 10, uploaded - 1_000);
    before.putMedia(clip, "video/webm", 10, uploaded - 2_000);
    // Your own: on an answer, on a chat request; a sound is not a picture.
    before.putMedia(answer, "image/jpeg", 10, uploaded);
    before.putMedia(request, "image/png", 10, uploaded);
    before.putMedia(sound, "audio/mpeg", 10, uploaded);
    before.addAction({ id: "act-1", clientId: "client-act-1", kind: "chat", at: "2026-09-30T00:00:00.000Z", request: { text: "this one", images: [request] } });
    before.close();
    const store = new Store(dataDir);
    const stills = [still, later].map((one) => ({ sha256: one, type: "image/png" }));
    store.putBoard(boardSchema.parse({ ...EXAMPLE_BOARD, needs: [{ ...STILLS_CARD, media: { kind: "stills", stills } }] }), null);
    store.addReply({ clientId: "client-old", itemId: "gone", itemTitle: "Gone", decision: "comment", text: "see", rev: "r", image: answer, item: { id: "gone", title: "Gone", kind: "fyi" } });
    store.close();

    const started = Date.now();
    const first = await serve(dataDir);
    const { items } = await list(first.server, first.cookie);
    expect(items.map((item) => item.sha)).toEqual([later, still, earlier, clip]);
    expect(items[0]!).toMatchObject({ title: STILLS_CARD.title, card: { id: STILLS_CARD.id, onBoard: true } });
    expect(Date.parse(items[0]!.at)).toBeGreaterThanOrEqual(started);
    expect(Date.parse(items[0]!.at)).toBeLessThanOrEqual(Date.now());
    expect(items[1]).toEqual(expect.objectContaining({ at: new Date(uploaded).toISOString(), title: STILLS_CARD.title, card: { id: STILLS_CARD.id, onBoard: true } }));
    // No card behind them to open: no id, no answer.
    expect(items[2]).toEqual({ sha: earlier, type: "image/jpeg", at: new Date(uploaded - 1_000).toISOString(), source: "card", title: EARLIER_TITLE });
    expect(items[3]).toEqual({ sha: clip, type: "video/webm", at: new Date(uploaded - 2_000).toISOString(), source: "card", title: EARLIER_TITLE });
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);

    const reopened = new CommandStore(dataDir);
    reopened.putMedia(again, "image/png", 10, uploaded);
    reopened.close();
    const second = await serve(dataDir);
    expect((await list(second.server, second.cookie)).items.map((item) => item.sha)).toEqual([later, still, earlier, clip]);
  });

  it("records only stored files, forgets an evicted one, and keeps a file's newest records", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rivet-media-"));
    const store = commandStore(dataDir);
    const [kept, absent] = ["6", "7"].map((n) => n.repeat(64)) as [string, string];
    store.putMedia(kept, "image/png", 10, 1);
    const card = (id: string, sha256: string) => needSchema.parse({ id, kind: "fyi", title: id, media: { kind: "stills", stills: [{ sha256, type: "image/png" }] } });
    store.recordCards([card("absent", absent)], "2026-09-01T00:00:00.000Z");
    store.addChatMessage({ id: "h-absent", from: "rivet", text: "", at: "2026-09-01T00:00:00.000Z", images: [absent] });
    expect(store.mediaSeen(null, 50)).toEqual([]);

    for (let i = 0; i < MEDIA_SEEN_PER_SHA + 5; i += 1) store.recordCards([card(`c${i}`, kept)], new Date(Date.UTC(2026, 8, 1, i)).toISOString());
    const rows = store.mediaSeen(null, 50);
    expect(rows.map((row) => row.ref)).toEqual(Array.from({ length: MEDIA_SEEN_PER_SHA }, (_, i) => `c${MEDIA_SEEN_PER_SHA + 4 - i}`));

    store.deleteMedia(kept);
    store.putMedia(kept, "image/png", 10, 2);
    expect(store.mediaSeen(null, 50)).toEqual([]);
  });

  it("gives a card's file the first answer to that card after it was shown, under the same title", async () => {
    const { server, dataDir, cookie } = await serve();
    const a = png(7);
    await upload(server, a, "image/png");
    const shown = new Date().toISOString();
    await putBoard(server.base, { ...EXAMPLE_BOARD, needs: [{ ...STILLS_CARD, media: { kind: "stills", stills: [ref(a, "image/png")] } }] });
    await putBoard(server.base, EXAMPLE_BOARD);
    const store = new Store(dataDir);
    stores.push(store);
    const reply = (clientId: string, itemTitle: string, text: string) =>
      store.addReply({ clientId, itemId: STILLS_CARD.id, itemTitle, decision: "comment", text, rev: "r", item: { id: STILLS_CARD.id, title: itemTitle, kind: "approval" } });
    for (const [clientId, title, text] of [["r-before", STILLS_CARD.title, "before"], ["r-other", "Another card, same id", "other"], ["r-first", STILLS_CARD.title, "first"], ["r-later", STILLS_CARD.title, "later"]]) {
      reply(clientId!, title!, text!);
    }
    const raw = new DatabaseSync(join(dataDir, "rivet.sqlite"));
    const at = (clientId: string, offset: number) => raw.prepare("UPDATE replies SET at = ? WHERE client_id = ?").run(new Date(Date.parse(shown) + offset).toISOString(), clientId);
    at("r-before", -60_000);
    at("r-other", 60_000);
    at("r-first", 120_000);
    at("r-later", 180_000);
    raw.close();

    const { items } = await list(server, cookie);
    expect(items[0]!.card!.answer).toMatchObject({ decision: "comment", text: "first" });

    // An answer to a later showing under the same title is not this one's; one that changes it (Answer again) is.
    const card = { id: STILLS_CARD.id, title: STILLS_CARD.title, kind: "approval" } as const;
    store.addReply({ clientId: "r-next", itemId: STILLS_CARD.id, itemTitle: STILLS_CARD.title, decision: "approve", rev: "r3", item: card });
    const next = new DatabaseSync(join(dataDir, "rivet.sqlite"));
    next.prepare("UPDATE replies SET at = ? WHERE client_id = ?").run(new Date(Date.parse(shown) + 300_000).toISOString(), "r-next");
    next.close();
    expect((await list(server, cookie)).items[0]!.card!.answer).toMatchObject({ decision: "comment", text: "first" });
    const first = store.getReplyByClientId("r-first")!;
    const changed = store.addReply({ clientId: "r-changed", itemId: STILLS_CARD.id, itemTitle: STILLS_CARD.title, decision: "reject", text: "changed", rev: "r2", item: { ...card, changes: { replyId: first.id, decision: "comment" } } });
    store.addReply({ clientId: "r-changed-2", itemId: STILLS_CARD.id, itemTitle: STILLS_CARD.title, decision: "comment", text: "changed again", rev: "r4", item: { ...card, changes: { replyId: changed.id, decision: "reject" } } });
    expect((await list(server, cookie)).items[0]!.card!.answer).toMatchObject({ decision: "comment", text: "changed again" });
  });

  it("evicts Media's files last, the longest ago sent first, a poster with its video", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rivet-media-"));
    const store = commandStore(dataDir);
    const [old, newer, clip, poster, other] = ["1", "2", "3", "4", "5"].map((n) => n.repeat(64)) as [string, string, string, string, string];
    for (const one of [old, newer, clip, poster]) store.putMedia(one, one === clip ? "video/mp4" : "image/png", 100, 1);
    store.putMedia(other, "image/png", 100, 9);
    const card = (id: string, media: unknown) => needSchema.parse({ id, kind: "fyi", title: id, media });
    store.recordCards([card("old", { kind: "stills", stills: [{ sha256: old, type: "image/png" }] })], "2026-09-20T00:00:00.000Z");
    store.recordCards([card("clip", { kind: "video", after: { sha256: clip, type: "video/mp4" }, poster: { sha256: poster, type: "image/png" } })], "2026-09-25T00:00:00.000Z");
    store.recordCards([card("newer", { kind: "stills", stills: [{ sha256: newer, type: "image/png" }] })], "2026-10-01T00:00:00.000Z");
    expect(store.mediaByAge().map((item) => item.sha)).toEqual([other, old, clip, poster, newer]);
    const media = new MediaStore(dataDir, store, () => new Set(), 150, () => 10 ** 13);
    expect(media.evict("none")).toEqual([other, old, clip, poster]);
    expect(store.getMedia(newer)).not.toBeNull();
  });
});
