// Whether code may act on a card's answer. POST /api/replies stamps every answer from the session that gave it, never
// from its body: `item.passkey` for one a passkey made, `item.via: "device-code"` for one a device code alone made, which
// changes nothing that outlives "Sign out desktop apps".

/** An answer with no stamp never acts: this is before any server stored one. */
export const UNMARKED_ANSWERS_UNTIL = "2000-01-01T00:00:00.000Z";

/**
 * Everything that acts on an answer by code asks this first; a refused answer is words only. `at` is the server's own
 * time for it, never the answering client's.
 * @param {{ at?: string, item?: any } | null | undefined} reply
 */
export function mayActByCode(reply) {
  if (reply?.item?.via !== undefined) return false;
  if (reply?.item?.passkey !== undefined) return reply.item.passkey === true;
  return typeof reply?.at === "string" && Date.parse(reply.at) < Date.parse(UNMARKED_ANSWERS_UNTIL);
}
