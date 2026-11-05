import { isFinished, type Ask } from "../../shared/asks.js";

// The server keeps each ask's true time (plan §3h.4): past its dueAt with no new time, the ask's chat is asked once and
// the ask says so (`askedForTimeAt`); the chat's new time, with its reason, is a move in `dueHistory`. Nothing here
// counts down or marks late: late is a view over dueAt, askedForTimeAt and dueHistory.

/** The event id prefix of an ask's time question; the rest is the ask id and its due time, so a resend is typed once. */
export const ASK_LATE_PREFIX = "ask-late-";

export const askLateId = (ask: Pick<Ask, "id" | "dueAt">): string => `${ASK_LATE_PREFIX}${ask.id}-${Date.parse(ask.dueAt ?? "")}`;

/** The ask id an ask-late event id names, or null for any other id. */
export function askOfLateId(id: string): string | null {
  const match = new RegExp(`^${ASK_LATE_PREFIX}([a-z0-9-]{1,40})-\\d{1,15}$`).exec(id);
  return match?.[1] ?? null;
}

/**
 * The asks to ask for a time now: in hand (not finished, not waiting on you), past their dueAt, not asked yet for this
 * time. A pick-up's ask is left to its Ops record, whose own late sweep asks its chat.
 */
export function asksPastDue(asks: readonly Ask[], now: Date): Ask[] {
  return asks.filter(
    (ask) =>
      ask.dueAt !== undefined &&
      ask.askedForTimeAt === undefined &&
      !isFinished(ask.stage) &&
      ask.stage !== "needs-you" &&
      !ask.source?.startsWith("pickup:") &&
      Date.parse(ask.dueAt) <= now.getTime(),
  );
}
