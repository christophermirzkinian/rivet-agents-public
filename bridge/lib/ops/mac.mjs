import os from "node:os";
import path from "node:path";

import { shapeText } from "../redact-cut.mjs";

// Read-only Mac health for the Ops tab: disk free, load, memory pressure, uptime,
// and whether the runners are running. Paths are read here and never sent:
// each volume goes out under a fixed label, runners under their own names.

export const DF_BIN = "/bin/df";
export const MOUNT_BIN = "/sbin/mount";
export const SYSCTL_BIN = "/usr/sbin/sysctl";
export const LAUNCHCTL_BIN = "/bin/launchctl";
export const MAC_TIMEOUT_MS = 10_000;
export const RUNNER_ROOT = path.join(os.homedir(), "actions-runner");
const RUNNER_LABEL_RE = /^actions\.runner\.[A-Za-z0-9._-]+\.([A-Za-z0-9._-]{1,64})$/;
const CHAT_RUNNER_LABEL = "dev.rivet-agents.chat-supervisor";
const MACHINE_NAME_MAX = 64;

/**
 * Rows of `df -k -P`: device, size, free and mount point.
 * @param {string} stdout
 */
export function parseDf(stdout) {
  const rows = [];
  for (const line of stdout.split("\n").slice(1)) {
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    rows.push({ device: match[1], totalBytes: Number(match[2]) * 1024, freeBytes: Number(match[4]) * 1024, mount: match[5] });
  }
  return rows;
}

/**
 * Mount points mounted read-only, from `mount`: an opened installer disk image is one, always 100% full
 * by construction and never able to fill further, so it is no disk to warn about.
 * @param {string} stdout
 */
export function parseReadOnly(stdout) {
  const mounts = new Set();
  for (const line of stdout.split("\n")) {
    const match = /^\S+ on (.+) \(([^()]*)\)$/.exec(line.trim());
    if (match && match[2].split(",").some((opt) => opt.trim() === "read-only")) mounts.add(match[1]);
  }
  return mounts;
}

/**
 * The volumes worth watching, under fixed labels only, since a disk's own name must not
 * leave the Mac: the internal disk as "Data" (or "System" when it has no Data volume),
 * the external volume holding the runners as "Runners", and every other volume under
 * /Volumes as "External 1", "External 2"… in mount order. VM and simulator volumes are left out,
 * as are read-only volumes under /Volumes (an opened installer disk image).
 * @param {ReturnType<typeof parseDf>} rows
 * @param {string | null} runnerDevice the device that holds RUNNER_ROOT
 * @param {Set<string>} [readOnly] mount points mounted read-only
 */
export function volumesFrom(rows, runnerDevice, readOnly = new Set()) {
  const volume = (/** @type {string} */ label, /** @type {(typeof rows)[number]} */ row) => ({
    label,
    totalBytes: row.totalBytes,
    freeBytes: row.freeBytes,
    runners: row.device === runnerDevice,
  });
  const volumes = [];
  const data = rows.find((row) => row.mount === "/System/Volumes/Data" && row.totalBytes > 0);
  const root = rows.find((row) => row.mount === "/" && row.totalBytes > 0);
  if (data) volumes.push(volume("Data", data));
  else if (root) volumes.push(volume("System", root));
  const external = rows.filter((row) => row.mount.startsWith("/Volumes/") && row.totalBytes > 0 && !readOnly.has(row.mount)).sort((a, b) => (a.mount < b.mount ? -1 : 1));
  let n = 0;
  for (const row of external) {
    if (row.device === runnerDevice && !volumes.some((v) => v.runners)) volumes.push(volume("Runners", row));
    else if (n < 10) volumes.push(volume(`External ${(n += 1)}`, row));
  }
  return volumes.slice(0, 12);
}

/**
 * Runner liveness from `launchctl list`: a PID means the job is running.
 * @param {string} stdout
 */
export function parseLaunchctl(stdout) {
  const runners = [];
  let chatRunner = false;
  for (const line of stdout.split("\n").slice(1)) {
    const [pid, , label] = line.split("\t");
    if (!label) continue;
    const alive = /^\d+$/.test(pid ?? "");
    const runner = RUNNER_LABEL_RE.exec(label.trim());
    // A runner's name as launchd labels it, or a word the server's pattern takes where redaction would change the whole
    // label: a secret may span its dots.
    if (runner) runners.push({ name: shapeText(label.trim(), Infinity) === label.trim() ? runner[1] : "redacted", alive });
    else if (label.trim() === CHAT_RUNNER_LABEL && alive) chatRunner = true;
  }
  runners.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  return { runners: runners.slice(0, 50), chatRunner };
}

/** @param {string} value kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical */
export function pressureOf(value) {
  const level = Number(value.trim());
  return level >= 4 ? "critical" : level >= 2 ? "warn" : "normal";
}

/**
 * @param {{ exec: import("../config.mjs").Exec, now?: () => Date,
 *   host?: Pick<typeof os, "loadavg" | "cpus" | "uptime" | "hostname">, runnerRoot?: string, env?: NodeJS.ProcessEnv }} deps
 */
export async function collectMac(deps) {
  const { exec } = deps;
  const host = deps.host ?? os;
  const run = (/** @type {string} */ bin, /** @type {string[]} */ args) => exec(bin, args, { timeout: MAC_TIMEOUT_MS, maxBuffer: 1024 * 1024 }).then((r) => r.stdout);
  const rows = parseDf(await run(DF_BIN, ["-k", "-P"]));
  let runnerDevice = null;
  try {
    runnerDevice = parseDf(await run(DF_BIN, ["-k", "-P", deps.runnerRoot ?? RUNNER_ROOT]))[0]?.device ?? null;
  } catch {}
  // A failed mount read keeps every volume in, as before.
  const readOnly = await run(MOUNT_BIN, []).then(parseReadOnly, () => new Set());
  // A failed read is "unknown", never "normal"; a failed launchctl fails the pass, so the server shows the Mac as stale.
  const memory = await Promise.all([
    run(SYSCTL_BIN, ["-n", "kern.memorystatus_level"]).then((v) => Math.min(100, Math.max(0, Number(v.trim()) || 0))),
    run(SYSCTL_BIN, ["-n", "kern.memorystatus_vm_pressure_level"]).then(pressureOf),
  ]).then(
    ([freePct, pressure]) => ({ freePct, pressure }),
    () => ({ freePct: 0, pressure: "unknown" }),
  );
  const jobs = parseLaunchctl(await run(LAUNCHCTL_BIN, ["list"]));
  const [one, five, fifteen] = host.loadavg();
  const round = (/** @type {number | undefined} */ n) => Math.round((n ?? 0) * 100) / 100;
  return {
    at: (deps.now ?? (() => new Date()))().toISOString(),
    name: shapeText((deps.env ?? process.env).RIVET_MACHINE_NAME?.trim() || host.hostname(), MACHINE_NAME_MAX),
    volumes: volumesFrom(rows, runnerDevice, readOnly),
    load: { one: round(one), five: round(five), fifteen: round(fifteen), cpus: Math.max(1, host.cpus().length) },
    memory,
    uptimeSec: Math.floor(host.uptime()),
    runners: jobs.runners,
    chatRunner: jobs.chatRunner,
  };
}
