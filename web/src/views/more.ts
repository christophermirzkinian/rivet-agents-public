import { h, ICONS } from "../dom.js";
import { HOME_ICON } from "../home-data.js";
import { app, changed, go, setOpsPage, subscribe, type MorePage, type OpsPage } from "../state.js";
import * as floor from "./floor.js";
import * as homeAssistant from "./home-assistant.js";
import * as media from "./media.js";
import * as mind from "./mind.js";
import * as ops from "./ops.js";
import * as settings from "./settings.js";
import type { View } from "./view.js";
import * as whatYouUsed from "./what-you-used.js";

// The pages the menu opens (menu.ts): this mounts the one `app.morePage` names.

/** Each page's name: its menu row, and its title over it. */
export const PAGE_NAMES: Record<MorePage, string> = {
  floor: "Floor",
  usage: "Usage",
  mind: "Rivet's mind",
  machines: "Machines",
  code: "Code",
  home: "Home",
  media: "Media",
  settings: "Settings",
  "what-you-used": "What you used",
};

export interface PageRow {
  page: MorePage;
  icon: string;
}

/** The menu's first group, after the home screen: what is happening. */
export const READINGS: PageRow[] = [
  { page: "floor", icon: ICONS.hq },
  { page: "usage", icon: ICONS.usage },
  { page: "machines", icon: ICONS.mac },
  { page: "code", icon: ICONS.code },
];

/** Its second, under the rule. */
export const YOURS: PageRow[] = [
  { page: "mind", icon: ICONS.mind },
  { page: "what-you-used", icon: ICONS.list },
  { page: "home", icon: HOME_ICON },
  { page: "media", icon: ICONS.photo },
  { page: "settings", icon: ICONS.settings },
];

let root: HTMLElement | null = null;
let shown: MorePage | null | undefined;
let page: View | null = null;
let stop: (() => void) | null = null;

export function mount(el: HTMLElement): void {
  unmount();
  root = el;
  shown = undefined;
  stop = subscribe(render);
  render();
}

export function unmount(): void {
  stop?.();
  stop = null;
  page?.unmount();
  page = null;
  shown = undefined;
  root = null;
}

/** Pull to refresh: the open page's own. */
export function refresh(): unknown {
  return page?.refresh?.();
}

/** Opens a page, or the home screen (null). */
export function openPage(next: MorePage | null): void {
  if (next) {
    app.morePage = next;
    app.tab = "more";
  } else go("progress");
  changed();
}

function render(): void {
  if (!root) return;
  const next = app.morePage;
  if (next === shown) return;
  page?.unmount();
  page = null;
  shown = next;
  root.scrollTop = 0;
  root.replaceChildren();
  if (next === null) return;
  const view =
    next === "floor" ? floor
    : next === "home" ? homeAssistant
    : next === "media" ? media
    : next === "settings" ? settings
    : next === "mind" ? mind
    : next === "what-you-used" ? whatYouUsed
    : ops;
  if (view === ops) setOpsPage(next as OpsPage);
  const host = h("div", { class: "more-page", attrs: { "data-page": next } });
  root.append(host);
  page = view;
  view.mount(host);
}
