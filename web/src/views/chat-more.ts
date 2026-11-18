// An exchange's More: his question on top, then Listen, Read all, Share and Not an answer, on the shared bottom sheet.
import { RIVET_NAME } from "../../../src/shared/names.js";
import { h, svg } from "../dom.js";
import { say } from "../voice.js";
import { closeSheet, openSheet } from "./sheet.js";

const LISTEN = '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>';
const READ_ALL =
  '<svg viewBox="0 0 24 24"><path d="M5 6h14M5 10h14M5 14h14M5 18h9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const SHARE =
  '<svg viewBox="0 0 24 24"><path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M6 12v7.5h12V12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const NOT_ANSWER =
  '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export interface MoreFor {
  /** His question, the sheet's top line. */
  question: string;
  /** Rivet's answer to read aloud; null when it has no words. */
  listen: string | null;
  /** Opens the exchange's conversation; null on that conversation's own page. */
  readAll: (() => void) | null;
  /** Today's Share; null when the answer may not leave the app. */
  share: (() => void) | null;
  /** Asks Rivet his question again; null unless Rivet's last line answers one of his. */
  notAnswer: (() => void) | null;
}

function row(icon: string, title: string, sub: string, use: string, go: () => void): HTMLElement {
  return h(
    "button",
    {
      class: `chat-more-row ${use.replace(/\./g, "-")}`,
      attrs: { type: "button", "data-use": use },
      on: {
        click: () => {
          closeSheet();
          go();
        },
      },
    },
    h("span", { class: "chat-more-icon", attrs: { "aria-hidden": "true" } }, svg(icon, "btn-icon")),
    h("span", { class: "chat-more-words" }, h("strong", {}, title), h("small", {}, sub)),
  );
}

export function openMore(more: MoreFor): void {
  const { listen, readAll, share, notAnswer } = more;
  openSheet(
    more.question,
    {
      mount: (el) =>
        el.replaceChildren(
          ...[
            listen ? row(LISTEN, "Listen", `${RIVET_NAME} reads this answer aloud`, "chat.more.listen", () => say(listen)) : null,
            readAll ? row(READ_ALL, "Read all", "Open the full answer and its details", "chat.more.read-all", readAll) : null,
            share ? row(SHARE, "Share", "Share this answer", "chat.more.share", share) : null,
            notAnswer ? row(NOT_ANSWER, "Not an answer", `${RIVET_NAME} looks at your question again`, "chat.more.not-answer", notAnswer) : null,
          ].filter((one): one is HTMLElement => one !== null),
        ),
      unmount: () => {},
    },
    "Close",
    undefined,
    { className: "chat-more-sheet", use: "chat.more" },
  );
}
