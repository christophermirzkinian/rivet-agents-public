// The worker sheet's Chat log as a feed: what the chat said or did, in plain words, newest first. It reads the lines
// the bridge already redacted (bridge/lib/redact.mjs) and only drops, joins and trims them, so an entry never holds
// anything the raw log does not. A terminal wraps one thing over several lines and repaints its footer, so the lines
// are read as entries: a line with a marker starts one, a line without continues the one before, and an entry is kept
// or hidden whole. Lines before the first marker belong to something that started above the read, so they are hidden.
// A line the terminal wrapped joins the one before with a space. A list item, or a line after one that ended a
// sentence early or was short (a heading), keeps its break, so a list stays a list. Redaction shortens lines, so a
// line that merely ends short of the screen's width is not enough.

export type FeedKind = "said" | "sent" | "heard" | "asked";

export interface FeedEntry {
  /** When the server first had the entry's first line; null for lines already there when the sheet opened. */
  at: string | null;
  kind: FeedKind;
  /** For a message: the other chat. */
  who?: string;
  text: string;
}

/** The working line Claude Code and Codex cycle spinner glyphs on (`✽ Waiting for CI…`), and what it leaves when done (`✻ Baked for 1m 8s`). */
// A `*` row is a spinner only with its timer after it: without it, it is a list row (`* Waiting for CI…`, or one with a note in brackets).
const SPINNER = /^(?:[·✢✳✶✻✽✺✹✸✷✵✴◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+(?:\S[^(]*…|\S+\s+for\s+\d+(?:\.\d+)?[hms]\b)|\*\s+(?:\S[^(]*…\s*\(\d+[hms]|\S+\s+for\s+\d+(?:\.\d+)?[hms]\b))/;
/** Box, rule and frame lines: borders only, a framed row, or a rule with words in it (`─ Worked for 1m ─`). */
const FRAME = /^[\s─━═│┃╭╮╰╯┌┐└┘├┤┬┴┼╌╍┄┅▔▁_—–=-]*$|^[│┃╭╰┌└├─━]/;
/** The input box, status bar and context meter at the foot of the screen. */
const FOOTER = /^(?:❯|⏵⏵|⏸)|bypass permissions|shift\+tab to cycle|\? for shortcuts|esc to interrupt|until auto-compact|^Context left|Restart to update/i;
const TIP = /^(?:⎿\s*)?Tip:/;
/** A tool call, `⏺ Bash(…)`, `⏺ Update(…)`, `⏺ github - get_issue (MCP)(…)`. */
const TOOL_CALL = /^⏺\s+[A-Za-z][\w.:-]*(?:\s+-\s+[\w.:-]+)?(?:\s+\(MCP\))?\(/;
/** A collapsed run of tools: `Ran 2 shell commands`, `Read 1 file, ran 4 shell commands`, `Searched for 1 pattern`. */
const TOOL_RUN = /^(?:Ran|Running|Read|Reading|Searched|Searching|Listed|Listing|Wrote|Writing|Edited|Editing|Updated|Updating|Fetched|Fetching|Found|Called|Calling)\s+(?:for\s+)?\d+\s+\S+/;
/** Codex's tool rows. */
const CODEX_TOOL = /^•\s+(?:Ran|Running|Explored|Exploring|Edited|Editing|Read|Reading|Search(?:ed|ing)?|Listed|Waited|Waiting|Called|Calling|Working|Updated Plan|Added|Deleted)\b/;
/** A numbered diff row from an edit's result. */
const DIFF = /^\d+\s+[+-]/;
const SENT = /^⎿\s*[“"](.+?)[”"]\s*→\s*sent to\s+([\w.@-]+)/;
const HEARD = /^›\s*Message from\s+@?([^\s:]+):\s*(.*)$/;
const LIST = /^(?:[-*•]|\d+[.)])\s/;
const EXPAND = /\s*\((?:ctrl|ctrl\+o|⌃o)[^)]*to expand\)\s*$/i;
/** An absolute, home or `$VAR` path of two or more parts; a word like and/or is not one. */
const PATH = /(?<![\w./$~-])(?:~|\$[A-Za-z_]\w*)?\/[\w.@<>-]+(?:\/[\w.@<>-]*)+/g;

type Start = { kind: FeedKind; text: string; who?: string } | "hide";

/** What a line starts, or null when it continues the entry before. */
function start(line: string): Start | null {
  if (SPINNER.test(line) || TIP.test(line) || FOOTER.test(line) || FRAME.test(line)) return "hide";
  const sent = SENT.exec(line);
  if (sent) return { kind: "sent", who: sent[2]!, text: sent[1]! };
  if (line.startsWith("⎿") || line.startsWith("└")) return "hide";
  const heard = HEARD.exec(line);
  if (heard) return { kind: "heard", who: heard[1]!, text: heard[2]! };
  if (TOOL_CALL.test(line) || TOOL_RUN.test(line) || CODEX_TOOL.test(line) || DIFF.test(line)) return "hide";
  if (line.startsWith("⏺") || line.startsWith("•")) return { kind: "said", text: line.slice(1) };
  if (line.startsWith(">") || line.startsWith("›")) return { kind: "asked", text: line.slice(1) };
  return null;
}

function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(PATH, (path) => path.replace(/\/+$/, "").split("/").pop() || path).replace(EXPAND, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * The feed of a log's redacted lines, newest first. `times[i]` is when line i arrived (ISO), null when unknown. An
 * entry the screen repainted shows once, at its first time; entries with no time come last, in screen order.
 */
export function logFeed(lines: readonly string[], times: readonly (string | null)[] = []): FeedEntry[] {
  const entries: FeedEntry[] = [];
  let current: FeedEntry | null = null;
  let hidden = true;
  let above = "";
  const width = Math.max(0, ...lines.map((raw) => raw.trimEnd().length));
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const begun = start(line);
    if (begun === null) {
      // A sent message's title is whole on its first line; what follows is who the chat is.
      if (!hidden && current && current.kind !== "sent") {
        const end = above.trimEnd();
        const early = end.length + 1 + line.split(" ")[0]!.length <= width && /[.:!?)]$/.test(end);
        const kept = LIST.test(line) || early || end.length < width / 2;
        current.text += `${kept ? "\n" : " "}${line}`;
        above = raw;
      }
      return;
    }
    if (begun === "hide") {
      hidden = true;
      current = null;
      return;
    }
    hidden = false;
    above = raw;
    current = { at: times[i] ?? null, kind: begun.kind, ...(begun.who ? { who: begun.who } : {}), text: begun.text };
    entries.push(current);
  });
  const seen = new Set<string>();
  const feed: FeedEntry[] = [];
  for (const entry of entries) {
    const text = tidy(entry.text);
    const key = `${entry.kind}\n${entry.who ?? ""}\n${text.replace(/\s+/g, " ")}`;
    if (!text || seen.has(key)) continue;
    seen.add(key);
    feed.push({ ...entry, text });
  }
  // Newest first by time: a status row the screen keeps in place can be newer than the rows below it.
  return feed.reverse().sort((a, b) => (a.at === b.at ? 0 : a.at === null ? 1 : b.at === null ? -1 : a.at < b.at ? 1 : -1));
}
