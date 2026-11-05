import { rivetWords } from "../../src/shared/names.js";

/** Attributes a person reads or hears: a tooltip, a screen reader's label, an empty box's hint. */
const READ_ATTRS = ["aria-label", "title", "placeholder", "alt"];
/** Not words to read: scripts, styles, typed text, and code as written (a command, a path). */
const NOT_TEXT = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE"]);

function fixText(node: Text): void {
  if (node.parentElement?.closest([...NOT_TEXT].join(","))) return;
  const next = rivetWords(node.data);
  if (next !== node.data) node.data = next;
}

function fixAttrs(element: Element): void {
  for (const name of READ_ATTRS) {
    const value = element.getAttribute(name);
    if (value === null) continue;
    const next = rivetWords(value);
    if (next !== value) element.setAttribute(name, next);
  }
}

function fix(node: Node): void {
  if (node.nodeType === Node.TEXT_NODE) return fixText(node as Text);
  if (!(node instanceof Element)) return;
  fixAttrs(node);
  for (const element of node.querySelectorAll(READ_ATTRS.map((name) => `[${name}]`).join(","))) fixAttrs(element);
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) fixText(text as Text);
}

/**
 * Every word on the page as the owner reads it: PR titles, cards, notes and chat text that agents wrote with the old
 * name show "Rivet" (rivetWords). It rewrites the page only, never the data; typed text in a box is left alone.
 */
export function showRivetWords(root: Element = document.documentElement): () => void {
  fix(root);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "childList") record.addedNodes.forEach(fix);
      else if (record.type === "characterData") fixText(record.target as Text);
      else fixAttrs(record.target as Element);
    }
  });
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: READ_ATTRS });
  return () => observer.disconnect();
}
