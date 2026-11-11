import { FINAL_STATUSES, type AuditEntry } from "../../../src/shared/command.js";
import {
  EFFORT_LABELS,
  effortOnModel,
  effortsFor,
  modelLabel,
  type ModelJob,
  type ModelJobKey,
  type ModelPick,
  type ModelPicks,
  type ModelSettingsResponse,
  type ModelStatus,
} from "../../../src/shared/models.js";
import { when } from "../../../src/shared/when.js";
import * as api from "../api.js";
import * as cmd from "../command-api.js";
import { button, describe, h } from "../dom.js";
import { onSessionReset, StaleSession } from "../session.js";
import { changed, sameSession, signedOut } from "../state.js";
import { flash } from "./toast.js";

// Settings › Who does what: the model and effort each kind of job runs on. Each change sends every pick to the
// Mac, which writes ~/.rivet/model-routing.json, reads it back and reports it; Saved is said only once the server's
// report carries that save. Every change sends all eight, so the rows stay shut until the screen knows what the Mac holds.

export const CONFIRM_MS = 20_000;
const CONFIRM_EVERY_MS = 1500;
export const UNREAD_EVERY_MS = 5000;
export const SAVED = "Saved. Applies at each chat's next start.";
export const UNCONFIRMED = "Sent to the Mac, not confirmed yet.";
export const ELSEWHERE = "Changed since on another screen.";
const FALLBACK_FRESH_MS = 24 * 60 * 60_000;
const SIGNED_OUT = "Your session ended. Sign in again.";

let models: ModelSettingsResponse | null = null;
/** What the selects show: the Mac's picks, or a change on its way to it. */
let picks: ModelPicks | null = null;
let loadError: string | null = null;
let saving = false;
/** Bumped by every read and every save; also each save's clientId key. */
let seq = 0;
/** The `seq` the latest save began at: a read begun before it never lands. */
let lastSave = 0;
/** The `seq` the latest read that landed began at: a read begun before it never lands. */
let landed = 0;
/** A save as it went: its once() key, the picks, and the save the view it was made from showed. */
interface Sent {
  key: string;
  picks: ModelPicks;
  base: string | null;
}
/**
 * A save whose outcome is not known: its action once the server has named it, and that action's final entry once it
 * has one. The rows stay shut until a report carries the action, or the server took a report after the final ack (the
 * Mac reports again after any ack but a success, so that report shows the file after the attempt).
 */
interface Unsure extends Sent {
  id: string | null;
  final: AuditEntry | null;
  sending: boolean;
}
let unsure: Unsure | null = null;
let unfollow = (): void => {};
let open = false;
let poll = 0;
onSessionReset(() => {
  models = null;
  picks = null;
  loadError = null;
  saving = false;
  lastSave = ++seq;
  unsure = null;
  unfollow();
  window.clearTimeout(poll);
});

/**
 * Whether a read begun at `started` may land: no save began after it, and no read begun after it has landed. The server
 * keeps only the Mac's newest report, so a read that lands shows the file as it is now, even one deleted or restored.
 */
export function readLands(started: number, latestSave: number, latestLanded: number): boolean {
  return started > latestSave && started > latestLanded;
}

/** Whether the server took this read's report after the save's final ack, so it shows the file after the attempt. */
const after = (read: ModelSettingsResponse, final: AuditEntry): boolean => !!read.reportedAt && Date.parse(read.reportedAt) > Date.parse(final.updatedAt);

/** A save turned away before anything was written (the Mac offline, or the server saying no), so the picks before it hold. */
export function refused(error: unknown): boolean {
  return error instanceof api.ApiError && (error.undelivered || (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429));
}

const editable = (): boolean => !!models?.reportedAt && !models.fileError && !unsure;

const shown = (settings: ModelSettingsResponse): ModelPicks =>
  Object.fromEntries(
    settings.jobs.map((job) => {
      const pick = settings.current?.[job.key];
      return [job.key, pick ? { model: pick.model, effort: pick.effort } : { model: job.models[0]!, effort: job.effort }];
    }),
  ) as ModelPicks;

/** Reads the server's view while Settings is open, again each UNREAD_EVERY_MS until the rows can be edited. */
export function loadModels(): Promise<void> {
  open = true;
  follow();
  return read();
}

export function closeModels(): void {
  open = false;
  unfollow();
  window.clearTimeout(poll);
}

async function read(): Promise<void> {
  window.clearTimeout(poll);
  const current = sameSession();
  const started = ++seq;
  try {
    const next = await api.getModelSettings();
    if (!current()) return;
    if (readLands(started, lastSave, landed)) {
      landed = started;
      models = next;
      loadError = null;
      if (unsure?.id && next.updated?.action === unsure.id) {
        unsure = null;
        unfollow();
        flash(SAVED);
      } else if (unsure?.final && after(next, unsure.final)) {
        // A save that succeeded and still isn't in the file was saved over by another screen's.
        if (unsure.final.status === "succeeded") flash(ELSEWHERE, "warn");
        unsure = null;
        unfollow();
      }
      if (!saving) picks = shown(next);
    }
  } catch (error) {
    if (!current()) return;
    if (error instanceof api.ApiError && error.status === 401) return signedOut(SIGNED_OUT);
    loadError = "Couldn't load who does what.";
  }
  window.clearTimeout(poll);
  if (open && !saving && !editable()) poll = window.setTimeout(tick, UNREAD_EVERY_MS);
  changed();
}

function tick(): void {
  if (unsure && !unsure.id && !unsure.sending) resend(unsure);
  void read();
}

/** The rows back on the server's view and shut until the save's own outcome is known. */
function doubt(sent: Sent, id: string | null, message: string, tone: "warn" | "error" = "warn", final: AuditEntry | null = null): void {
  saving = false;
  unsure = { ...sent, id, final, sending: false };
  if (models) picks = shown(models);
  flash(message, tone);
  follow();
  void read();
}

/** Follows the unsure save's action, with no cut-off, while Settings is open. */
function follow(): void {
  unfollow();
  unfollow = () => {};
  const pending = unsure;
  if (!open || !pending?.id || pending.final) return;
  unfollow = cmd.followAction(
    pending.id,
    (entry) => {
      if (unsure === pending && FINAL_STATUSES.has(entry.status)) ended(pending, entry);
    },
    CONFIRM_EVERY_MS,
    (status) => {
      if (unsure !== pending) return;
      if (status === 401) return signedOut(SIGNED_OUT);
      pending.id = null;
    },
  );
}

/** The unsure save's action is final: the rows wait for a report carrying it, or one the server took after this ack. */
function ended(pending: Unsure, entry: AuditEntry): void {
  pending.final = entry;
  if (entry.status !== "succeeded") flash(`Not saved: ${entry.detail?.reason ?? entry.status}`, "error");
  void read();
}

/** The same picks and base again under the same once() key, so a lost answer's clientId is reused and the server hands back its action. */
function resend(pending: Unsure): void {
  pending.sending = true;
  cmd.once(pending.key, (clientId) => api.postModels(clientId, pending.picks, pending.base)).then(
    (entry) => {
      pending.sending = false;
      if (unsure !== pending) return;
      pending.id = entry.id;
      if (FINAL_STATUSES.has(entry.status)) ended(pending, entry);
      else follow();
    },
    (error: unknown) => {
      pending.sending = false;
      if (error instanceof StaleSession || unsure !== pending) return;
      if (error instanceof api.ApiError && error.status === 401) return signedOut(SIGNED_OUT);
      if (!refused(error)) return;
      unsure = null;
      if (models) picks = shown(models);
      flash(`Not saved: ${describe(error)}`, "error");
      void read();
    },
  );
}

function save(next: ModelPicks): void {
  if (saving || !editable()) return;
  saving = true;
  const mine = ++seq;
  lastSave = mine;
  const previous = picks;
  const sent: Sent = { key: `models\n${mine}`, picks: next, base: models?.updated?.action ?? null };
  picks = next;
  changed();
  cmd.once(sent.key, (clientId) => api.postModels(clientId, sent.picks, sent.base)).then(
    (entry) => confirm(entry, mine, sent),
    (error: unknown) => {
      if (error instanceof StaleSession || mine !== lastSave) return;
      if (error instanceof api.ApiError && error.status === 401) {
        saving = false;
        return signedOut(SIGNED_OUT);
      }
      if (!refused(error)) return doubt(sent, null, `Not confirmed: ${describe(error)}`);
      saving = false;
      picks = previous;
      changed();
      flash(`Not saved: ${describe(error)}`, "error");
    },
  );
}

/** Waits for the Mac's ack, up to CONFIRM_MS, then for the server's report of it. */
function confirm(entry: AuditEntry, mine: number, sent: Sent): void {
  let stop = () => {};
  const timer = window.setTimeout(() => {
    stop();
    if (mine === lastSave) doubt(sent, entry.id, UNCONFIRMED);
  }, CONFIRM_MS);
  const settle = (done: AuditEntry) => {
    window.clearTimeout(timer);
    stop();
    if (mine !== lastSave) return;
    if (done.status === "succeeded") return void reported(done.id, mine, sent);
    doubt(sent, done.id, `Not saved: ${done.detail?.reason ?? done.status}`, "error", done);
  };
  if (FINAL_STATUSES.has(entry.status)) return settle(entry);
  stop = cmd.followAction(
    entry.id,
    (next) => {
      if (FINAL_STATUSES.has(next.status)) settle(next);
    },
    CONFIRM_EVERY_MS,
    (status) => {
      window.clearTimeout(timer);
      if (mine !== lastSave) return;
      if (status === 401) {
        saving = false;
        changed();
        return signedOut(SIGNED_OUT);
      }
      doubt(sent, null, UNCONFIRMED);
    },
  );
}

/** After a succeeded ack: reads until the server's report carries `action`, up to CONFIRM_MS, then follows it as unsure. */
async function reported(action: string, mine: number, sent: Sent): Promise<void> {
  const current = sameSession();
  const until = Date.now() + CONFIRM_MS;
  for (;;) {
    let next: ModelSettingsResponse | null = null;
    const started = ++seq;
    try {
      next = await api.getModelSettings();
    } catch (error) {
      if (current() && mine === lastSave && error instanceof api.ApiError && error.status === 401) {
        saving = false;
        return signedOut(SIGNED_OUT);
      }
    }
    if (!current() || mine !== lastSave) return;
    if (next?.updated?.action === action) {
      saving = false;
      unsure = null;
      if (landed > started) {
        // A read begun after this one already landed and holds the newer report: keep it. Unless it carries this save
        // too, or says the Mac can't read its file (the footer says so), another screen saved over this one meanwhile.
        if (models) picks = shown(models);
        if (models?.updated?.action === action) flash(SAVED);
        else if (!models?.fileError) flash(ELSEWHERE, "warn");
      } else {
        // A poll begun before this read holds an older report; it must not land over the save.
        landed = started;
        models = next;
        picks = shown(next);
        loadError = null;
        flash(SAVED);
      }
      // A read that landed while saving scheduled no poll; if the kept view is shut (say, a file the Mac can't read),
      // read again until it opens.
      window.clearTimeout(poll);
      if (open && !editable()) poll = window.setTimeout(tick, UNREAD_EVERY_MS);
      changed();
      return;
    }
    if (Date.now() >= until) return doubt(sent, action, UNCONFIRMED);
    await new Promise((resolve) => window.setTimeout(resolve, CONFIRM_EVERY_MS));
  }
}

function choose(
  label: string,
  options: readonly (readonly [string, string])[],
  value: string,
  disabled: boolean,
  job: ModelJobKey,
  part: "model" | "effort",
  onChange: (value: string) => void,
): HTMLElement {
  const select = h("select", { attrs: { "aria-label": label, "data-use": `settings.models.${job}.${part}` } }, ...options.map(([id, text]) => h("option", { attrs: { value: id } }, text)));
  select.value = value;
  select.disabled = disabled;
  select.addEventListener("change", () => onChange(select.value));
  return h("label", { class: "set-time" }, select);
}

/** A reason short and plain enough to say as it is, else the picked model is at its limit. */
function fallbackLine(pick: ModelPick, status: ModelStatus | undefined): string | null {
  if (!status || status.model === pick.model || !(Date.now() - Date.parse(status.at) < FALLBACK_FRESH_MS)) return null;
  const reason = status.reason.trim();
  const lead = /^[A-Za-z0-9 .,%'’()-]{4,80}$/.test(reason) ? (reason.endsWith(".") ? reason : `${reason}.`) : `${modelLabel(pick.model)} is at its limit.`;
  return `${lead} Using ${modelLabel(status.model)} until it drops.`;
}

function row(job: ModelJob, all: ModelPicks, status: ModelStatus | undefined, locked: boolean): HTMLElement {
  const pick = all[job.key];
  const only = job.models.length === 1;
  const set = (next: ModelPick) => save({ ...all, [job.key]: next });
  const model = choose(`${job.label} model`, job.models.map((id) => [id, modelLabel(id)] as const), pick.model, only || locked, job.key, "model", (id) =>
    set({ model: id, effort: effortOnModel(job, id, pick.effort) }),
  );
  const efforts = effortsFor(pick.model, job);
  const effort = choose(`${job.label} effort`, efforts.map((id) => [id, EFFORT_LABELS[id]] as const), pick.effort, locked || efforts.length === 1, job.key, "effort", (id) =>
    set({ model: pick.model, effort: id as ModelPick["effort"] }),
  );
  const note = fallbackLine(pick, status);
  return h(
    "div",
    { class: "mdl-row" },
    h("div", { class: "mdl-head" }, h("span", { class: "mdl-label" }, job.label), h("span", { class: "mdl-what" }, job.what)),
    h("div", { class: "set-times" }, model, effort),
    note
      ? h("p", { class: "set-state box t-warn mdl-note" }, note)
      : only
        ? h("p", { class: "mdl-only" }, `Only ${modelLabel(job.models[0]!)} runs these.`)
        : null,
  );
}

function footer(settings: ModelSettingsResponse): string {
  if (!settings.reportedAt) return "Not read from the Mac yet.";
  if (unsure) return "Checking what the Mac holds.";
  if (settings.fileError) return "Can't read the Mac's picks file, so changes wait until it can.";
  if (!settings.updated) return "On the defaults; nothing changed yet.";
  const by = settings.updated.by.startsWith("The owner") ? "The owner" : settings.updated.by;
  return `Changed ${when(settings.updated.at)} by ${by}.`;
}

export function modelSettings(): HTMLElement {
  const title = h("h3", { class: "panel-title" }, h("span", { class: "title-icon mdl-icon" }, "⚙"), "Who does what");
  if (!models || !picks)
    return h(
      "section",
      { class: "panel box mdl" },
      title,
      h("p", { class: "panel-text" }, loadError ?? "Loading…"),
      loadError ? button("Try again", () => void loadModels(), "big", false, "settings.models.retry") : null,
    );
  const all = picks;
  const status = models.status;
  const locked = saving || !editable();
  return h(
    "section",
    { class: "panel box mdl" },
    title,
    h("p", { class: "panel-text" }, "Pick who does each job. A change applies to each chat's next start, never mid-task."),
    h("div", { class: "mdl-cols" }, h("span", {}, "Model"), h("span", {}, "Effort")),
    ...models.jobs.map((job) => row(job, all, status[job.key], locked)),
    h("h4", { class: "set-sub" }, "Always on, whatever you pick"),
    h(
      "ul",
      { class: "mdl-guards" },
      h("li", {}, "A model at 85% steps aside for the next one."),
      h("li", {}, "Money, login and check changes get three reviews."),
      h("li", {}, "No pick can loosen the merge check."),
    ),
    h("p", { class: "panel-text mdl-foot" }, footer(models)),
  );
}
