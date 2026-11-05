// Chat threads for the `rivet thread` CLI. The constants mirror src/shared/threads.ts.

/** src/shared/threads.ts THREAD_STATUSES and THREAD_STATUS_LABELS. */
export const THREAD_STATUSES = Object.freeze(["working", "needs-you", "shipped", "parked"]);
/** @type {Readonly<Record<string, string>>} */
export const THREAD_STATUS_LABELS = Object.freeze({ working: "Working", "needs-you": "Needs you", shipped: "Done", parked: "Parked" });

/** src/shared/threads.ts THREAD_PROJECTS and THREAD_PROJECT_LABELS. */
export const THREAD_PROJECTS = Object.freeze(["rivet"]);
/** @type {Readonly<Record<string, string>>} */
export const THREAD_PROJECT_LABELS = Object.freeze({ rivet: "Rivet Agents" });

/** src/shared/threads.ts STEP_KINDS and STEP_LABELS. */
export const STEP_KINDS = Object.freeze(["ask", "chat", "pr", "ok", "shipped"]);
/** @type {Readonly<Record<string, string>>} */
export const STEP_LABELS = Object.freeze({ ask: "Ask", chat: "Chat", pr: "PR", ok: "Your OK", shipped: "Deployed" });

export const MAX_THREAD_TITLE = 120;
export const MAX_THREAD_TAG = 32;
/** src/shared/threads.ts MAX_AI_TITLE. */
export const MAX_AI_TITLE = 60;
export const MAX_STEP_LABEL = 200;
export const MAX_THREAD_STEPS = 50;

/** The server's one-line rule: no C0, DEL, C1 or bidi overrides. */
export const ONE_LINE_RE = /^[^\x00-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]+$/;

/**
 * The stage a step's label (or, failing that, its link) names; null when neither says.
 * @param {string} label @param {string} [url]
 * @returns {string | null}
 */
export function guessStepKind(label, url) {
  if (/\bPR\b|#\d+|\/pull\//i.test(label)) return "pr";
  if (/\bdeployed\b|\bshipped\b/i.test(label)) return "shipped";
  if (/\byour ok\b|\bapproved\b|\bok\b/i.test(label)) return "ok";
  if (/\bchat\b/i.test(label)) return "chat";
  if (/\bask\b/i.test(label)) return "ask";
  if (url && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url)) return "pr";
  return null;
}
