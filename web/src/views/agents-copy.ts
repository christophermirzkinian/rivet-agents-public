import { rivetWords } from "../../../src/shared/names.js";
import { h } from "../dom.js";

/** How long "Copied" shows after a tap. */
export const COPIED_MS = 2_000;

/** The text into the clipboard: the Clipboard API, else a selected textarea and the old copy command. False when both are refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) throw new Error("no clipboard");
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h("textarea", { class: "agents-copy-area", attrs: { readonly: "", "aria-hidden": "true" } });
    area.value = text;
    document.body.append(area);
    area.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}

/** A copy button: its label and the text it copies, read at the tap. */
export interface CopyButton {
  label: string;
  text: () => string;
  /** While its text could not yet be true, what the note says instead of copying. */
  notYet?: () => string | null;
}

/**
 * Copy buttons: each copies its text at the tap and says "Copied" for two seconds. Refused both ways,
 * it shows the text selected, to copy by hand.
 */
export function copySummary(buttons: readonly CopyButton[]): HTMLElement {
  const note = h("span", { class: "agents-copy-note", attrs: { role: "status" } });
  const manual = h("textarea", { class: "agents-copy-manual", attrs: { readonly: "", rows: "8", "aria-label": "Summary to copy", hidden: "" } });
  let timer = 0;
  const copy = async ({ text, notYet }: CopyButton) => {
    const waiting = notYet?.();
    if (waiting) {
      window.clearTimeout(timer);
      manual.hidden = true;
      note.textContent = waiting;
      return;
    }
    const summary = rivetWords(text());
    const copied = await copyText(summary);
    window.clearTimeout(timer);
    manual.hidden = copied;
    if (copied) {
      note.textContent = "Copied";
      timer = window.setTimeout(() => (note.textContent = ""), COPIED_MS);
    } else {
      note.textContent = "Couldn't copy: hold the text below";
      manual.value = summary;
      manual.focus();
      manual.select();
    }
  };
  return h(
    "div",
    { class: "agents-copy" },
    h(
      "div",
      { class: "agents-copy-row" },
      ...buttons.map((button) => h("button", { class: "agents-copy-btn", attrs: { type: "button", "data-use": "agents.copy-summary" }, on: { click: () => void copy(button) } }, button.label)),
      note,
    ),
    manual,
  );
}
