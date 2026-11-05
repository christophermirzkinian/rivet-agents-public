// Which answers a card takes. No zod, so the web app can import it.

interface Answerable {
  kind: string;
  options?: readonly { label: string; text?: boolean }[];
  reply?: "text";
}

/** A todo card: you do its steps yourself, then answers Done. */
export function isTodo(need: Pick<Answerable, "kind">): boolean {
  return need.kind === "todo";
}

/**
 * A card's steps, or none. A board stored before steps were checked passed any `steps` through, so the views take
 * them only as an array of strings.
 */
export function stepsOf(need: { steps?: unknown }): string[] {
  return Array.isArray(need.steps) && need.steps.every((step) => typeof step === "string") ? need.steps : [];
}

/** The kind of card that tells you something happened: it takes only Seen or a comment. */
export const UPDATE = "update";
/**
 * The standard first card for a piece of work: its yes, "Yes, go", starts the build.
 */
export const PLAN = "plan";
/**
 * The kind of card that puts a choice to you. Something of your asks you must confirm (a video waiting on your OK) is one,
 * with OUTCOME_OPTIONS, never an update card. Finished work takes no card at all.
 */
export const DECISION = "decision";
/** The answers of a card asking you to confirm a result: Yes, keep it, or Change it with what to change. */
export const OUTCOME_OPTIONS: readonly { label: string; text?: true }[] = [{ label: "Yes, keep it" }, { label: "Change it", text: true }];
/**
 * The one option of a news card: whatever a writer sends as an update card the board stores as a decision with this
 * option, and its tap drops the card, sent to no chat.
 */
export const GOT_IT = "Got it";

/** A news card: a decision whose one option is Got it. */
export function isGotIt(need: Pick<Answerable, "kind" | "options">): boolean {
  return need.kind === DECISION && need.options?.length === 1 && need.options[0]?.label === GOT_IT;
}

/** A bare tap of Got it: no note, image or file with it, so it is only a dismiss and goes to no chat. */
export function bareGotIt(reply: { decision: string; choice?: string; text?: string; image?: string; images?: readonly string[]; files?: readonly unknown[] }): boolean {
  return reply.decision === "choice" && reply.choice === GOT_IT && !reply.text?.trim() && !reply.image && !reply.images?.length && !reply.files?.length;
}
/** The kind of card that asks you something you answer by typing (wantsText). */
export const QUESTION = "question";
/** A yes-or-no ask card, with options Yes and No. */
export const ASK = "ask";

export function isUpdate(need: Pick<Answerable, "kind">): boolean {
  return need.kind === UPDATE;
}

/**
 * A card that waits on your decision: every kind but an update card, which is news you clear with Seen. An outcome
 * is a decision card (DECISION), so it waits on you too. The Feed's deck, the map's ? and its "needs you" read this.
 */
export function waitsOnYou(need: Pick<Answerable, "kind">): boolean {
  return !isUpdate(need);
}

export function isPlan(need: Pick<Answerable, "kind">): boolean {
  return need.kind === PLAN;
}

/** The pile an update card stacks in, by its thread's name: "Daily Build" and "daily-build" are one pile. */
export function threadKey(thread: string | undefined): string {
  return (thread ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "rivet";
}

/**
 * A todo card takes only Done, Reject, Dismiss or a comment, an update card only Seen or a comment; only they take Done
 * and Seen. Every card but an update card takes Dismiss: off your Feed with no answer, as Seen is
 * for news. The Feed has no Dismiss button since 2026-10-13, but cards dismissed before stay answered.
 */
export function takesDecision(need: Pick<Answerable, "kind">, decision: string): boolean {
  if (isTodo(need)) return decision === "done" || decision === "reject" || decision === "dismiss" || decision === "comment";
  if (isUpdate(need)) return decision === "seen" || decision === "comment";
  return decision !== "done" && decision !== "seen";
}

/** A question with no options, or a card marked reply "text", is answered by typing. */
export function wantsText(need: Answerable): boolean {
  return !isTodo(need) && !isUpdate(need) && !need.options?.length && (need.reply === "text" || need.kind === "question");
}

/** A card with options or a question takes a pick or a typed answer, never a bare approve. */
export function canApprove(need: Answerable): boolean {
  return !isTodo(need) && !isUpdate(need) && !need.options?.length && !wantsText(need);
}

/** The option you picked asks you to type what you mean first. */
export function optionNeedsText(need: Answerable, choice: string | undefined): boolean {
  // Any option with that label counts, so a duplicate label cannot skip the note.
  return !!need.options?.some((option) => option.label === choice && option.text);
}

/** The kind of card whose yes merges its PR, as the Merge sheet does. */
export const MERGE_READY = "merge-ready";

/**
 * The answer that arms a merge-ready card's merge: Approve, or the one option marked recommended when no other option
 * shares its label. Any other answer, and every answer on another kind of card, arms nothing.
 */
export function armsMerge(
  need: { kind: string; pr?: number; options?: readonly { label: string; recommended?: boolean }[] },
  decision: string,
  choice: string | undefined,
): boolean {
  if (need.kind !== MERGE_READY || need.pr === undefined) return false;
  if (decision === "approve") return true;
  const recommended = need.options?.filter((option) => option.recommended) ?? [];
  const picked = need.options?.filter((option) => option.label === choice) ?? [];
  return decision === "choice" && recommended.length === 1 && picked.length === 1 && picked[0] === recommended[0];
}
