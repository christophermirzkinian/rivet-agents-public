import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { PAD_GREY, SIDE } from "../lib/clip-check.mjs";
import { makeExec, resolveBin } from "../lib/config.mjs";
import { blankFrame, blankImage, composite, displayedSize, frameSpread, parseViewport, preflight } from "../lib/media-preflight.mjs";
import { run } from "../../scripts/rivet.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-preflight-test-"));

/** A SIDE × SIDE frame: `fill(x, y)` gives each pixel's colour. @param {(x: number, y: number) => number[]} fill */
function frame(fill) {
  const rgb = Buffer.alloc(SIDE * SIDE * 3);
  for (let y = 0; y < SIDE; y++) for (let x = 0; x < SIDE; x++) rgb.set(fill(x, y), (y * SIDE + x) * 3);
  return rgb;
}
/** @param {number} x @param {number} y */
const page = (x, y) => [(x * 37) % 256, (y * 53) % 256, ((x + y) * 29) % 256];
const CONTENT = frame(page);

/** @param {string} name @param {number} [bytes] */
function file(name, bytes = 1000) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, Buffer.alloc(1));
  fs.truncateSync(p, bytes);
  return p;
}

/** A SIDE × SIDE rgba frame: `fill(x, y)` gives each pixel's colour and alpha. @param {(x: number, y: number) => number[]} fill */
function rgbaFrame(fill) {
  const rgba = Buffer.alloc(SIDE * SIDE * 4);
  for (let y = 0; y < SIDE; y++) for (let x = 0; x < SIDE; x++) rgba.set(fill(x, y), (y * SIDE + x) * 4);
  return rgba;
}
/** @param {Buffer} rgb */
function opaque(rgb) {
  return rgbaFrame((x, y) => [...rgb.subarray((y * SIDE + x) * 3, (y * SIDE + x) * 3 + 3), 255]);
}

/**
 * ffprobe and ffmpeg as one fake exec: `probe` answers per file name, `frames` gives the decoded frame
 * (rgb24 frames are decoded opaque).
 * @param {Record<string, { codec?: string, width?: number, height?: number, pix?: string, duration?: string, format?: string,
 *   rotation?: number, rotate?: string }>} probe
 * @param {Record<string, Buffer>} [frames]
 */
function fakeExec(probe, frames = {}) {
  /** @type {string[][]} */
  const calls = [];
  /** @type {import("../lib/config.mjs").Exec} */
  const exec = async (bin, args) => {
    calls.push([bin, ...args]);
    if (bin.endsWith("ffprobe")) {
      const name = path.basename(/** @type {string} */ (args.at(-1)));
      const p = probe[name];
      if (!p) throw Object.assign(new Error("ffprobe exit 1"), { stderrFirstLine: "Invalid data found when processing input" });
      const video = /\.(mp4|webm)$/.test(name);
      return {
        stdout: JSON.stringify({
          streams: [
            {
              codec_name: p.codec ?? (video ? "h264" : name.endsWith(".png") ? "png" : "mjpeg"),
              width: p.width ?? 780,
              height: p.height ?? 1688,
              pix_fmt: p.pix ?? (video ? "yuv420p" : "rgb24"),
              tags: p.rotate === undefined ? {} : { rotate: p.rotate },
              ...(p.rotation === undefined ? {} : { side_data_list: [{ rotation: p.rotation }] }),
            },
          ],
          format: { format_name: p.format ?? (video ? (name.endsWith(".webm") ? "matroska,webm" : "mov,mp4,m4a,3gp,3g2,mj2") : "png_pipe"), ...(video ? { duration: p.duration ?? "4.2" } : {}) },
        }),
        stderr: "",
      };
    }
    const input = path.basename(args[args.indexOf("-i") + 1]);
    const decoded = frames[input] ?? CONTENT;
    fs.writeFileSync(/** @type {string} */ (args.at(-1)), decoded.length === SIDE * SIDE * 3 ? opaque(decoded) : decoded);
    return { stdout: "", stderr: "" };
  };
  return { exec, calls };
}

/** @param {import("../lib/media-preflight.mjs").MediaFile[]} files @param {ReturnType<typeof fakeExec>} fake @param {object} [extra] */
function check(files, fake, extra = {}) {
  return preflight(files, { exec: fake.exec, ffprobe: "/fake/ffprobe", ffmpeg: "/fake/ffmpeg", tmpdir: TMP, ...extra });
}

test("a flat frame is blank and a page is not", () => {
  assert.equal(frameSpread(frame(() => [255, 255, 255])), 0);
  assert.ok(blankFrame(frame(() => [255, 255, 255])));
  assert.ok(blankFrame(frame(() => [17, 17, 17])));
  assert.ok(blankFrame(frame((x, y) => [126 + ((x + y) % 3), 129, 126])), "compression noise on a flat grey is still blank");
  assert.ok(!blankFrame(CONTENT));
  assert.ok(!blankFrame(frame((x, y) => (y === 10 && x > 4 && x < 60 ? [40, 40, 40] : [255, 255, 255]))), "one line of text on white is a page");
});

test("an H.264 mp4 and a png pass", async () => {
  const fake = fakeExec({ "a.mp4": {}, "s.png": {} });
  const r = await check([{ role: "after", file: file("a.mp4") }, { role: "still", file: file("s.png") }], fake);
  assert.deepEqual(r, { ok: true, problems: [] });
  assert.ok(fake.calls.some((c) => c.includes("stream=codec_name,width,height,pix_fmt:stream_side_data=rotation:stream_tags=rotate:format=duration,format_name")));
  const decodes = fake.calls.filter((c) => c[0] === "/fake/ffmpeg");
  assert.equal(decodes.length, 2);
  for (const c of decodes) assert.equal(c[c.indexOf("-map") + 1], "0:v:0", "decodes the stream ffprobe probed");
});

test("a still is checked by what is inside, not its name", async () => {
  const fake = fakeExec({ "clip.png": { codec: "h264" }, "png.jpg": { codec: "png" }, "photo.jpeg": {} });
  const r = await check(
    [
      { role: "still", file: file("clip.png") },
      { role: "still", file: file("png.jpg") },
      { role: "still", file: file("photo.jpeg") },
    ],
    fake,
  );
  assert.deepEqual(r.problems, ["clip.png: not a png image inside (ffprobe reads h264)", "png.jpg: not a jpg image inside (ffprobe reads png)"]);
});

test("sizes are the displayed size, after the stream's rotation", async () => {
  assert.deepEqual(displayedSize({ width: 1688, height: 780, side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] }), { width: 780, height: 1688 });
  assert.deepEqual(displayedSize({ width: 1688, height: 780, tags: { rotate: "270" } }), { width: 780, height: 1688 });
  assert.deepEqual(displayedSize({ width: 1688, height: 780, side_data_list: [{ rotation: 180 }] }), { width: 1688, height: 780 });
  // A jpg's EXIF orientation arrives on its first frame; the stream's own rotation wins when both are there.
  assert.deepEqual(displayedSize({ width: 640, height: 320 }, { side_data_list: [{ rotation: -90 }, {}] }), { width: 320, height: 640 });
  assert.deepEqual(displayedSize({ width: 640, height: 320, side_data_list: [{ rotation: 0 }] }, { side_data_list: [{ rotation: -90 }] }), { width: 640, height: 320 });
  const fake = fakeExec({ "b.mp4": { width: 1688, height: 780, rotation: 90 }, "a.mp4": {}, "turned.mp4": { width: 1688, height: 780, rotate: "90" }, "flat.mp4": { width: 1688, height: 780 } });
  const viewport = { width: 390, height: 844 };
  assert.deepEqual(await check([{ role: "before", file: file("b.mp4") }, { role: "after", file: file("a.mp4") }], fake, { viewport }), { ok: true, problems: [] });
  const r = await check([{ role: "before", file: file("turned.mp4") }, { role: "after", file: file("flat.mp4") }], fake);
  assert.deepEqual(r.problems, ["before turned.mp4 is 780x1688 but after flat.mp4 is 1688x780; record both at the same size"]);
});

test("transparency: hidden colour is blank, an opaque shape on clear is not", async () => {
  const hidden = rgbaFrame((x, y) => [...page(x, y), 0]);
  const silhouette = rgbaFrame((x, y) => [0, 0, 0, Math.abs(x - 32) + Math.abs(y - 32) < 20 ? 255 : 0]);
  assert.ok(blankImage(hidden));
  assert.ok(!blankImage(silhouette));
  assert.ok(blankImage(rgbaFrame(() => [250, 250, 250, 255])));
  assert.deepEqual([...composite(rgbaFrame(() => [200, 100, 0, 128]), 255).subarray(0, 3)], [227, 177, 127]);
  const fake = fakeExec({ "hidden.png": { pix: "rgba" }, "shape.png": { pix: "rgba" } }, { "hidden.png": hidden, "shape.png": silhouette });
  const r = await check([{ role: "still", file: file("hidden.png") }, { role: "still", file: file("shape.png") }], fake);
  assert.deepEqual(r.problems, ["hidden.png: the image is blank (one flat colour)"]);
});

test("refuses HEVC, wrong pixel format, short, oversize and webm", async () => {
  const fake = fakeExec({ "hevc.mp4": { codec: "hevc" }, "pix.mp4": { pix: "yuv444p" }, "short.mp4": { duration: "0.4" }, "big.mp4": {}, "w.webm": { codec: "vp9" } });
  const r = await check(
    [
      { role: "video", file: file("hevc.mp4") },
      { role: "video", file: file("pix.mp4") },
      { role: "video", file: file("short.mp4") },
      { role: "video", file: file("big.mp4", 26 * 1024 * 1024) },
      { role: "video", file: file("w.webm") },
    ],
    fake,
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, [
    "hevc.mp4: video codec hevc, not H.264; a phone may not play it (re-encode with -c:v libx264 -pix_fmt yuv420p)",
    "pix.mp4: pixel format yuv444p, not yuv420p; phones may not play it (re-encode with -pix_fmt yuv420p)",
    "short.mp4: 0.4 s; a clip runs longer than 0.5 s",
    "big.mp4: 26.0 MB, over the 25 MB limit",
    "w.webm: not H.264 mp4; a phone may not play it (re-encode to mp4, or add --allow-webm)",
  ]);
  assert.deepEqual(await check([{ role: "video", file: file("w.webm") }], fake, { allowWebm: true }), { ok: true, problems: [] });
});

test("refuses a blank first frame, a blank still and grey padding", async () => {
  const padded = frame((x, y) => (x < SIDE / 2 ? page(x, y) : PAD_GREY));
  const fake = fakeExec({ "blank.mp4": {}, "blank.png": {}, "pad.mp4": {} }, { "blank.mp4": frame(() => [17, 17, 17]), "blank.png": frame(() => [250, 250, 250]), "pad.mp4": padded });
  const r = await check(
    [
      { role: "video", file: file("blank.mp4") },
      { role: "still", file: file("blank.png") },
      { role: "video", file: file("pad.mp4") },
    ],
    fake,
  );
  assert.equal(r.problems.length, 3);
  assert.match(r.problems[0], /^blank\.mp4: the first frame is blank/);
  assert.match(r.problems[1], /^blank\.png: the image is blank/);
  assert.match(r.problems[2], /^pad\.mp4: the page sits in the top-left corner, with grey padding along the right edge/);
  assert.deepEqual(await check([{ role: "video", file: file("pad.mp4") }], fake, { skipCorner: true }), { ok: true, problems: [] });
});

test("before and after must be the same size", async () => {
  const fake = fakeExec({ "b.mp4": { width: 780, height: 1688 }, "a.mp4": { width: 800, height: 1688 } });
  const r = await check([{ role: "before", file: file("b.mp4") }, { role: "after", file: file("a.mp4") }], fake);
  assert.deepEqual(r.problems, ["before b.mp4 is 780x1688 but after a.mp4 is 800x1688; record both at the same size"]);
});

test("--viewport takes exact multiples at DPR 1 to 4", async () => {
  assert.deepEqual(parseViewport("390x844"), { width: 390, height: 844 });
  for (const bad of ["390", "0x844", "390x", "390X844", "20000x10"]) assert.equal(parseViewport(bad), null, bad);
  const viewport = { width: 390, height: 844 };
  const fake = fakeExec({ "one.mp4": { width: 390, height: 844 }, "three.png": { width: 1170, height: 2532 }, "off.png": { width: 1200, height: 2532 }, "five.mp4": { width: 1950, height: 4220 } });
  const ok = await check([{ role: "video", file: file("one.mp4") }, { role: "still", file: file("three.png") }], fake, { viewport });
  assert.deepEqual(ok, { ok: true, problems: [] });
  const r = await check([{ role: "still", file: file("off.png") }, { role: "video", file: file("five.mp4") }], fake, { viewport });
  assert.deepEqual(r.problems, [
    "off.png: 1200x2532 is not the 390x844 viewport at DPR 1 to 4; expected 390x844, 780x1688, 1170x2532 or 1560x3376",
    "five.mp4: 1950x4220 is not the 390x844 viewport at DPR 1 to 4; expected 390x844, 780x1688, 1170x2532 or 1560x3376",
  ]);
  assert.equal((await check([{ role: "still", file: file("off.png") }], fake)).ok, true, "no --viewport, no multiple check");
});

test("fails closed without ffprobe or ffmpeg", async () => {
  const fake = fakeExec({ "a.mp4": {} });
  const missing = await preflight([{ role: "video", file: file("a.mp4") }], { exec: fake.exec, ffmpeg: "/fake/ffmpeg", tmpdir: TMP });
  assert.equal(missing.ok, false);
  assert.match(missing.problems[0], /^ffprobe not found on PATH: media is not sent unchecked/);
  assert.equal(fake.calls.length, 0);
  const enoent = await check([{ role: "video", file: file("a.mp4") }], {
    exec: async () => {
      throw Object.assign(new Error("ffprobe exit ENOENT"), { code: "ENOENT" });
    },
    calls: [],
  });
  assert.deepEqual(enoent, { ok: false, problems: ["ffprobe could not run: media is not sent unchecked (brew install ffmpeg)"] });
  const unreadable = await check([{ role: "video", file: file("junk.mp4") }], fake);
  assert.deepEqual(unreadable.problems, ["junk.mp4: ffprobe cannot read it (Invalid data found when processing input)"]);
});

/** @param {string[]} argv @param {Partial<import("../../scripts/rivet.mjs").Deps>} deps */
async function cli(argv, deps) {
  let stdout = "";
  let stderr = "";
  let fetches = 0;
  const code = await run(argv, {
    env: { RIVET_BRIDGE_DEV: "1", RIVET_BOARD_TOKEN: "cd".repeat(32), RIVET_URL: "http://localhost:5999", PATH: "" },
    bin: (name) => `/fake/${name}`,
    tmpdir: TMP,
    fetch: async () => {
      fetches++;
      return new Response("{}", { status: 500 });
    },
    ...deps,
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
  });
  return { code, stdout, stderr, fetches };
}

test("card add with refused media exits 5 and calls no server", async () => {
  const fake = fakeExec({ "hevc.mp4": { codec: "hevc" } });
  const r = await cli(["card", "add", "cam-pick", "--title", "Camera", "--after", file("hevc.mp4")], { exec: fake.exec });
  assert.equal(r.code, 5);
  assert.equal(r.fetches, 0);
  assert.match(r.stderr, /rivet: hevc\.mp4: video codec hevc, not H\.264/);
  assert.match(r.stderr, /media refused; nothing was uploaded or carded/);
  const edit = await cli(["card", "edit", "cam-pick", "--still", file("s.png")], {
    exec: fake.exec,
    bin: (name) => {
      if (name === "ffprobe") throw new Error("ffprobe not found on PATH");
      return `/fake/${name}`;
    },
  });
  assert.equal(edit.code, 5);
  assert.equal(edit.fetches, 0);
  assert.match(edit.stderr, /ffprobe not found on PATH/);
});

test("--skip-preflight warns and goes on to the server", async () => {
  const fake = fakeExec({});
  const r = await cli(["card", "add", "cam-pick", "--still", file("s.png"), "--after", file("junk.mp4"), "--skip-preflight"], { exec: fake.exec });
  assert.match(r.stderr, /WARNING --skip-preflight: this media is NOT checked/);
  assert.doesNotMatch(r.stderr, /corner check|grey padding/, "the legacy corner check is skipped too");
  assert.ok(r.fetches > 0);
  assert.equal(fake.calls.length, 0);
});

test("media check exits 0 clean and 5 on a problem", async () => {
  const fake = fakeExec({ "b.mp4": {}, "a.mp4": {}, "s.png": { width: 390, height: 844 } });
  const clean = await cli(["media", "check", file("s.png"), "--before", file("b.mp4"), "--after", file("a.mp4")], { exec: fake.exec });
  assert.equal(clean.code, 0, clean.stderr);
  assert.equal(clean.stdout, "media ok: 3 files checked\n");
  const bad = await cli(["media", "check", "--before", file("b.mp4"), "--after", file("a.mp4"), "--viewport", "400x800"], { exec: fake.exec });
  assert.equal(bad.code, 5);
  assert.match(bad.stderr, /b\.mp4: 780x1688 is not the 400x800 viewport/);
  assert.equal(bad.fetches, 0);
  assert.equal((await cli(["media", "check"], { exec: fake.exec })).code, 2);
  assert.equal((await cli(["media", "check", "x.mp4", "--viewport", "big"], { exec: fake.exec })).code, 2);
});

let ffmpeg = "";
let ffprobe = "";
try {
  ffmpeg = resolveBin("ffmpeg");
  ffprobe = resolveBin("ffprobe");
} catch {}

test("a real testsrc clip passes and a flat grey one is blank", { skip: !ffmpeg || !ffprobe ? "ffmpeg not installed" : false }, async () => {
  const exec = makeExec();
  /** @param {string} name @param {string} src */
  const make = async (name, src) => {
    const out = path.join(TMP, name);
    await exec(ffmpeg, ["-v", "error", "-nostdin", "-f", "lavfi", "-i", `${src}:size=160x320:rate=10:duration=1`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", out], { timeout: 60_000 });
    return out;
  };
  const busy = await make("busy.mp4", "testsrc=decimals=0");
  const grey = await make("grey.mp4", "color=c=0x404040");
  const opts = { exec, ffprobe, ffmpeg, tmpdir: TMP };
  assert.deepEqual(await preflight([{ role: "before", file: busy }], opts), { ok: true, problems: [] });
  const r = await preflight([{ role: "after", file: grey }], opts);
  assert.deepEqual(r.problems, ["grey.mp4: the first frame is blank (one flat colour); start the clip after the page has painted"]);

  // -display_rotation arrived after FFmpeg 5.1; older installs skip only this part.
  const turned = path.join(TMP, "turned.mp4");
  const rotates = await exec(ffmpeg, ["-v", "error", "-nostdin", "-display_rotation", "90", "-i", busy, "-c", "copy", "-y", turned], { timeout: 60_000 }).then(
    () => true,
    () => false,
  );
  if (rotates) assert.deepEqual(await preflight([{ role: "before", file: turned }], { ...opts, viewport: { width: 320, height: 160 } }), { ok: true, problems: [] });

  // A jpg coded 640x320 with EXIF Orientation 6 shows as 320x640. The APP1 segment is written by hand: no exiftool.
  const coded = path.join(TMP, "coded.jpg");
  await exec(ffmpeg, ["-v", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc=size=640x320", "-frames:v", "1", "-y", coded], { timeout: 60_000 });
  const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
  const app1 = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const jpg = fs.readFileSync(coded);
  const oriented = path.join(TMP, "oriented.jpg");
  fs.writeFileSync(oriented, Buffer.concat([jpg.subarray(0, 2), Buffer.from([0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255]), app1, jpg.subarray(2)]));
  assert.deepEqual(await preflight([{ role: "still", file: oriented }], { ...opts, viewport: { width: 320, height: 640 } }), { ok: true, problems: [] });

  const clear = path.join(TMP, "clear.png");
  await exec(ffmpeg, ["-v", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc=size=64x64,format=rgba,colorchannelmixer=aa=0", "-frames:v", "1", "-y", clear], { timeout: 60_000 });
  assert.deepEqual((await preflight([{ role: "still", file: clear }], opts)).problems, ["clear.png: the image is blank (one flat colour)"]);
  const renamed = path.join(TMP, "renamed.png");
  fs.copyFileSync(busy, renamed);
  assert.deepEqual((await preflight([{ role: "still", file: renamed }], opts)).problems, ["renamed.png: not a png image inside (ffprobe reads h264)"]);
  const boxed = path.join(TMP, "boxed.jpg");
  await exec(ffmpeg, ["-v", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=1", "-t", "1", "-c:v", "mjpeg", "-f", "avi", "-y", boxed], { timeout: 60_000 });
  assert.deepEqual((await preflight([{ role: "still", file: boxed }], opts)).problems, ["boxed.jpg: a avi file, not a single jpg image"]);
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
