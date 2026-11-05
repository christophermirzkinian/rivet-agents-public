import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_MINIMISED } from "../src/server/store.js";
import { bearer, BOARD_TOKEN, browser, startServer, type TestServer } from "./helpers.js";

describe("PUT /api/minimised/:key", () => {
  let server: TestServer;
  let cookie: string;
  beforeEach(async () => {
    server = await startServer();
    cookie = server.cookie();
  });
  afterEach(async () => {
    await server.close();
  });

  const minimise = (key: string, body: unknown, headers = browser(cookie)) =>
    fetch(`${server.base}/api/minimised/${encodeURIComponent(key)}`, { method: "PUT", headers, body: JSON.stringify(body) });
  const served = async () => ((await (await fetch(`${server.base}/api/board`, { headers: { cookie } })).json()) as { minimised: [string, string][] }).minimised;

  it("keeps a minimised card for every phone until it is opened again", async () => {
    expect(await served()).toEqual([]);
    expect(await (await minimise("a", { small: true, rev: "a1" })).json()).toEqual({ minimised: [["a", "a1"]] });
    expect((await minimise("reply:r-1", { small: true, rev: "r1" })).status).toBe(200);
    expect((await minimise("a", { small: true, rev: "a2" })).status).toBe(200);
    expect(await served()).toEqual([
      ["reply:r-1", "r1"],
      ["a", "a2"],
    ]);
    expect((await minimise("a", { small: false })).status).toBe(200);
    expect(await served()).toEqual([["reply:r-1", "r1"]]);
  });

  it("takes only your session, a known shape and a revision", async () => {
    expect((await minimise("a", { small: true, rev: "a1" }, bearer(BOARD_TOKEN))).status).toBe(403);
    expect((await minimise("a", { small: true })).status).toBe(400);
    expect((await minimise("a", { rev: "a1" })).status).toBe(400);
    expect((await minimise("bad key!", { small: true, rev: "a1" })).status).toBe(404);
    expect(await served()).toEqual([]);
  });

  it("holds the newest MAX_MINIMISED", async () => {
    for (let i = 0; i <= MAX_MINIMISED; i++) server.app.store.setMinimised(`k${i}`, "r", new Date(Date.UTC(2026, 9, 26, 0, 0, i)).toISOString());
    const kept = await served();
    expect(kept).toHaveLength(MAX_MINIMISED);
    expect(kept[0]![0]).toBe("k1");
  });

  it("keeps the order cards came in when they land in the same millisecond", async () => {
    const at = new Date(Date.UTC(2026, 9, 26)).toISOString();
    for (const key of ["b", "a", "reply:r-1", "b"]) server.app.store.setMinimised(key, key, at);
    expect(await served()).toEqual([
      ["a", "a"],
      ["reply:r-1", "reply:r-1"],
      ["b", "b"],
    ]);
    server.app.store.setMinimised("c", "c", new Date(Date.UTC(2026, 9, 25)).toISOString());
    expect((await served()).at(-1)).toEqual(["c", "c"]);
  });

  it("trims the one minimised first when every card ties", async () => {
    const at = new Date(Date.UTC(2026, 9, 26)).toISOString();
    for (let i = 0; i <= MAX_MINIMISED; i++) server.app.store.setMinimised(`z${i}`, "r", at);
    const kept = await served();
    expect(kept).toHaveLength(MAX_MINIMISED);
    expect(kept[0]![0]).toBe("z1");
    expect(kept.at(-1)![0]).toBe(`z${MAX_MINIMISED}`);
  });
});
