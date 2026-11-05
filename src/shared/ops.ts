// Ops board types and the pure rules the server and the web app share. No zod here,
// so the web app can import it without bundling the schemas (they live in
// src/server/ops/schema.ts).

import type { NextRow } from "./ops-next.js";
import type { OwnedItem } from "./ops-owned.js";
import { dayClock, localDay, minuteOfDay, when } from "./when.js";

/** Below these fractions of a volume free, the disk shows amber, then red. */
export const DISK_WARN = 0.15;
export const DISK_BAD = 0.05;
/** A bridge snapshot older than this is shown as stale rather than as the present. */
export const GITHUB_STALE_MS = 5 * 60_000;
export const MAC_STALE_MS = 5 * 60_000;
export const FLY_STALE_MS = 20 * 60_000;
/** The bridge reads Claude usage every two minutes; a reading older than this is shown as stale. */
export const CLAUDE_STALE_MS = 10 * 60_000;
/** An app counts as down after this many failed health checks in a row. */
export const DOWN_AFTER_FAILS = 2;
export const TIMELINE_DAYS = 14;

export type Tone = "ok" | "warn" | "bad" | "info";
export type ChecksState = "pass" | "fail" | "pending" | "none";

export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  author: string;
  labels: string[];
  /** When the head commit was made; null when GitHub did not say. */
  headAt: string | null;
  updatedAt: string;
  /** The head branch, for a PR from this repo: a chat with it checked out owns the PR. */
  branch?: string;
  checks: { state: ChecksState; passed: number; failed: number; pending: number; failing: string[] };
  headSha?: string;
  /** The first hold in force from the PR's body, its newest comments and review summaries, or the merge holds file (bridge/lib/ops/github.mjs). */
  hold?: string;
  /** Every hold line in its own words when more than one holds it, up to twenty, so one is not lost behind another. */
  holds?: string[];
  /** When the CI run still going on the head started. */
  ciStartedAt?: string;
}

export interface WorkflowRun {
  repo: string;
  id: number;
  /** A rerun keeps the run id and bumps this. */
  attempt: number;
  workflow: string;
  title: string;
  status: string;
  conclusion: string | null;
  event: string;
  sha: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  /** Failed job names of a completed run that did not succeed. */
  failedJobs?: string[];
}

export interface RunnerLoad {
  /** Absent in older snapshots: completeness unknown. */
  complete?: boolean;
  /** Whether the capped detail list includes every runner. Separate from aggregate coverage. */
  detailsComplete?: boolean;
  online: number;
  busy: number;
  offline: number;
  runners: { name: string; status: "online" | "offline"; busy: boolean }[];
}

/** A runner offline this long is a retired one, not one that is down. */
export const RETIRED_RUNNER_MS = 7 * 86_400_000;

/**
 * When each listed runner first read offline in a row (server time); online and unlisted runners drop out. GitHub gives no
 * last-seen time, so a runner already offline when this was first kept counts from then.
 */
export function offlineSince(previous: Readonly<Record<string, string>>, runners: RunnerLoad, at: string): Record<string, string> {
  return Object.fromEntries(runners.runners.filter((runner) => runner.status === "offline").map((runner) => [runner.name, previous[runner.name] ?? at]));
}

export function retiredRunners(since: Readonly<Record<string, string>>, now: Date): string[] {
  return Object.entries(since)
    .filter(([, at]) => now.getTime() - Date.parse(at) > RETIRED_RUNNER_MS)
    .map(([name]) => name)
    .sort();
}

export interface MergedPr {
  mergeSha?: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  author: string;
  /** The head branch, for a PR from this repo: the chat with it checked out made the PR. */
  branch?: string;
}

/** A PR closed without a merge. */
export interface ClosedPr {
  repo: string;
  number: number;
  closedAt: string;
}

export interface GithubSnapshot {
  at: string;
  prs: PullRequest[];
  /** All allowlisted repos and the combined list fit the fetch budget; absent means unknown. */
  prsComplete?: boolean;
  runs: WorkflowRun[];
  runners: RunnerLoad | null;
  queue: { queuedRuns: number; runningRuns: number; queuedJobs: number; runsComplete?: boolean; jobsComplete?: boolean; sampledRuns?: number } | null;
  /** Merged PRs of the last TIMELINE_DAYS; null when this push did not refresh them. */
  merged: MergedPr[] | null;
  /** PRs closed unmerged in the same days; null when this push did not refresh them, absent from an older bridge. */
  closed?: ClosedPr[] | null;
  /** The median minutes a passing PR CI run took lately; absent with too few runs. */
  ciTypicalMin?: number;
  /** Null in a snapshot stored before sources were reported: per-source freshness unknown. */
  sources: Record<GithubSource, SourceState> | null;
}

export type GithubSource = "prs" | "runs" | "merged" | "runners" | "queue";

/**
 * One GitHub source's freshness. `failed` names the repos whose latest fetch failed; their
 * last good data is still in the snapshot, fetched at `at` (null when there was none).
 */
export interface SourceState {
  failed: string[];
  at: string | null;
}

const SOURCE_WORD: Record<GithubSource, string> = {
  prs: "pull requests",
  runs: "main runs",
  merged: "merged PRs",
  runners: "runners",
  queue: "the queue",
};

/** Data older than this when a briefing is composed is reported as stale, never as good news. */
export const BRIEFING_STALE_MS = 15 * 60_000;

/** True when `at` is missing or older than BRIEFING_STALE_MS at `now`. */
export function staleAt(at: string | null | undefined, now: Date): boolean {
  return !at || now.getTime() - Date.parse(at) > BRIEFING_STALE_MS;
}

/** The oldest health check among checked apps once it is stale; null while checks are current or none ran. */
export function staleHealthSince(apps: readonly AppStatus[], now: Date): string | null {
  const oldest = apps
    .map((app) => app.health.checkedAt)
    .filter((at): at is string => at !== null)
    .sort()[0];
  return oldest && staleAt(oldest, now) ? oldest : null;
}

/**
 * "resets 8:30am, in 1h 9m" within a day; "resets Mon 4:00am, in 2 days, 3h 0m" further out. The label is
 * wall-clock time and the countdown is real elapsed time, so it stays right across a DST change.
 */
export function resetText(at: string | null, now: number): string | null {
  if (!at) return null;
  const ms = Date.parse(at) - now;
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return "resetting now";
  const total = Math.ceil(ms / 60_000);
  const days = Math.floor(total / 1440);
  const mins = total % 1440;
  const clock = mins >= 60 || days ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  const label = days ? dayClock(at) : when(at, now);
  return `resets ${label}, in ${days ? `${days} ${days === 1 ? "day" : "days"}, ` : ""}${clock}`;
}

/**
 * When a source's data was read: a source that answered is as old as its push; one that failed, as old as the data kept
 * for it, and null when it has none, so no reading.
 */
export function sourceAt(github: Pick<GithubSnapshot, "at" | "sources">, source: GithubSource): string | null {
  const state = github.sources?.[source];
  return state?.failed.length ? state.at : github.at;
}

/** "GitHub unreachable for main runs (example-repo), data from 14:02"; null while the source is fine. */
export function sourceProblem(github: Pick<GithubSnapshot, "sources">, source: GithubSource): string | null {
  const state = github.sources?.[source];
  if (!state?.failed.length) return null;
  const from = state.at ? `data from ${when(state.at)}` : "no data yet";
  return `GitHub unreachable for ${SOURCE_WORD[source]} (${state.failed.join(", ")}), ${from}`;
}

export interface MacVolume {
  label: string;
  totalBytes: number;
  freeBytes: number;
  /** The runners' work directories live on this volume. */
  runners: boolean;
}

export interface MacSnapshot {
  at: string;
  /** RIVET_MACHINE_NAME or the host name, read on the Mac: the Machines trend's label. */
  name: string;
  volumes: MacVolume[];
  load: { one: number; five: number; fifteen: number; cpus: number };
  /** "unknown" when the Mac could not read it; freePct is then 0. */
  memory: { freePct: number; pressure: "normal" | "warn" | "critical" | "unknown" };
  uptimeSec: number;
  runners: { name: string; alive: boolean }[];
  chatRunner: boolean;
}

/** Whether what holds the Mac's chats is running, and its words. */
export function macChats(mac: Pick<MacSnapshot, "chatRunner">): { up: boolean; running: string; down: string; downLine: string } {
  return { up: mac.chatRunner, running: "Chat runner running", down: "Chat runner down", downLine: "Chat runner down" };
}

/**
 * One usage meter as the account's usage endpoint grades it; the app never grades a row itself. Codex rows have no grading
 * from OpenAI, so the bridge grades those (90% warning, 100% critical) and adds the account's credits to its longest window.
 */
export interface ClaudeLimit {
  /** "session" (the 5-hour window), "weekly_all", "weekly_scoped"… */
  kind: string;
  label: string;
  /** Share of the window used, 0-100. */
  percent: number;
  severity: "normal" | "warning" | "critical";
  resetsAt: string | null;
  /** The server's headline meter. */
  active: boolean;
  /** Codex rows only: the account's credit balance, on its longest window's row; null when not read. */
  credits?: number | null;
  unlimited?: boolean;
}

export interface ClaudeUsageSnapshot {
  at: string;
  limits: ClaudeLimit[];
}

export interface FlyRelease {
  sha?: string;
  /** Merge SHAs proven newly shipped against all earlier successful releases, including the baseline. */
  patchMerges?: string[];
  version: number;
  status: string;
  at: string;
  /** The image it runs; a secrets or config release keeps the one before it. */
  image?: string;
}

/**
 * A release is a deploy when its image differs from the last complete release before it, in any order. A release with no
 * image counts (an older bridge); one with nothing to compare against is not known to be a deploy, so it is not one.
 */
export function newImage(releases: readonly FlyRelease[], release: FlyRelease): boolean {
  if (!release.image) return true;
  let before: FlyRelease | undefined;
  for (const other of releases) if (other.status === "complete" && other.version < release.version && (!before || other.version > before.version)) before = other;
  return !!before?.image && release.image !== before.image;
}

/** An app with no check of its own whose awake machines fail their Fly checks: its only red. */
export function wedged(app: Pick<AppStatus, "health" | "fly">): boolean {
  const fly = app.fly;
  return app.health.state === "no-check" && !!fly && fly.machines.started > 0 && fly.checks.passing < fly.checks.total;
}

export interface FlyApp {
  app: string;
  status: string;
  version: number | null;
  sha: string | null;
  machines: { started: number; total: number };
  checks: { passing: number; total: number };
  updatedAt: string | null;
  releases: FlyRelease[];
}

export interface FlySnapshot {
  at: string;
  apps: FlyApp[];
  /** Apps whose latest fetch failed (their last good data is kept); null in a snapshot from before it was reported. */
  source: SourceState | null;
}

/** "Fly unreachable for app-a, app-b +3, data from 14:02"; null while every app answered. */
export function flySourceProblem(fly: Pick<FlySnapshot, "source">): string | null {
  const state = fly.source;
  if (!state?.failed.length) return null;
  const names = `${state.failed.slice(0, 2).join(", ")}${state.failed.length > 2 ? ` +${state.failed.length - 2}` : ""}`;
  return `Fly unreachable for ${names}, ${state.at ? `data from ${when(state.at)}` : "no data yet"}`;
}

export type HealthState = "up" | "down" | "unknown" | "no-check";

export interface Health {
  state: HealthState;
  status: number | null;
  ms: number | null;
  checkedAt: string | null;
  /** When the current state began. */
  since: string | null;
  fails: number;
}

/** One app on the Ops list: a URL from RIVET_HEALTH_URLS, a Fly app from RIVET_FLY_APPS, or both under one name. */
export interface AppStatus {
  /** The app's name, lower-cased as a status key; its record and card are keyed by it. */
  id: string;
  name: string;
  /** The Fly app, when one has this name. */
  app: string | null;
  /** The URL the server checks; null for a Fly app with no URL. */
  url: string | null;
  health: Health;
  fly: (Omit<FlyApp, "releases" | "app"> & { lastRelease: FlyRelease | null }) | null;
}

export interface OpsSummary {
  needs: number;
  redCi: number;
  /**
   * Schedules whose last two or more finished runs failed (a feed card follows once it is late, shared/ops-cards.ts),
   * less any whose newest failed run is one of the red runs on main: that one is already in redCi.
   */
  failingSchedules: number;
  /** Every failing schedule, for when red CI is unknown; absent from an older server. */
  failingSchedulesAll?: number;
  /** When the schedules those counts come from were read; null with none, absent from an older server. */
  schedulesAt?: string | null;
  appsDown: number;
  disk: { freePct: number | null; tone: Tone };
}

export interface OpsResponse {
  now: string;
  bridge: { connected: boolean };
  github: (GithubSnapshot & { stale: boolean }) | null;
  mac: (MacSnapshot & { stale: boolean }) | null;
  claude: (ClaudeUsageSnapshot & { stale: boolean }) | null;
  flyAt: string | null;
  flyStale: boolean;
  flySource: SourceState | null;
  /** The oldest app check when checks have stopped for BRIEFING_STALE_MS; null while they are current. */
  healthStaleSince: string | null;
  apps: AppStatus[];
  summary: OpsSummary;
  /** The first of RIVET_REPOS, or null: the app sets it with setDefaultRepo so its status keys match the server's. */
  defaultRepo: string | null;
  /** Runners offline for over RETIRED_RUNNER_MS: kept out of the offline count. */
  retiredRunners?: string[];
  /** The dated rows of the Plan page's Next list, soonest first; absent from an older server. */
  next?: NextRow[];
}

export type TimelineKind = "merged" | "deploy" | "deploy-failed" | "shipped";

export interface TimelineEvent {
  sha?: string;
  mergeSha?: string;
  patchMerges?: string[];
  kind: TimelineKind;
  at: string | null;
  repo: string;
  title: string;
  url?: string;
  number?: number;
  app?: string;
  /** A merged PR's head branch, when the bridge read it. */
  branch?: string;
  /** A recent merge or ship's short title (src/shared/short-titles.ts), from GET /api/ops/timeline. */
  short?: string;
}

export interface TimelineDay {
  day: string;
  events: TimelineEvent[];
}

export interface TimelineResponse {
  days: TimelineDay[];
  repos: string[];
}

export type BriefingSlot = "morning" | "evening";
export type BriefingKey = "needs" | "shipped" | "failures" | "apps" | "mac";

export interface BriefingItem {
  key: BriefingKey;
  tone: Tone;
  title: string;
  lines: string[];
}

export interface Briefing {
  id: string;
  slot: BriefingSlot;
  day: string;
  /** The slot's own time: 07:30 or 18:00 in your zone. */
  at: string;
  composedAt: string;
  since: string;
  headline: string;
  items: BriefingItem[];
  /** Board shipped rows at compose time (pr:N, at:stamp or title:text), so the next briefing lists only new ones. */
  shippedSeen: string[];
  /** Merge, release and failed-job ids already briefed, with the event time, so a late one still shows once. */
  seen?: { id: string; at: string }[];
  notes: { text: string; at: string }[];
  /** What the headline counts, so a push held or retried says it calmly once someone is on a break it names. */
  alarms?: BriefingAlarms;
}

/** Every break a briefing names, someone on it or not, asked again when its push goes. */
export interface BriefingAlarms {
  merged: number;
  shipped: number;
  red: OwnedItem[];
  /** Failed releases and deploy jobs; null for a release of an app no record can name. */
  deploys: (OwnedItem | null)[];
  down: OwnedItem[];
  /** With a Mac cause: the items whose records clear it, or null when it has a cause no record clears. */
  mac?: OwnedItem[] | null;
}

export function diskTone(freeFraction: number | null): Tone {
  if (freeFraction === null) return "info";
  if (freeFraction < DISK_BAD) return "bad";
  if (freeFraction < DISK_WARN) return "warn";
  return "ok";
}

/** The fullest volume decides the Mac's disk chip. */
export function worstVolume(volumes: readonly MacVolume[]): MacVolume | null {
  let worst: MacVolume | null = null;
  for (const volume of volumes) {
    if (volume.totalBytes <= 0) continue;
    if (!worst || volume.freeBytes / volume.totalBytes < worst.freeBytes / worst.totalBytes) worst = volume;
  }
  return worst;
}

/** The latest completed run of each repo and workflow on main: red when it did not succeed. */
export function latestMainRuns(runs: readonly WorkflowRun[]): WorkflowRun[] {
  const latest = new Map<string, WorkflowRun>();
  for (const run of runs) {
    if (run.status !== "completed" || run.conclusion === "cancelled" || run.conclusion === "skipped") continue;
    const key = `${run.repo}\n${run.workflow}`;
    const seen = latest.get(key);
    if (!seen || run.createdAt > seen.createdAt) latest.set(key, run);
  }
  return [...latest.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function isRed(run: WorkflowRun): boolean {
  return run.status === "completed" && run.conclusion !== null && !["success", "neutral", "skipped", "cancelled"].includes(run.conclusion);
}

/**
 * A run someone started by hand (a one-off check, a remote command): nothing runs it again, so its red never clears.
 * CI's own dispatches are not one-off: their red is main's.
 */
export function isOneOff(run: WorkflowRun): boolean {
  return run.event === "workflow_dispatch" && run.workflow !== "CI";
}

/**
 * A CI run that skips steps a push run has (the secret scan runs on a push or a pull request only): a dispatch, or the
 * nightly schedule. Its red is main's, but its green clears only a red like its own: a push's red stands until a push
 * passes.
 */
export function partialCi(run: WorkflowRun): boolean {
  return run.workflow === "CI" && (run.event === "workflow_dispatch" || run.event === "schedule");
}

/**
 * Main's red runs that count as broken for Rivet and the Ops mark: a one-off run's red shows on Ops only. One-off runs are dropped before each workflow's latest is chosen, so one never
 * hides an automatic failure of the same workflow, nor clears it. A dispatched or nightly CI's red counts, but its
 * green does not clear a push's red (partialCi).
 */
export function brokenOnMain(runs: readonly WorkflowRun[]): WorkflowRun[] {
  const automatic = runs.filter((run) => !isOneOff(run));
  const pushed = latestMainRuns(automatic.filter((run) => !partialCi(run)));
  return latestMainRuns(automatic).flatMap((run) => {
    if (isRed(run)) return [run];
    if (!partialCi(run)) return [];
    const full = pushed.find((one) => one.repo === run.repo && one.workflow === run.workflow);
    return full && isRed(full) ? [full] : [];
  });
}

/** How long a PR's head may stay red while its chat works on it before it counts as broken. */
export const PR_RED_GRACE_MS = 60 * 60_000;
/** A head dated further ahead of the clock than this is not trusted to be young: its red counts at once. */
const HEAD_AHEAD_MS = 5 * 60_000;

/**
 * A PR whose checks fail on a head commit made over PR_RED_GRACE_MS ago, so red on the same push for over an hour; a
 * head of unknown time, or dated in the future (a commit date is the
 * author's to set), counts at once.
 */
export function longRed(pr: Pick<PullRequest, "checks" | "headAt">, now: number): boolean {
  if (pr.checks.state !== "fail") return false;
  const age = now - (pr.headAt ? Date.parse(pr.headAt) : NaN);
  return !(age < PR_RED_GRACE_MS && age > -HEAD_AHEAD_MS);
}

const DEPLOY_JOB = /^Deploy (.+) to Fly$/;

/** The app name a failed "Deploy <name> to Fly" job names, or null. */
export function deployJobTarget(job: string): string | null {
  return DEPLOY_JOB.exec(job)?.[1] ?? null;
}

/** The calendar day ("YYYY-MM-DD") and minute of the day of an instant, in Rivet's time zone. */
export function zoneClock(at: Date | number): { day: string; minute: number } {
  return { day: localDay(at), minute: minuteOfDay(at) };
}

/** Adds whole days to a "YYYY-MM-DD" calendar day. */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** The instant a wall-clock time in Rivet's time zone happens. */
export function zoneInstant(day: string, minute: number): Date {
  const [y, m, d] = day.split("-").map(Number);
  const wall = Date.UTC(y!, m! - 1, d!, Math.floor(minute / 60), minute % 60);
  let guess = wall;
  for (let i = 0; i < 3; i += 1) {
    const seen = zoneClock(guess);
    const [sy, sm, sd] = seen.day.split("-").map(Number);
    const seenWall = Date.UTC(sy!, sm! - 1, sd!, Math.floor(seen.minute / 60), seen.minute % 60);
    if (seenWall === wall) break;
    guess += wall - seenWall;
  }
  return new Date(guess);
}

/** A dollar amount as the app shows it: "$1.03", "<$0.01" or "$0.00". */
export function usd(amount: number): string {
  return amount > 0 && amount < 0.005 ? "<$0.01" : `$${amount.toFixed(2)}`;
}

const CODEX_WARN_PCT = 90;

export type SpendTone = Tone | "idle";

export interface SpendRow {
  /** The masked account, or null for a line about the whole source. */
  who: string | null;
  text: string;
  tone: SpendTone;
}

export interface SpendView {
  tone: SpendTone;
  headline: string;
  /** The usage tile's second line: the totals, worst tone; each part with its own tone, coloured on its own. */
  tile: { text: string; tone: SpendTone; parts: { text: string; tone: SpendTone }[] };
  codex: SpendRow[];
  /** When the usage reading was taken, for the card's foot. */
  read: string | null;
}

const SPEND_RANK: Record<SpendTone, number> = { bad: 0, warn: 1, info: 2, ok: 3, idle: 4 };
export const worstSpendTone = (tones: readonly SpendTone[]): SpendTone => tones.reduce<SpendTone>((acc, t) => (SPEND_RANK[t] < SPEND_RANK[acc] ? t : acc), "idle");

const MASK_RE = /^([a-z0-9._?-]{1,4}\*{3})/i;

export const ACCOUNT_WARN_PCT = 80;
export const ACCOUNT_BAD_PCT = 90;

/** A usage row's notes, the bridge's "(active, old, 5-hr 88%)". */
export function limitNotes(limit: ClaudeLimit): string[] {
  return /\(([^()]*)\)$/.exec(limit.label)?.[1]?.split(", ") ?? [];
}

/** The row holds no current week: the bridge could not read it, or its reading is over 45 minutes old. */
export function limitUnread(limit: ClaudeLimit): boolean {
  const notes = limitNotes(limit);
  return notes.includes("no reading") || notes.includes("old");
}

/** Account rows graded from their week, whatever an older bridge sent: warning from 80%, critical from 90%, unread normal. */
export function gradeAccounts(limits: readonly ClaudeLimit[]): ClaudeLimit[] {
  return limits.map((limit): ClaudeLimit =>
    !limit.kind.startsWith("account_")
      ? limit
      : { ...limit, severity: limitUnread(limit) ? "normal" : limit.percent >= ACCOUNT_BAD_PCT ? "critical" : limit.percent >= ACCOUNT_WARN_PCT ? "warning" : "normal" },
  );
}

/**
 * Every account's week as one raw sum out of 100% each, never averaged: the total counts every account, an unread one adding nothing used and an unknown amount left. Graded
 * on the share of the accounts read, warning from 80%, bad from 90%; null with none read.
 */
export function accountsTotal(limits: readonly ClaudeLimit[]): UsageSum | null {
  return sumCells(claudeCells(limits));
}

/** One account's part of a provider's overall: its week (Codex: its longest window) used, out of 100%. */
export interface UsageCell {
  /** The masked account, "ch***"; "?***" when the label carries none. */
  who: string;
  percent: number;
  unread: boolean;
  active: boolean;
  resetsAt: string | null;
  /** The window the percent is of: "week", "5 hr"… */
  window: string;
  /** The rows the cell came from: a Codex account's every window, a Claude account's one row. */
  rows: ClaudeLimit[];
}

export interface UsageSum {
  used: number;
  total: number;
  unread: number;
  tone: "ok" | "warn" | "bad";
  resetsAt: string | null;
  /** The read account whose window resets first. */
  next: UsageCell | null;
  cells: UsageCell[];
}

const cellWho = (label: string) => MASK_RE.exec(label.replace(/^Account /, ""))?.[1] ?? "?***";

/** The Claude accounts' weeks, one cell per account row, in the bridge's order. */
export function claudeCells(limits: readonly ClaudeLimit[]): UsageCell[] {
  return limits
    .filter((limit) => limit.kind.startsWith("account_"))
    .map((limit) => ({ who: cellWho(limit.label), percent: limit.percent, unread: limitUnread(limit), active: limitNotes(limit).includes("active"), resetsAt: limit.resetsAt, window: "week", rows: [limit] }));
}

/** The most Usage rows the server takes in one reading (the bridge cuts the tail to fit). */
export const MAX_CLAUDE_LIMITS = 12;

/** The Codex accounts, one cell per account (rows codex_<n>_<window>, or codex_<n> with no reading), on its longest window. */
export function codexCells(limits: readonly ClaudeLimit[]): UsageCell[] {
  const byAccount = new Map<string, ClaudeLimit[]>();
  for (const limit of limits) {
    const n = /^codex_(\d+)/.exec(limit.kind)?.[1];
    if (n) byAccount.set(n, [...(byAccount.get(n) ?? []), limit]);
  }
  const accounts = [...byAccount.values()];
  // The row cap cuts the tail, so only the last account of a full reading can have lost its longest window.
  const full = limits.length >= MAX_CLAUDE_LIMITS;
  return accounts.map((rows, i) => {
    // The bridge puts the credits on the longest window's row, and sends the windows shortest first. When the cap cut
    // that row, the account's week is not read: a shorter window never stands in for it.
    const longest = rows.find((row) => row.credits !== undefined || row.unlimited !== undefined);
    const main = longest ?? rows[rows.length - 1]!;
    return {
      who: cellWho(main.label),
      percent: main.percent,
      unread: (!longest && full && i === accounts.length - 1) || limitUnread(main),
      active: rows.some((row) => limitNotes(row).includes("active")),
      resetsAt: main.resetsAt,
      window: /, ([^(]+?)(?: \(|$)/.exec(main.label)?.[1] ?? "week",
      rows,
    };
  });
}

/**
 * Cells summed raw, out of 100% each: an unread cell
 * keeps its 100% in the total and adds nothing used. Graded on the share of the cells read, warning from 80%, bad from
 * 90%; null with none read.
 */
export function sumCells(cells: readonly UsageCell[]): UsageSum | null {
  const read = cells.filter((cell) => !cell.unread);
  if (!read.length) return null;
  const used = read.reduce((sum, cell) => sum + Math.min(100, Math.max(0, cell.percent)), 0);
  const share = used / (read.length * 100);
  const next = read.filter((cell) => cell.resetsAt && Number.isFinite(Date.parse(cell.resetsAt))).sort((a, b) => Date.parse(a.resetsAt!) - Date.parse(b.resetsAt!))[0] ?? null;
  return {
    used,
    total: cells.length * 100,
    unread: cells.length - read.length,
    tone: share >= ACCOUNT_BAD_PCT / 100 ? "bad" : share >= ACCOUNT_WARN_PCT / 100 ? "warn" : "ok",
    resetsAt: next?.resetsAt ?? null,
    next,
    cells: [...cells],
  };
}

/** A Codex account's line: its week (or longest window) use, the reset when close or full, and its credits. */
function codexRow(rows: readonly ClaudeLimit[], now: number): SpendRow {
  const who = MASK_RE.exec(rows[0]!.label)?.[1] ?? "?***";
  const main = rows.find((row) => row.credits !== undefined || row.unlimited !== undefined) ?? rows[rows.length - 1]!;
  if (/no reading/.test(main.label)) return { who, text: "no reading", tone: "warn" };
  const used = Math.round(main.percent);
  const window = /, ([^(]+?)(?: \(|$)/.exec(main.label)?.[1] ?? "week";
  const reset = main.severity === "critical" || main.severity === "warning" ? resetText(main.resetsAt, now) : null;
  const noCredits = !main.unlimited && main.credits === 0;
  const credits = main.unlimited ? "unlimited credits" : main.credits ? `${Math.round(main.credits).toLocaleString()} credits` : noCredits ? "no credits" : null;
  return {
    who,
    text: [`${window} ${used}%`, reset, credits].filter(Boolean).join(" · "),
    // Graded as the bridge graded the row (the OpenAI section reads the same severity), so the two never disagree.
    tone: main.severity === "critical" ? "bad" : main.severity === "warning" || noCredits ? "warn" : "ok",
  };
}

/** Everything the Spend card and the usage tile's second line say, from one Ops reading: a line per Codex account. */
export function spendLines(ops: Pick<OpsResponse, "claude">, now: number): SpendView {
  const claude = ops.claude ?? null;
  const stale = !!claude && (claude.stale || !(now - Date.parse(claude.at) <= CLAUDE_STALE_MS));
  // One line per account, from its rows (kinds codex_<n>_<window>, or codex_<n> with no reading).
  const byAccount = new Map<string, ClaudeLimit[]>();
  for (const limit of claude?.limits ?? []) {
    const n = /^codex_(\d+)/.exec(limit.kind)?.[1];
    if (n) byAccount.set(n, [...(byAccount.get(n) ?? []), limit]);
  }
  let codex = [...byAccount.values()].map((rows) => codexRow(rows, now));
  if (stale) codex = codex.map((row) => ({ ...row, tone: row.tone === "ok" ? "warn" : row.tone }));
  const busiest = codex.reduce((max, row) => Math.max(max, Number(/ (\d+)%/.exec(row.text)?.[1] ?? 0)), 0);
  const part = busiest >= CODEX_WARN_PCT ? `Codex ${busiest}%` : codex.some((row) => row.text.endsWith("no credits")) ? "Codex no credits" : null;
  const tone = worstSpendTone(codex.map((row) => row.tone));
  return {
    tone,
    headline: part ?? "",
    tile: { text: part ?? "", tone, parts: part ? [{ text: part, tone }] : [] },
    codex,
    read: claude?.at ?? null,
  };
}
