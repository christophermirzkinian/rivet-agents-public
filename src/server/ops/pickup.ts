import { createHash } from "node:crypto";

import { diskTone, GITHUB_STALE_MS, MAC_STALE_MS, type OpsResponse } from "../../shared/ops.js";
import { diskOwnedItem, HANDLER_BY, isOwned, macOwnedItem, recordOf, underWay, type OwnedItem } from "../../shared/ops-owned.js";
import { opsStatusKey, statusKeyRepo } from "../../shared/ops-status-key.js";
import type { OpsStatus, OpsStatusKind } from "../../shared/ops-status.js";
import { RIVET_NAME } from "../../shared/names.js";
import { isRepo, NO_REPO } from "../../shared/repos.js";
import type { Worker } from "../../shared/workers.js";

// No red goes unowned: a red item nobody is on for ten minutes is sent to the monitor to run rivet fix on, and work whose
// chat has been gone two hours is marked late and sent again. You are never asked; only a key still red after
// PICKUP_KEY_CAP pick-ups becomes your card.

/** A red item nobody is on is picked up after this long. */
export const PICKUP_AFTER_MS = 10 * 60_000;
/** A key picked up this many times in PICKUP_KEY_WINDOW_MS is not picked up again; it becomes one card. */
export const PICKUP_KEY_CAP = 3;
export const PICKUP_KEY_WINDOW_MS = 24 * 3600_000;
/** Auto pick-ups in any rolling hour. */
export const PICKUP_HOUR_CAP = 3;
/** The monitor's working-chat cap: no pick-up starts a chat past it. */
export const MAX_WORKING_CHATS = 10;
/** Work under way whose chat is not in the live crew this long is late. */
export const ORPHAN_MS = 2 * 3600_000;
/** A pick-up the bridge has not acked in this long is let go, and its record taken back if nobody has changed it since. */
export const PICKUP_ACK_MS = 10 * 60_000;
/** A typed pick-up counts as a working chat until its chat is in the crew, or this long after the ack. */
export const PICKUP_OPENING_MS = 15 * 60_000;
export const PICKUP_BY = "rivet";
export const PICKUP_NOTE = `${RIVET_NAME} picked this up on its own and is opening a chat on it.`;
export const QUEUE_FULL = "queue full";
export const CHAT_CLOSED = "chat closed";
export const KEEPS_BREAKING_PREFIX = "keeps-breaking-";

// bridge/lib/merge-holds.mjs HOLD_LABELS and pr-holds.mjs labelKey, as every merge path reads a hold label.
const HOLD_LABELS = ["do-not-merge", "do not merge", "dnm", "wip", "blocked"];
const labelKey = (label: string) =>
  label
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]?|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -/]*[0-~]?)/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

/** A PR label that holds it, as isMergeHoldLabel reads one. */
export function isHoldLabel(label: string): boolean {
  const key = labelKey(label);
  return key.includes("hold") || HOLD_LABELS.some((one) => labelKey(one) === key);
}

/** A red item as the server reads it: its record's kind and key, and its words. */
export interface RedItem extends OwnedItem {
  name: string;
  detail?: string;
}

export interface PickupState {
  /** When each red item was first read with nobody on it, by `kind/key`. */
  unowned: Record<string, string>;
  /** When each record under way was first read with its chat not in the live crew. */
  absent: Record<string, string>;
  /** Every pick-up sent in the last PICKUP_KEY_WINDOW_MS, acked or not. */
  starts: { item: string; at: string }[];
  /** Pick-up records the store refused, so nothing was sent; each counts toward the hourly cap. */
  refused?: { item: string; at: string }[];
  /** Pick-ups sent and not acked yet, by event id, with the version of the record each wrote and the one it replaced. */
  sent: Record<string, { kind: OpsStatusKind; key: string; at: string; version: number; prev?: OpsStatus | null }>;
  /** Pick-ups typed into the monitor chat whose own chat is not in the live crew yet, for PICKUP_OPENING_MS at most. */
  acked?: { item: string; at: string }[];
  /** The items with a keeps-breaking card posted. */
  cards: string[];
}

export const NO_PICKUPS: PickupState = { unowned: {}, absent: {}, starts: [], refused: [], sent: {}, cards: [] };

export const itemId = (item: { kind: string; key: string }) => `${item.kind}/${item.key}`;

export interface PickupPlan {
  state: PickupState;
  /** Pick-ups the bridge never acked in PICKUP_ACK_MS, by event id, still in `state` for releasePickup. */
  expired: string[];
  /** Records under way whose chat is gone: each is set late, "chat closed", and picked up again. */
  orphans: OpsStatus[];
  /** Items to send to the monitor now. */
  start: RedItem[];
  /** Items due a pick-up that a cap holds back: each is set Late, "queue full", and tried again next tick. */
  queueFull: RedItem[];
  /** Items past their pick-up cap with no card yet, each with the first start of its run of pick-ups. */
  keepsBreaking: { item: RedItem; episode: string }[];
}

/**
 * One tick's pick-ups. `workers` is the live crew; an empty crew is an unread one, so no chat is called gone and none is
 * started. `held`: items never touched (a PR you hold).
 */
export function planPickups(input: {
  red: readonly RedItem[];
  statuses: readonly OpsStatus[];
  workers: readonly Worker[];
  held: ReadonlySet<string>;
  monitorChat: string;
  state: PickupState;
  now: Date;
}): PickupPlan {
  const at = input.now.getTime();
  const iso = input.now.toISOString();
  const age = (time: string) => at - Date.parse(time);
  const state: PickupState = {
    unowned: {},
    absent: {},
    starts: input.state.starts.filter((start) => age(start.at) < PICKUP_KEY_WINDOW_MS),
    refused: (input.state.refused ?? []).filter((one) => age(one.at) < 3600_000),
    sent: input.state.sent,
    cards: [],
  };
  const expired = Object.keys(state.sent).filter((id) => age(state.sent[id]!.at) >= PICKUP_ACK_MS);
  const orphans: OpsStatus[] = [];
  const names = new Set(input.workers.map((worker) => worker.chat));
  const chats = new Set(input.workers.map((worker) => `${worker.repo.toLowerCase()}\n${worker.chat}`));
  // A record's chat is live in its own repo when the record or its key names one (another repo's key carries its
  // prefix); one of the default repo's key, naming none, is matched by name.
  const isLive = (status: Pick<OpsStatus, "chat" | "repo" | "kind" | "key">): boolean => {
    if (status.chat === undefined) return false;
    const keyRepo = statusKeyRepo(status.kind, status.key);
    const repo = status.repo ?? (keyRepo === NO_REPO ? undefined : keyRepo);
    return repo ? chats.has(`${repo.toLowerCase()}\n${status.chat}`) : names.has(status.chat);
  };
  const reds = new Map(input.red.map((item) => [itemId(item), item]));
  for (const status of input.statuses) {
    const id = itemId(status);
    if (!underWay(status) || status.kind === "coming" || input.held.has(id)) continue;
    const item = reds.get(id);
    if (!input.workers.length || isLive(status)) continue;
    const since = input.state.absent[id] ?? iso;
    if (age(since) >= ORPHAN_MS && age(status.updatedAt) >= ORPHAN_MS) orphans.push(status);
    else state.absent[id] = since;
  }
  const orphaned = new Set(orphans.map(itemId));
  const flying = Object.entries(state.sent).flatMap(([id, sent]) => (expired.includes(id) ? [] : [itemId(sent)]));
  const inFlight = new Set(flying);
  state.acked = (input.state.acked ?? []).filter(
    (one) => age(one.at) < PICKUP_OPENING_MS && !input.statuses.some((status) => itemId(status) === one.item && isLive(status)),
  );
  // A pick-up sent and not acked yet, or typed and its chat not in the crew yet, is a chat about to open.
  let working = input.workers.filter((worker) => worker.state === "working" && !worker.rivet && worker.chat !== input.monitorChat).length + flying.length + state.acked.length;
  let hour = [...state.starts, ...state.refused!].filter((start) => age(start.at) < 3600_000).length;
  const start: RedItem[] = [];
  const queueFull: RedItem[] = [];
  const keepsBreaking: PickupPlan["keepsBreaking"] = [];
  const seen = new Set<string>();
  for (const item of input.red) {
    const id = itemId(item);
    if (seen.has(id)) continue;
    seen.add(id);
    const record = recordOf(item, input.statuses);
    if (input.held.has(id)) continue;
    const status = record && orphaned.has(id) ? { ...record, state: "backlog" as const } : record;
    if (isOwned(item, status, input.workers) || (underWay(status) && status?.by === HANDLER_BY) || inFlight.has(id)) continue;
    // A chat found gone is picked up again at once.
    const since = orphaned.has(id) ? new Date(at - PICKUP_AFTER_MS).toISOString() : (input.state.unowned[id] ?? iso);
    state.unowned[id] = since;
    if (age(since) < PICKUP_AFTER_MS) continue;
    const mine = state.starts.filter((one) => one.item === id);
    if (mine.length >= PICKUP_KEY_CAP) {
      if (!input.state.cards.includes(id)) keepsBreaking.push({ item, episode: mine.map((one) => one.at).sort()[0]! });
      continue;
    }
    if (!input.workers.length) continue;
    if (hour >= PICKUP_HOUR_CAP || working >= MAX_WORKING_CHATS) {
      if (!(status?.askedForTimeAt && status.why === QUEUE_FULL && status.state === "backlog")) queueFull.push(item);
      continue;
    }
    start.push(item);
    delete state.unowned[id];
    hour += 1;
    working += 1;
  }
  state.cards = input.state.cards.filter((id) => state.starts.some((one) => one.item === id));
  return { state, expired, orphans, start, queueFull, keepsBreaking };
}

/**
 * The state with pick-up `id` let go, as the bridge could not type it or never acked it. Its start still counts toward
 * the caps: it was sent. Returns the pick-up too, so its record can be taken back.
 */
export function releasePickup(state: PickupState, id: string): { state: PickupState; sent: PickupState["sent"][string] | null } {
  const sent = state.sent[id];
  if (!sent) return { state, sent: null };
  const { [id]: _released, ...rest } = state.sent;
  return { state: { ...state, sent: rest }, sent };
}

/** The one card for a run of pick-ups of a key: its id is the key's and the run's first start, so a second post is refused. */
export function keepsBreakingCard(item: RedItem, episode: string): { id: string } & Record<string, unknown> {
  const hash = createHash("sha256").update(`${itemId(item)}\n${episode}`).digest("hex").slice(0, 16);
  return {
    id: `${KEEPS_BREAKING_PREFIX}${hash}`,
    kind: "decision",
    title: `${item.name} is still red`,
    ask: `Rivet has tried to start on this ${PICKUP_KEY_CAP} times in 24 hours and it is still red. Auto pick-up is off for it.`,
    ...(item.repo ? { repo: item.repo } : {}),
    options: [
      { label: "Find the cause", detail: "Rivet looks for why it is still red before trying again.", recommended: true },
      { label: "Leave it", detail: "It stays red until it is fixed." },
    ],
  };
}

/** The repo a failing schedule's fix runs in: its card's, else a GitHub schedule's id's, as the app's item names it. */
export function scheduleRepo(scheduleId: string, needRepo: string | undefined): string {
  const repo = /^github:([^/]+\/[^/]+)\//.exec(scheduleId)?.[1];
  return needRepo ?? (repo && isRepo(repo) ? repo : NO_REPO);
}

/** The disk, memory and runner reds the app lists (web/src/views/ops.ts wrongRows), keyed as its failed items are. */
export function machineReds(ops: OpsResponse): RedItem[] {
  const now = Date.parse(ops.now);
  const red: RedItem[] = [];
  const mac = ops.mac;
  if (mac && !mac.stale && now - Date.parse(mac.at) <= MAC_STALE_MS) {
    const what = [
      mac.memory.pressure === "critical" ? `Memory pressure critical, ${Math.round(mac.memory.freePct)}% free` : "",
      ops.bridge.connected ? "" : "Bridge offline",
      ...mac.runners.filter((runner) => !runner.alive).map((runner) => `Runner ${runner.name} down`),
    ].filter(Boolean);
    if (what.length) red.push({ ...macOwnedItem(), name: "Mac", detail: what.join(", ") });
    for (const volume of mac.volumes) {
      if (volume.totalBytes > 0 && diskTone(volume.freeBytes / volume.totalBytes) === "bad") {
        red.push({ ...diskOwnedItem(volume.label), name: `Mac ${volume.label} disk`, detail: `${Math.round((volume.freeBytes / volume.totalBytes) * 100)}% free` });
      }
    }
  }
  const github = ops.github;
  if (github && !github.stale && now - Date.parse(github.at) <= GITHUB_STALE_MS && !github.sources?.runners.failed.length) {
    const retired = new Set(ops.retiredRunners ?? []);
    for (const runner of github.runners?.runners ?? []) {
      if (runner.status !== "offline" || retired.has(runner.name)) continue;
      red.push({ kind: "runner", key: opsStatusKey("runner", runner.name), repo: NO_REPO, name: runner.name, detail: "CI runner offline" });
    }
  }
  return red;
}
