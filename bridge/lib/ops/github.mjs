import { conditionalGet } from "../conditional-gh.mjs";
import { defaultRepo, repoAllowlist } from "../../../src/shared/repos.ts";
import { fileHolds } from "../holds-file.mjs";
import { isMergeHoldLabel } from "../merge-holds.mjs";
import { allHolds, currentTexts, holdLines, labelKey, videoWaitOnly } from "../pr-holds.mjs";
import { redactDeep, redactKeepingLines, shapeText } from "../redact-cut.mjs";
import { clip, count, iso, parseJson } from "./common.mjs";

// Read-only GitHub collection for the Ops tab: open PRs with their checks, recent
// main runs, runner load, the queue and 14 days of merged PRs. Every call is `gh`
// with a fixed argument array; the only values in it are allowlisted repos, a date,
// and cursors, run ids, commits and job names GitHub itself returned. Nothing here writes
// to GitHub.

export const GH_TIMEOUT_MS = 30_000;
export const MAX_PRS = 300;
const PR_PAGE_SIZE = 50;
/** The newest comments and review summaries read on each PR for a hold; the merge guard reads them all. */
const PR_COMMENTS = 100;
export const MAX_RUNS = 150;
export const MAX_MERGED = 600;
export const MERGED_DAYS = 14;
/** Other repos' runs and the merged list change slowly; they refresh every Nth cycle. */
export const SLOW_EVERY = 5;
export const MERGED_EVERY = 10;
const MAX_JOB_LOOKUPS = 8;
/** Pages of 50 a queued or running run's jobs are counted to: 100 jobs, as one page of 100 was. */
const QUEUE_JOB_PAGES = 2;
const JOB_CACHE_MAX = 500;
/** Main runs read for the first repo in RIVET_REPOS, and for each of the others. */
const MAIN_RUNS = 20;
const OTHER_RUNS = 6;
/** Recent PR CI runs read for the Code tab's ETA; the typical run needs this many finished ones. */
const CI_RUNS = 60;
const MIN_CI_SAMPLES = 5;

const URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._/-]{1,250}$/;
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;
const RUNNER_RE = /^[A-Za-z0-9 ._:()/+-]{1,64}$/;
const WORD_RE = /^[a-z_]{1,30}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
// Mirrors BRANCH_PATTERN in src/shared/workers.ts, as ../workers.mjs does.
const BRANCH_RE = /^(?![/.-])(?!.*(?:\.\.|\/\/|\/\.|\/$|\.lock$))[A-Za-z0-9._/-]{1,200}$/;

export const PR_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${PR_PAGE_SIZE}, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url isDraft updatedAt body headRefName isCrossRepository
        author { login }
        labels(first: 20) { nodes { name } }
        comments(last: ${PR_COMMENTS}) { nodes { authorAssociation body createdAt updatedAt } }
        reviews(last: ${PR_COMMENTS}) { nodes { authorAssociation body submittedAt } }
        commits(last: 1) { nodes { commit { oid committedDate statusCheckRollup { contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { id name status conclusion startedAt
            checkSuite { id createdAt app { id } workflowRun { workflow { id } } }
          }
          ... on StatusContext { context state }
        } } } } } }
      }
    }
  }
}`;

// The snapshot's fields the server checks against a pattern, which a marker would fail (and the whole snapshot with
// it). Public identifiers pass as read: a login(), a commit SHA, a GitHub URL. Any other that redaction would change
// becomes a word its pattern takes: a status word, a runner's name. A branch redaction would change is never sent.
const PATTERNED = new Map([
  ["author", null], ["sha", null], ["headSha", null], ["mergeSha", null], ["url", null],
  ["status", "redacted"], ["conclusion", "redacted"], ["event", "redacted"], ["name", "redacted"],
]);

/** @param {unknown} value */
function login(value) {
  const raw = typeof value === "string" ? value.replace(/^app\//, "") : "";
  return LOGIN_RE.test(raw) ? raw : "unknown";
}

/** @param {unknown} value */
function url(value) {
  return typeof value === "string" && URL_RE.test(value) ? value : null;
}

/** PR and run text authors write: redacted whole, then clipped. @param {unknown} value @param {number} max */
function written(value, max) {
  return clip(typeof value === "string" ? shapeText(value, max) : "", max);
}

/** A head branch the Agents board can match a chat on; one that redaction would change is not shown. @param {any} pr */
function branchOf(pr) {
  const name = pr.isCrossRepository === false && typeof pr.headRefName === "string" && BRANCH_RE.test(pr.headRefName) ? pr.headRefName : null;
  return name && shapeText(name, 200) === name ? name : null;
}

/** @param {unknown} value */
function word(value) {
  const s = typeof value === "string" ? value.toLowerCase() : "";
  return WORD_RE.test(s) ? s : null;
}

const PASS = new Set(["success", "neutral", "skipped"]);
const FAIL = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale", "error"]);

/**
 * Only Actions checks with the same app, workflow and exact job name can supersede
 * one another. Missing identity/timestamps leave the cancellation visible.
 * @param {any} older
 * @param {any} newer
 */
function supersedesCancelled(older, newer) {
  if (newer?.__typename !== "CheckRun" || typeof older.id !== "string" || typeof newer.id !== "string" || older.id === newer.id) return false;
  const a = older.checkSuite;
  const b = newer.checkSuite;
  if (typeof older.name !== "string" || older.name !== newer.name ||
      typeof a?.app?.id !== "string" || a.app.id !== b?.app?.id ||
      typeof a?.workflowRun?.workflow?.id !== "string" || a.workflowRun.workflow.id !== b?.workflowRun?.workflow?.id ||
      typeof a?.id !== "string" || typeof b?.id !== "string") return false;
  // A cancellation needs its own start time: suite creation cannot date an
  // unstarted rerun. A queued replacement in a separate suite can use creation.
  const from = iso(older.startedAt);
  const to = iso(newer.startedAt) ?? (a.id !== b.id ? iso(b.createdAt) : null);
  return from !== null && to !== null && to > from;
}

/**
 * Pass, fail or pending over a head commit's check runs and statuses.
 * @param {unknown[]} contexts
 */
export function checksSummary(contexts) {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  /** @type {string[]} */
  const failing = [];
  for (const raw of contexts) {
    const c = /** @type {any} */ (raw);
    if (!c || typeof c !== "object") continue;
    if (c.__typename === "CheckRun" && String(c.conclusion ?? "").toLowerCase() === "cancelled" &&
        contexts.some((other) => supersedesCancelled(c, other))) continue;
    const name = written(c.__typename === "StatusContext" ? c.context : c.name, 120) || "check";
    let outcome;
    if (c.__typename === "StatusContext") {
      const state = String(c.state ?? "").toLowerCase();
      outcome = state === "success" ? "pass" : state === "failure" || state === "error" ? "fail" : "pending";
    } else {
      const status = String(c.status ?? "").toLowerCase();
      const conclusion = String(c.conclusion ?? "").toLowerCase();
      outcome = status !== "completed" ? "pending" : PASS.has(conclusion) ? "pass" : FAIL.has(conclusion) ? "fail" : "pending";
    }
    if (outcome === "pass") passed += 1;
    else if (outcome === "pending") pending += 1;
    else {
      failed += 1;
      if (failing.length < 10) failing.push(name);
    }
  }
  const state = failed ? "fail" : pending ? "pending" : passed ? "pass" : "none";
  return { state, passed, failed, pending, failing };
}

/**
 * @param {string} repo
 * @param {string} stdout `gh api graphql` output for PR_QUERY
 */
export function parsePullRequests(repo, stdout) {
  const doc = parseJson(stdout, "gh");
  const nodes = doc?.data?.repository?.pullRequests?.nodes;
  if (!Array.isArray(nodes)) throw new Error("gh returned no pull requests");
  const out = [];
  for (const n of nodes) {
    const number = n?.number;
    const prUrl = url(n?.url);
    const updatedAt = iso(n?.updatedAt);
    if (!Number.isInteger(number) || number <= 0 || !prUrl || !updatedAt) continue;
    const commit = n.commits?.nodes?.[0]?.commit;
    const contexts = commit?.statusCheckRollup?.contexts?.nodes;
    // A fork's branch name says nothing about the chats here.
    const branch = branchOf(n);
    out.push({
      repo,
      number,
      title: written(n.title, 300),
      url: prUrl,
      draft: n.isDraft === true,
      author: login(n.author?.login),
      labels: (Array.isArray(n.labels?.nodes) ? n.labels.nodes : [])
        .map((/** @type {any} */ l) => written(l?.name, 60))
        .filter(Boolean)
        .slice(0, 20),
      headAt: iso(commit?.committedDate),
      updatedAt,
      ...(branch ? { branch } : {}),
      ...(typeof commit?.oid === "string" && /^[0-9a-f]{40}$/.test(commit.oid) ? { headSha: commit.oid } : {}),
      ...textHold(n, Array.isArray(n.labels?.nodes) ? n.labels.nodes.map((/** @type {any} */ l) => String(l?.name ?? "")) : []),
      checks: checksSummary(Array.isArray(contexts) ? contexts : []),
    });
  }
  return out;
}

/**
 * The PR's first hold line in force, read as the merge guard reads it (bridge/lib/merge-holds.mjs) from the body and its
 * last PR_COMMENTS comments and review summaries, then again from those texts redacted whole (`[redacted]` when that took the hold).
 * `videoWait` when every hold in the unredacted texts is a wait for the owner's video OK (pr-holds.mjs videoWaitOnly)
 * and no raw label holds it but an agent's wip or blocked: a label's shown name may be redacted past reading.
 * `holds`, when more than one line holds it: every distinct hold line, up to twenty (pr-holds.mjs allHolds).
 * @param {any} pr @param {string[]} labels the raw label names
 */
function textHold(pr, labels = []) {
  const comments = Array.isArray(pr.comments?.nodes) ? pr.comments.nodes : [];
  const reviews = Array.isArray(pr.reviews?.nodes) ? pr.reviews.nodes : [];
  const notes = comments.map((/** @type {any} */ c) => ({ body: typeof c?.body === "string" ? c.body : null, posted: c?.createdAt, changed: c?.updatedAt, association: c?.authorAssociation }));
  // A review's summary can be edited and GitHub gives no time for it, so a review is never superseded.
  notes.push(...reviews.map((/** @type {any} */ r) => ({ body: typeof r?.body === "string" ? r.body : null, posted: r?.submittedAt, changed: null, association: r?.authorAssociation })));
  const live = currentTexts({ body: typeof pr.body === "string" ? pr.body : null, notes });
  if (holdLines(live) === null) return {};
  const redacted = live.map((text) => redactKeepingLines(text));
  const hold = shapeText(holdLines(redacted) ?? "[redacted]", 200);
  // Every hold line, when there is more than one: the server finds the owner's among them.
  const all = allHolds(redacted).map((one) => shapeText(one, 200));
  const holds = all.length > 1 ? { holds: all } : {};
  const labelled = labels.some((name) => isMergeHoldLabel(name) && !AGENT_LABELS.has(labelKey(name)));
  return !labelled && videoWaitOnly(live) ? { hold, ...holds, videoWait: true } : { hold, ...holds };
}

/** An agent's own hold labels, which the server's video wait passes too (src/shared/pr-holds.ts videoWaitOnly). */
const AGENT_LABELS = new Set(["wip", "blocked"].map(labelKey));

export const CI_RUN_FIELDS = "attempt,status,conclusion,headSha,startedAt,updatedAt";
/** The REST list cut to CI_RUN_FIELDS, as `gh run list` names them. */
const CI_RUN_JQ = "[.workflow_runs[] | {attempt: .run_attempt, status, conclusion, headSha: .head_sha, startedAt: .run_started_at, updatedAt: .updated_at}]";

/**
 * Recent pull-request CI runs: the median minutes a first attempt took to pass, and when the run still going on each
 * head started.
 * @param {string} stdout `gh run list --workflow ci.yml --event pull_request --json CI_RUN_FIELDS` output, or CI_RUN_JQ's
 * @returns {{ typicalMin: number | null, started: Map<string, string> }}
 */
export function parseCiRuns(stdout) {
  const list = parseJson(stdout, "gh");
  if (!Array.isArray(list)) throw new Error("gh returned no runs");
  /** @type {number[]} */
  const took = [];
  /** @type {Map<string, string>} */
  const started = new Map();
  for (const r of list) {
    const sha = typeof r?.headSha === "string" && /^[0-9a-f]{40}$/.test(r.headSha) ? r.headSha : null;
    const from = iso(r?.startedAt);
    const to = iso(r?.updatedAt);
    if (!sha || !from) continue;
    if (r.status !== "completed") {
      const known = started.get(sha);
      if (!known || from > known) started.set(sha, from);
    } else if (r.conclusion === "success" && r.attempt === 1 && to) {
      const ms = Date.parse(to) - Date.parse(from);
      if (ms > 0 && ms < 6 * 3600_000) took.push(ms);
    }
  }
  took.sort((a, b) => a - b);
  const typicalMin = took.length >= MIN_CI_SAMPLES ? Math.max(1, Math.round(took[Math.floor(took.length / 2)] / 60_000)) : null;
  return { typicalMin, started };
}

export const RUN_FIELDS = "databaseId,attempt,workflowName,displayTitle,status,conclusion,event,headSha,url,createdAt,updatedAt";
/** The REST list cut to RUN_FIELDS, as `gh run list` names them. */
const RUN_JQ = "[.workflow_runs[] | {databaseId: .id, attempt: .run_attempt, workflowName: .name, displayTitle: .display_title, status, conclusion, event, headSha: .head_sha, url: .html_url, createdAt: .created_at, updatedAt: .updated_at}]";

/**
 * @param {string} repo
 * @param {string} stdout `gh run list --json RUN_FIELDS` output, or RUN_JQ's
 */
export function parseRuns(repo, stdout) {
  const list = parseJson(stdout, "gh");
  if (!Array.isArray(list)) throw new Error("gh returned no runs");
  const out = [];
  for (const r of list) {
    const id = r?.databaseId;
    const runUrl = url(r?.url);
    const status = word(r?.status);
    const sha = typeof r?.headSha === "string" && SHA_RE.test(r.headSha) ? r.headSha : null;
    const createdAt = iso(r?.createdAt);
    const updatedAt = iso(r?.updatedAt) ?? createdAt;
    if (!Number.isSafeInteger(id) || id <= 0 || !runUrl || !status || !sha || !createdAt || !updatedAt) continue;
    out.push({
      repo,
      id,
      attempt: Number.isSafeInteger(r.attempt) && r.attempt > 0 && r.attempt <= 10_000 ? r.attempt : 1,
      workflow: written(r.workflowName, 120) || "workflow",
      title: written(r.displayTitle, 200),
      status,
      conclusion: word(r.conclusion),
      event: word(r.event) ?? "push",
      sha,
      url: runUrl,
      createdAt,
      updatedAt,
    });
  }
  return out;
}

/** @param {string} stdout `gh api .../jobs --jq` output: an array of failed job names */
export function parseJobNames(stdout) {
  // One array a line: a page each under --paginate.
  const lines = String(stdout).split("\n").filter((line) => line.trim());
  if (!lines.length) throw new Error("gh returned no jobs");
  const names = lines.flatMap((line) => {
    const list = parseJson(line, "gh");
    return Array.isArray(list) ? list : [];
  });
  return names.map((name) => written(name, 120)).filter(Boolean).slice(0, 10);
}

/** @param {string} stdout Bounded runner page, with its total_count. */
export function parseRunners(stdout) {
  const doc = parseJson(stdout, "gh");
  const list = Array.isArray(doc) ? doc : doc?.runners;
  if (!Array.isArray(list)) throw new Error("gh returned no runners");
  const runners = [];
  for (const r of Array.isArray(list) ? list : []) {
    if (typeof r?.name !== "string" || !RUNNER_RE.test(r.name)) continue;
    runners.push({ name: r.name, status: r.status === "online" ? "online" : "offline", busy: r.busy === true });
  }
  runners.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  const online = runners.filter((r) => r.status === "online");
  return {
    online: online.length,
    busy: online.filter((r) => r.busy).length,
    offline: runners.length - online.length,
    runners: runners.slice(0, 50),
    complete: Number.isSafeInteger(doc?.total_count) && doc.total_count === runners.length,
    detailsComplete: Number.isSafeInteger(doc?.total_count) && doc.total_count === runners.length && runners.length <= 50,
  };
}

/**
 * @param {string} repo
 * @param {string} stdout `gh pr list --state merged --json number,title,url,mergedAt,author,headRefName,isCrossRepository,mergeCommit` output
 */
export function parseMerged(repo, stdout) {
  const list = parseJson(stdout, "gh");
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const prUrl = url(p?.url);
    const mergedAt = iso(p?.mergedAt);
    if (!Number.isInteger(p?.number) || p.number <= 0 || !prUrl || !mergedAt) continue;
    // The head branch ties a merge to the chat that has it checked out (the Agents board); a fork's says nothing here.
    const branch = branchOf(p);
    out.push({ repo, number: p.number, title: written(p.title, 300), url: prUrl, mergedAt, ...(typeof p.mergeCommit?.oid === "string" && /^[0-9a-f]{40}$/.test(p.mergeCommit.oid) ? { mergeSha: p.mergeCommit.oid } : {}), author: login(p.author?.login), ...(branch ? { branch } : {}) });
  }
  return out;
}

/**
 * PRs closed without a merge, so a Coming row for one can leave the Feed.
 * @param {string} repo
 * @param {string} stdout `gh pr list --state closed --search is:unmerged --json number,closedAt` output
 */
export function parseClosed(repo, stdout) {
  const list = parseJson(stdout, "gh");
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const closedAt = iso(p?.closedAt);
    if (!Number.isInteger(p?.number) || p.number <= 0 || !closedAt) continue;
    out.push({ repo, number: p.number, closedAt });
  }
  return out;
}

/** A completed run worth naming the failed jobs of. @param {{ status: string, conclusion: string | null }} run */
function failedRun(run) {
  return run.status === "completed" && ["failure", "timed_out", "startup_failure"].includes(run.conclusion ?? "");
}

/**
 * The last good fetch per repo and source, so a failed fetch shows what was known
 * before rather than an empty list, and the failed jobs of runs already looked up.
 * Entries: { value, at, ok }; `ok` is false while the latest try at that source failed.
 */
export function emptyGithubCache() {
  return {
    cycle: 0,
    /** @type {Map<string, { value: any[], at: string | null, ok: boolean, complete?: boolean }>} */
    prs: new Map(),
    /** @type {Map<string, { value: any[], at: string | null, ok: boolean }>} */
    runs: new Map(),
    /** @type {Map<string, { value: any[], at: string | null, ok: boolean }>} */
    merged: new Map(),
    /** @type {Map<string, { value: any[], at: string | null, ok: boolean }>} */
    closed: new Map(),
    /** @type {{ value: any, at: string | null, ok: boolean } | null} */
    runners: null,
    /** @type {{ value: any, at: string | null, ok: boolean } | null} */
    queue: null,
    /** @type {{ value: ReturnType<typeof parseCiRuns> | null, at: string | null, ok: boolean } | null} */
    ci: null,
    /** Failed job names by `${run id}:${run attempt}`: a rerun is a new lookup. @type {Map<string, string[]>} */
    jobs: new Map(),
    /** The answers of the queue's conditional reads (conditional-gh.mjs). @type {import("../conditional-gh.mjs").EtagStore} */
    etags: new Map(),
  };
}

const short = (/** @type {string} */ repo) => repo.split("/")[1] ?? repo;

/**
 * Records one try at a source: the fresh value on success, the last good one on failure.
 * @param {{ value: any, at: string | null, ok: boolean } | null | undefined} previous
 * @param {any} value null on failure
 * @param {string} at
 */
function remember(previous, value, at) {
  if (value !== null) return { value, at, ok: true };
  return { value: previous?.value ?? null, at: previous?.at ?? null, ok: false };
}

/**
 * A source's freshness: the repos whose latest try failed, and when the oldest data still
 * shown for them was fetched (null when one of them has none).
 * @param {[string, { at: string | null, ok: boolean } | null | undefined][]} entries
 */
export function sourceState(entries) {
  const failed = entries.filter(([, entry]) => entry && !entry.ok);
  const times = failed.map(([, entry]) => entry?.at ?? null);
  return {
    failed: failed.map(([repo]) => short(repo)),
    at: times.includes(null) ? null : (times.sort()[0] ?? null),
  };
}

/**
 * One collection pass. A failed fetch keeps that repo's last good data and marks the
 * source failed in `sources`, so the server shows it as stale rather than empty or green.
 * @param {{ exec: import("../config.mjs").Exec, ghBin: string, now?: () => Date,
 *   cache: ReturnType<typeof emptyGithubCache>, log?: (event: string, fields?: Record<string, unknown>) => void,
 *   holdsFile?: string | null }} deps (holdsFile, the merge holds file a PR's hold is also read from, absent or null reads none)
 */
export async function collectGithub(deps) {
  const { exec, ghBin, cache } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const at = now.toISOString();
  const log = deps.log ?? (() => {});
  const repos = repoAllowlist();
  const main = defaultRepo();
  if (!main) {
    const none = { failed: [], at: null };
    return { at, prs: [], prsComplete: true, runs: [], runners: null, queue: null, merged: null, closed: null, sources: { prs: none, runs: none, merged: none, runners: none, queue: none } };
  }
  const gh = (/** @type {string[]} */ args) => exec(ghBin, args, { timeout: GH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout);
  // The reads this collector repeats every minute send the ETag of their last answer: a 304 costs none of the account's
  // shared REST quota.
  const get = conditionalGet(gh, cache.etags);
  const slow = cache.cycle % SLOW_EVERY === 0;
  const refreshMerged = cache.cycle % MERGED_EVERY === 0 || repos.some((repo) => !cache.merged.get(repo)?.ok);
  cache.cycle += 1;
  const reason = (/** @type {unknown} */ err) => (err instanceof Error ? err.message : "error");

  for (const repo of repos) {
    const [owner, name] = repo.split("/");
    let list = null;
    let complete = false;
    try {
      const nodes = [];
      const seen = new Set();
      const cursors = new Set();
      let cursor = null;
      // Bound both requests and retained rows, even if GitHub repeats a page.
      for (let page = 0; page < Math.ceil(MAX_PRS / PR_PAGE_SIZE); page += 1) {
        const args = ["api", "graphql", "-f", `query=${PR_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`];
        if (cursor !== null) args.push("-f", `cursor=${cursor}`);
        const doc = parseJson(await gh(args), "gh");
        const connection = doc?.data?.repository?.pullRequests;
        if (doc?.errors?.length || !Array.isArray(connection?.nodes)) throw new Error("gh returned no pull requests");
        for (const node of connection.nodes) {
          if (seen.has(node?.number)) continue;
          seen.add(node?.number);
          nodes.push(node);
          if (nodes.length >= MAX_PRS) break;
        }
        complete = connection.pageInfo?.hasNextPage === false;
        if (!connection.pageInfo?.hasNextPage || nodes.length >= MAX_PRS) break;
        if (page + 1 === Math.ceil(MAX_PRS / PR_PAGE_SIZE)) throw new Error("gh pull request pagination budget exhausted");
        cursor = connection.pageInfo.endCursor;
        if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) throw new Error("gh returned an invalid pull request cursor");
        cursors.add(cursor);
      }
      list = parsePullRequests(repo, JSON.stringify({ data: { repository: { pullRequests: { nodes } } } }));
    } catch (err) {
      log("ops-github-prs-failed", { repo: name, error: reason(err) });
    }
    const previous = cache.prs.get(repo);
    cache.prs.set(repo, { ...remember(previous, list, at), complete: list === null ? previous?.complete : complete });
  }

  for (const repo of repos) {
    const previous = cache.runs.get(repo);
    if (repo !== main && !slow && previous?.ok) continue;
    const limit = repo === main ? MAIN_RUNS : OTHER_RUNS;
    let list = null;
    try {
      list = parseRuns(repo, (await get(`repos/${repo}/actions/runs?branch=main&per_page=${limit}`, RUN_JQ)).body);
    } catch (err) {
      log("ops-github-runs-failed", { repo: short(repo), error: reason(err) });
    }
    cache.runs.set(repo, remember(previous, list, at));
  }
  const runs = repos.flatMap((repo) => (cache.runs.get(repo)?.value ?? []).map((/** @type {any} */ run) => ({ ...run })));
  let lookups = 0;
  for (const run of runs) {
    if (!failedRun(run)) continue;
    const jobKey = `${run.id}:${run.attempt}`;
    const known = cache.jobs.get(jobKey);
    if (known) {
      run.failedJobs = known;
      continue;
    }
    if (lookups >= MAX_JOB_LOOKUPS) continue;
    lookups += 1;
    try {
      const jobs = parseJobNames(
        await gh([
          "api",
          // 50 to a page: GitHub answers 502 at 100 on a large rerun run.
          `repos/${run.repo}/actions/runs/${run.id}/jobs?per_page=50&filter=latest`,
          "--paginate",
          "--jq",
          '[.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out") | .name]',
        ]),
      );
      if (cache.jobs.size >= JOB_CACHE_MAX) cache.jobs.delete(/** @type {string} */ (cache.jobs.keys().next().value));
      cache.jobs.set(jobKey, jobs);
      run.failedJobs = jobs;
    } catch (err) {
      log("ops-github-jobs-failed", { run: run.id, error: reason(err) });
    }
  }

  // The queue is a count on a screen, read every SLOW_EVERY cycles with the ETag
  // of each read's last answer (a 304 costs nothing): a cycle's ten calls each
  // minute were 600 of the account's 5,000 REST calls an hour, and every tool on
  // the account shares them.
  if (slow || !cache.queue?.ok) {
    let queue = null;
    try {
      const ids = async (/** @type {string} */ status) => {
        const doc = parseJson((await get(`repos/${main}/actions/runs?status=${status}&per_page=50`, "{total_count, ids: [.workflow_runs[].id]}")).body, "gh");
        if (!Array.isArray(doc?.ids)) throw new Error("gh returned no run ids");
        const values = doc.ids.filter((id) => Number.isSafeInteger(id));
        return { values, complete: Number.isSafeInteger(doc.total_count) && doc.total_count === values.length };
      };
      const queued = await ids("queued");
      const running = await ids("in_progress");
      // A queued run can start between the two reads; inspect it once.
      const runs = [...new Set([...queued.values, ...running.values])];
      const sampled = runs.slice(0, MAX_JOB_LOOKUPS);
      const runsComplete = queued.complete && running.complete;
      let jobsComplete = runsComplete && sampled.length === runs.length;
      let queuedJobs = 0;
      for (const id of sampled) {
        // A run's jobs, 50 to a page (GitHub answers 502 at 100 on a large
        // rerun run), up to QUEUE_JOB_PAGES pages.
        let read = 0;
        let queuedHere = 0;
        let total = null;
        for (let page = 1; page <= QUEUE_JOB_PAGES; page += 1) {
          const doc = parseJson((await get(`repos/${main}/actions/runs/${id}/jobs?per_page=50&filter=latest&page=${page}`, '{total_count, read: (.jobs | length), queued: ([.jobs[] | select(.status == "queued")] | length)}')).body, "gh");
          if (!Number.isSafeInteger(doc?.queued) || !Number.isSafeInteger(doc?.read) || doc.queued < 0 || doc.read < doc.queued) throw new Error("gh returned no job counts");
          read += doc.read;
          queuedHere += count(doc.queued);
          total = doc.total_count;
          if (doc.read < 50 || !Number.isSafeInteger(total) || read >= total) break;
        }
        queuedJobs += queuedHere;
        jobsComplete &&= Number.isSafeInteger(total) && total === read;
      }
      queue = { queuedRuns: queued.values.length, runningRuns: running.values.length, queuedJobs, runsComplete, jobsComplete, sampledRuns: sampled.length };
    } catch (err) {
      log("ops-github-queue-failed", { error: reason(err) });
    }
    cache.queue = remember(cache.queue, queue, at);
  }

  /** @type {any[] | null} */
  let merged = null;
  /** @type {any[] | null} */
  let closed = null;
  if (refreshMerged) {
    const since = new Date(now.getTime() - MERGED_DAYS * 24 * 3600_000).toISOString().slice(0, 10);
    for (const repo of repos) {
      let list = null;
      try {
        list = parseMerged(
          repo,
          await gh(["pr", "list", "-R", repo, "--state", "merged", "--search", `merged:>=${since}`, "--limit", "200", "--json", "number,title,url,mergedAt,author,headRefName,isCrossRepository,mergeCommit"]),
        );
      } catch (err) {
        log("ops-github-merged-failed", { repo: short(repo), error: reason(err) });
      }
      cache.merged.set(repo, remember(cache.merged.get(repo), list, at));
      let shut = null;
      try {
        shut = parseClosed(
          repo,
          await gh(["pr", "list", "-R", repo, "--state", "closed", "--search", `is:unmerged closed:>=${since}`, "--limit", "200", "--json", "number,closedAt"]),
        );
      } catch (err) {
        log("ops-github-closed-failed", { repo: short(repo), error: reason(err) });
      }
      cache.closed.set(repo, remember(cache.closed.get(repo), shut, at));
    }
    closed = repos.flatMap((repo) => cache.closed.get(repo)?.value ?? []).slice(0, MAX_MERGED);
    merged = repos.flatMap((repo) => cache.merged.get(repo)?.value ?? [])
      .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
      .slice(0, MAX_MERGED);
  }

  // The Code tab's status and ETA: PR CI timings, for this repo only.
  let ci = null;
  try {
    ci = parseCiRuns((await get(`repos/${main}/actions/workflows/ci.yml/runs?event=pull_request&per_page=${CI_RUNS}`, CI_RUN_JQ)).body);
  } catch (err) {
    log("ops-github-ci-failed", { error: reason(err) });
  }
  cache.ci = remember(cache.ci, ci, at);
  // A failed read keeps no old run starts: a rerun since would read as overdue.
  const ciNow = cache.ci.ok ? cache.ci.value : null;
  // The holds file's hold on a PR of this repo, as the merge guard reads it.
  // Every one of its entries: a hold filed beside an answered body hold is a new hold to card.
  const heldInFile = (/** @type {number} */ number) => (typeof deps.holdsFile === "string" ? fileHolds(number, { file: deps.holdsFile, now: now.getTime() }).map((one) => shapeText(one, 200)).filter(Boolean) : []);
  /** @param {any} pr */
  const withProgress = (pr) => {
    if (pr.repo !== main) return pr;
    // Any holds-file entry is more than the video wait: the PR's text hold stays the hold shown, so it cards as before.
    const filed = heldInFile(pr.number);
    if (filed.length && pr.videoWait) {
      const { videoWait: _videoWait, ...rest } = pr;
      pr = rest;
    }
    if (filed.length) {
      const all = [...new Set([...(pr.holds ?? (pr.hold ? [pr.hold] : [])), ...filed].filter(Boolean))].slice(0, 20);
      pr = { ...pr, hold: pr.hold || filed[0], ...(all.length > 1 ? { holds: all } : {}) };
    }
    if (!pr.headSha) return pr;
    const started = ciNow?.started.get(pr.headSha);
    return started ? { ...pr, ciStartedAt: started } : pr;
  };

  // Runners last, just before the snapshot goes: the server stamps the reading with the time it arrives, so the slow
  // queue and merged lookups must not sit between the fetch and the send.
  let runners = null;
  try {
    runners = parseRunners((await get(`repos/${main}/actions/runners?per_page=100`, "{total_count, runners: [.runners[] | {name, status, busy}]}")).body);
  } catch (err) {
    log("ops-github-runners-failed", { error: reason(err) });
  }
  cache.runners = remember(cache.runners, runners, at);

  const allPrs = repos.flatMap((repo) => cache.prs.get(repo)?.value ?? []);
  // The last step before the PUT: whatever a field above let through unredacted, this pass catches.
  return redactDeep({
    at,
    prs: allPrs.slice(0, MAX_PRS).map(withProgress),
    prsComplete: allPrs.length <= MAX_PRS && repos.every((repo) => cache.prs.get(repo)?.complete === true),
    ...(ciNow?.typicalMin ? { ciTypicalMin: ciNow.typicalMin } : {}),
    runs: runs.slice(0, MAX_RUNS),
    runners: cache.runners.value,
    queue: cache.queue.value,
    merged,
    closed,
    sources: {
      prs: sourceState(repos.map((repo) => [repo, cache.prs.get(repo)])),
      runs: sourceState(repos.map((repo) => [repo, cache.runs.get(repo)])),
      merged: sourceState(repos.map((repo) => [repo, cache.merged.get(repo)])),
      runners: sourceState([[main, cache.runners]]),
      queue: sourceState([[main, cache.queue]]),
    },
  }, PATTERNED);
}
