// A line's More: the line on top, then Read aloud, Copy, Share and Open card, on the shared bottom sheet.
import { h, svg } from "../dom.js";
import { say } from "../voice.js";
import { copyText } from "./agents-copy.js";
import { closeSheet, openSheet } from "./sheet.js";
import { flash } from "./toast.js";

const LISTEN = '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>';
const COPY =
  '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>';
const SHARE =
  '<svg viewBox="0 0 24 24"><path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M6 12v7.5h12V12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CARD =
  '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M8 10h8M8 14h5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

export interface MoreFor {
  /** The line, the sheet's top line. */
  line: string;
  /** Rivet's words to read aloud; null on his own line or one with no words. */
  listen: string | null;
  /** The words Copy puts on the clipboard; null with none. */
  copy: string | null;
  /** Today's Share; null when the line may not leave the app. */
  share: (() => void) | null;
  /** Opens the line's card; null when it has none on the board. */
  card: (() => void) | null;
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
  const { listen, copy, share, card } = more;
  openSheet(
    more.line,
    {
      mount: (el) =>
        el.replaceChildren(
          ...[
            listen ? row(LISTEN, "Read aloud", "Hear this line", "chat.more.listen", () => say(listen)) : null,
            copy
              ? row(COPY, "Copy", "Copy this line's words", "chat.more.copy", () =>
                  void copyText(copy).then((done) => flash(done ? "Copied" : "Couldn't copy.", done ? "ok" : "error")),
                )
              : null,
            share ? row(SHARE, "Share", "Share this line", "chat.more.share", share) : null,
            card ? row(CARD, "Open card", "Open the card it came with", "chat.more.card", card) : null,
          ].filter((one): one is HTMLElement => one !== null),
        ),
      unmount: () => {},
    },
    "Close",
    undefined,
    { className: "chat-more-sheet", use: "chat.more" },
  );
}
