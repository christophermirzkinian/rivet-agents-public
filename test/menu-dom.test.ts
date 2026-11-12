// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { app, go, landing } from "../web/src/state.js";
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
    expect(keys(list).filter(Boolean)).toEqual(["asks", "usage", "code", "machines", "mind", "what-you-used", "home", "media", "settings"]);
    expect([...list.querySelectorAll(".menu-name")].map((one) => one.textContent)).toEqual(["Home", "Usage", "Code", "Machines", "Rivet's mind", "What you used", "Home Assistant", "Media", "Settings"]);
    expect([...list.querySelectorAll<HTMLElement>(".menu-row")].every((one) => one.querySelector(".menu-icon"))).toBe(true);
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
    expect(drawer.querySelectorAll(".menu-row")).toHaveLength(9);
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
