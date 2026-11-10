import "./agents.css";

import { isGotIt, isUpdate } from "../../../src/shared/answers.js";
import { kanban, type KanbanCard } from "../agents-logic.js";
import { copySummaryText } from "../agents-summary.js";
import { freshPrs, opsData } from "../ops-data.js";
import { app, boardRead, crewLapsed, deck, laterCards } from "../state.js";
import { copySummary } from "./agents-copy.js";
import { READ_WORDS } from "./progress-mark.js";

// Every agent chat as one list, read by the Copy summary on Rivet's sheet.

/** The cards waiting on you: the deck and your Later ones, no update or Got it cards (the desks' Rivet pop-up reads the same). */
export const needs = () => [...deck(), ...laterCards()].filter((need) => !isUpdate(need) && !isGotIt(need));

/** Every agent chat as the app holds it now. */
export function cards(now = Date.now()): KanbanCard[] {
  const board = app.board?.board;
  const ops = opsData.ops;
  return kanban({
    now,
    // A crew snapshot past its age says nothing about who is open now (as the desks read it).
    workers: crewLapsed() ? [] : (app.workers?.workers ?? []).filter((worker) => !worker.rivet),
    chats: board?.chats ?? [],
    coming: board?.coming ?? [],
    cards: needs(),
    prs: ops ? freshPrs(ops) : null,
    prsFailed: ops?.github?.sources?.prs.failed ?? [],
    timeline: opsData.timeline,
    ownerHolds: opsData.ownerHolds,
    claims: null,
  });
}

/** Rivet's sheet: one Copy summary, on a phone and a computer alike. */
export function copyButtons(): HTMLElement {
  return copySummary([
    {
      label: "Copy summary",
      text: () => copySummaryText(cards(), needs(), Date.now()),
      // Before a board is read it would say nothing is new: the desk's words instead.
      notYet: () => {
        const read = boardRead();
        return read === "loaded" ? null : READ_WORDS[read];
      },
    },
  ]);
}
