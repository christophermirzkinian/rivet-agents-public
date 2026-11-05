import { brokenOnMain } from "../../../src/shared/ops.js";
import { maybeWhen, when } from "../../../src/shared/when.js";
import { isGotIt } from "../../../src/shared/answers.js";
import { needYou } from "../../../src/shared/words.js";
import { failingStreak, type Schedule, type SchedulesResponse } from "../../../src/shared/schedules.js";
import { isDesk } from "../desk.js";
import { h, keepFocus } from "../dom.js";
import { ciCurrent, failingSchedules, freshPrs, githubCurrent, opsData, watchOps } from "../ops-data.js";
import { app, changed, deck, subscribe, workingCount } from "../state.js";
import { focusSection, usageStale, weekTotal } from "./ops.js";
import { showChats, showList } from "./feed.js";
import { owned, parked, prItem, scheduleItem } from "./ops-status.js";
import { scheduleApi, schedulesStale } from "./schedules.js";
import { jobDismissed, jobLoose, jobRed, jobsView, loadJobs, openRedJobs } from "./scheduled.js";
import { onSessionReset } from "../session.js";

// The "where are we" line at the top of the empty Feed: the numbers the Feed, Ops, the chats list and Schedules already
// show, one tap each to that screen. Nothing in it is written by Rivet.

const SCHEDULES_POLL_MS = 60_000;

export interface StatusPart {
  key: "cards" | "prs" | "chats" | "jobs" | "claude";
  text: string;
  /** The same in fewer words, for the Floor's band at 320; `text` stays its label. */
  short: string;
  /** Red only for your own jobs (the Red jobs sheet): breaks are Rivet's job and live on Plan. */
  tone: "ok" | "info" | "warn" | "bad";
  /** The cards waiting: the way to the Feed, so it stands out. */
  lead?: boolean;
  open(): void;
}

let schedules: SchedulesResponse | null = null;
onSessionReset(() => {
  schedules = null;
});

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The failing schedules in the line's own current list, by the server's own test, null before one loads or once it is old. */
function failingList() {
  const now = new Date();
  return schedules && !schedulesStale(schedules) ? schedules.items.filter((item) => failingStreak(item, now)) : null;
}

/**
 * Whether Ops' count of failing schedules is all owned. The server's count names no schedule, so it is only when the
 * line's list, less what the server leaves out as already red CI, is exactly that many and every one has an agent on it.
 */
export function schedulesOwned(count: number): boolean {
  const counted = countedSchedules();
  return !!count && counted !== null && counted.length === count && counted.every((schedule) => owned(scheduleItem(schedule)));
}

/** The failing schedules Ops counts: the line's current list, less those already red CI; null without a current list. */
export function countedSchedules(): Schedule[] | null {
  const failing = failingList();
  const ops = opsData.ops;
  if (!failing || !ops) return null;
  const now = new Date();
  const red = ciCurrent(ops) ? brokenOnMain(ops.github?.runs ?? []) : [];
  return failing.filter((item) => {
    const url = failingStreak(item, now)?.newest.url ?? null;
    return url === null || !red.some((run) => run.url === url);
  });
}

/** A part red while something in it is nobody's. All of it owned is amber, "· agents on it". */
function redPart(text: string, red: number, mine: number, otherwise: StatusPart["tone"]): Pick<StatusPart, "text" | "tone"> {
  if (red > mine) return { text, tone: "bad" };
  if (red && mine) return { text: `${text} · agents on it`, tone: "warn" };
  return { text, tone: otherwise };
}

/** The line's parts, in order; one whose numbers have not loaded is left out. */
export function statusParts(): StatusPart[] {
  const parts: StatusPart[] = [];
  // A Got it card is news on the Feed, never one that needs you (state.needsYou).
  const cards = deck().filter((need) => !isGotIt(need)).length;
  // With none, the empty state under the line says Nothing needs you, once; on a phone the dock's Decide N says it.
  if (cards && isDesk()) parts.push({ key: "cards", text: `${needYou(cards)} →`, short: needYou(cards), tone: "warn", lead: true, open: () => showList() });
  const ops = opsData.ops;
  const gh = ops?.github ?? null;
  if (gh && !githubCurrent(ops!)) {
    // An old snapshot's counts are not a reading: it says so instead of showing them frozen (a dead bridge).
    parts.push({ key: "prs", text: `GitHub: no reading since ${when(gh.at)}`, short: "GitHub: no reading", tone: "warn", open: () => focusSection("prs") });
  } else if (gh) {
    // As Ops does: a source GitHub did not answer says so, and is never shown as fine.
    const ci = ciCurrent(ops!);
    const prsFailed = gh.sources?.prs.failed.length ? gh.sources.prs : null;
    const runsFailed = !ci;
    const currentPrs = freshPrs(ops!) ?? [];
    const partial = gh.prsComplete !== true || !!prsFailed;
    const prs = prsFailed && !currentPrs.length ? "PRs unknown" : `${plural(currentPrs.length, "PR")} ${partial ? "shown (partial)" : "open"}${prsFailed ? ", some PRs unavailable" : ""}`;
    // A red PR or red CI is no part of the line: Plan says who is fixing it and by when.
    const parkedPrs = currentPrs.filter((pr) => parked(prItem(pr))).length;
    parts.push({
      key: "prs",
      text: [prs, runsFailed ? "CI unknown" : null, parkedPrs ? `${parkedPrs} parked` : null].filter(Boolean).join(", "),
      short: [
        prsFailed && !currentPrs.length ? "PRs unknown" : `${plural(currentPrs.length, "PR")}${partial ? " (partial)" : ""}`,
        runsFailed ? "CI unknown" : null,
        parkedPrs ? `${parkedPrs} parked` : null,
      ]
        .filter(Boolean)
        .join(", "),
      tone: prsFailed || runsFailed || partial ? "warn" : "ok",
      open: () => focusSection("prs"),
    });
  }
  if (app.workers) parts.push({ key: "chats", text: `${plural(workingCount(), "chat")} working`, short: plural(workingCount(), "chat"), tone: "ok", open: () => showChats() });
  // Your own jobs: a red one already has its card, so this is only the way to the page.
  const redJobs = jobsView()?.jobs.filter((job) => jobRed(job) && !jobDismissed(job)) ?? [];
  if (redJobs.length) parts.push({ key: "jobs", ...redPart(`${plural(redJobs.length, "job")} red`, redJobs.length, redJobs.filter((job) => !jobLoose(job)).length, "ok"), short: `${plural(redJobs.length, "job")} red`, open: openRedJobs });
  const usage = ops?.claude;
  const week = usage ? weekTotal(usage.limits) : null;
  if (usage && week) {
    // As the Ops tile does: every account's week out of the total; an old reading says how old, never fine.
    const stale = usageStale(usage);
    parts.push({
      key: "claude",
      text: `Claude: ${week.text}${stale ? `, read ${maybeWhen(usage.at) ?? "earlier"}` : ""}`,
      short: `Claude ${week.n} ${week.of}${stale ? ", old" : ""}`,
      tone: (stale && week.tone === "ok") || week.tone === "bad" ? "warn" : week.tone,
      open: () => focusSection("claude"),
    });
  }
  return parts;
}

// Made on first use: this module may load where there is no document.
let made: HTMLElement | null = null;
function element(): HTMLElement {
  made ??= h("nav", { class: "status-line", attrs: { "aria-label": "Where things stand" } });
  return made;
}

const painters = new Set<() => void>();

/** Runs `painter` each time the line repaints, while anything holds the line; returns the way to stop. */
export function onStatusPaint(painter: () => void): () => void {
  painters.add(painter);
  return () => painters.delete(painter);
}

function paint(): void {
  for (const painter of painters) painter();
  const line = element();
  const refocus = keepFocus(line);
  line.replaceChildren(
    ...statusParts().map((part) =>
      h(
        "button",
        { class: `status-part t-${part.tone}${part.lead ? " is-lead" : ""}`, attrs: { type: "button", "data-key": `status-${part.key}`, "data-use": `status.${part.key}` }, on: { click: part.open } },
        part.text,
      ),
    ),
  );
  refocus();
}

async function loadSchedules(): Promise<void> {
  const count = () => (opsData.ops?.summary ? failingSchedules(opsData.ops) : 0);
  const named = () => (countedSchedules() ?? []).map((schedule) => schedule.id).join("|");
  const was = schedulesOwned(count());
  const wasNamed = named();
  try {
    schedules = await scheduleApi.get();
  } catch {
    // The line leaves the part out until a load works; the Schedules tab says why.
    return;
  }
  // Plan reads the list too, and lists each failing one under Being done.
  if (schedulesOwned(count()) !== was || named() !== wasNamed) changed();
  else paint();
}

let holders = 0;
let stop: (() => void) | null = null;

/** The line, kept live while anything holds it: every holder lets go with releaseStatusLine. */
export function holdStatusLine(): HTMLElement {
  if (holders++ === 0) {
    const unsubscribe = subscribe(paint);
    const unwatch = watchOps(paint);
    void loadSchedules();
    void loadJobs();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void loadSchedules();
      void loadJobs();
    }, SCHEDULES_POLL_MS);
    stop = () => {
      unsubscribe();
      unwatch();
      window.clearInterval(timer);
    };
  }
  paint();
  return element();
}

export function releaseStatusLine(): void {
  if (holders === 0 || --holders > 0) return;
  stop?.();
  stop = null;
}

/** The line as it stands, for a view that redraws while it holds it. */
export function statusLine(): HTMLElement {
  return element();
}
