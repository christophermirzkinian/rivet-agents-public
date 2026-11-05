import { stopDictation } from "../dictation.js";
import { navigated } from "../state.js";
import { closeAnswerSheet } from "./feed.js";
import { leaveLightbox } from "./lightbox.js";
import { closeSheet, leaveTallSheet } from "./sheet.js";
import { closeWorkerSheet } from "./worker-sheet.js";

let pending: { next: () => void } | null = null;

/** Opens a destination after the overlays and their Back traversals have gone; the latest request wins. */
export function leaveOverlays(next: () => void): void {
  // A request supersedes older reads immediately, even while an overlay's Back is still in flight.
  navigated();
  stopDictation();
  dismissOverlays(next);
}

/** Drops a destination still waiting on an overlay's Back: a sign-out means nothing opens after it. */
export function dropLeave(): void {
  if (pending) pending.next = () => {};
}

function dismissOverlays(next: () => void): void {
  if (pending) {
    pending.next = next;
    return;
  }
  const request = { next };
  pending = request;
  // A viewer can sit over a sheet. Restore their inert state from the outside in.
  leaveLightbox(() => {
    closeSheet();
    closeWorkerSheet();
    closeAnswerSheet();
    leaveTallSheet(() => {
      pending = null;
      request.next();
    });
  });
}
