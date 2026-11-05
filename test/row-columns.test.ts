import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// A row grid with fixed columns beside a `minmax(0, 1fr)` title squeezes the title to nothing in a box narrower than
// its columns: the In hand sheet's 640px dialog on a wide window gave the desktop table's 552px of fixed columns all
// its room, and a long title stood one letter wide, thousands of pixels tall. A grid
// whose fixed columns take more than a phone row can spare is laid out only in a container that leaves the title room.

const WEB = join(import.meta.dirname, "../web/src");
/** The most fixed columns (with their gaps) a grid may have and still be laid out at any width. */
const FIXED_FREE = 160;
/** What a gated grid's flexible column keeps at the narrowest width its container query allows. */
const TITLE_ROOM = 240;
/** A row's own padding and border, inside its container's width: `.desktop .ask-row`'s 16px sides and 1px border. */
const ROW_FRAME = 34;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : name.endsWith(".css") ? [path] : [];
  });
}

/** A value's top-level tracks: `minmax(0, 1fr) 150px` is two, whatever is inside the brackets. */
function tracks(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let word = "";
  for (const char of value.trim()) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (/\s/.test(char) && depth === 0) {
      if (word) out.push(word);
      word = "";
    } else word += char;
  }
  if (word) out.push(word);
  return out;
}

interface Grid {
  where: string;
  selector: string;
  fixed: number;
  /** The `min-width` of the container queries the rule sits in, the largest; 0 when it sits in none. */
  gate: number;
}

/** Every rule with a flexible column and fixed pixel columns, and the container width it is gated on. */
function grids(): Grid[] {
  const found: Grid[] = [];
  for (const sheet of files(WEB)) {
    const css = readFileSync(sheet, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const stack: number[] = [];
    // A rule with no gap of its own takes the one an earlier rule gave the same rows (Done today's from the table's).
    let lastGap = 0;
    for (const match of css.matchAll(/([^{}]*)([{}])/g)) {
      const head = match[1]!.trim();
      if (match[2] === "}") {
        stack.pop();
        continue;
      }
      const body = css.slice(match.index! + match[0].length, css.indexOf("}", match.index! + match[0].length));
      const gate = /^@container\b/.test(head) ? Number(/min-width:\s*(\d+)px/.exec(head)?.[1] ?? 0) : 0;
      stack.push(gate);
      if (head.startsWith("@")) continue;
      const columns = /(?:^|[\s;])grid-template-columns\s*:\s*([^;]+)/.exec(body)?.[1];
      if (!columns) continue;
      const list = tracks(columns);
      if (!list.some((track) => track.includes("fr"))) continue;
      const px = list.filter((track) => /^\d+(\.\d+)?px$/.test(track)).map((track) => parseFloat(track));
      if (!px.length) continue;
      const own = /(?:^|[\s;])(?:column-)?gap\s*:\s*(\d+)px/.exec(body)?.[1];
      const gap = own === undefined ? lastGap : parseFloat(own);
      lastGap = gap;
      found.push({ where: relative(WEB, sheet), selector: head, fixed: px.reduce((a, b) => a + b, 0) + gap * (list.length - 1), gate: Math.max(0, ...stack) });
    }
  }
  return found;
}

describe("a row grid's fixed columns", () => {
  it("leave its title room wherever the grid is laid out", () => {
    const all = grids();
    // The check reads the rows it guards: the In hand and Done today table's columns are among them.
    expect(all.filter((grid) => grid.selector.includes(".ask-row")).length).toBeGreaterThanOrEqual(2);
    const squeezed = all
      .filter((grid) => grid.fixed > FIXED_FREE && grid.gate - ROW_FRAME - grid.fixed < TITLE_ROOM)
      .map((grid) => `${grid.where} ${grid.selector}: ${grid.fixed}px fixed, laid out from ${grid.gate}px`);
    expect(squeezed).toEqual([]);
  });
});
