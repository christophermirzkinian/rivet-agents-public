import { bare, coverLines, heldTo, redactLines, valueOpen } from "../redact.mjs";
import { resolveChatTerminal } from "../terminals.mjs";
import { isChatName } from "../validate.mjs";
import { isRepo } from "../../../src/shared/repos.ts";

// The worker sheet's live log: while a lease is open the bridge reads the chat's
// terminal every couple of seconds, redacts it, and PUTs it to the server, which
// keeps it in memory only. The loop stops when the server says the lease lapsed,
// when its own copy of the lease runs out, or on logs.unsubscribe.
// A chat's TUI repaints its screen rather than writing new lines, so a read never moves on from where the last one ended. Each read is
// therefore of the whole screen, and the server matches it line by line to keep each line's first-seen time. A
// secret's opening line may have scrolled off the screen by then, so a read is redacted as what follows the lines
// already read where it picks up in them (`pickUp`), replayed from the redactor state before them. A read that shares
// no lines with them is a first read, held back to column 0 and through a quoted value's close (`heldTo`) as the read
// that opened the sheet; while a value is still open, nothing is sent until a read picks up in them again. A line is sent only once a read shows it as the read
// before did, so a line still being written waits.

/** @typedef {import("./index.mjs").ActionContext} ActionContext */
/** @typedef {import("./index.mjs").ActionResult} ActionResult */

export const LOG_READ_MS = 2_000;
export const LOG_LEASE_MAX_MS = 90_000;
export const LOG_READ_LIMIT = 200;
/** How many lines already read are kept for a read to pick up in. */
export const LOG_SEEN_LIMIT = 2 * LOG_READ_LIMIT;
/** How many of a read's first lines must match lines already read. */
const PICK_UP_LINES = 3;
const PUT_TIMEOUT_MS = 10_000;

/** @param {unknown} v */
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether every hold in `state` lasts at least as long as the one in the same place in `than`. @param {any} state @param {any} than @returns {boolean} */
const holdsAsLong = (state, than) =>
  !isRecord(than) && !Array.isArray(than)
    ? true
    : (than.hold ?? 0) <= (state?.hold ?? 0) && Object.entries(than).every(([key, value]) => holdsAsLong(state?.[key], value));
/**
 * Whether a redactor state is `end` with a value open in it, each hold lasting at least as long: what follows it is
 * redacted at least as strictly as what follows `end`.
 * @param {any} state @param {any} end
 */
export const sameOpen = (state, end) => valueOpen(state) && bare(state) === bare(end) && holdsAsLong(state, end);

/**
 * Where a read of the screen picks up in the lines already read, and how many of its first lines repeat them from
 * there: the index whose next lines repeat the most of the read's first lines, one not blank (the latest on a tie),
 * or -1 when none does. They are at least PICK_UP_LINES of them, all of a shorter read, or every line from there to
 * the end of the lines read. With `openAt` (a value is open at the end of the lines read), a read that repeats them
 * only part of the way, stopping before their end (even one it repeats whole), is taken only where `openAt` finds the redactor after the lines read
 * up to where it stops as it is at their end (`sameOpen`): a value open at the end of them is followed only into what certainly follows it, or into
 * what follows from inside it (a spinner repainted below it).
 * @param {string[]} seen @param {string[]} read @param {((end: number) => boolean) | null} [openAt]
 */
export function pickUp(seen, read, openAt = null) {
  const head = Math.min(PICK_UP_LINES, read.length);
  let best = { at: -1, run: 0 };
  for (let at = seen.length - 1; at >= 0; at--) {
    let run = 0;
    while (at + run < seen.length && run < read.length && seen[at + run] === read[run]) run++;
    const toEnd = at + run === seen.length;
    if (run <= best.run || !read.slice(0, run).some((line) => line.trim())) continue;
    if (run < head && !toEnd) continue;
    best = { at, run };
  }
  // Where it picks up is chosen by the lines alone, then checked: one that fails is not swapped for another place
  // whose state happens to pass, which may be another value's.
  if (openAt && best.at >= 0 && best.at + best.run < seen.length && !openAt(best.at + best.run)) {
    return { at: -1, run: 0 };
  }
  return best;
}

/**
 * @param {{ sleep?: (ms: number) => Promise<void>, now?: () => number, home?: string }} [options]
 */
export function createLogsFamily(options = {}) {
  const sleep = options.sleep ?? ((/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()));
  const now = options.now ?? Date.now;
  /** @type {Map<string, { until: number, stopped: boolean, resend: boolean, done: Promise<void> }>} */
  const loops = new Map();

  /** @param {number} until */
  const clamp = (until) => Math.min(until, now() + LOG_LEASE_MAX_MS);

  /**
   * @param {ActionContext} ctx
   * @param {string} repo
   * @param {string} chat
   * @param {{ until: number, stopped: boolean, resend: boolean }} loop
   */
  async function run(ctx, repo, chat, loop) {
    const { origin, token, log } = ctx.deps;
    // The lines the redactor has read, in order, each with whether what is above it was read (it was past where a
    // read was held back, `heldTo`), its state before the first of them and after the last. They move on with each
    // read, whether or not the server takes its lines: they are what the terminal showed, and a later read is
    // redacted as what follows them.
    /** @type {{ line: string, known: boolean }[]} */
    let seen = [];
    /** @type {any} */
    let seenState = { inKey: false };
    /** @type {any} */
    let keyState = { inKey: false };
    // Whether the cover found a value open at the end of the last read that the redactor, reading row by row, did not.
    let coverOpen = false;
    // The last read's lines, and the lines the server has (null when it may not have them).
    /** @type {string[] | null} */
    let shownLines = null;
    /** @type {string[] | null} */
    let sentLines = null;
    let held = false;
    log("logs-start", { repo, chat });
    while (!loop.stopped && now() < loop.until) {
      try {
        const found = resolveChatTerminal(await ctx.listTerminals(), chat, repo);
        if (!found.handle) {
          log("logs-stop", { repo, chat, reason: found.reason });
          break;
        }
        /** @type {unknown[]} */
        let tail;
        tail = await ctx.deps.chatRunner.read(found.handle, LOG_READ_LIMIT + 1);
        // The bottom row may still be being written, or wrap onto a row not yet there: it is read with what follows it.
        const read = tail.filter((/** @type {unknown} */ line) => typeof line === "string").slice(0, -1);
        // A screen read mid-repaint may be empty: it is read again, and the server keeps what it has.
        if (!read.length) throw Object.assign(new Error("the chat read returned no lines"), { empty: true });
        // A first read's top line may end a value begun above it, even at column 0, so it is never sent; what follows
        // may be a value whose header is above, so nothing is sent until a line that is not blank starts at column 0,
        // nor through the close of a quoted value that may have opened above (`heldTo`).
        /** The lines read up to `end`, redacted, and the redactor's state after them. @param {number} end */
        const replay = (end) => {
          const state = structuredClone(seenState);
          return { lines: redactLines(seen.slice(0, end).map((one) => one.line), state, options.home), state };
        };
        // A read that stops repeating them inside a value is followed past where it stops only from the state at
        // their end: the same value open, held at least as long (a hold only counts down), so a hold left by another
        // value never stands in for one opened below it.
        /** @type {Map<number, boolean>} */
        const opens = new Map();
        const openAt = (/** @type {number} */ end) => {
          if (!opens.has(end)) opens.set(end, sameOpen(replay(end).state, keyState));
          return opens.get(end) === true;
        };
        const open = valueOpen(keyState) || coverOpen;
        const { at, run } = pickUp(seen.map((one) => one.line), read, open ? openAt : null);
        if (at < 0 && seen.length && open) {
          // A read that shares no lines with them while a value is open may hold its middle with its opening line
          // gone: nothing is sent, and nothing moves on, until a read picks up in them again.
          throw Object.assign(new Error("a value is open and the read does not pick up in the lines read"), { held: true });
        }
        /** @type {any} */
        let state = { inKey: false };
        /** @type {string[]} */
        let above = [];
        let from = 0;
        let kept = seen;
        let keptState = seenState;
        if (at >= 0) {
          // The lines above where it picks up are replayed, unsent, from the state before them, and it is held back
          // only where the lines it repeats were.
          ({ lines: above, state } = replay(at));
          // A read that picks up in held lines goes on from the first line it repeats that was sent; one that repeats
          // none sends none of them, and is held as a first read below them.
          if (!seen[at].known) {
            const sent = read.findIndex((_, i) => i < run && seen[at + i].known);
            from = sent >= 0 ? sent : Math.max(run, heldTo(read));
          }
          kept = seen.slice(0, at);
        } else {
          from = heldTo(read);
          kept = [];
          keptState = { inKey: false };
        }
        // The withheld lines still go through the redactor, unsent, so its state stays in step with the terminal.
        // They are covered with the lines replayed above them, so a token or address wrapped from a line above, sent
        // by an earlier read or not, is covered.
        // Only the lines the last read showed as they are now are sent: a line still being written, wherever it is on
        // the screen, waits for a read that shows it unchanged, so the start of a token is never sent before its rest.
        const settled = Math.max(from, run);
        const withheld = redactLines(read.slice(0, from), state, options.home);
        const sent = redactLines(read.slice(from, settled), state, options.home);
        const waiting = redactLines(read.slice(settled), state, options.home);
        const cover = { open: false };
        const covered = coverLines([...above, ...withheld, ...sent, ...waiting], options.home, cover, [...seen.slice(0, at < 0 ? 0 : at).map((one) => one.line), ...read]);
        // A read that settles nothing (the screen changed above all it shows) keeps what was sent, rather than empty the feed.
        if (sent.length || shownLines === null) {
          shownLines = covered.slice(above.length + withheld.length, above.length + withheld.length + sent.length).slice(-LOG_READ_LIMIT);
        }
        let nextSeen = [...kept, ...read.map((line, i) => ({ line, known: i >= from }))];
        if (nextSeen.length > LOG_SEEN_LIMIT) {
          keptState = structuredClone(keptState);
          redactLines(nextSeen.slice(0, nextSeen.length - LOG_SEEN_LIMIT).map((one) => one.line), keptState, options.home);
          nextSeen = nextSeen.slice(-LOG_SEEN_LIMIT);
        }
        held = false;
        seen = nextSeen;
        seenState = keptState;
        keyState = state;
        coverOpen = cover.open;
      } catch (err) {
        const error = /** @type {any} */ (err);
        if (error?.held) {
          if (!held) log("logs-held", { repo, chat });
          held = true;
        } else if (!error?.empty) log("logs-read-failed", { repo, chat, error: String(error?.message ?? err).slice(0, 200) });
        if (loop.stopped || now() >= loop.until) break;
        await sleep(LOG_READ_MS);
        continue;
      }
      // A renewed lease may be a new one (the server restarted, or the old one lapsed): it is sent the lines again.
      if (loop.resend) [loop.resend, sentLines] = [false, null];
      const lines = shownLines ?? [];
      if (!sentLines || lines.length !== sentLines.length || lines.some((line, i) => line !== sentLines?.[i])) {
        try {
          const res = await ctx.deps.fetch(`${origin}/api/bridge/logs`, {
            method: "PUT",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ repo, chat, lines, reset: true }),
            redirect: "error",
            signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
          });
          if (!res.ok) throw new Error(`logs http ${res.status}`);
          const body = await res.json();
          if (body?.active !== true) {
            log("logs-stop", { repo, chat, reason: "lease-lapsed" });
            break;
          }
          const until = Date.parse(body.until);
          if (Number.isFinite(until)) loop.until = clamp(until);
          sentLines = lines;
        } catch (err) {
          // The next read's lines go whole, as every read's do.
          log("logs-put-failed", { repo, chat, error: String(/** @type {any} */ (err)?.message ?? err).slice(0, 200) });
          sentLines = null;
        }
      }
      if (loop.stopped || now() >= loop.until) break;
      await sleep(LOG_READ_MS);
    }
    log("logs-end", { repo, chat });
  }

  return {
    family: "logs",
    events: Object.freeze(["logs.subscribe", "logs.unsubscribe"]),
    /**
     * @param {string} event
     * @param {unknown} raw
     * @param {ActionContext} ctx
     * @returns {Promise<ActionResult>}
     */
    async handle(event, raw, ctx) {
      const r = isRecord(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
      const repo = isRepo(r.repo) ? r.repo : null;
      const chat = isChatName(r.chat) ? /** @type {string} */ (r.chat) : null;
      if (!repo || !chat) {
        ctx.deps.log("drop", { event, reason: "bad-log-target" });
        return "dropped";
      }
      const key = `${repo}\n${chat}`;
      const existing = loops.get(key);
      if (event === "logs.unsubscribe") {
        if (existing) existing.stopped = true;
        return "delivered";
      }
      const until = typeof r.until === "string" ? Date.parse(r.until) : NaN;
      if (!Number.isFinite(until) || until <= now()) {
        ctx.deps.log("drop", { event, reason: "bad-lease" });
        return "dropped";
      }
      if (existing && !existing.stopped) {
        existing.until = Math.max(existing.until, clamp(until));
        existing.resend = true;
        return "delivered";
      }
      const loop = { until: clamp(until), stopped: false, resend: false, done: Promise.resolve() };
      loop.done = run(ctx, repo, chat, loop).finally(() => {
        if (loops.get(key) === loop) loops.delete(key);
      });
      loops.set(key, loop);
      return "delivered";
    },
    /** Resolves once every running loop has ended. */
    idle() {
      return Promise.allSettled([...loops.values()].map((loop) => loop.done)).then(() => undefined);
    },
    /** @param {string} repo @param {string} chat */
    isRunning(repo, chat) {
      return loops.has(`${repo}\n${chat}`);
    },
  };
}

export const logs = createLogsFamily();
