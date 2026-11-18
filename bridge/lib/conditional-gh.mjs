// GitHub GETs that send the ETag of their last 200. GitHub answers an unchanged resource with 304 Not
// Modified, and a 304 costs none of the owner's hourly REST budget, which every tool on the account shares: 40 of them
// in one second spent none of it (8 Oct 2026). gh exits 1 on a 304, so the answer is read from the status line `-i`
// prints, never from the exit code. Only a 200 with a well-formed ETag is kept; anything else is passed on as it came.

/** The answers kept; past it the one used longest ago goes. */
export const MAX_ETAGS = 500;

const ETAG_RE = /^(W\/)?"[\x21\x23-\x7e]{1,200}"$/;

/**
 * The headers and body of `gh api -i` output, or null when it does not start with a status line.
 * @param {string} stdout
 */
export function splitResponse(stdout) {
  const end = stdout.search(/\r?\n\r?\n/);
  if (end < 0 || !/^HTTP\/[\d.]+ \d{3}\b/.test(stdout)) return null;
  const head = stdout.slice(0, end);
  return { status: Number(/^HTTP\/[\d.]+ (\d{3})/.exec(head)?.[1]), head, body: stdout.slice(end).replace(/^\r?\n\r?\n/, "") };
}

/** @typedef {Map<string, { etag: string, body: string }>} EtagStore */

/**
 * A GET of `path` (with `jq` applied, when given) through `gh api -i`. Resolves the body, from GitHub or, on a 304, the
 * one kept, and the response headers, which carry the x-ratelimit-* counts on a 304 too. With `onePage`, an answer
 * GitHub says has a next page is never kept. `max` is how many answers the store keeps, MAX_ETAGS unless given.
 * @param {(args: string[]) => Promise<string>} gh resolves stdout; on a non-zero exit rejects with the error's `stdout`
 * @param {EtagStore} store
 * @param {{ onePage?: boolean, max?: number }} [options]
 * @returns {(path: string, jq?: string) => Promise<{ body: string, head: string, cached: boolean }>}
 */
export function conditionalGet(gh, store, { onePage = false, max = MAX_ETAGS } = {}) {
  return async (path, jq) => {
    const key = jq === undefined ? path : `${path}\n${jq}`;
    const known = store.get(key);
    const args = ["api", "-i", ...(known ? ["-H", `If-None-Match: ${known.etag}`] : []), path, ...(jq === undefined ? [] : ["--jq", jq])];
    /** @type {string} */
    let stdout;
    try {
      stdout = await gh(args);
    } catch (err) {
      const answer = splitResponse(String(/** @type {any} */ (err)?.stdout ?? ""));
      if (!known || answer?.status !== 304) throw err;
      store.delete(key);
      store.set(key, known);
      return { body: known.body, head: answer.head, cached: true };
    }
    const answer = splitResponse(stdout);
    if (!answer) return { body: stdout, head: "", cached: false };
    const etag = /^etag:[ \t]*(.+?)[ \t]*$/im.exec(answer.head)?.[1] ?? "";
    store.delete(key);
    if (answer.status === 200 && ETAG_RE.test(etag) && !(onePage && /^link:.*\brel="next"/im.test(answer.head))) {
      store.set(key, { etag, body: answer.body });
      if (store.size > max) store.delete(/** @type {string} */ (store.keys().next().value));
    }
    return { body: answer.body, head: answer.head, cached: false };
  };
}

/**
 * `gh` for a reader that asks `["api", path]` and parses what it resolves, as readMergeHolds does: a path that names
 * no page, or page 1, is asked through conditionalGet with `onePage`, so a list is answered from the store only when
 * page 1 was all of it. A later page, and any other call, is passed to `gh` as it came.
 * @param {(args: string[]) => Promise<string>} gh as conditionalGet's
 * @param {EtagStore} store
 * @param {{ max?: number }} [options]
 * @returns {(args: string[]) => Promise<string>}
 */
export function conditionalReads(gh, store, options) {
  const get = conditionalGet(gh, store, { ...options, onePage: true });
  return async (args) => (args.length === 2 && args[0] === "api" && !/[?&]page=(?!1(?:&|$))/.test(args[1]) ? (await get(args[1])).body : gh(args));
}
