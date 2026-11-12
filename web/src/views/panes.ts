import { clampWidth, readLayout, WIDE_RAIL_QUERY, writeLayout, type DeskLayout, type Pane } from "../desk-layout.js";
import { h, svg } from "../dom.js";
import { changed } from "../state.js";
import { needYou } from "../../../src/shared/words.js";

// The desktop layout's pane controls: the chevron on each pane's edge that folds it away (on the
// pane itself, not the top bar), the slim strip a collapsed pane leaves behind, and the grip that drags a pane's
// width. The layout itself lives in desk-layout.ts.

export const PANE_ICONS = {
  rail: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M9 4.5v15" stroke="currentColor" stroke-width="2.2"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M14.5 4.5v15" stroke="currentColor" stroke-width="2.2"/></svg>',
  focus: '<svg viewBox="0 0 24 24"><path d="M4 9V5.5A1.5 1.5 0 015.5 4H9M15 4h3.5A1.5 1.5 0 0120 5.5V9M20 15v3.5a1.5 1.5 0 01-1.5 1.5H15M9 20H5.5A1.5 1.5 0 014 18.5V15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><rect x="8.5" y="8.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
} as const;

export function wideRail(): boolean {
  return window.matchMedia?.(WIDE_RAIL_QUERY).matches ?? false;
}

export function updateLayout(change: (layout: DeskLayout) => DeskLayout): void {
  writeLayout(change(readLayout()));
  changed();
}

const WIDTH_VAR = "--chat-w";
/** The narrowest the middle column may get when chat is dragged wider. */
export const MIN_CARD = 560;
/** Roughly the CSS default, for the first arrow-key nudge before the pane has been measured. */
const WIDTH_DEFAULT = 400;

/** Puts chat's dragged width on the page, or takes it off when it uses its default. */
export function applyWidths(layout: DeskLayout | null): void {
  const px = layout?.chatW ?? null;
  if (px === null) document.documentElement.style.removeProperty(WIDTH_VAR);
  else document.documentElement.style.setProperty(WIDTH_VAR, `${px}px`);
}

const CHEVRON = '<svg viewBox="0 0 24 24"><path d="M14.5 6.5L9 12l5.5 5.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * The chevron on a pane's inner edge, near its top: it points the way the pane folds, and on the rail (which has no
 * strip) the way it opens again.
 */
export function paneFold(opts: { pane: Pane; label: string; open: boolean; shortcut: string; onToggle: () => void }): HTMLElement {
  const verb = opts.open ? "Hide" : "Show";
  const name = opts.label.toLowerCase();
  return h(
    "button",
    {
      class: `pane-fold fold-${opts.pane}${opts.open ? " open" : ""}`,
      attrs: { type: "button", "data-use": opts.pane === "rail" ? "shell.rail.fold" : "pane.fold", title: `${verb} ${name} (${opts.shortcut})`, "aria-label": `${verb} ${name}`, "aria-expanded": String(opts.open) },
      on: { click: opts.onToggle },
    },
    svg(CHEVRON, "pane-fold-icon"),
  );
}

/** What a collapsed pane leaves behind: a slim strip with its icon and a count, which opens it again. */
export function paneStrip(opts: { pane: "chat"; label: string; icon: string; badge?: number; dot?: boolean; shortcut: string; onOpen: () => void }): HTMLElement {
  const count = opts.badge ?? 0;
  return h(
    "button",
    {
      class: `pane-strip strip-${opts.pane}`,
      attrs: {
        type: "button",
        "data-pane": opts.pane,
        "data-use": "pane.strip",
        title: `Show ${opts.label.toLowerCase()} (${opts.shortcut})`,
        "aria-label": `Show ${opts.label.toLowerCase()}`,
        "aria-expanded": "false",
      },
      on: { click: opts.onOpen },
    },
    svg(opts.icon, "pane-strip-icon"),
    count ? h("span", { class: "badge", attrs: { "aria-label": needYou(count) } }, String(count)) : null,
    opts.dot ? h("span", { class: "pane-strip-dot", attrs: { "aria-label": "New message" } }) : null,
    h("span", { class: "pane-strip-label" }, opts.label),
  );
}

/**
 * The drag handle on a pane's inner edge. `measure` turns a pointer's x into the pane's width. Arrow keys nudge it,
 * a double-click or Home puts the default back, and the width is kept once the drag ends.
 */
export function paneGrip(pane: "chat", label: string, measure: (clientX: number) => number, room: () => number): HTMLElement {
  const key = "chatW";
  const grows = "ArrowLeft";
  const shrinks = "ArrowRight";
  // A pane cannot be dragged over the middle column's MIN_CARD px. When a narrow window already leaves it less, the pane
  // may still shrink but no longer grow: the middle column's room wins over the pane's own minimum.
  const fit = (px: number) => clampWidth(pane, Math.min(px, Math.max(room(), Math.min(px, now()))));
  const keep = (px: number | null) => updateLayout((layout) => ({ ...layout, [key]: px === null ? null : fit(px) }));
  const grip = h("div", {
    class: `pane-grip grip-${pane}`,
    attrs: { role: "separator", "aria-orientation": "vertical", "aria-label": `Resize ${label}`, tabindex: "0", title: "Drag to resize · double-click to reset" },
  });
  const now = () => {
    const box = grip.parentElement?.getBoundingClientRect();
    return readLayout()[key] ?? Math.round(box?.width ?? WIDTH_DEFAULT);
  };
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    let px: number | null = null;
    grip.setPointerCapture?.(event.pointerId);
    document.documentElement.classList.add("pane-resizing");
    const move = (next: PointerEvent) => {
      px = fit(measure(next.clientX));
      document.documentElement.style.setProperty(WIDTH_VAR, `${px}px`);
    };
    // On the window, not the grip: a board refresh mid-drag replaces the grip, and the drag must still end.
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      document.documentElement.classList.remove("pane-resizing");
      if (px === null) return;
      keep(px);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  });
  // A re-render may replace the grip; keep the keyboard on it.
  const refocus = () => document.querySelector<HTMLElement>(`.grip-${pane}`)?.focus();
  grip.addEventListener("dblclick", () => keep(null));
  grip.addEventListener("keydown", (event) => {
    if (event.key === grows || event.key === shrinks) {
      event.preventDefault();
      event.stopPropagation();
      keep(now() + (event.key === grows ? 24 : -24));
      refocus();
    } else if (event.key === "Home") {
      event.preventDefault();
      keep(null);
      refocus();
    }
  });
  return grip;
}
