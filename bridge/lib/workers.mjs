import { createHash } from "node:crypto";

import { shapeText } from "./redact-cut.mjs";
import { isChatName } from "./validate.mjs";
import { defaultRepo, isRepo, repoAllowlist } from "../../src/shared/repos.ts";

/** The server's AGENT_RE, BRANCH_RE and MAX_WORKERS (src/shared/workers.ts). */
const AGENT_RE = /^[A-Za-z0-9._-]{1,40}$/;
const BRANCH_RE = /^(?![/.-])(?!.*(?:\.\.|\/\/|\/\.|\/$|\.lock$))[A-Za-z0-9._/-]{1,200}$/;
export const MAX_WORKERS = 300;

/**
 * @typedef {{ worktreeId: string, repo: string, chat: string, connected: boolean,
 *   lastOutputAt: number | null, agent: string, busy: boolean | null, branch?: string, startedAt?: number }} SnapshotWorker
 */

/**
 * The agent's own status glyph at the head of its terminal title: a spinner
 * (◐◑◒◓ or a braille dot) while it works, ✳ while it waits for input. Only
 * this boolean leaves the Mac; the title's words never do.
 * @param {unknown} title
 * @returns {boolean | null}
 */
export function titleBusy(title) {
  if (typeof title !== "string") return null;
  const glyph = String.fromCodePoint(title.trimStart().codePointAt(0) ?? 32);
  if (/^[\u25D0-\u25D3\u2801-\u28FF]$/u.test(glyph)) return true;
  if (glyph === "\u2733") return false;
  return null;
}

/**
 * A stable key for a chat that says nothing about the Mac it runs on.
 * @param {string} localId
 */
export function opaqueWorkerId(localId) {
  return createHash("sha256").update(localId, "utf8").digest("hex").slice(0, 16);
}

/**
 * The branch the chat's folder has checked out ("refs/heads/<name>"); null when detached or not a plain name. One that
 * redaction would change is not sent.
 * @param {unknown} ref
 */
export function branchName(ref) {
  const name = typeof ref === "string" && ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
  return BRANCH_RE.test(name) && shapeText(name, Infinity) === name ? name : null;
}

/** @param {unknown} v */
function outputTime(v) {
  const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) && t >= 0 ? Math.floor(t) : null;
}

/**
 * What PUT /api/bridge/workers carries: one entry per agent chat, metadata only, newest output first. Each field is
 * copied by name, so nothing else a chat reports (its title words or output) can reach the server. A chat's repo is its
 * own when the runner names an `owner/name`, else the default repo; a chat with neither is left out.
 * @param {import("./terminals.mjs").Terminal[]} terminals
 * @returns {{ workers: SnapshotWorker[] }}
 */
export function workerSnapshot(terminals) {
  return { workers: chatWorkers(terminals).slice(0, MAX_WORKERS) };
}

/**
 * @param {import("./terminals.mjs").Terminal[]} terminals
 * @returns {SnapshotWorker[]}
 */
function chatWorkers(terminals) {
  /** @type {Map<string, SnapshotWorker>} */
  const byName = new Map();
  for (const t of terminals) {
    const chat = t.handle;
    if (!t.agentIdentity || !isChatName(chat) || shapeText(chat, Infinity) !== chat || byName.has(chat)) continue;
    const repo = isRepo(t.repo) ? t.repo : defaultRepo();
    if (!repo) continue;
    const connected = t.connected === true;
    const branch = branchName(t.branch);
    const agent = typeof t.agentIdentity === "string" && AGENT_RE.test(t.agentIdentity) && shapeText(t.agentIdentity, Infinity) === t.agentIdentity ? t.agentIdentity : "agent";
    byName.set(chat, {
      worktreeId: opaqueWorkerId(chat),
      repo,
      chat,
      // A chat waiting for its agent to restart is still on the board: it has not closed.
      connected: connected || t.pending === true,
      lastOutputAt: outputTime(t.lastOutputAt),
      agent,
      // A disconnected chat's title is whatever it showed when it went away.
      busy: connected ? titleBusy(t.title) : null,
      ...(branch ? { branch } : {}),
      ...(t.startedAt !== undefined ? { startedAt: t.startedAt } : {}),
    });
  }
  return [...byName.values()].sort((a, b) => (b.lastOutputAt ?? -1) - (a.lastOutputAt ?? -1));
}

/**
 * Live (connected) chats per repo in RIVET_REPOS, zeros included, for `--check`.
 * @param {import("./terminals.mjs").Terminal[]} terminals
 */
export function liveWorkersByRepo(terminals) {
  const counts = new Map(repoAllowlist().map((repo) => [repo, 0]));
  for (const w of chatWorkers(terminals)) if (w.connected) counts.set(w.repo, (counts.get(w.repo) ?? 0) + 1);
  return [...counts].map(([repo, live]) => `${repo} ${live}`).join(", ") || "no repos in RIVET_REPOS";
}
