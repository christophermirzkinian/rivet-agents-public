// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachPullRefresh, PULL_THRESHOLD, resist, type PullRefresh } from "../web/src/pull-refresh.js";

let host: HTMLElement;
let scroller: HTMLElement;
let inner: HTMLElement;
let refresh: ReturnType<typeof vi.fn>;
let pullRefresh: PullRefresh;

function touch(target: Element, type: "touchstart" | "touchmove" | "touchend" | "touchcancel", x = 0, y = 0, fingers = 1): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const touches = type === "touchend" || type === "touchcancel" ? [] : Array.from({ length: fingers }, (_, i) => ({ clientX: x + i * 60, clientY: y }));
  Object.defineProperty(event, "touches", { value: touches });
  target.dispatchEvent(event);
  return event;
}

/** A finger from (x, y) straight down by `dy`, in steps, then lifted. Returns the first move. */
function pull(target: Element, dy: number, { x = 100, y = 100, dx = 0 } = {}): Event {
  touch(target, "touchstart", x, y);
  const first = touch(target, "touchmove", x + dx / 10, y + dy / 10);
  for (let step = 2; step <= 10; step++) touch(target, "touchmove", x + (dx * step) / 10, y + (dy * step) / 10);
  touch(target, "touchend");
  return first;
}

function scrolled(element: HTMLElement, top: number): void {
  Object.defineProperty(element, "scrollTop", { value: top, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  host = document.createElement("div");
  scroller = document.createElement("main");
  inner = document.createElement("div");
  inner.className = "card-body";
  inner.append(document.createElement("p"));
  scroller.append(
    inner,
    document.createElement("textarea"),
    document.createElement("canvas"),
    Object.assign(document.createElement("div"), { className: "sheet" }),
    Object.assign(document.createElement("div"), { className: "strip" }),
  );
  host.append(scroller);
  document.body.replaceChildren(host);
  refresh = vi.fn(() => Promise.resolve());
  pullRefresh = attachPullRefresh(scroller, host, refresh);
});

afterEach(() => {
  pullRefresh.detach();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pull to refresh", () => {
  it("resists: the content moves less than the finger, and about 110 px of finger reaches the threshold", () => {
    expect(resist(-20)).toBe(0);
    expect(resist(40)).toBeLessThan(40);
    expect(resist(100)).toBeLessThan(PULL_THRESHOLD);
    expect(resist(120)).toBeGreaterThan(PULL_THRESHOLD);
    expect(resist(10_000)).toBeLessThan(200);
  });

  it("refreshes once on a release past the threshold, with the spinner up until it is done", async () => {
    let done!: () => void;
    refresh.mockImplementation(() => new Promise<void>((resolve) => (done = resolve)));
    const first = pull(scroller.querySelector("p")!, 240);
    expect(first.defaultPrevented).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    const spinner = host.querySelector(".ptr")!;
    expect(spinner.classList.contains("spinning")).toBe(true);

    // A second pull while it runs does not start another refresh.
    pull(scroller, 240);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(spinner.classList.contains("spinning")).toBe(true);

    done();
    await vi.advanceTimersByTimeAsync(0);
    expect(spinner.classList.contains("spinning")).toBe(false);
    expect(scroller.style.transform).toBe("");
  });

  it("does nothing on a short pull, or when the finger comes back up before release", async () => {
    pull(scroller, 80);
    touch(scroller, "touchstart", 100, 100);
    touch(scroller, "touchmove", 100, 300);
    touch(scroller, "touchmove", 100, 110);
    touch(scroller, "touchend");
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("starts only with the scroll container at its top", async () => {
    scrolled(scroller, 40);
    const first = pull(scroller, 300);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).not.toHaveBeenCalled();
    expect(first.defaultPrevented).toBe(false);
  });

  it("ignores a mostly sideways gesture, even one that later turns downwards", async () => {
    touch(scroller, "touchstart", 100, 100);
    const first = touch(scroller, "touchmove", 130, 110);
    touch(scroller, "touchmove", 140, 400);
    touch(scroller, "touchend");
    pull(scroller.querySelector(".strip")!, 60, { dx: 200 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(first.defaultPrevented).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("never takes a gesture from an inner scroll area, a text box, a sheet or the 3D canvas", async () => {
    scrolled(inner, 30);
    for (const target of [inner.querySelector("p")!, scroller.querySelector("textarea")!, scroller.querySelector("canvas")!, scroller.querySelector(".sheet")!]) {
      expect(pull(target, 300).defaultPrevented).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).not.toHaveBeenCalled();
    expect(scroller.style.transform).toBe("");
  });

  it("an upward drag is left to the page's own scroll", async () => {
    const first = pull(scroller, -300);
    await vi.advanceTimersByTimeAsync(1000);
    expect(first.defaultPrevented).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a cancelled touch never refreshes and puts the content back", async () => {
    touch(scroller, "touchstart", 100, 100);
    touch(scroller, "touchmove", 100, 400);
    expect(scroller.style.transform).not.toBe("");
    touch(scroller, "touchcancel");
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).not.toHaveBeenCalled();
    expect(scroller.style.transform).toBe("");
    expect(host.querySelector(".ptr")!.classList.contains("shown")).toBe(false);
  });

  it("a second finger mid-pull puts the content back, and lifting never refreshes", async () => {
    touch(scroller, "touchstart", 100, 100);
    touch(scroller, "touchmove", 100, 250);
    touch(scroller, "touchmove", 100, 400);
    expect(scroller.style.transform).not.toBe("");
    touch(scroller, "touchstart", 100, 400, 2);
    expect(scroller.style.transform).toBe("");
    touch(scroller, "touchmove", 100, 500, 2);
    touch(scroller, "touchend");
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).not.toHaveBeenCalled();
    expect(scroller.style.transform).toBe("");
    expect(host.querySelector(".ptr")!.classList.contains("shown")).toBe(false);

    // A second finger arriving on a move does the same.
    touch(scroller, "touchstart", 100, 100);
    touch(scroller, "touchmove", 100, 300);
    touch(scroller, "touchmove", 100, 400, 2);
    expect(scroller.style.transform).toBe("");
    touch(scroller, "touchend");
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("reset() mid-pull or mid-refresh leaves the content at rest, and the refresh ending later changes nothing", async () => {
    touch(scroller, "touchstart", 100, 100);
    touch(scroller, "touchmove", 100, 300);
    pullRefresh.reset();
    expect(scroller.style.transform).toBe("");
    touch(scroller, "touchend");
    expect(refresh).not.toHaveBeenCalled();

    let done!: () => void;
    refresh.mockImplementation(() => new Promise<void>((resolve) => (done = resolve)));
    pull(scroller, 300);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector(".ptr")!.classList.contains("spinning")).toBe(true);
    pullRefresh.reset();
    expect(scroller.style.transform).toBe("");
    expect(host.querySelector(".ptr")!.classList.contains("spinning")).toBe(false);
    // The next pull works while the first refresh is still out.
    pull(scroller, 300);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    done();
    await vi.advanceTimersByTimeAsync(1000);
    expect(scroller.style.transform).toBe("");
  });

  it("keeps the content still under reduced motion and still refreshes", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query }));
    touch(scroller, "touchstart", 100, 100);
    touch(scroller, "touchmove", 100, 200);
    touch(scroller, "touchmove", 100, 360);
    expect(scroller.style.transform).toBe("");
    expect(host.querySelector(".ptr")!.classList.contains("armed")).toBe(true);
    touch(scroller, "touchend");
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("holds a cancelable touchmove only while the scroller is at its top, so a scroll from further down never waits", () => {
    const add = vi.spyOn(scroller, "addEventListener");
    const remove = vi.spyOn(scroller, "removeEventListener");
    scrolled(scroller, 300);
    scroller.dispatchEvent(new Event("scroll"));
    expect(remove).toHaveBeenCalledWith("touchmove", expect.any(Function));
    scrolled(scroller, 0);
    scroller.dispatchEvent(new Event("scroll"));
    expect(add).toHaveBeenCalledWith("touchmove", expect.any(Function), { passive: false });
    // Back at the top the pull works again.
    expect(pull(scroller.querySelector("p")!, 240).defaultPrevented).toBe(true);
  });
});
