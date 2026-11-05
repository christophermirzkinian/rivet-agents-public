// A whole GitHub token after padding of each kind a cut before redaction has met, the padding's length swept
// across a site's limit, and a check that what reaches Rivet shows neither the token nor a head of it. The token is
// built at runtime so the source holds none.
const fakeGh = (/** @type {string} */ tail) => ["gh", "p_"].join("") + tail;
export const TOKEN = fakeGh("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");

const fill = (/** @type {string} */ unit, /** @type {number} */ n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
/** @type {Record<string, (n: number) => string>} */
const PADDINGS = {
  spaces: (n) => " ".repeat(n),
  lines: (n) => fill("x\n", n),
  feff: (n) => String.fromCharCode(0xfeff).repeat(n),
  zwsp: (n) => String.fromCharCode(0x200b).repeat(n),
  paths: (n) => fill(`${["", "Users", ""].join("/")}alice/ `, n),
};

/** Each padding kind at every length from `limit` - 60 to `limit` + 20. @param {number} limit */
export function* paddings(limit) {
  for (const [kind, pad] of Object.entries(PADDINGS)) {
    for (let n = Math.max(0, limit - 60); n <= limit + 20; n++) yield { kind, n, padding: pad(n) };
  }
}

const HEAD = new RegExp(`${fakeGh("")}[A-Za-z0-9]{0,35}(?![A-Za-z0-9])`);
/** Whether `said` shows the token, or a head of it too short for any redaction to recognise. @param {unknown} said */
export function showsToken(said) {
  const text = typeof said === "string" ? said : JSON.stringify(said);
  return text.includes(TOKEN) || HEAD.test(text);
}
