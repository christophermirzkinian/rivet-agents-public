// Screen checks for a chat the runner types into. A line typed over Claude Code's "Held message from another session"
// dialog goes to the dialog, and its Enter picks Deny: the line is gone. A line goes in only once the dialog is gone.

/** The dialog sits at the bottom of the screen; anything higher is chat text that quotes it. */
const DIALOG_ROWS = 20;

/** @param {unknown[]} tail @returns {string[]} */
const bottomRows = (tail) => tail.filter((row) => typeof row === "string").slice(-DIALOG_ROWS);

/**
 * The dialog is up when both its options sit at the bottom of the screen.
 * @param {unknown[]} tail
 */
export function holdDialogUp(tail) {
  const rows = bottomRows(tail);
  return rows.some((row) => row.includes("Deny — drop it")) && rows.some((row) => row.includes("Deliver this message to Claude"));
}

/**
 * The input box is on screen with nothing in it: a line stuck there would be sent twice by a retry, so anything else
 * (text, a paste placeholder, another dialog, a session still starting) says no. The box is the lowest prompt row: a
 * bare one higher up is only chat output.
 * @param {unknown[]} tail
 */
export function promptEmpty(tail) {
  const box = bottomRows(tail).filter((row) => /^\s*❯/.test(row)).at(-1);
  return box !== undefined && /^\s*❯\s*$/.test(box);
}
