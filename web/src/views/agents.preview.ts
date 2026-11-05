// Dev-only preview of the Agents board (web/preview/agents.html). A render script may pass real data as `__AGENTS__`;
// without it a small made-up crew shows. Nothing imports this from the app, so the production build leaves it out.
import "../styles.css";

import type { BoardResponse } from "../../../src/shared/board.js";
import type { OpsResponse, PullRequest, TimelineResponse } from "../../../src/shared/ops.js";
import type { WorkersResponse } from "../../../src/shared/workers.js";
import type { Claim } from "../agents-logic.js";
import { app } from "../state.js";
import { mountShell } from "./shell.js";

interface PreviewData {
  board: BoardResponse;
  workers: WorkersResponse;
  prs: PullRequest[];
  timeline: TimelineResponse;
  claims: Claim[] | null;
  /** The chats with Team room lines; the first three open ones when absent. */
  room?: string[];
}

const now = new Date();
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const R = "example-org/example-repo";
const pr = (number: number, title: string, extra: Partial<PullRequest> = {}): PullRequest => ({
  repo: R,
  number,
  title,
  url: `https://github.com/${R}/pull/${number}`,
  draft: false,
  author: "sam",
  labels: [],
  headAt: ago(30),
  updatedAt: ago(20),
  checks: { state: "pass", passed: 12, failed: 0, pending: 0, failing: [] },
  ...extra,
});

const fake: PreviewData = {
  board: {
    version: 1,
    updatedAt: now.toISOString(),
    board: {
      updatedAt: now.toISOString(),
      needs: [{ id: "cover-video", kind: "approval", title: "New cover screen: approve the video?", chat: "cover-screen", pr: 412, rev: "0123456789abcdef" }],
      coming: [],
      chats: [
        { name: "team-room", state: "working", doing: "Team room in the app", prs: [418], updatedAt: ago(4) },
        { name: "claims-board", state: "working", doing: "Claims board for shared files", updatedAt: ago(2) },
        { name: "cover-screen", state: "waiting", doing: "New cover screen", prs: [412], updatedAt: ago(40) },
        { name: "flaky-triage", state: "done", doing: "A red check is called flaky or real", prs: [419], updatedAt: ago(90) },
        { name: "shader-warmup", state: "done", doing: "The chart warms its shaders", prs: [432], updatedAt: ago(50) },
        { name: "hide-music", state: "done", doing: "Hide the unused music button", prs: [439], updatedAt: ago(16) },
        { name: "boot-fallbacks", state: "done", doing: "Stalled loads fail over", prs: [433], updatedAt: ago(170) },
      ],
      shipped: [],
      waitingWM: [],
    },
  },
  workers: {
    at: now.toISOString(),
    workers: [
      // ETAs (rivet chat set --eta) count from updatedAt: due in 20 min, 36 min, 1 h 50, 3 h 10 and 5 h 30; three late (1 h 5,
      // 55 min and 25 min), two of them with long names, to prove the rows under the bar hold.
      { id: "w1", name: "team-room", repo: R, chat: "team-room", state: "working", lastOutputAt: now.getTime(), doing: "Team room in the app", prs: [418], branch: "sam/team-room", etaMinutes: 30, updatedAt: ago(10) },
      { id: "w2", name: "claims-board", repo: R, chat: "claims-board", state: "working", lastOutputAt: now.getTime(), doing: "Claims board for shared files", branch: "sam/claims-board", etaMinutes: 40, updatedAt: ago(4) },
      { id: "w3", name: "Sam", repo: R, chat: "cover-screen", state: "waiting", lastOutputAt: now.getTime(), doing: "New cover screen", prs: [412], etaMinutes: 150, updatedAt: ago(40) },
      { id: "w4", name: "fix-ci-lint", repo: R, chat: "fix-ci-lint", state: "working", lastOutputAt: now.getTime(), doing: "Lint fix", branch: "sam/fix-ci-lint", etaMinutes: 30, updatedAt: ago(55) },
      { id: "w5", name: "Alex", repo: R, chat: "settings-sound-pass", state: "working", lastOutputAt: now.getTime(), doing: "Settings sound pass", branch: "sam/settings-sound-pass", etaMinutes: 210, updatedAt: ago(20) },
      { id: "w7", name: "Riley", repo: R, chat: "onboarding-flow-sketch-for-launch", state: "working", lastOutputAt: now.getTime(), doing: "Onboarding sketch for launch", branch: "sam/onboarding-flow-sketch-for-launch", etaMinutes: 30, updatedAt: ago(95) },
      { id: "w8", name: "Jordan", repo: R, chat: "issue-number-432", state: "working", lastOutputAt: now.getTime(), doing: "Issue 432", branch: "sam/issue-number-432", etaMinutes: 20, updatedAt: ago(75) },
      { id: "w6", name: "Casey", repo: R, chat: "chart-axis-labels", state: "working", lastOutputAt: now.getTime(), doing: "Chart axis labels", branch: "sam/chart-axis-labels", etaMinutes: 340, updatedAt: ago(10) },
    ],
  },
  prs: [
    pr(418, "A Team room", { branch: "sam/team-room" }),
    pr(412, "New cover screen", { draft: true, hold: "**Owner hold:** waiting on the video" }),
    pr(420, "Lint fix", { branch: "sam/fix-ci-lint", ciStartedAt: ago(6), checks: { state: "pending", passed: 4, failed: 0, pending: 8, failing: [] } }),
  ],
  timeline: { repos: [R], days: [{ day: now.toISOString().slice(0, 10), events: [
    { kind: "merged", at: ago(80), repo: R, title: "A red check is called flaky or real", number: 419 },
    { kind: "merged", at: ago(48), repo: R, title: "The chart warms its shaders", number: 432 },
    { kind: "merged", at: ago(14), repo: R, title: "Hide the unused music button", number: 439 },
    { kind: "merged", at: ago(165), repo: R, title: "Stalled loads fail over", number: 433 },
  ] }] },
  claims: [{ chat: "team-room", pattern: "web/src/views/chat.ts" }],
};

const data = (globalThis as { __AGENTS__?: PreviewData }).__AGENTS__ ?? fake;

const ops: OpsResponse = {
  now: now.toISOString(),
  bridge: { connected: true },
  github: { at: now.toISOString(), prs: data.prs, runs: [], runners: null, queue: null, merged: null, sources: null, stale: false },
  mac: null,
  claude: null,
  flyAt: null,
  flyStale: false,
  flySource: null,
  healthStaleSince: null,
  summary: { needs: 0, redCi: 0, failingSchedules: 0, disk: { freePct: null, tone: "ok" } },
} as unknown as OpsResponse;

// The Team room, so a chat shows its conversation: a few lines from the first live chats and the lead's answers.
const roomChats = data.room ?? (data.workers.workers ?? []).filter((worker) => !worker.rivet).slice(0, 3).map((worker) => worker.chat);
const roomLines = roomChats.flatMap((chat, i) => [
  { from: chat, to: "lead", text: `${chat}: PR pushed, CI running` },
  { from: "lead", to: chat, text: `Seen. Rebase on main before the gate.` },
  { from: chat, to: "lead", text: `${chat}: rebased, lenses running (${i + 1} of ${roomChats.length})` },
]);
const room = roomLines.map((line, i) => ({
  id: `room-${i}`,
  from: "rivet",
  text: line.text,
  at: new Date(now.getTime() - (roomLines.length - i) * 4 * 60_000).toISOString(),
  threadId: "team-room",
  team: { from: line.from, to: line.to },
}));
const roomSummary = {
  id: "team-room",
  title: "Agent Chat",
  lastAt: room.at(-1)?.at ?? now.toISOString(),
  lastFrom: "rivet",
  lastText: room.at(-1)?.text ?? "",
  unread: 0,
  needsYou: false,
  links: { prs: [], chats: [], tag: null },
  closed: false,
  updates: false,
  appOnly: false,
  markedUnread: false,
  pinned: false,
  done: false,
  stage: "none",
};
const roomDetail = { ...roomSummary, status: null, statusFrom: null, project: null, tag: null, ball: null, startedBy: "rivet", count: room.length, steps: [], messages: room, more: false, conversation: roomSummary };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
window.fetch = async (input) => {
  const path = String(input).split("?")[0]!;
  if (path === "/api/board") return json(data.board);
  if (path === "/api/workers") return json(data.workers);
  if (path === "/api/ops") return json(ops);
  if (path === "/api/ops/timeline") return json(data.timeline);
  if (path === "/api/claims") return data.claims ? json({ claims: data.claims }) : json({ error: "not found" }, 404);
  if (path === "/api/replies") return json({ replies: [] });
  if (path === "/api/conversations") return json({ conversations: [roomSummary], older: 0, unread: 0 });
  if (path === "/api/conversations/team-room") return json(roomDetail);
  if (path === "/api/card-threads") return json({ cards: [] });
  if (path === "/api/status") return json({ board: { version: 1, updatedAt: now.toISOString() }, bridge: { connected: true, lastSeenAt: now.toISOString() } });
  return json({ error: "not in the preview" }, 404);
};

app.board = data.board;
app.workers = data.workers;
app.workersAt = Date.now();
// The crew on Progress's desks, for their pop-ups.
app.tab = "progress";
mountShell(document.getElementById("app")!);
