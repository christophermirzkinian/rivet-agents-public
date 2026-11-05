import { shapeText } from "../redact-cut.mjs";
import { repoAllowlist } from "../../../src/shared/repos.ts";
import { clip, count, iso, parseJson } from "./common.mjs";
import { GH_TIMEOUT_MS } from "./github.mjs";

// Each repo's open issues for a project's backlog sheet: one `gh api graphql` call a pass for every repo in RIVET_REPOS,
// the query text fixed and each repo's owner and name passed as values. Titles, numbers, labels and update times only,
// never a body (an issue opened in the app is read alone, on the tap, by actions/issue.mjs). Every tool on the account
// shares GitHub's quota, so this is one GraphQL query each five minutes and no REST call. Beside each repo's 100 newest it
// reads the open bugs (so an older bug still leads Other issues) and the 50 latest closed, so an ask from a Yes finishes
// when its issue closes.

export const BACKLOG_INTERVAL_MS = 5 * 60_000;
export const MAX_OWNER = 20;
export const MAX_RECENT = 100;
export const MAX_BUGS = 20;
/** Each repo's most recently updated closed issues: a pass is five minutes, so one just closed is always in them. */
export const MAX_CLOSED = 50;
/** GitHub's close reasons; a close from before reasons (null) is a completed one. */
const CLOSE_REASONS = { COMPLETED: "completed", NOT_PLANNED: "not_planned", DUPLICATE: "duplicate" };
export const MAX_LABELS = 10;
export const TITLE_MAX = 300;
export const LABEL_MAX = 50;
/** Under the server's 512 KiB cap on a bridge PUT (OPS_MAX_BYTES), with room to spare: a pass over it is trimmed. */
export const BACKLOG_MAX_BYTES = 448 * 1024;

const ISSUE = "number title updatedAt labels(first: 10) { nodes { name } }";
const NEWEST = "orderBy: { field: UPDATED_AT, direction: DESC }";
const FIELDS = [
  "open: issues(states: OPEN) { totalCount }",
  'logs: issues(states: OPEN, labels: ["type:log"]) { totalCount }',
  `owner: issues(states: OPEN, labels: ["autonomy:owner"], first: ${MAX_OWNER}, ${NEWEST}) { totalCount nodes { ${ISSUE} } }`,
  `recent: issues(states: OPEN, first: ${MAX_RECENT}, ${NEWEST}) { nodes { ${ISSUE} } }`,
  `bugs: issues(states: OPEN, labels: ["type:bug", "bug"], first: ${MAX_BUGS}, ${NEWEST}) { nodes { ${ISSUE} } }`,
  // So an ask from a Yes finishes when its issue closes: numbers, times and reasons only.
  `closed: issues(states: CLOSED, first: ${MAX_CLOSED}, ${NEWEST}) { nodes { number closedAt stateReason } }`,
].join(" ");
/** The fixed query for this many repos. @param {number} repos */
export function backlogQuery(repos) {
  const each = Array.from({ length: repos }, (_, i) => i);
  return `query(${each.map((i) => `$o${i}: String!, $n${i}: String!`).join(", ")}) { ${each.map((i) => `r${i}: repository(owner: $o${i}, name: $n${i}) { ${FIELDS} }`).join(" ")} }`;
}

/** The `gh` arguments for one pass: the fixed query, then each repo's owner and name as values. @param {string[]} repos */
export function backlogArgs(repos) {
  const args = ["api", "graphql", "-f", `query=${backlogQuery(repos.length)}`];
  repos.forEach((repo, i) => {
    const [owner, name] = repo.split("/");
    args.push("-f", `o${i}=${owner}`, "-f", `n${i}=${name}`);
  });
  return args;
}

/** Text an author wrote: redacted whole, then clipped. @param {unknown} value @param {number} max */
export function written(value, max) {
  return clip(typeof value === "string" ? shapeText(value, max) : "", max);
}

/** @param {any} nodes @param {number} max */
function issues(nodes, max) {
  if (!Array.isArray(nodes)) return [];
  const out = [];
  for (const node of nodes) {
    const number = node?.number;
    const updatedAt = iso(node?.updatedAt);
    if (!Number.isInteger(number) || number <= 0 || !updatedAt) continue;
    const labels = (Array.isArray(node.labels?.nodes) ? node.labels.nodes : [])
      .map((/** @type {any} */ label) => written(label?.name, LABEL_MAX))
      .filter(Boolean)
      .slice(0, MAX_LABELS);
    out.push({ number, title: written(node.title, TITLE_MAX), updatedAt, labels });
    if (out.length >= max) break;
  }
  return out;
}

/** @param {any} nodes */
function closedIssues(nodes) {
  if (!Array.isArray(nodes)) return [];
  const out = [];
  for (const node of nodes) {
    const number = node?.number;
    const closedAt = iso(node?.closedAt);
    if (!Number.isInteger(number) || number <= 0 || !closedAt) continue;
    const reason = node.stateReason == null ? "completed" : CLOSE_REASONS[/** @type {keyof typeof CLOSE_REASONS} */ (node.stateReason)];
    if (!reason) continue;
    out.push({ number, closedAt, reason });
    if (out.length >= MAX_CLOSED) break;
  }
  return out;
}

/**
 * The snapshot from one answer. A repo GitHub could not read (null) is left out.
 * @param {string} stdout @param {Date} now @param {string[]} repos
 */
export function parseBacklog(stdout, now, repos) {
  const data = parseJson(stdout, "gh")?.data;
  if (!data || typeof data !== "object") throw new Error("gh returned no backlog");
  const read = [];
  repos.forEach((repo, i) => {
    const node = data[`r${i}`];
    if (!node || typeof node !== "object") return;
    read.push({
      repo,
      total: count(node.open?.totalCount),
      logs: count(node.logs?.totalCount),
      ownerTotal: count(node.owner?.totalCount),
      owner: issues(node.owner?.nodes, MAX_OWNER),
      recent: issues(node.recent?.nodes, MAX_RECENT),
      bugs: issues(node.bugs?.nodes, MAX_BUGS),
      closed: closedIssues(node.closed?.nodes),
    });
  });
  return { at: now.toISOString(), repos: read };
}

/**
 * The snapshot cut to fit `max` bytes, so a pass the server would refuse whole still lands: each repo's newest issues
 * are cut first, then its bugs, then the owner's. The counts stay whole; the sheet shows the rows it has.
 * @param {{ at: string, repos: any[] }} snapshot @param {number} [max]
 */
export function fitBacklog(snapshot, max = BACKLOG_MAX_BYTES) {
  const size = (/** @type {any} */ value) => Buffer.byteLength(JSON.stringify(value));
  if (size(snapshot) <= max) return snapshot;
  const cuts = [75, 50, 25, 10, 0].map((n) => ({ recent: n, bugs: MAX_BUGS, owner: MAX_OWNER }));
  cuts.push({ recent: 0, bugs: 0, owner: MAX_OWNER });
  cuts.push(...[10, 5, 0].map((n) => ({ recent: 0, bugs: 0, owner: n })));
  for (const cut of cuts) {
    const repos = snapshot.repos.map((one) => ({
      ...one,
      owner: one.owner.slice(0, cut.owner),
      recent: one.recent.slice(0, cut.recent),
      bugs: one.bugs.slice(0, cut.bugs),
    }));
    const fitted = { at: snapshot.at, repos };
    if (size(fitted) <= max) return fitted;
  }
  throw new Error("backlog snapshot too large");
}

/**
 * One pass. `gh` exits non-zero when a repo in the query cannot be read, with the others' answer on stdout: that answer
 * is kept. Any other failure throws, and the next pass tries again.
 * @param {{ exec: import("../config.mjs").Exec, ghBin: string, now?: () => Date }} deps
 */
export async function collectBacklog(deps) {
  const now = (deps.now ?? (() => new Date()))();
  const repos = repoAllowlist();
  if (!repos.length) return { at: now.toISOString(), repos: [] };
  let stdout;
  try {
    ({ stdout } = await deps.exec(deps.ghBin, backlogArgs(repos), { timeout: GH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }));
  } catch (err) {
    const partial = /** @type {any} */ (err)?.stdout;
    if (typeof partial !== "string" || !partial.includes('"data"')) throw err;
    stdout = partial;
  }
  return fitBacklog(parseBacklog(stdout, now, repos));
}
