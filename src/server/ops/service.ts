import { randomUUID } from "node:crypto";

import { MAX_ASKS } from "../../shared/asks.js";
import { BACKLOG_AHEAD_MS, BACKLOG_STALE_MS, type BacklogSnapshot, type StoredBacklogRepo } from "../../shared/backlog.js";
import { ID_PATTERN, type Need } from "../../shared/board.js";
import { PICKUP_DUE_MINUTES, PICKUP_WHY } from "../../shared/command.js";
import { RIVET_NAME } from "../../shared/names.js";
import { cardId, cardOfDownKey, cardReason, opsCardOfPushKey, type CardEntry, type CardItem } from "../../shared/ops-cards.js";
import { foldDue, foldedDone } from "../../shared/ops-done.js";
import { appOwnedItem, ciOwnedItem, isOwned, recordOf, scheduleOwnedItem, underWay, type OwnedItem } from "../../shared/ops-owned.js";
import { opsStatusKey } from "../../shared/ops-status-key.js";
import type { OpsStatus, OpsStatusKind, OpsStatusPut } from "../../shared/ops-status.js";
import {
  brokenOnMain,
  GITHUB_STALE_MS,
  gradeAccounts,
  longRed,
  MAC_STALE_MS,
  offlineSince,
  zoneClock,
  type Briefing,
  type ClaudeUsageSnapshot,
  type FlySnapshot,
  type GithubSnapshot,
  type MacSnapshot,
  type OpsResponse,
  type PullRequest,
  type TimelineResponse,
} from "../../shared/ops.js";
import { NO_REPO } from "../../shared/repos.js";
import { rankSearch, type SearchItem } from "../../shared/search.js";
import type { Worker } from "../../shared/workers.js";
import { askLateId, askOfLateId, asksPastDue } from "../asks/late.js";
import { pickupAsk, settlePickupAsks } from "../asks/made.js";
import { stageReadings, syncAskStages, syncIssueCloses } from "../asks/stages.js";
import type { HealthCheck } from "../config.js";
import type { BridgeChannel } from "../events.js";
import { openBoard, withoutHandled } from "../http.js";
import { HttpError } from "../httputil.js";
import type { PushPayload, PushReport, PushService } from "../push.js";
import { writeOpsStatus } from "../routes/ops-status.js";
import { SchedulesStore, type FailingSchedule } from "../schedules.js";
import { settleComing } from "../stamps.js";
import type { Store } from "../store.js";
import { staleRecords } from "./auto-clear.js";
import { briefingPayload, composeBriefing, currentSlot, PUSH_WINDOW_MS } from "./briefing.js";
import { noCards, opsCardItems, syncOpsCards, type ScheduleFacts } from "./cards.js";
import { backlogGreen, fixCard, fixResults, MAX_FIX_RESULTS } from "./fixes.js";
import { nextHealth, probeAll } from "./health.js";
import { held, lateCardId, lateDue, lateKey, LATE_ASK_ACK_MS, type LateLog } from "./late.js";
import { MachineHistory, macMachine } from "./machines.js";
import { nextRows } from "./next.js";
import { CHAT_CLOSED, isHoldLabel, itemId, keepsBreakingCard, machineReds, NO_PICKUPS, PICKUP_BY, PICKUP_NOTE, planPickups, QUEUE_FULL, releasePickup, scheduleRepo, type PickupState, type RedItem } from "./pickup.js";
import { MAX_NOTES } from "./schema.js";
import { OpsStore, type PendingAlert, type QueuedPush } from "./store.js";
import { alertSummary, buildApps, buildOps, buildTimeline, deployAlerts, downAlerts, isDev, isStale, type Alert, type Owned } from "./view.js";

export const TICK_MS = 60_000;
/** An alert not delivered within this long is dropped: a late "down" push helps nobody. */
export const ALERT_PUSH_MS = 2 * 3600_000;
export interface OpsDeps {
  dataDir: string;
  store: Store;
  bridge: Pick<BridgeChannel, "status"> & Partial<Pick<BridgeChannel, "sendLateAsk">>;
  push: Pick<PushService, "notify" | "flushHeld" | "onDigestSettled" | "onDigestRelease" | "onDigestReword">;
  /** RIVET_HEALTH_URLS: the apps checked, none when it is unset. */
  checks: readonly HealthCheck[];
  fetch: typeof fetch;
  now?: () => Date;
  logger?: Pick<Console, "error">;
  /** The live crew (http.ts), none when its snapshot is stale: a working chat on a PR's branch owns it. */
  workers?: () => readonly Worker[];
  /** Posts an update card, create-only (http.ts); without it no Fix result card is posted. */
  addUpdate?: (card: { id: string } & Record<string, unknown>) => { status: number; error?: string };
  /** The auto pick-up's way to the monitor chat (ops/pickup.ts); without it nothing is picked up. */
  pickup?: { send: (pickup: { kind: string; key: string; repo: string }) => string | null; monitorChat: string };
  /** Makes the wait cards again from the records and asks (http.ts); writes the board only when they changed. */
  refreshWaits?: () => void;
}

export type Ops = ReturnType<typeof createOps>;

export function createOps(deps: OpsDeps) {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? console;
  const opsStore = new OpsStore(deps.dataDir);
  const machineHistory = new MachineHistory(deps.dataDir);
  const schedules = new SchedulesStore(deps.dataDir);
  let timer: ReturnType<typeof setInterval> | null = null;
  let first: ReturnType<typeof setTimeout> | null = null;
  let ticking = false;
  let draining: Promise<void> | null = null;
  let again = false;

  const board = () => deps.store.getBoard()?.board ?? null;
  const open = () => openBoard(deps.store, schedules, board(), now());
  const apps = () => buildApps(deps.checks, opsStore.get("health") ?? {}, opsStore.get("fly"));
  /** A deploy job alert's red workflow, by its run while the GitHub snapshot still has it; null for any other alert. */
  const deployJobOwner = (key: string): OwnedItem | null => {
    const [kind, first = ""] = key.split(":");
    const run = kind === "deployjob" ? opsStore.get("github")?.runs.find((one) => String(one.id) === first) : undefined;
    return run ? ciOwnedItem(run) : null;
  };
  // A deploy job queued without an owner takes its workflow now, before newer runs push its run out.
  opsStore.fillOwners(deployJobOwner);
  /**
   * Whether a queued alert's break is owned: by the item it was queued with (a deploy job's red workflow, kept after its run
   * leaves the GitHub snapshot), else by its key: an app's by its name, a deploy job's by its run.
   */
  const alertOwned = ({ key, owner }: PendingAlert, owned: Owned): boolean => {
    if (owner) return owned(owner);
    const [kind, first = ""] = key.split(":");
    if (kind === "down" || kind === "release") return owned(appOwnedItem(first));
    const item = deployJobOwner(key);
    return item !== null && owned(item);
  };
  /** The app's ownership test over the records and crew as they are now: an owned break sends no alert. */
  const ownedNow = (): Owned => {
    const statuses = deps.store.listOpsStatuses();
    const workers = deps.workers?.() ?? [];
    return (item) => isOwned(item, recordOf(item, statuses), workers);
  };
  const notProd = ({ key }: { key: string }): boolean => {
    const parts = key.split(":");
    const target = parts[0] === "down" || parts[0] === "release" ? parts[1] : parts[0] === "deployjob" ? parts.slice(3).join(":") : undefined;
    return target !== undefined && isDev(target);
  };

  // Delivered means a device got it; a duplicate was already held or sent under the same key before a restart.
  // Held by quiet hours, its alerts are told only once the digest is delivered.
  const delivered = (report: PushReport | null) => report !== null && (report.sent > 0 || report.skipped === "duplicate");
  const stopDigest = deps.push.onDigestSettled((sent, keys) =>
    opsStore.digestSettled(sent, keys.flatMap((key) => (key.startsWith("ops:") ? [key.slice(4)] : [])), now()),
  );
  // Someone took the break on while its push was held for quiet hours: it leaves the digest, settled unsent, so it raises
  // again once nobody is on it. As with a retry, a summary goes only when someone is on every alert in it.
  // An Ops card's push quiet hours held goes with its card: one withdrawn or answered since is not delivered in the morning.
  const cardGone = (id: string) => !open()?.needs.some((need) => need.id === id);
  const stopRelease = deps.push.onDigestRelease((keys) => {
    const withdrawn = keys.filter((key) => {
      const id = opsCardOfPushKey(key) ?? cardOfDownKey(key);
      return id !== null && cardGone(id);
    });
    const held = keys.filter((key) => key.startsWith("ops:") && !key.startsWith("ops:briefing:"));
    if (!held.length) return withdrawn;
    const owned = ownedNow();
    return [
      ...withdrawn,
      ...held.filter((key) => {
        const alerts = opsStore.pendingAlerts(key.slice(4));
        return alerts.length > 0 && alerts.every((alert) => alertOwned(alert, owned));
      }),
    ];
  });
  /** A briefing's push, its headline saying calmly a break someone is on now; null for a briefing not stored. */
  const briefingPush = (key: string, owned: Owned): PushPayload | null => {
    const briefing = opsStore.getBriefing(key.slice("briefing:".length));
    return briefing ? briefingPayload(briefing, owned) : null;
  };
  // A briefing held for quiet hours names its breaks as they stand when the digest goes.
  const stopReword = deps.push.onDigestReword((bodies) => {
    const held = bodies.filter(({ key }) => key.startsWith("ops:briefing:"));
    if (!held.length) return [];
    const owned = ownedNow();
    return held.flatMap(({ key }) => {
      const payload = briefingPush(key.slice(4), owned);
      return payload ? [{ key, body: payload.body }] : [];
    });
  });

  async function deliverDue(): Promise<void> {
    const { due, dropped, unlisted } = opsStore.duePushes(now());
    if (dropped) logger.error(`[ops] gave up on ${dropped} undelivered push${dropped === 1 ? "" : "es"}`);
    let untold = unlisted;
    const owned = due.length ? ownedNow() : null;
    for (const item of due) {
      // An app-down push whose card was withdrawn or answered while it waited is not sent.
      const downCard = cardOfDownKey(item.key);
      if (downCard !== null && cardGone(downCard)) {
        opsStore.pushDropped(item.key);
        continue;
      }
      // Someone took the break on while its push waited (a retry): it is dropped, so it raises again once nobody is on it.
      // A summary goes only when someone is on every alert in it, so no other alert loses its retries.
      const alerts = owned && item.category !== "briefing" ? opsStore.pendingAlerts(item.key) : [];
      if (alerts.length && alerts.every((alert) => alertOwned(alert, owned!))) {
        opsStore.pushDropped(item.key);
        continue;
      }
      if (notProd(item)) {
        opsStore.pushDelivered(item.key, now());
        continue;
      }
      const mention = untold > 0 && item.category !== "briefing" ? untold : 0;
      // A briefing's retry says calmly a break someone has taken on since it was composed.
      const payload = (item.category === "briefing" && briefingPush(item.key, owned ?? ownedNow())) || item.payload;
      const report = await deps.push.notify(payload, item.category, `ops:${item.key}`, mention).catch((error: unknown) => {
        logger.error(`[ops] push failed: ${error instanceof Error ? error.message : "error"}`);
        return null;
      });
      const held = report?.skipped === "quiet";
      if (delivered(report) || held) {
        if (held) opsStore.pushHeld(item.key);
        else opsStore.pushDelivered(item.key, now());
        // Sent, the push stated the count; held, the digest now carries it. A duplicate may not have, so it stays.
        if (mention && (report!.sent > 0 || held)) {
          opsStore.clearUnlisted(mention);
          untold = 0;
        }
      } else opsStore.pushFailed(item.key, now());
    }
  }

  /** Sends what the outbox holds; a call while a pass runs gets one more pass after it. */
  function deliverPushes(): Promise<void> {
    if (draining) {
      again = true;
      return draining;
    }
    draining = (async () => {
      do {
        again = false;
        await deliverDue();
      } while (again);
    })().finally(() => {
      draining = null;
    });
    return draining;
  }

  async function raise(alerts: Alert[]): Promise<void> {
    const at = now();
    const expiresAt = new Date(at.getTime() + ALERT_PUSH_MS);
    opsStore.raiseAlerts(
      alerts.map((alert) => ({ key: alert.key, category: alert.category, payload: alert.payload, expiresAt, owner: alert.owner })),
      at,
      alertSummary,
    );
    await deliverPushes();
  }

  function view(): OpsResponse {
    const read = schedules.view(now());
    return { ...buildOps({
      now: now(),
      bridgeConnected: deps.bridge.status().connected,
      board: open(),
      github: opsStore.get("github"),
      runnersOffline: opsStore.get("runnersOffline") ?? {},
      mac: opsStore.get("mac"),
      claude: opsStore.get("claude"),
      fly: opsStore.get("fly"),
      checks: deps.checks,
      health: opsStore.get("health") ?? {},
      // An old schedules reading counts nothing, as the Schedules tab marks it old; its feed cards stay.
      failingRuns: schedules.view(now()).stale ? [] : schedules.failingSchedules(now()).map(({ url }) => url),
      schedulesAt: schedules.view(now()).at,
    }), next: nextRows(now(), read.stale ? null : read.items) };
  }

  function timeline(): TimelineResponse {
    return buildTimeline({ now: now(), merged: opsStore.get("merged") ?? [], fly: opsStore.get("fly"), board: board() });
  }

  async function putGithub(sent: GithubSnapshot): Promise<void> {
    const at = now();
    const snapshot = notAhead(sent, at);
    if (snapshot.merged) opsStore.put("merged", snapshot.merged, at);
    if (snapshot.closed) opsStore.put("closed", snapshot.closed, at);
    if (snapshot.merged || snapshot.closed) {
      const stored = deps.store.getBoard();
      const settled = stored && settleComing(stored.board, { merged: opsStore.get("merged") ?? [], closed: opsStore.get("closed") ?? [], open: snapshot.prsComplete === true && snapshot.sources?.prs.failed.length === 0 && !isStale(snapshot.at, GITHUB_STALE_MS, at) ? snapshot.prs : null, now: at.toISOString() });
      if (settled) deps.store.putBoard(settled.board, stored.version);
    }
    opsStore.put("github", { ...snapshot, merged: null, closed: null }, at);
    syncAskStages(deps.store, deps.workers?.() ?? [], stageReadings(deps.store, opsStore.get("github"), opsStore.get("merged"), at), at);
    // Only fresh runner data counts: when GitHub failed the bridge resends its last reading.
    if (snapshot.runners && !snapshot.sources?.runners.failed.length) {
      opsStore.put("runnersOffline", offlineSince(opsStore.get("runnersOffline") ?? {}, snapshot.runners, at.toISOString()), at);
    }
    await raise(deployAlerts({ now: at, fly: null, github: snapshot, owned: ownedNow() }));
  }

  /** A repo this pass could not read keeps its last reading and that reading's time, so its sheet says how old it is. */
  function putBacklog(sent: BacklogSnapshot): void {
    const at = now();
    const fresh = notAhead(sent, at);
    const stored = opsStore.get("backlog");
    const read = new Set(fresh.repos.map((one) => one.repo));
    const kept = (stored?.repos ?? []).filter((one) => !read.has(one.repo));
    const repos: StoredBacklogRepo[] = [...fresh.repos.map((one) => ({ ...one, at: fresh.at })), ...kept];
    opsStore.put("backlog", { at: fresh.at, repos }, at);
    // Only a current reading finishes asks. One that is late, says nothing of an issue reopened since. So does one that is
    // not after the newest that did, by the bridge's own unclamped time; a replay is one of those. The mark only moves
    // forward. Over a store from before it, it starts just past now, kept at once: no reading sent before this one counts.
    // A reading dated more than a few minutes ahead finishes nothing and moves no mark, so a wrong clock cannot hold back
    // the readings after it.
    const sentMs = Date.parse(sent.at);
    let mark = opsStore.get("backlogClosesAt") ?? undefined;
    if (mark === undefined && stored) {
      mark = new Date(at.getTime() + BACKLOG_AHEAD_MS).toISOString();
      opsStore.put("backlogClosesAt", mark, at);
    }
    if (isStale(fresh.at, BACKLOG_STALE_MS, at) || sentMs > at.getTime() + BACKLOG_AHEAD_MS) return;
    if (mark !== undefined && sentMs <= Date.parse(mark)) return;
    opsStore.put("backlogClosesAt", new Date(sentMs).toISOString(), at);
    syncIssueCloses(deps.store, fresh.repos, at);
  }

  function putMac(snapshot: MacSnapshot): void {
    const at = now();
    const reading = notAhead(snapshot, at);
    opsStore.put("mac", reading, at);
    machineHistory.record([macMachine(reading)], at);
  }

  function putClaude(snapshot: ClaudeUsageSnapshot): void {
    const at = now();
    opsStore.put("claude", notAhead({ ...snapshot, limits: gradeAccounts(snapshot.limits) }, at), at);
  }

  async function putFly(sent: FlySnapshot): Promise<void> {
    const at = now();
    const snapshot = notAhead(sent, at);
    opsStore.put("fly", snapshot, at);
    await raise(deployAlerts({ now: at, fly: snapshot, github: null, owned: ownedNow() }));
  }

  async function probeTick(): Promise<void> {
    const results = await probeAll(deps.checks, deps.fetch);
    const at = now();
    const health = opsStore.get("health") ?? {};
    for (const [app, result] of results) health[app] = nextHealth(health[app], result, at);
    const known = new Set(deps.checks.map((check) => check.name));
    for (const app of Object.keys(health)) if (!known.has(app)) delete health[app];
    opsStore.put("health", health, at);
    await raise(downAlerts(apps(), ownedNow()));
  }

  /** Composes the current slot's briefing once; queues its push when it is not hours late. */
  async function briefingTick(): Promise<Briefing | null> {
    const at = now();
    const slot = currentSlot(at);
    if (opsStore.getBriefing(slot.id)) return null;
    const mac = opsStore.get("mac");
    const claude = opsStore.get("claude");
    const briefing = composeBriefing(
      {
        board: open(),
        github: opsStore.get("github"),
        merged: opsStore.get("merged") ?? [],
        fly: opsStore.get("fly"),
        apps: apps(),
        mac,
        macStale: isStale(mac?.at, MAC_STALE_MS, at),
        previous: opsStore.latestBriefing(),
        owned: ownedNow(),
      },
      slot,
      at,
    );
    const expiresAt = new Date(slot.at.getTime() + PUSH_WINDOW_MS);
    const push: QueuedPush | null = at < expiresAt ? { key: `briefing:${briefing.id}`, category: "briefing", payload: briefingPayload(briefing), expiresAt } : null;
    if (!opsStore.addBriefing(briefing, push, at)) return null;
    await deliverPushes();
    return briefing;
  }

  /** A note of Rivet's lands on the briefing on show; null when there is none yet. */
  function addNote(text: string): Briefing | null {
    const latest = opsStore.latestBriefing();
    if (!latest) return null;
    const notes = [...latest.notes, { text: text.trim(), at: now().toISOString() }].slice(-MAX_NOTES);
    const updated = { ...latest, notes };
    opsStore.replaceBriefing(updated);
    return updated;
  }

  /** What the app does not hold in memory: every stored reply, past briefings, the 14-day timeline. */
  function searchHistory(query: string): SearchItem[] {
    const items: SearchItem[] = [];
    for (const reply of deps.store.listReplies({ limit: 500 })) {
      items.push({
        kind: "reply",
        key: `reply:${reply.id}`,
        title: reply.itemTitle,
        detail: [reply.decision, reply.choice, reply.text].filter(Boolean).join(" "),
        at: reply.at,
        repo: reply.item.repo,
        open: { type: "reply", id: reply.id },
      });
    }
    for (const briefing of opsStore.listBriefings(60)) {
      items.push({
        kind: "briefing",
        key: `briefing:${briefing.id}`,
        title: `${briefing.slot === "morning" ? "Morning" : "Evening"} briefing ${briefing.day}`,
        detail: [briefing.headline, ...briefing.items.flatMap((item) => [item.title, ...item.lines]), ...briefing.notes.map((note) => note.text)].join(" "),
        at: briefing.composedAt,
        open: { type: "briefing", id: briefing.id },
      });
    }
    for (const day of timeline().days) {
      for (const event of day.events) {
        items.push({
          kind: "timeline",
          key: event.number ? `pr:${event.repo}#${event.number}` : event.app ? `deploy:${event.app}:${event.title}` : `${event.kind}:${event.title}`,
          title: event.number ? `#${event.number} ${event.title}` : event.title,
          detail: `${event.kind} ${day.day}`,
          at: event.at,
          repo: event.repo,
          open: event.url ? { type: "url", url: event.url } : { type: "tab", tab: "ops", section: "timeline" },
        });
      }
    }
    return rankSearch(items, query, now().getTime());
  }

  /** Drops each stored card HANDLED_DROP_MS after the answer to what it shows now was handled; a card asked again stays. */

  /** Fix result cards: an item with work under way that went green is set fixed, then it and any record set fixed get one. */
  function settleFixes(): void {
    if (!deps.addUpdate) return;
    const at = now();
    const read = schedules.view(at);
    const readings = { view: view(), schedules: [...(read.stale ? [] : read.items), ...schedules.jobs.readings()] };
    const posted = opsStore.get("fixResults") ?? [];
    // Failures read red at a pass, so a later green reads as the item going green; stored, so a restart keeps them.
    const before = opsStore.get("fixSeenRed") ?? [];
    const seenRed = new Set(before);
    for (const { status, green } of fixResults(deps.store.listOpsStatuses(), readings, at, seenRed)) {
      const card = fixCard(status, readings);
      // The card first, then the record: a record set fixed whose card the board refused would never get it.
      if (!posted.includes(card.id)) {
        const added = deps.addUpdate(card);
        if (added.status !== 200 && added.status !== 409) {
          logger.error(`[ops] Fix result ${card.id} refused: ${added.error ?? added.status}`);
          continue;
        }
        posted.push(card.id);
        opsStore.put("fixResults", posted.slice(-MAX_FIX_RESULTS), at);
      }
      if (green) deps.store.replaceOpsStatus({ ...status, state: "fixed", updatedAt: at.toISOString(), by: RIVET_NAME, version: deps.store.nextOpsStatusVersion() }, status.version);
    }
    const after = [...seenRed];
    if (after.length !== before.length || after.some((failure, i) => failure !== before[i])) opsStore.put("fixSeenRed", after.slice(-MAX_FIX_RESULTS), at);
  }

  /**
   * Sets fixed each record whose PR merged or closed, or whose workflow or schedule ran green since it began, or
   * with no Fix result card: the item ended, nobody fixed it. Runs after settleFixes, which keeps its card for a fix.
   */
  function clearStale(): void {
    const at = now();
    const read = schedules.view(at);
    const readings = { view: view(), schedules: [...(read.stale ? [] : read.items), ...schedules.jobs.readings()] };
    const stale = staleRecords(deps.store.listOpsStatuses(), {
      github: readings.view.github,
      merged: opsStore.get("merged") ?? [],
      closed: opsStore.get("closed") ?? [],
      schedules: readings.schedules,
      scheduleSources: read.sources,
      backlogGreen: (status) => backlogGreen(status, readings),
    });
    if (stale.length === 0) return;
    const posted = opsStore.get("fixResults") ?? [];
    const seenRed = new Set(opsStore.get("fixSeenRed") ?? []);
    for (const { status, note } of stale) {
      const cleared = { ...status, state: "fixed" as const, ...(note ? { note } : {}), updatedAt: at.toISOString(), by: RIVET_NAME, version: deps.store.nextOpsStatusVersion() };
      if (!deps.store.replaceOpsStatus(cleared, status.version)) continue;
      // A ci or schedule failure settleFixes saw red keeps its card: set fixed, settleFixes posts it (and retries one
      // the board refused) while the record is in its window and the item reads green.
      if (status.kind !== "pr" && seenRed.has(`${status.kind}/${status.key}/${status.since}`)) continue;
      const id = fixCard(status, readings).id;
      if (!posted.includes(id)) posted.push(id);
    }
    opsStore.put("fixResults", posted.slice(-MAX_FIX_RESULTS), at);
  }

  /** The id of the Ops card for the record's failure, at its current generation. */
  function opsCardIdOf(item: { kind: string; key: string; since: string }): string {
    const base = cardId({ kind: item.kind, key: item.key, incident: item.since });
    const generation = opsStore.get("opsCards")?.gens[base];
    return generation ? cardId({ kind: item.kind, key: item.key, incident: item.since, generation }) : base;
  }

  /**
   * Whether a card for the record's failure is open, unanswered: its Ops card or the late sweeper's third-late card. One
   * failure gets one card, so neither pass raises its own over the other's.
   */
  function hasOpenCard(item: { kind: string; key: string; since: string }, of: "ops" | "late" | "either" = "either"): boolean {
    return (of !== "late" && !cardGone(opsCardIdOf(item))) || (of !== "ops" && !cardGone(lateCardId({ kind: item.kind as OpsStatus["kind"], key: item.key, since: item.since })));
  }

  /** The Ops cards (ops/cards.ts): the one rule for which items become a Needs-you card, run on the records and PRs as they are. */
  function syncCards(): void {
    if (!deps.addUpdate) return;
    const at = now();
    // Every schedule's name counts toward the money test, failing twice or not. A schedule failing with no one on it has
    // SchedulesStore's card, and its record is carded here once owned, unless you already answered that failure's card.
    const failing = new Map(schedules.failing(at).map((one) => [one.scheduleId, one]));
    const factsOf = (name: string, what: string | undefined, one: FailingSchedule | undefined): ScheduleFacts => ({
      name,
      what,
      handled: !!one && !one.answered && !one.owned && !one.held,
      ...(one?.answered && one.answeredAt && Date.parse(one.need.since ?? one.answeredAt) <= Date.parse(one.answeredAt) ? { answered: true } : {}),
    });
    // Your own jobs are no schedule on the bridge's list, but a red one has its card too; its words count for money.
    const scheduleFacts = new Map<string, ScheduleFacts>([...schedules.view(at).items, ...schedules.jobs.readings()].map((item) => [opsStatusKey("schedule", item.id), factsOf(item.name, item.what, failing.get(item.id))]));
    const before = opsStore.get("opsCards") ?? noCards();
    // While an item's late card is open its Ops card is not posted, and one posted already is kept exactly as it is: a
    // rewrite would reopen an answered card. An app down breaks quiet hours, so it is carded anyway, and its late card goes
    // once that card is on the board, open.
    const items: CardItem[] = [];
    const kept: Record<string, CardEntry> = {};
    const lateOf = new Map<string, string>();
    const cleared = new Set<string>();
    for (const item of opsCardItems(deps.store.listOpsStatuses(), view(), scheduleFacts, opsStore.get("ownerHolds") ?? [], cleared)) {
      const one = item.incident === undefined ? null : { kind: item.kind as OpsStatus["kind"], key: item.key, since: item.incident };
      if (one === null || cardGone(lateCardId(one))) {
        items.push(item);
      } else if (cardReason(item, at) === "app-down") {
        items.push(item);
        lateOf.set(opsCardIdOf(one), lateCardId(one));
      } else if (before.cards[opsCardIdOf(one)]) {
        kept[opsCardIdOf(one)] = before.cards[opsCardIdOf(one)]!;
      }
    }
    const book = { ...before, cards: Object.fromEntries(Object.entries(before.cards).filter(([id]) => !(id in kept))) };
    const synced = syncOpsCards({ store: deps.store, addUpdate: deps.addUpdate, raise, isOpen: (id) => !cardGone(id), now: at, logger }, items, book, cleared);
    const after = { ...synced, cards: { ...synced.cards, ...kept } };
    const withdraw = [...lateOf].filter(([id]) => after.cards[id] !== undefined && !cardGone(id)).map(([, late]) => late);
    const stored = withdraw.length ? deps.store.getBoard() : null;
    if (stored) deps.store.putBoard({ ...stored.board, needs: stored.board.needs.filter((need) => !withdraw.includes(need.id)), updatedAt: at.toISOString() }, stored.version);
    if (JSON.stringify(after) !== JSON.stringify(before)) opsStore.put("opsCards", after, at);
  }

  /** Once a local day after 4am, removes the fixed records over 24 hours old that have no open card (shared/ops-done.ts). */
  function foldDone(): number {
    const at = now();
    const day = zoneClock(at).day;
    if (!foldDue(at, opsStore.get("doneFoldDay"))) return 0;
    let folded = 0;
    for (const status of foldedDone(deps.store.listOpsStatuses(), at, hasOpenCard)) if (deps.store.deleteOpsStatus(status.kind, status.key, status.version)) folded += 1;
    opsStore.put("doneFoldDay", day, at);
    return folded;
  }

  /**
   * Marks `askedForTimeAt` on each record with work under way whose dueAt has passed, once per dueAt, and asks its chat
   * why through the bridge (retried until acked), each time; going late again raises no card of its own.
   */
  function sweepLate(): void {
    const at = now();
    const statuses = deps.store.listOpsStatuses();
    const logs: Record<string, LateLog> = { ...(opsStore.get("late") ?? {}) };
    const open = new Set(statuses.filter((status) => status.state !== "fixed").map(lateKey));
    for (const key of Object.keys(logs)) if (!open.has(key)) delete logs[key];
    const prs = opsStore.get("github")?.prs;
    const { held: holds } = redItems(at, statuses);
    const isHeld = (status: OpsStatus) => held(status, holds, prs);
    try {
      for (const { status, dueAt } of lateDue(statuses, logs, at, isHeld)) {
        // updatedAt stays: asking for a time is not work on it, and the orphan sweep reads updatedAt as the last.
        const marked = { ...status, askedForTimeAt: at.toISOString(), version: deps.store.nextOpsStatusVersion() };
        if (!deps.store.replaceOpsStatus(marked, status.version)) continue;
        const log = (logs[lateKey(status)] ??= { dueAts: [], asks: [] });
        log.dueAts.push(dueAt);
        log.asks.push({ dueAt, id: randomUUID(), sentAt: null, delivered: false });
      }
      for (const [key, log] of Object.entries(logs)) {
        const status = statuses.find((one) => lateKey(one) === key);
        if (!status || !underWay(status) || isHeld(status)) continue;
        // A log that asked nothing from the third late on: its current time, logged late, is asked now.
        const current = status.dueAt ? new Date(status.dueAt).toISOString() : null;
        if (current && log.dueAts.includes(current) && !log.asks.some((ask) => ask.dueAt === current)) log.asks.push({ dueAt: current, id: randomUUID(), sentAt: null, delivered: false });
        for (const ask of log.asks) {
          if (ask.delivered || (ask.sentAt !== null && at.getTime() - Date.parse(ask.sentAt) < LATE_ASK_ACK_MS)) continue;
          if (deps.bridge.sendLateAsk?.(ask.id, { kind: status.kind, key: status.key, ...(status.chat ? { chat: status.chat } : {}), dueAt: ask.dueAt })) ask.sentAt = at.toISOString();
        }
      }
    } finally {
      opsStore.put("late", logs, at);
    }
  }

  // An ask's time question by its event id: when it last went to the bridge, null to send again. In memory: after a
  // restart it goes once more, and the bridge types each id once.
  const askQuestions = new Map<string, string | null>();

  /**
   * Asks each ask's chat once for a new time when the ask runs past its dueAt with none given, through the bridge,
   * retried until acked; the delivered ack marks the ask `askedForTimeAt`. Its new time, with the reason, is a move the
   * ask keeps; its row shows it, with no card.
   */
  function sweepAskTimes(): void {
    const at = now();
    const due = asksPastDue(deps.store.listAsks({ limit: MAX_ASKS }), at);
    const ids = new Set(due.map(askLateId));
    for (const id of askQuestions.keys()) if (!ids.has(id)) askQuestions.delete(id);
    for (const ask of due) {
      const id = askLateId(ask);
      const sentAt = askQuestions.get(id);
      if (sentAt && at.getTime() - Date.parse(sentAt) < LATE_ASK_ACK_MS) continue;
      if (deps.bridge.sendLateAsk?.(id, { kind: "ask", key: ask.id, ...(ask.chat !== undefined && ID_PATTERN.test(ask.chat) ? { chat: ask.chat } : {}), dueAt: ask.dueAt as string })) askQuestions.set(id, at.toISOString());
    }
  }

  /**
   * The bridge's word on an ask's time question: delivered marks the ask asked, unless its time changed since. False for
   * an id neither sent nor the ask's current question (one sent before a restart is still its current one).
   */
  function ackAskTime(id: string, delivered: boolean): boolean {
    const ask = deps.store.getAsk(askOfLateId(id) ?? "");
    const current = ask !== null && ask.dueAt !== undefined && askLateId(ask) === id;
    const sent = askQuestions.has(id);
    if (!current && !sent) return false;
    if (!delivered) {
      if (sent) askQuestions.set(id, null);
      return true;
    }
    askQuestions.delete(id);
    if (current && ask.askedForTimeAt === undefined) {
      const at = now().toISOString();
      deps.store.replaceAsk({ ...ask, askedForTimeAt: at, updatedAt: at, version: ask.version + 1 }, ask.version);
    }
    return true;
  }

  /** The bridge's word on a late question it was sent. False for an id the sweeper never sent. */
  function ackLateAsk(id: string, delivered: boolean): boolean {
    if (askOfLateId(id) !== null) return ackAskTime(id, delivered);
    const at = now();
    const logs: Record<string, LateLog> = { ...(opsStore.get("late") ?? {}) };
    const ask = Object.values(logs)
      .flatMap((log) => log.asks)
      .find((one) => one.id === id);
    if (!ask) return false;
    if (delivered) ask.delivered = true;
    else ask.sentAt = null;
    opsStore.put("late", logs, at);
    return true;
  }

  /**
   * The red items the auto pick-up reads, as the app counts them: main's broken workflows, prod apps down, ready PRs red
   * on one push over an hour, failing schedules you have not answered, and the machine, disk and runner reds. `held`:
   * heldItems, read or not red, never touched.
   */
  function redItems(at: Date, statuses: readonly OpsStatus[]): { red: RedItem[]; held: Set<string> } {
    const red: RedItem[] = [];
    const held = heldItems(at, statuses);
    const github = opsStore.get("github");
    const fresh = github !== null && github !== undefined && !isStale(github.at, GITHUB_STALE_MS, at);
    if (fresh && !github.sources?.runs.failed.length) {
      for (const run of brokenOnMain(github.runs)) red.push({ ...ciOwnedItem(run), name: run.workflow, detail: [run.title, ...(run.failedJobs ?? [])].join(", ") });
    }
    const failed = new Set(github?.sources?.prs.failed ?? []);
    for (const pr of github?.prs ?? []) {
      const item = prItem(pr);
      if (!held.has(itemId(item)) && fresh && !pr.draft && !failed.has(pr.repo.split("/").pop() ?? pr.repo) && longRed(pr, at.getTime())) red.push(item);
    }
    for (const app of apps()) {
      if (app.health.state === "down" && app.health.since && !isDev(app.name)) red.push({ ...appOwnedItem(app.id), name: app.name });
    }
    if (!schedules.view(at).stale) {
      for (const failing of schedules.failing(at)) {
        if (failing.answered) continue;
        red.push({ ...scheduleOwnedItem(failing.scheduleId), repo: scheduleRepo(failing.scheduleId, failing.need.repo), name: failing.need.title, detail: failing.detail });
      }
    }
    red.push(...machineReds(view()));
    return { red, held };
  }

  /**
   * The PR items no automation touches: PRs held (a hold label, a hold in the body, its comments or the holds file).
   * With GitHub's reading stale or missing, its last holds stand and
   * every PR record is held; a repo whose PR read failed is treated so for its own PRs.
   */
  function heldItems(at: Date, statuses: readonly OpsStatus[]): Set<string> {
    const held = new Set<string>();
    const github = opsStore.get("github");
    const fresh = github !== null && github !== undefined && !isStale(github.at, GITHUB_STALE_MS, at);
    for (const pr of github?.prs ?? []) {
      const item = prItem(pr);
      if (pr.hold || pr.labels.some(isHoldLabel)) held.add(itemId(item));
    }
    const unread = [...(github?.sources?.prs.failed ?? [])].map((name) => opsStatusKey("pr", "", `${NO_REPO.split("/")[0]}/${name}`));
    const inUnread = (key: string) => unread.some((prefix) => (prefix === "" ? !key.includes("/") : key.startsWith(prefix)));
    for (const status of statuses) if (status.kind === "pr" && (!fresh || inUnread(status.key))) held.add(itemId(status));
    return held;
  }

  /** The pick-up's record taken back to the one it replaced, unless someone changed it since. Its start still counts. */
  function takeBack(state: PickupState, id: string): PickupState {
    const released = releasePickup(state, id);
    const sent = released.sent;
    if (sent) restore(sent.kind, sent.key, sent.version, sent.prev ?? null);
    return released.state;
  }

  function restore(kind: OpsStatusKind, key: string, version: number, prev: OpsStatus | null): void {
    if (!prev) deps.store.deleteOpsStatus(kind, key, version);
    // A parked record keeps its time: a pick-up that failed must not re-park trouble newer than the record.
    else deps.store.replaceOpsStatus({ ...prev, updatedAt: prev.state === "parked" ? prev.updatedAt : now().toISOString(), version: deps.store.nextOpsStatusVersion() }, version);
  }

  /** No red goes unowned (ops/pickup.ts): sends the monitor each red item nobody is on, or marks it Late when a cap is hit. */
  function pickupTick(): void {
    settlePickupAsks(deps.store, deps.store.listOpsStatuses(), now());
    const pickup = deps.pickup;
    if (!pickup) return;
    const at = now();
    const iso = at.toISOString();
    const statuses = deps.store.listOpsStatuses();
    const { red, held } = redItems(at, statuses);
    const plan = planPickups({ red, statuses, workers: deps.workers?.() ?? [], held, monitorChat: pickup.monitorChat, state: opsStore.get("pickup") ?? NO_PICKUPS, now: at });
    let state = plan.state;
    for (const id of plan.expired) state = takeBack(state, id);
    const write = (item: { kind: OpsStatusKind; key: string }, change: OpsStatusPut, askedForTimeAt?: string) => {
      const before = deps.store.getOpsStatus(item.kind, item.key);
      let code: number;
      let written: OpsStatus | null = null;
      try {
        const result = writeOpsStatus(deps.store, item.kind, item.key, change, before?.version ?? 0, iso, { monitor: pickup.monitorChat, ...(askedForTimeAt ? { askedForTimeAt } : {}) });
        code = result.code;
        written = result.status;
      } catch (error) {
        code = error instanceof HttpError ? error.status : 500;
      }
      if (!written) logger.error(`[ops] pick-up of ${item.kind} ${item.key}: status refused (${code})`);
      return written && { written, before };
    };
    for (const status of plan.orphans) write(status, { state: "backlog", by: PICKUP_BY, why: CHAT_CLOSED }, iso);
    for (const item of plan.queueFull) write(item, { state: "backlog", by: PICKUP_BY, why: QUEUE_FULL }, deps.store.getOpsStatus(item.kind, item.key)?.askedForTimeAt ?? iso);
    for (const item of plan.start) {
      // The record first: one the store refuses sends nothing, and counts toward the hour so it is not tried every tick.
      const wrote = write(item, { state: "investigating", by: PICKUP_BY, note: PICKUP_NOTE, chat: null, eta: String(PICKUP_DUE_MINUTES), why: PICKUP_WHY });
      if (!wrote) {
        state = { ...state, refused: [...(state.refused ?? []), { item: itemId(item), at: iso }] };
        continue;
      }
      // The start is stored before the send, so a restart between them still counts it toward the caps.
      const before = state;
      state = { ...state, starts: [...state.starts, { item: itemId(item), at: iso }] };
      opsStore.put("pickup", state, at);
      const id = pickup.send({ kind: item.kind, key: item.key, repo: item.repo });
      // No capable bridge: the record and the start go back and the next tick tries again.
      if (id === null) {
        restore(item.kind, item.key, wrote.written.version, wrote.before);
        state = before;
        break;
      }
      state = { ...state, sent: { ...state.sent, [id]: { kind: item.kind, key: item.key, at: iso, version: wrote.written.version, prev: wrote.before } } };
      opsStore.put("pickup", state, at);
      // Rivet's own ask for it, beside yours on Progress with the same stage and time.
      if (!pickupAsk(deps.store, item, at, PICKUP_DUE_MINUTES)) logger.error(`[ops] pick-up of ${item.kind} ${item.key}: its ask was refused`);
    }
    for (const { item, episode } of plan.keepsBreaking) {
      const added = deps.addUpdate?.(keepsBreakingCard(item, episode));
      if (added?.status === 200 || added?.status === 409) state = { ...state, cards: [...state.cards, itemId(item)] };
      else if (added) logger.error(`[ops] keeps-breaking card for ${item.kind} ${item.key} refused: ${added.error ?? added.status}`);
    }
    opsStore.put("pickup", state, at);
  }

  /** The bridge's word on a pick-up: typed into the monitor chat, or not, when its record is taken back. False for an unknown id. */
  function ackPickup(id: string, delivered: boolean): boolean {
    const state = opsStore.get("pickup") ?? NO_PICKUPS;
    if (!state.sent[id]) return false;
    const { [id]: acked, ...sent } = state.sent;
    const at = now();
    opsStore.put("pickup", delivered ? { ...state, sent, acked: [...(state.acked ?? []), { item: itemId(acked!), at: at.toISOString() }] } : takeBack(state, id), at);
    return true;
  }

  function dropHandled(): void {
    const stored = deps.store.getBoard();
    const kept = stored && withoutHandled(deps.store, stored.board, now());
    if (kept) deps.store.putBoard(kept, stored.version);
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      try {
        dropHandled();
      } catch (error) {
        logger.error(`[ops] handled-card drop failed: ${error instanceof Error ? error.message : "error"}`);
      }
      await probeTick().catch((error: unknown) => logger.error(`[ops] health probe failed: ${error instanceof Error ? error.message : "error"}`));
      try {
        settleFixes();
      } catch (error) {
        logger.error(`[ops] Fix results failed: ${error instanceof Error ? error.message : "error"}`);
      }
      try {
        clearStale();
      } catch (error) {
        logger.error(`[ops] stale record clear failed: ${error instanceof Error ? error.message : "error"}`);
      }
      try {
        sweepLate();
      } catch (error) {
        logger.error(`[ops] late sweep failed: ${error instanceof Error ? error.message : "error"}`);
      }
      try {
        sweepAskTimes();
      } catch (error) {
        logger.error(`[ops] ask time sweep failed: ${error instanceof Error ? error.message : "error"}`);
      }
      try {
        syncCards();
      } catch (error) {
        logger.error(`[ops] Ops cards failed: ${error instanceof Error ? error.message : "error"}`);
      }
      try {
        foldDone();
      } catch (error) {
        logger.error(`[ops] Done fold failed: ${error instanceof Error ? error.message : "error"}`);
      }
      try {
        pickupTick();
      } catch (error) {
        logger.error(`[ops] auto pick-up failed: ${error instanceof Error ? error.message : "error"}`);
      }
      // The passes above settle, fold, mark and write records and asks the wait cards read.
      try {
        deps.refreshWaits?.();
      } catch (error) {
        logger.error(`[ops] wait cards failed: ${error instanceof Error ? error.message : "error"}`);
      }
      await briefingTick().catch((error: unknown) => logger.error(`[ops] briefing failed: ${error instanceof Error ? error.message : "error"}`));
      await deliverPushes().catch((error: unknown) => logger.error(`[ops] push retry failed: ${error instanceof Error ? error.message : "error"}`));
      await deps.push.flushHeld().catch((error: unknown) => logger.error(`[ops] digest failed: ${error instanceof Error ? error.message : "error"}`));
    } finally {
      ticking = false;
    }
  }

  return {
    store: opsStore,
    view,
    timeline,
    putGithub,
    putBacklog,
    /** The Mac's readings after `since` (epoch seconds), for the Machines trend. */
    machineHistory: (since?: number) => machineHistory.read(now(), since),
    putMac,
    putClaude,
    putFly,
    probeTick,
    briefingTick,
    deliverPushes,
    dropHandled,
    settleFixes,
    clearStale,
    sweepLate,
    sweepAskTimes,
    ackLateAsk,
    syncCards,
    foldDone,
    pickupTick,
    ackPickup,
    addNote,
    searchHistory,
    latestBriefing: () => opsStore.latestBriefing(),
    /** The names an up check may ask about: RIVET_HEALTH_URLS. */
    checkNames: () => deps.checks.map((check) => check.name),
    /** Health probes, briefings and the quiet-hours digest, every minute. */
    start(): void {
      if (timer) return;
      timer = setInterval(() => void tick(), TICK_MS);
      timer.unref();
      first = setTimeout(() => void tick(), 5_000);
      first.unref();
    },
    close(): void {
      if (timer) clearInterval(timer);
      if (first) clearTimeout(first);
      timer = null;
      stopDigest();
      stopRelease();
      stopReword();
      opsStore.close();
      machineHistory.close();
      schedules.close();
    },
  };
}

/** A PR as a red item. */
function prItem(pr: PullRequest): RedItem {
  return { kind: "pr", key: opsStatusKey("pr", String(pr.number), pr.repo), repo: pr.repo, ...(pr.branch ? { branch: pr.branch } : {}), draft: false, name: `#${pr.number} ${pr.title}`, detail: pr.checks.failing.join(", ") };
}

/**
 * A snapshot stamped later than it arrived takes the server's arrival time: with the Mac's clock ahead, a
 * future `at` would read as fresh long after collection stopped. A clock behind only makes data look older.
 */
export function notAhead<T extends { at: string }>(snapshot: T, at: Date): T {
  return Date.parse(snapshot.at) > at.getTime() ? { ...snapshot, at: at.toISOString() } : snapshot;
}
