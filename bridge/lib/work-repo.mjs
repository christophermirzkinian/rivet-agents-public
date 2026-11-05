// The repo a chat's work is in. A chat can run in one repo's worktree and work in a clone under ~/.rivet-agents/work, so
// its worktree's repo can be the wrong one. Only the allow-listed repo name leaves the Mac: never a path or a brief's words.
import { stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { folderRepo } from "./folder-repo.mjs";
import { repoAllowlist } from "../../src/shared/repos.ts";

const CACHE_MS = 10 * 60_000;
const MAX_FOLDERS = 10;
/** The most of a brief read for its repo, in characters. */
const MAX_BRIEF = 64 * 1024;

/** @param {string | undefined} repo */
const known = (repo) => (repo === undefined ? undefined : repoAllowlist().find((one) => one.toLowerCase() === repo.toLowerCase()));

/**
 * The names a chat's folders and brief go by, in order: its name, less a `-2` or `-a3` suffix, less a stage word.
 * @param {string} chat
 */
export function chatStems(chat) {
  const stems = [chat];
  const bare = chat.replace(/-(?:\d+|[0-9a-f]{2})$/, "");
  stems.push(bare, bare.replace(/-(?:plan|build|publish)$/, ""));
  return [...new Set(stems.filter((stem) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stem) && !stem.includes("..")))];
}

/**
 * The repos a brief names: an explicit `Project:` or `Repo:` line wins; else the clones under ~/.rivet-agents/work it
 * names and the owner/name it spells, kept to the allow-list.
 * @param {string} text
 * @returns {{ explicit?: string, folders: string[], spelled: string[] }}
 */
export function briefNames(text) {
  // A brief is a page or two; a cap and no newline-spanning `\s` keep a huge one from stalling the snapshot loop.
  text = text.slice(0, MAX_BRIEF);
  const line = /^[ \t>*-]*(?:\*\*)?(?:project|repo)(?:\*\*)?[ \t]*:(?:\*\*)?[ \t]*`?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?`?(?=[\s.,;)]|$)/im.exec(text);
  if (line) return { explicit: line[1], folders: [], spelled: [] };
  const folders = [...new Set([...text.matchAll(/\.rivet-agents\/work\/([A-Za-z0-9_-][A-Za-z0-9._-]*)/g)].map((m) => m[1].replace(/\.+$/, "")))].slice(0, MAX_FOLDERS);
  const spelled = repoAllowlist().filter((repo) => new RegExp(`(?<![A-Za-z0-9_.-])${repo.replace(/[.]/g, "\\.")}(?![A-Za-z0-9_-])`, "i").test(text));
  return { folders, spelled };
}

/**
 * @typedef {{ exec: import("./config.mjs").Exec, git: () => string, home?: string,
 *   read?: (file: string) => Promise<string>, exists?: (dir: string) => Promise<boolean> }} WorkRepoDeps
 */

/**
 * The allow-listed repo of a chat's work, or undefined when it cannot tell: its clone by name, else its brief, else
 * (a brief naming none) its worktree's repo. Never throws.
 * @param {WorkRepoDeps} deps @param {{ chat: string, repo: string }} worker
 */
export async function workRepo(deps, worker) {
  const home = deps.home ?? homedir();
  const out = join(home, ".rivet-agents", "work");
  // Only a regular file: a FIFO or a device would block the snapshot loop.
  const read = deps.read ?? (async (file) => ((await stat(file)).isFile() ? readFile(file, "utf8") : undefined));
  const exists = deps.exists ?? ((dir) => stat(dir).then((s) => s.isDirectory(), () => false));
  /** @param {string} dir */
  const origin = async (dir) => {
    if (!(await exists(dir))) return undefined;
    return known(await folderRepo(deps.exec, deps.git, dir).catch(() => undefined));
  };
  /** @param {string} name */
  const clone = async (name) => (await origin(join(out, name, "repo"))) ?? origin(join(out, name));
  try {
    const stems = chatStems(worker.chat);
    for (const stem of stems) {
      const repo = await clone(stem);
      if (repo) return repo;
    }
    for (const stem of stems) {
      const text = await read(join(home, ".rivet-agents", "briefs", `${stem}.md`)).catch(() => undefined);
      if (text === undefined) continue;
      const names = briefNames(text);
      if (names.explicit !== undefined) return known(names.explicit);
      const repos = new Set(names.spelled);
      for (const folder of names.folders) {
        const repo = await clone(folder);
        if (repo) repos.add(repo);
      }
      return repos.size === 1 ? [...repos][0] : repos.size ? undefined : known(worker.repo);
    }
  } catch {
    // Unread: the server falls back to the worktree's repo and says it is a guess.
  }
  return undefined;
}

/**
 * workRepo per chat, held CACHE_MS so the 20 s workers push does not run git each time.
 * @param {WorkRepoDeps & { now?: () => number }} deps
 */
export function createWorkRepos(deps) {
  const now = deps.now ?? Date.now;
  /** @type {Map<string, { at: number, repo: string | undefined }>} */
  const cache = new Map();
  /** @param {{ chat: string, repo: string }} worker */
  return async (worker) => {
    const key = `${worker.repo}\n${worker.chat}`;
    for (const [one, { at }] of cache) if (now() - at >= CACHE_MS) cache.delete(one);
    const held = cache.get(key);
    if (held) return held.repo;
    const repo = await workRepo(deps, worker);
    cache.set(key, { at: now(), repo });
    return repo;
  };
}
