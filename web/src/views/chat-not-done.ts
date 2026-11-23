// Chat's "Anything I asked not done?" (the Promise keeper, Settings › Behaviours): under Chat's options, one tap lists
// every ask of his still open, the late ones first, each with its stage and its time.
import "./chat-not-done.css";

import { isFinished, type Ask } from "../../../src/shared/asks.js";
import { when } from "../../../src/shared/when.js";
import { noTimeYet, stageWord } from "../../../src/shared/words.js";
import { ApiError, getAsks } from "../api.js";
import { describe, h } from "../dom.js";
import { openSheet } from "./sheet.js";
import { flash } from "./toast.js";

const TITLE_MAX = 90;

export interface NotDoneRow {
  id: string;
  title: string;
  stage: string;
  /** "Late: due 8:30am", "Due 5:00pm" or "No time yet". */
  time: string;
  late: boolean;
}

function titleOf(ask: Ask): string {
  const first = (ask.short ?? ask.words).split("\n").find((line) => line.trim())?.trim() ?? ask.id;
  const chars = Array.from(first);
  return chars.length <= TITLE_MAX ? first : `${chars.slice(0, TITLE_MAX - 1).join("").trimEnd()}…`;
}

/**
 * His asks not finished, as the list shows them: past their time first (the longest late first), then by time, then
 * those with no time, newest first. Backlog he only OK'd from Find more work is not an ask of his words, so it stays out.
 */
export function notDone(asks: readonly Ask[], now: number): NotDoneRow[] {
  const open = asks.filter((ask) => ask.who === "owner" && !isFinished(ask.stage));
  const due = (ask: Ask) => (ask.dueAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(ask.dueAt));
  // One waiting on him is not late: as the late sweep, no chat is asked about it.
  const isLate = (ask: Ask) => ask.dueAt !== undefined && Date.parse(ask.dueAt) <= now && ask.stage !== "needs-you";
  open.sort((a, b) => Number(isLate(b)) - Number(isLate(a)) || due(a) - due(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return open.map((ask) => {
    const late = isLate(ask);
    const time = ask.dueAt === undefined ? noTimeYet() : late ? `Late: due ${when(ask.dueAt, now)}` : `Due ${when(ask.dueAt, now)}`;
    return { id: ask.id, title: titleOf(ask), stage: stageWord(ask.stage, ask.stageAt, now), time, late };
  });
}

/** The sheet's list, or its one line when nothing is left. */
export function notDoneList(rows: readonly NotDoneRow[]): HTMLElement {
  if (!rows.length) return h("p", { class: "sheet-hint" }, "Nothing. Everything you asked is done.");
  return h(
    "ul",
    { class: "chat-not-done", attrs: { "aria-label": "Not done yet" } },
    ...rows.map((row) =>
      h(
        "li",
        { class: `chat-not-done-row${row.late ? " is-late" : ""}`, attrs: { "data-ask": row.id } },
        h("span", { class: "chat-not-done-title" }, row.title),
        h("span", { class: "chat-not-done-meta" }, `${row.stage} · ${row.time}`),
      ),
    ),
  );
}

/** Reads the asks and opens the list; a refusal says why and opens nothing. */
export async function openNotDone(signedOut: () => void): Promise<void> {
  try {
    const { asks } = await getAsks();
    const rows = notDone(asks, Date.now());
    // No bare count of late ones (§3d): each late row says its own time.
    const title = rows.length ? `${rows.length} not done` : "Not done yet";
    openSheet(title, { mount: (body) => body.replaceChildren(notDoneList(rows)), unmount: () => {} });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return signedOut();
    flash(describe(error), "error");
  }
}

/** The options menu's button; `picked` closes the menu as the list opens. */
export function chatNotDoneItem(picked: () => void, signedOut: () => void): HTMLElement {
  return h(
    "button",
    {
      class: "chat-menu-item chat-not-done-open",
      attrs: { type: "button", role: "menuitem", "data-use": "chat.not-done" },
      on: {
        click: () => {
          picked();
          void openNotDone(signedOut);
        },
      },
    },
    h("span", { class: "chat-menu-grow" }, "Anything I asked not done?"),
  );
}
