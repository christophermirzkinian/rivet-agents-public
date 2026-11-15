import "./ops.css";

import { APP_NAME } from "../../../src/shared/names.js";
import { MAX_TASK_RUNS_A_DAY, OVERNIGHT_OFF_NOTE, type OvernightChange, type OvernightSettings } from "../../../src/shared/jobs.js";
import * as api from "../api.js";
import { covered } from "../push.js";
import { button, describe, h } from "../dom.js";
import { onSessionReset, StaleSession } from "../session.js";
import { changed, go, sameSession, signedOut, subscribe } from "../state.js";
import { closeSheet, openSheet } from "./sheet.js";
import { flash } from "./toast.js";

// "Run jobs while I sleep": scheduled task chats and look chats run on the user's own Claude or ChatGPT
// plan, and the server skips them with "Overnight jobs are off" while this is off. Settings holds the switch; a one-time
// set-up notice says it once, in plain words. "Use an API key instead" is a planned row for now (the key route is a
// later slice).

let settings: OvernightSettings | null = null;
let loadError: string | null = null;
let saving = false;
/** Counts switch saves, so an answer or a read after one never lands over a newer one. */
let saves = 0;
/** The notice is open, or was offered this session: it is offered once a start, and never again once seen. */
let offered = false;
/** After Settings slides up, "Use an API key instead" brings its row into view. */
const KEY_ROW_SCROLL_MS = 400;

onSessionReset(() => {
  settings = null;
  loadError = null;
  saving = false;
  saves++;
  offered = false;
});

/** The words under the switch: what on and off each mean. */
export function overnightState(on: boolean): string {
  return on
    ? `On. Scheduled job chats and look chats run on your own Claude or ChatGPT plan and count toward its limits, up to ${MAX_TASK_RUNS_A_DAY} a day.`
    : `Off. Scheduled job chats and look chats skip with “${OVERNIGHT_OFF_NOTE}”. Checks still run, and a job you run yourself still goes.`;
}

export async function loadOvernight(): Promise<OvernightSettings | null> {
  const current = sameSession();
  try {
    const before = saves;
    const busy = saving;
    const next = await api.getOvernight();
    if (!current()) return null;
    // A switch save out when this read went, or sent while it was out, is newer than what it brought back.
    settings = before === saves && !busy && !saving ? next : settings ?? next;
    loadError = null;
  } catch (error) {
    if (!current()) return null;
    if (error instanceof api.ApiError && error.status === 401) {
      signedOut("Your session ended. Sign in again.");
      return null;
    }
    loadError = "Couldn't load overnight jobs.";
  }
  changed();
  return settings;
}

function save(change: OvernightChange): void {
  if (change.on === undefined) return markSeen();
  if (saving) return;
  saving = true;
  const mine = ++saves;
  const previous = settings;
  if (settings) settings = { on: change.on ?? settings.on, noticeSeen: change.noticeSeen ?? settings.noticeSeen };
  changed();
  api.putOvernight(change).then(
    (saved) => {
      if (mine === saves) settings = saved;
      flash(saved.on ? "Overnight jobs are on." : "Overnight jobs are off.");
    },
    (error: unknown) => {
      if (error instanceof StaleSession) return;
      if (mine === saves) settings = previous;
      if (error instanceof api.ApiError && error.status === 401) return signedOut("Your session ended. Sign in again.");
      flash(describe(error), "error");
      // It may have landed all the same (a timeout): ask the server what it holds now.
      void api.getOvernight().then(
        (now) => {
          if (mine !== saves) return;
          settings = now;
          changed();
        },
        () => undefined,
      );
    },
  ).finally(() => {
    // Only one switch save is out at a time, so this one is the one that set it.
    saving = false;
    changed();
  });
}

/** Marks the notice seen, quietly and apart from the switch: it never holds the switch or lands over its state. */
function markSeen(): void {
  if (settings) settings = { ...settings, noticeSeen: true };
  api.putOvernight({ noticeSeen: true }).catch((error: unknown) => {
    if (error instanceof api.ApiError && error.status === 401) signedOut("Your session ended. Sign in again.");
  });
}

function switchRow(on: boolean, use: string): HTMLElement {
  const input = h("input", { attrs: { type: "checkbox", role: "switch", "data-use": use } });
  input.checked = on;
  input.disabled = saving;
  input.addEventListener("change", () => save({ on: input.checked }));
  return h("label", { class: "set-row night-switch" }, h("span", {}, "Run jobs while I sleep"), input);
}

/** The planned API-key row: shown, marked planned, does nothing yet. */
function keyRow(): HTMLElement {
  return h(
    "div",
    { class: "set-row night-key", attrs: { id: "overnight-key", "data-use": "settings.overnight.key", "aria-disabled": "true" } },
    h("span", {}, "Use an API key instead"),
    h("span", { class: "chip night-planned" }, "Planned"),
  );
}

/** Settings › Overnight jobs. */
export function overnightPanel(): HTMLElement {
  if (!settings)
    return h(
      "section",
      { class: "panel box" },
      h("h3", { class: "panel-title" }, "Overnight jobs"),
      h("p", { class: "panel-text" }, loadError ?? "Loading…"),
      loadError ? button("Try again", () => void loadOvernight(), "big", false, "settings.overnight.retry") : null,
    );
  return h(
    "section",
    { class: "panel box night" },
    h("h3", { class: "panel-title" }, "Overnight jobs"),
    h("p", { class: `set-state box t-${settings.on ? "ok" : "idle"}` }, overnightState(settings.on)),
    switchRow(settings.on, "settings.overnight.toggle"),
    keyRow(),
    h("p", { class: "panel-text night-key-note" }, "Paste your own key and set a nightly limit. Coming in a later update."),
  );
}

/** The notice's body: the plain words, the switch, and the good-to-know. */
function noticeView(): { mount(el: HTMLElement): void; unmount(): void } {
  let stop: (() => void) | null = null;
  return {
    mount(el) {
      const render = () => {
        const on = settings?.on ?? true;
        el.replaceChildren(
          h("p", { class: "night-lead" }, `${APP_NAME} can run jobs while you sleep. They use your own Claude or ChatGPT plan, the same as work you start, and count toward its limits.`),
          h("div", { class: "night-tile box" }, switchRow(on, "overnight-notice.toggle"), h("p", { class: "night-tile-state" }, on ? "On. Uses your plan" : "Off. Scheduled chats skip")),
          h(
            "p",
            { class: "night-good box" },
            h("span", { class: "chip night-chip" }, "Good to know"),
            " Claude and ChatGPT set their own rules on automated use. You can switch this off, or use an API key instead, any time in Settings.",
          ),
          button("Use an API key instead", openKeyRow, "ghost big night-alt", false, "overnight-notice.api-key"),
        );
      };
      stop = subscribe(render);
      render();
    },
    unmount() {
      stop?.();
      stop = null;
      // However it closes (Got it, the key link, Back or a tap outside), it has been seen: it is told once.
      if (settings && !settings.noticeSeen) markSeen();
    },
  };
}

function openKeyRow(): void {
  closeSheet();
  go("settings");
  changed();
  // Once Settings has slid up (sheet.ts RISE_MS) and drawn the row.
  setTimeout(() => document.getElementById("overnight-key")?.scrollIntoView({ block: "center" }), KEY_ROW_SCROLL_MS);
}

/** Offers the one-time set-up notice once a start, if the server says it has not been seen. */
export async function offerOvernightNotice(): Promise<void> {
  if (offered) return;
  offered = true;
  const current = await loadOvernight();
  if (!current || current.noticeSeen) return;
  // Never over anything the user opened while it loaded (a sheet, a chat, a lightbox): it would close it or go under
  // it. A plain start has nothing open, and an interrupted one offers it again on the next start.
  if (covered()) return;
  openSheet("Overnight jobs", noticeView(), "Got it ›", undefined, { className: "night-notice", use: "overnight-notice", closeUse: "overnight-notice.got-it" });
}
