import type { Reply } from "../../src/shared/board.js";
import { when } from "../../src/shared/when.js";
import { RIVET_NAME, chatName } from "../../src/shared/names.js";

export type AnswerTone = "ok" | "warn" | "wait" | "acted";

/** A bridge error as one short clause: The owner needs the gist, Ops has the rest. */
const SHORT_ERROR = 60;

/**
 * Where an answer has got to, worded once for every view (README "One helper per metric"). Delivered is not acted on:
 * only Rivet marking it handled says the crew did something with it.
 */
export function answerState(reply: Reply, macOffline = false): { text: string; tone: AnswerTone } {
  // Seen goes to no chat: the update card just leaves the Feed.
  if (reply.decision === "seen") return { text: "Off Cards", tone: "ok" };
  if (reply.actedAt) return { text: `Acted on by ${RIVET_NAME} · ${when(reply.actedAt)}`, tone: "acted" };
  const delivery = reply.delivery;
  if (delivery?.lost) return { text: `Didn't reach the chat. ${RIVET_NAME} has been told.`, tone: "warn" };
  if (delivery?.confirmed === false) return { text: "Reached the chat, not confirmed. Check the chat.", tone: "warn" };
  if (delivery) return { text: `Reached ${delivery.target === "chat" ? (delivery.chat ? chatName(delivery.chat) : "the chat") : RIVET_NAME}`, tone: "ok" };
  if (reply.error) {
    const error = reply.error.length > SHORT_ERROR ? `${reply.error.slice(0, SHORT_ERROR - 1).trimEnd()}…` : reply.error;
    return { text: `Not delivered yet: ${error}`, tone: "warn" };
  }
  return { text: macOffline ? "Waiting for the Mac, which is offline" : "Waiting for the Mac", tone: "wait" };
}
