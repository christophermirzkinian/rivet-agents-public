// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { Briefing } from "../src/shared/ops.js";
import * as api from "../web/src/api.js";
import { openBriefingHistory } from "../web/src/views/briefing-history.js";
import { closeSheet } from "../web/src/views/sheet.js";

const past: Briefing = {
  id: "2026-09-28-morning", slot: "morning", day: "2026-09-28",
  at: "2026-09-27T21:30:00.000Z", composedAt: "2026-09-27T21:31:00.000Z",
  since: "2026-09-27T08:00:00.000Z", headline: "Past headline",
  items: [
    { key: "needs", tone: "warn", title: "Past needs", lines: ["First", "Second", "Third", "Fourth"] },
    { key: "apps", tone: "info", title: "Past apps", lines: ["Apps detail"] },
    { key: "shipped", tone: "ok", title: "Past shipped", lines: ["Shipped detail"] },
  ],
  shippedSeen: [], seen: [], notes: [{ text: "Past note", at: "2026-09-27T22:00:00.000Z" }],
};
afterEach(() => { closeSheet(); localStorage.clear(); vi.restoreAllMocks(); });

it("opens a dismissed snapshot with every item, line and note", async () => {
  localStorage.setItem("rivet.briefing.dismissed", `${past.id}:${past.notes[0]!.at}`);
  const get = vi.spyOn(api, "getBriefing").mockResolvedValue({ briefing: past });
  openBriefingHistory(past.id);
  await vi.waitFor(() => expect(document.querySelector(".brief-headline")?.textContent).toBe("Past headline"));
  expect(get).toHaveBeenCalledWith(past.id);
  expect([...document.querySelectorAll(".brief-line")].map((el) => el.textContent)).toEqual(["First", "Second", "Third", "Fourth", "Apps detail", "Shipped detail"]);
  expect(document.querySelectorAll(".brief-item")).toHaveLength(3);
  expect(document.querySelector(".brief-note")?.textContent).toBe("Rivet: Past note");
  expect(document.querySelector(".brief-title")?.textContent).toContain(past.day);
});

it("shows a missing snapshot and a failed request", async () => {
  vi.spyOn(api, "getBriefing").mockResolvedValueOnce({ briefing: null }).mockRejectedValueOnce(new Error("Offline"));
  openBriefingHistory("missing");
  await vi.waitFor(() => expect(document.querySelector(".sheet-body")?.textContent).toContain("no longer available"));
  openBriefingHistory("failure");
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain("Offline"));
});

it.each([false, true])("ignores a late response after replacement (reject: %s)", async (reject) => {
  let resolve!: (value: { briefing: Briefing | null }) => void;
  let fail!: (reason: Error) => void;
  vi.spyOn(api, "getBriefing").mockReturnValueOnce(new Promise((yes, no) => { resolve = yes; fail = no; })).mockResolvedValueOnce({ briefing: null });
  openBriefingHistory("old");
  const detached = document.querySelector(".sheet-body")!;
  openBriefingHistory("new");
  await vi.waitFor(() => expect(document.querySelector(".sheet-body")?.textContent).toContain("no longer available"));
  if (reject) fail(new Error("Late failure")); else resolve({ briefing: past });
  await Promise.resolve();
  expect(detached.textContent).toBe("Loading briefing…");
  expect(document.querySelector(".sheet-body")?.textContent).toContain("no longer available");
});
