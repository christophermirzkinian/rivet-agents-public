// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { AWAY_MS, hasUnsent, mainScript, watchNewBuild } from "../web/src/new-build.js";

const shell = (entry: string) => `<!doctype html><link rel="stylesheet" href="/assets/index-a1.css"><script type="module" crossorigin src="${entry}"></script>`;

describe("new build on return", () => {
  let clock = 0;
  let visibility: DocumentVisibilityState = "visible";
  let served = shell("/assets/index-OLD12345.js");
  let reloads = 0;
  let fetched: RequestInit[] = [];

  beforeEach(() => {
    clock = 0;
    visibility = "visible";
    served = shell("/assets/index-OLD12345.js");
    reloads = 0;
    fetched = [];
    document.body.innerHTML = '<textarea></textarea><div contenteditable="true"></div>';
    document.head.innerHTML = '<script type="module" src="/assets/index-OLD12345.js"></script>';
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  });

  const watch = () =>
    watchNewBuild({
      fetch: (async (_url: string, init: RequestInit) => {
        fetched.push(init);
        return new Response(served, { status: 200 });
      }) as typeof fetch,
      reload: () => (reloads += 1),
      now: () => clock,
    });
  const away = async (check: () => Promise<void>, ms: number) => {
    visibility = "hidden";
    await check();
    clock += ms;
    visibility = "visible";
    await check();
  };

  it("reads the shell's main script", () => {
    expect(mainScript(shell("/assets/index-NEW.js"))).toBe("/assets/index-NEW.js");
    expect(mainScript('<script src="/legacy.js"></script>')).toBeNull();
  });

  it("reloads after five minutes away when the shell names another build, asking past every cache", async () => {
    const check = watch();
    served = shell("/assets/index-NEW67890.js");
    await away(check, AWAY_MS);
    expect(reloads).toBe(1);
    expect(fetched[0]?.cache).toBe("no-store");
  });

  it("does not look after a short absence, nor reload onto the same build", async () => {
    const check = watch();
    served = shell("/assets/index-NEW67890.js");
    await away(check, AWAY_MS - 1);
    expect(fetched).toHaveLength(0);
    served = shell("/assets/index-OLD12345.js");
    await away(check, AWAY_MS);
    expect(reloads).toBe(0);
  });

  it("never reloads over unsent text", async () => {
    const check = watch();
    served = shell("/assets/index-NEW67890.js");
    document.querySelector("textarea")!.value = "half a message";
    expect(hasUnsent(document)).toBe(true);
    await away(check, AWAY_MS);
    expect(reloads).toBe(0);
    document.querySelector("textarea")!.value = "  ";
    document.querySelector("[contenteditable]")!.textContent = "a note";
    expect(hasUnsent(document)).toBe(true);
    document.querySelector("[contenteditable]")!.textContent = "";
    await away(check, AWAY_MS);
    expect(reloads).toBe(1);
  });
});
