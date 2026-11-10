import "./ops.css";

import type { Briefing } from "../../../src/shared/ops.js";
import { getBriefing } from "../api.js";
import { h } from "../dom.js";
import { composedLabel, sinceLabel } from "./briefing.js";
import { openSheet } from "./sheet.js";
import { RIVET_NAME } from "../../../src/shared/names.js";

/** Search opens the stored snapshot, including items hidden or dismissed since. */
export function openBriefingHistory(id: string): void {
  let mounted = false;
  openSheet("Past briefing", {
    mount(el) {
      mounted = true;
      el.replaceChildren(h("p", { attrs: { role: "status" } }, "Loading briefing…"));
      void getBriefing(id).then(
        ({ briefing }) => {
          if (!mounted) return;
          if (!briefing) {
            el.replaceChildren(h("p", { attrs: { role: "status" } }, "This briefing is no longer available."));
            return;
          }
          el.replaceChildren(snapshot(briefing));
        },
        () => {
          if (!mounted) return;
          el.replaceChildren(h("p", { attrs: { role: "alert" } }, "Couldn't load this briefing."));
        },
      );
    },
    unmount() {
      mounted = false;
    },
  }, "Close", undefined, { use: "briefing.past" });
}

function snapshot(briefing: Briefing): HTMLElement {
  return h(
    "article",
    { class: "brief" },
    h("h3", { class: "brief-title" }, `${briefing.slot === "morning" ? "Morning" : "Evening"} briefing · ${briefing.day}`),
    h("p", { class: "brief-since" }, `${composedLabel(briefing)} · ${sinceLabel(briefing).replace(/^S/, "s")}`),
    h("p", { class: "brief-headline" }, briefing.headline),
    h("ul", { class: "brief-items" }, ...briefing.items.map((item) =>
      h("li", { class: `brief-item box s-${item.tone}` },
        h("span", { class: "brief-item-title" }, item.title),
        ...item.lines.map((line) => h("span", { class: "brief-line" }, line)),
      ),
    )),
    briefing.notes.length ? h("ul", { class: "brief-notes" }, ...briefing.notes.map((note) =>
      h("li", { class: "brief-note" }, h("strong", {}, `${RIVET_NAME}: `), note.text),
    )) : null,
  );
}
