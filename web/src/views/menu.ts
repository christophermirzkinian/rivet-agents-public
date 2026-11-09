import "./menu.css";

import { h, ICONS, keepFocus, svg } from "../dom.js";
import { opsData, watchOps } from "../ops-data.js";
import { app, changed, go, subscribe, type MorePage } from "../state.js";
import * as home from "./home.js";
import { PAGE_NAMES, READINGS, YOURS, type PageRow } from "./more.js";
import { usageStale, weekTotal } from "./ops.js";
import { navMark, opsStatus } from "./progress-mark.js";
import { closeSheet, openSheet } from "./sheet.js";

// The menu: every page in one list, your asks first, the readings, then what is yours under a rule. A phone opens it as
// a drawer from the band's menu button, with Usage at its head; a computer shows it on the rail.

export type MenuKey = "asks" | MorePage;

/** The screen on now: your asks under a decision too. */
function lit(key: MenuKey): boolean {
  if (key === "asks") return app.tab === "progress" || app.tab === "cards";
  return app.tab === "more" && app.morePage === key;
}

function row(key: MenuKey, icon: string, name: string, onPick: () => void): HTMLElement {
  const on = lit(key);
  const badge = key === "machines" ? navMark(opsStatus().mark) : null;
  return h(
    "button",
    {
      class: `menu-row${on ? " on" : ""}`,
      attrs: {
        type: "button",
        "data-key": key,
        "data-use": `menu.row.${key}`,
        title: name,
        ...(badge ? { "aria-label": `${name}, ${badge.getAttribute("aria-label")}` } : {}),
        ...(on ? { "aria-current": "page" } : {}),
      },
      on: {
        click: () => {
          onPick();
          if (key !== "asks") return home.goSheet(key);
          go("progress");
          changed();
        },
      },
    },
    svg(icon, "menu-icon"),
    h("span", { class: "menu-name" }, name),
    badge,
  );
}

/** The list. `onPick` runs before a row moves the app. */
export function menuList(onPick: () => void = () => {}): HTMLElement {
  const page = ({ page: key, icon }: PageRow) => row(key, icon, PAGE_NAMES[key], onPick);
  return h(
    "div",
    { class: "menu", attrs: { role: "group", "aria-label": "Menu" } },
    row("asks", ICONS.progress, home.TITLE, onPick),
    ...READINGS.map(page),
    h("hr", { class: "menu-rule" }),
    ...YOURS.map(page),
  );
}

/** The drawer's head: Claude's week, with its reading's tone as a bar along its foot. */
function usageTile(onPick: () => void): HTMLElement {
  const usage = opsData.ops?.claude ?? null;
  const week = usage ? weekTotal(usage.limits) : null;
  const tone = week ? (usage && usageStale(usage) && week.tone === "ok" ? "warn" : week.tone) : null;
  return h(
    "button",
    {
      class: `menu-tile${tone ? ` t-${tone}` : ""}`,
      attrs: { type: "button", "data-key": "tile-usage", "data-use": "menu.tile.usage", "aria-label": week ? `Usage, Claude ${week.text}` : "Usage, no reading yet" },
      on: {
        click: () => {
          onPick();
          home.goSheet("usage");
        },
      },
    },
    h("span", { class: "menu-tile-name" }, "Usage"),
    h("span", { class: "menu-tile-n" }, week?.n ?? "–", week?.of ? h("span", { class: "menu-tile-unit" }, ` ${week.of}`) : null),
  );
}

/** The phone's drawer, in from the left: a row closes it, then goes. */
export function openMenu(): void {
  let stop = () => {};
  openSheet(
    "Menu",
    {
      mount(el) {
        const paint = () => {
          const refocus = keepFocus(el);
          el.replaceChildren(usageTile(closeSheet), menuList(closeSheet));
          refocus();
        };
        const stops = [subscribe(paint), watchOps(paint)];
        stop = () => stops.forEach((one) => one());
        paint();
      },
      unmount: () => stop(),
    },
    "Close",
    undefined,
    { className: "menu-sheet", use: "menu" },
  );
}

/** The band's menu button; the ops mark rides on it as a dot. */
export function menuButton(): HTMLElement {
  const { mark } = opsStatus();
  const words = navMark(mark)?.getAttribute("aria-label");
  return h(
    "button",
    { class: "menu-open", attrs: { type: "button", "data-use": "menu.open", "aria-label": words ? `Menu, ${words}` : "Menu" }, on: { click: openMenu } },
    svg(ICONS.menu, "menu-open-icon"),
    mark.dot ? h("span", { class: `menu-dot t-${mark.dot}`, attrs: { "aria-hidden": "true" } }) : null,
  );
}
