import { comingChatRepo, comingChatRepos, NO_REPO, isRealTime, MAX_SHIPPED, type Board } from "../shared/board.js";

/** A merged pull request, as a merged-PR reading would list it; nothing feeds one now, so lists stay empty. */
export interface MergedPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  branch?: string;
}

export interface ClosedPr {
  repo: string;
  number: number;
  closedAt: string;
}

type Row = Record<string, unknown>;
export type StampedSection = "chats" | "coming" | "shipped";

/** What only the server writes on a row; whatever a writer sends for them is dropped. */
const SERVER_FIELDS = ["touchedAt", "shippedAt", "mergedAt", "mergedRepo"] as const;

/**
 * A coming row's repo, as the Feed resolves it: its chat's, else the default; null for a chat two repos claim.
 */
function comingRepo(chats: Board["chats"], row: Row): string | null {
  if (typeof row.chat !== "string") return NO_REPO;
  const repo = comingChatRepo(chats, row.chat, typeof row.pr === "number" ? row.pr : undefined);
  return repo === null ? null : (repo ?? NO_REPO);
}

/**
 * The row of `before` that `row` continues: a chat by name and repo, a shipped row by PR, a coming row by PR in the
 * same repo, each side's repo resolved through its own board's chats (the same number in two repos is two rows, and
 * a row whose chat changes within one repo keeps its stamps). A merged row's repo is the one its merge was read in.
 * While the row's chat is one two repos claim, the repo is not known, so the same PR on the same chat continues it if
 * one of those repos is its merge's: an added namesake chat never wipes a stored merge, and the merge comes back only
 * to its own repo's PR, to the row of its title first. A merge whose repo is unknown never crosses to a repo by the chat's name alone. A title names
 * the row only when neither side has a PR, and only in the same repo (a coming row two repos claim, on the same chat),
 * so a row that gains a PR, or a new PR with an old title, starts afresh.
 */
function previousRow(section: StampedSection, previous: Board, next: Board, row: Row): Row | undefined {
  const before = previous[section] as Row[];
  if (section === "chats") return before.find((one) => one.name === row.name && one.repo === row.repo);
  if (row.pr !== undefined && section === "coming") {
    const repo = comingRepo(next.chats, row);
    const was = (one: Row): string | null => (typeof one.mergedRepo === "string" ? one.mergedRepo : comingRepo(previous.chats, one));
    if (repo === null) {
      const claims: Set<string> = comingChatRepos(next.chats, row.chat as string, row.pr as number);
      const mine = (one: Row): boolean => typeof one.mergedAt !== "string" || claims.has(was(one) ?? "");
      const ours = before.filter((one) => one.pr === row.pr && one.chat === row.chat && mine(one));
      return ours.find((one) => one.title === row.title) ?? ours[0];
    }
    const sameChat = (one: Row): boolean => one.chat === row.chat && typeof one.mergedAt !== "string";
    return before.find((one) => one.pr === row.pr && (was(one) ?? (sameChat(one) ? repo : null)) === repo);
  }
  // A shipped PR is its repo's: GitHub numbers each repo's PRs on their own.
  if (row.pr !== undefined) return before.find((one) => one.pr === row.pr && (one.repo ?? NO_REPO) === (row.repo ?? NO_REPO));
  if (section === "shipped") return before.find((one) => one.pr === undefined && one.title === row.title && (one.repo ?? NO_REPO) === (row.repo ?? NO_REPO));
  const repo = comingRepo(next.chats, row);
  const sameRepo = (one: Row): boolean => (repo === null ? one.chat === row.chat : (comingRepo(previous.chats, one) ?? (one.chat === row.chat ? repo : null)) === repo);
  return before.find((one) => one.pr === undefined && one.title === row.title && sameRepo(one));
}

function bare(row: Row): Row {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !(SERVER_FIELDS as readonly string[]).includes(key)));
}

function content(row: Row): string {
  return JSON.stringify(bare(row), (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : value,
  );
}

/**
 * The board with the server's stamps on its chats, coming and shipped rows; whatever a writer sent for them is
 * replaced. `touchedAt` is now for a row that is new, differs from the stored one, or is the row a per-item write
 * names (`touched`); an unchanged row in a whole-board push keeps its time, so a push that only re-sends the
 * monitor's list ages nothing back to fresh. A stored row from before the stamps starts at its own `updatedAt`.
 * `shippedAt` is set once, when a row first reaches the shipped list, and never moves; a stored row from before the
 * stamps takes the `at` the monitor wrote on it, else null for a day not known. Once the key is there it is never
 * derived again, so an `at` a writer sends later is never read. A coming row keeps the `mergedAt` markMerged gave it.
 */
export function stampBoard(previous: Board | null, next: Board, now: string, touched?: { section: StampedSection; index: number }): Board {
  const past = (value: unknown): value is string => typeof value === "string" && isRealTime(value) && Date.parse(value) <= Date.parse(now);
  const stamp = (section: StampedSection): Row[] => {
    const rows = next[section] as Row[];
    const found = rows.map((row) => (previous ? previousRow(section, previous, next, row) : undefined));
    // A stored coming row's merge never crosses repos. The rows that name it whose repo is known (the stored row's) are
    // its PR and all continue it; with none, it goes to the only row on a chat two repos claim, else the only one
    // unchanged, else the only one of its title, else none (which row it was is not known). The others start afresh, so
    // settleComing never drops a row whose PR did not ship.
    const only = (ats: number[]): number | undefined => (ats.length === 1 ? ats[0] : undefined);
    const heir = (before: Row | undefined, index: number): Row | undefined => {
      if (!before || section !== "coming") return before;
      const rivals = found.flatMap((one, at) => (one === before ? [at] : []));
      const known = rivals.filter((at) => comingRepo(next.chats, rows[at]!) !== null);
      if (known.length) return known.includes(index) ? before : undefined;
      const pick = only(rivals) ?? only(rivals.filter((at) => content(rows[at]!) === content(before))) ?? only(rivals.filter((at) => rows[at]!.title === before.title));
      return pick === index ? before : undefined;
    };
    return rows.map((row, index) => {
      const before = heir(found[index], index);
      const rest = bare(row);
      const named = touched?.section === section && touched.index === index;
      const start = past(before?.updatedAt) ? before.updatedAt : now;
      const touchedAt = !before || named || content(before) !== content(rest) ? now : typeof before.touchedAt === "string" ? before.touchedAt : start;
      if (section === "coming") {
        if (typeof before?.mergedAt !== "string") return { ...rest, touchedAt };
        const mergedRepo = typeof before.mergedRepo === "string" ? before.mergedRepo : comingRepo(previous!.chats, before);
        return { ...rest, touchedAt, mergedAt: before.mergedAt, ...(mergedRepo !== null && mergedRepo !== undefined ? { mergedRepo } : {}) };
      }
      if (section === "chats") return { ...rest, touchedAt };
      const shippedAt = !before ? now : "shippedAt" in before ? (typeof before.shippedAt === "string" ? before.shippedAt : null) : past(before.at) ? before.at : null;
      return { ...rest, shippedAt, touchedAt };
    });
  };
  return { ...next, chats: stamp("chats") as Board["chats"], coming: stamp("coming") as Board["coming"], shipped: stamp("shipped") as Board["shipped"] };
}

/**
 * The board with `mergedAt` on each Coming row whose PR GitHub's merged list shows in the row's repo (its chat's, as
 * the Feed resolves it), or null when no row changes. A row whose chat two repos claim is left alone, and a row
 * already deployed needs no merge.
 */
export function markMerged(board: Board, merged: readonly MergedPr[]): Board | null {
  if (!merged.length) return null;
  let changed = false;
  const coming = board.coming.map((item) => {
    if (item.pr === undefined || typeof item.mergedAt === "string" || item.stage === "shipped") return item;
    const repo = item.chat ? comingChatRepo(board.chats, item.chat, item.pr) : undefined;
    if (repo === null) return item;
    const mergedRepo = repo ?? NO_REPO;
    const pr = merged.find((one) => one.number === item.pr && one.repo === mergedRepo);
    if (!pr) return item;
    changed = true;
    return { ...item, mergedAt: pr.mergedAt, mergedRepo };
  });
  return changed ? { ...board, coming } : null;
}

/** What settleComing reads: GitHub's merged and closed lists, the PRs open now, and the index of a row a write names. */
export interface Settling {
  merged: readonly MergedPr[];
  closed: readonly ClosedPr[];
  /** Open PRs of the latest reading: a closure older than the PR's reopening does not count. Null when that reading
   * failed, so no closure counts. */
  open?: readonly { repo: string; number: number }[] | null;
  now: string;
  keep?: number;
}

/**
 * The board with each Coming row whose PR has merged, or already has its repo's Shipped row, moved to Shipped,
 * dated by its merge, and each whose PR closed unmerged dropped, or null when nothing changes. A PR is read in the
 * row's repo, as markMerged resolves it; a row whose chat two repos claim stays until a merge is stored on it. `keep`
 * is the index of a row a write names, which stays so the write can answer with it (its index after the move is
 * returned); the next write or GitHub reading moves it. Shipped keeps its newest MAX_SHIPPED rows.
 */
export function settleComing(board: Board, { merged, closed, open = [], now, keep }: Settling): { board: Board; keep?: number } | null {
  const marked = markMerged(board, merged) ?? board;
  const shipped = [...marked.shipped];
  const sameRepo = (row: { repo?: unknown }, repo: string | null) => (row.repo ?? NO_REPO) === (repo ?? NO_REPO);
  const reopened = (one: ClosedPr) => open === null || open.some((pr) => pr.number === one.number && pr.repo === one.repo);
  let kept: number | undefined;
  let removed = 0;
  const coming = marked.coming.filter((item, index) => {
    if (item.pr === undefined || index === keep) {
      if (index === keep) kept = index - removed;
      return true;
    }
    const resolved = item.chat ? comingChatRepo(marked.chats, item.chat, item.pr) : undefined;
    const repo = typeof item.mergedRepo === "string" ? item.mergedRepo : resolved === null ? null : (resolved ?? NO_REPO);
    const mergedAt = typeof item.mergedAt === "string" ? item.mergedAt : repo && merged.find((one) => one.number === item.pr && one.repo === repo)?.mergedAt;
    const done = repo !== null && shipped.some((row) => row.pr === item.pr && sameRepo(row, repo));
    if (mergedAt && !done) {
      shipped.unshift({ pr: item.pr, title: item.title, ...(repo && repo !== NO_REPO ? { repo } : {}), shippedAt: mergedAt, touchedAt: now });
    }
    const gone = Boolean(mergedAt) || done || (repo !== null && closed.some((one) => one.number === item.pr && one.repo === repo && !reopened(one)));
    if (gone) removed++;
    return !gone;
  });
  if (coming.length === board.coming.length && marked === board) return null;
  return { board: { ...marked, coming, shipped: newestShipped(shipped) }, ...(kept === undefined ? {} : { keep: kept }) };
}

/** `rows` in their order without the oldest beyond MAX_SHIPPED, a row whose day is not known oldest of all. */
export function newestShipped<T extends { shippedAt?: string | null }>(rows: T[]): T[] {
  if (rows.length <= MAX_SHIPPED) return rows;
  const day = (row: T) => (typeof row.shippedAt === "string" ? Date.parse(row.shippedAt) : -Infinity);
  const oldest = new Set(rows.map((row, index) => ({ at: day(row), index })).sort((a, b) => a.at - b.at || b.index - a.index).slice(0, rows.length - MAX_SHIPPED).map((one) => one.index));
  return rows.filter((_, index) => !oldest.has(index));
}
