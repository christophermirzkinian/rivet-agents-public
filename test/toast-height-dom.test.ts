// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearUndo, mountToasts, showUndo } from "../web/src/views/toast.js";

// The phone's Decide card steps down below the toasts, so toast.ts says where they end as --toasts-h.
describe("--toasts-h", () => {
  afterEach(() => {
    mountToasts(null);
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("is the toasts' bottom while one shows and 0 with none, and goes to 0 when unmounted", () => {
    const seen: Array<() => void> = [];
    const observed: Element[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          seen.push(callback);
        }
        observe(element: Element) {
          observed.push(element);
        }
        disconnect() {}
      },
    );
    const toasts = document.createElement("div");
    toasts.className = "toasts";
    document.body.append(toasts);
    let bottom = 86;
    toasts.getBoundingClientRect = () => ({ bottom }) as DOMRect;
    const say = () => document.documentElement.style.getPropertyValue("--toasts-h");

    mountToasts(toasts);
    expect(observed).toEqual([toasts]);
    expect(say()).toBe("0px");

    showUndo({ key: "a", verb: "Chose: Got it", title: "Fixed: the checks pass", tone: "yes", ms: 5000, onUndo: () => {} });
    seen[0]!();
    expect(say()).toBe("86px");

    bottom = 90.2;
    seen[0]!();
    expect(say()).toBe("91px");

    clearUndo("a");
    seen[0]!();
    expect(say()).toBe("0px");

    showUndo({ key: "b", verb: "Chose: Yes", title: "t", tone: "yes", ms: 5000, onUndo: () => {} });
    seen[0]!();
    expect(say()).toBe("91px");
    mountToasts(null);
    expect(say()).toBe("0px");
  });

  it("mounts without a ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const toasts = document.createElement("div");
    expect(() => mountToasts(toasts)).not.toThrow();
    expect(document.documentElement.style.getPropertyValue("--toasts-h")).toBe("0px");
  });
});
