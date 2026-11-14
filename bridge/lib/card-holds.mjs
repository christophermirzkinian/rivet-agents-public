import { defaultRepo } from "../../src/shared/repos.ts";
import { HOLDS_FILE, updateHolds } from "./holds-file.mjs";

// A video card about a PR holds its merge from the moment it is posted until the owner's yes on that card, so a PR can't
// merge before its video is approved. The hold is a holds.json entry, which every merge door reads
// (merge-pr --check, the shepherd, the bridge's one-tap merge); a GitHub write would start CI, or land after the review
// evidence and block the gate. Entries carry no repository, so only the main repository's PRs (the first of RIVET_REPOS)
// are held, and none while RIVET_REPOS names no repo.

const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const PR_WORD = /\b(?:pr|pull request)(?: #?|#)(\d+)(?!\w)/gi;
// A bare #n is the main repository's (issues share its numbers, so holding one blocks nothing), read as the server's
// namedPrs reads it (src/shared/threads.ts); owner/repo#n and an HTML &#39; are not.
const BARE = /(?<![\w&./-])#(\d{2,9})\b/g;
/** The main repository's own patterns, read when asked, so a RIVET_REPOS set after start is used. @param {string} repo */
const ownPatterns = (repo) => {
  const [owner, name] = repo.split("/").map(escape);
  return {
    pullLink: new RegExp(String.raw`https?:\/\/(?:www\.)?github\.com\/${owner}\/${name}\/pull\/(\d+)(?!\w)`, "gi"),
    ownRef: new RegExp(String.raw`(?<![\w/.-])(?:${owner}\/)?${name}#(\d+)(?!\w)`, "gi"),
  };
};
// Whole labels only: "Keep it held" and "Keep it on hold" are his no.
const YES = /^(?:yes|yes, keep it|yes, merge it|yes, ship it|approve|approved|ok|okay|ship it|merge it|lgtm|looks good)[.!]?$/i;

/** @param {any} card */
export function isVideoCard(card) {
  return ["before", "after"].some((role) => {
    const type = card?.media?.[role]?.type;
    return typeof type === "string" && type.startsWith("video/");
  });
}

/** The main repository's PRs a card is about: its own PR, those its title or ask names, and its links'. @param {any} card */
export function cardHoldPrs(card) {
  const main = defaultRepo();
  if (!main) return [];
  const { pullLink: PULL_LINK, ownRef: OWN_REF } = ownPatterns(main);
  const own = card?.repo === undefined || card?.repo === null || (typeof card.repo === "string" && card.repo.toLowerCase() === main.toLowerCase());
  /** @type {unknown[]} */
  const found = own ? [card?.pr] : [];
  const text = [card?.title, card?.ask].filter((t) => typeof t === "string").join("\n");
  const links = Array.isArray(card?.links) ? card.links.map((/** @type {any} */ l) => l?.url).filter((u) => typeof u === "string") : [];
  for (const m of [text, ...links].join("\n").matchAll(PULL_LINK)) found.push(Number(m[1]));
  for (const m of text.matchAll(OWN_REF)) found.push(Number(m[1]));
  if (own) for (const re of [PR_WORD, BARE]) for (const m of text.matchAll(re)) found.push(Number(m[1]));
  return [...new Set(found.filter((n) => Number.isSafeInteger(n) && /** @type {number} */ (n) > 0))].map(Number);
}

/**
 * The comparison a hold is bound to, as the server's ReplyItem videoSha names it: on a card with a video in either
 * role, the after media's sha256 and the before media's, joined by `+` (either alone when the card has only one), so a
 * new after or a new before is a new comparison.
 * @param {any} card @returns {string | undefined}
 */
const cardVideo = (card) => {
  const { after, before } = card?.media ?? {};
  const isVideo = (/** @type {any} */ clip) => typeof clip?.type === "string" && clip.type.startsWith("video/");
  if (!isVideo(after) && !isVideo(before)) return undefined;
  const shas = [after, before].flatMap((clip) => (typeof clip?.sha256 === "string" ? [clip.sha256] : []));
  return shas.length ? shas.join("+") : undefined;
};

/** @param {string} id */
const reasonFor = (id) => `video card ${id} waits for the owner's yes; his yes on that card releases it (by hand: rivet unhold --card ${id})`;

/**
 * Holds the merge of each PR a video card is about, once per card and PR. Nothing for another card. A new entry records
 * the card's after video, and only a yes to a card showing that video releases it. `restamp` (a new video) moves the
 * card's held entries to now and to that video. `write` marks the entries on the card's PRs as this write's, for its
 * rollback. `version` is the board version a landed write returned: it is recorded, and a write whose version is older
 * than one already recorded on the card changes nothing, as a later write published over it. The PRs in `skip` are
 * left as they are.
 * @param {any} card
 * @param {{ file?: string, now?: Date, platform?: string, restamp?: boolean, skip?: number[], write?: string, version?: number }} [opts]
 * @returns {{ pr: number, added: boolean }[]}
 */
export function holdForCard(card, { file = HOLDS_FILE, now = new Date(), platform, restamp = false, skip = [], write, version } = {}) {
  const prs = isVideoCard(card) ? cardHoldPrs(card).filter((pr) => !skip.includes(pr)) : [];
  if (!prs.length && !restamp) return [];
  const id = String(card.id);
  const since = now.toISOString();
  const video = cardVideo(card);
  const stamped = (/** @type {Record<string, unknown>} */ h) => {
    const { video: _, ...rest } = h;
    return { ...rest, since, ...(video ? { video } : {}), ...(version !== undefined ? { version } : {}) };
  };
  return updateHolds(
    (holds) => {
      if (version !== undefined && holds.some((h) => h.card === id && typeof h.version === "number" && h.version > version))
        return { holds: null, result: prs.map((pr) => ({ pr, added: false })) };
      const missing = prs.filter((pr) => !holds.some((h) => h.card === id && h.pr === pr));
      const stale = restamp ? holds.filter((h) => h.card === id && (h.since !== since || h.video !== video || (version !== undefined && h.version !== version))) : [];
      const taken = write === undefined ? [] : holds.filter((h) => h.card === id && prs.includes(/** @type {number} */ (h.pr)) && h.write !== write);
      const result = prs.map((pr) => ({ pr, added: missing.includes(pr) }));
      if (!missing.length && !stale.length && !taken.length) return { holds: null, result };
      const mark = write === undefined ? {} : { write };
      return {
        holds: [
          ...holds.map((h) => {
            const next = stale.includes(h) ? stamped(h) : h;
            return taken.includes(h) ? { ...next, ...mark } : next;
          }),
          ...missing.map((pr) => ({ pr, reason: reasonFor(id), card: id, since, ...(video ? { video } : {}), ...(version !== undefined ? { version } : {}), ...mark })),
        ],
        result,
      };
    },
    { file, platform },
  );
}

/**
 * Removes a card's holds (all, those on `prs`, or those still marked as `write`'s): for a card whose write failed after
 * its hold was placed, or by hand. Returns the PRs whose hold it removed.
 * @param {string} id @param {{ file?: string, prs?: number[], write?: string, platform?: string }} [opts]
 * @returns {number[]}
 */
export function dropCardHold(id, { file = HOLDS_FILE, prs, write, platform } = {}) {
  return updateHolds(
    (holds) => {
      const gone = holds.filter((h) => h.card === id && (prs === undefined || prs.includes(/** @type {number} */ (h.pr))) && (write === undefined || h.write === write));
      return { holds: gone.length ? holds.filter((h) => !gone.includes(h)) : null, result: [...new Set(gone.map((h) => /** @type {number} */ (h.pr)))] };
    },
    { file, platform },
  );
}

/**
 * Moves a card's holds to another id: say.mjs holds under a provisional id before the server names the card.
 * @param {string} from @param {string} to @param {{ file?: string, platform?: string }} [opts]
 * @returns {number[]} the PRs now held for `to`
 */
export function rekeyCardHold(from, to, { file = HOLDS_FILE, platform } = {}) {
  return updateHolds(
    (holds) => {
      const moving = holds.filter((h) => h.card === from);
      if (!moving.length) return { holds: null, result: [] };
      // Kept beside an entry another write placed under the card's id since, so that write's rollback leaves this one.
      const has = (/** @type {Record<string, unknown>} */ m) => holds.some((h) => h.card === to && h.pr === m.pr && h.write === m.write);
      const moved = moving.filter((h) => !has(h)).map((h) => ({ ...h, reason: reasonFor(to), card: to }));
      return {
        holds: [...holds.filter((h) => h.card !== from), ...moved],
        result: [...new Set(moving.map((h) => /** @type {number} */ (h.pr)))],
      };
    },
    { file, platform },
  );
}

/** A write the server refused for good (so nothing was posted): a 4xx other than a timeout, conflict or rate limit.
 * @param {number} status */
export const definitiveRefusal = (status) => status >= 400 && status < 500 && ![408, 409, 429].includes(status);

/** The owner's yes: approve, a choice whose whole label is one, or the answer the server found arms the card's merge.
 * "Change it", "Keep it held", "Send to the owner" and the rest are not.
 * @param {{ decision?: string, choice?: string, item?: { merge?: boolean } }} reply */
export function isYes(reply) {
  if (reply.item?.merge === true || reply.decision === "approve") return true;
  return reply.decision === "choice" && typeof reply.choice === "string" && YES.test(reply.choice.trim());
}

/**
 * On the owner's yes, removes the answered card's own holds that the revision he answered covers: a PR that revision names,
 * no other video than it showed, and placed no later than his answer. An answer with no time keeps its holds. Another
 * card's hold on the same PR is its own card's to release; the monitor's and the owner's own holds (no `card`) are never
 * touched. Returns the PRs released, and each video card still holding one of the answered card's PRs; for the answered
 * card's own, `why`: the revision he answered did not name the PR, showed another video, or came before the hold.
 * @param {{ itemId: string, at?: string, decision?: string, choice?: string, item?: any }} reply
 * @param {{ file?: string, platform?: string }} [opts]
 * @returns {{ released: number[], kept: { pr: number, card: string, why?: "unnamed" | "video" | "earlier" }[] }}
 */
export function releaseForYes(reply, { file = HOLDS_FILE, platform } = {}) {
  if (!isYes(reply)) return { released: [], kept: [] };
  const at = Date.parse(String(reply.at));
  const named = cardHoldPrs(reply.item);
  // The server's videoSha (the comparison, cardVideo's form); an older server sends only the after video, which matches
  // no hold on a card with a before as well (it fails safe).
  const shown = reply.item?.videoSha ?? reply.item?.video?.sha256;
  /** @param {Record<string, unknown>} h @returns {"unnamed" | "video" | "earlier" | undefined} */
  const why = (h) => {
    if (!named.includes(/** @type {number} */ (h.pr))) return "unnamed";
    if (h.video !== undefined && h.video !== shown) return "video";
    if (!(at >= Date.parse(String(h.since)))) return "earlier";
    return undefined;
  };
  return updateHolds(
    (holds) => {
      const answered = holds.filter((h) => h.card === reply.itemId);
      const gone = answered.filter((h) => why(h) === undefined);
      const left = holds.filter((h) => !gone.includes(h));
      const prs = new Set(answered.map((h) => h.pr));
      /** @type {{ pr: number, card: string, why?: "unnamed" | "video" | "earlier" }[]} */
      const kept = [];
      for (const h of left) {
        if (typeof h.card !== "string" || !prs.has(h.pr) || kept.some((k) => k.pr === h.pr && k.card === h.card)) continue;
        const pr = /** @type {number} */ (h.pr);
        kept.push(h.card === reply.itemId ? { pr, card: h.card, why: why(h) } : { pr, card: h.card });
      }
      const released = [...new Set(gone.map((h) => /** @type {number} */ (h.pr)))].sort((a, b) => a - b);
      return { holds: gone.length ? left : null, result: { released, kept } };
    },
    { file, platform },
  );
}
