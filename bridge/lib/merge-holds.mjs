import { fileHolds } from "./holds-file.mjs";
import { currentTexts, holdLines, labelKey } from "./pr-holds.mjs";

export const HOLD_LABELS = ["do-not-merge", "do not merge", "dnm", "wip", "blocked"];

/** @param {string} name */
export function isMergeHoldLabel(name) {
  const key = labelKey(name);
  return key.includes("hold") || HOLD_LABELS.some((label) => labelKey(label) === key);
}

// A GitHub closing keyword and what it names: "fix #N", "Fixes: owner/repo#N", "closes GH-N" or a github.com
// issue or pull link. No word boundary before the keyword, as in the monitor's scan: a refusal of "hotfix #N" costs a
// reword, where a miss closes a pull request unmerged. One run of spaces before an optional colon and one after it, so a
// long run of spaces is read in linear time. A repository name may start with a dot (owner/.github), but is not . or ..
const REPO = String.raw`[\w-]+\/(?!\.\.?(?![\w.-]))[\w.-]+`;
const CLOSING_REF = new RegExp(String.raw`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*(?::\s*)?(?:(?:https?:\/\/)?(?:www\.)?github\.com\/(${REPO})\/(?:issues|pull)\/|(?:(${REPO}))?#|gh-)(\d+)(?!\w)`, "gi");
const MAX_CLOSING_TARGETS = 50;
// GitHub lists at most 250 commits of a pull request, so a longer one's squash text cannot be read whole.
const MAX_LISTED_COMMITS = 250;

/** Every closing keyword in `texts` with the repository and number it names, in text order.
 * @param {string[]} texts @param {string} repo the repository a bare #N belongs to */
export function closingRefs(texts, repo) {
  return texts.flatMap((text) => [...String(text ?? "").matchAll(CLOSING_REF)].map((m) => (
    { phrase: m[0].replace(/\s+/g, " "), repo: m[1] ?? m[2] ?? repo, number: Number(m[3]) })));
}

/** The refusals for the open pull requests a closing keyword in the squash text names, and the squash title, which the
 * merge request sets so that a later title edit cannot change it. GitHub closes every pull request named there
 * unmerged once the squash lands. The squash text is the title and every commit message (the repository squashes with
 * the commit messages), and the body in case that setting changes. This PR itself and the numbers in `closes` (this
 * repository) are meant; issues and closed pull requests stay as they are. A phrase is shown as `shown` gives the text
 * it is in, as hold lines are, and one it hides refuses unread.
 * @param {{repo: string, pr: number, view: any, closes: number[], gh: (args: string[]) => Promise<string>, shown?: (text: string) => string}} options
 * @returns {Promise<{closing: string[], squashTitle: string}>}
 */
async function closingHolds({ repo, pr, view, closes, gh, shown }) {
  if (typeof view.title !== "string" || !view.title.trim()) throw new Error(`PR #${pr}: malformed title`);
  const count = view.commits;
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`PR #${pr}: malformed commit count`);
  if (count > MAX_LISTED_COMMITS) throw new Error(`PR #${pr}: ${count} commits; GitHub lists ${MAX_LISTED_COMMITS}, so the squash text cannot be read whole`);
  /** @type {string[]} */
  const messages = [];
  let reachesHead = false;
  for (let page = 1; page <= Math.ceil(MAX_LISTED_COMMITS / 100); page++) {
    const rows = JSON.parse(await gh(["api", `repos/${repo}/pulls/${pr}/commits?per_page=100&page=${page}`]));
    if (!Array.isArray(rows) || rows.length > 100 || !rows.every((r) => r && typeof r.sha === "string" && typeof r.commit?.message === "string"))
      throw new Error(`PR #${pr}: malformed pulls/${pr}/commits`);
    messages.push(...rows.map((r) => r.commit.message));
    reachesHead ||= rows.some((r) => r.sha === view.head?.sha);
    if (rows.length < 100) break;
  }
  // The list and the count come from separate reads: a push between them, or a short answer, reads again.
  if (messages.length !== count) throw new Error(`PR #${pr}: the commit list has ${messages.length} of the PR's ${count} commits; read it again`);
  if (!reachesHead) throw new Error(`PR #${pr}: the commit list does not reach the head; read it again`);
  // GitHub's squash title (COMMIT_OR_PR_TITLE): the commit's own for one commit, else the PR's, with the PR's number.
  const squashTitle = `${count === 1 ? messages[0].split("\n")[0].trim() || view.title : view.title} (#${pr})`;
  const texts = [squashTitle, view.title, view.body ?? "", ...messages];
  const own = repo.toLowerCase();
  const keyOf = (/** @type {{repo: string, number: number}} */ ref) => `${ref.repo.toLowerCase()}#${ref.number}`;
  /** @type {Map<string, {phrase: string, repo: string, number: number}>} */
  const targets = new Map();
  for (const ref of closingRefs(texts, repo)) {
    if (ref.repo.toLowerCase() === own && (ref.number === pr || closes.includes(ref.number))) continue;
    if (!targets.has(keyOf(ref))) targets.set(keyOf(ref), ref);
  }
  if (targets.size > MAX_CLOSING_TARGETS) throw new Error(`PR #${pr}: closing keywords name ${targets.size} issues or pull requests; at most ${MAX_CLOSING_TARGETS} are checked`);
  // Read from each text as `shown` gives it whole, as a phrase taken out first loses what marks a secret around it.
  const shownRefs = shown ? closingRefs(texts.map((text) => shown(String(text))), repo) : null;
  /** @type {string[]} */
  const closing = [];
  let hidden = false;
  for (const [key, ref] of targets) {
    const same = ref.repo.toLowerCase() === own;
    const seen = shownRefs ? shownRefs.find((r) => keyOf(r) === key) : ref;
    // A phrase `shown` hides refuses unread: neither its words nor what it names are shown, or put in a read's error.
    if (!seen) {
      hidden = true;
      continue;
    }
    const name = same ? `#${seen.number}` : `${seen.repo}#${seen.number}`;
    // Read as it is shown, as a hidden spelling of it may differ in case. A failed read throws as it came, so a caller
    // still tells a transient one from the rest.
    const target = JSON.parse(await gh(["api", `repos/${seen.repo}/issues/${seen.number}`]));
    if (!target || target.number !== seen.number || typeof target.state !== "string") throw new Error(`PR #${pr}: malformed ${name}`);
    if (!target.pull_request || target.state !== "open") continue;
    closing.push(`closing keyword "${seen.phrase}" names open pull request ${name}, which GitHub would close unmerged at the squash; reword it`);
  }
  if (hidden) closing.push("a closing keyword redacted here names an issue or pull request, which GitHub would close at the squash; reword it");
  return { closing, squashTitle };
}

/** Read every hold surface. Any incomplete API response refuses automatic action. A comment's or review's hold line
 * is in force until a later trusted release supersedes it (`currentTexts`).
 * `shown` gives a text as its hold line may be shown: the bridge passes its redactor here, as this file does not import it. For an open PR, `closing` lists the refusals for the other open pull requests a closing keyword in
 * its squash text names (closingHolds; `closes` lists the ones whose close is meant), apart from the holds: they stop
 * the merge only, and change when another PR does. `squashTitle` is the title the merge request must set; null unless
 * the PR is open. `forMerge: false` skips that merge-only read, for a caller that only wants the holds.
 * @param {{repo: string, pr: number, gh: (args: string[]) => Promise<string>, holdsFile?: string, now?: number, shown?: (text: string) => string, closes?: number[], rngStop?: string, forMerge?: boolean}} options
 */
export async function readMergeHolds({ repo, pr, gh, holdsFile, now, shown, closes = [], forMerge = true }) {
  const root = `repos/${repo}`;
  const json = async (/** @type {string} */ route) => JSON.parse(await gh(["api", `${root}/${route}`]));
  const view = await json(`pulls/${pr}`);
  if (!view || view.number !== pr || (view.body !== null && typeof view.body !== "string") || !Array.isArray(view.labels)
    || !view.labels.every((/** @type {any} */ l) => l && typeof l.name === "string")) throw new Error(`PR #${pr}: malformed hold metadata`);
  const pages = async (/** @type {string} */ route, /** @type {(r: any) => boolean} */ valid = (r) => r && (r.body === null || typeof r.body === "string")) => {
    /** @type {any[]} */
    const all = [];
    for (let page = 1; page <= 20; page++) {
      const rows = await json(`${route}?per_page=100&page=${page}`);
      if (!Array.isArray(rows) || rows.length > 100 || !rows.every(valid)) throw new Error(`PR #${pr}: malformed ${route}`);
      all.push(...rows);
      if (rows.length < 100) return all;
    }
    throw new Error(`PR #${pr}: ${route} pagination exhausted`);
  };
  const commentRows = await pages(`issues/${pr}/comments`);
  const reviewRows = await pages(`pulls/${pr}/reviews`);
  const reviewCommentRows = await pages(`pulls/${pr}/comments`);
  const comments = commentRows.map((r) => r.body ?? "");
  const texts = [view.body ?? "", ...comments, ...reviewRows.map((r) => r.body ?? ""), ...reviewCommentRows.map((r) => r.body ?? "")];
  const note = (/** @type {any} */ r, /** @type {unknown} */ posted, /** @type {unknown} */ changed) => ({ body: r.body, posted: typeof posted === "string" ? posted : null, changed: typeof changed === "string" ? changed : null, association: typeof r.author_association === "string" ? r.author_association : null });
  const notes = [
    ...commentRows.map((r) => note(r, r.created_at, r.updated_at)),
    // A review's summary can be edited and GitHub gives no time for it, so a review is never superseded.
    ...reviewRows.map((r) => note(r, r.submitted_at, null)),
    ...reviewCommentRows.map((r) => note(r, r.created_at, r.updated_at)),
  ];
  const live = currentTexts({ body: view.body, notes });
  const holds = view.labels.filter((/** @type {any} */ l) => isMergeHoldLabel(l.name)).map((/** @type {any} */ l) => `label ${l.name}`);
  const line = holdLines(live);
  // Found in the texts as written, so a hold always holds; shown from the texts as `shown` gives them whole, as a line
  // taken out first loses what marks a secret around it (a block's header, a continued line).
  if (line !== null) holds.push(`PR text: ${shown ? (holdLines(live.map((text) => shown(String(text ?? "")))) ?? "[redacted]") : line}`);
  const { closing, squashTitle } = view.state === "open" && forMerge ? await closingHolds({ repo, pr, view, closes, gh, shown }) : { closing: [], squashTitle: null };
  // Read after the last await, so a hold written during the lookups still holds the merge.
  holds.push(...fileHolds(pr, { file: holdsFile, now: now ?? Date.now() }));
  return { holds, closing, squashTitle, texts, comments, view, labels: view.labels.map((/** @type {any} */ l) => l.name) };
}
