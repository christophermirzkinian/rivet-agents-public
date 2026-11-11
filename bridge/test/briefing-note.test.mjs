import assert from "node:assert/strict";
import { test } from "node:test";

import { checkNote, parseArgs } from "../../scripts/briefing-note.mjs";

// say's `--text --stdin` sent the owner "--stdin" 14 times on 11 Nov; a briefing note is refused the same way.
test("briefing-note refuses a note that starts with --, and keeps one with -- later on", () => {
  assert.deepEqual(parseArgs(["--text", "--stdin"]), { text: "--stdin" });
  assert.equal(checkNote("--stdin").error, '--text got "--stdin" as the note, a flag; give --text the note itself. Nothing was sent');
  assert.match(String(checkNote("  --help").error), /^--text got "--help" as the note/);
  assert.match(String(checkNote(String(parseArgs(["--text", "-h"]).text)).error), /^--text got "-h" as the note/);
  assert.deepEqual(checkNote("Merged -- the gate was green"), { line: "Merged -- the gate was green" });
  assert.deepEqual(checkNote("- one bullet"), { line: "- one bullet" });
});
