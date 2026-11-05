import type { Board } from "../../shared/board.js";
import {
  addDays,
  deployJobTarget,
  newImage,
  diskTone,
  brokenOnMain,
  sourceProblem,
  flySourceProblem,
  staleAt,
  staleHealthSince,
  zoneClock,
  zoneInstant,
  type Briefing,
  type BriefingAlarms,
  type BriefingItem,
  type BriefingSlot,
  type FlyRelease,
  type FlySnapshot,
  type AppStatus,
  type GithubSnapshot,
  type MacSnapshot,
  type MergedPr,
  type WorkflowRun,
  macChats,
} from "../../shared/ops.js";
import { appOwnedItem, ciOwnedItem, diskOwnedItem, macOwnedItem, type OwnedItem } from "../../shared/ops-owned.js";
import { NO_REPO } from "../../shared/repos.js";
import { clock } from "../../shared/when.js";
import type { PushPayload } from "../push.js";

// The morning and evening briefings: a deterministic summary of the same data the
// Ops tab shows, composed once per slot and local day.

export const MORNING_MINUTE = 7 * 60 + 30;
export const EVENING_MINUTE = 18 * 60;
/** A briefing composed this long after its slot (the server was down) is stored but not pushed. */
export const PUSH_WINDOW_MS = 3 * 3600_000;
/** Events the bridge delivers late count if they are no older than this before the last briefing and it did not include them. */
export const LATE_MS = 24 * 3600_000;
const MAX_SEEN = 2000;
const MAX_LINES = 5;
const LINE_MAX = 140;

export interface Slot {
  id: string;
  slot: BriefingSlot;
  day: string;
  at: Date;
}

/** The latest slot that has started by `now`, in local time. */
export function currentSlot(now: Date): Slot {
  const { day, minute } = zoneClock(now);
  const make = (d: string, slot: BriefingSlot): Slot => ({
    id: `${d}-${slot}`,
    slot,
    day: d,
    at: zoneInstant(d, slot === "morning" ? MORNING_MINUTE : EVENING_MINUTE),
  });
  if (minute >= EVENING_MINUTE) return make(day, "evening");
  if (minute >= MORNING_MINUTE) return make(day, "morning");
  return make(addDays(day, -1), "evening");
}

export interface BriefingInputs {
  board: Board | null;
  github: GithubSnapshot | null;
  merged: readonly MergedPr[];
  fly: FlySnapshot | null;
  apps: readonly AppStatus[];
  mac: MacSnapshot | null;
  macStale: boolean;
  previous: Briefing | null;
  /**
   * Whether someone is on a failed item, by the app's own test (src/shared/ops-owned.ts). An owned break is no red line
   * and no "red" in the push headline: it reads "agents on it", as the app does. Absent, nobody is on anything.
   */
  owned?: (item: OwnedItem) => boolean;
}

const ON_IT = "agents on it";

function clip(value: string, max = LINE_MAX): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const short = (repo: string) => repo.split("/").pop() ?? repo;

const SHIPPED_KEY = /^(pr|at|title):/;

/** A title edit must not re-announce a row, so the title is the key only for a row with neither a PR nor a stamp. */
function shippedKey(item: Board["shipped"][number]): string {
  if (item.pr !== undefined) return item.repo && item.repo !== NO_REPO ? `pr:${item.repo}#${item.pr}` : `pr:${item.pr}`;
  const shippedAt = (item as { shippedAt?: unknown }).shippedAt;
  return typeof shippedAt === "string" ? `at:${shippedAt}` : `title:${item.title}`;
}

const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const redLine = (run: WorkflowRun) => `${short(run.repo)}: ${run.workflow} ${run.conclusion ?? ""}`.trim();
const releaseLine = ({ app, release }: { app: string; release: FlyRelease }) => `${app} v${release.version} release failed`;

/** The items `test` holds for, then the rest. */
function split<T>(items: readonly T[], test: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const item of items) (test(item) ? yes : no).push(item);
  return [yes, no];
}

function capped(lines: string[]): string[] {
  if (lines.length <= MAX_LINES) return lines.map((line) => clip(line));
  return [...lines.slice(0, MAX_LINES - 1).map((line) => clip(line)), `+${lines.length - (MAX_LINES - 1)} more`];
}

export function composeBriefing(inputs: BriefingInputs, slot: Slot, now: Date): Briefing {
  const since = inputs.previous?.composedAt ?? new Date(slot.at.getTime() - 12 * 3600_000).toISOString();
  // Earlier builds stored `seen` as plain ids, considered as of that briefing.
  const previous = inputs.previous;
  const stored = Array.isArray(previous?.seen) ? (previous.seen as unknown[]) : null;
  const recovered = (stored ?? []).flatMap((entry) => {
    if (typeof entry === "string") return [{ id: entry, at: previous!.composedAt }];
    const { id, at } = (entry ?? {}) as { id?: unknown; at?: unknown };
    return typeof id === "string" ? [{ id, at: typeof at === "string" ? at : previous!.composedAt }] : [];
  });
  // The window reaches back only when every stored id was recovered; otherwise the cutoff stays exact.
  const lookback = Date.parse(since) - (stored && recovered.length === stored.length ? LATE_MS : 0);
  const seenBefore = new Set(recovered.map((entry) => entry.id));
  // Carried forward, not rebuilt: an event a source drops for one cycle must not come back as new.
  const seen = new Map(recovered.filter((entry) => Date.parse(entry.at) > now.getTime() - LATE_MS - 24 * 3600_000).map((entry) => [entry.id, entry.at]));
  const fresh = (id: string, at: string) => {
    const t = Date.parse(at);
    if (!(t > lookback && t <= now.getTime())) return false;
    seen.set(id, at);
    return !seenBefore.has(id);
  };
  const items: BriefingItem[] = [];

  // No needs item: the cards waiting are the live row above the card, and a count frozen at compose time only disagrees with it.
  const merged = inputs.merged.filter((pr) => fresh(`pr:${pr.repo}#${pr.number}`, pr.mergedAt)).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
  const shippedBefore = new Set(inputs.previous?.shippedSeen ?? []);
  // Briefings stored before the keys held bare titles; those still match by title.
  const titleKeyed = shippedBefore.size > 0 && ![...shippedBefore].some((key) => SHIPPED_KEY.test(key));
  const shippedRows = inputs.board?.shipped ?? [];
  const shippedKeys = shippedRows.map(shippedKey);
  // A shipped row for a merged PR is that merge, already counted: only the rest are more shipped.
  const mergedNumbers = new Set(inputs.merged.map((pr) => `${pr.repo}#${pr.number}`));
  const shipped = shippedRows
    .filter((item, i) => !shippedBefore.has(shippedKeys[i]!) && !(titleKeyed && shippedBefore.has(item.title)) && !(item.pr !== undefined && mergedNumbers.has(`${item.repo ?? NO_REPO}#${item.pr}`)))
    .map((item) => item.title);
  const moved = merged.length + shipped.length;
  const mergedProblem = inputs.github ? sourceProblem(inputs.github, "merged") : null;
  items.push({
    key: "shipped",
    tone: mergedProblem ? "warn" : moved ? "ok" : "info",
    title: moved
      ? [merged.length ? `${plural(merged.length, "PR")} merged` : null, shipped.length ? `${shipped.length} ${merged.length ? "more " : ""}shipped` : null].filter(Boolean).join(", ")
      : mergedProblem
        ? "Merged PRs unknown"
        : "Nothing merged since the last briefing",
    lines: capped([
      ...(mergedProblem ? [mergedProblem] : []),
      ...shipped.map((title) => `Shipped: ${title}`),
      ...merged.map((pr) => `${short(pr.repo)} #${pr.number} ${pr.title}`),
    ]),
  });

  const red = inputs.github ? brokenOnMain(inputs.github.runs) : [];
  const failedReleases = (inputs.fly?.apps ?? []).flatMap((app) =>
    app.releases
      .filter((release) => release.status === "failed" && newImage(app.releases, release) && fresh(`release:${app.app}:${release.version}`, release.at))
      .map((release) => ({ app: app.app, release })),
  );
  const failedJobs = (inputs.github?.runs ?? []).flatMap((run) =>
    (run.failedJobs ?? [])
      .filter((job) => deployJobTarget(job) && fresh(`job:${run.repo}:${run.id}:${run.attempt}:${job}`, run.updatedAt))
      .map((job) => ({ run, job })),
  );
  // A break someone is on is said calmly, apart from the ones nobody has.
  const owned = inputs.owned ?? (() => false);
  const appIds = new Map(inputs.apps.flatMap((app) => (app.app ? [[app.app, app.id] as const] : [])));
  const [redOwned, redOpen] = split(red, (run) => owned(ciOwnedItem(run)));
  const [releasesOwned, releasesOpen] = split(failedReleases, ({ app }) => appIds.has(app) && owned(appOwnedItem(appIds.get(app)!)));
  const [jobsOwned, jobsOpen] = split(failedJobs, ({ run }) => owned(ciOwnedItem(run)));
  const failures = redOpen.length + releasesOpen.length + jobsOpen.length;
  const failuresOwned = redOwned.length + releasesOwned.length + jobsOwned.length;
  const failuresTitle = (runs: number, deploys: number) => `${plural(runs, "red workflow")} on main, ${plural(deploys, "failed deploy")}`;
  // Red or green is only known from fresh runs; failed or stale data is named as such.
  const github = inputs.github;
  const runsProblem = !github
    ? "No GitHub data yet"
    : (sourceProblem(github, "runs") ?? (staleAt(github.at, now) ? `GitHub data from ${clock(github.at)}, stale` : null));
  const fly = inputs.fly;
  const flyProblem = !fly ? "No Fly data yet" : (flySourceProblem(fly) ?? (staleAt(fly.at, now) ? `Fly data from ${clock(fly.at)}, stale` : null));
  items.push({
    key: "failures",
    tone: failures ? "bad" : runsProblem || flyProblem ? "warn" : failuresOwned ? "info" : "ok",
    title: failures
      ? failuresTitle(redOpen.length, releasesOpen.length + jobsOpen.length)
      : failuresOwned
        ? `${capital(ON_IT)}: ${failuresTitle(redOwned.length, releasesOwned.length + jobsOwned.length)}`
        : runsProblem && flyProblem
        ? "Main and Fly deploys unknown"
        : runsProblem
          ? "Main status unknown, no failed deploys seen"
          : flyProblem
          ? "Main is green, Fly deploys unknown"
          : "Main is green, no failed deploys",
    lines: capped([
      ...(runsProblem ? [runsProblem] : []),
      ...(flyProblem ? [flyProblem] : []),
      ...redOpen.map(redLine),
      ...releasesOpen.map(releaseLine),
      ...jobsOpen.map(({ job }) => job),
      ...redOwned.map((run) => `${redLine(run)}, ${ON_IT}`),
      ...releasesOwned.map((failed) => `${releaseLine(failed)}, ${ON_IT}`),
      ...jobsOwned.map(({ job }) => `${job}, ${ON_IT}`),
    ]),
  });

  const [downOwned, down] = split(
    inputs.apps.filter((app) => app.health.state === "down"),
    (app) => owned(appOwnedItem(app.id)),
  );
  const downTitle = (apps: readonly AppStatus[]) => `${plural(apps.length, "app")} down`;
  const downLine = (app: AppStatus) => `${app.name} (${app.health.status ? `HTTP ${app.health.status}` : "no answer"})`;
  const checked = inputs.apps.filter((app) => app.health.state === "up" || app.health.state === "down");
  const checksStale = staleHealthSince(inputs.apps, now);
  items.push({
    key: "apps",
    tone: down.length ? "bad" : checksStale ? "warn" : downOwned.length ? "info" : checked.length ? "ok" : "info",
    title: down.length
      ? downTitle(down)
      : downOwned.length
        ? `${capital(ON_IT)}: ${downTitle(downOwned)}`
        : checksStale
        ? "App health unknown"
        : checked.length
          ? `All ${checked.length} checked apps up`
          : "No app checks yet",
    lines: capped([
      ...(checksStale ? [`App checks from ${clock(checksStale)}, stale`] : []),
      ...down.map(downLine),
      ...downOwned.map((app) => `${downLine(app)}, ${ON_IT}`),
    ]),
  });

  const mac = inputs.mac;
  const macLines: string[] = [];
  let macTone: BriefingItem["tone"] = "ok";
  let macOnIt = false;
  // What makes it a Mac warning, someone on it or not: the items whose records clear it, null for a cause no record clears.
  const macCauses: (OwnedItem | null)[] = [];
  if (!mac || inputs.macStale) {
    macTone = "warn";
    macCauses.push(null);
    macLines.push(mac ? `Mac health from ${clock(mac.at)}, stale` : "No Mac health yet");
  } else {
    for (const volume of mac.volumes) {
      const free = volume.totalBytes > 0 ? volume.freeBytes / volume.totalBytes : 1;
      const tone = diskTone(free);
      if (tone === "ok") continue;
      // A full disk someone is on is calm: no tone, no "Mac warning".
      const onIt = tone === "bad" && owned(diskOwnedItem(volume.label));
      macOnIt ||= onIt;
      macCauses.push(tone === "bad" ? diskOwnedItem(volume.label) : null);
      if (tone === "bad" && !onIt) macTone = "bad";
      else if (!onIt && macTone === "ok") macTone = "warn";
      macLines.push(`${volume.label}: ${Math.round(free * 100)}% free${onIt ? `, ${ON_IT}` : ""}`);
    }
    // The Mac's record covers its memory and runners, as the app's Mac item does.
    const macOwned = owned(macOwnedItem());
    const deadRunners = mac.runners.filter((runner) => !runner.alive);
    // Only critical memory is the Mac item's fault; a warning stays amber.
    const memoryOwned = macOwned && mac.memory.pressure === "critical";
    macOnIt ||= memoryOwned || (macOwned && deadRunners.length > 0);
    if (mac.memory.pressure !== "normal") {
      macCauses.push(mac.memory.pressure === "critical" ? macOwnedItem() : null);
      if (!memoryOwned && macTone === "ok") macTone = "warn";
      macLines.push(`Memory pressure ${mac.memory.pressure}${memoryOwned ? `, ${ON_IT}` : ""}`);
    }
    if (deadRunners.length) {
      macCauses.push(macOwnedItem());
      if (!macOwned && macTone === "ok") macTone = "warn";
      macLines.push(`${plural(deadRunners.length, "runner")} not running${macOwned ? `, ${ON_IT}` : ""}`);
    }
    const chats = macChats(mac);
    if (!chats.up) {
      if (macTone === "ok") macTone = "warn";
      macCauses.push(null);
      macLines.push(chats.downLine);
    }
  }
  items.push({
    key: "mac",
    tone: macTone === "ok" && macOnIt ? "info" : macTone,
    title: macTone !== "ok" ? "Mac needs a look" : macOnIt ? `${capital(ON_IT)}: Mac` : "Mac healthy",
    lines: capped(macLines),
  });

  // Every break, someone on it or not, so a push held or retried asks of each again as it stands.
  const alarms: BriefingAlarms = {
    merged: merged.length,
    shipped: shipped.length,
    red: red.map(ciOwnedItem),
    deploys: [
      ...failedReleases.map(({ app }) => (appIds.has(app) ? appOwnedItem(appIds.get(app)!) : null)),
      ...failedJobs.map(({ run }) => ciOwnedItem(run)),
    ],
    down: [...down, ...downOwned].map((app) => appOwnedItem(app.id)),
    ...(macCauses.length ? { mac: macCauses.includes(null) ? null : macCauses.filter((item) => item !== null) } : {}),
  };
  return {
    id: slot.id,
    slot: slot.slot,
    day: slot.day,
    at: slot.at.toISOString(),
    composedAt: now.toISOString(),
    since,
    headline: briefingHeadline(alarms, owned),
    alarms,
    items,
    shippedSeen: shippedKeys.slice(0, 200),
    seen: [...seen]
      .map(([id, at]) => ({ id, at }))
      .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
      .slice(0, MAX_SEEN),
    notes: [],
  };
}

/**
 * The push headline: what moved, the breaks nobody is on, then those someone is on, said calmly. `owned` is
 * asked of every break, so a push held or retried says each as it stands: one taken on since calmly, one nobody is on
 * any more as a break.
 */
export function briefingHeadline(alarms: BriefingAlarms, owned: (item: OwnedItem) => boolean): string {
  const taken = (item: OwnedItem | null) => item !== null && owned(item);
  const [redOwned, red] = split(alarms.red, taken);
  const [deploysOwned, deploys] = split(alarms.deploys, taken);
  const [downOwned, down] = split(alarms.down, taken);
  const onRed = redOwned.length;
  const onDeploys = deploysOwned.length;
  const onDown = downOwned.length;
  const onIt = [onRed ? `${onRed} red` : null, onDeploys ? plural(onDeploys, "failed deploy") : null, onDown ? `${onDown} down` : null].filter(Boolean);
  // A Mac warning goes once someone is on every cause of it; one with a cause no record clears stays.
  const macWarning = alarms.mac !== undefined && !(alarms.mac?.length && alarms.mac.every(owned));
  const headline = [
    alarms.merged ? `${alarms.merged} merged` : null,
    alarms.shipped ? `${alarms.shipped} shipped` : null,
    red.length ? `${red.length} red` : null,
    deploys.length ? plural(deploys.length, "failed deploy") : null,
    down.length ? `${down.length} down` : null,
    onIt.length ? `${capital(ON_IT)}: ${onIt.join(", ")}` : null,
    macWarning ? "Mac warning" : null,
  ].filter(Boolean);
  return clip(headline.join(" · ") || "All quiet", 140);
}

/** Its push; with `owned`, the headline says calmly a break someone has since taken on. */
export function briefingPayload(briefing: Briefing, owned?: (item: OwnedItem) => boolean): PushPayload {
  return {
    title: briefing.slot === "morning" ? "Morning briefing" : "Evening briefing",
    body: briefing.alarms && owned ? briefingHeadline(briefing.alarms, owned) : briefing.headline,
    tag: `briefing-${briefing.id}`,
    path: "/",
  };
}
