import { h } from "../dom.js";
import { MAC_WAITS, macOffline } from "../state.js";

/**
 * A button that sends through the Mac: while the Mac is offline it says the answer waits for it, kept and sent when the Mac
 * is back. `aria` is its spoken name, which says the same.
 */
export function sending<T extends HTMLElement>(element: T, aria?: string): T {
  element.classList.add("sends");
  if (aria !== undefined) element.dataset.aria = aria;
  paintWait(element);
  return element;
}

/** Says or drops the wait on a sending button; a held render (an open sheet, a typed note) repaints only this. */
export function paintWait(element: HTMLElement): void {
  const offline = macOffline();
  const said = [...element.children].find((child) => child.classList.contains("waits"));
  if (offline && !said) element.append(h("span", { class: "waits" }, MAC_WAITS));
  if (!offline) said?.remove();
  const aria = element.dataset.aria;
  if (aria !== undefined) element.setAttribute("aria-label", offline ? `${aria} ${MAC_WAITS}` : aria);
}
