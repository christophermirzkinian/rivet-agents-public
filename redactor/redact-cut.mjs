import { redactLines, redactText, SECRET_NAME, shown } from "./redact.mjs";
import { cutAtWord, LINE_BREAK } from "./templates.mjs";

// Text bound for Rivet is redacted whole before anything is cut or withheld: a cut before the redactor can leave a
// token's head it no longer recognises, and a withheld word can take with it what opened a secret (a key block's
// BEGIN, a `--password` flag). Each line is first cleaned with the redactor's own `shown` (escapes and controls) after
// every line break it splits on is made a "\n", so no character it drops can stand as a word's end at a bound.
// Runs of spaces, which cost the redactor time and carry nothing, are kept to 256 units (indents up to that still
// nest), and only SCAN_MAX units are read, ending at a space or line break before the word the bound cuts, with
// all past it shown as one marker. The redactor reads the lines as written, a backslash continuation both as its own
// line and joined to the next, so no bound falls inside a continued line: one that would is shown whole as one marker.
// Then the continuations are joined, a word past 256 units withheld, and the text cut and redacted again.
const LONG_WORD = /\S{257,}/g;
const LONG_SPACE = /[^\S\n]{257,}/g;
const SCAN_MAX = 16384;
const LINE_MAX = 4096;

// A withheld word keeps what gives the text after it its meaning to the redactor: the assignment it opens with (key,
// separator, opening quote), the one it ends on with any collection it opens, and a quote it leaves open, with the
// assignment that opened it. A key is a whole run of key characters, so none of these keeps part of a token. A word
// with a secret's key in it is withheld from that key on, the key and separator kept: the redactor then reads the lines
// after it as that secret's value, whatever collection or element the word had opened.
const HEAD = /^[{[(,]{0,8}["']?[A-Za-z0-9_.$-]{0,128}["']?(?:=>|:=|[=:])["']?/;
const ENDING = /(?<![A-Za-z0-9_.$-])["']?[A-Za-z0-9_.$-]{1,128}["']?(?:=>|:=|[=:])[{[(]{0,8}$/;
const KEY = /(?<![A-Za-z0-9_.$-])["']?([A-Za-z0-9_.$-]+)["']?(?:=>|:=|[=:])/g;
// SECRET_NAME's own word: the redactor reads a key as a secret's when any key run around it holds one. Searched for on
// its own it takes time linear in the key, which can be the whole long word.
const RUN = "[A-Za-z0-9_.-]*";
const SECRET_WORD = new RegExp(SECRET_NAME.startsWith(RUN) && SECRET_NAME.endsWith(RUN) ? SECRET_NAME.slice(RUN.length, -RUN.length) : SECRET_NAME, "i");

/** Where the quote still open at the end of `text` opened, or -1. A backslash escapes outside quotes and inside "…". @param {string} text */
function openQuoteAt(text) {
  let at = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && (at < 0 || text[at] === '"')) i++;
    else if (at >= 0) at = c === text[at] ? -1 : at;
    else if (c === '"' || c === "'") at = i;
  }
  return at;
}

/** A long word withheld, its context kept. @param {string} word */
function withheld(word) {
  for (const key of word.matchAll(KEY)) {
    const name = SECRET_WORD.exec(key[1]);
    if (!name) continue;
    const before = word.slice(0, key.index);
    // A key past 128 units keeps only the secret's word in it, so what the redactor reads next stays short.
    const kept = key[1].length > 128 ? key[0].replace(key[1], () => `[redacted]${name[0]}`) : key[0];
    return `${before.length > 256 ? withheld(before) : before}${kept}[redacted]`;
  }
  const head = HEAD.exec(word)?.[0] ?? "";
  const open = openQuoteAt(word);
  if (open >= 0 && open < head.length) return `${head}[redacted]`;
  const headOpen = openQuoteAt(head);
  const out = head ? `${head}[redacted]${headOpen < 0 ? "" : head[headOpen]}` : "[redacted]";
  if (open >= 0) return `${out}${ENDING.exec(word.slice(0, open))?.[0] ?? ""}${word[open]}[redacted]`;
  return out + (ENDING.exec(word)?.[0] ?? "");
}

/** Each line of `text` as the redactor shows it. @param {unknown} text */
const cleaned = (text) => String(text).split(LINE_BREAK).map(shown);

/** The first and last of `lines` in the continued line that holds line `n`, and whether it is continued. @param {string[]} lines @param {number} n */
function around(lines, n) {
  let from = n;
  while (from > 0 && lines[from - 1].endsWith("\\")) from--;
  let to = n;
  while (to < lines.length - 1 && lines[to].endsWith("\\")) to++;
  return { from, to, continued: from < to || lines[to].endsWith("\\") };
}

/** The lines cleaned and continuations joined; a dangling one is dropped, as the redactor withholds it. @param {unknown} text */
function logical(text) {
  /** @type {string[]} */
  const out = [];
  let carry = "";
  for (const line of cleaned(text)) {
    const whole = carry + line;
    const continued = whole.endsWith("\\");
    carry = continued ? whole.slice(0, -1) : "";
    if (!continued) out.push(whole);
  }
  return out;
}
/**
 * The first SCAN_MAX units of `text`, ending before the word the bound cuts, and one marker for the rest; a continued
 * line the bound cuts goes whole into the marker.
 * @param {string} text
 */
function bounded(text) {
  if (text.length <= SCAN_MAX) return text;
  const lines = text.split("\n");
  let n = 0;
  let used = 0;
  while (used + lines[n].length <= SCAN_MAX) used += lines[n++].length + 1;
  const { from, continued } = around(lines, n);
  if (continued) return [...lines.slice(0, from), "[redacted]"].join("\n");
  return [...lines.slice(0, n), `${lines[n].slice(0, Math.max(0, SCAN_MAX - used)).replace(/[^ ]*$/, "")}[redacted]`].join("\n");
}

/** @param {unknown} raw @param {number} limit @param {string} fold */
function shapeOnce(raw, limit, fold) {
  const whole = redactText(bounded(cleaned(raw).join("\n").replace(LONG_SPACE, (run) => run.slice(0, 256))), Infinity);
  const read = logical(whole).join("\n").replace(LONG_WORD, withheld).replace(LONG_SPACE, (run) => run.slice(0, 256));
  const redacted = redactText(bounded(read), Infinity);
  if (fold === "\n") return cutAtWord(redacted, limit);
  return cutAtWord(redacted.split("\n").map((line) => line.trim()).filter(Boolean).join(fold), limit).trim();
}

/**
 * `raw` as it may leave for Rivet: cleaned, redacted whole, its line breaks folded to `fold` (blank lines dropped),
 * then cut at a word to `limit` UTF-16 units. Callers pass raw text: no cut of theirs runs before this one. Folded
 * lines read as one, so a secret's value can swallow the markers after it: the result is read again until a reading
 * changes nothing, and shaping it again gives it back.
 * @param {unknown} raw @param {number} limit @param {string} [fold]
 */
export function shapeText(raw, limit, fold = " / ") {
  let said = shapeOnce(raw, limit, fold);
  for (let n = 0; n < 4; n++) {
    const again = shapeOnce(said, limit, fold);
    if (again === said) break;
    said = again;
  }
  return said;
}

/**
 * `text` redacted whole with its lines kept, for a reader that takes one line out (a hold line, a deploy's reason): a
 * line taken out first loses what marks a secret around it (a block's header, a continued line). Shape the line taken
 * before showing it. Lines are read up to LINE_MAX units, as some of the redactor's rules take time quadratic in a
 * line: one past it, with every piece of a continued line it is in, shows as `[redacted]`, and the lines after it too.
 * @param {unknown} text
 */
export const redactKeepingLines = (text) => redactLines(capped(text, LINE_MAX, () => "[redacted]"), { inKey: false }, undefined, { rest: true, max: Infinity }).join("\n");

/** The start of `text`, redacted whole, then cut to `max` units at a word with its lines kept. @param {unknown} text @param {number} max */
export const redactHead = (text, max) => shapeText(text, max, "\n");

/**
 * A sink's backstop: every string in `value`, at any depth of plain objects and arrays, as `shapeText` shows it, cut at
 * a word to its own length so a field the sender bounded stays in bound; a string shaping leaves as it is (ids, SHAs,
 * URLs, times) passes unchanged, and a second pass changes nothing. A string under one of `fit`'s keys is a field the
 * sender has checked against a pattern, which a marker would break: one shaping would change becomes that key's
 * placeholder, or with none (a public identifier, such as a GitHub login) passes as it is.
 * @template T @param {T} value @param {ReadonlyMap<string, string | null>} [fit] @returns {T}
 */
export function redactDeep(value, fit = new Map()) {
  if (typeof value === "string") {
    const said = shapeText(value, Infinity);
    return /** @type {T} */ (said === value ? value : cutAtWord(said, value.length).trimEnd());
  }
  if (Array.isArray(value)) return /** @type {T} */ (value.map((v) => redactDeep(v, fit)));
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return /** @type {T} */ (Object.fromEntries(Object.entries(value).map(([key, v]) => [key, fit.has(key) && typeof v === "string" ? fitted(v, fit.get(key) ?? null) : redactDeep(v, fit)])));
  return value;
}

/** @param {string} value @param {string | null} placeholder */
function fitted(value, placeholder) {
  return placeholder === null || shapeText(value, Infinity) === value ? value : placeholder;
}

/**
 * The end of `text`: all of it, each line cut to `lineMax` characters at a word, redacted in order with its lines kept,
 * so a secret block's header stays in view of its values however long the text; then the last TAIL_MAX units of the
 * redacted lines. What a cut line dropped may have opened a secret's value (a header, a quote), so every line after the
 * first cut one is shown only as `[redacted]`, as the redactor holds a log past what it can read. The lines go to the
 * redactor as written: it reads a continued line both on its own and joined to the next, so a continued line with a line
 * past `lineMax` in it is shown whole as one `[redacted]`. Lines are read one at a time, never the text flattened, as
 * some rules take time quadratic in what they read.
 * @param {unknown} text @param {number} lineMax
 */
export const redactEachLine = (text, lineMax) =>
  tailOf(redactLines(capped(text, lineMax, (line) => cutRaw(line, lineMax)), { inKey: false }, undefined, { rest: true, max: Infinity })).join("\n");

/** `line` cut to `max` units at a word, nothing taken out: it goes to the redactor next (`x\u00adBearer`). @param {string} line @param {number} max */
const cutRaw = (line, max) => (line.length > max ? line.slice(0, max).replace(/\S*$/, "") : line);

const TAIL_MAX = 65536;

/** The last whole lines of `lines` within TAIL_MAX units. @param {string[]} lines */
function tailOf(lines) {
  let from = lines.length;
  for (let used = 0; from > 0 && used + lines[from - 1].length + 1 <= TAIL_MAX; ) used += lines[--from].length + 1;
  return lines.slice(from);
}

/**
 * The cleaned lines of `text` with the first past `lineMax` units as `cut` gives it, or one `[redacted]` for the
 * continued line it is in, and every line after it `[redacted]`.
 * @param {unknown} text @param {number} lineMax @param {(line: string) => string} cut
 */
function capped(text, lineMax, cut) {
  const lines = cleaned(text);
  const at = lines.findIndex((line) => line.length > lineMax);
  if (at < 0) return lines;
  const { from, to, continued } = around(lines, at);
  const held = lines.slice(to + 1).map((line) => (line.trim() ? "[redacted]" : ""));
  return continued ? [...lines.slice(0, from), "[redacted]", ...held] : [...lines.slice(0, at), cut(lines[at]), ...held];
}
