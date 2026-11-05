import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PushPayload } from "../src/server/push.js";
import { DIGEST_GIVE_UP_MS, DIGEST_RETRY_MS, MAX_HELD, QuietStore } from "../src/server/quiet.js";

const night = new Date("2026-09-28T13:00:00Z");
const day = new Date("2026-09-28T21:00:00Z");
const payload = (tag: string): PushPayload => ({ title: tag, body: "Check this", tag, path: "/" });

describe("quiet retry selection", () => {
  let dir: string;
  let gate: QuietStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rivet-quiet-retry-"));
    gate = new QuietStore(dir);
  });
  afterEach(() => { gate.close(); rmSync(dir, { recursive: true, force: true }); });

  it("supersedes only matching snapshot rows, retaining keys and newer rows", () => {
    expect(gate.lastHeldId()).toBe(0);
    gate.hold(payload("same"), night, "old-key");
    gate.hold(payload("different"), night, "other-key");
    gate.hold(payload("same"), night);
    const snapshot = gate.lastHeldId();
    gate.hold(payload("same"), night, "new-key");
    expect(gate.supersede("same", snapshot)).toEqual(["old-key"]);
    expect(gate.hasKey("old-key")).toBe(true);
    expect(gate.lastHeldId()).toBe(4);
    expect(gate.releasable(day)).toMatchObject({ ids: [2, 4], keys: ["other-key", "new-key"], dropped: 0 });
  });

  it("migrates old held rows without making them breakthrough retries", () => {
    gate.close();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(join(dir, "rivet.sqlite"));
    db.exec("ALTER TABLE held_pushes DROP COLUMN retry_category");
    db.prepare("INSERT INTO held_pushes (json, at, key) VALUES (?, ?, ?)").run(JSON.stringify(payload("old")), night.toISOString(), "old-key");
    db.close();
    gate = new QuietStore(dir);
    expect(gate.releasable(night)).toBeNull();
    gate.hold(payload("card-retry"), night, "retry-key", 0, "card");
    expect(gate.releasable(night)).toBeNull();
    expect(gate.releasable(day)!.keys).toEqual(["old-key", "retry-key"]);
  });

  it("clears retry timing when supersession empties the queue without clearing pending counts", () => {
    for (let n = 0; n <= MAX_HELD; n++) gate.hold(payload("old"), day);
    gate.hold(payload("old"), day, "old-key", 3);
    gate.settle(gate.releasable(day)!, false, day);
    expect(gate.releasable(day)).toBeNull();
    expect(gate.supersede("old", gate.lastHeldId())).toEqual(["old-key"]);
    expect(gate.heldCount()).toBe(0);
    gate.hold(payload("fresh"), day, "fresh-key");
    const fresh = gate.releasable(day)!;
    expect(fresh).toMatchObject({ keys: ["fresh-key"], dropped: 2, unsent: 3 });
    // The new failure starts its own expiry window and initial one-minute backoff.
    const later = new Date(day.getTime() + DIGEST_GIVE_UP_MS);
    expect(gate.settle(fresh, false, later)).toBe(false);
    expect(gate.releasable(new Date(later.getTime() + DIGEST_RETRY_MS - 1))).toBeNull();
    expect(gate.releasable(new Date(later.getTime() + DIGEST_RETRY_MS))!.keys).toEqual(["fresh-key"]);
  });
});
