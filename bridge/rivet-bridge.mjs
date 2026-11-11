#!/usr/bin/env node
// Rivet bridge: holds one outbound SSE connection to the Rivet server and carries fixed actions only (type a line into
// a chat through the chat runner, scripts/rivet-chat.mjs; post a GitHub comment on a repo in RIVET_REPOS; ack). It
// never runs a command it was sent. Every 20 s it also sends the live agent chats (metadata only). It also sends the Ops
// readings (lib/ops/), the schedules (lib/schedules/) and the spend (lib/spend.mjs). The thread titler
// (lib/threads-titler.mjs) names new chat threads with the local Claude CLI, and the row titler (lib/row-titler.mjs)
// gives asks and chat rows short titles the same way. Installed to ~/.rivet-agents/bridge/ by scripts/install-bridge.sh.
//
//   node rivet-bridge.mjs             run the daemon
//   node rivet-bridge.mjs --check     verify token, server, chat runner, gh and the monitor chat
//   node rivet-bridge.mjs --spend     print one spend reading
//   node rivet-bridge.mjs --usage     print one Claude usage reading
//   node rivet-bridge.mjs --schedules print one schedules reading
import { createBridge, runLoop, runWorkerFeed } from "./lib/bridge.mjs";
import { acquireInstanceLock } from "./lib/instance.mjs";
import { runLogRotateLoop } from "./lib/log-rotate.mjs";
import { fingerprint, formatLog, makeExec, readToken, resolveBin, serverOrigin } from "./lib/config.mjs";
import { collectClaude } from "./lib/ops/claude.mjs";
import { createFalseAlarmRetry } from "./lib/ops/false-alarm.mjs";
import { runOpsLoop } from "./lib/ops/index.mjs";
import { runModelReportLoop } from "./lib/model-routing.mjs";
import { createCollector, runSchedulesLoop } from "./lib/schedules/index.mjs";
import { aggregate, collect, emptyState, runSpendLoop } from "./lib/spend.mjs";
import { StateStore } from "./lib/state.mjs";
import { runTitlerLoop } from "./lib/threads-titler.mjs";
import { runRowTitlerLoop } from "./lib/row-titler.mjs";
import { CHAT_CLI, createChatRunner } from "./lib/chat-source.mjs";
import { resolveChatTerminal } from "./lib/terminals.mjs";
import { isChatName } from "./lib/validate.mjs";
import { liveWorkersByRepo } from "./lib/workers.mjs";
import { repoAllowlist } from "../src/shared/repos.ts";

const USAGE = "usage: node rivet-bridge.mjs [--check | --spend | --usage | --schedules]\n";

/** @param {string} event @param {Record<string, unknown>} [fields] */
function log(event, fields) {
  process.stdout.write(`${formatLog(event, fields)}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.length > 1 || args.some((a) => !["--check", "--spend", "--usage", "--schedules"].includes(a))) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (args.includes("--spend")) {
    const scan = emptyState();
    const { files, records, skipped } = await collect(scan);
    process.stdout.write(`${JSON.stringify({ files, records, skippedLines: skipped, ...aggregate(scan) }, null, 2)}\n`);
    return 0;
  }
  if (args.includes("--usage")) {
    process.stdout.write(`${JSON.stringify(await collectClaude({ exec: makeExec(), fetch }), null, 2)}\n`);
    return 0;
  }
  if (args.includes("--schedules")) {
    const collector = createCollector({ exec: makeExec(), ghBin: resolveBin("gh") });
    process.stdout.write(`${JSON.stringify(await collector.collect({ force: true }), null, 2)}\n`);
    return 0;
  }
  const check = args.includes("--check");

  const origin = serverOrigin(process.env.RIVET_URL || undefined);
  const monitorChat = process.env.RIVET_MONITOR_CHAT || null;
  if (monitorChat !== null && !isChatName(monitorChat)) throw new Error("RIVET_MONITOR_CHAT is not a valid chat name");
  const ghBin = resolveBin("gh");
  const exec = makeExec();
  const chatRunner = createChatRunner({ exec });

  if (check) return runCheck({ origin, monitorChat, ghBin, exec, chatRunner });

  const lock = await acquireInstanceLock();
  if (!lock.ok) {
    log("already-running", { reason: lock.reason });
    return 1;
  }
  const token = await readToken(exec, "RIVET_BRIDGE_TOKEN");
  const state = new StateStore(undefined, { log }).load();
  log("start", { origin, monitor: monitorChat, token: fingerprint(token), gh: ghBin, repos: repoAllowlist().length });

  const stopCtrl = new AbortController();
  for (const sig of /** @type {const} */ (["SIGTERM", "SIGINT"])) {
    process.once(sig, () => {
      log("stopping", { signal: sig });
      stopCtrl.abort();
    });
  }
  runLogRotateLoop({ stop: stopCtrl.signal, log });
  const models = runModelReportLoop({ origin, token, fetch, log, stop: stopCtrl.signal });
  const bridge = createBridge({ origin, token, ghBin, gitBin: optionalBin("git"), monitorChat, chatRunner, exec, fetch, state, log, onConnected: models.kick });
  const stop = stopCtrl.signal;
  const falseAlarm = createFalseAlarmRetry({ exec, ghBin, log });
  const spend = runSpendLoop({ origin, token, fetch, log, stop });
  const ops = runOpsLoop({ origin, token, fetch, exec, ghBin, flyBin: optionalBin("flyctl"), codexBin: optionalBin("codex"), log, stop, falseAlarm });
  const schedules = runSchedulesLoop({ origin, token, fetch, exec, ghBin, log, stop, falseAlarm });
  const titler = runTitlerLoop({ origin, token, fetch, claudeBin: optionalBin("claude"), log, stop: stopCtrl.signal });
  const rowTitler = runRowTitlerLoop({ origin, token, fetch, claudeBin: optionalBin("claude"), log, stop: stopCtrl.signal });
  await Promise.all([runLoop(bridge, { stop: stopCtrl.signal, log }), runWorkerFeed(bridge, { stop: stopCtrl.signal, log }), spend, ops, schedules, titler, rowTitler, models.done]);
  log("stopped");
  return 0;
}

/** A binary the bridge can run without; null when it is not on PATH. @param {string} name */
function optionalBin(name) {
  try {
    return resolveBin(name);
  } catch {
    return null;
  }
}

/**
 * @param {{ origin: string, monitorChat: string | null, ghBin: string, exec: import("./lib/config.mjs").Exec,
 *   chatRunner: import("./lib/chat-source.mjs").ChatRunner }} ctx
 */
async function runCheck({ origin, monitorChat, ghBin, exec, chatRunner }) {
  let failed = false;
  /** @param {string} name @param {() => Promise<string>} fn */
  const step = async (name, fn) => {
    try {
      process.stdout.write(`ok   ${name}: ${await fn()}\n`);
    } catch (err) {
      failed = true;
      const e = /** @type {any} */ (err);
      const cause = typeof e?.cause?.code === "string" ? ` (${e.cause.code})` : "";
      process.stdout.write(`FAIL ${name}: ${e?.message ?? "error"}${cause}\n`);
    }
  };
  await step("token", async () => `fingerprint ${fingerprint(await readToken(exec, "RIVET_BRIDGE_TOKEN"))}`);
  await step("server", async () => {
    const res = await fetch(`${origin}/healthz`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    await res.body?.cancel().catch(() => {});
    if (!res.ok) throw new Error(`${origin}/healthz http ${res.status}`);
    return `${origin}/healthz ${res.status}`;
  });
  /** @type {import("./lib/terminals.mjs").Terminal[] | null} */
  let terminals = null;
  await step("chats", async () => {
    terminals = await chatRunner.list();
    return `${terminals.length} chats (${CHAT_CLI})`;
  });
  // GitHub is optional: with no RIVET_REPOS the bridge comments nowhere, so gh need not be signed in.
  const repos = repoAllowlist();
  if (repos.length === 0) {
    process.stdout.write("ok   repos: none set (RIVET_REPOS): answers go to your chats only, no GitHub comments\n");
  } else {
    await step("gh", async () => {
      const { stdout } = await exec(ghBin, ["api", "user", "--jq", ".login"], { timeout: 30_000 });
      const login = stdout.trim();
      if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new Error("gh returned no login");
      return `signed in as ${login} (${ghBin})`;
    });
    await step("repos", async () => repos.join(", "));
  }
  await step("monitor", async () => {
    if (!monitorChat) return "none set (RIVET_MONITOR_CHAT): lines for a stopped chat start a new one";
    if (!terminals) throw new Error("chat runner unavailable");
    const found = resolveChatTerminal(terminals, monitorChat);
    if (!found.handle) throw new Error(`chat "${monitorChat}": ${found.reason === "ambiguous" ? "more than one chat" : "not running"}`);
    return monitorChat;
  });
  await step("workers", async () => {
    if (!terminals) throw new Error("chat runner unavailable");
    return `running per repo: ${liveWorkersByRepo(terminals)}`;
  });
  return failed ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    log("fatal", { error: err instanceof Error ? err.message : "error" });
    process.exitCode = 1;
  },
);
