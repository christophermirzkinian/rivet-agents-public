import "./home-assistant.css";

import type { HomeReading } from "../../../src/shared/home.js";
import { when } from "../../../src/shared/when.js";
import { ApiError, call } from "../api.js";
import { describe, h } from "../dom.js";
import { controlWords, homeData, homeState, loadHome, tileWords } from "../home-data.js";

// The Home page: the tiles and buttons the user listed in home.json, as Home Assistant reports them through the bridge.
// With nothing sent yet it says how to set that up. It reads once a minute while open.

const POLL_MS = 60_000;

let root: HTMLElement | null = null;
let timer = 0;
/** The button waiting on the bridge, and the last refusal, kept across the minute's repaints. */
let pending: string | null = null;
let note: string | null = null;

export function mount(el: HTMLElement): void {
  unmount();
  root = el;
  paint();
  void refresh();
  timer = window.setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, POLL_MS);
}

export function unmount(): void {
  window.clearInterval(timer);
  root = null;
  note = null;
}

export async function refresh(): Promise<void> {
  await loadHome();
  paint();
}

async function control(button: string): Promise<void> {
  if (pending) return;
  pending = button;
  note = null;
  paint();
  try {
    await call("POST", "/api/home/control", { button });
  } catch (err) {
    // Signed out, refused or unreachable: the page's own words; the rest are the route's codes.
    const coded = err instanceof ApiError && err.status >= 400 && err.status !== 401 && err.status !== 403;
    note = coded ? controlWords(err.message) : describe(err);
  } finally {
    pending = null;
  }
  await refresh();
}

function setUp(): HTMLElement {
  return h(
    "section",
    { class: "ha-block" },
    h("h2", { class: "ha-title" }, "Home Assistant isn't set up"),
    h(
      "ol",
      { class: "ha-steps" },
      h("li", {}, "Set RIVET_HA_URL where the bridge runs, to your Home Assistant's address."),
      h("li", {}, "Set RIVET_HA_TOKEN there, or keep the token in the Keychain as rivet-agents-home-assistant."),
      h("li", {}, "List your tiles and buttons in ~/.rivet-agents/home.json."),
    ),
    h("p", { class: "ha-help" }, "home-automation/README.md has the steps and an example file."),
  );
}

function reading({ tiles, buttons }: HomeReading): HTMLElement[] {
  if (!tiles.length && !buttons.length) return [h("p", { class: "ha-notice" }, "Home Assistant is answering. Add tiles and buttons to ~/.rivet-agents/home.json to see them here.")];
  const parts: HTMLElement[] = [];
  if (tiles.length) parts.push(h("div", { class: "ha-tiles" }, ...tiles.map((tile) => h("div", { class: "ha-tile" }, h("b", {}, tileWords(tile)), h("span", {}, tile.label)))));
  if (buttons.length) {
    const presses = buttons.map((one) => {
      const press = h("button", { class: "ha-button", attrs: { type: "button", "data-button": one.id, "data-use": "home.button" }, on: { click: () => void control(one.id) } }, one.label);
      press.disabled = pending !== null;
      if (pending === one.id) press.setAttribute("aria-busy", "true");
      return press;
    });
    parts.push(h("div", { class: "ha-buttons" }, ...presses));
  }
  if (note) parts.push(h("p", { class: "ha-note", attrs: { role: "status" } }, note));
  return parts;
}

function paint(): void {
  if (!root) return;
  const { home, error } = homeData;
  const body: HTMLElement[] = [];
  if (error) body.push(h("p", { class: "ha-notice" }, home ? `Couldn't refresh: ${error}` : `Couldn't load Home: ${error}`));
  const seen = homeState(home);
  if (!home && !error) body.push(h("p", { class: "ha-quiet" }, "Loading…"));
  else if (home && seen.state === "not-set-up") body.push(setUp());
  else if (seen.state === "offline") body.push(h("p", { class: "ha-notice" }, "The bridge is offline."));
  else if (seen.state === "no-ha") body.push(h("p", { class: "ha-notice" }, "The bridge can't reach Home Assistant."));
  else if (seen.state === "ok") body.push(...reading(seen.reading));
  if (home?.receivedAt) body.push(h("p", { class: "ha-foot" }, `Bridge checked in at ${when(home.receivedAt)}`));
  root.replaceChildren(h("div", { class: "ha" }, ...body));
}
