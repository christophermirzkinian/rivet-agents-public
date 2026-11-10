// @vitest-environment happy-dom
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Api from "../web/src/api.js";
import type { UsageDevice, UsageFeature, UsageReport, UsageRow } from "../src/shared/usage-ids.js";

// More › What you used: phone first, every feature in its area's fold, closed until
// opened, a search that opens the folds it finds, Retire? and Rework? only send a card, and a young recording reads as
// young.

const api = vi.hoisted(() => ({ getUsageReport: vi.fn(), askUsage: vi.fn() }));
vi.mock("../web/src/api.js", async (actual) => ({ ...(await actual<typeof Api>()), ...api }));

const page = await import("../web/src/views/what-you-used.js");

const row = (id: string, label: string, where: string, more: Partial<UsageRow> = {}): UsageRow => ({ id, label, where, count: 0, ...more });
const feature = (id: string, label: string, area: UsageFeature["area"], more: Partial<UsageFeature> = {}): UsageFeature => ({ id, label, area, phone: 0, desktop: 0, days: 0, status: "untouched", ...more });
const FEATURES: UsageFeature[] = [
  feature("cards.answer.choice", "Answer a card", "Cards", { phone: 412, desktop: 9, days: 26, last: "2026-11-27", status: "lot" }),
  feature("cards.minimise", "Minimise a card", "Cards", { phone: 6, days: 3, last: "2026-11-20", status: "some" }),
  feature("chat.send", "Send to Rivet", "Chat", { phone: 188, days: 20, last: "2026-11-27", status: "lot" }),
  feature("chat.aloud", "Read aloud", "Chat", { phone: 3, days: 2, last: "2026-11-20", status: "some", rework: { opens: 3, quick: 3 } }),
  feature("settings.push.test", "Push test", "Settings", { status: "unclear", retire: true }),
  feature("plan.0", "Plan zero", "Plan and Coming", { retire: true, asked: "kept" }),
  feature("plan.1", "Plan one", "Plan and Coming", { retire: true }),
  feature("findwork.go", "Find work: go", "Removed", { status: "removed", removed: "2026-11-02", phone: 4, days: 1, last: "2026-10-30" }),
];
const MATURE: UsageReport = {
  device: "phone",
  since: "2026-10-28",
  recorded: 31,
  days: 30,
  taps: 1284,
  opened: 2310,
  daysUsed: 26,
  often: [row("cards.answer.choice", "Answer a card", "Cards", { count: 412, perDay: 14 })],
  rarely: [row("chat.aloud", "Read aloud", "Chat", { count: 3, last: "2026-11-20", rework: { opens: 3, quick: 3 } })],
  never: [row("plan.0", "Plan zero", "Plan", { asked: "kept" }), row("plan.1", "Plan one", "Plan"), row("settings.push.test", "Push test", "Settings")],
  features: FEATURES,
};

let host: HTMLElement;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = (selector: string, within: ParentNode = host) => [...within.querySelectorAll(selector)].map((el) => el.textContent);
const fold = (area: string) => host.querySelector<HTMLElement>(`.used-fold[data-area="${area}"]`)!;
const head = (area: string) => fold(area).querySelector<HTMLButtonElement>(".used-fold-head")!;
/** The row numbers keep each phrase whole with no-break spaces. */
const plain = (texts: (string | null)[]) => texts.map((one) => one?.replace(/\u00a0/g, " "));
const type = (words: string) => {
  const input = host.querySelector<HTMLInputElement>(".used-search")!;
  input.value = words;
  input.dispatchEvent(new Event("input"));
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.replaceChildren(host);
  api.getUsageReport.mockReset();
  api.askUsage.mockReset();
});

afterEach(() => page.unmount());

describe("What you used", () => {
  it("shows the phone's 30 days as closed folds, each with its count and split, and a fold opens to its rows", async () => {
    api.getUsageReport.mockResolvedValue(MATURE);
    page.mount(host);
    expect(host.querySelector('.reading.is-pending[aria-label="Reading What you used…"]')).not.toBeNull();
    await flush();
    expect(api.getUsageReport).toHaveBeenCalledWith("phone");
    expect(host.querySelector('[data-use="used.device.phone"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector(".used-sum")!.textContent).toBe("Last 30 days on your phone · 1,284 taps and 2,310 screens opened on 26 days");
    expect(text(".used-fold-name")).toEqual(["Cards", "Chat", "Settings", "Plan and Coming", "Removed"]);
    expect(text(".used-fold-n")).toEqual(["2", "2", "1", "2", "1"]);
    expect(text(".used-split", fold("Cards"))).toEqual(["1 a lot1 sometimes"]);
    expect(text(".used-split .used-status", fold("Plan and Coming"))).toEqual(["2 untouched"]);
    expect(text(".used-split .used-status", fold("Settings"))).toEqual(["1 can't tell"]);
    expect(text(".used-split .used-status", fold("Removed"))).toEqual(["1 removed"]);
    expect(host.querySelectorAll(".used-row")).toHaveLength(0);
    expect(head("Cards").getAttribute("aria-expanded")).toBe("false");
    // A closed fold points at nothing; an open one points at its rows.
    expect(head("Cards").hasAttribute("aria-controls")).toBe(false);

    head("Cards").focus();
    head("Cards").click();
    expect(head("Cards").getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(head("Cards").getAttribute("aria-controls")!)?.querySelectorAll(".used-row")).toHaveLength(2);
    // The repaint hands focus to the new header, so a second Enter closes the fold.
    expect(document.activeElement).toBe(head("Cards"));
    expect(text(".used-name", fold("Cards"))).toEqual(["Answer a card", "Minimise a card"]);
    expect(text(".used-id", fold("Cards"))).toEqual(["cards.answer.choice", "cards.minimise"]);
    expect(plain(text(".used-where", fold("Cards")))).toEqual(["Phone 412 · Computer 9 · 26 days · last 27 Nov", "Phone 6 · Computer 0 · 3 days · last 20 Nov"]);
    expect(text(".used-ends .used-status", fold("Cards"))).toEqual(["a lot", "sometimes"]);
    head("Cards").click();
    expect(head("Cards").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(head("Cards"));
    expect(host.querySelectorAll(".used-row")).toHaveLength(0);

    head("Removed").click();
    const removed = fold("Removed").querySelector('[data-id="findwork.go"]')!;
    expect(removed.querySelector(".used-status.removed")!.textContent).toBe("Removed 2 Nov");
    expect(removed.querySelector("button")).toBeNull();
    expect(host.querySelector(".used-foot")!.textContent).toBe("Each Retire? comes to you as a card first. Nothing is removed by itself.");
  });

  it("searches every area by name or id, opens the folds it finds, and Expand all opens and closes them all", async () => {
    api.getUsageReport.mockResolvedValue(MATURE);
    page.mount(host);
    await flush();
    const toggle = host.querySelector<HTMLButtonElement>('[data-use="used.expand-all"]')!;
    expect(toggle.textContent).toBe("Expand all");
    toggle.click();
    expect(host.querySelectorAll(".used-row")).toHaveLength(FEATURES.length);
    expect(toggle.textContent).toBe("Collapse all");
    toggle.click();
    expect(host.querySelectorAll(".used-row")).toHaveLength(0);
    expect(toggle.textContent).toBe("Expand all");

    head("Settings").click();
    const input = host.querySelector<HTMLInputElement>(".used-search")!;
    input.focus();
    type("CARD");
    expect(text(".used-fold-name")).toEqual(["Cards"]);
    expect(head("Cards").getAttribute("aria-expanded")).toBe("true");
    expect(text(".used-name")).toEqual(["Answer a card", "Minimise a card"]);
    // The box is the same one, still focused, so typing goes on.
    expect(host.querySelector(".used-search")).toBe(input);
    expect(document.activeElement).toBe(input);

    type("chat.");
    expect(text(".used-fold-name")).toEqual(["Chat"]);
    expect(text(".used-fold-n")).toEqual(["2"]);
    type("push");
    expect(text(".used-name")).toEqual(["Push test"]);
    type("nothing like this");
    expect(host.querySelector(".used-empty")!.textContent).toBe("No feature matches “nothing like this”.");

    // Cleared, the folds are as they were before the search: only Settings open.
    type("");
    expect(text(".used-fold-name")).toEqual(["Cards", "Chat", "Settings", "Plan and Coming", "Removed"]);
    expect([...host.querySelectorAll(".used-fold.is-open")].map((el) => el.getAttribute("data-area"))).toEqual(["Settings"]);
  });

  it("keeps Retire? and Rework? on their rows, sends them as a card for the device shown, and says why one was not sent", async () => {
    api.getUsageReport.mockResolvedValue(MATURE);
    api.askUsage.mockResolvedValueOnce({ card: "usage-retire-2026-11-30-plan.1" });
    page.mount(host);
    await flush();
    head("Plan and Coming").click();
    expect(fold("Plan and Coming").querySelector('[data-id="plan.0"] .used-asked')!.textContent).toBe("Kept");
    expect(fold("Plan and Coming").querySelector('[data-id="plan.0"] button')).toBeNull();
    host.querySelector<HTMLButtonElement>('[data-id="plan.1"] [data-use="used.retire"]')!.click();
    expect(host.querySelector('[data-id="plan.1"] .used-chip')!.textContent).toBe("Sending…");
    await flush();
    expect(api.askUsage).toHaveBeenCalledWith("plan.1", "retire", "phone");
    expect(host.querySelector(".used-note.yes")!.textContent).toBe("Sent to Cards. Nothing changes until you answer it.");
    expect(api.getUsageReport).toHaveBeenCalledTimes(2);
    // The repaint after the card kept the fold open.
    expect(head("Plan and Coming").getAttribute("aria-expanded")).toBe("true");

    const { ApiError } = await import("../web/src/api.js");
    api.askUsage.mockRejectedValueOnce(new ApiError(409, "a card already asked about it"));
    head("Chat").click();
    expect(plain([host.querySelector('[data-id="chat.aloud"] .used-where')!.textContent])).toEqual(["Phone 3 · Computer 0 · 2 days · last 20 Nov · left in under 3 s 3 of 3 times".replace(/\u00a0/g, " ")]);
    host.querySelector<HTMLButtonElement>('[data-id="chat.aloud"] [data-use="used.rework"]')!.click();
    await flush();
    await flush();
    expect(api.askUsage).toHaveBeenLastCalledWith("chat.aloud", "rework", "phone");
    expect(host.querySelector(".used-note.no")!.textContent).toBe("Not sent: a card already asked about it.");
    // A server failure is plain words, never its own (review R1.5).
    api.askUsage.mockRejectedValueOnce(new ApiError(500, "Request failed (500)"));
    host.querySelector<HTMLButtonElement>('[data-id="chat.aloud"] [data-use="used.rework"]')!.click();
    await flush();
    await flush();
    expect(host.querySelector(".used-note.no")!.textContent).toBe("Not sent. Try again.");
    // A 4xx with no sentence in its body carries api's own fallback, which is not his to read (review R2.2).
    api.askUsage.mockRejectedValueOnce(new ApiError(404, "Request failed (404)"));
    host.querySelector<HTMLButtonElement>('[data-id="chat.aloud"] [data-use="used.rework"]')!.click();
    await flush();
    await flush();
    expect(host.querySelector(".used-note.no")!.textContent).toBe("Not sent. Try again.");
  });

  it("switches to the computer's counts and keeps the open folds", async () => {
    api.getUsageReport.mockImplementation(async (device: UsageDevice) => ({ ...MATURE, device, taps: device === "desktop" ? 40 : MATURE.taps, opened: device === "desktop" ? 1 : MATURE.opened }));
    page.mount(host);
    await flush();
    head("Chat").click();
    host.querySelector<HTMLButtonElement>('[data-use="used.device.desktop"]')!.click();
    await flush();
    expect(api.getUsageReport).toHaveBeenLastCalledWith("desktop");
    expect(host.querySelector('[data-use="used.device.desktop"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector(".used-sum")!.textContent).toBe("Last 30 days on your computer · 40 taps and 1 screen opened on 26 days");
    expect(head("Chat").getAttribute("aria-expanded")).toBe("true");
  });

  it("says it couldn't load in plain words, never the server's, and keeps the last counts when a refresh fails", async () => {
    const { ApiError } = await import("../web/src/api.js");
    api.getUsageReport.mockRejectedValueOnce(new ApiError(500, "Request failed (500)"));
    page.mount(host);
    await flush();
    expect(host.querySelector(".reading-failed-words")!.textContent).toBe("Couldn't load What you used.");
    expect(host.textContent).not.toMatch(/Request failed|Pull to try again/);
    api.getUsageReport.mockResolvedValueOnce(MATURE);
    host.querySelector<HTMLButtonElement>(".reading-failed .reading-btn")!.click();
    await flush();
    expect(host.querySelector(".used-sum")!.textContent).toMatch(/^Last 30 days on your phone/);
    api.getUsageReport.mockRejectedValueOnce(new ApiError(500, "Request failed (500)"));
    await page.refresh();
    expect(host.querySelector(".reading-stale")!.textContent).toBe("Couldn't refresh. These are the last numbers read.");
    expect(host.querySelector(".used-sum")).not.toBeNull();
    expect(host.textContent).not.toMatch(/Request failed/);
  });

  it("never counts an ended session's answer as a failed read, nor lets it end the newer read's wait (review R2.1)", async () => {
    const { StaleSession, endSession } = await import("../web/src/session.js");
    let stale!: (error: Error) => void;
    let fresh!: (report: UsageReport) => void;
    api.getUsageReport.mockImplementationOnce(() => new Promise((_, reject) => (stale = reject)));
    api.getUsageReport.mockImplementationOnce(() => new Promise((resolve) => (fresh = resolve)));
    page.mount(host);
    endSession();
    page.mount(host);
    stale(new StaleSession());
    await flush();
    expect(host.querySelector(".reading-failed")).toBeNull();
    expect(host.querySelector(".reading.is-pending")).not.toBeNull();
    fresh(MATURE);
    await flush();
    expect(host.querySelector(".used-sum")!.textContent).toMatch(/^Last 30 days on your phone/);
  });

  it("never lets a read from an earlier visit fail or replace the newer one (review R3.1)", async () => {
    let early!: { resolve: (report: UsageReport) => void; reject: (error: Error) => void };
    let fresh!: (report: UsageReport) => void;
    api.getUsageReport.mockImplementationOnce(() => new Promise((resolve, reject) => (early = { resolve, reject })));
    api.getUsageReport.mockImplementationOnce(() => new Promise((resolve) => (fresh = resolve)));
    page.mount(host);
    page.unmount();
    page.mount(host);
    fresh(MATURE);
    await flush();
    early.reject(new Error("late"));
    early.resolve({ ...MATURE, taps: 1 });
    await flush();
    expect(host.querySelector(".reading-stale")).toBeNull();
    expect(host.querySelector(".reading-failed")).toBeNull();
    expect(host.querySelector(".used-sum")!.textContent).toMatch(/^Last 30 days on your phone/);
    expect(host.querySelector(".used-sum")!.textContent).not.toContain(" 1 tap");
  });

  it("reads a young recording as young, and an empty one as empty, with no Retire?", async () => {
    const young = FEATURES.map(({ retire: _retire, ...rest }) => rest);
    api.getUsageReport.mockResolvedValueOnce({ ...MATURE, recorded: 10, days: 10, taps: 120, opened: 75, daysUsed: 8, never: null, features: young });
    page.mount(host);
    await flush();
    expect(host.querySelector(".used-sum")!.textContent).toBe("Recording since 28 Oct · on your phone, 120 taps and 75 screens opened on 8 days");
    host.querySelector<HTMLButtonElement>('[data-use="used.expand-all"]')!.click();
    expect(host.querySelector('[data-use="used.retire"]')).toBeNull();

    api.getUsageReport.mockResolvedValueOnce({ device: "phone", since: null, recorded: 0, days: 0, taps: 0, opened: 0, daysUsed: 0, often: [], rarely: [], never: null, features: [] });
    await page.refresh();
    expect(host.querySelector(".used-sum")!.textContent).toBe("Nothing recorded yet. Taps are counted from the next time you open the app.");
    expect(host.querySelectorAll(".used-fold")).toHaveLength(0);
    expect(host.querySelector(".used-search")).toBeNull();
  });

  it("listens for no scroll, touch move or wheel, and its styles have no animation, no text under 13px and 44px taps", async () => {
    const listened: string[] = [];
    const add = EventTarget.prototype.addEventListener;
    const spy = vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function (this: EventTarget, type, ...rest) {
      listened.push(type);
      return add.call(this, type, ...rest);
    });
    api.getUsageReport.mockResolvedValue(MATURE);
    page.mount(host);
    await flush();
    host.querySelector<HTMLButtonElement>('[data-use="used.expand-all"]')!.click();
    spy.mockRestore();
    expect(listened.filter((type) => /scroll|touch|wheel/.test(type))).toEqual([]);

    const css = readFileSync("web/src/views/what-you-used.css", "utf8");
    expect(css).not.toMatch(/animation|transition|@keyframes/);
    for (const [, px] of css.matchAll(/font-size:\s*(\d+)px/g)) expect(Number(px)).toBeGreaterThanOrEqual(13);
    for (const name of ["used-device", "used-chip", "used-search", "used-toggle"]) expect(css).toMatch(new RegExp(`\\.${name} \\{[^}]*min-height: (var\\(--tap\\)|4[4-9]px)`));
    expect(css).toMatch(/\.used-fold-head \{[^}]*min-height: (4[4-9]|5\d)px/);
  });
});
