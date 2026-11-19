// Dev-only preview of a map row's chat sheet (web/preview/chat-peek.html). A render script may pass a chat's masked
// screen reads as `__PEEK__` (each read as the server would serve it); without it a small made-up screen shows. Each
// poll serves the next read, so the screen updates as it would. ?before=1 shows the same reads in the worker sheet's
// raw log instead. Nothing imports this from the app, so the production build leaves it out.
import { logFeed } from "../../../src/shared/log-feed.js";
import { screenView } from "../../../src/shared/screen-view.js";
import "../styles.css";

import type { Ask } from "../../../src/shared/asks.js";
import type { BoardResponse } from "../../../src/shared/board.js";
import type { WorkersResponse } from "../../../src/shared/workers.js";
import { app } from "../state.js";
import { mountShell } from "./shell.js";
import { openWorkerSheet } from "./worker-sheet.js";

interface PeekPreview {
  chat: string;
  doing: string;
  reads: string[][];
}

const R = "example-org/example-repo";
const now = new Date();
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const fake: PeekPreview = {
  chat: "search-calls",
  doing: "Search: calls move off the page",
  reads: [
    ["⏺ Bash(pnpm vitest run callouts)", "⎿  ✓ 14 passed (2.1s)", "⏺ Callouts now sit in the top band.", "✽ Waiting for CI… (2m 10s)", "❯"],
    ["⏺ Bash(pnpm vitest run callouts)", "⎿  ✓ 14 passed (2.1s)", "⏺ Callouts now sit in the top band.", "⏺ Bash(pnpm test:e2e)", "⎿  Error: 2 failed", "✽ Fixing… (2m 30s)", "❯"],
  ],
};
const data = (globalThis as { __PEEK__?: PeekPreview }).__PEEK__ ?? fake;
const worker = { id: "w1", name: "Nina", repo: R, chat: data.chat, state: "working", doing: data.doing, lastOutputAt: now.getTime() - 20_000 };

// The ticket: a made-up ask, its plan card answered with two drawn stills, and an open card with one.
const sha = (n: string) => n.repeat(64);
const ask: Ask = {
  id: "a-1",
  words: "The callouts sit on the chart. Move them to the top band so the chart stays clear on a phone.",
  who: "owner",
  stage: "review",
  chat: data.chat,
  repo: R,
  prs: [41],
  dueAt: ago(-75),
  dueHistory: [{ at: ago(40), dueAt: ago(-75), was: ago(-15), why: "the CI queue is 3 deep" }],
  timeline: [
    { at: ago(150), stage: "building", by: "rivet", note: "plan card first, then build" },
    { at: ago(30), stage: "review", by: data.chat, note: "PR #41 is ready, standard tier." },
  ],
  createdAt: ago(150),
  stageAt: ago(30),
  updatedAt: ago(30),
  version: 4,
};
const png = (n: string) => ({ sha256: sha(n), type: "image/png" as const });
const plan = {
  id: "plan-1",
  rev: "r1",
  kind: "plan",
  title: "Callouts move to the top band",
  ask: "Callouts move off the page into the top band, over the chart.",
  askId: ask.id,
  chat: data.chat,
  since: ago(130),
  points: ["The band holds two callouts; older ones fade.", "The chart keeps its full width.", "Uses the band the HUD already draws."],
  size: "S",
  eta: "about 1 hour",
  media: { kind: "stills", stills: [png("a"), png("b")] },
};
// An open card would put the chat's row on "Needs you", whose tap opens Decide, so both cards here are answered.
const after = { id: "after-1", rev: "r2", kind: "decision", title: "After: callouts in the top band", chat: data.chat, askId: ask.id, since: ago(25), media: { kind: "stills", stills: [png("c")] } };
const answeredCards = [
  {
    card: plan,
    reply: { id: "rp-1", itemId: plan.id, itemTitle: plan.title, decision: "choice", choice: "B", text: "but keep the timer on top", rev: "r1", at: ago(110), handled: true, item: { id: plan.id, title: plan.title, kind: "plan", choiceDetail: "Callouts in the top band" } },
  },
  { card: after, reply: { id: "rp-2", itemId: after.id, itemTitle: after.title, decision: "approve", rev: "r2", at: ago(20), handled: true, item: { id: after.id, title: after.title, kind: "decision" } } },
];
/** A made-up phone screen per still, drawn as SVG: no real screen, so nothing private. */
const STILL_ART: Record<string, string> = {
  a: `<rect x="20" y="40" width="260" height="22" rx="6" fill="#34314f"/><rect x="20" y="300" width="120" height="40" rx="8" fill="#ffc53d"/><rect x="160" y="320" width="120" height="40" rx="8" fill="#ffc53d"/>`,
  b: `<rect x="20" y="40" width="260" height="60" rx="8" fill="#ffc53d"/><rect x="20" y="40" width="260" height="22" rx="6" fill="#34314f"/>`,
  c: `<rect x="20" y="40" width="260" height="60" rx="8" fill="#5fe0c0"/><rect x="20" y="40" width="260" height="22" rx="6" fill="#34314f"/>`,
};
const still = (key: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400"><rect width="300" height="400" fill="#12111c"/><path d="M0 260 Q150 200 300 260 L300 400 L0 400 Z" fill="#2a2640"/><circle cx="90" cy="250" r="14" fill="#7fa8ff"/><circle cx="200" cy="240" r="14" fill="#ff4d5e"/>${STILL_ART[key] ?? ""}</svg>`,
  )}`;
// Point each /media/ picture at its drawn still, as the sheet adds it.
new MutationObserver(() => {
  for (const img of document.querySelectorAll<HTMLImageElement>('img[src^="/media/"]')) img.src = still(img.getAttribute("src")!.slice(7, 8));
}).observe(document.body, { childList: true, subtree: true });

const board = {
  version: 1,
  updatedAt: ago(0),
  board: { updatedAt: ago(0), needs: [], coming: [], chats: [{ name: data.chat, state: "working", doing: data.doing, updatedAt: ago(1) }], shipped: [] },
} as unknown as BoardResponse;
const workers = { at: ago(0), workers: [worker] } as unknown as WorkersResponse;

let read = 0;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
window.fetch = async (input) => {
  const url = new URL(String(input), location.origin);
  const path = url.pathname;
  if (path === "/api/board") return json(board);
  if (path === "/api/workers") return json(workers);
  if (path === "/api/asks") return json({ asks: [ask] });
  if (path === `/api/asks/${ask.id}`) return json(ask);
  if (path === "/api/answered") return json({ cards: answeredCards, reopened: [] });
  if (path === "/api/status") return json({ board: { version: 1, updatedAt: ago(0) }, bridge: { connected: true, lastSeenAt: ago(0) } });
  if (path === "/api/logs/subscribe") return json({ leaseUntil: new Date(Date.now() + 60_000).toISOString() });
  if (path === "/api/logs/release") return json({ ok: true });
  if (path === "/api/logs") {
    const lines = data.reads[Math.min(read++, data.reads.length - 1)]!;
    return json({ repo: R, chat: data.chat, lines, times: lines.map(() => null), updatedAt: ago(0), leaseUntil: null, screen: screenView(lines), feed: logFeed(lines) });
  }
  return json({ error: "not in the preview" }, 404);
};

app.board = board;
app.workers = workers;
app.workersAt = Date.now();
app.status = { board: { version: 1, updatedAt: ago(0) }, bridge: { connected: true, lastSeenAt: ago(0) } } as never;
app.tab = "progress";
mountShell(document.getElementById("app")!);
if (new URLSearchParams(location.search).get("before")) {
  openWorkerSheet(worker as never);
  document.querySelector<HTMLButtonElement>(".cmd-log-raw")?.click();
} else {
  // The way you open it: a tap on the chat's row on the map.
  const tap = () => document.querySelector<HTMLButtonElement>('button.desk-agent-tap[data-use="desks.worker.open-chat"]');
  const wait = setInterval(() => {
    const row = tap();
    if (!row) return;
    clearInterval(wait);
    row.click();
  }, 100);
}
