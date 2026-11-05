import { describe, expect, it } from "vitest";

import { redactFeed, redactLog, redactScreen } from "../src/server/redact.js";
import { logFeed } from "../src/shared/log-feed.js";
import { cleanLine, screenView, toneOf } from "../src/shared/screen-view.js";

// Screens as Claude Code and Codex draw them (shapes read from real chats on 2 Nov; words made up).
const CLAUDE = [
  "  to read, ending a sentence the read cut off.",
  "  Read 1 file, ran 4 shell commands",
  "⏺ PR body drafted; still waiting on the push queue. Checking how the",
  "  PR fills its release notes section.",
  "  Ran 1 shell command",
  "⏺ Bash(pnpm vitest run callouts)",
  "  ⎿  ✓ 14 passed (2.1s)",
  "⏺ Bash(git push origin",
  "  HEAD:refs/heads/map-callouts)",
  "  ⎿  To github.com:owner/repo.git",
  "     abc123..def456  HEAD -> map-callouts",
  "⏺ Fixed it. Three things changed:",
  "  - the callouts sit in the top band,",
  "    clear of the cars",
  "  - 2 tests added",
  "  ⎿  “#303 pushed 77a47e9f7e” → sent to monitor-79 — another Claude session on this machine",
  "✻ Churned for 6m 56s · done 3:22 PM · 3 shells still running",
  "› Message from @monitor-79: monitor-79: one small addition, same PR, due 5pm. your still:",
  "~/work/out/rive… (ctrl+o to expand)",
  "  Probing crowded map bubbles for covered ones",
  "  ⎿  $ cd rivet; npx vite --port 5347",
  "  Reading ~/work/out/a.png",
  "  ⎿  ~/work/out/a.png",
  "✽ Puttering… (2m 48s · ↓ 9.6k tokens · thinking with high effort)",
  "  ⎿  Tip: Name your conversations with /rename",
  "────────────────────────────────────────────────────────────",
  "❯",
  "────────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent",
];

describe("screenView", () => {
  it("labels each tool with its result under it, keeps the chat's words as text, and drops the terminal's noise", () => {
    expect(screenView(CLAUDE)).toEqual([
      { kind: "said", text: "to read, ending a sentence the read cut off." },
      { kind: "tool", name: "Tools", detail: "Read 1 file, ran 4 shell commands", result: [] },
      { kind: "said", text: "PR body drafted; still waiting on the push queue. Checking how the PR fills its release notes section." },
      { kind: "tool", name: "Bash", detail: "1 shell command", result: [] },
      { kind: "tool", name: "Bash", detail: "pnpm vitest run callouts", result: [{ text: "✓ 14 passed (2.1s)", tone: "ok" }] },
      {
        kind: "tool",
        name: "Bash",
        detail: "git push origin HEAD:refs/heads/map-callouts",
        result: [
          { text: "To github.com:owner/repo.git", tone: null },
          { text: "abc123..def456  HEAD -> map-callouts", tone: null },
        ],
      },
      { kind: "said", text: "Fixed it. Three things changed:\n- the callouts sit in the top band, clear of the cars\n- 2 tests added" },
      { kind: "message", way: "out", who: "monitor-79", text: "#303 pushed 77a47e9f7e" },
      { kind: "message", way: "in", who: "monitor-79", text: "one small addition, same PR, due 5pm. your still: ~/work/out/rive…" },
      { kind: "tool", name: "Bash", detail: "Probing crowded map bubbles for covered ones", result: [{ text: "$ cd rivet; npx vite --port 5347", tone: null }] },
      { kind: "tool", name: "Read", detail: "~/work/out/a.png", result: [] },
      { kind: "working", text: "Busy · 2m 48s" },
    ]);
  });

  it("reads the screen the same way once masked: the Mac's redactor trims every line's indent", () => {
    expect(screenView(CLAUDE.map((line) => line.trim()))).toEqual(screenView(CLAUDE));
  });

  it("drops the rest of a tip the terminal wrapped, and calls a tool under way with a command under it a shell command", () => {
    expect(
      screenView(["⏺ Reading the freeze decision note", "⎿  $ sed -n 1,30p docs/notes/app/freeze.md", "⎿  Tip: Run /help to see more of what it does — 3 free", "reviews left", "❯"]),
    ).toEqual([{ kind: "tool", name: "Bash", detail: "Reading the freeze decision note", result: [{ text: "$ sed -n 1,30p docs/notes/app/freeze.md", tone: null }] }]);
    // Its marker blinks while it runs: without it, it reads the same.
    expect(screenView(["Reading the freeze decision note", "⎿  $ sed -n 1,30p docs/a.md"])).toEqual([
      { kind: "tool", name: "Bash", detail: "Reading the freeze decision note", result: [{ text: "$ sed -n 1,30p docs/a.md", tone: null }] },
    ]);
  });

  it("reads a masked Claude screen's bullets as list rows and a read's line count as its result", () => {
    expect(screenView(["⏺ Two things:", "• one", "• two"])).toEqual([{ kind: "said", text: "Two things:\n• one\n• two" }]);
    expect(screenView(["⏺ Read(src/a.ts)", "⎿ src/a.ts", "Read 40 lines"])).toEqual([
      { kind: "tool", name: "Read", detail: "src/a.ts", result: [{ text: "Read 40 lines", tone: null }] },
    ]);
  });

  it("never joins the pieces of a word a colour code without its escape split: the masking never saw them whole", () => {
    expect(cleanLine("ghp_ABCD[31mEFGH[31mIJKL[0m")).toBe("ghp_ABCD EFGH IJKL");
    expect(screenView(["⏺ ghp_ABCD[31mEFGH[31mIJKLMNOPQRSTUVWXYZ0123456789"])).toEqual([{ kind: "said", text: "ghp_ABCD EFGH IJKLMNOPQRSTUVWXYZ0123456789" }]);
  });

  it("reads a * row with no timer as a list row, and Codex's Added and Deleted rows as tools", () => {
    expect(screenView(["⏺ Next:", "* Waiting for CI…", "then deploy."])).toEqual([{ kind: "said", text: "Next:\n* Waiting for CI… then deploy." }]);
    expect(screenView(["⏺ Next:", "* Test for 2 regions"])).toEqual([{ kind: "said", text: "Next:\n* Test for 2 regions" }]);
    expect(screenView(["⏺ Next:", "* Waiting for CI… (owner approval required)"])).toEqual([{ kind: "said", text: "Next:\n* Waiting for CI… (owner approval required)" }]);
    expect(screenView(["• Added src/a.ts (+1 -0)", "• Deleted src/b.ts"]).map((item) => item.kind)).toEqual(["tool", "tool"]);
  });

  it("joins a call the terminal wrapped inside a nested bracket", () => {
    expect(screenView(["⏺ Bash(echo $(pwd)", "&& pnpm test)", "⎿  ok"])).toEqual([{ kind: "tool", name: "Bash", detail: "echo $(pwd) && pnpm test", result: [{ text: "ok", tone: "ok" }] }]);
  });

  it("shows no working line once the turn is done, and none for a spinner above the end", () => {
    const items = screenView(["✻ Baking… (10s)", "⏺ Done for now.", "✻ Baked for 12s · done 3:22 PM", "❯"]);
    expect(items).toEqual([{ kind: "said", text: "Done for now." }]);
  });

  it("strips colour codes and frame borders, and keeps what a framed row holds", () => {
    expect(cleanLine("\u001b[32m✓ ok\u001b[0m")).toBe("✓ ok");
    expect(cleanLine("[1;31mfailed[0m")).toBe("failed");
    expect(screenView(["╭──────────╮", "│ Do you want to proceed? │", "╰──────────╯"])).toEqual([{ kind: "said", text: "Do you want to proceed?" }]);
  });

  it("reads Codex's rows: a tool and its result, and its own words", () => {
    expect(screenView(["• Ran pnpm test", "  └ 3 failed, 10 passed", "• All set; pushing next.", "─ Worked for 1m 02s ─"])).toEqual([
      { kind: "tool", name: "Bash", detail: "pnpm test", result: [{ text: "3 failed, 10 passed", tone: "bad" }] },
      { kind: "said", text: "All set; pushing next." },
    ]);
  });

  it("does not start an item at an indented bullet: it is a list row of the words above", () => {
    expect(screenView(["⏺ Two things:", "  • one", "  • two"])).toEqual([{ kind: "said", text: "Two things:\n• one\n• two" }]);
  });

  it("drops a result the read cut off at the top, and a read's echo of the file it read", () => {
    expect(screenView(["  ⎿  Successfully loaded skill", "⏺ Read(src/a.ts)", "  ⎿  src/a.ts", "     Read 40 lines"])).toEqual([
      { kind: "tool", name: "Read", detail: "src/a.ts", result: [{ text: "Read 40 lines", tone: null }] },
    ]);
  });

  it("keeps a paragraph break after a blank line and drops repeated blanks", () => {
    expect(screenView(["⏺ First.", "", "", "  Second."])).toEqual([{ kind: "said", text: "First.\n\nSecond." }]);
  });

  it("colours passes green and failures red, and reads 0 failed as a pass", () => {
    expect(toneOf("Tests 42 passed, 0 failed")).toBe("ok");
    expect(toneOf("Error: ENOENT")).toBe("bad");
    expect(toneOf("✗ 2 failing")).toBe("bad");
    expect(toneOf("12 + const a = 1;")).toBe("ok");
    expect(toneOf("12 - const a = 0;")).toBe("bad");
    expect(toneOf("Wrote 3 files")).toBe(null);
  });

  it("never adds words of its own beyond the labels: every shown word is on the screen", () => {
    const words = (text: string) => text.split(/\s+/).filter(Boolean);
    const screen = new Set(CLAUDE.flatMap((line) => words(cleanLine(line).replace(/[()]/g, " "))));
    const labels = new Set(["Tool", "Tools", "Bash", "Read", "Busy", "·"]);
    for (const item of screenView(CLAUDE)) {
      const shown = item.kind === "tool" ? [item.name, item.detail, ...item.result.map((one) => one.text)] : [item.text];
      for (const word of shown.flatMap(words).map((one) => one.replace(/[()]/g, ""))) {
        if (!word || labels.has(word)) continue;
        expect([...screen].some((one) => one.includes(word)), word).toBe(true);
      }
    }
  });
});

describe("redactScreen", () => {
  // Made-up secrets, wrapped across lines as a terminal draws them; each line is masked first, as the server does.
  const token = "ghp_" + "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Y";
  const rows = (words: string[]) => Array.from({ length: Math.ceil(words.length / 100) }, (_, at) => (at ? "" : "⎿ ") + words.slice(at * 100, at * 100 + 100).join(" "));
  const cases: [string[], string[]][] = [
    [["⏺ Basic", "dGVzdDph"], ["dGVzdDph"]],
    [["⏺ Bearer", ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "abcDEF123456"].join(".")], ["eyJhbGciOiJIUzI1NiJ9"]],
    [["⏺ Bash(curl -H 'Authorization: Bearer", "zqv7Kp2LmN9xR4tW8yB3cF6hJ1sD5gQ0')"], ["zqv7Kp2LmN9xR4tW8yB3cF6hJ1sD5gQ0"]],
    [["⏺ The token is " + token.slice(0, 20), token.slice(20)], [token.slice(0, 20), token.slice(20)]],
    [["⏺ Bash(echo " + token.slice(0, 20), token.slice(20) + ")", "⎿  " + token.slice(0, 20), token.slice(20)], [token.slice(0, 20), token.slice(20)]],
    [["⏺ Basic[31m", "", "dGVzdDph"], ["dGVzdDph"]],
    [["⏺ Basic (ctrl+o to expand)", "dGVzdDph", "─".repeat(80)], ["dGVzdDph"]],
    [["⏺ Bash(curl -H 'Authorization: Basic", "⎿  dGVzdDph"], ["dGVzdDph"]],
    [["⏺ Basic", "⏺ dGVzdDph"], ["dGVzdDph"]],
    [["⏺ Basic(dGVzdDph)"], ["dGVzdDph"]],
    [["⏺ Done.", "• Basic", "• dGVzdDph"], ["dGVzdDph"]],
    [["⏺ Bearer", "⏺ " + "read".repeat(80)], ["read".repeat(80)]],
    // Its second piece stays, as it does on one line: a Basic value has no space, so the redactor reads none past the first.
    [["⏺ Basic", "⏺ dGVzdDphbGlj", "⏺ ZUJvYlRvbQ=="], ["dGVzdDphbGlj"]],
    [["⏺ Basic", "⏺ abcdefgh Bearer", "⏺ dGVzdDph"], ["dGVzdDph"]],
    [["⏺ Bash(redis-cli " + "foo ".repeat(80) + "-a", "", "⎿ smallpass"], ["smallpass"]],
    [["⏺ Bash(cat command.txt)", "⎿ mysql", "--host localhost", "-p hunter2"], ["hunter2"]],
    [["⏺ Basic", "1. dGVzdDph"], ["dGVzdDph"]],
    [["⏺ Basic", "⏺ dGVzdDph", "⏺ dGVzdDph"], ["dGVzdDph"]],
    [["⏺ Bash(cat log.txt)", "⎿ password", "⎿ = firstpart", "⎿ middlepart", "⎿ leakedpart"], ["firstpart", "middlepart", "leakedpart"]],
    [["⏺ Bash(cat command.txt)", "⎿ mysql", "--host localhost", "-p 'correct", "horse", "battery", "staple'"], ["correct", "horse", "battery", "staple"]],
    [["⏺ Bash(cat command.txt)", "⎿ mysql", "--host localhost", '-p "correct', "horse", 'battery"'], ["correct", "horse", "battery"]],
    // A command and its password over 2,000 characters apart, in rows of a result: one window holds both.
    [["⏺ Bash(cat command.txt)", ...rows([...Array(500).fill("x"), "mysql", ...Array(1050).fill("x"), "-p", "hunter2"])], ["hunter2"]],
  ];

  it.each(cases)("shows nothing of a secret the terminal wrapped, once its lines are joined: %j", (lines, secrets) => {
    const shown = JSON.stringify(redactScreen(redactLog(lines, 200)));
    for (const secret of secrets) expect(shown).not.toContain(secret);
  });

  it.each([
    ["✽ Waiting… (2m[31mBasic dGVzdDph)"],
    ["✽ Busy… (1s Basic[31m dGVzdDph)"],
    ["✽ Puttering… (1m Basic│dGVzdDph)"],
    ["✽ Puttering… (1m Basic dGVzdDph · ↓ 2k tokens)"],
  ])("shows only the time of a busy line, nothing else its bracket holds: %s", (line) => {
    const shown = redactScreen(redactLog(["⏺ Done.", line], 200));
    expect(JSON.stringify(shown)).not.toContain("dGVzdDph");
    expect(shown.at(-1)).toEqual({ kind: "working", text: expect.stringMatching(/^Busy · \d+[hms]$/) });
  });

  it.each(cases)("feeds the worker sheet nothing of a secret the terminal wrapped, once joined: %j", (lines, secrets) => {
    const shown = JSON.stringify(redactFeed(redactLog(lines, 200), []));
    for (const secret of secrets) expect(shown).not.toContain(secret);
  });

  it("keeps a clean screen's line breaks and results as they are, a long result too", () => {
    const lines = ["⏺ First.", "", "Second.", "⏺ Bash(pnpm test)", "⎿  ✓ 3 passed", "4 files"];
    expect(redactScreen(lines)).toEqual(screenView(lines));
    const long = ["⏺ Bash(pnpm test)", ...Array.from({ length: 100 }, (_, i) => `⎿ test ${i} passed with the expected output and no warnings at all`)];
    expect(redactScreen(long)).toEqual(screenView(long));
    expect(redactFeed(long, [])).toEqual(logFeed(long));
  });

  it("reads the feed in the screen's order before it sorts by time", () => {
    const lines = redactLog(["⏺ Basic", "⏺ dGVzdDph"], 200);
    for (const times of [["2026-11-02T05:00:00.000Z", null], [null, "2026-11-02T05:00:00.000Z"]]) expect(JSON.stringify(redactFeed(lines, times))).not.toContain("dGVzdDph");
  });

  it("joins a short Basic value the per-line masking let through, and then takes it out", () => {
    expect(redactLog(["⏺ Basic", "dGVzdDph"], 200)).toEqual(["⏺ Basic", "dGVzdDph"]);
    expect(redactScreen(["⏺ Basic", "dGVzdDph"])).toEqual([{ kind: "said", text: "Basic" }]);
  });
});
