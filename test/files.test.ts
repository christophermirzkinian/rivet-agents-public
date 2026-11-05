import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BATCH_QUIET_MS } from "../src/server/commandstore.js";
import { fileDisposition } from "../src/server/media.js";
// @ts-expect-error the fetch script is plain JavaScript
import { checkListing } from "../scripts/attachments.mjs";
// @ts-expect-error the bridge is plain JavaScript
import { FILE_NAME_RE } from "../bridge/lib/validate.mjs";
import { ATTACHMENT_NAME_PATTERN, attachmentName, BIG_TYPES, FILE_TYPES, fileTypeOf, MAX_AV_BYTES, type FileRef, type Reply } from "../src/shared/board.js";
import { MAX_FILE_BYTES, type AuditEntry, type ChatPage } from "../src/shared/command.js";
import {
  bearer,
  BOARD_TOKEN,
  BRIDGE_TOKEN,
  browser,
  fakeClock,
  ORIGIN,
  oversizedStatus,
  putBoard,
  revOf,
  startServer,
  waitForStatus,
  type TestServer,
} from "./helpers.js";

// Documents you attach: upload, type decided by the server, serving, chat and reply, and Rivet's fetch.

const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\ntrailer\n%%EOF\n");
const TEXT = Buffer.from("Line one\nLigne deux — café\n");
const CSV = Buffer.from("a,b\n1,2\n");
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100, 3)]);
const XLS = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(100, 4)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(120, 5)]);
const MOV = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  "), Buffer.alloc(120, 7)]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(120, 8)]);
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4, 0), Buffer.from("WAVEfmt "), Buffer.alloc(120, 9)]);
const AAC = Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80]), Buffer.alloc(120, 10)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(120, 7)]);
const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(120, 11)]);
const FLAC = Buffer.concat([Buffer.from("fLaC"), Buffer.alloc(120, 12)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(120, 13)]);
const HEIF = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmif1"), Buffer.alloc(120, 14)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(120, 15)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(120, 16)]);
const GLB = Buffer.concat([Buffer.from("glTF"), Buffer.from([2, 0, 0, 0]), Buffer.alloc(120, 17)]);
// An email whose HTML part would run a script if a browser ever rendered it.
const EML = Buffer.from(
  'Received: from mail.example.com\r\nFrom: "Sam" <sam@example.com>\r\nSubject: Logo\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body><script>alert(1)</script>Hi</body></html>\r\n',
);
const MBOX_EML = Buffer.from("From - Mon Oct 06 07:53:01 2026\r\nX-Mozilla-Status: 0001\r\nSubject: Hi\r\n\r\nHello\r\n");
const MSG = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(120, 19)]);
const ALL = "image,chat-window,images,files";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

let server: TestServer;
let cookie: string;
let clock: ReturnType<typeof fakeClock>;
let seq = 0;
const clientId = () => `client-${Date.now()}-${(seq += 1)}`;

beforeEach(async () => {
  clock = fakeClock();
  server = await startServer({}, { now: clock.now });
  cookie = server.cookie();
  await putBoard(server.base);
});

afterEach(async () => {
  await server.close();
});

const mediaDir = () => join(server.webRoot, "..", "data", "media");

const upload = (body: Buffer, name: string | null, headers: Record<string, string> = browser(cookie)) =>
  fetch(`${server.base}/api/files`, {
    method: "POST",
    headers: { ...headers, ...(name === null ? {} : { "x-file-name": encodeURIComponent(name) }) },
    body: new Uint8Array(body),
  });

async function uploaded(body: Buffer, name: string): Promise<FileRef> {
  const response = await upload(body, name);
  expect(response.status).toBe(201);
  const { sha256, name: stored } = (await response.json()) as FileRef;
  return { sha256, name: stored };
}

const post = (path: string, body: unknown, headers: Record<string, string> = browser(cookie)) =>
  fetch(`${server.base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

/** Collects the bridge's SSE events; `features` is the header a bridge build sends (null: an old bridge sends none). */
async function connectBridge(features: string | null = ALL) {
  const controller = new AbortController();
  const headers = { ...bearer(BRIDGE_TOKEN), ...(features === null ? {} : { "x-rivet-bridge-features": features }) };
  const response = await fetch(`${server.base}/api/bridge/events`, { headers, signal: controller.signal });
  expect(response.status).toBe(200);
  let buffer = "";
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
      }
    } catch {}
  })();
  const events = () =>
    buffer
      .split("\n\n")
      .filter((block) => block.startsWith("event:"))
      .map((block) => {
        const fields = Object.fromEntries(block.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]));
        return { event: fields.event!, data: JSON.parse(fields.data!) as Record<string, unknown> };
      });
  const waitFor = async (count: number) => {
    for (let i = 0; i < 200 && events().length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events().length).toBeGreaterThanOrEqual(count);
  };
  return { events, waitFor, abort: () => controller.abort() };
}

describe("attachment names", () => {
  it("keeps the character policy, the type's extension, and a fallback", () => {
    expect(attachmentName("../../Evil <script>.PDF", "application/pdf")).toBe("Evil script.pdf");
    expect(attachmentName("notes.log", "text/plain")).toBe("notes.log");
    expect(attachmentName("page.html", "text/plain")).toBe("page.html.txt");
    expect(attachmentName("report.docx", "application/pdf")).toBe("report.docx.pdf");
    expect(attachmentName("\u00ab\u00bb\n\u001b.md", "text/markdown")).toBe("file.md");
    expect(attachmentName("\u001b[31mred.md", "text/markdown")).toBe("31mred.md");
    expect(attachmentName(`${"a".repeat(200)}.csv`, "text/csv")).toBe(`${"a".repeat(96)}.csv`);
    expect(fileTypeOf("Deck.PPTX")).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    for (const name of ["x.html", "x.svg", "x.svgz", "x.exe", "x.rar", "x.gltf", "x.jpg", "x.webp", "x", ".pdf.", "x.toString", "x.constructor"]) expect(fileTypeOf(name), name).toBeNull();
  });

  it("puts a name in the header only once it is clean, inline or as a download by type", () => {
    expect(fileDisposition('a"b\r\nc.pdf', "application/pdf")).toBe(`inline; filename="a b c.pdf"; filename*=UTF-8''a%20b%20c.pdf`);
    expect(fileDisposition("", "text/csv")).toBe(`inline; filename="file.csv"; filename*=UTF-8''file.csv`);
    expect(fileDisposition("Budget (v2).xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(
      `attachment; filename="Budget (v2).xlsx"; filename*=UTF-8''Budget%20%28v2%29.xlsx`,
    );
    expect(fileDisposition("art.zip", "application/zip")).toMatch(/^attachment; /);
    expect(fileDisposition("monkey.glb", "model/gltf-binary")).toMatch(/^attachment; /);
    expect(fileDisposition("dance.gif", "image/gif")).toMatch(/^inline; /);
    expect(fileDisposition("Re: Logo.eml", "message/rfc822")).toBe(`attachment; filename="Re Logo.eml"; filename*=UTF-8''Re%20Logo.eml`);
    expect(fileDisposition("Invoice.msg", "application/vnd.ms-outlook")).toMatch(/^attachment; filename="Invoice\.msg"/);
  });

  it("is the bridge's and the Mac fetch's list too", () => {
    expect(FILE_NAME_RE.source).toBe(ATTACHMENT_NAME_PATTERN.source);
    for (const type of FILE_TYPES) {
      const listed = { files: [{ sha256: "a".repeat(64), name: attachmentName("file", type), type, size: 1 }], images: [] };
      expect(checkListing(listed).items, type).toHaveLength(1);
      const big = { files: [{ ...listed.files[0]!, size: 60 * 1024 * 1024 }], images: [] };
      if ((BIG_TYPES as readonly string[]).includes(type)) expect(checkListing(big).items, type).toHaveLength(1);
      else expect(() => checkListing(big), type).toThrow();
    }
  });
});

describe("upload", () => {
  it("decides the type from the name and the bytes, never the phone's content-type, and names it again", async () => {
    const response = await upload(PDF, "../../Evil <script>.PDF", { ...browser(cookie), "content-type": "text/html" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ sha256: sha(PDF), name: "Evil script.pdf", type: "application/pdf", size: PDF.length });
    const again = await upload(PDF, "Other.pdf");
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ sha256: sha(PDF), name: "Other.pdf", type: "application/pdf", size: PDF.length });

    for (const [body, name, type] of [
      [TEXT, "notes.txt", "text/plain"],
      [CSV, "sheet.csv", "text/csv"],
      [Buffer.from('{"a":1}'), "data.json", "application/json"],
      [DOCX, "Letter.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      [XLS, "old.xls", "application/vnd.ms-excel"],
      [MP4, "Monkey music.mp4", "video/mp4"],
      [MOV, "clip.mov", "video/quicktime"],
      [MP3, "song.mp3", "audio/mpeg"],
      [WAV, "beat.wav", "audio/wav"],
      [AAC, "voice.aac", "audio/aac"],
      [OGG, "voice-20261006-0001.opus", "audio/ogg"],
      [FLAC, "take.flac", "audio/flac"],
      [HEIC, "20261006_075301.heic", "image/heic"],
      [HEIF, "scan.heif", "image/heif"],
      [Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypmif2"), Buffer.alloc(120, 18)]), "edition2.heif", "image/heif"],
      [GIF, "dance.gif", "image/gif"],
      [ZIP, "Art folder.zip", "application/zip"],
      [GLB, "monkey.glb", "model/gltf-binary"],
      [EML, "Logo from Sam.eml", "message/rfc822"],
      [MBOX_EML, "Thunderbird.eml", "message/rfc822"],
      [Buffer.from("X_UIDL: 12345\r\nFrom: a@example.com\r\n\r\nHello\r\n"), "Pop.eml", "message/rfc822"],
      [MSG, "Invoice.msg", "application/vnd.ms-outlook"],
    ] as const) {
      const answer = await upload(body, name);
      expect(answer.status, name).toBe(201);
      expect(await answer.json()).toMatchObject({ sha256: sha(body), name, type });
    }
    // The same bytes as another text type keep their first type, and the name follows it.
    const markdown = await upload(TEXT, "notes.md");
    expect(await markdown.json()).toMatchObject({ type: "text/plain", name: "notes.md.txt" });
    // An email is only ever downloaded: its bytes already here as another type are refused as an email, never shown so;
    // an email's bytes sent again as text stay an email.
    const mail = Buffer.from("From: Sam <sam@example.com>\r\nSubject: Hi\r\nContent-Type: text/html\r\n\r\n<b>Hello</b>\r\n");
    expect(await (await upload(mail, "mail.txt")).json()).toMatchObject({ type: "text/plain", name: "mail.txt" });
    const asEmail = await upload(mail, "mail.eml");
    expect(asEmail.status).toBe(409);
    expect(await asEmail.json()).toMatchObject({ error: "That email was already sent as another kind of file. Send that file again instead." });
    const id3 = Buffer.from("ID3: x\r\nFrom: a@example.com\r\nSubject: hi\r\n\r\nHello\r\n");
    expect(await (await upload(id3, "seed.mp3")).json()).toMatchObject({ type: "audio/mpeg" });
    expect((await upload(id3, "mail.eml")).status).toBe(409);
    const email = Buffer.from("From: Sam <sam@example.com>\r\nSubject: Hi again\r\n\r\nHello\r\n");
    expect(await (await upload(email, "first.eml")).json()).toMatchObject({ type: "message/rfc822", name: "first.eml" });
    expect(await (await upload(email, "again.txt")).json()).toMatchObject({ type: "message/rfc822", name: "again.txt.eml" });
    expect(readdirSync(mediaDir()).every((file) => /^[0-9a-f]{64}$/.test(file))).toBe(true);
  });

  it("refuses types it does not take, and a file that is not what its name says", async () => {
    const refused = "That file type can't be sent. Attach photos, videos, music, PDFs, text files, Office documents, emails, ZIPs or GLB models.";
    const mislabelled = "That file isn't what its name says it is. Attach photos, videos, music, PDFs, text files, Office documents, emails, ZIPs or GLB models.";
    for (const [body, name, error] of [
      [Buffer.from("<html><script>alert(1)</script>"), "page.html", refused],
      [Buffer.from("<svg onload=alert(1)>"), "x.svg", refused],
      [Buffer.from("MZ\x90\x00"), "setup.exe", refused],
      [ZIP, "bundle.rar", refused],
      [Buffer.from("<svg onload=alert(1)>"), "x.svgz", refused],
      [JPEG, "photo.jpg", refused],
      [Buffer.from("<html><script>alert(1)</script>"), "paper.pdf", mislabelled],
      [Buffer.from("not a zip at all"), "Letter.docx", mislabelled],
      [DOCX, "old.doc", mislabelled],
      [Buffer.from("<html><script>alert(1)</script>"), "song.mp4", mislabelled],
      [PDF, "song.mp3", mislabelled],
      [MP4, "beat.wav", mislabelled],
      [MP3, "voice.opus", mislabelled],
      [OGG, "take.flac", mislabelled],
      [JPEG, "photo.heic", mislabelled],
      [MP4, "photo.heic", mislabelled],
      [Buffer.from("<svg onload=alert(1)>"), "dance.gif", mislabelled],
      [Buffer.from("<html><script>alert(1)</script>"), "art.zip", mislabelled],
      [Buffer.concat([Buffer.from("glTF"), Buffer.from([1, 0, 0, 0]), Buffer.alloc(40)]), "old.glb", mislabelled],
      [ZIP, "monkey.glb", mislabelled],
      [Buffer.from("<html><script>alert(1)</script>"), "mail.eml", mislabelled],
      [Buffer.from("<!DOCTYPE html><html><body>hi</body></html>"), "mail.eml", mislabelled],
      [PDF, "mail.eml", mislabelled],
      [Buffer.from("From: a"), "short.eml", mislabelled],
      [DOCX, "mail.msg", mislabelled],
      [EML, "mail.msg", mislabelled],
    ] as const) {
      const response = await upload(body, name);
      expect(response.status, name).toBe(415);
      expect(((await response.json()) as { error: string }).error, name).toBe(error);
    }
    for (const body of [Buffer.from([0x68, 0x69, 0xff, 0xfe]), Buffer.from("hi\u0000there"), Buffer.from([0x68, 0x69, 0xe2, 0x82])]) {
      const response = await upload(body, "notes.txt");
      expect(response.status).toBe(415);
      expect(((await response.json()) as { error: string }).error).toContain("isn't plain UTF-8 text");
    }
    expect((await upload(Buffer.alloc(0), "empty.txt")).status).toBe(400);
    expect(readdirSync(mediaDir()).filter((file) => !file.startsWith("."))).toEqual([]);
  });

  it("needs a name that decodes, a session and the app's own origin", async () => {
    expect((await upload(PDF, null)).status).toBe(400);
    const garbled = await fetch(`${server.base}/api/files`, {
      method: "POST",
      headers: { ...browser(cookie), "x-file-name": "%E0%A4%A.pdf" },
      body: new Uint8Array(PDF),
    });
    expect(garbled.status).toBe(400);
    expect((await upload(PDF, "a.pdf", { origin: ORIGIN, "x-rivet": "1" })).status).toBe(401);
    expect((await upload(PDF, "a.pdf", { cookie, "x-rivet": "1" })).status).toBe(403);
    expect((await upload(PDF, "a.pdf", bearer(BOARD_TOKEN))).status).toBe(403);
  });

  it("refuses a file over 25 MB, declared or streamed", async () => {
    const declared = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: server.port,
          method: "POST",
          path: "/api/files",
          headers: { ...browser(cookie), "x-file-name": "big.pdf", "content-length": String(MAX_FILE_BYTES + 1) },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(declared).toBe(413);
    const big = Buffer.concat([PDF, Buffer.alloc(MAX_FILE_BYTES, 0x20)]);
    expect(await oversizedStatus(upload(big, "big.pdf"))).toBe(413);
    expect(readdirSync(mediaDir()).filter((file) => !file.startsWith("."))).toEqual([]);
  });

  it("takes a video or sound file up to 100 MB, not over", async () => {
    const video = Buffer.concat([MP4, Buffer.alloc(MAX_FILE_BYTES, 0x20)]);
    const taken = await upload(video, "music.mp4");
    expect(taken.status).toBe(201);
    expect(await taken.json()).toMatchObject({ sha256: sha(video), name: "music.mp4", type: "video/mp4", size: video.length });
    const huge = Buffer.concat([MP4, Buffer.alloc(MAX_AV_BYTES, 0x20)]);
    expect(await oversizedStatus(upload(huge, "huge.mp4"))).toBe(413);
    const folder = Buffer.concat([ZIP, Buffer.alloc(MAX_FILE_BYTES, 0x20)]);
    expect(await upload(folder, "sounds.zip").then((response) => response.status)).toBe(201);
    const gif = Buffer.concat([GIF, Buffer.alloc(MAX_FILE_BYTES, 0x20)]);
    expect(await oversizedStatus(upload(gif, "big.gif"))).toBe(413);
    const mail = Buffer.concat([EML, Buffer.alloc(MAX_FILE_BYTES, 0x20)]);
    expect(await oversizedStatus(upload(mail, "big.eml"))).toBe(413);
  });

  it("takes two video or sound uploads at once, not a third", async () => {
    const open = () => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: server.port,
        method: "POST",
        path: "/api/files",
        headers: { ...browser(cookie), "x-file-name": "slow.mp4", "content-length": String(50 * 1024 * 1024) },
      });
      req.on("error", () => {});
      req.write(MP4);
      return req;
    };
    const slow = [open(), open()];
    await new Promise((resolve) => setTimeout(resolve, 200));
    const third = await upload(MP4, "third.mp4");
    expect(third.status).toBe(429);
    expect((await upload(PDF, "paper.pdf")).status).toBe(201);
    for (const req of slow) req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await upload(MP4, "after.mp4")).status).toBe(201);
  });

  it("serves video and sound playable in the browser's own player, and waits long enough for one", async () => {
    const clip = await uploaded(MP4, "clip.mp4");
    const served = await fetch(`${server.base}/media/${clip.sha256}?name=clip.mp4`, { headers: { cookie } });
    expect(served.headers.get("content-type")).toBe("video/mp4");
    expect(served.headers.get("content-security-policy")).toBe("default-src 'none'; media-src 'self'; frame-ancestors 'none'");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(server.app.server.requestTimeout).toBeGreaterThanOrEqual(15 * 60 * 1000);
  });

  it("lets the Mac's fetch take a video up to 100 MB and a document only up to 25 MB", () => {
    const listing = (type: string, name: string, size: number) => ({ files: [{ sha256: "a".repeat(64), name, type, size }], images: [] });
    expect(checkListing(listing("video/mp4", "music.mp4", 60 * 1024 * 1024)).items).toHaveLength(1);
    expect(() => checkListing(listing("video/mp4", "music.mp4", 100 * 1024 * 1024 + 1))).toThrow();
    expect(() => checkListing(listing("application/pdf", "big.pdf", 60 * 1024 * 1024))).toThrow();
  });
});

describe("serving", () => {
  it("sandboxes every document, never sniffed, text always as plain text, Office as a download", async () => {
    const markdown = Buffer.from("# <script>alert(1)</script>\n");
    const json = Buffer.from('{"html":"<b>"}');
    for (const [body, name] of [
      [markdown, "notes.md"],
      [json, "data.json"],
      [CSV, "sheet.csv"],
      [PDF, "paper.pdf"],
      [DOCX, "Letter.docx"],
      [EML, "Logo.eml"],
      [MSG, "Invoice.msg"],
    ] as const)
      await uploaded(body, name);
    const get = (hash: string, query = "") => fetch(`${server.base}/media/${hash}${query}`, { headers: { cookie } });

    for (const body of [markdown, json, CSV]) {
      const response = await get(sha(body), "?name=page.html");
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; frame-ancestors 'none'");
      expect(response.headers.get("content-disposition")).toMatch(/^inline; filename="page\.html\.(md|json|csv)"/);
    }
    const pdf = await get(sha(PDF), "?name=Paper.pdf");
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toBe(`inline; filename="Paper.pdf"; filename*=UTF-8''Paper.pdf`);
    const docx = await get(sha(DOCX), "?name=Letter.docx");
    expect(docx.headers.get("content-disposition")).toMatch(/^attachment; filename="Letter\.docx"/);
    expect(docx.headers.get("content-security-policy")).toContain("sandbox");
    // An email only ever downloads, sandboxed: its HTML is never rendered.
    for (const [body, name, type] of [
      [EML, "Logo.eml", "message/rfc822"],
      [MSG, "Invoice.msg", "application/vnd.ms-outlook"],
    ] as const) {
      const response = await get(sha(body), `?name=${name}`);
      expect(response.headers.get("content-type"), name).toBe(type);
      expect(response.headers.get("content-disposition"), name).toMatch(new RegExp(`^attachment; filename="${name.replace(".", "\\.")}"`));
      expect(response.headers.get("content-security-policy"), name).toBe("sandbox; default-src 'none'; frame-ancestors 'none'");
      expect(response.headers.get("x-content-type-options"), name).toBe("nosniff");
      expect(Buffer.from(await response.arrayBuffer()).equals(body), name).toBe(true);
    }
    expect((await fetch(`${server.base}/media/${sha(PDF)}`)).status).toBe(401);
  });
});

describe("chat and replies", () => {
  it("sends files with a chat message to a bridge that says files, and shows them in the thread", async () => {
    const pdf = await uploaded(PDF, "Paper.pdf");
    const text = await uploaded(TEXT, "notes.txt");
    const stream = await connectBridge();
    const sent = await post("/api/chat", { clientId: clientId(), files: [pdf, text] });
    expect(sent.status).toBe(202);
    const entry = (await sent.json()) as AuditEntry;
    expect(entry.files).toEqual([pdf, text]);
    clock.advance(BATCH_QUIET_MS);
    await stream.waitFor(1);
    expect(stream.events()[0]).toMatchObject({ event: "chat", data: { id: entry.id, files: [pdf, text] } });
    expect(stream.events()[0]!.data.text).toBeUndefined();
    const page = (await (await fetch(`${server.base}/api/chat`, { headers: { cookie } })).json()) as ChatPage;
    expect(page.messages.at(-1)).toMatchObject({ id: entry.id, files: [pdf, text] });
    stream.abort();
  });

  it("names a file again for its stored type, and refuses one the store does not have", async () => {
    const pdf = await uploaded(PDF, "Paper.pdf");
    const stream = await connectBridge();
    const renamed = (await (await post("/api/chat", { clientId: clientId(), text: "see", files: [{ sha256: pdf.sha256, name: "Paper.docx" }] })).json()) as AuditEntry;
    expect(renamed.files).toEqual([{ sha256: pdf.sha256, name: "Paper.docx.pdf" }]);
    // An identical retry of a renamed file is the same request, not a 409; so is one naming the same bytes otherwise.
    const retryId = clientId();
    const sent = (await (await post("/api/chat", { clientId: retryId, files: [{ sha256: pdf.sha256, name: "a  b.pdf" }] })).json()) as AuditEntry;
    for (const name of ["a  b.pdf", "Final.pdf"]) {
      const retry = await post("/api/chat", { clientId: retryId, files: [{ sha256: pdf.sha256, name }] });
      expect(retry.status).toBe(200);
      expect(((await retry.json()) as AuditEntry).id).toBe(sent.id);
    }

    const missing = await post("/api/chat", { clientId: clientId(), files: [{ sha256: "a".repeat(64), name: "gone.pdf" }] });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "that file is no longer on the server; attach it again" });
    // A photo in the store is not a file.
    const photo = (await (await fetch(`${server.base}/api/images`, { method: "POST", headers: { ...browser(cookie), "content-type": "image/jpeg" }, body: new Uint8Array(JPEG) })).json()) as { image: string };
    expect((await post("/api/chat", { clientId: clientId(), files: [{ sha256: photo.image, name: "photo.pdf" }] })).status).toBe(400);
    for (const files of [[], [pdf, pdf], [{ sha256: pdf.sha256, name: "../x.pdf" }], [{ sha256: pdf.sha256, name: "x.html" }], Array.from({ length: 6 }, () => pdf)])
      expect((await post("/api/chat", { clientId: clientId(), files })).status).toBe(400);
    stream.abort();
  });

  it("opens the next window when a message's files would take one past 5", async () => {
    const files = await Promise.all(Array.from({ length: 6 }, (_, i) => uploaded(Buffer.from(`note ${i}\n`), `note ${i}.txt`)));
    const stream = await connectBridge();
    const first = (await (await post("/api/chat", { clientId: clientId(), files: files.slice(0, 3) })).json()) as AuditEntry;
    const second = (await (await post("/api/chat", { clientId: clientId(), files: files.slice(3, 6) })).json()) as AuditEntry;
    await stream.waitFor(1);
    expect(stream.events()[0]!.data).toMatchObject({ id: first.id, files: files.slice(0, 3) });
    clock.advance(BATCH_QUIET_MS);
    await stream.waitFor(2);
    expect(stream.events()[1]!.data).toMatchObject({ id: second.id, files: files.slice(3, 6) });
    stream.abort();
  });

  it("takes files only while the last bridge said it can; one accepted before waits for such a bridge", async () => {
    const pdf = await uploaded(PDF, "Paper.pdf");
    const rev = await revOf(server.base, cookie, "pr2022-checkout");
    const fileChat = () => post("/api/chat", { clientId: clientId(), text: "read this", files: [pdf] });
    const fileReply = () => post("/api/replies", { clientId: clientId(), itemId: "pr2022-checkout", decision: "comment", rev, files: [pdf] });

    const restarted = await fileChat();
    expect(restarted.status).toBe(424);
    expect(await restarted.json()).toEqual({ error: "The Mac's bridge hasn't connected since the server restarted. Try the file again in a minute." });
    const old = await connectBridge("image,chat-window,images");
    const refused = await fileChat();
    expect(refused.status).toBe(424);
    expect(await refused.json()).toEqual({ error: "The Mac's bridge needs updating before it can take files." });
    expect((await fileReply()).status).toBe(424);
    old.abort();

    const able = await connectBridge();
    able.abort();
    const held = (await (await fileChat()).json()) as AuditEntry;
    const reply = (await (await fileReply()).json()) as Reply;
    expect(reply.files).toEqual([pdf]);
    clock.advance(BATCH_QUIET_MS);
    await waitForStatus(server.base, cookie, held.id, "queued");
    const older = await connectBridge("image,chat-window,images");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(older.events()).toEqual([]);
    older.abort();
    const upgraded = await connectBridge();
    await upgraded.waitFor(2);
    expect(upgraded.events().map((event) => [event.event, event.data.id, event.data.files])).toEqual([
      ["reply", reply.id, [pdf]],
      ["chat", held.id, [pdf]],
    ]);
    upgraded.abort();
  });

  it("a reply carries files: a comment may be files alone, a retry must name the same ones", async () => {
    const pdf = await uploaded(PDF, "Paper.pdf");
    const text = await uploaded(TEXT, "notes.txt");
    const rev = await revOf(server.base, cookie, "pr2022-checkout");
    const stream = await connectBridge();
    const reply = (body: Record<string, unknown>) => post("/api/replies", { itemId: "pr2022-checkout", decision: "comment", rev, ...body });
    expect((await reply({ clientId: clientId() })).status).toBe(400);
    expect((await reply({ clientId: clientId(), files: [{ sha256: "b".repeat(64), name: "gone.pdf" }] })).status).toBe(400);
    const id = clientId();
    const first = await reply({ clientId: id, files: [pdf] });
    expect(first.status).toBe(201);
    expect(((await first.json()) as Reply).files).toEqual([pdf]);
    expect((await reply({ clientId: id, files: [pdf] })).status).toBe(200);
    expect((await reply({ clientId: id, files: [{ sha256: pdf.sha256, name: "Paper.docx" }] })).status).toBe(200);
    expect((await reply({ clientId: id, files: [text] })).status).toBe(409);
    expect((await reply({ clientId: id })).status).toBe(409);
    stream.abort();
  });
});

describe("Rivet's fetch", () => {
  const board = (path: string, token = BOARD_TOKEN) => fetch(`${server.base}${path}`, { headers: { authorization: `Bearer ${token}` } });

  it("lists a whole window's files and photos by its lead, and a reply's, with the board token only", async () => {
    const pdf = await uploaded(PDF, "Paper.pdf");
    const text = await uploaded(TEXT, "notes.txt");
    const photo = ((await (await fetch(`${server.base}/api/images`, { method: "POST", headers: { ...browser(cookie), "content-type": "image/jpeg" }, body: new Uint8Array(JPEG) })).json()) as { image: string }).image;
    const stream = await connectBridge();
    const lead = (await (await post("/api/chat", { clientId: clientId(), text: "one", files: [pdf], image: photo })).json()) as AuditEntry;
    const member = (await (await post("/api/chat", { clientId: clientId(), files: [text, pdf] })).json()) as AuditEntry;

    const listed = await board(`/api/board/attachments/${lead.id}`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      id: lead.id,
      files: [
        { sha256: pdf.sha256, name: "Paper.pdf", type: "application/pdf", size: PDF.length },
        { sha256: text.sha256, name: "notes.txt", type: "text/plain", size: TEXT.length },
      ],
      images: [{ sha256: photo, type: "image/jpeg", size: JPEG.length }],
      missing: 0,
    });
    expect(((await (await board(`/api/board/attachments/${member.id}`)).json()) as { files: FileRef[] }).files.map((file) => file.name)).toEqual([
      "notes.txt",
      "Paper.pdf",
    ]);

    const rev = await revOf(server.base, cookie, "pr2022-checkout");
    const reply = (await (await post("/api/replies", { clientId: clientId(), itemId: "pr2022-checkout", decision: "comment", rev, files: [text] })).json()) as Reply;
    expect(await (await board(`/api/board/attachments/${reply.id}`)).json()).toMatchObject({ id: reply.id, files: [{ name: "notes.txt" }], images: [] });

    expect((await fetch(`${server.base}/api/board/attachments/${lead.id}`, { headers: { cookie } })).status).toBe(401);
    expect((await board(`/api/board/attachments/${lead.id}`, BRIDGE_TOKEN)).status).toBe(401);
    expect((await board("/api/board/attachments/nope")).status).toBe(404);
    expect((await board("/api/board/attachments/..")).status).toBe(404);
    stream.abort();
  });

  it("serves an attachment to the board token with the safe headers, and nothing else", async () => {
    const pdf = await uploaded(PDF, "Paper.pdf");
    const served = await board(`/api/board/media/${pdf.sha256}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await served.arrayBuffer()).equals(PDF)).toBe(true);

    const clip = sha(MP4);
    const put = await fetch(`${server.base}/api/bridge/media/${clip}`, { method: "PUT", headers: { ...bearer(BOARD_TOKEN), "content-type": "video/mp4" }, body: new Uint8Array(MP4) });
    expect(put.status).toBe(201);
    // An mp4 is a type you attach too, so a card's own clip reads back like one.
    expect((await board(`/api/board/media/${clip}`)).status).toBe(200);
    expect((await board(`/api/board/media/${"c".repeat(64)}`)).status).toBe(404);
    expect((await board(`/api/board/media/${pdf.sha256}`, BRIDGE_TOKEN)).status).toBe(401);
    expect((await fetch(`${server.base}/api/board/media/${pdf.sha256}`, { headers: { cookie } })).status).toBe(401);
  });
});
