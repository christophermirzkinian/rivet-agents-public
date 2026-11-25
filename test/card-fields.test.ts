import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error the bridge is plain ESM without type declarations
import { CARD_FIELDS, LINK_FIELDS, OPTION_FIELDS } from "../bridge/lib/card-fields.mjs";
import { needSchema, type Need } from "../src/shared/board.js";
import { bearer, BOARD_TOKEN, putBoard, startServer, type TestServer } from "./helpers.js";

/** The object schema inside a refined, optional or array one. */
function shapeOf(schema: unknown): Record<string, unknown> {
  const at = schema as { shape?: Record<string, unknown>; _def?: { schema?: unknown; innerType?: unknown; type?: unknown } };
  if (at.shape) return at.shape;
  return shapeOf(at._def?.schema ?? at._def?.innerType ?? at._def?.type);
}

describe("the fields a card may hold (card-fields.mjs)", () => {
  it("are needSchema's own, its options' and its links'", () => {
    const card = shapeOf(needSchema);
    expect([...CARD_FIELDS].sort()).toEqual(Object.keys(card).sort());
    expect([...OPTION_FIELDS].sort()).toEqual(Object.keys(shapeOf(card.options)).sort());
    expect([...LINK_FIELDS].sort()).toEqual(Object.keys(shapeOf(card.links)).sort());
  });
});

describe("a card with fields the app does not draw, on the board routes", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startServer();
  });

  afterEach(async () => {
    await server.close();
  });

  const BASE = { updatedAt: "2026-11-25T00:00:00.000Z", coming: [], chats: [], shipped: [] };
  const CARD = { kind: "choice", title: "Usage: which look?", ask: "Two looks.\n- Calm\n- Bold", askId: "a-1014", options: [{ label: "Calm" }, { label: "Bold" }] };
  const OLD = { id: "old", kind: "choice", title: "Which?", heading: "Usage", bullets: ["one"], ask: "a-1014", options: [{ label: "A", id: "a", image: "/a.png" }, { label: "B", id: "b" }] };
  const send = (method: string, url: string, body: unknown) => fetch(`${server.base}${url}`, { method, headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) });
  const errorOf = async (res: Response) => {
    expect(res.status).toBe(422);
    return ((await res.json()) as { error: string }).error;
  };
  const stored = (id: string) => server.app.store.getBoard()?.board.needs.find((need) => need.id === id);
  /** The old card as it was stored before the rule. */
  const putOld = () => expect(server.app.store.putBoard({ ...BASE, needs: [OLD as Need] } as never, null)).toBeTruthy();

  it("takes a normal card", async () => {
    expect((await send("PUT", "/api/board/needs/pick?create=only", CARD)).status).toBe(200);
    expect(stored("pick")).toMatchObject(CARD);
  });

  it("takes a card answered in its chat, and refuses one with no words or a field that has no place", async () => {
    const inChat = { ...CARD, kind: "decision", inChat: { label: "To the team", doing: { Calm: "Sending" }, noted: "Not sent." } };
    expect((await send("PUT", "/api/board/needs/said?create=only", inChat)).status).toBe(200);
    expect(stored("said")).toMatchObject(inChat);
    expect(await errorOf(await send("PUT", "/api/board/needs/bare", { ...inChat, ask: undefined }))).toContain("a decision card needs a description");
    expect((await send("PUT", "/api/board/needs/bare", { ...inChat, inChat: { label: "To the team", to: "elsewhere" } })).status).toBeGreaterThanOrEqual(400);
    expect(stored("bare")).toBeUndefined();
  });

  it("refuses a field the card or its options do not have, naming it and what to use, and stores nothing", async () => {
    const error = await errorOf(await send("PUT", "/api/board/needs/pick?create=only", { ...CARD, heading: "Usage", bullets: ["a"], options: [{ label: "Calm", image: "/a.png" }, { label: "Bold" }] }));
    expect(error).toMatch(/^card pick: a card has no field heading: put it in the ask text .*; a card has no field bullets: .*; option 1 has no field image: put each picture on the card with --still/);
    expect(stored("pick")).toBeUndefined();
  });

  it("refuses an ask that is only an ask's id, and a decision or choice card with no description", async () => {
    expect(await errorOf(await send("PUT", "/api/board/needs/pick", { ...CARD, ask: "a-1014 (option B)" }))).toContain("--ask-id a-N");
    for (const kind of ["decision", "choice"]) {
      expect(await errorOf(await send("PUT", "/api/board/needs/pick", { ...CARD, kind, ask: undefined }))).toContain(`a ${kind} card needs a description`);
    }
  });

  it("refuses them in a whole-board write too, naming the card", async () => {
    expect(await errorOf(await putBoard(server.base, { ...BASE, needs: [{ id: "ok", ...CARD }, { id: "pick", ...CARD, heading: "Usage" }] }))).toMatch(/^card pick: a card has no field heading/);
  });

  it("still reads and edits a card stored with the old fields, and takes them off with null", async () => {
    putOld();
    const read = (await (await fetch(`${server.base}/api/board`, { headers: bearer(BOARD_TOKEN) })).json()) as { board: { needs: Record<string, unknown>[] } };
    expect(read.board.needs[0]).toMatchObject(OLD);
    expect((await putBoard(server.base, read.board)).status).toBe(200);
    expect((await send("PATCH", "/api/board/needs/old", { title: "Which one?" })).status).toBe(200);
    expect(await errorOf(await send("PATCH", "/api/board/needs/old", { heading: "Other" }))).toContain("no field heading");
    expect((await send("PATCH", "/api/board/needs/old", { heading: null })).status).toBe(200);
    expect(stored("old")).not.toHaveProperty("heading");
    expect(stored("old")).toMatchObject({ title: "Which one?", bullets: ["one"] });
  });

  it("takes an unchanged stored field the redactor would change", async () => {
    const heading = "password: example";
    expect(server.app.store.putBoard({ ...BASE, needs: [{ ...OLD, heading } as Need] } as never, null)).toBeTruthy();
    expect((await send("PATCH", "/api/board/needs/old", { title: "Which one?" })).status).toBe(200);
  });

  it("refuses a news card's option fields before it becomes a Got it card", async () => {
    const news = { kind: "update", title: "Look", options: [{ label: "Preview", image: "/tmp/look.png" }] };
    expect(await errorOf(await send("PUT", "/api/board/needs/u", news))).toContain("option 1 has no field image");
    expect(await errorOf(await putBoard(server.base, { ...BASE, needs: [{ id: "u", ...news }] }))).toContain("option 1 has no field image");
  });

  it("takes a board that names no cards, and refuses words that store as nothing and options that are no list", async () => {
    expect((await putBoard(server.base, { updatedAt: BASE.updatedAt })).status).toBe(200);
    expect(await errorOf(await send("PUT", "/api/board/needs/pick", { ...CARD, ask: "\u001b[31m" }))).toContain("needs a description");
    expect(await errorOf(await send("PUT", "/api/board/needs/pick", { ...CARD, ask: "\u001b[31ma-1014" }))).toContain("only an ask's id");
    expect(await errorOf(await send("PUT", "/api/board/needs/u", { kind: "update", title: "Look", options: { label: "Preview", image: "/tmp/look.png" } }))).toContain("options is not a list");
  });

  it("never shows a key used as a field's name, or a long id of a card a full board drops", async () => {
    const key = `AKIA${"A".repeat(16)}`;
    expect(await errorOf(await send("PUT", "/api/board/needs/pick", { ...CARD, [key]: 1 }))).not.toContain(key);
    const old = { id: "x".repeat(500_000), kind: "update", title: "T", heading: "H", since: "2000-01-01T00:00:00Z" };
    const error = await errorOf(await putBoard(server.base, { ...BASE, needs: [old, ...Array.from({ length: 200 }, (_, i) => ({ id: `u${i}`, kind: "update", title: "T" }))] }));
    expect(error.length).toBeLessThan(1000);
  });

  it("refuses an edit that takes a card's description off", async () => {
    expect((await send("PUT", "/api/board/needs/pick", CARD)).status).toBe(200);
    expect(await errorOf(await send("PATCH", "/api/board/needs/pick", { ask: null }))).toContain("needs a description");
  });

  it("leaves a title-only say.mjs question and news alone", async () => {
    const say = (body: object) => fetch(`${server.base}/api/bridge/say`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) });
    expect((await say({ text: "Nightly ran clean", tag: "Nightly" })).status).toBe(201);
    expect((await send("PUT", "/api/board/needs/news", { kind: "update", title: "Merged" })).status).toBe(200);
    expect(stored("news")).toMatchObject({ kind: "decision", options: [{ label: "Got it" }] });
  });
});
