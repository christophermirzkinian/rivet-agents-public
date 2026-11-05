import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/server/config.js";
import { createApp, type App } from "../src/server/http.js";
import type { PushSender } from "../src/server/push.js";
import { DEFAULT_QUIET } from "../src/shared/quiet.js";

export const ORIGIN = "http://localhost:5230";
export const BOARD_TOKEN = "b".repeat(64);
export const BRIDGE_TOKEN = "c".repeat(64);
export const ENROLL_TOKEN = "e".repeat(64);

export const EXAMPLE_BOARD = {
  updatedAt: "2026-09-28T03:55:18.875Z",
  needs: [
    {
      id: "pr2022-checkout",
      kind: "approval",
      chat: "checkout-feedback",
      since: "2026-09-28T03:05:09.758Z",
      pr: 2022,
      title: "Daily build: Checkout button on the shared bar",
      ask: "Watch the video and approve or send changes.",
      options: [
        { short: "OK", label: "Approve and merge", recommended: true },
        { short: "Changes", label: "Send changes (write them below)" },
      ],
      links: [{ label: "Watch the video", url: "https://claude.ai/artifact/3A1f6kW19m6k6umKNLN", primary: true }],
    },
    {
      id: "billing-retry",
      kind: "decision",
      title: "Billing retry queue",
      risk: "money",
      options: [{ label: "Ship it" }],
    },
  ],
  coming: [{ pr: 2100, title: "Docs refresh" }],
  chats: [{ name: "rivet-app", state: "working", doing: "Building the relay", prs: [], moved: "2026-09-28T03:55:18.875Z" }],
  shipped: [{ pr: 105, title: "Touch action guard", deployed: "partial", deployedNote: "deploying" }],
};

/** The example board plus plain yes/no cards: only a card with no options and no question takes a bare approve. */
export const REPLY_BOARD = {
  ...EXAMPLE_BOARD,
  needs: [
    ...EXAMPLE_BOARD.needs,
    { id: "pr105-touch", kind: "approval", chat: "touch-guard", pr: 105, title: "Touch action guard", ask: "Approve the merge?" },
    { id: "billing-cap", kind: "approval", title: "Billing cap", risk: "money" },
  ],
};

export interface TestServer {
  app: App;
  base: string;
  port: number;
  webRoot: string;
  dataDir: string;
  cookie(): string;
  close(): Promise<void>;
}

export async function startServer(
  env: Record<string, string | undefined> = {},
  options: { pushSender?: PushSender; now?: () => Date; quiet?: boolean; logs?: string[] } = {},
): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "rivet-test-"));
  const webRoot = join(dir, "web");
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>Rivet</title>");
  writeFileSync(join(webRoot, "assets", "main-abc123.js"), "console.log(1)");
  writeFileSync(join(dir, "secret.txt"), "top secret");

  const config = {
    ...loadConfig({
      RIVET_DATA_DIR: join(dir, "data"),
      RIVET_ORIGIN: ORIGIN,
      RIVET_BOARD_TOKEN: BOARD_TOKEN,
      RIVET_BRIDGE_TOKEN: BRIDGE_TOKEN,
      RIVET_ENROLL_TOKEN: ENROLL_TOKEN,
      RIVET_REPOS: process.env.RIVET_REPOS ?? "example-org/example-repo,example-org/other-repo,example-org/third-repo,example-org/mobile-app",
      ...env,
    }),
    webRoot,
  };
  const app = createApp(config, { error: (message: string) => void options.logs?.push(message) }, options);
  // Quiet hours would make every push test depend on the time of day it runs at.
  if (!options.quiet) app.quiet.putSettings({ ...DEFAULT_QUIET, enabled: false });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const port = (app.server.address() as AddressInfo).port;
  return {
    app,
    base: `http://127.0.0.1:${port}`,
    port,
    webRoot,
    dataDir: config.dataDir,
    cookie: () => `__Host-rivet=${app.auth.createSession()}`,
    close: async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The clock a test server's chat windows run on; `advance` moves it past a window's deadline for the next sweep. */
export function fakeClock(start = Date.now()): { now: () => Date; advance(ms: number): void } {
  let at = start;
  return { now: () => new Date(at), advance: (ms) => void (at += ms) };
}

/** Waits for the once-a-second sweep to move an action to `status`. */
export async function waitForStatus(base: string, cookie: string, id: string, status: string): Promise<void> {
  let last = "";
  for (let i = 0; i < 300 && last !== status; i += 1) {
    if (i) await new Promise((resolve) => setTimeout(resolve, 10));
    last = ((await (await fetch(`${base}/api/actions/status?id=${id}`, { headers: { cookie } })).json()) as { status: string }).status;
  }
  if (last !== status) throw new Error(`${id} is ${last}, not ${status}`);
}

/** Headers a same-origin browser request carries. */
export function browser(cookie: string): Record<string, string> {
  return { cookie, origin: ORIGIN, "x-rivet": "1", "content-type": "application/json" };
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

export async function putBoard(base: string, board: unknown = EXAMPLE_BOARD): Promise<Response> {
  return fetch(`${base}/api/board`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify(board) });
}

/**
 * The status of a request whose body the server should refuse as too large.
 * The server answers 413 and closes without reading the body, so a client
 * still writing a big body can see the reset before the answer;
 * that reset counts as the refusal.
 */
export async function oversizedStatus(request: Promise<Response>): Promise<number> {
  try {
    return (await request).status;
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (code === "ECONNRESET" || code === "EPIPE") return 413;
    throw error;
  }
}

/** A raw GET, so the path reaches the server without URL normalisation. */
export function rawGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** The rev GET /api/board serves for a need, as the web app would send it. */
export async function revOf(base: string, cookie: string, itemId: string): Promise<string> {
  const response = await fetch(`${base}/api/board`, { headers: { cookie } });
  const body = (await response.json()) as { board: { needs: { id: string; rev: string }[] } };
  return body.board.needs.find((need) => need.id === itemId)!.rev;
}
