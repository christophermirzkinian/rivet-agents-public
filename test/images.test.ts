import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BATCH_QUIET_MS, CommandStore } from "../src/server/commandstore.js";
import { BridgeChannel } from "../src/server/events.js";
import { HttpError } from "../src/server/httputil.js";
import { MEDIA_GRACE_MS, MediaStore } from "../src/server/media.js";
import type { Reply } from "../src/shared/board.js";
import { MAX_CHAT_IMAGES, MAX_IMAGE_BYTES, type AuditEntry, type ChatPage } from "../src/shared/command.js";
import {
  bearer,
  BOARD_TOKEN,
  BRIDGE_TOKEN,
  browser,
  EXAMPLE_BOARD,
  fakeClock,
  ORIGIN,
  oversizedStatus,
  putBoard,
  rawGet,
  revOf,
  startServer,
  waitForStatus,
  type TestServer,
} from "./helpers.js";

// Images you attach: upload, store, send and the bridge's fetch.

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(120, 5)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 1)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(120, 2)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(120, 7)]);
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

const upload = (body: Buffer, type = "image/jpeg", headers: Record<string, string> = browser(cookie), path = "/api/images") =>
  fetch(`${server.base}${path}`, { method: "POST", headers: { ...headers, "content-type": type }, body: new Uint8Array(body) });

const mediaDir = () => join(server.webRoot, "..", "data", "media");

async function uploaded(body: Buffer, type?: string): Promise<string> {
  const response = await upload(body, type);
  expect(response.status).toBe(201);
  return ((await response.json()) as { image: string }).image;
}

/** Collects the bridge's SSE events; `features` is the header a bridge build sends (null: an old bridge sends none). */
async function connectBridge(features: string | null = "image") {
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

describe("upload", () => {
  it("stores a JPEG or PNG under the sha256 it computes and serves it to the session", async () => {
    const response = await upload(JPEG);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ image: sha(JPEG), type: "image/jpeg", size: JPEG.length });
    expect((await upload(JPEG)).status).toBe(200);
    // The type comes from the bytes: a PNG sent as text/plain is still a PNG.
    expect(await (await upload(PNG, "text/plain")).json()).toMatchObject({ image: sha(PNG), type: "image/png" });
    expect(readdirSync(mediaDir()).sort()).toEqual([sha(JPEG), sha(PNG)].sort());

    const served = await fetch(`${server.base}/media/${sha(PNG)}`, { headers: { cookie } });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("refuses anything that is not a JPEG or PNG by its first bytes, whatever it claims", async () => {
    for (const [body, type] of [
      [Buffer.from("<svg onload=alert(1)>"), "image/jpeg"],
      [HEIC, "image/heic"],
      [MP4, "image/png"],
      [Buffer.from("GIF89a" + "x".repeat(50)), "image/gif"],
    ] as const) {
      const response = await upload(body, type);
      expect(response.status, type).toBe(415);
      expect(((await response.json()) as { error: string }).error).toBe("that file is not a JPEG or PNG image");
    }
    expect((await upload(Buffer.alloc(0))).status).toBe(400);
    expect(readdirSync(mediaDir())).toEqual([]);
  });

  it("refuses an image over 8 MB with a clear message, declared or streamed", async () => {
    const declared = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: server.port,
          method: "POST",
          path: "/api/images",
          headers: { ...browser(cookie), "content-type": "image/jpeg", "content-length": String(MAX_IMAGE_BYTES + 1) },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(declared.status).toBe(413);
    expect(JSON.parse(declared.body)).toEqual({ error: "The image is over 8 MB. Pick a smaller one or take a screenshot of it." });

    const big = Buffer.concat([JPEG, Buffer.alloc(MAX_IMAGE_BYTES, 1)]);
    expect(await oversizedStatus(upload(big))).toBe(413);
    expect(readdirSync(mediaDir())).toEqual([]);
  });

  it("names nothing after the upload: a path or name in the request never reaches the disk", async () => {
    const response = await upload(JPEG, "image/jpeg", { ...browser(cookie), "content-disposition": 'attachment; filename="../../evil.jpg"' }, "/api/images?name=../../evil.jpg");
    expect(response.status).toBe(201);
    expect(readdirSync(mediaDir())).toEqual([sha(JPEG)]);
    expect(existsSync(join(server.webRoot, "..", "evil.jpg"))).toBe(false);
    for (const path of ["/api/images/../../secret.txt", "/api/images/x"]) {
      const res = await fetch(`${server.base}${path}`, { method: "POST", headers: browser(cookie), body: new Uint8Array(JPEG) });
      expect([404, 405], path).toContain(res.status);
    }
  });

  it("needs the passkey session and the CSRF headers; no bearer token uploads", async () => {
    expect((await upload(JPEG, "image/jpeg", { origin: ORIGIN, "x-rivet": "1" })).status).toBe(401);
    expect((await upload(JPEG, "image/jpeg", { ...bearer(BOARD_TOKEN), origin: ORIGIN, "x-rivet": "1" })).status).toBe(401);
    expect((await upload(JPEG, "image/jpeg", { ...bearer(BRIDGE_TOKEN), origin: ORIGIN, "x-rivet": "1" })).status).toBe(401);
    expect((await upload(JPEG, "image/jpeg", { cookie })).status).toBe(403);
    expect((await upload(JPEG, "image/jpeg", { cookie, origin: "https://evil.example", "x-rivet": "1" })).status).toBe(403);
    expect(readdirSync(mediaDir())).toEqual([]);
  });
});

describe("fetch", () => {
  it("the app's view needs the session; the bridge's needs the bridge token and gets images only", async () => {
    const image = await uploaded(JPEG);
    expect((await fetch(`${server.base}/media/${image}`)).status).toBe(401);
    expect((await fetch(`${server.base}/media/${image}`, { headers: bearer(BRIDGE_TOKEN) })).status).toBe(401);

    const bridged = await fetch(`${server.base}/api/bridge/media/${image}`, { headers: bearer(BRIDGE_TOKEN) });
    expect(bridged.status).toBe(200);
    expect(Buffer.from(await bridged.arrayBuffer()).equals(JPEG)).toBe(true);
    expect((await fetch(`${server.base}/api/bridge/media/${image}`)).status).toBe(401);
    expect((await fetch(`${server.base}/api/bridge/media/${image}`, { headers: { cookie } })).status).toBe(401);
    expect((await fetch(`${server.base}/api/bridge/media/${image}`, { headers: bearer(BOARD_TOKEN) })).status).toBe(401);

    // A board clip is not an image: the bridge's route never serves it.
    expect((await fetch(`${server.base}/api/bridge/media/${sha(MP4)}`, { method: "PUT", headers: { ...bearer(BOARD_TOKEN), "content-type": "video/mp4" }, body: new Uint8Array(MP4) })).status).toBe(201);
    expect((await fetch(`${server.base}/api/bridge/media/${sha(MP4)}`, { headers: bearer(BRIDGE_TOKEN) })).status).toBe(404);
    expect((await fetch(`${server.base}/api/bridge/media/${"a".repeat(64)}`, { headers: bearer(BRIDGE_TOKEN) })).status).toBe(404);
  });

  it("serves a board video to the bridge token only, at its own route; images stay on theirs", async () => {
    const put = await fetch(`${server.base}/api/bridge/media/${sha(MP4)}`, { method: "PUT", headers: { ...bearer(BOARD_TOKEN), "content-type": "video/mp4" }, body: new Uint8Array(MP4) });
    expect(put.status).toBe(201);
    const image = await uploaded(JPEG);
    const video = await fetch(`${server.base}/api/bridge/video/${sha(MP4)}`, { headers: bearer(BRIDGE_TOKEN) });
    expect(video.status).toBe(200);
    expect(video.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await video.arrayBuffer()).equals(MP4)).toBe(true);
    expect((await fetch(`${server.base}/api/bridge/video/${sha(MP4)}`)).status).toBe(401);
    expect((await fetch(`${server.base}/api/bridge/video/${sha(MP4)}`, { headers: { cookie } })).status).toBe(401);
    expect((await fetch(`${server.base}/api/bridge/video/${sha(MP4)}`, { headers: bearer(BOARD_TOKEN) })).status).toBe(401);
    expect((await fetch(`${server.base}/api/bridge/video/${image}`, { headers: bearer(BRIDGE_TOKEN) })).status).toBe(404);
    expect((await fetch(`${server.base}/api/bridge/video/${"a".repeat(64)}`, { headers: bearer(BRIDGE_TOKEN) })).status).toBe(404);
    expect((await fetch(`${server.base}/api/bridge/media/${sha(MP4)}`, { headers: bearer(BRIDGE_TOKEN) })).status).toBe(404);
    expect((await fetch(`${server.base}/api/bridge/media/${image}`, { headers: bearer(BRIDGE_TOKEN) })).status).toBe(200);
    for (const path of ["/api/bridge/video/../../secret.txt", "/api/bridge/video/..%2F..%2Fsecret.txt", `/api/bridge/video/${"A".repeat(64)}`]) {
      const response = await rawGet(server.port, path, bearer(BRIDGE_TOKEN));
      expect(response.body, path).not.toContain("top secret");
      expect([400, 404], path).toContain(response.status);
    }
  });

  it("never serves a path outside the store to the bridge", async () => {
    for (const path of ["/api/bridge/media/../../secret.txt", "/api/bridge/media/..%2F..%2Fsecret.txt", "/api/bridge/media/%2e%2e/secret.txt", `/api/bridge/media/${"A".repeat(64)}`]) {
      const response = await rawGet(server.port, path, bearer(BRIDGE_TOKEN));
      expect(response.body, path).not.toContain("top secret");
      expect([400, 404], path).toContain(response.status);
    }
  });
});

describe("store pruning", () => {
  it("evicts the least recently used images at the cap and never the board's own media", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rivet-images-"));
    const store = new CommandStore(dataDir);
    const pinned = "f".repeat(64);
    store.putMedia(pinned, "image/png", 100, 1);
    let clock = 1_000;
    // Each upload is past the grace period by the next, so only the board's media are held.
    const media = new MediaStore(dataDir, store, () => new Set([pinned]), 400, () => (clock += MEDIA_GRACE_MS + 1));
    const host = createServer((request, response) => {
      media.uploadImage(request, response).catch((error: unknown) => {
        request.resume();
        response.writeHead(error instanceof HttpError ? error.status : 500).end();
      });
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    const at = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
    const image = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, n]), Buffer.alloc(120, n)]);
    for (const n of [1, 2]) expect((await fetch(at, { method: "POST", body: new Uint8Array(image(n)) })).status).toBe(201);
    expect(store.mediaBytes()).toBe(100 + 2 * 124);
    const third = await fetch(at, { method: "POST", body: new Uint8Array(image(3)) });
    expect(third.status).toBe(201);
    const kept = new Set(store.mediaByAge().map((item) => item.sha));
    expect(kept).toEqual(new Set([pinned, sha(image(2)), sha(image(3))]));
    expect(existsSync(join(dataDir, "media", sha(image(1))))).toBe(false);
    expect(store.mediaBytes()).toBeLessThanOrEqual(400);
    // No room at all once the pinned media fill the cap.
    store.putMedia("e".repeat(64), "video/mp4", 300, 2);
    const full = new MediaStore(dataDir, store, () => new Set([pinned, "e".repeat(64)]), 400);
    const fullHost = createServer((request, response) => {
      full.uploadImage(request, response).catch((error: unknown) => {
        request.resume();
        response.writeHead(error instanceof HttpError ? error.status : 500).end();
      });
    });
    await new Promise<void>((resolve) => fullHost.listen(0, "127.0.0.1", resolve));
    expect((await fetch(`http://127.0.0.1:${(fullHost.address() as AddressInfo).port}`, { method: "POST", body: new Uint8Array(image(4)) })).status).toBe(507);
    expect(readdirSync(join(dataDir, "media")).filter((name) => name.startsWith(".upload-"))).toEqual([]);
    await new Promise((resolve) => host.close(resolve));
    await new Promise((resolve) => fullHost.close(resolve));
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe("sending an image", () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = browser(cookie)) =>
    fetch(`${server.base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

  it("a chat message carries the image to the bridge and back to the thread, with or without text", async () => {
    const image = await uploaded(PNG, "image/png");
    const stream = await connectBridge();
    const withText = (await (await post("/api/chat", { clientId: clientId(), text: "Look at this", image })).json()) as AuditEntry;
    // A window holds one image, so the second photo closes the first window and leads its own.
    const alone = await post("/api/chat", { clientId: clientId(), image });
    expect(alone.status).toBe(202);
    await stream.waitFor(1);
    clock.advance(BATCH_QUIET_MS);
    await stream.waitFor(2);
    expect(stream.events().map((event) => event.data)).toMatchObject([
      { id: withText.id, text: "Look at this", image },
      { image },
    ]);
    expect(stream.events()[1]!.data).not.toHaveProperty("text");
    const page = (await (await fetch(`${server.base}/api/chat`, { headers: { cookie } })).json()) as ChatPage;
    expect(page.messages.map((message) => [message.text, message.image])).toEqual([
      ["Look at this", image],
      ["", image],
    ]);
    stream.abort();
  });

  it("refuses a chat with neither text nor image, an image the store does not have, and a changed retry", async () => {
    expect((await post("/api/chat", { clientId: clientId() })).status).toBe(400);
    expect((await post("/api/chat", { clientId: clientId(), text: "  " })).status).toBe(400);
    expect((await post("/api/chat", { clientId: clientId(), image: "../../secret.txt" })).status).toBe(400);
    const missing = await post("/api/chat", { clientId: clientId(), text: "hi", image: "a".repeat(64) });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "that image is no longer on the server; attach it again" });

    const image = await uploaded(JPEG);
    const stream = await connectBridge();
    const id = clientId();
    expect((await post("/api/chat", { clientId: id, text: "hi", image })).status).toBe(202);
    expect((await post("/api/chat", { clientId: id, text: "hi", image })).status).toBe(200);
    expect((await post("/api/chat", { clientId: id, text: "hi" })).status).toBe(409);
    stream.abort();
  });

  it("takes photos only while the last bridge to connect said it can; text is never held back", async () => {
    const image = await uploaded(JPEG);
    const rev = await revOf(server.base, cookie, "pr2022-checkout");
    const photoChat = () => post("/api/chat", { clientId: clientId(), text: "see this", image });
    const photoReply = () => post("/api/replies", { clientId: clientId(), itemId: "pr2022-checkout", decision: "comment", rev, image });
    const chatCount = async () => ((await (await fetch(`${server.base}/api/chat`, { headers: { cookie } })).json()) as ChatPage).messages.length;

    const restarted = await photoChat();
    expect(restarted.status).toBe(424);
    expect(await restarted.json()).toEqual({ error: "The Mac's bridge hasn't connected since the server restarted. Try the photo again in a minute." });

    // An old bridge sends no header; a malformed header counts as none, and unknown features are ignored.
    for (const header of [null, "image;evil", "IMAGE", "voice, video", "image,", "a".repeat(201)]) {
      const old = await connectBridge(header);
      const chat = await photoChat();
      expect(chat.status).toBe(424);
      expect(await chat.json()).toEqual({ error: "The Mac's bridge needs updating before it can take photos." });
      expect((await photoReply()).status).toBe(424);
      old.abort();
    }
    expect(await chatCount()).toBe(0);
    const old = await connectBridge(null);
    expect((await post("/api/chat", { clientId: clientId(), text: "text still goes" })).status).toBe(202);
    clock.advance(BATCH_QUIET_MS);
    await old.waitFor(1);
    expect(old.events()).toHaveLength(1);
    old.abort();

    const current = await connectBridge("voice, image");
    expect((await photoChat()).status).toBe(202);
    expect((await photoReply()).status).toBe(201);
    clock.advance(BATCH_QUIET_MS);
    // The text chat not yet typed is replayed to the new connection first; the photo's window follows its quiet.
    await current.waitFor(3);
    expect(current.events().map((event) => [event.event, event.data.image])).toEqual([
      ["chat", undefined],
      ["reply", image],
      ["chat", image],
    ]);
    current.abort();

    // The most recent connection counts: an old bridge taking over turns photos off again.
    const downgraded = await connectBridge(null);
    expect((await photoChat()).status).toBe(424);
    downgraded.abort();
  });

  it("a photo accepted while the bridge was away waits for a bridge that takes photos; an old one gets only the text", async () => {
    const image = await uploaded(JPEG);
    const rev = await revOf(server.base, cookie, "pr2022-checkout");
    const able = await connectBridge();
    able.abort();
    const photo = (await (await post("/api/chat", { clientId: clientId(), text: "see this", image })).json()) as AuditEntry;
    clock.advance(BATCH_QUIET_MS);
    await waitForStatus(server.base, cookie, photo.id, "queued");
    const reply = (await (await post("/api/replies", { clientId: clientId(), itemId: "pr2022-checkout", decision: "comment", rev, image })).json()) as Reply;
    const text = (await (await post("/api/chat", { clientId: clientId(), text: "and this" })).json()) as AuditEntry;
    clock.advance(BATCH_QUIET_MS);
    await waitForStatus(server.base, cookie, text.id, "queued");

    const old = await connectBridge(null);
    await old.waitFor(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(old.events().map((event) => [event.event, event.data.id])).toEqual([["chat", text.id]]);
    old.abort();

    const current = await connectBridge();
    await current.waitFor(3);
    expect(current.events().map((event) => [event.event, event.data.id, event.data.image])).toEqual([
      ["reply", reply.id, image],
      ["chat", photo.id, image],
      ["chat", text.id, undefined],
    ]);
    current.abort();
  });

  it.each([null, "image"])("text sent during an open photo window still reaches a bridge downgraded to %s", async (features) => {
    const image = await uploaded(JPEG);
    const attachment = features === null ? { image } : { images: [image, await uploaded(PNG)] };
    const able = await connectBridge("image,images");
    const photo = (await (await post("/api/chat", { clientId: clientId(), text: "see this", ...attachment })).json()) as AuditEntry;
    expect(photo.status).toBe("collecting");
    able.abort();

    const old = await connectBridge(features);
    const response = await post("/api/chat", { clientId: clientId(), text: "text still goes" });
    expect(response.status).toBe(202);
    const text = (await response.json()) as AuditEntry;
    await waitForStatus(server.base, cookie, photo.id, "queued");
    clock.advance(BATCH_QUIET_MS);
    await old.waitFor(1);
    expect(old.events().map((event) => [event.event, event.data.id, event.data.text, event.data.image, event.data.images])).toEqual([
      ["chat", text.id, "text still goes", undefined, undefined],
    ]);
    await waitForStatus(server.base, cookie, photo.id, "queued");
    old.abort();

    const current = await connectBridge("image,images");
    await current.waitFor(2);
    expect(current.events().map((event) => [event.data.id, event.data.text, event.data.image, event.data.images])).toEqual([
      [photo.id, "see this", attachment.image, attachment.images],
      [text.id, "text still goes", undefined, undefined],
    ]);
    current.abort();
  });

  it("the channel never writes a photo event to a connection that did not say it takes photos", () => {
    const written: string[] = [];
    const connection = () =>
      ({ writeHead: () => {}, write: (chunk: string) => written.push(chunk), on: () => {}, end: () => {} }) as unknown as ServerResponse;
    const channel = new BridgeChannel();
    const reply = (image?: string) => ({ id: `r-${image ?? "text"}`, itemId: "x", itemTitle: "X", decision: "comment", rev: "1", at: "", handled: false, item: {}, ...(image ? { image } : {}) }) as unknown as Reply;
    const image = "b".repeat(64);
    channel.attach(connection(), []);
    written.length = 0;
    expect(channel.sendEvent("chat", "c-1", { id: "c-1", text: "see this", image })).toBe(false);
    channel.send(reply(image));
    expect(written).toEqual([]);
    expect(channel.sendEvent("chat", "c-2", { id: "c-2", text: "words" })).toBe(true);
    channel.send(reply());
    expect(written.map((chunk) => chunk.split("\n")[1])).toEqual(["id: c-2", "id: r-text"]);

    channel.attach(connection(), [], new Set(["image"]));
    written.length = 0;
    expect(channel.sendEvent("chat", "c-1", { id: "c-1", text: "see this", image })).toBe(true);
    channel.send(reply(image));
    expect(written.map((chunk) => chunk.split("\n")[1])).toEqual(["id: c-1", `id: r-${image}`]);
    channel.detach();
  });

  it("the channel writes several photos only to a connection that said images", () => {
    const written: string[] = [];
    const connection = () =>
      ({ writeHead: () => {}, write: (chunk: string) => written.push(chunk), on: () => {}, end: () => {} }) as unknown as ServerResponse;
    const channel = new BridgeChannel();
    const images = ["b".repeat(64), "c".repeat(64)];
    channel.attach(connection(), [], new Set(["image", "chat-window"]));
    expect(channel.chatWindowImages()).toBe(1);
    expect(channel.sendEvent("chat", "c-1", { id: "c-1", text: "these", images })).toBe(false);
    expect(channel.sendEvent("chat", "c-2", { id: "c-2", image: images[0] })).toBe(true);
    channel.attach(connection(), [], new Set(["images"]));
    expect(channel.sendEvent("chat", "c-1", { id: "c-1", text: "these", images })).toBe(true);
    channel.attach(connection(), [], new Set(["image", "chat-window", "images"]));
    expect(channel.chatWindowImages()).toBe(MAX_CHAT_IMAGES);
    expect(channel.sendEvent("chat", "c-1", { id: "c-1", text: "these", images })).toBe(true);
    expect(written.filter((chunk) => chunk.startsWith("event:")).map((chunk) => chunk.split("\n")[1])).toEqual(["id: c-2", "id: c-1", "id: c-1"]);
    channel.detach();
  });

  it("a card answer carries the image; a comment may be the image alone", async () => {
    const image = await uploaded(JPEG);
    const stream = await connectBridge();
    const rev = await revOf(server.base, cookie, "pr2022-checkout");
    const response = await post("/api/replies", { clientId: clientId(), itemId: "pr2022-checkout", decision: "comment", rev, image });
    expect(response.status).toBe(201);
    const reply = (await response.json()) as Reply;
    expect(reply.image).toBe(image);
    await stream.waitFor(1);
    expect(stream.events()[0]).toMatchObject({ event: "reply", data: { id: reply.id, decision: "comment", image } });
    expect(((await (await fetch(`${server.base}/api/replies/${reply.id}`, { headers: { cookie } })).json()) as Reply).image).toBe(image);

    const bare = await post("/api/replies", { clientId: clientId(), itemId: "pr2022-checkout", decision: "comment", rev });
    expect(bare.status).toBe(400);
    const gone = await post("/api/replies", { clientId: clientId(), itemId: "pr2022-checkout", decision: "comment", rev, text: "x", image: "b".repeat(64) });
    expect(gone.status).toBe(400);
    const video = await post("/api/replies", { clientId: clientId(), itemId: "pr2022-checkout", decision: "comment", rev, text: "x", image: "../x" });
    expect(video.status).toBe(400);
    stream.abort();
  });

  it("every event carrying an image passes the bridge's own validators", async () => {
    const commandPath = "../bridge/lib/actions/command.mjs";
    const validatePath = "../bridge/lib/validate.mjs";
    const { validateCommand } = (await import(commandPath)) as { validateCommand: (event: string, raw: unknown) => { ok: boolean; value?: unknown } };
    const { validateReply } = (await import(validatePath)) as { validateReply: (raw: unknown) => { ok: boolean; reply?: unknown } };
    const image = await uploaded(JPEG);
    const stream = await connectBridge();
    await post("/api/chat", { clientId: clientId(), image });
    const rev = await revOf(server.base, cookie, EXAMPLE_BOARD.needs[0]!.id);
    await post("/api/replies", { clientId: clientId(), itemId: EXAMPLE_BOARD.needs[0]!.id, decision: "comment", rev, text: "see photo", image });
    clock.advance(BATCH_QUIET_MS);
    await stream.waitFor(2);
    const chat = stream.events().find((event) => event.event === "chat");
    const reply = stream.events().find((event) => event.event === "reply");
    expect(validateCommand(chat!.event, chat!.data)).toMatchObject({ ok: true, value: { image } });
    expect(validateReply(reply!.data)).toMatchObject({ ok: true, reply: { image } });
    stream.abort();
  });
});

describe("several photos in one message", () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = browser(cookie)) =>
    fetch(`${server.base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const ALL = "image,chat-window,images";
  const photo = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(120, 40 + n)]);
  const photos = async (count: number) => Promise.all(Array.from({ length: count }, (_, i) => uploaded(photo(i))));

  it("goes to a bridge that says images as one event, joins the window with a follow-up photo, and comes back to the thread", async () => {
    const commandPath = "../bridge/lib/actions/command.mjs";
    const { validateCommand } = (await import(commandPath)) as { validateCommand: (event: string, raw: unknown) => { ok: boolean; value?: unknown } };
    const [a, b, c, d] = await photos(4);
    const stream = await connectBridge(ALL);
    const first = await post("/api/chat", { clientId: clientId(), text: "Compare these", images: [a, b, c] });
    expect(first.status).toBe(202);
    expect((await first.json()) as AuditEntry).toMatchObject({ status: "collecting", text: "Compare these", images: [a, b, c] });
    clock.advance(3_000);
    const follow = (await (await post("/api/chat", { clientId: clientId(), images: [d] })).json()) as AuditEntry;
    expect(follow).toMatchObject({ status: "collecting", image: d });
    expect(follow).not.toHaveProperty("images");
    clock.advance(BATCH_QUIET_MS);
    await stream.waitFor(1);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(stream.events()).toHaveLength(1);
    expect(stream.events()[0]!.data).toMatchObject({ text: "Compare these", images: [a, b, c, d] });
    expect(stream.events()[0]!.data).not.toHaveProperty("image");
    expect(validateCommand("chat", stream.events()[0]!.data)).toMatchObject({ ok: true, value: { images: [a, b, c, d] } });
    const page = (await (await fetch(`${server.base}/api/chat`, { headers: { cookie } })).json()) as ChatPage;
    expect(page.messages.map((message) => [message.text, message.image, message.images])).toEqual([
      ["Compare these", undefined, [a, b, c]],
      ["", d, undefined],
    ]);
    stream.abort();
  });

  it("one photo sent as images reaches a bridge from before several photos exactly as image does", async () => {
    const [a] = await photos(1);
    const stream = await connectBridge("image,chat-window");
    expect((await post("/api/chat", { clientId: clientId(), text: "just one", images: [a] })).status).toBe(202);
    clock.advance(BATCH_QUIET_MS);
    await stream.waitFor(1);
    // An old bridge reads what it knows; the conversation it was typed in rides beside it.
    expect(Object.keys(stream.events()[0]!.data).sort()).toEqual(["at", "conversation", "id", "image", "text"]);
    expect(stream.events()[0]!.data).toMatchObject({ text: "just one", image: a });
    stream.abort();
  });

  it("refuses more than 10, a repeat, image with images, none, a missing one and more than 40 MB together, whatever the app does", async () => {
    const stream = await connectBridge(ALL);
    const eleven = await photos(MAX_CHAT_IMAGES + 1);
    const [a, b] = eleven;
    for (const body of [
      { images: eleven },
      { images: [a, a] },
      { image: a, images: [b] },
      { images: [] },
      { text: "hi", images: [a, "../../secret.txt"] },
      { text: "hi", images: a },
    ]) {
      expect((await post("/api/chat", { clientId: clientId(), ...body })).status, JSON.stringify(body)).toBe(400);
    }
    const missing = await post("/api/chat", { clientId: clientId(), text: "hi", images: [a, "e".repeat(64)] });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "that image is no longer on the server; attach it again" });

    // Sizes as the server stored them: six 8 MB photos pass the per-image cap but not the 40 MB total.
    const seed = new CommandStore(join(server.webRoot, "..", "data"));
    const big = Array.from({ length: 6 }, (_, i) => String(i).repeat(64));
    for (const sha of big) seed.putMedia(sha, "image/jpeg", MAX_IMAGE_BYTES, Date.now());
    seed.close();
    const heavy = await post("/api/chat", { clientId: clientId(), images: big });
    expect(heavy.status).toBe(413);
    expect(await heavy.json()).toEqual({ error: "Those photos come to more than 40 MB together. Send some of them in another message." });
    expect((await post("/api/chat", { clientId: clientId(), images: big.slice(0, 5) })).status).toBe(202);

    const ten = eleven.slice(0, MAX_CHAT_IMAGES);
    const id = clientId();
    expect((await post("/api/chat", { clientId: id, images: ten })).status).toBe(202);
    expect((await post("/api/chat", { clientId: id, images: ten })).status).toBe(200);
    expect((await post("/api/chat", { clientId: id, images: [...ten].reverse() })).status).toBe(409);
    expect((await post("/api/chat", { clientId: id, images: ten.slice(0, 9) })).status).toBe(409);
    stream.abort();
  });

  it("waits for a bridge that says images: an older one takes the text and single photos around it, and the upgraded one gets it after a reconnect", async () => {
    const [a, b, c, d, e] = await photos(5);
    const able = await connectBridge(ALL);
    const many = (await (await post("/api/chat", { clientId: clientId(), text: "these", images: [a, b] })).json()) as AuditEntry;
    able.abort();
    const old = await connectBridge("image,chat-window");
    clock.advance(BATCH_QUIET_MS);
    await waitForStatus(server.base, cookie, many.id, "queued");

    const text = (await (await post("/api/chat", { clientId: clientId(), text: "and this" })).json()) as AuditEntry;
    clock.advance(2_000);
    await post("/api/chat", { clientId: clientId(), image: c });
    // Accepted while the older bridge is connected, not refused: it waits like the first.
    const later = await post("/api/chat", { clientId: clientId(), images: [d, e] });
    expect(later.status).toBe(202);
    const held = (await later.json()) as AuditEntry;
    clock.advance(BATCH_QUIET_MS);
    await old.waitFor(1);
    await waitForStatus(server.base, cookie, held.id, "queued");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(old.events().map((event) => [event.data.id, event.data.text, event.data.image, event.data.images])).toEqual([[text.id, "and this", c, undefined]]);
    old.abort();

    const upgraded = await connectBridge(ALL);
    await upgraded.waitFor(3);
    expect(upgraded.events().map((event) => [event.data.id, event.data.images])).toEqual([
      [many.id, [a, b]],
      [text.id, undefined],
      [held.id, [d, e]],
    ]);
    upgraded.abort();
  });
});

describe("several photos with a card answer", () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = browser(cookie)) =>
    fetch(`${server.base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const ALL = "image,chat-window,images,files,reply-images";
  const photo = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(120, 90 + n)]);
  const photos = async (count: number) => Promise.all(Array.from({ length: count }, (_, i) => uploaded(photo(i))));
  const ITEM = "pr2022-checkout";

  it("go to a bridge that says reply-images as one reply, pass its validator, and list for the attachments script", async () => {
    const validatePath = "../bridge/lib/validate.mjs";
    const { validateReply } = (await import(validatePath)) as { validateReply: (raw: unknown) => { ok: boolean; reply?: unknown } };
    const [a, b, c] = await photos(3);
    const stream = await connectBridge(ALL);
    const rev = await revOf(server.base, cookie, ITEM);
    const response = await post("/api/replies", { clientId: clientId(), itemId: ITEM, decision: "comment", rev, text: "these three", images: [a, b, c] });
    expect(response.status).toBe(201);
    const reply = (await response.json()) as Reply;
    expect(reply).toMatchObject({ images: [a, b, c] });
    expect(reply).not.toHaveProperty("image");
    await stream.waitFor(1);
    expect(stream.events()[0]).toMatchObject({ event: "reply", data: { id: reply.id, images: [a, b, c] } });
    expect(validateReply(stream.events()[0]!.data)).toMatchObject({ ok: true, reply: { images: [a, b, c] } });
    expect(((await (await fetch(`${server.base}/api/replies/${reply.id}`, { headers: { cookie } })).json()) as Reply).images).toEqual([a, b, c]);
    const listed = (await (await fetch(`${server.base}/api/board/attachments/${reply.id}`, { headers: bearer(BOARD_TOKEN) })).json()) as { images: { sha256: string }[] };
    expect(listed.images.map((image) => image.sha256)).toEqual([a, b, c]);
    stream.abort();
  });

  it("refuses a photo over the bridge's 8 MB, such as a board still, rather than letting the bridge drop it", async () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(9 * 1024 * 1024, 7)]);
    const bigSha = createHash("sha256").update(big).digest("hex");
    const put = await fetch(`${server.base}/api/bridge/media/${bigSha}`, {
      method: "PUT",
      headers: { ...bearer(BOARD_TOKEN), "content-type": "image/jpeg" },
      body: new Uint8Array(big),
    });
    expect(put.status).toBeLessThan(300);
    const [small] = await photos(1);
    const stream = await connectBridge(ALL);
    const rev = await revOf(server.base, cookie, ITEM);
    for (const body of [{ images: [bigSha, small] }, { image: bigSha }]) {
      const refused = await post("/api/replies", { clientId: clientId(), itemId: ITEM, decision: "comment", rev, ...body });
      expect(refused.status, JSON.stringify(body)).toBe(413);
      expect(await refused.json()).toEqual({ error: "A photo is over 8 MB. Send a smaller one with this answer." });
    }
    stream.abort();
  });

  it("one photo sent as images is kept and sent as image, as a bridge from before several photos expects", async () => {
    const [a] = await photos(1);
    const stream = await connectBridge("image,chat-window,images,files");
    const rev = await revOf(server.base, cookie, ITEM);
    const response = await post("/api/replies", { clientId: clientId(), itemId: ITEM, decision: "comment", rev, images: [a] });
    expect(response.status).toBe(201);
    await stream.waitFor(1);
    expect(stream.events()[0]!.data).toMatchObject({ image: a });
    expect(stream.events()[0]!.data).not.toHaveProperty("images");
    stream.abort();
  });

  it("refuses several photos while the bridge has not said reply-images, and a bad list whatever the app does", async () => {
    const [a, b] = await photos(2);
    const stream = await connectBridge("image,chat-window,images,files");
    const rev = await revOf(server.base, cookie, ITEM);
    const refused = await post("/api/replies", { clientId: clientId(), itemId: ITEM, decision: "comment", rev, images: [a, b] });
    expect(refused.status).toBe(424);
    expect(await refused.json()).toEqual({ error: "The Mac's bridge needs updating before an answer can take several photos. Send one photo for now." });
    for (const body of [{ images: [a, a] }, { image: a, images: [b] }, { images: [] }, { images: [a, "../x"] }, { images: [a, "e".repeat(64)] }]) {
      expect((await post("/api/replies", { clientId: clientId(), itemId: ITEM, decision: "comment", rev, text: "x", ...body })).status, JSON.stringify(body)).toBe(400);
    }
    stream.abort();

    const able = await connectBridge(ALL);
    const id = clientId();
    expect((await post("/api/replies", { clientId: id, itemId: ITEM, decision: "comment", rev, images: [a, b] })).status).toBe(201);
    expect((await post("/api/replies", { clientId: id, itemId: ITEM, decision: "comment", rev, images: [a, b] })).status).toBe(200);
    expect((await post("/api/replies", { clientId: id, itemId: ITEM, decision: "comment", rev, images: [b, a] })).status).toBe(409);
    expect((await post("/api/replies", { clientId: id, itemId: ITEM, decision: "comment", rev, image: a })).status).toBe(409);
    able.abort();
  });

  it("a reply with several photos never goes to a connection that said only images; it waits for one that says reply-images", () => {
    const channel = new BridgeChannel();
    const written: string[] = [];
    const response = { writeHead: () => {}, write: (chunk: string) => written.push(chunk), on: () => {}, end: () => {} } as unknown as ServerResponse;
    const reply = { id: "r-many", images: ["a".repeat(64), "b".repeat(64)], item: { id: "x", title: "x", kind: "decision" } } as unknown as Reply;
    channel.attach(response, [reply], new Set(["image", "images", "files"]));
    expect(written.some((chunk) => chunk.includes("r-many"))).toBe(false);
    channel.attach(response, [reply], new Set(["image", "images", "files", "reply-images"]));
    expect(written.some((chunk) => chunk.includes("r-many"))).toBe(true);
    channel.detach();
  });
});
