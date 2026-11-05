import { redactKeepingLines } from "./redact-cut.mjs";
import { redactLine, SECRET_WORDS, shown } from "./redact.mjs";
import { INVISIBLE, LINE_BREAK } from "./templates.mjs";

// Whether the redactor would change a text: the server's rule for what the board token writes (src/server/redact.ts),
// and the one a text document sent to the media store is held to, on the sending CLI and on the server.

/** What a reading of `text` shows, spaces aside: the redactor's own cleaning, with every run of spaces as one. @param {string} text */
export const seen = (text) =>
  text
    .split(LINE_BREAK)
    .map((line) => shown(line).replace(INVISIBLE, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

/** A control character or escape: the redactor drops what an escape sequence wraps, so text with one is never kept as written. */
export const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/**
 * The most a text document sent with the board token may hold: the redactor reads it whole on the server's one thread,
 * and some of its rules take time quadratic in a line (about 2 s for 256 KB of the worst shape).
 */
export const TEXT_DOCUMENT_MAX = 256 * 1024;

/** Whether the redactor would change `text` in anything but spaces. @param {string} text */
export const redactorChanges = (text) => CONTROL.test(text) || seen(redactKeepingLines(text)) !== seen(text);

/** Why a text document is refused: the redactor would change it, and a document is stored only as written. */
export const TEXT_DOCUMENT_REDACTED =
  "That text file holds something the redactor takes out (a key, token, password or escape code). A document is stored only as written, so take that out and send it again.";

/** The longest line the redactor reads (redact-cut.mjs's LINE_MAX): it takes a longer one out whole, unread. */
const LINE_MAX = 4096;
/** At most this many lines are named in a refusal. */
const REPORT_LINES = 5;
const SECRET_NAMED = new RegExp(SECRET_WORDS, "i");
/** The redactor's markers: `[redacted]` or `[redacted github token]`, a name in lower-case words only, so none of a line's own text is read as one. */
const MARKER = /\[redacted((?: [a-z]+)*)\]/g;
/**
 * The names the redactor's own markers carry (redactor/redact.mjs RULES, kept in lockstep by redact-check.test.mjs): a
 * refusal names only these, never a name read from a marker, which a line's own text can spell.
 */
export const RULE_NAMES = new Set(["private key", "github token", "anthropic key", "api key", "aws key", "slack token", "google key", "jwt"]);

/**
 * Where and why the redactor would change `text`, without a character of what it found: each line's number with the
 * rules that fired on it (the redactor's own marker names), at most REPORT_LINES of them. A line is read alone first;
 * what only reads as a secret across lines (a continued command, a private key's body) is named at the first line the
 * whole-text redaction changes. Empty when the redactor leaves `text` alone. @param {string} text
 */
export function redactionReport(text) {
  /** @type {string[]} */
  const found = [];
  const lines = text.split(LINE_BREAK);
  for (let i = 0; i < lines.length && found.length < REPORT_LINES; i++) {
    const line = lines[i];
    /** @type {Set<string>} */
    const rules = new Set();
    if (CONTROL.test(line)) rules.add("a control character or escape");
    const redacted = line.length > LINE_MAX ? null : redactLine(line, undefined, Infinity);
    if (redacted === null) rules.add(`a line over ${LINE_MAX} characters`);
    else if (seen(redacted) !== seen(line)) {
      // A marker the line already held, as written, is its own text: only the ones the redactor added are named.
      const held = [...line.matchAll(MARKER)].map(([marker]) => marker);
      for (const [marker, name] of redacted.matchAll(MARKER)) {
        const at = held.indexOf(marker);
        if (at >= 0) held.splice(at, 1);
        else rules.add(RULE_NAMES.has(name.trim()) ? name.trim() : SECRET_NAMED.test(line) ? "a value named as a secret" : "a secret-shaped value");
      }
      if (!rules.size) rules.add("changed by the redactor");
    }
    if (rules.size) found.push(`line ${i + 1} (${[...rules].join(", ")})`);
  }
  if (!found.length && redactorChanges(text)) {
    const whole = redactKeepingLines(text).split("\n");
    const at = lines.findIndex((line, i) => seen(line) !== seen(whole[i] ?? ""));
    found.push(`line ${Math.max(at, 0) + 1} (a secret read across lines)`);
  }
  return found.join(", ");
}

/** The refusal of a text document the redactor would change, naming its lines and rules, never what was found. @param {string} text */
export const textDocumentRefusal = (text) => `${TEXT_DOCUMENT_REDACTED} Found at ${redactionReport(text)}.`;

/** Why a text document is refused: it is over TEXT_DOCUMENT_MAX. */
export const TEXT_DOCUMENT_TOO_BIG = "A text file sent to a card is at most 256 KB. Cut it down and send it again.";
