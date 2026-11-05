import { chatName } from "../../../src/shared/names.js";
import "./ops-status.css";

import type { PushConfigResponse } from "../../../src/shared/board.js";
import { failingStreak, type Schedule } from "../../../src/shared/schedules.js";
import type { Worker } from "../../../src/shared/workers.js";
import type { OpsStatus, OpsStatusKind, OpsStatusState } from "../../../src/shared/ops-status.js";
import { opsStatusKey } from "../../../src/shared/ops-status-key.js";
import { appOwnedItem, branchHolder, ciOwnedItem, diskOwnedItem, isFixing, isOwned, isParked, macOwnedItem, recordOf, underWay, type OwnedItem } from "../../../src/shared/ops-owned.js";
import { dismissMark, notNamed } from "../../../src/shared/ops-dismiss.js";
import { NO_REPO } from "../../../src/shared/repos.js";
import { isRed, type AppStatus, type MacSnapshot, type OpsResponse, type MacVolume, type PullRequest, type WorkflowRun } from "../../../src/shared/ops.js";
import { button, h, isHttps } from "../dom.js";
import * as api from "../api.js";
import { dismissalWrite, flyCurrent, healthCurrent, noteDismissal, opsData, watchOps } from "../ops-data.js";
import { app, crewLapsed, subscribe } from "../state.js";
import { prHref } from "./queue-cards.js";
import { etaWords } from "./plan-time.js";
import { maybeWhen, when } from "../../../src/shared/when.js";
import { IN_HAND, noTimeYet, stageWord } from "../../../src/shared/words.js";
import { closeSheet, openSheet } from "./sheet.js";
import { clearUndo, flash, showUndo } from "./toast.js";
import { openChatSheet } from "./worker-sheet.js";

// A failed Ops item and the sheet a Plan row opens: what happened, what is being done, by whom and by when. The records
// come from `rivet status set`; an item without one is Rivet's to pick up, so nothing here asks you for a fix.

/** One failed thing on Ops. Its kind and key name its status record (src/shared/ops-status.ts lists the kinds). */
export interface FailedItem extends OwnedItem {
  title: string;
  /** What happened, a line each. */
  what: string[];
  /** When the item's own data says it failed, if it says. */
  failedAt: string | null;
  url: string | null;
}

/** A record's state, or `unclaimed` for a failed item nobody has recorded a status for. */
type PillState = OpsStatusState | "unclaimed";

const STATE_LABEL: Record<PillState, string> = {
  unclaimed: stageWord("queued"),
  investigating: IN_HAND.building,
  "in-progress": "In hand",
  backlog: "Backlog",
  parked: "Parked",
  fixed: "Fixed",
};
// An agent on it is amber; nothing waiting on Rivet is red.
const STATE_TONE: Record<PillState, string> = { unclaimed: "info", investigating: "warn", "in-progress": "warn", backlog: "idle", parked: "idle", fixed: "ok" };

/** A workflow on main in plain words: "Main build checks", "Other repo Release run". */
function ciTitle(run: WorkflowRun): string {
  const where = run.repo === NO_REPO ? "Main" : (run.repo.split("/").pop() ?? run.repo).replace(/[-_]+/g, " ");
  return `${where} ${run.workflow === "CI" ? "build checks" : `${run.workflow} run`}`;
}

/** A CI runner in plain words, by the machine its name says it runs on. */
export function runnerTitle(name: string): string {
  return /mac/i.test(name) ? "Test machine on the Mac" : "A test machine";
}

export function ciItem(run: WorkflowRun): FailedItem | null {
  if (!isRed(run)) return null;
  return {
    ...ciOwnedItem(run),
    title: ciTitle(run),
    what: [`${run.workflow} ${(run.conclusion ?? "failed").replace(/_/g, " ")} on main`, run.title, run.failedJobs?.length ? `Failed jobs: ${run.failedJobs.join(", ")}` : ""].filter(Boolean),
    failedAt: run.updatedAt,
    url: run.url,
  };
}

export function prItem(pr: PullRequest): FailedItem | null {
  if (pr.checks.state !== "fail") return null;
  return {
    kind: "pr",
    key: opsStatusKey("pr", String(pr.number), pr.repo),
    title: pr.title,
    what: [`${pr.checks.failed} ${pr.checks.failed === 1 ? "check" : "checks"} failed`, names(pr)].filter(Boolean),
    failedAt: pr.headAt,
    repo: pr.repo,
    url: pr.url,
    ...(pr.branch ? { branch: pr.branch } : {}),
    draft: pr.draft,
  };
}

/** The PR's failed checks, up to eight, and how many the bridge did not name. */
function names(pr: PullRequest): string {
  const unnamed = Math.max(0, pr.checks.failed - pr.checks.failing.length);
  return [...pr.checks.failing.slice(0, 8), unnamed ? notNamed(unnamed) : ""].filter(Boolean).join(", ");
}

/** The app's item as Ops shows it: health and Fly only while their readings are current. */
export function currentAppItem(one: AppStatus, ops: OpsResponse): FailedItem | null {
  return appItem({ ...one, health: healthCurrent(ops) ? one.health : { ...one.health, state: "unknown" }, fly: flyCurrent(ops, one.app ?? undefined) ? one.fly : null });
}

export function appItem(one: AppStatus): FailedItem | null {
  const down = one.health.state === "down";
  const release = one.fly?.lastRelease;
  const failedRelease = release?.status === "failed" ? release : null;
  if (!down && !failedRelease) return null;
  return {
    ...appOwnedItem(one.id),
    title: one.name,
    what: [
      down ? `Down: ${one.health.status ? `HTTP ${one.health.status}` : "no answer"} on ${one.health.fails} checks in a row` : "",
      failedRelease ? `Last Fly release v${failedRelease.version} failed` : "",
    ].filter(Boolean),
    failedAt: down ? one.health.since : (failedRelease?.at ?? null),
    url: null,
  };
}

/** Notifications reaching no phone: you have to turn them on, so it reads Not picked up until you do. */
export function pushItem(health: PushConfigResponse | null): FailedItem | null {
  if (!health?.configured || health.subscriptions > 0) return null;
  const removal = health.lastRemoval && health.lastRemoval.remaining === 0 ? health.lastRemoval : null;
  const why = !removal
    ? "No phone has turned them on"
    : removal.reason === "gone"
      ? `The last phone's push service (${removal.host}) answered ${removal.status}: notifications were blocked or the app removed`
      : removal.reason === "turned-off"
        ? "The last phone was turned off in Settings"
        : "The last phone was dropped";
  return {
    kind: "push",
    key: "phones",
    title: "Notifications",
    what: ["Off on every phone", why, "Turn them on from Cards or Settings on the phone"],
    failedAt: removal?.at ?? null,
    repo: NO_REPO,
    url: null,
  };
}

/** A schedule that is on and whose last run failed; keyed by its id, as `rivet status key schedule` keys it. */
export function scheduleItem(schedule: Schedule): FailedItem | null {
  // The server counts a streak of failures even while a retry runs, so that streak is an item too.
  const last = schedule.on && schedule.lastRun?.result === "failed" ? schedule.lastRun : (failingStreak(schedule, new Date())?.newest ?? null);
  if (!last) return null;
  return {
    kind: "schedule",
    key: opsStatusKey("schedule", schedule.id),
    title: schedule.name,
    what: ["note" in last && last.note ? last.note : "Last run failed"],
    failedAt: last.at,
    // A GitHub schedule's repo is its id's, as its board card names it, so its fix runs in that checkout.
    repo: /^github:([^/]+\/[^/]+)\//.exec(schedule.id)?.[1] ?? NO_REPO,
    url: last.url ?? null,
  };
}

export function runnerItem(name: string): FailedItem {
  return { kind: "runner", key: opsStatusKey("runner", name), title: runnerTitle(name), what: ["Offline"], failedAt: null, repo: NO_REPO, url: null };
}

/** The Mac's red faults (memory, the bridge, its runners) as one item; null when it has none. */
export function macItem(mac: MacSnapshot, bridge: boolean): FailedItem | null {
  const what = [
    mac.memory.pressure === "critical" ? `Memory pressure critical, ${Math.round(mac.memory.freePct)}% free` : "",
    bridge ? "" : "Bridge offline",
    ...mac.runners.filter((runner) => !runner.alive).map((runner) => `Runner ${runner.name} down`),
  ].filter(Boolean);
  return what.length ? { ...macOwnedItem(), title: "Mac", what, failedAt: null, url: null } : null;
}

export function diskItem(volume: MacVolume): FailedItem {
  const free = volume.totalBytes > 0 ? Math.round((volume.freeBytes / volume.totalBytes) * 100) : 0;
  return { ...diskOwnedItem(volume.label), title: `${volume.label} disk`, what: [`${free}% free${volume.runners ? ", the runners' work directories" : ""}`], failedAt: null, url: null };
}

export function statusOf(item: FailedItem): OpsStatus | null {
  return recordOf(item, opsData.statuses);
}

/** The live crew the ownership test reads: none once it has lapsed. */
const crew = () => (crewLapsed() ? [] : (app.workers?.workers ?? []));

/** The chat on an item: the one its status names, else whoever set it. Only work under way names one. */

/** The item's fix chat: the chat its record names while work is under way, and that chat's agent when it is live. */
export function fixChatOf(kind: OpsStatusKind, key: string, repo: string): { chat: string | null; worker: Worker | null } {
  const found = opsData.statuses?.find((one) => one.kind === kind && one.key === key) ?? null;
  // Two repos' Coming rows of one PR share a key: a record whose chat is another repo's is that row's, not this one's.
  const status = found?.repo && found.repo.toLowerCase() !== repo.toLowerCase() ? null : found;
  const chat = underWay(status) ? (status?.chat ?? null) : null;
  const worker = chat && !crewLapsed() ? (app.workers?.workers.find((one) => one.chat === chat && one.repo.toLowerCase() === repo.toLowerCase()) ?? null) : null;
  return { chat, worker };
}

/** A live fix chat's first output: what its board entry says it is doing, else whether its terminal has spoken yet. */
export function firstOutput(worker: Worker): string {
  if (worker.doing) return worker.doing;
  return worker.lastOutputAt ? `${IN_HAND.building}, last output ${maybeWhen(worker.lastOutputAt) ?? "earlier"}` : "Waiting for its first output";
}

export function owner(status: OpsStatus | null): string | null {
  if (!underWay(status)) return null;
  return status?.chat ?? status?.by ?? null;
}

/** The live chat holding the item's branch, as the shared ownership test finds it (src/shared/ops-owned.ts). */
function holder(item: FailedItem, status: OpsStatus | null): string | null {
  return branchHolder(item, status, crew());
}

/** What the pill shows: the record's state and owner, else In progress by the chat holding the branch. */
function pillOf(status: OpsStatus | null, held: string | null): { state: PillState; who: string | null } {
  return held ? { state: "in-progress", who: held } : { state: status?.state ?? "unclaimed", who: owner(status) };
}

/**
 * Whether anyone is fixing a failed item, and their ETA: the record's eta, the server's "by 3:30pm" beside its dueAt,
 * unless another chat holds the branch. A record saying work is under way counts, named or not.
 */
export function fixProgress(item: FailedItem): { fixing: boolean; eta: string | null } {
  const status = statusOf(item);
  const fixing = isFixing(item, status, crew());
  // The stored eta is its done-by's label as of the write: a day on, its clock time alone names the wrong day.
  const eta = status?.dueAt ? `by ${when(status.dueAt)}` : status?.eta;
  return { fixing, eta: fixing && eta && !holder(item, status) ? eta : null };
}

/** An item you parked: a calm "Parked" line, not a break (src/shared/ops-owned.ts). */
export function parked(item: FailedItem | null): boolean {
  return !!item && isParked(item, statusOf(item));
}

/**
 * Someone is on the item, or it is parked: Rivet's count and the Ops mark leave it out, and say it calmly, as
 * agents on it or as parked. The server's briefing and push alerts use the same test.
 */
export function owned(item: FailedItem | null): boolean {
  return !!item && isOwned(item, statusOf(item), crew());
}

/**
 * The item's mark for a Dismiss: when its trouble began and what failed. A new failure or a change in what failed makes
 * a new mark, so a dismissed item is red again (src/shared/ops-dismiss.ts).
 */
export function markOf(item: FailedItem): string {
  // An app's run of failed checks grows each probe while it stays down: the same outage, so not a new mark.
  const what = item.kind === "app" ? item.what.map((line) => line.replace(/ on \d+ checks in a row$/, "")) : item.what;
  return dismissMark({ since: item.failedAt, title: item.title, what });
}

/** Whether you can dismiss the item: red with nobody on it. */
export function dismissable(item: FailedItem | null): item is FailedItem {
  // Before a whole list of statuses loads, who is on an item is unknown: nothing is dismissed or dismissable.
  if (!opsData.statusesLoaded) return false;
  return !!item && !owned(item);
}

/** You dismissed the item and it has not changed or broken again since: it leaves the rows, counts and marks. */
export function dismissed(item: FailedItem | null): boolean {
  if (!dismissable(item)) return false;
  const mark = markOf(item);
  return opsData.dismissals.some((one) => one.kind === item.kind && one.key === item.key && one.mark === mark);
}

const UNDO_MS = 5000;

/**
 * Each item's dismissal writes, one after another, so a Bring back and a second Dismiss land in the order they were
 * tapped. Each resolves to whether a dismissal of this phone's is stored, so a Bring back after a refused write deletes
 * nothing.
 */
const writes = new Map<string, Promise<boolean>>();
/** Each item's latest Dismiss or Bring back tap, so a failed write never undoes a later one. */
const taps = new Map<string, number>();
let tapCount = 0;
const tap = (item: FailedItem) => {
  const n = ++tapCount;
  taps.set(itemKey(item), n);
  return () => taps.get(itemKey(item)) === n;
};
const itemKey = (item: FailedItem) => `${item.kind}/${item.key}`;

function queueWrite(item: FailedItem, write: (stored: boolean) => Promise<boolean>): void {
  const key = itemKey(item);
  // Nothing in flight: a dismissal loaded from the server may be stored, so a Bring back deletes it.
  // Counted from the tap: no list load lands until every queued write is done, then one reads the list again.
  const next = dismissalWrite((writes.get(key) ?? Promise.resolve(true)).then(write));
  writes.set(key, next);
  void next.then(() => {
    if (writes.get(key) === next) writes.delete(key);
  });
}

/** Hides the item at once and stores it on the server, with a 5 s Undo; a refused write brings it back. */
export function dismissItem(item: FailedItem): void {
  if (!dismissable(item)) return;
  const mark = markOf(item);
  const latest = tap(item);
  noteDismissal(item.kind, item.key, mark);
  const undoKey = `dismiss:${item.kind}/${item.key}`;
  const failed = () => {
    if (latest()) {
      noteDismissal(item.kind, item.key, null);
      clearUndo(undoKey);
    }
    flash("Couldn't dismiss it. Try again.", "error");
  };
  queueWrite(item, (stored) => api.putOpsDismissal(item.kind, item.key, mark).then(() => true, () => (failed(), stored)));
  const timer = window.setTimeout(() => clearUndo(undoKey), UNDO_MS);
  showUndo({
    key: undoKey,
    verb: "Dismissed",
    title: item.title,
    tone: "later",
    ms: UNDO_MS,
    group: "archive",
    onUndo: () => {
      window.clearTimeout(timer);
      clearUndo(undoKey);
      bringBack(item);
    },
  });
}

/** Takes a dismissal back: the item is red again. A dismissal still being written is deleted once it lands. */
export function bringBack(item: FailedItem): void {
  tap(item);
  noteDismissal(item.kind, item.key, null);
  queueWrite(item, (stored) =>
    stored
      ? api.deleteOpsDismissal(item.kind, item.key).then(
          () => false,
          // None stored (a Dismiss the server refused) is brought back already.
          (error: unknown) => (error instanceof api.ApiError && error.status === 404 ? false : (flash("Couldn't bring it back. Try again.", "error"), true)),
        )
      : Promise.resolve(false),
  );
}

/** A red an agent is on is amber, one you dismissed muted: the row and every red mark inside it. */
export function calm<T extends HTMLElement>(el: T, item: FailedItem | null): T {
  if (owned(item)) retone(el, "warn", "beingFixed");
  else if (dismissed(item)) retone(el, "idle", "dismissed");
  return el;
}

function retone(el: HTMLElement, to: "warn" | "idle", flag: "beingFixed" | "dismissed"): void {
  for (const node of [el, ...el.querySelectorAll<HTMLElement>(".s-bad, .t-bad")])
    for (const [from, into] of [["s-bad", `s-${to}`], ["t-bad", `t-${to}`]] as const) if (node.classList.contains(from)) node.classList.replace(from, into);
  el.dataset[flag] = "";
}

/** Nobody needs to look: an agent is on it, or you dismissed it. A section red only for these stands down. */
export function quiet(item: FailedItem | null): boolean {
  return owned(item) || dismissed(item);
}

/** The pill's face; `gone`, you dismissed it: "Dismissed", muted, in place of Not picked up. */
function face(status: OpsStatus | null, held: string | null, gone = false): HTMLElement {
  const { state, who } = pillOf(status, held);
  return h(
    "span",
    { class: `ops-pill-face t-${gone ? "idle" : STATE_TONE[state]}${who ? " has-owner" : ""}` },
    h("span", { class: "ops-pill-state" }, gone ? "Dismissed" : STATE_LABEL[state]),
    who ? h("span", { class: "ops-pill-owner" }, chatName(who)) : null,
  );
}

/**
 * The tone of one of the item's own marks drawn outside its row (a dot, a tile, a notice): amber while an agent is on it,
 * muted once you dismissed it, else as it was.
 */
export function shade<T extends string>(item: FailedItem | null, tone: T): T | "warn" | "idle" {
  if (tone !== "bad" || !item) return tone;
  return isFixing(item, statusOf(item), crew()) ? "warn" : dismissed(item) ? "idle" : tone;
}


/** The earlier of the record's `since` and the item's own failure time: both are no earlier than the failure. */
function startedAt(item: FailedItem, status: OpsStatus | null): string | null {
  const times = [status?.since, item.failedAt].filter((at): at is string => !!at && Number.isFinite(Date.parse(at)));
  return times.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
}

export function openStatus(item: FailedItem): void {
  const sheet = { returnFocus: true };
  let stop: (() => void) | null = null;
  let live = true;
  openSheet(item.title, {
    mount: (el) => {
      // Redrawn when the statuses change (Rivet sets On it, ETA or Latest) and when the crew does.
      const redraw = () => {
        if (!live) return;
        const old = el.querySelector<HTMLElement>(".ops-status-detail");
        const scrolled = old?.scrollTop ?? 0;
        const active = document.activeElement instanceof HTMLElement && old?.contains(document.activeElement) ? document.activeElement : null;
        const next = statusDetail(item, statusOf(item), sheet);
        el.replaceChildren(next);
        next.scrollTop = scrolled;
        if (active) refocus(active, next, el);
      };
      redraw();
      const unwatch = watchOps(redraw);
      // The crew too: the chat holding a PR's branch comes from it.
      const unsubscribe = subscribe(redraw);
      stop = () => {
        unwatch();
        unsubscribe();
      };
    },
    unmount: () => {
      live = false;
      stop?.();
      if (sheet.returnFocus)
        queueMicrotask(() => document.querySelector<HTMLElement>(`.ask-row[data-ask="${item.kind}/${item.key}"]`)?.focus());
    },
  }, "Close", undefined, { use: "ops.status" });
}

/** Focus stays where it was across a redraw, on the same control found by its class and words; else it goes to Close. */
function refocus(active: HTMLElement, next: HTMLElement, el: HTMLElement): void {
  const same = [...next.querySelectorAll<HTMLElement>(active.tagName)].find((node) => node.className === active.className && node.textContent === active.textContent);
  const usable = same && !(same instanceof HTMLButtonElement && same.disabled) ? same : null;
  (usable ?? el.closest(".sheet")?.querySelector<HTMLElement>(":scope > .btn"))?.focus({ preventScroll: true });
}

function field(label: string, ...value: (Node | string | null)[]): HTMLElement[] {
  return [h("h3", { class: "ops-status-label" }, label), h("div", { class: "ops-status-text" }, ...value)];
}

function statusDetail(item: FailedItem, status: OpsStatus | null, sheet: { returnFocus: boolean }): HTMLElement {
  const held = holder(item, status);
  const { state } = pillOf(status, held);
  const started = startedAt(item, status);
  const chat = held ?? status?.chat;
  const by = chat ? null : owner(status);
  const who: (HTMLElement | null)[] = [
    by ? h("span", { class: "ops-status-text" }, by) : null,
    chat
      ? button(
          `Chat ${chatName(chat)}`,
          () => {
            sheet.returnFocus = false;
            closeSheet();
            // The record's chat in the repo it was opened in, when the record knows it; a branch holder is item.repo's.
            const chatRepo = !held && status?.repo ? status.repo : item.repo;
            openChatSheet(chat, chatRepo || undefined, `ops-status-${chat}`, "ops", status?.pr ?? undefined);
          },
          "ghost ops-status-chat",
          false,
          "ops.status.chat",
        )
      : null,
    status?.pr ? h("a", { class: "ops-status-link", attrs: { href: prHref(status.pr, item.repo), target: "_blank", rel: "noopener noreferrer", "data-use": "ops.status.pr" } }, `PR #${status.pr}`) : null,
    status?.issue
      ? h("a", { class: "ops-status-link", attrs: { href: `https://github.com/${item.repo}/issues/${status.issue}`, target: "_blank", rel: "noopener noreferrer", "data-use": "ops.status.issue" } }, `Issue #${status.issue}`)
      : null,
  ];
  const onIt = who.filter((node): node is HTMLElement => node !== null);
  // An app with no record yet: one line until someone is on it.
  const nobody = item.kind === "app" && !status;
  return h(
    "div",
    { class: "ops-status-detail", attrs: { "data-kind": item.kind, "data-key": item.key } },
    h("div", { class: "ops-status-top" }, face(status, held, dismissed(item)), h("span", { class: "ops-status-key" }, `Key: ${item.kind} ${item.key}`)),
    ...field("What happened", ...item.what.map((line) => h("p", {}, line))),
    nobody
      ? h("div", { class: "ops-status-note box t-info" }, h("p", { class: "ops-status-text" }, "Rivet is picking this up"))
      : h(
          "div",
          { class: `ops-status-note box t-${STATE_TONE[state]}` },
          h("h3", { class: "ops-status-label" }, "Latest"),
          h(
            "p",
            { class: "ops-status-text" },
            held ? `${held} has this PR's branch checked out.` : (status?.why ?? status?.note ?? (status ? "No note yet." : "No update yet: Rivet is picking this up.")),
          ),
        ),
    ...field("Failing since", started ? when(started) : "Not known"),
    ...(nobody
      ? []
      : [
          ...field("Who", ...(onIt.length ? [h("div", { class: "ops-status-who" }, ...onIt)] : ["Rivet, picking it up"])),
          ...field("Done by", status && underWay(status) ? (status.dueAt ? when(status.dueAt) : status.eta?.trim() ? etaWords(status.eta, status.updatedAt) : noTimeYet()) : noTimeYet()),
          ...field("Last updated", status ? `${when(status.updatedAt)}${status.by ? ` by ${status.by}` : ""}` : "Never"),
        ]),
    item.url && isHttps(item.url) ? h("a", { class: "btn ghost ops-status-open", attrs: { href: item.url, target: "_blank", rel: "noopener noreferrer", "data-use": "ops.status.github" } }, "Open on GitHub") : null,
    dismissed(item)
      ? button("Bring back", () => bringBack(item), "ghost big ops-bring-back", false, "ops.status.bring-back")
      : dismissable(item)
        ? button(
            "Dismiss",
            () => {
              sheet.returnFocus = false;
              closeSheet();
              dismissItem(item);
            },
            "ghost big ops-dismiss",
            false,
            "ops.status.dismiss",
          )
        : null,
  );
}
