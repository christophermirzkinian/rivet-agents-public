import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A long sheet scrolls its body only, so the heading and Close stay in reach, and the Asks sheet's tabs stay under its
// heading.
// happy-dom lays nothing out, so the rules themselves are read here; a scrolled phone still shows them.
const read = (file: string) => readFileSync(new URL(`../web/src/${file}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (css: string, selector: string) => {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (match[1]!.trim() === selector) return match[2]!;
  return "";
};

describe("a long sheet keeps its heading and Close in reach", () => {
  const styles = read("styles.css");

  it("scrolls the body, which may shrink, not the heading or Close", () => {
    const body = rule(styles, ".sheet:not(.is-tall) > .sheet-body");
    expect(body).toMatch(/overflow-y: auto;/);
    expect(body).toMatch(/min-height: 0;/);
    expect(body).toMatch(/flex: 0 1 auto;/);
    expect(rule(styles, ".sheet:not(.is-tall) > :not(.sheet-body)")).toMatch(/flex: none;/);
  });

  it("keeps Close above the safe area", () => {
    expect(rule(styles, ".sheet")).toMatch(/padding: [^;]*env\(safe-area-inset-bottom\)/);
  });
});

describe("the Asks sheet's tabs stay under its heading", () => {
  const due = read("views/due-line.css");

  it("holds the body still and scrolls only the list", () => {
    // As specific as the generic body rule and later, so it wins: the body holds still.
    expect(rule(due, ".sheet.chat-due-sheet:not(.is-tall) > .sheet-body")).toMatch(/overflow: hidden;/);
    expect(rule(due, ".chat-due-tabs")).toMatch(/flex: none;/);
    const pane = rule(due, ".chat-due-pane");
    expect(pane).toMatch(/overflow-y: auto;/);
    expect(pane).toMatch(/min-height: 0;/);
  });
});
