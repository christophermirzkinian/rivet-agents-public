import { describe, expect, it } from "vitest";

import { spendLines, type ClaudeLimit, type OpsResponse } from "../src/shared/ops.js";

// The test zone is +11: 3 Oct 01:00 UTC is 12:00 local time.
const NOW = "2026-10-03T01:00:00.000Z";
const at = Date.parse(NOW);
const DAY = 86_400_000;

const codex = (n: number, who: string, percent: number, extra: Partial<ClaudeLimit> = {}): ClaudeLimit => ({
  kind: `codex_${n}_week`,
  label: `${who}, week`,
  percent,
  severity: "normal",
  resetsAt: new Date(at + 1.5 * DAY).toISOString(),
  active: false,
  credits: 61_467,
  unlimited: false,
  ...extra,
});

function ops(over: { limits?: ClaudeLimit[]; stale?: boolean; claudeAt?: string } = {}): Pick<OpsResponse, "claude"> {
  return { claude: { at: over.claudeAt ?? NOW, stale: over.stale ?? false, limits: over.limits ?? [] } };
}

describe("spendLines: Codex credits", () => {
  it("words each Codex state, and the tile names a Codex account near its limit", () => {
    const limits = [
      codex(1, "ab***", 62),
      codex(2, "cd***", 93, { severity: "warning" }),
      codex(3, "ef***", 100, { severity: "critical" }),
      codex(4, "gh***", 40, { credits: 0 }),
      { kind: "codex_5", label: "zz*** (no reading)", percent: 0, severity: "normal", resetsAt: null, active: false } as ClaudeLimit,
      codex(6, "aa***", 10, { credits: null, unlimited: true }),
    ];
    const view = spendLines(ops({ limits }), at);
    expect(view.codex.map((row) => [row.who, row.text, row.tone])).toEqual([
      ["ab***", "week 62% · 61,467 credits", "ok"],
      ["cd***", "week 93% · resets Mon 12:00am, in 1 day, 12h 0m · 61,467 credits", "warn"],
      ["ef***", "week 100% · resets Mon 12:00am, in 1 day, 12h 0m · 61,467 credits", "bad"],
      ["gh***", "week 40% · no credits", "warn"],
      ["zz***", "no reading", "warn"],
      ["aa***", "week 10% · unlimited credits", "ok"],
    ]);
    expect(view.tile.text).toBe("Codex 100%");
    expect(view.tile.tone).toBe("bad");
    expect(spendLines(ops({ limits: [codex(1, "gh***", 40, { credits: 0 })] }), at).tile.text).toBe("Codex no credits");
    // Graded as the bridge graded it: 99.5% the bridge calls a warning is amber, not red.
    expect(spendLines(ops({ limits: [codex(1, "cd***", 99.5, { severity: "warning" })] }), at).codex[0]!.tone).toBe("warn");
  });

  it("is empty with no Codex row or no reading, and the foot says when the reading was taken", () => {
    const account: ClaudeLimit = { kind: "account_1", label: "Account ab***", percent: 30, severity: "normal", resetsAt: null, active: false };
    const view = spendLines(ops({ limits: [account] }), at);
    expect(view).toEqual({ tone: "idle", headline: "", tile: { text: "", tone: "idle", parts: [] }, codex: [], read: NOW });
    expect(spendLines({ claude: null }, at)).toMatchObject({ codex: [], read: null, tile: { text: "" } });
  });

  it("marks a stale reading amber, by its flag or its age", () => {
    const limits = [codex(1, "ab***", 62)];
    expect(spendLines(ops({ limits }), at).codex[0]!.tone).toBe("ok");
    expect(spendLines(ops({ limits, stale: true }), at).codex[0]!.tone).toBe("warn");
    expect(spendLines(ops({ limits, claudeAt: new Date(at - 11 * 60_000).toISOString() }), at).codex[0]!.tone).toBe("warn");
    const critical = [codex(1, "ab***", 100, { severity: "critical" })];
    expect(spendLines(ops({ limits: critical, stale: true }), at).codex[0]!.tone, "red stays red").toBe("bad");
  });
});
