import "./scheduled.css";

import { FINAL_STATUSES, type AuditEntry } from "../../../src/shared/command.js";
import { jobScheduleKey, type Job, type JobRun, type JobsResponse } from "../../../src/shared/jobs.js";
import { RIVET_NAME } from "../../../src/shared/names.js";
import { opsStatusKey } from "../../../src/shared/ops-status-key.js";
import { when } from "../../../src/shared/when.js";
import { NO_REPO } from "../../../src/shared/repos.js";
import { ApiError, call } from "../api.js";
import * as cmd from "../command-api.js";
import { button, describe, h, keepFocus } from "../dom.js";
import { changed, sameSession, signedOut, subscribe } from "../state.js";
import { watchOps } from "../ops-data.js";
import { onSessionReset } from "../session.js";
import { bringBack, dismissable, dismissed, dismissItem, owned, parked, type FailedItem } from "./ops-status.js";
import { openSheet } from "./sheet.js";

// Your own jobs, set by Rivet from your words once you say Yes on its confirm card. They have no page: the status line
// counts the red ones and opens them in a sheet, where the phone pauses, runs or deletes one; what each run did comes
// from the server, which counts a run that never reported as missed. A red job an agent is on is amber; one nobody is
// on can be dismissed.

export const jobsApi = {
  // An answer without its list (a proxy's page, a preview stub) is a failed load, as Schedules does.
  get: () => call<JobsResponse>("GET", "/api/jobs").then((answer) => (Array.isArray(answer?.jobs) ? answer : Promise.reject(new Error("Jobs answered without its list.")))),
  change: (id: string, op: "pause" | "resume" | "run", clientId: string) => call<AuditEntry>("PATCH", `/api/jobs/${id}`, { clientId, op }),
  remove: (id: string, clientId: string) => call<AuditEntry>("DELETE", `/api/jobs/${id}`, { clientId }),
};

type Op = "pause" | "resume" | "run" | "remove";

let jobs: JobsResponse | null = null;
let loadError: string | null = null;
/** What each job's last button is doing or did, by job id. */
const pending = new Map<string, { text: string; tone: "wait" | "ok" | "bad" }>();
onSessionReset(() => {
  jobs = null;
  loadError = null;
  pending.clear();
});

export const RUN_WORDS: Record<JobRun["result"], string> = { running: "Running", green: "Passed", red: "Red", skipped: "Skipped", missed: "Missed" };
const RUN_TONE: Record<JobRun["result"], "ok" | "bad" | "idle"> = { running: "idle", green: "ok", red: "bad", skipped: "idle", missed: "bad" };

/** The jobs as last read, or null before a read worked. */
export function jobsView(): JobsResponse | null {
  return jobs;
}

/** On and red last time: the status line counts these and the red jobs sheet lists them. */
export const jobRed = (job: Job) => job.state === "active" && job.redStreak > 0;

/**
 * A red job as an Ops item, under its schedule record's key (shared/jobs.ts jobScheduleKey), so being on it and Dismiss
 * work as for any red. Its mark holds the streak's start: a new red streak is red again.
 */
export function jobItem(job: Job): FailedItem | null {
  if (!jobRed(job)) return null;
  return { kind: "schedule", key: opsStatusKey("schedule", jobScheduleKey(job.id)), repo: NO_REPO, title: job.name, what: [job.words], failedAt: job.redSince ?? job.lastRun?.at ?? null, url: job.lastRun?.url ?? null };
}

/** Red with an agent on it: amber, never red. Whether a parked record holds a job is the server's call: only it reads the runs. */
export const jobMine = (job: Job) => jobRed(job) && (job.owned || (owned(jobItem(job)) && !parked(jobItem(job))));

/** Red and dismissed by you, this streak: in no count and no mark. */
export const jobDismissed = (job: Job) => dismissed(jobItem(job));

/** Red with nobody on it and not dismissed: the Ops mark and the status line count only these as broken. */
export const jobLoose = (job: Job) => jobRed(job) && !jobMine(job) && !jobDismissed(job);

const shown = (view: JobsResponse | null) => JSON.stringify(view && { jobs: view.jobs, limits: view.limits });

/** Reads the jobs; the app redraws only when what it shows changed, as the status line polls this every minute. */
export async function loadJobs(): Promise<void> {
  const current = sameSession();
  const was = `${shown(jobs)}${loadError}`;
  try {
    const next = await jobsApi.get();
    if (!current()) return;
    jobs = next;
    loadError = null;
  } catch (failure) {
    if (!current()) return;
    loadError = failure instanceof Error ? failure.message : "Couldn't read the jobs.";
  }
  if (`${shown(jobs)}${loadError}` !== was) changed();
}

const VERB: Record<Op, string> = { pause: "Pausing", resume: "Resuming", run: "Starting", remove: "Deleting" };

function send(job: Job, op: Op): void {
  const clientId = `job-${op}-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  pending.set(job.id, { text: `${VERB[op]}…`, tone: "wait" });
  changed();
  const settle = (entry: AuditEntry) => {
    const ok = entry.status === "succeeded";
    pending.set(job.id, { text: entry.detail?.reason ?? (ok ? "Done." : "The Mac did not do it."), tone: ok ? "ok" : "bad" });
    void loadJobs();
  };
  (op === "remove" ? jobsApi.remove(job.id, clientId) : jobsApi.change(job.id, op, clientId)).then(
    (entry) => {
      void loadJobs();
      if (FINAL_STATUSES.has(entry.status)) return settle(entry);
      const stop = cmd.followAction(
        entry.id,
        (next) => {
          if (!FINAL_STATUSES.has(next.status)) return;
          stop();
          settle(next);
        },
        1500,
        (status) => {
          pending.set(job.id, { text: "Lost track of this; the list shows how it stands at the next read.", tone: "bad" });
          changed();
          if (status === 401) signedOut("Your session ended. Sign in again.");
        },
      );
    },
    (failure: unknown) => {
      if (failure instanceof ApiError && failure.status === 401) {
        pending.delete(job.id);
        changed();
        signedOut("Your session ended. Sign in again.");
        return;
      }
      pending.set(job.id, { text: failure instanceof ApiError && failure.status === 503 ? "The Mac is offline. Try again when the bridge is back." : describe(failure), tone: "bad" });
      changed();
    },
  );
}

/** Pause and Delete ask once; Run now and Resume go at once. */
function ask(job: Job, op: "pause" | "remove"): void {
  const title = op === "pause" ? `Pause ${job.name}?` : `Delete ${job.name}?`;
  openSheet(
    title,
    {
      mount(el) {
        const go = button(op === "pause" ? "Pause it" : "Delete it", () => {
          go.disabled = true;
          // Back to Red jobs, so the job's row shows how the change went (a failed Delete included).
          openRedJobs();
          send(job, op);
        }, "big", false, "scheduled.confirm");
        el.replaceChildren(
          h(
            "div",
            { class: "job-confirm" },
            h("p", {}, op === "pause" ? "It does not run until you resume it. A run already going finishes." : `Its automation goes too. ${RIVET_NAME} can set it again from your words.`),
            go,
          ),
        );
      },
      unmount() {},
    },
    "Cancel",
    undefined,
    { use: "scheduled.ask" },
  );
}

function lastText(run: JobRun | null, now: number): string {
  if (!run) return "No run yet";
  return `${RUN_WORDS[run.result]}${run.manual ? " (run by hand)" : ""} ${when(run.finishedAt ?? run.at, now)}`;
}

function jobEl(job: Job, now: number): HTMLElement {
  const paused = job.state === "paused";
  const removing = job.state === "removing";
  const last = job.lastRun;
  const item = jobItem(job);
  const mine = jobMine(job);
  const gone = !mine && jobDismissed(job);
  const runTone = paused || removing ? "idle" : last ? RUN_TONE[last.result] : "idle";
  const tone = runTone !== "bad" || !item ? runTone : gone ? "idle" : mine ? "warn" : "bad";
  const busy = pending.get(job.id)?.tone === "wait";
  const status = pending.get(job.id) ?? (removing ? { text: "Deleting: waiting for the Mac to remove its automation.", tone: "wait" } : job.note ? { text: job.note, tone: "bad" } : undefined);
  const cadence = `${job.whenText} · ${job.kind === "task" ? "a chat" : "on the Mac"} · ${job.cards === "every" ? "card every run" : "card only if red"}`;
  return h(
    "li",
    { class: `job${paused ? " paused" : ""}`, attrs: { "data-job": job.id } },
    h("div", { class: "job-head" }, h("span", { class: `ops-dot t-${tone}`, attrs: { "aria-hidden": "true" } }), h("span", { class: "job-name" }, job.name), paused ? h("span", { class: "job-paused" }, "Paused") : null),
    h("p", { class: "job-words" }, `“${job.words}”`),
    h("p", { class: "job-when" }, cadence),
    h("p", { class: `job-last t-${tone}` }, `Last: ${lastText(last, now)}${job.redStreak > 1 ? ` (${job.redStreak} in a row)` : ""}${item && mine ? " · an agent is on it" : gone ? " · dismissed" : ""}`),
    last?.line && last.result !== "green" ? h("p", { class: "job-line" }, last.line) : null,
    h("p", { class: "job-next" }, paused ? "Next: paused" : job.nextRun ? `Next: ${when(job.nextRun, now)}` : "Next: none"),
    status ? h("p", { class: `job-status ${status.tone}`, attrs: { role: "status" } }, status.text) : null,
    h(
      "div",
      { class: "job-actions" },
      button(paused ? "Resume" : "Pause", () => (paused ? send(job, "resume") : ask(job, "pause")), "", busy || removing, paused ? "scheduled.resume" : "scheduled.pause"),
      button("Run now", () => send(job, "run"), "", busy || paused || removing, "scheduled.run-now"),
      button("Delete", () => ask(job, "remove"), "ghost", busy, "scheduled.delete"),
      // A red nobody is on can be dismissed; one dismissed comes back with a tap.
      gone ? button("Bring back", () => bringBack(item!), "ghost job-bring-back", false, "scheduled.bring-back") : !mine && dismissable(item) ? button("Dismiss", () => dismissItem(item), "ghost job-dismiss", false, "scheduled.dismiss") : null,
    ),
  );
}

/** The red jobs, each with its buttons; empty once none is red. */
export function redJobsEl(): HTMLElement {
  const red = (jobs?.jobs ?? []).filter(jobRed).sort((a, b) => a.name.localeCompare(b.name));
  const now = Date.now();
  if (!jobs) return h("p", { class: "empty" }, loadError ? `Couldn't read the jobs: ${loadError}` : "Loading…");
  return h(
    "section",
    { class: "ops-list", attrs: { "data-section": "jobs" } },
    red.length ? h("ul", { class: "jobs" }, ...red.map((job) => jobEl(job, now))) : h("p", { class: "empty" }, "No job is red now."),
    loadError ? h("p", { class: "jobs-limits" }, `Couldn't read the jobs again: ${loadError}`) : null,
  );
}

/** The status line's "N jobs red": those jobs in a sheet, redrawn as a run or a button changes them. */
export function openRedJobs(): void {
  let stop = () => {};
  openSheet(
    "Red jobs",
    {
      mount(el) {
        const paint = () => {
          const refocus = keepFocus(el);
          el.replaceChildren(redJobsEl());
          refocus();
        };
        // A Dismiss or Bring back changes Ops data, not app state: listen to both, as the Floor does (review R4.1).
        const stops = [subscribe(paint), watchOps(paint)];
        stop = () => stops.forEach((one) => one());
        paint();
        void loadJobs();
      },
      unmount: () => stop(),
    },
    "Close",
    undefined,
    { use: "jobs.red" },
  );
}

/** Tests and previews: forget what was read. */
export function resetScheduled(view: JobsResponse | null = null): void {
  jobs = view;
  loadError = null;
  pending.clear();
}
