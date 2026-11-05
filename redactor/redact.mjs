import { homedir } from "node:os";

import { boundaried, clipUnits, ESC_SEQ, padded, plain, readings as textReadings, sanitizeLine, shownAs, readsTwoWays, unfolded } from "./templates.mjs";

// Terminal output leaves the Mac only through the worker sheet's live log, and
// only after this: escape sequences stripped, secrets replaced, and home-folder
// paths shortened to ~/…. Tested against bridge/test/redaction-corpus.mjs.

export const MAX_LOG_LINE = 500;

export const SECRET_WORDS =
  "(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|PASS|API[-_]?KEY|ACCESS[-_]?KEY|PRIVATE[-_]?KEY|CLIENT[-_]?KEY|CREDENTIALS?|AUTH|SESSION|COOKIE|DSN|DATABASE[-_]URL|CONN(?:ECTION)?[-_]?STRING|SIGNING[-_]?KEY|WEBHOOK)";
export const SECRET_NAME = `[A-Za-z0-9_.-]*${SECRET_WORDS}[A-Za-z0-9_.-]*`;
// Words that only hold a secret word by chance (`Passed: 12`, `Author: Sam`): never a secret's name, wherever they stand.
const CHANCE_WORDS = "(?:pass(?:ed|es|ing)|passengers?|bypass(?:ed|es|ing)?|compass|surpass(?:ed|es|ing)?|authors?|authority)";
// English words that are also secret words. After another word on their line, with a `:` and an unquoted value or none,
// they are a sentence (`What it has to pass: …`), not a key: a key stands at its line's start or is an identifier
// (`DB_PASSWORD`, `api-key`, `apiKey`, `webHook`), so neither `password` nor a name not listed here is ever read as prose.
const PROSE_WORDS = "(?:pass|tokens?|secrets?|sessions?|cookies?|auth|webhooks?)";
const LETTER = "A-Za-z0-9\\u00C0-\\u024F";
// The word before: a whole plain word, so a list marker, a `{`, a `key=value` or a comma-ended field is not one, and not
// a word that declares what comes next (`export token: x`). Read only behind a prose word already found, so a line of
// many costs each the gap to the one before it.
const WORD_BEFORE = `(?<=(?:^|\\s)[${LETTER}](?:[${LETTER}'’/.-]*[${LETTER}'’])?[ \\t]+)(?<!(?:^|\\s)(?:export|set|const|let|var|declare|local|readonly)[ \\t]+)`;
// A word as a sentence writes it: lower case, a capital first, or all capitals. Any other (`byPass`, `WebHook`, `pAss`) is
// an identifier. Every regex here ignores case, so this part must not. That syntax needs Node 23; on an older one no word
// is plain, nothing reads as prose, and a sentence goes as a key. One group a branch: in V8 a class after a group's `|` still ignores case.
const PLAIN_WORD = (() => {
  try {
    return new RegExp("(?!(?-i:[A-Za-z0-9]*[a-z0-9][A-Z]))(?!(?-i:[A-Z]{2}[A-Z0-9]*[a-z]))", "i").source;
  } catch {
    return "(?!)";
  }
})();
const NOT_PROSE = `(?!(?=${CHANCE_WORDS}(?![A-Za-z0-9_.-]))${PLAIN_WORD}|(?=${PROSE_WORDS}[ \\t]*:(?=\\s|$)(?!\\s*["'[{]))${PLAIN_WORD}${WORD_BEFORE})`;
// A prose word given a value, guard aside: when the redactor takes something from that line, it was a secret's key after
// all, and in one message the rest of it may be the token's wrapped end.
const PROSE_KEY = new RegExp(`(?<![A-Za-z0-9_.-])${PROSE_WORDS}[ \\t]*:(?=\\s|$)`, "i");
// A secret's name before its separator: the whole run of name characters, read once from where it starts, with a secret
// word in it. Scanned as SECRET_NAME, from inside a long token or back from each secret word in it, it was quadratic.
// One capture group (`name`) of its own.
const NAME_RUN = `(?<![A-Za-z0-9_.-])${NOT_PROSE}(?=[A-Za-z0-9_.-]*?${SECRET_WORDS})(?=(?<name>[A-Za-z0-9_.-]+))\\k<name>`;
// A secret's name from wherever a pattern starts it (a word boundary, after a dash): the same names as SECRET_NAME
// before a character that cannot be in a name, with the secret word looked for ahead once rather than backtracked to.
const SECRET_RUN = `(?=[A-Za-z0-9_.-]*?${SECRET_WORDS})[A-Za-z0-9_.-]+`;
// The first word boundary in a run of name characters: a name read from a later one in the same run reaches the same
// separator with the same secret word still ahead, so it matches only where a read from the first does, and the first is
// found first. Each later boundary rescanned the run to its end, quadratic in a long one (`ab.ab.…`); refused
// here it costs the dots and dashes behind it.
const RUN_START = String.raw`\b(?<![A-Za-z0-9_][.-]*)`;
// The first `--` in a run of name characters, for the same reason: no `-` just before it (`---` holds an earlier one) and
// no `--` further back in the run, the nearest looked for first so each costs only the gap to the one before it.
const FLAG_START = String.raw`(?<!-|--[A-Za-z0-9_.-]*?)`;

// One shell word: unquoted, single-quoted and double-quoted pieces run together
// up to the first unquoted blank (space, tab or line break: as in Bash, U+00A0 and other Unicode spaces are part of the
// word), or an unquoted `,` `;` `}` `]` straight after a closing quote (the end of a JSON value). An unclosed quote,
// and a dangling `\`, run to the end of the line.
const WORD = String.raw`(?:\$'(?:[^'\\]|\\(?:[\s\S]|$))*(?:'|$)|[^ \t\n\r\f\v"'\\,;}\]]|(?<!["'])[,;}\]]|\\(?:[\s\S]|$)|"(?:[^"\\]|\\(?:[\s\S]|$))*(?:"|$)|'[^']*(?:'|$))+`;

// A JSON, JS or YAML string value: escape-aware, `''` inside single quotes as
// YAML writes it, unclosed to the end of the line.
const STRING = String.raw`"(?:[^"\\]|\\(?:[\s\S]|$))*(?:"|$)|'(?:[^'\\]|\\(?:[\s\S]|$)|'')*(?:'|$)`;

/**
 * Keeps a secret key and its quotes, redacts only the string value.
 * @param {string} _match
 * @param {string} quote
 * @param {string} key
 * @param {string} separator
 * @param {string} value
 */
const keyedString = (_match, quote, key, separator, value) => `${quote}${key}${quote}${separator}${value[0]}[redacted]${value[0]}`;

/**
 * `user:password` after a curl user flag. An unquoted user name before the
 * colon stays; everything after it in the word goes.
 * @param {string} _match
 * @param {string} flag
 * @param {string} word
 */
const userPassword = (_match, flag, word) => {
  if (!word.includes(":")) return `${flag}${word}`;
  const user = /^[^\s:"'\\]+:/.exec(word);
  return `${flag}${user ? user[0] : ""}[redacted]`;
};

/** @type {[RegExp, string | ((...args: string[]) => string)][]} */
const RULES = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*/g, "[redacted private key]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted github token]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted github token]"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "[redacted anthropic key]"],
  [/\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, "[redacted api key]"],
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g, "[redacted aws key]"],
  [/\bxox[abpors]-[A-Za-z0-9-]{10,}/g, "[redacted slack token]"],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, "[redacted google key]"],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, "[redacted jwt]"],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  // A scheme read once from the start of its run (kept, leading digits too): from every letter in a long run it was
  // quadratic.
  // The user before the password may be empty (`redis://:password@host`).
  [/((?<![a-z0-9+.-])[0-9+.-]*[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]*:[^\s/@]+@/gi, "$1[redacted]@"],
  [/([?&](?:access_token|token|key|api_key|apikey|secret|sig|signature|password|auth)=)[^&\s]+/gi, "$1[redacted]"],
  [new RegExp(`(["']?)${RUN_START}${NOT_PROSE}(${SECRET_RUN})\\1(\\s*:\\s*)(${STRING})`, "gi"), keyedString],
  // An unquoted value after `:` or a spaced `=` (YAML, INI) is every word to the end of its line or a ` #`
  // comment outside its strings (`password: correct horse battery`), and so is a collection after any `:` or `=`
  // (`credentials: [a, b]`, `PASSWORDS=[a, b]`). A value an earlier rule masked in part goes whole; one that is
  // only a marker stays. A quoted one, and a shell assignment's (`TOKEN=x ./run.sh`), is one shell word, below.
  [new RegExp(`${RUN_START}${NOT_PROSE}(${SECRET_RUN})(["']?(?:\\s*:\\s*|\\s+=\\s*|=\\s+|=(?=[[{])))(?!["']|\\[redacted[^\\]]*\\][^\\S\\r\\n]*(?:#|$))[^\\s"'](?:${STRING}|[^\\s"']|[^\\S\\r\\n]+(?=[^\\s#]))*`, "gi"), "$1$2[redacted]"],
  [new RegExp(`${RUN_START}${NOT_PROSE}(${SECRET_RUN})(["']?\\s*[:=]\\s*)(?!["']?\\[redacted)${WORD}`, "gi"), "$1$2[redacted]"],
  [new RegExp(`(${FLAG_START}--${SECRET_RUN}(?:=|\\s+))${WORD}`, "gi"), "$1[redacted]"],
  [new RegExp(`(\\b(?:mysql|mysqldump|mysqladmin|mariadb|sshpass|mongo|mongosh)\\b.*?\\s-p)\\s*${WORD}`, "g"), "$1 [redacted]"],
  [new RegExp(`(\\bredis-cli\\b.*?\\s-a)\\s*${WORD}`, "g"), "$1 [redacted]"],
  [new RegExp(`(\\s(?:-[uU]\\s*|--(?:proxy-)?user(?:\\s+|=)))(${WORD})`, "g"), userPassword],
  [new RegExp(`(\\b(?:zip|7z|7za|7zz)\\b.*?\\s-[pP])\\s*${WORD}`, "g"), "$1 [redacted]"],
  [new RegExp(`(\\b(?:ldapsearch|ldapadd|ldapmodify|ldapdelete|ldappasswd|ldapwhoami)\\b.*?\\s-w)\\s*${WORD}`, "g"), "$1 [redacted]"],
  [new RegExp(`(\\bsqlcmd\\b.*?\\s-P)\\s*${WORD}`, "g"), "$1 [redacted]"],
];
/**
 * The credentials RULES names by their shape (`[redacted github token]`), each found after any character but a letter or
 * digit: Rivet reads an id with them, where a joining `_` (`x_ghp_…`) keeps the word boundary from matching, while a
 * shape glued to a letter (`task-…` holding `sk-…`) is not one.
 * @type {RegExp[]}
 */
export const NAMED_SHAPES = RULES.filter(([, to]) => typeof to === "string" && to.startsWith("[redacted ")).map(
  ([shape]) => new RegExp(shape.source.replace(/^\\b/, "(?<![A-Za-z0-9])"), shape.flags.replace("g", "")),
);

/** A marker as this file writes one, by its exact name, or left unfinished; any other text after `[redacted` is the line's own. */
const MARKER_NAMES = [...new Set(RULES.map(([, to]) => to).filter((to) => typeof to === "string" && to.startsWith("[redacted ")))];
const LINE_MARKER = new RegExp(`\\[redacted(?:-ip|${MARKER_NAMES.map((to) => to.slice(9, -1)).join("|")})?\\]|\\[redacted`, "g");
const INDEXED_RULES = RULES.map(([pattern, replacement]) => [new RegExp(pattern.source, `${pattern.flags}d`), replacement]);

const FILE_EXT =
  /\.(?:[cm]?[jt]sx?|json5?|md|markdown|css|s[ac]ss|html?|txt|ya?ml|toml|lock|map|py|sh|sql|sqlite|log|csv|png|jpe?g|webp|gif|heic|heif|svg|ico|glb|gltf|bin|mp[34]|m4a|aac|ogg|opus|flac|wav|webm|mov|woff2?|ttf|pdf|docx?|xlsx?|pptx?|eml|msg|zip|gz|tgz)$/i;

const SHORT_WORDS = new Set(["As", "At", "Be", "By", "Db", "Do", "Go", "Id", "If", "In", "Io", "Is", "Js", "My", "No", "Of", "Ok", "On", "Or", "To", "Ts", "Ui", "Up", "Vs"]);

const COMMON_PAIRS = new Set(
  "ab ac ad ae af ag ai ak al am an ap ar as at au av aw ay ba be bi bl bo br bu ca ce ch ci ck cl co cr ct cu cy da de di dl do dr du dy ea eb ec ed ee ef eg ei el em en eo ep er es et eu ev ew ex fa fe ff fi fl fo fr fu ga ge gg gh gi gl gn go gr gu gy ha he hi ho hr ht hu hy ia ib ic id ie if ig ik il im in io ip ir is it iu iv iz ka ke ki la ld le li ll lo lt lu ly ma mb me mi mm mo mp mu my na nc nd ne nf ng ni nk nl nn no np nr ns nt nu ny oa ob oc od oe of og oi ol om on oo op or os ot ou ov ow ox pa pe ph pi pl po pp pr ps pt pu py qu ra rb rc rd re rg ri rk rl rm rn ro rp rr rs rt ru ry sa sc se sh si sl sm so sp ss st su sy ta te th ti tl to tr tt tu ty ua ub uc ud ue ug ui ul um un up ur us ut va ve vi vo wa we wi wo xi yl ym yn yp yr ys yt ze zo".split(" "),
);

/**
 * Whether a lowercase run of 20 or more reads as words: hex up to a commit
 * SHA, or at most two groups of digits (the second within two letters of the
 * first, as in `5x6`) and 70% of its letter pairs among the 255 most common in
 * English words. Random base36 passes about 4 times in 100,000.
 * @param {string} run
 */
function wordShaped(run) {
  if (/^[0-9a-f]+$/.test(run)) return run.length <= 40;
  const digits = run.match(/[0-9]+/g) ?? [];
  if (digits.length > 2 || digits.join("").length > 6 || (digits.length === 2 && !/[0-9][a-z]{1,2}[0-9]/.test(run))) return false;
  let pairs = 0;
  let common = 0;
  for (const word of run.match(/[a-z]+/g) ?? []) {
    for (let i = 1; i < word.length; i++) {
      pairs++;
      if (COMMON_PAIRS.has(word.slice(i - 1, i + 1))) common++;
    }
  }
  return common >= pairs * 0.7;
}

/**
 * Whether a run of letters and digits reads as a name: lowercase with digits
 * (package names) that is short or reads as words, capitals (constants), a
 * short capitals-and-digits code (`T07`, `SHA256SUMS`), hex up to a commit SHA,
 * or mostly-lowercase camelCase built from real-looking words. In those, a word
 * of three or more letters has a vowel and no five consonants in a row, a
 * two-letter capitalised word comes from a short list, a lone letter only
 * starts the run or is a version or dimension (`apiV1`, `3D`), an acronym is
 * two to five capitals, and a number of up to four digits follows a word.
 * @param {string} run
 */
function nameShaped(run) {
  if (/^[a-z0-9]*$/.test(run)) return run.length < 20 || wordShaped(run);
  if (/^[A-Z]+$/.test(run)) return true;
  if (/^[0-9A-F]+$/.test(run)) return run.length <= 40;
  if (/^[A-Z0-9]+$/.test(run)) return run.length < 16 && /^[0-9]*[A-Z]*[0-9]*[A-Z]*$/.test(run);
  const lower = run.replace(/[^a-z]/g, "").length;
  if (lower < run.replace(/[^A-Z]/g, "").length) return false;
  const words = Array.from(run.matchAll(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g), ([word]) => word);
  return words.every((word, i) => {
    const previous = words[i - 1] ?? "";
    const next = words[i + 1] ?? "";
    if (/^[0-9]/.test(word)) return i > 0 && word.length <= 4;
    if (/^[A-Z]+$/.test(word)) {
      if (word.length > 5) return false;
      if (word.length > 1) return true;
      return word === "V" ? /[a-z]{2}$/.test(previous) && /^[0-9]+$/.test(next) : word === "D" && /^[0-9]+$/.test(previous) && next === "";
    }
    if (/^[0-9]/.test(previous) && /^[a-z]/.test(word)) return next === "" && /^(?:d|k|x|px|st|nd|rd|th|s)$/.test(word);
    if (word.length === 1) return i === 0;
    if (word.length === 2 && /^[A-Z]/.test(word)) return SHORT_WORDS.has(word);
    if (/[^aeiouy]{5}/i.test(word)) return false;
    return word.length < 3 || /[aeiouy]/i.test(word) || (i === 0 && /^[a-z]{3}$/.test(word));
  });
}

/**
 * A secret candidate whatever its entropy: 16+ characters with capitals and
 * digits, or 20+ base62/base64 characters, unless it reads as a name; base64
 * `+` or padding; or a hex run of 20 or more that is not a full commit SHA (40): a 32-character API key goes.
 * @param {string} run
 */
function candidate(run) {
  if (/^[0-9a-f]+$/i.test(run)) return run.length >= 20 && run.length !== 40;
  if (run.length >= 20 && /[+=]/.test(run)) return true;
  if (run.length >= 16 && /[A-Z]/.test(run) && /[0-9]/.test(run)) return !nameShaped(run);
  return run.length >= 20 && !nameShaped(run);
}

/**
 * The parts of a path segment between `.`, `-`, `_`, `@`, `+` and `~`.
 * @param {string} segment
 */
const partsOf = (segment) => segment.split(/[._@+~-]+/);

/**
 * A segment reads as a name when every part does, or it ends in a known file
 * extension and no part is a secret candidate. Base64 padding never does, and
 * `+` only joins lowercase package names as pnpm writes them.
 * @param {string} segment
 */
function nameLike(segment) {
  if (segment.includes("=") || (segment.includes("+") && (/[A-Z]/.test(segment) || /(?<![a-z0-9])\+|\+(?![a-z0-9])/.test(segment)))) return false;
  const parts = partsOf(segment);
  if (parts.every(nameShaped)) return true;
  return FILE_EXT.test(segment) && !parts.some(candidate);
}

/**
 * A token is safe only when every `/` segment reads as a name, no part is a
 * secret candidate, and its mixed-case parts joined are not one either.
 * Otherwise the whole token goes, so neither a leading `/` or `./` nor slashes
 * that cut a secret into name-sized pieces can clear it. pnpm shortens a long
 * store folder name with `_` and a 26-character base32 hash, which is dropped
 * before the check.
 * @param {string} token
 */
function looksSecret(token) {
  if (token.includes("[redacted")) return false;
  const segments = token.split("/").map((segment, i, all) => (all[i - 1] === ".pnpm" ? segment.replace(/_[a-z2-7]{26}$/, "") : segment)).filter(Boolean);
  if (segments.flatMap(partsOf).some(candidate)) return true;
  const capitalParts = segments.filter((segment) => !FILE_EXT.test(segment)).flatMap(partsOf).filter((part) => /[A-Z]/.test(part) && !/^[A-Z]+$/.test(part));
  if (candidate(capitalParts.join(""))) return true;
  return !segments.every(nameLike);
}

// Inspection only: decoded variants are never published. One escape can mean a
// numeric code point, a shell identity escape, or a standard control character.
const TEXT_ESCAPE = /\\(?:u\{[0-9a-fA-F]+\}|U[0-9a-fA-F]{1,8}|u[0-9a-fA-F]{1,4}|x[0-9a-fA-F]{1,2}|0?[0-7]{1,3}|[\s\S])/g;
const CONTROL_ESCAPES = { a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
const MAX_INSPECTION = 64 * 1024;
// Inspection runs the rules over the whole line, and some scan a run of non-blanks in quadratic time that the work
// counter cannot stop. A line with a longer run is held as one too long to inspect.
const MAX_RUN = 512;
/**
 * The IP addresses in a text as `coverIps` covers them (`::` alone not one): a spelling with escapes that reads as one
 * is withheld. @param {string} text
 */
const ipsIn = (text) => [...text.matchAll(IPV6_V4), ...text.matchAll(IPV4), ...text.matchAll(IPV6)].filter(([ip]) => ip !== "::");

// Conservative seeds for every SECRET_NAME alternative and every RULES family.
// Keep these in sync with those declarations; shorter seeds deliberately err
// toward inspection. Literal-keyword rules cannot match without one of them.
const SECRET_ANCHORS = [
  "secret", "token", "password", "passwd", "passphrase", "pass", "api", "access", "private", "client", "credential",
  "auth", "session", "cookie", "dsn", "database", "conn", "signing", "webhook",
];
const STRUCTURAL_ESCAPE_ANCHORS = [
  "private key", "mysql", "mariadb", "sshpass", "mongo", "redis-cli", "ldap", "sqlcmd", "-u", "--user", "--proxy-user", "zip", "7z",
];
const ESCAPE_ANCHORS = [
  "github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "sk-", "akia", "asia", "agpa", "aida", "aroa", "anpa",
  "xox", "aiza", "eyj", "bearer", "basic", "token", "://", "key", "sig", ...STRUCTURAL_ESCAPE_ANCHORS,
];

/** A proof for simple control escapes, not a permissive decoding heuristic.
 * Every plain character must be consumed; only escape interpretations branch.
 * With structuralOnly, proves only that no multiline secret context can form;
 * the line may still need redaction for a credential or token heuristic.
 * @param {string} text @param {boolean} [structuralOnly]
 */
function harmlessControlEscapes(text, structuralOnly = false) {
  const controls = /\\([abfnrtv])/g;
  if (/[\x00-\x1f\x7f-\x9f]/.test(text) || text.replace(controls, "").includes("\\")) return false;
  const identity = text.replace(controls, "$1");
  // All identity letters belong to the token alphabet. Replacing them with a
  // control/empty string cannot create a longer candidate than this reading.
  // Name-shape judgements are not monotonic and are intentionally not used.
  if (!structuralOnly && /[A-Za-z0-9+/_.@-]{16,}/.test(identity)) return false;
  // A control escape dropped by display cleanup joins the address characters either side of it (`203.0\b.113.42`): a
  // run of them through one, with an address's dots or colons, is read out like any other escape.
  if (!structuralOnly && Array.from(text.replace(controls, "\0").matchAll(/[0-9A-Fa-f.:\0]+/g), ([run]) => run)
    .some((run) => run.includes("\0") && (run.split(".").length > 3 || run.split(":").length > 2))) return false;
  const pieces = [];
  let at = 0;
  for (const match of text.matchAll(controls)) {
    pieces.push(text.slice(at, match.index).toLowerCase(), [match[1], CONTROL_ESCAPES[match[1]], "", " "]);
    at = match.index + match[0].length;
  }
  pieces.push(text.slice(at).toLowerCase());
  let work = 0;
  const anchors = [
    ...(structuralOnly ? STRUCTURAL_ESCAPE_ANCHORS : ESCAPE_ANCHORS).map((anchor) => ({ anchor, assignment: false, flag: false })),
    ...SECRET_ANCHORS.map((anchor) => ({ anchor, assignment: true, flag: false })),
    // A flag's hyphen must be attached to its name prefix, not elsewhere in a
    // diagnostic. -1 tracks that prefix before the secret stem begins.
    ...SECRET_ANCHORS.map((anchor) => ({ anchor, assignment: false, flag: true })),
  ];
  for (const { anchor, assignment, flag } of anchors) {
    let states = new Set(flag ? [0, -2] : [0]);
    const advance = (from, value) => {
      let current = from;
      for (const char of value) {
        const next = new Set([0]);
        if (flag && /[\s;&|"']/.test(char)) next.add(-2);
        for (const prefix of current) {
          if (++work > 4 * 1024 * 1024) return null;
          if (flag && prefix === 0) {
            // Double-hyphen options may occur in quoted command text too.
            if (char === "-") next.add(-3);
          } else if (prefix === -2 || prefix === -3) {
            if (char === "-") next.add(-1);
          } else if (prefix === -1) {
            if (/[a-z0-9_.-]/.test(char)) next.add(-1);
            if (anchor[0] === char) next.add(1);
          } else if (prefix >= anchor.length) {
            if (flag) {
              // Complete the name, its required separator, then a nonblank
              // value. A quoted mention such as '--session' is not a flag.
              if (prefix === anchor.length && /[a-z0-9_.-]/.test(char)) next.add(prefix);
              if (prefix === anchor.length && /[=\s]/.test(char)) next.add(anchor.length + 1);
              if (prefix === anchor.length + 1) {
                if (/\s/.test(char)) next.add(prefix);
                else return null;
              }
              continue;
            }
            // name characters, optional closing quote, then whitespace and
            // assignment punctuation. The three phases retain exact order.
            if (prefix === anchor.length && /[a-z0-9_.-]/.test(char)) next.add(prefix);
            if (prefix === anchor.length && /["']/.test(char)) next.add(anchor.length + 1);
            if (/\s/.test(char)) next.add(anchor.length + 2);
            if (/[:=]/.test(char)) return null;
          } else if (anchor[prefix] === char) {
            if (!assignment && !flag && prefix + 1 === anchor.length) return null;
            next.add(prefix + 1);
          }
        }
        current = next;
      }
      return current;
    };
    for (const piece of pieces) {
      const merged = new Set();
      for (const alternative of Array.isArray(piece) ? piece : [piece]) {
        const next = advance(states, alternative);
        if (!next) return false;
        for (const prefix of next) merged.add(prefix);
      }
      states = merged;
    }
  }
  return true;
}

/** Apply RULES with exact source spans. Only retained captures/delimiters keep
 * origins; generated markers never do. No substring/diff inference is used.
 * @param {string} input @param {(amount: number) => boolean} charge
 */
function ruleProjection(input, charge) {
  if (!charge(input.length)) return null;
  let text = input;
  let origins = Array.from({ length: input.length }, (_, i) => i);
  for (const [pattern, replacement] of INDEXED_RULES) {
    if (!charge(text.length)) return null;
    const chunks = [];
    const nextOrigins = [];
    let end = 0;
    let matched = false;
    const append = (part) => {
      const source = Array.isArray(part);
      const value = source ? text.slice(part[0], part[1]) : part;
      if (!charge(value.length * 2)) return false;
      chunks.push(value);
      for (let i = 0; i < value.length; i++) nextOrigins.push(source ? origins[part[0] + i] : -1);
      return true;
    };
    for (const match of text.matchAll(pattern)) {
      matched = true;
      const [start, stop] = match.indices[0];
      if (!append([end, start])) return null;
      let parts;
      if (replacement === keyedString) {
        const value = match[4];
        const valueStart = match.indices[4][0];
        parts = [[start, valueStart + 1], "[redacted]"];
        let close = -1;
        for (let i = 1; i < value.length; i++) {
          if (value[i] === "\\") i++;
          else if (value[i] === value[0]) {
            if (value[0] === "'" && value[i + 1] === "'") i++;
            else { close = i; break; }
          }
        }
        parts.push(close < 0 ? value[0] : [valueStart + close, valueStart + close + 1]);
      } else if (replacement === userPassword) {
        const word = match[2];
        if (!word.includes(":")) parts = [[start, stop]];
        else {
          const user = /^[^\s:"'\\]+:/.exec(word);
          parts = [match.indices[1]];
          if (user) parts.push([match.indices[2][0], match.indices[2][0] + user[0].length]);
          parts.push("[redacted]");
        }
      } else if (replacement === "$1[redacted]@") {
        parts = [match.indices[1], "[redacted]", [stop - 1, stop]];
      } else if (typeof replacement === "string") {
        parts = [];
        let at = 0;
        for (const capture of replacement.matchAll(/\$(\d+)/g)) {
          parts.push(replacement.slice(at, capture.index), match.indices[Number(capture[1])] ?? "");
          at = capture.index + capture[0].length;
        }
        parts.push(replacement.slice(at));
      } else return null;
      for (const part of parts) if (!append(part)) return null;
      end = stop;
    }
    if (!matched) continue;
    if (!append([end, text.length])) return null;
    text = chunks.join("");
    origins = nextOrigins;
  }
  if (!charge(input.length + origins.length)) return null;
  const exposed = Array(input.length).fill(false);
  for (const origin of origins) if (origin >= 0) exposed[origin] = true;
  return { text, exposed };
}

/** Mirror display normalization while retaining exposure on surviving chars.
 * @param {string} text @param {boolean[]} exposed @param {boolean} spaces
 * @param {(amount: number) => boolean} charge
 */
function shownWithExposure(text, exposed, spaces, charge) {
  const transforms = [...(spaces ? [[/[\r\n\t\f\v]/g, " "]] : []), [ESC_SEQ, ""], [/\t/g, " "], [C0_C1, ""]];
  for (const [pattern, replacement] of transforms) {
    if (!charge(text.length)) return null;
    const chunks = [];
    const next = [];
    let end = 0;
    for (const match of text.matchAll(pattern)) {
      if (!charge((match.index - end + replacement.length + match[0].length) * 2)) return null;
      chunks.push(text.slice(end, match.index), replacement);
      for (let i = end; i < match.index; i++) next.push(exposed[i]);
      const tainted = exposed.slice(match.index, match.index + match[0].length).some(Boolean);
      for (let i = 0; i < replacement.length; i++) next.push(tainted);
      end = match.index + match[0].length;
    }
    if (!charge((text.length - end) * 2)) return null;
    chunks.push(text.slice(end));
    for (let i = end; i < text.length; i++) next.push(exposed[i]);
    text = chunks.join("");
    exposed = next;
  }
  return { text, exposed };
}

/** Decoding must not introduce any reading the raw multiline parser lacks.
 * @param {string} decoded @param {string} baseline
 */
function untrackedOpening(decoded, baseline) {
  const next = opens(decoded);
  if (!next) return false;
  const previous = opens(baseline);
  if (!previous || (next.overflow && !previous.overflow)) return true;
  const keys = (reading) => [reading, ...(reading.alts ?? [])].map((one) =>
    JSON.stringify([one.open, Boolean(one.shell), Boolean(one.loose)]));
  const tracked = new Set(keys(previous));
  return keys(next).some((key) => !tracked.has(key));
}

/** A bounded certificate for unexplored control alternatives inside a secret.
 * Complete JSON fixes quote/container boundaries: its standard control escapes
 * occur inside closed strings and cannot add/remove quotes, brackets, or shell
 * syntax. Quote/backslash escapes are explicitly excluded by the control-only
 * proof; JSON shape alone never permits dropping a changed parser reading.
 * The independent structural proof must also exclude hidden shadow headers.
 * @param {string} text @param {any} context
 */
function stableControlContext(text, context) {
  if (context.inKey || /[$`]/.test(text) || !harmlessControlEscapes(text, true)) return false;
  try { JSON.parse(text); } catch { return false; }
  let visited = 0;
  const check = (secret) => {
    if (!secret) return true;
    if (++visited > 64 || secret.overflow) return false;
    for (const reading of [secret, ...(secret.alts ?? [])]) {
      if (reading.shell || reading.open?.some((one) => one !== "[" && one !== "{")) return false;
    }
    // A JSON value cannot change its leading indent or form a fence/list item;
    // headers, block scalars and lists therefore keep the raw parser's shape.
    return check(secret.shadow?.secret);
  };
  return check(context.secret);
}

/** @param {string} spelling */
function escapeChoices(spelling) {
  const identity = spelling.slice(1);
  // A partially decoded layer may retain this escape while its neighbours
  // decode, completing a numeric escape for the next layer.
  const choices = [spelling, identity];
  if (CONTROL_ESCAPES[identity] !== undefined) choices.unshift(CONTROL_ESCAPES[identity]);
  const number = /^(?:u\{([0-9a-fA-F]+)\}|[uUx]([0-9a-fA-F]+)|([0-7]+))$/.exec(identity);
  if (number) {
    const octal = number[3];
    const code = parseInt(octal ?? number[1] ?? number[2], octal === undefined ? 16 : 8);
    if (code > 0x10ffff) return null;
    // Byte escapes above ASCII may be UTF-8 pieces, not individual code points.
    if ((octal !== undefined || identity.startsWith("x")) && code > 127) return null;
    choices.unshift(String.fromCodePoint(code));
    if (octal?.length === 4) choices.push(String.fromCodePoint(parseInt(octal.slice(0, 3), 8)) + octal.slice(3));
  }
  return [...new Set(choices)];
}

/** 0: safe; 1: withhold this line; 2: ambiguous multiline boundary, hold stream.
 * @param {string} line @param {any} [context] @param {string} [home]
 * @param {{ rest?: boolean, depth?: number, stateOnly?: boolean }} [options]
 */
function inspectEscapes(line, context = null, home = "", options = {}) {
  // A backslash that ends the line escapes nothing on it: a continued line's own, read with it kept.
  if (/(?<!\\)(?:\\\\)*\\$/.test(line.slice(-MAX_RUN))) line = line.slice(0, -1);
  if (!line.includes("\\")) return 0;
  if (line.length > MAX_INSPECTION || line.split(/\s/).some((word) => word.length > MAX_RUN)) return 2;
  const initial = shown(line);
  const active = Boolean(context?.secret || context?.inKey);
  let transitions = 0;
  const successor = (lines) => {
    const copy = structuredClone(context);
    for (const text of lines) {
      if (++transitions > 128) return null;
      lineOut(shown(text), copy, home, { ...options, stateOnly: true });
    }
    return JSON.stringify(copy);
  };
  const originalSuccessor = active ? successor([initial]) : null;
  const contextSafe = (text) => !active || stableControlContext(text, context);
  let work = 0;
  const charge = (amount) => (work += amount) <= 4 * 1024 * 1024;
  const projection = ruleProjection(initial, charge);
  if (!projection) return 2;
  const published = projection.text;
  // Inspect the published spelling for secrets, and the original spelling for
  // hidden boundaries and exposed value fragments the raw rules did not mask.
  const pending = [{ text: published, depth: 0, structural: false, baseline: published, exposed: Array(published.length).fill(true) }];
  if (published !== initial) pending.push({ text: initial, depth: 0, structural: true, baseline: initial, exposed: projection.exposed });
  const seen = new Set(pending.map((entry) => `${entry.structural}:${entry.text}:${entry.exposed.map(Number).join("")}`));
  let result = 0;
  while (pending.length) {
    const { text, depth, structural, baseline, exposed } = pending.pop();
    // C/C++ hex escapes have variable width; do not guess at a two-digit prefix.
    if (/\\N\{|\\x[0-9a-fA-F]{3,}/.test(text)) return 2;
    if (harmlessControlEscapes(text) && contextSafe(text)) continue;
    const matches = [...text.matchAll(TEXT_ESCAPE)];
    if (!matches.length) continue;
    const choices = matches.map(([spelling]) => escapeChoices(spelling));
    if (choices.some((one) => one === null)) return 2;
    // An escape for an invisible character or a compatibility form hides a name from every reading, and the name can
    // open a value on the lines after it (`\uFF50assword:`).
    // Half a surrogate pair folds only with its other half (`\uD835\uDC29` is a styled p), escaped or beside it: the
    // pair is read whole and holds when it folds. A half alone folds to nothing, and an escaped emoji's pair is kept.
    const HIGH = /^[\uD800-\uDBFF]$/;
    const LOW = /^[\uDC00-\uDFFF]$/;
    // A half's other half: the escape or the character right beside it on the side its half goes. Not beside it, any
    // other half on that side, escaped or written alone, may meet it once cleaning takes out what is between
    // (`\uD835\x00\uDC29`, an escaped ANSI sequence), so the line holds.
    const FAR = Symbol("far");
    const partner = (/** @type {number} */ i, /** @type {string} */ half) => {
      const forward = HIGH.test(half);
      const other = forward ? LOW : HIGH;
      const start = matches[i].index ?? 0;
      const end = start + matches[i][0].length;
      const k = forward ? i + 1 : i - 1;
      const near = matches[k];
      if (near && (forward ? near.index === end : (near.index ?? 0) + near[0].length === start)) {
        const found = choices[k].find((value) => other.test(value));
        if (found) return found;
      }
      const c = text[forward ? end : start - 1] ?? "";
      if (other.test(c)) return c;
      const s = sides();
      const escaped = forward ? s.lowFrom[i + 1] : s.highTo[i];
      const written = forward ? s.lastLow >= end : s.firstHigh < start;
      return escaped || written ? FAR : undefined;
    };
    // Where the other halves are, read once per text so the search stays linear: an escape with a low half at or
    // after each match, one with a high half before it, and the last low and first high half written alone.
    /** @type {{ lowFrom: boolean[], highTo: boolean[], lastLow: number, firstHigh: number } | undefined} */
    let found;
    const sides = () => {
      if (found) return found;
      const lowFrom = Array(matches.length + 1).fill(false);
      const highTo = Array(matches.length + 1).fill(false);
      for (let k = matches.length - 1; k >= 0; k--) lowFrom[k] = lowFrom[k + 1] || choices[k].some((value) => LOW.test(value));
      for (let k = 0; k < matches.length; k++) highTo[k + 1] = highTo[k] || choices[k].some((value) => HIGH.test(value));
      const lows = [...text.matchAll(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g)];
      const high = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.exec(text);
      found = { lowFrom, highTo, lastLow: lows.length ? (lows[lows.length - 1].index ?? -1) : -1, firstHigh: high ? high.index : Infinity };
      return found;
    };
    const holds = (/** @type {string} */ value, /** @type {number} */ i) => {
      if (plain(value) !== value) return true;
      if (!/\p{Cs}/u.test(value)) return false;
      const other = partner(i, value);
      if (other === FAR) return true;
      const pair = other === undefined ? null : HIGH.test(value) ? value + other : other + value;
      return pair !== null && plain(pair) !== pair;
    };
    if (choices.some((one, i) => one.some((value) => holds(value, i)))) return 2;
    // The existing parser deliberately approximates several data grammars.
    // New syntax inside any protected value is ambiguous even if both parser
    // runs happen to produce the same approximate state (for example a list).
    if (active && choices.some((one, i) => one.some((value) =>
      value !== matches[i][0] && /[\[\]{}()"'`$#;|\\]/.test(value)
    ))) return 2;
    // If every possible character is token text, omitted combinations cannot
    // create an assignment, collection, or PEM boundary. Otherwise hold state.
    // Retained, complete fixed-width Unicode escapes cannot absorb digits
    // from neighbouring readings. Keep them in enumeration, but their raw
    // backslash adds no structural possibility beyond their decoded choices.
    // Hex, octal and incomplete Unicode spellings have no such certificate.
    const proofChoices = choices.map((one, i) => one.filter((value) =>
      value !== matches[i][0] || !/^\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})$/.test(value)
    ));
    const residue = text.replace(TEXT_ESCAPE, "");
    const starts = matches[0]?.index === 0 ? proofChoices[0] : [text[0]];
    // An internal hyphen cannot make a flag/PEM marker in a single word whose
    // every possible beginning is alphanumeric (for example an sk- token).
    const boundary = /[^A-Za-z0-9_-]/.test(residue) ||
      starts.some((value) => !/^[A-Za-z0-9_]/.test(value)) ||
      proofChoices.some((one) => one.some((value) => /[^A-Za-z0-9_-]/.test(value)));
    // Exhausted credential interpretations need not hide the rest of a log if
    // a separate proof rules out every assignment, flag, and PEM boundary.
    let overflowVerdict;
    const exhausted = () => overflowVerdict ??= (!contextSafe(text) || (boundary && !harmlessControlEscapes(text, true))) ? 2 : 1;
    let variants = [{ text: "", exposed: [] }];
    let at = 0;
    let overflow = false;
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const before = text.slice(at, match.index);
      if (variants.length * choices[i].length > 128) { overflow = true; break; }
      const retained = exposed.slice(at, match.index);
      const tainted = exposed.slice(match.index, match.index + match[0].length).some(Boolean);
      variants = variants.flatMap((prefix) => choices[i].map((value) => ({
        text: prefix.text + before + value,
        exposed: [...prefix.exposed, ...retained, ...Array(value.length).fill(tainted)],
      })));
      at = match.index + match[0].length;
      work += variants.reduce((sum, value) => sum + value.text.length * 2, 0);
      if (work > 4 * 1024 * 1024) { overflow = true; break; }
    }
    if (overflow) {
      result = Math.max(result, exhausted());
      // Still inspect uniform readings to discover a nested boundary.
      variants = [0, -1].map((pick) => {
        let decoded = "";
        const exposure = [];
        let end = 0;
        for (let i = 0; i < matches.length; i++) {
          const match = matches[i];
          const one = choices[i];
          const value = one[pick === -1 ? one.length - 1 : pick];
          decoded += text.slice(end, match.index) + value;
          exposure.push(...exposed.slice(end, match.index), ...Array(value.length).fill(exposed.slice(match.index, match.index + match[0].length).some(Boolean)));
          end = match.index + match[0].length;
        }
        return { text: decoded + text.slice(end), exposed: [...exposure, ...exposed.slice(end)] };
      });
    } else variants = variants.map((prefix) => ({ text: prefix.text + text.slice(at), exposed: [...prefix.exposed, ...exposed.slice(at)] }));
    for (const variant of variants) {
      const decoded = variant.text;
      const identity = `${structural}:${decoded}:${variant.exposed.map(Number).join("")}`;
      if (decoded === text || seen.has(identity)) continue;
      // Preserve physical boundaries for the multiline parser's header rule.
      // Flattening password:\n- value first would mask only the list marker,
      // leaving its value exposed. A header on any decoded line can protect
      // later lines/reads, even when the raw assignment masked the escape.
      const physical = decoded.split(/\r\n|[\n\r\v\f\x85\u2028\u2029]/);
      if (physical.length > 1 && physical.some((part) => SECRET_HEADER.test(shown(part)))) return 2;
      // A leading decoded break must not clear an indented secret block as a
      // single unindented string. Follow each physical line from the incoming
      // state before cleanup, unless closed JSON proves the controls are data.
      if (active && physical.length > 1 && !contextSafe(text)) {
        const nextSuccessor = successor(physical);
        if (nextSuccessor === null || nextSuccessor !== originalSuccessor) return 2;
      }
      // Controls can also separate fields or be removed by display cleanup.
      for (const spaces of [false, true]) {
        const display = shownWithExposure(decoded, variant.exposed, spaces, charge);
        if (!display) return Math.max(result, exhausted());
        const visible = display.text;
        if (active) {
          const nextSuccessor = successor([visible]);
          if (nextSuccessor === null || nextSuccessor !== originalSuccessor) return 2;
        }
        const assignments = flagMatches(SECRET_ASSIGN, visible);
        const existing = flagMatches(SECRET_ASSIGN, baseline);
        if (assignments.some((assignment) => !existing.includes(assignment)) ||
            (SECRET_HEADER.test(visible) && !SECRET_HEADER.test(baseline)) ||
            untrackedOpening(visible, baseline) ||
            (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(visible) && !/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(baseline))) return 2;
        const masked = ruleProjection(visible, charge);
        if (!masked) return Math.max(result, exhausted());
        // The raw rule may have masked only an escape that decodes to a
        // separator. Any newly masked character that was published is a leak.
        if (display.exposed.some((one, i) => one && !masked.exposed[i]) ||
            [...visible.matchAll(/[A-Za-z0-9+/_.@-]{16,}={0,2}/g)].some((match) =>
              looksSecret(match[0]) && display.exposed.slice(match.index, match.index + match[0].length).some(Boolean))) result = Math.max(result, 1);
        // An address the decoded reading shows and the line as written does not, published in part.
        // Counted, not only named: the same address written plainly elsewhere on the line shows no more of this one.
        const extra = new Map();
        for (const [ip] of ipsIn(visible)) extra.set(ip, (extra.get(ip) ?? 0) + 1);
        for (const [ip] of ipsIn(baseline)) extra.set(ip, (extra.get(ip) ?? 0) - 1);
        if (ipsIn(visible).some((ip) => (extra.get(ip[0]) ?? 0) > 0 && display.exposed.slice(ip.index, ip.index + ip[0].length).some(Boolean))) {
          result = Math.max(result, 1);
        }
      }
      if (depth >= 7 || seen.size >= 64) { result = Math.max(result, exhausted()); continue; }
      seen.add(identity);
      pending.push({ text: decoded, depth: depth + 1, structural, baseline, exposed: variant.exposed });
    }
  }
  return result;
}

// Markdown marks in a secret's key (`**password**:`, `` `token` = ``, `ENV_**PASSWORD**:`, `**Password:** x`) hide it:
// a key is read only with its separator right after it, a quote between. unmark takes the marks out of a key, and
// underscores next to a quote (`__"password"__`); quotes stay as they are. It is only a second reading: the line is
// read as written too, and goes whole when the two differ. Marks closing after the separator go too, whatever follows
// them (`**password:**"open`). A key is one run of name characters, marks and quotes, matched only from where such a
// run starts with a name character in it and never split two ways, so a long run is scanned once.
const KEY_TOKEN = /(?<![A-Za-z0-9_.*`~"'-])(?=[*`~_"']*[A-Za-z0-9.-])([A-Za-z0-9_.*`~"'-]+)((?:\s[*`~_]*)*[:=])([*`~_]+)?/g;

/** Whether a key, quoted or not, is a secret's name (checked without backtracking over a long one). @param {string} key */
const isKeyName = (key) => {
  const name = key.replace(/^["']|["']$/g, "");
  return /^[A-Za-z0-9_.-]+$/.test(name) && SECRET_WORD.test(name);
};

/**
 * A line with the Markdown marks in a secret's key taken out, and the marks after its separator; with `keep`, those
 * from the first backtick among them on stay, as the value's opening (`opening`, `"label"` its other way).
 * @param {string} line @param {boolean | "label"} [keep]
 */
const unmark = (line, keep = false) => {
  const spans = codeSpans(line);
  return line.replace(KEY_TOKEN, (all, token, separator, after = "", index) => {
    const key = token.replace(/[*`~]+/g, "").replace(/(?<!_)_+(?=["'])|(?<=["'])_+/g, "");
    if (!isKeyName(key)) return all;
    const name = index + token.search(/[^*`~_"']/);
    return `${key}${separator.replace(/[*`~_]+/g, "")}${keep ? opening(line, spans, name, index + all.length - after.length, after, keep === "label") : ""}`;
  });
};

/**
 * Of the marks after a key's separator, those from the first backtick that does not close a code span opened right
 * before the key's name, only marks or blanks between, and holding no quote, on (`` `**password:**` is a label ``
 * opens nothing): the value's opening (`**password:**` then a backtick, `` `password`:` open ``,
 * `` ``password`_``:`open ``). Any other span may be code a backtick in it opened (`note='`'; **password:**`
 * then a backtick, `` a`'**password**: ``), so the backtick after the key still opens: a label with more in it
 * (`` `env **password:**` is a label ``) holds the log until the next backtick rather than risk a value. Read as a
 * reading of its own beside the one with every mark out, which tracks a quote after them (`**password:**_"open`).
 * With `label`, any span closing there is a label's, as another reading: the span may be a quoted key's whose own
 * backtick pairs with the value's (`` "`**password**":`open ``) or a label the value opens after
 * (`` "`**password**":`*`open ``, `` `env **password:**`*`open ``, `` ENV_`**PASSWORD:**`_`open ``).
 * @param {string} line @param {() => Map<number, number>} spans its code spans (`codeSpans`)
 * @param {number} name where the key's name starts in it @param {number} from where the marks start in it
 * @param {string} marks @param {boolean} [label]
 */
const opening = (line, spans, name, from, marks, label = false) => {
  let at = marks.indexOf("`");
  const opened = at < 0 ? undefined : spans().get(from + at);
  const named = opened !== undefined && opened <= name && /^[*~_\s]*$/.test(line.slice(opened, name));
  if (opened !== undefined && (label || (named && !/["']/.test(line.slice(name, from + at))))) {
    while (marks[at] === "`") at++;
    at = marks.indexOf("`", at);
  }
  return at < 0 ? "" : marks.slice(at);
};

/**
 * A line's code spans, read once and only when asked for: where each run of backticks that closes one starts, to where
 * the run that opened it ends. A run opens one only outside a span and unescaped, and closes it only at the same length;
 * one left open has no close, so the backticks after it stay openings.
 * @param {string} line
 */
const codeSpans = (line) => {
  /** @type {Map<number, number> | undefined} */
  let spans;
  const read = () => {
    if (spans) return spans;
    spans = new Map();
    let open = -1;
    let size = 0;
    for (const run of line.matchAll(/`+/g)) {
      let at = run.index;
      let length = run[0].length;
      if (open < 0) {
        let back = 0;
        while (line[at - 1 - back] === "\\") back++;
        if (back % 2) [at, length] = [at + 1, length - 1];
        if (length) [open, size] = [at + length, length];
      } else if (length === size) {
        spans.set(at, open);
        open = -1;
      }
    }
    return spans;
  };
  return read;
};
/** A separator and the marks after it, read where a quoted key ends. */
const MARKS_AFTER = /[:=]([*`~_]*)/y;

// The readers' older reading of the same keys, kept as a third reading: from where the marks and quotes before a
// secret's name start (the first such run after any other quote or mark in the key) to its separator, the marks come
// out and a key that had a quote among them is quoted again (`a_'**secret**:` reads as `a_"secret":`).
const QUOTED_KEY = /(?<![A-Za-z0-9_.*`~"'-])(?=[*`~_"']*[A-Za-z0-9.-])([A-Za-z0-9_.*`~"'-]+)((?:\s[*`~_"']*)*)(?=[:=])/g;
const KEY_MARK = /[_*`~"']/;
const SECRET_WORD = new RegExp(SECRET_WORDS, "i");

/**
 * Marks closing a secret's key after its separator go too (`"**password**"":**"open`), but with `keep`, as in
 * `unmark`. A key read next from inside those marks is read from after them.
 * @param {string} line @param {boolean | "label"} [keep]
 */
const unmarkQuoted = (line, keep = false) => {
  const spans = codeSpans(line);
  let out = "";
  let at = 0;
  for (const match of line.matchAll(QUOTED_KEY)) {
    const from = Math.max(match.index, at);
    const token = match[1].slice(from - match.index);
    const key = quotedKey(line.slice(from, match.index + match[0].length), token, match[2]);
    out += line.slice(at, from) + key;
    at = match.index + match[0].length;
    if (key === line.slice(from, at)) continue;
    MARKS_AFTER.lastIndex = at;
    const marks = MARKS_AFTER.exec(line)?.[1] ?? "";
    out += line[at] + (keep ? opening(line, spans, from + token.search(/[^_*`~"']/), at + 1, marks, keep === "label") : "");
    at += 1 + marks.length;
  }
  return out + line.slice(at);
};

/** One key QUOTED_KEY matched, its marks out, or `all` as it is. @param {string} all @param {string} token @param {string} gap */
const quotedKey = (all, token, gap) => {
  const first = token.search(/[^_*`~"']/);
  if (first < 0) return all;
  let last = token.length - 1;
  while (KEY_MARK.test(token[last])) last--;
  let start = first;
  for (let i = last; i > first; i--) {
    if (/[*`~"']/.test(token[i])) {
      start = i + 1;
      while (token[start] === "_") start++;
      break;
    }
  }
  if (!SECRET_WORD.test(token.slice(start, last + 1))) return all;
  let from = start;
  while (from > 0 && KEY_MARK.test(token[from - 1])) from--;
  if (from > 0) from += 1;
  let end = last + 1;
  while (token[end] === "_") end++;
  const marks = `${token.slice(from, start)}${token.slice(end)}${gap}`;
  if (!/[*`~_]/.test(marks)) return all;
  const name = token.slice(start, end);
  return `${token.slice(0, from)}${/["']/.test(marks) ? `"${name}"` : name}`;
};

// A home folder in a path: a macOS or Linux home root and a user name of letters in any script, digits, marks, `.`, `_` and
// `-`, shortened to ~ only before `/` or the end of the line. Anything else after the name may go on with it into a
// label (`/home/password=`, `/home/api**key**=`, `/home/Bearer <token>`), so that path is read as written.
const HOME_DIR = /\/(?:Users|home)\/[\p{L}\p{N}\p{M}._-]+(?=\/|$)/gu;

/** `text` with each home folder shortened to ~ (`HOME_DIR`). @param {string} text */
export const shortenHome = (text) => text.replace(HOME_DIR, "~");

/** A line as written, then as each reading of its marked keys has it. @param {string} line */
export const keyReadings = (line) => [
  line,
  unmark(line),
  unmarkQuoted(line),
  unmark(line, true),
  unmarkQuoted(line, true),
  unmark(line, "label"),
  unmarkQuoted(line, "label"),
];

/**
 * A line as a log shows it before its secrets are looked for: one line, home folders shortened to ~ (`shortenHome`), then cut to
 * `4 * max` code points. The cut drops the word it falls in: the rules read only the cut line, and shortening or
 * redacting what comes before would bring a token's cut head inside `max`.
 * @param {string} line @param {string} home @param {number} max
 */
function display(line, home, max) {
  const out = sanitizeLine(line, Infinity);
  const short = shortenHome(home && home !== "/" ? out.split(home).join("~") : out);
  const cps = Array.from(short);
  return cps.length > 4 * max ? `${cps.slice(0, Math.max(0, 4 * max - 1)).join("").replace(/\S*$/, "")}…` : short;
}

/** @param {string} out a displayed line @param {number} max */
function scrub(out, max) {
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, /** @type {any} */ (replacement));
  out = out.replace(/[A-Za-z0-9+/_.@-]{16,}={0,2}/g, (token) => (looksSecret(token) ? "[redacted]" : token));
  return clipUnits(out, max);
}

/**
 * @param {string} line
 * @param {string} [home]
 * @param {number} [max] the output's length, MAX_LOG_LINE for a log line
 */
export function redactLine(line, home = homedir(), max = MAX_LOG_LINE) {
  if (readsTwoWays(line)) return "[redacted]";
  const [written, ...others] = textReadings(line);
  const out = asWritten(written, home, max);
  // Read too as folded and with word ends kept (`readings`): each moves word ends the others keep, so none is the safe
  // one alone, and a line they show differently goes whole.
  const seen = shownAs(out);
  return others.every((text) => shownAs(asWritten(text, home, max)) === seen) ? out : "[redacted]";
}

/** A backslash and the line break it continues over. */
const CONTINUATION = /\\(?:\r\n|[\r\n\u2028\u2029])/g;

/** @param {string} line @param {string} home @param {number} max */
function asWritten(line, home, max) {
  const joined = line.replace(CONTINUATION, "");
  // Read with a space where each continuation was too (joining takes a word boundary away: `prefix\` then `Bearer x`),
  // and with a key's marks out both ways: when either reading finds a secret, the line goes whole.
  const space = joined === line ? [] : [line.replace(CONTINUATION, " ")];
  if ([joined, ...space].some((text) => inspectEscapes(text))) return "[redacted]";
  const spaced = space.map((text) => display(text, home, max));
  const out = display(joined, home, max);
  for (const bare of new Set([...spaced, ...keyReadings(out).slice(1)])) {
    if (bare !== out && scrub(bare, max) !== clipUnits(bare, max)) return "[redacted]";
  }
  return scrub(out, max);
}

// A YAML anchor or tag is one run of non-blanks: `(?!\S)` ends it there, so a run of `!` or `&` has one reading, not
// exponentially many (`api_key: !!!…! x` once stalled the bridge).
// A line ending in a secret's name with no value after it (`password:`, YAML `token: |`, JSON `{"password":`, prose
// "Database password:"): its value is on the lines under it. Nothing after the name but a YAML anchor or tag, a block
// indicator or a comment.
const SECRET_HEADER = new RegExp(
  `${NAME_RUN}["']?\\s*[:=]\\s*(?:[&!]\\S*(?!\\S)\\s*)*(?:([|>])[-+0-9]*\\s*(?:#.*)?|#.*)?$`,
  "i",
);
/**
 * A secret's name at the text's start, its `:` or `=`, and any YAML anchor or tag: its value is the rest of the text,
 * with no line break in it (headMatch). A regex reading the value too (`(.*)$`) read to the end once per secret, and a
 * line of many was quadratic; this head has one longest match, the one it takes, so the two agree.
 */
const SECRET_OPEN_HEAD = new RegExp(`${NAME_RUN}["']?\\s*([:=])\\s*(?:[&!]\\S*(?!\\S)\\s*)*`, "iy");
/** A secret's name and everything after its `:` or `=`: the opening line of a value that runs on keeps only the name. */
const SECRET_VALUE = new RegExp(`(${NAME_RUN}["']?\\s*[:=])\\s*\\S.*$`, "i");
/** One message (rest): any secret's name given a value. Its value, and everything after it, goes. */
/**
 * A flag given a secret: `--password x`, `-api-key x`, and a user and password (`curl -u admin:pw`, `--user "a:…`),
 * only when its value word has a colon, backslash, quote, backtick or `$` anywhere (not `git push -u origin`). The name
 * is a secret's run (a long run with no separator after it backtracked over every word in it as SECRET_NAME). `-u`'s
 * value test is userValue's, not a lookahead: a lookahead read each `-u`'s word to its end, and a line of many was
 * quadratic. The regexes with this in them are read through flagExec.
 */
const FLAG_NAME = `-{1,2}${SECRET_RUN}|(?<user>-u|--user|--proxy-user)`;
/** What comes between a secret flag and its value: `=`, blanks, or nothing after `-u` (`-uadmin:pw`, `-u"a:…`). */
const FLAG_SEP = `(?:=|\\s+|(?<=-u|-user)(?=\\S))`;
const SECRET_ASSIGN = new RegExp(`${NAME_RUN}["']?\\s*[:=]|(?:^|[\\s;&|])(?:${FLAG_NAME})${FLAG_SEP}\\S`, "gi");
/** A secret flag at the text's start given its value after a space (`--password "…`): the value is the next shell word. */
const SECRET_FLAG_HEAD = new RegExp(`(?:^|[\\s;&|])(?:${FLAG_NAME})${FLAG_SEP}(?=\\S)`, "iy");
/** What `.` does not match. */
const DOT_BREAK = /[\n\r\u2028\u2029]/g;
/**
 * A secret flag and its value's first character: one line of a message (rest) keeps only the flag, and the value is
 * the rest of the text (nameOnly), as `.*$` read it. A `.*$` here read to the end before a `-u` was turned down.
 */
const SECRET_FLAG_VALUE = new RegExp(`((?:^|[\\s;&|])(?:${FLAG_NAME}))${FLAG_SEP}\\S`, "gi");
/** What a `-u` flag's value word, or the word after blanks when none follows it at once, must hold to be a secret. */
const USER_SECRET = /[:\\"'$`]/;
/** The text userValue last read, and the span of it, `from` up to `to`, whose positions all give `held`. */
let userText = "";
let userSpan = { from: 0, to: 0, held: false };
/**
 * Whether a `-u` name ending at `at` takes a secret: its value word (`=` and all), or when blanks follow it the next
 * word, holds a colon, backslash, quote, `$` or backtick, as the lookahead `(?=(?:=|\s+)?\S*[:\\"'$\`])` read it.
 * It reads on to the first such character or the word's end, and every position it passed gives the same answer, so a
 * line's search, whose `-u` flags come in order, reads each word once.
 * @param {string} text @param {number} at
 */
function userValue(text, at) {
  if (text === userText && at >= userSpan.from && at < userSpan.to) return userSpan.held;
  let end = at;
  while (end < text.length && /\s/.test(text[end])) end++;
  while (end < text.length && !/\s/.test(text[end]) && !USER_SECRET.test(text[end])) end++;
  const held = end < text.length && USER_SECRET.test(text[end]);
  userText = text;
  userSpan = { from: at, to: held ? end + 1 : end, held };
  return held;
}
/**
 * A FLAG_NAME regex's next match from `from` (global, or sticky at its lastIndex), read as the `-u` lookahead did: a
 * `-u` whose value fails userValue is no match where it starts. It is the last way the regex has to match there, so
 * the search goes on from the next character.
 * @param {RegExp} re @param {string} text @param {number} [from]
 */
function flagExec(re, text, from = re.sticky ? re.lastIndex : 0) {
  for (re.lastIndex = from; ; ) {
    const match = re.exec(text);
    const user = match?.groups?.user;
    if (!match || user === undefined || userValue(text, match.index + (match[0][0] === "-" ? 0 : 1) + user.length)) return match;
    if (re.sticky) return null;
    re.lastIndex = match.index + 1;
  }
}
/** Every match of a global FLAG_NAME regex, as String.prototype.match gives them. @param {RegExp} re @param {string} text */
function flagMatches(re, text) {
  const found = [];
  for (let match = flagExec(re, text); match; match = flagExec(re, text, match.index + match[0].length)) found.push(match[0]);
  return found;
}
const CLOSER = /** @type {Record<string, string>} */ ({ "]": "[", "}": "{", ")": "(" });
/** Characters scan and wordScan have read, for opens' budget. */
let scanned = 0;

/**
 * Reads text on from the contexts a value left open: quotes (`''` inside single ones, `\` escapes inside double ones),
 * brackets and, in a shell value, `$(…)` and backticks with quotes of their own. Returns the contexts still open at its
 * end, and where the last one closed (-1: never).
 * @param {string} text @param {string[]} stack @param {boolean} shell
 */
function scan(text, stack, shell, loose = false) {
  const open = [...stack];
  let i = 0;
  for (; i < text.length && open.length; i++) {
    const c = text[i];
    // A `$` and a line continuation inside a quote or substitution: `(` opening this line makes it `$(`.
    if (open[open.length - 1] === "$\\") {
      // Another continuation keeps it pending; `(` makes `$(`, and `'` outside double quotes makes `$'`.
      if (c === "\\" && i === text.length - 1) break;
      open.pop();
      if (c === "(" || (c === "'" && open[open.length - 1] !== '"')) {
        open.push(c === "(" ? "(" : "$'");
        continue;
      }
    }
    const top = open[open.length - 1];
    const subst = shell && c === "$" && text[i + 1] === "(";
    if (top === '"""' || top === "'''") {
      // A triple-quoted string (Python, TOML) ends only at its own three quotes.
      if (text.startsWith(top, i)) {
        open.pop();
        i += 2;
      } else if (c === "\\") i++;
    } else if (top === "'") {
      if (c === "'" && text[i + 1] === "'") i++;
      else if (c === "'") open.pop();
    } else if (top === "$'") {
      // Bash's ANSI-C quotes: a backslash escapes the next character, an apostrophe among them.
      if (c === "\\") i++;
      else if (c === "'") open.pop();
    } else if (c === "\\") {
      if (shell && i === text.length - 1 && text[i - 1] === "$") open.push("$\\");
      i++;
    } else if (shell && c === "`") {
      if (top === "`") open.pop();
      else open.push("`");
    } else if (subst) {
      open.push("(");
      i++;
    } else if (top === '"') {
      if (c === '"') open.pop();
    } else if (shell && c === "$" && text[i + 1] === "'") {
      open.push("$'");
      i++;
    } else if (c === "#" && "[{(".includes(top) && (i === 0 || /\s/.test(text[i - 1]) || (shell ? /[;&|()]/.test(text[i - 1]) : loose || /[,[{(]/.test(text[i - 1])))) {
      // A comment (`[ # ]`): its closers are text, so the collection stays open.
      break;
    } else if (!shell && (c === '"' || c === "'") && text.startsWith(c.repeat(3), i)) {
      open.push(c.repeat(3));
      i += 2;
    } else if (c === '"' || c === "'" || c === "[" || c === "{" || (top === "(" && c === "(")) open.push(c);
    else if (CLOSER[c] === top) open.pop();
    if (!open.length) {
      scanned += i + 1;
      return { open, end: i + 1 };
    }
  }
  scanned += i;
  return { open, end: -1 };
}

/**
 * The quote, backtick, `$(` or `$'` opening at `text[i]` (a triple quote too in data, `triple`): the context it opens
 * and its width, or null.
 * @param {string} text @param {number} i @param {boolean} [triple]
 * @returns {[string, number] | null}
 */
function opensAt(text, i, triple = false) {
  if (text.startsWith("$(", i)) return ["(", 2];
  if (text.startsWith("$'", i)) return ["$'", 2];
  if (triple && (text.startsWith('"""', i) || text.startsWith("'''", i))) return [text.slice(i, i + 3), 3];
  return /["'`]/.test(text[i] ?? "") ? [text[i], 1] : null;
}

/**
 * A shell word read from its start: the contexts it leaves open at the line's end (`"a"'b…`: one word, one value), or
 * null and where the word ended.
 * @param {string} text
 * @returns {{ open: string[] | null, end: number }}
 */
function wordScan(text) {
  // The word runs to an unescaped space, tab or `;`, `&`, `|` (Bash's blanks, never U+00A0); a backslash keeps the next
  // character in it as text, and one ending the line carries the word onto the next ("\\"; `$\` carries the `$` too).
  let i = 0;
  for (; i < text.length && !/[ \t;&|]/.test(text[i]); i++, scanned++) {
    if (text[i] === "\\" && i === text.length - 1) return { open: [text[i - 1] === "$" ? "\\$" : "\\"], end: -1 };
    if (text[i] === "\\") {
      i++;
      continue;
    }
    const at = opensAt(text, i);
    if (at) {
      const [context, width] = at;
      const { open, end } = scan(text.slice(i + width), [context], true);
      if (open.length) return { open, end: -1 };
      i += width + end - 1;
    }
  }
  return { open: null, end: i };
}

/**
 * The readings of every secret's value on this text still open at its end, or null: each secret on the line, not only
 * the first, since a name inside another's value may be only text or may be real (`--password "a TOKEN=[`,
 * `x="TOKEN='"; SECRET="`); a wrong one only redacts more. A value opening with a quote, bracket, `$(` or backtick
 * opens there; a shell one (`=`) also at any quote, `$(` or backtick later in its word. `=` is read both as shell and
 * as data (Python, TOML, JS).
 * @param {string} text
 * @returns {{ open: string[], shell: boolean, loose?: boolean, alts: Reading[] } | null}
 */
function opens(text) {
  const found = [];
  // Each secret's value is read until it closes, so many open on one line (`TOKEN=[` repeated) were quadratic: past
  // MAX_OPENS_WORK characters read (or 8 for each of a longer line's), the line overflows (the log is held). Values that
  // close soon cost little.
  const start = scanned;
  const budget = Math.max(MAX_OPENS_WORK, 8 * text.length);
  // Past MAX_READINGS distinct readings the line overflows too, as `readings` would have it.
  const over = () => scanned - start > budget || seen.size > MAX_READINGS;
  // A value runs to the text's end, so it must start past the last line break.
  let unbroken = 0;
  for (const at of text.matchAll(DOT_BREAK)) unbroken = (at.index ?? 0) + 1;
  // Only new readings are kept, keyed as `readings` dedupes them: a line of many values passed every one (nulls too) to
  // `readings`, past V8's argument limit.
  const seen = new Set();
  const add = (/** @type {any} */ one) => {
    if (!one) return;
    const keys = [one, ...(one.alts ?? [])].map((r) => JSON.stringify([r.open, r.shell, Boolean(r.loose)]));
    if (!one.overflow && keys.every((key) => seen.has(key))) return;
    for (const key of keys) seen.add(key);
    found.push(one);
  };
  for (const name of text.matchAll(SECRET_NAME_AT)) {
    if (over()) return overflowed(found);
    const from = text.slice(name.index);
    const broken = unbroken - (name.index ?? 0);
    add(assignOpens(from, true, broken));
    if (name[0].endsWith("=")) add(assignOpens(from, false, broken));
  }
  // Every flag, overlapping ones too (the blank before a flag's value can start another).
  const flags = [];
  for (let flag = flagExec(SECRET_FLAG_AT, text); flag; flag = flagExec(SECRET_FLAG_AT, text, flag.index + 1)) {
    // `-u`'s lookahead reads the rest of its word for a colon.
    if (!SECRET_RUN_FLAG.test(flag[0])) {
      BLANK.lastIndex = flag.index;
      scanned += (BLANK.exec(text)?.index ?? text.length) - flag.index;
      if (over()) return overflowed(found);
    }
    flags.push({ at: flag.index, end: flag.index + flag[0].length, value: /** @type {any} */ (false), added: false });
  }
  // Each flag the line's search finds (they do not overlap) takes the first flag from it whose value has no line break
  // in it, itself or one after: an unanchored regex read them so. Each flag's value is read and kept once.
  let next = 0;
  let end = 0;
  for (const flag of flags) {
    if (flag.at < end) continue;
    end = flag.end;
    while (next < flags.length && flags[next].at < flag.at) next++;
    for (; next < flags.length; next++) {
      const one = flags[next];
      if (one.value === false) one.value = flagOpens(text.slice(one.at), unbroken - one.at);
      if (over()) return overflowed(found);
      if (one.value === undefined) continue;
      if (!one.added) add(one.value);
      one.added = true;
      break;
    }
  }
  // A flag inside the word before it is text, and the first that opens holds the rest of the line, so each character
  // is scanned once.
  let past = 0;
  for (const at of passwordFlags(text)) {
    if (at < past) continue;
    const value = text.slice(at);
    const word = wordOpens(value);
    if (word) { found.push(word); break; }
    past = at + wordScan(value).end;
  }
  return readings(...found);
}

/** How many characters opens reads from its secrets' values on one line before it overflows. */
const MAX_OPENS_WORK = 4 * MAX_INSPECTION;
/** The readings found so far, set to overflow; a bracket left open when none was. @param {Parameters<typeof readings>} found */
const overflowed = (found) => ({ ...(readings(...found) ?? { open: ["["], shell: false, loose: false, alts: [] }), overflow: true });

/**
 * The commands that take a password in a short flag, as RULES redacts them, and its letters: `mysql -p`, `mongo -p`,
 * `sshpass -p`, `redis-cli -a`, `zip -P`, `ldapsearch -w`, `sqlcmd -P`. The flags are not secret names, so FLAG_NAME
 * has none of them (`mkdir -p`, `git commit -a`).
 */
const PASSWORD_COMMANDS = /** @type {[RegExp, string][]} */ ([
  [/^(?:mysql|mysqldump|mysqladmin|mariadb|sshpass|mongo|mongosh)$/, "p"],
  [/^redis-cli$/, "a"],
  [/^(?:zip|7z|7za|7zz)$/, "pP"],
  [/^ldap(?:search|add|modify|delete|passwd|whoami)$/, "w"],
  [/^sqlcmd$/, "P"],
]);
// A shell word is read whole, its closed quotes in it: `-e "select 1;"` ends no segment, `'mysql -p'` gives no flag,
// and `"mysql"` or `/usr/bin/m"ysql"` is the command. A quote has no escapes, so one that never closes is scanned to
// the end once, not once per quote.
// A short flag takes its attached value with it (`-e"select 1;"`), so the value's `;` ends nothing either. A double
// quote holding a command (`"$(mysql -p…`, a backtick) runs it, so it is not read past: the scan goes on inside it.
const PASSWORD_TOKEN =
  /\s-([A-Za-z])(?:[\w./-]|"(?:[^"$`]|\$(?!\())*"|'[^']*')*|(?<![^\s;&|(`])((?:[\w./-]|"(?:[^"$`]|\$(?!\())*"|'[^']*')+)|[;&|]/g;

/**
 * Where a password-flag command gives its password on a line: where each such flag's value starts (`-p"open…`,
 * `-a 'open…`). A flag counts after any command it belongs to earlier in its pipeline segment, so a command's
 * name as an argument (`mysql -h redis-cli -p`) adds a reading and takes none away. One pass, and `letters` holds each
 * letter once.
 * @param {string} text
 */
function passwordFlags(text) {
  const found = [];
  let letters = "";
  for (const token of text.matchAll(PASSWORD_TOKEN)) {
    if (token[2]) {
      const name = token[2].replace(/["']/g, "").split("/").pop() ?? "";
      for (const letter of PASSWORD_COMMANDS.find(([command]) => command.test(name))?.[1] ?? "") {
        if (!letters.includes(letter)) letters += letter;
      }
    } else if (!token[1]) letters = "";
    else if (letters.includes(token[1])) {
      let at = (token.index ?? 0) + 3;
      while (text[at] === " " || text[at] === "\t") at++;
      found.push(at);
    }
  }
  return found;
}

/** Where each secret is given a value on a line (opens). */
const SECRET_NAME_AT = new RegExp(`${NAME_RUN}["']?\\s*[:=]`, "gi");
const SECRET_FLAG_AT = new RegExp(`(?:^|[\\s;&|])(?:${FLAG_NAME})${FLAG_SEP}\\S`, "gi");

/** @typedef {{ open: string[], shell: boolean, loose?: boolean }} Reading */

/**
 * The readings of a value still open, first one leading: `{ open, shell, loose, alts }`, or null when none is.
 * Duplicates dropped; past MAX_READINGS the rest are dropped and `overflow` is set (redactLines then holds the log).
 * @param {...({ open: string[], shell: boolean, loose?: boolean, alts?: Reading[], overflow?: boolean } | null)} results
 */
function readings(...results) {
  const seen = new Set();
  const unique = results
    .flatMap((one) => (one ? [{ open: one.open, shell: one.shell, loose: Boolean(one.loose) }, ...(one.alts ?? [])] : []))
    .filter((one) => {
      const key = JSON.stringify([one.open, one.shell, Boolean(one.loose)]);
      return seen.has(key) ? false : (seen.add(key), true);
    });
  if (!unique.length) return null;
  const overflow = unique.length > MAX_READINGS || results.some((one) => one?.overflow);
  const [first, ...alts] = /** @type {Reading[]} */ (unique.slice(0, MAX_READINGS));
  return { open: first.open, shell: first.shell, loose: Boolean(first.loose), alts, ...(overflow ? { overflow } : {}) };
}
const MAX_READINGS = 64;
/**
 * Once a line has more readings open than MAX_READINGS, the rest of the log stays redacted: a dropped reading may be
 * the real one, and no count of lines bounds how long it stays open.
 */
const OVERFLOW_HOLD = Number.MAX_SAFE_INTEGER;
/** How deep lineOut's shadow states (a line read without the open readings) nest before the log is held. */
const MAX_SHADOWS = 4;

/**
 * One reading of an open value over the next line: the contexts still open, or null, and the text after where it
 * closed, to read for the next value.
 * @param {string} bare @param {Reading} reading
 */
function step(bare, reading) {
  const top = reading.open.at(-1);
  if (top === "\\_") {
    // A secret flag continued before its value (`--user\`): blanks then the value word, as Bash joins it.
    const text = bare.replace(/^[ \t]+/, "");
    return { ...reading, open: /^\\\s*$/.test(text) ? ["\\_"] : wordScan(text).open, rest: text };
  }
  if (top === "\\" || top === "\\$") {
    // A line continuation: this line is the same word, and may carry it on again or open its quotes.
    const lead = top === "\\$" ? "$" : "";
    const word = wordScan(`${lead}${bare}`);
    return { ...reading, open: word.open, rest: `${lead}${bare}` };
  }
  const { open, end } = scan(bare, reading.open, reading.shell, reading.loose);
  if (open.length) return { ...reading, open, rest: "" };
  // A shell word goes on after its closing quote (`end"'second…`): still the same value.
  const after = reading.shell ? wordScan(bare.slice(end)).open : null;
  return { ...reading, open: after, rest: bare.slice(end) };
}

/**
 * A flag's value at the start of `text`: the contexts it leaves open, null when it closes, or undefined when no flag's
 * value starts there or it has a line break in it (before `broken`).
 * @param {string} text @param {number} [broken]
 */
function flagOpens(text, broken = 0) {
  const match = headMatch(SECRET_FLAG_HEAD, text, broken);
  return match ? wordOpens(text.slice(match[0].length)) : undefined;
}

/**
 * What a sticky head regex matches at the start of `text`, its length charged to opens' budget (a YAML tag's run, `!…`,
 * is the rest of its word), or null when its value has a line break in it (before `broken`).
 * @param {RegExp} head @param {string} text @param {number} broken
 */
function headMatch(head, text, broken) {
  const match = flagExec(head, text, 0);
  if (match) scanned += match[0].length;
  return match && match[0].length >= broken ? match : null;
}
const BLANK = /\s/g;
/** FLAG_NAME's first alternative, a secret's name: a flag it does not match took the second, `-u`'s lookahead. */
const SECRET_RUN_FLAG = new RegExp(`^(?:^|[\\s;&|])-{1,2}${SECRET_RUN}${FLAG_SEP}\\S`, "i");

/** A flag's value word, from its start: the contexts it leaves open, or null. @param {string} value */
function wordOpens(value) {
  // `--user\` or `--user \`: the value is on the next line, after any blanks there.
  if (/^\\\s*$/.test(value)) return { open: ["\\_"], shell: true };
  const word = wordScan(value);
  return word.open ? { open: word.open, shell: true } : null;
}

/**
 * One secret's value at the start of `text`, read as shell (`byShell`, for `=`) or as data, and in data with a `#`
 * read both as a comment wherever it stands (Python, TOML) and only after a blank or `,` `[` `{` `(` (YAML), on this
 * line and the ones after it.
 * @param {string} text @param {boolean} byShell @param {number} [broken] where `text` is past its last line break
 */
function assignOpens(text, byShell, broken = 0) {
  const match = headMatch(SECRET_OPEN_HEAD, text, broken);
  if (!match) return null;
  const shell = byShell && match[2] === "=";
  let value = text.slice(match[0].length);
  // A Python string prefix (`r"""`, `b'`, `f"`) is part of the opening quote in data.
  if (!shell) value = value.replace(/^[rRbBuUfF]{1,2}(?=["'])/, "");
  const lead = /^[[{]/.test(value) ? /** @type {[string, number]} */ ([value[0], 1]) : shell ? null : opensAt(value, 0, true);
  if (lead) {
    const [context, width] = lead;
    const sh = shell || context === "(" || context === "`";
    const ways = sh ? [false] : [false, true];
    return readings(
      ...ways.map((loose) => {
        const { open, end } = scan(value.slice(width), [context], sh, loose);
        if (open.length) return { open, shell: sh, loose };
        // A shell word goes on after it (`[a]"b…`).
        const word = shell ? wordScan(value.slice(width + end)).open : null;
        return word ? { open: word, shell } : null;
      }),
    );
  }
  if (!shell) return null;
  const word = wordScan(value).open;
  return word ? { open: word, shell } : null;
}

/**
 * The block a header line opens: its value on the lines under it; under a block scalar (`|`, `>`) its quotes are text.
 * @param {string} bare the line @param {RegExpExecArray} header what SECRET_HEADER matched: its block indicator, if any, is
 * `header[2]` (a second scan of the header, unanchored, was quadratic in a long run of tags)
 */
/**
 * The readings a value opening on the line under its secret's name leaves open (`credentials:` then `  r"""…`,
 * `  [], password: [`): the line read as if written after the name.
 * @param {string} value the line, its indent trimmed
 */
const valueOpens = (value) => opens(`password: ${value}`);

const headerState = (bare, header) => ({ indent: indentOf(bare), first: true, ...(header[2] ? { block: true } : {}) });
/**
 * A run of non-blanks around a cut is read as a URL when it may hold an `@` after the cut or a `/` before it, written
 * or escaped: every escape (`\x40`, `%40`, `&#64`, `\U00000040`, layered too) needs a `\`, `%` or `&`, so those read
 * as one, rather than a list of spellings a new one gets past.
 */
const AT_AFTER = /[@\\%&]/;
const URL_BEFORE = /[/\\%&]/;
/**
 * The line with a secret's value after its name dropped. A name inside a URL's password (`u:pwTOKEN=x@h`) cuts the
 * URL's `@` away, and the URL rule could no longer see the password before it: when the cut's run of non-blanks reads
 * as a URL (`AT_AFTER`, `URL_BEFORE`), the line is cut at that run's start instead.
 * @param {string} bare @param {string} home @param {number} [max]
 */
const nameOnly = (bare, home, max) => {
  const named = bare.replace(SECRET_VALUE, "$1 [redacted]");
  // The first flag with no line break after its value's first character: its value runs to the text's end.
  let broken = -1;
  for (const one of named.matchAll(DOT_BREAK)) broken = one.index;
  let flag = flagExec(SECRET_FLAG_VALUE, named);
  while (flag && flag.index + flag[0].length <= broken) flag = flagExec(SECRET_FLAG_VALUE, named, flag.index + 1);
  const cut = flag ? `${named.slice(0, flag.index)}${flag[1]} [redacted]` : named;
  const out = redactLine(cut, home, max);
  if (cut === bare || out === "[redacted]") return out;
  const kept = cut.length - " [redacted]".length;
  // Found by a walk each way from the cut: a regex search back for the run's start was quadratic on a long line.
  let start = kept;
  while (start > 0 && !/\s/.test(bare[start - 1])) start -= 1;
  let end = kept;
  while (end < bare.length && !/\s/.test(bare[end])) end += 1;
  if (!AT_AFTER.test(bare.slice(kept, end)) && !URL_BEFORE.test(bare.slice(start, kept))) return out;
  return redactLine(`${bare.slice(0, start)}[redacted]`, home, max);
};
/** Every line break sanitizeLine folds into one line: split here first, so a value past one is on its own line. */
const BREAKS = /\r\n|[\r\v\f\x85\u2028\u2029]/;
/** Lines a log keeps redacted after a secret's value that a plain count says is unbalanced (redactLines). */
const HOLD_LINES = 30;

/**
 * A secret given a value on this line, with an odd quote or backtick, more openers than closers, or a trailing
 * backslash after its separator (also with a `#` comment dropped), or quoting mixed with nesting, a comment or `$`. A
 * plain count, no grammar: the floor under the parser.
 * @param {string} bare
 */
function unbalancedValue(bare) {
  const at = flagExec(SECRET_ASSIGN, bare);
  // The first password-flag command's value counts too (`mysql -p"open`).
  const flag = passwordFlags(bare)[0];
  if (!at && flag === undefined) return false;
  const values = flag === undefined ? [] : [bare.slice(flag)];
  const odd = (/** @type {string} */ text) => {
    const n = (/** @type {RegExp} */ re) => (text.match(re) ?? []).length;
    return n(/"/g) % 2 === 1 || n(/'/g) % 2 === 1 || n(/`/g) % 2 === 1 || n(/\[/g) > n(/]/g) || n(/\{/g) > n(/}/g) || n(/\(/g) > n(/\)/g) || /\\$/.test(text);
  };
  // From the separator on (a flag's match ends on its value's first character): the key's own quote is not counted.
  if (at) values.unshift(bare.slice(at.index + at[0].length - (/[:=]$/.test(at[0]) ? 0 : 1)));
  // Quotes with nesting, a comment or `$`, or a backslash, backtick or triple quote: a closer inside a string can balance
  // the count (`["a]",# ]`), so any mix a parser could misread holds too.
  return values.some((value) => {
    const kinds = [/["']/, /[[{(]/, /#/, /\$/].filter((re) => re.test(value)).length;
    return odd(value) || odd(value.replace(/#.*$/, "")) || kinds >= 2 || /[\\`]|"""|'''/.test(value);
  });
}
const FENCE = /^ *(`{3,}|~{3,})/;
/** A closing fence: the fence alone on its line (a fence with text after it is content). */
const FENCE_CLOSE = /^ *(`{3,}|~{3,}) *$/;
// C0, DEL and C1: the controls `CONTROLS` has besides the bidi ones, which are invisible characters.
const C0_C1 = /[\x00-\x1f\x7f-\x9f]/g;
// What a line shows, indentation kept: no escape sequences or controls to hide where it starts. Invisible characters,
// the bidi controls among them, stay as a word's end for the readings to take.
/** @param {string} line */
export const shown = (line) => line.replace(ESC_SEQ, "").replace(/\t/g, " ").replace(C0_C1, "");
/** @param {string} line */
const indentOf = (line) => /^ */.exec(line)?.[0].length ?? 0;

/**
 * Redacts a block of lines. A private key body sits on its own lines between the
 * BEGIN and END markers, so everything inside is dropped as one. Under a line
 * ending in a secret's name with no value (`password:`), the next line that
 * shows anything is its value, whatever its indentation, and so is every line
 * indented deeper than that name's line; blank lines between are kept blank.
 * A value left open by its quotes, brackets or `$(` goes until they all close (`scan`), a fenced one to its closing
 * fence. `state` carries an open block from one read to the next. With `rest` (one message, not a log), everything
 * from a secret's value on is dropped: no guess at where the value ends.
 * @param {string[]} lines
 * @param {{ inKey: boolean, rest?: boolean, continuation?: string, continuing?: boolean, pieces?: string[], alts?: any[], forms?: Record<string, any>, secret?: { indent: number, first: boolean, block?: boolean, list?: boolean, fence?: string, open?: string[], shell?: boolean } | null }} [state]
 * @param {string} [home]
 * @param {{ rest?: boolean, max?: number }} [options] max: each line's output length, MAX_LOG_LINE by default
 */
export function redactLines(lines, state = { inKey: false }, home = homedir(), options = {}) {
  const written = lines.flatMap((one) => one.split(BREAKS));
  // Each other reading (`readings`) is a whole parser state of its own, in `state.forms`, copied once a read as `alts`
  // is. One starts from this reading's state before the read, the first time a read has a line it reads differently,
  // and ends once it is back in this one's state with nothing held. A line it shows differently goes whole, and every
  // line when the two do not keep the same lines. Lines are matched by where they were written, not where they are
  // shown: a line one reading drops (a private key's body, a continued line) is not compared with the next line it shows.
  /** @type {Record<string, any>} */
  const forms = structuredClone(state.forms ?? {});
  const { forms: _forms, ...before } = state;
  const runs = Object.entries(FORM_READINGS).flatMap(([name, take]) => {
    const texts = written.map(take);
    if (!forms[name] && texts.every((text, i) => text === written[i])) return [];
    if (!forms[name]) {
      const form = structuredClone(before);
      if (form.continuation) form.continuation = take(form.continuation);
      if (form.pieces) form.pieces = form.pieces.map(take);
      forms[name] = form;
    }
    return [{ name, texts }];
  });
  const out = linesOut(written, state, home, options);
  for (const { name, texts } of runs) {
    const form = forms[name];
    const theirs = linesOut(texts, form, home, options);
    for (const [i, line] of out.entries()) {
      if (line === null) continue;
      // A line this reading shows and the other drops is inside what the other holds.
      if (theirs.length !== out.length || theirs[i] === null || shownAs(theirs[i]) !== shownAs(line)) out[i] = "[redacted]";
    }
    if (form.rest) state.rest = true;
    if (form.overflow) {
      state.overflow = true;
      state.hold = Math.max(state.hold ?? 0, OVERFLOW_HOLD);
    }
    const held = form.continuation || form.pieces?.length || JSON.stringify(form.alts ?? []) !== JSON.stringify(state.alts ?? []);
    if (held || parsed(form) !== parsed(state)) forms[name] = form;
    else delete forms[name];
  }
  // Never deleted: a caller commits a read by copying its fields back, and a deleted field is not one.
  state.forms = Object.keys(forms).length ? forms : undefined;
  return /** @type {string[]} */ (out.filter((line) => line !== null));
}

/** The readings beside the line as written, every one `readings` makes. @type {Record<string, (text: string) => string>} */
const FORM_READINGS = { plain, boundaried, unfolded, joined: (text) => padded(text, "") };

/**
 * redactLines in one reading: what each line as written shows, null for one it drops or holds.
 * @param {string[]} lines @param {any} state @param {string} home @param {{ rest?: boolean, max?: number }} options
 * @returns {(string | null)[]}
 */
function linesOut(lines, state, home, options) {
  /** @type {(string | null)[]} */
  const out = [];
  const max = options.max ?? MAX_LOG_LINE;
  // Copied once a read and never changed in place: a caller retries a failed read from a shallow copy of the state.
  /** @type {any[]} */
  let alts = (state.alts ?? []).map((/** @type {any} */ one) => structuredClone(one));
  /** @type {string[]} */
  const pieces = [...(state.pieces ?? [])];
  for (let line of lines.flatMap((one) => one.split(BREAKS))) {
    // Withhold physical continuations until the whole logical line is known,
    // including across batches. Publishing even a short prefix leaks fragments.
    line = shown(line);
    const physical = line;
    if (state.continuation) line = state.continuation + line;
    state.continuation = "";
    if (line.endsWith("\\")) {
      if (line.length > MAX_INSPECTION) {
        state.overflow = true;
        out.push("[redacted]");
        pieces.length = 0;
      } else {
        state.continuation = line.slice(0, -1);
        // A backslash alone has nothing to read on its own.
        if (physical.length > 1) pieces.push(physical.slice(0, -1));
        state.continuing = true;
      }
      state.pieces = pieces;
      // The live-log reader recognizes hold as protected state and preserves
      // its cursor on a failed read. Release this temporary hold on completion.
      if (!state.hold) { state.hold = 1; state.continuationHold = true; }
      if (line.length <= MAX_INSPECTION) out.push(null);
      continue;
    }
    if (line.length > MAX_INSPECTION && state.continuing) state.overflow = true;
    state.continuing = false;
    if (state.continuationHold) {
      state.hold = Math.max(0, (state.hold ?? 0) - 1);
      state.continuationHold = false;
    }
    const parts = [...pieces, physical].filter(Boolean);
    // Each physical line with its continuation kept, for the continued readings: the parser carries a flag or word on over
    // it (`--password \` then `$\` then `'open`, `--password foo\` then `'open`).
    const written = [...pieces.map((piece) => `${piece}\\`), physical].filter(Boolean);
    pieces.length = 0;
    state.pieces = pieces;
    // Other readings run beside this one (`alts`), at most one of each kind, each a whole parser state of its own: the
    // line with the marks in a secret's key taken out (two ways: `unmark`, `unmarkQuoted`), a continued line read one
    // physical line at a time (joining takes a word boundary away: `prefix\` then `Bearer x`), its continuations kept
    // or not, or joined with a space
    // where each break was (a flag's value on the next physical line: `--password \` then `"open`), each with its
    // marks taken out too. A kind with no reading of its own is in the state of the one it reads as until it reads a
    // line differently (a physical or spaced kind as its joined kind, the rest as this one), and starts from that state
    // then. A line any of them shows differently goes whole.
    const physicals = parts.length ? parts : [line];
    const continued = physicals.length > 1;
    const texts = Object.fromEntries(Object.entries(MARKS).map(([mark, take]) => [mark, take(line)]));
    const before = alts.length || continued || texts.unmark !== line || texts.quoted !== line ? reading(state) : null;
    const own = new Map(alts.map((alt) => [alt.via, alt]));
    /** @type {any[]} */
    const next = [];
    for (const mark of Object.keys(MARKS)) {
      const joined = mark === "raw" ? null : (own.get(mark) ?? (texts[mark] !== line ? { ...structuredClone(before), via: mark } : null));
      if (joined) next.push(joined);
      for (const split of SPLITS) {
        const alt = own.get(`${split} ${mark}`) ?? (continued ? { ...structuredClone(joined ?? before), via: `${split} ${mark}` } : null);
        if (alt) next.push(alt);
      }
    }
    const one = readLine(line, state, home, options);
    let hide = readsTwoWays(line);
    // No reading has that line's word ends, so none knows what it opens on the lines after it.
    if (hide) state.rest = true;
    // Readings in the same state reading the same text are read once.
    const done = new Map();
    for (const [i, alt] of next.entries()) {
      const [split, mark] = alt.via.includes(" ") ? alt.via.split(" ") : [null, alt.via];
      if (split && continued) {
        // A physical line the redactor changes, read alone or spaced, may hold a secret.
        const take = MARKS[mark];
        const texts = split === "physical" ? physicals : split === "continued" ? written : [physicals.join(" ")];
        for (const text of texts.map(take)) {
          if (readLine(text, alt, home, options) !== clipUnits(display(text, home, max), max)) hide = true;
        }
        continue;
      }
      const key = `${parsed(alt)}\n${texts[mark]}`;
      if (!done.has(key)) done.set(key, { out: readLine(texts[mark], alt, home, options), after: reading(alt) });
      else next[i] = { ...structuredClone(done.get(key).after), via: alt.via };
      if (done.get(key).out !== one) hide = true;
    }
    const main = parsed(state);
    const after = new Map(next.map((alt) => [alt.via, parsed(alt)]));
    alts = next.filter((alt) => {
      if (!alt.via.includes(" ")) return after.get(alt.via) !== main;
      const joined = after.get(alt.via.split(" ")[1]);
      return after.get(alt.via) !== (joined !== undefined && joined !== main ? joined : main);
    });
    if (state.overflow) {
      state.hold = Math.max(state.hold ?? 0, OVERFLOW_HOLD);
      alts = [];
    }
    state.alts = alts;
    out.push(one === null ? null : hide ? "[redacted]" : one);
  }
  return out;
}

/** How each kind of reading takes a line's marked keys. @type {Record<string, (line: string) => string>} */
const MARKS = {
  raw: (line) => line,
  unmark: (line) => unmark(line),
  quoted: (line) => unmarkQuoted(line),
  // Each way on its own, with a backtick opening a value kept: read one after the other, the second would take out
  // the backtick the first kept (`**password:**` then a backtick and `token:open`), and a first finding a key would
  // stop the second reading another (`**token**: ok; "**password**"":**` then a backtick).
  opened: (line) => unmark(line, true),
  openedQuoted: (line) => unmarkQuoted(line, true),
  // A quote in a code span closing at that backtick: the span as a label's (`opening`).
  labelled: (line) => unmark(line, "label"),
  labelledQuoted: (line) => unmarkQuoted(line, "label"),
};
/**
 * How the other readings take a continued line's physical lines: one at a time, one at a time with each continuation
 * kept (the parser carrying a word over it), or joined with a space.
 */
const SPLITS = ["physical", "continued", "spaced"];
/** A reading's parser state, without the other readings or a continued line's physical lines. @param {any} state */
const reading = ({ alts: _alts, pieces: _pieces, forms: _forms, ...rest }) => structuredClone(rest);
/**
 * What a reading carries to its next line, to tell two apart: its whole parser state, unset and empty fields alike.
 * @param {any} state
 */
const parsed = ({ alts: _alts, pieces: _pieces, forms: _forms, via: _via, continuation: _continuation, continuing: _continuing, continuationHold: _held, ...rest }) =>
  JSON.stringify(Object.entries(rest).filter(([, value]) => value !== undefined && value !== null && value !== false && value !== 0 && value !== "").sort(([a], [b]) => (a < b ? -1 : 1)));

/**
 * One logical line through one reading: what it shows, or null for a line of a private key (dropped).
 * @param {string} line @param {any} state @param {string} home @param {{ rest?: boolean, max?: number }} options
 */
function readLine(line, state, home, options) {
  const holding = (state.hold ?? 0) > 0;
  const one = lineOut(line, state, home, options);
  if (holding && shown(line).trim()) state.hold -= 1;
  // A log (not one message): a secret's value with an unbalanced quote or bracket by a plain count holds the next
  // HOLD_LINES lines redacted, whatever the parser decided about where it ends.
  if (!state.overflow && !options.rest && unbalancedValue(shown(line))) state.hold = Math.max(state.hold ?? 0, HOLD_LINES);
  if (state.secret?.overflow) state.overflow = true;
  if (state.overflow) state.hold = Math.max(state.hold ?? 0, OVERFLOW_HOLD);
  return one === null ? null : holding && one.trim() ? "[redacted]" : one;
}

/** @param {unknown} v */
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Whether anything is open in any reading or form of a redactor state (`redactLines`): a key, value, block or hold,
 * the rest of the text hidden, a continued line or an overflow.
 * @param {any} state
 */
export const valueOpen = (state) => {
  const forms = Object.values(state.forms ?? {}).flatMap((/** @type {any} */ form) => [form, ...(form.alts ?? [])]);
  return [state, ...(state.alts ?? []), ...forms].some((one) =>
    Object.entries(one).some(([key, value]) => key !== "alts" && key !== "forms" && (Array.isArray(value) ? value.length > 0 : Boolean(value))),
  );
};

/** A state read with its keys in order and its holds left out. @param {unknown} state @returns {string} */
export const bare = (state) =>
  Array.isArray(state)
    ? `[${state.map(bare).join(",")}]`
    : isRecord(state)
      ? `{${Object.keys(state).filter((key) => key !== "hold" && key !== "continuationHold" && state[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${bare(state[key])}`).join(",")}}`
      : JSON.stringify(state);
/** Whether a line starts at column 0 in every reading: an invisible character before an indent starts no new line. @param {string} line */
export const column0 = (line) => /^\S/.test(shown(line)) && /^\S/.test(plain(shown(line)));

/**
 * Where a read whose top was cut (a screen, a terminal's last lines) may start to be shown: its first line past the top
 * that starts at column 0, or its length when none does. What is above may be inside something whose header was cut
 * off, and its top line may end a value begun above, even at column 0, so it is never shown.
 * @param {string[]} lines
 */
export function heldTo(lines) {
  const from = lines.findIndex((line, i) => i > 0 && column0(line));
  if (from < 0) return lines.length;
  // A line at column 0 may still be inside a quoted value opened above it (`KEY="…` over several lines): the first line
  // from there with an odd count of double quotes may be that value's close, so the lines through it are held too, and
  // the same for single quotes, `"""` and `'''`; the latest of them, as each may be a literal inside a value of
  // another kind. One that looks like it opens a value (`NAME="hello`) may close one too, the rest a word the quote
  // ends, so it counts. A value may also change quote kind on the way (`"…"'…'`), which no count of one kind sees, so
  // the lines are read through from inside each kind too (`closeFrom`), and the latest close of all is held through.
  const closeOf = (/** @type {(line: string) => boolean} */ odd) => lines.findIndex((line, i) => i >= from && odd(line));
  const counted = [oddDouble, oddLoneSingle, oddSingle, oddTripleDouble, oddTripleSingle].map(closeOf);
  const close = Math.max(...counted, ...['"', "'", '"""', "'''"].map((open) => closeFrom(lines, from, open)));
  if (close < 0) return from;
  const after = lines.findIndex((line, i) => i > close && column0(line));
  return after < 0 ? lines.length : after;
}

/** A line without what a backslash escapes. @param {string} line */
const unescaped = (line) => shown(line).replace(/\\[\s\S]/g, "");
/** Whether a line has an odd count of double quotes, a backslash's next character not counted. @param {string} line */
const oddDouble = (line) => (unescaped(line).match(/"/g)?.length ?? 0) % 2 === 1;
/**
 * An apostrophe as prose writes one in a word (`it's`, `Sam's`, `don't`, `we'll`, `O'Brien`, `o'clock`, `y'all`,
 * `ma'am`): no quote to a hold, or every screen of a chat's prose would be held. One in any other word (`green'tail`)
 * may close a single-quoted value.
 */
const PROSE_APOSTROPHE = /(?<=\w)'(?=(?:s|t|d|m|re|ve|ll)(?!\w))|(?<=\b[do])'(?=[a-z])|(?<=\by)'(?=all\b)|(?<=\bma)'(?=am\b)/gi;
/** Whether a line has an odd count of single quotes not within a word (`it's`), as `oddDouble`. @param {string} line */
const oddLoneSingle = (line) => (unescaped(line).match(/(?<!\w)'|'(?!\w)/g)?.length ?? 0) % 2 === 1;
/**
 * Whether a line has an odd count of single quotes, prose's apostrophes not counted, as `oddDouble`: beside
 * `oddLoneSingle`, as counting more quotes may shift which line is odd. @param {string} line
 */
const oddSingle = (line) => (unescaped(line).replace(PROSE_APOSTROPHE, "").match(/'/g)?.length ?? 0) % 2 === 1;
/** Whether a line has an odd count of `"""`, as `oddDouble`. @param {string} line */
const oddTripleDouble = (line) => (unescaped(line).match(/"""/g)?.length ?? 0) % 2 === 1;
/** Whether a line has an odd count of `'''`, as `oddDouble`. @param {string} line */
const oddTripleSingle = (line) => (unescaped(line).match(/'''/g)?.length ?? 0) % 2 === 1;

/**
 * The first line from `from` that ends outside every quote, read as begun above inside an `open` quote, or -1 when none
 * does: as `oddDouble` and the rest for one kind, but read through every quote, so a value that changes kind on the way
 * (`"…"'…'`) is still open where a count of one kind closes it. `"` and `'` are read as a shell reads them, a backslash
 * escaping in a double-quoted part and outside but not in a single-quoted one; `"""` and `'''` as Python reads them, a
 * backslash escaping in every part. Prose's apostrophes are no quote (`PROSE_APOSTROPHE`).
 * @param {string[]} lines @param {number} from @param {string} open
 */
function closeFrom(lines, from, open) {
  const python = open.length === 3;
  /** @type {string | null} */
  let inside = open;
  for (let i = from; i < lines.length; i++) {
    const line = shown(lines[i]);
    const prose = new Set([...line.matchAll(PROSE_APOSTROPHE)].map((match) => match.index));
    for (let j = 0; j < line.length; j++) {
      if (inside) {
        if (line[j] === "\\" && (python || inside !== "'")) j += 1;
        else if (line.startsWith(inside, j) && !prose.has(j)) {
          j += inside.length - 1;
          inside = null;
        }
      } else if (line[j] === "\\") j += 1;
      else {
        const triple = python && ["'''", '"""'].find((mark) => line.startsWith(mark, j));
        const quote = triple || (line[j] === '"' || (line[j] === "'" && !prose.has(j)) ? line[j] : null);
        if (quote) {
          j += quote.length - 1;
          inside = quote;
        }
      }
    }
    if (!inside) return i;
  }
  return -1;
}

// An IPv6 address ending in a dotted IPv4 address (`::ffff:192.0.2.1`), covered whole before either form alone.
const IPV6_V4 = /(?<![\w:.])(?:[0-9a-f]{0,4}:){2,6}(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\w|\.\d)/gi;
const IPV4 = /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\w|\.\d)/g;
const IPV6 = /(?<![\w:])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){7}|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?)(?![\w:])/gi;
/** @param {string} text */
const coverIps = (text) => text.replace(IPV6_V4, "[redacted-ip]").replace(IPV4, "[redacted-ip]").replace(IPV6, (ip) => (ip === "::" ? ip : "[redacted-ip]"));
/** Two words joined that name a secret's key (`password:`, `"api_token" =`, a key in backticks). */
const WRAPPED_KEY = new RegExp(`(?<![A-Za-z0-9_.-])${NOT_PROSE}${SECRET_NAME}["'*\`]*\\s*[:=]`, "i");
/**
 * Words that may hold the part of a token or address whose other part was redacted on the next or last line: one
 * ending in any of their characters but a colon, unless it ends in two as an IPv6 address may (so a word naming a key
 * is not one, though a quote or key may come before), and one beginning with any of them (whatever closes it, a
 * quote, comma or full stop).
 * @param {string} word
 */
const headOf = (word) => /[\w+/=~.@-]$/.test(word) || /[0-9a-f]{0,4}:[0-9a-f]{0,4}:$/i.test(word);
/** @param {string} word */
const restOf = (word) => /^[\w+/=~.:-]/.test(word);

/**
 * The lines sent, with what the redactor cannot see in one line covered too, each line within MAX_LOG_LINE: an IP
 * address, whole or wrapped onto the next line, and a token the terminal wrapped onto the next line, each part too
 * short to look like one (a wrapped line's last word joined to the next line's first word reads as a token), or the
 * rest of one whose other part was redacted.
 * @param {string[]} lines @param {string} [home] @param {{ open: boolean } | null} [cover]
 * @param {string[] | null} [raw] the lines as the terminal showed them, before the redactor
 * @param {{ rest?: boolean }} [options] `rest`: one message (`redactLines`'s rest mode), so from a secret's name the
 * terminal wrapped, every row below it goes too
 */
export function coverLines(lines, home, cover = null, raw = null, options = {}) {
  const out = lines.map(coverIps);
  for (let i = 0; i + 1 < out.length; i++) {
    const last = /\S+$/.exec(out[i]);
    const first = /^\S+/.exec(out[i + 1]);
    if (!last || !first) continue;
    const joined = last[0] + first[0];
    let marks = null;
    // A marker may hold spaces ("[redacted api key]"), so the line's end is read, not its last word.
    if (/\[redacted[^\]]*\]$/.test(out[i])) {
      if (restOf(first[0])) marks = [last[0], "[redacted]"];
    } else if (/^\[redacted/.test(first[0])) {
      if (headOf(last[0])) marks = ["[redacted]", first[0]];
    } else if (coverIps(joined) !== joined) marks = ["[redacted-ip]", "[redacted-ip]"];
    else {
      // The two rows read as one: a secret's name wrapped onto the next row may begin a value that runs on past its
      // first word, and then all of that row goes.
      const both = out[i] + out[i + 1];
      const shown = redactLine(both, home);
      if (shown !== both) marks = ["[redacted]", redactLine(joined, home) !== joined && shown.endsWith(out[i + 1].slice(first[0].length)) ? "[redacted]" : null];
    }
    {
      // A secret's name wrapped within it may open a value the rows below hold, whether or not the two rows show part
      // of it: where they read as one open what they do not read apart, the rows below are read as following them
      // too, and what that changes goes. A value still open at the end is told to the reader (`cover.open`), so the
      // next read is held as for any value open.
      // They are read as the terminal showed them (`raw`, indents and all), and a row below read otherwise as following
      // them goes whole.
      const rawRows = raw && raw.length === out.length ? raw : out;
      // In one message a secret's key the wrap split (`pass` / `word: …`, `password` / ` : …`) may run its value on
      // below, whatever a marker took of either row: from it, all of that goes. The key is read in the rows as shown,
      // before any marker, joined across the spaces at the wrap.
      const rawJoined = rawRows[i].trimEnd() + rawRows[i + 1].trimStart();
      if (options.rest && WRAPPED_KEY.test(rawJoined) && !WRAPPED_KEY.test(rawRows[i]) && !WRAPPED_KEY.test(rawRows[i + 1])) {
        marks = ["[redacted]", null];
        for (let j = i + 2; j < out.length; j++) out[j] = "[redacted]";
      }
      const together = { inKey: false };
      redactLines([rawRows[i] + rawRows[i + 1]], together, home);
      if (valueOpen(together)) {
        const apart = { inKey: false };
        redactLines([rawRows[i], rawRows[i + 1]], apart, home);
        // This is read beside a marker too: a row a marker took the start of may hold the head of a wrapped name.
        if (bare(together) !== bare(apart)) {
          // A row already taken whole stays whole, and in one message the second row goes whole too.
          marks = ["[redacted]", options.rest || marks?.[1] === null ? null : "[redacted]"];
          const rest = rawRows.slice(i + 2);
          const below = redactLines(rest, together, home);
          const alone = redactLines(rest, apart, home);
          for (let j = 0; j < rest.length; j++) {
            if (options.rest || below.length !== rest.length || alone.length !== rest.length || below[j] !== alone[j]) out[i + 2 + j] = "[redacted]";
          }
          if (cover && valueOpen(together)) cover.open = true;
        }
      }
    }
    if (!marks) continue;
    out[i] = `${out[i].slice(0, last.index)}${marks[0]}`;
    out[i + 1] = marks[1] === null ? "[redacted]" : `${marks[1]}${out[i + 1].slice(first[0].length)}`;
  }
  return out.map((line) => clipUnits(line, MAX_LOG_LINE));
}

/**
 * A read whose top was cut, redacted from a fresh state with the lines above `from` (`heldTo`) read but not shown, so
 * a header among them still hides its value below, and covered (`coverLines`) with the held lines above the shown
 * ones, so a token or address wrapped from a held line onto the first one shown is seen whole. The Live log's first
 * read is held back the same way (`actions/logs.mjs`).
 * @param {string[]} lines @param {string} [home] @param {{ rest?: boolean, max?: number }} [options] @param {number} [from]
 */
export function redactCutTop(lines, home, options = {}, from = heldTo(lines)) {
  const state = { inKey: false };
  const held = redactLines(lines.slice(0, from), state, home, options);
  const out = redactLines(lines.slice(from), state, home, options);
  return coverLines([...held, ...out], home, null, lines, { rest: options.rest }).slice(held.length);
}

/**
 * A text that is shown as one line, redacted: its secrets out across its lines first (a key's value on the lines under
 * it too, and everything after), then again once flattened. redactLine alone joins the lines before it looks. The text
 * is cut to `max` UTF-16 units first: the secret patterns scan in quadratic time on long untrusted input. The output
 * is never clipped (folded line breaks and markers keep it within a small multiple of `max`), so a caller sees every
 * marker redaction wrote and clips to its own length after its checks.
 * @param {string} text
 * @param {number} max
 */
export function redactText(text, max) {
  const cut = text.length > max ? text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "") : text;
  return redactLine(redactLines(cut.split(/\r\n|\r|\n/), { inKey: false }, undefined, { rest: true, max: Infinity }).join("\n"), undefined, Infinity);
}

/**
 * One line of redactLines: what it shows, or null for a line of a private key (dropped).
 * @param {string} line @param {any} state @param {string} home @param {{ rest?: boolean, max?: number }} options
 * @returns {string | null}
 */
function lineOut(line, state, home, options) {
  // An escaped header/value may span later reads. Its original spelling cannot
  // reliably tell the parser where it ends, so retain the hold for this stream.
  const escaped = options.stateOnly ? 0 : inspectEscapes(line, state, home, options);
  // In one message, a secret found only by decoding may have had a key the guard read as prose: the rest goes.
  if (escaped === 2 || (escaped && options.rest)) state.rest = true;
  if (state.rest) return shown(line).trim() ? "[redacted]" : "";
  if (state.inKey) {
    // Read as shown, escapes and controls out, as every other line is.
    const text = shown(line);
    const end = /-----END [A-Z0-9 ]*PRIVATE KEY-----/.exec(text);
    if (end) {
      state.inKey = false;
      // The line goes, but what follows its END is still read (`-----END …-----"; credentials = """`), at the line's
      // own indent: a block it is in goes on.
      const after = text.slice(end.index + end[0].length);
      if (after.trim()) lineOut(`${/^\s*/.exec(text)?.[0] ?? ""}${after}`, state, home, options);
    }
    return null;
  }
  const bare = shown(line);
  // Past what the parser can follow (overflow), or from a secret on in one message (rest), every line goes.
  if (state.rest || state.overflow) {
    return bare.trim() ? "[redacted]" : "";
  }
  // A private key opening under a secret's name is a key block: dropped to its END, however it is indented, and the
  // secret's block (YAML `credentials: |`) still holds the lines indented under the name after it.
  const begins = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(bare) && !/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(bare);
  if (state.secret?.open) {
    // Every reading of the open value goes on over this line; it stays open while any does. A new object, never a
    // change to the old one: a caller may keep a copy of the state to retry a read from.
    const all = [{ open: state.secret.open, shell: Boolean(state.secret.shell), loose: Boolean(state.secret.loose) }, ...(state.secret.alts ?? [])];
    const steps = all.map((reading) => step(bare, reading));
    // The open readings may be wrong about where they are, so the line is also read as if they were not there: by a
    // whole parser state of its own (`shadow`), stepped by lineOut, whose header block, list, fence or value takes
    // over when they close. Shadows nest at most MAX_SHADOWS deep; past that the log is held (overflow).
    const depth = options.depth ?? 0;
    // Never in a key block of its own: a key opening here sets this state's inKey (below), which reads it to its END.
    const shadow = { inKey: false, secret: state.secret.shadow?.secret ?? null };
    if (depth < MAX_SHADOWS) lineOut(line, shadow, home, { ...options, depth: depth + 1 });
    // A reading that closed here may open the next value after it (`end"; TOKEN="`, `end", credentials: [`), while
    // another is still open; a secret given a value anywhere on the line counts too.
    const still = readings(
      ...steps.map((one) => (one.open ? { open: one.open, shell: one.shell, loose: one.loose } : null)),
      ...steps.map((one) => (one.open ? null : opens(one.rest))),
      opens(bare),
    );
    // Overflow is kept on the state itself, so it outlives the readings that set it.
    if (depth >= MAX_SHADOWS || still?.overflow || shadow.overflow || shadow.secret?.overflow) state.overflow = true;
    state.secret = still ? { ...state.secret, ...still, shadow: { inKey: false, secret: shadow.secret } } : shadow.secret;
    // A key opening on the line goes to its END.
    if (begins) state.inKey = true;
    return bare.trim() ? "[redacted]" : "";
  }
  if (state.secret) {
    if (!bare.trim()) {
      return "";
    }
    // A comment before the first value keeps waiting for it.
    if (state.secret.first && /^ *#/.test(bare)) {
      return "[redacted]";
    }
    const fence = state.secret.fence;
    if (fence) {
      // A fenced value goes to its closing fence, however it is indented.
      const close = FENCE_CLOSE.exec(bare)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) state.secret = null;
      return "[redacted]";
    }
    // An indentless YAML list (`credentials:` then `- one` at its indent) is the value too.
    // Comments between its items keep it open.
    const item =
      indentOf(bare) === state.secret.indent &&
      (/^ *-(?: |$)/.test(bare) || (state.secret.list && /^ *#/.test(bare))) &&
      (state.secret.first || state.secret.list);
    if (state.secret.first || item || indentOf(bare) > state.secret.indent) {
      const value = bare.trimStart();
      // A first value opening quotes or brackets goes until they close, however the lines after it are indented.
      // Not under a block scalar (`password: |`): its quotes are only text, its end is its indentation.
      // A value under the name is read as if written after it (valueOpens), and a secret given a value on a line of the
      // block is read too; the block takes over again when they close.
      const opened = state.secret.block ? null : state.secret.first ? valueOpens(value) : opens(bare);
      const fenced = state.secret.first ? FENCE.exec(bare)?.[1] : undefined;
      const block = {
        indent: state.secret.indent,
        first: false,
        list: Boolean(item || state.secret.list),
        ...(fenced ? { fence: fenced } : {}),
        ...(state.secret.block ? { block: true } : {}),
      };
      // A header on a line of the block (`  [], password:`) waits for its value, the block going on around it; so it
      // does when the line opens readings too (`  [], note: "TOKEN='", password:`), once they close.
      // Not in a block scalar or a fence: their text is only text.
      const header = state.secret.block || block.fence ? null : SECRET_HEADER.exec(bare);
      const after = header ? { ...headerState(bare, header), indent: block.indent, list: block.list } : block;
      state.secret = opened ? { ...block, ...opened, shadow: { inKey: false, secret: after } } : after;
      // A key opening on a value line goes to its END; the line itself goes whole, whatever is before the marker.
      if (begins) state.inKey = true;
      return "[redacted]";
    }
    state.secret = null;
  }
  // Did a rule take any of this line's text? Read as far as a line is read, but kept to that length, or a marker past the
  // output's limit is lost. The line is read as written, each whole marker as the plain one, so that a rule reads it as
  // one word; then the result and the line are held side by side without markers, blanks or colons, which a rule moves.
  const reach = 4 * (options.max ?? MAX_LOG_LINE);
  const read = options.rest && PROSE_KEY.test(bare) ? line.slice(0, reach).replace(LINE_MARKER, (marker) => (marker.endsWith("]") ? "[redacted]" : marker)) : "";
  const plain = (text) => text.replace(LINE_MARKER, "").replace(/[\s:]/g, "");
  const masked = read !== "" && plain(redactLine(read, home, reach)) !== plain(display(read, home, reach));
  if (options.rest && (begins || masked || flagExec(SECRET_ASSIGN, bare) !== null)) {
    // One message: from a key or any secret's value on, the rest of it goes; no guess at where a value ends.
    state.rest = true;
    return options.stateOnly ? null : begins ? "[redacted]" : nameOnly(bare, home, options.max);
  }
  if (begins) state.inKey = true;
  {
    // A key opening on the line (`password = """-----BEGIN …`, `credentials: | # -----BEGIN …`): the line is read
    // without its marker, so the value or header around it is still followed once the key's END is past.
    // Read both deleted and replaced: deleted, a header stays one (`credentials: -----BEGIN`); replaced, quotes either
    // side of it do not join into a closing `"""`.
    const marker = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
    const text = begins ? bare.replace(marker, "") : bare;
    const next = begins ? readings(opens(text), opens(bare.replace(marker, "x"))) : opens(text);
    const header = SECRET_HEADER.exec(text);
    if (next) {
      // The line read without its open readings: a header on it may be the real secret (shadow, above).
      state.secret = { indent: indentOf(bare), first: false, ...next, shadow: { inKey: false, secret: header ? headerState(text, header) : null } };
      return options.stateOnly ? null : begins ? "[redacted]" : nameOnly(bare, home, options.max);
    }
    if (header) state.secret = headerState(text, header);
  }
  return options.stateOnly ? null : redactLine(line, home, options.max);
}
