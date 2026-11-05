#!/usr/bin/env node
// PreToolUse(Bash): the hard lines. A few commands do damage nobody can undo, or go past a rule the repo relies on, and
// have no legitimate use from a chat: a merge past your own gate, a kill by name pattern, a docker volume or system
// prune. Unlike the other hooks here this one may deny. RIVET_HARD_LINES (off | shadow | deny, default shadow) sets how:
// shadow only says what it would deny and logs it. It is read from the hook's own environment, so a
// `RIVET_HARD_LINES=off` inside the command changes nothing. RIVET_MERGE_GATE names the command your merges go through.
// Text work only: no network, and anything wrong with the hook itself means it says nothing (advisory()).
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { advisory, emit, readStdin } from "./lib.mjs";

const MODES = new Set(["off", "shadow", "deny"]);
const BODY_FILE_MAX = 64 * 1024;
const CHAT_NAME = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/;
// Words that only wrap the command after them, with the options of theirs that take a value.
const WRAPPERS = new Map([
  ["sudo", /^-[ugCDhpRrtTU]$/], ["command", null], ["exec", /^-a$/], ["nohup", null], ["time", null], ["nice", /^-n$/],
  ["env", /^-[uCS]$/], ["caffeinate", /^-[tw]$/], ["timeout", /^-[sk]$/], ["xargs", /^-[ILnPsdEaJR]$/], ["stdbuf", null],
]);
// Shell words that start or end a compound command; the command after them still runs.
const RESERVED = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "case", "esac", "{", "}", "!", "function"]);
// Words that may come before a command's own name: reserved words, and the `time` keyword with its `-p`.
const LEADING = new Set([...RESERVED, "time", "-p"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
// Where a command substitution stood inside a word, and one whose output came from a pgrep by pattern.
const SUB = "\u0000";
const PGREP = "\u0001";
// Nesting past this (`eval eval …`, `$($(…))`), or more text read than this once nested copies are counted, is not
// something a chat writes; the hook refuses to guess at it.
const MAX_DEPTH = 24;
const MAX_READ = 1_000_000;
const PARSE_BUDGET_MS = 2000;
class TooDeep extends Error {}
let readLeft = MAX_READ;
let inputs = []; // parse()'s here-strings and heredoc bodies, read by mergeUnresolved()
let fed = []; // who reads each of `inputs`: a record, a group's range of records, or null
let ran = false; // parse() met text that runs as code: `<(…)`, a shell's, eval's or group's script
let deadline = Infinity; // parse() past this time throws TooDeep: the hook has 5 seconds, and a timeout says nothing
let ticks = 0;
// ANSI-C quoting, `$'…'`: the escapes bash decodes.
const ANSI_C = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

/**
 * The simple commands a Bash command line runs, nested ones included: `$(…)` and backticks (inside double quotes and
 * unquoted heredocs too), `<(…)`, `bash -c '…'`, `eval`, and a heredoc or here-string fed to a shell; `$'…'` is
 * decoded and a `case` pattern's `)` ends no substitution. Each is
 * { words, assigns, wrappers, from }: words unquoted with leading assignments, reserved words and wrappers removed,
 * `from` the command piping into it. A quoted argument stays one word, so a commit message, a PR body or a grep
 * pattern is never read as a command; a heredoc fed to anything but a shell is data. Every here-string, as bash
 * decodes it, and every heredoc body (an unquoted one's line continuations joined) also goes to `inputs`, whoever
 * reads it, a subshell `( … ) <<< …` included.
 */
function parse(src, asText = false, depth = 0) {
  if (depth > MAX_DEPTH || (readLeft -= src.length + 1) < 0 || Date.now() > deadline) throw new TooDeep();
  if (!asText && depth > 0) ran = true; // a shell's, eval's or group's script
  const found = [];
  let i = 0;
  const nested = (text, asData = false) => {
    for (const record of parse(text, asData, depth + 1)) found.push(record);
  };

  const substitution = (stop) => {
    const before = found.length;
    if ((depth += 1) > MAX_DEPTH) throw new TooDeep();
    list(stop);
    depth -= 1;
    return found.slice(before).some(namesByPattern) ? PGREP : SUB;
  };

  function doubleQuoted(close) {
    let text = "";
    while (i < src.length && src[i] !== close) {
      if (src[i] === "\\" && i + 1 < src.length) {
        text += "$`\"\\\n".includes(src[i + 1]) ? (src[i + 1] === "\n" ? "" : src[i + 1]) : src.slice(i, i + 2);
        i += 2;
      } else if (src[i] === "$" && src[i + 1] === "(") {
        i += 2;
        text += substitution(")");
      } else if (src[i] === "`") {
        i += 1;
        text += substitution("`");
      } else text += src[i++];
    }
    i += 1;
    return text;
  }

  // bash cuts the string at a decoded NUL: `$'pkill\0x'` runs pkill. `\u` takes at most 4 hex digits, `\U` 8.
  function ansiC() {
    let text = "";
    while (i < src.length && src[i] !== "'") {
      if (src[i] !== "\\") {
        text += src[i++];
        continue;
      }
      const esc = src[i + 1] ?? "";
      const code = esc === "x" ? src.slice(i + 2).match(/^[0-9a-fA-F]{1,2}/) : esc === "u" ? src.slice(i + 2).match(/^[0-9a-fA-F]{1,4}/) : esc === "U" ? src.slice(i + 2).match(/^[0-9a-fA-F]{1,8}/) : /[0-7]/.test(esc) ? src.slice(i + 1).match(/^[0-7]{1,3}/) : null;
      if (code) {
        text += String.fromCodePoint(Math.min(parseInt(code[0], /[0-7]/.test(esc) ? 8 : 16), 0x10ffff));
        i += 1 + (/[0-7]/.test(esc) ? 0 : 1) + code[0].length;
      } else {
        text += ANSI_C[esc] ?? `\\${esc}`;
        i += 2;
      }
    }
    i += 1;
    return text.includes("\0") ? text.slice(0, text.indexOf("\0")) : text;
  }

  function command(raw, from) {
    const assigns = [];
    const wrappers = [];
    let k = 0; // an index, not slices: `env env env …` stays linear
    while (k < raw.length) {
      const first = raw[k];
      const name = basename(first).toLowerCase(); // a case-blind file system: `/usr/bin/ENV` is env
      if (RESERVED.has(first)) k += 1;
      else if (/^[A-Za-z_]\w*\+?=/.test(first)) {
        assigns.push(first);
        k += 1;
      } else if (WRAPPERS.has(name)) {
        if (name === "command" && /^-[vV]$/.test(raw[k + 1] ?? "")) return null; // a lookup, not a run
        const takesValue = WRAPPERS.get(name);
        wrappers.push(name);
        k += 1;
        while (/^-/.test(raw[k] ?? "")) {
          const flag = raw[k];
          k += takesValue?.test(flag) ? 2 : 1;
          if (flag === "--") break;
        }
        if (name === "timeout") k += 1; // its duration
      } else break;
    }
    const words = raw.slice(k);
    if (!words.length && !assigns.length) return null;
    const record = { words: words.length ? [basename(words[0]).toLowerCase(), ...words.slice(1)] : [], assigns, wrappers, from };
    found.push(record);
    const [head, ...args] = record.words;
    const shell = SHELLS.has(head) ? shellOptions(head, args) : null;
    if (shell && !shell.noexec && shell.command >= 0 && args[shell.command] !== undefined) nested(args[shell.command]);
    if (head === "eval") nested(args.join(" "));
    return record;
  }

  function readHeredocs(docs) {
    for (const doc of docs) {
      let body = "";
      while (i < src.length) {
        const nl = src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
        let line = src.slice(i, nl);
        i = Math.min(nl + 1, src.length);
        // An unquoted heredoc joins `\<newline>` lines before it looks for the delimiter: `EO\<newline>F` ends it.
        while (!doc.quoted && /(?:^|[^\\])(?:\\\\)*\\$/.test(line) && i < src.length) {
          const next = src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
          line = line.slice(0, -1) + src.slice(i, next);
          i = Math.min(next + 1, src.length);
        }
        if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delim) break;
        body += `${line}\n`;
      }
      // `bash <<EOF` runs its body; an unquoted heredoc runs the substitutions in it first, whoever reads it.
      inputs.push(body);
      fed.push(doc.reader());
      if (feedsShell(doc.reader())) nested(body);
      if (!doc.quoted) nested(body, true);
    }
  }

  // A shell reading its script from stdin: `bash`, `sh -s`, not `bash -c '…'` or `bash -n`; for a group's input,
  // `(bash) <<< '…'` or `{ sh; } <<EOF`, any shell in it that does not redirect its own stdin. A group is a range of
  // `found`, counted from a running sum, so `(true;(true;…))` stays linear.
  const readers = [0];
  function feedsShell(owner) {
    if (owner && "start" in owner) {
      for (let k = readers.length - 1; k < owner.end; k += 1) {
        readers.push(readers[k] + (!found[k].ownStdin && feedsShell(found[k]) ? 1 : 0));
      }
      return readers[owner.end] - readers[owner.start] > 0;
    }
    if (!owner || !SHELLS.has(owner.words[0])) return false;
    const shell = shellOptions(owner.words[0], owner.words.slice(1));
    return shell.command < 0 && !shell.noexec;
  }

  // Reads a shell's options as it does, in order, up to `--` or the first operand. Returns whether it only parses
  // (`-n`, a later `+n` or `+o noexec` turning it back off; bash's `-D` too) and, with `-c`, the index of the command
  // string: the first operand, wherever `-c` sat (`bash -Oc extglob -c '…'`). Each o/O takes the next word
  // (`-On extglob`); zsh and ksh also take an attached `-o` value (`-oerrexit`, `-ono_exec`), whose letters are no flags.
  function shellOptions(shell, args) {
    const attached = shell === "zsh" || shell === "ksh";
    let noexec = false;
    let c = false;
    let k = 0;
    for (; k < args.length && /^[-+]./.test(args[k]); k += 1) {
      if (args[k] === "--") {
        k += 1;
        break;
      }
      if (/^--(?:rcfile|init-file)$/.test(args[k])) k += 1;
      else if (shell === "bash" && /^--dump-(?:po-)?strings$/.test(args[k])) noexec = true;
      else if (/^[-+][A-Za-z][A-Za-z_]*$/.test(args[k])) { // `_` only in an attached zsh name
        const set = args[k][0] === "-";
        const letters = args[k].slice(1);
        let value = k;
        for (let i = 0; i < letters.length; i += 1) {
          const letter = letters[i];
          if (letter === "n") noexec = set;
          if (letter === "D" && shell === "bash" && set) noexec = true;
          if (letter === "c" && set) c = true;
          if (letter !== "o" && letter !== "O") continue;
          if (letter === "o" && attached && i + 1 < letters.length) {
            if (isNoexec(letters.slice(i + 1))) noexec = set;
            break;
          }
          value += 1;
          if (letter === "o" && isNoexec(args[value] ?? "")) noexec = set;
        }
        k = value;
      }
    }
    return { noexec, command: c ? k : -1 };

    // zsh ignores case and underscores in option names: `NO_EXEC` is `noexec`.
    function isNoexec(name) {
      return (attached ? name.toLowerCase().replace(/_/g, "") : name) === "noexec";
    }
  }

  // Reads commands up to `stop` (")" or "`") or the end of the text.
  function list(stop) {
    let words = [];
    let word = null;
    let quoted = false;
    let target = null; // after a redirection: "file", "herestring", "heredoc" or "heredoc-" (<<-)
    let from = null;
    let last = null;
    let parens = 0;
    const caseAt = []; // each open `case … esac`'s paren depth: a `)` at that depth ends a pattern, not a group
    let ownStdin = false; // the command being read gives itself other stdin: a group's input is not its
    let stdinFrom = null; // a `<` or `<&` waiting for its target word: only `/dev/null` or `-` gives other stdin
    let lead = true; // only reserved words so far: a `case` or `esac` here is the keyword
    let subject = 0; // the words after `case` (its subject and `in`) that are never keywords
    const pending = [];
    let herestrings = [];
    const append = (text) => {
      word = (word ?? "") + text;
    };
    const endWord = () => {
      if (word === null) return;
      if (target === "heredoc" || target === "heredoc-") {
        const owner = words;
        pending.push({ delim: word, quoted, strip: target === "heredoc-", reader: () => owners.get(owner) ?? null });
      } else if (target === "herestring") herestrings.push(word);
      else if (!target) {
        if (subject) subject -= 1; // `case case in`, `case esac in`
        else if (lead && !quoted && word === "case") {
          caseAt.push(parens);
          subject = 2;
        } else if (lead && !quoted && word === "esac") caseAt.pop();
        if (quoted || !LEADING.has(word)) lead = false;
        words.push(word);
      } else if (target === "file" && stdinFrom) {
        // `bash </dev/null` or `bash <&-` reads no group input; any other file or descriptor may be it (`0<&0`,
        // `/dev/stdin`, a link to it, `3<&0` earlier).
        // The last stdin redirect wins: `bash </dev/null <&3` reads fd 3 again.
        ownStdin = word === (stdinFrom === "dup" ? "-" : "/dev/null");
      }
      stdinFrom = null;
      word = null;
      quoted = false;
      target = null;
    };
    const owners = new Map(); // a command's words → its record, or a group's records, for the heredocs it reads
    const groups = []; // where each open `(` or `{` group's records start in `found`
    let closed = null; // the group a `)` or `}` just closed, as a range of `found`: `( … ) <<< x` feeds it
    const endCommand = (pipe) => {
      endWord();
      target = null;
      for (const w of words) { // `{`, `if true; then {`, `{ {`, `time {`: each opens a group
        if (w === "{") groups.push(found.length);
        else if (!LEADING.has(w)) break;
      }
      const record = words.length ? command(words, from) : null;
      if (record) record.ownStdin = ownStdin;
      ownStdin = false;
      stdinFrom = null;
      lead = true;
      subject = 0;
      if (words.length && words.every((w) => w === "}")) {
        for (const _ of words) if (groups.length) closed = { start: groups.pop(), end: found.length };
      }
      const owner = record ?? (closed && (!words.length || words[0] === "}") ? closed : null);
      if (owner) owners.set(words, owner);
      closed = null;
      for (const text of herestrings) {
        inputs.push(text);
        fed.push(owner);
      }
      if (feedsShell(owner)) for (const text of herestrings) nested(text); // `bash <<< '…'`
      herestrings = [];
      last = record;
      from = pipe ? record : null;
      words = [];
    };
    while (i < src.length) {
      if ((ticks += 1) % 4096 === 0 && Date.now() > deadline) throw new TooDeep();
      const c = src[i];
      if (c === ")" && word === "esac" && !quoted && !words.length) endWord(); // `esac)` closes the case first
      if (stop === "`" && c === "`") {
        i += 1;
        break;
      }
      const pattern = c === ")" && caseAt.length > 0 && caseAt.at(-1) === parens;
      if (stop === ")" && c === ")" && parens === 0 && !pattern) {
        i += 1;
        break;
      }
      if (c === "\\") {
        // `\<newline>` is a line continuation, not a quote: `<<EO\<newline>F` is an unquoted heredoc.
        if (src[i + 1] !== "\n") {
          append(src[i + 1] ?? "");
          quoted = true;
        }
        i += 2;
      } else if (c === "'") {
        const end = src.indexOf("'", i + 1) < 0 ? src.length : src.indexOf("'", i + 1);
        append(src.slice(i + 1, end));
        quoted = true;
        i = end + 1;
      } else if (c === '"') {
        i += 1;
        append(doubleQuoted('"'));
        quoted = true;
      } else if (c === "$" && src[i + 1] === "'") {
        i += 2;
        append(ansiC());
        quoted = true;
      } else if (c === "$" && src[i + 1] === '"') {
        i += 2;
        append(doubleQuoted('"'));
        quoted = true;
      } else if (c === "$" && src[i + 1] === "(") {
        i += 2;
        append(substitution(")"));
      } else if (c === "`") {
        i += 1;
        append(substitution("`"));
      } else if ((c === "<" || c === ">") && src[i + 1] === "(") {
        endWord();
        i += 2;
        ran = true;
        if ((depth += 1) > MAX_DEPTH) throw new TooDeep();
        list(")");
        depth -= 1;
        target = null; // `2> >(cat >&2) gh …`: the substitution was the redirection's target
      } else if (c === "#" && word === null) {
        while (i < src.length && src[i] !== "\n") i += 1;
      } else if (c === " " || c === "\t") {
        endWord();
        i += 1;
      } else if (c === "\n") {
        endCommand(false);
        i += 1;
        readHeredocs(pending.splice(0));
      } else if (c === "&" && src[i + 1] === ">") {
        endWord();
        i += src[i + 2] === ">" ? 3 : 2;
        target = "file";
      } else if (c === ";" || c === "&" || c === "|") {
        endCommand(c === "|" && src[i + 1] !== "|");
        i += src[i + 1] === c || (c === "|" && src[i + 1] === "&") || (c === ";" && src[i + 1] === "&") ? 2 : 1;
      } else if (pattern) {
        endCommand(false); // a case pattern's end: `x) cmd;;`
        i += 1;
      } else if (c === "(" || c === ")") {
        endCommand(false);
        if (c === "(") groups.push(found.length);
        else if (groups.length) closed = { start: groups.pop(), end: found.length };
        parens += c === "(" ? 1 : -1;
        i += 1;
      } else if (c === "<" || c === ">") {
        const fd = word !== null && !quoted && /^\d+$/.test(word) ? word : null;
        if (fd !== null) word = null; // the descriptor of `2>&1`
        else endWord();
        const stdin = c === "<" && (fd === null || fd === "0");
        if (stdin && src[i + 1] === "<") ownStdin = true; // its own here-string or heredoc
        if (src.startsWith("<<<", i)) {
          i += 3;
          target = "herestring";
        } else if (src.startsWith("<<", i)) {
          i += 2;
          target = src[i] === "-" ? "heredoc-" : "heredoc";
          if (src[i] === "-") i += 1;
        } else {
          i += 1;
          if (src[i] === ">" || src[i] === "|" || (c === "<" && src[i] === ">")) i += 1;
          if (stdin && src[i - 1] === "<") stdinFrom = src[i] === "&" ? "dup" : "file";
          if (src[i] === "&") i += 1;
          target = "file";
        }
      } else {
        append(c);
        i += 1;
      }
    }
    endCommand(false);
    return last;
  }

  if (asText) doubleQuoted(null);
  else list(null);
  return found;
}

const mergeReason = () => {
  const gate = process.env.RIVET_MERGE_GATE?.trim();
  const door = gate ? `merges go through \`${gate}\`` : "merges go through your own gate (RIVET_MERGE_GATE names its command)";
  return `${door}: a direct merge skips the review and checks that gate stands for, and can go past a branch rule.`;
};
const KILL_REASON =
  "a kill by name pattern reaches other chats' processes and the tools running them. Stop only what you started: `kill <saved pid>`, `kill $(lsof -ti tcp:<port> -sTCP:LISTEN)` after checking the listener's cwd, or `pkill -P <your pid>`.";
const PRUNE_REASON =
  "docker volume/system prune deletes every project's unattached volumes on this machine and cannot be undone. Remove only your own container and its named volume: `docker rm -f <yours>`, `docker volume rm <name>`.";
const DEEP_REASON =
  "the command nests `eval`, `bash -c` or `$(…)` too deeply for the hard-lines hook to read, so it cannot tell whether a hard line is in it. Split it into plain commands.";

// Fail closed: no parser reads every bash form, so a line that mentions a merge passes
// only when it is plainly read. Every command in it is a data command (git's plain subcommands with no option but
// `-C`, gh's own subcommands, a fully literal `gh api` or curl, echo, cat, grep …) under a literal name with no
// assignment before it, nothing in it runs as code
// (`<(…)`, a shell's, eval's or group's script), every mention sits in a word or a here-string/heredoc of one of
// those commands, a word that mentions it holds no `$(…)` (the read around one may be wrong), and gh's subcommand
// and verb are literal. A `$(cat <<'EOF' … EOF)` commit message passes.
const UNRESOLVED_REASON =
  "This line mentions a merge (`gh pr merge`, a REST or GraphQL merge) in a form the hook cannot read plainly, so it is refused: run plain commands, with text that mentions a merge kept in a quoted argument or a quoted heredoc of git, gh, echo, cat or grep.";
const MERGE_TEXT = /pulls\/[^/\s]+\/merge\b|mergepullrequest|enablepullrequestautomerge/;
// `gh`, then `pr`, then `merge`, however far apart, within one command's text (`gh -R a/b -R a/b … pr merge`): the
// earliest of each after the last is the best chance, so one pass per part is enough.
function ghPrMerge(text) {
  for (const part of text.split(/[;&|\n]/)) {
    let at = 0;
    for (const re of [/\bgh\b/g, /\bpr\b/g, /\bmerge\b/g]) {
      re.lastIndex = at;
      if (!re.exec(part)) {
        at = -1;
        break;
      }
      at = re.lastIndex;
    }
    if (at >= 0) return true;
  }
  return false;
}
const DATA_HEADS = new Set(["echo", "printf", "cat", "tee", "grep", "egrep", "fgrep", "rg", "head", "tail", "wc", "ls", "cd", "pwd", "true", "false", ":", "test", "[", "diff", "jq", "mkdir", "touch", "cp", "mv", "sort", "uniq", "cut", "tr"]);
const GH_DATA = new Set(["pr", "issue", "run", "workflow", "repo", "release", "label", "search", "browse", "status"]);
const GIT_DATA = new Set(["add", "commit", "status", "log", "diff", "show", "fetch", "push", "pull", "rev-parse", "branch", "checkout", "switch", "tag", "notes", "grep", "ls-files", "restore", "rm", "mv", "merge-base", "rev-list", "remote"]);
const mentions = (text) => {
  const flat = text.toLowerCase().replace(/\\\n/g, "").replace(/[ \t\r\f\v]+/g, " ");
  return MERGE_TEXT.test(flat) || ghPrMerge(flat);
};

function isData(record) {
  if (!record || "start" in record) return false; // a group: its input reaches every command in it
  const [head, ...args] = record.words;
  if (record.wrappers.some((w) => w !== "command" && w !== "time")) return false; // xargs, sudo, env -S, nohup …
  if (record.assigns.length) return false; // `GIT_SSH_COMMAND=… git fetch`, `PAGER=… gh pr view`
  if (DATA_HEADS.has(head)) return true;
  if (head === "git") {
    const sub = gitWords(args);
    // Only `-C dir`, `-P` and `--no-pager` before the subcommand: `-cname=value`, `--exec-path` … can run code.
    const globals = args.slice(0, args.length - sub.length);
    for (let k = 0; k < globals.length; k += 1) {
      if (globals[k] === "-C") k += 1;
      else if (globals[k] !== "-P" && globals[k] !== "--no-pager") return false;
    }
    return GIT_DATA.has(sub[0]);
  }
  // A REST or GraphQL call is data only when the merge rule sees all of it: every word literal (`-X "${M:-PUT}"`
  // hides a PUT), and no method or payload from stdin, a file or a config (`--input -`, `query=@-`, `-sSK cfg`,
  // `--expand-request`). A literal `-X PUT` or mutation is the merge rule's.
  const literal = args.every((a) => !/[$\u0000\u0001]/.test(a));
  // curl takes a long option by any unique prefix (`--req`): one naming --request, --config or --variable counts.
  const names = (a) => /^--[a-z]/.test(a) && ["--request", "--config", "--variable"].some((full) => full.startsWith(a.split("=")[0]));
  if (head === "curl") return literal && !args.some((a) => /^-[A-Za-z0-9]*K|^--expand-/.test(a) || names(a));
  if (head !== "gh") return false;
  const [sub] = ghWords(args);
  if (sub === "api") return literal && !args.some((a) => a.includes("@") || /^--input/.test(a));
  return GH_DATA.has(sub); // gh's own commands, never an alias (`gh m 7396`) or an extension
}
const callsApi = (record) => record && !("start" in record) && (record.words[0] === "curl" || (record.words[0] === "gh" && ghWords(record.words.slice(1))[0] === "api"));

function mergeUnresolved(command, commands) {
  const dynamic = (w) => /[$\u0000\u0001]/.test(w ?? "");
  for (const { words } of commands) {
    if (dynamic(words[0]) && words.some((w) => /merge/i.test(w))) return true; // `$G pr merge 42`
    if (words[0] === "gh") {
      const [sub, verb] = ghWords(words.slice(1));
      if (dynamic(sub) || (sub === "pr" && dynamic(verb))) return true; // `gh pr $v 42`
    }
  }
  const raw = mentions(command.replace(/\\\n/g, "").replace(/['"\\]/g, ""));
  const said = commands.filter(({ words }) => mentions(words.join(" ")));
  const fedWith = fed.filter((_, k) => mentions(inputs[k]));
  if (!raw && !said.length && !fedWith.length) return false;
  if (said.some(({ words }) => words.some((w) => /[\u0000\u0001]/.test(w) && mentions(w)))) return true;
  if (commands.some(({ words }) => dynamic(words[0]))) return true; // `$(echo gh) pr merge`
  if (ran || !commands.every(isData)) return true;
  if (fedWith.some((owner) => !isData(owner) || callsApi(owner))) return true; // `gh api graphql --input - <<EOF`
  return raw && !said.length && !fedWith.length; // the text names a merge the read lost
}

/** gh's words with its global --repo removed: `gh -R a/b pr merge 3` → [pr, merge, 3]. */
function ghWords(args) {
  const out = [];
  for (let k = 0; k < args.length; k += 1) {
    if (args[k] === "-R" || args[k] === "--repo") k += 1;
    else if (!/^(?:-R.|--repo=)/.test(args[k])) out.push(args[k]);
  }
  return out;
}

/** git's words with its global options removed: `git -C dir commit` → [commit]. */
function gitWords(args) {
  let k = 0;
  while (k < args.length && args[k].startsWith("-")) k += /^-[Cc]$|^--(?:git-dir|work-tree|namespace)$/.test(args[k]) ? 2 : 1;
  return args.slice(k);
}

// Whether a REST call asks for PUT anywhere: `-X PUT`, `-XPUT`, `--method PUT`, `--method=PUT`, `--request PUT`. Any
// one counts, not the last: curl's `--next` starts another request with its own method.
function asksPut(args) {
  for (let k = 0; k < args.length; k += 1) {
    const joined = args[k].match(/^(?:-[A-Za-z0-9]*?X=?|--method=|--request=)(.+)$/); // `-sSXPUT`, gh's `-X=PUT` too
    if (/^(?:-[A-Za-z0-9]*X|--method|--request)$/.test(args[k]) && (args[k + 1] ?? "").toUpperCase() === "PUT") return true;
    if (joined?.[1].toUpperCase() === "PUT") return true;
  }
  return false;
}
const MERGE_PATH = /(?:^|\/)pulls\/[^/\s]+\/merge(?:[/?#]|$)/;

/** parse(), or null for a command nested past MAX_DEPTH. */
function readable(command) {
  // One read per command line: the hard lines and the nudges share it, so the 2-second budget is the whole hook's, not
  // one per caller.
  if (lastRead?.command === command) return lastRead.commands;
  lastRead = { command, commands: read(command) };
  return lastRead.commands;
}
let lastRead = null;
function read(command) {
  deadline = Date.now() + PARSE_BUDGET_MS;
  try {
    // A first read collects the line's assignments, so `-P $P` is judged by what P was set to (ownPid()). In it every
    // pgrep counts as a pattern, so a variable set from any pgrep holds one. `P+=…` appends: P is no longer a pid.
    readLeft = MAX_READ;
    assigned = null;
    const first = parse(command);
    const next = new Map();
    for (const { words, assigns } of first) {
      for (const a of [...assigns, ...(/^(?:export|declare|typeset|local|readonly)$/.test(words[0]) ? words.slice(1) : [])]) {
        const [, name, append, value] = a.match(/^([A-Za-z_]\w*)(\+?)=([\s\S]*)$/) ?? [];
        if (!name) continue;
        if (!next.has(name)) next.set(name, []);
        next.get(name).push(append ? "+=" : value); // in place: copying the list per assignment is quadratic
      }
    }
    assigned = next;
    resolved = new Map();
    readLeft = MAX_READ;
    inputs = [];
    fed = [];
    ran = false;
    return parse(command);
  } catch (err) {
    if (err instanceof TooDeep) return null;
    throw err;
  }
}

/** The command line's hard-line breaches: [{ rule, reason }]. */
function breaches(command) {
  const found = new Map();
  const add = (rule, reason) => found.set(rule, reason);
  const commands = readable(command);
  if (!commands) return [{ rule: "unreadable", reason: DEEP_REASON }];
  for (const { words, wrappers, from } of commands) {
    const [head, ...args] = words;
    if (head === "killall") add("pattern-kill", KILL_REASON);
    if (head === "pkill" && (wrappers.includes("xargs") || !onlyOwnChildren(args))) add("pattern-kill", KILL_REASON);
    if (head === "kill") {
      const upstream = [];
      for (let up = wrappers.includes("xargs") ? from : null; up; up = up.from) upstream.push(up);
      if (args.some((a) => a.includes(PGREP)) || upstream.some((up) => namesByPattern(up) || up.words[0] === "ps"))
        add("pattern-kill", KILL_REASON);
    }

    if (head === "gh") {
      const [sub, verb] = ghWords(args);
      if (sub === "pr" && verb === "merge") add("merge-door", mergeReason());
      if (sub === "api" && asksPut(args) && args.some((a) => MERGE_PATH.test(a))) add("merge-door", mergeReason());
      if (sub === "api" && args.some((a) => /\b(?:mergePullRequest|enablePullRequestAutoMerge)\b/.test(a)))
        add("merge-door", mergeReason());
    }
    if (head === "curl" && asksPut(args) && args.some((a) => MERGE_PATH.test(a))) add("merge-door", mergeReason());

    if (head === "docker") {
      const plain = [];
      for (let k = 0; k < args.length; k += 1) {
        if (/^(?:-c|--context|-H|--host|--config|-l|--log-level)$/.test(args[k])) k += 1;
        else if (!args[k].startsWith("-")) plain.push(args[k]);
      }
      if (/^(?:volume|system)$/.test(plain[0] ?? "") && plain[1] === "prune") add("docker-prune", PRUNE_REASON);
    }
  }
  if (!found.has("merge-door") && mergeUnresolved(command, commands)) add("merge-door", `${mergeReason()} ${UNRESOLVED_REASON}`);
  return [...found].map(([rule, reason]) => ({ rule, reason }));
}

// A pid a chat started and saved: a number, `$$`, `$!` or a variable holding one. Not 0 or 1 (init: every process
// on this machine) and not `$PPID`, whose children are the other shells of the agent or terminal that started this one.
// A variable set on the same line must hold such a pid too (or a plain `$(…)`, e.g. a pid file read); one set
// elsewhere is trusted, as a number is: the text cannot tell whose it is.
const OWN_PID = /^(?!0*1?$)(?:\d+|\$\$|\$!|\$(?!\{?PPID\}?$)\{?\w+\}?)$/;
let assigned = null;
let resolved = new Map(); // each name judged once (a cycle or a chain past 64 is no pid)
function ownPid(word, depth = 0) {
  if (!OWN_PID.test(word)) return false;
  const name = word.match(/^\$\{?(\w+)\}?$/)?.[1];
  if (!name || !assigned?.has(name)) return true;
  if (!resolved.has(name)) {
    resolved.set(name, false);
    resolved.set(name, depth < 64 && assigned.get(name).every((value) => value === SUB || ownPid(value, depth + 1)));
  }
  return resolved.get(name);
}

// A pgrep whose output names processes by pattern; `pgrep -P <own pid>` lists only that process's children. Under
// xargs it takes more arguments from its input (`-v` inverts the match), so it counts as a pattern there.
function namesByPattern({ words, wrappers }) {
  if (words[0] !== "pgrep") return false;
  return !assigned || wrappers.includes("xargs") || !(words.length === 3 && words[1] === "-P" && ownPid(words[2]));
}

// `pkill -P <pid>` (plus a signal) stops this shell's own children: the one pkill that names no pattern.
function onlyOwnChildren(args) {
  let parent = false;
  for (let k = 0; k < args.length; k += 1) {
    if (args[k] === "-P" && ownPid(args[k + 1] ?? "")) {
      parent = true;
      k += 1;
    } else if (args[k] === "-s" || args[k] === "--signal") k += 1;
    else if (!/^-(?:\d+|(?:SIG)?[A-Z]+)$/.test(args[k])) return false;
  }
  return parent;
}

/** Advice, never a deny: the rules a deny would cost too much on (#N closing keywords, rebase, force-push). */
function nudges(command, cwd) {
  const notes = [];
  const commands = readable(command) ?? [];
  // Only a command that writes a PR body or a commit message; a heredoc that merely mentions one writes nothing.
  const writers = commands.filter(({ words: [head, ...args] }) => {
    if (head === "gh") return /^(?:pr|issue)$/.test(ghWords(args)[0] ?? "") && /^(?:create|edit|comment)$/.test(ghWords(args)[1] ?? "");
    return head === "git" && gitWords(args)[0] === "commit";
  });
  if (writers.length) {
    const texts = [command];
    for (const { words } of writers)
      for (let k = 1; k < words.length; k += 1) {
        const flag = words[k].match(/^(--body-file|-F|--file)(?:=(.+))?$/);
        const file = flag && (flag[2] ?? words[k + 1]);
        if (!file || file === "-") continue;
        try {
          const path = isAbsolute(file) ? file : resolve(cwd ?? process.cwd(), file);
          const stat = statSync(path);
          if (stat.isFile() && stat.size <= BODY_FILE_MAX) texts.push(readFileSync(path, "utf8"));
        } catch {}
      }
    const named = new Set();
    for (const text of texts)
      for (const m of text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)/gi)) named.add(`#${m[1]}`);
    if (named.size)
      notes.push(
        `Hard lines (nudge): this text names ${[...named].join(", ")} after a closing keyword, and GitHub closes each of them when it merges, PRs included. Keep it only for the issue this PR really closes; otherwise write "PR #N" or "see #N".`,
      );
  }
  for (const { words: [head, ...args] } of commands) {
    if (head !== "git") continue;
    const sub = gitWords(args);
    if (sub[0] === "rebase" && !sub.some((a) => /^--(?:abort|continue|quit|skip)$/.test(a)))
      notes.push(
        "Hard lines (nudge): a PR branch behind its base takes a merge of the base, never a rebase: a rebase rewrites pushed commits, needs a force-push and drops the review threads' anchors.",
      );
    if (sub[0] === "push" && sub.some((a) => /^(?:-f|--force|--force-with-lease(?:=.*)?|--force-if-includes|\+\S+)$/.test(a)))
      notes.push(
        "Hard lines (nudge): a force-push rewrites a pushed branch under its PR and every chat holding it; push new commits instead.",
      );
  }
  return [...new Set(notes)];
}

function log(chat, entry) {
  const dir = join(tmpdir(), "claude-hard-lines");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, `${chat}.log`), `${JSON.stringify(entry)}\n`);
}

advisory(async () => {
  const mode = MODES.has(process.env.RIVET_HARD_LINES) ? process.env.RIVET_HARD_LINES : "shadow";
  if (mode === "off") return;
  const input = await readStdin();
  if (input.tool_name !== "Bash") return;
  const command = String(input.tool_input?.command ?? "");
  if (!command.trim()) return;

  const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? "";
  const chat = CHAT_NAME.test(basename(root)) ? basename(root) : "unknown";
  const hits = breaches(command);
  const notes = nudges(command, input.cwd);
  if (!hits.length && !notes.length) return;

  if (hits.length) {
    try {
      log(chat, { at: new Date().toISOString(), mode, rules: hits.map((h) => h.rule), command: command.slice(0, 500) });
    } catch {}
  }
  const reasons = hits.map((h) => `Hard line (${h.rule}): ${h.reason}`);
  if (mode === "deny" && hits.length) {
    emit({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: [...reasons, ...notes].join("\n\n") });
    return;
  }
  const shadow = reasons.map((r) => `${r} (Shadow mode: this call ran. With RIVET_HARD_LINES=deny it would be refused.)`);
  emit({ hookEventName: "PreToolUse", additionalContext: [...shadow, ...notes].join("\n\n") });
});
