import { command } from "./command.mjs";
import { home } from "./home.mjs";
import { issue } from "./issue.mjs";
import { logs } from "./logs.mjs";

// Action families the bridge carries beyond reply, reopen and late-ask: one module per
// family in this folder, listed in ACTION_FAMILIES. A handler validates its payload
// and runs fixed actions only; it never runs a command or an argument it was sent.

/**
 * @typedef {"dropped" | "duplicate" | "delivered" | "superseded" | "delivery-failed" | "ack-failed"} ActionResult
 *   "delivery-failed" and "ack-failed" end the connection so the event replays, as for a reply.
 * @typedef {{
 *   deps: import("../bridge.mjs").BridgeDeps,
 *   listTerminals(): Promise<import("../terminals.mjs").Terminal[]>,
 *   sendLine(handle: string, line: string): Promise<{ confirmed: boolean, stages: string[] }>,
 * }} ActionContext
 * @typedef {{
 *   family: string,
 *   events: readonly string[],
 *   handle(event: string, raw: unknown, ctx: ActionContext): Promise<ActionResult>,
 * }} ActionFamily
 */

/** @type {readonly ActionFamily[]} */
export const ACTION_FAMILIES = Object.freeze([command, logs, home, issue]);

const BUILT_IN = new Set(["reply", "reopen", "late-ask"]);

/**
 * Maps each SSE event name to its family. An event taken twice, or one of the
 * built-in events, is a startup error.
 * @param {readonly ActionFamily[]} families
 * @returns {Map<string, ActionFamily>}
 */
export function actionTable(families) {
  /** @type {Map<string, ActionFamily>} */
  const table = new Map();
  for (const family of families) {
    for (const event of family.events) {
      if (BUILT_IN.has(event) || table.has(event)) throw new Error(`action event already taken: ${event}`);
      table.set(event, family);
    }
  }
  return table;
}
