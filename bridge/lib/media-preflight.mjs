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
 *   allowWebm?: boolean, skipCorner?: boolean, tmpdir?: string }} PreflightOptions
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
 * Checks every video and still before a card is made. Audio and PDFs are not checked here.
 * @param {MediaFile[]} files
 * @param {PreflightOptions} opts
 * @returns {Promise<{ ok: boolean, problems: string[] }>}
 */
export async function preflight(files, { exec, ffprobe, ffmpeg, viewport, allowWebm = false, skipCorner = false, tmpdir = os.tmpdir() }) {
  const missing = [!ffprobe && "ffprobe", !ffmpeg && "ffmpeg"].filter(Boolean);
  if (missing.length) return { ok: false, problems: [`${missing.join(" and ")} not found on PATH: media is not sent unchecked (brew install ffmpeg)`] };
  /** @type {string[]} */
  const problems = [];
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
        if (notFound(err)) return { ok: false, problems: ["ffprobe could not run: media is not sent unchecked (brew install ffmpeg)"] };
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
        if (notFound(err)) return { ok: false, problems: ["ffmpeg could not run: media is not sent unchecked (brew install ffmpeg)"] };
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
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (sides.before && sides.after && sides.before.size !== sides.after.size)
    problems.push(`before ${sides.before.name} is ${sides.before.size} but after ${sides.after.name} is ${sides.after.size}; record both at the same size`);
  return { ok: problems.length === 0, problems };
}
