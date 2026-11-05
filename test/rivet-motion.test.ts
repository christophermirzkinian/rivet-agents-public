// @vitest-environment happy-dom
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MOODS, rivet } from "../web/src/rivet/rivet.js";

// The home screen's motion ran on the phone's main thread at rest. An animation inside an SVG, or of a paint-only
// property (stroke-dashoffset, clip-path), repaints every frame; transform and opacity on an HTML layer run on the
// compositor. Rivet's eyes and working dots are HTML layers now, the desk lines pulse and the typing lines scale.
const SRC = join(dirname(fileURLToPath(import.meta.url)), "../web/src");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");

describe("Rivet's moving parts", () => {
  it("are HTML layers over a still drawing, at every mood and tone", () => {
    for (const tone of ["rivet", "agent"] as const) {
      for (const mood of MOODS) {
        const el = rivet(mood, { tone });
        const base = el.querySelector(".rivet-hover > svg.rv-base");
        expect(base, `${tone} ${mood}`).not.toBeNull();
        expect(base?.querySelector(".rv-eyes, .rv-look, .rv-dots, circle:not(.rv-fill)"), `${tone} ${mood}`).toBeNull();
        const look = el.querySelector(".rivet-hover > div.rv-eyes > div.rv-look > svg");
        expect(look?.innerHTML.trim(), `${tone} ${mood}`).not.toBe("");
      }
    }
  });

  it("draws the working dots as three layers of their own, and only on Rivet", () => {
    for (const mood of ["working", "thinking"] as const) {
      const dots = [...rivet(mood).querySelectorAll(".rivet-hover > svg.rv-dot")];
      // Classes, not an inline style: the CSP refuses those (style-src 'self').
      expect(dots.map((dot) => dot.getAttribute("class"))).toEqual(["rv-dot rv-dot-0", "rv-dot rv-dot-1", "rv-dot rv-dot-2"]);
      expect(dots.some((dot) => dot.hasAttribute("style"))).toBe(false);
      expect(dots.every((dot) => dot.querySelectorAll("circle").length === 1)).toBe(true);
      expect(rivet(mood, { tone: "agent" }).querySelector(".rv-dot")).toBeNull();
    }
    expect(rivet("clear").querySelector(".rv-dot")).toBeNull();
  });
});

describe("the app's keyframes", () => {
  const files = (dir: string): string[] =>
    readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".css") ? [join(dir, entry.name)] : [],
    );
  /** Paint-only keyframes left as they are: a dot on More's Home lines, and the mic while it listens. */
  const LEFT = new Set(["home-flow", "dictate-pulse"]);
  const COMPOSITED = new Set(["transform", "translate", "scale", "rotate", "opacity"]);

  it("move only what the compositor can run", () => {
    const paint: string[] = [];
    for (const file of files(".")) {
      for (const [, name = "", body = ""] of read(file).matchAll(/@keyframes ([\w-]+) \{([\s\S]*?)\n\}/g)) {
        const props = [...body.matchAll(/([a-z-]+):/g)].map((match) => match[1] ?? "");
        if (!LEFT.has(name) && props.some((prop) => !COMPOSITED.has(prop))) paint.push(`${file} ${name}`);
      }
    }
    expect(paint).toEqual([]);
  });

  // The home screen's pause under a tall sheet is sheet.ts's, by script (sheet-leave-dom): a style rule over every home-screen element
  // and its pseudo-elements restyled them all on each open and close.
  it("pause the home screen under a tall sheet without a rule over all of it, and still every Rivet in a chat but the newest", () => {
    expect(read("styles.css")).not.toMatch(/main\.view \*/);
    expect(read("views/sheet.ts")).toMatch(/getAnimations\(\{ subtree: true \}\)[\s\S]*animation\.pause\(\)/);
    expect(read("views/command.css")).toMatch(
      /\.chat-msg\.has-rivet:not\(:nth-last-child\(1 of \.has-rivet\)\) \.chat-rivet \*\s*\{\s*animation: none;/,
    );
  });
});
