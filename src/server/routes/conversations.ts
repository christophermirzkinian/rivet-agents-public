import { randomUUID } from "node:crypto";

import { chatImages, type ChatMessage, type PostedCard } from "../../shared/command.js";
import {
  answerText,
  CONVERSATIONS_PAGE_MAX,
  conversationBatchSchema,
  conversationDoneSchema,
  conversationMergeSchema,
  conversationPatchSchema,
  conversationSplitSchema,
  chatBadge,
  countsUnread,
  ownsNoCard,
  TEAM_ROOM_ID,
  UPDATES_ID,
  type BatchResponse,
  type ConversationDetail,
  type ConversationEvent,
  type ConversationPatch,
  type ConversationPage,
  type ConversationsResponse,
  type ConversationStage,
  type ConversationSummary,
  type MergeResponse,
  type ReadAllResponse,
  type SplitResponse,
} from "../../shared/conversations.js";
import { bareGotIt, DECISION, isGotIt, UPDATE } from "../../shared/answers.js";
import { ID_PATTERN, type Need, type Reply } from "../../shared/board.js";
import { NO_REPO } from "../../shared/board.js";
import { type CommandStore } from "../commandstore.js";
import { rivetPayload } from "../push.js";
import { cardKey, conversationSummary, idle, isClosed, linkedPrs, listOrder, MIXED_CHATS, prStageKey, uniquePrs, waitsOnYou } from "../conversations.js";
import { decodeSegment, hasBearer, HttpError, json, readJson, requireSameOrigin } from "../httputil.js";
import { APP_ONLY_PROJECTS, MAX_THREAD_TITLE, THREAD_MESSAGES_MAX, type ThreadProject } from "../../shared/threads.js";
import { type CardItem } from "../threads.js";
import type { Router } from "./router.js";
import type { ThreadsApi } from "./threads.js";

// Conversations (src/shared/conversations.ts): the list your Chat tab shows, one conversation, and your
// rename, Close, read marker, marked unread and pin, one at a time or ticked in Select mode. Read with his session or
// the board token; changed with his session, except Rivet's done (the board token, `rivet conversation done`). A
// conversation idle over two hours is under Archived as the list is read (nothing written). A change goes out on the
// chat stream as a `conversation` event. Card answers land here as his messages.

const PREFIX = "/api/conversations/";
const PATCH_BODY_MAX = 4 * 1024;
const CARD_PREFIX = "/api/card-conversations/";
/** How much of a card's ask its inline bubble keeps. */
const POSTED_ASK_MAX = 200;
const BATCH_BODY_MAX = 16 * 1024;

/** How often the bridge's PR stages are recorded: well inside the 14 days a merge or close stays in its readings. */
const STAGE_RECORD_MS = 60 * 60_000;

export function registerConversations(
  router: Router,
  commands: CommandStore,
  threads: ThreadsApi,
  out: { broadcast: (message: ChatMessage) => void; announce: (event: ConversationEvent) => void },
): void {
  const { config, store, requireSession, now, logger, push } = router.deps;

  /** Every conversation as a row, with the order it arrived in, the open ones and the rest. Reads never write. */
  function rows(opened?: string): { open: { summary: ConversationSummary; seq: number }[]; older: { summary: ConversationSummary; seq: number }[] } {
    const at = now().toISOString();
    const cutover = commands.cutover(at);
    commands.ensureUpdates(at);
    // Agent Chat is always listed, so it is there before any agent writes in it. Best effort: a failed seed never fails
    // the read, or a change already made that answers with the list.
    try {
      commands.ensureTeamRoom(at);
    } catch (error) {
      logger.error(`[conversations] Agent Chat not seeded: ${error instanceof Error ? error.message : String(error)}`);
    }
    const read = threads.summaries(opened);
    const { rows: threadRows, threads: summaries, links, waiting } = read;
    const unread = commands.unreadCounts(cutover);
    const linked = linksOf(read);
    const recorded = remember(linked);
    const stageOf = stages([...linked.values(), ...recorded.values()].flat(), at);
    const filed = commands.filedCards();
    const open: { summary: ConversationSummary; seq: number }[] = [];
    const older: { summary: ConversationSummary; seq: number }[] = [];
    for (const [index, row] of threadRows.entries()) {
      const prs = [...(linked.get(row.id) ?? []), ...(recorded.get(row.id) ?? [])];
      const summary = conversationSummary(summaries[index]!, row, links.get(row.id), unread.get(row.id) ?? 0, stageOf, prs, filed.has(row.id));
      // A conversation is listed once it has a message since the cutover, or while pinned, marked unread, reopened or
      // waiting on you, until you close it or it sits idle two hours (Archived; never while it waits on you). Updates
      // never: news is update cards, and the old conversation stays read-only under Archived.
      // Agent Chat always.
      const waits = waitsOnYou(summary, row, waiting.has(row.id));
      const listed =
        row.id === TEAM_ROOM_ID ||
        (!summary.updates &&
          (row.lastAt >= cutover || row.pinnedAt !== null || row.unreadAt !== null || (row.closedAt === null && row.sweptAt !== null) || waits) &&
          !isClosed(row) &&
          !idle({ needsYou: waits }, row, Date.parse(at)));
      // Older rows also offer Reopen when they predate the list and were never explicitly closed. Updates stays
      // read-only with its existing summary; Agent Chat is always listed. This does not write a close timestamp.
      if (!listed && !summary.updates) summary.closed = true;
      (listed ? open : older).push({ summary, seq: row.lastSeq });
    }
    return { open, older };
  }

  /**
   * The PRs each conversation (not Updates) links now. A bare `#n` is the PR with that number it linked before, else
   * the one the bridge's readings show.
   */
  function linksOf({ rows: threadRows, threads: summaries, links }: ReturnType<ThreadsApi["summaries"]>): Map<string, string[]> {
    const live = bareResolver(threads.prStages());
    const before = commands.conversationPrs();
    return new Map(
      threadRows.flatMap((row, index) => {
        if (ownsNoCard(row.id)) return [];
        const resolve = (number: number) => before.get(row.id)?.find((key) => key.endsWith(`#${number}`)) ?? live(number);
        return [[row.id, linkedPrs(summaries[index]!, links.get(row.id), resolve)] as const];
      }),
    );
  }

  /** A bare `#n`'s PR from the bridge's readings: the main repo's when it has one, else another repo's. */
  function bareResolver(live: ReadonlyMap<string, ConversationStage>): (number: number) => string | undefined {
    const byNumber = new Map<number, string[]>();
    for (const key of live.keys()) {
      const number = Number(key.slice(key.lastIndexOf("#") + 1));
      byNumber.set(number, [...(byNumber.get(number) ?? []), key]);
    }
    return (number) => {
      const keys = byNumber.get(number) ?? [];
      return keys.find((key) => key === prStageKey({ repo: null, number })) ?? keys[0];
    };
  }

  // Records what each conversation links and every stage the bridge's readings show each hour, so a PR that merges or
  // closes and leaves its 14 days while nobody opens Chat keeps both its link and its last stage.
  const recordStages = () => {
    try {
      commands.rememberConversationPrs(linksOf(threads.summaries()));
      commands.rememberPrStages(threads.prStages(), now().toISOString());
    } catch (error) {
      logger.error(`[conversations] PR stages not recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const stageTimer = setInterval(recordStages, STAGE_RECORD_MS);
  stageTimer.unref();
  router.onClose(() => clearInterval(stageTimer));

  /** Records what each conversation links now and returns everything it ever linked; only the read is lost on an error. */
  function remember(linked: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
    try {
      commands.rememberConversationPrs(linked);
    } catch (error) {
      logger.error(`[conversations] PR links not recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
    return commands.conversationPrs();
  }

  /**
   * Each PR's stage: GitHub's now, else the last one recorded. Every stage the bridge's readings show is recorded on
   * each list read, so a PR that leaves its 14 days keeps the colour it had. No GitHub call: the bridge's readings only.
   */
  function stages(prs: readonly string[], at: string): (key: string) => ConversationStage | undefined {
    const live = threads.prStages();
    try {
      commands.rememberPrStages(live, at);
    } catch (error) {
      logger.error(`[conversations] PR stages not recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
    const stored = commands.prStages([...new Set(prs.map((key) => key.toLowerCase()))].filter((key) => !live.has(key)));
    return (key) => live.get(key) ?? (stored.get(key) as ConversationStage | undefined);
  }

  // The open list (pinned ones, then newest first), or with `older=1` "Archived", newest
  // first, `limit` at a time from `before` (the `next` of the page before).
  router.on("GET", "/api/conversations", ({ request, response, url }) => {
    const rivet = hasBearer(request, config.boardTokenDigest);
    if (!rivet) requireSession(request);
    const params = url.searchParams;
    const olderPage = params.get("older") === "1";
    const limit = params.has("limit") ? Number(params.get("limit")) : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > CONVERSATIONS_PAGE_MAX) throw new HttpError(400, `limit is 1 to ${CONVERSATIONS_PAGE_MAX}`);
    const before = params.get("before");
    if (before !== null && !/^\d{1,15}$/.test(before)) throw new HttpError(400, "invalid cursor");
    const { open, older } = rows();
    const unread = chatBadge(open.map((row) => row.summary));
    if (!olderPage) {
      // The board token is the chats', and chats never read Agent Chat.
      const listed = rivet ? open.filter((row) => row.summary.id !== TEAM_ROOM_ID) : open;
      json(response, 200, { conversations: listOrder(listed), older: older.length, unread } satisfies ConversationsResponse);
      return;
    }
    const list = older.filter((row) => (before === null || row.seq < Number(before)) && !(rivet && row.summary.id === TEAM_ROOM_ID)).sort((a, b) => b.seq - a.seq);
    const page = list.slice(0, limit);
    const body: ConversationsResponse = {
      conversations: page.map((row) => row.summary),
      older: older.length,
      unread,
      ...(list.length > limit ? { next: String(page.at(-1)!.seq) } : {}),
    };
    json(response, 200, body);
  });

  function detail(id: string): ConversationDetail {
    const thread = threads.detail(id);
    const { open, older } = rows(id);
    const conversation = [...open, ...older].find((row) => row.summary.id === id)!.summary;
    return { ...thread, conversation };
  }

  // With `before` (a message of it), the page of messages older than that one.
  router.onPrefix("GET", PREFIX, ({ request, response, url }) => {
    const rivet = hasBearer(request, config.boardTokenDigest);
    if (!rivet) requireSession(request);
    const id = threads.threadFrom(url.pathname.slice(PREFIX.length));
    if (rivet && id === TEAM_ROOM_ID) throw new HttpError(404, "no such conversation");
    const before = url.searchParams.get("before");
    if (before === null) {
      json(response, 200, detail(id));
      return;
    }
    if (!ID_PATTERN.test(before)) throw new HttpError(400, "invalid cursor");
    const page = commands.threadMessagesBefore(id, before, THREAD_MESSAGES_MAX);
    if (!page) throw new HttpError(400, "before is not a message of this conversation");
    json(response, 200, page satisfies ConversationPage);
  });

  // Mark all as read: every conversation on the open list, read up to its newest message, marked unread cleared.
  router.on("POST", "/api/conversations/read", ({ request, response }) => {
    requireSameOrigin(request, config.origin);
    requireSession(request);
    const { open } = rows();
    const changed = commands.readAll(
      open.map((row) => row.summary.id),
      now().toISOString(),
    );
    for (const id of changed) out.announce({ id });
    json(response, 200, { read: changed.length } satisfies ReadAllResponse);
  });

  // Select mode: one action on every conversation ticked (any message's id names its conversation; an unknown one is
  // skipped). Updates and Agent Chat are never closed.
  router.on("POST", "/api/conversations/batch", async ({ request, response }) => {
    requireSameOrigin(request, config.origin);
    requireSession(request);
    const parsed = conversationBatchSchema.safeParse(await readJson(request, BATCH_BODY_MAX));
    if (!parsed.success) {
      json(response, 400, { error: "invalid conversation batch", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    const { ids, action } = parsed.data;
    const change: ConversationPatch = action === "read" ? { read: true } : action === "unread" ? { unread: true } : { closed: action === "close" };
    const at = now().toISOString();
    let changed = 0;
    for (const id of new Set(ids.map((one) => commands.threadOf(one)))) {
      if (id === null || ((id === UPDATES_ID || id === TEAM_ROOM_ID) && action === "close")) continue;
      if (!commands.patchConversation(id, change, at)) continue;
      changed += 1;
      out.announce({ id });
    }
    json(response, 200, { changed } satisfies BatchResponse);
  });

  router.onPrefix("PATCH", PREFIX, async ({ request, response, url }) => {
    // Rivet (the board token) marks a conversation done or not, and nothing else.
    const rivet = hasBearer(request, config.boardTokenDigest);
    if (!rivet) {
      requireSameOrigin(request, config.origin);
      requireSession(request);
    }
    const id = threads.threadFrom(url.pathname.slice(PREFIX.length));
    // A change answers with the conversation, so the board token never changes the Team room either.
    if (rivet && id === TEAM_ROOM_ID) throw new HttpError(404, "no such conversation");
    const parsed = (rivet ? conversationDoneSchema : conversationPatchSchema).safeParse(await readJson(request, PATCH_BODY_MAX));
    if (!parsed.success && rivet) throw new HttpError(403, "the board token only marks a conversation done or not");
    if (!parsed.success) {
      json(response, 400, { error: "invalid conversation change", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    if (id === UPDATES_ID && "closed" in parsed.data && parsed.data.closed) throw new HttpError(409, "Updates cannot be closed");
    if (id === UPDATES_ID && "done" in parsed.data && parsed.data.done) throw new HttpError(409, "Updates is never done");
    if (id === TEAM_ROOM_ID && "closed" in parsed.data && parsed.data.closed) throw new HttpError(409, "Agent Chat cannot be closed");
    let changed: boolean;
    try {
      changed = commands.patchConversation(id, parsed.data, now().toISOString());
    } catch (error) {
      if (error instanceof RangeError) throw new HttpError(400, error.message);
      throw error;
    }
    if (changed) out.announce({ id });
    json(response, 200, detail(id));
  });

  /**
   * A card answer becomes your message, with the reply's id, in the card's conversation: the one cardOwner picks
   * (as the card's Round line does; the card still counts as live for it), else the one an earlier answer to the card
   * is in, else a new one titled after the card and filed under its repo's project. A private repo's card (an
   * app-only project) joins only an app-only conversation, so nothing private lands where Share is offered. Rivet's
   * follow-up `--reply-to <reply id>` then lands beside it. It never pushes: you just wrote it. A retried answer
   * adds no second message, and files a conversation it started only if that step was lost (never over later edits).
   */
  function answered(reply: Reply): void {
    const existing = commands.getChatMessage(reply.id);
    let thread: string;
    if (existing) thread = existing.threadId ?? existing.id;
    else {
      const card: CardItem & { id: string } = {
        id: reply.itemId,
        ...(reply.item.repo ? { repo: reply.item.repo } : {}),
        ...(reply.item.pr !== undefined ? { pr: reply.item.pr } : {}),
        // Rivet's chat is no sign of an ask's ownership.
        ...(reply.item.chat && !MIXED_CHATS.has(reply.item.chat.toLowerCase()) ? { chat: reply.item.chat } : {}),
      };
      const { owner } = threads.summaries(undefined, card);
      const fits = (id: string | null | undefined) => (id && !ownsNoCard(id) ? id : null);
      // The conversation the card was filed in wins (2026-10-09); then as before. An answer from before conversations
      // (retried now) keeps the conversation Rivet's replies to it are in; a card filed nowhere joins one its stem,
      // PR or chat matches before it starts its own.
      thread =
        fits(commands.cardConversation(reply.itemId)?.thread) ??
        fits(owner(card)?.thread) ??
        fits(commands.cardThread(reply.itemId)) ??
        fits(commands.repliedIn(reply.id)) ??
        fits(commands.filedLike(matchOf(card))?.thread) ??
        reply.id;
      commands.addChatMessage({ id: reply.id, from: "owner", text: answerText(reply), at: reply.at, images: chatImages(reply), card: reply.itemId, cardTitle: reply.itemTitle, thread });
      if (!ownsNoCard(thread)) commands.fileCard({ card: reply.itemId, thread, via: "answer", ...keyOf(card), at: reply.at });
    }
    if (thread === reply.id && !(existing && commands.threadFiled(reply.id))) {
      commands.patchThread(reply.id, { title: reply.itemTitle.slice(0, MAX_THREAD_TITLE) }, reply.at);
    }
    if (!existing) out.broadcast(commands.getChatMessage(reply.id)!);
  }

  /** What a card is matched on when its writer names no conversation: its id's stem and PR, its PR, its chat. */
  function keyOf(card: CardItem & { id: string }): { stem: string | null; repo: string | null; pr: number | null; chat: string | null } {
    const key = cardKey(card.id);
    return { stem: key.stem, repo: card.repo ?? NO_REPO, pr: card.pr ?? key.pr, chat: card.chat && !MIXED_CHATS.has(card.chat.toLowerCase()) ? card.chat : null };
  }

  function matchOf(card: CardItem & { id: string }): { stem: string | null; repo: string; pr: number | null; chat: string | null } {
    const key = keyOf(card);
    return { ...key, repo: key.repo ?? NO_REPO };
  }

  /**
   * The conversation a new card belongs in: the message or card its writer names (`replyTo`), else the conversation whose ask names it, else
   * the newest card filed with the same stem, PR or chat, else one whose ask or steps link its PR or chat. Null: none fits,
   * and its answer starts one (the writer is told, so it never happens silently). A private repo's card joins only an
   * app-only conversation, as its answer would.
   */
  function placeCard(need: Pick<Need, "id" | "repo" | "pr" | "chat" | "replyTo">): { thread: string; via: string } | null {
    // Rivet's chat is no sign of an ask's ownership either.
    const chat = need.chat && !MIXED_CHATS.has(need.chat.toLowerCase()) ? need.chat : undefined;
    const card: CardItem & { id: string } = { id: need.id, ...(need.repo ? { repo: need.repo } : {}), ...(need.pr !== undefined ? { pr: need.pr } : {}), ...(chat ? { chat } : {}) };
    const { owner } = threads.summaries(undefined, card);
    const fits = (id: string | null | undefined) => (id && !ownsNoCard(id) ? id : null);
    const replyTo = typeof need.replyTo === "string" ? need.replyTo : null;
    if (replyTo) {
      const named = fits(commands.threadOf(replyTo)) ?? fits(commands.cardConversation(replyTo)?.thread);
      if (named) return { thread: named, via: "reply-to" };
      logger.error(`[conversations] card ${need.id} names ${replyTo}, which is no message or filed card: matched instead`);
    }
    const owned = owner(card);
    if (owned && owned.strength === 5 && fits(owned.thread)) return { thread: owned.thread, via: "ask" };
    const like = commands.filedLike(matchOf(card));
    if (like && fits(like.thread)) return like;
    // Its ask's or Rivet's steps' PR or chat; a PR or chat a conversation only mentions is too weak a sign to post into it.
    if (owned && owned.strength >= 3 && fits(owned.thread)) return { thread: owned.thread, via: owned.strength === 4 ? "pr" : "chat" };
    return null;
  }

  /**
   * The line of its conversation a card's replyTo names, which it answers, so Chat shows it beside a line you typed
   * (2026-10-12). An update card is news, never an answer: the board refuses one answering his message, so only a say
   * progress card, filed by naming its conversation, carries one.
   */
  function answersLine(need: Need, place: { thread: string }): string | undefined {
    const replyTo = need.replyTo;
    if (typeof replyTo !== "string" || need.kind === UPDATE || isGotIt(need)) return undefined;
    return commands.threadOf(replyTo) === place.thread ? replyTo : undefined;
  }

  /** A card posted before it kept its replyTo gets it now. */
  function relink(need: Need): void {
    const filed = commands.cardConversation(need.id);
    const answers = filed?.posted ? answersLine(need, filed) : undefined;
    if (filed?.posted && answers) commands.linkPostedReply(filed.posted, answers);
  }

  /**
   * Files a card and puts it in its conversation as Rivet's message, once. `fresh`: the card is new to the board, so
   * one filed before (dropped, then added again) is placed again, and posted anew where it now belongs (2026-10-20).
   */
  function fileCard(need: Need, at: string, fresh: boolean): void {
    const before = commands.cardConversation(need.id);
    if (before && !fresh) return relink(need);
    const id = randomUUID();
    const place = placeCard(need);
    if (!place || (before && place.thread === before.thread)) return before ? relink(need) : undefined;
    const card = { id: need.id, ...(need.repo ? { repo: need.repo } : {}), ...(need.pr !== undefined ? { pr: need.pr } : {}), ...(need.chat ? { chat: need.chat } : {}) };
    if (!commands.fileCard({ card: need.id, thread: place.thread, via: place.via, ...keyOf(card), at, ...(before ? { again: true } : {}) })) return;
    const ask = need.ask?.split("\n").find((line) => line.trim() !== "")?.trim();
    const posted: PostedCard = { id: need.id, kind: need.kind, title: need.title, ...(ask ? { ask: ask.slice(0, POSTED_ASK_MAX) } : {}) };
    const answers = answersLine(need, place);
    const message = commands.addChatMessage({ id, from: "rivet", text: need.title, at, thread: place.thread, posted, ...(answers ? { replyTo: answers } : {}) });
    commands.setCardPosted(need.id, message.id);
    if (place.via === "own") {
      commands.patchThread(id, { title: need.title.slice(0, MAX_THREAD_TITLE) }, at);
    }
    out.broadcast(message);
  }

  // An answer from before cards were filed files its card where it is, once (the newest answer wins), so a card made
  // from that card later finds its conversation by stem, PR or chat.
  for (const answer of commands.unfiledAnswers()) {
    const home = commands.threadOf(answer.id) ?? answer.id;
    if (ownsNoCard(home)) continue;
    const item = store.getReply(answer.id)?.item;
    const card: CardItem & { id: string } = { id: answer.card, ...(item?.repo ? { repo: item.repo } : {}), ...(item?.pr !== undefined ? { pr: item.pr } : {}), ...(item?.chat ? { chat: item.chat } : {}) };
    commands.fileCard({ card: answer.card, thread: home, via: "answer", ...keyOf(card), at: answer.at });
  }

  for (const need of store.getBoard()?.board.needs ?? []) relink(need);

  // Each card new to the board, or newly naming its conversation, is filed as it is written. The cards on the board
  // when the server starts are known already: a restart never posts the board again.
  let known = new Set((store.getBoard()?.board.needs ?? []).map((need) => need.id));
  // An answer from before card titles were kept takes its reply's title once (2026-10-20); later answers carry it.
  commands.backfillCardTitles((id) => store.getReply(id)?.itemTitle);
  router.onClose(
    store.onBoard((board) => {
      const at = now().toISOString();
      // A card whose replyTo names another card of this write is filed after it, so it follows it in.
      const byId = new Map(board.needs.map((need) => [need.id, need]));
      const depth = (need: (typeof board.needs)[number]): number => {
        let n = 0;
        for (let up = need; typeof up.replyTo === "string" && byId.has(up.replyTo) && n < board.needs.length; n += 1) up = byId.get(up.replyTo)!;
        return n;
      };
      for (const need of [...board.needs].sort((a, b) => depth(a) - depth(b))) {
        if (known.has(need.id) && typeof need.replyTo !== "string") continue;
        try {
          fileCard(need, at, !known.has(need.id));
        } catch (error) {
          logger.error(`[conversations] card ${need.id} not filed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      known = new Set(board.needs.map((need) => need.id));
    }),
  );
  // The conversation a card was filed in, for the CLI to say so (or that its answer will start one).
  router.onPrefix("GET", CARD_PREFIX, ({ request, response, url }) => {
    if (!hasBearer(request, config.boardTokenDigest)) requireSession(request);
    const id = decodeSegment(url.pathname.slice(CARD_PREFIX.length), "no such card");
    if (!ID_PATTERN.test(id)) throw new HttpError(404, "no such card");
    const filed = commands.cardConversation(id);
    json(response, 200, { card: id, conversation: filed ? { id: filed.thread, title: commands.conversationTitle(filed.thread), via: filed.via } : null });
  });

  // Merge into…: your session, or the board token for the tidy. Every message, step and card of one moves into the other.
  router.onPrefix("POST", PREFIX, async ({ request, response, url }) => {
    const rest = url.pathname.slice(PREFIX.length);
    if (!rest.endsWith("/merge")) throw new HttpError(404, "not found");
    const rivet = hasBearer(request, config.boardTokenDigest);
    if (!rivet) {
      requireSameOrigin(request, config.origin);
      requireSession(request);
    }
    const parsed = conversationMergeSchema.safeParse(await readJson(request, PATCH_BODY_MAX));
    if (!parsed.success) {
      json(response, 400, { error: "invalid merge", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    const raw = decodeSegment(rest.slice(0, -"/merge".length), "no such conversation");
    if (ownsNoCard(raw) || ownsNoCard(parsed.data.into)) throw new HttpError(409, "Updates and Agent Chat never merge");
    // One merged already answers as done, so the tidy can run twice.
    const into = threads.threadFrom(parsed.data.into);
    const from = commands.threadOf(raw) === into ? into : threads.threadFrom(raw);
    if (ownsNoCard(from) || ownsNoCard(into)) throw new HttpError(409, "Updates and Agent Chat never merge");
    if (from === into) {
      if (raw === into) throw new HttpError(409, "a conversation cannot merge into itself");
      json(response, 200, { moved: 0, conversation: detail(into) } satisfies MergeResponse);
      return;
    }
    const before = threads.summaries();
    if (before.appOnly.includes(from) !== before.appOnly.includes(into)) throw new HttpError(409, "one of them stays in the app and the other can be shared");
    const moved = commands.mergeConversation(from, into);
    // Two app-only conversations stay app-only as one, whatever you move it to or whichever ask leads later: `from`'s
    // settings go, so the project that kept them private is filed (Rivet's filing, which no Move or ask overrides) on the
    // one that stays.
    if (before.appOnly.includes(into)) {
      const kept = [into, from].map((id) => before.threads.find((thread) => thread.id === id)).flatMap((thread) => [thread?.filed, thread?.project]);
      const project = kept.find((one): one is ThreadProject => typeof one === "string" && APP_ONLY_PROJECTS.has(one as ThreadProject));
      if (project) commands.patchThread(into, { project }, now().toISOString());
    }
    out.announce({ id: from });
    out.announce({ id: into });
    json(response, 200, { moved, conversation: detail(into) } satisfies MergeResponse);
  });

  // Split: the lines you typed with no Reply that the page's conversation took in
  // move out into conversations of their own, with what chains to them. `dryRun` plans it and changes nothing.
  router.on("POST", "/api/conversations/split", async ({ request, response }) => {
    const rivet = hasBearer(request, config.boardTokenDigest);
    if (!rivet) {
      requireSameOrigin(request, config.origin);
      requireSession(request);
    }
    const parsed = conversationSplitSchema.safeParse(await readJson(request, PATCH_BODY_MAX));
    if (!parsed.success) {
      json(response, 400, { error: "invalid split", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    const only = parsed.data.conversation === undefined ? null : threads.threadFrom(parsed.data.conversation);
    if (only !== null && ownsNoCard(only)) throw new HttpError(409, "Updates and Agent Chat never split");
    const cardReplyTo = new Map((store.getBoard()?.board.needs ?? []).flatMap((need) => (typeof need.replyTo === "string" ? [[need.id, need.replyTo] as const] : [])));
    const plan = commands.splitPlan(only, cardReplyTo);
    const dryRun = parsed.data.dryRun === true;
    if (!dryRun && plan.length > 0) {
      // Each split conversation's app-only project, from the same view the merge reads (its ask and the titler count too).
      const before = threads.summaries();
      const appOnly = new Map(
        before.threads.flatMap((thread) => {
          if (!before.appOnly.includes(thread.id)) return [];
          const project = [thread.filed, thread.project].find((one): one is ThreadProject => typeof one === "string" && APP_ONLY_PROJECTS.has(one as ThreadProject));
          return project ? [[thread.id, project] as const] : [];
        }),
      );
      commands.splitConversations(plan, appOnly, now().toISOString());
      for (const group of plan) {
        out.announce({ id: group.from });
        out.announce({ id: group.root });
      }
    }
    json(response, 200, {
      dryRun,
      conversations: plan.map((group) => ({ id: group.root, from: group.from, title: group.title, messages: group.messages.length, cards: group.cards.length })),
      messages: plan.reduce((sum, group) => sum + group.messages.length, 0),
      cards: plan.reduce((sum, group) => sum + group.cards.length, 0),
    } satisfies SplitResponse);
  });

  /** Every answer, and an answer retried (its message may have been lost to a restart or an error). */
  const gotIt = (id: string) => {
    const card = store.getBoard()?.board.needs.find((need) => need.id === id);
    return card !== undefined && isGotIt(card);
  };
  const onAnswer = (reply: Reply) => {
    // Seen on an update card says nothing to anyone.
    if (reply.decision === "seen") return;
    // Nor does Got it on a news card: it only drops the card.
    // A retried tap (same clientId) comes after the card left the board, or after its id went to another card: its reply
    // was handled as it landed, which a bare Got it on any other decision card never is.
    if (bareGotIt(reply) && (gotIt(reply.itemId) || (reply.handled && reply.item.kind === DECISION))) return;
    try {
      answered(reply);
    } catch (error) {
      // The answer stands without its message: the card, GitHub and Rivet's line still have it.
      logger.error(`[conversations] card answer ${reply.id} not added to a conversation: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  router.onClose(store.onReply(onAnswer));

  // Rivet's note under a card you answered is a reply to your answer in its conversation, and your answer shows it
  // was read.
  router.onClose(
    store.onCardNote(({ card, text, at }) => {
      const answer = commands.cardAnswer(card);
      if (!answer) return;
      try {
        const quote = commands.quoteOf(answer.id) ?? undefined;
        // Your answer first: the list's row then ends on the reply.
        if (commands.setAck(answer.id, "replied below", at)) out.broadcast(commands.getChatMessage(answer.id)!);
        const message = commands.addChatMessage({ id: randomUUID(), from: "rivet", text, at, replyTo: answer.id, quote });
        out.broadcast(message);
        // A reply pushes as say.mjs's does; only an ack is silent.
        const conversation = message.threadId ?? message.id;
        if (conversation !== TEAM_ROOM_ID) void push.notify(rivetPayload(text, { id: conversation, title: commands.conversationTitle(conversation) }), "card", `rivet:${message.id}`).catch(() => {});
      } catch (error) {
        logger.error(`[conversations] card note on ${card} not added to its conversation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
}
