// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OvernightSettings } from "../src/shared/jobs.js";
import { app, resetSession } from "../web/src/state.js";
import { offerOvernightNotice, overnightPanel } from "../web/src/views/overnight.js";
import { closeSheet } from "../web/src/views/sheet.js";

// The one-time overnight-jobs notice against a fake server: it opens only while the server says unseen, says
// seen however it closes, never comes back once seen, and its switch and "Use an API key instead" do what they say.

let served: OvernightSettings;
let puts: Record<string, unknown>[];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const notice = () => document.querySelector<HTMLElement>(".night-notice");
const use = (name: string) => document.querySelector<HTMLElement>(`[data-use="${name}"]`);

beforeEach(() => {
  resetSession();
  served = { on: true, noticeSeen: false };
  puts = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (String(input) !== "/api/settings/overnight") return json({ error: "not here" }, 404);
    if (init.method === "PUT") {
      const change = JSON.parse(String(init.body)) as { on?: boolean; noticeSeen?: true };
      puts.push(change);
      served = { on: change.on ?? served.on, noticeSeen: served.noticeSeen || change.noticeSeen === true };
    }
    return json(served);
  });
});

afterEach(() => {
  closeSheet();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("the overnight-jobs notice", () => {
  it("opens once while unseen, with the plain words, and Got it marks it seen", async () => {
    await offerOvernightNotice();
    expect(notice()).not.toBeNull();
    const text = notice()!.textContent ?? "";
    expect(text).toContain("They use your own Claude or ChatGPT plan, the same as work you start, and count toward its limits.");
    expect(text).toContain("You can switch this off, or use an API key instead, any time in Settings.");
    use("overnight-notice.got-it")!.click();
    await settle();
    expect(puts).toEqual([{ noticeSeen: true }]);
    expect(served.noticeSeen).toBe(true);
    // Offered once a start: a second offer in the same session opens nothing.
    await offerOvernightNotice();
    await settle();
    expect(document.querySelector(".night-notice:not(.is-leaving)")).toBeNull();
  });

  it("never opens again once the server says seen, as on the owner's own app", async () => {
    served = { on: true, noticeSeen: true };
    await offerOvernightNotice();
    expect(notice()).toBeNull();
    resetSession();
    await offerOvernightNotice();
    expect(notice()).toBeNull();
    expect(puts).toEqual([]);
  });

  it("switches overnight jobs off from the notice, and closing it any way marks it seen", async () => {
    await offerOvernightNotice();
    const toggle = use("overnight-notice.toggle") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await settle();
    expect(puts).toEqual([{ on: false }]);
    expect(notice()!.textContent).toContain("Off. Scheduled chats skip");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle();
    expect(puts).toEqual([{ on: false }, { noticeSeen: true }]);
    expect(served).toEqual({ on: false, noticeSeen: true });
  });

  it("closing the notice while the switch is still saving never leaves the switch stuck", async () => {
    await offerOvernightNotice();
    let answer: (() => void) | null = null;
    const real = fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) =>
      init.method === "PUT" && String(init.body).includes('"on"') && !answer ? new Promise<Response>((resolve) => (answer = () => void real(input, init).then(resolve))) : real(input, init),
    );
    const toggle = use("overnight-notice.toggle") as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    use("overnight-notice.got-it")!.click();
    await settle();
    expect(served.noticeSeen).toBe(true);
    answer!();
    await settle();
    expect(served.on).toBe(false);
    const again = overnightPanel().querySelector<HTMLInputElement>('[data-use="settings.overnight.toggle"]')!;
    expect(again.disabled).toBe(false);
    expect(again.checked).toBe(false);
    again.checked = true;
    again.dispatchEvent(new Event("change"));
    await settle();
    expect(served.on).toBe(true);
  });

  it("waits for the next start while anything is open over the screen: a sheet, Decide, a chat or a lightbox", async () => {
    for (const layer of ['<div class="sheet-backdrop"></div>', '<div class="sheet-backdrop is-tall"><div class="sheet is-tall" role="dialog" aria-modal="true"></div></div>', '<div class="scene-sheet-backdrop"><div class="scene-sheet" role="dialog" aria-modal="true"></div></div>', '<div class="lightbox" role="dialog" aria-modal="true"></div>']) {
      resetSession();
      document.body.innerHTML = layer;
      await offerOvernightNotice();
      expect(notice()).toBeNull();
    }
    expect(puts).toEqual([]);
    document.body.replaceChildren();
    resetSession();
    await offerOvernightNotice();
    expect(notice()).not.toBeNull();
  });

  it("Use an API key instead goes to Settings, where the key row is marked planned", async () => {
    await offerOvernightNotice();
    use("overnight-notice.api-key")!.click();
    await settle();
    expect(app.tab).toBe("more");
    expect(app.morePage).toBe("settings");
    expect(puts).toEqual([{ noticeSeen: true }]);
    const panel = overnightPanel();
    const key = panel.querySelector('[data-use="settings.overnight.key"]')!;
    expect(key.getAttribute("aria-disabled")).toBe("true");
    expect(key.textContent).toBe("Use an API key insteadPlanned");
    expect(panel.textContent).toContain("Run jobs while I sleep");
  });
});
