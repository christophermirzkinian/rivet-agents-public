/** A prefix within a UTF-16 budget, without splitting a surrogate pair or adding a suffix.
 * @param {string} text
 * @param {number} max
 */
export function takeUnits(text, max) {
  if (text.length <= max) return text;
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}
