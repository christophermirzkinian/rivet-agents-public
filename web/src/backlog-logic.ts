import type { BacklogAsk, BacklogIssue, BacklogResponse, BacklogStart } from "../../src/shared/backlog.js";
import type { PullRequest } from "../../src/shared/ops.js";
import { NO_REPO } from "../../src/shared/repos.js";
import { shownTitle } from "../../src/shared/short-titles.js";
import { clock, isToday, shortDate } from "../../src/shared/when.js";
import type { Worker } from "../../src/shared/workers.js";

// A project is a repo: one desk each, and one backlog sheet: the issues Start work began, its asks not started or
// parked, the issues waiting on your call, the drafts nobody is on, then its other issues.

/** The project a chat belongs to: the one set on the chat, else its worktree's repo. */
export const homeOf = (worker: Pick<Worker, "repo" | "project">): string => worker.project ?? worker.repo;

/** A project's name: its repo's, less the owner; a chat in no repo sits under "Other chats". */
export const projectName = (repo: string): string => (repo ? (repo.split("/").pop() ?? repo) : "Other chats");

export type BacklogTag = "started" | "start" | "parked" | "call" | "issue" | "pr";
export const TAG_WORDS: Record<BacklogTag, string> = { started: "Started", start: "Not started", parked: "Parked", call: "Issue", issue: "Issue", pr: "PR" };

export interface BacklogRow {
  key: string;
  tag: BacklogTag;
  title: string;
  sub: string;
  /** GitHub's page for an issue or PR. */
  url: string | null;
  ask: BacklogAsk | null;
  /** The issue a tap opens in the app: an issue's row, or one Start work began. */
  issue: number | null;
  start?: BacklogStart;
}

export interface BacklogSection {
  id: "started" | "asks" | "call" | "drafts" | "issues";
  title: string;
  /** The section's count beside its title, when the rows are fewer than it names. */
  count: number | null;
  rows: BacklogRow[];
  /** Rows shown before "N more ›". */
  shown: number;
}

export interface Backlog {
  repo: string;
  head: string;
  sections: BacklogSection[];
  /** GitHub's list; a project with no repo has none. */
  foot: { label: string; url: string } | null;
}

const SHOWN = { started: 5, asks: 4, call: 3, drafts: 5, issues: 5 } as const;

const isLog = (issue: BacklogIssue) => issue.labels.includes("type:log");
const isOwner = (issue: BacklogIssue) => issue.labels.includes("autonomy:owner");
const isBug = (issue: BacklogIssue) => issue.labels.includes("type:bug") || issue.labels.includes("bug");
const newest = (a: { updatedAt: string }, b: { updatedAt: string }) => b.updatedAt.localeCompare(a.updatedAt);
/** A GitHub title on one line. */
const plain = (title: string) => title.replace(/\s+/g, " ").trim() || "Untitled";
const join = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ");

function askRow(ask: BacklogAsk, now: number): BacklogRow {
  const repo = ask.repo ?? NO_REPO;
  const issue = ask.issue === undefined ? null : repo === NO_REPO ? `#${ask.issue}` : `${projectName(repo)} #${ask.issue}`;
  return {
    key: `ask-${ask.id}`,
    tag: ask.stage === "parked" ? "parked" : "start",
    title: shownTitle(ask.short, ask.words),
    sub: join(ask.why, issue, shortDate(ask.createdAt, now)),
    url: ask.issue === undefined || !repo ? null : `https://github.com/${repo}/issues/${ask.issue}`,
    ask,
    issue: null,
  };
}

function issueRow(repo: string, issue: BacklogIssue, tag: "call" | "issue", now: number): BacklogRow {
  return { key: `issue-${issue.number}`, tag, title: plain(issue.title), sub: join(`#${issue.number}`, shortDate(issue.updatedAt, now)), url: `https://github.com/${repo}/issues/${issue.number}`, ask: null, issue: issue.number };
}

/** "Started 1:52pm" today, "Started 2 Nov" before. */
export function startedWords(at: string, now: number): string {
  return `Started ${isToday(at, now) ? clock(at) : shortDate(at, now)}`;
}

function startedRow(start: BacklogStart, title: string | undefined, now: number): BacklogRow {
  return {
    key: `started-${start.issue}`,
    tag: "started",
    // Start work's words end in the title as it read then.
    title: plain(title ?? start.words.replace(/^Start work on [^:]*: /, "")),
    sub: join(`#${start.issue}`, start.chat ? `On it: ${start.chat}` : startedWords(start.at, now)),
    url: `https://github.com/${start.repo}/issues/${start.issue}`,
    ask: null,
    issue: start.issue,
    start,
  };
}

/**
 * The sheet for `repo`: sections in order, empty ones left out. `prs` are the open PRs the app already reads; only
 * this repo's drafts are taken.
 */
export function backlogOf(repo: string, data: BacklogResponse, prs: readonly PullRequest[], now = Date.now()): Backlog {
  const reading = data.repos[repo];
  // An issue Close closed leaves at once; one Start work began shows once, in Started.
  const closing = new Set((data.closing ?? []).map((one) => `${one.repo}#${one.issue}`));
  const starts = (data.started ?? []).filter((start) => !closing.has(`${start.repo}#${start.issue}`));
  const startAsks = new Set((data.started ?? []).map((start) => start.ask));
  const asks = data.asks.filter((ask) => !startAsks.has(ask.id) && !(ask.issue !== undefined && closing.has(`${ask.repo ?? NO_REPO}#${ask.issue}`)) && (ask.repo ?? NO_REPO) === repo);
  const started = asks.filter((ask) => ask.stage === "queued");
  const parked = asks.filter((ask) => ask.stage === "parked");
  // An issue an ask names shows once, as the ask's row.
  const askIssues = new Set([...data.asks.filter((ask) => ask.issue !== undefined).map((ask) => `${ask.repo ?? NO_REPO}#${ask.issue}`), ...starts.map((start) => `${start.repo}#${start.issue}`), ...closing]);
  const free = (issue: BacklogIssue) => !askIssues.has(`${repo}#${issue.number}`);

  // Every open issue read, once each: the owner's newest, the newest and the open bugs. An owner-labelled one the other
  // reads found waits on your call too. Logs are left out everywhere.
  const pool = new Map<number, BacklogIssue>();
  for (const issue of [...(reading?.owner ?? []), ...(reading?.recent ?? []), ...(reading?.bugs ?? [])]) if (!pool.has(issue.number)) pool.set(issue.number, issue);
  const ownerNumbers = new Set((reading?.owner ?? []).map((issue) => issue.number));
  const ownerAll = [...pool.values()].filter((issue) => ownerNumbers.has(issue.number) || isOwner(issue));
  const ownerRead = ownerAll.filter((issue) => !isLog(issue));
  const othersRead = [...pool.values()].filter((issue) => !isLog(issue) && !isOwner(issue) && !ownerNumbers.has(issue.number));
  const owner = ownerRead;
  const recent = othersRead;

  const callRows = owner.filter(free).sort(newest).map((issue) => issueRow(repo, issue, "call", now));
  const otherRows = recent
    .filter(free)
    .sort((a, b) => Number(isBug(b)) - Number(isBug(a)) || newest(a, b))
    .map((issue) => issueRow(repo, issue, "issue", now));
  // The counts are the repo's less its logs and the issues an ask's row stands for.
  const ownerLogs = ownerAll.length - ownerRead.length;
  const named = owner.length - callRows.length + recent.length - otherRows.length;
  const callCount = !reading ? 0 : Math.max(callRows.length, reading.ownerTotal - ownerLogs - (owner.length - callRows.length));
  const issueCount = !reading ? 0 : Math.max(callRows.length + otherRows.length, reading.total - reading.logs - named);
  const draftRows = prs
    .filter((pr) => pr.draft && pr.repo === repo)
    .sort(newest)
    .map((pr): BacklogRow => ({ key: `pr-${pr.number}`, tag: "pr", title: plain(pr.title), sub: `#${pr.number} · draft`, url: `https://github.com/${repo}/pull/${pr.number}`, ask: null, issue: null }));
  const otherCount = Math.max(otherRows.length, issueCount - callCount);
  const startedRows = starts
    .filter((start) => start.repo === repo)
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((start) => startedRow(start, pool.get(start.issue)?.title, now));

  const sections: BacklogSection[] = [
    { id: "started", title: "Started", count: null, rows: startedRows, shown: SHOWN.started },
    { id: "asks", title: "Your asks", count: null, rows: [...started, ...parked].map((ask) => askRow(ask, now)), shown: SHOWN.asks },
    { id: "call", title: "Needs your call", count: callCount > callRows.length ? callCount : null, rows: callRows, shown: SHOWN.call },
    { id: "drafts", title: "Drafts nobody is on", count: null, rows: draftRows, shown: SHOWN.drafts },
    { id: "issues", title: "Other issues", count: otherCount > otherRows.length ? otherCount : null, rows: otherRows, shown: SHOWN.issues },
  ];
  const head = join(
    startedRows.length ? `${startedRows.length} started` : null,
    started.length ? `${started.length} to start` : null,
    parked.length ? `${parked.length} parked` : null,
    callCount ? `${callCount} your call` : null,
    issueCount ? `${issueCount} ${issueCount === 1 ? "issue" : "issues"}` : null,
  );
  const label = reading?.total ? "All open issues on GitHub ›" : `Open ${projectName(repo)} on GitHub ›`;
  return { repo, head, sections: sections.filter((section) => section.rows.length), foot: repo ? { label, url: `https://github.com/${repo}/issues` } : null };
}

/** "N more ›" under a section's first rows; "N more parked ›" when every hidden ask is parked. */
export function moreLabel(section: BacklogSection): string | null {
  const hidden = section.rows.slice(section.shown);
  if (!hidden.length) return null;
  return `${hidden.length} more${section.id === "asks" && hidden.every((row) => row.tag === "parked") ? " parked" : ""} ›`;
}
