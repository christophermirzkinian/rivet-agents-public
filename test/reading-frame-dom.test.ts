// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import { clock } from "../src/shared/when.js";
import { h } from "../web/src/dom.js";
import { readingFrame, readingView, type Reading } from "../web/src/views/reading.js";

// The reading pages' one frame: a shimmer while the first read is out, Rivet and Try again when it fails with
// nothing to show, the last figures under one plain line when a refresh fails, and "Updated" with Refresh at the foot.

const AT = Date.parse("2026-11-10T03:02:00Z");
const frame = (over: Partial<Reading> = {}) =>
  readingFrame({ page: "Usage", has: true, failed: false, busy: false, at: AT, shape: [100, 50], retry: () => {}, ...over }, () => [h("p", { class: "figure" }, "0.3 of 5 left")]);

describe("the reading frame's states", () => {
  it("is pending until something is read, and failed only once a read came back failed", () => {
    expect(readingView({ has: false, failed: false, busy: true })).toEqual({ body: "pending", stale: false, dim: false });
    expect(readingView({ has: false, failed: true, busy: false })).toEqual({ body: "failed", stale: false, dim: false });
    // Try again shows the shimmer again, not the failure, while it reads.
    expect(readingView({ has: false, failed: true, busy: true }).body).toBe("pending");
    expect(readingView({ has: true, failed: false, busy: false })).toEqual({ body: "figures", stale: false, dim: false });
    expect(readingView({ has: true, failed: true, busy: false })).toEqual({ body: "figures", stale: true, dim: false });
    expect(readingView({ has: true, failed: false, busy: true })).toEqual({ body: "figures", stale: false, dim: true });
  });
});

describe("the reading frame", () => {
  it("shows a shimmer at the page's shape while the first read is out, and no figures", () => {
    const el = frame({ has: false, busy: true });
    expect(el.classList.contains("is-pending")).toBe(true);
    expect(el.getAttribute("aria-label")).toBe("Reading Usage…");
    expect([...el.querySelectorAll<HTMLElement>(".reading-skel")].map((block) => block.style.height)).toEqual(["100px", "50px"]);
    expect(el.querySelector(".figure")).toBeNull();
    expect(el.textContent).not.toMatch(/offline|Waiting for/);
  });

  it("shows Rivet, Couldn't load and Try again when the first read fails", () => {
    const retry = vi.fn();
    const el = frame({ has: false, failed: true, retry });
    expect(el.querySelector(".reading-failed .reading-face")).not.toBeNull();
    expect(el.querySelector(".reading-failed-words")!.textContent).toBe("Couldn't load Usage.");
    el.querySelector<HTMLButtonElement>(".reading-btn")!.click();
    expect(retry).toHaveBeenCalledOnce();
    expect(el.textContent).not.toMatch(/Request failed|Pull to try again/);
  });

  it("keeps the last figures under one plain line when a refresh fails", () => {
    const el = frame({ failed: true });
    expect(el.querySelector(".reading-stale")!.textContent).toBe("Couldn't refresh. These are the last numbers read.");
    expect(el.querySelector(".figure")).not.toBeNull();
  });

  it("says when the figures were read, with Refresh, and dims them while a read is out", () => {
    const retry = vi.fn();
    const el = frame({ retry });
    expect(el.querySelector(".reading-at")!.textContent).toBe(`Updated ${clock(AT)}`);
    el.querySelector<HTMLButtonElement>(".reading-foot .reading-btn")!.click();
    expect(retry).toHaveBeenCalledOnce();
    expect(el.classList.contains("is-busy")).toBe(false);
    const busy = frame({ busy: true });
    expect(busy.classList.contains("is-busy")).toBe(true);
    expect(busy.querySelector<HTMLButtonElement>(".reading-foot .reading-btn")!.textContent).toBe("Refreshing…");
    expect(busy.querySelector<HTMLButtonElement>(".reading-foot .reading-btn")!.disabled).toBe(true);
  });
});
