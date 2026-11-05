// Clips that play on their own: muted, and only while at least half of one is on screen and the app is showing.
// One observer serves every clip. Someone who asks for reduced motion gets the still, never the motion.

export interface AutoPlayer {
  /** On screen; `motion` is false under reduced motion, when it should load its first frame but not play. */
  start(motion: boolean): void;
  /** Off screen, or the app is hidden. */
  stop(): void;
}

const players = new WeakMap<Element, AutoPlayer>();
const onScreen = new Set<Element>();
/**
 * Clips that left the screen and stop unless they come back first. A redraw moves a card's clip into the new card, and
 * the observer reports it gone and back again: stopping it then would pause, mute and re-buffer it on every poll.
 */
const leaving = new Map<Element, ReturnType<typeof setTimeout>>();
/** How long a clip must stay off screen before it stops. */
export const LEAVE_MS = 400;
let observer: IntersectionObserver | null = null;

const REDUCED = "(prefers-reduced-motion: reduce)";
const motion = () => !(typeof matchMedia === "function" && matchMedia(REDUCED).matches);
const showing = () => document.visibilityState !== "hidden";

function watcher(): IntersectionObserver | null {
  if (observer || typeof IntersectionObserver === "undefined") return observer;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const player = players.get(entry.target);
        if (!player) continue;
        const target = entry.target;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          const away = leaving.get(target);
          leaving.delete(target);
          clearTimeout(away);
          // Back before it stopped: it plays on as it was.
          if (away !== undefined) continue;
          onScreen.add(target);
          if (showing()) player.start(motion());
        } else if (onScreen.has(target) && !leaving.has(target)) {
          leaving.set(
            target,
            setTimeout(() => {
              leaving.delete(target);
              if (onScreen.delete(target)) player.stop();
            }, LEAVE_MS),
          );
        }
      }
    },
    { threshold: 0.5 },
  );
  // Hiding the app stops every clip; turning reduced motion on mid-clip stops it too, and turning it off starts it.
  const retune = () => {
    for (const target of onScreen) {
      const player = players.get(target)!;
      if (showing() && motion()) player.start(true);
      else player.stop();
    }
  };
  document.addEventListener("visibilitychange", retune);
  if (typeof matchMedia === "function") matchMedia(REDUCED).addEventListener?.("change", retune);
  return observer;
}

/** Stops watching `target`, whose clip has left the app for good; the observer would otherwise keep it alive. */
export function unwatch(target: Element): void {
  observer?.unobserve(target);
  clearTimeout(leaving.get(target));
  leaving.delete(target);
  onScreen.delete(target);
  players.delete(target);
}

/** Plays `target`'s clip through `player` while it is on screen. */
export function autoplay(target: Element, player: AutoPlayer): void {
  players.set(target, player);
  watcher()?.observe(target);
}
