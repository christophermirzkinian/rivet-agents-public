import "./behaviours.css";

import {
  BEHAVIOUR_GROUPS,
  type BehaviourChoices,
  DEFAULT_PROMISE_KEEPER,
  PROMISE_KEEPER_ID,
  type BehaviourRow,
  type BehaviourSection,
  type BehaviourValue,
  type SwitchDone,
  type SwitchState,
} from "../../../src/shared/behaviours.js";
import { CHAT_SEND_DELAY_SECONDS, chatSendDelaySchema, type ChatSendDelay } from "../../../src/shared/command.js";
import * as api from "../api.js";
import { button, describe, h } from "../dom.js";
import { onSessionReset, setSignedInByCode, signedInByCode, StaleSession } from "../session.js";
import { changed, sameSession, signedOut } from "../state.js";
import { cacheChatPref, syncChatPrefs } from "./chat-prefs.js";
import { flash } from "./toast.js";

// Settings › Behaviours: what Rivet does by itself, grouped, each row with its switch. Live rows save to
// /api/behaviours; the send delay reads and saves its own route and stays hidden while that route is missing;
// linked rows open their Settings section; always-on rows show they have no switch yet.

let rows: BehaviourRow[] | null = null;
let loadError: string | null = null;
/** The send delay as its route serves it: null while unread, or while the route answers 404. */
let sendDelay: ChatSendDelay | null = null;
/** The send delay's route answered, but not with a value (a 5xx, offline, a shape this build doesn't know): the row shows so. */
let sendDelayFailed = false;
/** Rows with a save on the way, so a second tap waits for the first. */
const saving = new Set<string>();
export const LATE_READ_MS = 4_000;
export const REREAD_MS = 30_000;
let rereader: ReturnType<typeof setInterval> | null = null;
/** Counts loads and saves: a load's answer lands only while no later load or save has begun or answered. */
let turn = 0;
/** The panel whose focusout will redraw a timed load's rows, while a control in it is held. */
let redrawWaitsOn: Element | null = null;

onSessionReset(() => {
  if (rereader) clearInterval(rereader);
  rereader = null;
  redrawWaitsOn = null;
  rows = null;
  loadError = null;
  sendDelay = null;
  sendDelayFailed = false;
  saving.clear();
});

/** `timed` loads leave a control in hand undisturbed, redrawing once it lets go, unless a switch has lost its Mac or met a STOP. */
export async function loadBehaviours(timed = false): Promise<void> {
  const current = sameSession();
  const mine = ++turn;
  const before = rows;
  const [list, delay] = await Promise.allSettled([api.getBehaviours(), api.getChatSendDelay()]);
  if (!current() || mine !== turn) return;
  if (list.status === "fulfilled") {
    const synced = await syncChatPrefs(list.value.behaviours);
    if (!current() || mine !== turn) return;
    rows = synced;
    loadError = null;
  } else {
    if (list.reason instanceof api.ApiError && list.reason.status === 401) return signedOut("Your session ended. Sign in again.");
    loadError = "Couldn't load behaviours.";
  }
  // Only a 404 hides the row (the route is not in this build yet); any other miss shows it with "Couldn't load".
  const missing = delay.status === "rejected" && delay.reason instanceof api.ApiError && delay.reason.status === 404;
  const parsed = delay.status === "fulfilled" ? chatSendDelaySchema.safeParse(delay.value) : null;
  sendDelay = parsed?.success ? parsed.data : null;
  sendDelayFailed = !sendDelay && !missing;
  const panel = document.querySelector("[data-behaviours]");
  if (timed && panel?.contains(document.activeElement) && !lostSafety(before, rows)) {
    if (redrawWaitsOn !== panel) {
      redrawWaitsOn = panel;
      let pressed = false;
      const press = (event: Event) => (pressed = event.type === "pointerdown");
      for (const type of ["pointerdown", "pointerup", "pointercancel"]) window.addEventListener(type, press, true);
      panel.addEventListener(
        "focusout",
        () => {
          for (const type of ["pointerdown", "pointerup", "pointercancel"]) window.removeEventListener(type, press, true);
          if (redrawWaitsOn === panel) redrawWaitsOn = null;
          redrawAfterClick(pressed);
        },
        { once: true },
      );
    }
    return;
  }
  changed();
}

/** How long after the lift (or a keyboard focus move) the click may still come. */
const CLICK_AFTER_BLUR_MS = 400;

/** A redraw as focus leaves would replace the control under a pressed finger and lose its click: it waits for the lift, then that click. */
function redrawAfterClick(pressed: boolean): void {
  let done = false;
  const redraw = () => {
    if (done) return;
    done = true;
    window.removeEventListener("click", redraw, true);
    setTimeout(changed, 0);
  };
  const lifted = () => {
    window.removeEventListener("pointerup", lifted, true);
    window.removeEventListener("pointercancel", lifted, true);
    window.addEventListener("click", redraw, true);
    setTimeout(redraw, CLICK_AFTER_BLUR_MS);
  };
  if (!pressed) return lifted();
  window.addEventListener("pointerup", lifted, true);
  window.addEventListener("pointercancel", lifted, true);
}

/** A switch row that has newly gone stopped or offline. */
function lostSafety(before: BehaviourRow[] | null, after: BehaviourRow[] | null): boolean {
  const was = new Map(before?.map((row) => [row.id, row.switch?.state]));
  return (after ?? []).some((row) => (row.switch?.state === "stopped" || row.switch?.state === "offline") && was.get(row.id) !== row.switch.state);
}

/** What a row the server keeps from a window a device code alone signed in reads under its line (a-1010). */
export const BEHAVIOUR_NEEDS_PASSKEY = "Change this from a phone or computer signed in with a passkey.";
const locked = (row: BehaviourRow) => signedInByCode() === true && row.preference !== true && (row.control === "live" || row.control === "switch");

function refused(error: unknown): void {
  if (error instanceof StaleSession) return;
  if (error instanceof api.ApiError && error.status === 401) return signedOut("Your session ended. Sign in again.");
  flash(describe(error), "error");
}

function saveRow(row: BehaviourRow, value: BehaviourValue): void {
  if (saving.has(row.id)) return;
  saving.add(row.id);
  turn += 1;
  const current = sameSession();
  const swap = (next: BehaviourRow) => (rows = rows?.map((each) => (each.id === next.id ? next : each)) ?? null);
  // A file switch shows the file as last reported, disabled, until the Mac answers.
  const isSwitch = row.control === "switch";
  if (!isSwitch) swap({ ...row, value });
  changed();
  api.putBehaviour(row.id, value).then(
    (saved) => {
      if (!current()) return;
      turn += 1;
      swap(saved);
      cacheChatPref(saved);
      flash(saved.done ? doneToast(saved.name, saved.done, saved.switch) : "Saved.");
    },
    (error: unknown) => {
      if (!current()) return;
      turn += 1;
      // A refused switch is read again below rather than set back to the row as the tap found it.
      if (!isSwitch) swap(row);
      // The Mac may still act on the tap after the server stopped waiting; its report lands a moment later.
      if (error instanceof api.ApiError && error.status === 504) {
        flash("The Mac didn't answer in time. It may have gone through.", "error");
        setTimeout(() => {
          if (current()) void loadBehaviours();
        }, LATE_READ_MS);
        return;
      }
      if (api.needsPasskey(error)) setSignedInByCode(true);
      else refused(error);
      // A failed save may still have landed (a cut-off), and a refused switch's file may have moved: read what the
      // server holds now.
      void loadBehaviours();
    },
  ).finally(() => {
    if (!current()) return;
    saving.delete(row.id);
    changed();
  });
}

function saveSendDelay(next: ChatSendDelay): void {
  const previous = sendDelay;
  if (!previous || saving.has("chat.send-delay")) return;
  saving.add("chat.send-delay");
  turn += 1;
  const current = sameSession();
  sendDelay = next;
  changed();
  api.putChatSendDelay(next).then(
    (saved) => {
      if (!current()) return;
      turn += 1;
      const parsed = chatSendDelaySchema.safeParse(saved);
      sendDelay = parsed.success ? parsed.data : next;
      flash("Saved.");
    },
    (error: unknown) => {
      if (!current()) return;
      turn += 1;
      sendDelay = previous;
      refused(error);
      void loadBehaviours();
    },
  ).finally(() => {
    if (!current()) return;
    saving.delete("chat.send-delay");
    changed();
  });
}

function doneToast(name: string, done: SwitchDone, file: SwitchState | undefined): string {
  switch (done) {
    case "already-paused":
      return file?.state === "other" ? `${name} was already paused by other words: ${file.line}` : `${name} is paused.`;
    case "paused":
      return `${name} is paused.`;
    case "resumed":
    case "already-on":
      return `${name} is on.`;
    case "paused-then-stopped":
      return "Paused. The alarm stopped work too.";
  }
}

/** What a switch row says under its line, or null when the switch is free to use. */
function switchNote(state: SwitchState): string | null {
  switch (state.state) {
    case "offline":
      return "Mac not connected";
    case "stopped":
      return "Stopped by the alarm";
    case "other":
      return `Paused: ${state.line}`;
    default:
      return null;
  }
}

/** The switch drawn 26px tall inside a label a finger's width each way, which takes the tap. */
function toggle(name: string, on: boolean, disabled: boolean, onChange?: (on: boolean) => void): HTMLElement {
  const input = h("input", { class: "bhv-switch", attrs: { type: "checkbox", role: "switch", "aria-label": name, "data-use": "settings.behaviours.toggle" } });
  input.checked = on;
  input.disabled = disabled;
  if (onChange) input.addEventListener("change", () => onChange(input.checked));
  return h("label", { class: "bhv-hit" }, input);
}

function chip(text: string): HTMLElement {
  return h("span", { class: "bhv-chip" }, text);
}

function secondsChip(delay: ChatSendDelay, disabled: boolean): HTMLElement {
  const select = h(
    "select",
    { class: "bhv-chip", attrs: { "aria-label": "Send delay seconds", "data-use": "settings.behaviours.knob" } },
    ...CHAT_SEND_DELAY_SECONDS.map((seconds) => h("option", { attrs: { value: String(seconds) } }, `${seconds} s`)),
  );
  select.value = String(delay.seconds);
  select.disabled = disabled;
  select.addEventListener("change", () => saveSendDelay({ ...delay, seconds: Number(select.value) as ChatSendDelay["seconds"] }));
  return select;
}

/** The Promise keeper's warning, in minutes before the promised time. */
export const WARN_MINUTES = [5, 10, 15, 30, 60] as const;

function warnChip(row: BehaviourRow, disabled: boolean): HTMLElement {
  const now = typeof row.value?.warnMinutes === "number" ? row.value.warnMinutes : DEFAULT_PROMISE_KEEPER.warnMinutes;
  // A value set some other way (the API takes 1 to 120) stays listed, so the chip never shows a time it is not.
  const choices = [...new Set([...WARN_MINUTES, now])].sort((a, b) => a - b);
  const select = h(
    "select",
    { class: "bhv-chip", attrs: { "aria-label": `${row.name}: minutes before`, "data-use": "settings.behaviours.knob" } },
    ...choices.map((minutes) => h("option", { attrs: { value: String(minutes) } }, `${minutes} min before`)),
  );
  select.value = String(now);
  select.disabled = disabled;
  select.addEventListener("change", () => saveRow(row, { ...row.value, warnMinutes: Number(select.value) }));
  return select;
}

function choiceChip(row: BehaviourRow, choices: BehaviourChoices, disabled: boolean): HTMLElement {
  const select = h(
    "select",
    { class: "bhv-chip", attrs: { "aria-label": choices.label ?? row.name, "data-use": "settings.behaviours.knob" } },
    ...choices.options.map((option) => h("option", { attrs: { value: String(option.value) } }, option.label)),
  );
  select.value = String(row.value?.[choices.key]);
  select.disabled = disabled;
  select.addEventListener("change", () => {
    // The option's own value, a number kept a number.
    const picked = choices.options.find((option) => String(option.value) === select.value)?.value ?? select.value;
    saveRow(row, choices.switch ? { ...row.value, [choices.key]: picked } : { [choices.key]: picked });
  });
  return select;
}

/** The row's chip and control, or null for a row that stays hidden. */
function side(row: BehaviourRow, open: (section: BehaviourSection) => void): HTMLElement[] | null {
  const busy = saving.has(row.id) || locked(row);
  switch (row.control) {
    case "endpoint": {
      if (row.id !== "chat.send-delay") return null;
      if (!sendDelay)
        return sendDelayFailed
          ? [h("span", { class: "bhv-note" }, "Couldn't load"), button("Retry", () => void loadBehaviours(), "ghost bhv-open", false, "settings.behaviours.retry")]
          : null;
      const delay = sendDelay;
      return [secondsChip(delay, busy), toggle(row.name, delay.on, busy, (on) => saveSendDelay({ ...delay, on }))];
    }
    case "live": {
      // A pick with no switch stands in place of the on and off switch; one with `switch` sits beside it.
      if (row.choices && !row.choices.switch) return [choiceChip(row, row.choices, busy)];
      const key = row.switchKey ?? "on";
      const knob = row.id === PROMISE_KEEPER_ID ? [warnChip(row, busy)] : row.choices ? [choiceChip(row, row.choices, busy)] : row.chip ? [chip(row.chip)] : [];
      return [...knob, toggle(row.name, row.value?.[key] === true, busy, (next) => saveRow(row, { ...row.value, [key]: next }))];
    }
    case "switch": {
      const state = row.switch ?? { state: "offline" };
      const free = state.state === "absent" || state.state === "ours";
      return [toggle(row.name, row.value?.on === true, busy || !free, (next) => saveRow(row, { on: next }))];
    }
    case "linked":
      return row.link ? [button("Open", () => open(row.link!), "ghost bhv-open", false, "settings.behaviours.open")] : [];
    case "always-on":
      return row.note ? [h("span", { class: "bhv-note" }, row.note)] : [h("span", { class: "bhv-note" }, "always on"), toggle(row.name, true, true)];
    case "report":
      return row.report ? [] : null;
  }
}

/** A live row's knobs under it: each label with its select, or with a note where it has one choice. */
function knobs(row: BehaviourRow): HTMLElement | null {
  if (row.control !== "live" || !row.selects?.length) return null;
  const disabled = saving.has(row.id) || locked(row) || (!row.switchKey && row.value?.on !== true);
  return h(
    "div",
    { class: "bhv-knobs" },
    ...row.selects.map((select) => {
      const only = select.choices.length === 1 ? select.choices[0]! : null;
      let control: HTMLElement;
      if (only) control = h("span", { class: "bhv-note" }, `${only.label} only`);
      else {
        const input = h(
          "select",
          { class: "bhv-chip", attrs: { "aria-label": select.label, "data-use": "settings.behaviours.knob" } },
          ...select.choices.map((choice) => h("option", { attrs: { value: String(choice.value) } }, choice.label)),
        );
        input.value = String(row.value?.[select.knob]);
        input.disabled = disabled;
        input.addEventListener("change", () => {
          const picked = select.choices.find((choice) => String(choice.value) === input.value)?.value ?? input.value;
          saveRow(row, { ...row.value, [select.knob]: picked });
        });
        control = input;
      }
      return h("div", { class: "bhv-knob", attrs: { "data-knob": select.knob } }, h("span", { class: "bhv-knob-label" }, select.label), control);
    }),
  );
}

function rowView(row: BehaviourRow, open: (section: BehaviourSection) => void): HTMLElement | null {
  const right = side(row, open);
  if (!right) return null;
  const under = knobs(row);
  const note = row.control === "switch" ? switchNote(row.switch ?? { state: "offline" }) : (row.report?.note ?? null);
  return h(
    "div",
    { class: under ? "bhv-row bhv-row-knobs" : "bhv-row", attrs: { "data-id": row.id } },
    h(
      "div",
      { class: "bhv-text" },
      h("p", { class: "bhv-name" }, row.name, row.scope === "private" && row.group !== "Yours only" ? h("span", { class: "bhv-tag" }, "Yours only") : null),
      h("p", { class: "bhv-line" }, row.line),
      note ? h("p", { class: "bhv-state" }, note) : null,
      row.report?.detail ? h("p", { class: "bhv-state" }, row.report.detail) : null,
      locked(row) ? h("p", { class: "bhv-state" }, BEHAVIOUR_NEEDS_PASSKEY) : null,
    ),
    h("div", { class: "bhv-side" }, ...right),
    under,
  );
}

/** While the tab is on screen its rows are read again now and then, so a STOP or a Mac going away shows. */
function keepReading(): void {
  if (rereader) return;
  rereader = setInterval(() => {
    const panel = document.querySelector("[data-behaviours]");
    if (!panel) {
      clearInterval(rereader!);
      rereader = null;
    } else if (document.visibilityState === "visible" && !saving.size) void loadBehaviours(true);
  }, REREAD_MS);
}

function failedLoad(text: string): HTMLElement {
  return h(
    "section",
    { class: "panel box", attrs: { "data-behaviours": "" } },
    h("p", { class: "panel-text" }, text),
    loadError ? button("Try again", () => void loadBehaviours(), "big", false, "settings.behaviours.retry") : null,
  );
}

export function behavioursPanel(open: (section: BehaviourSection) => void): HTMLElement {
  keepReading();
  if (!rows) return failedLoad(loadError ?? "Loading…");
  const shown = rows;
  return h(
    "div",
    { class: "bhv", attrs: { "data-behaviours": "" } },
    loadError ? failedLoad(`${loadError} These may be out of date.`) : null,
    ...BEHAVIOUR_GROUPS.flatMap((group) => {
      const items = shown.filter((row) => row.group === group).map((row) => rowView(row, open)).filter((item): item is HTMLElement => item !== null);
      if (!items.length) return [];
      return [h("h4", { class: "bhv-group" }, group), h("section", { class: "panel box bhv-list", attrs: { "data-group": group } }, ...items)];
    }),
  );
}
