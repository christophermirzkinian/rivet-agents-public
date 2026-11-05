// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, WRITE_TIMEOUT_MS, call, uploadImage, uploadTimeoutMs } from "../web/src/api.js";
import { sendChat } from "../web/src/command-api.js";
import { PUSH_STEP_MS, disablePush, enablePush } from "../web/src/push.js";
import { STALL_MS } from "../web/src/stall.js";
import { fetchDocument } from "../web/src/views/documents.js";

// A send, upload, download or push step whose answer stalled left its control busy (Send off, a card hidden,
// Settings stuck, the PDF viewer on "Getting the PDF…") until a reload. Each now gives up and says so.

/** Never answers, until the request is aborted, as a real fetch does. */
function hang(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });
}

let settled: unknown;
const watch = (promise: Promise<unknown>) => {
  settled = undefined;
  void promise.then(
    (value) => (settled = { value }),
    (error: unknown) => (settled = { error }),
  );
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("fetch", vi.fn(hang));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("send deadlines", () => {
  it("gives up a send at WRITE_TIMEOUT_MS and says it may have gone through", async () => {
    watch(call("POST", "/api/replies", {}));
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    const { error } = settled as { error: ApiError };
    expect([error.status, error.message]).toEqual([0, expect.stringMatching(/may have gone through/)]);
  });

  it("retries a timed-out chat send under the same clientId, so the server never runs it twice", async () => {
    watch(sendChat("hello", [], [], undefined, null));
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS);
    expect(settled).toHaveProperty("error");
    watch(sendChat("hello", [], [], undefined, null));
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS);
    const ids = vi.mocked(fetch).mock.calls.map(([, init]) => (JSON.parse(String(init!.body)) as { clientId: string }).clientId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("keeps a refusal's status when its body stalls, so a 401 still signs out", async () => {
    vi.mocked(fetch).mockImplementation((_input, init) =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      } as unknown as Response),
    );
    watch(call("POST", "/api/chat", {}));
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS);
    expect((settled as { error: ApiError }).error.status).toBe(401);
  });

  it("gives an upload time for its size, then gives it up", async () => {
    const image = new Blob([new Uint8Array(1_000_000)], { type: "image/png" });
    watch(uploadImage(image));
    await vi.advanceTimersByTimeAsync(uploadTimeoutMs(image.size) - 1);
    expect(settled).toBeUndefined();
    expect(uploadTimeoutMs(image.size)).toBeGreaterThan(WRITE_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(1);
    expect((settled as { error: ApiError }).error).toBeInstanceOf(ApiError);
  });
});

describe("download stalls", () => {
  it("fails a document whose bytes stop for STALL_MS, and keeps one whose bytes keep coming", async () => {
    let push: ReadableStreamDefaultController<Uint8Array> | null = null;
    vi.mocked(fetch).mockImplementation((_input, init) => {
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (push = c) });
      init?.signal?.addEventListener("abort", () => push!.error(new DOMException("The operation was aborted.", "AbortError")));
      return Promise.resolve(new Response(body, { headers: { "content-type": "application/pdf" } }));
    });
    watch(fetchDocument("/media/x", "x.pdf", "application/pdf"));
    await vi.advanceTimersByTimeAsync(STALL_MS - 1000);
    push!.enqueue(new TextEncoder().encode("%PDF-1.7"));
    await vi.advanceTimersByTimeAsync(STALL_MS - 1000);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toEqual({ value: "The PDF stopped coming. Try again." });
  });
});

describe("push steps", () => {
  it("gives up registering the worker when it never settles", async () => {
    vi.stubGlobal("Notification", { requestPermission: () => Promise.resolve("granted") });
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register: () => new Promise(() => {}) } });
    watch(enablePush());
    await vi.advanceTimersByTimeAsync(PUSH_STEP_MS);
    expect(String((settled as { error: Error }).error)).toMatch(/took too long/);
  });

  it("gives up a browser push step that never settles", async () => {
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: () => new Promise(() => {}) } });
    watch(disablePush());
    await vi.advanceTimersByTimeAsync(PUSH_STEP_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(String((settled as { error: Error }).error)).toMatch(/took too long/);
  });
});
