// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatSendDelay } from "../src/shared/command.js";
import { ApiError } from "../web/src/api.js";
import { endSession, StaleSession } from "../web/src/session.js";
import { chatSendDelayRow, sendDelayNote } from "../web/src/views/chat-send-delay.js";

const api = vi.hoisted(() => ({
  get: vi.fn<() => Promise<ChatSendDelay>>(),
  put: vi.fn<(delay: ChatSendDelay) => Promise<ChatSendDelay>>(),
  flash: vi.fn(),
}));
vi.mock("../web/src/command-api.js", async () => {
  const actual: object = await vi.importActual("../web/src/command-api.js");
  return { ...actual, getChatSendDelay: api.get, putChatSendDelay: api.put };
});
/** No answer came back: the save may have landed. */
const lost = () => new ApiError(0, "offline");
vi.mock("../web/src/views/toast.js", () => ({ flash: api.flash }));


const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Chat's Send delay row", () => {
  let row: ReturnType<typeof chatSendDelayRow>;
  const toggle = () => row.el.querySelector<HTMLButtonElement>('[data-use="chat.send-delay.toggle"]')!;
  const seconds = (n: number) => row.el.querySelector<HTMLButtonElement>(`[data-use="chat.send-delay.${n}"]`)!;
  const picked = () => [3, 5, 7, 10].filter((n) => seconds(n).getAttribute("aria-checked") === "true");
  const note = () => row.el.querySelector(".chat-delay-note")!.textContent;

  beforeEach(() => {
    api.get.mockReset();
    api.put.mockReset();
    api.flash.mockReset();
    row = chatSendDelayRow();
    document.body.append(row.el);
  });

  afterEach(() => row.el.remove());

  it("shows On at 10 s before the server answers, then what the server holds on each open", async () => {
    expect([toggle().getAttribute("aria-checked"), picked(), note()]).toEqual(["true", [10], sendDelayNote({ on: true, seconds: 10 })]);
    api.get.mockResolvedValue({ on: true, seconds: 5 });
    row.refresh();
    await settle();
    expect(picked()).toEqual([5]);
    api.get.mockResolvedValue({ on: false, seconds: 5 });
    row.refresh();
    await settle();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    // Off still marks the kept seconds, greyed, so it shows what On brings back.
    expect(picked()).toEqual([5]);
    expect([3, 5, 7, 10].every((n) => seconds(n).disabled)).toBe(true);
    expect(note()).toMatch(/^Off: each message goes to .+ at once, with no Cancel\.$/);
  });

  it("a tap saves at once; a seconds tap turns it back On; a failed save puts the server's value back and says so", async () => {
    api.get.mockResolvedValue({ on: true, seconds: 10 });
    row.refresh();
    await settle();
    api.put.mockImplementation(async (delay) => delay);
    toggle().click();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    await settle();
    expect(api.put).toHaveBeenLastCalledWith({ on: false, seconds: 10 });
    toggle().click();
    await settle();
    seconds(3).click();
    await settle();
    expect(api.put).toHaveBeenLastCalledWith({ on: true, seconds: 3 });
    expect(picked()).toEqual([3]);
    expect(note()).toMatch(/^Gives you a few seconds to cancel or edit a message before it goes to .+\.$/);

    api.put.mockRejectedValue(lost());
    // The save's answer is lost, so the row asks: the server still holds 3 s.
    api.get.mockResolvedValue({ on: true, seconds: 3 });
    seconds(7).click();
    expect(picked()).toEqual([7]);
    await settle();
    expect(picked()).toEqual([3]);
    expect(api.flash).toHaveBeenCalledWith("Send delay didn't save. Try again.", "error");

    // The server can't be asked either: back to the last value it answered with.
    api.flash.mockReset();
    api.get.mockRejectedValue(new Error("offline"));
    seconds(5).click();
    await settle();
    expect(picked()).toEqual([3]);
    expect(api.flash).toHaveBeenCalledWith("Send delay didn't save. Try again.", "error");
  });

  it("a save whose answer is lost but which landed shows what the server holds and says nothing", async () => {
    api.get.mockResolvedValue({ on: true, seconds: 10 });
    row.refresh();
    await settle();
    api.put.mockRejectedValue(new ApiError(504, "timed out"));
    api.get.mockResolvedValue({ on: false, seconds: 10 });
    toggle().click();
    await settle();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(api.flash).not.toHaveBeenCalled();
    // It is never sent again: another writer (Settings › Behaviours) may have saved a newer value since.
    expect(api.put).toHaveBeenCalledTimes(1);
  });

  it("a signed-out save or read goes to authFail, with no toast", async () => {
    const authFail = vi.fn(() => true);
    const signed = chatSendDelayRow({ authFail });
    api.get.mockResolvedValue({ on: true, seconds: 10 });
    signed.refresh();
    await settle();
    const expired = new Error("401");
    api.put.mockRejectedValue(expired);
    const pick = (n: number) => signed.el.querySelector<HTMLButtonElement>(`[data-use="chat.send-delay.${n}"]`)!;
    // Two quick taps: the second, queued behind the 401, never goes, and the row goes back to what the server holds.
    pick(3).click();
    pick(7).click();
    await settle();
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(pick(10).getAttribute("aria-checked")).toBe("true");
    api.get.mockRejectedValue(expired);
    signed.refresh();
    await settle();
    expect(authFail.mock.calls).toEqual([[expired], [expired]]);
    expect(api.flash).not.toHaveBeenCalled();
  });

  it("stays shut until the server has answered once, so the row's default never overwrites the saved value", async () => {
    expect([toggle().disabled, seconds(3).disabled]).toEqual([true, true]);
    let answerRead!: (delay: ChatSendDelay) => void;
    api.get.mockReturnValue(new Promise((resolve) => (answerRead = resolve)));
    row.refresh();
    toggle().click();
    await settle();
    expect(api.put).not.toHaveBeenCalled();
    answerRead({ on: true, seconds: 5 });
    await settle();
    expect([toggle().disabled, seconds(3).disabled, picked()]).toEqual([false, false, [5]]);

    // A first read that fails keeps it shut and says so; an older read failing never opens it while a newer one is out.
    const fresh = chatSendDelayRow();
    const freshToggle = () => fresh.el.querySelector<HTMLButtonElement>('[data-use="chat.send-delay.toggle"]')!;
    let failOlder!: (error: Error) => void;
    api.get.mockReturnValueOnce(new Promise((_, reject) => (failOlder = reject)));
    let answerNewer!: (delay: ChatSendDelay) => void;
    api.get.mockReturnValueOnce(new Promise((resolve) => (answerNewer = resolve)));
    fresh.refresh();
    fresh.refresh();
    failOlder(new Error("offline"));
    await settle();
    expect(freshToggle().disabled).toBe(true);
    answerNewer({ on: false, seconds: 3 });
    await settle();
    expect([freshToggle().disabled, freshToggle().getAttribute("aria-checked")]).toEqual([false, "false"]);

    // The other way round: the newer read fails, then the older one answers. Any answer beats none.
    const late = chatSendDelayRow();
    const lateToggle = () => late.el.querySelector<HTMLButtonElement>('[data-use="chat.send-delay.toggle"]')!;
    let answerOlder!: (delay: ChatSendDelay) => void;
    api.get.mockReturnValueOnce(new Promise((resolve) => (answerOlder = resolve)));
    api.get.mockReturnValueOnce(Promise.reject(new Error("offline")));
    late.refresh();
    late.refresh();
    await settle();
    expect(lateToggle().disabled).toBe(true);
    answerOlder({ on: true, seconds: 7 });
    await settle();
    expect(lateToggle().disabled).toBe(false);

    const offline = chatSendDelayRow();
    api.get.mockRejectedValue(new Error("offline"));
    offline.refresh();
    await settle();
    expect(offline.el.querySelector<HTMLButtonElement>('[data-use="chat.send-delay.toggle"]')!.disabled).toBe(true);
    expect(offline.el.querySelector(".chat-delay-note")!.textContent).toBe("Send delay couldn't be read. Close this menu and open it again.");
  });

  it("an older read never paints over a newer pick, and a read waits out a save on its way", async () => {
    api.get.mockResolvedValue({ on: true, seconds: 10 });
    row.refresh();
    await settle();
    let answerRead!: (delay: ChatSendDelay) => void;
    api.get.mockReturnValue(new Promise((resolve) => (answerRead = resolve)));
    let answerPut!: (delay: ChatSendDelay) => void;
    api.put.mockReturnValue(new Promise((resolve) => (answerPut = resolve)));
    row.refresh();
    seconds(5).click();
    answerRead({ on: true, seconds: 10 });
    await settle();
    expect(picked()).toEqual([5]);
    // The menu opens again with the save still out: no read, and the save's answer paints.
    api.get.mockClear();
    row.refresh();
    expect(api.get).not.toHaveBeenCalled();
    answerPut({ on: true, seconds: 5 });
    await settle();
    expect(picked()).toEqual([5]);

    // A read that went out before a save that has since finished never paints over it.
    let answerStale!: (delay: ChatSendDelay) => void;
    api.get.mockReturnValue(new Promise((resolve) => (answerStale = resolve)));
    api.put.mockImplementation(async (delay) => delay);
    row.refresh();
    seconds(7).click();
    await settle();
    expect(picked()).toEqual([7]);
    answerStale({ on: true, seconds: 5 });
    await settle();
    expect(picked()).toEqual([7]);
  });

  it("saves go one at a time in tap order; a lost answer asks the server; only the newest pick's failure says so", async () => {
    api.get.mockResolvedValue({ on: true, seconds: 10 });
    row.refresh();
    await settle();
    const answers: Array<{ resolve: (delay: ChatSendDelay) => void; reject: (error: Error) => void }> = [];
    api.put.mockImplementation(() => new Promise((resolve, reject) => answers.push({ resolve, reject })));
    // Quick taps: a pick replaced before its turn never goes.
    seconds(3).click();
    seconds(5).click();
    await settle();
    expect(api.put.mock.calls).toEqual([[{ on: true, seconds: 5 }]]);
    answers[0]!.resolve({ on: true, seconds: 5 });
    await settle();

    // 3 s goes out, then 7 s is tapped behind it.
    seconds(3).click();
    await settle();
    seconds(7).click();
    // 3 s: the answer is lost, but 7 s is already waiting, so 3 s isn't sent again and says nothing; 7 s goes next.
    answers[1]!.reject(lost());
    await settle();
    expect(api.put.mock.calls.slice(1)).toEqual([[{ on: true, seconds: 3 }], [{ on: true, seconds: 7 }]]);
    expect(api.flash).not.toHaveBeenCalled();
    expect(picked()).toEqual([7]);
    // 7 s, the newest: its answer is lost and it isn't sent again; the server can't be asked either, so it goes back
    // to 5 s and says so.
    api.get.mockRejectedValue(lost());
    answers[2]!.reject(lost());
    await settle();
    expect(api.put).toHaveBeenCalledTimes(3);
    expect(picked()).toEqual([5]);
    expect(api.flash).toHaveBeenCalledWith("Send delay didn't save. Try again.", "error");
  });

  it("a refused save is final: no second send and no read; a changed session stops quietly", async () => {
    api.get.mockResolvedValue({ on: true, seconds: 10 });
    row.refresh();
    await settle();
    api.get.mockClear();
    api.put.mockRejectedValue(new ApiError(403, "forbidden"));
    seconds(3).click();
    await settle();
    expect([api.put.mock.calls.length, api.get.mock.calls.length, picked()]).toEqual([1, 0, [10]]);
    expect(api.flash).toHaveBeenCalledWith("Send delay didn't save. Try again.", "error");

    api.flash.mockReset();
    api.put.mockReset();
    api.put.mockRejectedValue(new StaleSession());
    seconds(5).click();
    await settle();
    expect([api.put.mock.calls.length, api.get.mock.calls.length, picked()]).toEqual([1, 0, [10]]);
    expect(api.flash).not.toHaveBeenCalled();
  });

  it("a row Chat has rebuilt reads only once the old row's save is done, and a lost save is never sent again", async () => {
    api.get.mockResolvedValue({ on: true, seconds: 10 });
    row.refresh();
    await settle();
    const answers: Array<{ resolve: (delay: ChatSendDelay) => void; reject: (error: Error) => void }> = [];
    api.put.mockImplementation(() => new Promise((resolve, reject) => answers.push({ resolve, reject })));
    // Off goes out from the first row, and its answer is held.
    toggle().click();
    await settle();
    expect(api.put.mock.calls).toEqual([[{ on: false, seconds: 10 }]]);
    // Chat is closed and opened again: the new row doesn't read yet, so it stays shut and a tap does nothing.
    row.el.remove();
    const old = row;
    row = chatSendDelayRow();
    document.body.append(row.el);
    api.get.mockClear();
    api.get.mockResolvedValue({ on: false, seconds: 10 });
    row.refresh();
    await settle();
    toggle().click();
    await settle();
    expect([api.get.mock.calls.length, api.put.mock.calls.length, toggle().disabled]).toEqual([0, 1, true]);
    // The old answer is lost: Off isn't sent again (Settings › Behaviours may have saved since); the old row asks the
    // server, then the new row reads what the save left and opens.
    answers[0]!.reject(lost());
    await settle();
    expect([api.get.mock.calls.length, api.put.mock.calls.length]).toEqual([2, 1]);
    expect([toggle().disabled, toggle().getAttribute("aria-checked")]).toEqual([false, "false"]);
    expect(api.flash).not.toHaveBeenCalled();
    old.el.remove();
  });

  it("a pick still queued when the session ends never goes under the next session", async () => {
    api.get.mockResolvedValue({ on: true, seconds: 3 });
    row.refresh();
    await settle();
    const answers: Array<{ resolve: (delay: ChatSendDelay) => void; reject: (error: Error) => void }> = [];
    api.put.mockImplementation(() => new Promise((resolve, reject) => answers.push({ resolve, reject })));
    // 5 s goes out and its answer is held; Chat is rebuilt, and the new row stays shut behind it.
    seconds(5).click();
    await settle();
    const first = row;
    row = chatSendDelayRow();
    document.body.append(row.el);
    row.refresh();
    await settle();
    toggle().click();
    await settle();
    expect(api.put).toHaveBeenCalledTimes(1);
    // He signs out and back in; the held answer comes back from the ended session.
    endSession();
    answers[0]!.reject(new StaleSession());
    await settle();
    // Nothing from the ended session goes, not even the new row's queued read; the next open reads.
    expect([api.put.mock.calls.length, api.get.mock.calls.length]).toEqual([1, 1]);
    row.refresh();
    await settle();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(toggle().disabled).toBe(false);
    expect(api.flash).not.toHaveBeenCalled();
    first.el.remove();
  });
});
