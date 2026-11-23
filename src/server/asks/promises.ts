import { DUE_SLACK_MS, isFinished, MAX_ASK_WHY, type Ask, type AskPatch } from "../../shared/asks.js";
import { DEFAULT_PROMISE_KEEPER, PROMISE_KEEPER_ID, type PromiseKeeper } from "../../shared/behaviours.js";
import { promisedTime } from "../../shared/promise-time.js";
import { ALL_BEHAVIOURS, OWNER, type BehavioursStore } from "../behaviours.js";

// Promise keeper (Settings › Behaviours): a time a chat promises the monitor goes on its ask by itself, and
// the chat is asked for the cause and a new time `warnMinutes` before it slips. After the time, asks/late.ts asks as
// before. Both read the row's on/off and minutes from the store each time, so the tab's change counts at once.

/** The event id prefix of an ask's warning before its time; the rest is the ask id and its due time, sent once each. */
export const ASK_SOON_PREFIX = "ask-soon-";

export const askSoonId = (ask: Pick<Ask, "id" | "dueAt">): string => `${ASK_SOON_PREFIX}${ask.id}-${Date.parse(ask.dueAt ?? "")}`;

/** The ask id an ask-soon event id names, or null for any other id. */
export function askOfSoonId(id: string): string | null {
  const match = new RegExp(`^${ASK_SOON_PREFIX}([a-z0-9-]{1,40})-\\d{1,15}$`).exec(id);
  return match?.[1] ?? null;
}

const ROW = ALL_BEHAVIOURS.find((behaviour) => behaviour.id === PROMISE_KEEPER_ID);

/** The Promise keeper's row as the owner set it; its default where the store has none. */
export function promiseKeeper(store: Pick<BehavioursStore, "get">): PromiseKeeper {
  return ROW ? (store.get(OWNER, ROW).value as PromiseKeeper) : DEFAULT_PROMISE_KEEPER;
}

/** In hand, as asks/late.ts reads it: not finished, not waiting on the owner, and not a pick-up's (its Ops record asks). */
const inHand = (ask: Ask): boolean => !isFinished(ask.stage) && ask.stage !== "needs-you" && !ask.source?.startsWith("pickup:");

/** The asks to warn now: in hand, due within `warnMs` and not yet past it, not asked for a time already. */
export function asksAboutToSlip(asks: readonly Ask[], now: Date, warnMs: number): Ask[] {
  return asks.filter((ask) => {
    if (ask.dueAt === undefined || ask.askedForTimeAt !== undefined || !inHand(ask)) return false;
    const left = Date.parse(ask.dueAt) - now.getTime();
    return left > 0 && left <= warnMs;
  });
}

/** The chat an ask names, without the PR or note after it ("cards-fix / PR 41" is cards-fix). */
const chatOf = (ask: Ask): string | null => ask.chat?.trim().split(/[\s/]/)[0] || null;

/** True when `name` is `chat` under its own name or a session's (`monitor-c7` is monitor). */
const sameChat = (name: string, chat: string): boolean => name === chat || (name.startsWith(`${chat}-`) && /^[0-9a-f]{2}$/.test(name.slice(chat.length + 1)));

/** True for a message to the monitor chat, under its own name or a session's (`monitor-c7`). */
export const toMonitor = (to: string, monitorChat: string): boolean => sameChat(to, monitorChat);

/**
 * The ask a chat's message to the monitor promises a time on, with the change that puts it there; null when it
 * promises none, names no ask of the sender's, or says the time the ask already has. Among the sender's asks in hand,
 * the one whose id the message names, else its only one. A later time is a move, its reason the line that says it.
 */
export function promiseChange(asks: readonly Ask[], message: { from: string; to: string; text: string }, monitorChat: string, now: Date): { ask: Ask; change: AskPatch } | null {
  if (!toMonitor(message.to, monitorChat)) return null;
  const mine = asks.filter((ask) => {
    const chat = chatOf(ask);
    return inHand(ask) && chat !== null && (sameChat(message.from, chat) || sameChat(chat, message.from));
  });
  const names = (ask: Ask) => new RegExp(`(?<![a-z0-9-])${ask.id}(?![a-z0-9-])`, "i").test(message.text);
  const named = mine.filter(names);
  // A message naming another chat's ask in hand may give that one's time ("a1 waits on stills-7; they say ETA 10:00"):
  // it moves nothing, as a missed time is asked about anyway and a wrong one is not.
  if (asks.some((ask) => inHand(ask) && !mine.includes(ask) && names(ask))) return null;
  const ask = named.length === 1 ? named[0]! : mine.length === 1 ? mine[0]! : null;
  if (!ask) return null;
  // The last time written: when it is the ask's own ("PR by 10:00, merged by 11:30"), nothing changes, though "new ETA
  // 9:30, was due by 9" is missed too, as a missed time is asked about anyway and a wrong one is not.
  const promised = promisedTime(message.text, now);
  if (!promised) return null;
  const due = Date.parse(promised.dueAt);
  if (ask.dueAt !== undefined && Math.abs(due - Date.parse(ask.dueAt)) <= DUE_SLACK_MS) return null;
  const later = ask.dueAt !== undefined && due > Date.parse(ask.dueAt) + DUE_SLACK_MS;
  return { ask, change: { due: promised.dueAt, by: message.from, ...(later ? { why: clipWhy(promised.line) } : {}) } };
}

/** One line of at most MAX_ASK_WHY characters, as an ask's why must be: no control or direction marks, as LINE. */
function clipWhy(line: string): string {
  const chars = Array.from(line.replace(/[\x00-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim());
  return chars.length <= MAX_ASK_WHY ? chars.join("") : `${chars.slice(0, MAX_ASK_WHY - 1).join("").trimEnd()}…`;
}
