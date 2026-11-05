import type { ComingItem } from "../../../src/shared/board.js";
import type { PullRequest } from "../../../src/shared/ops.js";
import type { OpsStatus } from "../../../src/shared/ops-status.js";
import { recordOf, underWay } from "../../../src/shared/ops-owned.js";
import { opsStatusKey } from "../../../src/shared/ops-status-key.js";
import { NO_REPO } from "../../../src/shared/repos.js";
import { localDay, when } from "../../../src/shared/when.js";
import { noTimeYet, slipped, slippedTwice } from "../../../src/shared/words.js";
import type { SchedulesResponse } from "../../../src/shared/schedules.js";
import { button, h, type Child } from "../dom.js";
import { freshPrs, opsData } from "../ops-data.js";
import { app } from "../state.js";
import { comingRowRepo, isStaleComing, shownComingRows } from "./board.js";
import { comingKey, openComingSheet } from "./coming-sheet.js";
import { dismissedItems, failedItems, opsItem, planWords } from "./ops.js";
import { bringBack, openStatus, runnerTitle, statusOf, type FailedItem } from "./ops-status.js";
import { etaWords } from "./plan-time.js";
import { comingDone, comingWhat, stageLabel } from "./queue-cards.js";
import { openChatSheet } from "./worker-sheet.js";

// Plan, under the desks on the Floor: what is being done, by when and why, what comes next and what was done today.
// The work is Rivet's job, so nothing here is red.

export interface PlanRow {
  id: string;
  kind: string;
  key: string;
  title: string;
  why: string | null;
  /** When it is due done, from a record's dueAt. */
  dueAt: string | null;
  /** A record's eta in words while it gives no dueAt (plan-time.ts etaWords): "by 6:10pm", "by soon". */
  eta: string | null;
  /** A break nobody has taken yet: its why says it is being picked up. */
  picking: boolean;
  /** A record past its first time, in the words an ask's row uses (lateWords); null while it keeps its time. */
  late: string | null;
  /** No time yet, or moved twice, as an ask row's `counted`. */
  counted: boolean;
  /** The Ops item a break nobody has taken stands for: you may dismiss it. */
  item: FailedItem | null;
  /** The record the row reads, `kind/key`; null for a break with none. */
  record: string | null;
  open: () => void;
}

/** A row as it is first listed, before its record is read. */
type Draft = Omit<PlanRow, "record">;
// `numbered`: a PR record Ops has no title for, whose row leads with its number once its words are plain.
type Entry = { row: Draft; status: OpsStatus | null; numbered?: boolean };

export interface PlanState {
  doing: PlanRow[];
  done: { id: string; at: string; text: string }[];
  next: { id: string; at: string; text: string }[];
  /** The breaks you dismissed, each brought back with one tap. */
  dismissed: FailedItem[];
}

/** Fields a later record or reading may carry (cause; Ops' `next`): read when there, never required. */
type Extra = OpsStatus & { cause?: unknown };
type NextRow = { key: string; title: string; at: string };

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

/** The line under a row: why it is done this way, else the cause, else the record's note. */
function reason(status: OpsStatus | null): string | null {
  return status?.why ?? text((status as Extra | null)?.cause) ?? status?.note ?? null;
}

/**
 * Late is read off the server's times, never a flag: work under way whose dueAt has passed has no time yet,
 * asked when the server asked its chat; one given a later time reads its move. A backlog record the auto pick-up marked
 * has nobody to ask. One moved once is not counted.
 */
function isLate(status: OpsStatus, now: number): boolean {
  if (status.state === "backlog") return !!status.askedForTimeAt;
  if (!underWay(status) || !status.dueAt) return false;
  return !(Date.parse(status.dueAt) > now) || (status.dueHistory?.length ?? 0) >= 2;
}

function lateWords(status: OpsStatus | null, now: number): Pick<PlanRow, "late" | "counted"> {
  const none = { late: null, counted: false };
  if (status?.state === "backlog") return status.askedForTimeAt ? { late: noTimeYet(), counted: true } : none;
  if (!status || !underWay(status) || !status.dueAt) return none;
  const due = Date.parse(status.dueAt);
  const counted = isLate(status, now);
  if (!(due > now)) return { late: noTimeYet(status.askedForTimeAt && Date.parse(status.askedForTimeAt) >= due ? status.askedForTimeAt : undefined, now), counted };
  const last = status.dueHistory?.at(-1);
  if (!last) return none;
  const why = last.why && planWords(last.why);
  return { late: counted ? slippedTwice(status.dueAt, why, now) : slipped(status.dueAt, last.was, why, now), counted };
}

/** Plan's words carry no PR numbers: "Merge #12: docs …" reads "Merge: docs …". */
function plain(words: string): string {
  const out = words.replace(/\s*\(#\d+\)|\s*#\d+/g, "").replace(/^[\s:·,-]+/, "").trim();
  return out ? out[0]!.toUpperCase() + out.slice(1) : "A code change";
}

const humanize = (key: string) => {
  const words = key.replace(/_[0-9a-z]+$/, "").replace(/[-_/.]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
};

/** A note's first sentence: Done today's line. */
function firstSentence(note: string | undefined): string | null {
  if (!note) return null;
  const line = note.split("\n")[0]!.trim();
  const end = line.search(/[.;](\s|$)/);
  return end > 0 ? line.slice(0, end) : line;
}

/**
 * A PR record's line led by its number from its key, as the board's fix cards lead with it ("#12 checks pass: …"):
 * "#12: …". A line that already starts with the number keeps it once.
 */
export function prRef(status: OpsStatus, text: string): string {
  const number = status.kind === "pr" ? /(?:^|\/)(\d+)$/.exec(status.key)?.[1] : undefined;
  return number && !new RegExp(`^#${number}(?!\\d)`).test(text) ? `#${number}: ${text}` : text;
}

/** A record's title when no Ops item names it, in plain words rather than its key. */
function recordTitle(status: OpsStatus): string {
  if (status.kind === "pr") return "A code change";
  if (status.kind === "ci") return "Build checks";
  if (status.kind === "runner") return runnerTitle(status.key);
  if (status.kind === "app") return opsData.ops?.apps?.find((one) => one.id === status.key)?.name ?? humanize(status.key);
  return humanize(status.key);
}

const openChat = (name: string, repo?: string) => openChatSheet(name, repo, `plan-${name}`, "ops");

function comingTitle(item: ComingItem): string {
  return item.app && !item.title.toLowerCase().startsWith(item.app.toLowerCase()) ? `${item.app}: ${item.title}` : item.title;
}

/** A listed row with its record read: its time, its late words and whether the mark counts it. */
function derive({ row, status, numbered }: Entry, now: number): PlanRow {
  const on = !!status && underWay(status);
  const recordDue = on && status!.dueAt ? status!.dueAt : null;
  const eta = on && text(status!.eta) ? etaWords(status!.eta!, status!.updatedAt, now) : null;
  const late = lateWords(status, now);
  const why = row.why && planWords(row.why);
  const moveWhy = status?.dueHistory?.at(-1)?.why;
  const said = moveWhy ? planWords(moveWhy).trim() : null;
  return {
    ...row,
    title: numbered && status ? prRef(status, plain(planWords(row.title))) : plain(planWords(row.title)),
    // A moved time already says its why (`was 10:29am · tests were red`): the same words are not said again under it.
    why: why && said === why.trim() && late.late?.endsWith(` · ${said}`) ? null : why,
    dueAt: recordDue,
    eta,
    picking: row.picking && !on,
    record: status ? `${status.kind}/${status.key}` : null,
    ...late,
  };
}

/** A record's own row, titled from its PR when Ops lists it. */
function recordEntry(status: OpsStatus, prs: readonly PullRequest[]): Entry {
  const pr = status.kind === "pr" ? prs.find((one) => opsStatusKey("pr", String(one.number), one.repo) === status.key) : undefined;
  const title = pr ? pr.title : recordTitle(status);
  const item: FailedItem = { kind: status.kind, key: status.key, repo: pr?.repo ?? NO_REPO, title, what: [], failedAt: status.since, url: pr?.url ?? null };
  const row = { id: `${status.kind}/${status.key}`, kind: status.kind, key: status.key, title, why: reason(status), dueAt: null, eta: null, picking: false, late: null, counted: false, item: null, open: () => openStatus(item) };
  return { row, status, numbered: !pr };
}

const byDue = (a: PlanRow, b: PlanRow) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity);

/** Plan's lists, read from Ops' snapshot, the status records, Coming and the schedules. The Progress mark and Rivet read it too. */
/** Coming rows under way, each with the ids a record joins it by. */
function comingInHand(now: number) {
  const coming = shownComingRows(app.board?.board ?? null);
  return coming.rows
    .filter((item) => !(comingDone(item) || (isStaleComing(item, now) && !coming.held.has(item))))
    .map((item) => {
      const repo = comingRowRepo(app.board?.board?.chats ?? [], item) ?? item.mergedRepo ?? NO_REPO;
      const key = comingKey(item);
      const recordKey = comingKey(item, repo);
      const prKey = item.pr ? opsStatusKey("pr", String(item.pr), repo) : null;
      // A Coming record's key carries its repo outside the default one, so each repo's row has its own.
      return { item, key, recordKey, repo, prKey, ids: [`coming/${repo}/${key}`, `coming/${recordKey}`, ...(prKey ? [`pr/${prKey}`] : [])] };
    });
}

export function planState(schedules: SchedulesResponse | null = null, now = Date.now()): PlanState {
  const statuses = opsData.statuses ?? [];
  const entries: Entry[] = [];
  const taken = new Map<string, Entry>();
  // A row naming something already listed joins it. `said` is a Coming row's own words, which a row it joins takes
  // before its own.
  const add = (row: Draft, ids: string[], status: OpsStatus | null, said: string | null = null, numbered = false) => {
    const listed = ids.map((id) => taken.get(id)).find(Boolean);
    if (listed) {
      if (status && underWay(status)) listed.row.picking = false;
      if (!(listed.status && underWay(listed.status)) && status && underWay(status)) listed.status = status;
      listed.row.why = reason(listed.status) ?? said ?? listed.row.why;
      for (const id of ids) if (!taken.has(id)) taken.set(id, listed);
      return;
    }
    const entry = { row, status, numbered };
    entries.push(entry);
    for (const id of ids) taken.set(id, entry);
  };
  // Every break Ops names is Rivet's to fix: with a record it says by when and why, without one it is being picked up.
  for (const item of failedItems(opsData.ops)) {
    const status = statusOf(item);
    const source = opsItem(item);
    add(
      { id: `${item.kind}/${item.key}`, kind: item.kind, key: item.key, title: item.title, why: reason(status) ?? item.what[0] ?? null, dueAt: null, eta: null, picking: true, late: null, counted: false, item: source, open: () => openStatus(source) },
      [`${item.kind}/${item.key}`],
      status,
    );
  }
  // Coming rows under way: not done, not gone quiet unless a chat at work holds it (as Feed's Coming keeps it). One
  // waiting on your OK stays too: it is still being done, and its card on Cards is the server's (asks/waits.ts).
  for (const { item, key, recordKey, repo, prKey, ids } of comingInHand(now)) {
    const status = [recordOf({ kind: "coming", key: recordKey, repo }, statuses), prKey ? recordOf({ kind: "pr", key: prKey, repo }, statuses) : null].find((one) => one && underWay(one)) ?? null;
    add(
      { id: `coming/${repo}/${key}`, kind: "coming", key, title: comingTitle(item), why: reason(status) ?? comingWhat(item) ?? stageLabel(item), dueAt: null, eta: null, picking: false, late: null, counted: false, item: null, open: () => openComingSheet(item, openChat, now) },
      ids,
      status,
      comingWhat(item) ?? null,
    );
  }
  // Any other record an agent is on.
  const prs = opsData.ops ? (freshPrs(opsData.ops) ?? []) : [];
  for (const status of statuses) {
    if (!underWay(status)) continue;
    const entry = recordEntry(status, prs);
    add(entry.row, [`${status.kind}/${status.key}`], status, null, entry.numbered);
  }
  const doing = entries.map((entry) => derive(entry, now)).sort(byDue);
  const today = localDay(now);
  const done = statuses
    .filter((status) => status.state === "fixed" && localDay(status.updatedAt) === today)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map((status) => ({ id: `${status.kind}/${status.key}`, at: status.updatedAt, text: prRef(status, plain(firstSentence(status.note) ?? recordTitle(status))) }));
  // Ops' own Next rows when the reading carries them, else the schedules' next runs.
  const served = (opsData.ops as { next?: unknown } | null)?.next;
  const upcoming = Array.isArray(served)
    ? (served as Partial<NextRow>[]).filter((row) => typeof row?.at === "string" && typeof row.title === "string").map((row) => ({ id: row.key ?? row.title!, at: row.at!, text: row.title! }))
    : (schedules?.items ?? []).filter((item) => item.on && item.nextRun).map((item) => ({ id: item.id, at: item.nextRun!, text: item.name }));
  const next = upcoming
    .filter((one) => Date.parse(one.at) > now)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(0, 4);
  return { doing, done, next, dismissed: dismissedItems(opsData.ops) };
}

/**
 * Progress › Your asks › Rivet's own: the records Rivet is on and the pick-ups waiting on a time, each once, then the
 * breaks no such record stands for, uncounted and with no record. So a record listed on a Coming row, or a break a Coming
 * record joined, is not Rivet's own here either, and a pick-up waiting on a time whose break has ended still has its row.
 */
export function ownRows(now = Date.now()): PlanRow[] {
  const { doing } = planState(null, now);
  const statuses = opsData.statuses ?? [];
  const ownable = statuses.filter((status) => status.kind !== "coming" && (status.state === "backlog" ? !!status.askedForTimeAt : underWay(status)));
  const joined = new Set(comingInHand(now).flatMap((row) => row.ids));
  const own = ownable.filter((status) => status.state === "backlog" || !joined.has(`${status.kind}/${status.key}`));
  const listed = new Map(doing.flatMap((row) => (row.record && row.kind !== "coming" ? [[row.record, row] as const] : [])));
  // Every record that can count: its row is above when it counts, else it is Coming's.
  const counts = new Set(ownable.map((status) => `${status.kind}/${status.key}`));
  const prs = opsData.ops ? (freshPrs(opsData.ops) ?? []) : [];
  return [
    ...own.map((status) => listed.get(`${status.kind}/${status.key}`) ?? derive(recordEntry(status, prs), now)),
    ...doing
      .filter((row) => row.kind !== "coming" && !(row.record && (counts.has(row.record) || row.record.startsWith("coming/"))))
      .map((row) => ({ ...row, record: null, counted: false })),
  ].sort(byDue);
}
/** What Ops fixed since midnight, newest first: Your asks' Done today lists it beside the finished asks. */
export const fixedToday = (now = Date.now()): PlanState["done"] => planState(null, now).done;

let dismissedOpen = false;

function secHead(text: string, extra: Child = null, cls = ""): HTMLElement {
  return h("h2", { class: `plan-sec${cls}` }, h("span", {}, text), extra ? h("span", {}, extra) : null);
}

export function foldRow(label: string, open: boolean, toggle: () => void, rerender: () => void): HTMLElement {
  return h(
    "button",
    {
      class: "plan-fold",
      attrs: { type: "button", "aria-expanded": String(open), "data-use": "plan.fold" },
      on: {
        click: () => {
          toggle();
          rerender();
        },
      },
    },
    h("span", {}, label),
    h("span", { class: "plan-link" }, open ? "Hide" : "Show"),
  );
}

/** Plan: the breaks you dismissed; what Rivet has in hand, late or not, and what he did today are Your asks' (your-asks.ts). */
export function planBody(schedules: SchedulesResponse | null, rerender: () => void, now = Date.now()): HTMLElement {
  const plan = planState(schedules, now);
  return h(
    "div",
    { class: "plan" },
    plan.dismissed.length
      ? h(
          "section",
          { class: "plan-group", attrs: { "data-plan-group": "dismissed" } },
          foldRow(`${plan.dismissed.length} dismissed`, dismissedOpen, () => (dismissedOpen = !dismissedOpen), rerender),
          dismissedOpen
            ? h(
                "ul",
                { class: "plan-list" },
                ...plan.dismissed.map((item) => h("li", { class: "plan-dismissed" }, h("span", { class: "plan-dismissed-title" }, item.title), button("Bring back", () => bringBack(item), "ghost plan-bring-back", false, "plan.bring-back"))),
              )
            : null,
        )
      : null,
  );
}

/** Next: the dated things coming up (timed runs, expiries), under Plan and beside the jobs on the Scheduled list. */
export function nextBody(schedules: SchedulesResponse | null, now = Date.now()): HTMLElement | null {
  const { next } = planState(schedules, now);
  return next.length
    ? h(
        "section",
        { class: "plan-group", attrs: { "data-plan-group": "next" } },
        secHead("Next"),
        h("ul", { class: "plan-list" }, ...next.map((one) => h("li", { class: "plan-item" }, h("span", { class: "plan-mark", attrs: { "aria-hidden": "true" } }, "◷"), h("span", { class: "plan-at" }, when(one.at, now)), h("span", {}, one.text)))),
      )
    : null;
}
