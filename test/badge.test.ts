import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

const pub = join(import.meta.dirname, "..", "web", "public");

/** Decodes an 8-bit RGBA, non-interlaced PNG: the only kind render-badge.mjs writes. */
function decodeRgba(png: Buffer): { width: number; height: number; px: Buffer } {
  let at = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([data.readUInt8(8), data.readUInt8(9), data.readUInt8(12)], "8-bit RGBA, not interlaced").toEqual([8, 6, 0]);
    } else if (type === "IDAT") idat.push(data);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw.readUInt8(y * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const v = raw.readUInt8(y * (stride + 1) + 1 + x);
      const a = x >= 4 ? px.readUInt8(y * stride + x - 4) : 0;
      const b = y > 0 ? px.readUInt8((y - 1) * stride + x) : 0;
      const c = x >= 4 && y > 0 ? px.readUInt8((y - 1) * stride + x - 4) : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][filter] ?? 0;
      px[y * stride + x] = (v + pred) & 0xff;
    }
  }
  return { width, height, px };
}

describe("Android notification badge", () => {
  it("is what the service worker shows, and the colour icon stays the icon", () => {
    expect(readFileSync(join(pub, "sw.js"), "utf8")).toContain('importScripts("/sw-logic.js")');
    const sw = readFileSync(join(pub, "sw-logic.js"), "utf8");
    expect(sw).toContain('badge: "/badge-96.png"');
    expect(sw).toContain('icon: "/icon-192.png"');
  });

  it.each([96, 72, 48])("at %i px is a white silhouette on a transparent ground, so Android's alpha mask draws Rivet and not a square", (size) => {
    const { width, height, px } = decodeRgba(readFileSync(join(pub, `badge-${size}.png`)));
    expect([width, height]).toEqual([size, size]);
    let clear = 0;
    let solid = 0;
    for (let i = 0; i < px.length; i += 4) {
      const alpha = px.readUInt8(i + 3);
      if (alpha === 0) clear++;
      else if (alpha === 255) solid++;
      // Every visible pixel is white, so no colour is lost to the mask.
      if (alpha > 0) expect([px[i], px[i + 1], px[i + 2]]).toEqual([255, 255, 255]);
    }
    const total = width * height;
    const scaled = (v: number) => Math.min(size - 1, Math.round((v * size) / 96));
    const alphaAt = (x: number, y: number) => px.readUInt8((scaled(y) * width + scaled(x)) * 4 + 3);
    for (const [x, y] of [[0, 0], [95, 0], [0, 95], [95, 95]] as const) expect(alphaAt(x, y), "corners are see-through").toBe(0);
    expect(alphaAt(19, 67), "his body is solid").toBe(255);
    expect(alphaAt(36, 36), "an eye is solid").toBe(255);
    expect(alphaAt(48, 29), "the visor between his eyes is see-through").toBe(0);
    expect(clear / total).toBeGreaterThan(0.3);
    expect(solid / total).toBeGreaterThan(0.2);
  });
});
