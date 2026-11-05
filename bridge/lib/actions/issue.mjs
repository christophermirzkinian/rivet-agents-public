import { redactKeepingLines } from "../redact-cut.mjs";
import { isId } from "../validate.mjs";
import { repoAllowlist } from "../../../src/shared/repos.ts";
import { iso, parseJson } from "../ops/common.mjs";
import { written, LABEL_MAX, MAX_LABELS, TITLE_MAX } from "../ops/backlog.mjs";
import { GH_TIMEOUT_MS } from "../ops/github.mjs";

// A backlog issue opened in the app: one `gh api graphql` call for that issue, the query text fixed and the repo's owner,
// name and number passed as values, then PUT to the server with the bridge token. What its author wrote is redacted.

/** @typedef {import("./index.mjs").ActionContext} ActionContext */
/** @typedef {import("./index.mjs").ActionResult} ActionResult */

export const BODY_MAX = 20_000;
const LOGIN_MAX = 100;
const PUT_TIMEOUT_MS = 10_000;

export const ISSUE_QUERY =
  "query($o: String!, $n: String!, $i: Int!) { repository(owner: $o, name: $n) { issue(number: $i) { " +
  "title body author { login } createdAt state url comments { totalCount } labels(first: 10) { nodes { name } } } } }";

/** The body's start, cut at a word: redacted whole first, so the cut cannot leave half a secret unmarked. @param {string} text */
const head = (text) => (text.length > BODY_MAX ? text.slice(0, BODY_MAX).replace(/\s+\S*$/, "") : text);

/** @param {string} repo @param {number} issue */
export function issueArgs(repo, issue) {
  const [owner, name] = repo.split("/");
  return ["api", "graphql", "-f", `query=${ISSUE_QUERY}`, "-f", `o=${owner}`, "-f", `n=${name}`, "-F", `i=${issue}`];
}

/**
 * The issue as the server keeps it; null when GitHub has no such issue.
 * @param {string} stdout @param {string} repo @param {number} number @param {Date} now
 */
export function parseIssue(stdout, repo, number, now) {
  const node = parseJson(stdout, "gh")?.data?.repository?.issue;
  if (!node || typeof node !== "object") return null;
  const login = typeof node.author?.login === "string" ? written(node.author.login, LOGIN_MAX) : "";
  const labels = (Array.isArray(node.labels?.nodes) ? node.labels.nodes : [])
    .map((/** @type {any} */ label) => written(label?.name, LABEL_MAX))
    .filter(Boolean)
    .slice(0, MAX_LABELS);
  const comments = node.comments?.totalCount;
  return {
    repo,
    number,
    title: written(node.title, TITLE_MAX),
    body: typeof node.body === "string" ? head(redactKeepingLines(node.body)) : "",
    author: login || null,
    createdAt: iso(node.createdAt) ?? now.toISOString(),
    state: node.state === "CLOSED" ? "closed" : "open",
    url: `https://github.com/${repo}/issues/${number}`,
    comments: Number.isInteger(comments) && comments >= 0 ? comments : 0,
    labels,
    at: now.toISOString(),
  };
}

export function createIssueFamily(options = {}) {
  const now = options.now ?? (() => new Date());
  /** Reads under way, by repo#issue: a second tap while one runs waits for it. @type {Set<string>} */
  const reading = new Set();

  /** @param {ActionContext} ctx @param {string} repo @param {number} issue */
  async function read(ctx, repo, issue) {
    const { exec, ghBin, origin, token, log } = ctx.deps;
    const key = `${repo}#${issue}`;
    try {
      const { stdout } = await exec(ghBin, issueArgs(repo, issue), { timeout: GH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
      const detail = parseIssue(stdout, repo, issue, now());
      if (!detail) {
        log("issue-read-missing", { repo, issue });
        return;
      }
      const res = await ctx.deps.fetch(`${origin}/api/bridge/issue`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(detail),
        redirect: "error",
        signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`issue http ${res.status}`);
      log("issue-read", { repo, issue });
    } catch (err) {
      log("issue-read-failed", { repo, issue, error: String(/** @type {any} */ (err)?.message ?? err).slice(0, 200) });
    } finally {
      reading.delete(key);
    }
  }

  return {
    family: "issue",
    events: Object.freeze(["issue.read"]),
    /**
     * @param {string} event
     * @param {unknown} raw
     * @param {ActionContext} ctx
     * @returns {Promise<ActionResult>}
     */
    async handle(event, raw, ctx) {
      const r = typeof raw === "object" && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
      const repo = typeof r.repo === "string" && repoAllowlist().includes(r.repo) ? r.repo : null;
      const issue = typeof r.issue === "number" && Number.isSafeInteger(r.issue) && r.issue > 0 ? r.issue : null;
      if (!isId(r.id) || !repo || !issue) {
        ctx.deps.log("drop", { event, reason: "bad-issue-read" });
        return "dropped";
      }
      const key = `${repo}#${issue}`;
      if (reading.has(key)) return "duplicate";
      reading.add(key);
      void read(ctx, repo, issue);
      return "delivered";
    },
  };
}

export const issue = createIssueFamily();
