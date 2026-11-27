// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REPLY_STYLE_ID, TEXT_SIZE_ID, type BehaviourRow } from "../src/shared/behaviours.js";
import * as api from "../web/src/api.js";
import { endSession, StaleSession } from "../web/src/session.js";
import { loadBehaviours } from "../web/src/views/behaviours.js";
import { cacheChatPref, chatPicksMark, loadChatPrefs, repaintAfterList } from "../web/src/views/chat-prefs.js";
import { chatReplyStylePicker, readChatReplyStyle, replyStyleField, setChatReplyStyle } from "../web/src/views/chat-reply-style.js";
import { chatTextSizePicker, readChatTextSize, setChatTextSize } from "../web/src/views/chat-text-size.js";
import { flash } from "../web/src/views/toast.js";

vi.mock("../web/src/api.js", () => ({ getBehaviours: vi.fn(), getChatSendDelay: vi.fn(), putBehaviour: vi.fn(), ApiError: class extends Error {} }));
vi.mock("../web/src/views/toast.js", () => ({ flash: vi.fn() }));

function row(id: string, value: Record<string, unknown>, updatedAt: string | null = "2026-11-27T00:00:00.000Z"): BehaviourRow {
  return { id, value, updatedAt, group: "Chat", name: id, line: "Chat preference", scope: "all", control: "live", chip: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function pickStyle(style: string): void {
  const picker = chatReplyStylePicker();
  document.body.append(picker);
  picker.querySelector<HTMLButtonElement>(`[data-use="chat.reply-style.${style}"]`)!.click();
}

beforeEach(() => {
  endSession();
  vi.resetAllMocks();
  setChatReplyStyle("normal");
  setChatTextSize("m");
  localStorage.clear();
  document.body.replaceChildren();
  vi.mocked(api.putBehaviour).mockImplementation(async (id, value) => row(id, value));
});

afterEach(() => document.body.replaceChildren());

describe("Chat preference loads racing with local picks", () => {
  it("keeps a reply style picked after the load started and still syncs untouched text size", async () => {
    const answer = deferred<Awaited<ReturnType<typeof api.getBehaviours>>>();
    vi.mocked(api.getBehaviours).mockReturnValueOnce(answer.promise);
    const loading = loadChatPrefs();

    pickStyle("detailed");
    expect(api.putBehaviour).toHaveBeenCalledWith(REPLY_STYLE_ID, { style: "detailed" });
    answer.resolve({ behaviours: [row(REPLY_STYLE_ID, { style: "short" }), row(TEXT_SIZE_ID, { size: "l" })] });
    await loading;

    expect(replyStyleField()).toEqual({ replyStyle: "detailed" });
    expect(localStorage.getItem("rivet.chat.replyStyle")).toBe("detailed");
    expect(document.querySelector('[data-use="chat.reply-style.detailed"]')!.getAttribute("aria-checked")).toBe("true");
    expect(readChatTextSize()).toBe("l");
    expect(document.documentElement.dataset.chatText).toBe("l");
  });

  it("keeps a text size picked after the load started", async () => {
    const answer = deferred<Awaited<ReturnType<typeof api.getBehaviours>>>();
    vi.mocked(api.getBehaviours).mockReturnValueOnce(answer.promise);
    const loading = loadChatPrefs();
    const picker = chatTextSizePicker();
    document.body.append(picker);
    picker.querySelector<HTMLButtonElement>('[data-use="chat.text-size.s"]')!.click();
    answer.resolve({ behaviours: [row(TEXT_SIZE_ID, { size: "l" })] });
    await loading;

    expect(readChatTextSize()).toBe("s");
    expect(localStorage.getItem("rivet.chat.textSize")).toBe("s");
    expect(document.documentElement.dataset.chatText).toBe("s");
  });

  it("keeps a Settings save cached after the load started", async () => {
    const answer = deferred<Awaited<ReturnType<typeof api.getBehaviours>>>();
    vi.mocked(api.getBehaviours).mockReturnValueOnce(answer.promise);
    const loading = loadChatPrefs();
    cacheChatPref(row(REPLY_STYLE_ID, { style: "detailed" }));
    answer.resolve({ behaviours: [row(REPLY_STYLE_ID, { style: "short" })] });
    await loading;

    expect(replyStyleField()).toEqual({ replyStyle: "detailed" });
  });

  it("keeps a newer pick while a failed save's reload is pending", async () => {
    const answer = deferred<Awaited<ReturnType<typeof api.getBehaviours>>>();
    vi.mocked(api.getBehaviours).mockReturnValueOnce(answer.promise);
    vi.mocked(api.putBehaviour).mockRejectedValueOnce(new Error("offline"));
    pickStyle("short");
    await vi.waitFor(() => expect(api.getBehaviours).toHaveBeenCalledOnce());

    pickStyle("detailed");
    const repainted = deferred<void>();
    const el = document.createElement("div");
    document.body.append(el);
    repaintAfterList(el, () => repainted.resolve());
    answer.resolve({ behaviours: [row(REPLY_STYLE_ID, { style: "normal" })] });
    await repainted.promise;

    expect(flash).toHaveBeenCalledWith("Couldn't save the reply style. Try again.", "error");
    expect(replyStyleField()).toEqual({ replyStyle: "detailed" });
  });

  it("does not migrate an old list's empty row after a new pick was saved", async () => {
    const answer = deferred<Awaited<ReturnType<typeof api.getBehaviours>>>();
    vi.mocked(api.getBehaviours).mockReturnValueOnce(answer.promise);
    const loading = loadChatPrefs();
    pickStyle("detailed");
    answer.resolve({ behaviours: [row(REPLY_STYLE_ID, { style: "normal" }, null)] });
    await loading;

    expect(api.putBehaviour).toHaveBeenCalledTimes(1);
    expect(readChatReplyStyle()).toBe("detailed");
  });

  it("keeps a Chat pick made while Settings' list is out", async () => {
    const answer = deferred<Awaited<ReturnType<typeof api.getBehaviours>>>();
    vi.mocked(api.getBehaviours).mockReturnValueOnce(answer.promise);
    const loading = loadBehaviours();
    pickStyle("detailed");
    answer.resolve({ behaviours: [row(REPLY_STYLE_ID, { style: "short" })] });
    await loading;

    expect(replyStyleField()).toEqual({ replyStyle: "detailed" });
  });

  it("keeps a pick whose save is still out when another save's failure reloads", async () => {
    const sizeSaved = deferred<BehaviourRow>();
    vi.mocked(api.putBehaviour).mockImplementation((id, value) => (id === TEXT_SIZE_ID ? sizeSaved.promise : Promise.reject(new Error("offline"))));
    const picker = chatTextSizePicker();
    document.body.append(picker);
    picker.querySelector<HTMLButtonElement>('[data-use="chat.text-size.l"]')!.click();
    const answer = deferred<Awaited<ReturnType<typeof api.getBehaviours>>>();
    vi.mocked(api.getBehaviours).mockReturnValueOnce(answer.promise);
    pickStyle("short");
    await vi.waitFor(() => expect(api.getBehaviours).toHaveBeenCalledOnce());

    const repainted = deferred<void>();
    const el = document.createElement("div");
    document.body.append(el);
    repaintAfterList(el, () => repainted.resolve());
    answer.resolve({ behaviours: [row(TEXT_SIZE_ID, { size: "m" })] });
    await repainted.promise;

    expect(readChatTextSize()).toBe("l");
    sizeSaved.resolve(row(TEXT_SIZE_ID, { size: "l" }));
  });

  it("says nothing and reloads nothing when a save answers after sign-out", async () => {
    vi.mocked(api.putBehaviour).mockRejectedValueOnce(new StaleSession());
    pickStyle("short");
    await new Promise((done) => setTimeout(done, 0));

    expect(flash).not.toHaveBeenCalled();
    expect(api.getBehaviours).not.toHaveBeenCalled();
  });

  it("keeps a pick whose save landed before a list sent while it was out answers", async () => {
    const saved = deferred<BehaviourRow>();
    vi.mocked(api.putBehaviour).mockReturnValueOnce(saved.promise);
    pickStyle("detailed");
    const answer = deferred<Awaited<ReturnType<typeof api.getBehaviours>>>();
    vi.mocked(api.getBehaviours).mockReturnValueOnce(answer.promise);
    const loading = loadChatPrefs();
    saved.resolve(row(REPLY_STYLE_ID, { style: "detailed" }));
    await new Promise((done) => setTimeout(done, 0));
    // The list was read before the save reached the store.
    answer.resolve({ behaviours: [row(REPLY_STYLE_ID, { style: "normal" })] });
    await loading;

    expect(replyStyleField()).toEqual({ replyStyle: "detailed" });
  });

  it("does not cache a Settings save answer sent before a newer Chat pick", async () => {
    const sentAt = chatPicksMark();
    pickStyle("detailed");
    await new Promise((done) => setTimeout(done, 0));
    cacheChatPref(row(REPLY_STYLE_ID, { style: "short" }), sentAt);

    expect(replyStyleField()).toEqual({ replyStyle: "detailed" });
  });

  it("caches a Settings save sent after a Chat pick, whichever answers first", async () => {
    for (const chatFirst of [true, false]) {
      setChatReplyStyle("normal");
      const chatSaved = deferred<BehaviourRow>();
      vi.mocked(api.putBehaviour).mockReturnValueOnce(chatSaved.promise);
      pickStyle("short");
      const sentAt = chatPicksMark();
      if (chatFirst) chatSaved.resolve(row(REPLY_STYLE_ID, { style: "short" }));
      await new Promise((done) => setTimeout(done, 0));
      cacheChatPref(row(REPLY_STYLE_ID, { style: "detailed" }), sentAt);
      chatSaved.resolve(row(REPLY_STYLE_ID, { style: "short" }));
      await new Promise((done) => setTimeout(done, 0));

      expect(replyStyleField(), `Chat answered first: ${chatFirst}`).toEqual({ replyStyle: "detailed" });
    }
  });

  it("lets the next session's first list through while the last session's save is out", async () => {
    const oldSave = deferred<BehaviourRow>();
    vi.mocked(api.putBehaviour).mockReturnValueOnce(oldSave.promise);
    pickStyle("short");
    endSession();
    vi.mocked(api.getBehaviours).mockResolvedValueOnce({ behaviours: [row(REPLY_STYLE_ID, { style: "detailed" })] });
    await loadChatPrefs();

    expect(replyStyleField()).toEqual({ replyStyle: "detailed" });
  });
});
