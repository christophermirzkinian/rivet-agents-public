import "./ops.css";

import { clock, dayDate, localDay, maybeWhen, when } from "../../../src/shared/when.js";
import {
  diskTone,
  brokenOnMain,
  sourceProblem,
  resetText,
  CLAUDE_STALE_MS,
  accountsTotal,
  claudeCells,
  codexCells,
  sumCells,
  type UsageCell,
  limitNotes,
  limitUnread,
  type AppStatus,
  type ClaudeLimit,
  type GithubSource,
  type MacVolume,
  type OpsResponse,
  type Tone,
  macChats,
} from "../../../src/shared/ops.js";
import { NO_REPO } from "../../../src/shared/repos.js";
import type { OpsStatusKind } from "../../../src/shared/ops-status.js";
import { opsStatusKey } from "../../../src/shared/ops-status-key.js";
import { button, h, keepFocus, type Child } from "../dom.js";
import { loadPushHealth, pushHealth } from "../push-health.js";
import { brokenPrs, ciCurrent, failingSchedules, flyCurrent, githubCurrent, healthCurrent, macCurrent, opsAge, opsData, readingAge, refreshOps, watchOps } from "../ops-data.js";
import { app, changed, go, refresh as refreshBoard, sameSession, setOpsPage, subscribe, type OpsPage } from "../state.js";
import { costCard, type PillTone } from "./costs.js";
import { calm, ciItem, currentAppItem, diskItem, dismissed, macItem, owned, prItem, pushItem, parked, quiet, runnerItem, scheduleItem, shade, type FailedItem } from "./ops-status.js";
import { nextBody, planBody } from "./ops-plan.js";
import { countedSchedules, holdStatusLine, releaseStatusLine, schedulesOwned } from "./status-line.js";
import { scheduleApi, scheduleLines, schedulesStale } from "./schedules.js";
import { jobRed, jobsView, openRedJobs } from "./scheduled.js";
import type { SchedulesResponse } from "../../../src/shared/schedules.js";
import * as settings from "./settings.js";
import { openSheet } from "./sheet.js";
import { machinesTrend } from "./machines-trend.js";
import * as api from "../api.js";
import { agentName } from "../cloud-agent.js";
import { accountLines, machinesHead, machinesWorstFirst, usageLead } from "../reading-figures.js";
import { leadFigure, readingFrame, readingView } from "./reading.js";
import { onSessionReset } from "../session.js";

export { HOLD_WORDS } from "../../../src/shared/pr-holds.js";

// Plan (ops-plan.ts) sits under the desks on the Floor: what is being done, by when and why. The readings are pages in
// the menu: Usage leads with the two overalls, Machines with one line per box, its readings and chart in full, then the
// schedules; Usage's detail folds under "More". Apps and Code are gone: their breaks are Plan's failed items, and a
// search hit for them opens Plan. Everything here only reads.

type Shade = Tone | "idle";

/** Which page each section lives on; search and the glance's rows open a section through this. */
const SECTION_TAB: Record<string, OpsPage> = {
  claude: "usage",
  openai: "usage",
  "claude-accounts": "usage",
  "openai-accounts": "usage",
  runners: "machines",
  mac: "machines",
  boxes: "machines",
  schedules: "machines",
};

/** A folded section you opened or closed yourself this visit; otherwise it opens only while red or amber. */
const folds = new Map<string, boolean>();
let pendingSection: string | null = null;
let unsubscribe: (() => void) | null = null;
let unwatch: (() => void) | null = null;
let root: HTMLElement | null = null;
let refreshing = false;
/** Ops holds the status line's schedules poll while open, so Plan's failing schedules stay current. */
let holding = false;
/** The schedules Machines lists, read while its pill is on. */
let schedules: SchedulesResponse | null = null;
let schedulesError: string | null = null;

/** Opens the page holding one section (search results use this); a section with no page left opens Plan. */
export function focusSection(section: string): void {
  // Red jobs have no page: they open a sheet of their own.
  if (section === "jobs") return openRedJobs();
  const owner = SECTION_TAB[section];
  if (!owner) return openOps();
  pendingSection = section;
  openOpsPage(owner);
}

/** Opens one page: Plan on the Floor, a reading from the menu. */
export function openOpsPage(next: OpsPage): void {
  setOpsPage(next);
  go(next);
  changed();
}

/** No page named (the desks' OK, the briefing's Open Ops, a search hit for the old tab): Plan, on the Floor. */
export function openOps(): void {
  pendingSection = "plan";
  openOpsPage("plan");
}

export function mount(el: HTMLElement): void {
  unmount();
  root = el;
  const render = () => renderOps(el);
  unsubscribe = subscribe(render);
  unwatch = watchOps(render);
  holdStatusLine();
  holding = true;
  render();
  void loadPushHealth();
}

export function unmount(): void {
  unsubscribe?.();
  unwatch?.();
  unsubscribe = null;
  unwatch = null;
  if (holding) releaseStatusLine();
  holding = false;
  root = null;
}

/** Pull to refresh: the board and the Ops data. */
export function refresh(): Promise<unknown> {
  return Promise.all([
    refreshBoard(),
    refreshOps(),
    loadPushHealth(),
    app.opsPage === "machines" || app.opsPage === "plan" ? loadSchedules() : null,
  ]);
}

async function loadSchedules(): Promise<void> {
  const current = sameSession();
  try {
    const next = await scheduleApi.get();
    if (!current()) return;
    schedules = next;
    schedulesError = null;
  } catch (failure) {
    if (!current()) return;
    schedulesError = failure instanceof Error ? failure.message : "Couldn't read the schedules.";
  }
  if (root && (app.opsPage === "machines" || app.opsPage === "plan")) renderOps(root);
}

const REFRESH_DEADLINE_MS = 20_000;

/** A load that never answers frees the button after REFRESH_DEADLINE_MS; its late answer still lands. */
async function refreshNow(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  if (root) renderOps(root);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), REFRESH_DEADLINE_MS);
  });
  try {
    if ((await Promise.race([refresh(), late])) === "late") opsData.error = "Ops didn't answer in 20 seconds. Try again.";
  } finally {
    clearTimeout(timer);
    refreshing = false;
    if (root) renderOps(root);
  }
}

const short = (repo: string) => repo.split("/").pop() ?? repo;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Reading labels use the same advancing server clock as their freshness flags. */
const readingAt = (ops: OpsResponse, at: string) => maybeWhen(at, Date.parse(ops.now) + opsAge());

/**
 * One section: its title and headline, then its content. The body is only built for the page on screen. A folded
 * section shows its title and headline and opens on a tap; it opens itself while red or amber, or when a search hit
 * or a glance row points at it.
 */
interface Section {
  id: string;
  title: string;
  tone: Shade;
  headline: string;
  body: () => Child;
  wide?: boolean;
  fold?: boolean;
  /** The tone the menu dot and Rivet take, with breaks an agent is on set aside; the page keeps `tone`. */
  calmTone?: Shade;
}

function section(id: string, title: string, tone: Shade, headline: string, body: () => Child, wide = false): Section {
  return { id, title, tone, headline, body, wide };
}

/** The section, folded: a quiet one stays shut until you want it. */
function folded(sec: Section): Section {
  return { ...sec, fold: true };
}

function sectionEl(sec: Section, i: number): HTMLElement {
  const title = h("h2", { class: "ops-sec-title", attrs: { id: `ops-${sec.id}-title` } }, sec.title);
  const line = h("span", { class: `ops-sec-line t-${sec.tone}` }, sec.headline);
  if (!sec.fold)
    return h(
      "section",
      { class: `ops-sec${sec.wide ? " wide" : ""}`, attrs: { "data-section": sec.id, "aria-labelledby": `ops-${sec.id}-title` } },
      h("div", { class: "ops-sec-head" }, title, line),
      h("div", { class: "ops-sec-body" }, sec.body()),
    );
  return fold(
    sec.id,
    sec.tone === "bad" || sec.tone === "warn",
    { class: `ops-sec ops-fold${sec.wide ? " wide" : ""}`, attrs: { "data-section": sec.id, "aria-labelledby": `ops-${sec.id}-title` } },
    h("summary", { class: "ops-sec-head", attrs: { "data-use": "ops.section.fold", "data-use-value": String(i + 1) } }, title, line),
    h("div", { class: "ops-sec-body" }, sec.body()),
  );
}

/**
 * A fold that opens by itself when `auto`, and otherwise keeps your own tap for the visit. A search hit or a glance row
 * that points at it opens it as your tap would, so a redraw straight after (the shell mounting Ops) keeps it open. The
 * toggle event a fold built open fires is no change of state, so it is not taken for a tap.
 */
function fold(key: string, auto: boolean, props: { class: string; attrs?: Record<string, string> }, summary: HTMLElement, ...body: Child[]): HTMLElement {
  if (pendingSection === key) folds.set(key, true);
  let open = folds.get(key) ?? auto;
  const el = h("details", { ...props, attrs: { ...props.attrs, ...(open ? { open: "" } : {}) } }, summary, ...body) as HTMLDetailsElement;
  el.addEventListener("toggle", () => {
    if (el.open === open) return;
    open = el.open;
    folds.set(key, open);
  });
  return el;
}

/** Every section of every page; only the bodies of the page on screen are ever built. */
function allSections(ops: OpsResponse | null): Section[] {
  // On each page a red section comes first (renderOps); what is only history or detail is folded under its title.
  // Usage draws its own page (usageHeroes, usageMore).
  return [
    macSection(ops),
    runnersSection(ops),
  ];
}

/** A reading page's title as its menu row says it, and its placeholder's blocks at about the height it lands at. */
const READING: Record<Exclude<OpsPage, "plan">, { page: string; shape: readonly number[] }> = {
  usage: { page: "Usage", shape: [250, 250, 56] },
  machines: { page: "Machines", shape: [110, 230, 200] },
};

/** What a reading page has read: Ops alone; Usage's figures are its Claude reading. */
function readingOf(ops: OpsResponse | null, page: Exclude<OpsPage, "plan">): { has: boolean; failed: boolean } {
  const failed = !!opsData.error;
  // A read with nothing to show says it failed plainly, never that it shows the last numbers read. Usage's figure is
  // an overall with an account read, not a Claude reading of unread rows.
  // Machines' figures are any machine reading, however old, never a bare Ops envelope that holds none.
  const measured = () =>
    page === "usage" ? overallViews(ops).some((view) => !!view.usage && !!usageLead(view.cells, false)) : page === "machines" ? machinesRead(ops) : true;
  return { has: !!ops && (!failed || measured()), failed };
}

/** Whether Ops holds a reading of any machine: the Mac's. */
function machinesRead(ops: OpsResponse | null): boolean {
  return !!ops?.mac;
}

function renderOps(el: HTMLElement): void {
  const ops = opsData.ops;
  const page = app.opsPage;
  const refocus = keepFocus(el);
  const reading = page === "plan" ? null : { ...READING[page], ...readingOf(ops, page), busy: refreshing, at: opsData.opsAt.wall || null, retry: () => void refreshNow() };
  const body: Child[] =
    !reading
      ? pageBody(ops, "plan")
      : [
          readingFrame(reading, () => pageBody(ops, page)),
          // The schedules and their Red jobs row are read apart from Ops, and stay while the page has no figures.
          page === "machines" && !reading.has ? machineSchedules(true) : null,
        ];
  el.replaceChildren(h("div", { class: "hq ops", attrs: { "data-page": page, "data-section": page } }, ...body));
  refocus();
  if (pendingSection) {
    const target = el.querySelector(`[data-section="${pendingSection}"]`);
    // A page still reading has drawn no sections yet: a search hit waits for the render that draws its target.
    if (target || !reading || readingView(reading).body !== "pending") pendingSection = null;
    if (target instanceof HTMLElement && typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "start" });
  }
}

/** One page's sections, the red ones first; the rest keep their order (a stable sort). */
function pageSections(ops: OpsResponse | null, page: OpsPage): HTMLElement[] {
  const quiet = quietSections(ops, page);
  return allSections(ops)
    .filter((sec) => SECTION_TAB[sec.id] === page)
    .map((sec) => ({ ...sec, tone: shownTone(sec, quiet) }))
    .sort((a, b) => Number(b.tone === "bad") - Number(a.tone === "bad"))
    .map(sectionEl);
}

/**
 * The page's sections whose red rows on Wrong now all have an agent on them or were dismissed, and no red row of theirs
 * is anybody else's.
 */
function quietSections(ops: OpsResponse | null, page: OpsPage): Set<string> & { owned?: Set<string> } {
  let wrong: ReturnType<typeof wrongRows>;
  try {
    wrong = wrongRows(ops, page);
  } catch {
    return new Set();
  }
  const red = (row: WrongRow) => row.tone === "bad" && row.section !== null;
  const quiet: Set<string> & { owned?: Set<string> } = new Set([...wrong.rows, ...wrong.hidden].filter(red).map((row) => row.section!));
  for (const row of wrong.rows) if (red(row) && !row.owned) quiet.delete(row.section!);
  // The sections an agent is on: amber. One quiet only for what you dismissed takes its calm tone.
  quiet.owned = new Set(wrong.rows.filter((row) => red(row) && row.owned).map((row) => row.section!));
  return quiet;
}

/**
 * A section's tone on its page: red only for what nobody is on. A section red only for breaks an agent is on, or that
 * you dismissed, is amber.
 */
function shownTone(sec: Section, quiet: Set<string> & { owned?: Set<string> }): Shade {
  if (sec.tone !== "bad") return sec.tone;
  const standsDown = sec.calmTone !== undefined ? sec.calmTone !== "bad" : quiet.has(sec.id);
  if (!standsDown) return "bad";
  // Red only for what you dismissed: its calm tone, as if the item were not there.
  if (quiet.owned && !quiet.owned.has(sec.id) && quiet.has(sec.id)) return sec.calmTone ?? "idle";
  return "warn";
}

/** "More": a page's detail, folded until you open it, and kept open for the visit once you have. */
function more(key: string, ...body: Child[]): HTMLElement {
  return fold(`more-${key}`, false, { class: "ops-page-more" }, h("summary", { class: "ops-page-more-head", attrs: { "data-use": "ops.page.more" } }, "More"), ...body);
}

function pageBody(ops: OpsResponse | null, page: OpsPage): Child[] {
  switch (page) {
    case "plan":
      if (!schedules && !schedulesError) void loadSchedules();
      return [notices(ops, page), ...planPage()];
    case "usage":
      return [usageHeroes(ops), notices(ops, page), more("usage", usageMore(ops))];
    case "machines":
      // The machine readings and their chart stay in full view.
      return [notices(ops, page), boxesEl(ops), machinesTrend(ops), h("div", { class: "ops-grid" }, ...pageSections(ops, page)), machineSchedules()];
    default:
      return [notices(ops, page), h("div", { class: "ops-grid" }, ...pageSections(ops, page))];
  }
}

/** Plan and Next, or one plain line once a read found neither. */
function planPage(): Child[] {
  const plan = planBody(schedules, () => root && renderOps(root));
  const next = nextBody(schedules);
  const none = !plan.childElementCount && !next && (schedules || schedulesError);
  return [plan, next, none ? h("p", { class: "empty" }, "Nothing on the plan yet.") : null];
}

// Machines: one line per box, then the schedules

/**
 * How many machines need a look, then one line per machine worst first, as each section shows itself: amber for what an
 * agent is on, calm for what you dismissed.
 */
function boxesEl(ops: OpsResponse | null): HTMLElement {
  const quiet = quietSections(ops, "machines");
  const faulty = (tone: Shade) => tone === "bad" || tone === "warn";
  const read = [!!ops?.mac && macCurrent(ops)];
  const lines = [macSection(ops)].map((sec, i) => ({ name: sec.title, why: sec.headline, tone: shownTone(sec, quiet), read: read[i]!, fault: faulty(sec.tone) }));
  const head = machinesHead(lines);
  return h(
    "section",
    { class: "ops-list machines-head", attrs: { "data-section": "boxes", "aria-label": "Machines" } },
    h("div", { class: `box machines-lead t-${head.tone}` }, leadFigure(head.figure, head.words, head.tone)),
    h("ul", { class: "ops-lines" }, ...machinesWorstFirst(lines).map((line) => lineEl(line.name, line.why, line.tone))),
  );
}

function lineEl(name: string, why: string, tone: Shade, attrs: Record<string, string> = {}): HTMLElement {
  return h(
    "li",
    { class: "ops-line", attrs },
    h("span", { class: `ops-dot t-${tone}`, attrs: { "aria-hidden": "true" } }),
    h("span", { class: "ops-line-name" }, name),
    h("span", { class: "ops-line-why" }, why),
  );
}

function machineSchedules(alone = false): HTMLElement | null {
  if (!schedules && !schedulesError) void loadSchedules();
  // Under a Machines frame with no Ops reading, only with something in them: the frame already says the read failed.
  if (alone && !schedules && !jobsView()?.jobs.some(jobRed)) return null;
  return schedulesEl();
}

/** The schedules, read only: name · next run · last result, failing first. Their switches went with their page. */
function schedulesEl(): HTMLElement {
  const head = (extra: string | null) => h("h2", { class: "ops-list-title", attrs: { id: "ops-schedules-title" } }, extra ? `Schedules · ${extra}` : "Schedules");
  const shell = (...body: Child[]) => h("section", { class: "ops-list", attrs: { "data-section": "schedules", "aria-labelledby": "ops-schedules-title" } }, ...body);
  // The Red jobs sheet's way in where the status line is hidden (a small phone, a computer). A dismissed red job counts
  // here too, as its Bring back, Pause and Delete are on that sheet.
  const red = jobsView()?.jobs.filter(jobRed).length ?? 0;
  const redRow = red ? button(`${red === 1 ? "1 job" : `${red} jobs`} red ›`, () => openRedJobs(), "ghost ops-red-jobs", false, "jobs.red.open") : null;
  if (!schedules)
    return shell(
      head(null),
      redRow,
      h("p", { class: "empty" }, schedulesError ? "Couldn't read the schedules." : "Loading…"),
      schedulesError ? button("Try again", () => void loadSchedules(), "ghost", false, "ops.refresh") : null,
    );
  const stale = schedulesStale(schedules);
  if (!schedules.items.length) return shell(head(null), redRow, h("p", { class: "empty" }, "Nothing scheduled yet."));
  return shell(
    head(schedulesError ? "couldn't refresh" : stale ? `read ${schedules.at ? when(schedules.at) : "earlier"}` : null),
    redRow,
    schedulesError ? button("Try again", () => void loadSchedules(), "ghost", false, "ops.refresh") : null,
    h("ul", { class: "ops-lines" }, ...scheduleLines(schedules).map((line) => {
      const schedule = schedules!.items.find((one) => one.id === line.id);
      return lineEl(line.name, `${line.next} · ${line.last}`, stale ? "idle" : shade(schedule ? scheduleItem(schedule) : null, line.tone), { "data-schedule": line.id });
    })),
  );
}

// What is wrong, for Plan's Being done

/** One thing wrong: the item when it failed, and where a tap takes you. */
interface WrongRow {
  kind: string;
  tone: "bad" | "warn";
  title: string;
  line: string | null;
  item: FailedItem | null;
  /** Every thing the row stands for has an agent on it. */
  owned: boolean;
  /** The section the row opens, whose red it stands for. */
  section: string | null;
  open: () => void;
}

/** Rows of one kind shown before "N more": more red PRs than this are one row that opens the list. */
const GLANCE_PER_KIND = 3;
const SHADE_ORDER: Record<"bad" | "warn", number> = { bad: 0, warn: 1 };

function wrongRow(kind: string, tone: "bad" | "warn", title: string, line: string | null, item: FailedItem | null, to: string | (() => void), mine = owned(item)): WrongRow {
  return { kind, tone, title, line, item, owned: mine, section: typeof to === "string" ? to : null, open: typeof to === "string" ? () => focusSection(to) : to };
}

/**
 * The groups Plan's failed items are read in: the Apps and Code pages' old groups, which no page shows now, and
 * Machines, whose page still marks its sections by them.
 */
export type WrongBucket = "apps" | "code" | "machines";

/** The group each kind of row is read in: a failing schedule, timed CI, sits with Code and opens Schedules. */
const WRONG_PAGE: Record<string, WrongBucket> = { app: "apps", ci: "code", pr: "code", schedule: "code", machine: "machines", disk: "machines", runner: "machines", push: "machines" };

/**
 * Everything red or amber, as rows of the page that reads it: apps down or with a failed deploy, red on main, red PRs,
 * failing schedules, the Mac's faults, full disks, CI runners offline and phones with notifications off. A reading out
 * of date adds no row: the notices say what is old. `hidden` holds the rows you dismissed (ops-status.ts dismissed),
 * left out of `rows` and `count` until the item changes or breaks again.
 */
export function wrongRows(ops: OpsResponse | null, on: WrongBucket | OpsPage, perKind = GLANCE_PER_KIND): { rows: WrongRow[]; count: number; hidden: WrongRow[] } {
  const rows: WrongRow[] = [];
  const hidden: WrongRow[] = [];
  let count = 0;
  if (!ops) return { rows, count, hidden };
  const push = (row: WrongRow, n = 1) => {
    if (WRONG_PAGE[row.kind] !== on) return;
    if (dismissed(row.item)) {
      hidden.push(row);
      return;
    }
    rows.push(row);
    count += n;
  };
  // Each part on its own: a reading missing one (no bridge, no apps) still names the others.
  const part = (fill: () => void) => {
    try {
      fill();
    } catch {
      // Nothing to name from a part the reading lacks.
    }
  };
  // Apps: down first (red), then a deploy that failed on an app still up (amber), as the server orders them.
  for (const one of ops.apps ?? [])
    part(() => {
      const item = currentAppItem(one, ops);
      const checks = one.fly?.checks;
      if (!item && appTone(one, ops) === "warn" && checks) push(wrongRow("app", "warn", one.name, `Fly checks: ${checks.passing} of ${checks.total} passing`, null, "apps"));
      if (!item) return;
      const down = healthCurrent(ops) && one.health.state === "down";
      push(wrongRow("app", down ? "bad" : "warn", one.name, item.what.slice(0, 2).join(" · "), item, "apps"));
    });
  // Red on main: one row a workflow; the server's count covers any run this snapshot lacks. A one-off run's red is on
  // Main and CI only.
  part(() => {
    if (!ciCurrent(ops)) return;
    // What you dismissed goes to the fold first, so the rows and the "more" count are only what is left.
    const all = brokenOnMain(ops.github!.runs);
    const red = all.filter((run) => !dismissed(ciItem(run)));
    for (const run of [...all.filter((run) => dismissed(ciItem(run))), ...red.slice(0, perKind)])
      push(
        wrongRow(
          "ci",
          "bad",
          `${short(run.repo)} · ${run.workflow}`,
          [`${(run.conclusion ?? "failed").replace(/_/g, " ")} on main`, maybeWhen(run.updatedAt), run.failedJobs?.length ? run.failedJobs.slice(0, 3).join(", ") : null].filter(Boolean).join(" · "),
          ciItem(run),
          "main",
        ),
      );
    const rest = Math.max(ops.summary.redCi, all.length) - (all.length - red.length) - Math.min(red.length, perKind);
    const restMine = ops.summary.redCi <= all.length && red.slice(perKind).every((run) => owned(ciItem(run)));
    if (rest > 0) push(wrongRow("ci", "bad", `${rest}${red.length ? " more" : ""} red on main`, red.length ? null : "Workflow runs the snapshot lacks", null, "main", restMine), rest);
  });
  // Red PRs: the first few, then one row for the rest.
  // A repo whose PRs could not be read drops only its own PRs, never every repo's (its notice names it).
  // Only a PR red on the same push for over an hour: a younger red is its chat's work, shown under Pull requests.
  part(() => {
    const broken = brokenPrs(ops);
    if (!broken) return;
    const failing = broken.filter((pr) => !dismissed(prItem(pr)));
    for (const pr of [...broken.filter((pr) => dismissed(prItem(pr))), ...failing.slice(0, perKind)]) {
      const item = prItem(pr)!;
      push(wrongRow("pr", "bad", `#${pr.number} ${pr.title}`, item.what.join(": "), item, "prs"));
    }
    const rest = failing.length - perKind;
    if (rest > 0) push(wrongRow("pr", "bad", `${rest} more red ${rest === 1 ? "PR" : "PRs"}`, null, null, "prs", failing.slice(perKind).every((pr) => owned(prItem(pr)))), rest);
  });
  part(() => {
    const schedules = failingSchedules(ops);
    if (schedules) push(wrongRow("schedule", "bad", `${plural(schedules, "schedule")} failing`, "Timed jobs, on Ops Machines", null, "schedules", schedulesOwned(schedules)), schedules);
  });
  // Machines: the Mac and its disks, then runners GitHub sees offline.
  part(() => {
    const mac = macFaults(ops);
    if (mac) push(wrongRow("machine", mac.tone, "Mac", mac.lines.join(" · "), mac.item, "mac"));
  });
  part(() => {
    for (const disk of macDisks(ops)) push(wrongRow("disk", disk.tone, `Mac ${disk.volume.label} disk`, `${disk.free}% free${disk.volume.runners ? " · the runners' work directories" : ""}`, disk.item, "mac"));
  });
  part(() => {
    const down = offlineRunners(ops);
    const offline = down.filter((name) => !dismissed(runnerItem(name)));
    for (const name of [...down.filter((name) => dismissed(runnerItem(name))), ...offline.slice(0, perKind)]) push(wrongRow("runner", "bad", name, "CI runner offline", runnerItem(name), "runners"));
    if (offline.length > perKind) push(wrongRow("runner", "bad", `${offline.length - perKind} more runners offline`, null, null, "runners", offline.slice(perKind).every((name) => owned(runnerItem(name)))), offline.length - perKind);
  });
  part(() => {
    const pushOff = pushItem(pushHealth());
    // Push lives in Settings, where it is turned back on.
    if (pushOff) push(wrongRow("push", "bad", pushOff.title, pushOff.what[0] ?? null, pushOff, () => openSheet("Settings", settings, "Close", undefined, { use: "more.settings" })));
  });
  // Red nobody is on first, then what is being fixed, then amber.
  rows.sort((a, b) => SHADE_ORDER[a.tone] - SHADE_ORDER[b.tone] || Number(a.owned) - Number(b.owned));
  return { rows, count, hidden };
}

/**
 * Every named break or warning, each once, for Plan's Being done: apps down or with a failed deploy, red on main, PRs
 * red over an hour, failing schedules, sick machines, full disks and offline runners. Phones with notifications off are
 * your own setting, not Rivet's work.
 */
export function failedItems(ops: OpsResponse | null): FailedItem[] {
  return planItems(ops).shown;
}

/** What you dismissed of failedItems, in Plan's words, for its "N dismissed · Show" fold. */
export function dismissedItems(ops: OpsResponse | null): FailedItem[] {
  return planItems(ops).gone;
}

/** The item Ops drew a Plan item from: a Dismiss and its sheet read the item as Ops has it, whose words make its mark. */
export function opsItem(item: FailedItem): FailedItem {
  return OPS_ITEM.get(item) ?? item;
}
const OPS_ITEM = new WeakMap<FailedItem, FailedItem>();

/** What you parked of failedItems, left off Plan and said on the calm "Parked" line. */
export function parkedItems(ops: OpsResponse | null): FailedItem[] {
  return planItems(ops).parked;
}

function planItems(ops: OpsResponse | null): { shown: FailedItem[]; gone: FailedItem[]; parked: FailedItem[] } {
  const seen = new Set<string>();
  const pages = (["apps", "code", "machines"] as const).map((page) => wrongRows(ops, page, Infinity));
  // Only while Ops counts a schedule failing, as its own rows do; each by name when the line's list has them, and the
  // rest of Ops' count, which the list may not have caught up with, as one row.
  const failing = ops?.summary ? failingSchedules(ops) : 0;
  const counted = failing ? (countedSchedules()?.map((schedule) => scheduleItem(schedule)).filter((item) => item !== null) ?? null) : null;
  const listed = counted?.filter((item) => !dismissed(item)) ?? null;
  const unnamed = counted ? failing - counted.length : 0;
  const plan = (item: FailedItem): FailedItem => {
    // Only a CI run's first line is Ops' own words; a title or a run's title is someone's, and keeps its words.
    const copy = { ...item, title: planWords(item.title), what: item.what.map((line, i) => (item.kind === "ci" && i === 0 ? planLine(line) : planWords(line))) };
    OPS_ITEM.set(copy, item);
    return copy;
  };
  // A row with no item of its own (a count the snapshot cannot name) gets one by its title. Every item's words are
  // Plan's: no "red", CI, runners or PRs.
  const items = pages
    .flatMap((page) => page.rows)
    .filter((row) => row.kind !== "push" && !(row.kind === "schedule" && counted && unnamed <= 0))
    .map((row): FailedItem => {
      if (row.item) return plan(row.item);
      if (row.kind === "schedule" && listed) row = { ...row, title: `${plural(unnamed, listed.length ? "more schedule" : "schedule", listed.length ? "more schedules" : "schedules")} failing` };
      const title = planLine(row.title);
      const line = row.line && planLine(row.line);
      return { kind: row.kind as OpsStatusKind, key: opsStatusKey(row.kind as OpsStatusKind, title), repo: NO_REPO, title, what: line ? [line] : [], failedAt: null, url: null };
    });
  if (listed) items.push(...listed.map(plan));
  const once = (item: FailedItem) => !seen.has(`${item.kind}/${item.key}`) && !!seen.add(`${item.kind}/${item.key}`);
  const distinct = items.filter(once);
  const shown = distinct.filter((item) => !parked(item));
  const hidden = [...pages.flatMap((page) => page.hidden.map((row) => row.item)), ...(counted ?? []).filter((item) => dismissed(item))];
  return { shown, gone: hidden.filter((item): item is FailedItem => item !== null && once(item)).map(plan), parked: distinct.filter(parked) };
}

/** A line Ops wrote, as Plan says it: no "red", CI, runners or PRs. */
function planLine(text: string): string {
  return planWords(
    text
      .replace(/^CI .* on main$/, "Tests failing on the main build")
      .replace(/\bred on main\b/, "failed runs on main")
      .replace(/\bred (PRs?)\b/, "$1 with failed checks"),
  );
}

/**
 * Someone's words, such as a PR's title, with only Plan's words swapped in for CI, runners, PRs and GitHub. Code
 * spans and any word with a "/" in it (URLs, paths) are names, not prose, and stay as written.
 */
export function planWords(text: string): string {
  return text
    .split(/(`[^`]*`|\S*\/\S*)/)
    .map((part, i) => (i % 2 ? part : proseWords(part, i === 0)))
    .join("");
}

function proseWords(text: string, opens: boolean): string {
  return text
    .replace(/\bCI ((?:[Rr]unner|[Rr]un|[Ff]ailure|[Cc]heck)(s?))\b/g, (_, word: string, s: string, at: number) => {
      const swapped = /^[Rr]unner/.test(word) ? `test machine${s}` : /^[Cc]heck/.test(word) ? `test${s}` : `test ${word.toLowerCase()}`;
      return (opens && at === 0) || /^[A-Z]/.test(word) ? swapped[0]!.toUpperCase() + swapped.slice(1) : swapped;
    })
    .replace(/\bPRs\b/g, "code changes")
    .replace(/\bPR\b/g, "code change")
    .replace(/\b([Rr])unners\b/g, (_, r: string) => (r === "R" ? "Test machines" : "test machines"))
    .replace(/\b([Rr])unner\b/g, (_, r: string) => (r === "R" ? "Test machine" : "test machine"))
    .replace(/\bCI\b/g, "tests")
    .replace(/\bGitHub\b/g, "the code host");
}

/** The group each GitHub source feeds: PRs and runs are Code's, which no page shows, runners and the queue Machines'. */
const GITHUB_PAGE: Record<GithubSource, WrongBucket> = { prs: "code", runs: "code", merged: "code", runners: "machines", queue: "machines" };
const GITHUB_SOURCES = Object.keys(GITHUB_PAGE) as GithubSource[];

/** What is old or unread, on the pages it touches: a failed load, the bridge and "Loading" on every page. */
function notices(ops: OpsResponse | null, on: OpsPage): HTMLElement | null {
  const lines: { text: string; tone: Shade }[] = [];
  const add = (text: string, tone: Shade, pages?: readonly OpsPage[]) => {
    if (!pages || pages.includes(on)) lines.push({ text, tone });
  };
  // A reading page says a failed read in its frame (reading.ts), never a server's own words.
  if (on === "plan" && opsData.error) add("Couldn't load Ops.", "bad");
  // app.notice is the feed's failure in the server's own words; Plan says it plainly.
  if (on === "plan" && app.notice) add(`Can't reach ${agentName()}.`, "bad");
  if (ops) {
    if (!ops.bridge.connected) add("The Mac bridge is offline; GitHub and Mac data stop updating.", "warn");
    else {
      // GitHub gives Machines its runners.
      if (ops.github?.stale) add(`GitHub data is from ${readingAt(ops, ops.github.at) ?? "earlier"}.`, "warn", ["machines"]);
      else if (ops.github) {
        const gh = ops.github;
        const problems = GITHUB_SOURCES.filter((source) => GITHUB_PAGE[source] === on)
          .map((source) => sourceProblem(gh, source))
          .filter((line): line is string => line !== null);
        if (problems.length) add(problems.length > 1 ? `${problems[0]}; ${problems.length - 1} more GitHub sources too.` : `${problems[0]}.`, "warn");
      }
      if (ops.claude && usageStale(ops.claude)) add(`Claude usage is from ${readingAt(ops, ops.claude.at) ?? "earlier"}.`, "warn", ["usage"]);
      if (ops.mac?.stale) add(`Mac health is from ${readingAt(ops, ops.mac.at) ?? "earlier"}.`, "warn", ["machines"]);
    }
  } else if (on === "plan" && !opsData.error) add("Loading Ops…", "info");
  if (!lines.length) return null;
  // Plan is never red: a failed read there is a grey line.
  if (on === "plan") return h("div", { class: "plan-notes", attrs: { role: "status" } }, ...lines.map((line) => h("p", { class: "plan-note" }, line.text)));
  return h("div", { class: "ops-notices", attrs: { role: "status" } }, ...lines.map((line) => h("p", { class: `ops-notice box t-${line.tone}` }, line.text)));
}

// GitHub readings

/** Failed fetches retain a source's last successful timestamp, never the newer envelope's. */
function githubAsOf(gh: NonNullable<OpsResponse["github"]>, source: GithubSource): string {
  const state = gh.sources?.[source];
  const at = state?.failed.length ? state.at : gh.at;
  return at ? `as of ${when(at)}` : "no reading";
}

function stat(value: string, label: string, tone: Shade = "idle"): HTMLElement {
  return h("div", { class: `ops-stat box t-${tone}` }, h("span", { class: "ops-stat-n" }, value), h("span", { class: "ops-stat-l" }, label));
}

type RunnerRow = { name: string; status: string; busy: boolean };

/** How the runners read, for the CI runners card and the glance. One offline over a week is retired, behind one line. */
function runnerReads(ops: OpsResponse | null) {
  const runners = ops?.github?.runners ?? null;
  const retiredNames = new Set(ops?.retiredRunners ?? []);
  const retired = (runner: RunnerRow) => runner.status === "offline" && retiredNames.has(runner.name);
  const gone = runners ? runners.runners.filter(retired) : [];
  const listed = (runner: RunnerRow) => !retired(runner);
  // Aggregate offline includes omitted retired rows. Only the sampled details can identify actionable faults.
  const offline = runners ? runners.runners.filter((runner) => runner.status === "offline" && listed(runner)).length : 0;
  return { runners, gone, offline, listed };
}

/** The names of the runners GitHub sees offline that are really down, while the GitHub reading is current. */
function offlineRunners(ops: OpsResponse | null): string[] {
  // A failed runners fetch leaves the last list in place: a runner offline in it may be back.
  if (!ops || !githubCurrent(ops) || ops.github!.sources?.runners.failed.length) return [];
  const { runners, listed } = runnerReads(ops);
  return (runners?.runners ?? []).filter((runner) => listed(runner) && runner.status === "offline").map((runner) => runner.name);
}

/** Your self-hosted CI runners and the job queue, on Machines; with GitHub's own runners there are none to list. */
function runnersSection(ops: OpsResponse | null): Section {
  const gh = ops?.github ?? null;
  const runnerCurrent = !!ops && githubCurrent(ops) && !gh?.sources?.runners.failed.length;
  const queueCurrent = !!ops && githubCurrent(ops) && !gh?.sources?.queue.failed.length;
  const queue = queueCurrent ? gh?.queue ?? null : null;
  const problems = gh ? (["runners", "queue"] as const).map((source) => sourceProblem(gh, source)).filter((line): line is string => line !== null) : [];
  const { runners: recorded, gone, offline, listed } = runnerReads(ops);
  const runners = runnerCurrent ? recorded : null;
  const runnerCount = (value: number) => `${value}${runners?.complete === true ? "" : "+"}`;
  const offlineCount = `${offline}${runners?.detailsComplete === true ? "" : "+"}`;
  const queueCount = queue ? `${queue.queuedJobs}${queue.jobsComplete === true ? "" : "+"}` : "–";
  const queueLabel = queue?.jobsComplete === true ? "jobs queued" : "jobs queued in sample";
  // No runner online is an outage only when one is really down.
  const noneUp = !!runners && runners.complete === true && !runners.online && offline > 0;
  const none = !!runners && runners.complete === true && !runners.runners.length && !queue?.queuedJobs && !problems.length;
  const headline = none
    ? "None listed"
    : gh
    ? [runners ? `${runnerCount(runners.busy)}/${runnerCount(runners.online)} busy` : null, runnerCurrent && offline ? `${offlineCount} offline` : null, queue ? `${queueCount} ${queueLabel}` : null, problems.length ? "GitHub unreachable" : null, !runnerCurrent || !queueCurrent ? `No current ${!runnerCurrent ? "runner" : "queue"} reading · ${githubAsOf(gh, !runnerCurrent ? "runners" : "queue")}` : null]
        .filter(Boolean)
        .join(" · ") || "No runner data"
    : "No GitHub data yet";
  const names = offlineRunners(ops);
  const ownedOffline = offline > 0 && names.length >= offline && names.every((name) => quiet(runnerItem(name)));
  // Offline runners you dismissed, every one: no amber left for them.
  const goneOffline = ownedOffline && names.every((name) => dismissed(runnerItem(name)));
  const tone: Shade = none ? "idle" : noneUp ? "bad" : runnerCurrent && offline && !goneOffline ? "warn" : runnerCurrent && queueCurrent ? "ok" : "info";
  // None online, every offline one owned or dismissed: amber, or calm once all are dismissed.
  const upTone: Shade = runners?.online ? "ok" : noneUp ? (goneOffline ? "idle" : ownedOffline ? "warn" : "bad") : "idle";
  return { ...section("runners", "CI runners", tone, headline, () =>
    !gh || none ? h("p", { class: "empty" }, none ? "No self-hosted runners." : "Waiting for the Mac to send GitHub status.") : h(
      "div",
      { class: "ops-stack" },
      ...problems.map((line) => h("p", { class: "ops-notice box t-warn" }, `${line}.`)),
      h(
        "div",
        { class: "ops-stats" },
        stat(runners ? runnerCount(runners.online) : "–", "runners online", runners ? upTone : "idle"),
        stat(runners ? runnerCount(runners.busy) : "–", "busy", runners?.busy ? "info" : "idle"),
        stat(runners ? offlineCount : "–", "offline", runnerCurrent && offline ? "warn" : "idle"),
        stat(queueCount, queueLabel, queue?.queuedJobs ? "warn" : "idle"),
      ),
      queue && queue.jobsComplete !== true && queue.sampledRuns !== undefined ? h("p", { class: "ops-row-meta" }, `Checked ${plural(queue.sampledRuns, "run")}; job list may be incomplete.`) : null,
      recorded && recorded.detailsComplete !== true ? h("p", { class: "ops-row-meta" }, "Runner list is a fetched sample; more runners may exist.") : null,
      recorded?.runners.some(listed)
        ? h(
            "ul",
            { class: "ops-rows" },
            ...recorded.runners.filter(listed).map((runner) => {
              const word = !runnerCurrent ? `${runner.status} ${githubAsOf(gh!, "runners")}` : runner.status === "offline" ? "Offline" : runner.busy ? "Busy" : "Idle";
              const rTone: Shade = !runnerCurrent ? "idle" : runner.status === "offline" ? "bad" : runner.busy ? "info" : "ok";
              return calm(
                h(
                  "li",
                  { class: `ops-row box s-${rTone}` },
                  h("span", { class: "ops-link" }, h("span", { class: "ops-tags" }, h("span", { class: "ops-row-title" }, runner.name), h("span", { class: `ops-tag t-${rTone}` }, word))),
                ),
                rTone === "bad" ? runnerItem(runner.name) : null,
              );
            }),
          )
        : null,
      runnerCurrent && gone.length
        ? fold(
            "runners-retired",
            false,
            { class: "ops-retired" },
            h("summary", { class: "ops-row-meta", attrs: { "data-use": "ops.retired.fold" } }, `${gone.length} retired`),
            h("p", { class: "ops-row-meta" }, `Offline over a week: ${gone.map((runner) => runner.name).join(", ")}`),
          )
        : null,
    ),
  ), calmTone: (tone === "warn" || (tone === "bad" && offline > 0)) && ownedOffline ? (runnerCurrent && queueCurrent ? "ok" : "info") : tone };
}

// Apps, as Plan's failed items read them

function appTone(one: AppStatus, ops: OpsResponse): Shade {
  if (healthCurrent(ops) && one.health.state === "down") return "bad";
  if (flyCurrent(ops, one.app ?? undefined) && one.fly?.lastRelease?.status === "failed") return "warn";
  // With no URL to check, Fly's checks are the only reading: a machine awake and a check failing is amber.
  if (flyCurrent(ops, one.app ?? undefined) && one.health.state === "no-check" && one.fly?.checks.total && one.fly.machines.started > 0) return one.fly.checks.passing < one.fly.checks.total ? "warn" : "ok";
  if (healthCurrent(ops) && one.health.state === "up") return "ok";
  return "idle";
}

// Mac

function uptime(sec: number): string {
  const days = Math.floor(sec / 86_400);
  const hours = Math.floor((sec % 86_400) / 3600);
  return days ? `${days}d ${hours}h` : `${hours}h ${Math.floor((sec % 3600) / 60)}m`;
}

function gb(bytes: number): string {
  const value = bytes / 1024 ** 3;
  return value >= 1000 ? `${(value / 1024).toFixed(1)} TB` : `${Math.round(value)} GB`;
}

/** The Mac's volumes that need a look while its reading is current: the fullest first, red ones as failed items. */
function macDisks(ops: OpsResponse | null): { volume: MacVolume; free: number; tone: "bad" | "warn"; item: FailedItem | null }[] {
  if (!ops?.mac || !macCurrent(ops)) return [];
  return ops.mac.volumes
    .filter((volume) => volume.totalBytes > 0)
    .map((volume) => {
      const share = volume.freeBytes / volume.totalBytes;
      const tone = diskTone(share);
      return { volume, free: Math.round(share * 100), tone, item: tone === "bad" ? diskItem(volume) : null };
    })
    .filter((disk): disk is { volume: MacVolume; free: number; tone: "bad" | "warn"; item: FailedItem | null } => disk.tone === "bad" || disk.tone === "warn")
    .sort((a, b) => a.free - b.free);
}

/** The Mac's faults other than its disks, for the glance: memory, the bridge, a runner down, chats stopped. Null when fine. */
function macFaults(ops: OpsResponse | null): { tone: "bad" | "warn"; lines: string[]; item: FailedItem | null } | null {
  const mac = ops?.mac ?? null;
  const bridge = ops?.bridge.connected ?? false;
  if (!mac || !macCurrent(ops!)) return null;
  const item = macItem(mac, bridge);
  const memTone: Shade = mac.memory.pressure === "critical" ? "bad" : mac.memory.pressure === "normal" ? "ok" : "warn";
  const lines = [...(item?.what ?? []), memTone === "warn" ? `Memory getting tight, ${Math.round(mac.memory.freePct)}% free` : "", macChats(mac).up ? "" : macChats(mac).down].filter(Boolean);
  if (!lines.length) return null;
  return { tone: item || memTone === "bad" ? "bad" : "warn", lines, item };
}

function macSection(ops: OpsResponse | null): Section {
  const mac = ops?.mac ?? null;
  const bridge = ops?.bridge.connected ?? false;
  if (!mac)
    return section("mac", "Mac", bridge ? "info" : "warn", bridge ? "No Mac health yet" : "Bridge offline", () =>
      h("p", { class: "empty" }, bridge ? "No Mac health read yet." : "The Mac bridge is offline, so no Mac health was read."),
    );
  // An old reading is no reading: its disk and memory say when they were read, never that they are fine now.
  const current = macCurrent(ops!);
  const disk = current ? ops!.summary.disk : { freePct: null, tone: "info" as Shade };
  const deadRunners = mac.runners.filter((runner) => !runner.alive);
  const loadPct = Math.round((mac.load.one / mac.load.cpus) * 100);
  const memTone: Shade = mac.memory.pressure === "critical" ? "bad" : mac.memory.pressure === "normal" ? "ok" : "warn";
  const faults = macItem(mac, bridge);
  const tone: Shade = !current
    ? "warn"
    : disk.tone === "bad" || memTone === "bad"
      ? "bad"
      : disk.tone === "warn" || memTone === "warn" || deadRunners.length || !macChats(mac).up
        ? "warn"
        : "ok";
  const headline = !current
    ? `no reading since ${when(mac.at)}`
    : [disk.freePct !== null ? `${disk.freePct}% disk free` : null, `memory ${mac.memory.pressure}`, deadRunners.length ? `${plural(deadRunners.length, "runner")} down` : null]
        .filter(Boolean)
        .join(" · ");
  return section("mac", "Mac", tone, headline, () =>
    h(
      "div",
      { class: "ops-stack" },
      h(
        "ul",
        { class: "ops-disks" },
        ...mac.volumes.map((volume) => {
          const free = volume.totalBytes > 0 ? volume.freeBytes / volume.totalBytes : 0;
          const vTone = diskTone(free);
          const bar = h("span", { class: "ops-bar-fill" });
          bar.style.width = `${Math.min(100, Math.max(2, Math.round((1 - free) * 100)))}%`;
          return calm(
            h(
              "li",
              { class: `ops-disk t-${vTone}` },
              h("span", { class: "ops-disk-top" }, h("strong", {}, volume.label), h("span", {}, `${Math.round(free * 100)}% free`)),
              h("span", { class: "ops-bar", attrs: { role: "img", "aria-label": `${volume.label} ${Math.round(free * 100)} percent free` } }, bar),
              h("span", { class: "ops-row-meta" }, `${gb(volume.freeBytes)} of ${gb(volume.totalBytes)}${volume.runners ? " · runner work dirs" : ""}`),
            ),
            vTone === "bad" ? diskItem(volume) : null,
          );
        }),
      ),
      h(
        "div",
        { class: "ops-stats" },
        stat(`${loadPct}%`, `load (${mac.load.one} on ${mac.load.cpus} cores)`, loadPct > 150 ? "warn" : "idle"),
        stat(mac.memory.pressure === "unknown" ? "–" : `${Math.round(mac.memory.freePct)}%`, `memory free, ${mac.memory.pressure}`, shade(faults, memTone)),
        stat(uptime(mac.uptimeSec), "uptime"),
      ),
      calm(
        h(
          "div",
          { class: "ops-tags" },
          h("span", { class: `ops-tag t-${bridge ? "ok" : "bad"}` }, bridge ? "Bridge connected" : "Bridge offline"),
          h("span", { class: `ops-tag t-${macChats(mac).up ? "ok" : "warn"}` }, macChats(mac).up ? macChats(mac).running : macChats(mac).down),
          ...mac.runners.map((runner) => h("span", { class: `ops-tag t-${runner.alive ? "ok" : "bad"}` }, `${runner.name} ${runner.alive ? "up" : "down"}`)),
        ),
        !bridge || deadRunners.length > 0 ? faults : null,
      ),
      h("p", { class: "ops-row-meta" }, `Sent ${readingAt(ops!, mac.at) ?? "earlier"}`),
    ),
  );
}

// Usage

// The page leads with the two overalls, Claude and OpenAI, each used, left and its next reset. Under them, calm and
// grouped: each provider's accounts and their resets.

const SEVERITY_TONE: Record<ClaudeLimit["severity"], Shade> = { normal: "ok", warning: "warn", critical: "bad" };
/** Soonest reset first; rows with no reset time keep their order at the end (Array#sort is stable). */
function byNextReset<T extends { resetsAt: string | null }>(limits: readonly T[]): T[] {
  const at = (limit: T) => (limit.resetsAt ? Date.parse(limit.resetsAt) : NaN);
  return [...limits].sort((a, b) => {
    const x = at(a);
    const y = at(b);
    if (Number.isNaN(x) || Number.isNaN(y)) return Number(Number.isNaN(x)) - Number(Number.isNaN(y));
    return x - y;
  });
}

type Usage = NonNullable<OpsResponse["claude"]>;

/** Judged by the clock as well as the server's flag: a cached reading ages while /api/ops is failing. */
export function usageStale(usage: Usage): boolean {
  const ops = opsData.ops;
  const age = ops?.claude === usage ? readingAge(ops, usage.at) : Date.now() - Date.parse(usage.at);
  return usage.stale || !(age <= CLAUDE_STALE_MS);
}

/** Hundreds of percent as limits: 368 → "3.7", 300 → "3". */
const asLimits = (percent: number): string => String(Number((percent / 100).toFixed(1)));

/**
 * "3.7 of 5 weekly limits used": every account's week summed raw, as the Claude card does, said as limits, not a percent
 * of a percent, with "1 account not read" for an account the bridge could not read; this account's own week with no
 * account read, out of every account as Usage says it, the unread ones still said. `used` and `unread` are the two
 * parts, each coloured on its own.
 */
export function weekTotal(
  limitRows: readonly ClaudeLimit[],
): { text: string; used: string; unread: string | null; tone: "ok" | "warn" | "bad"; n: string; of: string } | null {
  const sum = accountsTotal(limitRows);
  const cells = claudeCells(limitRows).length;
  // With none read this account's own week stands in for one of them, as Usage's overall does (claudeOverall).
  const unreadCount = sum ? sum.unread : Math.max(0, cells - 1);
  const unread = unreadCount ? `${plural(unreadCount, "account")} not read` : null;
  const said = (n: string, total: number, tone: "ok" | "warn" | "bad") => {
    const used = `${n} of ${asLimits(total)} weekly ${total === 100 ? "limit" : "limits"} used`;
    return { text: [used, unread].filter(Boolean).join(", "), used, unread, tone, n, of: `of ${asLimits(total)}` };
  };
  if (sum) return said(asLimits(sum.used), sum.total, sum.tone);
  const you = limitRows.find((limit) => limit.kind === "weekly_all");
  return you ? said(asLimits(you.percent), 100 * Math.max(1, cells), you.severity === "critical" ? "bad" : you.severity === "warning" ? "warn" : "ok") : null;
}

/** A Codex (OpenAI) account's row, carried with the Claude reading. */
const isCodex = (limit: ClaudeLimit): boolean => limit.kind === "codex" || limit.kind.startsWith("codex_");

/** The Claude cells: every account's week; with none read, this account's own week as the one cell. */
function claudeOverall(usage: Usage): UsageCell[] {
  const cells = claudeCells(usage.limits);
  if (cells.some((cell) => !cell.unread)) return cells;
  const week = usage.limits.find((limit) => limit.kind === "weekly_all");
  if (!week) return cells;
  // No account read: this account's own week stands in for its cell, and the others stay in the total, not read. With
  // none marked active it still stands in for one of them, never beside them: the list holds the signed-in account.
  const own: UsageCell = { who: "This account", percent: week.percent, unread: false, active: true, resetsAt: week.resetsAt, window: "week", rows: [week] };
  if (!cells.length) return [own];
  const at = Math.max(0, cells.findIndex((cell) => cell.active));
  return cells.map((cell, i) => (i === at ? { ...own, who: cell.active ? cell.who : own.who } : cell));
}

/** One provider's overall, the top of Usage: how much is used, how much is left and the next reset, in limits. */
interface Overall {
  id: "claude" | "openai";
  name: string;
  cells: UsageCell[];
  /** Null with nothing to show yet: the card says what it waits for. */
  usage: Usage | null;
  empty: string;
}

function overallCard(ops: OpsResponse | null, view: Overall): HTMLElement {
  const stale = !!view.usage && usageStale(view.usage);
  const lead = view.usage ? usageLead(view.cells, stale) : null;
  const head = h(
    "div",
    { class: "usage-hero-head" },
    h("h2", { class: "usage-hero-name", attrs: { id: `ops-${view.id}-title` } }, h("span", { class: "usage-mark", attrs: { "aria-hidden": "true" } }), view.name),
    stale
      ? h(
          "span",
          { class: "usage-hero-meta t-warn" },
          // Codex rows ride on the Claude reading and may be older than it (the bridge keeps them 15 minutes).
          `Read ${readingAt(ops!, view.usage!.at) ?? "earlier"}${view.id === "openai" ? " or earlier" : ""}`,
        )
      : lead
        ? h("span", { class: "usage-hero-meta" }, plural(view.cells.length, "account"))
        : null,
  );
  const shell = (...body: Child[]) =>
    h("section", { class: `usage-hero box t-${lead?.cardTone ?? "idle"}`, attrs: { "data-section": view.id, "aria-labelledby": `ops-${view.id}-title` } }, head, ...body);
  if (!lead) return shell(h("p", { class: "usage-hero-empty" }, view.empty));
  const left = `${lead.left}${lead.unread ? "+" : ""}`;
  return shell(
    leadFigure(left, `of ${lead.of} left`, lead.tone),
    h("p", { class: "reading-lines usage-lines" }, lead.line),
    accountList(view.cells),
  );
}

/** "Resets Tue 12:59am": the day and time alone, the countdown left off so a row fits a 320 px phone. */
const resetsLabel = (at: string | null): string | null => {
  const text = resetText(at, Date.now());
  return text ? `R${text.slice(1).replace(/, in .*$/, "")}` : null;
};

/** The overall's accounts, one row each: name, used (or "Not read" / "Full"), its own bar, then Fable and the reset. */
function accountList(cells: readonly UsageCell[]): HTMLElement {
  return h(
    "ul",
    { class: "usage-accounts" },
    ...accountLines(cells, resetsLabel).map((line) => {
      const fill = h("span", { class: "usage-cell-fill" });
      if (line.fill !== null) fill.style.width = `${line.fill}%`;
      return h(
        "li",
        { class: `usage-account s-${line.state} t-${line.tone}`, attrs: { "data-state": line.state } },
        h("div", { class: "usage-account-head" }, h("span", { class: "usage-account-who" }, line.who), h("span", { class: "usage-account-figure" }, line.figure)),
        h("span", { class: `usage-cell${line.fill === null ? " unread" : ""}`, attrs: { role: "img", "aria-label": `${line.who}: ${line.figure}` } }, fill),
        h("span", { class: "usage-account-detail" }, line.detail),
      );
    }),
  );
}

function overallViews(ops: OpsResponse | null): [Overall, Overall] {
  const usage = ops?.claude ?? null;
  const codex = usage ? codexCells(usage.limits) : [];
  return [
    { id: "claude", name: "Claude", cells: usage ? claudeOverall(usage) : [], usage, empty: "Rivet doesn't read Claude usage." },
    { id: "openai", name: "OpenAI", cells: codex, usage: codex.length ? usage : null, empty: "No OpenAI accounts read yet." },
  ];
}

/** The top of Usage: overall Claude, then overall OpenAI; side by side on a wide screen. */
function usageHeroes(ops: OpsResponse | null): HTMLElement {
  return h("div", { class: "usage-heroes" }, ...overallViews(ops).map((view) => overallCard(ops, view)));
}

/** A group under the overalls: its title, how old its reading is, then its cards. */
function usageCard(id: string, title: string, meta: string | null, ...body: Child[]): HTMLElement {
  return h(
    "section",
    { class: "usage-card usage-group", attrs: { "data-section": id, "aria-labelledby": `ops-${id}-title` } },
    h("div", { class: "usage-card-head" }, h("h3", { class: "usage-card-title", attrs: { id: `ops-${id}-title` } }, title), meta ? h("span", { class: "usage-card-meta" }, meta) : null),
    ...body,
  );
}

const PILL_TONE: Record<Shade, PillTone> = { ok: "yes", warn: "warn", bad: "bad", info: "quiet", idle: "quiet" };
const LIMIT_WORD: Record<Shade, string> = { ok: "OK", warn: "High", bad: "Very high", info: "OK", idle: "No reading" };

/**
 * One account or meter: its name and use, its grade, the reset, and its notes ("Active", "5-hr 88%") or shorter
 * windows. The bridge sends an unread account as 0%, and an old reading as it last was: neither is this week's, so it
 * reads "no reading". A shorter window's own grade counts, so a full 5-hour window reads red under a calm week.
 */
function usageRow(name: string, row: ClaudeLimit, pills: readonly string[], windows: readonly ClaudeLimit[] = []): HTMLElement {
  const unread = limitUnread(row);
  const used = Math.round(row.percent);
  const tones: Shade[] = [unread ? "idle" : SEVERITY_TONE[row.severity], ...windows.map((limit) => SEVERITY_TONE[limit.severity])];
  const tone: Shade = tones.includes("bad") ? "bad" : tones.includes("warn") ? "warn" : tones[0]!;
  const notes = [...pills, ...windows.map((limit) => [`${windowOf(limit) ?? "window"} ${Math.round(limit.percent)}%`, resetText(limit.resetsAt, Date.now())].filter(Boolean).join(" · "))];
  return costCard({
    name,
    figure: unread ? "no reading" : `${used}%`,
    quiet: unread,
    // The bar is this window's own use and grade; the pill also counts a shorter window's.
    bar: { percent: unread ? null : used, tone: PILL_TONE[tones[0]!], label: unread ? `${name}: no reading` : `${name} ${used} percent used` },
    pill: { text: LIMIT_WORD[tone], tone: PILL_TONE[tone] },
    meta: (!unread && resetText(row.resetsAt, Date.now())) || "no reset time",
    line: notes.length ? notes.join(" · ") : undefined,
  });
}

/** A Codex row's window from its label: "week", "5-hour". */
const windowOf = (row: ClaudeLimit) => /, ([^(]+?)(?: \(|$)/.exec(row.label)?.[1] ?? null;

/** The bridge's notes on an account row as pills: "Active", "Limited", "5-hr 88%"; "old" and "no reading" are the row's own state. */
const notePills = (row: ClaudeLimit): string[] =>
  limitNotes(row)
    .filter((note) => note !== "old" && note !== "no reading")
    .map((note) => (note === "active" ? "Active" : note === "limited" ? "Limited" : note.replace(/^fable /, "Fable ")));

/** Claude's accounts, the soonest reset first, then the signed-in account's own meters: the 5-hour session and the weeks. */
function claudeAccounts(ops: OpsResponse | null): HTMLElement | null {
  const usage = ops?.claude ?? null;
  if (!usage) return null;
  const accounts = byNextReset(claudeCells(usage.limits));
  const own = usage.limits.filter((limit) => !limit.kind.startsWith("account_") && !isCodex(limit));
  return usageCard(
    "claude-accounts",
    "Claude accounts",
    `Read ${readingAt(ops!, usage.at) ?? "earlier"}`,
    accounts.length ? h("ul", { class: "costs-list" }, ...accounts.map((cell) => usageRow(cell.who, cell.rows[0]!, notePills(cell.rows[0]!)))) : null,
    own.length ? h("h4", { class: "usage-sub" }, "Signed-in account") : null,
    own.length ? h("ul", { class: "costs-list" }, ...own.map((limit) => usageRow(limit.label, limit, []))) : null,
  );
}

/** Each Codex account: its longest window, and any shorter one under it. */
function openaiAccounts(ops: OpsResponse | null): HTMLElement | null {
  const usage = ops?.claude ?? null;
  const cells = usage ? byNextReset(codexCells(usage.limits)) : [];
  if (!cells.length) return null;
  const main = (cell: UsageCell) => cell.rows.find((row) => row.credits !== undefined || row.unlimited !== undefined) ?? cell.rows[cell.rows.length - 1]!;
  return usageCard(
    "openai-accounts",
    "OpenAI accounts",
    `Read ${readingAt(ops!, usage!.at) ?? "earlier"} or earlier`,
    h(
      "ul",
      { class: "costs-list" },
      ...cells.map((cell) => {
        const top = main(cell);
        const others = cell.rows.filter((row) => row !== top && !limitUnread(row));
        const window = windowOf(top);
        return usageRow(
          `${cell.who}${window && window !== "week" ? `, ${window}` : ""}`,
          top,
          cell.active ? ["Active"] : [],
          others,
        );
      }),
    ),
  );
}

/** Under the overalls: each account, Claude's and OpenAI's side by side on a wide screen. */
function usageMore(ops: OpsResponse | null): HTMLElement {
  const claude = claudeAccounts(ops);
  const openai = openaiAccounts(ops);
  return h(
    "div",
    { class: "usage-more" },
    h("h2", { class: "usage-more-title" }, "Accounts and resets"),
    claude || openai ? h("div", { class: "usage-cards" }, h("div", { class: "usage-col" }, claude), h("div", { class: "usage-col" }, openai)) : h("p", { class: "empty" }, "No accounts read yet."),
  );
}

onSessionReset(() => {
  refreshing = false;
});

