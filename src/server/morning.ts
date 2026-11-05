import { DECISION, GOT_IT, isGotIt, UPDATE } from "../shared/answers.js";
import type { Board, Need } from "../shared/board.js";
import { zoneClock, zoneInstant, type MergedPr } from "../shared/ops.js";
import { overnightLine } from "../shared/words.js";

// The Morning card: one update card at 7am local time with what merged overnight and what needs you, as one line. Seen
// like any update.

export const MORNING_HOUR = 7;
/** Overnight runs from 9pm the evening before to 7am. */
export const OVERNIGHT_FROM_HOUR = 21;

export interface MorningDeps {
  now(): Date;
  /** routes/router.ts addUpdate: 200, or the refusal (409 when the id is taken). */
  addUpdate(card: { id: string } & Record<string, unknown>): { status: number; error?: string };
  merged(): readonly MergedPr[];
  /** The cards that need you now, as the badge counts them (the summary's needsYou). */
  needs(): number;
  board(): Board | null;
  /** You already answered (saw) this card: one seen and gone from the board is not filed again. */
  answered(id: string): boolean;
  /** What you used's count of ids never used in 30 days, or null before 30 full days of recording. */
  neverUsed?(now: Date): number | null;
  /** The app's What you used page, an https link. */
  usageUrl?: string;
  logger: Pick<Console, "error">;
}

export interface MorningFacts {
  day: string;
  merged: number;
  needs: number;
  /** Mondays only, after 30 full days of recording: the never-used count, and the page it opens. */
  whatYouUsed?: { never: number; url: string };
}

/** The local day of the week at `at`: 0 Sunday to 6 Saturday. */
export function localWeekday(at: Date): number {
  return new Date(`${zoneClock(at).day}T00:00:00Z`).getUTCDay();
}

/** The instant the local clock reads `hour`:00 on `day`. */
export function localAt(day: string, hour: number): Date {
  return zoneInstant(day, hour * 60);
}

export function morningId(day: string): string {
  return `morning-${day}`;
}

export function morningFacts(deps: Pick<MorningDeps, "now" | "merged" | "needs">, now = deps.now()): MorningFacts {
  const { day } = zoneClock(now);
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  const from = localAt(yesterday, OVERNIGHT_FROM_HOUR).getTime();
  const to = Math.min(now.getTime(), localAt(day, MORNING_HOUR).getTime());
  const merged = deps.merged().filter((pr) => {
    const at = Date.parse(pr.mergedAt);
    return at >= from && at < to;
  }).length;
  return { day, merged, needs: deps.needs() };
}

/** Monday's What you used line, read only when the card is filed: nothing before 30 full days of recording. */
export function whatYouUsedFact(deps: Pick<MorningDeps, "neverUsed" | "usageUrl">, now: Date): Pick<MorningFacts, "whatYouUsed"> {
  if (localWeekday(now) !== 1 || !deps.usageUrl) return {};
  const never = deps.neverUsed?.(now) ?? null;
  return never === null ? {} : { whatYouUsed: { never, url: deps.usageUrl } };
}

/** Monday's one What you used line, a link that opens the page (the card's own line stays overnightLine). */
export function whatYouUsedLine(never: number): string {
  return `What you used: ${never} never used in 30 days ›`;
}

export function morningCard(facts: MorningFacts): { id: string } & Record<string, unknown> {
  const used = facts.whatYouUsed;
  return {
    id: morningId(facts.day),
    title: "Good morning",
    ask: overnightLine(facts.merged, facts.needs),
    // News, so a Got it card: one tap clears it, and its push stays quiet.
    kind: DECISION,
    options: [{ label: GOT_IT }],
    push: "fyi",
    ...(used ? { links: [{ label: whatYouUsedLine(used.never), url: used.url }] } : {}),
  };
}

/**
 * The merged count a Morning card was filed with, read back from its line (overnightLine) or, for one filed before it,
 * its first line ("2 merged overnight"); undefined for any other words.
 */
export function morningMerged(card: Need): number | undefined {
  const ask = card.ask ?? "";
  const said = /^Overnight: (\d+|nothing) merged/.exec(ask)?.[1] ?? /^(\d+|Nothing) merged overnight/.exec(ask)?.[1];
  return said === undefined ? undefined : /^\d+$/.test(said) ? Number(said) : 0;
}

const MORNING_PUSH_PREFIX = "morning:";

/** The Morning card's push key, so one quiet hours held whose card has left the board is withdrawn unsent. */
export function morningPushKey(need: Need): string | undefined {
  return ((need.kind === UPDATE && need.thread === "Morning") || isGotIt(need)) && /^morning-\d{4}-\d{2}-\d{2}$/.test(need.id) ? `${MORNING_PUSH_PREFIX}${need.id}` : undefined;
}

/** The Morning card a push key names, or null for any other key. */
export function morningOfPushKey(key: string): string | null {
  return key.startsWith(MORNING_PUSH_PREFIX) ? key.slice(MORNING_PUSH_PREFIX.length) : null;
}

export interface Morning {
  /** Files today's card once it is 7am or later and it is not there yet; safe to call every minute. */
  tick(): "early" | "filed" | "there" | "failed";
}

export function createMorning(deps: MorningDeps): Morning {
  let filed: string | null = null;
  let lastError: string | null = null;
  return {
    tick() {
      const now = deps.now();
      const { day, minute } = zoneClock(now);
      if (minute < MORNING_HOUR * 60) return "early";
      if (filed === day) return "there";
      const id = morningId(day);
      if (deps.board()?.needs.some((need) => need.id === id) || deps.answered(id)) {
        filed = day;
        return "there";
      }
      const result = deps.addUpdate(morningCard({ ...morningFacts(deps, now), ...whatYouUsedFact(deps, now) }));
      if (result.status === 200 || result.status === 409) {
        filed = day;
        lastError = null;
        return result.status === 200 ? "filed" : "there";
      }
      // Once per day and error, not once a minute.
      const error = `${day} ${result.status} ${result.error ?? ""}`;
      if (error !== lastError) deps.logger.error(`[morning] the Morning card was not filed (${result.status}): ${result.error ?? "unknown"}`);
      lastError = error;
      return "failed";
    },
  };
}
