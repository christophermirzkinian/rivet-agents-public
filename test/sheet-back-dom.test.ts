// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeLightbox, openText } from "../web/src/views/lightbox.js";
import { closeSheet, closeTallSheet, leavePlainSheet, openSheet, openTallSheet } from "../web/src/views/sheet.js";

// A plain sheet (the menu drawer, Red jobs, a confirm) took no history entry, so the phone's Back left the app
// with the sheet open. It takes one now; a close that is not Back takes it off again without racing what opens next.
const body = { mount: (el: HTMLElement) => void el.append("Hello"), unmount: () => {} };
const sheets = () => document.querySelectorAll(".sheet-backdrop:not(.is-tall)").length;
const talls = () => document.querySelectorAll(".sheet-backdrop.is-tall").length;

/** The browser's session history: entries, and Back as a traversal that lands a task later. */
let stack: unknown[];
let backs: number;

/** Android's Back, landed. */
function pressBack(): void {
  stack.pop();
  window.dispatchEvent(new PopStateEvent("popstate", { state: stack[stack.length - 1] }));
}

beforeEach(() => {
  vi.useFakeTimers();
  stack = [null];
  backs = 0;
  vi.spyOn(history, "state", "get").mockImplementation(() => stack[stack.length - 1]);
  vi.spyOn(history, "pushState").mockImplementation((state) => void stack.push(state));
  vi.spyOn(history, "replaceState").mockImplementation((state) => void (stack[stack.length - 1] = state));
  vi.spyOn(history, "back").mockImplementation(() => {
    backs += 1;
    setTimeout(pressBack, 20);
  });
});

afterEach(() => {
  closeLightbox();
  closeTallSheet();
  closeSheet();
  vi.runAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("a plain sheet and the phone's Back", () => {
  it("takes an entry, and Back closes it without a second step back", () => {
    openSheet("Menu", body);
    expect(stack).toHaveLength(2);
    pressBack();
    expect(sheets()).toBe(0);
    vi.runAllTimers();
    expect(backs).toBe(0);
    expect(stack).toEqual([null]);
  });

  it("closed by its button, takes its entry off: the next Back is not a dead step", () => {
    openSheet("Menu", body);
    document.querySelector<HTMLElement>(".sheet .btn")!.click();
    expect(sheets()).toBe(0);
    vi.runAllTimers();
    expect(backs).toBe(1);
    expect(stack).toEqual([null]);
  });

  it("a page opened in the tap that closed it takes its entry over: no Back is in flight to close the page", () => {
    openSheet("Menu", body);
    closeSheet();
    openTallSheet("Machines", body);
    vi.runAllTimers();
    expect(backs).toBe(0);
    expect(stack).toHaveLength(2);
    expect(talls()).toBe(1);
    pressBack();
    expect(talls()).toBe(0);
    expect(stack).toEqual([null]);
  });

  it("one sheet replacing another (a confirm over Red jobs) keeps one entry", () => {
    openSheet("Red jobs", body);
    openSheet("Pause it?", body);
    vi.runAllTimers();
    expect(backs).toBe(0);
    expect(stack).toHaveLength(2);
    expect(sheets()).toBe(1);
    pressBack();
    expect(sheets()).toBe(0);
  });

  it("over a tall sheet takes no entry: Back closes it alone, and the tall sheet stays on its entry", () => {
    openTallSheet("Decide", body);
    openSheet("Reject", body);
    expect(stack).toHaveLength(2);
    pressBack();
    expect(sheets()).toBe(0);
    expect(talls()).toBe(1);
    expect(stack).toHaveLength(2);
  });

  it("leavePlainSheet runs what is next only once the sheet's Back has landed", () => {
    openSheet("Menu", body);
    const next = vi.fn();
    leavePlainSheet(next);
    expect(sheets()).toBe(0);
    expect(backs).toBe(1);
    expect(next).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(next).toHaveBeenCalledTimes(1);
    expect(stack).toEqual([null]);
    vi.runAllTimers();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("leavePlainSheet with no sheet up, or one over a tall sheet, runs at once", () => {
    const next = vi.fn();
    leavePlainSheet(next);
    expect(next).toHaveBeenCalledTimes(1);
    openTallSheet("Decide", body);
    openSheet("Reject", body);
    leavePlainSheet(next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(backs).toBe(0);
  });

  it("leavePlainSheet waits for the Back of a sheet closed a moment ago, still in flight", () => {
    openSheet("Menu", body);
    closeSheet();
    vi.advanceTimersByTime(1);
    expect(backs).toBe(1);
    const next = vi.fn();
    leavePlainSheet(next);
    expect(next).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(next).toHaveBeenCalledTimes(1);
    expect(stack).toEqual([null]);
  });

  it("leavePlainSheet takes the Back of a sheet closed in the same task, and waits for it", () => {
    openSheet("More", body);
    closeSheet();
    const next = vi.fn();
    leavePlainSheet(next);
    expect(backs).toBe(1);
    expect(next).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(next).toHaveBeenCalledTimes(1);
    expect(backs).toBe(1);
    expect(stack).toEqual([null]);
  });

  it("a tall sheet and a viewer do not take a stale entry for their own either", () => {
    openTallSheet("Decide", body);
    const old = stack[1];
    pressBack();
    stack = [null, old];
    openTallSheet("Decide", body);
    expect(stack[2]).not.toEqual(old);
    pressBack();
    expect(talls()).toBe(0);

    stack = [null];
    openText("Notes.txt", false, () => Promise.resolve("Hello"));
    const was = stack[1];
    pressBack();
    stack = [null, was];
    openText("Notes.txt", false, () => Promise.resolve("Hello"));
    pressBack();
    expect(document.querySelector(".lightbox")).toBeNull();
  });

  it("a stale entry an earlier load left is not taken for the sheet's own: Back onto it closes the sheet", () => {
    stack = [null, { sheet: 1 }, { sheet: "old.1" }];
    openSheet("Menu", body);
    pressBack();
    expect(sheets()).toBe(0);
  });

  it("a viewer over the sheet going back leaves the sheet up, and the sheet's own Back leaves a viewer under it up", () => {
    openSheet("Photos", body);
    openText("Notes.txt", false, () => Promise.resolve("Hello"));
    expect(stack).toHaveLength(3);
    pressBack();
    expect(document.querySelector(".lightbox")).toBeNull();
    expect(sheets()).toBe(1);
    pressBack();
    expect(sheets()).toBe(0);

    openText("Notes.txt", false, () => Promise.resolve("Hello"));
    openSheet("More", body);
    pressBack();
    expect(sheets()).toBe(0);
    expect(document.querySelector(".lightbox")).not.toBeNull();
  });
});
