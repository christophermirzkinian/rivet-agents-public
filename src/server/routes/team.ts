import type { ChatMessage } from "../../shared/command.js";
import { TEAM_PER_HOUR, TEAM_ROOM_ID, TEAM_ROOM_KEEP_MS, TEAM_TEXT_MAX, teamMessageSchema } from "../../shared/conversations.js";
import type { CommandStore } from "../commandstore.js";
import { HttpError, json, readJson, requireBearer } from "../httputil.js";
import { retentionTick } from "../retention.js";
import { chatName } from "../../shared/names.js";
import { parseRedacted } from "../redact.js";
import type { Router } from "./router.js";

// The Team room (src/shared/conversations.ts): the Mac's team-room hook posts each agent-to-agent message here, already
// redacted, and redacted again on arrival. Nothing here pushes or counts as unread. Once an hour with traffic, one summary line; past a week, deleted.
// The same minute tick runs the hourly retention sweep (../retention.ts).

const BODY_MAX = 16 * 1024;
const HOUR_MS = 60 * 60_000;
const TICK_MS = 60_000;
/** The `meta` key holding the hour (ISO) the last summary covered up to. */
export const TEAM_SUMMARY_KEY = "team.summary";
/** How many chats the summary names, each with its newest first line. */
const SUMMARY_CHATS = 4;
const SUMMARY_LINE_MAX = 60;

/** Up to `max` characters of `text`, with "…" when it was cut. */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/**
 * "Last hour: 14 messages, 5 chats — sign-in-fix: shipped the form; search: reworking filters", from counts and
 * first lines (no model call): the busiest senders first, each with its newest message's first line.
 */
export function summaryLine(messages: readonly { from: string; to: string; text: string }[]): string | null {
  if (!messages.length) return null;
  const chats = new Set(messages.flatMap((message) => [message.from, message.to]));
  const bySender = new Map<string, { count: number; last: string }>();
  for (const message of messages) {
    const seen = bySender.get(message.from);
    bySender.set(message.from, { count: (seen?.count ?? 0) + 1, last: message.text });
  }
  const busiest = [...bySender.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, SUMMARY_CHATS);
  const lines = busiest.map(([chat, { last }]) => `${chatName(chat)}: ${clip(last.split("\n").find((line) => line.trim())?.trim() ?? "", SUMMARY_LINE_MAX)}`);
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return `Last hour: ${count(messages.length, "message")}, ${count(chats.size, "chat")} — ${lines.join("; ")}`;
}

export function registerTeamRoom(router: Router, commands: CommandStore, broadcast: (message: ChatMessage) => void): void {
  const { config, now } = router.deps;

  router.on("POST", "/api/team/message", async ({ request, response }) => {
    requireBearer(request, config.boardTokenDigest);
    const parsed = parseRedacted(teamMessageSchema, await readJson(request, BODY_MAX));
    if (!parsed.success) throw new HttpError(400, "invalid team message: id, from and to as chat names, and text");
    const id = `team-${parsed.data.id}`;
    if (commands.getChatMessage(id)) {
      json(response, 200, { id, duplicate: true });
      return;
    }
    const at = now();
    if (!commands.takeAlert("team", at, TEAM_PER_HOUR, HOUR_MS)) throw new HttpError(429, "too many team messages this hour");
    commands.ensureTeamRoom(at.toISOString());
    const { from, to } = parsed.data;
    const message = commands.addChatMessage({ id, from: "rivet", text: clip(parsed.data.text, TEAM_TEXT_MAX), at: at.toISOString(), thread: TEAM_ROOM_ID, team: { from, to } });
    broadcast(message);
    json(response, 201, { id });
  });

  const tick = () => {
    const at = now();
    const summary = teamTick(commands, at);
    if (summary) broadcast(summary);
    retentionTick(commands, at);
  };
  const timer = setInterval(() => {
    try {
      tick();
    } catch {
      // The next tick tries again; a summary is never worth a crash.
    }
  }, TICK_MS);
  timer.unref();
  router.onClose(() => clearInterval(timer));
}

/** Each minute: the room's messages past a week go; on a new hour, the last hour's summary line when it had traffic. */
export function teamTick(commands: CommandStore, at: Date): ChatMessage | null {
  const time = at.getTime();
  const hour = new Date(Math.floor(time / HOUR_MS) * HOUR_MS).toISOString();
  commands.pruneTeamRoom(new Date(time - TEAM_ROOM_KEEP_MS).toISOString());
  if (commands.getMeta(TEAM_SUMMARY_KEY) === hour) return null;
  commands.setMeta(TEAM_SUMMARY_KEY, hour);
  const line = summaryLine(commands.teamMessages(new Date(Date.parse(hour) - HOUR_MS).toISOString(), hour));
  if (line === null) return null;
  return commands.addChatMessage({ id: `team-summary-${hour.slice(0, 13)}`, from: "rivet", text: line, at: at.toISOString(), thread: TEAM_ROOM_ID });
}
