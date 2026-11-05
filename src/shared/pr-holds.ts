import type { PullRequest } from "./ops.js";

// How a PR is held or waits on you, as Ops and the Agents board both read it.

/** Hold labels that do not say "hold"; the bridge's label check reads the same words. */
export const HOLD_WORDS: readonly string[] = ["do-not-merge", "do not merge", "dnm", "wip", "blocked"];

/** A label with case, spaces and punctuation gone: `do_not_merge` and `Do Not Merge` read alike. */
export function labelKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** A hold label as the bridge reads it (`do_not_merge`, `owner-h-o-l-d`): any naming a hold, or one of the others. */
export function isHold(label: string): boolean {
  const key = labelKey(label);
  return key.includes("hold") || HOLD_WORDS.some((word) => labelKey(word) === key);
}
/** A hold that waits on you names the owner: not "ownership". */
const ON_OWNER = /\bowner(?:'s|s)?\b/i;
// Where a hold names the owner only to say it is not theirs: "none from the owner.", "no owner hold", "not by the owner",
// "Owner holds: none". An agent's checkpoint line ("Holds: in holds.json until the fix lands; none from the owner") reads
// as a hold, and must not read as yours. Only a denial that ends its clause, or one of a hold, counts: "Owner hold: no
// merge until tests pass", "Owner hold: none of the approvals are in" and "No owner OK yet" are still yours; "Owner holds:
// none (the owner approved the plan)" is not: an aside that is only a note of an approval, read whole, the bridge's
// APPROVAL_ASIDE. "not by the owner but by the monitor" is not either.
const NOT_ON_OWNER =
  /\b(?:no(?:ne|thing)?|not|never)\s+(?:(?:a|an|any|the)\s+)?(?:holds?\s+)?(?:(?:from|by|for|of|on)\s+)?(?:the\s+)?owner(?:['\u2019]s|s)?(?:\s+holds?\b|(?=\s*(?:[.;,:!?)\u2014\u2013-]|$)))|\bnot\s+(?:from|by)\s+(?:the\s+)?owner(?:['\u2019]s|s)?(?=\s+but\b)|\bowner(?:['\u2019]s|s)?\s+holds?\s*[:\u2014\u2013-]?\s*(?:none|no|nothing)(?:[ \t]*\((?:(?:(?:the[ \t]+)?owners?)[ \t]+)?(?:(?:has|have)[ \t]+)?(?:approved|oked|ok['\u2019]?d|okayed|signed[ \t]+off(?:[ \t]+on)?|agreed(?:[ \t]+to)?|gave[ \t]+(?:it[ \t]+)?the[ \t]+go-ahead(?:[ \t]+(?:for|on))?)(?:[ \t]+(?:(?:the|this|his|her|that)[ \t]+)?(?:plan|pr|change|changes|video|build|design|approach|fix|it|this))?[ \t]*\.?\))?(?=\s*(?:[.;,!?)]|$))/gim;

// A hold that names the monitor or an agent as its holder is theirs, even where its condition names the owner: "Hold: the
// monitor holds the merge until the owner opens the ruleset window" must not card you. Only an owner who opens a condition
// or one of its parts ("until the owner opens …", "once the owner's call ends", "until the fix lands and the owner has
// seen it") is set aside: any other mention of the owner ("the owner has just asked us to wait", "until the fix lands per
// the owner") keeps it yours, so a relay worded any way still cards.
const HELD_BY_OTHERS =
  /^[\s>+-]*(?:\d+[.)]\s*)?(?:(?:merge\s+|ordering\s+)?holds?\s*[:\u2014\u2013-]\s*)?(?:the\s+)?(?:monitor|rivet|agent)(?:['\u2019]s)?\s+(?:(?:merge\s+|ordering\s+)?holds?\b|is\s+holding\b|keeps\s+(?:\S+\s+){0,4}?(?:on\s+hold|held|back)\b)/i;
const CONDITION =
  /\b(?:until|till|unless|when|whenever|after|once|before|while)\s+(?:after\s+|(?:(?!\bowner)[^.,;:!?()\u2014\u2013\n])*?\b(?:and|or)\s+)?(?:the\s+)?owner(?:['\u2019]s|s)?\b/gi;

/** Whether a hold is yours: it names the owner other than to say it is not theirs. An agent's or the monitor's hold is not. */
export function isOwnerHold(hold: string): boolean {
  // Read past Markdown, which the hold keeps as written: "none from **the owner**" denies as plainly; "owner_hold" is two words.
  const text = hold.replace(/[*_`~]+/g, " ");
  return ON_OWNER.test((HELD_BY_OTHERS.test(text) ? text.replace(CONDITION, " ") : text).replace(NOT_ON_OWNER, " "));
}

/** Why the PR is held, from its body or a hold label; null when nothing holds it. */
export function holdOf(pr: PullRequest): string | null {
  return pr.hold ?? pr.labels.find(isHold) ?? null;
}

/**
 * Your hold on the PR, from every hold it carries (body or comment lines, label), not only the first: an agent's stale
 * checkpoint line in the body must not hide a hold of yours in the comments. Null when none is yours.
 */
export function ownerHoldOf(pr: PullRequest): string | null {
  return [pr.hold, ...(pr.holds ?? []), ...pr.labels.filter(isHold)].find((hold): hold is string => !!hold && isOwnerHold(hold)) ?? null;
}

/** "**Owner hold:** waiting on the review" reads "waiting on the review". */
export function holdReason(hold: string): string {
  const reason = hold
    .replace(/[*_`]+/g, "")
    .replace(/^(?:label\s+|holds\.json:\s*)/i, "")
    .replace(/^[\s>#+-]*(?:\[[ x]\]\s*)?(?:(?:owner|user|merge|deploy|monitor)\s+)?(?:on\s+)?holds?\b\s*[:\u2014\u2013-]?\s*/i, "")
    .trim();
  return reason.length > 80 ? `${reason.slice(0, 79)}…` : reason;
}
