import { z } from "zod";

import { isKnownRepo, NO_REPO } from "./repos.js";

// Your own holds: a merge hold you placed yourself, by your message or a card answer, as `rivet hold` records it on the
// server. It is the one source of an Ops hold card (ops/cards.ts). PR text, hold labels and holds.json still bind the
// merge guard, fail-closed, but never card you: a card must not ask you to release a hold you never placed.

/** The most holds the server keeps; a hold past it is refused, never one of yours dropped for room. */
export const MAX_OWNER_HOLDS = 200;
/** rivet hold's --reason limit. */
export const MAX_OWNER_HOLD_REASON = 1000;

export const ownerHoldPutSchema = z
  .object({
    /** Your words and the reply id they came in. */
    reason: z.string().trim().min(1).max(MAX_OWNER_HOLD_REASON),
    repo: z.string().refine(isKnownRepo, "repo is not in RIVET_REPOS").optional(),
  })
  .strict();

export interface OwnerHold {
  pr: number;
  repo: string;
  reason: string;
  /** When it was recorded: a hold put back after a release is a new hold, with a new card. */
  at: string;
}

/** GET /api/ops/holds: every hold of yours, oldest first. */
export interface OwnerHoldsResponse {
  holds: OwnerHold[];
}

/** Whether the hold is on that PR of that repo. */
export function holdsPr(hold: OwnerHold, pr: number, repo: string): boolean {
  return hold.pr === pr && hold.repo.toLowerCase() === repo.toLowerCase();
}
