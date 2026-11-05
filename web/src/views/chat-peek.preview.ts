// Dev-only preview of a map row's chat sheet (web/preview/chat-peek.html). A render script may pass a chat's masked
// screen reads as `__PEEK__` (each read as the server would serve it); without it a small made-up screen shows. Each
// poll serves the next read, so the screen updates as it would. ?before=1 shows the same reads in the worker sheet's
// raw log instead. Nothing imports this from the app, so the production build leaves it out.
import { logFeed } from "../../../src/shared/log-feed.js";
import { screenView } from "../../../src/shared/screen-view.js";
import "../styles.css";

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
const board = {
  version: 1,
  updatedAt: ago(0),
  board: { updatedAt: ago(0), needs: [], coming: [], chats: [{ name: data.chat, state: "working", doing: data.doing, updatedAt: ago(1) }], shipped: [], waitingWM: [] },
} as unknown as BoardResponse;
const workers = { at: ago(0), workers: [worker] } as unknown as WorkersResponse;

let read = 0;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
window.fetch = async (input) => {
  const url = new URL(String(input), location.origin);
  const path = url.pathname;
  if (path === "/api/board") return json(board);
  if (path === "/api/workers") return json(workers);
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
