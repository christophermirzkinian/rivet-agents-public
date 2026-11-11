import { comingChatRepo, type BoardChat, type ComingItem, type Need } from "../../src/shared/board.js";
import type { PullRequest, TimelineResponse } from "../../src/shared/ops.js";
import { NO_REPO } from "../../src/shared/repos.js";
import { when } from "../../src/shared/when.js";
import { TYPED_FRESH_MS, type Worker } from "../../src/shared/workers.js";
import { holdsPr, type OwnerHold } from "../../src/shared/owner-holds.js";
import { holdOf, holdReason } from "../../src/shared/pr-holds.js";

/**
 * The Agents board: every agent chat as a card in the column its own data puts it in. Nobody moves a card; a card in the
 * wrong column is a bug in these rules.
 */
/**
 * Four columns: Waiting is a card for you; In-Review is an open PR, its CI or any other review, or its merge and deploy
 * still going.
 */
export const COLUMNS = ["building", "waiting", "review", "merged"] as const;
export type Column = (typeof COLUMNS)[number];
/** How long a merged chat stays in Done. */
export const MERGED_SHOWN_MS = 24 * 60 * 60 * 1000;

/** A row of GET /api/claims (claims-board): one claimed file or glob. */
export interface Claim {
  pattern: string;
  chat: string;
  pr?: number;
  createdAt?: string;
}

export interface KanbanInput {
  now: number;
  /** The live chats, Rivet's own left out. */
  workers: readonly Worker[];
  chats: readonly BoardChat[];
  coming: readonly ComingItem[];
  /** The cards waiting on you: the deck and your Later ones, no update cards. */
  cards: readonly Need[];
  /** The open PRs, or null while GitHub's reading is not current. */
  prs: readonly PullRequest[] | null;
  /** Repos (short names) whose open-PR read failed this time: their PRs are unknown, not closed. */
  prsFailed?: readonly string[];
  timeline: TimelineResponse | null;
  /**
   * Your own holds (GET /api/ops/holds), the one source of "held on you"; null or left out while not loaded. A hold in a
   * PR's text or a hold label never puts a chat at your OK, as it never makes you a card.
   */
  ownerHolds?: readonly OwnerHold[] | null;
  /** Null while there is no claims API: the line is left off. */
  claims: readonly Claim[] | null;
}

export interface KanbanCard {
  key: string;
  chat: string;
  repo: string;
  column: Column;
  /** Why it is in that column, in plain words. */
  why: string;
  /** What it is doing, or null when nothing says. */
  task: string | null;
  pr: { number: number; url: string } | null;
  /** Its claimed shared files; null when the claims API is not there. */
  claims: string[] | null;
  /** Its latest update (ISO), or null when nothing says. */
  updatedAt: string | null;
  /** When it says it will be done (ISO): its ETA from its last progress write; null when it has given none. */
  dueAt: string | null;
  /** It comes to you for your OK before it ships: an open PR you hold yourself, or a Coming row at your OK. */
  forOk: boolean;
  /** What the ticket pop-up shows beyond the card. */
  ticket: Ticket;
}

/** Everything the board knows about one chat, for its ticket. */
export interface Ticket {
  /** The open chat, or null once it has closed. */
  worker: Worker | null;
  /** Its own board row (the one under its name first). */
  board: BoardChat | null;
  /** Its open PRs, newest first. */
  prs: PullRequest[];
  /** Its merged PRs, newest first. */
  merged: { number: number; at: string; url: string; title?: string }[];
  /** Your cards that stand for it. */
  cards: Need[];
  coming: ComingItem[];
  /** Issue numbers its cards name. */
  issues: number[];
}

// An event with no repo (older stored ones) keys by number alone rather than throwing the Board away.
const repoName = (repo: string) => (repo ?? "").split("/").pop() || repo;
const prKey = (repo: string, number: number) => `${repoName(repo)}#${number}`;
const latest = (...times: (string | null | undefined)[]): string | null =>
  times.filter((at): at is string => typeof at === "string" && Number.isFinite(Date.parse(at))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;

/** Merged PRs by repo#number → when, from the Ops timeline and the Coming rows' own merge stamps. */
function mergedTimes(input: KanbanInput): Map<string, string> {
  const merged = new Map<string, string>();
  for (const event of mergedEvents(input)) merged.set(prKey(event.repo, event.number!), event.at!);
  for (const item of input.coming) {
    if (item.pr !== undefined && typeof item.mergedAt === "string") {
      const key = prKey(item.mergedRepo ?? NO_REPO, item.pr);
      if (!merged.has(key)) merged.set(key, item.mergedAt);
    }
  }
  return merged;
}

function mergedEvents(input: KanbanInput) {
  return (input.timeline?.days ?? []).flatMap((day) => day.events.filter((event) => event.kind === "merged" && event.number !== undefined && !!event.at));
}

/**
 * The chat a name like `search-box-73` stands for in its repo: the open chat `search-box` unless one is open under the
 * full name (as the server and the Feed read it), else whichever of the two the board knows.
 */
export function chatFor(repo: string, name: string, live: ReadonlySet<string>, known: ReadonlySet<string>): string {
  const base = name.replace(/-\d+$/, "");
  if (base === name) return name;
  for (const names of [live, known]) {
    if (names.has(seedKey(repo, name))) return name;
    if (names.has(seedKey(repo, base))) return base;
  }
  return name;
}

/** A Coming row's repo: the one it merged in, else that of the board chat holding its PR; null when two repos claim it. */
function comingRepo(chats: readonly BoardChat[], item: ComingItem & { chat: string }): string | null {
  if (item.mergedRepo) return item.mergedRepo;
  const repo = comingChatRepo(chats, item.chat, item.pr);
  return repo === null ? null : (repo ?? NO_REPO);
}

/** The timeline names a repo by its short name; a card links by owner/name, as a live chat or the default repo gives it. */
const fullRepo = (repo: string, workers: readonly Worker[]) =>
  repo.includes("/") ? repo : ([NO_REPO, ...workers.map((worker) => worker.repo)].find((full) => repoName(full) === repo) ?? repo);

export const seedKey = (repo: string, chat: string) => `${repoName(repo)}\n${chat}`;


interface Seed {
  chat: string;
  repo: string;
  live: boolean;
  worker?: Worker;
  /** Its board rows: its own, and numbered ones that are the open chat's (all their PRs count). */
  boards: BoardChat[];
  coming: ComingItem[];
  cards: Need[];
}

export function kanban(input: KanbanInput): KanbanCard[] {
  const merged = mergedTimes(input);
  const merges = mergedEvents(input);
  const mergeUrls = new Map(merges.flatMap((event) => (event.url ? [[prKey(event.repo, event.number!), event.url] as const] : [])));
  const mergeTitles = new Map(merges.map((event) => [prKey(event.repo, event.number!), event.title] as const));
  const open = new Map((input.prs ?? []).map((pr) => [prKey(pr.repo, pr.number), pr]));
  const seeds = new Map<string, Seed>();
  const seed = (repo: string, chat: string): Seed => {
    const key = seedKey(repo, chat);
    let found = seeds.get(key);
    if (!found) seeds.set(key, (found = { chat, repo, live: false, boards: [], coming: [], cards: [] }));
    return found;
  };
  for (const worker of input.workers) Object.assign(seed(worker.repo, worker.chat), { live: true, worker });
  const live = new Set(seeds.keys());
  // A numbered board row is the open chat's row (`search-box-73` for an open `search-box`).
  for (const chat of input.chats) {
    const repo = typeof chat.repo === "string" ? chat.repo : NO_REPO;
    seed(repo, chatFor(repo, chat.name, live, live)).boards.push(chat);
  }
  // A chat that merged in the last day and has since closed and left the board still shows, under its branch's name,
  // unless an open chat or a board row already holds that merge.
  const comingAt = new Map(input.coming.flatMap((item) => (item.chat ? [[item, comingRepo(input.chats, { ...item, chat: item.chat })] as const] : [])));
  const claimed = new Set([
    ...[...input.workers, ...input.chats].flatMap((one) => (one.prs ?? []).map((number) => prKey(typeof one.repo === "string" ? one.repo : NO_REPO, number))),
    ...[...comingAt].flatMap(([item, repo]) => (repo !== null && item.pr !== undefined ? [prKey(repo, item.pr)] : [])),
  ]);
  const branches = new Set(input.workers.map((worker) => `${repoName(worker.repo)}\n${worker.branch}`));
  for (const event of merges) {
    // `rivet fix` opens <owner>/<yyMMdd-HHmmss>/<chat>: the stamp is skipped, the chat name stays last.
    const name = /^[^/]+\/(?:\d{6}-\d{6}\/)?([^/]+)$/.exec(event.branch ?? "")?.[1];
    if (!name || input.now - Date.parse(event.at!) > MERGED_SHOWN_MS) continue;
    if (claimed.has(prKey(event.repo, event.number!)) || branches.has(`${repoName(event.repo)}\n${event.branch}`)) continue;
    const repo = fullRepo(event.repo, input.workers);
    const chat = chatFor(repo, name, live, new Set(seeds.keys()));
    // An open chat's merges are only those from the branch it has checked out.
    if (!live.has(seedKey(repo, chat))) seed(repo, chat);
  }
  // A numbered card or Coming name reads against the open chats first, then the board's; a Coming row's own numbered
  // name never takes a card from its chat.
  const known = new Set(seeds.keys());
  // A Coming row names no repo: it is the repo it merged in, else that of the board chat holding its PR; two
  // candidates and nothing is guessed (comingChatRepo).
  for (const [item, repo] of comingAt) if (repo !== null) seed(repo, chatFor(repo, item.chat!, live, known)).coming.push(item);
  // A card stands for its chat even when the chat has closed and left the board.
  for (const need of input.cards) {
    if (!need.chat) continue;
    const repo = need.repo ?? NO_REPO;
    seed(repo, chatFor(repo, need.chat, live, known)).cards.push(need);
  }
  // A claim names no repo: it is the default repo's, as the claims board settles it against that repo's PRs alone.
  const claimsOf = new Map<string, string[]>();
  for (const claim of input.claims ?? []) {
    const at = seedKey(NO_REPO, claim.chat);
    claimsOf.set(at, [...(claimsOf.get(at) ?? []), claim.pattern]);
  }
  const failed = new Set(input.prsFailed ?? []);

  // A closed chat's branch names it as a card does (`x/search-box-73` is `search-box`'s).
  const everyone = new Set(seeds.keys());
  const cards: KanbanCard[] = [];
  for (const [key, one] of seeds) {
    const { worker, boards } = one;
    // The row under its own name speaks for it first.
    const board = boards.find((row) => row.name === one.chat) ?? boards[0];
    const numbers = new Set<number>([...(worker?.prs ?? []), ...boards.flatMap((row) => row.prs ?? [])]);
    for (const item of one.coming) if (item.pr !== undefined) numbers.add(item.pr);
    const sameRepo = (repo: string) => repoName(repo) === repoName(one.repo);
    // A PR is the chat's when it came from the branch the chat has checked out, or, once the chat has closed, from a
    // branch named after it (<owner>/<chat>), named on the board or not.
    const ours = (branch: string | undefined, repo: string) =>
      !!branch &&
      sameRepo(repo) &&
      (worker ? branch === worker.branch : !branches.has(`${repoName(repo)}\n${branch}`) && chatFor(one.repo, branch.split("/").pop()!, live, everyone) === one.chat);
    for (const pr of input.prs ?? []) if (ours(pr.branch, pr.repo)) numbers.add(pr.number);
    for (const event of merges) if (ours(event.branch, event.repo)) numbers.add(event.number!);
    const openPrs = [...numbers].flatMap((number) => open.get(prKey(one.repo, number)) ?? []).sort((a, b) => b.number - a.number);
    const mergedPrs = [...numbers]
      .flatMap((number) => {
        const at = merged.get(prKey(one.repo, number));
        return at ? [{ number, at }] : [];
      })
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const current = openPrs[0];
    const recentMerge = mergedPrs[0] && input.now - Date.parse(mergedPrs[0].at) <= MERGED_SHOWN_MS ? mergedPrs[0] : undefined;
    // Without a current read of this repo's open PRs, an unmerged PR of the chat may still be open.
    const unknown = input.prs === null || failed.has(repoName(one.repo));
    const unsettled = unknown && mergedPrs.length < numbers.size;

    const prCards = input.cards.filter((need) => need.pr !== undefined && numbers.has(need.pr) && sameRepo(need.repo ?? NO_REPO));
    const card = one.cards[0] ?? prCards[0];
    const waitingCards = [...new Set([...one.cards, ...prCards])];
    // A hold in its body or a hold label, as Ops reads it.
    const holds = openPrs.flatMap((pr) => {
      const hold = holdOf(pr);
      return hold ? [{ pr, hold }] : [];
    });
    // A merge or deploy still going is review's last step: a Coming row's stage, or the chat's own once the merge has
    // settled its Coming row.
    const comingStage = one.coming.find((item) => item.stage === "merging" || item.stage === "deploying")?.stage;
    // A typed stage goes stale as the server's does (TYPED_FRESH_MS): an old "Deploying" is not a deploy going.
    const touched = [board?.touchedAt, board?.moved, board?.updatedAt].find((at): at is string => typeof at === "string");
    const typedFresh = !(input.now - Date.parse(touched ?? "") > TYPED_FRESH_MS);
    const chatStage =
      worker && typedFresh && board?.state === "working" ? /\b(deploying|merging)\b/i.exec(board.stage ?? "")?.[1]?.toLowerCase() : undefined;
    const shipping = comingStage ?? chatStage;
    let column: Column;
    let why: string;
    // Waiting on you is a card for you and nothing else: a held PR or a Coming row for your OK stays in its own column,
    // noted.
    if (card) {
      column = "waiting";
      why = `Your card: ${card.title}`;
    } else if (current && current.draft) {
      column = "building";
      why = "Draft PR";
    } else if (current && (current.ciStartedAt || current.checks.state === "pending" || current.checks.pending > 0)) {
      column = "review";
      why = "CI running";
    } else if (current) {
      column = "review";
      why = current.checks.state === "fail" ? `PR open, ${current.checks.failed} failing` : "PR open";
    } else if (shipping) {
      column = "review";
      why = shipping === "deploying" ? "Deploying" : "Merging";
    } else if (recentMerge && !unsettled) {
      column = "merged";
      why = `Merged ${when(recentMerge.at, input.now)}`;
    } else if (one.live) {
      column = "building";
      why = unsettled ? "PR state unknown: GitHub is behind" : numbers.size ? "No open PR" : "No PR yet";
    } else {
      // A chat that is not open, with nothing waiting and nothing merged lately, is not on the board.
      continue;
    }
    if (column !== "waiting" && holds[0]) {
      const reason = holdReason(holds[0].hold);
      why = `${why} · ${reason ? `Held: ${reason}` : "Held"}`;
    }

    // The PR that puts it here: the one its card names (open or not), else its newest open PR.
    const prNumber = (column === "waiting" ? card?.pr : undefined) ?? current?.number ?? recentMerge?.number ?? [...numbers].sort((a, b) => b - a)[0];
    const prUrl = prNumber === undefined ? undefined : (open.get(prKey(one.repo, prNumber))?.url ?? mergeUrls.get(prKey(one.repo, prNumber)));
    const task = worker?.doing ?? worker?.what ?? board?.doing ?? board?.what ?? worker?.delivering?.title ?? current?.title ?? one.coming[0]?.title ?? null;
    cards.push({
      key,
      chat: one.chat,
      repo: one.repo,
      column,
      why,
      task,
      pr: prNumber === undefined ? null : { number: prNumber, url: prUrl ?? `https://github.com/${one.repo}/pull/${prNumber}` },
      claims: input.claims ? (claimsOf.get(key) ?? []) : null,
      updatedAt: latest(worker?.updatedAt, worker?.movedAt, ...boards.flatMap((row) => [row.updatedAt, row.moved, row.touchedAt]), current?.updatedAt, recentMerge?.at),
      // A row marked done keeps no time: the ETA it gave before is never late.
      dueAt: board?.state === "done" ? null : (dueOf(worker) ?? dueOf(board)),
      forOk:
        openPrs.some((pr) => (input.ownerHolds ?? []).some((hold) => holdsPr(hold, pr.number, pr.repo))) ||
        one.coming.some((item) => item.stage === "owner-ok"),
      ticket: {
        worker: worker ?? null,
        board: board ?? null,
        prs: openPrs,
        merged: mergedPrs.map((merge) => {
          const title = mergeTitles.get(prKey(one.repo, merge.number));
          return { ...merge, url: mergeUrls.get(prKey(one.repo, merge.number)) ?? `https://github.com/${one.repo}/pull/${merge.number}`, ...(title ? { title } : {}) };
        }),
        cards: waitingCards,
        coming: one.coming,
        issues: [...new Set(waitingCards.flatMap((need) => (need.issue === undefined ? [] : [need.issue])))],
      },
    });
  }
  // Newest news first in each column.
  return cards.sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0) || a.chat.localeCompare(b.chat));
}

/** When a chat's ETA runs out: `etaMinutes` counts from its `updatedAt` (rivet chat set --eta). */
function dueOf(one: { etaMinutes?: number; updatedAt?: string } | undefined): string | null {
  if (!one || typeof one.etaMinutes !== "number") return null;
  const from = Date.parse(one.updatedAt ?? "");
  return Number.isFinite(from) ? new Date(from + one.etaMinutes * 60_000).toISOString() : null;
}

/** The cards by column, every column present. */
export function byColumn(cards: readonly KanbanCard[]): Record<Column, KanbanCard[]> {
  const columns = Object.fromEntries(COLUMNS.map((column) => [column, [] as KanbanCard[]])) as Record<Column, KanbanCard[]>;
  for (const card of cards) columns[card.column].push(card);
  return columns;
}
