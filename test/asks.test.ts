import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GOT_IT, isGotIt } from "../src/shared/answers.js";
import type { Need } from "../src/shared/board.js";
import {
  ASK_STAGES,
  ASK_WHO,
  askPatchSchema,
  doneCardParts,
  doneCardText,
  FINISHED_STAGES,
  MAX_ASK_CHAT,
  MAX_ASK_NOTE,
  MAX_ASK_WHY,
  MAX_DONE_ITEM,
  MAX_DONE_ITEMS,
  MAX_ASK_WORDS,
  MAX_ASKS,
  type Ask,
  type AsksResponse,
} from "../src/shared/asks.js";
// @ts-expect-error the CLI is plain ESM without type declarations
import { run } from "../scripts/rivet.mjs";
import { CommandStore } from "../src/server/commandstore.js";
import { asksPastDue } from "../src/server/asks/late.js";
import { doneCardPoster } from "../src/server/asks/done-card.js";
import { settlePickupAsks } from "../src/server/asks/made.js";
import { syncIssueCloses } from "../src/server/asks/stages.js";
import { ensureAsk } from "../src/server/routes/asks.js";
import { ShortTitles } from "../src/server/short-titles.js";
import type { OpsStatus } from "../src/shared/ops-status.js";
import { askRows } from "../web/src/views/your-asks.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, browser, EXAMPLE_BOARD, fakeClock, putBoard, revOf, startServer, type TestServer } from "./helpers.js";

const START = Date.parse("2026-10-01T02:00:00.000Z");

let server: TestServer;
let cookie: string;
let clock: ReturnType<typeof fakeClock>;

beforeEach(async () => {
  clock = fakeClock(START);
  server = await startServer({}, { now: clock.now });
  cookie = server.cookie();
});

afterEach(async () => {
  await server.close();
});

function send(method: string, path: string, body?: unknown, headers: Record<string, string> = bearer(BOARD_TOKEN)): Promise<Response> {
  return fetch(`${server.base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function create(body: Record<string, unknown>): Promise<Ask> {
  const response = await send("POST", "/api/asks", body);
  expect(response.status).toBe(201);
  return (await response.json()) as Ask;
}

async function page(query = "", headers: Record<string, string> = bearer(BOARD_TOKEN)): Promise<AsksResponse> {
  const response = await send("GET", `/api/asks${query}`, undefined, headers);
  expect(response.status).toBe(200);
  return (await response.json()) as AsksResponse;
}

async function list(query = "", headers: Record<string, string> = bearer(BOARD_TOKEN)): Promise<Ask[]> {
  return (await page(query, headers)).asks;
}

async function get(id: string): Promise<Ask> {
  const response = await send("GET", `/api/asks/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Ask;
}

/** A stored ask, straight into the store, for tests that need hundreds. */
function stored(id: string, createdAt: string, stage: Ask["stage"] = "queued", stageAt = createdAt): Ask {
  const ask: Ask = { id, words: id, who: "owner", stage, prs: [], dueHistory: [], timeline: [{ at: stageAt, stage }], createdAt, stageAt, updatedAt: stageAt, version: 1 };
  expect(server.app.store.addAsk(ask)).toBe(true);
  return ask;
}

describe("asks", () => {
  it("creates an ask with defaults and its first timeline event", async () => {
    const response = await send("POST", "/api/asks", { id: "a-1", words: "Make the cards as big as you can", chat: "checkout", prs: [2550, 2550] });
    expect(response.status).toBe(201);
    expect(response.headers.get("etag")).toBe('"1"');
    const ask = (await response.json()) as Ask;
    expect(ask).toEqual({
      id: "a-1",
      words: "Make the cards as big as you can",
      who: "owner",
      stage: "queued",
      chat: "checkout",
      prs: [2550],
      dueHistory: [],
      timeline: [{ at: "2026-10-01T02:00:00.000Z", stage: "queued" }],
      createdAt: "2026-10-01T02:00:00.000Z",
      stageAt: "2026-10-01T02:00:00.000Z",
      updatedAt: "2026-10-01T02:00:00.000Z",
      version: 1,
    });
  });

  it("takes an import's date and note, and refuses a taken id with 409", async () => {
    const ask = await create({ id: "l-8", words: "x", stage: "shipped", createdAt: "2026-09-30T00:00:00Z", note: "LIVE 11:45Z", who: "owner" });
    expect(ask.createdAt).toBe("2026-09-30T00:00:00.000Z");
    expect(ask.timeline).toEqual([{ at: "2026-09-30T00:00:00.000Z", stage: "shipped", note: "LIVE 11:45Z" }]);
    const again = await send("POST", "/api/asks", { id: "l-8", words: "y" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toMatch(/already exists/);
  });

  it("refuses a date whose offset Date cannot read with 400, not 500", async () => {
    for (const createdAt of ["2026-09-30T00:00:00+99:99", "2026-09-30T00:00:00+14:01", "2026-09-30T00:00:00+05:60"]) {
      expect((await send("POST", "/api/asks", { id: "l-9", words: "x", createdAt })).status, createdAt).toBe(400);
    }
    expect((await create({ id: "l-9", words: "x", createdAt: "2026-09-30T00:00:00-12:00" })).createdAt).toBe("2026-09-30T12:00:00.000Z");
  });

  it("refuses invalid bodies with 400", async () => {
    for (const body of [
      { id: "A-1", words: "x" },
      { id: "a-1", words: "   " },
      { id: "a-1", words: "x", status: "done" },
      { id: "a-1", words: "x", stage: "open" },
      { id: "a-1", words: "x", card: "c-1" },
      { id: "a-1", words: "x", why: "two\nlines" },
      { id: "a-1", words: "x", why: "y".repeat(MAX_ASK_WHY + 1) },
      { id: "a-1", words: "x", progress: 1.5 },
      { id: "a-1", words: "x", who: "sam" },
      { id: "a-1", words: "x", extra: true },
      { id: "a-1", words: "x".repeat(4001) },
      { id: "a-1", words: "x", chat: "two\nlines" },
      { id: "a-1", words: "clear \x1b[2J screen" },
      { id: "a-1", words: "bell\x07" },
      { id: "a-1", words: "c1 \x9b31m" },
      { id: "a-1", words: "x", chat: "a\x07" },
      { id: "a-1", words: "x", note: "carriage\rreturn" },
      { id: "a-1", words: "x", by: "\u202eevil" },
    ]) {
      expect((await send("POST", "/api/asks", body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect((await send("POST", "/api/asks", "not json")).status).toBe(400);
    expect(await list()).toEqual([]);
    // Words and notes may still run over lines.
    expect((await create({ id: "a-1", words: "one\ntwo", note: "three\nfour" })).words).toBe("one\ntwo");
    expect((await send("PATCH", "/api/asks/a-1", { note: "esc \x1b]0;title\x07" })).status).toBe(400);
  });

  it("caps the body", async () => {
    const response = await send("POST", "/api/asks", { id: "a-1", words: "x", note: "y".repeat(70 * 1024) });
    expect(response.status).toBe(413);
  });

  it("lists newest first and filters by stage, or by an old status word as its stage", async () => {
    await create({ id: "a-1", words: "one" });
    clock.advance(60_000);
    await create({ id: "a-2", words: "two", stage: "building" });
    clock.advance(60_000);
    await create({ id: "a-3", words: "three" });
    expect((await list()).map((ask) => ask.id)).toEqual(["a-3", "a-2", "a-1"]);
    expect((await list("?stage=queued")).map((ask) => ask.id)).toEqual(["a-3", "a-1"]);
    expect((await send("GET", "/api/asks?stage=finished")).status).toBe(400);
  });

  it("merges a change, appends stage and note events, and bumps the version", async () => {
    await create({ id: "a-1", words: "Card glow", prs: [2606] });
    clock.advance(60_000);
    const response = await send("PATCH", "/api/asks/a-1", { stage: "building", chat: "banana-round2", prs: [2605, 2606], note: "relayed", by: "monitor" });
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"2"');
    const ask = (await response.json()) as Ask;
    expect(ask).toMatchObject({ stage: "building", chat: "banana-round2", prs: [2606, 2605], version: 2, updatedAt: "2026-10-01T02:01:00.000Z" });
    expect(ask.timeline.at(-1)).toEqual({ at: "2026-10-01T02:01:00.000Z", stage: "building", note: "relayed", by: "monitor" });

    // A note alone appends a note event; the same stage again appends nothing.
    const noted = (await (await send("PATCH", "/api/asks/a-1", { note: "stills due" })).json()) as Ask;
    expect(noted.timeline.at(-1)).toEqual({ at: "2026-10-01T02:01:00.000Z", note: "stills due" });
    const same = (await (await send("PATCH", "/api/asks/a-1", { stage: "building" })).json()) as Ask;
    expect(same.timeline).toHaveLength(3);
    expect(same.version).toBe(4);

    // null removes an optional field.
    const parked = (await (await send("PATCH", "/api/asks/a-1", { stage: "parked", issue: 2666, chat: null })).json()) as Ask;
    expect(parked.chat).toBeUndefined();
    expect(parked).toMatchObject({ stage: "parked", issue: 2666 });
    expect(await get("a-1")).toEqual(parked);
    // The list carries only the last event.
    expect((await list())[0]).toEqual({ ...parked, timeline: parked.timeline.slice(-1), short: expect.any(String) });
  });

  describe("the done card", () => {
    type Card = Record<string, unknown> & { id: string };
    const needs = async () => ((await (await send("GET", "/api/board")).json()) as { board: { needs: Card[] } | null }).board?.needs ?? [];
    const patch = async (id: string, change: Record<string, unknown>) => expect((await send("PATCH", `/api/asks/${id}`, change)).status).toBe(200);

    const cardOf = async (id: string) => (await needs()).find((card) => card.id === `ask-${id}-done`);
    const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(64, 3)]);

    it("a close to done posts one silent Got it card in the ask's conversation, what he asked then its close note, and no PR", async () => {
      const notifyNewNeeds = vi.spyOn(server.app.push, "notifyNewNeeds");
      await create({ id: "a-9", words: "Docs Sync round two look", chat: "search-box-2", prs: [4050], replyId: "m-77" });
      await patch("a-9", { note: "first pass" });
      await patch("a-9", { stage: "done", note: "The round two look is on the Lab." });
      const cards = await needs();
      expect(cards).toHaveLength(1);
      const card = cards[0]!;
      expect(card).toMatchObject({ id: "ask-a-9-done", kind: "decision", ask: "You asked: Docs Sync round two look\nDone: The round two look is on the Lab.", options: [{ label: "Got it" }], push: "fyi", chat: "search-box-2", replyTo: "m-77" });
      expect(card.title).toMatch(/^Done: /);
      expect(card.pr).toBeUndefined();
      // A Got it card, which Needs you does not count.
      expect(isGotIt(card as unknown as Need)).toBe(true);
      expect(notifyNewNeeds).toHaveBeenCalled();
      for (const [added] of notifyNewNeeds.mock.calls) expect(added.map((need) => need.id)).not.toContain("ask-a-9-done");
      notifyNewNeeds.mockRestore();
    });

    it("set --stage done posts it too: its Done line is this move's note, folded to one short line, never an older note; with none it is what he asked alone, never Finished.", async () => {
      await create({ id: "a-10", words: "Lobby chart", repo: "example-org/other-repo" });
      await create({ id: "a-11", words: "Long one" });
      await patch("a-10", { note: "an older note" });
      await patch("a-10", { stage: "done" });
      await patch("a-11", { stage: "done", note: `first line\n\n  ${"word ".repeat(60)}` });
      const cards = await needs();
      expect(cards.find((card) => card.id === "ask-a-10-done")).toMatchObject({ ask: "You asked: Lobby chart", repo: "example-org/other-repo" });
      for (const card of cards) expect(card.ask).not.toContain("Finished.");
      const [asked, line, ...more] = (cards.find((card) => card.id === "ask-a-11-done")!.ask as string).split("\n");
      expect(asked).toBe("You asked: Long one");
      expect(more).toEqual([]);
      expect(line).toMatch(/^Done: first line word word /);
      expect(line!.slice("Done: ".length)).toHaveLength(160);
      expect(line!.endsWith("…")).toBe(true);
    });

    it("with no note and no done items the Done line is the ask's last why; a note comes before the why", async () => {
      const due = new Date(clock.now().getTime() + 3_600_000).toISOString();
      await create({ id: "a-30", words: "Bigger cards", due });
      await create({ id: "a-31", words: "Smaller chips", due });
      for (const id of ["a-30", "a-31"]) await patch(id, { due: new Date(clock.now().getTime() + 7_200_000).toISOString(), why: "The art took one more pass" });
      expect((await get("a-30")).why).toBe("The art took one more pass");
      await patch("a-30", { stage: "done" });
      await patch("a-31", { stage: "done", note: "The chips are smaller on the Lab." });
      expect((await cardOf("a-30"))!.ask).toBe("You asked: Bigger cards\nDone: The art took one more pass");
      expect((await cardOf("a-31"))!.ask).toBe("You asked: Smaller chips\nDone: The chips are smaller on the Lab.");
    });

    it("the closer's done items are what is done: one on the Done line, two or three as - lines, before the note", async () => {
      for (const id of ["a-32", "a-33", "a-34"]) await create({ id, words: `Ask ${id}` });
      await patch("a-32", { stage: "done", done: ["The banner chart shows a week"], note: "not this" });
      await patch("a-33", { stage: "done", done: ["One", "Two"] });
      await patch("a-34", { stage: "done", done: ["One", "Two", "Three"], note: "not this" });
      expect((await cardOf("a-32"))!.ask).toBe("You asked: Ask a-32\nDone: The banner chart shows a week");
      expect((await cardOf("a-33"))!.ask).toBe("You asked: Ask a-33\nDone:\n- One\n- Two");
      expect((await cardOf("a-34"))!.ask).toBe("You asked: Ask a-34\nDone:\n- One\n- Two\n- Three");
      // The items are the card's alone: the ask keeps none of them.
      expect(JSON.stringify(await get("a-34"))).not.toContain("Three");
    });

    it("what he asked is folded to one line and clipped to 160 with an ellipsis", async () => {
      await create({ id: "a-35", words: `Make it\n\n  bigger   and ${"wider ".repeat(60)}` });
      await create({ id: "a-36", words: "Two\nlines" });
      await patch("a-35", { stage: "done", done: ["Bigger"] });
      await patch("a-36", { stage: "done" });
      const [asked, done] = ((await cardOf("a-35"))!.ask as string).split("\n");
      expect(asked).toMatch(/^You asked: Make it bigger and wider wider /);
      expect(asked!.slice("You asked: ".length)).toHaveLength(160);
      expect(asked!.endsWith("…")).toBe(true);
      expect(done).toBe("Done: Bigger");
      expect((await cardOf("a-36"))!.ask).toBe("You asked: Two lines");
    });

    it("done and doneMedia are refused with 400 unless the same write moves the ask to done, and so are a 4th item, a two-line item and media that is not one still or clip", async () => {
      await create({ id: "a-37", words: "Refused" });
      const still = { kind: "stills", stills: [{ sha256: sha(PNG), type: "image/png" }] };
      const clip = { sha256: "a".repeat(64), type: "video/mp4" };
      for (const body of [
        { done: ["A"] },
        { doneMedia: still },
        { stage: "building", done: ["A"] },
        { stage: "shipped", doneMedia: still },
        { note: "x", done: ["A"], doneMedia: still },
        { stage: "done", done: [] },
        { stage: "done", done: ["1", "2", "3", "4"] },
        { stage: "done", done: ["two\nlines"] },
        { stage: "done", done: ["   "] },
        { stage: "done", done: ["x".repeat(MAX_DONE_ITEM + 1)] },
        { stage: "done", doneMedia: { kind: "before-after", before: clip, after: clip } },
        { stage: "done", doneMedia: { kind: "stills" } },
      ]) {
        expect((await send("PATCH", "/api/asks/a-37", body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
      }
      expect((await get("a-37")).stage).toBe("queued");
      expect(await needs()).toEqual([]);
      // Each rule is its own refusal, not a malformed body.
      const why = (body: unknown) => askPatchSchema.safeParse(body).error?.issues.map((issue) => issue.message) ?? [];
      expect(why({ done: ["A"] })).toEqual(["done and doneMedia go with a move to done"]);
      expect(why({ stage: "done", doneMedia: { kind: "before-after", before: clip, after: clip } })).toEqual(["doneMedia is one still or one clip"]);
      expect(why({ stage: "done", done: ["two\nlines"] })).toEqual(["a done item is one line"]);
      expect(why({ stage: "done", done: ["x".repeat(MAX_DONE_ITEM)], doneMedia: { kind: "video", after: clip } })).toEqual([]);
      expect(MAX_DONE_ITEMS).toBe(3);
    });

    it("an uploaded still given as doneMedia rides on the card", async () => {
      const upload = await fetch(`${server.base}/api/bridge/media/${sha(PNG)}`, { method: "PUT", headers: { ...bearer(BOARD_TOKEN), "content-type": "image/png" }, body: new Uint8Array(PNG) });
      expect(upload.status).toBe(201);
      await create({ id: "a-38", words: "Show me the banner" });
      const media = { kind: "stills", stills: [{ sha256: sha(PNG), type: "image/png" }] };
      await patch("a-38", { stage: "done", done: ["The banner is on the Lab"], doneMedia: media });
      expect(await cardOf("a-38")).toMatchObject({ ask: "You asked: Show me the banner\nDone: The banner is on the Lab", media });
      expect((await get("a-38")) as Record<string, unknown>).not.toHaveProperty("doneMedia");
    });

    it("media the board refuses (never uploaded) does not cost the card: it posts without it, and is logged", async () => {
      const logs: string[] = [];
      await server.close();
      server = await startServer({}, { now: clock.now, logs });
      await create({ id: "a-39", words: "Lost still" });
      const missing = "b".repeat(64);
      await patch("a-39", { stage: "done", done: ["Shipped"], doneMedia: { kind: "stills", stills: [{ sha256: missing, type: "image/png" }] } });
      const card = (await cardOf("a-39"))!;
      expect(card.ask).toBe("You asked: Lost still\nDone: Shipped");
      expect(card.media).toBeUndefined();
      expect(logs.filter((line) => line.includes("ask-a-39-done"))).toEqual([expect.stringMatching(/done card ask-a-39-done posted without its media: .*bbbbbbbbbbbb.* not on the server/)]);
    });

    it("the poster retries once without media, and a card refused for another reason is logged as refused", () => {
      const calls: Card[] = [];
      const logs: string[] = [];
      const at = clock.now().toISOString();
      const ask = (id: string, stage: Ask["stage"]): Ask => ({ id, words: id, who: "owner", stage, prs: [], dueHistory: [], timeline: [{ at, stage }], createdAt: at, stageAt: at, updatedAt: at, version: 1 });
      const media = { kind: "stills" as const, stills: [{ sha256: "c".repeat(64), type: "image/png" as const }] };
      const poster = (addUpdate: (card: Card) => { status: number; error?: string }) =>
        doneCardPoster({ store: server.app.store, addUpdate: (card) => (calls.push(card), addUpdate(card)), titles: { of: (words) => words }, logger: { error: (line: string) => void logs.push(line) }, now: clock.now });
      poster((card) => (card.media ? { status: 400, error: "bad media" } : { status: 200 }))(ask("a-40", "building"), ask("a-40", "done"), { done: ["A"], media });
      expect(calls.map((card) => card.media)).toEqual([media, undefined]);
      expect(calls[1]).toEqual({ ...calls[0], media: undefined });
      expect(calls[1]!.ask).toBe("You asked: a-40\nDone: A");
      expect(logs).toEqual(["[board] done card ask-a-40-done posted without its media: bad media"]);
      // Already on the board (409) and a card with no media are not retried.
      calls.length = logs.length = 0;
      poster(() => ({ status: 409 }))(ask("a-41", "building"), ask("a-41", "done"), { media });
      poster(() => ({ status: 507, error: "the board is full of question cards" }))(ask("a-42", "building"), ask("a-42", "done"), "a note");
      expect(calls.map((card) => card.id)).toEqual(["ask-a-41-done", "ask-a-42-done"]);
      expect(logs).toEqual(["[board] done card ask-a-42-done refused: the board is full of question cards"]);
      // Refused with its media and again without: it never posted, so only the refusal is logged.
      calls.length = logs.length = 0;
      poster((card) => (card.media ? { status: 400, error: "bad media" } : { status: 507, error: "the board is full of question cards" }))(ask("a-43", "building"), ask("a-43", "done"), { done: ["A"], media });
      expect(calls.map((card) => card.media)).toEqual([media, undefined]);
      expect(logs).toEqual(["[board] done card ask-a-43-done refused: the board is full of question cards"]);
    });

    it("an ask the owner did not make (a pick-up) reads Asked:, their own You asked:", () => {
      const added: Card[] = [];
      const done = doneCardPoster({ store: server.app.store, addUpdate: (card) => (added.push(card), { status: 200 }), titles: { of: (words) => words }, logger: console, now: clock.now });
      const at = clock.now().toISOString();
      const ask = (id: string, who: Ask["who"], stage: Ask["stage"]): Ask => ({ id, words: `Words ${id}`, who, stage, prs: [], dueHistory: [], timeline: [{ at, stage }], createdAt: at, stageAt: at, updatedAt: at, version: 1 });
      done(ask("a-50", "rivet", "building"), ask("a-50", "rivet", "done"), { done: ["One", "Two"] });
      done(ask("a-51", "rivet", "building"), ask("a-51", "rivet", "done"), "Fixed");
      done(ask("a-52", "rivet", "building"), ask("a-52", "rivet", "done"));
      const own = (stage: Ask["stage"]) => ask("a-53", "owner", stage);
      done(own("building"), own("done"), "Fixed");
      expect(added.map((card) => card.ask)).toEqual(["Asked: Words a-50\nDone:\n- One\n- Two", "Asked: Words a-51\nDone: Fixed", "Asked: Words a-52", "You asked: Words a-53\nDone: Fixed"]);
      expect(doneCardParts(added[0]!.ask as string)).toEqual({ asked: "Words a-50", done: ["One", "Two"], own: false });
    });

    it("a Yes to found work is in the server's words, so it reads Asked:; a fallback line with any word the word rules ban is left out", () => {
      const added: Card[] = [];
      const done = doneCardPoster({ store: server.app.store, addUpdate: (card) => (added.push(card), { status: 200 }), titles: { of: (words) => words }, logger: console, now: clock.now });
      const at = clock.now().toISOString();
      const ask = (id: string, stage: Ask["stage"], more: Partial<Ask> = {}): Ask => ({ id, words: `Words ${id}`, who: "owner", stage, prs: [], dueHistory: [], timeline: [{ at, stage }], createdAt: at, stageAt: at, updatedAt: at, version: 1, ...more });
      done(ask("a-60", "building", { source: "backlog:rivet#12" }), ask("a-60", "done", { source: "backlog:rivet#12" }), "Fixed");
      for (const [n, text] of ["It is live", "Orders refunded", "Rivet restarted"].entries()) {
        done(ask(`a-6${n + 1}`, "building"), ask(`a-6${n + 1}`, "done", { why: text }));
        done(ask(`a-7${n + 1}`, "building"), ask(`a-7${n + 1}`, "done"), text);
      }
      expect(added[0]!.ask).toBe("Asked: Words a-60\nDone: Fixed");
      expect(added.slice(1).map((card) => card.ask)).toEqual(added.slice(1).map((card) => `You asked: Words ${(card.id as string).slice(4, -5)}`));
      expect(added).toHaveLength(7);
    });

    it("a note or a why with a word the card may not say is left off: a skipped note falls to the why, and with neither the card is the ask alone", () => {
      const added: Card[] = [];
      const done = doneCardPoster({ store: server.app.store, addUpdate: (card) => (added.push(card), { status: 200 }), titles: { of: (words) => words }, logger: console, now: clock.now });
      const at = clock.now().toISOString();
      let n = 60;
      const lineOf = (note: string | undefined, why?: string): string => {
        const id = `a-${n++}`;
        const ask = (stage: Ask["stage"]): Ask => ({ id, words: "Bigger cards", who: "owner", stage, prs: [], dueHistory: [], timeline: [{ at, stage }], createdAt: at, stageAt: at, updatedAt: at, version: 1, ...(why ? { why } : {}) });
        done(ask("building"), ask("done"), note);
        return (added.at(-1)!.ask as string).slice("You asked: Bigger cards".length);
      };
      for (const banned of ["The cards are live", "LIVE on the site", "Order refunded", "refund sent", "Refunds work", "refunding now", "Posted through Rivet", "rivet card"]) {
        expect(lineOf(banned), banned).toBe("");
        expect(lineOf(undefined, banned), `why: ${banned}`).toBe("");
        expect(lineOf(banned, "The art took one more pass"), `note then why: ${banned}`).toBe("\nDone: The art took one more pass");
      }
      expect(lineOf("It is live", "Order refunded")).toBe("");
      expect(lineOf("The art took one more pass", "It is live")).toBe("\nDone: The art took one more pass");
      // Whole words only.
      for (const fine of ["Delivered and alive", "Livestream fixed", "Refundable order shown"]) expect(lineOf(fine), fine).toBe(`\nDone: ${fine}`);
      expect(added).toHaveLength(n - 60);
    });

    it("done or doneMedia on an ask that is already done is refused with 400 and posts no second card; a plain move to done again is still 200", async () => {
      await create({ id: "a-44", words: "Closed once" });
      await patch("a-44", { stage: "done", done: ["First"] });
      const first = await needs();
      expect(first.map((card) => card.ask)).toEqual(["You asked: Closed once\nDone: First"]);
      const version = (await get("a-44")).version;
      for (const body of [
        { stage: "done", done: ["Second"] },
        { stage: "done", doneMedia: { kind: "stills", stills: [{ sha256: sha(PNG), type: "image/png" }] } },
      ]) {
        const refused = await send("PATCH", "/api/asks/a-44", body);
        expect(refused.status, JSON.stringify(body).slice(0, 60)).toBe(400);
        expect(((await refused.json()) as { error: string }).error).toContain("already done");
      }
      expect((await get("a-44")).version).toBe(version);
      await patch("a-44", { stage: "done" });
      await patch("a-44", { stage: "done", note: "again" });
      expect(await needs()).toEqual(first);
    });

    it("doneCardParts reads doneCardText back, and is null for a card from before it and any other text", () => {
      for (const items of [[], ["One thing"], ["One", "Two"], ["One", "Two", "Three"]]) {
        expect(doneCardParts(doneCardText("Make it bigger", items)), String(items.length)).toEqual({ asked: "Make it bigger", done: items, own: true });
        expect(doneCardParts(doneCardText("Make it bigger", items, false)), `not own ${items.length}`).toEqual({ asked: "Make it bigger", done: items, own: false });
      }
      expect(doneCardText("x", [], false)).toBe("Asked: x");
      expect(doneCardText("x", ["a", "b"], false)).toBe("Asked: x\nDone:\n- a\n- b");
      expect(doneCardParts("Asked:")).toBeNull();
      expect(doneCardParts("Asked: x\nDone:")).toBeNull();
      expect(doneCardText("x", [])).toBe("You asked: x");
      expect(doneCardText("x", ["a"])).toBe("You asked: x\nDone: a");
      expect(doneCardText("x", ["a", "b", "c"])).toBe("You asked: x\nDone:\n- a\n- b\n- c");
      for (const text of ["Finished.", "", "shipped to the Lab", "You asked:", "Done: it", "You asked: x\nand more", "You asked: x\nDone:", "You asked: x\nDone:\n- a\nb", "You asked: x\nDone: a\n- b", "- one\n- two"]) {
        expect(doneCardParts(text), JSON.stringify(text)).toBeNull();
      }
    });

    it("an issue close and a fixed pick-up moving an ask into done post it through the same helper, the move's note the line", () => {
      const added: Card[] = [];
      const done = doneCardPoster({ store: server.app.store, addUpdate: (card) => (added.push(card), { status: 200 }), titles: { of: (words) => words }, logger: console, now: clock.now });
      const at = clock.now().toISOString();
      const base = { who: "owner" as const, prs: [], dueHistory: [], createdAt: at, stageAt: at, updatedAt: at, version: 1 };
      server.app.store.addAsk({ ...base, id: "a-20", words: "Backlog fix", source: "backlog:example-org/example-repo#41", issue: 41, stage: "building", timeline: [{ at, stage: "building" }] });
      server.app.store.addAsk({ ...base, id: "a-21", words: "Fix ci ci_1", who: "rivet", source: "pickup:ci/ci_1", stage: "building", timeline: [{ at, stage: "building" }] });
      syncIssueCloses(server.app.store, [{ repo: "example-org/example-repo", closed: [{ number: 41, closedAt: at, reason: "completed" }] }], clock.now(), done);
      settlePickupAsks(server.app.store, [{ kind: "ci", key: "ci_1", state: "fixed" } as OpsStatus], clock.now(), done);
      expect(added.map((card) => [card.id, card.title, card.ask])).toEqual([
        ["ask-a-20-done", "Done: Backlog fix", "Asked: Backlog fix\nDone: Issue #41 closed"],
        ["ask-a-21-done", "Done: Fix ci ci_1", "Asked: Fix ci ci_1"],
      ]);
    });

    it("a title that throws still answers the close 200, and is logged", async () => {
      const logs: string[] = [];
      await server.close();
      server = await startServer({}, { now: clock.now, logs });
      await create({ id: "a-15", words: "Title breaks" });
      const of = vi.spyOn(ShortTitles.prototype, "of").mockImplementation(() => {
        throw new Error("titles down");
      });
      await patch("a-15", { stage: "done" });
      of.mockRestore();
      expect((await get("a-15")).stage).toBe("done");
      expect(await needs()).toEqual([]);
      expect(logs).toContainEqual(expect.stringContaining("done card ask-a-15-done failed: titles down"));
    });

    it("comes once per ask: a second done, done to live to done, and after Got it post nothing more", async () => {
      await create({ id: "a-12", words: "Once only" });
      await patch("a-12", { stage: "done" });
      const first = await needs();
      expect(first.map((card) => card.id)).toEqual(["ask-a-12-done"]);
      await patch("a-12", { stage: "done", note: "again" });
      await patch("a-12", { stage: "shipped" });
      await patch("a-12", { stage: "done", note: "back" });
      expect(await needs()).toEqual(first);
      // Tapped Got it, the card leaves; another done does not bring it back.
      const answer = await fetch(`${server.base}/api/replies`, {
        method: "POST",
        headers: browser(cookie),
        body: JSON.stringify({ clientId: "client-done-1", itemId: "ask-a-12-done", decision: "choice", choice: GOT_IT, rev: await revOf(server.base, cookie, "ask-a-12-done") }),
      });
      expect(answer.status).toBe(201);
      expect(await needs()).toEqual([]);
      await patch("a-12", { stage: "shipped" });
      await patch("a-12", { stage: "done" });
      expect(await needs()).toEqual([]);
    });

    it("a card that fails still closes the ask, and is logged", async () => {
      const logs: string[] = [];
      await server.close();
      server = await startServer({}, { now: clock.now, logs });
      await create({ id: "a-13", words: "Closes anyway" });
      const putBoard = vi.spyOn(server.app.store, "putBoard").mockImplementation(() => {
        throw new Error("disk full");
      });
      await patch("a-13", { stage: "done" });
      putBoard.mockRestore();
      expect((await get("a-13")).stage).toBe("done");
      expect(logs).toContainEqual(expect.stringContaining("done card ask-a-13-done failed: disk full"));
    });

    it("a stage that is not done posts nothing, and Done today still reads the stage", async () => {
      await create({ id: "a-14", words: "Not done yet", replyId: "m-78" });
      for (const stage of ["building", "needs-you", "parked", "shipped"]) await patch("a-14", { stage, ...(stage === "parked" ? { issue: 12 } : {}) });
      expect(await needs()).toEqual([]);
      const done = askRows(await list(), clock.now().getTime()).finished.map((row) => row.id);
      expect(done).toContain("a-14");
    });
  });

  it("an ask closed past its due time never comes back as overdue", async () => {
    await create({ id: "a-12", words: "Late one", due: new Date(clock.now().getTime() + 60_000).toISOString() });
    clock.advance(120_000);
    expect(asksPastDue(await list(), clock.now()).map((ask) => ask.id)).toEqual(["a-12"]);
    expect((await send("PATCH", "/api/asks/a-12", { stage: "done" })).status).toBe(200);
    expect(asksPastDue(await list(), clock.now())).toEqual([]);
    clock.advance(3_600_000);
    expect(asksPastDue(await list(), clock.now())).toEqual([]);
    expect((await get("a-12")).stage).toBe("done");
  });

  it("keeps the timeline to its last 100 events, and stageAt past them", async () => {
    await create({ id: "a-1", words: "x" });
    clock.advance(60_000);
    expect((await send("PATCH", "/api/asks/a-1", { stage: "shipped" })).status).toBe(200);
    clock.advance(60_000);
    for (let i = 0; i < 101; i++) expect((await send("PATCH", "/api/asks/a-1", { note: `n${i}` })).status).toBe(200);
    const ask = await get("a-1");
    expect(ask.timeline).toHaveLength(100);
    expect(ask.timeline[0]).toMatchObject({ note: "n1" });
    expect(ask.timeline.at(-1)).toMatchObject({ note: "n100" });
    expect(ask.timeline.some((event) => event.stage)).toBe(false);
    expect(ask.stageAt).toBe("2026-10-01T02:01:00.000Z");
    // A note is not a stage change; a new stage is.
    expect(ask.updatedAt).toBe("2026-10-01T02:02:00.000Z");
    clock.advance(60_000);
    expect(((await (await send("PATCH", "/api/asks/a-1", { stage: "parked", issue: 1 })).json()) as Ask).stageAt).toBe("2026-10-01T02:03:00.000Z");
  });

  it("lists what is moving, then what finished in the last 3 days, newest first, at most 500", async () => {
    const day = 86_400_000;
    const iso = (ms: number) => new Date(START - ms).toISOString();
    stored("old-open", iso(30 * day));
    stored("old-live", iso(30 * day), "shipped", iso(4 * day));
    stored("recent-live", iso(30 * day), "shipped", iso(2 * day));
    stored("old-parked", iso(10 * day), "parked", iso(3 * day + 60_000));
    stored("new-merged", iso(60_000), "done");
    expect((await list()).map((ask) => ask.id)).toEqual(["old-open", "new-merged", "recent-live"]);
    expect((await list("?stage=shipped")).map((ask) => ask.id)).toEqual(["recent-live"]);
    expect((await list("?all=1")).map((ask) => ask.id)).toEqual(["new-merged", "old-parked", "recent-live", "old-open", "old-live"]);

    // 500 asks finished yesterday never push an old open ask out of the bounded list.
    for (let i = 0; i < 500; i++) stored(`b-${i}`, iso(i), "shipped", iso(day));
    const bounded = await page();
    expect(bounded.asks).toHaveLength(500);
    expect(bounded.asks.slice(0, 2).map((ask) => ask.id)).toEqual(["old-open", "b-0"]);
    expect(bounded.next).toBeUndefined();
  });

  it("pages through every ask with all=1, ties broken by id", async () => {
    const same = new Date(START - 60_000).toISOString();
    for (const id of ["l-1", "l-2", "l-3", "l-4", "l-5"]) stored(id, same, "shipped");
    stored("a-1", new Date(START).toISOString());
    const seen: string[] = [];
    let next: string | undefined;
    for (let n = 0; n < 5; n++) {
      const result = await page(`?all=1&limit=2${next ? `&before=${encodeURIComponent(next)}` : ""}`);
      seen.push(...result.asks.map((ask) => ask.id));
      next = result.next;
      if (!next) break;
    }
    expect(seen).toEqual(["a-1", "l-5", "l-4", "l-3", "l-2", "l-1"]);
    expect((await send("GET", "/api/asks?all=1&limit=501")).status).toBe(400);
    expect((await send("GET", "/api/asks?all=1&limit=0")).status).toBe(400);
    expect((await send("GET", "/api/asks?all=1&before=nonsense")).status).toBe(400);
    expect((await send("GET", `/api/asks?before=${encodeURIComponent(`${same},l-3`)}`)).status).toBe(400);
  });

  it("serves one ask in full by id", async () => {
    await create({ id: "a-1", words: "x" });
    expect((await get("a-1")).id).toBe("a-1");
    expect((await send("GET", "/api/asks/a-2")).status).toBe(404);
    expect((await send("GET", "/api/asks/Bad%20Id")).status).toBe(404);
    expect((await send("GET", "/api/asks/a-1", undefined, browser(cookie))).status).toBe(200);
    expect((await send("GET", "/api/asks/a-1", undefined, {})).status).toBe(401);
  });

  it("answers 507 once it holds 5000 asks", async () => {
    const at = new Date(START).toISOString();
    for (let i = 0; i < MAX_ASKS; i++) stored(`f-${i}`, at);
    const full = await send("POST", "/api/asks", { id: "a-1", words: "x" });
    expect(full.status).toBe(507);
    expect(((await full.json()) as { error: string }).error).toBe("Rivet Agents holds at most 5000 asks");
  });

  it("keeps an ask's repo for its PR links, and drops it on null", async () => {
    const ask = await create({ id: "a-1", words: "x", prs: [31], repo: "example-org/quote" });
    expect(ask.repo).toBe("example-org/quote");
    const moved = (await (await send("PATCH", "/api/asks/a-1", { repo: "example-org/Other-Repo" })).json()) as Ask;
    expect(moved.repo).toBe("example-org/Other-Repo");
    expect(((await (await send("PATCH", "/api/asks/a-1", { repo: null })).json()) as Ask).repo).toBeUndefined();
  });

  it("honours If-Match with 409 when stale", async () => {
    await create({ id: "a-1", words: "x" });
    expect((await send("PATCH", "/api/asks/a-1", { note: "one" }, { ...bearer(BOARD_TOKEN), "if-match": '"1"' })).status).toBe(200);
    const stale = await send("PATCH", "/api/asks/a-1", { note: "two" }, { ...bearer(BOARD_TOKEN), "if-match": "1" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "ask version is stale", version: 2 });
    expect((await send("PATCH", "/api/asks/a-1", { note: "two" }, { ...bearer(BOARD_TOKEN), "if-match": "abc" })).status).toBe(400);
    expect((await get("a-1")).timeline).toHaveLength(2);
  });

  it("answers 404 for an unknown or malformed id and 400 for a bad change", async () => {
    expect((await send("PATCH", "/api/asks/a-9", { note: "x" })).status).toBe(404);
    expect((await send("PATCH", "/api/asks/Bad%20Id", { note: "x" })).status).toBe(404);
    expect((await send("PATCH", "/api/asks/a-1/more", { note: "x" })).status).toBe(404);
    await create({ id: "a-1", words: "x" });
    expect((await send("PATCH", "/api/asks/a-1", { status: "done" })).status).toBe(400);
    expect((await send("PATCH", "/api/asks/a-1", { stage: "merged" })).status).toBe(400);
    expect((await send("PATCH", "/api/asks/a-1", { id: "a-2" })).status).toBe(400);
  });

  it("lets a session read but not write, the board token write, and the bridge token neither", async () => {
    await create({ id: "a-1", words: "x" });
    expect((await send("GET", "/api/asks", undefined, {})).status).toBe(401);
    expect((await list("", browser(cookie))).map((ask) => ask.id)).toEqual(["a-1"]);
    expect((await send("GET", "/api/asks", undefined, bearer(BRIDGE_TOKEN))).status).toBe(401);

    expect((await send("POST", "/api/asks", { id: "a-2", words: "x" }, browser(cookie))).status).toBe(401);
    expect((await send("PATCH", "/api/asks/a-1", { note: "x" }, browser(cookie))).status).toBe(401);
    expect((await send("POST", "/api/asks", { id: "a-2", words: "x" }, bearer(BRIDGE_TOKEN))).status).toBe(401);
    expect((await send("PATCH", "/api/asks/a-1", { note: "x" }, bearer(BRIDGE_TOKEN))).status).toBe(401);
    expect((await list()).map((ask) => ask.version)).toEqual([1]);
  });
});

describe("an ask's promised time", () => {
  const inMinutes = (minutes: number) => new Date(START + minutes * 60_000).toISOString();
  const patch = async (body: Record<string, unknown>) => {
    const response = await send("PATCH", "/api/asks/a-1", body);
    return { status: response.status, ask: (await response.json()) as Ask & { error?: string } };
  };

  it("takes a due as the first promise, not a move", async () => {
    const ask = await create({ id: "a-1", words: "x", due: inMinutes(90), why: "stills first" });
    expect(ask).toMatchObject({ dueAt: inMinutes(90), why: "stills first", dueHistory: [] });
    // A first time on an ask that had none is a promise too.
    await create({ id: "a-2", words: "y" });
    const first = (await (await send("PATCH", "/api/asks/a-2", { due: "2026-10-01T06:30:00+02:00" })).json()) as Ask;
    expect(first).toMatchObject({ dueAt: "2026-10-01T04:30:00.000Z", dueHistory: [] });
  });

  it("restates a sooner time, or one within the slack, in place", async () => {
    await create({ id: "a-1", words: "x", due: inMinutes(60) });
    expect(await patch({ due: inMinutes(70) })).toMatchObject({ status: 200, ask: { dueAt: inMinutes(70), dueHistory: [] } });
    expect(await patch({ due: inMinutes(30) })).toMatchObject({ status: 200, ask: { dueAt: inMinutes(30), dueHistory: [] } });
  });

  it("records a later time with its why in dueHistory, and refuses one with no why", async () => {
    await create({ id: "a-1", words: "x", due: inMinutes(60) });
    const refused = await patch({ due: inMinutes(71) });
    expect(refused.status).toBe(400);
    expect(refused.ask.error).toMatch(/needs a why/);
    expect((await get("a-1")).dueAt).toBe(inMinutes(60));

    clock.advance(5 * 60_000);
    const moved = await patch({ due: inMinutes(120), why: "CI queue on CI" });
    expect(moved.status).toBe(200);
    expect(moved.ask).toMatchObject({ dueAt: inMinutes(120), why: "CI queue on CI", version: 2 });
    expect(moved.ask.dueHistory).toEqual([{ at: inMinutes(5), dueAt: inMinutes(120), was: inMinutes(60), why: "CI queue on CI" }]);
    // A why is one line.
    expect((await patch({ due: inMinutes(200), why: "two\nlines" })).status).toBe(400);
  });

  it("refuses a due in the past or more than a week out, and clears one on null", async () => {
    for (const due of [inMinutes(-2), inMinutes(7 * 24 * 60 + 1)]) {
      expect((await send("POST", "/api/asks", { id: "a-1", words: "x", due })).status, due).toBe(400);
    }
    await create({ id: "a-1", words: "x", due: inMinutes(60) });
    expect((await patch({ due: inMinutes(-2) })).status).toBe(400);
    expect((await patch({ due: inMinutes(7 * 24 * 60 + 1), why: "next week" })).status).toBe(400);
    const cleared = await patch({ due: null });
    expect(cleared.status).toBe(200);
    expect(cleared.ask.dueAt).toBeUndefined();
  });
});

describe("an ask from a message", () => {
  it("makes an ask from your message, taking its words, reply and source", async () => {
    const commands = new CommandStore(server.dataDir);
    commands.addAction({ id: "msg-7", clientId: "client-msg-7", kind: "chat", at: "2026-10-01T01:59:00.000Z", request: { text: "Make the chips bigger" } });
    commands.close();
    const ask = await create({ id: "a-1", from: "msg-7", who: "owner" });
    expect(ask).toMatchObject({ words: "Make the chips bigger", replyId: "msg-7", source: "message:msg-7" });
    // Words given win; an unknown message is a 404; no words and no message is a 400.
    expect((await create({ id: "a-2", from: "msg-7", words: "Bigger chips" })).words).toBe("Bigger chips");
    expect((await send("POST", "/api/asks", { id: "a-3", from: "msg-8" })).status).toBe(404);
    expect((await send("POST", "/api/asks", { id: "a-3" })).status).toBe(400);
  });
});

describe("the CLI's side of asks", () => {
  it("mirrors the server's stages and limits", async () => {
    const libPath = "../bridge/lib/asks.mjs";
    const lib = (await import(libPath)) as {
      ASK_STAGES: readonly string[];
      FINISHED_STAGES: readonly string[];
      ASK_WHO: readonly string[];
      MAX_ASK_WORDS: number;
      MAX_ASK_NOTE: number;
      MAX_ASK_CHAT: number;
      MAX_ASK_WHY: number;
      MAX_DONE_ITEMS: number;
      MAX_DONE_ITEM: number;
    };
    expect([...lib.ASK_STAGES]).toEqual([...ASK_STAGES]);
    expect([...lib.FINISHED_STAGES]).toEqual([...FINISHED_STAGES]);
    expect([...lib.ASK_WHO]).toEqual([...ASK_WHO]);
    expect([lib.MAX_ASK_WORDS, lib.MAX_ASK_NOTE, lib.MAX_ASK_CHAT, lib.MAX_ASK_WHY]).toEqual([MAX_ASK_WORDS, MAX_ASK_NOTE, MAX_ASK_CHAT, MAX_ASK_WHY]);
    expect([lib.MAX_DONE_ITEMS, lib.MAX_DONE_ITEM]).toEqual([MAX_DONE_ITEMS, MAX_DONE_ITEM]);
  });

  const cli = () => {
    const out = { stderr: "" };
    const env = { RIVET_BRIDGE_DEV: "1", RIVET_BOARD_TOKEN: BOARD_TOKEN, RIVET_URL: server.base, PATH: "" };
    const call = (argv: string[]): Promise<number> => run(argv, { env, now: () => new Date(clock.now()), stdout: () => undefined, stderr: (s: string) => void (out.stderr += s) });
    return { call, out };
  };

  it("rivet ask set --stage done and ask close done or shipped record the ask; done posts its Done card, with no PR", async () => {
    const { call, out } = cli();
    const needs = async () => ((await (await send("GET", "/api/board")).json()) as { board: { needs: { id: string; ask?: string; pr?: number }[] } | null }).board?.needs ?? [];
    for (const id of ["a-13", "a-14", "a-15"]) await create({ id, words: `Close ${id}`, prs: [4051] });
    expect(await call(["ask", "set", "a-13", "--stage", "done"])).toBe(0);
    expect(await call(["ask", "close", "a-14", "done", "--note", "shipped to the Lab"])).toBe(0);
    expect(await call(["ask", "close", "a-15", "shipped"])).toBe(0);
    expect(out.stderr).toBe("");
    expect(await Promise.all(["a-13", "a-14", "a-15"].map(async (id) => (await get(id)).stage))).toEqual(["done", "done", "shipped"]);
    const cards = await needs();
    expect(cards.map((card) => card.id).sort()).toEqual(["ask-a-13-done", "ask-a-14-done"]);
    expect(cards.find((card) => card.id === "ask-a-13-done")?.ask).toBe("You asked: Close a-13");
    expect(cards.find((card) => card.id === "ask-a-14-done")?.ask).toBe("You asked: Close a-14\nDone: shipped to the Lab");
    expect(cards.every((card) => card.pr === undefined)).toBe(true);
  });

  it("moves an ask to needs-you with no card named: the server cards it (asks/waits.ts)", async () => {
    const { call } = cli();
    const ask = await create({ id: "a-1", words: "Which layout?", chat: "rivet-app" });
    expect(await call(["ask", "set", ask.id, "--stage", "needs-you", "--why", "Which layout?"])).toBe(0);
    expect((await get(ask.id)).stage).toBe("needs-you");
    expect(await call(["ask", "set", ask.id, "--stage", "building"])).toBe(0);
    expect((await get(ask.id)).stage).toBe("building");
  });



});
