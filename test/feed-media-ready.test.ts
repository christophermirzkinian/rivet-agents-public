// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error the browser harness is plain ESM without type declarations
import { unloaded } from "../scripts/feed-media-ready.mjs";

const preview = window as unknown as { previewMediaDrawn: () => Promise<void> };

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<article data-need="clip"><video src="/media/fixture"></video></article>';
  preview.previewMediaDrawn = () => Promise.resolve();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "previewMediaDrawn");
});

describe("Feed fixture readiness", () => {
  it("does not spend the decode budget while the preview is still drawing its clip", async () => {
    const video = document.querySelector("video")!;
    let readyState = 0;
    Object.defineProperty(video, "readyState", { get: () => readyState });
    preview.previewMediaDrawn = () => new Promise((resolve) => setTimeout(() => {
      video.src = "blob:drawn-clip";
      resolve();
      // Decoding starts only once the fixture's final source exists.
      setTimeout(() => { readyState = 1; }, 200);
    }, 16_000));
    const done = vi.fn();
    const result = unloaded("clip").then((missing: string[]) => { done(); return missing; });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_300);
    expect(await result).toEqual([]);
  });

  it("still fails a video that never decodes after fixture setup", async () => {
    const result = unloaded("clip");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toEqual(["video"]);
  });

  it("still fails when the card has no media", async () => {
    document.body.replaceChildren();
    expect(await unloaded("clip")).toEqual(["no img or video"]);
  });

  it("still fails a completed image with no decoded pixels", async () => {
    document.body.innerHTML = '<article data-need="clip"><img></article>';
    Object.defineProperties(document.querySelector("img")!, { complete: { value: true }, naturalWidth: { value: 0 } });
    const result = unloaded("clip");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toEqual(["img"]);
  });
});
