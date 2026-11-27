// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_CHAT_TEXT } from "../src/shared/command.js";
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

  describe("Chat's saved draft (a-12)", () => {
    const kept = (items: Record<string, string>) => ({ getItem: (key: string) => items[key] ?? null });
    const chatBox = () => document.querySelector<HTMLTextAreaElement>("textarea.chat-text")!;

    beforeEach(() => {
      localStorage.clear();
      document.body.innerHTML = '<textarea class="chat-text"></textarea><textarea class="card-note"></textarea><ul class="attach-strip"></ul><ul class="attach-docs"></ul>';
    });

    it("reloads onto the new build over a draft that is saved, and never over one that is not", async () => {
      const check = watch();
      served = shell("/assets/index-NEW67890.js");
      chatBox().value = "left here on Tuesday";
      // Nothing saved, or other words saved: the box's words live only in the page.
      await away(check, AWAY_MS);
      localStorage.setItem("rivet.chat.draft", "left here on Monday");
      await away(check, AWAY_MS);
      expect(reloads).toBe(0);
      localStorage.setItem("rivet.chat.draft", "left here on Tuesday");
      await away(check, AWAY_MS);
      expect(reloads).toBe(1);
    });

    it("counts only Chat's box as saved: the same words in another box are unsent", () => {
      const saved = kept({ "rivet.chat.draft": "a note" });
      document.querySelector<HTMLTextAreaElement>(".card-note")!.value = "a note";
      expect(hasUnsent(document, saved)).toBe(true);
      document.querySelector<HTMLTextAreaElement>(".card-note")!.value = "";
      chatBox().value = "a note";
      expect(hasUnsent(document, saved)).toBe(false);
    });

    it("a draft over the limit is saved only when it is kept whole", () => {
      const long = "x".repeat(MAX_CHAT_TEXT + 5);
      chatBox().value = long;
      // A reload would cut it at the limit.
      expect(hasUnsent(document, kept({ "rivet.chat.draft": long }))).toBe(true);
      expect(hasUnsent(document, kept({ "rivet.chat.draft": long, "rivet.chat.draft.long": "1" }))).toBe(false);
    });

    it("a picked photo or file is unsent, with a saved draft or with no words at all", () => {
      const saved = kept({ "rivet.chat.draft": "with a photo" });
      chatBox().value = "with a photo";
      document.querySelector(".attach-strip")!.innerHTML = "<li></li>";
      expect(hasUnsent(document, saved)).toBe(true);
      chatBox().value = "";
      document.querySelector(".attach-strip")!.innerHTML = "";
      document.querySelector(".attach-docs")!.innerHTML = "<li></li>";
      expect(hasUnsent(document, kept({}))).toBe(true);
      document.querySelector(".attach-docs")!.innerHTML = "";
      expect(hasUnsent(document, kept({}))).toBe(false);
      // One that failed cannot be sent, so it holds no build back.
      document.querySelector(".attach-strip")!.innerHTML = "<li class=\"attach-tile failed\"></li>";
      expect(hasUnsent(document, kept({}))).toBe(false);
      document.querySelector(".attach-strip")!.innerHTML = "<li class=\"attach-tile failed\"></li><li class=\"attach-tile\"></li>";
      expect(hasUnsent(document, kept({}))).toBe(true);
    });

    it("a saved draft whose send is out or went unanswered is unsent: a reload would send it twice", () => {
      const saved = kept({ "rivet.chat.draft": "Ship it" });
      chatBox().value = "Ship it";
      const asked: string[] = [];
      expect(hasUnsent(document, saved, (words) => (asked.push(words), true))).toBe(true);
      expect(asked).toEqual(["Ship it"]);
      expect(hasUnsent(document, saved, () => false)).toBe(false);
    });

    it("storage that cannot be read saves nothing", () => {
      chatBox().value = "left here";
      const broken = { getItem: () => { throw new Error("denied"); } };
      expect(hasUnsent(document, broken)).toBe(true);
      expect(hasUnsent(document, null)).toBe(true);
    });
  });
});
