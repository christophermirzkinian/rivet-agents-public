// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_MEDIA_BYTES } from "../src/shared/command.js";
import { fileLink, VIEWER_MAX_BYTES } from "../web/src/views/attach.js";
import { FETCH_MAX_BYTES, fetchDocument, TOO_BIG_TO_SHOW } from "../web/src/views/documents.js";

const SHA = "a".repeat(64);

/** Whether a plain click on the link was taken by the app's viewer (true) or left to follow the link (false). */
function taken(bytes: number | undefined): boolean {
  const link = fileLink({ sha256: SHA, name: "report.pdf", ...(bytes === undefined ? {} : { bytes }) });
  document.body.append(link);
  let viewer = false;
  // Read on the way up, then stopped, so the test page never follows the link itself.
  document.body.addEventListener(
    "click",
    (event) => {
      viewer = event.defaultPrevented;
      event.preventDefault();
    },
    { once: true },
  );
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  return viewer;
}

describe("a sent document's link", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("opens in the viewer up to the old document cap, and follows its link over it", () => {
    // The viewer's fetch never has to answer here: only whether the click was taken is read.
    vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
    expect(VIEWER_MAX_BYTES).toBe(MAX_MEDIA_BYTES);
    expect(taken(undefined)).toBe(true);
    expect(taken(VIEWER_MAX_BYTES)).toBe(true);
    expect(taken(VIEWER_MAX_BYTES + 1)).toBe(false);
    expect(taken(400 * 1024 * 1024)).toBe(false);
  });

  /** A response whose body is `chunks` of `chunk` bytes, saying `length` (or no length), and how much of it was read. */
  function served(length: number | null, chunks: number, chunk: number) {
    const state = { read: 0, cancelled: false };
    let left = chunks;
    // A body being read is locked, so only aborting the fetch closes it: `cancelled` is that abort, nothing else.
    const body = {
      cancel: async () => {
        throw new TypeError("locked");
      },
      getReader: () => ({
        read: async () => {
          if (left === 0 || state.cancelled) return { done: true, value: undefined };
          left -= 1;
          state.read += chunk;
          return { done: false, value: new Uint8Array(chunk) };
        },
      }),
    };
    const headers = { get: (name: string) => (name === "content-length" && length !== null ? String(length) : name === "content-type" ? "text/plain" : null) };
    vi.stubGlobal("fetch", async (_src: string, init: { signal: AbortSignal }) => {
      init.signal.addEventListener("abort", () => {
        state.cancelled = true;
      });
      return { ok: true, status: 200, headers, body };
    });
    return state;
  }

  it("never reads a file with no size on its chat line past the viewer's cap", async () => {
    // The server says how long it is: nothing is read.
    const said = served(300 * 1024 * 1024, 300, 1024 * 1024);
    const viewer = () => fetchDocument("/media/x", "notes.txt", "text/plain", undefined, VIEWER_MAX_BYTES);
    expect(await viewer()).toBe(TOO_BIG_TO_SHOW);
    expect(said).toEqual({ read: 0, cancelled: true });
    // No length at all: the read stops at the first chunk past the cap.
    const unsaid = served(null, 300, 1024 * 1024);
    expect(await viewer()).toBe(TOO_BIG_TO_SHOW);
    expect(unsaid.cancelled).toBe(true);
    expect(unsaid.read).toBe(VIEWER_MAX_BYTES + 1024 * 1024);
    // One at the cap is still read.
    served(VIEWER_MAX_BYTES, 25, 1024 * 1024);
    expect(await viewer()).toBeInstanceOf(File);
    // A clip or picture fetched to share or save keeps the old clip cap: 51 MB is read, 300 MB is not.
    expect(FETCH_MAX_BYTES).toBe(100 * 1024 * 1024);
    served(51 * 1024 * 1024, 51, 1024 * 1024);
    expect(await fetchDocument("/media/x", "notes.txt", "text/plain")).toBeInstanceOf(File);
    const clip = served(300 * 1024 * 1024, 300, 1024 * 1024);
    expect(await fetchDocument("/media/x", "notes.txt", "text/plain")).toBe("That file is over 100 MB, too big to open here.");
    expect(clip).toEqual({ read: 0, cancelled: true });
  });
});
