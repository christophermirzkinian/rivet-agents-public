import type { Need } from "../../src/shared/board.js";
import { chatName } from "../../src/shared/names.js";
import { NO_REPO } from "../../src/shared/repos.js";
import { clock, dayClock, localDay } from "../../src/shared/when.js";
import { NEEDS_YOU } from "../../src/shared/words.js";
import type { KanbanCard } from "./agents-logic.js";
import { projectName } from "./backlog-logic.js";

/**
 * The text Copy summary copies: one heading per project, each with what merged today, what is coming today, what is
 * being built, the cards waiting on you, and tomorrow. Each line reads by its Coming row or PR title, else the chat's
 * own words, with no PR numbers; empty groups and projects are left off.
 */
export const SUMMARY_GROUPS = ["merged", "coming", "building", "waiting", "tomorrow"] as const;
export type SummaryGroup = (typeof SUMMARY_GROUPS)[number];
export const SUMMARY_TITLES: Record<SummaryGroup, string> = {
  merged: "Merged today",
  coming: "Coming today",
  building: "Being built",
  waiting: `${NEEDS_YOU} (cards)`,
  tomorrow: "Tomorrow",
};

/** A title longer than this is cut, so one line stays one line. */
const TITLE_MAX = 100;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** The local calendar day as numbers. */
function dayOf(at: number): [number, number, number] {
  const [year, month, day] = localDay(at).split("-").map(Number);
  return [year!, month!, day!];
}
const dayKey = (at: number) => dayOf(at).join("-");
const sameDay = (a: number, b: number) => dayKey(a) === dayKey(b);
/** The calendar day as one ordered number, for "is it today or before". */
const dayStamp = (at: number) => {
  const [year, month, day] = dayOf(at);
  return Date.UTC(year, month - 1, day);
};
/** The next day by the calendar (a day is 23 or 25 hours when the clocks change), keyed as dayKey. */
function nextDay(now: number): string {
  const [year, month, day] = dayOf(now);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()].join("-");
}

/** Soonest due first, those with no ETA after. */
function order(a: KanbanCard, b: KanbanCard): number {
  const due = (card: KanbanCard) => Date.parse(card.dueAt ?? "") || Infinity;
  return due(a) - due(b) || a.chat.localeCompare(b.chat);
}

/**
 * Which group a chat still going goes in, or null when it has none: done (its merges are listed from every ticket), or
 * a card for you (listed from your cards). An ETA past tomorrow stays in its group, dated; one coming to you for your
 * OK is still being built.
 */
export function groupOf(card: KanbanCard, now: number): "coming" | "building" | "tomorrow" | null {
  if (card.column === "waiting" || card.column === "merged") return null;
  const due = Date.parse(card.dueAt ?? "");
  if (Number.isFinite(due) && dayKey(due) === nextDay(now)) return "tomorrow";
  return card.column === "review" && !card.forOk ? "coming" : "building";
}

/** A title without its PR numbers ("Search box #12: approve", "Fix (#12)", "Search box (PR 12)"). */
const plain = (title: string) =>
  title
    .replace(/\s*\((?:(?:PR\s*)?#?\d+[,\s]*)+\)/gi, "")
    .replace(/\s*\bPR\s*#?\d+\b/gi, "")
    .replace(/\s*#\d+\b/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

/** A chat's line: its Coming row's title, else its PR's, else the first line of what it is at, else its name. */
function titleOf(card: KanbanCard): string {
  const number = card.pr?.number;
  const coming = card.ticket.coming.find((item) => item.pr !== undefined && item.pr === number) ?? card.ticket.coming.find((item) => item.pr === undefined);
  const title = (coming?.title ?? card.ticket.prs.find((pr) => pr.number === number)?.title ?? card.ticket.prs[0]?.title ?? card.task?.split("\n")[0])?.trim();
  return cut(plain(title || chatName(card.chat)), TITLE_MAX);
}

/** "5:05pm", with its day when not today (left off under Tomorrow); nothing once passed. */
function dueWords(card: KanbanCard, now: number, withDay = true): string {
  const due = Date.parse(card.dueAt ?? "");
  if (!Number.isFinite(due) || due < now) return "";
  return sameDay(due, now) || !withDay ? clock(due) : dayClock(due);
}

const repoName = (repo: string) => repo.split("/").pop() ?? repo;

/** One project's groups, every line of it already of the project's repo. */
function projectGroups(cards: readonly KanbanCard[], needs: readonly Need[], prTitle: ReadonlyMap<string, string>, now: number): string[] {
  const groups = Object.fromEntries(SUMMARY_GROUPS.map((group) => [group, [] as string[]])) as Record<SummaryGroup, string[]>;
  const seen = new Set<string>();
  const add = (group: SummaryGroup, title: string, when: string) => {
    // One line per title: two chats on one thing read once.
    if (seen.has(title)) return;
    seen.add(title);
    groups[group].push(`• ${title}${when ? `, ${when}` : ""}`);
  };
  // A line merged today reads by its merge's title, once (the newest chat to hold it speaks for it); read first, so a
  // merged PR still deploying reads as merged, not coming.
  const done = new Map<string, { title: string; at: number }>();
  for (const card of cards)
    for (const merge of card.ticket.merged) {
      const at = Date.parse(merge.at);
      const title = merge.title ? cut(plain(merge.title), TITLE_MAX) : "";
      if (title && Number.isFinite(at) && sameDay(at, now) && !done.has(merge.title!)) done.set(merge.title!, { title, at });
    }
  for (const merge of [...done.values()].sort((a, b) => b.at - a.at)) add("merged", merge.title, `done ${clock(merge.at)}`);
  const mergedToday = new Set(cards.flatMap((card) => card.ticket.merged.filter((merge) => sameDay(Date.parse(merge.at), now)).map((merge) => `${card.repo}#${merge.number}`)));
  for (const card of [...cards].sort(order)) {
    const group = groupOf(card, now);
    if (!group) continue;
    const title = titleOf(card);
    if (group === "coming") {
      // Today's go in Coming today, a later day's are left out.
      if (card.pr && mergedToday.has(`${card.repo}#${card.pr.number}`)) continue;
      const due = Date.parse(card.dueAt ?? "");
      if (!Number.isFinite(due) || dayStamp(due) <= dayStamp(now)) add("coming", title, dueWords(card, now));
    } else if (group === "tomorrow") add("tomorrow", title, dueWords(card, now, false));
    else add("building", title, dueWords(card, now));
  }
  // A card waiting on you reads by its PR's title when the board has it.
  for (const need of needs) {
    const fromPr = need.pr !== undefined ? prTitle.get(`${repoName(need.repo ?? NO_REPO)}#${need.pr}`) : undefined;
    add("waiting", cut(plain(fromPr ?? need.title), TITLE_MAX), "");
  }
  return SUMMARY_GROUPS.filter((group) => groups[group].length).map((group) => [SUMMARY_TITLES[group], ...groups[group]].join("\n"));
}

/** The text Copy summary copies. A project with nothing is left off. */
export function copySummaryText(cards: readonly KanbanCard[], needs: readonly Need[], now: number): string {
  const prTitle = new Map(cards.flatMap((card) => card.ticket.prs.map((pr) => [`${repoName(pr.repo ?? card.repo)}#${pr.number}`, pr.title] as const)));
  const unique = [...new Map(needs.map((one) => [one.id, one])).values()];
  const repoOf = (need: Need) => need.repo ?? NO_REPO;
  const repos = [...new Set([...cards.map((card) => card.repo), ...unique.map(repoOf)])].sort((a, b) => projectName(a).localeCompare(projectName(b)));
  const projects = repos.flatMap((repo) => {
    const body = projectGroups(
      cards.filter((card) => card.repo === repo),
      unique.filter((need) => repoOf(need) === repo),
      prTitle,
      now,
    );
    return body.length ? [[projectName(repo), ...body].join("\n\n")] : [];
  });
  return [`Update, ${dayClock(now)}`, ...(projects.length ? projects : ["Nothing new right now."])].join("\n\n");
}
