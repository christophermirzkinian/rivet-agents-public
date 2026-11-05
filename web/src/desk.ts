/**
 * A wide window gets the desktop layout: a rail on the left, the board as a list with the open card beside it, and
 * chat alongside. Anything narrower keeps the phone layout exactly as it is.
 */
export const DESK_QUERY = "(min-width: 1080px)";

/** True while the shell shows the desktop layout. The shell owns the switch; views only read it. */
export function isDesk(): boolean {
  return document.documentElement.classList.contains("desktop");
}

/** True while the focus is somewhere typing goes, so a single-letter shortcut must not fire. */
export function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "submit"].includes(target.type)) ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/**
 * True when Enter or Space would press the focused control itself, so a card shortcut on those keys must leave it
 * alone: Enter on a focused Cancel cancels. Every control (a tab, a Coming filter or row, the sort, a chat) does its
 * own thing and never answers the open card.
 */
export function pressesControl(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.matches('button, a[href], summary, [role="button"], input[type="button"], input[type="submit"], input[type="checkbox"], input[type="radio"]');
}
