import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The app is an installed PWA, so the page's viewport meta is what the phone's browser reads. No pinch zoom, no double-tap zoom, and no zoom when a text box takes focus. The
// lightbox's own picture zoom is its own pointer handling, so it keeps working.
const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const viewport = html.match(/<meta name="viewport" content="([^"]*)"/)?.[1] ?? "";

describe("the app's viewport", () => {
  it("does not zoom", () => {
    expect(viewport).toMatch(/(^|, )maximum-scale=1(,|$)/);
    expect(viewport).toMatch(/(^|, )user-scalable=no(,|$)/);
  });

  it("keeps its width and the notch inset", () => {
    expect(viewport).toMatch(/width=device-width/);
    expect(viewport).toMatch(/initial-scale=1(,|$)/);
    expect(viewport).toMatch(/viewport-fit=cover/);
  });
});
