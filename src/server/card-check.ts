import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MERGE_READY } from "../shared/answers.js";
import type { Need } from "../shared/board.js";
import type { CardChecker } from "../shared/card-check.js";
import { redactText, redactUrl } from "./redact.js";

// The card checker (Settings › Behaviours): each card a chat posts through the board token is checked before it is
// stored. A rule set to block refuses the write, one set to warn lets it through with a warning; the posting chat
// reads both, so every message names what to change and never echoes a link.

export interface MediaSize {
  width: number;
  height: number;
}

/** A media file's pixel size, or null when it cannot be read. */
export type MediaSizeOf = (sha: string) => MediaSize | null;

export interface CardCheckResult {
  refusals: string[];
  warnings: string[];
}

const MAX_TITLE_WORDS = 12;
const MAX_ASK = 1500;
const MAX_MAIN_LINE = 300;
const MAX_BULLETS = 3;
const MAX_POINTS = 3;
const MAX_STILL_SIDE = 1600;

// The card video sizes name the owner's phone, so they live in card-check-extra.ts, which the public export leaves
// out; it is read only when present and never imported by name. Without it the video rule passes any size it can read.
const PRIVATE_FILE = new URL("./card-check-extra.ts", import.meta.url);

async function privateVideoSizes(): Promise<readonly string[]> {
  if (!existsSync(fileURLToPath(PRIVATE_FILE))) return [];
  return ((await import(PRIVATE_FILE.href)) as { VIDEO_SIZES: readonly string[] }).VIDEO_SIZES;
}

/** The sizes a card video may be, as "WxH", the one to encode to first. */
export const CARD_VIDEO_SIZES: readonly string[] = await privateVideoSizes();

const BULLET = /^\s*(?:[•\-*–]|\d+[.)])\s+/;
/** An answer, or an option that changes nothing, needs no picture: a whole word, so "Hold-to-jump control" is a look. */
const NO_PICTURE =
  /^(?:none|neither|no|not|not now|later|skip|hold|wait|keep|today|current|as is|other|something else|cancel|yes|ok|okay|approve|approved|ship|ship it|go|go ahead|looks good|change|changes|send changes|revise|redo|fix)(?![\w-])/i;
const URL_IN_TEXT = /https?:\/\/\S+/g;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const shown = (size: string) => size.replace("x", "×");

/** JSON with every object's keys in order, so two copies of a card compare by what they hold. */
const canonical = (value: unknown) =>
  JSON.stringify(value ?? null, (_key, field: unknown) =>
    field && typeof field === "object" && !Array.isArray(field) ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : field,
  );

function shape(need: Need): string[] {
  const broke: string[] = [];
  const words = need.title.trim().split(/\s+/).length;
  if (words > MAX_TITLE_WORDS) broke.push(`the title has ${words} words (at most ${MAX_TITLE_WORDS})`);
  if (need.ask !== undefined) {
    if (need.ask.length > MAX_ASK) broke.push(`the ask is ${need.ask.length} characters (at most ${MAX_ASK})`);
    const items = need.ask.split(/\n\s*\n/).filter((item) => item.trim());
    items.forEach((item, index) => {
      const lines = item.split("\n").filter((line) => line.trim());
      const bullets = lines.filter((line) => BULLET.test(line)).length;
      const main = lines.filter((line) => !BULLET.test(line));
      const name = `item ${index + 1}`;
      if (main.length > 1) broke.push(`${name} has ${main.length} lines that are not bullets`);
      else if (main[0] !== undefined && main[0].length > MAX_MAIN_LINE) broke.push(`${name}'s main line is ${main[0].length} characters`);
      if (bullets > MAX_BULLETS) broke.push(`${name} has ${bullets} bullets`);
    });
  }
  if (need.points && need.points.length > MAX_POINTS) broke.push(`the plan has ${need.points.length} points`);
  if (!broke.length) return [];
  return [`card ${need.id}: ${broke.join(", ")}; keep each item to a heading and at most ${MAX_BULLETS} short bullets (detail goes in the saved file)`];
}

function options(need: Need): string[] {
  if (need.kind === MERGE_READY || need.media?.kind !== "stills") return [];
  const pictured = (need.options ?? []).filter((option) => option.text !== true && !NO_PICTURE.test(option.label.trim())).length;
  const stills = need.media.stills?.length ?? 0;
  if (pictured < 2 || stills >= pictured) return [];
  return [`card ${need.id}: ${plural(pictured, "option")} but ${plural(stills, "still")}; put every option's picture on the card (one --still each)`];
}

type Ref = { sha256: string; type: string };

/** The card's stills and before/after media of one kind; a video's poster is a frame of it, at its size, so not judged. */
function refs(need: Need, kind: "image/" | "video/"): { name: string; ref: Ref }[] {
  const media = need.media;
  if (!media) return [];
  const named: { name: string; ref: Ref | undefined }[] = [
    ...(media.stills ?? []).map((ref, index) => ({ name: `still ${index + 1}`, ref })),
    { name: kind === "video/" ? "the before video" : "the before image", ref: media.before },
    { name: kind === "video/" ? "the after video" : "the after image", ref: media.after },
  ];
  return named.flatMap(({ name, ref }) => (ref && ref.type.startsWith(kind) ? [{ name, ref }] : []));
}

function stills(need: Need, mediaSize: MediaSizeOf, unread: string[]): string[] {
  return refs(need, "image/").flatMap(({ name, ref }) => {
    const size = mediaSize(ref.sha256);
    if (!size) {
      unread.push(`card ${need.id}: could not read the size of ${name}; check it is ${MAX_STILL_SIDE} px or less on its long side`);
      return [];
    }
    if (Math.max(size.width, size.height) <= MAX_STILL_SIDE) return [];
    return [`card ${need.id}: ${name} is ${size.width}×${size.height}, over ${MAX_STILL_SIDE} px on its long side; shrink it (sips -Z ${MAX_STILL_SIDE}, or ffmpeg scale) before --still`];
  });
}

/** `videoSizes` empty: any size it can read passes. */
function video(need: Need, mediaSize: MediaSizeOf, videoSizes: readonly string[], unread: string[]): string[] {
  const first = videoSizes[0];
  return refs(need, "video/").flatMap(({ name, ref }) => {
    const size = mediaSize(ref.sha256);
    if (!size) {
      unread.push(`card ${need.id}: could not read the size of ${name} (a webm, or a file cut short); check it is the card size${first ? ` (${shown(first)})` : ""}`);
      return [];
    }
    if (!first || videoSizes.includes(`${size.width}x${size.height}`)) return [];
    return [`card ${need.id}: ${name} is ${size.width}×${size.height}, not the card size; encode it to ${shown(first)}`];
  });
}

/** Every text field a chat writes on a card, as sent. */
function texts(need: Need): string[] {
  const evidence = need.evidence;
  return [
    need.title,
    need.ask,
    ...(need.options ?? []).flatMap((option) => [option.label, option.short, option.detail]),
    ...(need.points ?? []),
    need.eta,
    ...(need.steps ?? []),
    evidence?.ciNote,
    evidence?.reviewNote,
    evidence?.why,
    ...(evidence?.holding ?? []),
    need.tag,
    need.thread,
    ...(need.links ?? []).map((link) => link.label),
    ...(need.media?.clips ?? []).map((clip) => clip.label),
  ].filter((value): value is string => typeof value === "string");
}

/** Links the card cannot carry whole: the redactor would cut them, so the owner would get a broken one. */
function links(need: Need): string[] {
  const inText = texts(need).flatMap((text) => text.match(URL_IN_TEXT) ?? []).filter((url) => redactText(url) !== url).length;
  const buttons = (need.links ?? []).filter((link) => redactUrl(link.url) !== link.url).length;
  const count = inText + buttons;
  if (!count) return [];
  return [
    `card ${need.id}: ${plural(count, "private link")}, which the card would show cut as https:[redacted]; send ${count === 1 ? "it" : "them"} to the owner in one email to himself, then add an email button (rivet card add … --email-button "<subject>")`,
  ];
}

/**
 * The card rules on the cards a write adds or changes. `cards` are as parsed (redacted), `sentCards` the same cards as
 * the chat sent them, for the links rule, and `storedCards` the board's cards before the write: on a card already
 * stored, a rule runs only when what it judges changed, so new proof on a merge card never re-judges its video. The
 * links rule compares the card as sent with the stored one, so a private link that redacts to the stored link is still
 * judged. A size that cannot be read only ever warns.
 */
export function checkCards({
  cards,
  sentCards,
  storedCards,
  knobs,
  mediaSize,
  videoSizes,
}: {
  cards: readonly Need[];
  sentCards: readonly Need[];
  storedCards: readonly Need[];
  knobs: CardChecker;
  mediaSize: MediaSizeOf;
  videoSizes: readonly string[];
}): CardCheckResult {
  const result: CardCheckResult = { refusals: [], warnings: [] };
  if (!knobs.on) return result;
  const sent = new Map(sentCards.map((need) => [need.id, need]));
  const stored = new Map(storedCards.map((need) => [need.id, need]));
  const add = (mode: "block" | "warn", messages: string[]) => (mode === "block" ? result.refusals : result.warnings).push(...messages);
  for (const need of cards) {
    const was = stored.get(need.id);
    const changed = (judged: (one: Need) => unknown) => !was || canonical(judged(need)) !== canonical(judged(was));
    const unread: string[] = [];
    if (changed((one) => [one.title, one.ask, one.points])) add(knobs.shape, shape(need));
    // Kind decides only whether the options rule applies (a merge card is exempt): a new kind never re-judges stored media.
    if (changed((one) => [one.kind, one.media, one.options])) add(knobs.options, options(need));
    if (changed((one) => [one.media, one.options])) {
      add(knobs.stills, stills(need, mediaSize, unread));
      add(knobs.video, video(need, mediaSize, videoSizes, unread));
    }
    const sentNeed = sent.get(need.id) ?? need;
    if (!was || canonical([texts(sentNeed), sentNeed.links]) !== canonical([texts(was), was.links])) add(knobs.links, links(sentNeed));
    result.warnings.push(...unread);
  }
  return result;
}

const CACHE_MAX = 256;
const MAX_BOXES = 512;
const MAX_JPEG_MARKERS = 512;

/** Reads `length` bytes at `position`; fewer at the end of the file. */
function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const read = readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, read);
}

function pngSize(fd: number): MediaSize | null {
  const head = readAt(fd, 0, 24);
  if (head.length < 24 || head.readUInt32BE(0) !== 0x89504e47 || head.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

function jpegSize(fd: number, size: number): MediaSize | null {
  const start = readAt(fd, 0, 2);
  if (start.length < 2 || start[0] !== 0xff || start[1] !== 0xd8) return null;
  let at = 2;
  for (let step = 0; step < MAX_JPEG_MARKERS && at + 4 <= size; step++) {
    const head = readAt(fd, at, 9);
    if (head[0] !== 0xff) return null;
    const marker = head[1]!;
    // Fill bytes, and markers with no length (RSTn, TEM).
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || head.length < 4) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (head.length < 9) return null;
      return { width: head.readUInt16BE(7), height: head.readUInt16BE(5) };
    }
    at += 2 + head.readUInt16BE(2);
  }
  return null;
}

interface Box {
  type: string;
  body: number;
  end: number;
}

/** The boxes between `start` and `end`; `budget` bounds the walk across a whole file. */
function boxes(fd: number, start: number, end: number, budget: { left: number }): Box[] {
  const found: Box[] = [];
  let at = start;
  while (at + 8 <= end && budget.left-- > 0) {
    const head = readAt(fd, at, 16);
    if (head.length < 8) break;
    let size = head.readUInt32BE(0);
    let body = at + 8;
    if (size === 1) {
      if (head.length < 16) break;
      size = Number(head.readBigUInt64BE(8));
      body = at + 16;
    } else if (size === 0) size = end - at;
    if (size < body - at || at + size > end) break;
    found.push({ type: head.toString("latin1", 4, 8), body, end: at + size });
    at += size;
  }
  return found;
}

function mp4Size(fd: number, size: number): MediaSize | null {
  const budget = { left: MAX_BOXES };
  const child = (box: Box, type: string) => boxes(fd, box.body, box.end, budget).find((one) => one.type === type);
  const moov = boxes(fd, 0, size, budget).find((box) => box.type === "moov");
  if (!moov) return null;
  for (const trak of boxes(fd, moov.body, moov.end, budget).filter((box) => box.type === "trak")) {
    const mdia = child(trak, "mdia");
    const hdlr = mdia && child(mdia, "hdlr");
    if (!hdlr || readAt(fd, hdlr.body + 8, 4).toString("latin1") !== "vide") continue;
    const tkhd = child(trak, "tkhd");
    // A tkhd ends with its 36-byte matrix, then width and height as 16.16 fixed point.
    if (!tkhd || tkhd.end - tkhd.body < 84) return null;
    const tail = readAt(fd, tkhd.end - 44, 44);
    if (tail.length < 44) return null;
    const width = Math.round(tail.readUInt32BE(36) / 65536);
    const height = Math.round(tail.readUInt32BE(40) / 65536);
    // A matrix turning the picture by 90° or 270° shows it the other way up.
    const turned = tail.readInt32BE(0) === 0 && tail.readInt32BE(4) !== 0;
    return width > 0 && height > 0 ? (turned ? { width: height, height: width } : { width, height }) : null;
  }
  return null;
}

/**
 * Reads a stored file's pixel size from its header alone (PNG, JPEG, MP4, told apart by their first bytes, whatever
 * type a card names), synchronously, as the board write that asks runs with no await. Sizes, and files with none, are
 * kept by digest, as a digest's file never changes.
 */
export function mediaSizeReader(dir: string): MediaSizeOf {
  const cache = new Map<string, MediaSize | null>();
  return (sha) => {
    if (cache.has(sha)) return cache.get(sha)!;
    let fd: number;
    try {
      fd = openSync(join(dir, sha), "r");
    } catch {
      return null;
    }
    let size: MediaSize | null = null;
    try {
      const bytes = fstatSync(fd).size;
      const head = readAt(fd, 0, 8);
      if (head.length >= 4 && head.readUInt32BE(0) === 0x89504e47) size = pngSize(fd);
      else if (head.length >= 2 && head[0] === 0xff && head[1] === 0xd8) size = jpegSize(fd, bytes);
      else if (head.toString("latin1", 4, 8) === "ftyp") size = mp4Size(fd, bytes);
    } catch {
      size = null;
    } finally {
      closeSync(fd);
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(sha, size);
    return size;
  };
}
