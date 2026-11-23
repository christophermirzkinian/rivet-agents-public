// The "3 designs" button (shared/designs.ts), on a card and at the menu's foot. It shows only once a Settings ›
// Behaviours list has said the row is on: chat-prefs.ts reads that list at sign-in and after each save.
import { isGotIt, isUpdate } from "../../../src/shared/answers.js";
import type { BehaviourRow } from "../../../src/shared/behaviours.js";
import { THREE_DESIGNS_ID, type DesignScreen } from "../../../src/shared/designs.js";
import * as api from "../api.js";
import { onSessionReset, StaleSession } from "../session.js";
import { app, changed } from "../state.js";
import { flash } from "./toast.js";

let on = false;
onSessionReset(() => {
  on = false;
});

export const designsOn = (): boolean => on;

/** A card offers the button while the row is on and the card waits on a decision: never an update, nor a Got it card, which leaves the board's open list. */
export const designsFor = (need: Parameters<typeof isGotIt>[0]): boolean => on && !isUpdate(need) && !isGotIt(need);

/** Follows the row from a Behaviours list or a save. */
export function noteDesignsRow(row: BehaviourRow): void {
  if (row.id !== THREE_DESIGNS_ID) return;
  const next = row.value?.on === true;
  if (next === on) return;
  on = next;
  changed();
}

/** The screen on now, as the menu lights it: Main (the home screen) under a menu page that is not open. */
export function screenOnNow(): DesignScreen {
  if (app.tab === "chat" || app.tab === "cards") return app.tab;
  if (app.tab === "more" && app.morePage) return app.morePage;
  return "main";
}

const clientId = () => crypto.randomUUID().replace(/-/g, "");

export async function askDesigns(from: { card: string } | { screen: DesignScreen }): Promise<void> {
  try {
    const got = await api.postDesigns({ clientId: clientId(), ...from });
    flash(got.already ? `Already asked: ${got.ask}` : "Asked for 3 designs");
  } catch (error) {
    if (error instanceof StaleSession) return;
    flash(error instanceof api.ApiError ? error.message : "Couldn't ask for 3 designs. Try again.", "error");
  }
}
