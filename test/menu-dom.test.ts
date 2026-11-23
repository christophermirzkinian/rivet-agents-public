// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { serviceOf } from "../src/shared/connectors.js";
import { loadConnectors, opsData, resetOps } from "../web/src/ops-data.js";
import { app, go, landing } from "../web/src/state.js";
import * as connectorsPage from "../web/src/views/connectors.js";
import { menuButton, menuList } from "../web/src/views/menu.js";
import { closeSheet, closeTallSheet } from "../web/src/views/sheet.js";

// The menu: one flat list, the home screen and the readings, a rule, then the rest.

const keys = (el: HTMLElement) => [...el.children].map((one) => (one as HTMLElement).dataset.key);

beforeEach(() => {
  app.tab = "progress";
  app.morePage = null;
});

afterEach(() => {
  closeSheet();
  closeTallSheet();
  document.body.replaceChildren();
  app.tab = "progress";
  app.morePage = null;
});

describe("the menu", () => {
  it("lists the home screen, the readings and what is yours, each named with an icon", () => {
    const list = menuList();
    expect(keys(list).filter(Boolean)).toEqual(["asks", "usage", "machines", "mind", "home", "media", "connectors", "settings"]);
    expect([...list.querySelectorAll(".menu-name")].map((one) => one.textContent)).toEqual(["Home", "Usage", "Machines", "Rivet's mind", "Home Assistant", "Media", "Connectors", "Settings"]);
    expect([...list.querySelectorAll<HTMLElement>(".menu-row")].every((one) => one.querySelector(".menu-icon"))).toBe(true);
  });

  it("puts a red count on Connectors while a service has an account signed out, and none once all are fine", () => {
    const row = () => menuList().querySelector<HTMLElement>('.menu-row[data-key="connectors"]')!;
    const at = "2026-11-22T00:00:00.000Z";
    const account = (id: string, state: "ok" | "signed-out") => ({ id, label: id, state, checkedAt: at, since: null });
    const fine = serviceOf("github", "GitHub", [account("github-1", "ok")]);
    opsData.connectors = { at, services: [serviceOf("claude", "Claude", [account("account-1", "ok"), account("account-2", "signed-out")]), fine] };
    expect(row().querySelector(".badge.t-bad")?.textContent).toBe("1");
    expect(row().getAttribute("aria-label")).toBe("Connectors, 1 needs attention");
    opsData.connectors = { at, services: [fine] };
    expect(row().querySelector(".badge")).toBeNull();
    opsData.connectors = null;
  });

  it("hides Connectors on a copy whose server has none, and asks that server no more this session", async () => {
    const realFetch = globalThis.fetch;
    let asks = 0;
    globalThis.fetch = async () => {
      asks += 1;
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "content-type": "application/json" } });
    };
    try {
      await loadConnectors();
      expect(opsData.connectorsAbsent).toBe(true);
      expect(menuList().querySelector('.menu-row[data-key="connectors"]')).toBeNull();
      expect(menuList().querySelector('.menu-row[data-key="settings"]')).not.toBeNull();
      const page = document.createElement("div");
      opsData.at = Date.now();
      connectorsPage.mount(page);
      expect(page.querySelector(".cn-note")?.textContent).toBe("Connectors are not set up on this copy.");
      connectorsPage.unmount();
      const asked = asks;
      await loadConnectors();
      expect(asks).toBe(asked);
    } finally {
      globalThis.fetch = realFetch;
      resetOps();
    }
    expect(opsData.connectorsAbsent).toBe(false);
  });

  it("lights the home screen under a decision too, and a page while it is open", () => {
    const lit = () => [...menuList().querySelectorAll<HTMLElement>('.menu-row[aria-current="page"]')].map((one) => one.dataset.key);
    expect(lit()).toEqual(["asks"]);
    app.tab = "cards";
    expect(lit()).toEqual(["asks"]);
    app.tab = "more";
    app.morePage = "media";
    expect(lit()).toEqual(["media"]);
  });

  it("goes to the home screen after its pick", () => {
    const picked: string[] = [];
    app.tab = "more";
    app.morePage = "settings";
    document.body.append(menuList(() => picked.push(`${app.tab}`)));
    document.querySelector<HTMLButtonElement>('.menu-row[data-key="asks"]')!.click();
    expect(app.tab).toBe("progress");
    expect(picked).toEqual(["more"]);
  });

  it("opens from the menu button as a drawer named Menu", () => {
    document.body.append(menuButton());
    document.querySelector<HTMLButtonElement>(".menu-open")!.click();
    const drawer = document.querySelector<HTMLElement>(".sheet.menu-sheet")!;
    expect(drawer.getAttribute("aria-label")).toBe("Menu");
    expect(drawer.querySelectorAll(".menu-row")).toHaveLength(8);
  });
});

describe("old ids for pages that went", () => {
  it.each(["more", "costs", "scheduled"])("%s lands on the home screen", (id) => {
    expect(landing(id)).toEqual({ tab: "progress", page: null });
    app.tab = "more";
    app.morePage = "media";
    go(id);
    expect(app.tab).toBe("progress");
  });
});
