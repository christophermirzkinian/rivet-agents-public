import { APP_NAME, RIVET_NAME } from "../../../src/shared/names.js";
import "./sheets.css";

import { clock } from "../../../src/shared/when.js";
import * as api from "../api.js";
import { button, describe, h, keepFocus } from "../dom.js";
import { loadPushHealth, onPushChanged, pushBanner, pushChanged } from "../push-health.js";
import { disablePush, enablePush, pushState, type PushState } from "../push.js";
import { app, changed, sameSession, signedOut, subscribe } from "../state.js";
import { closeModels, loadModels, modelSettings } from "./model-settings.js";
import * as patchNotes from "./patch-notes.js";
import { openSheet } from "./sheet.js";
import { flash } from "./toast.js";
import { voiceSettings } from "./voice-settings.js";

// The header's settings sheet: who does what (each job's model, kept on the Mac), then this phone's read-aloud voice,
// notifications and devices.

let push: PushState | null = null;
let pushBusy = false;
let unsubscribe: (() => void) | null = null;
let stopListening: (() => void) | null = null;

/** Bumped by each read and each Turn on or off, so only the latest answer lands. */
let pushReads = 0;

function readPushState(): void {
  const mine = ++pushReads;
  void pushState().then(
    (state) => {
      if (mine !== pushReads) return;
      push = state;
      changed();
    },
    () => {
      if (mine !== pushReads) return;
      push = "unsupported";
      changed();
    },
  );
}

export function mount(el: HTMLElement): void {
  unmount();
  const render = () => renderSettings(el);
  unsubscribe = subscribe(render);
  stopListening = onPushChanged(readPushState);
  render();
  void loadModels();
  void loadPushHealth();
  // Read on every open: a resync or the phone's own settings may have changed it since.
  readPushState();
}

export function unmount(): void {
  unsubscribe?.();
  unsubscribe = null;
  stopListening?.();
  stopListening = null;
  closeModels();
}

/** `done` is said only when the task ends in `expect`: a blocked phone answers "denied", never "on". */
function runPush(task: () => Promise<PushState | void>, done?: string, expect?: PushState): void {
  if (pushBusy) return;
  pushBusy = true;
  pushReads += 1;
  changed();
  task().then(
    (state) => {
      if (state) push = state;
      if (done && (!expect || state === expect)) flash(done);
      else if (state === "denied") flash(PUSH_TEXT.denied, "warn");
      else if (done && state) flash("Notifications are still off.", "warn");
    },
    (error: unknown) => flash(describe(error), "error"),
  ).finally(() => {
    pushBusy = false;
    changed();
    // Reads the phone again (a read started meanwhile was dropped) and the server's phone count.
    void pushChanged();
  });
}

const PUSH_TEXT: Record<PushState, string> = {
  "ios-install": `Add ${APP_NAME} to your Home Screen first: tap Share, then Add to Home Screen, and open it from there.`,
  unsupported: "This browser can't show notifications.",
  unconfigured: "Push is not set up on the server yet.",
  denied: `Notifications are blocked. Turn them on in Settings for ${APP_NAME}.`,
  off: "Get a ping when a new card lands.",
  on: `On. ${RIVET_NAME} pings you when a new card lands.`,
};

function notifications(): HTMLElement {
  const state = push;
  return h(
    "section",
    { class: "panel box notify" },
    h("h3", { class: "panel-title" }, "Notifications on this phone"),
    h("p", { class: "panel-text" }, state ? PUSH_TEXT[state] : "Checking…"),
    state === "on" || state === "off" ? h("p", { class: "panel-text push-levels" }, "Needs you: sound. FYI: quiet.") : null,
    state === "off" ? button("Turn on notifications", () => runPush(enablePush, "Notifications are on.", "on"), "primary big", pushBusy, "settings.push.on") : null,
    state === "on"
      ? h(
          "div",
          { class: "panel-actions" },
          button(
            "Send a test",
            () =>
              runPush(async () => {
                const result = await api.pushTest();
                flash(result.sent ? "Sent. Check your lock screen." : "No device took it. Turn notifications off and on.", result.sent ? "ok" : "warn");
              }),
            "big",
            pushBusy,
            "settings.push.test",
          ),
          button("Turn off", () => runPush(disablePush, "Notifications are off.", "off"), "ghost big", pushBusy, "settings.push.off"),
        )
      : null,
  );
}

function device(): HTMLElement {
  const code = app.device;
  return h(
    "section",
    { class: "panel box device" },
    h("h3", { class: "panel-title" }, "Devices"),
    code
      ? h(
          "div",
          { class: "device-code" },
          h("p", { class: "panel-text" }, "On the new device, open this link or enter the code:"),
          h("p", { class: "code" }, code.code),
          h("p", { class: "panel-text break" }, `${location.origin}/#code=${code.code}`),
          h("p", { class: "panel-text" }, `Works once, until ${clock(code.expiresAt)}.`),
          button(
            "Done",
            () => {
              app.device = null;
              changed();
            },
            "ghost big",
            false,
            "settings.device.done",
          ),
        )
      : button(
          "Add a device",
          () => {
            const current = sameSession();
            void api.deviceCode().then(
              (value) => {
                if (!current()) return;
                app.device = value;
                changed();
              },
              (error: unknown) => {
                if (current()) flash(describe(error), "error");
              },
            );
          },
          "big",
          false,
          "settings.device.add",
        ),
    // Signed out only once the server says so (or the session had already ended): a sign-out that never reached it
    // leaves the session live, so saying "Signed out." then would be wrong.
    button(
      "Sign out",
      () =>
        void api.logout().then(
          () => signedOut("Signed out."),
          (error: unknown) => (error instanceof api.ApiError && error.status === 401 ? signedOut("Signed out.") : flash(`Not signed out: ${describe(error)}`, "error")),
        ),
      "ghost big",
      false,
      "settings.device.signout",
    ),
  );
}

function patchNotesPanel(): HTMLElement {
  return h(
    "section",
    { class: "panel box" },
    h("h3", { class: "panel-title" }, "Patch notes"),
    h("p", { class: "panel-text" }, `What changed in each ${APP_NAME} update.`),
    button("Patch notes", () => openSheet("Patch notes", patchNotes, "Close", undefined, { use: "patch-notes" }), "ghost big", false, "settings.patch-notes"),
  );
}

function renderSettings(el: HTMLElement): void {
  const scroll = el.querySelector(".set")?.scrollTop ?? 0;
  const body = h("div", { class: "set" }, pushBanner(), modelSettings(), voiceSettings(), notifications(), device(), patchNotesPanel());
  const refocus = keepFocus(el);
  el.replaceChildren(body);
  refocus();
  body.scrollTop = scroll;
}
