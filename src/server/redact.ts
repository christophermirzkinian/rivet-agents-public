import type { z } from "zod";

import { type FeedEntry, logFeed } from "../shared/log-feed.js";
import { screenView, type ScreenItem } from "../shared/screen-view.js";

// @ts-expect-error the bridge is plain ESM without type declarations
import { NAMED_SHAPES as bridgeShapes, redactCutTop as bridgeCutTop } from "../../bridge/lib/redact.mjs";
// @ts-expect-error the bridge is plain ESM without type declarations
import { redactKeepingLines as bridgeRedact } from "../../bridge/lib/redact-cut.mjs";
// @ts-expect-error the bridge is plain ESM without type declarations
import { cutAtWord as bridgeCut } from "../../bridge/lib/templates.mjs";
// @ts-expect-error the bridge is plain ESM without type declarations
import * as bridgeCheck from "../../bridge/lib/redact-check.mjs";

const NAMED_SHAPES = bridgeShapes as RegExp[];
const redactKeepingLines = bridgeRedact as (text: string) => string;
const redactCutTop = bridgeCutTop as (lines: string[], home: string | undefined, options: object, from: number) => string[];
const cutAtWord = bridgeCut as (text: string, max: number) => string;
/** What a reading of `text` shows, spaces aside: the redactor's own cleaning, with every run of spaces as one. */
const seen = bridgeCheck.seen as (text: string) => string;
/** A control character or escape: the redactor drops what an escape sequence wraps, so text with one is never kept as written. */
const CONTROL = bridgeCheck.CONTROL as RegExp;
/** Whether the redactor would change `text` in anything but spaces: a text document it would change is refused. */
export const redactorChanges = bridgeCheck.redactorChanges as (text: string) => boolean;
export const TEXT_DOCUMENT_MAX = bridgeCheck.TEXT_DOCUMENT_MAX as number;
/** The refusal of a text document the redactor would change: its lines and the rules that fired, never what was found. */
export const textDocumentRefusal = bridgeCheck.textDocumentRefusal as (text: string) => string;
export const TEXT_DOCUMENT_TOO_BIG = bridgeCheck.TEXT_DOCUMENT_TOO_BIG as string;

// Text the board-token CLIs write (cards, say, team lines, comments) is redacted here, at ingest, with the bridge's own
// redactor, so the stored copy, the phone and its pushes are clean whichever CLI wrote it. The redactor drops a
// line's indent and its tabs, so a string it would change only in spaces, controls or invisible characters is kept as it
// was written; one it changes in anything else is stored redacted, cut at a word to its own length so a field the
// schema bounds stays in bound.

// A board write carries the whole board back each time: most of its strings were read on the last write. Only a string
// the redactor leaves alone is remembered, so no secret is kept past its request, and only a short one, so the memo holds
// at most MEMO_MAX × MEMO_TEXT_MAX characters however many large boards are written.
const MEMO_MAX = 4000;
const MEMO_TEXT_MAX = 2048;
const memo = new Set<string>();

/** `text` as Rivet may store it: unchanged unless the redactor finds something in it. */
export function redactText(text: string): string {
  if (memo.has(text)) return text;
  const redacted = redactKeepingLines(text);
  if (CONTROL.test(text) || seen(redacted) !== seen(text)) return cutAtWord(redacted, text.length).trimEnd();
  if (text.length <= MEMO_TEXT_MAX) {
    if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value!);
    memo.add(text);
  }
  return text;
}

/**
 * A one-word id (a tool call's, a client's) as Rivet may store it: the redactor guesses a long opaque word is a token,
 * but an id is one by design and its field's pattern bounds it, so only a credential the redactor knows by shape is
 * taken out, which then fails that pattern.
 */
export function redactId(value: string): string {
  // Longer than any id or host is refused unread: a shape's pattern rescans the rest of the value from each place it
  // could start, so a long one would hold the server.
  if (value.length > ID_MAX) return "[redacted]";
  // A known shape is read after any joining character, so one behind a prefix (`x_ghp_…`, `X_AKIA…`) is found as well,
  // even when the prefix keeps the whole word clean to the redactor, and however long the value is.
  if (NAMED_SHAPES.some((shape) => shape.test(value))) return "[redacted]";
  return OPAQUE.test(value) ? value : redactText(value);
}

/** Longer than any id field holds and any host (253): past it, an id or link part is never read. */
const ID_MAX = 256;
/** One word of id characters, as long as an id field holds: the only shape `redactId` keeps when the redactor guesses. */
const OPAQUE = /^[A-Za-z0-9._-]{1,128}$/;

/** A field name that says its value is a secret (`apiKey`, `PGPASSWORD`, `credentials`); `auth` and `author` are not. */
const SECRET_KEY = /passw(?:or)?d|passphrase|secret|token|credential|cookie|dsn|api_?key|access_?key|private_?key|signing_?key/;
const isSecretKey = (name: string) => SECRET_KEY.test(name.toLowerCase());

/** A media file's name in the store: its content's digest, which the redactor reads as a key (64 hex characters). */
const DIGEST = /^[0-9a-f]{64}$/;
/** Where in a body a digest names a media file the route checks is in the store; the path leaves out array steps. */
export type MediaAt = (path: readonly string[]) => boolean;
const NO_MEDIA: MediaAt = () => false;
/** A board's: the `sha256` of each file in a card's `media`, which writeBoard finds in the store. */
export const BOARD_MEDIA: MediaAt = (path) => path[0] === "needs" && path[1] === "media" && path.at(-1) === "sha256";
/** Say's: its photos and its video. */
export const SAY_MEDIA: MediaAt = (path) => path.length === 1 && (path[0] === "images" || path[0] === "video");
/**
 * Where in a body a string is a name another system gives by design, which the redactor can read as a token, and the
 * redactor that reads it instead of `redactText`.
 */
export type FieldAt = (path: readonly string[]) => ((value: string) => string) | undefined;
const NO_FIELDS: FieldAt = () => undefined;
/**
 * A log's lines as Rivet may store them: read as one run, as the bridge reads a log (bridge/lib/actions/logs.mjs), so a
 * secret's name on one line hides its value on the lines below (`password: |`), a name the terminal wrapped across two
 * rows too, and cut to `max` lines. A word beside a marker the bridge wrote can go as well. Run on the
 * lines as sent, before `parseRedacted`, which reads each line alone and would take the name away first. Each upload is
 * read on its own: a value whose name came in an earlier upload is left to the sender's redactor, which reads the log whole.
 */
/** Fly's: the image of each app's release, a registry name and its tag (`redactImage`). */
export const FLY_FIELDS: FieldAt = (path) => (path.at(-1) === "image" ? redactImage : undefined);
/** GitHub's: the login of a pull request's author, one word like an id (`redactId`), which can look like a key (32 hex). */
export const GITHUB_FIELDS: FieldAt = (path) => (path.at(-1) === "author" ? redactId : undefined);

/**
 * An image reference: a registry host and path, a tag, and a content digest. The tag flyctl gives (`deployment-<ulid>`)
 * and the digest (64 hex) are names by design, which the redactor reads as tokens; nothing else in one is read so.
 */
const IMAGE_REF = /^([a-z0-9.-]{1,253}(?::\d{1,5})?(?:\/[a-z0-9._-]{1,128}){1,4})(?::([A-Za-z0-9_.-]{1,128}))?(@sha256:[0-9a-f]{64})?$/i;
const FLYCTL_TAG = /^deployment-[0-9A-HJKMNP-TV-Z]{26}$/i;

/**
 * A release's image as Rivet may store it: refused (`[redacted]`, which fails its field's pattern) when it is not an
 * image reference (a user name and password, a scheme) or holds a credential the redactor knows by shape; otherwise
 * flyctl's tag and the digest are kept as sent and the rest is read as text.
 */
export function redactImage(value: string): string {
  if (value.length > ID_MAX || NAMED_SHAPES.some((shape) => shape.test(value))) return "[redacted]";
  const ref = IMAGE_REF.exec(value);
  if (!ref) return "[redacted]";
  const [, name, tag, digest = ""] = ref;
  const named = tag === undefined ? redactText(name!) : FLYCTL_TAG.test(tag) ? `${redactText(name!)}:${tag}` : redactText(`${name}:${tag}`);
  return `${named}${digest}`;
}

export function redactLog(lines: string[], max: number): string[] {
  return lines.length ? redactCutTop(lines, undefined, {}, 0).slice(0, max) : lines;
}

/** The texts as one line, each run of spaces and line breaks as one space, and a colour code without its escape (`[31m`) as a space. */
const flat = (texts: string[]) => texts.join(" ").replace(/\[(?:\d{1,3};)*\d{1,3}m/g, " ").replace(/\s+/g, " ").trim();

/** One shown line read by the redactor again, as the reader sees it: a colour code without its escape splits no word. */
function redactLine(line: string): string {
  const plain = flat([line]);
  return redactText(plain) === plain ? redactText(line) : redactText(plain);
}

/**
 * What a reader reads past, blanked at its own length so every other character keeps its place: a colour code without its
 * escape, the screen's expand hint, a rule line, and a mark at a line's start (an item's `⏺`, a result's `⎿`, a list's
 * `•`, `-` or `1.`).
 */
const NOISE = /\[(?:\d{1,3};)*\d{1,3}m|\(ctrl\+o to expand\)|^[\s─━═│┃╭╮╰╯]+$|^[ \t]*(?:[⏺●•⎿└›*·–-]|\d{1,3}[.)])(?=\s)/gm;
/**
 * How much shown text the redactor reads at once, under its 4,096-character line, and how far at most each window starts
 * past the last: any whole up to WINDOW - STEP characters lies inside one window. A window starts at a word the word
 * itself picks, or STEP past the last start where none does, so as a screen moves on the same windows come round again,
 * and each window's reading is kept: a poll reads only the windows the new lines touch.
 */
const WINDOW = 4000;
const STEP = 1000;
const ACROSS_MEMO = 32;
const acrossMemo = new Map<string, string[]>();
const WINDOW_MEMO = 512;
const windowMemo = new Map<string, number[]>();

/** A word's own pick as a window's start: about one word in 128, some 800 characters apart. */
function picked(word: string): boolean {
  let hash = 2166136261;
  for (let at = 0; at < word.length; at++) hash = Math.imul(hash ^ word.charCodeAt(at), 16777619);
  return (hash >>> 0) % 128 === 0;
}

/** The places in a window the redactor takes out, read once for each window. */
function readWindow(piece: string[]): number[] {
  const line = piece.join(" ");
  const known = windowMemo.get(line);
  if (known) return known;
  const read = redactKeepingLines(line);
  const out = read === line ? [] : dropped(piece, read.split(/\s+/).filter(Boolean));
  if (windowMemo.size >= WINDOW_MEMO) windowMemo.delete(windowMemo.keys().next().value!);
  windowMemo.set(line, out);
  return out;
}

/**
 * The places in `a` that `b` does not keep, by the longest run the two have in common, in order. On a tie a word of `a`
 * counts as taken out where it stands, so a repeated value is taken out at its first place, as the redactor does.
 */
function dropped(whole: string[], kept: string[]): number[] {
  // The redactor changes a few words in place: what it keeps at either end is matched as it stands, and only the rest by LCS.
  let head = 0;
  while (head < whole.length && head < kept.length && whole[head] === kept[head]) head++;
  let tail = 0;
  while (tail < whole.length - head && tail < kept.length - head && whole[whole.length - 1 - tail] === kept[kept.length - 1 - tail]) tail++;
  const a = whole.slice(head, whole.length - tail);
  const b = kept.slice(head, kept.length - tail);
  const width = b.length + 1;
  const best = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      best[i * width + j] = a[i] === b[j] ? best[(i + 1) * width + j + 1]! + 1 : Math.max(best[(i + 1) * width + j]!, best[i * width + j + 1]!);
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length) {
    if (j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (j < b.length && best[i * width + j + 1]! > best[(i + 1) * width + j]!) j++;
    else out.push(head + i++);
  }
  return out;
}

/**
 * Shown texts, in the order a reader reads them, each line read by the redactor again, and then all of it read in
 * overlapping windows as one line, so a word the redactor takes out in its context goes wherever it shows. The Mac masks
 * a screen a line at a time, and the redactor reads a text a line at a time, so a scheme or a command at one line and
 * its secret further on (`Basic`, then `dGVzdDph`; `mysql`, `--host x`, `-p hunter2`) was never a whole to either: across
 * a wrap, a blank line, rows of a result, two items, or a tool's label and its call.
 */
/** One stored text read whole by the redactor (redactAcross): a scheme on one line and its secret on the next go too. */
export function redactBlock(text: string): string {
  return redactAcross([text])[0]!;
}

function redactAcross(texts: string[]): string[] {
  // The count leads the key: [] and [""] join to the same text and must not share an answer.
  const key = `${texts.length}\u0001${texts.join("\u0000")}`;
  const known = acrossMemo.get(key);
  if (known) return known;
  const shown = texts.map((text) => text.split("\n").map(redactLine).join("\n"));
  const words: { text: number; line: number; at: number; end: number; word: string }[] = [];
  let lines = 0;
  shown.forEach((text, at) => {
    const plain = text.replace(NOISE, (noise) => " ".repeat(noise.length));
    for (const match of plain.matchAll(/\S+|\n/g)) {
      if (match[0] === "\n") lines++;
      else words.push({ text: at, line: lines, at: match.index, end: match.index + match[0].length, word: match[0] });
    }
    lines++;
  });
  const start: number[] = [0];
  for (const one of words) start.push(start.at(-1)! + one.word.length + 1);
  const gone = new Set<number>();
  for (let from = 0; from < words.length; ) {
    let to = from + 1;
    while (to < words.length && start[to + 1]! - start[from]! - 1 <= WINDOW) to++;
    const piece = words.slice(from, to).map((one) => one.word);
    const taken = readWindow(piece);
    if (taken.length) {
      // Every word taken out goes, a value over many rows too. The redactor reads a `key: value` value to its line's end,
      // and here the line runs on to the window's end, so a key at a row's end takes the rows after it: masked too much,
      // never too little.
      for (const at of taken) gone.add(from + at);
      // A value taken out on its own goes wherever it shows again in the window: said twice, it is a secret twice.
      for (const at of taken)
        if (!taken.includes(at - 1) && !taken.includes(at + 1)) piece.forEach((word, one) => word === piece[at] && gone.add(from + one));
    }
    if (to >= words.length) break;
    let next = from + 1;
    while (next < to && start[next]! - start[from]! < STEP && !picked(words[next]!.word)) next++;
    from = next;
  }
  const out = shown.slice();
  for (const at of [...gone].sort((a, b) => b - a)) {
    const one = words[at]!;
    out[one.text] = `${out[one.text]!.slice(0, one.at)}[redacted]${out[one.text]!.slice(one.end)}`;
  }
  if (acrossMemo.size >= ACROSS_MEMO) acrossMemo.delete(acrossMemo.keys().next().value!);
  acrossMemo.set(key, out);
  return out;
}

/**
 * Masked lines as the worker sheet's feed, read by the redactor across the screen (see redactAcross) twice: in the
 * screen's own order before the feed sorts its entries by time, and as the feed shows them.
 */
export function redactFeed(lines: string[], times: (string | null)[]): FeedEntry[] {
  const feed = logFeed(redactAcross(lines), times);
  const shown = redactAcross(feed.flatMap((entry) => (entry.who === undefined ? [entry.text] : [entry.who, entry.text])));
  let at = 0;
  return feed
    .map((entry) => (entry.who === undefined ? { ...entry, text: shown[at++]! } : { ...entry, who: shown[at++]!, text: shown[at++]! }))
    .filter((entry) => entry.text.trim());
}

/**
 * Masked lines set out to read on a phone, for the map's chat sheet. screenView joins the lines the terminal wrapped and
 * sets items side by side, so everything it shows, labels too, is read by the redactor again across the screen
 * (redactAcross), in the order the sheet shows it: a whole the per-line masking never saw goes as it would on one line.
 */
export function redactScreen(lines: string[]): ScreenItem[] {
  const items = screenView(lines);
  const shown = redactAcross(
    items.flatMap((item) => (item.kind === "tool" ? [item.name, item.detail, ...item.result.map((line) => line.text)] : item.kind === "message" ? [item.who, item.text] : [item.text])),
  );
  let at = 0;
  return items.flatMap((item): ScreenItem[] => {
    if (item.kind === "tool") {
      const name = shown[at++]!;
      const detail = shown[at++]!;
      const result = item.result.map((line) => ({ ...line, text: shown[at++]! })).filter((line) => line.text.trim());
      return [{ ...item, name, detail, result }];
    }
    if (item.kind === "message") {
      const who = shown[at++]!;
      const text = shown[at++]!;
      return text.trim() ? [{ ...item, who, text }] : [];
    }
    const text = shown[at++]!;
    return text.trim() ? [{ ...item, text }] : [];
  });
}

/**
 * A link's address: what a link opens is meant to be opened, so a path the redactor reads as a token (a shared file's
 * id) is kept, while a user name or password goes, and its query and fragment go whole when the redactor finds anything
 * in them. One that is not a URL is redacted as text, and fails the schema's URL check.
 */
export function redactUrl(value: string): string {
  if (!URL.canParse(value)) return redactText(value);
  const url = new URL(value);
  url.username = "";
  url.password = "";
  // A host the redactor finds anything in is refused; a path keeps a part it guesses is a token only when that part is
  // one opaque word, a shared file's id, and otherwise goes whole.
  // The host is read as written too, since `URL` lowercases it and a credential's shape can be in its case (`AIza…`).
  const host = writtenHost(value);
  const plainHost = decoded(host);
  // Whole as well as by label, so a shape that holds dots (a JWT) is read too.
  if (plainHost === null || ![url.hostname, host, plainHost].every((one) => clean(one) && one.split(".").every(clean))) return "[redacted]";
  const path = decoded(url.pathname);
  if (path === null || !path.split("/").every(clean)) url.pathname = "/";
  // Each parameter on its own line, as written and decoded, so `?%70assword=…` reads as the password it is.
  const tail = `${url.search}${url.hash}`.replace(/[?&#;]/g, "\n");
  const plain = decoded(tail);
  if (plain === null || redactText(tail) !== tail || redactText(plain) !== plain) {
    url.search = "";
    url.hash = "";
  }
  return url.href === new URL(value).href ? value : url.href;
}

/** One part of an address with no credential in it: no known shape, and an opaque word or text the redactor finds nothing in. */
const clean = (part: string) => redactId(part) === part;

/** A URL's host as written: after the scheme, short of any user name and port, read as `URL` reads it (no tabs or line breaks, nothing before the scheme). */
function writtenHost(value: string): string {
  const input = value.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+/, "");
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:[\\/]*([^\\/?#]*)/.exec(input)?.[1] ?? "";
  return authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d*$/, "");
}

/** `text` percent-decoded and with `+` as a space, as a server reads a query; null when it does not decode. */
function decoded(text: string): string | null {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

/**
 * Every string in `value`, at any depth of arrays and plain objects, as `redactText` gives it; an entry whose key the
 * redactor would change is dropped, and a string under a key that names a secret (`password`, `apiKey`) is redacted
 * whole, as is every string inside one. A `url` is a link's address (`redactUrl`), an `id` or `…Id` is one word
 * (`redactId`), and a digest where `media` says it names a media file is kept: the schema reads each, and the route checks the file is in the store. A
 * string where `fields` names its own redactor is read with that one. Run on a body
 * before its schema, so an id-like field that held a secret fails the schema's pattern rather than being stored.
 */
export function redactBody<T>(value: T, media: MediaAt = NO_MEDIA, fields: FieldAt = NO_FIELDS): T {
  return walk(value, [], media, fields);
}

function walk<T>(value: T, path: readonly string[], media: MediaAt, fields: FieldAt): T {
  const key = path.at(-1);
  if (typeof value === "string") {
    if (key === undefined) return redactText(value) as T;
    if (path.some(isSecretKey)) return (value ? "[redacted]" : value) as T;
    if (key === "url") return redactUrl(value) as T;
    if (key === "id" || key.endsWith("Id")) return redactId(value) as T;
    if (media(path) && DIGEST.test(value)) return value;
    return (fields(path) ?? redactText)(value) as T;
  }
  if (Array.isArray(value)) return value.map((one) => walk(one, path, media, fields)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    // Under a key that names a secret, the entries' names can be the secret (`tokens: {<token>: "read"}`): no schema has
    // such a field, so the object goes whole.
    if (path.some(isSecretKey)) return (Object.keys(value).length ? "[redacted]" : value) as T;
    return Object.fromEntries(Object.entries(value).flatMap(([name, one]) => (redactText(name) === name ? [[name, walk(one, [...path, name], media, fields)]] : []))) as T;
  }
  return value;
}

/**
 * `raw` checked against `schema` as sent, then redacted (`redactBody`) and checked again: a field over its bound is
 * refused even when its redacted copy would fit, and one the redactor changes past its pattern is refused too.
 */
export function parseRedacted<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
  media: MediaAt = NO_MEDIA,
  fields: FieldAt = NO_FIELDS,
): z.SafeParseReturnType<unknown, z.output<S>> {
  const sent = schema.safeParse(raw);
  return sent.success ? schema.safeParse(redactBody(sent.data, media, fields)) : sent;
}
