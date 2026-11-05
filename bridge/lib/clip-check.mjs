import { execFile } from "node:child_process";

// Playwright's recordVideo pads the page with a flat grey when its size is bigger than
// the viewport, so the page plays in the top-left corner of the clip. On a card the
// clip then fills its box and the app looks like it sits in a corner. push-board
// reads one frame of each video and refuses a clip with that grey along its right or
// bottom edge. Colour alone cannot tell that grey from a page's own grey sidebar or
// background, so --skip-corner-check lets a clip through when the grey is the page.

/** Playwright's padding colour, measured from a Chromium recording. */
export const PAD_GREY = [126, 129, 126];
/** The frame is read at SIDE × SIDE pixels. */
export const SIDE = 64;
const TOLERANCE = 12;
/**
 * A padded band is at least 10% of the frame's width or height: 6 whole lines of 64,
 * since scaling down blends the line where the page meets the padding.
 */
const MIN_LINES = Math.floor(SIDE * 0.1);
/** A column or row counts as padding when this share of it is the grey. */
const FULL = 0.95;

/** @param {Buffer} rgb @param {number} i pixel index */
function grey(rgb, i) {
  const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
  return Math.abs(r - PAD_GREY[0]) <= TOLERANCE && Math.abs(g - PAD_GREY[1]) <= TOLERANCE && Math.abs(b - PAD_GREY[2]) <= TOLERANCE;
}

/**
 * Which edge of a SIDE × SIDE rgb24 frame carries Playwright's grey padding, if any.
 * @param {Buffer} rgb
 * @param {number} [side]
 * @returns {"right" | "bottom" | null}
 */
export function paddedEdge(rgb, side = SIDE) {
  const band = Math.max(2, Math.round((MIN_LINES * side) / SIDE));
  /** @param {(k: number, j: number) => number} at pixel index of the k-th line from the edge, j-th pixel along it */
  const lines = (at) => {
    let n = 0;
    for (let k = 0; k < side; k++) {
      let hits = 0;
      for (let j = 0; j < side; j++) if (grey(rgb, at(k, j))) hits++;
      if (hits < side * FULL) break;
      n++;
    }
    return n;
  };
  if (lines((k, j) => j * side + (side - 1 - k)) >= band) return "right";
  if (lines((k, j) => (side - 1 - k) * side + j) >= band) return "bottom";
  return null;
}

/**
 * One frame of a video as SIDE × SIDE rgb24, half a second in (the first frame for a
 * shorter clip). Null when ffmpeg is not installed or cannot read the file.
 * @param {string} file
 * @param {string} [ffmpeg]
 * @returns {Promise<Buffer | null>}
 */
export async function videoFrame(file, ffmpeg = "ffmpeg") {
  for (const seek of [["-ss", "0.5"], []]) {
    const args = ["-v", "error", "-nostdin", ...seek, "-i", file, "-frames:v", "1", "-vf", `scale=${SIDE}:${SIDE}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"];
    const out = await new Promise((resolve) => {
      execFile(ffmpeg, args, { encoding: "buffer", timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
    });
    if (out instanceof Buffer && out.length === SIDE * SIDE * 3) return out;
  }
  return null;
}
