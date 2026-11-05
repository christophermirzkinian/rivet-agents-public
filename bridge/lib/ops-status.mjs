import { defaultRepo } from "../../src/shared/repos.ts";

// Ops statuses for the `rivet status` CLI: the server's rules, mirrored from src/shared/ops-status.ts.

export const OPS_STATUS_KINDS = Object.freeze(["ci", "pr", "app", "machine", "runner", "disk", "push", "schedule", "coming"]);
export const OPS_STATUS_STATES = Object.freeze(["investigating", "in-progress", "backlog", "parked", "fixed"]);
export const OPS_STATUS_KEY_RE = /^[a-z0-9][a-z0-9._/-]{0,99}$/;
export const MAX_OPS_STATUS_NOTE = 1000;
export const MAX_OPS_STATUS_ETA = 100;
export const MAX_OPS_STATUS_CAUSE = 100;
export const MAX_OPS_STATUS_PREVENT = 100;
export const MAX_OPS_STATUS_WHY = 140;

// opsStatusKey mirrors src/shared/ops-status-key.ts: the app makes each failed item's key this way.

/** @param {string} name */
function nameHash(name) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(name)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash.toString(36).padStart(7, "0");
}

/** @param {string} name @param {number} max */
function keyPart(name, max) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return slug && slug === name ? slug : `${slug || "x"}_${nameHash(name)}`;
}

/** @param {string} kind @param {string} name @param {string} [repo] @param {NodeJS.ProcessEnv} [env] */
export function opsStatusKey(kind, name, repo, env = process.env) {
  const main = defaultRepo(env) ?? "";
  const named = repo ?? main;
  const prefix = named.toLowerCase() === main.toLowerCase() ? "" : `${keyPart((named.split("/").pop() ?? named).toLowerCase(), 30)}/`;
  if (kind === "pr") return `${prefix}${name}`;
  if (kind === "ci" || kind === "coming") return `${prefix}${keyPart(name, 52)}`;
  return keyPart(name, 52);
}

/**
 * @typedef {{ kind: string, key: string, state: string, note?: string, eta?: string, chat?: string, pr?: number,
 *   issue?: number, since: string, updatedAt: string, by?: string, version: number, dueAt?: string, why?: string,
 *   askedForTimeAt?: string, cause?: string, prevent?: string, repo?: string, dueHistory?: unknown[] }} OpsStatus
 */
