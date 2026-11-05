// The feed's rules, free of the DOM so they can be unit-tested.

import { isUpdate, MERGE_READY, waitsOnYou } from "../../src/shared/answers.js";
import type { Decision, FileRef, Reply, ServedNeed } from "../../src/shared/board.js";
import type { PullRequest } from "../../src/shared/ops.js";
import { holdOf, holdReason } from "../../src/shared/pr-holds.js";
import { localDay } from "./day.js";

export type Action = "approve" | "reject" | "skip";

export const UNDO_MS = 5_000;
/** A press that travels further than this is a scroll or a slip, not a tap. */
export const TAP_SLOP_PX = 10;

export function isTap(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) <= TAP_SLOP_PX;
}

export interface DeckInput {
  /** itemId → the rev of the latest reply to it. */
  answeredRev: ReadonlyMap<string, string>;
  /** Answered cards the owner asked to answer again. */
  reopened: ReadonlySet<string>;
  /** Cards waiting out their undo window or being sent. */
  held: ReadonlySet<string>;
  /** id → the revision put as Later, in the order put there; that revision stays out of the deck. */
  later: ReadonlyMap<string, string>;
  /** A card to show first (an undo, a failed send, or a tapped notification). */
  front: string | null;
}

function isOpen(need: ServedNeed, input: Pick<DeckInput, "answeredRev" | "reopened" | "held">): boolean {
  return !input.held.has(need.id) && (input.reopened.has(need.id) || input.answeredRev.get(need.id) !== need.rev);
}

/** The cards still to answer, in the order the feed shows them: the desktop's order, with the front card first. Update cards answer nothing, so they are never here. */
export function deckOrder(needs: readonly ServedNeed[], input: DeckInput): ServedNeed[] {
  const ordered = deskOrder(needs.filter((need) => waitsOnYou(need) && isOpen(need, input) && input.later.get(need.id) !== need.rev));
  const front = input.front ? ordered.findIndex((need) => need.id === input.front) : -1;
  if (front > 0) ordered.unshift(...ordered.splice(front, 1));
  return ordered;
}

/** The update cards the owner has not seen at their current revision, newest first. */
export function updateOrder(needs: readonly ServedNeed[], input: Pick<DeckInput, "answeredRev" | "reopened" | "held">): ServedNeed[] {
  const since = (need: ServedNeed) => {
    const at = need.since ? Date.parse(need.since) : NaN;
    return Number.isFinite(at) ? at : -Infinity;
  };
  return needs
    .map((need, index) => ({ need, index }))
    // The server marks one seen however old his Seen is, past the replies the app reads.
    .filter(({ need }) => isUpdate(need) && isOpen(need, input) && (!need.seen || input.reopened.has(need.id)))
    .sort((a, b) => since(b.need) - since(a.need) || b.index - a.index)
    .map(({ need }) => need);
}

export { localDay };

/**
 * Feed › Done: the answers given today on this phone, newest first, one per card (the newest), the update cards seen
 * apart from the cards answered.
 */
export function doneToday(replies: Iterable<Reply>, now: Date): { answered: Reply[]; seen: Reply[] } {
  const today = localDay(now);
  const done = [...replies]
    .filter((reply) => Number.isFinite(Date.parse(reply.at)) && localDay(new Date(reply.at)) === today)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { answered: done.filter((reply) => reply.decision !== "seen"), seen: done.filter((reply) => reply.decision === "seen") };
}

/** The open cards put as Later at their current revision, in the order they were put there. */
export function laterOrder(needs: readonly ServedNeed[], input: DeckInput): ServedNeed[] {
  const open = new Map(needs.filter((need) => isOpen(need, input)).map((need) => [need.id, need]));
  return [...input.later].flatMap(([id, rev]) => {
    const need = open.get(id);
    return need?.rev === rev ? [need] : [];
  });
}

/** The desktop board's order: risky cards first, then the oldest. It ignores `front`, so opening a card never moves it in the list. */
export function deskOrder(cards: readonly ServedNeed[]): ServedNeed[] {
  const since = (need: ServedNeed) => {
    const at = need.since ? Date.parse(need.since) : NaN;
    return Number.isFinite(at) ? at : Infinity;
  };
  return cards
    .map((need, index) => ({ need, index }))
    .sort(
      (a, b) =>
        Number(!a.need.risk) - Number(!b.need.risk) ||
        since(a.need) - since(b.need) ||
        a.index - b.index,
    )
    .map(({ need }) => need);
}

/** Money, auth and fairness cards need the extra tap before an approve or a choice. */
export function needsConfirm(need: Pick<ServedNeed, "risk">, decision: Decision): boolean {
  return !!need.risk && (decision === "approve" || decision === "choice");
}

export interface Answer {
  itemId: string;
  decision: Decision;
  rev: string;
  choice?: string;
  text?: string;
  image?: string;
  /** Two or more photos; one comes as `image`. */
  images?: string[];
  files?: FileRef[];
}

export function answerKey(answer: Answer): string {
  return JSON.stringify([
    answer.itemId,
    answer.decision,
    answer.rev,
    answer.choice ?? null,
    answer.text ?? null,
    answer.image ?? null,
    ...(answer.files ? [answer.files.map((file) => file.sha256)] : []),
    ...(answer.images ? [{ images: answer.images }] : []),
  ]);
}

/** An identical retry reuses its clientId (the server dedupes it); any other answer gets a new one. */
export function clientIdFor(
  pending: { key: string; clientId: string } | null,
  answer: Answer,
  make: () => string,
): { key: string; clientId: string } {
  const key = answerKey(answer);
  return pending?.key === key ? pending : { key, clientId: make() };
}

export type Failure = "signin" | "changed" | "confirm" | "refused" | "retry";

/** How a failed send is handled. Only "retry" keeps the clientId, since the answer may have landed. */
export function classifyFailure(status: number): Failure {
  if (status === 401) return "signin";
  if (status === 409) return "changed";
  if (status === 428) return "confirm";
  if (status >= 400 && status < 500) return "refused";
  return "retry";
}

interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Holds each answer for its own undo window and commits it when that window
 * ends. Nothing reaches the server before then, so an undo never needs a call,
 * and a newer answer never cuts short an older one's window. Undo takes back
 * the newest.
 */
export class UndoQueue<T> {
  private pending: { entry: T; handle: unknown; commit: (entry: T) => void }[] = [];

  constructor(
    private readonly delayMs = UNDO_MS,
    private readonly timers: Timers = realTimers,
  ) {}

  /** The newest held answer, the one Undo takes back. */
  get current(): T | null {
    return this.pending[this.pending.length - 1]?.entry ?? null;
  }

  /** Every held answer, oldest first. */
  get entries(): T[] {
    return this.pending.map((held) => held.entry);
  }

  push(entry: T, commit: (entry: T) => void): void {
    const held: (typeof this.pending)[number] = { entry, handle: null, commit };
    held.handle = this.timers.set(() => {
      this.pending = this.pending.filter((other) => other !== held);
      commit(entry);
    }, this.delayMs);
    this.pending.push(held);
  }

  /** Takes the newest held answer back; it is never sent. */
  undo(): T | null {
    const held = this.pending.pop();
    if (!held) return null;
    this.timers.clear(held.handle);
    return held.entry;
  }

  /** Commits every held answer now, oldest first (the page is going away). */
  flush(): void {
    for (const held of this.drainHeld()) held.commit(held.entry);
  }

  /** Takes every held answer out without committing it, oldest first. */
  drain(): T[] {
    return this.drainHeld().map((held) => held.entry);
  }

  private drainHeld(): typeof this.pending {
    const all = this.pending;
    this.pending = [];
    for (const held of all) this.timers.clear(held.handle);
    return all;
  }
}

export type ProofTone = "ok" | "bad" | "wait" | "warn";
export interface ProofLine {
  key: "tests" | "review" | "why" | "hold";
  text: string;
  tone: ProofTone;
}

const CI_WORDS = { green: ["Tests green", "ok"], red: ["Tests red", "bad"], running: ["Tests running", "wait"] } as const;
const REVIEW_WORDS = { clean: ["Review clean", "ok"], findings: ["Review: findings open", "bad"], running: ["Review running", "wait"] } as const;

const withNote = (text: string, note?: string) => (note ? `${text} · ${note}` : text);

/** The proof a merge-ready card, or any card with evidence, carries above its answers: the checks and review the chat wrote, why it is yours, and every hold. */
export function proofOf(need: ServedNeed, pr?: PullRequest): ProofLine[] {
  const evidence = need.evidence;
  const merge = need.kind === MERGE_READY;
  if (!merge && !evidence) return [];
  const lines: ProofLine[] = [];
  const moved = !!(need.headSha && pr?.headSha && pr.headSha !== need.headSha);
  const checks = moved ? undefined : pr?.checks;
  if (checks && checks.state === "pass") lines.push({ key: "tests", text: `Tests green · ${checks.passed} passed`, tone: "ok" });
  else if (checks && checks.state === "fail") {
    const named = checks.failing.slice(0, 2).join(", ");
    const more = checks.failing.length > 2 ? ` +${checks.failing.length - 2} more` : "";
    lines.push({ key: "tests", text: named ? `Tests red · failing: ${named}${more}` : `Tests red · ${checks.failed} failing`, tone: "bad" });
  } else if (checks && checks.state === "pending") {
    const done = checks.passed + checks.failed;
    lines.push({ key: "tests", text: `Tests running · ${done} of ${done + checks.pending}`, tone: "wait" });
  } else if (evidence?.ci) {
    const [text, tone] = CI_WORDS[evidence.ci];
    lines.push({ key: "tests", text: withNote(text, evidence.ciNote), tone });
  }
  if (evidence?.review) {
    const [text, tone] = REVIEW_WORDS[evidence.review];
    lines.push({ key: "review", text: withNote(text, evidence.reviewNote), tone });
  }
  if (evidence?.why) lines.push({ key: "why", text: `Why you: ${evidence.why}`, tone: "ok" });
  const holds: string[] = [];
  if (moved) holds.push("new commits since this card");
  const held = pr ? holdOf(pr) : null;
  if (held) holds.push(holdReason(held) || "on hold");
  holds.push(...(evidence?.holding ?? []));
  for (const hold of holds) lines.push({ key: "hold", text: `Held: ${hold}`, tone: "warn" });
  if (!holds.length && merge) lines.push({ key: "hold", text: "Nothing holds it", tone: "ok" });
  return lines;
}
