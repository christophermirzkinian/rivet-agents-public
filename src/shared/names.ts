
/** The monitor chat's name wherever a person reads it. Other chats go by their own chat name. */
export let RIVET_NAME = "Rivet";
/**
 * The agent's name in anything stored (a note, a thread, a label, a card's option): the build's own, which a hosted
 * machine shows as its agent's current name (rivetWords), so a rename later reads everywhere.
 */
export const STORED_NAME = RIVET_NAME;
/** A hosted agent's name until its customer names it. */
export const UNNAMED_AGENT = "Agent";
let hostedApp: string | null = null;

/** Setup's rule for a name, or a looser one (letters, numbers, spaces, hyphens, apostrophes; at most 24). */
const AGENT_NAME_RULE = /^[\p{L}\p{M}\p{N}' ’-]{1,24}$/u;
/** A host's name for the app: letters, numbers and spaces, at most 32. */
const APP_NAME_RULE = /^[\p{L}\p{M}\p{N} ]{1,32}$/u;
const checked = (rule: RegExp) => (raw: unknown): string | null =>
  typeof raw === "string" && rule.test(raw.trim()) ? raw.trim() : null;
/** The words rivetWords writes, as a whole word in any case. */
const writesWord = (name: string): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:rivet|${STORED_NAME}|${APP_NAME})(?![\\p{L}\\p{N}])`, "iu").test(name);
/**
 * An agent's name as the server and the app both take it; anything else is no name yet. One with STORED_NAME, APP_NAME
 * or the old name in it as a word is refused: with an app name beside it (Rivet and Bolt, app Bolt), each pass of
 * rivetWords would write it longer.
 */
export function checkedAgentName(raw: unknown): string | null {
  const name = checked(AGENT_NAME_RULE)(raw);
  return name === null || writesWord(name) ? null : name;
}
/**
 * A host's name for the app as the server and the app both take it; anything else keeps APP_NAME. One with APP_NAME,
 * STORED_NAME or the old name in it is refused: rivetWords writes those words, so a pass could rewrite its own output.
 */
export function checkedAppName(raw: unknown): string | null {
  const app = checked(APP_NAME_RULE)(raw);
  const lower = app?.toLowerCase() ?? "";
  return app === null || /rivet/i.test(app) || [APP_NAME, STORED_NAME].some((word) => lower.includes(word.toLowerCase())) ? null : app;
}

/**
 * A hosted machine's agent goes by its customer's name, and the app by the name its host gives it; `null` is the
 * owner's own name, and no app the build's own. Only a hosted machine's app and server set them.
 */
export function nameHostedAgent(name: string | null, app: string | null = null): void {
  // rivetWords cuts text at the app's names first, so a name those cut into one of its words (Rivetbolt, app bolt) grows too.
  const cut = name?.split(new RegExp([APP_NAME, app ?? APP_NAME].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "iu"));
  const next = cut && cut.length > 1 && writesWord(cut.join(" ")) ? UNNAMED_AGENT : (name ?? STORED_NAME);
  if (next === RIVET_NAME && app === hostedApp) return;
  RIVET_NAME = next;
  hostedApp = app;
  for (const renamed of renames) renamed();
}

const renames = new Set<() => void>();
/** Runs after each change of the agent's or the app's name until the returned stop. */
export function onRename(renamed: () => void): () => void {
  renames.add(renamed);
  return () => renames.delete(renamed);
}

/** The app's name as a person reads it: APP_NAME, or the name a hosted machine's host gives it. */
export const appName = (): string => hostedApp ?? APP_NAME;

/**
 * The old name as a word in prose: capitalised, as agents write it. Not one: a hostname, key, path or address
 * (rivet-agents, RIVET_TOKEN, /Rivet/x, Rivet@…), a web or mail address, or lowercase `rivet`, which is the CLI,
 * a chat id, a folder or a command's argument (chat names go through chatName).
 */
const OLD_NAME = /(?<![\p{L}\p{N}_./=@-])(?:Rivet|RIVET)(?![\p{L}\p{N}_/@+]|[.:][\p{L}\p{N}_])/gu;
/** STORED_NAME as a word, on OLD_NAME's edges: a hosted machine shows its agent's name for it. */
const STORED_WORD = new RegExp(`(?<![\\p{L}\\p{N}_./=@-])(?:${STORED_NAME}|${STORED_NAME.toUpperCase()})(?![\\p{L}\\p{N}_/@+]|[.:][\\p{L}\\p{N}_])`, "gu");
const ADDRESS = /(?:\b[a-z][\w+.-]*:\/\/|\bwww\.|\bmailto:)\S+/gi;

/**
 * Text as you read it: the old name in PR titles and agent-written text shows as Rivet, case kept (Rivet → Rivet,
 * RIVET → RIVET). Display only; stored text keeps its words.
 * On a hosted machine the stored STORED_NAME shows as its agent's name; the app's name, like the agent's, is kept.
 */
export function rivetWords(text: string): string {
  const storedWord = RIVET_NAME !== STORED_NAME && text.toLowerCase().includes(STORED_NAME.toLowerCase());
  if (!/rivet/i.test(text) && !storedWord && !(hostedApp !== null && text.includes(APP_NAME))) return text;
  const app = appName();
  return text.split(APP_NAME).map((part) => part.split(app).map(oldNameWords).join(app)).join(app);
}

/**
 * The old name, or a hosted agent's own name as a whole word in any case, which is kept as written: a name with the
 * old name in it (Rivet Jr) is never renamed again, so the words a pass writes are the words the next pass keeps. The
 * name's edges are never stricter than OLD_NAME's, or what one pass wrote could be renamed by the next.
 */
function oldNameOrAgent(): RegExp {
  if (RIVET_NAME === STORED_NAME) return OLD_NAME;
  const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const anyCase = [...RIVET_NAME].map((c) => `(?:${[...new Set([c, c.toLowerCase(), c.toUpperCase()])].map(literal).join("|")})`).join("");
  return new RegExp(`(?<![\\p{L}\\p{N}])(${anyCase})(?![\\p{L}\\p{N}])|${OLD_NAME.source}|${STORED_WORD.source}`, "gu");
}

/** A build whose app is named for the old name (APP_NAME) keeps that name a product's, never the agent's. */
function oldNameWords(text: string): string {
  const pattern = oldNameOrAgent();
  const words = (part: string) =>
    part.replace(pattern, (word, kept: unknown) => (typeof kept === "string" ? kept : word === word.toUpperCase() ? RIVET_NAME.toUpperCase() : RIVET_NAME));
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
  return chat.replace(/(?<![a-z0-9])rivet(?![a-z0-9])/g, () => RIVET_NAME.toLowerCase());
}
