import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// What the bridge last reported for each card action, kept on disk until the
// server has it. A lost ack is retried from here, and after a restart the
// server's list of unfinished actions is answered from here.

export const JOURNAL_MAX = 500;
const ISSUE_KEPT_MS = 24 * 3600_000;

/**
 * @typedef {{ status: string, detail?: Record<string, unknown>, shaped?: true }} Report
 * @typedef {{ id: string, kind: string, startedAt: string, last?: Report, acked: boolean, ackedAt?: string, note?: Record<string, unknown> }} JournalEntry
 *   `note`: what an action needs to carry on after a restart (an armed merge's PR and head, a deploy run's status file).
 */

export class ActionJournal {
  /** @param {string} file */
  constructor(file) {
    this.file = file;
    /** @type {Map<string, JournalEntry>} */
    this.entries = new Map();
    try {
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const entry of Array.isArray(doc?.actions) ? doc.actions : []) {
        if (entry && typeof entry.id === "string" && typeof entry.kind === "string") this.entries.set(entry.id, entry);
      }
    } catch {
      // Missing or unreadable: start empty; unfinished actions are then reported as interrupted.
    }
  }

  /** @param {string} id */
  get(id) {
    return this.entries.get(id);
  }

  /** Written before an action does anything, so a restart mid-action is known. @param {string} id @param {string} kind @param {string} at */
  start(id, kind, at) {
    if (this.entries.has(id)) return;
    this.entries.set(id, { id, kind, startedAt: at, acked: false });
    this.save();
  }

  /** @param {string} id @param {Report} report */
  report(id, report) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.last = report;
    entry.acked = false;
    this.save();
  }

  /** Merges `fields` into the action's note. @param {string} id @param {Record<string, unknown>} fields */
  note(id, fields) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.note = { ...entry.note, ...fields };
    this.save();
  }

  /** @param {string} id @param {Report} report the report the server confirmed */
  acked(id, report) {
    const entry = this.entries.get(id);
    if (!entry || entry.last !== report) return;
    entry.acked = true;
    entry.ackedAt = new Date().toISOString();
    this.save();
  }

  save() {
    // Oldest first, JOURNAL_MAX kept. A GitHub write the server has not confirmed, or confirmed in the last day, is kept
    // over that and not counted (it keeps one queued for good and sends it again on each attach, and a send already on
    // its way can land after the confirm; only this entry stops it commenting twice), so it never pushes out another.
    const settled = Date.now() - ISSUE_KEPT_MS;
    const held = (/** @type {JournalEntry} */ entry) => entry.kind === "issue" && !(entry.acked && Date.parse(entry.ackedAt ?? entry.startedAt) < settled);
    let counted = [...this.entries.values()].filter((entry) => !held(entry)).length;
    for (const [id, entry] of this.entries) {
      if (counted <= JOURNAL_MAX) break;
      if (held(entry)) continue;
      this.entries.delete(id);
      counted--;
    }
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${path.basename(this.file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, actions: [...this.entries.values()] })}\n`, { mode: 0o600, flag: "wx" });
    try {
      fs.renameSync(tmp, this.file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
}
