import type { Board } from "../../shared/board.js";
import { appOwnedItem, ciOwnedItem, type OwnedItem } from "../../shared/ops-owned.js";
import {
  brokenOnMain,
  CLAUDE_STALE_MS,
  deployJobTarget,
  diskTone,
  FLY_STALE_MS,
  GITHUB_STALE_MS,
  MAC_STALE_MS,
  newImage,
  retiredRunners,
  staleHealthSince,
  TIMELINE_DAYS,
  worstVolume,
  zoneClock,
  type AppStatus,
  type ClaudeUsageSnapshot,
  type FlySnapshot,
  type GithubSnapshot,
  type Health,
  type MacSnapshot,
  type MergedPr,
  type OpsResponse,
  type TimelineEvent,
  type TimelineResponse,
} from "../../shared/ops.js";
import { NO_REPO } from "../../shared/repos.js";
import type { HealthCheck } from "../config.js";
import type { PushPayload } from "../push.js";
import { NO_CHECK, UNKNOWN } from "./health.js";
import type { QueuedPush } from "./store.js";

const STATE_ORDER: Record<Health["state"], number> = { down: 0, unknown: 1, up: 2, "no-check": 3 };

/** One row per RIVET_HEALTH_URLS entry and per Fly app; an entry named as a Fly app shares its row. */
export function buildApps(checks: readonly HealthCheck[], health: Record<string, Health>, fly: FlySnapshot | null): AppStatus[] {
  const byApp = new Map((fly?.apps ?? []).map((app) => [app.app, app]));
  const urls = new Map(checks.map((check) => [check.name, check.url]));
  const apps = [...new Set([...urls.keys(), ...byApp.keys()])].map((name): AppStatus => {
    const app = byApp.get(name);
    const url = urls.get(name) ?? null;
    return {
      id: name,
      name,
      app: app ? name : null,
      url,
      health: url ? (health[name] ?? UNKNOWN) : NO_CHECK,
      fly: app
        ? {
            status: app.status,
            version: app.version,
            sha: app.sha,
            machines: app.machines,
            checks: app.checks,
            updatedAt: app.updatedAt,
            lastRelease: app.releases[0] ?? null,
          }
        : null,
    };
  });
  return apps.sort((a, b) => STATE_ORDER[a.health.state] - STATE_ORDER[b.health.state] || a.name.localeCompare(b.name));
}

export function isStale(at: string | undefined | null, maxAgeMs: number, now: Date): boolean {
  return !at || !(now.getTime() - Date.parse(at) <= maxAgeMs);
}

export function buildOps(input: {
  now: Date;
  bridgeConnected: boolean;
  board: Board | null;
  github: GithubSnapshot | null;
  runnersOffline?: Readonly<Record<string, string>>;
  mac: MacSnapshot | null;
  claude?: ClaudeUsageSnapshot | null;
  fly: FlySnapshot | null;
  checks: readonly HealthCheck[];
  health: Record<string, Health>;
  /** Each failing schedule's newest failed run (SchedulesStore.failingRuns). */
  failingRuns?: readonly (string | null)[];
  /** When the schedules were read. */
  schedulesAt?: string | null;
}): OpsResponse {
  const { now, github, mac, fly } = input;
  const apps = buildApps(input.checks, input.health, fly);
  // An old Mac reading is no disk figure: the chip and the menu badge would hold it frozen.
  const worst = mac && !isStale(mac.at, MAC_STALE_MS, now) ? worstVolume(mac.volumes) : null;
  const freePct = worst ? Math.round((worst.freeBytes / worst.totalBytes) * 1000) / 10 : null;
  const red = github ? brokenOnMain(github.runs) : [];
  return {
    now: now.toISOString(),
    bridge: { connected: input.bridgeConnected },
    github: github ? { ...github, merged: null, stale: isStale(github.at, GITHUB_STALE_MS, now) } : null,
    mac: mac ? { ...mac, stale: isStale(mac.at, MAC_STALE_MS, now) } : null,
    claude: input.claude ? { ...input.claude, stale: isStale(input.claude.at, CLAUDE_STALE_MS, now) } : null,
    flyAt: fly?.at ?? null,
    flyStale: isStale(fly?.at, FLY_STALE_MS, now),
    flySource: fly?.source ?? null,
    healthStaleSince: staleHealthSince(apps, now),
    apps,
    summary: {
      needs: input.board?.needs.length ?? 0,
      redCi: red.length,
      failingSchedules: (input.failingRuns ?? []).filter((url) => url === null || !red.some((run) => run.url === url)).length,
      failingSchedulesAll: (input.failingRuns ?? []).length,
      schedulesAt: input.schedulesAt ?? null,
      appsDown: apps.filter((app) => app.health.state === "down").length,
      disk: { freePct, tone: diskTone(worst ? worst.freeBytes / worst.totalBytes : null) },
    },
    defaultRepo: NO_REPO || null,
    retiredRunners: retiredRunners(input.runnersOffline ?? {}, now),
  };
}

const short = (repo: string) => repo.split("/").pop() ?? repo;

/**
 * Merged PRs and Fly deploys (releases with a new image) of the last TIMELINE_DAYS, plus the board's shipped rows by
 * the day they reached the list (`shippedAt`), by local day, newest first. A shipped row whose day is not known (no
 * stamp, or a null one), or whose PR is a merged row, is left out: it would be dated today every day.
 */
export function buildTimeline(input: {
  now: Date;
  merged: readonly MergedPr[];
  fly: FlySnapshot | null;
  board: Board | null;
}): TimelineResponse {
  const cutoff = input.now.getTime() - TIMELINE_DAYS * 24 * 3600_000;
  const within = (at: string) => {
    const t = Date.parse(at);
    return t >= cutoff && t <= input.now.getTime() + 60_000;
  };
  const events: TimelineEvent[] = [];
  const mergedNumbers = new Set<string>();
  for (const pr of input.merged) {
    if (!within(pr.mergedAt)) continue;
    mergedNumbers.add(`${pr.repo}#${pr.number}`);
    events.push({ kind: "merged", at: pr.mergedAt, repo: short(pr.repo), title: pr.title, url: pr.url, number: pr.number, ...(pr.mergeSha ? { mergeSha: pr.mergeSha } : {}), ...(pr.branch ? { branch: pr.branch } : {}) });
  }
  for (const app of input.fly?.apps ?? []) {
    for (const release of app.releases) {
      if (!within(release.at) || !["complete", "failed"].includes(release.status) || !newImage(app.releases, release)) continue;
      events.push({
        kind: release.status === "failed" ? "deploy-failed" : "deploy",
        at: release.at,
        repo: short(NO_REPO),
        title: `${app.app} v${release.version}`,
        app: app.app,
        ...(release.sha ? { sha: release.sha } : {}),
        ...(release.status === "complete" && release.patchMerges ? { patchMerges: release.patchMerges } : {}),
      });
    }
  }
  const today = zoneClock(input.now).day;
  for (const item of input.board?.shipped ?? []) {
    const repo = item.repo ?? NO_REPO;
    if (typeof item.shippedAt !== "string" || !within(item.shippedAt) || mergedNumbers.has(`${repo}#${item.pr}`)) continue;
    events.push({
      kind: "shipped",
      at: item.shippedAt,
      repo: short(repo),
      title: item.title,
      ...(item.pr ? { number: item.pr, url: `https://github.com/${repo}/pull/${item.pr}` } : {}),
    });
  }
  const byDay = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    const day = event.at ? zoneClock(Date.parse(event.at)).day : today;
    const list = byDay.get(day) ?? [];
    list.push(event);
    byDay.set(day, list);
  }
  const days = [...byDay.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, list]) => ({
      day,
      events: list.sort((a, b) => (b.at ?? "9999").localeCompare(a.at ?? "9999") || a.title.localeCompare(b.title)),
    }));
  return { days, repos: [...new Set(events.map((event) => event.repo))].sort() };
}

/** Deploy names shaped like a dev channel ("example-app-dev", "Example App (dev)") are not prod, so they never break through quiet hours. */
export function isDev(name: string): boolean {
  return /(^|[^a-z0-9])dev($|[^a-z0-9])/i.test(name);
}

const ALERT_WINDOW_MS = 2 * 3600_000;

export interface Alert {
  key: string;
  category: "app-down" | "deploy-failed";
  payload: PushPayload;
  /** The item whose owner silences the alert while it waits, when its key alone cannot name it: a deploy job's workflow. */
  owner?: OwnedItem;
}

const ALERT_NAME = [/^Deploy (.+) failed$/, /^(.+) deploy failed$/, /^(.+) is down$/];

/** Several new alerts of one kind from one snapshot as one push: a count, the first three names and "+N". */
export function alertSummary(group: QueuedPush[]): QueuedPush {
  const first = group[0]!;
  const names = group.slice(0, 3).map(({ payload }) => {
    for (const pattern of ALERT_NAME) {
      const match = pattern.exec(payload.title);
      if (match) return match[1]!;
    }
    return payload.title;
  });
  const body = `${names.join(", ")}${group.length > 3 ? ` +${group.length - 3}` : ""}`;
  return {
    key: `summary:${first.key}:${group.length}`,
    category: first.category,
    payload: {
      title: first.category === "app-down" ? `${group.length} apps are down` : `${group.length} deploys failed`,
      body: body.length > 140 ? `${body.slice(0, 139).trimEnd()}…` : body,
      tag: `summary-${first.category}`,
      path: "/",
    },
    expiresAt: first.expiresAt,
  };
}

/** Whether someone is on a failed item, by the app's own test (src/shared/ops-owned.ts): an owned break sends no alert. */
export type Owned = (item: OwnedItem) => boolean;
const NOBODY: Owned = () => false;

/** Newly down apps, dev channels aside: one alert per down spell, keyed by when it began. An app someone is on sends none; once nobody is, its spell alerts. */
export function downAlerts(apps: readonly AppStatus[], owned: Owned = NOBODY): Alert[] {
  return apps
    .filter((app) => app.health.state === "down" && app.health.since && !isDev(app.name) && !owned(appOwnedItem(app.id)))
    .map((app) => ({
      key: `down:${app.id}:${app.health.since}`,
      category: "app-down",
      payload: {
        title: `${app.name} is down`,
        body: `Its health check failed ${app.health.fails} times in a row (${app.health.status ? `HTTP ${app.health.status}` : "no answer"}).`,
        tag: `down-${app.id}`,
        path: "/",
      },
    }));
}

/**
 * Failed prod deploys from the last two hours: Fly releases of a new image and "Deploy <name> to Fly" jobs on main. A
 * release of an app someone is on, or a job of a red workflow someone is on, sends none.
 */
export function deployAlerts(input: { now: Date; fly: FlySnapshot | null; github: GithubSnapshot | null; owned?: Owned }): Alert[] {
  const recent = (at: string) => input.now.getTime() - Date.parse(at) <= ALERT_WINDOW_MS;
  const owned = input.owned ?? NOBODY;
  const alerts: Alert[] = [];
  for (const app of input.fly?.apps ?? []) {
    if (isDev(app.app) || owned(appOwnedItem(app.app))) continue;
    for (const release of app.releases) {
      if (release.status !== "failed" || !recent(release.at) || !newImage(app.releases, release)) continue;
      alerts.push({
        key: `release:${app.app}:${release.version}`,
        category: "deploy-failed",
        payload: { title: `${app.app} deploy failed`, body: `Fly release v${release.version} failed.`, tag: `deploy-${app.app}`, path: "/" },
      });
    }
  }
  for (const run of input.github?.runs ?? []) {
    if (!recent(run.updatedAt) || owned(ciOwnedItem(run))) continue;
    for (const job of run.failedJobs ?? []) {
      const target = deployJobTarget(job);
      if (!target || isDev(target)) continue;
      alerts.push({
        key: `deployjob:${run.id}:${run.attempt}:${target}`,
        category: "deploy-failed",
        owner: ciOwnedItem(run),
        payload: { title: `Deploy ${target} failed`, body: `${run.workflow} on main: ${job}.`, tag: `deployjob-${run.id}`, path: "/" },
      });
    }
  }
  return alerts;
}
