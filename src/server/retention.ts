import { AUDIT_KEEP_MS, CONVERSATION_KEEP_MS, RETENTION_BATCH } from "../shared/conversations.js";
import type { CommandStore, RetentionCounts } from "./commandstore.js";

// Retention: once an hour, on the Team room's minute tick.

/**
 * Count-only until the counts and your window are agreed (monitor, 2026-10-28): the sweep logs what it would delete
 * and deletes nothing. Turning it on is its own PR.
 */
export const RETENTION_APPLY = false;
/** The `meta` key holding the hour (ISO) the last sweep ran in. */
export const RETENTION_HOUR_KEY = "retention.hour";
/** The `meta` key holding the last sweep's counts, as JSON. */
export const RETENTION_LAST_KEY = "retention.last";
const HOUR_MS = 60 * 60_000;

/** On a new hour, one sweep: its counts, logged and kept in `meta`. Null when this hour's sweep already ran. */
export function retentionTick(commands: CommandStore, at: Date, apply = RETENTION_APPLY, log: (line: string) => void = console.log): RetentionCounts | null {
  const time = at.getTime();
  const hour = new Date(Math.floor(time / HOUR_MS) * HOUR_MS).toISOString();
  if (commands.getMeta(RETENTION_HOUR_KEY) === hour) return null;
  commands.setMeta(RETENTION_HOUR_KEY, hour);
  const conversationsBefore = CONVERSATION_KEEP_MS === null ? null : new Date(time - CONVERSATION_KEEP_MS).toISOString();
  const counts = commands.sweepRetention(conversationsBefore, new Date(time - AUDIT_KEEP_MS).toISOString(), apply, RETENTION_BATCH);
  commands.setMeta(RETENTION_LAST_KEY, JSON.stringify({ at: at.toISOString(), apply, ...counts }));
  log(
    `[rivet] retention: ${apply ? "deleted" : "would delete"} ${counts.conversations} conversations (${counts.messages} messages), ${counts.audit} audit rows, ${counts.prStages} PR stages`,
  );
  return counts;
}
