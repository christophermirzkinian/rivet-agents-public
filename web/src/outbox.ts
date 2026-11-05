// Answers on their way to the server, kept in localStorage until the server
// confirms them, so a page closed mid-send can say so on the next load.

import type { Answer } from "./feed-logic.js";

export interface OutboxEntry extends Answer {
  clientId: string;
  title: string;
  /** Still in its undo window at sign-out: sent after the next sign-in rather than offered again. */
  parked?: boolean;
  confirm?: boolean;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

// One key per entry, so adding or dropping one never rewrites another tab's
// entry.
const PREFIX = "rivet.outbox.";
/**
 * The single array the outbox used to be. It is read alongside the keys and
 * never written except to drop a forgotten entry, so it empties as recovery
 * clears each one; nothing copies it, which could resurrect or lose an entry
 * another tab changed meanwhile.
 */
const LEGACY_KEY = "rivet.outbox";
/** More than a board holds (200 cards), so Seen on a whole pile, parked at sign-out or sent at once, never drops one. */
export const MAX_ENTRIES = 250;

interface Stored {
  savedAt: number;
  entry: OutboxEntry;
}

function defaultStore(): Store | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null): Stored | null {
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    const { savedAt, entry } = parsed as Record<string, unknown>;
    return typeof savedAt === "number" && isEntry(entry) ? { savedAt, entry } : null;
  } catch {
    return null;
  }
}

function legacy(store: Store): OutboxEntry[] {
  try {
    const parsed: unknown = JSON.parse(store.getItem(LEGACY_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

function keyed(store: Store): Stored[] {
  // Downwards, so another tab removing a key mid-loop shifts one already read
  // into view again rather than skipping one.
  const keys = new Set<string>();
  for (let i = store.length - 1; i >= 0; i--) {
    const key = store.key(i);
    if (key?.startsWith(PREFIX)) keys.add(key);
  }
  const all: Stored[] = [];
  for (const key of keys) {
    const item = parse(store.getItem(key));
    if (item && key === PREFIX + item.entry.clientId) all.push(item);
  }
  return all.sort((a, b) => a.savedAt - b.savedAt);
}

export function readOutbox(store: Store | null = defaultStore()): OutboxEntry[] {
  try {
    if (!store) return [];
    const entries = keyed(store).map((item) => item.entry);
    const ids = new Set(entries.map((entry) => entry.clientId));
    return [...legacy(store).filter((entry) => !ids.has(entry.clientId)), ...entries];
  } catch {
    return [];
  }
}

export function remember(entry: OutboxEntry, store: Store | null = defaultStore()): void {
  try {
    if (!store) return;
    const newest = keyed(store).at(-1)?.savedAt ?? 0;
    store.setItem(PREFIX + entry.clientId, JSON.stringify({ savedAt: Math.max(Date.now(), newest + 1), entry }));
    // Past the cap, drop the oldest, each only if no tab has saved it again since it was read.
    const all = keyed(store);
    for (const old of all.slice(0, Math.max(0, all.length - MAX_ENTRIES))) {
      const key = PREFIX + old.entry.clientId;
      if (parse(store.getItem(key))?.savedAt === old.savedAt) store.removeItem(key);
    }
  } catch {
    // Storage full or blocked: the send itself still goes ahead.
  }
}

export function forget(clientId: string, store: Store | null = defaultStore()): void {
  try {
    if (!store) return;
    store.removeItem(PREFIX + clientId);
    const old = legacy(store);
    if (!old.some((entry) => entry.clientId === clientId)) return;
    const rest = old.filter((entry) => entry.clientId !== clientId);
    if (rest.length) store.setItem(LEGACY_KEY, JSON.stringify(rest));
    else store.removeItem(LEGACY_KEY);
  } catch {}
}

/** Entries the server does not have: no reply it holds carries the entry's clientId. */
export function unconfirmed(entries: readonly OutboxEntry[], landed: ReadonlySet<string>): OutboxEntry[] {
  return entries.filter((entry) => !landed.has(entry.clientId));
}

function isEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return ["clientId", "itemId", "decision", "rev", "title"].every((key) => typeof entry[key] === "string");
}
