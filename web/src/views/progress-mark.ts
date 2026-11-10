import { RIVET_NAME } from "../../../src/shared/names.js";
import { when } from "../../../src/shared/when.js";
import { NOTHING_NEEDS_YOU, allMinimised } from "../../../src/shared/words.js";
import { type Mood } from "../rivet/rivet.js";
import { h } from "../dom.js";
import { freshPrs, opsData } from "../ops-data.js";
import { boardRead, summary } from "../state.js";
import { parkedItems } from "./ops.js";
import { parked, prItem } from "./ops-status.js";

/** What the Progress tab shows: an amber "!" while an ask has no time or has moved twice. */
export interface NavMark {
  dot: "warn" | null;
  line: string | null;
  /** The asks in hand and when the next is done, from the summary, said calmly beside the mark and never counted in it. */
  owned?: string | null;
  /** What you parked, "1 PR, iPhone X": draft PRs by count, the rest by name, said calmly beside the mark and never counted in it. */
  parked?: string | null;
}

/**
 * How the work is, for the Progress tab on the phone's bar and the rail: the work is Rivet's job, so a break is no
 * mark; the mark is amber while an ask has no time or has moved twice, never for a time that slipped once.
 * Its counts are the summary's.
 */
export function opsStatus(): { mark: NavMark } {
  const ops = opsData.ops;
  const asks = summary()?.asks;
  const parkedPrs = ops ? (freshPrs(ops) ?? []).filter((pr) => parked(prItem(pr))).length : 0;
  const parkedNames = parkedItems(ops).filter((item) => item.kind !== "pr").map((item) => item.title);
  const amber = asks ? [asks.noTime ? `${asks.noTime} no time yet` : null, asks.moved ? `${asks.moved} moved twice` : null].filter(Boolean).join(" · ") : "";
  return { mark: { dot: amber ? "warn" : null, line: amber || null, owned: asksLine(), parked: [parkedPrs ? plural(parkedPrs, "PR", "PRs") : null, ...parkedNames].filter(Boolean).join(", ") || null } };
}

/** "Your asks: 6 in hand, next done 6:10pm", the Cards empty state's one line to Progress; null with none in hand. */
export function asksLine(): string | null {
  const now = summary();
  if (!now?.asks.inHand) return null;
  return `Your asks: ${now.asks.inHand} in hand${now.nextDoneAt ? `, next done ${when(now.nextDoneAt)}` : ""}`;
}

/** The calm lines beside the mark: the asks in hand and "Parked: …", each null when it has nothing. */
export function calmLines(mark: NavMark): { agents: string | null; parked: string | null } {
  return { agents: mark.owned ?? null, parked: mark.parked ? `Parked: ${mark.parked}` : null };
}

/**
 * Rivet's words with no card waiting, on Cards and at his desk: happy, as nothing needs you, with your asks in one
 * small line (`agents`). `minimised` is how many minimised cards still wait: Cards passes the ones it shows; the
 * summary's count otherwise.
 */
export function clearWords(minimised = summary()?.minimised ?? 0): { mood: Mood; title: string; lede: string; agents: string | null; parked: string | null } {
  const { mark } = opsStatus();
  const { agents, parked } = calmLines(mark);
  // Nothing is clear until the board has loaded once: a neutral face, never the tick, while it reads or cannot.
  const read = boardRead();
  if (read !== "loaded") return { mood: "thinking", title: READ_WORDS[read], lede: "", agents, parked };
  // A minimised card still waits on you, so with every open card minimised the heading says so, and Cards puts a tap
  // to them under it.
  const title = minimised ? allMinimised(minimised) : NOTHING_NEEDS_YOU;
  return { mood: "happy", title, lede: "", agents, parked };
}

/** Rivet's words on the home screen before the board has loaded. */
export const READ_WORDS = { reading: "Reading the home…", slow: "Still reading…", failed: `Can't reach ${RIVET_NAME}.` } as const;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A tab's mark, one shape on the phone's bar and the desktop rail: "!" in amber. */
export function navMark(mark: NavMark | undefined): HTMLElement | null {
  if (mark?.dot) return h("span", { class: `badge t-${mark.dot}`, attrs: { role: "img", "aria-label": mark.line ?? "an ask has no time" } }, "!");
  return null;
}
