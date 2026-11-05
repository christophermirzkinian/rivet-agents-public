#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mediaFlag, mediaOf, readMedia, replyRecord, serverError, uploadClips } from "../bridge/lib/board-client.mjs";
import { fingerprint, makeExec, readToken, serverOrigin } from "../bridge/lib/config.mjs";
import { chatRepoOf, comingChatRepo, isId, progressFieldProblems } from "../bridge/lib/validate.mjs";
import { defaultRepo } from "../src/shared/repos.ts";

const USAGE = `Publish Rivet's board, and read or settle replies, on the Rivet server.

  node push-board.mjs <board.json> [--if-match <version> | --replace]
      PUT the board; prints "version N". By default it first reads the server's
      board and keeps cards, coming rows and chats that other chats added since
      the last push, and the shipped rows the server moved there from Coming (named on
      stderr and written into board.json); the keys of
      each push go in <board.json>.pushed. A stale version retries up to 3 times.
      --if-match sends that version with no merge; --replace overwrites with no
      merge and no version check.
  node push-board.mjs --replies                             unhandled replies as JSON
  node push-board.mjs --handled <reply id>                  mark one reply handled
  node push-board.mjs --verify <reply id>                   the server's record of one decision
  node push-board.mjs --fingerprint                         sha256(token)[0:12]
  node push-board.mjs --media <item id> --before a.mp4 --after b.mp4 [--poster p.jpg] [--still s.png ...]
                     [--audio v.mp3 [--label "Onyx"] ...] [--file "White paper.pdf" ...]
                     [--skip-corner-check] [board.json]
      upload the clips (mp4, webm, jpg or png, 25 MB each) and attach them to
      that card in board.json, then push it; without board.json, print the
      media JSON to paste into the card. One clip alone is --after (or --before).
      --still adds a screenshot (jpg or png, up to 8); --audio adds a sound clip
      (mp3 or m4a, up to 6), named by the --label after it; --file adds a
      document (up to 4, 25 MB each) that you can open, save or share, under
      its own file name (letters, digits, spaces and . _ - ( ) kept): a PDF,
      Markdown (md), text (txt, log, csv), JSON (UTF-8 text) or an Office file
      (docx, xlsx, pptx, doc, xls, ppt). The app shows PDFs, Markdown, text and
      JSON itself; the rest only share. Stills, sound or documents alone are fine. A video with Playwright's grey padding on its right or
      bottom edge (recorded bigger than the viewport) is refused; the check
      reads one frame with ffmpeg and is skipped with a warning without it.
      --skip-corner-check lets a clip through whose own page is that grey.

Token: RIVET_BOARD_TOKEN (from the repo's .env, or the Keychain; see npm run setup).
Server: RIVET_URL (default http://127.0.0.1:8130; http only for localhost).
`;

const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const DEFAULT_REPO = defaultRepo();

const MAX_BOARD_BYTES = 1024 * 1024;

/** @param {string} msg @param {number} [code] */
function fail(msg, code = 1) {
  process.stderr.write(`push-board: ${msg}\n`);
  return code;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ mode?: string, file?: string, ifMatch?: string, replace?: boolean, id?: string, help?: boolean, before?: string, after?: string, poster?: string, stills: string[], audio: { file: string, label?: string }[], files: string[], skipCorner?: boolean }} */
  const o = { stills: [], audio: [], files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const setMode = (/** @type {string} */ m) => {
      if (o.mode === "media" && m === "push") return;
      if (o.mode === "push" && m === "media") {
        o.mode = m;
        return;
      }
      if (o.mode) throw new Error("pick one of <board.json>, --replies, --handled, --verify, --fingerprint, --media");
      o.mode = m;
    };
    const last = mediaFlag(argv, i, o);
    if (last >= 0) i = last;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--replies") setMode("replies");
    else if (a === "--fingerprint") setMode("fingerprint");
    else if (a === "--handled" || a === "--verify" || a === "--media") {
      setMode(a.slice(2));
      o.id = argv[++i];
      if (o.id === undefined) throw new Error(`${a} needs ${a === "--media" ? "an item" : "a reply"} id`);
    } else if (a === "--if-match") {
      o.ifMatch = argv[++i];
      if (o.ifMatch === undefined) throw new Error("--if-match needs a version");
    } else if (a === "--replace") o.replace = true;
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else {
      if (o.file !== undefined) throw new Error("only one board file");
      setMode("push");
      o.file = a;
    }
  }
  if (o.mode === "media" && !o.before && !o.after && !o.stills.length && !o.audio.length && !o.files.length)
    throw new Error("--media needs --before and --after, one clip, --still, --audio or --file");
  if (o.mode !== "media" && (o.before || o.after || o.poster || o.stills.length || o.audio.length || o.files.length || o.skipCorner))
    throw new Error("--before, --after, --poster, --still, --audio, --file and --skip-corner-check go with --media");
  if (o.ifMatch !== undefined && o.mode !== "push" && !(o.mode === "media" && o.file !== undefined))
    throw new Error("--if-match only applies to a board push");
  if (o.replace && o.mode !== "push" && !(o.mode === "media" && o.file !== undefined))
    throw new Error("--replace only applies to a board push");
  if (o.replace && o.ifMatch !== undefined) throw new Error("pick one of --if-match and --replace");
  return o;
}

/** @param {string} file */
function readBoard(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${file} is not a file`);
  if (stat.size > MAX_BOARD_BYTES) throw new Error("board is over 1 MB");
  const text = fs.readFileSync(file, "utf8");
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc.needs))
    throw new Error(`${file} has no needs array`);
  const problems = progressFieldProblems(doc);
  if (problems.length) throw new Error(`${file}: ${problems.slice(0, 5).join("; ")}`);
  return text;
}

/**
 * The board text with one card's media set.
 * @param {string} text
 * @param {string} itemId
 * @param {Record<string, unknown>} media
 */
function attachMedia(text, itemId, media) {
  const doc = JSON.parse(text);
  const need = doc.needs.find((/** @type {any} */ n) => n?.id === itemId);
  if (!need) throw new Error(`no card with id ${itemId} in the board`);
  need.media = media;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

const PUSH_TRIES = 3;

/**
 * `key` in `repo`: another repo's has its repo, since a PR number, title or chat name is only unique within a repo. The
 * default repo's (the first of RIVET_REPOS) is bare, unless it could be read as another's (a title starting like
 * owner/name/, or with the ? of a row two repos claim): then it has the default repo, or "-" when there is none.
 * @param {string | null | undefined} repo @param {string} key
 */
const inRepo = (repo, key) =>
  (!repo || repo === DEFAULT_REPO) && !/^\?|^[^/]+\/[^/]+\//.test(key) ? key : `${repo || DEFAULT_REPO || "-"}/${key}`;

/**
 * `key` in a coming row's repo, its chat's (comingChatRepo) read for its PR (`pr`), or by the chat alone for a no-pr key,
 * so a row that gained a PR finds the row it was; its chat's name when two repos claim it.
 * @param {any} row @param {unknown} chats @param {number | undefined} pr @param {string} key
 */
function inComingRepo(row, chats, pr, key) {
  const repo = comingChatRepo(chats, row.chat, pr);
  return repo === null ? `?${row.chat}/${key}` : inRepo(repo, key);
}
/**
 * A coming row's PR key. Two repos claiming the row leaves its PR unique in neither, so its title is in the key too: two
 * repos' rows of one PR and chat name stay two rows.
 * @param {any} row @param {unknown} chats
 */
const comingPrKey = (row, chats) =>
  `pr:${inComingRepo(row, chats, row.pr, comingChatRepo(chats, row.chat, row.pr) === null ? `${row.pr}/${row.title ?? ""}` : String(row.pr))}`;
/** A coming row's title key, `kind` title (read for its PR) or no-pr. @param {"title" | "no-pr"} kind @param {any} row @param {unknown} chats */
const comingTitleKey = (kind, row, chats) => `${kind}:${inComingRepo(row, chats, kind === "title" ? row.pr : undefined, row.title)}`;

/**
 * The keys that name a row in each merged list, each read with its own board's chats (`chats`): a coming row answers to
 * its PR and to its exact title in its repo, a chat to its name in its repo.
 * @type {Record<"needs" | "coming" | "chats" | "shipped", (row: any, chats?: unknown) => string[]>}
 */
const KEYS = {
  needs: (row) => (typeof row?.id === "string" ? [row.id] : []),
  coming: (row, chats) => [
    ...(typeof row?.pr === "number" ? [comingPrKey(row, chats)] : []),
    ...(typeof row?.title === "string" ? [comingTitleKey("title", row, chats), ...(typeof row?.pr === "number" ? [] : [comingTitleKey("no-pr", row, chats)])] : []),
  ],
  chats: (row) => (typeof row?.name === "string" ? [inRepo(chatRepoOf(row), row.name)] : []),
  // The server moves a Coming row whose PR merged to Shipped, so a push keeps the shipped rows it added. A shipped PR is
  // its repo's, and a row without one answers to its title in its repo.
  shipped: (row) =>
    typeof row?.pr === "number"
      ? [`pr:${typeof row?.repo === "string" ? row.repo : (DEFAULT_REPO ?? "")}#${row.pr}`]
      : typeof row?.title === "string"
        ? [`title:${inRepo(typeof row?.repo === "string" ? row.repo : DEFAULT_REPO, row.title)}`]
        : [],
};
const SECTIONS = /** @type {(keyof typeof KEYS)[]} */ (Object.keys(KEYS));

/**
 * The keys a row looks another up by, among the KEYS that row holds: a coming row with a PR finds the row of its PR, or
 * one of its title with no PR (the PR set since), so two PRs of the same title stay two rows; one with no PR finds any
 * row of its title. Every other row finds its own keys.
 * @param {keyof typeof KEYS} section @param {any} row @param {unknown} chats
 */
function probes(section, row, chats) {
  if (section !== "coming" || typeof row?.pr !== "number") return KEYS[section](row, chats).filter((k) => !k.startsWith("no-pr:"));
  return [comingPrKey(row, chats), ...(typeof row?.title === "string" ? [comingTitleKey("no-pr", row, chats)] : [])];
}

/** A row's keys, read with the chats of the board holding it. @param {keyof typeof KEYS} section @param {any} row @param {any} doc */
const keysIn = (section, row, doc) => KEYS[section](row, doc?.chats);
/** The keys a row looks another up by (probes), read with the chats of the board holding it. @param {keyof typeof KEYS} section @param {any} row @param {any} doc */
const probesIn = (section, row, doc) => probes(section, row, doc?.chats);

/** @param {any} doc @returns {Record<string, string[]>} */
function keysOf(doc) {
  return Object.fromEntries(SECTIONS.map((s) => [s, (Array.isArray(doc?.[s]) ? doc[s] : []).flatMap((/** @type {any} */ row) => keysIn(s, row, doc))]));
}

/** @typedef {{ section: keyof typeof KEYS, row: any, keys: string[], probes: string[] }} Added the row's keys and probes as the merge read them */

/** The sections whose rows the server removes on its own: handled cards, and Coming rows whose PR merged or closed. */
const SERVER_DROPS = /** @type {const} */ (["needs", "coming"]);

/** A short digest of each card, so a push can tell a card the monitor has not changed since it was last pushed. @param {any} doc */
function cardDigests(doc) {
  const needs = Array.isArray(doc?.needs) ? doc.needs : [];
  return Object.fromEntries(
    needs.filter((/** @type {any} */ need) => typeof need?.id === "string").map((/** @type {any} */ need) => [need.id, createHash("sha256").update(cardText(need)).digest("hex").slice(0, 16)]),
  );
}

/**
 * `doc` without the rows the server removed since the last push: a row all of whose keys are `dropped`, so a row the
 * monitor gave another PR or title stays, and a card only while it is as it was pushed, so a card the monitor asks
 * again is pushed again. A sidecar from before the digests knows no card's content, and leaves out each such card.
 * @param {any} doc @param {Dropped} dropped @param {string[]} [left] collects `section:key` of each row left out
 */
function withoutRows(doc, dropped, left = []) {
  for (const section of SERVER_DROPS) {
    if (!Array.isArray(doc[section]) || !dropped[section].size) continue;
    const now = section === "needs" ? cardDigests(doc) : {};
    doc[section] = doc[section].filter((/** @type {any} */ row) => {
      const keys = keysIn(section, row, doc);
      const hit = keys.length > 0 && keys.every((k) => dropped[section].has(k));
      const keep = !hit || (section === "needs" && dropped.digests !== null && dropped.digests[row.id] !== now[row.id]);
      if (!keep) left.push(`${section}:${keys[0]}`);
      return keep;
    });
  }
  return doc;
}

/** @typedef {{ needs: Set<string>, coming: Set<string>, digests: Record<string, string> | null }} Dropped */

/** The most shipped rows the server takes; it keeps the newest when it moves one there. */
const MAX_SHIPPED = 200;

/** How many of `keys` are each no-pr key. @param {string[]} keys @returns {Map<string, number>} */
const noPrCounts = (keys) => keys.filter((k) => k.startsWith("no-pr:")).reduce((n, k) => n.set(k, (n.get(k) ?? 0) + 1), new Map());

/**
 * `doc` with each added row that it does not already hold under one of the row's keys. A shipped row the server moved
 * there goes first, and Shipped keeps MAX_SHIPPED rows, the oldest by `day` left out, as the server keeps them. The
 * added chats come first (mergeBoard), so `doc`'s Coming rows are read with them.
 * @param {any} doc @param {Added[]} added @param {(row: any) => number} [day]
 * @param {Map<string, number>} [placeholders] the PR-less Coming rows of each no-pr key that mergeBoard read
 */
function withRows(doc, added, day = (row) => (typeof row?.shippedAt === "string" ? Date.parse(row.shippedAt) : -Infinity), placeholders = new Map()) {
  /** @type {Map<string, number> | null} */
  let spare = null;
  for (const { section, row, probes: lookups } of [...added.filter((a) => a.section === "chats"), ...added.filter((a) => a.section !== "chats")]) {
    if (!Array.isArray(doc[section])) doc[section] = [];
    const have = new Set(doc[section].flatMap((/** @type {any} */ one) => keysIn(section, one, doc)));
    if (lookups.some((k) => !k.startsWith("no-pr:") && have.has(k))) continue;
    // mergeBoard let each PR-less row it read stand for one PR row of its title, so an added PR row stands beside them;
    // only a PR-less row written to the file since stands for one, and first for an added PR-less row of it.
    if (section === "coming") {
      if (!spare) {
        const counts = noPrCounts(doc.coming.flatMap((/** @type {any} */ one) => keysIn(section, one, doc)));
        spare = new Map([...counts].map(([k, n]) => [k, n - (placeholders.get(k) ?? 0)]));
        for (const one of added)
          if (one.section === "coming" && typeof one.row?.pr !== "number" && one.probes.some((k) => have.has(k)))
            for (const k of one.keys) if ((spare.get(k) ?? 0) > 0) spare.set(k, /** @type {number} */ (spare.get(k)) - 1);
      }
      const titled = lookups.find((k) => k.startsWith("no-pr:") && (spare?.get(k) ?? 0) > 0);
      if (titled) {
        spare.set(titled, /** @type {number} */ (spare.get(titled)) - 1);
        continue;
      }
    }
    if (section === "shipped") doc[section].unshift(row);
    else doc[section].push(row);
  }
  if (Array.isArray(doc.shipped) && doc.shipped.length > MAX_SHIPPED) {
    const order = doc.shipped.map((/** @type {any} */ row, /** @type {number} */ index) => ({ at: day(row), index }));
    order.sort((/** @type {any} */ a, /** @type {any} */ b) => a.at - b.at || b.index - a.index);
    const oldest = new Set(order.slice(0, doc.shipped.length - MAX_SHIPPED).map((/** @type {any} */ one) => one.index));
    doc.shipped = doc.shipped.filter((/** @type {any} */ _, /** @type {number} */ index) => !oldest.has(index));
  }
  return doc;
}

/** Pretty, unless that would take the file over the size push-board reads. @param {any} doc */
function boardText(doc) {
  const pretty = `${JSON.stringify(doc, null, 2)}\n`;
  return Buffer.byteLength(pretty) <= MAX_BOARD_BYTES ? pretty : `${JSON.stringify(doc)}\n`;
}

/** The keys of the last successful push, or null when there are none to read. @param {string} file */
function readPushed(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    // One with no shipped keys keeps every server shipped row once.
    return SECTIONS.every((s) => s === "shipped" || Array.isArray(doc?.[s])) ? doc : null;
  } catch {
    return null;
  }
}

/**
 * Whether the server opened `row` again (its `again.at`) after the last push (`base.pushedAt`); a sidecar from before
 * the push time knows none, so any card opened again counts.
 * @param {any} row @param {any} base
 */
function reopenedSince(row, base) {
  const at = typeof row?.again?.at === "string" ? Date.parse(row.again.at) : NaN;
  if (!Number.isFinite(at)) return false;
  const pushedAt = typeof base?.pushedAt === "string" ? Date.parse(base.pushedAt) : NaN;
  return !Number.isFinite(pushedAt) || at > pushedAt;
}

/**
 * The local board plus every server row another writer added since the last
 * push: one with none of its keys in the local board or the base. A base key
 * missing locally is the monitor's own delete, and a row on both sides keeps
 * the local copy. A card or Coming row pushed last time that the server no
 * longer holds under any key was removed there (handled, merged, closed or
 * deleted by another chat), so it is dropped rather than pushed back; never
 * against a server board older than the base, as after a restore, which the
 * push fills again.
 * @param {string} text @param {any} server @param {any} sidecar the last push's keys @param {number} version the server board's version
 * @returns {{ added: Added[], dropped: Dropped, day: (row: any) => number, placeholders: Map<string, number> }}
 */
function mergeBoard(text, server, sidecar, version) {
  const mine = JSON.parse(text);
  const base = sidecar;
  /** @type {Added[]} */
  const added = [];
  /** @type {Dropped} */
  const dropped = { needs: new Set(), coming: new Set(), digests: base?.digests && typeof base.digests === "object" ? base.digests : null };
  // A Coming row's repo is its chat's, so every row is read with the chats the push leaves (the local ones and those
  // another writer added, merged first): a row on both sides has one key, whichever board's chats name its repo.
  const merged = { chats: Array.isArray(mine.chats) ? [...mine.chats] : [] };
  /** @type {Map<string, number>} */
  let placeholders = new Map();
  for (const section of ["chats", ...SECTIONS.filter((s) => s !== "chats")]) {
    const known = new Set((Array.isArray(mine[section]) ? mine[section] : []).flatMap((/** @type {any} */ row) => keysIn(section, row, merged)));
    const pushed = new Set(Array.isArray(base?.[section]) ? base[section] : []);
    const rows = Array.isArray(server?.[section]) ? server[section] : [];
    // A PR-less row, local or pushed and since deleted, stands for one server row of its title: the server's PR-less
    // row of it, else the first that has a PR (set since), so another chat's second PR of that title is kept. A
    // pushed one the monitor has since given a PR is its local PR row, not pushed under that PR, which stands for it only.
    /** @type {Map<string, number>} */
    const spare = new Map();
    if (section === "coming") {
      const local = Array.isArray(mine.coming) ? mine.coming : [];
      placeholders = noPrCounts(local.flatMap((/** @type {any} */ row) => keysIn(section, row, merged)));
      const given = noPrCounts(
        local
          .filter((/** @type {any} */ row) => typeof row?.pr === "number" && !pushed.has(comingPrKey(row, merged.chats)))
          .flatMap((/** @type {any} */ row) => probesIn(section, row, merged)),
      );
      const before = noPrCounts(Array.isArray(base?.[section]) ? base[section] : []);
      for (const [k, n] of before) spare.set(k, Math.max(0, n - (placeholders.get(k) ?? 0) - (given.get(k) ?? 0)));
      for (const [k, n] of placeholders) spare.set(k, (spare.get(k) ?? 0) + n);
      for (const row of rows) {
        if (typeof row?.pr === "number" || !probesIn(section, row, merged).some((k) => known.has(k) || pushed.has(k))) continue;
        for (const k of keysIn(section, row, merged)) if (spare.get(k)) spare.set(k, /** @type {number} */ (spare.get(k)) - 1);
      }
    }
    for (const row of rows) {
      const keys = keysIn(section, row, merged);
      const lookups = probesIn(section, row, merged);
      if (!keys.length) continue;
      const exact = lookups.filter((k) => !k.startsWith("no-pr:"));
      if (exact.some((k) => known.has(k))) continue;
      // A card pushed before and gone from the local file is the monitor's own delete, unless you opened it again
      // after that push (Answer again, or Reopen of an answered card): the monitor never saw that revision.
      if (exact.some((k) => pushed.has(k)) && !(section === "needs" && reopenedSince(row, base))) continue;
      // Only a PR row no local or pushed row names by its own keys is one a PR-less row of its title stands for.
      const titled = typeof row?.pr === "number" ? lookups.find((k) => k.startsWith("no-pr:") && spare.get(k)) : undefined;
      if (titled) {
        spare.set(titled, /** @type {number} */ (spare.get(titled)) - 1);
        continue;
      }
      keys.forEach((k) => known.add(k));
      // A served card carries a computed rev that is not part of the card.
      added.push({ section, row: section === "needs" ? (({ rev, ...need }) => need)(row) : row, keys, probes: lookups });
      if (section === "chats") merged.chats.push(row);
    }
  }
  for (const section of SERVER_DROPS) {
    if (!base || !Array.isArray(base[section]) || !Array.isArray(server?.[section]) || !(version >= base.version)) continue;
    // A PR row's no-pr probe is there too: a PR-less row stands for a server row of its title that has a PR.
    const there = new Set(server[section].flatMap((/** @type {any} */ row) => [...keysIn(section, row, merged), ...probesIn(section, row, merged).filter((k) => k.startsWith("no-pr:"))]));
    const pushed = new Set(base[section]);
    for (const row of mine[section] ?? []) {
      const keys = keysIn(section, row, merged);
      // A PR row is there only under its PR: a PR-less row of its title there stands for another.
      const lookups = typeof row?.pr === "number" ? probesIn(section, row, merged).filter((k) => !k.startsWith("no-pr:")) : [...probesIn(section, row, merged), ...keys];
      // Only a row as it was pushed: one with a new PR or title is the monitor's new work. A no-pr key only restates its
      // title, which a sidecar from before it holds alone.
      if (keys.length && keys.every((k) => pushed.has(k) || k.startsWith("no-pr:")) && !lookups.some((k) => there.has(k))) keys.forEach((k) => dropped[section].add(k));
    }
  }
  // The monitor's file has no server stamps, so a shipped row's day is the server's: one pushed before that the server
  // no longer holds was left out there as oldest, and one the server has not seen yet is the newest.
  /** @type {Map<string, number>} */
  const days = new Map();
  for (const row of Array.isArray(server?.shipped) ? server.shipped : [])
    for (const k of KEYS.shipped(row)) days.set(k, typeof row?.shippedAt === "string" ? Date.parse(row.shippedAt) : -Infinity);
  const pushedShipped = new Set(Array.isArray(base?.shipped) ? base.shipped : []);
  /** @param {any} row */
  const day = (row) => {
    if (typeof row?.shippedAt === "string") return Date.parse(row.shippedAt);
    const keys = KEYS.shipped(row);
    const known = keys.find((k) => days.has(k));
    if (known) return /** @type {number} */ (days.get(known));
    return keys.some((k) => pushedShipped.has(k)) ? -Infinity : Infinity;
  };
  // Reported in the board's order; withRows takes the chats first.
  added.sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section));
  return { added, dropped, day, placeholders };
}

/**
 * A card as JSON with its keys in order and without the served rev or the server's Answer again, to tell
 * whether the server holds it as it is. @param {any} need
 */
function cardText(need) {
  /** @param {any} v @returns {any} */
  const sorted = (v) =>
    Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
  const { rev, again, ...card } = need ?? {};
  return JSON.stringify(sorted(card));
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (err) {
    return fail(`${/** @type {Error} */ (err).message}\n\n${USAGE}`, 2);
  }
  if (o.help || !o.mode) {
    process.stdout.write(USAGE);
    return o.help ? 0 : 2;
  }
  if ((o.mode === "handled" || o.mode === "verify" || o.mode === "media") && !isId(o.id))
    return fail(`${o.mode === "media" ? "item" : "reply"} id must match [A-Za-z0-9._-]{1,100}`, 2);
  if (o.ifMatch !== undefined && !/^\d{1,15}$/.test(o.ifMatch)) return fail("--if-match must be a version number", 2);

  let board;
  /** @type {import("../bridge/lib/board-client.mjs").Clip[]} */
  let clips = [];
  if (o.mode === "push" || (o.mode === "media" && o.file !== undefined)) {
    try {
      board = readBoard(/** @type {string} */ (o.file));
    } catch (err) {
      return fail(/** @type {Error} */ (err).message);
    }
  }
  if (o.mode === "media") {
    try {
      clips = await readMedia(o, (msg) => process.stderr.write(`push-board: ${msg}\n`));
      if (board !== undefined) board = attachMedia(board, /** @type {string} */ (o.id), mediaOf(clips));
    } catch (err) {
      return fail(/** @type {Error} */ (err).message);
    }
  }

  const origin = serverOrigin(process.env.RIVET_URL || undefined);
  const token = await readToken(makeExec(), "RIVET_BOARD_TOKEN");
  if (o.mode === "fingerprint") {
    process.stdout.write(`${fingerprint(token)}\n`);
    return 0;
  }
  const auth = { authorization: `Bearer ${token}` };
  // A fresh timeout per request: a signal made up front would already have run
  // out for the board PUT that follows several minutes of media uploads.
  const common = () => ({ redirect: /** @type {const} */ ("error"), signal: AbortSignal.timeout(30_000) });

  if (o.mode === "media") {
    try {
      await uploadClips(clips, { origin, token, fetch, log: (msg) => process.stderr.write(`${msg}\n`) });
    } catch (err) {
      return fail(/** @type {Error} */ (err).message);
    }
    if (board === undefined) {
      process.stdout.write(`${JSON.stringify({ media: mediaOf(clips) }, null, 2)}\n`);
      return 0;
    }
    fs.writeFileSync(/** @type {string} */ (o.file), board);
  }
  if (o.mode === "push" || o.mode === "media") {
    const file = /** @type {string} */ (o.file);
    const sidecar = `${file}.pushed`;
    const merge = o.ifMatch === undefined && !o.replace;
    for (let attempt = 1; ; attempt++) {
      /** @type {Record<string, string>} */
      const headers = { ...auth, "content-type": "application/json" };
      const text = /** @type {string} */ (board);
      let body = text;
      /** @type {Added[]} */
      let added = [];
      /** @type {Dropped | null} */
      let dropped = null;
      /** @type {((row: any) => number) | undefined} */
      let day;
      /** @type {Map<string, number> | undefined} */
      let placeholders;
      /** @type {string[]} */
      const left = [];
      if (o.ifMatch !== undefined) headers["if-match"] = o.ifMatch;
      if (merge) {
        const got = await fetch(`${origin}/api/board`, { ...common(), headers: auth });
        if (!got.ok) return fail(`reading the server board: ${await serverError(got)}`);
        const current = await got.json().catch(() => null);
        if (!current || !Number.isSafeInteger(current.version)) return fail("server did not return the board version");
        ({ added, dropped, day, placeholders } = mergeBoard(text, current.board, readPushed(sidecar), current.version));
        const drops = dropped.needs.size + dropped.coming.size;
        // Compact: the server caps the body at the 1 MB the file may hold, and indenting can cross it.
        if (added.length || drops) body = JSON.stringify(withoutRows(withRows(JSON.parse(text), added, day, placeholders), dropped, left));
        headers["if-match"] = String(current.version);
      }
      const res = await fetch(`${origin}/api/board`, { ...common(), method: "PUT", headers, body });
      if (res.status === 409 && merge) {
        await res.body?.cancel().catch(() => {});
        if (attempt < PUSH_TRIES) continue;
        return fail(`the server board changed during each of ${PUSH_TRIES} tries; nothing was pushed, push again`);
      }
      if (!res.ok) return fail(res.status === 409 ? `stale version (${await serverError(res)})` : await serverError(res));
      const doc = await res.json().catch(() => null);
      if (!doc || !Number.isSafeInteger(doc.version)) return fail("server did not return a version");
      process.stdout.write(`version ${doc.version}\n`);
      let learnt = true;
      if (added.length) {
        const kept = added.map(({ section, keys }) => `${section}:${keys[0]}`);
        process.stderr.write(`push-board: kept ${kept.length} item(s) other chats added: ${kept.join(", ")}\n`);
      }
      if (left.length) process.stderr.write(`push-board: left out ${left.length} item(s) the server removed: ${left.join(", ")}\n`);
      if (added.length || left.length) {
        // The monitor may have changed the file while the push was in flight: add the kept rows to it as it is now.
        try {
          const latest = JSON.parse(fs.readFileSync(file, "utf8"));
          fs.writeFileSync(file, boardText(dropped ? withoutRows(withRows(latest, added, day, placeholders), dropped) : withRows(latest, added, day, placeholders)));
        } catch {
          learnt = false;
          process.stderr.write(`push-board: ${file} is not valid JSON now; the kept items stay on the server and are kept again next push\n`);
        }
      }
      // A kept row left out of the file must not enter the base, or the next push would read it as the monitor's delete.
      const pushed = JSON.parse(learnt ? body : text);
      fs.writeFileSync(sidecar, `${JSON.stringify({ version: doc.version, pushedAt: new Date().toISOString(), ...keysOf(pushed), digests: cardDigests(pushed) }, null, 2)}\n`);
      return 0;
    }
  }
  if (o.mode === "replies") {
    const res = await fetch(`${origin}/api/replies?handled=false`, { ...common(), headers: auth });
    if (!res.ok) return fail(await serverError(res));
    process.stdout.write(`${JSON.stringify(await res.json(), null, 2)}\n`);
    return 0;
  }
  const id = /** @type {string} */ (o.id);
  if (o.mode === "verify") {
    const res = await fetch(`${origin}/api/replies/${encodeURIComponent(id)}`, { ...common(), headers: auth });
    if (res.status === 404) return fail("no such reply");
    if (!res.ok) return fail(await serverError(res));
    const out = replyRecord(await res.json().catch(() => null), id);
    if (!out) return fail("server returned a different reply");
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }
  const res = await fetch(`${origin}/api/replies/${encodeURIComponent(id)}/handled`, {
    ...common(),
    method: "POST",
    headers: auth,
  });
  if (!res.ok) return fail(await serverError(res));
  await res.body?.cancel().catch(() => {});
  process.stdout.write(`handled ${id}\n`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.exitCode = fail(err instanceof Error ? err.message : "error");
  },
);
