// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IMAGE_LOAD_MS, closeLightbox, openImages, openPdf } from "../web/src/views/lightbox.js";

// The one full-screen viewer behind card stills, chat photos and card PDFs: how it opens and closes, and that a double
// tap zooms the image in its own layout (so it stays sharp) rather than through the page.

const view = () => document.querySelector<HTMLElement>(".lightbox");
const img = () => document.querySelector<HTMLImageElement>(".lightbox-img")!;
const key = (k: string, init: KeyboardEventInit = {}) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));

let opener: HTMLButtonElement;
let back: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  document.body.innerHTML = "";
  opener = document.createElement("button");
  opener.textContent = "Screenshot";
  const app = document.createElement("main");
  app.append(opener);
  document.body.append(app);
  opener.focus();
  back = vi.spyOn(history, "back").mockImplementation(() => window.dispatchEvent(new PopStateEvent("popstate")));
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  // happy-dom lays nothing out: give the stage a phone's size and the image a wide 4-up sheet's.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 400 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => 4000 });
  Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", { configurable: true, get: () => 2000 });
});

afterEach(() => {
  closeLightbox();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const name of ["clientWidth", "clientHeight"]) Reflect.deleteProperty(HTMLElement.prototype, name);
  for (const name of ["naturalWidth", "naturalHeight"]) Reflect.deleteProperty(HTMLImageElement.prototype, name);
});

describe("the lightbox", () => {
  it("opens as a modal over an inert app, with focus on Close, and Escape gives everything back", () => {
    const push = vi.spyOn(history, "pushState");
    openImages(["/media/a", "/media/b"], 1);
    expect(view()!.getAttribute("role")).toBe("dialog");
    expect(view()!.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement?.classList.contains("lightbox-close")).toBe(true);
    expect(document.querySelector("main")!.hasAttribute("inert")).toBe(true);
    expect(document.documentElement.classList.contains("lightbox-open")).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
    expect(img().getAttribute("src")).toBe("/media/b");

    key("Escape");
    expect(view()).toBeNull();
    expect(document.querySelector("main")!.hasAttribute("inert")).toBe(false);
    expect(document.documentElement.classList.contains("lightbox-open")).toBe(false);
    expect(back).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it("the back button closes it without going back a second time", () => {
    openImages(["/media/a"], 0);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(view()).toBeNull();
    expect(back).not.toHaveBeenCalled();
  });

  it("steps through several images with the arrows and the arrow keys, wrapping round", () => {
    openImages(["/media/a", "/media/b", "/media/c"], 0, "Photo");
    const title = () => document.querySelector(".lightbox-title")!.textContent;
    expect(title()).toBe("Photo 1 of 3");
    document.querySelector<HTMLButtonElement>("[aria-label='Next']")!.click();
    expect(img().getAttribute("src")).toBe("/media/b");
    key("ArrowLeft");
    key("ArrowLeft");
    expect(img().getAttribute("src")).toBe("/media/c");
    expect(title()).toBe("Photo 3 of 3");
    expect(document.querySelectorAll(".lightbox-img")).toHaveLength(1);
  });

  it("a single image has no arrows", () => {
    openImages(["/media/a"], 0);
    expect(document.querySelector("[aria-label='Next']")).toBeNull();
    expect(document.querySelector(".lightbox-title")!.textContent).toBe("Screenshot");
  });

  it("keeps Tab inside the viewer", () => {
    openImages(["/media/a", "/media/b"], 0);
    const close = document.querySelector<HTMLButtonElement>(".lightbox-close")!;
    const first = document.querySelector<HTMLButtonElement>(".lightbox-bar button")!;
    expect(document.activeElement).toBe(close);
    key("Tab");
    expect(document.activeElement).toBe(first);
    key("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(close);
  });

  it("Tab reaches a document's links as well as the buttons", () => {
    openImages(["/media/a", "/media/b"], 0);
    const first = document.querySelector<HTMLButtonElement>(".lightbox-bar button")!;
    const link = view()!.appendChild(document.createElement("a"));
    link.href = "https://example.com/";
    link.focus();
    key("Tab");
    expect(document.activeElement).toBe(first);
    key("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(link);
  });

  it("a replaced image failing late says nothing over the one shown, and a load clears the note", () => {
    openImages(["/media/a", "/media/b"], 0);
    const a = img();
    const note = document.querySelector<HTMLElement>(".lightbox-note")!;
    document.querySelector<HTMLButtonElement>("[aria-label='Next']")!.click();
    a.dispatchEvent(new Event("error"));
    expect(note.hidden).toBe(true);
    img().dispatchEvent(new Event("error"));
    expect(note.hidden).toBe(false);
    img().dispatchEvent(new Event("load"));
    expect(note.hidden).toBe(true);
  });

  it("an image that neither loads nor fails says it could not load, and a late load still shows it", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const note = () => document.querySelector<HTMLElement>(".lightbox-note")!;
    openImages(["/media/a"], 0);
    img().dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(IMAGE_LOAD_MS);
    expect(note().hidden).toBe(true);
    closeLightbox();

    openImages(["/media/b"], 0);
    vi.advanceTimersByTime(IMAGE_LOAD_MS - 1);
    expect(note().hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(note().hidden).toBe(false);
    expect(note().textContent).toBe("Could not load the image.");
    img().dispatchEvent(new Event("load"));
    expect(note().hidden).toBe(true);
  });

  it("opening another replaces the first and keeps one history entry", () => {
    const push = vi.spyOn(history, "pushState");
    openImages(["/media/a"], 0);
    openImages(["/media/b"], 0);
    expect(document.querySelectorAll(".lightbox")).toHaveLength(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>(".lightbox-close")!.click();
    expect(view()).toBeNull();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("fits the image, a double tap zooms its layout in on the tapped point, and another goes back", () => {
    openImages(["/media/a"], 0);
    img().dispatchEvent(new Event("load"));
    expect(img().style.width).toBe("400px");
    expect(img().style.height).toBe("200px");
    expect(img().style.transform).toBe("translate3d(0px, 300px, 0)");
    const stage = document.querySelector<HTMLElement>(".lightbox-stage")!;
    const tap = (id: number) => {
      for (const type of ["pointerdown", "pointerup"]) stage.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: 150, clientY: 400, bubbles: true, pointerType: "touch" }));
    };
    tap(1);
    tap(2);
    expect(img().style.width).toBe("1200px");
    expect(img().style.height).toBe("600px");
    // The tapped sheet point (150, 100) stays under the finger: x + 150 * 3 = 150.
    expect(img().style.transform).toBe("translate3d(-300px, 100px, 0)");
    tap(3);
    tap(4);
    expect(img().style.width).toBe("400px");
  });

  it("a pinch goes on smoothly from the two fingers left when one of three lifts", () => {
    openImages(["/media/a"], 0);
    const stage = document.querySelector<HTMLElement>(".lightbox-stage")!;
    const pointer = (type: string, id: number, x: number, y: number) =>
      stage.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, pointerType: "touch" }));
    pointer("pointerdown", 1, 100, 400);
    pointer("pointerdown", 2, 300, 400);
    pointer("pointermove", 2, 350, 400);
    expect(img().style.width).toBe("500px");
    pointer("pointerdown", 3, 200, 600);
    pointer("pointerup", 1, 100, 400);
    const after = [img().style.width, img().style.transform];
    // Fingers 2 and 3 have not moved: nothing jumps.
    pointer("pointermove", 3, 200, 600);
    expect([img().style.width, img().style.transform]).toEqual(after);
    // Spreading them zooms from where the pinch had got to.
    pointer("pointermove", 3, 200 - 150, 600 + 200);
    expect(img().style.width).toBe("1000px");
  });

  it("a PDF shows why it could not be had, and closing drops a late answer", async () => {
    openPdf("Terms.pdf", () => Promise.resolve("That PDF is no longer on the server."));
    expect(document.querySelector(".lightbox-note")!.textContent).toBe("Getting the PDF…");
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector(".lightbox-note")!.textContent).toBe("That PDF is no longer on the server.");
    closeLightbox();

    let answer!: (value: string) => void;
    openPdf("Terms.pdf", () => new Promise<string>((done) => (answer = done)));
    closeLightbox();
    answer("Could not get the PDF. Try again.");
    await Promise.resolve();
    expect(view()).toBeNull();
  });
});
