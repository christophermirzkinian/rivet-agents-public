import { z } from "zod";

import type { AskStage } from "./asks.js";
import { ID_PATTERN, isRealTime } from "./board.js";
import type { ChatMessage } from "./command.js";
import { APP_NAME, RIVET_NAME } from "./names.js";
import { IN_HAND, NEEDS_YOU } from "./words.js";

// Chat threads: every message you send starts one, and what answers it (a reply-to chain) stacks under it. A chat
// window's later members join its lead's thread. A message that answers nothing known starts its own. Rivet sets a
// thread's status, project, title and timeline steps (PATCH /api/threads/:id, `rivet thread set`); what can be
// worked out (the ask it is linked to, a merged PR, a card answer) is, on read.

export const THREAD_STATUSES = ["working", "needs-you", "shipped", "parked"] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];
// `shipped` stays the stored and wire value Rivet sets; you read it as Done.
export const THREAD_STATUS_LABELS: Record<ThreadStatus, string> = { working: IN_HAND.building, "needs-you": NEEDS_YOU, shipped: "Done", parked: "Parked" };

export const THREAD_PROJECTS = ["work", "personal", "rivet"] as const;
export type ThreadProject = (typeof THREAD_PROJECTS)[number];
export const THREAD_PROJECT_LABELS: Record<ThreadProject, string> = {
  work: "Work",
  personal: "Personal",
  rivet: APP_NAME,
};
/** Personal threads stay in the app: they offer no Share. */
export const APP_ONLY_PROJECTS: ReadonlySet<ThreadProject> = new Set(["personal"]);

/** Your Move can put a thread in an app-only project but never take it out of one Rivet filed it in. */
export function appOnlyThread(thread: { project: string | null; filed?: string | null }): boolean {
  return [thread.project, thread.filed].some((project) => typeof project === "string" && APP_ONLY_PROJECTS.has(project as ThreadProject));
}
/** The Threads view's top-level folders, in the order you read them; threads with no project are Unsorted. */
export const FOLDER_PROJECTS: readonly ThreadProject[] = ["work", "personal", "rivet"];
export const UNSORTED_LABEL = "Unsorted";

/** The status chips: each thread falls under one of them besides All. Done holds the closed (parked) ones too. */
export const STATUS_FILTERS = ["all", "needs-you", "working", "done", "idle"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];
export const STATUS_FILTER_LABELS: Record<StatusFilter, string> = { all: "All", "needs-you": NEEDS_YOU, working: IN_HAND.building, done: "Done", idle: "Idle" };

/**
 * Where a thread's status came from: an unanswered card on its PRs or chat, the linked ask, Rivet's question (its
 * last message), a live chat, an open PR, a shipped or merged PR, or Rivet's set status.
 */
export const STATUS_SOURCES = ["card", "ask", "question", "chat", "pr", "shipped", "merged", "set"] as const;
export type StatusSource = (typeof STATUS_SOURCES)[number];

/** The timeline's stages, in order; every step is one of them. */
export const STEP_KINDS = ["ask", "chat", "pr", "ok", "shipped"] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export const STEP_LABELS: Record<StepKind, string> = { ask: "Ask", chat: "Chat", pr: "PR", ok: NEEDS_YOU, shipped: "Deployed" };

export const MAX_THREAD_TITLE = 120;
export const MAX_STEP_LABEL = 200;
export const MAX_THREAD_STEPS = 50;
/** The most messages GET /api/threads/:id answers with, newest kept. */
export const THREAD_MESSAGES_MAX = 300;
export const THREADS_PAGE_MAX = 300;
/** Threads and Open show only threads active within a window: the last 24 hours or 7 days. All keeps every message. */
export const THREAD_WINDOWS = ["day", "week"] as const;
export type ThreadWindow = (typeof THREAD_WINDOWS)[number];
export const THREAD_WINDOW_MS: Record<ThreadWindow, number> = { day: 86_400_000, week: 7 * 86_400_000 };
/** A question of Rivet's left unanswered this long has gone quiet: it no longer puts the thread on Needs you. */
export const QUESTION_MAX_AGE_MS = 3 * 86_400_000;
export const THREAD_WINDOW_LABELS: Record<ThreadWindow, string> = { day: "Today", week: "This week" };
export const MAX_THREAD_TAG = 32;
/** The AI titler's titles are shorter than Rivet's. */
export const MAX_AI_TITLE = 60;
/** What the untitled list carries of each message it hands the titler. */
export const AI_TEXT_CLIP = 400;
export const AI_RECENT_MESSAGES = 6;
export const AI_UNTITLED_MAX = 20;

// C0, DEL, C1 and the bidi overrides.
const LINE = /^[^\x00-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]+$/;
const httpsUrl = z
  .string()
  .max(2000)
  .url()
  .refine((url) => url.startsWith("https://"), "links are https");

export const threadStepSchema = z
  .object({
    kind: z.enum(STEP_KINDS),
    // Trimmed, so the same step sent twice is skipped; an offset time is kept as the UTC instant it names, so steps sort.
    label: z
      .string()
      .min(1)
      .max(MAX_STEP_LABEL)
      .regex(LINE, "a label is one line")
      .refine((text) => text.trim() !== "", "a label must not be blank")
      .transform((text) => text.trim()),
    url: httpsUrl.optional(),
    at: z
      .string()
      .datetime({ offset: true })
      .refine(isRealTime, "a time with an offset within ±14:00")
      .transform((at) => new Date(at).toISOString())
      .optional(),
  })
  .strict();

const tagSchema = z
  .string()
  .min(1)
  .max(MAX_THREAD_TAG)
  .regex(LINE, "a tag is one line")
  .refine((text) => text.trim() !== "", "a tag must not be blank")
  .transform((text) => text.trim());

/** PATCH /api/threads/:id. A null clears a field; `steps` are added (one already there is skipped); `clearSteps` drops Rivet's steps first. */
export const threadPatchSchema = z
  .object({
    title: z
      .string()
      .min(1)
      .max(MAX_THREAD_TITLE)
      .regex(LINE, "a title is one line")
      .refine((text) => text.trim() !== "", "a title must not be blank")
      .nullable()
      .optional(),
    status: z.enum(THREAD_STATUSES).nullable().optional(),
    project: z.enum(THREAD_PROJECTS).nullable().optional(),
    tag: tagSchema.nullable().optional(),
    steps: z.array(threadStepSchema).max(MAX_THREAD_STEPS).optional(),
    clearSteps: z.boolean().optional(),
  })
  .strict();

export const threadIdSchema = z.string().regex(ID_PATTERN);

/** PATCH /api/threads/:id with your session: Move to a project's folder or Unsorted, for good; the titler never moves it again. */
export const threadMoveSchema = z
  .object({
    project: z.enum(THREAD_PROJECTS).nullable(),
  })
  .strict();

export type ThreadMove = z.infer<typeof threadMoveSchema>;

/**
 * POST /api/bridge/threads/:id/ai: the titler's answer, once per thread. All null marks a thread it gave up on. Its
 * title shows only while Rivet has set none; its tag and project only fill what nothing else gave, and its project
 * never reaches a message.
 */
export const threadAiSchema = z
  .object({
    title: z
      .string()
      .min(1)
      .max(MAX_AI_TITLE)
      .regex(LINE, "a title is one line")
      .refine((text) => text.trim() !== "", "a title must not be blank")
      .transform((text) => text.trim())
      .nullable(),
    tag: tagSchema.nullable(),
    project: z.enum(THREAD_PROJECTS).nullable(),
  })
  .strict();

export type ThreadAi = z.infer<typeof threadAiSchema>;

/** GET /api/bridge/threads/untitled: a thread the titler has not run on, with what it reads to title it. */
export interface UntitledThread {
  id: string;
  project: ThreadProject | null;
  /** The first message, then up to AI_RECENT_MESSAGES of the newest, each clipped to AI_TEXT_CLIP. */
  messages: { from: ChatMessage["from"]; text: string }[];
}

export type ThreadPatch = z.infer<typeof threadPatchSchema>;

export interface ThreadStep {
  kind: StepKind;
  label: string;
  url?: string;
  at: string;
  /** Worked out by the server (the first message, a linked ask, a merged PR, a card answer), not set by Rivet. */
  auto?: boolean;
  /** A chat message in the thread this step points at (the ask). */
  messageId?: string;
}

export interface ThreadSummary {
  /** The id of the thread's first message. */
  id: string;
  title: string;
  /** Null: nothing is open on it and it has gone quiet, or Rivet only posted a note (Idle). */
  status: ThreadStatus | null;
  /** Where the status came from (STATUS_SOURCES); statusText says it in words. */
  statusFrom: StatusSource | null;
  /** The PR the status names: the open one, the merged one, or the card's. */
  statusPr?: number;
  /** The live chat a Working status names. */
  statusChat?: string;
  /** The unanswered card a Needs you status names: the thread's Your OK opens it. */
  statusCard?: string;
  project: ThreadProject | null;
  /** Where Rivet filed it (the monitor's, else the ask's, else the AI titler's), whatever your Move says. */
  filed?: ThreadProject;
  /** The app, repo or project it is about, in a few words: Rivet's, else the AI titler's. */
  tag: string | null;
  /** Who has the ball: you on Needs you, Rivet on Working. */
  ball: "owner" | "rivet" | null;
  startedBy: ChatMessage["from"];
  count: number;
  lastAt: string;
  lastFrom: ChatMessage["from"];
  lastText: string;
  /** The linked ask's id, if one threads on a message here. */
  ask?: string;
}

export interface FolderCount {
  /** Threads in the window under the chosen status chip. */
  count: number;
  /** Threads in the window whose ball is your, whatever the chip. */
  needsYou: number;
}

export interface ThreadFolders {
  all: FolderCount;
  projects: Record<ThreadProject | "none", FolderCount>;
}

export interface ThreadsResponse {
  threads: ThreadSummary[];
  /** Open threads (Working or Needs you) per project, and `all`. */
  open: Record<ThreadProject | "all" | "none", number>;
  /** Every folder's count in the window, under the chosen status chip. */
  folders: ThreadFolders;
  /** Each status chip's count in the window and the chosen folder. */
  statuses: Record<StatusFilter, number>;
  /** Every thread in an app-only project, whatever its age or page: the client hides Share in them all. */
  appOnly: string[];
  /** Pass as `before` for the next page; absent on the last. */
  next?: string;
}

const countsOf = <K extends string>(keys: readonly K[], value: z.ZodTypeAny) => z.object(Object.fromEntries(keys.map((key) => [key, value])) as Record<K, z.ZodTypeAny>);
const folderCountSchema = z.object({ count: z.number(), needsYou: z.number() });

/**
 * Every part of a thread list the web reads: only a list that parses may lift a Share restriction, so a short or
 * broken one never says an app-only thread is shareable. The server's own list must parse (tested).
 */
export const threadListSchema = z.object({
  threads: z.array(z.object({ id: z.string(), project: z.string().nullable(), filed: z.string().nullable().optional() }).passthrough()),
  appOnly: z.array(z.string()),
  open: countsOf([...THREAD_PROJECTS, "all", "none"], z.number()),
  folders: z.object({ all: folderCountSchema, projects: countsOf([...THREAD_PROJECTS, "none"], folderCountSchema) }),
  statuses: countsOf(STATUS_FILTERS, z.number()),
});

export interface ThreadDetail extends ThreadSummary {
  steps: ThreadStep[];
  /** Oldest first; the newest THREAD_MESSAGES_MAX. */
  messages: ChatMessage[];
  /** True when older messages were left out. */
  more: boolean;
}

/** An open card's thread, and which of that thread's card rounds it is: 1 for the first card you see in it. */
export interface CardThread {
  card: string;
  thread: string;
  title: string;
  round: number;
}

/** GET /api/card-threads: each open card that belongs to a thread. */
export interface CardThreadsResponse {
  cards: CardThread[];
}

/** The `thread` event on the chat stream: a thread's status, project, title or steps changed. */
export interface ThreadEvent {
  id: string;
  project: ThreadProject | null;
  /** True while anything (Rivet, the ask, the titler) puts it in an app-only project, wherever it was moved. */
  appOnly: boolean;
}

/** The first line of a message, trimmed to fit; an empty one says what it carried. */
export function threadTitle(text: string, carried: { images?: number; files?: number } = {}): string {
  const line = text.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "";
  if (!line) return carried.images ? (carried.images > 1 ? "Photos" : "Photo") : carried.files ? "Document" : "Message";
  return line.length > MAX_THREAD_TITLE ? `${line.slice(0, MAX_THREAD_TITLE - 1).trimEnd()}…` : line;
}

/** The ask's stage as a thread status. */
export function askThreadStatus(stage: AskStage): ThreadStatus {
  return stage === "needs-you" ? "needs-you" : stage === "shipped" ? "shipped" : stage === "parked" ? "parked" : "working";
}

export function isOpen(status: ThreadStatus | null): boolean {
  return status === "working" || status === "needs-you";
}

export function ballOf(status: ThreadStatus | null): ThreadSummary["ball"] {
  return status === "needs-you" ? "owner" : status === "working" ? "rivet" : null;
}

/** What is true of a thread now, read from the ask, the board, the bridge's chats and GitHub. */
export interface StatusFacts {
  set?: { status: ThreadStatus; at: string } | null;
  ask?: { status: ThreadStatus; at: string } | null;
  lastOwnerAt: string | null;
  /** A card on the board for one of its PRs or its chat that you have not answered. */
  card?: { id?: string; pr?: number } | null;
  /** When Rivet's last message, a question, was sent: the thread's last message ends with "?". */
  question?: string | null;
  /** A chat on it that is open now. */
  chat?: string | null;
  /** One of its PRs that GitHub lists as open. */
  openPr?: number | null;
  /** Its newest merged PR. */
  merged?: { pr: number; at: string } | null;
  /** When the ask or a step last said it shipped. */
  shippedAt?: string | null;
}

export interface StatusResult {
  status: ThreadStatus | null;
  from: StatusSource | null;
  pr?: number;
  chat?: string;
  card?: string;
}

/**
 * A thread's status from real state, the first that holds. Needs you: an unanswered card, the ask or Rivet waiting on
 * You, or Rivet's question as the last word. Working: an open chat or an open PR. Done: shipped or merged, unless you
 * or Rivet's status spoke after. Then the newer of Rivet's set status and the ask's, unless you wrote after it;
 * Working only from an open ask. Otherwise Idle (null): you writing lately or Rivet's set Working is no link.
 */
export function threadStatus(input: StatusFacts): StatusResult {
  const { set, ask, lastOwnerAt } = input;
  const after = (at: string) => lastOwnerAt !== null && lastOwnerAt > at;
  if (input.card)
    return {
      status: "needs-you",
      from: "card",
      ...(input.card.pr !== undefined ? { pr: input.card.pr } : {}),
      ...(input.card.id !== undefined ? { card: input.card.id } : {}),
    };
  if (ask?.status === "needs-you" && !after(ask.at) && !(set && set.at > ask.at)) return { status: "needs-you", from: "ask" };
  if (set?.status === "needs-you" && !after(set.at) && !(ask && ask.at > set.at)) return { status: "needs-you", from: "set" };
  if (input.question && !after(input.question)) return { status: "needs-you", from: "question" };
  if (input.chat) return { status: "working", from: "chat", chat: input.chat };
  if (input.openPr != null) return { status: "working", from: "pr", pr: input.openPr };
  const deployed = input.shippedAt ?? null;
  const merged = input.merged ?? null;
  if (deployed || merged) {
    const doneAt = [deployed, merged?.at].filter((at): at is string => !!at).sort().at(-1)!;
    // A shipped mark older than the newest merge is an earlier PR's deploy, not this one's.
    const shipped = deployed !== null && (merged === null || deployed >= merged.at);
    if (!after(doneAt) && !(set && set.at > doneAt)) return { status: "shipped", from: shipped ? "shipped" : "merged", ...(merged ? { pr: merged.pr } : {}) };
  }
  const chosen = set && ask ? (ask.at > set.at ? { ...ask, from: "ask" as const } : { ...set, from: "set" as const }) : set ? { ...set, from: "set" as const } : ask ? { ...ask, from: "ask" as const } : null;
  if (chosen && chosen.status !== "working" && !after(chosen.at)) return { status: chosen.status, from: chosen.from };
  if (ask?.status === "working") return { status: "working", from: "ask" };
  return { status: null, from: null };
}

/** The status and where it came from, in words: "Working, PR #123 open". */
export function statusText(thread: Pick<ThreadSummary, "status" | "statusFrom" | "statusPr" | "statusChat">): string {
  const { status } = thread;
  if (status === null) return "Idle, nothing open on it";
  const label = THREAD_STATUS_LABELS[status];
  const pr = thread.statusPr !== undefined ? `PR #${thread.statusPr}` : null;
  switch (thread.statusFrom) {
    case "card":
      return `${label}, ${pr ? `a card on ${pr}` : "a card"} waits for you`;
    case "ask":
      return `${label}, ${status === "needs-you" ? "the ask waits for you" : status === "shipped" ? "the ask is deployed" : status === "parked" ? "the ask is parked" : "the ask is open"}`;
    case "question":
      return `${label}, ${RIVET_NAME} asked you`;
    case "chat":
      return thread.statusChat ? `${label}, chat ${thread.statusChat} is open` : `${label}, a chat is open`;
    case "pr":
      return `${label}, ${pr ?? "a PR"} open`;
    case "shipped":
      return pr ? `${label}, ${pr} merged and deployed` : `${label}, deployed`;
    case "merged":
      return `${label}, ${pr ?? "its PR"} merged`;
    case "set":
      return `${label}, set by ${RIVET_NAME}`;
    default:
      return label;
  }
}

/** The chip a status falls under. */
export function statusGroup(status: ThreadStatus | null): Exclude<StatusFilter, "all"> {
  return status === "needs-you" ? "needs-you" : status === "working" ? "working" : status === "shipped" || status === "parked" ? "done" : "idle";
}

export function statusCounts(threads: readonly Pick<ThreadSummary, "status">[]): Record<StatusFilter, number> {
  const counts: Record<StatusFilter, number> = { all: threads.length, "needs-you": 0, working: 0, done: 0, idle: 0 };
  for (const thread of threads) counts[statusGroup(thread.status)]++;
  return counts;
}

/** One Rivet message nobody answered with nothing open or done on it: Today and This week leave it out; Chat keeps it. */
export function loneNotice(thread: Pick<ThreadSummary, "startedBy" | "count" | "status">): boolean {
  return thread.startedBy === "rivet" && thread.count === 1 && thread.status === null;
}

/** Whether a thread is in a folder: a project (none is Unsorted), or null for every one. */
export function inFolder(thread: Pick<ThreadSummary, "project">, project: ThreadProject | "none" | null): boolean {
  return project === null || (thread.project ?? "none") === project;
}

/** Every folder's count under the `status` chip, and its Needs-you count whatever the chip. */
export function threadFolders(threads: readonly ThreadSummary[], status: StatusFilter): ThreadFolders {
  const zero = (): FolderCount => ({ count: 0, needsYou: 0 });
  const folders: ThreadFolders = {
    all: zero(),
    projects: Object.fromEntries([...THREAD_PROJECTS, "none"].map((project) => [project, zero()])) as ThreadFolders["projects"],
  };
  for (const thread of threads) {
    const counted = status === "all" || statusGroup(thread.status) === status ? 1 : 0;
    const yours = thread.ball === "owner" ? 1 : 0;
    for (const folder of [folders.all, folders.projects[thread.project ?? "none"]]) {
      folder.count += counted;
      folder.needsYou += yours;
    }
  }
  return folders;
}

/** The PR number a step names: `#123` in its label or `/pull/123` in its link. */
export function stepPr(step: Pick<ThreadStep, "label" | "url">): number | null {
  const match = /\/pull\/(\d{1,9})\b/.exec(step.url ?? "") ?? /#(\d{1,9})\b/.exec(step.label);
  return match ? Number(match[1]) : null;
}

/** A PR a text names; `repo` (lower case) only when the text gives one. */
export interface PrRef {
  repo: string | null;
  number: number;
}

/** The PRs a text names: `#123` (any repo), `owner/repo#123` or an `owner/repo/pull/123` link; an HTML `&#39;` is none. */
export function namedPrs(text: string): PrRef[] {
  const refs = new Map<string, PrRef>();
  for (const match of text.matchAll(/([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d{1,9})\b/g)) refs.set(`${match[1]!.toLowerCase()}#${match[2]}`, { repo: match[1]!.toLowerCase(), number: Number(match[2]) });
  for (const match of text.matchAll(/(?<![\w&./-])#(\d{2,9})\b/g)) refs.set(`#${match[1]}`, { repo: null, number: Number(match[1]) });
  return [...refs.values()];
}

/** Whether a named PR is that PR: the same number, and the same repo when the text gave one. */
export function namesPr(ref: PrRef, pr: { repo: string; number: number }): boolean {
  return ref.number === pr.number && (ref.repo === null || ref.repo === pr.repo.toLowerCase());
}

/** The words a text is made of, lower case, split on spaces, commas and brackets with outer punctuation and a possessive off: ids match whole. */
export function textWords(text: string): Set<string> {
  const words = text.toLowerCase().split(/[\s,;()[\]{}<>"`|*]+/).map((word) => word.replace(/^[^\w]+|[^\w]+$/g, "").replace(/['’]s$/, ""));
  return new Set(words.filter(Boolean));
}

/** An id worth matching as a word: a plain word (no digit or hyphen) would match ordinary prose. */
export function idLike(id: string): boolean {
  return /[\d-]/.test(id);
}

/** What a thread's messages name: PRs (namedPrs) and words (textWords), as parsed from the messages themselves. */
export interface Mentions {
  refs: PrRef[];
  words: ReadonlySet<string>;
}

/** What one text names. */
export function textMentions(text: string): Mentions {
  return { refs: namedPrs(text), words: textWords(text) };
}
