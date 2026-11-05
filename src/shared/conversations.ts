import { z } from "zod";

import { ID_PATTERN } from "./board.js";
import type { ChatMessage } from "./command.js";
import { MAX_THREAD_TITLE, type ThreadDetail } from "./threads.js";
import { RIVET_NAME } from "./names.js";
import { NEEDS_YOU } from "./words.js";

// Conversations: the Chat tab is a list of them. A conversation is a thread (src/shared/threads.ts) under a
// new name, keyed by its first message's id, so every message already carries its conversation in `threadId`. What
// is new: your rename, Close and read marker per conversation, one pinned Updates conversation for whatever Rivet
// says about nothing in particular, and a cutover: the list holds conversations with a message after it, so it opens
// as a blank slate and everything older stays under "Archived".

/** The Updates conversation's root message id: server-owned, never closed. */
export const UPDATES_ID = "updates";
export const UPDATES_TITLE = "Updates";
export const UPDATES_ROOT_TEXT = `Updates from ${RIVET_NAME}`;

/**
 * Retention: a conversation closed or done, not pinned and quiet this long is
 * deleted whole. The default is 180 days; null keeps every conversation.
 */
export const CONVERSATION_KEEP_MS: number | null = 180 * 24 * 60 * 60_000;
/** A finished action's audit row is deleted this long after it, once its chat message is gone. */
export const AUDIT_KEEP_MS = 365 * 24 * 60 * 60_000;
/** Roughly the most rows one retention sweep deletes; a conversation is never split. */
export const RETENTION_BATCH = 500;
/** How much of one agent message the room keeps. */
export const TEAM_TEXT_MAX = 600;
/** A cap on agent messages an hour, so a looping chat cannot flood the room. */
export const TEAM_PER_HOUR = 600;

/** POST /api/team/message with the board token: one agent message, already redacted on the Mac. */
export const teamMessageSchema = z
  .object({
    /** Its id on the Mac (the tool call's), so a retry adds it once. */
    id: z.string().regex(ID_PATTERN).max(90),
    from: z.string().regex(ID_PATTERN),
    to: z.string().regex(ID_PATTERN),
    /** Cut to TEAM_TEXT_MAX by the server. */
    text: z.string().trim().min(1).max(TEAM_TEXT_MAX * 4),
  })
  .strict();

export type TeamMessage = z.infer<typeof teamMessageSchema>;

/**
 * The Team room, titled Agent Chat: the agents' messages to each other as they happen, posted from the Mac by the repo's
 * team-room hook (POST /api/team/message). Always listed, even before its first message; never closed, unread, pushed or
 * read aloud. Kept TEAM_ROOM_KEEP_MS.
 */
export const TEAM_ROOM_ID = "team-room";
export const TEAM_ROOM_TITLE = "Agent Chat";
export const TEAM_ROOM_ROOT_TEXT = "The agents talking to each other";
export const TEAM_ROOM_KEEP_MS = 7 * 24 * 60 * 60_000;

/** A conversation Rivet writes on its own: it owns no card, and nothing it names routes a note into it. */
export function ownsNoCard(id: string): boolean {
  return id === UPDATES_ID || id === TEAM_ROOM_ID;
}

/** The server-owned conversations' root messages: each is a heading, never a message, unread or a bubble. */
export const SEED_IDS: readonly string[] = [UPDATES_ID, TEAM_ROOM_ID];

/** The `meta` key holding when the list started (ISO), written once. */
export const CUTOVER_KEY = "conversations.cutover";

export const CONVERSATIONS_PAGE_MAX = 100;
/** A conversation with no message for longer than this is archived: off the list, under Archived. */
export const IDLE_ARCHIVE_MS = 2 * 60 * 60_000;
/** At most this many PRs and chats each a row names; the app shows three chips in all. */
export const CONVERSATION_LINKS_MAX = 3;

export interface ConversationLinks {
  /** PRs it is about, as "#3412" or "repo#88" for another repo's. */
  prs: string[];
  chats: string[];
  /**
   * The same chats with the repo each was linked in; none for a chat it only names in words or by its status. A chat
   * name recurs across repos, so a lookup by chat matches its repo where both sides know one.
   */
  chatRefs?: ChatRef[];
  /** The app, repo or project it is about, in a few words. */
  tag: string | null;
}

export interface ChatRef {
  chat: string;
  repo?: string;
}

/** Whether the links name the chat: in the given repo when the link knows its repo, else by name alone. */
export function linksChat(links: Pick<ConversationLinks, "chats" | "chatRefs">, chat: string, repo?: string | null): boolean {
  const refs: readonly ChatRef[] = links.chatRefs ?? links.chats.map((name) => ({ chat: name }));
  return refs.some((ref) => ref.chat === chat && (!repo || !ref.repo || ref.repo.toLowerCase() === repo.toLowerCase()));
}

/**
 * Where a conversation's PRs stand, as GitHub's own colours show them: open (green), merged (purple), closed unmerged
 * (red), draft (grey); none when it links no PR GitHub has told us about (grey, just a conversation).
 */
export const CONVERSATION_STAGES = ["open", "draft", "merged", "closed", "none"] as const;
export type ConversationStage = (typeof CONVERSATION_STAGES)[number];

/**
 * Where the work a conversation is about stands, in words on its row: your ball first, then deployed, merged, building; none when nothing is under way.
 */
export const CONVERSATION_PHASES = ["waiting", "building", "merged", "deployed"] as const;
export type ConversationPhase = (typeof CONVERSATION_PHASES)[number];
export const PHASE_LABELS: Record<ConversationPhase, string> = {
  waiting: NEEDS_YOU,
  building: "Building",
  merged: "Merged",
  deployed: "Deployed",
};

export interface ConversationSummary {
  /** The id of its first message. */
  id: string;
  title: string;
  lastAt: string;
  lastFrom: ChatMessage["from"];
  /** The newest message's first line; "Photo" or "Video" when it has no text. */
  lastText: string;
  /** Rivet's messages since you last read it (and since the cutover). */
  unread: number;
  /** You have the ball: an unanswered card, an open ask, or Rivet's question is the last word. */
  needsYou: boolean;
  links: ConversationLinks;
  /** Closed and quiet since, or idle IDLE_ARCHIVE_MS: it shows under "Archived". */
  closed: boolean;
  /** The pinned Updates conversation. */
  updates: boolean;
  /** Its project is app-only (Personal): it offers no Share. */
  appOnly: boolean;
  /** You marked it unread: a dot until you read it. */
  markedUnread: boolean;
  /** You pinned it: it sits at the top, in its own group. */
  pinned: boolean;
  /** Rivet marked it done (`rivet conversation done`), and you have not written since: a green tick. */
  done: boolean;
  /** Its PRs' stage: any open wins, then draft, merged, closed. */
  stage: ConversationStage;
  /** The PR that decided the stage, as its chip names it. */
  stagePr?: string;
  /** Where its work stands, for the row's status pill; null when nothing is under way. */
  phase: ConversationPhase | null;
  /** A card is filed in it: it is a thing, with a page of its own, and not part of Chat. */
  thing: boolean;
}

/** GET /api/conversations: the open list, or with `older=1` a page of "Archived". */
export interface ConversationsResponse {
  conversations: ConversationSummary[];
  /** How many conversations are under "Archived". */
  older: number;
  /** The Chat tab's badge (chatBadge). */
  unread: number;
  /** The cursor of the next page (`before`), when there is one. */
  next?: string;
}

/** GET /api/conversations/:id: the thread detail, plus what the list knows of it. */
export interface ConversationDetail extends ThreadDetail {
  conversation: ConversationSummary;
}

/** GET /api/conversations/:id?before=<message id>: up to THREAD_MESSAGES_MAX of its messages older than that one, oldest first. */
export interface ConversationPage {
  messages: ChatMessage[];
  /** Older ones were left out. */
  more: boolean;
}

/**
 * PATCH /api/conversations/:id with your session: rename (null goes back to Rivet's or the titler's title), close
 * or reopen, mark read up to a message of it (true: its newest; it also clears a marked unread), mark it unread (or
 * clear that), and pin or unpin; pinning or marking unread reopens it.
 */
export const conversationPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_THREAD_TITLE).nullable().optional(),
    closed: z.boolean().optional(),
    read: z.union([z.literal(true), z.string().regex(ID_PATTERN)]).optional(),
    unread: z.boolean().optional(),
    pinned: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((one) => one !== undefined), "change something")
  .refine((value) => !(value.read !== undefined && value.unread === true), "read and unread together")
  // Pinning or marking unread reopens a closed conversation; closing puts both away.
  .refine((value) => !(value.closed === true && (value.unread === true || value.pinned === true)), "close and pin or unread together");

export type ConversationPatch = z.infer<typeof conversationPatchSchema>;

/** PATCH /api/conversations/:id with the board token: Rivet marks it done, or not. Nothing else. */
export const conversationDoneSchema = z.object({ done: z.boolean() }).strict();

/**
 * POST /api/conversations/:id/merge, your session or the board token: every message, card and step of `:id` moves
 * into `into`, which keeps its id, title and settings. Never Updates, never one into
 * itself, and never across app-only and shareable (409). Merging one already merged into `into` changes nothing.
 */
export const conversationMergeSchema = z.object({ into: z.string().regex(ID_PATTERN) }).strict();

export interface MergeResponse {
  /** How many messages moved; 0 when it was already merged. */
  moved: number;
  /** The conversation it now is, as GET /api/conversations/:id answers. */
  conversation: ConversationDetail;
}

/**
 * POST /api/conversations/split, your session or the board token (2026-10-20): every line typed with no Reply inside a
 * conversation it did not start, moves out with what chains to it into a new
 * conversation named by its id; `conversation` limits it to one. `dryRun` answers the same and changes nothing. Run
 * again it moves nothing.
 */
export const conversationSplitSchema = z.object({ conversation: z.string().regex(ID_PATTERN).optional(), dryRun: z.boolean().optional() }).strict();

export interface SplitResponse {
  dryRun: boolean;
  /** One per new conversation: its root message's id, the conversation it leaves, its title, and what moves with it. */
  conversations: { id: string; from: string; title: string; messages: number; cards: number }[];
  messages: number;
  cards: number;
}

/** What Select mode does to the conversations ticked: Close or Reopen them, mark them read or unread. */
export const CONVERSATION_ACTIONS = ["read", "unread", "close", "reopen"] as const;
export type ConversationAction = (typeof CONVERSATION_ACTIONS)[number];

/** POST /api/conversations/batch with your session: one action on up to CONVERSATIONS_PAGE_MAX conversations. */
export const conversationBatchSchema = z
  .object({
    ids: z.array(z.string().regex(ID_PATTERN)).min(1).max(CONVERSATIONS_PAGE_MAX),
    action: z.enum(CONVERSATION_ACTIONS),
  })
  .strict();

export interface BatchResponse {
  /** How many conversations it changed (Updates is never closed; one already so is left). */
  changed: number;
}

/** POST /api/conversations/read with your session: marks every listed conversation read. */
export interface ReadAllResponse {
  /** How many conversations it marked read. */
  read: number;
}

/** The `conversation` event on the chat stream: a conversation's title, closed or read state changed. */
export interface ConversationEvent {
  id: string;
}

/** Counts toward the Chat tab's badge: anything unread, or marked unread. */
export function countsUnread(summary: Pick<ConversationSummary, "unread" | "markedUnread">): boolean {
  return summary.unread > 0 || summary.markedUnread;
}

/** The Chat tab's badge: 1 while Rivet has replied in Chat, plus each thing with a reply you have not read. */
export function chatBadge(rows: readonly Pick<ConversationSummary, "unread" | "markedUnread" | "thing">[]): number {
  const unread = rows.filter(countsUnread);
  return (unread.some((row) => !row.thing) ? 1 : 0) + unread.filter((row) => row.thing).length;
}

/** What a card answer says in its conversation, as your message. */
export function answerText(reply: { decision: string; choice?: string; text?: string; itemTitle: string }): string {
  const note = reply.text?.trim();
  if (reply.decision === "comment") return note ? `Comment: ${note}` : "Comment";
  const said =
    reply.decision === "approve"
      ? `Approved: ${reply.itemTitle}`
      : reply.decision === "choice"
        ? `Chose: ${reply.choice ?? ""}`
        : reply.decision === "reject"
          ? "Rejected: fix and resubmit"
          : reply.decision === "seen"
            ? "Seen"
            : reply.decision === "dismiss"
              ? "Dismissed"
              : "Done";
  return note ? `${said}\n${note}` : said;
}
