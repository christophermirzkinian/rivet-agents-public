#!/usr/bin/env node
// PostToolUse(SendMessage|Bash): copies one agent-to-agent message into the app's Team room
// (src/shared/conversations.ts): a SendMessage between local chats, or a `rivet-chat send <chat> --text "…"`
// relay. Redacted here, before it leaves this machine, and fail closed (redactText); first TEXT_MAX characters only.
// Fail-open: no token, no server or a slow answer means nothing is posted and nothing is said; it runs in the
// background (`async`), so it never holds up the tool. RIVET_TEAM_ROOM=off stops it.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { advisory, readStdin } from "./lib.mjs";

const DEFAULT_URL = "http://127.0.0.1:8130";
const TEXT_MAX = 600;
const TIMEOUT_MS = 2000;
/** Marks a shell word with text the shell builds ($'…', $VAR, $(…), `…`; shellWords): its text is never posted. */
const SHELL_BUILT = "\uE000";
const SHELL_BUILT_SHOWN = "[relay text the shell builds: not shown]";
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const MASK = "•••";
const REST = "[rest not shown: it may hold a secret]";
// A secret's name, in the letters of the message run together (no space, digit or escape between them hides one)...
const SECRET_NAME = /passw(?:or)?d|sshpass|auth|passphrase|secret|token|credential|bearer|apikey|privatekey|accesskey|cookie/;
// ...or as one part of a word (DB_PASS, MYSQL_PWD, requirepass): the labels of secrets a person picks, which can look like any words.
// Generated ones (keys, session ids, tokens) are long and random, and no word shape takes them.
const SECRET_PART = /^(?:\p{L}*pass|\p{L}*pwd|pw|passcode|pin|pincode|otp|creds?)$/u;
// The shapes a shown word may have; any other word is MASK.
const WORD = /^(?:\p{Ll}+|\p{Lu}\p{Ll}*|\p{Lu}+s?|\p{Lu}?\p{Ll}+(?:\p{Lu}\p{Ll}{2,})+|\p{Lo}+)$/u;
const NUMBER = /^\d{1,5}(?:[.,]\d{1,3})?(?:%|k|m|x|ms|s|px|h|am|pm|st|nd|rd|th)?$/;
const SHORT_SHA = /^[0-9a-f]{7,12}$/;
const LETTERS_DIGITS = /^(?:[a-z]+\d{1,4}[a-z]*|\d{1,4}[a-z]+\d{0,4}|[A-Z]+\d{1,4}[A-Z]*|\d{1,4}[A-Z]+\d{0,4})$/;
const HEX = /^[0-9a-f]{4,}$/i;
// Five consonants in a row: random letters (a generated password or seed), not a word.
const RANDOM = /[bcdfghjklmnpqrstvwxz]{5,}/i;
const TIME = /^\d{1,2}:\d{2}(?::\d{2})?(?:am|pm)?$/;
const PUNCTUATION = /^[\p{P}\p{S}]{1,4}$/u;
const LEAD = /^[([{<"'`\u00ab“‘*_~]+/u;
const TRAIL = /(?:(?<=\p{L})['’](?:t|s|re|ve|ll|d|m))?[()\]}>"'`\u00bb”’*_~.,;:!?…]*$/u;
// A handle, PR number, flag or path: its parts, split at - – . _ / × +, are each a word or a number.
const PREFIX = /^(?:@|#|--?|~?\/|\.\.?\/)/;
// Tab aside, every C0/C1 control, DEL and format character (bidi overrides, zero-width marks).
const CONTROL = /[^\P{Cc}\t]|\p{Cf}/u;
// A character that shows nothing (a Hangul filler, a combining grapheme joiner) splits a word or a flag unseen. A
// variation selector after a character outside ASCII styles it (an emoji's ❤️) and is not one.
const IGNORABLE = /(?![\uFE00-\uFE0F\u{E0100}-\u{E01EF}])\p{Default_Ignorable_Code_Point}|(?<![^\x00-\x7f])[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;
// A command-line flag: the word after it is its value (`redis-cli -a hunter2`), whatever it looks like, and so is the rest
// of a one-letter flag (`-phunter2`).
const FLAG = /^--?\p{L}/u;
const ATTACHED = /^-\p{L}./u;
// An apostrophe in a contraction (don't, Sam's); any other ' is a shell quote, mid-word too (`x'correct horse'y`).
const APOSTROPHE = /(?<=\p{L})'(?=(?:t|s|re|ve|ll|d|m)(?!\p{L}))/giu;
// A home folder is ~; Claude's encoding of one (`-Users-alice-`) is masked: the account name is no one's business.
// A user name then `/` or the end: anything else after the name may go on with it into a label (`/home/password=`,
// `/home/api**key**:`), so that path is read as written.
const HOME = /\/(?:Users|home)\/[\p{L}\p{N}\p{M}._-]+(?=\/|$)/gu;
const shortenHome = (/** @type {string} */ text) => text.replace(HOME, "~");
const ACCOUNT = /[-/](?:Users|home)[-/]/;

const word = (part) => part.length <= 24 && WORD.test(part) && !RANDOM.test(part);
const lettersDigits = (part) => part.length <= 10 && LETTERS_DIGITS.test(part) && !RANDOM.test(part);

/** A word is shown only when it has one of the allowed shapes; there is no list of secret formats to get past. */
export function wordShown(raw) {
  if (raw.length > 200) return false;
  if (PUNCTUATION.test(raw)) return true;
  const core = raw.replace(LEAD, "").replace(TRAIL, "");
  if (!core || TIME.test(core)) return true;
  if (ACCOUNT.test(core)) return false;
  // A link shows only on GitHub; anywhere else its path may be a key (`/reset/<uuid>`).
  const link = /^https?:\/\/([^/]*)/.exec(core);
  if (link && link[1] !== "github.com") return false;
  const parts = core.replace(/^https?:\/\//, "").replace(PREFIX, "").split(/[-–._/×+]/);
  if (parts.length === 1) return word(parts[0]) || NUMBER.test(parts[0]) || SHORT_SHA.test(parts[0]) || lettersDigits(parts[0]);
  return parts.some(Boolean) && parts.filter((part) => HEX.test(part)).length < 2 && parts.every((part) => !part || word(part) || NUMBER.test(part));
}

/**
 * A line as shown, or null where what is shown ends: a control or escape (it can hide text a terminal never shows), a
 * backslash, a secret's label in a word, or a quote still open at the end of the line (its value runs on). Every word
 * inside or touching straight quotes is MASK (`IDENTIFIED BY '…'`), as is a flag's value and every word wordShown refuses.
 */
function showLine(line, state) {
  if (CONTROL.test(line) || IGNORABLE.test(line) || line.includes("\\")) return null;
  let single = false;
  let double = false;
  let out = "";
  for (const [i, piece] of line.split(/(\s+)/).entries()) {
    if (i % 2 || !piece) {
      out += piece;
      continue;
    }
    let quoted = single || double;
    for (const c of piece.replace(APOSTROPHE, "")) {
      if (c === "'") single = !single;
      else if (c === '"') double = !double;
      else continue;
      quoted = true;
    }
    const core = piece.length > 200 ? piece : piece.replace(LEAD, "").replace(TRAIL, "");
    if (core.split(/[^\p{L}\p{N}]+|(?<=\p{Ll})(?=\p{Lu})/u).some((part) => SECRET_PART.test(part.toLowerCase()))) return null;
    // Punctuation (no letter, digit or quote) is never a flag's value, so it leaves one pending (`-a , hunter2`, a YAML list's `-`, the
    // next line of a folded command); it is still masked in quotes or as a value, except a list's marker first on a line.
    const punctuation = /^[^\p{L}\p{N}'"]+$/u.test(piece);
    const marker = /^[-*•]$/.test(piece) && !out.trim();
    const masked = !marker && (quoted || single || double || state.value || ATTACHED.test(core) || !wordShown(piece));
    if (!punctuation) state.value = FLAG.test(core);
    out += masked ? MASK : piece;
  }
  return single || double ? null : out.trimEnd();
}

// The readings redactText compares with the text as written: compatibility forms folded, then accents off as well.
// A variation selector is a mark too, but styles an emoji (❤️) and hides no letter.
const ACCENT = /(?![\uFE00-\uFE0F\u{E0100}-\u{E01EF}])\p{M}/gu;
const FOLDS = [(/** @type {string} */ text) => text.normalize("NFKC"), (/** @type {string} */ text) => text.normalize("NFKD").replace(ACCENT, "").normalize("NFKC")];

/**
 * Fail closed by construction: prose is shown, and only the words of it that have an allowed shape (wordShown; a plain
 * word, number, short SHA, path, GitHub link or PR number), never one in quotes or a flag's value; any other word is MASK.
 * Where a line ends what is shown (showLine), or at the line where a secret is named (the letters of the message run
 * together, across lines too, so no space, digit or escape hides a name), the rest of the message is REST. Nothing is
 * deleted first, so nothing can join two halves of a secret. Then the first TEXT_MAX characters.
 */
export function redactText(text) {
  // Read as written and with compatibility forms folded; from the first line the two show differently, the rest goes.
  // Neither reading is safe alone: folding moves quotes and word ends (`"a＂ b ＂c"` is one quoted word), and the written
  // one misses a fullwidth flag or quote.
  // Accents off too: NFKC folds U+212B to a letter of its own, A with a ring, which hides `PASS`.
  const out = once(text);
  let same = Infinity;
  for (const fold of FOLDS) {
    const [ours, theirs] = [fold(out).split("\n"), once(fold(String(text))).split("\n")];
    if (ours.join("\n") === theirs.join("\n")) continue;
    const at = ours.findIndex((line, i) => line !== theirs[i]);
    same = Math.min(same, at < 0 ? ours.length - 1 : at);
  }
  const shown = same === Infinity ? out : [...out.split("\n").slice(0, same), REST].join("\n");
  // Cut after the readings are compared: a cut's `…` folds to `...` in one reading and not the other.
  const chars = Array.from(shown);
  return chars.length > TEXT_MAX ? `${chars.slice(0, TEXT_MAX - 1).join("")}…` : shown;
}

/** @param {string} text */
function once(text) {
  const lines = shortenHome(String(text)).split(/\r\n?|[\n\v\f\x85\u2028\u2029]/);
  // NFKD: a fullwidth or styled letter reads as its plain one, and a combining accent stays apart from its letter and is
  // dropped (`ｐasswórd`). Composed, it would be a letter of its own that hides the name. A letter that shows
  // nothing (a Hangul filler) goes too.
  const letters = lines.map((line) => line.normalize("NFKD").toLowerCase().replace(/[^\p{L}]|\p{Default_Ignorable_Code_Point}/gu, ""));
  const named = SECRET_NAME.exec(letters.join(""));
  let seen = 0;
  // A symbol that folds to letters (`™`, a circled letter) may join a name or split one (`passw™ord`), so the text stops
  // at its line.
  const symbol = lines.findIndex((line) => [...line].some((c) => !/[\p{L}\p{M}]/u.test(c) && /\p{L}/u.test(c.normalize("NFKD"))));
  const end = Math.min(named ? letters.findIndex((line) => (seen += line.length) > named.index) : lines.length, symbol < 0 ? lines.length : symbol);
  const shown = [];
  const state = { value: false };
  let length = 0;
  for (const line of lines.slice(0, end)) {
    const out = length > TEXT_MAX ? null : showLine(line, state);
    if (out === null) break;
    length += out.length + 1;
    shown.push(out);
  }
  if (shown.length < lines.length) shown.push(REST);
  return shown.join("\n").trim();
}

/** A chat name the server takes: the worktree folder's name, or the part of a `to` before any ` [ref]`. */
export function chatName(raw) {
  const name = String(raw ?? "").trim().split(/\s+/)[0].replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 100);
  return NAME.test(name) && !/^\.+$/.test(name) ? name : null;
}

/** The words of a shell command, quotes resolved; enough for `rivet-chat send fix --text "…"`. */
export function shellWords(command) {
  const words = [];
  let word = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      word = (word ?? "") + command.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? command.length : end;
    } else if (c === '"') {
      word ??= "";
      for (i++; i < command.length && command[i] !== '"'; i++) {
        const next = command[i + 1] ?? "";
        // A line continuation is gone, as in Bash.
        if (command[i] === "\\" && next === "\n") {
          i++;
          continue;
        }
        if (command[i] === "\\" && /["\\$`]/.test(next)) i++;
        else if (command[i] === "$" || command[i] === "`") word += SHELL_BUILT;
        word += command[i];
      }
    } else if (c === "$" || c === "`") {
      // $'…', $VAR, $(…) and `…` are text the shell builds, joined with what is around it. Rather than redact a guess at
      // it, a word with any of it is never shown (SHELL_BUILT marks it).
      word = (word ?? "") + SHELL_BUILT + c;
      if (c === "$" && command[i + 1] === "'") for (i += 2; i < command.length && command[i] !== "'"; i++) if (command[i] === "\\") i++;
    } else if (c === "\\" && command[i + 1] === "\n") {
      i++;
    } else if (c === "\\" && i + 1 < command.length) {
      word = (word ?? "") + command[++i];
    } else if (c === " " || c === "\t" || c === "\n" || c === ";" || c === "&" || c === "|") {
      // Bash's blanks only: U+00A0 and other Unicode spaces are part of the word.
      if (word !== null) words.push(word);
      word = null;
      if (c !== " " && c !== "\t") words.push(c === "\n" ? ";" : c);
    } else if ("{*?[~(".includes(c)) {
      // Brace, glob, extglob (`@(…)`) and tilde expansion: the shell builds that word too.
      word = (word ?? "") + SHELL_BUILT + c;
    } else word = (word ?? "") + c;
  }
  if (word !== null) words.push(word);
  return words;
}

/** Command or parameter substitution anywhere, unescaped: its quotes can nest, so no word of the command is trusted. */
const SUBSTITUTION = /(?:^|[^\\])(?:\\\\)*(?:\$[('{]|`)/;

const run = (file, args) =>
  new Promise((resolve) =>
    execFile(file, args, { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout)),
  );

/** Whether `words[at]` is what its command runs, not an argument of `printf` or `echo`: only `node` or settings before it. */
function runsCommand(words, at) {
  for (let i = at - 1; i >= 0 && ![";", "&", "|"].includes(words[i]); i--) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) && !["node", "env"].includes(basename(words[i]))) return false;
  }
  return true;
}

/** Where the arguments of a chat send start in `words`, for the two commands that make one; -1 when `words[at]` is neither. */
function sendArguments(words, at) {
  const name = basename(words[at]);
  if (/^rivet-chat(\.mjs)?$/.test(name)) return words[at + 1] === "send" ? at + 2 : -1;
  if (/^rivet(\.mjs)?$/.test(name)) return words[at + 1] === "chat" && words[at + 2] === "send" ? at + 3 : -1;
  return -1;
}

/** Every `rivet-chat send <chat> --text …` or `rivet chat send <chat> --text …`: the chat it names (a name, a session or a worktree path) and the text. */
export function runnerSends(command) {
  const words = shellWords(command);
  const built = SUBSTITUTION.test(command) || SUBSTITUTION.test(command.replace(/\\\n/g, ""));
  const sends = [];
  for (let i = 0; i + 1 < words.length; i++) {
    const start = sendArguments(words, i);
    if (start < 0 || !runsCommand(words, i)) continue;
    let chat = null;
    let text = null;
    for (let j = start; j < words.length && ![";", "&", "|"].includes(words[j]); j++) {
      const [flag, inline] = words[j].split(/=(.*)/s);
      if (flag === "--text") {
        text = inline ?? words[j + 1];
        if (inline === undefined) j++;
      } else if (flag === "--repo") {
        if (inline === undefined) j++;
      } else if (!chat) chat = words[j];
    }
    if (text) sends.push({ chat: chat ? chatName(basename(chat)) : null, text: built || text.includes(SHELL_BUILT) ? SHELL_BUILT_SHOWN : text.replace(/^From [A-Za-z0-9._-]+:\s*/, "") });
  }
  return sends;
}

/**
 * The chat a SendMessage `to` names: a session name is the chat plus a two-hex suffix
 * (`docs-build-b0 [3ccc08]`), a socket address is a session's process (its folder), and
 * an `a…` hex id is an in-process subagent, no chat at all (null).
 */
export async function recipient(raw, projectDir) {
  const to = String(raw ?? "").trim().split(/\s+/)[0];
  const workspace = dirname(projectDir);
  const socket = /^uds:.*\/(\d+)\.sock$/.exec(to);
  if (socket) {
    const out = await run(process.env.LSOF_BIN || "/usr/sbin/lsof", ["-a", "-p", socket[1], "-d", "cwd", "-Fn"]);
    const path = out?.split("\n").find((line) => line.startsWith("n"))?.slice(1);
    if (!path) return null;
    return chatName(path.startsWith(`${workspace}/`) ? path.slice(workspace.length + 1).split("/")[0] : basename(path));
  }
  if (/^a[0-9a-f]{8,}$/.test(to)) return null;
  const name = chatName(to);
  const bare = name?.replace(/-[0-9a-f]{2}$/, "");
  return name && bare !== name && !existsSync(join(workspace, name)) && existsSync(join(workspace, bare)) ? bare : name;
}

async function token() {
  if (process.env.RIVET_BOARD_TOKEN) return process.env.RIVET_BOARD_TOKEN.trim();
  const out = await run("/usr/bin/security", ["find-generic-password", "-s", "rivet-agents", "-a", "RIVET_BOARD_TOKEN", "-w"]);
  return out?.trim() || null;
}

/** What the tool call said, to whom: none when it is no agent-to-agent message. */
export async function messagesOf(input, projectDir) {
  const tool = input.tool_input ?? {};
  if (input.tool_name === "SendMessage") {
    const to = await recipient(tool.to, projectDir);
    return to && typeof tool.message === "string" && tool.message.trim() ? [{ to, text: tool.message }] : [];
  }
  if (input.tool_name === "Bash" && typeof tool.command === "string" && /\brivet(?:-chat|\.mjs\s+chat|\s+chat)\b[\s\S]*\bsend\b/.test(tool.command)) {
    return runnerSends(tool.command).map((sent) => ({ to: sent.chat ?? "terminal", text: sent.text }));
  }
  return [];
}

async function main() {
  if (process.env.RIVET_TEAM_ROOM === "off") return;
  const input = await readStdin();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || "";
  const messages = await messagesOf(input, projectDir);
  const from = chatName(basename(projectDir));
  if (!messages.length || !from) return;
  // https, or http to this machine only: the board token goes nowhere else.
  const origin = new URL(process.env.RIVET_URL || DEFAULT_URL);
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) return;
  const secret = await token();
  if (!secret) return;
  const toolId = String(input.tool_use_id ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 86);
  for (const [n, message] of messages.entries()) {
    const text = redactText(message.text);
    if (!text) continue;
    const id = toolId ? `${toolId}${n ? `-${n}` : ""}` : createHash("sha256").update(`${input.session_id}\n${message.to}\n${text}`).digest("hex").slice(0, 40);
    await fetch(new URL("/api/team/message", origin), {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ id, from, to: message.to, text }),
      // A redirect could carry the message somewhere the origin check never saw.
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) advisory(main);
