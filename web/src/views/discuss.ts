import { button } from "../dom.js";
import { app, changed } from "../state.js";
import { startDraft } from "./chat.js";
import { closeSheet } from "./sheet.js";
import { flash } from "./toast.js";

// Discuss this on an item's pop-up: a new Rivet
// chat message that starts by naming the item, the keyboard up for his comment. The name rides in the message itself,
// so Rivet gets it like any other.

/**
 * Board text inside the message: one line, no quote marks of its own, so it reads as a quoted name, never as the owner. The
 * bridge turns curly and angle quotes and double quotes into apostrophes, so an apostrophe of its own becomes ’, which it leaves alone.
 * Control characters go too: an unfinished escape sequence would make the bridge drop the rest of the line.
 */
export const quoted = (text: string) => `“${text.replace(/[\s“”"\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/['\u00ab\u00bb]/g, "’").trim()}”`;

/** The start of the message: `About “<title>” (<kind>, <refs>): `, refs such as `PR #23` left out when absent. */
export function discussPrefix(title: string, kind: string, refs: readonly (string | null | undefined)[] = []): string {
  return `About ${quoted(title)} (${[kind, ...refs].filter(Boolean).join(", ")}): `;
}

/** Why a message, `over` characters past the most Chat takes once tagged, was kept rather than sent. */
export const tooLong = (over: number) => `Not sent: ${over} ${over === 1 ? "character" : "characters"} too long with the chat's tag. Shorten it and send again.`;

/**
 * The button beside Close: closes the pop-up (`close`) and opens Chat on a new conversation started with `prefix`. An
 * unsent message too long to take the prefix stays as it is, and a toast says the item is not in it.
 */
export function discussButton(prefix: string, close: () => void = closeSheet): HTMLButtonElement {
  return button(
    "Discuss this",
    () => {
      close();
      const named = startDraft(prefix);
      app.tab = "chat";
      changed();
      if (!named) flash("Your unsent message is too long to add this item to. Send or shorten it first.", "warn", 5000);
    },
    "primary discuss-this",
    false,
    "chat.discuss",
  );
}
