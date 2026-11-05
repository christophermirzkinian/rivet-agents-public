// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stubCanvas } from "./canvas-stub.js";
import { IMAGE_STEP_MS, prepareImage } from "../web/src/image.js";
import { VIEWER_LOAD_MS, closeLightbox, openText } from "../web/src/views/lightbox.js";
import { within } from "../web/src/within.js";

// A browser wait that is not a fetch (a lazy chunk, an image decode) has no deadline of its own, so a stalled
// one left its view stuck. Each now ends in that view's own failure state.

// Lazy chunks that never arrive, as on a connection that drops mid-load.
vi.mock("../web/src/views/text-pages.js", () => new Promise(() => {}));

/** What pdf.js's document load answers: a document whose pages never load, or nothing at all. */
const pdf = vi.hoisted(() => ({ loaded: false }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: pdf.loaded ? Promise.resolve({ numPages: 1, getPage: () => new Promise(() => {}) }) : new Promise(() => {}),
    destroy: () => Promise.resolve(),
  }),
}));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "/pdf.worker.js" }));

let settled: unknown;
const watch = (promise: Promise<unknown>) => {
  settled = undefined;
  void promise.then(
    (value) => (settled = { value }),
    (error: unknown) => (settled = { error }),
  );
};

/** An image that is never decoded: neither load nor error fires. */
class StalledImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = "";
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("within", () => {
  it("passes a step's answer through and clears its timer", async () => {
    await expect(within(Promise.resolve(7), 1_000, "late")).resolves.toBe(7);
    await expect(within(Promise.reject(new Error("broke")), 1_000, "late")).rejects.toThrow("broke");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with its message once the time is up", async () => {
    watch(within(new Promise(() => {}), 1_000, "Took too long."));
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ error: new Error("Took too long.") });
  });
});

describe("preparing a photo", () => {
  it("fails a decode that never finishes, so the photo frees the upload queue", async () => {
    vi.stubGlobal("Image", StalledImage);
    watch(prepareImage(new Blob(["heic"], { type: "image/heic" })));
    await vi.advanceTimersByTimeAsync(IMAGE_STEP_MS);
    expect(settled).toEqual({ error: new Error("Reading that image took too long. Try again.") });
  });

  it("fails a re-encode whose canvas never calls back", async () => {
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        naturalWidth = 400;
        naturalHeight = 300;
        set src(_url: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    stubCanvas();
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(() => {});
    watch(prepareImage(new Blob(["jpeg"], { type: "image/jpeg" })));
    await vi.advanceTimersByTimeAsync(IMAGE_STEP_MS);
    expect(settled).toEqual({ error: new Error("Preparing that image took too long. Try again.") });
  });
});

describe("the document viewer", () => {
  it("says it could not show the file when its viewer code never loads", async () => {
    vi.spyOn(history, "back").mockImplementation(() => window.dispatchEvent(new PopStateEvent("popstate")));
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    document.body.replaceChildren();
    openText("notes.md", true, () => Promise.resolve(new File(["# Notes"], "notes.md", { type: "text/markdown" })));
    const note = () => document.querySelector(".lightbox-note")!.textContent;
    await vi.advanceTimersByTimeAsync(VIEWER_LOAD_MS - 1);
    expect(note()).toBe("Getting the file…");
    await vi.advanceTimersByTimeAsync(1);
    expect(note()).toBe("Could not show the file.");
    closeLightbox();
  });
});

describe("the PDF viewer", () => {
  it("fails a document or page load that never finishes, like a broken PDF", async () => {
    const { PDF_STEP_MS, pdfContent } = await import("../web/src/views/pdf-pages.js");
    for (const loaded of [false, true]) {
      pdf.loaded = loaded;
      watch(pdfContent(new Uint8Array(8), new AbortController().signal));
      await vi.advanceTimersByTimeAsync(PDF_STEP_MS - 1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toEqual({ error: new Error("PDF step took too long") });
    }
  });
});

