import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { Claim } from "../shared/claims.js";
import type { ClosedPr, MergedPr, PullRequest } from "../shared/ops.js";
import { NO_REPO } from "../shared/repos.js";

// See store.ts: node:sqlite goes through createRequire under vitest.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

// Its own connection to the app database, like SchedulesStore: one row per live claim, one per chat and pattern.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS claims (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern    TEXT NOT NULL,
  chat       TEXT NOT NULL,
  pr         INTEGER,
  branch     TEXT,
  note       TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (chat, pattern)
);
`;

interface Row {
  id: number;
  pattern: string;
  chat: string;
  pr: number | null;
  branch: string | null;
  note: string | null;
  created_at: string;
  expires_at: string;
}

/** `open` proves absence only when complete and current; observed rows can still associate a branch. */
export interface PrLifecycle {
  merged: readonly MergedPr[];
  closed: readonly ClosedPr[];
  open: readonly PullRequest[] | null;
  observedOpen?: readonly PullRequest[];
}

export class ClaimsStore {
  private readonly db: InstanceType<typeof DatabaseSync>;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "rivet.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Drops expired claims and those whose PR merged or closed, and gives a claim made on a branch the PR now open for
   * it, so the claim goes when that PR does. Returns what it dropped.
   */
  settle(now: Date, prs: PrLifecycle): Claim[] {
    const at = now.toISOString();
    const dropped = (this.db.prepare("SELECT * FROM claims WHERE expires_at <= ?").all(at) as unknown as Row[]).map(claimOf);
    this.db.prepare("DELETE FROM claims WHERE expires_at <= ?").run(at);
    const ours = (pr: { repo: string }) => pr.repo === NO_REPO;
    for (const pr of prs.observedOpen ?? prs.open ?? []) {
      if (ours(pr) && pr.branch) this.db.prepare("UPDATE claims SET pr = ? WHERE pr IS NULL AND branch = ?").run(pr.number, pr.branch);
    }
    const reopened = (number: number) => prs.open === null || prs.open.some((pr) => ours(pr) && pr.number === number);
    const gone = new Set([...prs.merged.filter(ours).map((pr) => pr.number), ...prs.closed.filter((pr) => ours(pr) && !reopened(pr.number)).map((pr) => pr.number)]);
    for (const row of this.db.prepare("SELECT * FROM claims WHERE pr IS NOT NULL").all() as unknown as Row[]) {
      if (row.pr !== null && gone.has(row.pr)) {
        this.db.prepare("DELETE FROM claims WHERE id = ?").run(row.id);
        dropped.push(claimOf(row));
      }
    }
    return dropped;
  }

  list(): Claim[] {
    return (this.db.prepare("SELECT * FROM claims ORDER BY id").all() as unknown as Row[]).map(claimOf);
  }

  /**
   * Adds the chat's claim on the pattern, or renews it: a new expiry, and any PR, branch or note given replace the old.
   * A new branch drops the old branch's PR, so the claim follows the branch's own PR from then on.
   */
  put(claim: Omit<Claim, "id">): { claim: Claim; created: boolean } {
    const current = this.db.prepare("SELECT * FROM claims WHERE chat = ? AND pattern = ?").get(claim.chat, claim.pattern) as unknown as Row | undefined;
    if (current) {
      const moved = claim.branch !== undefined && claim.branch !== current.branch;
      this.db
        .prepare("UPDATE claims SET pr = ?, branch = ?, note = ?, expires_at = ? WHERE id = ?")
        .run(claim.pr ?? (moved ? null : current.pr), claim.branch ?? current.branch, claim.note ?? current.note, claim.expiresAt, current.id);
      return { claim: claimOf(this.db.prepare("SELECT * FROM claims WHERE id = ?").get(current.id) as unknown as Row), created: false };
    }
    const result = this.db
      .prepare("INSERT INTO claims (pattern, chat, pr, branch, note, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(claim.pattern, claim.chat, claim.pr ?? null, claim.branch ?? null, claim.note ?? null, claim.createdAt, claim.expiresAt);
    return { claim: claimOf(this.db.prepare("SELECT * FROM claims WHERE id = ?").get(result.lastInsertRowid) as unknown as Row), created: true };
  }

  /** Removes the chat's claim by id or pattern; null when the chat holds no such claim. */
  release(chat: string, by: { id: number } | { pattern: string }): Claim | null {
    const row = (
      "id" in by
        ? this.db.prepare("SELECT * FROM claims WHERE chat = ? AND id = ?").get(chat, by.id)
        : this.db.prepare("SELECT * FROM claims WHERE chat = ? AND pattern = ?").get(chat, by.pattern)
    ) as unknown as Row | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM claims WHERE id = ?").run(row.id);
    return claimOf(row);
  }
}

function claimOf(row: Row): Claim {
  return {
    id: `c-${row.id}`,
    pattern: row.pattern,
    chat: row.chat,
    ...(row.pr === null ? {} : { pr: row.pr }),
    ...(row.branch === null ? {} : { branch: row.branch }),
    ...(row.note === null ? {} : { note: row.note }),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
