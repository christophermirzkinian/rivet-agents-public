import { z } from "zod";

import { isRealTime } from "./board.js";
import { OPS_STATUS_KEY_PATTERN, OPS_STATUS_KINDS, type OpsStatusKind } from "./ops-status.js";

// Your Dismiss on a red Ops item. Stored on the server, keyed as the item's status record is, with the item's mark: what
// failed and when, as the phone saw it. The item stays hidden while its mark is the same; a change or a new break makes a
// new mark, and it is red again.

export const MAX_OPS_DISMISS_MARK = 2000;
/** PUT answers 507 once the store holds this many. */
export const MAX_OPS_DISMISSALS = 500;
/** A dismissal is deleted this long after it was made, so a break that never changes comes back. */
export const OPS_DISMISS_DAYS = 14;

const time = z.string().datetime({ offset: true }).refine(isRealTime, "a time with an offset within ±14:00");

export const opsDismissalSchema = z
  .object({
    kind: z.enum(OPS_STATUS_KINDS),
    key: z.string().regex(OPS_STATUS_KEY_PATTERN),
    mark: z.string().min(1).max(MAX_OPS_DISMISS_MARK),
    at: time,
  })
  .strict();

/** PUT /api/ops/dismissals/:kind/:key. */
export const opsDismissPutSchema = z.object({ mark: z.string().min(1).max(MAX_OPS_DISMISS_MARK) }).strict();

export type OpsDismissal = z.infer<typeof opsDismissalSchema>;

/** GET /api/ops/dismissals: every dismissal, newest first. */
export interface OpsDismissalsResponse {
  dismissals: OpsDismissal[];
}

/** What the mark is made of: when the item's trouble began, its title and what failed, a line each. */
export interface MarkParts {
  since: string | null;
  title: string;
  what: readonly string[];
}

export function dismissMark(parts: MarkParts): string {
  return JSON.stringify([parts.since ?? "", parts.title, ...parts.what]).slice(0, MAX_OPS_DISMISS_MARK);
}

/** A PR's failed checks the bridge did not name (it keeps ten). */
export function notNamed(count: number): string {
  return `${count} not named`;
}
