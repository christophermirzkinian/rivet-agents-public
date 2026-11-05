import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LEGACY_ERROR, StateStore } from "../lib/state.mjs";

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-state-"));
  return path.join(dir, "nested", "state.json");
}
/** @param {string} id */
const entry = (id) => ({
  id,
  itemId: "i",
  processedAt: "t",
  delivery: { target: /** @type {const} */ ("chat"), chat: "c", at: "t" },
  acked: true,
});

test("round-trips through disk with private permissions and no temp files", () => {
  const file = tmpFile();
  const s = new StateStore(file).load();
  s.put(entry("a"));
  s.put({ ...entry("b"), github: { url: "https://github.com/o/r/pull/1#issuecomment-1" } });
  const again = new StateStore(file).load();
  assert.deepEqual(again.get("b")?.github, { url: "https://github.com/o/r/pull/1#issuecomment-1" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"]);
});

test("an error saved before redaction is kept only as fixed words, on disk too", () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A made-up secret shape, cut before any redaction as the old short() saved it.
  const raw = "gh exit 1: password=not-a-real-pass-42";
  const shaped = { ...entry("b"), github: { error: "gh exit 1: HTTP 502" }, shaped: true };
  fs.writeFileSync(file, JSON.stringify({ version: 1, replies: [{ ...entry("a"), github: { error: raw } }, shaped] }));
  const s = new StateStore(file).load();
  assert.deepEqual(s.get("a")?.github, { error: LEGACY_ERROR });
  assert.deepEqual(s.get("b")?.github, { error: "gh exit 1: HTTP 502" });
  assert.equal(fs.readFileSync(file, "utf8").includes("not-a-real-pass"), false);
});

test("keeps only the newest max entries", () => {
  const file = tmpFile();
  const s = new StateStore(file, { max: 3 }).load();
  for (const id of ["a", "b", "c", "d", "e"]) s.put(entry(id));
  const again = new StateStore(file, { max: 3 }).load();
  assert.equal(again.get("a"), undefined);
  assert.equal(again.get("b"), undefined);
  assert.deepEqual([...again.entries.keys()], ["c", "d", "e"]);
});

test("re-putting an id moves it to newest", () => {
  const s = new StateStore(tmpFile(), { max: 2 }).load();
  s.put(entry("a"));
  s.put(entry("b"));
  s.put({ ...entry("a"), acked: false });
  s.put(entry("c"));
  assert.deepEqual([...s.entries.keys()], ["a", "c"]);
});

test("a corrupt file is set aside, not fatal", () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{nope");
  /** @type {string[]} */
  const logs = [];
  const s = new StateStore(file, { log: (e) => logs.push(e) }).load();
  assert.equal(s.entries.size, 0);
  assert.deepEqual(logs, ["state-corrupt"]);
  assert.equal(fs.readdirSync(path.dirname(file)).some((f) => f.startsWith("state.json.corrupt-")), true);
});

test("a missing file loads empty", () => {
  assert.equal(new StateStore(tmpFile()).load().entries.size, 0);
});
