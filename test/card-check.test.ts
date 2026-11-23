import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkCards, mediaSizeReader, type MediaSizeOf } from "../src/server/card-check.js";
import type { Need } from "../src/shared/board.js";
import { CARD_CHECKER_ID, DEFAULT_CARD_CHECKER, type CardChecker } from "../src/shared/card-check.js";
import { bearer, BOARD_TOKEN, browser, startServer, type TestServer } from "./helpers.js";

// The card checker: each rule on its own, blocking and warning, the media size reader, and the board-token routes.

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real PNG of one flat colour, `width` × `height`. */
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(height * (1 + width * 3));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** A JPEG's markers up to its frame header: APP0, a long APP1 to step over, DQT, then SOF2. */
function jpeg(width: number, height: number): Buffer {
  const segment = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  const sof = Buffer.from([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    segment(0xe1, Buffer.alloc(3000, 0x45)),
    segment(0xdb, Buffer.alloc(65, 1)),
    Buffer.from([0xff, 0xff]),
    segment(0xc2, sof),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length + 8);
  return Buffer.concat([size, Buffer.from(type, "latin1"), body]);
}

function tkhd(width: number, height: number, turned: boolean): Buffer {
  const body = Buffer.alloc(84);
  body.writeUInt32BE(7, 0);
  const matrix = turned ? [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000] : [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
  matrix.forEach((value, index) => body.writeInt32BE(value, 40 + index * 4));
  body.writeUInt32BE(width * 65536, 76);
  body.writeUInt32BE(height * 65536, 80);
  return box("tkhd", body);
}

function trak(handler: string, width: number, height: number, turned = false): Buffer {
  const hdlr = Buffer.alloc(25);
  hdlr.write(handler, 8, "latin1");
  return box("trak", tkhd(width, height, turned), box("mdia", box("mdhd", Buffer.alloc(24)), box("hdlr", hdlr)));
}

/** An MP4 with a sound track before its video track, `moov` after `mdat` as a phone writes it. */
function mp4(width: number, height: number, turned = false): Buffer {
  const ftyp = box("ftyp", Buffer.from("isom\0\0\x02\0isomiso2avc1mp41", "latin1"));
  return Buffer.concat([ftyp, box("mdat", Buffer.alloc(500, 9)), box("moov", box("mvhd", Buffer.alloc(100)), trak("soun", 0, 0), trak("vide", width, height, turned))]);
}

const S1 = "1".repeat(64);
const S2 = "2".repeat(64);
const S3 = "3".repeat(64);
const V1 = "4".repeat(64);

function card(fields: Partial<Need> & Record<string, unknown>): Need {
  return { id: "pick", kind: "decision", title: "Pick a look", ...fields } as Need;
}

const knobs = (mode: "block" | "warn", extra: Partial<CardChecker> = {}): CardChecker => ({ ...DEFAULT_CARD_CHECKER, shape: mode, options: mode, stills: mode, video: mode, links: mode, ...extra });

/** Card sizes for the tests alone; the real ones are in the private module. */
const VIDEO_SIZES = ["400x900", "300x650"];

function run(cards: Need[], mode: "block" | "warn", sizes: Record<string, { width: number; height: number } | null> = {}, sentCards: Need[] = cards, storedCards: Need[] = []) {
  const mediaSize: MediaSizeOf = (digest) => (digest in sizes ? sizes[digest]! : { width: 400, height: 900 });
  return checkCards({ cards, sentCards, storedCards, knobs: knobs(mode), mediaSize, videoSizes: VIDEO_SIZES });
}

/** The rule's messages refuse under block and warn under warn. */
function both(cards: Need[], sizes?: Record<string, { width: number; height: number } | null>, sentCards?: Need[]): string[] {
  const blocked = run(cards, "block", sizes, sentCards);
  const warned = run(cards, "warn", sizes, sentCards);
  expect(blocked.warnings).toEqual([]);
  expect(warned.refusals).toEqual([]);
  expect(warned.warnings).toEqual(blocked.refusals);
  return blocked.refusals;
}

describe("the card rules", () => {
  it("pass a card that keeps every rule", () => {
    const ok = card({
      ask: "Which banner look?\n- calm\n- bold\n\nShip after his pick",
      options: [{ label: "Calm" }, { label: "Bold" }, { label: "Neither" }],
      media: { kind: "stills", stills: [{ sha256: S1, type: "image/png" }, { sha256: S2, type: "image/jpeg" }] },
      links: [{ label: "PR", url: "https://github.com/x/y/pull/12" }],
    });
    expect(run([ok], "block")).toEqual({ refusals: [], warnings: [] });
  });

  it("shape: a long title, an item with too many bullets or lines, a long ask and too many plan points", () => {
    const [message] = both([card({ title: "one two three four five six seven eight nine ten eleven twelve thirteen", ask: "Main\n- a\n- b\n\nSecond\n- a\n- b\n- c\n- d\n- e\n\nThird\nline two" })]);
    expect(message).toBe(
      "card pick: the title has 13 words (at most 12), item 2 has 5 bullets, item 3 has 2 lines that are not bullets; keep each item to a heading and at most 3 short bullets (detail goes in the saved file)",
    );
    expect(both([card({ ask: "x".repeat(1501) })])[0]).toContain("the ask is 1501 characters (at most 1500), item 1's main line is 1501 characters");
    expect(both([card({ kind: "plan", points: ["a", "b", "c", "d"] })])[0]).toContain("the plan has 4 points");
    expect(both([card({ ask: "Main\n1. a\n2) b\n• c\n\n* d" })])).toEqual([]);
  });

  it("options: every option that changes something has its still", () => {
    const stills = (n: number) => ({ kind: "stills" as const, stills: [S1, S2, S3].slice(0, n).map((digest) => ({ sha256: digest, type: "image/png" as const })) });
    const three = [{ label: "Calm" }, { label: "Bold" }, { label: "Loud" }, { label: "Keep it as is" }, { label: "Something else", text: true }];
    expect(both([card({ options: three, media: stills(1) })])).toEqual(["card pick: 3 options but 1 still; put every option's picture on the card (one --still each)"]);
    expect(both([card({ options: three, media: stills(3) })])).toEqual([]);
    // A yes/no card, an approve-or-change card, a merge card and a card with no stills are not judged.
    expect(both([card({ options: [{ label: "Yes" }, { label: "Not now" }], media: stills(1) })])).toEqual([]);
    expect(both([card({ options: [{ label: "Ship it" }, { label: "Not yet" }], media: stills(1) })])).toEqual([]);
    expect(both([card({ options: [{ label: "Approve and merge" }, { label: "Send changes" }], media: stills(1) })])).toEqual([]);
    expect(both([card({ title: "Ship the new banner?", options: [{ label: "Yes" }, { label: "Change it" }], media: stills(1) })])).toEqual([]);
    expect(both([card({ options: [{ label: "Approve" }, { label: "OK, go ahead" }, { label: "Changes: bolder" }, { label: "Redo it" }], media: stills(1) })])).toEqual([]);
    expect(both([card({ kind: "merge-ready", pr: 1, headSha: "a".repeat(40), options: three, media: stills(1) })])).toEqual([]);
    expect(both([card({ options: three })])).toEqual([]);
  });

  it("options: an answer word counts only as a whole word at the start of the label", () => {
    const media = { kind: "stills" as const, stills: [{ sha256: S1, type: "image/png" as const }] };
    const looks = [{ label: "Otherworld theme" }, { label: "Currently-blue HUD" }, { label: "Hold-to-jump control" }];
    expect(both([card({ options: looks, media })])).toEqual(["card pick: 3 options but 1 still; put every option's picture on the card (one --still each)"]);
    expect(both([card({ options: [{ label: "Gold banner" }, { label: "Fixed camera" }, { label: "Other" }], media })])).toEqual([
      "card pick: 2 options but 1 still; put every option's picture on the card (one --still each)",
    ]);
  });

  it("stills: each image's long side is 1600 px or less", () => {
    const media = { kind: "stills" as const, stills: [{ sha256: S1, type: "image/png" as const }, { sha256: S2, type: "image/png" as const }] };
    expect(both([card({ media })], { [S2]: { width: 900, height: 1700 } })).toEqual([
      "card pick: still 2 is 900×1700, over 1600 px on its long side; shrink it (sips -Z 1600, or ffmpeg scale) before --still",
    ]);
    // A video's poster is a frame of it, at the video's size.
    const poster = { kind: "video" as const, after: { sha256: V1, type: "video/mp4" as const }, poster: { sha256: S1, type: "image/jpeg" as const } };
    expect(both([card({ media: poster })], { [S1]: { width: 900, height: 1700 } })).toEqual([]);
  });

  it("video: each video is one of the card sizes, and any readable size passes with none set", () => {
    const media = { kind: "before-after" as const, before: { sha256: V1, type: "video/mp4" as const }, after: { sha256: S3, type: "video/mp4" as const } };
    const sizes = { [V1]: { width: 300, height: 650 }, [S3]: { width: 780, height: 1688 } };
    expect(both([card({ media })], sizes)).toEqual(["card pick: the after video is 780×1688, not the card size; encode it to 400×900"]);
    expect(checkCards({ cards: [card({ media })], sentCards: [], storedCards: [], knobs: knobs("block"), mediaSize: (digest) => sizes[digest]!, videoSizes: [] })).toEqual({ refusals: [], warnings: [] });
  });

  it("an unreadable size only ever warns", () => {
    const media = { kind: "video" as const, after: { sha256: V1, type: "video/webm" as const }, stills: [{ sha256: S1, type: "image/png" as const }] };
    const result = run([card({ media })], "block", { [V1]: null, [S1]: null });
    expect(result.refusals).toEqual([]);
    expect(result.warnings).toEqual([
      "card pick: could not read the size of still 1; check it is 1600 px or less on its long side",
      "card pick: could not read the size of the after video (a webm, or a file cut short); check it is the card size (400×900)",
    ]);
  });

  it("judges an mp4 named a webm by what the file is", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-card-check-type-"));
    try {
      const bytes = mp4(300, 700);
      fs.writeFileSync(path.join(dir, sha(bytes)), bytes);
      const media = { kind: "video" as const, after: { sha256: sha(bytes), type: "video/webm" as const } };
      const result = checkCards({ cards: [card({ media })], sentCards: [], storedCards: [], knobs: knobs("block"), mediaSize: mediaSizeReader(dir), videoSizes: VIDEO_SIZES });
      expect(result).toEqual({ refusals: ["card pick: the after video is 300×700, not the card size; encode it to 400×900"], warnings: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("on a card already stored, runs only the rules whose part changed", () => {
    const media = { kind: "video" as const, after: { sha256: V1, type: "video/mp4" as const } };
    const wrong = { [V1]: { width: 780, height: 1688 } };
    const was = card({ kind: "merge-ready", pr: 1, headSha: "a".repeat(40), title: "Merge the banner", media, evidence: { ci: "running" } });
    // New proof and a new title leave the stored video alone.
    const now = { ...was, title: "Merge the banner now", evidence: { ci: "green" as const, ciNote: "all green" } };
    expect(run([now], "block", wrong, [now], [was])).toEqual({ refusals: [], warnings: [] });
    // A changed title is judged for its shape all the same.
    const long = { ...was, title: "one two three four five six seven eight nine ten eleven twelve thirteen" };
    expect(run([long], "block", wrong, [long], [was]).refusals).toEqual([
      "card pick: the title has 13 words (at most 12); keep each item to a heading and at most 3 short bullets (detail goes in the saved file)",
    ]);
    // A new video is judged.
    const swapped = { ...was, media: { kind: "video" as const, after: { sha256: S3, type: "video/mp4" as const } } };
    expect(run([swapped], "block", { [S3]: { width: 780, height: 1688 } }, [swapped], [was]).refusals).toEqual([
      "card pick: the after video is 780×1688, not the card size; encode it to 400×900",
    ]);
  });

  it("on a card already stored, judges no link the chat sent back as it was", () => {
    const was = card({ links: [{ label: "Lab", url: `https://rivet.example/play?key=ghp_${"a1B2c3D4e5".repeat(4)}` }], evidence: { ci: "running" } });
    const now = { ...was, evidence: { ci: "green" as const } };
    expect(run([now], "block", {}, [now], [was])).toEqual({ refusals: [], warnings: [] });
  });

  it("links: counts the links the card would carry cut, as sent, and never names one", () => {
    const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const sent = card({
      ask: `See https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd/edit and https://github.com/x/y/pull/12`,
      options: [{ label: "Open", detail: `https://example.com/x?token=${token}` }],
      links: [{ label: "Lab", url: `https://rivet.example/play?key=${token}` }, { label: "PR", url: "https://github.com/x/y/pull/12" }],
    });
    const stored = card({ ask: "See https:[redacted] and https://github.com/x/y/pull/12" });
    const [message] = both([stored], {}, [sent]);
    expect(message).toBe(
      'card pick: 3 private links, which the card would show cut as https:[redacted]; send them to the owner in one email to himself, then add an email button (rivet card add … --email-button "<subject>")',
    );
    expect(message).not.toContain(token);
    expect(both([card({ links: [{ label: "Mail", url: `https://mail.google.com/mail/#search/${encodeURIComponent('subject:"Lab links"')}` }] })])).toEqual([]);
    const lab = `https://rivet.example/play?key=${token}`;
    const elsewhere = card({
      kind: "plan",
      eta: `after ${lab}`,
      links: [{ label: `Lab ${lab}`, url: "https://github.com/x/y/pull/12" }],
      media: { kind: "audio", clips: [{ sha256: S1, type: "audio/mpeg", label: lab.slice(0, 40) }] },
    });
    expect(both([elsewhere])[0]).toContain("card pick: 3 private links");
  });

  it("checks nothing while it is off", () => {
    const broken = card({ title: "one two three four five six seven eight nine ten eleven twelve thirteen", options: [{ label: "A" }, { label: "B" }], media: { kind: "stills", stills: [{ sha256: S1, type: "image/png" }] } });
    expect(checkCards({ cards: [broken], sentCards: [broken], storedCards: [], knobs: { ...knobs("block"), on: false }, mediaSize: () => null, videoSizes: VIDEO_SIZES })).toEqual({ refusals: [], warnings: [] });
  });
});

describe("the media size reader", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-card-check-"));
  const put = (bytes: Buffer) => {
    const digest = sha(bytes);
    fs.writeFileSync(path.join(dir, digest), bytes);
    return digest;
  };
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reads a PNG, a JPEG and an MP4 from their headers, turning a rotated video", () => {
    const read = mediaSizeReader(dir);
    expect(read(put(png(1700, 20)))).toEqual({ width: 1700, height: 20 });
    expect(read(put(jpeg(600, 1300)))).toEqual({ width: 600, height: 1300 });
    expect(read(put(mp4(400, 900)))).toEqual({ width: 400, height: 900 });
    expect(read(put(mp4(900, 400, true)))).toEqual({ width: 400, height: 900 });
  });

  it("gives null for a webm, a file cut short, a missing file and junk, and reads a bad file once", () => {
    const read = mediaSizeReader(dir);
    const whole = mp4(400, 900);
    expect(read(put(whole.subarray(0, whole.length - 60)))).toBeNull();
    expect(read(put(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])))).toBeNull();
    expect(read("f".repeat(64))).toBeNull();
    const junk = put(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(120, 7)]));
    expect(read(junk)).toBeNull();
    expect(read(put(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff])))).toBeNull();
    // Kept: the same digest over a readable file still answers null.
    fs.writeFileSync(path.join(dir, junk), png(10, 10));
    expect(read(junk)).toBeNull();
  });
});

describe("the card checker on the board routes", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startServer();
  });

  afterEach(async () => {
    await server.close();
  });

  const upload = async (bytes: Buffer, type: string) => {
    const res = await fetch(`${server.base}/api/bridge/media/${sha(bytes)}`, { method: "PUT", headers: { ...bearer(BOARD_TOKEN), "content-type": type }, body: new Uint8Array(bytes) });
    expect(res.status).toBe(201);
    return sha(bytes);
  };
  const send = (method: string, url: string, body: unknown) => fetch(`${server.base}${url}`, { method, headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) });
  const setKnobs = (value: unknown) => fetch(`${server.base}/api/behaviours/${CARD_CHECKER_ID}`, { method: "PUT", headers: browser(server.cookie()), body: JSON.stringify(value) });
  const options = [{ label: "Calm" }, { label: "Bold" }, { label: "Loud" }];

  it("refuses a card a blocking rule stops, with what to change", async () => {
    const still = await upload(png(400, 900), "image/png");
    const refused = await send("PUT", "/api/board/needs/pick", { kind: "decision", title: "Pick a look", options, media: { kind: "stills", stills: [{ sha256: still, type: "image/png" }] } });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "card checker: card pick: 3 options but 1 still; put every option's picture on the card (one --still each)" });
    expect((await send("PATCH", "/api/board/needs/pick", { title: "Pick" })).status).toBe(404);
  });

  it("saves the knobs, refuses a bad one, and lets a warned card post with its warnings", async () => {
    const saved = await setKnobs({ ...DEFAULT_CARD_CHECKER, options: "warn" });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ id: CARD_CHECKER_ID, value: { ...DEFAULT_CARD_CHECKER, options: "warn" } });
    expect((await setKnobs({ ...DEFAULT_CARD_CHECKER, edge: "block" })).status).toBe(400);
    expect((await setKnobs({ on: true })).status).toBe(400);
    const listed = (await (await fetch(`${server.base}/api/behaviours`, { headers: browser(server.cookie()) })).json()) as { behaviours: { id: string; value: unknown; selects?: unknown[] }[] };
    const row = listed.behaviours.find((one) => one.id === CARD_CHECKER_ID)!;
    expect(row.value).toEqual({ ...DEFAULT_CARD_CHECKER, options: "warn" });
    expect(row.selects).toHaveLength(6);

    const still = await upload(png(1700, 20), "image/png");
    const posted = await send("PUT", "/api/board/needs/pick", { kind: "decision", title: "Pick a look", options, media: { kind: "stills", stills: [{ sha256: still, type: "image/png" }] } });
    expect(posted.status).toBe(200);
    expect(((await posted.json()) as { warnings: string[] }).warnings).toEqual([
      "card pick: 3 options but 1 still; put every option's picture on the card (one --still each)",
      "card pick: still 1 is 1700×20, over 1600 px on its long side; shrink it (sips -Z 1600, or ffmpeg scale) before --still",
    ]);
    const clean = await send("PUT", "/api/board/needs/plain", { kind: "decision", title: "Plain" });
    expect(await clean.json()).not.toHaveProperty("warnings");
  });

  it("re-checks only the cards a whole-board PUT adds or changes", async () => {
    await setKnobs({ ...DEFAULT_CARD_CHECKER, options: "warn" });
    const still = await upload(png(400, 900), "image/png");
    const media = { kind: "stills", stills: [{ sha256: still, type: "image/png" }] };
    expect((await send("PUT", "/api/board/needs/pick", { kind: "decision", title: "Pick a look", options, media })).status).toBe(200);
    expect((await setKnobs(DEFAULT_CARD_CHECKER)).status).toBe(200);

    const read = (await (await fetch(`${server.base}/api/board`, { headers: bearer(BOARD_TOKEN) })).json()) as { board: { needs: Record<string, unknown>[] } };
    const again = await fetch(`${server.base}/api/board`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify(read.board) });
    expect(again.status).toBe(200);
    expect(await again.json()).not.toHaveProperty("warnings");

    // A new title is not a new look: the stored options and still are not judged again.
    const retitled = { ...read.board, needs: read.board.needs.map((need) => ({ ...need, title: "Pick a look, again" })) };
    const kept = await fetch(`${server.base}/api/board`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify(retitled) });
    expect(kept.status).toBe(200);
    expect(await kept.json()).not.toHaveProperty("warnings");

    const changed = { ...retitled, needs: retitled.needs.map((need) => ({ ...need, options: [...options, { label: "Wild" }] })) };
    const refused = await fetch(`${server.base}/api/board`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify(changed) });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toContain("card pick: 4 options but 1 still");
  });

  it("never checks a wait card the server makes in the same write", async () => {
    await setKnobs({ ...DEFAULT_CARD_CHECKER, shape: "block" });
    const doing = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen?";
    const board = { updatedAt: new Date().toISOString(), needs: [], coming: [], chats: [{ name: "logo", state: "waiting on the owner", doing }] };
    const res = await fetch(`${server.base}/api/board`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify(board) });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("warnings");
    expect(server.app.store.getBoard()!.board.needs.map((need) => need.title)).toEqual([doing]);
  });

  it("checks a say.mjs card: refused under block, posted with its warnings under warn", async () => {
    const say = (text: string) => fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ text }) });
    const long = "one two three four five six seven eight nine ten eleven twelve thirteen";
    const warned = await say(long);
    expect(warned.status).toBe(201);
    const posted = (await warned.json()) as { card: string; warnings: string[] };
    expect(posted.warnings).toEqual([`card ${posted.card}: the title has 13 words (at most 12); keep each item to a heading and at most 3 short bullets (detail goes in the saved file)`]);

    await setKnobs({ ...DEFAULT_CARD_CHECKER, shape: "block" });
    const refused = await say(`${long} fourteen`);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toMatch(/^the update card was refused: card checker: card upd-[0-9a-f-]+: the title has 14 words \(at most 12\)/);
    expect((await say("Short news")).status).toBe(201);
  });

  it("judges a say.mjs card's links as sent, and stores it redacted", async () => {
    const say = (text: string) => fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ text }) });
    const text = "Preview\nSee https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd/edit";
    const refused = await say(text);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toMatch(/^the update card was refused: card checker: card upd-[0-9a-f-]+: 1 private link, which the card would show cut/);

    await setKnobs({ ...DEFAULT_CARD_CHECKER, links: "warn" });
    const warned = await say(text);
    expect(warned.status).toBe(201);
    const posted = (await warned.json()) as { card: string; warnings: string[] };
    expect(posted.warnings).toEqual([
      `card ${posted.card}: 1 private link, which the card would show cut as https:[redacted]; send it to the owner in one email to himself, then add an email button (rivet card add … --email-button "<subject>")`,
    ]);
    const stored = server.app.store.getBoard()!.board.needs.find((need) => need.id === posted.card)!;
    expect(stored.ask).toContain("[redacted]");
    expect(stored.ask).not.toContain("docs.google.com");
  });

  it("judges the options again when a merge card becomes a decision card", async () => {
    const still = await upload(png(400, 900), "image/png");
    const looks = [{ label: "Calm", recommended: true }, { label: "Bold" }];
    const media = { kind: "stills", stills: [{ sha256: still, type: "image/png" }] };
    expect((await send("PUT", "/api/board/needs/pick", { kind: "merge-ready", title: "Merge the banner", pr: 1, headSha: "a".repeat(40), options: looks, media })).status).toBe(200);
    const refused = await send("PATCH", "/api/board/needs/pick", { kind: "decision", headSha: null });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toBe("card checker: card pick: 2 options but 1 still; put every option's picture on the card (one --still each)");
  });

  it("re-judges no stored still when a merge card becomes a decision card", async () => {
    await setKnobs({ ...DEFAULT_CARD_CHECKER, stills: "warn" });
    const still = await upload(png(1700, 20), "image/png");
    const media = { kind: "stills", stills: [{ sha256: still, type: "image/png" }] };
    const answers = [{ label: "Approve", recommended: true }, { label: "Change it" }];
    expect((await send("PUT", "/api/board/needs/pick", { kind: "merge-ready", title: "Merge the banner", pr: 1, headSha: "a".repeat(40), options: answers, media })).status).toBe(200);
    await setKnobs({ ...DEFAULT_CARD_CHECKER, stills: "block" });
    const moved = await send("PATCH", "/api/board/needs/pick", { kind: "decision", headSha: null });
    expect(moved.status).toBe(200);
    expect(await moved.json()).not.toHaveProperty("warnings");
  });

  it("judges a private link that redacts to the stored one, sent with new proof", async () => {
    const link = "https://h.example/p";
    expect((await send("PUT", "/api/board/needs/pick", { kind: "decision", title: "Pick a look", links: [{ label: "Lab", url: link }], evidence: { ci: "running" } })).status).toBe(200);
    const refused = await send("PATCH", "/api/board/needs/pick", { links: [{ label: "Lab", url: `${link}?access_token=ghp_${"a1B2c3D4e5".repeat(4)}` }], evidence: { ci: "green" } });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toContain("card pick: 1 private link");
  });

  it("checks nothing while it is off", async () => {
    await setKnobs({ ...DEFAULT_CARD_CHECKER, on: false });
    const still = await upload(png(400, 900), "image/png");
    const posted = await send("PUT", "/api/board/needs/pick", { kind: "decision", title: "Pick a look", options, media: { kind: "stills", stills: [{ sha256: still, type: "image/png" }] } });
    expect(posted.status).toBe(200);
    expect(await posted.json()).not.toHaveProperty("warnings");
  });
});
