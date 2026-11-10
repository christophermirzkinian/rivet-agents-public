import { sumCells, type UsageCell } from "../../src/shared/ops.js";

// The figure each reading page leads with, kept apart from the DOM so the rules are tested on their own.

export type FigureTone = "ok" | "warn" | "bad" | "idle";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Hundreds of percent as limits: 368 → "3.7", 300 → "3". */
export const asLimits = (percent: number): string => String(Number((percent / 100).toFixed(1)));

/** An account this full counts as full on Usage's card. */
export const ACCOUNT_FULL_PCT = 90;

export interface UsageLead {
  /** What is known to be left, in limits: "0.3". */
  left: string;
  /** Every account's limit: "5". */
  of: string;
  used: string;
  /** Left over the whole: what the figure and meter are coloured by. */
  leftShare: number;
  /** Green over 25% left, gold from 10%, red under 10%. */
  tone: FigureTone;
  /** The card: gold also when any one account is full or the reading is old. */
  cardTone: FigureTone;
  unread: number;
  full: number;
  /** "3.7 used · 1 account not read · 1 account full". */
  line: string;
}

/** One provider's lead on Usage: what is left of its accounts' limits. Null while no account was read. */
export function usageLead(cells: readonly UsageCell[], stale: boolean): UsageLead | null {
  const sum = sumCells(cells);
  if (!sum) return null;
  const used = sum.used;
  // An unread account's 100% is in the whole but not in what is known to be left.
  const left = Math.max(0, sum.total - sum.unread * 100 - used);
  const leftShare = left / sum.total;
  const tone: FigureTone = leftShare > 0.25 ? "ok" : leftShare >= 0.1 ? "warn" : "bad";
  const full = cells.filter((cell) => !cell.unread && cell.percent >= ACCOUNT_FULL_PCT).length;
  const cardTone: FigureTone = tone === "ok" && (full > 0 || stale) ? "warn" : tone;
  const line = [`${asLimits(used)} used`, sum.unread ? `${plural(sum.unread, "account")} not read` : null, full ? `${plural(full, "account")} full` : null].filter(Boolean).join(" · ");
  return { left: asLimits(left), of: asLimits(sum.total), used: asLimits(used), leftShare, tone, cardTone, unread: sum.unread, full, line };
}

/** Machines worst first: red, then amber, then not read, then green. */
const MACHINE_ORDER: Record<string, number> = { bad: 0, warn: 1, idle: 2, info: 2, ok: 3 };

export function machinesWorstFirst<T extends { tone: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (MACHINE_ORDER[a.tone] ?? 2) - (MACHINE_ORDER[b.tone] ?? 2));
}

export interface MachinesHead {
  figure: string;
  words: string;
  tone: FigureTone;
}

/**
 * "2 of 5 need a look", "All 5 working", or how many have no reading; a machine nobody read is never called working.
 * `fault` is what was measured, whatever its colour: a fault the owner dismissed is calm, but its machine is not working.
 */
export function machinesHead(machines: readonly { tone: string; read: boolean; fault?: boolean }[]): MachinesHead {
  const all = machines.length;
  const needs = (tone: string) => tone === "bad" || tone === "warn";
  const need = machines.filter((one) => needs(one.tone)).length;
  const unread = machines.filter((one) => !needs(one.tone) && !one.read).length;
  const faulty = machines.filter((one) => !needs(one.tone) && one.read && one.fault).length;
  if (need) return { figure: String(need), words: `of ${all} need${need === 1 ? "s" : ""} a look`, tone: machines.some((one) => one.tone === "bad") ? "bad" : "warn" };
  if (unread) return { figure: String(unread), words: `of ${all} not read yet`, tone: "idle" };
  if (faulty) return { figure: String(all - faulty), words: `of ${all} working`, tone: "idle" };
  return { figure: "All", words: `${all} working`, tone: "ok" };
}
