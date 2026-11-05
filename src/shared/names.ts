
/** The monitor chat's name wherever a person reads it. Other chats go by their own chat name. */
export const RIVET_NAME = "Rivet";

/**
 * The old name as a word in prose: capitalised, as agents write it. Not one: a hostname, key, path or address
 * (rivet-agents, RIVET_TOKEN, /Rivet/x, Rivet@…), a web or mail address, or lowercase `rivet`, which is the CLI,
 * a chat id, a folder or a command's argument (chat names go through chatName).
 */
const OLD_NAME = /(?<![\w./=@-])(?:Rivet|RIVET)(?![\w/@+]|[.:]\w)/g;
const ADDRESS = /(?:\b[a-z][\w+.-]*:\/\/|\bwww\.|\bmailto:)\S+/gi;

/**
 * Text as you read it: the old name in PR titles and agent-written text shows as Rivet, case kept (Rivet → Rivet,
 * RIVET → RIVET). Display only; stored text keeps its words.
 */
export function rivetWords(text: string): string {
  if (!/rivet/i.test(text)) return text;
  const words = (part: string) => part.replace(OLD_NAME, (word) => (word === word.toUpperCase() ? RIVET_NAME.toUpperCase() : RIVET_NAME));
  let out = "";
  let from = 0;
  for (const address of text.matchAll(ADDRESS)) {
    out += words(text.slice(from, address.index)) + address[0];
    from = address.index + address[0].length;
  }
  return out + words(text.slice(from));
}

/** What a stored-text search looks for: the words you typed, and with Rivet as the old name stored text may still say. */
export function searchNeedles(query: string): [string, string] {
  return [query, query.replace(/\brivet\b/gi, "Rivet")];
}

/** The app's name on the Home Screen, the sign-in page and the header. */
export const APP_NAME = "Rivet Agents";

/**
 * A chat as a person reads it: the monitor's `rivet` chat is Rivet, and a chat named for the old name (rivet-coming) reads rivet-coming; others go by their chat name.
 */
export function chatName(chat: string): string {
  if (chat === "rivet") return RIVET_NAME;
  return chat.replace(/(?<![a-z0-9])rivet(?![a-z0-9])/g, RIVET_NAME.toLowerCase());
}
