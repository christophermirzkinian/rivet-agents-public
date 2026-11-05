// The animated grill in index.html, shown while the app loads after Android's still splash. It never holds a loaded app back for more than about a second
// from launch, and a stalled load still uncovers the app, so an error or the sign-in is never hidden.

/** From launch: long enough for the coals to flicker once, short enough to read as part of the load. */
export const BOOT_MIN_MS = 900;
/** A load still going after this shows the app anyway; its own screens say what is wrong. */
export const BOOT_MAX_MS = 6000;
const FADE_MS = 250;

let done = false;

export function dismissBoot(): void {
  if (done) return;
  done = true;
  const boot = document.getElementById("boot");
  if (!boot) return;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const wait = still ? 0 : Math.max(0, BOOT_MIN_MS - performance.now());
  window.setTimeout(() => {
    boot.classList.add("gone");
    window.setTimeout(() => boot.remove(), still ? 0 : FADE_MS);
  }, wait);
}

// Counted from launch, like BOOT_MIN_MS; boot.css hides it at the same moment if this script never runs.
window.setTimeout(dismissBoot, Math.max(0, BOOT_MAX_MS - performance.now()));
