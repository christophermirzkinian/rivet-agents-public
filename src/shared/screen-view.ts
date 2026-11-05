// "Its screen" on the map's chat sheet: a chat's redacted terminal lines
// read as a phone reads, not as a terminal dump. It reads the lines the bridge and the server already redacted and only drops, joins and labels them, so
// an item never holds anything the lines do not. Each tool call is a short labelled line with its result under it, the
// chat's own sentences are plain text, and the terminal's noise (frames, rules, spinners, the input box, the status
// bar, tips, colour codes left over) is gone. The newest is last, as on the screen.

export type Tone = "ok" | "bad" | null;

export interface ResultLine {
  text: string;
  tone: Tone;
}

export type ScreenItem =
  /** The chat's own words; `\n` keeps a list's rows apart. */
  | { kind: "said"; text: string }
  /** A tool call: its label (Read, Bash, Edit…), what it was called on, and its result lines. */
  | { kind: "tool"; name: string; detail: string; result: ResultLine[] }
  /** A message to (`out`) or from (`in`) another chat. */
  | { kind: "message"; way: "in" | "out"; who: string; text: string }
  /** A prompt typed into the chat. */
  | { kind: "asked"; text: string }
  /** The chat is at work: its spinner line, without the spinner, shown once at the foot. */
  | { kind: "working"; text: string };

/** Colour codes and other control characters a read can leave, and the bracket halves of one cut in two. */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]|[\u0000-\u0008\u000b-\u001f\u007f]/g;
// A colour code that lost its escape (`[31m`) is plain text to both redactors, so it may sit inside a secret they let
// through in pieces: inside a word it leaves a space, never joining the pieces into a whole the masking never saw.
const BARE_SGR = /\[(?:\d{1,3};)*\d{1,3}m/g;
/** The spinner glyphs Claude Code and Codex cycle on their working line. */
const SPIN = "·✢✳✶✻✽✺✹✸✷✵✴*◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
/** The working line while at work: `✽ Puttering… (2m 48s · ↓ 9.6k tokens)`. */
const WORKING = new RegExp(`^[${SPIN}]\\s+\\S[^(]*…\\s*(?:\\((.*)\\))?\\s*$`);
/** What a turn leaves when it ends: `✻ Brewed for 32s · done 2:33 PM`. */
const DONE = new RegExp(`^[${SPIN}]\\s+\\S+\\s+for\\s+\\d+(?:\\.\\d+)?[hms]\\b`);
/** Borders and rules only, or a rule with words in it (`─ Worked for 1m ─`). */
const RULE = /^[\s─━═╌╍┄┅▔▁_—–=-]*$|^[─━═]+\s.*\s[─━═]+$/;
const BOX = /[│┃╭╮╰╯┌┐┘├┤┬┴┼║╔╗╚╝]/;
const BOXES = new RegExp(BOX.source, "g");
/** The input box, status bar and context meter at the foot of the screen. */
const FOOTER = /^(?:❯|⏵⏵|⏸|>\s*$)|bypass permissions|shift\+tab to cycle|\? for shortcuts|esc to interrupt|until auto-compact|^Context left|Restart to update|ctrl\+t to (?:hide|show)/i;
const TIP = /^(?:⎿\s*)?Tip:/;
const EXPAND = /\s*\((?:ctrl|ctrl\+o|⌃o)[^)]*to expand\)\s*$/i;
/** A tool call, `⏺ Bash(…)`, `⏺ Update(…)`, `⏺ github - get_issue (MCP)(…)`. */
const TOOL_CALL = /^([A-Za-z][\w.:-]*(?:\s+-\s+[\w.:-]+)?(?:\s+\(MCP\))?)\((.*)$/;
/** A collapsed run of tools, or one under way: `Ran 2 shell commands`, `Read 1 file, ran 4 shell commands`, `Reading ~/a.png`. */
const TOOL_RUN = /^(Ran|Running|Added|Deleted|Read|Reading|Searched|Searching|Listed|Listing|Wrote|Writing|Edited|Editing|Updated|Updating|Fetched|Fetching|Called|Calling|Explored|Exploring|Waited|Waiting for background)\s+(.+)$/;
const COUNTED = /^(?:for\s+)?\d+\s+\S+/;
const VERB: Record<string, string> = {
  Ran: "Bash",
  Running: "Bash",
  Read: "Read",
  Reading: "Read",
  Searched: "Search",
  Searching: "Search",
  Listed: "List",
  Listing: "List",
  Wrote: "Write",
  Writing: "Write",
  Edited: "Edit",
  Editing: "Edit",
  Updated: "Edit",
  Updating: "Edit",
  Fetched: "Fetch",
  Fetching: "Fetch",
  Called: "Call",
  Calling: "Call",
  Explored: "Read",
  Exploring: "Read",
  "Waiting for background": "Wait",
  Waited: "Wait",
};
const SENT = /^[“"](.+?)[”"]\s*→\s*sent to\s+([\w.@-]+)/;
const HEARD = /^›\s*Message from\s+@?([^\s:]+):\s*(.*)$/;
const LIST = /^(?:[-*•]|\d+[.)])\s/;
/** A result that passed, and one that failed; "0 failed" is a pass. */
const OK = /[✓✔]|\b(?:passed|passing|succeeded|success(?:fully)?|merged|deployed|ok)\b|\brc[ =]0\b/i;
const BAD = /[✗✘×]|\b(?:FAIL|ERR!?)\b|\b(?:error|errors|failed|failing|failure|fatal|refused|denied|not found|timed out)\b|\brc[ =][1-9]/i;
const ZERO_BAD = /\b0 (?:failed|errors?|failing)\b/gi;
const DIFF = /^\d+\s*([+-])/;

/** A line as text: no colour codes or control characters, no frame borders, no trailing space. */
export function cleanLine(raw: string): string {
  const text = raw
    .replace(ANSI, "")
    .replace(BARE_SGR, (code, at: number, all: string) => (/\S/.test(all[at - 1] ?? " ") && /\S/.test(all[at + code.length] ?? " ") ? " " : ""))
    .replace(/\t/g, "  ");
  // A framed row keeps what is in it; a line that is only a frame is a rule.
  return (BOX.test(text) ? text.replace(BOXES, " ") : text).replace(/\s+$/, "");
}

export function toneOf(text: string): Tone {
  const diff = DIFF.exec(text.trim());
  if (diff) return diff[1] === "+" ? "ok" : "bad";
  if (BAD.test(text.replace(ZERO_BAD, ""))) return "bad";
  return OK.test(text) ? "ok" : null;
}

const indentOf = (line: string) => line.length - line.trimStart().length;
/** A result line that is a shell command (`⎿  $ sed …`). */
const SHELL_UNDER = /^[⎿└]\s*\$\s/;
const resultStart = (line: string) => /^[⎿└]/.test(line.trimStart());
/** A call's bracket still open: more ( than ), as a nested `$(pwd)` wrapped leaves it, or no ) at its end. */
const unbalanced = (text: string) => {
  const opens = text.match(/\(/g)?.length ?? 0;
  const closes = text.match(/\)/g)?.length ?? 0;
  return opens > closes || (opens === closes && !text.trimEnd().endsWith(")"));
};

/** A tool's label and detail from a line that names one (no marker), or null. */
function toolOf(text: string, marked = false): { name: string; detail: string; open: boolean } | null {
  const call = TOOL_CALL.exec(text);
  if (call) {
    const inside = call[2]!;
    const open = unbalanced(`(${inside}`);
    return { name: call[1]!.replace(/\s+\(MCP\)$/, ""), detail: open ? inside : inside.replace(/\)\s*$/, ""), open };
  }
  const run = TOOL_RUN.exec(text);
  if (run && (marked || COUNTED.test(run[2]!) || /^(?:Reading|Writing|Editing|Updating|Fetching|Searching|Listing|Running|Calling|Exploring)$/.test(run[1]!) || /[/~.]/.test(run[2]!))) {
    // A run of several kinds (`Read 1 file, ran 4 shell commands`) is named as a whole.
    if (/,\s*(?:and\s+)?[a-z]+\s+\d/.test(run[2]!)) return { name: "Tools", detail: text, open: false };
    return { name: VERB[run[1]!] ?? run[1]!, detail: run[2]!, open: false };
  }
  return null;
}

/**
 * The items of a screen's redacted lines, oldest first. A spinner shows only as the one working line at the foot,
 * while the chat is at work; a repeated blank line, a frame and the foot of the screen show not at all.
 */
export function screenView(lines: readonly string[]): ScreenItem[] {
  const items: ScreenItem[] = [];
  const clean = lines.map(cleanLine);
  let current: ScreenItem | null = null;
  // A tool's detail still open across a wrap (`Bash(git push origin` then `HEAD:…)`).
  let openDetail = false;
  // Whether the tool above has begun its result, shown or not (a read's echo of its file is not).
  let resulting = false;
  let working: string | null = null;
  let blank = false;
  // Under a tip the terminal wrapped: its rest is dropped with it, up to the next line that starts something.
  let hiding = false;
  const push = (item: ScreenItem) => {
    items.push(item);
    current = item;
    openDetail = false;
    resulting = false;
    blank = false;
    hiding = false;
  };
  // Claude Code marks its items ⏺ (or ●) and Codex •. The Mac's redactor trims every indent, so on a Claude screen a
  // bullet at the left edge is a list row of the words above, not an item of its own.
  const MARKER = clean.some((line) => /^\s*[⏺●]/.test(line)) ? /^[⏺●]\s*/ : /^[⏺●•]\s*/;
  clean.forEach((line, i) => {
    const text = line.trim();
    if (!text) {
      blank = true;
      return;
    }
    if (RULE.test(text) || FOOTER.test(text) || TIP.test(text) || /^\(?(?:ctrl|ctrl\+o|⌃o)\b[^)]*to expand\)?$/i.test(text)) {
      // The input box and status bar end what came before; a rule inside a result is only a rule.
      if (FOOTER.test(text)) current = null;
      if (TIP.test(text)) {
        current = null;
        hiding = true;
      }
      return;
    }
    const tidy = text.replace(EXPAND, "");
    // A `*` row is a spinner only with its timer after it: without it, it is a list row (`* Waiting for CI…`, or
    // `* Waiting for CI… (owner approval required)`).
    const workingNow = WORKING.exec(tidy);
    if (workingNow && !(tidy.startsWith("*") && !/^\d+[hms]/.test(workingNow[1] ?? ""))) {
      const parts = (workingNow[1] ?? "").split("·").map((part) => part.trim());
      // Only the time itself: the rest of the bracket is the terminal's, and the sheet shows none of it.
      const time = parts.map((part) => /^\d+[hms](?:\s+\d+[hms])*(?=\s|$)/.exec(part)?.[0]).find(Boolean);
      working = time ? `Busy · ${time}` : "Busy";
      current = null;
      return;
    }
    if (DONE.test(tidy)) {
      working = null;
      current = null;
      return;
    }
    // A marker starts an item only at the left edge: an indented bullet is a list row.
    const marker = indentOf(line) === 0 ? MARKER.exec(text) : null;
    if (marker) {
      const body = tidy.slice(marker[0].length);
      const next = clean[i + 1]?.trim() ?? "";
      const tool = toolOf(body, true);
      // A tool under way with a shell command under it (`⏺ Reading the notes` over `⎿ $ sed …`) is a shell command.
      if (tool && !TOOL_CALL.test(body) && SHELL_UNDER.test(next)) {
        push({ kind: "tool", name: "Bash", detail: body, result: [] });
        return;
      }
      if (tool) {
        push({ kind: "tool", name: tool.name, detail: tool.detail, result: [] });
        openDetail = tool.open;
        return;
      }
      // A marker line with a result under it is a tool with no parentheses (`⏺ Stop Task`).
      if (resultStart(next) && !SENT.test(next.replace(/^[⎿└]\s*/, ""))) {
        push({ kind: "tool", name: "Tool", detail: body, result: [] });
        return;
      }
      push({ kind: "said", text: body });
      return;
    }
    const heard = HEARD.exec(tidy);
    if (heard) {
      // Rivet signs its messages with its own name: once is enough.
      const who = heard[1]!;
      push({ kind: "message", way: "in", who, text: heard[2]!.startsWith(`${who}:`) ? heard[2]!.slice(who.length + 1).trimStart() : heard[2]! });
      return;
    }
    if (/^[>›]\s*\S/.test(tidy)) {
      push({ kind: "asked", text: tidy.replace(/^[>›]\s*/, "") });
      return;
    }
    if (resultStart(text)) {
      const body = tidy.replace(/^[⎿└]\s*/, "");
      const sent = SENT.exec(body);
      if (sent) {
        push({ kind: "message", way: "out", who: sent[2]!, text: sent[1]! });
        return;
      }
      // A result at the top of the screen is the end of a tool the read cut off: it is not shown.
      if (!body || (!items.length && current === null)) return;
      // A result under a said line belongs to a tool the screen folded away.
      if (current?.kind !== "tool") push({ kind: "tool", name: "Tool", detail: "", result: [] });
      const tool = current as unknown as Extract<ScreenItem, { kind: "tool" }>;
      // A read echoes the file it read: said once.
      if (!(!resulting && body === tool.detail)) tool.result.push({ text: body, tone: toneOf(body) });
      openDetail = false;
      resulting = true;
      return;
    }
    const call = current as ScreenItem | null;
    if (call?.kind === "tool" && openDetail) {
      call.detail += ` ${tidy}`;
      openDetail = unbalanced(`(${call.detail}`);
      if (!openDetail) call.detail = call.detail.replace(/\)\s*$/, "");
      return;
    }
    // An indented line that names a tool run (`Ran 3 shell commands`), or that a result follows (a tool's own
    // description, `Probing the bubbles` over `⎿ $ cd …`), starts a tool.
    const next = clean[i + 1]?.trim() ?? "";
    const run = indentOf(line) <= 2 ? toolOf(tidy) : null;
    // A count of lines under a tool's result (`Read 40 lines`) is more of that result, its indent trimmed away.
    const more = current?.kind === "tool" && resulting && /^\w+ \d+ lines?\b/.test(tidy);
    if (run && !run.open && !more && TOOL_RUN.test(tidy)) {
      // Its marker blinks while it runs, so it reads as the marked line does.
      push(SHELL_UNDER.test(next) ? { kind: "tool", name: "Bash", detail: tidy, result: [] } : { kind: "tool", name: run.name, detail: run.detail, result: [] });
      return;
    }
    const nextBody = next.replace(/^[⎿└]\s*/, "");
    if (indentOf(line) <= 2 && resultStart(next) && !SENT.test(nextBody) && !LIST.test(tidy) && !(current?.kind === "tool" && resulting)) {
      const shell = /^\$\s/.test(nextBody);
      push({ kind: "tool", name: shell ? "Bash" : "Tool", detail: tidy, result: [] });
      return;
    }
    if (hiding) return;
    const at = current as ScreenItem | null;
    if (at?.kind === "tool") {
      if (resulting) {
        at.result.push({ text: tidy, tone: toneOf(tidy) });
        return;
      }
    }
    if (at && (at.kind === "said" || at.kind === "message" || at.kind === "asked")) {
      // A list row, or a line after a blank, keeps its break; a line the terminal wrapped joins the one before.
      at.text += LIST.test(tidy) ? `\n${tidy}` : blank ? `\n\n${tidy}` : ` ${tidy}`;
      blank = false;
      return;
    }
    // Words with nothing above them on the screen: the rest of something the read cut off.
    push({ kind: "said", text: tidy });
  });
  if (working) items.push({ kind: "working", text: working });
  return items;
}
