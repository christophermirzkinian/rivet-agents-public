import { h } from "./dom.js";

// Pull to refresh for a tab's scroll container. Touch events, not pointer
// events: iOS only lets a page stop its own scroll and bounce from a
// cancelable touchmove, and only from the first one of a gesture.

/** How far the content has to be pulled, after resistance, to refresh on release. */
export const PULL_THRESHOLD = 70;
const PULL_MAX = 200;
/** The spinner stays up at least this long, so a fast refresh still reads as one. */
const MIN_SPIN_MS = 450;

/** Rubber band: the content follows the finger less the further it goes. */
export function resist(dy: number): number {
  return dy <= 0 ? 0 : (PULL_MAX * dy) / (dy + PULL_MAX);
}

/** Areas that own their own vertical gesture. */
const NOT_HERE = "textarea, input, select, [contenteditable], canvas, .y3d-stage, .sheet-backdrop, .sheet, [data-no-pull]";

/** A pull may start here: nothing between the target and the container is scrolled away from its top. */
function startsAtTop(target: EventTarget | null, scroller: HTMLElement): boolean {
  if (!(target instanceof Element) || !scroller.contains(target) || target.closest(NOT_HERE)) return false;
  for (let node: Element | null = target; node; node = node.parentElement) {
    if (node.scrollTop > 0) return false;
    if (node === scroller) return true;
  }
  return false;
}

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface PullRefresh {
  /** Puts the content back at rest and hides the spinner, whatever the gesture or refresh was doing. */
  reset(): void;
  detach(): void;
}

/**
 * Pull `scroller` down from its top and let go past the threshold to run
 * `refresh()` once. The spinner sits in `host`, just above the scroller.
 */
export function attachPullRefresh(scroller: HTMLElement, host: HTMLElement, refresh: () => unknown): PullRefresh {
  const spinner = h("div", { class: "ptr", attrs: { "aria-hidden": "true" } }, h("span", { class: "ptr-ring" }));
  const status = h("span", { class: "ptr-status", attrs: { role: "status" } });
  host.append(spinner, status);
  let start: { x: number; y: number } | null = null;
  let state: "idle" | "maybe" | "pulling" | "refreshing" = "idle";
  let distance = 0;
  /** Bumped by reset(), so a refresh that ends afterwards leaves the rest state alone. */
  let generation = 0;

  const draw = (d: number, animate: boolean) => {
    const still = reducedMotion();
    scroller.style.transition = animate && !still ? "transform 0.22s ease" : "";
    scroller.style.transform = d > 0 && !still ? `translateY(${d}px)` : "";
    spinner.style.top = `${scroller.offsetTop}px`;
    spinner.style.setProperty("--pull", String(Math.min(1, d / PULL_THRESHOLD)));
    spinner.classList.toggle("shown", d > 0);
    spinner.classList.toggle("armed", d >= PULL_THRESHOLD);
  };

  const reset = () => {
    generation++;
    start = null;
    distance = 0;
    const moved = state !== "idle" && state !== "maybe";
    state = "idle";
    spinner.classList.remove("spinning");
    status.textContent = "";
    if (moved || scroller.style.transform) draw(0, true);
  };

  const onStart = (event: TouchEvent) => {
    if (state === "refreshing") return;
    // A second finger ends the pull: the content goes back rather than staying where it was.
    if (state === "pulling") return reset();
    const touch = event.touches.length === 1 ? event.touches[0] : undefined;
    state = touch && startsAtTop(event.target, scroller) ? "maybe" : "idle";
    start = touch && state === "maybe" ? { x: touch.clientX, y: touch.clientY } : null;
  };

  const onMove = (event: TouchEvent) => {
    if (!start || (state !== "maybe" && state !== "pulling")) return;
    const touch = event.touches[0];
    if (!touch || event.touches.length !== 1) return reset();
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (state === "maybe") {
      if (dx === 0 && dy === 0) return;
      // Decided on the first move: later ones can no longer stop the browser's scroll.
      if (dy <= 0 || Math.abs(dx) >= dy || scroller.scrollTop > 0) {
        state = "idle";
        return;
      }
      state = "pulling";
    }
    if (event.cancelable) event.preventDefault();
    distance = resist(dy);
    draw(distance, false);
  };

  const onEnd = () => {
    if (state !== "pulling") {
      if (state === "maybe") state = "idle";
      return;
    }
    start = null;
    if (distance < PULL_THRESHOLD) return reset();
    state = "refreshing";
    spinner.classList.add("spinning");
    status.textContent = "Refreshing";
    draw(PULL_THRESHOLD, true);
    const spin = new Promise((resolve) => window.setTimeout(resolve, MIN_SPIN_MS));
    const current = generation;
    void Promise.allSettled([Promise.resolve().then(refresh), spin]).then(() => {
      if (spinner.isConnected && current === generation) reset();
    });
  };

  // The pull needs a cancelable touchmove, and a listener that can cancel makes the start of every scroll wait for the
  // page's main thread. Only a scroller at its top can start a pull, so it listens only then: a scroll that starts
  // further down never waits.
  let listening = false;
  const onScroll = () => {
    const top = scroller.scrollTop <= 0;
    if (top === listening) return;
    listening = top;
    if (top) scroller.addEventListener("touchmove", onMove, { passive: false });
    else scroller.removeEventListener("touchmove", onMove);
  };
  scroller.addEventListener("touchstart", onStart, { passive: true });
  onScroll();
  scroller.addEventListener("scroll", onScroll, { passive: true });
  const onCancel = () => (state === "idle" ? undefined : reset());
  scroller.addEventListener("touchend", onEnd);
  scroller.addEventListener("touchcancel", onCancel);
  const detach = () => {
    scroller.removeEventListener("touchstart", onStart);
    scroller.removeEventListener("touchmove", onMove);
    scroller.removeEventListener("scroll", onScroll);
    scroller.removeEventListener("touchend", onEnd);
    scroller.removeEventListener("touchcancel", onCancel);
    scroller.style.transform = "";
    scroller.style.transition = "";
    spinner.remove();
    status.remove();
  };
  return { reset, detach };
}
