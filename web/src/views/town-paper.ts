import "./town-paper.css";

import { isDesk } from "../desk.js";
import { h } from "../dom.js";
import { mountDesks } from "./desks.js";
import { holdStatusLine, onStatusPaint, releaseStatusLine } from "./status-line.js";

// The Desks tab: the desks view (desks.ts) under OK / Not OK. The cards that need you are the Feed badge's, not a
// button here too.

export interface PaperTown {
  el: HTMLElement;
  paint(): void;
  stop(): void;
}

export interface PaperTownOptions {
  /** The head of a scrolling page with more under it: the desks at their natural height, scrolled by the page. */
  flow?: boolean;
}

export function mountPaperTown(options: PaperTownOptions = {}): PaperTown {
  const el = h("section", { class: `paper${options.flow ? " is-flow" : ""}`, attrs: { "aria-label": "Progress" } });
  const desks = mountDesks();
  let desk = isDesk();
  el.append(h("div", { class: "paper-home" }, h("div", { class: "paper-stage" }, desks.el)));

  const paint = () => {
    desk = isDesk();
    desks.paint();
  };

  // The OK pill reads Ops' snapshot and Plan, kept loading while the tab is open. The line repaints on every board
  // change and Ops read, so the Town follows it alone: a board subscription too painted it twice a poll.

  holdStatusLine();
  const unpaint = onStatusPaint(paint);
  paint();
  const onResize = () => isDesk() !== desk && paint();
  window.addEventListener("resize", onResize);
  return {
    el,
    paint,
    stop() {
      unpaint();
      releaseStatusLine();
      window.removeEventListener("resize", onResize);
      desks.stop();
    },
  };
}
