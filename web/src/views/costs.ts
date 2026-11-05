import "./costs.css";

import { h } from "../dom.js";

// The cards Usage shows: the name and figure on one line, a pill, and one plain line. Kind is never a stripe down the
// side: an estimate's pill is dashed and its figure quieter and marked ≈.

export type PillTone = "yes" | "warn" | "bad" | "quiet";

export interface CardSpec {
  name: string;
  /** The row's figure: "A$838". */
  figure: string;
  /** An estimate: "≈ " before the figure, and the figure quieter. */
  approx?: boolean;
  /** Words in place of a figure ("Not priced"): smaller and quiet. */
  quiet?: boolean;
  pill: { text: string; tone: PillTone; dashed?: boolean };
  /** Beside the pill: "Checked 9 Oct". */
  meta?: string;
  /** One plain line under it. */
  line?: string;
  /** A meter under the name (Usage's account cards): filled to the share used, null while not read. */
  bar?: { percent: number | null; tone: PillTone; label: string };
}

/** The meter: an unread one is hatched, never an empty 0%. */
function costBar(bar: NonNullable<CardSpec["bar"]>): HTMLElement {
  const fill = h("span", { class: "cost-bar-fill" });
  if (bar.percent !== null) fill.style.width = `${Math.min(100, Math.max(0, bar.percent))}%`;
  return h("span", { class: `cost-bar ${bar.percent === null ? "unread" : bar.tone}`, attrs: { role: "img", "aria-label": bar.label } }, fill);
}

/** One row's card, for a `<ul class="costs-list">`. */
export function costCard(spec: CardSpec): HTMLLIElement {
  return h(
    "li",
    { class: "cost-card" },
    h("div", { class: "cost-head" }, h("span", { class: "cost-name" }, spec.name), h("span", { class: `cost-figure${spec.approx ? " approx" : ""}${spec.quiet ? " quiet" : ""}` }, spec.approx ? `≈ ${spec.figure}` : spec.figure)),
    spec.bar ? costBar(spec.bar) : null,
    h(
      "p",
      { class: "cost-meta" },
      h("span", { class: `cost-pill ${spec.pill.tone}${spec.pill.dashed ? " dashed" : ""}` }, spec.pill.text),
      spec.meta ? h("span", { class: "cost-when" }, spec.meta) : null,
    ),
    spec.line ? h("p", { class: "cost-line" }, spec.line) : null,
  );
}
