import { MAX_ASKS, type Ask } from "../../shared/asks.js";
import { ownsNoCard, TEAM_ROOM_ID, type ConversationStage } from "../../shared/conversations.js";
import type { Need } from "../../shared/board.js";
import { NO_REPO } from "../../shared/board.js";
import {
  AI_RECENT_MESSAGES,
  AI_TEXT_CLIP,
  AI_UNTITLED_MAX,
  appOnlyThread,
  inFolder,
  isOpen,
  loneNotice,
  namesPr,
  STATUS_FILTERS,
  statusCounts,
  statusGroup,
  THREAD_MESSAGES_MAX,
  THREAD_PROJECTS,
  THREAD_WINDOW_MS,
  THREAD_WINDOWS,
  threadAiSchema,
  threadFolders,
  threadIdSchema,
  threadMoveSchema,
  threadPatchSchema,
  THREADS_PAGE_MAX,
  type PrRef,
  type CardThread,
  type CardThreadsResponse,
  type StatusFilter,
  type ThreadDetail,
  type ThreadEvent,
  type ThreadProject,
  type ThreadsResponse,
  type ThreadSummary,
  type ThreadWindow,
  type Mentions,
  type UntitledThread,
} from "../../shared/threads.js";
import type { CommandStore, ThreadRow } from "../commandstore.js";
import { prStageKey } from "../conversations.js";
import { needRev, openBoard } from "../http.js";
import { decodeSegment, hasBearer, HttpError, json, readJson, requireBearer, requireSameOrigin } from "../httputil.js";
import { allAsksByThread, asksByThread, cardOwner, cardThreads, liveState, openCounts, parsePrKey, statusFacts, summarize, threadLinks, threadSteps, type CardItem, type LiveState, type ThreadLinks } from "../threads.js";
import { deriveWorkers } from "../workers.js";
import { parseRedacted } from "../redact.js";
import type { Router } from "./router.js";

// Chat threads (src/shared/threads.ts): your phone reads them and moves them (your session), Rivet sets their
// status, project, title and steps with the board token. A change goes out on the chat stream as a `thread` event, so
// an open app redraws.

const PREFIX = "/api/threads/";
const AI_PREFIX = "/api/bridge/threads/";
const PATCH_BODY_MAX = 64 * 1024;
const REPLIES_READ = 500;
/** Questions threadMentions keeps answers to: the list's, and a few opened threads'. */
const MENTIONS_MEMO_MAX = 16;

/** What the conversation routes read through the threads': every thread worked out, and one thread's detail. */
export interface ThreadsApi {
  /** `answering`: a card just answered, still counted as live so what its owner names of it still counts. */
  summaries: (opened?: string, answering?: CardItem) => {
    rows: ReturnType<CommandStore["threadRows"]>;
    threads: ThreadSummary[];
    links: Map<string, ThreadLinks>;
    appOnly: string[];
    owner: (item: CardItem) => { thread: string; strength: number } | null;
    /** Threads with an unanswered card filed in them (a say card too) or any ask awaiting you you have not written after. */
    waiting: Set<string>;
  };
  detail: (id: string) => ThreadDetail;
  /** The thread a message id is in, as `/api/threads/:id` reads it; 404 for anything else. */
  threadFrom: (raw: string) => string;
  /** Each PR's stage as the bridge's GitHub readings show it now, by prStageKey. */
  prStages: () => Map<string, ConversationStage>;
}

export function registerThreads(router: Router, commands: CommandStore, announce: (event: ThreadEvent) => void): ThreadsApi {
  const { config, store, requireSession, schedules, now } = router.deps;
  // A stored ask can move the threads it linked and links to into another project: open chats hear it.
  router.onClose(
    store.onAsk((ask, previous) => {
      const linking = [ask, previous].filter((one): one is Ask => !!one?.replyId);
      if (linking.length === 0) return;
      const rows = commands.threadRows();
      const ids = new Set(linking.flatMap((one) => [...asksByThread([one], rows, (message) => commands.threadOf(message)).keys()]));
      if (ids.size === 0) return;
      const { threads, appOnly } = summaries();
      for (const id of ids) {
        const thread = threads.find((one) => one.id === id);
        if (thread) announce({ id, project: thread.project, appOnly: appOnly.includes(id) });
      }
    }),
  );

  /**
   * Open chats come from the bridge's workers snapshot (Rivet's own left out), and cards from the board less the ones
   * you answered at their rev. Nothing reads open or merged PRs now.
   */
  function readLive(answering?: CardItem): LiveState {
    const board = openBoard(store, schedules, store.getBoard()?.board ?? null, now());
    const { workers } = deriveWorkers(store.getWorkers(), board, config.monitorChat, now().getTime());
    return liveState({
      openPrs: [],
      merged: [],
      cards: [...(board?.needs ?? []), ...(answering ? [answering] : [])],
      chats: workers.filter((worker) => !worker.rivet),
    });
  }

  // threadMentions reads a week of chat text: most of every thread-list poll's CPU, which an open app repeats every few
  // seconds and which ran the shared-cpu machine out of CPU (2026-10-05). Messages are only ever added, so an answer
  // holds until a new message, for the same question. The query reads from `since`'s minute so it repeats, and its
  // answer keeps only the threads with a message since `since` itself, as the query alone would.
  const mentionsMemo = new Map<string, Map<string, Mentions>>();
  let mentionsSeq = -1;
  let latest = new Map<string, string>();
  function threadMentions(
    needles: string[],
    known: ReadonlyMap<number, readonly { repo: string; number: number }[]>,
    keep: Parameters<CommandStore["threadMentions"]>[1],
    since: string,
    thread?: string,
  ): Map<string, Mentions> {
    // Any change to messages, a merge moving them included, not only a new one.
    const seq = commands.chatVersion();
    if (seq !== mentionsSeq) {
      mentionsMemo.clear();
      mentionsSeq = seq;
      latest = commands.threadLatest();
    }
    const from = since === "" ? "" : new Date(Date.parse(since) - (Date.parse(since) % 60_000)).toISOString();
    const key = JSON.stringify([needles, [...known], [...keep.words], from, thread ?? null]);
    let said = mentionsMemo.get(key);
    if (!said) {
      if (mentionsMemo.size >= MENTIONS_MEMO_MAX) mentionsMemo.clear();
      said = commands.threadMentions(needles, keep, from, thread);
      mentionsMemo.set(key, said);
    }
    return from === since ? said : new Map([...said].filter(([id]) => (latest.get(id) ?? "") >= since));
  }

  function summaries(
    opened?: string,
    answering?: CardItem,
  ): {
    rows: ReturnType<CommandStore["threadRows"]>;
    threads: ThreadSummary[];
    asks: ReturnType<typeof asksByThread>;
    links: Map<string, ThreadLinks>;
    appOnly: string[];
    owner: (item: CardItem) => { thread: string; strength: number } | null;
    waiting: Set<string>;
  } {
    const rows = commands.threadRows();
    const allAsks = allAsksByThread(store.listAsks({ limit: MAX_ASKS }), rows, (id) => commands.threadOf(id));
    const asks = new Map([...allAsks].map(([thread, linked]) => [thread, linked[0]!]));
    const steps = commands.allThreadSteps();
    const live = readLive(answering);
    // Only messages that could name a PR, an open chat or a card's chat are read; statusFacts decides what they name.
    const chats = [...[...live.chats].map((key) => key.split("\n")[1]!), ...live.cards.flatMap((need) => (need.chat ? [need.chat.toLowerCase()] : []))];
    const needles = [...new Set(["#", "/pull/", ...chats])];
    // Only PRs GitHub lists as open, merged or closed, or a card is on, and the chats above can change a status
    // (namesPr); a closed one only gives a conversation its red stage icon.
    const known = new Map<number, { repo: string; number: number }[]>();
    for (const pr of [...[...live.openPrs].map(parsePrKey), ...live.merged.values(), ...live.cards.flatMap((need) => (need.pr !== undefined ? [{ repo: need.repo, number: need.pr }] : []))]) {
      known.set(pr.number, [...(known.get(pr.number) ?? []), pr]);
    }
    const keep = { pr: (ref: PrRef) => ((known.get(ref.number) ?? []).some((pr) => namesPr(ref, pr)) ? ref : null), words: new Set(chats) };
    const said = threadMentions(needles, known, keep, new Date(now().getTime() - THREAD_WINDOW_MS.week).toISOString());
    // A card's owner weighs what each thread's messages name below its ask's and Rivet's links (cardMatch). Only a
    // thread active this week has its messages read for it, so the list, an opened thread and /api/card-threads agree.
    // A card filed in a conversation (2026-10-09) is that conversation's alone: another's ask naming it no longer counts.
    const filed = commands.filedCards();
    const filedIn = new Map([...filed].flatMap(([thread, cards]) => cards.map((card) => [card, thread] as const)));
    const links = new Map(
      rows.map((row) => {
        const linked = threadLinks(allAsks.get(row.id) ?? [], steps.get(row.id) ?? [], said.get(row.id));
        const ids = [...new Set([...linked.ids.filter((id) => (filedIn.get(id) ?? row.id) === row.id), ...(filed.get(row.id) ?? [])])];
        return [row.id, { ...linked, ids }];
      }),
    );
    // An opened thread reads its own mentions however long it has been quiet, for its open and merged PRs and chats:
    // the window bounds the list, not a thread. Its card is still cardOwner's word.
    const own = opened === undefined ? undefined : threadMentions(needles, known, keep, "", opened).get(opened);
    // Updates owns no card: Rivet writes it on its own, not a card's conversation.
    const owner = cardOwner(rows.filter((row) => !ownsNoCard(row.id)).map((row) => ({ id: row.id, lastAt: row.lastAt, links: links.get(row.id)! })));
    // Each card's owner, worked out once for every thread that asks.
    const owners = new Map<CardItem, ReturnType<typeof owner>>(live.cards.map((card) => [card, owner(card)]));
    const time = now();
    const threads = rows.map((row) => {
      const owns = (card: CardItem) => {
        const found = owners.get(card);
        return found?.thread === row.id ? found.strength : 0;
      };
      return summarize(row, asks.get(row.id), time, statusFacts(asks.get(row.id), steps.get(row.id) ?? [], live, (row.id === opened ? own : undefined) ?? said.get(row.id), owns));
    });
    const appOnly = threads.filter(appOnlyThread).map((thread) => thread.id);
    // Waiting on you beyond the status line, which reads one card and the newest ask: never archived.
    const carded = commands.conversationsOfCards(live.cards.flatMap((card) => (card.id !== undefined ? [card.id] : [])));
    const after = (row: ThreadRow, at: string) => row.lastOwnerAt !== null && row.lastOwnerAt > at;
    const waiting = new Set(
      rows
        .filter((row) => carded.has(row.id) || (allAsks.get(row.id) ?? []).some((ask) => ask.stage === "needs-you" && !after(row, ask.stageAt)))
        .map((row) => row.id),
    );
    return { rows, asks, links, threads, appOnly, owner, waiting };
  }

  function detail(id: string): ThreadDetail {
    const { rows, threads, asks } = summaries(id);
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) throw new HttpError(404, "no such thread");
    const row = rows[index]!;
    const { messages, more } = commands.threadMessages(id, THREAD_MESSAGES_MAX);
    const root = messages[0]?.id === id ? messages[0] : commands.getChatMessage(id);
    const steps = threadSteps({
      row,
      rootAt: root?.at ?? row.lastAt,
      ask: asks.get(id),
      stored: commands.threadSteps(id),
      merged: [],
      replies: (prs) => store.repliesForPrs(prs, REPLIES_READ),
    });
    return { ...threads[index]!, steps, messages, more };
  }

  /** Each open card's thread and round, for the card's top line; a thread's answers counted are its newest REPLIES_READ. */
  function cardLinks(): CardThreadsResponse {
    const needs = store.getBoard()?.board?.needs ?? [];
    const answered = store.answeredCards(needs.map((need) => need.id));
    const cards = needs.map((need) => ({ ...need, rev: needRev(need) })).filter((card) => !answered.has(`${card.id}\n${card.rev}`));
    if (!cards.length) return { cards: [] };
    return { cards: linkCards(cards) };
  }

  function linkCards(cards: (Need & { rev: string })[]): CardThread[] {
    const { threads, links } = summaries();
    const linked = threads.filter((summary) => !ownsNoCard(summary.id)).map((summary) => ({ summary, links: links.get(summary.id)! }));
    // A bare PR reference or a named chat may be any card's repo; cardThreads keeps only the answers the owner owns.
    const repos = [...new Set([NO_REPO, ...cards.map((card) => card.repo ?? NO_REPO)])];
    const read = (links: ThreadLinks) =>
      store.repliesLinked(
        {
          ids: links.ids,
          prs: [...links.prs, ...(links.said?.refs ?? []).flatMap((ref) => (ref.repo !== null ? [{ repo: ref.repo, number: ref.number }] : repos.map((repo) => ({ repo, number: ref.number }))))],
          chats: [...links.chats, ...[...(links.said?.words ?? [])].flatMap((chat) => repos.map((repo) => ({ repo, chat })))],
        },
        REPLIES_READ,
      );
    return cardThreads(linked, cards, read);
  }
  router.deps.cardThreadTitles((need) => linkCards([{ ...need, rev: needRev(need) }]).map((link) => link.title));

  router.on("GET", "/api/card-threads", ({ request, response }) => {
    requireSession(request);
    json(response, 200, cardLinks());
  });

  /** The thread a message id is in: any message of it names it, as Rivet often knows only your latest. */
  function threadFrom(raw: string): string {
    const id = decodeSegment(raw, "no such thread");
    if (!threadIdSchema.safeParse(id).success) throw new HttpError(404, "no such thread");
    const thread = commands.threadOf(id);
    if (!thread) throw new HttpError(404, "no such thread");
    return thread;
  }

  // `view=open` is the open inbox: Needs you first, then Working, each newest first, every one of them. `view=all`
  // (the default) is every thread newest first, `limit` at a time; `before` is the `next` of the page before. Both,
  // and every count, hold only threads active in the `since` window: the last 24 hours (`day`) or 7 days (`week`, the
  // default), less Rivet's lone notes (loneNotice). `project` (or `none`) picks a folder; `status` a status chip. The
  // folder counts follow the window and the chip, the chip counts the window and the folder. Every message stays
  // reachable in the chat's flat list.
  router.on("GET", "/api/threads", ({ request, response, url }) => {
    const rivet = hasBearer(request, config.boardTokenDigest);
    if (!rivet) requireSession(request);
    const params = url.searchParams;
    const view = params.get("view") ?? "all";
    if (view !== "all" && view !== "open") throw new HttpError(400, "view is all or open");
    const since = params.get("since") ?? "week";
    if (!(THREAD_WINDOWS as readonly string[]).includes(since)) throw new HttpError(400, `since is ${THREAD_WINDOWS.join(" or ")}`);
    const project = params.get("project");
    if (project !== null && project !== "none" && !(THREAD_PROJECTS as readonly string[]).includes(project)) {
      throw new HttpError(400, `project is none or one of ${THREAD_PROJECTS.join(", ")}`);
    }
    const status = (params.get("status") ?? "all") as StatusFilter;
    if (!STATUS_FILTERS.includes(status)) throw new HttpError(400, `status is ${STATUS_FILTERS.join(", ")}`);
    const limit = params.has("limit") ? Number(params.get("limit")) : 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > THREADS_PAGE_MAX) throw new HttpError(400, `limit is 1 to ${THREADS_PAGE_MAX}`);
    const before = params.get("before");
    if (before !== null && !/^\d{1,15}$/.test(before)) throw new HttpError(400, "invalid cursor");

    const all = summaries();
    const cutoff = now().getTime() - THREAD_WINDOW_MS[since as ThreadWindow];
    // The board token is the chats', and chats never read Team Chat.
    const threads = all.threads.filter((thread) => Date.parse(thread.lastAt) >= cutoff && !loneNotice(thread) && !(rivet && thread.id === TEAM_ROOM_ID));
    const rows = all.rows;
    const counts = openCounts(threads, THREAD_PROJECTS);
    const appOnly = all.appOnly;
    const folders = threadFolders(threads, status);
    const seqs = new Map(rows.map((row) => [row.id, row.lastSeq]));
    const folder = threads.filter((thread) => inFolder(thread, project as ThreadProject | "none" | null));
    const statuses = statusCounts(folder);
    let list = folder.filter((thread) => status === "all" || statusGroup(thread.status) === status);
    if (view === "open") {
      // Rows come newest first; a stable sort keeps that order within each side.
      list = list.filter((thread) => isOpen(thread.status)).sort((a, b) => Number(b.ball === "owner") - Number(a.ball === "owner"));
      json(response, 200, { threads: list, open: counts, folders, statuses, appOnly } satisfies ThreadsResponse);
      return;
    }
    if (before !== null) list = list.filter((thread) => seqs.get(thread.id)! < Number(before));
    const page = list.slice(0, limit);
    const last = page.at(-1);
    const body: ThreadsResponse = { threads: page, open: counts, folders, statuses, appOnly, ...(last && list.length > limit ? { next: String(seqs.get(last.id)) } : {}) };
    json(response, 200, body);
  });

  router.onPrefix("GET", PREFIX, ({ request, response, url }) => {
    const rivet = hasBearer(request, config.boardTokenDigest);
    if (!rivet) requireSession(request);
    const id = threadFrom(url.pathname.slice(PREFIX.length));
    if (rivet && id === TEAM_ROOM_ID) throw new HttpError(404, "no such thread");
    json(response, 200, detail(id));
  });

  /** The stream's word on a thread, with whether anything keeps it app-only. */
  function event(id: string, project: ThreadProject | null): ThreadEvent {
    return { id, project, appOnly: summaries().appOnly.includes(id) };
  }

  // Rivet (board token) changes anything; your session only moves a thread to a project or Unsorted. A move records
  // itself, so the titler never refiles the thread.
  router.onPrefix("PATCH", PREFIX, async ({ request, response, url }) => {
    const rivet = hasBearer(request, config.boardTokenDigest);
    if (!rivet) {
      requireSameOrigin(request, config.origin);
      requireSession(request);
    }
    const id = threadFrom(url.pathname.slice(PREFIX.length));
    // A change answers with the thread, so the board token never changes the Team room either.
    if (rivet && id === TEAM_ROOM_ID) throw new HttpError(404, "no such thread");
    const raw = await readJson(request, PATCH_BODY_MAX);
    const parsed = rivet ? parseRedacted(threadPatchSchema, raw) : threadMoveSchema.safeParse(raw);
    if (!parsed.success) {
      json(response, 400, { error: "invalid thread change", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    let changed: boolean;
    try {
      changed = commands.patchThread(id, parsed.data, now().toISOString(), !rivet);
    } catch (error) {
      if (error instanceof RangeError) throw new HttpError(409, error.message);
      throw error;
    }
    const body = detail(id);
    if (changed || !rivet) announce(event(id, (body.project as ThreadProject | null) ?? null));
    json(response, 200, body);
  });

  // The bridge's AI titler (bridge/lib/threads-titler.mjs): threads active this week it has not run on, newest first,
  // with a little of each, and its one answer per thread.
  router.on("GET", "/api/bridge/threads/untitled", ({ request, response, url }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const raw = url.searchParams.get("limit");
    const limit = raw === null ? 10 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > AI_UNTITLED_MAX) throw new HttpError(400, `limit is 1 to ${AI_UNTITLED_MAX}`);
    const cutoff = now().getTime() - THREAD_WINDOW_MS.week;
    const { rows, threads } = summaries();
    const untitled: UntitledThread[] = [];
    for (const [index, row] of rows.entries()) {
      if (untitled.length >= limit) break;
      // A server-owned conversation keeps its own title, and the Team room's talk never goes to the titler's model.
      if (row.aiTitledAt !== null || Date.parse(row.lastAt) < cutoff || ownsNoCard(row.id)) continue;
      const root = commands.getChatMessage(row.id);
      const recent = commands.threadMessages(row.id, AI_RECENT_MESSAGES).messages.filter((message) => message.id !== row.id);
      const messages = [...(root ? [root] : []), ...recent].map((message) => ({ from: message.from, text: clip(message.text) }));
      untitled.push({ id: row.id, project: threads[index]!.project, messages });
    }
    json(response, 200, { threads: untitled });
  });

  router.onPrefix("POST", AI_PREFIX, async ({ request, response, url }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const rest = url.pathname.slice(AI_PREFIX.length);
    if (!rest.endsWith("/ai")) throw new HttpError(404, "not found");
    const id = threadFrom(rest.slice(0, -"/ai".length));
    const parsed = parseRedacted(threadAiSchema, await readJson(request, PATCH_BODY_MAX));
    if (!parsed.success) {
      json(response, 400, { error: "invalid thread title", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    commands.setThreadAi(id, parsed.data, now().toISOString());
    const body = detail(id);
    announce(event(id, (body.project as ThreadProject | null) ?? null));
    json(response, 200, body);
  });

  /** No pull-request reading feeds the stages now: every conversation's PR stage is unknown. */
  function prStages(): Map<string, ConversationStage> {
    return new Map();
  }

  return { summaries, detail, threadFrom, prStages };
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > AI_TEXT_CLIP ? `${flat.slice(0, AI_TEXT_CLIP - 1).trimEnd()}…` : flat;
}
