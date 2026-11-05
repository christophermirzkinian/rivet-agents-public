// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { covered } from "../web/src/push.js";
import { closeSheet, closeTallSheet, openSheet, openTallSheet, swipeOpens } from "../web/src/views/sheet.js";

// A sheet faded in from above its place, so the screen under it
// showed through, and went in one frame. It slides up whole now, and back down as it closes.
const SRC = join(dirname(fileURLToPath(import.meta.url)), "../web/src");
const css = readFileSync(join(SRC, "styles.css"), "utf8");
const body = { mount: (el: HTMLElement) => void el.append("Hello"), unmount: () => {} };
const backdrops = () => [...document.querySelectorAll<HTMLElement>(".sheet-backdrop")];

/** A browser that runs animations; happy-dom has no getAnimations, so a sheet there goes at once. */
function animating(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  (HTMLElement.prototype as unknown as { getAnimations: () => unknown[] }).getAnimations = () => [];
}

afterEach(() => {
  vi.restoreAllMocks();
  closeTallSheet();
  closeSheet();
  delete (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("a sheet's motion", () => {
  it("slides up opaque over a dim that fades in: no fade on the panel", () => {
    const sheet = css.match(/\n\.sheet \{[^}]*\}/)![0];
    expect(sheet).toMatch(/animation: sheet-up /);
    expect(css).toMatch(/@keyframes sheet-up \{\s*from \{\s*transform: translateY\(100%\);\s*\}\s*\}/);
    expect(css.match(/\n:is\(\.sheet-backdrop, \.scene-sheet-backdrop\)::before \{[^}]*\}/)![0]).toMatch(/background: var\(--sheet-dim\);[\s\S]*animation: sheet-dim /);
  });

  it("slides back down as it closes, no longer a dialog, and goes when its slide ends", () => {
    animating();
    openTallSheet("Rivet", body);
    const [backdrop] = backdrops();
    const panel = backdrop!.querySelector<HTMLElement>(".sheet")!;
    closeTallSheet();
    expect(backdrop!.isConnected).toBe(true);
    expect(backdrop!.classList.contains("is-leaving")).toBe(true);
    expect(panel.hasAttribute("aria-modal")).toBe(false);
    expect(panel.hasAttribute("role")).toBe(false);
    expect(covered()).toBe(false);
    // A child's own animation ending is not the slide's.
    panel.querySelector(".sheet-body")!.dispatchEvent(new Event("animationend", { bubbles: true }));
    expect(backdrop!.isConnected).toBe(true);
    panel.dispatchEvent(new Event("animationend"));
    expect(backdrop!.isConnected).toBe(false);
  });

  it("goes after the slide's time even when no animationend comes", () => {
    animating();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    openSheet("Reject", body);
    const [backdrop] = backdrops();
    closeSheet();
    expect(backdrop!.isConnected).toBe(true);
    vi.advanceTimersByTime(400);
    expect(backdrop!.isConnected).toBe(false);
  });

  it("goes at once with reduced motion", () => {
    animating();
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }));
    openSheet("Reject", body);
    closeSheet();
    expect(backdrops()).toHaveLength(0);
  });

  it("closed by a drag, slides on down from where the thumb let go", () => {
    animating();
    openTallSheet("Rivet", body);
    const panel = document.querySelector<HTMLElement>(".sheet.is-tall")!;
    const handle = panel.querySelector<HTMLElement>(".sheet-handle")!;
    handle.dispatchEvent(at(new PointerEvent("pointerdown", { pointerId: 1, clientY: 100 })));
    clock(500);
    handle.dispatchEvent(at(new PointerEvent("pointermove", { pointerId: 1, clientY: 400 })));
    clock(300);
    handle.dispatchEvent(at(new PointerEvent("pointerup", { pointerId: 1, clientY: 400 })));
    expect(panel.closest(".sheet-backdrop")!.classList.contains("is-leaving")).toBe(true);
    expect(panel.style.transform).toBe("translateY(300px)");
  });

  it("keeps showing what it showed as it slides away, though its view has gone", () => {
    animating();
    let host: HTMLElement | null = null;
    let card: HTMLElement | null = null;
    openTallSheet("Decide", { mount: (el) => void (host = el).append((card = document.createElement("p")), "The card"), unmount: () => host!.replaceChildren() });
    const panel = document.querySelector<HTMLElement>(".sheet.is-tall")!;
    closeTallSheet();
    expect(panel.textContent).toBe("The card");
    // Its own nodes, not a copy to lay out again.
    expect(panel.contains(card)).toBe(true);
  });

  it("puts back what an unmount takes out below its host, as Decide's card slot", () => {
    animating();
    const slot = document.createElement("div");
    const card = document.createElement("article");
    card.textContent = "The card";
    slot.append(card);
    openTallSheet("Decide", { mount: (el) => el.append(slot), unmount: () => slot.replaceChildren() });
    const panel = document.querySelector<HTMLElement>(".sheet.is-tall")!;
    closeTallSheet();
    expect(card.parentElement).toBe(slot);
    expect(panel.contains(card)).toBe(true);
  });

  it("leaves a view's nodes where they are when its unmount leaves them", () => {
    animating();
    const thread = document.createElement("ol");
    openTallSheet("Rivet", { mount: (el) => void el.append(thread), unmount: () => {} });
    const panel = document.querySelector<HTMLElement>(".sheet.is-tall")!;
    const host = thread.parentElement;
    closeTallSheet();
    expect(thread.parentElement).toBe(host);
    expect(panel.contains(thread)).toBe(true);
  });

  it("pauses the home screen's motion under a tall sheet and plays it again as the sheet leaves", () => {
    animating();
    const view = document.createElement("main");
    view.className = "view";
    document.body.append(view);
    const motion = (playState: string) => {
      const one = { playState, pause: vi.fn(() => void (one.playState = "paused")), play: vi.fn(() => void (one.playState = "running")) };
      return one;
    };
    const running = motion("running");
    const finished = motion("finished");
    (view as unknown as { getAnimations: () => unknown[] }).getAnimations = () => [running, finished];
    openTallSheet("Rivet", body);
    expect(running.pause).toHaveBeenCalledOnce();
    expect(finished.pause).not.toHaveBeenCalled();
    closeTallSheet();
    expect(running.play).toHaveBeenCalledOnce();
    expect(finished.play).not.toHaveBeenCalled();
  });

  // feed-cards-fit once hung: the home screen's redraw after the slide started a desk's spawn under the sheet, and it ran
  // until its animationstart a frame later, so a wait for the home screen's unpaused motion waited on one that never ends.
  it("pauses motion a home-screen redraw starts under the sheet in the redraw's own task, and plays it as the sheet leaves", async () => {
    animating();
    const view = document.createElement("main");
    view.className = "view";
    document.body.append(view);
    const motions: { playState: string; pause: () => void; play: () => void }[] = [];
    (view as unknown as { getAnimations: () => unknown[] }).getAnimations = () => motions;
    openTallSheet("Decide", body);
    const spawn = { playState: "running", pause: vi.fn(() => void (spawn.playState = "paused")), play: vi.fn(() => void (spawn.playState = "running")) };
    motions.push(spawn);
    view.append(Object.assign(document.createElement("div"), { className: "desk is-spawn" }));
    await Promise.resolve();
    expect(spawn.pause).toHaveBeenCalledOnce();
    closeTallSheet();
    expect(spawn.play).toHaveBeenCalledOnce();
    view.append(document.createElement("div"));
    await Promise.resolve();
    expect(spawn.pause).toHaveBeenCalledOnce();
  });
});

/** The time the drags read (an event's timeStamp), so a flick and a slow drag are what the test says. */
let now = 0;
function clock(ms: number): void {
  now += ms;
}

function at<T extends Event>(event: T): T {
  return Object.defineProperty(event, "timeStamp", { value: now });
}

function touch(el: Element, type: string, y: number, x = 0): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const finger = { clientX: x, clientY: y, identifier: 1, target: el };
  Object.assign(event, { touches: type === "touchend" || type === "touchcancel" ? [] : [finger], changedTouches: [finger] });
  el.dispatchEvent(at(event));
  return event;
}

describe("a swipe on a tall sheet", () => {
  const view = { mount: (el: HTMLElement) => void el.append(Object.assign(document.createElement("div"), { className: "list" })), unmount: () => {} };
  const panel = () => document.querySelector<HTMLElement>(".sheet.is-tall")!;
  const backdrop = () => document.querySelector<HTMLElement>(".sheet-backdrop.is-tall")!;

  beforeEach(() => {
    now = 0;
    animating();
    // happy-dom lays nothing out: the sheet is the window's height (768).
    openTallSheet("Rivet", view);
  });

  it("follows the finger down and dims less, and springs back from short of a third", () => {
    touch(panel(), "touchstart", 100);
    clock(100);
    const move = touch(panel(), "touchmove", 300);
    expect(move.defaultPrevented).toBe(true);
    expect(panel().style.transform).toBe("translateY(200px)");
    expect(backdrop().classList.contains("is-dragging")).toBe(true);
    expect(Number(backdrop().style.getPropertyValue("--sheet-drag"))).toBeCloseTo(200 / 768);
    clock(300);
    touch(panel(), "touchend", 300);
    expect(backdrop().classList.contains("is-leaving")).toBe(false);
    expect(backdrop().classList.contains("is-dragging")).toBe(false);
    expect(panel().style.transform).toBe("");
    expect(backdrop().style.getPropertyValue("--sheet-drag")).toBe("");
  });

  it("closes past a third, and slides on from there", () => {
    touch(panel(), "touchstart", 100);
    clock(200);
    touch(panel(), "touchmove", 400);
    clock(300);
    touch(panel(), "touchend", 400);
    expect(backdrop().classList.contains("is-leaving")).toBe(true);
    expect(panel().style.transform).toBe("translateY(300px)");
  });

  it("closes on a flick, however short", () => {
    touch(panel(), "touchstart", 100);
    clock(20);
    touch(panel(), "touchmove", 140);
    clock(20);
    touch(panel(), "touchend", 160);
    expect(backdrop().classList.contains("is-leaving")).toBe(true);
  });

  it("leaves a list scrolled down to scroll, and a drag up or sideways to the content", () => {
    const list = panel().querySelector<HTMLElement>(".list")!;
    Object.defineProperties(list, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } });
    list.style.overflowY = "auto";
    list.scrollTop = 50;
    touch(list, "touchstart", 100);
    clock(20);
    expect(touch(list, "touchmove", 300).defaultPrevented).toBe(false);
    touch(list, "touchend", 300);
    expect(panel().style.transform).toBe("");

    list.scrollTop = 0;
    touch(list, "touchstart", 300);
    expect(touch(list, "touchmove", 200).defaultPrevented).toBe(false);
    touch(list, "touchstart", 300, 0);
    expect(touch(list, "touchmove", 320, 60).defaultPrevented).toBe(false);
    expect(panel().style.transform).toBe("");

    // At its top, down drags the sheet.
    touch(list, "touchstart", 100);
    expect(touch(list, "touchmove", 200).defaultPrevented).toBe(true);
    expect(panel().style.transform).toBe("translateY(100px)");
  });

  it("closes on a flick after a hold, measured over the flick alone", () => {
    touch(panel(), "touchstart", 100);
    clock(1000);
    touch(panel(), "touchmove", 140);
    clock(20);
    touch(panel(), "touchend", 180);
    expect(backdrop().classList.contains("is-leaving")).toBe(true);
  });

  it("goes back when a second finger lands mid-drag, and is not left part-way", () => {
    touch(panel(), "touchstart", 100);
    clock(100);
    touch(panel(), "touchmove", 200);
    expect(panel().style.transform).toBe("translateY(100px)");
    const second = new Event("touchstart", { bubbles: true });
    const fingers = [{ clientX: 0, clientY: 200, identifier: 1 }, { clientX: 50, clientY: 300, identifier: 2 }];
    Object.assign(second, { touches: fingers, changedTouches: [fingers[1]] });
    panel().dispatchEvent(at(second));
    expect(backdrop().classList.contains("is-dragging")).toBe(false);
    expect(panel().style.transform).toBe("");
    expect(backdrop().style.getPropertyValue("--sheet-drag")).toBe("");
    touch(panel(), "touchend", 200);
    expect(backdrop().classList.contains("is-leaving")).toBe(false);
  });

  it("a tap is not a drag", () => {
    touch(panel(), "touchstart", 100);
    touch(panel(), "touchmove", 104);
    touch(panel(), "touchend", 104);
    expect(backdrop().classList.contains("is-dragging")).toBe(false);
    expect(backdrop().classList.contains("is-leaving")).toBe(false);
  });
});

describe("a swipe up off the dock", () => {
  let button: HTMLButtonElement;
  const panel = () => document.querySelector<HTMLElement>(".sheet-backdrop:not(.is-leaving) > .sheet.is-tall");

  beforeEach(() => {
    now = 0;
    animating();
    button = document.createElement("button");
    button.addEventListener("click", () => openTallSheet("Rivet", body));
    document.body.append(button);
    swipeOpens(button);
  });

  it("brings the sheet up under the finger, and opens it fully past a third", () => {
    touch(button, "touchstart", 760);
    clock(100);
    touch(button, "touchmove", 700);
    expect(panel()).not.toBeNull();
    expect(panel()!.style.transform).toBe("translateY(708px)");
    clock(200);
    touch(button, "touchmove", 400);
    expect(panel()!.style.transform).toBe("translateY(408px)");
    clock(300);
    touch(button, "touchend", 400);
    expect(panel()!.style.transform).toBe("");
  });

  it("slides back down and closes from short of a third", () => {
    touch(button, "touchstart", 760);
    clock(100);
    touch(button, "touchmove", 700);
    clock(300);
    touch(button, "touchend", 700);
    expect(panel()).toBeNull();
    expect(document.querySelector(".sheet-backdrop.is-leaving")).not.toBeNull();
  });

  it("opens on a flick up", () => {
    touch(button, "touchstart", 760);
    clock(20);
    touch(button, "touchmove", 720);
    clock(20);
    touch(button, "touchend", 690);
    expect(panel()!.style.transform).toBe("");
  });

  it("a tap stays a tap, and a drag down does nothing", () => {
    touch(button, "touchstart", 760);
    touch(button, "touchmove", 790);
    touch(button, "touchend", 790);
    expect(panel()).toBeNull();
  });
});
