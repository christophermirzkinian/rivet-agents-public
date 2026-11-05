import { z } from "zod";

// Short row titles. The home rows and the desk bubbles show an ask's or a chat's short title,
// "App or area: what", which the bridge's Haiku pass writes (bridge/lib/row-titler.mjs). Your own words stay on the ask,
// one tap away; until Haiku has named a row, or when it cannot, the row reads a trimmed first clause, never a blank.

/** A short title runs to this many characters at most. */
export const MAX_SHORT_TITLE = 32;
/** What the titler is given of a row's words. */
export const MAX_SHORT_SOURCE = 600;
/** The bridge takes at most this many rows a pass. */
export const SHORT_PENDING_MAX = 20;
/** A merge or ship this recent is the floor's news, and wears a short title. */
export const NEWS_MS = 12 * 3_600_000;
/** The server's key for a row's words: a SHA-256 in hex. */
export const SHORT_HASH_PATTERN = /^[0-9a-f]{64}$/;

// One line: no C0, DEL, C1 or bidi controls.
const ONE_LINE = /^[^\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/;

// Copy a row may never show: the word "live", which reads as a broadcast.
const BANNED_WORD = /\blive\b/i;

/** A title that fits on a row: one line, short, and none of the copy a row may never show. */
export function isShowable(title: string): boolean {
  return title.length > 0 && title.length <= MAX_SHORT_TITLE && ONE_LINE.test(title) && !BANNED_WORD.test(title);
}

/** The bridge's answer for one row: its title, or null when Haiku could not name it (the row keeps its fallback). */
export const shortTitleAnswerSchema = z
  .object({ title: z.string().trim().min(1).max(MAX_SHORT_TITLE).regex(ONE_LINE, "title is one line").refine(isShowable, "title is not showable").nullable() })
  .strict();

/** One row the bridge is asked to name. */
export interface PendingShortTitle {
  hash: string;
  text: string;
}

const URL_RE = /\bhttps?:\/\/\S+/gi;

/** `text` cut to `max` at a word, with an ellipsis when cut. */
export function cutAtWord(text: string, max = MAX_SHORT_TITLE): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,:;·–—-]+$/, "")}…`;
}

/**
 * The title a row wears until Haiku names it: the words' first clause (to the first full stop, question mark, semicolon,
 * dash or line break), links left out, cut at a word. Never blank: words that are only a link read as the link's host.
 */
export function fallbackTitle(words: string): string {
  const text = words.replace(/\r/g, "").replace(/\blive\b/gi, " ").trim();
  const noLinks = text.replace(URL_RE, " ").replace(/[^\S\n]+/g, " ").trim();
  const first = noLinks.split(/(?<=[^\d])[.?!;](?=\s|$)|\n|\s[–—-]\s/)[0]?.trim() ?? "";
  const clause = first.replace(/[\s,:;]+$/, "");
  const host = /\bhttps?:\/\/([^/\s?#]+)/i.exec(text)?.[1];
  const title = clause ? cutAtWord(clause) : noLinks ? cutAtWord(noLinks) : host ? cutAtWord(host) : cutAtWord(text);
  // A cut can leave "live" standing alone ("…-livestream" cut to "…-live…"): drop it once more.
  return title.replace(/\blive\b/gi, "").replace(/\s+/g, " ").replace(/^[\s,:;·–—-]+|[\s,:;·–—-]+$/g, "").trim() || "Untitled";
}

/** A short title as it may be shown: the given one when it is a fit, else the fallback from `words`. */
export function shownTitle(title: string | null | undefined, words: string): string {
  const clean = title?.replace(/\s+/g, " ").trim();
  return clean && isShowable(clean) ? clean : fallbackTitle(words);
}
