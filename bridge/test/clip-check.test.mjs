import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { PAD_GREY, SIDE, paddedEdge, videoFrame } from "../lib/clip-check.mjs";

/** A SIDE × SIDE frame: `fill(x, y)` gives each pixel's colour. @param {(x: number, y: number) => number[]} fill */
function frame(fill) {
  const rgb = Buffer.alloc(SIDE * SIDE * 3);
  for (let y = 0; y < SIDE; y++) for (let x = 0; x < SIDE; x++) rgb.set(fill(x, y), (y * SIDE + x) * 3);
  return rgb;
}
/** Busy page content: no two neighbours alike. @param {number} x @param {number} y */
const page = (x, y) => [(x * 37) % 256, (y * 53) % 256, ((x + y) * 29) % 256];

test("a page in the top-left quarter pads the right edge", () => {
  assert.equal(paddedEdge(frame((x, y) => (x < SIDE / 2 && y < SIDE / 2 ? page(x, y) : PAD_GREY))), "right");
});

test("a page narrower than the clip but full height pads the right edge", () => {
  assert.equal(paddedEdge(frame((x, y) => (x < SIDE * 0.8 ? page(x, y) : PAD_GREY))), "right");
});

test("a page shorter than the clip but full width pads the bottom edge", () => {
  assert.equal(paddedEdge(frame((x, y) => (y < SIDE * 0.75 ? page(x, y) : [PAD_GREY[0] + 6, PAD_GREY[1] - 5, PAD_GREY[2] + 4]))), "bottom");
});

test("padding of just 10% is caught although scaling blends its inner edge", () => {
  // 6.4 columns of 64: six whole grey columns, then one blended with the page.
  assert.equal(paddedEdge(frame((x, y) => (x >= SIDE - 6 ? PAD_GREY : x === SIDE - 7 ? [60, 70, 180] : page(x, y)))), "right");
});

test("a full-frame page is not padded", () => {
  assert.equal(paddedEdge(frame(page)), null);
});

test("black letterbox bars and a thin grey edge are not Playwright padding", () => {
  assert.equal(paddedEdge(frame((x, y) => (x >= SIDE * 0.7 ? [0, 0, 0] : page(x, y)))), null);
  assert.equal(paddedEdge(frame((x, y) => (x >= SIDE - 3 ? PAD_GREY : page(x, y)))), null);
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("videoFrame reads a real clip, and paddedEdge finds its padding", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-clip-"));
  const make = (/** @type {string} */ name, /** @type {string} */ vf) => {
    const file = path.join(dir, name);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=360x640:d=1:r=30", "-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
    return file;
  };
  const padded = make("padded.mp4", "pad=720:1280:0:0:color=0x7e817e");
  const clean = make("clean.mp4", "scale=720:1280");
  const tenth = path.join(dir, "tenth.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=576x640:d=1:r=30", "-vf", "pad=640:640:0:0:color=0x7e817e", "-c:v", "libx264", "-pix_fmt", "yuv420p", tenth]);
  assert.equal(paddedEdge(/** @type {Buffer} */ (await videoFrame(tenth))), "right");
  assert.equal(paddedEdge(/** @type {Buffer} */ (await videoFrame(padded))), "right");
  assert.equal(paddedEdge(/** @type {Buffer} */ (await videoFrame(clean))), null);
  assert.equal(await videoFrame(path.join(dir, "missing.mp4")), null);
  assert.equal(await videoFrame(clean, path.join(dir, "no-ffmpeg")), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
