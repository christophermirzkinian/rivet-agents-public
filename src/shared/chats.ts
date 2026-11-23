import { z } from "zod";

// Chats run themselves: the bridge counts the open chats, closes the finished ones, pulls backlog when the room has
// been idle and picks small issues each night; its last pass comes back as a report (server/chats-report.ts).

export const CHATS_ID = "work.chats-run-themselves";

/** Twice the bridge's every-five-minutes pass: a report older than that is from a bridge that stopped reporting. */
export const CHATS_STALE_MS = 2 * 5 * 60_000;

export const CHAT_CAPS = Array.from({ length: 20 }, (_, i) => i + 1);
export const CHAT_IDLE_MINUTES = [10, 20, 30, 45, 60] as const;
/** 0 is off. */
export const CHAT_NIGHTLY = Array.from({ length: 11 }, (_, i) => i);

export const chatsSchema = z
  .object({
    close: z.boolean(),
    cap: z.number().int().min(1).max(20),
    idleMinutes: z.number().refine((minutes) => (CHAT_IDLE_MINUTES as readonly number[]).includes(minutes)),
    nightly: z.number().int().min(0).max(10),
  })
  .strict();
export type Chats = z.infer<typeof chatsSchema>;
export const DEFAULT_CHATS: Chats = { close: true, cap: 10, idleMinutes: 30, nightly: 10 };

export interface ChatsReport {
  open: number;
  working: number;
  cap: number;
  kept: { name: string; reason: string }[];
  closed: string[];
  /** ISO time of the pass. */
  at: string;
}

/** GET /api/chats: Progress's count, as chatsLine words it. */
export interface ChatsLineResponse {
  line: string;
  /** How much longer (ms, by the server's clock) the server keeps the report the count is from; null with none. */
  leftMs: number | null;
}

/** The count with the stored cap, never the report's; with no report, "Can't tell" and never a guessed number. */
export function chatsLine(report: ChatsReport | null, cap: number): string {
  if (!report) return "Can't tell";
  return `${report.open} ${report.open === 1 ? "chat" : "chats"} open · cap ${cap}`;
}
