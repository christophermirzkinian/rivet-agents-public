import "./queue-cards.css";

import {
  chatRepo,
  comingChatRepo,
  COMING_STAGES,
  STAGE_LABELS,
  type ComingItem,
  type ComingStage,
  type Repo,
} from "../../../src/shared/board.js";
import { NO_REPO } from "../../../src/shared/repos.js";
import { cleanComing, comingDone, comingQuietMs, COMING_QUIET_MS, COMING_STALE_MS } from "../../../src/shared/summary.js";
import { h } from "../dom.js";

// Coming items and the card helpers they share. A Coming item's sheet keeps its bar through building → review → your
// OK → merging → deploying → shipped.

export { STAGE_LABELS };
export { cleanComing, comingDone, comingQuietMs, COMING_QUIET_MS, COMING_STALE_MS };

const KINDS: Record<string, string> = { approval: "Approval", decision: "Decision", question: "Question", todo: "Do it", "merge-ready": "MERGE READY", plan: "Plan" };

export function kindClass(kind: string): string {
  return KINDS[kind] ? `k-${kind}` : "k-other";
}

/** "no update for 3 h", in days from two days on; null under COMING_QUIET_MS. */
export function quietText(ms: number | null): string | null {
  if (ms === null || ms < COMING_QUIET_MS) return null;
  const hours = Math.floor(ms / 3600_000);
  return hours < 48 ? `no update for ${hours} h` : `no update for ${Math.floor(hours / 24)} d`;
}

/** The stage as the row and the sheet name it: "Merged" once GitHub saw the PR merged. */
export function stageLabel(item: ComingItem): string | null {
  return typeof item.mergedAt === "string" ? "Merged" : item.stage ? STAGE_LABELS[item.stage] : null;
}

/** The bar's fill, 0 to 1: `progress` kept inside the stage's share of the bar, or the middle of the stage. */
export function comingFill(item: Pick<ComingItem, "stage" | "progress">): number | null {
  const n = COMING_STAGES.length;
  if (!item.stage) return item.progress ?? null;
  if (item.stage === "shipped") return 1;
  const i = COMING_STAGES.indexOf(item.stage);
  const low = i / n;
  const high = (i + 1) / n;
  return item.progress === undefined ? (i + 0.5) / n : Math.min(high, Math.max(low, item.progress));
}

function place(element: HTMLElement, property: "width" | "left", share: number): HTMLElement {
  element.style[property] = `${(share * 100).toFixed(2)}%`;
  return element;
}

export function prHref(pr: number, repo = NO_REPO): string {
  return `https://github.com/${repo}/pull/${pr}`;
}

export { chatRepo, comingChatRepo, type Repo };

/** The bar through the six stages, filled to where the item is; null for an item with nothing to show. */
export function comingBar(item: ComingItem): HTMLElement | null {
  const fill = item.mergedAt ? 1 : comingFill(item);
  if (fill === null) return null;
  return h(
    "span",
    {
      class: `qc-bar${comingDone(item) ? " done" : ""}`,
      attrs: {
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": String(Math.round(fill * 100)),
        "aria-label": stageLabel(item) ?? "Progress",
      },
    },
    // Positions go through the CSSOM: the server's CSP (style-src 'self') refuses style attributes.
    place(h("span", { class: "qc-fill" }), "width", fill),
    ...(item.stage ? COMING_STAGES.slice(1).map((_, i) => place(h("span", { class: "qc-tick" }), "left", (i + 1) / COMING_STAGES.length)) : []),
  );
}

/** The card's heading: the app, else the title. */
export function comingName(item: ComingItem): string {
  return item.app ?? item.title;
}

/** One line of what it is: `what`, else the title when the app heads the card. */
export function comingWhat(item: ComingItem): string | undefined {
  return item.what ?? (item.app && item.title !== item.app ? item.title : undefined);
}


/** The ask's first line, which stands in the picture's place on a card without one. */
export function askLine(ask: string | undefined): string | null {
  const line = ask?.split(/\n/).find((part) => part.trim())?.trim();
  return line || null;
}
