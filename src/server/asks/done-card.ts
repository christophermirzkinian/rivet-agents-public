import { DECISION, GOT_IT } from "../../shared/answers.js";
import { doneCardText, MAX_DONE_ITEM, MAX_DONE_ITEMS, type Ask } from "../../shared/asks.js";
import { ID_PATTERN, type Media } from "../../shared/board.js";
import type { RouteDeps } from "../routes/router.js";
import type { ShortTitles } from "../short-titles.js";
import type { Store } from "../store.js";

// The card an ask's move into done posts: one Got it, no push, no PR, once per ask. It reads on its own: what was
// asked, what is done in up to three short items, and the closer's still or clip when it gave one. Best effort: a
// card that fails is logged and never fails the move.

/** What the closer said of the move: its note, its done items and its still or clip. */
export interface DoneDetails {
  note?: string;
  done?: readonly string[];
  media?: Media;
}

/** Called with an ask before and after a write; posts the done card when the write moved it into done. */
export type AskDone = (before: Ask, after: Ask, details?: string | DoneDetails) => void;

export interface DoneCardDeps {
  store: Pick<Store, "answeredCards">;
  addUpdate: RouteDeps["addUpdate"];
  titles: Pick<ShortTitles, "of">;
  logger: Pick<Console, "error">;
  now(): Date;
}

export function doneCardPoster({ store, addUpdate, titles, logger, now }: DoneCardDeps): AskDone {
  return (before, after, details) => {
    if (before.stage === "done" || after.stage !== "done") return;
    const id = doneCardId(after.id);
    try {
      // An answered card has left the board, so its answer is what says it was posted.
      if (store.answeredCards([id]).size) return;
      const card = doneCard(after, titles.of(after.words, undefined, now()), details);
      let added = addUpdate(card, { progress: true, silent: true });
      // A still or clip the board refuses (never uploaded, say) must not cost the owner the card: it goes without it.
      if (added.status !== 200 && added.status !== 409 && card.media !== undefined) {
        const refusal = added.error ?? added.status;
        const { media: _media, ...plain } = card;
        added = addUpdate(plain, { progress: true, silent: true });
        if (added.status === 200 || added.status === 409) logger.error(`[board] done card ${id} posted without its media: ${refusal}`);
      }
      if (added.status !== 200 && added.status !== 409) logger.error(`[board] done card ${id} refused: ${added.error ?? added.status}`);
    } catch (error) {
      logger.error(`[board] done card ${id} failed: ${error instanceof Error ? error.message : "error"}`);
    }
  };
}

/** Words a card never says to the owner. A floor for the fallback line only: the closer's own items are the closer's to word. */
const NOT_CARD_COPY = /\b(?:live|refund(?:s|ed|ing)?|rivet)\b/i;

export const doneCardId = (askId: string): string => `ask-${askId}-done`;

const line = (text: string): string => {
  const folded = text.replace(/\s+/g, " ").trim();
  return folded.length > MAX_DONE_ITEM ? `${folded.slice(0, MAX_DONE_ITEM - 1)}…` : folded;
};

/** What a done card says is done: the closer's items, else the move's note, else the ask's last why. */
export function doneItems(ask: Pick<Ask, "why">, details?: string | DoneDetails): string[] {
  const { note, done } = typeof details === "string" ? { note: details } : (details ?? {});
  const said = (done ?? []).map(line).filter(Boolean).slice(0, MAX_DONE_ITEMS);
  // The note and the why were written for another reader and passed no word rule: one the card may not say is left out.
  return said.length ? said : [note, ask.why].map((text) => line(text ?? "")).filter((text) => text && !NOT_CARD_COPY.test(text)).slice(0, 1);
}

/**
 * "Done: <short title>" in the ask's conversation. Its text is "You asked: <his words, one short line>", then what is
 * done: the closer's items, else the move's own note, else the ask's last why; one sits on the Done line, more are "- "
 * lines under it. With none of them the card still says what was asked.
 */
export function doneCard(ask: Ask, title: string, details?: string | DoneDetails): { id: string; media?: Media } & Record<string, unknown> {
  const media = typeof details === "string" ? undefined : details?.media;
  const items = doneItems(ask, details);
  return {
    id: doneCardId(ask.id),
    kind: DECISION,
    title: `Done: ${title}`,
    // An ask taken from the backlog is in the server's words ("Start work on …"), never words of the owner's own.
    ask: doneCardText(line(ask.words), items, ask.who === "owner" && !ask.source?.startsWith("backlog:")),
    options: [{ label: GOT_IT }],
    push: "fyi",
    ...(media ? { media } : {}),
    ...(ask.repo ? { repo: ask.repo } : {}),
    ...(ask.chat !== undefined && ID_PATTERN.test(ask.chat) ? { chat: ask.chat } : {}),
    ...(ask.replyId !== undefined && ID_PATTERN.test(ask.replyId) ? { replyTo: ask.replyId } : {}),
  };
}
