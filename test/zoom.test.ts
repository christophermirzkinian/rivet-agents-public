import { describe, expect, it } from "vitest";

import { clampView, DOUBLE_TAP_SCALE, doubleTapView, fitSize, panBy, pinchView, wheelFactor, zoomAt } from "../web/src/views/zoom.js";

// The lightbox's zoom maths: content at its fit size (scale 1), drawn `scale` times bigger at (x, y).

const stage = { w: 400, h: 800 };
/** A wide 4-up sheet fitted to a phone: full width, centred top to bottom. */
const sheet = fitSize({ w: 4000, h: 2000 }, stage, "contain");

describe("fitSize", () => {
  it("fits an image inside the stage and a document to the stage's width, capped", () => {
    expect(sheet).toEqual({ w: 400, h: 200 });
    expect(fitSize({ w: 1000, h: 4000 }, stage, "contain")).toEqual({ w: 200, h: 800 });
    expect(fitSize({ w: 600, h: 800 }, { w: 1440, h: 800 }, "width", 960)).toEqual({ w: 960, h: 1280 });
    expect(fitSize({ w: 0, h: 0 }, stage, "contain")).toEqual({ w: 0, h: 0 });
  });
});

describe("clampView", () => {
  it("centres content smaller than the stage and keeps bigger content's edges outside it", () => {
    expect(clampView({ scale: 1, x: 50, y: 0 }, sheet, stage, 8)).toEqual({ scale: 1, x: 0, y: 300 });
    // At 2x the sheet is 800 wide: x runs from -400 to 0; still only 400 tall, so centred.
    expect(clampView({ scale: 2, x: 100, y: 0 }, sheet, stage, 8)).toEqual({ scale: 2, x: 0, y: 200 });
    expect(clampView({ scale: 2, x: -900, y: 0 }, sheet, stage, 8)).toEqual({ scale: 2, x: -400, y: 200 });
  });

  it("keeps the scale between fit and the maximum", () => {
    expect(clampView({ scale: 0.3, x: 0, y: 0 }, sheet, stage, 8).scale).toBe(1);
    expect(clampView({ scale: 20, x: 0, y: 0 }, sheet, stage, 8).scale).toBe(8);
  });

  it("lets a tall document scroll from its top to its bottom and no further", () => {
    const doc = { w: 400, h: 3000 };
    expect(clampView({ scale: 1, x: 0, y: 40 }, doc, stage, 6)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(clampView({ scale: 1, x: 0, y: -5000 }, doc, stage, 6)).toEqual({ scale: 1, x: 0, y: -2200 });
  });
});

describe("zoomAt and panBy", () => {
  it("keeps the content under the point where it is", () => {
    const start = clampView({ scale: 1, x: 0, y: 0 }, sheet, stage, 8);
    const at = { x: 150, y: 400 };
    const view = zoomAt(start, 4, at, sheet, stage, 8);
    expect(view.scale).toBe(4);
    // The sheet point under (150, 400) before: (150, 100). After: x + 150 * 4 = 150.
    expect(view.x + 150 * 4).toBeCloseTo(150);
    expect(view.y + 100 * 4).toBeCloseTo(400);
  });

  it("pans only as far as the edges", () => {
    const view = zoomAt(clampView({ scale: 1, x: 0, y: 0 }, sheet, stage, 8), 2, { x: 200, y: 400 }, sheet, stage, 8);
    expect(panBy(view, 1000, 0, sheet, stage, 8).x).toBe(0);
    expect(panBy(view, -1000, 0, sheet, stage, 8).x).toBe(-400);
    expect(panBy(view, -50, 0, sheet, stage, 8).x).toBe(view.x - 50);
  });
});

describe("pinchView", () => {
  const start = clampView({ scale: 1, x: 0, y: 0 }, sheet, stage, 8);

  it("scales with the fingers' spread about the point between them", () => {
    const view = pinchView(start, [{ x: 100, y: 400 }, { x: 200, y: 400 }], [{ x: 50, y: 400 }, { x: 250, y: 400 }], sheet, stage, 8);
    expect(view.scale).toBe(2);
    // The middle (150, 400) was sheet point (150, 100); it stays under the middle.
    expect(view.x + 150 * 2).toBeCloseTo(150);
    expect(view.y + 100 * 2).toBeCloseTo(400);
  });

  it("follows the middle as both fingers move", () => {
    const zoomed = { scale: 3, x: -300, y: 100 };
    const view = pinchView(zoomed, [{ x: 100, y: 400 }, { x: 200, y: 400 }], [{ x: 80, y: 380 }, { x: 180, y: 380 }], sheet, stage, 8);
    expect(view).toEqual({ scale: 3, x: -320, y: 100 });
  });

  it("stops at fit and at the maximum", () => {
    expect(pinchView(start, [{ x: 100, y: 400 }, { x: 300, y: 400 }], [{ x: 190, y: 400 }, { x: 210, y: 400 }], sheet, stage, 8).scale).toBe(1);
    expect(pinchView(start, [{ x: 190, y: 400 }, { x: 210, y: 400 }], [{ x: 0, y: 400 }, { x: 400, y: 400 }], sheet, stage, 8).scale).toBe(8);
  });
});

describe("doubleTapView", () => {
  it("zooms in on the tapped point, and a second double tap goes back to fit", () => {
    const start = clampView({ scale: 1, x: 0, y: 0 }, sheet, stage, 8);
    // The second phone of four, near the middle of the sheet's height.
    const tap = { x: 150, y: 400 };
    const zoomed = doubleTapView(start, tap, sheet, stage, 8);
    expect(zoomed.scale).toBe(DOUBLE_TAP_SCALE);
    expect(zoomed.x + 150 * DOUBLE_TAP_SCALE).toBeCloseTo(150);
    // One phone (a quarter of the sheet) now spans most of the screen.
    expect((sheet.w / 4) * zoomed.scale).toBeGreaterThan(stage.w * 0.7);
    expect(doubleTapView(zoomed, tap, sheet, stage, 8)).toEqual(start);
  });

  it("never zooms past the maximum", () => {
    expect(doubleTapView({ scale: 1, x: 0, y: 300 }, { x: 200, y: 400 }, sheet, stage, 2).scale).toBe(2);
  });
});

describe("wheelFactor", () => {
  it("zooms in for a wheel or pinch toward the user, out away, and limits one notch", () => {
    expect(wheelFactor(-10, 0)).toBeGreaterThan(1);
    expect(wheelFactor(10, 0)).toBeLessThan(1);
    expect(wheelFactor(-1000, 0)).toBeCloseTo(wheelFactor(-50, 0));
    expect(wheelFactor(3, 1)).toBeCloseTo(wheelFactor(48, 0));
  });
});
