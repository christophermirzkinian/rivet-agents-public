import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ANSWER_QUIET_MS, MAX_WAITS, stemOf, waitStem, withWaits, yesKey, type AskLike, type WaitInput } from "../src/server/asks/waits.js";
import { needRev, withAgain } from "../src/server/http.js";
import type { Board, BoardChat, ComingItem, Need } from "../src/shared/board.js";
import { NO_REPO } from "../src/shared/board.js";
import { bearer, BOARD_TOKEN, browser, fakeClock, revOf, startServer, type TestServer } from "./helpers.js";

const NOW = new Date("2026-10-26T04:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function board(parts: Partial<Board> = {}): Board {
  return { updatedAt: NOW.toISOString(), needs: [], coming: [], chats: [], shipped: [], ...parts } as Board;
}
const okRow = (extra: Partial<ComingItem> = {}): ComingItem => ({ pr: 483, title: "Daily build v2 sound pass", chat: "build-sound", stage: "owner-ok", touchedAt: ago(60_000), ...extra });
const waitingChat = (extra: Partial<BoardChat> = {}): BoardChat => ({ name: "design", state: "waiting on you", doing: "Which logo, blue or red?", touchedAt: ago(60_000), ...extra });
const ask = (extra: Partial<AskLike> = {}): AskLike => ({ id: "a-1", words: "Cache keys: never forgotten", status: "awaiting-you", chat: "cache-keys", prs: [4100], ...extra });

function run(input: Partial<WaitInput> & { board: Board }): Need[] {
  return withWaits({ stored: null, asks: [], answers: new Map(), rev: needRev, room: 200, now: NOW, ...input }).needs.filter((need) => need.id.startsWith("wait-"));
}

describe("withWaits", () => {
  it("makes one card for each of a Your OK row and a waiting chat, and none for a needs-you ask", () => {
    const cards = run({ board: board({ coming: [okRow()], chats: [waitingChat()] }), asks: [ask()] });
    expect(cards.map((card) => [card.kind, card.title])).toEqual([
      ["decision", "Your OK: Daily build v2 sound pass"],
      ["question", "Which logo, blue or red?"],
    ]);
    expect(cards[0]).toMatchObject({ pr: 483, chat: "build-sound", options: [{ label: "Yes" }, { label: "Change it", text: true }] });
    // With no ask, the question is the title and the chat is named once, in the card's own line.
    expect(cards[1]).toMatchObject({ chat: "design", reply: "text" });
    expect(cards[1]?.ask).toBeUndefined();
  });

  it("makes a Your OK for each of two rows of one PR and chat that two repos claim, and one for a row and its duplicate", () => {
    const markets = "example-org/third-repo";
    const chats = [waitingChat({ name: "lab", state: "a", prs: [7] }), waitingChat({ name: "lab", state: "b", repo: markets, prs: [7] })];
    const rows = [okRow({ pr: 7, chat: "lab", title: "Software seven" }), okRow({ pr: 7, chat: "lab", title: "Reports seven" })];
    const cards = run({ board: board({ coming: rows, chats }) });
    expect(cards.map((card) => card.title)).toEqual(["Your OK: Software seven", "Your OK: Reports seven"]);
    expect(new Set(cards.map((card) => card.waitKey)).size).toBe(2);
    // With one repo's lab holding PR 7, the rows are the same PR in the same repo: one card.
    expect(run({ board: board({ coming: rows, chats: [chats[0]!] }) }).map((card) => card.title)).toEqual(["Your OK: Software seven"]);
  });

  it("keeps two repos' Your OKs of one PR apart: one's answer leaves the other, and a later row of another repo is its own wait", () => {
    const markets = "example-org/third-repo";
    const chats = [waitingChat({ name: "lab", state: "a", prs: [7] }), waitingChat({ name: "lab", state: "b", repo: markets, prs: [7] })];
    const rows = [okRow({ pr: 7, chat: "lab", title: "Software seven" }), okRow({ pr: 7, chat: "lab", title: "Reports seven" })];
    const [first, second] = run({ board: board({ coming: rows, chats }) });
    // You answer the first: the second stays.
    const answered = [{ id: first!.id, at: NOW.toISOString(), chat: "lab" }];
    const stored = board({ coming: rows, chats, needs: [second!] });
    expect(run({ board: board({ coming: rows, chats }), stored, answered }).map((card) => card.title)).toEqual(["Your OK: Reports seven"]);
    // A Software row's reopened card is not a Reports row's of the same PR and chat later.
    const reopened = { ...run({ board: board({ coming: [rows[0]!], chats: [chats[0]!] }) })[0]!, again: { n: 1, after: "r1" } } as Need;
    const later = run({ board: board({ coming: [rows[1]!], chats: [chats[1]!] }), stored: board({ needs: [reopened] }) });
    expect(later.map((card) => [card.title, card.repo])).toEqual([
      ["Your OK: Software seven", "example-org/example-repo"],
      ["Your OK: Reports seven", markets],
    ]);
  });

  it("keeps another repo's old card off a default-repo Your OK, and an ambiguous card's answer off its sibling once its row moved on", () => {
    const markets = "example-org/third-repo";
    const marketsCard = run({ board: board({ coming: [okRow({ pr: 7, chat: "lab", title: "Reports seven" })], chats: [waitingChat({ name: "lab", state: "a", repo: markets, prs: [7] })] }) })[0]!;
    const legacy = { ...marketsCard, id: `${waitStem("ok", "ok\n7\nlab\n")}-k1`, waitKey: "ok\n7\nlab\n", again: { n: 1, after: "r1" } } as Need;
    const software = run({ board: board({ coming: [okRow({ pr: 7, chat: "lab", title: "Software seven" })] }), stored: board({ needs: [legacy] }) });
    expect(software.map((card) => [card.title, card.repo])).toEqual([
      ["Your OK: Reports seven", markets],
      ["Your OK: Software seven", undefined],
    ]);
    // The first of two ambiguous rows was answered and has left owner-ok: the second still asks.
    const chats = [waitingChat({ name: "lab", state: "a", prs: [7] }), waitingChat({ name: "lab", state: "b", repo: markets, prs: [7] })];
    const rows = [okRow({ pr: 7, chat: "lab", title: "Software seven" }), okRow({ pr: 7, chat: "lab", title: "Reports seven" })];
    const [first] = run({ board: board({ coming: rows, chats }) });
    // As a reply records it: the default repo for a card that names none.
    const answered = [{ id: first!.id, at: NOW.toISOString(), chat: "lab", repo: NO_REPO }];
    expect(run({ board: board({ coming: [{ ...rows[0]!, stage: "building" }, rows[1]!], chats }), answered }).map((card) => card.title)).toEqual(["Your OK: Reports seven"]);
    expect(run({ board: board({ coming: rows, chats }), stored: board({ needs: [first!] }), answered }).map((card) => card.title)).toEqual(["Your OK: Software seven", "Your OK: Reports seven"]);
  });

  it("gives an ambiguous Your OK the old card of its PR and chat only when it is that row's", () => {
    const markets = "example-org/third-repo";
    const chats = [waitingChat({ name: "lab", state: "a", prs: [7] }), waitingChat({ name: "lab", state: "b", repo: markets, prs: [7] })];
    const rows = [okRow({ pr: 7, chat: "lab", title: "Software seven" }), okRow({ pr: 7, chat: "lab", title: "Reports seven" })];
    const [first] = run({ board: board({ coming: rows, chats }) });
    const legacy = { ...first!, id: `${waitStem("ok", "ok\n7\nlab\n")}-k1`, waitKey: "ok\n7\nlab\n", again: { n: 1, after: "r1" } } as Need;
    const yeses = new Map([[yesKey(waitStem("ok", "ok\n7\nlab\n"), undefined, undefined), NOW.toISOString()]]);
    // The row it was made for has moved on: the other row asks with its own card, the old one's Yes not its own.
    const other = run({ board: board({ coming: [{ ...rows[0]!, stage: "building" }, rows[1]!], chats }), stored: board({ needs: [legacy] }), yeses });
    expect(other.find((card) => card.title === "Your OK: Reports seven")?.id).not.toBe(legacy.id);
    expect(run({ board: board({ coming: [{ ...rows[0]!, stage: "building" }, rows[1]!], chats }), yeses }).map((card) => card.title)).toEqual(["Your OK: Reports seven"]);
    // Its own row keeps it.
    expect(run({ board: board({ coming: [rows[0]!, { ...rows[1]!, stage: "building" }], chats }), stored: board({ needs: [legacy] }) }).map((card) => card.id)).toEqual([legacy.id]);
  });

  it("keeps a Your OK's card and Yes from before its key named its repo", () => {
    const markets = "example-org/third-repo";
    const chats = [waitingChat({ name: "lab", state: "a", repo: markets, prs: [7] })];
    const row = okRow({ pr: 7, chat: "lab", title: "Reports seven" });
    const [card] = run({ board: board({ coming: [row], chats }) });
    const legacy = { ...card!, id: `${waitStem("ok", "ok\n7\nlab\n")}-k1`, waitKey: "ok\n7\nlab\n" } as Need;
    const kept = run({ board: board({ coming: [row], chats }), stored: board({ needs: [legacy] }) });
    expect(kept.map((one) => [one.id, one.waitKey])).toEqual([[legacy.id, card!.waitKey]]);
    const later = new Date(NOW.getTime() + 3 * ANSWER_QUIET_MS);
    const yeses = new Map([[yesKey(stemOf(legacy.id), markets, 7), NOW.toISOString()]]);
    expect(run({ board: board({ coming: [row], chats }), yeses, now: later })).toEqual([]);
  });

  it("makes no card for an ask, at needs-you or with its time moved twice", () => {
    const twice = [
      { at: ago(7200_000), dueAt: ago(3600_000), why: "tests" },
      { at: ago(60_000), dueAt: "2026-10-26T09:30:00.000Z", why: "deploy queue" },
    ];
    const asks = [
      ask({ id: "a-old", status: "awaiting-you" }),
      ask({ id: "a-new", status: undefined, stage: "needs-you", replyId: "m1", timeline: [{ note: "Pick a key name" }] } as Partial<AskLike>),
      ask({ id: "a-moved", status: undefined, stage: "building", dueAt: "2026-10-26T09:30:00.000Z", dueHistory: twice } as Partial<AskLike>),
    ];
    expect(run({ board: board(), asks })).toEqual([]);
  });

  it("titles a Your OK and a chat's question with their ask, and says what a yes does with the PR's link", () => {
    const asks = [
      ask({ id: "a-build", words: "Daily build sound pass", status: "in-hand", chat: undefined, prs: [483], repo: "example-org/example-repo" }),
      ask({ id: "a-logo", words: "Docs Sync logo", status: "in-hand", chat: "design-2", prs: [] }),
      ask({ id: "a-old", words: "An old logo ask", status: "done", chat: "design", prs: [] }),
    ];
    const building = { name: "build-sound", state: "building", repo: "example-org/example-repo", touchedAt: ago(60_000) } as BoardChat;
    const cards = run({ board: board({ coming: [okRow({ what: "v2 sound pass" })], chats: [waitingChat(), building] }), asks });
    expect(cards.map((card) => [card.title, card.ask])).toEqual([
      ["Your OK: Daily build sound pass", "v2 sound pass is ready to merge. Yes tells build-sound to merge it; Change it sends build-sound your note."],
      ["Question from Docs Sync logo", "Which logo, blue or red?"],
    ]);
    expect(cards[0]?.links).toEqual([{ label: "PR #483", url: "https://github.com/example-org/example-repo/pull/483" }]);
    const bare = run({ board: board({ coming: [okRow({ chat: undefined })] }) });
    expect(bare[0]?.ask).toBe("It is ready to merge. Yes tells Rivet to merge it; Change it sends Rivet your note.");
  });

  it("is a fixed point: the same sources make the same ids, revs and since on every write", () => {
    const input = { board: board({ coming: [okRow()], chats: [waitingChat()] }), asks: [ask()] };
    const first = run(input);
    let stored = board({ needs: first });
    for (let i = 1; i <= 50; i++) {
      const next = run({ ...input, stored, now: new Date(NOW.getTime() + i * 60_000) });
      expect(next.map((card) => `${card.id} ${needRev(card)} ${card.since}`)).toEqual(first.map((card) => `${card.id} ${needRev(card)} ${card.since}`));
      stored = board({ needs: next });
    }
  });

  it("drops a writer's wait cards and makes them from their sources", () => {
    const forged = { id: "wait-ok-forged-1", kind: "question", title: "Forged" } as Need;
    expect(run({ board: board({ needs: [forged] }) })).toEqual([]);
  });

  it("makes one card for one item reached two ways: the Your OK wins its chat, titled with its ask", () => {
    const cards = run({
      board: board({ coming: [okRow({ chat: "cache-keys", pr: 4100 })], chats: [waitingChat({ name: "cache-keys" })] }),
      asks: [ask(), ask()],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toMatch(/^wait-ok-/);
    expect(cards[0]!.title).toBe("Your OK: Cache keys: never forgotten");
  });

  it("is never more than MAX_WAITS cards, nor past the board's room", () => {
    const chats = Array.from({ length: 60 }, (_, i) => waitingChat({ name: `chat-${i}` }));
    expect(run({ board: board({ chats }) })).toHaveLength(MAX_WAITS);
    const others = Array.from({ length: 195 }, (_, i) => ({ id: `n${i}`, kind: "question", title: `q${i}` }) as Need);
    expect(run({ board: board({ chats, needs: others }) })).toHaveLength(5);
  });

  describe("a card you can act on speaks for its wait; one the deck leaves out does not", () => {
    const named = { id: "c1", kind: "question", title: "Logo?", chat: "design" } as Need;
    const input = (needs: Need[], answers = new Map<string, string>()) => ({ board: board({ needs, chats: [waitingChat()] }), answers });

    it("an open card naming the chat: no wait card", () => {
      expect(run(input([named]))).toEqual([]);
    });
    it("an update card naming the chat: the wait is still carded", () => {
      expect(run(input([{ ...named, kind: "update" } as Need]))).toHaveLength(1);
    });
    it("a card answered a while ago: the wait is carded again", () => {
      expect(run(input([named], new Map([[`c1\n${needRev(named)}`, ago(ANSWER_QUIET_MS + 1)]])))).toHaveLength(1);
    });
    it("a card answered just now: no second card while the crew acts on it", () => {
      expect(run(input([named], new Map([[`c1\n${needRev(named)}`, ago(60_000)]])))).toEqual([]);
    });
    it("a card on another chat's numbered name speaks for it", () => {
      expect(run({ board: board({ needs: [{ ...named, chat: "design-2" }], chats: [waitingChat()] }) })).toEqual([]);
    });
  });

  it("an answered wait stays answered while its question holds, and a new question is a new revision", () => {
    const first = run({ board: board({ chats: [waitingChat()] }) });
    const answers = new Map([[`${first[0]!.id}\n${needRev(first[0]!)}`, NOW.toISOString()]]);
    const same = run({ board: board({ chats: [waitingChat()] }), stored: board({ needs: first }), answers });
    expect(needRev(same[0]!)).toBe(needRev(first[0]!));
    const asked = run({ board: board({ chats: [waitingChat({ doing: "And the font?" })] }), stored: board({ needs: same }), answers });
    expect(asked[0]!.id).toBe(first[0]!.id);
    expect(needRev(asked[0]!)).not.toBe(needRev(first[0]!));
  });

  it("a wait that ends and comes back is a new card", () => {
    const first = run({ board: board({ coming: [okRow()] }) });
    const ended = run({ board: board({ coming: [okRow({ stage: "merging" })] }), stored: board({ needs: first }) });
    expect(ended).toEqual([]);
    const back = run({ board: board({ coming: [okRow()] }), stored: board({ needs: ended }), now: new Date(NOW.getTime() + 60_000) });
    expect(back[0]!.id).not.toBe(first[0]!.id);
  });

  it("keeps a reopened wait card after its source ends, until it is answered again", () => {
    const first = run({ board: board({ coming: [okRow()] }) });
    const reopened = { ...first[0]!, again: { n: 1, after: "r1" } } as Need;
    const kept = run({ board: board(), stored: board({ needs: [reopened] }) });
    expect(kept.map((card) => card.id)).toEqual([reopened.id]);
    const answered = run({ board: board(), stored: board({ needs: [reopened] }), answers: new Map([[`${reopened.id}\n${needRev(reopened)}`, NOW.toISOString()]]) });
    expect(answered).toEqual([]);
  });

  it("drops a reopened ask or moved-time card, a kind no longer made", () => {
    const first = run({ board: board({ coming: [okRow()] }) });
    for (const id of ["wait-ask-6535f7edd50e-mvpu11d0", "wait-moved-e2e64b20a15c-mvpu11d0"]) {
      const retired = { ...first[0]!, id, again: { n: 1, after: "r1" } } as Need;
      expect(run({ board: board(), stored: board({ needs: [retired] }) }), id).toEqual([]);
    }
  });

  it("keeps a reopened wait card at its reopened revision while its source still holds, until it is answered again", () => {
    const first = run({ board: board({ coming: [okRow()] }) });
    const reopened = { ...first[0]!, again: { n: 1, after: "r1" } } as Need;
    const kept = run({ board: board({ coming: [okRow()] }), stored: board({ needs: [reopened] }) });
    expect(kept).toHaveLength(1);
    expect(needRev(kept[0]!)).toBe(needRev(reopened));
    const answered = new Map([[`${reopened.id}\n${needRev(reopened)}`, NOW.toISOString()]]);
    const after = run({ board: board({ coming: [okRow()] }), stored: board({ needs: [reopened] }), answers: answered });
    expect(after.map((card) => card.again)).toEqual([undefined]);
  });

  it("a Your OK of another repo carries its repo, and the default repo's ask, card and PR number never stand for it", () => {
    const MARKETS = "example-org/third-repo";
    const chats = [{ name: "markets-ui", state: "building", prs: [7], repo: MARKETS, touchedAt: ago(60_000) } as BoardChat];
    const asks = [ask({ id: "a-main", words: "A private ask", status: "in-hand", chat: undefined, prs: [7] })];
    const question = { id: "q-main-7", kind: "question", title: "About PR 7", pr: 7, reply: "text" } as Need;
    const cards = run({ board: board({ needs: [question], chats, coming: [okRow({ pr: 7, chat: "markets-ui", title: "Reports sound pass" })] }), asks });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ title: "Your OK: Reports sound pass", pr: 7, repo: MARKETS, links: [{ url: `https://github.com/${MARKETS}/pull/7` }] });
    // The default repo's card covers the default repo's PR 7 only.
    expect(run({ board: board({ needs: [question], coming: [okRow({ pr: 7, chat: undefined })] }) })).toEqual([]);
    expect(run({ board: board({ coming: [okRow()] }) })[0]!.repo).toBeUndefined();
  });

  it("names no PR on a Your OK whose chat two repos claim, so a yes can land on neither", () => {
    const chats = [
      { name: "shared", state: "building", repo: "example-org/third-repo", touchedAt: ago(60_000) },
      { name: "shared", state: "building", touchedAt: ago(60_000) },
    ] as BoardChat[];
    const [card] = run({ board: board({ chats, coming: [okRow({ pr: 7, chat: "shared" })] }) });
    expect(card).toMatchObject({ title: "Your OK: Daily build v2 sound pass", chat: "shared" });
    expect([card?.pr, card?.repo, card?.links]).toEqual([undefined, undefined, undefined]);
  });

  it("a waiting chat is titled with the ask of its base name, either way round", () => {
    const cards = run({ board: board({ chats: [waitingChat()] }), asks: [ask({ chat: "design-2", prs: [] })] });
    expect(cards.map((card) => card.title)).toEqual(["Question from Cache keys: never forgotten"]);
    const back = run({ board: board({ chats: [waitingChat({ name: "design-2" })] }), asks: [ask({ chat: "design", prs: [] })] });
    expect(back.map((card) => card.title)).toEqual(["Question from Cache keys: never forgotten"]);
  });

  it("an answered wait card speaks for its chat and PR for ANSWER_QUIET_MS after its card has gone", () => {
    const waiting = waitingChat({ name: "build-sound", prs: [483] });
    const [chatCard] = run({ board: board({ chats: [waiting] }) });
    expect(chatCard).toMatchObject({ title: "Which logo, blue or red?", chat: "build-sound" });
    // You answer the chat's card; the chat moves on, its PR's Coming row now waits at Your OK.
    const answered = [{ id: chatCard!.id, at: NOW.toISOString(), repo: NO_REPO, chat: "build-sound" }];
    const moved = waitingChat({ name: "build-sound", prs: [483], state: "building" });
    expect(run({ board: board({ coming: [okRow()], chats: [moved] }), stored: board({ needs: [chatCard!] }), answered })).toEqual([]);
    const later = run({ board: board({ coming: [okRow()], chats: [moved] }), answered, now: new Date(NOW.getTime() + ANSWER_QUIET_MS + 1) });
    expect(later.map((card) => card.title)).toEqual(["Your OK: Daily build v2 sound pass"]);
    // Never its own wait: the card keeps its id, and its answer, while it stays.
    const kept = run({ board: board({ chats: [waiting] }), stored: board({ needs: [chatCard!] }), answered });
    expect(kept.map((card) => card.id)).toEqual([chatCard!.id]);
  });

  it("a Your OK you said yes to is not made again once its card has gone, while its row stays untouched at owner-ok", () => {
    const [card] = run({ board: board({ coming: [okRow()] }) });
    const yeses = new Map([[yesKey(stemOf(card!.id), NO_REPO, 483), NOW.toISOString()]]);
    const later = new Date(NOW.getTime() + ANSWER_QUIET_MS + 1);
    expect(run({ board: board({ coming: [okRow()] }), yeses, now: later })).toEqual([]);
    // Its card still on the board keeps its id, and its answer, as before.
    expect(run({ board: board({ coming: [okRow()] }), stored: board({ needs: [card!] }), yeses, now: later }).map((one) => one.id)).toEqual([card!.id]);
    // Another row's wait is its own; so is the same PR and chat in another repo.
    expect(run({ board: board({ coming: [okRow({ pr: 2484, chat: "build-other" })] }), yeses, now: later })).toHaveLength(1);
    const otherRepo = new Map([[yesKey(stemOf(card!.id), "example-org/third-repo", 483), NOW.toISOString()]]);
    expect(run({ board: board({ coming: [okRow()] }), yeses: otherRepo, now: later })).toHaveLength(1);
    // A yes on a card that named no PR (two repos claimed its chat) is not this card's, which names its PR; the answer
    // still recorded the default repo.
    expect(run({ board: board({ coming: [okRow()] }), yeses: new Map([[yesKey(stemOf(card!.id), NO_REPO, undefined), NOW.toISOString()]]), now: later })).toHaveLength(1);
    // It still speaks for its chat: the chat waiting on the same OK since before his yes is not carded in its place,
    // and one that spoke after it asks afresh.
    expect(run({ board: board({ coming: [okRow()], chats: [waitingChat({ name: "build-sound" })] }), yeses, now: later })).toEqual([]);
    expect(run({ board: board({ coming: [okRow()], chats: [waitingChat({ name: "build-sound", touchedAt: later.toISOString() })] }), yeses, now: later }).map((one) => one.kind)).toEqual(["question"]);
    // A row changed after his yes (it went back to building and returned) asks again.
    expect(run({ board: board({ coming: [okRow({ touchedAt: new Date(NOW.getTime() + 1000).toISOString() })] }), yeses, now: later })).toHaveLength(1);
  });

  it("a reopened wait card keeps the words you reopened, so a board write keeps it reopened", () => {
    const [first] = run({ board: board({ chats: [waitingChat()] }) });
    const reopened = { ...first!, again: { n: 1, after: "r1" } } as Need;
    const waited = run({ board: board({ chats: [waitingChat({ doing: "And the font?" })] }), stored: board({ needs: [reopened] }) });
    expect(waited).toEqual([reopened]);
    // writeBoard's next step keeps Answer again only on an unchanged card.
    expect(withAgain(board({ needs: [reopened] }), board({ needs: waited })).needs.map((card) => card.again)).toEqual([{ n: 1, after: "r1" }]);
  });

  it("a chat is one repo's: another repo's chat of the same name is a wait of its own", () => {
    const MARKETS = "example-org/third-repo";
    const markets = waitingChat({ name: "design", repo: MARKETS });
    // An answer to the default repo chat's card keeps only that chat quiet.
    const answered = [{ id: "wait-chat-old", at: NOW.toISOString(), chat: "design", repo: NO_REPO }];
    expect(run({ board: board({ chats: [markets] }), answered })).toHaveLength(1);
    expect(run({ board: board({ chats: [waitingChat()] }), answered })).toEqual([]);
    // A default repo ask of that chat titles only its own chat's card.
    expect(run({ board: board({ chats: [markets] }), asks: [ask({ chat: "design-2", prs: [] })] }).map((card) => card.title)).toEqual(["Which logo, blue or red?"]);
    // A card that names no repo speaks for its chat in another repo while the default repo has no board chat of its name.
    const question = { id: "q-design", kind: "question", title: "Which logo?", chat: "design", reply: "text" } as Need;
    expect(run({ board: board({ needs: [question], chats: [markets] }) })).toEqual([]);
  });

  it("a card that names no repo speaks for the default repo's chat of its name, never another repo's beside it", () => {
    const MARKETS = "example-org/third-repo";
    const question = { id: "q-lab", kind: "question", title: "Which preview?", chat: "lab", reply: "text" } as Need;
    const software = waitingChat({ name: "lab", state: "building" });
    const markets = waitingChat({ name: "lab", repo: MARKETS, doing: "Ship the Reports lab?" });
    const cards = run({ board: board({ needs: [question], chats: [software, markets] }) });
    expect(cards.map((card) => [card.title, card.repo])).toEqual([["Ship the Reports lab?", MARKETS]]);
    // The default repo's waiting chat stays covered by the card.
    expect(run({ board: board({ needs: [question], chats: [waitingChat({ name: "lab" }), markets] }) }).map((card) => card.repo)).toEqual([MARKETS]);
    // A card naming its repo covers that repo's chat alone.
    expect(run({ board: board({ needs: [{ ...question, repo: MARKETS } as Need], chats: [waitingChat({ name: "lab" }), markets] }) }).map((card) => card.title)).toEqual(["Which logo, blue or red?"]);
  });

  it("two board chats are two waits, whatever their names, and an answer to one keeps only that one quiet", () => {
    const chats = [waitingChat(), waitingChat({ name: "design-2", doing: "And the font?" })];
    expect(run({ board: board({ chats }) }).map((card) => card.title)).toEqual(["Which logo, blue or red?", "And the font?"]);
    const one = [waitingChat({ name: "design-1" }), waitingChat({ name: "design-1-2", doing: "And the font?" })];
    expect(run({ board: board({ chats: one }) })).toHaveLength(2);
    const answered = [{ id: "wait-chat-old", at: NOW.toISOString(), chat: "design", repo: NO_REPO }];
    expect(run({ board: board({ chats }), answered }).map((card) => card.title)).toEqual(["And the font?"]);
    // An answered Your OK's card speaks for its chat's re-spawns too.
    const asked = [{ id: "wait-ok-old", at: NOW.toISOString(), chat: "design-2", repo: NO_REPO }];
    expect(run({ board: board({ chats }), answered: asked })).toEqual([]);
  });

  it("a chat's repo is never read as part of its name", () => {
    const decoy = waitingChat({ name: "decoy", repo: "*\ndesign" } as Partial<BoardChat>);
    const real = waitingChat({ repo: "example-org/third-repo" } as Partial<BoardChat>);
    expect(run({ board: board({ chats: [decoy, real] }) }).map((card) => card.title)).toContain("Which logo, blue or red?");
  });

  it("a Your OK row whose chat two repos claim is titled by either repo's ask of that chat, and names no PR", () => {
    const MARKETS = "example-org/third-repo";
    const chats = [waitingChat({ name: "shared", state: "working", repo: MARKETS } as Partial<BoardChat>), waitingChat({ name: "shared", state: "working" })];
    const cards = run({ board: board({ coming: [okRow({ chat: "shared" })], chats }), asks: [ask({ chat: "shared", repo: MARKETS, prs: [] })] });
    expect(cards.map((card) => [card.title, card.pr])).toEqual([["Your OK: Cache keys: never forgotten", undefined]]);
  });

  it("a Your OK row whose chat two repos claim hides neither repo's own waiting chat", () => {
    const MARKETS = "example-org/third-repo";
    const chats = [waitingChat({ name: "shared" }), waitingChat({ name: "shared", repo: MARKETS, doing: "And the font?" } as Partial<BoardChat>)];
    const titles = run({ board: board({ coming: [okRow({ chat: "shared" })], chats }) }).map((card) => card.title);
    expect(titles).toEqual(expect.arrayContaining(["Which logo, blue or red?", "And the font?"]));
  });

  it("ignores a bare waiting state, a stale row, a merged Your OK row and a done ask", () => {
    expect(
      run({
        board: board({ chats: [waitingChat({ state: "waiting" }), waitingChat({ name: "ci", state: "waiting for CI" }), waitingChat({ name: "old", touchedAt: ago(25 * 3600_000) })], coming: [okRow({ mergedAt: ago(1) })] }),
        asks: [ask({ status: "shipped" })],
      }),
    ).toEqual([]);
  });
});

describe("wait cards on the server", () => {
  let server: TestServer;
  let cookie: string;
  let clock: ReturnType<typeof fakeClock>;
  beforeEach(async () => {
    clock = fakeClock(NOW.getTime());
    server = await startServer({}, { now: clock.now });
    cookie = server.cookie();
  });
  afterEach(async () => {
    await server.close();
  });

  const put = (body: unknown) => fetch(`${server.base}/api/board`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) });
  const read = async () => ((await (await fetch(`${server.base}/api/board`, { headers: { cookie } })).json()) as { version: number; board: Board }).board;
  const waits = async () => (await read()).needs.filter((need) => need.id.startsWith("wait-"));

  it("cards a Your OK row once, pushes it once, and keeps it through whole-board writes that send it back", async () => {
    const pushed = vi.spyOn(server.app.push, "notifyNewNeeds");
    expect((await put(board({ coming: [okRow()] }))).status).toBe(200);
    const [card] = await waits();
    expect(card).toMatchObject({ kind: "decision", title: "Your OK: Daily build v2 sound pass" });
    for (let i = 0; i < 5; i++) expect((await put(await read())).status).toBe(200);
    expect((await waits()).map((need) => need.id)).toEqual([card!.id]);
    const pushedIds = pushed.mock.calls.flatMap(([added]) => added.map((need) => need.id)).filter((id) => id.startsWith("wait-"));
    expect(pushedIds).toEqual([card!.id]);
  });

  it("an answered wait card is not made again or pushed again while its row waits", async () => {
    await put(board({ coming: [okRow()] }));
    const [card] = await waits();
    const reply = await fetch(`${server.base}/api/replies`, {
      method: "POST",
      headers: browser(cookie),
      body: JSON.stringify({ clientId: "client-wait-1", itemId: card!.id, decision: "choice", choice: "Yes", rev: await revOf(server.base, cookie, card!.id) }),
    });
    expect(reply.status).toBe(201);
    const pushed = vi.spyOn(server.app.push, "notifyNewNeeds");
    for (let i = 0; i < 3; i++) await put(await read());
    expect((await waits()).map((need) => need.id)).toEqual([card!.id]);
    expect(pushed.mock.calls.flatMap(([added]) => added)).toEqual([]);
  });

  const answer = async (id: string, choice: string, n: number) =>
    fetch(`${server.base}/api/replies`, {
      method: "POST",
      headers: browser(cookie),
      body: JSON.stringify({ clientId: `client-wait-${n}`, itemId: id, decision: "choice", choice, ...(choice === "Yes" ? {} : { text: "quieter" }), rev: await revOf(server.base, cookie, id) }),
    });
  // An answer takes the real clock's time (store.addReply): the quiet ends past that.
  const pastQuiet = () => clock.advance(Date.now() - clock.now().getTime() + ANSWER_QUIET_MS + 60_000);
  // An agent's card on the row's chat speaks for it, so the wait card leaves the board while its row stays.
  const covering = { id: "c-build", kind: "question", title: "Which mix?", chat: "build-sound" } as Need;

  it("a Your OK answered Yes stays answered after its card leaves the board and the quiet ends", async () => {
    await put(board({ coming: [okRow()] }));
    const [card] = await waits();
    expect((await answer(card!.id, "Yes", 1)).status).toBe(201);
    expect((await put(board({ needs: [covering], coming: [okRow()] }))).status).toBe(200);
    expect(await waits()).toEqual([]);
    pastQuiet();
    expect((await put(board({ coming: [okRow()] }))).status).toBe(200);
    expect(await waits()).toEqual([]);
  });

  it("a Your OK answered Yes asks again once its row has left owner-ok and come back", async () => {
    await put(board({ coming: [okRow()] }));
    const [card] = await waits();
    expect((await answer(card!.id, "Yes", 2)).status).toBe(201);
    pastQuiet();
    expect((await put(board({ coming: [okRow({ stage: "building" })] }))).status).toBe(200);
    expect(await waits()).toEqual([]);
    clock.advance(60_000);
    expect((await put(board({ coming: [okRow({ what: "v3 sound pass" })] }))).status).toBe(200);
    expect((await waits()).map((need) => need.title)).toEqual(["Your OK: Daily build v2 sound pass"]);
  });

  it("a Your OK answered Change it is carded again once the quiet ends", async () => {
    await put(board({ coming: [okRow()] }));
    const [card] = await waits();
    expect((await answer(card!.id, "Change it", 3)).status).toBe(201);
    expect((await put(board({ needs: [covering], coming: [okRow()] }))).status).toBe(200);
    pastQuiet();
    expect((await put(board({ coming: [okRow()] }))).status).toBe(200);
    expect((await waits()).map((need) => need.title)).toEqual(["Your OK: Daily build v2 sound pass"]);
  });

  // An agent's own card for the row's PR: once its answer is 2h old it no longer speaks for the PR.
  const agentCard = (kind: string, id = `${kind}-483`) =>
    ({ id, kind, title: "Daily build v2: merge?", pr: 483, ...(kind === "merge-ready" ? { headSha: "b".repeat(40) } : { options: [{ label: "Yes" }, { label: "No" }] }) }) as Need;
  const agentAnswer = (card: Need, decision: string, { choice }: { choice?: string } = {}) =>
    server.app.store.addReply({
      clientId: `client-${card.id}-${decision}`,
      itemId: card.id,
      itemTitle: card.title,
      decision: decision as never,
      ...(choice ? { choice } : {}),
      rev: needRev(card),
      item: { ...card, repo: NO_REPO } as never,
    });

  it("an agent card's Yes, or a merge-ready card answered no, still lets the Your OK ask after the quiet", async () => {
    const decision = agentCard("decision", "approve-483");
    agentAnswer(decision, "choice", { choice: "Yes" });
    const held = agentCard("merge-ready", "mr-held");
    agentAnswer(held, "reject");
    expect((await put(board({ needs: [decision, held], coming: [okRow()] }))).status).toBe(200);
    expect(await waits()).toEqual([]);
    pastQuiet();
    expect((await put(board({ needs: [decision, held], coming: [okRow()] }))).status).toBe(200);
    expect((await waits()).map((need) => need.title)).toEqual(["Your OK: Daily build v2 sound pass"]);
  });

  it("cards a chat waiting on you in the write that makes it, with no times of its own", async () => {
    expect((await put(board({ chats: [{ name: "logo", state: "waiting on you", doing: "Blue or red?" }] }))).status).toBe(200);
    expect((await waits()).map((need) => need.title)).toEqual(["Blue or red?"]);
  });

  it("an ask at needs-you raises no card of its own", async () => {
    await put(board());
    const send = (method: string, path: string, body: unknown) => fetch(`${server.base}${path}`, { method, headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) });
    expect((await send("POST", "/api/asks", { id: "a-1", words: "Cache keys: never forgotten", stage: "needs-you", note: "Pick a key name" })).status).toBe(201);
    expect((await send("POST", "/api/asks", { id: "a-3", words: "Lobby tiles: new art first", stage: "needs-you", note: "Which tile first?" })).status).toBe(201);
    expect(await waits()).toEqual([]);
  });

  it("pushes nothing for an ask's needs, its moves or its close", async () => {
    await put(board());
    const pushed = vi.spyOn(server.app.push, "notifyNewNeeds");
    const ids = () => pushed.mock.calls.flatMap(([added]) => added.map((need) => need.id));
    const send = (method: string, path: string, body: unknown) => fetch(`${server.base}${path}`, { method, headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) });
    const inHours = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();
    expect((await send("POST", "/api/asks", { id: "a-1", words: "Cache keys: never forgotten", stage: "needs-you", note: "Pick a key name" })).status).toBe(201);
    expect((await send("PATCH", "/api/asks/a-1", { stage: "building" })).status).toBe(200);
    for (const [h, why] of [[1, undefined], [2, "tests were red"], [3, "deploy queue"], [4, "review found a gap"]] as const) expect((await send("PATCH", "/api/asks/a-1", { due: inHours(h), ...(why ? { why } : {}) })).status).toBe(200);
    expect(await waits()).toEqual([]);
    expect((await send("PATCH", "/api/asks/a-1", { stage: "done" })).status).toBe(200);
    expect((await read()).needs).toEqual([]);
    expect(ids()).toEqual([]);
  });

  it("a time moved twice and more raises no Keep going card; every move and its why is still recorded", async () => {
    await put(board());
    const send = (method: string, path: string, body: unknown) => fetch(`${server.base}${path}`, { method, headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) });
    const inHours = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();
    expect((await send("POST", "/api/asks", { id: "a-1", words: "Cache keys: never forgotten", stage: "building", due: inHours(1) })).status).toBe(201);
    expect((await send("PATCH", "/api/asks/a-1", { due: inHours(2), why: "tests were red" })).status).toBe(200);
    expect((await send("PATCH", "/api/asks/a-1", { due: inHours(3), why: "deploy queue" })).status).toBe(200);
    expect((await send("PATCH", "/api/asks/a-1", { due: inHours(4), why: "review found a gap" })).status).toBe(200);
    expect(await waits()).toEqual([]);
    const stored = (await (await send("GET", "/api/asks/a-1", undefined)).json()) as { dueAt: string; dueHistory: { dueAt: string; why?: string }[] };
    expect(stored.dueAt).toBe(inHours(4));
    expect(stored.dueHistory.map((move) => [move.dueAt, move.why])).toEqual([
      [inHours(2), "tests were red"],
      [inHours(3), "deploy queue"],
      [inHours(4), "review found a gap"],
    ]);
  });
});
