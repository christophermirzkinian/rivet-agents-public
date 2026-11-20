// Pull a line to the right to reply to it, as in Messenger: the pull itself is the reply, with no button to press
// (owner, 20 Nov). The line follows the finger and
// a reply arrow fades in behind it; past SWIPE_AT a light buzz says letting go will reply, and letting go there starts
// the same reply as the Reply button. Short of it the line springs back and nothing happens.

/** How far, in px, a line must be pulled before letting go replies. */
export const SWIPE_AT = 64;
/** Taps that start this close to the screen's left edge are Android's back gesture, never a pull. */
export const EDGE = 24;
/** How far a finger moves before the pull decides it is sideways (a pull) or not (a scroll, left alone). */
const DECIDE = 10;
/** The line never goes further than this; past SWIPE_AT it moves at a third of the finger's pace. */
const MOST = 96;

const stillMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Where the line sits for a finger `dx` px to the right: the finger's own pace up to SWIPE_AT, then slower. */
export function pulledTo(dx: number): number {
  if (dx <= 0) return 0;
  if (dx <= SWIPE_AT) return dx;
  return Math.min(MOST, SWIPE_AT + (dx - SWIPE_AT) / 3);
}

/**
 * Lets `line` be pulled right to reply. `reply` runs when a pull past SWIPE_AT is let go. A pull that started
 * swallows the click that follows it, so the line's tap (its time, More and Reply) never opens as well.
 */
export function swipeToReply(line: HTMLElement, reply: () => void): void {
  // The arrow is the line's own ::before and ::after in the stylesheet, faded in by `--swipe`.
  let id: number | null = null;
  let x0 = 0;
  let y0 = 0;
  let state: "idle" | "deciding" | "pulling" | "off" = "idle";
  let past = false;
  let swallow = false;

  const place = (dx: number) => {
    const at = pulledTo(dx);
    line.style.setProperty("--swipe", String(Math.min(1, at / SWIPE_AT)));
    line.style.transform = at && !stillMotion() ? `translateX(${at}px)` : "";
  };
  const end = (go: boolean) => {
    const was = state;
    state = "idle";
    id = null;
    if (was !== "pulling") return;
    line.classList.remove("swiping");
    line.classList.add("swipe-back");
    place(0);
    line.style.removeProperty("--swipe");
    window.setTimeout(() => line.classList.remove("swipe-back"), 220);
    swallow = true;
    if (go) reply();
  };

  line.addEventListener("pointerdown", (event) => {
    // A new press: a click a past pull left unclaimed (a touch drag makes none) never eats this one's tap.
    swallow = false;
    // A finger or pen only: a mouse drag across the words picks them, as it did. A clip's or a sound's own controls
    // (its seek bar) keep their drags.
    if (id !== null || event.pointerType === "mouse") return;
    if (event.clientX < EDGE || (event.target as Element | null)?.closest?.("video, audio")) return;
    id = event.pointerId;
    x0 = event.clientX;
    y0 = event.clientY;
    state = "deciding";
    past = false;
  });
  line.addEventListener("pointermove", (event) => {
    if (event.pointerId !== id || state === "off" || state === "idle") return;
    const dx = event.clientX - x0;
    const dy = event.clientY - y0;
    if (state === "deciding") {
      if (Math.abs(dx) < DECIDE && Math.abs(dy) < DECIDE) return;
      // Only a mostly sideways pull to the right is ours. The line's pan-y gives the browser any move that starts
      // mostly up or down (its scroll), and the same split here leaves no angle that does neither.
      if (dx <= 0 || dx <= Math.abs(dy)) {
        state = "off";
        return;
      }
      state = "pulling";
      line.classList.add("swiping");
      line.setPointerCapture?.(event.pointerId);
      window.getSelection()?.removeAllRanges();
    }
    event.preventDefault();
    place(dx);
    const now = pulledTo(dx) >= SWIPE_AT;
    if (now && !past) navigator.vibrate?.(10);
    past = now;
  });
  line.addEventListener("pointerup", (event) => {
    if (event.pointerId !== id) return;
    end(past);
  });
  line.addEventListener("pointercancel", (event) => {
    if (event.pointerId !== id) return;
    end(false);
  });
  line.addEventListener(
    "click",
    (event) => {
      if (!swallow) return;
      swallow = false;
      event.stopPropagation();
      event.preventDefault();
    },
    { capture: true },
  );
}
