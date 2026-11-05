import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Rivet's CSP (style-src 'self', src/server/http.ts) refuses a style attribute: a timeline that set its places with
 * `attrs: { style }` had every stem, label and NOW sat at the bar's left edge on the deployed app, while the dev preview
 * (no CSP) looked right. Places go through the element's style object (el.style.left = …), which the CSP allows.
 * Each file is read whole, so a shape split across lines is still found.
 */
const SHAPES = [
  /setAttribute(\(|NS\([^,()]*,)\s*["'`]style["'`]/g, // setAttribute("style", …), across lines too
  /\bstyle=\\?["']/g, // style="…" in markup
  /\bcssText\b/g,
  /\b(h|createElement)\(\s*["'`]style["'`]/g, // an inline <style> element, refused by the same rule
];
/** A `style` key in an h() attrs object: `attrs: { style: … }` or the shorthand `attrs: { style }`. */
const STYLE_KEY = /(^|[{,])\s*["']?style["']?\s*[:,}]/;

/** Every attrs object's text, its braces matched (a template literal's ${…} keeps them balanced). */
function attrsObjects(text: string): { at: number; body: string }[] {
  const found: { at: number; body: string }[] = [];
  for (const match of text.matchAll(/\battrs\s*:\s*\{/g)) {
    const start = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = start; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}" && --depth === 0) {
        found.push({ at: match.index, body: text.slice(start, i + 1) });
        break;
      }
    }
  }
  return found;
}

function inlineStyles(text: string): number[] {
  return [
    ...SHAPES.flatMap((shape) => [...text.matchAll(shape)].map((match) => match.index)),
    ...attrsObjects(text).flatMap((object) => (STYLE_KEY.test(object.body) ? [object.at] : [])),
  ];
}

const WEB = join(import.meta.dirname, "../web/src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") && !path.endsWith(".preview.ts") ? [path] : [];
  });
}

describe("no inline style attributes in the web app", () => {
  it("still refuses inline styles in the server's CSP, so this guard matters", () => {
    const csp = readFileSync(join(import.meta.dirname, "../src/server/http.ts"), "utf8");
    expect(csp).toContain(`"style-src 'self'"`);
    expect(csp).not.toMatch(/style-src[^"]*unsafe-inline/);
  });

  it("finds the shapes that broke the timeline, on one line or several", () => {
    for (const text of [
      'h("span", { attrs: { style: `left:${x}px` } })',
      'h("button", {\n  class: "x",\n  attrs: {\n    "aria-label": `${a}`,\n    style: `left:${x}px`,\n  },\n})',
      'h("span", { attrs: { style:\n  `left:${x}px` } })',
      'const style = "left:10px";\nh("span", { attrs: { style } })',
      'h("span", { attrs: { type: "button", style } })',
      'h("span", { attrs: { "style": s } })',
      'el.setAttribute("style", "left:0")',
      "el.setAttribute(\n  'style',\n  css,\n)",
      'el.setAttributeNS(null, "style", css)',
      '<span style="left:0">',
      "el.style.cssText = s",
      'h("style", {}, ".x{display:none}")',
      'document.createElement("style")',
    ])
      expect(inlineStyles(text), text).not.toEqual([]);
    for (const text of [
      "el.style.left = `${x}px`;",
      "Object.assign(el.style, { left: `${x}px` });",
      'new Intl.NumberFormat("en-AU", { style: "percent" })',
      "new Intl.RelativeTimeFormat(\"en\", { style: 'short' })",
      "function place(el: HTMLElement, style: Partial<Record<\"left\", string>>) {}",
      'h("span", { class: "x", attrs: { "data-style": "a", title: `${n}` } })',
      'h("span", { class: "style" })',
    ])
      expect(inlineStyles(text), text).toEqual([]);
  });

  it("finds none in web/src", () => {
    const all = files(WEB);
    expect(all.length).toBeGreaterThan(50);
    // The scan reads real attrs objects, so a guard that matched nothing would show here.
    expect(all.reduce((sum, path) => sum + attrsObjects(readFileSync(path, "utf8")).length, 0)).toBeGreaterThan(100);
    const hits = all.flatMap((path) => {
      const text = readFileSync(path, "utf8");
      return inlineStyles(text).map((at) => `${path.slice(WEB.length + 1)}:${text.slice(0, at).split("\n").length}`);
    });
    expect(hits).toEqual([]);
  });
});
