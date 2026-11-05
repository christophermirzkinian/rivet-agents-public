import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BODY,
  EYES,
  FRONT,
  MARK_STROKE,
  MOODS,
  VISOR,
} from "../web/src/rivet/rivet.js";

/**
 * Rivet's front symbols sit wholly in the yellow below his visor, never touching it, at every size he is drawn
 *. The eyes stay inside the visor too.
 */

/** Clear yellow kept between a symbol and the visor or the body's edge, in viewBox units. */
const GAP = 3;
/** And never less than this many screen pixels at any size drawn. */
const MIN_PX = 1;
const EYE_STROKE = 6;

type Box = { x0: number; y0: number; x1: number; y1: number };

/** The control-point hull of an absolute-command path: a box the drawn curve can never leave. */
function pathBox(d: string): Box {
  expect(d, `"${d}" uses only absolute commands`).not.toMatch(/[a-z]/);
  const tokens = d.match(/[MLCSHVZ]|-?\d*\.?\d+/g) ?? [];
  const xs: number[] = [];
  const ys: number[] = [];
  let cmd = "";
  let cur: [number, number] = [0, 0];
  let ctrl2: [number, number] | null = null;
  const nums: number[] = [];
  const next = (): number => {
    const n = nums.shift();
    if (n === undefined)
      throw new Error(`"${d}" is missing a number after ${cmd}`);
    return n;
  };
  const point = (x: number, y: number) => (xs.push(x), ys.push(y));
  const flush = () => {
    while (nums.length) {
      if (cmd === "M" || cmd === "L") {
        cur = [next(), next()];
        point(...cur);
        ctrl2 = null;
        if (cmd === "M") cmd = "L";
      } else if (cmd === "C" || cmd === "S") {
        const c1: [number, number] =
          cmd === "C"
            ? [next(), next()]
            : ctrl2
              ? [2 * cur[0] - ctrl2[0], 2 * cur[1] - ctrl2[1]]
              : cur;
        const c2: [number, number] = [next(), next()];
        cur = [next(), next()];
        (point(...c1), point(...c2), point(...cur));
        ctrl2 = c2;
      } else if (cmd === "H") {
        cur = [next(), cur[1]];
        point(...cur);
      } else if (cmd === "V") {
        cur = [cur[0], next()];
        point(...cur);
      } else throw new Error(`unhandled path command ${cmd} in "${d}"`);
    }
  };
  for (const t of tokens) {
    if (/[A-Z]/.test(t)) {
      flush();
      cmd = t;
    } else nums.push(Number(t));
  }
  flush();
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

const corners = (b: Box): [number, number][] => [
  [b.x0, b.y0],
  [b.x1, b.y0],
  [b.x0, b.y1],
  [b.x1, b.y1],
];
const grow = (b: Box, by: number): Box => ({
  x0: b.x0 - by,
  y0: b.y0 - by,
  x1: b.x1 + by,
  y1: b.y1 + by,
});
const union = (boxes: Box[]): Box => ({
  x0: Math.min(...boxes.map((b) => b.x0)),
  y0: Math.min(...boxes.map((b) => b.y0)),
  x1: Math.max(...boxes.map((b) => b.x1)),
  y1: Math.max(...boxes.map((b) => b.y1)),
});

/** Every part of an SVG snippet's ink, stroke included. */
function inkBox(svg: string, stroke: number): Box {
  const boxes: Box[] = [];
  for (const m of svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g))
    boxes.push(grow(pathBox(m[1] ?? ""), stroke / 2));
  for (const m of svg.matchAll(
    /<circle\b[^>]*\bcx="([\d.]+)"[^>]*\bcy="([\d.]+)"[^>]*\br="([\d.]+)"/g,
  )) {
    const [cx, cy, r] = [Number(m[1]), Number(m[2]), Number(m[3])];
    boxes.push({ x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r });
  }
  expect(boxes.length, `ink in ${svg}`).toBeGreaterThan(0);
  return union(boxes);
}

/** Whether a point lies inside a rounded rectangle, `inset` in from its edge. */
function inRoundRect(
  x: number,
  y: number,
  r: { x: number; y: number; width: number; height: number; rx: number },
  inset: number,
): boolean {
  const x0 = r.x + inset;
  const y0 = r.y + inset;
  const x1 = r.x + r.width - inset;
  const y1 = r.y + r.height - inset;
  const rx = Math.max(0, r.rx - inset);
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + rx), x1 - rx);
  const cy = Math.min(Math.max(y, y0 + rx), y1 - rx);
  return Math.hypot(x - cx, y - cy) <= rx;
}

/** Every size Rivet is drawn at in the app (from the source), and the app icon's sizes. */
function sizesUsed(): number[] {
  const root = join(import.meta.dirname, "../web/src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.ts$/.test(name)) files.push(path);
    }
  };
  walk(root);
  const sizes = new Set<number>();
  for (const file of files) {
    for (const call of readFileSync(file, "utf8").matchAll(
      /\brivet\([^;]*?size:\s*([^,}]+)/g,
    )) {
      for (const n of (call[1] ?? "").matchAll(/\d+(?:\.\d+)?/g))
        sizes.add(Number(n[0]));
    }
  }
  const manifest = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../web/public/manifest.webmanifest"),
      "utf8",
    ),
  ) as { icons?: { sizes?: string }[] };
  for (const icon of manifest.icons ?? [])
    for (const s of (icon.sizes ?? "").split(/\s+/))
      if (/^\d+x\d+$/.test(s)) sizes.add(Number(s.split("x")[0]));
  return [...sizes].sort((a, b) => a - b);
}

const SIZES = sizesUsed();
const visorBottom = VISOR.y + VISOR.height;
const innerBody = {
  ...BODY,
  x: BODY.x + BODY.stroke / 2,
  y: BODY.y + BODY.stroke / 2,
  width: BODY.width - BODY.stroke,
  height: BODY.height - BODY.stroke,
  rx: BODY.rx - BODY.stroke / 2,
};

describe("Rivet's front symbols stay in his yellow stomach", () => {
  it("finds the sizes he is drawn at", () => {
    expect(SIZES.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...SIZES)).toBeGreaterThan(0);
  });

  for (const mood of MOODS) {
    it(`${mood}: clear of the visor and inside the body at every size`, () => {
      const box = inkBox(FRONT[mood], MARK_STROKE);
      expect(
        box.y0 - visorBottom,
        `${mood} sits ${GAP} below the visor`,
      ).toBeGreaterThanOrEqual(GAP);
      for (const [x, y] of corners(box))
        expect(
          inRoundRect(x, y, innerBody, GAP),
          `${mood} corner ${x},${y} inside the yellow`,
        ).toBe(true);
      for (const size of SIZES)
        expect(
          ((box.y0 - visorBottom) * size) / 100,
          `${mood} at ${size}px`,
        ).toBeGreaterThanOrEqual(MIN_PX);
    });

    it(`${mood}: the eyes stay inside the visor`, () => {
      const box = inkBox(EYES[mood], EYE_STROKE);
      for (const [x, y] of corners(box))
        expect(
          inRoundRect(x, y, VISOR, 0),
          `${mood} eye ${x},${y} inside the visor`,
        ).toBe(true);
    });
  }

  it("the app icon's tick is clear of its visor too", () => {
    const svg = readFileSync(
      join(import.meta.dirname, "../web/public/icon.svg"),
      "utf8",
    );
    const visor = svg.match(/<rect\b[^>]*fill="#3a2a0f"[^>]*>/)?.[0] ?? "";
    const y = Number(visor.match(/\by="([\d.]+)"/)?.[1]);
    const h = Number(visor.match(/\bheight="([\d.]+)"/)?.[1]);
    const stroke = Number(svg.match(/stroke-width="([\d.]+)"/)?.[1]);
    const tick = inkBox(svg.match(/<path\b[^>]*>/)?.[0] ?? "", stroke);
    expect(tick.y0 - (y + h)).toBeGreaterThanOrEqual(GAP);
  });
});
