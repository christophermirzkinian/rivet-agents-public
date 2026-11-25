import { APP_NAME, RIVET_NAME } from "../../../src/shared/names.js";
import "./sheets.css";

import { clock } from "../../../src/shared/when.js";
import * as api from "../api.js";
import { button, describe, h, keepFocus } from "../dom.js";
import { loadPushHealth, onPushChanged, PUSH_NEEDS_PASSKEY, pushBanner, pushChanged } from "../push-health.js";
import { gateWords } from "../gate-words.js";
import { disablePush, enablePush, pushState, type PushState } from "../push.js";
import { onSessionReset, setSignedInByCode, signedInByCode } from "../session.js";
import { app, changed, sameSession, signedOut, subscribe } from "../state.js";
import type { BehaviourSection } from "../../../src/shared/behaviours.js";
import { behavioursPanel, loadBehaviours } from "./behaviours.js";
import { closeModels, loadModels, modelSettings } from "./model-settings.js";
import { flash } from "./toast.js";
import { voiceSettings } from "./voice-settings.js";

// The header's settings sheet: who does what (each job's model, kept on the Mac), then
// this phone's read-aloud voice, notifications and devices.

let push: PushState | null = null;
let pushBusy = false;
let unsubscribe: (() => void) | null = null;
let stopListening: (() => void) | null = null;
type SettingsTab = "general" | "behaviours";
/** General is today's page; Behaviours lists what Rivet does by itself. Each open starts on General. */
let tab: SettingsTab = "general";

/** Bumped by each read and each Turn on or off, so only the latest answer lands. */
let pushReads = 0;
/** Whether "Sign out desktop apps" shows: the server signs a device in by a code alone, or such a session is still live. */
let desktopApps = false;
let desktopAsk = false;
let desktopBusy = false;
/** This window signed in with a code alone: such a session can add no device and turn on no notifications (the server refuses it). */
const byCode = (): boolean => signedInByCode() === true;
onSessionReset(() => {
  desktopApps = desktopAsk = desktopBusy = false;
});

function readDesktopApps(): void {
  const current = sameSession();
  void api.me().then(
    (me) => {
      if (!current()) return;
      desktopApps = me.deviceSession === true || (me.deviceSessions ?? 0) > 0;
      setSignedInByCode(me.via === "device-code");
      changed();
    },
    () => {},
  );
}

function signOutDesktopApps(): void {
  const current = sameSession();
  desktopBusy = true;
  changed();
  void api.revokeDeviceSessions().then(
    ({ ended, signedOut: own }) => {
      if (!current()) return;
      if (own) return signedOut("Signed out.");
      desktopAsk = desktopBusy = false;
      flash(ended === 0 ? "No desktop app was signed in." : ended === 1 ? "1 desktop app signed out." : `${ended} desktop apps signed out.`, "ok");
      readDesktopApps();
      changed();
    },
    (error: unknown) => {
      if (!current()) return;
      if (error instanceof api.ApiError && error.status === 401) return signedOut("Signed out.");
      desktopBusy = false;
      flash(`Not signed out: ${gateWords(error, "devices")}`, "error");
      changed();
    },
  );
}

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
  tab = "general";
  const render = () => renderSettings(el);
  unsubscribe = subscribe(render);
  stopListening = onPushChanged(readPushState);
  render();
  void loadModels();
  void loadPushHealth();
  // Read on every open: a resync or the phone's own settings may have changed it since.
  readPushState();
  desktopAsk = false;
  readDesktopApps();
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
  get on() {
    return `On. ${RIVET_NAME} pings you when a new card lands.`;
  },
};

function notifications(): HTMLElement {
  if (byCode()) return h("section", { class: "panel box notify" }, h("h3", { class: "panel-title" }, "Notifications on this phone"), h("p", { class: "panel-text" }, PUSH_NEEDS_PASSKEY));
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
      : byCode()
        ? h("p", { class: "panel-text" }, "Add a device from a phone or computer signed in with a passkey.")
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
                  if (!current()) return;
                  // The server's word that a code alone made this session, where the window had not heard yet: the line above.
                  if (api.needsPasskey(error)) {
                    setSignedInByCode(true);
                    return changed();
                  }
                  flash(gateWords(error, "devices"), "error");
                },
              );
            },
            "big",
            false,
            "settings.device.add",
          ),
    !desktopApps
      ? null
      : desktopAsk
        ? h(
            "div",
            { class: "device-desktop" },
            h("p", { class: "panel-text" }, "Sign out every desktop app that signed in with a code? Each needs a new code to come back."),
            h(
              "div",
              { class: "panel-actions" },
              button("Sign them out", signOutDesktopApps, "big", desktopBusy, "settings.device.desktop-yes"),
              button(
                "Cancel",
                () => {
                  desktopAsk = false;
                  changed();
                },
                "ghost big",
                desktopBusy,
                "settings.device.desktop-no",
              ),
            ),
          )
        : button(
            "Sign out desktop apps",
            () => {
              desktopAsk = true;
              changed();
            },
            "ghost big",
            false,
            "settings.device.desktop",
          ),
    // Signed out only once the server says so (or the session had already ended): a sign-out that never reached it
    // leaves the session live, so saying "Signed out." then would be wrong.
    button(
      "Sign out",
      () =>
        void api.logout().then(
          () => signedOut("Signed out."),
          (error: unknown) => (error instanceof api.ApiError && error.status === 401 ? signedOut("Signed out.") : flash(`Not signed out: ${gateWords(error, "devices")}`, "error")),
        ),
      "ghost big",
      false,
      "settings.device.signout",
    ),
  );
}

/** Shows a tab; the preview opens Behaviours with it. */
export function openTab(next: SettingsTab): void {
  tab = next;
  if (next === "behaviours") void loadBehaviours();
  changed();
}

function tabs(el: HTMLElement): HTMLElement {
  const tabButton = (name: SettingsTab, label: string) => {
    const pick = h("button", { class: "set-tab", attrs: { type: "button", role: "tab", "aria-selected": String(tab === name), "data-use": `settings.tab.${name}` } }, label);
    pick.addEventListener("click", () => {
      if (tab === name) return;
      openTab(name);
      const body = el.querySelector(".set");
      if (body) body.scrollTop = 0;
    });
    return pick;
  };
  return h("div", { class: "set-tabs box", attrs: { role: "tablist", "aria-label": "Settings" } }, tabButton("general", "General"), tabButton("behaviours", "Behaviours"));
}

/** A linked behaviour opens its section on General. */
function openSection(el: HTMLElement, section: BehaviourSection): void {
  openTab("general");
  el.querySelector(`[data-section="${section}"]`)?.scrollIntoView({ block: "start" });
}

function marked(panel: HTMLElement, section: BehaviourSection): HTMLElement {
  panel.dataset.section = section;
  return panel;
}

function renderSettings(el: HTMLElement): void {
  const scroll = el.querySelector(".set")?.scrollTop ?? 0;
  const body = h(
    "div",
    { class: "set" },
    tabs(el),
    ...(tab === "behaviours"
      ? [behavioursPanel((section) => openSection(el, section))]
      : [pushBanner(), marked(modelSettings(), "models"), marked(voiceSettings(), "voice"), marked(notifications(), "push"), device()]),
  );
  const refocus = keepFocus(el);
  el.replaceChildren(body);
  refocus();
  body.scrollTop = scroll;
}
