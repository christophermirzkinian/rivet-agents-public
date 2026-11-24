import assert from "node:assert/strict";
import { test } from "node:test";

import { opsPickupDetail, opsPickupLine } from "../lib/bridge.mjs";
import { NO_REPO } from "../lib/validate.mjs";

test("a reader's red passes into the pick-up line, and nothing beside it", () => {
  const good = [
    "reader stale: never ran",
    "reader stale: no good reading for 47 min (wanted within 30 min)",
    "reader stale: no good reading for 3 days (wanted within 26 h)",
    "reader stale: no good reading for 1 day (wanted within 8 days)",
    "reader empty: ran but wrote nothing for 26 h",
    "reader empty: ran but wrote nothing",
    "reader empty: no runs and no PRs",
    "reader empty: no apps",
    "reader empty: no repos",
    "reader empty: no accounts",
    "reader wrong: reading time ahead of now",
    "reader wrong: a negative count",
    "reader wrong: an app listed twice",
    "reader wrong: flyctl failed for every app (auth?)",
    "reader wrong: a repo listed twice",
    "reader wrong: no account has a reading",
  ];
  for (const reason of good) assert.equal(opsPickupDetail(reason), reason);
  const bad = [
    "reader stale: no good reading for ages (wanted within 30 min)",
    "reader empty: hunter2",
    "reader wrong: hunter2",
    "reader stale: never ran hunter2",
    "reader empty: ran but wrote nothing for 26 h, token=abc",
    "reader stale: no good reading for 47 min (wanted within 30 min) hunter2",
  ];
  for (const reason of bad) assert.equal(opsPickupDetail(reason), "", reason);
});

test("a reader's pick-up line hands its fix chat the reason; other items' lines are as before", () => {
  const line = opsPickupLine("schedule", "reader-github", NO_REPO, "reader stale: no good reading for 47 min (wanted within 15 min)");
  assert.match(line ?? "", /Run rivet fix schedule reader-github --brief "reader stale: no good reading for 47 min \(wanted within 15 min\)" --by rivet/);
  assert.doesNotMatch(opsPickupLine("schedule", "reader-github", NO_REPO, "reader wrong: hunter2") ?? "", /--brief/);
  assert.doesNotMatch(opsPickupLine("machine", "mac", NO_REPO, "Bridge offline") ?? "", /--brief/);
});
