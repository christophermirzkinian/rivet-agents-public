#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { documentName, MAX_MEDIA_BYTES, readClip, uploadClips } from "../bridge/lib/board-client.mjs";
import { definitiveRefusal, dropCardHold, holdForCard, isVideoCard, rekeyCardHold } from "../bridge/lib/card-holds.mjs";
import { makeExec, readToken, resolveBin, serverOrigin } from "../bridge/lib/config.mjs";
import { folderRepo, prRepo } from "../bridge/lib/folder-repo.mjs";
import { HOLDS_FILE } from "../bridge/lib/holds-file.mjs";
import { preflight } from "../bridge/lib/media-preflight.mjs";
import { sanitizeLine } from "../bridge/lib/templates.mjs";
import { isId } from "../bridge/lib/validate.mjs";
import { defaultRepo } from "../src/shared/repos.ts";

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

const USAGE = `Answer you in the Rivet Agents app: a chat reply, a card you must confirm, or an update card.

  node say.mjs --text "<message>" [--reply-to <message id>] [--image <abs path> ...] [--video <abs path>] [--file <abs path>.pdf]
  node say.mjs --stdin [--reply-to <message id>]       read the message from stdin
  node say.mjs --image <abs path> [--reply-to <message id>]   a photo alone
  node say.mjs --new [--title "<title>"] --text "<message>"   start a conversation of its own
  node say.mjs --reply-to <message id> --card --text "<result>" [--image <abs path> ...] [--video <abs path>] [--pr <n> [--repo <owner/name>]] [--ask <ask id>]
  node say.mjs --reply-to <message id> --ack "building it, ~9:45"

Where it lands: --reply-to <id> is a chat reply (acks and talk) in the
conversation of that message (any message of it, its first, or a card answer's
reply id). --new starts a conversation; its id is what "sent <id>" prints, so
follow-ups reply to it.

Without either it is an update card, for progress and status only: the first
line its title, the rest its text, its photos or video its media. Its thread is
--thread, else the one conversation active this week its text names by PR,
chat, ask or card id, else Rivet. --tag says what happened ("Fixed", "CI").

--reply-to <id> --card asks you to confirm something you asked for, only when
you must (a video waiting on your OK, a report you have to judge): a decision
card in Needs you with "Yes, keep it" and "Change it", its photos or video kept,
and one line in the conversation that opens it ("Card: <title> >"); a --tag or
--thread on it is dropped. Finished work takes no card: rivet ask close records
it. Nor does an answer to you go as an update card: the board refuses an update
card that answers one of your messages. --pr <n> (with --repo <owner/name>, or
the working folder's repo when that is left off) names the PR it is about, and
your yes is that PR's decision of record. Pass --ask a-N, the ask the card is
about, so the card stays "under way" until the ask closes: your answer makes it
that ask's card, and Cards shows it under way at the ask's stage, then Done or
Called off with the note it closed with. A --card with a --video about a PR of
the main repo (the first of RIVET_REPOS) holds that PR's merge in holds.json from
the moment it is posted until your yes on it (by hand: rivet unhold --card <id>).

--reply-to <id> --ack "<words>" sets the status line on your message
("Rivet: building it · ~9:45") instead of posting a bubble: no unread, no push.
A later --ack replaces it. Use it for acks; real answers stay --text.

--image puts a jpg or png in the chat bubble (up to 3; tap it for full size).
--video puts one H.264 mp4 there (25 MB at most). Both are checked as card media
are (ffmpeg), uploaded to the board's media store, then sent; never send a disk
path, your phone cannot open one. Text is optional when there is a photo or video.

--file puts one PDF there (25 MB at most, its first bytes %PDF-): a tile with its
name and size that opens in the app's PDF viewer, where you can share or save
it. It goes on a chat line (--reply-to or --new), not a card; a card carries
documents through rivet card --file. Text is optional with it too.

The app shows the message, reads it aloud when the speaker is on, and pushes it
to your phone when the app is closed.

Token: RIVET_BOARD_TOKEN (from the repo's .env, or the Keychain; see npm run setup).
Server: RIVET_URL (default http://127.0.0.1:8130; http only for localhost).
`;

export const MAX_SAY_TEXT = 4000;
export const MAX_SAY_IMAGES = 3;
export const MAX_SAY_TITLE = 120;
export const MAX_CARD_TAG = 40;
export const MAX_CARD_THREAD = 80;
export const MAX_SAY_ACK = 120;

/** @param {string} msg @param {number} [code] */
function fail(msg, code = 1) {
  process.stderr.write(`say: ${msg}\n`);
  return code;
}

/**
 * A message that starts with "--" is a flag swallowed as the words (`--text --stdin` sent the owner "--stdin"), never
 * words for the owner: the refusal names the fix, or undefined when the value is fine.
 * @param {string} flag @param {string} value
 */
export function dashRefusal(flag, value) {
  if (!value.trim().startsWith("--") && value.trim() !== "-h") return undefined;
  const shown = sanitizeLine(value.trim(), 40);
  if (flag === "--text") return `--text got "${shown}" as its message; for a file use --stdin alone. Nothing was sent`;
  if (flag === "--stdin") return `--stdin got "${shown}" as its message; a message never starts with --. Nothing was sent`;
  return `${flag} got "${shown}" as its value, a flag; give ${flag} its own value. Nothing was sent`;
}

/** A parse error printed on its own, without the usage text after it. */
export class DashError extends Error {}

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ text?: string, replyTo?: string, stdin?: boolean, help?: boolean, images: string[], video?: string, file?: string, new?: boolean, title?: string, card?: boolean, tag?: string, thread?: string, ack?: string, pr?: number, repo?: string, ask?: string }} */
  const o = { images: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--stdin") o.stdin = true;
    else if (a === "--new") o.new = true;
    else if (a === "--card") o.card = true;
    else if (a === "--ask") {
      const value = argv[++i];
      if (value === undefined || !/^[a-z0-9-]{1,40}$/.test(value)) throw new Error("--ask takes an ask id, as a-1");
      o.ask = value;
    } else if (a === "--pr" || a === "--repo") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${a} needs a value`);
      if (a === "--repo") {
        if (!REPO_RE.test(value)) throw new Error("--repo takes owner/name");
        o.repo = value;
      } else {
        if (!/^[1-9]\d{0,8}$/.test(value)) throw new Error("--pr takes a PR number");
        o.pr = Number(value);
      }
    }
    else if (a === "--file") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${a} needs a value`);
      if (o.file !== undefined) throw new Error("one --file at most");
      if (!path.isAbsolute(value) || !/\.pdf$/i.test(value)) throw new Error("--file takes the absolute path of a pdf");
      o.file = value;
    }
    else if (a === "--text" || a === "--reply-to" || a === "--image" || a === "--video" || a === "--title" || a === "--tag" || a === "--thread" || a === "--ack") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${a} needs a value`);
      const dash = dashRefusal(a, value);
      if (dash) throw new DashError(dash);
      if (a === "--text") o.text = value;
      else if (a === "--tag") o.tag = value;
      else if (a === "--ack") o.ack = value;
      else if (a === "--thread") o.thread = value;
      else if (a === "--title") o.title = value;
      else if (a === "--reply-to") o.replyTo = value;
      else if (a === "--image") {
        if (!path.isAbsolute(value) || !/\.(jpe?g|png)$/i.test(value)) throw new Error("--image takes the absolute path of a jpg or png");
        if (o.images.length === MAX_SAY_IMAGES) throw new Error(`at most ${MAX_SAY_IMAGES} images`);
        if (o.images.includes(value)) throw new Error(`${path.basename(value)} is given twice`);
        o.images.push(value);
      } else {
        if (o.video !== undefined) throw new Error("one --video at most");
        if (!path.isAbsolute(value) || !/\.mp4$/i.test(value)) throw new Error("--video takes the absolute path of an mp4");
        o.video = value;
      }
    } else throw new Error(`unknown argument ${a}`);
  }
  if (o.stdin && o.text !== undefined) throw new Error("pick one of --text and --stdin");
  if (o.replyTo !== undefined && !isId(o.replyTo)) throw new Error("--reply-to must match [A-Za-z0-9._-]{1,100}");
  if (o.new && o.replyTo !== undefined) throw new Error("--new starts a conversation; it replies to nothing");
  if (o.title !== undefined && !o.new) throw new Error("--title names a --new conversation");
  if (o.title !== undefined && (!o.title.trim() || o.title.length > MAX_SAY_TITLE)) throw new Error(`--title is 1 to ${MAX_SAY_TITLE} characters`);
  if (o.ack !== undefined) {
    if (o.replyTo === undefined) throw new Error("--ack goes on a message: give --reply-to <id>");
    if (o.stdin || o.text !== undefined || o.images.length || o.video !== undefined || o.file !== undefined || o.card || o.tag !== undefined || o.thread !== undefined)
      throw new Error("--ack is a status line: --reply-to and --ack, nothing else");
    if (!o.ack.trim() || o.ack.trim().length > MAX_SAY_ACK) throw new Error(`--ack is 1 to ${MAX_SAY_ACK} characters`);
  }
  if (o.card && o.replyTo === undefined) throw new Error("--card answers a message: give --reply-to <id>");
  if ((o.pr !== undefined || o.repo !== undefined) && !o.card) throw new Error("--pr names the PR of an outcome card: give --reply-to <id> --card");
  if (o.repo !== undefined && o.pr === undefined) throw new Error("--repo names the PR's repo: give --pr <n>");
  if (o.ask !== undefined && !o.card) throw new Error("--ask names the ask of an outcome card: give --reply-to <id> --card");
  // An outcome (--card) takes no tag or thread, but an older call that passes them still posts it: the server drops them.
  const card = o.card || (o.replyTo === undefined && !o.new);
  if (card && o.file !== undefined && o.ack === undefined)
    throw new Error("--file goes on a chat line (--reply-to or --new), not a card; a card carries a PDF through rivet card --file");
  if (!card && (o.tag !== undefined || o.thread !== undefined))
    throw new Error("--tag and --thread go on an update card (progress, with no --reply-to); a reply to you takes neither");
  if (o.tag !== undefined && (!o.tag.trim() || o.tag.trim().length > MAX_CARD_TAG)) throw new Error(`--tag is 1 to ${MAX_CARD_TAG} characters`);
  if (o.thread !== undefined && (!o.thread.trim() || o.thread.trim().length > MAX_CARD_THREAD)) throw new Error(`--thread is 1 to ${MAX_CARD_THREAD} characters`);
  return o;
}

/**
 * The say request: text when there is any, the reply id, the photos in order and the video, each by its sha256 in
 * the media store.
 * @param {string} text
 * @param {string | undefined} replyTo
 * @param {{ role: "image" | "video" | "file", sha256: string, file?: string }[]} clips
 * @param {{ new?: boolean, title?: string, card?: boolean, tag?: string, thread?: string, schedule?: string, ack?: string, pr?: number, repo?: string, ask?: string }} [start] say.mjs --new [--title], --card [--pr [--repo]] [--ask], --tag, --thread, --schedule, --ack
 */
export function sayBody(text, replyTo, clips, start = {}) {
  // Two paths to the same bytes are one photo.
  const images = [...new Set(clips.filter((clip) => clip.role === "image").map((clip) => clip.sha256))];
  const video = clips.find((clip) => clip.role === "video")?.sha256;
  // The PDF under its own name, kept to the letters the server's pdfFileName keeps.
  const files = clips.filter((clip) => clip.role === "file").map((clip) => ({ sha256: clip.sha256, name: documentName(clip.file ?? "document.pdf") }));
  return {
    ...(text ? { text } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(images.length ? { images } : {}),
    ...(video ? { video } : {}),
    ...(files.length ? { files } : {}),
    ...(start.new ? { new: true } : {}),
    ...(start.new && start.title ? { title: start.title.trim() } : {}),
    ...(start.card ? { card: true } : {}),
    ...(start.card && start.pr !== undefined ? { pr: start.pr, ...(start.repo ? { repo: start.repo } : {}) } : {}),
    ...(start.card && start.ask ? { ask: start.ask } : {}),
    ...(start.tag ? { tag: start.tag.trim() } : {}),
    ...(start.thread ? { thread: start.thread.trim() } : {}),
    ...(start.ack ? { ack: start.ack.trim() } : {}),
  };
}

/**
 * The PDF --file names, read for upload: refused unless it is a file of 1 byte to 25 MB whose first bytes are %PDF-.
 * @param {string} file
 */
export function readPdf(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`${path.basename(file)}: file not found`);
  }
  if (!stat.isFile()) throw new Error(`${path.basename(file)}: not a file`);
  if (stat.size > MAX_MEDIA_BYTES) throw new Error(`${path.basename(file)}: ${(stat.size / 1024 / 1024).toFixed(1)} MB, over the 25 MB limit`);
  return readClip(file, { ".pdf": "application/pdf" });
}

/**
 * Holds the merge of the PR a posted video card is about, as the server stored it (it may have found the PR itself),
 * beside the PRs already `held` for it, which it leaves as they are: his yes may have released one since. Returns the
 * lines to print; throws when the board cannot be read or the hold cannot be written.
 * @param {string} cardId @param {{ origin: string, token: string, fetch: typeof fetch, file?: string, now?: Date, held?: number[] }} o
 * @returns {Promise<string[]>}
 */
export async function holdSayCard(cardId, { origin, token, fetch: fetchFn, file = HOLDS_FILE, now, held = [] }) {
  const res = await fetchFn(`${origin}/api/board`, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`board read: http ${res.status}`);
  const doc = await res.json();
  const need = doc?.board?.needs?.find((/** @type {any} */ n) => n?.id === cardId);
  if (!need) throw new Error(`card ${cardId} is not on the board`);
  const prs = [...held, ...holdForCard(need, { file, now, skip: held }).map(({ pr }) => pr)];
  if (prs.length) return prs.map((pr) => `held #${pr} until the owner's yes on video card ${cardId} (holds.json)`);
  if (isVideoCard(need) && typeof need.pr === "number") return [`card ${cardId} is about ${String(need.repo)}#${need.pr}: holds.json holds only ${defaultRepo() ?? "the main repo's (none is set in RIVET_REPOS)"} PRs, so no merge hold was placed`];
  return [];
}

/**
 * Posts the say body. A --card with a video (`hold`) holds its PR's merge first, under a provisional id moved to the
 * card the server names, so no merge slips between the card and its hold; whatever goes wrong after, the hold stays.
 * Lines go to `out` and `err`; `posted` is whether the message went up.
 * @param {Record<string, unknown>} body
 * @param {{ origin: string, token: string, fetch: typeof fetch, file?: string, now?: Date, out: (line: string) => void,
 *   err: (line: string) => void, hold?: { pr?: number, repo?: string, text: string, video: { sha256: string, type: string } } }} o
 * @returns {Promise<{ code: number, posted: boolean }>}
 */
export async function postSay(body, { origin, token, fetch: fetchFn, file = HOLDS_FILE, now = new Date(), out, err, hold }) {
  const why = (/** @type {unknown} */ e) => sanitizeLine(/** @type {Error} */ (e).message, 200);
  const pending = `say-pending-${randomUUID()}`;
  /** @type {number[]} */
  let held = [];
  if (hold) {
    const card = { id: pending, pr: hold.pr, repo: hold.repo, title: hold.text, ask: hold.text, media: { kind: "video", after: hold.video } };
    try {
      held = holdForCard(card, { file, now }).map(({ pr }) => pr);
    } catch (e) {
      err(`the video card's merge hold could not be written (${why(e)}); nothing was sent`);
      return { code: 1, posted: false };
    }
  }
  const prs = `#${held.join(", #")}`;
  const unhold = `rivet unhold --card ${pending}`;
  const kept = held.length ? `; the merge hold on ${prs} is kept, as the card may be up (if it is not: ${unhold})` : "";
  const drop = () => {
    if (!held.length) return "";
    try {
      dropCardHold(pending, { file });
      return "";
    } catch (e) {
      return `; the merge hold on ${prs} could not be taken back (${why(e)}): ${unhold}`;
    }
  };
  let res;
  try {
    res = await fetchFn(`${origin}/api/bridge/say`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    err(`${why(e)}${kept}`);
    return { code: 1, posted: false };
  }
  if (!res.ok) {
    const doc = await res.json().catch(() => null);
    const line = `http ${res.status}${typeof doc?.error === "string" ? `: ${sanitizeLine(doc.error, 200)}` : ""}`;
    err(`${line}${definitiveRefusal(res.status) ? drop() : kept}`);
    return { code: 1, posted: false };
  }
  const doc = await res.json().catch(() => null);
  out(`sent ${typeof doc?.id === "string" ? sanitizeLine(doc.id, 100) : ""}`);
  if (!hold) return { code: 0, posted: true };
  if (typeof doc?.card !== "string") {
    if (!held.length) return { code: 0, posted: true };
    err(`WARNING the server named no card for the video, so the merge hold on ${prs} stays under ${pending}: his yes will not release it; after it, ${unhold}`);
    return { code: 1, posted: true };
  }
  const cardId = sanitizeLine(doc.card, 100);
  if (held.length) {
    try {
      rekeyCardHold(pending, doc.card, { file });
    } catch (e) {
      err(`WARNING the merge hold on ${prs} stays under ${pending}, not video card ${cardId} (${why(e)}): his yes will not release it; after it, ${unhold}`);
      return { code: 1, posted: true };
    }
  }
  try {
    for (const line of await holdSayCard(doc.card, { origin, token, fetch: fetchFn, file, now, held })) err(line);
  } catch (e) {
    err(`WARNING a PR the server found on video card ${cardId} may not be held (${why(e)}): ${held.length ? `${prs} is held until his yes (by hand: rivet unhold --card ${cardId})` : "no merge hold was written"}; tell the monitor`);
    return { code: 1, posted: true };
  }
  return { code: 0, posted: true };
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_SAY_TEXT * 4) throw new Error(`the message is over ${MAX_SAY_TEXT} characters`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof DashError) return fail(err.message, 2);
    return fail(`${/** @type {Error} */ (err).message}\n\n${USAGE}`, 2);
  }
  const media = o.images.length > 0 || o.video !== undefined || o.file !== undefined;
  if (o.help || (!o.stdin && o.text === undefined && !media && o.ack === undefined)) {
    process.stdout.write(USAGE);
    return o.help ? 0 : 2;
  }
  const text = (o.stdin ? await readStdin() : (o.text ?? "")).trim();
  if (!text && !media && o.ack === undefined) return fail("the message is empty", 2);
  if (text.length > MAX_SAY_TEXT) return fail(`the message is over ${MAX_SAY_TEXT} characters`, 2);
  const dash = dashRefusal(o.stdin ? "--stdin" : "--text", text);
  if (dash) return fail(dash, 2);
  const exec = makeExec();
  // A --pr with no --repo is this folder's repo's PR.
  if (o.pr !== undefined && o.repo === undefined) {
    try {
      o.repo = prRepo(o.pr, await folderRepo(exec, () => resolveBin("git"), process.cwd()));
    } catch (err) {
      return fail(`${/** @type {Error} */ (err).message}\n\n${USAGE}`, 2);
    }
  }
  /** @type {import("../bridge/lib/media-preflight.mjs").MediaFile[]} */
  const files = o.images.map((file) => ({ role: /** @type {const} */ ("still"), file }));
  if (o.video !== undefined) files.push({ role: "video", file: o.video });
  if (files.length) {
    const bin = (/** @type {string} */ name) => {
      try {
        return resolveBin(name);
      } catch {
        return undefined;
      }
    };
    const { ok, problems } = await preflight(files, { exec, ffprobe: bin("ffprobe"), ffmpeg: bin("ffmpeg"), tmpdir: os.tmpdir() });
    for (const problem of problems) process.stderr.write(`say: ${problem}\n`);
    if (!ok) return fail("media refused; nothing was sent", 5);
  }
  /** @type {{ role: "image" | "video" | "file", file: string, type: string, bytes: Buffer, sha256: string }[]} */
  const clips = files.map(({ role, file }) => ({ role: role === "video" ? "video" : "image", file, ...readClip(file) }));
  // A PDF is read, not played: readClip checks its size and %PDF- start, and the server checks both again.
  if (o.file !== undefined) {
    try {
      clips.push({ role: "file", file: o.file, ...readPdf(o.file) });
    } catch (err) {
      return fail(`${/** @type {Error} */ (err).message}; nothing was sent`, 5);
    }
  }

  const origin = serverOrigin(process.env.RIVET_URL || undefined);
  const token = await readToken(exec, "RIVET_BOARD_TOKEN");
  await uploadClips(clips, { origin, token, fetch, log: (msg) => process.stderr.write(`say: ${msg}\n`) });
  const video = o.card ? clips.find((clip) => clip.role === "video") : undefined;
  const { code, posted } = await postSay(sayBody(text, o.replyTo, clips, { new: o.new, title: o.title, card: o.card, pr: o.pr, repo: o.repo, ask: o.ask, tag: o.tag, thread: o.thread, ack: o.ack }), {
    origin,
    token,
    fetch,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`say: ${line}\n`),
    ...(video ? { hold: { pr: o.pr, repo: o.repo, text, video: { sha256: video.sha256, type: video.type } } } : {}),
  });
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.exitCode = fail(err instanceof Error ? err.message : "error");
    },
  );
}
