// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { drawnClip, previewMediaFile } from "../web/src/views/media.preview.js";

afterEach(() => {
  delete window.__RIVET_PREVIEW_CLIPS__;
  vi.unstubAllGlobals();
});

describe("Feed prerecorded clip fixtures", () => {
  it.each([
    ["540x720", "feed-portrait.webm", undefined, undefined],
    ["1920x1080", "feed-landscape.webm", 1920, 1080],
  ] as const)("serves %s without a recorder or the recording cache", async (size, name, width, height) => {
    const file = readFileSync(resolve("scripts/fixtures", name));
    window.__RIVET_PREVIEW_CLIPS__ = { [size]: file.toString("base64") };
    const unavailable = () => { throw new Error("live recording must not run in the layout harness"); };
    vi.stubGlobal("MediaRecorder", unavailable);
    vi.stubGlobal("caches", { open: unavailable });
    const id = drawnClip(`fixture-${size}`, "Layout clip", 190, width, height);
    const response = await previewMediaFile(`/media/${id}`);
    expect(response!.headers.get("content-type")).toBe("video/webm");
    expect(Buffer.from(await response!.arrayBuffer())).toEqual(file);
  });

  it("fails on an unprovided size instead of silently recording a new clip", async () => {
    window.__RIVET_PREVIEW_CLIPS__ = {};
    const id = drawnClip("missing-size", "Missing", 190, 999, 999);
    await expect(previewMediaFile(`/media/${id}`)).rejects.toThrow("Missing preview clip fixture: 999x999");
  });
});
