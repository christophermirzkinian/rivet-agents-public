import "./reading.css";

import { clock } from "../../../src/shared/when.js";
import { h, type Child } from "../dom.js";
import { rivet } from "../rivet/rivet.js";

// The reading pages' one frame: a shimmer at about the page's height while the first read is out, Rivet and Try again
// when it fails with nothing to show, the last figures under one plain line when a refresh fails, and "Updated 2:02pm"
// with Refresh at the foot. A server's own error words never show here.

export interface ReadingInput {
  /** Something read that can be shown. */
  has: boolean;
  /** The last read failed. */
  failed: boolean;
  /** A read asked for here is out. */
  busy: boolean;
}

export interface ReadingView {
  body: "pending" | "failed" | "figures";
  /** The figures are the last ones read: a refresh failed. */
  stale: boolean;
  /** The figures dim while a read is out. */
  dim: boolean;
}

export function readingView({ has, failed, busy }: ReadingInput): ReadingView {
  if (!has) return { body: failed && !busy ? "failed" : "pending", stale: false, dim: false };
  return { body: "figures", stale: failed, dim: busy };
}

export const STALE_WORDS = "Couldn't refresh. These are the last numbers read.";
export const failedWords = (page: string): string => `Couldn't load ${page}.`;
export const updatedWords = (at: number | null): string => (at ? `Updated ${clock(at)}` : "");

export interface Reading extends ReadingInput {
  /** The page's title, as its menu row says it. */
  page: string;
  /** When the figures shown were read; null before any read. */
  at: number | null;
  /** The placeholder's blocks in px, about the height the page lands at. */
  shape: readonly number[];
  retry: () => void;
  /** False on a page whose own Refresh already sits top right: the row keeps only its time. */
  button?: boolean;
}

function frameButton(words: string, busy: boolean, retry: () => void, primary: boolean): HTMLElement {
  return h(
    "button",
    {
      class: `btn ${primary ? "primary" : "ghost"} reading-btn`,
      attrs: { type: "button", "data-use": "ops.refresh", "aria-busy": String(busy), ...(busy ? { disabled: "" } : {}) },
      on: { click: retry },
    },
    busy ? "Refreshing…" : words,
  );
}

/** "Updated 2:02pm" with Refresh at the right, the page's top row. */
function readingHead(reading: Reading): HTMLElement {
  return h("div", { class: "reading-foot" }, h("span", { class: "reading-at" }, updatedWords(reading.at)), reading.button === false ? null : frameButton("Refresh", reading.busy, reading.retry, false));
}

/** "Updated 2:02pm" with Refresh, then the stale line when a refresh failed, as the frame orders them: for a page that lays out its own figures. */
export function readingNotes(reading: Reading): HTMLElement[] {
  const head = readingHead(reading);
  return readingView(reading).stale ? [head, h("p", { class: "reading-stale", attrs: { role: "status" } }, STALE_WORDS)] : [head];
}

/**
 * The page in its frame; `figures` is only built once there is something to show. `lead` (a page's own switch) sits
 * under the top row, undimmed; the caller shows it above the frame while there are no figures yet.
 */
export function readingFrame(reading: Reading, figures: () => Child[], lead: Child = null): HTMLElement {
  const view = readingView(reading);
  if (view.body === "pending")
    return h(
      "div",
      { class: "reading is-pending", attrs: { role: "status", "aria-label": `Reading ${reading.page}…`, "aria-busy": "true" } },
      ...reading.shape.map((px) => {
        const block = h("div", { class: "reading-skel" });
        block.style.height = `${px}px`;
        return block;
      }),
    );
  if (view.body === "failed")
    return h(
      "div",
      { class: "reading is-failed" },
      h("div", { class: "reading-failed", attrs: { role: "status" } }, rivet("wrong", { size: 56, className: "reading-face" }), h("p", { class: "reading-failed-words" }, failedWords(reading.page)), frameButton("Try again", false, reading.retry, true)),
    );
  return h(
    "div",
    { class: `reading${view.dim ? " is-busy" : ""}`, attrs: { "aria-busy": String(view.dim) } },
    readingHead(reading),
    view.stale ? h("p", { class: "reading-stale", attrs: { role: "status" } }, STALE_WORDS) : null,
    lead,
    h("div", { class: "reading-figures" }, ...figures()),
  );
}

/** A lead figure: the number big in its tone, then its words ("of 5 left"). */
export function leadFigure(figure: string, words: string, tone: string): HTMLElement {
  return h("p", { class: `reading-lead t-${tone}` }, h("b", { class: "reading-lead-n" }, figure), h("span", { class: "reading-lead-words" }, words));
}

/** A meter filled to `share` (0…1) in its tone; `label` says it for a screen reader. */
export function readingMeter(share: number, tone: string, label: string): HTMLElement {
  const bar = h("span", { class: `reading-meter t-${tone}`, attrs: { role: "img", "aria-label": label } }, h("span", { class: "reading-meter-fill" }));
  bar.style.setProperty("--fill", `${(Math.min(1, Math.max(0, share)) * 100).toFixed(1)}%`);
  return bar;
}
