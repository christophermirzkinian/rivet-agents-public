// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDGE, SWIPE_AT, pulledTo, swipeToReply } from "../web/src/views/chat-swipe.js";

let line: HTMLElement;
let replied = 0;
let tapped = 0;

/** A pointer event as a finger makes it; `pointerId` 1, a touch. */
function finger(type: string, x: number, y: number, kind = "touch"): MouseEvent {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: kind });
  return event;
}

/** Puts a finger down at (x, y), moves it through each step, and lifts it at the last. */
function pull(x: number, y: number, steps: Array<[number, number]>, lift: "pointerup" | "pointercancel" = "pointerup"): MouseEvent[] {
  line.dispatchEvent(finger("pointerdown", x, y));
  const moves = steps.map(([dx, dy]) => {
    const move = finger("pointermove", x + dx, y + dy);
    line.dispatchEvent(move);
    return move;
  });
  const [dx, dy] = steps.at(-1) ?? [0, 0];
  line.dispatchEvent(finger(lift, x + dx, y + dy));
  return moves;
}

beforeEach(() => {
  vi.useFakeTimers();
  replied = 0;
  tapped = 0;
  line = document.createElement("li");
  line.className = "chat-msg";
  line.addEventListener("click", () => tapped++);
  document.body.replaceChildren(line);
  swipeToReply(line, () => replied++);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pull a line right to reply", () => {
  it("follows the finger, then slows past the threshold and stops at a most", () => {
    expect(pulledTo(-20)).toBe(0);
    expect(pulledTo(30)).toBe(30);
    expect(pulledTo(SWIPE_AT)).toBe(SWIPE_AT);
    expect(pulledTo(SWIPE_AT + 30)).toBe(SWIPE_AT + 10);
    expect(pulledTo(1000)).toBe(96);
  });

  it("past the threshold, letting go replies once, with one light buzz as it crosses", () => {
    const buzz = vi.fn();
    Object.defineProperty(navigator, "vibrate", { value: buzz, configurable: true });
    line.dispatchEvent(finger("pointerdown", 100, 300));
    line.dispatchEvent(finger("pointermove", 130, 302));
    expect(line.classList.contains("swiping")).toBe(true);
    expect(line.style.transform).toBe("translateX(30px)");
    expect(Number(line.style.getPropertyValue("--swipe"))).toBeCloseTo(30 / SWIPE_AT);
    expect(buzz).not.toHaveBeenCalled();
    line.dispatchEvent(finger("pointermove", 100 + SWIPE_AT + 6, 304));
    line.dispatchEvent(finger("pointermove", 100 + SWIPE_AT + 30, 304));
    expect(buzz).toHaveBeenCalledTimes(1);
    expect(buzz).toHaveBeenCalledWith(10);
    expect(replied).toBe(0);
    line.dispatchEvent(finger("pointerup", 100 + SWIPE_AT + 30, 304));
    expect(replied).toBe(1);
    // It springs back to where it was.
    expect(line.style.transform).toBe("");
    expect(line.classList.contains("swiping")).toBe(false);
    expect(line.classList.contains("swipe-back")).toBe(true);
    // The click a let-go makes is the pull's, not a tap that opens the line's time, More and Reply.
    line.click();
    expect(tapped).toBe(0);
    vi.advanceTimersByTime(500);
    line.click();
    expect(tapped).toBe(1);
  });

  it("short of the threshold, the line springs back and nothing happens", () => {
    pull(100, 300, [[20, 0], [SWIPE_AT - 4, 2]]);
    expect(replied).toBe(0);
    expect(line.style.transform).toBe("");
    expect(line.classList.contains("swipe-back")).toBe(true);
    vi.advanceTimersByTime(300);
    expect(line.classList.contains("swipe-back")).toBe(false);
  });

  it("pulled past and back again before letting go, it does not reply", () => {
    pull(100, 300, [[20, 0], [SWIPE_AT + 20, 0], [30, 0]]);
    expect(replied).toBe(0);
  });

  it("leaves an up-and-down scroll alone: no pull, no preventDefault, no reply", () => {
    const moves = pull(100, 300, [[4, 12], [20, 60], [90, 140]]);
    expect(moves.every((move) => !move.defaultPrevented)).toBe(true);
    expect(line.classList.contains("swiping")).toBe(false);
    expect(line.style.transform).toBe("");
    expect(replied).toBe(0);
  });

  it("a slanted move that is mostly up or down stays a scroll; one mostly sideways is a pull", () => {
    pull(100, 300, [[20, 24], [90, 100]]);
    expect(line.style.transform).toBe("");
    expect(replied).toBe(0);
    pull(100, 300, [[24, 20], [90, 60]]);
    expect(replied).toBe(1);
  });

  it("a mouse drag picks words as before and never pulls", () => {
    line.dispatchEvent(finger("pointerdown", 100, 300, "mouse"));
    line.dispatchEvent(finger("pointermove", 200, 300, "mouse"));
    line.dispatchEvent(finger("pointerup", 200, 300, "mouse"));
    expect(line.classList.contains("swiping")).toBe(false);
    expect(replied).toBe(0);
  });

  it("a drag on a clip's own controls (its seek bar) is the clip's, not a pull", () => {
    const clip = document.createElement("video");
    line.append(clip);
    clip.dispatchEvent(finger("pointerdown", 100, 300));
    clip.dispatchEvent(finger("pointermove", 200, 300));
    clip.dispatchEvent(finger("pointerup", 200, 300));
    expect(line.style.transform).toBe("");
    expect(replied).toBe(0);
  });

  it("a tap right after a short pull (which made no click) still opens", () => {
    pull(100, 300, [[20, 0], [40, 0]]);
    line.dispatchEvent(finger("pointerdown", 100, 300));
    line.dispatchEvent(finger("pointerup", 100, 300));
    line.click();
    expect(tapped).toBe(1);
  });

  it("a pull to the left does nothing", () => {
    pull(200, 300, [[-20, 0], [-90, 0]]);
    expect(line.style.transform).toBe("");
    expect(replied).toBe(0);
  });

  it("never starts at the screen's left edge, Android's back gesture", () => {
    pull(EDGE - 4, 300, [[20, 0], [120, 0]]);
    expect(line.classList.contains("swiping")).toBe(false);
    expect(line.style.transform).toBe("");
    expect(replied).toBe(0);
    pull(EDGE + 4, 300, [[20, 0], [120, 0]]);
    expect(replied).toBe(1);
  });

  it("a cancelled pull (the browser took the touch) springs back without replying", () => {
    pull(100, 300, [[20, 0], [SWIPE_AT + 20, 0]], "pointercancel");
    expect(replied).toBe(0);
    expect(line.style.transform).toBe("");
  });

  it("with reduced motion the line does not move, and the reply still starts", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), addEventListener() {} }));
    line.dispatchEvent(finger("pointerdown", 100, 300));
    line.dispatchEvent(finger("pointermove", 100 + SWIPE_AT + 10, 300));
    expect(line.style.transform).toBe("");
    expect(Number(line.style.getPropertyValue("--swipe"))).toBe(1);
    line.dispatchEvent(finger("pointerup", 100 + SWIPE_AT + 10, 300));
    expect(replied).toBe(1);
  });

  it("a plain tap is still a tap", () => {
    line.dispatchEvent(finger("pointerdown", 100, 300));
    line.dispatchEvent(finger("pointerup", 101, 300));
    line.click();
    expect(tapped).toBe(1);
    expect(replied).toBe(0);
  });
});
