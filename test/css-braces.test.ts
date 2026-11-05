import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// An unmatched brace makes the browser drop the rules after it without a word (ops.css, 2026-10-24).
const VIEWS = join(import.meta.dirname, "../web/src/views");

describe("The views' stylesheets", () => {
  for (const file of readdirSync(VIEWS).filter((name) => name.endsWith(".css")))
    it(`${file} closes every brace it opens`, () => {
      const css = readFileSync(join(VIEWS, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
      let depth = 0;
      for (const char of css) {
        if (char === "{") depth++;
        else if (char === "}") depth--;
        expect(depth).toBeGreaterThanOrEqual(0);
      }
      expect(depth).toBe(0);
    });
});
