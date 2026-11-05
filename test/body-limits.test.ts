import { readdirSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HttpError, readJson } from "../src/server/httputil.js";
import { MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_MEDIA_BYTES } from "../src/shared/command.js";
import { probeBodyBudget } from "./body-budget-probe.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, browser, putBoard, startServer, type TestServer } from "./helpers.js";

let server: TestServer;
beforeEach(async () => { server = await startServer(); });
afterEach(async () => { await server.close(); });

/** Leave the chunked body unfinished: a refusal must arrive without waiting for EOF. */
function unfinishedUpload(method: string, path: string, headers: Record<string, string>, bytes: number): Promise<{
  status: number; headers: IncomingHttpHeaders; body: string; requestDestroyedBeforeResponse: boolean | undefined;
}> {
  return new Promise((resolve, reject) => {
    let requestDestroyedBeforeResponse: boolean | undefined;
    server.app.server.prependOnceListener("request", (request, response) => {
      response.once("prefinish", () => { requestDestroyedBeforeResponse = request.destroyed; });
    });
    const req = httpRequest({ host: "127.0.0.1", port: server.port, method, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("error", reject);
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, requestDestroyedBeforeResponse });
        req.destroy();
      });
    });
    req.on("error", reject); // A reset is a failure, never a substitute for 413.
    req.setTimeout(5000, () => req.destroy(new Error("no response to oversized body")));
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    let remaining = bytes;
    const write = () => {
      while (remaining > 0) {
        const size = Math.min(chunk.length, remaining);
        remaining -= size;
        if (!req.write(chunk.subarray(0, size))) {
          req.once("drain", write);
          return;
        }
      }
      req.flushHeaders();
    };
    write();
  });
}

describe("body limits over HTTP", () => {
  it("returns JSON 413 and closes an unfinished chunked JSON request", async () => {
    const response = await unfinishedUpload("PUT", "/api/board", bearer(BOARD_TOKEN), 1_000_001);
    expect(response.status).toBe(413);
    expect(response.requestDestroyedBeforeResponse).toBe(false);
    expect(response.headers.connection).toBe("close");
    expect(JSON.parse(response.body)).toEqual({ error: "request body too large" });
    expect((await putBoard(server.base)).status).toBe(200);
  });

  it.each([
    ["images", "POST", "/api/images", MAX_IMAGE_BYTES, {}],
    ["files", "POST", "/api/files", MAX_FILE_BYTES, { "x-file-name": "big.pdf" }],
    ["bridge media", "PUT", `/api/bridge/media/${"a".repeat(64)}`, MAX_MEDIA_BYTES, { "content-type": "video/mp4" }],
  ] as const)("returns 413 for chunked %s and removes every temporary file", async (_name, method, path, cap, extra) => {
    const headers = method === "PUT" ? bearer(BOARD_TOKEN) : browser(server.cookie());
    const response = await unfinishedUpload(method, path, { ...headers, ...extra }, cap + 1);
    expect(response.status).toBe(413);
    expect(response.requestDestroyedBeforeResponse).toBe(false);
    expect(response.headers.connection).toBe("close");
    expect(JSON.parse(response.body).error).toMatch(/over /);
    expect(readdirSync(join(server.webRoot, "..", "data", "media"))).toEqual([]);
  });

  it("returns a declared-size refusal before receiving any body", async () => {
    const response = await unfinishedUpload("PUT", "/api/board", {
      ...bearer(BOARD_TOKEN), "content-length": "1000001",
    }, 0);
    expect(response.status).toBe(413);
    expect(response.headers.connection).toBe("close");
    expect(JSON.parse(response.body)).toEqual({ error: "request body too large" });
  });
});

describe("JSON bodies held at once", () => {
  // The enrolment bodies are read before any session exists, through the readJson every route uses: an address
  // holding many unfinished bodies is refused past its share of the server's body budget instead of read without bound.
  it("refuses a body past one address's share of bodies held at once, and lets the share go when they end", async () => {
    // Sixty-four bodies under the logs route's 256 KiB cap fill the 4 MiB share.
    const probe = await probeBodyBudget({
      port: server.port,
      method: "PUT",
      path: "/api/bridge/logs",
      headers: bearer(BRIDGE_TOKEN),
      stalled: 64,
      chunkBytes: 64 * 1024 - 1,
    });
    probe.close();
    expect(probe.status).toBe(429);
    expect(probe.response.toLowerCase()).toContain("retry-after: 1");
    expect(probe.response.toLowerCase()).toContain("connection: close");
    await new Promise((r) => setTimeout(r, 200));
    expect((await putBoard(server.base)).status).toBe(200);
  });

  it("refuses a JSON body still incomplete at its deadline, under the server's long upload timeout", async () => {
    const short = createServer((request, response) => {
      readJson(request, 64 * 1024, 100).then(
        () => response.writeHead(200).end(),
        (error: unknown) => response.writeHead(error instanceof HttpError ? error.status : 500, { connection: "close" }).end(),
      );
    });
    await new Promise<void>((resolve) => short.listen(0, "127.0.0.1", resolve));
    try {
      const probe = await probeBodyBudget({ port: (short.address() as AddressInfo).port, path: "/", stalled: 0, waitMs: 2_000 });
      probe.close();
      expect(probe.status).toBe(408);
    } finally {
      short.closeAllConnections();
      await new Promise((resolve) => short.close(resolve));
    }
  });
});
