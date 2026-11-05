import type { HomeReading, HomeResponse } from "../../src/shared/home.js";
import { call } from "./api.js";
import { describe } from "./dom.js";
import { onSessionReset } from "./session.js";

// The Home page's reading, shared by the page and its menu row, and the words both say.

/** Past this the bridge has stopped checking in: it sends one a minute. */
export const HOME_STALE_MS = 5 * 60_000;

export const HOME_ICON =
  '<svg viewBox="0 0 24 24"><path d="M4 11.2L12 4.5l8 6.7V19a1.5 1.5 0 0 1-1.5 1.5h-4v-5.5h-5v5.5h-4A1.5 1.5 0 0 1 4 19z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>';

export const homeData: { home: HomeResponse | null; error: string | null } = { home: null, error: null };
onSessionReset(() => {
  homeData.home = null;
  homeData.error = null;
});

export async function loadHome(): Promise<void> {
  try {
    homeData.home = await call<HomeResponse>("GET", "/api/home");
    homeData.error = null;
  } catch (err) {
    homeData.error = describe(err);
  }
}

export type HomeState = { state: "not-set-up" } | { state: "offline" } | { state: "no-ha" } | { state: "ok"; reading: HomeReading };

/** Nothing ever sent, stopped checking in, can't reach Home Assistant, or the reading. */
export function homeState(home: HomeResponse | null, now = Date.now()): HomeState {
  if (!home?.snapshot || !home.receivedAt) return { state: "not-set-up" };
  if (now - Date.parse(home.receivedAt) > HOME_STALE_MS) return { state: "offline" };
  if (!home.snapshot.haReachable) return { state: "no-ha" };
  return { state: "ok", reading: home.snapshot };
}

/** A tile's reading with its unit, or a dash for none. */
export function tileWords(tile: { value: string | null; unit: string | null }): string {
  if (tile.value === null) return "–";
  return tile.unit ? `${tile.value} ${tile.unit}` : tile.value;
}

/** A refused press in plain words, from the route's code. */
export function controlWords(code: string): string {
  switch (code) {
    case "bridge_offline":
      return "The bridge is offline, try again.";
    case "not_set_up":
      return "Home Assistant isn't set up on the bridge yet.";
    case "unknown_button":
      return "That button isn't in home.json any more.";
    case "timeout":
      return "The bridge is still working on it. Check back in a minute.";
    case "too_many_tries":
      return "Too many taps. Wait 15 minutes, then try again.";
    case "busy":
      return "Still doing the last one. Wait a moment.";
    default:
      return "Home Assistant couldn't do that. Try again.";
  }
}
