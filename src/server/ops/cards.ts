import { createHash } from "node:crypto";

import type { Need } from "../../shared/board.js";
import { RIVET_NAME } from "../../shared/names.js";
import { cardBreaksQuiet, cardDownKey, cardId, cardKey, cardReason, CARD_REASON_WORDS, isMoneyText, recordDueAt, type CardEntry, type CardItem, type CardBook, type CardReason } from "../../shared/ops-cards.js";
import { opsStatusKey, statusKeyRepo } from "../../shared/ops-status-key.js";
import type { OpsStatus } from "../../shared/ops-status.js";
import type { OpsResponse } from "../../shared/ops.js";
import { holdsPr, type OwnerHold } from "../../shared/owner-holds.js";
import { NO_REPO } from "../../shared/repos.js";
import type { Store } from "../store.js";
import type { Alert } from "./view.js";

// Ops cards (Ops reimagine, automation 7): the one place the server turns an Ops item into a Needs-you card, by the rule
// in shared/ops-cards.ts. A card is added through the same create-only path as any update card; one item has one card
// per incident, which a later pass updates, never repeats. A schedule failing with no one on it has SchedulesStore's own card (schedules.ts), by the
// same rule; once someone owns it, its record is carded here when it qualifies.

/** How long an app-down card waits before its push is raised again, should the outbox have given up on it. */
const APP_DOWN_RERAISE_MS = 15 * 60_000;

export const noCards = (): CardBook => ({ cards: {}, gens: {} });
/** The answered hold lines a book keeps (CardBook.released), the newest. */
const MAX_RELEASED = 300;
const RELEASED_PREFIX = "pr:";

const first = (note: string | undefined) => note?.split("\n")[0]?.trim() || undefined;

/**
 * The words of your own hold on the PR, as one text: your answer to its card stands until they change
 * (CardBook.released). When it was recorded is in it, so the same words put back after a release are a new hold.
 */
function ownerHoldLine(hold: OwnerHold): string {
  return `${hold.at}\n${hold.reason}`;
}

/** The PR number and non-default repo an item's card answers to, read as fixes.ts reads them. */
function target(status: OpsStatus, view: Pick<OpsResponse, "github">): { pr?: number; repo?: string } {
  const found = status.kind === "pr" ? view.github?.prs.find((one) => opsStatusKey("pr", String(one.number), one.repo) === status.key) : undefined;
  const run = status.kind === "ci" ? view.github?.runs.find((one) => opsStatusKey("ci", one.workflow, one.repo) === status.key) : undefined;
  const keyed = statusKeyRepo(status.kind, status.key);
  const bare = status.kind === "pr" ? status.key.slice(status.key.lastIndexOf("/") + 1) : "";
  const pr = found?.number ?? (/^\d+$/.test(bare) ? Number(bare) : status.pr);
  // Else the repo of the record's fix chat, so its card opens that repo's conversation.
  const repo = found?.repo ?? run?.repo ?? (keyed === NO_REPO ? status.repo : keyed);
  return { ...(pr !== undefined ? { pr } : {}), ...(repo && repo !== NO_REPO ? { repo } : {}) };
}

/** What a schedule record's card needs to know of its schedule, by the record's key. */
export interface ScheduleFacts {
  name: string;
  what?: string;
  /** SchedulesStore shows its own card for it. */
  handled: boolean;
  /** You answered its card while the failure now running was already failing: every record of it is that incident. */
  answered?: boolean;
}

/**
 * The items that may become cards: records with work still to do, and each open PR you hold yourself (`ownerHolds`, as
 * rivet hold records them). A hold read from the PR's text, a hold label or holds.json binds the merge guard and never
 * becomes a card: an agent's checkpoint line or a quoted example would ask you to release holds you never placed. A schedule record is left out only while its schedule is `handled`; its name and
 * what it does count toward the money test with the record's own words.
 */
export function opsCardItems(
  statuses: readonly OpsStatus[],
  view: Pick<OpsResponse, "apps" | "github">,
  schedules: ReadonlyMap<string, ScheduleFacts> = new Map(),
  ownerHolds: readonly OwnerHold[] = [],
  /** Filled with the key of each PR read with no hold of yours: no release of yours stands there. */
  cleared?: Set<string>,
): CardItem[] {
  const items = new Map<string, CardItem>();
  for (const status of statuses) {
    const schedule = status.kind === "schedule" ? schedules.get(status.key) : undefined;
    if (status.state === "fixed" || schedule?.handled || schedule?.answered) continue;
    const app = status.kind === "app" ? view.apps.find((one) => opsStatusKey("app", one.id) === status.key) : undefined;
    const item: CardItem = {
      kind: status.kind,
      key: status.key,
      title: app?.name ?? first(status.note) ?? `${status.kind} ${status.key}`,
      text: status.note,
      startedAt: status.since,
      incident: status.since,
      dueAt: recordDueAt(status),
      ...(schedule && isMoneyText(schedule.name, schedule.what) ? { money: true } : {}),
      down: app?.health.state === "down",
      // Rivet picked it up, on a record that began at `since`; its pick-up only opens a fix chat.
      rivetRecordSince: app && status.by?.toLowerCase() === RIVET_NAME.toLowerCase() && (status.state === "in-progress" || status.state === "investigating") ? status.since : null,
      ...target(status, view),
      ...(status.chat ? { chat: status.chat } : {}),
    };
    // A parked record is your own calm line, except that money still reaches you.
    if (status.state === "parked" && !item.money && !isMoneyText(item.key, item.title, item.text)) continue;
    items.set(cardKey(item), item);
  }
  for (const pr of view.github?.prs ?? []) {
    const hold = ownerHolds.find((one) => holdsPr(one, pr.number, pr.repo));
    const key = opsStatusKey("pr", String(pr.number), pr.repo);
    if (!hold) {
      cleared?.add(key);
      continue;
    }
    const item: CardItem = {
      kind: "pr",
      key,
      title: `#${pr.number} ${pr.title}`,
      text: hold.reason,
      startedAt: hold.at,
      hold: true,
      holdLine: ownerHoldLine(hold),
      pr: pr.number,
      ...(pr.repo !== NO_REPO ? { repo: pr.repo } : {}),
    };
    const known = items.get(cardKey(item));
    items.set(cardKey(item), known ? { ...known, hold: true, holdLine: item.holdLine } : item);
  }
  return [...items.values()];
}

function cardFor(item: CardItem & { generation?: number }, reason: CardReason): Need {
  const held = reason === "hold";
  return {
    id: cardId(item),
    kind: "decision",
    title: item.title.length > 300 ? `${item.title.slice(0, 299)}…` : item.title,
    ask: CARD_REASON_WORDS[reason],
    // An app down is told by its own app-down push, so the card itself must not push a second time (http.ts).
    ...(reason === "app-down" ? { push: "fyi" as const } : {}),
    options: held
      ? [{ label: "Release the hold", recommended: true }, { label: "Keep it held" }]
      : [{ label: `Ask ${RIVET_NAME} to fix`, recommended: true }, { label: "Leave it" }],
    ...(item.pr !== undefined ? { pr: item.pr } : {}),
    ...(item.repo ? { repo: item.repo } : {}),
    ...(item.chat ? { chat: item.chat } : {}),
  } as Need;
}

/** Everything of the card a later pass may change; a change makes a new revision for you to answer. */
function fingerprint(need: Need): string {
  return createHash("sha256").update(JSON.stringify([need.title, need.ask, need.options, need.pr, need.repo, need.chat])).digest("hex").slice(0, 16);
}

export interface CardPass {
  store: Pick<Store, "getBoard" | "putBoard">;
  /** http.ts addUpdate: create-only; 409 when the card is already on the board. */
  addUpdate: (card: { id: string } & Record<string, unknown>) => { status: number; error?: string };
  /** Queues alerts in the Ops outbox, which retries them until a device has one (service.ts raise). */
  raise: (alerts: Alert[]) => Promise<void>;
  /** Whether the card is on the board unanswered. */
  isOpen: (id: string) => boolean;
  now: Date;
  logger: Pick<Console, "error">;
}

/**
 * Posts, updates and withdraws the cards for `items`; the new book is returned. A card whose item no longer qualifies
 * leaves the board and its generation moves on, so the same item coming back is a new card; one whose words changed is
 * rewritten in place; a card posted once is not posted again while its item keeps qualifying, so an answered card stays
 * answered. An app-down card raises its push when it is posted, when a posted card turns app-down, and again every 15
 * minutes while it stays open (the outbox dedupes a push told or queued, and requeues one it gave up on).
 */
export function syncOpsCards(pass: CardPass, items: readonly CardItem[], book: Readonly<CardBook>, cleared: ReadonlySet<string> = new Set()): CardBook {
  const cards: Record<string, CardEntry> = {};
  const gens = { ...book.gens };
  // Keyed `pr:<key>`: a bare PR number is an integer key, which JS orders first, and the cap must drop the oldest.
  const released = Object.fromEntries(Object.entries(book.released ?? {}).filter(([key]) => !cleared.has(key.slice(RELEASED_PREFIX.length))));
  // The hold lines each PR's answered card asks about: a status record coming or going moves the card's id, not your answer.
  const answeredOn = new Map<string, string>();
  for (const [id, entry] of Object.entries(book.cards)) if (entry.key && entry.held !== undefined && !pass.isOpen(id)) answeredOn.set(entry.key, entry.held);
  const decided = new Map<string, { need: Need; reason: CardReason; base: string; held?: string; key: string }>();
  for (const item of items) {
    const reason = cardReason(item, pass.now);
    if (!reason) continue;
    const base = cardId(item);
    // A hold card you answered stands until a new hold line appears: the same lines read again after its card left (a
    // missed read, a reworded body that keeps them) are not a new card. A reading of the PR with no hold of yours clears
    // it (`cleared`).
    const held = reason === "hold" ? item.holdLine : undefined;
    const idAt = (generation: number) => (generation ? cardId({ ...item, generation }) : base);
    let generation = gens[base] ?? 0;
    if (held !== undefined) {
      const kept = released[RELEASED_PREFIX + item.key];
      if (kept === held) continue;
      if (kept !== undefined) delete released[RELEASED_PREFIX + item.key];
      const posted = book.cards[idAt(generation)];
      if (!posted && answeredOn.get(item.key) === held) continue;
      // A different hold on a card you have answered, or a hold where your answered card was for something else, is a new
      // hold: a new card asks you about it.
      // A card turning to a hold is always a new card: rewritten in place it could match a revision you answered before.
      const fresh = posted && (posted.reason !== "hold" || (posted.held !== undefined && posted.held !== held && !pass.isOpen(idAt(generation))));
      if (fresh) gens[base] = ++generation;
    }
    const id = idAt(generation);
    decided.set(id, { need: cardFor({ ...item, ...(generation ? { generation } : {}) }, reason), reason, base, key: item.key, ...(held !== undefined ? { held } : {}) });
  }
  const raiseDown = (id: string, need: Need, entry: CardEntry) => {
    entry.raisedAt = pass.now.toISOString();
    void pass
      .raise([{ key: cardDownKey(id), category: "app-down", payload: { title: need.title, body: need.ask ?? "", tag: id, path: "/" } }])
      .catch((error: unknown) => pass.logger.error(`[ops] card push failed: ${error instanceof Error ? error.message : "error"}`));
  };
  const changed: Need[] = [];
  for (const [id, { need, reason, base, held, key }] of decided) {
    const print = fingerprint(need);
    const posted = book.cards[id];
    if (posted) {
      const { held: _held, key: _key, ...rest } = posted;
      const entry: CardEntry = { ...rest, print, reason, ...(held !== undefined ? { held, key } : {}) };
      if (posted.print !== print) changed.push(need);
      const lapsed = !posted.raisedAt || pass.now.getTime() - Date.parse(posted.raisedAt) >= APP_DOWN_RERAISE_MS;
      if (cardBreaksQuiet(reason) && pass.isOpen(id) && (posted.reason !== reason || lapsed)) raiseDown(id, need, entry);
      cards[id] = entry;
      continue;
    }
    const added = pass.addUpdate(need);
    if (added.status !== 200 && added.status !== 409) {
      pass.logger.error(`[ops] card ${id} refused: ${added.error ?? added.status}`);
      continue;
    }
    const entry: CardEntry = { base, print, reason, ...(held !== undefined ? { held, key } : {}) };
    if (added.status === 200 && cardBreaksQuiet(reason)) raiseDown(id, need, entry);
    cards[id] = entry;
  }
  const gone = Object.keys(book.cards).filter((id) => !decided.has(id));
  const carded = new Set([...decided.values()].filter(({ held }) => held !== undefined).map(({ key }) => key));
  for (const id of gone) {
    const entry = book.cards[id]!;
    // A new hold's card already moved its generation on above.
    if ((gens[entry.base] ?? 0) === (book.gens[entry.base] ?? 0)) gens[entry.base] = (gens[entry.base] ?? 0) + 1;
    if (entry.held === undefined || !entry.key || pass.isOpen(id) || cleared.has(entry.key) || carded.has(entry.key)) continue;
    delete released[RELEASED_PREFIX + entry.key];
    released[RELEASED_PREFIX + entry.key] = entry.held;
  }
  const kept = Object.entries(released).slice(-MAX_RELEASED);
  if (changed.length || gone.length) {
    const stored = pass.store.getBoard();
    if (stored) {
      const swap = new Map(changed.map((need) => [need.id, need]));
      const needs = stored.board.needs
        .filter((need) => !gone.includes(need.id))
        .map((need) => {
          const fresh = swap.get(need.id);
          if (!fresh) return need;
          const { pr: _pr, repo: _repo, chat: _chat, ...rest } = need as Need & { pr?: number; repo?: string; chat?: string };
          return { ...rest, title: fresh.title, ask: fresh.ask, options: fresh.options, ...(fresh.push ? { push: fresh.push } : {}), ...(fresh.pr !== undefined ? { pr: fresh.pr } : {}), ...(fresh.repo ? { repo: fresh.repo } : {}), ...(fresh.chat ? { chat: fresh.chat } : {}) } as Need;
        });
      pass.store.putBoard({ ...stored.board, needs, updatedAt: pass.now.toISOString() }, stored.version);
    }
  }
  return { cards, gens, ...(kept.length ? { released: Object.fromEntries(kept) } : {}) };
}
