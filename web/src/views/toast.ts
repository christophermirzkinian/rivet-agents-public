import { button, h } from "../dom.js";

// Undo toasts and a short flash, independent: the Undo toast of the answer
// being held (a newer answer's replaces it), one for each conversation
// archived in the last few seconds, and the flash. A flash never removes an
// Undo button, and clearing one Undo only removes that toast.

let host: HTMLElement | null = null;
/** By key; `group` "answer" holds one at a time. */
const undoToasts = new Map<string, { group: "answer" | "archive"; element: HTMLElement }>();
let flashToast: { element: HTMLElement; timer: number } | null = null;

export function mountToasts(element: HTMLElement | null): void {
  clearToasts();
  host = element;
}

export function clearToasts(): void {
  if (flashToast) window.clearTimeout(flashToast.timer);
  for (const one of undoToasts.values()) one.element.remove();
  flashToast?.element.remove();
  undoToasts.clear();
  flashToast = null;
}

/**
 * The undo toast for one held answer (the answer is held until the bar runs out), or with `group` "archive" for one
 * archived conversation, which leaves an answer's toast and the other archives' alone.
 */
export function showUndo(options: {
  key: string;
  verb: string;
  title: string;
  tone: "yes" | "no" | "note" | "later";
  ms: number;
  onUndo: () => void;
  group?: "answer" | "archive";
}): void {
  const group = options.group ?? "answer";
  for (const [key, one] of undoToasts)
    if (key === options.key || (group === "answer" && one.group === "answer")) {
      one.element.remove();
      undoToasts.delete(key);
    }
  const bar = h("span", { class: "toast-bar" });
  bar.style.animationDuration = `${options.ms}ms`;
  const element = h(
    "div",
    { class: `toast undo ${options.tone}`, attrs: { role: "status", "data-key": options.key } },
    h("div", { class: "toast-text" }, h("strong", {}, options.verb), h("span", { class: "toast-title" }, options.title)),
    button("Undo", options.onUndo, "undo-btn", false, group === "answer" ? "cards.undo" : "toast.undo"),
    bar,
  );
  undoToasts.set(options.key, { group, element });
  host?.prepend(element);
}

export function clearUndo(key: string): void {
  undoToasts.get(key)?.element.remove();
  undoToasts.delete(key);
}

export function flash(text: string, tone: "ok" | "warn" | "error" = "ok", ms = 2600): void {
  // A StaleSession's text: an answer from an earlier session says nothing.
  if (!text) return;
  if (flashToast) {
    window.clearTimeout(flashToast.timer);
    flashToast.element.remove();
  }
  const element = h("div", { class: `toast flash ${tone}`, attrs: { role: tone === "error" ? "alert" : "status" } }, text);
  const timer = window.setTimeout(() => {
    element.remove();
    if (flashToast?.element === element) flashToast = null;
  }, ms);
  flashToast = { element, timer };
  host?.append(element);
}
