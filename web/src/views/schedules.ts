import { SCHEDULES_STALE_MS, type Schedule, type SchedulesResponse } from "../../../src/shared/schedules.js";
import { call } from "../api.js";
import { when } from "../../../src/shared/when.js";

// The timed jobs, read live by the Mac bridge from launchd and GitHub; Ops Machines lists them read-only and the status
// line counts the failing ones.

export const RESULT_WORDS: Record<NonNullable<Schedule["lastRun"]>["result"], string> = {
  ok: "OK",
  failed: "Failed",
  skipped: "Skipped",
  running: "Running",
  unknown: "Not known",
};

export const scheduleApi = {
  // An answer without its list (a proxy's page, a preview stub) is a failed load, not one the line and Ops crash on.
  get: () =>
    call<SchedulesResponse>("GET", "/api/schedules").then((answer) =>
      Array.isArray(answer?.items) ? answer : Promise.reject(new Error("Schedules answered without its list.")),
    ),
};

/** On and failed last time: Ops lists these first and the status line counts them. */
export const needsLook = (item: Schedule) => item.on && item.lastRun?.result === "failed";

/** Stale is judged again on the device: a refresh that fails keeps the last answer, whose own flag ages. */
export function schedulesStale(view: SchedulesResponse): boolean {
  return view.stale || (view.at !== null && Date.now() - Date.parse(view.at) > SCHEDULES_STALE_MS);
}

/** One schedule as Machines lists it: its name, its next run and its last result, failing ones first. */
export interface ScheduleLine {
  id: string;
  name: string;
  next: string;
  last: string;
  tone: "bad" | "ok" | "idle";
}

export function scheduleLines(view: SchedulesResponse, now = Date.now()): ScheduleLine[] {
  const line = (item: Schedule): ScheduleLine => {
    const last = item.lastRun;
    return {
      id: item.id,
      name: item.name,
      next: !item.on ? "Off" : item.nextRun ? `next ${when(item.nextRun, now)}` : item.group === "always-on" ? "Always on" : "No next run",
      last: last ? `${RESULT_WORDS[last.result]}${last.at ? ` ${when(last.at, now)}` : ""}` : "No run yet",
      tone: needsLook(item) ? "bad" : item.on && last?.result === "ok" ? "ok" : "idle",
    };
  };
  return [...view.items].sort((a, b) => Number(needsLook(b)) - Number(needsLook(a)) || a.name.localeCompare(b.name)).map(line);
}
