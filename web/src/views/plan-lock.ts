// A hosted agent with no plan connected (cloud-agent.ts needsPlan): the home screen's box that says to connect one, and what
// a locked message box shows. On the owner's own machine none of it is ever drawn.
import { agentName, CONNECT_PATH, connectPlan, LOCKED_LINE, needsPlan, planNames } from "../cloud-agent.js";
import { stopDictation } from "../dictation.js";
import { button, h, svg } from "../dom.js";
import { subscribe } from "../state.js";
import type { PhotosControl } from "./attach.js";

const LOCK =
  '<svg viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="10" rx="2.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M8 10.5V8a4 4 0 018 0v2.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

export const lockMark = (): HTMLElement => svg(LOCK, "noplan-mark");

/** The home screen's box. Connect now is the supervisor's page, a full page load. */
export function planBox(): HTMLElement {
  return h(
    "section",
    { class: "noplan-box", attrs: { "aria-labelledby": "noplan-title" } },
    h("h2", { class: "noplan-title", attrs: { id: "noplan-title" } }, `Connect ${planNames()} to start`),
    h("p", { class: "noplan-words" }, `${agentName()} can't take jobs until one is connected. It takes about a minute.`),
    button("Connect now", connectPlan, "primary big", false, "cloud.connect-band"),
  );
}

/** Under a locked message box: the line is the way to Connect. `mark` where the box itself carries no lock. */
export function lockedLine(mark = false): HTMLElement {
  const words = document.createTextNode(LOCKED_LINE);
  const line = h("a", { class: "noplan-line", attrs: { href: CONNECT_PATH, "data-use": "cloud.connect-band" } }, mark ? lockMark() : null, words);
  lineWords.set(line, words);
  keepWords(new WeakRef(line));
  return line;
}

/** Each line's words, for as long as the line lives. Being a key here also marks the line as in use, so a browser never
 *  swaps the object behind a line that is still on the page for a new one, which would empty the weak hold below. */
const lineWords = new WeakMap<HTMLElement, Text>();

/**
 * The words name the plans of the last plans read, which may come after the line is built: each redraw sets them. A
 * sheet takes its line off the page and puts it back, so being off the page ends nothing; the listener goes once
 * nothing holds the line any more, and it holds the line only weakly so that it never keeps a dropped line alive.
 */
function keepWords(ref: WeakRef<HTMLElement>): void {
  const stop = subscribe(() => {
    const line = ref.deref();
    const words = line && lineWords.get(line);
    if (!words) return stop();
    if (words.data !== LOCKED_LINE) words.data = LOCKED_LINE;
  });
}

/**
 * A card's message box (feed.ts): while needsPlan(), its field, mic, photos and Send are off and the returned line shows
 * under it; a read that finds a plan turns them back on. Once the box has left the page it stops listening.
 */
export function planLocks(field: HTMLTextAreaElement, attach: PhotosControl | null, ...sends: (HTMLButtonElement | null)[]): HTMLElement {
  const line = lockedLine(true);
  const mic = field.parentElement?.querySelector<HTMLButtonElement>(".dictate-mic") ?? null;
  const parts = [field, mic, ...sends].filter((part) => part !== null);
  let was: boolean[] = [];
  let locked = false;
  let shown = false;
  const paint = () => {
    if (field.isConnected) shown = true;
    else if (shown) return stop();
    const on = needsPlan();
    line.hidden = !on;
    if (on === locked) return;
    locked = on;
    if (on) {
      stopDictation();
      was = parts.map((part) => part.disabled);
    }
    parts.forEach((part, index) => {
      part.disabled = on || was[index]!;
      part.classList.toggle("plan-locked", on);
    });
    attach?.lock(on);
  };
  const stop = subscribe(paint);
  paint();
  return line;
}
