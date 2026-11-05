import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The chat sheet's rules once lived in a stylesheet that went away, so Message Rivet opened an unstyled sheet under the
// app and the page scrolled a screen to reach it. The sheet's own file holds them now, imported by the sheet.
const css = readFileSync(new URL("../web/src/views/worker-sheet.css", import.meta.url), "utf8");
const ts = readFileSync(new URL("../web/src/views/worker-sheet.ts", import.meta.url), "utf8");
const rule = (selector: string) => new RegExp(`(^|\\n)${selector.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`).exec(css)?.[2] ?? "";

describe("the chat sheet's styles", () => {
  it("are imported by the sheet that builds them", () => {
    expect(ts).toContain('import "./worker-sheet.css";');
  });

  it("fix the backdrop over the whole screen, above the Decide sheet's", () => {
    const backdrop = rule(".scene-sheet-backdrop");
    expect(backdrop).toMatch(/position: fixed;/);
    expect(backdrop).toMatch(/inset: 0;/);
    expect(Number(/z-index: (\d+);/.exec(backdrop)?.[1])).toBeGreaterThan(40);
  });

  it("keep the panel inside the screen, its middle scrolling", () => {
    expect(rule(".scene-sheet")).toMatch(/max-height: calc\(var\(--vv-h, 100dvh\)/);
    expect(rule(".scene-sheet")).toMatch(/overflow: hidden;/);
  });

  it("never scroll the page to the sheet when it takes focus", () => {
    expect(ts).toContain("close.focus({ preventScroll: true });");
  });
});
