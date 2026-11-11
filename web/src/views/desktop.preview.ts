// Dev-only preview of the signed-in app with a fake board, for desktop and phone screenshots:
// web/preview/desktop.html?tab=cards|progress|chat|more (an old id lands where its page went)[&page=<menu page>][&task=<Plan row id>][&v4=1][&late=1][&top5=1[&newcard=1][&offline=1|net]][&clear=1[&wait=1]][&updates=only|none][&top=<need id>][&long=1][&conversation=<id> | &new=1][&tap=<n>][&mac=off][&pictured=1][&gotit=1][&quiet=1][&usage=near]
// (the Chat tab opens on the conversation list, that conversation, or a new one; Media's fixtures and `tap` are in
// media.preview.ts). Clips and stills load from /media/<sha256>; a recording script serves them. Nothing imports this
// from the app, so the production build leaves it out.
import "../styles.css";

import { isUpdate } from "../../../src/shared/answers.js";
import type { Ask } from "../../../src/shared/asks.js";
import { boardSchema, type Reply } from "../../../src/shared/board.js";
import type { ChatMessage } from "../../../src/shared/command.js";
import {
  countsUnread,
  IDLE_ARCHIVE_MS,
  ownsNoCard,
  SEED_IDS,
  TEAM_ROOM_ID,
  UPDATES_ID,
  type ConversationAction,
  type ConversationDetail,
  type ConversationsResponse,
  type ConversationSummary,
  type MergeResponse,
} from "../../../src/shared/conversations.js";
import type { ClaudeUsageSnapshot, GithubSnapshot, PullRequest, TimelineEvent } from "../../../src/shared/ops.js";
import { opsStatusKey } from "../../../src/shared/ops-status-key.js";
import type { BacklogIssueResponse, BacklogResponse, IssueDetail } from "../../../src/shared/backlog.js";
import type { SchedulesResponse } from "../../../src/shared/schedules.js";
import type { SearchItem } from "../../../src/shared/search.js";
import type { ThreadSummary } from "../../../src/shared/threads.js";
import { summarize } from "../../../src/shared/summary.js";
import type { Worker, WorkersResponse } from "../../../src/shared/workers.js";
import { buildOps } from "../../../src/server/ops/view.js";
import { showRivetWords } from "../rivet-words.js";
import { app, changed, go, networkChanged, refresh } from "../state.js";
import { openBacklog } from "./backlog-sheet.js";
import { planState } from "./ops-plan.js";
import { takeShare } from "../share-target.js";
import { receiveShare, showConversation, startDraft } from "./chat.js";
import { drawnClip, drawnStill, drawPreviewMedia, gameStill, previewMediaFile, previewMediaPage, tapPreviewThumb } from "./media.preview.js";
import { answeredRoute } from "./answered.preview.js";
import { mindPreview } from "./mind.preview.js";
import { mountShell } from "./shell.js";

const now = new Date();
/** `mac=off`: the bridge reads offline (read once: the app rewrites the address as it moves). */
const MAC_OFF = new URLSearchParams(location.search).get("mac") === "off";
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
// ?chip=1: Claude's week on Usage, resetting on the next Friday.
const friday = new Date(now.getTime() + ((12 - now.getDay()) % 7) * 86_400_000).toISOString();
const weekLimit = (percent: number, severity: "normal" | "warning"): ClaudeUsageSnapshot => ({
  at: ago(1),
  limits: [{ kind: "weekly_all", label: "This week", percent, severity, resetsAt: friday, active: true }],
});
// ?usage=near: the week near its cap, as the Floor's line names it.
const NEAR = new URLSearchParams(location.search).get("usage") === "near";
const CHIP: ClaudeUsageSnapshot | null = NEAR ? weekLimit(92, "warning") : new URLSearchParams(location.search).get("chip") === "1" ? weekLimit(30, "normal") : null;
const sha = (c: string) => c.repeat(64);
const REPO = "example-org/example-repo";
const OTHER_REPO = "example-org/other-repo";
const THIRD_REPO = "example-org/third-repo";
const FOURTH_REPO = "example-org/fourth-repo";
const pr = (n: number) => `https://github.com/${REPO}/pull/${n}`;

/** GET /api/asks: one of each row Your asks draws, times relative to `now`. */
const ask = (id: string, words: string, minutes: number, over: Partial<Ask>): Ask => ({
  id,
  words,
  who: "owner",
  stage: "queued",
  prs: [],
  dueHistory: [],
  timeline: [],
  createdAt: ago(minutes),
  stageAt: ago(minutes),
  updatedAt: ago(minutes),
  version: 1,
  ...over,
});
const asks: Ask[] = [
  ask("toolbar-row", "Toolbar on one row on the phone", 20, { stage: "building", chat: "toolbar-one-row", repo: REPO, prs: [655], progress: 0.6, dueAt: ago(-40) }),
  ask("loading-animation", "Loading animation: which of the two?", 35, { stage: "needs-you", cardId: "loading-animation", chat: "tap-hint-glow", repo: REPO }),
  ask("smooth-scroll", "Smoother scroll on long lists", 50, { stage: "review", chat: "smooth-scroll", repo: REPO, prs: [648], dueAt: ago(-70), dueHistory: [{ at: ago(30), dueAt: ago(-70), was: ago(10), why: "tests were red" }] }),
  ask("sidebar-polish", "Sidebar polish, round two", 90, {
    stage: "building",
    chat: "sidebar-polish-r2",
    repo: REPO,
    progress: 0.3,
    dueAt: ago(-150),
    dueHistory: [
      { at: ago(80), dueAt: ago(20), was: ago(40), why: "assets late" },
      { at: ago(15), dueAt: ago(-150), was: ago(20), why: "review queue" },
    ],
  }),
  ask("sign-in-retry", "Sign-in retry catches a late reply", 120, { stage: "building", chat: "sign-in-retry", repo: REPO, dueAt: ago(25), askedForTimeAt: ago(10), progress: 0.8 }),
  ask("sort-newest", "Lists: newest first", 150, { stage: "queued" }),
  ask("dashboard-numbers", "Dashboard: bigger numbers", 180, { stage: "building", chat: "dashboard-numbers", repo: REPO, dueAt: ago(-90) }),
  ask("pickup-ci", "Main build tests failing", 40, { who: "rivet", source: "pickup:ci/main", stage: "building", chat: "fix-main-build", repo: REPO, dueAt: ago(-30) }),
  ask("split-view", "Split view keeps a refused drag", 300, { stage: "done", prs: [653], chat: "split-view-drag", repo: REPO, stageAt: ago(45) }),
  ask("tabs-newest", "Dashboard shows the newest row in every tab", 400, { stage: "shipped", prs: [630], stageAt: ago(15) }),
];

const board = boardSchema.parse({
  updatedAt: ago(2),
  needs: [
    {
      id: "sidebar-shortcuts",
      kind: "approval",
      title: "Sidebar: keyboard shortcuts panel",
      ask: "Card D. A key button next to Customise opens the shortcuts: a Common list plus one for each of the 12 pages, with All, Editing and Navigation, and Today, This Week and All Time.",
      chat: "sidebar-polish-r2",
      since: ago(1),
      media: { kind: "stills", stills: [{ sha256: sha("1"), type: "image/png" }, { sha256: sha("2"), type: "image/png" }] },
    },
    {
      id: "long-title",
      kind: "approval",
      title: "Search, Reports and Settings: the shared toolbar keeps SAVE, the undo and the auto-save toggle on one row on every phone",
      ask: "One row on every phone, down to the narrowest; nothing wraps under the title.",
      chat: "toolbar-one-row",
      pr: 480,
      since: ago(6),
      media: { kind: "stills", stills: [{ sha256: sha("3"), type: "image/png" }] },
    },
    {
      id: "smooth-scroll",
      kind: "approval",
      title: "Lists: TOP scrolls in one motion",
      ask: "Picking TOP now starts the scroll at once, so the list glides past the middle section in one clean, satisfying motion instead of jumping late. The data stays server-side; this is the animation only.",
      chat: "smooth-scroll",
      pr: 462,
      since: ago(48),
      links: [
        { label: "Before / after video", url: pr(462), primary: true },
        { label: "PR #462", url: pr(462) },
        { label: "github.com/example-org/example-repo/actions/runs/18611190633/job/53070123456", url: `https://github.com/${REPO}/actions/runs/18611190633/job/53070123456` },
      ],
      media: {
        kind: "before-after",
        before: { sha256: sha("a"), type: "video/mp4" },
        after: { sha256: sha("b"), type: "video/mp4" },
        stills: [
          { sha256: sha("c"), type: "image/jpeg" },
          { sha256: sha("d"), type: "image/jpeg" },
          { sha256: sha("e"), type: "image/jpeg" },
        ],
      },
    },
    {
      id: "tap-hint-glow",
      kind: "approval",
      title: "Search and Settings: the tap hint glows instead of blinking",
      ask: "The hint under the thumb now breathes in and out rather than flashing. Same timing, softer on the eye.",
      chat: "tap-hint-glow",
      pr: 471,
      since: ago(25),
      media: {
        kind: "before-after",
        before: { sha256: drawnClip("f1".repeat(32), "Blink", 200), type: "video/webm" },
        after: { sha256: drawnClip("f2".repeat(32), "Glow", 140), type: "video/webm" },
      },
    },
    {
      id: "sign-in-retry",
      kind: "decision",
      title: "Sign-in retry queue: how long before a stuck request is dropped?",
      ask: "A sign-in the provider never confirmed sits in the retry queue. After how long should the worker give up and ask the person to try again?",
      chat: "sign-in-retry",
      pr: 440,
      risk: "auth",
      since: ago(190),
      media: {
        kind: "files",
        files: [{ sha256: "9".repeat(64), type: "application/pdf", name: "Retry window notes.pdf", bytes: 482_000 }],
      },
      options: [
        { label: "5 minutes", short: "5 min", detail: "Fastest for people; more manual follow-up" },
        { label: "15 minutes", short: "15 min", recommended: true, detail: "Matches the provider's own retry window" },
        { label: "1 hour", short: "1 hour", detail: "Fewest drops, slowest for people" },
      ],
    },
    {
      id: "github-sweep",
      kind: "approval",
      title: "GitHub sweep: file the top six suggestions as issues?",
      ask: "The read-only sweep of agent orchestration, memory and supervision projects is done; the report is attached.",
      chat: "rivet",
      since: ago(40),
      media: { kind: "files", files: [{ sha256: sha("8"), type: "application/pdf", name: "GitHub sweep.pdf", bytes: 471_000 }] },
    },
    {
      id: "audit-checklist-file",
      kind: "outcome",
      title: "Audit checklist (file)",
      ask: "The checklist is attached as a file, so you can share it.\n• Audit-checklist.md: 74 card checks, 29 design checks, 36 feel checks.\n• Paste it into an agent and ask it to start with the audit.",
      since: ago(2),
      media: {
        kind: "stills",
        stills: [{ sha256: drawnStill(sha("6"), "Before / after", 20, 2400, 1140), type: "image/png" }],
        files: [{ sha256: sha("7"), type: "text/markdown", name: "Audit-checklist.md", bytes: 40_257 }],
      },
    },
    {
      id: "sound-pass",
      kind: "approval",
      title: "Notifications: the v2 sound pass",
      ask: `Three clips: the ping, the alert and the done chime. The run that made them: https://github.com/${REPO}/actions/runs/18234567890/job/52012345678`,
      chat: "notification-sounds",
      since: ago(9),
      media: {
        kind: "audio",
        clips: [
          { sha256: sha("4"), type: "audio/mpeg", label: "Ping" },
          { sha256: sha("5"), type: "audio/mpeg", label: "Alert" },
          { sha256: sha("6"), type: "audio/mp4", label: "Done chime" },
        ],
      },
    },
    {
      id: "intro-clip",
      kind: "approval",
      title: "Welcome tour: the new intro clip",
      ask: "Eight seconds, from the first tap to the home screen.",
      chat: "welcome-tour",
      since: ago(11),
      media: { kind: "video", after: { sha256: drawnClip("5c".repeat(32), "Welcome tour", 190, 1920, 1080), type: "video/webm" } },
    },
    {
      id: "overnight-run-notes",
      kind: "approval",
      title: "Import job: keep the overnight schedule?",
      ask: "Notes, the raw log and the summary from last night's run. Nothing failed; two rows retried once.",
      chat: "import-job",
      since: ago(15),
      media: {
        kind: "files",
        files: [
          { sha256: sha("1"), type: "text/markdown", name: "Overnight run notes.md", bytes: 951 },
          { sha256: sha("2"), type: "text/plain", name: "import-run.log", bytes: 56_073 },
          { sha256: sha("3"), type: "application/json", name: "summary.json", bytes: 330 },
          { sha256: sha("4"), type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", name: "Row export.xlsx", bytes: 18_400 },
        ],
      },
    },
    {
      id: "loading-animation",
      kind: "decision",
      title: "Loading animation: which one?",
      chat: "loading-animation",
      since: ago(12),
      options: [
        { label: "Bounce", short: "Bounce", detail: "A soft hop every two seconds" },
        { label: "Sway", short: "Sway", detail: "Leans side to side, then settles" },
        { label: "Pulse and fade", short: "Pulse", detail: "Pulses, then a slow fade" },
        { label: "Keep today's", short: "Keep" },
      ],
    },
    {
      id: "mascot-name",
      kind: "question",
      reply: "text",
      title: "What should the mascot be called?",
      ask: "The welcome banner needs a name for its mascot. Anything short works.",
      chat: "welcome-banner",
      since: ago(6),
    },
    {
      // Three shorts at the card format's 40 characters: the bar's buttons wrap them whole (feed-option-text.mjs).
      id: "open-sign-up",
      kind: "decision",
      title: "Sign-up: who can make an account?",
      ask: "Invites work end to end. Open sign-up needs rate limits and spam checks first.",
      chat: "sign-up",
      // The oldest card, so a phone opens it once the risky one is put as Later.
      since: ago(600),
      options: [
        { label: "Yes", short: "Ship it now: invited people only for now", recommended: true },
        { label: "Plan open sign-up", short: "Plan letting anyone sign up on their own" },
        { label: "Both", short: "Ship this first, then plan open sign-ups" },
      ],
    },
    {
      // Last, so the other cards keep their indexes (their revs); next oldest after open-sign-up, so a phone opens it
      // once that one is put as Later too.
      id: "touch-guard-merge",
      kind: "merge-ready",
      title: "Touch action guard: ready to merge",
      ask: "Gate clean on the head you saw. Merge lands it on main.",
      chat: "touch-guard",
      pr: 105,
      headSha: "b".repeat(40),
      since: ago(599),
    },
    {
      // Last, so no other card's index (its rev, which scripts seed Later with) moves.
      id: "coming-chips",
      kind: "decision",
      title: "Coming: hide the five filter chips until there are 8+ rows?",
      chat: "rivet-coming",
      since: ago(12),
      options: [
        { label: "Yes, one list under 8 rows", short: "Yes", recommended: true },
        { label: "Keep the chips", short: "Keep" },
      ],
    },
    // Update cards, after every question card so none of their revs move.
    {
      id: "upd-reports-deployed",
      kind: "update",
      thread: "Reports page",
      tag: "Merged · Deployed",
      title: "Reports page: new charts and filters",
      ask: "Merged and deployed. Deploy checked: marker found in the bundle.",
      pr: 402,
      chat: "reports-page",
      since: ago(4),
      media: { kind: "stills", stills: [{ sha256: drawnStill(sha("9"), "Reports page", 38), type: "image/png" }] },
    },
    {
      id: "upd-reports-merged",
      kind: "update",
      thread: "Reports page",
      tag: "Merged",
      title: "#402 merged: new charts and filters",
      ask: "Gate clean, 3 lenses, no findings left.",
      pr: 402,
      since: ago(11),
    },
    {
      id: "upd-reports-red",
      kind: "update",
      thread: "Reports page",
      tag: "Red fixed",
      title: "Visual QA red on #402 fixed",
      ask: "The load-time check tripped on the charts; images halved, now under a second on a phone.",
      since: ago(38),
      comments: [
        { from: "owner", text: "charts look a bit flat", at: ago(30) },
        { from: "rivet", text: "Got it, the colour pass is in #424, card when it lands", at: ago(28) },
      ],
    },
    {
      id: "upd-reports-chat",
      kind: "update",
      thread: "Reports page",
      tag: "Chat finished",
      title: "reports-page closed",
      ask: "Charts and filters done; the colour pass moved to #424.",
      since: ago(120),
      seen: true,
    },
    {
      id: "upd-main-red",
      kind: "update",
      thread: "main",
      tag: "Red",
      title: "Main red: lockfile drift",
      ask: "package-lock.json out of step after #419; fixing in #423.",
      since: ago(34),
    },
    {
      id: "upd-main-green",
      kind: "update",
      thread: "main",
      tag: "Red fixed",
      title: "Main green again",
      ask: "Lockfile drift from #419; fixed in #423, merged.",
      since: ago(22),
      comments: [
        { from: "owner", text: "what broke it?", at: ago(20) },
        { from: "rivet", text: "Got it, the lockfile from #419; #423 pins it", at: ago(18) },
      ],
    },
    {
      id: "upd-admin-page",
      kind: "update",
      thread: "Admin page",
      tag: "Chat finished",
      title: "Search box shipped (#411)",
      ask: "Deployed to the admin page, checked.",
      since: ago(61),
    },
    // Seen ones stay a week for the Updates stream; the Feed leaves them out.
    { id: "upd-nightly", kind: "update", thread: "Nightly", tag: "Nightly", title: "6 PRs merged, main green, every deploy checked", since: ago(420), seen: true },
    { id: "upd-schedules", kind: "update", thread: "Schedules", tag: "Schedules", title: "The 09:00 sweep ran clean", since: ago(480), seen: true },
    { id: "upd-rivet", kind: "update", thread: "Rivet Agents", tag: "Deployed", title: "Ops back on the bottom bar", since: ago(1560), seen: true },
    // Posted into Saved views (one conversation per thing), last so no other card's rev moves.
    { id: "upd-views-merged", kind: "update", thread: "Saved views", tag: "Merged", title: "#493 merged: saved views per team", ask: "Gate clean, 3 lenses; deploying next.", pr: 493, since: ago(25), seen: true },
  ],
  coming: [
    { pr: 248, title: "Reports: totals row after the table", app: "Reports", what: "Totals row after the table", stage: "review", etaMinutes: 20, updatedAt: ago(4) },
    { pr: 283, title: "Notifications v2 sound pass", app: "Notifications", what: "v2 sound pass", stage: "owner-ok", etaMinutes: 45 },
    { pr: 288, title: "Loading animation", app: "Loading", what: "Animation v6 on every page", stage: "building", progress: 0.1, etaMinutes: 90 },
    { pr: 290, title: "Row drag and drop", app: "Lists", what: "Drag to reorder and drop to file", stage: "deploying", etaMinutes: 6, updatedAt: ago(1) },
    { pr: 276, title: "Welcome banner mascot", app: "Welcome", what: "Stylised mascot and backdrop", stage: "shipped" },
    { title: "Admin export switch (title only, the old shape)" },
  ],
  chats: [
    { name: "reports-totals", state: "working", doing: "Totals row under the table", prs: [248] },
    { name: "loading-animation", state: "waiting", doing: "Loading animation v6 for review" },
    // Gone (no running chat) and untouched for 2 h: off the Feed's Chats list, still in Search.
    { name: "photo-carousel", state: "working", doing: "Photo carousel", touchedAt: ago(120) },
    { name: "welcome-banner", state: "idle" },
  ],
  shipped: [
    { pr: 296, title: "Rivet Agents: push-board refuses clips recorded in the top-left corner", deployed: true },
    { pr: 295, title: "Admin: no iOS zoom on search", deployed: "partial", deployedNote: "2 of 3 machines" },
  ],
});
// ?pictured=1: a pictured decision with three options on an agent's chat, first on the deck (the Decide sheet's stills).
if (new URLSearchParams(location.search).get("pictured") === "1")
  board.needs.unshift({
    id: "done-pop",
    kind: "decision",
    title: "Dashboard: which done pop?",
    ask: "Three stills from the test build. One goes out tonight.",
    chat: "dashboard-numbers",
    since: ago(8),
    media: { kind: "stills", stills: [{ sha256: gameStill("b1".repeat(32), "Glow", 48), type: "image/png" }, { sha256: gameStill("b2".repeat(32), "Bounce", 200), type: "image/png" }, { sha256: gameStill("b3".repeat(32), "Keep", 280), type: "image/png" }] },
    options: [
      { label: "Glow", short: "Glow", recommended: true, detail: "Gold halo, 400 ms" },
      { label: "Bounce", short: "Bounce", detail: "Two hops, no halo" },
      { label: "Keep as is", short: "Keep", detail: "No change this week" },
    ],
  } as (typeof board.needs)[number]);

// The pictured map as a normal evening's: two agents hold a decision (the pictured one and the late sign-in retry) and
// the others' cards are news, so the ? stays a focus and not a mark on every seat.
if (new URLSearchParams(location.search).get("pictured") === "1")
  for (const one of board.needs)
    if (["sidebar-polish-r2", "toolbar-one-row", "smooth-scroll", "tap-hint-glow"].includes(one.chat ?? ""))
      Object.assign(one, { kind: "update", options: undefined });

const workers: WorkersResponse = {
  at: now.toISOString(),
  workers: [
    { id: "wt::h", name: "Rivet", repo: REPO, chat: "rivet", state: "working", lastOutputAt: now.getTime() - 5_000, rivet: true },
    // The chats at work are the asks' chats, so each desk's bubble can be read against its row in Your asks.
    { id: "wt::a", name: "sidebar-polish-r2", repo: REPO, chat: "sidebar-polish-r2", state: "working", lastOutputAt: now.getTime() - 30_000 },
    { id: "wt::e", name: "sign-in-retry", repo: REPO, chat: "sign-in-retry", state: "working", lastOutputAt: now.getTime() - 50_000 },
    { id: "wt::b", name: "tap-hint-glow", repo: REPO, chat: "tap-hint-glow", state: "waiting", lastOutputAt: now.getTime() - 400_000 },
    { id: "wt::f", name: "toolbar-one-row", repo: REPO, chat: "toolbar-one-row", state: "working", lastOutputAt: now.getTime() - 40_000 },
    { id: "wt::c", name: "Sam", repo: REPO, chat: "smooth-scroll", state: "working", lastOutputAt: now.getTime() - 60_000, needsYou: true },
    { id: "wt::g", name: "dashboard-numbers", repo: REPO, chat: "dashboard-numbers", state: "working", lastOutputAt: now.getTime() - 70_000 },
    { id: "wt::d", name: "welcome-banner", repo: REPO, chat: "welcome-banner", state: "idle", lastOutputAt: now.getTime() - 900_000 },
  ] as WorkersResponse["workers"],
};
// ?crew=live: a crew shaped like a normal afternoon's (most chats in one repo, a few elsewhere, what / % / ETA typed by
// Rivet), for desk stills.
if (new URLSearchParams(location.search).get("crew") === "live") {
  const at = (minutes: number) => now.getTime() - minutes * 60_000;
  const crew: [string, string, string, Worker["state"], number, Partial<Worker>][] = [
    ["image-pass", REPO, "image-pass", "working", 0.2, { what: "Image compression pass", progress: 0.6, etaMinutes: 25 }],
    ["infra-ci", REPO, "infra-ci", "working", 1, { what: "Build image refresh", progress: 0.3, etaMinutes: 50, prs: [421], delivering: { pr: 421, title: "Build image refresh", stage: "review" } }],
    ["Sam", REPO, "export-review", "working", 0.5, { what: "Reviewing the export PR", progress: 0.8, etaMinutes: 10, prs: [419] }],
    ["loading-art", REPO, "loading-art", "working", 2, { what: "Loading animation art", progress: 0.45, etaMinutes: 40, stage: "Checking it on a phone" }],
    ["reports-totals", REPO, "reports-totals", "waiting", 30, { what: "Totals row video", progress: 0.9, etaMinutes: 5 }],
    ["docs-site", OTHER_REPO, "docs-site", "working", 1, { what: "Docs site update", progress: 0.7, etaMinutes: 15, delivering: { title: "Docs site", stage: "deploying" } }],
    ["csv-export", OTHER_REPO, "csv-export", "working", 0.8, { what: "CSV export", progress: 0.35, etaMinutes: 45, needsYou: true }],
    ["sandbox", THIRD_REPO, "sandbox", "idle", 40, {}],
    ["feed-retries", FOURTH_REPO, "feed-retries", "working", 3, { what: "Feed retries", progress: 0.5, etaMinutes: 30 }],
  ];
  crew.forEach(([name, repo, chat, state, minutes, extra], i) =>
    workers.workers.push({ id: `wt::l${i}`, name, repo, chat, state, lastOutputAt: at(minutes), ...extra } as WorkersResponse["workers"][number]),
  );
  // Ops' timeline for the desks' bubbles and cheer: a merge from earlier, read 1.5 s after load (no cheer: old news), and
  // the export chat's PR merging 7 s after load (&cheer=<ms> after the first read moves it) (Rivet cheers, the chat hops).
  const merges: TimelineEvent[] = [{ kind: "merged", at: new Date(at(40)).toISOString(), repo: "example-repo", title: "Loading art: the first loop (#418)", number: 418 }];
  const readTimeline = () => void import("../ops-data.js").then(({ refreshOps }) => refreshOps());
  setTimeout(() => {
    const inner = window.fetch;
    window.fetch = (input, init) => (String(input) === "/api/ops/timeline" ? Promise.resolve(Response.json({ days: [{ day: "today", events: merges }], repos: [] })) : inner(input, init));
    readTimeline();
    setTimeout(() => {
      merges.unshift({ kind: "merged", at: new Date().toISOString(), repo: "example-repo", title: "Export: the review's three fixes (#419)", number: 419 });
      readTimeline();
    }, Number(new URLSearchParams(location.search).get("cheer") ?? 5_500));
  }, 1_500);
}
// ?crew=empty|one|eight|waiting: the desks with no agent, one, eight across four projects, and three with one waiting on you.
{
  const shape = new URLSearchParams(location.search).get("crew");
  const sizes: Record<string, number> = { empty: 0, one: 1, eight: 8, waiting: 3 };
  if (shape && shape in sizes) {
    const upd = ago(1);
    const jobs: [string, string, string, number, number][] = [
      [REPO, "settings-redesign", "Settings redesign from the new mocks", 0.4, 50],
      [OTHER_REPO, "docs-site-report", "Docs site report, phone and computer", 0.55, 35],
      [REPO, "layout-audit", "Phone layouts: one shape for all", 0.7, 20],
      [THIRD_REPO, "csv-export", "CSV export", 0.35, 45],
      [REPO, "infra-ci", "Build image refresh", 0.3, 50],
      [FOURTH_REPO, "feed-retries", "Feed retries", 0.5, 30],
      [REPO, "dashboard-chart-colours-and-the-long-legend-pass", "Dashboard: brighter chart colours and the long legend", 0.85, 10],
      [OTHER_REPO, "docs-release", "Docs site release", 0.7, 15],
    ];
    workers.workers = [
      { id: "wt::h", name: "Rivet", repo: REPO, chat: "rivet", state: "working", lastOutputAt: now.getTime(), rivet: true },
      ...jobs.slice(0, sizes[shape]).map(([repo, chat, what, progress, etaMinutes], i) => ({
        id: `wt::s${i}`, name: chat, repo, chat, state: shape === "waiting" && i === 1 ? "waiting" : "working", lastOutputAt: now.getTime() - 30_000, what, progress, etaMinutes, updatedAt: upd,
      })),
    ] as WorkersResponse["workers"];
  }
}
// ?crew=projects: projects each with their own box; &more=1 adds two more.
{
  const q = new URLSearchParams(location.search);
  if (q.get("crew") === "projects") {
    // [repo, chat, its ask's words, minutes until its time]
    const jobs: [string, string, string, number, string?][] = [
      [REPO, "reports-review", "Reports: review fixes", 95],
      [REPO, "header-icon", "Header: fix mirrored icon", 110],
      [REPO, "export-audit", "Export: fix audit fails", 80],
      [REPO, "search-plan", "Search: plan card by 8:30", 110],
      [REPO, "home-tidy", "Home: tidy and plan card", 80],
      [REPO, "rivet-projects-row", "Rivet: projects row comes back", 60],
      [REPO, "rivet-stages", "Rivet map: stages under each box", 90],
      [REPO, "docs-pages-plan", "Docs: 25 pages plan", 125, OTHER_REPO],
      [REPO, "docs-pacing-plan", "Docs: pacing plan", 140, OTHER_REPO],
      ...(q.get("more")
        ? ([
            [THIRD_REPO, "weekly-digest", "Feed: weekly digest", 170],
            [FOURTH_REPO, "store-listing", "Store listing copy", 200],
          ] as [string, string, string, number][])
        : []),
    ];
    workers.workers = [
      { id: "wt::h", name: "Rivet", repo: REPO, chat: "rivet", state: "working", lastOutputAt: now.getTime(), rivet: true },
      ...jobs.map(([repo, chat, what, , project], i) => ({ id: `wt::p${i}`, name: chat, repo, ...(project ? { project } : {}), chat, state: "working", lastOutputAt: now.getTime() - 30_000, what, stage: "Building" })),
    ] as WorkersResponse["workers"];
    asks.push(...jobs.map(([repo, chat, words, due], i) => ask(`plan-${i}`, words, 20, { stage: "building", chat, repo: repo as Ask["repo"], dueAt: ago(-due) })));
  }
}
// ?crew=crowded: the crew above and forty more chats at work, so the map ends on its "N more ›" row.
if (new URLSearchParams(location.search).get("crew") === "crowded") {
  const jobs: [string, string, string][] = [
    [REPO, "settings-redesign", "Settings redesign from the new mocks"],
    [OTHER_REPO, "docs-site-report", "Docs site report, phone and computer"],
    [REPO, "layout-audit", "Phone layouts: one shape for all"],
    [THIRD_REPO, "csv-export", "CSV export"],
    [REPO, "infra-ci", "Build image refresh"],
    [FOURTH_REPO, "feed-retries", "Feed retries"],
    [REPO, "dashboard-chart-colours", "Dashboard: brighter chart colours and the long legend"],
    [OTHER_REPO, "docs-release", "Docs site release"],
    [REPO, "row-drag", "Lists: name the drag handle"],
    [THIRD_REPO, "sandbox-sounds", "Sandbox sound pass"],
  ];
  jobs.forEach(([repo, chat, what], i) =>
    workers.workers.push({ id: `wt::m${i}`, name: chat, repo, chat, state: "working", lastOutputAt: now.getTime() - 30_000, what } as WorkersResponse["workers"][number]),
  );
  for (let i = 0; i < 30; i++) workers.workers.push({ id: `wt::n${i}`, name: `extra-${i}`, repo: REPO, chat: `extra-${i}`, state: "working", lastOutputAt: now.getTime() - 30_000, what: `Extra chat ${i + 1}` });
}
// ?crew=under-way: 25 rows across three boxes, every stage, through what the phone reads: workers, asks, the push queue,
// Ops' PRs and the timeline. ?crew=under-way-few: five of them, on a roomy map.
const UNDER_WAY = new URLSearchParams(location.search).get("crew");
const underWayEvents: TimelineEvent[] = [];
let underWayGithub: GithubSnapshot | null = null;
if (UNDER_WAY === "under-way" || UNDER_WAY === "under-way-few") {
  const few = UNDER_WAY === "under-way-few";
  const pull = (number: number, title: string, over: Partial<PullRequest> = {}): PullRequest => ({
    repo: REPO,
    number,
    title,
    url: `https://github.com/${REPO}/pull/${number}`,
    draft: false,
    author: "sam",
    labels: [],
    headAt: ago(40),
    updatedAt: ago(5),
    checks: { state: "pass", passed: 12, failed: 0, pending: 0, failing: [] },
    ...over,
  });
  // A chat, its words, its stage, minutes to its promise, its repo, whether it is at work, and any PRs its ask names.
  const chats: { chat: string; words: string; stage: Ask["stage"]; due?: number; repo?: WorkersResponse["workers"][number]["repo"]; idle?: true; prs?: number[]; few?: true }[] = [
    { chat: "window-pick", words: "Window layout pick", stage: "needs-you", idle: true, few: true },
    { chat: "search-filters", words: "Search: filters", stage: "deploying", idle: true, prs: [299], few: true },
    { chat: "upload-route", words: "Uploads: route fix", stage: "review", due: 75, prs: [318], few: true },
    { chat: "home-tidy", words: "Home: tidy and plan", stage: "review", due: 60, idle: true },
    { chat: "multi-select", words: "Lists: multi select", stage: "push-queue", due: 25, few: true },
    { chat: "release-helper", words: "Release helper changes", stage: "push-queue", due: 180 },
    { chat: "message-not-sent", words: "Rivet: message not sent", stage: "push-queue", due: 50 },
    { chat: "back-to-chats", words: "Rivet: back to chats view", stage: "push-queue", due: 40 },
    { chat: "report-split", words: "Report split", stage: "push-queue", due: 70, idle: true },
    { chat: "old-code-removal", words: "Old code removal: stages 2, 3", stage: "building", due: 110, few: true },
    { chat: "empty-states", words: "Reports: empty states", stage: "building", due: 230 },
    { chat: "keep-chats-in-view", words: "Map: keep chats in view", stage: "building", due: 35 },
    { chat: "icon-set", words: "Icons: the new set", stage: "building", due: 65 },
    { chat: "file-nine-bugs", words: "Reports: file 9 bugs", stage: "building", due: 170 },
    { chat: "pricing-page", words: "Pricing page", stage: "building", due: 290 },
    { chat: "docs-nav", words: "Docs: nav and search", stage: "push-queue", due: 70, repo: OTHER_REPO },
    { chat: "docs-final", words: "Docs: final pages", stage: "building", due: 150, repo: OTHER_REPO },
    { chat: "sandbox-notes", words: "my sandbox notes", stage: "push-queue", due: 150, repo: THIRD_REPO },
  ];
  const seated = chats.filter((one) => !few || one.few);
  workers.workers = [
    ...workers.workers.filter((w) => w.rivet),
    ...seated.map(({ chat, repo = REPO, idle }) => ({ id: `wt::${chat}`, name: chat, repo, chat, state: idle ? ("idle" as const) : ("working" as const), lastOutputAt: now.getTime() - 30_000 })),
  ];
  asks.splice(
    0,
    asks.length,
    ...seated.map(({ chat, words, stage, due, repo = REPO, prs = [] }) =>
      ask(chat, words, 90, { stage, chat, repo, prs, ...(due !== undefined ? { dueAt: ago(-due) } : {}), ...(stage === "needs-you" ? { cardId: chat } : {}) }),
    ),
  );
  board.needs.splice(0, board.needs.length, { id: "window-pick", kind: "approval", title: "Window layout pick", ask: "Which layout goes first?", chat: "window-pick", since: ago(4) } as (typeof board.needs)[number]);
  workers.pushQueue = (
    [
      ["dependency-prs", REPO],
      ["browser-guard", REPO, 303],
      ["multi-select", REPO],
      ["release-helper", REPO],
      ["message-not-sent", REPO],
      ["back-to-chats", REPO],
      ["report-split", REPO],
      ["docs-nav", OTHER_REPO],
      ["sandbox-notes", THIRD_REPO],
      ["rivet-handles-by-itself", REPO],
    ] as const
  ).flatMap(([chat, repo, pr], i) => (!few || chat === "multi-select" ? [{ chat, repo, position: i + 1, at: now.getTime() - 60_000 * (40 - i), ...(pr ? { pr } : {}) }] : []));
  if (!few) workers.workers.push({ id: "wt::dependency-prs", name: "dependency-prs", repo: REPO, chat: "dependency-prs", state: "idle", lastOutputAt: now.getTime() - 300_000, what: "Dependency PRs run their own" });
  underWayGithub = {
    at: now.toISOString(),
    prsComplete: true,
    prs: few
      ? [pull(318, "Uploads: the upload routes get size limits", { ciStartedAt: ago(20) })]
      : [
          pull(318, "Uploads: the upload routes get size limits", { ciStartedAt: ago(20) }),
          pull(302, "Browser retry", { ciStartedAt: ago(30) }),
          pull(290, "Paid plan page", { ciStartedAt: ago(45) }),
          pull(317, "Queue drain", { ciStartedAt: ago(35), checks: { state: "fail", passed: 10, failed: 2, pending: 0, failing: ["CI complete"] } }),
          pull(303, "Browser guard", { branch: "browser-guard" }),
          pull(100, "Someone else's PR, on no row", { author: "someone-else" }),
          pull(101, "A draft, on no row", { draft: true }),
        ],
    runs: [],
    runners: null,
    queue: null,
    merged: [],
    sources: null,
  };
  const merge = (minutes: number, number: number, title: string): TimelineEvent => ({ kind: "merged", at: ago(minutes), repo: "example-repo", title: `${title} (#${number})`, number });
  underWayEvents.push(merge(14, 299, "Search: filters"), ...(few ? [] : [merge(11, 305, "Docs: link check")]));
}
// Search's history and one failing schedule, as ops.preview.ts has them.
const history: SearchItem[] = [
  { kind: "briefing", key: "briefing:old", title: "Evening briefing", detail: "Search down 12 minutes", at: ago(2900), open: { type: "tab", tab: "agents" } },
];
const schedules: SchedulesResponse = {
  at: ago(1),
  stale: false,
  sources: [{ source: "github", ok: true, at: ago(1) }],
  items: [
    {
      id: `github:${REPO}/link-check.yml`,
      source: "github",
      name: "Link check",
      what: "Checks every link in the docs",
      when: "Every 30 minutes",
      group: "all-day",
      on: true,
      lastRun: { at: ago(12), result: "failed", note: "link check timed out", url: `https://github.com/${REPO}/actions/runs/1` },
      runs: [{ id: "1", at: ago(12), result: "failed" }, { id: "0", at: ago(42), result: "failed" }],
      nextRun: ago(-18),
      toggle: { can: true },
    },
  ],
};

// ?fix=open: Start it on "Admin export switch" opened its chat through `rivet fix coming <key>`, and it has started work.
const FIX_OPEN = new URLSearchParams(location.search).get("fix") === "open";
const fixKey = opsStatusKey("coming", "Admin export switch (title only, the old shape)");
// ?parked=backlog|parked|ready: PR 595, red for three hours on one push, with a status record: a draft on backlog, a
// draft parked, or the parked record on a PR marked ready.
const PARKED = new URLSearchParams(location.search).get("parked");
const parkedGithub: GithubSnapshot | null = PARKED
  ? {
      at: now.toISOString(),
      prsComplete: true,
      prs: [
        {
          repo: REPO,
          number: 595,
          title: "Reports: reads like the old table. Five columns of five rows, tap a column to sort it, tap SAVE to keep the view",
          url: `https://github.com/${REPO}/pull/595`,
          draft: PARKED !== "ready",
          author: "sam",
          labels: [],
          headAt: ago(180),
          updatedAt: ago(170),
          branch: "sam/reports-table",
          checks: { state: "fail", passed: 30, failed: 1, pending: 0, failing: ["reports tests"] },
        },
      ],
      runs: [],
      runners: null,
      queue: null,
      merged: [],
      sources: null,
    }
  : null;
// The parked PR alone: the link check passes.
if (PARKED) schedules.items = schedules.items.map((item) => ({ ...item, lastRun: item.lastRun && { ...item.lastRun, result: "ok" as const, note: undefined }, runs: item.runs?.map((run) => ({ ...run, result: "ok" as const })) }));
const parkedStatus = PARKED ? [{ kind: "pr", key: "595", state: PARKED === "backlog" ? "backlog" : "parked", by: "Rivet", since: ago(180), updatedAt: ago(60), version: 1 }] : [];
// ?late=1: Rivet's own late rows, three records an agent is on: a time moved once, moved twice, and one passed with no new
// time. Each carries the old `lateSince` beside `askedForTimeAt` and `dueHistory`, so trees from before and after the
// server kept the times read the same seed.
const LATE = new URLSearchParams(location.search).get("late") === "1";
const lateStatus = LATE
  ? [
      { kind: "schedule", key: "nightly-link-sweep", state: "in-progress", by: "Rivet", since: ago(90), updatedAt: ago(15), version: 3, dueAt: ago(-40), lateSince: ago(20), askedForTimeAt: ago(20), dueHistory: [{ at: ago(15), dueAt: ago(-40), was: ago(20), why: "tests were red" }] },
      {
        kind: "schedule",
        key: "home-stills-refresh",
        state: "in-progress",
        by: "Rivet",
        since: ago(120),
        updatedAt: ago(20),
        version: 4,
        dueAt: ago(-90),
        lateSince: ago(60),
        askedForTimeAt: ago(25),
        dueHistory: [
          { at: ago(55), dueAt: ago(25), was: ago(60), why: "assets late" },
          { at: ago(20), dueAt: ago(-90), was: ago(25), why: "review queue" },
        ],
      },
      { kind: "schedule", key: "copy-sweep", state: "investigating", by: "Rivet", since: ago(70), updatedAt: ago(28), version: 2, dueAt: ago(30), lateSince: ago(30), askedForTimeAt: ago(28) },
    ]
  : [];
if (FIX_OPEN)
  workers.workers.push({ id: "wt::f", name: "fix-coming-admin-export", repo: REPO, chat: "fix-coming-admin-export", state: "working", lastOutputAt: now.getTime() - 8_000, doing: "Reading the admin export switch and its tests" } as WorkersResponse["workers"][number]);

// Conversations: rows as the server builds them from the messages below; Updates is pinned while it has anything unread.
const say = (id: string, conversation: string, text: string, at: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  from: "rivet",
  text,
  at: ago(at),
  threadId: conversation,
  ...extra,
});
const mine = (id: string, conversation: string, text: string, at: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  from: "owner",
  text,
  at: ago(at),
  status: "replied",
  threadId: conversation,
  ...extra,
});
const messages: ChatMessage[] = [
  say(UPDATES_ID, UPDATES_ID, "Updates from Rivet", 2000),
  say("u1", UPDATES_ID, "Nightly: 6 PRs merged, main green, every deploy verified.", 40),
  say("u2", UPDATES_ID, "Schedules: the 09:00 sweep ran clean.", 12),
  mine("k1", "k1", "Can we get the totals row after the table like Reports has?", 3 * 1440),
  say("k2", "k1", "On it. Chat reports-totals, PR #312 open.", 3 * 1440 - 2, { replyTo: "k1" }),
  mine("reply-k", "k1", "Approved: Reports totals row, merge?\nlooks good, ship it", 62, { card: "sidebar-shortcuts", status: "sent" }),
  say("k3", "k1", "Merged and shipped. Stills attached, ready for your OK on the next step.", 58),
  mine("k4", "k1", "Can the header use the blue from the logo?", 20, { ack: { text: "building it, ~9:45", at: ago(19) } }),
  mine("k6", "k1", "Comment: why is the header grey on the phone?", 12, { card: "sidebar-shortcuts", status: undefined, ack: { text: "replied below", at: ago(6) } }),
  say("k7", "k1", "The phone build missed the blue token; fixed in #420, deploying now.", 6, { replyTo: "k6", quote: { from: "owner", text: "Comment: why is the header grey on the phone?" } }),
  // One thing, one conversation: your ask, Rivet's ack, the decision card it posted, your answer, and the update card.
  mine("lp1", "lp1", "Saved views: can we share them per team?", 240, { ack: { text: "trying both ways, ~2:30", at: ago(239) } }),
  say("lp2", "lp1", "On it. Chat saved-views is trying both ways; I'll card you the choice here.", 236, { replyTo: "lp1" }),
  say("lp3", "lp1", "Saved views: one per team or one for all?", 120, {
    posted: { id: "saved-views-pick", kind: "decision", title: "Saved views: one per team or one for all?", ask: "Per team needs a small settings page; one for all ships today." },
  }),
  mine("lp4", "lp1", "Chose: One per team", 100, { card: "saved-views-pick", status: "sent" }),
  say("lp5", "lp1", "#493 merged: saved views per team", 25, {
    posted: { id: "upd-views-merged", kind: "update", title: "#493 merged: saved views per team", ask: "Gate clean, 3 lenses; deploying next." },
  }),
  mine("or1", "or1", "Charts on the dashboard need more colour", 1300),
  say("or2", "or1", "On it. The dashboard chat is making stills of brighter chart options; the plan card comes about 11:45pm. A recent change left the first series 40% grey, and that's one of the things the plan looks at.", 1298, { replyTo: "or1" }),
  mine("or3", "or1", "Chose: B: rainbow palette", 700),
  say("or4", "or1", "Dashboard rainbow palette video by about 8:45am.", 690),
  say("or5", "or1", "Dashboard: the rainbow palette, built", 420),
  mine("or6", "or1", "Chose: Yes, put it on the site", 400),
  say("or7", "or1", "Dashboard: rainbow palette is on the site", 365),
  mine("or8", "or1", "Chose: Yes, keep it", 3),
  mine("c1", "c1", "The thread view is hard to follow. Could the chat be a list of conversations?", 200),
  say("c2", "c1", "Design is on the issue with mockups. PR 1 is the server.", 190),
  mine("c3", "c1", "ok do the issue first", 180),
  mine("g1", "g1", "The enquiry form emails are failing again", 3000),
  say("g2", "g1", "Fixed and verified with a test enquiry.", 2900),
  mine("w1", "w1", "Add a weekly average line to the habit chart", 300),
  say("w2", "w1", "The 7-day line is drawn; the axis labels next.", 240),
  mine("m1", "m1", "Report tabs need their own colours", 500),
  say("m2", "m1", "Merged #390; deploying now.", 30),
  // A result sent as an update card: one line that opens it.
  say("m3", "m1", "Card: Reports page: new charts and filters ›", 4, { replyTo: "m1", card: "upd-reports-deployed" }),
  mine("x1", "x1", "Try a darker background on Settings", 900),
  say("x2", "x1", "Closed #387: you preferred the old background.", 400),
  mine("d1", "d1", "Bulk edit: 1–4 rows on one screen?", 90),
  say("d2", "d1", "The chat is drawing mocks in draft #421.", 20),
  mine("t1", "t1", "Bottom bar: Feed and Chat only", 700),
  say("t2", "t1", "Merged, deployed and verified. Done.", 15),
  // Merged and quiet for hours: idle, so under Archived.
  mine("s1", "s1", "Notifications v2 needs a proper sound pass", 1500),
  say("s2", "s1", "Merged #283 and deployed; the new chime is on the site.", 660),
  mine("r1", "r1", "Welcome banner: a stylised mascot, not the capsule", 2600),
  say("r2", "r1", "Merged #276. Mascot and backdrop are on the site.", 1200),
  // The Team room: agents talking to each other. A render script may pass its own traffic as `__TEAM_ROOM__`.
  say(TEAM_ROOM_ID, TEAM_ROOM_ID, "The agents talking to each other", 3000),
  ...teamTraffic(),
];

function teamTraffic(): ChatMessage[] {
  const real = (globalThis as { __TEAM_ROOM__?: { from: string; to: string; text: string; minutes: number }[] }).__TEAM_ROOM__;
  const lines = real ?? [
    { from: "avatar-build", to: "rivet", text: "Avatars shipped on the test build: PR #412 is green, video next.", minutes: 26 },
    { from: "rivet", to: "avatar-build", text: "Good. Record the phone-size approval video and send it as a card.", minutes: 24 },
    { from: "chart-animation", to: "rivet", text: "Reworking the chart: the loop pops at the turn. Fixing the easing.", minutes: 9 },
  ];
  return lines.map((line, n) => say(`team-${n}`, TEAM_ROOM_ID, line.text, line.minutes, { team: { from: line.from, to: line.to } }));
}
type PreviewFields = Partial<Pick<ConversationSummary, "markedUnread" | "pinned" | "done" | "stage" | "stagePr" | "phase">> & {
  title: string;
  links?: Partial<ConversationSummary["links"]>;
  needsYou?: boolean;
  unread?: number;
  project?: ThreadSummary["project"];
  closed?: boolean;
  /** When it was reopened: listed two hours from then, as the server's idle rule counts it. */
  sweptAt?: string;
};
const conversationFields: Record<string, PreviewFields> = {
  [UPDATES_ID]: { title: "Updates", unread: 2 },
  k1: { title: "Reports totals row", needsYou: true, unread: 1, links: { prs: ["#312"], tag: "Reports" }, project: "work", stage: "open", stagePr: "#312", pinned: true, phase: "waiting" },
  lp1: { title: "Saved views", links: { prs: ["#493"], tag: "Saved views" }, project: "work", stage: "merged", stagePr: "#493", phase: "merged" },
  c1: { title: "Threads → conversations", links: { tag: "Rivet Agents" }, project: "rivet", markedUnread: true },
  or1: { title: "Brighter dashboard charts", links: { tag: "Dashboard" }, project: "work", stage: "merged", phase: "deployed" },
  m1: { title: "Report tab colours", unread: 3, links: { prs: ["#390"], tag: "Reports" }, project: "work", stage: "merged", stagePr: "#390", phase: "deployed" },
  x1: { title: "Darker Settings background", links: { prs: ["#387"], tag: "Settings" }, project: "work", stage: "closed", stagePr: "#387" },
  d1: { title: "Bulk edit: 1–4 rows on one screen?", unread: 1, links: { prs: ["#421"], tag: "Bulk edit" }, project: "work", stage: "draft", stagePr: "#421", phase: "building" },
  t1: { title: "Bottom bar: Feed and Chat", links: { prs: ["#418"], tag: "Rivet Agents" }, project: "rivet", stage: "merged", stagePr: "#418", done: true },
  g1: { title: "Enquiry form", links: { prs: ["other-repo#88"], tag: "Contact page" }, project: "work" },
  w1: { title: "Weekly average line", links: { tag: "Habit chart" }, project: "personal" },
  s1: { title: "Notifications v2 sound pass", links: { prs: ["#283"], tag: "Notifications" }, project: "work", stage: "merged", stagePr: "#283" },
  [TEAM_ROOM_ID]: { title: "Agent Chat" },
  r1: { title: "Welcome banner mascot", links: { prs: ["#276"], tag: "Welcome" }, project: "work", stage: "merged", stagePr: "#276" },
};
// Archived: enough for two pages.
for (let n = 1; n <= 64; n++) {
  const id = `o${n}`;
  messages.push(mine(id, id, `An older topic, number ${n}`, 10_000 + n * 60), say(`${id}-a`, id, `Done with older topic ${n}.`, 10_000 + n * 60 - 5));
  conversationFields[id] = { title: `Older topic ${n}`, closed: n % 3 === 0 };
}
const OLDER = new Set(Object.keys(conversationFields).filter((id) => id.startsWith("o")));

function conversationOf(id: string): string | null {
  const message = messages.find((one) => one.id === id);
  return message ? (message.threadId ?? message.id) : null;
}

function rowOf(id: string): ConversationSummary {
  const fields = conversationFields[id] ?? { title: messages.find((one) => one.id === id)?.text.split("\n")[0] ?? "Conversation" };
  const own = messages.filter((one) => (one.threadId ?? one.id) === id).sort((a, b) => a.at.localeCompare(b.at));
  const last = own.at(-1)!;
  return {
    id,
    title: fields.title,
    lastAt: last.at,
    lastFrom: last.from,
    lastText: (last.team ? `${last.team.from} → ${last.team.to}: ` : "") + (last.text.split("\n")[0] || "Photo"),
    unread: fields.unread ?? 0,
    needsYou: fields.needsYou ?? false,
    links: { prs: [], chats: [], tag: null, ...fields.links },
    closed: (fields.closed ?? false) || idle(id, fields, last),
    updates: id === UPDATES_ID,
    appOnly: fields.project === "personal",
    markedUnread: fields.markedUnread ?? false,
    pinned: fields.pinned ?? false,
    done: fields.done ?? false,
    stage: fields.stage ?? "none",
    ...(fields.stagePr ? { stagePr: fields.stagePr } : {}),
    phase: fields.phase ?? null,
    thing: own.some((one) => !!one.posted),
  };
}

/**
 * As the server's idle rule: no message for over IDLE_ARCHIVE_MS, nor a Reopen since; never Updates or Agent Chat, nor
 * one waiting on you (or with Rivet's question the last word), pinned or marked unread.
 */
function idle(id: string, fields: PreviewFields, last: ChatMessage): boolean {
  if (id === UPDATES_ID || id === TEAM_ROOM_ID || fields.needsYou || fields.pinned || fields.markedUnread) return false;
  if (last.from === "rivet" && last.text.trimEnd().endsWith("?")) return false;
  const active = !fields.closed && fields.sweptAt && fields.sweptAt > last.at ? fields.sweptAt : last.at;
  return Date.parse(active) < Date.now() - IDLE_ARCHIVE_MS;
}

/** As the server: an old conversation is listed again once pinned, marked unread, reopened or waiting on you. */
function reopened(fields: PreviewFields): boolean {
  return Boolean(fields.pinned || fields.markedUnread || fields.needsYou || (!fields.closed && fields.sweptAt));
}

function openRows(): ConversationSummary[] {
  const rows = Object.keys(conversationFields)
    // As the server: the old Updates conversation is only under Archived.
    .filter((id) => id !== UPDATES_ID && (!OLDER.has(id) || reopened(conversationFields[id]!)))
    .map(rowOf)
    .filter((row) => !row.closed)
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  const top = (row: ConversationSummary) => (row.pinned ? 1 : 0);
  return rows.sort((a, b) => top(b) - top(a));
}

function olderRows(): ConversationSummary[] {
  return Object.keys(conversationFields)
    .filter((id) => !openRows().some((row) => row.id === id))
    .map(rowOf)
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

function detailOf(id: string): ConversationDetail {
  const row = rowOf(id);
  const fields = conversationFields[id];
  return {
    id,
    title: row.title,
    status: row.needsYou ? "needs-you" : null,
    statusFrom: row.needsYou ? "card" : null,
    project: fields?.project ?? null,
    tag: row.links.tag,
    ball: row.needsYou ? "owner" : null,
    startedBy: messages.find((one) => one.id === id)?.from ?? "owner",
    count: messages.filter((one) => (one.threadId ?? one.id) === id).length,
    lastAt: row.lastAt,
    lastFrom: row.lastFrom,
    lastText: row.lastText,
    steps: [],
    messages: messages.filter((one) => (one.threadId ?? one.id) === id).sort((a, b) => a.at.localeCompare(b.at)),
    more: false,
    conversation: row,
  };
}

// ?clear=1 empties the board's needs and every wait the server would make a card of (asks/waits.ts): no Coming row at
// Your OK and no chat or worker waiting on you (a quiet worker waits only while a card names its chat,
// server/workers.ts), and no ask at needs-you, so the Feed shows its all-clear and the crew tiles and every needs-you
// count is 0.
// ?quiet=1: nothing of yours due within the hour, so with clear=1 the Floor's line has nothing to say.
if (new URLSearchParams(location.search).get("quiet") === "1")
  for (const one of asks) if (one.dueAt && Date.parse(one.dueAt) > now.getTime() && Date.parse(one.dueAt) <= now.getTime() + 3_600_000) one.dueAt = ago(-90);
const CLEAR = new URLSearchParams(location.search).get("clear") === "1";
if (CLEAR) {
  board.needs.length = 0;
  // No card waiting, so no ask at Your OK either.
  for (const one of asks) if (one.stage === "needs-you") one.stage = "building";
  board.coming.splice(0, board.coming.length, ...board.coming.filter((row) => row.stage !== "owner-ok"));
  for (const chat of board.chats) if (chat.state === "waiting") chat.state = "idle";
  for (const worker of workers.workers) {
    if (worker.state === "waiting") worker.state = "idle";
    delete worker.needsYou;
  }
}
// ?clear=1&wait=1: one wait, the loading animation at Your OK, with the card the server makes for it (okWait) and
// loading-animation waiting, as the server derives a quiet worker its card names.
if (CLEAR && new URLSearchParams(location.search).get("wait") === "1") {
  Object.assign(board.coming.find((row) => row.pr === 288)!, { stage: "owner-ok", chat: "loading-animation", touchedAt: ago(20) });
  const loading = workers.workers.find((worker) => worker.chat === "loading-animation");
  if (loading) loading.state = "waiting";
  board.needs.push({
    id: "wait-ok-f8f57bc5c802-preview",
    kind: "decision",
    title: "Your OK: Loading animation",
    ask: "Animation v6 on every page is ready to merge. Yes tells loading-animation to merge it; Change it sends loading-animation your note.",
    options: [{ label: "Yes" }, { label: "Change it", text: true }],
    pr: 288,
    repo: REPO,
    links: [{ label: "PR #288", url: pr(288) }],
    chat: "loading-animation",
    since: ago(20),
  });
}
// ?waits=1: loading-animation waits on you, and the deck carries the cards the server makes (asks/waits.ts) for it and the
// fixture's Your OK row, for asks titled "Loading animation" and "Notifications v2 sound pass".
if (new URLSearchParams(location.search).get("waits") === "1") {
  const loading = board.chats.find((chat) => chat.name === "loading-animation");
  if (loading) Object.assign(loading, { state: "waiting on you", doing: "Animation v6: keep the slower spin or go back to v5?", touchedAt: ago(6) });
  board.needs.unshift(
    {
      id: "wait-ok-5dbe828e9ad9-preview",
      kind: "decision",
      title: "Your OK: Notifications v2 sound pass",
      ask: "v2 sound pass is ready to merge. Yes tells Rivet to merge it; Change it sends Rivet your note.",
      options: [{ label: "Yes" }, { label: "Change it", text: true }],
      pr: 283,
      links: [{ label: "PR #283", url: pr(283) }],
      since: ago(45),
    },
    { id: "wait-chat-d09cae621ddf-preview", kind: "question", title: "Question from Loading animation", ask: "Animation v6: keep the slower spin or go back to v5?", reply: "text", chat: "loading-animation", since: ago(6) },
  );
}
// ?updates=only keeps just the update cards: no question waits, so the Feed opens on its news.
if (new URLSearchParams(location.search).get("updates") === "only") board.needs.splice(0, board.needs.length, ...board.needs.filter((need) => need.kind === "update"));
// ?updates=none drops them, for the Feed as it was before update cards.
if (new URLSearchParams(location.search).get("updates") === "none") board.needs.splice(0, board.needs.length, ...board.needs.filter((need) => need.kind !== "update"));
// ?long=1 gives the open-sign-up card the extremes the format allows: a 200-character label with no short, and an
// unbroken 40-character short (feed-option-text.mjs).
if (new URLSearchParams(location.search).get("long") === "1") {
  const card = board.needs.find((need) => need.id === "open-sign-up");
  if (card) {
    card.options = [
      { label: "Ship it now for invited people only, and come back to open sign-up once the rate limits and spam checks have a plan, a design, an owner and a date Sam has agreed to in writing, and not a day before it", recommended: true },
      { label: "Plan open sign-up", short: "W".repeat(40) },
      { label: "Both" },
    ];
  }
}
const replies: Reply[] = [];
let seq = 0;
// ?v4=1: the Feed's pieces: a plan card first, a late pile, and answers given today for Done.
if (new URLSearchParams(location.search).get("v4") === "1") {
  board.needs.unshift({
    id: "plan-undo-history",
    kind: "plan",
    title: "Five undo steps, kept between saves",
    ask: "Friday's ask as a test build on the editor. Plan only, nothing starts until you say yes.",
    points: ["Keep the last 5 edits from the start of a session", "Undo any time between saves, one tap per step", "Same store, server-side history, same rules"],
    size: "M",
    eta: "~2:30pm",
    chat: "undo-history",
    since: ago(6),
  });
  board.needs.push({ id: "upd-export-late", kind: "update", thread: "CSV export", tag: "Late 40 min", title: "Round-2 review found 3 findings; fixing", ask: "New ETA 12:15pm.", pr: 495, since: ago(3) });
  const answered = (minutes: number, id: string, itemTitle: string, decision: Reply["decision"], extra: Partial<Reply> = {}): Reply =>
    ({ id: `r-${id}`, itemId: id, itemTitle, decision, rev: "0".repeat(16), at: ago(minutes), handled: true, item: { id, title: itemTitle, kind: "decision" }, ...extra }) as Reply;
  replies.push(
    answered(12, "copy-check", "Copy: say saved, never stored", "approve", { text: "yes and check the toasts too" }),
    answered(40, "preview-mode", "Preview: side by side or stacked?", "choice", { choice: "Stacked" }),
    answered(65, "dmarc-record", "Mail DMARC record", "seen"),
    answered(70, "nightly-1", "6 PRs merged, main green", "seen"),
    answered(95, "home-tiles", "Home tiles: drop the demo badge", "reject", { text: "keep the badge off but the tile needs the new art first" }),
  );
}
// ?top5=1: the phone Feed's top five: a merge-ready card with its proof and a still, and Done rows in each state. With
// it, `newcard=1` adds a card 4 s after load (the pill), `offline=1` makes the next read fail 6 s after load and
// `offline=net` says the phone lost its network.
const TOP5 = new URLSearchParams(location.search).get("top5") === "1";
if (TOP5) {
  // Risky cards sort first on the phone, so the merge card leads a short deck of its own.
  board.needs.splice(0, board.needs.length, ...board.needs.filter((need) => need.kind === "update" || need.id === "sidebar-shortcuts"));
  board.needs.unshift({
    id: "merge-toolbar",
    kind: "merge-ready",
    title: "Reports: the toolbar keeps SAVE on one row",
    ask: "Gate clean. One row on every phone down to the narrowest.",
    chat: "toolbar-one-row",
    pr: 480,
    headSha: "4f9a2c7e".repeat(5),
    since: ago(4),
    media: { kind: "stills", stills: [{ sha256: drawnStill("t5".padEnd(64, "a"), "Toolbar on a phone", 150, 1280, 720), type: "image/png" }] },
    evidence: {
      ci: "green",
      ciNote: "gate clean on 4f9a2c7",
      review: "clean",
      reviewNote: "3 lenses, round 2",
      why: "It changes the save row people tap",
      holding: [],
    },
    options: [{ label: "Merge it", short: "Merge", recommended: true }, { label: "Send changes (write them below)", short: "Changes", text: true }],
  });
  const done = (minutes: number, id: string, itemTitle: string, extra: Partial<Reply> = {}): Reply =>
    ({ id: `r-${id}`, itemId: id, itemTitle, decision: "approve", rev: "0".repeat(16), at: ago(minutes), handled: false, item: { id, title: itemTitle, kind: "approval" }, ...extra }) as Reply;
  replies.push(
    done(2, "top5-waiting", "Editor: undo keeps 12 steps"),
    done(9, "top5-reached", "Dashboard: rainbow first series", { delivery: { target: "chat", chat: "chart-colours", at: ago(8) } }),
    done(20, "top5-unconfirmed", "Request keys: never forgotten", { delivery: { target: "chat", chat: "request-keys", at: ago(19), confirmed: false } }),
    done(45, "top5-acted", "Home tiles: new art first", { handled: true, handledAt: ago(30), actedAt: ago(30), delivery: { target: "rivet", at: ago(44) } }),
  );
}
// ?gotit=1: a news card as the board now stores one, a decision with one option, Got it.
if (new URLSearchParams(location.search).get("gotit") === "1") {
  board.needs.push({ id: "got-it-news", kind: "decision", title: "Merged: #493 Home tiles show new art first", ask: "Deploying to the site next.", chat: "home-tiles", pr: 493, since: ago(3), options: [{ label: "Got it" }], push: "fyi" } as (typeof board.needs)[number]);
}
/** `offline=1`: the server stops answering (a 503) once set. */
let serverDown = false;
// ?top=<need id> puts that card first on a phone, and opens it on desktop (below), whose list sorts risky cards first.
const top = board.needs.findIndex((need) => need.id === new URLSearchParams(location.search).get("top"));
if (top > 0) board.needs.unshift(...board.needs.splice(top, 1));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let askSeq = 4710;

// The chat polls instead of streaming here.
(window as { EventSource?: unknown }).EventSource = undefined;

const ISSUE: IssueDetail = {
  repo: OTHER_REPO,
  number: 20,
  title: "Dark-theme chart draws the daily line indigo on production but lavender on a local build",
  body: [
    "**Seen** while making the stills for #14 (PR #18), dark theme, on a phone.",
    "**What happens.** Production draws the chart's daily line in indigo `#4b3bf5`, the light-theme colour. A local production build of the same code draws it lavender `#a59bff`, the dark-theme colour.",
    "**Likely cause.** `TrendChart` reads the theme colours once, before the dark theme is applied, and nothing redraws it.",
    "**Suggested fix.** Make the chart's colours follow the theme.",
  ].join("\n\n"),
  author: "sam",
  createdAt: ago(3 * 1440),
  state: "open",
  url: `https://github.com/${OTHER_REPO}/issues/20`,
  comments: 0,
  labels: [],
  at: ago(0),
};
/** The first read of #20 waits on the Mac, as a real one does; Start work and Close land at once. */
let issueReads = 0;
let issueStart: BacklogIssueResponse["start"] = null;
let issueClose: BacklogIssueResponse["close"] = null;

// A project's backlog: its longest everyday titles, more rows than each section shows.
const backlogIssue = (number: number, title: string, hours: number, labels: string[] = []) => ({ number, title, updatedAt: ago(hours * 60), labels });
const backlog: BacklogResponse = {
  at: ago(3),
  stale: false,
  repos: {
    [REPO]: {
      repo: REPO,
      total: 386,
      logs: 12,
      ownerTotal: 6,
      owner: [
        backlogIssue(356, "Search: filters and results edge to edge on the smallest phone at its largest text size", 2, ["autonomy:owner"]),
        backlogIssue(301, "Editor: which undo trail to keep", 30, ["autonomy:owner"]),
        backlogIssue(290, "Pricing page: the price of the new plan", 50, ["autonomy:owner"]),
        backlogIssue(288, "Store upload: which build goes first", 70, ["autonomy:owner"]),
      ],
      recent: [
        backlogIssue(344, "Chat runner: a chat at its limit stays stuck until restarted", 1, ["type:bug"]),
        backlogIssue(339, "Seven servers: a held job shows twice in history", 5, ["bug"]),
        backlogIssue(330, "Home: the new tile's art is a little soft", 8),
        backlogIssue(322, "Loading animation a touch quick", 20),
        backlogIssue(310, "Reports: result card copy says saved twice", 26),
        backlogIssue(305, "Docs: the setup page names an old step", 40),
        backlogIssue(299, "Charts: a small shake at full zoom", 60),
      ],
      bugs: [],
      at: ago(3),
      stale: false,
    },
    // ?issue=20: other-repo's #20, opened in its backlog.
    [OTHER_REPO]: {
      repo: OTHER_REPO,
      total: 1,
      logs: 0,
      ownerTotal: 0,
      owner: [],
      recent: [{ number: 20, title: ISSUE.title, updatedAt: ISSUE.createdAt, labels: [] }],
      bugs: [],
      at: ago(3),
      stale: false,
    },
    // A project read with nothing open: its sheet says Nothing waiting.
    [THIRD_REPO]: { repo: THIRD_REPO, total: 0, logs: 0, ownerTotal: 0, owner: [], recent: [], bugs: [], at: ago(3), stale: false },
  },
  asks: [
    { id: "ask-30", words: "Start the new pages once the list of all of them comes in", short: "Start the new pages", stage: "queued", repo: REPO, prs: [], why: "Waits on the list", createdAt: ago(40), stageAt: ago(40) },
    { id: "ask-26", words: "Editor: brighter toolbar on the test build", short: "Editor brighter toolbar", stage: "queued", repo: REPO, issue: 301, chat: "editor", prs: [], createdAt: ago(300), stageAt: ago(300) },
    { id: "ask-10", words: "Nightly report by email", short: "Nightly report", stage: "parked", repo: REPO, prs: [], why: "You said to park this", createdAt: ago(3000), stageAt: ago(2000) },
    { id: "ask-01", words: "Editor sound pass", stage: "parked", repo: REPO, prs: [], createdAt: ago(5000), stageAt: ago(4000) },
    { id: "ask-02", words: "Reports second table", stage: "parked", repo: REPO, prs: [], createdAt: ago(6000), stageAt: ago(5000) },
  ],
};

const passThrough = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith("/media/")) return (await previewMediaFile(url)) ?? passThrough(input, init);
  if (!url.startsWith("/api/")) return passThrough(input, init);
  if (serverDown) return json({ error: "Unavailable" }, 503);
  const method = init?.method ?? "GET";
  const served = board.needs.map((need, i) => ({ ...need, rev: String(i).repeat(16) }));
  if (url === "/api/board") return json({ version: 1, updatedAt: board.updatedAt, board: { ...board, needs: served } });
  if (url === "/api/summary") {
    // What GET /api/summary makes of this board and its records (routes/summary.ts): its open cards are openBoard's.
    const open = served.filter((need) => !isUpdate(need) && !replies.some((reply) => reply.itemId === need.id && reply.rev === need.rev));
    return json(summarize({ needs: open, minimised: new Map(), board, crew: { workers: workers.workers, lapsed: false }, asks, statuses: [], queue: workers.pushQueue ?? [], prs: underWayGithub?.prs ?? [], merged: underWayEvents.map((event) => ({ repo: event.repo, number: event.number ?? 0, at: event.at ?? "" })), now: Date.now() }));
  }
  if (url === "/api/backlog") return json({ ...backlog, started: issueStart ? [issueStart] : [], closing: issueClose ? [{ repo: OTHER_REPO, issue: 20 }] : [] });
  if (url.startsWith("/api/backlog/issue?")) {
    const read = issueReads++ > 0;
    return json({ detail: read ? ISSUE : null, pending: !read, start: issueStart, close: issueClose, chat: null } satisfies BacklogIssueResponse);
  }
  if (url === "/api/backlog/start") {
    issueStart ??= { repo: OTHER_REPO, issue: 20, ask: "ask-48", words: `Start work on other-repo #20: ${ISSUE.title}`, at: new Date().toISOString(), stage: "queued" };
    return json({ ask: issueStart.ask, already: false, start: issueStart }, 201);
  }
  if (url === "/api/backlog/close") {
    issueClose ??= { id: "close-20", status: "waiting", at: new Date().toISOString() };
    return json({ close: issueClose }, 201);
  }
  if (url === "/api/card-threads") {
    return json({ cards: [{ card: "audit-checklist-file", thread: "04322f27", title: "Audit checklist for work card UI and design consistency", round: 1 }] });
  }
  if (url === "/api/status") return json({ board: { version: 1, updatedAt: board.updatedAt }, bridge: { connected: !MAC_OFF, lastSeenAt: now.toISOString() }, tts: false });
  const answered = answeredRoute(url, method, typeof init?.body === "string" ? init.body : undefined, board.needs);
  if (answered) return answered;
  if (url.startsWith("/api/replies") && method === "GET") return json({ replies });
  if (url === "/api/replies") {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const reply = { id: `reply-${++seq}`, itemTitle: "", at: new Date().toISOString(), handled: false, item: {}, ...body } as unknown as Reply;
    replies.unshift(reply);
    return json(reply, 201);
  }
  // Uploads answer with a made-up sha256 per upload; a recording script serves /media/ for them.
  if (url === "/api/images") return json({ image: (++seq % 16).toString(16).repeat(64), type: "image/jpeg", size: 10 }, 201);
  if (url === "/api/files") {
    const name = decodeURIComponent((init?.headers as Record<string, string>)["x-file-name"] ?? "file.pdf");
    return json({ sha256: (15 - (++seq % 16)).toString(16).repeat(64), name, type: "application/pdf", size: 10 }, 201);
  }
  if (url.startsWith("/api/workers")) return json(workers);
  if (url.startsWith("/api/asks")) return json({ asks });
  if (url === "/api/ops/status")
    return json({ statuses: [...(FIX_OPEN ? [{ kind: "coming", key: fixKey, state: "investigating", chat: "fix-coming-admin-export", by: "Rivet", since: ago(1), updatedAt: ago(1), version: 1 }] : []), ...parkedStatus, ...lateStatus] });
  // As ops.preview.ts answers them: the Floor's status line reads /api/ops on every remount.
  if (url.startsWith("/api/ops/search")) return json({ results: history });
  // The all-clear's "shipped in 7 days" reads the timeline.
  if (url === "/api/ops/timeline") return json({ days: underWayEvents.length ? [{ day: "today", events: underWayEvents }] : [], repos: [] });
  if (url.startsWith("/api/mind")) return mindPreview(url);
  if (url === "/api/ops") return json(buildOps({ now, bridgeConnected: !MAC_OFF, board, github: parkedGithub ?? underWayGithub, mac: null, fly: null, checks: [], health: {}, schedulesAt: schedules.at, claude: CHIP }));
  if (url.startsWith("/api/schedules")) return json(schedules);
  // Schedules reads its switch history beside the list.
  if (url.startsWith("/api/audit")) return json({ entries: [] });
  if (url.startsWith("/api/media")) return json(previewMediaPage(url));
  // Chat's search, as the server answers it: titles first, then messages newest first, each naming its conversation.
  if (url.startsWith("/api/chat/search")) {
    const q = (new URL(url, location.origin).searchParams.get("q") ?? "").trim().toLowerCase();
    const titles = Object.entries(conversationFields)
      .filter(([, fields]) => q && fields.title.toLowerCase().includes(q))
      .map(([id, fields]) => ({ kind: "message" as const, key: `conversation:${id}`, title: fields.title, detail: "Conversation", at: rowOf(id).lastAt, open: { type: "message" as const, id } }));
    const said = messages
      .filter((one) => q && !SEED_IDS.includes(one.id) && one.text.toLowerCase().includes(q))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 20)
      .map((one) => ({
        kind: "message" as const,
        key: `message:${one.id}`,
        title: one.text.split("\n")[0]!,
        detail: `${one.from === "owner" ? "You" : "Rivet"} in ${rowOf(one.threadId ?? one.id).title}`,
        at: one.at,
        open: { type: "message" as const, id: one.id },
      }));
    return json({ results: [...titles, ...said] });
  }
  if (url.startsWith("/api/conversations?") || url === "/api/conversations") {
    const params = new URL(url, location.origin).searchParams;
    const open = openRows();
    const unread = open.filter(countsUnread).length;
    const rest = olderRows();
    if (params.get("older") !== "1") return json({ conversations: open, older: rest.length, unread } satisfies ConversationsResponse);
    const limit = Number(params.get("limit") ?? 50);
    const from = params.get("before") ? Number(params.get("before")) : 0;
    const page = rest.slice(from, from + limit);
    return json({ conversations: page, older: rest.length, unread, ...(from + limit < rest.length ? { next: String(from + limit) } : {}) } satisfies ConversationsResponse);
  }
  if (url === "/api/conversations/batch" && method === "POST") {
    const { ids, action } = JSON.parse(String(init?.body)) as { ids: string[]; action: ConversationAction };
    let changed = 0;
    for (const id of new Set(ids.map(conversationOf))) {
      if (!id || (id === UPDATES_ID && action === "close")) continue;
      const fields = (conversationFields[id] ??= { title: rowOf(id).title });
      if (action === "read") Object.assign(fields, { unread: 0, markedUnread: false });
      else if (action === "unread") Object.assign(fields, { markedUnread: true, closed: false, ...(fields.closed ? { sweptAt: new Date().toISOString() } : {}) });
      else if (action === "close") Object.assign(fields, { closed: true, pinned: false, markedUnread: false });
      else Object.assign(fields, { closed: false, sweptAt: new Date().toISOString() });
      changed += 1;
    }
    return json({ changed });
  }
  if (url === "/api/conversations/read" && method === "POST") {
    const changed = openRows().filter(countsUnread);
    for (const row of changed) Object.assign(conversationFields[row.id]!, { unread: 0, markedUnread: false });
    return json({ read: changed.length });
  }
  const merging = /^\/api\/conversations\/([^/?]+)\/merge$/.exec(url);
  if (merging && method === "POST") {
    const { into } = JSON.parse(String(init?.body)) as { into: string };
    const id = conversationOf(decodeURIComponent(merging[1]!));
    const target = conversationOf(into);
    if (!id || !target) return json({ error: "no such conversation" }, 404);
    if (ownsNoCard(id) || ownsNoCard(target) || id === target) return json({ error: "That conversation can't be merged." }, 409);
    if (rowOf(id).appOnly !== rowOf(target).appOnly) return json({ error: "An app-only conversation can't merge with a shareable one." }, 409);
    const moving = messages.filter((one) => (one.threadId ?? one.id) === id);
    for (const one of moving) one.threadId = target;
    delete conversationFields[id];
    return json({ moved: moving.length, conversation: detailOf(target) } satisfies MergeResponse);
  }
  if (url.startsWith("/api/conversations/")) {
    const id = conversationOf(decodeURIComponent(url.slice("/api/conversations/".length)));
    if (!id) return json({ error: "no such conversation" }, 404);
    if (method === "PATCH") {
      const change = JSON.parse(String(init?.body)) as { title?: string | null; closed?: boolean; read?: unknown; unread?: boolean; pinned?: boolean };
      const fields = (conversationFields[id] ??= { title: rowOf(id).title });
      const wasClosed = fields.closed ?? false;
      if (change.title !== undefined) fields.title = change.title ?? fields.title;
      if (change.closed !== undefined) fields.closed = change.closed;
      if (change.read !== undefined) Object.assign(fields, { unread: 0, markedUnread: false });
      if (change.unread !== undefined) fields.markedUnread = change.unread;
      if (change.pinned !== undefined) fields.pinned = change.pinned;
      // As the server: pinning or marking unread reopens it; closing puts both away.
      if (change.closed === true) Object.assign(fields, { pinned: false, markedUnread: false });
      else if (change.closed === undefined && (change.unread === true || change.pinned === true)) fields.closed = false;
      // Reopened (Reopen, or pin or mark unread on a closed one): listed two hours from now.
      if (change.closed === false || (wasClosed && !fields.closed)) fields.sweptAt = new Date().toISOString();
    }
    return json(detailOf(id));
  }
  if (url.startsWith("/api/chat") && method === "GET") return json({ messages: [...messages].sort((x, y) => x.at.localeCompare(y.at)).slice(-30), older: null });
  if (url.startsWith("/api/chat")) {
    const body = JSON.parse(String(init?.body)) as { clientId: string; text?: string; conversation?: string | null };
    const id = `c-${++seq}`;
    const conversation = body.conversation ? (conversationOf(body.conversation) ?? id) : id;
    if (!conversationFields[conversation]) conversationFields[conversation] = { title: (body.text ?? "").split("\n")[0]!.slice(0, 60) || "New conversation" };
    // A new message opens a closed one again, as on the server.
    conversationFields[conversation]!.closed = false;
    // Stamped now, not when the page loaded: the idle rule reads the clock.
    const sent = mine(id, conversation, body.text ?? "", 0, { status: "sent", at: new Date().toISOString() });
    messages.push(sent);
    setTimeout(() => messages.push(say(`h-${++seq}`, conversation, "On it. I'll tell its chat now.", 0, { at: new Date().toISOString() })), 1500);
    return json({ id, clientId: body.clientId, at: sent.at, status: "done", conversation: body.conversation === null ? null : conversation }, 201);
  }
  if (url.startsWith("/api/briefing")) return json({ briefing: null });
  if (url.startsWith("/api/logs/subscribe")) return json({ leaseUntil: new Date(Date.now() + 60_000).toISOString() });
  if (url.startsWith("/api/logs?")) return json({ lines: ["Reading src/lists/scroll.ts", "Running npm test (42 passed)"], updatedAt: now.toISOString(), leaseUntil: null });
  return json({});
};

try {
  localStorage.setItem("rivet.installHint", "dismissed");
  sessionStorage.setItem("rivet.intro-seen", "1");
} catch {}

const params = new URLSearchParams(location.search);
const asked = params.get("tab") ?? "cards";
go(asked === "more" ? (params.get("page") ?? "more") : asked);
const openId = params.get("conversation");
if (openId) showConversation(openId);
else if (params.get("new") === "1") startDraft("");
showRivetWords();
mountShell(document.getElementById("app")!);
drawPreviewMedia();
const task = params.get("task");
if (task) openTask(task);
if (params.get("tap") !== null) tapPreviewThumb(Number(params.get("tap")));
// A share the service worker kept (a simulated Share menu POST to /share-target) lands as it does in the app.
void takeShare().then((share) => share && receiveShare(share));
// Opened once the board is in: a render before it has no cards and clears the front card.
void refresh().then(() => {
  if (top < 0) return;
  app.front = board.needs[0]!.id;
  changed();
});
if (TOP5 && params.get("newcard") === "1")
  setTimeout(() => {
    board.needs.push({ id: "top5-new", kind: "approval", title: "Editor: rows glow on a save", ask: "A soft glow under each row that saved.", chat: "row-glow", since: new Date().toISOString() });
    void refresh();
  }, 4000);
if (TOP5 && params.get("offline") === "1")
  setTimeout(() => {
    serverDown = true;
    void refresh();
  }, 6000);
if (TOP5 && params.get("offline") === "net")
  setTimeout(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    networkChanged();
    changed();
  }, 6000);

/** ?task=: a Plan row's detail, opened as a tap would once Ops has loaded the row (by its id, or part of it). */
function openTask(id: string, tries = 25): void {
  const rows = planState().doing;
  const row = rows.find((r) => r.id === id) ?? rows.find((r) => r.id.includes(id));
  if (row) row.open();
  else if (tries > 0) setTimeout(() => openTask(id, tries - 1), 200);
}

/** ?issue=20: other-repo's backlog with #20 opened, as a tap on its row; ?issue=list leaves the list open. */
if (params.get("issue")) {
  setTimeout(() => {
    openBacklog(OTHER_REPO);
    if (params.get("issue") !== "list") openIssueRow(25);
  }, 600);
}

function openIssueRow(tries: number): void {
  const row = document.querySelector<HTMLButtonElement>('.backlog-sheet [data-key="issue-20"]');
  if (row) row.click();
  else if (tries > 0) setTimeout(() => openIssueRow(tries - 1), 200);
}
