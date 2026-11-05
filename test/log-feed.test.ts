import { describe, expect, it } from "vitest";

import { logFeed } from "../src/shared/log-feed.js";
import { when } from "../src/shared/when.js";

// Chat tails as the bridge uploads them, redacted, wrapped at the terminal's width (from real chats, ids shortened).
const CLAUDE_TAIL = [
  "Ran 2 shell commands",
  "⏺ That test runs on the demo/terminal path, so it does not show that a shop billing is left alone. Looking for a",
  "ShopAccounting test harness with a fake billing.",
  "Read 1 file, ran 4 shell commands",
  "⏺ Bash(cd ~/wt-B/web-cache && grep -rnE 'holdsEntry' server/src | head)",
  "⎿  src/shopApi.ts:120: holdsEntry(",
  "   … +14 lines (ctrl+o to expand)",
  "⏺ Update(server/src/shopApi.test.ts)",
  "⎿  Updated server/src/shopApi.test.ts with 2 additions",
  "11 -    expect(source).toContain(\"viewer: launchViewer,\");",
  "12 +    expect(source).toContain(\"load(CACHE_KEY, 100)\");",
  "+mpt \"Read and follow <brief>…\" --json",
  "⎿  “#649 plan: server already makes replay lookup-only; pin it” → sent to monitor-e3 — another Claude session",
  "on this machine",
  "⏺ The #649 plan is with the monitor. I saved the notes to /private/tmp/claude-502/x/scratchpad/r4/brief.md and",
  "will write the server test now.",
  "⎿  $ S=/private/tmp/claude-502/-Users-someone-um-b03-two-tabs/39923c27-04c7-4b",
  "d9-a106-45a4edcaa615/scratchpad; cd $S/wt-B/web-cache && grep -rnE '`account:\\$\\{|\"account:' server/src |",
  "grep -v '\\.test\\.' | cut -c1-220 | head",
  "› Message from @monitor-e3: #649 plan OK: proof test plus the one rule (c) line, no client or schema change, high",
  "tier. Ask for GO PUSH when ready. (ctrl+o to expand)",
  "✶ Enchanting… (4m 44s · ↓ 11.2k tokens",
  "· thought for 10s)",
  "⎿  Tip: Double-tap esc to rewind the code and/or conversation to a previous point in time",
  "5% until auto-compact",
  "────────────────────────────────────────────────────────────────────────",
  "❯",
  "────────────────────────────────────────────────────────────────────────",
  "⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent",
];

describe("live log feed", () => {
  it("keeps what the chat said and sent, newest first, and drops commands, paths, spinners, tips and box lines", () => {
    expect(logFeed(CLAUDE_TAIL).map(({ kind, who, text }) => (who ? [kind, who, text] : [kind, text]))).toEqual([
      ["heard", "monitor-e3", "#649 plan OK: proof test plus the one rule (c) line, no client or schema change, high tier. Ask for GO PUSH when ready."],
      ["said", "The #649 plan is with the monitor. I saved the notes to brief.md and will write the server test now."],
      ["sent", "monitor-e3", "#649 plan: server already makes replay lookup-only; pin it"],
      ["said", "That test runs on the demo/terminal path, so it does not show that a shop billing is left alone. Looking for a ShopAccounting test harness with a fake billing."],
    ]);
    const text = logFeed(CLAUDE_TAIL).map((entry) => entry.text).join("\n");
    for (const gone of ["grep", "Enchanting", "Tip:", "auto-compact", "───", "bypass", "/private/", "scratchpad", "Ran 2", "CACHE_KEY", "thought for"]) {
      expect(text).not.toContain(gone);
    }
  });

  it("hides lines that continue something above the read", () => {
    expect(logFeed(["the end of a long command | head", "more of it", "⏺ Done: 19 apps deployed."]).map((entry) => entry.text)).toEqual(["Done: 19 apps deployed."]);
  });

  it("keeps a list's breaks while joining wrapped lines, and puts a newer status row above older rows", () => {
    const rule = "─".repeat(60);
    const lines = [
      "⏺ The card-counts change went to push at 18:26 and stays on hold until you answer",
      "its confirm card.",
      "Push order:",
      "1. #687, now past its done-by time.",
      "2. #327.",
      "⏺ Task \"Deploy the merge\" still running in background",
      rule,
    ];
    const times = ["2026-10-26T07:26:00.000Z", null, null, null, null, "2026-10-26T07:28:00.000Z", null];
    expect(logFeed(lines, times).map((entry) => entry.text)).toEqual([
      'Task "Deploy the merge" still running in background',
      "The card-counts change went to push at 18:26 and stays on hold until you answer its confirm card.\nPush order:\n1. #687, now past its done-by time.\n2. #327.",
    ]);
  });

  it("hides the working line once done, the update notice and a searched row", () => {
    const lines = ["⏺ Pushed #683.", "✻ Baked for 1m 8s · done 6:28 PM · 3 shells still running", "✔ Update installed · Restart to update", "› Message from @monitor-e3: GO PUSH", "Searched for 1 pattern, ran 1 shell command"];
    expect(logFeed(lines).map((entry) => entry.text)).toEqual(["GO PUSH", "Pushed #683."]);
  });

  it("hides a working line of more than one word, not folding it into the sentence above", () => {
    expect(logFeed(["⏺ Callouts now sit in the top band.", "✽ Waiting for CI… (2m 10s · ↓ 1.2k tokens)"]).map((entry) => entry.text)).toEqual(["Callouts now sit in the top band."]);
    expect(logFeed(["⏺ Next:", "* Waiting for CI… (owner approval required)"]).map((entry) => entry.text)).toEqual(["Next:\n* Waiting for CI… (owner approval required)"]);
  });

  it("knows a message from a chat whose name the screen cut short", () => {
    expect(logFeed(["› Message from @your-asks-count-copy…: rebased, pushing now"])).toEqual([
      { at: null, kind: "heard", who: "your-asks-count-copy…", text: "rebased, pushing now" },
    ]);
  });

  it("reads Codex's rows the same way", () => {
    const tail = ["• Ran pnpm test", "  └ 12 passed", "• All 12 tests pass; pushing next.", "› run the release check", "─ Worked for 1m 02s ─", "• Working (12s • esc to interrupt)"];
    expect(logFeed(tail).map(({ kind, text }) => [kind, text])).toEqual([
      ["asked", "run the release check"],
      ["said", "All 12 tests pass; pushing next."],
    ]);
  });

  it("dates each entry by its first line, in the set zone's time, and shows a repainted entry once at its first time", () => {
    const lines = ["⏺ Deployed 19 apps and", "verified each.", "⏺ Deployed 19 apps and verified each."];
    const times = ["2026-10-26T06:53:10.000Z", "2026-10-26T06:53:12.000Z", "2026-10-26T06:58:00.000Z"];
    const feed = logFeed(lines, times);
    expect(feed).toEqual([{ at: "2026-10-26T06:53:10.000Z", kind: "said", text: "Deployed 19 apps and verified each." }]);
    expect(when(feed[0]!.at!, "2026-10-26T07:00:00.000Z")).toBe("5:53pm");
    expect(logFeed(["⏺ Earlier work"])[0]!.at).toBeNull();
  });

  it("only drops, joins and trims: every word it shows is in the redacted lines", () => {
    const redacted = ["⏺ Set the token to [redacted] and restarted the bridge on [redacted-ip]."];
    const [entry] = logFeed(redacted);
    expect(entry!.text).toBe("Set the token to [redacted] and restarted the bridge on [redacted-ip].");
    for (const word of logFeed(CLAUDE_TAIL).flatMap((one) => one.text.split(/\s+/))) expect(CLAUDE_TAIL.join(" ")).toContain(word);
  });
});
