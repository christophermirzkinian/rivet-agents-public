/**
 * Keeps a scroller at its foot while what is in it settles after a paint: fonts, pictures and a late layout grew the
 * Rivet chat 20 ms after it scrolled once, and it opened up to 275 px short of the newest message. From a
 * `place`, it holds until a scroll up leaves the foot, and holds again from within `near` px of it; `stop` lets go.
 * A jump (`place(false, true)`) lets go until the reader scrolls down to the foot himself.
 */
export function holdFoot(
  box: HTMLElement,
  near: number,
): { place(atFoot: boolean, jumped?: boolean): void; held(): boolean; stop(): void } {
  let held = false;
  let top = 0;
  // After a jump: only a scroll down to the foot takes hold again. The page settling under the jump's scroll
  // (the Asked-before strip going, the keyboard closing) tells of a scroll a frame late, unmoved or clamped at the
  // foot; taken for the reader, its hold pinned Chat to the foot and ended the jump's scroll.
  let jumping = false;
  // Growth never moves the scroll up; a scroll up that ends at the foot is a shorter page clamping it.
  const scrolled = () => {
    // Hidden (display:none), it reads 0 everywhere, which is no foot to hold.
    if (box.clientHeight === 0) return;
    const now = box.scrollTop;
    const left = box.scrollHeight - now - box.clientHeight;
    if (now < top && left > 1) held = false;
    else if (left < near && (!jumping || now > top)) {
      held = true;
      jumping = false;
    }
    top = now;
  };
  const sizes =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          if (!held) return;
          box.scrollTop = box.scrollHeight;
          top = box.scrollTop;
        })
      : null;
  return {
    place(atFoot, jumped = false) {
      held = atFoot;
      // A redraw during a jump's scroll (atFoot false) leaves it a jump.
      if (atFoot) jumping = false;
      else if (jumped) jumping = true;
      if (atFoot) box.scrollTop = box.scrollHeight;
      top = box.scrollTop;
      box.addEventListener("scroll", scrolled, { passive: true });
      // A paint can replace what is in it; the box itself too, as a sheet opening rewraps its lines.
      sizes?.disconnect();
      sizes?.observe(box);
      for (const child of box.children) sizes?.observe(child);
    },
    held: () => held,
    stop() {
      held = false;
      jumping = false;
      sizes?.disconnect();
      box.removeEventListener("scroll", scrolled);
    },
  };
}
