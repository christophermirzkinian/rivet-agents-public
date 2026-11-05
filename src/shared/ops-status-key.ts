import type { OpsStatusKind } from "./ops-status.js";
import { KNOWN_REPOS, NO_REPO } from "./repos.js";

// A failed Ops item's status key, made from its own data. Kept apart from ops-status.ts so the web app can use it without
// bundling zod; bridge/lib/ops-status.mjs mirrors it for `rivet status key`.

/** The longest name part and repo part: with "_", a hash and "/", a key stays within its 100 characters. */
const NAME_MAX = 52;
const REPO_MAX = 30;

/** FNV-1a over the name's UTF-8 bytes, in base 36: seven characters. */
function nameHash(name: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(name)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash.toString(36).padStart(7, "0");
}

/**
 * The name itself when it is already a plain slug (a-z, 0-9, "." and "-"); otherwise its slug, cut to `max`, then "_"
 * and a hash of the exact name, so names that slug alike ("Lint API", "Lint_API") or share a long start never share a
 * key. A slug never holds "_", so a hashed part never equals a plain one.
 */
function keyPart(name: string, max: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return slug && slug === name ? slug : `${slug || "x"}_${nameHash(name)}`;
}

/**
 * ci: the workflow name; pr: the number; app: its name on the Ops list; runner: the runner name; disk: the volume label;
 * machine: "mac"; schedule: the schedule's id; coming: the PR number, else the item's name. A ci, pr or coming key
 * outside the default repo starts with the repo's name, lowercased (GitHub names a repo without regard to case), and "/".
 */
export function opsStatusKey(kind: OpsStatusKind, name: string, repo: string = NO_REPO): string {
  const prefix = repo.toLowerCase() === NO_REPO.toLowerCase() ? "" : `${keyPart((repo.split("/").pop() ?? repo).toLowerCase(), REPO_MAX)}/`;
  if (kind === "pr") return `${prefix}${name}`;
  if (kind === "ci" || kind === "coming") return `${prefix}${keyPart(name, NAME_MAX)}`;
  return keyPart(name, NAME_MAX);
}

/** The repo a ci, pr or coming key names: the one whose "<repo>/" prefix opsStatusKey gives it (a PR key is that prefix alone), else the default repo. */
export function statusKeyRepo(kind: string, key: string): string {
  if (kind !== "pr" && kind !== "ci" && kind !== "coming") return NO_REPO;
  return KNOWN_REPOS.find((repo) => repo !== NO_REPO && key.startsWith(opsStatusKey("pr", "", repo))) ?? NO_REPO;
}
