/**
 * One chat of the chat runner, as the bridge sees it (chat-source.mjs runnerTerminal). `handle` is the chat's name, the
 * one the runner's CLI takes.
 * @typedef {{ handle: string, name?: string, worktreePath?: unknown, repo?: unknown, connected?: unknown, writable?: unknown,
 *   agentIdentity?: unknown, lastOutputAt?: unknown, title?: unknown, branch?: unknown, pending?: boolean, startedAt?: number }} Terminal
 */

/** @param {unknown} repo */
const shortName = (repo) => (typeof repo === "string" ? (repo.split("/").pop() ?? "").toLowerCase() : "");

/**
 * The live agent chat named `chat`. With `repo`, a chat whose own repo is known must be in it: a same-named chat in
 * another repo never receives this repo's line. Two live chats left are ambiguous.
 * @param {Terminal[]} terminals
 * @param {string} chat
 * @param {string | null} [repo] "owner/name"
 * @returns {{ handle: string } | { handle: null, reason: "no-terminal" | "ambiguous" }}
 */
export function resolveChatTerminal(terminals, chat, repo = null) {
  const matches = terminals.filter(
    (t) =>
      t.handle === chat &&
      t.connected === true &&
      t.writable === true &&
      Boolean(t.agentIdentity) &&
      (!repo || !t.repo || shortName(t.repo) === shortName(repo)),
  );
  if (matches.length === 0) return { handle: null, reason: "no-terminal" };
  if (matches.length > 1) return { handle: null, reason: "ambiguous" };
  return { handle: matches[0].handle };
}
