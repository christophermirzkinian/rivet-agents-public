import { ancestryCache, provePatchMerges, refreshHistory } from "./ancestry.mjs";
import { BACKLOG_INTERVAL_MS, collectBacklog } from "./backlog.mjs";
import { CLAUDE_INTERVAL_MS, collectClaude, limitedUsage, MAX_LIMITS, writeUsageFile } from "./claude.mjs";
import { CODEX_INTERVAL_MS, CODEX_STALE_MS, collectCodex } from "./codex.mjs";
import { collectFly, emptyFlyCache, flyApps } from "./fly.mjs";
import { collectGithub, emptyGithubCache } from "./github.mjs";
import { collectHome, haBaseUrl } from "./home.mjs";
import { HOLDS_FILE } from "../holds-file.mjs";
import { collectMac } from "./mac.mjs";
import { putSnapshot } from "../snapshot-compat.mjs";
import { defaultRepo } from "../../../src/shared/repos.ts";

// The Ops collectors: Mac health and GitHub every minute, Claude usage every two, Codex (OpenAI) usage, Fly and each
// repo's open issues every five minutes, Home Assistant every minute, as separate loops so a slow Fly pass never delays
// the rest. Fly and Home Assistant run only with their settings. Each pass sends one PUT with the bridge token; a failure
// is logged and the next pass tries again. They read only; nothing they run changes anything, apart from fetching main
// into the bridge's own history clone (RIVET_HISTORY_REPO) and, when given a falseAlarm, re-running a red CI run on main
// once when it failed on a GitHub hiccup (./false-alarm.mjs).

export const OPS_INTERVAL_MS = 60_000;
export const FLY_INTERVAL_MS = 5 * 60_000;
const UNAUTHORIZED_MS = 5 * 60_000;
const HTTP_TIMEOUT_MS = 15_000;

export class Unauthorized extends Error {}

/**
 * @param {{ origin: string, token: string, fetch: typeof fetch, exec: import("../config.mjs").Exec,
 *   ghBin: string, flyBin: string | null, codexBin?: string | null, log: (event: string, fields?: Record<string, unknown>) => void,
 *   stop: AbortSignal, now?: () => Date, sleep?: (ms: number, stop: AbortSignal) => Promise<void>,
 *   usageFile?: string | null, holdsFile?: string | null,
 *   falseAlarm?: ReturnType<typeof import("./false-alarm.mjs").createFalseAlarmRetry> | null, haUrl?: string | null }} deps (usageFile
 *   null writes no file; holdsFile null reads no merge holds file, absent reads HOLDS_FILE; falseAlarm absent or null re-runs
 *   nothing; haUrl absent reads RIVET_HA_URL, and with neither the Home page stays unread)
 */
export function runOpsLoop(deps) {
  const { origin, token, log, stop } = deps;
  const sleep = deps.sleep ?? abortableSleep;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const cache = emptyGithubCache();
  const flyCache = emptyFlyCache();
  const patchCache = ancestryCache();
  /** The latest Codex rows and when they were read; they ride on the Claude usage PUT. */
  let codex = { rows: /** @type {Awaited<ReturnType<typeof collectCodex>>} */ ([]), at: 0 };
  const nowMs = () => (deps.now ?? (() => new Date()))().getTime();

  /** @param {string} path @param {"GET" | "PUT"} method @param {unknown} [body] */
  async function call(path, method, body) {
    const send = (payload) => deps.fetch(`${origin}${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const res = method === "PUT" ? await putSnapshot(send, body) : await send(body);
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new Unauthorized(`http ${res.status}`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`${path} http ${res.status}`);
    }
    return res.json().catch(() => null);
  }

  /** @param {string} name @param {number} interval @param {() => Promise<void>} pass */
  async function every(name, interval, pass) {
    while (!stop.aborted) {
      let delay = interval;
      try {
        await pass();
      } catch (err) {
        if (err instanceof Unauthorized) delay = UNAUTHORIZED_MS;
        log(`ops-${name}-failed`, { error: err instanceof Error ? err.message.slice(0, 200) : "error" });
      }
      await sleep(delay, stop);
    }
  }

  const loops = [
    every("mac", OPS_INTERVAL_MS, async () => {
      await call("/api/bridge/ops/mac", "PUT", await collectMac({ exec: deps.exec, now: deps.now }));
    }),
    every("claude", CLAUDE_INTERVAL_MS, async () => {
      // A failed reading is logged and the pass goes on: the Codex rows still reach the server, so one collector never
      // stops the other.
      let snapshot = await collectClaude({ exec: deps.exec, fetch: deps.fetch, now: deps.now }).catch((/** @type {unknown} */ err) => {
        log("ops-claude-usage-failed", { error: err instanceof Error ? err.message.slice(0, 200) : "error" });
        return null;
      });
      if (snapshot && deps.usageFile !== null) writeUsageFile(snapshot, deps.usageFile);
      // A limited account's last reading stands in for a failed one, after the write: the file keeps the real reading.
      snapshot ??= limitedUsage({ file: deps.usageFile, now: deps.now });
      const openai = nowMs() - codex.at <= CODEX_STALE_MS ? codex.rows : [];
      const limits = [...(snapshot?.limits ?? []), ...openai].slice(0, MAX_LIMITS);
      // The server takes one row at least: with none there is nothing new to say.
      if (!limits.length) return;
      await call("/api/bridge/ops/claude", "PUT", { at: snapshot?.at ?? new Date(nowMs()).toISOString(), limits });
    }),
    every("github", OPS_INTERVAL_MS, async () => {
      const snapshot = await collectGithub({ exec: deps.exec, ghBin: deps.ghBin, now: deps.now, cache, log, holdsFile: deps.holdsFile === undefined ? HOLDS_FILE : deps.holdsFile });
      if (deps.falseAlarm) snapshot.runs = await deps.falseAlarm.cycle(snapshot.runs);
      await call("/api/bridge/ops/github", "PUT", snapshot);
    }),
    every("backlog", BACKLOG_INTERVAL_MS, async () => {
      const snapshot = await collectBacklog({ exec: deps.exec, ghBin: deps.ghBin, now: deps.now });
      await call("/api/bridge/ops/backlog", "PUT", snapshot);
      log("ops-backlog", { repos: snapshot.repos.length });
    }),
  ];
  const { codexBin } = deps;
  if (codexBin) {
    /** Each pool home's last reading, kept across passes (the per-home read TTL and the stale rows). */
    const codexCache = new Map();
    loops.push(
      every("codex", CODEX_INTERVAL_MS, async () => {
        codex = { rows: await collectCodex({ codexBin, now: nowMs, cache: codexCache }), at: nowMs() };
      }),
    );
  } else {
    log("ops-codex-off", { reason: "codex not on PATH" });
  }
  const flyBin = deps.flyBin;
  const apps = flyApps();
  if (flyBin && apps.length) {
    loops.push(
      every("fly", FLY_INTERVAL_MS, async () => {
        const snapshot = await collectFly({ exec: deps.exec, flyBin, apps, now: deps.now, cache: flyCache, log });
        const historyRepo = process.env.RIVET_HISTORY_REPO;
        await provePatchMerges(snapshot, cache.merged.get(defaultRepo())?.value ?? [], { exec: deps.exec, repo: historyRepo, cache: patchCache });
        await call("/api/bridge/ops/fly", "PUT", snapshot);
        log("ops-fly", { apps: snapshot.apps.length, failed: snapshot.source.failed.length });
        // After the PUT, so a slow fetch never delays it; the next pass proves against what it brought.
        await refreshHistory(deps.exec, historyRepo).catch(() => log("ops-history-fetch-failed"));
      }),
    );
  } else {
    log("ops-fly-off", { reason: flyBin ? "RIVET_FLY_APPS not set" : "flyctl not on PATH" });
  }
  const haUrl = deps.haUrl ?? haBaseUrl();
  if (haUrl) {
    const homeCache = { token: /** @type {string | null} */ (null) };
    loops.push(
      every("home", OPS_INTERVAL_MS, async () => {
        await call("/api/bridge/home", "PUT", await collectHome({ fetch: deps.fetch, exec: deps.exec, haUrl, now: deps.now, cache: homeCache }));
      }),
    );
  }
  return Promise.all(loops).then(() => undefined);
}

/** @param {number} ms @param {AbortSignal} stop */
function abortableSleep(ms, stop) {
  return new Promise((resolve) => {
    if (stop.aborted) return resolve(undefined);
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      stop.removeEventListener("abort", done);
      resolve(undefined);
    }
    stop.addEventListener("abort", done, { once: true });
  });
}
