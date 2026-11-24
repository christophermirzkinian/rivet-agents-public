// The repo a card's --pr names when no --repo is given: the working folder's. A chat in another repo's
// checkout that leaves --repo off would otherwise name the default repo's PR of that number.
import { defaultRepo, repoAllowlist } from "../../src/shared/repos.ts";

const REMOTE_RE =
  /^(?:(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/|[^@/\s:]+@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i;

/**
 * owner/name of a GitHub remote URL (https, ssh or scp form, any host case, a port allowed), or undefined for any other.
 * @param {string} url
 */
export function remoteRepo(url) {
  return REMOTE_RE.exec(url.trim())?.[1];
}

/**
 * The working folder's GitHub repo by its origin remote, or undefined when the folder is no checkout or has no origin.
 * Throws when it cannot tell (no git, a timeout, an origin that is not a GitHub URL), so the caller asks for --repo
 * rather than guess the default repo.
 * @param {import("./config.mjs").Exec} exec @param {() => string} git the git binary; may throw when there is none
 * @param {string} cwd
 */
export async function folderRepo(exec, git, cwd) {
  const unread = "--pr has no --repo and this folder's repo could not be read";
  let bin;
  try {
    bin = git();
  } catch {
    throw new Error(`${unread} (no git): give --repo`);
  }
  let stdout;
  try {
    ({ stdout } = await exec(bin, ["-C", cwd, "remote", "get-url", "origin"], { timeout: 10_000 }));
  } catch (err) {
    const line = String(/** @type {any} */ (err)?.stderrFirstLine ?? "");
    // Only git's "no repository here" and "no origin": a broken checkout (a .git file pointing nowhere says "not a
    // git repository: <path>") is unreadable, not "no checkout".
    if (/not a git repository \(or any|no such remote 'origin'/i.test(line)) return undefined;
    throw new Error(`${unread} (${/** @type {Error} */ (err)?.message ?? "git failed"}): give --repo`);
  }
  const repo = remoteRepo(stdout);
  // The URL is not echoed: an https origin can carry a token.
  if (repo === undefined) throw new Error("--pr has no --repo and this folder's origin is not a GitHub URL: give --repo");
  return repo;
}

/**
 * The repo to send with a --pr that came with no --repo: undefined (the server's default) unless the folder is a
 * checkout of another repo, then that repo as RIVET_REPOS spells it. Throws for a repo Rivet does not know, so
 * the card is refused rather than pointed at the default repo's PR.
 * @param {number} pr @param {string | undefined} folder folderRepo's answer
 */
export function prRepo(pr, folder) {
  if (folder === undefined || folder.toLowerCase() === defaultRepo()?.toLowerCase()) return undefined;
  const repos = repoAllowlist();
  const known = repos.find((repo) => repo.toLowerCase() === folder.toLowerCase());
  if (known) return known;
  throw new Error(`--pr ${pr} has no --repo and this folder is ${folder}, which Rivet does not know: give --repo, one of ${repos.join(", ") || "RIVET_REPOS (none set)"}`);
}

/**
 * The repo a card's --pr names by its chat: the repo the board's chat of that name is in, when its row names
 * one. A card is often posted for a chat from another folder (the monitor's), so the chat's repo comes before the
 * folder's. The rows are picked as the server picks a Coming row's: a chat name is only
 * unique within a repo, so the rows holding the PR decide, else all of the name; `search-box` stands for `search-box-73`
 * when no chat has that name, and then the default repo is a candidate too unless that chat holds the PR. Unlike a
 * Coming row, a row that names no repo, or one Rivet does not know, says nothing here (it may never have been given
 * one): when no row names a repo the folder decides as before, and `repo` is undefined. Rows that leave more than one
 * candidate leave `among`, the repos to pick from (the default for a row naming none): the caller refuses and asks
 * for --repo, as the folder (often the monitor's main checkout) is no tie-break.
 * @param {unknown} chats the board's chats @param {unknown} name the card's chat @param {number} pr
 * @returns {{ repo?: string, among?: string[] }}
 */
export function chatPrRepo(chats, name, pr) {
  if (typeof name !== "string" || !name || !Array.isArray(chats)) return {};
  const exact = chats.filter((chat) => chat?.name === name);
  const base = name.replace(/-\d+$/, "");
  const named = exact.length || base === name ? exact : chats.filter((chat) => chat?.name === base);
  const holding = named.filter((chat) => Array.isArray(chat?.prs) && chat.prs.includes(pr));
  const known = repoAllowlist();
  const said = (holding.length ? holding : named).map((chat) => (known.includes(chat?.repo) ? /** @type {string} */ (chat.repo) : undefined));
  const repos = /** @type {string[]} */ (said.filter(Boolean));
  if (!repos.length) return {};
  // A row naming no repo, and a base chat that does not hold the PR, leave the default repo in the running.
  const loose = said.includes(undefined) || (!exact.length && !holding.length);
  const fallback = defaultRepo();
  const among = [...new Set([...repos, ...(loose && fallback ? [fallback] : [])])];
  return among.length === 1 ? { repo: among[0] } : { among };
}
