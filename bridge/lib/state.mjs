import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_STATE_FILE = path.join(homedir(), ".rivet-agents", "bridge", "state.json");
export const MAX_ENTRIES = 2000;
/** What a GitHub error saved before redaction is kept and sent as. */
export const LEGACY_ERROR = "details not kept (written before redaction)";

/**
 * @typedef {{ id: string, itemId: string, processedAt: string,
 *   delivery: { target: "chat" | "rivet", chat: string, at: string, confirmed: boolean, stages: string[] },
 *   github?: { url: string } | { error: string }, acked: boolean, shaped?: true, noticeOwed?: boolean }} StateEntry
 * (shaped: its github.error was redacted before it was cut)
 */

/** Reply ids the bridge has already delivered, newest last, capped at `max`. */
export class StateStore {
  /**
   * @param {string} file
   * @param {{ max?: number, log?: (event: string, fields?: Record<string, unknown>) => void }} [opts]
   */
  constructor(file = DEFAULT_STATE_FILE, { max = MAX_ENTRIES, log = () => {} } = {}) {
    this.file = file;
    this.max = max;
    this.log = log;
    /** @type {Map<string, StateEntry>} */
    this.entries = new Map();
  }

  load() {
    let text;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return this;
      throw err;
    }
    let scrubbed = false;
    try {
      const doc = JSON.parse(text);
      if (!doc || !Array.isArray(doc.replies)) throw new Error("no replies array");
      for (const e of doc.replies) {
        if (!e || typeof e.id !== "string") continue;
        // An unshaped error was cut before any redaction: it is kept only as fixed words, on disk too.
        if (!e.shaped && e.github && typeof e.github === "object" && "error" in e.github) {
          e.github = { error: LEGACY_ERROR };
          scrubbed = true;
        }
        this.entries.set(e.id, e);
      }
    } catch {
      // A corrupt file must not wedge the daemon; set it aside and start clean.
      const aside = `${this.file}.corrupt-${Date.now()}`;
      fs.renameSync(this.file, aside);
      this.log("state-corrupt", { movedTo: path.basename(aside) });
      this.entries.clear();
      scrubbed = false;
    }
    this.trim();
    if (scrubbed) this.save();
    return this;
  }

  /** @param {string} id */
  get(id) {
    return this.entries.get(id);
  }

  /** @param {StateEntry} entry */
  put(entry) {
    this.entries.delete(entry.id);
    this.entries.set(entry.id, entry);
    this.trim();
    this.save();
  }

  trim() {
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  save() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${path.basename(this.file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    const body = `${JSON.stringify({ version: 1, replies: [...this.entries.values()] })}\n`;
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, this.file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
}
