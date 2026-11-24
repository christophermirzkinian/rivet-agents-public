import os from "node:os";
import { redactKeepingLines } from "./redact-cut.mjs";
import { redactLine, SECRET_WORDS, shortenHome, shown } from "./redact.mjs";
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
export const redactionReport = (text) =>
  redactionFindings(text)
    .map(({ line, rules }) => `line ${line} (${rules.join(", ")})`)
    .join(", ");

/** A long token-shaped value (a sha256, an MD5, a run id): the redactor's guess, which the board shows as `[redacted]` in place. */
const GUESS = "a secret-shaped value";
const CHANGED = "changed by the redactor";
const ACROSS_LINES = "a secret read across lines";
const WHOLE_LINE = "the whole line would be hidden";

/**
 * redactionReport's findings, at most `max` lines of them: each line's number (from 1), the rules that fired on it, and
 * whether the redactor hides the whole line although it holds more than one word (`blanked`).
 * @param {string} text @param {number} [max] @returns {{ line: number, rules: string[], blanked: boolean }[]}
 */
export function redactionFindings(text, max = REPORT_LINES) {
  /** @type {{ line: number, rules: string[], blanked: boolean }[]} */
  const found = [];
  const lines = text.split(LINE_BREAK);
  for (let i = 0; i < lines.length && found.length < max; i++) {
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
        else rules.add(RULE_NAMES.has(name.trim()) ? name.trim() : SECRET_NAMED.test(line) ? "a value named as a secret" : GUESS);
      }
      if (!rules.size) rules.add(CHANGED);
    }
    // Hidden whole: more than one word gone, or one word that holds a look-alike form (a title of `Acme™`).
    const blanked = redacted !== null && seen(redacted) === "[redacted]" && (/\s/.test(seen(line)) || line.normalize("NFKC") !== line);
    if (rules.size) found.push({ line: i + 1, rules: [...rules], blanked });
  }
  if (!found.length && redactorChanges(text)) {
    const whole = redactKeepingLines(text).split("\n");
    const at = lines.findIndex((line, i) => seen(line) !== seen(whole[i] ?? ""));
    found.push({ line: Math.max(at, 0) + 1, rules: [ACROSS_LINES], blanked: false });
  }
  return found;
}

/** The run the redactor's long-token guess reads (redactor/redact.mjs `scrub`). */
const LONG_RUN = /[A-Za-z0-9+/_.@-]{16,}={0,2}/g;
/** A plain word that guess never takes, which every rule that reads a value by its place (after `Bearer`, behind `-p`) still takes out. */
const STAND_IN = "placeholder";
/**
 * `line` as read, with that plain word for each long run the redactor took out whole, or null when the redactor
 * changed anything else: part of a run (a URL's password, a value stuck to its flag), or text that is no long run (a
 * short password after a command). Every other word is kept, so a rule that reads a value by its place still fires.
 * @param {string} line @returns {string | null}
 */
const withoutLongIds = (line) => {
  const written = seen(line);
  const redacted = seen(redactLine(line, undefined, Infinity));
  let out = "";
  let at = 0;
  let to = 0;
  let swapped = false;
  for (const run of written.matchAll(LONG_RUN)) {
    const between = written.slice(at, run.index);
    if (!redacted.startsWith(between, to)) return null;
    to += between.length;
    at = run.index + run[0].length;
    if (redacted.startsWith("[redacted]", to)) {
      out += `${between}${STAND_IN}`;
      to += "[redacted]".length;
      swapped = true;
    } else if (redacted.startsWith(run[0], to)) {
      out += between + run[0];
      to += run[0].length;
    } else return null;
  }
  if (redacted.slice(to) !== written.slice(at)) return null;
  return swapped ? out + written.slice(at) : null;
};
/**
 * Whether the redactor changes `line` only for what its long runs spell: it took out whole long runs and nothing
 * else, and with a plain word in each one's place it leaves the line alone. A password in a URL, after `Bearer` or
 * behind a flag is taken out whatever it spells, so it is no guess.
 * @param {string} line
 */
const onlyLongIds = (line) => {
  const short = withoutLongIds(line);
  return short !== null && seen(redactLine(short, undefined, Infinity)) === short;
};

/**
 * The refusal for the human-text `fields` (label, text) of a message or card the redactor would change, or null when it
 * would change none, and a note for each field with a guess, which is sent all the same. Both name the field, the line
 * and the rule, never a character of the text. A home folder, which the board shows as ~, is no change.
 * @param {[string, unknown][]} fields @param {string} [home] @returns {{ refusal: string | null, notes: string[] }}
 */
export function sendRefusal(fields, home = os.homedir()) {
  const refused = [];
  const notes = [];
  for (const [label, value] of fields) {
    if (typeof value !== "string" || !value) continue;
    const text = shortenHome(home && home !== "/" ? value.split(home).join("~") : value);
    const lines = text.split(LINE_BREAK);
    const findings = redactionFindings(text, Infinity);
    const guessed = findings.filter(({ line, rules, blanked }) => !blanked && rules.length === 1 && rules[0] === GUESS && onlyLongIds(lines[line - 1] ?? ""));
    const bad = findings.filter((finding) => !guessed.includes(finding));
    if (guessed.length && !bad.length) {
      // A line's own guess keeps the whole-text reading from being asked: a secret read across lines is still one, on a
      // guessed line too (a long id under `password:`), so the whole text is read with the guessed ids as plain words.
      const plain = lines.map((line, i) => (guessed.some((finding) => finding.line === i + 1) ? (withoutLongIds(line) ?? line) : line));
      const whole = redactKeepingLines(plain.join("\n")).split("\n");
      const at = plain.findIndex((line, i) => seen(line) !== seen(whole[i] ?? ""));
      if (at >= 0) bad.push({ line: at + 1, rules: [ACROSS_LINES], blanked: false });
    }
    if (bad.length) {
      const named = bad.slice(0, REPORT_LINES).map(({ line, rules, blanked }) => {
        const written = lines[line - 1] ?? "";
        const hidden = written.normalize("NFKC") !== written ? `${WHOLE_LINE}: a look-alike form such as ™ or ² does that, write TM or 2` : WHOLE_LINE;
        const said = blanked ? [...new Set(rules.map((rule) => (rule === GUESS || rule === CHANGED ? hidden : rule)))] : rules;
        return `line ${line} (${said.join(", ")})`;
      });
      refused.push(`${label}: ${named.join(", ")}`);
    }
    if (guessed.length) notes.push(`${label}: ${guessed.map(({ line }) => `line ${line}`).join(", ")} ${guessed.length > 1 ? "hold" : "holds"} a long token-shaped value; the board shows [redacted] in its place`);
  }
  const refusal = refused.length
    ? `refused, nothing was sent: the redactor would take this out (a key, token, password, escape code or hidden line), and the board would show [redacted] there. Take it out and send it again:\n  ${refused.join("\n  ")}`
    : null;
  return { refusal, notes };
}

/** The refusal of a text document the redactor would change, naming its lines and rules, never what was found. @param {string} text */
export const textDocumentRefusal = (text) => `${TEXT_DOCUMENT_REDACTED} Found at ${redactionReport(text)}.`;

/** Why a text document is refused: it is over TEXT_DOCUMENT_MAX. */
export const TEXT_DOCUMENT_TOO_BIG = "A text file sent to a card is at most 256 KB. Cut it down and send it again.";
