// Kept apart from board.ts so the web app can use them without bundling zod. Only the server, bridge and scripts call
// repoAllowlist and defaultRepo: the web app has no environment to read.

/** A GitHub `owner/name`. */
export const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export function isRepo(s: unknown): s is string {
  return typeof s === "string" && REPO_RE.test(s) && !s.endsWith("/.") && !s.endsWith("/..");
}

/** The repos named in RIVET_REPOS (comma-separated `owner/name`), malformed entries dropped, in the order given. */
export function repoAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const named = (env.RIVET_REPOS ?? "").split(",").map((one) => one.trim()).filter(isRepo);
  return [...new Set(named)];
}

/**
 * The repo a row naming none belongs to; "" until setDefaultRepo names one. Read on the server from RIVET_REPOS and in
 * the web app from the Ops payload, so both key an item alike.
 */
export let NO_REPO = "";

/** Every repo this install works in; the server sets it from RIVET_REPOS, and the web app leaves it empty. */
export let KNOWN_REPOS: readonly string[] = [];

/** A repo this install works in. The shape alone would let a write name any repo the bridge's gh login can reach. */
export function isKnownRepo(s: unknown): s is string {
  return isRepo(s) && KNOWN_REPOS.includes(s);
}

export function setDefaultRepo(repo: string | null): void {
  NO_REPO = repo ?? "";
}

export function setKnownRepos(repos: readonly string[]): void {
  KNOWN_REPOS = repos;
}

/** The first repo of RIVET_REPOS, or null when none is set. */
export function defaultRepo(env: NodeJS.ProcessEnv = process.env): string | null {
  return repoAllowlist(env)[0] ?? null;
}
