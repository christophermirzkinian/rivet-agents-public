import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_MEDIA_BYTES } from "./board-client.mjs";
import { paddedEdge, SIDE } from "./clip-check.mjs";

// The checks a card's videos and stills pass before anything is uploaded, so media
// the owner would reject (a clip a phone cannot play, a blank first frame, a page in
// the corner of grey padding, before and after at different sizes) goes back to the
// chat that made it and never reaches a card.

/**
 * A frame whose luma standard deviation (0-255, read at SIDE × SIDE) is below this is
 * one flat colour. Measured over 113 clips and stills: the one blank first frame read 0.00,
 * every frame with a page on it 15 or more.
 */
export const BLANK_SD = 3;
/** Phones play 8-bit 4:2:0; yuvj420p is the same layout at full range. */
const PIXEL_FORMATS = ["yuv420p", "yuvj420p"];
/** ffprobe format names for a single png or jpg image. */
const STILL_FORMATS = ["png_pipe", "jpeg_pipe", "image2"];
const MIN_SECONDS = 0.5;
const MAX_DPR = 4;
const VIDEO_RE = /\.(mp4|webm)$/i;
const STILL_RE = /\.(png|jpe?g)$/i;

/**
 * @typedef {{ role: "before" | "after" | "poster" | "still" | "video", file: string }} MediaFile
 * @typedef {{ width: number, height: number }} Viewport
 * @typedef {{ exec: import("./config.mjs").Exec, ffprobe?: string, ffmpeg?: string, viewport?: Viewport,
 *   allowWebm?: boolean, skipCorner?: boolean, tmpdir?: string, maxStill?: number }} PreflightOptions
 */

/**
 * "390x844" as a viewport; null when it is not two whole numbers from 1 to 10000.
 * @param {string} text
 * @returns {Viewport | null}
 */
export function parseViewport(text) {
  const m = /^([1-9]\d{0,4})x([1-9]\d{0,4})$/.exec(text);
  if (!m || Number(m[1]) > 10_000 || Number(m[2]) > 10_000) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * The luma standard deviation of a SIDE × SIDE rgb24 frame.
 * @param {Buffer} rgb
 */
export function frameSpread(rgb) {
  const n = rgb.length / 3;
  let sum = 0;
  let squares = 0;
  for (let i = 0; i < n; i++) {
    const y = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
    sum += y;
    squares += y * y;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, squares / n - mean * mean));
}

/** @param {Buffer} rgb */
export function blankFrame(rgb) {
  return frameSpread(rgb) < BLANK_SD;
}

/**
 * An rgba frame laid over one grey level, as rgb24.
 * @param {Buffer} rgba
 * @param {number} bg 0 black to 255 white
 */
export function composite(rgba, bg) {
  const n = rgba.length / 4;
  const rgb = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(rgba[i * 4 + c] * a + bg * (1 - a));
  }
  return rgb;
}

/**
 * Blank whatever the card shows behind it: over black and over white alike, so hidden
 * colour under full transparency does not count and an opaque shape on clear does.
 * @param {Buffer} rgba
 */
export function blankImage(rgba) {
  return blankFrame(composite(rgba, 0)) && blankFrame(composite(rgba, 255));
}

/** The width a still or first frame is read at for a thick coloured edge: about a phone's CSS width. */
export const EDGE_WIDTH = 400;
const STRIPE_MIN = 3;
const STRIPE_MAX = 10;
const STRIPE_TALL = 40;
/** Plain pixels beside a stripe on its box's side. */
const STRIPE_INSIDE = 6;
/** How far a stripe's pixels may stray from its first, per channel. */
const STRIPE_SPREAD = 30;

/** @param {Buffer} rgb @param {number} i the pixel's index */
function saturated(rgb, i) {
  const r = rgb[i * 3];
  const g = rgb[i * 3 + 1];
  const b = rgb[i * 3 + 2];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max / 255 > 0.3 && (max - min) / max > 0.4;
}

/** @param {Buffer} rgb @param {number} i @param {number} j */
function near(rgb, i, j) {
  for (let c = 0; c < 3; c++) if (Math.abs(rgb[i * 3 + c] - rgb[j * 3 + c]) > STRIPE_SPREAD) return false;
  return true;
}

/**
 * A heuristic for the thick coloured line on one side of a box (a border-left or border-right accent): a vertical stripe STRIPE_MIN to STRIPE_MAX px thick of one saturated colour (HSV s > 0.4, v > 0.3), at
 * least STRIPE_TALL px tall, with a plain pixel on each side and a plain run beside it on the box's side. Vertical
 * only: a top or bottom rule is not read, and a wide coloured button or a 1px line does not count.
 * @param {Buffer} rgb rgb24, `width` × `height`
 * @param {number} width
 * @param {number} height
 */
export function edgeStripe(rgb, width, height) {
  const run = new Int32Array(width);
  const thick = new Int32Array(width);
  const first = new Int32Array(width).fill(-1);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const seen = new Uint8Array(width);
    for (let x = 1; x < width - 1; x++) {
      const at = row + x;
      if (!saturated(rgb, at) || saturated(rgb, at - 1)) continue;
      let t = 1;
      while (x + t < width && t <= STRIPE_MAX && saturated(rgb, at + t) && near(rgb, at, at + t)) t++;
      if (t < STRIPE_MIN || t > STRIPE_MAX || x + t >= width || saturated(rgb, at + t)) continue;
      const plain = (/** @type {number} */ from, /** @type {number} */ step) => {
        for (let k = 0; k < STRIPE_INSIDE; k++) {
          const px = from + k * step;
          if (px < 0 || px >= width || saturated(rgb, row + px)) return false;
        }
        return true;
      };
      if (!plain(x + t, 1) && !plain(x - 1, -1)) continue;
      // The same stripe as the row above: its start, its thickness give or take a pixel, its colour.
      const same = run[x] > 0 && Math.abs(thick[x] - t) <= 1 && near(rgb, first[x], at);
      run[x] = same ? run[x] + 1 : 1;
      thick[x] = t;
      if (!same) first[x] = at;
      seen[x] = 1;
      if (run[x] >= STRIPE_TALL) return true;
    }
    for (let x = 0; x < width; x++) if (!seen[x]) run[x] = 0;
  }
  return false;
}

/**
 * The size a player shows: the coded size turned by the stream's rotation, or for a jpg by its EXIF orientation,
 * which FFmpeg puts on the first frame rather than the stream.
 * @param {any} stream an ffprobe stream with side_data_list and tags
 * @param {any} [frame] the first ffprobe frame, with its side_data_list
 */
export function displayedSize(stream, frame) {
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  /** @param {any} owner */
  const turn = (owner) => (Array.isArray(owner?.side_data_list) ? owner.side_data_list.find((/** @type {any} */ s) => s?.rotation !== undefined)?.rotation : undefined);
  const rotation = Number(turn(stream) ?? stream?.tags?.rotate ?? turn(frame) ?? 0);
  return Math.abs(rotation) % 180 === 90 ? { width: height, height: width } : { width, height };
}

/** @param {number} w @param {number} h @param {Viewport} v */
function fitsViewport(w, h, v) {
  const k = w / v.width;
  return Number.isInteger(k) && k >= 1 && k <= MAX_DPR && h === v.height * k;
}

/** @param {Viewport} v */
function viewportSizes(v) {
  const sizes = [];
  for (let k = 1; k <= MAX_DPR; k++) sizes.push(`${v.width * k}x${v.height * k}`);
  return `${sizes.slice(0, -1).join(", ")} or ${sizes.at(-1)}`;
}

/** @param {unknown} err */
function notFound(err) {
  return /** @type {any} */ (err)?.code === "ENOENT";
}

/** @param {unknown} err */
function why(err) {
  const e = /** @type {any} */ (err);
  return String(e?.stderrFirstLine || e?.message || "failed").slice(0, 200);
}

/**
 * Checks every video and still before a card is made. Audio and PDFs are not checked here. A warning (a thick
 * coloured edge) never refuses the media. `maxStill` refuses a still longer than it on either side.
 * @param {MediaFile[]} files
 * @param {PreflightOptions} opts
 * @returns {Promise<{ ok: boolean, problems: string[], warnings: string[] }>}
 */
export async function preflight(files, { exec, ffprobe, ffmpeg, viewport, allowWebm = false, skipCorner = false, tmpdir = os.tmpdir(), maxStill }) {
  const missing = [!ffprobe && "ffprobe", !ffmpeg && "ffmpeg"].filter(Boolean);
  if (missing.length) return { ok: false, warnings: [], problems: [`${missing.join(" and ")} not found on PATH: media is not sent unchecked (brew install ffmpeg)`] };
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Partial<Record<"before" | "after", { name: string, size: string }>>} */
  const sides = {};
  const dir = fs.mkdtempSync(path.join(tmpdir, "rivet-preflight-"));
  try {
    for (const [index, { role, file }] of files.entries()) {
      const name = path.basename(file);
      const video = VIDEO_RE.test(file);
      if (!video && !STILL_RE.test(file)) {
        problems.push(`${name}: not an mp4 video or a png or jpg still`);
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        problems.push(`${name}: file not found`);
        continue;
      }
      if (!stat.isFile() || stat.size === 0) {
        problems.push(`${name}: not a file, or empty`);
        continue;
      }
      if (stat.size > MAX_MEDIA_BYTES) problems.push(`${name}: ${(stat.size / 1024 / 1024).toFixed(1)} MB, over the 25 MB limit`);

      let probe;
      try {
        const entries = "stream=codec_name,width,height,pix_fmt:stream_side_data=rotation:stream_tags=rotate:format=duration,format_name";
        // A still's first frame carries its EXIF orientation.
        const frames = video ? [] : ["-read_intervals", "%+#1", "-show_entries", "frame_side_data=rotation"];
        const out = await exec(/** @type {string} */ (ffprobe), ["-v", "error", "-select_streams", "v:0", "-show_entries", entries, ...frames, "-of", "json", file], { timeout: 30_000 });
        probe = JSON.parse(out.stdout);
      } catch (err) {
        if (notFound(err)) return { ok: false, warnings: [], problems: ["ffprobe could not run: media is not sent unchecked (brew install ffmpeg)"] };
        problems.push(`${name}: ffprobe cannot read it (${why(err)})`);
        continue;
      }
      const stream = Array.isArray(probe?.streams) ? probe.streams[0] : undefined;
      const { width, height } = displayedSize(stream, Array.isArray(probe?.frames) ? probe.frames[0] : undefined);
      if (!stream || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        problems.push(`${name}: no picture in it`);
        continue;
      }
      if (video) {
        const webm = /\.webm$/i.test(file);
        const format = String(probe.format?.format_name ?? "");
        const codec = String(stream.codec_name ?? "unknown");
        if (webm && !allowWebm) problems.push(`${name}: not H.264 mp4; a phone may not play it (re-encode to mp4, or add --allow-webm)`);
        else if (!webm && !format.split(",").includes("mp4")) problems.push(`${name}: named .mp4 but the container is ${format || "unknown"}`);
        else if (!webm && codec !== "h264") problems.push(`${name}: video codec ${codec}, not H.264; a phone may not play it (re-encode with -c:v libx264 -pix_fmt yuv420p)`);
        const pix = String(stream.pix_fmt ?? "unknown");
        if (!PIXEL_FORMATS.includes(pix)) problems.push(`${name}: pixel format ${pix}, not yuv420p; phones may not play it (re-encode with -pix_fmt yuv420p)`);
        const seconds = Number(probe.format?.duration);
        if (!(seconds > MIN_SECONDS)) problems.push(`${name}: ${Number.isFinite(seconds) ? `${seconds} s` : "no duration"}; a clip runs longer than ${MIN_SECONDS} s`);
      } else {
        const want = /\.png$/i.test(file) ? "png" : "mjpeg";
        const codec = String(stream.codec_name ?? "unknown");
        // A single-image container: an mjpeg AVI renamed .jpg has the right codec but the server refuses it.
        const format = String(probe.format?.format_name ?? "");
        if (codec !== want) {
          problems.push(`${name}: not a ${want === "png" ? "png" : "jpg"} image inside (ffprobe reads ${codec})`);
          continue;
        }
        if (!format.split(",").some((f) => STILL_FORMATS.includes(f))) {
          problems.push(`${name}: a ${format || "unknown"} file, not a single ${want === "png" ? "png" : "jpg"} image`);
          continue;
        }
        if (maxStill && role === "still" && Math.max(width, height) > maxStill)
          problems.push(`${name}: ${width}x${height}, over ${maxStill} px on its longest side; scale it down (sips -Z ${maxStill} ${name})`);
      }
      if (viewport && !fitsViewport(width, height, viewport))
        problems.push(`${name}: ${width}x${height} is not the ${viewport.width}x${viewport.height} viewport at DPR 1 to ${MAX_DPR}; expected ${viewportSizes(viewport)}`);
      if (role === "before" || role === "after") sides[role] = { name, size: `${width}x${height}` };

      const raw = path.join(dir, `frame-${index}.rgba`);
      try {
        await exec(
          /** @type {string} */ (ffmpeg),
          ["-v", "error", "-nostdin", "-i", file, "-map", "0:v:0", "-frames:v", "1", "-vf", `scale=${SIDE}:${SIDE}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgba", "-y", raw],
          { timeout: 60_000 },
        );
      } catch (err) {
        if (notFound(err)) return { ok: false, warnings: [], problems: ["ffmpeg could not run: media is not sent unchecked (brew install ffmpeg)"] };
      }
      const frame = fs.existsSync(raw) ? fs.readFileSync(raw) : null;
      if (!frame || frame.length !== SIDE * SIDE * 4) {
        problems.push(`${name}: ffmpeg cannot decode its ${video ? "first frame" : "image"}`);
        continue;
      }
      const edge = video && !skipCorner ? paddedEdge(composite(frame, 0)) : null;
      if (edge)
        problems.push(
          `${name}: the page sits in the top-left corner, with grey padding along the ${edge} edge; record with recordVideo.size equal to the viewport ` +
            "(or add --skip-corner-check if that grey is the page itself)",
        );
      else if (blankImage(frame))
        problems.push(video ? `${name}: the first frame is blank (one flat colour); start the clip after the page has painted` : `${name}: the image is blank (one flat colour)`);

      // Only ever a warning, so a frame that will not decode at this size is skipped.
      const wide = path.join(dir, `edge-${index}.rgb`);
      try {
        await exec(
          /** @type {string} */ (ffmpeg),
          ["-v", "error", "-nostdin", "-i", file, "-map", "0:v:0", "-frames:v", "1", "-vf", `scale=${EDGE_WIDTH}:-2`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-y", wide],
          { timeout: 60_000 },
        );
        const rgb = fs.readFileSync(wide);
        const rows = rgb.length / (EDGE_WIDTH * 3);
        if (Number.isInteger(rows) && rows > 0 && edgeStripe(rgb, EDGE_WIDTH, rows))
          warnings.push(`${name}: looks like a thick coloured line on one edge of a box; check the still`);
      } catch {}
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (sides.before && sides.after && sides.before.size !== sides.after.size)
    problems.push(`before ${sides.before.name} is ${sides.before.size} but after ${sides.after.name} is ${sides.after.size}; record both at the same size`);
  return { ok: problems.length === 0, problems, warnings };
}
