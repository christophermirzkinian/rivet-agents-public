import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { Need } from "../shared/board.js";
import { cardReason, recordDueAt } from "../shared/ops-cards.js";
import { isOwned, recordOf, scheduleOwnedItem } from "../shared/ops-owned.js";
import type { OpsStatus } from "../shared/ops-status.js";
import { isRepo } from "../shared/repos.js";
import {
  failingStreak,
  SCHEDULES_STALE_MS,
  type RecentRun,
  type Schedule,
  type SchedulesResponse,
  type SchedulesSnapshot,
  type Streak,
} from "../shared/schedules.js";
import { RIVET_NAME } from "../shared/names.js";
import { shortDate } from "../shared/when.js";
import { JobsStore } from "./jobs.js";

// See store.ts: node:sqlite goes through createRequire under vitest.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

// Its own connection to the app database, like OpsStore: the bridge's latest read of the schedules, one row, and a
// row per failing schedule's card. Whether a schedule is failing comes from its runs alone; the card row only keeps
// the card's id steady for the whole streak, pushes it once, and holds your answer until the schedule works again.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS schedules_snapshot (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  json        TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_cards (
  schedule_id TEXT PRIMARY KEY,
  card_id     TEXT NOT NULL,
  shown_at    TEXT NOT NULL,
  answered_at TEXT
);
`;

/** The failing-schedule cards' ids. Only the server makes them: the board token can't write one. */
export const SCHEDULE_CARD_PREFIX = "schedule-";

/** A failing-schedule card's push key prefix: a held one is checked again before the digest. */
export const SCHEDULE_PUSH_PREFIX = "schedule-card:";

/** By schedule and card: a later card of the same schedule is no duplicate, and a held one is found by its schedule. */
export function schedulePushKey(card: Need): string {
  return `${SCHEDULE_PUSH_PREFIX}${card.schedule ?? ""}:${card.id}`;
}

/** The schedule a push key names (a card id has no colon; a schedule id may), or null for any other key. */
export function scheduleOfPushKey(key: string): string | null {
  return key.startsWith(SCHEDULE_PUSH_PREFIX) ? key.slice(SCHEDULE_PUSH_PREFIX.length, key.lastIndexOf(":")) || null : null;
}

/** A schedule whose newest FAILING_AFTER finished runs failed, all within FAILING_WINDOW_MS. */
export interface FailingSchedule {
  scheduleId: string;
  need: Need;
  /** What Rivet gets with an answer: the schedule, its repo and the newest failed run. */
  detail: string;
  /** The newest failed run's GitHub link, or null for a run with none. */
  url: string | null;
  /** You answered its card, Leave it too: it stays off the feed until a run passes after that. */
  answered: boolean;
  /** When he answered; null if he has not. */
  answeredAt: string | null;
  /** Someone is on it (its record, ops-owned.ts): no card on the feed while they are. */
  owned: boolean;
  /** The card rule (shared/ops-cards.ts) does not let it reach you yet: not money, not late. Never true once its card showed. */
  held: boolean;
}

interface CardRow {
  schedule_id: string;
  card_id: string;
  shown_at: string;
  answered_at: string | null;
}

/** A red job's schedule key (shared/jobs.ts jobScheduleKey): its card is one of the failing ones. */
const JOB_KEY_PREFIX = "job-";

export class SchedulesStore {
  private readonly db: InstanceType<typeof DatabaseSync>;
  /** Your own jobs: a red one's card is a failing-schedule card too. */
  readonly jobs: JobsStore;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "rivet.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.jobs = new JobsStore(dataDir, (key) => this.owned(key));
  }

  close(): void {
    this.jobs.close();
    this.db.close();
  }

  /** Stores the bridge's read, unless it is older than the one stored; returns the cards it made new, to push. */
  put(snapshot: SchedulesSnapshot, receivedAt: Date): Need[] {
    const stored = this.get();
    if (stored && Date.parse(snapshot.at) < Date.parse(stored.at)) return [];
    this.db
      .prepare("INSERT INTO schedules_snapshot (id, json, received_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json, received_at = excluded.received_at")
      .run(JSON.stringify(snapshot), receivedAt.toISOString());
    return this.sync(receivedAt);
  }

  /**
   * Brings the card rows up to date with the runs, after anything that changes them (a bridge read). A card first seen gets its row, and is returned to push; that happens once per card, restarts and
   * replays included. A row goes once a run passes after the card showed, or when the streak ended unanswered.
   * A schedule someone is on gets no card yet: it is filed and pushed once nobody is on it.
   */
  sync(now: Date): Need[] {
    const rows = this.rows();
    const owned = this.ownedTest();
    const statuses = this.statuses();
    const fresh: Need[] = [];
    for (const item of this.view(now).items) {
      const streak = failingStreak(item, now);
      let row = rows.get(item.id);
      if (row && (passedSince(item, row.shown_at) || (!streak && !row.answered_at))) {
        this.db.prepare("DELETE FROM schedule_cards WHERE schedule_id = ?").run(item.id);
        row = undefined;
      }
      if (streak && !row && !owned(item.id) && !holdsBack(item, streak, now, statuses)) {
        const cardId = failingCardId(item.id, streak.start.id);
        this.db.prepare("INSERT INTO schedule_cards (schedule_id, card_id, shown_at) VALUES (?, ?, ?)").run(item.id, cardId, now.toISOString());
        fresh.push(failingCard(item, streak, cardId));
      }
    }
    return fresh;
  }

  /** Every red card, a schedule's or a job's: the feed's cards and their answers. */
  failing(now: Date): FailingSchedule[] {
    return this.failingSchedules(now).concat(this.jobs.failing());
  }

  /**
   * The failing schedules /api/schedules lists, worked out from each one's finished runs; the card row only gives the
   * id and the answer. A red job is not one: the Red jobs sheet shows it.
   */
  failingSchedules(now: Date): FailingSchedule[] {
    const rows = this.rows();
    const owned = this.ownedTest();
    const statuses = this.statuses();
    return this.view(now).items.flatMap((item) => {
      const streak = failingStreak(item, now);
      if (!streak) return [];
      const row = rows.get(item.id);
      const need = failingCard(item, streak, row?.card_id ?? failingCardId(item.id, streak.start.id));
      return [{ scheduleId: item.id, need, detail: failingDetail(item, streak), url: streak.newest.url ?? null, answered: !!row?.answered_at, answeredAt: row?.answered_at ?? null, owned: owned(item.id), held: !row && holdsBack(item, streak, now, statuses) }];
    });
  }

  /**
   * A schedule card whose push was never sent (withdrawn from the digest as someone took it on, or given up on): its
   * row goes, so the next read files and pushes it again once nobody is on it. An answered card keeps its row.
   */
  unfile(scheduleId: string): void {
    if (scheduleId.startsWith(JOB_KEY_PREFIX)) return this.jobs.unfile(scheduleId.slice(JOB_KEY_PREFIX.length));
    this.db.prepare("DELETE FROM schedule_cards WHERE schedule_id = ? AND answered_at IS NULL").run(scheduleId);
  }

  /** Someone is on this schedule, by its record (the shared test, ops-owned.ts). */
  owned(scheduleId: string): boolean {
    return this.ownedTest()(scheduleId);
  }

  /** You answered this schedule's card: off the feed until a run passes after now. */
  answer(failing: FailingSchedule, at: Date): void {
    if (failing.scheduleId.startsWith(JOB_KEY_PREFIX)) return this.jobs.answer(failing.scheduleId.slice(JOB_KEY_PREFIX.length), failing.need.id, at);
    this.db
      .prepare(
        "INSERT INTO schedule_cards (schedule_id, card_id, shown_at, answered_at) VALUES (?, ?, ?, ?) ON CONFLICT (schedule_id) DO UPDATE SET answered_at = excluded.answered_at",
      )
      .run(failing.scheduleId, failing.need.id, at.toISOString(), at.toISOString());
  }

  private rows(): Map<string, CardRow> {
    const rows = this.db.prepare("SELECT * FROM schedule_cards").all() as unknown as CardRow[];
    return new Map(rows.map((row) => [row.schedule_id, row]));
  }

  get(): SchedulesSnapshot | null {
    const row = this.db.prepare("SELECT json FROM schedules_snapshot WHERE id = 1").get() as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as SchedulesSnapshot) : null;
  }

  /** The schedules' records (the Store keeps them); none before the first. */
  private statuses(): OpsStatus[] {
    try {
      const rows = this.db.prepare("SELECT json FROM ops_status WHERE kind = 'schedule'").all() as { json: string }[];
      return rows.map((row) => JSON.parse(row.json) as OpsStatus);
    } catch {
      // No ops_status table yet: nobody is on anything.
      return [];
    }
  }

  /** The app's ownership test over the schedules' records; none before the first. */
  private ownedTest(): (scheduleId: string) => boolean {
    const statuses = this.statuses();
    // A schedule has no branch, so no live chat can hold it: only its record counts.
    return (scheduleId) => {
      const item = scheduleOwnedItem(scheduleId);
      const status = recordOf(item, statuses);
      return !(status?.state === "parked" && this.jobs.loud(scheduleId)) && isOwned(item, status, []);
    };
  }

  /** One schedule from the latest read, by id. */
  find(id: string): Schedule | null {
    return this.view(new Date()).items.find((item) => item.id === id) ?? null;
  }

  view(now: Date): SchedulesResponse {
    const snapshot = this.get();
    return {
      at: snapshot?.at ?? null,
      stale: !snapshot || now.getTime() - Date.parse(snapshot.at) > SCHEDULES_STALE_MS,
      items: snapshot?.items ?? [],
      sources: snapshot?.sources ?? [],
    };
  }
}

function passedSince(item: Schedule, at: string): boolean {
  return (item.runs ?? []).some((run) => run.result === "ok" && Date.parse(run.at) > Date.parse(at));
}

/** Named by the schedule and the streak's first failed run when it showed; the card row keeps it for the streak. */
export function failingCardId(scheduleId: string, startRunId: string): string {
  return `${SCHEDULE_CARD_PREFIX}${createHash("sha256").update(`${scheduleId}\n${startRunId}`).digest("hex").slice(0, 16)}`;
}

/** The card rule (shared/ops-cards.ts) says this failing schedule is not yet one for you: Rivet's to handle until it is money or late. */
function holdsBack(item: Schedule, streak: Streak, now: Date, statuses: readonly OpsStatus[]): boolean {
  const owned = scheduleOwnedItem(item.id);
  const reason = cardReason({ kind: owned.kind, key: owned.key, title: item.name, text: item.what, startedAt: streak.start.at, dueAt: recordDueAt(recordOf(owned, statuses)) }, now);
  return reason === null;
}

/** A GitHub schedule's repo, when the board takes it. */
function scheduleRepo(item: Schedule): string | undefined {
  const repo = /^github:([^/]+\/[^/]+)\//.exec(item.id)?.[1];
  return repo && isRepo(repo) ? repo : undefined;
}

/** No chat on the card: an answer goes to Rivet, like any card that names none. */
function failingCard(item: Schedule, streak: Streak, id: string): Need {
  const repo = scheduleRepo(item);
  return {
    id,
    kind: "decision",
    title: `${item.name} failing since ${shortDate(streak.start.at)}`,
    ask: `Its last ${streak.length} runs failed. ${item.what}`,
    since: streak.start.at,
    ...(repo ? { repo } : {}),
    schedule: item.id,
    options: [
      { label: `Ask ${RIVET_NAME} to fix`, recommended: true },
      { label: "Leave it", detail: "No new card until it works again and then fails twice more." },
    ],
    ...(streak.newest.url ? { links: [{ label: "Open run", url: streak.newest.url, primary: true }] } : {}),
  };
}

function failingDetail(item: Schedule, streak: Streak): string {
  const repo = /^github:([^/]+\/[^/]+)\//.exec(item.id)?.[1];
  const run = streak.newest.url ?? `finished ${streak.newest.at}, no link`;
  return `Schedule: ${item.name} (${item.id})${repo ? `, repo ${repo}` : ""}. Newest failed run: ${run}.`;
}
