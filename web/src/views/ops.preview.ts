// Dev-only preview of Progress, the menu's pages and the search and settings sheets with fake data:
// web/preview/ops.html?tab=progress|more[&page=usage|machines|code]&sheet=search|settings&q=notes
// Nothing imports this from the app, so the production build leaves it out.
import "../styles.css";

import type { OpsStatus } from "../../../src/shared/ops-status.js";
import type { OpsDismissal } from "../../../src/shared/ops-dismiss.js";
import { boardSchema, type PushConfigResponse, type Reply } from "../../../src/shared/board.js";
import type { AuditEntry } from "../../../src/shared/command.js";
import type { ConversationsResponse } from "../../../src/shared/conversations.js";
import type { ClaudeUsageSnapshot, FlySnapshot, GithubSnapshot, Health, MacSnapshot, OpsResponse, TimelineResponse } from "../../../src/shared/ops.js";
import type { PushSettingsResponse } from "../../../src/shared/quiet.js";
import type { SearchItem } from "../../../src/shared/search.js";
import type { SchedulesResponse } from "../../../src/shared/schedules.js";
import { confirmLine, lastRunTimes, nextRunTime, type Job, type JobsResponse } from "../../../src/shared/jobs.js";
import type { WorkersResponse } from "../../../src/shared/workers.js";
import { loadPushHealth } from "../push-health.js";
import { app, crewLoaded, go } from "../state.js";
// Chat first, as main.ts loads it: it registers a search source as it loads, which needs search.ts loaded already.
import "./chat.js";
import * as search from "./search.js";
import * as patchNotes from "./patch-notes.js";
import * as settings from "./settings.js";
import { openSheet } from "./sheet.js";
import { mountShell } from "./shell.js";
import { fakeHistory } from "./machines-trend.preview.js";
import { ciItem, scheduleItem } from "./ops-status.js";
import { ciOwnedItem } from "../../../src/shared/ops-owned.js";

const now = new Date();
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const R = "example-org/";
const MS = `${R}example-repo`;
const OTHER = `${R}other-repo`;
const pr = (n: number) => `https://github.com/${MS}/pull/${n}`;
// ?stale=1 shows collectors that stopped 40 minutes ago.
const stale = new URLSearchParams(location.search).get("stale") === "1";
const collected = (minutes: number) => ago(stale ? 40 : minutes);
// ?main=green: main's CI passes, so only the PRs are red.
const mainGreen = new URLSearchParams(location.search).get("main") === "green";

// ?jobcard=1: Rivet's confirm card for a job read from your words, first on the feed.
const jobCard = new URLSearchParams(location.search).get("jobcard") === "1";
const board = boardSchema.parse({
  updatedAt: ago(3),
  needs: [
    ...(jobCard
      ? [
          {
            id: "job-confirm-docs-up",
            kind: "decision",
            title: confirmLine({ words: "check Docs Site is up", when: { every: "day", at: "07:00" }, cards: "red" }),
            ask: "Your words: every morning check Docs Site is up. From the Mac, it asks Docs Site's health check once; anything but OK is red.",
            chat: "rivet",
            options: [{ label: "Yes", recommended: true }, { label: "Change", text: true }],
          },
        ]
      : []),
    {
      id: "pr2022-sidebar",
      kind: "approval",
      title: "Field Notes: pin the sidebar",
      ask: "The sidebar stays in place as you scroll, like the one on Docs Site.",
      pr: 2022,
      chat: "field-notes",
      media: { kind: "stills", stills: [{ sha256: "c".repeat(64), type: "image/png" }] },
    },
    { id: "retry-queue", kind: "decision", title: "Retry queue", options: [{ label: "Ship it" }] },
    {
      id: "docs-search",
      kind: "decision",
      title: "Add search to Docs Site?",
      ask: "People opened the contents page 20+ times a day on 3 of the last 7 days. Add puts a search box at the top of every page.",
      chat: "docs-site",
      options: [{ label: "Add" }, { label: "Not now" }],
    },
    {
      id: "merge-3968",
      kind: "merge-ready",
      title: "Merge: the header keeps the top-left corner clear",
      pr: 3968,
      repo: MS,
      headSha: "d".repeat(40),
      options: [{ label: "Merge", recommended: true }, { label: "Not yet" }],
    },
  ],
  coming: [
    { pr: 2100, title: "Field Notes offline mode", app: "Field Notes", what: "Notes open with no signal", stage: "merging", etaMinutes: 12 },
    { pr: 2101, title: "Paper Trail exports", app: "Paper Trail", what: "Export any page to PDF", stage: "building", progress: 0.4 },
    { title: "Admin switch for email alerts" },
  ],
  chats: [
    { name: "field-notes", state: "working", doing: "Sidebar for review", prs: [2105] },
    { name: "paper-trail", state: "waiting", doing: "Export layout for review" },
  ],
  shipped: [{ pr: 2105, title: "Touch action guard", live: true }],
});

const run = (id: number, workflow: string, conclusion: string | null, minutes: number, failedJobs?: string[], repo = MS) => ({
  repo,
  id,
  attempt: 1,
  workflow,
  title: `Merge #${2150 + (id % 20)}`,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  event: "push",
  sha: "a".repeat(40),
  url: `https://github.com/${repo}/actions/runs/${id}`,
  createdAt: ago(minutes + 20),
  updatedAt: ago(minutes),
  ...(failedJobs ? { failedJobs } : {}),
});

const github: GithubSnapshot = {
  at: collected(1),
  prsComplete: true,
  prs: [
    {
      repo: MS,
      number: 2177,
      title: "Ops board, briefings, search and quiet hours",
      url: pr(2177),
      draft: true,
      author: "sam",
      labels: [],
      headAt: ago(12),
      updatedAt: ago(10),
      branch: "sam/ops-board",
      checks: { state: "fail", passed: 14, failed: 2, pending: 0, failing: ["unit tests", "lint"] },
    },
    // Two failing PRs with no status record, each on a branch a live chat has checked out.
    {
      repo: MS,
      number: 3788,
      title: "Sync: confirm a save once the server has it",
      url: pr(3788),
      draft: false,
      author: "sam",
      labels: [],
      headAt: ago(5),
      updatedAt: ago(5),
      branch: "sam/retry-fix",
      checks: { state: "fail", passed: 7, failed: 1, pending: 1, failing: ["integration tests"] },
    },
    {
      repo: MS,
      number: 3739,
      title: "Drafts: a lost draft is kept per session",
      url: pr(3739),
      draft: false,
      author: "sam",
      labels: [],
      headAt: ago(40),
      updatedAt: ago(38),
      branch: "fix/lost-draft-per-session",
      checks: { state: "fail", passed: 57, failed: 3, pending: 0, failing: ["integration tests", "CI complete"] },
    },
    {
      repo: MS,
      number: 2105,
      title: "Field Notes: new home page",
      url: pr(2105),
      draft: false,
      author: "sam",
      labels: ["hold: design review"],
      headAt: ago(180),
      updatedAt: ago(90),
      checks: { state: "pass", passed: 22, failed: 0, pending: 0, failing: [] },
    },
    // One PR per status the Code tab can show.
    {
      repo: MS,
      number: 3968,
      title: "The header keeps the top-left corner clear; logos centred",
      url: pr(3968),
      draft: false,
      author: "sam",
      labels: [],
      headAt: ago(60),
      updatedAt: ago(20),
      headSha: "d".repeat(40),
      checks: { state: "pass", passed: 2, failed: 0, pending: 0, failing: [] },
    },
    {
      repo: MS,
      number: 3960,
      title: "Tests: spawned servers count as ready only on their own listening line",
      url: pr(3960),
      draft: false,
      author: "sam",
      labels: [],
      headAt: ago(9),
      updatedAt: ago(8),
      headSha: "e".repeat(40),
      ciStartedAt: ago(6),
      checks: { state: "pending", passed: 41, failed: 0, pending: 12, failing: [] },
    },
    {
      repo: MS,
      number: 3859,
      title: "Docs: a scheduled job rebuilds the index of a ready PR",
      url: pr(3859),
      draft: false,
      author: "sam",
      labels: [],
      headAt: ago(25),
      updatedAt: ago(2),
      headSha: "1".repeat(40),
      checks: { state: "pass", passed: 65, failed: 0, pending: 0, failing: [] },
    },
    {
      repo: MS,
      number: 3959,
      title: "Search re-reads a short cached list before refusing, and says when it could not",
      url: pr(3959),
      draft: false,
      author: "sam",
      labels: [],
      headAt: ago(30),
      updatedAt: ago(10),
      headSha: "2".repeat(40),
      checks: { state: "pass", passed: 58, failed: 0, pending: 0, failing: [] },
    },
    {
      repo: MS,
      number: 3879,
      title: "Exports: a log call that throws can no longer abort an export or end the process",
      url: pr(3879),
      draft: false,
      author: "sam",
      labels: [],
      headAt: ago(48),
      updatedAt: ago(30),
      headSha: "3".repeat(40),
      hold: "**Owner hold:** the owner reads the diff first",
      checks: { state: "pass", passed: 20, failed: 0, pending: 0, failing: [] },
    },
    {
      repo: OTHER,
      number: 88,
      title: "Colour picker: bigger swatches",
      url: `https://github.com/${OTHER}/pull/88`,
      draft: false,
      author: "robin",
      labels: [],
      headAt: ago(40),
      updatedAt: ago(35),
      checks: { state: "pending", passed: 3, failed: 0, pending: 2, failing: [] },
    },
    {
      repo: OTHER,
      number: 412,
      title: "Pricing page copy",
      url: `https://github.com/${OTHER}/pull/412`,
      draft: false,
      author: "sam",
      labels: [],
      headAt: ago(600),
      updatedAt: ago(500),
      checks: { state: "pass", passed: 6, failed: 0, pending: 0, failing: [] },
    },
  ],
  ciTypicalMin: 21,
  runs: [
    mainGreen ? run(900, "CI", "success", 25) : run(900, "CI", "failure", 25, ["Deploy to Fly", "unit tests"]),
    run(901, "Deploy", "success", 60),
    run(902, "CI", null, 2),
    run(903, "Nightly checks", "success", 120),
    run(904, "CI", "success", 300, undefined, OTHER),
  ],
  // Runner 2 is between jobs and runner 4 is down: GitHub lists both offline.
  runners: {
    complete: true,
    detailsComplete: true,
    online: 4,
    busy: 2,
    offline: 2,
    runners: Array.from({ length: 6 }, (_, i) => ({ name: `example-runner-${i + 1}`, status: i === 1 || i === 3 ? ("offline" as const) : ("online" as const), busy: i === 0 || i === 2 })),
  },
  queue: { queuedRuns: 0, runningRuns: 3, queuedJobs: 0, sampledRuns: 3, runsComplete: true, jobsComplete: true },
  merged: null,
  sources: {
    prs: { failed: [], at: ago(1) },
    // ?ghfail=1 shows a failed fetch with the last good data kept.
    runs: new URLSearchParams(location.search).get("ghfail") === "1" ? { failed: ["example-repo"], at: ago(14) } : { failed: [], at: ago(1) },
    merged: { failed: [], at: ago(1) },
    runners: { failed: [], at: ago(1) },
    queue: { failed: [], at: ago(1) },
  },
};

const merged = [
  { repo: MS, number: 2160, title: "Ops: phases 2-4", url: pr(2160), mergedAt: ago(200), author: "sam" },
  { repo: MS, number: 3338, mergeSha: "a".repeat(40), title: "Replies send from the lock screen", url: pr(3338), mergedAt: ago(40), author: "sam" },
  { repo: MS, number: 3326, mergeSha: "b".repeat(40), title: "The opening splash glows and turns while it loads", url: pr(3326), mergedAt: ago(320), author: "sam" },
  { repo: MS, number: 3300, mergeSha: "c".repeat(40), title: "Chat threads, open inbox and thread timeline", url: pr(3300), mergedAt: ago(1700), author: "sam" },
  { repo: MS, number: 2150, title: "Field Notes toolbar", url: pr(2150), mergedAt: ago(1500), author: "sam" },
  { repo: OTHER, number: 31, title: "Menu: lunch plates", url: `https://github.com/${OTHER}/pull/31`, mergedAt: ago(3000), author: "sam" },
];

const mac: MacSnapshot = {
  at: collected(1),
  name: "This Mac",
  volumes: [
    { label: "Data", totalBytes: 971 * 1024 ** 3, freeBytes: 276 * 1024 ** 3, runners: true },
    { label: "External 1", totalBytes: 2 * 1024 ** 4, freeBytes: 1.2 * 1024 ** 4, runners: false },
  ],
  load: { one: 9.4, five: 8.1, fifteen: 7.7, cpus: 12 },
  memory: { freePct: 22, pressure: "warn" },
  uptimeSec: 4 * 86_400 + 5 * 3600,
  runners: [
    { name: "example-mac-1", alive: true },
    { name: "example-mac-2", alive: false },
    { name: "other-mac-1", alive: true },
  ],
  chatRunner: true,
};

const up = (ms: number): Health => ({ state: "up", status: 200, ms, checkedAt: collected(1), since: ago(3000), fails: 0 });
const health: Record<string, Health> = {
  "paper-trail": { state: "down", status: 502, ms: 812, checkedAt: collected(1), since: ago(14), fails: 7 },
  "docs-site": up(88),
  "field-notes": up(143),
  "status-page": up(61),
};

const fly: FlySnapshot = {
  at: collected(3),
  // ?ghfail=1 also shows a Fly app whose fetch failed.
  source: new URLSearchParams(location.search).get("ghfail") === "1" ? { failed: ["field-notes"], at: ago(9) } : { failed: [], at: null },
  apps: [
    {
      app: "paper-trail",
      status: "deployed",
      version: 57,
      sha: "c0ffee123456",
      machines: { started: 0, total: 1 },
      checks: { passing: 0, total: 1 },
      updatedAt: ago(20),
      releases: [
        { version: 57, status: "failed", at: ago(22) },
        { version: 56, status: "complete", at: ago(1600) },
      ],
    },
    {
      app: "status-page",
      status: "deployed",
      version: 214,
      sha: null,
      machines: { started: 1, total: 1 },
      checks: { passing: 1, total: 1 },
      updatedAt: ago(30),
      releases: [
        { version: 214, status: "complete", at: ago(30), patchMerges: ["a".repeat(40)] },
        { version: 213, status: "complete", at: ago(150), patchMerges: ["b".repeat(40)] },
        { version: 212, status: "complete", at: ago(1500), patchMerges: ["c".repeat(40)] },
      ],
    },
    {
      app: "field-notes",
      status: "deployed",
      version: 102,
      sha: "beef00112233",
      machines: { started: 2, total: 2 },
      checks: { passing: 2, total: 2 },
      updatedAt: ago(80),
      releases: [{ version: 102, status: "complete", at: ago(80) }],
    },
  ],
};

const inMinutes = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
const claude: ClaudeUsageSnapshot = {
  at: collected(1),
  limits: [
    { kind: "session", label: "Session (5 hr)", percent: 85, severity: "warning", resetsAt: inMinutes(69), active: true },
    { kind: "weekly_all", label: "Week (all models)", percent: 86, severity: "warning", resetsAt: inMinutes(5 * 1440 + 40), active: false },
    { kind: "weekly_scoped", label: "Week (one model)", percent: 22, severity: "normal", resetsAt: inMinutes(5 * 1440 + 40), active: false },
    { kind: "account_5", label: "Account ab*** (no reading)", percent: 0, severity: "normal", resetsAt: null, active: false },
    { kind: "account_1", label: "Account cd***", percent: 96, severity: "critical", resetsAt: inMinutes(3 * 1440 + 900), active: false },
    { kind: "account_2", label: "Account ef*** (5-hr 88%)", percent: 91, severity: "critical", resetsAt: inMinutes(1 * 1440 + 780), active: false },
    { kind: "account_3", label: "Account gh*** (active)", percent: 86, severity: "warning", resetsAt: inMinutes(5 * 1440 + 40), active: false },
    { kind: "account_4", label: "Account ij***", percent: 95, severity: "critical", resetsAt: inMinutes(3 * 1440 + 1080), active: false },
    { kind: "codex_1_week", label: "ef***, week (active)", percent: 100, severity: "critical", resetsAt: inMinutes(1 * 1440 + 480), active: false },
    { kind: "codex_2_week", label: "cd***, week", percent: 47, severity: "normal", resetsAt: inMinutes(5 * 1440 + 990), active: false },
  ],
};
// ?usage=green|amber|amberacct: the overall week under 80% (one account still at 96%) or at 80–89%, for Usage's menu
// mark; amberacct has both overalls green with one account at 85% and the session amber, for Usage's pill; the default
// sums to 92%, red.
const usageParam = new URLSearchParams(location.search).get("usage");
const weeks: Record<string, number> | undefined = { green: { account_2: 40, account_3: 35, account_4: 50 }, amber: { account_3: 70, account_4: 70 }, amberacct: { account_1: 85, account_2: 20, account_3: 20, account_4: 20, codex_1_week: 30 } }[usageParam ?? ""];
if (weeks)
  claude.limits = claude.limits.map((limit) =>
    limit.kind in weeks ? { ...limit, percent: weeks[limit.kind]!, severity: weeks[limit.kind]! >= 90 ? "critical" : weeks[limit.kind]! >= 80 ? "warning" : "normal" } : limit,
  );
// ?allclear=1: nothing wrong and nothing waiting, for the glance's empty state (every app up, main green, no red PR, every
// runner online, the Mac fine, no card open).
const allClear = new URLSearchParams(location.search).get("allclear") === "1";
if (allClear) {
  health["paper-trail"] = up(120);
  for (const flyApp of fly.apps) for (const release of flyApp.releases) release.status = "complete";
  github.runs = github.runs.map((run) => ({ ...run, status: "completed", conclusion: "success", failedJobs: [] }));
  github.prs = github.prs.filter((pr) => pr.checks.state !== "fail" && !pr.hold);
  if (github.runners) github.runners = { ...github.runners, offline: 0, runners: github.runners.runners.map((runner) => ({ ...runner, status: "online" as const })) };
  mac.memory = { freePct: 48, pressure: "normal" };
  mac.runners = mac.runners.map((runner) => ({ ...runner, alive: true }));
  board.needs = [];
}
// ?rivet=broke: all clear but main's CI red with nobody on it, Rivet's job on Plan. ?rivet=owned: the same red, with an
// agent on it.
const rivetParam = allClear ? new URLSearchParams(location.search).get("rivet") : null;
if (rivetParam) {
  github.runs = github.runs.map((run) => (run.workflow === "CI" && run.repo === MS ? { ...run, conclusion: "failure", failedJobs: ["unit tests"] } : run));
  claude.limits = claude.limits.map((limit) => ({ ...limit, percent: Math.min(limit.percent ?? 0, 40), severity: "normal" }));
}
// ?runners=none: GitHub lists no runner at all. ?prfail=1: other-repo's PRs could not be read; the other repos' still count.
if (new URLSearchParams(location.search).get("runners") === "none") github.runners = { online: 0, busy: 0, offline: 0, runners: [] };
// ?partial=1 shows bounded GitHub reads, rather than pretending they are full totals.
if (new URLSearchParams(location.search).get("partial") === "1") {
  github.prsComplete = false;
  if (github.runners) Object.assign(github.runners, { complete: false, detailsComplete: false });
  if (github.queue) Object.assign(github.queue, { runsComplete: false, jobsComplete: false });
}
if (new URLSearchParams(location.search).get("prfail") === "1" && github.sources) github.sources = { ...github.sources, prs: { failed: ["other-repo"], at: ago(14) } };
const failedOnMain = github.runs.filter((run) => run.repo === MS && run.status === "completed" && run.conclusion === "failure").length;
const ops: OpsResponse = {
  now: now.toISOString(),
  bridge: { connected: true },
  github: { ...github, merged, stale },
  mac: { ...mac, stale },
  claude: { ...claude, stale },
  flyAt: fly.at,
  flyStale: stale,
  flySource: fly.source,
  healthStaleSince: stale ? ago(40) : null,
  apps: Object.entries(health).map(([id, check]) => {
    const flyApp = fly.apps.find((row) => row.app === id);
    return {
      id,
      name: id.replace(/-/g, " ").replace(/^./, (first) => first.toUpperCase()),
      app: flyApp?.app ?? null,
      url: `https://${id}.example.com/health`,
      health: check,
      fly: flyApp ? { status: flyApp.status, version: flyApp.version, sha: flyApp.sha, machines: flyApp.machines, checks: flyApp.checks, updatedAt: flyApp.updatedAt, lastRelease: flyApp.releases[0] ?? null } : null,
    };
  }),
  summary: {
    needs: board.needs.length,
    redCi: failedOnMain,
    failingSchedules: allClear ? 0 : 1,
    failingSchedulesAll: allClear ? 0 : 1,
    schedulesAt: collected(1),
    appsDown: Object.values(health).filter((check) => check.state === "down").length,
    disk: { freePct: 28, tone: "ok" },
  },
  defaultRepo: MS,
};
const timeline: TimelineResponse = {
  days: [
    {
      day: now.toISOString().slice(0, 10),
      events: [
        { kind: "deploy-failed", at: ago(22), repo: MS, title: "Paper Trail release 57 failed", app: "paper-trail" },
        { kind: "merged", at: ago(40), repo: MS, title: merged[1]!.title, url: merged[1]!.url, number: merged[1]!.number, mergeSha: merged[1]!.mergeSha },
        { kind: "deploy", at: ago(30), repo: MS, title: "Status page release 214", app: "status-page", patchMerges: ["a".repeat(40)] },
      ],
    },
  ],
  repos: [MS, OTHER],
};
const pushSettings: PushSettingsResponse = {
  enabled: true,
  start: "22:00",
  end: "07:00",
  held: 3,
  quietNow: false,
};

const workers: WorkersResponse = {
  at: now.toISOString(),
  workers: [
    { id: "wt::a", name: "field-notes", repo: MS, chat: "field-notes", state: "working", lastOutputAt: now.getTime() - 30_000 },
    { id: "wt::b", name: "colour-picker", repo: OTHER, chat: "colour-picker", state: "idle", lastOutputAt: now.getTime() - 600_000 },
    { id: "wt::c", name: "retry-fix", repo: MS, chat: "retry-fix", state: "working", lastOutputAt: now.getTime() - 20_000, branch: "sam/retry-fix", etaMinutes: 25 },
    { id: "wt::d", name: "Alex", repo: MS, chat: "pr-lander-f", state: "idle", lastOutputAt: now.getTime() - 300_000, branch: "fix/lost-draft-per-session" },
  ] as WorkersResponse["workers"],
};

const history: SearchItem[] = [
  { kind: "briefing", key: "briefing:old", title: "Evening briefing", detail: "Paper Trail down 12 minutes", at: ago(2900), open: { type: "tab", tab: "agents" } },
];

const reply = (id: string, itemTitle: string, decision: Reply["decision"], minutes: number, extra: Partial<Reply> = {}): Reply => ({
  id,
  itemId: id,
  itemTitle,
  decision,
  rev: "r0",
  at: ago(minutes),
  handled: true,
  item: { id, title: itemTitle, kind: "approval" },
  ...extra,
});
const replies: Reply[] = [
  // A comment with two photos and a file; a recording script serves /media/ for the made-up hashes.
  reply("a0", "Colour picker: bigger swatches", "comment", 3, {
    text: "These two screens, and the brief I mentioned.",
    images: ["1".repeat(64), "2".repeat(64)],
    files: [{ sha256: "f".repeat(64), name: "Brief.pdf" }],
  }),
  reply("a1", "Field Notes: toolbar after a save", "approve", 12, { delivery: { target: "chat", chat: "field-notes", at: ago(11) } as Reply["delivery"] }),
  reply("a2", "Paper Trail export layout v5", "reject", 95, { text: "Still too tight at phone size; give every row more room." }),
  reply("a3", "Docs Site page name", "comment", 240, { text: "Call it Getting started.", handled: false }),
  // Answered at the card's rev and still on the board until Rivet drops it: Needs you leaves it out.
  reply("pr2022-sidebar", "Field Notes: pin the sidebar", "approve", 1, { rev: "r1" }),
];
const opsStatus = (kind: OpsStatus["kind"], key: string, state: OpsStatus["state"], minutes: number, extra: Partial<OpsStatus> = {}): OpsStatus => ({
  kind,
  key,
  state,
  since: ago(minutes),
  updatedAt: ago(Math.min(minutes, 6)),
  version: 1,
  ...extra,
});
// Plan's records: CI is in a chat with a done-by and a why, the failing PR has no time yet, the nightly checks are late
// with how it is kept from happening again, and three things were fixed today.
const statuses: OpsStatus[] = [
  opsStatus("ci", ciOwnedItem({ workflow: "CI", repo: MS }).key, "in-progress", 25, { chat: "deploy-fix", note: "Fly deploy timed out; retrying with a longer wait", by: "rivet", dueAt: ago(-35), why: "Fly's deploy timed out on a slow image pull" } as Partial<OpsStatus>),
  opsStatus("pr", "2177", "investigating", 12, { by: "rivet" }),
  opsStatus("schedule", "nightly-checks", "in-progress", 180, {
    by: "rivet",
    dueAt: ago(40),
    why: "The nightly checks ran past 6am: two repos queued behind a stuck run",
    prevent: "each check now stops itself after 90 minutes and the next one starts",
  } as Partial<OpsStatus>),
  opsStatus("runner", "example-mac-2", "backlog", 300, { note: "Re-register the Mac runner after the macOS update" }),
  opsStatus("app", "field-notes", "fixed", 200, { updatedAt: ago(150), note: "Field Notes back up after a restart. Its machine ran out of memory" }),
  opsStatus("pr", "3721", "fixed", 120, { updatedAt: ago(95), note: "PR 3721 green again: the flaky test now waits for the page" }),
  opsStatus("schedule", "index-rebuild", "fixed", 60, { updatedAt: ago(20), note: "The index rebuild runs again" }),
];
// ?answered=1: Rivet has answered an Investigate now on Paper Trail through `rivet status set`.
if (new URLSearchParams(location.search).get("answered") === "1")
  statuses.push(opsStatus("app", "paper-trail", "investigating", 14, { note: "Machine ran out of memory; restarting it with 1 GB", eta: "in 20 minutes", by: "rivet" }));
// One schedule failing, for the Schedules tab's pill.
const schedules: SchedulesResponse = {
  at: collected(1),
  stale: false,
  sources: [{ source: "github", ok: true, at: collected(1) }],
  items: [
    {
      id: "github:example-org/example-repo/index-rebuild.yml",
      source: "github",
      name: "Index rebuild",
      what: "Rebuilds the search index of a ready PR",
      when: "Every 30 minutes",
      group: "all-day",
      on: true,
      lastRun: { at: ago(12), result: "failed", note: "index rebuild timed out", url: `https://github.com/${MS}/actions/runs/1` },
      runs: [{ id: "1", at: ago(12), result: "failed" }, { id: "0", at: ago(42), result: "failed" }],
      nextRun: ago(-18),
      toggle: { can: true },
    },
  ],
};
if (rivetParam) {
  // No answer waiting to be confirmed, so only the red under test colours Rivet.
  replies.length = 0;
  statuses.length = 0;
  // The server counts each failing schedule's own red run, as Ops' summary does once it reads them.
  const failing = schedules.items.map(scheduleItem).filter((item) => item !== null).length;
  Object.assign(ops.summary, { failingSchedules: failing, failingSchedulesAll: failing });
  if (rivetParam === "owned")
    for (const item of [...github.runs.map(ciItem), ...schedules.items.map(scheduleItem)])
      if (item) statuses.push(opsStatus(item.kind, item.key, "in-progress", 12, { chat: `fix-${item.kind}`, by: "rivet" }));
}
const audit: AuditEntry[] = [
  { id: "x1", clientId: "c-x1", kind: "merge", at: ago(20), updatedAt: ago(18), status: "merged", repo: MS, pr: 2105 },
  { id: "x2", clientId: "c-x2", kind: "schedule", at: ago(16), updatedAt: ago(9), status: "succeeded", schedule: "Index rebuild", on: true },
  { id: "x3", clientId: "c-x3", kind: "send", at: ago(70), updatedAt: ago(66), status: "failed", chat: "paper-trail" },
];

// ?push=off: the server can reach no phone, the last dropped by its push service. ?push=blocked: this phone (an installed
// Android app) blocks notifications as well.
const pushParam = new URLSearchParams(location.search).get("push");
const pushConfig: PushConfigResponse = {
  configured: true,
  publicKey: "BPreview",
  subscriptions: pushParam ? 0 : 1,
  lastRemoval: pushParam ? { at: ago(36 * 60), reason: "gone", status: 410, host: "fcm.googleapis.com", remaining: 0 } : null,
};
// Headless Chromium always reads "denied", so the preview sets this phone's permission itself.
if ("Notification" in window) Object.defineProperty(Notification, "permission", { configurable: true, get: () => (pushParam === "blocked" ? "denied" : "granted") });
if (pushParam === "blocked") {
  const media = window.matchMedia.bind(window);
  window.matchMedia = (query: string) => (query.includes("display-mode: standalone") ? ({ ...media(query), matches: true } as MediaQueryList) : media(query));
}

const dismissals: OpsDismissal[] = [];

// Ops › Scheduled: your own jobs, one red, one paused; ?jobs=none for none, ?jobs=owned for the red one being fixed.
const fakeJob = (extra: Partial<Job>): Job => ({
  id: "j-aaaaaaaa",
  name: "Docs Site up",
  words: "every morning check Docs Site is up",
  kind: "check",
  check: { probe: "up", app: "docs-site", where: "mac", onRed: "card" },
  when: { every: "day", at: "07:00" },
  cards: "red",
  state: "active",
  createdAt: ago(5 * 1440),
  activeSince: ago(5 * 1440),
  whenText: "Daily 7:00am",
  lastRun: { id: "r-00000001", at: lastDue({ every: "day", at: "07:00" }), finishedAt: lastDue({ every: "day", at: "07:00" }, 4), result: "green", line: "docs-site is up: https://docs-site.example.com/health answered 200." },
  runs: [],
  redStreak: 0,
  owned: false,
  ...extra,
  nextRun: nextRunTime(extra.when ?? { every: "day", at: "07:00" }, now)?.toISOString() ?? null,
});
const lastDue = (when: Job["when"], plus = 0) => new Date((lastRunTimes(when, now, 1)[0] ?? now).getTime() + plus * 60_000).toISOString();
const jobs: JobsResponse = {
  at: now.toISOString(),
  jobs: [
    fakeJob({}),
    fakeJob({
      id: "j-bbbbbbbb",
      name: "Open issues",
      words: "every Monday at 9 look over the open issues and tell me which need me",
      kind: "task",
      check: undefined,
      when: { every: "week", day: "mon", at: "09:00" },
      whenText: "Mondays 9:00am",
      lastRun: { id: "r-00000002", at: lastDue({ every: "week", day: "mon", at: "09:00" }), finishedAt: lastDue({ every: "week", day: "mon", at: "09:00" }, 12), result: "red", line: "Two issues need you." },
      redStreak: 1,
      // ?jobs=owned: an agent is on the red job, so it is amber.
      owned: new URLSearchParams(location.search).get("jobs") === "owned",
    }),
    fakeJob({ id: "j-cccccccc", name: "Typecheck", words: "typecheck main every 6 hours", check: { script: "typecheck", where: "mac", onRed: "card" }, when: { every: "hours", hours: 6, minute: 15 }, whenText: "Every 6 hours at :15", state: "paused", lastRun: { id: "r-00000003", at: lastDue({ every: "hours", hours: 6, minute: 15 }, -360), result: "missed" } }),
  ],
  limits: { active: 2, maxActive: 10, tasksToday: 1, maxTasksToday: 6 },
};

const passThrough = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input);
  // Anything else, such as images, loads for real.
  if (!url.startsWith("/api/")) return passThrough(input, init);
  const method = init?.method ?? "GET";
  let body: unknown = {};
  let status = 200;
  if (url.startsWith("/api/machines/history")) body = url.includes("since=") ? { now: now.toISOString(), machines: [] } : fakeHistory();
  else if (url.startsWith("/api/ops/timeline")) body = timeline;
  else if (url.startsWith("/api/ops/search")) body = { results: history };
  else if (url.startsWith("/api/ops/status")) body = { statuses };
  else if (url.startsWith("/api/ops/dismissals")) {
    // Your Dismiss: kept for the page's life, as the server keeps them.
    const [kind, key] = url.slice("/api/ops/dismissals/".length).split("/").map(decodeURIComponent);
    const at = dismissals.findIndex((row) => row.kind === kind && row.key === key);
    if (method === "PUT") {
      const row = { kind: kind as OpsDismissal["kind"], key: key!, mark: (JSON.parse(String(init?.body)) as { mark: string }).mark, at: new Date().toISOString() };
      if (at >= 0) dismissals.splice(at, 1);
      dismissals.unshift(row);
      body = row;
    } else if (method === "DELETE") {
      if (at >= 0) dismissals.splice(at, 1);
      body = { ok: true };
    } else body = { dismissals };
  }
  else if (url.startsWith("/api/schedules")) body = schedules;
  else if (url === "/api/jobs") body = new URLSearchParams(location.search).get("jobs") === "none" ? { ...jobs, jobs: [], limits: { ...jobs.limits, active: 0 } } : jobs;
  else if (url.startsWith("/api/ops")) body = ops;
  else if (url.startsWith("/api/settings/push")) body = method === "PUT" ? { ...pushSettings, ...JSON.parse(String(init?.body)) } : pushSettings;
  else if (url.startsWith("/api/workers")) body = workers;
  else if (url.startsWith("/api/replies")) body = { replies };
  else if (url.startsWith("/api/audit")) body = { entries: audit };
  else if (url.startsWith("/api/chat/search")) body = { results: [] };
  else if (url === "/api/chat" && method === "POST") {
    const sent = JSON.parse(String(init?.body)) as { clientId: string; text: string };
    body = { id: "preview-ask", clientId: sent.clientId, kind: "chat", at: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "collecting", text: sent.text } satisfies AuditEntry;
  }
  else if (url.startsWith("/api/chat")) body = { messages: [], older: null };
  else if (url.startsWith("/api/conversations/")) {
    body = { error: "no such thread" };
    status = 404;
  } else if (url.startsWith("/api/conversations")) body = { conversations: [], older: 0, unread: 0 } satisfies ConversationsResponse;
  else if (url.startsWith("/api/push/config")) body = pushConfig;
  else if (url.startsWith("/api/logs/subscribe")) body = { leaseUntil: new Date(Date.now() + 60_000).toISOString() };
  else if (url.startsWith("/api/logs?")) body = { lines: ["Reading src/export.ts", "Running pnpm test (42 passed)", "Waiting for review"], updatedAt: new Date().toISOString(), leaseUntil: null };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
};

try {
  localStorage.removeItem("rivet.briefing.dismissed");
} catch {}

const params = new URLSearchParams(location.search);
app.board = { version: 1, updatedAt: board.updatedAt, board: { ...board, needs: board.needs.map((need) => ({ ...need, rev: "r1" })) } };
app.status = { bridge: { connected: true } } as typeof app.status;
app.recent = replies;
crewLoaded(workers);
// As refresh() loads them: the newest reply to each card.
for (const reply of replies) if (!app.replies.has(reply.itemId)) app.replies.set(reply.itemId, reply);
const asked = params.get("tab") ?? "progress";
go(asked === "more" ? (params.get("page") ?? "more") : asked);
mountShell(document.getElementById("app")!);
void loadPushHealth();

const sheet = params.get("sheet");
if (sheet === "search") {
  openSheet("Search", search);
  const q = params.get("q");
  if (q)
    setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>(".srch-input");
      if (!input) return;
      input.value = q;
      input.dispatchEvent(new Event("input"));
    }, 300);
} else if (sheet === "settings") openSheet("Settings", settings);
else if (sheet === "patchnotes") openSheet("Patch notes", patchNotes);
