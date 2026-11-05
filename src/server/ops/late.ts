import { createHash } from "node:crypto";

import { underWay } from "../../shared/ops-owned.js";
import { opsStatusKey } from "../../shared/ops-status-key.js";
import type { OpsStatus } from "../../shared/ops-status.js";
import type { PullRequest } from "../../shared/ops.js";
import { itemId } from "./pickup.js";

// Late work: a record with work under way whose dueAt has passed is marked late and its chat is asked why, every time.
// Going late again raises no card; the Ops card for a late item (ops/cards.ts) still tells you it ran late.

/** A question sent and not acked in this long goes again: the bridge may have dropped it. */
export const LATE_ASK_ACK_MS = 2 * 60_000;

/** One question to a late item's chat, for one dueAt it ran past. */
export interface LateAsk {
  dueAt: string;
  /** The event id the bridge acks; every resend of this question carries the same one, so the bridge types it once. */
  id: string;
  sentAt: string | null;
  delivered: boolean;
}

/** What the sweeper has done about one failure (`kind/key/since`): each dueAt it went late on. */
export interface LateLog {
  dueAts: string[];
  asks: LateAsk[];
}

export const lateKey = (status: Pick<OpsStatus, "kind" | "key" | "since">) => `${status.kind}/${status.key}/${status.since}`;

/**
 * Whether the PR a record is about is held: in `holds`, the auto pick-up's held items (its hold or label, and every PR
 * record while GitHub's reading is stale or its repo unread), or a draft. That is yours to release, not late work.
 */
export function held(status: OpsStatus, holds: ReadonlySet<string>, prs: readonly PullRequest[] | undefined): boolean {
  if (status.kind !== "pr") return false;
  if (holds.has(itemId(status))) return true;
  return prs?.find((one) => opsStatusKey("pr", String(one.number), one.repo) === status.key)?.draft === true;
}

/**
 * The records to mark late now: work under way (never parked, backlog or fixed), a dueAt that has passed and that was not
 * already logged, and no hold of yours on its PR.
 */
export function lateDue(statuses: readonly OpsStatus[], logs: Readonly<Record<string, LateLog>>, now: Date, isHeld: (status: OpsStatus) => boolean): { status: OpsStatus; dueAt: string }[] {
  const due: { status: OpsStatus; dueAt: string }[] = [];
  for (const status of statuses) {
    if (!underWay(status) || !status.dueAt || isHeld(status)) continue;
    const dueAt = new Date(status.dueAt);
    if (dueAt.getTime() > now.getTime() || logs[lateKey(status)]?.dueAts.includes(dueAt.toISOString())) continue;
    due.push({ status, dueAt: dueAt.toISOString() });
  }
  return due;
}

/** The third-late card's id, one per failure (its since): a card raised before 27 Oct 2026 stands in for its Ops card until it goes. */
export function lateCardId(item: Pick<OpsStatus, "kind" | "key" | "since">): string {
  const hash = createHash("sha256").update(`${item.kind}\n${item.key}\n${item.since}`).digest("hex").slice(0, 12);
  return `late-${item.kind}-${item.key.replace(/[^a-z0-9.-]+/g, "-").slice(0, 40)}-${hash}`;
}
