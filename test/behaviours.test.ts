import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { ALL_BEHAVIOURS, BehavioursStore, OWNER } from "../src/server/behaviours.js";
import { followHostedName } from "../src/server/hosted-name.js";
import { ALL_READERS } from "../src/server/ops/readers.js";
import { readerBehaviourId, READERS_FIX_ID } from "../src/shared/readers.js";
import { BEHAVIOUR_GROUPS, BEHAVIOURS, behaviour, CHAT_SEND_DELAY_PATH, type BehavioursResponse } from "../src/shared/behaviours.js";
import { DEFAULT_CHAT_SEND_DELAY } from "../src/shared/command.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, browser, ORIGIN, startServer, type TestServer } from "./helpers.js";

// Settings › Behaviours: the list, its store and its routes.

/** Read through the server's list, never imported: the public tree has no behaviours-extra.ts. */
const OWNERS_ROWS = ALL_BEHAVIOURS.slice(BEHAVIOURS.length);

describe("the behaviours list", () => {
  it("gives every entry a line, a group, a scope and a default its own knobs accept", () => {
    for (const entry of ALL_BEHAVIOURS) {
      expect(entry.line.trim(), entry.id).not.toBe("");
      expect(BEHAVIOUR_GROUPS, entry.id).toContain(entry.group);
      expect(["all", "private"], entry.id).toContain(entry.scope);
      expect(entry.knobs.safeParse(entry.default).success, entry.id).toBe(true);
    }
  });

  it("has unique ids across the shared and private lists", () => {
    const ids = ALL_BEHAVIOURS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ALL_BEHAVIOURS.slice(0, BEHAVIOURS.length)).toEqual(BEHAVIOURS);
  });

  it("keeps the owner's rows out of the shared file", () => {
    const shared = fs.readFileSync(new URL("../src/shared/behaviours.ts", import.meta.url), "utf8");
    expect(OWNERS_ROWS.length > 0).toBe(fs.existsSync(new URL("../src/shared/behaviours-extra.ts", import.meta.url)));
    expect(BEHAVIOURS.every((entry) => entry.scope === "all")).toBe(true);
    expect(OWNERS_ROWS.every((entry) => entry.scope === "private")).toBe(true);
    for (const entry of OWNERS_ROWS) {
      expect(shared, entry.id).not.toContain(`"${entry.id}"`);
      expect(shared, entry.id).not.toContain(`"${entry.name}"`);
    }
  });

  it("gives each reader a live row whose choices are its fresh windows, and the fix row its caps", () => {
    for (const spec of ALL_READERS) {
      const entry = ALL_BEHAVIOURS.find((one) => one.id === readerBehaviourId(spec.id))!;
      expect(entry, spec.id).toBeDefined();
      expect(entry.control, spec.id).toBe("live");
      expect(entry.default, spec.id).toEqual({ on: true, fresh: spec.defaultFresh });
      expect(entry.choices?.options.map((option) => option.value), spec.id).toEqual(spec.fresh);
      expect(entry.knobs.safeParse({ on: true, fresh: spec.fresh.at(-1) }).success, spec.id).toBe(true);
      expect(entry.knobs.safeParse({ on: true, fresh: 7 }).success, spec.id).toBe(false);
    }
    const fix = ALL_BEHAVIOURS.find((one) => one.id === READERS_FIX_ID)!;
    expect(fix).toMatchObject({ control: "live", default: { on: true, cap: 3 } });
    expect(fix.chip?.(fix.default)).toBe("card after 3");
    expect(fix.knobs.safeParse({ on: true, cap: 4 }).success).toBe(false);
    expect(ALL_BEHAVIOURS.some((one) => one.id === "ops.readers")).toBe(false);
  });

  it("links each linked row to a section and gives the endpoint row its route", () => {
    for (const entry of ALL_BEHAVIOURS) {
      if (entry.control === "linked") expect(entry.link, entry.id).toBeDefined();
      if (entry.control === "endpoint") expect(entry.endpoint, entry.id).toBe("/api/settings/chat-send-delay");
    }
  });
});

describe("the behaviours store", () => {
  const knob = behaviour({ id: "test.knob", group: "Work", name: "Test", line: "A test knob", scope: "all", control: "live", knobs: z.object({ on: z.boolean(), cap: z.number().int().min(1).max(9) }).strict(), default: { on: true, cap: 3 } });
  let dir: string;
  let store: BehavioursStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-behaviours-"));
    store = new BehavioursStore(dir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("serves the default until a value is saved", () => {
    expect(store.get(OWNER, knob)).toEqual({ value: { on: true, cap: 3 }, updatedAt: null });
  });

  it("keys each value by its user", () => {
    store.put("someone", knob, { on: false, cap: 5 }, new Date("2026-11-22T00:00:00Z"));
    expect(store.get(OWNER, knob).value).toEqual({ on: true, cap: 3 });
    expect(store.get("someone", knob).value).toEqual({ on: false, cap: 5 });
  });

  it("refuses a value its knobs do not accept and writes nothing", () => {
    for (const bad of [{ on: "yes", cap: 3 }, { on: true, cap: 12 }, { on: true, cap: 3, extra: 1 }, null, []])
      expect(store.put(OWNER, knob, bad, new Date())).toBeNull();
    expect(store.get(OWNER, knob).updatedAt).toBeNull();
  });

  it("moves updatedAt on each write, and keeps it across a reopen", () => {
    store.put(OWNER, knob, { on: false, cap: 3 }, new Date("2026-11-22T00:00:00Z"));
    const saved = store.put(OWNER, knob, { on: true, cap: 4 }, new Date("2026-11-22T00:05:00Z"));
    expect(saved).toEqual({ value: { on: true, cap: 4 }, updatedAt: "2026-11-22T00:05:00.000Z" });
    store.close();
    store = new BehavioursStore(dir);
    expect(store.get(OWNER, knob)).toEqual(saved);
  });

  it("serves the default for a stored row that is not JSON", () => {
    store.close();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(path.join(dir, "rivet.sqlite"));
    db.prepare("INSERT INTO behaviours (user, id, value, updated_at) VALUES (?, ?, ?, ?)").run(OWNER, knob.id, "{not json", "2026-11-22T00:00:00.000Z");
    db.close();
    store = new BehavioursStore(dir);
    expect(store.get(OWNER, knob)).toEqual({ value: { on: true, cap: 3 }, updatedAt: null });
  });
});

describe("the behaviours routes", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startServer();
  });

  afterEach(async () => {
    await server.close();
  });

  const list = async () => (await (await fetch(`${server.base}/api/behaviours`, { headers: browser(server.cookie()) })).json()) as BehavioursResponse;

  it("refuses a signed-out read or write", async () => {
    expect((await fetch(`${server.base}/api/behaviours`)).status).toBe(401);
    const put = await fetch(`${server.base}/api/behaviours/work.who-does-what`, { method: "PUT", headers: { origin: ORIGIN, "x-rivet": "1", "content-type": "application/json" }, body: "{}" });
    expect(put.status).toBe(401);
  });

  it("lets the board token read the list, and only the board token", async () => {
    const read = await fetch(`${server.base}/api/behaviours`, { headers: bearer(BOARD_TOKEN) });
    expect(read.status).toBe(200);
    expect(((await read.json()) as BehavioursResponse).behaviours.map((row) => row.id)).toEqual(ALL_BEHAVIOURS.map((entry) => entry.id));
    expect((await fetch(`${server.base}/api/behaviours`, { headers: bearer("x".repeat(64)) })).status).toBe(401);
  });

  it("refuses a write with the board token", async () => {
    const live = ALL_BEHAVIOURS.find((entry) => entry.control === "live") ?? ALL_BEHAVIOURS[0]!;
    const url = `${server.base}/api/behaviours/${live.id}`;
    expect((await fetch(url, { method: "PUT", headers: { ...bearer(BOARD_TOKEN), "content-type": "application/json" }, body: JSON.stringify(live.default) })).status).toBe(403);
    expect((await fetch(url, { method: "PUT", headers: { ...bearer(BOARD_TOKEN), origin: ORIGIN, "x-rivet": "1", "content-type": "application/json" }, body: JSON.stringify(live.default) })).status).toBe(401);
  });

  it("lists every row with its value, chip and no schema, and an endpoint row with neither value nor chip", async () => {
    const { behaviours } = await list();
    expect(behaviours.map((row) => row.id)).toEqual(ALL_BEHAVIOURS.map((entry) => entry.id));
    expect(behaviours.find((row) => row.id === "chat.text-size")).toMatchObject({ value: { size: "m" }, chip: null, updatedAt: null, control: "live" });
    const delay = behaviours.find((row) => row.id === "chat.send-delay");
    expect(delay).toMatchObject({ value: null, chip: null, updatedAt: null, control: "endpoint" });
    expect(delay).not.toHaveProperty("knobs");
    expect(delay).not.toHaveProperty("default");
  });

  it("refuses a cross-origin or non-JSON write", async () => {
    const cookie = server.cookie();
    const url = `${server.base}/api/behaviours/work.who-does-what`;
    expect((await fetch(url, { method: "PUT", headers: { ...browser(cookie), origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
    const { "x-rivet": _marker, ...unmarked } = browser(cookie);
    expect((await fetch(url, { method: "PUT", headers: unmarked, body: "{}" })).status).toBe(403);
    expect((await fetch(url, { method: "PUT", headers: browser(cookie), body: "on" })).status).toBe(400);
  });

  it("answers 404 for an unknown id and 409 for a row this tab does not set", async () => {
    const cookie = server.cookie();
    expect((await fetch(`${server.base}/api/behaviours/no.such`, { method: "PUT", headers: browser(cookie), body: "{}" })).status).toBe(404);
    const always = await fetch(`${server.base}/api/behaviours/ops.pick-up-reds`, { method: "PUT", headers: browser(cookie), body: JSON.stringify({ on: false }) });
    expect(always.status).toBe(409);
  });

  it("saves a reader's fresh window from its choices and refuses one it does not offer", async () => {
    const url = `${server.base}/api/behaviours/reader.github`;
    const saved = await fetch(url, { method: "PUT", headers: browser(server.cookie()), body: JSON.stringify({ on: true, fresh: 30 }) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ value: { on: true, fresh: 30 }, chip: "fresh 30 min" });
    expect((await fetch(url, { method: "PUT", headers: browser(server.cookie()), body: JSON.stringify({ on: true, fresh: 45 }) })).status).toBe(400);
    const cap = await fetch(`${server.base}/api/behaviours/${READERS_FIX_ID}`, { method: "PUT", headers: browser(server.cookie()), body: JSON.stringify({ on: true, cap: 5 }) });
    expect(await cap.json()).toMatchObject({ value: { on: true, cap: 5 }, chip: "card after 5" });
  });

  const LIVE = ALL_BEHAVIOURS.filter((entry) => entry.control === "live");
  const bridgeRead = () => fetch(`${server.base}/api/bridge/behaviours`, { headers: bearer(BRIDGE_TOKEN) });

  it("gives the bridge, by its token only, each live row's value: the default until one is saved", async () => {
    const url = `${server.base}/api/bridge/behaviours`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: bearer(BOARD_TOKEN) })).status).toBe(401);
    expect((await fetch(url, { headers: browser(server.cookie()) })).status).toBe(401);
    expect(await (await bridgeRead()).json()).toEqual({ values: Object.fromEntries(LIVE.map((entry) => [entry.id, entry.default])) });
    // A row with an on/off value: reply style and text size, for two, hold a pick instead.
    const first = LIVE.find((entry) => typeof (entry.default as { on?: unknown } | null)?.on === "boolean");
    if (!first) return;
    const saved = { ...first.default, on: true };
    const put = await fetch(`${server.base}/api/behaviours/${first.id}`, { method: "PUT", headers: browser(server.cookie()), body: JSON.stringify(saved) });
    expect(put.status).toBe(200);
    expect(((await (await bridgeRead()).json()) as { values: Record<string, unknown> }).values[first.id]).toEqual(saved);
  });

  it("saves reply style and text size, and refuses a pick they don't offer", async () => {
    const cookie = server.cookie();
    for (const [id, value, bad] of [["chat.reply-style", { style: "detailed" }, { style: "long" }], ["chat.text-size", { size: "l" }, { size: "xl" }]] as const) {
      expect((await fetch(`${server.base}/api/behaviours/${id}`, { method: "PUT", headers: browser(cookie), body: JSON.stringify(bad) })).status, id).toBe(400);
      const saved = await fetch(`${server.base}/api/behaviours/${id}`, { method: "PUT", headers: browser(cookie), body: JSON.stringify(value) });
      expect(saved.status, id).toBe(200);
      const row = (await list()).behaviours.find((entry) => entry.id === id);
      expect(row?.value, id).toEqual(value);
      expect(row?.updatedAt, id).not.toBeNull();
    }
  });

  describe("for a session a device code alone made (a-1010)", () => {
    const REFUSED = [403, { error: "sign in with a passkey to change what your agent does by itself" }];
    let byCode: Record<string, string>;
    const put = (id: string, body: unknown, headers = byCode) => fetch(`${server.base}/api/behaviours/${id}`, { method: "PUT", headers, body: JSON.stringify(body) });

    beforeEach(() => {
      const value = "c".repeat(43);
      server.app.store.addSession(createHash("sha256").update(value).digest("hex"), 60_000, "device-code");
      byCode = browser(`__Host-rivet=${value}`);
    });

    it("marks only the three chat rows a preference, so any other row, and a new one, is closed to it", async () => {
      expect(ALL_BEHAVIOURS.filter((entry) => entry.preference).map((entry) => entry.id)).toEqual(["chat.send-delay", "chat.reply-style", "chat.text-size"]);
      const before = await list();
      const closed = before.behaviours.filter((row) => !row.preference);
      expect(closed.length).toBeGreaterThan(10);
      for (const row of closed) {
        const refused = await put(row.id, { on: false });
        expect([refused.status, await refused.json()], row.id).toEqual(REFUSED);
      }
      expect(await list()).toEqual(before);
      expect(await (await bridgeRead()).json()).toEqual({ values: Object.fromEntries(LIVE.map((entry) => [entry.id, entry.default])) });
    });

    it("is refused before the body is read, where a passkey session still saves", async () => {
      const refused = await fetch(`${server.base}/api/behaviours/reader.github`, { method: "PUT", headers: byCode, body: "not json" });
      expect([refused.status, await refused.json()]).toEqual(REFUSED);
      const saved = await put("reader.github", { on: true, fresh: 30 }, browser(server.cookie()));
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ value: { on: true, fresh: 30 } });
    });

    it("still saves reply style, text size and the send delay", async () => {
      for (const [id, value] of [["chat.reply-style", { style: "short" }], ["chat.text-size", { size: "l" }]] as const) {
        const saved = await put(id, value);
        expect(saved.status, id).toBe(200);
        expect(await saved.json(), id).toMatchObject({ value });
      }
      const delay = { ...DEFAULT_CHAT_SEND_DELAY, on: !DEFAULT_CHAT_SEND_DELAY.on };
      const sent = await fetch(`${server.base}${CHAT_SEND_DELAY_PATH}`, { method: "PUT", headers: byCode, body: JSON.stringify(delay) });
      expect(sent.status).toBe(200);
      expect(await (await fetch(`${server.base}${CHAT_SEND_DELAY_PATH}`, { headers: byCode })).json()).toMatchObject(delay);
    });
  });

  describe("on a hosted machine", () => {
    let dir: string;
    let stop: () => void;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-hosted-"));
      const file = path.join(dir, "agent.json");
      fs.writeFileSync(file, JSON.stringify({ name: "Pip", app: "Acme Agents" }));
      stop = followHostedName(file);
    });

    afterEach(() => {
      stop();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("lists no private row and refuses to find one", async () => {
      const { behaviours } = await list();
      expect(behaviours.length).toBe(BEHAVIOURS.length);
      expect(behaviours.every((row) => row.scope === "all")).toBe(true);
      for (const hidden of OWNERS_ROWS) {
        const put = await fetch(`${server.base}/api/behaviours/${hidden.id}`, { method: "PUT", headers: browser(server.cookie()), body: JSON.stringify(hidden.default) });
        expect(put.status, hidden.id).toBe(404);
      }
      const { values } = (await (await bridgeRead()).json()) as { values: Record<string, unknown> };
      expect(Object.keys(values)).toEqual(LIVE.filter((entry) => entry.scope === "all").map((entry) => entry.id));
    });
  });
});
