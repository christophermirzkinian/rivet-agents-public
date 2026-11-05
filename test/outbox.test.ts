import { describe, expect, it } from "vitest";

import { forget, MAX_ENTRIES, readOutbox, remember, unconfirmed, type OutboxEntry } from "../web/src/outbox.js";

function store(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
}

function entry(clientId: string, itemId: string, extra: Partial<OutboxEntry> = {}): OutboxEntry {
  return { clientId, itemId, decision: "approve", rev: `r-${itemId}`, title: `Card ${itemId}`, ...extra };
}

describe("outbox", () => {
  it("keeps entries until each is forgotten by its clientId", () => {
    const s = store();
    remember(entry("c1", "a"), s);
    remember(entry("c2", "a", { decision: "reject" }), s);
    remember(entry("c3", "b"), s);
    remember(entry("c3", "b"), s);
    expect(readOutbox(s).map((e) => e.clientId)).toEqual(["c1", "c2", "c3"]);
    forget("c3", s);
    expect(readOutbox(s).map((e) => e.clientId)).toEqual(["c1", "c2"]);
    forget("c1", s);
    expect(readOutbox(s).map((e) => e.clientId)).toEqual(["c2"]);
  });

  it("survives broken or missing storage", () => {
    expect(readOutbox(store({ "rivet.outbox": "{not json" }))).toEqual([]);
    expect(readOutbox(store({ "rivet.outbox.c1": "{not json", "rivet.outbox.c2": JSON.stringify({ savedAt: 1, entry: { clientId: 2 } }) }))).toEqual([]);
    expect(readOutbox(null)).toEqual([]);
    const full = { ...store(), setItem: () => { throw new Error("QuotaExceededError"); } };
    expect(() => remember(entry("c1", "a"), full)).not.toThrow();
    expect(() => forget("c1", null)).not.toThrow();
  });

  it("a delete in one tab never drops an entry another tab stored meanwhile", () => {
    const s = store();
    remember(entry("a", "x"), s);
    // Tab A's delete reads storage; tab B stores b before tab A writes.
    let tabB = () => remember(entry("b", "y"), s);
    const tabA = {
      getItem: (key: string) => {
        const value = s.getItem(key);
        tabB();
        tabB = () => {};
        return value;
      },
      setItem: s.setItem,
      removeItem: s.removeItem,
      key: s.key,
      get length() {
        return s.length;
      },
    };
    forget("a", tabA);
    expect(readOutbox(s).map((e) => e.clientId)).toEqual(["b"]);
    expect([...s.data.keys()]).toEqual(["rivet.outbox.b"]);
  });

  it("reads the old single-array outbox without writing, and drops its entries only as each is forgotten", () => {
    const parked = entry("c2", "b", { parked: true, text: "Later" });
    const s = store({ "rivet.outbox": JSON.stringify([{ clientId: 1 }, entry("c1", "a"), parked]), "rivet.other": "x" });
    const before = new Map(s.data);
    expect(readOutbox(s)).toEqual([entry("c1", "a"), parked]);
    expect(s.data).toEqual(before);
    remember(entry("c3", "c"), s);
    expect(readOutbox(s).map((e) => e.clientId)).toEqual(["c1", "c2", "c3"]);
    // An older tab still on the array code appends to it meanwhile; nothing here drops that.
    s.setItem("rivet.outbox", JSON.stringify([entry("c1", "a"), parked, entry("old-tab", "d")]));
    forget("c1", s);
    expect(readOutbox(s).map((e) => e.clientId)).toEqual(["c2", "old-tab", "c3"]);
    forget("c2", s);
    forget("old-tab", s);
    expect(s.data.has("rivet.outbox")).toBe(false);
    expect(readOutbox(s).map((e) => e.clientId)).toEqual(["c3"]);
    expect(s.data.get("rivet.other")).toBe("x");
  });

  it("still shows the old array's answers when storage is full", () => {
    const s = { ...store({ "rivet.outbox": JSON.stringify([entry("c1", "a", { parked: true })]) }), setItem: () => { throw new Error("QuotaExceededError"); } };
    Object.defineProperty(s, "length", { get: () => s.data.size });
    expect(readOutbox(s).map((e) => e.clientId)).toEqual(["c1"]);
  });

  it("keeps the newest MAX_ENTRIES entries, more than a board's 200 cards", () => {
    expect(MAX_ENTRIES).toBeGreaterThan(200);
    const s = store();
    for (let i = 0; i < MAX_ENTRIES + 2; i++) remember(entry(`c${i}`, "a"), s);
    const ids = readOutbox(s).map((e) => e.clientId);
    expect(ids).toHaveLength(MAX_ENTRIES);
    expect(ids[0]).toBe("c2");
    expect(ids.at(-1)).toBe(`c${MAX_ENTRIES + 1}`);
  });

  it("past the cap, never drops an entry another tab saved again after it was read", () => {
    const s = store();
    for (let i = 0; i < MAX_ENTRIES; i++) remember(entry(`c${i}`, "a"), s);
    const resaved = JSON.stringify({ savedAt: Date.now() + 1_000_000, entry: entry("c0", "a", { parked: true }) });
    let reads = 0;
    const tabA = {
      ...s,
      getItem: (key: string) => {
        // Tab B parks c0 again just before tab A checks it for eviction.
        if (key === "rivet.outbox.c0" && ++reads === 3) s.setItem(key, resaved);
        return s.getItem(key);
      },
    };
    Object.defineProperty(tabA, "length", { get: () => s.data.size });
    remember(entry("new", "b"), tabA);
    expect(s.data.get("rivet.outbox.c0")).toBe(resaved);
    expect(s.data.has("rivet.outbox.new")).toBe(true);
  });

  it("a key another tab removes mid-scan never hides a surviving entry", () => {
    const s = store();
    for (const id of ["x", "y", "z"]) remember(entry(id, "a"), s);
    let removed = false;
    const tabA = {
      ...s,
      key: (i: number) => {
        const key = s.key(i);
        if (!removed && key === "rivet.outbox.y") {
          removed = true;
          s.removeItem("rivet.outbox.x");
        }
        return key;
      },
    };
    Object.defineProperty(tabA, "length", { get: () => s.data.size });
    expect(readOutbox(tabA).map((e) => e.clientId)).toEqual(["y", "z"]);
  });

  it("treats an entry as landed only when the server holds a reply with its clientId", () => {
    const entries = [entry("c1", "a"), entry("c2", "a", { decision: "reject", text: "Stop" }), entry("c3", "b")];
    expect(unconfirmed(entries, new Set(["c1", "other"])).map((e) => e.clientId)).toEqual(["c2", "c3"]);
  });
});
