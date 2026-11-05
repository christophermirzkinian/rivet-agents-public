import { z } from "zod";

import { CHAT_PATTERN } from "./board.js";

// The claims board: before a chat changes a shared file it claims the file's path, so the other chats
// see who holds it before they collide. A claim is a repo-relative path or glob held by one chat until its TTL runs
// out, the chat releases it, or its PR merges or closes. Claims only inform: nothing on the server refuses an edit.

/** A repo-relative path or glob: no leading slash, no `..` segment, `*` within a segment and `**` as a whole one. */
export const CLAIM_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+*/-]{1,200}$/;
/** More stars than any real claim needs; the matcher is linear, but a claim is a path, not a puzzle. */
export const MAX_CLAIM_STARS = 8;
export const CLAIM_ID_PATTERN = /^c-[1-9]\d{0,14}$/;
export const DEFAULT_CLAIM_TTL_MINUTES = 120;
export const MAX_CLAIM_TTL_MINUTES = 24 * 60;
export const MAX_CLAIM_NOTE = 200;
/** POST answers 507 once this many claims are live. */
export const MAX_CLAIMS = 500;

export interface Claim {
  id: string;
  pattern: string;
  chat: string;
  pr?: number;
  branch?: string;
  note?: string;
  createdAt: string;
  expiresAt: string;
}

export interface ClaimsResponse {
  claims: Claim[];
}

/** 409 on a POST: the live claims of other chats that overlap the pattern asked for. */
export interface ClaimHeld {
  error: string;
  holders: Claim[];
}

// One line, and none of the quote marks the hook wraps it in: C0, DEL, C1, the line and paragraph separators, the
// bidi overrides and angle quotes.
const LINE = /^[^\x00-\x1f\x7f-\x9f\u2028\u2029؜‎‏‪-‮⁦-⁩\u00ab\u00bb]+$/;
const claimPattern = z
  .string()
  .regex(CLAIM_PATTERN, "a repo-relative path or glob")
  .refine((pattern) => pattern.split("*").length - 1 <= MAX_CLAIM_STARS, `at most ${MAX_CLAIM_STARS} stars`);
// Mirrors BRANCH_PATTERN in workers.ts.
const BRANCH = /^(?![/.-])(?!.*(?:\.\.|\/\/|\/\.|\/$|\.lock$))[A-Za-z0-9._/-]{1,200}$/;

export const claimAddSchema = z
  .object({
    pattern: claimPattern,
    chat: z.string().regex(CHAT_PATTERN),
    pr: z.number().int().positive().max(1_000_000_000).optional(),
    branch: z.string().regex(BRANCH).optional(),
    note: z.string().min(1).max(MAX_CLAIM_NOTE).regex(LINE, "a note is one line").refine((text) => text.trim() !== "", "a note must not be blank").optional(),
    ttlMinutes: z.number().int().min(1).max(MAX_CLAIM_TTL_MINUTES).optional(),
    /** Claim it even though another chat holds an overlapping claim (both stay). */
    force: z.boolean().optional(),
  })
  .strict();

export const claimReleaseSchema = z
  .object({
    chat: z.string().regex(CHAT_PATTERN),
    id: z.string().regex(CLAIM_ID_PATTERN).optional(),
    pattern: claimPattern.optional(),
  })
  .strict()
  .refine((body) => (body.id === undefined) !== (body.pattern === undefined), "give an id or a pattern");

export type ClaimAdd = z.infer<typeof claimAddSchema>;
export type ClaimRelease = z.infer<typeof claimReleaseSchema>;

/**
 * Whether the glob matches the whole path: `**` as a segment is any number of segments (none included), `*` any run
 * within a segment. No RegExp: a pattern is caller text, and a backtracking match of `a*a*a*…` would stall the server.
 * Both loops are memoised or greedy, so the work is at most the product of the two lengths.
 */
export function globMatches(glob: string, path: string): boolean {
  const g = glob.split("/");
  const p = path.split("/");
  const memo = new Map<number, boolean>();
  const at = (i: number, j: number): boolean => {
    const key = i * (p.length + 1) + j;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (i === g.length) result = j === p.length;
    else if (g[i] === "**") result = at(i + 1, j) || (j < p.length && at(i, j + 1));
    else result = j < p.length && segmentMatches(g[i] as string, p[j] as string) && at(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return at(0, 0);
}

/** `*` within one segment: the greedy two-pointer wildcard match, which never backtracks past the last star. */
function segmentMatches(glob: string, text: string): boolean {
  let gi = 0;
  let ti = 0;
  let star = -1;
  let mark = 0;
  while (ti < text.length) {
    if (gi < glob.length && glob[gi] !== "*" && glob[gi] === text[ti]) {
      gi++;
      ti++;
    } else if (gi < glob.length && glob[gi] === "*") {
      star = gi++;
      mark = ti;
    } else if (star !== -1) {
      gi = star + 1;
      ti = ++mark;
    } else return false;
  }
  while (gi < glob.length && glob[gi] === "*") gi++;
  return gi === glob.length;
}

/**
 * Whether two claims can name the same file. Exact for a plain path against anything; for two globs it compares the
 * text before their first `*`, so it may say yes where no file matches both (a claim only informs, so that errs safe).
 */
export function claimsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const aGlob = a.includes("*");
  const bGlob = b.includes("*");
  if (!aGlob && !bGlob) return false;
  if (!aGlob) return globMatches(b, a);
  if (!bGlob) return globMatches(a, b);
  const aHead = a.slice(0, a.indexOf("*"));
  const bHead = b.slice(0, b.indexOf("*"));
  return aHead.startsWith(bHead) || bHead.startsWith(aHead);
}
