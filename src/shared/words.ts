import { type At, moved, movedTwice, when } from "./when.js";

// One word for each state, used by every surface (docs/plans/rivet-information-review.md §3c). A surface that names a
// state takes its words from here, so Cards, Progress, and the desks never say the same thing two ways.
// Times inside the words come from when.ts.

/** Nothing anywhere waits on you. Replaces Caught up, All clear, On track, OK, Every card answered. */
export const NOTHING_NEEDS_YOU = "Nothing needs you.";

/**
 * The Cards heading with every open card minimised, as a minimised card still waits on you: `15 cards wait for you,
 * all minimised.`, `1 card waits for you, minimised.` Nothing needs you is only for none open.
 */
export function allMinimised(count: number): string {
  return count === 1 ? "1 card waits for you, minimised." : `${count} cards wait for you, all minimised.`;
}

/** The tap under that heading to the minimised cards: `Show them ›`, `Show it ›` for one. */
export function showMinimised(count: number): string {
  return count === 1 ? "Show it ›" : "Show them ›";
}

/** The chip on a row that waits on you. Replaces Your OK, Waiting on your OK, waiting for you, Asking you. */
export const NEEDS_YOU = "Needs you";

/** How many things wait on you: `1 needs you`, `3 need you`. */
export function needYou(count: number): string {
  return `${count} ${count === 1 ? "needs" : "need"} you`;
}

/**
 * The Morning card's one line (plan §6): `Overnight: 3 merged, 1 needs you ›`, `Overnight: nothing merged. Nothing needs
 * you.` What needs you is the badge's count.
 */
export function overnightLine(merged: number, needs: number): string {
  const head = `Overnight: ${merged ? `${merged} merged` : "nothing merged"}`;
  return needs ? `${head}, ${needYou(needs)} ›` : `${head}. ${NOTHING_NEEDS_YOU}`;
}

/** The stages of work in hand. */
export type InHand = "building" | "push-queue" | "review" | "merging" | "deploying";

/** Work in hand, one word per stage. Replaces Being done, In progress, Investigating, Picking up, On it, Working. */
export const IN_HAND: Readonly<Record<InHand, string>> = {
  building: "Building",
  "push-queue": "Push queue",
  review: "In review",
  merging: "Merging",
  deploying: "Deploying",
};

const because = (why?: string) => (why?.trim() ? ` · ${why.trim()}` : "");

/** A slipped time with its reason: `Now 7:00pm, was 6:10pm · tests were red`. Replaces Late, N late, was due. */
export function slipped(dueAt: At, wasAt: At, why?: string, now: At = Date.now()): string {
  return `${moved(dueAt, wasAt, now)}${because(why)}`;
}

/** A time that moved twice, with its reason: `Now 8:30pm, moved twice · deploy queue`. */
export function slippedTwice(dueAt: At, why?: string, now: At = Date.now()): string {
  return `${movedTwice(dueAt, now)}${because(why)}`;
}

/** Past its time with no new one: `No time yet, asked 5:42pm`, or `No time yet` when the ask's time is not known. Replaces asking for a time, no time given. */
export function noTimeYet(askedAt?: At, now: At = Date.now()): string {
  return askedAt === undefined ? "No time yet" : `No time yet, asked ${when(askedAt, now)}`;
}

/** Finished: `Done 2:05pm`. Replaces Fixed, Shipped, Merged, green. */
export function doneAt(at: At, now: At = Date.now()): string {
  return `Done ${when(at, now)}`;
}

/** On the site: `Deployed 2:05pm`. */
export function deployedAt(at: At, now: At = Date.now()): string {
  return `Deployed ${when(at, now)}`;
}

/** Every stage an ask can be in (the plan's ask stage enum); `shipped` is shown as `Deployed`. */
export type Stage = "queued" | "building" | "push-queue" | "review" | "needs-you" | "merging" | "deploying" | "shipped" | "parked" | "done";

/** One word for any stage: `Queued`, `Building`, `Needs you`, `Parked`; `Done 2:05pm` and `Deployed 2:05pm` with their time. */
export function stageWord(stage: Stage, at?: At, now: At = Date.now()): string {
  switch (stage) {
    case "queued":
      return "Queued";
    case "needs-you":
      return NEEDS_YOU;
    case "parked":
      return "Parked";
    case "done":
      return at === undefined ? "Done" : doneAt(at, now);
    case "shipped":
      return at === undefined ? "Deployed" : deployedAt(at, now);
    default:
      return IN_HAND[stage];
  }
}

// The cards Rivet makes for a wait (plan §3e), and the answers on them.

/** `Your OK: Lobby tiles: new art first` */
export function yourOk(title: string): string {
  return `Your OK: ${title}`;
}

/** `Question from daily-build: run the nightly job at 2am` */
export function questionFrom(title: string): string {
  return `Question from ${title}`;
}

/** The answers on a Your OK card. */
export const YES = "Yes";
export const CHANGE_IT = "Change it";

// The Answered side of Cards (plan §3e): what you said, and reopening it.

/** The Cards switch: `Open 3`, `Answered 12`. */
export function openTab(count: number): string {
  return `Open ${count}`;
}
export function answeredTab(count: number): string {
  return `Answered ${count}`;
}

/** An answered row: `You: Yes · 6:10pm`. The answer is the option's own words, or Yes, No, Done, Dismissed, Comment. */
export function youAnswered(answer: string, at: At, now: At = Date.now()): string {
  return `You: ${answer} · ${when(at, now)}`;
}

export const REOPEN = "Reopen";
export const SEND_AGAIN = "Send again";
export const ALREADY_MERGED = "Already merged; a new answer is a follow-up.";
export const NO_ANSWERED = "No answered cards in the last 30 days.";
export const SHOW_DONE = "Show done";

/** A time chip over Answered: `6h`, `24h`; `All` for the whole list. */
export function answeredChip(hours: number | null): string {
  return hours === null ? "All" : `${hours}h`;
}

/** Answered when a chip and Show done leave no rows: none answered in the chip's hours, or each one there done. */
export function noAnsweredIn(hours: number | null, done: number): string {
  const span = hours === null ? "the last 30 days" : `the last ${hours} hours`;
  if (!done) return hours === null ? NO_ANSWERED : `No answered cards in ${span}.`;
  return done === 1 ? `The one card answered in ${span} is done.` : `All ${done} cards answered in ${span} are done.`;
}

/** The band on a reopened card: `Reopened by you at 6:10pm. Your answer was Yes.` */
export function reopenedBand(at: At, answer: string, now: At = Date.now()): string {
  return `Reopened by you at ${when(at, now)}. Your answer was ${answer}.`;
}

/** Whether a reopened card's chat has heard: told (acked), telling (pending), unconfirmed (acked, not confirmed), not-told (expired). */
export type ChatTold = "told" | "telling" | "unconfirmed" | "not-told";

/** The line after the band, one per state; `not-told` goes with a SEND_AGAIN button. */
export const CHAT_TOLD: Readonly<Record<ChatTold, string>> = {
  told: "Its chat is told.",
  telling: "Telling its chat…",
  unconfirmed: "Not confirmed yet.",
  "not-told": "Its chat was not told.",
};
