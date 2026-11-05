import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BATCH_QUIET_MS } from "../src/server/commandstore.js";
import { MAX_CARDS } from "../src/server/http.js";
import { conversationStage, conversationSummary, idle, isClosed, isDone, linkedPrs, resolveConversation } from "../src/server/conversations.js";
import { rivetPayload } from "../src/server/push.js";
import { wantsText } from "../src/shared/answers.js";
import type { ChatMessage } from "../src/shared/command.js";
import type { CardThreadsResponse } from "../src/shared/threads.js";
import { answerText, IDLE_ARCHIVE_MS, linksChat, TEAM_ROOM_ID, UPDATES_ID, type ConversationDetail, type ConversationPage, type ConversationsResponse } from "../src/shared/conversations.js";
import { THREAD_MESSAGES_MAX } from "../src/shared/threads.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, browser, fakeClock, REPLY_BOARD, revOf, startServer, type TestServer } from "./helpers.js";

const T0 = Date.parse("2026-10-03T00:00:00.000Z");
const REPO = "example-org/example-repo";

describe("resolveConversation", () => {
  const threads = new Map([
    ["m1", "c1"],
    ["c1", "c1"],
    ["reply-1", "c2"],
  ]);
  const deps = (mentioned: string[] = []) => ({
    threadOf: (id: string) => threads.get(id) ?? null,
    isReply: (id: string) => id === "old-reply" || id === "older-reply",
    repliedIn: (id: string) => (id === "older-reply" ? "h1" : null),
    mentioned: () => mentioned,
  });

  it("lands by the id Rivet quotes: a message, a conversation's own id, a card answer's reply id", () => {
    expect(resolveConversation({ id: "new", replyTo: "m1", text: "x" }, deps())).toEqual({ thread: "c1", via: "message" });
    expect(resolveConversation({ id: "new", replyTo: "c1", text: "x" }, deps())).toEqual({ thread: "c1", via: "message" });
    expect(resolveConversation({ id: "new", replyTo: "reply-1", text: "x" }, deps())).toEqual({ thread: "c2", via: "message" });
  });

  it("an unknown id, no mention or two mentions go to Updates; exactly one mention files it there", () => {
    expect(resolveConversation({ id: "new", replyTo: "gone", text: "x" }, deps(["c1"]))).toEqual({ thread: UPDATES_ID, via: "updates" });
    // A card answer from before conversations has no message: a reply to it starts one, as it always did.
    expect(resolveConversation({ id: "new", replyTo: "old-reply", text: "x" }, deps(["c1"]))).toEqual({ thread: "new", via: "new" });
    // ...and the next reply to it joins that one.
    expect(resolveConversation({ id: "new", replyTo: "older-reply", text: "x" }, deps(["c1"]))).toEqual({ thread: "h1", via: "message" });
    expect(resolveConversation({ id: "new", text: "x" }, deps())).toEqual({ thread: UPDATES_ID, via: "updates" });
    expect(resolveConversation({ id: "new", text: "x" }, deps(["c1", "c2"]))).toEqual({ thread: UPDATES_ID, via: "updates" });
    expect(resolveConversation({ id: "new", text: "x" }, deps(["c1"]))).toEqual({ thread: "c1", via: "mention" });
    // Updates never counts as the one a note names.
    expect(resolveConversation({ id: "new", text: "x" }, deps(["c1", UPDATES_ID]))).toEqual({ thread: "c1", via: "mention" });
  });

  it("say.mjs --new starts one at the message", () => {
    expect(resolveConversation({ id: "new", text: "x", fresh: true }, deps(["c1"]))).toEqual({ thread: "new", via: "new" });
  });

  it("a card answer says what you decided, with your note", () => {
    expect(answerText({ decision: "approve", itemTitle: "Night Batch results row" })).toBe("Approved: Night Batch results row");
    expect(answerText({ decision: "choice", choice: "Ship it", text: "looks good", itemTitle: "t" })).toBe("Chose: Ship it\nlooks good");
    expect(answerText({ decision: "reject", itemTitle: "t" })).toBe("Rejected: fix and resubmit");
    expect(answerText({ decision: "comment", text: "why?", itemTitle: "t" })).toBe("Comment: why?");
    expect(answerText({ decision: "done", itemTitle: "t" })).toBe("Done");
    expect(answerText({ decision: "dismiss", itemTitle: "t" })).toBe("Dismissed");
  });
});

describe("conversation stage and done", () => {
  const stages = new Map([
    ["#1", "open"],
    ["#2", "draft"],
    ["#3", "merged"],
    ["#4", "closed"],
    ["example-org/other-repo#3", "open"],
  ] as const);
  const stageOf = (key: string) => stages.get(key as never);
  const pr = (number: number, repo = "") => `${repo}#${number}`;

  it("anything still open wins, then draft, merged, closed; none with no PR GitHub told us of", () => {
    expect(conversationStage([pr(4), pr(3), pr(1)], stageOf)).toEqual({ stage: "open", pr: "#1" });
    expect(conversationStage([pr(4), pr(3), pr(2)], stageOf)).toEqual({ stage: "draft", pr: "#2" });
    expect(conversationStage([pr(4), pr(3)], stageOf)).toEqual({ stage: "merged", pr: "#3" });
    expect(conversationStage([pr(4)], stageOf)).toEqual({ stage: "closed", pr: "#4" });
    expect(conversationStage([pr(99)], stageOf)).toEqual({ stage: "none" });
    expect(conversationStage([], stageOf)).toEqual({ stage: "none" });
    // Another repo's PR is its own: its #3 is open, the repo-less #3 merged.
    expect(conversationStage([pr(3, "example-org/Other-Repo")], stageOf)).toEqual({ stage: "open", pr: "Other-Repo#3" });
  });

  it("links its status's PR only when nothing it links has that number, since the status names no repo", () => {
    const links = { ids: [], prs: [{ repo: "example-org/Other-Repo", number: 3 }], chats: [] };
    expect(linkedPrs({ statusPr: 3 }, links)).toEqual(["example-org/Other-Repo#3"]);
    expect(linkedPrs({ statusPr: 1 }, links)).toEqual(["example-org/Other-Repo#3", "example-org/example-repo#1"]);
    expect(linkedPrs({}, { ...links, prs: [...links.prs, { repo: "example-org/other-repo", number: 3 }] })).toEqual(["example-org/Other-Repo#3"]);
    // A bare "#n" in a message: the linked PR with that number, else the PR GitHub shows with it, else a repo-less one.
    const said = (number: number) => ({ ...links, said: { refs: [{ repo: null, number }], namesChat: () => false } as never });
    expect(linkedPrs({}, said(3))).toEqual(["example-org/Other-Repo#3"]);
    const resolve = (number: number) => (number === 88 ? "example-org/other-repo#88" : undefined);
    expect(linkedPrs({}, said(88), resolve)).toEqual(["example-org/Other-Repo#3", "example-org/other-repo#88"]);
    expect(linkedPrs({}, said(89), resolve)).toEqual(["example-org/Other-Repo#3", "example-org/example-repo#89"]);
  });

  it("idle: no message for more than two hours, nor a Reopen since; never one waiting on you, pinned or marked unread", () => {
    const lastAt = "2026-10-10T00:00:00.000Z";
    const edge = Date.parse(lastAt) + IDLE_ARCHIVE_MS;
    const row = { lastAt, lastFrom: "owner" as const, lastAsks: false, closedAt: null, pinnedAt: null, unreadAt: null, sweptAt: null };
    const quiet = { needsYou: false };
    // Two hours to the millisecond is still active; one more and it is archived.
    expect(idle(quiet, row, edge)).toBe(false);
    expect(idle(quiet, row, edge + 1)).toBe(true);
    expect(idle({ needsYou: true }, row, edge + 24 * 60 * 60_000)).toBe(false);
    // Rivet's question as the last word waits on you past the three days Needs you shows it.
    expect(idle(quiet, { ...row, lastFrom: "rivet", lastAsks: true }, edge + 7 * 24 * 60 * 60_000)).toBe(false);
    expect(idle(quiet, { ...row, lastFrom: "owner", lastAsks: true }, edge + 1)).toBe(true);
    expect(idle(quiet, { ...row, pinnedAt: lastAt }, edge + 1)).toBe(false);
    expect(idle(quiet, { ...row, unreadAt: lastAt }, edge + 1)).toBe(false);
    // His Reopen an hour on counts as a message: two hours from it.
    const reopened = { ...row, sweptAt: "2026-10-10T01:00:00.000Z" };
    expect(idle(quiet, reopened, edge + 1)).toBe(false);
    expect(idle(quiet, reopened, edge + 60 * 60_000 + 1)).toBe(true);
    // The sweep's mark on one it closed is no Reopen.
    expect(idle(quiet, { ...reopened, closedAt: reopened.sweptAt }, edge + 1)).toBe(true);
  });

  it("the retired merged sweep's closures are no Close: the idle rule decides them, so one waiting on you are listed", () => {
    const lastAt = "2026-10-10T00:00:00.000Z";
    const swept = "2026-10-10T08:00:00.000Z";
    expect(isClosed({ lastAt, closedAt: swept, sweptAt: swept })).toBe(false);
    expect(isClosed({ lastAt, closedAt: swept, sweptAt: null })).toBe(true);
    // His Close after a Reopen stands.
    expect(isClosed({ lastAt, closedAt: "2026-10-10T09:00:00.000Z", sweptAt: swept })).toBe(true);
  });

  it("done stands until you write after it", () => {
    expect(isDone({ doneAt: null, lastOwnerAt: null })).toBe(false);
    expect(isDone({ doneAt: "2026-10-05T01:00:00.000Z", lastOwnerAt: "2026-10-05T00:59:00.000Z" })).toBe(true);
    expect(isDone({ doneAt: "2026-10-05T01:00:00.000Z", lastOwnerAt: null })).toBe(true);
    expect(isDone({ doneAt: "2026-10-05T01:00:00.000Z", lastOwnerAt: "2026-10-05T01:01:00.000Z" })).toBe(false);
  });

  it("carries each linked chat's repo; a name only said or its status's adds no repo-less ref beside a linked one", () => {
    const markets = "example-org/third-repo";
    const lastAt = "2026-10-10T00:00:00.000Z";
    const thread = { id: "t-lab", title: "Lab", status: null, statusFrom: null, statusChat: "lab", project: null, tag: null, ball: null, startedBy: "owner", count: 1, lastAt, lastFrom: "owner", lastText: "" } as never;
    const row = { closedAt: null, lastAt, sweptAt: null, unreadAt: null, pinnedAt: null, doneAt: null, lastOwnerAt: null } as never;
    const links = { ids: [], prs: [], chats: [{ repo: REPO, chat: "lab" }, { repo: markets, chat: "lab" }], said: { refs: [], words: new Set(["lab", "rates"]) } };
    const summary = conversationSummary(thread, row, links, 0);
    expect(summary.links.chats).toEqual(["lab", "rates"]);
    expect(summary.links.chatRefs).toEqual([{ chat: "lab", repo: REPO }, { chat: "lab", repo: markets }, { chat: "rates" }]);
    // A chat linked only in one repo is not another repo's chat of the name, said in words or not.
    const one = conversationSummary(thread, row, { ...links, chats: [{ repo: REPO, chat: "lab" }] }, 0);
    expect(one.links.chatRefs).toEqual([{ chat: "lab", repo: REPO }, { chat: "rates" }]);
    expect(linksChat(one.links, "lab", "example-org/side-app")).toBe(false);
    expect(linksChat(one.links, "lab", REPO.toLowerCase())).toBe(true);
    expect(linksChat(summary.links, "lab", markets)).toBe(true);
    // A repo-less ref matches by name in any repo; no repo given matches by name.
    expect(linksChat(one.links, "rates", markets)).toBe(true);
    expect(linksChat(one.links, "lab")).toBe(true);
    expect(linksChat(one.links, "lab", null)).toBe(true);
    expect(linksChat(one.links, "pond", markets)).toBe(false);
    // A summary from before chatRefs matches by name.
    expect(linksChat({ chats: ["lab"] }, "lab", markets)).toBe(true);
    // A chat both repos link keeps both refs however many other chats come between: never cut to one repo's.
    const many = [{ repo: REPO, chat: "lab" }, ...["a", "b", "c", "d", "e"].map((chat) => ({ repo: REPO, chat })), { repo: markets, chat: "lab" }];
    const long = conversationSummary({ ...(thread as object), statusChat: undefined } as never, row, { ...links, chats: many, said: { refs: [], words: new Set<string>() } }, 0);
    expect(long.links.chats).toEqual(["lab", "a", "b"]);
    expect(long.links.chatRefs).toEqual(many.map(({ repo, chat }) => ({ chat, repo })));
    // A chat past the shown three still opens its conversation, as the first refs kept it before.
    expect(linksChat(long.links, "d", REPO)).toBe(true);
    const longer = conversationSummary({ ...(thread as object), statusChat: undefined } as never, row, { ...links, chats: [...many.slice(0, 6), { repo: REPO, chat: "f" }, ...many.slice(6)], said: { refs: [], words: new Set<string>() } }, 0);
    expect(linksChat(longer.links, "f", REPO)).toBe(false);
    expect(linksChat(longer.links, "lab", markets)).toBe(true);
  });
});

describe("conversation routes", () => {
  let server: TestServer;
  let cookie: string;
  let clock: ReturnType<typeof fakeClock>;
  let seq = 0;

  beforeEach(async () => {
    clock = fakeClock(T0);
    server = await startServer({}, { now: clock.now });
    cookie = server.cookie();
  });

  afterEach(async () => {
    await server.close();
  });

  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = bearer(BOARD_TOKEN)) =>
    fetch(`${server.base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  async function owner(text: string, extra: { replyTo?: string; conversation?: string | null } = {}): Promise<string> {
    const response = await send("POST", "/api/chat", { clientId: `client-${(seq += 1)}`, text, ...extra }, browser(cookie));
    expect(response.status).toBe(202);
    return ((await response.json()) as { id: string }).id;
  }

  async function rivet(text: string, extra: { replyTo?: string; new?: true; title?: string } = {}): Promise<ChatMessage> {
    const response = await send("POST", "/api/bridge/say", { text, ...extra });
    expect(response.status).toBe(201);
    return (await response.json()) as ChatMessage;
  }

  async function list(query = ""): Promise<ConversationsResponse> {
    const response = await send("GET", `/api/conversations${query}`, undefined, { cookie });
    expect(response.status).toBe(200);
    const listed = (await response.json()) as ConversationsResponse;
    // Agent Chat is always listed (team.test.ts); these are about the rest.
    return { ...listed, conversations: listed.conversations.filter((row) => row.id !== TEAM_ROOM_ID) };
  }

  async function open(id: string): Promise<ConversationDetail> {
    const response = await send("GET", `/api/conversations/${id}`, undefined, { cookie });
    expect(response.status).toBe(200);
    return (await response.json()) as ConversationDetail;
  }

  const patch = (id: string, body: unknown) => send("PATCH", `/api/conversations/${id}`, body, browser(cookie));

  it("starts as a blank slate: nothing open, everything older and Updates under Archived, and an old one back on a new message", async () => {
    const old = await owner("Docs refresh: the crash sound is late");
    clock.advance(60_000);
    await owner("Night Batch results row");
    clock.advance(60_000);
    let page = await list();
    expect(page.conversations).toEqual([]);
    expect(page.older).toBe(3);
    const older = await list("?older=1&limit=2");
    expect(older.conversations.map((row) => row.title)).toEqual(["Updates", "Night Batch results row"]);
    expect(older.conversations[0]).toMatchObject({ id: UPDATES_ID, updates: true, unread: 0, closed: false });
    expect((await list(`?older=1&limit=2&before=${older.next}`)).conversations.map((row) => row.title)).toEqual(["Docs refresh: the crash sound is late"]);

    clock.advance(60_000);
    await rivet("Found it, the sample starts 480 ms in.", { replyTo: old });
    page = await list();
    expect(page.conversations.map((row) => row.id)).toEqual([old]);
    expect(page.conversations[0]).toMatchObject({ lastFrom: "rivet", lastText: "Found it, the sample starts 480 ms in.", unread: 1 });
    expect(page).toMatchObject({ older: 2, unread: 1 });
    // The board token reads it too (rivet conversation list).
    expect((await send("GET", "/api/conversations")).status).toBe(200);
  });

  it("Updates is only under Archived, read-only news: never in the open list, its unread not in the badge", async () => {
    await list();
    clock.advance(60_000);
    const mine = await owner("New one", { conversation: null });
    clock.advance(60_000);
    // Only a reply to an id the server does not know lands there now; a say replying to nothing is an update card.
    await rivet("Nightly: 6 PRs merged, main green", { replyTo: "not-a-message" });
    clock.advance(60_000);
    await rivet("On it.", { replyTo: mine });
    let page = await list();
    expect(page.conversations.map((row) => [row.id, row.unread])).toEqual([[mine, 1]]);
    expect(page.unread).toBe(1);
    const older = await list("?older=1");
    expect(older.conversations.map((row) => [row.id, row.unread])).toEqual([[UPDATES_ID, 1]]);
    // A newer message in Updates does not bring it back.
    clock.advance(60_000);
    await rivet("The build server is back.", { replyTo: "not-a-message" });
    page = await list();
    expect(page.conversations.map((row) => row.id)).toEqual([mine]);
    expect(page).toMatchObject({ unread: 1, older: 1 });
  });

  it("you typing in an open conversation joins it, a window holds one conversation, and a reply still leads its own", async () => {
    await list();
    const first = await owner("Docs refresh: the crash sound is late", { conversation: null });
    // Within the window but a new conversation: it never joins the window open before it.
    const other = await owner("Night Batch results row", { conversation: null });
    expect(other).not.toBe(first);
    const more = await owner("by half a second", { conversation: first });
    clock.advance(BATCH_QUIET_MS);
    const ski = await open(first);
    expect(ski.messages.map((message) => message.id)).toEqual([first, more]);
    expect((await open(other)).messages.map((message) => message.id)).toEqual([other]);
    expect(ski.conversation).toMatchObject({ title: "Docs refresh: the crash sound is late", lastFrom: "owner" });

    // Typed into a conversation by any message of it.
    const reply = await rivet("Fixing.", { replyTo: more });
    const typed = await owner("thanks", { conversation: reply.id });
    expect((await open(first)).messages.map((message) => message.id)).toEqual([first, more, reply.id, typed]);
    const answer = await owner("which sample?", { replyTo: reply.id, conversation: first });
    expect((await open(first)).messages.at(-1)!.id).toBe(answer);
    expect((await send("POST", "/api/chat", { clientId: "client-unknown", text: "x", conversation: "no-such" }, browser(cookie))).status).toBe(400);
  });

  it("Rivet's message lands by the id he quotes, or Updates; one replying to nothing is a Got it card; --new starts one", async () => {
    await list();
    const batch = await owner("Night Batch results row, PR #412", { conversation: null });
    clock.advance(BATCH_QUIET_MS);
    const card = async (text: string) => {
      const response = await send("POST", "/api/bridge/say", { text });
      expect(response.status).toBe(201);
      const { id } = (await response.json()) as { id: string };
      const board = (await (await send("GET", "/api/board")).json()) as { board: { needs: Record<string, unknown>[] } };
      return board.board.needs.find((need) => need.id === id)!;
    };
    // By what its text names: the PR, and the one conversation naming it; else none.
    expect(await card("#412 is green.\nAll checks passed.")).toMatchObject({ kind: "decision", title: "#412 is green.", ask: "All checks passed.", pr: 412, options: [{ label: "Got it" }], replyTo: batch });
    const notice = await card("The build server is back.");
    expect(notice).toMatchObject({ kind: "decision", title: "The build server is back.", options: [{ label: "Got it" }] });
    expect(notice.replyTo).toBeUndefined();
    // The card about its PR is shown in it; the one naming nothing is in none.
    expect((await open(batch)).messages.map((message) => message.posted?.title ?? message.text)).toEqual(["Night Batch results row, PR #412", "#412 is green."]);
    expect((await rivet("Late reply.", { replyTo: "not-a-message" })).threadId).toBe(UPDATES_ID);
    const started = await rivet("Six PRs merged overnight.", { new: true, title: "Nightly report 3 Oct" });
    expect(started.threadId).toBe(started.id);
    expect((await open(started.id)).conversation).toMatchObject({ title: "Nightly report 3 Oct", lastFrom: "rivet" });
    expect((await rivet("And main is green.", { replyTo: started.id })).threadId).toBe(started.id);
    expect((await send("POST", "/api/bridge/say", { text: "x", new: true, replyTo: batch })).status).toBe(400);
    expect((await send("POST", "/api/bridge/say", { text: "x", title: "no new" })).status).toBe(400);
    // Updates' root heads the conversation but is no message of today's flat chat.
    const flat = (await (await send("GET", "/api/chat?limit=50", undefined, { cookie })).json()) as { messages: { id: string }[] };
    expect(flat.messages.map((message) => message.id)).not.toContain(UPDATES_ID);
    expect((await open(UPDATES_ID)).messages[0]).toMatchObject({ id: UPDATES_ID, text: "Updates from Rivet" });
  });

  it("a reply that asks you something is a question card you type into, beside one line that opens it", async () => {
    await list();
    const asked = await owner("Make Docs Sync darker", { conversation: null });
    expect((await send("POST", "/api/asks", { id: "a-7", words: "Docs Sync darker", replyId: asked, stage: "building", prs: [4050] })).status).toBe(201);
    clock.advance(BATCH_QUIET_MS);
    const notify = vi.spyOn(server.app.push, "notify");
    const needs = vi.spyOn(server.app.push, "notifyNewNeeds");
    const line = await rivet("Same on the lobby tile?", { replyTo: asked });
    expect(line).toMatchObject({ from: "rivet", text: "Card: Same on the lobby tile? ›", replyTo: asked, threadId: asked });
    const board = (await (await send("GET", "/api/board")).json()) as { board: { needs: Record<string, unknown>[] } };
    const card = board.board.needs.find((need) => need.id === line.card)!;
    expect(card).toMatchObject({ kind: "question", title: "Same on the lobby tile?" });
    // No PR, repo or chat: his answer comes back here by the line, never to the ask's PR or another conversation on it.
    for (const key of ["pr", "repo", "chat", "thread"]) expect(card[key]).toBeUndefined();
    expect(wantsText(card as never)).toBe(true);
    // The card's push, not a chat push; the line is no unread word.
    expect(notify).not.toHaveBeenCalled();
    expect(needs).toHaveBeenCalledWith([expect.objectContaining({ id: line.card, kind: "question" })], expect.any(Function));
    notify.mockRestore();
    needs.mockRestore();
    expect((await open(asked)).conversation.unread).toBe(0);
    // The conversation waits on you until you answer the card, and your typed answer lands in it.
    expect((await list()).conversations.find((row) => row.id === asked)).toMatchObject({ needsYou: true });
    const rev = await revOf(server.base, cookie, line.card!);
    const answered = await send("POST", "/api/replies", { clientId: "reply-0002", itemId: line.card, decision: "comment", rev, text: "Yes, the tile too" }, browser(cookie));
    expect(answered.status).toBe(201);
    expect((await open(asked)).messages.at(-1)).toMatchObject({ from: "owner", card: line.card, threadId: asked });
    expect((await list()).conversations.find((row) => row.id === asked)).toMatchObject({ needsYou: false });
    // A statement, a photo and a new conversation stay words in Chat.
    expect((await rivet("Done, the lobby tile is darker too.", { replyTo: asked })).card).toBeUndefined();
    expect((await rivet("Nightly: all green?", { new: true })).card).toBeUndefined();
  });

  it("a question stays words when the board has no room for its card", async () => {
    await list();
    const asked = await owner("Make Docs Sync darker", { conversation: null });
    const needs = Array.from({ length: MAX_CARDS }, (_, n) => ({ id: `q-${n}`, kind: "question", title: `Question ${n}?` }));
    expect((await send("PUT", "/api/board", { ...REPLY_BOARD, needs })).status).toBe(200);
    clock.advance(BATCH_QUIET_MS);
    const said = await rivet("Same on the lobby tile?", { replyTo: asked });
    expect(said).toMatchObject({ text: "Same on the lobby tile?", replyTo: asked });
    expect(said.card).toBeUndefined();
  });

  it("--card --pr names the outcome card's PR over the ask's own, so its yes is that PR's decision of record", async () => {
    await list();
    const asked = await owner("Make Docs Sync darker", { conversation: null });
    await rivet("On it.", { replyTo: asked });
    expect((await send("POST", "/api/asks", { id: "a-pr", words: "Docs Sync darker", replyId: asked, stage: "building", prs: [4050] })).status).toBe(201);
    clock.advance(60_000);
    const card = async (body: Record<string, unknown>) => {
      const line = (await (await send("POST", "/api/bridge/say", { text: "Docs Sync: the video", replyTo: asked, card: true, ...body })).json()) as ChatMessage;
      const board = (await (await send("GET", "/api/board")).json()) as { board: { needs: Record<string, unknown>[] } };
      return board.board.needs.find((need) => need.id === line.card);
    };
    expect(await card({ pr: 4051, repo: "example-org/third-repo" })).toMatchObject({ kind: "decision", pr: 4051, repo: "example-org/third-repo" });
    const plain = await card({ pr: 4052 });
    expect(plain).toMatchObject({ kind: "decision", pr: 4052 });
    expect(plain?.repo).toBeUndefined();
    expect(await card({})).toMatchObject({ pr: 4050 });
  });

  it("--card answers an ask with an outcome card in Needs you, Yes, keep it or Change it, and one line that opens it", async () => {
    await list();
    const asked = await owner("Make Docs Sync darker", { conversation: null });
    const ack = await rivet("On it.", { replyTo: asked });
    expect((await send("POST", "/api/asks", { id: "a-5", words: "Docs Sync darker", replyId: asked, stage: "building", prs: [4050] })).status).toBe(201);
    expect((await send("PUT", "/api/board", { ...REPLY_BOARD, coming: [{ pr: 4050, title: "Docs Sync look", app: "Docs Sync" }] })).status).toBe(200);
    clock.advance(60_000);
    const notify = vi.spyOn(server.app.push, "notify");
    const response = await send("POST", "/api/bridge/say", { text: "Docs Sync deployed\nDarker blacks, less glow.", replyTo: asked, card: true, tag: "Deployed" });
    expect(response.status).toBe(201);
    const line = (await response.json()) as ChatMessage;
    expect(line).toMatchObject({ from: "rivet", text: "Card: Docs Sync deployed ›", replyTo: asked, threadId: asked });
    expect(line.card).toMatch(/^out-/);
    const board = (await (await send("GET", "/api/board")).json()) as { board: { needs: Record<string, unknown>[] } };
    const outcome = board.board.needs.find((need) => need.id === line.card);
    expect(outcome).toMatchObject({ kind: "decision", title: "Docs Sync deployed", ask: "Darker blacks, less glow.", pr: 4050, options: [{ label: "Yes, keep it" }, { label: "Change it", text: true }] });
    // An outcome stacks in no pile: the tag a caller sent is dropped.
    expect(outcome?.tag).toBeUndefined();
    expect(outcome?.thread).toBeUndefined();
    // The board refuses an update card answering his message, and names the fix.
    const refused = await send("PUT", "/api/board/needs/upd-docs-sync?create=only", { kind: "update", title: "Docs Sync deployed", replyTo: asked });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/Finished work takes no card.*rivet ask close.*What you must confirm goes as a decision card/);
    // One line in the conversation; the card's push, not a chat push.
    expect((await open(asked)).messages.map((message) => message.id)).toEqual([asked, ack.id, line.id]);
    // Only Rivet's words count as unread: "On it." does, the "Card: … ›" line never does.
    expect((await open(asked)).conversation.unread).toBe(1);
    expect(notify).not.toHaveBeenCalled();
    notify.mockRestore();

    // A newer ask in the same conversation: a say naming the older one goes in the older one's conversation, with its PR.
    expect((await send("POST", "/api/asks", { id: "a-6", words: "Lobby badge", replyId: ack.id, stage: "building", prs: [4060] })).status).toBe(201);
    clock.advance(60_000);
    const named = (await (await send("POST", "/api/bridge/say", { text: "a-5 checked on the phone" })).json()) as { card: string };
    const named_board = (await (await send("GET", "/api/board")).json()) as { board: { needs: Record<string, unknown>[] } };
    expect(named_board.board.needs.find((need) => need.id === named.card)).toMatchObject({ pr: 4050, replyTo: asked });

    // No ask: the conversation's title is the thread; any message of it finds it.
    const other = await owner("Lobby tiles", { conversation: null });
    clock.advance(BATCH_QUIET_MS);
    const reply = await rivet("Looking.", { replyTo: other });
    const second = (await (await send("POST", "/api/bridge/say", { text: "Tiles fixed", replyTo: reply.id, card: true })).json()) as ChatMessage;
    expect(second).toMatchObject({ text: "Card: Tiles fixed ›", threadId: other });
    const after = (await (await send("GET", "/api/board")).json()) as { board: { needs: Record<string, unknown>[] } };
    expect(after.board.needs.find((need) => need.id === second.card)).toMatchObject({ kind: "decision", title: "Tiles fixed" });
  });

  it("renames, closes and reopens on a new message; Updates cannot be closed; only your session changes them", async () => {
    await list();
    const id = await owner("Docs refresh crash sound", { conversation: null });
    expect((await patch(id, { title: "Docs refresh audio" })).status).toBe(200);
    expect((await open(id)).conversation.title).toBe("Docs refresh audio");
    // Rivet's own title does not beat your rename.
    expect((await send("PATCH", `/api/threads/${id}`, { title: "Rivet's name" })).status).toBe(200);
    expect((await open(id)).title).toBe("Docs refresh audio");
    expect((await patch(id, { title: null })).status).toBe(200);
    expect((await open(id)).title).toBe("Rivet's name");

    clock.advance(60_000);
    expect((await patch(id, { closed: true })).status).toBe(200);
    let page = await list();
    expect(page.conversations).toEqual([]);
    expect((await list("?older=1")).conversations[0]).toMatchObject({ id, closed: true });
    clock.advance(60_000);
    await rivet("Fixed, live now.", { replyTo: id });
    page = await list();
    expect(page.conversations.map((row) => row.id)).toEqual([id]);
    expect(page.conversations[0]!.closed).toBe(false);

    expect((await patch(UPDATES_ID, { closed: true })).status).toBe(409);
    expect((await patch(id, {})).status).toBe(400);
    expect((await patch(id, { read: "not-in-it" })).status).toBe(400);
    expect((await send("PATCH", `/api/conversations/${id}`, { closed: true })).status).toBe(403);
    expect((await send("PATCH", `/api/conversations/${id}`, { closed: true }, { cookie, "content-type": "application/json" })).status).toBe(403);
  });

  it("a closed conversation never shows Needs you, even with Rivet's question as its last word", async () => {
    await list();
    const id = await owner("Docs refresh crash sound", { conversation: null });
    clock.advance(60_000);
    await rivet("Shall I mute it?", { replyTo: id });
    expect((await list()).conversations.find((row) => row.id === id)).toMatchObject({ needsYou: true, closed: false });
    clock.advance(60_000);
    expect((await patch(id, { closed: true })).status).toBe(200);
    expect((await list("?older=1")).conversations.find((row) => row.id === id)).toMatchObject({ needsYou: false, closed: true });
  });

  it("pages a long conversation back from a message of it", async () => {
    await list();
    const id = await owner("Long one", { conversation: null });
    const said: string[] = [];
    for (let n = 0; n < THREAD_MESSAGES_MAX + 5; n += 1) said.push((await rivet(`Line ${n}`, { replyTo: id })).id);
    const opened = await open(id);
    expect(opened.messages).toHaveLength(THREAD_MESSAGES_MAX);
    expect(opened).toMatchObject({ more: true });
    expect(opened.messages[0]!.id).toBe(said[5]);
    const earlier = await send("GET", `/api/conversations/${said[300]}?before=${said[5]}`, undefined, { cookie });
    expect(earlier.status).toBe(200);
    const page = (await earlier.json()) as ConversationPage;
    expect(page.messages.map((message) => message.id)).toEqual([id, ...said.slice(0, 5)]);
    expect(page.more).toBe(false);
    const tail = (await (await send("GET", `/api/conversations/${id}?before=${said[2]}`, undefined, { cookie })).json()) as ConversationPage;
    expect(tail).toEqual({ messages: [expect.objectContaining({ id }), expect.objectContaining({ id: said[0] }), expect.objectContaining({ id: said[1] })], more: false });

    clock.advance(BATCH_QUIET_MS + 1000);
    const other = await owner("Another", { conversation: null });
    expect((await send("GET", `/api/conversations/${id}?before=${other}`, undefined, { cookie })).status).toBe(400);
    expect((await send("GET", `/api/conversations/${id}?before=no%20such`, undefined, { cookie })).status).toBe(400);
    expect((await send("GET", `/api/conversations/gone?before=${id}`, undefined, { cookie })).status).toBe(404);
  });

  it("reads up to a message and never back", async () => {
    await list();
    const id = await owner("Docs refresh", { conversation: null });
    clock.advance(60_000);
    const first = await rivet("One.", { replyTo: id });
    clock.advance(60_000);
    await rivet("Two.", { replyTo: id });
    expect((await open(id)).conversation.unread).toBe(2);
    expect((await patch(id, { read: first.id })).status).toBe(200);
    expect((await open(id)).conversation.unread).toBe(1);
    expect((await patch(id, { read: true })).status).toBe(200);
    expect((await patch(id, { read: first.id })).status).toBe(200);
    expect((await open(id)).conversation.unread).toBe(0);
  });

  it("a card answer is your message with the reply's id in the card's conversation, or starts one titled after the card", async () => {
    await list();
    const id = await owner("Approve the touch guard", { conversation: null });
    expect((await send("PATCH", `/api/threads/${id}`, { steps: [{ kind: "pr", label: "PR #105" }] })).status).toBe(200);
    clock.advance(BATCH_QUIET_MS);
    expect((await send("PUT", "/api/board", REPLY_BOARD)).status).toBe(200);
    const notify = vi.spyOn(server.app.push, "notify");
    const rev = await revOf(server.base, cookie, "pr105-touch");
    const answered = await send("POST", "/api/replies", { clientId: "reply-0001", itemId: "pr105-touch", decision: "approve", rev, text: "ship it" }, browser(cookie));
    expect(answered.status).toBe(201);
    const reply = (await answered.json()) as { id: string };
    const detail = await open(id);
    expect(detail.messages.at(-1)).toMatchObject({ id: reply.id, from: "owner", text: "Approved: Touch action guard\nship it", card: "pr105-touch", threadId: id });
    expect(notify).not.toHaveBeenCalled();
    // Rivet's follow-up by the reply id lands beside it.
    expect((await rivet("Merged and live.", { replyTo: reply.id })).threadId).toBe(id);
    // The attachments route still finds the reply behind that id.
    expect((await send("GET", `/api/board/attachments/${reply.id}`)).status).toBe(200);

    const capRev = await revOf(server.base, cookie, "billing-cap");
    const capped = await send("POST", "/api/replies", { clientId: "reply-0002", itemId: "billing-cap", decision: "reject", text: "Lower the cap", rev: capRev }, browser(cookie));
    expect(capped.status).toBe(201);
    const capReply = (await capped.json()) as { id: string };
    const started = await open(capReply.id);
    expect(started).toMatchObject({ id: capReply.id, title: "Billing cap" });
    expect(started.messages.map((message) => message.text)).toEqual(["Rejected: fix and resubmit\nLower the cap"]);
    notify.mockRestore();
  });

  it("a card's owner by what it names keeps it once answered; Updates owns none; a card answered again, a retry", async () => {
    await list();
    expect((await rivet("#105 needs review.", { replyTo: "not-a-message" })).threadId).toBe(UPDATES_ID);
    expect((await send("PUT", "/api/board", REPLY_BOARD)).status).toBe(200);
    const cardThreads = async () => ((await (await send("GET", "/api/card-threads", undefined, { cookie })).json()) as CardThreadsResponse).cards;
    expect((await cardThreads()).map((card) => card.thread)).not.toContain(UPDATES_ID);
    const answer = async (clientId: string, itemId: string, decision: string) => {
      const response = await send("POST", "/api/replies", { clientId, itemId, decision, ...(decision === "reject" ? { text: "Not yet" } : {}), rev: await revOf(server.base, cookie, itemId) }, browser(cookie));
      expect(response.status).toBe(201);
      return ((await response.json()) as { id: string }).id;
    };

    // Owned only by what its messages name (no ask, no step, GitHub's list empty): still its owner once answered.
    const id = await owner("Is #105 ready?", { conversation: null });
    clock.advance(BATCH_QUIET_MS);
    expect((await cardThreads()).find((card) => card.card === "pr105-touch")?.thread).toBe(id);
    const touch = await answer("reply-0001", "pr105-touch", "approve");
    expect((await open(id)).messages.at(-1)).toMatchObject({ id: touch, card: "pr105-touch" });

    // Answered again at a new rev, in the same conversation; a retried answer adds nothing.
    const first = await answer("reply-0003", "billing-cap", "reject");
    const reissued = REPLY_BOARD.needs.map((need) => (need.id === "billing-cap" ? { ...need, ask: "Cap lowered, approve?" } : need));
    expect((await send("PUT", "/api/board", { ...REPLY_BOARD, needs: reissued })).status).toBe(200);
    const again = await answer("reply-0004", "billing-cap", "reject");
    const capped = await open(first);
    expect(capped.messages.map((message) => message.id)).toEqual([first, again]);
    const retried = await send("POST", "/api/replies", { clientId: "reply-0004", itemId: "billing-cap", decision: "reject", text: "Not yet", rev: await revOf(server.base, cookie, "billing-cap") }, browser(cookie));
    expect(retried.status).toBe(200);
    expect((await open(first)).messages.map((message) => message.id)).toEqual([first, again]);
  });

  it("pushes per conversation: its title, tag and path; Updates quiet unless Rivet asks", async () => {
    await list();
    const id = await owner("Night Batch results row", { conversation: null });
    const notify = vi.spyOn(server.app.push, "notify");
    const said = await rivet("Stills attached, ready for your OK", { replyTo: id });
    const payload = rivetPayload("Stills attached, ready for your OK", { id, title: "Night Batch results row" });
    expect(notify).toHaveBeenCalledWith(payload, "card", `rivet:${said.id}`);
    expect(payload).toMatchObject({ title: "Night Batch results row", tag: `conv-${id}`, path: `/?conversation=${id}`, conversation: id, chat: id });
    expect(payload.level).toBeUndefined();
    expect(rivetPayload("Nightly: green", { id: UPDATES_ID, title: "Updates" }).level).toBe("fyi");
    expect(rivetPayload("Shall I restart the workers?", { id: UPDATES_ID, title: "Updates" }).level).toBeUndefined();
    notify.mockRestore();
  });

  it("marks one unread with a dot, reading it clears it, Mark all as read clears every count and dot; the badge counts Chat once", async () => {
    await list();
    const a = await owner("Docs refresh", { conversation: null });
    clock.advance(BATCH_QUIET_MS + 1000);
    const b = await owner("Night Batch", { conversation: null });
    clock.advance(60_000);
    await rivet("On it.", { replyTo: a });
    // Updates' news is not in the badge.
    await rivet("Nightly: green", { replyTo: "not-a-message" });
    let page = await list();
    expect(page.unread).toBe(1);
    expect((await patch(b, { unread: true })).status).toBe(200);
    page = await list();
    expect(page.conversations.find((row) => row.id === b)).toMatchObject({ unread: 0, markedUnread: true });
    // Both are Chat's: the badge counts Chat once.
    expect(page.unread).toBe(1);
    // Reading clears the dot as well as the count.
    expect((await patch(b, { read: true })).status).toBe(200);
    expect((await open(b)).conversation).toMatchObject({ unread: 0, markedUnread: false });
    expect((await patch(b, { unread: true })).status).toBe(200);
    expect((await patch(b, { unread: false })).status).toBe(200);
    expect((await open(b)).conversation.markedUnread).toBe(false);
    expect((await patch(b, { read: true, unread: true })).status).toBe(400);

    expect((await patch(b, { unread: true })).status).toBe(200);
    const all = await send("POST", "/api/conversations/read", {}, browser(cookie));
    expect(all.status).toBe(200);
    // The two, and Agent Chat's read marker the first time.
    expect(await all.json()).toEqual({ read: 3 });
    page = await list();
    expect(page.unread).toBe(0);
    expect(page.conversations.every((row) => row.unread === 0 && !row.markedUnread)).toBe(true);
    // Updates is not in the list it reads.
    expect((await list("?older=1")).conversations.find((row) => row.id === UPDATES_ID)).toMatchObject({ unread: 1 });
    // Only your session marks all read; the read state is the server's, so another device sees it.
    expect((await send("POST", "/api/conversations/read", {})).status).toBe(403);
    expect((await (await send("POST", "/api/conversations/read", {}, browser(cookie))).json())).toEqual({ read: 0 });
  });

  it("pins to the top, above newer ones; a pinned one before the cutover stays listed until closed", async () => {
    const old = await owner("From before the list");
    clock.advance(60_000);
    await list();
    const a = await owner("Docs refresh", { conversation: null });
    clock.advance(BATCH_QUIET_MS + 1000);
    const b = await owner("Night Batch", { conversation: null });
    clock.advance(60_000);
    await rivet("Nightly: green");
    expect((await list()).conversations.map((row) => row.id)).toEqual([b, a]);
    expect((await patch(a, { pinned: true })).status).toBe(200);
    expect((await patch(old, { pinned: true })).status).toBe(200);
    let page = await list();
    expect(page.conversations.map((row) => [row.id, row.pinned])).toEqual([
      [a, true],
      [old, true],
      [b, false],
    ]);
    expect((await patch(old, { closed: true })).status).toBe(200);
    expect((await patch(a, { pinned: false })).status).toBe(200);
    page = await list();
    expect(page.conversations.map((row) => row.id)).toEqual([b, a]);
    // Closing put its pin away; marking it unread from Archived brings it back, dot and badge.
    expect((await open(old)).conversation).toMatchObject({ closed: true, pinned: false });
    const before = page.unread;
    expect((await patch(old, { unread: true })).status).toBe(200);
    page = await list();
    expect(page.conversations.find((row) => row.id === old)).toMatchObject({ closed: false, markedUnread: true });
    expect(page.unread).toBe(before + 1);
    // So does pinning it; closing it again takes both away, and it cannot be closed and pinned at once.
    expect((await patch(old, { closed: true })).status).toBe(200);
    expect((await patch(old, { pinned: true })).status).toBe(200);
    expect((await list()).conversations[0]).toMatchObject({ id: old, pinned: true, closed: false });
    expect((await patch(old, { closed: true, pinned: true })).status).toBe(400);
  });

  it("Rivet marks one done with the board token until you write in it; your session cannot, nor Updates", async () => {
    await list();
    const id = await owner("Bottom bar", { conversation: null });
    clock.advance(60_000);
    const said = await rivet("Merged and deployed.", { replyTo: id });
    const done = await send("PATCH", `/api/conversations/${said.id}`, { done: true });
    expect(done.status).toBe(200);
    expect(((await done.json()) as ConversationDetail).conversation.done).toBe(true);
    // Rivet's own follow-up keeps the tick.
    clock.advance(60_000);
    await rivet("Verified on the site.", { replyTo: id });
    expect((await open(id)).conversation.done).toBe(true);
    expect((await send("PATCH", `/api/conversations/${id}`, { done: false })).status).toBe(200);
    expect((await open(id)).conversation.done).toBe(false);
    expect((await send("PATCH", `/api/conversations/${id}`, { done: true })).status).toBe(200);
    clock.advance(BATCH_QUIET_MS + 1000);
    await owner("One more thing", { conversation: id });
    expect((await open(id)).conversation.done).toBe(false);

    expect((await send("PATCH", `/api/conversations/${id}`, { done: true, closed: true })).status).toBe(403);
    expect((await send("PATCH", `/api/conversations/${id}`, { pinned: true })).status).toBe(403);
    expect((await patch(id, { done: true })).status).toBe(400);
    expect((await send("PATCH", `/api/conversations/${UPDATES_ID}`, { done: true })).status).toBe(409);
  });

  /** #103 recorded merged, as the hourly record keeps a PR's last stage. */
  async function recordMerged(): Promise<void> {
    const { createRequire } = await import("node:module");
    const { dirname, join } = await import("node:path");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(join(dirname(server.webRoot), "data", "rivet.sqlite"));
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("INSERT OR REPLACE INTO pr_stages (pr, stage, at) VALUES (?, 'merged', ?)").run(`${REPO}#103`, clock.now().toISOString());
    db.close();
  }

  const linkPr = async (id: string, number: number) =>
    expect(
      (await send("PATCH", `/api/threads/${id}`, { steps: [{ kind: "pr", label: `PR #${number}`, url: `https://github.com/${REPO}/pull/${number}` }] })).status,
    ).toBe(200);

  it("a merged conversation waiting on you stays listed however quiet; nothing closes it", async () => {
    await recordMerged();
    await list();
    const merged = await owner("Docs Sync portals", { conversation: null });
    await linkPr(merged, 103);
    clock.advance(BATCH_QUIET_MS);
    await rivet("Merged. Shall I deploy it?", { replyTo: merged });
    clock.advance(9 * 60 * 60_000);
    expect((await list()).conversations.find((row) => row.id === merged)).toMatchObject({ stage: "merged", needsYou: true, closed: false });
    expect((await open(merged)).conversation.closed).toBe(false);

    // One the retired sweep closed before this shipped (closed_at and swept_at alike) is listed again.
    const { createRequire } = await import("node:module");
    const { dirname, join } = await import("node:path");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(join(dirname(server.webRoot), "data", "rivet.sqlite"));
    const at = clock.now().toISOString();
    db.prepare("UPDATE chat_threads SET closed_at = ?, swept_at = ? WHERE root_id = ?").run(at, at, merged);
    db.close();
    expect((await list()).conversations.find((row) => row.id === merged)).toMatchObject({ needsYou: true, closed: false });
  });

  it("never archives one waiting on you beyond its status: a question card under a later line, an older ask, one from before the list", async () => {
    // Its last message comes before the first list read, so before the cutover.
    const early = await owner("Night Batch reels", { conversation: null });
    clock.advance(BATCH_QUIET_MS + 1000);
    await list();
    const carded = await owner("Lobby tile colours", { conversation: null });
    clock.advance(BATCH_QUIET_MS + 1000);
    // Rivet's question card, then a plain line: the line is the last word, the card still waits for his answer.
    await rivet("Same on the Docs Sync tile?", { replyTo: carded });
    await rivet("Build is green.", { replyTo: carded });
    // As one filed before cards were (2026-10-09): only its card line shows it in the conversation.
    const legacy = await owner("Log Viewer reels", { conversation: null });
    clock.advance(BATCH_QUIET_MS + 1000);
    await rivet("Same on the bonus reel?", { replyTo: legacy });
    await rivet("Reels are in.", { replyTo: legacy });
    const { createRequire } = await import("node:module");
    const { dirname, join } = await import("node:path");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(join(dirname(server.webRoot), "data", "rivet.sqlite"));
    expect(db.prepare("DELETE FROM card_conversations WHERE thread IN (SELECT id FROM chat_messages WHERE COALESCE(thread_id, id) = ?)").run(legacy).changes).toBe(1);
    db.close();
    const asked = await owner("Data Import rates", { conversation: null });
    clock.advance(BATCH_QUIET_MS + 1000);
    // An ask awaiting him, then a newer one in its chat: the status reads the newer.
    expect((await send("POST", "/api/asks", { id: "a-21", words: "Data Import rates", replyId: asked, stage: "needs-you" })).status).toBe(201);
    clock.advance(1000);
    expect((await send("POST", "/api/asks", { id: "a-22", words: "Data Import copy", replyId: asked, stage: "building" })).status).toBe(201);
    expect((await send("POST", "/api/asks", { id: "a-23", words: "Night Batch reels", replyId: early, stage: "needs-you" })).status).toBe(201);
    const quiet = await owner("Kiosk names", { conversation: null });

    clock.advance(3 * IDLE_ARCHIVE_MS);
    const ids = (await list()).conversations.map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([carded, legacy, asked, early]));
    expect(ids).not.toContain(quiet);
    // Once he writes after the ask, it is no longer waiting: two hours on, it is archived.
    await owner("Leave the rates", { conversation: asked });
    clock.advance(IDLE_ARCHIVE_MS + 1);
    expect((await list()).conversations.map((row) => row.id)).not.toContain(asked);
  });

  it("archives one idle more than two hours, brings it back on any new message or Reopen, and never one waiting on you", async () => {
    await list();
    const quiet = await owner("Night Batch results row", { conversation: null });
    clock.advance(BATCH_QUIET_MS + 1000);
    const asked = await owner("Make Docs Sync darker", { conversation: null });
    expect((await send("POST", "/api/asks", { id: "a-9", words: "Docs Sync darker", replyId: asked, stage: "building", prs: [4050] })).status).toBe(201);
    clock.advance(BATCH_QUIET_MS);
    // A question card in it: you have the ball.
    const card = await rivet("Same on the lobby tile?", { replyTo: asked });
    const ids = async () => (await list()).conversations.map((row) => row.id);
    const archived = async () => (await list("?older=1")).conversations.find((row) => row.id === quiet);

    // Two hours to the millisecond after its last message it is listed; a millisecond more and it is under Archived.
    clock.advance(IDLE_ARCHIVE_MS - (BATCH_QUIET_MS + 1000) - BATCH_QUIET_MS);
    expect(await ids()).toEqual([asked, quiet]);
    clock.advance(1);
    const page = await list();
    expect(page.conversations.map((row) => row.id)).toEqual([asked]);
    expect(page.older).toBe(2);
    expect(await archived()).toMatchObject({ closed: true });
    expect((await open(quiet)).conversation.closed).toBe(true);

    // Waiting on you, it stays whatever its age.
    clock.advance(3 * IDLE_ARCHIVE_MS);
    expect((await list()).conversations.find((row) => row.id === asked)).toMatchObject({ needsYou: true });

    // Rivet's message brings it back at once; idle two hours more, it goes again.
    await rivet("Found it, the row was cut at 412.", { replyTo: quiet });
    expect(await ids()).toEqual([quiet, asked]);
    clock.advance(IDLE_ARCHIVE_MS + 1);
    expect(await ids()).toEqual([asked]);
    // So does your.
    await owner("Thanks", { conversation: quiet });
    expect(await ids()).toEqual([quiet, asked]);
    clock.advance(IDLE_ARCHIVE_MS + 1);
    // ...and his Reopen, for two hours.
    expect(await ids()).toEqual([asked]);
    expect((await patch(quiet, { closed: false })).status).toBe(200);
    expect(await ids()).toContain(quiet);
    clock.advance(IDLE_ARCHIVE_MS);
    expect(await ids()).toContain(quiet);
    clock.advance(1);
    expect(await ids()).not.toContain(quiet);

    // His card answer is a message in it: listed, and no longer waiting on him, so it ages like any other.
    const rev = await revOf(server.base, cookie, card.card!);
    expect((await send("POST", "/api/replies", { clientId: "reply-0009", itemId: card.card, decision: "comment", rev, text: "Yes" }, browser(cookie))).status).toBe(201);
    expect((await list()).conversations.find((row) => row.id === asked)).toMatchObject({ needsYou: false, lastText: "Comment: Yes" });

    // Rivet's plain question as the last word stays listed too, past the three days Needs you shows it.
    const question = (await rivet("Nightly: all green, shall I tidy the old branches?", { new: true })).threadId ?? null;
    expect(question).not.toBeNull();
    clock.advance(4 * 24 * 60 * 60_000);
    expect(await ids()).toContain(question);
    expect(await ids()).not.toContain(quiet);
  });

  const batch = (body: unknown, headers: Record<string, string> = browser(cookie)) => send("POST", "/api/conversations/batch", body, headers);

  it.each([
    ["single", true],
    ["batch", true],
    ["single", false],
    ["batch", false],
  ] as const)("%s Reopen lists a pre-cutover conversation (explicitly closed: %s) for two hours", async (mode, closed) => {
    const old = await owner("Old merged work", { conversation: null });
    clock.advance(60_000);
    await list();
    await recordMerged();
    await linkPr(old, 103);
    if (closed) expect((await patch(old, { closed: true })).status).toBe(200);
    clock.advance(4 * IDLE_ARCHIVE_MS);
    expect((await list()).conversations.map((row) => row.id)).not.toContain(old);
    // Both the Older row menu and the detail menu consume this flag to offer Reopen, including untouched rows.
    expect((await list("?older=1")).conversations.find((row) => row.id === old)).toMatchObject({ closed: true });
    expect((await open(old)).conversation).toMatchObject({ closed: true });

    const response = mode === "single" ? await patch(old, { closed: false }) : await batch({ ids: [old], action: "reopen" });
    expect(response.status).toBe(200);
    if (mode === "batch") expect(await response.json()).toEqual({ changed: 1 });
    for (let poll = 0; poll < 2; poll += 1) {
      clock.advance(60_000);
      expect((await list()).conversations.find((row) => row.id === old)).toMatchObject({ closed: false, pinned: false, markedUnread: false, stage: "merged" });
      expect((await list("?older=1")).conversations.map((row) => row.id)).not.toContain(old);
    }
    expect((await patch(old, { closed: true })).status).toBe(200);
    expect((await list()).conversations.map((row) => row.id)).not.toContain(old);
    expect((await list("?older=1")).conversations.find((row) => row.id === old)).toMatchObject({ closed: true });
  });

  it("one conversation per thing: a card carries its ask's conversation, a follow-up card joins by stem or PR, and a merge moves the rest", async () => {
    await list();
    const ask = await owner("Lobby packages, the Apple way", { conversation: null });
    clock.advance(BATCH_QUIET_MS);
    await rivet("On it.", { replyTo: ask });
    const card = (id: string, extra: Record<string, unknown> = {}) => send("PUT", `/api/board/needs/${id}`, { kind: "decision", title: `Card ${id}`, ask: "Pick one\nmore", ...extra });
    const filed = async (id: string) => ((await (await send("GET", `/api/card-conversations/${id}`)).json()) as { conversation: { id: string; via: string } | null }).conversation;
    expect((await card("signup-forms-4861", { replyTo: ask, pr: 4861 })).status).toBe(200);
    // Cards made from it with no link: the stem files one beside it, the PR the other.
    expect((await card("signup-forms-v2-4861")).status).toBe(200);
    expect((await card("signup-forms-walkthrough-4861", { pr: 4861 })).status).toBe(200);
    expect(await filed("signup-forms-4861")).toMatchObject({ id: ask, via: "reply-to" });
    expect(await filed("signup-forms-v2-4861")).toMatchObject({ id: ask, via: "stem" });
    expect(await filed("signup-forms-walkthrough-4861")).toMatchObject({ id: ask, via: "pr" });
    // A malformed escape is an unknown card, not a server fault.
    expect((await send("GET", "/api/card-conversations/%E0")).status).toBe(404);
    const detail = await open(ask);
    expect(detail.messages.map((message) => message.posted?.id ?? message.text)).toEqual([
      "Lobby packages, the Apple way",
      "On it.",
      "signup-forms-4861",
      "signup-forms-v2-4861",
      "signup-forms-walkthrough-4861",
    ]);
    expect(detail.messages[2]).toMatchObject({ from: "rivet", text: "Card signup-forms-4861", posted: { id: "signup-forms-4861", kind: "decision", title: "Card signup-forms-4861", ask: "Pick one" } });
    // Its unanswered cards are your ball: the row waits on you.
    expect((await list()).conversations.find((row) => row.id === ask)).toMatchObject({ needsYou: true, phase: "waiting", thing: true });
    // Chat's timeline holds the ask up to the line that put its first card there; what follows is on the thing's page.
    const timeline = (await (await send("GET", "/api/chat?chat=1", undefined, browser(cookie))).json()) as { messages: ChatMessage[] };
    expect(timeline.messages.filter((message) => message.threadId === ask || message.id === ask).map((message) => message.posted?.id ?? message.text)).toEqual([
      "Lobby packages, the Apple way",
      "On it.",
      "signup-forms-4861",
    ]);
    // Rewriting the board posts nothing twice.
    expect((await card("signup-forms-v2-4861", { ask: "Pick one, again" })).status).toBe(200);
    expect((await open(ask)).messages).toHaveLength(5);
    // His answer and Rivet's reply to it land there too.
    const rev = await revOf(server.base, cookie, "signup-forms-v2-4861");
    const answered = await send("POST", "/api/replies", { clientId: "reply-0101", itemId: "signup-forms-v2-4861", decision: "comment", rev, text: "add a share button" }, browser(cookie));
    expect(answered.status).toBe(201);
    const reply = (await answered.json()) as { id: string };
    expect((await open(reply.id)).id).toBe(ask);
    expect((await rivet("Share button added.", { replyTo: reply.id })).threadId).toBe(ask);

    // A card nothing matches joins none (the CLI says so), and its answer starts one, as before.
    expect((await card("kids-cooking-concepts")).status).toBe(200);
    expect(await filed("kids-cooking-concepts")).toBeNull();
    const other = await owner("Kids cooking app: three directions", { conversation: null });
    clock.advance(BATCH_QUIET_MS);
    const crev = await revOf(server.base, cookie, "kids-cooking-concepts");
    const split = (await (await send("POST", "/api/replies", { clientId: "reply-0102", itemId: "kids-cooking-concepts", decision: "approve", rev: crev }, browser(cookie))).json()) as { id: string };
    expect((await open(split.id)).id).toBe(split.id);
    expect(await filed("kids-cooking-concepts")).toMatchObject({ id: split.id, via: "answer" });
    // You merges it by hand: its messages and card move, and its old id opens the one it joined.
    const merged = await send("POST", `/api/conversations/${split.id}/merge`, { into: other }, browser(cookie));
    expect(merged.status).toBe(200);
    expect(await merged.json()).toMatchObject({ moved: 1, conversation: { id: other } });
    expect((await open(split.id)).id).toBe(other);
    expect((await list()).conversations.map((row) => row.id)).not.toContain(split.id);
    expect(await filed("kids-cooking-concepts")).toMatchObject({ id: other });
    // Rivet's line or card on the merged one's old message lands in the one it joined.
    expect(await rivet("Still on it.", { replyTo: split.id })).toMatchObject({ threadId: other });
    const update = await send("POST", "/api/bridge/say", { text: "Kids cooking v2", replyTo: split.id, card: true });
    expect(update.status).toBe(201);
    const updateCard = ((await update.json()) as ChatMessage).card!;
    expect(await filed(updateCard)).toMatchObject({ id: other });
    // A card made from that card follows it there.
    expect((await card("kids-cooking-build", { replyTo: "kids-cooking-concepts" })).status).toBe(200);
    expect((await open(other)).messages.at(-1)?.posted?.id).toBe("kids-cooking-build");
    // Twice is harmless (the tidy runs again); itself, Updates and another origin are refused; the board token may merge.
    expect(await (await send("POST", `/api/conversations/${split.id}/merge`, { into: other }, browser(cookie))).json()).toMatchObject({ moved: 0 });
    expect((await send("POST", `/api/conversations/${other}/merge`, { into: other }, browser(cookie))).status).toBe(409);
    expect((await send("POST", `/api/conversations/${other}/merge`, { into: UPDATES_ID }, browser(cookie))).status).toBe(409);
    expect((await send("POST", `/api/conversations/${other}/merge`, { into: ask }, { ...browser(cookie), origin: "https://evil.example" })).status).toBe(403);
    expect((await send("POST", `/api/conversations/${other}/merge`, { into: ask })).status).toBe(200);
    expect((await open(other)).id).toBe(ask);
  });

  it("a card filed by reply to a line you typed in a thing stays in Chat with that line (2026-10-12)", async () => {
    await list();
    const ask = await owner("Top 10 chart libraries research, PR #999", { conversation: null });
    clock.advance(BATCH_QUIET_MS);
    const card = (id: string, extra: Record<string, unknown> = {}) => send("PUT", `/api/board/needs/${id}`, { kind: "decision", title: `Card ${id}`, ask: "Pick one", ...extra });
    expect((await card("chart-findings", { replyTo: ask })).status).toBe(200);
    // Typed on the thing's page after its card: it lands in the thing.
    const typed = await owner("Settings: bigger buttons", { conversation: ask });
    clock.advance(BATCH_QUIET_MS);
    expect((await card("settings-buttons-plan", { replyTo: typed })).status).toBe(200);
    expect((await card("chart-findings-v2")).status).toBe(200);
    // A question or a decision answering his first line is an answer.
    expect((await card("chart-question", { kind: "question", replyTo: ask })).status).toBe(200);
    expect((await card("slot-outcome", { replyTo: ask })).status).toBe(200);
    // Rivet's progress card naming the thing (say with no reply) is shown on its page only.
    const progress = await send("POST", "/api/bridge/say", { text: "#999 is green." });
    expect(progress.status).toBe(201);
    expect((await open(ask)).messages.at(-1)?.posted?.title).toBe("#999 is green.");
    const timeline = async () =>
      ((await (await send("GET", "/api/chat?chat=1", undefined, browser(cookie))).json()) as { messages: ChatMessage[] }).messages
        .filter((message) => (message.threadId ?? message.id) === ask)
        .map((message) => message.posted?.id ?? message.text);
    const shown = ["Top 10 chart libraries research, PR #999", "chart-findings", "Settings: bigger buttons", "settings-buttons-plan", "chart-question", "slot-outcome"];
    expect(await timeline()).toEqual(shown);
    // A card posted before its line kept the replyTo gets it back on the board's next write.
    const { createRequire } = await import("node:module");
    const { dirname, join } = await import("node:path");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(join(dirname(server.webRoot), "data", "rivet.sqlite"));
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("UPDATE chat_messages SET reply_to = NULL WHERE reply_to = ?").run(typed);
    db.close();
    expect(await timeline()).toEqual(shown.filter((line) => line !== "settings-buttons-plan"));
    expect((await card("settings-buttons-plan", { replyTo: typed, ask: "Pick one, again" })).status).toBe(200);
    expect(await timeline()).toEqual(shown);
    // A card filed by its stem that later names the line it answers joins Chat then.
    expect((await card("chart-findings-v2", { replyTo: typed })).status).toBe(200);
    expect(await timeline()).toEqual([...shown.slice(0, 4), "chart-findings-v2", ...shown.slice(4)]);
    // One that moves to another line answers that one: off Chat for Rivet's note, back for your line.
    const note = await rivet("Noted.", { replyTo: typed });
    expect((await card("chart-findings-v2", { replyTo: note.id })).status).toBe(200);
    expect(await timeline()).not.toContain("chart-findings-v2");
    expect((await card("chart-findings-v2", { replyTo: typed })).status).toBe(200);
    expect(await timeline()).toContain("chart-findings-v2");
  });

  it("a card's filing holds against near misses: another repo's PR, a stem on another PR, an ask naming it elsewhere; posted cards are never unread", async () => {
    await list();
    const card = (id: string, extra: Record<string, unknown> = {}) => send("PUT", `/api/board/needs/${id}`, { kind: "decision", title: `Card ${id}`, ...extra });
    const filed = async (id: string) => ((await (await send("GET", `/api/card-conversations/${id}`)).json()) as { conversation: { id: string } | null }).conversation?.id ?? null;
    const a = await owner("Lobby deploys", { conversation: null });
    clock.advance(BATCH_QUIET_MS);
    expect((await card("deploy-4861", { replyTo: a, pr: 88 })).status).toBe(200);
    expect(await filed("deploy-4861")).toBe(a);
    // The other repo's #88 is not this repo's #88, and deploy-4900 is another deploy than deploy-4861.
    expect((await card("other-enquiry-form", { pr: 88, repo: "example-org/other-repo" })).status).toBe(200);
    expect(await filed("other-enquiry-form")).toBeNull();
    expect((await card("deploy-4900", { pr: 4900 })).status).toBe(200);
    expect(await filed("deploy-4900")).toBeNull();
    expect((await card("deploy-88", { pr: 88, repo: "example-org/other-repo" })).status).toBe(200);
    expect(await filed("deploy-88")).toBeNull();
    // A stem with no PR is still its repo's: the other repo's deploy-check is not this repo's deploy-check-4861.
    expect((await card("deploy-check", { replyTo: a, repo: "example-org/other-repo" })).status).toBe(200);
    expect((await card("deploy-check-4861", { pr: 4861 })).status).toBe(200);
    expect(await filed("deploy-check-4861")).toBeNull();
    // A card filed in one conversation is that one's, though another's ask names it: Needs you is where it is shown.
    const b = await owner("Weekly deploy check", { conversation: null });
    expect((await send("POST", "/api/asks", { id: "a-41", words: "Weekly deploy check", replyId: b, stage: "building", cardId: "deploy-weekly" })).status).toBe(201);
    clock.advance(BATCH_QUIET_MS);
    expect((await card("deploy-weekly", { replyTo: a })).status).toBe(200);
    expect(await filed("deploy-weekly")).toBe(a);
    await owner("Any news?", { conversation: b });
    clock.advance(BATCH_QUIET_MS);
    const rows = (await list()).conversations;
    expect(rows.find((row) => row.id === a)).toMatchObject({ needsYou: true, phase: "waiting" });
    expect(rows.find((row) => row.id === b)?.needsYou).toBe(false);
    // Read, then a card shown in it: no unread count.
    expect((await patch(a, { read: true })).status).toBe(200);
    expect((await card("deploy-notes-4861", { kind: "question", replyTo: a, ask: "Gate clean. Merge?" })).status).toBe(200);
    expect((await list()).conversations.find((row) => row.id === a)?.unread).toBe(0);
    // Agent Chat never merges, however its id is spelled.
    expect((await send("POST", "/api/conversations/team%2Droom/merge", { into: TEAM_ROOM_ID })).status).toBe(409);
    expect((await send("POST", `/api/conversations/${a}/merge`, { into: TEAM_ROOM_ID })).status).toBe(409);
  });

  it("a shareable repo's ask closed leaves its conversation shareable", async () => {
    await list();
    const lobby = await owner("Lobby copy", { conversation: null });
    expect((await send("POST", "/api/asks", { id: "a-73", words: "Lobby copy", replyId: lobby, stage: "building", repo: "example-org/example-repo" })).status).toBe(201);
    clock.advance(BATCH_QUIET_MS);
    expect((await send("PATCH", "/api/asks/a-73", { stage: "done" })).status).toBe(200);
    expect((await list()).conversations.find((row) => row.id === lobby)?.appOnly).toBe(false);
  });

  it("two app-only conversations merged stay app-only, though the newer one's ask names a shareable repo", async () => {
    await list();
    const private1 = await owner("Weigh-in chart", { conversation: null });
    expect((await send("PATCH", `/api/threads/${private1}`, { project: "personal" })).status).toBe(200);
    clock.advance(BATCH_QUIET_MS);
    const private2 = await owner("Pitch deck", { conversation: null });
    expect((await send("PATCH", `/api/threads/${private2}`, { project: "personal" })).status).toBe(200);
    expect((await send("POST", "/api/asks", { id: "a-52", words: "Pitch deck", replyId: private2, stage: "building", repo: "example-org/example-repo" })).status).toBe(201);
    clock.advance(BATCH_QUIET_MS);
    const appOnly = async (id: string) => (await list()).conversations.find((row) => row.id === id)?.appOnly;
    expect([await appOnly(private1), await appOnly(private2)]).toEqual([true, true]);
    expect((await send("POST", `/api/conversations/${private2}/merge`, { into: private1 }, browser(cookie))).status).toBe(200);
    expect(await appOnly(private1)).toBe(true);

    // Private only by your Move: merged into it, a Rivet-filed private one keeps it private when you move it back.
    const shared = await owner("Lobby copy", { conversation: null });
    expect((await send("POST", "/api/asks", { id: "a-53", words: "Lobby copy", replyId: shared, stage: "building", repo: "example-org/example-repo" })).status).toBe(201);
    clock.advance(BATCH_QUIET_MS);
    expect((await send("PATCH", `/api/threads/${shared}`, { project: "personal" }, browser(cookie))).status).toBe(200);
    expect(await appOnly(shared)).toBe(true);
    expect((await send("POST", `/api/conversations/${private1}/merge`, { into: shared }, browser(cookie))).status).toBe(200);
    expect((await send("PATCH", `/api/threads/${shared}`, { project: "work" }, browser(cookie))).status).toBe(200);
    expect(await appOnly(shared)).toBe(true);
  });

  it("chats match in their repo; Updates takes no card; a card follows its parent of the same write", async () => {
    await list();
    const card = (id: string, extra: Record<string, unknown> = {}) => send("PUT", `/api/board/needs/${id}`, { kind: "decision", title: `Card ${id}`, ...extra });
    const filed = async (id: string) => ((await (await send("GET", `/api/card-conversations/${id}`)).json()) as { conversation: { id: string } | null }).conversation?.id ?? null;
    const lobby = await owner("Lobby copy", { conversation: null });
    clock.advance(BATCH_QUIET_MS);

    // A chat is its repo's, and Rivet's own chat is no key in any case.
    expect((await card("other-copy", { replyTo: lobby, chat: "copy-review", repo: "example-org/other-repo" })).status).toBe(200);
    expect((await card("lobby-text", { chat: "copy-review" })).status).toBe(200);
    expect(await filed("lobby-text")).toBeNull();
    expect((await card("lobby-status", { replyTo: lobby, chat: "Rivet" })).status).toBe(200);
    expect((await send("POST", "/api/asks", { id: "a-65", words: "Lobby status", replyId: lobby, stage: "building", chat: "Rivet" })).status).toBe(201);
    expect((await card("town-status", { chat: "Rivet" })).status).toBe(200);
    expect(await filed("town-status")).toBeNull();
    // Nor when you answer it: your answer starts its own conversation.
    const trev = await revOf(server.base, cookie, "town-status");
    const townAnswer = (await (await send("POST", "/api/replies", { clientId: "reply-0201", itemId: "town-status", decision: "approve", rev: trev }, browser(cookie))).json()) as { id: string };
    expect(await filed("town-status")).toBe(townAnswer.id);

    // A card on a line in Updates is filed nowhere: Updates owns no card.
    const said = await send("POST", "/api/bridge/say", { text: "Status note", replyTo: UPDATES_ID, card: true });
    expect(said.status).toBe(201);
    const note = ((await said.json()) as ChatMessage).card!;
    expect(await filed(note)).not.toBe(UPDATES_ID);

    // One write, the follow-up before its parent: it still follows the parent in.
    const board = (await (await send("GET", "/api/board")).json()) as { board: { needs: Record<string, unknown>[] } };
    const needs = [...board.board.needs, { id: "copy-walkthrough", kind: "update", title: "Walkthrough", replyTo: "copy-plan" }, { id: "copy-plan", kind: "decision", title: "Plan", replyTo: lobby }];
    expect((await send("PUT", "/api/board", { ...REPLY_BOARD, needs })).status).toBe(200);
    expect([await filed("copy-plan"), await filed("copy-walkthrough")]).toEqual([lobby, lobby]);
  });

  it("Select mode closes, reopens, marks read and unread every one ticked; Updates is never closed; only your session", async () => {
    await list();
    const a = await owner("Docs refresh", { conversation: null });
    clock.advance(BATCH_QUIET_MS + 1000);
    const b = await owner("Night Batch", { conversation: null });
    clock.advance(BATCH_QUIET_MS + 1000);
    const c = await owner("Help Page", { conversation: null });
    clock.advance(60_000);
    const reply = await rivet("On it.", { replyTo: a });
    await rivet("Looking.", { replyTo: b });
    await rivet("Nightly: green");

    // Any message's id names its conversation; an id twice counts once; one that names nothing is left.
    let response = await batch({ ids: [reply.id, b, a, UPDATES_ID, "no-such-message"], action: "read" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ changed: 3 });
    let page = await list();
    expect(page.unread).toBe(0);

    expect(await (await batch({ ids: [a, c], action: "unread" })).json()).toEqual({ changed: 2 });
    page = await list();
    expect(page.conversations.filter((row) => row.markedUnread).map((row) => row.id).sort()).toEqual([a, c].sort());

    expect(await (await batch({ ids: [a, b, UPDATES_ID], action: "close" })).json()).toEqual({ changed: 2 });
    page = await list();
    expect(page.conversations.map((row) => row.id).sort()).toEqual([c]);
    expect(page.older).toBeGreaterThanOrEqual(2);
    expect(await (await batch({ ids: [a, b], action: "reopen" })).json()).toEqual({ changed: 2 });
    expect((await list()).conversations.map((row) => row.id).sort()).toEqual([a, b, c].sort());

    expect((await batch({ ids: [], action: "close" })).status).toBe(400);
    expect((await batch({ ids: [a], action: "pin" })).status).toBe(400);
    expect((await batch({ ids: [a], action: "close", extra: 1 })).status).toBe(400);
    expect((await batch({ ids: Array.from({ length: 101 }, (_, n) => `m${n}`), action: "read" })).status).toBe(400);
    // The board token and a cross-site request change nothing.
    expect((await send("POST", "/api/conversations/batch", { ids: [a], action: "close" })).status).toBe(403);
    expect((await batch({ ids: [a], action: "close" }, { cookie, "content-type": "application/json" })).status).toBe(403);
    expect((await list()).conversations.map((row) => row.id)).toContain(a);
  });

  describe("a line typed with no Reply starts its own chat (2026-10-20)", () => {
    const card = (id: string, extra: Record<string, unknown> = {}) => send("PUT", `/api/board/needs/${id}`, { kind: "decision", title: `Card ${id}`, ask: "Pick one\nmore", ...extra });
    const filed = async (id: string) => ((await (await send("GET", `/api/card-conversations/${id}`)).json()) as { conversation: { id: string; via: string } | null }).conversation;
    const split = (body: unknown = {}, headers: Record<string, string> = bearer(BOARD_TOKEN)) => send("POST", "/api/conversations/split", body, headers);
    const answer = async (id: string, text: string) => {
      const rev = await revOf(server.base, cookie, id);
      const response = await send("POST", "/api/replies", { clientId: `reply-no-${(seq += 1)}`, itemId: id, decision: "comment", rev, text }, browser(cookie));
      expect(response.status, await response.clone().text()).toBe(201);
    };
    const sqlite = async (sql: string, ...args: string[]) => {
      const { createRequire } = await import("node:module");
      const { dirname, join } = await import("node:path");
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(join(dirname(server.webRoot), "data", "rivet.sqlite"));
      db.exec("PRAGMA busy_timeout = 5000");
      db.prepare(sql).run(...args);
      db.close();
    };
    // A Sketcher chat that took in a Log Viewer line typed on its page, both Log Viewer cards that answered
    // it, and your answer to one of them (old clients sent a page's line with the page's conversation).
    async function misfiled() {
      await list();
      const sketcher = await owner("Adding tester Sam to Sketcher Android test", { conversation: null });
      clock.advance(BATCH_QUIET_MS);
      await rivet("Added Sam.", { replyTo: sketcher });
      const viewer = await owner("Log Viewer: review the colour pass", { conversation: sketcher });
      expect((await card("log-viewer-review-4861", { replyTo: viewer, pr: 4861 })).status).toBe(200);
      expect((await card("log-viewer-notes", { replyTo: viewer })).status).toBe(200);
      expect((await card("sketcher-sam", { replyTo: sketcher })).status).toBe(200);
      await answer("log-viewer-review-4861", "ship the lanterns");
      return { sketcher, viewer };
    }

    it("a card whose reply-to is a no-Reply line typed on another thing's page lands in that line's own chat", async () => {
      await list();
      const sketcher = await owner("Adding tester Sam to Sketcher Android test", { conversation: null });
      clock.advance(BATCH_QUIET_MS);
      const viewer = await owner("Log Viewer: review the colour pass", { conversation: null });
      expect(viewer).not.toBe(sketcher);
      expect((await card("log-viewer-colour-review", { replyTo: viewer })).status).toBe(200);
      expect(await filed("log-viewer-colour-review")).toMatchObject({ id: viewer, via: "reply-to" });
      expect((await open(sketcher)).messages.map((message) => message.posted?.id ?? message.text)).toEqual(["Adding tester Sam to Sketcher Android test"]);
    });

    it("a card dropped from the board and added again is placed again; one that never left is not posted twice", async () => {
      await list();
      const first = await owner("Lobby tiles", { conversation: null });
      clock.advance(BATCH_QUIET_MS);
      const second = await owner("Slot sounds", { conversation: null });
      expect((await card("sound-pass", { replyTo: first })).status).toBe(200);
      expect(await filed("sound-pass")).toMatchObject({ id: first });
      expect((await card("sound-pass", { replyTo: first, ask: "Pick one, again" })).status).toBe(200);
      expect((await open(first)).messages).toHaveLength(2);
      expect((await send("DELETE", "/api/board/needs/sound-pass")).status).toBe(200);
      expect((await card("sound-pass", { replyTo: second })).status).toBe(200);
      expect(await filed("sound-pass")).toMatchObject({ id: second, via: "reply-to" });
      expect((await open(second)).messages.map((message) => message.posted?.id ?? message.text)).toEqual(["Slot sounds", "sound-pass"]);
      // Back where it was: the filing moves again, and the new line is the one it posts.
      expect((await send("DELETE", "/api/board/needs/sound-pass")).status).toBe(200);
      expect((await card("sound-pass", { replyTo: first })).status).toBe(200);
      expect(await filed("sound-pass")).toMatchObject({ id: first });
      // Dropped and back to the same place: nothing new is posted there.
      expect((await send("DELETE", "/api/board/needs/sound-pass")).status).toBe(200);
      expect((await card("sound-pass", { replyTo: first })).status).toBe(200);
      expect((await open(first)).messages.map((message) => message.posted?.id ?? message.text)).toEqual(["Lobby tiles", "sound-pass", "sound-pass"]);
    });

    it("Chat names the card an answer answered, never its conversation, even once the card has left the board", async () => {
      const { sketcher } = await misfiled();
      expect((await send("DELETE", "/api/board/needs/log-viewer-review-4861")).status).toBe(200);
      const timeline = (await (await send("GET", "/api/chat?chat=1", undefined, browser(cookie))).json()) as { messages: ChatMessage[] };
      const answered = timeline.messages.find((message) => message.card === "log-viewer-review-4861");
      expect(answered).toMatchObject({ cardTitle: "Card log-viewer-review-4861" });
      expect(answered?.threadId).toBe(sketcher);
    });

    it("split: a dry run lists the chats and changes nothing; the real run moves the Log Viewer line, its two cards and your answer together; run again it moves nothing", async () => {
      const { sketcher, viewer } = await misfiled();
      const before = (await open(sketcher)).messages.map((message) => message.id);
      const planned = (await (await split({ dryRun: true })).json()) as { dryRun: boolean; conversations: { id: string; from: string; title: string; messages: number; cards: number }[]; messages: number; cards: number };
      expect(planned).toMatchObject({ dryRun: true, messages: 4, cards: 2 });
      expect(planned.conversations).toEqual([{ id: viewer, from: sketcher, title: expect.stringContaining("Log Viewer"), messages: 4, cards: 2 }]);
      expect((await open(sketcher)).messages.map((message) => message.id)).toEqual(before);
      expect(await filed("log-viewer-notes")).toMatchObject({ id: sketcher });

      const done = (await (await split()).json()) as typeof planned;
      expect(done).toMatchObject({ dryRun: false, messages: 4, cards: 2 });
      const moved = await open(viewer);
      expect(moved.messages.map((message) => message.posted?.id ?? message.card ?? message.text).sort()).toEqual(["Log Viewer: review the colour pass", "log-viewer-notes", "log-viewer-review-4861", "log-viewer-review-4861"].sort());
      expect((await open(sketcher)).messages.map((message) => message.posted?.id ?? message.text)).toEqual(["Adding tester Sam to Sketcher Android test", "Added Sam.", "sketcher-sam"]);
      expect(await filed("log-viewer-notes")).toMatchObject({ id: viewer });
      expect(await filed("sketcher-sam")).toMatchObject({ id: sketcher });
      expect(await (await split()).json()).toEqual({ dryRun: false, conversations: [], messages: 0, cards: 0 });

      // A near-miss card made later follows the Log Viewer card by its stem, now into the Log Viewer chat.
      expect((await card("log-viewer-review-v2-4861")).status).toBe(200);
      expect(await filed("log-viewer-review-v2-4861")).toMatchObject({ id: viewer, via: "stem" });
    });

    it("split never undoes a merge or takes a Stop it; a say card moves with its answer; a chat you moved into the app keeps what leaves it there", async () => {
      await list();
      const page = await owner("Side Project: slide notes", { conversation: null });
      clock.advance(BATCH_QUIET_MS);
      const other = await owner("Weekend plans", { conversation: null });
      clock.advance(BATCH_QUIET_MS);
      expect((await send("POST", `/api/conversations/${other}/merge`, { into: page }, browser(cookie))).status).toBe(200);
      await owner("Stop this: Side Project: slide notes", { conversation: page });
      clock.advance(BATCH_QUIET_MS);
      const typed = await owner("Pricing page draft", { conversation: page });
      const say = await send("POST", "/api/bridge/say", { text: "Which pricing layout?", replyTo: typed, card: true });
      expect(say.status).toBe(201);
      const sayCard = ((await say.json()) as ChatMessage).card!;
      await answer(sayCard, "the second");
      expect((await send("PATCH", `/api/threads/${page}`, { project: "personal" }, browser(cookie))).status).toBe(200);

      const done = (await (await split({ conversation: page })).json()) as { conversations: { id: string; messages: number; cards: number }[] };
      expect(done.conversations).toEqual([expect.objectContaining({ id: typed, messages: 3, cards: 1 })]);
      expect((await open(page)).messages.map((message) => message.text)).toEqual(["Side Project: slide notes", "Weekend plans", "Stop this: Side Project: slide notes"]);
      expect(await filed(sayCard)).toMatchObject({ id: typed });
      expect((await open(typed)).conversation).toMatchObject({ id: typed, appOnly: true });
    });

    it("split keeps a chat in the app when only the titler put its conversation there", async () => {
      await list();
      const page = await owner("Reminders: weekly check-in", { conversation: null });
      clock.advance(BATCH_QUIET_MS);
      const typed = await owner("Streak badge colours", { conversation: page });
      expect((await send("POST", "/api/bridge/say", { text: "Green for a week, gold for a month.", replyTo: typed })).status).toBe(201);
      await sqlite("INSERT INTO chat_threads (root_id, ai_project, updated_at) VALUES (?, 'personal', ?) ON CONFLICT(root_id) DO UPDATE SET ai_project = excluded.ai_project", page, clock.now().toISOString());
      expect((await open(page)).conversation).toMatchObject({ appOnly: true });
      const done = (await (await split({ conversation: page })).json()) as { conversations: { id: string; messages: number }[] };
      expect(done.conversations).toEqual([expect.objectContaining({ id: typed, messages: 2 })]);
      expect((await open(typed)).conversation).toMatchObject({ id: typed, appOnly: true });
    });

    it("split answers only your session or the board token, and never splits Updates", async () => {
      await list();
      expect((await split({}, {})).status).toBe(403);
      expect((await split({ conversation: UPDATES_ID })).status).toBe(409);
      expect((await split({ extra: 1 })).status).toBe(400);
      expect((await split({}, { cookie, "content-type": "application/json" })).status).toBe(403);
    });
  });
});

describe("CommandStore.backfillCardTitles", () => {
  it("names an old answer's card from its reply, once, when no line that posted the card is left", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { CommandStore } = await import("../src/server/commandstore.js");
    const store = new CommandStore(mkdtempSync(join(tmpdir(), "rivet-card-titles-")));
    const at = "2026-10-15T03:00:00.000Z";
    store.addChatMessage({ id: "answer-old", from: "owner", text: "Approve", at, card: "viewer-lanterns" });
    store.addChatMessage({ id: "typed-old", from: "owner", text: "Hello", at });
    expect(store.getChatMessage("answer-old")?.cardTitle).toBeUndefined();
    const titles = new Map([["answer-old", "Log Viewer lanterns"], ["typed-old", "never asked"]]);
    expect(store.backfillCardTitles((id) => titles.get(id))).toBe(1);
    expect(store.getChatMessage("answer-old")?.cardTitle).toBe("Log Viewer lanterns");
    expect(store.backfillCardTitles((id) => titles.get(id))).toBe(0);
  });
});

describe("CommandStore.rememberConversationPrs", () => {
  it("keeps every link it made, up to the cap a conversation, and never drops a current one", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { CommandStore, CONVERSATION_PRS_KEPT } = await import("../src/server/commandstore.js");
    const store = new CommandStore(mkdtempSync(join(tmpdir(), "rivet-conversation-prs-")));
    const keys = (from: number, count: number) => Array.from({ length: count }, (_, index) => `${REPO}#${from + index}`);
    store.rememberConversationPrs(new Map([["a", keys(1, 50)]]));
    store.rememberConversationPrs(new Map([["a", keys(51, 50)], ["b", keys(1, 1)]]));
    expect(store.conversationPrs().get("a")).toHaveLength(100);
    // Fifty more: the oldest no longer linked go; the current fifty stay.
    store.rememberConversationPrs(new Map([["a", keys(101, 50)]]));
    const a = store.conversationPrs().get("a")!;
    expect(a).toHaveLength(CONVERSATION_PRS_KEPT);
    expect(a).toEqual(keys(51, 100));
    expect(store.conversationPrs().get("b")).toEqual(keys(1, 1));
    // The cap counts its current links: one old and one new current leaves 98 of the rest.
    store.rememberConversationPrs(new Map([["a", [`${REPO}#51`, `${REPO}#151`]]]));
    expect(store.conversationPrs().get("a")).toHaveLength(CONVERSATION_PRS_KEPT);
    expect(store.conversationPrs().get("a")).toContain(`${REPO}#51`);
    // A PR is one link whatever its case.
    store.rememberConversationPrs(new Map([["b", [`${REPO.toLowerCase()}#1`]]]));
    expect(store.conversationPrs().get("b")).toEqual(keys(1, 1));
  });
});
