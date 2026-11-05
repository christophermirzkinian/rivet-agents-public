// Loaded only when a text file is opened, so the Markdown lexer stays out of the app's own bundle. Markdown is lexed,
// never rendered as HTML: every element is made here and every string goes in as text, so nothing in a file can run,
// load from elsewhere, or style the app. Raw HTML in it shows as the text it is.
import { lexer, type Token, type Tokens } from "marked";

import MarkdownWorker from "./markdown.worker.ts?worker";

import type { LightboxContent } from "./lightbox.js";

/** What is shown of a text file; the whole file is still there to share. */
export const TEXT_CAP_BYTES = 2 * 1024 * 1024;
const MAX_WIDTH = 760;
const MAX_SCALE = 4;
const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

const text = (parent: Node, value: string) => parent.appendChild(document.createTextNode(value));

const NAMED_REFS: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Character references in a link's address read as a browser reads them in HTML (`&amp;` is `&`), without the DOM. */
export function decodeRefs(value: string): string {
  return value.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (ref, body: string) => {
    if (body[0] !== "#") return Object.hasOwn(NAMED_REFS, body.toLowerCase()) ? NAMED_REFS[body.toLowerCase()]! : ref;
    const point = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ref;
  });
}

/** A link's address when it is a web or mail one, else null. */
export function safeHref(href: string): string | null {
  try {
    const url = new URL(href);
    return LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function inline(tokens: Token[] | undefined, parent: Node): void {
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "text":
        if ("tokens" in token && token.tokens?.length) inline(token.tokens, parent);
        else text(parent, (token as Tokens.Text).text);
        break;
      case "escape":
        text(parent, (token as Tokens.Escape).text);
        break;
      case "strong":
      case "em":
      case "del": {
        const el = parent.appendChild(element(token.type === "strong" ? "strong" : token.type === "em" ? "em" : "del"));
        inline((token as Tokens.Strong).tokens, el);
        break;
      }
      case "codespan":
        parent.appendChild(element("code")).textContent = (token as Tokens.Codespan).text;
        break;
      case "br":
        parent.appendChild(element("br"));
        break;
      case "link": {
        const link = token as Tokens.Link;
        // An autolink's address is literal; a written link's may carry character references.
        const href = safeHref(link.autolink ? link.href : decodeRefs(link.href));
        if (!href) {
          inline(link.tokens, parent);
          break;
        }
        const a = parent.appendChild(element("a"));
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.dataset.use = "link.text";
        if (link.title) a.title = link.title;
        inline(link.tokens, a);
        break;
      }
      case "image": {
        const image = token as Tokens.Image;
        parent.appendChild(element("span", "md-image")).textContent = `${image.text || "Image"} (${image.href})`;
        break;
      }
      case "checkbox":
        parent.appendChild(checkbox((token as Tokens.Checkbox).checked));
        break;
      default:
        text(parent, token.raw);
    }
  }
}

function checkbox(checked: boolean): HTMLInputElement {
  const box = element("input", "md-task");
  box.type = "checkbox";
  box.checked = checked;
  box.disabled = true;
  return box;
}

function blocks(tokens: Token[], parent: Node): void {
  for (const token of tokens) {
    switch (token.type) {
      case "space":
      case "def":
        break;
      case "heading": {
        const depth = Math.min(6, Math.max(1, (token as Tokens.Heading).depth));
        inline((token as Tokens.Heading).tokens, parent.appendChild(element(`h${depth}` as "h1")));
        break;
      }
      case "paragraph":
        inline((token as Tokens.Paragraph).tokens, parent.appendChild(element("p")));
        break;
      case "text":
        // A tight list item's words.
        if ("tokens" in token && token.tokens?.length) inline(token.tokens, parent);
        else text(parent, (token as Tokens.Text).text);
        break;
      case "blockquote":
        blocks((token as Tokens.Blockquote).tokens, parent.appendChild(element("blockquote")));
        break;
      case "code":
        parent.appendChild(element("pre")).appendChild(element("code")).textContent = (token as Tokens.Code).text;
        break;
      case "hr":
        parent.appendChild(element("hr"));
        break;
      case "list": {
        const list = token as Tokens.List;
        const el = parent.appendChild(element(list.ordered ? "ol" : "ul"));
        if (list.ordered && typeof list.start === "number" && list.start !== 1) el.setAttribute("start", String(list.start));
        for (const item of list.items) {
          const li = el.appendChild(element("li", item.task ? "md-task-item" : undefined));
          if (item.task && !item.tokens.some((t) => t.type === "checkbox")) li.appendChild(checkbox(Boolean(item.checked)));
          blocks(item.tokens, li);
        }
        break;
      }
      case "checkbox":
        parent.appendChild(checkbox((token as Tokens.Checkbox).checked));
        break;
      case "table": {
        const table = token as Tokens.Table;
        const el = parent.appendChild(element("table"));
        const row = (cells: Tokens.TableCell[], into: HTMLElement, tag: "th" | "td") => {
          const tr = into.appendChild(element("tr"));
          for (const cell of cells) {
            const td = tr.appendChild(element(tag));
            if (cell.align) td.style.textAlign = cell.align;
            inline(cell.tokens, td);
          }
        };
        row(table.header, el.appendChild(element("thead")), "th");
        const body = el.appendChild(element("tbody"));
        for (const cells of table.rows) row(cells, body, "td");
        break;
      }
      default:
        // Raw HTML among them: shown as the text it is.
        parent.appendChild(element("p", "md-raw")).textContent = token.raw.replace(/\n+$/, "");
    }
  }
}

/** Past these, Markdown is shown as plain text: marked pads every table row to its header's width while it lexes, on
 * the main thread, so a small file whose table is wide and long could freeze the app before anything shows. */
export const MD_CAP_BYTES = 512 * 1024;
export const MD_MAX_CELLS = 200_000;
export const MD_MAX_QUOTE_DEPTH = 4;

/** A line that could be a table's delimiter row (`---|:--:|---`), quote markers and any whitespace allowed. One
 * character class, so the test is linear however the line is built. */
const DELIMITER_SHAPED = /^[\s>|:-]*$/;
const QUOTE_PREFIX = /^[\s>]*/;

/**
 * Whether Markdown is small enough to lex and lay out. Rather than follow marked's table grammar, which a crafted file
 * can sidestep, this bounds what it could build: no table is wider than the widest delimiter-shaped line, none has
 * more rows than the file has lines (split on every line ending marked accepts), and quotes nest no deeper than four.
 */
export function formattable(source: string): boolean {
  if (source.length > MD_CAP_BYTES) return false;
  const lines = source.split(/\r\n|\r|\n/);
  let columns = 1;
  let depth = 0;
  for (const line of lines) {
    if (line.includes("-") && DELIMITER_SHAPED.test(line)) columns = Math.max(columns, line.split("|").length);
    depth = Math.max(depth, QUOTE_PREFIX.exec(line)![0].split(">").length - 1);
  }
  // marked can lex a nested quote's insides again for each shallower line that continues it, which doubles the work
  // per level (measured: 2^(depth-1) passes over a table), so deep nesting is refused and the rest weighted.
  return depth <= MD_MAX_QUOTE_DEPTH && columns * lines.length * 2 ** depth <= MD_MAX_CELLS;
}

/** How long a Markdown file may take to lex before it is shown as plain text instead. */
export const LEX_BUDGET_MS = 3000;

/** Markdown's tokens, lexed in a worker that is stopped past the budget; null when it ran out or failed. */
export function lexMarkdown(source: string): Promise<Token[] | null> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new MarkdownWorker();
    } catch {
      resolve(null);
      return;
    }
    const done = (tokens: Token[] | null) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(tokens);
    };
    const timer = setTimeout(() => done(null), LEX_BUDGET_MS);
    worker.onmessage = (event: MessageEvent<Token[] | null>) => done(event.data);
    worker.onerror = () => done(null);
    worker.postMessage(source);
  });
}

/** Markdown as elements, from its tokens. */
export function markdownDom(source: string | Token[]): DocumentFragment {
  const out = document.createDocumentFragment();
  blocks(typeof source === "string" ? lexer(source) : source, out);
  return out;
}

const isSpace = (c: string | undefined) => c === " " || c === "\n" || c === "\r" || c === "\t";

/**
 * Valid JSON laid out two spaces deep with every token copied as written: parsing and re-serialising would round
 * 9007199254740993, turn 1e400 into null and rewrite escapes. Null when the layout would grow past four times
 * the file (deep nesting indents quadratically), which is then shown as it is.
 */
function indentJson(source: string): string | null {
  const out: string[] = [];
  let depth = 0;
  let room = source.length * 4 + 65_536;
  const put = (...parts: string[]) => {
    for (const part of parts) {
      out.push(part);
      room -= part.length;
    }
  };
  const line = () => "\n" + "  ".repeat(depth);
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
      put(source.slice(i, j + 1));
      i = j;
    } else if (c === "{" || c === "[") {
      let j = i + 1;
      while (isSpace(source[j])) j++;
      if (source[j] === (c === "{" ? "}" : "]")) {
        put(c, source[j]!);
        i = j;
      } else {
        depth++;
        put(c, line());
      }
    } else if (c === "}" || c === "]") {
      depth--;
      put(line(), c);
    } else if (c === ",") put(",", line());
    else if (c === ":") put(": ");
    else if (!isSpace(c)) put(c);
    if (room < 0) return null;
  }
  return out.join("");
}

/** A text file's words as shown: JSON laid out when it parses, anything else as it is. */
export function plainText(source: string, json: boolean): string {
  if (json) {
    try {
      const text = source.replace(/^﻿/, "");
      JSON.parse(text);
      return indentJson(text) ?? source;
    } catch {
      // Not JSON after all, or cut short at the cap: shown as it is.
    }
  }
  return source;
}

/**
 * A text file in the viewer, the width of a phone or a reading column. While a pinch moves it is scaled as a picture;
 * once it stops it is laid out again at that size, so the words are sharp and wrap the same.
 */
export async function textContent(
  file: File,
  markdown: boolean,
  lex: (source: string) => Promise<Token[] | null> = lexMarkdown,
): Promise<LightboxContent> {
  const cut = file.size > TEXT_CAP_BYTES;
  const source = new TextDecoder().decode(await file.slice(0, TEXT_CAP_BYTES).arrayBuffer());
  const tokens = markdown && formattable(source) ? await lex(source) : null;
  const article = element("article", `lightbox-text ${tokens ? "markdown" : "plain"}`);
  if (cut) article.appendChild(element("p", "lightbox-text-cut")).textContent = "Showing the first 2 MB";
  if (markdown && !tokens) article.appendChild(element("p", "lightbox-text-cut")).textContent = "Too large to format: shown as plain text";
  if (tokens) article.appendChild(markdownDom(tokens));
  else article.appendChild(element("pre", "lightbox-plain")).textContent = plainText(source, file.type === "application/json");
  const el = element("div", "lightbox-doc");
  el.appendChild(article);
  let laidOut = 1;
  return {
    el,
    fit(stage) {
      const width = Math.min(stage.w, MAX_WIDTH);
      laidOut = 1;
      article.style.zoom = "1";
      article.style.transform = "";
      article.style.width = `${width}px`;
      // A table wider than the column overflows it; the viewer pans over all of it.
      return { w: Math.max(width, article.scrollWidth), h: Math.max(1, article.offsetHeight) };
    },
    maxScale: () => MAX_SCALE,
    moved(view, _fit, _stage, settled) {
      if (settled) {
        laidOut = view.scale;
        article.style.zoom = String(view.scale);
        article.style.transform = "";
      } else {
        article.style.transform = view.scale === laidOut ? "" : `scale(${view.scale / laidOut})`;
      }
    },
    destroy: () => el.remove(),
  };
}
