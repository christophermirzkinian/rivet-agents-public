// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One observer drives every clip: on screen plays, off screen or a hidden app stops, reduced motion never plays, and
// a clip that left the app for good is let go.

let fire: (entries: { target: Element; isIntersecting: boolean; intersectionRatio: number }[]) => void;
const unobserved: Element[] = [];
let reduce = false;
const listeners: (() => void)[] = [];

beforeEach(() => {
  vi.resetModules();
  unobserved.length = 0;
  listeners.length = 0;
  reduce = false;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof fire) {
        fire = callback;
      }
      observe() {}
      unobserve(target: Element) {
        unobserved.push(target);
      }
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return reduce;
    },
    addEventListener: (_: string, listener: () => void) => listeners.push(listener),
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function watched() {
  const { autoplay, unwatch } = await import("../web/src/views/autoplay.js");
  const target = document.createElement("video");
  const player = { start: vi.fn(), stop: vi.fn() };
  autoplay(target, player);
  return { target, player, unwatch };
}

describe("autoplay", () => {
  it("plays on screen and stops once it has stayed off screen", async () => {
    vi.useFakeTimers();
    const { target, player } = await watched();
    fire([{ target, isIntersecting: true, intersectionRatio: 0.6 }]);
    expect(player.start).toHaveBeenLastCalledWith(true);
    fire([{ target, isIntersecting: false, intersectionRatio: 0 }]);
    expect(player.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(player.stop).toHaveBeenCalledTimes(1);
  });

  // The owner, 20 Oct: every poll's redraw moved the open card's clip, the observer saw it leave and come back, and the
  // clip paused, muted and re-buffered each time.
  it("leaves a playing clip alone when a redraw moves it and it comes straight back", async () => {
    vi.useFakeTimers();
    const { target, player } = await watched();
    fire([{ target, isIntersecting: true, intersectionRatio: 1 }]);
    fire([{ target, isIntersecting: false, intersectionRatio: 0 }]);
    fire([{ target, isIntersecting: true, intersectionRatio: 1 }]);
    vi.advanceTimersByTime(1000);
    expect(player.stop).not.toHaveBeenCalled();
    expect(player.start).toHaveBeenCalledTimes(1);
    // Still watched: scrolled away for real, it stops.
    fire([{ target, isIntersecting: false, intersectionRatio: 0 }]);
    vi.advanceTimersByTime(400);
    expect(player.stop).toHaveBeenCalledTimes(1);
  });

  it("stops a playing clip when reduced motion is turned on, and starts it when it is turned off", async () => {
    const { target, player } = await watched();
    fire([{ target, isIntersecting: true, intersectionRatio: 1 }]);
    reduce = true;
    for (const listener of listeners) listener();
    expect(player.stop).toHaveBeenCalledTimes(1);
    reduce = false;
    for (const listener of listeners) listener();
    expect(player.start).toHaveBeenLastCalledWith(true);
    expect(player.start).toHaveBeenCalledTimes(2);
  });

  it("lets go of a clip that has left the app", async () => {
    const { target, player, unwatch } = await watched();
    fire([{ target, isIntersecting: true, intersectionRatio: 1 }]);
    unwatch(target);
    expect(unobserved).toContain(target);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(player.start).toHaveBeenCalledTimes(1);
    expect(player.stop).not.toHaveBeenCalled();
  });
});
