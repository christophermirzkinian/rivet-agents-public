// What a card may hold: the fields the app draws or the server reads. The server's schema keeps a field it does not know
// (rivet/src/shared/board.ts needSchema is passthrough, so a stored card always reads), and the app draws none of them:
// on 25 Nov 2026 four cards went up with their words in `heading` and `bullets`, their pictures in each option's `image`
// and the ask's id as their `ask`, and the owner saw no description and no pictures. So a write that brings one is
// refused, on the sending CLI and on the server, naming the field and what to use instead.

/** needSchema's own fields (test/card-fields.test.ts holds the lists to it). */
export const CARD_FIELDS = [
  "id", "kind", "title", "ask", "chat", "since", "pr", "issue", "repo", "headSha", "risk", "options", "reply", "replyTo", "askId", "push", "links", "media",
  "steps", "thread", "tag", "comments", "points", "size", "eta", "evidence", "again", "inChat",
];
/** What a card also carries: the schedule a news card is about, and what a board read serves with it. */
export const CARD_EXTRAS = ["schedule", "rev", "seen"];
export const OPTION_FIELDS = ["label", "short", "detail", "recommended", "text"];
export const LINK_FIELDS = ["label", "url", "primary"];

const ASK_TEXT = 'put it in the ask text (--ask or --ask-file), bullets as lines starting "- "';
const STILL = "put each picture on the card with --still <file>, one per option in the options' order";
const ASK_ID = "name the ask with --ask-id a-N (askId in the JSON)";

/** What to use instead of a field, by its name in lower case with no "_" or "-". @type {Record<string, string>} */
const CARD_INSTEAD = {
  ...Object.fromEntries(["heading", "headings", "subtitle", "bullets", "body", "description", "desc", "summary", "detail", "details", "text", "items", "notes"].map((name) => [name, ASK_TEXT])),
  ...Object.fromEntries(["image", "images", "still", "stills", "picture", "pictures", "photo", "photos"].map((name) => [name, STILL])),
  ...Object.fromEntries(["video", "before", "after", "poster"].map((name) => [name, "put the clip on the card with --after <file> (and --before <file>)"])),
  ...Object.fromEntries(["askid", "askref"].map((name) => [name, ASK_ID])),
  option: "use options (--option)",
  choices: "use options (--option)",
  link: "use links (--link)",
  url: "use links (--link)",
  replyto: "use replyTo (--reply-to)",
};
/** @type {Record<string, string>} */
const OPTION_INSTEAD = {
  ...Object.fromEntries(["image", "images", "still", "stills", "picture", "photo"].map((name) => [name, STILL])),
  ...Object.fromEntries(["description", "desc", "body", "bullets", "subtitle", "heading"].map((name) => [name, "use its detail (--detail)"])),
  id: "leave it out: an option is known by its label",
  value: "leave it out: an option is known by its label",
  title: "use its label",
  name: "use its label",
};

/** @typedef {(field: string, a: unknown, b: unknown) => boolean} Same */

/** @param {unknown} value @returns {string} JSON with every object's keys in order */
const canonical = (value) =>
  JSON.stringify(value ?? null, (_key, field) =>
    field && typeof field === "object" && !Array.isArray(field) ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : field,
  );

/** @param {string} field */
const plain = (field) => field.toLowerCase().replace(/[_-]/g, "");

/** The instead for `field`, else the fields there are. @param {Record<string, string>} instead @param {string} field @param {string[]} known */
function insteadOf(instead, field, known) {
  const name = plain(field);
  return Object.hasOwn(instead, name) ? instead[name] : `use one of ${known.join(", ")}`;
}

/**
 * A field's name as a refusal shows it. It is the sender's own text, so only a name the hints know or a plain word
 * ("wibble", "lookBook"): a key has digits, capitals or dashes.
 * @param {string} field @param {Record<string, string>} instead
 */
const shown = (field, instead) => (field.length <= 24 && (Object.hasOwn(instead, plain(field)) || /^[a-z]+(?:[A-Z][a-z]+)*$/.test(field)) ? field : "with that name");

/**
 * The fields of `row` the card does not have. One the same part of the stored card already holds as it is passes, so a
 * card stored before this rule can still be changed; a null (card edit --unset) takes the field off.
 * @param {any} row @param {any[]} stored @param {string[]} known @param {string[]} allowed @param {Same} same
 */
function unknownFields(row, stored, known, allowed, same) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return [];
  return Object.keys(row).filter(
    (field) => !known.includes(field) && !allowed.includes(field) && row[field] !== undefined && !stored.some((one) => one && Object.hasOwn(one, field) && same(field, one[field], row[field])),
  );
}

/** @param {unknown} text @returns {string} its words alone, in lower case */
const words = (text) => String(text ?? "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();

/**
 * An ask's id and nothing said about it: "a-1014", "Ask a-1014, option B", or the id and one of the card's option labels.
 * @param {unknown} ask @param {unknown[]} [labels]
 */
export function isAskIdOnly(ask, labels = []) {
  const id = typeof ask === "string" ? /^[^\p{L}\p{N}]*(?:ask[^\p{L}\p{N}]+)?a-\d+(?![\p{L}\p{N}])/iu.exec(ask) : null;
  if (!id) return false;
  const rest = words(String(ask).slice(id[0].length));
  const said = rest.replace(/^(?:option|opt|choice)(?: |(?=\d)|$)/, "");
  return said === "" || /^[a-z0-9]{1,2}$/.test(said) || (said !== rest && !said.includes(" ")) || labels.some((label) => [rest, said].includes(words(label)));
}

const GOT_IT = "Got it";
/** A card that asks for a choice, so it needs words on it; news (one option, Got it) says it all in its title. @param {any} card */
const needsWords = (card) =>
  (card?.kind === "decision" && !(Array.isArray(card.options) && card.options.length === 1 && card.options[0]?.label === GOT_IT)) || card?.kind === "choice";
/** @param {any} card */
const hasWords = (card) => [card?.ask, card?.evidence?.why].some((text) => typeof text === "string" && text.trim() !== "");

/**
 * Why `card` is not taken: every field it, its options or its links do not have, an ask that is only an ask's id, and a
 * decision or choice with no description. `stored` is the card before the write: only what the write changes is judged.
 * `whole`: the card is all of itself, so a missing description is missing (a card edit's body is not). `titled`: a card that
 * may be its title alone (say.mjs). `clean`: what storing a card does to its text, so a stored field the write sends back
 * reads the same whichever side it was done on.
 * @param {any} card @param {{ stored?: any, whole?: boolean, titled?: boolean, clean?: (row: any) => any }} [opts] @returns {string[]}
 */
export function cardFieldRefusals(card, { stored, whole = true, titled = false, clean = (row) => row } = {}) {
  /** @type {Same} */
  const same = (field, a, b) => canonical(clean({ [field]: a })) === canonical(clean({ [field]: b }));
  const list = (/** @type {unknown} */ value) => (Array.isArray(value) ? value : []);
  /** @type {string[]} */
  const out = [];
  const body = whole ? card : Object.fromEntries(Object.entries(card ?? {}).filter(([, value]) => value !== null));
  // Its words are judged as they would be stored, so text that cleans away to nothing is no description.
  const read = clean(body);
  for (const field of unknownFields(body, [stored], CARD_FIELDS, CARD_EXTRAS, same)) out.push(`a card has no field ${shown(field, CARD_INSTEAD)}: ${insteadOf(CARD_INSTEAD, field, CARD_FIELDS)}`);
  // News (an update card) is stored with options of the server's own, so the schema never reads the ones it brings.
  if (body?.options != null && !Array.isArray(body.options)) out.push("options is not a list: use a list of { label }, or --option for each");
  list(body?.options).forEach((option, i) => {
    if (!option || typeof option !== "object" || Array.isArray(option)) out.push(`option ${i + 1} is not an option: use { label }, or --option`);
    const there = list(stored?.options).filter((one) => same("label", one?.label, option?.label));
    for (const field of unknownFields(option, there, OPTION_FIELDS, [], same)) out.push(`option ${i + 1} has no field ${shown(field, OPTION_INSTEAD)}: ${insteadOf(OPTION_INSTEAD, field, OPTION_FIELDS)}`);
  });
  list(body?.links).forEach((link, i) => {
    const there = list(stored?.links).filter((one) => same("label", one?.label, link?.label));
    for (const field of unknownFields(link, there, LINK_FIELDS, [], same)) out.push(`link ${i + 1} has no field ${shown(field, {})}: use one of ${LINK_FIELDS.join(", ")}`);
  });
  const labels = list(read?.options ?? clean(stored)?.options).map((one) => one?.label);
  if (isAskIdOnly(read?.ask, labels) && !same("ask", body.ask, stored?.ask)) out.push(`the ask text is only an ask's id: ${ASK_ID}, and say in --ask what the card asks`);
  else if (whole && !titled && needsWords(read) && !hasWords(read) && !(stored && needsWords(stored) && !hasWords(clean(stored))))
    out.push(`a ${card.kind} card needs a description: say in --ask (or --ask-file) what it asks, bullets as lines starting "- "`);
  return out;
}

/** The refusals one line names; the rest are counted, as a card can bring any number of fields. */
const LISTED = 6;
/** @param {string[]} lines @param {string} what */
const listed = (lines, what) => [...lines.slice(0, LISTED), ...(lines.length > LISTED ? [`and ${lines.length - LISTED} more ${what}`] : [])].join("; ");

/** One line for a refused write; the id is the sender's text too. @param {unknown} id @param {string[]} refusals */
export const cardFieldsLine = (id, refusals) => `card ${String(id ?? "").slice(0, 100)}: ${listed(refusals, "problems")}`;

/** One line for a write with several refused cards, each its cardFieldsLine. @param {string[]} lines */
export const cardsFieldsLine = (lines) => listed(lines, "cards");
