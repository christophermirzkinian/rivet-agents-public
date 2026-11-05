// What reaches you as a Needs-you card: one rule, here, for every server path that decides whether an Ops item becomes a
// card. Anything not named here is Rivet's to handle and you do not see it. Pure and free of app state, so the server's
// card pass, the failing-schedule card and the Plan page all ask the same question.

import { underWay } from "./ops-owned.js";
import type { OpsStatus } from "./ops-status.js";

/** Why a card is allowed, in the order they are tried. */
export const CARD_REASONS = ["app-down", "money", "hold", "decision", "fix-failed", "late"] as const;
export type CardReason = (typeof CARD_REASONS)[number];

/** An auto-fix that failed this many times becomes a card. */
export const AUTO_FIX_FAILURES_FOR_CARD = 2;
/** An app still down this long into a record Rivet holds becomes a card. */
export const APP_DOWN_CARD_AFTER_MS = 15 * 60_000;
/** An item with no done-by time is late for a card past this long. */
export const LATE_CARD_CAP_MS = 24 * 3600_000;
/** An item is late for a card once its done-by time has passed by this long: time for its chat to answer the late question. */
export const LATE_GRACE_MS = 2 * 3600_000;
/** Open this long, an item is late whatever its done-by time: one moved on before each passes would otherwise never be. */
export const LATE_OPEN_CAP_MS = 72 * 3600_000;

/** What the rule reads of an Ops item. */
export interface CardItem {
  /** Its record's kind ("ci", "pr", "app", "schedule"…). */
  kind: string;
  key: string;
  title: string;
  /** More words the money test reads: a record's note, a schedule's description. */
  text?: string;
  /** When the trouble began (a record's `since`). */
  startedAt: string;
  /** What names this incident of the item: its record's `since`, so an item that breaks again gets a new card. */
  incident?: string;
  /** Where the card's answer goes: the item's PR, its repo when not the default, and the chat on it. */
  pr?: number;
  repo?: string;
  chat?: string;
  /** The done-by time its record carries, when it has one. */
  dueAt?: string | null;
  /** Set when the caller knows it touches money; the words are read too. */
  money?: boolean;
  /** You placed a hold on it and it is waiting on your release. */
  hold?: boolean;
  /** Every hold of yours the PR carries, one text; your answer to its card stands until they change (CardBook.released). */
  holdLine?: string;
  /** It is a decision only you can make. */
  decision?: boolean;
  /** How many times Rivet's auto-fix of it has failed. */
  autoFixFailures?: number;
  /** An app that reads down now. */
  down?: boolean;
  /** When the live record Rivet holds on that app began: its `since`, which can predate Rivet's pick-up. Nothing in Rivet restarts an app. */
  rivetRecordSince?: string | null;
}

const MONEY = /(?<![a-z0-9])(money|billing|invoices?|subscriptions?)(?![a-z0-9])/i;

/** Whether the words are about money or billing. */
export function isMoneyText(...words: (string | undefined)[]): boolean {
  return MONEY.test(words.filter(Boolean).join(" "));
}

/**
 * How long an item may run before a card: until its done-by time has passed by the grace, however old the item is, but never
 * more than 72 hours; 24 hours with no done-by time, or one before it began.
 */
export function lateAfterMs(item: Pick<CardItem, "startedAt" | "dueAt">): number {
  const planned = item.dueAt ? Date.parse(item.dueAt) - Date.parse(item.startedAt) : NaN;
  return Number.isFinite(planned) && planned > 0 ? Math.min(planned + LATE_GRACE_MS, LATE_OPEN_CAP_MS) : LATE_CARD_CAP_MS;
}

/** A record's done-by time, when someone is on it: one left on a record no one is working is no plan. */
export function recordDueAt(record: Pick<OpsStatus, "dueAt" | "state"> | null | undefined): string | null {
  return underWay(record ?? null) ? (record?.dueAt ?? null) : null;
}

/** The reason the item may become a card now, else null: it stays Rivet's to handle. */
export function cardReason(item: CardItem, now: Date): CardReason | null {
  // Before money: an app down that qualifies always breaks quiet hours, whatever its note says.
  if (item.down && item.rivetRecordSince && now.getTime() - Date.parse(item.rivetRecordSince) > APP_DOWN_CARD_AFTER_MS) return "app-down";
  if (item.money || isMoneyText(item.key, item.title, item.text)) return "money";
  if (item.hold) return "hold";
  if (item.decision) return "decision";
  if ((item.autoFixFailures ?? 0) >= AUTO_FIX_FAILURES_FOR_CARD) return "fix-failed";
  if (now.getTime() - Date.parse(item.startedAt) > lateAfterMs(item)) return "late";
  return null;
}

/** What the card book keeps of a posted card: its base id (before any generation), its words' fingerprint, its reason, and when its app-down push was last raised. */
export interface CardEntry {
  base: string;
  print: string;
  reason: CardReason;
  raisedAt?: string;
  /** A PR hold card's hold lines and the PR's key, kept so your answer to it stands once the card leaves (CardBook.released). */
  held?: string;
  key?: string;
}

/**
 * The posted cards by board id, each base id's generation (how many times its card was withdrawn), and by `pr:<key>` the
 * hold lines of each PR hold card you answered before it left: the same lines read again are not carded again, new
 * ones are, and a reading of the PR with no hold of yours clears them.
 */
export interface CardBook {
  cards: Record<string, CardEntry>;
  gens: Record<string, number>;
  released?: Record<string, string>;
}

/** Quiet hours hold a card for the digest, except an app down's. */
export function cardBreaksQuiet(reason: CardReason): boolean {
  return reason === "app-down";
}

/** The item's one card per incident: named by the item and its incident, so a later pass updates it rather than adding another. */
export function cardKey(item: Pick<CardItem, "kind" | "key">): string {
  return `${item.kind}/${item.key}`;
}

/**
 * The card's board id, from its item, incident and generation: readable, with a hash of the whole key so two long keys never
 * share a card. The generation counts the times the card was withdrawn, so one that comes back is a new card to answer.
 */
export function cardId(item: Pick<CardItem, "kind" | "key" | "incident"> & { generation?: number }): string {
  const name = `${cardKey(item)}\n${item.incident ?? ""}${item.generation ? `\n${item.generation}` : ""}`;
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(name)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return `${OPS_CARD_PREFIX}${item.kind}-${item.key.replace(/[^a-z0-9.-]+/g, "-").slice(0, 40)}-${hash.toString(36).padStart(7, "0")}`;
}

/** Every ops card's board id starts with this. */
export const OPS_CARD_PREFIX = "ops-card-";

/** The key an ops card's push carries, so one quiet hours held can be withdrawn with its card. */
export function opsCardPushKey(id: string): string {
  return `ops-card:${id}`;
}

/** The outbox key of a card's app-down push (the Ops outbox adds "ops:" when it sends). */
export function cardDownKey(id: string): string {
  return `card-down:${id}`;
}

/** The card id an app-down push key names (with or without the "ops:" the sender adds), or null for any other key. */
export function cardOfDownKey(key: string): string | null {
  const bare = key.startsWith("ops:") ? key.slice(4) : key;
  return bare.startsWith("card-down:") ? bare.slice("card-down:".length) : null;
}

/** The card id a push key names, or null for any other key. */
export function opsCardOfPushKey(key: string): string | null {
  return key.startsWith("ops-card:") ? key.slice("ops-card:".length) : null;
}

/** Why the card says it is there, in words you read. */
export const CARD_REASON_WORDS: Record<CardReason, string> = {
  money: "It touches money, so it reaches you at once.",
  hold: "You placed a hold on it, so it needs you.",
  decision: "Only you can decide this.",
  "fix-failed": "Rivet tried to fix it twice and it did not work.",
  "app-down": "Rivet picked it up, and the app is still down over 15 minutes in.",
  late: "It has run late.",
};
