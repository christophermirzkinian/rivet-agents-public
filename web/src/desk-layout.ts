/**
 * How the owner has arranged the desktop layout: which side panes are open, how wide they are, and whether Focus mode
 * (the open card alone) is on. It is kept per device and survives a reload. The phone layout never reads it.
 */

export type Pane = "rail" | "chat";

export interface DeskLayout {
  /** "auto" shows the menu's names on every computer window; "icons" folds it. */
  rail: "auto" | "full" | "icons";
  chat: boolean;
  /** The open card alone: every side pane is collapsed until Focus is turned off. */
  focus: boolean;
  /** Chat's dragged width in px; null keeps the default. */
  chatW: number | null;
}

export const WIDE_RAIL_QUERY = "(min-width: 1080px)";
export const WIDTHS = { chat: { min: 300, max: 640 } } as const;
export const DEFAULT_LAYOUT: DeskLayout = { rail: "auto", chat: true, focus: false, chatW: null };

const KEY = "rivet.desk.layout";
/** Before the layout was kept as a whole, only chat's open state was. */
const OLD_CHAT_KEY = "rivet.desk.chat";

export function clampWidth(pane: "chat", px: number): number {
  const { min, max } = WIDTHS[pane];
  return Math.round(Math.min(max, Math.max(min, px)));
}

/** A stored layout, with anything missing or malformed replaced by its default. */
export function parseLayout(raw: string | null, oldChat: string | null = null): DeskLayout {
  let saved: Partial<Record<keyof DeskLayout, unknown>> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") saved = parsed;
  } catch {
    // A damaged entry: start from the defaults.
  }
  const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  const width = (pane: "chat", value: unknown) => (typeof value === "number" && Number.isFinite(value) ? clampWidth(pane, value) : null);
  return {
    rail: saved.rail === "full" || saved.rail === "icons" ? saved.rail : "auto",
    chat: flag(saved.chat, oldChat !== "closed"),
    focus: flag(saved.focus, false),
    chatW: width("chat", saved.chatW),
  };
}

/** Whether a pane shows open right now. Focus collapses every one of them. */
export function paneOpen(layout: DeskLayout, pane: Pane, wideRail: boolean): boolean {
  if (layout.focus) return false;
  if (pane === "rail") return layout.rail === "auto" ? wideRail : layout.rail === "full";
  return layout[pane];
}

/**
 * Opens or collapses one pane. In Focus mode every pane shows collapsed, so toggling one leaves Focus with the others
 * still collapsed and that one open: what the owner sees changes by exactly that pane.
 */
export function togglePane(layout: DeskLayout, pane: Pane, wideRail: boolean): DeskLayout {
  const base = layout.focus ? { ...layout, focus: false, rail: "icons" as const, chat: false } : layout;
  const open = !paneOpen(base, pane, wideRail);
  if (pane === "rail") return { ...base, rail: open ? "full" : "icons" };
  return { ...base, [pane]: open };
}

/** Focus mode on or off; off brings back the panes as they were. */
export function toggleFocus(layout: DeskLayout): DeskLayout {
  return { ...layout, focus: !layout.focus };
}

let current: DeskLayout | null = null;

export function readLayout(): DeskLayout {
  if (current) return current;
  try {
    current = parseLayout(localStorage.getItem(KEY), localStorage.getItem(OLD_CHAT_KEY));
  } catch {
    current = { ...DEFAULT_LAYOUT };
  }
  return current;
}

export function writeLayout(next: DeskLayout): void {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private mode: the layout lasts until the page closes.
  }
}

/** Forgets the cached layout, so the next read comes from storage (tests, sign-out). */
export function forgetLayout(): void {
  current = null;
}
