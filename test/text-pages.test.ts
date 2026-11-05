// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lexer } from "marked";

import { MD_MAX_TOKEN_CHARS, tokensWithin } from "../web/src/views/markdown-size.js";
import { describe, expect, it } from "vitest";

import { decodeRefs, formattable, markdownDom, MD_CAP_BYTES, plainText, safeHref, TEXT_CAP_BYTES, textContent } from "../web/src/views/text-pages.js";

// The linear-time guards below time CPU, not the wall clock: a loaded runner stalls a run until its CPU quota
// refills, while a quadratic or backtracking parse still costs the CPU it always did.
const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

// The text viewer: Markdown made into elements one by one, never through HTML, and plain text and JSON as they read.

const render = (source: string) => {
  const box = document.createElement("div");
  box.append(markdownDom(source));
  return box;
};

describe("markdownDom", () => {
  it("builds headings, emphasis, inline code, quotes, rules and code blocks", () => {
    const box = render("# Title\n\n## Part\n\nSome **bold**, *soft*, ~~gone~~ and `x < y`.\n\n> quoted\n\n---\n\n```js\nif (a < b) run();\n```\n");
    expect(box.querySelector("h1")!.textContent).toBe("Title");
    expect(box.querySelector("h2")!.textContent).toBe("Part");
    expect(box.querySelector("p strong")!.textContent).toBe("bold");
    expect(box.querySelector("p em")!.textContent).toBe("soft");
    expect(box.querySelector("p del")!.textContent).toBe("gone");
    expect(box.querySelector("p code")!.textContent).toBe("x < y");
    expect(box.querySelector("blockquote p")!.textContent).toBe("quoted");
    expect(box.querySelector("hr")).not.toBeNull();
    expect(box.querySelector("pre code")!.textContent).toBe("if (a < b) run();");
  });

  it("builds nested, numbered and task lists", () => {
    const box = render("- [x] done\n- [ ] todo\n  - nested\n\n3. three\n4. four\n");
    const tasks = [...box.querySelectorAll<HTMLInputElement>("input.md-task")];
    expect(tasks.map((task) => [task.checked, task.disabled])).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(box.querySelector("ul li ul li")!.textContent).toBe("nested");
    expect(box.querySelector("ol")!.getAttribute("start")).toBe("3");
    expect([...box.querySelectorAll("ol li")].map((li) => li.textContent)).toEqual(["three", "four"]);
  });

  it("builds a table with its columns' alignment", () => {
    const box = render("| Job | Runs |\n|:--|--:|\n| nightly | **412** |\n");
    expect([...box.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["Job", "Runs"]);
    const cells = [...box.querySelectorAll<HTMLElement>("tbody td")];
    expect(cells.map((td) => td.textContent)).toEqual(["nightly", "412"]);
    expect(cells[1]!.style.textAlign).toBe("right");
    expect(cells[1]!.querySelector("strong")).not.toBeNull();
  });

  it("shows raw HTML and a script as the text they are", () => {
    const box = render('<script>alert("x")</script>\n\nA <b>bold</b> <img src=x onerror=alert(1)> word.\n');
    expect(box.querySelector("script, b, img")).toBeNull();
    expect(box.querySelector(".md-raw")!.textContent).toBe('<script>alert("x")</script>');
    expect(box.textContent).toContain("A <b>bold</b> <img src=x onerror=alert(1)> word.");
  });

  it("keeps web and mail links, opening in a new tab without the app, and drops any other", () => {
    const box = render("[web](https://example.com/a?b=1) [mail](mailto:owner@example.com) [bad](javascript:alert(1)) [data](data:text/html,x) [here](/media/x)");
    const links = [...box.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com/a?b=1", "mailto:owner@example.com"]);
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(box.textContent).toContain("bad");
    expect(box.textContent).toContain("here");
  });

  it("reads character references in a link's address as a browser does", () => {
    const box = render("[r](https://example.com/?a=1&amp;b=2) [n](https://example.com/?c=3&#38;d=4&#x26;e=5) [k](https://example.com/?f&bogus;g)");
    expect([...box.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "https://example.com/?a=1&b=2",
      "https://example.com/?c=3&d=4&e=5",
      "https://example.com/?f&bogus;g",
    ]);
    expect(decodeRefs("&#0;&#x110000;&lt;&QUOT;")).toBe('&#0;&#x110000;<"');
    // A name an object inherits is no reference.
    expect(decodeRefs("https://example.com/?q=&constructor;&toString;")).toBe("https://example.com/?q=&constructor;&toString;");
    // An autolink's address is literal.
    expect(render("<https://example.com/?a=1&amp;b=2>").querySelector("a")!.getAttribute("href")).toBe("https://example.com/?a=1&amp;b=2");
    expect(render("[x](javascript&#58;alert(1))").querySelector("a")).toBeNull();
  });

  it("shows an image as its alt text and address, loading nothing", () => {
    const box = render("![chart of runs](https://example.com/chart.png)");
    expect(box.querySelector("img")).toBeNull();
    expect(box.querySelector(".md-image")!.textContent).toBe("chart of runs (https://example.com/chart.png)");
  });

  it("never parses HTML from a string", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "web", "src", "views", "text-pages.ts"), "utf8");
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|DOMParser/);
  });
});

describe("safeHref", () => {
  it("allows http, https and mailto only", () => {
    expect(safeHref("https://a.example/")).toBe("https://a.example/");
    expect(safeHref("http://a.example/x")).toBe("http://a.example/x");
    expect(safeHref("mailto:a@b.example")).toBe("mailto:a@b.example");
    expect(safeHref("JavaScript:alert(1)")).toBeNull();
    expect(safeHref("vbscript:x")).toBeNull();
    expect(safeHref("/relative")).toBeNull();
  });
});

describe("plain text and JSON", () => {
  it("lays out JSON that parses and leaves anything else as it is", () => {
    expect(plainText('﻿{"a":1,"b":[true]}', true)).toBe('{\n  "a": 1,\n  "b": [\n    true\n  ]\n}');
    expect(plainText('{"a":', true)).toBe('{"a":');
    expect(plainText('{"a":1}', false)).toBe('{"a":1}');
  });

  it("lays JSON out without changing a number, an escape or an empty value", () => {
    const source = '{"id":9007199254740993, "big":1e400,"f":1.50,"e":"\\u0041\\"{[,:]}","x":[ ],"o":{\n},"n":[-0,{"k":null}]}';
    expect(plainText(source, true)).toBe(
      [
        "{",
        '  "id": 9007199254740993,',
        '  "big": 1e400,',
        '  "f": 1.50,',
        '  "e": "\\u0041\\"{[,:]}",',
        '  "x": [],',
        '  "o": {},',
        '  "n": [',
        "    -0,",
        "    {",
        '      "k": null',
        "    }",
        "  ]",
        "}",
      ].join("\n"),
    );
  });

  it("shows JSON as it is when laying it out would grow it past four times its size", () => {
    const deep = "[".repeat(10_000) + "0" + "]".repeat(10_000);
    const started = cpuMs();
    expect(plainText(deep, true)).toBe(deep);
    expect(cpuMs() - started).toBeLessThan(2_000);
    // Copied tokens count too: a long string deep down is no way past the bound.
    const long = "[".repeat(300) + '"' + "x".repeat(30_000) + '"' + "]".repeat(300);
    expect(plainText(long, true)).toBe(long);
    const wide = "[" + Array.from({ length: 1000 }, (_, i) => `{"k":${i}}`).join(",") + "]";
    expect(plainText(wide, true)).not.toBe(wide);
  });

  it("shows a JSON file laid out in monospace", async () => {
    const content = await textContent(new File(['{"jobs":[{"name":"nightly"}]}'], "summary.json", { type: "application/json" }), false);
    expect(content.el.querySelector("pre.lightbox-plain")!.textContent).toBe('{\n  "jobs": [\n    {\n      "name": "nightly"\n    }\n  ]\n}');
    expect(content.el.querySelector(".lightbox-text-cut")).toBeNull();
  });

  it("shows the first 2 MB of a bigger file and says so", async () => {
    const big = new File(["a".repeat(TEXT_CAP_BYTES + 10)], "run.log", { type: "text/plain" });
    const content = await textContent(big, false);
    expect(content.el.querySelector(".lightbox-text-cut")!.textContent).toBe("Showing the first 2 MB");
    expect(content.el.querySelector("pre")!.textContent).toHaveLength(TEXT_CAP_BYTES);
  });

  it("formats a Markdown file", async () => {
    const content = await textContent(new File(["# Notes\n\n- one"], "notes.md", { type: "text/markdown" }), true, async (source) => lexer(source));
    expect(content.el.querySelector("article.markdown h1")!.textContent).toBe("Notes");
    expect(content.el.querySelector("article.markdown li")!.textContent).toBe("one");
  });

  it("shows Markdown as plain text when lexing runs out of time", async () => {
    const source = "*a ".repeat(5_000);
    const content = await textContent(new File([source], "slow.md", { type: "text/markdown" }), true, async () => null);
    expect(content.el.querySelector("article.markdown")).toBeNull();
    expect(content.el.querySelector(".lightbox-text-cut")!.textContent).toBe("Too large to format: shown as plain text");
    expect(content.el.querySelector("pre")!.textContent).toBe(source);
  });

  it("scales while a pinch moves and lays out again at that size once it stops", async () => {
    const content = await textContent(new File(["words"], "a.txt", { type: "text/plain" }), false);
    const article = content.el.querySelector<HTMLElement>("article")!;
    content.fit({ w: 412, h: 800 });
    expect(article.style.width).toBe("412px");
    content.moved!({ scale: 2, x: 0, y: 0 }, { w: 412, h: 100 }, { w: 412, h: 800 }, false);
    expect(article.style.transform).toBe("scale(2)");
    content.moved!({ scale: 2, x: 0, y: 0 }, { w: 412, h: 100 }, { w: 412, h: 800 }, true);
    expect(article.style.zoom).toBe("2");
    expect(article.style.transform).toBe("");
  });

  it("measures a table wider than the column, so the viewer pans to its last columns", async () => {
    const content = await textContent(new File(["words"], "a.txt", { type: "text/plain" }), false);
    const article = content.el.querySelector<HTMLElement>("article")!;
    Object.defineProperty(article, "scrollWidth", { configurable: true, get: () => 900 });
    expect(content.fit({ w: 320, h: 800 })!.w).toBe(900);
    Object.defineProperty(article, "scrollWidth", { configurable: true, get: () => 300 });
    expect(content.fit({ w: 320, h: 800 })!.w).toBe(320);
  });
});

describe("formattable", () => {
  const row = (n: number, cell: string) => Array(n).fill(cell).join("|");

  it("formats ordinary Markdown, tables included", () => {
    expect(formattable("# Title\r\n\r\n| a | b |\r\n|---|:-:|\r\n| 1 | 2 |\r\n")).toBe(true);
    expect(formattable(`| ${row(30, "h")} |\n| ${row(30, "-")} |\n${`| ${row(30, "x")} |\n`.repeat(2_000)}`)).toBe(true);
  });

  it("formats a fenced regex full of pipes, which is no table", () => {
    expect(formattable("# Notes\n\n~~~regex\n" + Array.from({ length: 200 }, (_, i) => `code${i}`).join("|") + "\n~~~\n")).toBe(true);
  });

  it("refuses wide, long tables however the file is written", () => {
    expect(formattable(`${row(64, "h")}\n${row(64, "-")}\n${"x\n".repeat(200_000)}`)).toBe(false);
    expect(formattable(`> ${row(64, "h")}\n> ${row(64, "-")}\n${"> x\n".repeat(5_000)}`)).toBe(false);
    expect(formattable(`${row(1000, "h")}\r${row(1000, "-")}\r${"x\r".repeat(10_000)}`)).toBe(false);
    expect(formattable(`${row(1000, "h")}\n${row(1000, "-")}\n\u00a0\n${"x\n".repeat(10_000)}`)).toBe(false);
    expect(formattable(`h\n:-\n${"x\n".repeat(250_000)}`)).toBe(false);
    const ladder = (depth: number) => {
      const prefix = ">".repeat(depth);
      let source = `${prefix} h|h|h|h\n${prefix} -|-|-|-\n${prefix} x\n`;
      for (let level = depth - 1; level >= 0; level--) source += `${">".repeat(level)} x\n${prefix} x\n`;
      return source;
    };
    expect(formattable(ladder(20))).toBe(false);
    expect(formattable(ladder(3))).toBe(true);
    const deep = ">".repeat(20) + " ";
    expect(formattable(`${deep}${row(200, "h")}\n${deep}${row(200, "-")}\n${`${deep}x\n`.repeat(100)}x\n${deep}x`)).toBe(false);
  });

  it("tests a delimiter-shaped line in linear time", () => {
    const start = cpuMs();
    formattable(`# Notes\n-|-${" ".repeat(400_000)}x`);
    expect(cpuMs() - start).toBeLessThan(500);
  });

  it("refuses Markdown over the size cap", () => {
    expect(formattable("a".repeat(MD_CAP_BYTES + 1))).toBe(false);
  });
});

describe("tokensWithin", () => {
  it("passes an ordinary document and refuses one whose reference links multiply its text", () => {
    expect(tokensWithin(lexer("# Notes\n\n[site][x] and ![pic][x]\n\n[x]: https://example.com/\n"), MD_MAX_TOKEN_CHARS)).toBe(true);
    const expanding = "![x]\n".repeat(1000) + "\n[x]: https://example.com/" + "a".repeat(50_000);
    expect(expanding.length).toBeLessThan(60_000);
    expect(tokensWithin(lexer(expanding), MD_MAX_TOKEN_CHARS)).toBe(false);
  });
});
